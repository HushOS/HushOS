import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDatabase, createTestAccount, resetDatabase } from '../test/helpers';
import { db } from './client';
import * as growth from './growth';
import {
    affiliateDisputes,
    affiliateEarnings,
    affiliateLedgerState,
    affiliateWithdrawnOrders,
    affiliates,
} from './schema';

/*
 * Commission safety in the repository (docs/company-billing-design.md 8.4, 8.5 and 12): what is
 * left of an earning after refunds and disputes, the hold, payouts that take clawbacks back by
 * amount, the cut-over, and the insert of the release before this one against the migrated table.
 * Real rows throughout; amounts are fixed, and time is passed in, so a failure reproduces.
 */

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-11-01T12:00:00.000Z');
const days = (count: number, from = T0) => new Date(from.getTime() + count * DAY);
const OPERATOR = '6f0a1b2c-3d4e-4f50-8a61-728394a5b6c7';

beforeEach(resetDatabase);
afterAll(closeDatabase);

async function affiliate(overrides: Partial<Parameters<typeof growth.createAffiliate>[0]> = {}) {
    return growth.createAffiliate({
        name: 'Creator',
        slug: 'creator',
        code: 'CREATOR20',
        percentOff: 20,
        duration: 'forever',
        durationMonths: null,
        commissionBps: 2000,
        userId: null,
        notes: null,
        providerDiscountId: 'disc_1',
        ...overrides,
    });
}

/* An earning recorded with the switch on: 20% of `net`, held 30 days from `at`. */
async function earn(
    affiliateId: string,
    orderId: string,
    input: {
        net?: bigint;
        at?: Date;
        currency?: string;
        flag?: 'self' | 'member' | null;
        refunded?: bigint;
    } = {},
) {
    const at = input.at ?? T0;
    return growth.recordHeldEarning({
        affiliateId,
        orderId,
        userId: null,
        currency: input.currency ?? 'usd',
        netAmount: input.net ?? 10_000n,
        commissionBps: 2000,
        payableAt: days(growth.AFFILIATE_HOLD_DAYS, at),
        flag: input.flag ?? null,
        refundedAmount: input.refunded,
        now: at,
    });
}

/* An earning as the code before the switch left it: no pot, no hold, paid or not. */
async function legacy(
    affiliateId: string,
    orderId: string,
    input: { net?: number; recordedAt: Date; paidAt?: Date; refundedAt?: Date },
) {
    await growth.recordEarning({
        affiliateId,
        orderId,
        userId: null,
        currency: 'usd',
        netAmount: input.net ?? 10_000,
        commissionBps: 2000,
    });
    await db
        .update(affiliateEarnings)
        .set({
            createdAt: input.recordedAt,
            paidAt: input.paidAt ?? null,
            orderRefundedAt: input.refundedAt ?? null,
        })
        .where(eq(affiliateEarnings.orderId, orderId));
}

const row = async (orderId: string) =>
    (await db.select().from(affiliateEarnings).where(eq(affiliateEarnings.orderId, orderId)))[0]!;

const ledger = async (affiliateId: string, now: Date, currency = 'usd') =>
    (await growth.affiliateLedger(affiliateId, now))[currency]!;

const pay = (affiliateId: string, now: Date) =>
    growth.settlePayout(affiliateId, { by: OPERATOR, now });

describe('what is left of an earning', () => {
    test('a refund leaves the pot’s share of what was not refunded, rounded down', () => {
        const left = (refunded: bigint, disputeStatus: string | null = null) =>
            growth.earningLeft({ pot: 2_000n, net: 10_000n, refunded, disputeStatus });
        expect(left(0n)).toBe(2_000n);
        expect(left(5_000n)).toBe(1_000n);
        // 2000 × 6667 / 10000 is 1333.4: never rounded up in the affiliate's favour.
        expect(left(3_333n)).toBe(1_333n);
        expect(left(9_999n)).toBe(0n);
        expect(left(10_000n)).toBe(0n);
    });

    test('a refund past the net, a negative one, and an order worth nothing never leave more than the pot or less than nothing', () => {
        const base = { pot: 2_000n, net: 10_000n, disputeStatus: null };
        expect(growth.earningLeft({ ...base, refunded: 25_000n })).toBe(0n);
        expect(growth.earningLeft({ ...base, refunded: -500n })).toBe(2_000n);
        expect(growth.earningLeft({ ...base, net: 0n, refunded: 0n })).toBe(0n);
        expect(growth.earningLeft({ ...base, net: -10_000n, refunded: 0n })).toBe(0n);
        expect(growth.earningLeft({ ...base, pot: 0n, refunded: 0n })).toBe(0n);
    });

    test('a lost dispute leaves nothing whatever the refunds say; any other status takes nothing itself', () => {
        const left = (disputeStatus: string | null, refunded = 0n) =>
            growth.earningLeft({ pot: 76_800n, net: 384_000n, refunded, disputeStatus });
        expect(left('lost')).toBe(0n);
        expect(left('lost', 192_000n)).toBe(0n);
        for (const status of ['won', 'prevented', 'needs_response', 'under_review'])
            expect(left(status)).toBe(76_800n);
        expect(left('prevented', 192_000n)).toBe(38_400n);
    });

    test('amounts past 2^53 are exact, where a JavaScript number would round them', () => {
        const pot = 9_007_199_254_740_993n; // 2^53 + 1: not a number a double can hold.
        const net = 100_000_000_000_000_000n;
        // pot × (net − 1) / net is pot less a fraction of one: exactly pot − 1.
        expect(growth.earningLeft({ pot, net, refunded: 1n, disputeStatus: null })).toBe(
            9_007_199_254_740_992n,
        );
        expect(growth.earningLeft({ pot, net, refunded: 0n, disputeStatus: null })).toBe(pot);
        expect(growth.commissionOf(90_071_992_547_409_935n, 2000)).toBe(18_014_398_509_481_987n);
        expect(growth.commissionOf(799n, 2500)).toBe(199n);
        expect(growth.commissionOf(0n, 2500)).toBe(0n);
        expect(growth.commissionOf(-799n, 2500)).toBe(0n);
    });

    test('an amount past 2^53 is stored and read back exactly', async () => {
        const creator = await affiliate();
        const net = 90_071_992_547_409_935n;
        const recorded = await earn(creator.id, 'order_huge', { net });
        expect(recorded).toMatchObject({ netAmount: net, potAmount: 18_014_398_509_481_987n });
        await growth.applyRefundRead('order_huge', 1n, { now: days(1) });
        // One unit refunded of ninety quadrillion takes less than one unit of the pot: one off.
        expect((await row('order_huge')).commissionAmount).toBe(18_014_398_509_481_986n);
        expect((await ledger(creator.id, days(1))).held).toBe(18_014_398_509_481_986n);
    });
});

describe('recording an earning with the switch on', () => {
    test('nothing is recorded for a net of zero or less, and an order is recorded once however often it is reported', async () => {
        const creator = await affiliate();
        expect(await earn(creator.id, 'order_zero', { net: 0n })).toBeNull();
        expect(await earn(creator.id, 'order_negative', { net: -500n })).toBeNull();
        const recorded = await Promise.all(
            Array.from({ length: 12 }, () => earn(creator.id, 'order_once')),
        );
        expect(recorded.filter(Boolean)).toHaveLength(1);
        const rows = await db.select().from(affiliateEarnings);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            part: 'main',
            potAmount: 2_000n,
            commissionAmount: 2_000n,
            payableAt: days(30),
        });
    });

    test('an order HushOS refunded whole records nothing afterwards, and one recorded first stays in the ledger at nothing', async () => {
        const creator = await affiliate();
        expect(await growth.withdrawHeldEarning('order_late', T0)).toBe('none');
        expect(await earn(creator.id, 'order_late')).toBeNull();
        await earn(creator.id, 'order_kept');
        expect(await growth.withdrawHeldEarning('order_kept', days(1))).toBe('withdrawn');
        expect(await row('order_kept')).toMatchObject({
            potAmount: 2_000n,
            commissionAmount: 0n,
            refundedAmount: 10_000n,
        });
        // Said once: the same refund seen again changes nothing and reports nothing.
        expect(await growth.withdrawHeldEarning('order_kept', days(2))).toBe('none');
        // The refund is still on its way at Polar, so its list shows nothing yet: still nothing left.
        await growth.applyRefundRead('order_kept', 0n, { now: days(3) });
        expect((await row('order_kept')).commissionAmount).toBe(0n);
        expect(await db.select().from(affiliateWithdrawnOrders)).toHaveLength(2);
    });

    test('an earning already paid when HushOS refunds its order whole gains a clawback of all of it, said once', async () => {
        const creator = await affiliate();
        await earn(creator.id, 'order_paid');
        await pay(creator.id, days(30));
        expect(await growth.withdrawHeldEarning('order_paid', days(31))).toBe('paid');
        expect(await growth.withdrawHeldEarning('order_paid', days(32))).toBe('none');
        expect(await row('order_paid')).toMatchObject({
            paidAmount: 2_000n,
            commissionAmount: 0n,
            clawbackAmount: 2_000n,
            clawbackOrigin: null,
            orderRefundedAt: days(31),
        });
    });

    test('an affiliate removed while the order was on its way earns nothing, and one deleted has nowhere to record it', async () => {
        const creator = await affiliate();
        await growth.updateAffiliate(creator.id, { active: false, removedAt: T0 });
        expect(await earn(creator.id, 'order_after_removal')).toBeNull();
        await expect(
            earn('3e8b3a4f-9d7b-4f74-8d76-5e4c7abc2b43', 'order_nobody'),
        ).rejects.toBeInstanceOf(growth.AffiliateGoneError);
    });

    test('an order already partly refunded when its earning is recorded starts lowered', async () => {
        const creator = await affiliate();
        const recorded = await earn(creator.id, 'order_refunded_first', { refunded: 2_500n });
        expect(recorded).toMatchObject({
            potAmount: 2_000n,
            commissionAmount: 1_500n,
            refundedAmount: 2_500n,
        });
    });
});

describe('refunds', () => {
    test('two reads of one half-refunded order leave half the pot, not a quarter; the rest refunded leaves nothing; a refund that fails raises it again', async () => {
        const creator = await affiliate();
        await earn(creator.id, 'order_1');
        expect(await growth.applyRefundRead('order_1', 5_000n, { now: days(1) })).toBe(1);
        expect((await row('order_1')).commissionAmount).toBe(1_000n);
        // The same delivery again, or the daily read of the same list: nothing moves.
        expect(await growth.applyRefundRead('order_1', 5_000n, { now: days(2) })).toBe(0);
        expect(await row('order_1')).toMatchObject({
            potAmount: 2_000n,
            commissionAmount: 1_000n,
            refundsChangedAt: days(1),
            refundsReadAt: days(2),
        });
        await growth.applyRefundRead('order_1', 10_000n, { now: days(3) });
        expect((await row('order_1')).commissionAmount).toBe(0n);
        // Both refunds failed after all: everything is owed again, from the pot, not from zero.
        await growth.applyRefundRead('order_1', 0n, { now: days(4) });
        expect(await row('order_1')).toMatchObject({
            commissionAmount: 2_000n,
            refundedAmount: 0n,
        });
    });

    test('a paid earning keeps what was paid and gains a clawback of the refunded share; a refund that fails takes the clawback away', async () => {
        const creator = await affiliate();
        await earn(creator.id, 'order_1');
        expect((await pay(creator.id, days(30))).paid).toBe(1);
        await growth.applyRefundRead('order_1', 2_500n, { now: days(40) });
        expect(await row('order_1')).toMatchObject({
            paidAmount: 2_000n,
            commissionAmount: 1_500n,
            clawbackAmount: 500n,
            clawbackAt: days(40),
            clawbackSettledAt: null,
            orderRefundedAt: days(40),
        });
        await growth.applyRefundRead('order_1', 10_000n, { now: days(41) });
        expect(await row('order_1')).toMatchObject({
            commissionAmount: 0n,
            clawbackAmount: 2_000n,
        });
        await growth.applyRefundRead('order_1', 0n, { now: days(42) });
        expect(await row('order_1')).toMatchObject({
            paidAmount: 2_000n,
            commissionAmount: 2_000n,
            clawbackAmount: 0n,
        });
        expect(await ledger(creator.id, days(42))).toMatchObject({
            paidOut: 2_000n,
            payable: 0n,
            clawbackOpen: 0n,
        });
    });

    test('an earning paid at a lowered amount is owed the rest when the refund that lowered it fails', async () => {
        const creator = await affiliate();
        await earn(creator.id, 'order_1');
        await growth.applyRefundRead('order_1', 5_000n, { now: days(1) });
        await pay(creator.id, days(30));
        expect(await row('order_1')).toMatchObject({ paidAmount: 1_000n });
        await growth.applyRefundRead('order_1', 0n, { now: days(35) });
        expect(await ledger(creator.id, days(35))).toMatchObject({
            paidOut: 1_000n,
            payable: 1_000n,
            clawbackOpen: 0n,
        });
        const second = await pay(creator.id, days(36));
        expect(second.payouts.usd).toEqual({ owed: 1_000n, netted: 0n, payout: 1_000n });
        expect(await ledger(creator.id, days(36))).toMatchObject({ paidOut: 2_000n, payable: 0n });
    });
});

describe('disputes', () => {
    const dispute = (status: string, openedAt = days(2), id = 'dp_1') => ({
        id,
        orderId: 'order_1',
        status,
        openedAt,
    });

    test('an open dispute keeps an earning from being paid; won clears it and leaves the amount', async () => {
        const creator = await affiliate();
        await earn(creator.id, 'order_1');
        for (const status of ['early_warning', 'needs_response', 'under_review']) {
            await growth.recordDispute(dispute(status), { now: days(3) });
            expect(await ledger(creator.id, days(40))).toMatchObject({
                flagged: 2_000n,
                payable: 0n,
            });
            expect((await pay(creator.id, days(40))).paid).toBe(0);
        }
        await growth.recordDispute(dispute('won'), { now: days(41) });
        expect(await row('order_1')).toMatchObject({
            disputeId: 'dp_1',
            disputeStatus: 'won',
            commissionAmount: 2_000n,
        });
        expect((await pay(creator.id, days(41))).paid).toBe(1);
    });

    test('a status Polar adds later holds the earning as an open dispute does', async () => {
        const creator = await affiliate();
        await earn(creator.id, 'order_1');
        await growth.recordDispute(dispute('warning_closed_pending'), { now: days(3) });
        expect((await pay(creator.id, days(40))).paid).toBe(0);
    });

    test('a 768 USD pot whose dispute is lost is nothing, and is still nothing after the daily read of its refunds finds none', async () => {
        const creator = await affiliate();
        await earn(creator.id, 'order_1', { net: 384_000n });
        expect((await row('order_1')).potAmount).toBe(76_800n);
        await growth.recordDispute(dispute('lost'), { now: days(5) });
        expect((await row('order_1')).commissionAmount).toBe(0n);
        await growth.applyRefundRead('order_1', 0n, { now: days(6) });
        expect(await row('order_1')).toMatchObject({ potAmount: 76_800n, commissionAmount: 0n });
        expect((await pay(creator.id, days(40))).paid).toBe(0);
    });

    test('a paid earning whose dispute is lost keeps its clawback of the whole amount through the refund read', async () => {
        const creator = await affiliate();
        await earn(creator.id, 'order_1', { net: 384_000n });
        await pay(creator.id, days(30));
        await growth.recordDispute(dispute('lost', days(45)), { now: days(46) });
        expect((await row('order_1')).clawbackAmount).toBe(76_800n);
        await growth.applyRefundRead('order_1', 0n, { now: days(47) });
        expect(await row('order_1')).toMatchObject({
            paidAmount: 76_800n,
            clawbackAmount: 76_800n,
            // A chargeback is not a refund: nothing says the order was refunded.
            orderRefundedAt: null,
        });
    });

    test('a half refund, then lost, then the refund read again, is nothing; won afterwards puts back the half the refund left', async () => {
        const creator = await affiliate();
        await earn(creator.id, 'order_1');
        await growth.applyRefundRead('order_1', 5_000n, { now: days(1) });
        await growth.recordDispute(dispute('lost'), { now: days(5) });
        await growth.applyRefundRead('order_1', 5_000n, { now: days(6) });
        expect((await row('order_1')).commissionAmount).toBe(0n);
        // Polar's own answer changes (a dispute lost, then won on appeal).
        await growth.recordDispute(dispute('won'), { now: days(9) });
        expect((await row('order_1')).commissionAmount).toBe(1_000n);
    });

    test('the same dispute read again and again writes one record and changes nothing', async () => {
        const creator = await affiliate();
        await earn(creator.id, 'order_1');
        await growth.recordDispute(dispute('lost'), { now: days(5) });
        const first = await row('order_1');
        await growth.recordDispute(dispute('lost'), { now: days(6) });
        await growth.recordDispute(dispute('lost'), { now: days(7) });
        expect(await row('order_1')).toEqual(first);
        expect(await db.select().from(affiliateDisputes)).toEqual([
            expect.objectContaining({ id: 'dp_1', status: 'lost', lastReadAt: days(7) }),
        ]);
    });

    test('a dispute seen before its earning exists: the earning starts flagged for an open one, at nothing for a lost one, untouched by a won one', async () => {
        const creator = await affiliate();
        const seen = async (orderId: string, status: string) => {
            const outcome = await growth.recordDispute(
                { id: `dp_${orderId}`, orderId, status, openedAt: days(1) },
                { now: days(2) },
            );
            // No earning yet: nothing to match, and nothing to read refunds for.
            expect(outcome).toEqual({ earnings: 0, refunds: false });
            return earn(creator.id, orderId, { at: days(3) });
        };
        expect(await seen('order_open', 'under_review')).toMatchObject({
            commissionAmount: 2_000n,
            disputeStatus: 'under_review',
            disputedAt: days(1),
        });
        expect(await seen('order_lost', 'lost')).toMatchObject({
            potAmount: 2_000n,
            commissionAmount: 0n,
            disputeId: 'dp_order_lost',
        });
        expect(await seen('order_won', 'won')).toMatchObject({ commissionAmount: 2_000n });
        expect(await ledger(creator.id, days(40))).toMatchObject({
            flagged: 2_000n,
            payable: 2_000n,
            lowered: 2_000n,
        });
    });

    test('a prevented dispute takes nothing itself and says the order’s refunds are to be read', async () => {
        const creator = await affiliate();
        await earn(creator.id, 'order_1');
        expect(await growth.recordDispute(dispute('prevented'), { now: days(3) })).toEqual({
            earnings: 1,
            refunds: true,
        });
        expect(await row('order_1')).toMatchObject({
            commissionAmount: 2_000n,
            disputeStatus: 'prevented',
        });
        // Not flagged: it is closed, and the refund is what lowers it.
        expect((await ledger(creator.id, days(3))).held).toBe(2_000n);
    });

    test('of two disputes on one order the lost one decides, whichever was read last', async () => {
        const creator = await affiliate();
        await earn(creator.id, 'order_1');
        await growth.recordDispute(dispute('lost', days(2), 'dp_old'), { now: days(3) });
        await growth.recordDispute(dispute('won', days(4), 'dp_new'), { now: days(5) });
        expect(await row('order_1')).toMatchObject({ disputeId: 'dp_old', commissionAmount: 0n });
    });
});

describe('the hold, flags and voiding', () => {
    test('an earning cannot be marked paid on day 29, can at the moment its hold ends, and on day 31', async () => {
        const creator = await affiliate();
        await earn(creator.id, 'order_1');
        const justBefore = new Date(days(30).getTime() - 1);
        expect((await pay(creator.id, days(29))).paid).toBe(0);
        expect((await pay(creator.id, justBefore)).paid).toBe(0);
        expect(await ledger(creator.id, justBefore)).toMatchObject({ held: 2_000n, payable: 0n });
        expect((await row('order_1')).paidAt).toBeNull();
        expect(await ledger(creator.id, days(30))).toMatchObject({ held: 0n, payable: 2_000n });
        await earn(creator.id, 'order_2', { at: days(1) });
        const paid = await pay(creator.id, days(31));
        expect(paid).toMatchObject({ paid: 2 });
        expect(paid.payouts.usd).toEqual({ owed: 4_000n, netted: 0n, payout: 4_000n });
        expect(await row('order_1')).toMatchObject({ paidAt: days(31), paidAmount: 2_000n });
        // Paid once: a second click pays nothing more.
        expect(await pay(creator.id, days(32))).toEqual({ paid: 0, payouts: {} });
    });

    test('a flagged earning is not paid until an operator releases it, and a dispute’s hold is not theirs to lift', async () => {
        const creator = await affiliate();
        const own = (await earn(creator.id, 'order_self', { flag: 'self' }))!;
        const disputed = (await earn(creator.id, 'order_disputed'))!;
        await growth.recordDispute(
            { id: 'dp_1', orderId: 'order_disputed', status: 'needs_response', openedAt: days(2) },
            { now: days(3) },
        );
        expect((await pay(creator.id, days(40))).paid).toBe(0);
        expect(
            await growth.releaseEarningFlag(creator.id, disputed.id, {
                by: OPERATOR,
                now: days(40),
            }),
        ).toBe('unflagged');
        expect(
            await growth.releaseEarningFlag(creator.id, own.id, { by: OPERATOR, now: days(40) }),
        ).toBe('done');
        const paid = await pay(creator.id, days(40));
        expect(paid.paid).toBe(1);
        expect((await row('order_self')).paidAt).toEqual(days(40));
        expect((await row('order_disputed')).paidAt).toBeNull();
        // Another affiliate's earning cannot be released through this one.
        const other = await affiliate({
            slug: 'other',
            code: 'OTHER20',
            providerDiscountId: 'disc_2',
        });
        const theirs = (await earn(other.id, 'order_theirs', { flag: 'self' }))!;
        expect(await growth.releaseEarningFlag(creator.id, theirs.id, { by: OPERATOR })).toBe(
            'missing',
        );
    });

    test('a voided earning is owed to nobody, is never paid, and a paid one cannot be voided', async () => {
        const creator = await affiliate();
        const fraud = (await earn(creator.id, 'order_fraud'))!;
        const honest = (await earn(creator.id, 'order_honest'))!;
        expect(growth.ledgerBlocksRemoval(await growth.affiliateLedger(creator.id, days(1)))).toBe(
            true,
        );
        expect(
            await growth.voidEarning(creator.id, fraud.id, {
                by: OPERATOR,
                reason: 'Stolen cards',
                now: days(1),
            }),
        ).toBe('done');
        expect((await pay(creator.id, days(40))).paid).toBe(1);
        expect(await row('order_fraud')).toMatchObject({
            paidAt: null,
            voidedAt: days(1),
            voidedBy: OPERATOR,
            voidReason: 'Stolen cards',
        });
        expect(await ledger(creator.id, days(40))).toMatchObject({
            earned: 4_000n,
            voided: 2_000n,
            paidOut: 2_000n,
            payable: 0n,
            held: 0n,
        });
        // With the other one paid, the voided one stands in nobody's way.
        expect(growth.ledgerBlocksRemoval(await growth.affiliateLedger(creator.id, days(40)))).toBe(
            false,
        );
        expect(
            await growth.voidEarning(creator.id, honest.id, { by: OPERATOR, reason: 'Too late' }),
        ).toBe('paid');
        expect((await row('order_honest')).voidedAt).toBeNull();
    });

    test('the figures an operator was shown must still be the ledger’s, or nothing is marked', async () => {
        const creator = await affiliate();
        await earn(creator.id, 'order_1');
        const shown = { usd: { owed: '2000', netted: '0' } };
        // A refund lands between the page loading and the click.
        await growth.applyRefundRead('order_1', 5_000n, { now: days(31) });
        await expect(
            growth.settlePayout(creator.id, { by: OPERATOR, now: days(31), expected: shown }),
        ).rejects.toBeInstanceOf(growth.PayoutChangedError);
        expect((await row('order_1')).paidAt).toBeNull();
        // A currency the page did not show is a change too.
        await earn(creator.id, 'order_inr', { currency: 'inr' });
        await expect(
            growth.settlePayout(creator.id, {
                by: OPERATOR,
                now: days(31),
                expected: { usd: { owed: '1000', netted: '0' } },
            }),
        ).rejects.toBeInstanceOf(growth.PayoutChangedError);
        const paid = await growth.settlePayout(creator.id, {
            by: OPERATOR,
            now: days(31),
            expected: { usd: { owed: '1000', netted: '0' }, inr: { owed: '2000', netted: '0' } },
        });
        expect(paid.paid).toBe(2);
    });
});

describe('clawbacks are settled by amount', () => {
    /* An earning paid on day 30 whose order is then refunded whole: a clawback of its whole commission. */
    async function clawedBack(affiliateId: string, orderId: string, net: bigint, refundedOn: Date) {
        await earn(affiliateId, orderId, { net });
        await pay(affiliateId, days(30));
        await growth.applyRefundRead(orderId, net, { now: refundedOn });
    }

    test('with 50 owed and a 768 clawback, marking paid pays nothing, applies 50, and leaves 718 open for the next payout', async () => {
        const creator = await affiliate();
        await clawedBack(creator.id, 'order_big', 384_000n, days(40));
        await earn(creator.id, 'order_small', { net: 25_000n, at: days(35) });
        expect(growth.payoutOf(await ledger(creator.id, days(70)))).toEqual({
            owed: 5_000n,
            netted: 5_000n,
            payout: 0n,
        });
        const paid = await pay(creator.id, days(70));
        expect(paid.payouts.usd).toEqual({ owed: 5_000n, netted: 5_000n, payout: 0n });
        expect(await row('order_big')).toMatchObject({
            clawbackAmount: 76_800n,
            clawbackSettledAmount: 5_000n,
            clawbackSettledAt: null,
        });
        expect((await row('order_small')).paidAt).toEqual(days(70));
        // 718 is still to come back, and the affiliate cannot be removed past it.
        const after = await ledger(creator.id, days(70));
        expect(after).toMatchObject({ payable: 0n, clawbackOpen: 71_800n });
        expect(growth.ledgerBlocksRemoval({ usd: after })).toBe(true);
        await earn(creator.id, 'order_next', { net: 500_000n, at: days(71) });
        expect(growth.payoutOf(await ledger(creator.id, days(110)))).toEqual({
            owed: 100_000n,
            netted: 71_800n,
            payout: 28_200n,
        });
        await pay(creator.id, days(110));
        expect(await row('order_big')).toMatchObject({
            clawbackSettledAmount: 76_800n,
            clawbackSettledAt: days(110),
            clawbackSettledBy: OPERATOR,
        });
        expect(await ledger(creator.id, days(110))).toMatchObject({
            clawbackOpen: 0n,
            payable: 0n,
        });
    });

    test('a clawback smaller than what is owed is settled and never taken again', async () => {
        const creator = await affiliate();
        await clawedBack(creator.id, 'order_small', 5_000n, days(40));
        await earn(creator.id, 'order_big', { net: 50_000n, at: days(35) });
        const first = await pay(creator.id, days(70));
        expect(first.payouts.usd).toEqual({ owed: 10_000n, netted: 1_000n, payout: 9_000n });
        await earn(creator.id, 'order_later', { net: 50_000n, at: days(71) });
        const second = await pay(creator.id, days(110));
        expect(second.payouts.usd).toEqual({ owed: 10_000n, netted: 0n, payout: 10_000n });
    });

    test('two clawbacks are taken oldest first, each up to what is open on it, and only in their own currency', async () => {
        const creator = await affiliate();
        await earn(creator.id, 'order_a', { net: 10_000n });
        await earn(creator.id, 'order_b', { net: 20_000n });
        await earn(creator.id, 'order_eur', { net: 10_000n, currency: 'eur' });
        await pay(creator.id, days(30));
        // The later order is refunded first: its clawback is the older one.
        await growth.applyRefundRead('order_b', 20_000n, { now: days(40) });
        await growth.applyRefundRead('order_a', 10_000n, { now: days(41) });
        await growth.applyRefundRead('order_eur', 10_000n, { now: days(42) });
        await earn(creator.id, 'order_c', { net: 22_500n, at: days(43) });
        const paid = await pay(creator.id, days(80));
        expect(paid.payouts).toEqual({ usd: { owed: 4_500n, netted: 4_500n, payout: 0n } });
        expect(await row('order_b')).toMatchObject({
            clawbackSettledAmount: 4_000n,
            clawbackSettledAt: days(80),
        });
        expect(await row('order_a')).toMatchObject({
            clawbackSettledAmount: 500n,
            clawbackSettledAt: null,
        });
        // Dollars owed never settle a clawback in euros.
        expect(await row('order_eur')).toMatchObject({ clawbackSettledAmount: 0n });
        expect((await ledger(creator.id, days(80), 'eur')).clawbackOpen).toBe(2_000n);
    });

    test('settled by hand in part leaves the rest open; a repayment past what is open, or of nothing, is refused; a write-off closes it', async () => {
        const creator = await affiliate();
        await clawedBack(creator.id, 'order_1', 10_000n, days(40));
        const { id } = await row('order_1');
        const settle = (input: Parameters<typeof growth.settleClawback>[2]) =>
            growth.settleClawback(creator.id, id, input);
        expect(await settle({ kind: 'repaid', amount: 2_001n, by: OPERATOR })).toBe('amount');
        expect(await settle({ kind: 'repaid', amount: 0n, by: OPERATOR })).toBe('amount');
        expect(await settle({ kind: 'repaid', amount: -5n, by: OPERATOR })).toBe('amount');
        expect((await row('order_1')).clawbackSettledAmount).toBe(0n);
        expect(await settle({ kind: 'repaid', amount: 600n, by: OPERATOR, now: days(41) })).toBe(
            'done',
        );
        expect(await row('order_1')).toMatchObject({
            clawbackSettledAmount: 600n,
            clawbackSettledAt: null,
        });
        expect((await ledger(creator.id, days(41))).clawbackOpen).toBe(1_400n);
        expect(
            await settle({
                kind: 'written-off',
                note: 'Account closed, unreachable',
                by: OPERATOR,
                now: days(42),
            }),
        ).toBe('done');
        expect(await row('order_1')).toMatchObject({
            clawbackSettledAmount: 600n,
            clawbackWrittenOffAmount: 1_400n,
            clawbackSettledAt: days(42),
            clawbackSettledBy: OPERATOR,
            clawbackNote: 'Account closed, unreachable',
        });
        expect((await ledger(creator.id, days(42))).clawbackOpen).toBe(0n);
        expect(await settle({ kind: 'repaid', amount: 1n, by: OPERATOR })).toBe('none');
    });

    test('a read that lowers a clawback below what was taken back shows the difference as owed to the affiliate, once', async () => {
        const creator = await affiliate();
        await clawedBack(creator.id, 'order_1', 10_000n, days(40));
        const { id } = await row('order_1');
        await growth.settleClawback(creator.id, id, {
            kind: 'repaid',
            amount: 2_000n,
            by: OPERATOR,
            now: days(41),
        });
        // Half the refund failed after all: only 1,000 was ever due back, and 2,000 came back.
        await growth.applyRefundRead('order_1', 5_000n, { now: days(45) });
        expect(await row('order_1')).toMatchObject({
            clawbackAmount: 1_000n,
            clawbackSettledAmount: 2_000n,
        });
        expect(await ledger(creator.id, days(45))).toMatchObject({
            payable: 1_000n,
            clawbackOpen: 0n,
        });
        const paid = await pay(creator.id, days(46));
        expect(paid.payouts.usd).toEqual({ owed: 1_000n, netted: 0n, payout: 1_000n });
        expect(await ledger(creator.id, days(46))).toMatchObject({ payable: 0n });
        expect(await pay(creator.id, days(47))).toEqual({ paid: 0, payouts: {} });
    });

    test('money written off is not money taken back: lowering the clawback afterwards owes the affiliate nothing', async () => {
        const creator = await affiliate();
        await clawedBack(creator.id, 'order_1', 10_000n, days(40));
        const { id } = await row('order_1');
        await growth.settleClawback(creator.id, id, {
            kind: 'written-off',
            note: 'Goodwill',
            by: OPERATOR,
            now: days(41),
        });
        await growth.applyRefundRead('order_1', 0n, { now: days(45) });
        expect(await ledger(creator.id, days(45))).toMatchObject({ payable: 0n, clawbackOpen: 0n });
    });
});

describe('the cut-over', () => {
    test('it happens once: a second run changes nothing and makes no second clawback', async () => {
        const creator = await affiliate();
        await legacy(creator.id, 'order_refunded', {
            recordedAt: days(-300),
            paidAt: days(-250),
            refundedAt: days(-240),
        });
        await legacy(creator.id, 'order_unpaid', { recordedAt: days(-10) });
        const first = await growth.beginCutover(T0);
        expect(first.began).toBe(true);
        expect(await row('order_refunded')).toMatchObject({
            potAmount: 2_000n,
            paidAmount: 2_000n,
            commissionAmount: 0n,
            clawbackAmount: 2_000n,
            clawbackOrigin: 'cutover',
            clawbackConfirmedAt: null,
        });
        const before = await db.select().from(affiliateEarnings).orderBy(affiliateEarnings.orderId);
        const second = await growth.beginCutover(days(5));
        expect(second.began).toBe(false);
        expect(second.state.cutoverAt).toEqual(T0);
        expect(
            await db.select().from(affiliateEarnings).orderBy(affiliateEarnings.orderId),
        ).toEqual(before);
        expect(await db.select().from(affiliateLedgerState)).toHaveLength(1);
    });

    test('an earning from before the switch is not held; one recorded after it is held 30 days', async () => {
        const creator = await affiliate();
        await legacy(creator.id, 'order_before', { recordedAt: days(-1) });
        await growth.beginCutover(T0);
        await earn(creator.id, 'order_after', { at: days(1) });
        expect(await ledger(creator.id, days(2))).toMatchObject({ payable: 2_000n, held: 2_000n });
        expect((await pay(creator.id, days(2))).paid).toBe(1);
        expect((await row('order_before')).paidAt).toEqual(days(2));
        expect((await row('order_after')).paidAt).toBeNull();
    });

    test('a clawback the cut-over made is listed and counted in no net and no payout until an operator confirms it; then it nets as any other', async () => {
        const creator = await affiliate();
        await legacy(creator.id, 'order_refunded', {
            recordedAt: days(-90),
            paidAt: days(-80),
            refundedAt: days(-70),
        });
        await legacy(creator.id, 'order_owed', { recordedAt: days(-5), net: 5_000 });
        await growth.beginCutover(T0);
        expect(await ledger(creator.id, days(1))).toMatchObject({
            payable: 1_000n,
            clawbackOpen: 0n,
            clawbackUnconfirmed: 2_000n,
        });
        const first = await pay(creator.id, days(1));
        expect(first.payouts.usd).toEqual({ owed: 1_000n, netted: 0n, payout: 1_000n });
        expect((await row('order_refunded')).clawbackSettledAmount).toBe(0n);
        // Listed, and it still stands in the way of removing them.
        expect(growth.ledgerBlocksRemoval(await growth.affiliateLedger(creator.id, days(1)))).toBe(
            true,
        );
        const { id } = await row('order_refunded');
        expect(await growth.confirmClawback(creator.id, id, { by: OPERATOR, now: days(2) })).toBe(
            'done',
        );
        await legacy(creator.id, 'order_next', { recordedAt: days(3), net: 5_000 });
        const second = await pay(creator.id, days(4));
        expect(second.payouts.usd).toEqual({ owed: 1_000n, netted: 1_000n, payout: 0n });
        expect(await row('order_refunded')).toMatchObject({
            clawbackSettledAmount: 1_000n,
            clawbackConfirmedBy: OPERATOR,
        });
    });

    test('a clawback that arises after the switch nets without anyone’s yes, and has nothing to confirm', async () => {
        const creator = await affiliate();
        await growth.beginCutover(T0);
        await earn(creator.id, 'order_1', { at: days(1) });
        await pay(creator.id, days(31));
        await growth.applyRefundRead('order_1', 10_000n, { now: days(40) });
        await earn(creator.id, 'order_2', { at: days(35) });
        expect(await row('order_1')).toMatchObject({ clawbackOrigin: null });
        expect(
            await growth.confirmClawback(creator.id, (await row('order_1')).id, { by: OPERATOR }),
        ).toBe('none');
        const paid = await pay(creator.id, days(70));
        expect(paid.payouts.usd).toEqual({ owed: 2_000n, netted: 2_000n, payout: 0n });
    });

    test('the reach back reads every unpaid earning whatever its age and every one paid in the 120 days before the switch, and each only until it was read', async () => {
        const creator = await affiliate();
        await legacy(creator.id, 'order_unpaid_old', { recordedAt: days(-900) });
        await legacy(creator.id, 'order_paid_100', { recordedAt: days(-130), paidAt: days(-100) });
        await legacy(creator.id, 'order_paid_120', {
            recordedAt: days(-130),
            paidAt: new Date(days(-120).getTime()),
        });
        await legacy(creator.id, 'order_paid_121', { recordedAt: days(-130), paidAt: days(-121) });
        await legacy(creator.id, 'order_paid_200', { recordedAt: days(-230), paidAt: days(-200) });
        const { state } = await growth.beginCutover(T0);
        await earn(creator.id, 'order_new', { at: days(1) });
        expect(await growth.reachBackOrders(state)).toEqual([
            'order_paid_100',
            'order_paid_120',
            'order_unpaid_old',
        ]);
        const reach = { cutoverAt: state.cutoverAt };
        // An unpaid one is lowered at once: it was never owed.
        await growth.applyRefundRead('order_unpaid_old', 10_000n, { now: days(1), reach });
        expect((await row('order_unpaid_old')).commissionAmount).toBe(0n);
        // A paid one gains a clawback that waits for a yes.
        await growth.applyRefundRead('order_paid_100', 10_000n, { now: days(1), reach });
        expect(await row('order_paid_100')).toMatchObject({
            clawbackAmount: 2_000n,
            clawbackOrigin: 'cutover',
            clawbackConfirmedAt: null,
        });
        expect(await growth.reachBackOrders(state)).toEqual(['order_paid_120']);
        expect(await row('order_paid_200')).toMatchObject({
            clawbackAmount: 0n,
            refundsReadAt: null,
        });
    });

    test('a dispute from before the switch reaches an earning paid 100 days before it, as the cut-over’s own, and leaves one paid 200 days before it alone', async () => {
        const creator = await affiliate();
        await legacy(creator.id, 'order_paid_100', { recordedAt: days(-130), paidAt: days(-100) });
        await legacy(creator.id, 'order_paid_200', { recordedAt: days(-230), paidAt: days(-200) });
        const { state } = await growth.beginCutover(T0);
        const reach = { cutoverAt: state.cutoverAt };
        for (const orderId of ['order_paid_100', 'order_paid_200'])
            await growth.recordDispute(
                { id: `dp_${orderId}`, orderId, status: 'lost', openedAt: days(-90) },
                { now: days(1), reach },
            );
        expect(await row('order_paid_100')).toMatchObject({
            clawbackAmount: 2_000n,
            clawbackOrigin: 'cutover',
        });
        expect(await row('order_paid_200')).toMatchObject({
            clawbackAmount: 0n,
            commissionAmount: 2_000n,
            disputeStatus: null,
        });
        // The dispute itself is kept either way.
        expect(await db.select().from(affiliateDisputes)).toHaveLength(2);
        // One opened after the switch is not the past's: it reaches the old earning too.
        await growth.recordDispute(
            { id: 'dp_new', orderId: 'order_paid_200', status: 'lost', openedAt: days(3) },
            { now: days(4) },
        );
        expect(await row('order_paid_200')).toMatchObject({
            clawbackAmount: 2_000n,
            clawbackOrigin: null,
        });
    });

    test('an affiliate paused before the switch is given a pause time, so the people they had brought go on earning', async () => {
        const creator = await affiliate();
        await growth.updateAffiliate(creator.id, { active: false });
        await growth.beginCutover(T0);
        const [paused] = await db.select().from(affiliates).where(eq(affiliates.id, creator.id));
        expect(paused).toMatchObject({ active: false, pausedAt: T0 });
    });
});

describe('the daily refund read', () => {
    test('it lists what could still be paid and what a refund changed lately, least recently read first, and nothing voided or long settled', async () => {
        const creator = await affiliate();
        await earn(creator.id, 'order_unread');
        await earn(creator.id, 'order_read_yesterday');
        await growth.applyRefundRead('order_read_yesterday', 0n, { now: days(9) });
        const voided = (await earn(creator.id, 'order_voided'))!;
        await growth.voidEarning(creator.id, voided.id, { by: OPERATOR, reason: 'Fraud' });
        // Refunded whole 31 days ago and unpaid: nothing can be paid on it, and the refund is old.
        await earn(creator.id, 'order_refunded_long_ago', { at: days(-60) });
        await growth.applyRefundRead('order_refunded_long_ago', 10_000n, { now: days(-21) });
        // Paid, then refunded 29 days ago: the refund can still fail.
        await earn(creator.id, 'order_paid_refunded', { at: days(-60) });
        await pay(creator.id, days(-25));
        await growth.applyRefundRead('order_paid_refunded', 10_000n, { now: days(-19) });
        // Paid and never refunded: nothing reads it again.
        await earn(creator.id, 'order_paid_clean', { at: days(-80) });
        await pay(creator.id, days(-22));
        expect(await growth.dueRefundReads({ now: days(10) })).toEqual([
            'order_unread',
            'order_paid_refunded',
            'order_read_yesterday',
        ]);
        expect(await growth.dueRefundReads({ now: days(10), limit: 1 })).toEqual(['order_unread']);
        // A day later the old refund is past its 30 days too.
        expect(await growth.dueRefundReads({ now: days(12) })).not.toContain('order_paid_refunded');
    });
});

describe('the ledger', () => {
    test('every pot is in exactly one place: paid out, payable, held, flagged, lowered or voided', async () => {
        const creator = await affiliate();
        await earn(creator.id, 'order_paid', { net: 10_000n, at: days(-40) });
        await pay(creator.id, days(-5));
        await earn(creator.id, 'order_payable', { net: 20_000n, at: days(-31) });
        await earn(creator.id, 'order_held', { net: 30_000n, at: days(-2) });
        await earn(creator.id, 'order_flagged', { net: 40_000n, at: days(-35), flag: 'self' });
        await earn(creator.id, 'order_half', { net: 50_000n, at: days(-2) });
        await growth.applyRefundRead('order_half', 25_000n, { now: days(-1) });
        const voided = (await earn(creator.id, 'order_voided', { net: 60_000n, at: days(-2) }))!;
        await growth.voidEarning(creator.id, voided.id, { by: OPERATOR, reason: 'Fraud' });
        const totals = await ledger(creator.id, T0);
        expect(totals).toEqual({
            earned: 42_000n,
            paidOut: 2_000n,
            payable: 4_000n,
            held: 6_000n + 5_000n,
            flagged: 8_000n,
            lowered: 5_000n,
            voided: 12_000n,
            clawbackOpen: 0n,
            clawbackUnconfirmed: 0n,
        });
        expect(
            totals.paidOut +
                totals.payable +
                totals.held +
                totals.flagged +
                totals.lowered +
                totals.voided,
        ).toBe(totals.earned);
    });
});

describe('during the rollout', () => {
    /* The insert of the release before this one, as its drizzle wrote it: no `part`, no pot. */
    const OLD_INSERT = (affiliateId: string, orderId: string) => sql`
        insert into "affiliate_earnings"
            ("id", "affiliate_id", "order_id", "user_id", "currency", "net_amount", "commission_amount", "paid_at", "order_refunded_at", "created_at")
        values (default, ${affiliateId}, ${orderId}, null, 'usd', 1000, 200, default, default, default)
        on conflict ("order_id") do nothing
        returning "id"`;

    test('the insert of the release before this one still works against the migrated table, once per order, beside the new one', async () => {
        const creator = await affiliate();
        expect(
            (await db.execute<{ id: string }>(OLD_INSERT(creator.id, 'order_old'))).rows,
        ).toHaveLength(1);
        expect(
            (await db.execute<{ id: string }>(OLD_INSERT(creator.id, 'order_old'))).rows,
        ).toHaveLength(0);
        // What it wrote reads as an earning that is not held and whose pot is its commission.
        expect(await row('order_old')).toMatchObject({
            part: 'main',
            netAmount: 1_000n,
            commissionAmount: 200n,
            potAmount: null,
            payableAt: null,
            refundedAmount: 0n,
            clawbackAmount: 0n,
        });
        expect(await ledger(creator.id, T0)).toMatchObject({ earned: 200n, payable: 200n });
        // The new insert and the old one refuse each other's order, in either order.
        expect(await earn(creator.id, 'order_old')).toBeNull();
        await earn(creator.id, 'order_new');
        expect(
            (await db.execute<{ id: string }>(OLD_INSERT(creator.id, 'order_new'))).rows,
        ).toHaveLength(0);
        expect(await db.select().from(affiliateEarnings)).toHaveLength(2);
        // An old row lowered by the new code keeps its pot from then on.
        await growth.applyRefundRead('order_old', 500n, { now: days(1) });
        await growth.applyRefundRead('order_old', 500n, { now: days(2) });
        expect(await row('order_old')).toMatchObject({ potAmount: 200n, commissionAmount: 100n });
    });

    test('with the unique order id dropped the old insert fails, which is why this release keeps it', async () => {
        const creator = await affiliate();
        await expect(
            db.transaction(async (tx) => {
                await tx.execute(
                    sql`alter table affiliate_earnings drop constraint affiliate_earnings_order_id_key`,
                );
                // The new insert names (order_id, part), so it still works.
                await tx.execute(sql`
                    insert into affiliate_earnings (affiliate_id, order_id, currency, net_amount, commission_amount)
                    values (${creator.id}, 'order_new', 'usd', 1000, 200)
                    on conflict (order_id, part) do nothing`);
                await tx.execute(OLD_INSERT(creator.id, 'order_old'));
            }),
        ).rejects.toMatchObject({ cause: { code: '42P10' } });
        // Rolled back: the constraint is still there for the tests that follow.
        expect(
            (await db.execute<{ id: string }>(OLD_INSERT(creator.id, 'order_old'))).rows,
        ).toHaveLength(1);
    });

    test('an order may hold one row per part and no second row of the same part', async () => {
        const creator = await affiliate();
        await earn(creator.id, 'order_1');
        await expect(
            db.execute(sql`
                insert into affiliate_earnings (affiliate_id, order_id, part, currency, net_amount, commission_amount)
                values (${creator.id}, 'order_other', 'third', 'usd', 1000, 200)`),
        ).rejects.toMatchObject({ cause: { code: '23514' } });
        await expect(
            db.execute(sql`
                insert into affiliate_earnings (affiliate_id, order_id, currency, net_amount, commission_amount)
                values (${creator.id}, 'order_negative', 'usd', 1000, -1)`),
        ).rejects.toMatchObject({ cause: { code: '23514' } });
    });
});

describe('who a paused affiliate still earns from', () => {
    test('an attribution carries when it was made, and an earlier earning is found only before the time asked', async () => {
        const creator = await affiliate();
        const customer = await createTestAccount();
        const stranger = await createTestAccount();
        await growth.attributeSignup({ userId: customer.userId, code: 'CREATOR20' });
        const attribution = await growth.findAttribution(customer.userId);
        expect(attribution?.affiliate.id).toBe(creator.id);
        expect(attribution?.attributedAt).toBeInstanceOf(Date);
        expect(await growth.findAttribution(stranger.userId)).toBeNull();
        await growth.recordHeldEarning({
            affiliateId: creator.id,
            orderId: 'order_1',
            userId: stranger.userId,
            currency: 'usd',
            netAmount: 10_000n,
            commissionBps: 2000,
            payableAt: days(30),
            now: T0,
        });
        expect(await growth.earnedBefore(creator.id, stranger.userId, days(1))).toBe(true);
        expect(await growth.earnedBefore(creator.id, stranger.userId, T0)).toBe(false);
        expect(await growth.earnedBefore(creator.id, customer.userId, days(1))).toBe(false);
    });
});
