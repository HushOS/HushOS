import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CryptoRequests, CryptoResults, UploadPartResult } from '@hushos/crypto';
import { DriveApiError, type DriveApi, type NodeView } from './api';
import type { DriveNode, Rpc } from './client';
import { createMemoryJournal } from './journal';
import { backoffDelay, createTransferManager, type UploadStash } from './transfers';

/*
 * The upload engine against a fake worker, a fake API and an in-memory journal:
 * the pool bounds parts in flight, a digest is journaled before a part is sent,
 * pause aborts and resume continues from the parts the store has, a retryable
 * failure backs off, a permanent one fails the file, cancel releases the server
 * reservation, and a journaled upload comes back after a "reload" and continues
 * only when the file proves to be the same one. No bytes, no crypto: decisions.
 */

const CHUNK = 8 * 1024 * 1024;

function node(id: string, parentId: string | null = 'root'): DriveNode {
    return {
        id,
        workspaceId: 'ws',
        parentId,
        kind: 'folder',
        keyEpoch: 1,
        parentKeyEpoch: 1,
        keyEnvelope: 'k',
        prevKeyEnvelope: null,
        prevKeyEpoch: null,
        prevParentKeyEpoch: null,
        metadataVersion: 1,
        metadataEnvelope: 'm',
        currentVersion: null,
        trashedAt: null,
        changeSeq: 1,
        createdAt: '',
        updatedAt: '',
        metadata: { name: id, mime: null, size: null, modified: null },
        name: id,
        content: null,
        openError: null,
    };
}

/* A File whose bytes never matter: the fake worker digests by name and chunk index. */
function fakeFile(size: number, name = 'file.bin', lastModified = 1_000) {
    return { name, size, type: 'application/octet-stream', lastModified } as unknown as File;
}

type SendHandler = (objectId: string, index: number) => Promise<UploadPartResult>;
type Journal = ReturnType<typeof createMemoryJournal>;

/* The app's stash, in memory: bytes by name, plus what was removed and swept. */
function fakeStash() {
    const files = new Map<string, File>();
    const removed: string[] = [];
    const stash: UploadStash & { files: Map<string, File>; removed: string[] } = {
        files,
        removed,
        async open(name, file) {
            const stored = files.get(name);
            if (!stored) throw new Error('gone');
            return fakeFile(file.size, file.name, file.lastModified);
        },
        async remove(name) {
            files.delete(name);
            removed.push(name);
        },
        async sweep(keep) {
            for (const name of Array.from(files.keys()))
                if (!keep.has(name)) await this.remove(name);
        },
    };
    return stash;
}

function harness(
    options: {
        send?: SendHandler;
        journal?: Journal;
        conflict?: boolean;
        stash?: ReturnType<typeof fakeStash>;
        random?: () => number;
        offline?: () => boolean;
    } = {},
) {
    const journal = options.journal ?? createMemoryJournal();
    const calls: string[] = [];
    /* The key epoch every created node was given. */
    const givenEpochs: number[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const flying = new Map<string, Set<(result: UploadPartResult) => void>>();
    const digestOf = (file: File, index: number) => `d-${file.name}-${index}`;
    const rpc: Rpc = async <K extends keyof CryptoRequests>(
        operation: K,
        input: CryptoRequests[K],
    ): Promise<CryptoResults[K]> => {
        calls.push(operation);
        switch (operation) {
            case 'driveCreateNodes':
                for (const n of (input as CryptoRequests['driveCreateNodes']).nodes)
                    givenEpochs.push(n.keyEpoch);
                return {
                    nodes: (input as CryptoRequests['driveCreateNodes']).nodes.map((n) => ({
                        id: n.id,
                        keyEnvelope: 'ke',
                        metadataEnvelope: 'me',
                    })),
                } as CryptoResults[K];
            case 'driveUploadPrepare':
            case 'driveUploadReopen': {
                const { plaintextSize } = input as CryptoRequests['driveUploadPrepare'];
                const chunks = Math.max(1, Math.ceil(plaintextSize / CHUNK));
                return {
                    contentNonce: 'n',
                    contentKeyEnvelope: 'c',
                    chunkCount: chunks,
                    ciphertextSize: plaintextSize + 16 * chunks,
                    thumbnail: null,
                } as CryptoResults[K];
            }
            case 'driveUploadDigest': {
                const { file, index } = input as CryptoRequests['driveUploadDigest'];
                return { digest: digestOf(file as File, index) } as CryptoResults[K];
            }
            case 'driveUploadEncrypt': {
                const { file, index } = input as CryptoRequests['driveUploadEncrypt'];
                return {
                    digest: digestOf(file as File, index),
                    bytes: CHUNK + 16,
                } as CryptoResults[K];
            }
            case 'driveUploadSend': {
                const { objectId, index } = input as CryptoRequests['driveUploadSend'];
                inFlight++;
                peakInFlight = Math.max(peakInFlight, inFlight);
                try {
                    if (options.send)
                        return (await options.send(objectId, index)) as CryptoResults[K];
                    return (await new Promise<UploadPartResult>((resolve) => {
                        const set = flying.get(objectId) ?? new Set();
                        flying.set(objectId, set);
                        const finish = (result: UploadPartResult) => {
                            set.delete(finish);
                            resolve(result);
                        };
                        set.add(finish);
                        setTimeout(
                            () => finish({ ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 }),
                            100,
                        );
                    })) as CryptoResults[K];
                } finally {
                    inFlight--;
                }
            }
            case 'driveUploadCancel': {
                const set = flying.get((input as CryptoRequests['driveUploadCancel']).objectId);
                const count = set?.size ?? 0;
                for (const finish of Array.from(set ?? []))
                    finish({
                        ok: false,
                        status: 0,
                        retryable: true,
                        message: 'Paused.',
                        cancelled: true,
                    });
                return { cancelled: count } as CryptoResults[K];
            }
            case 'driveUploadForget':
                return { forgotten: true } as CryptoResults[K];
            case 'driveUploadRewrap': {
                const { nodeId } = input as CryptoRequests['driveUploadRewrap'];
                return { contentKeyEnvelope: `rewrapped-under-${nodeId}` } as CryptoResults[K];
            }
            default:
                throw new Error(`unexpected ${operation}`);
        }
    };
    const server = {
        uploads: new Map<
            string,
            { parts: Map<number, string>; status: string; expiresAt: string }
        >(),
        aborted: [] as string[],
        completed: [] as { id: string; parts: number[] }[],
        attached: [] as { id: string; input: unknown }[],
        /* How many epochs each allocation asked for. */
        epochs: [] as number[],
    };
    let nextUpload = 0;
    let nextEpoch = 5;
    const api = {
        allocateEpochs: async (_ws: string, count: number) => {
            server.epochs.push(count);
            const from = nextEpoch;
            nextEpoch += count;
            return { from, to: from + count - 1 };
        },
        beginUpload: async (_ws: string, input: { chunkCount: number }) => {
            const id = `up-${++nextUpload}`;
            const expiresAt = new Date(Date.now() + 3600_000).toISOString();
            server.uploads.set(id, { parts: new Map(), status: 'open', expiresAt });
            return {
                upload: {
                    id,
                    nodeId: 'n',
                    versionId: 'v',
                    objectId: 'o',
                    status: 'open' as const,
                    chunkCount: input.chunkCount,
                    ciphertextSize: '0',
                    expiresAt,
                },
                parts: Array.from({ length: input.chunkCount }, (_, i) => ({
                    partNumber: i + 1,
                    length: CHUNK + 16,
                    url: `https://store/${id}/${i + 1}`,
                })),
                urlExpiresAt: expiresAt,
            };
        },
        uploadPartUrls: async (_ws: string, id: string, from: number, count = 64) => ({
            parts: Array.from({ length: count }, (_, i) => ({
                partNumber: from + i,
                length: CHUNK + 16,
                url: `https://store/${id}/${from + i}`,
            })),
            urlExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        uploadState: async (_ws: string, id: string) => {
            const upload = server.uploads.get(id);
            if (!upload) throw new Error('not found');
            return {
                upload: { id, status: upload.status, expiresAt: upload.expiresAt } as never,
                parts: [...upload.parts].map(([partNumber, etag]) => ({
                    partNumber,
                    etag,
                    size: CHUNK + 16,
                })),
            };
        },
        completeUpload: async (_ws: string, id: string, parts: { partNumber: number }[]) => {
            if (options.conflict) {
                server.uploads.get(id)!.status = 'conflicted';
                throw new DriveApiError(
                    'This file changed while it was uploading.',
                    'conflict',
                    409,
                    {
                        conflicted: true,
                        currentVersionId: 'v-winner',
                    },
                );
            }
            server.completed.push({ id, parts: parts.map((p) => p.partNumber) });
            server.uploads.get(id)!.status = 'completed';
            return {
                status: 'completed' as const,
                node: { id: 'n', parentId: 'root' } as NodeView,
            };
        },
        attachUpload: async (
            _ws: string,
            id: string,
            input: { mode: string; node?: { id: string } },
        ) => {
            const upload = server.uploads.get(id);
            if (!upload || upload.status !== 'conflicted') throw new Error('not conflicted');
            server.attached.push({ id, input });
            upload.status = 'completed';
            return {
                status: 'completed' as const,
                node: { id: input.node?.id ?? 'n', parentId: 'root' } as NodeView,
            };
        },
        abortUpload: async (_ws: string, id: string) => {
            server.aborted.push(id);
            const upload = server.uploads.get(id);
            if (upload) upload.status = 'aborted';
            return { aborted: true };
        },
    } as unknown as DriveApi;
    const published: string[] = [];
    const manager = createTransferManager({
        rpc,
        api,
        journal,
        stash: options.stash,
        random: options.random,
        offline: options.offline,
        openNodes: async () => ({ parent: node('root', null) }),
        onPublished: (n) => published.push(n.id),
        maxPartsInFlight: 3,
        maxActiveFiles: 2,
        maxAttempts: 3,
    });
    // The fake store learns of a landed part the same way the journal does: from its etag.
    const original = journal.update.bind(journal);
    journal.update = async (id, patch) => {
        await original(id, patch);
        const entry = journal.entries.get(id);
        const upload = entry && server.uploads.get(entry.uploadId);
        if (!entry || !upload) return;
        for (const [part, journaled] of Object.entries(entry.parts))
            if (journaled.etag) upload.parts.set(Number(part), journaled.etag);
    };
    return {
        manager,
        api: api as { beginUpload: DriveApi['beginUpload'] },
        calls,
        givenEpochs,
        server,
        journal,
        published,
        peak: () => peakInFlight,
        state: () => manager.getState(),
        item: (id: string) => manager.getState().uploads.find((u) => u.id === id)!,
    };
}

async function settle(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('backoff', () => {
    test('grows exponentially with full jitter and never exceeds a minute', () => {
        expect(backoffDelay(1, () => 1)).toBe(1_000);
        expect(backoffDelay(3, () => 1)).toBe(4_000);
        expect(backoffDelay(10, () => 1)).toBe(60_000);
        expect(backoffDelay(3, () => 0)).toBe(0);
        expect(backoffDelay(3, () => 0.5)).toBe(2_000);
    });
});

describe('transfer manager', () => {
    test('uploads through a bounded pool, journals digests before sends, completes once', async () => {
        const h = harness();
        const [id] = h.manager.enqueue([{ file: fakeFile(5 * CHUNK), parent: node('root', null) }]);
        await settle(2_000);
        expect(h.item(id!).status).toBe('done');
        expect(h.peak()).toBe(3);
        expect(h.server.completed).toEqual([{ id: 'up-1', parts: [1, 2, 3, 4, 5] }]);
        expect(h.published).toEqual(['n']);
        const firstSend = h.calls.indexOf('driveUploadSend');
        expect(h.calls.slice(0, firstSend)).toContain('driveUploadEncrypt');
        expect(h.journal.entries.size).toBe(0);
    });

    test('pause aborts parts in flight and resume continues from the ones that landed', async () => {
        const h = harness();
        const [id] = h.manager.enqueue([{ file: fakeFile(6 * CHUNK), parent: node('root', null) }]);
        await settle(150);
        const landed = h.item(id!).partsDone;
        expect(landed).toBeGreaterThanOrEqual(1);
        await h.manager.pause(id!);
        await settle(500);
        expect(h.item(id!).status).toBe('paused');
        const sendsWhilePaused = h.calls.filter((c) => c === 'driveUploadSend').length;
        await settle(1_000);
        expect(h.calls.filter((c) => c === 'driveUploadSend').length).toBe(sendsWhilePaused);
        await h.manager.resume(id!);
        await settle(2_000);
        expect(h.item(id!).status).toBe('done');
        expect(h.server.completed).toEqual([{ id: 'up-1', parts: [1, 2, 3, 4, 5, 6] }]);
        expect(h.calls.filter((c) => c === 'driveUploadSend').length - sendsWhilePaused).toBe(
            6 - landed,
        );
    });

    test('a pause while preparing holds the file before a byte is sent, and a resume in either order sends it once', async () => {
        const h = harness();
        // Hold the server's answer to begin, so the pause lands while the file is preparing.
        const begin = h.api.beginUpload;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        h.api.beginUpload = async (ws, input) => {
            await held;
            return begin(ws, input);
        };
        const [id] = h.manager.enqueue([{ file: fakeFile(3 * CHUNK), parent: node('root', null) }]);
        await settle(100);
        expect(h.item(id!).status).toBe('preparing');
        await h.manager.pause(id!);
        expect(h.item(id!).status).toBe('paused');
        release();
        await settle(500);
        // Prepared, journaled, and not sending: the reservation is what a resume continues from.
        expect(h.item(id!).status).toBe('paused');
        expect(h.journal.entries.size).toBe(1);
        expect(h.calls.filter((c) => c === 'driveUploadSend')).toEqual([]);
        await h.manager.resume(id!);
        await settle(2_000);
        expect(h.item(id!).status).toBe('done');
        expect(h.server.completed).toEqual([{ id: 'up-1', parts: [1, 2, 3] }]);

        // Resumed before preparation finished: it carries on, and begins on the server once.
        let releaseAgain!: () => void;
        const heldAgain = new Promise<void>((resolve) => {
            releaseAgain = resolve;
        });
        h.api.beginUpload = async (ws, input) => {
            await heldAgain;
            return begin(ws, input);
        };
        const [second] = h.manager.enqueue([
            { file: fakeFile(CHUNK, 'second.bin'), parent: node('root', null) },
        ]);
        await settle(100);
        await h.manager.pause(second!);
        expect(h.item(second!).status).toBe('paused');
        await h.manager.resume(second!);
        expect(h.item(second!).status).toBe('preparing');
        releaseAgain();
        await settle(2_000);
        expect(h.item(second!).status).toBe('done');
        expect(h.server.completed.map((c) => c.id)).toEqual(['up-1', 'up-2']);
    });

    test('a retryable part failure backs off and the file still completes', async () => {
        let failures = 0;
        const h = harness({
            // Half the ceiling every time: 500 ms then 1 s, so neither retry lands inside the first check.
            random: () => 0.5,
            send: async (_objectId, index) => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                if (index === 1 && failures < 2) {
                    failures++;
                    return { ok: false, status: 503, retryable: true, message: 'busy' };
                }
                return { ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 };
            },
        });
        const [id] = h.manager.enqueue([{ file: fakeFile(3 * CHUNK), parent: node('root', null) }]);
        await settle(200);
        expect(h.item(id!).status).toBe('uploading');
        expect(h.item(id!).partsDone).toBe(2);
        await settle(70_000);
        expect(failures).toBe(2);
        expect(h.item(id!).status).toBe('done');
        expect(h.server.completed[0]!.parts).toEqual([1, 2, 3]);
    });

    test('while offline a failing part waits for the network and the tries are not counted', async () => {
        let failures = 0;
        const h = harness({
            random: () => 0.5,
            offline: () => failures < 5,
            send: async (_objectId, index) => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                // Five failures, more than the harness's three tries, all while offline.
                if (index === 1 && failures < 5) {
                    failures++;
                    return { ok: false, status: 0, retryable: true, message: 'offline' };
                }
                return { ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 };
            },
        });
        const [id] = h.manager.enqueue([{ file: fakeFile(3 * CHUNK), parent: node('root', null) }]);
        await settle(200_000);
        expect(failures).toBe(5);
        expect(h.item(id!).status).toBe('done');
        expect(h.server.completed[0]!.parts).toEqual([1, 2, 3]);
    });

    test('a permanent part failure fails the file and keeps the journal for a retry', async () => {
        const h = harness({
            send: async (_objectId, index) => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                if (index === 0)
                    return { ok: false, status: 400, retryable: false, message: 'rejected' };
                return { ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 };
            },
        });
        const [id] = h.manager.enqueue([{ file: fakeFile(2 * CHUNK), parent: node('root', null) }]);
        await settle(500);
        expect(h.item(id!).status).toBe('failed');
        expect(h.item(id!).error).toBe('rejected');
        expect(h.server.completed).toHaveLength(0);
        expect(h.server.aborted).toHaveLength(0);
        expect(h.journal.entries.size).toBe(1);
    });

    test('cancel aborts the server upload, forgets the key, and drops the journal', async () => {
        const h = harness();
        const [id] = h.manager.enqueue([{ file: fakeFile(4 * CHUNK), parent: node('root', null) }]);
        await settle(120);
        await h.manager.cancel(id!);
        await settle(500);
        expect(h.item(id!).status).toBe('cancelled');
        expect(h.server.aborted).toEqual(['up-1']);
        expect(h.calls.filter((c) => c === 'driveUploadForget')).toHaveLength(1);
        expect(h.server.completed).toHaveLength(0);
        expect(h.journal.entries.size).toBe(0);
    });

    test('a batch takes its key epochs in one range, one round trip for the lot', async () => {
        const h = harness();
        const ids = h.manager.enqueue([
            { file: fakeFile(CHUNK), parent: node('root', null) },
            { file: fakeFile(CHUNK), parent: node('root', null) },
            { file: fakeFile(CHUNK), parent: node('root', null) },
        ]);
        await settle(1_000);
        expect(ids.map((id) => h.item(id).status)).toEqual(['done', 'done', 'done']);
        expect(h.server.epochs).toEqual([3]);
        // Each file still got an epoch of its own out of the range.
        expect(new Set(h.givenEpochs).size).toBe(3);
    });

    test('files start two at a time; the third waits its turn', async () => {
        const h = harness();
        const ids = h.manager.enqueue([
            { file: fakeFile(CHUNK), parent: node('root', null) },
            { file: fakeFile(CHUNK), parent: node('root', null) },
            { file: fakeFile(CHUNK), parent: node('root', null) },
        ]);
        await settle(0);
        expect(ids.slice(0, 2).map((id) => h.item(id).status)).not.toContain('queued');
        expect(h.item(ids[2]!).status).toBe('queued');
        await settle(1_000);
        expect(ids.map((id) => h.item(id).status)).toEqual(['done', 'done', 'done']);
    });
});

describe('journal and restore', () => {
    /* Runs an upload half way, then builds a second manager on the same journal, as a reload would. */
    async function interrupted() {
        const first = harness();
        const [id] = first.manager.enqueue([
            { file: fakeFile(6 * CHUNK, 'movie.mp4'), parent: node('root', null) },
        ]);
        await settle(150);
        await first.manager.pause(id!);
        await settle(100);
        const landed = first.item(id!).partsDone;
        expect(landed).toBeGreaterThan(0);
        expect(landed).toBeLessThan(6);
        const entry = first.journal.entries.get(id!)!;
        expect(Object.values(entry.parts).filter((part) => part.etag)).toHaveLength(landed);
        const second = harness({ journal: first.journal });
        second.server.uploads = first.server.uploads;
        return { id: id!, landed, second, entry };
    }

    test('a journaled upload comes back paused and continues once the same file is attached', async () => {
        const { id, landed, second } = await interrupted();
        const [restored] = await second.manager.restore('ws');
        expect(restored).toBe(id);
        expect(second.item(id).status).toBe('paused');
        expect(second.item(id).needsFile).toBe(true);
        expect(second.item(id).partsDone).toBe(landed);
        const result = await second.manager.attachFile(id, fakeFile(6 * CHUNK, 'movie.mp4'));
        expect(result).toEqual({ ok: true, resumed: true });
        await settle(2_000);
        expect(second.item(id).status).toBe('done');
        // The keys were reopened, never re-minted, and the landed parts were not re-sent.
        expect(second.calls).toContain('driveUploadReopen');
        expect(second.calls).not.toContain('driveUploadPrepare');
        expect(second.calls.filter((c) => c === 'driveUploadSend')).toHaveLength(6 - landed);
        expect(second.server.completed).toEqual([{ id: 'up-1', parts: [1, 2, 3, 4, 5, 6] }]);
        expect(second.journal.entries.size).toBe(0);
    });

    test('an upload the server finished while the page was away is published, never sent or begun again', async () => {
        const { id, second } = await interrupted();
        // The complete request got through after the page went: the server holds it finished.
        second.server.uploads.get('up-1')!.status = 'completed';
        await second.manager.restore('ws');
        const result = await second.manager.attachFile(id, fakeFile(6 * CHUNK, 'movie.mp4'));
        expect(result).toEqual({ ok: true, resumed: true });
        await settle(500);
        expect(second.item(id).status).toBe('done');
        expect(second.calls.filter((c) => c === 'driveUploadSend')).toHaveLength(0);
        expect(second.server.aborted).toEqual([]);
        expect(second.server.uploads.size).toBe(1);
        expect(second.journal.entries.size).toBe(0);
    });

    test('an upload the server is still finishing fails with a retry, instead of a duplicate', async () => {
        const { id, second } = await interrupted();
        second.server.uploads.get('up-1')!.status = 'completing';
        await second.manager.restore('ws');
        await second.manager.attachFile(id, fakeFile(6 * CHUNK, 'movie.mp4'));
        await settle(500);
        expect(second.item(id).status).toBe('failed');
        expect(second.server.uploads.size).toBe(1);
        expect(second.journal.entries.size).toBe(1);
        // Once the server is done, retry publishes it without a byte sent.
        second.server.uploads.get('up-1')!.status = 'completed';
        await second.manager.retry(id);
        await settle(500);
        expect(second.item(id).status).toBe('done');
        expect(second.calls.filter((c) => c === 'driveUploadSend')).toHaveLength(0);
        expect(second.server.uploads.size).toBe(1);
    });

    test('a different file starts over with a fresh object instead of continuing', async () => {
        const { id, second } = await interrupted();
        await second.manager.restore('ws');
        // Same size, different name: identity fails, so nothing is re-encrypted under the old key.
        const swapped = await second.manager.attachFile(id, fakeFile(6 * CHUNK, 'other.mp4'));
        expect(swapped).toEqual({ ok: true, resumed: false });
        await settle(2_000);
        expect(second.item(id).status).toBe('done');
        expect(second.server.aborted).toContain('up-1');
        expect(second.calls).toContain('driveUploadPrepare');
        expect(second.server.completed.at(-1)!.parts).toEqual([1, 2, 3, 4, 5, 6]);
    });

    test('a file with the same identity but different bytes also starts over', async () => {
        const { id, second, entry } = await interrupted();
        // Forge the journal so a landed chunk's digest no longer matches the file's bytes.
        const landedPart = Object.entries(entry.parts).find(([, part]) => part.etag)![0];
        second.journal.entries.set(id, {
            ...entry,
            parts: {
                ...entry.parts,
                [landedPart]: { ...entry.parts[landedPart]!, digest: 'stale' },
            },
        });
        await second.manager.restore('ws');
        const result = await second.manager.attachFile(id, fakeFile(6 * CHUNK, 'movie.mp4'));
        expect(result).toEqual({ ok: true, resumed: false });
        expect(second.calls).toContain('driveUploadDigest');
        expect(second.server.aborted).toContain('up-1');
    });

    test('an expired journal entry is discarded and the server told', async () => {
        const { id, second, entry } = await interrupted();
        second.journal.entries.set(id, {
            ...entry,
            expiresAt: new Date(Date.now() - 1).toISOString(),
        });
        const restored = await second.manager.restore('ws');
        expect(restored).toEqual([]);
        expect(second.server.aborted).toEqual(['up-1']);
        expect(second.journal.entries.size).toBe(0);
    });

    test('a lock pauses everything and resume reopens from the journal', async () => {
        let lockedOnce = false;
        const h = harness({
            send: async (_objectId, index) => {
                await new Promise((resolve) => setTimeout(resolve, 50));
                if (index === 2 && !lockedOnce) {
                    lockedOnce = true;
                    throw new Error('Your account was locked. Please try again.');
                }
                return { ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 };
            },
        });
        const [id] = h.manager.enqueue([{ file: fakeFile(4 * CHUNK), parent: node('root', null) }]);
        await settle(300);
        expect(h.item(id!).status).toBe('paused');
        expect(h.item(id!).error).toMatch(/unlock/i);
        expect(h.server.aborted).toHaveLength(0);
        const sendsBefore = h.calls.filter((c) => c === 'driveUploadSend').length;
        await h.manager.resume(id!);
        await settle(2_000);
        expect(h.calls).toContain('driveUploadReopen');
        expect(h.item(id!).status).toBe('done');
        expect(
            h.calls.filter((c) => c === 'driveUploadSend').length - sendsBefore,
        ).toBeLessThanOrEqual(2);
    });
    test('a conflict at complete attaches the finished object as a conflict copy instead of re-uploading', async () => {
        const h = harness({ conflict: true });
        const [id] = h.manager.enqueue([
            { file: fakeFile(2 * CHUNK, 'report.pdf'), parent: node('root', null) },
        ]);
        await settle(5_000);
        const item = h.item(id!);
        expect(item.error).toBeNull();
        expect(item.status).toBe('done');
        expect(item.name).toBe('report (conflict copy).pdf');
        expect(h.server.attached).toHaveLength(1);
        const attach = h.server.attached[0]!.input as {
            mode: string;
            node: { id: string; parentId: string };
            contentKeyEnvelope: string;
        };
        expect(attach.mode).toBe('sibling');
        expect(attach.node.parentId).toBe('root');
        expect(attach.contentKeyEnvelope).toBe(`rewrapped-under-${attach.node.id}`);
        expect(h.published).toEqual([attach.node.id]);
        // Nothing was sent twice, nothing aborted, and the journal row is gone.
        expect(h.calls.filter((call) => call === 'driveUploadSend')).toHaveLength(2);
        expect(h.server.aborted).toEqual([]);
        expect(h.journal.entries.size).toBe(0);
    });

    test('a refusal for lack of room fails the upload with the code the app needs to offer a way out', async () => {
        const h = harness({});
        const begin = h.api.beginUpload;
        h.api.beginUpload = async () => {
            throw new DriveApiError('Not enough storage for this file.', 'over-quota', 402, {
                freeBytes: '0',
            });
        };
        const [id] = h.manager.enqueue([{ file: fakeFile(CHUNK), parent: node('root', null) }]);
        await settle(1_000);
        const item = h.item(id!);
        expect(item.status).toBe('failed');
        expect(item.errorCode).toBe('over-quota');
        expect(item.error).toMatch(/Not enough storage/);
        // Room found: a retry starts over and goes through.
        h.api.beginUpload = begin;
        await h.manager.retry(id!);
        await settle(3_000);
        expect(h.item(id!).status).toBe('done');
        expect(h.item(id!).errorCode).toBeNull();
    });
});

describe('queued rows and stashed copies', () => {
    test('files still waiting when the page went away come back and start once their file is attached', async () => {
        const first = harness();
        const ids = first.manager.enqueue([
            { file: fakeFile(CHUNK, 'a.bin'), parent: node('root', null) },
            { file: fakeFile(CHUNK, 'b.bin'), parent: node('root', null) },
            { file: fakeFile(CHUNK, 'c.bin'), parent: node('root', null) },
        ]);
        await settle(10);
        // Two began (the active-file limit); the third only ever reached its queued row.
        expect(first.item(ids[2]!).status).toBe('queued');
        expect(first.journal.queued.size).toBe(3);
        expect(first.journal.entries.has(ids[2]!)).toBe(false);
        const second = harness({ journal: first.journal });
        second.server.uploads = first.server.uploads;
        const restored = await second.manager.restore('ws');
        expect(restored).toHaveLength(3);
        const third = second.item(ids[2]!);
        expect(third.status).toBe('paused');
        expect(third.needsFile).toBe(true);
        expect(third.partsDone).toBe(0);
        // Not the file that was waiting: refused, and nothing is sent under its name.
        expect(await second.manager.attachFile(ids[2]!, fakeFile(CHUNK, 'other.bin'))).toEqual({
            ok: false,
            reason: 'different',
        });
        expect(second.item(ids[2]!).status).toBe('paused');
        expect(second.calls).not.toContain('driveUploadPrepare');
        expect(await second.manager.attachFile(ids[2]!, fakeFile(CHUNK, 'c.bin'))).toEqual({
            ok: true,
            resumed: false,
        });
        await settle(2_000);
        expect(second.item(ids[2]!).status).toBe('done');
        expect(second.calls).toContain('driveUploadPrepare');
        expect(second.journal.queued.has(ids[2]!)).toBe(false);
        expect(second.journal.entries.has(ids[2]!)).toBe(false);
    });

    test('a copy comes back from its stash and finishes without being asked', async () => {
        const stash = fakeStash();
        stash.files.set('copy-1', fakeFile(6 * CHUNK, 'movie.mp4'));
        const first = harness({ stash });
        const [id] = first.manager.enqueue([
            {
                file: fakeFile(6 * CHUNK, 'movie.mp4'),
                parent: node('root', null),
                origin: 'copy',
                stash: 'copy-1',
            },
        ]);
        await settle(150);
        await first.manager.pause(id!);
        await settle(100);
        const landed = first.item(id!).partsDone;
        expect(landed).toBeGreaterThan(0);
        expect(landed).toBeLessThan(6);
        const second = harness({ journal: first.journal, stash });
        second.server.uploads = first.server.uploads;
        await second.manager.restore('ws');
        await settle(2_000);
        expect(second.item(id!).status).toBe('done');
        // Resumed from the journal's keys and the landed parts, not begun again.
        expect(second.calls).toContain('driveUploadReopen');
        expect(second.calls).not.toContain('driveUploadPrepare');
        expect(second.calls.filter((c) => c === 'driveUploadSend')).toHaveLength(6 - landed);
        expect(second.server.completed).toEqual([{ id: 'up-1', parts: [1, 2, 3, 4, 5, 6] }]);
        expect(stash.removed).toEqual(['copy-1']);
        expect(second.journal.entries.size).toBe(0);
        expect(second.journal.queued.size).toBe(0);
    });

    test('a copy without bytes on this device is reported lost, its reservation released, no file picker offered', async () => {
        const stash = fakeStash();
        stash.files.set('copy-1', fakeFile(2 * CHUNK, 'stashed.bin'));
        const first = harness({ stash });
        const [stashed, unstashed] = first.manager.enqueue([
            {
                file: fakeFile(2 * CHUNK, 'stashed.bin'),
                parent: node('root', null),
                origin: 'copy',
                stash: 'copy-1',
            },
            // A browser that could not stash: the copy lives only in memory.
            { file: fakeFile(2 * CHUNK, 'plain.bin'), parent: node('root', null), origin: 'copy' },
        ]);
        await settle(50);
        await first.manager.pause(stashed!);
        await first.manager.pause(unstashed!);
        await settle(100);
        expect(first.journal.entries.size).toBe(2);
        // Site data cleared: the stash is gone too.
        stash.files.clear();
        const second = harness({ journal: first.journal, stash });
        second.server.uploads = first.server.uploads;
        await second.manager.restore('ws');
        await settle(100);
        for (const id of [stashed!, unstashed!]) {
            const item = second.item(id);
            expect(item.status).toBe('failed');
            expect(item.error).toMatch(/Save it again/);
            expect(item.needsFile).toBe(true);
            expect(item.hasHandle).toBe(false);
        }
        expect(second.server.aborted.sort()).toEqual(['up-1', 'up-2']);
        expect(second.journal.entries.size).toBe(0);
        expect(second.journal.queued.size).toBe(0);
        // Nothing to retry with: the row stays as it is until removed.
        await second.manager.retry(stashed!);
        expect(second.item(stashed!).status).toBe('failed');
        expect(second.calls).not.toContain('driveUploadPrepare');
    });
});
