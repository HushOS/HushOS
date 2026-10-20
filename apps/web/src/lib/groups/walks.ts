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
 * When this tab walks each key change run again (keyed by folder and run). A walk that ended
 * leaves the run alone for backoffDelay of its attempts so far; one that failed (a batch the
 * client's 30 s timeout cut off, a flaky network) is also tried again at the end of that wait,
 * on a timer of its own: never only "at the next sync", whose timing pages and renders decide.
 * Asking whether a run is due, or syncing, any number of times meanwhile moves nothing.
 */
export function walkRetries(
    clock: {
        now: () => number;
        schedule: (run: () => void, ms: number) => unknown;
        cancel: (handle: unknown) => void;
    } = {
        now: () => Date.now(),
        schedule: (run, ms) => setTimeout(run, ms),
        cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
) {
    const runs = new Map<string, { attempts: number; until: number; timer: unknown }>();
    const inFlight = new Set<string>();
    const ended = (key: string, retry?: () => void) => {
        const previous = runs.get(key);
        if (previous?.timer !== undefined) clock.cancel(previous.timer);
        const attempts = (previous?.attempts ?? 0) + 1;
        const delay = backoffDelay(attempts);
        const entry = { attempts, until: clock.now() + delay, timer: undefined as unknown };
        if (retry)
            entry.timer = clock.schedule(() => {
                entry.timer = undefined;
                retry();
            }, delay);
        runs.set(key, entry);
    };
    /* Whether the run may be walked now: not while it waits out its last walk. */
    const due = (key: string) => {
        const run = runs.get(key);
        return !run || clock.now() >= run.until;
    };
    return {
        due,
        /* When it may be walked again (null: now). */
        nextAt(key: string) {
            return runs.get(key)?.until ?? null;
        },
        /* A walk of the run ended; with `retry` (it failed), that runs once when the wait is over. */
        ended,
        /*
         * Walks the run unless it waits out its last walk or is being walked already, and
         * counts the walk once, however many syncs asked for it meanwhile: a sync that finds the
         * run while this tab walks it joins nothing, so one failed walk is one attempt, never
         * one per page that synced during it (which once sent a run's next try minutes out).
         */
        run(
            key: string,
            walk: () => Promise<unknown>,
            then: { walked: () => void; retry: () => void },
        ) {
            if (inFlight.has(key) || !due(key)) return;
            inFlight.add(key);
            void walk().then(
                () => {
                    inFlight.delete(key);
                    ended(key);
                    then.walked();
                },
                () => {
                    inFlight.delete(key);
                    ended(key, then.retry);
                },
            );
        },
    };
}
