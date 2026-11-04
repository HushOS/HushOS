import type { Signer } from '@hushos/drive/api';
import type { QueryClient } from '@tanstack/react-query';
import { contactKeys, followServedKeys } from '@/lib/contacts';
import { driveClient, driveKeys } from '@/lib/drive';

/*
 * What happens when the people a person trusts change, and the ways out a
 * mark offers. The words themselves are in integrity-lines.ts.
 */
export {
    COULDNT_CHECK,
    issueLines,
    markLabel,
    nameSigner,
    savedLine,
    type IssueLine,
    type SignerNames,
} from '@/lib/integrity-lines';

/*
 * After the people this person trusts changed (someone checked, removed, or
 * followed to new keys): every listing is checked again, and the catalogue
 * behind Home, search and tags too.
 */
export function afterTrustChanged(queryClient: QueryClient) {
    void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === 'drive' && query.queryKey[1] !== 'open',
    });
    void driveClient.recheckIntegrity().catch(() => {});
}

/*
 * After Add someone moved trust (someone new, or someone already there whose
 * pin the add made first-seen or followed to new keys): every listing judged
 * again, Shared read again (what they shared opens), and what was shared with
 * them sealed to the keys the pin holds now when the pin asks for it.
 */
export function afterContactAdded(queryClient: QueryClient, pin: { resealShares?: boolean }) {
    afterTrustChanged(queryClient);
    void queryClient.invalidateQueries({ queryKey: driveKeys.shared });
    if (pin.resealShares) void driveClient.upgradeShares().catch(() => {});
}

/*
 * "Try again" on a check that could not run: what it rests on (the settings
 * with the pins, the identity and its history) is read afresh, then every
 * listing is checked again.
 */
export async function retryChecks(queryClient: QueryClient, userId: string) {
    await queryClient.invalidateQueries({ queryKey: contactKeys.settings(userId) });
    afterTrustChanged(queryClient);
}

/*
 * "Check again" on a checked contact's bad signature: their keys as the
 * server serves them now are looked up and, when a chain signed by the keys
 * the pin holds leads to them, the pin follows and everything is checked
 * again. Only ever on the person's press: a device that looked contacts up by
 * itself would tell the server whom it pins.
 */
export async function checkSignerAgain(queryClient: QueryClient, userId: string, signer: Signer) {
    const outcome = await followServedKeys(userId, signer);
    if (outcome === 'followed') afterTrustChanged(queryClient);
    return outcome;
}
