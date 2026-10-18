import { and, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { db } from './client';
import {
    accountIntents,
    billingCustomers,
    billingSubscriptions,
    billingWebhookEvents,
    groupBillingCustomers,
    groupBillingSubscriptions,
    groupStorage,
    groups,
    personalWorkspaces,
    storageEntitlements,
    workspaceStorage,
    workspaces,
} from './schema';

// past_due keeps its allowance through the retry window; the entitlement's own expiry bounds it.
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

export type SubscriptionSnapshot = {
    id: string;
    productId: string;
    productName: string;
    status: string;
    recurringInterval: string;
    amount: number | null;
    currency: string | null;
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
                    amount: subscription.amount,
                    currency: subscription.currency,
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
                        amount: subscription.amount,
                        currency: subscription.currency,
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
                  amount: subscription.amount,
                  currency: subscription.currency,
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

/* ------------------------------------------------------------------------- */
/* Groups (docs/groups-design.md 3.5)                                         */
/* ------------------------------------------------------------------------- */

export type GroupSubscriptionSnapshot = {
    id: string;
    productId: string;
    productName: string;
    status: string;
    recurringInterval: string;
    amount: number | null;
    currency: string | null;
    /* The member capacity bought, and a cut scheduled for the period's end. */
    units: number;
    /*
     * The places paid for: `units` once no order of the subscription waits for
     * payment, or null when one does (or that could not be read), which keeps
     * the count last paid, never above `units`.
     */
    paidUnits: number | null;
    pendingUnits: number | null;
    /* The product a pending update moves the plan to at the period's end (a smaller tier). */
    pendingProductId: string | null;
    /*
     * The tier paid for (the newest paid, unrefunded order's product and its pool), null
     * while nothing is paid; absent when Polar's orders couldn't be read, which leaves the
     * row's as it was (a new row then starts with nothing paid).
     */
    paidTier?: { productId: string; quotaBytes: bigint } | null;
    /* Since when the product has been bigger than the tier paid for; null once it isn't. */
    tierMismatchSince?: Date | null;
    includedMembers: number;
    /* The pool the plan gives the group; a family's is fixed. */
    quotaBytes: bigint;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    endedAt: Date | null;
};

export async function getGroupCustomer(groupId: string) {
    const [row] = await db
        .select()
        .from(groupBillingCustomers)
        .where(eq(groupBillingCustomers.groupId, groupId));
    return row ?? null;
}

/*
 * Moves a family's billing to another member, only from the payer the caller
 * read (`from`, null once that account is gone): true when this call made the
 * change, false when someone else's change got there first.
 */
export async function setGroupPayer(groupId: string, from: string | null, to: string) {
    const rows = await db
        .update(groupBillingCustomers)
        .set({ payerUserId: to, updatedAt: new Date() })
        .where(
            and(
                eq(groupBillingCustomers.groupId, groupId),
                from === null
                    ? isNull(groupBillingCustomers.payerUserId)
                    : eq(groupBillingCustomers.payerUserId, from),
            ),
        )
        .returning({ groupId: groupBillingCustomers.groupId });
    return rows.length === 1;
}

/*
 * Records the provider customer made for a group and who pays. A row already
 * there wins (two checkouts at once made one customer at the provider, whose
 * external id is unique): the caller compares the payer it gets back.
 */
export async function recordGroupCustomer(input: {
    groupId: string;
    provider: string;
    providerCustomerId: string;
    payerUserId: string;
}) {
    await db.insert(groupBillingCustomers).values(input).onConflictDoNothing();
    return getGroupCustomer(input.groupId);
}

export async function listGroupCustomerIds(provider: string) {
    const rows = await db
        .select({ groupId: groupBillingCustomers.groupId })
        .from(groupBillingCustomers)
        .where(eq(groupBillingCustomers.provider, provider));
    return rows.map((row) => row.groupId);
}

export async function listLiveGroupSubscriptionIds(groupId: string) {
    const rows = await db
        .select({ id: groupBillingSubscriptions.id })
        .from(groupBillingSubscriptions)
        .where(
            and(
                eq(groupBillingSubscriptions.groupId, groupId),
                isNull(groupBillingSubscriptions.endedAt),
            ),
        );
    return rows.map((row) => row.id);
}

const liveGroupSubscription = (groupId: string) =>
    and(
        eq(groupBillingSubscriptions.groupId, groupId),
        isNull(groupBillingSubscriptions.endedAt),
        inArray(groupBillingSubscriptions.status, [...LIVE_STATUSES]),
    );

/* The group's plan: its live subscription, the one running longest if there were ever two. */
export async function getLiveGroupSubscription(groupId: string) {
    const [row] = await db
        .select()
        .from(groupBillingSubscriptions)
        .where(liveGroupSubscription(groupId))
        .orderBy(desc(groupBillingSubscriptions.currentPeriodEnd))
        .limit(1);
    return row ?? null;
}

/*
 * Groups whose live plan this person pays for: their account cannot be
 * deleted, nor they leave or be removed, meanwhile. A plan set to cancel at
 * the period's end is not live here: its payer has stopped paying, and the
 * family keeps it until it ends.
 */
export async function listGroupsPaidBy(userId: string) {
    const rows = await db
        .selectDistinct({ groupId: groupBillingCustomers.groupId })
        .from(groupBillingCustomers)
        .innerJoin(
            groupBillingSubscriptions,
            eq(groupBillingSubscriptions.groupId, groupBillingCustomers.groupId),
        )
        .where(
            and(
                eq(groupBillingCustomers.payerUserId, userId),
                isNull(groupBillingSubscriptions.endedAt),
                inArray(groupBillingSubscriptions.status, [...LIVE_STATUSES]),
                eq(groupBillingSubscriptions.cancelAtPeriodEnd, false),
            ),
        );
    return rows.map((row) => row.groupId);
}

/*
 * The seats a plan allows: what was bought, or a scheduled cut if lower, since
 * a cut blocks new admissions from the moment it is made and never removes
 * anyone (docs/groups-design.md 3.5).
 */
export function seatLimitOf(subscription: {
    units: number;
    paidUnits: number;
    pendingUnits: number | null;
}) {
    const limit = Math.min(
        subscription.units,
        subscription.paidUnits,
        subscription.pendingUnits ?? subscription.units,
    );
    return Math.max(1, limit);
}

/*
 * The next-period count HushOS asked Polar for, or null once nothing is due
 * (the cut applied, was cleared, or is no longer below the count).
 */
export async function setIntendedUnits(
    subscriptionId: string,
    units: number | null,
    stale = false,
) {
    await db
        .update(groupBillingSubscriptions)
        .set({
            intendedUnits: units,
            intendedStale: units !== null && stale,
            updatedAt: new Date(),
        })
        .where(eq(groupBillingSubscriptions.id, subscriptionId));
}

/*
 * The smaller tier HushOS asked Polar to move the plan to at the period's
 * end, or null once nothing is due (the move applied, or was withdrawn).
 */
export async function setIntendedProduct(
    subscriptionId: string,
    productId: string | null,
    stale = false,
) {
    await db
        .update(groupBillingSubscriptions)
        .set({
            intendedProductId: productId,
            intendedProductStale: productId !== null && stale,
            updatedAt: new Date(),
        })
        .where(eq(groupBillingSubscriptions.id, subscriptionId));
}

/*
 * Notes what HushOS just asked Polar for again, when, and how many times in a
 * row (the reconcile guard and the give-up rule); `state` null once Polar holds
 * what HushOS wants, which resets the count.
 */
export async function markReissued(
    subscriptionId: string,
    state: string | null,
    attempts: number,
    at = new Date(Date.now()),
) {
    await db
        .update(groupBillingSubscriptions)
        .set({
            reissuedAt: state === null ? null : at,
            reissuedState: state,
            reissueAttempts: attempts,
            updatedAt: at,
        })
        .where(eq(groupBillingSubscriptions.id, subscriptionId));
}

/*
 * Claims the family's one queued retry until `until`: false when another is
 * still pending (claimed by someone else and not yet due), so it is not queued twice.
 */
export async function claimReissueRetry(subscriptionId: string, until: Date) {
    const now = new Date(Date.now());
    const rows = await db
        .update(groupBillingSubscriptions)
        .set({ reissueRetryAt: until, updatedAt: now })
        .where(
            and(
                eq(groupBillingSubscriptions.id, subscriptionId),
                sql`(${groupBillingSubscriptions.reissueRetryAt} is null or ${groupBillingSubscriptions.reissueRetryAt} <= ${now.toISOString()}::timestamptz)`,
            ),
        )
        .returning({ id: groupBillingSubscriptions.id });
    return rows.length === 1;
}

/*
 * Marks (or, with null, clears) a family's plan change HushOS can't make, and why
 * (`not-kept`, `revert-unavailable`): the operators' list on the management page.
 */
export async function setReissueGaveUp(
    subscriptionId: string,
    at: Date | null,
    reason: 'not-kept' | 'revert-unavailable' | null = null,
) {
    await db
        .update(groupBillingSubscriptions)
        .set({
            reissueGaveUpAt: at,
            reissueStuckReason: at === null ? null : reason,
            updatedAt: new Date(),
        })
        .where(eq(groupBillingSubscriptions.id, subscriptionId));
}

/*
 * Claims the family's one plan change (a place purchase or an upgrade) until
 * `until`: false while another holds it and hasn't run out.
 */
export async function claimPlanChange(subscriptionId: string, until: Date) {
    const now = new Date(Date.now());
    const rows = await db
        .update(groupBillingSubscriptions)
        .set({ changeClaimUntil: until, updatedAt: now })
        .where(
            and(
                eq(groupBillingSubscriptions.id, subscriptionId),
                sql`(${groupBillingSubscriptions.changeClaimUntil} is null or ${groupBillingSubscriptions.changeClaimUntil} <= ${now.toISOString()}::timestamptz)`,
            ),
        )
        .returning({ id: groupBillingSubscriptions.id });
    return rows.length === 1;
}

export async function releasePlanChange(subscriptionId: string) {
    await db
        .update(groupBillingSubscriptions)
        .set({ changeClaimUntil: null, updatedAt: new Date() })
        .where(eq(groupBillingSubscriptions.id, subscriptionId));
}

/* Records orders that must never count as paying for a tier (added to those already kept). */
export async function addUncreditedOrders(subscriptionId: string, orderIds: string[]) {
    if (!orderIds.length) return;
    await db.transaction(async (tx) => {
        const [row] = await tx
            .select({ ids: groupBillingSubscriptions.uncreditedOrderIds })
            .from(groupBillingSubscriptions)
            .where(eq(groupBillingSubscriptions.id, subscriptionId))
            .for('update');
        if (!row) return;
        await tx
            .update(groupBillingSubscriptions)
            .set({
                uncreditedOrderIds: [...new Set([...(row.ids ?? []), ...orderIds])],
                updatedAt: new Date(),
            })
            .where(eq(groupBillingSubscriptions.id, subscriptionId));
    });
}

/* Lets a claimed retry go (its job could not be queued), so the next attempt may queue one. */
export async function releaseReissueRetry(subscriptionId: string) {
    await db
        .update(groupBillingSubscriptions)
        .set({ reissueRetryAt: null, updatedAt: new Date() })
        .where(eq(groupBillingSubscriptions.id, subscriptionId));
}

/* Live family plans whose scheduled change HushOS gave up on: the operators' list. */
export async function listGivenUpReissues() {
    return db
        .select({
            groupId: groupBillingSubscriptions.groupId,
            subscriptionId: groupBillingSubscriptions.id,
            wanted: groupBillingSubscriptions.reissuedState,
            reason: groupBillingSubscriptions.reissueStuckReason,
            since: groupBillingSubscriptions.reissueGaveUpAt,
        })
        .from(groupBillingSubscriptions)
        .where(
            and(
                isNull(groupBillingSubscriptions.endedAt),
                isNotNull(groupBillingSubscriptions.reissueGaveUpAt),
            ),
        )
        .orderBy(desc(groupBillingSubscriptions.reissueGaveUpAt));
}

/* One group subscription's row, live or not: what it had paid for before a change. */
export async function getGroupSubscription(subscriptionId: string) {
    const [row] = await db
        .select()
        .from(groupBillingSubscriptions)
        .where(eq(groupBillingSubscriptions.id, subscriptionId));
    return row ?? null;
}

/* Live group subscriptions with a cut or a tier move HushOS still means to have at Polar. */
export async function listIntendedCuts() {
    return db
        .select({
            groupId: groupBillingSubscriptions.groupId,
            subscriptionId: groupBillingSubscriptions.id,
        })
        .from(groupBillingSubscriptions)
        .where(
            and(
                isNull(groupBillingSubscriptions.endedAt),
                sql`(${groupBillingSubscriptions.intendedUnits} is not null or ${groupBillingSubscriptions.intendedProductId} is not null)`,
            ),
        );
}

/*
 * Replaces what is known about a group's subscriptions with the provider's
 * answer, and projects the live plan onto the group in the same transaction:
 * `groups.seat_limit` (null without a plan: the instance default) and the
 * group's storage pool (empty without a plan; the period end plus the grace
 * days with one). The group row is locked before the pool, the order Drive's
 * free-space check takes them in.
 */
export async function applyGroupState(input: {
    groupId: string;
    provider: string;
    customerId: string | null;
    subscriptions: GroupSubscriptionSnapshot[];
    graceMs: number;
    /*
     * Whether `subscriptions` is everything the provider has (a reconcile: any
     * other live row has ended), or one subscription as a change returned it.
     */
    complete?: boolean;
    /*
     * Subscriptions the caller could not read into a snapshot (their product is
     * not a plan it knows): left exactly as they are, never swept as ended.
     */
    keepIds?: string[];
}) {
    return db.transaction(async (tx) => {
        const [group] = await tx
            .select({ id: groups.id })
            .from(groups)
            .where(eq(groups.id, input.groupId))
            .for('no key update');
        if (!group) return false;
        const now = new Date();
        if (input.customerId)
            await tx
                .insert(groupBillingCustomers)
                .values({
                    groupId: input.groupId,
                    provider: input.provider,
                    providerCustomerId: input.customerId,
                })
                .onConflictDoUpdate({
                    target: groupBillingCustomers.groupId,
                    set: { providerCustomerId: input.customerId, updatedAt: now },
                });
        for (const subscription of input.subscriptions) {
            const paid = subscription.paidUnits;
            const values = {
                productId: subscription.productId,
                productName: subscription.productName,
                status: subscription.status,
                recurringInterval: subscription.recurringInterval,
                amount: subscription.amount,
                currency: subscription.currency,
                units: subscription.units,
                pendingUnits: subscription.pendingUnits,
                pendingProductId: subscription.pendingProductId,
                includedMembers: subscription.includedMembers,
                quotaBytes: subscription.quotaBytes,
                currentPeriodStart: subscription.currentPeriodStart,
                currentPeriodEnd: subscription.currentPeriodEnd,
                cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
                endedAt: subscription.endedAt,
            };
            await tx
                .insert(groupBillingSubscriptions)
                .values({
                    id: subscription.id,
                    groupId: input.groupId,
                    provider: input.provider,
                    ...values,
                    // A subscription first seen with an order unpaid has paid for nothing yet.
                    paidUnits: paid === null ? 0 : Math.min(paid, subscription.units),
                    paidProductId: subscription.paidTier?.productId ?? null,
                    paidQuotaBytes: subscription.paidTier?.quotaBytes ?? 0n,
                    tierMismatchSince: subscription.tierMismatchSince ?? null,
                })
                .onConflictDoUpdate({
                    target: groupBillingSubscriptions.id,
                    set: {
                        ...values,
                        paidUnits:
                            paid === null
                                ? sql`least(${groupBillingSubscriptions.paidUnits}, ${subscription.units})`
                                : Math.min(paid, subscription.units),
                        // The tier paid for, as Polar's orders say it now; unreadable, as it was.
                        ...(subscription.paidTier !== undefined
                            ? {
                                  paidProductId: subscription.paidTier?.productId ?? null,
                                  paidQuotaBytes: subscription.paidTier?.quotaBytes ?? 0n,
                              }
                            : {}),
                        ...(subscription.tierMismatchSince !== undefined
                            ? { tierMismatchSince: subscription.tierMismatchSince }
                            : {}),
                        updatedAt: now,
                    },
                });
        }
        const liveIds = input.subscriptions
            .filter(
                (subscription) => !subscription.endedAt && LIVE_STATUSES.has(subscription.status),
            )
            .map((subscription) => subscription.id)
            .concat(input.keepIds ?? []);
        if (input.complete !== false)
            await tx
                .update(groupBillingSubscriptions)
                .set({
                    status: sql`case when ${groupBillingSubscriptions.status} in ('active', 'trialing', 'past_due') then 'canceled' else ${groupBillingSubscriptions.status} end`,
                    endedAt: sql`coalesce(${groupBillingSubscriptions.endedAt}, now())`,
                    updatedAt: now,
                })
                .where(
                    and(
                        eq(groupBillingSubscriptions.groupId, input.groupId),
                        eq(groupBillingSubscriptions.provider, input.provider),
                        isNull(groupBillingSubscriptions.endedAt),
                        liveIds.length
                            ? notInArray(groupBillingSubscriptions.id, liveIds)
                            : undefined,
                    ),
                );
        const [plan] = await tx
            .select()
            .from(groupBillingSubscriptions)
            .where(liveGroupSubscription(input.groupId))
            .orderBy(desc(groupBillingSubscriptions.currentPeriodEnd))
            .limit(1);
        await tx
            .update(groups)
            .set({ seatLimit: plan ? seatLimitOf(plan) : null, updatedAt: now })
            .where(eq(groups.id, input.groupId));
        const pool = {
            // The lesser of the tier paid for and the product's: an unpaid upgrade gives nothing,
            // a smaller tier at a renewal counts at once.
            quotaBytes: plan
                ? (plan.paidQuotaBytes ?? 0n) < plan.quotaBytes
                    ? (plan.paidQuotaBytes ?? 0n)
                    : plan.quotaBytes
                : 0n,
            expiresAt: plan ? new Date(plan.currentPeriodEnd.getTime() + input.graceMs) : null,
        };
        await tx
            .insert(groupStorage)
            .values({ groupId: input.groupId, ...pool })
            .onConflictDoUpdate({
                target: groupStorage.groupId,
                set: { ...pool, updatedAt: now },
            });
        return true;
    });
}

/* The group's pool as stored, for the billing summary. */
export async function getGroupPool(groupId: string) {
    const [row] = await db
        .select({ quotaBytes: groupStorage.quotaBytes, expiresAt: groupStorage.expiresAt })
        .from(groupStorage)
        .where(eq(groupStorage.groupId, groupId));
    return row ?? null;
}

/*
 * What the family's folders hold, together: the bytes the pool is spent on
 * (drive.ts freeBytes counts the same areas). Reserved bytes of uploads still
 * in flight are left out; the summary shows what is stored.
 */
export async function getGroupPoolUsage(groupId: string) {
    const [row] = await db
        .select({ used: sql<string>`coalesce(sum(${workspaceStorage.usedBytes}), 0)::text` })
        .from(workspaceStorage)
        .innerJoin(workspaces, eq(workspaces.id, workspaceStorage.workspaceId))
        .where(eq(workspaces.groupId, groupId));
    return BigInt(row?.used ?? '0');
}

/* The family's most recent plan that has ended, for the notice once none is live. */
export async function getLastEndedGroupSubscription(groupId: string) {
    const [row] = await db
        .select({
            productName: groupBillingSubscriptions.productName,
            endedAt: groupBillingSubscriptions.endedAt,
        })
        .from(groupBillingSubscriptions)
        .where(
            and(
                eq(groupBillingSubscriptions.groupId, groupId),
                isNotNull(groupBillingSubscriptions.endedAt),
            ),
        )
        .orderBy(desc(groupBillingSubscriptions.endedAt))
        .limit(1);
    return row?.endedAt ? { productName: row.productName, endedAt: row.endedAt } : null;
}
