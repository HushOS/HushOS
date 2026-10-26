import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import type { GroupSubscriptionSnapshot, ReadingStamp } from './billing';

// Pools are billing's: with BILLING_PROVIDER=none Drive ignores them (drive.pool-none.test.ts).
process.env.BILLING_PROVIDER = 'polar';

const { closeDatabase, createTestAccount, createTestFamily, resetDatabase } =
    await import('../test/helpers');
const billing = await import('./billing');
const { db } = await import('./client');
const { getStorage } = await import('./drive');
const { deletionBlockers, purgeDeletedAreas } = await import('./groups');
const { groupBillingCustomers, groupBillingSubscriptions, groups, workspaceStorage, workspaces } =
    await import('./schema');

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
        // Paid for, unless a test says otherwise: the product's own tier.
        paidTier: {
            productId: overrides.productId ?? 'prod_family',
            quotaBytes: overrides.quotaBytes ?? 100n,
        },
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
        readingFrom: await billing.readingStamp(),
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
        await apply(groupId, [plan({ quotaBytes: 10n * GIB })]);
        await setBytes(areaIds[0]!, 6n * GIB, 0n);
        await setBytes(areaIds[1]!, 0n, 3n * GIB);
        // The folders are one part of the pool, counted together in whole GiB.
        for (const areaId of areaIds)
            expect(await getStorage(areaId)).toMatchObject({
                allowance: 10n * GIB,
                used: 6n * GIB,
                reserved: 3n * GIB,
                free: GIB,
            });
    });

    test('a deleted family folder draws from the pool until its purge deletes its files', async () => {
        const { userId } = await createTestAccount();
        const { groupId, areaIds } = await createTestFamily({
            organizerId: userId,
            areas: 2,
            pooled: true,
        });
        await apply(groupId, [plan({ quotaBytes: 10n * GIB })]);
        await setBytes(areaIds[0]!, 6n * GIB, 3n * GIB);
        // Deleted, not yet purged: its files are still stored, so deleting a full folder frees
        // no room to fill another.
        await db
            .update(workspaces)
            .set({ deletedAt: sql`now() - make_interval(days => 31)` })
            .where(eq(workspaces.id, areaIds[0]!));
        expect(await getStorage(areaIds[1]!)).toMatchObject({
            allowance: 10n * GIB,
            used: 6n * GIB,
            reserved: 3n * GIB,
            free: GIB,
        });
        // Purged: its bytes leave the pool with its files.
        expect(await purgeDeletedAreas(30)).toBe(1);
        expect(await getStorage(areaIds[1]!)).toMatchObject({
            used: 0n,
            reserved: 0n,
            free: 10n * GIB,
        });
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

describe('what a full reconcile ends', () => {
    test.each(['unpaid', 'incomplete', 'paused'])(
        'a plan Polar answers as %s stays unended with its status, and gives no pool or places at once',
        async (status) => {
            const { userId } = await createTestAccount();
            const { groupId, areaIds } = await createTestFamily({
                organizerId: userId,
                pooled: true,
            });
            await apply(groupId, [plan({ units: 8 })]);
            expect((await getStorage(areaIds[0]!))?.allowance).toBe(100n);
            // Mid-period: the grace days are for a period that ran out, not for a lapsed payment.
            await apply(groupId, [plan({ units: 8, status })]);
            expect(await billing.getGroupSubscription('sub_family')).toMatchObject({
                status,
                endedAt: null,
            });
            // Still read again by the next reconcile, and still able to charge.
            expect(await billing.listUnendedGroupSubscriptionIds(groupId)).toEqual(['sub_family']);
            expect((await getStorage(areaIds[0]!))?.allowance).toBe(0n);
            expect(await seatLimit(groupId)).toBeNull();
            expect(await billing.getLiveGroupSubscription(groupId)).toBeNull();
            // Paid after all: back to active, and the pool with it.
            await apply(groupId, [plan({ units: 8 })]);
            expect((await getStorage(areaIds[0]!))?.allowance).toBe(100n);
            expect(await seatLimit(groupId)).toBe(8);
        },
    );

    test('a scheduled change given up on is listed for operators only while the plan is live', async () => {
        const { userId } = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: userId, pooled: true });
        await apply(groupId, [plan()]);
        await billing.setReissueGaveUp('sub_family', new Date(), 'not-kept');
        const listed = async () =>
            (await billing.listGivenUpReissues()).map((row) => [row.subscriptionId, row.reason]);
        expect(await listed()).toEqual([['sub_family', 'not-kept']]);
        // Unpaid, it changes nothing a payer gets; kept unended, it must not linger on the list.
        await apply(groupId, [plan({ status: 'unpaid' })]);
        expect(await listed()).toEqual([]);
        // Paid after all: the change is wanted again, and listed again.
        await apply(groupId, [plan()]);
        expect(await listed()).toEqual([['sub_family', 'not-kept']]);
    });

    test('one Polar no longer lists is ended, whatever it was last seen as', async () => {
        const { userId } = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: userId, pooled: true });
        await apply(groupId, [plan({ status: 'unpaid' })]);
        await apply(groupId, []);
        expect(await billing.getGroupSubscription('sub_family')).toMatchObject({
            status: 'unpaid',
            endedAt: expect.any(Date),
        });
        expect(await billing.listUnendedGroupSubscriptionIds(groupId)).toEqual([]);
    });

    test('one Polar answers as canceled or expired, without saying when it ended, is ended', async () => {
        const { userId } = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: userId, pooled: true });
        await apply(groupId, [
            plan({ id: 'sub_a', status: 'canceled' }),
            plan({ id: 'sub_b', status: 'incomplete_expired' }),
        ]);
        for (const id of ['sub_a', 'sub_b'])
            expect((await billing.getGroupSubscription(id))?.endedAt).toBeInstanceOf(Date);
        expect(await billing.listUnendedGroupSubscriptionIds(groupId)).toEqual([]);
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

    test('the pool is the lesser of the tier paid for and the product’s', async () => {
        const { userId } = await createTestAccount();
        const { groupId, areaIds } = await createTestFamily({ organizerId: userId, pooled: true });
        const allowance = async () => (await getStorage(areaIds[0]!))?.allowance;
        const pro = { productId: 'prod_pro', quotaBytes: 2048n * GIB };
        await apply(groupId, [plan({ units: 5, ...pro })]);
        expect(await allowance()).toBe(2048n * GIB);
        // On Family Max, Family Pro paid for (the upgrade's order waits): Family Pro's pool.
        await apply(groupId, [
            plan({ units: 5, productId: 'prod_max', quotaBytes: 4096n * GIB, paidTier: pro }),
        ]);
        expect(await allowance()).toBe(2048n * GIB);
        expect(await billing.getLiveGroupSubscription(groupId)).toMatchObject({
            productId: 'prod_max',
            paidProductId: 'prod_pro',
            paidQuotaBytes: 2048n * GIB,
        });
        // On Family Plus from a renewal not yet paid, Family Pro still the last paid: Plus's pool.
        await apply(groupId, [
            plan({ units: 5, productId: 'prod_plus', quotaBytes: 800n * GIB, paidTier: pro }),
        ]);
        expect(await allowance()).toBe(800n * GIB);
        // Nothing paid at all: nothing.
        await apply(groupId, [
            plan({ units: 5, productId: 'prod_max', quotaBytes: 4096n * GIB, paidTier: null }),
        ]);
        expect(await allowance()).toBe(0n);
        expect((await billing.getLiveGroupSubscription(groupId))?.paidProductId).toBeNull();
    });

    test('a plan first seen with nothing paid has no pool and no places', async () => {
        const { userId } = await createTestAccount();
        const { groupId, areaIds } = await createTestFamily({ organizerId: userId, pooled: true });
        await apply(groupId, [
            plan({ units: 4, paidUnits: null, quotaBytes: 2048n * GIB, paidTier: null }),
        ]);
        expect((await getStorage(areaIds[0]!))?.allowance).toBe(0n);
        expect(await seatLimit(groupId)).toBe(1);
        await apply(groupId, [plan({ units: 4, quotaBytes: 2048n * GIB })]);
        expect((await getStorage(areaIds[0]!))?.allowance).toBe(2048n * GIB);
        expect(await seatLimit(groupId)).toBe(4);
    });

    test('orders that couldn’t be read leave the tier paid for as it was', async () => {
        const { userId } = await createTestAccount();
        const { groupId, areaIds } = await createTestFamily({ organizerId: userId, pooled: true });
        const since = new Date('2026-10-10T00:00:00Z');
        await apply(groupId, [
            plan({
                productId: 'prod_max',
                quotaBytes: 4096n * GIB,
                paidTier: { productId: 'prod_pro', quotaBytes: 2048n * GIB },
                tierMismatchSince: since,
            }),
        ]);
        await apply(groupId, [
            plan({
                productId: 'prod_max',
                quotaBytes: 4096n * GIB,
                paidTier: undefined,
                tierMismatchSince: undefined,
            }),
        ]);
        expect((await getStorage(areaIds[0]!))?.allowance).toBe(2048n * GIB);
        expect(await billing.getLiveGroupSubscription(groupId)).toMatchObject({
            paidProductId: 'prod_pro',
            tierMismatchSince: since,
        });
        // Paid: the difference is gone, and with it the date.
        await apply(groupId, [
            plan({ productId: 'prod_max', quotaBytes: 4096n * GIB, tierMismatchSince: null }),
        ]);
        expect(await billing.getLiveGroupSubscription(groupId)).toMatchObject({
            paidProductId: 'prod_max',
            tierMismatchSince: null,
        });
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
            readingFrom: await billing.readingStamp(),
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
        expect(await billing.listUnendedGroupSubscriptionIds(groupId)).toEqual(
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

describe('lapsed family plans and double charges', () => {
    const personal = (id: string, status: string, endedAt: Date | null = null) => ({
        id,
        productId: 'prod_pro',
        productName: 'Pro (monthly)',
        status,
        recurringInterval: 'month',
        amount: 1000,
        currency: 'usd',
        quotaBytes: 500n * GIB,
        currentPeriodEnd: new Date(Date.now() + 29 * DAY),
        cancelAtPeriodEnd: false,
        endedAt,
    });

    test('a checkout finds every unpaid, incomplete or paused plan of the family, never a live or ended one', async () => {
        const { userId } = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: userId, pooled: true });
        await apply(groupId, [
            plan({ id: 'sub_unpaid', status: 'unpaid' }),
            plan({ id: 'sub_incomplete', status: 'incomplete' }),
            plan({ id: 'sub_paused', status: 'paused' }),
            plan({ id: 'sub_due', status: 'past_due' }),
            plan({ id: 'sub_gone', status: 'unpaid', endedAt: new Date() }),
        ]);
        expect((await billing.listLapsedGroupSubscriptionIds(groupId)).sort()).toEqual([
            'sub_incomplete',
            'sub_paused',
            'sub_unpaid',
        ]);
        // The page names the newest of them while nothing is live.
        await apply(groupId, [
            plan({ id: 'sub_old', status: 'unpaid', currentPeriodEnd: new Date(Date.now() + DAY) }),
            plan({ id: 'sub_new', status: 'paused' }),
        ]);
        expect(await billing.getLapsedGroupSubscription(groupId)).toMatchObject({
            id: 'sub_new',
            status: 'paused',
        });
        await apply(groupId, [plan({ id: 'sub_new', status: 'canceled' })]);
        expect(await billing.getLapsedGroupSubscription(groupId)).toBeNull();
    });

    test('a family’s plan and its ending’s owner are told from a person’s by one rule, a purged family’s too', async () => {
        const { userId } = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: userId, pooled: true });
        await apply(groupId, [plan()]);
        expect(await billing.familyPlanOf('sub_family')).toEqual({ groupId });
        expect(await billing.familyPlanOf('sub_personal')).toBeNull();
        expect(await billing.isFamilyOwner(groupId)).toBe(true);
        expect(await billing.isFamilyOwner(userId)).toBe(false);
        // Operators' lists name the family behind a family's own ending.
        await billing.beginLapsedRevoke({
            subscriptionId: 'sub_family',
            userId: groupId,
            at: new Date(),
            owner: 'run',
            leaseMs: 60_000,
        });
        await billing.setPlanUnrefundable('sub_family', 300, 'usd');
        expect(await billing.listUnrefundable()).toEqual([
            expect.objectContaining({ subscriptionId: 'sub_family', planOfGroupId: groupId }),
        ]);
        // Billing rows outlive the family's own (no foreign key): still a family's.
        const purged = randomUUID();
        await db.insert(groupBillingSubscriptions).values({
            id: 'sub_purged',
            groupId: purged,
            provider: 'polar',
            productId: 'prod_family',
            productName: 'Family (monthly)',
            status: 'canceled',
            recurringInterval: 'month',
            units: 6,
            includedMembers: 6,
            quotaBytes: 100n,
            currentPeriodStart: new Date(Date.now() - DAY),
            currentPeriodEnd: new Date(Date.now() + DAY),
            endedAt: new Date(),
        });
        expect(await billing.familyPlanOf('sub_purged')).toEqual({ groupId: purged });
        expect(await billing.isFamilyOwner(purged)).toBe(true);
    });

    test('a family or a person with two plans that can still charge is listed for operators; one, or an ended second, is not', async () => {
        const { userId } = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: userId, pooled: true });
        const listed = async () => billing.listDoubleCharging();
        await apply(groupId, [plan({ id: 'sub_a' })]);
        await billing.applyCustomerState({
            readingFrom: await billing.readingStamp(),
            userId,
            provider: 'polar',
            customerId: 'cus_person',
            subscriptions: [personal('sub_p1', 'active')],
            graceMs: GRACE,
        });
        expect(await listed()).toEqual([]);
        // An unpaid plan Polar still holds beside a live one: it can charge again.
        await apply(groupId, [plan({ id: 'sub_a' }), plan({ id: 'sub_b', status: 'unpaid' })]);
        await billing.applyCustomerState({
            readingFrom: await billing.readingStamp(),
            userId,
            provider: 'polar',
            customerId: 'cus_person',
            subscriptions: [personal('sub_p1', 'active'), personal('sub_p2', 'paused')],
            graceMs: GRACE,
        });
        expect(await listed()).toEqual([
            {
                kind: 'family',
                id: groupId,
                subscriptions: [
                    { id: 'sub_a', status: 'active' },
                    { id: 'sub_b', status: 'unpaid' },
                ],
            },
            {
                kind: 'person',
                id: userId,
                subscriptions: [
                    { id: 'sub_p1', status: 'active' },
                    { id: 'sub_p2', status: 'paused' },
                ],
            },
        ]);
        // The live one set to end at its period's end charges no more: off the list.
        await apply(groupId, [
            plan({ id: 'sub_a', cancelAtPeriodEnd: true }),
            plan({ id: 'sub_b', status: 'unpaid' }),
        ]);
        expect((await listed()).map((row) => row.kind)).toEqual(['person']);
        // Revoked, or ended at Polar: no longer able to charge, so off the list.
        await apply(groupId, [
            plan({ id: 'sub_a' }),
            plan({ id: 'sub_b', status: 'canceled', endedAt: new Date() }),
        ]);
        await billing.applyCustomerState({
            readingFrom: await billing.readingStamp(),
            userId,
            provider: 'polar',
            customerId: 'cus_person',
            subscriptions: [personal('sub_p1', 'active'), personal('sub_p2', 'incomplete_expired')],
            graceMs: GRACE,
        });
        expect(await listed()).toEqual([]);
    });
});

test('the readability migration marks unread the rows an earlier build named after their product id, and nothing else', async () => {
    const { readFileSync } = await import('node:fs');
    const migration = readFileSync(
        new URL(
            '../drizzle/20261026094157_family_lapsed_revoke_refusal/migration.sql',
            import.meta.url,
        ),
        'utf8',
    );
    const backfill = migration
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter((statement) => statement.startsWith('UPDATE'));
    expect(backfill).toHaveLength(1);
    const row = (id: string, productId: string, productName: string) => ({
        id,
        groupId: randomUUID(),
        provider: 'polar',
        productId,
        productName,
        status: 'paused',
        recurringInterval: 'month',
        units: 1,
        includedMembers: 1,
        quotaBytes: 0n,
        currentPeriodStart: new Date(Date.now() - DAY),
        currentPeriodEnd: new Date(Date.now() + DAY),
    });
    await db
        .insert(groupBillingSubscriptions)
        .values([
            row('sub_sentinel', 'prod_archived', 'prod_archived'),
            row('sub_read', 'prod_family', 'Family (monthly)'),
        ]);
    await db.execute(sql.raw(backfill[0]!));
    const unread = async (id: string) =>
        (
            await db
                .select({ unread: groupBillingSubscriptions.productUnread })
                .from(groupBillingSubscriptions)
                .where(eq(groupBillingSubscriptions.id, id))
        )[0]?.unread;
    expect(await unread('sub_sentinel')).toBe(true);
    expect(await unread('sub_read')).toBe(false);
});

describe('a deleted family’s plans', () => {
    const orphan = (
        overrides: Partial<Parameters<typeof billing.recordOrphanedSubscription>[1]> = {},
    ) => ({
        id: 'sub_orphan',
        productId: 'prod_family',
        productName: 'Family (monthly)',
        status: 'active',
        recurringInterval: 'month',
        amount: 1500,
        currency: 'usd',
        units: 6,
        includedMembers: 6,
        quotaBytes: 100n,
        currentPeriodStart: new Date(Date.now() - DAY),
        currentPeriodEnd: new Date(Date.now() + 29 * DAY),
        cancelAtPeriodEnd: false,
        endedAt: null,
        ...overrides,
    });

    test('a plan’s first recorded end is kept however often Polar brings it back', async () => {
        const gone = randomUUID();
        const ended = new Date(Date.now() - 2 * DAY);
        await billing.recordOrphanedSubscription(
            gone,
            orphan({ status: 'canceled', endedAt: ended }),
        );
        expect((await billing.getGroupSubscription('sub_orphan'))?.endedAt).toEqual(ended);
        // Reinstated: Polar answers it live, with no end; the end HushOS recorded stays.
        await billing.recordOrphanedSubscription(gone, orphan());
        expect(await billing.getGroupSubscription('sub_orphan')).toMatchObject({
            status: 'active',
            endedAt: ended,
        });
        // Another family's id on the same subscription (a stray answer) never moves the row.
        await billing.recordOrphanedSubscription(randomUUID(), orphan({ status: 'unpaid' }));
        expect(await billing.getGroupSubscription('sub_orphan')).toMatchObject({
            groupId: gone,
            status: 'active',
        });
        // Gone at Polar: an end it never had is now.
        await billing.recordOrphanedSubscription(gone, orphan({ id: 'sub_other' }));
        await billing.recordOrphanedSubscription(gone, { id: 'sub_other', ended: true });
        expect(await billing.getGroupSubscription('sub_other')).toMatchObject({
            status: 'canceled',
            endedAt: expect.any(Date),
        });
    });

    test('operators see a deleted family’s plan while it can still charge, never a living family’s, nor an old swept row', async () => {
        const { userId } = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: userId, pooled: true });
        await apply(groupId, [plan({ id: 'sub_living' })]);
        const gone = randomUUID();
        await billing.recordOrphanedSubscription(
            gone,
            orphan({ status: 'canceled', endedAt: new Date() }),
        );
        await billing.recordOrphanedSubscription(
            gone,
            orphan({ id: 'sub_swept', status: 'unpaid', endedAt: new Date() }),
        );
        expect(await billing.listOrphanedPlans()).toEqual([]);
        // Billing again, and HushOS has set out to end it (its ending, keyed by the family).
        await billing.recordOrphanedSubscription(gone, orphan());
        await billing.beginLapsedRevoke({
            subscriptionId: 'sub_orphan',
            userId: gone,
            at: new Date(),
            owner: 'run',
            leaseMs: 60_000,
        });
        expect(await billing.listOrphanedPlans()).toEqual([
            expect.objectContaining({
                groupId: gone,
                subscriptionId: 'sub_orphan',
                revokedAt: null,
            }),
        ]);
        // A plan of a family that still exists is never listed, whatever it does.
        await billing.beginLapsedRevoke({
            subscriptionId: 'sub_living',
            userId: groupId,
            at: new Date(),
            owner: 'run',
            leaseMs: 60_000,
        });
        expect((await billing.listOrphanedPlans()).map((row) => row.subscriptionId)).toEqual([
            'sub_orphan',
        ]);
    });
});

describe('readings of Polar that overlap', () => {
    async function family() {
        const { userId } = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: userId, pooled: true });
        return groupId;
    }
    /* One plan as a change returned it, answered at `readingFrom`. */
    const change = (
        groupId: string,
        subscription: GroupSubscriptionSnapshot,
        readingFrom: ReadingStamp,
    ) =>
        billing
            .applyGroupState({
                groupId,
                provider: 'polar',
                customerId: null,
                subscriptions: [subscription],
                graceMs: GRACE,
                complete: false,
                readingFrom,
            })
            .then((result) => result.outcome);
    const reconcile = (
        groupId: string,
        subscriptions: GroupSubscriptionSnapshot[],
        readingFrom: ReadingStamp,
    ) =>
        billing
            .applyGroupState({
                groupId,
                provider: 'polar',
                customerId: 'cus_team',
                subscriptions,
                graceMs: GRACE,
                readingFrom,
            })
            .then((result) => result.outcome);

    test('a change answered before the newest reconcile began writes nothing; one answered after it does', async () => {
        const groupId = await family();
        const answered = await billing.readingStamp();
        expect(await reconcile(groupId, [plan()], await billing.readingStamp())).toBe('applied');
        expect(await change(groupId, plan({ units: 9 }), answered)).toBe('stale');
        expect(await seatLimit(groupId)).toBe(6);
        expect(await change(groupId, plan({ units: 9 }), await billing.readingStamp())).toBe(
            'applied',
        );
        expect(await seatLimit(groupId)).toBe(9);
    });

    test('a reconcile that began before the newest change is answered again (rerun); one that began after it is written', async () => {
        const groupId = await family();
        expect(await reconcile(groupId, [plan()], await billing.readingStamp())).toBe('applied');
        const began = await billing.readingStamp();
        expect(await change(groupId, plan({ units: 9 }), await billing.readingStamp())).toBe(
            'applied',
        );
        expect(await reconcile(groupId, [plan()], began)).toBe('rerun');
        expect(await seatLimit(groupId)).toBe(9);
        expect(await reconcile(groupId, [plan({ units: 9 })], await billing.readingStamp())).toBe(
            'applied',
        );
        // And a reconcile behind that one writes nothing.
        expect(await reconcile(groupId, [plan({ units: 4 })], began)).toBe('stale');
        expect(await seatLimit(groupId)).toBe(9);
    });

    test('two answers for one plan: the older, committing last, writes nothing', async () => {
        const groupId = await family();
        expect(await reconcile(groupId, [plan()], await billing.readingStamp())).toBe('applied');
        const older = await billing.readingStamp();
        expect(await change(groupId, plan({ units: 9 }), await billing.readingStamp())).toBe(
            'applied',
        );
        expect(await change(groupId, plan({ units: 7 }), older)).toBe('stale');
        expect(await seatLimit(groupId)).toBe(9);
    });

    test('readings drawn at once, on several connections, are each numbered once, in the order drawn', async () => {
        const drawn = await Promise.all(Array.from({ length: 20 }, () => billing.readingStamp()));
        const numbers = drawn.map((stamp) => BigInt(stamp));
        expect(new Set(numbers).size).toBe(20);
        // Each later draw on one connection is numbered after the earlier ones, however close.
        const first = await billing.readingStamp();
        const second = await billing.readingStamp();
        expect(BigInt(second)).toBeGreaterThan(BigInt(first));
        for (const number of numbers) expect(BigInt(first)).toBeGreaterThan(number);
        // So whichever commits last, the newest reading is kept.
        const groupId = await family();
        expect(await reconcile(groupId, [plan({ units: 9 })], second)).toBe('applied');
        expect(await reconcile(groupId, [plan()], first)).toBe('stale');
        expect(await seatLimit(groupId)).toBe(9);
    });

    test('a change never gives way to another change, which may be of another plan', async () => {
        const groupId = await family();
        expect(await reconcile(groupId, [plan()], await billing.readingStamp())).toBe('applied');
        const older = await billing.readingStamp();
        expect(await change(groupId, plan({ units: 9 }), await billing.readingStamp())).toBe(
            'applied',
        );
        expect(await change(groupId, plan({ id: 'sub_other', status: 'unpaid' }), older)).toBe(
            'applied',
        );
        expect((await billing.getGroupSubscription('sub_other'))?.status).toBe('unpaid');
        expect(await seatLimit(groupId)).toBe(9);
    });

    test('a first reconcile’s customer row holds its reading', async () => {
        const groupId = await family();
        const older = await billing.readingStamp();
        expect(await reconcile(groupId, [plan()], await billing.readingStamp())).toBe('applied');
        expect(await reconcile(groupId, [plan({ status: 'unpaid' })], older)).toBe('stale');
        expect(await seatLimit(groupId)).toBe(6);
    });

    test('an unread plan read before the newest reconcile began is not written', async () => {
        const groupId = await family();
        const answered = await billing.readingStamp();
        expect(await reconcile(groupId, [plan()], await billing.readingStamp())).toBe('applied');
        const unread = {
            id: 'sub_unread_late',
            productId: 'prod_archived',
            status: 'active',
            recurringInterval: 'month',
            amount: 1500,
            currency: 'usd',
            units: 6,
            currentPeriodStart: new Date(Date.now() - DAY),
            currentPeriodEnd: new Date(Date.now() + 29 * DAY),
            cancelAtPeriodEnd: false,
            endedAt: null,
        };
        expect(await billing.recordUnreadGroupSubscription(groupId, unread, answered)).toBe(
            'stale',
        );
        expect(await billing.getGroupSubscription(unread.id)).toBeNull();
        expect(
            await billing.recordUnreadGroupSubscription(
                groupId,
                unread,
                await billing.readingStamp(),
            ),
        ).toBe('applied');
        expect(await billing.getGroupSubscription(unread.id)).toMatchObject({
            productUnread: true,
        });
    });
});

test('the one-plan migration gives each family’s current plan served_since: a plan reinstated beside it before the first reconcile is not kept', async () => {
    const { readFileSync } = await import('node:fs');
    const migration = readFileSync(
        new URL('../drizzle/20261026164003_family_one_checkout/migration.sql', import.meta.url),
        'utf8',
    );
    const backfill = migration
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter((statement) => statement.startsWith('UPDATE'));
    expect(backfill).toHaveLength(1);
    const { userId } = await createTestAccount();
    const { groupId } = await createTestFamily({ organizerId: userId, pooled: true });
    const current = plan({ id: 'sub_current' });
    expect(await apply(groupId, [current])).toMatchObject({ outcome: 'applied' });
    // Written by the release before this one: no plan has served_since yet.
    await db
        .update(groupBillingSubscriptions)
        .set({ servedSince: null })
        .where(eq(groupBillingSubscriptions.groupId, groupId));
    await db.execute(sql.raw(backfill[0]!));
    // Polar reinstates an older plan beside it before any reconcile on this release runs.
    const reinstated = plan({ id: 'sub_reinstated_old' });
    const result = await billing.applyGroupState({
        readingFrom: await billing.readingStamp(),
        groupId,
        provider: 'polar',
        customerId: 'cus_team',
        subscriptions: [current, reinstated],
        graceMs: GRACE,
        cure: [
            { id: current.id, createdAt: Date.now() - 30 * DAY },
            { id: reinstated.id, createdAt: Date.now() - 365 * DAY },
        ],
    });
    expect(result).toMatchObject({
        outcome: 'applied',
        kept: current.id,
        superseded: [expect.objectContaining({ id: reinstated.id })],
    });
});
