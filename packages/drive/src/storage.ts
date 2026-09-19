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
import {
    evidenceConfigured,
    replicaConfigured,
    storageEnv,
    storageEvidenceEnv,
    storageReplicaEnv,
} from '@hushos/env/storage';

/*
 * The object store, through the S3 API every candidate speaks: MinIO locally, R2
 * hosted, B2 as the replica. Object keys carry no information ("ws/{ws}/{object}")
 * and the store only ever holds ciphertext. Nothing here knows about the tree.
 *
 * Every part URL is signed with the exact Content-Length the server derived from
 * the plaintext size, so the store refuses a part of any other length; the
 * reservation bounds what the store accepts, not only what the database admits.
 */

export type StoreConfig = {
    /* The endpoint presigned URLs name: what a browser can reach. */
    endpoint: string;
    /* Where this process reaches the store, when that is a different address (Compose's `minio`). */
    internalEndpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
};

export type ObjectStore = ReturnType<typeof createObjectStore>;
type StoreHandle = { client: S3Client; bucket: string };

/* A copy moves in parts of this size: held in memory one at a time, above the 5 MiB minimum and well under any single-put limit. */
export const COPY_PART_SIZE = 64 * 1024 * 1024;

export function objectKey(workspaceId: string, objectId: string) {
    return `ws/${workspaceId}/${objectId}`;
}

export function createObjectStore(config: StoreConfig) {
    const clientFor = (endpoint: string) =>
        new S3Client({
            endpoint,
            region: config.region,
            forcePathStyle: config.forcePathStyle,
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
            },
            // R2 and MinIO reject the SDK's default CRC checksums on presigned and
            // multipart requests; the object is verified by size and by decryption.
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
        });
    // The server talks to the store at the internal address; a signature names the
    // host the browser will use, so presigned URLs come from a client on the public one.
    const client = clientFor(config.internalEndpoint ?? config.endpoint);
    const signer = config.internalEndpoint ? clientFor(config.endpoint) : client;
    const Bucket = config.bucket;

    async function head(key: string) {
        try {
            const result = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
            return { size: result.ContentLength ?? 0 };
        } catch (error) {
            if (error instanceof NotFound || statusOf(error) === 404) return null;
            throw error;
        }
    }

    return {
        bucket: Bucket,
        client,

        async createMultipart(key: string) {
            const result = await client.send(
                new CreateMultipartUploadCommand({ Bucket, Key: key }),
            );
            if (!result.UploadId) throw new Error('The store returned no upload id.');
            return result.UploadId;
        },

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

        async listParts(key: string, uploadId: string) {
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

        /*
         * Finishes the multipart upload and returns the stored size. `NoSuchUpload`
         * with the object present is a retry after an earlier success and is treated
         * as one; without the object it is reported as null.
         */
        async completeMultipart(
            key: string,
            uploadId: string,
            parts: { partNumber: number; etag: string }[],
        ) {
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
                );
            } catch (error) {
                if (!(error instanceof NoSuchUpload)) throw error;
            }
            return head(key);
        },

        async abortMultipart(key: string, uploadId: string) {
            try {
                await client.send(
                    new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }),
                );
            } catch (error) {
                if (!(error instanceof NoSuchUpload)) throw error;
            }
        },

        head,

        presignGet(key: string, ttl: number) {
            return getSignedUrl(signer, new GetObjectCommand({ Bucket, Key: key }), {
                expiresIn: ttl,
            });
        },

        async delete(key: string) {
            await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
        },

        /*
         * One page of keys under `prefix` after `startAfter`, in key order, with
         * when the store last wrote each; used by the orphan sweep and nothing else.
         */
        async list(prefix: string, startAfter: string | null, max = 1000) {
            const page = await client.send(
                new ListObjectsV2Command({
                    Bucket,
                    Prefix: prefix,
                    StartAfter: startAfter ?? undefined,
                    MaxKeys: max,
                }),
            );
            return {
                objects: (page.Contents ?? []).flatMap((entry) =>
                    entry.Key ? [{ key: entry.Key, modifiedAt: entry.LastModified ?? null }] : [],
                ),
                truncated: Boolean(page.IsTruncated),
            };
        },

        /* Rewrites an object into another storage class in place; the bytes never change. */
        async setStorageClass(key: string, storageClass: string) {
            await client.send(
                new CopyObjectCommand({
                    Bucket,
                    Key: key,
                    CopySource: `/${Bucket}/${encodeURIComponent(key).replaceAll('%2F', '/')}`,
                    StorageClass: storageClass as StorageClass,
                    MetadataDirective: 'COPY',
                }),
            );
        },

        /*
         * Copies an object from another store into this one; used by replication
         * and by the evidence copy. Up to one part's worth is read whole, so a
         * digest can go with it; anything larger goes over as a multipart upload,
         * one range of the source per part, each with its own digest. A verified
         * copy sends those SHA-256 digests as headers, which every store accepts
         * and a bucket under Object Lock (Backblaze) refuses to do without;
         * clients here compute no checksums of their own, since R2 and MinIO
         * reject the SDK's streamed ones.
         */
        async copyFrom(
            source: StoreHandle,
            key: string,
            targetKey = key,
            {
                verified = false,
                partSize = COPY_PART_SIZE,
            }: { verified?: boolean; partSize?: number } = {},
        ) {
            const head = await source.client.send(
                new HeadObjectCommand({ Bucket: source.bucket, Key: key }),
            );
            const size = head.ContentLength ?? 0;
            const read = async (from: number, to: number) => {
                const object = await source.client.send(
                    new GetObjectCommand({
                        Bucket: source.bucket,
                        Key: key,
                        Range: `bytes=${from}-${to}`,
                    }),
                );
                if (!object.Body) throw new Error('The source object has no body.');
                return object.Body.transformToByteArray();
            };
            const digest = (bytes: Uint8Array) =>
                verified ? createHash('sha256').update(bytes).digest('base64') : undefined;
            if (size <= partSize) {
                const bytes = await read(0, Math.max(size - 1, 0));
                await client.send(
                    new PutObjectCommand({
                        Bucket,
                        Key: targetKey,
                        Body: bytes,
                        ContentLength: bytes.byteLength,
                        ChecksumSHA256: digest(bytes),
                    }),
                );
                return;
            }
            const uploadId = await this.createMultipart(targetKey);
            try {
                const parts: { partNumber: number; etag: string; checksum?: string }[] = [];
                for (let from = 0, partNumber = 1; from < size; from += partSize, partNumber++) {
                    const bytes = await read(from, Math.min(from + partSize, size) - 1);
                    const checksum = digest(bytes);
                    const part = await client.send(
                        new UploadPartCommand({
                            Bucket,
                            Key: targetKey,
                            UploadId: uploadId,
                            PartNumber: partNumber,
                            Body: bytes,
                            ContentLength: bytes.byteLength,
                            ChecksumSHA256: checksum,
                        }),
                    );
                    if (!part.ETag) throw new Error('The store returned no part tag.');
                    parts.push({ partNumber, etag: part.ETag, checksum });
                }
                await client.send(
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
                );
            } catch (error) {
                await this.abortMultipart(targetKey, uploadId).catch(() => undefined);
                throw error;
            }
        },
    };
}

function statusOf(error: unknown) {
    return error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
}

let primary: ObjectStore | undefined;
export function primaryStore() {
    primary ??= createObjectStore({
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
/* Null when no replica is configured; the worker says so once at start. */
export function replicaStore() {
    if (replica !== undefined) return replica;
    if (!replicaConfigured()) return (replica = null);
    const env = storageReplicaEnv;
    replica = createObjectStore({
        endpoint: env.STORAGE_REPLICA_ENDPOINT!,
        region: env.STORAGE_REPLICA_REGION ?? 'auto',
        bucket: env.STORAGE_REPLICA_BUCKET!,
        accessKeyId: env.STORAGE_REPLICA_ACCESS_KEY_ID!,
        secretAccessKey: env.STORAGE_REPLICA_SECRET_ACCESS_KEY!,
        forcePathStyle: env.STORAGE_REPLICA_FORCE_PATH_STYLE,
    });
    return replica;
}

let evidence: ObjectStore | null | undefined;
/* Null when no evidence bucket is configured; the worker says so once at start. */
export function evidenceStore() {
    if (evidence !== undefined) return evidence;
    if (!evidenceConfigured()) return (evidence = null);
    const env = storageEvidenceEnv;
    evidence = createObjectStore({
        endpoint: env.STORAGE_EVIDENCE_ENDPOINT!,
        region: env.STORAGE_EVIDENCE_REGION ?? 'auto',
        bucket: env.STORAGE_EVIDENCE_BUCKET!,
        accessKeyId: env.STORAGE_EVIDENCE_ACCESS_KEY_ID!,
        secretAccessKey: env.STORAGE_EVIDENCE_SECRET_ACCESS_KEY!,
        forcePathStyle: env.STORAGE_EVIDENCE_FORCE_PATH_STYLE,
    });
    return evidence;
}
