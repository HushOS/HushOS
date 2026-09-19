import type { DriveNode } from '@hushos/drive/client';
import type { QueryClient } from '@tanstack/react-query';
import { toast } from '@/components/ui/toast';
import { driveClient, driveError, driveKeys, folderQueryOptions } from '@/lib/drive';

/*
 * Revocation stops the server; rotation shuts the door. After a share or link
 * is stopped, the owner's device re-keys the node and everything beneath it,
 * re-sealing what remains shared. It runs in the background of the tab and,
 * if the tab closes first, resumes the next time this account opens Drive.
 */

let running: Promise<unknown> | null = null;

async function announce(
    queryClient: QueryClient,
    name: string | null,
    work: Promise<{ rotated: number } | null>,
) {
    const id = toast.add({
        type: 'loading',
        title: name ? `Rotating the keys of “${name}”` : 'Finishing a key rotation',
        description: 'Whoever was cut off keeps no key that still opens anything here.',
        timeout: 0,
    });
    try {
        const result = await work;
        toast.close(id);
        if (result)
            toast.add({
                type: 'success',
                title: 'Keys rotated',
                description: `${result.rotated} ${result.rotated === 1 ? 'item' : 'items'} re-keyed and re-sealed.`,
            });
    } catch (error) {
        toast.close(id);
        toast.add({
            type: 'error',
            title: 'Key rotation did not finish',
            description: `${driveError(error)} It resumes the next time you open Drive.`,
        });
    } finally {
        // Every envelope under the root changed: listings and shares are stale.
        await queryClient.invalidateQueries({ queryKey: driveKeys.all });
    }
}

/* Rotate after a revocation; a rotation already running in this tab finishes first. */
export function rotateAfterRevoke(queryClient: QueryClient, node: DriveNode) {
    const previous = running ?? Promise.resolve();
    running = previous.then(() => announce(queryClient, node.name, driveClient.rotate(node)));
    return running;
}

/* Settles when any rotation this tab started has finished; at once when none has. */
export function rotationSettled(): Promise<unknown> {
    return running ?? Promise.resolve();
}

/*
 * The node as it is now, for anything sealed under its key. A dialog keeps the
 * node it was opened with, and stopping a share or link from that same dialog
 * rotates the key beneath it; a seal under the epoch it remembers would be
 * refused by the worker and the server alike. So: let the rotation finish, then
 * read the node back from the listing the rotation refreshed.
 */
export async function currentNode(queryClient: QueryClient, node: DriveNode): Promise<DriveNode> {
    await rotationSettled();
    if (!node.parentId) return node;
    const listing = await queryClient.fetchQuery(folderQueryOptions(node.parentId));
    return listing.children.find((child) => child.id === node.id) ?? node;
}

/* On opening Drive: a rotation left unfinished, by this tab or another device. */
export function resumePendingRotation(queryClient: QueryClient) {
    if (!driveClient.pendingRotation() || running) return;
    running = announce(queryClient, null, driveClient.resumeRotation()).finally(() => {
        running = null;
    });
}
