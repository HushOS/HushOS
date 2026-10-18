import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import type { GroupSubscriptionSnapshot } from './billing';

// Pools are billing's: with BILLING_PROVIDER=none Drive ignores them (drive.pool-none.test.ts).
process.env.BILLING_PROVIDER = 'polar';

const { closeDatabase, createTestAccount, createTestFamily, resetDatabase } =
    await import('../test/helpers');
const billing = await import('./billing');
const { db } = await import('./client');
const { getStorage } = await import('./drive');
const { deletionBlockers, purgeDeletedAreas } = await import('./groups');
const { groupBillingCustomers, groups, workspaceStorage, workspaces } = await import('./schema');

/*
 * A family's plan as billing writes it, and the pool Drive reads from it: the
 * seats an admission is counted against, the bytes every area of the group
 * shares, and what is left once the plan ends or its grace runs out.
 */

const DAY = 24 * 60 * 60 * 1000;
const GRACE = 3 * DAY;
const GIB = 1_073_741_824n;

function plan(overrides: Partial<GroupSubscriptionSnapshot> = {}): GroupSubscriptionSnapshot {
    const units = overrides.units ?? 6;
    return {
        id: 'sub_family',
        productId: 'prod_family',
        productName: 'Family (monthly)',
        status: 'active',
        recurringInterval: 'month',
        amount: 1500,
        currency: 'usd',
        units,
        paidUnits: units,
        pendingUnits: null,
        pendingProductId: null,
        includedMembers: 6,
        quotaBytes: 100n,
        currentPeriodStart: new Date(Date.now() - DAY),
        currentPeriodEnd: new Date(Date.now() + 29 * DAY),
        cancelAtPeriodEnd: false,
        endedAt: null,
        ...overrides,
    };
}

async function apply(groupId: string, subscriptions: GroupSubscriptionSnapshot[]) {
    return billing.applyGroupState({
        groupId,
        provider: 'polar',
        customerId: 'cus_team',
        subscriptions,
        graceMs: GRACE,
    });
}

async function seatLimit(groupId: string) {
    const [row] = await db
        .select({ seatLimit: groups.seatLimit })
        .from(groups)
        .where(eq(groups.id, groupId));
    return row?.seatLimit;
}

async function setBytes(workspaceId: string, used: bigint, reserved: bigint) {
    await db
        .update(workspaceStorage)
        .set({ usedBytes: used, reservedBytes: reserved })
        .where(eq(workspaceStorage.workspaceId, workspaceId));
}

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('the pool', () => {
    test('a group without a pool keeps each area’s own allowance, as without billing', async () => {
        const { userId } = await createTestAccount();
        const { areaIds } = await createTestFamily({ organizerId: userId, areas: 2 });
        await setBytes(areaIds[0]!, 4n * GIB, 0n);
        expect(await getStorage(areaIds[1]!)).toMatchObject({
            allowance: 10n * GIB,
            used: 0n,
            free: 10n * GIB,
        });
    });

    test('a pooled group starts empty: nothing is stored free before a plan', async () => {
        const { userId } = await createTestAccount();
        const { areaIds } = await createTestFamily({ organizerId: userId, pooled: true });
        expect((await getStorage(areaIds[0]!))?.free).toBe(0n);
    });

    test('every area spends the same pool: one area’s bytes are another’s missing room', async () => {
        const { userId } = await createTestAccount();
        const { groupId, areaIds } = await createTestFamily({
            organizerId: userId,
            areas: 2,
            pooled: true,
        });
        await apply(groupId, [plan({ quotaBytes: 100n })]);
        await setBytes(areaIds[0]!, 60n, 0n);
        await setBytes(areaIds[1]!, 0n, 30n);
        for (const areaId of areaIds)
            expect(await getStorage(areaId)).toMatchObject({
                allowance: 100n,
                used: 60n,
                reserved: 30n,
                free: 10n,
            });
    });

    test('a deleted family folder draws from the pool until its purge deletes its files', async () => {
        const { userId } = await createTestAccount();
        const { groupId, areaIds } = await createTestFamily({
            organizerId: userId,
            areas: 2,
            pooled: true,
        });
        await apply(groupId, [plan({ quotaBytes: 100n })]);
        await setBytes(areaIds[0]!, 60n, 30n);
        // Deleted, not yet purged: its files are still stored, so deleting a full folder frees
        // no room to fill another.
        await db
            .update(workspaces)
            .set({ deletedAt: sql`now() - make_interval(days => 31)` })
            .where(eq(workspaces.id, areaIds[0]!));
        expect(await getStorage(areaIds[1]!)).toMatchObject({
            allowance: 100n,
            used: 60n,
            reserved: 30n,
            free: 10n,
        });
        // Purged: its bytes leave the pool with its files.
        expect(await purgeDeletedAreas(30)).toBe(1);
        expect(await getStorage(areaIds[1]!)).toMatchObject({ used: 0n, reserved: 0n, free: 100n });
    });

    test('an area’s own base allowance is not added to the pool', async () => {
        const { userId } = await createTestAccount();
        const { groupId, areaIds } = await createTestFamily({
            organizerId: userId,
            pooled: true,
            areaQuotaBytes: 10n * GIB,
        });
        await apply(groupId, [plan({ quotaBytes: 100n })]);
        expect((await getStorage(areaIds[0]!))?.allowance).toBe(100n);
    });

    test('a group whose first plan arrives gets a pool, even without one at creation', async () => {
        const { userId } = await createTestAccount();
        const { groupId, areaIds } = await createTestFamily({ organizerId: userId });
        await apply(groupId, [plan({ quotaBytes: 100n })]);
        expect((await getStorage(areaIds[0]!))?.allowance).toBe(100n);
    });

    test('past the period end and the grace days, the pool reads empty', async () => {
        const { userId } = await createTestAccount();
        const { groupId, areaIds } = await createTestFamily({ organizerId: userId, pooled: true });
        // Past due and never re-read: the period ended four days ago, one day past the grace.
        await apply(groupId, [
            plan({
                status: 'past_due',
                currentPeriodStart: new Date(Date.now() - 34 * DAY),
                currentPeriodEnd: new Date(Date.now() - 4 * DAY),
            }),
        ]);
        expect((await getStorage(areaIds[0]!))?.allowance).toBe(0n);
        // Within the grace days it still holds.
        await apply(groupId, [
            plan({
                status: 'past_due',
                currentPeriodStart: new Date(Date.now() - 32 * DAY),
                currentPeriodEnd: new Date(Date.now() - 2 * DAY),
            }),
        ]);
        expect((await getStorage(areaIds[0]!))?.allowance).toBe(100n);
    });

    test('a plan that ended empties the pool and frees no seats; nothing is deleted', async () => {
        const { userId } = await createTestAccount();
        const { groupId, areaIds } = await createTestFamily({ organizerId: userId, pooled: true });
        await apply(groupId, [plan({ units: 8 })]);
        await setBytes(areaIds[0]!, 60n, 0n);
        await apply(groupId, []);
        expect(await getStorage(areaIds[0]!)).toMatchObject({ allowance: 0n, used: 60n });
        expect(await seatLimit(groupId)).toBeNull();
        expect(await billing.getLiveGroupSubscription(groupId)).toBeNull();
    });
});

describe('tier moves', () => {
    test('a move to a smaller tier changes neither the pool nor the seats until Polar applies it', async () => {
        const { userId } = await createTestAccount();
        const { groupId, areaIds } = await createTestFamily({ organizerId: userId, pooled: true });
        await apply(groupId, [plan({ units: 7, quotaBytes: 4096n * GIB })]);
        await apply(groupId, [
            plan({ units: 7, quotaBytes: 4096n * GIB, pendingProductId: 'prod_plus' }),
        ]);
        expect(await seatLimit(groupId)).toBe(7);
        expect((await getStorage(areaIds[0]!))?.allowance).toBe(4096n * GIB);
        expect(await billing.getLiveGroupSubscription(groupId)).toMatchObject({
            pendingProductId: 'prod_plus',
            productId: 'prod_family',
        });
        // At the renewal the product and its pool change together; the places stay.
        await apply(groupId, [plan({ units: 7, productId: 'prod_plus', quotaBytes: 800n * GIB })]);
        expect(await seatLimit(groupId)).toBe(7);
        expect((await getStorage(areaIds[0]!))?.allowance).toBe(800n * GIB);
        expect((await billing.getLiveGroupSubscription(groupId))?.pendingProductId).toBeNull();
    });

    test('a recorded move outlives a rewrite from Polar, is listed for re-issue, and clears', async () => {
        const { userId } = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: userId, pooled: true });
        await apply(groupId, [plan({ units: 6 })]);
        expect(await billing.listIntendedCuts()).toEqual([]);
        await billing.setIntendedProduct('sub_family', 'prod_plus');
        // A raise deleted Polar's pending update: the read model loses it, the record does not.
        await apply(groupId, [plan({ units: 7, pendingProductId: null })]);
        expect(await billing.getLiveGroupSubscription(groupId)).toMatchObject({
            pendingProductId: null,
            intendedProductId: 'prod_plus',
        });
        expect(await billing.listIntendedCuts()).toEqual([
            { groupId, subscriptionId: 'sub_family' },
        ]);
        await billing.setIntendedProduct('sub_family', null);
        expect(await billing.listIntendedCuts()).toEqual([]);
        // An ended plan's record is never listed.
        await billing.setIntendedProduct('sub_family', 'prod_plus');
        await apply(groupId, [plan({ endedAt: new Date(), status: 'canceled' })]);
        expect(await billing.listIntendedCuts()).toEqual([]);
    });
});

describe('seats', () => {
    test('a scheduled cut blocks admissions at once, below what was bought', async () => {
        const { userId } = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: userId, pooled: true });
        await apply(groupId, [plan({ units: 8 })]);
        expect(await seatLimit(groupId)).toBe(8);
        await apply(groupId, [plan({ units: 8, pendingUnits: 6 })]);
        expect(await seatLimit(groupId)).toBe(6);
    });

    test('places Polar holds but nobody has paid for open nothing until they are paid', async () => {
        const { userId } = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: userId, pooled: true });
        await apply(groupId, [plan({ units: 6 })]);
        // A raise to seven waiting for the bank: Polar says seven, the paid count stays six.
        await apply(groupId, [plan({ units: 7, paidUnits: null })]);
        expect(await seatLimit(groupId)).toBe(6);
        expect((await billing.getLiveGroupSubscription(groupId))?.paidUnits).toBe(6);
        // Paid: the seventh place opens.
        await apply(groupId, [plan({ units: 7 })]);
        expect(await seatLimit(groupId)).toBe(7);
        // An unpaid renewal at a lower count never leaves more paid places than places.
        await apply(groupId, [plan({ units: 5, paidUnits: null })]);
        expect((await billing.getLiveGroupSubscription(groupId))?.paidUnits).toBe(5);
    });

    test('a subscription first seen with an order unpaid has paid for no place', async () => {
        const { userId } = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: userId, pooled: true });
        await apply(groupId, [plan({ units: 6, paidUnits: null })]);
        expect(await seatLimit(groupId)).toBe(1);
    });

    test('one changed subscription leaves the group’s other live plan alone', async () => {
        const { userId } = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: userId, pooled: true });
        await apply(groupId, [plan({ id: 'sub_a', units: 7 })]);
        await billing.applyGroupState({
            groupId,
            provider: 'polar',
            customerId: null,
            subscriptions: [
                plan({
                    id: 'sub_b',
                    units: 9,
                    currentPeriodEnd: new Date(Date.now() + 10 * DAY),
                }),
            ],
            graceMs: GRACE,
            complete: false,
        });
        expect(await billing.listLiveGroupSubscriptionIds(groupId)).toEqual(
            expect.arrayContaining(['sub_a', 'sub_b']),
        );
        // The plan running longest is the one the group's seats follow.
        expect((await billing.getLiveGroupSubscription(groupId))?.id).toBe('sub_a');
        expect(await seatLimit(groupId)).toBe(7);
    });
});

describe('payers', () => {
    test('the payer of a live family plan is listed; once it ends, they are not', async () => {
        const payer = await createTestAccount();
        const other = await createTestAccount();
        const { groupId } = await createTestFamily({
            organizerId: payer.userId,
            members: [{ userId: other.userId, roles: ['members'] }],
            pooled: true,
        });
        expect(
            await billing.recordGroupCustomer({
                groupId,
                provider: 'polar',
                providerCustomerId: 'cus_team',
                payerUserId: payer.userId,
            }),
        ).toMatchObject({ payerUserId: payer.userId });
        // A second record for the same group keeps the first payer.
        expect(
            await billing.recordGroupCustomer({
                groupId,
                provider: 'polar',
                providerCustomerId: 'cus_other',
                payerUserId: other.userId,
            }),
        ).toMatchObject({ payerUserId: payer.userId, providerCustomerId: 'cus_team' });
        expect(await billing.listGroupsPaidBy(payer.userId)).toEqual([]);
        await apply(groupId, [plan()]);
        expect(await billing.listGroupsPaidBy(payer.userId)).toEqual([groupId]);
        expect(await billing.listGroupsPaidBy(other.userId)).toEqual([]);
        await apply(groupId, []);
        expect(await billing.listGroupsPaidBy(payer.userId)).toEqual([]);
    });
});

describe('dissolving', () => {
    test('the last member of a family with a plan still paid for cannot delete their account; once cancelled they can', async () => {
        const { userId } = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: userId, pooled: true });
        expect(await deletionBlockers(userId)).toEqual([]);
        await apply(groupId, [plan()]);
        expect(await deletionBlockers(userId)).toEqual([{ groupId, reason: 'billed' }]);
        await apply(groupId, [plan({ cancelAtPeriodEnd: true })]);
        expect(await deletionBlockers(userId)).toEqual([]);
        // Cancelled, the family keeps its places and pool until the period ends.
        expect(await seatLimit(groupId)).toBe(6);
        expect(await billing.listGroupsPaidBy(userId)).toEqual([]);
    });
});

describe('the payer', () => {
    test('moves only from the payer the caller read, so two takeovers at once leave one payer', async () => {
        const organizer = await createTestAccount();
        const first = await createTestAccount();
        const second = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: organizer.userId });
        await billing.recordGroupCustomer({
            groupId,
            provider: 'polar',
            providerCustomerId: 'cus_payer',
            payerUserId: organizer.userId,
        });
        // Both read the organizer as payer; the first change wins, the second finds it moved.
        expect(await billing.setGroupPayer(groupId, organizer.userId, first.userId)).toBe(true);
        expect(await billing.setGroupPayer(groupId, organizer.userId, second.userId)).toBe(false);
        expect((await billing.getGroupCustomer(groupId))?.payerUserId).toBe(first.userId);
        // A payer whose account went (set null) is taken over from null, and only from null.
        await db
            .update(groupBillingCustomers)
            .set({ payerUserId: null })
            .where(eq(groupBillingCustomers.groupId, groupId));
        expect(await billing.setGroupPayer(groupId, first.userId, second.userId)).toBe(false);
        expect(await billing.setGroupPayer(groupId, null, second.userId)).toBe(true);
        expect((await billing.getGroupCustomer(groupId))?.payerUserId).toBe(second.userId);
    });
});
