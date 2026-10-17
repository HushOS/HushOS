import {
    integrityIssues,
    type IntegrityIssue,
    type NodeIntegrity,
    type RekeyNote,
} from '@hushos/drive/trust';
import { describe, expect, test } from 'vitest';
import {
    COULDNT_CHECK,
    REKEY_UNATTESTED,
    REKEY_UNCONFIRMED,
    changedByLabel,
    changedByWords,
    droppedLines,
    issueLines,
    markLabel,
    rekeyedLines,
    savedLine,
    verifiedByLine,
    vouchedByLine,
    type SignerNames,
} from './integrity-lines';

/*
 * What a mark says is steered by what the server serves: who it names as the
 * writer, whether a signature is there at all. These are the readings a
 * malicious server would try to soften or misattribute.
 */
const ME = 'a0000000-0000-4000-8000-000000000001';
const MAYA = 'a0000000-0000-4000-8000-000000000002';
const STRANGER = 'a0000000-0000-4000-8000-000000000003';
const names: SignerNames = { userId: ME, checked: { [MAYA]: 'Maya Lindqvist' } };
const issue = (
    integrity: IntegrityIssue['integrity'],
    signer: string | null,
    record: IntegrityIssue['record'] = 'metadata',
): IntegrityIssue => ({ record, integrity, signer: signer ? { id: signer } : null });

describe('integrity lines', () => {
    test('a stripped signature reads no milder than a writer nobody checked', () => {
        const [unsigned] = issueLines([issue('unsigned', null)], names);
        const [unknown] = issueLines([issue('unknown-signer', STRANGER)], names);
        expect(unsigned!.text).toBe('HushOS can’t confirm who wrote this.');
        expect(unknown!.text.startsWith(unsigned!.text)).toBe(true);
        expect(unsigned!.text).not.toMatch(/before HushOS signed/);
        // Nothing to check for a record with no writer: no way out offered that leads nowhere.
        expect(unsigned!.action).toBeNull();
    });

    test('writers are named from this person’s own pins only', () => {
        const by = (signer: string) =>
            issueLines([issue('resealed', signer)], names)[0]!.text.split(';')[0];
        expect(by(ME)).toBe('Re-locked by you');
        expect(by(MAYA)).toBe('Re-locked by Maya Lindqvist');
        expect(by(STRANGER)).toBe('Re-locked by someone you haven’t checked');
        expect(issueLines([issue('retired-key', MAYA)], names)[0]!.text).toBe(
            'Signed with keys Maya Lindqvist has since replaced.',
        );
        expect(issueLines([issue('retired-key', ME, 'version')], names)[0]!.text).toBe(
            'This version was signed with keys you have since replaced.',
        );
    });

    test('each way out is offered only where it can clear the mark', () => {
        const action = (i: IntegrityIssue) => issueLines([i], names)[0]!.action;
        expect(action(issue('unknown-signer', STRANGER))).toEqual({
            kind: 'check',
            signer: { id: STRANGER },
        });
        // A checked contact's bad signature may be keys they replaced: look them up again.
        expect(action(issue('bad-signature', MAYA))).toEqual({
            kind: 'again',
            signer: { id: MAYA },
            name: 'Maya Lindqvist',
        });
        // One's own bad signature, a retired key or a re-locked record: nothing to check.
        expect(action(issue('bad-signature', ME))).toBeNull();
        expect(action(issue('retired-key', MAYA))).toBeNull();
        expect(action(issue('resealed', ME))).toBeNull();
        expect(action(issue('unchecked', MAYA))).toEqual({ kind: 'retry' });
    });

    test('a check that could not run says so once, under its own label', () => {
        const both = [issue('unchecked', MAYA), issue('unchecked', STRANGER, 'version')];
        expect(issueLines(both, names)).toEqual([
            { text: COULDNT_CHECK, action: { kind: 'retry' } },
        ]);
        expect(markLabel(both)).toBe('Couldn’t check');
        // Anything that did get checked and failed is Unverified, whatever else could not run.
        expect(markLabel([issue('bad-signature', MAYA), issue('unchecked', MAYA, 'version')])).toBe(
            'Unverified',
        );
    });
});

describe('a copy saved from a link', () => {
    const saved = (
        metadata: IntegrityIssue['integrity'] | 'verified' | 'saved-from-link',
        version: IntegrityIssue['integrity'] | 'verified' | 'saved-from-link' | null,
        signer: string | null = ME,
    ) => ({
        integrity: { metadata, version },
        metadataSigner: signer ? { id: signer } : null,
        currentVersion: version === null ? null : { signer: signer ? { id: signer } : null },
    });

    test('says who saved it, from this person’s pins, and that the original is unknown', () => {
        expect(savedLine(saved('saved-from-link', 'saved-from-link'), names)).toBe(
            'Saved from a link by you. HushOS can’t confirm who made the original.',
        );
        expect(savedLine(saved('saved-from-link', 'saved-from-link', MAYA), names)).toBe(
            'Saved from a link by Maya Lindqvist. HushOS can’t confirm who made the original.',
        );
        // A saved folder has no version.
        expect(savedLine(saved('saved-from-link', null), names)).toMatch(
            /^Saved from a link by you/,
        );
    });

    test('gives way to the mark when any record did not verify, and is absent for anything else', () => {
        // The name saved, but the content not: the Unverified mark speaks, not this line.
        expect(savedLine(saved('saved-from-link', 'resealed'), names)).toBeNull();
        expect(savedLine(saved('unknown-signer', 'saved-from-link'), names)).toBeNull();
        expect(savedLine(saved('saved-from-link', 'unchecked'), names)).toBeNull();
        // Verified records, or none checked (a link visitor's view), say nothing.
        expect(savedLine(saved('verified', 'verified'), names)).toBeNull();
        expect(
            savedLine({ integrity: null, metadataSigner: { id: ME }, currentVersion: null }, names),
        ).toBeNull();
        // Never names someone this person has not checked.
        expect(savedLine(saved('saved-from-link', 'saved-from-link', STRANGER), names)).toBeNull();
    });
});

/*
 * Inside a family's folders the member list decides (design 2.8), and the
 * server supplies the members' names: these are the readings a server could
 * steer by naming someone, by withholding a member's links, or by planting
 * keys in a member's entry.
 */
describe('in a family folder', () => {
    const FAMILY = 'b0000000-0000-4000-8000-000000000001';
    const SAM = 'a0000000-0000-4000-8000-000000000004';
    const family: SignerNames = {
        ...names,
        family: {
            name: 'Lindqvist family',
            members: {
                [SAM]: { name: 'Sam Lindqvist', email: 'sam@example.com' },
                // The server names a checked contact otherwise: the pin's name wins.
                [MAYA]: { name: 'Mom', email: 'maya@example.com' },
                // A former member: the server gives no address once someone has left.
                [STRANGER]: { name: 'Ana Berg', email: null },
            },
        },
    };

    test('a bad signature never accuses anyone, since withheld links make genuine records read so', () => {
        const [line] = issueLines([issue('bad-signature', SAM)], family);
        expect(line!.text).toBe('HushOS couldn’t verify this signature.');
        expect(line!.text).not.toMatch(/Don’t trust/);
        expect(issueLines([issue('bad-signature', SAM, 'version')], family)[0]!.text).toBe(
            'HushOS couldn’t verify this version’s signature.',
        );
        // Outside a family folder the personal reading stands.
        expect(issueLines([issue('bad-signature', SAM)], names)[0]!.text).toMatch(
            /Don’t trust this item/,
        );
    });

    test('keys that conflict with this person’s check are worse than Unverified, never an accusation', () => {
        const [line] = issueLines([issue('key-conflict', MAYA)], family);
        // Named from the pin, never from what the server calls them.
        expect(line!.text).toBe(
            'Maya’s keys don’t match the ones you checked. Check it’s them again.',
        );
        expect(line!.text).not.toMatch(/Mom/);
        expect(line!.action).toEqual({ kind: 'check', signer: { id: MAYA } });
        expect(markLabel([issue('key-conflict', MAYA)])).toBe('Keys don’t match');
        // A pin taken on a family's word was never Ana's own check: the server's full name and
        // address, and the family that vouched for the keys.
        const vouched: SignerNames = {
            ...family,
            checked: {
                ...family.checked,
                [SAM]: 'Sam Lindqvist (sam@example.com), whom Berg family vouches for',
            },
            vouched: {
                [SAM]: { name: 'Sam Lindqvist', email: 'sam@example.com', family: 'Berg family' },
            },
        };
        const [onWord] = issueLines([issue('key-conflict', SAM)], vouched);
        expect(onWord!.text).toBe(
            'Sam Lindqvist (sam@example.com)’s keys don’t match the ones Berg family vouched for. Check it’s them again.',
        );
        expect(onWord!.text).not.toMatch(/you checked/);
        expect(onWord!.action).toEqual({ kind: 'check', signer: { id: SAM } });
        // Ranked first, ahead of a bad signature on the other record.
        const node = {
            metadataSigner: { id: SAM },
            currentVersion: { signer: { id: MAYA } },
            integrity: { metadata: 'bad-signature', version: 'key-conflict' } as NodeIntegrity,
        };
        expect(integrityIssues(node).map((at) => at.integrity)).toEqual([
            'key-conflict',
            'bad-signature',
        ]);
    });

    test('a former member’s work is marked, named as the server names them, with their address where given', () => {
        expect(issueLines([issue('former-member', SAM)], family)[0]!.text).toBe(
            'Written by Sam Lindqvist (sam@example.com), who has left Lindqvist family.',
        );
        expect(issueLines([issue('former-member', STRANGER, 'version')], family)[0]!.text).toBe(
            'Added by Ana Berg, who has left Lindqvist family.',
        );
        expect(markLabel([issue('former-member', SAM)])).toBe('Unverified');
        // Neither checked nor on the list the server gives: the row and Info's "Changed by" call
        // them the same, rather than "someone" in one place and "someone you haven't checked" in
        // the other.
        const gone = 'a0000000-0000-4000-8000-000000000009';
        expect(issueLines([issue('former-member', gone)], family)[0]!.text).toBe(
            'Written by someone you haven’t checked, who has left Lindqvist family.',
        );
        expect(changedByLabel(issue('former-member', gone))).toBe('Written by');
        expect(changedByWords(issue('former-member', gone), family)).toBe(
            'Someone you haven’t checked, who has left Lindqvist family.',
        );
    });

    test('Info never says the family vouches for a former member, and reads as the row’s mark', () => {
        // Sam was pinned on Berg family's word, and has since left this family: the pin's name
        // still carries the vouch, which nobody gives for him here any more.
        const vouched: SignerNames = {
            ...family,
            checked: {
                ...family.checked,
                [SAM]: 'Sam Lindqvist (sam@example.com), whom Lindqvist family vouches for',
            },
            vouched: {
                [SAM]: {
                    name: 'Sam Lindqvist',
                    email: 'sam@example.com',
                    family: 'Lindqvist family',
                },
            },
        };
        for (const record of ['metadata', 'version'] as const) {
            const gone = issue('former-member', SAM, record);
            const info = `${changedByLabel(gone)} ${changedByWords(gone, vouched)}`;
            expect(info).not.toMatch(/vouche/);
            expect(info).toBe(issueLines([gone], vouched)[0]!.text);
        }
        expect(
            `${changedByLabel(issue('former-member', SAM))} ${changedByWords(issue('former-member', SAM), vouched)}`,
        ).toBe('Written by Sam, who has left Lindqvist family.');
        // Beside Unverified for any other verdict: the plain label, and the name with the address,
        // never the vouch, which this record does not have.
        expect(changedByLabel(issue('unknown-signer', SAM))).toBe('Changed by');
        for (const verdict of ['bad-signature', 'key-conflict', 'retired-key'] as const)
            expect(changedByWords(issue(verdict, SAM), vouched)).toBe(
                'Sam Lindqvist (sam@example.com)',
            );
        for (const verdict of ['retired-key', 'resealed'] as const)
            expect(issueLines([issue(verdict, SAM)], vouched)[0]!.text).not.toMatch(/vouches/);
        expect(issueLines([issue('bad-signature', SAM)], vouched)[0]!.action).toEqual({
            kind: 'again',
            signer: { id: SAM },
            name: 'Sam Lindqvist (sam@example.com)',
        });
    });

    test('Info says "Verified by" only when every record verified and the family vouched for one', () => {
        const by = (
            integrity: NodeIntegrity | null,
            at = { groupId: FAMILY, name: 'Lindqvist family' },
        ) => verifiedByLine({ integrity }, at);
        const via = (metadata: string | null, version: string | null) => ({ metadata, version });
        expect(by({ metadata: 'verified', version: 'verified', via: via(FAMILY, FAMILY) })).toBe(
            'Verified by Lindqvist family',
        );
        // A folder has no version.
        expect(by({ metadata: 'verified', version: null, via: via(FAMILY, null) })).toBe(
            'Verified by Lindqvist family',
        );
        // This person's own words check vouched: nothing to say.
        expect(by({ metadata: 'verified', version: 'verified', via: via(null, null) })).toBeNull();
        // Another family's word counts only when this person took that family's word for the
        // writer ("Trust as … does"), and then it names that family.
        const vouched = 'b0000000-0000-4000-8000-000000000003';
        expect(
            verifiedByLine(
                { integrity: { metadata: 'verified', version: null, via: via(vouched, null) } },
                { groupId: FAMILY, name: 'Lindqvist family' },
                { [vouched]: 'Berg family' },
            ),
        ).toBe('Verified by Berg family');
        // Another family's word does not count here.
        const other = 'b0000000-0000-4000-8000-000000000002';
        expect(
            by({ metadata: 'verified', version: 'verified', via: via(other, other) }),
        ).toBeNull();
        // Any record that did not verify: the mark speaks, never this line.
        expect(
            by({ metadata: 'verified', version: 'former-member', via: via(FAMILY, null) }),
        ).toBeNull();
        expect(
            by({ metadata: 'verified', version: 'unchecked', via: via(FAMILY, null) }),
        ).toBeNull();
        // Checked by the personal verifier (no member list spoke), outside a family folder,
        // or nothing checked: nothing.
        expect(by({ metadata: 'verified', version: null })).toBeNull();
        expect(
            verifiedByLine(
                { integrity: { metadata: 'verified', version: null, via: via(FAMILY, null) } },
                null,
            ),
        ).toBeNull();
        expect(by(null)).toBeNull();
    });
});

describe('outside family folders', () => {
    test('a record written by someone pinned on a family’s word says that family vouched', () => {
        const SAM = 'a0000000-0000-4000-8000-000000000004';
        const vouched: SignerNames = {
            ...names,
            vouched: {
                [SAM]: {
                    name: 'Sam Lindqvist',
                    email: 'sam@example.com',
                    family: 'Lindqvist family',
                },
            },
        };
        const node = (metadata: IntegrityIssue['integrity'] | 'verified', signer: string) => ({
            integrity: { metadata, version: 'verified' } as NodeIntegrity,
            metadataSigner: { id: signer },
            currentVersion: { signer: { id: signer.toUpperCase() } },
        });
        expect(vouchedByLine(node('verified', SAM), vouched)).toBe('Verified by Lindqvist family');
        // Someone whose words were compared: nothing to add.
        expect(vouchedByLine(node('verified', MAYA), vouched)).toBeNull();
        // A record that did not verify: the mark speaks instead.
        expect(vouchedByLine(node('resealed', SAM), vouched)).toBeNull();
        expect(vouchedByLine({ ...node('verified', SAM), integrity: null }, vouched)).toBeNull();

        // Re-keyed records: the family vouches for the bound origin's writer, never the re-keyer.
        const rekeyed = (
            writer: string,
            by: string,
            over: Partial<RekeyNote> = {},
        ): Parameters<typeof vouchedByLine>[0] => {
            const note: RekeyNote = {
                writer: { id: writer },
                by: { id: by },
                integrity: 'verified',
                bound: true,
                ...over,
            };
            return {
                metadataSigner: { id: by },
                currentVersion: { signer: { id: by } },
                integrity: {
                    metadata: 'verified',
                    version: 'verified',
                    rekeyed: { metadata: note, version: note },
                },
            };
        };
        expect(vouchedByLine(rekeyed(SAM, MAYA), vouched)).toBe('Verified by Lindqvist family');
        // Sam, pinned on the family's word, only replaced the keys of Maya's record: whatever his
        // re-key's verdict, the family vouched for no record's writer, so it is not named.
        expect(vouchedByLine(rekeyed(MAYA, SAM), vouched)).toBeNull();
    });
});

/*
 * Re-keyed records (docs/integrity-design.md, "Re-keyed records"): a record
 * reads as its writer's, the re-keyer in Info; "doesn't match" only when the
 * contents showed it, naming the re-keyer only under their own verified
 * signature; anything a server alone could cause, as couldn't confirm.
 */
describe('a re-keyed item', () => {
    const SAM = 'a0000000-0000-4000-8000-000000000004';
    const family: SignerNames = {
        ...names,
        family: {
            name: 'Lindqvist family',
            members: { [SAM]: { name: 'Sam', email: 'sam@example.com' } },
        },
    };
    const note = (over: Partial<RekeyNote> = {}): RekeyNote => ({
        writer: { id: SAM },
        by: { id: MAYA },
        integrity: 'verified',
        bound: true,
        ...over,
    });
    /* A folder (metadata only) whose record the verdict and note describe, as the server names its re-keyer. */
    const folder = (metadata: NodeIntegrity['metadata'], rekeyed: RekeyNote) => ({
        metadataSigner: rekeyed.by,
        currentVersion: null,
        integrity: { metadata, version: null, rekeyed: { metadata: rekeyed, version: null } },
    });
    const lines = (node: ReturnType<typeof folder>, who = family) =>
        issueLines(integrityIssues(node), who).map((line) => line.text);

    test('reads as its writer’s, not the re-keyer’s: a removed member’s file is still theirs', () => {
        const node = folder('former-member', note());
        expect(lines(node)).toEqual([
            'Written by Sam (sam@example.com), who has left Lindqvist family.',
        ]);
        expect(markLabel(integrityIssues(node))).toBe('Unverified');
        // Info names the re-keyer only as such, never as the writer.
        expect(rekeyedLines(node, family)).toEqual({
            writtenBy: null,
            replacedBy: ['Keys replaced by Maya'],
        });
    });

    test('Info names both people when it verified, and the re-keyer is never a mark of its own', () => {
        expect(rekeyedLines(folder('verified', note()), family)).toEqual({
            writtenBy: 'Sam (sam@example.com)',
            replacedBy: ['Keys replaced by Maya'],
        });
        expect(integrityIssues(folder('verified', note()))).toEqual([]);
        // Someone unchecked, or a check that could not run, is said in Info only.
        for (const integrity of ['unknown-signer', 'unchecked', 'retired-key'] as const)
            expect(integrityIssues(folder('verified', note({ integrity })))).toEqual([]);
        expect(
            rekeyedLines(folder('verified', note({ integrity: 'unknown-signer' })), family),
        ).toEqual({
            writtenBy: 'Sam (sam@example.com)',
            replacedBy: ['Keys replaced by someone you haven’t checked'],
        });
        expect(
            rekeyedLines(folder('verified', note({ by: { id: ME } })), family).replacedBy,
        ).toEqual(['Keys replaced by you']);
    });

    test('“doesn’t match” names the re-keyer only when their verified signature covers it', () => {
        expect(lines(folder('bad-signature', note({ bound: false })))).toEqual([
            'What Maya locked again doesn’t match what was written. Don’t trust this item.',
        ]);
        // The contents differ, but the re-key signature is someone unchecked's, or missing: nobody named.
        for (const integrity of ['unknown-signer', 'unsigned', 'bad-signature'] as const)
            expect(lines(folder('bad-signature', note({ bound: false, integrity })))).toEqual([
                'What was locked again doesn’t match what was written. Don’t trust this item.',
            ]);
        // Nor is a mismatch ever said in the writer's name.
        expect(lines(folder('bad-signature', note({ bound: false })))[0]).not.toMatch(/Sam/);
    });

    test('what a server alone could cause is “couldn’t confirm”, never a mismatch or a name', () => {
        const node = folder('unchecked', note({ bound: null }));
        expect(lines(node)).toEqual([REKEY_UNCONFIRMED]);
        expect(issueLines(integrityIssues(node), family)[0]!.action).toEqual({ kind: 'retry' });
        expect(rekeyedLines(node, family)).toEqual({ writtenBy: null, replacedBy: [] });
        expect(lines(node)[0]).not.toMatch(/match|Maya|Sam/);
    });

    test('“Changed by” names the re-keyer only for a mismatch under their verified signature', () => {
        const changedBy = (rekeyed: RekeyNote, metadata: NodeIntegrity['metadata'] = 'verified') =>
            integrityIssues(folder(metadata, rekeyed)).map((issue) => ({
                signer: issue.signer,
                words: changedByWords(issue, family),
            }));
        expect(changedBy(note({ bound: false }), 'bad-signature')).toEqual([
            { signer: { id: MAYA }, words: 'Maya Lindqvist' },
        ]);
        // A mismatch nobody verified, a re-key nobody attested to, one that could not be
        // confirmed: the server names the re-keyer, Info does not.
        for (const rekeyed of [
            note({ bound: false, integrity: 'unknown-signer' }),
            note({ bound: false, integrity: 'unsigned' }),
            note({ integrity: 'unsigned' }),
            note({ integrity: 'key-conflict' }),
            note({ bound: null }),
        ])
            expect(changedBy(rekeyed, rekeyed.bound === true ? 'verified' : 'unchecked')).toEqual([
                { signer: null, words: 'Not confirmed' },
            ]);
    });

    test('a re-key nobody attested to marks the item, over contents that match, without blaming anyone', () => {
        for (const integrity of ['unsigned', 'bad-signature', 'key-conflict'] as const) {
            const node = folder('verified', note({ integrity }));
            expect(lines(node)).toEqual([REKEY_UNATTESTED]);
            expect(markLabel(integrityIssues(node))).toBe('Unverified');
            expect(rekeyedLines(node, family).replacedBy).toEqual([]);
        }
        // The writer's own verdict comes first when that did not verify either.
        expect(lines(folder('former-member', note({ integrity: 'unsigned' })))).toEqual([
            'Written by Sam (sam@example.com), who has left Lindqvist family.',
            REKEY_UNATTESTED,
        ]);
    });

    test('Info names the name’s writer and re-keyer apart from the content’s when they differ', () => {
        const both = {
            metadataSigner: { id: MAYA },
            currentVersion: { signer: { id: ME } },
            integrity: {
                metadata: 'verified' as const,
                version: 'verified' as const,
                rekeyed: {
                    metadata: note(),
                    version: note({ writer: { id: ME }, by: { id: ME } }),
                },
            },
        };
        expect(rekeyedLines(both, family)).toEqual({
            writtenBy: 'Sam (sam@example.com) (name), You (content)',
            replacedBy: ['Keys replaced by Maya (name)', 'Keys replaced by you (content)'],
        });
        // The same people on both records: said once, unlabelled.
        const same = {
            ...both,
            integrity: { ...both.integrity, rekeyed: { metadata: note(), version: note() } },
        };
        expect(rekeyedLines(same, family)).toEqual({
            writtenBy: 'Sam (sam@example.com)',
            replacedBy: ['Keys replaced by Maya'],
        });
        // A version uploaded after the rotation is its own uploader's, by its own signer.
        const newer = {
            ...both,
            currentVersion: { signer: { id: ME } },
            integrity: { ...both.integrity, rekeyed: { metadata: note(), version: null } },
        };
        expect(rekeyedLines(newer, family)).toEqual({
            writtenBy: 'Sam (sam@example.com) (name), You (content)',
            replacedBy: ['Keys replaced by Maya'],
        });
    });

    test('a dropped origin names its dropper only where their checked signature agrees, and never its writer', () => {
        // What a drop leaves: the record re-sealed and signed by the dropper, which this
        // person checked (verdict `resealed` by Maya); the server's trace names Maya.
        const dropped = (by: string, verdict: NodeIntegrity['metadata'], signer = MAYA) => ({
            metadataSigner: { id: signer },
            metadataOriginDropped: { by: { id: by } },
            currentVersion: null,
            integrity: { metadata: verdict, version: null },
        });
        expect(droppedLines(dropped(MAYA, 'resealed'), family)).toEqual([
            'Its original signature was dropped by Maya when its keys were replaced.',
        ]);
        // A served trace blaming someone the verified signature does not name: nobody is named.
        expect(droppedLines(dropped(ME, 'resealed'), family)).toEqual([
            'Its original signature was dropped when its keys were replaced.',
        ]);
        // Nor where the re-sealed signature did not check out, or is someone unchecked's.
        for (const verdict of ['unknown-signer', 'bad-signature', 'unchecked'] as const)
            expect(droppedLines(dropped(MAYA, verdict), family)).toEqual([
                'Its original signature was dropped when its keys were replaced.',
            ]);
        // Re-keyed since: the dropper's re-sealed record is the bound origin, and still names them.
        const rekeyed = {
            ...dropped(MAYA, 'resealed', ME),
            integrity: {
                metadata: 'resealed' as const,
                version: null,
                rekeyed: {
                    metadata: note({ writer: { id: MAYA }, by: { id: ME } }),
                    version: null,
                },
            },
        };
        expect(droppedLines(rekeyed, family)).toEqual([
            'Its original signature was dropped by Maya when its keys were replaced.',
        ]);
        // Unless the origin did not bind: then nothing confirms it.
        const unbound = {
            ...rekeyed,
            integrity: {
                ...rekeyed.integrity,
                rekeyed: {
                    metadata: note({ writer: { id: MAYA }, by: { id: ME }, bound: null }),
                    version: null,
                },
            },
        };
        expect(droppedLines(unbound, family)[0]).not.toMatch(/Maya/);
        // The dropped origin's writer is never named, whoever the server says it was.
        expect(droppedLines(dropped(MAYA, 'resealed'), family)[0]).not.toMatch(/Sam/);
        expect(droppedLines({ integrity: null, currentVersion: null }, family)).toEqual([]);
    });

    test('a saved copy names who saved it, the origin’s writer, never the re-keyer', () => {
        // I saved it from a link; Maya, a checked contact, replaced the keys since.
        const mine = folder('saved-from-link', note({ writer: { id: ME } }));
        expect(savedLine(mine, family)).toBe(
            'Saved from a link by you. HushOS can’t confirm who made the original.',
        );
        // Maya saved it and I replaced the keys: Maya, not me.
        expect(
            savedLine(
                folder('saved-from-link', note({ writer: { id: MAYA }, by: { id: ME } })),
                family,
            ),
        ).toMatch(/^Saved from a link by Maya Lindqvist\./);
        // A file whose content was saved: the version's origin writer, not its re-keyer.
        const file = {
            metadataSigner: { id: MAYA },
            currentVersion: { signer: { id: MAYA } },
            integrity: {
                metadata: 'verified' as const,
                version: 'saved-from-link' as const,
                rekeyed: { metadata: note(), version: note({ writer: { id: ME } }) },
            },
        };
        expect(savedLine(file, family)).toMatch(/^Saved from a link by you\./);
        // Saved by someone this person never checked: nobody is named, the re-keyer least of all.
        expect(
            savedLine(folder('saved-from-link', note({ writer: { id: SAM } })), family),
        ).toBeNull();
    });

    test('a server that puts a pinned member in the re-keyer’s place gets no name for them', () => {
        // The origin, saved by someone unchecked, verified and bound. The server serves Maya's id
        // as the re-keyer with a re-key signature that does not hold, and withholds her links,
        // so her verdict is only `unchecked`: Info-only, no mark. She signed nothing that held.
        const node = folder(
            'saved-from-link',
            note({ writer: { id: STRANGER }, by: { id: MAYA }, integrity: 'unchecked' }),
        );
        expect(savedLine(node, family)).toBeNull();
        // Nor is the reader credited for re-keying someone else's saved copy.
        expect(
            savedLine(
                folder('saved-from-link', note({ writer: { id: SAM }, by: { id: ME } })),
                family,
            ),
        ).toBeNull();
    });
});
