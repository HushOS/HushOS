import type { DriveClient, DriveNode } from '@hushos/drive/client';
import { createIndexedDbJournal, type JournalEntry, type QueuedEntry } from '@hushos/drive/journal';
import {
    createTransferManager,
    type TransferManagerOptions,
    type TransfersState,
} from '@hushos/drive/transfers';
import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { authClient } from '@/lib/auth-client';
import { renderThumbnail } from '@/lib/thumbnails';
import {
    clientFor,
    driveKeys,
    invalidateFolders,
    refreshKeyChange,
    refuseWrite,
    waitsForKeyChange,
} from '@/lib/drive';
import { driveApi } from '@/lib/drive-api';
import { stashAvailable, uploadStash } from '@/lib/stash';
import { backoffDelay } from '@/lib/groups/walks';

/*
 * One transfer manager for the whole app, created once and never tied to a route,
 * so a queue started in one folder keeps going while the person browses another.
 * Pages subscribe through `useTransfers`.
 */

let queryClient: QueryClient | undefined;
export function bindTransfersToQueries(client: QueryClient) {
    queryClient = client;
}

/*
 * For a journaled upload, opens the parent chain (which caches every key on the
 * way down) and, for a file node the server has not published yet, opens that
 * node from the envelopes the journal kept. A file that was only waiting has no
 * node yet and needs its parent (and the file it replaces) looked up.
 */
/*
 * One listing of a folder shared by every upload that looks it up within a
 * couple of seconds: a hundred files waiting out a key change in one folder,
 * each looking again after its pause, fetch it once a round, not a hundred
 * times. A failed fetch is not kept.
 */
const LOOK_SHARED_MS = 2_000;
const looks = new Map<string, { at: number; listing: ReturnType<DriveClient['listFolder']> }>();
function lookUp(workspaceId: string, folderId: string) {
    const key = `${workspaceId}:${folderId}`;
    const held = looks.get(key);
    if (held && Date.now() - held.at < LOOK_SHARED_MS) return held.listing;
    // A family folder's upload is opened by that folder's client, which checks by its member list.
    const listing = clientFor(workspaceId).listFolder(folderId);
    looks.set(key, { at: Date.now(), listing });
    listing.catch(() => {
        if (looks.get(key)?.listing === listing) looks.delete(key);
    });
    for (const [other, look] of looks)
        if (Date.now() - look.at >= LOOK_SHARED_MS) looks.delete(other);
    return listing;
}

async function openNodes(entry: JournalEntry | QueuedEntry) {
    const client = clientFor(entry.workspaceId);
    const listing = await lookUp(entry.workspaceId, entry.parentId);
    if (!('uploadId' in entry)) {
        const replaces = entry.replacesId
            ? listing.children.find((child) => child.id === entry.replacesId)
            : undefined;
        return { parent: listing.folder, replaces };
    }
    const replaces = entry.newNode
        ? undefined
        : listing.children.find((child) => child.id === entry.nodeId);
    if (entry.newNode && entry.node)
        await client.openNode({
            id: entry.nodeId,
            workspaceId: entry.workspaceId,
            parentId: entry.parentId,
            parentKeyEpoch: entry.parentKeyEpoch,
            keyEpoch: entry.keyEpoch,
            keyEnvelope: entry.node.keyEnvelope,
            metadataVersion: entry.node.metadataVersion,
            metadataEnvelope: entry.node.metadataEnvelope,
        });
    return { parent: listing.folder, replaces };
}

/*
 * One pause of an upload waiting out a family folder's key change (or one the
 * server refused for it, 409 rotating): the first look goes at once, since the
 * walk is often done by then; each later one waits twice as long as the last,
 * by the walks' own backoff (lib/groups/walks.ts), from 5 seconds up to a
 * minute. Then the family is synced again, so this device knows where the run
 * is and walks it too when it should; the engine looks the folder up after.
 */
const KEY_CHANGE_FIRST_MS = 5_000;
const KEY_CHANGE_MOST_MS = 60_000;
async function keyChangePause(target: DriveNode, attempt: number) {
    if (attempt > 1)
        await new Promise((resolve) =>
            setTimeout(resolve, backoffDelay(attempt - 1, KEY_CHANGE_FIRST_MS, KEY_CHANGE_MOST_MS)),
        );
    await refreshKeyChange(target).catch(() => {});
}

export const transfers = createTransferManager({
    rpc: authClient.rpc,
    api: driveApi,
    journal: typeof indexedDB === 'undefined' ? undefined : createIndexedDbJournal(),
    stash: stashAvailable() ? uploadStash : undefined,
    openNodes,
    // A family folder that may not be written fails the upload at prepare; one a key change has
    // not reached yet makes it wait, and it goes once the walk has re-keyed the folder.
    refuseWrite,
    waitsForKeyChange,
    // A refusal this device had not foreseen (409 rotating) waits too: the upload is looked up and
    // sealed again under the folder's new keys once the walk is done, and goes by itself.
    keyChangePause,
    thumbnail: (file, mime) => renderThumbnail(file, mime),
    onPublished: (node) => {
        if (!queryClient) return;
        refreshFolderSoon(queryClient, node.parentId);
        // A new version of a file whose Versions are open: the list read while it was still on its
        // way is stale (it showed the old version as current and no earlier one).
        void queryClient.invalidateQueries({ queryKey: driveKeys.versions(node.id) });
    },
    onEvent: (event) => {
        for (const listener of listeners) listener(event);
    },
});

/*
 * A folder's listing is refetched once for a burst of finished uploads, not
 * once per file: a thousand small files would otherwise fetch a growing
 * listing a thousand times, which is most of what made them slow.
 */
const refreshes = new Map<string | null, ReturnType<typeof setTimeout>>();
const REFRESH_AFTER_MS = 400;
function refreshFolderSoon(client: QueryClient, parentId: string | null) {
    const pending = refreshes.get(parentId);
    if (pending) clearTimeout(pending);
    refreshes.set(
        parentId,
        setTimeout(() => {
            refreshes.delete(parentId);
            void invalidateFolders(client, parentId);
        }, REFRESH_AFTER_MS),
    );
}

/* Anything in the app that wants to react to an upload's fate, such as a refusal for lack of room. */
export type TransferEvent = Parameters<NonNullable<TransferManagerOptions['onEvent']>>[0];
const listeners = new Set<(event: TransferEvent) => void>();
export function onTransferEvent(listener: (event: TransferEvent) => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/* Once per workspace open: bring back what this device was uploading before. */
const restored = new Set<string>();
export async function restoreTransfers(workspaceId: string) {
    if (restored.has(workspaceId)) return;
    restored.add(workspaceId);
    await transfers.restore(workspaceId).catch(() => restored.delete(workspaceId));
}

const EMPTY: TransfersState = { uploads: [], active: 0, bytesPerSecond: 0 };

export function useTransfers() {
    return useSyncExternalStore(transfers.subscribe, transfers.getState, () => EMPTY);
}

/* Leaving the page abandons in-flight uploads; ask before that happens. */
let guarding = false;
export function guardUnloadWhileUploading() {
    if (guarding || typeof window === 'undefined') return;
    guarding = true;
    window.addEventListener('beforeunload', (event) => {
        if (transfers.getState().active > 0) {
            event.preventDefault();
            // Chrome still requires returnValue to be set for the prompt to show.
            event.returnValue = '';
        }
    });
}
