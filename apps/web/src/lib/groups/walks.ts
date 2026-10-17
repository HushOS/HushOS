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
 * server's word alone: every walk re-signs records as the walker.
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
