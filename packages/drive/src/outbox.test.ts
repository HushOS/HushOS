import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { startS3 } from '../test/s3-server';

/*
 * The deletion outbox, the orphan sweep and the backup copy, with real bytes
 * (docs/company-storage-design.md 8.4, and the outbox tests of its section
 * 15): a real database, and four buckets in an S3 server in this process, so
 * "nothing is left" and "nothing live was touched" are read off the buckets.
 *
 * Two stores hold objects: the environment's primary, backed up by the
 * environment's replica, and a second region's store with a backup of its
 * own. This process holds the replica's variables, as the worker does; the
 * second store and its backup are `database` rows, which nothing can open by
 * itself yet, so the jobs are handed an opener for them, as they take one.
 *
 * No move exists yet. `move` below stands in for one: it does what section 8.2
 * says a move's copy step does (see the target's old copy at the row's size
 * and take it back, or copy the bytes; then flip), through the repository's
 * flip, which is what a move will call.
 */

const s3 = await startS3();
const PRIMARY = s3.bucket('primary');
const REPLICA = s3.bucket('replica');
const SECOND = s3.bucket('second');
const SECOND_BACKUP = s3.bucket('second-backup');
const credentials = { accessKeyId: 'test-key-id', secretAccessKey: 'test-secret-value' };
Object.assign(process.env, {
    STORAGE_ENDPOINT: s3.url,
    STORAGE_BUCKET: PRIMARY,
    STORAGE_ACCESS_KEY_ID: credentials.accessKeyId,
    STORAGE_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    STORAGE_FORCE_PATH_STYLE: 'true',
    STORAGE_REPLICA_ENDPOINT: s3.url,
    STORAGE_REPLICA_BUCKET: REPLICA,
    STORAGE_REPLICA_ACCESS_KEY_ID: credentials.accessKeyId,
    STORAGE_REPLICA_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    STORAGE_REPLICA_FORCE_PATH_STYLE: 'true',
});
delete process.env.STORAGE_INTERNAL_ENDPOINT;

// After the environment is set: these read it when they load.
const {
    authRepository,
    driveRepository,
    ENVIRONMENT_PRIMARY_STORE_ID: PRIMARY_ID,
    ENVIRONMENT_REPLICA_STORE_ID: REPLICA_ID,
} = await import('@hushos/db');
const logging = await import('@hushos/logging');
const { db } = await import('../../db/src/client');
// What only a move will call is not on the repository yet.
const outbox = await import('../../db/src/outbox');
const { driveObjectDeletions, driveObjects } = await import('../../db/src/schema');
const { registered, signedIn } = await import('../../db/test/accounts');
const { closeDatabase, createTestStore, resetDatabase } = await import('../../db/test/helpers');
const signed = await import('../../db/test/signed');
const fixtures = await import('../test/fixtures');
const jobs = await import('./jobs');
const { createObjectStore, storeFor } = await import('./storage');

type Account = Awaited<ReturnType<typeof fixtures.member>>;
type Store = ReturnType<typeof createObjectStore>;

const DAY = 24 * 3600 * 1000;
const OLD = new Date(Date.now() - 30 * DAY);
const run = (text: string, params: unknown[] = []) => db.$client.query(text, params);
const bucketStore = (bucket: string): Store =>
    createObjectStore({
        endpoint: s3.url,
        region: 'auto',
        bucket,
        forcePathStyle: true,
        ...credentials,
    });

let owner: Account;
let root: Awaited<ReturnType<typeof fixtures.root>>;
let secondId: string;
let secondBackupId: string;
let opened: Record<string, Store>;
let open: (storeId: string) => Promise<Store>;
/* Both regions' backups, as a worker that keeps both would be told. */
let BACKUPS: { storeId: string; backupStoreId: string }[];
let stores: { open: typeof open; backups: typeof BACKUPS };

beforeEach(async () => {
    s3.reset();
    await resetDatabase();
    owner = await fixtures.member();
    root = await fixtures.root(owner);
    secondId = await createTestStore({ bucket: SECOND });
    const backup = await run(
        `insert into object_stores (source, kind, endpoint, signing_region, bucket, path_style, seal, secret_key_id, secret_sealed, status)
         values ('database', 'backup', 'https://s3.store.test', 'auto', $1, false, 'worker', $2, $3, 'ready') returning id`,
        [SECOND_BACKUP, randomBytes(8), randomBytes(64)],
    );
    secondBackupId = backup.rows[0].id;
    await run(
        `insert into storage_regions (code, label, store_id, backup_store_id, backup_prune, offered) values ('second', 'Second', $1, $2, true, true)`,
        [secondId, secondBackupId],
    );
    opened = { [secondId]: bucketStore(SECOND), [secondBackupId]: bucketStore(SECOND_BACKUP) };
    open = async (storeId) => opened[storeId] ?? storeFor(storeId);
    BACKUPS = [
        { storeId: PRIMARY_ID, backupStoreId: REPLICA_ID },
        { storeId: secondId, backupStoreId: secondBackupId },
    ];
    stores = { open, backups: BACKUPS };
});
afterAll(async () => {
    await closeDatabase();
    await s3.stop();
});

const keyOf = (objectId: string, workspaceId = owner.workspaceId) =>
    `ws/${workspaceId}/${objectId}`;
const bucketOf = (storeId: string) =>
    ({
        [PRIMARY_ID]: PRIMARY,
        [REPLICA_ID]: REPLICA,
        [secondId]: SECOND,
        [secondBackupId]: SECOND_BACKUP,
    })[storeId]!;
const everywhere = () => [PRIMARY, REPLICA, SECOND, SECOND_BACKUP].map((bucket) => s3.keys(bucket));
const NOWHERE = [[], [], [], []];

/* A published file whose object row names `storeId`, its bytes in that store's bucket. */
async function storedFile(storeId = PRIMARY_ID, bytes = randomBytes(1024)) {
    const node = await fixtures.file(owner, root, BigInt(bytes.length));
    const objectId = node.currentVersion!.objectId;
    await run('update drive_objects set store_id = $1 where id = $2', [storeId, objectId]);
    s3.put(bucketOf(storeId), keyOf(objectId), bytes, OLD);
    return {
        nodeId: node.id,
        objectId,
        key: keyOf(objectId),
        bytes,
        object: { id: objectId, workspaceId: owner.workspaceId, objectKey: keyOf(objectId) },
    };
}
type File = Awaited<ReturnType<typeof storedFile>>;

async function purge(file: File) {
    await driveRepository.trashNode({ workspaceId: owner.workspaceId, nodeId: file.nodeId });
    await driveRepository.purgeNode({ workspaceId: owner.workspaceId, nodeId: file.nodeId });
}

/* A move's copy step for one object, standing in for the move job (section 8.2, step 4). */
async function move(file: File, fromStoreId: string, toStoreId: string, moveId: string) {
    const flip = (copiedSince: string | null) =>
        outbox.flipObjectStore({
            object: file.object,
            fromStoreId,
            toStoreId,
            moveId,
            copiedSince,
        });
    const target = await open(toStoreId);
    // The target still has the copy the object left there, at the row's size: take it back.
    const old = await target.head(file.key);
    if (old && old.size === file.bytes.length) {
        const taken = await flip(null);
        if (taken.status !== 'copy-needed') return taken;
    }
    const copiedSince = await outbox.databaseNow();
    await target.copyFrom(await open(fromStoreId), file.key);
    return flip(copiedSince);
}

/* Every wait in the outbox is over: old copies' dates, and backup copies' undo windows. */
async function waitsOver() {
    await run(
        `update drive_object_deletions set not_before = now() - interval '1 second' where not_before is not null`,
    );
    await run(
        `update drive_object_deletions set delete_replica_after = now() - interval '1 second' where delete_replica_after is not null`,
    );
}
/*
 * The worker's copy and deletion jobs, run as it runs them, until the outbox
 * has nothing left to do, each wait having passed.
 */
async function drain() {
    for (let pass = 0; pass < 3; pass++) {
        await jobs.replicateObjects(stores);
        await jobs.deleteObjects(stores);
        await waitsOver();
    }
    return jobs.deleteObjects(stores);
}

const outboxRows = () => db.select().from(driveObjectDeletions);
const storeOf = async (objectId: string) =>
    (await run('select store_id from drive_objects where id = $1', [objectId])).rows[0]?.store_id;
const knownAnywhere = async (key: string) =>
    (
        await Promise.all(
            [PRIMARY_ID, REPLICA_ID, secondId, secondBackupId].map((storeId) =>
                driveRepository.knownObjectKeys(storeId, [key]),
            ),
        )
    ).some((known) => known.has(key));
const deletesOf = (bucket: string, key: string) =>
    s3.requests.filter(
        (request) =>
            request.method === 'DELETE' && request.bucket === bucket && request.key === key,
    ).length;

describe('nothing purged is kept', () => {
    test('a purged object leaves its store at once and its backup after the undo window, and not before', async () => {
        const file = await storedFile();
        const live = await storedFile();
        expect(await jobs.replicateObjects(stores)).toMatchObject({ copied: 2, failed: 0 });
        await purge(file);
        expect(await jobs.deleteObjects(stores)).toMatchObject({ primaries: 1, replicas: 0 });
        expect(s3.keys(PRIMARY)).toEqual([live.key]);
        // Thirty days to undo a bad purge: the backup copy is still there, byte for byte.
        expect(s3.get(REPLICA, file.key)).toEqual(file.bytes);
        expect(await jobs.deleteObjects(stores)).toMatchObject({ primaries: 0, replicas: 0 });
        await waitsOver();
        expect(await jobs.deleteObjects(stores)).toMatchObject({ replicas: 1 });
        // Gone from both, and the file nobody purged is where it was, in both.
        expect(s3.keys(PRIMARY)).toEqual([live.key]);
        expect(s3.keys(REPLICA)).toEqual([live.key]);
        expect(s3.get(PRIMARY, live.key)).toEqual(live.bytes);
    });

    test('a published object purged before its backup existed is copied first, then deleted from both', async () => {
        const file = await storedFile();
        await purge(file);
        // Its only copy: the primary stays until the backup holds it.
        expect(await jobs.deleteObjects(stores)).toMatchObject({ primaries: 0, waiting: 1 });
        expect(s3.get(PRIMARY, file.key)).toEqual(file.bytes);
        expect(await jobs.replicateObjects(stores)).toMatchObject({ copied: 1 });
        expect(s3.get(REPLICA, file.key)).toEqual(file.bytes);
        expect(await drain()).toMatchObject({ failed: 0 });
        expect(everywhere()).toEqual(NOWHERE);
        // A purged file whose bytes are already gone from its store can never be backed up:
        // its row does not wait for a copy that cannot be made.
        const lost = await storedFile();
        await purge(lost);
        s3.remove(PRIMARY, lost.key);
        expect(await jobs.deleteObjects(stores)).toMatchObject({ primaries: 1, waiting: 0 });
        expect((await outboxRows()).every((row) => row.doneAt !== null)).toBe(true);
        // A worker that keeps no backup waits for none.
        const other = await storedFile();
        await purge(other);
        expect(await jobs.deleteObjects({ open, backups: [] })).toMatchObject({ primaries: 1 });
        expect(everywhere()).toEqual(NOWHERE);
    });

    test('an object moved and then purged leaves nothing at either store, and neither key is known to the sweep afterwards', async () => {
        const file = await storedFile();
        const moveId = randomUUID();
        expect(await move(file, PRIMARY_ID, secondId, moveId)).toEqual({
            status: 'flipped',
            reused: false,
        });
        expect(s3.get(SECOND, file.key)).toEqual(file.bytes);
        // The old copy waits for its move: the outbox leaves both copies alone.
        expect(await jobs.deleteObjects(stores)).toMatchObject({ primaries: 0 });
        expect(s3.get(PRIMARY, file.key)).toEqual(file.bytes);

        await purge(file);
        expect(await drain()).toMatchObject({ failed: 0 });
        expect(everywhere()).toEqual(NOWHERE);
        expect(await knownAnywhere(file.key)).toBe(false);
        // So a copy of that key that turns up again at either store is an orphan there.
        s3.put(PRIMARY, file.key, file.bytes, OLD);
        s3.put(SECOND, file.key, file.bytes, OLD);
        expect(await jobs.sweepOrphans(stores)).toMatchObject({ deleted: 2, failed: 0 });
        expect(everywhere()).toEqual(NOWHERE);
    });

    test('the round trip: moved out, the wait waited out, moved back, then purged, leaves nothing at either store or either backup', async () => {
        const file = await storedFile();
        await jobs.replicateObjects(stores);
        expect(s3.keys(REPLICA)).toEqual([file.key]);

        const out = randomUUID();
        await move(file, PRIMARY_ID, secondId, out);
        // The new region's backup copies it afresh; the mark it had is gone with the flip.
        expect(await jobs.replicateObjects(stores)).toMatchObject({ copied: 1 });
        expect(s3.keys(SECOND_BACKUP)).toEqual([file.key]);
        // The move is done, the old copy's wait passes, and its row finishes: copy and backup copy gone.
        await outbox.releaseMoveHolds(out, new Date(Date.now() + 7 * DAY));
        expect(await jobs.deleteObjects(stores)).toMatchObject({ primaries: 0 });
        expect(s3.keys(PRIMARY)).toEqual([file.key]);
        await drain();
        expect([s3.keys(PRIMARY), s3.keys(REPLICA)]).toEqual([[], []]);
        const finished = (await outboxRows()).find((row) => row.storeId === PRIMARY_ID);
        expect(finished).toMatchObject({ reason: 'moved' });
        expect(finished?.doneAt).not.toBeNull();

        // Within the 30 days that finished row is kept, the object comes back...
        const back = randomUUID();
        expect(await move(file, secondId, PRIMARY_ID, back)).toEqual({
            status: 'flipped',
            reused: false,
        });
        expect(s3.get(PRIMARY, file.key)).toEqual(file.bytes);
        expect(await jobs.replicateObjects(stores)).toMatchObject({ copied: 1 });
        expect(s3.keys(REPLICA)).toEqual([file.key]);
        // ...and is purged where it lives. A dropped insert would leave this copy and its backup for ever.
        await purge(file);
        expect(await drain()).toMatchObject({ failed: 0 });
        expect(everywhere()).toEqual(NOWHERE);
        expect(await knownAnywhere(file.key)).toBe(false);
        expect((await outboxRows()).every((row) => row.doneAt !== null)).toBe(true);
    });

    test('where HushOS may not delete from the backup, the row finishes with the copy recorded as left there', async () => {
        await run(`update storage_regions set backup_prune = false where code = 'default'`);
        const file = await storedFile();
        await jobs.replicateObjects(stores);
        await purge(file);
        expect(await jobs.deleteObjects(stores)).toMatchObject({ primaries: 1, left: 1 });
        await waitsOver();
        expect(await jobs.deleteObjects(stores)).toMatchObject({ replicas: 0 });
        expect(s3.keys(PRIMARY)).toEqual([]);
        // Nothing was ever asked of the backup but the copy.
        expect(s3.get(REPLICA, file.key)).toEqual(file.bytes);
        expect(deletesOf(REPLICA, file.key)).toBe(0);
        const [row] = await outboxRows();
        expect(row).toMatchObject({ backupLeft: true, backupStoreId: REPLICA_ID });
        expect(row?.doneAt).not.toBeNull();
    });

    test('a row the previous release queued is deleted from the environment’s primary, and from the replica it meant', async () => {
        // As that release wrote it: a store, no reason, no backup store, `replicated` for the replica.
        const objectId = randomUUID();
        const key = keyOf(objectId);
        await run(
            `insert into drive_object_deletions (object_id, workspace_id, object_key, store_id, published, replicated) values ($1, $2, $3, $4, true, true)`,
            [objectId, owner.workspaceId, key, PRIMARY_ID],
        );
        for (const bucket of [PRIMARY, REPLICA, SECOND]) s3.put(bucket, key, randomBytes(64), OLD);
        await drain();
        expect([s3.keys(PRIMARY), s3.keys(REPLICA)]).toEqual([[], []]);
        // And from nowhere else.
        expect(s3.keys(SECOND)).toEqual([key]);
    });

    test('finished rows are removed after 30 days, and from the day they finish they make no key known', async () => {
        const file = await storedFile();
        await purge(file);
        await jobs.deleteObjects({ open, backups: [] });
        expect((await outboxRows())[0]?.doneAt).not.toBeNull();
        // The same key back in the bucket while the finished row is still kept: an orphan.
        s3.put(PRIMARY, file.key, file.bytes, OLD);
        expect(await jobs.sweepOrphans(stores)).toMatchObject({ deleted: 1 });
        expect(await jobs.deleteObjects(stores)).toMatchObject({ cleared: 0 });
        await run(`update drive_object_deletions set done_at = now() - interval '31 days'`);
        expect(await jobs.deleteObjects(stores)).toMatchObject({ cleared: 1 });
        expect(await outboxRows()).toEqual([]);
    });
});

describe('nothing that should be kept is deleted', () => {
    test('a moved copy whose new copy is absent, or the wrong size, is not deleted and is marked for attention', async () => {
        const absent = await storedFile();
        const short = await storedFile();
        const fine = await storedFile();
        const moveId = randomUUID();
        for (const file of [absent, short, fine]) await move(file, PRIMARY_ID, secondId, moveId);
        await outbox.releaseMoveHolds(moveId, new Date(Date.now() - 1000));
        // The new store lost one and truncated another since they were verified.
        s3.remove(SECOND, absent.key);
        s3.put(SECOND, short.key, short.bytes.subarray(0, 100));
        const logged = vi.spyOn(logging.log, 'error').mockImplementation(() => undefined);
        try {
            expect(await jobs.deleteObjects(stores)).toMatchObject({
                primaries: 1,
                attention: 2,
                failed: 0,
            });
            // The old copies are the only whole ones left, and they are still there.
            expect(s3.get(PRIMARY, absent.key)).toEqual(absent.bytes);
            expect(s3.get(PRIMARY, short.key)).toEqual(short.bytes);
            expect(s3.get(PRIMARY, fine.key)).toBeNull();
            const marked = Object.fromEntries(
                (await outboxRows()).map((row) => [row.objectId, row.attention]),
            );
            expect(marked).toEqual({
                [absent.objectId]: true,
                [short.objectId]: true,
                [fine.objectId]: false,
            });
            // Operators are told once per row, by ids and a class of reason, and never again on a retry.
            expect(await jobs.deleteObjects(stores)).toMatchObject({ primaries: 0, attention: 2 });
            expect(logged).toHaveBeenCalledTimes(2);
            const said = JSON.stringify(logged.mock.calls);
            expect(said).toContain(absent.objectId);
            expect(said).toContain('new-copy-absent');
            for (const secret of [s3.url, SECOND, PRIMARY, ...Object.values(credentials)])
                expect(said).not.toContain(secret);
        } finally {
            logged.mockRestore();
        }
        // The new copy healed, the old one may go.
        s3.put(SECOND, absent.key, absent.bytes);
        expect(await jobs.deleteObjects(stores)).toMatchObject({ primaries: 1, attention: 1 });
        expect(s3.get(PRIMARY, absent.key)).toBeNull();
        expect(s3.get(SECOND, absent.key)).toEqual(absent.bytes);
    });

    test('a move cancelled after flips, then eight days: every object is readable, and no moved row is left for a store an object lives at', async () => {
        const files = [await storedFile(), await storedFile(), await storedFile()];
        const out = randomUUID();
        // Two had flipped when the move was cancelled.
        for (const file of files.slice(0, 2)) await move(file, PRIMARY_ID, secondId, out);
        const back = randomUUID();
        const copiesBefore = s3.requests.filter((request) => request.method === 'PUT').length;
        for (const file of files.slice(0, 2))
            expect(await move(file, secondId, PRIMARY_ID, back)).toEqual({
                status: 'flipped',
                reused: true,
            });
        // Taken back, not copied again.
        expect(s3.requests.filter((request) => request.method === 'PUT').length).toBe(copiesBefore);
        await outbox.releaseMoveHolds(back, new Date(Date.now() - 1000));
        await run(`update drive_object_deletions set created_at = created_at - interval '8 days'`);
        await drain();
        for (const file of files) {
            const storeId = await storeOf(file.objectId);
            expect(storeId).toBe(PRIMARY_ID);
            expect(s3.get(bucketOf(storeId), file.key)).toEqual(file.bytes);
        }
        const left = (await outboxRows()).filter((row) => row.doneAt === null);
        expect(left).toEqual([]);
        // What the cancelled move had copied out is cleaned up; nothing else was.
        expect(s3.keys(SECOND)).toEqual([]);
        expect(s3.keys(PRIMARY).sort()).toEqual(files.map((file) => file.key).sort());
    });

    test('a flip back to a store whose old copy is gone, or is there at another size, copies the bytes again', async () => {
        const gone = await storedFile();
        const short = await storedFile();
        const out = randomUUID();
        for (const file of [gone, short]) await move(file, PRIMARY_ID, secondId, out);
        // The copies they left at the primary are damaged before the move is cancelled.
        s3.remove(PRIMARY, gone.key);
        s3.put(PRIMARY, short.key, short.bytes.subarray(0, 10));
        const back = randomUUID();
        for (const file of [gone, short])
            expect(await move(file, secondId, PRIMARY_ID, back)).toEqual({
                status: 'flipped',
                reused: false,
            });
        for (const file of [gone, short]) expect(s3.get(PRIMARY, file.key)).toEqual(file.bytes);
        // No row is left that would delete the copies just made.
        expect((await outboxRows()).filter((row) => row.storeId === PRIMARY_ID)).toEqual([]);
    });

    test('a report’s hold keeps the bytes through a purge, at the store and in its backup, until the report lets go', async () => {
        const file = await storedFile();
        await jobs.replicateObjects(stores);
        const reportId = randomUUID();
        await run(
            `insert into drive_reports (id, workspace_id, node_id, node_kind, key_epoch, category, reason) values ($1, $2, $3, 'file', 1, 'other', 'Looks wrong.')`,
            [reportId, owner.workspaceId, file.nodeId],
        );
        await run(
            `insert into drive_report_items (report_id, node_id, depth, kind, key_epoch, parent_key_epoch, key_envelope, metadata_version, metadata_envelope, version_id, object_id, object_key, content_key_envelope, content_nonce, content_suite, chunk_size, chunk_count, ciphertext_size) values ($1, $2, 0, 'file', 1, 1, $3, 1, $4, $5, $6, $7, $8, $9, 3, 8388608, 1, 1024)`,
            [
                reportId,
                file.nodeId,
                randomBytes(72),
                randomBytes(100),
                randomUUID(),
                file.objectId,
                file.key,
                randomBytes(84),
                randomBytes(16),
            ],
        );
        await purge(file);
        await drain();
        await jobs.sweepOrphans(stores);
        expect(s3.get(PRIMARY, file.key)).toEqual(file.bytes);
        expect(s3.get(REPLICA, file.key)).toEqual(file.bytes);
        await run(`update drive_reports set status = 'dismissed' where id = $1`, [reportId]);
        await drain();
        expect(everywhere()).toEqual(NOWHERE);
    });
});

describe('the orphan sweep, store by store', () => {
    test('deletes only what nothing accounts for at the store it was listed at', async () => {
        const live = await storedFile();
        const elsewhere = await storedFile(secondId);
        const queued = await storedFile();
        await purge(queued);
        // An upload still in flight, its bytes already whole at the store and old.
        const pending = randomUUID();
        const begun = await signed.beginUpload({
            workspaceId: owner.workspaceId,
            userId: owner.userId,
            node: {
                existing: false,
                id: randomUUID(),
                parentId: root.id,
                envelopes: {
                    keyEpoch: await fixtures.epoch(owner.workspaceId),
                    parentKeyEpoch: root.keyEpoch,
                    keyEnvelope: fixtures.keyEnvelope(),
                    metadataEnvelope: fixtures.metadataEnvelope(),
                },
            },
            version: { id: randomUUID(), contentKeyEnvelope: randomBytes(84) },
            object: {
                id: pending,
                objectKey: keyOf(pending),
                contentSuite: 3,
                chunkSize: 8 * 1024 * 1024,
                chunkCount: 1,
                contentNonce: randomBytes(16),
                ciphertextSize: 80n,
            },
            multipartId: `mp-${pending}`,
            expiresAt: new Date(Date.now() + 3600_000),
        });
        expect(begun.status).toBe('ok');
        s3.put(PRIMARY, keyOf(pending), randomBytes(80), OLD);
        // A copy of the second store's object under the same key in the primary, where no row says it is.
        s3.put(PRIMARY, elsewhere.key, elsewhere.bytes, OLD);
        // Orphans, old and young, in both stores and in a backup.
        const orphan = keyOf(randomUUID());
        const young = keyOf(randomUUID());
        for (const bucket of [PRIMARY, SECOND, REPLICA])
            s3.put(bucket, orphan, randomBytes(8), OLD);
        s3.put(PRIMARY, young, randomBytes(8), new Date(Date.now() - 6 * DAY));

        expect(await jobs.sweepOrphans(stores)).toMatchObject({
            stores: 2,
            deleted: 3,
            failed: 0,
            completed: true,
        });
        expect(s3.keys(PRIMARY).sort()).toEqual(
            [live.key, queued.key, keyOf(pending), young].sort(),
        );
        // The object that lives at the second store is untouched there; only the stray copy went.
        expect(s3.keys(SECOND)).toEqual([elsewhere.key]);
        expect(s3.get(SECOND, elsewhere.key)).toEqual(elsewhere.bytes);
        // A backup is never swept.
        expect(s3.keys(REPLICA)).toEqual([orphan]);
        // Every deletion went to the bucket the key was listed in.
        expect(deletesOf(SECOND, elsewhere.key)).toBe(0);
        expect(deletesOf(PRIMARY, elsewhere.key)).toBe(1);
    });

    test('each store has its own cursor, and one store that cannot be opened does not stop the others', async () => {
        // More than one page in the primary; one orphan in the second store; a third region nobody can open.
        const strays: string[] = [];
        for (let index = 0; index < 1001; index++) {
            const key = `ws/${owner.workspaceId}/stray-${String(index).padStart(4, '0')}`;
            strays.push(key);
            s3.put(PRIMARY, key, Buffer.alloc(1), OLD);
        }
        s3.put(SECOND, strays[0]!, Buffer.alloc(1), OLD);
        const unopened = await createTestStore();
        const first = await jobs.sweepOrphans(stores, { pages: 1 });
        expect(first).toMatchObject({
            stores: 3,
            listed: 1001,
            deleted: 1001,
            failed: 1,
            completed: false,
            failures: { StoreUnavailableError: 1 },
        });
        expect(s3.keys(SECOND)).toEqual([]);
        expect(s3.keys(PRIMARY)).toEqual([strays[1000]]);
        // The primary resumes where it stopped; the second store starts over; neither shares a cursor.
        expect(await driveRepository.getSweepCursor(jobs.orphanSweepName(PRIMARY_ID))).toBe(
            strays[999],
        );
        expect(await driveRepository.getSweepCursor(jobs.orphanSweepName(secondId))).toBeNull();
        expect(await driveRepository.getSweepCursor(jobs.orphanSweepName(unopened))).toBeNull();
        expect(await jobs.sweepOrphans(stores, { pages: 1 })).toMatchObject({
            listed: 1,
            deleted: 1,
        });
        expect(s3.keys(PRIMARY)).toEqual([]);
        expect(await driveRepository.getSweepCursor(jobs.orphanSweepName(PRIMARY_ID))).toBeNull();
    });

    test('a pause after a restore stops every store’s sweep', async () => {
        for (const bucket of [PRIMARY, SECOND])
            s3.put(bucket, keyOf(randomUUID()), Buffer.alloc(1), OLD);
        const result = await jobs.sweepOrphans(stores, {
            pausedUntil: new Date(Date.now() + DAY),
        });
        expect(result).toMatchObject({ skipped: 'paused' });
        expect([s3.keys(PRIMARY).length, s3.keys(SECOND).length]).toEqual([1, 1]);
    });
});

describe('loops survive one failure', () => {
    test('one store that is down and one that cannot be opened do not stop the outbox, and no copy is deleted twice', async () => {
        const fine = await storedFile();
        const refused = await storedFile(secondId);
        const unopened = await createTestStore();
        const stuck = await storedFile();
        await run('update drive_objects set store_id = $1 where id = $2', [
            unopened,
            stuck.objectId,
        ]);
        for (const file of [refused, stuck, fine]) await purge(file);
        // Oldest first: the two that fail are ahead of the one that works.
        await run(
            `update drive_object_deletions set created_at = now() - interval '1 hour' where object_id <> $1`,
            [fine.objectId],
        );

        s3.hooks.refuse = (request) =>
            request.method === 'DELETE' && request.bucket === SECOND ? 500 : undefined;
        const none = { open, backups: [] };
        const first = await jobs.deleteObjects(none);
        expect(first).toMatchObject({ primaries: 1, failed: 2 });
        // What is recorded of a failure is its class: no address, no bucket, no key, no answer.
        expect(Object.keys(first.failures).sort()).toEqual([
            'InternalError',
            'StoreUnavailableError',
        ]);
        const text = JSON.stringify(first);
        for (const secret of [s3.url, new URL(s3.url).port, SECOND, ...Object.values(credentials)])
            expect(text).not.toContain(secret);
        expect(s3.get(PRIMARY, fine.key)).toBeNull();
        expect(s3.get(SECOND, refused.key)).toEqual(refused.bytes);
        // Neither row is lost, neither is marked as done, and each remembers that it failed.
        const rows = Object.fromEntries((await outboxRows()).map((row) => [row.objectId, row]));
        expect(rows[refused.objectId]).toMatchObject({
            failures: 1,
            primaryDeletedAt: null,
            doneAt: null,
        });
        expect(rows[stuck.objectId]).toMatchObject({
            failures: 1,
            primaryDeletedAt: null,
            doneAt: null,
        });
        expect(rows[fine.objectId]?.doneAt).not.toBeNull();

        // The store recovers: the row that failed is retried and deleted, exactly once.
        s3.hooks.refuse = undefined;
        const requestsBefore = deletesOf(SECOND, refused.key);
        expect(await jobs.deleteObjects(none)).toMatchObject({ primaries: 1, failed: 1 });
        expect(s3.get(SECOND, refused.key)).toBeNull();
        expect(await jobs.deleteObjects(none)).toMatchObject({ primaries: 0, failed: 1 });
        expect(deletesOf(SECOND, refused.key)).toBe(requestsBefore + 1);
        expect(deletesOf(PRIMARY, fine.key)).toBe(1);
        // The one nobody can open is still queued, for the day somebody can.
        expect(
            (await outboxRows()).filter((row) => row.doneAt === null).map((row) => row.objectId),
        ).toEqual([stuck.objectId]);
    });

    test('one object that always fails to copy does not stop the others from being backed up, and is counted', async () => {
        const first = await storedFile();
        const broken = await storedFile();
        const last = await storedFile();
        // Its bytes are not at the store its row names: the copy throws every time.
        s3.remove(PRIMARY, broken.key);
        const result = await jobs.replicateObjects(stores);
        expect(result).toMatchObject({ copied: 2, failed: 1, skipped: 0 });
        expect(JSON.stringify(result)).not.toContain(s3.url);
        expect(s3.keys(REPLICA).sort()).toEqual([first.key, last.key].sort());
        const failures = async () =>
            (await run('select copy_failures from drive_objects where id = $1', [broken.objectId]))
                .rows[0].copy_failures;
        expect(await failures()).toBe(1);
        // Tried again each run, behind whatever has not failed; after ten in a row, left alone.
        for (let runs = 1; runs < driveRepository.COPY_FAILURE_LIMIT; runs++)
            await jobs.replicateObjects(stores);
        expect(await failures()).toBe(driveRepository.COPY_FAILURE_LIMIT);
        const gets = () =>
            s3.requests.filter(
                (request) => request.key === broken.key && request.bucket === PRIMARY,
            ).length;
        const asked = gets();
        expect(await jobs.replicateObjects(stores)).toMatchObject({
            copied: 0,
            failed: 0,
            skipped: 1,
        });
        expect(gets()).toBe(asked);
        // Never marked as backed up while it was not.
        expect(
            (await run('select replicated_at from drive_objects where id = $1', [broken.objectId]))
                .rows[0].replicated_at,
        ).toBeNull();
    });

    test('an audit does not call an object missing because its store did not answer, and confirms the rest', async () => {
        const here = await storedFile();
        const there = await storedFile(secondId);
        s3.hooks.refuse = (request) => (request.bucket === SECOND ? 500 : undefined);
        expect(await jobs.auditObjects(stores, 'primary')).toMatchObject({
            examined: 2,
            present: 1,
            missing: 0,
            failed: 1,
        });
        const status = async (objectId: string) =>
            (await run('select status, audited_at from drive_objects where id = $1', [objectId]))
                .rows[0];
        expect(await status(there.objectId)).toEqual({ status: 'ready', audited_at: null });
        expect((await status(here.objectId)).audited_at).not.toBeNull();
        // The replica audit, likewise: a backup that does not answer clears no mark.
        await run(
            `update drive_objects set replicated_at = now(), backup_store_id = $1 where id = $2`,
            [REPLICA_ID, here.objectId],
        );
        s3.hooks.refuse = (request) => (request.bucket === REPLICA ? 500 : undefined);
        expect(await jobs.auditObjects(stores, 'replica')).toMatchObject({
            replicaMissing: 0,
            failed: 1,
        });
        s3.hooks.refuse = undefined;
        // It answers, and really has no copy: now the mark is cleared, store and all.
        expect(await jobs.auditObjects(stores, 'replica')).toMatchObject({ replicaMissing: 1 });
        expect(
            (
                await run(
                    'select replicated_at, backup_store_id from drive_objects where id = $1',
                    [here.objectId],
                )
            ).rows[0],
        ).toEqual({ replicated_at: null, backup_store_id: null });
    });
});

describe('the backup mark is a compare-and-set', () => {
    test('a backup run racing a flip does not mark the object as backed up in the old region’s backup', async () => {
        const file = await storedFile();
        const moveId = randomUUID();
        // The copy to the replica is under way when the object flips to the second store.
        const replica = await storeFor(REPLICA_ID);
        const racing = {
            ...replica,
            copyFrom: async (...args: Parameters<Store['copyFrom']>) => {
                await replica.copyFrom(...args);
                await move(file, PRIMARY_ID, secondId, moveId);
            },
        } as Store;
        const result = await jobs.replicateObjects({
            open: async (storeId) => (storeId === REPLICA_ID ? racing : open(storeId)),
            backups: [BACKUPS[0]!],
        });
        expect(result).toMatchObject({ copied: 1, unmarked: 0 });
        const mark = (
            await run(
                'select store_id, replicated_at, backup_store_id from drive_objects where id = $1',
                [file.objectId],
            )
        ).rows[0];
        // Not backed up where it now lives, so the new region's backup will copy it.
        expect(mark).toEqual({ store_id: secondId, replicated_at: null, backup_store_id: null });
        expect(await jobs.replicateObjects(stores)).toMatchObject({ copied: 1 });
        expect(s3.keys(SECOND_BACKUP)).toEqual([file.key]);
        // The copy the race left in the old backup is the old copy's row's to remove.
        expect(s3.keys(REPLICA)).toEqual([file.key]);
        await outbox.releaseMoveHolds(moveId, new Date(Date.now() - 1000));
        await drain();
        expect([s3.keys(PRIMARY), s3.keys(REPLICA)]).toEqual([[], []]);
        expect(s3.get(SECOND, file.key)).toEqual(file.bytes);
        expect(s3.get(SECOND_BACKUP, file.key)).toEqual(file.bytes);
    });

    test('a copy nothing accounts for is removed from the backup again', async () => {
        const file = await storedFile();
        const replica = await storeFor(REPLICA_ID);
        const racing = {
            ...replica,
            copyFrom: async (...args: Parameters<Store['copyFrom']>) => {
                await replica.copyFrom(...args);
                // The row names another store by the time the copy is made, and nothing queued the old one.
                await run('update drive_objects set store_id = $1 where id = $2', [
                    secondId,
                    file.objectId,
                ]);
            },
        } as Store;
        expect(
            await jobs.replicateObjects({
                open: async (storeId) => (storeId === REPLICA_ID ? racing : open(storeId)),
                backups: [BACKUPS[0]!],
            }),
        ).toMatchObject({ copied: 0, unmarked: 1, failed: 0 });
        expect(s3.keys(REPLICA)).toEqual([]);
    });
});

describe('deleting an account', () => {
    test('removes its files from every store and every backup, keeps what a report holds, and touches nobody else’s', async () => {
        const { user, workspaceId } = await registered();
        const token = await signedIn(user.id);
        const object = async (storeId: string, replicated: boolean) => {
            const id = randomUUID();
            const key = keyOf(id, workspaceId);
            const bytes = randomBytes(256);
            await db.insert(driveObjects).values({
                id,
                workspaceId,
                objectKey: key,
                storeId,
                contentSuite: 3,
                chunkSize: 8 * 1024 * 1024,
                chunkCount: 1,
                contentNonce: randomBytes(16),
                ciphertextSize: 256n,
                status: 'ready',
            });
            s3.put(bucketOf(storeId), key, bytes, OLD);
            if (replicated) {
                const backup = BACKUPS.find((pair) => pair.storeId === storeId)!.backupStoreId;
                s3.put(bucketOf(backup), key, bytes, OLD);
                await run(
                    `update drive_objects set replicated_at = now(), backup_store_id = $1 where id = $2`,
                    [backup, id],
                );
            }
            return { id, key, bytes };
        };
        const here = await object(PRIMARY_ID, true);
        const there = await object(secondId, true);
        const held = await object(PRIMARY_ID, true);
        const reportId = randomUUID();
        const nodeId = randomUUID();
        await run(
            `insert into drive_reports (id, workspace_id, node_id, node_kind, key_epoch, category, reason) values ($1, $2, $3, 'file', 1, 'other', 'Looks wrong.')`,
            [reportId, workspaceId, nodeId],
        );
        await run(
            `insert into drive_report_items (report_id, node_id, depth, kind, key_epoch, parent_key_epoch, key_envelope, metadata_version, metadata_envelope, version_id, object_id, object_key, content_key_envelope, content_nonce, content_suite, chunk_size, chunk_count, ciphertext_size) values ($1, $2, 0, 'file', 1, 1, $3, 1, $4, $5, $6, $7, $8, $9, 3, 8388608, 1, 256)`,
            [
                reportId,
                nodeId,
                randomBytes(72),
                randomBytes(100),
                randomUUID(),
                held.id,
                held.key,
                randomBytes(84),
                randomBytes(16),
            ],
        );
        const bystander = await storedFile();
        await jobs.replicateObjects(stores);

        expect(
            await authRepository.deleteAccount({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash: token,
            }),
        ).toBe(true);
        expect(
            (await run('select 1 from drive_objects where workspace_id = $1', [workspaceId])).rows,
        ).toEqual([]);

        expect(await drain()).toMatchObject({ failed: 0 });
        await jobs.sweepOrphans(stores);
        // The deleted account's files are gone from both stores and both backups...
        for (const gone of [here, there])
            for (const bucket of [PRIMARY, REPLICA, SECOND, SECOND_BACKUP])
                expect(s3.get(bucket, gone.key), `${bucket} ${gone.key}`).toBeNull();
        // ...the file under report is exactly where it was, in the store and in its backup...
        expect(s3.get(PRIMARY, held.key)).toEqual(held.bytes);
        expect(s3.get(REPLICA, held.key)).toEqual(held.bytes);
        // ...and another person's file was not touched.
        expect(s3.get(PRIMARY, bystander.key)).toEqual(bystander.bytes);
        expect(s3.get(REPLICA, bystander.key)).toEqual(bystander.bytes);
        expect(await storeOf(bystander.objectId)).toBe(PRIMARY_ID);

        // The report lets go: the last of the account's bytes follow.
        await run(`update drive_reports set status = 'dismissed' where id = $1`, [reportId]);
        await drain();
        expect(s3.keys(PRIMARY)).toEqual([bystander.key]);
        expect(s3.keys(REPLICA)).toEqual([bystander.key]);
        expect([s3.keys(SECOND), s3.keys(SECOND_BACKUP)]).toEqual([[], []]);
    });
});
