import type { FamilyPlan, Plan } from '@hushos/billing/api';
import { describe, expect, test } from 'vitest';
import { currenciesOf, familyOffer, priceOf, pricingLede, tiersOf } from './plans';

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

/* Production's Family plans: yearly is ten times monthly, 2 TB for 6, up to 20. */
function family(interval: 'month' | 'year'): FamilyPlan {
    const times = interval === 'year' ? 10 : 1;
    return {
        id: `family-${interval}`,
        name: interval === 'year' ? 'Family (yearly)' : 'Family (monthly)',
        description: null,
        interval,
        prices: {
            usd: { base: 1500 * times, perMember: 200 * times },
            eur: { base: 1500 * times, perMember: 200 * times },
            gbp: { base: 1200 * times, perMember: 200 * times },
            inr: { base: 59900 * times, perMember: 7900 * times },
        },
        includedMembers: 6,
        maxMembers: 20,
        quotaBytes: String(2 * 1024 ** 4),
    };
}
const families = [family('month'), family('year')];

describe('familyOffer', () => {
    test('offers nothing where the server lists no family plan (families off)', () => {
        expect(familyOffer({ enabled: true, families: [] }, 'month', 'usd')).toBeNull();
        expect(familyOffer({ enabled: true, families: [] }, 'year', 'usd')).toBeNull();
    });

    test('offers nothing with billing off, whatever plans came with it', () => {
        expect(familyOffer({ enabled: false, families }, 'month', 'usd')).toBeNull();
    });

    test('prices the monthly plan in the visitor’s currency', () => {
        expect(familyOffer({ enabled: true, families }, 'month', 'gbp')).toMatchObject({
            plan: { id: 'family-month' },
            price: '£12 a month',
            billed: 'Billed monthly. £120 a year if you pay yearly.',
            size: 'For up to 6 people, sharing 2 TB.',
            extra: 'Then £2 a month for each person after that, up to 20.',
        });
        const inr = familyOffer({ enabled: true, families }, 'month', 'inr');
        expect(inr?.price).toBe('₹599 a month');
        expect(inr?.extra).toBe('Then ₹79 a month for each person after that, up to 20.');
    });

    test('shows the yearly plan as a month, billed yearly, and its member price per year', () => {
        expect(familyOffer({ enabled: true, families }, 'year', 'usd')).toMatchObject({
            plan: { id: 'family-year' },
            price: '$12.50 a month',
            billed: 'Billed $150 yearly.',
            extra: 'Then $20 a year for each person after that, up to 20.',
        });
    });

    test('falls back to the default currency, never a price in a currency it lacks', () => {
        const offer = familyOffer({ enabled: true, families }, 'month', 'jpy');
        expect(offer?.price).toBe('$15 a month');
        expect(offer?.billed).toBe('Billed monthly. $150 a year if you pay yearly.');
    });

    test('offers the other interval when only one is on sale', () => {
        const offer = familyOffer({ enabled: true, families: [family('month')] }, 'year', 'usd');
        expect(offer?.plan.id).toBe('family-month');
        expect(offer?.billed).toBe('Billed monthly.');
    });
});

describe('pricingLede', () => {
    test('keeps "nothing else" only while no family plan is shown', () => {
        const off =
            'Every plan protects your files the same way. Paid plans add space, and nothing else.';
        expect(pricingLede(familyOffer({ enabled: true, families: [] }, 'month', 'usd'))).toBe(off);
        expect(pricingLede(familyOffer({ enabled: false, families }, 'month', 'usd'))).toBe(off);
        expect(pricingLede(familyOffer({ enabled: true, families }, 'month', 'usd'))).toBe(
            'Every plan protects your files the same way. Paid plans add space; a family plan adds folders you share with up to 20 people.',
        );
    });
});
