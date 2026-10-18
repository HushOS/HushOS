import { describe, expect, test } from 'vitest';
import {
    FAMILY_PER_MEMBER_YEAR_FACTOR,
    familyPerMember,
    familyPrices,
    familyTiers,
    personalPrices,
    priceProblem,
    seedPriceProblems,
    tiers,
} from './seed-prices';

/* A year by the month, in whole units of the currency, as the pricing page shows it. */
const byMonth = (table: Record<string, number>) =>
    Object.fromEntries(
        Object.entries(table).map(([currency, amount]) => [currency, amount / 1200]),
    );

describe('the seeded prices', () => {
    test('keep the monthly table exactly as the owner set it', () => {
        expect(tiers.map((tier) => [tier.name, tier.month])).toEqual([
            ['Plus', { usd: 500, eur: 500, gbp: 400, inr: 19900 }],
            ['Pro', { usd: 1000, eur: 1000, gbp: 800, inr: 39900 }],
            ['Max', { usd: 1500, eur: 1500, gbp: 1200, inr: 69900 }],
        ]);
        expect(familyTiers.map((tier) => [tier.name, tier.month])).toEqual([
            ['Family Plus', { usd: 1000, eur: 1000, gbp: 800, inr: 39900 }],
            ['Family Pro', { usd: 2000, eur: 2000, gbp: 1600, inr: 79900 }],
            ['Family Max', { usd: 3000, eur: 3000, gbp: 2400, inr: 139900 }],
        ]);
        expect(familyPerMember).toEqual({ usd: 150, eur: 150, gbp: 120, inr: 5900 });
    });

    test('pass every check the seed makes before it calls Polar', () => {
        expect(seedPriceProblems()).toEqual([]);
    });

    test('price a personal year at the owner’s round totals, a whole month each', () => {
        expect(tiers.map((tier) => [tier.name, byMonth(tier.year)])).toEqual([
            ['Plus', { usd: 4, eur: 4, gbp: 3, inr: 165 }],
            ['Pro', { usd: 8, eur: 8, gbp: 6, inr: 325 }],
            ['Max', { usd: 12, eur: 12, gbp: 9, inr: 575 }],
        ]);
    });

    test('price a family year at the owner’s round totals, and a member past the included ones at ten months', () => {
        expect(familyTiers.map((tier) => [tier.name, byMonth(tier.year)])).toEqual([
            ['Family Plus', { usd: 8, eur: 8, gbp: 6, inr: 325 }],
            ['Family Pro', { usd: 16, eur: 16, gbp: 12, inr: 650 }],
            ['Family Max', { usd: 24, eur: 24, gbp: 18, inr: 1150 }],
        ]);
        const yearly = Object.fromEntries(
            Object.entries(familyPerMember).map(([currency, amount]) => [
                currency,
                amount * FAMILY_PER_MEMBER_YEAR_FACTOR,
            ]),
        );
        expect(yearly).toEqual({ usd: 1500, eur: 1500, gbp: 1200, inr: 59000 });
    });
});

describe('priceProblem', () => {
    const month = { usd: 500, inr: 19900 };

    test('refuses a year that doesn’t split into twelve whole units, either side of one', () => {
        expect(priceProblem('Plus', month, { usd: 4800, inr: 198000 })).toBeNull();
        for (const usd of [4799, 4801, 5000])
            expect(priceProblem('Plus', month, { usd, inr: 198000 })).toBe(
                'Plus yearly in usd doesn’t split into twelve whole units.',
            );
        // Ten months of ₹399, the old rule's price: ₹332.50 a month.
        expect(priceProblem('Pro', { usd: 1000, inr: 39900 }, { usd: 9600, inr: 399000 })).toBe(
            'Pro yearly in inr doesn’t split into twelve whole units.',
        );
    });

    test('refuses a year dearer than ten months, which isn’t two months free; exactly ten is', () => {
        for (const usd of [400, 479])
            expect(priceProblem('Plus', { usd }, { usd: 4800 })).toBe(
                'Plus yearly in usd costs more than ten months, so it isn’t two months free.',
            );
        expect(priceProblem('Plus', { usd: 480 }, { usd: 4800 })).toBeNull();
    });

    test('refuses a year missing the default currency or priced in other currencies', () => {
        expect(priceProblem('Plus', month, { inr: 198000 } as never)).toBe(
            'Plus has no USD price; Polar treats that as free.',
        );
        expect(priceProblem('Plus', month, { usd: 4800 })).toBe(
            'Plus is priced yearly in other currencies than monthly.',
        );
        expect(priceProblem('Plus', month, { usd: 4800, inr: 198000, gbp: 3600 })).toBe(
            'Plus is priced yearly in other currencies than monthly.',
        );
    });
});

describe('what Polar is sent', () => {
    const named = <T extends { name: string }>(list: T[], name: string) =>
        list.find((tier) => tier.name === name)!;

    test('personal Pro yearly is one fixed price per currency, 96 USD', () => {
        expect(personalPrices(named(tiers, 'Pro').year).map(({ create }) => create)).toEqual([
            { amount_type: 'fixed', price_amount: 9600, price_currency: 'usd' },
            { amount_type: 'fixed', price_amount: 9600, price_currency: 'eur' },
            { amount_type: 'fixed', price_amount: 7200, price_currency: 'gbp' },
            { amount_type: 'fixed', price_amount: 390000, price_currency: 'inr' },
        ]);
        expect(personalPrices(named(tiers, 'Pro').month)[0]?.create.price_amount).toBe(1000);
    });

    test('Family Pro yearly is 192 USD fixed, four free places, then 15 USD a member a year', () => {
        const prices = familyPrices(named(familyTiers, 'Family Pro'), 'year');
        const usd = prices.filter((price) => price.price_currency === 'usd');
        expect(usd).toEqual([
            { amount_type: 'fixed', price_currency: 'usd', price_amount: 19200 },
            {
                amount_type: 'unit_based',
                price_currency: 'usd',
                tiers: {
                    type: 'graduated',
                    tiers: [
                        { bound: 4, unit_amount: 0 },
                        { bound: null, unit_amount: 1500 },
                    ],
                },
                minimum_units: 4,
                unit_label: { en: { '=1': 'member', other: 'members' } },
            },
        ]);
        // Two prices in each of the four currencies, and the rupee member at 590 a year.
        expect(prices).toHaveLength(8);
        const inr = prices.find(
            (price) => price.price_currency === 'inr' && price.amount_type === 'unit_based',
        );
        expect(inr && 'tiers' in inr && inr.tiers?.tiers[1]).toEqual({
            bound: null,
            unit_amount: 59000,
        });
    });

    test('Family Pro monthly is 20 USD fixed, then 1.50 USD a member', () => {
        const usd = familyPrices(named(familyTiers, 'Family Pro'), 'month').filter(
            (price) => price.price_currency === 'usd',
        );
        expect(usd[0]).toMatchObject({ amount_type: 'fixed', price_amount: 2000 });
        expect(usd[1]).toMatchObject({
            tiers: {
                tiers: [
                    { bound: 4, unit_amount: 0 },
                    { bound: null, unit_amount: 150 },
                ],
            },
            minimum_units: 4,
        });
    });
});
