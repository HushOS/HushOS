import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
    closeDatabase,
    createTestAccount,
    createTestFamily,
    createTestIdentity,
    createTestStore,
    lockObserver,
    resetDatabase,
} from '../test/helpers';
import * as signed from '../test/signed';
import { db } from './client';
import * as drive from './drive';
import * as groupsRepository from './groups';
import * as reports from './reports';
import {
    ENVIRONMENT_PRIMARY_STORE_ID,
    ENVIRONMENT_REPLICA_STORE_ID,
    driveNodes,
    driveObjectDeletions,
    driveObjects,
    driveUploads,
    fileVersions,
    objectStores,
    storageRegions,
    workspaceStorage,
    workspaces,
} from './schema';
import * as stores from './stores';

/*
 * Stores as rows (docs/company-storage-design.md 2.1, 2.2), against a real
 * database: an upload's store is chosen inside begin's transaction, under a
 * lock a move's switch must wait for, and written on the upload and its
 * object; the multipart id is written afterwards and only while the row is
 * open; and reads, expiry and deletion follow the store a row names, not a
 * global. No store is involved here: these are the rows the stores follow.
 */

const MiB = 1024n * 1024n;
const keyEnvelope = () => randomBytes(72);
const metadataEnvelope = () => randomBytes(100);

let account: Awaited<ReturnType<typeof createTestAccount>>;
let rootId: string;
let rootEpoch: number;

async function epoch() {
    const range = await drive.allocateKeyEpochs(account.workspaceId, 1);
    return range!.from;
}

async function reserved() {
    const [row] = await db
        .select({ reserved: workspaceStorage.reservedBytes })
        .from(workspaceStorage)
        .where(eq(workspaceStorage.workspaceId, account.workspaceId));
    return row!.reserved;
}

type Ids = { nodeId: string; versionId: string; objectId: string; keyEpoch: number };
async function mint(): Promise<Ids> {
    return {
        nodeId: randomUUID(),
        versionId: randomUUID(),
        objectId: randomUUID(),
        keyEpoch: await epoch(),
    };
}

/*
 * Begins a 1 MiB upload of a new file under the root. Without `multipartId` the
 * row is left as begin's transaction commits it, before any store has answered.
 */
async function begin(options: { ids?: Ids; multipartId?: string } = {}) {
    const ids = options.ids ?? (await mint());
    const result = await signed.beginUpload({
        workspaceId: account.workspaceId,
        userId: account.userId,
        node: {
            existing: false,
            id: ids.nodeId,
            parentId: rootId,
            envelopes: {
                keyEpoch: ids.keyEpoch,
                parentKeyEpoch: rootEpoch,
                keyEnvelope: keyEnvelope(),
                metadataEnvelope: metadataEnvelope(),
            },
        },
        version: { id: ids.versionId, contentKeyEnvelope: randomBytes(84) },
        object: {
            id: ids.objectId,
            objectKey: `ws/${account.workspaceId}/${ids.objectId}`,
            contentSuite: 3,
            chunkSize: Number(8n * MiB),
            chunkCount: 1,
            contentNonce: randomBytes(16),
            ciphertextSize: MiB,
        },
        ...(options.multipartId !== undefined && { multipartId: options.multipartId }),
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    });
    return { result, ids };
}

async function began(options: { ids?: Ids; multipartId?: string } = {}) {
    const { result, ids } = await begin(options);
    if (result.status !== 'ok') throw new Error(result.status);
    return { uploadId: result.uploadId, storeId: result.storeId, ids };
}

/* A published file, whose object is at whatever store the default region names now. */
async function published() {
    const upload = await began({ multipartId: 'mp' });
    await drive.startCompleting(account.workspaceId, upload.uploadId);
    const done = await drive.finishCompleting(account.workspaceId, upload.uploadId, MiB);
    if (done.status !== 'published') throw new Error(done.status);
    return { ...upload, node: done.node };
}

async function uploadRow(uploadId: string) {
    const [row] = await db.select().from(driveUploads).where(eq(driveUploads.id, uploadId));
    return row;
}

async function objectStore(objectId: string) {
    const [row] = await db
        .select({ storeId: driveObjects.storeId })
        .from(driveObjects)
        .where(eq(driveObjects.id, objectId));
    return row?.storeId;
}

/* The default region re-pointed, as a move's switch will do it. */
async function pointDefaultRegionAt(storeId: string) {
    await db.update(storageRegions).set({ storeId }).where(eq(storageRegions.isDefault, true));
}

beforeEach(async () => {
    await resetDatabase();
    account = await createTestAccount({ quotaBytes: 100n * MiB });
    await createTestIdentity(account.userId);
    const created = await signed.createRoot({
        workspaceId: account.workspaceId,
        userId: account.userId,
        id: randomUUID(),
        envelopes: {
            keyEpoch: await epoch(),
            parentKeyEpoch: 1,
            keyEnvelope: keyEnvelope(),
            metadataEnvelope: metadataEnvelope(),
        },
    });
    if (created.status !== 'created') throw new Error(created.status);
    rootId = created.root.id;
    rootEpoch = created.root.keyEpoch;
});
afterAll(closeDatabase);

describe('which store an upload begins at', () => {
    test('the default region’s store, written on the upload and on its object', async () => {
        const first = await began();
        expect(first.storeId).toBe(ENVIRONMENT_PRIMARY_STORE_ID);
        expect((await uploadRow(first.uploadId))?.storeId).toBe(ENVIRONMENT_PRIMARY_STORE_ID);
        expect(await objectStore(first.ids.objectId)).toBe(ENVIRONMENT_PRIMARY_STORE_ID);

        // The region is what begin reads, not a constant: re-pointed, the next upload follows it.
        const second = await createTestStore();
        await pointDefaultRegionAt(second);
        const next = await began();
        expect(next.storeId).toBe(second);
        expect((await uploadRow(next.uploadId))?.storeId).toBe(second);
        expect(await objectStore(next.ids.objectId)).toBe(second);

        // An upload in flight finishes where it began: its rows did not move with the region.
        expect((await uploadRow(first.uploadId))?.storeId).toBe(ENVIRONMENT_PRIMARY_STORE_ID);
        expect(await objectStore(first.ids.objectId)).toBe(ENVIRONMENT_PRIMARY_STORE_ID);
    });

    test('a switch holding the region’s row makes begin wait, and begin then writes the store the switch chose', async () => {
        const target = await createTestStore();
        const observer = lockObserver();
        try {
            // The switch: the region's row taken for update, not yet re-pointed.
            await observer.query('begin');
            await observer.query('select id from storage_regions where is_default for update');
            let settled = false;
            const upload = began().finally(() => {
                settled = true;
            });
            // Begin has reached the region and waits there, having committed nothing.
            for (let i = 0; i < 100 && !(await observer.waitingOn('storage_regions')); i++)
                await new Promise((resolve) => setTimeout(resolve, 20));
            expect(await observer.waitingOn('storage_regions')).toBe(true);
            expect(settled).toBe(false);
            expect(await db.select({ id: driveUploads.id }).from(driveUploads)).toEqual([]);

            await observer.query('update storage_regions set store_id = $1 where is_default', [
                target,
            ]);
            await observer.query('commit');
            // An upload that read its store before the lock would name the store the switch left.
            const result = await upload;
            expect(result.storeId).toBe(target);
            expect((await uploadRow(result.uploadId))?.storeId).toBe(target);
            expect(await objectStore(result.ids.objectId)).toBe(target);
        } finally {
            await observer.query('rollback').catch(() => {});
            await observer.end();
        }
    });

    test('the default flag moving to another region while begin waits is followed, not read as no default', async () => {
        const target = await createTestStore();
        await db
            .insert(storageRegions)
            .values({ code: 'eu', label: 'European Union', storeId: target });
        const observer = lockObserver();
        try {
            // An operator makes another region the default: two rows change in one transaction.
            await observer.query('begin');
            await observer.query(
                `update storage_regions set is_default = false where code = 'default'`,
            );
            await observer.query(`update storage_regions set is_default = true where code = 'eu'`);
            const upload = began();
            for (let i = 0; i < 100 && !(await observer.waitingOn('storage_regions')); i++)
                await new Promise((resolve) => setTimeout(resolve, 20));
            expect(await observer.waitingOn('storage_regions')).toBe(true);
            await observer.query('commit');
            // The row begin waited on is no longer the default, and the one that now is was
            // not when its statement began: one statement finds neither, and begin would fail.
            const result = await upload;
            expect(result.storeId).toBe(target);
            expect(await objectStore(result.ids.objectId)).toBe(target);
        } finally {
            await observer.query('rollback').catch(() => {});
            await observer.end();
        }
    });

    test('without a default region begin fails and reserves nothing, rather than pick a store', async () => {
        await db.delete(storageRegions);
        await expect(begin()).rejects.toThrow('There is no default storage region.');
        expect(await reserved()).toBe(0n);
        expect(await db.select({ id: driveObjects.id }).from(driveObjects)).toEqual([]);
    });
});

describe('the multipart id', () => {
    test('begin commits the row open and without one, and nothing completes it', async () => {
        const { uploadId } = await began();
        expect(await uploadRow(uploadId)).toMatchObject({ status: 'open', multipartId: null });
        expect((await drive.startCompleting(account.workspaceId, uploadId)).status).toBe('expired');
        expect((await uploadRow(uploadId))?.status).toBe('open');
    });

    test('is written once, while the row is open', async () => {
        const { uploadId } = await began();
        expect(await drive.setUploadMultipartId(account.workspaceId, uploadId, 'mp-first')).toBe(
            true,
        );
        // A second answer (a retried request) never replaces the id parts were signed for.
        expect(await drive.setUploadMultipartId(account.workspaceId, uploadId, 'mp-second')).toBe(
            false,
        );
        expect((await uploadRow(uploadId))?.multipartId).toBe('mp-first');
        expect((await drive.startCompleting(account.workspaceId, uploadId)).status).toBe('ok');
    });

    test('is not written to a row that was aborted, is past its expiry, or is another workspace’s', async () => {
        const aborted = await began();
        await drive.abortUpload(account.workspaceId, aborted.uploadId);
        expect(await drive.setUploadMultipartId(account.workspaceId, aborted.uploadId, 'mp')).toBe(
            false,
        );

        const late = await began();
        await db
            .update(driveUploads)
            .set({ expiresAt: new Date(Date.now() - 1000) })
            .where(eq(driveUploads.id, late.uploadId));
        expect(await drive.setUploadMultipartId(account.workspaceId, late.uploadId, 'mp')).toBe(
            false,
        );

        const other = await createTestAccount();
        const mine = await began();
        expect(await drive.setUploadMultipartId(other.workspaceId, mine.uploadId, 'mp')).toBe(
            false,
        );

        // The aborted upload of a file never published is gone with its node; the others stand.
        expect(await uploadRow(aborted.uploadId)).toBeUndefined();
        expect(await uploadRow(late.uploadId)).toMatchObject({ status: 'open', multipartId: null });
        expect(await uploadRow(mine.uploadId)).toMatchObject({ status: 'open', multipartId: null });
    });
});

describe('an upload its store never started', () => {
    const backdate = (uploadId: string, seconds: number) =>
        db
            .update(driveUploads)
            .set({ createdAt: sql`now() - make_interval(secs => ${seconds})` })
            .where(eq(driveUploads.id, uploadId));
    const listed = async () => (await drive.listExpiredUploads()).map((row) => row.id);

    test('is listed for expiry after a minute, not before, and never once it has its id', async () => {
        const unstarted = await began();
        const started = await began({ multipartId: 'mp' });
        expect(await listed()).toEqual([]);
        await backdate(unstarted.uploadId, drive.UPLOAD_START_SECONDS - 5);
        expect(await listed()).toEqual([]);
        await backdate(unstarted.uploadId, drive.UPLOAD_START_SECONDS + 1);
        // As old, but started: a live upload with a day left.
        await backdate(started.uploadId, drive.UPLOAD_START_SECONDS + 1);
        expect(await listed()).toEqual([unstarted.uploadId]);
    });

    test('is expired like any other, and a store that answers after that leaves no row with an id', async () => {
        const { uploadId, ids } = await began();
        await backdate(uploadId, drive.UPLOAD_START_SECONDS + 1);
        expect(await reserved()).toBe(MiB);
        const result = await drive.expireUnstartedUpload(account.workspaceId, uploadId);
        expect(result).toMatchObject({ status: 'ok', alreadyAborted: false });
        // Nothing to abort at the store: the row read under the lock never had an id.
        if (result.status === 'ok') expect(result.upload.multipartId).toBeNull();
        // A file never published leaves with its upload; its bytes are no longer reserved.
        expect(await uploadRow(uploadId)).toBeUndefined();
        expect(await reserved()).toBe(0n);

        // The slow store's answer arrives now: refused, so the caller aborts what it started.
        expect(await drive.setUploadMultipartId(account.workspaceId, uploadId, 'mp-late')).toBe(
            false,
        );
        expect(
            await db.select().from(driveUploads).where(eq(driveUploads.multipartId, 'mp-late')),
        ).toEqual([]);
        expect(await objectStore(ids.objectId)).toBeUndefined();
    });

    test('is left alone by expiry when the store’s answer was written since it was listed', async () => {
        const { uploadId } = await began();
        await backdate(uploadId, drive.UPLOAD_START_SECONDS + 1);
        expect(await listed()).toEqual([uploadId]);
        expect(await drive.setUploadMultipartId(account.workspaceId, uploadId, 'mp-in-time')).toBe(
            true,
        );
        // Expiry acts on its stale listing: the upload the client was just handed must survive.
        expect(await drive.expireUnstartedUpload(account.workspaceId, uploadId)).toEqual({
            status: 'started',
        });
        expect(await uploadRow(uploadId)).toMatchObject({
            status: 'open',
            multipartId: 'mp-in-time',
        });
        expect(await reserved()).toBe(MiB);
    });

    test('whose store refused is undone whole, and the same ids begin again', async () => {
        const { uploadId, ids } = await began();
        expect(await reserved()).toBe(MiB);
        expect(await drive.discardUnstartedUpload(account.workspaceId, uploadId)).toBe(true);
        expect(await reserved()).toBe(0n);
        expect(await uploadRow(uploadId)).toBeUndefined();
        expect(await objectStore(ids.objectId)).toBeUndefined();
        expect(
            await db.select().from(fileVersions).where(eq(fileVersions.id, ids.versionId)),
        ).toEqual([]);
        expect(await db.select().from(driveNodes).where(eq(driveNodes.id, ids.nodeId))).toEqual([]);
        // Nothing reached the store under this key, so nothing is queued to delete there.
        expect(await db.select().from(driveObjectDeletions)).toEqual([]);

        // The client sends the same begin again, as it did when the store failed before the rows.
        const again = await begin({ ids, multipartId: 'mp' });
        expect(again.result.status).toBe('ok');
        expect(await reserved()).toBe(MiB);
    });

    test('is found by a listing that reads only the index of live uploads', async () => {
        // Expiry runs every five minutes over a table that keeps every finished upload.
        const { sql: text, params } = drive.expiredUploadsQuery(100).toSQL();
        const client = await db.$client.connect();
        try {
            await client.query('begin');
            // With the table this small the planner would scan it whatever the indexes: ask
            // what it does when a scan is the last resort.
            await client.query('set local enable_seqscan = off');
            const plan = (await client.query(`explain ${text}`, params)).rows
                .map((row) => row['QUERY PLAN'] as string)
                .join('\n');
            expect(plan).toContain('drive_uploads_expiry_idx');
            expect(plan).not.toMatch(/Seq Scan on drive_uploads|drive_uploads_pkey/);
        } finally {
            await client.query('rollback');
            client.release();
        }
    });

    test('is the only kind undone: a started upload keeps its rows and its reservation', async () => {
        const { uploadId, ids } = await began({ multipartId: 'mp' });
        expect(await drive.discardUnstartedUpload(account.workspaceId, uploadId)).toBe(false);
        expect(await uploadRow(uploadId)).toMatchObject({ status: 'open', multipartId: 'mp' });
        expect(await objectStore(ids.objectId)).toBe(ENVIRONMENT_PRIMARY_STORE_ID);
        expect(await reserved()).toBe(MiB);
    });
});

describe('what follows an object’s row', () => {
    test('a download reads the store the object’s row names, and follows the row when it changes', async () => {
        const file = await published();
        const version = file.node.currentVersionId!;
        const one = await drive.getVersionForDownload(account.workspaceId, version);
        expect(one).toMatchObject({ status: 'ok', storeId: ENVIRONMENT_PRIMARY_STORE_ID });

        const second = await createTestStore();
        await db
            .update(driveObjects)
            .set({ storeId: second })
            .where(eq(driveObjects.id, file.ids.objectId));
        expect(await drive.getVersionForDownload(account.workspaceId, version)).toMatchObject({
            status: 'ok',
            storeId: second,
        });
        const many = await drive.getVersionsForDownload(account.workspaceId, [version]);
        expect(many.map((row) => row.storeId)).toEqual([second]);
    });

    test('a retired object’s outbox row names the store its row named', async () => {
        const second = await createTestStore();
        const here = await began({ multipartId: 'mp-a' });
        await pointDefaultRegionAt(second);
        const there = await began({ multipartId: 'mp-b' });
        await drive.abortUpload(account.workspaceId, here.uploadId);
        await drive.abortUpload(account.workspaceId, there.uploadId);
        const outbox = await drive.listPendingObjectDeletions();
        expect(Object.fromEntries(outbox.map((row) => [row.objectId, row.storeId]))).toEqual({
            [here.ids.objectId]: ENVIRONMENT_PRIMARY_STORE_ID,
            [there.ids.objectId]: second,
        });
    });

    test('a deleted family folder’s objects are queued at the stores their rows named', async () => {
        const family = await createTestFamily({ organizerId: account.userId, areas: 1 });
        const second = await createTestStore();
        const areaId = family.areaIds[0]!;
        const ids = [randomUUID(), randomUUID()];
        await db.insert(driveObjects).values(
            ids.map((id, index) => ({
                id,
                workspaceId: areaId,
                objectKey: `ws/${areaId}/${id}`,
                chunkSize: 1,
                chunkCount: 1,
                contentNonce: randomBytes(16),
                ciphertextSize: 17n,
                status: 'ready' as const,
                storeId: index === 1 ? second : ENVIRONMENT_PRIMARY_STORE_ID,
            })),
        );
        await db
            .update(workspaces)
            .set({ deletedAt: sql`now() - interval '40 days'` })
            .where(eq(workspaces.id, areaId));
        expect(await groupsRepository.purgeDeletedAreas(30)).toBe(1);
        const outbox = await db.select().from(driveObjectDeletions);
        expect(Object.fromEntries(outbox.map((row) => [row.objectId, row.storeId]))).toEqual({
            [ids[0]!]: ENVIRONMENT_PRIMARY_STORE_ID,
            [ids[1]!]: second,
        });
    });

    test('replication is asked store by store, and the audit is handed each object’s store', async () => {
        const second = await createTestStore();
        const here = await published();
        await pointDefaultRegionAt(second);
        const there = await published();
        const byObject = (rows: { objectId: string; storeId: string }[]) =>
            Object.fromEntries(rows.map((row) => [row.objectId, row.storeId]));
        // A backup is of one store: what is waiting at another store is not its work.
        expect(byObject(await drive.listUnreplicatedObjects(ENVIRONMENT_PRIMARY_STORE_ID))).toEqual(
            { [here.ids.objectId]: ENVIRONMENT_PRIMARY_STORE_ID },
        );
        expect(byObject(await drive.listUnreplicatedObjects(second))).toEqual({
            [there.ids.objectId]: second,
        });
        expect(byObject(await drive.listObjectsForAudit('primary'))).toEqual({
            [here.ids.objectId]: ENVIRONMENT_PRIMARY_STORE_ID,
            [there.ids.objectId]: second,
        });
    });

    test('the audit has a page of each store’s own, and the stores it asks are the ones that hold objects', async () => {
        const second = await createTestStore();
        // A store nothing is at, and the replica, which holds only backups: neither is asked.
        await createTestStore();
        const here = [await published(), await published(), await published()];
        await db.update(driveObjects).set({ createdAt: sql`now() - interval '1 day'` });
        await pointDefaultRegionAt(second);
        const there = [await published(), await published()];
        expect(await stores.listStoresHoldingObjects()).toEqual(
            [ENVIRONMENT_PRIMARY_STORE_ID, second].sort(),
        );

        const ids = async (rows: Promise<{ objectId: string }[]>) =>
            (await rows).map((row) => row.objectId).sort();
        const hereIds = here.map((file) => file.ids.objectId);
        // Never audited and older, the first store's objects fill a page shared by both.
        const shared = await ids(drive.listObjectsForAudit('primary', 2));
        expect(shared.every((id) => hereIds.includes(id))).toBe(true);
        // A page of the second store's own is its objects, whatever waits elsewhere.
        expect(await ids(drive.listObjectsForAudit('primary', 2, second))).toEqual(
            there.map((file) => file.ids.objectId).sort(),
        );
        const own = await ids(
            drive.listObjectsForAudit('primary', 2, ENVIRONMENT_PRIMARY_STORE_ID),
        );
        expect(own).toHaveLength(2);
        expect(own.every((id) => hereIds.includes(id))).toBe(true);
    });

    test('a backup copy is told the size on the object’s row, and nothing once that row is gone', async () => {
        const live = await published();
        const purged = await published();
        await drive.trashNode({ workspaceId: account.workspaceId, nodeId: purged.node.id });
        await drive.purgeNode({ workspaceId: account.workspaceId, nodeId: purged.node.id });
        const sizes = Object.fromEntries(
            (await drive.listUnreplicatedObjects(ENVIRONMENT_PRIMARY_STORE_ID)).map((row) => [
                row.objectId,
                row.ciphertextSize,
            ]),
        );
        // What bounds the copy's reads: the row's size, or the fact that no row holds one.
        expect(sizes).toEqual({ [live.ids.objectId]: MiB, [purged.ids.objectId]: null });
    });

    test('expired uploads are listed store by store in turn: one store’s many do not fill the page', async () => {
        const second = await createTestStore();
        const here: string[] = [];
        for (let i = 0; i < 6; i++) here.push((await began({ multipartId: `mp-${i}` })).uploadId);
        await pointDefaultRegionAt(second);
        const there = [
            (await began({ multipartId: 'mp-a' })).uploadId,
            (await began({ multipartId: 'mp-b' })).uploadId,
        ];
        // All past their expiry, the first store's by longer.
        await db.update(driveUploads).set({ expiresAt: sql`now() - interval '1 minute'` });
        for (const [index, id] of here.entries())
            await db
                .update(driveUploads)
                .set({ expiresAt: sql`now() - make_interval(hours => ${6 - index})` })
                .where(eq(driveUploads.id, id));
        const page = (await drive.listExpiredUploads(4)).map((row) => row.id);
        expect(page.filter((id) => there.includes(id)).sort()).toEqual([...there].sort());
        expect(page.filter((id) => here.includes(id))).toEqual(here.slice(0, 2));
        // A store alone has the whole page, oldest first.
        await db.delete(driveUploads).where(eq(driveUploads.storeId, second));
        expect((await drive.listExpiredUploads(4)).map((row) => row.id)).toEqual(here.slice(0, 4));
    });

    test('tiering only considers objects in the environment’s primary store', async () => {
        const second = await createTestStore();
        const here = await published();
        await pointDefaultRegionAt(second);
        const there = await published();
        // Both idle for a season: only the one in the store the cold class belongs to is a candidate.
        await db.update(driveObjects).set({ readyAt: sql`now() - interval '100 days'` });
        expect((await drive.listTierCandidates(90)).map((row) => row.objectId)).toEqual([
            here.ids.objectId,
        ]);
        await db
            .update(driveObjects)
            .set({ storageClass: 'cold', lastReadAt: sql`now() - interval '1 day'` });
        expect((await drive.listWarmCandidates(90)).map((row) => row.objectId)).toEqual([
            here.ids.objectId,
        ]);
        expect(there.storeId).toBe(second);
    });

    test('a reported object is found at its row’s store, and at its outbox row’s once purged', async () => {
        const second = await createTestStore();
        await pointDefaultRegionAt(second);
        const live = await published();
        const retired = await began({ multipartId: 'mp' });
        await drive.abortUpload(account.workspaceId, retired.uploadId);
        const unknown = randomUUID();
        const found = await reports.storesOfReportObjects([
            live.ids.objectId,
            retired.ids.objectId,
            unknown,
        ]);
        expect(found.get(live.ids.objectId)).toBe(second);
        expect(found.get(retired.ids.objectId)).toBe(second);
        // No row names it: its copy is gone, and nothing guesses a store for it.
        expect(found.has(unknown)).toBe(false);
    });
});

describe('the environment’s replica row', () => {
    const replicaRow = async () => {
        const [row] = await db
            .select()
            .from(objectStores)
            .where(eq(objectStores.id, ENVIRONMENT_REPLICA_STORE_ID));
        return row!;
    };

    test('says the replica is there exactly when the worker’s environment describes it', async () => {
        // As migrated: no worker has spoken, so the default region has no working backup.
        expect((await replicaRow()).envPresent).toBe(false);

        expect(await stores.recordEnvironmentReplica(true)).toBe(true);
        const present = await replicaRow();
        expect(present.envPresent).toBe(true);
        expect(present.version).toBe(2);
        // The same answer at the next start changes nothing: the version is what caches key on.
        expect(await stores.recordEnvironmentReplica(true)).toBe(false);
        expect((await replicaRow()).version).toBe(2);

        // The operator removes STORAGE_REPLICA_* and restarts the worker.
        expect(await stores.recordEnvironmentReplica(false)).toBe(true);
        expect(await replicaRow()).toMatchObject({ envPresent: false, version: 3 });
    });

    test('never takes on the environment’s settings, and the primary’s row is not touched', async () => {
        await stores.recordEnvironmentReplica(true);
        expect(await replicaRow()).toMatchObject({
            source: 'environment',
            kind: 'backup',
            endpoint: null,
            bucket: null,
            secretSealed: null,
        });
        const [primary] = await db
            .select()
            .from(objectStores)
            .where(eq(objectStores.id, ENVIRONMENT_PRIMARY_STORE_ID));
        expect(primary).toMatchObject({ envPresent: true, version: 1, endpoint: null });
        // The region still names it as its backup either way: null there means "none" only.
        const [region] = await db.select().from(storageRegions);
        expect(region).toMatchObject({
            storeId: ENVIRONMENT_PRIMARY_STORE_ID,
            backupStoreId: ENVIRONMENT_REPLICA_STORE_ID,
        });
    });
});
