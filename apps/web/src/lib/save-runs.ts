import type { DriveNode } from '@hushos/drive/client';
import {
    createIndexedDbRunJournal,
    createMemoryRunJournal,
    type RunJournal,
    type RunRow,
} from '@hushos/drive/journal';
import { MAX_TRASH_BATCH } from '@hushos/drive/protocol';
import {
    abandonRuns,
    askAbort,
    cleanUpInterrupted,
    deniedWhole,
    interruptedRuns,
    keepInterrupted,
    roomOf,
    startRun,
    trashFatesOf,
    type ItemFate,
    type RunPlan,
    type SaveRunDeps,
} from '@hushos/drive/save-runs';
import type { QueryClient } from '@tanstack/react-query';
import { deviceSession } from '@/lib/device-session';
import {
    clientFor,
    folderQueryOptions,
    groupOfSpace,
    nextName,
    refuseWrite,
    waitsForKeyChange,
} from '@/lib/drive';
import { driveApi } from '@/lib/drive-api';
import { storageQueryOptions } from '@/lib/queries';
import { onTransferEvent, transfers } from '@/lib/transfers';
import { purgeBatch } from '@/lib/trash-batch';
import { untilWritable } from '@/lib/uploads';

/*
 * The save path on the web (packages/drive/src/save-runs.ts): File tools and
 * editing start a run here and save their results through it. No interface of
 * its own yet: the first tool brings the "interrupted" prompt (delete or keep
 * what was made), shows a run's RunStopped, and opens the storage-full dialog
 * for a refusal for room in the person's own space (SaveRefused with `room`).
 */

export {
    OWN_WRITING,
    RunStopped,
    SaveRefused,
    type SaveRun,
    type VersionSaved,
} from '@hushos/drive/save-runs';

let runJournal: RunJournal | undefined;
function runs() {
    runJournal ??=
        typeof indexedDB === 'undefined' ? createMemoryRunJournal() : createIndexedDbRunJournal();
    return runJournal;
}

// A Web Lock's name, not storage: nothing is kept under it.
const LOCK_PREFIX = 'drive-save-run:';
const locks = () => (typeof navigator === 'undefined' ? undefined : navigator.locks);

/*
 * Holds a Web Lock named for the run while it runs, so another tab's next open never takes it
 * for interrupted: resolves once the lock is granted (its row is written only then), with what
 * lets it go.
 */
function hold(runId: string) {
    return new Promise<() => void>((granted, refused) => {
        let release = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        locks()!
            .request(`${LOCK_PREFIX}${runId}`, () => {
                granted(release);
                return held;
            })
            .catch(refused);
    });
}
async function isLive(runId: string) {
    const state = await locks()!.query();
    return (state.held ?? []).some((lock) => lock.name === `${LOCK_PREFIX}${runId}`);
}

/* The account's storage figures as the server has them now, not the sidebar's cached copy. */
function storageNow(queryClient: QueryClient) {
    return queryClient.fetchQuery({ ...storageQueryOptions, staleTime: 0 });
}

function deps(queryClient: QueryClient): SaveRunDeps {
    const from = { generation: deviceSession.generation() };
    const ownWorkspace = async () =>
        (
            queryClient.getQueryData(storageQueryOptions.queryKey) ??
            (await storageNow(queryClient).catch(() => null))
        )?.workspaceId ?? null;
    return {
        transfers,
        events: onTransferEvent,
        runs: runs(),
        refuseWrite,
        waitsForKeyChange,
        room: async (workspaceId) =>
            roomOf(await storageNow(queryClient), workspaceId, groupOfSpace(workspaceId)),
        namesIn: async (folder) =>
            (
                await queryClient.fetchQuery({
                    ...folderQueryOptions(folder.id, folder.workspaceId),
                    staleTime: 0,
                })
            ).children.map((child) => child.name),
        nextName,
        makeFolder: async (parent, name, signAs, minted) => {
            const writable = await untilWritable(queryClient, parent);
            const [made] = await clientFor(writable.workspaceId).createFolderPath(
                writable,
                [name],
                // The run records the folder's id before its creation is sent.
                { signAs, onMinted: ([id]) => minted(id!) },
            );
            return made!;
        },
        // An upload still finishing is asked about again for about ten seconds (askAbort).
        abortUpload: (workspaceId, uploadId) =>
            askAbort(() => driveApi.abortUpload(workspaceId, uploadId)),
        trash: async (workspaceId, ids) => {
            const fates = new Map<string, ItemFate>();
            for (let at = 0; at < ids.length; at += MAX_TRASH_BATCH) {
                const batch = ids.slice(at, at + MAX_TRASH_BATCH);
                try {
                    const answer = await clientFor(workspaceId).trashMany(workspaceId, batch);
                    for (const [id, fate] of trashFatesOf(answer.results)) fates.set(id, fate);
                } catch (error) {
                    if (!deniedWhole(error)) throw error;
                    for (const id of batch) fates.set(id, 'denied');
                }
            }
            return fates;
        },
        // Delete forever as the Trash page does it (lib/trash-batch.ts purgeBatch): a request the
        // workspace was too busy for is sent again, and items left `busy` too, while that helps.
        purge: async (workspaceId, ids) => {
            const refusedWhole = new Set<string>();
            const { gone } = await purgeBatch(
                ids.map((id) => ({ id, workspaceId }) as DriveNode),
                {
                    trash: () => Promise.reject(new Error('not used')),
                    restore: () => Promise.reject(new Error('not used')),
                    purge: async (ws, nodeIds) => {
                        try {
                            return await clientFor(ws).purgeMany(ws, nodeIds);
                        } catch (error) {
                            if (deniedWhole(error)) for (const id of nodeIds) refusedWhole.add(id);
                            throw error;
                        }
                    },
                    ancestorsOf: () => [],
                },
            );
            const out = new Set(gone);
            return new Map(
                ids.map((id): [string, ItemFate] => [
                    id,
                    out.has(id) ? 'done' : refusedWhole.has(id) ? 'denied' : 'refused',
                ]),
            );
        },
        // The server deletes forever only for a member: the person's own Drive, a family's folder.
        mayPurge: async (workspaceId) =>
            groupOfSpace(workspaceId) !== null || workspaceId === (await ownWorkspace()),
        hold: locks() ? hold : undefined,
        isLive: locks() ? isLive : undefined,
        from,
        current: () => deviceSession.open() && deviceSession.generation() === from.generation,
    };
}

/*
 * Starts a run that writes into `plan.targets` (folders for new files, files
 * for new versions). Each result says what it was made from (`sources`, or
 * OWN_WRITING), and is signed as the weakest of them. Throws SaveRefused
 * before anything is made.
 */
export async function startSaveRun(queryClient: QueryClient, plan: RunPlan) {
    return startRun(deps(queryClient), plan);
}

/* Runs a closed tab left behind (ids only), for the next open to offer to delete or keep what they made. */
export function interruptedSaveRuns() {
    return interruptedRuns({ runs: runs(), isLive: locks() ? isLive : undefined });
}

/* Deletes what an interrupted run made (to the Trash where the person may not delete forever). */
export async function cleanUpSaveRun(queryClient: QueryClient, row: RunRow) {
    return cleanUpInterrupted(deps(queryClient), row);
}

/* Keeps what an interrupted run made: its row goes, its open uploads are aborted. */
export async function keepSaveRun(queryClient: QueryClient, row: RunRow) {
    return keepInterrupted(deps(queryClient), row);
}

/* A sign-out, here or in another tab: every run stops at once, writing nothing (packages/drive abandonRuns). */
export { abandonRuns };

/* What a run would name a result in `folder`, shown and editable before saving. */
export async function suggestedName(queryClient: QueryClient, folder: DriveNode, name: string) {
    const listing = await queryClient.fetchQuery(folderQueryOptions(folder.id, folder.workspaceId));
    return nextName(name, new Set(listing.children.map((child) => child.name)));
}
