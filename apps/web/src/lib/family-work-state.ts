import { useSyncExternalStore } from 'react';

/*
 * What a family's background pass (lib/family-work.ts) last found, kept apart from the pass
 * itself so the drive shell can read it: the sidebar counts members waiting to be checked from
 * it, and the shell stays off the groups data layer (lib/families-shell.ts). Nothing here does
 * work; the pass writes, the pages and the sidebar read.
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
const states = new Map<string, FamilyWork>();
const listeners = new Set<() => void>();

export function setFamilyWork(groupId: string, next: Partial<FamilyWork>) {
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
