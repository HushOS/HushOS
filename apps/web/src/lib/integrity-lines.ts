import type { Signer } from '@hushos/drive/api';
import type { IntegrityIssue } from '@hushos/drive/trust';

/*
 * The words behind an Unverified or Couldn't check mark, one verdict at a
 * time (docs/integrity-design.md, "Reading" and "Round 3"). Pure, so the
 * wording a server could steer by what it serves is tested on its own.
 */

/*
 * Who wrote a record, as this person can say it: the server names a signer by
 * account id alone, so a name comes only from their own pins. `you` for this
 * account, a checked contact's name, or null for anyone else.
 */
export type SignerNames = { userId: string | null; checked: Record<string, string> };
type Named = { kind: 'you' } | { kind: 'contact'; name: string } | { kind: 'unknown' };

export function nameSigner(signer: Signer | null, names: SignerNames): Named {
    if (!signer) return { kind: 'unknown' };
    if (names.userId && signer.id.toLowerCase() === names.userId.toLowerCase())
        return { kind: 'you' };
    const name = names.checked[signer.id.toLowerCase()];
    return name ? { kind: 'contact', name } : { kind: 'unknown' };
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
    switch (integrity) {
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

/* What the mark says on its face: Couldn't check when nothing could be, else Unverified. */
export function markLabel(issues: IntegrityIssue[]) {
    return issues.length > 0 && issues.every((issue) => issue.integrity === 'unchecked')
        ? 'Couldn’t check'
        : 'Unverified';
}
