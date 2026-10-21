import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, createTestAccount, resetDatabase } from '../test/helpers';
import { getStorageAllowance } from './auth';
import * as billing from './billing';
import { db } from './client';
import { accountIntents, billingSubscriptions, storageEntitlements } from './schema';

const DAY = 24 * 60 * 60 * 1000;
const GRACE = 3 * DAY;
const GIB = 1_073_741_824n;

function subscription(overrides: Partial<billing.SubscriptionSnapshot> = {}) {
    return {
        id: 'sub_1',
        productId: 'prod_pro',
        productName: 'Pro (monthly)',
        status: 'active',
        recurringInterval: 'month',
        amount: 1000,
        currency: 'usd',
        quotaBytes: 500n * GIB,
        currentPeriodEnd: new Date(Date.now() + 30 * DAY),
        cancelAtPeriodEnd: false,
        endedAt: null,
        ...overrides,
    } satisfies billing.SubscriptionSnapshot;
}

async function entitlements(workspaceId: string) {
    return db
        .select()
        .from(storageEntitlements)
        .where(eq(storageEntitlements.workspaceId, workspaceId));
}

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('applyCustomerState', () => {
    test('an active subscription grants its quota until period end plus grace', async () => {
        const { userId, workspaceId } = await createTestAccount();
        const sub = subscription();
        await billing.applyCustomerState({
            userId,
            provider: 'polar',
            customerId: 'cus_1',
            subscriptions: [sub],
            graceMs: GRACE,
        });

        const rows = await entitlements(workspaceId);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.sourceReference).toBe('sub_1');
        expect(rows[0]?.quotaBytes).toBe(500n * GIB);
        expect(rows[0]?.revokedAt).toBeNull();
        expect(rows[0]?.expiresAt?.getTime()).toBe(sub.currentPeriodEnd.getTime() + GRACE);

        const allowance = await getStorageAllowance(userId);
        expect(allowance?.quotaBytes).toBe((501n * GIB).toString());
        expect((await billing.getBillingSummary(userId)).hasCustomer).toBe(true);
    });

    test('a renewal extends the same entitlement instead of adding one', async () => {
        const { userId, workspaceId } = await createTestAccount();
        const first = subscription();
        await billing.applyCustomerState({
            userId,
            provider: 'polar',
            customerId: 'cus_1',
            subscriptions: [first],
            graceMs: GRACE,
        });
        const renewed = subscription({
            currentPeriodEnd: new Date(first.currentPeriodEnd.getTime() + 30 * DAY),
        });
        await billing.applyCustomerState({
            userId,
            provider: 'polar',
            customerId: 'cus_1',
            subscriptions: [renewed],
            graceMs: GRACE,
        });

        const rows = await entitlements(workspaceId);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.expiresAt?.getTime()).toBe(renewed.currentPeriodEnd.getTime() + GRACE);
    });

    test('a subscription missing from the state is ended and its entitlement revoked', async () => {
        const { userId, workspaceId } = await createTestAccount();
        await billing.applyCustomerState({
            userId,
            provider: 'polar',
            customerId: 'cus_1',
            subscriptions: [subscription()],
            graceMs: GRACE,
        });
        await billing.applyCustomerState({
            userId,
            provider: 'polar',
            customerId: 'cus_1',
            subscriptions: [],
            graceMs: GRACE,
        });

        const rows = await entitlements(workspaceId);
        expect(rows[0]?.revokedAt).not.toBeNull();
        const summary = await billing.getBillingSummary(userId);
        expect(summary.subscription?.status).toBe('canceled');
        expect(summary.subscription?.endedAt).not.toBeNull();
        expect((await getStorageAllowance(userId))?.quotaBytes).toBe(GIB.toString());
        expect(await billing.listUnendedSubscriptionIds(userId)).toEqual([]);
    });

    test('cancel at period end keeps the allowance; an ended subscription loses it', async () => {
        const { userId, workspaceId } = await createTestAccount();
        await billing.applyCustomerState({
            userId,
            provider: 'polar',
            customerId: 'cus_1',
            subscriptions: [subscription({ cancelAtPeriodEnd: true })],
            graceMs: GRACE,
        });
        expect((await entitlements(workspaceId))[0]?.revokedAt).toBeNull();
        expect((await billing.getBillingSummary(userId)).subscription?.cancelAtPeriodEnd).toBe(
            true,
        );

        await billing.applyCustomerState({
            userId,
            provider: 'polar',
            customerId: 'cus_1',
            subscriptions: [subscription({ status: 'canceled', endedAt: new Date() })],
            graceMs: GRACE,
        });
        expect((await entitlements(workspaceId))[0]?.revokedAt).not.toBeNull();
        expect((await getStorageAllowance(userId))?.quotaBytes).toBe(GIB.toString());
    });

    test('past due keeps the allowance through the retry window', async () => {
        const { userId, workspaceId } = await createTestAccount();
        await billing.applyCustomerState({
            userId,
            provider: 'polar',
            customerId: 'cus_1',
            subscriptions: [subscription({ status: 'past_due' })],
            graceMs: GRACE,
        });
        expect((await entitlements(workspaceId))[0]?.revokedAt).toBeNull();
    });

    test('a plan change updates the quota on the same entitlement', async () => {
        const { userId, workspaceId } = await createTestAccount();
        await billing.applyCustomerState({
            userId,
            provider: 'polar',
            customerId: 'cus_1',
            subscriptions: [subscription()],
            graceMs: GRACE,
        });
        await billing.applyCustomerState({
            userId,
            provider: 'polar',
            customerId: 'cus_1',
            subscriptions: [
                subscription({
                    productId: 'prod_max',
                    productName: 'Max',
                    quotaBytes: 1024n * GIB,
                }),
            ],
            graceMs: GRACE,
        });
        const rows = await entitlements(workspaceId);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.quotaBytes).toBe(1024n * GIB);
        expect((await billing.getBillingSummary(userId)).subscription?.productName).toBe('Max');
    });

    test('returns false and writes nothing for a user without a workspace', async () => {
        const { userId } = await createTestAccount();
        await db.execute(`delete from personal_workspaces where user_id = '${userId}'`);
        const applied = await billing.applyCustomerState({
            userId,
            provider: 'polar',
            customerId: 'cus_1',
            subscriptions: [subscription()],
            graceMs: GRACE,
        });
        expect(applied).toBe(false);
        expect(await billing.getCustomer(userId)).toBeNull();
    });
});

/* The mirror's answer to every question a status decides, for one user. */
async function standing(userId: string) {
    return {
        unended: await billing.listUnendedSubscriptionIds(userId),
        live: await billing.listLivePlanIds(userId),
        lapsed: await billing.listLapsedPlanIds(userId),
    };
}

function apply(userId: string, subscriptions: billing.SubscriptionSnapshot[]) {
    return billing.applyCustomerState({
        userId,
        provider: 'polar',
        customerId: 'cus_1',
        subscriptions,
        graceMs: GRACE,
    });
}

describe('a personal plan Polar holds but that gives nothing', () => {
    test.each(['unpaid', 'incomplete', 'paused'])(
        'one Polar answers as %s stays unended with its status, gives no storage at once, and comes back when paid',
        async (status) => {
            const { userId, workspaceId } = await createTestAccount();
            await apply(userId, [subscription()]);
            expect((await getStorageAllowance(userId))?.quotaBytes).toBe((501n * GIB).toString());
            // Mid-period: the grace days stretch a period that ran out, not a payment that lapsed.
            await apply(userId, [subscription({ status })]);
            const summary = await billing.getBillingSummary(userId);
            expect(summary.subscription).toMatchObject({ id: 'sub_1', status, endedAt: null });
            expect(await standing(userId)).toEqual({
                unended: ['sub_1'],
                live: [],
                lapsed: ['sub_1'],
            });
            expect((await entitlements(workspaceId))[0]?.revokedAt).toBeInstanceOf(Date);
            expect((await getStorageAllowance(userId))?.quotaBytes).toBe(GIB.toString());
            // The next reconcile reads it again and still keeps it.
            await apply(userId, [subscription({ status })]);
            expect((await billing.getBillingSummary(userId)).subscription?.endedAt).toBeNull();
            // Paid (or resumed) after all: live again, and its storage with it.
            await apply(userId, [subscription()]);
            expect(await standing(userId)).toEqual({
                unended: ['sub_1'],
                live: ['sub_1'],
                lapsed: [],
            });
            expect((await getStorageAllowance(userId))?.quotaBytes).toBe((501n * GIB).toString());
        },
    );

    test('one Polar no longer has (404) is ended, with the status it was last seen in', async () => {
        const { userId } = await createTestAccount();
        await apply(userId, [subscription({ status: 'unpaid' })]);
        await apply(userId, []);
        const summary = await billing.getBillingSummary(userId);
        expect(summary.subscription).toMatchObject({ status: 'unpaid' });
        expect(summary.subscription?.endedAt).not.toBeNull();
        expect(await standing(userId)).toEqual({ unended: [], live: [], lapsed: [] });
    });

    test('a status Polar adds later is kept but never counted as lapsed, so a checkout never revokes it', async () => {
        const { userId } = await createTestAccount();
        await apply(userId, [subscription({ status: 'on_hold' })]);
        expect(await standing(userId)).toEqual({ unended: ['sub_1'], live: [], lapsed: [] });
        expect((await getStorageAllowance(userId))?.quotaBytes).toBe(GIB.toString());
    });

    test('a lapsed plan about to be revoked gets a settled ending with no family, once; a dropped one is taken over', async () => {
        const { userId } = await createTestAccount();
        const at = new Date('2026-10-21T10:00:00Z');
        expect(
            await billing.beginLapsedRevoke({ subscriptionId: 'sub_1', userId, at }),
        ).toMatchObject({ groupId: null, pooledAt: at, revokedAt: null, outcome: 'settled' });
        // Asked again before any revoke landed (one that timed out unlanded): taken over.
        const later = new Date('2026-10-22T00:00:00Z');
        await billing.beginLapsedRevoke({ subscriptionId: 'sub_1', userId, at: later });
        expect((await billing.getPlanEnding('sub_1'))?.pooledAt).toEqual(later);
        // Once Polar says it ended, it stands.
        await billing.recordPlanRevoked('sub_1', {
            revokedAt: later,
            periodStart: at,
            periodEnd: later,
        });
        await billing.beginLapsedRevoke({
            subscriptionId: 'sub_1',
            userId,
            at: new Date('2026-10-23T00:00:00Z'),
        });
        expect((await billing.getPlanEnding('sub_1'))?.pooledAt).toEqual(later);
        expect(await billing.listOpenPlanEndings(userId)).toEqual([]);
        // A pooled ending its owner left before the revoke (dropped) is taken over; one still
        // being worked is left to its own job.
        const groupId = '00000000-0000-4000-8000-000000000001';
        for (const id of ['sub_dropped', 'sub_open'])
            await billing.ensurePlanEnding({
                subscriptionId: id,
                userId,
                groupId,
                admittedAt: at,
                pooledAt: at,
            });
        await billing.dropPlanEnding('sub_dropped');
        expect(
            await billing.beginLapsedRevoke({ subscriptionId: 'sub_dropped', userId, at }),
        ).toMatchObject({ groupId: null, outcome: 'settled' });
        expect(
            await billing.beginLapsedRevoke({ subscriptionId: 'sub_open', userId, at }),
        ).toMatchObject({ groupId, outcome: null });
    });

    test('nothing noted under an earlier ending survives a takeover or the paid-orders snapshot', async () => {
        const { userId } = await createTestAccount();
        const at = new Date('2026-10-21T10:00:00Z');
        const note = (orderId: string) =>
            billing.notePlanRefund({
                orderId,
                subscriptionId: 'sub_1',
                refundKey: `key_${orderId}`,
                amount: 0,
                currency: 'usd',
            });
        // An ending dropped by a version that left a noted row unworked.
        await billing.beginLapsedRevoke({ subscriptionId: 'sub_1', userId, at });
        await note('order_old');
        await billing.closePlanEnding('sub_1', 'ended');
        await db.execute(
            "update personal_plan_endings set outcome = 'dropped' where subscription_id = 'sub_1'",
        );
        await billing.beginLapsedRevoke({ subscriptionId: 'sub_1', userId, at });
        expect((await billing.getPlanRefund('order_old'))?.status).toBe('none');
        // A noted, unworked row the snapshot finds paid already: never refunded.
        await note('order_paid');
        await billing.notePaidBeforeRevoke([
            { orderId: 'order_paid', subscriptionId: 'sub_1', refundKey: 'k', currency: 'usd' },
        ]);
        expect((await billing.getPlanRefund('order_paid'))?.status).toBe('none');
        // One already worked is left as it is.
        await note('order_worked');
        await billing.markPlanRefundAttempt('order_worked');
        await billing.notePaidBeforeRevoke([
            { orderId: 'order_worked', subscriptionId: 'sub_1', refundKey: 'k2', currency: 'usd' },
        ]);
        expect((await billing.getPlanRefund('order_worked'))?.status).toBe('requested');
    });

    test('an ending isn’t settled while a refund noted on it was never asked for', async () => {
        const { userId } = await createTestAccount();
        const at = new Date('2026-10-21T10:00:00Z');
        await billing.beginLapsedRevoke({ subscriptionId: 'sub_1', userId, at });
        await billing.reopenPlanEnding('sub_1');
        await billing.notePlanRefund({
            orderId: 'order_1',
            subscriptionId: 'sub_1',
            refundKey: 'key_1',
            amount: 0,
            currency: 'usd',
        });
        expect(await billing.closePlanEnding('sub_1', 'settled')).toBe(false);
        expect((await billing.getPlanEnding('sub_1'))?.outcome).toBeNull();
        // Asked for once: no longer unworked.
        await billing.markPlanRefundAttempt('order_1');
        expect(await billing.closePlanEnding('sub_1', 'settled')).toBe(true);
        expect((await billing.getPlanEnding('sub_1'))?.outcome).toBe('settled');
    });

    test('one Polar answers as canceled or expired without saying when it ended is ended now', async () => {
        const { userId } = await createTestAccount();
        await apply(userId, [
            subscription({ id: 'sub_a', status: 'canceled' }),
            subscription({ id: 'sub_b', status: 'incomplete_expired' }),
        ]);
        expect(await standing(userId)).toEqual({ unended: [], live: [], lapsed: [] });
        expect((await getStorageAllowance(userId))?.quotaBytes).toBe(GIB.toString());
    });

    test('the summary shows the live plan over a lapsed one, and a lapsed one over an ended one', async () => {
        const { userId } = await createTestAccount();
        await apply(userId, [
            subscription({ id: 'sub_ended', status: 'canceled', endedAt: new Date() }),
            subscription({ id: 'sub_unpaid', status: 'unpaid' }),
        ]);
        await db
            .update(billingSubscriptions)
            .set({ updatedAt: new Date(Date.now() + DAY) })
            .where(eq(billingSubscriptions.id, 'sub_ended'));
        expect((await billing.getBillingSummary(userId)).subscription?.id).toBe('sub_unpaid');
        // A new plan, bought while the lapsed one was touched later still.
        await apply(userId, [
            subscription({ id: 'sub_unpaid', status: 'unpaid' }),
            subscription({ id: 'sub_new', productId: 'prod_max', quotaBytes: 1024n * GIB }),
        ]);
        await db
            .update(billingSubscriptions)
            .set({ updatedAt: new Date(Date.now() + 2 * DAY) })
            .where(eq(billingSubscriptions.id, 'sub_unpaid'));
        expect((await billing.getBillingSummary(userId)).subscription?.id).toBe('sub_new');
        expect((await getStorageAllowance(userId))?.quotaBytes).toBe((1025n * GIB).toString());
    });
});

describe('recordWebhookEvent', () => {
    test('a new delivery is pending, a processed one is not, a failed one is retried', async () => {
        const event = { id: 'msg_1', provider: 'polar', type: 'subscription.active' };
        expect(await billing.recordWebhookEvent(event)).toEqual({ pending: true });
        expect(await billing.recordWebhookEvent(event)).toEqual({ pending: true });
        await billing.markWebhookProcessed('msg_1');
        expect(await billing.recordWebhookEvent(event)).toEqual({ pending: false });
    });
});

describe('signup intents', () => {
    test('a pending intent is returned once and consumed', async () => {
        const { userId } = await createTestAccount();
        await db
            .insert(accountIntents)
            .values({ userId, planProductId: 'prod_pro', source: 'pricing' });
        expect((await billing.getPendingIntent(userId))?.planProductId).toBe('prod_pro');
        await billing.consumeIntent(userId);
        expect(await billing.getPendingIntent(userId)).toBeNull();
    });
});
