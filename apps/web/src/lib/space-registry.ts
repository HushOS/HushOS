/*
 * Which Drive client a workspace belongs to (lib/drive.ts holds the app's
 * one). Family folders each have a client of their own (lib/spaces.ts),
 * registered by workspace with the family they are in; anything never
 * registered is this account's own Drive (shares included).
 *
 * It fails closed: a family folder that was registered and then forgotten (a
 * sync no longer lists it, the family was wiped) keeps a tombstone, and asking
 * for its client throws rather than falling back to the personal client, which
 * would judge the folder's records by personal rules and could sign a former
 * member's record as this person's own. Kept free of imports so it is tested
 * on its own.
 */

export type WriteTarget = {
    id: string;
    keyEpoch: number;
    workspaceId: string;
    /* The parent epoch the node's envelope is under, and its parent: what a key change's walk reads. */
    parentKeyEpoch?: number;
    parentId?: string | null;
};

export const FOLDER_GONE = 'This family folder isn’t open here any more. Open the family again.';

type Entry<C> = {
    groupId: string;
    client: C;
    /* Why nothing may be added to `folder` now, or null. */
    refuseWrite: (folder: WriteTarget) => string | null;
    /* Whether that refusal is only a key change that has not reached `folder` yet: adds wait. */
    waitsForKeyChange?: (folder: WriteTarget) => boolean;
    /*
     * The family synced again, for an upload waiting out a key change (or one
     * the server refused for it, 409 rotating): the folder's client learns of
     * the run and of its end, and this device's walk joins when it should.
     */
    refreshKeyChange?: () => Promise<void>;
};

export function createSpaceRegistry<C extends { close(): void; knows(nodeId: string): boolean }>(
    personal: () => C,
) {
    const entries = new Map<string, Entry<C>>();
    const gone = new Set<string>();
    const closers = new Set<() => void>();
    function forget(workspaceId: string) {
        const entry = entries.get(workspaceId);
        if (!entry) return;
        entry.client.close();
        entries.delete(workspaceId);
        gone.add(workspaceId);
    }
    // Plain functions, never `this`: callers take them off the registry one by one.
    return {
        register: (workspaceId: string, entry: Entry<C>) => {
            gone.delete(workspaceId);
            entries.set(workspaceId, entry);
        },
        has: (workspaceId: string) => {
            return entries.has(workspaceId) || gone.has(workspaceId);
        },
        /* The client of the workspace a node lives in; throws for a family folder forgotten here. */
        clientFor: (workspaceId: string | null | undefined): C => {
            if (!workspaceId) return personal();
            const entry = entries.get(workspaceId);
            if (entry) return entry.client;
            if (gone.has(workspaceId)) throw new Error(FOLDER_GONE);
            return personal();
        },
        /* The client that has listed a node, when only its id is at hand. */
        clientOfNode: (nodeId: string): C => {
            for (const { client } of entries.values()) if (client.knows(nodeId)) return client;
            return personal();
        },
        refuseWrite: (folder: WriteTarget) => {
            if (gone.has(folder.workspaceId)) return FOLDER_GONE;
            return entries.get(folder.workspaceId)?.refuseWrite(folder) ?? null;
        },
        waitsForKeyChange: (folder: WriteTarget) => {
            if (gone.has(folder.workspaceId)) return false;
            return entries.get(folder.workspaceId)?.waitsForKeyChange?.(folder) ?? false;
        },
        /* Nothing to learn for one's own Drive, or a family folder forgotten here. */
        refreshKeyChange: async (folder: WriteTarget) => {
            await entries.get(folder.workspaceId)?.refreshKeyChange?.();
        },
        /* After a lock or a sign-out: every family client forgets what it opened. */
        closeAll: () => {
            for (const { client } of entries.values()) client.close();
            for (const closer of closers) closer();
        },
        /*
         * Only what goes with them, the clients left as they are: at the start of a sign-out,
         * before the device's stores are deleted (lib/sign-out.ts).
         */
        stopAll: () => {
            for (const closer of closers) closer();
        },
        /* What else goes with them (lib/spaces.ts: the key-change walks' retries). */
        onClose: (closer: () => void) => {
            closers.add(closer);
            return () => {
                closers.delete(closer);
            };
        },
        forget,
        /* A family's folders not in `keep` (all of them for a family gone from this device). */
        prune: (groupId: string, keep: readonly string[]) => {
            for (const [workspaceId, entry] of entries)
                if (entry.groupId === groupId && !keep.includes(workspaceId)) forget(workspaceId);
        },
        clients: () => {
            return [...entries.values()].map((entry) => entry.client);
        },
    };
}
