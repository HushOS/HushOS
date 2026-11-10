import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { registered, signedIn } from '../test/accounts';
import {
    closeDatabase,
    createTestAccount,
    createTestIdentity,
    createTestStore,
    resetDatabase,
} from '../test/helpers';
import * as signed from '../test/signed';
import * as auth from './auth';
import { db } from './client';
import * as drive from './drive';
import {
    ENVIRONMENT_PRIMARY_STORE_ID as PRIMARY,
    ENVIRONMENT_REPLICA_STORE_ID as REPLICA,
    driveObjectDeletions,
    driveObjects,
    storageRegions,
} from './schema';

/*
 * The deletion outbox's rules (docs/company-storage-design.md 8.4), against
 * real rows. The stores are a set of "store:key" strings here: what matters in
 * this file is which copy a row lets go and which it never may, and what the
 * rows say afterwards. The same rules with real bytes in real buckets are in
 * packages/drive/src/outbox.test.ts.
 */

let account: Awaited<ReturnType<typeof createTestAccount>>;
let root: { id: string; keyEpoch: number };
let second: string;

/* Every copy that exists, as "store:key", and every deletion asked for, in order. */
let copies: Set<string>;
let removed: string[];
const at = (storeId: string, key: string) => `${storeId}:${key}`;

/* A worker that keeps the replica as the primary's backup, unless told it keeps none. */
function store(options: { backups?: boolean; failing?: string } = {}) {
    const backups = options.backups ?? true;
    return {
        backupOf: (storeId: string) => (backups && storeId === PRIMARY ? REPLICA : null),
        keepsBackup: (storeId: string) => backups && storeId === REPLICA,
        present: async (storeId: string, key: string) => {
            if (storeId === options.failing) throw new Error('socket hang up');
            return copies.has(at(storeId, key));
        },
        remove: async (storeId: string, key: string) => {
            if (storeId === options.failing) throw new Error('socket hang up');
            removed.push(at(storeId, key));
            copies.delete(at(storeId, key));
        },
    };
}

beforeEach(async () => {
    await resetDatabase();
    account = await createTestAccount();
    await createTestIdentity(account.userId);
    const created = await signed.createRoot({
        workspaceId: account.workspaceId,
        userId: account.userId,
        id: randomUUID(),
        envelopes: {
            keyEpoch: (await drive.allocateKeyEpochs(account.workspaceId, 1))!.from,
            parentKeyEpoch: 1,
            keyEnvelope: randomBytes(72),
            metadataEnvelope: randomBytes(100),
        },
    });
    if (created.status !== 'created') throw new Error(created.status);
    root = created.root;
    second = await createTestStore();
    copies = new Set();
    removed = [];
});
afterAll(closeDatabase);

/* A published file at the environment's primary, its bytes "stored" there. */
async function published() {
    const objectId = randomUUID();
    const objectKey = `ws/${account.workspaceId}/${objectId}`;
    const begun = await signed.beginUpload({
        workspaceId: account.workspaceId,
        userId: account.userId,
        node: {
            existing: false,
            id: randomUUID(),
            parentId: root.id,
            envelopes: {
                keyEpoch: (await drive.allocateKeyEpochs(account.workspaceId, 1))!.from,
                parentKeyEpoch: root.keyEpoch,
                keyEnvelope: randomBytes(72),
                metadataEnvelope: randomBytes(100),
            },
        },
        version: { id: randomUUID(), contentKeyEnvelope: randomBytes(84) },
        object: {
            id: objectId,
            objectKey,
            contentSuite: 3,
            chunkSize: 8 * 1024 * 1024,
            chunkCount: 1,
            contentNonce: randomBytes(16),
            ciphertextSize: 4096n,
        },
        multipartId: `mp-${objectId}`,
        expiresAt: new Date(Date.now() + 3600_000),
    });
    if (begun.status !== 'ok') throw new Error(begun.status);
    await drive.startCompleting(account.workspaceId, begun.uploadId);
    const done = await drive.finishCompleting(account.workspaceId, begun.uploadId, 4096n);
    if (done.status !== 'published') throw new Error(done.status);
    copies.add(at(PRIMARY, objectKey));
    return {
        nodeId: done.node.id,
        object: { id: objectId, workspaceId: account.workspaceId, objectKey },
        key: objectKey,
    };
}
type File = Awaited<ReturnType<typeof published>>;

async function purge(file: File) {
    await drive.trashNode({ workspaceId: account.workspaceId, nodeId: file.nodeId });
    await drive.purgeNode({ workspaceId: account.workspaceId, nodeId: file.nodeId });
}

/* A move's copy and flip, as a move will make them: bytes first, then the row. */
async function moved(file: File, from: string, to: string, moveId = randomUUID()) {
    const copiedSince = await drive.databaseNow();
    copies.add(at(to, file.key));
    const flip = await drive.flipObjectStore({
        object: file.object,
        fromStoreId: from,
        toStoreId: to,
        moveId,
        copiedSince,
    });
    return { flip, moveId };
}

async function rows(objectId: string) {
    return db
        .select()
        .from(driveObjectDeletions)
        .where(eq(driveObjectDeletions.objectId, objectId))
        .orderBy(driveObjectDeletions.storeId);
}
async function row(objectId: string, storeId: string) {
    return (await rows(objectId)).find((entry) => entry.storeId === storeId) ?? null;
}
async function objectRow(objectId: string) {
    const [found] = await db.select().from(driveObjects).where(eq(driveObjects.id, objectId));
    return found ?? null;
}
const setRow = (objectId: string, storeId: string, set: Record<string, unknown>) =>
    db
        .update(driveObjectDeletions)
        .set(set)
        .where(
            and(
                eq(driveObjectDeletions.objectId, objectId),
                eq(driveObjectDeletions.storeId, storeId),
            ),
        );
const pendingIds = async () =>
    (await drive.listPendingObjectDeletions()).map((entry) => `${entry.storeId}:${entry.objectId}`);
const key = (file: File, storeId: string) => ({ objectId: file.object.id, storeId });

describe('the key is the object and the store', () => {
    test('a moved object’s old copy and its later purge are two rows that never collide', async () => {
        const file = await published();
        const { flip, moveId } = await moved(file, PRIMARY, second);
        expect(flip).toEqual({ status: 'flipped', reused: false });
        await purge(file);
        const queued = await rows(file.object.id);
        expect(
            queued
                .map((entry) => [entry.storeId, entry.reason])
                .sort((a, b) => a[0]!.localeCompare(b[0]!)),
        ).toEqual(
            [
                [PRIMARY, 'moved'],
                [second, 'purged'],
            ].sort((a, b) => a[0]!.localeCompare(b[0]!)),
        );
        // Nothing can be undone for an object that is gone: the old copy's hold and wait are cleared.
        expect(await row(file.object.id, PRIMARY)).toMatchObject({
            heldByMove: null,
            notBefore: null,
        });
        expect(moveId).toBeTruthy();
        // Both go, each from its own store, and nothing else is touched.
        for (const entry of queued)
            expect(await drive.removeQueuedCopy(key(file, entry.storeId), store())).toMatchObject({
                status: 'removed',
            });
        expect(copies).toEqual(new Set());
        expect(removed.sort()).toEqual([at(PRIMARY, file.key), at(second, file.key)].sort());
    });

    test('a purge leaves another object’s moved copy held', async () => {
        const kept = await published();
        const gone = await published();
        await moved(kept, PRIMARY, second);
        await moved(gone, PRIMARY, second);
        await purge(gone);
        expect((await row(kept.object.id, PRIMARY))?.heldByMove).not.toBeNull();
        expect((await row(gone.object.id, PRIMARY))?.heldByMove).toBeNull();
    });
});

describe('an insert meets a row for the same object and store', () => {
    const queue = (file: File, copy: Partial<drive.QueuedCopy>) =>
        db.transaction((tx) =>
            drive.queueCopy(tx, {
                objectId: file.object.id,
                workspaceId: file.object.workspaceId,
                objectKey: file.key,
                storeId: PRIMARY,
                reason: 'purged',
                published: true,
                backupStoreId: null,
                ...copy,
            }),
        );

    test('a finished row is replaced whole: reason, dates, hold, marks and the backup and export fields', async () => {
        const file = await published();
        const move = randomUUID();
        expect(
            await queue(file, { reason: 'moved', heldByMove: move, backupStoreId: REPLICA }),
        ).toBe(true);
        // As it stands once its copy and its backup copy are both gone, with everything a row can carry.
        await setRow(file.object.id, PRIMARY, {
            heldByMove: null,
            notBefore: new Date(Date.now() - 1000),
            primaryDeletedAt: new Date(Date.now() - 900),
            deleteReplicaAfter: new Date(Date.now() - 800),
            doneAt: new Date(Date.now() - 700),
            backupLeft: true,
            attention: true,
            failures: 4,
            failedAt: new Date(Date.now() - 950),
            exportStoreId: randomUUID(),
            exportLastSeq: 41,
            createdAt: new Date(Date.now() - 5000),
        });
        // The object came back to this store and is purged there, with no backup copy this time.
        expect(await queue(file, { reason: 'purged', published: false })).toBe(true);
        const [replaced] = await rows(file.object.id);
        expect(replaced).toMatchObject({
            reason: 'purged',
            published: false,
            replicated: false,
            backupStoreId: null,
            exportStoreId: null,
            exportLastSeq: null,
            heldByMove: null,
            notBefore: null,
            backupLeft: false,
            attention: false,
            failures: 0,
            failedAt: null,
            primaryDeletedAt: null,
            deleteReplicaAfter: null,
            doneAt: null,
        });
        expect(replaced!.createdAt.getTime()).toBeGreaterThan(Date.now() - 2000);
        // And so the copy that came back is deleted, which a dropped insert would never do.
        expect(await pendingIds()).toEqual([`${PRIMARY}:${file.object.id}`]);
    });

    test('an unfinished row is left as it is by a moved or a stray insert', async () => {
        const file = await published();
        const move = randomUUID();
        await queue(file, { reason: 'moved', heldByMove: move, backupStoreId: REPLICA });
        const before = await rows(file.object.id);
        expect(await queue(file, { reason: 'stray', published: false })).toBe(false);
        expect(await queue(file, { reason: 'moved', heldByMove: randomUUID() })).toBe(false);
        expect(await rows(file.object.id)).toEqual(before);
        // A purge that meets an unfinished purge changes nothing either.
        const other = await published();
        await queue(other, { backupStoreId: REPLICA });
        const queued = await rows(other.object.id);
        expect(await queue(other, { published: false })).toBe(false);
        expect(await rows(other.object.id)).toEqual(queued);
    });

    test('a purge replaces an unfinished moved or stray row, clears its hold, and keeps its backup copy to remove', async () => {
        for (const reason of ['moved', 'stray'] as const) {
            const file = await published();
            await queue(file, {
                reason,
                heldByMove: reason === 'moved' ? randomUUID() : null,
                backupStoreId: REPLICA,
                published: false,
            });
            // Its copy at the store was recorded as deleted, and it was marked for attention.
            await setRow(file.object.id, PRIMARY, {
                notBefore: new Date(Date.now() + 7 * 24 * 3600 * 1000),
                attention: true,
                primaryDeletedAt: new Date(),
                deleteReplicaAfter: new Date(Date.now() + 1000),
            });
            expect(await queue(file, { reason: 'purged', published: true })).toBe(true);
            expect((await rows(file.object.id))[0], reason).toMatchObject({
                reason: 'purged',
                heldByMove: null,
                notBefore: null,
                attention: false,
                // The copy at the store is removed again whatever the row had recorded.
                primaryDeletedAt: null,
                deleteReplicaAfter: null,
                doneAt: null,
                published: true,
                // What the old row knew of a backup copy is not forgotten.
                replicated: true,
                backupStoreId: REPLICA,
            });
        }
    });
});

describe('what a row waits for', () => {
    test('a moved copy is held until its move is done, and then until its date', async () => {
        const file = await published();
        const { moveId } = await moved(file, PRIMARY, second);
        expect(await pendingIds()).toEqual([]);
        expect(await drive.removeQueuedCopy(key(file, PRIMARY), store())).toEqual({
            status: 'held',
        });
        // Another move's end releases nothing of this one.
        expect(await drive.releaseMoveHolds(randomUUID(), new Date())).toBe(0);
        expect(await drive.removeQueuedCopy(key(file, PRIMARY), store())).toEqual({
            status: 'held',
        });
        // Done: the old copy now waits for as long as an old copy is kept.
        expect(await drive.releaseMoveHolds(moveId, new Date(Date.now() + 7 * 24 * 3600_000))).toBe(
            1,
        );
        expect(await pendingIds()).toEqual([]);
        expect(await drive.removeQueuedCopy(key(file, PRIMARY), store())).toEqual({
            status: 'held',
        });
        expect(removed).toEqual([]);
        await setRow(file.object.id, PRIMARY, { notBefore: new Date(Date.now() - 1000) });
        expect(await pendingIds()).toEqual([`${PRIMARY}:${file.object.id}`]);
        expect(await drive.removeQueuedCopy(key(file, PRIMARY), store())).toMatchObject({
            status: 'removed',
        });
        expect(removed).toEqual([at(PRIMARY, file.key)]);
        // The object's own copy is where its row says, untouched.
        expect(copies.has(at(second, file.key))).toBe(true);
    });

    test('a moved copy goes only once the new copy is seen again; when it is not, nothing is deleted', async () => {
        const file = await published();
        const { moveId } = await moved(file, PRIMARY, second);
        await drive.releaseMoveHolds(moveId, new Date(Date.now() - 1000));
        // The new copy has gone missing: the old one is now the only one.
        copies.delete(at(second, file.key));
        expect(await drive.removeQueuedCopy(key(file, PRIMARY), store())).toEqual({
            status: 'attention',
            why: 'new-copy-absent',
            first: true,
        });
        expect(await drive.removeQueuedCopy(key(file, PRIMARY), store())).toEqual({
            status: 'attention',
            why: 'new-copy-absent',
            first: false,
        });
        expect(removed).toEqual([]);
        expect(await row(file.object.id, PRIMARY)).toMatchObject({
            attention: true,
            primaryDeletedAt: null,
            doneAt: null,
        });
        // A store that cannot be asked says nothing: no deletion, and no mark either.
        await setRow(file.object.id, PRIMARY, { attention: false });
        await expect(
            drive.removeQueuedCopy(key(file, PRIMARY), store({ failing: second })),
        ).rejects.toThrow();
        expect(await row(file.object.id, PRIMARY)).toMatchObject({
            attention: false,
            primaryDeletedAt: null,
        });
        expect(removed).toEqual([]);
        // Healed: the old copy may go, and the mark goes with it.
        await setRow(file.object.id, PRIMARY, { attention: true });
        copies.add(at(second, file.key));
        expect(await drive.removeQueuedCopy(key(file, PRIMARY), store())).toMatchObject({
            status: 'removed',
        });
        expect(await row(file.object.id, PRIMARY)).toMatchObject({ attention: false });
        expect(removed).toEqual([at(PRIMARY, file.key)]);
    });

    test('no row ever deletes the copy at the store its object lives at', async () => {
        const file = await published();
        // A stray row for the very store the object is at, as a lost race could leave one.
        for (const reason of ['stray', 'moved', 'purged'] as const) {
            await db.delete(driveObjectDeletions);
            await db.insert(driveObjectDeletions).values({
                objectId: file.object.id,
                workspaceId: account.workspaceId,
                objectKey: file.key,
                storeId: PRIMARY,
                reason,
                published: false,
            });
            expect(
                await drive.removeQueuedCopy(key(file, PRIMARY), store({ backups: false })),
                reason,
            ).toMatchObject({ status: 'attention', why: 'lives-here' });
        }
        expect(removed).toEqual([]);
        expect(copies.has(at(PRIMARY, file.key))).toBe(true);
    });

    test('a report’s hold keeps every copy of the object, read again under the row’s lock', async () => {
        const file = await published();
        const reportId = randomUUID();
        await db.$client.query(
            `insert into drive_reports (id, workspace_id, node_id, node_kind, key_epoch, category, reason) values ($1, $2, $3, 'file', 1, 'other', 'Looks wrong.')`,
            [reportId, account.workspaceId, file.nodeId],
        );
        await db.$client.query(
            `insert into drive_report_items (report_id, node_id, depth, kind, key_epoch, parent_key_epoch, key_envelope, metadata_version, metadata_envelope, version_id, object_id, object_key, content_key_envelope, content_nonce, content_suite, chunk_size, chunk_count, ciphertext_size) values ($1, $2, 0, 'file', 1, 1, $3, 1, $4, $5, $6, $7, $8, $9, 3, 8388608, 1, 4096)`,
            [
                reportId,
                file.nodeId,
                randomBytes(72),
                randomBytes(100),
                randomUUID(),
                file.object.id,
                file.key,
                randomBytes(84),
                randomBytes(16),
            ],
        );
        const { moveId } = await moved(file, PRIMARY, second);
        await drive.releaseMoveHolds(moveId, new Date(Date.now() - 1000));
        await purge(file);
        expect(await pendingIds()).toEqual([]);
        for (const storeId of [PRIMARY, second])
            expect(await drive.removeQueuedCopy(key(file, storeId), store())).toEqual({
                status: 'held',
            });
        expect(removed).toEqual([]);
        // The report is dismissed without a hold: both copies go.
        await db.$client.query(`update drive_reports set status = 'dismissed' where id = $1`, [
            reportId,
        ]);
        for (const storeId of [PRIMARY, second])
            expect(await drive.removeQueuedCopy(key(file, storeId), store())).toMatchObject({
                status: 'removed',
            });
        expect(copies).toEqual(new Set());
    });
});

describe('one worker at a time, and a failure loses nothing', () => {
    test('a row another transaction holds is skipped, not deleted twice', async () => {
        const file = await published();
        await purge(file);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let entered!: () => void;
        const inside = new Promise<void>((resolve) => (entered = resolve));
        const slow = {
            ...store({ backups: false }),
            remove: async (storeId: string, objectKey: string) => {
                entered();
                await gate;
                removed.push(at(storeId, objectKey));
            },
        };
        const first = drive.removeQueuedCopy(key(file, PRIMARY), slow);
        await inside;
        // A second worker, while the first is still at the store.
        expect(await drive.removeQueuedCopy(key(file, PRIMARY), store({ backups: false }))).toEqual(
            { status: 'skipped' },
        );
        release();
        expect(await first).toEqual({ status: 'removed', backup: 'none' });
        expect(await drive.removeQueuedCopy(key(file, PRIMARY), store({ backups: false }))).toEqual(
            { status: 'skipped' },
        );
        expect(removed).toEqual([at(PRIMARY, file.key)]);
    });

    test('a store that throws leaves the row as it was, and the row goes to the back of the line', async () => {
        const failing = await published();
        const fine = await published();
        await purge(failing);
        await purge(fine);
        expect(await pendingIds()).toEqual([
            `${PRIMARY}:${failing.object.id}`,
            `${PRIMARY}:${fine.object.id}`,
        ]);
        await expect(
            drive.removeQueuedCopy(
                key(failing, PRIMARY),
                store({ backups: false, failing: PRIMARY }),
            ),
        ).rejects.toThrow();
        await drive.recordObjectDeletionFailure(key(failing, PRIMARY));
        expect(await row(failing.object.id, PRIMARY)).toMatchObject({
            failures: 1,
            primaryDeletedAt: null,
            doneAt: null,
        });
        // Not lost, and no longer ahead of the row that has not failed.
        expect(await pendingIds()).toEqual([
            `${PRIMARY}:${fine.object.id}`,
            `${PRIMARY}:${failing.object.id}`,
        ]);
        expect(
            await drive.removeQueuedCopy(key(failing, PRIMARY), store({ backups: false })),
        ).toEqual({ status: 'removed', backup: 'none' });
        expect(await row(failing.object.id, PRIMARY)).toMatchObject({
            failures: 0,
            failedAt: null,
        });
    });
});

describe('the flip', () => {
    test('moves the row only from the store the copy was read from, clears the backup mark, and queues the copy left behind', async () => {
        const file = await published();
        await drive.markObjectReplicated({ ...key(file, PRIMARY), backupStoreId: REPLICA });
        await db
            .update(driveObjects)
            .set({ storageClass: 'cold', copyFailures: 3 })
            .where(eq(driveObjects.id, file.object.id));
        const third = await createTestStore();
        // The object is not where this copy was read from: nothing flips, and the copy just made is a stray.
        copies.add(at(second, file.key));
        expect(
            await drive.flipObjectStore({
                object: file.object,
                fromStoreId: third,
                toStoreId: second,
                moveId: randomUUID(),
                copiedSince: await drive.databaseNow(),
            }),
        ).toEqual({ status: 'elsewhere' });
        expect((await objectRow(file.object.id))?.storeId).toBe(PRIMARY);
        expect(await row(file.object.id, second)).toMatchObject({
            reason: 'stray',
            heldByMove: null,
        });
        // The stray goes at once, and never the copy the object lives on.
        expect(await drive.removeQueuedCopy(key(file, second), store())).toMatchObject({
            status: 'removed',
        });
        expect(copies).toEqual(new Set([at(PRIMARY, file.key)]));

        const { flip, moveId } = await moved(file, PRIMARY, second);
        expect(flip).toEqual({ status: 'flipped', reused: false });
        expect(await objectRow(file.object.id)).toMatchObject({
            storeId: second,
            replicatedAt: null,
            backupStoreId: null,
            storageClass: 'standard',
            copyFailures: 0,
        });
        expect(await row(file.object.id, PRIMARY)).toMatchObject({
            reason: 'moved',
            heldByMove: moveId,
            published: true,
            // The old region's backup copy goes with the old copy.
            replicated: true,
            backupStoreId: REPLICA,
        });
        // A second flip of the same copy changes nothing.
        expect((await moved(file, PRIMARY, second)).flip).toEqual({ status: 'already' });
        expect(await rows(file.object.id)).toHaveLength(2);
    });

    test('an object purged while its copy was made leaves that copy queued as a stray', async () => {
        const file = await published();
        const copiedSince = await drive.databaseNow();
        copies.add(at(second, file.key));
        await purge(file);
        expect(
            await drive.flipObjectStore({
                object: file.object,
                fromStoreId: PRIMARY,
                toStoreId: second,
                moveId: randomUUID(),
                copiedSince,
            }),
        ).toEqual({ status: 'gone' });
        for (const entry of await rows(file.object.id))
            expect(
                await drive.removeQueuedCopy(key(file, entry.storeId), store({ backups: false })),
            ).toMatchObject({ status: 'removed' });
        expect(copies).toEqual(new Set());
    });

    test('a flip back takes the old copy back and withdraws its row; a cancelled move leaves no row for a store an object lives at', async () => {
        const files = [await published(), await published(), await published()];
        const out = randomUUID();
        for (const file of files) await moved(file, PRIMARY, second, out);
        // Cancelled: the same move the other way. The old copies are still there, so nothing is copied.
        const back = randomUUID();
        for (const file of files)
            expect(
                await drive.flipObjectStore({
                    object: file.object,
                    fromStoreId: second,
                    toStoreId: PRIMARY,
                    moveId: back,
                    copiedSince: null,
                }),
            ).toEqual({ status: 'flipped', reused: true });
        await drive.releaseMoveHolds(back, new Date(Date.now() - 1000));
        // Eight days on, the outbox has run as often as it likes.
        await db.execute(
            sql`update drive_object_deletions set created_at = created_at - interval '8 days'`,
        );
        for (let run = 0; run < 2; run++)
            for (const entry of await drive.listPendingObjectDeletions())
                await drive.removeQueuedCopy(
                    { objectId: entry.objectId, storeId: entry.storeId },
                    store(),
                );
        for (const file of files) {
            const object = await objectRow(file.object.id);
            expect(object?.storeId).toBe(PRIMARY);
            // Readable: the copy its row names is there.
            expect(copies.has(at(object!.storeId, file.key))).toBe(true);
            // No moved row is left for the store it lives at; the copy at the other store is gone.
            expect(await row(file.object.id, PRIMARY)).toBeNull();
            expect(copies.has(at(second, file.key))).toBe(false);
        }
    });

    test('a flip back after the old copy was deleted says the bytes must be copied, and changes nothing', async () => {
        const file = await published();
        const { moveId } = await moved(file, PRIMARY, second);
        await drive.releaseMoveHolds(moveId, new Date(Date.now() - 1000));
        expect(await drive.removeQueuedCopy(key(file, PRIMARY), store({ backups: false }))).toEqual(
            {
                status: 'removed',
                backup: 'none',
            },
        );
        const flipBack = (copiedSince: string | null) =>
            drive.flipObjectStore({
                object: file.object,
                fromStoreId: second,
                toStoreId: PRIMARY,
                moveId: randomUUID(),
                copiedSince,
            });
        expect(await flipBack(null)).toEqual({ status: 'copy-needed' });
        expect((await objectRow(file.object.id))?.storeId).toBe(second);
        // With no row at all (it finished long ago and was cleared away), the same.
        await db.delete(driveObjectDeletions);
        expect(await flipBack(null)).toEqual({ status: 'copy-needed' });
        // Copied afresh, it flips.
        const since = await drive.databaseNow();
        copies.add(at(PRIMARY, file.key));
        expect(await flipBack(since)).toEqual({ status: 'flipped', reused: false });
        expect((await objectRow(file.object.id))?.storeId).toBe(PRIMARY);
        expect(copies.has(at(PRIMARY, file.key))).toBe(true);
    });

    test('a copy the outbox deleted after it was made is not flipped onto', async () => {
        const file = await published();
        const { moveId } = await moved(file, PRIMARY, second);
        await drive.releaseMoveHolds(moveId, new Date(Date.now() - 1000));
        // A mover begins a fresh copy back to the primary...
        const since = await drive.databaseNow();
        copies.add(at(PRIMARY, file.key));
        // ...and the outbox, whose row for the old copy there was due, deletes it under its feet.
        expect(
            await drive.removeQueuedCopy(key(file, PRIMARY), store({ backups: false })),
        ).toMatchObject({ status: 'removed' });
        expect(copies.has(at(PRIMARY, file.key))).toBe(false);
        expect(
            await drive.flipObjectStore({
                object: file.object,
                fromStoreId: second,
                toStoreId: PRIMARY,
                moveId: randomUUID(),
                copiedSince: since,
            }),
        ).toEqual({ status: 'copy-needed' });
        // The object still names the store that holds it.
        const object = await objectRow(file.object.id);
        expect(copies.has(at(object!.storeId, file.key))).toBe(true);
    });

    test('the outbox and a flip back on one object, started together in either order, never leave it with no copy', async () => {
        for (const order of ['outbox-first', 'flip-first', 'together'] as const)
            for (let round = 0; round < 4; round++) {
                const file = await published();
                const { moveId } = await moved(file, PRIMARY, second);
                await drive.releaseMoveHolds(moveId, new Date(Date.now() - 1000));
                const outbox = () =>
                    drive.removeQueuedCopy(key(file, PRIMARY), store({ backups: false }));
                const flip = () =>
                    drive.flipObjectStore({
                        object: file.object,
                        fromStoreId: second,
                        toStoreId: PRIMARY,
                        moveId: randomUUID(),
                        copiedSince: null,
                    });
                let flipped: drive.ObjectFlip;
                if (order === 'outbox-first') {
                    // The outbox is inside the store's delete, holding the row, when the flip starts.
                    let release!: () => void;
                    const gate = new Promise<void>((resolve) => (release = resolve));
                    let entered!: () => void;
                    const inside = new Promise<void>((resolve) => (entered = resolve));
                    const slow = {
                        ...store({ backups: false }),
                        remove: async (storeId: string, objectKey: string) => {
                            entered();
                            await gate;
                            copies.delete(at(storeId, objectKey));
                        },
                    };
                    const deleting = drive.removeQueuedCopy(key(file, PRIMARY), slow);
                    await inside;
                    const flipping = flip();
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    release();
                    await deleting;
                    flipped = await flipping;
                    expect(flipped).toEqual({ status: 'copy-needed' });
                } else if (order === 'flip-first') {
                    flipped = await flip();
                    expect(await outbox()).toEqual({ status: 'skipped' });
                    expect(flipped).toEqual({ status: 'flipped', reused: true });
                } else [, flipped] = await Promise.all([outbox(), flip()]);
                const object = await objectRow(file.object.id);
                // Whatever the order: the copy the row names exists.
                expect(copies.has(at(object!.storeId, file.key)), `${order} ${round}`).toBe(true);
                // And when the flip took the old copy back, nothing is left queued against it.
                if (flipped.status === 'flipped')
                    expect(await row(file.object.id, PRIMARY)).toBeNull();
            }
    });

    test('an object that comes back by a fresh copy does not lose the backup copy made for it there', async () => {
        const file = await published();
        await drive.markObjectReplicated({ ...key(file, PRIMARY), backupStoreId: REPLICA });
        copies.add(at(REPLICA, file.key));
        const { moveId } = await moved(file, PRIMARY, second);
        await drive.releaseMoveHolds(moveId, new Date(Date.now() - 1000));
        // The old copy goes; its backup copy is to follow after the undo window.
        expect(await drive.removeQueuedCopy(key(file, PRIMARY), store())).toEqual({
            status: 'removed',
            backup: 'later',
        });
        // Before that, the object is copied back to the primary and backed up afresh, under the same key.
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect((await moved(file, second, PRIMARY)).flip).toEqual({
            status: 'flipped',
            reused: false,
        });
        await drive.markObjectReplicated({ ...key(file, PRIMARY), backupStoreId: REPLICA });
        // The row that was waiting to delete the backup copy is finished without deleting it.
        expect(await row(file.object.id, PRIMARY)).toMatchObject({ deleteReplicaAfter: null });
        expect((await row(file.object.id, PRIMARY))?.doneAt).not.toBeNull();
        expect(await drive.listBackupDeletionsDue()).toEqual([]);
        expect(await drive.removeQueuedBackupCopy(key(file, PRIMARY), store())).toEqual({
            status: 'skipped',
        });
        expect(copies.has(at(REPLICA, file.key))).toBe(true);
        // And a later move out queues the copy at the primary again, in place of the finished row.
        expect((await moved(file, PRIMARY, second)).flip).toEqual({
            status: 'flipped',
            reused: false,
        });
        expect(await row(file.object.id, PRIMARY)).toMatchObject({
            reason: 'moved',
            doneAt: null,
            primaryDeletedAt: null,
            backupStoreId: REPLICA,
        });
    });
});

describe('the backup copy', () => {
    test('a due backup deletion spares a copy that is a live object’s backup', async () => {
        // Two regions that share one backup store: the object moves from one to the other, and
        // its backup copy, under the same key in the same bucket, is the new region's too.
        const file = await published();
        await drive.markObjectReplicated({ ...key(file, PRIMARY), backupStoreId: REPLICA });
        copies.add(at(REPLICA, file.key));
        const { moveId } = await moved(file, PRIMARY, second);
        await drive.markObjectReplicated({ ...key(file, second), backupStoreId: REPLICA });
        await drive.releaseMoveHolds(moveId, new Date(Date.now() - 1000));
        expect(await drive.removeQueuedCopy(key(file, PRIMARY), store())).toEqual({
            status: 'removed',
            backup: 'later',
        });
        await setRow(file.object.id, PRIMARY, { deleteReplicaAfter: new Date(Date.now() - 1000) });
        expect(await drive.removeQueuedBackupCopy(key(file, PRIMARY), store())).toEqual({
            status: 'kept',
            why: 'live',
        });
        expect(copies.has(at(REPLICA, file.key))).toBe(true);
        expect((await row(file.object.id, PRIMARY))?.doneAt).not.toBeNull();
        // Once the object itself is purged, that copy goes with the purge's own row.
        await purge(file);
        expect(await row(file.object.id, second)).toMatchObject({
            reason: 'purged',
            backupStoreId: REPLICA,
        });
    });

    test('where HushOS may not delete from a backup, the row finishes with the copy recorded as left', async () => {
        await db.update(storageRegions).set({ backupPrune: false });
        const file = await published();
        await drive.markObjectReplicated({ ...key(file, PRIMARY), backupStoreId: REPLICA });
        copies.add(at(REPLICA, file.key));
        await purge(file);
        expect(await drive.removeQueuedCopy(key(file, PRIMARY), store())).toEqual({
            status: 'removed',
            backup: 'left',
        });
        const finished = await row(file.object.id, PRIMARY);
        expect(finished).toMatchObject({ backupLeft: true, deleteReplicaAfter: null });
        expect(finished?.doneAt).not.toBeNull();
        // Nothing was asked of the backup, then or later.
        expect(await drive.listBackupDeletionsDue()).toEqual([]);
        expect(removed).toEqual([at(PRIMARY, file.key)]);
        expect(copies.has(at(REPLICA, file.key))).toBe(true);
        // The row is kept past 30 days: the list that names the copy for the operator is not
        // written yet, and it is the only record that the copy is there.
        await setRow(file.object.id, PRIMARY, {
            doneAt: new Date(Date.now() - 40 * 24 * 3600_000),
        });
        expect(await drive.deleteFinishedObjectDeletions()).toBe(0);
        expect(await row(file.object.id, PRIMARY)).not.toBeNull();
    });

    test('a worker that can no longer open the backup leaves the copy and says so, instead of trying for ever', async () => {
        const file = await published();
        await drive.markObjectReplicated({ ...key(file, PRIMARY), backupStoreId: REPLICA });
        await purge(file);
        await drive.removeQueuedCopy(key(file, PRIMARY), store());
        await setRow(file.object.id, PRIMARY, { deleteReplicaAfter: new Date(Date.now() - 1000) });
        expect(
            await drive.removeQueuedBackupCopy(key(file, PRIMARY), store({ backups: false })),
        ).toEqual({ status: 'kept', why: 'left' });
        expect(await row(file.object.id, PRIMARY)).toMatchObject({ backupLeft: true });
        expect(removed).toEqual([at(PRIMARY, file.key)]);
    });

    test('the mark is a compare-and-set against the store the copy was read from', async () => {
        const file = await published();
        // A backup run reads the object at the primary; a flip lands before it marks.
        await moved(file, PRIMARY, second);
        expect(
            await drive.markObjectReplicated({ ...key(file, PRIMARY), backupStoreId: REPLICA }),
        ).toBe('outbox');
        // Not backed up where it now lives: the new region's backup still has it to copy.
        expect(await objectRow(file.object.id)).toMatchObject({
            replicatedAt: null,
            backupStoreId: null,
        });
        expect(
            (await drive.listUnreplicatedObjects(second)).map((entry) => entry.objectId),
        ).toEqual([file.object.id]);
        // The copy just made in the old backup is the old copy's row's to remove.
        expect(await row(file.object.id, PRIMARY)).toMatchObject({
            replicated: true,
            backupStoreId: REPLICA,
        });
        // An object nothing queues at that store: the copy is nobody's.
        const other = await published();
        expect(
            await drive.markObjectReplicated({ ...key(other, second), backupStoreId: REPLICA }),
        ).toBe('neither');
        expect(await objectRow(other.object.id)).toMatchObject({ replicatedAt: null });
        // And the plain case.
        expect(
            await drive.markObjectReplicated({ ...key(other, PRIMARY), backupStoreId: REPLICA }),
        ).toBe('object');
        expect(await objectRow(other.object.id)).toMatchObject({ backupStoreId: REPLICA });
    });

    test('objects that failed to copy come after the others, and one that failed ten times is left alone', async () => {
        const a = await published();
        const b = await published();
        const c = await published();
        const listed = async () =>
            (await drive.listUnreplicatedObjects(PRIMARY)).map((entry) => entry.objectId);
        expect(await listed()).toEqual([a.object.id, b.object.id, c.object.id]);
        await drive.recordObjectCopyFailure(key(a, PRIMARY));
        expect(await listed()).toEqual([b.object.id, c.object.id, a.object.id]);
        for (let tries = 1; tries < drive.COPY_FAILURE_LIMIT; tries++)
            await drive.recordObjectCopyFailure(key(a, PRIMARY));
        expect(await listed()).toEqual([b.object.id, c.object.id]);
        expect(await drive.countObjectsNotCopied(PRIMARY)).toBe(1);
        // A copy that succeeds after all starts the count again.
        await drive.markObjectReplicated({ ...key(a, PRIMARY), backupStoreId: REPLICA });
        expect(await objectRow(a.object.id)).toMatchObject({ copyFailures: 0 });
        expect(await drive.countObjectsNotCopied(PRIMARY)).toBe(0);
        // A failure on an object purged meanwhile is counted on its outbox row.
        await purge(b);
        await drive.recordObjectCopyFailure(key(b, PRIMARY));
        expect(await row(b.object.id, PRIMARY)).toMatchObject({ failures: 1 });
    });

    test('marks of the release before the backup column are rewritten to name the replica, a page at a time', async () => {
        const files = [];
        for (let index = 0; index < 5; index++) files.push(await published());
        // Three as that release's worker marked them, one never copied, one marked by this release.
        for (const file of files.slice(0, 3))
            await db
                .update(driveObjects)
                .set({ replicatedAt: new Date() })
                .where(eq(driveObjects.id, file.object.id));
        await drive.markObjectReplicated({ ...key(files[4]!, PRIMARY), backupStoreId: REPLICA });
        // And an outbox row that release's web container queued for a replicated object.
        const retired = randomUUID();
        await db.$client.query(
            `insert into drive_object_deletions (object_id, workspace_id, object_key, store_id, published, replicated) values ($1, $2, $3, $4, true, true)`,
            [retired, account.workspaceId, `ws/${account.workspaceId}/${retired}`, PRIMARY],
        );
        // Before the rewrite the old shape already reads as the replica where it matters.
        expect(await drive.knownObjectKeys(REPLICA, [files[0]!.key, files[3]!.key])).toEqual(
            new Set([files[0]!.key]),
        );
        expect(await drive.adoptLegacyBackupMarks(2)).toEqual({ objects: 3, outbox: 1 });
        const marks = Object.fromEntries(
            (await db.select().from(driveObjects)).map((entry) => [entry.id, entry.backupStoreId]),
        );
        expect(files.map((file) => marks[file.object.id])).toEqual([
            REPLICA,
            REPLICA,
            REPLICA,
            null,
            REPLICA,
        ]);
        expect((await row(retired, PRIMARY))?.backupStoreId).toBe(REPLICA);
        expect(await drive.adoptLegacyBackupMarks(2)).toEqual({ objects: 0, outbox: 0 });
    });

    test('a replicated object purged by the previous release’s shape still has its replica copy removed', async () => {
        // `replicated` with no backup store named: the replica is meant.
        const retired = randomUUID();
        const objectKey = `ws/${account.workspaceId}/${retired}`;
        await db.$client.query(
            `insert into drive_object_deletions (object_id, workspace_id, object_key, store_id, published, replicated) values ($1, $2, $3, $4, true, true)`,
            [retired, account.workspaceId, objectKey, PRIMARY],
        );
        copies.add(at(PRIMARY, objectKey));
        copies.add(at(REPLICA, objectKey));
        const retiredKey = { objectId: retired, storeId: PRIMARY };
        expect(await drive.removeQueuedCopy(retiredKey, store())).toEqual({
            status: 'removed',
            backup: 'later',
        });
        await setRow(retired, PRIMARY, { deleteReplicaAfter: new Date(Date.now() - 1000) });
        expect(await drive.removeQueuedBackupCopy(retiredKey, store())).toEqual({
            status: 'removed',
        });
        expect(copies).toEqual(new Set());
    });
});

describe('known at this store', () => {
    test('a key is known where a row says the object or its backup is, or where an unfinished row is for it, and nowhere else', async () => {
        const live = await published();
        await drive.markObjectReplicated({ ...key(live, PRIMARY), backupStoreId: REPLICA });
        const elsewhere = await published();
        await moved(elsewhere, PRIMARY, second);
        const retired = await published();
        await drive.markObjectReplicated({ ...key(retired, PRIMARY), backupStoreId: REPLICA });
        await purge(retired);
        const keys = [live.key, elsewhere.key, retired.key, `ws/${account.workspaceId}/nothing`];
        expect(await drive.knownObjectKeys(PRIMARY, keys)).toEqual(
            // The moved object's old copy is still queued here, unfinished.
            new Set([live.key, elsewhere.key, retired.key]),
        );
        expect(await drive.knownObjectKeys(second, keys)).toEqual(new Set([elsewhere.key]));
        expect(await drive.knownObjectKeys(REPLICA, keys)).toEqual(
            new Set([live.key, retired.key]),
        );

        // The old copy's row finishes: the object's row, which names another store, makes
        // nothing known at the primary any more.
        await setRow(elsewhere.object.id, PRIMARY, { doneAt: new Date() });
        expect(await drive.knownObjectKeys(PRIMARY, [elsewhere.key])).toEqual(new Set());
        // The purged object's row finishes: known nowhere.
        await setRow(retired.object.id, PRIMARY, { doneAt: new Date() });
        expect(await drive.knownObjectKeys(PRIMARY, [retired.key])).toEqual(new Set());
        expect(await drive.knownObjectKeys(REPLICA, [retired.key])).toEqual(new Set());
    });

    test('finished rows are removed 30 days after they finished, and not a day sooner', async () => {
        const old = await published();
        const recent = await published();
        const waiting = await published();
        for (const file of [old, recent, waiting]) await purge(file);
        const day = 24 * 3600_000;
        await setRow(old.object.id, PRIMARY, { doneAt: new Date(Date.now() - 31 * day) });
        await setRow(recent.object.id, PRIMARY, { doneAt: new Date(Date.now() - 29 * day) });
        // Unfinished for longer than that: never removed here.
        await setRow(waiting.object.id, PRIMARY, { createdAt: new Date(Date.now() - 90 * day) });
        expect(await drive.deleteFinishedObjectDeletions()).toBe(1);
        expect(await row(old.object.id, PRIMARY)).toBeNull();
        expect(await row(recent.object.id, PRIMARY)).not.toBeNull();
        expect(await row(waiting.object.id, PRIMARY)).not.toBeNull();
        expect(await drive.deleteFinishedObjectDeletions()).toBe(0);
    });
});

describe('a workspace deleted whole', () => {
    test('deleting an account queues every object of its own space at the store its row names, with its backup copy', async () => {
        const { user, workspaceId } = await registered();
        const token = await signedIn(user.id);
        const object = (storeId: string, set: Record<string, unknown> = {}) => {
            const id = randomUUID();
            return {
                id,
                workspaceId,
                objectKey: `ws/${workspaceId}/${id}`,
                storeId,
                chunkSize: 1,
                chunkCount: 1,
                contentNonce: randomBytes(16),
                ciphertextSize: 17n,
                status: 'ready' as const,
                ...set,
            };
        };
        const here = object(PRIMARY, { replicatedAt: new Date(), backupStoreId: REPLICA });
        const there = object(second);
        const legacy = object(PRIMARY, { replicatedAt: new Date() });
        const pending = object(PRIMARY, { status: 'pending' as const });
        await db.insert(driveObjects).values([here, there, legacy, pending]);
        // Someone else's object, which must not be queued by this deletion.
        const bystander = await published();
        // One of them was moved earlier: its old copy is still held for that move.
        await db.insert(driveObjectDeletions).values({
            objectId: there.id,
            workspaceId,
            objectKey: there.objectKey,
            storeId: PRIMARY,
            reason: 'moved',
            published: true,
            heldByMove: randomUUID(),
        });

        expect(
            await auth.deleteAccount({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash: token,
            }),
        ).toBe(true);
        expect(await db.select().from(driveObjects)).toHaveLength(1);
        const queued = await db.select().from(driveObjectDeletions);
        const summary = queued
            .map((entry) => [
                entry.objectId,
                entry.storeId,
                entry.reason,
                entry.published,
                entry.replicated,
                entry.backupStoreId,
                entry.heldByMove,
            ])
            .sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`));
        expect(summary).toEqual(
            [
                [here.id, PRIMARY, 'purged', true, true, REPLICA, null],
                [there.id, second, 'purged', true, false, null, null],
                // The copy its move left behind no longer waits for anything.
                [there.id, PRIMARY, 'moved', true, false, null, null],
                // The old shape of a backup mark is read as the replica.
                [legacy.id, PRIMARY, 'purged', true, true, REPLICA, null],
                [pending.id, PRIMARY, 'purged', false, false, null, null],
            ].sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`)),
        );
        expect(queued.map((entry) => entry.objectId)).not.toContain(bystander.object.id);
    });
});
