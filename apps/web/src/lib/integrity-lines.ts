import type { Signer } from '@hushos/drive/api';
import { integrityIssues, type IntegrityIssue, type NodeIntegrity } from '@hushos/drive/trust';

/*
 * The words behind an Unverified or Couldn't check mark, one verdict at a
 * time (docs/integrity-design.md, "Reading" and "Round 3"). Pure, so the
 * wording a server could steer by what it serves is tested on its own.
 */

/*
 * Who wrote a record, as this person can say it: the server names a signer by
 * account id alone, so a name comes only from their own pins. `you` for this
 * account, a checked contact's name, or null for anyone else.
 *
 * Inside a family's folders (`family`) the verdicts are the member list's
 * (design 2.8), and a member nobody checked personally is named as the server
 * names them, with their address beside the name where the server gives it
 * (decision D10): the member list vouches for their keys, never for the name.
 */
export type SignerNames = {
    userId: string | null;
    checked: Record<string, string>;
    /* Families whose word this person took for someone, by group id: their names. */
    vouchers?: Record<string, string>;
    /*
     * Pins taken on a family's word, by user id: the server's name and address,
     * and the family that vouched for the keys (never this person's own check).
     */
    vouched?: Record<string, { name: string; email: string; family: string }>;
    family?: {
        name: string;
        members: Record<string, { name: string; email: string | null }>;
    };
};
type Named =
    | { kind: 'you' }
    | {
          kind: 'contact';
          name: string;
          /* Set for a pin taken on a family's word. */
          vouched?: { name: string; email: string; family: string };
      }
    | { kind: 'member'; name: string; email: string | null }
    | { kind: 'unknown' };

export function nameSigner(signer: Signer | null, names: SignerNames): Named {
    if (!signer) return { kind: 'unknown' };
    const id = signer.id.toLowerCase();
    if (names.userId && id === names.userId.toLowerCase()) return { kind: 'you' };
    const name = names.checked[id];
    const vouched = names.vouched?.[id];
    if (name) return vouched ? { kind: 'contact', name, vouched } : { kind: 'contact', name };
    const member = names.family?.members[id];
    return member ? { kind: 'member', ...member } : { kind: 'unknown' };
}

/* A member as a sentence names them: a checked contact by their pin, anyone else as the server does. */
function memberWords(named: Named, fallback: string) {
    if (named.kind === 'contact') return firstName(named.name);
    if (named.kind === 'member') return named.email ? `${named.name} (${named.email})` : named.name;
    return fallback;
}

/* "Maya" from "Maya Lindqvist": what a sentence calls someone the second time. */
function firstName(name: string) {
    return name.trim().split(/\s+/)[0] || name;
}

export type IssueLine = {
    text: string;
    /*
     * The way out, where there is one: `check`, compare words with a writer
     * nobody has checked (their account id, to look them up against); `again`,
     * look up a checked contact's keys once more, since a bad signature may be
     * keys they replaced that this device has not followed; `retry`, run a
     * check that could not run.
     */
    action:
        | { kind: 'check'; signer: Signer }
        | { kind: 'again'; signer: Signer; name: string }
        | { kind: 'retry' }
        | null;
};

const CANT_CONFIRM = 'HushOS can’t confirm who wrote this.';
const CANT_CONFIRM_VERSION = 'HushOS can’t confirm who added this version.';
export const COULDNT_CHECK = 'HushOS couldn’t check who wrote this. Try again later.';

function line(issue: IntegrityIssue, names: SignerNames): IssueLine {
    const { signer, record, integrity } = issue;
    const version = record === 'version';
    const named = nameSigner(signer, names);
    const plain = version ? CANT_CONFIRM_VERSION : CANT_CONFIRM;
    const family = names.family?.name;
    switch (integrity) {
        // Never an accusation: the keys differ from the ones this person checked, and no
        // signed chain joins them. Comparing words again is the way out.
        case 'key-conflict': {
            // A pin taken on a family's word was never this person's check: the keys are the
            // ones that family vouched for, and the name and address are the server's.
            if (named.kind === 'contact' && named.vouched)
                return {
                    text: `${named.vouched.name} (${named.vouched.email})’s keys don’t match the ones ${named.vouched.family} vouched for. Check it’s them again.`,
                    action: signer ? { kind: 'check', signer } : null,
                };
            const who = memberWords(named, 'Its writer');
            return {
                text: `${who === 'Its writer' ? 'Its writer’s' : `${who}’s`} keys don’t match the ones you checked. Check it’s them again.`,
                action: signer ? { kind: 'check', signer } : null,
            };
        }
        case 'former-member': {
            const who = memberWords(named, 'someone');
            return {
                text: `${version ? 'Added' : 'Written'} by ${who}, who has left ${family ?? 'the family'}.`,
                action: null,
            };
        }
        case 'unchecked':
            return { text: COULDNT_CHECK, action: { kind: 'retry' } };
        // No signature reads as any other record nobody can vouch for: a server that strips
        // one gets no milder warning than one it cannot forge.
        case 'unsigned':
            return { text: plain, action: null };
        case 'unknown-signer':
            return {
                text: `${plain} It was ${version ? 'added' : 'added or last changed'} by someone you haven’t checked.`,
                // Checking words clears it only for someone not already counted as checked.
                action: signer && named.kind === 'unknown' ? { kind: 'check', signer } : null,
            };
        case 'bad-signature': {
            // In a family's folders a server withholding a member's links makes their genuine
            // records read this way (design 2.8, "Withholding links"): it is said as what it is.
            if (family)
                return {
                    text: version
                        ? 'HushOS couldn’t verify this version’s signature.'
                        : 'HushOS couldn’t verify this signature.',
                    action:
                        signer && named.kind === 'contact'
                            ? { kind: 'again', signer, name: named.name }
                            : null,
                };
            const whose =
                named.kind === 'you'
                    ? 'your'
                    : named.kind === 'contact'
                      ? `${firstName(named.name)}’s`
                      : 'its writer’s';
            return {
                text: `${version ? 'This version’s signature' : 'The signature'} doesn’t match ${whose} keys. Don’t trust this item.`,
                action:
                    signer && named.kind === 'contact'
                        ? { kind: 'again', signer, name: named.name }
                        : null,
            };
        }
        case 'retired-key': {
            const who =
                named.kind === 'you'
                    ? 'you have'
                    : named.kind === 'contact'
                      ? `${named.name} has`
                      : 'its writer has';
            return {
                text: `${version ? 'This version was signed' : 'Signed'} with keys ${who} since replaced.`,
                action: null,
            };
        }
        case 'resealed': {
            const by =
                named.kind === 'you'
                    ? 'you'
                    : named.kind === 'contact'
                      ? named.name
                      : 'someone you haven’t checked';
            return {
                text: `${version ? 'This version was re-locked' : 'Re-locked'} by ${by}; HushOS couldn’t confirm who wrote it before.`,
                action: null,
            };
        }
    }
}

/*
 * One line per thing to say, worst first. The name and the version with the
 * same verdict from the same writer say it once; a check that could not run
 * says so once, whatever it could not check.
 */
export function issueLines(issues: IntegrityIssue[], names: SignerNames): IssueLine[] {
    const [a, b] = issues;
    if (
        a &&
        b &&
        a.integrity === b.integrity &&
        a.integrity !== 'bad-signature' &&
        (a.integrity === 'unchecked' || (a.signer?.id ?? null) === (b.signer?.id ?? null))
    )
        return [line(a.record === 'metadata' ? a : b, names)];
    return issues.map((issue) => line(issue, names));
}

/*
 * What the mark says on its face: Couldn't check when nothing could be, a
 * key conflict (worse than Unverified) as its own words, else Unverified.
 */
export function markLabel(issues: IntegrityIssue[]) {
    if (issues.length > 0 && issues.every((issue) => issue.integrity === 'unchecked'))
        return 'Couldn’t check';
    if (issues.some((issue) => issue.integrity === 'key-conflict')) return 'Keys don’t match';
    return 'Unverified';
}

/*
 * Outside family folders, the same line for an item whose verified records
 * were written by someone this person trusts on a family's word ("Trust as
 * Lindqvist family does"): the verdict rests on that family's member list,
 * not on words this person compared, and Info says so. Null when every
 * record did not verify, or no verified record's writer is pinned that way.
 */
export function vouchedByLine(
    node: {
        integrity: NodeIntegrity | null;
        metadataSigner?: Signer | null;
        currentVersion: { signer?: Signer | null } | null;
    },
    names: SignerNames,
) {
    const integrity = node.integrity;
    if (!integrity) return null;
    const records = [
        { verdict: integrity.metadata, signer: node.metadataSigner ?? null },
        ...(integrity.version === null
            ? []
            : [{ verdict: integrity.version, signer: node.currentVersion?.signer ?? null }]),
    ];
    if (!records.every((record) => record.verdict === 'verified')) return null;
    for (const { signer } of records) {
        const vouched = signer ? names.vouched?.[signer.id.toLowerCase()] : undefined;
        if (vouched) return `Verified by ${vouched.family}`;
    }
    return null;
}

/*
 * The line Info shows for an item a family's member list vouched for, and
 * nothing for anything else: every record verified, at least one of them by
 * a family's word rather than this person's own check (design 2.8): this
 * folder's family, or another whose word this person took for the writer
 * ("Trust as … does", `vouchers`).
 */
export function verifiedByLine(
    node: { integrity: NodeIntegrity | null },
    family: { groupId: string; name: string } | null,
    vouchers: Record<string, string> = {},
) {
    const integrity = node.integrity;
    if (!family || !integrity?.via) return null;
    const records = [
        { verdict: integrity.metadata, via: integrity.via.metadata },
        ...(integrity.version === null
            ? []
            : [{ verdict: integrity.version, via: integrity.via.version }]),
    ];
    if (!records.every((record) => record.verdict === 'verified')) return null;
    if (records.some((record) => record.via === family.groupId))
        return `Verified by ${family.name}`;
    const other = records.find((record) => record.via && vouchers[record.via]);
    return other ? `Verified by ${vouchers[other.via!]}` : null;
}

/*
 * The neutral line for a copy saved from a link (docs/integrity-design.md,
 * "Saved copies"): no mark, only who saved it, named from this person's own
 * pins, and that the original's writer is unknown. Null when there is a mark
 * to show instead (any record that did not verify), or nothing was saved.
 */
export function savedLine(
    node: {
        integrity: NodeIntegrity | null;
        metadataSigner?: Signer | null;
        currentVersion: { signer?: Signer | null } | null;
    },
    names: SignerNames,
): string | null {
    const integrity = node.integrity;
    if (!integrity) return null;
    const issues = integrityIssues({
        metadataSigner: node.metadataSigner ?? null,
        currentVersion: node.currentVersion ? { signer: node.currentVersion.signer ?? null } : null,
        integrity,
    });
    if (issues.length) return null;
    const signer =
        integrity.metadata === 'saved-from-link'
            ? (node.metadataSigner ?? null)
            : integrity.version === 'saved-from-link'
              ? (node.currentVersion?.signer ?? null)
              : undefined;
    if (signer === undefined) return null;
    const named = nameSigner(signer, names);
    // A saved signature reads as saved only from someone trusted; anyone else is never named.
    const by = named.kind === 'you' ? 'you' : named.kind === 'contact' ? named.name : null;
    if (!by) return null;
    return `Saved from a link by ${by}. HushOS can’t confirm who made the original.`;
}
