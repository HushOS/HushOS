import type { Signer } from '@hushos/drive/api';
import type { IntegrityIssue } from '@hushos/drive/trust';
import type { QueryClient } from '@tanstack/react-query';
import { authClient } from '@/lib/auth-client';
import { followServedKeys } from '@/lib/contacts';
import { driveClient } from '@/lib/drive';

/*
 * The words behind an Unverified mark, and what happens when the people a
 * person trusts change. See docs/integrity-design.md, "Reading".
 */

export type IssueLine = {
    text: string;
    /* The writer whose words can be checked to clear it: an unknown signer the server named. */
    check: Signer | null;
};

const who = (signer: Signer) => `${signer.name} (${signer.email})`;
const first = (signer: Signer) => signer.name.trim().split(/\s+/)[0] || signer.name;

function line(issue: IntegrityIssue): IssueLine {
    const { signer, record, integrity } = issue;
    const version = record === 'version';
    if (integrity === 'unsigned')
        return {
            text: version
                ? 'This version was added before HushOS signed changes.'
                : 'Made before HushOS signed changes.',
            check: null,
        };
    if (integrity === 'bad-signature')
        return {
            text: signer
                ? version
                    ? `This version was added by ${who(signer)}, but its signature doesn’t match ${first(signer)}’s keys. Don’t trust this item.`
                    : `The signature doesn’t match ${first(signer)}’s keys. Don’t trust this item.`
                : 'The signature doesn’t match its writer’s keys. Don’t trust this item.',
            check: null,
        };
    return {
        text: signer
            ? version
                ? `This version was added by ${who(signer)}, whom you haven’t checked yet.`
                : `Added or last changed by ${who(signer)}, whom you haven’t checked yet.`
            : version
              ? 'This version was added by someone you haven’t checked yet.'
              : 'Added or last changed by someone you haven’t checked yet.',
        check: signer,
    };
}

/*
 * One line per thing to say, worst first. The name and the version written by
 * the same unchecked person, or both made before signatures, say it once.
 */
export function issueLines(issues: IntegrityIssue[]): IssueLine[] {
    const [a, b] = issues;
    if (
        a &&
        b &&
        a.integrity === b.integrity &&
        a.integrity !== 'bad-signature' &&
        (a.signer?.id ?? null) === (b.signer?.id ?? null)
    )
        return [line(a.record === 'metadata' ? a : b)];
    return issues.map(line);
}

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
 * A bad signature from a contact may be their new keys, which this device has
 * not followed yet (a succession it has not seen). Once per writer and unlock,
 * their served keys are looked up and, when a signed chain leads to them, the
 * pin follows and everything is checked again. Anything else stays as it is.
 */
const reconsidered = new Set<string>();
authClient.store.subscribe((state, previous) => {
    if (state.unlockedUserId !== previous.unlockedUserId) reconsidered.clear();
});
export async function reconsiderSigner(queryClient: QueryClient, userId: string, signer: Signer) {
    if (reconsidered.has(signer.id)) return;
    reconsidered.add(signer.id);
    try {
        if (await followServedKeys(userId, signer)) afterTrustChanged(queryClient);
    } catch {
        /* Nothing followed: the mark stays as it is. */
    }
}
