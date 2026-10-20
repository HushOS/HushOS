import type { FamilyPlan, Plan } from '@hushos/billing/api';
import { describe, expect, test } from 'vitest';
import {
    currenciesOf,
    familyOffers,
    familyPairs,
    personalPairs,
    twoMonthsFree,
    priceOf,
    pricingLede,
    tiersOf,
    yearlyPrice,
    yearsByMonth,
} from './plans';

function plan(overrides: Partial<Plan> & { id: string }): Plan {
    return {
        name: 'Pro (monthly)',
        description: null,
        interval: 'month',
        amount: 1000,
        currency: 'usd',
        prices: { usd: 1000 },
        quotaBytes: '536870912000',
        recommended: false,
        ...overrides,
    };
}

describe('priceOf', () => {
    test('uses the currency when the plan has it and the default otherwise', () => {
        const pro = plan({ id: 'pro', prices: { usd: 1000, inr: 79900 } });
        expect(priceOf(pro, 'inr')).toEqual({ amount: 79900, currency: 'inr' });
        expect(priceOf(pro, 'gbp')).toEqual({ amount: 1000, currency: 'usd' });
    });
});

describe('currenciesOf', () => {
    test('offers only currencies every plan is priced in, default first', () => {
        const plans = [
            plan({ id: 'a', prices: { usd: 500, inr: 39900, eur: 500 } }),
            plan({ id: 'b', prices: { usd: 1000, eur: 1000, gbp: 800 } }),
        ];
        expect(currenciesOf(plans)).toEqual(['usd', 'eur']);
        expect(currenciesOf([])).toEqual([]);
    });
});

describe('tiersOf', () => {
    test('joins the monthly and yearly product of one storage size into one tier', () => {
        const tiers = tiersOf([
            plan({ id: 'pro-m', name: 'Pro (monthly)' }),
            plan({ id: 'pro-y', name: 'Pro (yearly)', interval: 'year', amount: 10000 }),
        ]);
        expect(tiers).toHaveLength(1);
        expect(tiers[0]?.name).toBe('Pro');
        expect(tiers[0]?.month?.id).toBe('pro-m');
        expect(tiers[0]?.year?.id).toBe('pro-y');
    });

    test('keeps catalogue order and separates sizes', () => {
        const tiers = tiersOf([
            plan({
                id: 'plus',
                name: 'Plus (yearly)',
                interval: 'year',
                quotaBytes: '214748364800',
            }),
            plan({ id: 'pro', name: 'Pro (monthly)' }),
            plan({ id: 'max', name: 'Max (monthly)', quotaBytes: '1099511627776' }),
        ]);
        expect(tiers.map((tier) => tier.name)).toEqual(['Plus', 'Pro', 'Max']);
        expect(tiers[0]?.month).toBeUndefined();
        expect(tiers[0]?.year?.id).toBe('plus');
    });

    test('a tier is recommended if either of its products is', () => {
        const tiers = tiersOf([
            plan({ id: 'pro-m' }),
            plan({ id: 'pro-y', name: 'Pro (yearly)', interval: 'year', recommended: true }),
        ]);
        expect(tiers[0]?.recommended).toBe(true);
    });

    test('leaves a name alone when it carries no interval suffix', () => {
        expect(tiersOf([plan({ id: 'x', name: 'Team' })])[0]?.name).toBe('Team');
        expect(tiersOf([plan({ id: 'y', name: 'Pro (annual)' })])[0]?.name).toBe('Pro');
    });
});

/*
 * The family tiers as seed.ts makes them (owner, 2026-10-18): Plus 800 GB, Pro
 * 2 TB, Max 4 TB; four members included, then 1.50 a member (1.20 GBP, 59 INR);
 * EUR at parity, GBP at 0.8, INR on the personal ratio. A year (owner, 2026-10-19) is a
 * round total that splits into twelve: 96/192/288 USD and EUR, 72/144/216 GBP, 3,900/7,800/
 * 13,800 INR; a member past the included ones is ten months a year.
 * In the server's order: by pool, monthly before yearly.
 */
const base = {
    plus: { usd: 1000, eur: 1000, gbp: 800, inr: 39900 },
    pro: { usd: 2000, eur: 2000, gbp: 1600, inr: 79900 },
    max: { usd: 3000, eur: 3000, gbp: 2400, inr: 139900 },
};
const yearlyBase = {
    plus: { usd: 9600, eur: 9600, gbp: 7200, inr: 390000 },
    pro: { usd: 19200, eur: 19200, gbp: 14400, inr: 780000 },
    max: { usd: 28800, eur: 28800, gbp: 21600, inr: 1380000 },
};
const perMember = { usd: 150, eur: 150, gbp: 120, inr: 5900 };
const pools = { plus: 800, pro: 2048, max: 4096 };
function family(tier: keyof typeof base, interval: 'month' | 'year'): FamilyPlan {
    const times = interval === 'year' ? 10 : 1;
    const label = { plus: 'Plus', pro: 'Pro', max: 'Max' }[tier];
    return {
        id: `${tier}-${interval}`,
        name: `Family ${label} (${interval === 'year' ? 'yearly' : 'monthly'})`,
        description: null,
        interval,
        tier,
        recommended: tier === 'pro',
        prices: Object.fromEntries(
            Object.entries(interval === 'year' ? yearlyBase[tier] : base[tier]).map(
                ([currency, amount]) => [
                    currency,
                    {
                        base: amount,
                        perMember: perMember[currency as keyof typeof perMember] * times,
                    },
                ],
            ),
        ),
        includedMembers: 4,
        maxMembers: 20,
        quotaBytes: String(pools[tier] * 1024 ** 3),
    };
}
const families = (['plus', 'pro', 'max'] as const).flatMap((tier) => [
    family(tier, 'month'),
    family(tier, 'year'),
]);
const offers = (interval: 'month' | 'year', currency: string, list = families) =>
    familyOffers({ enabled: true, families: list }, interval, currency);

describe('familyOffers', () => {
    test('offers nothing where the server lists no family plan, or with billing off', () => {
        expect(offers('month', 'usd', [])).toEqual([]);
        expect(familyOffers({ enabled: false, families }, 'month', 'usd')).toEqual([]);
    });

    test('offers the three tiers, smallest first, monthly in the visitor’s currency', () => {
        expect(
            offers('month', 'gbp').map(({ name, storage, price, billed, extra }) => ({
                name,
                storage,
                price,
                billed,
                extra,
            })),
        ).toEqual([
            {
                name: 'Family Plus',
                storage: '800 GB',
                price: '£8 a month',
                billed: 'Billed monthly. £72 a year if you pay yearly.',
                extra: 'Each extra member is £1.20 a month.',
            },
            {
                name: 'Family Pro',
                storage: '2 TB',
                price: '£16 a month',
                billed: 'Billed monthly. £144 a year if you pay yearly.',
                extra: 'Each extra member is £1.20 a month.',
            },
            {
                name: 'Family Max',
                storage: '4 TB',
                price: '£24 a month',
                billed: 'Billed monthly. £216 a year if you pay yearly.',
                extra: 'Each extra member is £1.20 a month.',
            },
        ]);
        expect(offers('month', 'inr').map((offer) => offer.price)).toEqual([
            '₹399 a month',
            '₹799 a month',
            '₹1,399 a month',
        ]);
        expect(offers('month', 'inr')[0]?.extra).toBe('Each extra member is ₹59 a month.');
        expect(offers('month', 'eur').map((offer) => offer.price)).toEqual([
            '€10 a month',
            '€20 a month',
            '€30 a month',
        ]);
    });

    test('shows a yearly tier as its whole month, then every yearly figure in one sentence', () => {
        expect(
            offers('year', 'usd').map(({ price, billed, extra }) => [price, billed, extra]),
        ).toEqual([
            ['$8 a month', 'Billed $96 yearly, plus $15 for each extra member.', null],
            ['$16 a month', 'Billed $192 yearly, plus $15 for each extra member.', null],
            ['$24 a month', 'Billed $288 yearly, plus $15 for each extra member.', null],
        ]);
        // ₹590 a year doesn't split into whole months, so it stays a yearly figure.
        expect(offers('year', 'inr').map(({ price, billed }) => [price, billed])).toEqual([
            ['₹325 a month', 'Billed ₹3,900 yearly, plus ₹590 for each extra member.'],
            ['₹650 a month', 'Billed ₹7,800 yearly, plus ₹590 for each extra member.'],
            ['₹1,150 a month', 'Billed ₹13,800 yearly, plus ₹590 for each extra member.'],
        ]);
        expect(offers('year', 'gbp').map((offer) => offer.price)).toEqual([
            '£6 a month',
            '£12 a month',
            '£18 a month',
        ]);
        expect(offers('year', 'usd')[1]?.plan.id).toBe('pro-year');
    });

    test('one yearly price that doesn’t split into whole months puts every tier by the year', () => {
        // Ten months of ₹399, as the old table priced it: ₹332.50 a month is never shown, and the
        // tiers that do split don't show a month beside a year.
        const odd = families.map((plan) =>
            plan.id === 'plus-year'
                ? { ...plan, prices: { ...plan.prices, inr: { base: 399000, perMember: 59000 } } }
                : plan,
        );
        expect(
            offers('year', 'inr', odd).map(({ price, billed, extra }) => [price, billed, extra]),
        ).toEqual([
            ['₹3,990 a year', 'Billed yearly.', 'Each extra member is ₹590 a year.'],
            ['₹7,800 a year', 'Billed yearly.', 'Each extra member is ₹590 a year.'],
            ['₹13,800 a year', 'Billed yearly.', 'Each extra member is ₹590 a year.'],
        ]);
        // Decided per currency: the dollar prices all split.
        expect(offers('year', 'usd', odd)[0]?.price).toBe('$8 a month');
    });

    test('falls back to the default currency, never a price in a currency it lacks', () => {
        expect(offers('month', 'jpy').map((offer) => offer.price)).toEqual([
            '$10 a month',
            '$20 a month',
            '$30 a month',
        ]);
    });

    test('a tier with only one interval on sale still shows, at that interval', () => {
        const list = families.filter((plan) => plan.id !== 'max-year');
        const yearly = offers('year', 'usd', list);
        expect(yearly.map((offer) => offer.plan.id)).toEqual([
            'plus-year',
            'pro-year',
            'max-month',
        ]);
        expect(yearly[2]?.billed).toBe('Billed monthly.');
    });
});

describe('pricingLede', () => {
    test('keeps "nothing else" only while no family plan is shown', () => {
        const off =
            'Every plan protects your files the same way. Paid plans add space, and nothing else.';
        expect(pricingLede(offers('month', 'usd', []))).toBe(off);
        expect(pricingLede(familyOffers({ enabled: false, families }, 'month', 'usd'))).toBe(off);
        expect(pricingLede(offers('month', 'usd'))).toBe(
            'Every plan protects your files the same way. Paid plans add space; a family plan covers up to 20 people, with folders you share.',
        );
    });
});

describe('yearlyPrice', () => {
    test('by the month only when the year splits into twelve whole units of its currency', () => {
        expect(yearlyPrice(390000, 'inr', true)).toEqual({
            byMonth: true,
            price: '₹325 a month',
            billed: 'Billed ₹3,900 yearly.',
            line: '₹325 a month, billed ₹3,900 yearly.',
        });
        expect(yearlyPrice(4800, 'usd', true).price).toBe('$4 a month');
        // The page decided against months (another year in the catalogue doesn't split).
        expect(yearlyPrice(4800, 'usd', false).price).toBe('$48 a year');
        // A unit either side of a whole month, and ten months of $5: the year alone, no cents.
        for (const amount of [4799, 4801, 5000])
            expect(yearlyPrice(amount, 'usd', true).price).toMatch(/^\$[\d.,]+ a year$/);
        expect(yearlyPrice(5000, 'usd', true)).toEqual({
            byMonth: false,
            price: '$50 a year',
            billed: 'Billed yearly.',
            line: '$50 a year.',
        });
    });
});

describe('yearsByMonth', () => {
    const yearly = (usd: number) =>
        plan({ id: 'plus-y', interval: 'year', amount: usd, prices: { usd } });
    const monthly = plan({ id: 'plus-m', amount: 499, prices: { usd: 499 } });

    test('holds only while every yearly price, personal and family, splits into whole months', () => {
        expect(yearsByMonth({ plans: [monthly, yearly(4800)], families }, 'usd')).toBe(true);
        // Ten months of $5: one personal year that doesn't split puts the family cards by the year too.
        expect(yearsByMonth({ plans: [monthly, yearly(5000)], families }, 'usd')).toBe(false);
        const odd = families.map((candidate) =>
            // Ten months of $10.
            candidate.id === 'plus-year'
                ? { ...candidate, prices: { usd: { base: 10000, perMember: 1500 } } }
                : candidate,
        );
        expect(yearsByMonth({ plans: [yearly(4800)], families: odd }, 'usd')).toBe(false);
        // A monthly price never needs to split: $4.99 a month is shown as it is.
        expect(yearsByMonth({ plans: [monthly], families: [] }, 'usd')).toBe(true);
    });
});

describe('twoMonthsFree', () => {
    const tier = (name: string, month: number, year: number) => [
        plan({ id: `${name}-m`, name: `${name} (monthly)`, amount: month, prices: { usd: month } }),
        plan({
            id: `${name}-y`,
            name: `${name} (yearly)`,
            interval: 'year',
            amount: year,
            prices: { usd: year },
        }),
    ];

    test('holds for the prices on sale: every year at most ten months, family members included', () => {
        for (const currency of ['usd', 'eur', 'gbp', 'inr'])
            expect(twoMonthsFree(familyPairs(families, currency)), currency).toBe(true);
    });

    test('a year at exactly ten months still saves two; one unit more, on any tier, says nothing', () => {
        expect(twoMonthsFree(personalPairs(tier('plus', 500, 5000), 'usd'))).toBe(true);
        expect(twoMonthsFree(personalPairs(tier('plus', 500, 5001), 'usd'))).toBe(false);
        // Ten months of a family's extra member, plus one cent.
        const dear = families.map((candidate) =>
            candidate.id === 'max-year'
                ? { ...candidate, prices: { usd: { base: 28800, perMember: 1501 } } }
                : candidate,
        );
        expect(twoMonthsFree(familyPairs(dear, 'usd'))).toBe(false);
        expect(twoMonthsFree(familyPairs(dear, 'gbp'))).toBe(true);
    });

    test('says nothing where no tier is priced both ways', () => {
        expect(twoMonthsFree([])).toBe(false);
        expect(
            twoMonthsFree(
                familyPairs(
                    families.filter((p) => p.interval === 'month'),
                    'usd',
                ),
            ),
        ).toBe(false);
    });
});
