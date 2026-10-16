import type { SyncResult } from '@/lib/groups/sync';

/*
 * What the always-on Drive shell needs of families beyond lib/families-shell
 * without loading the families layer: the key of the app-wide families pass
 * it shares with the families pages (familiesSyncKey in lib/families.ts, a
 * test holds them equal), and a note each family sync leaves, so the family
 * folders' clients follow a sync the shell ran (lib/spaces.ts listens).
 */

export const familiesSyncAllKey = (userId: string) => ['families', userId, 'sync-all'] as const;

type Listener = (groupId: string, result: SyncResult | { status: 'failed'; error: string }) => void;
const listeners = new Set<Listener>();
export function onFamilySynced(listener: Listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
export function familySynced(groupId: string, result: Parameters<Listener>[1]) {
    for (const listener of listeners) listener(groupId, result);
}
