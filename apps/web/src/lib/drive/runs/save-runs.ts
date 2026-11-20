import { DriveApiError } from '@hushos/drive/api';
import type { DriveNode } from '@hushos/drive/client';
import { createIndexedDbRunJournal, type RunJournal, type RunRow } from '@hushos/drive/journal';
import {
    abandonRuns,
    lockRuns,
    cleanUpInterrupted,
    interruptedRuns,
    keepInterrupted,
    roomOf,
    SignedOutError,
    startRun,
    UNCOUNTED,
    type RunPlan,
    type SaveRunDeps,
} from '@hushos/drive/save-runs';
import type { QueryClient } from '@tanstack/react-query';
import { authClient } from '@/lib/auth/auth-client';
import { deviceSession } from '@/lib/account/device-session';
import {
    clientFor,
    folderQueryOptions,
    sharedQueryOptions,
    groupOfSpace,
    nextName,
    refuseChange,
    refuseWrite,
    waitsForKeyChange,
} from '@/lib/drive/drive';
import { driveApi } from '@/lib/drive/drive-api';
import { storageQueryOptions } from '@/lib/billing/queries';
import { onTransferEvent, transfers } from '@/lib/drive/transfers/transfers';
import { cleanUpSends } from '@/lib/drive/runs/save-run-sends';
import { untilWritable } from '@/lib/drive/transfers/uploads';

/*
 * The save path on the web (packages/drive/src/save-runs.ts): File tools and
 * editing start a run here and save their results through it. No interface of
 * its own yet: the first tool brings the "interrupted" prompt (delete or keep
 * what was made), shows a run's RunStopped, and opens the storage-full dialog
 * for a refusal for room in the person's own space (SaveRefused with `room`).
 */

export {
    OWN_WRITING,
    RecordNotUpdated,
    RunStopped,
    SaveRefused,
    type SaveRun,
    type VersionSaved,
} from '@hushos/drive/save-runs';

/*
 * A browser that can't keep the run's record (no IndexedDB) or hold its lock (no Web Locks) saves
 * nothing: what a run made must be named on disk before it is sent, and its lock is what keeps
 * every other tab from taking it for interrupted, or recovering it, while it runs. A memory journal
 * would forget it with the tab (it stays for tests only, in packages/drive). Every browser HushOS
 * supports has both.
 */
export const NO_RECORD = 'This browser can’t keep a record of this save, so it wasn’t started.';
const persistent = () => typeof indexedDB !== 'undefined' && locks() !== undefined;

let runJournal: RunJournal | undefined;
function runs() {
    if (!persistent()) throw new Error(NO_RECORD);
    runJournal ??= createIndexedDbRunJournal();
    return runJournal;
}

// A Web Lock's name, not storage: nothing is kept under it. The run holds it for its whole life;
// another tab's Keep, Delete or quiet settling takes it only if it is free (exclusive).
const LOCK_PREFIX = 'drive-save-run:';
function locks() {
    return typeof navigator === 'undefined' ? undefined : navigator.locks;
}

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
    // The session these deps were made in: nothing is sent or written for it once it ends.
    const stillOn = () => deviceSession.open() && deviceSession.generation() === from.generation;
    /*
     * Why a clean-up may not change anything in `workspaceId` now: a family folder registered here
     * says so itself (read-only, its keys changed, forgotten); this account's own Drive and a share
     * it edits may be; any other is a family folder not open in this tab yet, which isn't known.
     */
    const refuseChangeNow = async (workspaceId: string): Promise<string | null> => {
        const registered = refuseChange(workspaceId);
        if (registered !== undefined) return registered;
        const notKnown = 'Open the family again, then try again.';
        const figures = await storage();
        if (!figures) return notKnown;
        if (workspaceId === figures.workspaceId) return null;
        const shares = await queryClient.fetchQuery(sharedQueryOptions).catch(() => null);
        if (shares?.some((mount) => mount.workspaceId === workspaceId)) return null;
        return notKnown;
    };
    // The account unlocked as these deps were made: written into every row, and only its rows recovered.
    const account = authClient.store.getState().unlockedUserId;
    const storage = async () =>
        queryClient.getQueryData(storageQueryOptions.queryKey) ??
        (await storageNow(queryClient).catch(() => null));
    return {
        transfers,
        events: onTransferEvent,
        runs: runs(),
        account,
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
        // A refused creation's folder, as the server lists it now (a key change moved its epoch).
        lookFolderAgain: async (folder) =>
            (
                await queryClient.fetchQuery({
                    ...folderQueryOptions(folder.id, folder.workspaceId),
                    staleTime: 0,
                })
            ).folder,
        // Answered 409 for its own id: the folder as the server lists it now, if it is there.
        findChild: async (parent, id) =>
            (
                await queryClient.fetchQuery({
                    ...folderQueryOptions(parent.id, parent.workspaceId),
                    staleTime: 0,
                })
            ).children.find((child) => child.id === id) ?? null,
        // How many items a folder holds now, every page counted; null when it isn't there. Only looks.
        lookFolder: async (workspaceId, id) => {
            let items = 0;
            let after: string | undefined;
            try {
                do {
                    // Each page only while this session lasts: a sign-out stops the look, unsettled.
                    if (!stillOn()) throw new SignedOutError();
                    const page = await driveApi.children(workspaceId, id, after);
                    items += page.children.length;
                    after = page.nextCursor ?? undefined;
                } while (after);
            } catch (error) {
                if (error instanceof DriveApiError && error.status === 404) return null;
                // In the Trash: there, and the person decides what goes. Its items can't be listed,
                // so how many it holds isn't known (never taken for none).
                if (error instanceof DriveApiError && error.code === 'trashed') return UNCOUNTED;
                throw error;
            }
            return items;
        },
        // Every clean-up request, and each retry, only while this session lasts, and a trash or a
        // delete forever only while a family folder may be changed (lib/drive/runs/save-run-sends.ts).
        ...cleanUpSends(
            stillOn,
            clientFor,
            (workspaceId, uploadId) => driveApi.abortUpload(workspaceId, uploadId),
            refuseChangeNow,
        ),
        // The server deletes forever only for a member: the person's own Drive, a family's folder.
        // A family member's workspace not registered yet (its family's pages not loaded, at open)
        // may be a family folder: not known, so the row stays (asked again later), never retired
        // after only a trash.
        mayPurge: async (workspaceId) => {
            if (groupOfSpace(workspaceId) !== null) return true;
            const figures = await storage();
            if (!figures) return null;
            if (workspaceId === figures.workspaceId) return true;
            // Another person's share this account edits: never deleted forever here.
            const shares = await queryClient.fetchQuery(sharedQueryOptions).catch(() => null);
            if (!shares) return null;
            if (shares.some((mount) => mount.workspaceId === workspaceId)) return false;
            // Neither: a family folder whose family isn't registered in this tab yet (pooled or not,
            // billing or not). Not known, so the row stays until it is.
            return null;
        },
        hold,
        isLive,
        from,
        current: stillOn,
        // The run's own lock, if no tab holds it: never waits on a live run (a frozen tab's included).
        exclusive: <T>(runId: string, work: () => Promise<T>) =>
            locks()!.request(`${LOCK_PREFIX}${runId}`, { ifAvailable: true }, (lock) =>
                lock ? work() : null,
            ) as Promise<T | null>,
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

/*
 * Runs a closed tab left behind (ids only), for the next open to offer to delete or keep what they
 * made. Settled here and never offered: a row with nothing made, only reservations to let go, and
 * one the person already answered "delete" for that waits for a folder that may still land.
 */
export function interruptedSaveRuns(queryClient: QueryClient) {
    // Nothing kept here, so nothing was left behind.
    if (!persistent()) return Promise.resolve([]);
    return interruptedRuns(deps(queryClient));
}

/* Deletes what an interrupted run made (to the Trash where the person may not delete forever). */
export async function cleanUpSaveRun(queryClient: QueryClient, row: RunRow) {
    return cleanUpInterrupted(deps(queryClient), row);
}

/* Keeps what an interrupted run made: its row is marked kept, its open uploads are aborted. */
export async function keepSaveRun(queryClient: QueryClient, row: RunRow) {
    return keepInterrupted(deps(queryClient), row);
}

/* A sign-out, here or in another tab: every run stops at once, writing nothing (packages/drive abandonRuns). */
export { abandonRuns };

/* The device locked: every run stops and cleans up, a paused or completing result included (packages/drive lockRuns). */
export function lockSaveRuns() {
    return lockRuns();
}

/* What a run would name a result in `folder`, shown and editable before saving. */
export async function suggestedName(queryClient: QueryClient, folder: DriveNode, name: string) {
    const listing = await queryClient.fetchQuery(folderQueryOptions(folder.id, folder.workspaceId));
    return nextName(name, new Set(listing.children.map((child) => child.name)));
}
