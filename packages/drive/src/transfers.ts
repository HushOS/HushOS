import type { NodeMetadata, UploadPartProgress, UploadPartResult } from '@hushos/crypto';
import { CONTENT_SUITE, chunkCount, ciphertextSize } from '@hushos/crypto/drive';
import type { DriveApi, NodeView, PartUrl } from './api';
import type { DriveErrorCode } from './protocol';
import { DriveApiError } from './api';
import type { DriveNode, Rpc } from './client';
import type { JournalEntry, QueuedEntry, UploadJournal, UploadOrigin } from './journal';

/*
 * The upload engine. One queue for the whole app, independent of any page: a
 * transfer keeps running when the person navigates. Encryption and the PUTs
 * happen in the crypto worker; this module decides what to do next, keeps the
 * state a UI renders, talks to the API, and keeps the journal that lets an
 * upload continue after a reload or a lock.
 *
 * State per upload is an explicit machine:
 *   queued -> preparing -> uploading <-> paused -> completing -> done
 *                                    \-> failed (retryable from the last good part)
 *                                    \-> cancelled
 * A restored upload starts paused and, until its file is attached again, cannot
 * move: one that had begun continues from its last acknowledged part, one that
 * was only waiting starts once it has its file. A copy of something shared has
 * no file on disk; its bytes sit in a stash the app keeps, and it resumes from
 * there on its own, or is reported lost when the stash is gone. A global pool
 * bounds parts in flight across every file, so a hundred small files do not
 * open a hundred connections; failed parts retry with jittered backoff. Each
 * part is encrypted, its digest journaled, then sent.
 */

export type UploadStatus =
    | 'queued'
    | 'preparing'
    | 'uploading'
    | 'paused'
    | 'completing'
    | 'done'
    | 'failed'
    | 'cancelled';

export type UploadItem = {
    id: string;
    name: string;
    size: number;
    mime: string | null;
    parentId: string;
    parentName: string;
    status: UploadStatus;
    error: string | null;
    /* The server's reason when it refused, so the app can offer a way out (over-quota). */
    errorCode: DriveErrorCode | 'unavailable' | null;
    /* Bytes of ciphertext the store has acknowledged or is receiving. */
    loaded: number;
    total: number;
    bytesPerSecond: number;
    chunkCount: number;
    partsDone: number;
    startedAt: number | null;
    finishedAt: number | null;
    node: NodeView | null;
    /*
     * Came back from the journal and has no file yet; `attachFile` continues it.
     * On a failed upload: there is no file to retry with (a lost copy).
     */
    needsFile: boolean;
    /* Bytes this device can reopen itself: a kept file handle or a stash; `resume` uses them. */
    hasHandle: boolean;
    origin: UploadOrigin;
};

export type TransfersState = {
    uploads: UploadItem[];
    active: number;
    bytesPerSecond: number;
};

export type EnqueueInput = {
    file: File;
    parent: DriveNode;
    /* Replace this file's content with a new version instead of creating a node. */
    replaces?: DriveNode;
    /* The name the file takes in Drive when it differs from the file's own ("keep both"). */
    name?: string;
    handle?: FileSystemFileHandle;
    /* A copy of something shared, rather than a file the person holds. */
    origin?: UploadOrigin;
    /* The stash the app wrote this upload's bytes to, so a reload can reopen them. */
    stash?: string;
};

/* Where the app keeps the bytes of uploads that have no file on disk, by name. */
export type UploadStash = {
    /* Reopens stashed bytes as the file the journal describes; rejects when the stash is gone. */
    open(name: string, file: JournalEntry['file']): Promise<File>;
    remove(name: string): Promise<void>;
    /* Drops every stash not named in `keep`, for stashes whose upload finished without cleanup. */
    sweep?(keep: Set<string>): Promise<void>;
};

export type TransferManagerOptions = {
    rpc: Rpc;
    api: DriveApi;
    journal?: UploadJournal;
    stash?: UploadStash;
    /*
     * Opens the keys a restored upload needs, parents first, and returns the parent
     * folder (and the file being replaced) as nodes. The app implements it with
     * the Drive client; the engine never lists folders itself. A queued entry has
     * no keys yet and only needs its parent (and the file it replaces) looked up.
     */
    openNodes?: (
        entry: JournalEntry | QueuedEntry,
    ) => Promise<{ parent: DriveNode; replaces?: DriveNode }>;
    /* Called once a version is published; the app invalidates its folder listing. */
    onPublished?: (node: NodeView, parentId: string) => void;
    /*
     * Renders a thumbnail for a file: a WebP of at most 64 KiB, or null when the
     * type has none. Started when the upload starts and awaited before begin,
     * because the worker seals it into the object as its trailer and the
     * envelope and the declared size must be final before a byte leaves.
     */
    thumbnail?: (file: File, mime: string | null) => Promise<Blob | null>;
    onEvent?: (event: {
        type: 'started' | 'done' | 'failed' | 'cancelled' | 'locked' | 'restored' | 'lost';
        item: UploadItem;
    }) => void;
    maxPartsInFlight?: number;
    maxActiveFiles?: number;
    maxAttempts?: number;
    now?: () => number;
    /* The jitter behind retry backoff; tests pin it so a retry cannot land early by chance. */
    random?: () => number;
    /* Whether the device has no network: a failed part then waits for one without spending a try. Tests stub it. */
    offline?: () => boolean;
};

type Internal = {
    item: UploadItem;
    file: File | null;
    handle: FileSystemFileHandle | null;
    parent: DriveNode | null;
    replaces: DriveNode | undefined;
    nodeId: string;
    versionId: string;
    objectId: string;
    uploadId: string | null;
    keyEpoch: number;
    /* The journal row, once begin has succeeded; null before, and for finished uploads. */
    entry: JournalEntry | null;
    /* The queued row, from enqueue until the upload is settled; the only row a waiting file has. */
    queued: QueuedEntry | null;
    stash: string | null;
    /* The thumbnail render in flight, started with the upload. */
    thumbnail: Promise<Blob | null> | null;
    /* Whether the worker currently holds this upload's content key. */
    prepared: boolean;
    /* Preparation is under way: a pause holds the file afterwards, a resume must not start it twice. */
    preparing: boolean;
    parts: Map<number, { etag: string; bytes: number }>;
    digests: Map<number, string>;
    urls: Map<number, { url: string; expiresAt: number }>;
    inFlight: Map<number, { loaded: number; total: number }>;
    attempts: Map<number, number>;
    completedBytes: number;
    fetchingUrls: Promise<void> | null;
    backoff: Set<ReturnType<typeof setTimeout>>;
    generation: number;
};

/* Every upload lands in its folder's workspace: the owner's, for a folder shared with an editor. */
function workspaceOf(u: Internal) {
    const workspaceId =
        u.parent?.workspaceId ??
        u.replaces?.workspaceId ??
        u.entry?.workspaceId ??
        u.queued?.workspaceId;
    if (!workspaceId) throw new Error('This upload has no folder.');
    return workspaceId;
}

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/* While offline a waiting piece also looks again this often, in case the browser's online flag is wrong. */
export const OFFLINE_RECHECK_MS = 15_000;

/* Whether the browser knows it has no network at all. */
export function isOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/*
 * Resolves when `offline` says the network is back: at the browser's online
 * event, or after OFFLINE_RECHECK_MS at the latest, so an injected check (or a
 * browser whose flag is wrong) is looked at again rather than trusted forever.
 */
export function onlineAgain(offline: () => boolean = isOffline): Promise<void> {
    if (!offline()) return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            if (typeof window !== 'undefined') window.removeEventListener('online', done);
            resolve();
        };
        const timer = setTimeout(done, OFFLINE_RECHECK_MS);
        if (typeof window !== 'undefined') window.addEventListener('online', done, { once: true });
    });
}

export function backoffDelay(attempt: number, random = Math.random) {
    // Exponential with full jitter, capped: every client that lost the store at the
    // same moment must not retry in the same instant.
    const ceiling = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.max(0, attempt - 1));
    return Math.floor(random() * ceiling);
}

/* The server's answer when the node moved on under an upload: attach, do not retry. */
function isConflicted(error: unknown) {
    return (
        error instanceof DriveApiError &&
        error.code === 'conflict' &&
        typeof error.data === 'object' &&
        error.data !== null &&
        (error.data as { conflicted?: boolean }).conflicted === true
    );
}

/* "report.pdf" becomes "report (conflict copy).pdf". */
export function conflictCopyName(name: string) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    return `${stem} (conflict copy)${extension}`;
}

/* A worker rejection means the device locked: the keys are gone until unlock. */
function isLockError(error: unknown) {
    return error instanceof Error && /locked/i.test(error.message);
}

export function createTransferManager(options: TransferManagerOptions) {
    const {
        rpc,
        api,
        journal,
        maxPartsInFlight = 4,
        // Parts bound the bandwidth; files bound the latency. Each file costs a few
        // round trips before its first byte, so several must be in those at once or
        // a folder of small files goes one round trip at a time.
        maxActiveFiles = 6,
        maxAttempts = 8,
        now = () => Date.now(),
        offline = isOffline,
    } = options;
    const uploads = new Map<string, Internal>();
    const order: string[] = [];
    const listeners = new Set<() => void>();
    /*
     * Key epochs come from the server in ranges, one range per workspace per
     * batch, so a thousand small files cost one round trip for their epochs
     * rather than a thousand. An epoch is only a unique number; the ones a
     * cancelled batch leaves unused are simply never used.
     */
    const epochPools = new Map<string, { next: number; end: number }>();
    // Files that begin together share one fetch of the range rather than each fetching their own.
    const epochFills = new Map<string, Promise<void>>();
    async function takeEpoch(workspaceId: string): Promise<number> {
        for (;;) {
            const pool = epochPools.get(workspaceId);
            if (pool && pool.next < pool.end) return pool.next++;
            let fill = epochFills.get(workspaceId);
            if (!fill) {
                fill = (async () => {
                    const waiting = [...uploads.values()].filter(
                        (u) =>
                            (u.item.status === 'queued' || u.item.status === 'preparing') &&
                            workspaceOf(u) === workspaceId,
                    ).length;
                    const count = Math.max(1, Math.min(200, waiting));
                    const { from } = await api.allocateEpochs(workspaceId, count);
                    epochPools.set(workspaceId, { next: from, end: from + count });
                })().finally(() => epochFills.delete(workspaceId));
                epochFills.set(workspaceId, fill);
            }
            await fill;
        }
    }
    let snapshot: TransfersState = { uploads: [], active: 0, bytesPerSecond: 0 };
    let dirty = true;
    let ticker: ReturnType<typeof setInterval> | null = null;
    const speed = new Map<string, { at: number; loaded: number; rate: number }>();

    function emit() {
        dirty = true;
        for (const listener of listeners) listener();
    }
    function loadedOf(u: Internal) {
        let inFlight = 0;
        for (const part of u.inFlight.values()) inFlight += part.loaded;
        return u.completedBytes + inFlight;
    }
    function isActive(u: Internal) {
        return (
            u.item.status === 'preparing' ||
            u.item.status === 'uploading' ||
            u.item.status === 'completing'
        );
    }
    function tick() {
        const at = now();
        let anyActive = false;
        for (const u of uploads.values()) {
            if (!isActive(u)) {
                speed.delete(u.item.id);
                if (u.item.bytesPerSecond !== 0) u.item.bytesPerSecond = 0;
                continue;
            }
            anyActive = true;
            const loaded = loadedOf(u);
            const previous = speed.get(u.item.id);
            if (previous) {
                const seconds = (at - previous.at) / 1000;
                if (seconds > 0) {
                    const instant = Math.max(0, loaded - previous.loaded) / seconds;
                    previous.rate = previous.rate * 0.6 + instant * 0.4;
                }
                previous.at = at;
                previous.loaded = loaded;
                u.item.bytesPerSecond = Math.round(previous.rate);
            } else speed.set(u.item.id, { at, loaded, rate: 0 });
            u.item.loaded = loaded;
        }
        if (!anyActive && ticker) {
            clearInterval(ticker);
            ticker = null;
        }
        emit();
    }
    function ensureTicker() {
        ticker ??= setInterval(tick, 750);
    }

    function getState(): TransfersState {
        if (dirty) {
            const items = order.map((id) => ({ ...uploads.get(id)!.item }));
            let active = 0;
            let bytesPerSecond = 0;
            for (const u of uploads.values())
                if (isActive(u)) {
                    active++;
                    bytesPerSecond += u.item.bytesPerSecond;
                }
            snapshot = { uploads: items, active, bytesPerSecond };
            dirty = false;
        }
        return snapshot;
    }
    function subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function set(u: Internal, patch: Partial<UploadItem>) {
        Object.assign(u.item, patch);
        emit();
    }
    function clearBackoff(u: Internal) {
        for (const timer of u.backoff) clearTimeout(timer);
        u.backoff.clear();
    }
    function fail(u: Internal, message: string, code: UploadItem['errorCode'] = null) {
        clearBackoff(u);
        set(u, { status: 'failed', error: message, errorCode: code, finishedAt: now() });
        options.onEvent?.({ type: 'failed', item: u.item });
        void schedule();
    }
    /*
     * The worker is gone. Every upload keeps its journal and its server reservation;
     * resuming after unlock reopens the keys from the journal.
     */
    function locked() {
        for (const u of uploads.values()) {
            u.prepared = false;
            if (
                u.item.status === 'uploading' ||
                u.item.status === 'preparing' ||
                u.item.status === 'queued'
            ) {
                clearBackoff(u);
                u.inFlight.clear();
                set(u, { status: 'paused', error: 'Unlock this device to continue.' });
                options.onEvent?.({ type: 'locked', item: u.item });
            }
        }
    }

    /* Parts not yet stored and not in flight, lowest first. */
    function missingParts(u: Internal) {
        const missing: number[] = [];
        for (let part = 1; part <= u.item.chunkCount; part++)
            if (!u.parts.has(part) && !u.inFlight.has(part)) missing.push(part);
        return missing;
    }
    function inFlightTotal() {
        let total = 0;
        for (const u of uploads.values()) total += u.inFlight.size;
        return total;
    }

    async function ensureUrls(u: Internal, from: number) {
        if (u.fetchingUrls) return u.fetchingUrls;
        u.fetchingUrls = (async () => {
            if (!u.uploadId) return;
            const { parts, urlExpiresAt } = await api.uploadPartUrls(
                workspaceOf(u),
                u.uploadId,
                from,
                64,
            );
            rememberUrls(u, parts, urlExpiresAt);
        })().finally(() => {
            u.fetchingUrls = null;
        });
        return u.fetchingUrls;
    }
    function rememberUrls(u: Internal, parts: PartUrl[], urlExpiresAt: string) {
        const expiresAt = new Date(urlExpiresAt).getTime();
        for (const part of parts) u.urls.set(part.partNumber, { url: part.url, expiresAt });
    }

    async function journalPart(
        u: Internal,
        part: number,
        patch: Partial<JournalEntry['parts'][string]>,
    ) {
        if (!journal || !u.entry) return;
        await journal.update(u.entry.id, (entry) => ({
            ...entry,
            parts: {
                ...entry.parts,
                [part]: { ...entry.parts[part], ...patch } as JournalEntry['parts'][string],
            },
        }));
    }
    /* Drops the begun row only: the upload is starting over and stays queued. */
    async function journalRemove(u: Internal) {
        if (!journal || !u.entry) return;
        await journal.remove(u.entry.id).catch(() => {});
        u.entry = null;
    }
    /* The upload is settled: every row goes, and the stash with it. */
    async function journalForget(u: Internal) {
        await journalRemove(u);
        if (journal && u.queued) {
            await journal.removeQueued(u.queued.id).catch(() => {});
            u.queued = null;
        }
        if (u.stash && options.stash) {
            await options.stash.remove(u.stash).catch(() => {});
            u.stash = null;
        }
    }
    /*
     * A copy whose bytes this device no longer has: there is no file to ask for,
     * so the server's reservation is released and the person is told to save it
     * again. The row stays in the list as failed, without a retry.
     */
    async function lost(u: Internal) {
        u.generation++;
        clearBackoff(u);
        u.inFlight.clear();
        if (u.uploadId) await api.abortUpload(workspaceOf(u), u.uploadId).catch(() => {});
        await rpc('driveUploadForget', { objectId: u.objectId }).catch(() => {});
        await journalForget(u);
        u.uploadId = null;
        set(u, {
            status: 'failed',
            error: 'This copy did not finish before the page closed. Save it again.',
            errorCode: null,
            needsFile: true,
            hasHandle: false,
            finishedAt: now(),
        });
        options.onEvent?.({ type: 'lost', item: u.item });
    }
    /* Reopens a restored upload's bytes from its stash, as the file the journal described. */
    async function fromStash(u: Internal) {
        const described = u.entry?.file ?? u.queued?.file;
        if (!u.stash || !options.stash || !described) return null;
        try {
            return await options.stash.open(u.stash, described);
        } catch {
            return null;
        }
    }

    /* Begin: node envelopes (new file), content key, and the server's reservation. */
    async function prepare(u: Internal) {
        const generation = u.generation;
        const file = u.file;
        const parent = u.parent;
        if (!file || !parent) throw new Error('This upload has no file.');
        set(u, { status: 'preparing', startedAt: u.item.startedAt ?? now() });
        options.onEvent?.({ type: 'started', item: u.item });
        u.preparing = true;
        try {
            await prepareInner(u, generation, file, parent);
        } finally {
            u.preparing = false;
        }
    }
    async function prepareInner(u: Internal, generation: number, file: File, parent: DriveNode) {
        if (options.thumbnail && !u.thumbnail)
            u.thumbnail = options.thumbnail(file, u.item.mime).catch(() => null);
        const workspaceId = workspaceOf(u);
        const metadata: NodeMetadata = {
            name: u.item.name,
            mime: u.item.mime,
            size: u.item.size,
            modified: file.lastModified ? new Date(file.lastModified).toISOString() : null,
        };
        let node: Parameters<DriveApi['beginUpload']>[1]['node'];
        let nodeEnvelopes: JournalEntry['node'] = null;
        if (u.replaces) {
            node = {
                existing: true,
                id: u.replaces.id,
                keyEpoch: u.replaces.keyEpoch,
                expectedVersionId: u.replaces.currentVersion?.id ?? null,
            };
            u.keyEpoch = u.replaces.keyEpoch;
        } else {
            const from = await takeEpoch(workspaceId);
            const { nodes } = await rpc('driveCreateNodes', {
                workspaceId,
                nodes: [
                    {
                        id: u.nodeId,
                        parentId: parent.id,
                        parentKeyEpoch: parent.keyEpoch,
                        keyEpoch: from,
                        metadata,
                    },
                ],
            });
            u.keyEpoch = from;
            nodeEnvelopes = {
                keyEnvelope: nodes[0]!.keyEnvelope,
                metadataEnvelope: nodes[0]!.metadataEnvelope,
                metadataVersion: 1,
            };
            node = {
                existing: false,
                id: u.nodeId,
                parentId: parent.id,
                parentKeyEpoch: parent.keyEpoch,
                keyEpoch: from,
                keyEnvelope: nodeEnvelopes.keyEnvelope,
                metadataEnvelope: nodeEnvelopes.metadataEnvelope,
            };
        }
        if (u.generation !== generation) return;
        // The thumbnail is sealed as the object's trailer at prepare, so its render
        // is waited for here: after this, nothing about the object changes.
        const thumbnail = u.thumbnail ? await u.thumbnail : null;
        if (u.generation !== generation) return;
        const prepared = await rpc('driveUploadPrepare', {
            workspaceId,
            nodeId: u.nodeId,
            versionId: u.versionId,
            objectId: u.objectId,
            plaintextSize: u.item.size,
            thumbnail:
                thumbnail && thumbnail.size ? new Uint8Array(await thumbnail.arrayBuffer()) : null,
        });
        u.prepared = true;
        if (u.generation !== generation) return;
        set(u, { total: prepared.ciphertextSize });
        const begun = await api.beginUpload(workspaceId, {
            node,
            versionId: u.versionId,
            objectId: u.objectId,
            contentKeyEnvelope: prepared.contentKeyEnvelope,
            contentNonce: prepared.contentNonce,
            contentSuite: CONTENT_SUITE,
            chunkCount: prepared.chunkCount,
            ciphertextSize: String(prepared.ciphertextSize),
        });
        if (u.generation !== generation) {
            await api.abortUpload(workspaceId, begun.upload.id).catch(() => {});
            return;
        }
        u.uploadId = begun.upload.id;
        rememberUrls(u, begun.parts, begun.urlExpiresAt);
        u.entry = {
            id: u.item.id,
            workspaceId,
            uploadId: begun.upload.id,
            nodeId: u.nodeId,
            versionId: u.versionId,
            objectId: u.objectId,
            parentId: parent.id,
            parentName: parent.name,
            parentKeyEpoch: parent.keyEpoch,
            keyEpoch: u.keyEpoch,
            name: u.item.name,
            newNode: !u.replaces,
            expectedVersionId: u.replaces?.currentVersion?.id ?? null,
            node: nodeEnvelopes,
            contentKeyEnvelope: prepared.contentKeyEnvelope,
            contentNonce: prepared.contentNonce,
            contentSuite: CONTENT_SUITE,
            thumbnail: prepared.thumbnail,
            ciphertextSize: prepared.ciphertextSize,
            file: {
                name: file.name,
                size: file.size,
                lastModified: file.lastModified,
                type: file.type,
            },
            handle: u.handle,
            origin: u.item.origin,
            stash: u.stash,
            parts: {},
            expiresAt: begun.upload.expiresAt,
            createdAt: now(),
            updatedAt: now(),
        };
        await journal?.put(u.entry);
        // A pause during preparation holds here: everything a resume needs is in place, nothing is sent.
        if (u.item.status !== 'paused') set(u, { status: 'uploading' });
    }

    /* Encrypt, journal the digest, then send. The digest is on disk before the PUT starts. */
    async function putPart(u: Internal, part: number) {
        const generation = u.generation;
        const index = part - 1;
        const file = u.file;
        if (!file) return;
        let entry = u.urls.get(part);
        if (!entry || entry.expiresAt - now() < 60_000) {
            await ensureUrls(u, part);
            entry = u.urls.get(part);
        }
        if (u.generation !== generation || u.item.status !== 'uploading') return;
        if (!entry) throw new Error('No upload URL for this part.');
        u.inFlight.set(part, { loaded: 0, total: 0 });
        ensureTicker();
        let result: UploadPartResult;
        try {
            const encrypted = await rpc('driveUploadEncrypt', {
                objectId: u.objectId,
                file,
                index,
            });
            u.digests.set(part, encrypted.digest);
            await journalPart(u, part, { digest: encrypted.digest });
            if (u.generation !== generation || u.item.status !== 'uploading') {
                u.inFlight.delete(part);
                return;
            }
            result = await rpc(
                'driveUploadSend',
                { objectId: u.objectId, index, url: entry.url },
                {
                    idleTimeoutMs: 120_000,
                    onProgress: (raw) => {
                        const progress = raw as UploadPartProgress;
                        if (progress.objectId !== u.objectId || progress.index !== index) return;
                        u.inFlight.set(part, { loaded: progress.loaded, total: progress.total });
                    },
                },
            );
        } catch (error) {
            u.inFlight.delete(part);
            if (u.generation !== generation) return;
            if (isLockError(error)) {
                locked();
                return;
            }
            fail(u, error instanceof Error ? error.message : 'The upload failed.');
            return;
        }
        u.inFlight.delete(part);
        if (u.generation !== generation) return;
        if (result.ok) {
            u.parts.set(part, { etag: result.etag, bytes: result.bytes });
            u.completedBytes += result.bytes;
            set(u, { partsDone: u.parts.size, loaded: loadedOf(u) });
            void journalPart(u, part, { etag: result.etag, bytes: result.bytes });
            void schedule();
            return;
        }
        if (result.cancelled) {
            emit();
            return;
        }
        // No network at all: the part waits for one and the try is not counted, so an upload
        // outlasts a tunnel or a flight instead of failing after a few minutes of backoff.
        const waiting = result.retryable && offline();
        const attempt = waiting
            ? Math.max(1, u.attempts.get(part) ?? 0)
            : (u.attempts.get(part) ?? 0) + 1;
        u.attempts.set(part, attempt);
        if (!result.retryable || attempt >= maxAttempts) {
            fail(u, result.message);
            return;
        }
        // A 403 is almost always an expired URL: fetch fresh ones before retrying.
        if (result.status === 403) u.urls.delete(part);
        const retry = () => {
            if (!u.backoff.delete(timer)) return;
            clearTimeout(timer);
            void schedule();
        };
        const timer = setTimeout(
            retry,
            waiting ? OFFLINE_RECHECK_MS : backoffDelay(attempt, options.random),
        );
        u.backoff.add(timer);
        if (waiting) void onlineAgain(offline).then(retry);
        emit();
    }

    /* The file is done the moment its version is current, thumbnail and all. */
    async function published(u: Internal, result: { node: NodeView | null }) {
        await journalForget(u);
        set(u, { status: 'done', node: result.node, finishedAt: now(), loaded: u.item.total });
        options.onEvent?.({ type: 'done', item: u.item });
        if (result.node) options.onPublished?.(result.node, u.item.parentId);
        await rpc('driveUploadForget', { objectId: u.objectId }).catch(() => {});
    }

    async function complete(u: Internal) {
        const generation = u.generation;
        if (!u.uploadId) return;
        set(u, { status: 'completing' });
        const parts = [...u.parts.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([partNumber, part]) => ({ partNumber, etag: part.etag }));
        try {
            let result: { node: NodeView | null };
            try {
                result = await api.completeUpload(workspaceOf(u), u.uploadId, parts);
            } catch (error) {
                if (!isConflicted(error)) throw error;
                result = await attach(u, generation);
            }
            if (u.generation !== generation) return;
            await published(u, result);
        } catch (error) {
            if (u.generation !== generation) return;
            fail(u, error instanceof Error ? error.message : 'The upload could not be finished.');
        } finally {
            void schedule();
        }
    }

    /* A restored or retried upload the server already holds as `conflicted`. */
    async function finishConflicted(u: Internal) {
        const generation = u.generation;
        set(u, { status: 'completing', error: null });
        try {
            const result = await attach(u, generation);
            if (u.generation !== generation) return;
            await published(u, result);
        } catch (error) {
            if (u.generation !== generation) return;
            if (isLockError(error)) return locked();
            fail(u, error instanceof Error ? error.message : 'The upload could not be finished.');
        } finally {
            void schedule();
        }
    }

    /*
     * The bytes are at the store but the node moved on while they were in flight.
     * Attach publishes them under fresh keys instead of uploading again: to the
     * same node when the version begin expected is still current (its key was
     * rotated), otherwise as a new sibling, a conflict copy, so that nobody's
     * version is overwritten. The worker rewraps the content key it still holds.
     */
    async function attach(u: Internal, generation: number) {
        const entry = u.entry;
        if (!u.uploadId || !entry || !options.openNodes)
            throw new Error('This file changed while it was uploading. Upload it again.');
        const workspaceId = workspaceOf(u);
        const { parent, replaces } = await options.openNodes(entry);
        if (u.generation !== generation) throw new Error('Cancelled.');
        u.parent = parent;
        if (!u.prepared) {
            await rpc('driveUploadReopen', reopenInput(entry));
            u.prepared = true;
        }
        const versionUnchanged =
            replaces !== undefined &&
            entry.expectedVersionId !== undefined &&
            (replaces.currentVersion?.id ?? null) === entry.expectedVersionId;
        if (versionUnchanged) {
            const { contentKeyEnvelope } = await rpc('driveUploadRewrap', {
                workspaceId,
                objectId: u.objectId,
                nodeId: replaces.id,
                versionId: u.versionId,
            });
            try {
                return await api.attachUpload(workspaceId, u.uploadId, {
                    mode: 'same-node',
                    keyEpoch: replaces.keyEpoch,
                    contentKeyEnvelope,
                });
            } catch (error) {
                // The version moved between the listing and the attach: keep both.
                if (!isConflicted(error)) throw error;
            }
        }
        const from = await takeEpoch(workspaceId);
        const nodeId = crypto.randomUUID();
        const name = conflictCopyName(u.item.name);
        const { nodes } = await rpc('driveCreateNodes', {
            workspaceId,
            nodes: [
                {
                    id: nodeId,
                    parentId: parent.id,
                    parentKeyEpoch: parent.keyEpoch,
                    keyEpoch: from,
                    metadata: {
                        name,
                        mime: u.item.mime,
                        size: u.item.size,
                        modified: u.file?.lastModified
                            ? new Date(u.file.lastModified).toISOString()
                            : null,
                    },
                },
            ],
        });
        const { contentKeyEnvelope } = await rpc('driveUploadRewrap', {
            workspaceId,
            objectId: u.objectId,
            nodeId,
            versionId: u.versionId,
        });
        const result = await api.attachUpload(workspaceId, u.uploadId, {
            mode: 'sibling',
            node: {
                id: nodeId,
                parentId: parent.id,
                parentKeyEpoch: parent.keyEpoch,
                keyEpoch: from,
                keyEnvelope: nodes[0]!.keyEnvelope,
                metadataEnvelope: nodes[0]!.metadataEnvelope,
            },
            contentKeyEnvelope,
        });
        u.nodeId = nodeId;
        set(u, { name, parentId: parent.id });
        return result;
    }

    let scheduling = false;
    /* Hands out work: start queued files while under the limit, then fill the part pool. */
    async function schedule() {
        if (scheduling) return;
        scheduling = true;
        try {
            let active = [...uploads.values()].filter(isActive).length;
            for (const id of order) {
                const u = uploads.get(id)!;
                if (u.item.status !== 'queued' || active >= maxActiveFiles || !u.file) continue;
                active++;
                void prepare(u)
                    .then(() => schedule())
                    .catch((error: unknown) => {
                        if (u.item.status === 'cancelled') return;
                        if (isLockError(error)) return locked();
                        fail(
                            u,
                            error instanceof DriveApiError || error instanceof Error
                                ? error.message
                                : 'The upload could not start.',
                            error instanceof DriveApiError ? error.code : null,
                        );
                    });
            }
            let slots = maxPartsInFlight - inFlightTotal();
            for (const id of order) {
                if (slots <= 0) break;
                const u = uploads.get(id)!;
                if (u.item.status !== 'uploading' || !u.uploadId || !u.prepared || !u.file)
                    continue;
                const missing = missingParts(u);
                if (!missing.length) {
                    if (u.inFlight.size === 0 && u.parts.size === u.item.chunkCount)
                        void complete(u);
                    continue;
                }
                for (const part of missing) {
                    if (slots <= 0) break;
                    // A part waiting on its backoff keeps its slot free for others.
                    if (u.backoff.size && (u.attempts.get(part) ?? 0) > 0) continue;
                    slots--;
                    void putPart(u, part).catch((error: unknown) => {
                        u.inFlight.delete(part);
                        if (isLockError(error)) return locked();
                        fail(u, error instanceof Error ? error.message : 'The upload failed.');
                    });
                }
            }
        } finally {
            scheduling = false;
        }
    }

    function makeInternal(item: UploadItem, file: File | null, parent: DriveNode | null): Internal {
        return {
            item,
            file,
            handle: null,
            parent,
            replaces: undefined,
            nodeId: crypto.randomUUID(),
            versionId: crypto.randomUUID(),
            objectId: crypto.randomUUID(),
            uploadId: null,
            keyEpoch: 0,
            entry: null,
            queued: null,
            stash: null,
            thumbnail: null,
            prepared: false,
            preparing: false,
            parts: new Map(),
            digests: new Map(),
            urls: new Map(),
            inFlight: new Map(),
            attempts: new Map(),
            completedBytes: 0,
            fetchingUrls: null,
            backoff: new Set(),
            generation: 0,
        };
    }

    function enqueue(inputs: EnqueueInput[]) {
        const ids: string[] = [];
        for (const input of inputs) {
            const id = crypto.randomUUID();
            const size = input.file.size;
            const u = makeInternal(
                {
                    id,
                    name: input.name ?? input.file.name,
                    size,
                    mime: input.file.type || null,
                    parentId: input.parent.id,
                    parentName: input.parent.name,
                    status: 'queued',
                    error: null,
                    errorCode: null,
                    loaded: 0,
                    total: ciphertextSize(size),
                    bytesPerSecond: 0,
                    chunkCount: chunkCount(size),
                    partsDone: 0,
                    startedAt: null,
                    finishedAt: null,
                    node: null,
                    needsFile: false,
                    hasHandle: Boolean(input.handle) || Boolean(input.stash),
                    origin: input.origin ?? 'file',
                },
                input.file,
                input.parent,
            );
            u.replaces = input.replaces;
            u.handle = input.handle ?? null;
            u.stash = input.stash ?? null;
            if (input.replaces) u.nodeId = input.replaces.id;
            // On disk before anything else happens, so a reload forgets no file that was waiting.
            u.queued = {
                id,
                workspaceId: input.parent.workspaceId,
                parentId: input.parent.id,
                parentName: input.parent.name,
                name: u.item.name,
                replacesId: input.replaces?.id ?? null,
                file: {
                    name: input.file.name,
                    size,
                    lastModified: input.file.lastModified,
                    type: input.file.type,
                },
                handle: u.handle,
                origin: u.item.origin,
                stash: u.stash,
                createdAt: now(),
                updatedAt: now(),
            };
            void journal?.putQueued(u.queued).catch(() => {});
            uploads.set(id, u);
            order.push(id);
            ids.push(id);
        }
        emit();
        void schedule();
        return ids;
    }

    /*
     * Reopens the keys for an upload whose worker state is gone (reload or lock):
     * the app opens the node, then the worker unwraps the content key from the
     * journaled envelope. Nothing new is minted.
     */
    async function reopen(u: Internal) {
        const entry = u.entry;
        if (!entry || !options.openNodes)
            throw new Error('This upload cannot be resumed on this device.');
        const { parent, replaces } = await options.openNodes(entry);
        u.parent = parent;
        u.replaces = replaces;
        await rpc('driveUploadReopen', reopenInput(entry));
        u.prepared = true;
    }

    /* What the worker needs to hold an upload's keys again; the trailer must be the journaled one. */
    function reopenInput(entry: JournalEntry) {
        return {
            workspaceId: entry.workspaceId,
            nodeId: entry.nodeId,
            versionId: entry.versionId,
            objectId: entry.objectId,
            contentSuite: entry.contentSuite ?? 0,
            contentKeyEnvelope: entry.contentKeyEnvelope,
            contentNonce: entry.contentNonce,
            plaintextSize: entry.file.size,
            thumbnail: entry.thumbnail ?? null,
        };
    }

    /*
     * Reconciles the parts we believe landed with the ones the store reports. An
     * upload the server holds as conflicted has all its bytes and wants attaching;
     * one that is gone or expired must start over.
     */
    type Reconciled = 'ok' | 'conflicted' | 'completed' | 'completing' | 'restart';
    async function reconcile(u: Internal): Promise<Reconciled> {
        if (!u.uploadId) return 'restart';
        const state = await api.uploadState(workspaceOf(u), u.uploadId);
        if (state.upload.status === 'conflicted') return 'conflicted';
        // The complete request got through as the page went away: the server holds
        // the file finished, and sending it again would make a second copy.
        if (state.upload.status === 'completed') return 'completed';
        if (state.upload.status === 'completing') return 'completing';
        if (state.upload.status !== 'open' || new Date(state.upload.expiresAt).getTime() <= now())
            return 'restart';
        const stored = new Map(state.parts.map((part) => [part.partNumber, part]));
        for (const [part, known] of Array.from(u.parts)) {
            const remote = stored.get(part);
            if (!remote || remote.etag !== known.etag) u.parts.delete(part);
        }
        u.completedBytes = [...u.parts.values()].reduce((sum, part) => sum + part.bytes, 0);
        return 'ok';
    }

    /*
     * What a reconciled upload does when it cannot simply carry on. Returns false
     * for `ok`, when the caller continues sending parts.
     */
    async function settleReconciled(u: Internal, state: Reconciled) {
        switch (state) {
            case 'restart':
                await startOver(u);
                return true;
            case 'conflicted':
                await finishConflicted(u);
                return true;
            case 'completed':
                // Published while this device was away: nothing to send, nothing to abort.
                await published(u, { node: null });
                void schedule();
                return true;
            case 'completing':
                // The server is still finishing it; a retry reconciles again. Starting
                // over here would upload a duplicate beside the one about to appear.
                fail(u, 'This upload is still being finished on the server. Retry in a moment.');
                return true;
            default:
                return false;
        }
    }

    /* Throws everything away and begins again with a fresh object, key and nonce. */
    async function startOver(u: Internal) {
        if (u.uploadId) await api.abortUpload(workspaceOf(u), u.uploadId).catch(() => {});
        await rpc('driveUploadForget', { objectId: u.objectId }).catch(() => {});
        await journalRemove(u);
        u.generation++;
        u.uploadId = null;
        u.prepared = false;
        u.versionId = crypto.randomUUID();
        u.objectId = crypto.randomUUID();
        if (!u.replaces) u.nodeId = crypto.randomUUID();
        u.parts.clear();
        u.digests.clear();
        u.urls.clear();
        u.inFlight.clear();
        u.attempts.clear();
        u.completedBytes = 0;
        set(u, {
            status: 'queued',
            error: null,
            errorCode: null,
            loaded: 0,
            partsDone: 0,
            needsFile: false,
        });
        void schedule();
    }

    async function pause(id: string) {
        const u = uploads.get(id);
        if (!u) return;
        if (u.item.status === 'queued' || u.item.status === 'preparing') {
            // Preparation runs on to its end (keys, reservation, journal entry) and then holds.
            set(u, { status: 'paused' });
            return;
        }
        if (u.item.status !== 'uploading') return;
        clearBackoff(u);
        set(u, { status: 'paused' });
        await rpc('driveUploadCancel', { objectId: u.objectId }).catch(() => {});
        void schedule();
    }

    /*
     * Continues a paused upload. One that lost its worker state (reload, lock) has
     * its keys reopened from the journal and its parts reconciled with the store
     * first; if the store no longer has the upload, it starts over.
     */
    async function resume(id: string): Promise<void> {
        const u = uploads.get(id);
        if (!u || u.item.status !== 'paused') return;
        if (!u.file) {
            if (u.stash) {
                const file = await fromStash(u);
                if (u.item.status !== 'paused') return;
                if (file) {
                    await attachFile(id, file);
                    return;
                }
                await lost(u);
                return;
            }
            if (u.item.origin === 'copy') {
                await lost(u);
                return;
            }
            if (u.handle) {
                // Chromium only; other browsers never hand out handles, so this is not reached.
                const handle = u.handle as FileSystemFileHandle & {
                    requestPermission?: (options: { mode: 'read' }) => Promise<PermissionState>;
                };
                const permission = await (
                    handle.requestPermission?.({ mode: 'read' }) ??
                    Promise.resolve('denied' as const)
                ).catch(() => 'denied' as const);
                if (permission === 'granted') {
                    const file = await u.handle.getFile();
                    await attachFile(id, file);
                    return;
                }
            }
            set(u, { error: 'Choose the file to continue this upload.' });
            return;
        }
        if (u.preparing) {
            // Still preparing: it carries on and sends when done, as if never paused.
            set(u, { status: 'preparing', error: null });
            return;
        }
        if (!u.uploadId) {
            set(u, { status: 'queued', error: null });
            void schedule();
            return;
        }
        if (!u.prepared) {
            try {
                await reopen(u);
                if (await settleReconciled(u, await reconcile(u))) return;
            } catch (error) {
                if (isLockError(error)) return locked();
                fail(u, error instanceof Error ? error.message : 'The upload could not resume.');
                return;
            }
        }
        set(u, { status: 'uploading', error: null, partsDone: u.parts.size, loaded: loadedOf(u) });
        void schedule();
    }

    /*
     * Gives a restored upload its file back. The file must be the one that was
     * journaled: same size and modification time, and every chunk that already
     * left the machine must hash to what the journal recorded. Anything else
     * starts over, because encrypting different bytes under the same key and nonce
     * as an uploaded part is the one thing the cipher forbids.
     */
    async function attachFile(id: string, file: File) {
        const u = uploads.get(id);
        if (!u) return { ok: false as const, reason: 'unknown' as const };
        if (!u.entry) return attachQueued(u, file);
        const entry = u.entry;
        u.file = file;
        set(u, { needsFile: false, error: null });
        const identity =
            file.size === entry.file.size &&
            file.name === entry.file.name &&
            file.lastModified === entry.file.lastModified;
        try {
            await reopen(u);
            let verified = identity;
            if (verified)
                for (const [part, journaled] of Object.entries(entry.parts)) {
                    if (!journaled.etag) continue;
                    const { digest } = await rpc('driveUploadDigest', {
                        objectId: u.objectId,
                        file,
                        index: Number(part) - 1,
                    });
                    if (digest !== journaled.digest) {
                        verified = false;
                        break;
                    }
                }
            const state = verified ? await reconcile(u) : 'restart';
            if (state === 'restart') {
                await startOver(u);
                return { ok: true as const, resumed: false as const };
            }
            if (state !== 'ok') {
                void settleReconciled(u, state);
                return { ok: true as const, resumed: true as const };
            }
        } catch (error) {
            if (isLockError(error)) {
                locked();
                return { ok: false as const, reason: 'locked' as const };
            }
            fail(u, error instanceof Error ? error.message : 'The upload could not resume.');
            return { ok: false as const, reason: 'failed' as const };
        }
        set(u, { status: 'uploading', partsDone: u.parts.size, loaded: loadedOf(u) });
        void schedule();
        return { ok: true as const, resumed: true as const };
    }

    /*
     * A file that was only waiting when the page went away: nothing was sent, so
     * it needs its parent looked up and then starts like any queued upload. The
     * file must be the one that was queued; a stashed one is that by construction.
     */
    async function attachQueued(u: Internal, file: File) {
        const queued = u.queued;
        if (!queued || u.item.status !== 'paused' || !options.openNodes)
            return { ok: false as const, reason: 'unknown' as const };
        const same =
            u.stash !== null ||
            (file.size === queued.file.size &&
                file.name === queued.file.name &&
                file.lastModified === queued.file.lastModified);
        if (!same) {
            set(u, { error: 'That is not the file that was waiting to upload.' });
            return { ok: false as const, reason: 'different' as const };
        }
        try {
            const { parent, replaces } = await options.openNodes(queued);
            if (u.item.status !== 'paused')
                return { ok: false as const, reason: 'unknown' as const };
            if (queued.replacesId && !replaces) {
                fail(u, 'The file this was going to replace is gone.');
                return { ok: false as const, reason: 'failed' as const };
            }
            u.parent = parent;
            u.replaces = replaces;
        } catch (error) {
            if (isLockError(error)) {
                locked();
                return { ok: false as const, reason: 'locked' as const };
            }
            fail(u, error instanceof Error ? error.message : 'The upload could not start.');
            return { ok: false as const, reason: 'failed' as const };
        }
        u.file = file;
        set(u, { status: 'queued', needsFile: false, error: null });
        void schedule();
        return { ok: true as const, resumed: false as const };
    }

    /* A failed upload picks up from its last acknowledged part when the server still has it. */
    async function retry(id: string) {
        const u = uploads.get(id);
        if (!u || u.item.status !== 'failed') return;
        // A lost copy has nothing to retry with; the list keeps its row until removed.
        if (!u.file) return;
        u.attempts.clear();
        if (u.uploadId && u.file) {
            try {
                if (!u.prepared) await reopen(u);
                const state = await reconcile(u);
                if (state !== 'ok') return void (await settleReconciled(u, state));
                set(u, {
                    status: 'uploading',
                    error: null,
                    partsDone: u.parts.size,
                    loaded: loadedOf(u),
                });
                void schedule();
                return;
            } catch {
                /* Fall through: start over with a fresh object. */
            }
        }
        await startOver(u);
    }

    async function cancel(id: string) {
        const u = uploads.get(id);
        if (!u || u.item.status === 'done' || u.item.status === 'cancelled') return;
        u.generation++;
        clearBackoff(u);
        set(u, { status: 'cancelled', finishedAt: now() });
        options.onEvent?.({ type: 'cancelled', item: u.item });
        await rpc('driveUploadCancel', { objectId: u.objectId }).catch(() => {});
        await rpc('driveUploadForget', { objectId: u.objectId }).catch(() => {});
        if (u.uploadId) await api.abortUpload(workspaceOf(u), u.uploadId).catch(() => {});
        await journalForget(u);
        u.inFlight.clear();
        void schedule();
    }
    function remove(id: string) {
        const u = uploads.get(id);
        if (!u) return;
        if (u.item.status !== 'done' && u.item.status !== 'cancelled' && u.item.status !== 'failed')
            return;
        uploads.delete(id);
        order.splice(order.indexOf(id), 1);
        emit();
    }
    function clearFinished() {
        for (const id of order.slice()) {
            const status = uploads.get(id)!.item.status;
            if (status === 'done' || status === 'cancelled') remove(id);
        }
    }
    function pauseAll() {
        for (const id of order) void pause(id);
    }
    function resumeAll() {
        for (const id of order) void resume(id);
    }

    /*
     * Brings back the uploads this device journaled for a workspace, paused and
     * waiting for their files. Entries past their server expiry are discarded, and
     * the server is told so its reservation goes.
     */
    async function restore(workspaceId?: string) {
        if (!journal) return [];
        const entries = workspaceId ? await journal.list(workspaceId) : await journal.listAll();
        const waiting = await journal.listQueued(workspaceId);
        const queuedById = new Map(waiting.map((entry) => [entry.id, entry]));
        const ids: string[] = [];
        const stashed: string[] = [];
        const restoredItem = (u: Internal) => {
            uploads.set(u.item.id, u);
            order.push(u.item.id);
            ids.push(u.item.id);
            if (u.stash) stashed.push(u.item.id);
            options.onEvent?.({ type: 'restored', item: u.item });
        };
        for (const entry of entries) {
            queuedById.delete(entry.id);
            if (uploads.has(entry.id)) continue;
            const queued = waiting.find((row) => row.id === entry.id) ?? null;
            // Expired, or begun under the previous suite, which nothing here can
            // resume: the server's side is aborted and the file goes back to the person.
            if (
                new Date(entry.expiresAt).getTime() <= now() ||
                entry.contentSuite !== CONTENT_SUITE
            ) {
                await api.abortUpload(entry.workspaceId, entry.uploadId).catch(() => {});
                await journal.remove(entry.id).catch(() => {});
                if (queued) await journal.removeQueued(entry.id).catch(() => {});
                if (entry.stash && options.stash)
                    await options.stash.remove(entry.stash).catch(() => {});
                continue;
            }
            const done = Object.values(entry.parts).filter((part) => part.etag);
            const stash = entry.stash ?? null;
            const u = makeInternal(
                {
                    id: entry.id,
                    name: entry.name ?? entry.file.name,
                    size: entry.file.size,
                    mime: entry.file.type || null,
                    parentId: entry.parentId,
                    parentName: entry.parentName,
                    status: 'paused',
                    error: null,
                    errorCode: null,
                    loaded: done.reduce((sum, part) => sum + (part.bytes ?? 0), 0),
                    total: entry.ciphertextSize ?? ciphertextSize(entry.file.size),
                    bytesPerSecond: 0,
                    chunkCount: chunkCount(entry.file.size),
                    partsDone: done.length,
                    startedAt: entry.createdAt,
                    finishedAt: null,
                    node: null,
                    needsFile: true,
                    hasHandle: entry.handle !== null || stash !== null,
                    origin: entry.origin ?? 'file',
                },
                null,
                null,
            );
            u.handle = entry.handle;
            u.stash = stash;
            u.nodeId = entry.nodeId;
            u.versionId = entry.versionId;
            u.objectId = entry.objectId;
            u.uploadId = entry.uploadId;
            u.keyEpoch = entry.keyEpoch;
            u.entry = entry;
            u.queued = queued;
            for (const [part, journaled] of Object.entries(entry.parts)) {
                u.digests.set(Number(part), journaled.digest);
                if (journaled.etag)
                    u.parts.set(Number(part), {
                        etag: journaled.etag,
                        bytes: journaled.bytes ?? 0,
                    });
            }
            u.completedBytes = u.item.loaded;
            restoredItem(u);
        }
        // Files that were waiting and never began: the server holds nothing for them.
        for (const queued of queuedById.values()) {
            if (uploads.has(queued.id)) continue;
            const u = makeInternal(
                {
                    id: queued.id,
                    name: queued.name,
                    size: queued.file.size,
                    mime: queued.file.type || null,
                    parentId: queued.parentId,
                    parentName: queued.parentName,
                    status: 'paused',
                    error: null,
                    errorCode: null,
                    loaded: 0,
                    total: ciphertextSize(queued.file.size),
                    bytesPerSecond: 0,
                    chunkCount: chunkCount(queued.file.size),
                    partsDone: 0,
                    startedAt: null,
                    finishedAt: null,
                    node: null,
                    needsFile: true,
                    hasHandle: queued.handle !== null || queued.stash !== null,
                    origin: queued.origin,
                },
                null,
                null,
            );
            u.handle = queued.handle;
            u.stash = queued.stash;
            u.queued = queued;
            if (queued.replacesId) u.nodeId = queued.replacesId;
            restoredItem(u);
        }
        emit();
        // Copies without bytes on this device are lost, not left waiting for a file nobody has.
        for (const id of ids) {
            const u = uploads.get(id)!;
            if (u.item.origin === 'copy' && !u.stash) await lost(u);
        }
        // Stashed bytes need nobody: continue from them at once.
        for (const id of stashed) void resume(id);
        if (options.stash?.sweep) {
            const keep = new Set<string>();
            for (const entry of await journal.listAll()) if (entry.stash) keep.add(entry.stash);
            for (const entry of await journal.listQueued()) if (entry.stash) keep.add(entry.stash);
            for (const u of uploads.values()) if (u.stash) keep.add(u.stash);
            await options.stash.sweep(keep).catch(() => {});
        }
        return ids;
    }

    /* Forgets a restored upload the person does not want to finish. */
    async function discard(id: string) {
        const u = uploads.get(id);
        if (!u) return;
        if (u.item.status !== 'paused' && u.item.status !== 'failed') return;
        u.generation++;
        if (u.uploadId) await api.abortUpload(workspaceOf(u), u.uploadId).catch(() => {});
        await rpc('driveUploadForget', { objectId: u.objectId }).catch(() => {});
        await journalForget(u);
        uploads.delete(id);
        order.splice(order.indexOf(id), 1);
        emit();
    }

    return {
        enqueue,
        pause,
        resume,
        retry,
        cancel,
        remove,
        discard,
        clearFinished,
        pauseAll,
        resumeAll,
        restore,
        attachFile,
        getState,
        subscribe,
    };
}

export type TransferManager = ReturnType<typeof createTransferManager>;

/* Human units for speeds and sizes; the UI formats, the engine never does. */
export function formatRate(bytesPerSecond: number) {
    if (!bytesPerSecond) return '';
    const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s'];
    let value = bytesPerSecond;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${unit === 0 ? Math.round(value) : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
