import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CryptoRequests, CryptoResults, UploadPartResult } from '@hushos/crypto';
import { KEY_CHANGE_PENDING } from '@hushos/crypto/protocol';
import { DriveApiError, type DriveApi, type NodeView } from './api';
import type { DriveNode, Rpc } from './client';
import { scopedId } from '../../db/src/ids';
import { createMemoryJournal } from './journal';
import {
    backoffDelay,
    createTransferManager,
    KEY_CHANGE_GAVE_UP,
    VERSION_MOVED,
    type TransferManagerOptions,
    type UploadStash,
    type MemoryFile,
    StashGone,
} from './transfers';

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
        envelopeSuite: 1,
        metadataSigner: null,
        metadataSignature: null,
        integrity: null,
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
    /* Stashes of real bytes, reopened as memory files (a fresh copy each time), not Files. */
    const bytes = new Map<string, Uint8Array>();
    const removed: string[] = [];
    const stash: UploadStash & {
        files: Map<string, File>;
        bytes: Map<string, Uint8Array>;
        removed: string[];
    } = {
        files,
        bytes,
        removed,
        async open(name, file) {
            const held = bytes.get(name);
            if (held) {
                const opened: MemoryFile = {
                    kind: 'memory',
                    name: file.name,
                    size: held.byteLength,
                    type: file.type,
                    lastModified: file.lastModified,
                    parts: [held.slice()],
                };
                return opened;
            }
            const stored = files.get(name);
            if (!stored) throw new StashGone('gone');
            return fakeFile(file.size, file.name, file.lastModified);
        },
        async remove(name) {
            files.delete(name);
            bytes.delete(name);
            removed.push(name);
        },
        async sweep(keep) {
            for (const name of [...files.keys(), ...bytes.keys()])
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
        /* What the fake worker hashes a chunk to; by name and index unless a test changes the bytes. */
        digest?: (file: File, index: number) => string;
        refuseWrite?: (target: DriveNode) => string | null;
        waitsForKeyChange?: (target: DriveNode) => boolean;
        openNodes?: TransferManagerOptions['openNodes'];
        keyChangePause?: TransferManagerOptions['keyChangePause'];
        keyChangeGiveUpMs?: number;
        onEvent?: TransferManagerOptions['onEvent'];
        /* The worker refuses a node under this parent epoch: a key change has not reached it. */
        keyChangePendingAt?: (parentKeyEpoch: number) => boolean;
        /* The worker dies mid-attach: the parts are moved, then the call fails with a lock. */
        attachLocks?: boolean;
        /* Held until it resolves: the attach, and the encrypt of a chunk index, still on their way. */
        attachHold?: () => Promise<void>;
        encryptHold?: (index: number) => Promise<void> | undefined;
    } = {},
) {
    const journal = options.journal ?? createMemoryJournal();
    const calls: string[] = [];
    /* The statement each signing call was asked for, in order. */
    const signed: { operation: string; signAs: string | undefined }[] = [];
    /* The key epoch every created node was given, and the parent epoch its key was wrapped under. */
    const givenEpochs: number[] = [];
    const wrappedUnder: number[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const flying = new Map<string, Set<(result: UploadPartResult) => void>>();
    const digestOf = options.digest ?? ((file: File, index: number) => `d-${file.name}-${index}`);
    /* Attached in-memory bytes, as the worker holds them, and what each read chunk held. */
    const sources = new Map<string, Uint8Array[]>();
    const readChunks = new Map<string, Uint8Array>();
    const released: string[] = [];
    const preparedThumbnails: (Uint8Array | null)[] = [];
    const readSource = (sourceId: string, index: number) => {
        const parts = sources.get(sourceId);
        if (!parts) throw new Error('This upload’s bytes are no longer on this device.');
        const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
        let at = 0;
        for (const part of parts) {
            joined.set(part, at);
            at += part.byteLength;
        }
        return joined.slice(index * CHUNK, (index + 1) * CHUNK);
    };
    const digestOfInput = (file: CryptoRequests['driveUploadEncrypt']['file'], index: number) => {
        if (file instanceof Blob || !('source' in file)) return digestOf(file as File, index);
        const chunk = readSource(file.source, index);
        readChunks.set(`${file.source}:${index}`, chunk);
        // Enough of the bytes to tell chunks apart, cheaply; the test compares them in full.
        const at = (i: number) => chunk[Math.min(i, chunk.length - 1)] ?? 0;
        return `d-mem-${index}-${chunk.length}-${at(0)}-${at(4096)}-${at(chunk.length - 1)}`;
    };
    const rpc: Rpc = async <K extends keyof CryptoRequests>(
        operation: K,
        input: CryptoRequests[K],
        rpcOptions?: { transfer?: Transferable[] },
    ): Promise<CryptoResults[K]> => {
        calls.push(operation);
        switch (operation) {
            case 'driveSourceAttach': {
                const { sourceId, parts } = input as CryptoRequests['driveSourceAttach'];
                // As postMessage does: what is listed for transfer moves, and is detached here.
                const moved = structuredClone(parts, { transfer: rpcOptions?.transfer ?? [] });
                if (options.attachLocks)
                    throw new Error('Your account was locked. Please try again.');
                sources.set(sourceId, moved);
                await options.attachHold?.();
                return {
                    size: moved.reduce((total, part) => total + part.byteLength, 0),
                } as CryptoResults[K];
            }
            case 'driveSourceRelease': {
                const { sourceId } = input as CryptoRequests['driveSourceRelease'];
                released.push(sourceId);
                return { released: sources.delete(sourceId) } as CryptoResults[K];
            }
            case 'driveCreateNodes':
                for (const n of (input as CryptoRequests['driveCreateNodes']).nodes)
                    if (options.keyChangePendingAt?.(n.parentKeyEpoch))
                        throw new Error(KEY_CHANGE_PENDING);
                for (const n of (input as CryptoRequests['driveCreateNodes']).nodes) {
                    givenEpochs.push(n.keyEpoch);
                    wrappedUnder.push(n.parentKeyEpoch);
                    signed.push({ operation, signAs: n.signAs });
                }
                return {
                    // A node key's envelope names the parent epoch it was wrapped under.
                    nodes: (input as CryptoRequests['driveCreateNodes']).nodes.map((n) => ({
                        id: n.id,
                        keyEnvelope: `ke-under-${n.parentKeyEpoch}`,
                        metadataEnvelope: 'me',
                    })),
                } as CryptoResults[K];
            case 'driveUploadPrepare':
            case 'driveUploadReopen': {
                const { plaintextSize } = input as CryptoRequests['driveUploadPrepare'];
                if (operation === 'driveUploadPrepare')
                    preparedThumbnails.push(
                        (input as CryptoRequests['driveUploadPrepare']).thumbnail ?? null,
                    );
                if (operation === 'driveUploadPrepare')
                    signed.push({
                        operation,
                        signAs: (input as CryptoRequests['driveUploadPrepare']).signAs,
                    });
                const chunks = Math.max(1, Math.ceil(plaintextSize / CHUNK));
                // Every prepare mints a fresh content key, so its envelope is never the same twice.
                return {
                    contentNonce: 'n',
                    contentKeyEnvelope: `c-${calls.filter((call) => call === operation).length}`,
                    chunkCount: chunks,
                    ciphertextSize: plaintextSize + 16 * chunks,
                    thumbnail: null,
                } as CryptoResults[K];
            }
            case 'driveUploadDigest': {
                const { file, index } = input as CryptoRequests['driveUploadDigest'];
                return { digest: digestOfInput(file, index) } as CryptoResults[K];
            }
            case 'driveUploadEncrypt': {
                const { file, index } = input as CryptoRequests['driveUploadEncrypt'];
                await options.encryptHold?.(index);
                return {
                    digest: digestOfInput(file, index),
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
                const { nodeId, signAs } = input as CryptoRequests['driveUploadRewrap'];
                signed.push({ operation, signAs });
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
        /* Every begin as sent, ids and seeds included. */
        begins: [] as Parameters<DriveApi['beginUpload']>[1][],
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
        beginUpload: async (_ws: string, input: Parameters<DriveApi['beginUpload']>[1]) => {
            server.begins.push(input);
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
        openNodes: options.openNodes ?? (async () => ({ parent: node('root', null) })),
        refuseWrite: options.refuseWrite,
        waitsForKeyChange: options.waitsForKeyChange,
        keyChangeRecheckMs: 1_000,
        keyChangePause: options.keyChangePause,
        keyChangeGiveUpMs: options.keyChangeGiveUpMs,
        onEvent: options.onEvent,
        onPublished: (n) => published.push(n.id),
        // Ids as the server derives them, minted without Web Crypto's real-time digest,
        // which fake timers would never let resolve.
        newId: async (kind, workspaceId) => {
            const seed = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
                'base64url',
            );
            return { id: scopedId(kind, workspaceId, seed)!, seed };
        },
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
        signed,
        givenEpochs,
        wrappedUnder,
        server,
        journal,
        published,
        peak: () => peakInFlight,
        sources,
        readChunks,
        released,
        preparedThumbnails,
        /* An explicit lock ends the worker: everything it held goes, unseen by the engine. */
        lockWorker: () => sources.clear(),
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
    test('a key change that lands after a file was queued stops it at prepare, and a retry goes once the walk reached the folder', async () => {
        // The running key change's target epoch, null before it lands; what the walk has re-keyed.
        let target: number | null = null;
        const epochs = new Map([
            ['waiting', 1],
            ['old', 1],
        ]);
        const at = (id: string, parentId: string | null = 'root') => ({
            ...node(id, parentId),
            keyEpoch: epochs.get(id) ?? 9,
        });
        const existing = { ...at('old'), kind: 'file' as const };
        const h = harness({
            // As the app's refusal reads it: by the key epoch of the node it is handed.
            refuseWrite: (t) =>
                target !== null && t.keyEpoch < target ? 'Finishing a key change.' : null,
            // The folder (and the file replaced) as listed now, not as when queued.
            openNodes: async (entry) => ({
                parent: at(entry.parentId, null),
                ...('replacesId' in entry && entry.replacesId
                    ? { replaces: { ...at(entry.replacesId), kind: 'file' as const } }
                    : {}),
            }),
        });
        const [intoFolder, replacing] = h.manager.enqueue([
            { file: fakeFile(CHUNK), parent: at('waiting') },
            { file: fakeFile(CHUNK), parent: at('root', null), replaces: existing },
        ]);
        target = 5;
        await settle(2_000);
        for (const id of [intoFolder!, replacing!]) {
            expect(h.item(id).status).toBe('failed');
            expect(h.item(id).error).toBe('Finishing a key change.');
        }
        // Nothing was wrapped under the old keys, and the server saw nothing.
        for (const operation of ['driveCreateNodes', 'driveUploadPrepare', 'driveUploadSend'])
            expect(h.calls).not.toContain(operation);
        expect(h.server.uploads.size).toBe(0);
        // The walk re-keys both: the snapshots taken when they were queued are still at epoch 1,
        // so a retry goes only because the folder and the file are looked up again.
        epochs.set('waiting', 5);
        epochs.set('old', 5);
        await h.manager.retry(intoFolder!);
        await h.manager.retry(replacing!);
        await settle(2_000);
        expect(h.item(intoFolder!).status).toBe('done');
        expect(h.item(replacing!).status).toBe('done');
        expect(h.givenEpochs.length).toBe(1);
    });

    test('an upload into a folder a key change has not reached waits without a slot, and goes once the walk re-keyed it; any other refusal still fails', async () => {
        let target: number | null = 5;
        const epochs = new Map([
            ['waiting', 1],
            ['old', 1],
        ]);
        const at = (id: string, parentId: string | null = 'root') => ({
            ...node(id, parentId),
            keyEpoch: epochs.get(id) ?? 9,
        });
        const existing = { ...at('old'), kind: 'file' as const };
        const h = harness({
            refuseWrite: (t) =>
                t.id === 'shut'
                    ? 'You can open this folder but not add to it.'
                    : target !== null && t.keyEpoch < target
                      ? 'Finishing a key change.'
                      : null,
            waitsForKeyChange: (t) => t.id !== 'shut' && target !== null && t.keyEpoch < target,
            openNodes: async (entry) => ({
                parent: at(entry.parentId, null),
                ...('replacesId' in entry && entry.replacesId
                    ? { replaces: { ...at(entry.replacesId), kind: 'file' as const } }
                    : {}),
            }),
        });
        const [intoFolder, replacing, shut] = h.manager.enqueue([
            { file: fakeFile(CHUNK), parent: at('waiting') },
            { file: fakeFile(CHUNK), parent: at('root', null), replaces: existing },
            { file: fakeFile(CHUNK), parent: at('shut') },
        ]);
        await settle(5_000);
        // The two waiting say why and hold nothing made; the refused one failed as before.
        for (const id of [intoFolder!, replacing!]) {
            expect(h.item(id)).toMatchObject({
                status: 'preparing',
                waitingFor: 'Finishing a key change.',
            });
        }
        expect(h.item(shut!)).toMatchObject({
            status: 'failed',
            error: 'You can open this folder but not add to it.',
        });
        for (const operation of ['driveCreateNodes', 'driveUploadPrepare', 'driveUploadSend'])
            expect(h.calls).not.toContain(operation);
        // Waiting holds no slot (two at a time here): an upload elsewhere goes meanwhile.
        const [elsewhere] = h.manager.enqueue([
            { file: fakeFile(CHUNK), parent: at('root', null) },
        ]);
        await settle(5_000);
        expect(h.item(elsewhere!).status).toBe('done');
        expect(h.item(intoFolder!).status).toBe('preparing');
        // The walk re-keys the folder and the file: at the next look they go by themselves.
        epochs.set('waiting', 5);
        epochs.set('old', 5);
        await settle(5_000);
        expect(h.item(intoFolder!)).toMatchObject({ status: 'done', waitingFor: null });
        expect(h.item(replacing!)).toMatchObject({ status: 'done', waitingFor: null });
        target = null;
    });

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

    test('a part retried after the file changed under it starts over, never re-sent under the same nonce', async () => {
        let encryptions = 0;
        const h = harness({
            random: () => 0.5,
            // The second chunk reads differently the second time it is encrypted.
            digest: (file, index) =>
                index === 1 && ++encryptions > 1 ? 'changed' : `d-${file.name}-${index}`,
            send: async (_objectId, index) => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                if (index === 1 && encryptions === 1)
                    return { ok: false, status: 503, retryable: true, message: 'busy' };
                return { ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 };
            },
        });
        const [id] = h.manager.enqueue([{ file: fakeFile(3 * CHUNK), parent: node('root', null) }]);
        await settle(5_000);
        // The first object is abandoned, and the changed bytes went out only in a fresh one.
        expect(h.server.aborted).toContain('up-1');
        expect(h.calls.filter((c) => c === 'driveUploadPrepare').length).toBeGreaterThan(1);
        expect(h.server.completed.some((c) => c.id === 'up-1')).toBe(false);
        expect(h.item(id!).status).not.toBe('failed');
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

    test('every new id goes to begin with the seed that derives it there; starting over mints new ones', async () => {
        const { id, second, entry } = await interrupted();
        // Nothing has begun on the reloaded side yet.
        expect(second.server.begins).toEqual([]);
        // The journal kept the seeds the first begin sent, beside the ids they derive.
        expect(entry.idSeeds).toBeDefined();
        expect(scopedId('node', 'ws', entry.idSeeds!.node!)).toBe(entry.nodeId);
        expect(scopedId('version', 'ws', entry.idSeeds!.version)).toBe(entry.versionId);
        expect(scopedId('object', 'ws', entry.idSeeds!.object)).toBe(entry.objectId);
        await second.manager.restore('ws');
        await second.manager.attachFile(id, fakeFile(6 * CHUNK, 'other.mp4'));
        await settle(2_000);
        const [again] = second.server.begins;
        expect(again).toBeDefined();
        if (again!.node.existing) throw new Error('a new file begins a new node');
        expect(scopedId('node', 'ws', again!.node.idSeed)).toBe(again!.node.id);
        expect(scopedId('version', 'ws', again!.versionIdSeed)).toBe(again!.versionId);
        expect(scopedId('object', 'ws', again!.objectIdSeed)).toBe(again!.objectId);
        // Fresh material for a fresh object: none of the abandoned ids or seeds comes back.
        expect(again!.node.id).not.toBe(entry.nodeId);
        expect(again!.objectId).not.toBe(entry.objectId);
        expect(again!.versionIdSeed).not.toBe(entry.idSeeds!.version);
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

    test('a part sent without an answer must match too: the store may hold it under the same nonce', async () => {
        const { id, second, entry } = await interrupted();
        // A part whose digest was journaled before its send, with no etag back: changed bytes there.
        const landed = Object.keys(entry.parts).map(Number);
        const unanswered = String(Math.max(...landed) + 1);
        second.journal.entries.set(id, {
            ...entry,
            parts: { ...entry.parts, [unanswered]: { digest: 'stale' } },
        });
        await second.manager.restore('ws');
        const result = await second.manager.attachFile(id, fakeFile(6 * CHUNK, 'movie.mp4'));
        expect(result).toEqual({ ok: true, resumed: false });
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

    test('an attach after a conflict waits for a key change that landed meanwhile, then writes', async () => {
        // The key change lands while the upload is in flight: its conflict copy would be wrapped
        // under the folder's old key, so the attach waits like any upload.
        let target: number | null = null;
        const epochs = new Map([['waiting', 1]]);
        const at = (id: string) => ({ ...node(id, 'root'), keyEpoch: epochs.get(id) ?? 9 });
        const h = harness({
            conflict: true,
            refuseWrite: (t) =>
                target !== null && t.keyEpoch < target ? 'Finishing a key change.' : null,
            waitsForKeyChange: (t) => target !== null && t.keyEpoch < target,
            openNodes: async (entry) => ({ parent: at(entry.parentId) }),
        });
        const api = h.api as unknown as DriveApi;
        const complete = api.completeUpload.bind(api);
        api.completeUpload = (async (...args: Parameters<typeof complete>) => {
            target = 5;
            return complete(...args);
        }) as typeof complete;
        const [id] = h.manager.enqueue([{ file: fakeFile(2 * CHUNK), parent: at('waiting') }]);
        await settle(5_000);
        expect(h.item(id!)).toMatchObject({ waitingFor: 'Finishing a key change.' });
        expect(h.server.attached).toEqual([]);
        // The walk reaches the folder: the conflict copy goes under its new key.
        epochs.set('waiting', 5);
        await settle(5_000);
        expect(h.item(id!)).toMatchObject({ status: 'done', waitingFor: null });
        expect(h.server.attached).toHaveLength(1);
    });

    test('a waiting upload can be cancelled, and nothing is made for it', async () => {
        const h = harness({
            refuseWrite: () => 'Finishing a key change.',
            waitsForKeyChange: () => true,
            openNodes: async (entry) => ({
                parent: { ...node(entry.parentId, 'root'), keyEpoch: 1 },
            }),
        });
        const [id] = h.manager.enqueue([
            { file: fakeFile(CHUNK), parent: { ...node('waiting', 'root'), keyEpoch: 1 } },
        ]);
        await settle(3_000);
        expect(h.item(id!).waitingFor).toBe('Finishing a key change.');
        await h.manager.cancel(id!);
        await settle(5_000);
        expect(h.item(id!).status).toBe('cancelled');
        for (const operation of ['driveCreateNodes', 'driveUploadPrepare'])
            expect(h.calls).not.toContain(operation);
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

describe('a key change the server says nothing of (design 2.10, F14)', () => {
    test('the worker refusing the folder’s old key is waited out like a 409, and the upload lands under the new key', async () => {
        // The server serves the folder under its old key and refuses nothing; only the worker,
        // whose member list says the folder's key changed, will not seal under it.
        const folder = { epoch: 1 };
        const pauses: number[] = [];
        const h = harness({
            openNodes: async () => ({
                parent: { ...node('trips', 'root'), keyEpoch: folder.epoch },
            }),
            keyChangePause: async (_target, attempt) => {
                pauses.push(attempt);
                await new Promise((resolve) => setTimeout(resolve, 1_000));
            },
            keyChangePendingAt: (parentKeyEpoch) => parentKeyEpoch < 5,
        });
        const [id] = h.manager.enqueue([
            { file: fakeFile(CHUNK), parent: { ...node('trips', 'root'), keyEpoch: 1 } },
        ]);
        await settle(3_000);
        // Waiting, never failed, and nothing begun under the old key.
        expect(h.item(id!)).toMatchObject({ status: 'preparing', error: null });
        expect(h.item(id!).waitingFor).toBe(KEY_CHANGE_PENDING);
        expect(h.server.begins).toHaveLength(0);
        // The walk re-keys the folder: the next look finds the new key, and it lands under it.
        folder.epoch = 5;
        await settle(5_000);
        expect(h.item(id!)).toMatchObject({ status: 'done', error: null, waitingFor: null });
        expect(h.server.begins).toHaveLength(1);
        expect(h.server.begins[0]!.node).toMatchObject({
            parentKeyEpoch: 5,
            keyEnvelope: 'ke-under-5',
        });
        expect(pauses.length).toBeGreaterThan(0);
    });
});

describe('a key change this device has not heard of (409 rotating)', () => {
    /*
     * A family folder, "trips", and the server's side of a key change walking
     * it, judged as packages/db's beginUpload and attachUpload judge them: a new
     * node there is refused as `rotating` while the walk has not reached the
     * folder (its key epoch below the target), and as `stale` when its key is
     * wrapped under any epoch but the folder's own. The app's own view
     * (refuseWrite) never hears of the change: it started a moment after the
     * file was queued, so only the server's answer says to wait.
     */
    function family(
        options: Parameters<typeof harness>[0] & {
            /* At this look, the walk finishes right after the folder was listed under its old key. */
            raceAtLook?: number;
        } = {},
    ) {
        const { raceAtLook, ...rest } = options;
        // The folder, and a file in it, as the server holds them; the walk re-keys both.
        const folder = { epoch: 1, target: null as number | null, file: 1, version: 'v1' };
        const at = () => ({ ...node('trips', 'root'), keyEpoch: folder.epoch });
        const file = () => ({
            ...node('old', 'trips'),
            kind: 'file' as const,
            keyEpoch: folder.file,
            currentVersion: { id: folder.version } as DriveNode['currentVersion'],
        });
        const pauses: number[] = [];
        let looks = 0;
        const walked = () => {
            folder.epoch = folder.target ?? folder.epoch;
            folder.file = folder.target ?? folder.file;
            folder.target = null;
        };
        const h = harness({
            // The folder (and the file replaced) as the server lists them now.
            openNodes: async (entry) => {
                const listed = {
                    parent: at(),
                    ...('replacesId' in entry && entry.replacesId ? { replaces: file() } : {}),
                };
                if (++looks === raceAtLook) walked();
                return listed;
            },
            // The app's pause: a sync of the family, a second here.
            keyChangePause: async (_target, attempt) => {
                pauses.push(attempt);
                await new Promise((resolve) => setTimeout(resolve, 1_000));
            },
            ...rest,
        });
        const rotating = () =>
            new DriveApiError(
                'Keys are being rotated for this folder. Try again in a moment.',
                'rotating',
                409,
            );
        const stale = () =>
            new DriveApiError(
                'This item changed since you last saw it. Refresh and try again.',
                'stale',
                409,
            );
        const walking = (epoch: number) => folder.target !== null && epoch < folder.target;
        // As packages/db judges a node in trips: `rotating` first, then `stale`.
        const judge = (parentKeyEpoch: number) => {
            if (walking(folder.epoch)) throw rotating();
            if (parentKeyEpoch !== folder.epoch) throw stale();
        };
        /* Every begin sent, refused ones included. */
        const tried: Parameters<DriveApi['beginUpload']>[1][] = [];
        const api = h.api as unknown as DriveApi;
        const begin = api.beginUpload.bind(api);
        api.beginUpload = (async (ws, input) => {
            tried.push(input);
            if (input.node.existing) {
                if (walking(folder.file)) throw rotating();
                if (input.node.keyEpoch !== folder.file) throw stale();
                if (input.node.expectedVersionId !== folder.version) throw stale();
            } else if (input.node.parentId === 'trips') judge(input.node.parentKeyEpoch);
            return begin(ws, input);
        }) as typeof begin;
        const attach = api.attachUpload.bind(api);
        api.attachUpload = (async (ws, id, input) => {
            if (input.mode === 'sibling' && input.node.parentId === 'trips')
                judge(input.node.parentKeyEpoch);
            return attach(ws, id, input);
        }) as typeof attach;
        return {
            ...h,
            api,
            at,
            file,
            folder,
            pauses,
            tried,
            // The key change starts: the folder keeps its old key until the walk reaches it.
            start: (target: number) => {
                folder.target = target;
            },
            // The walk re-keys the folder (and the file) and the run ends.
            walked,
        };
    }

    test('a refused begin waits, says so, and lands by itself once the walk is done, sealed afresh under the folder’s new key', async () => {
        const f = family();
        const [id] = f.manager.enqueue([{ file: fakeFile(CHUNK), parent: f.at() }]);
        f.start(5);
        await settle(500);
        // Refused once, under the old key: it waits rather than failing, and holds no slot.
        expect(f.tried).toHaveLength(1);
        expect(f.tried[0]!.node).toMatchObject({ parentKeyEpoch: 1 });
        expect(f.item(id!)).toMatchObject({ status: 'preparing', error: null });
        expect(f.item(id!).waitingFor).toBeTruthy();
        expect(f.state().active).toBe(0);
        // Still walking: refused again at each look, never failed, nothing reserved.
        await settle(5_000);
        expect(f.item(id!).status).toBe('preparing');
        expect(f.server.uploads.size).toBe(0);
        // The walk reaches the folder: nobody presses anything, and it lands.
        f.walked();
        await settle(5_000);
        expect(f.item(id!)).toMatchObject({ status: 'done', error: null, waitingFor: null });
        expect(f.server.begins).toHaveLength(1);
        const landed = f.server.begins[0]!;
        // The node's key wrapped under the folder's new key, and a content key never sent before.
        expect(landed.node).toMatchObject({
            existing: false,
            parentKeyEpoch: 5,
            keyEnvelope: 'ke-under-5',
        });
        const refused = f.tried.slice(0, -1).map((input) => input.contentKeyEnvelope);
        expect(refused).not.toContain(landed.contentKeyEnvelope);
        expect(f.pauses[0]).toBe(1);
    });

    test('a refused attach waits the same way, then attaches the sent bytes under the folder’s new key', async () => {
        const f = family({ conflict: true });
        // The key change lands while the bytes are in flight: completing finds the node moved on.
        const complete = f.api.completeUpload.bind(f.api);
        f.api.completeUpload = (async (...args: Parameters<typeof complete>) => {
            f.start(5);
            return complete(...args);
        }) as typeof complete;
        const [id] = f.manager.enqueue([{ file: fakeFile(2 * CHUNK), parent: f.at() }]);
        await settle(3_000);
        expect(f.item(id!)).toMatchObject({ status: 'completing', error: null });
        expect(f.item(id!).waitingFor).toBeTruthy();
        expect(f.state().active).toBe(0);
        expect(f.server.attached).toEqual([]);
        f.walked();
        await settle(5_000);
        expect(f.item(id!)).toMatchObject({ status: 'done', error: null, waitingFor: null });
        expect(f.server.attached).toHaveLength(1);
        const attached = f.server.attached[0]!.input as {
            mode: string;
            node: { id: string; parentKeyEpoch: number; keyEnvelope: string };
            contentKeyEnvelope: string;
        };
        expect(attached.mode).toBe('sibling');
        expect(attached.node).toMatchObject({ parentKeyEpoch: 5, keyEnvelope: 'ke-under-5' });
        expect(attached.contentKeyEnvelope).toBe(`rewrapped-under-${attached.node.id}`);
        // Attaching never sends the bytes again.
        expect(f.calls.filter((call) => call === 'driveUploadSend')).toHaveLength(2);
    });

    test('a retry after a key change looks the folder up again and seals afresh, never resending the old envelopes', async () => {
        const f = family();
        const begin = f.api.beginUpload.bind(f.api);
        let reachable = false;
        f.api.beginUpload = (async (...args: Parameters<typeof begin>) => {
            if (!reachable) throw new Error('Failed to fetch');
            return begin(...args);
        }) as typeof begin;
        const [id] = f.manager.enqueue([{ file: fakeFile(CHUNK), parent: f.at() }]);
        await settle(1_000);
        expect(f.item(id!).status).toBe('failed');
        // Meanwhile a key change re-keyed the folder and finished: nothing on this device says so.
        f.start(5);
        f.walked();
        reachable = true;
        await f.manager.retry(id!);
        await settle(3_000);
        expect(f.item(id!)).toMatchObject({ status: 'done', error: null });
        expect(f.server.begins.at(-1)!.node).toMatchObject({
            parentKeyEpoch: 5,
            keyEnvelope: 'ke-under-5',
        });
    });

    test('a key change that never finishes gives up after the wait, cleanly; once it is done a retry lands', async () => {
        const pauses: number[] = [];
        const f = family({
            keyChangeGiveUpMs: 60_000,
            // An app whose pause never returns (a sync that hangs) must not hold the upload forever.
            keyChangePause: (_target, attempt) => {
                pauses.push(attempt);
                return new Promise(() => {});
            },
        });
        f.start(5);
        const [id] = f.manager.enqueue([{ file: fakeFile(CHUNK), parent: f.at() }]);
        await settle(30_000);
        expect(f.item(id!).status).toBe('preparing');
        expect(f.item(id!).waitingFor).toBeTruthy();
        await settle(31_000);
        expect(f.item(id!)).toMatchObject({
            status: 'failed',
            error: KEY_CHANGE_GAVE_UP,
            waitingFor: null,
        });
        // Nothing reserved on the server, and nothing tries again by itself.
        expect(f.server.uploads.size).toBe(0);
        const tried = f.tried.length;
        await settle(10 * 60_000);
        expect(f.tried).toHaveLength(tried);
        expect(pauses).toEqual([1]);
        // The walk ends after all: Retry seals afresh under the new key and lands.
        f.walked();
        await f.manager.retry(id!);
        await settle(3_000);
        expect(f.item(id!)).toMatchObject({ status: 'done', error: null });
        expect(f.server.begins.at(-1)!.node).toMatchObject({ parentKeyEpoch: 5 });
    });

    test('a walk that reaches the folder between the look and the begin answers stale: looked at again, it still lands', async () => {
        // The first look after the refusal lists the folder under its old key, and the walk ends
        // right then: the begin sealed from that look is `stale`, not `rotating`.
        const f = family({ raceAtLook: 1 });
        const [id] = f.manager.enqueue([{ file: fakeFile(CHUNK), parent: f.at() }]);
        f.start(5);
        await settle(10_000);
        expect(f.item(id!)).toMatchObject({ status: 'done', error: null, waitingFor: null });
        expect(
            f.tried.map((input) => (input.node as { parentKeyEpoch: number }).parentKeyEpoch),
        ).toEqual([1, 1, 5]);
        expect(f.server.begins.at(-1)!.node).toMatchObject({ keyEnvelope: 'ke-under-5' });
    });

    test('the same race at attach answers stale too, and the attach is looked at again and lands', async () => {
        // Attach looks first under the old key (refused, rotating); its second look races the walk.
        const f = family({ conflict: true, raceAtLook: 2 });
        const complete = f.api.completeUpload.bind(f.api);
        f.api.completeUpload = (async (...args: Parameters<typeof complete>) => {
            f.start(5);
            return complete(...args);
        }) as typeof complete;
        const [id] = f.manager.enqueue([{ file: fakeFile(2 * CHUNK), parent: f.at() }]);
        await settle(10_000);
        expect(f.item(id!)).toMatchObject({ status: 'done', error: null, waitingFor: null });
        expect(f.server.attached).toHaveLength(1);
        expect((f.server.attached[0]!.input as { node: unknown }).node).toMatchObject({
            parentKeyEpoch: 5,
            keyEnvelope: 'ke-under-5',
        });
    });

    test('a stale answer before any wait is not a key change: it fails as before', async () => {
        const f = family();
        const [id] = f.manager.enqueue([{ file: fakeFile(CHUNK), parent: f.at() }]);
        // Re-keyed and finished before the upload began, unseen: nothing said to wait, so `stale`
        // is the server's last word, as for any upload outside a family folder.
        f.start(5);
        f.walked();
        await settle(3_000);
        expect(f.item(id!)).toMatchObject({ status: 'failed', errorCode: 'stale' });
        expect(f.tried).toHaveLength(1);
    });

    test('an upload discarded while it waits is gone for good: its wait ends without failing it or sending anything', async () => {
        const events: string[] = [];
        const f = family({
            keyChangeGiveUpMs: 60_000,
            // The give-up is what would fire later: a pause that never returns.
            keyChangePause: () => new Promise(() => {}),
            onEvent: (event) => events.push(`${event.type}:${event.item.id}`),
        });
        f.start(5);
        const [id] = f.manager.enqueue([{ file: fakeFile(CHUNK), parent: f.at() }]);
        await settle(1_000);
        expect(f.item(id!).waitingFor).toBeTruthy();
        await f.manager.pause(id!);
        await f.manager.discard(id!);
        const tried = f.tried.length;
        await settle(5 * 60_000);
        expect(f.state().uploads).toEqual([]);
        expect(events.filter((event) => event.startsWith('failed'))).toEqual([]);
        expect(f.tried).toHaveLength(tried);
        // Discarded while its begin is on the wire, which then fails: nothing answers for it.
        const begin = f.api.beginUpload.bind(f.api);
        f.api.beginUpload = (async () => {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            throw new DriveApiError('Not enough storage for this file.', 'over-quota', 402);
        }) as typeof begin;
        f.walked();
        const [other] = f.manager.enqueue([{ file: fakeFile(CHUNK), parent: f.at() }]);
        await settle(100);
        await f.manager.pause(other!);
        await f.manager.discard(other!);
        await settle(5_000);
        expect(f.state().uploads).toEqual([]);
        expect(events.filter((event) => event.startsWith('failed'))).toEqual([]);
    });

    test('uploads leaving a key-change wait take a slot to seal again, so no more than two run at once', async () => {
        // Sends that take a while, and a begin that takes half a second: a slot held is visible.
        let beginning = 0;
        let most = 0;
        const f = family({
            send: (_objectId, index) =>
                new Promise((resolve) =>
                    setTimeout(
                        () => resolve({ ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 }),
                        10_000,
                    ),
                ),
        });
        const begin = f.api.beginUpload.bind(f.api);
        f.api.beginUpload = (async (...args: Parameters<typeof begin>) => {
            beginning++;
            const uploading = f.state().uploads.filter((u) => u.status === 'uploading').length;
            most = Math.max(most, beginning + uploading);
            try {
                await new Promise((resolve) => setTimeout(resolve, 500));
                return await begin(...args);
            } finally {
                beginning--;
            }
        }) as typeof begin;
        f.start(5);
        const waiting = f.manager.enqueue(
            [1, 2, 3].map((n) => ({ file: fakeFile(CHUNK, `trip-${n}.bin`), parent: f.at() })),
        );
        await settle(2_000);
        // Waiting, they hold no slot: two uploads elsewhere start at once.
        const elsewhere = f.manager.enqueue(
            [1, 2].map((n) => ({
                file: fakeFile(CHUNK, `home-${n}.bin`),
                parent: node('root', null),
            })),
        );
        await settle(2_000);
        expect(elsewhere.map((id) => f.item(id).status)).toEqual(['uploading', 'uploading']);
        f.walked();
        await settle(60_000);
        for (const id of [...waiting, ...elsewhere]) expect(f.item(id).status).toBe('done');
        expect(most).toBeLessThanOrEqual(2);
    });

    test('a new version refused for a key change waits too, and lands under the file’s new key; one overtaken meanwhile is never overwritten', async () => {
        const f = family();
        const [id] = f.manager.enqueue([
            { file: fakeFile(CHUNK, 'old'), parent: f.at(), replaces: f.file() },
        ]);
        f.start(5);
        await settle(3_000);
        expect(f.item(id!).status).toBe('preparing');
        expect(f.item(id!).waitingFor).toBeTruthy();
        expect(f.tried[0]!.node).toMatchObject({ existing: true, keyEpoch: 1 });
        f.walked();
        await settle(5_000);
        expect(f.item(id!)).toMatchObject({ status: 'done', error: null });
        expect(f.server.begins.at(-1)!.node).toMatchObject({
            existing: true,
            id: 'old',
            keyEpoch: 5,
            expectedVersionId: 'v1',
        });
        // Again, but someone else's version becomes current while this one waits.
        const g = family();
        const [late] = g.manager.enqueue([
            { file: fakeFile(CHUNK, 'old'), parent: g.at(), replaces: g.file() },
        ]);
        g.start(5);
        await settle(3_000);
        g.folder.version = 'v2';
        g.walked();
        await settle(5_000);
        expect(g.item(late!)).toMatchObject({ status: 'failed', error: VERSION_MOVED });
        expect(g.server.begins).toEqual([]);
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

    test('a new version names only its version and object: the node is the file it replaces', async () => {
        const h = harness();
        const file = { ...node('doc'), kind: 'file' as const };
        h.manager.enqueue([
            { file: fakeFile(CHUNK, 'doc'), parent: node('root', null), replaces: file },
        ]);
        await settle(2_000);
        const [begun] = h.server.begins;
        expect(begun!.node).toMatchObject({ existing: true, id: 'doc' });
        expect(begun!.node).not.toHaveProperty('idSeed');
        expect(scopedId('version', 'ws', begun!.versionIdSeed)).toBe(begun!.versionId);
    });

    test('a copy signs as it was told, through a conflict copy too; an older journaled copy signs re-sealed', async () => {
        const h = harness({ conflict: true });
        h.manager.enqueue([
            {
                file: fakeFile(CHUNK, 'saved.bin'),
                parent: node('root', null),
                origin: 'copy',
                signAs: { metadata: 'saved', version: 'saved' },
            },
        ]);
        await settle(2_000);
        // Its node, its version, and the sibling a conflict made, all saved.
        expect(h.signed).toEqual([
            { operation: 'driveCreateNodes', signAs: 'saved' },
            { operation: 'driveUploadPrepare', signAs: 'saved' },
            { operation: 'driveCreateNodes', signAs: 'saved' },
            { operation: 'driveUploadRewrap', signAs: 'saved' },
        ]);
        const sibling = h.server.attached[0]!.input as { node: { id: string; idSeed: string } };
        expect(scopedId('node', 'ws', sibling.node.idSeed)).toBe(sibling.node.id);

        // A verified original's name with content that did not verify: chosen apart.
        const mixed = harness();
        mixed.manager.enqueue([
            {
                file: fakeFile(CHUNK, 'mixed.bin'),
                parent: node('root', null),
                origin: 'copy',
                signAs: { metadata: 'ordinary', version: 'resealed' },
            },
        ]);
        await settle(2_000);
        expect(mixed.signed.map((call) => call.signAs)).toEqual(['ordinary', 'resealed']);

        // A file the person holds is theirs: ordinary.
        const own = harness();
        own.manager.enqueue([{ file: fakeFile(CHUNK, 'own.bin'), parent: node('root', null) }]);
        await settle(2_000);
        expect(own.signed.map((call) => call.signAs)).toEqual(['ordinary', 'ordinary']);

        // A copy queued before copies said how to sign, restored: re-sealed, as copies were then.
        const journal = createMemoryJournal();
        const stash = fakeStash();
        stash.files.set('old-copy', fakeFile(CHUNK, 'old.bin'));
        await journal.putQueued({
            id: 'q-old',
            workspaceId: 'ws',
            parentId: 'root',
            parentName: 'root',
            name: 'old.bin',
            replacesId: null,
            file: { name: 'old.bin', size: CHUNK, lastModified: 0, type: '' },
            handle: null,
            origin: 'copy',
            stash: 'old-copy',
            createdAt: 0,
            updatedAt: 0,
        });
        const restored = harness({ journal, stash });
        await restored.manager.restore('ws');
        await settle(2_000);
        expect(restored.signed.map((call) => call.signAs)).toEqual(['resealed', 'resealed']);
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

    test('a stash that can’t be read just now is kept and tried again; only a gone one is lost', async () => {
        const stash = fakeStash();
        stash.files.set('copy-1', fakeFile(2 * CHUNK, 'notes.pdf'));
        const first = harness({ stash });
        const [id] = first.manager.enqueue([
            {
                file: fakeFile(2 * CHUNK, 'notes.pdf'),
                parent: node('root', null),
                origin: 'copy',
                stash: 'copy-1',
            },
        ]);
        await settle(50);
        await first.manager.pause(id!);
        await settle(100);
        // After a reload the disk is busy for a moment: not lost, the stash stays.
        const open = stash.open.bind(stash);
        stash.open = async () => {
            throw new DOMException('Busy', 'NoModificationAllowedError');
        };
        const second = harness({ journal: first.journal, stash });
        second.server.uploads = first.server.uploads;
        await second.manager.restore('ws');
        await settle(500);
        expect(second.item(id!).status).toBe('paused');
        expect(stash.files.has('copy-1')).toBe(true);
        // A lock while reopening pauses it as a lock does, and keeps the stash too.
        stash.open = async () => {
            throw new Error('Your account was locked. Please try again.');
        };
        await second.manager.resume(id!);
        await settle(200);
        expect(second.item(id!).error).toBe('Unlock this device to continue.');
        expect(stash.files.has('copy-1')).toBe(true);
        // Readable again: it finishes.
        stash.open = open;
        await second.manager.resume(id!);
        await settle(2_000);
        expect(second.item(id!).status).toBe('done');
        // A stash that is gone, by contrast, is lost at once.
        const third = harness({ stash });
        const [goneId] = third.manager.enqueue([
            {
                file: fakeFile(CHUNK, 'gone.pdf'),
                parent: node('root', null),
                origin: 'copy',
                stash: 'copy-2',
            },
        ]);
        await settle(20);
        await third.manager.pause(goneId!);
        const fourth = harness({ journal: third.journal, stash });
        await fourth.manager.restore('ws');
        await settle(500);
        expect(fourth.item(goneId!).status).toBe('failed');
    });

    test('signing out stops every upload and leaves no name, digest or stashed byte behind', async () => {
        const stash = fakeStash();
        stash.files.set('copy-1', fakeFile(4 * CHUNK, 'shared-contract.pdf'));
        // A stash an earlier page left behind, which no upload names any more.
        stash.files.set('orphan', fakeFile(CHUNK, 'old.bin'));
        const h = harness({ stash });
        h.manager.enqueue([
            {
                file: fakeFile(4 * CHUNK, 'shared-contract.pdf'),
                parent: node('root', null),
                origin: 'copy',
                stash: 'copy-1',
            },
            { file: fakeFile(4 * CHUNK, 'payroll.xlsx'), parent: node('root', null) },
            { file: fakeFile(CHUNK, 'waiting.txt'), parent: node('root', null) },
        ]);
        await settle(120);
        expect(h.journal.entries.size + h.journal.queued.size).toBeGreaterThan(0);
        await h.manager.forgetAll();
        await settle(200);
        expect(h.journal.entries.size).toBe(0);
        expect(h.journal.queued.size).toBe(0);
        expect(stash.files.size).toBe(0);
        expect(h.manager.getState().uploads).toHaveLength(0);
        // The server is told, so the reservations do not linger until they expire.
        expect(h.server.aborted.length).toBeGreaterThan(0);
        expect(h.server.completed).toHaveLength(0);
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

/* A copy's bytes in memory, in uneven parts, with a recognisable pattern. */
function memoryCopy(size: number, name = 'copy.bin') {
    const content = Uint8Array.from({ length: size }, (_, i) => (i * 31 + 11) & 0xff);
    const cut = [0, 1000, CHUNK + 7, size].filter(
        (at, i, all) => at <= size && all.indexOf(at) === i,
    );
    const parts = cut.slice(1).map((end, i) => content.slice(cut[i], end));
    const file: MemoryFile = {
        kind: 'memory',
        name,
        size,
        type: 'application/octet-stream',
        lastModified: 2_000,
        parts,
        thumbnail: new Uint8Array([1, 2, 3]),
    };
    return { content, file };
}

describe('uploads from memory', () => {
    test('send exactly the bytes, never as a Blob, and move them to the worker rather than copy', async () => {
        const blobs = vi.spyOn(globalThis, 'Blob');
        const files = vi.spyOn(globalThis, 'File');
        const h = harness();
        // Five chunks, so later parts are read after the first wave (three in flight) has
        // already moved the bytes: they must read the worker's copy, not move them again.
        const size = 4 * CHUNK + 5;
        const { content, file } = memoryCopy(size);
        const parts = [...file.parts];
        const [id] = h.manager.enqueue([{ file, parent: node('root', null), origin: 'copy' }]);
        await settle(3_000);
        expect(h.item(id!).status).toBe('done');
        // Byte for byte: the chunks the worker read, in order, are the copy.
        const sourceId = [...h.readChunks.keys()][0]!.split(':')[0]!;
        const sent = new Uint8Array(size);
        for (let index = 0; index < 5; index++)
            sent.set(h.readChunks.get(`${sourceId}:${index}`)!, index * CHUNK);
        // Compared natively, without printing 40 MB on a mismatch.
        expect(Buffer.compare(sent, content)).toBe(0);
        // Moved once: the page's buffers are detached, and attached a single time.
        expect(h.calls.filter((call) => call === 'driveSourceAttach')).toHaveLength(1);
        expect(parts.every((part) => part.byteLength === 0)).toBe(true);
        // And let go of in the worker once the upload is done.
        expect(h.released).toEqual([sourceId]);
        expect(h.sources.size).toBe(0);
        // The plaintext never became a Blob or a File on the way.
        expect(blobs.mock.calls.length).toBe(0);
        expect(files.mock.calls.length).toBe(0);
    }, 20_000);

    test('a lock drops the bytes the worker held, and the copy comes back from its stash', async () => {
        const stash = fakeStash();
        const { file } = memoryCopy(3 * CHUNK);
        stash.files.set('copy-1', fakeFile(3 * CHUNK, 'copy.bin', 2_000));
        let fail = false;
        const h = harness({
            stash,
            send: async (_objectId, index) => {
                if (fail) throw new Error('Your account was locked. Please try again.');
                return { ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 };
            },
        });
        const [id] = h.manager.enqueue([
            { file, parent: node('root', null), origin: 'copy', stash: 'copy-1' },
        ]);
        fail = true;
        await settle(500);
        expect(h.item(id!).status).toBe('paused');
        // What was moved to the worker is not asked for again: the page has nothing to move.
        const opened = vi.spyOn(stash, 'open');
        fail = false;
        await h.manager.resume(id!);
        await settle(2_000);
        expect(opened).toHaveBeenCalledTimes(1);
        expect(h.item(id!).status).toBe('done');
    }, 20_000);
});

describe('in-memory bytes after the upload stops', () => {
    const permanent = async () =>
        ({ ok: false, status: 400, retryable: false, message: 'Refused.' }) as UploadPartResult;

    test('a failed copy removed from the list lets the worker drop its bytes', async () => {
        const h = harness({ send: permanent });
        const { file } = memoryCopy(CHUNK);
        const [id] = h.manager.enqueue([{ file, parent: node('root', null), origin: 'copy' }]);
        await settle(500);
        expect(h.item(id!).status).toBe('failed');
        expect(h.sources.size).toBe(1);
        h.manager.remove(id!);
        await settle(10);
        expect(h.sources.size).toBe(0);
        expect(h.released).toHaveLength(1);
    }, 20_000);

    test('a cancelled copy lets the worker drop its bytes', async () => {
        let hold: (() => void) | null = null;
        const h = harness({
            send: (_objectId, index) =>
                new Promise((resolve) => {
                    hold = () => resolve({ ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 });
                }),
        });
        const { file } = memoryCopy(CHUNK);
        const [id] = h.manager.enqueue([{ file, parent: node('root', null), origin: 'copy' }]);
        await settle(100);
        expect(h.sources.size).toBe(1);
        await h.manager.cancel(id!);
        void hold;
        expect(h.sources.size).toBe(0);
    }, 20_000);

    test('carries the copy’s own thumbnail into the sealed object', async () => {
        const h = harness();
        const { file } = memoryCopy(CHUNK);
        h.manager.enqueue([{ file, parent: node('root', null), origin: 'copy' }]);
        await settle(1_000);
        expect(h.preparedThumbnails.map((t) => (t ? [...t] : null))).toEqual([[1, 2, 3]]);
    }, 20_000);

    test('after a lock it never saw, a paused copy reopens from its stash instead of failing', async () => {
        const stash = fakeStash();
        const { content, file } = memoryCopy(6 * CHUNK);
        stash.bytes.set('copy-1', content.slice());
        const h = harness({ stash });
        const [id] = h.manager.enqueue([
            { file, parent: node('root', null), origin: 'copy', stash: 'copy-1' },
        ]);
        await settle(150);
        await h.manager.pause(id!);
        await settle(100);
        expect(h.item(id!).partsDone).toBeLessThan(6);
        // Locked while paused: the worker and its copy of the bytes are gone.
        h.lockWorker();
        const opened = vi.spyOn(stash, 'open');
        await h.manager.resume(id!);
        await settle(3_000);
        expect(h.item(id!).status).toBe('done');
        expect(opened).toHaveBeenCalledTimes(1);
        // Reattached from the stash's bytes, which were in memory, never a Blob.
        expect(h.calls.filter((call) => call === 'driveSourceAttach')).toHaveLength(2);
    }, 20_000);

    test('after a lock it never saw, a copy with no stash is reported lost, not failed at every retry', async () => {
        const h = harness();
        const { file } = memoryCopy(6 * CHUNK);
        const [id] = h.manager.enqueue([{ file, parent: node('root', null), origin: 'copy' }]);
        await settle(150);
        await h.manager.pause(id!);
        await settle(100);
        expect(h.item(id!).partsDone).toBeLessThan(6);
        h.lockWorker();
        await h.manager.resume(id!);
        await settle(500);
        expect(h.item(id!).status).toBe('failed');
        expect(h.item(id!).error).toMatch(/did not finish/);
    }, 20_000);

    test('a lock that cuts the move to the worker short, with no stash, reports the copy lost', async () => {
        const h = harness({ attachLocks: true });
        const { file } = memoryCopy(CHUNK);
        const [id] = h.manager.enqueue([{ file, parent: node('root', null), origin: 'copy' }]);
        await settle(300);
        expect(h.item(id!).status).toBe('paused');
        await h.manager.resume(id!);
        await settle(300);
        expect(h.item(id!).status).toBe('failed');
        expect(h.item(id!).error).toMatch(/did not finish/);
    }, 20_000);
});

describe('in-memory bytes and the person’s own actions', () => {
    test('Retry brings back a failed copy whose bytes a lock took, from its sealed stash', async () => {
        const stash = fakeStash();
        const { content, file } = memoryCopy(2 * CHUNK);
        stash.bytes.set('copy-1', content.slice());
        let mode: 'fail' | 'lock' | 'ok' = 'fail';
        const h = harness({
            stash,
            send: async (_objectId, index) => {
                if (mode === 'lock') throw new Error('Your account was locked. Please try again.');
                if (mode === 'fail')
                    return { ok: false, status: 400, retryable: false, message: 'Refused.' };
                return { ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 };
            },
        });
        const [copy] = h.manager.enqueue([
            { file, parent: node('root', null), origin: 'copy', stash: 'copy-1' },
        ]);
        await settle(500);
        expect(h.item(copy!).status).toBe('failed');
        // Another upload meets the lock: the engine notices, and the worker's bytes are gone.
        mode = 'lock';
        h.manager.enqueue([{ file: fakeFile(CHUNK, 'other.bin'), parent: node('root', null) }]);
        await settle(500);
        h.lockWorker();
        expect(h.item(copy!).status).toBe('failed');
        mode = 'ok';
        await h.manager.retry(copy!);
        await settle(3_000);
        expect(h.item(copy!).status).toBe('done');
    }, 20_000);

    test('a copy cancelled while its bytes move to the worker leaves none there', async () => {
        let arrive: () => void = () => {};
        const h = harness({ attachHold: () => new Promise((resolve) => (arrive = resolve)) });
        const { file } = memoryCopy(CHUNK);
        const [id] = h.manager.enqueue([{ file, parent: node('root', null), origin: 'copy' }]);
        await settle(100);
        expect(h.calls).toContain('driveSourceAttach');
        await h.manager.cancel(id!);
        arrive();
        await settle(100);
        expect(h.sources.size).toBe(0);
    }, 20_000);

    test('removing a failed copy with a part still encrypting touches nothing more', async () => {
        // No stash: a part that wrongly carried on would end in lost(), on a row already gone.
        const { file } = memoryCopy(3 * CHUNK);
        let encrypted: () => void = () => {};
        const events: string[] = [];
        const h = harness({
            // The first part is refused for good; the last is still being encrypted meanwhile.
            send: async () => ({ ok: false, status: 400, retryable: false, message: 'Refused.' }),
            encryptHold: (index) =>
                index === 2 ? new Promise((resolve) => (encrypted = resolve)) : undefined,
            onEvent: (event) => void events.push(event.type),
        });
        const [id] = h.manager.enqueue([{ file, parent: node('root', null), origin: 'copy' }]);
        await settle(300);
        expect(h.item(id!).status).toBe('failed');
        const before = events.length;
        h.manager.remove(id!);
        await settle(10);
        encrypted();
        await settle(300);
        // Nothing more happens to the removed copy: no lost event, no server abort.
        expect(events.slice(before)).toEqual([]);
        expect(h.server.aborted).toEqual([]);
    }, 20_000);
});
