import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * An S3-compatible store in this process, for tests: several buckets behind one
 * path-style endpoint, speaking the calls `createObjectStore` makes (multipart
 * uploads, HEAD, ranged GET, PUT, DELETE, ListObjectsV2 and an in-place
 * CopyObject) through the real SDK and real presigned URLs. It checks no
 * signature. What it holds is plain to read from the test, so a test can say
 * which bucket a byte went to, which is the point of having more than one.
 *
 * It can also misbehave on purpose (`hooks.hostile`): a test is handed the
 * response of any request and may never answer it, answer late, lie about a
 * size, or send bytes for ever (docs/company-storage-design.md 15, "a hostile
 * store").
 */

type Stored = { body: Buffer; modified: Date; storageClass: string };
type Upload = { bucket: string; key: string; parts: Map<number, Buffer> };
export type S3Request = {
    method: string;
    bucket: string;
    key: string;
    query: string;
    /* When it arrived, by `performance.now()`. */
    at: number;
    /* The `Range` header, when there was one. */
    range?: string;
};

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;
const etagOf = (body: Buffer) => `"${createHash('md5').update(body).digest('hex')}"`;

export async function startS3() {
    const buckets = new Map<string, Map<string, Stored>>();
    const uploads = new Map<string, Upload>();
    const requests: S3Request[] = [];
    const hooks: {
        /* Runs before a multipart upload is created: wait in it, or throw to have the store refuse. */
        beforeCreateMultipart?: (bucket: string, key: string) => Promise<void> | void;
        /* Runs before any request is served: return an HTTP status to have the store answer with that error instead. */
        refuse?: (request: S3Request) => number | undefined;
        /*
         * Runs before any request is served, with its response in hand. Return true (now or
         * later) and the store does nothing more with the request: whatever is or is not
         * written to `res` is the answer. Return false and the request is served honestly,
         * which after a wait is a store that is slow and right.
         */
        hostile?: (
            request: S3Request,
            res: ServerResponse,
            req: IncomingMessage,
        ) => boolean | Promise<boolean>;
    } = {};

    function fail(res: ServerResponse, status: number, code: string) {
        res.writeHead(status, { 'content-type': 'application/xml' });
        res.end(xml(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`));
    }

    async function bodyOf(req: IncomingMessage) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks);
    }

    async function handle(req: IncomingMessage, res: ServerResponse) {
        const url = new URL(req.url ?? '/', 'http://store.test');
        const [, bucketName = '', ...rest] = url.pathname.split('/');
        const key = decodeURIComponent(rest.join('/'));
        const query = url.searchParams;
        const method = req.method ?? 'GET';
        const request: S3Request = {
            method,
            bucket: bucketName,
            key,
            query: url.search,
            at: performance.now(),
            ...(req.headers.range ? { range: String(req.headers.range) } : {}),
        };
        requests.push(request);
        if (await hooks.hostile?.(request, res, req)) return;
        const refused = hooks.refuse?.(request);
        if (refused) {
            await bodyOf(req);
            if (method === 'HEAD') {
                res.writeHead(refused);
                return res.end();
            }
            return fail(res, refused, refused === 403 ? 'AccessDenied' : 'InternalError');
        }
        const bucket = buckets.get(bucketName);
        if (!bucket) return fail(res, 404, 'NoSuchBucket');
        const uploadId = query.get('uploadId');

        if (method === 'POST' && query.has('uploads')) {
            try {
                await hooks.beforeCreateMultipart?.(bucketName, key);
            } catch {
                return fail(res, 403, 'AccessDenied');
            }
            const id = randomUUID();
            uploads.set(id, { bucket: bucketName, key, parts: new Map() });
            res.writeHead(200, { 'content-type': 'application/xml' });
            return res.end(
                xml(
                    `<InitiateMultipartUploadResult><Bucket>${bucketName}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
                ),
            );
        }

        if (uploadId) {
            const upload = uploads.get(uploadId);
            if (!upload || upload.bucket !== bucketName || upload.key !== key) {
                await bodyOf(req);
                return fail(res, 404, 'NoSuchUpload');
            }
            if (method === 'PUT') {
                const body = await bodyOf(req);
                upload.parts.set(Number(query.get('partNumber')), body);
                res.writeHead(200, { etag: etagOf(body) });
                return res.end();
            }
            if (method === 'GET') {
                const parts = [...upload.parts.entries()].sort(([a], [b]) => a - b);
                res.writeHead(200, { 'content-type': 'application/xml' });
                return res.end(
                    xml(
                        `<ListPartsResult><Bucket>${bucketName}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId><IsTruncated>false</IsTruncated>${parts
                            .map(
                                ([number, body]) =>
                                    `<Part><PartNumber>${number}</PartNumber><ETag>${etagOf(body)}</ETag><Size>${body.length}</Size></Part>`,
                            )
                            .join('')}</ListPartsResult>`,
                    ),
                );
            }
            if (method === 'POST') {
                const listed = [...(await bodyOf(req)).toString().matchAll(/<PartNumber>(\d+)</g)];
                const body = Buffer.concat(
                    listed.map(([, number]) => upload.parts.get(Number(number)) ?? Buffer.alloc(0)),
                );
                bucket.set(key, { body, modified: new Date(), storageClass: 'STANDARD' });
                uploads.delete(uploadId);
                res.writeHead(200, { 'content-type': 'application/xml' });
                return res.end(
                    xml(
                        `<CompleteMultipartUploadResult><Bucket>${bucketName}</Bucket><Key>${key}</Key><ETag>${etagOf(body)}</ETag></CompleteMultipartUploadResult>`,
                    ),
                );
            }
            if (method === 'DELETE') {
                uploads.delete(uploadId);
                res.writeHead(204);
                return res.end();
            }
        }

        if (method === 'GET' && query.get('list-type') === '2') {
            const prefix = query.get('prefix') ?? '';
            const after = query.get('start-after') ?? '';
            const max = Number(query.get('max-keys') ?? 1000);
            const keys = [...bucket.keys()]
                .filter((name) => name.startsWith(prefix) && name > after)
                .sort();
            const page = keys.slice(0, max);
            res.writeHead(200, { 'content-type': 'application/xml' });
            return res.end(
                xml(
                    `<ListBucketResult><Name>${bucketName}</Name><Prefix>${prefix}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${keys.length > page.length}</IsTruncated>${page
                        .map((name) => {
                            const stored = bucket.get(name)!;
                            return `<Contents><Key>${name}</Key><LastModified>${stored.modified.toISOString()}</LastModified><ETag>${etagOf(stored.body)}</ETag><Size>${stored.body.length}</Size><StorageClass>${stored.storageClass}</StorageClass></Contents>`;
                        })
                        .join('')}</ListBucketResult>`,
                ),
            );
        }

        const stored = bucket.get(key);
        if (method === 'HEAD' || method === 'GET') {
            if (!stored) {
                if (method === 'HEAD') {
                    res.writeHead(404);
                    return res.end();
                }
                return fail(res, 404, 'NoSuchKey');
            }
            const headers = {
                etag: etagOf(stored.body),
                'last-modified': stored.modified.toUTCString(),
                'accept-ranges': 'bytes',
            };
            const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
            if (method === 'GET' && range) {
                const from = Number(range[1]);
                const to = Math.min(Number(range[2]), stored.body.length - 1);
                const slice = stored.body.subarray(from, to + 1);
                res.writeHead(206, {
                    ...headers,
                    'content-length': slice.length,
                    'content-range': `bytes ${from}-${to}/${stored.body.length}`,
                });
                return res.end(slice);
            }
            res.writeHead(200, { ...headers, 'content-length': stored.body.length });
            return res.end(method === 'HEAD' ? undefined : stored.body);
        }
        if (method === 'PUT') {
            const body = await bodyOf(req);
            // An in-place copy is how an object changes storage class; nothing else copies here.
            if (req.headers['x-amz-copy-source']) {
                if (!stored) return fail(res, 404, 'NoSuchKey');
                stored.storageClass = String(req.headers['x-amz-storage-class'] ?? 'STANDARD');
                res.writeHead(200, { 'content-type': 'application/xml' });
                return res.end(
                    xml(
                        `<CopyObjectResult><ETag>${etagOf(stored.body)}</ETag><LastModified>${stored.modified.toISOString()}</LastModified></CopyObjectResult>`,
                    ),
                );
            }
            bucket.set(key, { body, modified: new Date(), storageClass: 'STANDARD' });
            res.writeHead(200, { etag: etagOf(body) });
            return res.end();
        }
        if (method === 'DELETE') {
            bucket.delete(key);
            res.writeHead(204);
            return res.end();
        }
        return fail(res, 405, 'MethodNotAllowed');
    }

    const server = createServer((req, res) => {
        handle(req, res).catch(() => {
            if (!res.headersSent) fail(res, 500, 'InternalError');
            else res.end();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}`,
        hooks,
        requests,
        /* Creates the bucket, or empties nothing if it is there, and returns its name. */
        bucket(name: string) {
            if (!buckets.has(name)) buckets.set(name, new Map());
            return name;
        },
        /* An object's bytes in `bucket`, or null. */
        get(bucket: string, key: string) {
            return buckets.get(bucket)?.get(key)?.body ?? null;
        },
        storageClass(bucket: string, key: string) {
            return buckets.get(bucket)?.get(key)?.storageClass ?? null;
        },
        /* Puts an object straight into `bucket`, as if it had been there since `modified`. */
        put(bucket: string, key: string, body: Buffer, modified = new Date()) {
            buckets.get(bucket)!.set(key, { body, modified, storageClass: 'STANDARD' });
        },
        remove(bucket: string, key: string) {
            buckets.get(bucket)?.delete(key);
        },
        keys(bucket: string) {
            return [...(buckets.get(bucket)?.keys() ?? [])].sort();
        },
        /* The multipart uploads started and neither completed nor aborted, in `bucket`. */
        openUploads(bucket: string) {
            return [...uploads.entries()]
                .filter(([, upload]) => upload.bucket === bucket)
                .map(([id, upload]) => ({ id, key: upload.key }));
        },
        /* Empties every bucket and forgets every upload, request and hook. */
        reset() {
            for (const bucket of buckets.values()) bucket.clear();
            uploads.clear();
            requests.length = 0;
            hooks.beforeCreateMultipart = undefined;
            hooks.refuse = undefined;
            hooks.hostile = undefined;
        },
        async stop() {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
