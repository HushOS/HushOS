import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { type S3Request, startS3 } from '../test/s3-server';

/*
 * What a store may do to the server (docs/company-storage-design.md 2.4, and
 * "a hostile store" in its section 15). The store is an S3 server in this
 * process that misbehaves on purpose, reached through the real SDK, so what is
 * observed is what the worker and the web process would do: how a call ends,
 * which requests went out, how many bytes were taken.
 *
 * Nothing here asserts that something was quick: a loaded runner is several
 * times slower than a laptop. A call that can only end by its deadline is
 * shown to end, and not before the deadline. What must not happen after a
 * deadline is shown by what the store was sent, in order. How long a call
 * "took", where the breaker judges it, is said by a clock the test moves. The
 * arithmetic of deadlines, breaker and cap, with a clock only, is in
 * bounds.test.ts.
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
const { STORE_BOUNDS, StoreUnavailableError, deadlineFor } = await import('./bounds');

/* The production deadline scaled down: 400 ms for 60 s. */
const CALL = 400;
/* Fast enough that the allowance for a test's few bytes is nothing: the deadline is CALL. */
const BOUNDS = {
    connectMs: 200,
    idleMs: 30_000,
    callMs: CALL,
    bytesPerSecond: 1024 * 1024 * 1024,
    maxCallMs: 60_000,
    breakerOpenMs: 300,
    slowMs: 300,
};
type Bounds = Partial<typeof BOUNDS> & { answerBytes?: number };

const storeAt = (
    bucket: string,
    bounds: Bounds = {},
    options: { cap?: number; id?: string; now?: () => number } = {},
) =>
    createObjectStore({
        endpoint: s3.url,
        region: 'auto',
        bucket,
        accessKeyId: 'test-key-id',
        secretAccessKey: 'test-secret-value',
        forcePathStyle: true,
        bounds: { ...BOUNDS, ...bounds },
        ...options,
    });

const KEY = 'ws/00000000-0000-4000-8000-00000000000a/00000000-0000-4000-8000-00000000000b';
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/* Waits for something the store's side does a moment later, such as noticing a closed connection. */
async function until(happened: () => boolean) {
    for (let tries = 0; tries < 500 && !happened(); tries++) await wait(10);
    return happened();
}
const requestsTo = (bucket: string, method?: string) =>
    s3.requests.filter(
        (request) => request.bucket === bucket && (!method || request.method === method),
    );

/* How a call ended, when it began and ended, and how long that was. */
async function timed<T>(call: Promise<T>) {
    const started = performance.now();
    const outcome = await call.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
    );
    const ended = performance.now();
    return { ...outcome, started, ended, took: ended - started };
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
/* A body that never ends, and whether the store's side saw the connection closed on it. */
function endless(res: ServerResponse, status = 206) {
    const state = { closed: false };
    res.writeHead(status, {});
    const piece = Buffer.alloc(64 * 1024, 9);
    const timer = setInterval(() => res.write(piece), 1);
    res.on('close', () => {
        clearInterval(timer);
        state.closed = true;
    });
    return state;
}

beforeEach(() => {
    s3.reset();
});
afterAll(async () => {
    await s3.stop();
});

describe('a total deadline', () => {
    test('ends a call to a store that accepts the connection and never answers, and not before its time', async () => {
        hostile(never);
        const { error, took } = await timed(storeAt(HOSTILE).head(KEY));
        // Nothing else could have ended it: the store said nothing.
        expect(error).toBeInstanceOf(StoreDeadlineError);
        expect(took).toBeGreaterThanOrEqual(CALL - 5);
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
            await wait(CALL * 2);
            return false;
        });
        // The honest answer arrives at twice the deadline: without one the call would have it.
        const { error } = await timed(storeAt(HOSTILE).head(KEY));
        expect(error).toBeInstanceOf(StoreDeadlineError);
    });

    test('covers the SDK’s retries: the retry of a failed attempt is cut off with the call, and no third attempt is sent', async () => {
        // The first attempt fails at once; the SDK retries; the store sits on the retry.
        let attempts = 0;
        hostile((request, res) => (++attempts === 1 ? failing(request, res) : true));
        const { error, took, ended } = await timed(storeAt(HOSTILE).head(KEY));
        expect(error).toBeInstanceOf(StoreDeadlineError);
        // One deadline for both attempts: the retry did not get a fresh one, nor end the call early.
        expect(took).toBeGreaterThanOrEqual(CALL - 5);
        expect(requestsTo(HOSTILE)).toHaveLength(2);
        // The attempt the SDK had left is never made, however long one waits.
        await wait(CALL);
        expect(requestsTo(HOSTILE)).toHaveLength(2);
        for (const request of requestsTo(HOSTILE)) expect(request.at).toBeLessThanOrEqual(ended);
    });

    test('with attempts that each time out idle, no attempt begins after the deadline', async () => {
        hostile(never);
        // Three attempts of 150 ms each do not fit in the 400: the deadline ends the call, not the last of them.
        const { error, ended } = await timed(storeAt(HOSTILE, { idleMs: 150 }).head(KEY));
        expect(error).toBeInstanceOf(StoreDeadlineError);
        // The idle limit did give the store another attempt inside the deadline.
        expect(requestsTo(HOSTILE).length).toBeGreaterThanOrEqual(2);
        const sent = requestsTo(HOSTILE).length;
        await wait(CALL);
        expect(requestsTo(HOSTILE)).toHaveLength(sent);
        for (const request of requestsTo(HOSTILE)) expect(request.at).toBeLessThanOrEqual(ended);
    });

    test('lets a store that fails twice and then answers finish inside one call', async () => {
        s3.put(HOSTILE, KEY, randomBytes(48));
        let failures = 2;
        hostile((request, res) => (failures-- > 0 ? failing(request, res) : false));
        const store = storeAt(HOSTILE, { callMs: 30_000 });
        expect(await store.head(KEY)).toEqual({ size: 48 });
        expect(requestsTo(HOSTILE)).toHaveLength(3);
        expect(store.health()).toBe('ok');
    });

    test('covers every page of a part list, not each page', async () => {
        // A store that says there is always another page, and takes a while over each.
        hostile(async (_request, res) => {
            await wait(CALL / 4);
            res.writeHead(200, { 'content-type': 'application/xml' });
            res.end(
                '<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>1</NextPartNumberMarker><Part><PartNumber>1</PartNumber><ETag>"e"</ETag><Size>5</Size></Part></ListPartsResult>',
            );
            return true;
        });
        // Every page is answered well inside a deadline of its own; only one for all of them ends this.
        const { error } = await timed(storeAt(HOSTILE).listParts(KEY, 'upload-id'));
        expect(error).toBeInstanceOf(StoreDeadlineError);
        expect(requestsTo(HOSTILE).length).toBeGreaterThan(1);
    });

    test('allows for the bytes a call expects: a slow, honest read of a large range is not cut off at the base deadline', async () => {
        const bytes = randomBytes(600);
        s3.put(HOSTILE, KEY, bytes);
        // 600 bytes in six pieces over 1.5 times the base deadline.
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
        // 100 bytes a second: 600 bytes are allowed six seconds beyond the base.
        const store = storeAt(HOSTILE, { bytesPerSecond: 100 });
        const { value, took } = await timed(store.read(KEY, 0, 599));
        expect(Buffer.from(value!).equals(bytes)).toBe(true);
        expect(took).toBeGreaterThan(CALL);
    });

    test('is never longer than the ceiling, and a caller’s own ceiling is lower still', async () => {
        hostile(never);
        // By its size this read would be allowed 10,000 seconds. The store's ceiling ends it.
        const capped = storeAt(HOSTILE, { bytesPerSecond: 100, maxCallMs: CALL * 2 });
        const byStore = await timed(capped.read(KEY, 0, 999_999));
        expect(byStore.error).toBeInstanceOf(StoreDeadlineError);
        expect(byStore.took).toBeGreaterThanOrEqual(CALL * 2 - 5);
        // A person's request passes a lower one of its own.
        const s = storeAt(HOSTILE, { bytesPerSecond: 100, maxCallMs: 600_000 });
        const byCaller = await timed(
            s.completeMultipart(KEY, 'upload-id', [], { size: 999_999, maxMs: CALL }),
        );
        expect(byCaller.error).toBeInstanceOf(StoreDeadlineError);
        expect(byCaller.took).toBeGreaterThanOrEqual(CALL - 5);
    });

    test('at the lowest rate the setting accepts and the largest object there is, is the ceiling and not a timer that overflowed', async () => {
        // 78 GiB at 80 KiB/s is twelve days by the rate: the ceiling is what the call gets.
        const floor = { ...STORE_BOUNDS, bytesPerSecond: 80 * 1024 };
        expect(deadlineFor(floor, MAX_OBJECT_BYTES)).toBe(STORE_BOUNDS.maxCallMs);

        // And were there no ceiling, at a rate that puts the delay past what a timer can
        // hold (one byte a second: 2,600 years), the completion of such an object must
        // still be waited for, not failed after the one millisecond an overflowed timer runs.
        expect(MAX_OBJECT_BYTES * 1000).toBeGreaterThan(2 ** 31);
        const key = `${KEY}-largest`;
        const store = storeAt(HONEST, { bytesPerSecond: 1, maxCallMs: Number.MAX_SAFE_INTEGER });
        const uploadId = await store.createMultipart(key);
        const part = randomBytes(64);
        const put = await fetch(await store.presignPart(key, uploadId, 1, part.length, 60), {
            method: 'PUT',
            body: new Uint8Array(part),
        });
        hostile(async (request) => {
            if (request.method === 'POST') await wait(50);
            return false;
        }, HONEST);
        expect(
            await store.completeMultipart(
                key,
                uploadId,
                [{ partNumber: 1, etag: put.headers.get('etag')! }],
                { size: MAX_OBJECT_BYTES },
            ),
        ).toEqual({ size: 64 });
    });
});

describe('a request the store answers only after working in silence', () => {
    /* An upload of one part, begun and sent, ready to complete. */
    async function begun(store: ReturnType<typeof storeAt>, key: string) {
        const part = randomBytes(600);
        const uploadId = await store.createMultipart(key);
        const url = await store.presignPart(key, uploadId, 1, part.length, 60);
        const put = await fetch(url, { method: 'PUT', body: new Uint8Array(part) });
        return { uploadId, part, parts: [{ partNumber: 1, etag: put.headers.get('etag')! }] };
    }
    const IDLE = 150;
    /* Four times the idle limit without a byte, then the honest answer. */
    const assembling = (matches: (request: S3Request) => boolean) =>
        hostile(async (request) => {
            if (matches(request)) await wait(IDLE * 4);
            return false;
        });

    test('a completion that takes four times the idle limit is waited for, in one request', async () => {
        // 100 bytes a second: 600 bytes are allowed six seconds beyond the base.
        const store = storeAt(HOSTILE, { idleMs: IDLE, callMs: 5_000, bytesPerSecond: 100 });
        const upload = await begun(store, KEY);
        assembling((request) => request.method === 'POST' && request.query.includes('uploadId'));
        expect(
            await store.completeMultipart(KEY, upload.uploadId, upload.parts, { size: 600 }),
        ).toEqual({ size: 600 });
        // Not cut off at the idle limit and sent again: the store was asked once.
        expect(
            requestsTo(HOSTILE, 'POST').filter((r) => r.query.includes('uploadId')),
        ).toHaveLength(1);
        expect(s3.get(HOSTILE, KEY)!.equals(upload.part)).toBe(true);
        expect(store.health()).toBe('ok');
    });

    test('five such completions in a row do not open the breaker: nobody else’s uploads are refused for them', async () => {
        const store = storeAt(HOSTILE, { idleMs: IDLE, callMs: 5_000, bytesPerSecond: 100 });
        assembling((request) => request.method === 'POST' && request.query.includes('uploadId'));
        const uploads = [];
        for (let i = 0; i < 5; i++) uploads.push(await begun(store, `${KEY}-${i}`));
        await Promise.all(
            uploads.map((upload, i) =>
                store.completeMultipart(`${KEY}-${i}`, upload.uploadId, upload.parts, {
                    size: 600,
                }),
            ),
        );
        expect(store.health()).not.toBe('open');
        expect(await store.createMultipart(`${KEY}-next`)).toEqual(expect.any(String));
    });

    test('a class rewrite that takes four times the idle limit is waited for, in one request', async () => {
        s3.put(HOSTILE, KEY, randomBytes(600));
        const store = storeAt(HOSTILE, { idleMs: IDLE, callMs: 5_000, bytesPerSecond: 100 });
        assembling((request) => request.method === 'PUT');
        await store.setStorageClass(KEY, 'STANDARD_IA', { size: 600 });
        expect(requestsTo(HOSTILE, 'PUT')).toHaveLength(1);
        expect(s3.storageClass(HOSTILE, KEY)).toBe('STANDARD_IA');
    });

    test('the completion of a copy of several parts is waited for the same way', async () => {
        const bytes = randomBytes(1000);
        s3.put(HONEST, KEY, bytes);
        const target = storeAt(HOSTILE, { idleMs: IDLE, callMs: 5_000, bytesPerSecond: 100 });
        assembling((request) => request.method === 'POST' && request.query.includes('uploadId'));
        expect(
            await target.copyFrom(storeAt(HONEST), KEY, KEY, { size: 1000, partSize: 300 }),
        ).toBe('copied');
        expect(s3.get(HOSTILE, KEY)!.equals(bytes)).toBe(true);
    });

    test('everything else keeps the idle limit: a HEAD that goes silent that long is given up and sent again', async () => {
        s3.put(HOSTILE, KEY, randomBytes(16));
        const store = storeAt(HOSTILE, { idleMs: IDLE, callMs: 30_000 });
        assembling((request) => request.method === 'HEAD');
        const { error } = await timed(store.head(KEY));
        // The idle limit ended each attempt, long before the deadline could.
        expect((error as Error).name).toBe('TimeoutError');
        expect(requestsTo(HOSTILE, 'HEAD').length).toBeGreaterThan(1);
    });

    test('silence is still bounded: a completion the store never finishes ends at its deadline', async () => {
        const store = storeAt(HOSTILE, { idleMs: IDLE, bytesPerSecond: 600 });
        const upload = await begun(store, KEY);
        hostile((request) => request.method === 'POST' && request.query.includes('uploadId'));
        // 600 bytes at 600 a second: one second beyond the base, and no more.
        const { error, took } = await timed(
            store.completeMultipart(KEY, upload.uploadId, upload.parts, { size: 600 }),
        );
        expect(error).toBeInstanceOf(StoreDeadlineError);
        expect(took).toBeGreaterThanOrEqual(CALL + 1_000 - 5);
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
        let body!: ReturnType<typeof endless>;
        hostile((_request, res) => {
            body = endless(res);
            return true;
        });
        // Ended by the first byte past the megabyte asked for, not by the deadline.
        const { error } = await timed(storeAt(HOSTILE).read(KEY, 0, 1024 * 1024 - 1));
        expect(error).toMatchObject({ name: 'StoreAnswerError', code: 'too-long' });
        expect(await until(() => body.closed)).toBe(true);
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
        // A byte every 25 ms never trips the idle limit, and 1024 of them would take 25 seconds.
        const { error, took } = await timed(storeAt(HOSTILE).read(KEY, 0, 1023));
        expect(error).toBeInstanceOf(StoreDeadlineError);
        expect(took).toBeGreaterThanOrEqual(CALL - 5);
        expect(await until(() => closed)).toBe(true);
    });

    test('a body that stalls is cut off by the idle limit, not left to the deadline', async () => {
        hostile((_request, res) => {
            res.writeHead(206, { 'content-length': 1024 });
            res.write(Buffer.alloc(100, 1));
            return true;
        });
        const store = storeAt(HOSTILE, { callMs: 30_000, idleMs: 150 });
        const { error } = await timed(store.read(KEY, 0, 1023));
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(StoreDeadlineError);
    });

    test('a listing longer than the limit is refused, and an endless one is closed, not collected', async () => {
        const entry = `<Contents><Key>ws/${'k'.repeat(100)}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`;
        const body = { closed: false };
        hostile((_request, res) => {
            res.writeHead(200, { 'content-type': 'application/xml' });
            res.write('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>');
            const timer = setInterval(() => {
                for (let i = 0; i < 20; i++) res.write(entry);
            }, 1);
            res.on('close', () => {
                clearInterval(timer);
                body.closed = true;
            });
            return true;
        });
        const { error } = await timed(
            storeAt(HOSTILE, { answerBytes: 64 * 1024 }).list('ws/', null),
        );
        expect(error).toMatchObject({ name: 'StoreAnswerError', code: 'too-long' });
        expect(await until(() => body.closed)).toBe(true);
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
        const { error } = await timed(
            storeAt(HOSTILE, { answerBytes: 64 * 1024 }).createMultipart(KEY),
        );
        // Ended by the limit: the deadline would have been a StoreDeadlineError.
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(StoreDeadlineError);
        expect(await until(() => closed)).toBe(true);
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
            endless(res);
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
        expect(
            await storeAt(TARGET).copyFrom(storeAt(HONEST), KEY, 'copies/one', {
                size: SIZE,
                partSize: 300,
            }),
        ).toBe('copied');
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
            const { error } = await timed(target.copyFrom(source, KEY, KEY, { size: SIZE }));
            expect(error).toBeInstanceOf(StoreDeadlineError);
        }
        expect(source.health()).toBe('open');
        expect(target.health()).toBe('ok');
        const sent = requestsTo(HOSTILE).length;
        const { error } = await timed(target.copyFrom(source, KEY, KEY, { size: SIZE }));
        expect(error).toBeInstanceOf(StoreUnavailableError);
        expect(requestsTo(HOSTILE)).toHaveLength(sent);
    });
});

describe('a copy of several parts that is told to stop between two of them', () => {
    const SIZE = 1000;
    const PARTS = { size: SIZE, partSize: 300 };
    const ranges = () => requestsTo(HONEST, 'GET').map((request) => request.range);
    /* Says yes `times` times, then no. */
    const proceedFor = (times: number) => {
        let asked = 0;
        return () => ++asked <= times;
    };

    test('leaves nothing that reads as a finished copy, and goes on from the next part when called again', async () => {
        const bytes = randomBytes(SIZE);
        s3.put(HONEST, KEY, bytes);
        const source = storeAt(HONEST);
        const target = storeAt(TARGET);

        // Asked before the second part (yes) and before the third (no).
        expect(await target.copyFrom(source, KEY, KEY, { ...PARTS, proceed: proceedFor(1) })).toBe(
            'suspended',
        );
        expect(ranges()).toEqual(['bytes=0-299', 'bytes=300-599']);
        // No object under the key, by HEAD or by listing: only an upload that is still open.
        expect(await target.head(KEY)).toBeNull();
        expect(s3.keys(TARGET)).toEqual([]);
        expect(s3.openUploads(TARGET)).toHaveLength(1);
        const [upload] = s3.openUploads(TARGET);

        // The next call for the same key moves the parts the store does not hold, and no others.
        expect(await target.copyFrom(source, KEY, KEY, { ...PARTS, proceed: () => true })).toBe(
            'copied',
        );
        expect(ranges()).toEqual([
            'bytes=0-299',
            'bytes=300-599',
            'bytes=600-899',
            'bytes=900-999',
        ]);
        expect(s3.get(TARGET, KEY)!.equals(bytes)).toBe(true);
        // The same upload, finished: none was begun again, and none is left open.
        expect(
            requestsTo(TARGET, 'POST').filter((r) => r.query.startsWith('?uploads')),
        ).toHaveLength(1);
        expect(s3.openUploads(TARGET)).toEqual([]);
        expect(upload).toBeDefined();
    });

    test('moves at least one part every call, however often it is told to stop, and still ends byte for byte', async () => {
        const bytes = randomBytes(SIZE);
        s3.put(HONEST, KEY, bytes);
        const source = storeAt(HONEST);
        const target = storeAt(TARGET);
        const outcomes = [];
        for (let call = 0; call < 4; call++)
            outcomes.push(
                await target.copyFrom(source, KEY, KEY, { ...PARTS, proceed: () => false }),
            );
        // Four parts, one a call: the first of a call is never asked about.
        expect(outcomes).toEqual(['suspended', 'suspended', 'suspended', 'copied']);
        expect(ranges()).toEqual([
            'bytes=0-299',
            'bytes=300-599',
            'bytes=600-899',
            'bytes=900-999',
        ]);
        expect(s3.get(TARGET, KEY)!.equals(bytes)).toBe(true);
    });

    test('a verified copy keeps its parts’ digests across the stop', async () => {
        const bytes = randomBytes(SIZE);
        s3.put(HONEST, KEY, bytes);
        const target = storeAt(TARGET);
        const options = { ...PARTS, verified: true };
        expect(
            await target.copyFrom(storeAt(HONEST), KEY, KEY, { ...options, proceed: () => false }),
        ).toBe('suspended');
        expect(await target.copyFrom(storeAt(HONEST), KEY, KEY, options)).toBe('copied');
        expect(s3.get(TARGET, KEY)!.equals(bytes)).toBe(true);
    });

    test('is not taken up as another copy: one asked for with another size begins again, and the old upload is aborted', async () => {
        s3.put(HONEST, KEY, randomBytes(SIZE));
        const target = storeAt(TARGET);
        await target.copyFrom(storeAt(HONEST), KEY, KEY, { ...PARTS, proceed: () => false });
        const [old] = s3.openUploads(TARGET);
        // The object under the key is another one now, and so is its row.
        const other = randomBytes(1300);
        s3.put(HONEST, KEY, other);
        expect(
            await target.copyFrom(storeAt(HONEST), KEY, KEY, { size: 1300, partSize: 300 }),
        ).toBe('copied');
        expect(s3.get(TARGET, KEY)!.equals(other)).toBe(true);
        expect(s3.openUploads(TARGET).map((upload) => upload.id)).not.toContain(old!.id);
        expect(s3.openUploads(TARGET)).toEqual([]);
    });

    test('a failure after it was taken up aborts it: the call after that begins from the first part', async () => {
        const bytes = randomBytes(SIZE);
        s3.put(HONEST, KEY, bytes);
        const source = storeAt(HONEST);
        const target = storeAt(TARGET);
        await target.copyFrom(source, KEY, KEY, { ...PARTS, proceed: () => false });
        // The source loses the object's tail for one read.
        let failed = false;
        hostile((request, res) => {
            if (request.method !== 'GET' || failed) return false;
            failed = true;
            res.writeHead(206, { 'content-length': 10 });
            res.end(Buffer.alloc(10));
            return true;
        }, HONEST);
        const { error } = await timed(target.copyFrom(source, KEY, KEY, PARTS));
        expect(error).toMatchObject({ code: 'too-short' });
        expect(s3.openUploads(TARGET)).toEqual([]);
        expect(s3.keys(TARGET)).toEqual([]);

        s3.requests.length = 0;
        expect(await target.copyFrom(source, KEY, KEY, PARTS)).toBe('copied');
        expect(ranges()[0]).toBe('bytes=0-299');
        expect(s3.get(TARGET, KEY)!.equals(bytes)).toBe(true);
    });

    test('is remembered by the process only: after a restart the copy begins again and is still whole', async () => {
        const bytes = randomBytes(SIZE);
        s3.put(HONEST, KEY, bytes);
        await storeAt(TARGET).copyFrom(storeAt(HONEST), KEY, KEY, {
            ...PARTS,
            proceed: () => false,
        });
        s3.requests.length = 0;
        // A store opened by a process that remembers nothing.
        expect(await storeAt(TARGET).copyFrom(storeAt(HONEST), KEY, KEY, PARTS)).toBe('copied');
        expect(ranges()).toEqual([
            'bytes=0-299',
            'bytes=300-599',
            'bytes=600-899',
            'bytes=900-999',
        ]);
        expect(s3.get(TARGET, KEY)!.equals(bytes)).toBe(true);
        // The upload the first process left open is the store's lifecycle rule's to remove.
        expect(s3.openUploads(TARGET)).toHaveLength(1);
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
            const { error } = await timed(call());
            expect(error).toBeInstanceOf(StoreUnavailableError);
            expect(error).toMatchObject({ code: 'breaker-open' });
        }
        // Refused here, not at the store: it was sent nothing more.
        expect(requestsTo(HOSTILE)).toHaveLength(sent);
        expect(down.health()).toBe('open');

        expect(await well.head(KEY)).toEqual({ size: 16 });
        expect(well.health()).toBe('ok');
    });

    test('is not kept closed by an answer now and then: four timeouts and one answer, then one more timeout, open it', async () => {
        s3.put(HOSTILE, KEY, randomBytes(16));
        let call = 0;
        // Every fifth call is answered, and rightly.
        hostile(() => ++call % 5 !== 0);
        const store = storeAt(HOSTILE, { callMs: 60 });
        for (let i = 0; i < 4; i++)
            expect((await timed(store.head(KEY))).error).toBeInstanceOf(StoreDeadlineError);
        expect(await store.head(KEY)).toEqual({ size: 16 });
        expect(store.health()).not.toBe('open');
        expect((await timed(store.head(KEY))).error).toBeInstanceOf(StoreDeadlineError);
        expect(store.health()).toBe('open');
    });

    test('after its open time one trial call goes: a store that is back is used again, one that is not is left alone again', async () => {
        s3.put(HOSTILE, KEY, randomBytes(16));
        hostile(never);
        const clock = { at: 0 };
        const store = storeAt(
            HOSTILE,
            { callMs: 80, breakerOpenMs: 60_000 },
            { now: () => clock.at },
        );
        for (let i = 0; i < 5; i++) await timed(store.head(KEY));
        clock.at += 60_000;

        // Still down: the trial is one call, and the breaker is open again for the full time.
        const before = requestsTo(HOSTILE).length;
        expect((await timed(store.head(KEY))).error).toBeInstanceOf(StoreDeadlineError);
        const afterTrial = requestsTo(HOSTILE).length;
        expect(afterTrial).toBeGreaterThan(before);
        clock.at += 59_999;
        expect((await timed(store.head(KEY))).error).toBeInstanceOf(StoreUnavailableError);
        expect(requestsTo(HOSTILE)).toHaveLength(afterTrial);

        // Back: the next trial closes it, and calls go again without waiting.
        clock.at += 1;
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
            const store = storeAt(HOSTILE, { callMs: 30_000 });
            await Promise.all(Array.from({ length: 5 }, () => timed(store.delete(KEY))));
            expect(store.health(), String(status)).toBe('open');
        }
    }, 30_000);

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
            endless(res);
            return true;
        });
        const store = storeAt(HOSTILE);
        for (let i = 0; i < 5; i++)
            expect((await timed(store.read(KEY, 0, 99))).error).toMatchObject({ code: 'too-long' });
        expect(store.health()).toBe('open');
    });

    test('is one per store id and process, however often the store is opened with the same settings', async () => {
        hostile(never);
        const open = (cap?: number) =>
            storeAt(HOSTILE, { callMs: 80, breakerOpenMs: 60_000 }, { id: 'opened-twice', cap });
        const first = open();
        for (let i = 0; i < 5; i++) await timed(first.head(KEY));
        // Opened again, as a process does when its cached store expires: the breaker is still open.
        const again = open();
        expect(again.health()).toBe('open');
        expect((await timed(again.head(KEY))).error).toBeInstanceOf(StoreUnavailableError);
    });

    test('a store opened again under its id with another cap is held to that cap, not the first opener’s', async () => {
        s3.put(HOSTILE, KEY, randomBytes(16));
        let inFlight = 0;
        let most = 0;
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        hostile(async () => {
            most = Math.max(most, ++inFlight);
            await held;
            inFlight--;
            return false;
        });
        const open = (cap?: number) =>
            storeAt(HOSTILE, { callMs: 30_000 }, { id: 'cap-changed', cap });
        // First opened without a cap; then its row is changed and it is opened with one.
        open();
        const capped = open(2);
        const calls = Array.from({ length: 5 }, () => capped.head(KEY));
        expect(await until(() => inFlight === 2)).toBe(true);
        // Long enough for the other three to have arrived, had nothing held them.
        await wait(150);
        expect(most).toBe(2);
        release();
        expect(await Promise.all(calls)).toHaveLength(5);
    });
});

describe('a store that succeeds slowly', () => {
    /* A store whose every answer is right, and "takes" what the test says, by the clock the breaker reads. */
    function slowly(took: () => number) {
        const clock = { at: 0 };
        s3.put(HOSTILE, KEY, randomBytes(16));
        hostile(() => {
            clock.at += took();
            return false;
        });
        return {
            clock,
            store: storeAt(HOSTILE, { callMs: 60_000, slowMs: 60_000 }, { now: () => clock.at }),
        };
    }

    test('is marked slow after five answers that each took more than half their deadline, and a person’s upload there still begins', async () => {
        const { clock, store } = slowly(() => 30_001);
        for (let i = 0; i < 4; i++) expect(await store.head(KEY)).toEqual({ size: 16 });
        expect(store.health()).toBe('ok');
        expect(await store.head(KEY)).toEqual({ size: 16 });
        expect(store.health()).toBe('slow');

        // Slow refuses nothing: what a person is waiting on goes, and is answered.
        const uploadId = await store.createMultipart(KEY);
        expect(uploadId).toEqual(expect.any(String));
        expect(await store.listParts(KEY, uploadId)).toEqual([]);

        // The mark runs out by itself.
        clock.at += 60_001;
        expect(store.health()).toBe('ok');
    });

    test('is not marked for answering in exactly half its deadline, or for one late answer among prompt ones', async () => {
        const half = slowly(() => 30_000);
        for (let i = 0; i < 12; i++) await half.store.head(KEY);
        expect(half.store.health()).toBe('ok');

        let call = 0;
        const mostly = slowly(() => (++call % 5 === 0 ? 59_000 : 10));
        for (let i = 0; i < 20; i++) await mostly.store.head(KEY);
        expect(mostly.store.health()).toBe('ok');
    });

    test('is not kept from slow by a prompt answer now and then', async () => {
        let call = 0;
        // Four late, one prompt, repeated.
        const { store } = slowly(() => (++call % 5 === 0 ? 10 : 59_000));
        for (let i = 0; i < 5; i++) await store.head(KEY);
        expect(store.health()).toBe('ok');
        await store.head(KEY);
        expect(store.health()).toBe('slow');
    });
});

describe('the cap of a store', () => {
    /* A store that holds every request until it is let go, and says how many it holds. */
    function holding() {
        s3.put(HOSTILE, KEY, randomBytes(16));
        const state = { inFlight: 0, most: 0, release: () => {} };
        const held = new Promise<void>((resolve) => (state.release = resolve));
        hostile(async () => {
            state.most = Math.max(state.most, ++state.inFlight);
            await held;
            state.inFlight--;
            return false;
        });
        return state;
    }

    test('with a cap of two, six calls made at once reach the store two at a time, and all are answered', async () => {
        const store = holding();
        const capped = storeAt(HOSTILE, { callMs: 30_000 }, { cap: 2 });
        const calls = Array.from({ length: 6 }, () => capped.head(KEY));
        expect(await until(() => store.inFlight === 2)).toBe(true);
        // Long enough for the other four to have arrived, had nothing held them.
        await wait(150);
        expect(store.inFlight).toBe(2);
        store.release();
        expect(await Promise.all(calls)).toEqual(Array.from({ length: 6 }, () => ({ size: 16 })));
        expect(store.most).toBe(2);
    });

    test('an uncapped store, the operator’s own, is not held to two', async () => {
        const store = holding();
        const uncapped = storeAt(HOSTILE, { callMs: 30_000 });
        const calls = Array.from({ length: 6 }, () => uncapped.head(KEY));
        expect(await until(() => store.inFlight === 6)).toBe(true);
        store.release();
        await Promise.all(calls);
    });

    test('a call that waits for a place behind a hung call ends at its own deadline, having sent nothing', async () => {
        hostile(never);
        // 600 bytes a second: the read of 600 bytes may take a second beyond the base, the delete nothing.
        const capped = storeAt(HOSTILE, { callMs: 200, bytesPerSecond: 600 }, { cap: 1 });
        const first = timed(capped.read(KEY, 0, 599));
        await until(() => requestsTo(HOSTILE, 'GET').length === 1);
        const second = await timed(capped.delete(KEY));
        expect(second.error).toBeInstanceOf(StoreDeadlineError);
        expect(second.took).toBeGreaterThanOrEqual(195);
        // The read still held the only place: the delete never reached the store.
        expect(requestsTo(HOSTILE, 'DELETE')).toEqual([]);
        expect((await first).error).toBeInstanceOf(StoreDeadlineError);
        // And the line is empty again: the place the delete never had was not lost.
        s3.hooks.hostile = undefined;
        expect(await capped.head(KEY)).toBeNull();
    });
});
