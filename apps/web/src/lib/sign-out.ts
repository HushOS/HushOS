import type { useRouter } from '@tanstack/react-router';
import { authClient } from '@/lib/auth-client';
import { holdAuthView } from '@/lib/auth-view';
import { forgetReturn } from '@/lib/return-to';
import { forgetSession } from '@/lib/session';

/*
 * What Drive kept on this device between visits, which would otherwise outlive
 * the account here: unfinished uploads are stopped, their journal (file names
 * and chunk digests) emptied and their stashed bytes (sealed copies)
 * deleted; the mirrored tree (ciphertext, but its shape, sizes and times) is
 * dropped; families' sealed records and family folders' mirrors are deleted;
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

/*
 * The same, failing when any part did not clear: a removed device acknowledges its removal
 * (and lets go of the cookie) only once this resolved, so a blocked store is tried again.
 */
export async function clearDevice() {
    forgetReturn();
    // Every part is tried whatever another does; the first failure is reported once all settled.
    const results = await Promise.allSettled([
        import('@/lib/transfers').then(({ transfers }) => transfers.forgetAll()),
        // The sealed stash and the key for it, whatever the uploads left.
        import('@/lib/stash').then(({ forgetStash }) => forgetStash()),
        import('@/lib/drive').then(({ driveClient }) => driveClient.forgetMirror()),
        // Families: the sealed chain records, outbox and joins, and every family folder's
        // mirror (the 1c plan, 1.3). Membership is the social graph; none of it stays.
        import('@/lib/groups/store').then(({ deleteGroupDevice }) => deleteGroupDevice()),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
}

/* Signing out of this browser: whatever the device cleanup does, the session and device key go. */
export async function signOut() {
    try {
        await forgetDevice();
    } finally {
        await authClient.logout();
    }
}

/*
 * Signing out from inside the app. The screen holds still while it works: the view is held
 * at what it showed, the device is wiped and locked under it, and the sign-in page replaces
 * it in one step. Only then go what the old page drew from: the open workspace, decrypted
 * thumbnails and previews, and the query cache. A failure lets the view go, so the screen
 * shows what is true (locked here, still signed in), and is thrown for the caller to say.
 */
export async function leaveApp(
    router: ReturnType<typeof useRouter>,
    { dim = false }: { dim?: boolean } = {},
) {
    const release = holdAuthView({ dim });
    const { queryClient } = router.options.context;
    try {
        await signOut();
        forgetSession(queryClient, false);
        await router.navigate({ to: '/login' });
    } finally {
        release();
    }
    try {
        await forgetOpened();
    } finally {
        queryClient.clear();
    }
}

/*
 * What an unlocked Drive holds in memory beside the worker's keys, which the lock wiped. Every
 * part is let go whatever another does; the first failure is thrown once all have run.
 */
async function forgetOpened() {
    const [{ driveClient, closeSpaces }, { forgetThumbnails }, { forgetPreviews }] =
        await Promise.all([
            import('@/lib/drive'),
            import('@/lib/thumbnails'),
            import('@/lib/previews'),
        ]);
    const failures: unknown[] = [];
    for (const forget of [
        () => driveClient.close(),
        closeSpaces,
        forgetThumbnails,
        forgetPreviews,
    ]) {
        try {
            forget();
        } catch (error) {
            failures.push(error);
        }
    }
    if (failures.length) throw failures[0];
}
