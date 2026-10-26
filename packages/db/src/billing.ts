import { and, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { db } from './client';
import { memberUsage, poolUsage, pooledFamilyOf, takePoolLock } from './pool';

export { wholeGibUp } from './pool';
import {
    accountIntents,
    billingCustomers,
    billingSubscriptions,
    billingWebhookEvents,
    groupBillingCustomers,
    groupBillingSubscriptions,
    groupMemberships,
    groupStorage,
    groups,
    personalPlanEndings,
    personalPlanRefunds,
    personalWorkspaces,
    storageEntitlements,
} from './schema';

// past_due keeps its allowance through the retry window; the entitlement's own expiry bounds it.
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);
/*
 * Polar still holds the plan, but it gives nothing: its retries ran out, its first payment
 * never went through, or it is paused. Named, so a status Polar adds later is never revoked.
 */
const LAPSED_STATUSES = ['unpaid', 'incomplete', 'paused'];

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

/*
 * Every personal subscription not recorded as ended, whatever its status: what a
 * reconcile reads from Polar one by one, since an `unpaid`, `incomplete` or
 * `paused` plan leaves the customer's state but can still come back.
 */
export async function listUnendedSubscriptionIds(userId: string) {
    const rows = await db
        .select({ id: billingSubscriptions.id })
        .from(billingSubscriptions)
        .where(and(eq(billingSubscriptions.userId, userId), isNull(billingSubscriptions.endedAt)));
    return rows.map((row) => row.id);
}

/* The personal plans that give storage now: not ended, and `active`, `trialing` or `past_due`. */
export async function listLivePlanIds(userId: string) {
    const rows = await db
        .select({ id: billingSubscriptions.id })
        .from(billingSubscriptions)
        .where(
            and(
                eq(billingSubscriptions.userId, userId),
                isNull(billingSubscriptions.endedAt),
                inArray(billingSubscriptions.status, [...LIVE_STATUSES]),
            ),
        );
    return rows.map((row) => row.id);
}

/*
 * Personal plans Polar still holds that give no storage: not ended, and `unpaid`,
 * `incomplete` or `paused`. A new checkout revokes them first, so a later payment or
 * resume can't run one beside the new plan; so does the plan-ending job of someone pooled.
 */
export async function listLapsedPlanIds(userId: string) {
    const rows = await db
        .select({ id: billingSubscriptions.id })
        .from(billingSubscriptions)
        .where(
            and(
                eq(billingSubscriptions.userId, userId),
                isNull(billingSubscriptions.endedAt),
                inArray(billingSubscriptions.status, LAPSED_STATUSES),
            ),
        );
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
 * answer, in one transaction. Only a live plan (`active`, `trialing`, `past_due`, no
 * `ended_at`) holds an entitlement; every other plan's is revoked at once, so the
 * allowance never outlives the plan. A plan in the snapshot that Polar hasn't ended
 * (no `ended_at`, not `canceled` or `incomplete_expired`) is kept unended with Polar's
 * status, `unpaid`, `incomplete` and `paused` included, and read again by the next
 * reconcile: a payment or a resume can still bring it back. One absent from the
 * snapshot (Polar answered 404), or that Polar answers as ended without saying when,
 * is recorded as ended now.
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
        const ended = new Set<string>(ENDED_SUBSCRIPTION_STATUSES);
        const kept = input.subscriptions.filter(
            (subscription) => !subscription.endedAt && !ended.has(subscription.status),
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
        const ofUser = and(
            eq(billingSubscriptions.userId, input.userId),
            eq(billingSubscriptions.provider, input.provider),
        );
        const keptIds = kept.map((subscription) => subscription.id);
        await tx
            .update(billingSubscriptions)
            .set({
                status: sql`case when ${billingSubscriptions.status} in ('active', 'trialing', 'past_due') then 'canceled' else ${billingSubscriptions.status} end`,
                endedAt: sql`coalesce(${billingSubscriptions.endedAt}, now())`,
                updatedAt: now,
            })
            .where(
                and(
                    ofUser,
                    isNull(billingSubscriptions.endedAt),
                    keptIds.length ? notInArray(billingSubscriptions.id, keptIds) : undefined,
                ),
            );
        // Everything that isn't live gives nothing, kept or ended: mid-period too, since the
        // grace days stretch a period that ran out, not a payment that lapsed.
        const liveIds = live.map((subscription) => subscription.id);
        const endedIds = await tx
            .select({ id: billingSubscriptions.id })
            .from(billingSubscriptions)
            .where(
                and(
                    ofUser,
                    liveIds.length ? notInArray(billingSubscriptions.id, liveIds) : undefined,
                ),
            );
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

/*
 * The current subscription: the live one; failing that, one Polar still holds that
 * gives nothing (unpaid, incomplete, paused), so the page can say why; failing that,
 * the most recently updated.
 */
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
            notInArray(billingSubscriptions.status, [...LIVE_STATUSES]),
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

/*
 * Every subscription of the group not recorded as ended, live or not (`unpaid`,
 * `incomplete` and `paused` too): what the next reconcile reads from Polar again.
 */
export async function listUnendedGroupSubscriptionIds(groupId: string) {
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

/*
 * A plan whose product the catalogue could read (recordUnreadGroupSubscription marks the others
 * with their product id for a name): only such a plan is ever the family's plan, its places and
 * pool, or makes its payer one who pays for the family. An unread one is still a plan that can
 * charge (a dissolved family's job ends it, operators see it).
 */
const readablePlan = sql`${groupBillingSubscriptions.productName} <> ${groupBillingSubscriptions.productId}`;

const liveGroupSubscription = (groupId: string) =>
    and(
        eq(groupBillingSubscriptions.groupId, groupId),
        isNull(groupBillingSubscriptions.endedAt),
        inArray(groupBillingSubscriptions.status, [...LIVE_STATUSES]),
        readablePlan,
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

/* Every group whose billing customer names this person as its payer, whatever its plans. */
export async function listGroupsBilledTo(userId: string) {
    const rows = await db
        .select({ groupId: groupBillingCustomers.groupId })
        .from(groupBillingCustomers)
        .where(eq(groupBillingCustomers.payerUserId, userId));
    return rows.map((row) => row.groupId);
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
                readablePlan,
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
 * Claims the family's one plan change (a place purchase or an upgrade) for
 * `holdMs`, on the database's clock: the claim's expiry, the token its holder
 * releases with, or null while another holds one that hasn't run out.
 * Truncated to the millisecond so the token comes back exactly as stored.
 */
export async function claimPlanChange(subscriptionId: string, holdMs: number) {
    const until = sql`date_trunc('milliseconds', now() + make_interval(secs => ${holdMs / 1000}))`;
    const rows = await db
        .update(groupBillingSubscriptions)
        .set({ changeClaimUntil: until, updatedAt: sql`now()` })
        .where(
            and(
                eq(groupBillingSubscriptions.id, subscriptionId),
                sql`(${groupBillingSubscriptions.changeClaimUntil} is null or ${groupBillingSubscriptions.changeClaimUntil} <= now())`,
            ),
        )
        .returning({ until: groupBillingSubscriptions.changeClaimUntil });
    return rows[0]?.until ?? null;
}

/* Lets go of the claim taken as `claim`, and no other: one taken since stays its holder's. */
export async function releasePlanChange(subscriptionId: string, claim: Date) {
    await db
        .update(groupBillingSubscriptions)
        .set({ changeClaimUntil: null, updatedAt: sql`now()` })
        .where(
            and(
                eq(groupBillingSubscriptions.id, subscriptionId),
                eq(groupBillingSubscriptions.changeClaimUntil, claim),
            ),
        );
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

/*
 * How long setting a dissolved family's plan to end may keep failing before operators see it,
 * and how close to its renewal a failing one is listed at once, so they see it before the charge.
 */
export const DISSOLVE_FAILING_LISTED_HOURS = 24;
export const DISSOLVE_FAILING_RENEWAL_HOURS = 48;

/*
 * Live family plans HushOS gave up on, the operators' list: a scheduled change Polar
 * won't keep or can't be moved back (`reissueStuckReason`), or a dissolved family's plan
 * Polar refused to set to end (`dissolved-refused`), or that HushOS has failed to set to
 * end for over a day, or at all within two days of its renewal (`dissolved-failing`: a
 * token error, Polar down), which an operator
 * cancels. Those go from the list once the plan is set to end, whoever set it (the
 * operator in Polar, or its payer), as soon as the mirror shows it. A refused plan that
 * isn't live (`unpaid`, `incomplete`, `paused`: `dissolved-inactive`) stays until it has
 * ended, since setting it to end doesn't end it and the purge waits for the end; an
 * operator revokes it. A scheduled change given up on is listed only while the plan is live.
 */
export async function listGivenUpReissues() {
    const live = sql`(${groupBillingSubscriptions.status} in (${sql.join(
        [...LIVE_STATUSES].map((status) => sql`${status}`),
        sql`, `,
    )}))`;
    const refused = sql`(${groupBillingSubscriptions.dissolveRefusedAt} is not null and (not ${groupBillingSubscriptions.cancelAtPeriodEnd} or not ${live}))`;
    // Not filtered on `cancel_at_period_end`: a run fails before it can read Polar (a revoked
    // token), so the mirror's may be stale. It clears once a reconcile sees the plan ending.
    const failing = sql`(${groupBillingSubscriptions.dissolveRefusedAt} is null and (${groupBillingSubscriptions.dissolveFailingSince} < now() - make_interval(hours => ${DISSOLVE_FAILING_LISTED_HOURS}) or (${groupBillingSubscriptions.dissolveFailingSince} is not null and ${groupBillingSubscriptions.currentPeriodEnd} < now() + make_interval(hours => ${DISSOLVE_FAILING_RENEWAL_HOURS}))))`;
    const since = sql`coalesce(case when ${refused} then ${groupBillingSubscriptions.dissolveRefusedAt} when ${failing} then ${groupBillingSubscriptions.dissolveFailingSince} end, ${groupBillingSubscriptions.reissueGaveUpAt})`;
    return db
        .select({
            groupId: groupBillingSubscriptions.groupId,
            subscriptionId: groupBillingSubscriptions.id,
            wanted: groupBillingSubscriptions.reissuedState,
            reason: sql<
                string | null
            >`case when ${refused} and not ${live} and ${groupBillingSubscriptions.dissolveRefusal} like 'paid-period:%' then 'dissolved-paid-period' when ${refused} and not ${live} and ${groupBillingSubscriptions.dissolveRefusal} like 'status:%' then 'dissolved-unknown-status' when ${refused} and not ${live} then 'dissolved-inactive' when ${refused} then 'dissolved-refused' when ${failing} then 'dissolved-failing' else ${groupBillingSubscriptions.reissueStuckReason} end`,
            since: since.mapWith(groupBillingSubscriptions.reissueGaveUpAt),
        })
        .from(groupBillingSubscriptions)
        .where(
            and(
                isNull(groupBillingSubscriptions.endedAt),
                sql`((${groupBillingSubscriptions.reissueGaveUpAt} is not null and ${live}) or ${refused} or ${failing})`,
            ),
        )
        .orderBy(desc(since));
}

/*
 * The statuses after which a subscription can never charge again. Anything else not
 * ended (`active`, `trialing`, `past_due`, `unpaid`, `incomplete`, `paused`) still can.
 */
export const ENDED_SUBSCRIPTION_STATUSES = ['canceled', 'incomplete_expired'] as const;
const ENDED = new Set<string>(ENDED_SUBSCRIPTION_STATUSES);
const canStillCharge = and(
    isNull(groupBillingSubscriptions.endedAt),
    notInArray(groupBillingSubscriptions.status, [...ENDED_SUBSCRIPTION_STATUSES]),
);

/*
 * What says whether setting a plan to end could go differently now: its status, its
 * period and whether it is set to end. A refusal is recorded with it, and the plan is
 * tried again only once it differs (a renewal, a status change, a resume).
 */
export function dissolveStateOf(subscription: {
    status: string;
    currentPeriodEnd: Date | string;
    cancelAtPeriodEnd: boolean;
}) {
    return `${subscription.status}|${new Date(subscription.currentPeriodEnd).toISOString()}|${subscription.cancelAtPeriodEnd}`;
}

/*
 * A dissolved family's subscriptions that can still charge (docs/groups-design.md 3.3), as
 * the mirror holds them: `ending` when set to end at the period's end, how many times
 * HushOS set it so, its state now and the state Polar last refused in, and `mailOwed`
 * when it is set to end, HushOS asked for that in this period, and its payer has not been
 * mailed for this period. Empty for a family that isn't dissolved.
 */
export async function listDissolvedChargeable(groupId: string) {
    const rows = await db
        .select({
            id: groupBillingSubscriptions.id,
            status: groupBillingSubscriptions.status,
            currentPeriodEnd: groupBillingSubscriptions.currentPeriodEnd,
            currentPeriodStart: groupBillingSubscriptions.currentPeriodStart,
            ending: groupBillingSubscriptions.cancelAtPeriodEnd,
            cancels: groupBillingSubscriptions.dissolveCancels,
            askedAt: groupBillingSubscriptions.dissolveCancelledAt,
            mailedPeriodEnd: groupBillingSubscriptions.dissolveMailedPeriodEnd,
            refusedState: groupBillingSubscriptions.dissolveRefusedState,
        })
        .from(groupBillingSubscriptions)
        .innerJoin(groups, eq(groups.id, groupBillingSubscriptions.groupId))
        .where(
            and(
                eq(groupBillingSubscriptions.groupId, groupId),
                isNotNull(groups.dissolvedAt),
                canStillCharge,
            ),
        )
        .orderBy(groupBillingSubscriptions.id);
    return rows.map((row) => ({
        ...row,
        mailOwed:
            row.ending &&
            row.askedAt !== null &&
            row.askedAt.getTime() >= row.currentPeriodStart.getTime() &&
            row.mailedPeriodEnd?.getTime() !== row.currentPeriodEnd.getTime(),
        state: dissolveStateOf({
            status: row.status,
            currentPeriodEnd: row.currentPeriodEnd,
            cancelAtPeriodEnd: row.ending,
        }),
    }));
}

/*
 * HushOS is about to ask Polar to set a dissolved family's plan to end: written before the
 * call, so a set whose answer was lost still owes its payer the mail once Polar shows it.
 */
export async function markDissolveAsked(subscriptionId: string) {
    await db
        .update(groupBillingSubscriptions)
        .set({ dissolveCancelledAt: new Date(), updatedAt: new Date() })
        .where(eq(groupBillingSubscriptions.id, subscriptionId));
}

/* HushOS set a dissolved family's plan to end: one more, and no refusal stands. */
export async function recordDissolveCancel(subscriptionId: string) {
    await db
        .update(groupBillingSubscriptions)
        .set({
            dissolveCancels: sql`${groupBillingSubscriptions.dissolveCancels} + 1`,
            dissolveFailingSince: null,
            dissolveRefusedAt: null,
            dissolveRefusal: null,
            dissolveRefusedState: null,
            updatedAt: new Date(),
        })
        .where(eq(groupBillingSubscriptions.id, subscriptionId));
}

/* Polar refused to set it to end, in `state`: listed for operators until it is set or ends. */
export async function recordDissolveRefusal(
    subscriptionId: string,
    state: string,
    refusal: string,
) {
    await db
        .update(groupBillingSubscriptions)
        .set({
            dissolveRefusedAt: new Date(),
            dissolveRefusal: refusal,
            dissolveRefusedState: state,
            dissolveFailingSince: null,
            updatedAt: new Date(),
        })
        .where(eq(groupBillingSubscriptions.id, subscriptionId));
}

/*
 * A run of the job for a dissolved family failed in a way pg-boss retries: its plans that
 * can still charge and weren't refused are failing, since the first such run (kept by later
 * ones). Whatever the mirror says of their ending, since a run that fails may not have read
 * Polar. Cleared once a plan is set to end, seen ending by a reconcile, or refused.
 */
export async function recordDissolveFailing(groupId: string) {
    await db
        .update(groupBillingSubscriptions)
        .set({
            dissolveFailingSince: sql`coalesce(${groupBillingSubscriptions.dissolveFailingSince}, now())`,
        })
        .where(
            and(
                eq(groupBillingSubscriptions.groupId, groupId),
                canStillCharge,
                isNull(groupBillingSubscriptions.dissolveRefusedAt),
                sql`exists (select 1 from ${groups} where ${groups.id} = ${groupBillingSubscriptions.groupId} and ${groups.dissolvedAt} is not null)`,
            ),
        );
}

/*
 * The plan-ending mail for the period ending at `periodEnd`, claimed: true only for the
 * first claim of that period, so a plan resumed and set to end again mails once.
 */
export async function claimDissolveMail(subscriptionId: string, periodEnd: Date) {
    const rows = await db
        .update(groupBillingSubscriptions)
        .set({ dissolveMailedPeriodEnd: periodEnd })
        .where(
            and(
                eq(groupBillingSubscriptions.id, subscriptionId),
                sql`${groupBillingSubscriptions.dissolveMailedPeriodEnd} is distinct from ${periodEnd.toISOString()}::timestamptz`,
            ),
        )
        .returning({ id: groupBillingSubscriptions.id });
    return rows.length > 0;
}

/* The mail was not sent: the claim goes, so the next run for the family sends it. */
export async function releaseDissolveMail(subscriptionId: string, periodEnd: Date) {
    await db
        .update(groupBillingSubscriptions)
        .set({ dissolveMailedPeriodEnd: null })
        .where(
            and(
                eq(groupBillingSubscriptions.id, subscriptionId),
                sql`${groupBillingSubscriptions.dissolveMailedPeriodEnd} = ${periodEnd.toISOString()}::timestamptz`,
            ),
        );
}

/*
 * A family's lapsed plan whose product the catalogue can't read (archived, or edited so it
 * drops out), as the lapsed-plan lookup found it at Polar: written so the family page names it
 * (and a checkout's confirmation can list it) and so its ending is told as the family's
 * (familyPlanOf). It gives no pool or places. The lookup and every reconcile write it again as
 * Polar has it, ended included, so it leaves the page once ended. Only a row of this family's
 * whose product is unread (`product_name` is its product id) is ever updated: a plan the
 * catalogue once read, whose product an operator has since edited, is left as it was. A live
 * state is written too, so a plan that can charge is never lost (a dissolved family's job ends
 * it, purge waits for it): but such a row is never the family's plan, its places or pool, nor
 * makes its payer one who pays for the family (readablePlan), since its tier can't be read.
 */
export async function recordUnreadGroupSubscription(
    groupId: string,
    input: {
        id: string;
        productId: string;
        status: string;
        recurringInterval: string;
        amount: number | null;
        currency: string | null;
        units: number;
        currentPeriodStart: Date;
        currentPeriodEnd: Date;
        cancelAtPeriodEnd: boolean;
        endedAt: Date | null;
    },
) {
    const { id: _id, ...state } = input;
    await db
        .insert(groupBillingSubscriptions)
        .values({
            ...input,
            groupId,
            provider: 'polar',
            productName: input.productId,
            includedMembers: 1,
            quotaBytes: 0n,
            paidUnits: 0,
            paidQuotaBytes: 0n,
        })
        .onConflictDoUpdate({
            target: groupBillingSubscriptions.id,
            set: { ...state, updatedAt: new Date() },
            setWhere: and(
                eq(groupBillingSubscriptions.groupId, groupId),
                eq(groupBillingSubscriptions.productName, groupBillingSubscriptions.productId),
            ),
        });
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
                // A plan seen live (paid in the portal, resumed) or ended is no lapsed plan left
                // unended: its refusal leaves the operators' list.
                ...(LAPSED_STATUSES.includes(subscription.status) && !subscription.endedAt
                    ? {}
                    : { lapsedRevokeRefusal: null, lapsedRevokeRefusedAt: null }),
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
                        // Seen ending: a dissolved family's plan is no longer failing to be set so.
                        ...(subscription.cancelAtPeriodEnd || subscription.endedAt
                            ? { dissolveFailingSince: null }
                            : {}),
                        updatedAt: now,
                    },
                });
        }
        // Kept as not ended: every subscription Polar just answered for that it hasn't ended
        // itself (no `ended_at`, not `canceled` or `incomplete_expired`), whatever its status:
        // `paused`, `unpaid` and `incomplete` too, which can still charge, so a dissolved
        // family's job and purge see them. They give no pool or places (liveGroupSubscription
        // below). What Polar no longer lists, or has ended without saying when, ends here.
        const keptIds = input.subscriptions
            .filter((subscription) => !subscription.endedAt && !ENDED.has(subscription.status))
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
                        keptIds.length
                            ? notInArray(groupBillingSubscriptions.id, keptIds)
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
        // Under the pool lock, as every upload's check takes it, even for a group whose first
        // plan this is (no row to lock yet).
        await takePoolLock(tx, input.groupId);
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
 * What the family stores, as the pool counts it (pool.ts PoolPart): its folders
 * together and every pooled member's own files, each part rounded up to a whole
 * GiB on its own. `used` is that count, what the summary shows and the downgrade
 * and first-purchase guards compare with a tier; never the exact total, which
 * would tell a payer another member's bytes. Uploads in flight are apart: the
 * summary shows what is stored, the upload check counts both.
 */
export async function getPoolUsage(groupId: string) {
    const usage = await poolUsage(db, groupId);
    return { used: usage.counted, reserved: usage.reserved };
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

/*
 * A family's plans Polar still holds that give nothing: not ended, and `unpaid`,
 * `incomplete` or `paused`. A family checkout (and with it a payer takeover) revokes
 * each first, so a payment or a resume later can't run one beside the new plan.
 */
export async function listLapsedGroupSubscriptionIds(groupId: string) {
    const rows = await db
        .select({ id: groupBillingSubscriptions.id })
        .from(groupBillingSubscriptions)
        .where(
            and(
                eq(groupBillingSubscriptions.groupId, groupId),
                isNull(groupBillingSubscriptions.endedAt),
                inArray(groupBillingSubscriptions.status, LAPSED_STATUSES),
            ),
        );
    return rows.map((row) => row.id);
}

/*
 * The family's newest plan that Polar still holds but that gives nothing (its payment
 * failed, or it is paused), for the family page while no plan is live; null otherwise.
 */
export async function getLapsedGroupSubscription(groupId: string) {
    const [row] = await db
        .select({
            id: groupBillingSubscriptions.id,
            productId: groupBillingSubscriptions.productId,
            productName: groupBillingSubscriptions.productName,
            status: groupBillingSubscriptions.status,
        })
        .from(groupBillingSubscriptions)
        .where(
            and(
                eq(groupBillingSubscriptions.groupId, groupId),
                isNull(groupBillingSubscriptions.endedAt),
                inArray(groupBillingSubscriptions.status, LAPSED_STATUSES),
            ),
        )
        .orderBy(desc(groupBillingSubscriptions.currentPeriodEnd))
        .limit(1);
    return row ?? null;
}

/*
 * The one rule that tells a family's plan ending from a person's (both live in
 * personal_plan_endings, worked by the same job): a family's subscription has a row in the
 * family mirror, group_billing_subscriptions, and its ending is keyed by the family's id.
 * The family whose plan this subscription is, or null for a person's.
 */
export async function familyPlanOf(subscriptionId: string) {
    const [row] = await db
        .select({ groupId: groupBillingSubscriptions.groupId })
        .from(groupBillingSubscriptions)
        .where(eq(groupBillingSubscriptions.id, subscriptionId));
    return row ? { groupId: row.groupId } : null;
}

/* Whether an ending's owner id (personal_plan_endings.user_id) is a family's, by the same rule. */
export async function isFamilyOwner(ownerId: string) {
    const [row] = await db
        .select({ id: groupBillingSubscriptions.id })
        .from(groupBillingSubscriptions)
        .where(eq(groupBillingSubscriptions.groupId, ownerId))
        .limit(1);
    return row !== undefined;
}

/*
 * A lapsed family plan HushOS couldn't revoke, and why (null once a revoke landed): what the
 * operators' list of blocked revokes reads.
 */
export async function recordLapsedRevokeRefusal(subscriptionId: string, refusal: string | null) {
    await db
        .update(groupBillingSubscriptions)
        .set({
            lapsedRevokeRefusal: refusal,
            lapsedRevokeRefusedAt: refusal === null ? null : sql`now()`,
            updatedAt: new Date(),
        })
        .where(eq(groupBillingSubscriptions.id, subscriptionId));
}

/* Lapsed family plans HushOS couldn't revoke that haven't ended: the operators' list. Ids only. */
export async function listLapsedRevokeRefusals() {
    return db
        .select({
            groupId: groupBillingSubscriptions.groupId,
            subscriptionId: groupBillingSubscriptions.id,
            status: groupBillingSubscriptions.status,
            refusal: groupBillingSubscriptions.lapsedRevokeRefusal,
            since: groupBillingSubscriptions.lapsedRevokeRefusedAt,
        })
        .from(groupBillingSubscriptions)
        .where(
            and(
                isNotNull(groupBillingSubscriptions.lapsedRevokeRefusedAt),
                isNull(groupBillingSubscriptions.endedAt),
            ),
        )
        .orderBy(desc(groupBillingSubscriptions.lapsedRevokeRefusedAt));
}

/*
 * Every family and every person with more than one subscription that can still charge
 * (not ended, not `canceled` or `incomplete_expired`): live, or lapsed but able to come
 * back. A live plan already set to end at its period's end is left out: it charges no more
 * unless resumed, and a resume shows it here again at the next reconcile. Two such plans are a double charge waiting to happen; checkouts revoke a lapsed
 * one first, so any row here is something that slipped past them, for an operator to
 * look at in Polar. Ids and statuses only.
 */
export async function listDoubleCharging() {
    const families = await db
        .select({
            id: groupBillingSubscriptions.groupId,
            subscriptions: sql<
                { id: string; status: string }[]
            >`json_agg(json_build_object('id', ${groupBillingSubscriptions.id}, 'status', ${groupBillingSubscriptions.status}) order by ${groupBillingSubscriptions.id})`,
        })
        .from(groupBillingSubscriptions)
        .where(
            and(
                canStillCharge,
                // A live plan set to end at its period's end charges no more (a resume brings it back).
                sql`not (${groupBillingSubscriptions.cancelAtPeriodEnd} and ${groupBillingSubscriptions.status} in ('active', 'trialing', 'past_due'))`,
            ),
        )
        .groupBy(groupBillingSubscriptions.groupId)
        .having(sql`count(*) > 1`)
        .orderBy(groupBillingSubscriptions.groupId);
    const people = await db
        .select({
            id: billingSubscriptions.userId,
            subscriptions: sql<
                { id: string; status: string }[]
            >`json_agg(json_build_object('id', ${billingSubscriptions.id}, 'status', ${billingSubscriptions.status}) order by ${billingSubscriptions.id})`,
        })
        .from(billingSubscriptions)
        .where(
            and(
                isNull(billingSubscriptions.endedAt),
                notInArray(billingSubscriptions.status, [...ENDED_SUBSCRIPTION_STATUSES]),
                sql`not (${billingSubscriptions.cancelAtPeriodEnd} and ${billingSubscriptions.status} in ('active', 'trialing', 'past_due'))`,
            ),
        )
        .groupBy(billingSubscriptions.userId)
        .having(sql`count(*) > 1`)
        .orderBy(billingSubscriptions.userId);
    return [
        ...families.map((row) => ({ kind: 'family' as const, ...row })),
        ...people.map((row) => ({ kind: 'person' as const, ...row })),
    ];
}

/* ------------------------------------------------------------------------- */
/* Ending a pooled member's personal plan (docs/families-shared-pool.md 5.1)  */
/* ------------------------------------------------------------------------- */

/* The family `userId`'s own files draw from now (pool.ts pooledFamilyOf), or null. */
export async function getPooledFamily(userId: string) {
    return pooledFamilyOf(db, userId);
}

/* Each active member's own stored bytes and the family folders' total, exact (pool.ts memberUsage). */
export async function getMemberUsage(groupId: string) {
    return memberUsage(db, groupId);
}

/*
 * People whose own files draw from a family's live pool while the mirror still
 * holds a live or lapsed (unpaid, incomplete, paused) personal subscription of
 * theirs: every one of them is owed the end of that plan. One family's, or every
 * family's (the daily reconcile).
 */
export async function listPooledWithPersonalPlan(groupId?: string) {
    const rows = await db
        .selectDistinct({ userId: groupMemberships.userId })
        .from(groupMemberships)
        .innerJoin(groupStorage, eq(groupStorage.groupId, groupMemberships.groupId))
        .innerJoin(billingSubscriptions, eq(billingSubscriptions.userId, groupMemberships.userId))
        .where(
            and(
                groupId ? eq(groupMemberships.groupId, groupId) : undefined,
                eq(groupMemberships.groupKind, 'family'),
                eq(groupMemberships.state, 'active'),
                sql`${groupStorage.expiresAt} > ${new Date().toISOString()}::timestamptz`,
                isNull(billingSubscriptions.endedAt),
                inArray(billingSubscriptions.status, [...LIVE_STATUSES, ...LAPSED_STATUSES]),
            ),
        );
    return rows.map((row) => row.userId);
}

export type PlanEnding = typeof personalPlanEndings.$inferSelect;
export type PlanRefund = typeof personalPlanRefunds.$inferSelect;

/*
 * The ending of one personal subscription, made the first time it is asked for. A
 * later call never moves it to another membership; it only keeps the earliest time
 * HushOS saw its owner pooled.
 */
export async function ensurePlanEnding(input: {
    subscriptionId: string;
    userId: string;
    groupId: string;
    admittedAt: Date;
    pooledAt: Date;
}) {
    const [row] = await db
        .insert(personalPlanEndings)
        .values(input)
        .onConflictDoUpdate({
            target: personalPlanEndings.subscriptionId,
            // A plan left alone because its owner left before it was revoked (`dropped`) is
            // theirs until they are pooled again: then it is ended for the new membership.
            set: {
                groupId: sql`case when ${personalPlanEndings.outcome} = 'dropped' then excluded.group_id else ${personalPlanEndings.groupId} end`,
                admittedAt: sql`case when ${personalPlanEndings.outcome} = 'dropped' then excluded.admitted_at else ${personalPlanEndings.admittedAt} end`,
                pooledAt: sql`case when ${personalPlanEndings.outcome} = 'dropped' then excluded.pooled_at else least(${personalPlanEndings.pooledAt}, excluded.pooled_at) end`,
                outcome: sql`case when ${personalPlanEndings.outcome} = 'dropped' then null else ${personalPlanEndings.outcome} end`,
                updatedAt: new Date(),
            },
        })
        .returning();
    return row!;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/* A refund row noted (a payment delivery) and never asked for: no run has worked it. */
const unworkedRefund = (subscriptionId: string) =>
    and(
        eq(personalPlanRefunds.subscriptionId, subscriptionId),
        eq(personalPlanRefunds.status, 'requested'),
        isNull(personalPlanRefunds.firstAttemptedAt),
    );

/*
 * Settles a plan's unworked refund rows as `none` (nothing owed on them); `kept`: they are
 * its owner's, their rewards still to grant (`rewards_pending`). Returns their orders.
 */
async function clearUnworkedRefunds(tx: Tx, subscriptionId: string, kept = false) {
    const rows = await tx
        .update(personalPlanRefunds)
        .set({ status: 'none', rewardsPending: kept, updatedAt: new Date() })
        .where(unworkedRefund(subscriptionId))
        .returning({ orderId: personalPlanRefunds.orderId });
    return rows.map((row) => row.orderId);
}

/*
 * The ending of a lapsed personal plan (unpaid, incomplete, paused) HushOS is about to
 * revoke itself, before a checkout or because its owner was pooled: one with no family,
 * written before Polar is asked, so a revoke whose answer is lost and a payment that lands
 * meanwhile still find it. Settled, since nothing of it is in force: a payment Polar takes
 * for it afterwards opens it again (notePaidOnLapsed), and the plan-ending job refunds that
 * order whole. `revoked_at` is set once Polar's answer says when (recordPlanRevoked).
 * Taken over: one its owner's leaving dropped, and an earlier lapsed one whose revoke never
 * landed (no family, not revoked, settled); their unworked refund rows are settled `none`
 * first, so nothing from before is refunded under the new one. Any other ending the plan
 * has is left as it is. Written only with the ending's lease, taken for `owner` in the same
 * write; one another run holds is left untouched. Returns the plan's ending as it stands
 * and whether this call holds it now.
 */
export async function beginLapsedRevoke(input: {
    subscriptionId: string;
    userId: string;
    at: Date;
    /* The run setting out to revoke it: the ending's lease is taken for it in the same write. */
    owner: string;
    leaseMs: number;
}) {
    return db.transaction(async (tx) => {
        const [existing] = await tx
            .select({
                row: personalPlanEndings,
                leasedByOther: sql<boolean>`${personalPlanEndings.leaseUntil} > now() and ${personalPlanEndings.leaseOwner} is distinct from ${input.owner}`,
            })
            .from(personalPlanEndings)
            .where(eq(personalPlanEndings.subscriptionId, input.subscriptionId))
            .for('update');
        const lease = {
            leaseOwner: input.owner,
            leaseUntil: sql`now() + make_interval(secs => ${input.leaseMs / 1000})`,
        };
        const fresh = {
            groupId: null,
            admittedAt: input.at,
            pooledAt: input.at,
            revokedAt: null,
            periodStart: null,
            periodEnd: null,
            outcome: 'settled',
            unrefundableAmount: null,
            unrefundableCurrency: null,
        };
        if (!existing) {
            const [row] = await tx
                .insert(personalPlanEndings)
                .values({
                    subscriptionId: input.subscriptionId,
                    userId: input.userId,
                    ...fresh,
                    ...lease,
                })
                .returning();
            return { ending: row!, leased: true };
        }
        // Another run holds it: nothing is written, not even a takeover's times.
        if (existing.leasedByOther) return { ending: existing.row, leased: false };
        const takeOver =
            existing.row.outcome === 'dropped' ||
            (existing.row.groupId === null &&
                !existing.row.revokedAt &&
                existing.row.outcome === 'settled');
        if (!takeOver) return { ending: existing.row, leased: false };
        await clearUnworkedRefunds(tx, input.subscriptionId);
        const [row] = await tx
            .update(personalPlanEndings)
            .set({ ...fresh, ...lease, updatedAt: new Date() })
            .where(eq(personalPlanEndings.subscriptionId, input.subscriptionId))
            .returning();
        return { ending: row!, leased: true };
    });
}

/*
 * An ending HushOS gives up on: the plan stays its owner's (they left the family before
 * it was revoked, or a lapsed plan's revoke never landed). Its unworked refund rows are
 * settled `none` in the same transaction, never refunded by a later lapsed ending of the
 * plan, and marked `rewards_pending`: their commission and referral reward, which the
 * payment delivery held back, are still owed (grantKeptRewards), so a failure granting
 * them loses nothing, and a family ending that later refunds part of the order (moving
 * its status on) doesn't erase them. Returns those rows' orders.
 */
export async function dropPlanEnding(subscriptionId: string) {
    return db.transaction(async (tx) => {
        await tx
            .update(personalPlanEndings)
            .set({ outcome: 'dropped', updatedAt: new Date() })
            .where(eq(personalPlanEndings.subscriptionId, subscriptionId));
        return clearUnworkedRefunds(tx, subscriptionId, true);
    });
}

/* Payments kept by their owner whose rewards are still to grant, this person's. */
export async function listKeptPayments(userId: string) {
    return db
        .select({
            orderId: personalPlanRefunds.orderId,
            subscriptionId: personalPlanRefunds.subscriptionId,
        })
        .from(personalPlanRefunds)
        .innerJoin(
            personalPlanEndings,
            eq(personalPlanEndings.subscriptionId, personalPlanRefunds.subscriptionId),
        )
        .where(
            and(
                eq(personalPlanEndings.userId, userId),
                eq(personalPlanRefunds.rewardsPending, true),
            ),
        );
}

/* People with a kept payment whose rewards are still to grant: the daily reconcile's. */
export async function listUsersWithKeptPayments() {
    const rows = await db
        .selectDistinct({ userId: personalPlanEndings.userId })
        .from(personalPlanRefunds)
        .innerJoin(
            personalPlanEndings,
            eq(personalPlanEndings.subscriptionId, personalPlanRefunds.subscriptionId),
        )
        .where(eq(personalPlanRefunds.rewardsPending, true));
    return rows.map((row) => row.userId);
}

/* A kept payment's rewards are granted: nothing more to do on it. */
export async function settleKeptPayment(orderId: string) {
    await db
        .update(personalPlanRefunds)
        .set({ rewardsPending: false, updatedAt: new Date() })
        .where(eq(personalPlanRefunds.orderId, orderId));
}

/*
 * Gives a plan's refund rows that were never asked for the keys of the ending now working
 * it (a family's, taking over one a lapsed revoke dropped), so its refunds carry, and are
 * matched by, that ending's key.
 */
export async function rekeyUnattemptedRefunds(rows: { orderId: string; refundKey: string }[]) {
    for (const row of rows)
        await db
            .update(personalPlanRefunds)
            .set({ refundKey: row.refundKey, updatedAt: new Date() })
            .where(
                and(
                    eq(personalPlanRefunds.orderId, row.orderId),
                    isNull(personalPlanRefunds.firstAttemptedAt),
                ),
            );
}

/*
 * The orders of a lapsed plan already paid when HushOS revokes it, noted `none`: never
 * refunded, even when an `order.paid` for one arrives late. One noted earlier and never
 * worked (a payment delivery before the takeover) is settled `none` too.
 */
export async function notePaidBeforeRevoke(
    rows: { orderId: string; subscriptionId: string; refundKey: string; currency: string }[],
) {
    for (const row of rows)
        await db
            .insert(personalPlanRefunds)
            .values({ ...row, amount: 0, status: 'none' })
            .onConflictDoUpdate({
                target: personalPlanRefunds.orderId,
                // Noted for a refund by its `order.paid`, which then held its rewards back: kept
                // after all, so they are owed (`rewardsPending`, granted by the job once).
                set: { status: 'none', rewardsPending: true, updatedAt: new Date() },
                where: and(
                    eq(personalPlanRefunds.subscriptionId, row.subscriptionId),
                    eq(personalPlanRefunds.status, 'requested'),
                    isNull(personalPlanRefunds.firstAttemptedAt),
                ),
            });
}

/*
 * An `order.paid` for a plan with a lapsed ending (no family), in one transaction: the
 * order noted for a refund and the ending opened again. `noted`: noted now, or noted
 * before and never worked (a redelivery after the first try failed midway), either way
 * open now. `worked`: refunded or being refunded already. `paid-before`: it was paid when
 * HushOS revoked the plan. `none`: no lapsed ending (or a dropped one) to note it on.
 */
export async function notePaidOnLapsed(input: {
    orderId: string;
    subscriptionId: string;
    refundKey: string;
    currency: string;
}): Promise<'noted' | 'worked' | 'paid-before' | 'none'> {
    return db.transaction(async (tx) => {
        const [ending] = await tx
            .select()
            .from(personalPlanEndings)
            .where(eq(personalPlanEndings.subscriptionId, input.subscriptionId))
            .for('update');
        if (!ending || ending.groupId !== null || ending.outcome === 'dropped') return 'none';
        const [row] = await tx
            .select()
            .from(personalPlanRefunds)
            .where(eq(personalPlanRefunds.orderId, input.orderId));
        if (row?.status === 'none') return 'paid-before';
        if (row && (row.status !== 'requested' || row.firstAttemptedAt)) return 'worked';
        if (!row)
            await tx
                .insert(personalPlanRefunds)
                .values({ ...input, amount: 0, status: 'requested' });
        await tx
            .update(personalPlanEndings)
            .set({ outcome: null, updatedAt: new Date() })
            .where(
                and(
                    eq(personalPlanEndings.subscriptionId, input.subscriptionId),
                    eq(personalPlanEndings.outcome, 'settled'),
                ),
            );
        return 'noted';
    });
}

/* Endings with work left for this person, oldest first. */
export async function listOpenPlanEndings(userId: string) {
    return db
        .select()
        .from(personalPlanEndings)
        .where(and(eq(personalPlanEndings.userId, userId), isNull(personalPlanEndings.outcome)))
        .orderBy(personalPlanEndings.createdAt);
}

/* People with an ending not yet settled: the daily reconcile queues each again. */
export async function listUsersWithOpenPlanEndings() {
    const rows = await db
        .selectDistinct({ userId: personalPlanEndings.userId })
        .from(personalPlanEndings)
        .where(isNull(personalPlanEndings.outcome));
    return rows.map((row) => row.userId);
}

/*
 * Stores when Polar ended the plan and the period it was in, the first time only:
 * a retry an hour later prorates from the same instant. Returns the row as stored.
 */
export async function recordPlanRevoked(
    subscriptionId: string,
    input: { revokedAt: Date; periodStart: Date; periodEnd: Date },
) {
    await db
        .update(personalPlanEndings)
        .set({ ...input, updatedAt: new Date() })
        .where(
            and(
                eq(personalPlanEndings.subscriptionId, subscriptionId),
                isNull(personalPlanEndings.revokedAt),
            ),
        );
    const [row] = await db
        .select()
        .from(personalPlanEndings)
        .where(eq(personalPlanEndings.subscriptionId, subscriptionId));
    return row!;
}

/*
 * Closes an ending. `settled` only while no refund of it is still unworked (noted,
 * `requested`, never asked for): an order a payment delivery noted while the run that
 * settles it was already past reading the orders keeps the ending open, for that run's
 * retry. Returns whether it closed.
 */
export async function closePlanEnding(subscriptionId: string, outcome: 'settled' | 'ended') {
    const rows = await db
        .update(personalPlanEndings)
        .set({ outcome, updatedAt: new Date() })
        .where(
            and(
                eq(personalPlanEndings.subscriptionId, subscriptionId),
                outcome === 'settled'
                    ? sql`not exists (select 1 from ${personalPlanRefunds} where ${unworkedRefund(subscriptionId)})`
                    : undefined,
            ),
        )
        .returning({ subscriptionId: personalPlanEndings.subscriptionId });
    return rows.length > 0;
}

export async function getPlanRefund(orderId: string) {
    const [row] = await db
        .select()
        .from(personalPlanRefunds)
        .where(eq(personalPlanRefunds.orderId, orderId));
    return row ?? null;
}

/*
 * Written before Polar is asked, with the key and amount, so the operators' list can
 * name a refund that never lands; made once, its amount kept current (setPlanRefundAmount).
 */
export async function notePlanRefund(input: {
    orderId: string;
    subscriptionId: string;
    refundKey: string;
    amount: number;
    currency: string;
    status?: 'requested' | 'none';
}) {
    await db
        .insert(personalPlanRefunds)
        .values({ ...input, status: input.status ?? 'requested' })
        .onConflictDoNothing();
}

/* What HushOS means to have refunded on the order in all, as this run computed it. */
export async function setPlanRefundAmount(orderId: string, amount: number) {
    await db
        .update(personalPlanRefunds)
        .set({ amount, updatedAt: new Date() })
        .where(eq(personalPlanRefunds.orderId, orderId));
}

/* Stamped just before Polar is asked, on the database's clock: the first ask once, the last every time. */
export async function markPlanRefundAttempt(orderId: string) {
    await db
        .update(personalPlanRefunds)
        .set({
            firstAttemptedAt: sql`coalesce(${personalPlanRefunds.firstAttemptedAt}, now())`,
            lastAttemptedAt: sql`now()`,
            updatedAt: sql`now()`,
        })
        .where(eq(personalPlanRefunds.orderId, orderId));
}

/*
 * An ask whose outcome is unknown (a timeout, a 5xx): nothing is asked again for `ms`
 * after it, on the database's clock, since Polar may still make that refund.
 */
export async function markPlanRefundUnsure(orderId: string, ms: number) {
    await db
        .update(personalPlanRefunds)
        .set({ unsureUntil: sql`now() + make_interval(secs => ${ms / 1000})` })
        .where(eq(personalPlanRefunds.orderId, orderId));
}

/* Whether an unknown outcome still holds the next ask back (markPlanRefundUnsure). */
export async function planRefundUnsure(orderId: string) {
    const [row] = await db
        .select({ unsure: sql<boolean>`${personalPlanRefunds.unsureUntil} > now()` })
        .from(personalPlanRefunds)
        .where(eq(personalPlanRefunds.orderId, orderId));
    return row?.unsure === true;
}

/*
 * What Polar won't refund of an ending's unused part, as the last run computed it
 * (null once nothing is): listed for operators.
 */
export async function setPlanUnrefundable(
    subscriptionId: string,
    amount: number | null,
    currency: string | null,
) {
    await db
        .update(personalPlanEndings)
        .set({ unrefundableAmount: amount, unrefundableCurrency: currency, updatedAt: new Date() })
        .where(eq(personalPlanEndings.subscriptionId, subscriptionId));
}

/* Endings whose unused part Polar won't fully refund: the operators' list. Ids only. */
export async function listUnrefundable() {
    return db
        .select({
            subscriptionId: personalPlanEndings.subscriptionId,
            userId: personalPlanEndings.userId,
            groupId: personalPlanEndings.groupId,
            /* The family whose own plan this is (its ending's `userId` is then the family's id). */
            planOfGroupId: groupBillingSubscriptions.groupId,
            amount: personalPlanEndings.unrefundableAmount,
            currency: personalPlanEndings.unrefundableCurrency,
            since: personalPlanEndings.updatedAt,
        })
        .from(personalPlanEndings)
        .leftJoin(
            groupBillingSubscriptions,
            eq(groupBillingSubscriptions.id, personalPlanEndings.subscriptionId),
        )
        .where(sql`${personalPlanEndings.unrefundableAmount} > 0`)
        .orderBy(desc(personalPlanEndings.updatedAt));
}

/*
 * Takes the ending for `owner` for `ms` (the database's clock, as claimPlanChange
 * does, so worker hosts whose clocks differ can't take it early), when nobody holds
 * it, its holder's time ran out, or `owner` holds it already: true when taken. Two
 * runs for one person never work one ending at once, and a run that stalled past its
 * lease finds it gone (renewPlanEndingLease) before it asks Polar for anything more.
 * Plain rows, so it holds behind a transaction-mode pooler and survives a dropped
 * connection.
 */
export async function takePlanEndingLease(subscriptionId: string, owner: string, ms: number) {
    const rows = await db
        .update(personalPlanEndings)
        .set({
            leaseOwner: owner,
            leaseUntil: sql`now() + make_interval(secs => ${ms / 1000})`,
        })
        .where(
            and(
                eq(personalPlanEndings.subscriptionId, subscriptionId),
                sql`(${personalPlanEndings.leaseUntil} is null or ${personalPlanEndings.leaseUntil} <= now() or ${personalPlanEndings.leaseOwner} = ${owner})`,
            ),
        )
        .returning({ subscriptionId: personalPlanEndings.subscriptionId });
    return rows.length === 1;
}

/* Extends the lease only while `owner` still holds it and it hasn't run out: false otherwise. */
export async function renewPlanEndingLease(subscriptionId: string, owner: string, ms: number) {
    const rows = await db
        .update(personalPlanEndings)
        .set({ leaseUntil: sql`now() + make_interval(secs => ${ms / 1000})` })
        .where(
            and(
                eq(personalPlanEndings.subscriptionId, subscriptionId),
                eq(personalPlanEndings.leaseOwner, owner),
                sql`${personalPlanEndings.leaseUntil} > now()`,
            ),
        )
        .returning({ subscriptionId: personalPlanEndings.subscriptionId });
    return rows.length === 1;
}

/* Lets the lease go, if `owner` still holds it. */
export async function releasePlanEndingLease(subscriptionId: string, owner: string) {
    await db
        .update(personalPlanEndings)
        .set({ leaseOwner: null, leaseUntil: null })
        .where(
            and(
                eq(personalPlanEndings.subscriptionId, subscriptionId),
                eq(personalPlanEndings.leaseOwner, owner),
            ),
        );
}

/*
 * What Polar holds for the refund now: `pending` or `succeeded` clears the count of
 * failures (and the Refunds owed listing); `none` for nothing to refund.
 */
export async function settlePlanRefund(
    orderId: string,
    input: { status: 'pending' | 'succeeded' | 'none'; providerRefundId?: string | null },
) {
    await db
        .update(personalPlanRefunds)
        .set({
            status: input.status,
            providerRefundId: input.providerRefundId ?? null,
            failures: 0,
            owedSince: null,
            unsureUntil: null,
            updatedAt: new Date(),
        })
        .where(eq(personalPlanRefunds.orderId, orderId));
}

/* Endings settled within the last `days` (by their last write): their refunds are read again. */
export async function listRecentlySettledEndings(days: number) {
    return db
        .select()
        .from(personalPlanEndings)
        .where(
            and(
                eq(personalPlanEndings.outcome, 'settled'),
                sql`${personalPlanEndings.updatedAt} > now() - make_interval(days => ${days})`,
            ),
        );
}

export async function getPlanEnding(subscriptionId: string) {
    const [row] = await db
        .select()
        .from(personalPlanEndings)
        .where(eq(personalPlanEndings.subscriptionId, subscriptionId));
    return row ?? null;
}

/* A settled ending whose refund failed afterwards: open again, so its job places it again. */
export async function reopenPlanEnding(subscriptionId: string) {
    await db
        .update(personalPlanEndings)
        .set({ outcome: null, updatedAt: new Date() })
        .where(
            and(
                eq(personalPlanEndings.subscriptionId, subscriptionId),
                eq(personalPlanEndings.outcome, 'settled'),
            ),
        );
}

/* The order's charge is disputed: its share is dropped for good, never moved. */
export async function markPlanRefundDisputed(orderId: string) {
    await db
        .update(personalPlanRefunds)
        .set({ status: 'disputed', amount: 0, unsureUntil: null, updatedAt: new Date() })
        .where(eq(personalPlanRefunds.orderId, orderId));
}

/*
 * A try that failed (Polar refused, could not be reached, or its refund failed): one
 * more in a row. At `owedAfter` in a row it is listed under Refunds owed, from then
 * until it lands. Returns the count.
 */
export async function failPlanRefund(orderId: string, owedAfter: number) {
    const now = new Date();
    const [row] = await db
        .update(personalPlanRefunds)
        .set({
            status: 'failed',
            failures: sql`${personalPlanRefunds.failures} + 1`,
            owedSince: sql`case when ${personalPlanRefunds.failures} + 1 >= ${owedAfter} then coalesce(${personalPlanRefunds.owedSince}, ${now.toISOString()}::timestamptz) else ${personalPlanRefunds.owedSince} end`,
            updatedAt: now,
        })
        .where(eq(personalPlanRefunds.orderId, orderId))
        .returning({ failures: personalPlanRefunds.failures });
    return row?.failures ?? 0;
}

export async function listPlanRefunds(subscriptionId: string) {
    return db
        .select()
        .from(personalPlanRefunds)
        .where(eq(personalPlanRefunds.subscriptionId, subscriptionId));
}

/*
 * Refunds HushOS has failed to make several times in a row: the operators' list. Ids only.
 * `groupId` names the family for a refund on a family's plan (its ending's `userId` is then
 * the family's id too); null for a person's plan.
 */
export async function listRefundsOwed() {
    return db
        .select({
            orderId: personalPlanRefunds.orderId,
            subscriptionId: personalPlanRefunds.subscriptionId,
            userId: personalPlanEndings.userId,
            groupId: groupBillingSubscriptions.groupId,
            amount: personalPlanRefunds.amount,
            currency: personalPlanRefunds.currency,
            failures: personalPlanRefunds.failures,
            since: personalPlanRefunds.owedSince,
        })
        .from(personalPlanRefunds)
        .innerJoin(
            personalPlanEndings,
            eq(personalPlanEndings.subscriptionId, personalPlanRefunds.subscriptionId),
        )
        .leftJoin(
            groupBillingSubscriptions,
            eq(groupBillingSubscriptions.id, personalPlanRefunds.subscriptionId),
        )
        .where(isNotNull(personalPlanRefunds.owedSince))
        .orderBy(personalPlanRefunds.owedSince);
}
