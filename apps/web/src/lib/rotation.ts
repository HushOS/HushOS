import type { DriveNode } from '@hushos/drive/client';
import type { QueryClient } from '@tanstack/react-query';
import { toast } from '@/components/ui/toast';
import { authClient } from '@/lib/auth-client';
import { sharingLedger } from '@/lib/contacts';
import { driveClient, driveError, driveKeys, folderQueryOptions } from '@/lib/drive';
import { stopSharingWith } from '@/lib/stop-sharing';

/*
 * Revocation stops the server; rotation shuts the door. After a share or link
 * is stopped, the owner's device re-keys the node and everything beneath it,
 * re-sealing what remains shared. It runs in the background of the tab and,
 * if the tab closes first, resumes the next time this account opens Drive.
 */

let running: Promise<unknown> | null = null;
let finished = 0;

/*
 * When a rotation stops (most often because the people this person trusts
 * could not be loaded, and nothing is ever re-signed without them), it is
 * tried again after these pauses, then left for the next time Drive opens.
 */
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];

/*
 * Runs quietly: stopping a share or a link already said what happened, and the
 * re-keying behind it is not something a person acts on. Only a failure is
 * said, once, since it is tried again on its own. Each finished rotation is
 * counted on the document, so a test can wait for the door to shut.
 */
async function quietly(
    queryClient: QueryClient,
    name: string | null,
    work: () => Promise<{ rotated: number } | null>,
    attempt = 0,
): Promise<void> {
    try {
        await work();
        countFinishedRotation();
    } catch (error) {
        const last = attempt >= RETRY_DELAYS_MS.length;
        if (attempt === 0 || last)
            toast.add({
                type: 'error',
                title: name
                    ? `Stopping access to “${name}” didn’t finish`
                    : 'Stopping access didn’t finish',
                description: `${driveError(error)} ${
                    last
                        ? 'HushOS finishes it the next time you open your files.'
                        : 'HushOS tries again shortly.'
                }`,
            });
        if (!last) retryLater(queryClient, name, work, attempt + 1);
    } finally {
        // Every envelope under the root changed: listings and shares are stale.
        await queryClient.invalidateQueries({ queryKey: driveKeys.all });
    }
}

/* One more key change walked to its end on this page (a family folder's too), for tests to wait on. */
export function countFinishedRotation() {
    finished++;
    document.documentElement.dataset.keyRotations = String(finished);
}

function retryLater(
    queryClient: QueryClient,
    name: string | null,
    work: () => Promise<{ rotated: number } | null>,
    attempt: number,
) {
    const unlocked = authClient.store.getState().unlockedUserId;
    setTimeout(
        () => {
            // Locked or signed out meanwhile: the next open resumes it instead.
            if (!unlocked || authClient.store.getState().unlockedUserId !== unlocked) return;
            const previous = running ?? Promise.resolve();
            running = previous.then(() => quietly(queryClient, name, work, attempt));
        },
        RETRY_DELAYS_MS[attempt - 1],
    );
}

/* Rotate after a revocation; a rotation already running in this tab finishes first. */
export function rotateAfterRevoke(queryClient: QueryClient, node: DriveNode) {
    const previous = running ?? Promise.resolve();
    // Starting again learns of the rotation the server already holds for the node.
    running = previous.then(() => quietly(queryClient, node.name, () => driveClient.rotate(node)));
    return running;
}

/*
 * Stop sharing with Maya (lib/stop-sharing.ts): every share with them revoked
 * here, then each item re-keyed in the background, as one stopped share is.
 */
export async function stopSharingWithPerson(queryClient: QueryClient, contactId: string) {
    const { stopped } = await stopSharingWith(contactId, {
        ledger: sharingLedger(() => authClient.store.getState().unlockedUserId),
        shares: () => driveClient.mySharing(),
        revoke: (node, shareId) => driveClient.revokeShare(node, shareId),
        rotate: (node) => rotateAfterRevoke(queryClient, node),
    });
    await queryClient.invalidateQueries({ queryKey: driveKeys.all });
    return stopped;
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
    running = quietly(queryClient, null, () => driveClient.resumeRotation()).finally(() => {
        running = null;
    });
}
