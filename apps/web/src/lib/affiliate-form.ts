import type { AffiliateInput, AffiliateView } from '@hushos/billing/api';

/*
 * The affiliate dialog's fields as typed. Numbers stay text while someone
 * edits them, so an emptied field is empty rather than 0, and are read once,
 * on blur and on save. The server checks the same ranges again.
 */
export type AffiliateDraft = {
    name: string;
    slug: string;
    code: string;
    percentOff: string;
    duration: AffiliateInput['duration'];
    durationMonths: string;
    commission: string;
    userEmail: string;
    notes: string;
};

export type DraftField = 'percentOff' | 'commission' | 'durationMonths' | 'userEmail';

export const emptyDraft: AffiliateDraft = {
    name: '',
    slug: '',
    code: '',
    percentOff: '20',
    duration: 'forever',
    durationMonths: '3',
    commission: '20',
    userEmail: '',
    notes: '',
};

/* Basis points as the percentage an operator types: 2000 is "20", 1250 is "12.5". */
export function percentText(bps: number) {
    const whole = Math.trunc(bps / 100);
    const cents = String(bps % 100)
        .padStart(2, '0')
        .replace(/0+$/, '');
    return cents ? `${whole}.${cents}` : String(whole);
}

export function draftFrom(affiliate: AffiliateView): AffiliateDraft {
    return {
        name: affiliate.name,
        slug: affiliate.slug,
        code: affiliate.code,
        percentOff: String(affiliate.percentOff),
        duration: affiliate.duration,
        durationMonths: String(affiliate.durationMonths ?? 3),
        commission: percentText(affiliate.commissionBps),
        // Leaving the account empty keeps the one linked; an email replaces it.
        userEmail: '',
        notes: affiliate.notes ?? '',
    };
}

/* A whole number in a range, digits only: no sign, exponent or blank read as 0. */
function whole(text: string, min: number, max: number) {
    const trimmed = text.trim();
    if (!/^\d{1,4}$/.test(trimmed)) return null;
    const value = Number(trimmed);
    return value >= min && value <= max ? value : null;
}

/*
 * A percentage with up to two decimals, as basis points, worked out on the
 * digits so 0.29 is 29 exactly. A comma is a decimal point too.
 */
function basisPoints(text: string) {
    const trimmed = text.trim();
    const match = /^(\d{1,3})?(?:[.,](\d{0,2}))?$/.exec(trimmed);
    if (!match || !/\d/.test(trimmed)) return null;
    const bps = Number(match[1] ?? 0) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
    return bps <= 10_000 ? bps : null;
}

/* The form, not the address: the server applies the sign-up rule. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MESSAGES: Record<DraftField, string> = {
    percentOff: 'Enter a whole number from 1 to 100.',
    commission: 'Enter a percentage from 0 to 100, with up to two decimals.',
    durationMonths: 'Enter a whole number of months from 1 to 36.',
    userEmail: 'Enter an email address, or leave this empty.',
};

export type DraftReading =
    | { ok: true; input: AffiliateInput; errors: Partial<Record<DraftField, string>> }
    | { ok: false; input: null; errors: Partial<Record<DraftField, string>> };

/* What the server wants: numbers read, optionals trimmed to null, months only for a repeating discount. */
export function readDraft(draft: AffiliateDraft): DraftReading {
    const percentOff = whole(draft.percentOff, 1, 100);
    const commissionBps = basisPoints(draft.commission);
    const repeating = draft.duration === 'repeating';
    const durationMonths = repeating ? whole(draft.durationMonths, 1, 36) : null;
    const userEmail = draft.userEmail.trim() || null;
    const errors: Partial<Record<DraftField, string>> = {};
    if (percentOff === null) errors.percentOff = MESSAGES.percentOff;
    if (commissionBps === null) errors.commission = MESSAGES.commission;
    if (repeating && durationMonths === null) errors.durationMonths = MESSAGES.durationMonths;
    if (userEmail && !EMAIL.test(userEmail)) errors.userEmail = MESSAGES.userEmail;
    if (percentOff === null || commissionBps === null || Object.keys(errors).length > 0)
        return { ok: false, input: null, errors };
    return {
        ok: true,
        errors,
        input: {
            name: draft.name,
            slug: draft.slug,
            code: draft.code,
            percentOff,
            duration: draft.duration,
            durationMonths,
            commissionBps,
            userEmail,
            notes: draft.notes.trim() || null,
        },
    };
}

/*
 * An edit as the server takes it. The account field starts empty and empty
 * means "keep the linked account", so no email sends no `userEmail` at all:
 * the server reads a null one as "unlink".
 */
export function editPatch(input: AffiliateInput): Partial<AffiliateInput> {
    const { userEmail, ...rest } = input;
    return userEmail ? { ...rest, userEmail } : rest;
}
