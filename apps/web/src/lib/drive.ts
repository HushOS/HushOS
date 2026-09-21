import {
    contentSize,
    createDriveClient,
    createIndexedDbMirror,
    type DriveNode,
} from '@hushos/drive/client';
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
export const mySharingQueryOptions = queryOptions({
    queryKey: driveKeys.mine,
    queryFn: () => driveClient.mySharing(),
    staleTime: 15_000,
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
    ]);
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

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
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

const dateFormat = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
});
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
export function formatWhen(iso: string | null | undefined) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay ? timeFormat.format(date) : dateFormat.format(date);
}

/* The size a file shows: what its version envelope sealed, else what its metadata says. */
export function nodeSize(node: DriveNode) {
    if (node.kind !== 'file') return null;
    return contentSize(node) ?? node.metadata?.size ?? NaN;
}

export function driveError(error: unknown) {
    return error instanceof Error ? error.message : 'Please try again.';
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
