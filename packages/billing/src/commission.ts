import { growthRepository } from '@hushos/db';
import { billingEnv } from '@hushos/env/billing';
import { log } from '@hushos/logging';
import type { models } from '@polar-sh/sdk/2026-10';
import { billingEnabled, polar, statusOf, unavailable } from './provider';

/*
 * Commission safety, above the repository (docs/company-billing-design.md 8.4, 8.5): what Polar
 * is asked, and when. Everything here runs only with AFFILIATE_V2_ENABLED; with it off the
 * callers take the paths they always took and nothing in this file is reached.
 *
 * A delivery about a refund is only a trigger: the order's refunds are listed at Polar and the
 * earning is worked out again from what the list says. Polar sends no delivery for a dispute, so
 * its disputes list is read once a day, each dispute is kept by order, and an earning is matched
 * to its order's dispute from both sides: by the read, and by whoever records the earning.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function affiliateV2() {
    return billingEnv.AFFILIATE_V2_ENABLED;
}

/* The switch's own row; the cut-over happens the first time anything asks. */
export async function ensureCutover(now = new Date()) {
    return (
        (await growthRepository.getLedgerState()) ??
        (await growthRepository.beginCutover(now)).state
    );
}

type Reach = { cutoverAt: Date } | null;

/* What the order's refunds list says is refunded: the sum of those that succeeded. A refund's amount is before tax, as the net is. */
async function refundedAtPolar(orderId: string) {
    const page = await polar().refunds.list({ order_id: orderId, limit: 100 });
    return page.items
        .filter((refund) => refund.status === 'succeeded')
        .reduce((sum, refund) => sum + BigInt(refund.amount), 0n);
}

/* The order's refunds, read again, and every earning of the order recomputed from them. Throws when Polar can't be read. */
export async function rereadRefunds(orderId: string, options: { reach?: Reach; now?: Date } = {}) {
    return growthRepository.applyRefundRead(orderId, await refundedAtPolar(orderId), options);
}

type Affiliate = NonNullable<Awaited<ReturnType<typeof growthRepository.getAffiliate>>>;

/*
 * Who a paid order earns for, with the switch on: the affiliate whose discount it used, else the
 * one its customer signed up through, as before, but never one who was removed, and one who is
 * paused only for a customer they had brought before the pause: signed up through them before
 * it, or already earned them something before it (a customer who only ever used their code). A
 * stale code that still gets through at Polar's checkout ties nobody new to a paused affiliate.
 */
export async function earningAffiliate(discountId: string | null, userId: string | null) {
    const byDiscount = discountId
        ? await growthRepository.findAffiliateByDiscount(discountId)
        : null;
    const attribution = userId ? await growthRepository.findAttribution(userId) : null;
    const earns = async (affiliate: Affiliate, usedCode: boolean) => {
        if (affiliate.removedAt) return false;
        if (!affiliate.pausedAt) return true;
        if (
            attribution?.affiliate.id === affiliate.id &&
            attribution.attributedAt < affiliate.pausedAt
        )
            return true;
        return usedCode && userId
            ? growthRepository.earnedBefore(affiliate.id, userId, affiliate.pausedAt)
            : false;
    };
    if (byDiscount && (await earns(byDiscount, true))) return byDiscount;
    if (attribution && (await earns(attribution.affiliate, false))) return attribution.affiliate;
    return null;
}

/*
 * Commission for a paid order, with the switch on. Held for AFFILIATE_HOLD_DAYS from now: Polar's
 * order carries no time it was paid, and this, the handling of its `order.paid`, is never before
 * the charge. Flagged `self` when the affiliate's own account is the customer. An order already
 * partly refunded when this runs (the job that grants kept rewards reads it fresh; a delivery
 * that was delayed) starts lowered; a refund this cannot see yet is found by the daily read while
 * the earning is still held.
 */
export async function recordHeldAffiliateEarning(
    order: {
        id: string;
        discount_id?: string | null;
        net_amount?: number;
        refunded_amount?: number;
        currency?: string;
    },
    userId: string | null,
) {
    if (!Number.isSafeInteger(order.net_amount) || !order.currency) return;
    await ensureCutover();
    const affiliate = await earningAffiliate(order.discount_id ?? null, userId);
    if (!affiliate) return;
    const now = new Date();
    const known = BigInt(Math.max(0, Math.trunc(order.refunded_amount ?? 0)));
    let refunded = known;
    const dispute = await growthRepository.orderDisputeStatus(order.id);
    if (known > 0n || dispute?.status === 'prevented') {
        try {
            refunded = await refundedAtPolar(order.id);
        } catch (error) {
            // What the order itself says stands in; the daily read corrects it.
            log.warn({
                message: 'An order’s refunds could not be read as its commission was recorded',
                billing: { order: order.id, status: statusOf(error) },
            });
        }
    }
    try {
        await growthRepository.recordHeldEarning({
            affiliateId: affiliate.id,
            orderId: order.id,
            userId,
            currency: order.currency,
            netAmount: BigInt(order.net_amount!),
            commissionBps: affiliate.commissionBps,
            payableAt: new Date(now.getTime() + growthRepository.AFFILIATE_HOLD_DAYS * DAY_MS),
            flag: affiliate.userId && affiliate.userId === userId ? 'self' : null,
            refundedAmount: refunded,
            now,
        });
    } catch (error) {
        if (!(error instanceof growthRepository.AffiliateGoneError)) throw error;
        log.error({
            message:
                'Commission not recorded: its affiliate was removed while the order was paid. Pay it by hand if it is owed',
            billing: {
                order: order.id,
                discount: order.discount_id ?? null,
                affiliate: affiliate.id,
                code: affiliate.code,
                amount: growthRepository
                    .commissionOf(BigInt(order.net_amount!), affiliate.commissionBps)
                    .toString(),
                currency: order.currency,
            },
        });
    }
}

/*
 * An order HushOS refunds whole: its commission is taken back. With the switch on the earning is
 * kept in the ledger at nothing, or gains a clawback when it was already paid; without, as before.
 */
export function withdrawOrderEarning(orderId: string) {
    return affiliateV2()
        ? growthRepository.withdrawHeldEarning(orderId)
        : growthRepository.withdrawEarning(orderId);
}

/*
 * Polar's `order.refunded`, `refund.created` and `refund.updated`, whoever made the refund: the
 * order's refunds are read again when it has an earning. A token that may not read refunds is
 * said at error level and the delivery is still taken (the daily read tries again); any other
 * failure refuses the delivery, so Polar sends it again.
 */
export async function noteRefundDelivery(event: { type: string; data: unknown }) {
    if (!billingEnabled() || !affiliateV2()) return false;
    const data = event.data as { id?: unknown; order_id?: unknown };
    const orderId = event.type === 'order.refunded' ? data.id : data.order_id;
    if (typeof orderId !== 'string' || !orderId || orderId.length > 100) return false;
    if (!(await growthRepository.hasEarning(orderId))) return false;
    await ensureCutover();
    try {
        await rereadRefunds(orderId);
    } catch (error) {
        if (statusOf(error) !== 403 && statusOf(error) !== 401) throw unavailable(error);
        log.error({
            message:
                'Refunds can’t be read, so commission on a refunded order was not lowered: the Polar token needs the refunds:read scope',
            billing: { order: orderId, status: statusOf(error) },
        });
        return false;
    }
    return true;
}

/*
 * The daily read of Polar's disputes: the list newest first, down to the newest one the last
 * whole read saw, and then every dispute held as not closed, which nothing else would look at
 * again. Each is kept and matched to its order's earnings; a `prevented` one has its order's
 * refunds read at once. If the list can't be read (a token without disputes:read) that is said
 * at error level and kept for the operators' page, and the marker does not move, so the next
 * read starts where this one should have.
 */
async function readDisputes(
    state: growthRepository.LedgerState,
    reach: Reach,
    now: Date,
    /* Orders whose refunds this run has read: a prevented dispute's is not read a second time. */
    refundsRead: Set<string>,
) {
    const seen = new Set<string>();
    let newest: Date | null = null;
    const take = async (
        dispute: Pick<models.Dispute, 'id' | 'order_id' | 'status' | 'created_at'>,
    ) => {
        seen.add(dispute.id);
        const matched = await growthRepository.recordDispute(
            {
                id: dispute.id,
                orderId: dispute.order_id,
                status: dispute.status,
                openedAt: new Date(dispute.created_at),
            },
            { now, reach },
        );
        if (!matched.refunds || refundsRead.has(dispute.order_id)) return;
        try {
            await rereadRefunds(dispute.order_id, { reach, now });
            refundsRead.add(dispute.order_id);
        } catch (error) {
            // Not the disputes list's failure: said as one that the next run tries again.
            throw new Error('The refunds of a prevented dispute’s order could not be read.', {
                cause: error,
            });
        }
    };
    try {
        for await (const dispute of polar().disputes.iterList({
            sorting: ['-created_at'],
            limit: 100,
        })) {
            const openedAt = new Date(dispute.created_at);
            if (state.disputesSeenThrough && openedAt < state.disputesSeenThrough) break;
            newest ??= openedAt;
            await take(dispute);
        }
        for (const held of await growthRepository.listOpenDisputes()) {
            if (seen.has(held.id)) continue;
            try {
                await take(await polar().disputes.get(held.id));
            } catch (error) {
                // One Polar no longer has is left as it was last read.
                if (statusOf(error) !== 404) throw error;
            }
        }
    } catch (error) {
        const failure = statusOf(error) === 403 || statusOf(error) === 401 ? 'scope' : 'failed';
        await growthRepository.noteDisputesRead({ failure }, now);
        log.error({
            message:
                failure === 'scope'
                    ? 'Disputes can’t be read: the Polar token has no disputes:read scope. Commission on a charged-back order is not taken back until it has'
                    : 'Polar’s disputes could not be read; the next daily run reads them again',
            billing: { status: statusOf(error), failure: String((error as Error)?.name) },
        });
        return { ok: false, read: seen.size };
    }
    await growthRepository.noteDisputesRead({ seenThrough: newest }, now);
    return { ok: true, read: seen.size };
}

/*
 * The daily reconcile's part for commission. The first run after the switch reaches back: the
 * refunds and disputes nothing acted on at the time are read for every unpaid earning, whatever
 * its age, and every earning paid in the AFFILIATE_CUTOVER_DAYS before the switch. A clawback
 * that reach makes is the cut-over's and waits for an operator's yes. Every run reads Polar's
 * disputes, and reads again the refunds of each earning that could still be paid and of each one
 * a refund changed in the last 30 days. Refunds are still read when disputes can't be.
 */
export async function reconcileAffiliateEarnings(now = new Date()) {
    if (!billingEnabled() || !affiliateV2()) return null;
    const state = await ensureCutover(now);
    const reach: Reach = state.reachBackDoneAt ? null : { cutoverAt: state.cutoverAt };
    const done = new Set<string>();
    const disputes = await readDisputes(state, reach, now, done);
    let refundsRead = 0;
    let refundsFailed = 0;
    const read = async (orderId: string, reaching: Reach) => {
        if (done.has(orderId)) return;
        done.add(orderId);
        try {
            await rereadRefunds(orderId, { reach: reaching, now });
            refundsRead += 1;
        } catch (error) {
            refundsFailed += 1;
            log.warn({
                message: 'An earning’s refunds could not be read again',
                billing: { order: orderId, status: statusOf(error) },
            });
        }
    };
    if (reach)
        for (const orderId of await growthRepository.reachBackOrders(state))
            await read(orderId, reach);
    for (const orderId of await growthRepository.dueRefundReads({ now })) await read(orderId, null);
    if (
        reach &&
        disputes.ok &&
        !refundsFailed &&
        !(await growthRepository.reachBackOrders(state, { limit: 1 })).length
    )
        await growthRepository.finishReachBack(now);
    return { disputesRead: disputes.ok, disputes: disputes.read, refundsRead, refundsFailed };
}
