import { randomUUID } from 'node:crypto';
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
 * What the person actually paid on an order, before tax: its net amount (after
 * discounts), less any customer balance Polar applied to it (`applied_balance_amount`
 * is negative when a credit paid part of it, as a downgrade's credit does at the next
 * renewal). Polar caps a refund at net plus applied balance less what it refunded.
 */
export function paidOf(order: { net_amount: number; applied_balance_amount?: number | null }) {
    return Math.min(order.net_amount, order.net_amount + (order.applied_balance_amount ?? 0));
}

/*
 * The unused share of one order, as a fraction of the seconds it paid for. An
 * order pays from its period's start (a change order from when it was made) to the
 * period's end. What was used ran until the plan was revoked; an order paid after
 * its owner was pooled (a renewal that slipped past the revoke) paid for nothing
 * they used, and its whole span is unused.
 */
export function unusedShare(input: {
    order: { createdAt: Date; change: boolean };
    periodStart: Date;
    periodEnd: Date;
    revokedAt: Date;
    pooledAt: Date;
}) {
    const { order } = input;
    const spanStart = order.change ? order.createdAt : input.periodStart;
    const end = input.periodEnd.getTime();
    const total = seconds(end - spanStart.getTime());
    if (total <= 0n) return { unused: 0n, total: 1n };
    const from =
        order.createdAt.getTime() >= input.pooledAt.getTime()
            ? spanStart.getTime()
            : Math.max(input.revokedAt.getTime(), spanStart.getTime());
    const unused = seconds(Math.max(0, end - from));
    return { unused: unused < total ? unused : total, total };
}

/* `amount × unused / total`, rounded down (toward minus infinity for a credit). */
function shareOf(amount: number, share: { unused: bigint; total: bigint }) {
    const product = BigInt(amount) * share.unused;
    const quotient = product / share.total;
    return Number(product < 0n && quotient * share.total !== product ? quotient - 1n : quotient);
}

/*
 * The orders of the revoked plan's last period: the checkout or renewal that paid
 * for it, every change order made inside it (an upgrade's charge, a downgrade's
 * credit), paid or not when they credit.
 */
async function periodOrders(ending: billingRepository.PlanEnding) {
    const periodStart = ending.periodStart!.getTime();
    const periodEnd = ending.periodEnd!.getTime();
    const page = await polar().orders.list({
        subscription_id: ending.subscriptionId,
        sorting: ['-created_at'],
        limit: 100,
    });
    return page.items.filter((order) => {
        if (!PERIOD_REASONS.has(order.billing_reason)) return false;
        if (!order.paid && order.net_amount >= 0) return false;
        const at = Date.parse(order.created_at);
        if (Number.isNaN(at) || at >= periodEnd) return false;
        return order.billing_reason === 'subscription_update'
            ? at >= periodStart
            : at >= periodStart - PERIOD_SLACK_MS;
    });
}

export const refundKey = (ending: billingRepository.PlanEnding, orderId: string) =>
    `${ending.userId}:${ending.groupId}:${ending.admittedAt.toISOString()}:${orderId}`;

/* `owed`: listed for operators and not tried again within a day of the last try. */
type RefundOutcome = 'settled' | 'pending' | 'failed' | 'owed';

const RANK: Record<RefundOutcome, number> = { settled: 0, pending: 1, owed: 2, failed: 3 };
const worse = (a: RefundOutcome, b: RefundOutcome) => (RANK[a] >= RANK[b] ? a : b);

/* An owed refund is tried again at most this often (the daily reconcile's pace). */
const OWED_RETRY_MS = 23 * 60 * 60 * 1000;

/* How long a run holds an ending, renewed between steps: well past Polar's 15 s timeouts. */
export const PLAN_ENDING_LEASE_MS = 2 * 60 * 1000;

/*
 * A refund without HushOS's key made this soon before its first ask is still taken
 * for it (clocks differ); one made earlier was someone else's.
 */
const ATTEMPT_SLACK_MS = 60 * 1000;

const isLive = (refund: models.Refund) =>
    refund.status === 'pending' || refund.status === 'succeeded';

/*
 * The run's hold on one ending (PLAN_ENDING_LEASE_MS, renewed between steps), and
 * its job's signal: `check` throws when either is gone, and is called right before
 * every refund is asked for.
 */
type Hold = { check: () => Promise<void> };

/*
 * One order of the period as this run reads it. `ours`: its live refunds HushOS
 * made (its key), or that appeared without the key after HushOS first asked (taken
 * for its own: Polar recording one without the metadata after an ask that errored
 * once the card was refunded, or an operator's). `others`: its live refunds before
 * that, by anyone. `cap`: the most Polar will still refund on it for HushOS.
 */
type OrderState = {
    order: models.Order;
    row: billingRepository.PlanRefund | null;
    listed: models.Refund[] | null;
    ours: number;
    others: number;
    pending: boolean;
    cap: number;
};

/*
 * Every order of the period refunded, recomputed from Polar at every run.
 *
 * What is owed in all is the sum of every order's unused share, signed: a
 * checkout or renewal, an upgrade's charge (paid by card or from the customer's
 * balance), a downgrade's credit (negative). Each order's share is of its net
 * amount less the others' live refunds on it. That total is then placed on the
 * orders, at most what Polar will refund on each (net amount less any balance that
 * paid it, less live refunds): each its own share first, then the difference (a
 * credit taken off, an unrefundable order's share added), newest order first. What Polar won't take (a share paid from a balance
 * whose credit isn't in this period) is logged and not refunded.
 *
 * Orders Polar can refund nothing on (free, 100%-off, paid from balance, a credit)
 * are settled as `none` without listing their refunds. An order whose refunds, or
 * anyone's, are still pending stays open, so a refund that later fails or is
 * cancelled, HushOS's or anyone's, is owed again at the next run.
 */
async function refundPeriod(
    ending: billingRepository.PlanEnding,
    hold: Hold,
): Promise<RefundOutcome> {
    const orders = await periodOrders(ending);
    const rows = new Map(
        (await billingRepository.listPlanRefunds(ending.subscriptionId)).map((row) => [
            row.orderId,
            row,
        ]),
    );
    const share = (order: models.Order) =>
        unusedShare({
            order: {
                createdAt: new Date(order.created_at),
                change: order.billing_reason === 'subscription_update',
            },
            periodStart: ending.periodStart!,
            periodEnd: ending.periodEnd!,
            revokedAt: ending.revokedAt!,
            pooledAt: ending.pooledAt,
        });
    const states: OrderState[] = [];
    let readable = true;
    for (const order of orders) {
        const key = refundKey(ending, order.id);
        const row = rows.get(order.id) ?? null;
        const most = paidOf(order);
        if (most <= 0) {
            if (!row)
                await billingRepository.notePlanRefund({
                    orderId: order.id,
                    subscriptionId: ending.subscriptionId,
                    refundKey: key,
                    amount: 0,
                    currency: order.currency,
                    status: 'none',
                });
            states.push({ order, row, listed: [], ours: 0, others: 0, pending: false, cap: 0 });
            continue;
        }
        let listed: models.Refund[] | null = null;
        try {
            listed = (await polar().refunds.list({ order_id: order.id, limit: 100 })).items;
        } catch (error) {
            readable = false;
            log.warn({
                message: 'An order’s refunds could not be listed',
                billing: { user: ending.userId, order: order.id, status: statusOf(error) },
            });
        }
        const asked = row?.firstAttemptedAt?.getTime() ?? null;
        const mine = (refund: models.Refund) =>
            refund.metadata?.[REFUND_METADATA_KEY] === key ||
            (asked !== null && Date.parse(refund.created_at) >= asked - ATTEMPT_SLACK_MS);
        const live = (listed ?? []).filter(isLive);
        const ours = live.filter(mine).reduce((sum, refund) => sum + refund.amount, 0);
        // Unreadable: Polar's own refunded total stands for everyone's.
        const others = listed
            ? live.filter((refund) => !mine(refund)).reduce((sum, r) => sum + r.amount, 0)
            : order.refunded_amount;
        states.push({
            order,
            row,
            listed,
            ours,
            others,
            pending: live.some((refund) => refund.status === 'pending'),
            cap: Math.max(0, most - others),
        });
    }
    // What is owed in all, every order's unused share signed (a credit counts against it).
    const shares = new Map(
        states.map((state) => [
            state.order.id,
            shareOf(state.order.net_amount - Math.max(0, state.others), share(state.order)),
        ]),
    );
    const owedInAll = Math.max(
        0,
        [...shares.values()].reduce((sum, value) => sum + value, 0),
    );
    // Placed on the orders Polar can refund: each its own share first, as far as Polar takes it;
    // then the difference from what is owed in all (a credit taken off, or the share of an order
    // Polar can't refund on added) newest order first, within what Polar takes.
    const targets = new Map<string, number>();
    for (const state of states)
        targets.set(state.order.id, Math.min(Math.max(0, shares.get(state.order.id)!), state.cap));
    let left = owedInAll - [...targets.values()].reduce((sum, value) => sum + value, 0);
    for (const state of [...states].sort(
        (a, b) => Date.parse(b.order.created_at) - Date.parse(a.order.created_at),
    )) {
        if (left === 0) break;
        const now = targets.get(state.order.id)!;
        const next = Math.min(state.cap, Math.max(0, now + left));
        targets.set(state.order.id, next);
        left -= next - now;
    }
    if (left > 0)
        log.warn({
            message: 'Part of a personal plan’s unused days can’t be refunded: Polar won’t take it',
            billing: { user: ending.userId, subscription: ending.subscriptionId, amount: left },
        });
    let outcome: RefundOutcome = 'settled';
    for (const state of states) {
        if (paidOf(state.order) <= 0) continue;
        const target = targets.get(state.order.id)!;
        if (!state.row)
            await billingRepository.notePlanRefund({
                orderId: state.order.id,
                subscriptionId: ending.subscriptionId,
                refundKey: refundKey(ending, state.order.id),
                amount: target,
                currency: state.order.currency,
            });
        else if (state.listed) await billingRepository.setPlanRefundAmount(state.order.id, target);
        const row = (await billingRepository.getPlanRefund(state.order.id))!;
        outcome = worse(
            outcome,
            readable
                ? await refundOrder(ending, state, row, target, hold)
                : await failRefund(ending, row, 'list', null),
        );
    }
    return outcome;
}

/*
 * A try that failed: one more in a row; at REFUND_FAILURES_BEFORE_OWED, owed
 * (listed for operators, asked again at most daily).
 */
async function failRefund(
    ending: billingRepository.PlanEnding,
    row: billingRepository.PlanRefund,
    reason: string,
    status: number | null,
): Promise<RefundOutcome> {
    const failures = await billingRepository.failPlanRefund(
        row.orderId,
        REFUND_FAILURES_BEFORE_OWED,
    );
    const fields = {
        billing: {
            user: ending.userId,
            order: row.orderId,
            amount: row.amount,
            currency: row.currency,
            failures,
            reason,
            status,
        },
    };
    if (failures >= REFUND_FAILURES_BEFORE_OWED) {
        log.error({ message: 'Refund owed: Polar has not refunded it', ...fields });
        return 'owed';
    }
    log.warn({ message: 'Refund not made; tried again', ...fields });
    return 'failed';
}

/*
 * One order brought to its target: what HushOS means to have refunded on it in all.
 * What its live refunds of HushOS's already hold counts; the rest is asked for, under
 * the run's hold, checked right before the call.
 */
async function refundOrder(
    ending: billingRepository.PlanEnding,
    state: OrderState,
    row: billingRepository.PlanRefund,
    target: number,
    hold: Hold,
): Promise<RefundOutcome> {
    const key = row.refundKey;
    const listed = state.listed ?? [];
    // One HushOS counted as on its way has failed or been cancelled at Polar since: a failed
    // try, so it counts toward Refunds owed, and what it held is owed again below.
    let failedBefore: RefundOutcome | null = null;
    if (
        row.status === 'pending' &&
        listed.some(
            (refund) =>
                refund.metadata?.[REFUND_METADATA_KEY] === key &&
                (refund.status === 'failed' || refund.status === 'canceled'),
        ) &&
        state.ours < target
    )
        failedBefore = await failRefund(ending, row, 'refund-failed', null);
    const owed = target - state.ours;
    if (owed <= 0) {
        // Anything still pending on the order keeps it open, to be read again.
        const ourLatest = listed.find(
            (refund) => refund.metadata?.[REFUND_METADATA_KEY] === key && isLive(refund),
        );
        if (state.pending) {
            await billingRepository.settlePlanRefund(row.orderId, {
                status: 'pending',
                providerRefundId: ourLatest?.id ?? row.providerRefundId,
            });
            return 'pending';
        }
        await billingRepository.settlePlanRefund(row.orderId, {
            status: state.ours > 0 ? 'succeeded' : 'none',
            providerRefundId: ourLatest?.id ?? row.providerRefundId,
        });
        return 'settled';
    }
    if (failedBefore === 'owed') return 'owed';
    // Owed already: asked again once a day, not at every delivery or retry.
    if (
        row.failures >= REFUND_FAILURES_BEFORE_OWED &&
        row.lastAttemptedAt &&
        Date.now() - row.lastAttemptedAt.getTime() < OWED_RETRY_MS
    )
        return 'owed';
    await hold.check();
    await billingRepository.markPlanRefundAttempt(row.orderId, new Date());
    let refund: models.Refund;
    try {
        refund = await polar().refunds.create({
            order_id: row.orderId,
            amount: owed,
            reason: 'customer_request',
            comment: 'Moved to a HushOS family plan',
            revoke_benefits: false,
            metadata: { [REFUND_METADATA_KEY]: key },
        });
    } catch (error) {
        // Refunded whole already, by whoever: nothing is left to give back.
        if (statusOf(error) === 403 && errorName(error) === 'RefundedAlready') {
            await billingRepository.settlePlanRefund(row.orderId, { status: 'none' });
            return 'settled';
        }
        return failRefund(ending, row, errorName(error) ?? 'create', statusOf(error));
    }
    if (refund.status === 'succeeded' && !state.pending) {
        await billingRepository.settlePlanRefund(row.orderId, {
            status: 'succeeded',
            providerRefundId: refund.id,
        });
        return 'settled';
    }
    if (refund.status === 'succeeded' || refund.status === 'pending') {
        await billingRepository.settlePlanRefund(row.orderId, {
            status: 'pending',
            providerRefundId: refund.id,
        });
        return 'pending';
    }
    return failRefund(ending, row, refund.status, null);
}

/* Thrown when the run's job signal fired, or another run holds (or took over) an ending. */
export class PlanEndingBusyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PlanEndingBusyError';
    }
}

/*
 * `billing.end-personal-plan` for one person: every live personal plan of theirs
 * is ended while they are pooled, and every ending not yet settled is worked:
 * revoked (the instant stored the first time), the local entitlement revoked
 * (reconcileCustomer), and each order of the period refunded. Throws while a
 * revoke or a refund has failed, so pg-boss retries with backoff; returns while
 * only refunds still pending at Polar, or owed (five failures in a row, tried
 * again daily), remain: the daily reconcile queues those again. Someone who left
 * the family before their plan was revoked keeps it.
 *
 * Each ending is worked under a lease on its row (PLAN_ENDING_LEASE_MS, the app's
 * clock), taken with a conditional update and renewed between steps; the lease and
 * the job's signal are checked right before every refund is asked for. A second run
 * (pg-boss's retry of one it took for dead) can't take an ending another holds, and
 * a run that stalled past its lease, which another then took, asks Polar for nothing
 * more: it throws PlanEndingBusyError and is retried.
 */
export async function endPersonalPlans(
    job: EndPersonalPlanJob,
    options: { signal?: AbortSignal } = {},
) {
    if (!billingEnabled()) return { settled: 0, pending: 0, owed: 0 };
    const { signal } = options;
    const owner = randomUUID();
    const stop = () => {
        if (signal?.aborted)
            throw new PlanEndingBusyError('The job ran out of time; its retry carries on.');
    };
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
    let owed = 0;
    let failed = 0;
    let busy = false;
    let revokedAny = false;
    for (let ending of await billingRepository.listOpenPlanEndings(userId)) {
        stop();
        const subscriptionId = ending.subscriptionId;
        if (
            !(await billingRepository.takePlanEndingLease(
                subscriptionId,
                owner,
                new Date(),
                PLAN_ENDING_LEASE_MS,
            ))
        ) {
            busy = true;
            continue;
        }
        const hold: Hold = {
            async check() {
                stop();
                if (
                    !(await billingRepository.renewPlanEndingLease(
                        subscriptionId,
                        owner,
                        new Date(),
                        PLAN_ENDING_LEASE_MS,
                    ))
                )
                    throw new PlanEndingBusyError(
                        'Another run took this plan’s ending over; this one stops.',
                    );
            },
        };
        try {
            if (!ending.revokedAt) {
                const stillPooled = family?.groupId === ending.groupId;
                // Left the family since: their plan stays theirs, unless an earlier try's revoke
                // landed at Polar with its answer lost (then the refund is still owed them).
                const revoked = stillPooled
                    ? await revoke(subscriptionId)
                    : await endedSince(subscriptionId, ending.pooledAt);
                if (!stillPooled && !revoked) {
                    await billingRepository.closePlanEnding(subscriptionId, 'dropped');
                    continue;
                }
                if (
                    !revoked ||
                    (revoked.already &&
                        revoked.revokedAt.getTime() <
                            ending.pooledAt.getTime() - ENDED_BEFORE_MARGIN_MS)
                ) {
                    // Gone at Polar, or ended before its owner was pooled: nothing is refunded.
                    await billingRepository.closePlanEnding(subscriptionId, 'ended');
                    revokedAny = true;
                    continue;
                }
                const { already, ...instant } = revoked;
                ending = await billingRepository.recordPlanRevoked(subscriptionId, instant);
                revokedAny = true;
                log.info({
                    message: already
                        ? 'Personal plan found already ended; refunding from when it ended'
                        : 'Personal plan ended: its owner’s files joined a family',
                    billing: { user: userId, subscription: subscriptionId },
                });
            }
            await hold.check();
            let outcome: RefundOutcome;
            try {
                outcome = await refundPeriod(ending, hold);
            } catch (error) {
                if (error instanceof PlanEndingBusyError) throw error;
                log.warn({
                    message: 'A personal plan’s orders could not be read for its refund',
                    billing: { user: userId, status: statusOf(error) },
                });
                outcome = 'failed';
            }
            if (outcome === 'settled') {
                await billingRepository.closePlanEnding(subscriptionId, 'settled');
                settled += 1;
            } else if (outcome === 'pending') pending += 1;
            else if (outcome === 'owed') owed += 1;
            else failed += 1;
        } finally {
            await billingRepository.releasePlanEndingLease(subscriptionId, owner);
        }
    }
    // The plan has ended: its entitlement goes now, not at the next delivery.
    if (revokedAny || refresh) {
        const { reconcileCustomer } = await import('./server');
        await reconcileCustomer(userId);
    }
    // Another run holds an ending: this one is retried rather than work it alongside.
    if (busy)
        throw new PlanEndingBusyError(
            'Another run is ending this person’s plan; tried again later.',
        );
    // A failure is retried by pg-boss with backoff; a refund owed waits for the daily reconcile.
    if (failed) throw new Error('A personal plan’s refund has not been made yet.');
    return { settled, pending, owed };
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
