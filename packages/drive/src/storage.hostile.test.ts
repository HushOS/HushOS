import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { type S3Request, startS3 } from '../test/s3-server';

/*
 * What a store may do to the server (docs/company-storage-design.md 2.4, and
 * "a hostile store" in its section 15). The store is an S3 server in this
 * process that misbehaves on purpose, reached through the real SDK, so what is
 * measured is what the worker and the web process would do: when a call ends,
 * how many requests went out, how many bytes were taken.
 *
 * The bounds are the production ones scaled down (a 400 ms deadline for 60 s),
 * never slept through in seconds. Upper limits leave room for a loaded runner;
 * lower limits do not, since ending early would be a defect of its own.
 */

const s3 = await startS3();
const HOSTILE = s3.bucket('hostile');
const HONEST = s3.bucket('honest');
const TARGET = s3.bucket('target');
Object.assign(process.env, {
    STORAGE_ENDPOINT: s3.url,
    STORAGE_BUCKET: HONEST,
    STORAGE_ACCESS_KEY_ID: 'test-key-id',
    STORAGE_SECRET_ACCESS_KEY: 'test-secret-value',
    STORAGE_FORCE_PATH_STYLE: 'true',
});

const { createObjectStore, MAX_OBJECT_BYTES, StoreAnswerError, StoreDeadlineError } =
    await import('./storage');
const { StoreUnavailableError } = await import('./bounds');

const CALL = 400;
const SLACK = 400;
/* Fast enough that the allowance for a test's few bytes is nothing: the deadline is CALL. */
const BOUNDS = {
    connectMs: 200,
    idleMs: 5_000,
    callMs: CALL,
    bytesPerSecond: 1024 * 1024 * 1024,
    breakerOpenMs: 300,
    slowMs: 300,
};
type Bounds = Partial<typeof BOUNDS> & { answerBytes?: number };

const storeAt = (bucket: string, bounds: Bounds = {}, cap?: number) =>
    createObjectStore({
        endpoint: s3.url,
        region: 'auto',
        bucket,
        accessKeyId: 'test-key-id',
        secretAccessKey: 'test-secret-value',
        forcePathStyle: true,
        cap,
        bounds: { ...BOUNDS, ...bounds },
    });

const KEY = 'ws/00000000-0000-4000-8000-00000000000a/00000000-0000-4000-8000-00000000000b';
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const requestsTo = (bucket: string, method?: string) =>
    s3.requests.filter(
        (request) => request.bucket === bucket && (!method || request.method === method),
    );

/* How a call ended and how long it took. */
async function timed<T>(call: Promise<T>) {
    const started = performance.now();
    const outcome = await call.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
    );
    return { ...outcome, started, took: performance.now() - started };
}

/* Only requests to the hostile bucket are tampered with; every other bucket is an honest store. */
function hostile(
    answer: (request: S3Request, res: ServerResponse) => boolean | Promise<boolean>,
    bucket = HOSTILE,
) {
    s3.hooks.hostile = (request, res) => (request.bucket === bucket ? answer(request, res) : false);
}
const never = () => true;
const failing = (_request: S3Request, res: ServerResponse) => {
    res.writeHead(500, { 'content-type': 'application/xml' });
    res.end('<Error><Code>InternalError</Code><Message>down</Message></Error>');
    return true;
};

beforeEach(() => {
    s3.reset();
});
afterAll(async () => {
    await s3.stop();
});

describe('a total deadline', () => {
    test('ends a call to a store that accepts the connection and never answers', async () => {
        hostile(never);
        const { error, took } = await timed(storeAt(HOSTILE).head(KEY));
        expect(error).toBeInstanceOf(StoreDeadlineError);
        expect(took).toBeGreaterThanOrEqual(CALL - 5);
        expect(took).toBeLessThan(CALL + SLACK);
    });

    test('is not an AbortError, which is a client that went away, and carries nothing of the store', async () => {
        hostile(never);
        const { error } = await timed(storeAt(HOSTILE).delete(KEY));
        expect((error as Error).name).toBe('StoreDeadlineError');
        expect(JSON.stringify(error) + String(error)).not.toMatch(/127\.0\.0\.1|hostile|test-key/);
    });

    test('ends a call whose answer comes after it, however right that answer is', async () => {
        s3.put(HOSTILE, KEY, randomBytes(32));
        hostile(async () => {
            await wait(CALL + 250);
            return false;
        });
        const { error, took } = await timed(storeAt(HOSTILE).head(KEY));
        expect(error).toBeInstanceOf(StoreDeadlineError);
        expect(took).toBeLessThan(CALL + 200);
    });

    test('covers the SDK’s retries: a store that fails slowly is cut off in its second attempt, and a third is never sent', async () => {
        // A longer deadline than the other tests', so the SDK's own wait before a retry (under
        // 100 ms) always fits. Each attempt is answered with a 500 after 60% of it: three
        // attempts would take 180%.
        const LONG = 800;
        hostile(async (request, res) => {
            await wait(LONG * 0.6);
            return failing(request, res);
        });
        const { error, took, started } = await timed(storeAt(HOSTILE, { callMs: LONG }).head(KEY));
        expect(error).toBeInstanceOf(StoreDeadlineError);
        expect(took).toBeGreaterThanOrEqual(LONG - 5);
        expect(took).toBeLessThan(LONG + SLACK);
        expect(requestsTo(HOSTILE)).toHaveLength(2);
        // The retry the SDK had left is not made once the caller has its answer.
        await wait(LONG / 2);
        expect(requestsTo(HOSTILE)).toHaveLength(2);
        for (const request of requestsTo(HOSTILE)) expect(request.at - started).toBeLessThan(LONG);
    });

    test('with attempts that each time out idle, no attempt begins after the deadline', async () => {
        hostile(never);
        const { error, took, started } = await timed(storeAt(HOSTILE, { idleMs: 150 }).head(KEY));
        expect(error).toBeInstanceOf(StoreDeadlineError);
        expect(took).toBeLessThan(CALL + SLACK);
        // The idle timeout did give the store a second attempt inside the deadline.
        expect(requestsTo(HOSTILE).length).toBeGreaterThanOrEqual(2);
        const sent = requestsTo(HOSTILE).length;
        await wait(CALL);
        expect(requestsTo(HOSTILE)).toHaveLength(sent);
        for (const request of requestsTo(HOSTILE))
            expect(request.at - started).toBeLessThan(CALL + 100);
    });

    test('lets a store that fails twice and then answers finish inside one call', async () => {
        s3.put(HOSTILE, KEY, randomBytes(48));
        let failures = 2;
        hostile((request, res) => (failures-- > 0 ? failing(request, res) : false));
        const store = storeAt(HOSTILE, { callMs: 5_000 });
        expect(await store.head(KEY)).toEqual({ size: 48 });
        expect(requestsTo(HOSTILE)).toHaveLength(3);
        expect(store.health()).toBe('ok');
    });

    test('covers every page of a part list, not each page', async () => {
        // A store that says there is always another page, 60% of the deadline apart.
        hostile(async (_request, res) => {
            await wait(CALL * 0.6);
            res.writeHead(200, { 'content-type': 'application/xml' });
            res.end(
                '<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>1</NextPartNumberMarker><Part><PartNumber>1</PartNumber><ETag>"e"</ETag><Size>5</Size></Part></ListPartsResult>',
            );
            return true;
        });
        const { error, took } = await timed(storeAt(HOSTILE).listParts(KEY, 'upload-id'));
        expect(error).toBeInstanceOf(StoreDeadlineError);
        expect(took).toBeLessThan(CALL + SLACK);
    });

    test('allows for the bytes a call expects: a slow, honest read of a large range is not cut off at the base deadline', async () => {
        const bytes = randomBytes(600);
        s3.put(HOSTILE, KEY, bytes);
        // 600 bytes in six pieces over 1.5 times the base deadline, at a rate the store's bounds accept.
        hostile((_request, res) => {
            res.writeHead(206, { 'content-length': 600 });
            let sent = 0;
            const timer = setInterval(() => {
                res.write(bytes.subarray(sent, sent + 100));
                sent += 100;
                if (sent >= 600) {
                    clearInterval(timer);
                    res.end();
                }
            }, CALL / 4);
            res.on('close', () => clearInterval(timer));
            return true;
        });
        // 1000 bytes a second: 600 bytes are allowed 600 ms beyond the base.
        const store = storeAt(HOSTILE, { bytesPerSecond: 1000 });
        const { value, took } = await timed(store.read(KEY, 0, 599));
        expect(Buffer.from(value!).equals(bytes)).toBe(true);
        expect(took).toBeGreaterThan(CALL);
    });
    test('allows a completion the bytes the store assembles: one that takes longer than the base deadline over a large object is waited for', async () => {
        // A store that takes 1.5 times the base deadline to put an object together, and then has it.
        const assembling = (uploads: Set<string>) =>
            hostile(async (request) => {
                if (request.method === 'POST' && uploads.has(request.query)) await wait(CALL * 1.5);
                return false;
            });
        const store = storeAt(HOSTILE, { bytesPerSecond: 1000 });
        const part = randomBytes(600);
        const begun = async (key: string) => {
            const uploadId = await store.createMultipart(key);
            const url = await store.presignPart(key, uploadId, 1, part.length, 60);
            const put = await fetch(url, { method: 'PUT', body: new Uint8Array(part) });
            return { uploadId, parts: [{ partNumber: 1, etag: put.headers.get('etag')! }] };
        };
        const large = await begun(KEY);
        const unsized = await begun(`${KEY}-unsized`);
        assembling(new Set([`?uploadId=${large.uploadId}`, `?uploadId=${unsized.uploadId}`]));

        // Told the object is 600 bytes, at 1000 bytes a second the call may take 600 ms more.
        expect(
            await store.completeMultipart(KEY, large.uploadId, large.parts, { size: 600 }),
        ).toEqual({ size: 600 });
        // Told nothing, it has the base deadline and no more.
        const { error, took } = await timed(
            store.completeMultipart(`${KEY}-unsized`, unsized.uploadId, unsized.parts),
        );
        expect(error).toBeInstanceOf(StoreDeadlineError);
        expect(took).toBeLessThan(CALL + SLACK);
    });
});

describe('a read is bounded by what was asked for', () => {
    test('an honest range comes back whole and exact', async () => {
        const bytes = randomBytes(4096);
        s3.put(HONEST, KEY, bytes);
        const read = await storeAt(HONEST).read(KEY, 100, 1123);
        expect(Buffer.from(read).equals(bytes.subarray(100, 1124))).toBe(true);
        expect(requestsTo(HONEST, 'GET')[0]!.range).toBe('bytes=100-1123');
    });

    test('a ranged answer longer than the range is an error, not a longer buffer', async () => {
        hostile((_request, res) => {
            res.writeHead(206, { 'content-length': 1024 + 1 });
            res.end(Buffer.alloc(1024 + 1, 7));
            return true;
        });
        const { error } = await timed(storeAt(HOSTILE).read(KEY, 0, 1023));
        expect(error).toBeInstanceOf(StoreAnswerError);
        expect(error).toMatchObject({ code: 'too-long' });
    });

    test('a store that streams for ever is cut off after the range’s length, and its connection closed', async () => {
        let written = 0;
        let closedAt: number | null = null;
        hostile((_request, res) => {
            res.writeHead(206, {});
            const piece = Buffer.alloc(64 * 1024, 9);
            const timer = setInterval(() => {
                written += piece.length;
                res.write(piece);
            }, 1);
            res.on('close', () => {
                clearInterval(timer);
                closedAt = performance.now();
            });
            return true;
        });
        const { error, took, started } = await timed(
            storeAt(HOSTILE).read(KEY, 0, 1024 * 1024 - 1),
        );
        expect(error).toMatchObject({ name: 'StoreAnswerError', code: 'too-long' });
        // Long before the deadline: at the first byte past the megabyte asked for.
        expect(took).toBeLessThan(CALL);
        await wait(100);
        expect(closedAt).not.toBeNull();
        expect(closedAt! - started).toBeLessThan(CALL);
        // The store was stopped, not drained: what it got out is the range and some buffers, not a stream.
        expect(written).toBeLessThan(16 * 1024 * 1024);
    });

    test('an answer that ends before the range does is an error, never a short buffer', async () => {
        hostile((_request, res) => {
            res.writeHead(206, { 'content-length': 1000 });
            res.end(Buffer.alloc(1000, 5));
            return true;
        });
        const { error } = await timed(storeAt(HOSTILE).read(KEY, 0, 1023));
        expect(error).toMatchObject({ name: 'StoreAnswerError', code: 'too-short' });
    });

    test('a connection dropped mid-body is an error, never the bytes so far', async () => {
        hostile((_request, res) => {
            res.writeHead(206, { 'content-length': 1024 });
            res.write(Buffer.alloc(1000, 5));
            setTimeout(() => res.destroy(), 20);
            return true;
        });
        const { error, value } = await timed(storeAt(HOSTILE).read(KEY, 0, 1023));
        expect(value).toBeUndefined();
        expect(error).toBeInstanceOf(Error);
    });

    test('a store that trickles a byte at a time is cut off at the total deadline', async () => {
        let closed = false;
        hostile((_request, res) => {
            res.writeHead(206, { 'content-length': 1024 });
            const timer = setInterval(() => res.write(Buffer.alloc(1, 1)), 25);
            res.on('close', () => {
                clearInterval(timer);
                closed = true;
            });
            return true;
        });
        const { error, took } = await timed(storeAt(HOSTILE).read(KEY, 0, 1023));
        expect(error).toBeInstanceOf(StoreDeadlineError);
        expect(took).toBeGreaterThanOrEqual(CALL - 5);
        expect(took).toBeLessThan(CALL + SLACK);
        await wait(50);
        expect(closed).toBe(true);
    });

    test('a body that stalls is cut off by the idle limit, before the deadline', async () => {
        hostile((_request, res) => {
            res.writeHead(206, { 'content-length': 1024 });
            res.write(Buffer.alloc(100, 1));
            return true;
        });
        const store = storeAt(HOSTILE, { callMs: 3_000, idleMs: 150 });
        const { error, took } = await timed(store.read(KEY, 0, 1023));
        expect(error).toBeInstanceOf(Error);
        expect(took).toBeLessThan(1_500);
    });

    test('a listing longer than the limit is refused, and an endless one is closed, not collected', async () => {
        const entry = `<Contents><Key>ws/${'k'.repeat(100)}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`;
        let closed = false;
        let written = 0;
        hostile((_request, res) => {
            res.writeHead(200, { 'content-type': 'application/xml' });
            res.write('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>');
            const timer = setInterval(() => {
                for (let i = 0; i < 20; i++) {
                    written += entry.length;
                    res.write(entry);
                }
            }, 1);
            res.on('close', () => {
                clearInterval(timer);
                closed = true;
            });
            return true;
        });
        const { error, took } = await timed(
            storeAt(HOSTILE, { answerBytes: 64 * 1024 }).list('ws/', null),
        );
        expect(error).toMatchObject({ name: 'StoreAnswerError', code: 'too-long' });
        expect(took).toBeLessThan(CALL);
        await wait(50);
        expect(closed).toBe(true);
        expect(written).toBeLessThan(8 * 1024 * 1024);
    });

    test('an honest page of a thousand of our keys is well inside the production limit', async () => {
        for (let i = 0; i < 1000; i++)
            s3.put(
                HONEST,
                `ws/00000000-0000-4000-8000-00000000000a/${String(i).padStart(36, '0')}`,
                Buffer.alloc(1),
            );
        // No answerBytes here: the limit is the deployment's 1 MiB.
        const page = await storeAt(HONEST).list('ws/', null, 1000);
        expect(page.objects).toHaveLength(1000);
    });

    test('an error body is read to the limit and no further', async () => {
        let closed = false;
        hostile((_request, res) => {
            res.writeHead(403, { 'content-type': 'application/xml' });
            res.write('<Error><Code>AccessDenied</Code><Message>');
            const timer = setInterval(() => res.write('x'.repeat(16 * 1024)), 1);
            res.on('close', () => {
                clearInterval(timer);
                closed = true;
            });
            return true;
        });
        const { error, took } = await timed(
            storeAt(HOSTILE, { answerBytes: 64 * 1024 }).createMultipart(KEY),
        );
        expect(error).toBeInstanceOf(Error);
        expect(took).toBeLessThan(CALL);
        await wait(50);
        expect(closed).toBe(true);
    });
});

describe('a copy is bounded by the row’s size', () => {
    const SIZE = 1000;

    test('a source that reports a larger size than the row fails the copy before any byte is read, and the target receives nothing', async () => {
        s3.put(HOSTILE, KEY, randomBytes(SIZE + 1));
        const { error } = await timed(
            storeAt(TARGET).copyFrom(storeAt(HOSTILE), KEY, KEY, { size: BigInt(SIZE) }),
        );
        expect(error).toMatchObject({ name: 'StoreAnswerError', code: 'size-mismatch' });
        expect(requestsTo(HOSTILE, 'GET')).toEqual([]);
        expect(requestsTo(TARGET)).toEqual([]);
        expect(s3.keys(TARGET)).toEqual([]);
    });

    test('a source that reports a smaller size is refused the same way: a truncated object is not copied as if whole', async () => {
        s3.put(HOSTILE, KEY, randomBytes(SIZE - 1));
        const { error } = await timed(
            storeAt(TARGET).copyFrom(storeAt(HOSTILE), KEY, KEY, { size: SIZE }),
        );
        expect(error).toMatchObject({ code: 'size-mismatch' });
        expect(requestsTo(HOSTILE, 'GET')).toEqual([]);
        expect(s3.keys(TARGET)).toEqual([]);
    });

    test('a source that says the right size and then sends more is cut off, and nothing is left at the target', async () => {
        s3.put(HOSTILE, KEY, randomBytes(SIZE));
        hostile((request, res) => {
            if (request.method !== 'GET') return false;
            res.writeHead(206, {});
            const timer = setInterval(() => res.write(Buffer.alloc(4096, 3)), 1);
            res.on('close', () => clearInterval(timer));
            return true;
        });
        // Four parts of 300 bytes: a multipart copy, so there is an upload to leave behind.
        const { error } = await timed(
            storeAt(TARGET).copyFrom(storeAt(HOSTILE), KEY, KEY, { size: SIZE, partSize: 300 }),
        );
        expect(error).toMatchObject({ code: 'too-long' });
        expect(s3.keys(TARGET)).toEqual([]);
        expect(s3.openUploads(TARGET)).toEqual([]);
    });

    test('every range asked for is derived from the row’s size, part by part, and the copy is byte for byte', async () => {
        const bytes = randomBytes(SIZE);
        s3.put(HONEST, KEY, bytes);
        await storeAt(TARGET).copyFrom(storeAt(HONEST), KEY, 'copies/one', {
            size: SIZE,
            partSize: 300,
        });
        expect(requestsTo(HONEST, 'GET').map((request) => request.range)).toEqual([
            'bytes=0-299',
            'bytes=300-599',
            'bytes=600-899',
            'bytes=900-999',
        ]);
        expect(s3.get(TARGET, 'copies/one')!.equals(bytes)).toBe(true);
    });

    test('an object that is not at the source is not-found, and is not created empty at the target', async () => {
        const { error } = await timed(
            storeAt(TARGET).copyFrom(storeAt(HONEST), KEY, KEY, { size: SIZE }),
        );
        expect(error).toMatchObject({ name: 'StoreAnswerError', code: 'not-found' });
        expect(s3.keys(TARGET)).toEqual([]);
    });

    test('with no row left to say the size, the source’s own is taken up to the largest object an upload can make, and refused above it', async () => {
        const bytes = randomBytes(SIZE);
        s3.put(HONEST, KEY, bytes);
        await storeAt(TARGET).copyFrom(storeAt(HONEST), KEY, KEY, { size: null });
        expect(s3.get(TARGET, KEY)!.equals(bytes)).toBe(true);

        s3.put(HOSTILE, KEY, bytes);
        hostile((request, res) => {
            if (request.method !== 'HEAD') return false;
            res.writeHead(200, { 'content-length': MAX_OBJECT_BYTES + 1 });
            res.end();
            return true;
        });
        const { error } = await timed(
            storeAt(TARGET).copyFrom(storeAt(HOSTILE), KEY, 'copies/two', { size: null }),
        );
        expect(error).toMatchObject({ code: 'size-mismatch' });
        expect(requestsTo(HOSTILE, 'GET')).toEqual([]);
        expect(s3.get(TARGET, 'copies/two')).toBeNull();

        // Nor is "no length at all" a size: an empty object is never a copy of anything.
        hostile((request, res) => {
            if (request.method !== 'HEAD') return false;
            res.writeHead(200, {});
            res.end();
            return true;
        });
        const empty = await timed(
            storeAt(TARGET).copyFrom(storeAt(HOSTILE), KEY, 'copies/three', { size: null }),
        );
        expect(empty.error).toMatchObject({ code: 'size-mismatch' });
        expect(s3.get(TARGET, 'copies/three')).toBeNull();
    });

    test('a copy’s reads are the source’s calls: a source that never answers costs its own deadline and opens its own breaker, not the target’s', async () => {
        hostile(never);
        const source = storeAt(HOSTILE, { callMs: 100 });
        const target = storeAt(TARGET);
        for (let i = 0; i < 5; i++) {
            const { error, took } = await timed(target.copyFrom(source, KEY, KEY, { size: SIZE }));
            expect(error).toBeInstanceOf(StoreDeadlineError);
            expect(took).toBeLessThan(100 + SLACK);
        }
        expect(source.health()).toBe('open');
        expect(target.health()).toBe('ok');
        const sent = requestsTo(HOSTILE).length;
        const { error } = await timed(target.copyFrom(source, KEY, KEY, { size: SIZE }));
        expect(error).toBeInstanceOf(StoreUnavailableError);
        expect(requestsTo(HOSTILE)).toHaveLength(sent);
    });
});

describe('the breaker of a store', () => {
    test('five failures open it: calls then answer unavailable without a request, and another store is unaffected', async () => {
        s3.put(HONEST, KEY, randomBytes(16));
        hostile(never);
        const down = storeAt(HOSTILE, { callMs: 80 });
        const well = storeAt(HONEST);
        for (let i = 0; i < 5; i++)
            expect((await timed(down.head(KEY))).error).toBeInstanceOf(StoreDeadlineError);
        const sent = requestsTo(HOSTILE).length;

        const calls: (() => Promise<unknown>)[] = [
            () => down.head(KEY),
            () => down.createMultipart(KEY),
            () => down.delete(KEY),
            () => down.list('ws/', null),
            () => down.read(KEY, 0, 9),
        ];
        for (const call of calls) {
            const { error, took } = await timed(call());
            expect(error).toBeInstanceOf(StoreUnavailableError);
            expect(error).toMatchObject({ code: 'breaker-open' });
            // At once: not after a deadline.
            expect(took).toBeLessThan(50);
        }
        expect(requestsTo(HOSTILE)).toHaveLength(sent);
        expect(down.health()).toBe('open');

        expect(await well.head(KEY)).toEqual({ size: 16 });
        expect(well.health()).toBe('ok');
    });

    test('after its open time one trial call goes: a store that is back is used again, one that is not is left alone again', async () => {
        s3.put(HOSTILE, KEY, randomBytes(16));
        hostile(never);
        const store = storeAt(HOSTILE, { callMs: 80, breakerOpenMs: 250 });
        for (let i = 0; i < 5; i++) await timed(store.head(KEY));
        await wait(260);

        // Still down: the trial is one request, and the breaker is open again for the full time.
        const before = requestsTo(HOSTILE).length;
        expect((await timed(store.head(KEY))).error).toBeInstanceOf(StoreDeadlineError);
        const afterTrial = requestsTo(HOSTILE).length;
        expect(afterTrial).toBeGreaterThan(before);
        expect((await timed(store.head(KEY))).error).toBeInstanceOf(StoreUnavailableError);
        expect(requestsTo(HOSTILE)).toHaveLength(afterTrial);

        // Back: the next trial closes it, and calls go again without waiting.
        await wait(260);
        s3.hooks.hostile = undefined;
        expect(await store.head(KEY)).toEqual({ size: 16 });
        expect(await store.head(KEY)).toEqual({ size: 16 });
        expect(store.health()).toBe('ok');
    });

    test('counts a 5xx and a throttle as failures', async () => {
        for (const status of [500, 503, 429]) {
            hostile((_request, res) => {
                res.writeHead(status, { 'content-type': 'application/xml' });
                res.end('<Error><Code>SlowDown</Code></Error>');
                return true;
            });
            const store = storeAt(HOSTILE, { callMs: 5_000 });
            await Promise.all(Array.from({ length: 5 }, () => timed(store.delete(KEY))));
            expect(store.health(), String(status)).toBe('open');
        }
    }, 20_000);

    test('does not count a refusal as a failure: a store that answers "not there" or "not allowed" is up', async () => {
        const store = storeAt(HONEST);
        for (let i = 0; i < 8; i++) expect(await store.head(`missing/${i}`)).toBeNull();
        for (let i = 0; i < 8; i++) expect(await store.listParts(KEY, 'no-such-upload')).toBeNull();
        hostile((_request, res) => {
            res.writeHead(403, { 'content-type': 'application/xml' });
            res.end('<Error><Code>AccessDenied</Code></Error>');
            return true;
        });
        const denied = storeAt(HOSTILE);
        for (let i = 0; i < 8; i++) {
            const { error } = await timed(denied.createMultipart(KEY));
            expect(error).not.toBeInstanceOf(StoreUnavailableError);
            expect(error).toMatchObject({ name: 'AccessDenied' });
        }
        expect(store.health()).toBe('ok');
        expect(denied.health()).toBe('ok');
    });

    test('an answer that breaks a bound is a failure of the store: five endless bodies open it', async () => {
        hostile((_request, res) => {
            res.writeHead(206, {});
            const timer = setInterval(() => res.write(Buffer.alloc(4096, 1)), 1);
            res.on('close', () => clearInterval(timer));
            return true;
        });
        const store = storeAt(HOSTILE);
        for (let i = 0; i < 5; i++)
            expect((await timed(store.read(KEY, 0, 99))).error).toMatchObject({ code: 'too-long' });
        expect(store.health()).toBe('open');
    });

    test('is one per store id and process, however often the store is opened', async () => {
        hostile(never);
        const open = () =>
            createObjectStore({
                id: 'a-store-opened-twice',
                endpoint: s3.url,
                region: 'auto',
                bucket: HOSTILE,
                accessKeyId: 'test-key-id',
                secretAccessKey: 'test-secret-value',
                forcePathStyle: true,
                bounds: { ...BOUNDS, callMs: 80, breakerOpenMs: 60_000 },
            });
        const first = open();
        for (let i = 0; i < 5; i++) await timed(first.head(KEY));
        // Opened again, as a process does when its cached store expires: the breaker is still open.
        const again = open();
        expect(again.health()).toBe('open');
        expect((await timed(again.head(KEY))).error).toBeInstanceOf(StoreUnavailableError);
    });
});

describe('a store that succeeds slowly', () => {
    test('is marked slow after five successes that each took more than half their deadline, and a person’s upload there still begins', async () => {
        s3.put(HOSTILE, KEY, randomBytes(16));
        hostile(async () => {
            await wait(CALL * 0.6);
            return false;
        });
        const store = storeAt(HOSTILE);
        for (let i = 0; i < 4; i++) expect(await store.head(KEY)).toEqual({ size: 16 });
        expect(store.health()).toBe('ok');
        expect(await store.head(KEY)).toEqual({ size: 16 });
        expect(store.health()).toBe('slow');

        // Slow refuses nothing: what a person is waiting on goes, and is answered.
        const uploadId = await store.createMultipart(KEY);
        expect(uploadId).toEqual(expect.any(String));
        expect(await store.listParts(KEY, uploadId)).toEqual([]);

        // The mark runs out by itself.
        await wait(BOUNDS.slowMs + 20);
        expect(store.health()).toBe('ok');
    }, 15_000);

    test('is not marked for being fast, or for one slow answer among fast ones', async () => {
        s3.put(HOSTILE, KEY, randomBytes(16));
        let call = 0;
        hostile(async () => {
            if (++call % 5 === 0) await wait(CALL * 0.6);
            return false;
        });
        const store = storeAt(HOSTILE);
        for (let i = 0; i < 15; i++) await store.head(KEY);
        expect(store.health()).toBe('ok');
    }, 15_000);
});

describe('the cap of a store', () => {
    test('with a cap of two, six calls made at once reach the store two at a time, and all are answered', async () => {
        s3.put(HOSTILE, KEY, randomBytes(16));
        let inFlight = 0;
        let most = 0;
        hostile(async () => {
            most = Math.max(most, ++inFlight);
            await wait(60);
            inFlight--;
            return false;
        });
        const capped = storeAt(HOSTILE, { callMs: 2_000 }, 2);
        const answers = await Promise.all(Array.from({ length: 6 }, () => capped.head(KEY)));
        expect(answers).toEqual(Array.from({ length: 6 }, () => ({ size: 16 })));
        expect(most).toBe(2);
    });

    test('an uncapped store, the operator’s own, is not held to two', async () => {
        s3.put(HOSTILE, KEY, randomBytes(16));
        let inFlight = 0;
        let most = 0;
        hostile(async () => {
            most = Math.max(most, ++inFlight);
            await wait(60);
            inFlight--;
            return false;
        });
        await Promise.all(Array.from({ length: 6 }, () => storeAt(HOSTILE).head(KEY)));
        expect(most).toBeGreaterThan(2);
    });

    test('a call that waits for a place behind a hung call ends at its own deadline, having sent nothing', async () => {
        hostile(never);
        // 1000 bytes a second: the read of 600 bytes may take 800 ms, the delete 200.
        const capped = storeAt(HOSTILE, { callMs: 200, bytesPerSecond: 1000 }, 1);
        const first = timed(capped.read(KEY, 0, 599));
        await wait(50);
        const second = await timed(capped.delete(KEY));
        expect(second.error).toBeInstanceOf(StoreDeadlineError);
        expect(second.took).toBeGreaterThanOrEqual(195);
        expect(second.took).toBeLessThan(200 + SLACK);
        // The read still held the only place: the delete never reached the store.
        expect(requestsTo(HOSTILE, 'DELETE')).toEqual([]);
        expect((await first).error).toBeInstanceOf(StoreDeadlineError);
        // And the line is empty again: the place the delete never had was not lost.
        s3.hooks.hostile = undefined;
        expect(await capped.head(KEY)).toBeNull();
    });
});
