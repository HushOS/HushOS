import type { DriveNode } from '@hushos/drive/client';
import type { QueryClient } from '@tanstack/react-query';
import { toast } from '@/components/ui/toast';
import { driveClient, driveError, driveKeys } from '@/lib/drive';

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

/* On opening Drive: a rotation left unfinished, by this tab or another device. */
export function resumePendingRotation(queryClient: QueryClient) {
    if (!driveClient.pendingRotation() || running) return;
    running = announce(queryClient, null, driveClient.resumeRotation()).finally(() => {
        running = null;
    });
}
