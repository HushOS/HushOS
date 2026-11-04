import type { GroupWriter } from '@hushos/crypto';
import type { NodeView, WorkspaceView } from '@hushos/drive/api';
import { createDriveClient, createIndexedDbMirror, type DriveClient } from '@hushos/drive/client';
import type { Pin } from '@hushos/drive/trust';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { authClient } from '@/lib/auth-client';
import { contactPins, familyCheckedOnAccount, openIdentity, trustedSigners } from '@/lib/contacts';
import { asFirstUse } from '@/lib/groups/family-checks';
import { driveKeys, forgetSpace, onSpacesClosed, pruneSpaces, registerSpace } from '@/lib/drive';
import { driveApi } from '@/lib/drive-api';
import { familyContext, type FamilyDetail } from '@/lib/families';
import { familySynced, onFamilySynced } from '@/lib/families-keys';
import { countFinishedRotation } from '@/lib/rotation';
import { restoreTransfers } from '@/lib/transfers';
import { groupsApi } from '@/lib/groups/api';
import { provideRotations } from '@/lib/groups/client';
import { errorCopy } from '@/lib/groups/copy';
import { stageChange } from '@/lib/groups/outbox';
import { createRotationSource } from '@/lib/groups/rotations';
import { AREA_MIRROR_PREFIX } from '@/lib/groups/store';
import {
    syncGroup,
    syncLocked,
    waitsForKeyChange,
    writeRefusal,
    type AreaState,
} from '@/lib/groups/sync';
import { familyWalks, stillRunning, walkToEnd, type WalkTarget } from '@/lib/groups/walks';
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
            // A family taken on first use vouches for nobody's keys (2.6): its word reads `seen`.
            // Settings that can't be read count as first use: an under-claim, never an over-claim.
            const vouched = await familyCheckedOnAccount(userId, groupId).catch(() => false);
            return vouched ? checked : asFirstUse(checked, groupId);
        },
        // Personal keys for writers the family's member list does not speak for.
        signers: async () => trustedSigners(userId),
        // Copies and key-change walks re-sign records only as the family judges them (1c step
        // 7); the worker refuses either in a family folder without it.
        rotationTrust: async () => ({
            groupId,
            staged: null,
            writers: await writersFor(userId, groupId),
        }),
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
        waitsForKeyChange: (folder) => waitsForKeyChange(areas.get(workspaceId)?.state, folder),
        refreshKeyChange: () => refreshFamily(area.userId, area.groupId),
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

/* ------------------------------------------------------------------------ */
/* Key changes walking family folders                                        */
/* ------------------------------------------------------------------------ */

/*
 * A family folder's key change (after a removal, a departure marked left, or
 * Replace keys) re-keys its top folder with the member list at once; the
 * rest of the folder is walked here afterwards, batch by batch, every record
 * re-signed as the family judges it (`rotationTrust`). The walk is the
 * server's state (route 25's `rotation`), so it resumes from wherever it got
 * to on the next open, on any device of anyone who manages the family. One
 * tab walks a folder at a time (a Web Lock per folder), and never under the
 * family's write lock, so a member list change that has to finish the same
 * walk first (409 rotating) waits for it instead of racing it.
 */
export type FamilyWalk = {
    groupId: string;
    workspaceId: string;
    /* Items re-keyed so far by this tab. */
    done: number;
    /* Why the last attempt stopped, worded for the person (errorCopy). */
    error: string | null;
    /*
     * When it is tried again, once it stopped: a time (ms since the epoch), once this device is
     * back online, or null when this tab has no try of its own lined up (the next sync walks it).
     */
    retry: number | 'online' | null;
};
const walkState = new Map<string, FamilyWalk>();
let walkSnapshot: FamilyWalk[] = [];
const walkListeners = new Set<() => void>();
function publishWalks() {
    walkSnapshot = [...walkState.values()];
    for (const listener of walkListeners) listener();
}
function subscribeWalks(listener: () => void) {
    walkListeners.add(listener);
    return () => {
        walkListeners.delete(listener);
    };
}
/* The key changes this tab is walking (or last failed to walk) in a family's folders. */
export function useFamilyWalks(groupId: string) {
    const all = useSyncExternalStore(
        subscribeWalks,
        () => walkSnapshot,
        () => walkSnapshot,
    );
    return useMemo(() => all.filter((walk) => walk.groupId === groupId), [all, groupId]);
}

function areaWalkLock<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
    if (typeof navigator !== 'undefined' && navigator.locks)
        return navigator.locks.request(`hushos-area-walk:${workspaceId}`, work) as Promise<T>;
    return work();
}

/*
 * Walks the key change running in one family folder to its end, with the family's trust; one
 * that ended meanwhile (another tab, another device) answers 404 and is done. The folder's
 * client comes from the family's latest sync, or from a sync now (the caller holds the family's
 * write lock when it is the outbox finishing a walk a member list change met). Joining a walk
 * this tab runs already, the retries and telling the pages it ended are walks.ts familyWalks'.
 */
// The walk of each folder whose progress the pages show: one cut loose by a lock or a sign-out
// (familyWalks clear) may still settle after a newer one started, and must not write over it.
const walkAttempts = new Map<string, object>();
function walkFolder(
    userId: string,
    groupId: string,
    rotation: WalkTarget,
    progress: (done: number) => void,
): Promise<void> {
    const workspaceId = rotation.workspaceId;
    const attempt = {};
    const mine = () => walkAttempts.get(workspaceId) === attempt;
    const show = (walk: FamilyWalk | null) => {
        if (!mine()) return;
        if (walk) walkState.set(workspaceId, walk);
        else walkState.delete(workspaceId);
        publishWalks();
    };
    const run = areaWalkLock(workspaceId, async () => {
        // This walk's own count from its first step: one that fails before it re-keys anything
        // (the folder not open, a sync refused) shows and reports nothing re-keyed.
        walkAttempts.set(workspaceId, attempt);
        show({ groupId, workspaceId, done: 0, error: null, retry: null });
        let area = areas.get(workspaceId);
        if (!area || area.groupId !== groupId) {
            await syncLocked(familyContext(userId), groupId, { flush: false });
            area = areas.get(workspaceId);
        }
        if (!area || area.groupId !== groupId)
            throw new Error('Open the family’s folders first, then try again.');
        await area.client.open(userId);
        const client = area.client;
        const outcome = await walkToEnd({
            walk: () =>
                client.walkRotation(
                    { nodeId: rotation.nodeId, targetEpoch: rotation.targetEpoch },
                    (done) => {
                        progress(done);
                        show({ groupId, workspaceId, done, error: null, retry: null });
                    },
                ),
            running: async () => stillRunning((await groupsApi.spaces()).spaces, groupId, rotation),
        });
        // Counted only when this tab walked it to its end, never when another finished it.
        if (outcome === 'walked') countFinishedRotation();
    });
    return run.then(
        () => {
            show(null);
            if (mine()) walkAttempts.delete(workspaceId);
        },
        (error: unknown) => {
            show({
                groupId,
                workspaceId,
                done: walkState.get(workspaceId)?.done ?? 0,
                error: errorCopy(error),
                retry: null,
            });
            throw error;
        },
    );
}

/*
 * Every key change a sync found walking the family's folders, started in the background, by
 * anyone in the family (the server lets any member walk, so a waiting upload does not depend on
 * a manager's device), each when due: the next walk of the same run waits longer each time, so
 * a run that comes back right after a walk said it finished, or that keeps failing, does not
 * spin walk, sync, walk; one that failed is walked again when its wait is over, on its own
 * timer, whatever the pages render or sync meanwhile; and the family's pages hear each walk end
 * (familyWalkEndings), whoever started it.
 */
const walks = familyWalks({
    walkFolder,
    sync: async (userId, groupId) => {
        const result = await syncGroup(familyContext(userId), groupId);
        familySynced(groupId, result);
        return result.status === 'accepted' ? result.areas : null;
    },
    unlockedUser: () => authClient.store.getState().unlockedUserId,
    online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    scheduled: (workspaceId, next) => {
        const walk = walkState.get(workspaceId);
        if (!walk?.error) return;
        walkState.set(workspaceId, {
            ...walk,
            retry: typeof next === 'number' ? Date.now() + next : next,
        });
        publishWalks();
    },
});
export function walkArea(userId: string, groupId: string, rotation: WalkTarget): Promise<void> {
    return walks.walk(userId, groupId, rotation);
}
export function walkPending(userId: string, groupId: string, states: readonly AreaState[]) {
    walks.pending(userId, groupId, states);
}
/*
 * For an upload waiting out a key change in one of the family's folders, or one the server
 * refused for it (409 rotating) before this device heard of the change: the family synced
 * again, so the folders' clients know of the run (what may be written, and when it is over),
 * and this device walks it too when it has its own reason to (the same rule and backoff as
 * after any sync). The uploads look their folders up again afterwards (packages/drive
 * transfers). One sync per family at a time, and none within a few seconds of the last,
 * however many uploads wait.
 */
function refreshFamily(userId: string, groupId: string): Promise<void> {
    return walks.refresh(userId, groupId);
}
// Locked or signed out (lib/drive closeSpaces): no retry fires for an account whose keys are
// gone (a sync then would reopen the device storage signing out deleted), nothing settling
// later counts, and no stopped walk claims a try this tab no longer has lined up.
onSpacesClosed(() => {
    walks.clear();
    for (const [workspaceId, walk] of walkState)
        if (walk.error) walkState.set(workspaceId, { ...walk, retry: null });
    publishWalks();
});
if (typeof window !== 'undefined') window.addEventListener('online', () => walks.online());

function unlockedUser() {
    const userId = authClient.store.getState().unlockedUserId;
    if (!userId) throw new Error('Unlock your account first.');
    return userId;
}

/*
 * What the families data layer builds a roster call's rotations from, and how
 * it finishes a walk a call met (409 rotating): this module's folder clients.
 * Provided once this module loads, with the family pages.
 */
provideRotations({
    ...createRotationSource({
        areaRoot: (groupId, workspaceId) => groupsApi.areaRoot(groupId, workspaceId),
        allocateEpochs: (workspaceId, count) => driveApi.allocateEpochs(workspaceId, count),
        document: (workspaceId, kind) => driveApi.document(workspaceId, kind),
        writers: (groupId) => writersFor(unlockedUser(), groupId),
        walk: (groupId, rotation) => walkArea(unlockedUser(), groupId, rotation),
    }),
    opened: (groupId, states) => {
        const userId = authClient.store.getState().unlockedUserId;
        if (!userId) return;
        for (const state of states) areaClient(userId, groupId, state);
    },
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

/*
 * Deletes a family folder, for those who manage the family (groups design
 * 2.10): its tombstone on the member list, as its own change, kept and sent.
 * The server stops serving it to everyone and keeps its files 30 days, as
 * the trash does, before they go for good. Nothing brings it back.
 */
export function deleteFamilyFolder(userId: string, groupId: string, workspaceId: string) {
    return stageChange(familyContext(userId), groupId, { kind: 'retire', workspaceId });
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
