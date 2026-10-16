import type { GroupWriter } from '@hushos/crypto';
import type { NodeView, WorkspaceView } from '@hushos/drive/api';
import { createDriveClient, createIndexedDbMirror, type DriveClient } from '@hushos/drive/client';
import type { Pin } from '@hushos/drive/trust';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef } from 'react';
import { authClient } from '@/lib/auth-client';
import { contactPins, openIdentity, trustedSigners } from '@/lib/contacts';
import { driveKeys, forgetSpace, pruneSpaces, registerSpace } from '@/lib/drive';
import { driveApi } from '@/lib/drive-api';
import { familyContext, type FamilyDetail } from '@/lib/families';
import { onFamilySynced } from '@/lib/families-keys';
import { restoreTransfers } from '@/lib/transfers';
import { stageChange } from '@/lib/groups/outbox';
import { AREA_MIRROR_PREFIX } from '@/lib/groups/store';
import { writeRefusal, type AreaState } from '@/lib/groups/sync';
import { groupWriters } from '@/lib/groups/writers';

/*
 * Family folders in Drive (groups 1c step 6; the 1c plan, section 2 "Drive
 * integration"). Each family folder has a Drive client of its own: opened
 * from route 25's area view after the family's sync opened its key in the
 * worker (groupOpenArea) and listed its root, with its own tree mirror
 * (`hushos-drive-mirror:<workspace>`) and catalogue, and with every record
 * judged by the family's member list (groupVerify) instead of this person's
 * pins alone. Registered with lib/drive, so code holding a node reaches the
 * client that lists and writes it.
 *
 * This module, and the families layer under it, load with the family space
 * pages only.
 */

type Area = { userId: string; groupId: string; state: AreaState; client: DriveClient };
const areas = new Map<string, Area>();

/* Route 25's area view as the Drive client opens a workspace. */
function viewOf(state: AreaState): WorkspaceView {
    return {
        workspaceId: state.workspaceId,
        changeSeq: state.view.changeSeq,
        // Opened by the family's sync, never from a workspace grant here.
        grant: null,
        root: state.view.root as NodeView | null,
        rotation: state.view.rotation,
    };
}

/*
 * The writers each verdict needs, kept while this person's pins stay the same
 * object (a words check or a removal replaces it) and for a minute at most,
 * since a member may replace their keys.
 */
const WRITERS_FOR_MS = 60_000;
const writers = new Map<
    string,
    { contacts: Record<string, Pin>; at: number; writers: Promise<GroupWriter[]> }
>();
async function writersFor(userId: string, groupId: string) {
    const contacts = await contactPins(userId);
    const held = writers.get(groupId);
    if (held && held.contacts === contacts && Date.now() - held.at < WRITERS_FOR_MS)
        return held.writers;
    const pending = groupWriters(familyContext(userId), groupId, contacts);
    writers.set(groupId, { contacts, at: Date.now(), writers: pending });
    pending.catch(() => writers.delete(groupId));
    return pending;
}

/*
 * The client of one family folder, made once and kept up to date with the
 * family's latest sync: its view (root, change sequence, running key change)
 * and what this device may do there.
 */
export function areaClient(userId: string, groupId: string, state: AreaState): DriveClient {
    const workspaceId = state.workspaceId;
    const held = areas.get(workspaceId);
    if (held && held.userId === userId && held.groupId === groupId) {
        held.state = state;
        // Registered again: a sync may have pruned it meanwhile, and the folder is back.
        register(held);
        return held.client;
    }
    if (held) forgetSpace(workspaceId);
    const client = createDriveClient(authClient.rpc, driveApi, {
        mirror:
            typeof indexedDB === 'undefined'
                ? undefined
                : createIndexedDbMirror(AREA_MIRROR_PREFIX + workspaceId),
        view: async () => {
            const current = areas.get(workspaceId);
            if (!current) throw new Error('Open the family again, then try again.');
            return viewOf(current.state);
        },
        // Every record as the family's member list says (design 2.8); a check that throws is
        // the client's to read as `unchecked`.
        verify: async (at, nodes) => {
            const { nodes: checked } = await authClient.rpc('groupVerify', {
                groupId,
                workspaceId: at,
                writers: await writersFor(userId, groupId),
                nodes,
            });
            return checked;
        },
        // Copies and rotations judge records against these (neither is offered in a family
        // folder here yet; the worker refuses a family folder's rotation without the family).
        signers: async () => trustedSigners(userId),
        openIdentity: (id) => openIdentity(id),
    });
    const area = { userId, groupId, state, client };
    areas.set(workspaceId, area);
    register(area);
    return client;
}
function register(area: Area) {
    const workspaceId = area.state.workspaceId;
    registerSpace(workspaceId, {
        groupId: area.groupId,
        client: area.client,
        refuseWrite: (folder) => writeRefusal(areas.get(workspaceId)?.state, folder),
    });
}

/*
 * Opens a family folder's client (the workspace view, the identity), then, in
 * the background, what an open Drive keeps going: the catalogue from its own
 * mirror and the uploads this device left unfinished in it.
 */
export async function openArea(userId: string, groupId: string, state: AreaState) {
    const client = areaClient(userId, groupId, state);
    const opened = await client.open(userId);
    void client.buildCatalogue(state.workspaceId).catch(() => {});
    void restoreTransfers(state.workspaceId);
    return { client, ...opened };
}

/*
 * A family's folders the server no longer lists for it (or a family gone from
 * this device): their clients go, and a page still holding one gets an error
 * rather than the personal client (lib/space-registry.ts).
 */
export function pruneAreas(groupId: string, keep: readonly string[]) {
    for (const [workspaceId, area] of areas)
        if (area.groupId === groupId && !keep.includes(workspaceId)) areas.delete(workspaceId);
    pruneSpaces(groupId, keep);
    writers.delete(groupId);
}

/*
 * Any sync of a family, the always-on one included: the folders' clients take
 * the new state (what may be written, the running key change), and those no
 * longer listed go.
 */
onFamilySynced((groupId, result) => {
    if (result.status === 'wiped') pruneAreas(groupId, []);
    if (result.status !== 'accepted') return;
    for (const state of result.areas) {
        const held = areas.get(state.workspaceId);
        if (held?.groupId === groupId) held.state = state;
    }
    pruneAreas(
        groupId,
        result.areas.map((state) => state.workspaceId),
    );
});

/*
 * The family folder holding `folderId`, for a page opened at its address: a
 * folder's own top folder, one a client has listed, or else each folder of
 * the family asked in turn (a reload or a link). The listing that finds it is
 * kept, so the page does not ask again.
 */
export async function areaOf(
    userId: string,
    groupId: string,
    states: readonly AreaState[],
    folderId: string,
    keep: (listing: Awaited<ReturnType<DriveClient['listFolder']>>) => void,
): Promise<string | null> {
    const direct = states.find((state) => state.view.root?.id === folderId);
    if (direct) return direct.workspaceId;
    for (const state of states)
        if (areas.get(state.workspaceId)?.client.knows(folderId)) return state.workspaceId;
    for (const state of states) {
        if (!state.view.root || !state.opened) continue;
        const { client } = await openArea(userId, groupId, state);
        try {
            const listing = await client.listFolder(folderId);
            keep(listing);
            return state.workspaceId;
        } catch (error) {
            if ((error as { status?: number }).status !== 404) throw error;
        }
    }
    return null;
}

/*
 * A new family folder (route 21), for those who manage the family: staged on
 * the member list as its own change, with its key granted to every member,
 * then kept and sent. Its folder and root land with it.
 */
export function createFamilyFolder(userId: string, groupId: string, name: string) {
    return stageChange(familyContext(userId), groupId, { kind: 'area', name });
}

/* What the family space pages share: the family, its folders as synced, and who is in it. */
export type FamilySpace = {
    userId: string;
    groupId: string;
    family: string;
    areas: AreaState[];
    members: FamilyDetail['members'];
    manager: boolean;
    recheck: () => void;
};
const FamilySpaceContext = createContext<FamilySpace | null>(null);
export const FamilySpaceProvider = FamilySpaceContext.Provider;
export function useFamilySpace() {
    const space = useContext(FamilySpaceContext);
    if (!space) throw new Error('useFamilySpace must be used inside a family space.');
    return space;
}

/* Members by user id as the server names them, with their address where it gives one. */
export function membersById(members: FamilyDetail['members']) {
    return Object.fromEntries(
        members.map((member) => [
            member.userId.toLowerCase(),
            { name: member.name, email: member.email ?? null },
        ]),
    );
}

const FEED_INTERVAL_MS = 8_000;
/*
 * A family folder's listings stay fresh as one's own do (lib/feed.ts): its
 * change feed is polled while the tab is visible, from the change sequence the
 * folder was opened at, a few pages a tick, and every folder a change touches
 * is marked stale. A change to the folder's top folder (a key change re-keys
 * it, with the member list) also checks the family again (`onRootChanged`),
 * so what may be written and the running key change are read afresh.
 */
export function useAreaFeed(
    opened: { client: DriveClient; root: NodeView; changeSeq: number } | null,
    workspaceId: string,
    onRootChanged: () => void,
) {
    const queryClient = useQueryClient();
    const cursor = useRef<number | null>(null);
    const rootChanged = useRef(onRootChanged);
    useEffect(() => {
        rootChanged.current = onRootChanged;
    });
    useEffect(() => {
        if (!opened) return;
        const { client, root } = opened;
        // From where the folder was opened, never from nothing (that would replay its history).
        cursor.current = Math.max(cursor.current ?? 0, opened.changeSeq);
        let stopped = false;
        let timer: number | undefined;
        async function poll() {
            let page = await client.changesSince(workspaceId, cursor.current!);
            for (let more = 0; ; more++) {
                cursor.current = page.nextCursor;
                const folders = new Set<string>();
                let rootTouched = false;
                for (const change of page.changes) {
                    if (change.kind === 'node') {
                        if (change.node.parentId) folders.add(change.node.parentId);
                        if (change.node.kind === 'folder') folders.add(change.node.id);
                        if (change.node.id === root.id) rootTouched = true;
                    } else if (change.kind === 'tombstone') {
                        if (change.parentId) folders.add(change.parentId);
                        folders.add(change.nodeId);
                    }
                }
                for (const id of folders)
                    void queryClient.invalidateQueries({ queryKey: driveKeys.folder(id) });
                if (rootTouched) rootChanged.current();
                if (!page.hasMore || more >= 5 || stopped) break;
                page = await client.changesSince(workspaceId, cursor.current);
            }
        }
        async function tick() {
            if (stopped) return;
            if (document.visibilityState === 'visible')
                await poll().catch(() => {
                    /* Tried again on the next tick. */
                });
            if (!stopped) timer = window.setTimeout(() => void tick(), FEED_INTERVAL_MS);
        }
        timer = window.setTimeout(() => void tick(), FEED_INTERVAL_MS);
        return () => {
            stopped = true;
            window.clearTimeout(timer);
        };
    }, [opened, workspaceId, queryClient]);
}
