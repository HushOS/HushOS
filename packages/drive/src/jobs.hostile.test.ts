import { randomBytes, randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { type S3Request, startS3 } from '../test/s3-server';

/*
 * The worker's jobs with one store that misbehaves beside one that does not
 * (docs/company-storage-design.md 2.4 and "a hostile store" in section 15): a
 * real database, the real S3 client, and an S3 server in this process whose
 * `hostile` bucket answers late, never, or falsely.
 *
 * The healthy store is the environment's primary, with the replica as its
 * backup. The hostile one is a second region's store, a `database` row the
 * jobs are handed an opener for, with the production bounds scaled down: a
 * 300 ms deadline stands for 60 s, and a share of a run is set per test.
 */

const s3 = await startS3();
const PRIMARY = s3.bucket('primary');
const REPLICA = s3.bucket('replica');
const HOSTILE = s3.bucket('hostile');
const HOSTILE_BACKUP = s3.bucket('hostile-backup');
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

const {
    driveRepository,
    ENVIRONMENT_PRIMARY_STORE_ID: PRIMARY_ID,
    ENVIRONMENT_REPLICA_STORE_ID: REPLICA_ID,
} = await import('@hushos/db');
const { db } = await import('../../db/src/client');
const { closeDatabase, createTestStore, resetDatabase } = await import('../../db/test/helpers');
const fixtures = await import('../test/fixtures');
const jobs = await import('./jobs');
const { createObjectStore, storeFor } = await import('./storage');

type Account = Awaited<ReturnType<typeof fixtures.member>>;
type Store = ReturnType<typeof createObjectStore>;

const CALL = 300;
const BOUNDS = {
    connectMs: 200,
    idleMs: 5_000,
    callMs: CALL,
    bytesPerSecond: 1024 * 1024 * 1024,
    breakerOpenMs: 60_000,
    slowMs: 60_000,
};
const DAY = 24 * 3600 * 1000;
const OLD = new Date(Date.now() - 30 * DAY);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (text: string, params: unknown[] = []) => db.$client.query(text, params);
const bucketStore = (bucket: string, bounds: Partial<typeof BOUNDS> = {}): Store =>
    createObjectStore({
        endpoint: s3.url,
        region: 'auto',
        bucket,
        forcePathStyle: true,
        bounds: { ...BOUNDS, ...bounds },
        ...credentials,
    });

let owner: Account;
let root: Awaited<ReturnType<typeof fixtures.root>>;
let hostileId: string;
let hostileBackupId: string;
let hostileStore: Store;
let open: (storeId: string) => Promise<Store>;

/* The hostile bucket's store, opened again with other bounds, in place of the default. */
function hostileWith(bounds: Partial<typeof BOUNDS>) {
    hostileStore = bucketStore(HOSTILE, bounds);
    return hostileStore;
}

beforeEach(async () => {
    s3.reset();
    await resetDatabase();
    owner = await fixtures.member();
    root = await fixtures.root(owner);
    hostileId = await createTestStore({ bucket: HOSTILE });
    const backup = await run(
        `insert into object_stores (source, kind, endpoint, signing_region, bucket, path_style, seal, secret_key_id, secret_sealed, status)
         values ('database', 'backup', 'https://s3.store.test', 'auto', $1, false, 'worker', $2, $3, 'ready') returning id`,
        [HOSTILE_BACKUP, randomBytes(8), randomBytes(64)],
    );
    hostileBackupId = backup.rows[0].id;
    hostileStore = bucketStore(HOSTILE);
    const hostileBackup = bucketStore(HOSTILE_BACKUP);
    open = async (storeId) =>
        storeId === hostileId
            ? hostileStore
            : storeId === hostileBackupId
              ? hostileBackup
              : storeFor(storeId);
    // The one line a marked row logs; not what these tests are about.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(async () => {
    await closeDatabase();
    await s3.stop();
});

/* Only the hostile bucket is tampered with. Return false and the request is served honestly, after whatever wait. */
function hostile(answer: (request: S3Request, res: ServerResponse) => boolean | Promise<boolean>) {
    s3.hooks.hostile = (request, res) =>
        request.bucket === HOSTILE ? answer(request, res) : false;
}
const requestsTo = (bucket: string, method?: string) =>
    s3.requests.filter(
        (request) => request.bucket === bucket && (!method || request.method === method),
    );

const keyOf = (objectId: string) => `ws/${owner.workspaceId}/${objectId}`;
const bucketOf = (storeId: string) =>
    ({
        [PRIMARY_ID]: PRIMARY,
        [REPLICA_ID]: REPLICA,
        [hostileId]: HOSTILE,
        [hostileBackupId]: HOSTILE_BACKUP,
    })[storeId]!;

/*
 * `count` purged copies queued for removal at `storeId`, their bytes in its
 * bucket, queued `agoSeconds` back and one second apart. Not published, so none
 * waits for a backup: each costs its store one DELETE.
 */
async function queued(storeId: string, count: number, agoSeconds: number) {
    const keys: string[] = [];
    for (let index = 0; index < count; index++) {
        const objectId = randomUUID();
        keys.push(keyOf(objectId));
        s3.put(bucketOf(storeId), keyOf(objectId), randomBytes(8), OLD);
        await run(
            `insert into drive_object_deletions (object_id, store_id, workspace_id, object_key, reason, published, created_at)
             values ($1, $2, $3, $4, 'purged', false, now() - make_interval(secs => $5))`,
            [objectId, storeId, owner.workspaceId, keyOf(objectId), agoSeconds - index],
        );
    }
    return keys;
}
const outboxOf = async (storeId: string) =>
    (
        await run(
            `select count(*) filter (where done_at is not null)::int as done,
                    count(*) filter (where done_at is null)::int as pending,
                    count(*) filter (where failures > 0)::int as failed
             from drive_object_deletions where store_id = $1`,
            [storeId],
        )
    ).rows[0] as { done: number; pending: number; failed: number };

/* A published file whose object row names `storeId`, its bytes in that store's bucket. */
async function storedFile(storeId: string, bytes = randomBytes(512)) {
    const node = await fixtures.file(owner, root, BigInt(bytes.length));
    const objectId = node.currentVersion!.objectId;
    await run('update drive_objects set store_id = $1 where id = $2', [storeId, objectId]);
    s3.put(bucketOf(storeId), keyOf(objectId), bytes, OLD);
    return { objectId, key: keyOf(objectId), bytes };
}
const objectRow = async (objectId: string) =>
    (
        await run(
            'select status, replicated_at, copy_failures, audited_at from drive_objects where id = $1',
            [objectId],
        )
    ).rows[0] as {
        status: string;
        replicated_at: Date | null;
        copy_failures: number;
        audited_at: Date | null;
    };

describe('the deletion outbox, with a store that answers every call late, and rightly', () => {
    test('200 rows of its own delay another store’s deletions by no more than its share of the run and one request’s deadline', async () => {
        // Queued first, so that before stores were taken in turn they filled the page by themselves.
        await queued(hostileId, 200, 10_000);
        const ours = await queued(PRIMARY_ID, 10, 100);
        // Two thirds of its deadline, every time, and the answer is right every time: it trips
        // no breaker, and two such calls are not yet "slow".
        const DEADLINE = 600;
        hostileWith({ callMs: DEADLINE });
        hostile(async () => {
            await wait(DEADLINE * (2 / 3));
            return false;
        });

        const started = performance.now();
        const result = await jobs.deleteObjects({
            open,
            backups: [],
            budgetMs: DEADLINE,
            itemMs: DEADLINE,
        });
        const took = performance.now() - started;

        // Every one of the other store's deletions was done in this run.
        expect(s3.keys(PRIMARY)).toEqual([]);
        expect(ours).toHaveLength(10);
        expect(await outboxOf(PRIMARY_ID)).toEqual({ done: 10, pending: 0, failed: 0 });
        // The slow store got two calls: the second began inside its share and was let finish.
        expect(requestsTo(HOSTILE, 'DELETE')).toHaveLength(2);
        expect(result).toMatchObject({ primaries: 12, failed: 0, avoided: 0 });
        // What it left is deferred, not failed: nothing is recorded against those rows.
        expect(result.deferred).toBe(188);
        expect(await outboxOf(hostileId)).toEqual({ done: 2, pending: 198, failed: 0 });
        // The share and one request's deadline, and the well store's own ten deletions.
        expect(took).toBeLessThan(DEADLINE + DEADLINE + 700);
    });

    test('a page is not filled by the store with the most waiting: the rows are listed store by store in turn', async () => {
        await queued(hostileId, 30, 10_000);
        await queued(PRIMARY_ID, 4, 100);
        // No store is slow here: a page of eight is simply too small for 34 rows.
        const result = await jobs.deleteObjects({ open, backups: [] }, 8);
        expect(await outboxOf(PRIMARY_ID)).toEqual({ done: 4, pending: 0, failed: 0 });
        expect(await outboxOf(hostileId)).toEqual({ done: 4, pending: 26, failed: 0 });
        expect(result).toMatchObject({ primaries: 8, deferred: 0 });
    });
});

describe('the deletion outbox, with a store that accepts the request and never answers', () => {
    test('each row costs one deadline, five open the breaker, the rest are left alone, and the other store’s work is done', async () => {
        await queued(hostileId, 12, 10_000);
        await queued(PRIMARY_ID, 6, 100);
        hostileWith({ callMs: 100 });
        hostile(() => true);

        const started = performance.now();
        const result = await jobs.deleteObjects({
            open,
            backups: [],
            budgetMs: 60_000,
            itemMs: 100,
        });
        const took = performance.now() - started;

        expect(s3.keys(PRIMARY)).toEqual([]);
        expect(await outboxOf(PRIMARY_ID)).toEqual({ done: 6, pending: 0, failed: 0 });
        // Five rows waited out their deadline and are recorded as failed tries, by class.
        expect(result).toMatchObject({
            primaries: 6,
            failed: 5,
            failures: { StoreDeadlineError: 5 },
            avoided: 7,
            deferred: 0,
        });
        expect(await outboxOf(hostileId)).toEqual({ done: 0, pending: 12, failed: 5 });
        // The other seven were never sent: the store is not hammered while it is failing.
        expect(requestsTo(HOSTILE)).toHaveLength(5);
        expect(hostileStore.health()).toBe('open');
        // Five deadlines of 100 ms, not twelve, and not for ever.
        expect(took).toBeGreaterThanOrEqual(5 * 100 - 25);
        expect(took).toBeLessThan(5 * 100 + 1_000);
        // No row's lock or transaction outlived its call.
        const idle = await run(
            `select count(*)::int as n from pg_stat_activity
             where datname = current_database() and state like 'idle in transaction%'`,
        );
        expect(idle.rows[0].n).toBe(0);

        // The next run, a moment later, sends it nothing at all.
        const again = await jobs.deleteObjects({ open, backups: [], itemMs: 100 });
        expect(again).toMatchObject({ primaries: 0, failed: 0, avoided: 12 });
        expect(requestsTo(HOSTILE)).toHaveLength(5);
    });

    test('the calls of one row share one deadline: a look and a delete that each fit do not get two', async () => {
        // A published copy with no backup yet, at a store this worker backs up: the outbox
        // first asks whether the copy is there at all (it is not), then deletes.
        const objectId = randomUUID();
        await run(
            `insert into drive_object_deletions (object_id, store_id, workspace_id, object_key, reason, published)
             values ($1, $2, $3, $4, 'purged', true)`,
            [objectId, hostileId, owner.workspaceId, keyOf(objectId)],
        );
        // Each call answers at two thirds of the deadline: alone each is in time, together they are not.
        const DEADLINE = 600;
        hostileWith({ callMs: DEADLINE });
        hostile(async () => {
            await wait(DEADLINE * (2 / 3));
            return false;
        });
        const started = performance.now();
        const result = await jobs.deleteObjects({
            open,
            backups: [{ storeId: hostileId, backupStoreId: hostileBackupId }],
            itemMs: DEADLINE,
        });
        const took = performance.now() - started;
        expect(requestsTo(HOSTILE).map((request) => request.method)).toEqual(['HEAD', 'DELETE']);
        expect(result).toMatchObject({
            primaries: 0,
            failed: 1,
            failures: { StoreDeadlineError: 1 },
        });
        expect(took).toBeLessThan(DEADLINE + 300);
        // Not marked as deleted: the row is tried again.
        expect(await outboxOf(hostileId)).toEqual({ done: 0, pending: 1, failed: 1 });
    });
});

describe('the deletion outbox, with a store whose successes are slow', () => {
    test('after five in a row the run leaves the store alone, and so does the next', async () => {
        await queued(hostileId, 9, 10_000);
        await queued(PRIMARY_ID, 3, 100);
        hostileWith({ callMs: 400 });
        // 260 ms of a 400 ms deadline: more than half, every time, and always right.
        hostile(async () => {
            await wait(260);
            return false;
        });
        const result = await jobs.deleteObjects({ open, backups: [], budgetMs: 60_000 });
        expect(result).toMatchObject({ primaries: 3 + 5, failed: 0, avoided: 4, deferred: 0 });
        expect(hostileStore.health()).toBe('slow');
        expect(await outboxOf(hostileId)).toEqual({ done: 5, pending: 4, failed: 0 });
        expect(await outboxOf(PRIMARY_ID)).toEqual({ done: 3, pending: 0, failed: 0 });

        const sent = requestsTo(HOSTILE).length;
        expect(await jobs.deleteObjects({ open, backups: [] })).toMatchObject({
            primaries: 0,
            avoided: 4,
        });
        expect(requestsTo(HOSTILE)).toHaveLength(sent);
        // A person's request is another matter: an upload beginning there is still sent.
        expect(await hostileStore.createMultipart(keyOf(randomUUID()))).toEqual(expect.any(String));
    });
});

describe('the backup copy, with a source that lies', () => {
    const PAIRS = () => [
        { storeId: PRIMARY_ID, backupStoreId: REPLICA_ID },
        { storeId: hostileId, backupStoreId: hostileBackupId },
    ];

    test('an object whose store reports a larger size than its row is not copied, nothing reaches the backup, and the others are', async () => {
        const honest = await storedFile(hostileId);
        const inflated = await storedFile(hostileId);
        const mine = await storedFile(PRIMARY_ID);
        hostile((request, res) => {
            if (request.method !== 'HEAD' || request.key !== inflated.key) return false;
            res.writeHead(200, { 'content-length': 512 * 1024 * 1024 });
            res.end();
            return true;
        });
        const result = await jobs.replicateObjects({ open, backups: PAIRS() });
        expect(result).toMatchObject({
            copied: 2,
            failed: 1,
            failures: { 'size-mismatch': 1 },
        });
        // Refused before a byte was read, and nothing was written for it.
        expect(requestsTo(HOSTILE, 'GET').map((request) => request.key)).toEqual([honest.key]);
        expect(s3.keys(HOSTILE_BACKUP)).toEqual([honest.key]);
        expect(s3.openUploads(HOSTILE_BACKUP)).toEqual([]);
        expect(await objectRow(inflated.objectId)).toMatchObject({
            replicated_at: null,
            copy_failures: 1,
        });
        expect(s3.get(REPLICA, mine.key)!.equals(mine.bytes)).toBe(true);
    });

    test('a source that sends more than the range it was asked for is cut off at the row’s size', async () => {
        const endless = await storedFile(hostileId);
        let written = 0;
        hostile((request, res) => {
            if (request.method !== 'GET') return false;
            res.writeHead(206, {});
            const piece = Buffer.alloc(64 * 1024, 1);
            const timer = setInterval(() => {
                written += piece.length;
                res.write(piece);
            }, 1);
            res.on('close', () => clearInterval(timer));
            return true;
        });
        const result = await jobs.replicateObjects({ open, backups: PAIRS() });
        expect(result).toMatchObject({ copied: 0, failed: 1, failures: { 'too-long': 1 } });
        expect(requestsTo(HOSTILE, 'GET')[0]!.range).toBe('bytes=0-511');
        expect(s3.keys(HOSTILE_BACKUP)).toEqual([]);
        expect(await objectRow(endless.objectId)).toMatchObject({ copy_failures: 1 });
        // The row said 512 bytes; the store was stopped long before it could send what it liked.
        await wait(50);
        expect(written).toBeLessThan(16 * 1024 * 1024);
    });

    test('a slow pair keeps to its share of the run, and the other pair’s copies are all made', async () => {
        const theirs: Awaited<ReturnType<typeof storedFile>>[] = [];
        for (let i = 0; i < 6; i++) theirs.push(await storedFile(hostileId));
        const mine: Awaited<ReturnType<typeof storedFile>>[] = [];
        for (let i = 0; i < 4; i++) mine.push(await storedFile(PRIMARY_ID));
        // A HEAD and a GET per copy, each at a third of the deadline: never slow, never failing.
        hostile(async () => {
            await wait(CALL / 3);
            return false;
        });
        const started = performance.now();
        const result = await jobs.replicateObjects({
            open,
            backups: PAIRS(),
            budgetMs: CALL + 50,
        });
        const took = performance.now() - started;
        for (const file of mine) expect(s3.get(REPLICA, file.key)!.equals(file.bytes)).toBe(true);
        // Two copies of 200 ms each use the 350 ms share; four wait for the next run.
        expect(result).toMatchObject({ copied: 4 + 2, failed: 0, avoided: 0, deferred: 4 });
        expect(s3.keys(HOSTILE_BACKUP)).toHaveLength(2);
        expect(took).toBeLessThan(CALL + 2 * CALL + 700);
        // Nothing is held against the objects that waited.
        for (const file of theirs) expect((await objectRow(file.objectId)).copy_failures).toBe(0);
    });
});

describe('the audit', () => {
    test('a store that does not answer does not keep another store’s objects from being confirmed', async () => {
        // Never audited, and older than ours: one page for every store would hold only these.
        const theirs: Awaited<ReturnType<typeof storedFile>>[] = [];
        for (let i = 0; i < 4; i++) theirs.push(await storedFile(hostileId));
        await run(`update drive_objects set created_at = now() - interval '1 day'`);
        const mine: Awaited<ReturnType<typeof storedFile>>[] = [];
        for (let i = 0; i < 3; i++) mine.push(await storedFile(PRIMARY_ID));
        hostileWith({ callMs: 80 });
        hostile(() => true);

        const result = await jobs.auditObjects({ open, backups: [] }, 'primary', 3);
        expect(result).toMatchObject({
            present: 3,
            missing: 0,
            failed: 3,
            failures: { StoreDeadlineError: 3 },
        });
        for (const file of mine) expect((await objectRow(file.objectId)).audited_at).not.toBeNull();
        // Silence says nothing about an object: none of theirs is called missing.
        for (const file of theirs)
            expect(await objectRow(file.objectId)).toMatchObject({
                status: 'ready',
                audited_at: null,
            });
    });

    test('a lost object is healed from its backup by the size on its row, and not from a backup that reports another', async () => {
        const lost = await storedFile(PRIMARY_ID);
        const swollen = await storedFile(PRIMARY_ID);
        for (const file of [lost, swollen]) {
            s3.put(REPLICA, file.key, file.bytes);
            s3.remove(PRIMARY, file.key);
        }
        await run(`update drive_objects set replicated_at = now(), backup_store_id = $1`, [
            REPLICA_ID,
        ]);
        // The backup holds something longer under the second key.
        s3.put(REPLICA, swollen.key, randomBytes(4096));
        const result = await jobs.auditObjects(
            { open, backups: [{ storeId: PRIMARY_ID, backupStoreId: REPLICA_ID }] },
            'primary',
        );
        expect(result).toMatchObject({ recovered: 1, missing: 1 });
        expect(s3.get(PRIMARY, lost.key)!.equals(lost.bytes)).toBe(true);
        expect(s3.get(PRIMARY, swollen.key)).toBeNull();
    });
});

describe('the orphan sweep', () => {
    test('takes a page of each store in turn, and a slow store that has used its share keeps its cursor for the next run', async () => {
        // Three pages at the hostile store, one at ours; all too young to be deleted.
        for (let i = 0; i < 2500; i++)
            s3.put(HOSTILE, `ws/${String(i).padStart(8, '0')}`, Buffer.alloc(1));
        for (let i = 0; i < 20; i++)
            s3.put(PRIMARY, `ws/${String(i).padStart(8, '0')}`, Buffer.alloc(1));
        hostile(async () => {
            await wait(CALL / 3);
            return false;
        });
        const result = await jobs.sweepOrphans(
            { open, backups: [], budgetMs: CALL / 6 },
            { pages: 5 },
        );
        // One page of the slow store, which used its share; ours was listed to the end.
        expect(result).toMatchObject({
            stores: 2,
            listed: 1000 + 20,
            deleted: 0,
            failed: 0,
            deferred: 1,
            completed: false,
        });
        expect(requestsTo(HOSTILE, 'GET')).toHaveLength(1);
        expect(await driveRepository.getSweepCursor(jobs.orphanSweepName(hostileId))).toBe(
            'ws/00000999',
        );
        // The next run goes on from there.
        s3.hooks.hostile = undefined;
        const next = await jobs.sweepOrphans({ open, backups: [] }, { pages: 5 });
        expect(next).toMatchObject({ listed: 1500 + 20, completed: true, deferred: 0 });
        expect(requestsTo(HOSTILE, 'GET')[1]!.query).toContain('start-after=ws%2F00000999');
    });

    test('a store whose breaker is open is not listed, and the others are swept', async () => {
        s3.put(PRIMARY, 'ws/orphan', Buffer.alloc(1), OLD);
        hostileWith({ callMs: 60 });
        hostile(() => true);
        for (let i = 0; i < 5; i++) await hostileStore.head('ws/probe').catch(() => undefined);
        const sent = requestsTo(HOSTILE).length;
        const result = await jobs.sweepOrphans({ open, backups: [] });
        expect(result).toMatchObject({ stores: 2, deleted: 1, avoided: 1, completed: false });
        expect(requestsTo(HOSTILE)).toHaveLength(sent);
        expect(s3.keys(PRIMARY)).toEqual([]);
    });
});
