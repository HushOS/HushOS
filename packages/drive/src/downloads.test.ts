import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CryptoRequests, CryptoResults, DownloadChunkResult } from '@hushos/crypto';
import { chunkCount, contentLength } from '@hushos/crypto/drive';
import type { DriveApi } from './api';
import type { DriveNode, FolderListing, Rpc } from './client';
import { createDownloadManager, type DownloadSink, type ZipEntry } from './downloads';

/*
 * The download engine against a fake worker, a fake API and a recording sink:
 * chunks reach the sink in index order however the network reorders them, no
 * more than the look-ahead is in flight, an expired URL is replaced and a
 * retryable failure backs off, a permanent one fails the download and aborts the
 * sink, cancel stops writes and closes the worker's key, and a folder becomes
 * zip entries with the right relative paths and sizes. Bytes stand in for
 * plaintext: chunk i of object o is the byte pattern `o:i`.
 */

const CHUNK = 8 * 1024 * 1024;

function file(
    id: string,
    plaintextSize: number,
    parentId: string | null = 'root',
    name = id,
): DriveNode {
    return {
        id,
        workspaceId: 'ws',
        parentId,
        kind: 'file',
        keyEpoch: 1,
        parentKeyEpoch: 1,
        keyEnvelope: 'k',
        prevKeyEnvelope: null,
        prevKeyEpoch: null,
        prevParentKeyEpoch: null,
        metadataVersion: 1,
        metadataEnvelope: 'm',
        currentVersion: {
            id: `v-${id}`,
            objectId: `o-${id}`,
            contentKeyEnvelope: 'c',
            status: 'ready',
            objectStatus: 'ready',
            contentSuite: 1,
            chunkSize: CHUNK,
            chunkCount: Math.max(1, Math.ceil(plaintextSize / CHUNK)),
            contentNonce: 'n',
            plaintextSize: String(plaintextSize),
            ciphertextSize: String(plaintextSize + 16),
            readyAt: '',
            signer: null,
            signature: null,
        },
        trashedAt: null,
        changeSeq: 1,
        createdAt: '',
        updatedAt: '',
        metadata: { name, mime: null, size: plaintextSize, modified: null },
        name,
        content: { plaintextSize, thumbnailBytes: 0 },
        openError: null,
        envelopeSuite: 1,
        metadataSigner: null,
        metadataSignature: null,
        integrity: null,
    };
}
/* A suite 3 file with a thumbnail trailer: its object is padded to a Padmé bucket. */
function paddedFile(id: string, plaintextSize: number, thumbnailBytes: number): DriveNode {
    const base = file(id, plaintextSize);
    return {
        ...base,
        currentVersion: { ...base.currentVersion!, contentSuite: 3, plaintextSize: null },
        content: { plaintextSize, thumbnailBytes },
    };
}
function folder(id: string, parentId: string | null = 'root'): DriveNode {
    return { ...file(id, 0, parentId), kind: 'folder', currentVersion: null };
}

function chunkBytes(objectId: string, index: number, size: number) {
    const bytes = new Uint8Array(size);
    const tag = new TextEncoder().encode(`${objectId}:${index};`);
    for (let offset = 0; offset < size; offset += tag.length)
        bytes.set(tag.subarray(0, Math.min(tag.length, size - offset)), offset);
    return bytes;
}
/* Byte equality without handing vitest tens of millions of elements to diff. */
function sameBytes(a: Uint8Array, b: Uint8Array) {
    return a.byteLength === b.byteLength && Buffer.from(a).equals(Buffer.from(b));
}

type ChunkDecision = (
    objectId: string,
    index: number,
    attempt: number,
) => Promise<DownloadChunkResult | null> | DownloadChunkResult | null;

function harness(options: {
    decide?: ChunkDecision;
    folders?: Record<string, DriveNode[]>;
    zip?: boolean;
    lookahead?: number;
    offline?: () => boolean;
    /* What a suite 3 version's envelope would say, by object id. */
    sealed?: Record<string, { plaintextSize: number; thumbnailBytes: number }>;
    /* Opening a file's folder, which a test can hold. */
    ensureOpen?: () => Promise<void>;
}) {
    const calls: string[] = [];
    const attempts = new Map<string, number>();
    const pendingChunks = new Map<string, () => void>();
    const closed: string[] = [];
    /* The worker's open keys, by reader, as it holds them: the object each reader opened. */
    const readers = new Map<string, string>();
    let inFlight = 0;
    let peakInFlight = 0;
    let urlsIssued = 0;
    const sizes = new Map<string, number>();

    const rpc: Rpc = async <K extends keyof CryptoRequests>(
        operation: K,
        input: CryptoRequests[K],
    ): Promise<CryptoResults[K]> => {
        calls.push(operation);
        switch (operation) {
            case 'driveDownloadOpen': {
                const { reader, version } = input as CryptoRequests['driveDownloadOpen'];
                readers.set(reader, version.objectId);
                // Suite 1 keeps the size on the row; suite 3 seals it, and the test passes it in.
                const sealed = options.sealed?.[version.objectId];
                const plaintextSize = sealed?.plaintextSize ?? Number(version.plaintextSize);
                const thumbnailBytes = sealed?.thumbnailBytes ?? 0;
                sizes.set(version.objectId, plaintextSize);
                return {
                    chunkCount: chunkCount(
                        contentLength(version.contentSuite, plaintextSize, thumbnailBytes),
                    ),
                    plaintextSize,
                    thumbnailBytes,
                } as CryptoResults[K];
            }
            case 'driveDownloadChunk': {
                const { reader, index, url } = input as CryptoRequests['driveDownloadChunk'];
                expect(url).toMatch(/^https:\/\/store\//);
                const objectId = readers.get(reader);
                if (!objectId) throw new Error('This download is no longer open. Start it again.');
                const key = `${objectId}:${index}`;
                const attempt = (attempts.get(key) ?? 0) + 1;
                attempts.set(key, attempt);
                inFlight++;
                peakInFlight = Math.max(peakInFlight, inFlight);
                try {
                    const decided = await options.decide?.(objectId, index, attempt);
                    if (decided) return decided as CryptoResults[K];
                    // Default: the chunk lands after a short delay, releasable early by a test.
                    await new Promise<void>((resolve) => {
                        pendingChunks.set(key, resolve);
                        setTimeout(resolve, 50);
                    });
                    pendingChunks.delete(key);
                    const total = sizes.get(objectId)!;
                    // The worker trims each chunk to the file: past its end, padding gives nothing.
                    const size = Math.max(0, Math.min(CHUNK, total - index * CHUNK));
                    return {
                        ok: true,
                        index,
                        plaintext: chunkBytes(objectId, index, size),
                    } as CryptoResults[K];
                } finally {
                    inFlight--;
                }
            }
            case 'driveDownloadClose': {
                const { reader } = input as CryptoRequests['driveDownloadClose'];
                const objectId = readers.get(reader);
                if (objectId) closed.push(objectId);
                readers.delete(reader);
                return { closed: objectId !== undefined } as CryptoResults[K];
            }
            default:
                throw new Error(`unexpected ${operation}`);
        }
    };
    const api = {
        downloadUrl: async (_ws: string, versionId: string) => {
            urlsIssued++;
            return {
                url: `https://store/${versionId}/${urlsIssued}`,
                urlExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
                node: {} as never,
                version: {} as never,
            };
        },
    } as unknown as DriveApi;

    const sinks: { name: string; size: number | null; writes: Uint8Array[]; log: string[] }[] = [];
    const openSink = async (target: { name: string; size: number | null }) => {
        const record = { ...target, writes: [] as Uint8Array[], log: [] as string[] };
        sinks.push(record);
        const sink: DownloadSink = {
            async write(chunk) {
                record.writes.push(chunk.slice());
                record.log.push('write');
            },
            async close() {
                record.log.push('close');
            },
            async abort() {
                record.log.push('abort');
            },
        };
        return sink;
    };
    const zipped: { entries: { name: string; size: number; bytes: number }[]; sizes: unknown } = {
        entries: [],
        sizes: null,
    };
    const zip = (entries: AsyncIterable<ZipEntry>, list: { name: string; size: number }[]) => {
        zipped.sizes = list;
        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                for await (const entry of entries) {
                    let bytes = 0;
                    const reader = entry.input.getReader();
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        bytes += value.byteLength;
                        controller.enqueue(value);
                    }
                    zipped.entries.push({ name: entry.name, size: entry.size, bytes });
                }
                controller.close();
            },
        });
        return { stream, size: list.reduce((sum, f) => sum + f.size, 0) + 22 };
    };
    const listed: string[] = [];
    const manager = createDownloadManager({
        rpc,
        api,
        openSink,
        listFolder: async (folderId): Promise<FolderListing> => {
            listed.push(folderId);
            return {
                folder: folder(folderId),
                ancestors: [],
                children: options.folders?.[folderId] ?? [],
            };
        },
        ensureOpen: options.ensureOpen ?? (async () => {}),
        zip: options.zip ? zip : undefined,
        lookahead: options.lookahead,
        maxAttempts: 3,
        offline: options.offline,
    });
    const release = (objectId: string, index: number) =>
        pendingChunks.get(`${objectId}:${index}`)?.();
    return {
        manager,
        calls,
        closed,
        /* The keys the worker holds open now. */
        get openKeys() {
            return readers.size;
        },
        listed,
        sinks,
        zipped,
        release,
        attempts,
        get peakInFlight() {
            return peakInFlight;
        },
        get urlsIssued() {
            return urlsIssued;
        },
    };
}

async function settle(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
}
function concat(parts: Uint8Array[]) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('download manager', () => {
    test('writes chunks in order even when later ones arrive first, with a bounded look-ahead', async () => {
        const h = harness({ lookahead: 1 });
        const size = 3 * CHUNK + 1234;
        const id = h.manager.download([file('a', size)])!;
        await settle(10);
        // Chunk 1 lands before chunk 0; the sink must still see 0 first.
        h.release('o-a', 1);
        await settle(0);
        await settle(1_000);
        const item = h.manager.getState().downloads[0]!;
        expect(item.id).toBe(id);
        expect(item.status).toBe('done');
        expect(item.loaded).toBe(size);
        expect(h.peakInFlight).toBeLessThanOrEqual(2);
        const [sink] = h.sinks;
        expect(sink!.name).toBe('a');
        expect(sink!.size).toBe(size);
        expect(sink!.log.at(-1)).toBe('close');
        const expected = concat(
            [0, 1, 2, 3].map((i) => chunkBytes('o-a', i, i === 3 ? 1234 : CHUNK)),
        );
        expect(sameBytes(concat(sink!.writes), expected)).toBe(true);
        expect(h.closed).toEqual(['o-a']);
    });

    test('while offline a failing chunk waits for the network and the tries are not counted', async () => {
        let offline = true;
        const h = harness({
            offline: () => offline,
            // Five failures, more than the harness's three tries, all while offline.
            decide: (_object, index, attempt) =>
                index === 1 && attempt <= 5
                    ? { ok: false, status: 0, retryable: true, message: 'offline' }
                    : null,
        });
        h.manager.download([file('c', 3 * CHUNK)]);
        await settle(200_000);
        offline = false;
        await settle(70_000);
        expect(h.manager.getState().downloads[0]!.status).toBe('done');
        expect(h.attempts.get('o-c:1')).toBe(6);
        expect(concat(h.sinks[0]!.writes).byteLength).toBe(3 * CHUNK);
    });

    test('replaces an expired URL after a 403 and backs off a retryable failure', async () => {
        const h = harness({
            decide: (_object, index, attempt) => {
                if (index === 1 && attempt === 1)
                    return { ok: false, status: 403, retryable: true, message: 'expired' };
                if (index === 2 && attempt < 3)
                    return { ok: false, status: 503, retryable: true, message: 'busy' };
                return null;
            },
        });
        h.manager.download([file('b', 3 * CHUNK)]);
        await settle(70_000);
        const item = h.manager.getState().downloads[0]!;
        expect(item.status).toBe('done');
        expect(h.urlsIssued).toBe(2);
        expect(h.attempts.get('o-b:2')).toBe(3);
        expect(concat(h.sinks[0]!.writes).byteLength).toBe(3 * CHUNK);
    });

    test('a permanent failure aborts the sink, closes the key and reports why', async () => {
        const h = harness({
            decide: (_object, index) =>
                index === 1
                    ? { ok: false, status: 404, retryable: false, message: 'The object is gone.' }
                    : null,
        });
        h.manager.download([file('c', 2 * CHUNK)]);
        await settle(5_000);
        const item = h.manager.getState().downloads[0]!;
        expect(item.status).toBe('failed');
        expect(item.error).toBe('The object is gone.');
        expect(h.sinks[0]!.log).toEqual(['write', 'abort']);
        expect(h.closed).toContain('o-c');
    });

    test('cancel stops further writes, aborts the sink and closes the key', async () => {
        const h = harness({ lookahead: 0 });
        const id = h.manager.download([file('d', 4 * CHUNK)])!;
        await settle(60);
        const written = h.sinks[0]!.writes.length;
        expect(written).toBeGreaterThan(0);
        await h.manager.cancel(id);
        await settle(1_000);
        const item = h.manager.getState().downloads[0]!;
        expect(item.status).toBe('cancelled');
        expect(h.sinks[0]!.writes.length).toBe(written);
        expect(h.sinks[0]!.log).toContain('abort');
        expect(h.sinks[0]!.log).not.toContain('close');
        expect(h.closed).toContain('o-d');
        // A settled download cannot be cancelled again or removed while active.
        h.manager.remove(id);
        expect(h.manager.getState().downloads).toHaveLength(0);
    });

    test('a locked worker fails the download with an unlock hint', async () => {
        const h = harness({
            decide: () => {
                throw new Error('The device is locked.');
            },
        });
        h.manager.download([file('e', CHUNK)]);
        await settle(1_000);
        const item = h.manager.getState().downloads[0]!;
        expect(item.status).toBe('failed');
        expect(item.error).toMatch(/locked. Unlock it/);
    });

    test('a folder becomes a zip of relative paths with sizes announced up front', async () => {
        const h = harness({
            zip: true,
            folders: {
                photos: [
                    folder('raw', 'photos'),
                    file('a.jpg', 100, 'photos'),
                    file('empty', 0, 'photos'),
                ],
                raw: [file('b.dng', CHUNK + 5, 'raw')],
            },
        });
        const id = h.manager.download([folder('photos')])!;
        await settle(2_000);
        const item = h.manager.getState().downloads[0]!;
        expect(item.id).toBe(id);
        expect(item.status).toBe('done');
        expect(item.name).toBe('photos.zip');
        expect(item.files).toBe(3);
        // A folder's own files come before its subfolders, which are listed together.
        expect(h.zipped.sizes).toEqual([
            { name: 'photos/a.jpg', size: 100 },
            { name: 'photos/empty', size: 0 },
            { name: 'photos/raw/b.dng', size: CHUNK + 5 },
        ]);
        expect(h.zipped.entries.map((e) => [e.name, e.bytes])).toEqual([
            ['photos/a.jpg', 100],
            ['photos/empty', 0],
            ['photos/raw/b.dng', CHUNK + 5],
        ]);
        expect(h.sinks[0]!.size).toBe(CHUNK + 5 + 100 + 22);
        expect(item.size).toBe(CHUNK + 5 + 100 + 22);
        expect(h.closed.sort()).toEqual(['o-a.jpg', 'o-b.dng', 'o-empty']);
        // Each folder is listed once, not once for sizes and again for entries.
        expect(h.listed).toEqual(['photos', 'raw']);
    });

    test('several files picked together zip under a name from the caller', async () => {
        const h = harness({ zip: true });
        h.manager.download([file('x', 10), file('y', 20)], 'Shared');
        await settle(1_000);
        const item = h.manager.getState().downloads[0]!;
        expect(item.name).toBe('Shared.zip');
        expect(item.status).toBe('done');
        expect(h.zipped.entries.map((e) => e.name)).toEqual(['x', 'y']);
    });

    test('without a zip function, a folder download fails instead of hanging', async () => {
        const h = harness({});
        h.manager.download([folder('f')]);
        await settle(100);
        const item = h.manager.getState().downloads[0]!;
        expect(item.status).toBe('failed');
        expect(h.sinks).toHaveLength(0);
    });

    test('a reader stitches ranges across chunks and refetches only what left its cache', async () => {
        const h = harness({});
        const size = 2 * CHUNK + 100;
        const reader = h.manager.openReader(file('r', size), 2);
        expect(reader.size).toBe(size);
        // A range straddling chunks 0 and 1 comes back as one contiguous slice.
        const across = reader.read(CHUNK - 10, 20);
        await settle(100);
        const bytes = await across;
        const expected = concat([
            chunkBytes('o-r', 0, CHUNK).subarray(CHUNK - 10),
            chunkBytes('o-r', 1, CHUNK).subarray(0, 10),
        ]);
        expect(sameBytes(bytes, expected)).toBe(true);
        expect(h.attempts.size).toBe(2);
        // The tail chunk is short; a read past the end is clipped, not an error.
        const tail = reader.read(2 * CHUNK + 90, 1_000);
        await settle(100);
        expect((await tail).byteLength).toBe(10);
        expect(h.attempts.size).toBe(3);
        // Chunk 0 was evicted (cache of two, chunks 1 and 2 are newer); chunk 2 was not.
        const again = Promise.all([reader.read(0, 1), reader.read(2 * CHUNK, 1)]);
        await settle(100);
        await again;
        expect(h.attempts.get('o-r:0')).toBe(2);
        expect(h.attempts.get('o-r:2')).toBe(1);
        expect(h.calls.filter((c) => c === 'driveDownloadOpen')).toHaveLength(1);
        await reader.close();
        expect(h.closed).toEqual(['o-r']);
        await expect(reader.read(0, 1)).rejects.toThrow(/closed/);
    });

    test('a reader closed after another of the same file opened leaves the other reading', async () => {
        // The viewer reopening for the same file: the old reader is closed as the new one
        // opens, and the worker must close the old one's key only.
        const h = harness({});
        const size = 2 * CHUNK;
        const old = h.manager.openReader(file('r', size), 2);
        const first = old.read(0, 1);
        await settle(100);
        await first;
        const fresh = h.manager.openReader(file('r', size), 2);
        const opening = fresh.read(0, 1);
        await settle(100);
        expect((await opening).byteLength).toBe(1);
        // The old one's close reaches the worker after the new one opened.
        await old.close();
        const later = fresh.read(CHUNK, 1);
        await settle(100);
        expect((await later).byteLength).toBe(1);
        expect(h.closed).toEqual(['o-r']);
        await fresh.close();
        expect(h.closed).toEqual(['o-r', 'o-r']);
    });

    test('a reader closed while its folder is still opening leaves no key in the worker', async () => {
        let folderOpen: () => void = () => {};
        const h = harness({
            ensureOpen: () => new Promise<void>((resolve) => (folderOpen = resolve)),
        });
        const reader = h.manager.openReader(file('r', CHUNK), 2);
        const read = expect(reader.read(0, 1)).rejects.toThrow();
        const closing = reader.close();
        folderOpen();
        await closing;
        await read;
        await settle(100);
        expect(h.openKeys).toBe(0);
    });

    test('a file that changed while it opened leaves no key in the worker', async () => {
        // The worker reads another size from the version than the listing gave.
        const h = harness({ sealed: { 'o-r': { plaintextSize: 10, thumbnailBytes: 0 } } });
        const reader = h.manager.openReader(file('r', CHUNK), 2);
        const read = expect(reader.read(0, 1)).rejects.toThrow(/changed while it was being opened/);
        await settle(100);
        await read;
        expect(h.openKeys).toBe(0);
    });

    test('a padded file is fetched to the end of its object and written to the end of the file', async () => {
        // The trailer pushes the bucket past the first chunk: one chunk of file, one of padding.
        const size = CHUNK - 10;
        const h = harness({ sealed: { 'o-pad': { plaintextSize: size, thumbnailBytes: 1000 } } });
        h.manager.download([paddedFile('pad', size, 1000)]);
        await settle(1_000);
        const item = h.manager.getState().downloads[0]!;
        expect(item.status).toBe('done');
        // Both chunks were asked for, so the store cannot tell where the file stops...
        expect([...h.attempts.keys()].sort()).toEqual(['o-pad:0', 'o-pad:1']);
        // ...and the padding wrote nothing: the sink holds the file and only the file.
        const [sink] = h.sinks;
        expect(sink!.writes).toHaveLength(1);
        expect(sameBytes(concat(sink!.writes), chunkBytes('o-pad', 0, size))).toBe(true);
    });

    test('a read that reaches the file’s last chunk fetches the padding after it', async () => {
        const size = CHUNK - 10;
        const h = harness({ sealed: { 'o-rd': { plaintextSize: size, thumbnailBytes: 1000 } } });
        const reader = h.manager.openReader(paddedFile('rd', size, 1000));
        expect(reader.size).toBe(size);
        const all = reader.read(0, size);
        await settle(100);
        expect((await all).byteLength).toBe(size);
        // The padding chunk was asked for beside the file's last chunk, not left for a drain.
        expect([...h.attempts.keys()].sort()).toEqual(['o-rd:0', 'o-rd:1']);
        const drained = reader.drain!();
        await settle(100);
        await drained;
        // Draining after that fetches nothing more.
        expect(h.attempts.get('o-rd:1')).toBe(1);
        await reader.close();
    });

    test('a ranged read short of the file’s end fetches no padding; one at the end does', async () => {
        // Two chunks of file and, with the trailer, a bucket that leaves a third of padding.
        const size = 2 * CHUNK - 10;
        const h = harness({ sealed: { 'o-sk': { plaintextSize: size, thumbnailBytes: 1000 } } });
        const reader = h.manager.openReader(paddedFile('sk', size, 1000), 1);
        const head = reader.read(0, 100);
        await settle(100);
        await head;
        expect([...h.attempts.keys()]).toEqual(['o-sk:0']);
        // Seeking to the end, as a video's duration probe does, brings the padding with it.
        const tail = reader.read(size - 100, 100);
        await settle(100);
        expect((await tail).byteLength).toBe(100);
        expect([...h.attempts.keys()].sort()).toEqual(['o-sk:0', 'o-sk:1', 'o-sk:2']);
        // The last chunk fetched again after leaving the cache fetches its padding again.
        const back = reader.read(0, 1);
        await settle(100);
        await back;
        const again = reader.read(size - 1, 1);
        await settle(100);
        await again;
        expect(h.attempts.get('o-sk:1')).toBe(2);
        expect(h.attempts.get('o-sk:2')).toBe(2);
        await reader.close();
    });

    test('a version whose envelope promises another chunk count than the listing is refused', async () => {
        // The listing said no thumbnail (one chunk); the envelope opened says a trailer (two).
        const size = CHUNK - 10;
        const h = harness({ sealed: { 'o-x': { plaintextSize: size, thumbnailBytes: 1000 } } });
        h.manager.download([paddedFile('x', size, 0)]);
        await settle(1_000);
        const item = h.manager.getState().downloads[0]!;
        expect(item.status).toBe('failed');
        expect(item.error).toMatch(/changed while it was being opened/);
    });

    test('pause holds the next chunk fetch and the sink; resume continues where it stopped', async () => {
        const h = harness({ lookahead: 0 });
        const id = h.manager.download([file('p', 4 * CHUNK)])!;
        await settle(60);
        const written = h.sinks[0]!.writes.length;
        expect(written).toBeGreaterThanOrEqual(1);
        h.manager.pause(id);
        expect(h.manager.getState().downloads[0]!.status).toBe('paused');
        const attemptsAtPause = h.attempts.size;
        await settle(2_000);
        // Nothing new was requested and nothing new was written while paused.
        expect(h.attempts.size).toBeLessThanOrEqual(attemptsAtPause + 1);
        const writtenWhilePaused = h.sinks[0]!.writes.length;
        await settle(2_000);
        expect(h.sinks[0]!.writes.length).toBe(writtenWhilePaused);
        expect(h.manager.getState().active).toBe(0);
        h.manager.resume(id);
        expect(h.manager.getState().downloads[0]!.status).toBe('downloading');
        await settle(2_000);
        const item = h.manager.getState().downloads[0]!;
        expect(item.status).toBe('done');
        expect(h.sinks[0]!.writes.length).toBe(4);
        // Every chunk was fetched exactly once: a pause is not a retry.
        expect([...h.attempts.values()].every((n) => n === 1)).toBe(true);
    });
});
