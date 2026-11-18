import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { UploadPartResult } from '@hushos/crypto';
import { DriveApiError, type DriveApi, type NodeView } from './api';
import type { DriveNode } from './client';
import { createMemoryRunJournal, type RunJournal } from './journal';
import {
    OWN_WRITING,
    RecordNotUpdated,
    RunStopped,
    abandonRuns,
    askAbort,
    lockRuns,
    CREATION_SETTLE_MS,
    cleanUpInterrupted,
    interruptedRuns,
    quietlySettled,
    startRun,
    type ItemFate,
    type SaveRun,
    type SaveRunDeps,
    type VersionSaved,
} from './save-runs';
import type { TransferManagerOptions } from './transfers';
import { harness, node } from './transfers.harness';

/*
 * The save path's rule one level down (save-runs.faults.test.ts drives a stand-in
 * queue): the real save-runs over the real upload engine (createTransferManager,
 * through the bench transfers.test.ts uses), against a server that does what the
 * real one does where it matters here:
 *
 * - key epochs and versions: a begin whose file moved on is `stale`; one whose
 *   key moved (its version the same) is `stale` too; a completion that finds
 *   the file moved is `conflicted` naming the version current now;
 * - a completion publishes only once the store completes it, and an abort in
 *   between answers "completing";
 * - trash and purge answer per item, a purge refuses past a busy budget, and a
 *   whole request can be refused (403) as no longer the person's;
 * - an editor in someone else's share may only Trash; a begin past the free
 *   room is 402;
 * - the app's folder listing is shared for two seconds (lib/transfers.ts lookUp)
 *   unless asked fresh.
 *
 * Each wait (the room check, the lock grant, a listing, a folder's creation, the
 * epoch allocation, a begin, a part, a completion, an attach, an abort, a trash,
 * a purge, mayPurge, a journal write or removal) is failed in turn, sampled with
 * a fixed seed, with no network, a lost answer, a refusal, an outage, a cancel,
 * a crash just after the server acted, or the process dying. After each, the
 * rule the stand-in test checks, and two of the engine's own: a result said to
 * be `stale` lost a real race, and a real race is said `stale` with the version
 * that won.
 */

type Point =
    | 'room'
    | 'hold'
    | 'listing'
    | 'lookup'
    | 'folder'
    | 'allocate'
    | 'begin'
    | 'part'
    | 'complete'
    | 'attach'
    | 'abort'
    | 'trash'
    | 'purge'
    | 'may-purge'
    | 'journal-put'
    | 'journal-remove';
/*
 * `revoked`: from that wait on the person's access is gone (the share ended), and the server
 * answers 404 as it does for a workspace no longer theirs. `denied`: a whole request refused
 * 403. `slow`: a journal write takes its time and the process dies before it lands. `late`: the
 * answer is cut while the server is still at it, and it acts five seconds later. `signout`,
 * `lock`: the person signs out (the journal goes with the account) or the app locks.
 */
type Fault =
    | 'network'
    | 'lost'
    | 'refused'
    | 'outage'
    | 'cancel'
    | 'crash'
    | 'death'
    | 'revoked'
    | 'denied'
    | 'slow'
    | 'late'
    | 'signout'
    | 'lock';

const PEOPLE: Fault[] = ['cancel', 'signout', 'lock'];
const SERVER: Fault[] = [
    'network',
    'lost',
    'refused',
    'outage',
    'crash',
    'death',
    'revoked',
    ...PEOPLE,
];
const ASKING: Fault[] = ['network', 'refused', 'outage', 'death', ...PEOPLE];
const FAULTS: Record<Point, Fault[]> = {
    room: ASKING,
    hold: ['refused', 'cancel', 'death'],
    listing: ASKING,
    lookup: ASKING,
    folder: [...SERVER, 'late'],
    allocate: ASKING,
    begin: SERVER,
    part: ['network', 'refused', 'outage', 'cancel', 'death'],
    complete: SERVER,
    attach: SERVER,
    abort: SERVER,
    trash: [...SERVER, 'denied'],
    purge: [...SERVER, 'denied'],
    'may-purge': ['refused', 'death', ...PEOPLE],
    'journal-put': ['refused', 'crash', 'death', 'slow', ...PEOPLE],
    'journal-remove': ['refused', 'crash', 'death', ...PEOPLE],
};

type Plan = { point: Point; k: number; fault: Fault } | null;
type TransferEvent = Parameters<NonNullable<TransferManagerOptions['onEvent']>>[0];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
    abandonRuns();
    vi.useRealTimers();
});

const own = { sources: OWN_WRITING } as const;
const bytes = (n = 1024) => new Uint8Array(n).fill(7);
/* Long enough for the engine's retries and backoff, the abort's asking, and a slow store. */
const SETTLE_MS = 120_000;

/* What the server holds. `f` is a folder with `doc` (version v1, key epoch 1) in it. */
function serverOf(options: { storeMs?: number; editor?: boolean; busy?: number; quota?: number }) {
    type Node = {
        kind: 'file' | 'folder';
        parent: string;
        keyEpoch: number;
        version: string | null;
        state: 'live' | 'trash' | 'purged';
        name: string;
    };
    type Upload = {
        nodeId: string;
        parent: string;
        newNode: boolean;
        expected: string | null;
        keyEpoch: number;
        /* The folder's key epoch a new file's begin was sealed under. */
        parentKeyEpoch: number;
        size: number;
        versionId: string;
        status: 'open' | 'completing' | 'conflicted' | 'completed' | 'aborted';
    };
    const nodes = new Map<string, Node>([
        [
            'root',
            { kind: 'folder', parent: '', keyEpoch: 1, version: null, state: 'live', name: 'root' },
        ],
        [
            'f',
            {
                kind: 'folder',
                parent: 'root',
                keyEpoch: 1,
                version: null,
                state: 'live',
                name: 'f',
            },
        ],
        [
            'doc',
            { kind: 'file', parent: 'f', keyEpoch: 1, version: 'v1', state: 'live', name: 'doc' },
        ],
    ]);
    const original = new Set(nodes.keys());
    const uploads = new Map<string, Upload>();
    let next = 0;
    let busy = options.busy ?? 0;
    /* Versions this test's run published (another client's save is not one). */
    let ownVersions = 0;
    const lostBegins = new Set<string>();
    const recorded = new Set<string>();
    let completing: (() => void) | null = null;
    /* Runs as a part arrives: another device acting while the bytes go up. */
    let onPart: (() => void) | null = null;
    /* Bytes still free for this person's uploads (402 at begin past it), when the scenario sets one. */
    let free = options.quota ?? Number.POSITIVE_INFINITY;
    /* Another device saved a version of `doc`: a version of ours never goes over it. */
    let othersSaved = false;
    const conflict = (current: string | null) =>
        new DriveApiError('This file changed while it was uploading.', 'conflict', 409, {
            conflicted: true,
            currentVersionId: current,
        });
    function gone(id: string): boolean {
        const node = nodes.get(id);
        if (!node || node.state === 'purged') return true;
        return nodes.has(node.parent) ? gone(node.parent) : false;
    }
    function publish(upload: Upload, nodeId: string) {
        upload.status = 'completed';
        if (upload.newNode)
            nodes.set(nodeId, {
                kind: 'file',
                parent: upload.parent,
                keyEpoch: upload.keyEpoch,
                version: upload.versionId,
                state: 'live',
                name: nodeId,
            });
        else {
            nodes.get(nodeId)!.version = upload.versionId;
            ownVersions += 1;
        }
    }
    return {
        nodes,
        uploads,
        lostBegins,
        recorded,
        editor: options.editor ?? false,
        onCompleting(hook: () => void) {
            completing = hook;
        },
        driveNode(id: string): DriveNode {
            const held = nodes.get(id)!;
            return {
                ...node(id, held.parent || null),
                kind: held.kind,
                keyEpoch: held.keyEpoch,
                currentVersion: held.version
                    ? ({ id: held.version } as DriveNode['currentVersion'])
                    : null,
                name: held.name,
            };
        },
        begin(input: Parameters<DriveApi['beginUpload']>[1]) {
            const spec = input.node;
            let upload: Upload;
            if (spec.existing) {
                const file = nodes.get(spec.id);
                if (!file || file.state !== 'live')
                    throw new DriveApiError('Gone.', 'not-found', 404);
                // Its version moved on, or its key did: refused `stale` either way, as packages/db does.
                if (file.version !== spec.expectedVersionId || file.keyEpoch !== spec.keyEpoch)
                    throw new DriveApiError(
                        'This item changed since you last saw it.',
                        'stale',
                        409,
                    );
                upload = {
                    nodeId: spec.id,
                    parent: file.parent,
                    newNode: false,
                    expected: spec.expectedVersionId,
                    keyEpoch: file.keyEpoch,
                    parentKeyEpoch: nodes.get(file.parent)!.keyEpoch,
                    size: Number(input.ciphertextSize),
                    versionId: input.versionId,
                    status: 'open',
                };
            } else {
                const parent = nodes.get(spec.parentId);
                if (!parent || gone(spec.parentId))
                    throw new DriveApiError('Gone.', 'not-found', 404);
                if (parent.keyEpoch !== spec.parentKeyEpoch)
                    throw new DriveApiError(
                        'This item changed since you last saw it.',
                        'stale',
                        409,
                    );
                upload = {
                    nodeId: spec.id,
                    parent: spec.parentId,
                    newNode: true,
                    expected: null,
                    keyEpoch: spec.keyEpoch,
                    parentKeyEpoch: spec.parentKeyEpoch,
                    size: Number(input.ciphertextSize),
                    versionId: input.versionId,
                    status: 'open',
                };
            }
            // Room is reserved at begin: past what is free, 402, as packages/db's begin answers.
            if (upload.size > free)
                throw new DriveApiError('There isn’t enough room for this.', 'over-quota', 402);
            free -= upload.size;
            const id = `up-${++next}`;
            uploads.set(id, upload);
            const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
            return {
                upload: {
                    id,
                    nodeId: upload.nodeId,
                    versionId: input.versionId,
                    objectId: input.objectId,
                    status: 'open' as const,
                    chunkCount: input.chunkCount,
                    ciphertextSize: input.ciphertextSize,
                    expiresAt,
                },
                parts: Array.from({ length: input.chunkCount }, (_, i) => ({
                    partNumber: i + 1,
                    length: 1,
                    url: `https://store/${id}/${i + 1}`,
                })),
                urlExpiresAt: expiresAt,
            };
        },
        /* The store completes it a while later: only then is anything published. */
        async complete(id: string) {
            const upload = uploads.get(id);
            if (!upload || upload.status !== 'open')
                throw new DriveApiError('This upload is ready.', 'conflict', 409);
            upload.status = 'completing';
            completing?.();
            await new Promise((resolve) => setTimeout(resolve, options.storeMs ?? 0));
            if (upload.status !== 'completing')
                throw new DriveApiError('Cancelled.', 'conflict', 409);
            const file = nodes.get(upload.nodeId);
            const parent = nodes.get(upload.parent);
            // As packages/db finishCompleting: the file's version or key moved, or (for a new file)
            // its folder's key: `conflicted`, naming the version current now.
            if (
                !upload.newNode &&
                file &&
                (file.version !== upload.expected || file.keyEpoch !== upload.keyEpoch)
            ) {
                upload.status = 'conflicted';
                throw conflict(file.version);
            }
            if (upload.newNode && parent && parent.keyEpoch !== upload.parentKeyEpoch) {
                upload.status = 'conflicted';
                throw conflict(null);
            }
            publish(upload, upload.nodeId);
            return {
                status: 'completed' as const,
                node: { id: upload.nodeId, parentId: upload.parent, workspaceId: 'ws' } as NodeView,
            };
        },
        attach(id: string, input: { mode: string; keyEpoch?: number; node?: { id: string } }) {
            const upload = uploads.get(id);
            if (!upload || upload.status !== 'conflicted')
                throw new DriveApiError('Not conflicted.', 'conflict', 409);
            const nodeId = input.node?.id ?? upload.nodeId;
            const stale = () =>
                new DriveApiError('This item changed since you last saw it.', 'stale', 409);
            if (input.mode === 'same-node') {
                const file = nodes.get(upload.nodeId)!;
                if (file.version !== upload.expected) throw conflict(file.version);
                // Rewrapped under the key the file has now, or refused: never under one it no longer has.
                if (input.keyEpoch !== file.keyEpoch) throw stale();
                upload.keyEpoch = file.keyEpoch;
            } else {
                const sibling = input.node as unknown as {
                    parentId: string;
                    parentKeyEpoch: number;
                    keyEpoch: number;
                };
                const parent = nodes.get(sibling.parentId);
                if (!parent || gone(sibling.parentId))
                    throw new DriveApiError('Gone.', 'not-found', 404);
                if (parent.keyEpoch !== sibling.parentKeyEpoch) throw stale();
                upload.parent = sibling.parentId;
                upload.keyEpoch = sibling.keyEpoch;
            }
            publish(upload, nodeId);
            return {
                status: 'completed' as const,
                node: { id: nodeId, parentId: upload.parent, workspaceId: 'ws' } as NodeView,
            };
        },
        abort(id: string) {
            const upload = uploads.get(id);
            if (!upload) throw new DriveApiError('This upload no longer exists.', 'not-found', 404);
            if (upload.status === 'completing')
                throw new DriveApiError(
                    'This upload is finishing and cannot be cancelled.',
                    'conflict',
                    409,
                    { upload: 'completing' },
                );
            if (upload.status === 'completed')
                throw new DriveApiError('This upload already finished.', 'conflict', 409, {
                    upload: 'completed',
                });
            upload.status = 'aborted';
            return { aborted: true };
        },
        createFolder(id: string, parent: string, name: string) {
            if (gone(parent)) throw new DriveApiError('Gone.', 'not-found', 404);
            nodes.set(id, {
                kind: 'folder',
                parent,
                keyEpoch: 1,
                version: null,
                state: 'live',
                name,
            });
        },
        names(parent: string) {
            return [...nodes.values()]
                .filter((n) => n.parent === parent && n.state === 'live')
                .map((n) => n.name);
        },
        trash(ids: string[]) {
            const fates = new Map<string, ItemFate>();
            for (const id of ids) {
                const held = nodes.get(id);
                if (!held || held.state === 'purged') fates.set(id, 'gone');
                else {
                    held.state = 'trash';
                    fates.set(id, 'done');
                }
            }
            return fates;
        },
        /*
         * Past the busy budget an item is refused `busy`, as a workspace too busy answers. Only a
         * member deletes forever (an editor's whole request is 404), and only what is in the
         * Trash (anything else is refused, 409).
         */
        purge(ids: string[]) {
            if (options.editor)
                throw new DriveApiError('This item no longer exists.', 'not-found', 404);
            const fates = new Map<string, ItemFate>();
            for (const id of ids) {
                const held = nodes.get(id);
                if (busy > 0) {
                    busy -= 1;
                    fates.set(id, 'refused');
                } else if (held?.state === 'trash') {
                    held.state = 'purged';
                    fates.set(id, 'done');
                } else if (held && held.state === 'live') fates.set(id, 'refused');
                else fates.set(id, 'gone');
            }
            return fates;
        },
        part() {
            onPart?.();
        },
        onPart(hook: () => void) {
            onPart = hook;
        },
        /* Another device's key change: the node's key moves to a new epoch (its version stays). */
        bumpKey(id: string) {
            nodes.get(id)!.keyEpoch += 1;
        },
        /* Another device saves a version of `doc`. */
        othersSave() {
            nodes.get('doc')!.version = 'v-theirs';
            othersSaved = true;
        },
        othersSaved: () => othersSaved,
        gone,
        /*
         * New files and folders this run made that are still there: live, or (for a member whose
         * clean-up could delete forever) in the Trash. One that could only trash leaves them there.
         */
        published(trashCounts = !options.editor) {
            return [...nodes.entries()]
                .filter(
                    ([id, held]) =>
                        !original.has(id) && !gone(id) && (held.state === 'live' || trashCounts),
                )
                .map(([id]) => id);
        },
        lineage(id: string) {
            const out: string[] = [];
            for (let at: string | undefined = id; at; at = nodes.get(at)?.parent) out.push(at);
            return out;
        },
        versions: () => ownVersions,
        openReservations() {
            return [...uploads.entries()]
                .filter(([, u]) => u.status === 'open' || u.status === 'conflicted')
                .map(([id]) => id);
        },
    };
}
type Server = ReturnType<typeof serverOf>;

/* One process of the app over the server and the journal (the disk), failing as planned. */
function processOf(srv: Server, disk: ReturnType<typeof createMemoryRunJournal>, plan: Plan) {
    const counts = new Map<Point, number>();
    const state = { dead: false, signedOut: false, outage: false, revoked: false };
    let interrupt: (fault: Fault) => void = () => {};
    function faultAt(point: Point) {
        const k = (counts.get(point) ?? 0) + 1;
        counts.set(point, k);
        const fault = plan && plan.point === point && plan.k === k ? plan.fault : null;
        if (fault === 'death') state.dead = true;
        if (fault === 'outage') state.outage = true;
        if (fault === 'revoked') state.revoked = true;
        if (fault && PEOPLE.includes(fault)) interrupt(fault);
        return fault;
    }
    const lostAccess = () => new DriveApiError('This item no longer exists.', 'not-found', 404);
    const offline = () => new TypeError('Failed to fetch');
    async function call<T>(
        point: Point,
        effect: () => T | Promise<T>,
        refusal: () => T,
    ): Promise<T> {
        await Promise.resolve();
        const fault = faultAt(point);
        if (state.dead || state.outage || fault === 'network') throw offline();
        // The share ended: every request about it is a 404 now.
        if (state.revoked && !['room', 'hold', 'may-purge'].includes(point)) throw lostAccess();
        if (fault === 'refused') return refusal();
        if (fault === 'denied')
            throw new DriveApiError('You no longer have access.', 'forbidden', 403);
        if (fault === 'late') {
            setTimeout(
                () =>
                    void Promise.resolve()
                        .then(effect)
                        .catch(() => {}),
                5_000,
            );
            throw offline();
        }
        const result = await effect();
        if (fault === 'lost' || fault === 'crash') {
            if (fault === 'crash') state.dead = true;
            if (point === 'begin')
                srv.lostBegins.add((result as { upload: { id: string } }).upload.id);
            throw offline();
        }
        return result;
    }
    async function write(point: Point, apply: () => Promise<void>) {
        await Promise.resolve();
        const fault = faultAt(point);
        if (state.dead || fault === 'refused')
            throw new DOMException('refused', 'QuotaExceededError');
        // A slow disk: the write takes three seconds, and the process dies before it lands.
        if (fault === 'slow') {
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            state.dead = true;
            throw new DOMException('gone', 'AbortError');
        }
        await apply();
        if (fault === 'crash') state.dead = true;
    }
    const runs: RunJournal = {
        list: () => disk.list(),
        put: (row) =>
            write('journal-put', async () => {
                await disk.put(row);
                for (const id of row.uploadIds) srv.recorded.add(id);
            }),
        remove: (id) => write('journal-remove', () => disk.remove(id)),
    };
    const forbidden = () => {
        throw new DriveApiError('You no longer have access to this.', 'forbidden', 403);
    };

    /* The app's folder listing, shared for two seconds unless asked fresh (lib/transfers.ts lookUp). */
    const looks = new Map<
        string,
        { at: number; parent: DriveNode; children: Map<string, DriveNode> }
    >();
    async function lookUp(folderId: string, fresh: boolean, another = false) {
        const held = looks.get(folderId);
        if (!fresh && held && Date.now() - held.at < 2_000) return held;
        // Another upload's look (shared with this one) is no wait of the run's.
        const ask = another ? <T>(_: Point, effect: () => T) => Promise.resolve(effect()) : call;
        const listing = await ask(
            'lookup',
            () => ({
                at: Date.now(),
                parent: srv.driveNode(folderId),
                children: new Map(
                    [...srv.nodes.entries()]
                        .filter(([, n]) => n.parent === folderId && n.state === 'live')
                        .map(([id]) => [id, srv.driveNode(id)] as const),
                ),
            }),
            forbidden,
        );
        looks.set(folderId, listing);
        return listing;
    }

    const listeners = new Set<(event: TransferEvent) => void>();
    const send = async (_objectId: string, index: number): Promise<UploadPartResult> => {
        try {
            return await call<UploadPartResult>(
                'part',
                () => {
                    srv.part();
                    return { ok: true as const, etag: `etag-${index}`, bytes: 1 };
                },
                () => ({ ok: false as const, status: 403, retryable: false, message: 'Refused.' }),
            );
        } catch {
            return { ok: false, status: 0, retryable: true, message: 'Failed to fetch' };
        }
    };
    const h = harness({
        send,
        onEvent: (event) => {
            for (const listener of listeners) listener(event);
        },
        openNodes: async (entry, options) => {
            const listing = await lookUp(entry.parentId, Boolean(options?.fresh));
            const id =
                'uploadId' in entry ? (entry.newNode ? null : entry.nodeId) : entry.replacesId;
            return {
                parent: listing.parent,
                ...(id && listing.children.get(id) ? { replaces: listing.children.get(id) } : {}),
            };
        },
    });
    const api = h.api as unknown as DriveApi;
    let epochs = 10;
    Object.assign(api, {
        allocateEpochs: (_ws: string, count: number) =>
            call(
                'allocate',
                () => {
                    const from = epochs;
                    epochs += count;
                    return { from, to: from + count - 1 };
                },
                forbidden,
            ),
        beginUpload: (_ws: string, input: Parameters<DriveApi['beginUpload']>[1]) =>
            call('begin', () => srv.begin(input), forbidden),
        completeUpload: (_ws: string, id: string) =>
            call('complete', () => srv.complete(id), forbidden),
        attachUpload: (_ws: string, id: string, input: { mode: string; node?: { id: string } }) =>
            call('attach', () => srv.attach(id, input), forbidden),
        abortUpload: (_ws: string, id: string) => call('abort', () => srv.abort(id), forbidden),
    });
    let folders = 0;
    const deps: SaveRunDeps = {
        transfers: {
            enqueue: (inputs, from) => h.manager.enqueue(inputs, from),
            cancel: (id) => h.manager.cancel(id),
        },
        events: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        runs,
        refuseWrite: () => null,
        waitsForKeyChange: () => false,
        room: () =>
            call(
                'room',
                () =>
                    srv.editor ? { kind: 'shared' as const } : { kind: 'own' as const, free: 1e12 },
                forbidden,
            ),
        namesIn: (folder) => call('listing', () => srv.names(folder.id), forbidden),
        nextName: (name, taken) => {
            let given = name;
            for (let n = 2; taken.has(given); n++) given = `${name} (${n})`;
            return given;
        },
        makeFolder: async (parent, name, _signAs, minted) => {
            const id = `folder-${++folders}`;
            await minted(id);
            await call('folder', () => srv.createFolder(id, parent.id, name), forbidden);
            return srv.driveNode(id);
        },
        // As the web does: a finishing upload asked about again, about ten seconds.
        abortUpload: (_ws, id) =>
            askAbort(() => api.abortUpload('ws', id), { stillOn: () => true }),
        trash: async (_ws, ids) => {
            try {
                return await call(
                    'trash',
                    () => srv.trash(ids),
                    () => new Map(ids.map((id) => [id, 'refused' as const])),
                );
            } catch (error) {
                // As the web's trash does (deniedWhole): a 403 or 404 for the whole request.
                if (
                    error instanceof DriveApiError &&
                    (error.status === 403 || error.status === 404)
                )
                    return new Map(ids.map((id) => [id, 'denied' as const]));
                throw error;
            }
        },
        // As the Trash page's purgeBatch does: items left busy asked again while that helps.
        purge: async (_ws, ids) => {
            const fates = new Map<string, ItemFate>();
            let left = ids;
            try {
                for (let tries = 0; tries < 3 && left.length; tries++) {
                    const answer = await call(
                        'purge',
                        () => srv.purge(left),
                        () => new Map(left.map((id) => [id, 'refused' as const])),
                    );
                    for (const [id, fate] of answer) fates.set(id, fate);
                    left = left.filter((id) => fates.get(id) === 'refused');
                }
            } catch (error) {
                if (
                    error instanceof DriveApiError &&
                    (error.status === 403 || error.status === 404)
                )
                    for (const id of left) fates.set(id, 'denied');
                else throw error;
            }
            return fates;
        },
        // Only looks: how many items the folder holds, or null when it isn't there.
        lookFolder: (_ws, id) =>
            call(
                'lookup',
                () =>
                    srv.gone(id)
                        ? null
                        : [...srv.nodes.values()].filter(
                              (n) => n.parent === id && n.state !== 'purged',
                          ).length,
                forbidden,
            ),
        mayPurge: () =>
            call(
                'may-purge',
                () => !srv.editor,
                () => false,
            ),
        hold: async () => {
            await call('hold', () => undefined, forbidden);
            return () => {};
        },
        current: () => !state.dead && !state.signedOut,
        beatMs: 1e9,
    };
    return {
        deps,
        counts,
        state,
        disk,
        manager: h.manager,
        warm: (folderId: string) => lookUp(folderId, true, true),
        onInterrupt(hook: (fault: Fault) => void) {
            interrupt = hook;
        },
    };
}

type Scenario = {
    server?: { storeMs?: number; editor?: boolean; busy?: number; quota?: number };
    /* What happens on the server before the run (another client's save, a key change). */
    before?: (srv: Server, app: ReturnType<typeof processOf>) => Promise<void> | void;
    run: (run: SaveRun, srv: Server) => Promise<{ files: string[]; versions: VersionSaved[] }>;
    /* Whether a clean run finishes (a scenario that cancels by itself doesn't). */
    finishes: boolean;
};

const F = 'f';
const doc = (srv: Server, epoch = 1) => ({
    ...srv.driveNode('doc'),
    keyEpoch: epoch,
    currentVersion: { id: 'v1' } as DriveNode['currentVersion'],
});
const file = (run: SaveRun, srv: Server, name: string, into?: DriveNode) =>
    run.file({ name, bytes: bytes(), mime: null, ...own, into: into ?? srv.driveNode(F) });
const version = (run: SaveRun, srv: Server) =>
    run.version({
        file: doc(srv),
        folder: srv.driveNode(F),
        startedFrom: 'v1',
        bytes: bytes(),
        ...own,
    });

const SCENARIOS: Record<string, Scenario> = {
    'new files': {
        finishes: true,
        run: async (run, srv) => {
            const made = await Promise.all([file(run, srv, 'a'), file(run, srv, 'b')]);
            return { files: made.map((n) => n!.id), versions: [] };
        },
    },
    'a folder tree': {
        finishes: true,
        run: async (run, srv) => {
            const out = await run.folder('Out', { into: srv.driveNode(F), ...own });
            const inner = await file(run, srv, 'a', out);
            return { files: [out.id, inner!.id], versions: [] };
        },
    },
    'a new version': {
        finishes: true,
        run: async (run, srv) => ({ files: [], versions: [await version(run, srv)] }),
    },
    'an editor in someone else’s share': {
        server: { editor: true },
        finishes: true,
        run: async (run, srv) => {
            const made = await file(run, srv, 'a');
            return { files: [made!.id], versions: [] };
        },
    },
    'a race with another device, the listing warm': {
        finishes: true,
        // Another upload listed the folder a moment ago (shared for two seconds); then another device saved.
        before: async (srv, app) => {
            await app.warm(F);
            srv.nodes.get('doc')!.version = 'v2';
        },
        run: async (run, srv) => ({ files: [], versions: [await version(run, srv)] }),
    },
    'a key change, the version the same': {
        finishes: true,
        before: (srv) => {
            srv.nodes.get('doc')!.keyEpoch = 2;
        },
        run: async (run, srv) => ({ files: [], versions: [await version(run, srv)] }),
    },
    // Another device acts while the bytes go up: the completion is refused, and an attach (or a
    // stale version) follows.
    'another device re-keys the file mid-upload': {
        finishes: true,
        before: (srv) => {
            let once = true;
            srv.onPart(() => {
                if (once) srv.bumpKey('doc');
                once = false;
            });
        },
        run: async (run, srv) => ({ files: [], versions: [await version(run, srv)] }),
    },
    // The same as the server answers it (the completion names the version, still current), with
    // another upload having listed the folder moments before: the attach must look again, fresh,
    // or it seals under the old key the cached listing still holds.
    'another device re-keys the file mid-upload, the listing warm': {
        finishes: true,
        before: (srv, app) => {
            let once = true;
            srv.onPart(() => {
                if (!once) return;
                once = false;
                void app.warm(F).then(() => srv.bumpKey('doc'));
            });
        },
        run: async (run, srv) => ({ files: [], versions: [await version(run, srv)] }),
    },
    'another device re-keys the folder mid-upload': {
        finishes: true,
        before: (srv) => {
            let once = true;
            srv.onPart(() => {
                if (once) srv.bumpKey(F);
                once = false;
            });
        },
        run: async (run, srv) => {
            const made = await file(run, srv, 'a');
            return { files: [made!.id], versions: [] };
        },
    },
    'another device saves mid-upload': {
        finishes: true,
        before: (srv) => {
            let once = true;
            srv.onPart(() => {
                if (once) srv.othersSave();
                once = false;
            });
        },
        run: async (run, srv) => ({ files: [], versions: [await version(run, srv)] }),
    },
    // The room runs out part way: the second begin is 402, and the first file goes again.
    'room for one file only': {
        server: { quota: 1_500 },
        finishes: false,
        run: async (run, srv) => {
            await Promise.allSettled([file(run, srv, 'a'), file(run, srv, 'b')]);
            throw await run.cancel();
        },
    },
    // A workspace too busy to delete forever at first: the clean-up asks again.
    'a cancel in a busy workspace': {
        server: { busy: 2 },
        finishes: false,
        run: async (run, srv) => {
            await file(run, srv, 'a');
            await file(run, srv, 'b');
            throw await run.cancel();
        },
    },
    'a cancel while the store completes slowly': {
        server: { storeMs: 20_000 },
        finishes: false,
        run: async (run, srv) => {
            let both: () => void = () => {};
            let seen = 0;
            const completing = new Promise<void>((resolve) => {
                both = resolve;
            });
            srv.onCompleting(() => {
                if (++seen === 2) both();
            });
            const results = Promise.allSettled([version(run, srv), file(run, srv, 'a')]);
            // Once both completions are with the store (or the run ended some other way first).
            await Promise.race([completing, results]);
            await run.cancel();
            await results;
            return { files: [], versions: [] };
        },
    },
};

type Outcome =
    | { kind: 'finished'; files: string[]; versions: VersionSaved[] }
    | { kind: 'not-started' }
    | { kind: 'stopped'; stopped: RunStopped }
    | { kind: 'unrecorded' };

async function play(name: string, plan: Plan) {
    const scenario = SCENARIOS[name]!;
    const srv = serverOf(scenario.server ?? {});
    const disk = createMemoryRunJournal();
    const app = processOf(srv, disk, plan);
    await scenario.before?.(srv, app);
    const escaped: unknown[] = [];
    let run: SaveRun | null = null;
    app.onInterrupt((fault) => {
        if (fault === 'cancel') void run?.cancel();
        // The app's lock: every run stops and cleans up (drive-shell, lockSaveRuns).
        if (fault === 'lock') void lockRuns();
        // A sign-out: runs abandoned, the queue let go, the journal gone with the account.
        if (fault === 'signout') {
            app.state.signedOut = true;
            abandonRuns();
            void app.manager.releaseAll();
            disk.rows.clear();
        }
    });
    const settled = { done: false };
    const playing = (async (): Promise<Outcome> => {
        try {
            run = await startRun(app.deps, { targets: [srv.driveNode(F), doc(srv)], results: [] });
        } catch {
            return { kind: 'not-started' };
        }
        try {
            const made = await scenario.run(run, srv);
            await run.finish();
            return { kind: 'finished', ...made };
        } catch (error) {
            if (error instanceof RecordNotUpdated) return { kind: 'unrecorded' };
            if (error instanceof RunStopped) return { kind: 'stopped', stopped: error };
            escaped.push(error);
            return { kind: 'stopped', stopped: await run.cancel() };
        }
    })().finally(() => {
        settled.done = true;
    });
    for (let waited = 0; !settled.done && waited < SETTLE_MS; waited += 500)
        await vi.advanceTimersByTimeAsync(500);
    const outcome = settled.done
        ? await playing
        : ({
              kind: 'stopped',
              stopped: new RunStopped('failed', 'never ended', 'left'),
          } as Outcome);
    if (!settled.done) escaped.push(new Error('the run never ended'));
    // Whatever was on its way lands (a slow store, a retry) before anything is judged.
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    return { srv, disk, app, outcome, escaped };
}

/* The rule and the engine's own two, as violations (empty when they hold). */
async function violations(name: string, plan: Plan) {
    const { srv, disk, app, outcome, escaped } = await play(name, plan);
    const found = escaped.map((error) => `a failure escaped the run's stop: ${String(error)}`);
    const dead = app.state.dead;
    const rows = await disk.list();
    const named = new Set(rows.flatMap((row) => row.nodeIds));
    // A clean-up told it may only trash (an editor, or mayPurge saying so) leaves the Trash as is.
    const onlyTrashed = outcome.kind === 'stopped' && outcome.stopped.cleanup === 'trashed';
    const published = srv.published(!srv.editor && !onlyTrashed);
    const signedOut = app.state.signedOut;
    const message = outcome.kind === 'stopped' && !dead ? outcome.stopped.message : null;
    // "You'll be asked about it next time" promises a row; only "can no longer remove it", and a
    // sign-out's "may still be there" (its journal went with the account), excuse an unnamed node.
    const excused =
        (message?.includes('can no longer remove it') ?? false) ||
        (signedOut && (message?.includes('may still be there') ?? false));
    if (message) {
        const stopped = (outcome as { stopped: RunStopped }).stopped;
        if (message.includes('Nothing was saved') && (published.length || srv.versions()))
            found.push(
                `says nothing was saved; ${published.length} published, ${srv.versions()} versions`,
            );
        if (stopped.keptVersions > srv.versions())
            found.push(`says ${stopped.keptVersions} versions kept; ${srv.versions()} exist`);
        if (srv.versions() > stopped.keptVersions + stopped.uncertainVersions)
            found.push(
                `${srv.versions()} versions published, ${stopped.keptVersions + stopped.uncertainVersions} said`,
            );
    }
    // Finished for good: its row retired before anything else happened (a death after that changes nothing).
    if (outcome.kind === 'finished' && !rows.some((row) => !row.done)) {
        for (const id of outcome.files)
            if (!published.includes(id)) found.push(`a saved result ${id} isn't there`);
        for (const saved of outcome.versions) {
            const current = srv.nodes.get('doc')!.version;
            if (saved.status === 'stale' && current === 'v1')
                found.push('said stale, but nobody else saved');
            if (saved.status === 'stale' && saved.currentVersionId !== current)
                found.push(
                    `said stale naming ${saved.currentVersionId}, the server has ${current}`,
                );
        }
        if (name.startsWith('a race') && outcome.versions[0]?.status !== 'stale')
            found.push('a real race was not said stale');
        if (srv.othersSaved() && outcome.versions.some((saved) => saved.status !== 'stale'))
            found.push('another device’s version was saved over');
        abandonRuns();
        const finishedOpen = processOf(srv, disk, null);
        const listing = interruptedRuns({ ...finishedOpen.deps, isLive: async () => false });
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        if ((await listing).length) found.push('a finished save is offered for deletion');
        const settling = quietlySettled();
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        await settling;
    } else if (signedOut) {
        // The journal went with the account: what is there must have been said to remain.
        if (!dead && !excused)
            for (const id of published)
                found.push(`${id} is there after a sign-out that didn't say so`);
    } else {
        if (name.startsWith('a race') && outcome.kind === 'stopped' && !dead && plan === null)
            found.push(`a real race ended as a failure: ${outcome.stopped.message}`);
        for (const id of published)
            if (!srv.lineage(id).some((at) => named.has(at)) && !excused)
                found.push(
                    `${id} is published, named by no row${message ? ` (said: ${message})` : ''}`,
                );
        // The next open, from the journal alone, on a working network.
        abandonRuns();
        const reopen = async () => {
            const reopened = processOf(srv, disk, null);
            const listing = interruptedRuns({ ...reopened.deps, isLive: async () => false });
            await vi.advanceTimersByTimeAsync(SETTLE_MS);
            const settling = quietlySettled();
            await vi.advanceTimersByTimeAsync(SETTLE_MS);
            await settling;
            for (const row of await listing) {
                const cleaning = cleanUpInterrupted(reopened.deps, row);
                await vi.advanceTimersByTimeAsync(SETTLE_MS);
                await cleaning;
            }
        };
        await reopen();
        for (const id of srv.published(!srv.editor && !onlyTrashed))
            if (!excused) found.push(`${id} is still there after the next open's clean-up`);
        // Only a folder whose creation may still land keeps its row past that open; once the
        // creation window has passed, the open after settles it.
        for (const row of await disk.list())
            if (
                row.uploadIds.length ||
                !row.nodeIds.every((id) => row.uncertain?.some((held) => held.id === id))
            )
                found.push('a row survived the next open’s clean-up');
        vi.setSystemTime(Date.now() + CREATION_SETTLE_MS);
        await reopen();
        if ((await disk.list()).length) found.push('a row survived past the creation window');
        // Access lost (the share ended): nothing more is this person's to abort; the expiry's.
        const known = app.state.revoked
            ? []
            : srv
                  .openReservations()
                  .filter((id) => srv.recorded.has(id) && !srv.lostBegins.has(id));
        if (known.length) found.push(`reservations left open: ${known.join(', ')}`);
    }
    return found;
}

/* A fixed-seed sample of the waits: every point and fault at its first reach, and two more reaches each. */
function sample(counts: Map<Point, number>, seed: number) {
    let state = seed;
    const random = () => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        return state / 2_147_483_648;
    };
    const plans: Exclude<Plan, null>[] = [];
    for (const [point, faults] of Object.entries(FAULTS) as [Point, Fault[]][]) {
        const reached = Math.max(
            1,
            counts.get(point) ?? 0,
            ['abort', 'trash', 'purge', 'journal-remove', 'may-purge'].includes(point) ? 3 : 0,
        );
        for (const fault of faults) {
            plans.push({ point, k: 1, fault });
            for (let more = 0; more < 2 && reached > 1; more++)
                plans.push({ point, k: 2 + Math.floor(random() * (reached - 1)), fault });
        }
    }
    return plans;
}

describe(
    'the save path over the real upload engine, failing every wait',
    { timeout: 600_000 },
    () => {
        for (const [name, scenario] of Object.entries(SCENARIOS))
            test(`${name}: the rule holds, and stale means a real race`, async () => {
                const clean = await play(name, null);
                expect(clean.outcome.kind).toBe(scenario.finishes ? 'finished' : 'stopped');
                // A key change mid-upload is met where it is: the bytes attached under the keys found.
                if (name.includes('re-keys'))
                    expect(clean.app.counts.get('attach')).toBeGreaterThan(0);
                expect(await violations(name, null)).toEqual([]);
                const failures: string[] = [];
                for (const plan of sample(clean.app.counts, 7))
                    for (const found of await violations(name, plan))
                        failures.push(`${plan.point} #${plan.k} ${plan.fault}: ${found}`);
                expect(failures).toEqual([]);
            });
    },
);
