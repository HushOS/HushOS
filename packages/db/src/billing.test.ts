import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, createTestAccount, resetDatabase } from '../test/helpers';
import { getStorageAllowance } from './auth';
import * as billing from './billing';
import { db } from './client';
import { accountIntents, storageEntitlements } from './schema';

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
        expect(await billing.listLiveSubscriptionIds(userId)).toEqual([]);
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
