import type { FamilyPlan, Plan } from '@hushos/billing/api';
import { describe, expect, test } from 'vitest';
import { currenciesOf, familyOffers, priceOf, pricingLede, tiersOf } from './plans';

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
 * EUR at parity, GBP at 0.8, INR on the personal ratio; a year is ten months.
 * In the server's order: by pool, monthly before yearly.
 */
const base = {
    plus: { usd: 1000, eur: 1000, gbp: 800, inr: 39900 },
    pro: { usd: 2000, eur: 2000, gbp: 1600, inr: 79900 },
    max: { usd: 3000, eur: 3000, gbp: 2400, inr: 139900 },
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
            Object.entries(base[tier]).map(([currency, amount]) => [
                currency,
                {
                    base: amount * times,
                    perMember: perMember[currency as keyof typeof perMember] * times,
                },
            ]),
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
            offers('month', 'gbp').map(({ name, storage, price, billed, size, extra }) => ({
                name,
                storage,
                price,
                billed,
                size,
                extra,
            })),
        ).toEqual([
            {
                name: 'Family Plus',
                storage: '800 GB',
                price: '£8 a month',
                billed: 'Billed monthly. £80 a year if you pay yearly.',
                size: 'For up to 4 members, sharing 800 GB.',
                extra: 'Then £1.20 a month for each member after that, up to 20.',
            },
            {
                name: 'Family Pro',
                storage: '2 TB',
                price: '£16 a month',
                billed: 'Billed monthly. £160 a year if you pay yearly.',
                size: 'For up to 4 members, sharing 2 TB.',
                extra: 'Then £1.20 a month for each member after that, up to 20.',
            },
            {
                name: 'Family Max',
                storage: '4 TB',
                price: '£24 a month',
                billed: 'Billed monthly. £240 a year if you pay yearly.',
                size: 'For up to 4 members, sharing 4 TB.',
                extra: 'Then £1.20 a month for each member after that, up to 20.',
            },
        ]);
        expect(offers('month', 'inr').map((offer) => offer.price)).toEqual([
            '₹399 a month',
            '₹799 a month',
            '₹1,399 a month',
        ]);
        expect(offers('month', 'inr')[0]?.extra).toBe(
            'Then ₹59 a month for each member after that, up to 20.',
        );
        expect(offers('month', 'eur').map((offer) => offer.price)).toEqual([
            '€10 a month',
            '€20 a month',
            '€30 a month',
        ]);
    });

    test('shows a yearly tier as its month, billed yearly, and its member price per year', () => {
        expect(offers('year', 'usd').map(({ price, billed }) => [price, billed])).toEqual([
            ['$8.33 a month', 'Billed $100 yearly.'],
            ['$16.67 a month', 'Billed $200 yearly.'],
            ['$25 a month', 'Billed $300 yearly.'],
        ]);
        expect(offers('year', 'usd')[1]?.extra).toBe(
            'Then $15 a year for each member after that, up to 20.',
        );
        expect(offers('year', 'usd')[1]?.plan.id).toBe('pro-year');
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
            'Every plan protects your files the same way. Paid plans add space; a family plan adds folders you share with up to 20 members.',
        );
    });
});
