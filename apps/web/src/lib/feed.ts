import type { NodeChange } from '@hushos/drive/api';
import { DriveApiError } from '@hushos/drive/api';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { driveClient, driveKeys, sharedQueryOptions } from '@/lib/drive';

/*
 * Listings stay fresh without a reload: the tab polls the workspace's change
 * feed and the feed of every share it holds, and marks the folders a change
 * touches as stale so the query layer refetches what is on screen. Polling
 * pauses while the tab is hidden, backs off on failure, and a share that
 * answers 410 unmounts by refreshing the Shared list.
 */

export const FEED_INTERVAL_MS = 8_000;

/* What a page of changes makes stale: the parents of changed nodes, the folders themselves, the trash. */
function apply(queryClient: QueryClient, changes: NodeChange[]) {
    const folders = new Set<string>();
    let trash = false;
    for (const change of changes) {
        switch (change.kind) {
            case 'node':
                if (change.node.parentId) folders.add(change.node.parentId);
                if (change.node.kind === 'folder') folders.add(change.node.id);
                if (change.node.trashedAt) trash = true;
                break;
            case 'tombstone':
                if (change.parentId) folders.add(change.parentId);
                folders.add(change.nodeId);
                trash = true;
                break;
            case 'entered':
            case 'left':
                folders.add(change.nodeId);
                break;
        }
    }
    for (const id of folders)
        void queryClient.invalidateQueries({ queryKey: driveKeys.folder(id) });
    if (trash) void queryClient.invalidateQueries({ queryKey: driveKeys.trash });
    return folders.size > 0 || trash;
}

type Cursor = { since: number; failures: number };

/* Mounted once inside the Drive shell. */
export function useChangeFeed(workspaceId: string | null, initialSeq: number) {
    const queryClient = useQueryClient();
    // Only once Drive is open: mounting shares needs the account's identity in the worker.
    const shares = useQuery({ ...sharedQueryOptions, enabled: workspaceId !== null });
    const own = useRef<Cursor>({ since: initialSeq, failures: 0 });
    const perShare = useRef(new Map<string, Cursor>());
    const mounted = shares.data;

    useEffect(() => {
        if (!workspaceId) return;
        let stopped = false;
        let timer: number | undefined;
        async function tick() {
            if (stopped) return;
            if (document.visibilityState === 'visible') {
                await pollOwn();
                await pollShares();
            }
            if (!stopped) timer = window.setTimeout(() => void tick(), FEED_INTERVAL_MS);
        }
        async function pollOwn() {
            const cursor = own.current;
            try {
                let page = await driveClient.changesSince(workspaceId!, cursor.since);
                apply(queryClient, page.changes);
                cursor.since = page.nextCursor;
                // A backlog after a long sleep: drain it in a few more pages, then rest.
                for (let more = 0; page.hasMore && more < 5; more++) {
                    page = await driveClient.changesSince(workspaceId!, cursor.since);
                    apply(queryClient, page.changes);
                    cursor.since = page.nextCursor;
                }
                cursor.failures = 0;
            } catch {
                cursor.failures++;
            }
        }
        async function pollShares() {
            for (const mount of mounted ?? []) {
                if (mount.error) continue;
                const cursor =
                    perShare.current.get(mount.id) ??
                    perShare.current
                        .set(mount.id, { since: mount.changeSeq, failures: 0 })
                        .get(mount.id)!;
                // Back off a failing share feed: one try per 2^failures ticks, capped.
                if (cursor.failures && Math.random() > 1 / Math.min(2 ** cursor.failures, 16))
                    continue;
                try {
                    const page = await driveClient.shareChangesSince(mount.id, cursor.since);
                    apply(queryClient, page.changes);
                    cursor.since = page.nextCursor;
                    cursor.failures = 0;
                } catch (error) {
                    if (
                        error instanceof DriveApiError &&
                        (error.status === 410 || error.status === 404)
                    ) {
                        // The share ended: the Shared list and every folder it showed are stale.
                        perShare.current.delete(mount.id);
                        void queryClient.invalidateQueries({ queryKey: driveKeys.shared });
                        void queryClient.invalidateQueries({
                            queryKey: driveKeys.folder(mount.node.id),
                        });
                    } else cursor.failures++;
                }
            }
        }
        const onVisible = () => {
            if (document.visibilityState === 'visible') {
                window.clearTimeout(timer);
                void tick();
            }
        };
        document.addEventListener('visibilitychange', onVisible);
        timer = window.setTimeout(() => void tick(), FEED_INTERVAL_MS);
        return () => {
            stopped = true;
            window.clearTimeout(timer);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [workspaceId, queryClient, mounted]);
}
