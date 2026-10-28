import type {
    CryptoResults,
    NodeMetadata,
    UploadBytes,
    SignatureForm,
    UploadPartProgress,
    UploadPartResult,
} from '@hushos/crypto';
import { CONTENT_SUITE, chunkCount, ciphertextSize, contentLength } from '@hushos/crypto/drive';
import { KEY_CHANGE_PENDING } from '@hushos/crypto/protocol';
import { newId as mintScopedId, type IdKind } from '@hushos/crypto/ids';
import type { DriveApi, NodeView, PartUrl } from './api';
import type { DriveErrorCode } from './protocol';
import { DriveApiError } from './api';
import type { DriveNode, Rpc } from './client';
import type {
    IdSeeds,
    JournalEntry,
    QueuedEntry,
    UploadJournal,
    UploadMove,
    UploadOrigin,
    UploadSignatures,
} from './journal';

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
    /*
     * While preparing: why it waits before anything is made (a family folder's
     * key change has not reached the folder yet). It carries on by itself.
     */
    waitingFor?: string | null;
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
    /* A move between the person's workspaces: the file this is a copy of (UploadMove). */
    move?: UploadMove | null;
};

export type TransfersState = {
    uploads: UploadItem[];
    active: number;
    bytesPerSecond: number;
};

/*
 * Bytes held in memory rather than a file on disk: a saved copy, or one
 * reopened from its sealed stash. They are never wrapped in a Blob, since
 * Chrome can page a large Blob to its profile directory, which would put the
 * plaintext on disk. The first time the upload reads them they move to the
 * crypto worker (transferred, not copied), and the parts here are detached.
 */
export type MemoryFile = {
    kind: 'memory';
    name: string;
    size: number;
    type: string;
    lastModified: number;
    /* The bytes, in any number of pieces; their lengths add up to `size`. */
    parts: Uint8Array[];
    /* A ready thumbnail (a copy keeps its source's): nothing renders one from memory. */
    thumbnail?: Uint8Array | null;
};
export type UploadFile = File | MemoryFile;

export function inMemory(file: UploadFile): file is MemoryFile {
    return (file as MemoryFile).kind === 'memory';
}

export type EnqueueInput = {
    file: UploadFile;
    parent: DriveNode;
    /* Replace this file's content with a new version instead of creating a node. */
    replaces?: DriveNode;
    /* The name the file takes in Drive when it differs from the file's own ("keep both"). */
    name?: string;
    handle?: FileSystemFileHandle;
    /* A copy of something shared, rather than a file the person holds. */
    origin?: UploadOrigin;
    /*
     * The statements a copy's metadata and version are signed with, by where
     * it came from (see signatureFormFor in ./trust); ordinary when absent.
     */
    signAs?: UploadSignatures;
    /* The stash the app wrote this upload's bytes to, so a reload can reopen them. */
    stash?: string;
    /* A move: the file this one is a re-encrypted copy of. */
    move?: UploadMove;
};

/* Where the app keeps the bytes of uploads that have no file on disk, by name. */
/* The stash's bytes are gone or won't open (not merely unreachable for now): the upload is lost. */
export class StashGone extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'StashGone';
    }
}

export type UploadStash = {
    /*
     * Reopens stashed bytes as the file the journal describes. Rejects with
     * StashGone when they are gone or won't open; any other rejection (a lock,
     * a busy disk) leaves the stash for a later try.
     */
    open(name: string, file: JournalEntry['file']): Promise<UploadFile>;
    remove(name: string): Promise<void>;
    /* Drops every stash not named in `keep`, for stashes whose upload finished without cleanup. */
    sweep?(keep: Set<string>): Promise<void>;
};

/*
 * Which session of the account uploads are for (the app's device session): `open` is false
 * from a sign-out until the next sign-in, and `generation` moves on at every sign-out, so work
 * that began before one (a copy still reading its bytes) can be told apart from work after.
 */
export type UploadSession = { open(): boolean; generation(): number };

/* An enqueue refused because the person signed out of this browser after it began. */
export class SignedOutError extends Error {
    constructor() {
        super('You signed out of this browser, so this wasn’t added.');
        this.name = 'SignedOutError';
    }
}

export type TransferManagerOptions = {
    rpc: Rpc;
    api: DriveApi;
    journal?: UploadJournal;
    /* Without one, every enqueue is taken (tests, and pages with no account). */
    session?: UploadSession;
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
    /*
     * Why nothing may be written into `target` now, or null: asked again at
     * prepare, right before a node or a content key is made, since a family
     * folder's key change can land after a file was queued (adding to a folder
     * the walk has not reached is refused: docs/groups-server.md 8). A refused
     * folder is looked up again (openNodes) before the answer stands, so a
     * walk that has reached it since lets the upload go. A refusal fails the
     * upload with that sentence; nothing retries it on its own.
     */
    refuseWrite?: (target: DriveNode) => string | null;
    /*
     * Whether a refusal of `target` is only a key change still walking its
     * family folder (docs/groups-server.md 8, decision D9): then the upload
     * waits, looking the folder up again every `keyChangeRecheckMs`, and goes
     * once the walk has re-keyed it (its key epoch at the walk's target) or
     * the walk is over. Any other refusal fails the upload as before.
     */
    waitsForKeyChange?: (target: DriveNode) => boolean;
    keyChangeRecheckMs?: number;
    /*
     * One pause while an upload waits out a family folder's key change: between
     * looks at a folder the app knows is waiting, and after the server refused
     * a begin or an attach (409 rotating: the walk had not reached `target`,
     * which the app may not have heard of yet). The app learns of the run, and
     * of its end, and lets this device's own background walk join it; then it
     * resolves, and the engine looks the folder (and the file it replaces) up
     * again and seals the upload afresh under the keys it finds. `attempt`
     * counts this upload's pauses from 1, for the app's backoff. Without it
     * the engine waits `keyChangeRecheckMs` between looks.
     */
    keyChangePause?: (target: DriveNode, attempt: number) => Promise<void>;
    /* How long an upload waits out a key change before it fails and says so (30 minutes). */
    keyChangeGiveUpMs?: number;
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
    /* Mints an id and its seed in a workspace; @hushos/crypto's newId unless a test pins it. */
    newId?: (kind: IdKind, workspaceId: string) => Promise<{ id: string; seed: string }>;
};

type Internal = {
    item: UploadItem;
    file: UploadFile | null;
    /* An in-memory file's bytes, once moved to the worker: the id they are read by there. */
    sourceId: string | null;
    attaching: Promise<string> | null;
    handle: FileSystemFileHandle | null;
    parent: DriveNode | null;
    replaces: DriveNode | undefined;
    /* Empty until minted in the folder's workspace at prepare (see mintIds). */
    nodeId: string;
    versionId: string;
    objectId: string;
    /* The seeds the ids were derived from, sent with begin; null until minted. */
    seeds: IdSeeds | null;
    signAs: UploadSignatures;
    uploadId: string | null;
    keyEpoch: number;
    /* The journal row, once begin has succeeded; null before, and for finished uploads. */
    entry: JournalEntry | null;
    /* The queued row, from enqueue until the upload is settled; the only row a waiting file has. */
    queued: QueuedEntry | null;
    stash: string | null;
    /* The thumbnail in flight (a render, or an in-memory file's own), started with the upload. */
    thumbnail: Promise<Uint8Array | null> | null;
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
    /*
     * Look the folder (and the file replaced) up again before sealing: the
     * snapshot held may be under keys a key change has replaced since (after
     * a 409 rotating, or on a retry).
     */
    lookAgain: boolean;
    /* Pauses waiting out a key change in this attempt, and when the first began; null when not waiting. */
    keyChangePauses: number;
    keyChangeSince: number | null;
    /* In a pause between looks: the only part of a key-change wait that holds no slot. */
    pausing: boolean;
};

/*
 * What an upload signs when nothing says otherwise: ordinary for a file the
 * person holds; for a copy journaled before copies said how to sign, re-sealed,
 * as every copy was then.
 */
function signaturesOf(origin: UploadOrigin, signAs: UploadSignatures | undefined) {
    if (signAs) return signAs;
    const form: SignatureForm = origin === 'copy' ? 'resealed' : 'ordinary';
    return { metadata: form, version: form };
}

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

/* How often an upload waiting for a family folder's key change looks the folder up again. */
const KEY_CHANGE_RECHECK_MS = 5_000;
/*
 * How long an upload waits out a key change before it fails. A walk re-keys a
 * family folder batch by batch, a large one for some minutes; one that has not
 * finished in half an hour has stalled, and the person is told rather than left
 * with an upload that never moves.
 */
const KEY_CHANGE_GIVE_UP_MS = 30 * 60_000;
export const KEY_CHANGE_GAVE_UP =
    'The family folder’s key change hasn’t finished, so this file wasn’t uploaded. Retry later.';

/* The server refused because a family folder's key change has not reached the folder (or the file). */
function isRotating(error: unknown) {
    return error instanceof DriveApiError && error.code === 'rotating';
}
/*
 * The crypto worker refused to write under a family folder key a key change
 * has not reached yet (design 2.10): a wait, like the server's 409 `rotating`,
 * even when the server says nothing of one.
 */
function isKeyChangePending(error: unknown) {
    return error instanceof Error && error.message === KEY_CHANGE_PENDING;
}
const pendingKeyChange = () => new DriveApiError(KEY_CHANGE_PENDING, 'rotating', 409);
/* The server refused envelopes under a key epoch that is no longer the node's (or its parent's). */
function isStale(error: unknown) {
    return error instanceof DriveApiError && error.code === 'stale';
}
/* A new version that waited out a key change, while someone else's version became current. */
export const VERSION_MOVED =
    'This file changed while the upload waited for a key change. Upload it again to replace the newer version.';

/*
 * An upload's object before the worker has prepared it: suite 3's padded size
 * and chunk count for a file of `size` bytes with a thumbnail trailer of
 * `thumbnailBytes` (0 until the render is known). Prepare replaces both with
 * what it sealed; a journaled upload knows its trailer from the start.
 */
export function plannedSize(size: number, thumbnailBytes: number) {
    return ciphertextSize(CONTENT_SUITE, size, thumbnailBytes);
}
export function plannedChunks(size: number, thumbnailBytes: number) {
    return chunkCount(contentLength(CONTENT_SUITE, size, thumbnailBytes));
}
/*
 * An upload's progress in the file's own bytes. What is sent is the padded
 * object (tags, padding, the thumbnail trailer), so `loaded` of `total` runs
 * past the file's size; shown to a person, it is scaled back to the file.
 */
export function fileProgress(item: Pick<UploadItem, 'size' | 'loaded' | 'total'>) {
    if (item.total <= 0) return { loaded: 0, total: item.size };
    const share = Math.min(1, Math.max(0, item.loaded / item.total));
    return { loaded: Math.round(item.size * share), total: item.size };
}

/* The thumbnail's length from its sealed trailer, which carries a 16-byte tag. */
function thumbnailBytesOf(trailer: Uint8Array | null | undefined) {
    return trailer && trailer.length > 16 ? trailer.length - 16 : 0;
}

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

/* What the worker (or the engine) says when an in-memory upload's bytes are not there to read. */
const SOURCE_GONE = 'This upload’s bytes are no longer on this device.';
function isSourceGone(error: unknown) {
    return error instanceof Error && error.message.includes('no longer on this device');
}

/* Whether an in-memory file's parts were moved away already (to a worker since lost). */
function detached(file: MemoryFile) {
    return file.parts.reduce((total, part) => total + part.byteLength, 0) !== file.size;
}

/* How long sign-out waits for the server to hear of each stopped upload before it forgets them anyway. */
const FORGET_TIMEOUT_MS = 5_000;

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
        newId = mintScopedId,
    } = options;
    const uploads = new Map<string, Internal>();
    const order: string[] = [];
    /* Begins on their way to the server: the upload id each will answer, or null if it fails. */
    const beginning = new Map<Internal, { workspaceId: string; answer: Promise<string | null> }>();
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
            // An upload pausing for a key change holds no slot: others go meanwhile. Looking its
            // folder up again and sealing afresh between pauses is work, and takes one.
            ((u.item.status === 'preparing' || u.item.status === 'completing') && !u.pausing) ||
            u.item.status === 'uploading'
        );
    }
    /* Uploads leaving a key-change pause, each waiting for a slot to seal again in. */
    const slotWaiters = new Set<() => void>();
    function slotFreed() {
        return new Promise<void>((resolve) => slotWaiters.add(resolve));
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
        set(u, {
            status: 'failed',
            error: message,
            errorCode: code,
            finishedAt: now(),
            waitingFor: null,
        });
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
            // The worker took an in-memory file's bytes with it. Ones it never had go too where a
            // sealed stash can bring them back after unlock, so no copy sits decrypted through a lock.
            // (Parts a lock cut off mid-move are found empty at the next read: see sourceGone.)
            if (u.file && inMemory(u.file) && (u.sourceId || u.stash)) u.file = null;
            u.sourceId = null;
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
    /*
     * A landed part's etag, written in the background. Tried twice; a journal that still refuses
     * it is left as it is. The row keeps the upload id, so a reload still resumes this upload
     * (dropping it would leave the server's upload holding quota while a restart reserved the
     * size again), and a part with no etag is simply sent again, checked against its journaled
     * digest first. Never rejects: the part did land.
     */
    async function journalLanded(
        u: Internal,
        part: number,
        landed: { etag: string; bytes: number },
    ) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                await journalPart(u, part, landed);
                return;
            } catch (error) {
                if (attempt === 2)
                    console.warn(
                        `The upload journal did not record part ${part}; it will be sent again if this upload resumes.`,
                        error instanceof Error ? error.name : error,
                    );
            }
        }
    }
    /* Drops the begun row only: the upload is starting over and stays queued. */
    async function journalRemove(u: Internal) {
        if (!journal || !u.entry) return;
        await journal.remove(u.entry.id).catch(() => {});
        u.entry = null;
    }
    /*
     * What the worker reads an upload's bytes from: the person's File as it is,
     * or an in-memory file's bytes, moved to the worker the first time they are
     * read and named by a source id after that.
     */
    async function bytesFor(u: Internal, file: UploadFile): Promise<UploadBytes> {
        if (!inMemory(file)) return file;
        if (u.sourceId) return { source: u.sourceId };
        u.attaching ??= (async () => {
            // Moved once already (then the worker was lost): the bytes are not here to move.
            if (detached(file)) throw new Error(SOURCE_GONE);
            const sourceId = crypto.randomUUID();
            const buffers = [...new Set(file.parts.map((part) => part.buffer))].filter(
                (buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer,
            );
            await rpc('driveSourceAttach', { sourceId, parts: file.parts }, { transfer: buffers });
            // Cancelled or removed while the bytes were on their way: nothing will release them
            // later (journalForget saw no source), so they are released now.
            if (uploads.get(u.item.id) !== u || u.item.status === 'cancelled') {
                await rpc('driveSourceRelease', { sourceId }).catch(() => {});
                throw new Error('This upload was stopped.');
            }
            // Set here, before `attaching` clears, so no read in between moves the parts again.
            u.sourceId = sourceId;
            return sourceId;
        })().finally(() => {
            u.attaching = null;
        });
        return { source: await u.attaching };
    }
    /*
     * The worker no longer holds an upload's in-memory bytes: a lock ended it
     * while the upload sat paused or failed, so nothing here noticed. What is
     * left of them goes, and the copy reopens from its sealed stash, or, with
     * none, is reported lost rather than failing at every retry.
     */
    async function sourceGone(u: Internal) {
        u.generation++;
        clearBackoff(u);
        u.inFlight.clear();
        u.prepared = false;
        u.sourceId = null;
        u.attaching = null;
        if (u.file && inMemory(u.file)) u.file = null;
        set(u, { status: 'paused', error: null });
        if (u.stash) await resume(u.item.id);
        else await lost(u);
    }
    /* The worker lets go of an in-memory file's bytes (and zeroes them). */
    async function releaseSource(u: Internal) {
        const sourceId = u.sourceId;
        u.sourceId = null;
        if (sourceId) await rpc('driveSourceRelease', { sourceId }).catch(() => {});
        if (u.file && inMemory(u.file)) u.file = null;
    }
    /* The upload is settled: every row goes, and the stash with it. */
    async function journalForget(u: Internal) {
        await releaseSource(u);
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
    /*
     * Reopens a restored upload's bytes from its stash, as the file the journal
     * described. Only a stash that is gone counts as lost; a lock pauses the
     * upload as any lock does, and anything else keeps the stash for a retry.
     */
    async function fromStash(u: Internal): Promise<UploadFile | 'lost' | 'locked' | 'later'> {
        const described = u.entry?.file ?? u.queued?.file;
        if (!u.stash || !options.stash || !described) return 'lost';
        try {
            return await options.stash.open(u.stash, described);
        } catch (error) {
            if (error instanceof StashGone) return 'lost';
            return isLockError(error) ? 'locked' : 'later';
        }
    }

    /* Begin: node envelopes (new file), content key, and the server's reservation. */
    /*
     * The upload's ids, derived in the workspace it lands in (the owner's, for a
     * folder shared with an editor) from fresh seeds the server derives again.
     * Minted once per attempt: a begin sent again reuses them and their seeds.
     */
    async function mintIds(u: Internal, workspaceId: string) {
        if (u.seeds) return;
        const node = u.replaces ? null : await newId('node', workspaceId);
        const version = await newId('version', workspaceId);
        const object = await newId('object', workspaceId);
        u.nodeId = node ? node.id : u.replaces!.id;
        u.versionId = version.id;
        u.objectId = object.id;
        u.seeds = { node: node?.seed ?? null, version: version.seed, object: object.seed };
    }

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
    /*
     * `target` once nothing refuses it: a refusal that is only a family folder's
     * key change still on its way waits (looked up again every recheck), any
     * other refusal throws. Null when the upload was cancelled or restarted
     * meanwhile. While it waits the upload says why and holds no slot; it keeps
     * saying so until its begin or attach lands, since the server may still
     * refuse it (keyChangeRefused).
     */
    async function untilWritable(
        u: Internal,
        generation: number,
        target: { parent: DriveNode; replaces?: DriveNode },
        lookup: () => Promise<{ parent: DriveNode; replaces?: DriveNode }>,
    ): Promise<{ parent: DriveNode; replaces?: DriveNode } | null> {
        let { parent, replaces } = target;
        let refused = refusalOf(parent, replaces);
        while (refused && waitsOf(parent, replaces)) {
            set(u, { waitingFor: refused });
            if (!(await pauseForKeyChange(u, generation, parent))) return null;
            if (u.item.status === 'cancelled') return null;
            const fresh = await lookup().catch(() => null);
            if (u.generation !== generation) return null;
            if (fresh) {
                parent = fresh.parent;
                if (replaces && fresh.replaces) replaces = fresh.replaces;
            }
            refused = refusalOf(parent, replaces);
        }
        if (refused) throw new Error(refused);
        return { parent, replaces };
    }
    /*
     * One pause while `u` waits out a key change: the app's (which learns of
     * the run and lets this device's walk join it), or a plain recheck. Never
     * past the give-up: the first pause of an attempt starts the clock, and a
     * pause that would run past it ends there and fails the upload, so nothing
     * waits forever, however the app's pause behaves. The pause itself holds no
     * slot; the look and the seal after it wait for one, so the queue never runs
     * more than maxActiveFiles at once. False when the run was cancelled,
     * discarded or started over meanwhile: it answers for nothing, not even the
     * give-up.
     */
    async function pauseForKeyChange(u: Internal, generation: number, target: DriveNode) {
        const current = () => u.generation === generation && uploads.get(u.item.id) === u;
        if (!current()) return false;
        const since = (u.keyChangeSince ??= now());
        const deadline = since + (options.keyChangeGiveUpMs ?? KEY_CHANGE_GIVE_UP_MS);
        if (now() >= deadline) throw new Error(KEY_CHANGE_GAVE_UP);
        const attempt = ++u.keyChangePauses;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const giveUp = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, deadline - now());
        });
        const pause = options.keyChangePause
            ? options.keyChangePause(target, attempt).catch(() => {})
            : new Promise<void>((resolve) =>
                  setTimeout(resolve, options.keyChangeRecheckMs ?? KEY_CHANGE_RECHECK_MS),
              );
        u.pausing = true;
        try {
            void schedule();
            await Promise.race([pause, giveUp]);
            clearTimeout(timer);
            if (!current()) return false;
            if (now() >= deadline) throw new Error(KEY_CHANGE_GAVE_UP);
            while ([...uploads.values()].filter(isActive).length >= maxActiveFiles) {
                await slotFreed();
                if (!current()) return false;
            }
            return true;
        } finally {
            clearTimeout(timer);
            u.pausing = false;
        }
    }
    /*
     * The server refused a begin or an attach because a family folder's key
     * change has not reached the folder or the file (409 rotating). The app may
     * not have heard of it (it started a moment ago), so nothing on this device
     * said to wait: the upload waits now, says so, and is looked up and sealed
     * again once the pause ends. False when it was cancelled or restarted
     * meanwhile.
     */
    async function keyChangeRefused(
        u: Internal,
        generation: number,
        error: DriveApiError,
        target: DriveNode,
    ) {
        set(u, { waitingFor: error.message });
        if (!(await pauseForKeyChange(u, generation, target))) return false;
        if (u.item.status === 'cancelled') return false;
        u.lookAgain = true;
        return true;
    }
    /* The upload got past a key change (or never met one): its wait, if any, is over. */
    function keyChangeOver(u: Internal) {
        u.keyChangePauses = 0;
        u.keyChangeSince = null;
        if (u.item.waitingFor) set(u, { waitingFor: null });
    }
    function waitsOf(parent: DriveNode, replaces: DriveNode | undefined) {
        const waits = options.waitsForKeyChange;
        if (!waits) return false;
        if (options.refuseWrite?.(parent)) return waits(parent);
        return replaces ? waits(replaces) : false;
    }
    function refusalOf(parent: DriveNode, replaces: DriveNode | undefined) {
        return (
            options.refuseWrite?.(parent) ??
            (replaces ? (options.refuseWrite?.(replaces) ?? null) : null)
        );
    }
    async function prepareInner(
        u: Internal,
        generation: number,
        file: UploadFile,
        parent: DriveNode,
    ) {
        // An in-memory file brings its thumbnail: rendering one would need its bytes in a Blob.
        if (inMemory(file)) u.thumbnail ??= Promise.resolve(file.thumbnail ?? null);
        else if (options.thumbnail && !u.thumbnail) {
            const render = options.thumbnail;
            u.thumbnail = render(file, u.item.mime)
                .then(async (blob) =>
                    blob?.size ? new Uint8Array(await blob.arrayBuffer()) : null,
                )
                .catch(() => null);
        }
        const workspaceId = workspaceOf(u);
        await mintIds(u, workspaceId);
        if (u.generation !== generation) return;
        const seeds = u.seeds!;
        const metadata: NodeMetadata = {
            name: u.item.name,
            mime: u.item.mime,
            size: u.item.size,
            modified: file.lastModified ? new Date(file.lastModified).toISOString() : null,
        };
        // Sealed, then begun; sealed again from a fresh look each time the server says a key
        // change has not reached the folder yet (409 rotating), until it takes it or the wait
        // gives up. Nothing the server refused is sent again: its envelopes are under keys the
        // key change is replacing.
        let sealed:
            | {
                  nodeEnvelopes: JournalEntry['node'];
                  prepared: CryptoResults['driveUploadPrepare'];
                  begun: Awaited<ReturnType<DriveApi['beginUpload']>>;
              }
            | undefined;
        while (!sealed) {
            // Asked again here, right before a node or a content key is made: into the folder, or
            // as a new version under the file's own key, either may be waiting for a key change.
            let refused = refusalOf(parent, u.replaces);
            if ((refused || u.lookAgain) && options.openNodes && u.queued) {
                // The folder as it was when queued (or when the server last refused it) may be
                // under an older key than it is now (the walk may have reached it since): looked
                // up afresh, then asked again.
                const fresh = await options.openNodes(u.queued);
                if (u.generation !== generation) return;
                // Looked at again for its keys, a replaced file must still be at the version this
                // upload set out to replace: one someone else made meanwhile is never overwritten.
                if (
                    u.lookAgain &&
                    u.replaces &&
                    fresh.replaces &&
                    (fresh.replaces.currentVersion?.id ?? null) !==
                        (u.replaces.currentVersion?.id ?? null)
                )
                    throw new Error(VERSION_MOVED);
                parent = u.parent = fresh.parent;
                if (u.replaces && fresh.replaces) u.replaces = fresh.replaces;
                u.lookAgain = false;
                refused = refusalOf(parent, u.replaces);
            }
            // A key change still walking the folder: wait for it, then look again, rather than fail.
            const queued = u.queued;
            const lookup = options.openNodes;
            if (refused && queued && lookup) {
                const ready = await untilWritable(
                    u,
                    generation,
                    { parent, replaces: u.replaces },
                    () => lookup(queued),
                );
                if (!ready) return;
                parent = u.parent = ready.parent;
                if (u.replaces && ready.replaces) u.replaces = ready.replaces;
                refused = null;
            }
            if (refused) throw new Error(refused);
            let node: Parameters<DriveApi['beginUpload']>[1]['node'];
            let nodeEnvelopes: JournalEntry['node'] = null;
            let prepared: CryptoResults['driveUploadPrepare'];
            try {
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
                                kind: 'file',
                                parentId: parent.id,
                                parentKeyEpoch: parent.keyEpoch,
                                keyEpoch: from,
                                metadata,
                                // A saved copy is signed by where it came from: saved from a link,
                                // re-locked when the original did not verify, ordinary when it did.
                                signAs: u.signAs.metadata,
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
                        idSeed: seeds.node!,
                        parentId: parent.id,
                        parentKeyEpoch: parent.keyEpoch,
                        keyEpoch: from,
                        keyEnvelope: nodeEnvelopes.keyEnvelope,
                        metadataEnvelope: nodeEnvelopes.metadataEnvelope,
                        metadataSignature: nodes[0]!.metadataSignature,
                    };
                }
                if (u.generation !== generation) return;
                // The thumbnail is sealed as the object's trailer at prepare, so its render
                // is waited for here: after this, nothing about the object changes.
                const thumbnail = u.thumbnail ? await u.thumbnail : null;
                if (u.generation !== generation) return;
                // A fresh content key, under the node key just made (or the replaced file's key as
                // just looked up): the worker forgets any it held for this object first.
                prepared = await rpc('driveUploadPrepare', {
                    workspaceId,
                    nodeId: u.nodeId,
                    versionId: u.versionId,
                    objectId: u.objectId,
                    plaintextSize: u.item.size,
                    thumbnail: thumbnail?.byteLength ? thumbnail : null,
                    signAs: u.signAs.version,
                });
            } catch (error) {
                // The worker will not seal under a folder key a key change has not reached:
                // waited out like the server's 409 rotating, then sealed again from a fresh look.
                if (!isKeyChangePending(error) || !options.openNodes || !u.queued) throw error;
                if (u.generation !== generation) return;
                if (!(await keyChangeRefused(u, generation, pendingKeyChange(), parent))) return;
                continue;
            }
            u.prepared = true;
            if (u.generation !== generation) return;
            // Padded: the object has the chunks of its bucket, which may be more than the file needs.
            set(u, { total: prepared.ciphertextSize, chunkCount: prepared.chunkCount });
            let begun: Awaited<ReturnType<DriveApi['beginUpload']>>;
            // Known while on its way, so a release can wait for the reservation it makes.
            let answer: Promise<string | null> | undefined;
            try {
                const request = api.beginUpload(workspaceId, {
                    node,
                    versionId: u.versionId,
                    versionIdSeed: seeds.version,
                    objectId: u.objectId,
                    objectIdSeed: seeds.object,
                    contentKeyEnvelope: prepared.contentKeyEnvelope,
                    versionSignature: prepared.versionSignature,
                    contentNonce: prepared.contentNonce,
                    contentSuite: CONTENT_SUITE,
                    chunkCount: prepared.chunkCount,
                    ciphertextSize: String(prepared.ciphertextSize),
                    // A move: the server deletes the source when this completes, in the same
                    // transaction (UploadMove).
                    ...(u.item.move && { moveOf: u.item.move.of }),
                });
                answer = request.then(
                    (result) => result.upload.id,
                    () => null,
                );
                beginning.set(u, { workspaceId, answer });
                begun = await request;
            } catch (error) {
                // Without a way to look the folder up again there is nothing to seal afresh from.
                if (!options.openNodes || !u.queued) throw error;
                if (u.generation !== generation) return;
                // The server asks `rotating` before `stale`: once this upload has waited, a walk
                // that reached the folder between the look and the begin answers `stale`, and it
                // is the same wait ending, looked at again within the same deadline.
                if (!isRotating(error) && !(isStale(error) && u.keyChangePauses > 0)) throw error;
                if (!(await keyChangeRefused(u, generation, error as DriveApiError, parent)))
                    return;
                continue;
            } finally {
                if (answer && beginning.get(u)?.answer === answer) beginning.delete(u);
            }
            sealed = { nodeEnvelopes, prepared, begun };
        }
        const { nodeEnvelopes, prepared, begun } = sealed;
        if (u.generation !== generation) {
            await api.abortUpload(workspaceId, begun.upload.id).catch(() => {});
            return;
        }
        keyChangeOver(u);
        u.uploadId = begun.upload.id;
        rememberUrls(u, begun.parts, begun.urlExpiresAt);
        u.entry = {
            id: u.item.id,
            workspaceId,
            uploadId: begun.upload.id,
            nodeId: u.nodeId,
            versionId: u.versionId,
            objectId: u.objectId,
            idSeeds: seeds,
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
            signAs: u.signAs,
            stash: u.stash,
            move: u.item.move ?? null,
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
                file: await bytesFor(u, file),
                index,
            });
            // Sent before under this key and nonce with other bytes (the file changed under us):
            // sending these too would hand the store two plaintexts under one nonce. Start over.
            const before = u.digests.get(part) ?? u.entry?.parts[part]?.digest;
            if (before !== undefined && before !== encrypted.digest) {
                u.inFlight.delete(part);
                if (u.generation === generation) await startOver(u);
                return;
            }
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
            if (isSourceGone(error)) {
                await sourceGone(u);
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
            void journalLanded(u, part, { etag: result.etag, bytes: result.bytes });
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
     * A family folder's key change the server says has not reached the folder or
     * the file yet (409 rotating) is waited out, and the attach starts again from
     * a fresh look, rewrapped under the keys it finds.
     */
    async function attach(u: Internal, generation: number) {
        for (;;) {
            try {
                const result = await attachOnce(u, generation);
                keyChangeOver(u);
                return result;
            } catch (error) {
                if (u.generation !== generation) throw error;
                // A late `stale` after a pause is the walk reaching the folder or the file between
                // the look and the attach, as for a begin; the worker refusing a key the change
                // has not reached yet is the same wait.
                const pending = isKeyChangePending(error);
                if (!pending && !isRotating(error) && !(isStale(error) && u.keyChangePauses > 0))
                    throw error;
                const target = u.parent ?? u.replaces;
                if (!target) throw error;
                const reason = pending ? pendingKeyChange() : (error as DriveApiError);
                if (!(await keyChangeRefused(u, generation, reason, target)))
                    throw new Error('Cancelled.');
            }
        }
    }
    async function attachOnce(u: Internal, generation: number) {
        const entry = u.entry;
        if (!u.uploadId || !entry || !options.openNodes)
            throw new Error('This file changed while it was uploading. Upload it again.');
        const workspaceId = workspaceOf(u);
        const lookup = options.openNodes;
        const looked = await lookup(entry);
        if (u.generation !== generation) throw new Error('Cancelled.');
        // Attaching writes under the folder (a sibling) or the file's own key (the same node):
        // either may be waiting for a family folder's key change, exactly as a new upload does.
        const ready = await untilWritable(u, generation, looked, () => lookup(entry));
        if (!ready) throw new Error('Cancelled.');
        const { parent, replaces } = ready;
        u.parent = parent;
        if (!u.prepared) {
            const reopened = await rpc('driveUploadReopen', reopenInput(entry));
            set(u, { chunkCount: reopened.chunkCount, total: reopened.ciphertextSize });
            u.prepared = true;
        }
        const versionUnchanged =
            replaces !== undefined &&
            entry.expectedVersionId !== undefined &&
            (replaces.currentVersion?.id ?? null) === entry.expectedVersionId;
        if (versionUnchanged) {
            const { contentKeyEnvelope, versionSignature } = await rpc('driveUploadRewrap', {
                workspaceId,
                objectId: u.objectId,
                nodeId: replaces.id,
                versionId: u.versionId,
                signAs: u.signAs.version,
            });
            try {
                return await api.attachUpload(workspaceId, u.uploadId, {
                    mode: 'same-node',
                    keyEpoch: replaces.keyEpoch,
                    contentKeyEnvelope,
                    versionSignature,
                });
            } catch (error) {
                // The version moved between the listing and the attach: keep both.
                if (!isConflicted(error)) throw error;
            }
        }
        const from = await takeEpoch(workspaceId);
        const { id: nodeId, seed: nodeIdSeed } = await newId('node', workspaceId);
        const name = conflictCopyName(u.item.name);
        const { nodes } = await rpc('driveCreateNodes', {
            workspaceId,
            nodes: [
                {
                    id: nodeId,
                    kind: 'file',
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
                    signAs: u.signAs.metadata,
                },
            ],
        });
        const { contentKeyEnvelope, versionSignature } = await rpc('driveUploadRewrap', {
            workspaceId,
            objectId: u.objectId,
            nodeId,
            versionId: u.versionId,
            signAs: u.signAs.version,
        });
        const result = await api.attachUpload(workspaceId, u.uploadId, {
            mode: 'sibling',
            node: {
                id: nodeId,
                idSeed: nodeIdSeed,
                parentId: parent.id,
                parentKeyEpoch: parent.keyEpoch,
                keyEpoch: from,
                keyEnvelope: nodes[0]!.keyEnvelope,
                metadataEnvelope: nodes[0]!.metadataEnvelope,
                metadataSignature: nodes[0]!.metadataSignature,
            },
            contentKeyEnvelope,
            versionSignature,
        });
        u.nodeId = nodeId;
        set(u, { name, parentId: parent.id });
        return result;
    }

    let scheduling = false;
    /* Set while sign-out forgets everything: nothing new starts in the meantime. */
    let stopping = false;
    /* Hands out work: start queued files while under the limit, then fill the part pool. */
    async function schedule() {
        if (scheduling || stopping) return;
        scheduling = true;
        try {
            let active = [...uploads.values()].filter(isActive).length;
            for (const id of order) {
                const u = uploads.get(id)!;
                if (u.item.status !== 'queued' || active >= maxActiveFiles || !u.file) continue;
                active++;
                const generation = u.generation;
                void prepare(u)
                    .then(() => schedule())
                    .catch((error: unknown) => {
                        // A run that was discarded or started over meanwhile answers for nothing.
                        if (u.generation !== generation || uploads.get(u.item.id) !== u) return;
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
            // After the queue took what it could: an upload leaving a key-change pause looks again.
            for (const wake of Array.from(slotWaiters)) {
                slotWaiters.delete(wake);
                wake();
            }
        }
    }

    function makeInternal(
        item: UploadItem,
        file: UploadFile | null,
        parent: DriveNode | null,
    ): Internal {
        return {
            item,
            file,
            sourceId: null,
            attaching: null,
            handle: null,
            parent,
            replaces: undefined,
            nodeId: '',
            versionId: '',
            objectId: '',
            seeds: null,
            signAs: signaturesOf(item.origin, undefined),
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
            lookAgain: false,
            keyChangePauses: 0,
            keyChangeSince: null,
            pausing: false,
        };
    }

    /*
     * Queues `inputs`. `from` is the session generation the caller took when its work began
     * (a copy reading its bytes, a move): if the person signed out since, or is signed out
     * now, nothing is queued, so nothing is journaled after sign-out deleted the journal.
     */
    function enqueue(inputs: EnqueueInput[], from?: { generation: number }) {
        const session = options.session;
        if (
            session &&
            (!session.open() || (from !== undefined && from.generation !== session.generation()))
        )
            throw new SignedOutError();
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
                    total: plannedSize(size, 0),
                    bytesPerSecond: 0,
                    chunkCount: plannedChunks(size, 0),
                    partsDone: 0,
                    startedAt: null,
                    finishedAt: null,
                    node: null,
                    needsFile: false,
                    hasHandle: Boolean(input.handle) || Boolean(input.stash),
                    origin: input.origin ?? 'file',
                    move: input.move ?? null,
                },
                input.file,
                input.parent,
            );
            u.replaces = input.replaces;
            u.handle = input.handle ?? null;
            u.stash = input.stash ?? null;
            u.signAs = signaturesOf(u.item.origin, input.signAs);
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
                signAs: u.signAs,
                stash: u.stash,
                move: u.item.move ?? null,
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
        const reopened = await rpc('driveUploadReopen', reopenInput(entry));
        set(u, { chunkCount: reopened.chunkCount, total: reopened.ciphertextSize });
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
        // Fresh ids, minted again in the folder's workspace at the next prepare.
        u.seeds = null;
        u.versionId = '';
        u.objectId = '';
        if (!u.replaces) u.nodeId = '';
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
                if (typeof file !== 'string') await attachFile(id, file);
                else if (file === 'lost') await lost(u);
                else if (file === 'locked') {
                    // Paused already, so locked() leaves it: it says why itself.
                    locked();
                    set(u, { error: 'Unlock this device to continue.' });
                } else set(u, { error: 'This copy couldn’t be read just now. Try again.' });
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
     * journaled: same size and modification time, and every chunk that may
     * already have left the machine must hash to what the journal recorded. That
     * is every part with a digest, acknowledged or not: a digest is journaled
     * before the send, and a part the store took without the answer reaching us
     * is as much on the server as one it acknowledged. Anything else starts over,
     * because encrypting different bytes under the same key and nonce as a part
     * the server holds is the one thing the cipher forbids.
     */
    async function attachFile(id: string, file: UploadFile) {
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
                    if (!journaled.digest) continue;
                    const { digest } = await rpc('driveUploadDigest', {
                        objectId: u.objectId,
                        file: await bytesFor(u, file),
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
            if (isSourceGone(error)) {
                await sourceGone(u);
                return { ok: false as const, reason: 'failed' as const };
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
    async function attachQueued(u: Internal, file: UploadFile) {
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
        if (!u.file) {
            // A lost copy has nothing to retry with; the list keeps its row until removed.
            if (u.item.needsFile || u.item.origin !== 'copy') return;
            // A copy whose bytes a lock took while it sat failed: back from its sealed stash, or
            // reported lost when there is none, the way resume brings a paused one back.
            u.attempts.clear();
            set(u, { status: 'paused', error: null });
            await resume(id);
            return;
        }
        u.attempts.clear();
        // What failed may have met a key change: the folder and the file are looked up again and
        // everything sealed afresh under the keys found, never sent again under the old ones, and
        // a wait for a key change starts its clock again.
        u.lookAgain = true;
        u.keyChangePauses = 0;
        u.keyChangeSince = null;
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
        // A part still on its way finishes quietly instead of acting on a row that is gone.
        u.generation++;
        uploads.delete(id);
        order.splice(order.indexOf(id), 1);
        // A failed copy's bytes may still sit in the worker: they go with the row.
        void releaseSource(u);
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
                    total: entry.ciphertextSize ?? plannedSize(entry.file.size, 0),
                    bytesPerSecond: 0,
                    chunkCount: plannedChunks(entry.file.size, thumbnailBytesOf(entry.thumbnail)),
                    partsDone: done.length,
                    startedAt: entry.createdAt,
                    finishedAt: null,
                    node: null,
                    needsFile: true,
                    hasHandle: entry.handle !== null || stash !== null,
                    origin: entry.origin ?? 'file',
                    move: entry.move ?? null,
                },
                null,
                null,
            );
            u.handle = entry.handle;
            u.stash = stash;
            u.signAs = signaturesOf(u.item.origin, entry.signAs);
            u.nodeId = entry.nodeId;
            u.versionId = entry.versionId;
            u.objectId = entry.objectId;
            // Kept so a begin sent again for these ids carries the seeds that made them.
            u.seeds = entry.idSeeds ?? null;
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
                    total: plannedSize(queued.file.size, 0),
                    bytesPerSecond: 0,
                    chunkCount: plannedChunks(queued.file.size, 0),
                    partsDone: 0,
                    startedAt: null,
                    finishedAt: null,
                    node: null,
                    needsFile: true,
                    hasHandle: queued.handle !== null || queued.stash !== null,
                    origin: queued.origin,
                    move: queued.move ?? null,
                },
                null,
                null,
            );
            u.handle = queued.handle;
            u.stash = queued.stash;
            u.signAs = signaturesOf(u.item.origin, queued.signAs);
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

    /*
     * Sign-out: every upload stopped and forgotten, and nothing of them left in
     * this browser, neither the journal's names and chunk digests nor the
     * stash's decrypted bytes.
     */
    async function forgetAll() {
        stopping = true;
        try {
            // Every upload at once, and not forever: an offline sign-out must still finish.
            await Promise.race([
                Promise.allSettled(order.slice().map((id) => cancel(id))),
                new Promise((resolve) => setTimeout(resolve, FORGET_TIMEOUT_MS)),
            ]);
            for (const u of uploads.values()) u.generation++;
            uploads.clear();
            order.length = 0;
            emit();
            await journal?.clear().catch(() => {});
            await options.stash?.sweep?.(new Set()).catch(() => {});
        } finally {
            stopping = false;
        }
    }

    /*
     * Another tab signed out: every upload here is dropped without touching the journal (that
     * tab deletes it). Each upload's generation moves on, and every step that writes the
     * journal checks its own first, so an answer that lands later (a begin, a part, a
     * completion) writes nothing back: a begun upload is aborted instead.
     */
    function invalidate() {
        for (const u of uploads.values()) {
            u.generation++;
            clearBackoff(u);
            u.inFlight.clear();
        }
        uploads.clear();
        order.length = 0;
        emit();
    }

    /*
     * Another tab is signing out and waits on this one: every upload here stops at once, as
     * invalidate does, and then what each had reserved is released while the session still
     * answers. The server's reservations (which would otherwise hold quota until they expire)
     * are aborted at once, those of begins still on their way as soon as they answer, apart
     * from the worker's state for each, which is dropped beside them: a worker that hangs
     * never holds up the network. Never longer than FORGET_TIMEOUT_MS, and nothing is written
     * to the journal, which that tab deletes.
     */
    async function releaseAll() {
        const held = [...uploads.values()];
        const begins = [...beginning.values()];
        invalidate();
        const abort = (workspaceId: string, uploadId: string) =>
            api.abortUpload(workspaceId, uploadId).catch(() => {});
        await Promise.race([
            Promise.allSettled([
                ...held.flatMap((u) => (u.uploadId ? [abort(workspaceOf(u), u.uploadId)] : [])),
                ...begins.map(({ workspaceId, answer }) =>
                    answer.then((uploadId) =>
                        uploadId ? abort(workspaceId, uploadId) : undefined,
                    ),
                ),
                ...held.map(async (u) => {
                    await rpc('driveUploadCancel', { objectId: u.objectId }).catch(() => {});
                    await rpc('driveUploadForget', { objectId: u.objectId }).catch(() => {});
                }),
            ]),
            new Promise((resolve) => setTimeout(resolve, FORGET_TIMEOUT_MS)),
        ]);
    }

    return {
        enqueue,
        forgetAll,
        invalidate,
        releaseAll,
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
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let value = bytesPerSecond;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${unit === 0 ? Math.round(value) : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
