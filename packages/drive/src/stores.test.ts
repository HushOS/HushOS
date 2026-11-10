import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Database from '@hushos/db';
import { startS3 } from '../test/s3-server';

/*
 * The repository as it is, except that one test can make the write of the
 * multipart id fail the way a lost database connection would.
 */
const failing = vi.hoisted(() => ({ setUploadMultipartId: null as Error | null }));
vi.mock('@hushos/db', async (importOriginal) => {
    const real = await importOriginal<typeof Database>();
    const setUploadMultipartId: typeof real.driveRepository.setUploadMultipartId = (...args) =>
        failing.setUploadMultipartId
            ? Promise.reject(failing.setUploadMultipartId)
            : real.driveRepository.setUploadMultipartId(...args);
    return { ...real, driveRepository: { ...real.driveRepository, setUploadMultipartId } };
});

/*
 * Every object and upload names its store, and everything that reads, signs,
 * copies or deletes follows that row (docs/company-storage-design.md 2.2).
 * Against a real database and a real S3 client: the store is a small S3 server
 * in this process with several buckets, reached through the SDK and through
 * the presigned URLs a browser would use, so "which store" is which bucket the
 * bytes are in.
 *
 * Two rows can be opened before sealed secrets exist, the environment's
 * primary and its replica. This process holds the replica's variables, as the
 * worker does, so the replica's row is the second store the server-side tests
 * point at; nothing about resolution is particular to it. The worker's jobs
 * take the opener as an argument and are also given a third bucket under a
 * `database` store's id.
 */

const s3 = await startS3();
const PRIMARY = s3.bucket('primary');
const REPLICA = s3.bucket('replica');
const SECOND = s3.bucket('second');
const EVIDENCE = s3.bucket('evidence');
const credentials = { accessKeyId: 'test-key', secretAccessKey: 'test-secret' };
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
    driveRepository,
    reportsRepository,
    ENVIRONMENT_PRIMARY_STORE_ID,
    ENVIRONMENT_REPLICA_STORE_ID,
} = await import('@hushos/db');
const { db } = await import('../../db/src/client');
const { driveObjectDeletions, driveObjects, driveUploads } = await import('../../db/src/schema');
const { metadataStatement, versionStatement } = await import('../../db/src/signatures');
const { closeDatabase, createTestStore, resetDatabase, signerFor } =
    await import('../../db/test/helpers');
const fixtures = await import('../test/fixtures');
const jobs = await import('./jobs');
const server = await import('./server');
const { createObjectStore, replicaStore, storeFor, StoreUnavailableError } =
    await import('./storage');

type Account = Awaited<ReturnType<typeof fixtures.member>>;
type Root = Awaited<ReturnType<typeof fixtures.root>>;

const b64 = (bytes: Buffer) => bytes.toString('base64url');
const CHUNK = 8 * 1024 * 1024 + 16;

let owner: Account;
let root: Root;

beforeEach(async () => {
    s3.reset();
    await resetDatabase();
    owner = await fixtures.member();
    root = await fixtures.root(owner);
});
afterAll(async () => {
    await closeDatabase();
    await s3.stop();
});

/* A begin as a client sends it: fresh ids for this workspace, signed by the owner. */
async function beginInput(framing: { chunkCount: number; ciphertextSize: number }) {
    const node = fixtures.minted('node', owner.workspaceId);
    const version = fixtures.minted('version', owner.workspaceId);
    const object = fixtures.minted('object', owner.workspaceId);
    const metadata = randomBytes(24 + 256 + 16);
    const content = randomBytes(84);
    const sign = signerFor(owner.userId).sign;
    return {
        node: {
            existing: false as const,
            id: node.id,
            idSeed: node.seed,
            parentId: root.id,
            keyEpoch: await fixtures.epoch(owner.workspaceId),
            parentKeyEpoch: root.keyEpoch,
            keyEnvelope: b64(randomBytes(72)),
            metadataEnvelope: b64(metadata),
            metadataSignature: b64(
                sign(
                    metadataStatement({
                        workspaceId: owner.workspaceId,
                        nodeId: node.id,
                        kind: 'file',
                        metadataVersion: 1,
                        metadataEnvelope: metadata,
                    }),
                ),
            ),
        },
        versionId: version.id,
        versionIdSeed: version.seed,
        objectId: object.id,
        objectIdSeed: object.seed,
        contentKeyEnvelope: b64(content),
        versionSignature: b64(
            sign(
                versionStatement({
                    workspaceId: owner.workspaceId,
                    nodeId: node.id,
                    versionId: version.id,
                    objectId: object.id,
                    contentSuite: 3,
                    contentKeyEnvelope: content,
                }),
            ),
        ),
        contentNonce: b64(randomBytes(16)),
        contentSuite: 3,
        chunkCount: framing.chunkCount,
        ciphertextSize: String(framing.ciphertextSize),
    };
}

const keyOf = (objectId: string) => `ws/${owner.workspaceId}/${objectId}`;

async function begin(framing = { chunkCount: 1, ciphertextSize: 4096 }) {
    const input = await beginInput(framing);
    const begun = await server.beginUpload(owner.userId, owner.workspaceId, input);
    return { input, begun, key: keyOf(input.objectId) };
}

/* Sends a part the way a browser does: a PUT to the presigned URL, reading the ETag. */
async function putPart(part: { url: string; length: number }, body: Buffer) {
    expect(body.length).toBe(part.length);
    const response = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(body),
        headers: { 'content-type': 'application/octet-stream' },
    });
    expect(response.status).toBe(200);
    return response.headers.get('etag')!;
}

async function read(url: string, from: number, to: number) {
    const response = await fetch(url, { headers: { range: `bytes=${from}-${to}` } });
    expect(response.status).toBe(206);
    return Buffer.from(await response.arrayBuffer());
}

const bucketOf = (url: string) => new URL(url).pathname.split('/')[1];

/* Plain SQL for the rows a test arranges; the package has no query builder of its own. */
const run = (text: string, params: unknown[] = []) => db.$client.query(text, params);

/* The default region re-pointed, as a move's switch will do it. */
async function regionAt(storeId: string) {
    await run('update storage_regions set store_id = $1, backup_store_id = null where is_default', [
        storeId,
    ]);
}

/* At the replica's row, the second store this process can open. */
const regionAtSecondStore = () => regionAt(ENVIRONMENT_REPLICA_STORE_ID);

async function uploadRows() {
    return db.select().from(driveUploads);
}

async function reserved() {
    const result = await run(
        'select reserved_bytes::text as reserved from workspace_storage where workspace_id = $1',
        [owner.workspaceId],
    );
    return BigInt(result.rows[0].reserved);
}

/* A published file whose object row names `storeId`, with `bytes` in `bucket` under its key. */
async function storedFile(storeId: string, bucket: string, bytes: Buffer) {
    const node = await fixtures.file(owner, root, BigInt(bytes.length));
    const objectId = node.currentVersion!.objectId;
    await run('update drive_objects set store_id = $1 where id = $2', [storeId, objectId]);
    s3.put(bucket, keyOf(objectId), bytes);
    return { node, objectId, key: keyOf(objectId), versionId: node.currentVersion!.id };
}

/* Files a report on `file`, sealed to an operator made for it, and returns the report's id. */
async function reported(file: { node: { id: string; keyEpoch: number } }) {
    const operator = await fixtures.member();
    await run(`update users set role = 'admin' where id = $1`, [operator.userId]);
    const id = randomUUID();
    const filed = await reportsRepository.createReport({
        id,
        workspaceId: owner.workspaceId,
        nodeId: file.node.id,
        keyEpoch: file.node.keyEpoch,
        linkId: null,
        shareId: null,
        category: 'other',
        reason: 'Looks wrong.',
        reporterUserId: null,
        reporterEmail: null,
        reporterAddressHash: randomBytes(32),
        keys: (await reportsRepository.listOperators()).map((entry) => ({
            operatorUserId: entry.userId,
            keyEnvelope: randomBytes(112),
        })),
    });
    expect(filed.status).toBe('ok');
    return id;
}

/* The owner trashes and purges a file: its object row becomes an outbox row. */
async function purged(file: { node: { id: string } }) {
    await driveRepository.trashNode({ workspaceId: owner.workspaceId, nodeId: file.node.id });
    await driveRepository.purgeNode({ workspaceId: owner.workspaceId, nodeId: file.node.id });
}

describe('an upload, from begin to download', () => {
    test('a one-part upload lands in the store its row names and reads back byte for byte', async () => {
        const { begun, key } = await begin();
        // The multipart upload the row names is the one the store started, at the row's store.
        const [row] = await uploadRows();
        expect(row).toMatchObject({ storeId: ENVIRONMENT_PRIMARY_STORE_ID, status: 'open' });
        expect(s3.openUploads(PRIMARY)).toEqual([{ id: row!.multipartId, key }]);
        expect(begun.parts.map((part) => bucketOf(part.url))).toEqual([PRIMARY]);

        const bytes = randomBytes(4096);
        const etag = await putPart(begun.parts[0]!, bytes);
        const done = await server.completeUpload(owner.userId, owner.workspaceId, begun.upload.id, [
            { partNumber: 1, etag },
        ]);
        expect(done.status).toBe('completed');
        expect(s3.get(PRIMARY, key)).toEqual(bytes);
        expect(s3.keys(REPLICA)).toEqual([]);
        expect(s3.openUploads(PRIMARY)).toEqual([]);

        const download = await server.downloadUrl(
            owner.userId,
            owner.workspaceId,
            begun.upload.versionId,
        );
        expect(await read(download.url, 0, 4095)).toEqual(bytes);
        const thumbnails = await server.thumbnailUrls(owner.userId, owner.workspaceId, [
            begun.upload.versionId,
        ]);
        expect(await read(thumbnails.urls[0]!.url, 4000, 4095)).toEqual(bytes.subarray(4000));
    });

    test('a two-part upload is signed, listed and completed part by part at that store', async () => {
        const size = CHUNK + 4096;
        const { begun, key } = await begin({ chunkCount: 2, ciphertextSize: size });
        expect(begun.parts.map((part) => part.length)).toEqual([CHUNK, 4096]);
        const bytes = randomBytes(size);
        const first = await putPart(begun.parts[0]!, bytes.subarray(0, CHUNK));
        // A resume: what the store holds so far, and a fresh URL for what is left.
        const state = await server.getUploadState(owner.userId, owner.workspaceId, begun.upload.id);
        expect(state.parts).toEqual([{ partNumber: 1, etag: first, size: CHUNK }]);
        const more = await server.uploadPartUrls(
            owner.userId,
            owner.workspaceId,
            begun.upload.id,
            2,
            1,
        );
        const second = await putPart(more.parts[0]!, bytes.subarray(CHUNK));
        await server.completeUpload(owner.userId, owner.workspaceId, begun.upload.id, [
            { partNumber: 2, etag: second },
            { partNumber: 1, etag: first },
        ]);
        expect(s3.get(PRIMARY, key)?.equals(bytes)).toBe(true);
        const download = await server.downloadUrl(
            owner.userId,
            owner.workspaceId,
            begun.upload.versionId,
        );
        // A range across the part boundary: the parts were joined in order.
        expect(await read(download.url, CHUNK - 8, CHUNK + 7)).toEqual(
            bytes.subarray(CHUNK - 8, CHUNK + 8),
        );
    });
});

describe('the store is the row’s, not a global', () => {
    test('with the region at a second store, begin, part URLs, the part list, completion and abort all go there', async () => {
        await regionAtSecondStore();
        const { begun, key } = await begin();
        const [row] = await uploadRows();
        expect(row?.storeId).toBe(ENVIRONMENT_REPLICA_STORE_ID);
        expect(s3.openUploads(REPLICA)).toEqual([{ id: row!.multipartId, key }]);
        expect(s3.openUploads(PRIMARY)).toEqual([]);
        expect(bucketOf(begun.parts[0]!.url)).toBe(REPLICA);

        const bytes = randomBytes(4096);
        const etag = await putPart(begun.parts[0]!, bytes);
        const state = await server.getUploadState(owner.userId, owner.workspaceId, begun.upload.id);
        expect(state.parts).toEqual([{ partNumber: 1, etag, size: 4096 }]);
        await server.completeUpload(owner.userId, owner.workspaceId, begun.upload.id, [
            { partNumber: 1, etag },
        ]);
        expect(s3.get(REPLICA, key)).toEqual(bytes);
        expect(s3.keys(PRIMARY)).toEqual([]);
        const [object] = await db.select().from(driveObjects);
        expect(object).toMatchObject({ storeId: ENVIRONMENT_REPLICA_STORE_ID, status: 'ready' });

        // The region moves back: what began at the second store is still aborted there.
        const abandoned = await begin();
        await regionAt(ENVIRONMENT_PRIMARY_STORE_ID);
        expect(s3.openUploads(REPLICA)).toHaveLength(1);
        const more = await server.uploadPartUrls(
            owner.userId,
            owner.workspaceId,
            abandoned.begun.upload.id,
            1,
            1,
        );
        expect(bucketOf(more.parts[0]!.url)).toBe(REPLICA);
        await server.abortUpload(owner.userId, owner.workspaceId, abandoned.begun.upload.id);
        expect(s3.openUploads(REPLICA)).toEqual([]);
    });

    test('a file whose object row names a second store is downloaded, thumbnailed and copied from that store', async () => {
        const there = randomBytes(2048);
        const file = await storedFile(ENVIRONMENT_REPLICA_STORE_ID, REPLICA, there);
        // A stale copy under the same key in the primary: a read that ignored the row would get it.
        s3.put(PRIMARY, file.key, randomBytes(2048));

        const one = await server.downloadUrl(owner.userId, owner.workspaceId, file.versionId);
        expect(await read(one.url, 0, 2047)).toEqual(there);
        const many = await server.downloadUrls(owner.userId, owner.workspaceId, [file.versionId]);
        expect(await read(many.urls[0]!.url, 0, 2047)).toEqual(there);
        const thumbnails = await server.thumbnailUrls(owner.userId, owner.workspaceId, [
            file.versionId,
        ]);
        expect(await read(thumbnails.urls[0]!.url, 2000, 2047)).toEqual(there.subarray(2000));

        // A copy moves no bytes: it points at the same object, so it is read from the same store.
        const node = fixtures.minted('node', owner.workspaceId);
        const version = fixtures.minted('version', owner.workspaceId);
        const metadata = randomBytes(24 + 256 + 16);
        const content = randomBytes(84);
        const sign = signerFor(owner.userId).sign;
        await server.copyNode(owner.userId, owner.workspaceId, file.node.id, {
            sourceVersionId: file.versionId,
            node: {
                id: node.id,
                idSeed: node.seed,
                parentId: root.id,
                keyEpoch: await fixtures.epoch(owner.workspaceId),
                parentKeyEpoch: root.keyEpoch,
                keyEnvelope: b64(randomBytes(72)),
                metadataEnvelope: b64(metadata),
                metadataSignature: b64(
                    sign(
                        metadataStatement({
                            workspaceId: owner.workspaceId,
                            nodeId: node.id,
                            kind: 'file',
                            metadataVersion: 1,
                            metadataEnvelope: metadata,
                        }),
                    ),
                ),
            },
            versionId: version.id,
            versionIdSeed: version.seed,
            contentKeyEnvelope: b64(content),
            versionSignature: b64(
                sign(
                    versionStatement({
                        workspaceId: owner.workspaceId,
                        nodeId: node.id,
                        versionId: version.id,
                        objectId: file.objectId,
                        contentSuite: 3,
                        contentKeyEnvelope: content,
                    }),
                ),
            ),
        });
        const copied = await server.downloadUrl(owner.userId, owner.workspaceId, version.id);
        expect(await read(copied.url, 0, 2047)).toEqual(there);
    });

    test('a store this process cannot open fails the request, and nothing is signed or asked elsewhere', async () => {
        const unopened = await createTestStore();
        const file = await storedFile(unopened, PRIMARY, randomBytes(1024));
        s3.requests.length = 0;
        await expect(
            server.downloadUrl(owner.userId, owner.workspaceId, file.versionId),
        ).rejects.toBeInstanceOf(StoreUnavailableError);
        await expect(
            server.thumbnailUrls(owner.userId, owner.workspaceId, [file.versionId]),
        ).rejects.toBeInstanceOf(StoreUnavailableError);

        // A new upload there: refused, undone, and no multipart upload opened at any store.
        await regionAt(unopened);
        const input = await beginInput({ chunkCount: 1, ciphertextSize: 4096 });
        const error = await server.beginUpload(owner.userId, owner.workspaceId, input).then(
            () => null,
            (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(StoreUnavailableError);
        // The error names the store's id and nothing of where it points.
        expect(String((error as Error).message)).not.toMatch(/http|s3\.|second-/);
        // Only the finished upload of the file above is left: the refused begin kept no row.
        expect((await uploadRows()).map((row) => row.status)).toEqual(['completed']);
        expect(await reserved()).toBe(0n);
        expect(s3.requests).toEqual([]);
    });
});

describe('a report’s bytes', () => {
    test('are signed at the store that holds them, before and after the owner purges the file', async () => {
        const there = randomBytes(2048);
        const file = await storedFile(ENVIRONMENT_REPLICA_STORE_ID, REPLICA, there);
        // A different object under the same key in the primary: a URL signed there would read it.
        s3.put(PRIMARY, file.key, randomBytes(2048));
        const reportId = await reported(file);

        const readAll = async () => {
            const one = await server.reportDownloadUrl(reportId, file.versionId);
            const many = await server.reportDownloadUrls(reportId, [file.versionId]);
            const thumbnails = await server.reportThumbnailUrls(reportId, [file.versionId]);
            return [
                await read(one.url, 0, 2047),
                await read(many.urls[0]!.url, 0, 2047),
                await read(thumbnails.urls[0]!.url, 0, 2047),
            ];
        };
        expect(await readAll()).toEqual([there, there, there]);

        // Purged: the object's row is gone, and the hold keeps the copy its outbox row names.
        await purged(file);
        expect(await db.select().from(driveObjects)).toEqual([]);
        expect((await db.select().from(driveObjectDeletions)).map((row) => row.storeId)).toEqual([
            ENVIRONMENT_REPLICA_STORE_ID,
        ]);
        expect(await readAll()).toEqual([there, there, there]);
    });
});

describe('begin and its store', () => {
    test('the row is committed, open and without an id, before the store is asked', async () => {
        let seen: Awaited<ReturnType<typeof uploadRows>> = [];
        s3.hooks.beforeCreateMultipart = async () => {
            seen = await uploadRows();
        };
        await begin();
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
            status: 'open',
            multipartId: null,
            storeId: ENVIRONMENT_PRIMARY_STORE_ID,
        });
        const [after] = await uploadRows();
        expect(after!.multipartId).toBe(s3.openUploads(PRIMARY)[0]!.id);
    });

    test('a store that refuses leaves nothing behind, and the same begin then goes through', async () => {
        const input = await beginInput({ chunkCount: 1, ciphertextSize: 4096 });
        s3.hooks.beforeCreateMultipart = () => {
            throw new Error('refused');
        };
        await expect(
            server.beginUpload(owner.userId, owner.workspaceId, input),
        ).rejects.toMatchObject({ name: 'AccessDenied' });
        expect(await uploadRows()).toEqual([]);
        expect(await db.select().from(driveObjects)).toEqual([]);
        expect(await db.select().from(driveObjectDeletions)).toEqual([]);
        expect(await reserved()).toBe(0n);

        // The client sends the same ids again, as it always could after a store failure.
        s3.hooks.beforeCreateMultipart = undefined;
        const begun = await server.beginUpload(owner.userId, owner.workspaceId, input);
        expect(begun.upload.status).toBe('open');
        expect(await reserved()).toBe(4096n);
    });

    test('a failure writing the multipart id aborts the upload the store just started, and is rethrown', async () => {
        const input = await beginInput({ chunkCount: 1, ciphertextSize: 4096 });
        failing.setUploadMultipartId = new Error('the database went away');
        try {
            await expect(
                server.beginUpload(owner.userId, owner.workspaceId, input),
            ).rejects.toThrow('the database went away');
        } finally {
            failing.setUploadMultipartId = null;
        }
        // The store did start one, and no row will ever name it: it must not be left open.
        const started = s3.requests.filter(
            (request) => request.method === 'POST' && request.query.includes('uploads'),
        );
        expect(started).toHaveLength(1);
        expect(s3.openUploads(PRIMARY)).toEqual([]);
        // The row stays as begin committed it, for expiry to take once it is a minute old.
        expect(await uploadRows()).toMatchObject([{ status: 'open', multipartId: null }]);
    });

    test('a store that answers after the row was expired leaves no row with an id and no open multipart upload', async () => {
        let asked!: () => void;
        let answer!: () => void;
        const reached = new Promise<void>((resolve) => (asked = resolve));
        const held = new Promise<void>((resolve) => (answer = resolve));
        s3.hooks.beforeCreateMultipart = async () => {
            asked();
            await held;
        };
        const input = await beginInput({ chunkCount: 1, ciphertextSize: 4096 });
        const pending = server.beginUpload(owner.userId, owner.workspaceId, input).then(
            () => null,
            (caught: unknown) => caught,
        );
        await reached;
        // More than a minute passes with no answer, and the worker's expiry runs.
        await run('update drive_uploads set created_at = now() - make_interval(secs => $1)', [
            driveRepository.UPLOAD_START_SECONDS + 1,
        ]);
        expect(await jobs.expireUploads({ open: storeFor, replica: null })).toMatchObject({
            examined: 1,
            aborted: 1,
        });
        expect(await reserved()).toBe(0n);

        answer();
        const error = await pending;
        expect(error).toBeInstanceOf(server.DriveError);
        expect(error).toMatchObject({ code: 'expired', status: 409 });
        // The multipart upload the store started late was aborted, and no row took its id.
        expect(s3.openUploads(PRIMARY)).toEqual([]);
        expect((await uploadRows()).filter((row) => row.multipartId !== null)).toEqual([]);
    });
});

describe('the worker follows each row', () => {
    const second = createObjectStore({
        endpoint: s3.url,
        region: 'auto',
        bucket: SECOND,
        forcePathStyle: true,
        ...credentials,
    });
    let secondId: string;
    /* The worker's opener, with a third store under a `database` row's id. */
    const open = async (storeId: string) => (storeId === secondId ? second : storeFor(storeId));

    beforeEach(async () => {
        secondId = await createTestStore({ bucket: SECOND });
    });

    test('expiry aborts a multipart upload at the store its upload names', async () => {
        const kept = await begin();
        await regionAtSecondStore();
        const expired = await begin();
        await run(
            "update drive_uploads set expires_at = now() - interval '1 second' where id = $1",
            [expired.begun.upload.id],
        );
        expect(await jobs.expireUploads({ open, replica: null })).toMatchObject({
            examined: 1,
            aborted: 1,
        });
        expect(s3.openUploads(REPLICA)).toEqual([]);
        // The live upload at the other store was not what got aborted.
        expect(s3.openUploads(PRIMARY).map((upload) => upload.key)).toEqual([kept.key]);
    });

    test('expiry aborts a completing upload only when its store says the object is not there', async () => {
        const unopened = await createTestStore();
        // Four uploads whose completion stalled more than an hour ago.
        const stalled = async () => {
            const upload = await begin();
            await driveRepository.startCompleting(owner.workspaceId, upload.begun.upload.id);
            return { ...upload, id: upload.begun.upload.id };
        };
        const elsewhere = await stalled();
        const silent = await stalled();
        const absent = await stalled();
        const present = await stalled();
        await run(`update drive_uploads set completing_at = now() - interval '2 hours'`);
        // One at a store this worker cannot open, with its bytes fully uploaded there for all
        // this worker knows; one at a store that does not answer.
        await run(`update drive_uploads set store_id = $1 where id = $2`, [unopened, elsewhere.id]);
        await run(`update drive_uploads set store_id = $1 where id = $2`, [secondId, silent.id]);
        s3.put(PRIMARY, present.key, randomBytes(4096));
        const unanswering = { ...second, head: () => Promise.reject(new Error('socket hang up')) };

        expect(
            await jobs.expireUploads({
                open: async (storeId) => (storeId === secondId ? unanswering : open(storeId)),
                replica: null,
            }),
        ).toEqual({ examined: 4, aborted: 1, finalised: 1, skipped: 2 });

        const rows = Object.fromEntries((await uploadRows()).map((row) => [row.id, row.status]));
        // Neither was aborted: their objects and reservations stand until a store answers.
        expect(rows[elsewhere.id]).toBe('completing');
        expect(rows[silent.id]).toBe('completing');
        expect(rows[present.id]).toBe('completed');
        // Truly absent: aborted, and a file nobody saw goes with its upload.
        expect(rows[absent.id]).toBeUndefined();
        expect(await reserved()).toBe(2n * 4096n);
        expect((await db.select().from(driveObjects)).map((row) => row.id).sort()).toEqual(
            [elsewhere.input.objectId, silent.input.objectId, present.input.objectId].sort(),
        );
    });

    test('evidence is copied from the store that holds the reported object, live or purged', async () => {
        const evidence = createObjectStore({
            endpoint: s3.url,
            region: 'auto',
            bucket: EVIDENCE,
            forcePathStyle: true,
            ...credentials,
        });
        const reportedFile = async () => {
            const bytes = randomBytes(1500);
            const file = await storedFile(secondId, SECOND, bytes);
            // A different object under the same key in the primary: a copy from there would show.
            s3.put(PRIMARY, file.key, randomBytes(1500));
            return { bytes, file, reportId: await reported(file) };
        };
        const live = await reportedFile();
        const held = await reportedFile();
        const gone = await reportedFile();
        await purged(held.file);
        // No row names the third any more, as after its outbox row is cleared away.
        await purged(gone.file);
        await run(`delete from drive_object_deletions where object_id = $1`, [gone.file.objectId]);

        const result = await jobs.copyEvidence({ open, evidence });
        expect(result).toMatchObject({ reports: 3, copied: 2, failed: 1 });
        expect(result.failures).toEqual([
            {
                report: gone.reportId,
                object: gone.file.objectId,
                error: 'Error: The reported object is no longer in any store.',
            },
        ]);
        const copyOf = (entry: typeof live) =>
            s3.get(EVIDENCE, `reports/${entry.reportId}/${entry.file.objectId}`);
        expect(copyOf(live)).toEqual(live.bytes);
        expect(copyOf(held)).toEqual(held.bytes);
        // Not guessed at from the primary, where a key of the same name sits.
        expect(copyOf(gone)).toBeNull();
    });

    test('the outbox deletes each copy from the store its row names, and only there', async () => {
        const here = await begin();
        await regionAt(secondId);
        // An upload at the third store, as its rows would be had the web process begun it there.
        const node = await fixtures.file(owner, root, 1024n);
        const thereKey = keyOf(node.currentVersion!.objectId);
        // Both keys exist in both buckets: a delete at the wrong store would show.
        for (const bucket of [PRIMARY, SECOND])
            for (const key of [here.key, thereKey]) s3.put(bucket, key, randomBytes(16));

        await server.abortUpload(owner.userId, owner.workspaceId, here.begun.upload.id);
        // The published file is trashed and purged, which retires its object.
        await driveRepository.trashNode({ workspaceId: owner.workspaceId, nodeId: node.id });
        await driveRepository.purgeNode({ workspaceId: owner.workspaceId, nodeId: node.id });
        const outbox = await db.select().from(driveObjectDeletions);
        expect(Object.fromEntries(outbox.map((row) => [row.objectKey, row.storeId]))).toEqual({
            [here.key]: ENVIRONMENT_PRIMARY_STORE_ID,
            [thereKey]: secondId,
        });

        expect(await jobs.deleteObjects({ open, replica: null })).toMatchObject({ primaries: 2 });
        expect(s3.keys(PRIMARY)).toEqual([thereKey]);
        expect(s3.keys(SECOND)).toEqual([here.key]);
    });

    test('replication copies from the object’s own store to the replica', async () => {
        const a = randomBytes(3000);
        const b = randomBytes(3000);
        const here = await storedFile(ENVIRONMENT_PRIMARY_STORE_ID, PRIMARY, a);
        const there = await storedFile(secondId, SECOND, b);
        // A stale copy of the second object's key in the primary: a copy that ignored the row would take it.
        s3.put(PRIMARY, there.key, randomBytes(3000));
        expect(await jobs.replicateObjects({ open, replica: replicaStore() })).toEqual({
            copied: 2,
        });
        expect(s3.get(REPLICA, here.key)).toEqual(a);
        expect(s3.get(REPLICA, there.key)).toEqual(b);
        expect(await driveRepository.listUnreplicatedObjects()).toEqual([]);
    });

    test('the audit looks where the row says, and heals a lost copy back into that store', async () => {
        const bytes = randomBytes(2000);
        const lost = await storedFile(secondId, SECOND, bytes);
        s3.remove(SECOND, lost.key);
        s3.put(REPLICA, lost.key, bytes);
        // Present under the same key in the primary, where its row does not say it is.
        s3.put(PRIMARY, lost.key, bytes);
        await run('update drive_objects set replicated_at = now() where id = $1', [lost.objectId]);
        const gone = await storedFile(ENVIRONMENT_PRIMARY_STORE_ID, PRIMARY, randomBytes(500));
        s3.remove(PRIMARY, gone.key);
        // In the third store, but its row says the primary: not there, and in no replica.
        s3.put(SECOND, gone.key, randomBytes(500));

        expect(await jobs.auditObjects({ open, replica: replicaStore() }, 'primary')).toMatchObject(
            { examined: 2, recovered: 1, missing: 1 },
        );
        expect(s3.get(SECOND, lost.key)).toEqual(bytes);
        const rows = await db.select().from(driveObjects);
        expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual({
            [lost.objectId]: 'ready',
            [gone.objectId]: 'missing',
        });
    });

    test('the orphan sweep walks the environment’s primary bucket and no other', async () => {
        const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
        const named = await storedFile(ENVIRONMENT_PRIMARY_STORE_ID, PRIMARY, randomBytes(64));
        s3.put(PRIMARY, named.key, randomBytes(64), old);
        const stray = `ws/${owner.workspaceId}/stray`;
        s3.put(PRIMARY, stray, randomBytes(64), old);
        s3.put(SECOND, stray, randomBytes(64), old);
        s3.put(REPLICA, stray, randomBytes(64), old);
        expect(await jobs.sweepOrphans({ open, replica: null })).toMatchObject({
            listed: 2,
            deleted: 1,
            completed: true,
        });
        expect(s3.keys(PRIMARY)).toEqual([named.key]);
        expect(s3.keys(SECOND)).toEqual([stray]);
        expect(s3.keys(REPLICA)).toEqual([stray]);
    });

    test('tiering rewrites only objects in the environment’s primary', async () => {
        const here = await storedFile(ENVIRONMENT_PRIMARY_STORE_ID, PRIMARY, randomBytes(64));
        const there = await storedFile(secondId, SECOND, randomBytes(64));
        s3.put(PRIMARY, there.key, randomBytes(64));
        await run("update drive_objects set ready_at = now() - interval '100 days'");
        expect(
            await jobs.tierObjects({ open, replica: null }, { coldClass: 'STANDARD_IA' }),
        ).toEqual({ cooled: 1, warmed: 0 });
        expect(s3.storageClass(PRIMARY, here.key)).toBe('STANDARD_IA');
        expect(s3.storageClass(PRIMARY, there.key)).toBe('STANDARD');
        expect(s3.storageClass(SECOND, there.key)).toBe('STANDARD');
    });
});
