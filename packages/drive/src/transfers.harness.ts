import { vi } from 'vitest';
import type { CryptoRequests, CryptoResults, UploadPartResult } from '@hushos/crypto';
import { KEY_CHANGE_PENDING } from '@hushos/crypto/protocol';
import { DriveApiError, type DriveApi, type NodeView } from './api';
import type { DriveNode, Rpc } from './client';
import { scopedId } from '../../db/src/ids';
import { createMemoryJournal } from './journal';
import {
    createTransferManager,
    type TransferManagerOptions,
    type UploadStash,
    type MemoryFile,
    StashGone,
} from './transfers';

/*
 * The upload engine's test bench (transfers.test.ts, save-runs.engine.test.ts): a fake
 * worker, a fake API and an in-memory journal around the real createTransferManager. No
 * bytes, no crypto: decisions.
 */

export const CHUNK = 8 * 1024 * 1024;
/* Ids in the form the envelope contexts take, for the one test that seals a record for real. */
export const WS_ID = '11111111-1111-4111-8111-111111111111';
export const NODE_ID = '22222222-2222-4222-8222-222222222222';

export function node(id: string, parentId: string | null = 'root'): DriveNode {
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
export function fakeFile(size: number, name = 'file.bin', lastModified = 1_000) {
    return { name, size, type: 'application/octet-stream', lastModified } as unknown as File;
}

export type SendHandler = (objectId: string, index: number) => Promise<UploadPartResult>;
export type Journal = ReturnType<typeof createMemoryJournal>;

/* The app's stash, in memory: bytes by name, plus what was removed and swept. */
export function fakeStash() {
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

export function harness(
    options: {
        send?: SendHandler;
        journal?: Journal;
        conflict?: boolean;
        /* The file left the folder it was saved into: completion answers conflicted naming no version. */
        moved?: boolean;
        /*
         * The replaced file's current version as the server holds it now: a begin naming
         * another is refused `stale`, and a completion that finds it moved since begin is
         * `conflicted`, naming it, as packages/db does.
         */
        serverVersion?: () => string | null;
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
        /* The worker's cancel of an upload, held until it resolves (a worker that hangs). */
        cancelHold?: () => Promise<void>;
        /* A completion held until it resolves: the server finishing it while the device does something else. */
        completeHold?: () => Promise<void>;
        /* A rewrap held until it resolves (a cancel or a lock while it is on its way). */
        rewrapHold?: () => Promise<void>;
        /* The account's session (a sign-out closes it). */
        session?: TransferManagerOptions['session'];
    } = {},
) {
    const journal = options.journal ?? createMemoryJournal();
    const calls: string[] = [];
    /* The statement each signing call was asked for, in order. */
    const signed: { operation: string; signAs: string | undefined }[] = [];
    /* The key epoch every created node was given, and the parent epoch its key was wrapped under. */
    const givenEpochs: number[] = [];
    const wrappedUnder: number[] = [];
    /* The metadata every created node was sealed with, in order. */
    const createdMetadata: CryptoRequests['driveCreateNodes']['nodes'][number]['metadata'][] = [];
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
                    createdMetadata.push(n.metadata);
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
                await options.cancelHold?.();
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
                await options.rewrapHold?.();
                return { contentKeyEnvelope: `rewrapped-under-${nodeId}` } as CryptoResults[K];
            }
            default:
                throw new Error(`unexpected ${operation}`);
        }
    };
    const server = {
        uploads: new Map<
            string,
            {
                parts: Map<number, string>;
                status: string;
                expiresAt: string;
                expectedVersionId?: string | null;
            }
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
            const expected = input.node.existing ? input.node.expectedVersionId : undefined;
            if (
                options.serverVersion &&
                expected !== undefined &&
                expected !== options.serverVersion()
            )
                throw new DriveApiError('This item changed since you last saw it.', 'stale', 409);
            const id = `up-${++nextUpload}`;
            const expiresAt = new Date(Date.now() + 3600_000).toISOString();
            server.uploads.set(id, {
                parts: new Map(),
                status: 'open',
                expiresAt,
                expectedVersionId: expected,
            });
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
            await options.completeHold?.();
            const expected = server.uploads.get(id)?.expectedVersionId;
            if (
                options.serverVersion &&
                expected !== undefined &&
                expected !== options.serverVersion()
            ) {
                server.uploads.get(id)!.status = 'conflicted';
                throw new DriveApiError(
                    'This file changed while it was uploading.',
                    'conflict',
                    409,
                    { conflicted: true, currentVersionId: options.serverVersion() },
                );
            }
            if (options.moved) {
                server.uploads.get(id)!.status = 'conflicted';
                throw new DriveApiError(
                    'This file changed while it was uploading.',
                    'conflict',
                    409,
                    {
                        conflicted: true,
                        currentVersionId: null,
                    },
                );
            }
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
        session: options.session,
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
        createdMetadata,
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

export async function settle(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
}
