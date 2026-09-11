import type { Plan } from '@hushos/billing/api';
import { describe, expect, test } from 'vitest';
import { tiersOf } from './plans';

function plan(overrides: Partial<Plan> & { id: string }): Plan {
    return {
        name: 'Pro (monthly)',
        description: null,
        interval: 'month',
        amount: 1000,
        currency: 'usd',
        quotaBytes: '536870912000',
        recommended: false,
        ...overrides,
    };
}

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
