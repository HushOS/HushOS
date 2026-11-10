import { and, desc, eq, gt, gte, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from './client';
import {
    affiliateDisputes,
    affiliateEarnings,
    affiliateLedgerState,
    affiliateWithdrawnOrders,
    affiliates,
    referrals,
} from './schema';

/*
 * Commission safety (docs/company-billing-design.md 8.4 and 8.5), used with AFFILIATE_V2_ENABLED.
 *
 * An earning is recorded once per order with its pot, which nothing later changes. Two things
 * lower what is left of it: the order's refunds and a lost dispute. `earningLeft` works that out
 * from what is stored on the row, and `writeLeft` is the only code that writes it: every path
 * (a refund read, a dispute read, HushOS's own whole refund, the cut-over) first stores what it
 * read and then calls it, under the order's lock and with the order's rows locked, so no two
 * paths can each write an answer worked out from half the facts.
 *
 * Money already paid out on an order that was then refunded or charged back is a clawback. It is
 * taken back by amount, never as a whole: what a payout nets is applied to the oldest first, and
 * what is not covered stays open.
 *
 * Amounts are minor units as `bigint` throughout: `pot × (net − refunded)` passes 2^53 for an
 * order of a few thousand rupees' commission, where a JavaScript number would round it.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Earning = typeof affiliateEarnings.$inferSelect;
export type LedgerState = typeof affiliateLedgerState.$inferSelect;

/* Days a new earning waits before it may be paid: most refunds and disputes arrive inside them. */
export const AFFILIATE_HOLD_DAYS = 30;
/* How far back from the switch a paid earning's refunds and disputes are still looked at. */
export const AFFILIATE_CUTOVER_DAYS = 120;
/* How long after a refund read changed an earning its refunds are read again daily (a refund can fail late). */
export const REFUND_RECHECK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/*
 * One order's earning, recorded, lowered or withdrawn: all take this lock first, so a commission
 * is never recorded after the order was refunded whole, and a dispute read and the recording of
 * its order's earning cannot each miss the other, however their deliveries race.
 */
const EARNING_LOCK_SPACE = 0x6561726e;
export const lockOrder = (tx: Tx, orderId: string) =>
    tx.execute(sql`select pg_advisory_xact_lock(${EARNING_LOCK_SPACE}::int, hashtext(${orderId}))`);

/* An earning whose affiliate was removed while its order was on the way. */
export class AffiliateGoneError extends Error {
    constructor(options?: { cause?: unknown }) {
        super('The affiliate was removed.', options);
        this.name = 'AffiliateGoneError';
    }
}

export const EARNING_AFFILIATE_KEY = 'affiliate_earnings_affiliate_id_affiliates_id_fkey';
export const EARNING_ACCOUNT_KEY = 'affiliate_earnings_user_id_users_id_fkey';

/* The foreign key a driver error says was violated, within a few causes; null for anything else. */
export function violatedForeignKey(error: unknown) {
    let at = error;
    for (let depth = 0; depth < 5 && at && typeof at === 'object'; depth++) {
        const { code, constraint } = at as { code?: unknown; constraint?: unknown };
        if (code === '23503') return typeof constraint === 'string' ? constraint : null;
        at = (at as { cause?: unknown }).cause;
    }
    return null;
}

/* The commission on an order's net amount, in its smallest unit: rounded down. */
export function commissionFor(netAmount: number, commissionBps: number) {
    return Math.floor((netAmount * commissionBps) / 10_000);
}

/* The same, exact for any amount: `full = floor(net × bps / 10000)`. Nothing for a net of zero or less. */
export function commissionOf(netAmount: bigint, commissionBps: number) {
    if (netAmount <= 0n || commissionBps <= 0) return 0n;
    return (netAmount * BigInt(commissionBps)) / 10_000n;
}

/*
 * What is left of an earning: nothing when the order's dispute is lost (a chargeback returns the
 * whole charge and is not among the order's refunds), else the pot less the refunded share of
 * the order, rounded down. A refund is never more than the net here, nor less than nothing.
 */
export function earningLeft(input: {
    pot: bigint;
    net: bigint;
    refunded: bigint;
    disputeStatus: string | null;
}) {
    if (input.disputeStatus === 'lost') return 0n;
    if (input.pot <= 0n || input.net <= 0n) return 0n;
    const refunded =
        input.refunded <= 0n ? 0n : input.refunded > input.net ? input.net : input.refunded;
    return (input.pot * (input.net - refunded)) / input.net;
}

/* Polar's statuses of a dispute that is over. Anything else, a status not known here too, is open. */
const CLOSED_DISPUTES = new Set(['lost', 'won', 'prevented']);
export const disputeOpen = (status: string | null | undefined) =>
    typeof status === 'string' && !CLOSED_DISPUTES.has(status);

/* Which of an order's disputes decides its earning: a lost one, else an open one, else `prevented`, else `won`; the newest of equals. */
function governing<T extends { status: string; openedAt: Date }>(disputes: T[]) {
    const rank = (status: string) =>
        status === 'lost' ? 3 : disputeOpen(status) ? 2 : status === 'prevented' ? 1 : 0;
    return (
        [...disputes].sort(
            (a, b) =>
                rank(b.status) - rank(a.status) || b.openedAt.getTime() - a.openedAt.getTime(),
        )[0] ?? null
    );
}

/* What of a clawback is still to be taken back. */
export function clawbackOpen(
    row: Pick<Earning, 'clawbackAmount' | 'clawbackSettledAmount' | 'clawbackWrittenOffAmount'>,
) {
    const open = row.clawbackAmount - row.clawbackSettledAmount - row.clawbackWrittenOffAmount;
    return open > 0n ? open : 0n;
}

/* What was taken back beyond what is owed back, after a later read lowered the clawback: the affiliate's again. */
export function clawbackCredit(row: Pick<Earning, 'clawbackAmount' | 'clawbackSettledAmount'>) {
    const over = row.clawbackSettledAmount - row.clawbackAmount;
    return over > 0n ? over : 0n;
}

/* Whether a clawback counts in no net yet: the cut-over made it and no operator has said yes to it. */
const unconfirmed = (row: Pick<Earning, 'clawbackOrigin' | 'clawbackConfirmedAt'>) =>
    row.clawbackOrigin === 'cutover' && !row.clawbackConfirmedAt;

/* Whether an operator must act, or a dispute close, before it is paid. */
export const earningFlagged = (row: Pick<Earning, 'flag' | 'flagReleasedAt' | 'disputeStatus'>) =>
    (row.flag !== null && !row.flagReleasedAt) || disputeOpen(row.disputeStatus);

const potOf = (row: Pick<Earning, 'potAmount' | 'commissionAmount'>) =>
    row.potAmount ?? row.commissionAmount;
/* What a paid row was paid: a row paid without the switch has not been lowered, so it is its commission. */
const paidOf = (row: Pick<Earning, 'paidAmount' | 'commissionAmount'>) =>
    row.paidAmount ?? row.commissionAmount;

/* The order's rows, locked until the transaction ends: a payout or an operator's change waits, and is then read fresh. */
function lockedRows(tx: Tx, orderId: string) {
    return tx
        .select()
        .from(affiliateEarnings)
        .where(eq(affiliateEarnings.orderId, orderId))
        .orderBy(affiliateEarnings.id)
        .for('update');
}

type Facts = Partial<
    Pick<Earning, 'refundedAmount' | 'disputeId' | 'disputeStatus' | 'disputedAt'>
> & { refundsReadAt?: Date; refundsChangedAt?: Date };

/*
 * The one writer of what is left of an earning. `row` is read under the order's lock and locked;
 * `facts` is what the caller just read. An unpaid earning is lowered (or raised again) to what is
 * left. A paid one keeps what was paid (`paid_amount`) and gains a clawback of what was paid
 * beyond what is left; if what is left is later more than what was paid, the difference is owed.
 * `reach`: the cut-over's reach back is running, so a clawback that first arises here on an
 * earning paid before the switch is the cut-over's, and waits for an operator's yes.
 */
async function writeLeft(
    tx: Tx,
    row: Earning,
    facts: Facts,
    options: { now: Date; reach?: { cutoverAt: Date } | null },
) {
    const next = { ...row, ...facts };
    const pot = potOf(row);
    const left = earningLeft({
        pot,
        net: next.netAmount,
        refunded: next.refundedAmount,
        disputeStatus: next.disputeStatus,
    });
    const changes: Partial<Earning> = { ...facts, potAmount: pot, commissionAmount: left };
    if (row.paidAt) {
        const paid = paidOf(row);
        const clawback = paid > left ? paid - left : 0n;
        changes.paidAmount = paid;
        changes.clawbackAmount = clawback;
        if (clawback > 0n && row.clawbackAmount === 0n) {
            // A clawback arises. The cut-over's own only when its reach back found it, on an
            // earning paid before the switch; any other needs no yes.
            changes.clawbackAt = options.now;
            changes.clawbackOrigin =
                options.reach && row.paidAt <= options.reach.cutoverAt ? 'cutover' : null;
            changes.clawbackConfirmedAt = null;
            changes.clawbackConfirmedBy = null;
        }
        const open = clawbackOpen({ ...row, clawbackAmount: clawback });
        changes.clawbackSettledAt =
            clawback > 0n && open === 0n ? (row.clawbackSettledAt ?? options.now) : null;
        if (clawback > 0n && next.refundedAmount > 0n && !row.orderRefundedAt)
            changes.orderRefundedAt = options.now;
    }
    const [written] = await tx
        .update(affiliateEarnings)
        .set(changes)
        .where(eq(affiliateEarnings.id, row.id))
        .returning();
    return written!;
}

/* The switch's own row, or null before the cut-over. */
export async function getLedgerState(executor: typeof db | Tx = db): Promise<LedgerState | null> {
    const [row] = await executor.select().from(affiliateLedgerState);
    return row ?? null;
}

/*
 * The cut-over, once: the first thing done with the switch on. Later calls change nothing and
 * return the same row. It notes when the switch came on; gives every affiliate paused before it
 * a pause time of now, so the people they had brought go on earning as they did; gives every
 * earning a pot and, where paid, what was paid; and gives each paid earning HushOS had already
 * marked refunded (it refunded the order whole) a clawback of all of it, the cut-over's own, so it
 * is listed once and taken from nothing until an operator says yes.
 */
export async function beginCutover(now = new Date()) {
    return db.transaction(async (tx) => {
        const [made] = await tx
            .insert(affiliateLedgerState)
            .values({ id: true, cutoverAt: now })
            .onConflictDoNothing()
            .returning();
        if (!made) return { state: (await getLedgerState(tx))!, began: false };
        await tx
            .update(affiliates)
            .set({ pausedAt: now })
            .where(and(eq(affiliates.active, false), isNull(affiliates.pausedAt)));
        await tx
            .update(affiliateEarnings)
            .set({ potAmount: sql`${affiliateEarnings.commissionAmount}` })
            .where(isNull(affiliateEarnings.potAmount));
        await tx
            .update(affiliateEarnings)
            .set({ paidAmount: sql`${affiliateEarnings.commissionAmount}` })
            .where(and(isNotNull(affiliateEarnings.paidAt), isNull(affiliateEarnings.paidAmount)));
        const refunded = await tx
            .select()
            .from(affiliateEarnings)
            .where(
                and(
                    isNotNull(affiliateEarnings.paidAt),
                    isNotNull(affiliateEarnings.orderRefundedAt),
                    eq(affiliateEarnings.clawbackAmount, 0n),
                ),
            )
            .orderBy(affiliateEarnings.id)
            .for('update');
        for (const row of refunded)
            await writeLeft(
                tx,
                row,
                { refundedAmount: row.netAmount },
                { now, reach: { cutoverAt: now } },
            );
        return { state: made, began: true };
    });
}

/* The reach back is over: every earning it covers was read, and the disputes were read through. */
export async function finishReachBack(now = new Date()) {
    await db
        .update(affiliateLedgerState)
        .set({ reachBackDoneAt: now })
        .where(isNull(affiliateLedgerState.reachBackDoneAt));
}

/* How the daily read of Polar's disputes went: read through, or why not. */
export async function noteDisputesRead(
    outcome: { seenThrough: Date | null } | { failure: 'scope' | 'failed' },
    now = new Date(),
) {
    await db.update(affiliateLedgerState).set(
        'failure' in outcome
            ? { disputesFailure: outcome.failure, disputesFailedAt: now }
            : {
                  disputesReadAt: now,
                  disputesFailure: null,
                  disputesFailedAt: null,
                  ...(outcome.seenThrough ? { disputesSeenThrough: outcome.seenThrough } : {}),
              },
    );
}

/* Who the customer of an order came through, and when: the pause is judged against it. */
export async function findAttribution(userId: string) {
    const [row] = await db
        .select({ affiliate: affiliates, attributedAt: referrals.createdAt })
        .from(referrals)
        .innerJoin(affiliates, eq(affiliates.id, referrals.affiliateId))
        .where(and(eq(referrals.referredUserId, userId), eq(referrals.kind, 'affiliate')));
    return row ?? null;
}

/* Whether this customer had already earned this affiliate something before `before`: brought by their code, with no sign-up to say so. */
export async function earnedBefore(affiliateId: string, userId: string, before: Date) {
    const [row] = await db
        .select({ id: affiliateEarnings.id })
        .from(affiliateEarnings)
        .where(
            and(
                eq(affiliateEarnings.affiliateId, affiliateId),
                eq(affiliateEarnings.userId, userId),
                lt(affiliateEarnings.createdAt, before),
            ),
        )
        .limit(1);
    return Boolean(row);
}

/* Whether any commission was recorded for the order: asked before Polar is, for a refund's delivery. */
export async function hasEarning(orderId: string) {
    const [row] = await db
        .select({ id: affiliateEarnings.id })
        .from(affiliateEarnings)
        .where(eq(affiliateEarnings.orderId, orderId))
        .limit(1);
    return Boolean(row);
}

/* The status of the order's dispute that decides its earning, as last read; null with none. */
export async function orderDisputeStatus(orderId: string, executor: typeof db | Tx = db) {
    const rows = await executor
        .select()
        .from(affiliateDisputes)
        .where(eq(affiliateDisputes.orderId, orderId));
    return governing(rows);
}

/*
 * Commission on one paid order, with the switch on. As `recordEarning`: once per order and part,
 * nothing for a net of zero or less, nothing for an order HushOS refunded whole. And under the
 * order's lock it reads the disputes already seen for the order, so an earning recorded after
 * its order's dispute starts flagged (an open one) or at nothing (a lost one), and one whose
 * order was already partly refunded (`refundedAmount`, read by the caller) starts lowered.
 * `payableAt` is when the hold ends.
 */
export async function recordHeldEarning(input: {
    affiliateId: string;
    orderId: string;
    userId: string | null;
    currency: string;
    netAmount: bigint;
    commissionBps: number;
    payableAt: Date;
    flag?: 'self' | 'member' | null;
    refundedAmount?: bigint;
    now?: Date;
}): Promise<Earning | null> {
    if (input.netAmount <= 0n) return null;
    const pot = commissionOf(input.netAmount, input.commissionBps);
    const now = input.now ?? new Date();
    const record = (userId: string | null) =>
        db.transaction(async (tx) => {
            await lockOrder(tx, input.orderId);
            const [withdrawn] = await tx
                .select({ orderId: affiliateWithdrawnOrders.orderId })
                .from(affiliateWithdrawnOrders)
                .where(eq(affiliateWithdrawnOrders.orderId, input.orderId));
            if (withdrawn) return null;
            // Removed while the order was on its way (the removal held this row): nothing earns.
            const [owner] = await tx
                .select({ removedAt: affiliates.removedAt })
                .from(affiliates)
                .where(eq(affiliates.id, input.affiliateId))
                .for('share');
            if (!owner) throw new AffiliateGoneError();
            if (owner.removedAt) return null;
            const dispute = await orderDisputeStatus(input.orderId, tx);
            const refunded =
                (input.refundedAmount ?? 0n) > input.netAmount
                    ? input.netAmount
                    : (input.refundedAmount ?? 0n) < 0n
                      ? 0n
                      : (input.refundedAmount ?? 0n);
            const [row] = await tx
                .insert(affiliateEarnings)
                .values({
                    affiliateId: input.affiliateId,
                    orderId: input.orderId,
                    part: 'main',
                    userId,
                    currency: input.currency,
                    netAmount: input.netAmount,
                    potAmount: pot,
                    commissionAmount: earningLeft({
                        pot,
                        net: input.netAmount,
                        refunded,
                        disputeStatus: dispute?.status ?? null,
                    }),
                    payableAt: input.payableAt,
                    flag: input.flag ?? null,
                    refundedAmount: refunded,
                    refundsChangedAt: refunded > 0n ? now : null,
                    disputeId: dispute?.id ?? null,
                    disputeStatus: dispute?.status ?? null,
                    disputedAt: dispute?.openedAt ?? null,
                    createdAt: now,
                })
                .onConflictDoNothing({
                    target: [affiliateEarnings.orderId, affiliateEarnings.part],
                })
                .returning();
            return row ?? null;
        });
    try {
        return await record(input.userId);
    } catch (error) {
        // As recordEarning: a customer gone since paying leaves the earning with nobody named; an
        // affiliate gone leaves nothing to record it on.
        const key = violatedForeignKey(error);
        if (key === EARNING_ACCOUNT_KEY && input.userId) return record(null);
        if (key === EARNING_AFFILIATE_KEY) throw new AffiliateGoneError({ cause: error });
        throw error;
    }
}

/*
 * An order HushOS refunds whole, with the switch on: the order is kept (affiliate_withdrawn_orders)
 * so no later delivery records a first earning, and an earning already there is recomputed with
 * everything refunded. Unpaid, it stays in the ledger at nothing (`withdrawn`); paid, it gains a
 * clawback of all of it (`paid`, said the first time only). `none` when there was nothing to change.
 */
export async function withdrawHeldEarning(orderId: string, now = new Date()) {
    return db.transaction(async (tx) => {
        await lockOrder(tx, orderId);
        await tx.insert(affiliateWithdrawnOrders).values({ orderId }).onConflictDoNothing();
        let outcome: 'withdrawn' | 'paid' | 'none' = 'none';
        for (const row of await lockedRows(tx, orderId)) {
            const firstTime = row.refundedAmount < row.netAmount;
            await writeLeft(
                tx,
                row,
                {
                    refundedAmount: row.netAmount,
                    ...(firstTime ? { refundsChangedAt: now } : {}),
                },
                { now },
            );
            if (!firstTime) continue;
            if (row.paidAt) outcome = 'paid';
            else if (outcome === 'none') outcome = 'withdrawn';
        }
        return outcome;
    });
}

/*
 * What the order's refunds list at Polar says is refunded (the sum of those that succeeded),
 * stored on the order's earnings and what is left written from it. An order HushOS itself set
 * out to refund whole stays wholly refunded whatever the list says yet: its refund may still be
 * on its way. Returns how many earnings changed.
 */
export async function applyRefundRead(
    orderId: string,
    refundedAtPolar: bigint,
    options: { now?: Date; reach?: { cutoverAt: Date } | null } = {},
) {
    const now = options.now ?? new Date();
    return db.transaction(async (tx) => {
        await lockOrder(tx, orderId);
        const [withdrawn] = await tx
            .select({ orderId: affiliateWithdrawnOrders.orderId })
            .from(affiliateWithdrawnOrders)
            .where(eq(affiliateWithdrawnOrders.orderId, orderId));
        let changed = 0;
        for (const row of await lockedRows(tx, orderId)) {
            const refunded = withdrawn
                ? row.netAmount
                : refundedAtPolar > row.netAmount
                  ? row.netAmount
                  : refundedAtPolar < 0n
                    ? 0n
                    : refundedAtPolar;
            const moved = refunded !== row.refundedAmount;
            await writeLeft(
                tx,
                row,
                {
                    refundedAmount: refunded,
                    refundsReadAt: now,
                    ...(moved ? { refundsChangedAt: now } : {}),
                },
                { now, reach: options.reach },
            );
            if (moved) changed += 1;
        }
        return changed;
    });
}

/*
 * A dispute as Polar's list has it now: kept by order whether or not the order has an earning,
 * and matched to the order's earnings. Open, it keeps them from being paid; lost, nothing is left
 * of them; won, they stand. `prevented` takes nothing itself: `refunds` tells the caller to read
 * the order's refunds, which is what lowers the earning. An earning paid longer before the switch
 * than the reach back goes is left alone by a dispute that was opened before the switch.
 */
export async function recordDispute(
    dispute: { id: string; orderId: string; status: string; openedAt: Date },
    options: { now?: Date; reach?: { cutoverAt: Date } | null; reachDays?: number } = {},
) {
    const now = options.now ?? new Date();
    return db.transaction(async (tx) => {
        await lockOrder(tx, dispute.orderId);
        await tx
            .insert(affiliateDisputes)
            .values({ ...dispute, lastReadAt: now })
            .onConflictDoUpdate({
                target: affiliateDisputes.id,
                set: { status: dispute.status, lastReadAt: now },
            });
        const decides = await orderDisputeStatus(dispute.orderId, tx);
        const state = await getLedgerState(tx);
        const floor = state
            ? new Date(
                  state.cutoverAt.getTime() -
                      (options.reachDays ?? AFFILIATE_CUTOVER_DAYS) * DAY_MS,
              )
            : null;
        let earnings = 0;
        for (const row of await lockedRows(tx, dispute.orderId)) {
            if (
                state &&
                floor &&
                row.paidAt &&
                row.paidAt < floor &&
                dispute.openedAt < state.cutoverAt
            )
                continue;
            await writeLeft(
                tx,
                row,
                {
                    disputeId: decides?.id ?? null,
                    disputeStatus: decides?.status ?? null,
                    disputedAt: decides?.openedAt ?? null,
                },
                { now, reach: options.reach },
            );
            earnings += 1;
        }
        return { earnings, refunds: dispute.status === 'prevented' && earnings > 0 };
    });
}

/* Every dispute held as not closed: read again each day, since nothing announces how it ends. */
export async function listOpenDisputes() {
    const rows = await db.select().from(affiliateDisputes);
    return rows.filter((row) => disputeOpen(row.status));
}

/*
 * The orders whose refunds the daily run reads again: every earning that could still be paid for
 * an order that was refunded (unpaid, not voided, something left), so a refund whose delivery
 * never arrived is found before the money goes; and every earning a refund read changed in the
 * last `recheckDays`, paid or not, since a refund can fail weeks after it succeeded. The least
 * recently read first, `limit` an hour's worth at most, so a long list is read over several runs.
 */
export async function dueRefundReads(
    options: { now?: Date; limit?: number; recheckDays?: number } = {},
) {
    const now = options.now ?? new Date();
    const since = new Date(now.getTime() - (options.recheckDays ?? REFUND_RECHECK_DAYS) * DAY_MS);
    const rows = await db
        .select({
            orderId: affiliateEarnings.orderId,
            readAt: sql<Date | null>`min(${affiliateEarnings.refundsReadAt})`,
        })
        .from(affiliateEarnings)
        .where(
            and(
                isNull(affiliateEarnings.voidedAt),
                or(
                    and(
                        isNull(affiliateEarnings.paidAt),
                        gt(affiliateEarnings.commissionAmount, 0n),
                    ),
                    gt(affiliateEarnings.refundsChangedAt, since),
                ),
            ),
        )
        .groupBy(affiliateEarnings.orderId)
        .orderBy(
            sql`min(${affiliateEarnings.refundsReadAt}) asc nulls first`,
            affiliateEarnings.orderId,
        )
        .limit(options.limit ?? 500);
    return rows.map((row) => row.orderId);
}

/*
 * The cut-over's reach back: orders whose refunds nothing acted on before the switch and that
 * have not been read since it. Every unpaid earning, whatever its age, and every earning paid in
 * the `days` before the switch. Empty once all were read.
 */
export async function reachBackOrders(
    state: LedgerState,
    options: { days?: number; limit?: number } = {},
) {
    const floor = new Date(
        state.cutoverAt.getTime() - (options.days ?? AFFILIATE_CUTOVER_DAYS) * DAY_MS,
    );
    const rows = await db
        .selectDistinct({ orderId: affiliateEarnings.orderId })
        .from(affiliateEarnings)
        .where(
            and(
                isNull(affiliateEarnings.voidedAt),
                lt(affiliateEarnings.createdAt, state.cutoverAt),
                or(
                    isNull(affiliateEarnings.refundsReadAt),
                    lt(affiliateEarnings.refundsReadAt, state.cutoverAt),
                ),
                or(
                    isNull(affiliateEarnings.paidAt),
                    and(
                        gte(affiliateEarnings.paidAt, floor),
                        lt(affiliateEarnings.paidAt, state.cutoverAt),
                    ),
                ),
            ),
        )
        .orderBy(affiliateEarnings.orderId)
        .limit(options.limit ?? 500);
    return rows.map((row) => row.orderId);
}

/* An affiliate's money in one currency, in minor units. */
export type LedgerTotals = {
    /* Recorded for them in all: every pot, voided ones included. */
    earned: bigint;
    /* May be paid now: past its hold, not flagged, and anything owed again after it was taken back. */
    payable: bigint;
    /* Recorded and still inside its hold. */
    held: bigint;
    /* Waiting on an operator, or on a dispute to close. */
    flagged: bigint;
    paidOut: bigint;
    voided: bigint;
    /* Taken off by refunds and lost disputes before it was paid. */
    lowered: bigint;
    /* Paid and to be taken back: counted against the next payout. */
    clawbackOpen: bigint;
    /* The cut-over's, waiting for an operator's yes: listed, counted in no net. */
    clawbackUnconfirmed: bigint;
};

const noTotals = (): LedgerTotals => ({
    earned: 0n,
    payable: 0n,
    held: 0n,
    flagged: 0n,
    paidOut: 0n,
    voided: 0n,
    lowered: 0n,
    clawbackOpen: 0n,
    clawbackUnconfirmed: 0n,
});

/* Where an unpaid earning stands at `now`. Payable from the moment its hold ends, not after it. */
export function earningState(row: Earning, now: Date) {
    if (row.voidedAt) return 'voided' as const;
    if (row.paidAt) return 'paid' as const;
    if (earningFlagged(row)) return 'flagged' as const;
    if (row.payableAt && row.payableAt.getTime() > now.getTime()) return 'held' as const;
    return 'payable' as const;
}

/*
 * The ledger, per currency, from the rows themselves: the one place that says which bucket an
 * earning's money is in. Every pot is in exactly one of paid out, payable, held, flagged, lowered
 * and voided, so they sum to what was earned (less anything owed again after an over-collected
 * clawback, which is in payable beside them).
 */
export function ledgerOf(rows: Earning[], now: Date) {
    const ledger: Record<string, LedgerTotals> = {};
    for (const row of rows) {
        const totals = (ledger[row.currency] ??= noTotals());
        const pot = potOf(row);
        totals.earned += pot;
        const state = earningState(row, now);
        if (state === 'voided') {
            totals.voided += pot;
            continue;
        }
        if (state !== 'paid') {
            totals[state] += row.commissionAmount;
            totals.lowered += pot - row.commissionAmount;
            continue;
        }
        const paid = paidOf(row);
        // Left is more than was paid (a refund counted before the payout failed after it): owed.
        const more = row.commissionAmount > paid ? row.commissionAmount - paid : 0n;
        totals.paidOut += paid;
        totals[earningFlagged(row) ? 'flagged' : 'payable'] += more;
        totals.lowered += pot - paid - more;
        totals[unconfirmed(row) ? 'clawbackUnconfirmed' : 'clawbackOpen'] += clawbackOpen(row);
        totals.payable += clawbackCredit(row);
    }
    return ledger;
}

/* What a payout in one currency comes to: what is owed, what of it open clawbacks take, and the rest, never below nothing. */
export function payoutOf(totals: Pick<LedgerTotals, 'payable' | 'clawbackOpen'>) {
    const netted = totals.payable < totals.clawbackOpen ? totals.payable : totals.clawbackOpen;
    return { owed: totals.payable, netted, payout: totals.payable - netted };
}

/* Whether anything stands in the way of removing the affiliate: owed, held, flagged, or a clawback not settled. */
export function ledgerBlocksRemoval(ledger: Record<string, LedgerTotals>) {
    return Object.values(ledger).some(
        (totals) =>
            totals.payable > 0n ||
            totals.held > 0n ||
            totals.flagged > 0n ||
            totals.clawbackOpen > 0n ||
            totals.clawbackUnconfirmed > 0n,
    );
}

export async function listLedgerRows(
    affiliateId: string,
    executor: typeof db | Tx = db,
    limit?: number,
) {
    const query = executor
        .select()
        .from(affiliateEarnings)
        .where(eq(affiliateEarnings.affiliateId, affiliateId))
        .orderBy(desc(affiliateEarnings.createdAt), affiliateEarnings.id);
    return limit === undefined ? query : query.limit(limit);
}

export async function affiliateLedger(
    affiliateId: string,
    now = new Date(),
    executor: typeof db | Tx = db,
) {
    return ledgerOf(await listLedgerRows(affiliateId, executor), now);
}

/* The figures an operator was shown differ from the ledger now: nothing was marked. */
export class PayoutChangedError extends Error {
    constructor() {
        super('The amounts changed.');
        this.name = 'PayoutChangedError';
    }
}

export type Payout = { owed: bigint; netted: bigint; payout: bigint };

/*
 * An operator has paid the affiliate. In one transaction, with every earning of theirs locked:
 * each earning that may be paid is marked paid for what is left of it; what an earlier payout
 * fell short by, and what was taken back beyond what was owed back, are counted as paid too; and
 * what open clawbacks took of the payout is applied to them, oldest first, each up to what is
 * open on it. A clawback covered in full is settled; one covered in part stays open for the rest.
 * Held, flagged and voided earnings are not touched, and a cut-over clawback nobody confirmed is
 * counted in nothing. `expected`: what the operator was shown, per currency; if the ledger says
 * otherwise now, nothing is written (PayoutChangedError).
 */
export async function settlePayout(
    affiliateId: string,
    input: {
        by: string | null;
        now?: Date;
        expected?: Record<string, { owed: string; netted: string }>;
    },
) {
    const now = input.now ?? new Date();
    return db.transaction(async (tx) => {
        const rows = await tx
            .select()
            .from(affiliateEarnings)
            .where(eq(affiliateEarnings.affiliateId, affiliateId))
            .orderBy(affiliateEarnings.id)
            .for('update');
        const ledger = ledgerOf(rows, now);
        const payouts: Record<string, Payout> = {};
        for (const [currency, totals] of Object.entries(ledger))
            if (totals.payable > 0n) payouts[currency] = payoutOf(totals);
        if (input.expected) {
            const shown = Object.keys(input.expected).sort();
            const same =
                shown.join() === Object.keys(payouts).sort().join() &&
                shown.every(
                    (currency) =>
                        input.expected![currency]!.owed === payouts[currency]!.owed.toString() &&
                        input.expected![currency]!.netted === payouts[currency]!.netted.toString(),
                );
            if (!same) throw new PayoutChangedError();
        }
        let paid = 0;
        for (const row of rows) {
            if (!payouts[row.currency]) continue;
            const state = earningState(row, now);
            if (state === 'payable' && row.commissionAmount > 0n) {
                await tx
                    .update(affiliateEarnings)
                    .set({
                        paidAt: now,
                        paidAmount: row.commissionAmount,
                        potAmount: potOf(row),
                    })
                    .where(eq(affiliateEarnings.id, row.id));
                paid += 1;
                continue;
            }
            if (state !== 'paid') continue;
            const changes: Partial<Earning> = {};
            if (row.commissionAmount > paidOf(row) && !earningFlagged(row))
                changes.paidAmount = row.commissionAmount;
            if (clawbackCredit(row) > 0n) changes.clawbackSettledAmount = row.clawbackAmount;
            if (Object.keys(changes).length)
                await tx
                    .update(affiliateEarnings)
                    .set(changes)
                    .where(eq(affiliateEarnings.id, row.id));
        }
        // What the payouts netted, applied to the clawbacks it was netted against: oldest first.
        const oldestFirst = rows
            .filter((row) => row.paidAt && !unconfirmed(row) && clawbackOpen(row) > 0n)
            .sort(
                (a, b) =>
                    (a.clawbackAt?.getTime() ?? 0) - (b.clawbackAt?.getTime() ?? 0) ||
                    a.id.localeCompare(b.id),
            );
        const remaining = Object.fromEntries(
            Object.entries(payouts).map(([currency, payout]) => [currency, payout.netted]),
        );
        for (const row of oldestFirst) {
            const left = remaining[row.currency] ?? 0n;
            if (left <= 0n) continue;
            const open = clawbackOpen(row);
            const taken = open < left ? open : left;
            remaining[row.currency] = left - taken;
            await tx
                .update(affiliateEarnings)
                .set({
                    clawbackSettledAmount: row.clawbackSettledAmount + taken,
                    ...(taken === open
                        ? { clawbackSettledAt: now, clawbackSettledBy: input.by }
                        : {}),
                })
                .where(eq(affiliateEarnings.id, row.id));
        }
        return { paid, payouts };
    });
}

/* One earning of one affiliate, locked for an operator's change; null when it is not theirs. */
async function lockedEarning(tx: Tx, affiliateId: string, earningId: string) {
    const [row] = await tx
        .select()
        .from(affiliateEarnings)
        .where(
            and(
                eq(affiliateEarnings.id, earningId),
                eq(affiliateEarnings.affiliateId, affiliateId),
            ),
        )
        .for('update');
    return row ?? null;
}

/*
 * An operator voids one earning, with a reason: it is owed to nobody and no longer blocks
 * removing the affiliate. Only before it is paid (`paid`): money that has gone is taken back as a
 * clawback, which a void cannot make. Voiding one already voided changes nothing.
 */
export async function voidEarning(
    affiliateId: string,
    earningId: string,
    input: { by: string; reason: string; now?: Date },
) {
    return db.transaction(async (tx) => {
        const row = await lockedEarning(tx, affiliateId, earningId);
        if (!row) return 'missing' as const;
        if (row.paidAt) return 'paid' as const;
        if (row.voidedAt) return 'done' as const;
        await tx
            .update(affiliateEarnings)
            .set({
                voidedAt: input.now ?? new Date(),
                voidedBy: input.by,
                voidReason: input.reason,
            })
            .where(eq(affiliateEarnings.id, row.id));
        return 'done' as const;
    });
}

/* An operator has looked at a flagged earning and lets it be paid. A dispute's hold is not theirs to lift. */
export async function releaseEarningFlag(
    affiliateId: string,
    earningId: string,
    input: { by: string; now?: Date },
) {
    return db.transaction(async (tx) => {
        const row = await lockedEarning(tx, affiliateId, earningId);
        if (!row) return 'missing' as const;
        if (!row.flag) return 'unflagged' as const;
        if (row.flagReleasedAt) return 'done' as const;
        await tx
            .update(affiliateEarnings)
            .set({ flagReleasedAt: input.now ?? new Date(), flagReleasedBy: input.by })
            .where(eq(affiliateEarnings.id, row.id));
        return 'done' as const;
    });
}

/* An operator says yes to one clawback the cut-over made: from now it counts against payouts. */
export async function confirmClawback(
    affiliateId: string,
    earningId: string,
    input: { by: string; now?: Date },
) {
    return db.transaction(async (tx) => {
        const row = await lockedEarning(tx, affiliateId, earningId);
        if (!row) return 'missing' as const;
        if (row.clawbackOrigin !== 'cutover' || row.clawbackAmount === 0n) return 'none' as const;
        if (row.clawbackConfirmedAt) return 'done' as const;
        await tx
            .update(affiliateEarnings)
            .set({ clawbackConfirmedAt: input.now ?? new Date(), clawbackConfirmedBy: input.by })
            .where(eq(affiliateEarnings.id, row.id));
        return 'done' as const;
    });
}

/*
 * An operator settles a clawback by hand, in full or in part: `repaid`, the affiliate sent an
 * amount back (at most what is open); `written-off`, what is open is given up, which needs a
 * note. Only the second writes anything off.
 */
export async function settleClawback(
    affiliateId: string,
    earningId: string,
    input:
        | { kind: 'repaid'; amount: bigint; note?: string | null; by: string; now?: Date }
        | { kind: 'written-off'; note: string; by: string; now?: Date },
) {
    const now = input.now ?? new Date();
    return db.transaction(async (tx) => {
        const row = await lockedEarning(tx, affiliateId, earningId);
        if (!row) return 'missing' as const;
        const open = clawbackOpen(row);
        if (open === 0n) return 'none' as const;
        if (input.kind === 'repaid' && (input.amount <= 0n || input.amount > open))
            return 'amount' as const;
        const settled = row.clawbackSettledAmount + (input.kind === 'repaid' ? input.amount : 0n);
        const writtenOff =
            row.clawbackWrittenOffAmount + (input.kind === 'written-off' ? open : 0n);
        const closed = row.clawbackAmount - settled - writtenOff <= 0n;
        await tx
            .update(affiliateEarnings)
            .set({
                clawbackSettledAmount: settled,
                clawbackWrittenOffAmount: writtenOff,
                clawbackNote: input.note?.trim() || row.clawbackNote,
                ...(closed ? { clawbackSettledAt: now, clawbackSettledBy: input.by } : {}),
            })
            .where(eq(affiliateEarnings.id, row.id));
        return 'done' as const;
    });
}
