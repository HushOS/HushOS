import type { FamilyPlan, Plan } from '@hushos/billing/api';
import { describe, expect, test } from 'vitest';
import { defaultFamilyName, familyLanding, familyStanding } from './family-signup';

const personal = (prices: Record<string, number>): Plan => ({
    id: 'plus-month',
    name: 'Plus (monthly)',
    description: null,
    interval: 'month',
    amount: prices.usd ?? 0,
    currency: 'usd',
    prices,
    quotaBytes: String(200 * 1024 ** 3),
    recommended: false,
});
const familyPro = (prices: FamilyPlan['prices']): FamilyPlan => ({
    id: 'family-pro-month',
    name: 'Family Pro (monthly)',
    description: null,
    interval: 'month',
    tier: 'pro',
    recommended: true,
    prices,
    includedMembers: 4,
    maxMembers: 20,
    quotaBytes: String(2048 * 1024 ** 3),
});
const everywhere = familyPro({
    usd: { base: 2000, perMember: 150 },
    inr: { base: 79900, perMember: 5900 },
});
const catalogue = {
    plans: [personal({ usd: 300, inr: 14900, gbp: 250 })],
    families: [everywhere],
};
const india = { country: 'IN', acceptLanguage: null, trusted: true };
const land = (input: Partial<Parameters<typeof familyLanding>[0]> = {}) =>
    familyLanding({
        tier: everywhere.id,
        groupsEnabled: true,
        families: [],
        catalogue,
        hint: india,
        ...input,
    });

const member = (state: string, name = 'Ortega family') => ({
    id: `group-${state}`,
    kind: 'family',
    name,
    state,
});

describe('familyStanding', () => {
    test('in a family, waiting to join one, or in none', () => {
        expect(familyStanding([member('left'), member('active', 'Berg family')])).toEqual({
            kind: 'in',
            family: member('active', 'Berg family'),
        });
        expect(familyStanding([member('accepted')])).toEqual({
            kind: 'waiting',
            family: member('accepted'),
        });
        expect(familyStanding([member('left'), member('removed')])).toEqual({ kind: 'none' });
        expect(familyStanding([])).toEqual({ kind: 'none' });
    });

    test('being in a family outranks waiting to join another', () => {
        expect(familyStanding([member('accepted', 'Berg family'), member('active')])).toMatchObject(
            { kind: 'in', family: { name: 'Ortega family' } },
        );
    });
});

describe('defaultFamilyName', () => {
    test('is the account’s first name as a family, else My family', () => {
        expect(defaultFamilyName('Sam Ortega')).toBe('Sam’s family');
        expect(defaultFamilyName('  Maya\tLindqvist ')).toBe('Maya’s family');
        expect(defaultFamilyName('')).toBe('My family');
        expect(defaultFamilyName('   ')).toBe('My family');
        expect(defaultFamilyName(undefined)).toBe('My family');
    });

    test('never suggests a name longer than the field takes', () => {
        expect(defaultFamilyName('a'.repeat(91))).toBe(`${'a'.repeat(91)}’s family`);
        expect(defaultFamilyName('a'.repeat(92))).toBe('My family');
    });
});

describe('familyLanding', () => {
    test('opens Create a family with the tier, in the currency sign-up showed it in', () => {
        expect(land()).toEqual({
            to: '/app/family',
            search: { create: everywhere.id, currency: 'inr' },
        });
    });

    test('someone already in a family lands on it, never on a second one', () => {
        expect(land({ families: [member('active')] })).toEqual({ to: '/app/family' });
    });

    test('someone waiting to join a family lands on it too, never on paying for another', () => {
        expect(land({ families: [member('accepted')] })).toEqual({ to: '/app/family' });
    });

    test('a family they left or were removed from is no family', () => {
        expect(land({ families: [member('left'), member('removed')] })).toMatchObject({
            search: { create: everywhere.id },
        });
    });

    test('with the families unread, the family page decides, so the tier still rides along', () => {
        expect(land({ families: undefined })).toMatchObject({ search: { create: everywhere.id } });
    });

    test('goes to Plans where families aren’t served, or the tier is no longer offered', () => {
        expect(land({ groupsEnabled: false })).toEqual({ to: '/app/billing' });
        expect(land({ tier: 'family-old' })).toEqual({ to: '/app/billing' });
        expect(land({ catalogue: { ...catalogue, families: [] } })).toEqual({
            to: '/app/billing',
        });
    });

    test('a tier with no price in the visitor’s currency is charged in its default', () => {
        const usdOnly = familyPro({ usd: { base: 2000, perMember: 150 } });
        const britain = { country: 'GB', acceptLanguage: null, trusted: true };
        // Personal plans are sold in pounds, so sign-up picks them; the tier has none.
        expect(land({ catalogue: { ...catalogue, families: [usdOnly] }, hint: britain })).toEqual({
            to: '/app/family',
            search: { create: usdOnly.id, currency: 'usd' },
        });
    });
});
