import { afterAll, beforeEach, expect, test } from 'vitest';

/*
 * Switching back to BILLING_PROVIDER=none stops reading pools: a family folder
 * falls back to its own allowance, which is 0 for one made while billing was on.
 */
process.env.BILLING_PROVIDER = 'none';

const { closeDatabase, createTestAccount, createTestFamily, resetDatabase } =
    await import('../test/helpers');
const billing = await import('./billing');
const { getStorageAllowance } = await import('./auth');
const { getStorage } = await import('./drive');

beforeEach(resetDatabase);
afterAll(closeDatabase);

function familyPlan() {
    return {
        id: 'sub_family',
        productId: 'prod_family',
        productName: 'Family (monthly)',
        status: 'active',
        recurringInterval: 'month',
        amount: 1500,
        currency: 'usd',
        units: 6,
        paidUnits: 6,
        pendingUnits: null,
        pendingProductId: null,
        paidTier: { productId: 'prod_family', quotaBytes: 100n },
        includedMembers: 6,
        quotaBytes: 100n,
        currentPeriodStart: new Date(Date.now() - 1000),
        currentPeriodEnd: new Date(Date.now() + 86_400_000),
        cancelAtPeriodEnd: false,
        endedAt: null,
    };
}

test('without billing a family member’s own files keep their own allowance, whatever the family’s plan', async () => {
    const organizer = await createTestAccount({ quotaBytes: 2000n });
    const member = await createTestAccount({ quotaBytes: 3000n });
    const { groupId } = await createTestFamily({
        organizerId: organizer.userId,
        members: [{ userId: member.userId }],
        pooled: true,
    });
    await billing.applyGroupState({
        groupId,
        provider: 'polar',
        customerId: 'cus_team',
        subscriptions: [familyPlan()],
        graceMs: 0,
    });
    expect(await getStorage(member.workspaceId)).toEqual({
        allowance: 3000n,
        used: 0n,
        reserved: 0n,
        free: 3000n,
        pool: null,
    });
    expect(await getStorageAllowance(organizer.userId)).toMatchObject({
        quotaBytes: '2000',
        pool: null,
    });
});

test('without billing a pooled group’s folders read their own allowance, not the pool', async () => {
    const { userId } = await createTestAccount();
    const { groupId, areaIds } = await createTestFamily({
        organizerId: userId,
        areas: 2,
        pooled: true,
    });
    // Someone else's: an account is in one family at most.
    const { areaIds: older } = await createTestFamily({
        organizerId: (await createTestAccount()).userId,
    });
    await billing.applyGroupState({
        groupId,
        provider: 'polar',
        customerId: 'cus_team',
        subscriptions: [
            {
                id: 'sub_family',
                productId: 'prod_family',
                productName: 'Family (monthly)',
                status: 'active',
                recurringInterval: 'month',
                amount: 1500,
                currency: 'usd',
                units: 6,
                paidUnits: 6,
                pendingUnits: null,
                pendingProductId: null,
                paidTier: { productId: 'prod_family', quotaBytes: 100n },
                includedMembers: 6,
                quotaBytes: 100n,
                currentPeriodStart: new Date(Date.now() - 1000),
                currentPeriodEnd: new Date(Date.now() + 86_400_000),
                cancelAtPeriodEnd: false,
                endedAt: null,
            },
        ],
        graceMs: 0,
    });
    expect((await getStorage(areaIds[0]!))?.allowance).toBe(0n);
    // A folder made before billing keeps its own free allowance.
    expect((await getStorage(older[0]!))?.allowance).toBe(10n * 1_073_741_824n);
});
