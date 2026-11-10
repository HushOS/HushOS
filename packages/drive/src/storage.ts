import {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CopyObjectCommand,
    CreateMultipartUploadCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    ListPartsCommand,
    NoSuchUpload,
    NotFound,
    PutObjectCommand,
    S3Client,
    S3ServiceException,
    type StorageClass,
    UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import { ENVIRONMENT_PRIMARY_STORE_ID, ENVIRONMENT_REPLICA_STORE_ID } from '@hushos/db/schema';
import {
    evidenceConfigured,
    replicaConfigured,
    storageEnv,
    storageEvidenceEnv,
    storageReplicaEnv,
} from '@hushos/env/storage';
import { log } from '@hushos/logging';
import {
    type CallOptions,
    type Guard,
    STORE_BOUNDS,
    StoreAnswerError,
    type StoreBounds,
    StoreUnavailableError,
    createGuard,
} from './bounds';
import { CHUNK_SIZE, CHUNK_TAG_BYTES, THUMBNAIL_MAX_BYTES } from './protocol';

export { StoreAnswerError, StoreDeadlineError, StoreUnavailableError } from './bounds';
export type { Health } from './bounds';

/*
 * The object store, through the S3 API every candidate speaks: Garage locally, R2
 * hosted, B2 as the replica. Object keys carry no information ("ws/{ws}/{object}")
 * and the store only ever holds ciphertext. Nothing here knows about the tree.
 *
 * Every part URL is signed with the exact Content-Length the server derived from
 * the plaintext size, so the store refuses a part of any other length; the
 * reservation bounds what the store accepts, not only what the database admits.
 */

export type StoreConfig = {
    /*
     * Which store this is, for its breaker and its cap: one state per id and
     * process, however often the store is opened. Without one the store keeps
     * a state of its own.
     */
    id?: string;
    /* The endpoint presigned URLs name: what a browser can reach. */
    endpoint: string;
    /* Where this process reaches the store, when that is a different address (Compose's `garage`). */
    internalEndpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
    /* The most calls in flight at once (2.4: a company's store). The operator's own stores have none. */
    cap?: number;
    /* Other bounds than this deployment's, for tests that cannot wait a minute. */
    bounds?: Partial<StoreBounds>;
};

export type ObjectStore = ReturnType<typeof createObjectStore>;
/* What a copy asks of the store it reads from: its size, and ranges of its bytes, each a guarded call of that store's. */
export type CopySource = {
    head: (key: string, options?: CallOptions) => Promise<{ size: number } | null>;
    read: (key: string, from: number, to: number, options?: CallOptions) => Promise<Uint8Array>;
};

/* A copy moves in parts of this size: held in memory one at a time, above the 5 MiB minimum and well under any single-put limit. */
export const COPY_PART_SIZE = 64 * 1024 * 1024;

/*
 * The largest object an upload can make: S3's 10,000 parts of one sealed chunk
 * each, and a thumbnail's trailer. A copy whose object has no row left to say
 * its size is held to this.
 */
export const MAX_OBJECT_BYTES =
    10_000 * (CHUNK_SIZE + CHUNK_TAG_BYTES) + 2 * (THUMBNAIL_MAX_BYTES + CHUNK_TAG_BYTES);

export function objectKey(workspaceId: string, objectId: string) {
    return `ws/${workspaceId}/${objectId}`;
}

/* This deployment's bounds: the design's, with the rate the operator set. */
export function storeBounds(): StoreBounds {
    return { ...STORE_BOUNDS, bytesPerSecond: storageEnv.STORAGE_MIN_BYTES_PER_SECOND };
}

/* One breaker and one cap per store and process (2.4), whoever opens the store and however often. */
const guards = new Map<string, Guard>();

/*
 * A 4xx is the store answering: it is up, and it refused this request (a key
 * that is not there, a part it never got, a signature it does not accept).
 * Being asked to wait (408, 429) is not an answer, and neither is anything
 * without a status: a timeout, a reset, a 5xx, or an answer that broke a bound.
 */
function answered(error: unknown) {
    const status = statusOf(error);
    return (
        status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429
    );
}

/*
 * Reads what the SDK parses itself (a listing, a part list, an error body) to
 * at most `limit` bytes; a longer answer is an error, not more memory. An
 * object's bytes never come through here: `read` streams those.
 */
function boundedCollector(limit: number) {
    return async (stream: unknown): Promise<Uint8Array> => {
        const chunks: Uint8Array[] = [];
        let received = 0;
        const body = stream as AsyncIterable<Uint8Array | string> & { destroy?: () => void };
        try {
            for await (const piece of body) {
                const chunk = typeof piece === 'string' ? Buffer.from(piece) : piece;
                received += chunk.byteLength;
                if (received > limit) throw new StoreAnswerError('too-long');
                chunks.push(chunk);
            }
        } finally {
            body.destroy?.();
        }
        return new Uint8Array(Buffer.concat(chunks));
    };
}

/*
 * Exactly `length` bytes of a body, into memory sized by what was asked for
 * and never by what arrives: one byte more is an error and the stream is
 * closed, and so is an end before the last byte. `signal` closes it too.
 */
async function readExactly(body: unknown, length: number, signal: AbortSignal) {
    const stream = body as
        | (AsyncIterable<Uint8Array> & { destroy?: (error?: Error) => void })
        | undefined;
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function')
        throw new StoreAnswerError('no-body');
    const bytes = new Uint8Array(length);
    let received = 0;
    const close = () => stream.destroy?.();
    signal.addEventListener('abort', close, { once: true });
    try {
        for await (const chunk of stream) {
            if (received + chunk.byteLength > length) throw new StoreAnswerError('too-long');
            bytes.set(chunk, received);
            received += chunk.byteLength;
        }
    } finally {
        signal.removeEventListener('abort', close);
        close();
    }
    if (received < length) throw new StoreAnswerError('too-short');
    return bytes;
}

export function createObjectStore(config: StoreConfig) {
    const bounds = { ...storeBounds(), ...config.bounds };
    const clientFor = (endpoint: string) =>
        new S3Client({
            endpoint,
            region: config.region,
            forcePathStyle: config.forcePathStyle,
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
            },
            // R2 rejects the SDK's default CRC checksums on presigned and
            // multipart requests; the object is verified by size and by decryption.
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
            // Each attempt's own limits. The total deadline is the guard's, and spans the
            // SDK's retries: every request below is sent with the guard's signal.
            requestHandler: { connectionTimeout: bounds.connectMs, socketTimeout: bounds.idleMs },
            streamCollector: boundedCollector(bounds.answerBytes),
        });
    // The server talks to the store at the internal address; a signature names the
    // host the browser will use, so presigned URLs come from a client on the public one.
    const client = clientFor(config.internalEndpoint ?? config.endpoint);
    const signer = config.internalEndpoint ? clientFor(config.endpoint) : client;
    const Bucket = config.bucket;

    // An error names the store by its id and never by its bucket; one opened without an id has none to name.
    const fresh = () =>
        createGuard({ storeId: config.id ?? 'unnamed', bounds, cap: config.cap, answered });
    let guard: Guard;
    if (config.id === undefined) guard = fresh();
    else {
        guard = guards.get(config.id) ?? fresh();
        guards.set(config.id, guard);
    }
    const { call } = guard;

    /* The requests themselves, unguarded: each is made inside one `call`, with that call's signal. */
    async function headWith(key: string, signal: AbortSignal) {
        try {
            const result = await client.send(new HeadObjectCommand({ Bucket, Key: key }), {
                abortSignal: signal,
            });
            return { size: result.ContentLength ?? 0 };
        } catch (error) {
            if (error instanceof NotFound || statusOf(error) === 404) return null;
            throw error;
        }
    }
    async function abortWith(key: string, uploadId: string, signal: AbortSignal) {
        try {
            await client.send(
                new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }),
                { abortSignal: signal },
            );
        } catch (error) {
            if (!(error instanceof NoSuchUpload)) throw error;
        }
    }

    const head = (key: string, options?: CallOptions) =>
        call(0, (signal) => headWith(key, signal), options);

    async function createMultipart(key: string, options?: CallOptions) {
        const result = await call(
            0,
            (signal) =>
                client.send(new CreateMultipartUploadCommand({ Bucket, Key: key }), {
                    abortSignal: signal,
                }),
            options,
        );
        if (!result.UploadId) throw new Error('The store returned no upload id.');
        return result.UploadId;
    }

    const abortMultipart = (key: string, uploadId: string, options?: CallOptions) =>
        call(0, (signal) => abortWith(key, uploadId, signal), options);

    /*
     * Bytes `from` to `to` of an object, inclusive, and exactly those: the
     * store is asked for the range and what it sends is cut off at the range's
     * length (2.4). The deadline allows for that many bytes.
     */
    function read(key: string, from: number, to: number, options?: CallOptions) {
        const length = to - from + 1;
        return call(
            length,
            async (signal) => {
                const object = await client.send(
                    new GetObjectCommand({ Bucket, Key: key, Range: `bytes=${from}-${to}` }),
                    { abortSignal: signal },
                );
                return readExactly(object.Body, length, signal);
            },
            options,
        );
    }

    /* Writes a whole object from memory; with `checksum`, the store checks the SHA-256 it is sent. */
    async function put(
        key: string,
        bytes: Uint8Array,
        { checksum, ...options }: CallOptions & { checksum?: string } = {},
    ) {
        await call(
            bytes.byteLength,
            (signal) =>
                client.send(
                    new PutObjectCommand({
                        Bucket,
                        Key: key,
                        Body: bytes,
                        ContentLength: bytes.byteLength,
                        ChecksumSHA256: checksum,
                    }),
                    { abortSignal: signal },
                ),
            options,
        );
    }

    return {
        bucket: Bucket,
        /* Whether to call this store now: see `Health`. Asked by the worker's jobs before each item. */
        health: guard.health,

        createMultipart,

        /* A PUT URL for one part, valid only for a body of exactly `length` bytes. */
        presignPart(
            key: string,
            uploadId: string,
            partNumber: number,
            length: number,
            ttl: number,
        ) {
            return getSignedUrl(
                signer,
                new UploadPartCommand({
                    Bucket,
                    Key: key,
                    UploadId: uploadId,
                    PartNumber: partNumber,
                    ContentLength: length,
                }),
                { expiresIn: ttl, signableHeaders: new Set(['content-length']) },
            );
        },

        /* Every page of the part list under one deadline: a person is waiting for all of it. */
        listParts(key: string, uploadId: string, options?: CallOptions) {
            return call(
                0,
                async (signal) => {
                    const parts: { partNumber: number; etag: string; size: number }[] = [];
                    let marker: string | undefined;
                    try {
                        do {
                            const page = await client.send(
                                new ListPartsCommand({
                                    Bucket,
                                    Key: key,
                                    UploadId: uploadId,
                                    PartNumberMarker: marker,
                                    MaxParts: 1000,
                                }),
                                { abortSignal: signal },
                            );
                            for (const part of page.Parts ?? [])
                                if (part.PartNumber && part.ETag)
                                    parts.push({
                                        partNumber: part.PartNumber,
                                        etag: part.ETag,
                                        size: part.Size ?? 0,
                                    });
                            marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
                        } while (marker);
                    } catch (error) {
                        if (error instanceof NoSuchUpload) return null;
                        throw error;
                    }
                    return parts;
                },
                options,
            );
        },

        /*
         * Finishes the multipart upload and returns the stored size. `NoSuchUpload`
         * with the object present is a retry after an earlier success and is treated
         * as one; without the object it is reported as null. Both requests share one
         * deadline, which allows for the `size` the store is asked to assemble: S3
         * itself can take minutes over a large object, and says so.
         */
        completeMultipart(
            key: string,
            uploadId: string,
            parts: { partNumber: number; etag: string }[],
            { size = 0, ...options }: CallOptions & { size?: number } = {},
        ) {
            return call(
                size,
                async (signal) => {
                    try {
                        await client.send(
                            new CompleteMultipartUploadCommand({
                                Bucket,
                                Key: key,
                                UploadId: uploadId,
                                MultipartUpload: {
                                    Parts: parts.map((part) => ({
                                        PartNumber: part.partNumber,
                                        ETag: part.etag,
                                    })),
                                },
                            }),
                            { abortSignal: signal },
                        );
                    } catch (error) {
                        if (!(error instanceof NoSuchUpload)) throw error;
                    }
                    return headWith(key, signal);
                },
                options,
            );
        },

        abortMultipart,

        head,

        read,

        put,

        presignGet(key: string, ttl: number) {
            return getSignedUrl(signer, new GetObjectCommand({ Bucket, Key: key }), {
                expiresIn: ttl,
            });
        },

        async delete(key: string, options?: CallOptions) {
            await call(
                0,
                (signal) =>
                    client.send(new DeleteObjectCommand({ Bucket, Key: key }), {
                        abortSignal: signal,
                    }),
                options,
            );
        },

        /*
         * One page of keys under `prefix` after `startAfter`, in key order, with
         * when the store last wrote each; used by the orphan sweep and nothing else.
         */
        async list(prefix: string, startAfter: string | null, max = 1000, options?: CallOptions) {
            const page = await call(
                0,
                (signal) =>
                    client.send(
                        new ListObjectsV2Command({
                            Bucket,
                            Prefix: prefix,
                            StartAfter: startAfter ?? undefined,
                            MaxKeys: max,
                        }),
                        { abortSignal: signal },
                    ),
                options,
            );
            return {
                objects: (page.Contents ?? []).flatMap((entry) =>
                    entry.Key ? [{ key: entry.Key, modifiedAt: entry.LastModified ?? null }] : [],
                ),
                truncated: Boolean(page.IsTruncated),
            };
        },

        /*
         * Rewrites an object into another storage class in place; the bytes never
         * change. The store copies `size` bytes itself, and the deadline allows for them.
         */
        async setStorageClass(
            key: string,
            storageClass: string,
            { size = 0, ...options }: CallOptions & { size?: number } = {},
        ) {
            await call(
                size,
                (signal) =>
                    client.send(
                        new CopyObjectCommand({
                            Bucket,
                            Key: key,
                            CopySource: `/${Bucket}/${encodeURIComponent(key).replaceAll('%2F', '/')}`,
                            StorageClass: storageClass as StorageClass,
                            MetadataDirective: 'COPY',
                        }),
                        { abortSignal: signal },
                    ),
                options,
            );
        },

        /*
         * Copies an object from another store into this one; used by replication,
         * by the audit's healing and by the evidence copy.
         *
         * `size` is what the database says the object is, and bounds everything
         * read (2.4): the source must report exactly that size before a byte is
         * read (`size-mismatch`), and each range read is cut off at its own
         * length. Null is an object no row holds a size for any more (one purged
         * before its backup copy was made): the source's size is then taken, and
         * refused when it is nothing or above the largest object an upload can make.
         *
         * Up to one part's worth is read whole, so a digest can go with it;
         * anything larger goes over as a multipart upload, one range of the
         * source per part, each with its own digest. A verified copy sends those
         * SHA-256 digests as headers, which every store accepts and a bucket
         * under Object Lock (Backblaze) refuses to do without; clients here
         * compute no checksums of their own, since R2 rejects the SDK's streamed
         * ones.
         *
         * Every request is a call of its store's, the source's reads included:
         * each has its own total deadline and goes through that store's cap and
         * breaker.
         */
        async copyFrom(
            source: CopySource,
            key: string,
            targetKey = key,
            {
                size: expected,
                verified = false,
                partSize = COPY_PART_SIZE,
                ...options
            }: CallOptions & {
                size: bigint | number | null;
                verified?: boolean;
                partSize?: number;
            },
        ) {
            const found = await source.head(key, options);
            if (!found) throw new StoreAnswerError('not-found');
            const size = found.size;
            // A size that is no whole number of bytes is no size at all, whatever the row says.
            if (
                !Number.isSafeInteger(size) ||
                size < 0 ||
                (expected === null
                    ? size < 1 || size > MAX_OBJECT_BYTES
                    : BigInt(size) !== BigInt(expected))
            )
                throw new StoreAnswerError('size-mismatch');
            const digest = (bytes: Uint8Array) =>
                verified ? createHash('sha256').update(bytes).digest('base64') : undefined;
            if (size <= partSize) {
                const bytes = size
                    ? await source.read(key, 0, size - 1, options)
                    : new Uint8Array(0);
                await put(targetKey, bytes, { ...options, checksum: digest(bytes) });
                return;
            }
            const uploadId = await createMultipart(targetKey, options);
            try {
                const parts: { partNumber: number; etag: string; checksum?: string }[] = [];
                for (let from = 0, partNumber = 1; from < size; from += partSize, partNumber++) {
                    const bytes = await source.read(
                        key,
                        from,
                        Math.min(from + partSize, size) - 1,
                        options,
                    );
                    const checksum = digest(bytes);
                    const part = await call(
                        bytes.byteLength,
                        (signal) =>
                            client.send(
                                new UploadPartCommand({
                                    Bucket,
                                    Key: targetKey,
                                    UploadId: uploadId,
                                    PartNumber: partNumber,
                                    Body: bytes,
                                    ContentLength: bytes.byteLength,
                                    ChecksumSHA256: checksum,
                                }),
                                { abortSignal: signal },
                            ),
                        options,
                    );
                    if (!part.ETag) throw new Error('The store returned no part tag.');
                    parts.push({ partNumber, etag: part.ETag, checksum });
                }
                await call(
                    size,
                    (signal) =>
                        client.send(
                            new CompleteMultipartUploadCommand({
                                Bucket,
                                Key: targetKey,
                                UploadId: uploadId,
                                MultipartUpload: {
                                    Parts: parts.map((part) => ({
                                        PartNumber: part.partNumber,
                                        ETag: part.etag,
                                        ChecksumSHA256: part.checksum,
                                    })),
                                },
                            }),
                            { abortSignal: signal },
                        ),
                    options,
                );
            } catch (error) {
                // Under a deadline of its own: the one that ended the copy may be the caller's.
                await abortMultipart(targetKey, uploadId).catch(() => undefined);
                throw error;
            }
        },
    };
}

function statusOf(error: unknown) {
    return error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
}

/*
 * Which store, by the id an object, upload or outbox row carries
 * (docs/company-storage-design.md 2.2). Every read, signed URL, copy and
 * deletion goes through here with its row's `store_id`; nothing picks "the"
 * store any more.
 *
 * The environment's stores are rows with fixed ids and nothing in them: this
 * process fills them in from its own variables, so changing `STORAGE_*` changes
 * where the row points, as it always did. The web service holds no replica
 * variables and so cannot open the replica's row, exactly as before.
 *
 * A store this process cannot open fails that request (`StoreUnavailableError`)
 * and is never swapped for another one: signing a URL at the wrong bucket would
 * hand out a dead link, and deleting there would be worse. Stores added on the
 * page are `database` rows, opened with a sealing key from the environment;
 * until that exists every such id is unavailable here.
 */
const reportedUnavailable = new Set<string>();

export async function storeFor(storeId: string): Promise<ObjectStore> {
    if (storeId === ENVIRONMENT_PRIMARY_STORE_ID) return environmentPrimary();
    if (storeId === ENVIRONMENT_REPLICA_STORE_ID) {
        const store = replicaStore();
        if (store) return store;
    }
    // Once per store and process: the id and nothing about where it points.
    if (!reportedUnavailable.has(storeId)) {
        reportedUnavailable.add(storeId);
        log.error({ message: 'A store cannot be opened by this process', storeId });
    }
    throw new StoreUnavailableError(storeId);
}

let primary: ObjectStore | undefined;
function environmentPrimary() {
    primary ??= createObjectStore({
        id: ENVIRONMENT_PRIMARY_STORE_ID,
        endpoint: storageEnv.STORAGE_ENDPOINT,
        internalEndpoint: storageEnv.STORAGE_INTERNAL_ENDPOINT,
        region: storageEnv.STORAGE_REGION,
        bucket: storageEnv.STORAGE_BUCKET,
        accessKeyId: storageEnv.STORAGE_ACCESS_KEY_ID,
        secretAccessKey: storageEnv.STORAGE_SECRET_ACCESS_KEY,
        forcePathStyle: storageEnv.STORAGE_FORCE_PATH_STYLE,
    });
    return primary;
}

let replica: ObjectStore | null | undefined;
/*
 * The environment's replica, which is the default region's backup store. Null
 * when this process's environment does not describe one; the worker says so
 * once at start and records it on the row.
 */
export function replicaStore() {
    if (replica !== undefined) return replica;
    if (!replicaConfigured()) return (replica = null);
    const env = storageReplicaEnv;
    replica = createObjectStore({
        id: ENVIRONMENT_REPLICA_STORE_ID,
        endpoint: env.STORAGE_REPLICA_ENDPOINT!,
        region: env.STORAGE_REPLICA_REGION ?? 'auto',
        bucket: env.STORAGE_REPLICA_BUCKET!,
        accessKeyId: env.STORAGE_REPLICA_ACCESS_KEY_ID!,
        secretAccessKey: env.STORAGE_REPLICA_SECRET_ACCESS_KEY!,
        forcePathStyle: env.STORAGE_REPLICA_FORCE_PATH_STYLE,
    });
    return replica;
}

/* The evidence bucket is not a row (2.1); this is the id its breaker is kept under. */
export const EVIDENCE_STORE_ID = 'evidence';

let evidence: ObjectStore | null | undefined;
/* Null when no evidence bucket is configured; the worker says so once at start. */
export function evidenceStore() {
    if (evidence !== undefined) return evidence;
    if (!evidenceConfigured()) return (evidence = null);
    const env = storageEvidenceEnv;
    evidence = createObjectStore({
        id: EVIDENCE_STORE_ID,
        endpoint: env.STORAGE_EVIDENCE_ENDPOINT!,
        region: env.STORAGE_EVIDENCE_REGION ?? 'auto',
        bucket: env.STORAGE_EVIDENCE_BUCKET!,
        accessKeyId: env.STORAGE_EVIDENCE_ACCESS_KEY_ID!,
        secretAccessKey: env.STORAGE_EVIDENCE_SECRET_ACCESS_KEY!,
        forcePathStyle: env.STORAGE_EVIDENCE_FORCE_PATH_STYLE,
    });
    return evidence;
}
