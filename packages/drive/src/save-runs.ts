import {
    CHUNK_TAG_BYTES,
    THUMBNAIL_MAX_BYTES,
    chunkCount,
    paddedLength,
} from '@hushos/crypto/drive';
import type { SignatureForm } from '@hushos/crypto/signatures';
import type { NodeView } from './api';
import type { DriveNode } from './client';
import type { RunJournal, RunRow, UploadSignatures } from './journal';
import type { MemoryFile, TransferManager, TransferManagerOptions, UploadItem } from './transfers';

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
 * one row of ids (RunRow) so that a cancel, a refusal, a 402, a failure or a
 * closed tab leaves nothing: open uploads aborted, what was published deleted
 * forever, or moved to the Trash where the person may not delete forever.
 */

/*
 * One result's room, an upper bound on its padded ciphertext whatever its
 * thumbnail turns out to be: the Padmé bucket of its bytes with a full 64 KiB
 * thumbnail trailer and its tag, plus a 16-byte tag per chunk of that bucket.
 * Never less than what begin reserves for it (ciphertextSize in
 * @hushos/crypto/drive), at most a chunk tag more than the largest of those.
 */
export function resultEstimate(plaintextSize: number) {
    const padded = paddedLength(plaintextSize + THUMBNAIL_MAX_BYTES + CHUNK_TAG_BYTES);
    return padded + CHUNK_TAG_BYTES * chunkCount(padded);
}

/* A result's bytes when they are known before producing it, or the sources' it is made from (conversion, compress). */
export type PlannedResult = { size: number } | { sourcesSize: number };

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
        );
    return total;
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
 * Why a run stopped after it started, and what its clean-up did with what it
 * had made: deleted forever, moved to the Trash (an editor in someone else's
 * folder may not delete forever), or nothing was published to remove. `left`
 * when the clean-up itself failed: the run's row stays for the next open.
 */
export type Cleanup = 'deleted' | 'trashed' | 'nothing' | 'left';
export class RunStopped extends Error {
    constructor(
        readonly reason: 'cancelled' | 'no-room' | 'failed',
        message: string,
        readonly cleanup: Cleanup,
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

type TransferEvent = Parameters<NonNullable<TransferManagerOptions['onEvent']>>[0];

export type SaveRunDeps = {
    transfers: Pick<TransferManager, 'enqueue' | 'cancel'>;
    /* Every upload event (the app's fan-out of the transfer manager's onEvent). */
    events: (listener: (event: TransferEvent) => void) => () => void;
    runs: RunJournal;
    refuseWrite: (target: DriveNode) => string | null;
    waitsForKeyChange: (target: DriveNode) => boolean;
    /*
     * The free bytes of a workspace (allowance minus used minus reserved), or
     * null when they are not this person's to know: someone else's share,
     * whose owner's free space is never revealed. There the server's 402 is
     * the only check, and the run ends "no room" and cleans up.
     */
    freeSpace: (workspaceId: string) => Promise<number | null>;
    /* The names in a folder now. */
    namesIn: (folder: DriveNode) => Promise<Iterable<string>>;
    /* The next free name among `taken` ("name (2).ext"), matching whatever the case. */
    nextName: (name: string, taken: Set<string>) => string;
    /* A new folder, signed as `signAs`; waits out a family folder's key change, refuses otherwise. */
    makeFolder: (parent: DriveNode, name: string, signAs: SignatureForm) => Promise<DriveNode>;
    abortUpload: (workspaceId: string, uploadId: string) => Promise<void>;
    /* To the Trash, then (where `mayPurge`) deleted forever; both answer per item and refuse nothing whole. */
    trash: (workspaceId: string, nodeIds: string[]) => Promise<void>;
    purge: (workspaceId: string, nodeIds: string[]) => Promise<void>;
    /*
     * Whether the person may delete forever in a workspace: the server lets
     * only a member (their own, their family's folders), never an editor
     * through a share, whose results go to the owner's Trash instead.
     */
    mayPurge: (workspaceId: string) => boolean;
    /* Marks a run live for as long as it runs (Web Locks on the web), so no tab takes it for interrupted. */
    hold?: (runId: string) => () => void;
    isLive?: (runId: string) => Promise<boolean>;
    /* The session generation the caller's work began in (the transfer manager's enqueue `from`). */
    from?: { generation: number };
    newId?: () => string;
    now?: () => number;
};

/* Where a run's results came from: sources whose signatures it takes (sourcesSignatureForms), or the person's own work. */
export type RunPlan = {
    /* Where the run writes: folders new files go into, files new versions go onto; one workspace. */
    targets: DriveNode[];
    results: PlannedResult[];
    signAs: UploadSignatures;
};

export type ProducedFile = {
    name: string;
    bytes: Uint8Array | Uint8Array[];
    mime: string | null;
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
    readonly signAs: UploadSignatures;
    /* A new folder for results under the next free name in `into` (the run's first target by default). */
    folder(name: string, into?: DriveNode): Promise<DriveNode>;
    /* A new file under the next free name in its folder; never replaces anything. */
    file(result: ProducedFile): Promise<NodeView | null>;
    /* A new version of `file`, unless someone else saved since the work started (`stale`). */
    version(result: ProducedVersion): Promise<VersionSaved>;
    /* Every result is in: the run's row goes. Throws while any is still on its way. */
    finish(): Promise<void>;
    /* Stops the run and removes what it made; what was removed, and how. */
    cancel(): Promise<Cleanup>;
    /* Results queued and not yet in. */
    waiting(): number;
};

/* Runs live in this page: a result still waiting to upload asks before the page unloads. */
const liveRuns = new Set<SaveRun>();
export function resultsWaiting() {
    for (const run of liveRuns) if (run.waiting() > 0) return true;
    return false;
}

function toParts(bytes: Uint8Array | Uint8Array[]) {
    return Array.isArray(bytes) ? bytes : [bytes];
}

/*
 * Starts a run: the write gate and the room check, both before anything is
 * made, then the run's row. Throws SaveRefused when it may not start.
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
    const needed = runEstimate(plan.results);
    const free = await deps.freeSpace(workspaceId);
    if (free !== null && needed > free)
        throw new SaveRefused('no-room', NO_ROOM, { needed, free: Math.max(0, free) });
    const now = deps.now ?? (() => Date.now());
    const row: RunRow = {
        id: deps.newId?.() ?? crypto.randomUUID(),
        workspaceId,
        nodeIds: [],
        uploadIds: [],
        at: now(),
    };
    await deps.runs.put(row);
    return createRun(deps, row, plan, free === null);
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

function createRun(deps: SaveRunDeps, row: RunRow, plan: RunPlan, shared: boolean): SaveRun {
    const pending = new Map<string, Pending>();
    /* Folders this run made: what is inside one goes with it and needs no row of its own. */
    const madeFolders = new Set<string>();
    /*
     * Names given out per folder, so two results never take the same one: one listing per
     * folder, shared by every result asking for it at once.
     */
    const claimed = new Map<string, Promise<Set<string>>>();
    let stopped: RunStopped | null = null;
    let stopping: Promise<Cleanup> | null = null;
    let finished = false;
    const release = deps.hold?.(row.id);
    // Rows written one after another, each the run as it is then.
    let writing = Promise.resolve();
    const persist = () => {
        const snapshot = { ...row, nodeIds: [...row.nodeIds], uploadIds: [...row.uploadIds] };
        writing = writing.then(() => deps.runs.put(snapshot)).catch(() => {});
        return writing;
    };
    const unsubscribe = deps.events(onEvent);

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
    function check() {
        if (stopped) throw stopped;
        if (finished) throw new Error('This save run has finished.');
    }

    function onEvent(event: TransferEvent) {
        const output = pending.get(event.item.id);
        if (!output) return;
        switch (event.type) {
            case 'done':
                return settled(event.item, output);
            case 'failed':
                if (output.kind === 'version' && event.item.errorCode === 'stale') {
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
            case 'cancelled':
                // Cancelled from the transfers panel: a run is all or nothing.
                if (!stopping) void stop('cancelled', event.item);
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
        // A new file a key change moved under is attached as a node of its own: that one is kept.
        const landed = item.node?.id ?? null;
        if (output.tracked && landed && landed !== output.nodeId) {
            row.nodeIds = row.nodeIds.filter((id) => id !== output.nodeId);
            row.nodeIds.push(landed);
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
        extra: { replaces?: DriveNode; startedFrom?: string | null },
    ) {
        check();
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
                    origin: 'copy',
                    signAs: plan.signAs,
                    produced: {
                        ...(extra.replaces ? { startedFrom: extra.startedFrom ?? null } : {}),
                        onBegun: ({ uploadId, nodeId }) => {
                            // A restart begins again with fresh ids: the last begin is the one held.
                            if (output.uploadId)
                                row.uploadIds = row.uploadIds.filter(
                                    (held) => held !== output.uploadId,
                                );
                            if (output.tracked && output.nodeId)
                                row.nodeIds = row.nodeIds.filter((held) => held !== output.nodeId);
                            output.uploadId = uploadId;
                            row.uploadIds.push(uploadId);
                            if (output.tracked) {
                                output.nodeId = nodeId;
                                row.nodeIds.push(nodeId);
                            }
                            void persist();
                        },
                    },
                },
            ],
            deps.from,
        );
        pending.set(id!, output);
        return settledPromise;
    }

    function memoryFile(
        name: string,
        bytes: Uint8Array | Uint8Array[],
        mime: string | null | undefined,
        thumbnail: Uint8Array | null | undefined,
        modified: number | undefined,
    ): MemoryFile {
        const parts = toParts(bytes);
        return {
            kind: 'memory',
            name,
            size: parts.reduce((total, part) => total + part.byteLength, 0),
            type: mime ?? '',
            lastModified: modified ?? (deps.now ?? Date.now)(),
            parts,
            thumbnail: thumbnail ?? null,
        };
    }

    function stop(reason: RunStopped['reason'], item?: UploadItem): Promise<Cleanup> {
        if (stopping) return stopping;
        const message =
            reason === 'cancelled'
                ? RUN_CANCELLED
                : reason === 'no-room'
                  ? shared
                      ? NO_ROOM_SHARED
                      : NO_ROOM
                  : (item?.error ?? RUN_FAILED);
        // Set before any of it runs: the cancels it sends are heard here, and must not stop it twice.
        stopping = Promise.resolve().then(async () => {
            const open = [...pending.keys()];
            const cleanup = await cleanUp(deps, row, open, () => writing);
            stopped = new RunStopped(reason, message, cleanup);
            for (const output of pending.values()) output.reject(stopped);
            pending.clear();
            end();
            return cleanup;
        });
        return stopping;
    }
    function end() {
        unsubscribe();
        release?.();
        liveRuns.delete(run);
    }

    const run: SaveRun = {
        id: row.id,
        signAs: plan.signAs,
        async folder(name, into = plan.targets[0]!) {
            check();
            const taken = await namesTaken(into);
            const given = claim(taken, name);
            const made = await deps.makeFolder(into, given, plan.signAs.metadata);
            if (stopping) {
                // Stopped while it was being made: it goes the way the rest of the run went.
                await stopping;
                await discard(deps, row.workspaceId, [made.id]).catch(() => {});
                throw stopped;
            }
            madeFolders.add(made.id);
            claimed.set(made.id, Promise.resolve(new Set()));
            if (!madeFolders.has(into.id)) {
                row.nodeIds.push(made.id);
                await persist();
            }
            return made;
        },
        async file(result) {
            check();
            const into = result.into ?? plan.targets[0]!;
            const name = claim(await namesTaken(into), result.name);
            const file = memoryFile(
                name,
                result.bytes,
                result.mime,
                result.thumbnail,
                result.modified,
            );
            return (await enqueue('file', file, into, {})) as NodeView | null;
        },
        async version(result) {
            check();
            if (result.folder.id !== result.file.parentId)
                throw new Error('A new version is saved from the folder its file is in.');
            const file = memoryFile(
                result.file.name,
                result.bytes,
                result.mime ?? result.file.metadata?.mime,
                result.thumbnail,
                result.modified,
            );
            return (await enqueue('version', file, result.folder, {
                replaces: result.file,
                startedFrom: result.startedFrom,
            })) as VersionSaved;
        },
        async finish() {
            if (stopped) throw stopped;
            if (pending.size) throw new Error('This save run still has results on their way.');
            finished = true;
            await writing;
            await deps.runs.remove(row.id).catch(() => {});
            end();
        },
        cancel() {
            if (finished) return Promise.resolve<Cleanup>('nothing');
            return stop('cancelled');
        },
        waiting() {
            return pending.size;
        },
    };
    liveRuns.add(run);
    return run;
}

/*
 * Removes what a run made and then its row: its uploads still in this page
 * cancelled (the queue aborts them on the server), any others the row names
 * aborted, its published files and folders to the Trash and, where the person
 * may, deleted forever. A clean-up that fails keeps the row for the next open.
 */
async function cleanUp(
    deps: SaveRunDeps,
    row: RunRow,
    live: string[],
    written: () => Promise<void> = async () => {},
): Promise<Cleanup> {
    await Promise.allSettled(live.map((id) => deps.transfers.cancel(id)));
    if (!live.length)
        await Promise.allSettled(
            row.uploadIds.map((uploadId) => deps.abortUpload(row.workspaceId, uploadId)),
        );
    let cleanup: Cleanup;
    try {
        cleanup = await discard(deps, row.workspaceId, row.nodeIds);
    } catch {
        return 'left';
    }
    // After the last row the run wrote, so none lands after this one goes.
    await written();
    await deps.runs.remove(row.id).catch(() => {});
    return cleanup;
}

/* Published results to the Trash, then deleted forever where the person may. */
async function discard(
    deps: Pick<SaveRunDeps, 'trash' | 'purge' | 'mayPurge'>,
    workspaceId: string,
    nodeIds: string[],
): Promise<Cleanup> {
    if (!nodeIds.length) return 'nothing';
    await deps.trash(workspaceId, nodeIds);
    if (!deps.mayPurge(workspaceId)) return 'trashed';
    await deps.purge(workspaceId, nodeIds);
    return 'deleted';
}

/*
 * Runs a closed tab (or a crash) left behind, for the next open to offer
 * "… was interrupted. Delete what was made?": rows of runs not running in
 * this page or held by another tab. Ids only; the app names the folder from
 * its own metadata.
 */
export async function interruptedRuns(deps: Pick<SaveRunDeps, 'runs' | 'isLive'>) {
    const live = new Set([...liveRuns].map((run) => run.id));
    const rows = await deps.runs.list();
    const left: RunRow[] = [];
    for (const row of rows) {
        if (live.has(row.id)) continue;
        if (deps.isLive && (await deps.isLive(row.id))) continue;
        left.push(row);
    }
    return left;
}

/* Cleans up an interrupted run as a cancel would have (cleanUp). */
export function cleanUpInterrupted(deps: SaveRunDeps, row: RunRow) {
    return cleanUp(deps, row, []);
}
