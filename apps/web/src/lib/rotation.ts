import type { DriveNode } from '@hushos/drive/client';
import type { QueryClient } from '@tanstack/react-query';
import { toast } from '@/components/ui/toast';
import { authClient } from '@/lib/auth-client';
import { stopWork } from '@/lib/contacts';
import { driveClient, driveError, driveKeys, folderQueryOptions } from '@/lib/drive';
import {
    owe,
    rekeyAll,
    resumeStopping,
    stopSharingWith,
    type StopSharingParts,
} from '@/lib/stop-sharing';

/*
 * Revocation stops the server; rotation shuts the door. After a share or link
 * is stopped, the owner's device re-keys the node and everything beneath it,
 * re-sealing what remains shared. Every re-key owed is recorded in the
 * settings before the share or link is stopped (lib/contacts.ts stopWork), one
 * item after another, and crossed off only once it finished, so the whole
 * queue, not just the rotation the server is running, survives a closed tab:
 * it runs in the background and resumes the next time this account opens
 * Drive, on any of its devices.
 */
const owed = stopWork(() => authClient.store.getState().unlockedUserId);

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

/*
 * Every re-key owed, oldest first, each crossed off once it finished (or its
 * item is gone for good): a rotation the server already runs for this account
 * first, since it allows one at a time. Queued behind whatever this tab runs.
 */
function rekeyOwed(queryClient: QueryClient, name: string | null = null) {
    const previous = running ?? Promise.resolve();
    const next: Promise<unknown> = previous.then(() =>
        quietly(queryClient, name, async () => {
            if (driveClient.pendingRotation()) {
                await driveClient.resumeRotation();
                countFinishedRotation();
            }
            return rekeyAll(
                owed,
                (nodeId) => driveClient.rotateById(nodeId),
                countFinishedRotation,
            );
        }),
    );
    running = next;
    void next.finally(() => {
        if (running === next) running = null;
    });
    return next;
}

/*
 * Rotate after a revocation: recorded first (`owe`, before the share or link
 * is stopped), then run behind anything this tab is rotating already.
 */
export async function oweRotation(nodeId: string) {
    await owed.save((record) => owe(record, [nodeId]));
}
export function rotateAfterRevoke(queryClient: QueryClient, node: DriveNode) {
    return rekeyOwed(queryClient, node.name);
}

function stopParts(queryClient: QueryClient): StopSharingParts {
    return {
        work: owed,
        listed: () => driveClient.sharedByMeIds(),
        sharesOf: async (nodeId) =>
            (await driveClient.sharesOfNode(nodeId)).map((share) => ({
                id: share.id,
                granteeId: share.grantee.id,
            })),
        revoke: (_nodeId, shareId) => driveClient.endShare(shareId),
        rekey: () => rekeyOwed(queryClient),
    };
}

/*
 * Stop sharing with Maya (lib/stop-sharing.ts): every share with them revoked
 * here, then each item re-keyed in the background, as one stopped share is.
 */
export async function stopSharingWithPerson(queryClient: QueryClient, contactId: string) {
    try {
        const { stopped } = await stopSharingWith(contactId, stopParts(queryClient));
        return stopped;
    } finally {
        await queryClient.invalidateQueries({ queryKey: driveKeys.all });
    }
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

/*
 * On opening Drive: a rotation left unfinished, by this tab or another
 * device, and whatever a Stop sharing or a stopped share left owed.
 */
export function resumePendingRotation(queryClient: QueryClient) {
    if (running) return;
    void (async () => {
        const record = await owed.read();
        if (!driveClient.pendingRotation() && !record.rekey?.length && !record.stopping) return;
        await resumeStopping(stopParts(queryClient));
    })().catch((error: unknown) => {
        toast.add({
            type: 'error',
            title: 'Stopping access didn’t finish',
            description: `${driveError(error)} HushOS finishes it the next time you open your files.`,
        });
    });
}
