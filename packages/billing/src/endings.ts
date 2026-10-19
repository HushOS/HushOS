import { billingRepository } from '@hushos/db';
import { log } from '@hushos/logging';
import type { PolarClientError } from '@polar-sh/sdk';
import type { models } from '@polar-sh/sdk/2026-10';
import { billingEnabled, getCatalogue, polar, statusOf } from './provider';

/*
 * Ending the personal plan of someone whose own files joined a family's pool
 * (docs/families-shared-pool.md 3.3, 5.1, owner decision 2). Their plan ends at
 * Polar at once (`subscriptions.revoke`) and the unused part of what they paid
 * for the current period is refunded, prorated, through Polar's refunds API.
 *
 * What Polar documents, and what it doesn't (checked 19 October 2026):
 * - `DELETE /v1/subscriptions/{id}` revokes now; 403 `AlreadyCanceledSubscription`
 *   ("This subscription is already revoked"), 404, 409 `SubscriptionLocked`.
 *   Polar's own code lets a subscription set to cancel at the period's end be
 *   revoked; the 403 comes only for one already ended (or never billable).
 * - `POST /v1/refunds/` takes `amount` in minor units, capped at the order's net
 *   amount (after discounts, before tax) less what it has refunded; Polar refunds
 *   the matching tax itself, prorated. 403 `RefundedAlready` for an order refunded
 *   whole. No idempotency key is documented, so HushOS keys refunds itself, in
 *   their metadata, and lists the order's refunds before every call.
 * - Refund statuses are `pending`, `succeeded`, `failed`, `canceled`. Whether a
 *   pending or failed refund counts in the order's `refunded_amount` is not
 *   documented, so HushOS never infers its own refunds from that figure: it
 *   matches them by key, and counts other refunds only as Polar lists them.
 * - Polar keeps its fee on a refunded order; HushOS bears it.
 */

/* Failed tries in a row before a refund is listed for operators under Refunds owed. */
export const REFUND_FAILURES_BEFORE_OWED = 5;

/* The refund's metadata key that carries HushOS's own key for it. */
export const REFUND_METADATA_KEY = 'hushos_refund';

/* The orders that pay for a period: a checkout, a renewal, a mid-period change. */
const PERIOD_REASONS = new Set([
    'subscription_create',
    'subscription_cycle',
    'subscription_update',
]);

/*
 * A checkout or renewal order made up to this long before the period it pays for
 * began still pays for it (Polar's clock and the subscription's period start are
 * not one instant). A change order must fall inside the period.
 */
const PERIOD_SLACK_MS = 60 * 60 * 1000;

export type EndPersonalPlanJob = {
    userId: string;
    /* The membership that pooled them, and when HushOS saw them pooled. */
    groupId: string;
    admittedAt: string;
    seenAt: string;
};

type Queue = (job: EndPersonalPlanJob) => Promise<unknown>;
let queue: Queue | undefined;

/*
 * Where `billing.end-personal-plan` jobs go (pg-boss, a `stately` queue keyed by
 * the user): set by the web app and the worker, as the cut retries are.
 */
export function setEndPersonalPlanQueue(next: Queue | undefined) {
    queue = next;
}

async function send(job: EndPersonalPlanJob) {
    if (!queue) {
        log.warn({ message: 'No queue for ending personal plans', billing: { user: job.userId } });
        return false;
    }
    try {
        await queue(job);
        return true;
    } catch (error) {
        // The daily reconcile queues it again.
        log.warn({
            message: 'Ending a personal plan could not be queued',
            billing: { user: job.userId, failure: String((error as Error)?.name) },
        });
        return false;
    }
}

/*
 * Queues the end of `userId`'s personal plan when their own files draw from a
 * family's live pool and HushOS holds a live personal subscription of theirs
 * (or `force`: an order Polar just reported paid). Never throws: the admission,
 * webhook or reconcile that asks has done its own work, and the daily reconcile
 * asks again.
 */
export async function queuePlanEnding(userId: string, options: { force?: boolean } = {}) {
    if (!billingEnabled()) return false;
    try {
        const family = await billingRepository.getPooledFamily(userId);
        if (!family) return false;
        if (!options.force && !(await billingRepository.listLiveSubscriptionIds(userId)).length)
            return false;
        return await send({
            userId,
            groupId: family.groupId,
            admittedAt: family.admittedAt.toISOString(),
            seenAt: new Date().toISOString(),
        });
    } catch (error) {
        log.warn({
            message: 'Ending a personal plan could not be queued',
            billing: { user: userId, failure: String((error as Error)?.name) },
        });
        return false;
    }
}

/*
 * The daily reconcile's part (5.1): everyone pooled with a live personal plan in
 * the mirror (a lost job, a checkout that raced the admission), and everyone
 * with an ending not yet settled (a refund still pending at Polar is checked
 * again; a failed one is owed and tried again).
 */
export async function reconcilePlanEndings() {
    if (!billingEnabled()) return 0;
    const users = new Set([
        ...(await billingRepository.listPooledWithPersonalPlan()),
        ...(await billingRepository.listUsersWithOpenPlanEndings()),
    ]);
    let queued = 0;
    for (const userId of users) {
        const family = await billingRepository.getPooledFamily(userId);
        const open = family ? null : (await billingRepository.listOpenPlanEndings(userId))[0];
        const membership = family ?? open;
        if (!membership) continue;
        if (
            await send({
                userId,
                groupId: membership.groupId,
                admittedAt: membership.admittedAt.toISOString(),
                seenAt: new Date().toISOString(),
            })
        )
            queued += 1;
    }
    return queued;
}

/* Polar's error name on a refused call (`AlreadyCanceledSubscription`, `RefundedAlready`). */
function errorName(error: unknown) {
    return (error as PolarClientError<{ error?: string }>).error?.error ?? null;
}

/* `already`: Polar had ended it before this call (403), so `revokedAt` is its own `ended_at`. */
type Revoked = { revokedAt: Date; periodStart: Date; periodEnd: Date; already: boolean };

const revokedFrom = (
    subscription: models.Subscription,
    endedAt: string,
    already: boolean,
): Revoked => ({
    revokedAt: new Date(endedAt),
    periodStart: new Date(subscription.current_period_start),
    periodEnd: new Date(subscription.current_period_end),
    already,
});

/*
 * An `ended_at` this long before HushOS saw its owner pooled is a plan that ended
 * before pooling (it ran out, or was ended at Polar): not this job's to refund.
 * The margin keeps clock differences between Polar and HushOS from refusing a
 * refund for a plan HushOS's own lost revoke ended.
 */
const ENDED_BEFORE_MARGIN_MS = 5 * 60 * 1000;

/*
 * Ends the subscription at Polar now. Already revoked (403
 * `AlreadyCanceledSubscription`, a first try whose answer was lost, or one ended
 * some other way): the subscription is read and its `ended_at` is the instant,
 * never now. Gone at Polar (404): null. Anything else throws, to be retried.
 */
async function revoke(subscriptionId: string): Promise<Revoked | null> {
    try {
        const revoked = await polar().subscriptions.revoke(subscriptionId);
        return revokedFrom(revoked, revoked.ended_at ?? new Date().toISOString(), false);
    } catch (error) {
        if (statusOf(error) === 404) return null;
        if (statusOf(error) !== 403 || errorName(error) !== 'AlreadyCanceledSubscription')
            throw error;
        const subscription = await polar().subscriptions.get(subscriptionId);
        // A 403 for one that still runs is not one HushOS can prorate: retried until it ends.
        if (!subscription.ended_at) throw error;
        return revokedFrom(subscription, subscription.ended_at, true);
    }
}

/*
 * For an ending whose owner left before HushOS knew the plan was revoked: whether
 * Polar ended it after they were pooled (an earlier try's revoke whose answer was
 * lost), as `revoke` reports one already ended, or null.
 */
async function endedSince(subscriptionId: string, pooledAt: Date): Promise<Revoked | null> {
    let subscription: models.Subscription;
    try {
        subscription = await polar().subscriptions.get(subscriptionId);
    } catch (error) {
        if (statusOf(error) === 404) return null;
        throw error;
    }
    if (
        !subscription.ended_at ||
        Date.parse(subscription.ended_at) < pooledAt.getTime() - ENDED_BEFORE_MARGIN_MS
    )
        return null;
    return revokedFrom(subscription, subscription.ended_at, true);
}

const seconds = (ms: number) => BigInt(Math.floor(ms / 1000));

/*
 * The unused part of one order, before tax, rounded down to the minor unit.
 * An order pays from its period's start (a change order from when it was made)
 * to the period's end. What was used ran until the plan was revoked; an order
 * paid after its owner was pooled (a renewal that slipped past the revoke) paid
 * for nothing they used, and is refunded whole. Its base is the order's net
 * amount (after discounts, before tax) less what it has refunded already.
 */
export function unusedAmount(input: {
    order: { netAmount: number; refundedAmount: number; createdAt: Date; change: boolean };
    periodStart: Date;
    periodEnd: Date;
    revokedAt: Date;
    pooledAt: Date;
}) {
    const { order } = input;
    const base = order.netAmount - order.refundedAmount;
    if (base <= 0) return 0;
    const spanStart = order.change ? order.createdAt : input.periodStart;
    const end = input.periodEnd.getTime();
    const total = seconds(end - spanStart.getTime());
    if (total <= 0n) return 0;
    const from =
        order.createdAt.getTime() >= input.pooledAt.getTime()
            ? spanStart.getTime()
            : Math.max(input.revokedAt.getTime(), spanStart.getTime());
    const unused = seconds(Math.max(0, end - from));
    const amount = (BigInt(base) * (unused < total ? unused : total)) / total;
    return Number(amount);
}

/* The orders that paid for the revoked plan's last period, every one of them. */
async function periodOrders(ending: billingRepository.PlanEnding) {
    const periodStart = ending.periodStart!.getTime();
    const periodEnd = ending.periodEnd!.getTime();
    const page = await polar().orders.list({
        subscription_id: ending.subscriptionId,
        sorting: ['-created_at'],
        limit: 100,
    });
    return page.items.filter((order) => {
        if (!order.paid || !PERIOD_REASONS.has(order.billing_reason)) return false;
        const at = Date.parse(order.created_at);
        if (Number.isNaN(at) || at >= periodEnd) return false;
        return order.billing_reason === 'subscription_update'
            ? at >= periodStart
            : at >= periodStart - PERIOD_SLACK_MS;
    });
}

export const refundKey = (ending: billingRepository.PlanEnding, orderId: string) =>
    `${ending.userId}:${ending.groupId}:${ending.admittedAt.toISOString()}:${orderId}`;

type RefundOutcome = 'settled' | 'pending' | 'failed';

/*
 * One order's refund, at most once. The amount is computed once, from the stored
 * revocation time, and kept. Before any call the order's refunds at Polar are
 * listed: one with HushOS's key that is pending or succeeded is this refund (a
 * retried job, a webhook replay, a reconcile, a call whose answer was lost); a
 * failed or cancelled one is not, and the refund is asked for again. Refunds
 * without the key made since (an operator's, by hand) count against it.
 */
async function refundOrder(
    ending: billingRepository.PlanEnding,
    order: models.Order,
): Promise<RefundOutcome> {
    const key = refundKey(ending, order.id);
    let row = await billingRepository.getPlanRefund(order.id);
    if (row && (row.status === 'succeeded' || row.status === 'none')) return 'settled';
    if (!row) {
        const amount = unusedAmount({
            order: {
                netAmount: order.net_amount,
                refundedAmount: order.refunded_amount,
                createdAt: new Date(order.created_at),
                change: order.billing_reason === 'subscription_update',
            },
            periodStart: ending.periodStart!,
            periodEnd: ending.periodEnd!,
            revokedAt: ending.revokedAt!,
            pooledAt: ending.pooledAt,
        });
        await billingRepository.notePlanRefund({
            orderId: order.id,
            subscriptionId: ending.subscriptionId,
            refundKey: key,
            amount,
            currency: order.currency,
        });
        row = (await billingRepository.getPlanRefund(order.id))!;
    }
    const failed = async (reason: string, status: number | null) => {
        const failures = await billingRepository.failPlanRefund(
            order.id,
            REFUND_FAILURES_BEFORE_OWED,
        );
        const fields = {
            billing: {
                user: ending.userId,
                order: order.id,
                amount: row.amount,
                currency: row.currency,
                failures,
                reason,
                status,
            },
        };
        if (failures >= REFUND_FAILURES_BEFORE_OWED)
            log.error({ message: 'Refund owed: Polar has not refunded it', ...fields });
        else log.warn({ message: 'Refund not made; tried again', ...fields });
        return 'failed' as const;
    };
    let refunds: models.Refund[];
    try {
        refunds = (await polar().refunds.list({ order_id: order.id, limit: 100 })).items;
    } catch (error) {
        return failed('list', statusOf(error));
    }
    const ours = refunds.filter((refund) => refund.metadata?.[REFUND_METADATA_KEY] === key);
    const done = ours.find((refund) => refund.status === 'succeeded');
    const waiting = ours.find((refund) => refund.status === 'pending');
    // One HushOS counted as on its way has failed at Polar since: a failed try, so it is owed
    // and counts toward Refunds owed, and it is asked for again below.
    if (!done && !waiting && row.status === 'pending') await failed('refund-failed', null);
    if (done || waiting) {
        const held = (done ?? waiting)!;
        await billingRepository.settlePlanRefund(order.id, {
            status: held.status as 'succeeded' | 'pending',
            providerRefundId: held.id,
        });
        return held.status === 'succeeded' ? 'settled' : 'pending';
    }
    // Refunded by someone else since HushOS computed it (an operator in Polar's dashboard).
    const byHand = refunds
        .filter(
            (refund) =>
                refund.metadata?.[REFUND_METADATA_KEY] !== key &&
                (refund.status === 'succeeded' || refund.status === 'pending') &&
                Date.parse(refund.created_at) >= row.createdAt.getTime(),
        )
        .reduce((sum, refund) => sum + refund.amount, 0);
    const owed = row.amount - byHand;
    if (owed <= 0) {
        if (byHand > 0)
            log.info({
                message: 'Refund made outside HushOS; nothing left to refund',
                billing: { user: ending.userId, order: order.id },
            });
        await billingRepository.settlePlanRefund(order.id, { status: 'none' });
        return 'settled';
    }
    let refund: models.Refund;
    try {
        refund = await polar().refunds.create({
            order_id: order.id,
            amount: owed,
            reason: 'customer_request',
            comment: 'Moved to a HushOS family plan',
            revoke_benefits: false,
            metadata: { [REFUND_METADATA_KEY]: key },
        });
    } catch (error) {
        // Refunded whole already, by whoever: nothing is left to give back.
        if (statusOf(error) === 403 && errorName(error) === 'RefundedAlready') {
            await billingRepository.settlePlanRefund(order.id, { status: 'none' });
            return 'settled';
        }
        return failed(errorName(error) ?? 'create', statusOf(error));
    }
    if (refund.status === 'succeeded' || refund.status === 'pending') {
        await billingRepository.settlePlanRefund(order.id, {
            status: refund.status,
            providerRefundId: refund.id,
        });
        return refund.status === 'succeeded' ? 'settled' : 'pending';
    }
    return failed(refund.status, null);
}

/*
 * `billing.end-personal-plan` for one person: every live personal plan of theirs
 * is ended while they are pooled, and every ending not yet settled is worked:
 * revoked (the instant stored the first time), the local entitlement revoked
 * (reconcileCustomer), and each order of the period refunded. Throws while a
 * revoke or a refund has failed, so pg-boss retries with backoff; returns while
 * only refunds still pending at Polar remain (the daily reconcile checks them).
 * Someone who left the family before their plan was revoked keeps it.
 */
export async function endPersonalPlans(job: EndPersonalPlanJob) {
    if (!billingEnabled()) return { settled: 0, pending: 0 };
    const { userId } = job;
    const family = await billingRepository.getPooledFamily(userId);
    // The mirror is read again at the end when it is out of date (a plan Polar ended unheard).
    let refresh = false;
    if (family) {
        // Seen pooled at `seenAt` through this membership; a newer one is seen pooled now.
        const same =
            family.groupId === job.groupId &&
            family.admittedAt.getTime() === Date.parse(job.admittedAt);
        const pooledAt = same ? new Date(job.seenAt) : new Date();
        const live = await livePersonalSubscriptions(userId);
        refresh = live.stale;
        for (const subscriptionId of live.ids)
            await billingRepository.ensurePlanEnding({
                subscriptionId,
                userId,
                groupId: family.groupId,
                admittedAt: family.admittedAt,
                pooledAt,
            });
    }
    let settled = 0;
    let pending = 0;
    let failed = 0;
    let revokedAny = false;
    for (let ending of await billingRepository.listOpenPlanEndings(userId)) {
        if (!ending.revokedAt) {
            const stillPooled = family?.groupId === ending.groupId;
            // Left the family since: their plan stays theirs, unless an earlier try's revoke
            // landed at Polar with its answer lost (then the refund is still owed them).
            const revoked = stillPooled
                ? await revoke(ending.subscriptionId)
                : await endedSince(ending.subscriptionId, ending.pooledAt);
            if (!stillPooled && !revoked) {
                await billingRepository.closePlanEnding(ending.subscriptionId, 'dropped');
                continue;
            }
            if (
                !revoked ||
                (revoked.already &&
                    revoked.revokedAt.getTime() <
                        ending.pooledAt.getTime() - ENDED_BEFORE_MARGIN_MS)
            ) {
                // Gone at Polar, or ended before its owner was pooled: nothing of it is refunded.
                await billingRepository.closePlanEnding(ending.subscriptionId, 'ended');
                revokedAny = true;
                continue;
            }
            const { already, ...instant } = revoked;
            ending = await billingRepository.recordPlanRevoked(ending.subscriptionId, instant);
            revokedAny = true;
            log.info({
                message: already
                    ? 'Personal plan found already ended; refunding from when it ended'
                    : 'Personal plan ended: its owner’s files joined a family',
                billing: { user: userId, subscription: ending.subscriptionId },
            });
        }
        let outcome: RefundOutcome = 'settled';
        try {
            for (const order of await periodOrders(ending)) {
                const result = await refundOrder(ending, order);
                if (result === 'failed') outcome = 'failed';
                else if (result === 'pending' && outcome === 'settled') outcome = 'pending';
            }
        } catch (error) {
            log.warn({
                message: 'A personal plan’s orders could not be read for its refund',
                billing: { user: userId, status: statusOf(error) },
            });
            outcome = 'failed';
        }
        if (outcome === 'settled') {
            await billingRepository.closePlanEnding(ending.subscriptionId, 'settled');
            settled += 1;
        } else if (outcome === 'pending') pending += 1;
        else failed += 1;
    }
    // The plan has ended: its entitlement goes now, not at the next delivery.
    if (revokedAny || refresh) {
        const { reconcileCustomer } = await import('./server');
        await reconcileCustomer(userId);
    }
    if (failed) throw new Error('A personal plan’s refund has not been made yet.');
    return { settled, pending };
}

/*
 * Polar's live subscriptions to a HushOS personal plan for this person, past due
 * included, and whether the mirror holds one as live that Polar has ended (a
 * delivery missed): that one ended on its own, before or after they were pooled,
 * and is not this job's to end or refund.
 */
async function livePersonalSubscriptions(userId: string) {
    let state: models.CustomerState | null = null;
    try {
        state = await polar().customers.getStateExternal(userId);
    } catch (error) {
        if (statusOf(error) !== 404) throw error;
    }
    const plans = new Set((await getCatalogue()).map((plan) => plan.id));
    const ids = new Set(
        (state?.active_subscriptions ?? [])
            .filter((subscription) => plans.has(subscription.product_id))
            .map((subscription) => subscription.id),
    );
    // Past due leaves the customer's state but still bills: the mirror names it.
    let stale = false;
    for (const id of await billingRepository.listLiveSubscriptionIds(userId)) {
        if (ids.has(id)) continue;
        try {
            const subscription = await polar().subscriptions.get(id);
            if (!subscription.ended_at && plans.has(subscription.product_id)) ids.add(id);
            else stale = true;
        } catch (error) {
            if (statusOf(error) !== 404) throw error;
            stale = true;
        }
    }
    return { ids: [...ids], stale };
}
