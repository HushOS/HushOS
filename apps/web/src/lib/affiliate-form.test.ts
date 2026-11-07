import type { AffiliateView } from '@hushos/billing/api';
import { describe, expect, test } from 'vitest';
import {
    draftFrom,
    editPatch,
    emptyDraft,
    percentText,
    readDraft,
    type AffiliateDraft,
} from './affiliate-form';

/*
 * The dialog used to read each number field with Number(value) as it changed,
 * so clearing a field saved 0 and erasing to retype was impossible. These
 * cases hold the fields as text and read them only when the form is checked.
 */

const draft = (patch: Partial<AffiliateDraft>): AffiliateDraft => ({
    ...emptyDraft,
    name: 'Ada',
    slug: 'ada',
    code: 'ADA20',
    ...patch,
});

describe('reading the affiliate form', () => {
    test('an emptied field is not 0: it is an error that blocks saving', () => {
        for (const field of ['percentOff', 'commission'] as const) {
            const reading = readDraft(draft({ [field]: '' }));
            expect(reading.ok).toBe(false);
            expect(reading.input).toBeNull();
            expect(reading.errors[field]).toBeTruthy();
        }
        const months = readDraft(draft({ duration: 'repeating', durationMonths: '  ' }));
        expect(months.ok).toBe(false);
        expect(months.errors.durationMonths).toBeTruthy();
    });

    test('what Number() would have taken is refused: signs, exponents, hex and fractions of a whole', () => {
        for (const text of ['-5', '+5', '1e1', '0x10', '2.5', '20%', 'twenty'])
            expect(readDraft(draft({ percentOff: text })).errors.percentOff).toBeTruthy();
        for (const text of ['-1', '1e1', '0x10', '12.345', '.', '1.2.3'])
            expect(readDraft(draft({ commission: text })).errors.commission).toBeTruthy();
    });

    test('the ranges are the server’s: 1 to 100 off, 0 to 100% commission, 1 to 36 months', () => {
        expect(readDraft(draft({ percentOff: '0' })).ok).toBe(false);
        expect(readDraft(draft({ percentOff: '101' })).ok).toBe(false);
        expect(readDraft(draft({ percentOff: '100' })).input?.percentOff).toBe(100);
        expect(readDraft(draft({ commission: '100.01' })).ok).toBe(false);
        expect(readDraft(draft({ commission: '0' })).input?.commissionBps).toBe(0);
        expect(readDraft(draft({ commission: '100' })).input?.commissionBps).toBe(10_000);
        expect(readDraft(draft({ duration: 'repeating', durationMonths: '0' })).ok).toBe(false);
        expect(readDraft(draft({ duration: 'repeating', durationMonths: '37' })).ok).toBe(false);
        expect(
            readDraft(draft({ duration: 'repeating', durationMonths: '36' })).input?.durationMonths,
        ).toBe(36);
    });

    test('a commission is read on its digits: 0.29 is 29 basis points, and a comma is a decimal point', () => {
        expect(readDraft(draft({ commission: '0.29' })).input?.commissionBps).toBe(29);
        expect(readDraft(draft({ commission: '12,5' })).input?.commissionBps).toBe(1250);
        expect(readDraft(draft({ commission: ' 12.25 ' })).input?.commissionBps).toBe(1225);
        expect(readDraft(draft({ commission: '.5' })).input?.commissionBps).toBe(50);
        expect(readDraft(draft({ commission: '5.' })).input?.commissionBps).toBe(500);
    });

    test('months count only for a discount that repeats; another duration ignores a bad months field', () => {
        const reading = readDraft(draft({ duration: 'forever', durationMonths: '' }));
        expect(reading.ok).toBe(true);
        expect(reading.input?.durationMonths).toBeNull();
    });

    test('an email is optional, trimmed, and refused only when it is not shaped like one', () => {
        expect(readDraft(draft({ userEmail: '   ' })).input?.userEmail).toBeNull();
        expect(readDraft(draft({ userEmail: ' new@hushos.test ' })).input?.userEmail).toBe(
            'new@hushos.test',
        );
        expect(readDraft(draft({ userEmail: 'not an email' })).errors.userEmail).toBeTruthy();
    });

    test('an affiliate as saved reads back to the same numbers', () => {
        const affiliate = {
            name: 'Ada',
            slug: 'ada',
            code: 'ADA20',
            percentOff: 15,
            duration: 'repeating',
            durationMonths: 6,
            commissionBps: 1225,
            notes: null,
        } as AffiliateView;
        expect(percentText(2000)).toBe('20');
        expect(percentText(1250)).toBe('12.5');
        expect(percentText(29)).toBe('0.29');
        expect(readDraft(draftFrom(affiliate)).input).toMatchObject({
            percentOff: 15,
            durationMonths: 6,
            commissionBps: 1225,
            userEmail: null,
            notes: null,
        });
    });

    test('an edit with the account field left empty keeps the linked account: it sends no email, not a null one', () => {
        const kept = editPatch(readDraft(draft({ userEmail: '  ' })).input!);
        expect(kept).not.toHaveProperty('userEmail');
        expect(kept).toMatchObject({ name: 'Ada', percentOff: 20, commissionBps: 2000 });
        expect(editPatch(readDraft(draft({ userEmail: 'new@hushos.test' })).input!)).toMatchObject({
            userEmail: 'new@hushos.test',
        });
    });
});
