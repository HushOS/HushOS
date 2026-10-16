import { authClient } from '@/lib/auth-client';
import { forgetReturn } from '@/lib/return-to';

/*
 * What Drive kept on this device between visits, which would otherwise outlive
 * the account here: unfinished uploads are stopped, their journal (file names
 * and chunk digests) emptied and their stashed bytes (decrypted copies)
 * deleted; the mirrored tree (ciphertext, but its shape, sizes and times) is
 * dropped; and a saved return to a link (its key in the fragment) goes. Drive
 * loads on demand, so a page that never opened it does not pull it in here.
 */
export async function forgetDevice() {
    await clearDevice().catch(() => {});
}

/*
 * The same, failing when any part did not clear: a removed device acknowledges its removal
 * (and lets go of the cookie) only once this resolved, so a blocked store is tried again.
 */
export async function clearDevice() {
    forgetReturn();
    await Promise.all([
        import('@/lib/transfers').then(({ transfers }) => transfers.forgetAll()),
        import('@/lib/drive').then(({ driveClient }) => driveClient.forgetMirror()),
    ]);
}

/* Signing out of this browser: whatever the device cleanup does, the session and device key go. */
export async function signOut() {
    try {
        await forgetDevice();
    } finally {
        await authClient.logout();
    }
}
