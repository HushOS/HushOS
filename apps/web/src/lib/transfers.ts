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
import { driveClient, invalidateFolders } from '@/lib/drive';
import { driveApi } from '@/lib/drive-api';
import { stashAvailable, uploadStash } from '@/lib/stash';

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
async function openNodes(entry: JournalEntry | QueuedEntry) {
    const listing = await driveClient.listFolder(entry.parentId);
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
        await driveClient.openNode({
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

export const transfers = createTransferManager({
    rpc: authClient.rpc,
    api: driveApi,
    journal: typeof indexedDB === 'undefined' ? undefined : createIndexedDbJournal(),
    stash: stashAvailable() ? uploadStash : undefined,
    openNodes,
    thumbnail: (file, mime) => renderThumbnail(file, mime),
    onPublished: (node) => {
        if (queryClient) refreshFolderSoon(queryClient, node.parentId);
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
