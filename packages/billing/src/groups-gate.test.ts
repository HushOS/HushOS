import type * as PolarSdk from '@polar-sh/sdk/2026-10';
import { afterAll, beforeEach, expect, test, vi } from 'vitest';

/*
 * A family's plan is only served where families are: with GROUPS_ENABLED off,
 * GET /billing/groups/:id answers 404 before reading anything, billing on or not.
 */
process.env.APP_ORIGIN = 'http://localhost:5173';
process.env.BILLING_PROVIDER = 'polar';
process.env.POLAR_ENVIRONMENT = 'sandbox';
process.env.POLAR_ACCESS_TOKEN = 'polar_oat_test';
process.env.POLAR_WEBHOOK_SECRET = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;
process.env.GROUPS_ENABLED = 'false';

const calls: string[] = [];
vi.mock('@polar-sh/sdk/2026-10', async (importOriginal) => {
    const real = await importOriginal<typeof PolarSdk>();
    const record = (name: string) => () => {
        calls.push(name);
        throw new Error('Polar was asked');
    };
    return {
        ...real,
        createPolar: () => ({
            products: { iterList: record('products') },
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
    expect(calls).toEqual([]);
});
