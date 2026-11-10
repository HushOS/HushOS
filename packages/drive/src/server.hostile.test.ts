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
        // The store said nothing, so only the deadline ended this; and not before its time.
        expect(first.error).toBeInstanceOf(StoreDeadlineError);
        expect(first.took).toBeGreaterThanOrEqual(CALL - 5);
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
        // Refused here: the dead store was sent nothing more, so no deadline was waited out.
        expect(sentTo(DEAD)).toHaveLength(sent);
        // Refused begins leave nothing behind either.
        expect(await db.select().from(driveUploads)).toEqual([]);
        expect(await reserved()).toBe(0n);

        // Somebody whose files live at the other store is not held up by any of it.
        await regionAt(WELL_ID);
        const elsewhere = await begin();
        expect(elsewhere.error).toBeUndefined();
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
        const timed = async (call: Promise<unknown>) => ({
            error: await call.then(
                () => undefined,
                (thrown: unknown) => thrown,
            ),
        });
        const listed = await timed(
            server.getUploadState(owner.userId, owner.workspaceId, upload.id),
        );
        expect(listed.error).toBeInstanceOf(StoreDeadlineError);
        const completed = await timed(
            server.completeUpload(owner.userId, owner.workspaceId, upload.id, [
                { partNumber: 1, etag },
            ]),
        );
        expect(completed.error).toBeInstanceOf(StoreDeadlineError);
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
        // Five answers in a row, each right and each past half the deadline by the breaker's clock.
        const clock = { at: 0 };
        const store = createObjectStore({
            endpoint: s3.url,
            region: 'auto',
            bucket: DEAD,
            forcePathStyle: true,
            now: () => clock.at,
            ...credentials,
        });
        opened.stores[DEAD_ID] = store;
        s3.hooks.hostile = (request) => {
            if (request.bucket === DEAD) clock.at += 31_000;
            return false;
        };
        for (let i = 0; i < 5; i++) await store.head('ws/probe');
        expect(store.health()).toBe('slow');

        const slow = await begin();
        expect(slow.error).toBeUndefined();
        expect(slow.begun!.upload.status).toBe('open');
        expect(s3.openUploads(DEAD)).toHaveLength(1);
    });
});

describe('completing a large upload', () => {
    test('is given five minutes at most by a person’s request, whatever the object’s size allows the worker', async () => {
        const { WEB_CALL_MAX_MS, deadlineFor, STORE_BOUNDS } = await import('./bounds');
        const asked: { size?: number; maxMs?: number }[] = [];
        const real = opened.stores[DEAD_ID] as Storage.ObjectStore;
        opened.stores[DEAD_ID] = {
            ...real,
            completeMultipart: (
                key: string,
                uploadId: string,
                parts: { partNumber: number; etag: string }[],
                options: { size?: number; maxMs?: number } = {},
            ) => {
                asked.push(options);
                return real.completeMultipart(key, uploadId, parts, options);
            },
        };
        const { begun } = await begin();
        const put = await fetch(begun!.parts[0]!.url, {
            method: 'PUT',
            body: new Uint8Array(randomBytes(4096)),
            headers: { 'content-type': 'application/octet-stream' },
        });
        await server.completeUpload(owner.userId, owner.workspaceId, begun!.upload.id, [
            { partNumber: 1, etag: put.headers.get('etag')! },
        ]);
        // The store is told the size the row holds, and the ceiling of a web request.
        expect(asked).toEqual([{ size: 4096, maxMs: WEB_CALL_MAX_MS }]);
        // Which for a 5 GiB object is five minutes, where the rate alone says 5 h 42 min.
        expect(deadlineFor(STORE_BOUNDS, 5 * 1024 ** 3, asked[0]!.maxMs)).toBe(5 * 60_000);
    });
});
