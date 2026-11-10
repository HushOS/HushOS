import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Storage from './storage';
import { startS3 } from '../test/s3-server';

/*
 * What a store may do to a person's request (docs/company-storage-design.md
 * 2.4): the web process calls a store when an upload begins, lists its parts
 * and completes, and those calls carry the deadline and the breaker, so a dead
 * bucket fails its own uploads quickly and nobody else's.
 *
 * The real upload routes' domain functions, a real database, and the real S3
 * client against an S3 server in this process. `storeFor` is the real one for
 * everything but the bounds: the two stores a process can open today (the
 * environment's primary and its replica) are opened here with a 300 ms
 * deadline in place of 60 s, and afresh for every test, since a breaker is
 * kept for the life of the process.
 */

const opened = vi.hoisted(() => ({ stores: {} as Record<string, unknown> }));
vi.mock('./storage', async (importOriginal) => {
    const real = await importOriginal<typeof Storage>();
    const storeFor: typeof real.storeFor = async (storeId) =>
        (opened.stores[storeId] as Storage.ObjectStore | undefined) ?? real.storeFor(storeId);
    return { ...real, storeFor };
});

const s3 = await startS3();
const DEAD = s3.bucket('dead');
const WELL = s3.bucket('well');
const credentials = { accessKeyId: 'test-key-id', secretAccessKey: 'test-secret-value' };
Object.assign(process.env, {
    STORAGE_ENDPOINT: s3.url,
    STORAGE_BUCKET: DEAD,
    STORAGE_ACCESS_KEY_ID: credentials.accessKeyId,
    STORAGE_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    STORAGE_FORCE_PATH_STYLE: 'true',
});
delete process.env.STORAGE_INTERNAL_ENDPOINT;

const { ENVIRONMENT_PRIMARY_STORE_ID: DEAD_ID, ENVIRONMENT_REPLICA_STORE_ID: WELL_ID } =
    await import('@hushos/db');
const { db } = await import('../../db/src/client');
const { driveObjects, driveUploads } = await import('../../db/src/schema');
const { closeDatabase, resetDatabase } = await import('../../db/test/helpers');
const fixtures = await import('../test/fixtures');
const server = await import('./server');
const { createObjectStore, StoreDeadlineError, StoreUnavailableError } =
    await vi.importActual<typeof Storage>('./storage');

const CALL = 300;
const storeAt = (bucket: string) =>
    createObjectStore({
        endpoint: s3.url,
        region: 'auto',
        bucket,
        forcePathStyle: true,
        bounds: { callMs: CALL, connectMs: 100, bytesPerSecond: 1024 * 1024 * 1024 },
        ...credentials,
    });

type Account = Awaited<ReturnType<typeof fixtures.member>>;
let owner: Account;
let root: Awaited<ReturnType<typeof fixtures.root>>;

beforeEach(async () => {
    s3.reset();
    await resetDatabase();
    owner = await fixtures.member();
    root = await fixtures.root(owner);
    opened.stores = { [DEAD_ID]: storeAt(DEAD), [WELL_ID]: storeAt(WELL) };
});
afterAll(async () => {
    await closeDatabase();
    await s3.stop();
});

const run = (text: string, params: unknown[] = []) => db.$client.query(text, params);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/* The default region re-pointed, so the next upload begins at that store. */
const regionAt = (storeId: string) =>
    run('update storage_regions set store_id = $1, backup_store_id = null where is_default', [
        storeId,
    ]);
const sentTo = (bucket: string) => s3.requests.filter((request) => request.bucket === bucket);
const reserved = async () =>
    BigInt(
        (
            await run(
                'select reserved_bytes::text as reserved from workspace_storage where workspace_id = $1',
                [owner.workspaceId],
            )
        ).rows[0].reserved,
    );

async function begin() {
    const input = await fixtures.beginInput(owner, root, { chunkCount: 1, ciphertextSize: 4096 });
    const started = performance.now();
    const outcome = await server.beginUpload(owner.userId, owner.workspaceId, input).then(
        (begun) => ({ begun, error: undefined }),
        (error: unknown) => ({ begun: undefined, error }),
    );
    return { input, ...outcome, took: performance.now() - started };
}
/* The store holding the `dead` bucket stops answering: it accepts each request and says nothing. */
const goSilent = () => {
    s3.hooks.hostile = (request) => request.bucket === DEAD;
};

describe('an upload beginning at a store that does not answer', () => {
    test('fails at the deadline, leaves nothing behind, and the same begin goes through once the store is back', async () => {
        goSilent();
        const first = await begin();
        expect(first.error).toBeInstanceOf(StoreDeadlineError);
        expect(first.took).toBeGreaterThanOrEqual(CALL - 5);
        expect(first.took).toBeLessThan(CALL + 600);
        // As a begin the store refused: no upload, no object, no reserved bytes.
        expect(await db.select().from(driveUploads)).toEqual([]);
        expect(await db.select().from(driveObjects)).toEqual([]);
        expect(await reserved()).toBe(0n);

        s3.hooks.hostile = undefined;
        const again = await server.beginUpload(owner.userId, owner.workspaceId, first.input);
        expect(again.upload.status).toBe('open');
        expect(s3.openUploads(DEAD)).toHaveLength(1);
    });

    test('after five such begins the sixth is refused at once, without a request, and an upload at another store begins as ever', async () => {
        goSilent();
        for (let i = 0; i < 5; i++)
            expect((await begin()).error).toBeInstanceOf(StoreDeadlineError);
        const sent = sentTo(DEAD).length;

        const refused = await begin();
        expect(refused.error).toBeInstanceOf(StoreUnavailableError);
        expect(refused.error).toMatchObject({ code: 'breaker-open' });
        // Quickly: no deadline was waited out, and the dead store was sent nothing more.
        expect(refused.took).toBeLessThan(CALL);
        expect(sentTo(DEAD)).toHaveLength(sent);
        // Refused begins leave nothing behind either.
        expect(await db.select().from(driveUploads)).toEqual([]);
        expect(await reserved()).toBe(0n);

        // Somebody whose files live at the other store is not held up by any of it.
        await regionAt(WELL_ID);
        const elsewhere = await begin();
        expect(elsewhere.error).toBeUndefined();
        expect(elsewhere.took).toBeLessThan(CALL);
        expect(s3.openUploads(WELL)).toHaveLength(1);
    });
});

describe('an upload in flight at a store that stops answering', () => {
    test('listing its parts and completing it each end at the deadline, and completing it again finishes it when the store is back', async () => {
        const { begun } = await begin();
        const upload = begun!.upload;
        const bytes = randomBytes(4096);
        const put = await fetch(begun!.parts[0]!.url, {
            method: 'PUT',
            body: new Uint8Array(bytes),
            headers: { 'content-type': 'application/octet-stream' },
        });
        const etag = put.headers.get('etag')!;

        goSilent();
        const timed = async (call: Promise<unknown>) => {
            const started = performance.now();
            const error = await call.then(
                () => undefined,
                (thrown: unknown) => thrown,
            );
            return { error, took: performance.now() - started };
        };
        const listed = await timed(
            server.getUploadState(owner.userId, owner.workspaceId, upload.id),
        );
        expect(listed.error).toBeInstanceOf(StoreDeadlineError);
        expect(listed.took).toBeLessThan(CALL + 600);
        const completed = await timed(
            server.completeUpload(owner.userId, owner.workspaceId, upload.id, [
                { partNumber: 1, etag },
            ]),
        );
        expect(completed.error).toBeInstanceOf(StoreDeadlineError);
        expect(completed.took).toBeLessThan(CALL + 600);
        // Nothing was decided about the bytes: the upload waits, completing, for an answer.
        const [row] = await db.select().from(driveUploads);
        expect(row?.status).toBe('completing');

        s3.hooks.hostile = undefined;
        const done = await server.completeUpload(owner.userId, owner.workspaceId, upload.id, [
            { partNumber: 1, etag },
        ]);
        expect(done.status).toBe('completed');
        expect(s3.get(DEAD, `ws/${owner.workspaceId}/${upload.objectId}`)).toEqual(bytes);
    });
});

describe('an upload beginning at a store marked slow', () => {
    test('still begins: slow keeps background work away, not a person', async () => {
        // Five answers in a row, each right and each past half the deadline.
        s3.hooks.hostile = async (request) => {
            if (request.bucket === DEAD) await wait(CALL * 0.6);
            return false;
        };
        const store = opened.stores[DEAD_ID] as Storage.ObjectStore;
        for (let i = 0; i < 5; i++) await store.head('ws/probe');
        expect(store.health()).toBe('slow');

        const slow = await begin();
        expect(slow.error).toBeUndefined();
        expect(slow.begun!.upload.status).toBe('open');
        expect(s3.openUploads(DEAD)).toHaveLength(1);
    });
});
