import type { useRouter } from '@tanstack/react-router';
import { authClient } from '@/lib/auth-client';
import { holdAuthView } from '@/lib/auth-view';
import { announceSignOut, forgetBrowserData, within } from '@/lib/device-data';
import { forgetReturn } from '@/lib/return-to';
import { forgetSession } from '@/lib/session';
import { holdSignIn, markSignedOut } from '@/lib/sign-in-gate';
import { loadPage } from '@/lib/load-page';

/*
 * What Drive kept on this device between visits, which would otherwise outlive
 * the account here: unfinished uploads are stopped, their journal (file names
 * and chunk digests) and their stashed bytes (sealed copies) deleted; the
 * mirrored tree (ciphertext, but its shape, sizes and times) is deleted;
 * families' sealed records and family folders' mirrors are deleted;
 * and a saved return to a link (its key in the fragment) goes. Drive
 * loads on demand, so a page that never opened it does not pull it in here.
 */
export async function forgetDevice() {
    try {
        await clearDevice();
        return true;
    } catch (error) {
        // Signing out goes on regardless; what stayed is said, never silently kept.
        console.error('Some of what HushOS kept on this device could not be cleared.', error);
        return false;
    }
}

/* How long each part of clearing the device may take before it is given up on. */
export const CLEAR_PART_MS = 6_000;

/* Clearing the device did not finish: what stayed is named in `cause`, and a later try may get it. */
export class DeviceNotCleared extends Error {
    override name = 'DeviceNotCleared';
    constructor(cause: unknown) {
        super('Some of what HushOS kept on this browser could not be deleted.', { cause });
    }
}

/*
 * The same, failing when any part did not clear: a removed device acknowledges its removal
 * (and lets go of the cookie) only once this resolved, so a blocked store is tried again.
 * Drive's parts are stopped by their owners first, without opening anything to empty it (a
 * store opened while its deletion waits on another tab waits too, with no end); then
 * everything this browser keeps for an account is deleted by name. What that is lives in one
 * list, lib/device-data.ts: a new store that holds anything of an account is registered
 * there. Each part gives up after CLEAR_PART_MS, so this always settles, with
 * DeviceNotCleared when anything stayed.
 */
export async function clearDevice() {
    const results = await Promise.allSettled([clearDrive()]);
    results.push(
        ...(await Promise.allSettled([
            within(forgetBrowserData(), CLEAR_PART_MS, 'Device storage did not clear in time.'),
        ])),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw new DeviceNotCleared(failed.reason);
}

async function clearDrive() {
    forgetReturn();
    // Every part is tried whatever another does; the first failure is reported once all settled.
    const results = await Promise.allSettled(
        [
            // Uploads stop; their journal goes with the databases below, never opened to be emptied.
            import('@/lib/transfers').then(({ transfers }) => transfers.invalidate()),
            // The sealed stash and the key for it, whatever the uploads left.
            import('@/lib/stash').then(({ forgetStash }) => forgetStash()),
            // Families: the sealed chain records, outbox and joins, and every family folder's
            // mirror (the 1c plan, 1.3). Membership is the social graph; none of it stays.
            import('@/lib/groups/store').then(({ deleteGroupDevice }) => deleteGroupDevice()),
        ].map((part) => within(part, CLEAR_PART_MS, 'Part of this device did not clear in time.')),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
}

/* How long signing out lets uploads stop, while the session can still release them. */
export const STOP_UPLOADS_MS = 5_000;

/*
 * Signing out of this browser. Other tabs hear of it first, then uploads stop while the
 * session still answers (the server releases what they reserved), never longer than
 * STOP_UPLOADS_MS. The session is revoked before anything local is deleted: deleting can wait
 * on a database another tab holds, and nothing on this device may keep the server session
 * alive. Then, whatever the logout did, everything this browser kept for the account goes.
 */
export async function signOut() {
    announceSignOut();
    // While this tab is still unlocked: no family key-change retry may sync now, since a sync
    // opens the families' store (hushos-groups) that forgetDevice is deleting, and could hold
    // up its deletion or make it again.
    await import('@/lib/drive')
        .then(({ stopSpaces }) => stopSpaces())
        .catch((error: unknown) => console.error('Family work could not be stopped here.', error));
    await within(
        import('@/lib/transfers').then(({ transfers }) => transfers.forgetAll()),
        STOP_UPLOADS_MS,
        'Uploads took too long to stop.',
    ).catch((error: unknown) => console.error('Uploads were not all stopped here.', error));
    try {
        await authClient.logout();
    } finally {
        await forgetDevice();
    }
}

/* Past this, a sign-out that has not finished is said to have failed, and can be tried again. */
export const SIGN_OUT_TIMEOUT_MS = 15_000;
/* Past this, the sign-in page is loaded from the server instead of opened in the app. */
export const NAVIGATE_TIMEOUT_MS = 10_000;

type Attempt = {
    work: Promise<void>;
    router: ReturnType<typeof useRouter>;
    finished?: Promise<void>;
};

/*
 * The sign-out under way. One given up on (it outlasted the timeout) is not stopped: pressing
 * Try again joins it rather than starting a second, which the auth client would refuse while
 * the first holds it, and if it lands late the sign-out finishes then.
 */
let attempt: Attempt | null = null;

function signOutOnce(router: ReturnType<typeof useRouter>) {
    if (attempt) return attempt;
    const current: Attempt = { work: signOut(), router };
    attempt = current;
    // Failed: the next press starts afresh.
    current.work.catch(() => {
        if (attempt === current) attempt = null;
    });
    // A sign-in waits until this sign-out, and the wipe after it, are done.
    holdSignIn(
        current.work.then(
            () => {
                // Signed out on the server: anything queued to sign in before now is stale.
                markSignedOut();
                return finish(current);
            },
            () => {},
        ),
    );
    return current;
}

/*
 * Signing out from inside the app. The screen holds still while it works: the view is held
 * at what it showed, the device is wiped and locked under it, and the sign-in page replaces
 * it in one step. A failed or stalled logout never leaves: the view goes, so the screen shows
 * what is true (locked here, still signed in), and the failure is thrown.
 */
export async function leaveApp(
    router: ReturnType<typeof useRouter>,
    { dim = false }: { dim?: boolean } = {},
) {
    const release = holdAuthView({ dim });
    const current = signOutOnce(router);
    try {
        await withTimeout(current.work, SIGN_OUT_TIMEOUT_MS, 'Signing out took too long.');
        await finish(current);
    } finally {
        release();
    }
}

/*
 * After the logout, once however many presses waited on it, and also when it lands after
 * being given up on. The sign-in page replaces the app; then, with the page gone, go what it
 * drew from (the open workspace, decrypted thumbnails and previews, the query cache), and the
 * device is wiped once more, since a pull the feed had on its way can have written the tree
 * back before close() stopped it. Signed out on the server means signed out here: a navigation
 * that fails loads the sign-in page from the server instead, which leaves memory behind too.
 */
function finish(current: Attempt) {
    current.finished ??= (async () => {
        const { router } = current;
        const { queryClient } = router.options.context;
        forgetSession(queryClient, false);
        let navigated = true;
        try {
            await withTimeout(
                router.navigate({ to: '/login' }),
                NAVIGATE_TIMEOUT_MS,
                'The sign-in page took too long to open.',
            );
        } catch (error) {
            console.error('The sign-in page did not open; loading it instead.', error);
            navigated = false;
        }
        await forgetOpened();
        queryClient.clear();
        if (attempt === current) attempt = null;
        if (!navigated) loadPage('/login');
    })();
    return current.finished;
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([work, stalled]).finally(() => clearTimeout(timer));
}

/*
 * What an unlocked Drive holds in memory beside the worker's keys, which the lock wiped, then
 * the device's copies again. Each part runs whatever another does, and failures are logged,
 * not thrown: the person has already left, and the sign-in page is no place to say so.
 */
async function forgetOpened() {
    const drive = import('@/lib/drive');
    const parts = [
        drive.then(({ driveClient }) => driveClient.close()),
        drive.then(({ closeSpaces }) => closeSpaces()),
        import('@/lib/thumbnails').then(({ forgetThumbnails }) => forgetThumbnails()),
        import('@/lib/previews').then(({ forgetPreviews }) => forgetPreviews()),
    ];
    const results = await Promise.allSettled(parts);
    // Only now that nothing open can pull the feed into it.
    results.push(...(await Promise.allSettled([clearDevice()])));
    for (const result of results)
        if (result.status === 'rejected')
            console.error('Part of signing out could not be cleared here.', result.reason);
}
