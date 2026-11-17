import {
    CHUNK_TAG_BYTES,
    THUMBNAIL_MAX_BYTES,
    chunkCount,
    paddedLength,
} from '@hushos/crypto/drive';
import type { SignatureForm } from '@hushos/crypto/signatures';
import { DriveApiError, type NodeView, type TrashBatchItem } from './api';
import type { DriveNode } from './client';
import type { RunJournal, RunRow, UploadSignatures } from './journal';
import type { MemoryFile, TransferManager, TransferManagerOptions, UploadItem } from './transfers';
import { sourcesSignatureForms, type ResultSource } from './trust';

/*
 * The save path (docs/file-tools-design.md, section 2, "The save path: two
 * modes, one queue"): how File tools and editing write what they produce.
 * Two modes over the one upload queue: a new version of the same file, which
 * a version race ends `stale` (never a conflict copy), and a new file under
 * the next free name in its folder, which never replaces anything.
 *
 * A run groups one tool's or one save's results. Before anything is made it
 * asks the destination once whether it may be written (a family folder that
 * is read-only or whose keys changed refuses; one waiting for a key change
 * queues) and whether the results fit (their padded ciphertext against the
 * workspace's free space, where that is the person's to know). Results upload
 * from memory and are never journaled, so they never resume; the run keeps
 * one row of ids (RunRow) so that a cancel, a refusal, a 402, a failure, a
 * lock or a closed tab leaves no new file behind: open uploads aborted, what
 * was published deleted forever, or moved to the Trash where the person may
 * not delete forever. A new version that already landed is kept (never rolled
 * back), and the run says so rather than "nothing was saved".
 *
 * Each result is signed by its own sources (sourcesSignatureForms: the weakest
 * of them), or as the person's own writing when the caller says so with
 * OWN_WRITING. A tool never picks a signature.
 */

/*
 * One result's room, an upper bound on what begin reserves for it: the Padmé
 * bucket of its bytes, with a full 64 KiB thumbnail trailer and its tag when
 * it may carry a thumbnail, plus a 16-byte tag per chunk of that bucket. Never
 * less than ciphertextSize (@hushos/crypto/drive) for any thumbnail up to the
 * allowance (none, without one), at most a chunk tag more than the largest.
 */
export function resultEstimate(plaintextSize: number, thumbnail = true) {
    const trailer = thumbnail ? THUMBNAIL_MAX_BYTES + CHUNK_TAG_BYTES : 0;
    const padded = paddedLength(plaintextSize + trailer);
    return padded + CHUNK_TAG_BYTES * chunkCount(padded);
}

/*
 * A result's bytes when they are known before producing it, or the sources'
 * it is made from (conversion, compress). `thumbnail` false: it carries none
 * (a zip, a text file), so no thumbnail allowance is set aside for it.
 */
export type PlannedResult = ({ size: number } | { sourcesSize: number }) & { thumbnail?: boolean };

/* A result whose size is not known until made is taken as its sources' total plus 1%, rounded up. */
export function unknownResultSize(sourcesSize: number) {
    return sourcesSize + Math.ceil(sourcesSize / 100);
}

/* What a run's results may take: each result's estimate, added up. */
export function runEstimate(results: readonly PlannedResult[]) {
    let total = 0;
    for (const result of results)
        total += resultEstimate(
            'size' in result ? result.size : unknownResultSize(result.sourcesSize),
            result.thumbnail !== false,
        );
    return total;
}

/* What a result is signed with when it is the person's own writing, not made from anything they hold. */
export const OWN_WRITING = 'own-writing' as const;
export type ResultSources = typeof OWN_WRITING | readonly ResultSource[];

/* The statements a result is signed with: its sources' weakest, or ordinary for the person's own writing. */
export function resultSignatures(sources: ResultSources): UploadSignatures {
    if (sources === OWN_WRITING) return { metadata: 'ordinary', version: 'ordinary' };
    return sourcesSignatureForms(sources);
}

/* Why a run did not start: nothing was made. */
export class SaveRefused extends Error {
    constructor(
        readonly reason: 'read-only' | 'no-room',
        message: string,
        /* For a workspace that is the person's own (or their family's): what the run needs and what is free. */
        readonly room: { needed: number; free: number } | null = null,
    ) {
        super(message);
        this.name = 'SaveRefused';
    }
}

/*
 * What a clean-up did with what the run made: deleted forever, moved to the
 * Trash (an editor in someone else's folder may not delete forever), nothing
 * was published to remove, or `no-access`: the folder is no longer this
 * person's to clean up (the share ended, the family was left), so there is
 * nothing more they can do and the row goes. `left` when the clean-up could
 * not finish (no network, an item refused): the run's row stays for the next
 * open.
 */
export type Cleanup = 'deleted' | 'trashed' | 'nothing' | 'left' | 'no-access';

export type StopReason = 'cancelled' | 'no-room' | 'failed' | 'locked' | 'signed-out';

/*
 * Why a run stopped after it started, what its clean-up did, how many new
 * versions had already landed and were kept (a run never rolls a version back),
 * and how many may have: their abort had no answer (offline, or the server
 * still finishing them), so they may land yet.
 */
export class RunStopped extends Error {
    constructor(
        readonly reason: StopReason,
        message: string,
        readonly cleanup: Cleanup,
        readonly keptVersions = 0,
        readonly uncertainVersions = 0,
    ) {
        super(message);
        this.name = 'RunStopped';
    }
}

export const NO_ROOM = 'There isn’t enough room for this. Nothing was saved.';
export const NO_ROOM_SHARED =
    'There isn’t enough room in this shared folder for this. Nothing was saved.';
export const RUN_CANCELLED = 'Cancelled. Nothing was saved.';
export const RUN_FAILED = 'This couldn’t be saved, so nothing was kept.';
/* What a run says when this device would not keep its record (the browser's storage full): it stops. */
export const UNRECORDED = 'This device couldn’t keep a record of this save.';
/* A cancel after the run finished: what it made was saved, and stays. */
export const ALREADY_SAVED = 'This was already saved, so it was kept.';

/*
 * A finished run (or kept results) whose record this device would not update:
 * it is not retired, and asking again may (finish or Keep once more).
 */
export class RecordNotUpdated extends Error {
    constructor() {
        super('This was saved, but this device couldn’t update its record of it. Try again.');
        this.name = 'RecordNotUpdated';
    }
}

const OPENINGS: Record<Exclude<StopReason, 'failed'>, string> = {
    cancelled: 'Cancelled.',
    'no-room': 'There isn’t enough room for this.',
    locked: 'This device locked before this was saved.',
    'signed-out': 'You signed out before this was saved.',
};

/*
 * What a stopped run says, from what its clean-up found: never "nothing was
 * saved" once a new version landed, while one may still land, or while new
 * files or folders it made may still be there (`remains`: `left` when the
 * row stays for the next open, `no-access` when the space is no longer the
 * person's to clean up).
 */
export function stoppedWords(
    reason: StopReason,
    options: {
        shared?: boolean;
        failure?: string | null;
        keptVersions?: number;
        uncertainVersions?: number;
        remains?: 'left' | 'no-access' | 'stays' | null;
    } = {},
) {
    const kept = options.keptVersions ?? 0;
    const uncertain = options.uncertainVersions ?? 0;
    const remains =
        options.remains === 'left'
            ? ' Some of what was made may still be there. You’ll be asked about it next time.'
            : options.remains === 'no-access'
              ? ' Some of what was made may still be there, and you can no longer remove it.'
              : options.remains === 'stays'
                ? ' Some of what was made may still be there.'
                : '';
    const opening =
        reason === 'failed'
            ? sentence(options.failure ?? 'This couldn’t be saved.')
            : reason === 'no-room' && options.shared
              ? 'There isn’t enough room in this shared folder for this.'
              : OPENINGS[reason];
    if (!kept && !uncertain && !remains)
        return reason === 'failed' && !options.failure
            ? RUN_FAILED
            : `${opening} Nothing was saved.`;
    const versions = !kept
        ? ''
        : kept === 1
          ? ' The new version saved before that was kept.'
          : ` The ${kept} new versions saved before that were kept.`;
    const maybe = !uncertain
        ? ''
        : uncertain === 1
          ? ` ${kept ? 'Another' : 'A'} new version may have been saved.`
          : ` ${uncertain} ${kept ? 'other ' : ''}new versions may have been saved.`;
    return `${opening}${versions}${maybe}${remains || ' Nothing else was saved.'}`;
}

/* A reason as a sentence: trimmed, and ended with a full stop when it has none. */
function sentence(text: string) {
    const trimmed = text.trim();
    return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

type TransferEvent = Parameters<NonNullable<TransferManagerOptions['onEvent']>>[0];

/*
 * Whose space a destination is: the person's own Drive or their family's, with
 * its free bytes as the server checks them (null when not known now), or
 * someone else's share, whose owner's free space is never revealed: there the
 * server's 402 is the only check, and the run ends "no room" and cleans up.
 */
export type Room = { kind: 'own' | 'family'; free: number | null } | { kind: 'shared' };

/*
 * Whose space a workspace is, and its free bytes as the server checks an
 * upload begin there (packages/db/src/pool.ts). On the account's own
 * allowance, `availableBytes`. In a family's pool, the person's own files
 * take `own.freeBytes`, which the server computes as it checks a begin (the
 * shown figures count their own part in whole GiB; an older server without
 * it leaves the shown figure, which never says more is free than there is).
 * A family folder of that pool: `availableBytes`, whole GiB on both sides.
 * Someone else's share: never known.
 */
export function roomOf(
    storage: {
        workspaceId: string;
        availableBytes: string;
        pool: { groupId: string } | null;
        own?: { freeBytes?: string } | null;
    } | null,
    workspaceId: string,
    family: string | null,
): Room {
    const own = storage !== null && workspaceId === storage.workspaceId;
    if (!own && family === null) return { kind: 'shared' };
    if (!storage) return { kind: own ? 'own' : 'family', free: null };
    const available = Number(storage.availableBytes);
    if (own)
        return {
            kind: 'own',
            free:
                storage.pool && storage.own?.freeBytes ? Number(storage.own.freeBytes) : available,
        };
    // A family folder of a family whose pool these figures are not: not known here.
    return { kind: 'family', free: storage.pool?.groupId === family ? available : null };
}

/* The server's answer to aborting an upload; `unknown` when there was none (offline, a 5xx). */
export type AbortFate = 'aborted' | 'gone' | 'finished' | 'denied' | 'unknown';
/*
 * The server's answer for one item of a batch: `done` (in the Trash, or deleted
 * forever), `gone` (not found: nothing to remove), `refused` (anything else, a
 * purge left `busy` after its retries included), `denied` (the whole request
 * refused because the workspace is no longer this person's: 403 or 404).
 */
export type ItemFate = 'done' | 'gone' | 'refused' | 'denied';

/*
 * What an abort's answer means for a clean-up (the server's abortUpload names a
 * finishing upload and a finished one in `data.upload`): an upload still
 * finishing is asked about again, every `pauseMs` up to `tries` times (about
 * ten seconds). One still finishing then is `unknown`, never finished: the
 * server publishes its node only once the object store has completed it, so
 * it may still land, and the row that names it stays for the next open.
 */
export async function askAbort(
    abort: () => Promise<unknown>,
    options: { tries?: number; pauseMs?: number; pause?: (ms: number) => Promise<void> } = {},
): Promise<AbortFate> {
    const tries = options.tries ?? 5;
    const pause =
        options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let asked = 1; ; asked++) {
        try {
            await abort();
            return 'aborted';
        } catch (error) {
            const fate = abortFateOf(error);
            if (fate !== 'finishing') return fate;
            if (asked >= tries) return 'unknown';
            await pause(options.pauseMs ?? 2_000);
        }
    }
}

/* One abort refusal as a fate; `finishing` while the server is still completing it. */
export function abortFateOf(error: unknown): AbortFate | 'finishing' {
    if (!(error instanceof DriveApiError)) return 'unknown';
    if (error.status === 404) return 'gone';
    if (error.status === 401 || error.status === 403) return 'denied';
    if (error.status === 409) {
        const upload = (error.data as { upload?: string } | undefined)?.upload;
        if (upload === 'completing') return 'finishing';
        if (upload === 'completed') return 'finished';
    }
    return 'unknown';
}

/* The whole request refused because the workspace is no longer this person's to write. */
export function deniedWhole(error: unknown) {
    return error instanceof DriveApiError && (error.status === 403 || error.status === 404);
}

/*
 * A trash batch's answers as fates: in the Trash (moved, with a folder that
 * went, or already there), gone (not found), anything else refused.
 */
export function trashFatesOf(results: readonly TrashBatchItem[]) {
    const fates = new Map<string, ItemFate>();
    for (const item of results)
        fates.set(
            item.id,
            item.status === 'trashed' || item.status === 'covered'
                ? 'done'
                : item.reason === 'trashed'
                  ? 'done'
                  : item.reason === 'not-found'
                    ? 'gone'
                    : 'refused',
        );
    return fates;
}

export type SaveRunDeps = {
    transfers: Pick<TransferManager, 'enqueue' | 'cancel'>;
    /* Every upload event (the app's fan-out of the transfer manager's onEvent). */
    events: (listener: (event: TransferEvent) => void) => () => void;
    runs: RunJournal;
    refuseWrite: (target: DriveNode) => string | null;
    waitsForKeyChange: (target: DriveNode) => boolean;
    room: (workspaceId: string) => Promise<Room>;
    /* The names in a folder now. */
    namesIn: (folder: DriveNode) => Promise<Iterable<string>>;
    /* The next free name among `taken` ("name (2).ext"), matching whatever the case. */
    nextName: (name: string, taken: Set<string>) => string;
    /* A new folder, signed as `signAs`; waits out a family folder's key change, refuses otherwise. */
    /*
     * `minted` hears the folder's id before its creation is sent (the run records it first);
     * a throw from it sends nothing.
     */
    makeFolder: (
        parent: DriveNode,
        name: string,
        signAs: SignatureForm,
        minted: (id: string) => Promise<void>,
    ) => Promise<DriveNode>;
    /* Never throws: what the server said, or `unknown`. */
    abortUpload: (workspaceId: string, uploadId: string) => Promise<AbortFate>;
    /*
     * To the Trash, then (where `mayPurge`) deleted forever: each item's fate.
     * Throws only when the request as a whole got no answer.
     */
    trash: (workspaceId: string, nodeIds: string[]) => Promise<Map<string, ItemFate>>;
    purge: (workspaceId: string, nodeIds: string[]) => Promise<Map<string, ItemFate>>;
    /*
     * Whether the person may delete forever in a workspace: the server lets
     * only a member (their own, their family's folders), never an editor
     * through a share, whose results go to the owner's Trash instead.
     */
    mayPurge: (workspaceId: string) => Promise<boolean>;
    /*
     * Marks a run live for as long as it runs (Web Locks on the web), so no tab
     * takes it for interrupted; taken before its row is written. Without it,
     * the row's heartbeat says whether it runs.
     */
    hold?: (runId: string) => Promise<() => void> | (() => void);
    isLive?: (runId: string) => Promise<boolean>;
    /* The session generation the caller's work began in (the transfer manager's enqueue `from`). */
    from?: { generation: number };
    /* Whether the run's session is still this browser's: after a sign-out nothing is written. */
    current?: () => boolean;
    newId?: () => string;
    now?: () => number;
    /* How often a live run's row says it is alive (BEAT_MS). */
    beatMs?: number;
};

/* A live run's heartbeat, and how old one may be before another tab takes the run for interrupted. */
export const BEAT_MS = 30_000;
export const STALE_BEAT_MS = 4 * BEAT_MS;

export type RunPlan = {
    /* Where the run writes: folders new files go into, files new versions go onto; one workspace. */
    targets: DriveNode[];
    results: PlannedResult[];
};

export type ProducedFile = {
    name: string;
    bytes: Uint8Array | Uint8Array[];
    mime: string | null;
    /* What it was made from (its signature is theirs, the weakest), or OWN_WRITING. */
    sources: ResultSources;
    thumbnail?: Uint8Array | null;
    modified?: number;
    /* The folder it goes into: the run's first target unless the run made one for it. */
    into?: DriveNode;
};

export type ProducedVersion = {
    file: DriveNode;
    /* The folder the file is in, as listed: the queue looks the file up there again before sealing. */
    folder: DriveNode;
    /* The version the work started from: a different one current at saving is `stale`. */
    startedFrom: string | null;
    bytes: Uint8Array | Uint8Array[];
    /* What it was made from (its signature is theirs, the weakest), or OWN_WRITING. */
    sources: ResultSources;
    mime?: string | null;
    thumbnail?: Uint8Array | null;
    modified?: number;
};

export type VersionSaved =
    | { status: 'saved'; node: NodeView | null }
    /* Nothing was published: someone else's version is current (Save on top, Save as a copy, Open theirs). */
    | { status: 'stale'; currentVersionId: string | null };

export type SaveRun = {
    readonly id: string;
    /* A new folder for results under the next free name in `into` (the run's first target by default). */
    folder(name: string, options: { into?: DriveNode; sources: ResultSources }): Promise<DriveNode>;
    /* A new file under the next free name in its folder; never replaces anything. */
    file(result: ProducedFile): Promise<NodeView | null>;
    /* A new version of `file`, unless someone else saved since the work started (`stale`). */
    version(result: ProducedVersion): Promise<VersionSaved>;
    /* Every result is in: the run's row goes. Throws while any is still on its way, or once stopped. */
    finish(): Promise<void>;
    /* Stops the run and removes the new files and folders it made; how it stopped. */
    cancel(): Promise<RunStopped>;
    /* Results queued and not yet in. */
    waiting(): number;
};

type LiveRun = SaveRun & { abandon(): void };

/* Runs live in this page: a result still waiting to upload asks before the page unloads. */
const liveRuns = new Set<LiveRun>();
export function resultsWaiting() {
    for (const run of liveRuns) if (run.waiting() > 0) return true;
    return false;
}

/*
 * A sign-out (here or in another tab): every run in this page stops at once.
 * Its pending results are rejected and their bytes let go; nothing is written
 * to the journal (the sign-out deletes it) and nothing is asked of the server
 * (the uploads were already dropped and released by the queue).
 */
export function abandonRuns() {
    // A Set may lose the entry being visited: each run removes itself as it ends.
    for (const run of liveRuns) run.abandon();
}

/*
 * Buffers already handed to a run: a result's bytes move to the crypto worker
 * whole (transferred, never copied), so a part that is a view into a larger
 * buffer, or into one another result already took, is copied first. Two
 * results cut from one buffer would otherwise leave the second with nothing.
 */
const handedBuffers = new WeakSet<ArrayBufferLike>();
function ownedParts(bytes: Uint8Array | Uint8Array[]) {
    const parts = Array.isArray(bytes) ? bytes : [bytes];
    return parts.map((part) => {
        const whole =
            part.buffer instanceof ArrayBuffer &&
            part.byteOffset === 0 &&
            part.byteLength === part.buffer.byteLength &&
            !handedBuffers.has(part.buffer);
        const owned = whole ? part : part.slice();
        handedBuffers.add(owned.buffer);
        return owned;
    });
}

/*
 * Starts a run: the write gate and the room check, both before anything is
 * made, then the run's row (after its hold, so no other tab ever sees the
 * row without it). Throws SaveRefused when it may not start.
 */
export async function startRun(deps: SaveRunDeps, plan: RunPlan): Promise<SaveRun> {
    const [first] = plan.targets;
    if (!first) throw new Error('A save run needs somewhere to save.');
    const workspaceId = first.workspaceId;
    if (plan.targets.some((target) => target.workspaceId !== workspaceId))
        throw new Error('A save run writes into one workspace.');
    // Once for the run, not per result: a read-only family folder or one whose keys changed
    // refuses; one a key change has not reached yet takes the run, whose uploads wait in the queue.
    for (const target of plan.targets) {
        const refused = deps.refuseWrite(target);
        if (refused && !deps.waitsForKeyChange(target)) throw new SaveRefused('read-only', refused);
    }
    // A sign-out while it starts (abandonRuns cannot reach a run not yet live): it never
    // starts, writes nothing into the journal the sign-out cleared, and lets its hold go.
    const current = () => deps.current?.() ?? true;
    const signedOut = () => new RunStopped('signed-out', stoppedWords('signed-out'), 'nothing');
    if (!current()) throw signedOut();
    const needed = runEstimate(plan.results);
    const room = await deps.room(workspaceId);
    if (!current()) throw signedOut();
    if (room.kind !== 'shared' && room.free !== null && needed > room.free)
        throw new SaveRefused('no-room', NO_ROOM, { needed, free: Math.max(0, room.free) });
    const now = deps.now ?? (() => Date.now());
    const id = deps.newId?.() ?? crypto.randomUUID();
    // Held before the row exists: no other tab ever finds the row without its hold.
    const release = await deps.hold?.(id);
    try {
        if (!current()) throw signedOut();
        const row: RunRow = { id, workspaceId, nodeIds: [], uploadIds: [], at: now(), beat: now() };
        await deps.runs.put(row);
        // Signed out while the row was written: it goes too (only this row, wherever it landed).
        if (!current()) {
            await deps.runs.remove(row.id).catch(() => {});
            throw signedOut();
        }
        return createRun(deps, row, plan, room.kind === 'shared', release);
    } catch (error) {
        release?.();
        throw error;
    }
}

type Pending = {
    kind: 'file' | 'version';
    /* The node begin made for a new file, while the run keeps it in its row (not inside a run's folder). */
    tracked: boolean;
    uploadId: string | null;
    nodeId: string | null;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
};

function createRun(
    deps: SaveRunDeps,
    row: RunRow,
    plan: RunPlan,
    shared: boolean,
    release: (() => void) | undefined,
): LiveRun {
    const now = deps.now ?? (() => Date.now());
    const pending = new Map<string, Pending>();
    /* Uploads of new versions: one the server finished is a version kept, not a file to delete. */
    const versionUploads = new Set<string>();
    /* Uploads whose completion was sent: only these can land after a stop that got no answer. */
    const completing = new Set<string>();
    /*
     * Nodes whose publication was sent (a folder's creation, a file's completion or attach) or
     * that landed: only these may still be there after a clean-up that couldn't remove them.
     */
    const mayBePublished = new Set<string>();
    /*
     * After a stop: folders made too late to go with it that then couldn't be removed, in one
     * row (the stop's, when it kept one), each write after the last.
     */
    let late: RunRow | null = null;
    let lateWriting = Promise.resolve();
    /* Folders this run made: what is inside one goes with it and needs no row of its own. */
    const madeFolders = new Set<string>();
    /*
     * Names given out per folder, so two results never take the same one: one listing per
     * folder, shared by every result asking for it at once.
     */
    const claimed = new Map<string, Promise<Set<string>>>();
    /* Results planned with a thumbnail: no more may carry one than were set room aside for. */
    let thumbnails = plan.results.filter((result) => result.thumbnail !== false).length;
    let keptVersions = 0;
    let stopped: RunStopped | null = null;
    let stopping: Promise<RunStopped> | null = null;
    let finished = false;
    let abandoned = false;
    /* Set by the clean-up just before it removes the row: no write may land after that. */
    let sealed = false;
    /* Writes the journal only while this run's session is the browser's. */
    const current = () => !abandoned && (deps.current?.() ?? true);
    // Rows written one after another, each the run as it is then.
    let writing = Promise.resolve();
    /*
     * A write the journal refused twice (storage full): the run can no longer promise the next
     * open a row naming what it made, so it stops and cleans up, and nothing more is published.
     */
    let unrecorded: unknown = null;
    const snapshot = () => ({
        ...row,
        nodeIds: [...row.nodeIds],
        uploadIds: [...row.uploadIds],
        beat: now(),
    });
    const writable = () => current() && !sealed;
    const persist = () => {
        if (!writable()) return writing;
        const taken = snapshot();
        writing = writing
            .then(async () => {
                if (!writable()) return;
                try {
                    await deps.runs.put(taken);
                } catch {
                    // Once more, as the run is now (rows are whole), on a fresh connection: WebKit
                    // closes IndexedDB connections on its own, which one refused write is not.
                    if (writable()) await deps.runs.put(snapshot());
                }
            })
            .catch((error: unknown) => {
                unrecorded ??= error;
                void stop('failed', undefined, UNRECORDED);
            });
        return writing;
    };
    /* Every row written so far is on disk; throws when one was refused. */
    const recorded = async () => {
        await writing;
        if (unrecorded) throw unrecorded;
    };
    const beat = setInterval(() => void persist(), deps.beatMs ?? BEAT_MS);
    const unsubscribe = deps.events(onEvent);

    /*
     * New work only while the run is open: one handed in during a stop is refused with it, and
     * one handed in after its session ended abandons it (a sign-out that did not reach it).
     */
    async function open() {
        if (!current() && !stopping) run.abandon();
        if (stopping) throw await stopping;
        if (finished) throw new Error('This save run has finished.');
    }

    function namesTaken(folder: DriveNode) {
        let taken = claimed.get(folder.id);
        if (!taken) {
            taken = madeFolders.has(folder.id)
                ? Promise.resolve(new Set<string>())
                : deps.namesIn(folder).then((names) => new Set(names));
            // A listing that failed is asked again by the next result.
            taken.catch(() => claimed.delete(folder.id));
            claimed.set(folder.id, taken);
        }
        return taken;
    }
    function claim(taken: Set<string>, name: string) {
        const given = deps.nextName(name, taken);
        taken.add(given);
        return given;
    }

    function onEvent(event: TransferEvent) {
        const output = pending.get(event.item.id);
        if (!output) return;
        switch (event.type) {
            case 'done':
                return settled(event.item, output);
            case 'failed':
                // Only a race the engine confirmed (`stale` naming the version current now): a
                // `stale` that is only a key having moved is a failure, not someone else's save.
                if (
                    output.kind === 'version' &&
                    event.item.errorCode === 'stale' &&
                    event.item.stale
                ) {
                    pending.delete(event.item.id);
                    forgetUpload(output);
                    output.resolve({
                        status: 'stale',
                        currentVersionId: event.item.stale?.currentVersionId ?? null,
                    } satisfies VersionSaved);
                    return;
                }
                return void stop(
                    event.item.errorCode === 'over-quota' ? 'no-room' : 'failed',
                    event.item,
                );
            case 'lost':
                return void stop('failed', event.item);
            case 'locked':
                // The worker is gone and its keys with it: the run stops and cleans up rather than
                // hold the result's plaintext in this page until someone unlocks.
                return void stop('locked');
            case 'cancelled':
                // Cancelled from the transfers panel: a run is all or nothing.
                if (!stopping) void stop('cancelled');
                return;
        }
    }
    function forgetUpload(output: Pending) {
        if (!output.uploadId) return;
        row.uploadIds = row.uploadIds.filter((id) => id !== output.uploadId);
        void persist();
    }
    function settled(item: UploadItem, output: Pending) {
        pending.delete(item.id);
        row.uploadIds = row.uploadIds.filter((id) => id !== output.uploadId);
        if (output.kind === 'version') keptVersions += 1;
        // A new file a key change moved under is attached as a node of its own: that one is kept.
        const landed = item.node?.id ?? null;
        if (landed) mayBePublished.add(landed);
        if (output.tracked && landed && landed !== output.nodeId) {
            row.nodeIds = row.nodeIds.filter((id) => id !== output.nodeId);
            if (!row.nodeIds.includes(landed)) row.nodeIds.push(landed);
        }
        void persist();
        output.resolve(
            output.kind === 'version'
                ? ({ status: 'saved', node: item.node } satisfies VersionSaved)
                : item.node,
        );
    }

    function enqueue(
        kind: Pending['kind'],
        file: MemoryFile,
        parent: DriveNode,
        sources: ResultSources,
        extra: { replaces?: DriveNode; startedFrom?: string | null },
    ) {
        const output: Pending = {
            kind,
            tracked: kind === 'file' && !madeFolders.has(parent.id),
            uploadId: null,
            nodeId: null,
            resolve: () => {},
            reject: () => {},
        };
        const settledPromise = new Promise<unknown>((resolve, reject) => {
            output.resolve = resolve;
            output.reject = reject;
        });
        const [id] = deps.transfers.enqueue(
            [
                {
                    file,
                    parent,
                    name: file.name,
                    replaces: extra.replaces,
                    origin: 'result',
                    signAs: resultSignatures(sources),
                    produced: {
                        ...(extra.replaces ? { startedFrom: extra.startedFrom ?? null } : {}),
                        onBegun: ({ uploadId, nodeId }) => {
                            if (stopped || !current()) return;
                            // A restart begins again with fresh ids: the last begin is the one held.
                            if (output.uploadId)
                                row.uploadIds = row.uploadIds.filter(
                                    (held) => held !== output.uploadId,
                                );
                            if (output.tracked && output.nodeId)
                                row.nodeIds = row.nodeIds.filter((held) => held !== output.nodeId);
                            output.uploadId = uploadId;
                            if (kind === 'version') versionUploads.add(uploadId);
                            row.uploadIds.push(uploadId);
                            if (output.tracked) {
                                output.nodeId = nodeId;
                                row.nodeIds.push(nodeId);
                            }
                            void persist();
                        },
                        onAttach: async ({ nodeId }) => {
                            // Stopping: the attach is not sent, so no node lands after the clean-up.
                            if (stopping || !current())
                                throw new Error('This save run is stopping.');
                            if (!output.tracked) return;
                            // Both kept until it lands: the begun node never published, the new one may.
                            if (!row.nodeIds.includes(nodeId)) row.nodeIds.push(nodeId);
                            output.nodeId = nodeId;
                            void persist();
                            // On disk before the attach is sent, or not sent at all.
                            await recorded();
                            if (stopping) throw new Error('This save run is stopping.');
                            mayBePublished.add(nodeId);
                        },
                        // On disk before the completion is sent: nothing is published that the row
                        // the next open cleans up from does not name.
                        beforeComplete: async () => {
                            await recorded();
                            if (stopping) throw new Error('This save run is stopping.');
                            if (output.uploadId) completing.add(output.uploadId);
                            if (output.nodeId) mayBePublished.add(output.nodeId);
                        },
                    },
                },
            ],
            deps.from,
        );
        pending.set(id!, output);
        return settledPromise;
    }

    function takeThumbnail(thumbnail: Uint8Array | null | undefined) {
        if (!thumbnail?.byteLength) return null;
        if (thumbnails <= 0)
            throw new Error('This result was planned without a thumbnail, so none was set aside.');
        thumbnails -= 1;
        return thumbnail;
    }

    function memoryFile(
        name: string,
        bytes: Uint8Array | Uint8Array[],
        mime: string | null | undefined,
        thumbnail: Uint8Array | null,
        modified: number | undefined,
    ): MemoryFile {
        const parts = ownedParts(bytes);
        return {
            kind: 'memory',
            name,
            size: parts.reduce((total, part) => total + part.byteLength, 0),
            type: mime ?? '',
            lastModified: modified ?? now(),
            parts,
            thumbnail,
        };
    }

    function stop(reason: StopReason, item?: UploadItem, failure?: string): Promise<RunStopped> {
        if (stopping) return stopping;
        // Set before any of it runs: a result handed in from here on is refused (open), and the
        // cancels the clean-up sends are heard here without stopping it twice.
        stopping = (async () => {
            await Promise.resolve();
            const open = [...pending.keys()];
            const result = await cleanUp(deps, row, open, {
                seal: () => {
                    sealed = true;
                },
                written: () => writing,
                versionUploads,
                completing,
                published: mayBePublished,
                current,
            });
            keptVersions += result.keptVersions;
            const done = new RunStopped(
                reason,
                stoppedWords(reason, {
                    shared,
                    failure: reason === 'failed' ? (failure ?? item?.error ?? null) : null,
                    keptVersions,
                    uncertainVersions: result.uncertainVersions,
                    remains: result.remains,
                }),
                result.cleanup,
                keptVersions,
                result.uncertainVersions,
            );
            stopped = done;
            for (const output of pending.values()) output.reject(done);
            pending.clear();
            end();
            return done;
        })();
        return stopping;
    }
    /*
     * A failure on the run's own way to a result (a folder's listing, a folder's creation): the
     * run stops and cleans up as an upload's failure does, all or nothing.
     */
    async function failed(error: unknown): Promise<never> {
        if (error instanceof RunStopped) throw error;
        if (stopping) throw await stopping;
        throw await stop('failed', undefined, error instanceof Error ? error.message : undefined);
    }
    /* A late folder that couldn't be removed joins the late row (keepLate on the phones). */
    function keepLate(nodeId: string, stopKeptRow: boolean) {
        if (!current()) return lateWriting;
        late ??= stopKeptRow
            ? { ...row, nodeIds: [...row.nodeIds], uploadIds: [...row.uploadIds] }
            : { ...row, nodeIds: [], uploadIds: [] };
        if (!late.nodeIds.includes(nodeId)) late.nodeIds.push(nodeId);
        const snapshot = { ...late, nodeIds: [...late.nodeIds], beat: now() };
        lateWriting = lateWriting
            .then(() => (current() ? deps.runs.put(snapshot) : undefined))
            .catch(() => {});
        return lateWriting;
    }
    function end() {
        clearInterval(beat);
        unsubscribe();
        release?.();
        liveRuns.delete(run);
    }

    const run: LiveRun = {
        id: row.id,
        async folder(name, { into = plan.targets[0]!, sources }) {
            await open();
            const signAs = resultSignatures(sources).metadata;
            // A folder inside one the run made goes with it and needs no row of its own.
            const recordIt = !madeFolders.has(into.id);
            let made: DriveNode;
            try {
                const given = claim(await namesTaken(into), name);
                await open();
                made = await deps.makeFolder(into, given, signAs, async (id) => {
                    // Its id on disk before its creation is sent, or the creation is not sent.
                    if (stopping || !current()) throw new Error('This save run is stopping.');
                    if (recordIt) {
                        row.nodeIds.push(id);
                        void persist();
                        await recorded();
                    }
                    if (stopping) throw new Error('This save run is stopping.');
                    mayBePublished.add(id);
                });
            } catch (error) {
                return failed(error);
            }
            if (!current() && !stopping) run.abandon();
            if (stopping) {
                const done = await stopping;
                // Signed out meanwhile: nothing is asked of the server or written for that account.
                if (abandoned) throw done;
                // Made while the run stopped: it goes the way the rest of the run went, and if it
                // cannot, a row names it for the next open (keepLate).
                const fate = await discard(deps, row.workspaceId, [made.id]).catch(
                    (): Cleanup => 'left',
                );
                if (fate === 'left') await keepLate(made.id, done.cleanup === 'left');
                throw done;
            }
            madeFolders.add(made.id);
            claimed.set(made.id, Promise.resolve(new Set()));
            return made;
        },
        async file(result) {
            await open();
            const into = result.into ?? plan.targets[0]!;
            const thumbnail = takeThumbnail(result.thumbnail);
            let file: MemoryFile;
            try {
                const name = claim(await namesTaken(into), result.name);
                file = memoryFile(name, result.bytes, result.mime, thumbnail, result.modified);
            } catch (error) {
                return failed(error);
            }
            // Checked again with nothing awaited before the enqueue: a stop that began while the
            // folder was listed refuses this result, which then never reaches the queue.
            await open();
            return (await enqueue('file', file, into, result.sources, {})) as NodeView | null;
        },
        async version(result) {
            await open();
            if (result.folder.id !== result.file.parentId)
                throw new Error('A new version is saved from the folder its file is in.');
            const thumbnail = takeThumbnail(result.thumbnail);
            const file = memoryFile(
                result.file.name,
                result.bytes,
                result.mime ?? result.file.metadata?.mime,
                thumbnail,
                result.modified,
            );
            return (await enqueue('version', file, result.folder, result.sources, {
                replaces: result.file,
                startedFrom: result.startedFrom,
            })) as VersionSaved;
        },
        async finish() {
            if (stopping) throw await stopping;
            if (pending.size) throw new Error('This save run still has results on their way.');
            finished = true;
            sealed = true;
            await writing;
            // Not retired: the run stays live (its row is never taken for interrupted here) and
            // finish may be asked again; nothing more is taken in (`finished`).
            if (current() && !(await retire(deps.runs, row))) throw new RecordNotUpdated();
            end();
        },
        async cancel() {
            // Finished: what it made was saved and stays (the message says so when there was any).
            if (finished)
                return new RunStopped(
                    'cancelled',
                    keptVersions || row.nodeIds.length ? ALREADY_SAVED : RUN_CANCELLED,
                    'nothing',
                    keptVersions,
                );
            return stop('cancelled');
        },
        waiting() {
            return pending.size;
        },
        abandon() {
            if (stopped) return;
            abandoned = true;
            // Nothing is removed after a sign-out: what was sent to be published may stay.
            const uncertain = [...completing].filter(
                (id) => versionUploads.has(id) && row.uploadIds.includes(id),
            ).length;
            const stays = row.nodeIds.some((id) => mayBePublished.has(id));
            const done = new RunStopped(
                'signed-out',
                stoppedWords('signed-out', {
                    keptVersions,
                    uncertainVersions: uncertain,
                    remains: stays ? 'stays' : null,
                }),
                'left',
                keptVersions,
                uncertain,
            );
            stopped = done;
            stopping ??= Promise.resolve(done);
            for (const output of pending.values()) output.reject(done);
            pending.clear();
            end();
        },
    };
    liveRuns.add(run);
    return run;
}

/*
 * Removes what a run made and then its row: its uploads still in this page
 * cancelled (the queue aborts them on the server), every upload the row names
 * aborted (an answer is needed: none, and the row stays), its published files
 * and folders to the Trash and, where the person may, deleted forever. An
 * upload the server had already finished is a new file to remove, or a new
 * version kept. A clean-up that cannot finish keeps the row for the next open;
 * one refused because the space is no longer this person's drops it.
 */
async function cleanUp(
    deps: SaveRunDeps,
    row: RunRow,
    live: string[],
    options: {
        seal?: () => void;
        written?: () => Promise<void>;
        versionUploads?: Set<string>;
        /* Uploads whose completion was sent; without it (an interrupted run), any may have been. */
        completing?: Set<string>;
        /* Nodes whose publication was sent; without it (an interrupted run), any may have been. */
        published?: Set<string>;
        current?: () => boolean;
    } = {},
): Promise<{
    cleanup: Cleanup;
    keptVersions: number;
    uncertainVersions: number;
    /* New files or folders that may still be there: `left` with the row kept, `no-access` without. */
    remains: 'left' | 'no-access' | null;
}> {
    await Promise.allSettled(live.map((id) => deps.transfers.cancel(id)));
    let unsettled = false;
    let denied = false;
    let keptVersions = 0;
    let uncertainVersions = 0;
    let othersMayLand = false;
    for (const uploadId of row.uploadIds) {
        const fate = await deps.abortUpload(row.workspaceId, uploadId);
        if (fate === 'unknown') {
            unsettled = true;
            // No answer: once its completion was sent it may still land, and a new version is
            // never said not to have; one whose completion was never sent cannot.
            if (!(options.completing?.has(uploadId) ?? true)) continue;
            if (options.versionUploads?.has(uploadId)) uncertainVersions += 1;
            else othersMayLand = true;
        } else if (fate === 'denied') {
            denied = true;
            // No longer this person's to ask: once its completion was sent it may have landed.
            if (!(options.completing?.has(uploadId) ?? true)) continue;
            if (options.versionUploads?.has(uploadId)) uncertainVersions += 1;
            else othersMayLand = true;
        } else if (fate === 'finished' && options.versionUploads?.has(uploadId)) keptVersions += 1;
    }
    const discarded = await discard(deps, row.workspaceId, row.nodeIds).catch(
        (): Cleanup => 'left',
    );
    let cleanup = discarded;
    if (unsettled) cleanup = 'left';
    else if (denied && (cleanup === 'nothing' || cleanup === 'no-access')) cleanup = 'no-access';
    // Not removed: only what was sent to be published may still be there.
    const unremoved =
        (discarded === 'left' || discarded === 'no-access') &&
        row.nodeIds.some((id) => options.published?.has(id) ?? true);
    const someRemain = othersMayLand || unremoved;
    if (cleanup !== 'left') {
        // After the last row the run wrote, so none lands after this one goes.
        options.seal?.();
        await options.written?.();
        // A row the journal won't retire stays as it was: the clean-up is left for the next open.
        if ((options.current?.() ?? true) && !(await retire(deps.runs, row))) cleanup = 'left';
    }
    const remains = !someRemain ? null : cleanup === 'left' ? 'left' : 'no-access';
    return { cleanup, keptVersions, uncertainVersions, remains };
}

/*
 * A run's row goes: removed, asked again once; if the journal still refuses,
 * marked `done` so no open offers what a finished run made for deletion (and
 * the next open drops it). False when neither was written: the row stays as
 * it was, and the caller says so rather than call it retired.
 */
async function retire(runs: RunJournal, row: RunRow) {
    for (let tries = 0; tries < 2; tries++)
        try {
            await runs.remove(row.id);
            return true;
        } catch {
            // Asked again, then marked done.
        }
    const done = { ...row, nodeIds: [...row.nodeIds], uploadIds: [...row.uploadIds], done: true };
    for (let tries = 0; tries < 2; tries++)
        try {
            await runs.put(done);
            return true;
        } catch {
            // Asked again; past that the row stays as it was.
        }
    return false;
}

/* Published results to the Trash, then deleted forever where the person may; anything refused is `left`. */
async function discard(
    deps: Pick<SaveRunDeps, 'trash' | 'purge' | 'mayPurge'>,
    workspaceId: string,
    nodeIds: string[],
): Promise<Cleanup> {
    if (!nodeIds.length) return 'nothing';
    const trashed = await deps.trash(workspaceId, nodeIds);
    const fates = nodeIds.map((id) => trashed.get(id) ?? 'refused');
    if (fates.every((fate) => fate === 'denied')) return 'no-access';
    if (fates.some((fate) => fate === 'refused' || fate === 'denied')) return 'left';
    const inTrash = nodeIds.filter((id) => trashed.get(id) === 'done');
    if (!inTrash.length) return 'nothing';
    if (!(await deps.mayPurge(workspaceId))) return 'trashed';
    const purged = await deps.purge(workspaceId, inTrash);
    if (inTrash.some((id) => !['done', 'gone'].includes(purged.get(id) ?? 'refused')))
        return 'left';
    return 'deleted';
}

/*
 * Runs a closed tab (or a crash) left behind, for the next open to offer
 * "… was interrupted. Delete what was made?": rows of runs not running in
 * this page or held by another tab (or, without Web Locks, whose heartbeat
 * stopped). Ids only; the app names the folder from its own metadata.
 */
export async function interruptedRuns(deps: Pick<SaveRunDeps, 'runs' | 'isLive' | 'now'>) {
    const now = deps.now ?? (() => Date.now());
    const live = new Set([...liveRuns].map((run) => run.id));
    const rows = await deps.runs.list();
    const left: RunRow[] = [];
    for (const row of rows) {
        // A finished run whose row couldn't be removed: never offered, dropped now.
        if (row.done) {
            await deps.runs.remove(row.id).catch(() => {});
            continue;
        }
        if (live.has(row.id)) continue;
        if (deps.isLive) {
            if (await deps.isLive(row.id)) continue;
        } else if (now() - (row.beat ?? row.at) < STALE_BEAT_MS) continue;
        left.push(row);
    }
    return left;
}

/* Deletes what an interrupted run made, as a cancel would have (cleanUp). */
export async function cleanUpInterrupted(deps: SaveRunDeps, row: RunRow) {
    return (await cleanUp(deps, row, [])).cleanup;
}

/*
 * "Keep what was made": an interrupted run's files and folders stay, and its
 * row always goes. Its open uploads are still asked to abort (they are not
 * files, only reserved room); one with no answer is left to the server, which
 * lets an open upload go once it expires, and one still finishing lands and
 * is kept, as asked.
 */
export async function keepInterrupted(
    deps: Pick<SaveRunDeps, 'abortUpload' | 'runs'>,
    row: RunRow,
): Promise<'kept' | 'not-recorded'> {
    for (const uploadId of row.uploadIds) await deps.abortUpload(row.workspaceId, uploadId);
    // The journal refusing to let it go: still offered, and Keep may be asked again.
    return (await retire(deps.runs, row)) ? 'kept' : 'not-recorded';
}
