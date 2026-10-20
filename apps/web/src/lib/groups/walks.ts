import type { SpaceList } from './api';
import type { AreaState } from './sync';

/*
 * The rules a family folder's walk runs by (1c step 7), kept free of the
 * Drive clients so they are tested on their own (walks.test.ts).
 */

/*
 * Whether this device has its own reason to walk the rotation route 25 names
 * in a folder, in the background: it is a roster rotation of the folder (the
 * member list moved the folder to a new key and re-keyed its top folder at
 * the walk's target), which the device saw for itself, since the top folder
 * opened here under the folder's latest key with that very key epoch (bound
 * in its envelope). Any other run the server names (a holder's Drive walk of
 * a subtree, or one the server made up) is walked only when a call of this
 * device met it (409 rotating) or a removal finishes it, never on the
 * server's word alone. A walk no longer signs anyone's record as the
 * walker's (re-keyed records keep each writer's), but it still re-seals only
 * the shares and links the walker's own sharing ledger records and closes the
 * rest, so walking someone else's run would close what their ledger keeps.
 */
export function ownReasonToWalk(state: Pick<AreaState, 'opened' | 'rootListed' | 'view'>) {
    const { rotation, root } = state.view;
    return Boolean(
        rotation &&
        root &&
        state.opened &&
        state.rootListed &&
        rotation.nodeId === root.id &&
        rotation.targetEpoch === root.keyEpoch,
    );
}

/* Whether route 25 still lists the run as the folder's running one. */
export function stillRunning(
    spaces: SpaceList,
    groupId: string,
    run: { workspaceId: string; rotationId: string | null; nodeId: string; targetEpoch: number },
) {
    for (const space of spaces) {
        if (space.space.kind !== 'group' || space.space.groupId !== groupId) continue;
        for (const area of space.areas) {
            if (area.workspaceId !== run.workspaceId) continue;
            const rotation = area.rotation;
            if (!rotation) return false;
            return run.rotationId
                ? rotation.id === run.rotationId
                : rotation.nodeId === run.nodeId && rotation.targetEpoch === run.targetEpoch;
        }
    }
    // The folder is not listed at all: no run of it is this device's to finish.
    return false;
}

/*
 * Walks a run to its end. A 404 counts as the run having ended elsewhere
 * (another tab, device or manager finished it) only once route 25 says it is
 * no longer running; any other 404 (a node that will not list, access that
 * ended) is the walk failing, said as such and tried again later, never
 * counted as finished.
 */
export async function walkToEnd(deps: {
    walk(): Promise<unknown>;
    running(): Promise<boolean>;
}): Promise<'walked' | 'ended-elsewhere'> {
    try {
        await deps.walk();
        return 'walked';
    } catch (error) {
        if ((error as { status?: number } | null)?.status === 404 && !(await deps.running()))
            return 'ended-elsewhere';
        throw error;
    }
}

/*
 * How long to leave a run before walking it, or checking for it, again: after
 * each walk of the same run that ended (said it finished, or failed) and each
 * poll that still finds one, twice as long, from `base`, never more than
 * `cap`. A run that keeps coming back (a server that never closes it, a node
 * that never lists) costs a request every few minutes, not every few seconds.
 */
export function backoffDelay(attempts: number, base = 30_000, cap = 10 * 60_000) {
    return Math.min(cap, base * 2 ** Math.max(0, attempts - 1));
}

/*
 * How long a family page waits before checking a running key change again: `base` at first,
 * then twice as long for each doubling of the time it has been found running, never more than
 * `cap`. A function of the clock alone: TanStack Query asks a query's `refetchInterval` on every
 * render and every update of the query, so a count kept there moved with renders, and a page
 * that rendered often (a storage figure refreshed, a dialog) pushed its next check out to ten
 * minutes while a walk waited on it.
 */
export function walkPollDelay(walkingSince: number, now: number, base: number, cap = 10 * 60_000) {
    const elapsed = Math.max(0, now - walkingSince);
    return Math.min(cap, base * 2 ** Math.floor(Math.log2(elapsed / base + 1)));
}

/*
 * The clock the retries run by. Monotonic by default (performance.now), so a wall-clock step
 * (a laptop waking, the time zone or NTP moving it) never strands a wait.
 */
export type WalkClock = {
    now: () => number;
    schedule: (run: () => void, ms: number) => unknown;
    cancel: (handle: unknown) => void;
};
const systemClock: WalkClock = {
    now: () => performance.now(),
    schedule: (run, ms) => setTimeout(run, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/*
 * What a failed walk does to its run's next wait:
 * - `counted`: one more attempt, so the wait grows (backoffDelay);
 * - `progressed`: it re-keyed something before it stopped, so the wait starts over (a slow
 *   server never pushes a walk that is getting somewhere out to the cap);
 * - `offline`: the device is offline, so nothing is counted and no timer runs; it is walked
 *   again when the device is back online (`online`);
 * - `gone`: the account locked or signed out (or someone else unlocked), so the run is
 *   forgotten, nothing counted: the next unlocked sync walks it at once.
 */
export type WalkFailure = 'counted' | 'progressed' | 'offline' | 'gone';

const RETRY_CAP_MS = 10 * 60_000;

/*
 * When this tab walks each key change run again (keyed by folder and run). A walk that ended
 * leaves the run alone for backoffDelay of its attempts so far, give or take a fifth (so tabs
 * and devices that failed together don't all come back together); one that failed is also
 * tried again at the end of that wait, on a timer of its own: never only "at the next sync",
 * whose timing pages and renders decide. Asking whether a run is due, or syncing, any number
 * of times meanwhile moves nothing.
 */
export function walkRetries(clock: WalkClock = systemClock, random: () => number = Math.random) {
    type Entry = { attempts: number; until: number; timer: unknown; retry: (() => void) | null };
    const runs = new Map<string, Entry>();
    const inFlight = new Set<string>();
    // Bumped by clear(): a walk that settles after it (signed out meanwhile) leaves nothing.
    let generation = 0;
    const stop = (entry: Entry | undefined) => {
        if (entry?.timer === undefined) return;
        clock.cancel(entry.timer);
        entry.timer = undefined;
    };
    /*
     * A walk of the run ended: well (no `retry`), or it failed and `retry` runs once the wait
     * is over. Returns the wait, or null when there is none (offline, or forgotten).
     */
    function ended(
        key: string,
        options: { retry?: () => void; failure?: WalkFailure } = {},
    ): number | null {
        const previous = runs.get(key);
        stop(previous);
        const failure = options.failure ?? 'counted';
        if (failure === 'gone') {
            runs.delete(key);
            return null;
        }
        const before = failure === 'progressed' ? 0 : (previous?.attempts ?? 0);
        if (failure === 'offline') {
            runs.set(key, {
                attempts: before,
                until: clock.now(),
                timer: undefined,
                retry: options.retry ?? null,
            });
            return null;
        }
        const attempts = before + 1;
        const delay = Math.min(
            RETRY_CAP_MS,
            Math.round(backoffDelay(attempts, 30_000, RETRY_CAP_MS) * (0.8 + 0.4 * random())),
        );
        const entry: Entry = {
            attempts,
            until: clock.now() + delay,
            timer: undefined,
            retry: options.retry ?? null,
        };
        const retry = options.retry;
        if (retry)
            entry.timer = clock.schedule(() => {
                entry.timer = undefined;
                // The wait is over, whatever the clock reads now: the retry walks.
                entry.until = -Infinity;
                retry();
            }, delay);
        runs.set(key, entry);
        return delay;
    }
    /* Whether the run may be walked now: not while it waits out its last walk. */
    const due = (key: string) => {
        const run = runs.get(key);
        return !run || clock.now() >= run.until;
    };
    return {
        due,
        /* When it may be walked again, by `clock` (null: now). */
        nextAt(key: string) {
            return runs.get(key)?.until ?? null;
        },
        ended,
        /* The run is no one's to retry here (locked, signed out): its timer stops, nothing counts. */
        forget(key: string) {
            stop(runs.get(key));
            runs.delete(key);
        },
        /* Signed out or locked: every timer stops, and walks settling later leave nothing. */
        clear() {
            generation++;
            for (const entry of runs.values()) stop(entry);
            runs.clear();
            inFlight.clear();
        },
        /* Back online: what failed waits no longer, and its count starts over. */
        online() {
            const waiting = [...runs.values()].filter((entry) => entry.retry !== null);
            for (const entry of waiting) {
                stop(entry);
                entry.attempts = 0;
                entry.until = -Infinity;
            }
            for (const entry of waiting) entry.retry?.();
        },
        /*
         * Walks the run unless it waits out its last walk or is being walked already, and
         * counts the walk once, however many syncs asked for it meanwhile: a sync that finds the
         * run while this tab walks it joins nothing, so one failed walk is one attempt, never
         * one per page that synced during it (which once sent a run's next try minutes out).
         * `judge` says how a failure counts; `failed` hears the wait that follows.
         */
        run(
            key: string,
            walk: () => Promise<unknown>,
            then: {
                retry: () => void;
                judge: (error: unknown) => WalkFailure;
                failed?: (failure: WalkFailure, wait: number | null) => void;
            },
        ) {
            if (inFlight.has(key) || !due(key)) return false;
            inFlight.add(key);
            const at = generation;
            void walk().then(
                () => {
                    if (at !== generation) return;
                    inFlight.delete(key);
                    ended(key);
                },
                (error: unknown) => {
                    if (at !== generation) return;
                    inFlight.delete(key);
                    const failure = then.judge(error);
                    const wait = ended(key, { retry: then.retry, failure });
                    then.failed?.(failure, wait);
                },
            );
            return true;
        },
    };
}

/* A run of a family folder's key change, as a walk is given it. */
export type WalkTarget = {
    workspaceId: string;
    rotationId: string | null;
    nodeId: string;
    targetEpoch: number;
};

/*
 * Who hears that a walk of one of a family's folders ended (walked to its end here, or ended
 * elsewhere): the family's pages, which sync again so they stop showing it. Said once, from the
 * walk itself, whoever started it (a page's sync, an upload waiting on it, the outbox, a retry).
 */
export function walkEndings() {
    const listeners = new Map<string, Set<() => void>>();
    return {
        subscribe(groupId: string, listener: () => void) {
            const set = listeners.get(groupId) ?? new Set();
            set.add(listener);
            listeners.set(groupId, set);
            return () => {
                set.delete(listener);
                if (set.size === 0) listeners.delete(groupId);
            };
        },
        emit(groupId: string) {
            for (const listener of listeners.get(groupId) ?? []) {
                try {
                    listener();
                } catch (error) {
                    console.error('A page could not hear that a key change ended.', error);
                }
            }
        },
    };
}
/* The app's one: lib/spaces.ts says it, the family pages (lib/families.ts) listen. */
export const familyWalkEndings = walkEndings();

/*
 * This tab's walks of the key changes running in its families' folders (lib/spaces.ts gives it
 * the folders' clients): one walk per folder at a time, joined rather than started twice; the
 * runs a sync found, walked when due (walkRetries) and only with this device's own reason to
 * (ownReasonToWalk); a failed one walked again on its own timer through a sync of the family;
 * and the family's syncs for uploads waiting on a key change, one at a time and none within
 * `refreshGapMs` of the last, except a retry's. Kept free of the Drive clients, so it is tested
 * with its parts injected.
 */
export function familyWalks(deps: {
    /* Walks the run in its folder to its end: the folder's client, its lock, its progress. */
    walkFolder: (userId: string, groupId: string, target: WalkTarget) => Promise<void>;
    /* A sync of the family: its folders' states when it was accepted, else null. */
    sync: (userId: string, groupId: string) => Promise<readonly AreaState[] | null>;
    /* Whose keys this tab holds now (null: locked or signed out). */
    unlockedUser: () => string | null;
    online: () => boolean;
    /* Whether the folder's last walk re-keyed anything before it stopped. */
    progressed: (workspaceId: string) => boolean;
    /* A failed walk's next try: in `ms`, once back online, or not from here (null). */
    scheduled?: (workspaceId: string, next: number | 'online' | null) => void;
    endings?: ReturnType<typeof walkEndings>;
    clock?: WalkClock;
    random?: () => number;
    refreshGapMs?: number;
}) {
    const clock = deps.clock ?? systemClock;
    const endings = deps.endings ?? familyWalkEndings;
    const gap = deps.refreshGapMs ?? 4_000;
    const retries = walkRetries(clock, deps.random);
    const walking = new Map<string, Promise<void>>();
    const refreshes = new Map<string, { at: number; pending: Promise<void> | null }>();

    function walk(userId: string, groupId: string, target: WalkTarget): Promise<void> {
        const held = walking.get(target.workspaceId);
        if (held) return held;
        const settled = deps
            .walkFolder(userId, groupId, target)
            .then(() => endings.emit(groupId))
            .finally(() => walking.delete(target.workspaceId));
        walking.set(target.workspaceId, settled);
        return settled;
    }

    /* Why a walk or a retry's sync failed, as walkRetries counts it. */
    function failureOf(userId: string, workspaceId: string): WalkFailure {
        if (deps.unlockedUser() !== userId) return 'gone';
        if (!deps.online()) return 'offline';
        return deps.progressed(workspaceId) ? 'progressed' : 'counted';
    }
    const nextOf = (failure: WalkFailure, wait: number | null) =>
        wait ?? (failure === 'offline' ? ('online' as const) : null);

    function pending(userId: string, groupId: string, states: readonly AreaState[]) {
        for (const state of states) {
            const rotation = state.view.rotation;
            // Only a roster rotation this device saw for itself: never a run on the server's
            // word alone, since a walk closes every share and link its own ledger lacks.
            if (!rotation || !ownReasonToWalk(state)) continue;
            const workspaceId = state.workspaceId;
            const key = `${workspaceId}:${rotation.id}`;
            const target = {
                workspaceId,
                rotationId: rotation.id,
                nodeId: rotation.nodeId,
                targetEpoch: rotation.targetEpoch,
            };
            // Once the wait is over: a sync of the family, which walks what still runs. Never for
            // an account that locked or left meanwhile (its sync would reopen what signing out
            // deleted), and a sync that fails waits again, counted as the walk would be.
            const retry = () => {
                if (deps.unlockedUser() !== userId) {
                    retries.forget(key);
                    return;
                }
                refresh(userId, groupId, { due: true }).catch(() => {
                    const failure = failureOf(userId, workspaceId);
                    const wait = retries.ended(key, { retry, failure });
                    deps.scheduled?.(workspaceId, nextOf(failure, wait));
                });
            };
            retries.run(key, () => walk(userId, groupId, target), {
                retry,
                judge: () => failureOf(userId, workspaceId),
                failed: (failure, wait) => deps.scheduled?.(workspaceId, nextOf(failure, wait)),
            });
        }
    }

    function refresh(
        userId: string,
        groupId: string,
        options: { due?: boolean } = {},
    ): Promise<void> {
        const held = refreshes.get(groupId);
        if (held?.pending) return held.pending;
        // A retry is already spaced out by its own wait: never skipped for being close to another.
        if (!options.due && held && clock.now() - held.at < gap) return Promise.resolve();
        const work: Promise<void> = (async () => {
            const states = await deps.sync(userId, groupId);
            if (states) pending(userId, groupId, states);
        })().finally(() => {
            if (refreshes.get(groupId)?.pending === work)
                refreshes.set(groupId, { at: clock.now(), pending: null });
        });
        refreshes.set(groupId, { at: held?.at ?? -Infinity, pending: work });
        return work;
    }

    return {
        /* Walks the run to its end; one this tab walks already is joined. */
        walk,
        /* Every run a sync of the family found that this device walks, when due. */
        pending,
        /* A sync of the family for an upload waiting on a key change, then the walks it finds. */
        refresh,
        /* Signed out or locked: no retry fires, nothing settling later counts. */
        clear() {
            retries.clear();
            refreshes.clear();
        },
        /* Back online: what failed offline (or waits) is walked again now. */
        online: () => retries.online(),
    };
}
