import {
    contentSize,
    createDriveClient,
    createIndexedDbMirror,
    type DriveNode,
} from '@hushos/drive/client';
import { ROOT_LABEL } from '@hushos/drive/protocol';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { authClient } from '@/lib/auth-client';
import { trustGrantee, trustGranter } from '@/lib/contacts';
import { driveApi, linkApi, reportApi } from '@/lib/drive-api';

/*
 * The browser's Drive client and its query layer. Folder listings live in the
 * query cache keyed by folder id; every mutation invalidates the folders it
 * touched. Keys stay in the crypto worker, so nothing here is sensitive.
 */

export const driveClient = createDriveClient(authClient.rpc, driveApi, {
    mirror: typeof indexedDB === 'undefined' ? undefined : createIndexedDbMirror(),
    trustGranter,
    trustGrantee: (granteeUserId, served) => {
        const userId = authClient.store.getState().unlockedUserId;
        if (!userId) throw new Error('Unlock your account first.');
        return trustGrantee(userId, granteeUserId, served);
    },
    linkApi,
    reportApi,
});

export const driveKeys = {
    all: ['drive'] as const,
    shared: ['drive', 'shared'] as const,
    mine: ['drive', 'mine'] as const,
    open: (userId: string) => ['drive', 'open', userId] as const,
    folder: (folderId: string) => ['drive', 'folder', folderId] as const,
    trash: ['drive', 'trash'] as const,
};

/* Opens the workspace in the worker and makes sure the root exists. */
export const driveOpenQueryOptions = (userId: string) =>
    queryOptions({
        queryKey: driveKeys.open(userId),
        queryFn: () => driveClient.open(userId),
        staleTime: Infinity,
        gcTime: Infinity,
        retry: false,
    });

/* The catalogue answers first when it can, so a folder draws before the server is asked. */
export const folderQueryOptions = (folderId: string) =>
    queryOptions({
        queryKey: driveKeys.folder(folderId),
        queryFn: () => driveClient.listFolder(folderId),
        placeholderData: () => driveClient.localListing(folderId) ?? undefined,
        staleTime: 15_000,
        retry: 1,
    });

/* What others shared with this person, keys opened; refreshed on every visit. */
export const sharedQueryOptions = queryOptions({
    queryKey: driveKeys.shared,
    queryFn: () => driveClient.mountShares(true),
    staleTime: 15_000,
    retry: 1,
});

/* What this account shares out: by account and by link. */
/*
 * Everything this person shares. Every share, link and revocation made here
 * refreshes it at once, so it is kept for minutes rather than refetched on every
 * folder that shows who can open its rows.
 */
export const mySharingQueryOptions = queryOptions({
    queryKey: driveKeys.mine,
    queryFn: () => driveClient.mySharing(),
    staleTime: 5 * 60_000,
});

export const trashQueryOptions = queryOptions({
    queryKey: driveKeys.trash,
    queryFn: () => driveClient.listTrash(),
    staleTime: 15_000,
    retry: 1,
});

/* After a change: the folders that show the node, and the trash, are stale. */
export async function invalidateFolders(queryClient: QueryClient, ...folderIds: (string | null)[]) {
    const ids = new Set(folderIds.filter((id): id is string => id !== null));
    await Promise.all([
        ...Array.from(ids, (id) =>
            queryClient.invalidateQueries({ queryKey: driveKeys.folder(id) }),
        ),
        queryClient.invalidateQueries({ queryKey: driveKeys.trash }),
        // Whatever changed a folder may have changed how much room is used: the sidebar meter.
        queryClient.invalidateQueries({ queryKey: ['auth', 'storage'] }),
    ]);
    // Recent, search and tags read the catalogue, which otherwise waits for the next feed poll.
    void driveClient.catchUp().catch(() => {});
}

/* The name a copy takes among `taken`: the original, else "name (copy)", "name (copy 2)", and so on. */
export function copyName(name: string, taken: Set<string>) {
    const lower = new Set(Array.from(taken, (entry) => entry.toLowerCase()));
    if (!lower.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf('.');
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 1; ; n++) {
        const candidate = `${base} (copy${n > 1 ? ` ${n}` : ''})${ext}`;
        if (!lower.has(candidate.toLowerCase())) return candidate;
    }
}

/* The name a second upload takes beside an existing one: "name (2).ext", "name (3).ext", and so on. */
export function nextName(name: string, taken: Set<string>) {
    const lower = new Set(Array.from(taken, (entry) => entry.toLowerCase()));
    if (!lower.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf('.');
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 2; ; n++) {
        const candidate = `${base} (${n})${ext}`;
        if (!lower.has(candidate.toLowerCase())) return candidate;
    }
}

/*
 * Copies `nodes` into `destination`, each under a name free in that folder, and
 * refreshes the folders that changed. Reports items made so far.
 */
export async function copyInto(
    queryClient: QueryClient,
    nodes: DriveNode[],
    destination: DriveNode,
    onProgress?: (done: number) => void,
) {
    const listing = await queryClient.fetchQuery(folderQueryOptions(destination.id));
    const taken = new Set(listing.children.map((child) => child.name));
    let done = 0;
    try {
        for (const node of nodes) {
            const name = copyName(node.name, taken);
            taken.add(name);
            const before = done;
            await driveClient.copyTree(node, destination, name, (made) => {
                done = before + made;
                onProgress?.(done);
            });
        }
    } finally {
        await invalidateFolders(queryClient, destination.id);
    }
    return done;
}

/* Folders first, then names the way a person expects them ordered. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export function sortNodes(nodes: DriveNode[]) {
    return [...nodes].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
        return collator.compare(a.name, b.name);
    });
}

// Counted in 1024s and labelled as people know them, as in formatQuota.
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
export function formatBytes(value: number | string | bigint | null | undefined) {
    if (value === null || value === undefined) return '';
    let n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '';
    let unit = 0;
    while (n >= 1024 && unit < UNITS.length - 1) {
        n /= 1024;
        unit++;
    }
    return `${unit === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)} ${UNITS[unit]}`;
}

/*
 * Dates as the phones say them: "Today, 14:08", "Yesterday", "29 Sept", and the year
 * only when it isn't this one, "29 Sept 2025". Day and month are written the en-GB
 * way on every client; the time keeps the person's own 12 or 24 hour clock.
 */
const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const dayYearFormat = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
});
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function parse(iso: string | null | undefined) {
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
}

/* "29 Sept", or "29 Sept 2025" in another year: for "on", "until" and "ends". */
export function formatDay(iso: string | null | undefined) {
    const date = parse(iso);
    if (!date) return '';
    return date.getFullYear() === new Date().getFullYear()
        ? dayFormat.format(date)
        : dayYearFormat.format(date);
}

/* "14:08", or "2:08 pm", as the person's clock reads. */
export function formatTime(iso: string | null | undefined) {
    const date = parse(iso);
    return date ? timeFormat.format(date) : '';
}

/*
 * When something happened, for lists and facts: "Today, 14:08", "Yesterday", then
 * a day. `lower` is for the middle of a sentence: "Added today, 14:08".
 */
export function formatWhen(iso: string | null | undefined, { lower = false } = {}) {
    const date = parse(iso);
    if (!date) return '';
    const now = new Date();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const relative =
        date.toDateString() === now.toDateString()
            ? `Today, ${timeFormat.format(date)}`
            : date.toDateString() === yesterday.toDateString()
              ? 'Yesterday'
              : null;
    if (!relative) return formatDay(iso);
    return lower ? relative[0]!.toLowerCase() + relative.slice(1) : relative;
}

/* What a folder list is ordered by, as on the phone apps. */
export type SortKey = 'name' | 'modified' | 'size';
export type SortOrder = { key: SortKey; ascending: boolean };
export const DEFAULT_SORT: SortOrder = { key: 'name', ascending: true };

/* Folders first whichever key is chosen, as every drive does it; equal values fall back to the name. */
export function sortNodesBy(nodes: DriveNode[], order: SortOrder) {
    const value = (node: DriveNode) => {
        if (order.key === 'modified')
            return Date.parse(node.metadata?.modified ?? node.updatedAt) || 0;
        const size = nodeSize(node);
        return size === null || Number.isNaN(size) ? 0 : size;
    };
    return [...nodes].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
        const primary = order.key === 'name' ? 0 : value(a) - value(b);
        const result = primary !== 0 ? primary : collator.compare(a.name, b.name);
        return order.ascending ? result : -result;
    });
}

/* The size a file shows: what its version envelope sealed, else what its metadata says. */
/* An item's name as the person sees it: their top folder is "My files", whatever it is stored as. */
export function displayName(node: Pick<DriveNode, 'name' | 'parentId'>) {
    return node.parentId === null ? ROOT_LABEL : node.name;
}

export function nodeSize(node: DriveNode) {
    if (node.kind !== 'file') return null;
    return contentSize(node) ?? node.metadata?.size ?? NaN;
}

/*
 * A request that never reached the server fails with the browser's own words:
 * "Failed to fetch" (Chromium), "Load failed" (Safari), "NetworkError when
 * attempting to fetch resource." (Firefox). Said instead as what to do.
 */
export const OFFLINE_WORDS = 'Couldn’t reach HushOS. Check your connection, then try again.';
export function isNetworkFailure(message: string | null | undefined) {
    return Boolean(message && /^(failed to fetch|load failed|networkerror\b)/i.test(message));
}

export function driveError(error: unknown) {
    if (!(error instanceof Error)) return 'Please try again.';
    return isNetworkFailure(error.message) ? OFFLINE_WORDS : error.message;
}

/* Where the catalogue build is, for search results and the sidebar to follow. */
const idleCatalogue = { phase: 'idle', pulled: 0, opened: 0, error: null } as const;
export function useCatalogueState() {
    return useSyncExternalStore(
        driveClient.subscribeCatalogue,
        () => driveClient.catalogueState,
        () => idleCatalogue,
    );
}
