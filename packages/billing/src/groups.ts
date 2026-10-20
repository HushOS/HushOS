import { createHash } from 'node:crypto';
import { authRepository, billingRepository, groupsRepository } from '@hushos/db';
import { appEnv } from '@hushos/env/app';
import { billingEnv } from '@hushos/env/billing';
import { groupsEnv } from '@hushos/env/groups';
import { log } from '@hushos/logging';
import type { models } from '@polar-sh/sdk/2026-10';
import type { PolarClientError } from '@polar-sh/sdk';
import type { FamilyUsage, GroupBillingSummary } from './api';
import { queuePlanEnding } from './endings';
import {
    BillingError,
    PROVIDER,
    billingEnabled,
    getFamilyCatalogue,
    offeredFamilies,
    polar,
    statusOf,
    unavailable,
    type BillingUser,
    type FamilyCatalogueProduct,
} from './provider';
import {
    GROUP_CUSTOMER_PREFIX,
    MAX_MEMBERS_PER_RAISE,
    STALE_RAISE_DAYS,
    UNPAID_GROUP_SEATS,
    quoteUnitsChange,
    spaceOf,
} from './protocol';

/* Pure, so the web quotes a raise with the server's own arithmetic. */
export { quoteUnitsChange, spaceOf };

/*
 * Family billing (docs/groups-design.md 3.5, docs/polar-group-billing-spike.md
 * 5 and 8). One Polar team customer per group, `group:<groupId>`, whose owner
 * member is the payer; one subscription whose `units` is the member capacity
 * bought: a fixed base plus a graduated unit price, free up to the plan's
 * included members. Webhooks and the daily job re-read the team customer and
 * project the live plan onto the group's seat limit and storage pool.
 *
 * Money moves only on a raise, charged at once (`invoice`), and only the payer
 * raises. A raise that Polar answers with 402 changes nothing at Polar (spike
 * E8) and nothing here, so an admission waits for the 200. A cut is scheduled
 * for the period's end (`next_period`) and is never below the members already
 * admitted; any raise deletes it at Polar (spike E3), so it is put back.
 */

const DAY = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* The group id in a team customer's external id, or null for anything else. */
export function groupIdOf(externalId: string) {
    if (!externalId.startsWith(GROUP_CUSTOMER_PREFIX)) return null;
    const id = externalId.slice(GROUP_CUSTOMER_PREFIX.length);
    return UUID.test(id) ? id : null;
}

const customerKey = (groupId: string) => `${GROUP_CUSTOMER_PREFIX}${groupId}`;
const graceMs = () => billingEnv.BILLING_GRACE_DAYS * DAY;
// Account → Family: the page of the one family an account is in (docs/families-shared-pool.md 7.2).
const familyPage = () => `${appEnv.APP_ORIGIN}/app/family`;

function requireFamilyBilling() {
    if (!billingEnabled()) throw new BillingError('Billing is not available on this server.', 404);
    if (!groupsEnv.GROUPS_ENABLED)
        throw new BillingError('This server does not offer families yet.', 404);
}

/*
 * The caller's family, as an active member with the role asked for: `billing`
 * to buy or change the plan, `billing` or `members` to see it.
 */
async function familyOf(groupId: string, userId: string, need: 'billing' | 'manager') {
    const found = await groupsRepository.getGroupFor(groupId, userId);
    if (!found || found.membership.state !== 'active' || found.group.kind !== 'family')
        throw new BillingError('This family does not exist.', 404);
    const roles = found.membership.roles;
    const allowed = roles.includes('billing') || (need === 'manager' && roles.includes('members'));
    if (!allowed)
        throw new BillingError('Only someone who manages this family’s plan can do that.', 403);
    return found.group;
}

/* ------------------------------------------------------------------------- */
/* Reading Polar                                                              */
/* ------------------------------------------------------------------------- */

function snapshotOf(
    subscription: models.Subscription,
    plan: FamilyCatalogueProduct,
    paid: boolean,
    tier: TierState,
): billingRepository.GroupSubscriptionSnapshot {
    const units = subscription.units ?? plan.includedMembers;
    return {
        id: subscription.id,
        productId: plan.id,
        productName: plan.name,
        status: subscription.status,
        recurringInterval: subscription.recurring_interval,
        amount: subscription.amount,
        currency: subscription.currency,
        units,
        paidUnits: paid ? units : null,
        pendingUnits: subscription.pending_update?.units ?? null,
        pendingProductId: subscription.pending_update?.product_id ?? null,
        ...(tier.known ? { paidTier: tier.paidTier, tierMismatchSince: tier.mismatchSince } : {}),
        includedMembers: plan.includedMembers,
        quotaBytes: BigInt(plan.quotaBytes),
        currentPeriodStart: new Date(subscription.current_period_start),
        currentPeriodEnd: new Date(subscription.current_period_end),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        endedAt: subscription.ended_at ? new Date(subscription.ended_at) : null,
    };
}

async function planOf(productId: string) {
    const plan = (await getFamilyCatalogue()).find((candidate) => candidate.id === productId);
    if (!plan)
        log.warn({
            message: 'Group subscription product is not a family plan',
            billing: { product: productId },
        });
    return plan ?? null;
}

/*
 * Whether an order of the subscription waits for payment (a raise the bank
 * has not confirmed, a renewal being retried), and since when: `unpaid` is
 * true, false, or null when the orders could not be read (`orders:read`).
 * Only false lets places count as paid.
 */
async function orderState(subscriptionId: string) {
    try {
        const orders = await polar().orders.list({
            subscription_id: subscriptionId,
            status: 'pending',
            limit: 10,
        });
        const waiting = orders.items.filter((order) => order.due_amount > 0);
        const oldest = waiting.reduce<number | null>((min, order) => {
            const at = Date.parse(order.created_at);
            return Number.isNaN(at) ? min : min === null ? at : Math.min(min, at);
        }, null);
        return { unpaid: waiting.length > 0, oldestAt: oldest };
    } catch (error) {
        log.warn({
            message: 'Group orders could not be read',
            billing: { status: statusOf(error) },
        });
        return { unpaid: null, oldestAt: null };
    }
}

/*
 * An order refunded whole: Polar marks it `refunded`, or its refunds reach what it
 * charged. A partial refund (a goodwill credit) leaves it paying for its tier; an
 * order that charged nothing (a 100%-off checkout) is never "refunded" by being free.
 */
function fullyRefunded(order: models.Order) {
    return (
        order.status === 'refunded' ||
        (order.refunded_amount > 0 && order.refunded_amount >= order.net_amount)
    );
}

/* The orders that pay for a tier: a checkout, a renewal, a change. */
const TIER_ORDER_REASONS = new Set([
    'subscription_create',
    'subscription_cycle',
    'subscription_update',
]);

/*
 * The tier a subscription has paid for, re-derived from Polar's orders: the
 * product of its newest paid, unrefunded checkout, renewal or change order
 * (newest by when it was made), and that product's pool. Pending orders don't
 * count, nor orders refunded whole (a partial refund still pays for the tier). So a paid upgrade gives its tier, an
 * unpaid one leaves the last paid order's tier in force, and a paid renewal of
 * the bigger tier gives it whatever change order still waits. A raise is a
 * change order for the product it was made on, which places are refused off
 * (changePlaces), so it never names a tier not paid for. `mismatchSince`:
 * while the product's pool is bigger than the paid tier's (an upgrade
 * unpaid), the date kept from the first time HushOS saw it, or the oldest
 * unpaid change order for the product if older; null otherwise, and while
 * nothing is paid (no tier to go back to). `known` is false when the orders
 * can't be read: the row keeps what it had.
 */
type TierState =
    | { known: false }
    | {
          known: true;
          paidTier: { productId: string; quotaBytes: bigint } | null;
          mismatchSince: Date | null;
      };

async function tierStateOf(
    subscription: models.Subscription,
    plan: FamilyCatalogueProduct,
): Promise<TierState> {
    let orders: models.Order[];
    try {
        orders = (
            await polar().orders.list({
                subscription_id: subscription.id,
                sorting: ['-created_at'],
                limit: 100,
            })
        ).items;
    } catch (error) {
        log.warn({
            message: 'Group orders could not be read for a tier',
            billing: { status: statusOf(error) },
        });
        return { known: false };
    }
    const catalogue = await getFamilyCatalogue();
    const row = await billingRepository.getGroupSubscription(subscription.id);
    const uncredited = new Set(row?.uncreditedOrderIds ?? []);
    const newest = orders
        .filter(
            (order) =>
                order.paid &&
                !fullyRefunded(order) &&
                !uncredited.has(order.id) &&
                TIER_ORDER_REASONS.has(order.billing_reason) &&
                catalogue.some((candidate) => candidate.id === order.product_id),
        )
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    const paidPlan = newest && catalogue.find((candidate) => candidate.id === newest.product_id);
    const paidTier = paidPlan
        ? { productId: paidPlan.id, quotaBytes: BigInt(paidPlan.quotaBytes) }
        : null;
    if (!paidTier || BigInt(plan.quotaBytes) <= paidTier.quotaBytes)
        return { known: true, paidTier, mismatchSince: null };
    // Only change orders made since the tier paid for: an old one left unpaid months ago (an
    // upgrade that was reverted) doesn't start the clock on a fresh upgrade to the same tier.
    const paidAt = newest ? Date.parse(newest.created_at) : 0;
    const unpaid = orders
        .filter(
            (order) =>
                !order.paid &&
                order.billing_reason === 'subscription_update' &&
                order.product_id === subscription.product_id &&
                Date.parse(order.created_at) > paidAt,
        )
        .map((order) => Date.parse(order.created_at))
        .filter((at) => !Number.isNaN(at));
    const seen = row?.tierMismatchSince?.getTime() ?? Date.now();
    return {
        known: true,
        paidTier,
        mismatchSince: new Date(Math.min(seen, ...unpaid)),
    };
}

/*
 * One subscription as a change returned it, written without touching the
 * group's others. `paid` says the places it now has are paid for (a raise
 * Polar answered with 200 and no order waits); otherwise the paid count stays
 * where it was. The tier paid for is re-derived from Polar's orders
 * (tierStateOf). False when the product isn't a family plan.
 */
async function applyChanged(groupId: string, subscription: models.Subscription, paid: boolean) {
    const plan = await planOf(subscription.product_id);
    if (!plan) return false;
    const tier = await tierStateOf(subscription, plan);
    await billingRepository.applyGroupState({
        groupId,
        provider: PROVIDER,
        customerId: null,
        subscriptions: [snapshotOf(subscription, plan, paid, tier)],
        graceMs: graceMs(),
        complete: false,
    });
    return true;
}

const LIVE = new Set(['active', 'trialing', 'past_due']);

/*
 * A webhook says only that something changed: the team customer's state says
 * what is true now. Every subscription it lists, and every one HushOS still
 * holds as live, is read in full (the state carries no pending cut, and an
 * ended one has left it), with its unpaid orders: places count as paid only
 * when none waits, so a raise awaiting the bank opens nothing until its
 * `order.paid` (or the next reconcile) finds it paid. Then the group's rows,
 * seat limit and pool are rewritten in one transaction.
 *
 * A subscription whose product the catalogue cannot read (an operator edited
 * it) is left as it was, never swept as ended: the family keeps its places and
 * its payer stays its payer until someone fixes the product. A raise whose
 * order has waited STALE_RAISE_DAYS is cut back to the places paid for at the
 * period's end (one made within that many days of a renewal can still be
 * billed once), and the cut is withdrawn if the order is paid later. A live
 * plan whose payer's account is gone is revoked. Last, a cut
 * HushOS still means to have that Polar lost is asked for again, and queued
 * for a retry if Polar refuses.
 */
export async function reconcileGroup(
    groupId: string,
    options: { fromDissolveCancel?: boolean } = {},
) {
    if (!billingEnabled() || !UUID.test(groupId)) return;
    let state: models.CustomerState | null;
    try {
        state = await polar().customers.getStateExternal(customerKey(groupId));
    } catch (error) {
        if (statusOf(error) === 404) state = null;
        else throw unavailable(error);
    }
    // A group HushOS never made a customer for gets no pool from a stray delivery.
    if (!state && !(await billingRepository.getGroupCustomer(groupId))) return;
    const ids = new Set((state?.active_subscriptions ?? []).map((subscription) => subscription.id));
    for (const id of await billingRepository.listLiveGroupSubscriptionIds(groupId)) ids.add(id);
    const subscriptions: billingRepository.GroupSubscriptionSnapshot[] = [];
    const unresolved: string[] = [];
    const stale: string[] = [];
    // Products bigger than the tier paid for, for more than STALE_RAISE_DAYS (an unpaid upgrade).
    const staleTier: string[] = [];
    for (const id of ids) {
        let subscription: models.Subscription;
        try {
            subscription = await polar().subscriptions.get(id);
        } catch (error) {
            if (statusOf(error) === 404) continue;
            throw unavailable(error);
        }
        const plan = await planOf(subscription.product_id);
        if (!plan) {
            unresolved.push(subscription.id);
            log.warn({
                message: 'Group subscription left as it was: its product is not a family plan',
                billing: { group: groupId, subscription: subscription.id },
            });
            continue;
        }
        const ended = Boolean(subscription.ended_at);
        const orders = ended ? null : await orderState(subscription.id);
        if (orders?.oldestAt != null && Date.now() - orders.oldestAt > STALE_RAISE_DAYS * DAY)
            stale.push(subscription.id);
        const tier: TierState = ended ? { known: false } : await tierStateOf(subscription, plan);
        if (
            tier.known &&
            tier.mismatchSince &&
            Date.now() - tier.mismatchSince.getTime() > STALE_RAISE_DAYS * DAY
        )
            staleTier.push(subscription.id);
        subscriptions.push(snapshotOf(subscription, plan, orders?.unpaid === false, tier));
    }
    await billingRepository.applyGroupState({
        groupId,
        provider: PROVIDER,
        customerId: state?.id ?? null,
        subscriptions,
        graceMs: graceMs(),
        complete: true,
        keepIds: unresolved,
    });
    // Everyone whose files now draw from a live pool with a personal plan still live has that
    // plan ended (docs/families-shared-pool.md 5.1): the organizer's first purchase, a family's
    // lapsed plan bought again, a checkout that raced an admission.
    for (const userId of await billingRepository.listPooledWithPersonalPlan(groupId))
        await queuePlanEnding(userId);
    // A dissolved family's plan that can still charge and isn't set to end (its payer took the
    // ending back in the portal, or it was never set): the worker sets it to end. Also one
    // HushOS set to end whose payer is still owed the mail (it failed, or the answer was lost).
    if (
        !options.fromDissolveCancel &&
        (await billingRepository.listDissolvedChargeable(groupId)).some(
            (row) => (!row.ending && row.refusedState !== row.state) || row.mailOwed,
        )
    )
        await queueDissolvedCancel(groupId);
    const liveCount =
        subscriptions.filter((s) => !s.endedAt && LIVE.has(s.status)).length + unresolved.length;
    if (liveCount > 1)
        log.warn({
            message: 'Group has more than one live subscription',
            billing: { group: groupId, live: liveCount },
        });
    let live = await billingRepository.getLiveGroupSubscription(groupId);
    if (live && (await revokeWithoutPayer(groupId, live))) return;
    const used = await groupsRepository.seatsUsed(groupId);
    // Changed outside HushOS (the dashboard, support): never remove anyone, but say so.
    if (live && live.units < used)
        log.warn({
            message: 'Group plan has fewer places than admitted members',
            billing: { group: groupId, units: live.units, admitted: used },
        });
    if (
        live &&
        staleTier.includes(live.id) &&
        live.paidProductId !== null &&
        paidTier(live).quotaBytes < live.quotaBytes
    ) {
        // An upgrade the bank never confirmed: back to the tier paid for at the period's end, so
        // a renewal never bills it. The payer's own move at or below that tier stands. Withdrawn
        // by reissueCut as soon as the tier paid for matches the product.
        const tier = { productId: live.paidProductId, quotaBytes: paidTier(live).quotaBytes };
        const catalogue = await getFamilyCatalogue();
        const back = catalogue.find((candidate) => candidate.id === tier.productId);
        const own = live.intendedProductId
            ? catalogue.find((candidate) => candidate.id === live?.intendedProductId)
            : undefined;
        if (!back || !offeredFamilies(catalogue).includes(back)) {
            // Nothing to move back to: the family stays at the smaller storage (the pool is the
            // lesser of the two) and an operator is told, once; nothing is scheduled or retried.
            if (live.reissueStuckReason !== 'revert-unavailable') {
                log.error({
                    message: 'Unconfirmed upgrade can’t be reverted: its paid plan is not offered',
                    billing: { group: groupId, product: live.productId, paid: tier.productId },
                });
                await billingRepository.setReissueGaveUp(
                    live.id,
                    new Date(Date.now()),
                    'revert-unavailable',
                );
            }
        } else if (!own || BigInt(own.quotaBytes) > tier.quotaBytes) {
            log.warn({
                message: 'Unconfirmed upgrade reverted at the period end',
                billing: { group: groupId, product: live.productId, paid: tier.productId },
            });
            await billingRepository.setIntendedProduct(live.id, tier.productId, true);
            live = await billingRepository.getLiveGroupSubscription(groupId);
        }
    } else if (
        live?.reissueStuckReason === 'revert-unavailable' &&
        paidTier(live).quotaBytes >= live.quotaBytes
    ) {
        // Paid after all, or moved by hand: no longer stuck.
        await billingRepository.setReissueGaveUp(live.id, null);
    }
    // The raise the stale rule cut back was paid after all: withdraw that cut, re-issue nothing.
    if (live?.intendedStale && live.paidUnits >= live.units) {
        log.info({
            message: 'Stale-raise cut withdrawn: the raise was paid',
            billing: { group: groupId, units: live.units },
        });
        await billingRepository.setIntendedUnits(live.id, null);
        if (live.pendingUnits === live.intendedUnits) {
            const subscription = await polar().subscriptions.get(live.id);
            await setPending(groupId, subscription, {
                units: null,
                product: live.intendedProductId,
            });
        }
        return;
    }
    // A first checkout never paid has no places to go back to (and a cut to none is no cut):
    // Polar's own retries decide whether it starts at all.
    if (live && stale.includes(live.id) && live.paidUnits < live.units && live.paidUnits > 0) {
        log.warn({
            message: 'Unconfirmed raise cut back to the places paid for',
            billing: { group: groupId, units: live.units, paid: live.paidUnits },
        });
        // The payer's own cut stands when it is already at or below the places paid for.
        if (live.intendedUnits === null || live.intendedUnits > live.paidUnits)
            await billingRepository.setIntendedUnits(live.id, live.paidUnits, true);
    }
    if (
        live &&
        (live.intendedUnits !== null || live.intendedProductId !== null || stale.includes(live.id))
    )
        try {
            await reissueCut(groupId, { fromReconcile: true });
        } catch (error) {
            log.warn({
                message: 'Recorded cut not re-issued by reconcile',
                billing: { group: groupId, status: statusOf(error) },
            });
            await queueCutRetry(groupId);
        }
}

/*
 * A plan still billing with nobody to pay for it: its payer's account is gone
 * (a checkout paid after they deleted it, say). Revoked at Polar at once, so
 * no card is charged for a family nobody pays for; a plan already set to end
 * runs out instead, as its payer chose.
 */
async function revokeWithoutPayer(
    groupId: string,
    live: { id: string; cancelAtPeriodEnd: boolean },
) {
    if (live.cancelAtPeriodEnd) return false;
    const customer = await billingRepository.getGroupCustomer(groupId);
    if (customer?.payerUserId) return false;
    log.warn({
        message: 'Group plan revoked: its payer is gone',
        billing: { group: groupId, subscription: live.id },
    });
    const revoked = await polar().subscriptions.revoke(live.id);
    await applyChanged(groupId, revoked, false);
    return true;
}

/* ------------------------------------------------------------------------- */
/* Dissolved families                                                         */
/* ------------------------------------------------------------------------- */

/*
 * Where a dissolved family's plan is queued to be set to end (pg-boss, keyed by the
 * family, with retries): set by the processes that can send jobs. Without one the
 * daily reconcile finds the plan and queues it then.
 */
type DissolveCancelQueue = (groupId: string) => Promise<unknown>;
let dissolveCancelQueue: DissolveCancelQueue | undefined;
export function setDissolveCancelQueue(queue: DissolveCancelQueue | undefined) {
    dissolveCancelQueue = queue;
}

/* Never throws: a family dissolved without a queued job is found by the next reconcile. */
export async function queueDissolvedCancel(groupId: string) {
    if (!billingEnabled() || !UUID.test(groupId)) return;
    if (!dissolveCancelQueue) {
        log.warn({
            message: 'No queue for dissolved families’ plans',
            billing: { group: groupId },
        });
        return;
    }
    try {
        await dissolveCancelQueue(groupId);
    } catch (error) {
        log.warn({
            message: 'Dissolved family’s plan not queued to end',
            billing: { group: groupId, status: statusOf(error) },
        });
    }
}

/* Another run holds the plan (its claim): pg-boss retries this one, which then finds it set. */
export class DissolveCancelBusyError extends Error {
    constructor() {
        super('Another run is setting this plan to end.');
        this.name = 'DissolveCancelBusyError';
    }
}

const ENDED = new Set<string>(billingRepository.ENDED_SUBSCRIPTION_STATUSES);
const endsOnFormat = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
});

/* Polar's error name on a refused call (`InactiveSubscription`, `SubscriptionLocked`). */
function errorName(error: unknown) {
    return (error as PolarClientError<{ error?: string }>).error?.error ?? null;
}

const endingOrEnded = (subscription: models.Subscription) =>
    Boolean(subscription.ended_at) ||
    subscription.cancel_at_period_end ||
    ENDED.has(subscription.status);

/*
 * The job for a dissolved family (docs/groups-design.md 3.3): every plan of it that
 * can still charge (not ended, `canceled` or `incomplete_expired`; `paused` can, since
 * a payer may resume it) is set to end at the period's end (`cancel_at_period_end`),
 * never revoked: the payer keeps what they paid for, and nothing is refunded, as when a
 * payer cancels (groups-design 3.5); the prorated refund of docs/families-shared-pool.md
 * 5.1 is for a personal plan ended early.
 *
 * Every time it is resumed it is set to end again, without limit: a resume is the payer's
 * own click in the portal, never something setting it to end causes, so there is no loop
 * to break, and stopping would leave them charged for a family that is gone.
 *
 * Only for a family the mirror holds a plan for that can still charge, so a dissolve
 * without one asks Polar nothing. Polar is read first (reconcileGroup), since the mirror
 * may lag a payer's change. Each plan is set under its change claim (claimPlanChange, the
 * claim raises and tier moves take), read again under it, and changed only when it still
 * isn't set to end: two runs, a retry and a webhook's job never set it twice.
 *
 * Polar's answers to the update (the errors its SDK declares for it): only 403
 * `InactiveSubscription`, a plan it won't change while it isn't active (past due, paused),
 * is a refusal no retry changes until the plan does. It is recorded with the plan's state
 * and listed for operators, and the plan is not tried again, by this job or any reconcile,
 * until Polar shows it in another state. 403 `AlreadyCanceledSubscription` is a plan set
 * to end since the read, read again to be sure. Everything else throws, for pg-boss to
 * retry with backoff: 409 `SubscriptionLocked` (a pending update, as Polar holds one
 * during a renewal), 402, 422, a token error (401, or a 403 of another name), 429, a 5xx,
 * a timeout, a held claim. Such a failure is recorded (`dissolve_failing_since`, from the
 * first), so one Polar keeps repeating lists the plan for operators after a day
 * (`dissolved-failing`) instead of being retried unseen while the plan renews.
 *
 * The payer is emailed once per plan per period (`dissolve_mailed_period_end`), last, from
 * the mirror: for every plan set to end this period that HushOS asked to end this period
 * (`dissolve_cancelled_at`, written before the call). So a set whose answer was lost (a
 * timeout) is mailed by the retry that finds it ending, and a mail that failed by the next
 * run, which every reconcile queues while one is owed. A plan its payer set to end
 * themselves gets no mail.
 */
export async function cancelDissolvedPlan(groupId: string) {
    const outcome = { cancelled: 0, refused: 0 };
    if (!billingEnabled() || !UUID.test(groupId)) return outcome;
    if ((await billingRepository.listDissolvedChargeable(groupId)).length === 0) return outcome;
    try {
        return await setDissolvedToEnd(groupId, outcome);
    } catch (error) {
        // Retried by pg-boss, but recorded: a failure Polar keeps repeating (a token without
        // write access, a revoked one) is listed for operators after a day, not retried unseen.
        if (!(error instanceof DissolveCancelBusyError))
            await billingRepository.recordDissolveFailing(groupId).catch((failure) =>
                log.warn({
                    message: 'Dissolved family’s failing plan not recorded',
                    billing: { group: groupId, failure: String((failure as Error)?.name) },
                }),
            );
        throw error;
    }
}

async function setDissolvedToEnd(groupId: string, outcome: { cancelled: number; refused: number }) {
    await reconcileGroup(groupId, { fromDissolveCancel: true });
    let asked = false;
    for (const row of await billingRepository.listDissolvedChargeable(groupId)) {
        if (row.ending || row.refusedState === row.state) continue;
        const result = await withPlanChange(
            row.id,
            () => 'busy' as const,
            async () => {
                const read = async () => {
                    try {
                        return await polar().subscriptions.get(row.id);
                    } catch (error) {
                        if (statusOf(error) === 404) return null;
                        throw unavailable(error);
                    }
                };
                const current = await read();
                if (!current) return 'gone' as const;
                if (endingOrEnded(current)) return 'already' as const;
                const state = billingRepository.dissolveStateOf({
                    status: current.status,
                    currentPeriodEnd: current.current_period_end,
                    cancelAtPeriodEnd: current.cancel_at_period_end,
                });
                // Before the call, so an answer lost to a timeout still counts as HushOS's.
                await billingRepository.markDissolveAsked(row.id);
                try {
                    await polar().subscriptions.update(row.id, { cancel_at_period_end: true });
                } catch (error) {
                    const status = statusOf(error);
                    const name = errorName(error);
                    if (status === 403 && name === 'AlreadyCanceledSubscription') {
                        const again = await read();
                        if (!again || endingOrEnded(again)) return 'already' as const;
                        throw unavailable(error);
                    }
                    if (status !== 403 || name !== 'InactiveSubscription') throw unavailable(error);
                    await billingRepository.recordDissolveRefusal(row.id, state, name);
                    log.error({
                        message:
                            'Polar refused to end a dissolved family’s plan: cancel it in Polar',
                        billing: { group: groupId, subscription: row.id, status, refusal: name },
                    });
                    return 'refused' as const;
                }
                await billingRepository.recordDissolveCancel(row.id);
                log.info({
                    message: 'Dissolved family’s plan set to end at its period’s end',
                    billing: { group: groupId, subscription: row.id, cancels: row.cancels + 1 },
                });
                return 'cancelled' as const;
            },
        );
        if (result === 'busy') throw new DissolveCancelBusyError();
        if (result === 'cancelled') outcome.cancelled++;
        if (result === 'refused') outcome.refused++;
        asked = true;
    }
    if (asked) await reconcileGroup(groupId, { fromDissolveCancel: true });
    for (const row of await billingRepository.listDissolvedChargeable(groupId))
        if (
            row.mailOwed &&
            (await billingRepository.claimDissolveMail(row.id, row.currentPeriodEnd))
        )
            await tellPayer(groupId, row.id, row.currentPeriodEnd);
    return outcome;
}

/*
 * The payer is told once per plan per period (the caller claimed it). A mail that fails
 * is logged and the claim given back: the mail is still owed, so the next reconcile (a
 * delivery, the daily one at the latest) queues the job, which sends it. A family whose
 * payer's account is gone keeps the claim, and nobody is mailed.
 * The mail module is loaded here, not with this file: it reads the email settings when it
 * loads, and a process without them (a worker an operator gave none) must still start.
 */
async function tellPayer(groupId: string, subscriptionId: string, endsAt: Date) {
    try {
        const customer = await billingRepository.getGroupCustomer(groupId);
        const payer = customer?.payerUserId
            ? await authRepository.getUserById(customer.payerUserId)
            : null;
        if (!payer) return;
        const { sendFamilyPlanEnding } = await import('@hushos/emails/server');
        await sendFamilyPlanEnding(payer.email, {
            endsOn: endsOnFormat.format(endsAt),
            appUrl: appEnv.APP_ORIGIN,
        });
    } catch (error) {
        await billingRepository.releaseDissolveMail(subscriptionId, endsAt);
        log.warn({
            message: 'Plan ending email not sent',
            billing: { group: groupId, status: statusOf(error) },
        });
    }
}

/* ------------------------------------------------------------------------- */
/* Scheduled cuts                                                             */
/* ------------------------------------------------------------------------- */

/*
 * Where a failed re-issue is queued for another try (pg-boss, with backoff):
 * set by the processes that can send jobs, the web app and the worker. Without
 * one the recorded cut still waits for the daily reconcile.
 */
type RetryQueue = (groupId: string, startAfterSeconds?: number) => Promise<unknown>;
let cutRetryQueue: RetryQueue | undefined;
export function setCutRetryQueue(queue: RetryQueue | undefined) {
    cutRetryQueue = queue;
}

/* A retry now (with the job's backoff), or not before `startAfterSeconds`. */
async function queueCutRetry(groupId: string, startAfterSeconds?: number) {
    if (!cutRetryQueue) {
        log.warn({ message: 'No queue for cut retries', billing: { group: groupId } });
        return;
    }
    // One pending retry per family: claimed on its row until it is due (and the queue itself
    // keeps one per family, stately with the group as its key).
    const live = await billingRepository.getLiveGroupSubscription(groupId);
    const due = Date.now() + Math.max(startAfterSeconds ?? 0, RETRY_CLAIM_SECONDS) * 1000;
    if (live && !(await billingRepository.claimReissueRetry(live.id, new Date(due)))) return;
    try {
        await cutRetryQueue(groupId, startAfterSeconds);
    } catch (error) {
        // Not queued (the queue isn't made yet, the database is busy): the claim goes, so the
        // next reconcile, the daily one at the latest, can queue it.
        if (live) await billingRepository.releaseReissueRetry(live.id);
        log.warn({
            message: 'Cut retry could not be queued',
            billing: { group: groupId, failure: String((error as Error)?.name) },
        });
    }
}

/*
 * Polar's pending update holds a scheduled product change and a scheduled cut
 * side by side (spike 8, T1, 2026-10-18): each `next_period` call overwrites
 * only its own part, in either order, and one call carrying both is refused
 * (422), so each part is its own call. An immediate raise drops only the
 * pending cut; an immediate product change (an upgrade) drops the whole
 * pending update.
 */
/*
 * A reconcile does not ask Polar again within this long of the last time
 * HushOS did: the deliveries a re-issue causes (subscription.updated,
 * customer.state_changed) then find it done or leave it to the daily
 * reconcile and the retry job, never re-issue it themselves.
 */
const REISSUE_GUARD_MS = 15 * 60 * 1000;

/* How many times in a row the same request is sent before HushOS gives up and tells operators. */
export const MAX_REISSUES = 5;

/* An immediate retry (with the job's backoff) holds the family's one retry this long. */
const RETRY_CLAIM_SECONDS = 60;

/* What HushOS wants Polar's pending update to hold: a cut to `units` places, a move to `product`. */
type Pending = { units: number | null; product: string | null };

const pendingOf = (subscription: models.Subscription): Pending => ({
    units: subscription.pending_update?.units ?? null,
    product: subscription.pending_update?.product_id ?? null,
});

/* Whether Polar's pending update holds `want`, as setPending would ask for it. */
function holds(subscription: models.Subscription, want: Pending) {
    const units = subscription.units ?? 0;
    const held = pendingOf(subscription);
    return (
        held.units === (want.units !== null && want.units < units ? want.units : null) &&
        held.product ===
            (want.product !== null && want.product !== subscription.product_id
                ? want.product
                : null)
    );
}

/*
 * Makes Polar's pending update hold exactly `want`, one call per part that
 * differs, and nothing when it already does: every write sets an absolute
 * part of the next period, so asking again is idempotent. Polar cannot drop
 * one part alone, so a part held and no longer wanted clears it first.
 * Returns the subscription as Polar last answered.
 */
async function setPending(groupId: string, subscription: models.Subscription, want: Pending) {
    let current = subscription;
    const units = current.units ?? 0;
    const target: Pending = {
        units: want.units !== null && want.units < units ? want.units : null,
        product: want.product !== null && want.product !== current.product_id ? want.product : null,
    };
    const held = pendingOf(current);
    if (held.units === target.units && held.product === target.product) return current;
    // Neither part can be dropped alone: a part held and no longer wanted clears both first.
    if (
        (held.units !== null && target.units === null) ||
        (held.product !== null && target.product === null)
    )
        current = await polar().subscriptions.update(current.id, { pending_update: null });
    if (target.product !== null && pendingOf(current).product !== target.product)
        current = await polar().subscriptions.update(current.id, {
            product_id: target.product,
            proration_behavior: 'next_period',
        });
    if (target.units !== null && pendingOf(current).units !== target.units)
        current = await polar().subscriptions.update(current.id, {
            units: target.units,
            proration_behavior: 'next_period',
        });
    if (!(await applyChanged(groupId, current, false))) throw unresolvedPlan();
    const after = pendingOf(current);
    if (after.units !== target.units || after.product !== target.product)
        log.warn({
            message: 'Polar holds a different pending update than HushOS asked for',
            billing: { group: groupId, wanted: target, held: after },
        });
    return current;
}

/*
 * Schedules a cut to `target` places at the period's end and records it,
 * beside any tier move HushOS means to have. An admission can commit between
 * the count `target` came from and the cut: the seats this writes refuse any
 * admission after it (the group row orders the two), and the members counted
 * after it catch one that landed before, so the cut is moved up to them, or
 * dropped if that is no cut at all.
 */
async function scheduleCut(
    groupId: string,
    subscriptionId: string,
    units: number,
    target: number,
    stale = false,
) {
    const live = await billingRepository.getLiveGroupSubscription(groupId);
    const product = live?.id === subscriptionId ? live.intendedProductId : null;
    let cut = await setPending(groupId, await polar().subscriptions.get(subscriptionId), {
        units: target,
        product,
    });
    await billingRepository.setIntendedUnits(subscriptionId, target, stale);
    const used = await groupsRepository.seatsUsed(groupId);
    if (used > target) {
        cut = await setPending(groupId, cut, { units: used < units ? used : null, product });
        await billingRepository.setIntendedUnits(subscriptionId, used < units ? used : null, stale);
    }
}

function unresolvedPlan() {
    return new BillingError(
        'This family’s plan could not be read. Nothing more was changed; contact support.',
        503,
    );
}

/*
 * Asks Polar again for the cut and the tier move HushOS recorded, if Polar no
 * longer holds them, in one pass (setPending): idempotent, and nothing is sent
 * when Polar already holds them. A cut never goes below the members admitted
 * or the plan's included count; once the count is no longer above it (the cut
 * applied at renewal), the record is cleared, as is a move once the plan is on
 * that tier or the tier is withdrawn. Parts Polar holds that HushOS has no
 * record of are left alone. `fromReconcile` does not send the same request
 * again within REISSUE_GUARD_MS of the last (records are still tidied); it
 * queues a retry for when the window ends, so a re-issue's own deliveries
 * never repeat it and a needed one is never dropped. A stale revert whose
 * upgrade was paid is withdrawn here, Polar first.
 * Throws when Polar refuses or cannot be reached, so the retry job is retried
 * with backoff.
 */
export async function reissueCut(groupId: string, options: { fromReconcile?: boolean } = {}) {
    if (!billingEnabled()) return;
    const live = await billingRepository.getLiveGroupSubscription(groupId);
    if (!live || (live.intendedUnits === null && live.intendedProductId === null)) return;
    const subscription = await polar().subscriptions.get(live.id);
    const plan = await planOf(subscription.product_id);
    if (!plan) return;
    let product = live.intendedProductId;
    // The stale rule's revert, once the upgrade it was reverting is paid: withdrawn. Polar is
    // written first and the record cleared only after, so a failed write is retried, not lost.
    const withdraw =
        product !== null &&
        live.intendedProductStale &&
        paidTier(live).quotaBytes >= live.quotaBytes;
    if (withdraw) {
        log.info({
            message: 'Stale-upgrade revert withdrawn: the upgrade was paid',
            billing: { group: groupId, product: live.productId },
        });
        product = null;
    }
    if (product !== null && subscription.product_id === product) {
        await billingRepository.setIntendedProduct(live.id, null);
        product = null;
    }
    if (product !== null) {
        const target = (await getFamilyCatalogue()).find((candidate) => candidate.id === product);
        if (!target || target.archived) {
            log.warn({
                message: 'Recorded tier move dropped: the plan is no longer offered',
                billing: { group: groupId, product },
            });
            await billingRepository.setIntendedProduct(live.id, null);
            product = null;
        }
    }
    const units = subscription.units ?? plan.includedMembers;
    let cut = live.intendedUnits;
    if (cut !== null) {
        const target = Math.max(
            cut,
            plan.includedMembers,
            await groupsRepository.seatsUsed(groupId),
        );
        if (target >= units) {
            await billingRepository.setIntendedUnits(live.id, null);
            cut = null;
        } else {
            if (target !== cut)
                await billingRepository.setIntendedUnits(live.id, target, live.intendedStale);
            cut = target;
        }
    }
    const held = pendingOf(subscription);
    const want = {
        units: cut ?? held.units,
        // A withdrawn revert leaves only what it put there; anything else Polar holds stays.
        product:
            product ?? (withdraw && held.product === live.intendedProductId ? null : held.product),
    };
    const done = async () => {
        if (withdraw) await billingRepository.setIntendedProduct(live.id, null);
    };
    if (want.units === held.units && want.product === held.product) {
        // Polar holds it: the count of tries starts again.
        if (live.reissueAttempts > 0 || live.reissuedState !== null)
            await billingRepository.markReissued(live.id, null, 0);
        if (live.reissueGaveUpAt) await billingRepository.setReissueGaveUp(live.id, null);
        return done();
    }
    // Polar refuses changes to a plan set to end; resuming it brings them back here.
    if (subscription.cancel_at_period_end) return;
    // A reconcile soon after asking for exactly this (most likely that write's own delivery)
    // writes nothing, and queues a retry for when the window ends; a different request goes.
    const state = JSON.stringify(want);
    const again = live.reissuedState === state;
    // Polar answered 200 to this MAX_REISSUES times and kept none of it: stop, and put it in
    // front of an operator (the management page), rather than ask again for ever.
    if (again && live.reissueAttempts >= MAX_REISSUES) {
        if (!live.reissueGaveUpAt) {
            await billingRepository.setReissueGaveUp(live.id, new Date(Date.now()), 'not-kept');
            log.error({
                message: 'Family plan’s scheduled change given up: Polar would not keep it',
                billing: { group: groupId, wanted: want, held, attempts: live.reissueAttempts },
            });
        }
        return;
    }
    if (
        options.fromReconcile &&
        live.reissuedAt &&
        again &&
        Date.now() - live.reissuedAt.getTime() < REISSUE_GUARD_MS
    ) {
        const wait = REISSUE_GUARD_MS - (Date.now() - live.reissuedAt.getTime());
        log.warn({
            message: 'Pending update still differs right after the same re-issue; retried later',
            billing: { group: groupId, wanted: want, held, retryInSeconds: Math.ceil(wait / 1000) },
        });
        await queueCutRetry(groupId, Math.ceil(wait / 1000));
        return;
    }
    // Stamped first (the count as it was), so the deliveries this write causes find it and
    // leave it. A failure (a throw, a 5xx, a timeout) counts for nothing: the job retries it.
    const before = again ? live.reissueAttempts : 0;
    await billingRepository.markReissued(live.id, state, before);
    const after = await setPending(groupId, subscription, want);
    // Answered 200: counted only if Polar still doesn't hold it.
    await billingRepository.markReissued(live.id, state, holds(after, want) ? 0 : before + 1);
    await done();
    // An admission that landed while the cut was asked for moves it up (see scheduleCut).
    if (cut === null) return;
    const used = await groupsRepository.seatsUsed(groupId);
    if (used <= cut) return;
    await setPending(groupId, after, { units: used < units ? used : null, product: want.product });
    await billingRepository.setIntendedUnits(
        live.id,
        used < units ? used : null,
        live.intendedStale,
    );
}

/*
 * After a write that drops some of Polar's pending update (an upgrade drops
 * all of it, a raise its cut), the recorded cut and move are asked for again,
 * if missing. A failure is
 * queued for the retry job and the daily reconcile, never thrown: the write
 * before it stands.
 */
async function restorePending(groupId: string) {
    try {
        await reissueCut(groupId);
    } catch (error) {
        log.warn({
            message: 'Recorded pending update not re-issued',
            billing: { group: groupId, status: statusOf(error) },
        });
        await queueCutRetry(groupId);
    }
}

/* ------------------------------------------------------------------------- */
/* Customer, checkout and portal                                              */
/* ------------------------------------------------------------------------- */

/*
 * The family's team customer, made before checkout so the subscription lands
 * on it and not on the payer's own customer (spike 3). Its owner member is the
 * payer, keyed by their user id, which is how their portal session is opened.
 * The family's own name stays here: Polar sees only "HushOS family".
 */
async function ensureTeamCustomer(groupId: string, user: BillingUser) {
    const existing = await billingRepository.getGroupCustomer(groupId);
    if (existing) {
        if (existing.payerUserId !== user.id) await takeOverPayer(groupId, existing, user);
        return existing.providerCustomerId;
    }
    let customer: models.Customer;
    try {
        customer = await polar().customers.create({
            type: 'team',
            external_id: customerKey(groupId),
            name: 'HushOS family',
            owner: { email: user.email, name: user.name, external_id: user.id },
            metadata: {
                hushos_owner_kind: 'group',
                hushos_group_id: groupId,
                hushos_payer: user.id,
            },
        });
    } catch (error) {
        // Made before and its row lost between the two writes: adopt it only for the payer it names.
        if (statusOf(error) !== 409 && statusOf(error) !== 422) throw unavailable(error);
        let found: models.Customer;
        try {
            found = await polar().customers.getExternal(customerKey(groupId));
        } catch {
            throw unavailable(error);
        }
        if (found.type !== 'team' || found.metadata.hushos_payer !== user.id) throw anotherPayer();
        customer = found;
    }
    const row = await billingRepository.recordGroupCustomer({
        groupId,
        provider: PROVIDER,
        providerCustomerId: customer.id,
        payerUserId: user.id,
    });
    if (!row || row.payerUserId !== user.id) throw anotherPayer();
    return row.providerCustomerId;
}

function anotherPayer() {
    return new BillingError(
        'Another member pays for this family’s plan, so only they can change it while it runs.',
        409,
    );
}

/*
 * A family with no live plan, whose payer is someone else (their plan ended,
 * they left, or a checkout was never finished): a `billing` holder starting a
 * checkout becomes the payer. At Polar they join the team customer and take
 * its owner role, which demotes the former owner (spike 3, "When billing
 * passes"); then the former payer is taken off it, so they no longer see the
 * family's invoices. Never while a plan is live, here or at Polar: that card
 * is still being charged, and handing it over waits for a proper handover.
 * The row changes only from the payer read, so two takeovers at once leave
 * one payer.
 */
async function takeOverPayer(
    groupId: string,
    existing: { payerUserId: string | null },
    user: BillingUser,
) {
    if (await billingRepository.getLiveGroupSubscription(groupId)) throw anotherPayer();
    const key = customerKey(groupId);
    let state: models.CustomerState | null = null;
    try {
        state = await polar().customers.getStateExternal(key);
    } catch (error) {
        if (statusOf(error) !== 404) throw unavailable(error);
    }
    if (state?.active_subscriptions.length) {
        await reconcileGroup(groupId);
        throw anotherPayer();
    }
    try {
        try {
            await polar().customers.members.createExternal(key, {
                email: user.email,
                name: user.name,
                external_id: user.id,
                role: 'billing_manager',
            });
        } catch (error) {
            // Already a member of it (an earlier takeover that stopped halfway): promoted below.
            if (statusOf(error) !== 409 && statusOf(error) !== 422) throw error;
        }
        await polar().customers.members.updateExternal(key, user.id, { role: 'owner' });
        await polar().customers.updateExternal(key, {
            metadata: {
                hushos_owner_kind: 'group',
                hushos_group_id: groupId,
                hushos_payer: user.id,
            },
        });
    } catch (error) {
        throw unavailable(error);
    }
    if (!(await billingRepository.setGroupPayer(groupId, existing.payerUserId, user.id)))
        throw anotherPayer();
    log.info({ message: 'Family payer changed', billing: { group: groupId } });
    if (!existing.payerUserId) return;
    try {
        await polar().customers.members.deleteExternal(key, existing.payerUserId);
    } catch (error) {
        log.warn({
            message: 'Former family payer left on the team customer',
            billing: { group: groupId, status: statusOf(error) },
        });
    }
}

/*
 * Polar's hosted checkout for a family plan, for `units` places (at least
 * the plan's included members and the members already admitted, at most the
 * plan's maximum). The person who starts it becomes the payer.
 */
export async function startGroupCheckout(
    user: BillingUser,
    groupId: string,
    input: { productId: string; currency?: string; units?: number; address?: string },
) {
    requireFamilyBilling();
    await familyOf(groupId, user.id, 'billing');
    const plan = (await getFamilyCatalogue()).find(
        (candidate) => candidate.id === input.productId && !candidate.archived,
    );
    if (!plan) throw new BillingError('That plan is not available.', 404);
    if (input.currency !== undefined && !(input.currency in plan.prices))
        throw new BillingError('That plan is not priced in that currency.', 400);
    if (await billingRepository.getLiveGroupSubscription(groupId))
        throw new BillingError('This family already has a plan.', 409);
    const seats = await groupsRepository.seatsUsed(groupId);
    // Everyone's own files draw from the pool once the plan is live, so a first plan (or one
    // bought again) smaller than what they store is refused, as a downgrade is (3.2, 5.2).
    // Checked exactly, said in whole GiB rounded up, as the downgrade guard says it.
    const { used } = await billingRepository.getPoolUsage(groupId);
    const room = BigInt(plan.quotaBytes);
    if (used > room)
        throw new BillingError(
            `${seats > 1 ? 'Your family stores' : 'Your files take'} ${spaceOf(billingRepository.wholeGibUp(used))}, more than ${tierName(plan)}’s ${spaceOf(room)}. Choose a bigger plan or free at least ${spaceOf(billingRepository.wholeGibUp(used - room))}.`,
            409,
        );
    const floor = Math.max(plan.includedMembers, seats);
    const units = input.units ?? floor;
    if (units < floor)
        throw new BillingError(
            'Choose at least as many places as the plan includes and the family has members.',
            400,
        );
    if (units > plan.maxMembers)
        throw new BillingError(`A family can have at most ${plan.maxMembers} members.`, 400);
    const customerId = await ensureTeamCustomer(groupId, user);
    // A plan Polar has that has not reached HushOS yet (a delivery still on its way) is one too.
    let state: models.CustomerState | null = null;
    try {
        state = await polar().customers.getStateExternal(customerKey(groupId));
    } catch (error) {
        if (statusOf(error) !== 404) throw unavailable(error);
    }
    if (state?.active_subscriptions.length) {
        await reconcileGroup(groupId);
        throw new BillingError('This family already has a plan.', 409);
    }
    try {
        const checkout = await polar().checkouts.create({
            products: [plan.id],
            customer_id: customerId,
            currency: (input.currency as models.PresentmentCurrency | undefined) ?? null,
            units,
            min_units: floor,
            max_units: plan.maxMembers,
            customer_ip_address:
                input.address && input.address !== 'unknown' ? input.address : null,
            success_url: `${familyPage()}?checkout_id={CHECKOUT_ID}`,
            return_url: familyPage(),
            allow_trial: false,
            allow_discount_codes: true,
            metadata: { hushos_group_id: groupId },
        });
        return { url: checkout.url };
    } catch (error) {
        throw unavailable(error);
    }
}

/*
 * The payer's portal session. A team customer's session must name the member
 * (spike E1: without one Polar answers 422 "member_id is required"); the payer
 * is the owner member, keyed by their user id.
 */
async function portalFor(groupId: string, payerUserId: string) {
    try {
        const session = await polar().customerSessions.create({
            external_customer_id: customerKey(groupId),
            external_member_id: payerUserId,
            return_url: familyPage(),
        });
        return { url: session.customer_portal_url };
    } catch (error) {
        if (statusOf(error) === 404 || statusOf(error) === 422)
            throw new BillingError(
                'Polar does not list you as this family’s payer. Contact support.',
                409,
                { cause: error },
            );
        throw unavailable(error);
    }
}

async function requirePayer(groupId: string, userId: string) {
    const customer = await billingRepository.getGroupCustomer(groupId);
    if (!customer) throw new BillingError('This family has no billing account yet.', 404);
    if (customer.payerUserId !== userId)
        throw new BillingError('Only the person who pays for this family can do that.', 403);
    return customer;
}

/* The payer's portal, open to them even after they left: they can always stop paying. */
export async function createGroupPortalSession(user: BillingUser, groupId: string) {
    requireFamilyBilling();
    await requirePayer(groupId, user.id);
    return portalFor(groupId, user.id);
}

/*
 * Whether this person pays for the family's live plan, one HushOS cannot read
 * included. While they do, they may not leave it (nor dissolve it as its last
 * member): the card on its customer is theirs and would go on being charged.
 */
export async function paysForGroup(groupId: string, userId: string) {
    if (!billingEnabled()) return false;
    return (await billingRepository.listGroupsPaidBy(userId)).includes(groupId);
}

/*
 * Whether the family may invite and make family folders: with billing off,
 * always; with it on, only while a plan is live (docs/groups-design.md 3.5).
 * Without one nobody can be let in and the pool is empty.
 */
export async function familyHasPlan(groupId: string) {
    if (!billingEnabled()) return true;
    return (await billingRepository.getLiveGroupSubscription(groupId)) !== null;
}

/* ------------------------------------------------------------------------- */
/* Places                                                                     */
/* ------------------------------------------------------------------------- */

/* Why a place could not be had, or that it was. */
export type SeatResult =
    | { status: 'ok' }
    /* No live plan: buy one first. */
    | { status: 'no-plan' }
    /* Someone other than the payer would have to pay for it. */
    | { status: 'payer' }
    /* Past the plan's maximum, or more than one raise may add. */
    | { status: 'cap'; max: number; step: number }
    /* The plan is set to end; Polar refuses quantity changes until it is resumed. */
    | { status: 'canceling' }
    /* 402 PaymentFailed: the bank declined; nothing changed and nothing waits in the portal. */
    | { status: 'declined' }
    /* 402 PaymentActionRequired: the bank wants the payer to confirm, in the portal. */
    | { status: 'confirm'; url: string | null }
    /* Any other refused payment. */
    | { status: 'payment' }
    /* Another place purchase or an upgrade is under way for this family. */
    | { status: 'busy' }
    /* Polar charged for the place, but billed it on a plan changed meanwhile: nobody let in. */
    | { status: 'changed' }
    | { status: 'unavailable' };

/* A refused raise, by what Polar said. */
function refusedRaise(error: unknown): SeatResult {
    if (statusOf(error) === 402) {
        const kind = (error as PolarClientError<{ error?: string }>).error?.error;
        if (kind === 'PaymentFailed') return { status: 'declined' };
        if (kind === 'PaymentActionRequired') return { status: 'confirm', url: null };
        return { status: 'payment' };
    }
    // AlreadyCanceledSubscription: set to cancel at the period's end (spike E3, step 8).
    if (statusOf(error) === 403) return { status: 'canceling' };
    log.warn({ message: 'Group raise failed', billing: { status: statusOf(error) } });
    return { status: 'unavailable' };
}

/*
 * Moves the live plan to `target` places for the payer. Above the current
 * count it is a raise, capped (Polar has none) and charged at once; at or
 * below it, a scheduled cut that stands in the way is moved up to `target`,
 * free. After a raise, a cut that was scheduled is put back, never below
 * `floor` (the members admitted, and the plan's included count). Local state
 * is written from Polar's answers, so a seat bought is a seat HushOS counts.
 */
async function changePlaces(
    groupId: string,
    live: { id: string; paidUnits: number },
    target: number,
): Promise<SeatResult> {
    let subscription: models.Subscription;
    try {
        subscription = await polar().subscriptions.get(live.id);
    } catch (error) {
        log.warn({ message: 'Group plan read failed', billing: { status: statusOf(error) } });
        return { status: 'unavailable' };
    }
    const plan = await planOf(subscription.product_id);
    if (!plan) return { status: 'no-plan' };
    const current = subscription.units ?? plan.includedMembers;
    const cap = { status: 'cap' as const, max: plan.maxMembers, step: MAX_MEMBERS_PER_RAISE };
    if (target > plan.maxMembers) return cap;
    if (subscription.cancel_at_period_end) return { status: 'canceling' };
    if (target <= current) return placesHeld(groupId, live, subscription, target);
    if (target - current > MAX_MEMBERS_PER_RAISE) return cap;
    // One plan change at a time: a raise and an upgrade never run together for a family. The
    // raise works from a read taken under the claim, never from the one above.
    return withPlanChange(
        live.id,
        (): SeatResult => ({ status: 'busy' }),
        async () => {
            let held: models.Subscription;
            try {
                held = await polar().subscriptions.get(live.id);
            } catch (error) {
                log.warn({
                    message: 'Group plan read failed',
                    billing: { status: statusOf(error) },
                });
                return { status: 'unavailable' };
            }
            const heldPlan = await planOf(held.product_id);
            if (!heldPlan) return { status: 'no-plan' };
            const now = held.units ?? heldPlan.includedMembers;
            if (held.cancel_at_period_end) return { status: 'canceling' };
            if (target > heldPlan.maxMembers) return cap;
            // A raise that landed meanwhile may already hold the place.
            if (target <= now) return placesHeld(groupId, live, held, target);
            if (target - now > MAX_MEMBERS_PER_RAISE) return cap;
            return raisePlaces(groupId, live, held, target, held.pending_update?.units ?? null);
        },
    );
}

/*
 * A place the plan already has: open once paid (a raise awaiting the bank opens
 * nothing; asking Polar again would charge nothing), and a scheduled cut that
 * would take it is moved up, free.
 */
async function placesHeld(
    groupId: string,
    live: { id: string; paidUnits: number },
    subscription: models.Subscription,
    target: number,
): Promise<SeatResult> {
    const plan = await planOf(subscription.product_id);
    const current = subscription.units ?? plan?.includedMembers ?? 0;
    const cut = subscription.pending_update?.units ?? null;
    if (target > live.paidUnits) {
        await reconcileGroup(groupId);
        const fresh = await billingRepository.getLiveGroupSubscription(groupId);
        if (!fresh || fresh.paidUnits < target) return { status: 'confirm', url: null };
    }
    if (cut === null || cut >= target) return { status: 'ok' };
    try {
        const intended = await billingRepository.getLiveGroupSubscription(groupId);
        await setPending(groupId, subscription, {
            units: target < current ? target : null,
            product: intended?.id === live.id ? intended.intendedProductId : null,
        });
        await billingRepository.setIntendedUnits(live.id, target < current ? target : null);
        return { status: 'ok' };
    } catch (error) {
        return refusedRaise(error);
    }
}

/*
 * The orders a raise made: change orders for the product Polar billed it on, at
 * its count of places, since it was asked for. Unreadable, none (logged).
 */
async function raiseOrders(raised: models.Subscription, units: number, since: number) {
    try {
        const orders = (
            await polar().orders.list({
                subscription_id: raised.id,
                product_id: raised.product_id,
                sorting: ['-created_at'],
                limit: 10,
            })
        ).items;
        return orders
            .filter(
                (order) =>
                    order.billing_reason === 'subscription_update' &&
                    order.product_id === raised.product_id &&
                    order.units === units &&
                    Date.parse(order.created_at) >= since - 60_000,
            )
            .map((order) => order.id);
    } catch (error) {
        log.warn({
            message: 'A raise’s orders could not be read to set them aside',
            billing: { status: statusOf(error) },
        });
        return [];
    }
}

/* The raise itself, holding the family's plan-change claim (changePlaces). */
async function raisePlaces(
    groupId: string,
    live: { id: string; paidUnits: number },
    subscription: models.Subscription,
    target: number,
    cut: number | null,
): Promise<SeatResult> {
    // No raise on top of an upgrade the bank hasn't confirmed: the two orders never interleave.
    // Polar's product, just read, against the tier paid for: a row a failed write left behind
    // can't open a place.
    // The tier paid for is read from Polar's orders now, not taken from the row: a refund
    // since the last reconcile can't leave a place open.
    if (!(await applyChanged(groupId, subscription, false))) return { status: 'no-plan' };
    const row = await billingRepository.getLiveGroupSubscription(groupId);
    if (row && subscription.product_id !== paidTier(row).productId)
        return { status: 'confirm', url: null };
    const startedAt = Date.now();
    let raised: models.Subscription;
    try {
        raised = await polar().subscriptions.update(subscription.id, {
            units: target,
            proration_behavior: 'invoice',
        });
    } catch (error) {
        return refusedRaise(error);
    }
    // Billed on another product than the one it was asked on (changed outside HushOS meanwhile):
    // its places and its order are not credited, and the plan is read again from Polar.
    if (raised.product_id !== subscription.product_id) {
        log.error({
            message: 'A raise was billed on another product than it was asked on; not credited',
            billing: { group: groupId, asked: subscription.product_id, billed: raised.product_id },
        });
        await billingRepository.addUncreditedOrders(
            live.id,
            await raiseOrders(raised, target, startedAt),
        );
        await applyChanged(groupId, raised, false);
        await reconcileGroup(groupId);
        return { status: 'changed' };
    }
    // The raise replaced any scheduled cut at Polar (spike E3): the payer asked for more places
    // now, so the cut is not put back, or they would pay for places they could not fill.
    // A scheduled tier move survives it (T1); restorePending below only checks.
    if (cut !== null) await billingRepository.setIntendedUnits(live.id, null);
    // Paid only when Polar shows no order waiting; one that cannot be read is not paid yet.
    const paid = (await orderState(subscription.id)).unpaid === false;
    await applyChanged(groupId, raised, paid);
    // Polar keeps a scheduled move through a raise; were it lost, it is asked for again.
    await restorePending(groupId);
    return paid ? { status: 'ok' } : { status: 'confirm', url: null };
}

/*
 * Before an admission is written: a place for one more member. Without
 * billing nothing is asked. With it, the plan must have room (a scheduled cut
 * counts), or the payer, and only the payer, buys the place now; the
 * admission goes ahead only on Polar's 200. The repository counts the seats
 * again under the group's lock, against the limit this wrote.
 */
export async function ensureGroupSeat(groupId: string, admitterId: string): Promise<SeatResult> {
    if (!billingEnabled()) return { status: 'ok' };
    const live = await billingRepository.getLiveGroupSubscription(groupId);
    if (!live) return { status: 'no-plan' };
    const used = await groupsRepository.seatsUsed(groupId);
    const target = used + 1;
    if (target <= billingRepository.seatLimitOf(live)) return { status: 'ok' };
    const customer = await billingRepository.getGroupCustomer(groupId);
    if (!customer || customer.payerUserId !== admitterId) return { status: 'payer' };
    const result = await changePlaces(groupId, live, target);
    if (result.status !== 'confirm') return result;
    return {
        status: 'confirm',
        url: await portalFor(groupId, admitterId).then(
            (portal) => portal.url,
            () => null,
        ),
    };
}

/*
 * The payer sets the number of places: more is charged now (capped, and
 * refused whole on a 402), fewer is scheduled for the period's end and never
 * below the members admitted or the plan's included count.
 */
export async function setGroupUnits(user: BillingUser, groupId: string, units: number) {
    requireFamilyBilling();
    // The payer may always pay for less, even after leaving the family; adding needs a member.
    await requirePayer(groupId, user.id);
    const live = await billingRepository.getLiveGroupSubscription(groupId);
    if (!live) throw new BillingError('This family has no plan.', 404);
    const used = await groupsRepository.seatsUsed(groupId);
    const floor = Math.max(live.includedMembers, used);
    if (units < floor)
        throw new BillingError(
            'A family cannot have fewer places than its members, or than its plan includes.',
            400,
        );
    if (units < live.units) {
        // A plan HushOS cannot read is never changed blind.
        if (!(await planOf(live.productId))) throw unresolvedPlan();
        try {
            await scheduleCut(groupId, live.id, live.units, units);
        } catch (error) {
            if (error instanceof BillingError) throw error;
            throw unavailable(error);
        }
        return { billing: await getGroupBilling(user, groupId), url: null };
    }
    await familyOf(groupId, user.id, 'billing');
    const result = await changePlaces(groupId, live, units);
    switch (result.status) {
        case 'ok':
            return { billing: await getGroupBilling(user, groupId), url: null };
        case 'confirm':
            return {
                billing: await getGroupBilling(user, groupId),
                url: (await portalFor(groupId, user.id)).url,
                confirmPayment: true as const,
            };
        default:
            throw seatError(result);
    }
}

/* Said when Polar has charged for a place on a plan that changed meanwhile: never "try again". */
const CHARGED_BUT_CHANGED =
    'The charge went through but the plan changed at the same time. Refresh to see your places.';

/* Said when a place purchase and an upgrade meet: one waits for the other. */
const BUSY = 'Another change to this plan is in progress. Try again in a moment.';

/* How long a plan change holds its claim: well past Polar's timeouts, short enough to lapse. */
const CHANGE_CLAIM_MS = 2 * 60 * 1000;

/*
 * Runs `work` holding the family's one plan-change claim (place purchases and
 * upgrades), or answers `busy` when another holds it. Released however `work` ends.
 */
async function withPlanChange<T>(subscriptionId: string, busy: () => T, work: () => Promise<T>) {
    const claim = await billingRepository.claimPlanChange(subscriptionId, CHANGE_CLAIM_MS);
    if (!claim) return busy();
    try {
        return await work();
    } finally {
        // Only this claim: one that ran out and was taken by another change stays theirs.
        await billingRepository.releasePlanChange(subscriptionId, claim);
    }
}

/* ------------------------------------------------------------------------- */
/* Tiers                                                                      */
/* ------------------------------------------------------------------------- */

const tierName = (plan: { name: string }) =>
    plan.name.replace(/\s*\((monthly|yearly|annual)\)\s*$/i, '');

export type PlanChange = {
    billing: GroupBillingSummary;
    url: string | null;
    confirmPayment?: true;
    /* A bigger tier, now; a smaller one, at the period's end; or a scheduled move withdrawn. */
    when: 'now' | 'renewal' | 'kept';
};

/*
 * The payer moves the family to another tier billed the same way (monthly or
 * yearly). Places carry over: a product change at Polar keeps `units`, and
 * every tier includes the same members.
 *
 * - A bigger pool is an upgrade: the product changes now, and the difference
 *   for the rest of the period is charged at once (`invoice`), as a personal
 *   plan switch is. Only a member who holds `billing` may, and not while the
 *   bank still has a charge to confirm. A 402 changes nothing; a bank that
 *   wants confirmation sends the payer to the portal.
 * - A smaller pool is a downgrade, scheduled for the period's end
 *   (`next_period`), so nothing is credited to a wallet that cannot be paid
 *   out and the family keeps what it paid for. It is refused while the family
 *   folders hold more than the smaller pool. The payer may do it even after
 *   leaving, as they may always pay for less. It is recorded, since a raise
 *   deletes Polar's pending update, and asked for again after one.
 * - The family's own tier withdraws a scheduled move.
 *
 * A plan set to end, or with a renewal the bank refused, is not changed.
 */
export async function changeGroupPlan(
    user: BillingUser,
    groupId: string,
    productId: string,
): Promise<PlanChange> {
    requireFamilyBilling();
    await requirePayer(groupId, user.id);
    const live = await billingRepository.getLiveGroupSubscription(groupId);
    if (!live) throw new BillingError('This family has no plan.', 404);
    const catalogue = await getFamilyCatalogue();
    const target = catalogue.find((candidate) => candidate.id === productId);
    if (!target || (!offeredFamilies(catalogue).includes(target) && target.id !== live.productId))
        throw new BillingError('That plan is not available.', 404);
    let subscription: models.Subscription;
    try {
        subscription = await polar().subscriptions.get(live.id);
    } catch (error) {
        throw unavailable(error);
    }
    const current = catalogue.find((candidate) => candidate.id === subscription.product_id);
    // A plan HushOS cannot read is never changed blind.
    if (!current) throw unresolvedPlan();
    if (subscription.cancel_at_period_end)
        throw new BillingError(
            'This family plan is set to end. Resume it in the billing portal first.',
            409,
        );
    if (subscription.status === 'past_due')
        throw new BillingError(
            'The last payment for this family’s plan didn’t go through. Update the card in the billing portal first.',
            409,
        );
    const done = async (when: PlanChange['when']): Promise<PlanChange> => ({
        billing: await getGroupBilling(user, groupId),
        url: null,
        when,
    });

    if (target.id === current.id) {
        const pending = subscription.pending_update?.product_id ?? null;
        if (pending === null && live.intendedProductId === null)
            throw new BillingError('The family is already on that plan.', 409);
        await billingRepository.setIntendedProduct(live.id, null);
        if (pending !== null)
            // Polar can't drop the move alone: the pending update is set again without it.
            await asBillingError(() =>
                setPending(groupId, subscription, {
                    units: live.intendedUnits ?? pendingOf(subscription).units,
                    product: null,
                }),
            );
        return done('kept');
    }
    if (target.interval !== current.interval)
        throw new BillingError(
            current.interval === 'year'
                ? 'Choose another yearly plan. A family plan can’t switch between monthly and yearly yet.'
                : 'Choose another monthly plan. A family plan can’t switch between monthly and yearly yet.',
            400,
        );
    const currency = subscription.currency;
    if (!(currency in target.prices))
        throw new BillingError('That plan is not priced in the family’s currency.', 400);
    const units = subscription.units ?? current.includedMembers;
    if (units < target.includedMembers)
        throw new BillingError('That plan includes more places than the family has.', 400);
    const bigger = BigInt(target.quotaBytes) > BigInt(current.quotaBytes);
    if (!bigger && BigInt(target.quotaBytes) === BigInt(current.quotaBytes))
        throw new BillingError('That plan has the same storage as the family’s.', 400);

    if (bigger)
        // One plan change at a time: an upgrade and a place purchase never run together.
        return withPlanChange(
            live.id,
            (): never => {
                throw new BillingError(BUSY, 409);
            },
            async (): Promise<PlanChange> => {
                await familyOf(groupId, user.id, 'billing');
                // Read again under the claim: the guard and the change work from this, never from
                // a copy a place purchase finished after.
                let held: models.Subscription;
                try {
                    held = await polar().subscriptions.get(live.id);
                } catch (error) {
                    throw unavailable(error);
                }
                if (
                    held.product_id !== subscription.product_id ||
                    held.cancel_at_period_end ||
                    held.status === 'past_due'
                )
                    throw new BillingError(
                        'This plan changed a moment ago. Look at it again before changing it.',
                        409,
                    );
                // The tier paid for, read from Polar's orders now (a refund since the last reconcile).
                if (!(await applyChanged(groupId, held, false))) throw unresolvedPlan();
                const fresh = (await billingRepository.getLiveGroupSubscription(groupId)) ?? live;
                // Nothing stacks on a charge the bank hasn't confirmed: places, or an upgrade.
                if (
                    fresh.paidUnits < fresh.units ||
                    paidTier(fresh).quotaBytes < fresh.quotaBytes ||
                    held.product_id !== paidTier(fresh).productId
                )
                    throw new BillingError(
                        'Your bank hasn’t confirmed the last charge yet. Confirm it in Manage payment and invoices, then change the plan.',
                        409,
                    );
                let changed: models.Subscription;
                try {
                    changed = await polar().subscriptions.update(held.id, {
                        product_id: target.id,
                        proration_behavior: 'invoice',
                    });
                } catch (error) {
                    const refused = refusedRaise(error);
                    if (refused.status === 'confirm') {
                        // The bank wants the payer: whatever Polar now holds is written, never left stale.
                        await writeAsPolarHolds(groupId, held.id);
                        return {
                            billing: await getGroupBilling(user, groupId),
                            url: (await portalFor(groupId, user.id)).url,
                            confirmPayment: true,
                            when: 'now',
                        };
                    }
                    // Declined: nothing changed at Polar (spike 8, T2: 0341).
                    throw planChangeError(refused);
                }
                // The move replaces any scheduled one. Its tier counts once an order for it is paid:
                // until then the family keeps the tier and pool it paid for.
                await billingRepository.setIntendedProduct(live.id, null);
                // The places are unchanged (their paid count stays); the tier from Polar's orders. Polar has
                // changed the product: a write that fails here is put right from Polar at once.
                let applied: boolean;
                try {
                    applied = await applyChanged(groupId, changed, false);
                } catch (error) {
                    log.warn({
                        message: 'Upgrade not written after Polar took it; reconciling',
                        billing: { group: groupId, failure: String((error as Error)?.name) },
                    });
                    await reconcileGroup(groupId);
                    applied = (await billingRepository.getLiveGroupSubscription(groupId)) !== null;
                }
                if (!applied) throw unresolvedPlan();
                const paid =
                    (await billingRepository.getLiveGroupSubscription(groupId))?.paidProductId ===
                    target.id;
                log.info({
                    message: 'Family plan upgraded',
                    billing: { group: groupId, from: current.id, to: target.id, paid },
                });
                // Polar dropped the whole pending update with the change (T1): a recorded cut is asked
                // for again; a scheduled downgrade is not, the upgrade replaced it (cleared above).
                await restorePending(groupId);
                // The charge waits for the bank (3-D Secure, an Indian e-mandate): its portal carries it.
                if (!paid)
                    return {
                        billing: await getGroupBilling(user, groupId),
                        url: (await portalFor(groupId, user.id)).url,
                        confirmPayment: true,
                        when: 'now',
                    };
                return done('now');
            },
        );

    // Everything the pool holds: the family folders and every pooled member's own files, as the
    // pool counts them, part by part in whole GiB (pool.ts PoolPart), so the guard can't be
    // probed for another member's bytes (docs/families-shared-pool.md 3.6, 3.9).
    const { used } = await billingRepository.getPoolUsage(groupId);
    const room = BigInt(target.quotaBytes);
    if (used > room)
        throw new BillingError(
            `Your family stores ${spaceOf(billingRepository.wholeGibUp(used))}, more than ${tierName(target)}’s ${spaceOf(room)}. Free at least ${spaceOf(billingRepository.wholeGibUp(used - room))}, then change the plan.`,
            409,
        );
    // The move and any recorded cut together, as Polar's one pending update must hold them.
    await asBillingError(() =>
        setPending(groupId, subscription, {
            units: live.intendedUnits ?? pendingOf(subscription).units,
            product: target.id,
        }),
    );
    await billingRepository.setIntendedProduct(live.id, target.id);
    log.info({
        message: 'Family plan downgrade scheduled',
        billing: { group: groupId, from: current.id, to: target.id },
    });
    return done('renewal');
}

/*
 * Writes the subscription as Polar holds it now, after a call whose answer was
 * an error but which may have changed it (a 402 that wants the bank). A
 * failure is left to the next reconcile, and logged.
 */
async function writeAsPolarHolds(groupId: string, subscriptionId: string) {
    try {
        await applyChanged(groupId, await polar().subscriptions.get(subscriptionId), false);
    } catch (error) {
        log.warn({
            message: 'Family plan not re-read after a refused change',
            billing: { group: groupId, status: statusOf(error) },
        });
    }
}

/* A Polar failure as the payer reads it; HushOS's own refusals pass through. */
async function asBillingError<T>(run: () => Promise<T>) {
    try {
        return await run();
    } catch (error) {
        if (error instanceof BillingError) throw error;
        throw unavailable(error);
    }
}

/* The tier and pool a plan has paid for (null and 0 while nothing is): from its newest paid order. */
function paidTier(live: { paidProductId: string | null; paidQuotaBytes: bigint | null }) {
    return { productId: live.paidProductId, quotaBytes: live.paidQuotaBytes ?? 0n };
}

/* A refused upgrade, in words about the plan rather than places. */
function planChangeError(result: SeatResult) {
    switch (result.status) {
        case 'declined':
            return new BillingError(
                'Your bank declined this charge. Nothing was charged and the plan didn’t change. Try another card in the billing portal, or ask your bank.',
                402,
            );
        case 'payment':
            return new BillingError(
                'The payment did not go through, so the plan didn’t change. Try again later.',
                402,
            );
        case 'canceling':
            return new BillingError(
                'This family plan is set to end. Resume it in the billing portal first.',
                409,
            );
        default:
            return new BillingError('Billing is temporarily unavailable. Please try again.', 503);
    }
}

/* The sentence for a place that could not be had, on billing's own routes. */
export function seatError(result: Exclude<SeatResult, { status: 'ok' | 'confirm' }>) {
    switch (result.status) {
        case 'declined':
            return new BillingError(
                'Your bank declined this charge. Nothing was charged and no places were added. Try another card in the billing portal, or ask your bank.',
                402,
            );
        case 'payment':
            return new BillingError(
                'The payment did not go through, so no places were added. Try again later.',
                402,
            );
        case 'busy':
            return new BillingError(BUSY, 409);
        case 'changed':
            return new BillingError(CHARGED_BUT_CHANGED, 409);
        case 'cap':
            return new BillingError(
                `A family can have at most ${result.max} members, and one change can add at most ${result.step} places.`,
                400,
            );
        case 'canceling':
            return new BillingError(
                'This family plan is set to end. Resume it in the billing portal first.',
                409,
            );
        case 'no-plan':
            return new BillingError('This family has no plan.', 404);
        case 'payer':
            return new BillingError('Only the person who pays for this family can do that.', 403);
        case 'unavailable':
            return new BillingError('Billing is temporarily unavailable. Please try again.', 503);
    }
}

/* ------------------------------------------------------------------------- */
/* Summary                                                                    */
/* ------------------------------------------------------------------------- */

/*
 * Who may see a family's plan, and how much: its `billing` holders, and its
 * payer, who keeps seeing it after leaving so they can stop paying, see all
 * of it; any other active member, a manager without `billing` included, sees
 * the glance. Anyone else is told the family does not exist.
 */
async function planView(groupId: string, userId: string): Promise<'manage' | 'member'> {
    try {
        await familyOf(groupId, userId, 'billing');
        return 'manage';
    } catch (error) {
        const customer = await billingRepository.getGroupCustomer(groupId);
        if (
            customer?.payerUserId === userId &&
            (await billingRepository.getLiveGroupSubscription(groupId))
        )
            return 'manage';
        if (!(error instanceof BillingError) || error.status !== 403) throw error;
        return 'member';
    }
}

async function seesPlan(groupId: string, userId: string) {
    if ((await planView(groupId, userId)) !== 'manage')
        throw new BillingError('Only someone who manages this family’s plan can do that.', 403);
}

/* Each sync reads Polar several times: ten a person per family every ten minutes. */
const SYNC_LIMIT = { count: 10, windowMs: 10 * 60 * 1000 };

/* After a checkout or a portal visit: the family's state re-read from Polar now. */
export async function syncGroup(user: BillingUser, groupId: string) {
    requireFamilyBilling();
    await seesPlan(groupId, user.id);
    const bucket = createHash('sha256').update(`billing:group-sync:${groupId}:${user.id}`).digest();
    if (!(await authRepository.consumeRateLimit(bucket, SYNC_LIMIT.count, SYNC_LIMIT.windowMs)))
        throw new BillingError(
            'Too many refreshes just now. Please try again in a few minutes.',
            429,
        );
    await reconcileGroup(groupId);
    return getGroupBilling(user, groupId);
}

const GIB = 1n << 30n;

/*
 * One member's own files as a manager sees them (3.9, decision 6): whole GiB,
 * rounded up, and "0" for anything under 1 GiB, which the page reads "Under 1
 * GB". Rounded here, so the exact bytes never reach another member's browser.
 */
export function roundedOwnBytes(bytes: bigint) {
    return bytes < GIB ? 0n : billingRepository.wholeGibUp(bytes);
}

/*
 * What the caller may see of who stores what (3.9): their own files exactly; the
 * family folders' total in whole GiB, rounded up; and, for every `members` or
 * `billing` holder (the organizer holds both), each member's own files rounded (roundedOwnBytes),
 * largest first. Anyone not an active member (a payer who left) sees neither theirs
 * nor anyone's.
 */
async function usageFor(groupId: string, userId: string): Promise<FamilyUsage> {
    const [found, usage] = await Promise.all([
        groupsRepository.getGroupFor(groupId, userId),
        billingRepository.getMemberUsage(groupId),
    ]);
    const active = found?.membership.state === 'active';
    // The organizer holds both roles from the start; whoever holds either now manages.
    const manages =
        active &&
        (found.membership.roles.includes('members') || found.membership.roles.includes('billing'));
    const own = usage.members.find((member) => member.userId === userId);
    return {
        ownBytes: active && own ? own.usedBytes.toString() : null,
        foldersBytes: billingRepository.wholeGibUp(usage.foldersBytes).toString(),
        members: manages
            ? usage.members
                  .map((member) => ({
                      userId: member.userId,
                      rounded: roundedOwnBytes(member.usedBytes),
                  }))
                  .sort((a, b) =>
                      a.rounded === b.rounded
                          ? a.userId.localeCompare(b.userId)
                          : a.rounded > b.rounded
                            ? -1
                            : 1,
                  )
                  .map((member) => ({
                      userId: member.userId,
                      ownBytesRounded: member.rounded.toString(),
                  }))
            : null,
    };
}

export async function getGroupBilling(
    user: BillingUser,
    groupId: string,
): Promise<GroupBillingSummary> {
    if (!groupsEnv.GROUPS_ENABLED)
        throw new BillingError('This server does not offer families yet.', 404);
    const view = await planView(groupId, user.id);
    if (!billingEnabled())
        return view === 'manage'
            ? {
                  enabled: false,
                  view,
                  plans: [],
                  payer: null,
                  subscription: null,
                  lastPlan: null,
                  storage: null,
                  seats: await (async () => {
                      const used = await groupsRepository.seatsUsed(groupId);
                      return { used, limit: used };
                  })(),
                  nextPlace: null,
              }
            : { enabled: false, view, hasPlan: false, planName: null, storage: null };
    const [live, pool, usage, people] = await Promise.all([
        billingRepository.getLiveGroupSubscription(groupId),
        billingRepository.getGroupPool(groupId),
        billingRepository.getPoolUsage(groupId),
        usageFor(groupId, user.id),
    ]);
    // The pool as Drive's free-space check reads it: its folders and every pooled member's own
    // files against the plan's quota, which is empty before a plan and past its period and grace.
    const storage = pool
        ? {
              // Counted part by part in whole GiB: exact, it would give away one member's usage.
              usedBytes: usage.used.toString(),
              quotaBytes:
                  pool.expiresAt !== null && pool.expiresAt.getTime() > Date.now()
                      ? pool.quotaBytes.toString()
                      : '0',
          }
        : null;
    // A member who does not hold `billing` sees what the family has, never what it costs.
    if (view === 'member')
        return {
            enabled: true,
            view,
            hasPlan: live !== null,
            planName: live?.productName ?? null,
            storage,
            usage: people,
        };
    const [families, customer, used] = await Promise.all([
        getFamilyCatalogue(),
        billingRepository.getGroupCustomer(groupId),
        groupsRepository.seatsUsed(groupId),
    ]);
    const lastPlan = live ? null : await billingRepository.getLastEndedGroupSubscription(groupId);
    const plan = live ? families.find((candidate) => candidate.id === live.productId) : undefined;
    const price = plan && live?.currency ? plan.prices[live.currency] : undefined;
    return {
        enabled: true,
        view,
        // What a page may offer, and the family's own plan, so it is always priced.
        plans: families
            .filter(
                (candidate) => offeredFamilies(families).includes(candidate) || candidate === plan,
            )
            .map(({ archived: _archived, createdAt: _createdAt, ...rest }) => rest),
        payer: customer?.payerUserId
            ? { userId: customer.payerUserId, you: customer.payerUserId === user.id }
            : null,
        subscription: live
            ? {
                  id: live.id,
                  productId: live.productId,
                  productName: live.productName,
                  status: live.status,
                  recurringInterval: live.recurringInterval,
                  amount: live.amount,
                  currency: live.currency,
                  units: live.units,
                  paidUnits: live.paidUnits,
                  pendingUnits: live.pendingUnits,
                  pendingProductId: live.pendingProductId,
                  paidProductId: paidTier(live).productId,
                  includedMembers: live.includedMembers,
                  quotaBytes: live.quotaBytes.toString(),
                  currentPeriodStart: live.currentPeriodStart.toISOString(),
                  currentPeriodEnd: live.currentPeriodEnd.toISOString(),
                  cancelAtPeriodEnd: live.cancelAtPeriodEnd,
              }
            : null,
        lastPlan: lastPlan
            ? { productName: lastPlan.productName, endedAt: lastPlan.endedAt.toISOString() }
            : null,
        storage,
        usage: people,
        seats: { used, limit: live ? billingRepository.seatLimitOf(live) : UNPAID_GROUP_SEATS },
        nextPlace:
            live && price && live.currency
                ? {
                      amount: quoteUnitsChange({
                          perMember: price.perMember,
                          includedMembers: live.includedMembers,
                          fromUnits: live.units,
                          toUnits: live.units + 1,
                          periodStart: live.currentPeriodStart,
                          periodEnd: live.currentPeriodEnd,
                      }),
                      currency: live.currency,
                  }
                : null,
    };
}
