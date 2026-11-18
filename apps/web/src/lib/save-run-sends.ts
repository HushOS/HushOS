import type { PurgeBatchItem, TrashBatchItem } from '@hushos/drive/api';
import type { DriveNode } from '@hushos/drive/client';
import { MAX_TRASH_BATCH } from '@hushos/drive/protocol';
import {
    askAbort,
    deniedWhole,
    heldNow,
    trashFatesOf,
    trashInBatches,
    whileSignedIn,
    type ItemFate,
    type SaveRunDeps,
} from '@hushos/drive/save-runs';
import { purgeBatch, type TrashParts } from '@/lib/trash-batch';

/* The two batch routes a clean-up sends, from the workspace's own client (lib/drive.ts clientFor). */
export type CleanUpClient = {
    trashMany: (workspaceId: string, nodeIds: string[]) => Promise<{ results: TrashBatchItem[] }>;
    purgeMany: (workspaceId: string, nodeIds: string[]) => Promise<{ results: PurgeBatchItem[] }>;
};

/*
 * A save run's clean-up requests (SaveRunDeps abortUpload, trash, purge), each sent only while
 * `stillOn` (the session the run's deps were made in): checked before every batch, every delete
 * forever, every try of an abort and every resend of a busy delete, so a sign-out between two
 * sends nothing more, under no other account. `refuseChange` is asked at the same points before
 * a trash or a delete forever: a family folder that may not be changed now (read-only here, its
 * keys changed, not known) has nothing removed, and the items stay `refused` (the row kept).
 */
export function cleanUpSends(
    stillOn: () => boolean,
    clientFor: (workspaceId: string) => CleanUpClient,
    abort: (workspaceId: string, uploadId: string) => Promise<unknown>,
    refuseChange: (workspaceId: string) => Promise<string | null>,
    options: { pause?: (ms: number) => Promise<void> } = {},
): Pick<SaveRunDeps, 'abortUpload' | 'trash' | 'purge'> {
    return {
        // An upload still finishing is asked about again for about ten seconds (askAbort).
        abortUpload: (workspaceId, uploadId) =>
            askAbort(() => abort(workspaceId, uploadId), { stillOn, pause: options.pause }),
        trash: (workspaceId, ids) =>
            trashInBatches(ids, MAX_TRASH_BATCH, stillOn, async (batch) => {
                const fates = new Map<string, ItemFate>();
                if (await refuseChange(workspaceId)) {
                    for (const id of batch) fates.set(id, 'refused');
                    return fates;
                }
                try {
                    const answer = await clientFor(workspaceId).trashMany(workspaceId, batch);
                    for (const [id, fate] of trashFatesOf(answer.results)) fates.set(id, fate);
                } catch (error) {
                    // A family manager's pause is not lost access: kept for after the hold.
                    if (heldNow(error)) for (const id of batch) fates.set(id, 'held');
                    else if (deniedWhole(error)) for (const id of batch) fates.set(id, 'denied');
                    else throw error;
                }
                return fates;
            }),
        // Delete forever as the Trash page does it (lib/trash-batch.ts purgeBatch): a request the
        // workspace was too busy for is sent again, and items left `busy` too, while that helps.
        purge: async (workspaceId, ids) => {
            const refusedWhole = new Set<string>();
            const heldWhole = new Set<string>();
            const send = whileSignedIn(stillOn, (w: string, n: string[]) =>
                clientFor(w).purgeMany(w, n),
            );
            const parts: TrashParts = {
                trash: () => Promise.reject(new Error('not used')),
                restore: () => Promise.reject(new Error('not used')),
                purge: async (ws, nodeIds) => {
                    // Before every send, its resends too: refused, nothing goes (the items stay refused).
                    const refused = await refuseChange(ws);
                    if (refused) throw new Error(refused);
                    try {
                        return await send(ws, nodeIds);
                    } catch (error) {
                        if (heldNow(error)) for (const id of nodeIds) heldWhole.add(id);
                        else if (deniedWhole(error)) for (const id of nodeIds) refusedWhole.add(id);
                        throw error;
                    }
                },
                ancestorsOf: () => [],
                pause: options.pause,
            };
            const { gone } = await purgeBatch(
                ids.map((id) => ({ id, workspaceId }) as DriveNode),
                parts,
            );
            const out = new Set(gone);
            return new Map(
                ids.map((id): [string, ItemFate] => [
                    id,
                    out.has(id)
                        ? 'done'
                        : heldWhole.has(id)
                          ? 'held'
                          : refusedWhole.has(id)
                            ? 'denied'
                            : 'refused',
                ]),
            );
        },
    };
}
