import type { DriveNode } from '@hushos/drive/client';
import {
    createIndexedDbRunJournal,
    createMemoryRunJournal,
    type RunJournal,
    type RunRow,
} from '@hushos/drive/journal';
import { MAX_TRASH_BATCH } from '@hushos/drive/protocol';
import {
    cleanUpInterrupted,
    interruptedRuns,
    startRun,
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
import { untilWritable } from '@/lib/uploads';

/*
 * The save path on the web (packages/drive/src/save-runs.ts): File tools and
 * editing start a run here and save their results through it. No interface of
 * its own yet: the first tool brings the "interrupted" prompt, and a refusal
 * for room in the person's own space opens the storage-full dialog from there.
 */

export { SaveRefused, RunStopped, type SaveRun, type VersionSaved } from '@hushos/drive/save-runs';

let runJournal: RunJournal | undefined;
function runs() {
    runJournal ??=
        typeof indexedDB === 'undefined' ? createMemoryRunJournal() : createIndexedDbRunJournal();
    return runJournal;
}

// A Web Lock's name, not storage: nothing is kept under it.
const LOCK_PREFIX = 'drive-save-run:';

/* Holds a Web Lock named for the run while it runs: another tab's next open never takes it for interrupted. */
function hold(runId: string) {
    if (typeof navigator === 'undefined' || !navigator.locks) return () => {};
    let release = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    void navigator.locks.request(`${LOCK_PREFIX}${runId}`, () => held).catch(() => {});
    return release;
}
async function isLive(runId: string) {
    if (typeof navigator === 'undefined' || !navigator.locks) return false;
    const state = await navigator.locks.query();
    return (state.held ?? []).some((lock) => lock.name === `${LOCK_PREFIX}${runId}`);
}

/* The account's storage figures as the server has them now, not the sidebar's cached copy. */
function storageNow(queryClient: QueryClient) {
    return queryClient.fetchQuery({ ...storageQueryOptions, staleTime: 0 });
}

function inBatches(ids: string[], send: (batch: string[]) => Promise<unknown>) {
    return (async () => {
        for (let at = 0; at < ids.length; at += MAX_TRASH_BATCH)
            await send(ids.slice(at, at + MAX_TRASH_BATCH));
    })();
}

function deps(queryClient: QueryClient): SaveRunDeps {
    const ownWorkspace = () =>
        queryClient.getQueryData(storageQueryOptions.queryKey)?.workspaceId ?? null;
    return {
        transfers,
        events: onTransferEvent,
        runs: runs(),
        refuseWrite,
        waitsForKeyChange,
        /*
         * Known for the person's own Drive, and for a family folder whose family's pool their
         * figures are (docs/families-shared-pool.md: a pool's figures are whole GiB, available
         * rounded down, so the check errs towards refusing). Never for someone else's share.
         */
        freeSpace: async (workspaceId) => {
            const storage = await storageNow(queryClient);
            if (!storage) return null;
            const family = groupOfSpace(workspaceId);
            const ours =
                workspaceId === storage.workspaceId ||
                (family !== null && storage.pool?.groupId === family);
            return ours ? Number(storage.availableBytes) : null;
        },
        namesIn: async (folder) =>
            (
                await queryClient.fetchQuery({
                    ...folderQueryOptions(folder.id, folder.workspaceId),
                    staleTime: 0,
                })
            ).children.map((child) => child.name),
        nextName,
        makeFolder: async (parent, name, signAs) => {
            const writable = await untilWritable(queryClient, parent);
            const [made] = await clientFor(writable.workspaceId).createFolderPath(
                writable,
                [name],
                {
                    signAs,
                },
            );
            return made!;
        },
        abortUpload: async (workspaceId, uploadId) => {
            await driveApi.abortUpload(workspaceId, uploadId);
        },
        trash: (workspaceId, ids) =>
            inBatches(ids, (batch) => clientFor(workspaceId).trashMany(workspaceId, batch)),
        purge: (workspaceId, ids) =>
            inBatches(ids, (batch) => clientFor(workspaceId).purgeMany(workspaceId, batch)),
        // The server deletes forever only for a member: the person's own Drive, a family's folder.
        mayPurge: (workspaceId) =>
            workspaceId === ownWorkspace() || groupOfSpace(workspaceId) !== null,
        hold,
        isLive,
        from: { generation: deviceSession.generation() },
    };
}

/*
 * Starts a run that writes into `plan.targets` (folders for new files, files
 * for new versions), signed as `plan.signAs`: sourcesSignatureForms of its
 * sources (@hushos/drive/trust), or ordinary for the person's own writing.
 * Throws SaveRefused before anything is made.
 */
export async function startSaveRun(queryClient: QueryClient, plan: RunPlan) {
    return startRun(deps(queryClient), plan);
}

/* Runs a closed tab left behind (ids only), for the next open to offer to delete what they made. */
export function interruptedSaveRuns() {
    return interruptedRuns({ runs: runs(), isLive });
}

/* Deletes what an interrupted run made (to the Trash where the person may not delete forever). */
export async function cleanUpSaveRun(queryClient: QueryClient, row: RunRow) {
    await storageNow(queryClient);
    return cleanUpInterrupted(deps(queryClient), row);
}

/* What a run would name a result in `folder`, shown and editable before saving. */
export async function suggestedName(queryClient: QueryClient, folder: DriveNode, name: string) {
    const listing = await queryClient.fetchQuery(folderQueryOptions(folder.id, folder.workspaceId));
    return nextName(name, new Set(listing.children.map((child) => child.name)));
}
