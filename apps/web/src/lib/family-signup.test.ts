import type { FamilyPlan, Plan } from '@hushos/billing/api';
import { checkGroupName } from '@hushos/groups/protocol';
import { describe, expect, test } from 'vitest';
import { defaultFamilyName, familyLanding, familyStanding, firstLanding } from './family-signup';

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
    // Every suggestion must be one the server stores as it is (its groupName is checkGroupName).
    const accepted = (name: string) => expect(checkGroupName(name)).toBe(name);

    test('is the account’s full name as a family, else My family', () => {
        expect(defaultFamilyName('Sam Ortega')).toBe('Sam Ortega’s family');
        expect(defaultFamilyName('  Maya   Lindqvist ')).toBe('Maya Lindqvist’s family');
        expect(defaultFamilyName('')).toBe('My family');
        expect(defaultFamilyName('   ')).toBe('My family');
        expect(defaultFamilyName(undefined)).toBe('My family');
        accepted(defaultFamilyName('Sam Ortega'));
        accepted(defaultFamilyName(''));
    });

    test('a tab between names is a space, never a character the server refuses', () => {
        const name = defaultFamilyName('Sam\tOrtega');
        expect(name).toBe('Sam Ortega’s family');
        accepted(name);
    });

    test('invisible marks the server refuses are left out: ZWNJ, bidi marks, an emoji’s joiners', () => {
        // Persian names often carry a zero-width non-joiner.
        const persian = defaultFamilyName('مهر\u200cانگیز');
        expect(persian).toBe('مهرانگیز’s family');
        accepted(persian);
        const bidi = defaultFamilyName('\u202bسارا\u202c \u200fRahimi');
        expect(bidi).toBe('سارا Rahimi’s family');
        accepted(bidi);
        const emoji = defaultFamilyName('👨\u200d👩\u200d👧 Lee');
        expect(emoji).toBe('👨👩👧 Lee’s family');
        accepted(emoji);
        // Nothing but marks: nothing left to name it after.
        expect(defaultFamilyName('\u200c\u200f')).toBe('My family');
    });

    test('a long name is cut, never the ’s family, and never inside a character', () => {
        const long = defaultFamilyName('a'.repeat(200));
        expect(long).toBe(`${'a'.repeat(91)}’s family`);
        accepted(long);
        // A thumb with its skin tone is one character of two code points: kept whole or dropped.
        const thumb = defaultFamilyName(`${'a'.repeat(90)}👍🏽 Ortega`);
        expect(thumb).toBe(`${'a'.repeat(90)}’s family`);
        accepted(thumb);
        // Combining accents stay on their letter, composed as the server stores it.
        const accent = defaultFamilyName(`${'e'.repeat(89)}Jose\u0301`);
        accepted(accent);
        expect(Array.from(accent).length).toBeLessThanOrEqual(100);
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

describe('firstLanding', () => {
    type Deps = Parameters<typeof firstLanding>[0];
    /* The readings an account just signed up for Family Pro would get, each one replaceable. */
    function deps(overrides: Partial<Deps> = {}) {
        const forgotten: unknown[] = [];
        const all: Deps = {
            summary: async () => ({ intendedPlan: null, intendedFamily: everywhere.id }),
            capabilities: async () => ({ groups: true }),
            catalogue: async () => catalogue,
            hint: async () => india,
            families: async () => [],
            forget: async () => {
                forgotten.push(true);
            },
            ...overrides,
        };
        return { all, forgotten };
    }

    test('a family tier opens Create a family with it, and is forgotten once', async () => {
        const { all, forgotten } = deps();
        expect(await firstLanding(all)).toEqual({
            kind: 'go',
            to: { to: '/app/family', search: { create: everywhere.id, currency: 'inr' } },
        });
        expect(forgotten).toHaveLength(1);
    });

    test('a personal plan goes on to its checkout, and nothing is forgotten', async () => {
        const { all, forgotten } = deps({
            summary: async () => ({ intendedPlan: 'plus-month', intendedFamily: null }),
        });
        expect(await firstLanding(all)).toEqual({ kind: 'checkout', plan: 'plus-month' });
        expect(forgotten).toHaveLength(0);
    });

    test('with no summary, nothing happens and the tier is kept for the next visit', async () => {
        const { all, forgotten } = deps({
            summary: async () => {
                throw new Error('offline');
            },
        });
        expect(await firstLanding(all)).toEqual({ kind: 'stay' });
        expect(forgotten).toHaveLength(0);
    });

    test('someone waiting to join a family lands on Family, without the tier', async () => {
        const { all } = deps({ families: async () => [member('accepted')] });
        expect(await firstLanding(all)).toEqual({ kind: 'go', to: { to: '/app/family' } });
    });

    test('where families aren’t served, it goes to Plans without asking for the families', async () => {
        let asked = false;
        const { all, forgotten } = deps({
            capabilities: async () => ({ groups: false }),
            families: async () => {
                asked = true;
                return [];
            },
        });
        expect(await firstLanding(all)).toEqual({ kind: 'go', to: { to: '/app/billing' } });
        expect(asked).toBe(false);
        expect(forgotten).toHaveLength(1);
    });
});
