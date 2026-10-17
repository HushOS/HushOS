import { useSyncExternalStore } from 'react';
import { familyContext } from '@/lib/families';
import { runDue } from '@/lib/groups/removal';
import type { SyncResult } from '@/lib/groups/sync';
import { walkPending } from '@/lib/spaces';

/*
 * What a family page does on its own after each sync (1c step 7): what route
 * 3 says is due (grants for everyone; for those who manage the family,
 * departures marked left, fold-ins, folders owed new keys, a previous
 * top-folder key to repair), then every key change still walking a folder,
 * in the background. One pass per family at a time; the latest sync that
 * came while one ran starts the next. Loaded with the family pages only.
 */

export type FamilyWork = {
    /* A pass is running. */
    running: boolean;
    /* Why the last pass stopped; it runs again at the next sync. */
    error: string | null;
    /* Members whose words need comparing again before their new keys are taken in. */
    needsCheck: string[];
};

const IDLE: FamilyWork = { running: false, error: null, needsCheck: [] };
const passes = new Map<string, Promise<void>>();
/* A sync that came while a pass ran: the next pass starts from it once this one ends. */
const queued = new Map<string, () => void>();
const states = new Map<string, FamilyWork>();
const listeners = new Set<() => void>();

function set(groupId: string, next: Partial<FamilyWork>) {
    states.set(groupId, { ...(states.get(groupId) ?? IDLE), ...next });
    for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useFamilyWork(groupId: string): FamilyWork {
    return useSyncExternalStore(
        subscribe,
        () => states.get(groupId) ?? IDLE,
        () => IDLE,
    );
}

/*
 * After a sync of the family: what is due, then the walks. `onChanged` runs
 * when either moved something (a roster landed, a walk ended), so the pages
 * sync again and show it.
 */
export function startFamilyWork(
    userId: string,
    groupId: string,
    result: SyncResult,
    options: { manager: boolean; onChanged: () => void },
) {
    if (result.status !== 'accepted') return;
    if (passes.has(groupId)) {
        queued.set(groupId, () => startFamilyWork(userId, groupId, result, options));
        return;
    }
    const ctx = familyContext(userId);
    set(groupId, { running: true });
    const pass = (async () => {
        try {
            const report = await runDue(ctx, groupId, {
                manager: options.manager,
                areas: result.areas,
            });
            set(groupId, { error: null, needsCheck: report.needsCheck });
            if (report.done.length > 0) options.onChanged();
        } catch (error) {
            set(groupId, {
                error: error instanceof Error ? error.message : 'Please try again.',
            });
        }
        // Everyone walks what is running (the server lets any member): a walk resumes from the
        // server's state at every sync, one tab per folder.
        walkPending(userId, groupId, result.areas, options.onChanged);
    })().finally(() => {
        passes.delete(groupId);
        set(groupId, { running: false });
        const next = queued.get(groupId);
        queued.delete(groupId);
        next?.();
    });
    passes.set(groupId, pass);
}
