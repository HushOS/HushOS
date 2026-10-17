import type { DroppedView, Signer } from '@hushos/drive/api';
import {
    integrityIssues,
    type IntegrityIssue,
    type NodeIntegrity,
    type RekeyNote,
} from '@hushos/drive/trust';

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

/*
 * Who Info's "Changed by" names for the worst issue: from this person's own
 * pins and the family's list, as everywhere. A re-key cause names someone
 * only for a mismatch under the re-keyer's verified signature; any other is
 * "Not confirmed", whatever the server says.
 */
export function changedByWords(issue: IntegrityIssue, names: SignerNames) {
    if (issue.rekey && !(issue.rekey.cause === 'mismatch' && issue.rekey.rekeyer === 'verified'))
        return 'Not confirmed';
    if (issue.integrity === 'unchecked') return 'Not checked';
    const named = nameSigner(issue.signer, names);
    if (named.kind === 'you') return 'You';
    if (named.kind === 'contact') return named.name;
    if (named.kind === 'member') return named.email ? `${named.name} (${named.email})` : named.name;
    return issue.signer ? 'Someone you haven’t checked' : 'Unknown';
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

/*
 * A re-keyed record (docs/integrity-design.md, "Re-keyed records"): what a
 * server alone could cause is said as unconfirmed, never as anyone's fault.
 */
export const REKEY_UNCONFIRMED = 'HushOS couldn’t confirm this item since its keys were replaced.';
const REKEY_UNCONFIRMED_VERSION =
    'HushOS couldn’t confirm this version since its keys were replaced.';
export const REKEY_UNATTESTED = 'HushOS can’t confirm who replaced this item’s keys.';

/* Someone as a sentence names them, or null for nobody this person can name. */
function personWords(named: Named) {
    if (named.kind === 'you') return 'you';
    if (named.kind === 'unknown') return null;
    return memberWords(named, '');
}

/*
 * The words for a re-keyed record's own cause. "Doesn't match" is said only
 * when the plaintexts showed it (`bound` false), and a person is named only
 * when their verified re-key signature covers what failed; a mismatch nobody
 * attested to names nobody.
 */
function rekeyLine(
    issue: IntegrityIssue & { rekey: NonNullable<IntegrityIssue['rekey']> },
    named: Named,
): IssueLine {
    const version = issue.record === 'version';
    switch (issue.rekey.cause) {
        case 'mismatch': {
            const who = issue.rekey.rekeyer === 'verified' ? personWords(named) : null;
            return {
                text: version
                    ? `This version as ${who ? `${who} locked it` : 'it was locked'} again doesn’t match what was added. Don’t trust this item.`
                    : `What ${who ? `${who} locked` : 'was locked'} again doesn’t match what was written. Don’t trust this item.`,
                action: null,
            };
        }
        case 'unconfirmed':
            return {
                text: version ? REKEY_UNCONFIRMED_VERSION : REKEY_UNCONFIRMED,
                action: { kind: 'retry' },
            };
        case 'unattested':
            return { text: REKEY_UNATTESTED, action: null };
    }
}

const CANT_CONFIRM = 'HushOS can’t confirm who wrote this.';
const CANT_CONFIRM_VERSION = 'HushOS can’t confirm who added this version.';
export const COULDNT_CHECK = 'HushOS couldn’t check who wrote this. Try again later.';

function line(issue: IntegrityIssue, names: SignerNames): IssueLine {
    const { signer, record, integrity } = issue;
    const version = record === 'version';
    const named = nameSigner(signer, names);
    const plain = version ? CANT_CONFIRM_VERSION : CANT_CONFIRM;
    const family = names.family?.name;
    if (issue.rekey) return rekeyLine({ ...issue, rekey: issue.rekey }, named);
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
            // Unnamed as Info's "Changed by" leaves them: nobody this person checked, nor on the list.
            const who = memberWords(named, 'someone you haven’t checked');
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
    const sameSigner = (a?.signer?.id ?? null) === (b?.signer?.id ?? null);
    // The same re-key cause on both records, by the same re-keyer, is said once (the item's words).
    if (a?.rekey && b?.rekey && a.rekey.cause === b.rekey.cause && sameSigner)
        return [line(a.record === 'metadata' ? a : b, names)];
    if (
        a &&
        b &&
        !a.rekey &&
        !b.rekey &&
        a.integrity === b.integrity &&
        a.integrity !== 'bad-signature' &&
        (a.integrity === 'unchecked' || sameSigner)
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
    // A re-keyer's conflicting keys say the re-key is not attested, not that the writer's differ.
    if (issues.some((issue) => issue.integrity === 'key-conflict' && !issue.rekey))
        return 'Keys don’t match';
    return 'Unverified';
}

/*
 * Who wrote a re-keyed item and who locked it again, as Info says them
 * (decision D5: the re-keyer is said in Info, never as a mark). Only for
 * records whose bytes bound to their writer's; a mismatch or an unconfirmed
 * re-key is the mark's to say. `writtenBy` only when every record verified
 * (an item that did not says who wrote it beside its mark): the name's writer
 * and the content's, each once, labelled when they differ; `replacedBy` one
 * line per re-keyer verdict, labelled the same way, none where the mark says
 * it instead.
 */
export function rekeyedLines(
    node: {
        integrity: NodeIntegrity | null;
        metadataSigner?: Signer | null;
        currentVersion?: { signer?: Signer | null } | null;
    },
    names: SignerNames,
): { writtenBy: string | null; replacedBy: string[] } {
    const integrity = node.integrity;
    const none = { writtenBy: null, replacedBy: [] };
    if (!integrity?.rekeyed) return none;
    const records: {
        label: 'name' | 'content';
        verdict: NodeIntegrity['metadata'];
        note: RekeyNote | null;
        signer: Signer | null;
    }[] = [
        {
            label: 'name',
            verdict: integrity.metadata,
            note: integrity.rekeyed.metadata,
            signer: node.metadataSigner ?? null,
        },
        ...(integrity.version === null
            ? []
            : [
                  {
                      label: 'content' as const,
                      verdict: integrity.version,
                      note: integrity.rekeyed.version,
                      signer: node.currentVersion?.signer ?? null,
                  },
              ]),
    ];
    const bound = records.filter((record) => record.note?.bound === true);
    if (!bound.length) return none;
    const words = (signer: Signer | null, you: string) => {
        const who = nameSigner(signer, names);
        return who.kind === 'you' ? you : who.kind === 'unknown' ? null : memberWords(who, '');
    };
    /* One phrase per record, or once when they agree; labelled by what each record holds. */
    const labelled = (phrases: { label: string; phrase: string | null }[]) => {
        const present = phrases.filter((entry): entry is { label: string; phrase: string } =>
            Boolean(entry.phrase),
        );
        if (new Set(present.map((entry) => entry.phrase)).size <= 1)
            return present.slice(0, 1).map((entry) => entry.phrase);
        return present.map((entry) => `${entry.phrase} (${entry.label})`);
    };
    const trusted = (verdict: NodeIntegrity['metadata']) =>
        verdict === 'verified' || verdict === 'saved-from-link';
    // A record no rotation re-keyed is written by its own signer.
    const writers = records.every((record) => trusted(record.verdict))
        ? labelled(
              records.map((record) => ({
                  label: record.label,
                  phrase: words(record.note ? record.note.writer : record.signer, 'You'),
              })),
          )
        : [];
    const replacedBy = labelled(
        bound.map(({ label, note }) => {
            const by = words(note!.by, 'you');
            const phrase: Partial<Record<RekeyNote['integrity'], string | null>> = {
                verified: by ? `Keys replaced by ${by}` : null,
                'retired-key': `Keys replaced by ${by ?? 'someone you haven’t checked'}, with keys since replaced`,
                'former-member': `Keys replaced by ${by ?? 'someone you haven’t checked'}, who has left ${names.family?.name ?? 'the family'}`,
                'unknown-signer': 'Keys replaced by someone you haven’t checked',
                unchecked: 'HushOS couldn’t check who replaced its keys',
            };
            return { label, phrase: phrase[note!.integrity] ?? null };
        }),
    );
    return { writtenBy: writers.length ? writers.join(', ') : null, replacedBy };
}

/*
 * A dropped origin, as Info says it: a rotation dropped the signature a
 * record's writer made (its client found the origin did not bind, or said so).
 * The server says who dropped it, unsigned. The dropper is named only where a
 * signature this person checked agrees: the record's own re-sealed signature
 * by them, which is what a drop writes, or, once a later rotation re-keyed the
 * record, the same re-sealed signature as the bound origin. Anyone else, and
 * the dropped origin's writer always, goes unnamed: nothing here proves them,
 * and a server could otherwise blame an innocent member.
 */
export function droppedLines(
    node: {
        integrity: NodeIntegrity | null;
        metadataSigner?: Signer | null;
        metadataOriginDropped?: DroppedView | null;
        currentVersion?: { signer?: Signer | null; originDropped?: DroppedView | null } | null;
    },
    names: SignerNames,
): string[] {
    const integrity = node.integrity;
    const confirmed = (
        dropped: DroppedView,
        verdict: NodeIntegrity['metadata'] | null | undefined,
        signer: Signer | null,
        note: RekeyNote | null | undefined,
    ) => {
        if (verdict !== 'resealed') return false;
        const who = note ? (note.bound === true ? note.writer : null) : signer;
        return who !== null && who.id.toLowerCase() === dropped.by.id.toLowerCase();
    };
    /* What follows "Its original signature" or "This version's original signature". */
    const tail = (dropped: DroppedView, named: boolean) => {
        if (!named) return 'was dropped when its keys were replaced.';
        const by = nameSigner(dropped.by, names);
        const who =
            by.kind === 'you'
                ? 'you'
                : by.kind === 'unknown'
                  ? 'someone you haven’t checked'
                  : memberWords(by, '');
        return `was dropped by ${who} when its keys were replaced.`;
    };
    const metadata = node.metadataOriginDropped ?? null;
    const version = node.currentVersion?.originDropped ?? null;
    const metadataTail = metadata
        ? tail(
              metadata,
              confirmed(
                  metadata,
                  integrity?.metadata,
                  node.metadataSigner ?? null,
                  integrity?.rekeyed?.metadata,
              ),
          )
        : null;
    const versionTail = version
        ? tail(
              version,
              confirmed(
                  version,
                  integrity?.version,
                  node.currentVersion?.signer ?? null,
                  integrity?.rekeyed?.version,
              ),
          )
        : null;
    // The same words for both records are said once.
    if (metadataTail && metadataTail === versionTail)
        return [`Its original signature ${metadataTail}`];
    return [
        ...(metadataTail ? [`Its original signature ${metadataTail}`] : []),
        ...(versionTail ? [`This version’s original signature ${versionTail}`] : []),
    ];
}

/*
 * Whose signature a record's verdict is about. A re-keyed record's verdict is
 * its origin's, so that is the origin's writer, and only once the bytes bound.
 * The record's own signer column is then the re-keyer, whose signature may
 * never have verified (an unchecked re-key carries no mark), so a server
 * could put any pinned member's id there. Null when nobody can be named.
 */
function verdictSigner(current: Signer | null, note: RekeyNote | null | undefined) {
    return note ? (note.bound === true ? note.writer : null) : current;
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
        {
            verdict: integrity.metadata,
            signer: verdictSigner(node.metadataSigner ?? null, integrity.rekeyed?.metadata),
        },
        ...(integrity.version === null
            ? []
            : [
                  {
                      verdict: integrity.version,
                      signer: verdictSigner(
                          node.currentVersion?.signer ?? null,
                          integrity.rekeyed?.version,
                      ),
                  },
              ]),
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
    // Whose saved signature verified: for a re-keyed record the origin's writer, never the re-keyer.
    const signer =
        integrity.metadata === 'saved-from-link'
            ? verdictSigner(node.metadataSigner ?? null, integrity.rekeyed?.metadata)
            : integrity.version === 'saved-from-link'
              ? verdictSigner(node.currentVersion?.signer ?? null, integrity.rekeyed?.version)
              : undefined;
    if (signer === undefined) return null;
    const named = nameSigner(signer, names);
    // A saved signature reads as saved only from someone trusted; anyone else is never named.
    const by = named.kind === 'you' ? 'you' : named.kind === 'contact' ? named.name : null;
    if (!by) return null;
    return `Saved from a link by ${by}. HushOS can’t confirm who made the original.`;
}

/*
 * A re-keyed record's check as Technical details says it: what the contents
 * showed, then the re-key signature. Plain enough to read, exact enough to
 * report.
 */
export function rekeyTechnical(note: RekeyNote) {
    const contents =
        note.bound === true
            ? 'Contents match what was written'
            : note.bound === false
              ? 'Contents differ from what was written'
              : 'Contents not confirmed';
    const signature: Record<RekeyNote['integrity'], string> = {
        verified: 'key change signed',
        'saved-from-link': 'key change signed',
        resealed: 'key change signed',
        'retired-key': 'key change signed with keys since replaced',
        'former-member': 'key change signed by a former member',
        'unknown-signer': 'key change signed by someone you haven’t checked',
        'key-conflict': 'key change signed with keys that don’t match',
        'bad-signature': 'key change signature doesn’t hold',
        unsigned: 'key change not signed',
        unchecked: 'key change not checked',
    };
    return `${contents} · ${signature[note.integrity]}`;
}
