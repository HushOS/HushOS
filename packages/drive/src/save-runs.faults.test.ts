import { describe, expect, test } from 'vitest';
import { DriveApiError, type NodeView } from './api';
import type { DriveNode } from './client';
import { createMemoryRunJournal, type RunJournal } from './journal';
import {
    OWN_WRITING,
    RecordNotUpdated,
    RunStopped,
    abandonRuns,
    CREATION_SETTLE_MS,
    cleanUpInterrupted,
    interruptedRuns,
    quietlySettled,
    startRun,
    type ItemFate,
    type SaveRun,
    type SaveRunDeps,
} from './save-runs';
import type { EnqueueInput, TransferManagerOptions, UploadItem } from './transfers';

/*
 * The save path's one rule, checked by breaking it everywhere: a run is driven
 * against a server that records everything it publishes and every reservation,
 * and each of the run's waits (a listing, a folder's creation, a begin, a part,
 * a completion, an attach, a journal write or removal, an abort, a trash, a
 * purge) is made to fail in turn: no network, an answer lost after the server
 * acted, a refusal, a full disk, or the process dying there. After each:
 *
 * - everything the server published is named by a row that survived, or
 *   counted in what the run said it kept, or said to be what may remain;
 * - nothing the journal offers for deletion is a save that finished;
 * - the next open, from the journal alone, removes everything of a run that
 *   did not finish, and aborts every reservation it knew of.
 *
 * The waits come from the table below and the run's own calls: a new wait is
 * covered by adding its name. Process death is everything failing from that
 * point: nothing more reaches the server or the disk.
 */

type Point =
    | 'listing'
    | 'folder'
    | 'begin'
    | 'part'
    | 'complete'
    | 'attach'
    | 'journal-put'
    | 'journal-remove'
    | 'abort'
    | 'trash'
    | 'purge';
/*
 * `crash`: the server (or the disk) acts, then the process dies before hearing. `outage`: the
 * network goes for good while the process lives on (its clean-up meets it too). `cancel`,
 * `signout`, `lock`: the person cancels, signs out (the journal goes with the account), or the
 * device locks just as that wait is reached.
 */
type Fault =
    | 'network'
    | 'lost'
    | 'refused'
    | 'full'
    | 'death'
    | 'crash'
    | 'outage'
    | 'cancel'
    | 'signout'
    | 'lock';

const PEOPLE: Fault[] = ['cancel', 'signout', 'lock'];
const FAULTS: Record<Point, Fault[]> = {
    listing: ['network', 'refused', 'death', 'outage', ...PEOPLE],
    folder: ['network', 'lost', 'refused', 'death', 'crash', 'outage', ...PEOPLE],
    begin: ['network', 'lost', 'refused', 'death', 'crash', 'outage', ...PEOPLE],
    part: ['network', 'death', 'outage', ...PEOPLE],
    complete: ['network', 'lost', 'refused', 'death', 'crash', 'outage', ...PEOPLE],
    attach: ['network', 'lost', 'refused', 'death', 'crash', 'outage', ...PEOPLE],
    'journal-put': ['refused', 'full', 'death', 'crash', ...PEOPLE],
    'journal-remove': ['refused', 'full', 'death', 'crash', ...PEOPLE],
    abort: ['network', 'lost', 'refused', 'death', 'crash', 'outage', ...PEOPLE],
    trash: ['network', 'lost', 'refused', 'death', 'crash', 'outage', ...PEOPLE],
    purge: ['network', 'lost', 'refused', 'death', 'crash', 'outage', ...PEOPLE],
};

type Plan = { point: Point; k: number; fault: Fault } | null;
type TransferEvent = Parameters<NonNullable<TransferManagerOptions['onEvent']>>[0];

const own = { sources: OWN_WRITING } as const;
const bytes = () => new Uint8Array(1);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() {
    for (let i = 0; i < 12; i++) await tick();
}

function folderNode(id: string, parentId: string | null = 'root'): DriveNode {
    return {
        id,
        workspaceId: 'ws',
        parentId,
        kind: 'folder',
        keyEpoch: 1,
        name: id,
        currentVersion: null,
        metadata: { name: id, mime: null, size: null, modified: null },
    } as unknown as DriveNode;
}
const F = folderNode('f');
const DOC = { ...folderNode('doc', 'f'), kind: 'file', currentVersion: { id: 'v1' } } as DriveNode;

/* What the server holds: nodes it published, versions it completed, every reservation. */
function server() {
    const nodes = new Map<
        string,
        { state: 'live' | 'trash' | 'purged'; parent: string; name: string }
    >();
    const uploads = new Map<
        string,
        {
            status: 'open' | 'completed' | 'aborted';
            nodeId: string;
            version: boolean;
            parent: string;
        }
    >();
    /* Reservations whose begin answer was lost: no client could know their id (the expiry's). */
    const lostBegins = new Set<string>();
    /* Reservations some row on disk named at some point: the journal knew of them. */
    const recorded = new Set<string>();
    let next = 0;
    return {
        nodes,
        uploads,
        lostBegins,
        recorded,
        begin(nodeId: string, version: boolean, parent: string) {
            const id = `up-${++next}`;
            uploads.set(id, { status: 'open', nodeId, version, parent });
            return id;
        },
        complete(uploadId: string, nodeId?: string) {
            const upload = uploads.get(uploadId)!;
            if (upload.status !== 'open') throw new DriveApiError('gone', 'not-found', 404);
            upload.status = 'completed';
            if (nodeId) upload.nodeId = nodeId;
            if (!upload.version)
                nodes.set(upload.nodeId, {
                    state: 'live',
                    parent: upload.parent,
                    name: upload.nodeId,
                });
            return upload.nodeId;
        },
        abort(uploadId: string) {
            const upload = uploads.get(uploadId);
            if (!upload) return 'gone' as const;
            if (upload.status === 'completed') return 'finished' as const;
            upload.status = 'aborted';
            return 'aborted' as const;
        },
        create(id: string, parent: string, name: string) {
            nodes.set(id, { state: 'live', parent, name });
        },
        names(parent: string) {
            return [...nodes.values()]
                .filter((n) => n.parent === parent && n.state === 'live')
                .map((n) => n.name);
        },
        trash(ids: string[]) {
            const fates = new Map<string, ItemFate>();
            for (const id of ids) {
                const node = nodes.get(id);
                if (!node || node.state === 'purged') fates.set(id, 'gone');
                else {
                    node.state = 'trash';
                    fates.set(id, 'done');
                }
            }
            return fates;
        },
        purge(ids: string[]) {
            const fates = new Map<string, ItemFate>();
            for (const id of ids) {
                const node = nodes.get(id);
                if (node?.state === 'trash') {
                    node.state = 'purged';
                    fates.set(id, 'done');
                } else fates.set(id, 'gone');
            }
            return fates;
        },
        /* Deleted forever with a folder above it: a folder goes with everything inside. */
        gone(id: string): boolean {
            const node = nodes.get(id);
            if (!node) return true;
            if (node.state === 'purged') return true;
            return nodes.has(node.parent) ? this.gone(node.parent) : false;
        },
        /* New files and folders still there (live, or in the Trash and not deleted forever). */
        published() {
            return [...nodes.keys()].filter((id) => !this.gone(id));
        },
        /* `id` or a folder above it. */
        lineage(id: string) {
            const out: string[] = [];
            for (let at: string | undefined = id; at; at = nodes.get(at)?.parent) out.push(at);
            return out;
        },
        versions() {
            return [...uploads.values()].filter((u) => u.version && u.status === 'completed')
                .length;
        },
        openReservations() {
            return [...uploads.entries()].filter(([, u]) => u.status === 'open').map(([id]) => id);
        },
    };
}

/*
 * One process of the app over the server and the journal (the disk): every call
 * counted by its wait, the planned one failing as planned. A dead process
 * reaches nothing.
 */
function processOf(
    srv: ReturnType<typeof server>,
    disk: ReturnType<typeof createMemoryRunJournal>,
    plan: Plan,
) {
    const counts = new Map<Point, number>();
    const state = { dead: false, full: false, outage: false, signedOut: false };
    let interrupt: (fault: Fault) => void = () => {};
    function faultAt(point: Point) {
        const k = (counts.get(point) ?? 0) + 1;
        counts.set(point, k);
        const fault = plan && plan.point === point && plan.k === k ? plan.fault : null;
        if (fault === 'death') state.dead = true;
        if (fault === 'full') state.full = true;
        if (fault === 'outage') state.outage = true;
        if (fault && PEOPLE.includes(fault)) interrupt(fault);
        return fault;
    }
    async function call<T>(point: Point, effect: () => T, refusal: () => T): Promise<T> {
        await Promise.resolve();
        const fault = faultAt(point);
        if (state.dead || state.outage || fault === 'network')
            throw new TypeError('Failed to fetch');
        if (fault === 'refused') return refusal();
        const result = effect();
        if (fault === 'lost' || fault === 'crash') {
            if (fault === 'crash') state.dead = true;
            if (point === 'begin') srv.lostBegins.add(result as string);
            throw new TypeError('Failed to fetch');
        }
        return result;
    }
    async function write(point: Point, apply: () => Promise<void>) {
        await Promise.resolve();
        const fault = faultAt(point);
        if (state.dead || state.full || fault === 'refused')
            throw new DOMException('refused', 'QuotaExceededError');
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

    /* The upload queue, as the engine drives a produced result. */
    const listeners = new Set<(event: TransferEvent) => void>();
    const emit = (event: TransferEvent) => {
        for (const listener of listeners) listener(event);
    };
    const held = new Map<
        string,
        { input: EnqueueInput; item: UploadItem; uploadId: string | null; over: boolean }
    >();
    let items = 0;
    let folders = 0;
    const refuse = () => {
        throw new DriveApiError('refused', 'invalid', 400);
    };
    async function drive(id: string) {
        const h = held.get(id)!;
        const produced = h.input.produced!;
        const end = (type: 'done' | 'failed', patch: Partial<UploadItem>) => {
            if (h.over) return;
            h.over = true;
            Object.assign(h.item, { status: type, ...patch });
            emit({ type, item: h.item });
        };
        try {
            await tick();
            if (h.over || state.signedOut) return;
            const version = Boolean(h.input.replaces);
            const nodeId = h.input.replaces?.id ?? `node-${id}`;
            const uploadId = await call(
                'begin',
                () => srv.begin(nodeId, version, h.input.parent.id),
                refuse,
            );
            // Cancelled while it began: the engine aborts what it reserved.
            if (h.over)
                return void (await call(
                    'abort',
                    () => srv.abort(uploadId),
                    () => 'denied',
                ).catch(() => {}));
            h.uploadId = uploadId;
            produced.onBegun?.({ workspaceId: 'ws', uploadId, nodeId });
            for (let part = 1; part <= 2; part++) {
                await call('part', () => undefined, refuse);
                if (h.over) return;
            }
            await produced.beforeComplete?.();
            if (h.over) return;
            let landed: string;
            if (h.input.name?.startsWith('rekey')) {
                // Its folder's key moved while it went up: the completion is refused and the
                // bytes attached as a node of their own.
                await call('complete', () => undefined, refuse);
                const sibling = `${nodeId}-attached`;
                await produced.onAttach?.({ workspaceId: 'ws', nodeId: sibling });
                if (h.over) return;
                landed = await call('attach', () => srv.complete(uploadId, sibling), refuse);
            } else landed = await call('complete', () => srv.complete(uploadId), refuse);
            end('done', { node: { id: landed } as NodeView });
        } catch (error) {
            end('failed', {
                error: error instanceof Error ? error.message : 'failed',
                errorCode: error instanceof DriveApiError ? error.code : null,
            });
        }
    }
    const deps: SaveRunDeps = {
        transfers: {
            enqueue: (inputs) =>
                inputs.map((input) => {
                    const id = `item-${++items}`;
                    const item = {
                        id,
                        name: input.name ?? input.file.name,
                        status: 'queued',
                        error: null,
                        errorCode: null,
                        node: null,
                    } as unknown as UploadItem;
                    held.set(id, { input, item, uploadId: null, over: false });
                    void drive(id);
                    return id;
                }),
            cancel: async (id) => {
                const h = held.get(id);
                if (!h || h.over) return;
                h.over = true;
                h.item.status = 'cancelled';
                emit({ type: 'cancelled', item: h.item });
                // The engine aborts what it reserved, as best it can.
                if (h.uploadId)
                    await call(
                        'abort',
                        () => srv.abort(h.uploadId!),
                        () => 'denied',
                    ).catch(() => {});
            },
        },
        events: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        runs,
        refuseWrite: () => null,
        waitsForKeyChange: () => false,
        room: async () => ({ kind: 'own', free: 1e12 }),
        namesIn: (parent) => call('listing', () => srv.names(parent.id), refuse),
        nextName: (name, taken) => {
            let given = name;
            for (let n = 2; taken.has(given); n++) given = `${name} (${n})`;
            return given;
        },
        makeFolder: async (parent, name, _signAs, minted) => {
            const id = `folder-${++folders}`;
            await minted(id);
            await call('folder', () => srv.create(id, parent.id, name), refuse);
            return folderNode(id, parent.id);
        },
        abortUpload: async (_ws, uploadId) => {
            try {
                return await call(
                    'abort',
                    () => srv.abort(uploadId),
                    () => 'denied' as const,
                );
            } catch {
                return 'unknown';
            }
        },
        // Only looks: how many items the folder holds, or null when it isn't there.
        lookFolder: (_ws, id) =>
            call(
                'listing',
                () =>
                    srv.gone(id)
                        ? null
                        : [...srv.nodes.values()].filter(
                              (n) => n.parent === id && n.state !== 'purged',
                          ).length,
                refuse,
            ),
        trash: (_ws, ids) =>
            call(
                'trash',
                () => srv.trash(ids),
                () => new Map(ids.map((id) => [id, 'refused' as const])),
            ),
        purge: (_ws, ids) =>
            call(
                'purge',
                () => srv.purge(ids),
                () => new Map(ids.map((id) => [id, 'refused' as const])),
            ),
        mayPurge: async () => true,
        current: () => !state.dead && !state.signedOut,
        beatMs: 1e9,
    };
    return {
        deps,
        counts,
        state,
        onInterrupt(hook: (fault: Fault) => void) {
            interrupt = hook;
        },
        /* The device locked: the worker and its keys go, and each upload still on its way hears so. */
        lock() {
            for (const h of held.values())
                if (!h.over) {
                    h.over = true;
                    h.item.status = 'paused';
                    emit({ type: 'locked', item: h.item });
                }
        },
        /* A sign-out: the queue lets every upload go, and the journal goes with the account. */
        signOut() {
            state.signedOut = true;
            for (const h of held.values()) h.over = true;
            disk.rows.clear();
        },
    };
}

/* Representative runs: several new files, a folder tree, a new version, and a mix (an attach among them). */
/* Each returns the new files and folders it was given, and how many new versions were saved. */
type Made = { nodes: string[]; versions: number };
const ids = (made: (NodeView | DriveNode | null)[]) => made.map((n) => n!.id);
const SCENARIOS: Record<string, (run: SaveRun) => Promise<Made>> = {
    'several new files': async (run) => ({
        nodes: ids(
            await Promise.all(
                ['a', 'b', 'c'].map((name) =>
                    run.file({ name, bytes: bytes(), mime: null, ...own }),
                ),
            ),
        ),
        versions: 0,
    }),
    'a folder tree': async (run) => {
        const out = await run.folder('Out', own);
        const inner = await run.folder('Inner', { into: out, ...own });
        const a = await run.file({ name: 'a', bytes: bytes(), mime: null, into: inner, ...own });
        const b = await run.file({ name: 'b', bytes: bytes(), mime: null, into: out, ...own });
        return { nodes: ids([out, inner, a, b]), versions: 0 };
    },
    'a new version': async (run) => {
        const saved = await run.version({
            file: DOC,
            folder: F,
            startedFrom: 'v1',
            bytes: bytes(),
            ...own,
        });
        return { nodes: [], versions: saved.status === 'saved' ? 1 : 0 };
    },
    'a mix': async (run) => {
        const out = await run.folder('Out', own);
        const [saved, a, b] = await Promise.all([
            run.version({ file: DOC, folder: F, startedFrom: 'v1', bytes: bytes(), ...own }),
            run.file({ name: 'rekey-a', bytes: bytes(), mime: null, ...own }),
            run.file({ name: 'b', bytes: bytes(), mime: null, into: out, ...own }),
        ]);
        return { nodes: ids([out, a, b]), versions: saved.status === 'saved' ? 1 : 0 };
    },
};

type Outcome =
    | { kind: 'finished'; made: Made }
    | { kind: 'not-started' }
    | { kind: 'stopped'; stopped: RunStopped }
    | { kind: 'unrecorded' };

async function play(scenario: string, plan: Plan) {
    const srv = server();
    const disk = createMemoryRunJournal();
    const app = processOf(srv, disk, plan);
    let outcome: Outcome;
    const escaped: unknown[] = [];
    let run: SaveRun | null = null;
    app.onInterrupt((fault) => {
        if (fault === 'cancel') void run?.cancel();
        if (fault === 'lock') app.lock();
        if (fault === 'signout') {
            app.signOut();
            abandonRuns();
        }
    });
    try {
        run = await startRun(app.deps, { targets: [F, DOC], results: [] });
    } catch {
        outcome = { kind: 'not-started' };
    }
    if (run) {
        try {
            const made = await SCENARIOS[scenario]!(run);
            await run.finish();
            outcome = { kind: 'finished', made };
        } catch (error) {
            if (error instanceof RecordNotUpdated) outcome = { kind: 'unrecorded' };
            else if (error instanceof RunStopped) outcome = { kind: 'stopped', stopped: error };
            else {
                // A failure that never went through the run's stop: the rule broken.
                escaped.push(error);
                outcome = { kind: 'stopped', stopped: await run.cancel() };
            }
        }
    }
    await settle();
    return { srv, disk, app, outcome: outcome!, escaped };
}

/* The invariant, as violations (empty when it holds). */
async function violations(scenario: string, plan: Plan) {
    const { srv, disk, app, outcome, escaped } = await play(scenario, plan);
    const found: string[] = escaped.map(
        (error) => `a failure escaped the run's stop: ${String(error)}`,
    );
    const rows = await disk.list();
    const named = new Set(rows.flatMap((row) => row.nodeIds));
    const published = srv.published();
    // A process that died said nothing, whatever its code went on to do: only its journal and
    // the server speak for it.
    const dead = app.state.dead;
    const signedOut = app.state.signedOut;
    const message = outcome.kind === 'stopped' && !dead ? outcome.stopped.message : null;
    // "You'll be asked about it next time" promises a row the next open removes it by; only
    // "can no longer remove it", and a sign-out's "may still be there", excuse an unnamed node.
    const excused =
        (message?.includes('can no longer remove it') ?? false) ||
        (signedOut && (message?.includes('may still be there') ?? false));
    if (message && outcome.kind === 'stopped') {
        const { keptVersions, uncertainVersions } = outcome.stopped;
        // Never claiming more than is so.
        if (message.includes('Nothing was saved') && (published.length || srv.versions()))
            found.push(
                `says nothing was saved: ${published.length} there, ${srv.versions()} versions`,
            );
        if (message.includes('Nothing else was saved') && published.length)
            found.push(`says nothing else was saved: ${published.join(', ')} there`);
        if (keptVersions > srv.versions())
            found.push(`says ${keptVersions} versions kept, ${srv.versions()} exist`);
        if (srv.versions() > keptVersions + uncertainVersions)
            found.push(
                `${srv.versions()} versions published, ${keptVersions + uncertainVersions} said`,
            );
    }
    // The next open is a new process: nothing of this one's runs is live there.
    abandonRuns();
    // Finished for good: its row retired before anything else happened (a death after that changes nothing).
    if (outcome.kind === 'finished' && !rows.length) {
        for (const id of outcome.made.nodes)
            if (!published.includes(id)) found.push(`a saved result ${id} isn't there`);
        if (srv.versions() < outcome.made.versions) found.push('a saved version is not there');
        const reopened = processOf(srv, disk, null);
        const offered = await interruptedRuns({ ...reopened.deps, isLive: async () => false });
        await quietlySettled();
        if (offered.length) found.push('a finished save is offered for deletion');
    } else if (signedOut) {
        // The journal went with the account: only what it said may remain may be there.
        for (const id of published)
            if (!excused && !dead) found.push(`${id} is there after a sign-out that didn't say so`);
    } else {
        // Named by a row itself, or inside a folder a row names (it goes with that folder).
        for (const id of published)
            if (!srv.lineage(id).some((at) => named.has(at)) && !excused)
                found.push(
                    `${id} is published, named by no row${message ? ` (said: ${message})` : ''}`,
                );
        // The next open, from the journal alone, on a working network.
        let clock = Date.now();
        const reopen = async () => {
            const reopened = processOf(srv, disk, null);
            reopened.deps.now = () => clock;
            const offered = await interruptedRuns({ ...reopened.deps, isLive: async () => false });
            await quietlySettled();
            for (const row of offered) await cleanUpInterrupted(reopened.deps, row);
            await settle();
        };
        await reopen();
        for (const id of srv.published())
            if (!excused) found.push(`${id} is still there after the next open's clean-up`);
        // Only a folder whose creation may still land keeps its row past that open; once the
        // creation window has passed, the open after settles it.
        for (const row of await disk.list())
            if (
                row.uploadIds.length ||
                !row.nodeIds.every((id) => row.uncertain?.some((held) => held.id === id))
            )
                found.push('a row survived the next open’s clean-up');
        clock += CREATION_SETTLE_MS;
        await reopen();
        if ((await disk.list()).length) found.push('a row survived past the creation window');
    }
    // A reservation no row ever named (its begin's answer lost, or the process gone before its
    // row was written) is the server's expiry's: nothing is published from it, since no
    // completion is sent before its row is on disk.
    const known = srv
        .openReservations()
        .filter((id) => srv.recorded.has(id) && !srv.lostBegins.has(id));
    if ((outcome.kind !== 'finished' || rows.length) && !signedOut && known.length)
        found.push(`reservations left open: ${known.join(', ')}`);
    return found;
}

describe('the save path under failure at every wait', { timeout: 120_000 }, () => {
    for (const scenario of Object.keys(SCENARIOS))
        test(`${scenario}: whatever fails, nothing published is unaccounted for and nothing saved is offered for deletion`, async () => {
            // A clean run first: how often it reaches each wait, so each one is failed in turn.
            const clean = await play(scenario, null);
            expect(clean.outcome.kind).toBe('finished');
            expect(await violations(scenario, null)).toEqual([]);
            const counts = new Map(clean.app.counts);
            // The clean-up's waits (abort, trash, purge) are only reached once something fails:
            // tried a few times each, with a failure earlier that brings them on.
            for (const point of ['abort', 'trash', 'purge', 'journal-remove'] as const)
                counts.set(point, Math.max(counts.get(point) ?? 0, 3));
            const failures: string[] = [];
            let tried = 0;
            for (const [point, faults] of Object.entries(FAULTS) as [Point, Fault[]][])
                for (let k = 1; k <= (counts.get(point) ?? 0); k++)
                    for (const fault of faults) {
                        tried++;
                        for (const found of await violations(scenario, { point, k, fault }))
                            failures.push(`${point} #${k} ${fault}: ${found}`);
                    }
            expect(tried).toBeGreaterThan(20);
            expect(failures).toEqual([]);
        });

    test('a cancel during the clean-up’s waits keeps the rule too', async () => {
        // A run cancelled once every result began, then each clean-up wait failed in turn.
        const failures: string[] = [];
        for (const [point, faults] of Object.entries(FAULTS) as [Point, Fault[]][])
            for (let k = 1; k <= 3; k++)
                for (const fault of faults) {
                    const srv = server();
                    const disk = createMemoryRunJournal();
                    const app = processOf(srv, disk, { point, k, fault });
                    let run: SaveRun;
                    try {
                        run = await startRun(app.deps, { targets: [F, DOC], results: [] });
                    } catch {
                        continue;
                    }
                    const results = SCENARIOS['a mix']!(run).catch(() => {});
                    for (let i = 0; i < 6; i++) await tick();
                    const stopped = await run.cancel();
                    await results;
                    await settle();
                    const named = new Set((await disk.list()).flatMap((row) => row.nodeIds));
                    // Only "can no longer remove it" (or a sign-out's "may still be there") excuses an
                    // unnamed node; "you'll be asked about it next time" promises a row naming it.
                    const message = app.state.dead ? '' : stopped.message;
                    const excused =
                        message.includes('can no longer remove it') ||
                        (app.state.signedOut && message.includes('may still be there'));
                    for (const id of srv.published())
                        if (!srv.lineage(id).some((at) => named.has(at)) && !excused)
                            failures.push(
                                `${point} #${k} ${fault}: ${id} unaccounted for after a cancel`,
                            );
                    if (
                        !app.state.dead &&
                        srv.versions() > stopped.keptVersions + stopped.uncertainVersions
                    )
                        failures.push(`${point} #${k} ${fault}: a version published and not said`);
                }
        expect(failures).toEqual([]);
    });
});
