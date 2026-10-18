import { describe, expect, test } from 'vitest';
import {
    FAMILY_PER_MEMBER_YEAR_FACTOR,
    familyPerMember,
    familyTiers,
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

    test('refuses a year at ten months or more, which isn’t more than two months free', () => {
        for (const usd of [400, 480])
            expect(priceProblem('Plus', { usd }, { usd: 4800 })).toBe(
                'Plus yearly in usd isn’t more than two months free.',
            );
        expect(priceProblem('Plus', { usd: 481 }, { usd: 4800 })).toBeNull();
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
