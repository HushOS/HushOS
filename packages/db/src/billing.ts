import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { db } from './client';
import {
    accountIntents,
    billingCustomers,
    billingSubscriptions,
    billingWebhookEvents,
    personalWorkspaces,
    storageEntitlements,
} from './schema';

// past_due keeps its allowance through the retry window; the entitlement's own expiry bounds it.
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

export type SubscriptionSnapshot = {
    id: string;
    productId: string;
    productName: string;
    status: string;
    recurringInterval: string;
    quotaBytes: bigint;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    endedAt: Date | null;
};

/*
 * Records a delivery and says whether it still needs applying. A retry of a
 * delivery that failed midway is applied again; one that was applied is not.
 */
export async function recordWebhookEvent(input: { id: string; provider: string; type: string }) {
    const [row] = await db
        .insert(billingWebhookEvents)
        .values(input)
        .onConflictDoNothing()
        .returning({ id: billingWebhookEvents.id });
    if (row) return { pending: true };
    const [existing] = await db
        .select({ processedAt: billingWebhookEvents.processedAt })
        .from(billingWebhookEvents)
        .where(eq(billingWebhookEvents.id, input.id));
    return { pending: !existing?.processedAt };
}

export async function markWebhookProcessed(id: string) {
    await db
        .update(billingWebhookEvents)
        .set({ processedAt: new Date() })
        .where(eq(billingWebhookEvents.id, id));
}

export async function listLiveSubscriptionIds(userId: string) {
    const rows = await db
        .select({ id: billingSubscriptions.id })
        .from(billingSubscriptions)
        .where(and(eq(billingSubscriptions.userId, userId), isNull(billingSubscriptions.endedAt)));
    return rows.map((row) => row.id);
}

export async function getCustomer(userId: string) {
    const [row] = await db
        .select()
        .from(billingCustomers)
        .where(eq(billingCustomers.userId, userId));
    return row ?? null;
}

export async function listCustomerIds(provider: string) {
    const rows = await db
        .select({ userId: billingCustomers.userId })
        .from(billingCustomers)
        .where(eq(billingCustomers.provider, provider));
    return rows.map((row) => row.userId);
}

/*
 * Replaces what is known about a user's subscriptions with the provider's current
 * answer. Subscriptions absent from the snapshot have ended; their entitlements are
 * revoked in the same transaction, so the allowance can never outlive the plan.
 */
export async function applyCustomerState(input: {
    userId: string;
    provider: string;
    customerId: string | null;
    subscriptions: SubscriptionSnapshot[];
    graceMs: number;
}) {
    return db.transaction(async (tx) => {
        const [personal] = await tx
            .select({ workspaceId: personalWorkspaces.workspaceId })
            .from(personalWorkspaces)
            .where(eq(personalWorkspaces.userId, input.userId));
        if (!personal) return false;
        const now = new Date();
        if (input.customerId)
            await tx
                .insert(billingCustomers)
                .values({
                    userId: input.userId,
                    provider: input.provider,
                    providerCustomerId: input.customerId,
                })
                .onConflictDoUpdate({
                    target: billingCustomers.userId,
                    set: { providerCustomerId: input.customerId, updatedAt: now },
                });
        const live = input.subscriptions.filter(
            (subscription) => !subscription.endedAt && LIVE_STATUSES.has(subscription.status),
        );
        for (const subscription of input.subscriptions) {
            await tx
                .insert(billingSubscriptions)
                .values({
                    id: subscription.id,
                    userId: input.userId,
                    workspaceId: personal.workspaceId,
                    provider: input.provider,
                    productId: subscription.productId,
                    productName: subscription.productName,
                    status: subscription.status,
                    recurringInterval: subscription.recurringInterval,
                    quotaBytes: subscription.quotaBytes,
                    currentPeriodEnd: subscription.currentPeriodEnd,
                    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
                    endedAt: subscription.endedAt,
                })
                .onConflictDoUpdate({
                    target: billingSubscriptions.id,
                    set: {
                        productId: subscription.productId,
                        productName: subscription.productName,
                        status: subscription.status,
                        recurringInterval: subscription.recurringInterval,
                        quotaBytes: subscription.quotaBytes,
                        currentPeriodEnd: subscription.currentPeriodEnd,
                        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
                        endedAt: subscription.endedAt,
                        updatedAt: now,
                    },
                });
        }
        for (const subscription of live) {
            const expiresAt = new Date(subscription.currentPeriodEnd.getTime() + input.graceMs);
            await tx
                .insert(storageEntitlements)
                .values({
                    workspaceId: personal.workspaceId,
                    source: input.provider,
                    sourceReference: subscription.id,
                    quotaBytes: subscription.quotaBytes,
                    expiresAt,
                })
                .onConflictDoUpdate({
                    target: storageEntitlements.sourceReference,
                    set: { quotaBytes: subscription.quotaBytes, expiresAt, revokedAt: null },
                });
        }
        const liveIds = live.map((subscription) => subscription.id);
        const ended = and(
            eq(billingSubscriptions.userId, input.userId),
            eq(billingSubscriptions.provider, input.provider),
            liveIds.length ? notInArray(billingSubscriptions.id, liveIds) : undefined,
        );
        await tx
            .update(billingSubscriptions)
            .set({
                status: sql`case when ${billingSubscriptions.status} in ('active', 'trialing', 'past_due') then 'canceled' else ${billingSubscriptions.status} end`,
                endedAt: sql`coalesce(${billingSubscriptions.endedAt}, now())`,
                updatedAt: now,
            })
            .where(and(ended, isNull(billingSubscriptions.endedAt)));
        const endedIds = await tx
            .select({ id: billingSubscriptions.id })
            .from(billingSubscriptions)
            .where(ended);
        if (endedIds.length)
            await tx
                .update(storageEntitlements)
                .set({ revokedAt: now })
                .where(
                    and(
                        eq(storageEntitlements.workspaceId, personal.workspaceId),
                        eq(storageEntitlements.source, input.provider),
                        inArray(
                            storageEntitlements.sourceReference,
                            endedIds.map((row) => row.id),
                        ),
                        isNull(storageEntitlements.revokedAt),
                    ),
                );
        return true;
    });
}

/* The current subscription is the live one, or failing that the most recently updated. */
export async function getBillingSummary(userId: string) {
    const [customer] = await db
        .select({ providerCustomerId: billingCustomers.providerCustomerId })
        .from(billingCustomers)
        .where(eq(billingCustomers.userId, userId));
    const rows = await db
        .select()
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.userId, userId))
        .orderBy(
            sql`${billingSubscriptions.endedAt} is not null`,
            sql`${billingSubscriptions.updatedAt} desc`,
        )
        .limit(1);
    const subscription = rows[0];
    return {
        hasCustomer: Boolean(customer),
        subscription: subscription
            ? {
                  id: subscription.id,
                  productId: subscription.productId,
                  productName: subscription.productName,
                  status: subscription.status,
                  recurringInterval: subscription.recurringInterval,
                  quotaBytes: subscription.quotaBytes.toString(),
                  currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
                  cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
                  endedAt: subscription.endedAt?.toISOString() ?? null,
              }
            : null,
    };
}

/* The plan someone signed up for and has not checked out yet. */
export async function getPendingIntent(userId: string) {
    const [row] = await db
        .select({ planProductId: accountIntents.planProductId })
        .from(accountIntents)
        .where(and(eq(accountIntents.userId, userId), isNull(accountIntents.consumedAt)));
    return row ?? null;
}

export async function consumeIntent(userId: string) {
    await db
        .update(accountIntents)
        .set({ consumedAt: new Date() })
        .where(and(eq(accountIntents.userId, userId), isNull(accountIntents.consumedAt)));
}
