import { authClient } from '@/lib/auth-client';
import { forgetReturn } from '@/lib/return-to';

/*
 * Signing out of this browser: the session and the device key go, and so does
 * what Drive kept on the device between visits, which would otherwise outlive
 * the account here. Unfinished uploads are stopped, their journal (file names
 * and chunk digests) emptied and their stashed bytes (decrypted copies) deleted,
 * and a saved return to a link (its key in the fragment) is dropped. Transfers
 * load on demand, so a page that never opened Drive does not pull them in.
 */
export async function signOut() {
    forgetReturn();
    const { transfers } = await import('@/lib/transfers');
    await transfers.forgetAll().catch(() => {});
    await authClient.logout();
}
