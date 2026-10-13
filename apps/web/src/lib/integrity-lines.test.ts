import type { IntegrityIssue } from '@hushos/drive/trust';
import { describe, expect, test } from 'vitest';
import {
    COULDNT_CHECK,
    issueLines,
    markLabel,
    savedLine,
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
