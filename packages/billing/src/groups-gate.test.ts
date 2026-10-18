import type * as PolarSdk from '@polar-sh/sdk/2026-10';
import { afterAll, beforeEach, expect, test, vi } from 'vitest';

/*
 * A family's plan is only served where families are: with GROUPS_ENABLED off,
 * GET /billing/groups/:id answers 404 before reading anything, billing on or not,
 * and the public catalogue (the pricing page) lists no family plans.
 */
process.env.APP_ORIGIN = 'http://localhost:5173';
process.env.BILLING_PROVIDER = 'polar';
process.env.POLAR_ENVIRONMENT = 'sandbox';
process.env.POLAR_ACCESS_TOKEN = 'polar_oat_test';
process.env.POLAR_WEBHOOK_SECRET = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;
process.env.GROUPS_ENABLED = 'false';

const calls: string[] = [];
const fixed = (currency: string, amount: number) => ({
    amount_type: 'fixed',
    price_amount: amount,
    price_currency: currency,
    is_archived: false,
});
const products = [
    {
        id: '11111111-aaaa-4aaa-8aaa-111111111111',
        name: 'Plus (monthly)',
        description: null,
        is_archived: false,
        recurring_interval: 'month',
        metadata: { hushos_plan: 'plus', quota_bytes: String(200 * 1024 ** 3) },
        prices: [fixed('usd', 300)],
    },
    {
        id: '55555555-aaaa-4aaa-8aaa-555555555555',
        name: 'Family (monthly)',
        description: null,
        is_archived: false,
        recurring_interval: 'month',
        metadata: {
            hushos_plan: 'family',
            hushos_group_kind: 'family',
            quota_bytes: String(2 * 1024 ** 4),
            included_members: '6',
        },
        prices: [
            fixed('usd', 1500),
            {
                amount_type: 'unit_based',
                price_currency: 'usd',
                is_archived: false,
                tiers: {
                    type: 'graduated',
                    tiers: [
                        { bound: 6, unit_amount: '0' },
                        { bound: null, unit_amount: '200' },
                    ],
                },
                minimum_units: 6,
            },
        ],
    },
    {
        id: '66666666-aaaa-4aaa-8aaa-666666666666',
        name: 'Family Pro (monthly)',
        description: null,
        is_archived: false,
        recurring_interval: 'month',
        metadata: {
            hushos_plan: 'family',
            hushos_group_kind: 'family',
            hushos_tier: 'pro',
            quota_bytes: String(2 * 1024 ** 4),
            included_members: '4',
        },
        prices: [
            fixed('usd', 2000),
            {
                amount_type: 'unit_based',
                price_currency: 'usd',
                is_archived: false,
                tiers: {
                    type: 'graduated',
                    tiers: [
                        { bound: 4, unit_amount: '0' },
                        { bound: null, unit_amount: '150' },
                    ],
                },
                minimum_units: 4,
            },
        ],
    },
];
vi.mock('@polar-sh/sdk/2026-10', async (importOriginal) => {
    const real = await importOriginal<typeof PolarSdk>();
    const record = (name: string) => () => {
        calls.push(name);
        throw new Error('Polar was asked');
    };
    return {
        ...real,
        createPolar: () => ({
            products: {
                // One personal plan and one valid family plan, as production lists them.
                async *iterList() {
                    calls.push('products');
                    yield* products;
                },
            },
            customers: { getStateExternal: record('state') },
        }),
    };
});

const { closeDatabase, createTestAccount, createTestFamily, resetDatabase } =
    await import('../../db/test/helpers');
const billing = await import('./server');

beforeEach(resetDatabase);
afterAll(closeDatabase);

test('a family’s plan is not served with families off', async () => {
    const organizer = await createTestAccount();
    const { groupId } = await createTestFamily({ organizerId: organizer.userId });
    const user = { id: organizer.userId, name: 'Test', email: organizer.email };
    await expect(billing.getGroupBilling(user, groupId)).rejects.toMatchObject({ status: 404 });
    await expect(billing.syncGroup(user, groupId)).rejects.toMatchObject({ status: 404 });
    await expect(
        billing.changeGroupPlan(user, groupId, '66666666-aaaa-4aaa-8aaa-666666666666'),
    ).rejects.toMatchObject({ status: 404 });
    expect(calls).toEqual([]);
});

test('the public catalogue lists no family plans with families off', async () => {
    // The family products read as such (readFamilyProduct), so only the gate keeps them out.
    expect(billing.readFamilyProduct(products[1] as never)).not.toBeNull();
    expect(billing.readFamilyProduct(products[2] as never)).toMatchObject({ tier: 'pro' });
    const catalogue = await billing.listCatalogue();
    expect(catalogue.enabled).toBe(true);
    expect(catalogue.plans.map((plan) => plan.name)).toEqual(['Plus (monthly)']);
    expect(catalogue.families).toEqual([]);
});
