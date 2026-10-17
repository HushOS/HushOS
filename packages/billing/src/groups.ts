import { createHash } from 'node:crypto';
import { authRepository, billingRepository, groupsRepository } from '@hushos/db';
import { appEnv } from '@hushos/env/app';
import { billingEnv } from '@hushos/env/billing';
import { groupsEnv } from '@hushos/env/groups';
import { log } from '@hushos/logging';
import type { models } from '@polar-sh/sdk/2026-10';
import type { PolarClientError } from '@polar-sh/sdk';
import type { GroupBillingSummary } from './api';
import {
    BillingError,
    PROVIDER,
    billingEnabled,
    getFamilyCatalogue,
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
} from './protocol';

/* Pure, so the web quotes a raise with the server's own arithmetic. */
export { quoteUnitsChange };

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
const familyPage = (groupId: string) => `${appEnv.APP_ORIGIN}/app/families/${groupId}`;

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
 * One subscription as a change returned it, written without touching the
 * group's others. `paid` says the places it now has are paid for (a raise
 * Polar answered with 200 and no order waits); otherwise the paid count stays
 * where it was.
 */
async function applyChanged(groupId: string, subscription: models.Subscription, paid: boolean) {
    const plan = await planOf(subscription.product_id);
    if (!plan) return false;
    await billingRepository.applyGroupState({
        groupId,
        provider: PROVIDER,
        customerId: null,
        subscriptions: [snapshotOf(subscription, plan, paid)],
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
export async function reconcileGroup(groupId: string) {
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
        subscriptions.push(snapshotOf(subscription, plan, orders?.unpaid === false));
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
    const liveCount =
        subscriptions.filter((s) => !s.endedAt && LIVE.has(s.status)).length + unresolved.length;
    if (liveCount > 1)
        log.warn({
            message: 'Group has more than one live subscription',
            billing: { group: groupId, live: liveCount },
        });
    const live = await billingRepository.getLiveGroupSubscription(groupId);
    if (live && (await revokeWithoutPayer(groupId, live))) return;
    const used = await groupsRepository.seatsUsed(groupId);
    // Changed outside HushOS (the dashboard, support): never remove anyone, but say so.
    if (live && live.units < used)
        log.warn({
            message: 'Group plan has fewer places than admitted members',
            billing: { group: groupId, units: live.units, admitted: used },
        });
    // The raise the stale rule cut back was paid after all: withdraw that cut, re-issue nothing.
    if (live?.intendedStale && live.paidUnits >= live.units) {
        log.info({
            message: 'Stale-raise cut withdrawn: the raise was paid',
            billing: { group: groupId, units: live.units },
        });
        await billingRepository.setIntendedUnits(live.id, null);
        if (live.pendingUnits === live.intendedUnits) {
            const cleared = await polar().subscriptions.update(live.id, { pending_update: null });
            await applyChanged(groupId, cleared, true);
        }
        return;
    }
    if (live && stale.includes(live.id) && live.paidUnits < live.units) {
        log.warn({
            message: 'Unconfirmed raise cut back to the places paid for',
            billing: { group: groupId, units: live.units, paid: live.paidUnits },
        });
        // The payer's own cut stands when it is already at or below the places paid for.
        if (live.intendedUnits === null || live.intendedUnits > live.paidUnits)
            await billingRepository.setIntendedUnits(live.id, live.paidUnits, true);
    }
    if (live && (live.intendedUnits !== null || stale.includes(live.id)))
        try {
            await reissueCut(groupId);
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
/* Scheduled cuts                                                             */
/* ------------------------------------------------------------------------- */

/*
 * Where a failed re-issue is queued for another try (pg-boss, with backoff):
 * set by the processes that can send jobs, the web app and the worker. Without
 * one the recorded cut still waits for the daily reconcile.
 */
let cutRetryQueue: ((groupId: string) => Promise<unknown>) | undefined;
export function setCutRetryQueue(queue: ((groupId: string) => Promise<unknown>) | undefined) {
    cutRetryQueue = queue;
}

async function queueCutRetry(groupId: string) {
    if (!cutRetryQueue) {
        log.warn({ message: 'No queue for cut retries', billing: { group: groupId } });
        return;
    }
    try {
        await cutRetryQueue(groupId);
    } catch (error) {
        log.warn({
            message: 'Cut retry could not be queued',
            billing: { group: groupId, failure: String((error as Error)?.name) },
        });
    }
}

/*
 * Schedules a cut to `target` places at the period's end and records it. An
 * admission can commit between the count `target` came from and the cut: the
 * seats this writes refuse any admission after it (the group row orders the
 * two), and the members counted after it catch one that landed before, so the
 * cut is moved up to them, or dropped if that is no cut at all.
 */
async function scheduleCut(
    groupId: string,
    subscriptionId: string,
    units: number,
    target: number,
    stale = false,
) {
    let cut = await polar().subscriptions.update(subscriptionId, {
        units: target,
        proration_behavior: 'next_period',
    });
    if (!(await applyChanged(groupId, cut, false))) throw unresolvedPlan();
    await billingRepository.setIntendedUnits(subscriptionId, target, stale);
    const used = await groupsRepository.seatsUsed(groupId);
    if (used <= target) return;
    cut = await polar().subscriptions.update(
        subscriptionId,
        used < units
            ? { units: used, proration_behavior: 'next_period' }
            : { pending_update: null },
    );
    if (!(await applyChanged(groupId, cut, false))) throw unresolvedPlan();
    await billingRepository.setIntendedUnits(subscriptionId, used < units ? used : null, stale);
}

function unresolvedPlan() {
    return new BillingError(
        'This family’s plan could not be read. Nothing more was changed; contact support.',
        503,
    );
}

/*
 * Asks Polar again for the cut HushOS recorded, if Polar no longer has it.
 * Idempotent: a cut sets an absolute count for the next period, so asking
 * twice schedules the same thing. Never below the members admitted or the
 * plan's included count; once the count is no longer above it (the cut
 * applied at renewal), the record is cleared. Throws when Polar refuses or
 * cannot be reached, so the retry job is retried with backoff.
 */
export async function reissueCut(groupId: string) {
    if (!billingEnabled()) return;
    const live = await billingRepository.getLiveGroupSubscription(groupId);
    if (!live || live.intendedUnits === null) return;
    const subscription = await polar().subscriptions.get(live.id);
    const plan = await planOf(subscription.product_id);
    if (!plan) return;
    const units = subscription.units ?? plan.includedMembers;
    const target = Math.max(
        live.intendedUnits,
        plan.includedMembers,
        await groupsRepository.seatsUsed(groupId),
    );
    if (target >= units) {
        await billingRepository.setIntendedUnits(live.id, null);
        return;
    }
    if (target !== live.intendedUnits)
        await billingRepository.setIntendedUnits(live.id, target, live.intendedStale);
    if (subscription.pending_update?.units === target) return;
    // Polar refuses quantity changes on a plan set to end; resuming it brings the cut back here.
    if (subscription.cancel_at_period_end) return;
    await scheduleCut(groupId, subscription.id, units, target, live.intendedStale);
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
    const floor = Math.max(plan.includedMembers, await groupsRepository.seatsUsed(groupId));
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
            success_url: `${familyPage(groupId)}?checkout_id={CHECKOUT_ID}`,
            return_url: familyPage(groupId),
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
            return_url: familyPage(groupId),
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
    const cut = subscription.pending_update?.units ?? null;
    const cap = { status: 'cap' as const, max: plan.maxMembers, step: MAX_MEMBERS_PER_RAISE };
    if (target > plan.maxMembers) return cap;
    if (subscription.cancel_at_period_end) return { status: 'canceling' };
    if (target <= current) {
        // Polar holds places HushOS has not seen paid: a raise awaiting the bank. Re-read;
        // they open only once no order waits, and asking Polar again would charge nothing.
        if (target > live.paidUnits) {
            await reconcileGroup(groupId);
            const fresh = await billingRepository.getLiveGroupSubscription(groupId);
            if (!fresh || fresh.paidUnits < target) return { status: 'confirm', url: null };
        }
        if (cut === null || cut >= target) return { status: 'ok' };
        try {
            const moved = await polar().subscriptions.update(
                subscription.id,
                target < current
                    ? { units: target, proration_behavior: 'next_period' }
                    : { pending_update: null },
            );
            await applyChanged(groupId, moved, false);
            await billingRepository.setIntendedUnits(live.id, target < current ? target : null);
            return { status: 'ok' };
        } catch (error) {
            return refusedRaise(error);
        }
    }
    if (target - current > MAX_MEMBERS_PER_RAISE) return cap;
    let raised: models.Subscription;
    try {
        raised = await polar().subscriptions.update(subscription.id, {
            units: target,
            proration_behavior: 'invoice',
        });
    } catch (error) {
        return refusedRaise(error);
    }
    // The raise replaced any scheduled cut at Polar (spike E3): the payer asked for more places
    // now, so the cut is not put back, or they would pay for places they could not fill.
    if (cut !== null) await billingRepository.setIntendedUnits(live.id, null);
    // Paid only when Polar shows no order waiting; one that cannot be read is not paid yet.
    const paid = (await orderState(subscription.id)).unpaid === false;
    await applyChanged(groupId, raised, paid);
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
    const [live, pool, usedBytes] = await Promise.all([
        billingRepository.getLiveGroupSubscription(groupId),
        billingRepository.getGroupPool(groupId),
        billingRepository.getGroupPoolUsage(groupId),
    ]);
    // The pool as Drive's free-space check reads it: past its period and grace, empty.
    const storage = pool
        ? {
              usedBytes: usedBytes.toString(),
              quotaBytes:
                  pool.expiresAt === null || pool.expiresAt.getTime() > Date.now()
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
        plans: families
            .filter((candidate) => !candidate.archived)
            .map(({ archived: _archived, ...rest }) => rest),
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
