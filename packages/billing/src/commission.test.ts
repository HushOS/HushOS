import type * as PolarSdk from '@polar-sh/sdk/2026-10';
import { PolarClientError } from '@polar-sh/sdk';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * Commission safety with the switch on (docs/company-billing-design.md 8.4, 8.5 and 12), through
 * the billing server: real webhook signatures, real rows, and Polar's client replaced where the
 * code reaches it by a small in-memory organisation holding refunds, disputes and discounts.
 * Nothing here reaches the network. `commission-off.test.ts` is the same server with the switch off.
 */
process.env.APP_ORIGIN = 'http://localhost:5173';
process.env.BILLING_PROVIDER = 'polar';
process.env.POLAR_ENVIRONMENT = 'sandbox';
process.env.POLAR_ACCESS_TOKEN = 'polar_oat_test';
const SECRET_BYTES = Buffer.from('0123456789abcdef0123456789abcdef');
process.env.POLAR_WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
process.env.AFFILIATE_V2_ENABLED = 'true';

const DAY = 24 * 60 * 60 * 1000;
const OPERATOR = '6f0a1b2c-3d4e-4f50-8a61-728394a5b6c7';

type FakeRefund = {
    id: string;
    order_id: string;
    amount: number;
    status: 'pending' | 'succeeded' | 'failed' | 'canceled';
};
type FakeDispute = { id: string; order_id: string; status: string; created_at: string };

/* The fake Polar organisation, changed by tests. */
const polar = {
    refunds: [] as FakeRefund[],
    disputes: [] as FakeDispute[],
    discounts: new Map<string, { id: string; code: string; ends_at: string | null }>(),
    /* Every call HushOS made, in order. */
    calls: [] as string[],
    /* The token has no disputes:read. */
    disputesForbidden: false,
    /* The disputes list fails after this many were read (an outage half-way). */
    disputesFailAfter: null as number | null,
    /* The token has no refunds:read; or Polar is down for refunds. */
    refundsForbidden: false,
    refundsDown: false,
    /* The token is wrong or revoked: every disputes and refunds call answers 401. */
    unauthorized: false,
    /* This page of a refunds list fails (1 is the first), after the pages before it answered. */
    refundPageFails: null as number | null,
    /* Awaited once inside the next refunds list, after Polar has decided its answer. */
    onRefundList: null as (() => Promise<void>) | null,
    /* Polar fixes a used discount's terms: an end date is refused. */
    discountsFixed: false,
};

const missing = () => new PolarClientError(404, { error: 'ResourceNotFound' });

const fakeClient = {
    customers: {
        async getStateExternal() {
            throw missing();
        },
    },
    products: {
        // An organisation with no products.
        async *iterList() {},
    },
    subscriptions: {
        async get() {
            throw missing();
        },
    },
    // Paged as Polar pages it: `limit` to a page, a page that fails after earlier ones answered.
    refunds: {
        async *iterList(query: { order_id?: string; limit?: number }) {
            polar.calls.push(`refunds.list:${query.order_id}`);
            if (polar.unauthorized) throw new PolarClientError(401, { error: 'Unauthorized' });
            if (polar.refundsForbidden) throw new PolarClientError(403, { error: 'NotPermitted' });
            if (polar.refundsDown) throw new PolarClientError(503, { error: 'ServiceUnavailable' });
            // What Polar held when the call was made; the answer may then be slow to arrive.
            const held = polar.refunds
                .filter((refund) => refund.order_id === query.order_id)
                .map((refund) => ({ ...refund }));
            const stall = polar.onRefundList;
            polar.onRefundList = null;
            await stall?.();
            const size = query.limit ?? 10;
            for (let from = 0; from < Math.max(held.length, 1); from += size) {
                const page = from / size + 1;
                if (page > 1) polar.calls.push(`refunds.page:${page}`);
                if (polar.refundPageFails === page)
                    throw new PolarClientError(503, { error: 'ServiceUnavailable' });
                yield* held.slice(from, from + size);
            }
        },
    },
    disputes: {
        // Newest first, as HushOS asks for them.
        async *iterList(query: { sorting?: string[] }) {
            polar.calls.push(`disputes.list:${(query.sorting ?? []).join()}`);
            if (polar.unauthorized) throw new PolarClientError(401, { error: 'Unauthorized' });
            if (polar.disputesForbidden)
                throw new PolarClientError(403, { error: 'InsufficientScopes' });
            const newestFirst = [...polar.disputes].sort(
                (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
            );
            let read = 0;
            for (const dispute of newestFirst) {
                if (polar.disputesFailAfter !== null && read >= polar.disputesFailAfter)
                    throw new PolarClientError(503, { error: 'ServiceUnavailable' });
                read += 1;
                polar.calls.push(`disputes.read:${dispute.id}`);
                yield { ...dispute };
            }
        },
        async get(id: string) {
            polar.calls.push(`disputes.get:${id}`);
            const dispute = polar.disputes.find((candidate) => candidate.id === id);
            if (!dispute) throw missing();
            return { ...dispute };
        },
    },
    discounts: {
        async create(body: { code: string }) {
            polar.calls.push(`discounts.create:${body.code}`);
            const discount = {
                id: `disc_${body.code.toLowerCase()}`,
                code: body.code,
                ends_at: null,
            };
            polar.discounts.set(discount.id, discount);
            return { ...discount };
        },
        async get(id: string) {
            polar.calls.push(`discounts.get:${id}`);
            const discount = polar.discounts.get(id);
            if (!discount) throw missing();
            return { ...discount };
        },
        async update(id: string, body: { ends_at?: string | null }) {
            polar.calls.push(`discounts.update:${id}:${Object.keys(body).join()}`);
            const discount = polar.discounts.get(id);
            if (!discount) throw missing();
            if ('ends_at' in body) {
                if (polar.discountsFixed)
                    throw new PolarClientError(422, { error: 'HTTPValidationError' });
                discount.ends_at = body.ends_at ?? null;
            }
            return { ...discount };
        },
        async delete(id: string) {
            polar.calls.push(`discounts.delete:${id}`);
            polar.discounts.delete(id);
        },
    },
};

vi.mock('@polar-sh/sdk/2026-10', async (importOriginal) => {
    const real = await importOriginal<typeof PolarSdk>();
    return { ...real, createPolar: () => fakeClient };
});
vi.mock('@hushos/emails/server', () => ({
    sendVerificationEmail: async () => {},
    sendFamilyPlanEnding: async () => {},
}));

const { closeDatabase, createTestAccount, resetDatabase } = await import('../../db/test/helpers');
const { db, growthRepository } = await import('@hushos/db');
const { affiliateDisputes, affiliateEarnings, affiliates, referrals } =
    await import('@hushos/db/schema');
const { log } = await import('@hushos/logging');
const billing = await import('./server');
const growth = await import('./growth');

async function signedWebhook(body: object) {
    const payload = JSON.stringify(body);
    const id = `msg_${Math.random().toString(36).slice(2)}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey(
        'raw',
        SECRET_BYTES,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const signature = Buffer.from(
        await crypto.subtle.sign(
            'HMAC',
            key,
            new TextEncoder().encode(`${id}.${timestamp}.${payload}`),
        ),
    ).toString('base64');
    return () =>
        new Request('http://localhost/api/billing/webhook', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'webhook-id': id,
                'webhook-timestamp': timestamp,
                'webhook-signature': `v1,${signature}`,
            },
            body: payload,
        });
}

/* One delivery, answered; `again` sends the very same delivery once more, as Polar's retry does. */
async function deliver(type: string, data: object, options: { again?: boolean } = {}) {
    const request = await signedWebhook({ type, data });
    const response = await billing.handleWebhook(request());
    if (options.again) expect((await billing.handleWebhook(request())).status).toBe(200);
    return response.status;
}

type Order = {
    id: string;
    net?: number;
    refunded?: number;
    discount?: string | null;
    customer?: string | null;
    currency?: string;
};
const paid = (order: Order, options?: { again?: boolean }) =>
    deliver(
        'order.paid',
        {
            id: order.id,
            subscription_id: null,
            created_at: new Date().toISOString(),
            currency: order.currency ?? 'usd',
            net_amount: order.net ?? 10_000,
            refunded_amount: order.refunded ?? 0,
            discount_id: order.discount ?? null,
            customer: order.customer ? { external_id: order.customer } : null,
        },
        options,
    );

function refund(orderId: string, amount: number, status: FakeRefund['status'] = 'succeeded') {
    const made: FakeRefund = {
        id: `refund_${polar.refunds.length + 1}`,
        order_id: orderId,
        amount,
        status,
    };
    polar.refunds.push(made);
    return made;
}

function dispute(orderId: string, status: string, openedAt: Date, id = `dp_${orderId}`) {
    const existing = polar.disputes.find((candidate) => candidate.id === id);
    if (existing) existing.status = status;
    else polar.disputes.push({ id, order_id: orderId, status, created_at: openedAt.toISOString() });
}

const creator = (overrides: Partial<Parameters<typeof growth.createAffiliate>[0]> = {}) =>
    growth.createAffiliate({
        name: 'Creator',
        slug: 'creator',
        code: 'CREATOR20',
        percentOff: 20,
        duration: 'forever',
        commissionBps: 2000,
        ...overrides,
    });

const earning = async (orderId: string) =>
    (await db.select().from(affiliateEarnings)).find((row) => row.orderId === orderId);

/* Raw SQL on the test database, to move a row's dates: time passing, without waiting for it. */
const rawSql = (text: string, values: unknown[] = []) => db.$client.query(text, values);

/*
 * The earning's hold is over: its payable date is `days` earlier. When it was recorded stays,
 * since an earning dated before the switch is one the reach back has to read first.
 */
async function age(orderId: string, days = 31) {
    await rawSql(
        `update affiliate_earnings set payable_at = payable_at - make_interval(days => $2) where order_id = $1`,
        [orderId, days],
    );
}

/* Runs `run` with the logger quiet, and returns what was logged at error level. */
async function errorsOf(run: () => Promise<unknown>) {
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
        await run();
        return error.mock.calls.map(([entry]) => (entry as { message: string }).message);
    } finally {
        error.mockRestore();
        warn.mockRestore();
    }
}

/* An operator marks paid what the Affiliates page shows them now, as the page does it. */
async function markPaid(affiliateId: string) {
    const shown = (await growth.listAffiliates()).find((row) => row.id === affiliateId)!;
    const expected: Record<string, { owed: string; netted: string }> = {};
    for (const [currency, totals] of Object.entries(shown.ledger ?? {}))
        if (BigInt(totals.payable) > 0n)
            expected[currency] = { owed: totals.payable, netted: totals.netted };
    return growth.markAffiliatePaid(affiliateId, { by: OPERATOR, expected });
}

const callsTo = (prefix: string) => polar.calls.filter((call) => call.startsWith(prefix));

beforeEach(async () => {
    await resetDatabase();
    polar.refunds = [];
    polar.disputes = [];
    polar.discounts.clear();
    polar.calls = [];
    polar.disputesForbidden = false;
    polar.disputesFailAfter = null;
    polar.refundsForbidden = false;
    polar.refundsDown = false;
    polar.unauthorized = false;
    polar.refundPageFails = null;
    polar.onRefundList = null;
    polar.discountsFixed = false;
});
afterAll(closeDatabase);

describe('a paid order', () => {
    test('earns its affiliate a commission that is held 30 days, whichever way it is delivered and however often', async () => {
        const affiliate = await creator();
        const customer = await createTestAccount();
        await growthRepository.attributeSignup({ userId: customer.userId, code: 'CREATOR20' });
        const before = Date.now();
        expect(await paid({ id: 'order_1', customer: customer.userId }, { again: true })).toBe(200);
        // A second delivery about the same order, with an id of its own.
        expect(await paid({ id: 'order_1', customer: customer.userId })).toBe(200);
        const rows = await db.select().from(affiliateEarnings);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            affiliateId: affiliate.id,
            userId: customer.userId,
            part: 'main',
            netAmount: 10_000n,
            potAmount: 2_000n,
            commissionAmount: 2_000n,
            flag: null,
        });
        const hold = rows[0]!.payableAt!.getTime() - before;
        expect(hold).toBeGreaterThanOrEqual(30 * DAY);
        expect(hold).toBeLessThan(30 * DAY + 60_000);
        // Held: marking paid today pays nothing, and the page says it is held, not owed.
        expect(await markPaid(affiliate.id)).toEqual({
            paid: 0,
            payouts: {},
        });
        const [listed] = await growth.listAffiliates();
        expect(listed!.ledger).toEqual({
            usd: expect.objectContaining({ held: '2000', payable: '0', payout: '0' }),
        });
        await age('order_1');
        expect(await markPaid(affiliate.id)).toEqual({
            paid: 1,
            payouts: { usd: { owed: '2000', netted: '0', payout: '2000' } },
        });
    });

    test('the delivery and the job that grants kept rewards, in both orders and at once, leave one row', async () => {
        await creator();
        const order = (id: string) => ({
            id,
            net_amount: 10_000,
            currency: 'usd',
            discount_id: 'disc_creator20',
        });
        const customer = await createTestAccount();
        await paid({ id: 'order_a', discount: 'disc_creator20', customer: customer.userId });
        await billing.grantOrderRewards(customer.userId, order('order_a'));
        await billing.grantOrderRewards(customer.userId, order('order_b'));
        await paid({ id: 'order_b', discount: 'disc_creator20', customer: customer.userId });
        await Promise.all([
            paid({ id: 'order_c', discount: 'disc_creator20', customer: customer.userId }),
            billing.grantOrderRewards(customer.userId, order('order_c')),
            billing.grantOrderRewards(customer.userId, order('order_c')),
        ]);
        const rows = await db.select().from(affiliateEarnings);
        const byOrder = [...rows].sort((a, b) => a.orderId.localeCompare(b.orderId));
        expect(byOrder.map((row) => [row.orderId, row.part, row.potAmount])).toEqual([
            ['order_a', 'main', 2_000n],
            ['order_b', 'main', 2_000n],
            ['order_c', 'main', 2_000n],
        ]);
    });

    test('bought by the affiliate’s own account is flagged, not withheld, and paid only once an operator releases it', async () => {
        const account = await createTestAccount();
        const affiliate = await creator();
        await growthRepository.updateAffiliate(affiliate.id, { userId: account.userId });
        await paid({ id: 'order_own', discount: 'disc_creator20', customer: account.userId });
        expect(await earning('order_own')).toMatchObject({
            flag: 'self',
            commissionAmount: 2_000n,
        });
        await age('order_own');
        expect((await markPaid(affiliate.id)).paid).toBe(0);
        const [listed] = await growth.listAffiliateEarnings(affiliate.id);
        expect(listed).toMatchObject({ state: 'flagged', flag: 'self' });
        await growth.releaseAffiliateEarning(affiliate.id, listed!.id, OPERATOR);
        expect((await markPaid(affiliate.id)).paid).toBe(1);
    });

    test('with no affiliate behind it, a net of nothing, or an amount that is not a whole number, records nothing', async () => {
        await creator();
        const stranger = await createTestAccount();
        await paid({ id: 'order_nobody', customer: stranger.userId });
        await paid({ id: 'order_free', discount: 'disc_creator20', net: 0 });
        await paid({ id: 'order_fraction', discount: 'disc_creator20', net: 10.5 });
        expect(await db.select().from(affiliateEarnings)).toEqual([]);
    });
});

describe('a refund made in Polar', () => {
    test('lowers an unpaid earning by what the order’s refunds list says, never by the delivery’s own figure', async () => {
        await creator();
        await paid({ id: 'order_1', discount: 'disc_creator20' });
        refund('order_1', 2_500);
        refund('order_1', 4_000, 'pending');
        // The delivery claims the whole order: only the list is believed, and only what succeeded.
        expect(
            await deliver(
                'refund.created',
                { id: 'refund_x', order_id: 'order_1', amount: 10_000, status: 'succeeded' },
                { again: true },
            ),
        ).toBe(200);
        expect(await earning('order_1')).toMatchObject({
            potAmount: 2_000n,
            commissionAmount: 1_500n,
            refundedAmount: 2_500n,
        });
        // A second delivery about the same refund: half of the pot stays half, never a quarter.
        await deliver('refund.updated', {
            id: 'refund_1',
            order_id: 'order_1',
            status: 'succeeded',
        });
        await deliver('order.refunded', { id: 'order_1', refunded_amount: 2_500 });
        expect((await earning('order_1'))!.commissionAmount).toBe(1_500n);
        // The pending one lands: the rest of what was refunded comes off the pot.
        polar.refunds[1]!.status = 'succeeded';
        await deliver('refund.updated', {
            id: 'refund_2',
            order_id: 'order_1',
            status: 'succeeded',
        });
        expect((await earning('order_1'))!.commissionAmount).toBe(700n);
        // Refunded whole, past the net: nothing, and never below it.
        refund('order_1', 9_000);
        await deliver('order.refunded', { id: 'order_1' });
        expect(await earning('order_1')).toMatchObject({
            commissionAmount: 0n,
            refundedAmount: 10_000n,
        });
    });

    test('that later fails raises the earning again', async () => {
        await creator();
        await paid({ id: 'order_1', discount: 'disc_creator20' });
        const made = refund('order_1', 10_000);
        await deliver('refund.created', { id: made.id, order_id: 'order_1' });
        expect((await earning('order_1'))!.commissionAmount).toBe(0n);
        made.status = 'failed';
        await deliver('refund.updated', { id: made.id, order_id: 'order_1', status: 'failed' });
        expect((await earning('order_1'))!.commissionAmount).toBe(2_000n);
    });

    test('marks a paid earning with what is to be taken back, and the next payout takes it by amount', async () => {
        const affiliate = await creator();
        await paid({ id: 'order_big', discount: 'disc_creator20', net: 384_000 });
        await age('order_big');
        await markPaid(affiliate.id);
        refund('order_big', 384_000);
        await deliver('order.refunded', { id: 'order_big' });
        expect(await earning('order_big')).toMatchObject({
            paidAmount: 76_800n,
            clawbackAmount: 76_800n,
            clawbackOrigin: null,
        });
        await paid({ id: 'order_small', discount: 'disc_creator20', net: 25_000 });
        await age('order_small');
        const [shown] = await growth.listAffiliates();
        expect(shown!.ledger!.usd).toMatchObject({
            payable: '5000',
            clawbackOpen: '76800',
            netted: '5000',
            payout: '0',
        });
        expect(await markPaid(affiliate.id)).toEqual({
            paid: 1,
            payouts: { usd: { owed: '5000', netted: '5000', payout: '0' } },
        });
        const [after] = await growth.listAffiliates();
        expect(after!.ledger!.usd).toMatchObject({ payable: '0', clawbackOpen: '71800' });
    });

    test('seen before the earning: an order already refunded in part when it is recorded starts lowered', async () => {
        await creator();
        refund('order_1', 5_000);
        // The refund's own delivery finds no earning, and asks Polar nothing.
        await deliver('refund.created', { id: 'refund_1', order_id: 'order_1' });
        expect(callsTo('refunds.list')).toEqual([]);
        // The order as the job that grants kept rewards reads it: fresh, with its refunds counted.
        await billing.grantOrderRewards((await createTestAccount()).userId, {
            id: 'order_1',
            net_amount: 10_000,
            refunded_amount: 5_000,
            currency: 'usd',
            discount_id: 'disc_creator20',
        });
        expect(await earning('order_1')).toMatchObject({
            potAmount: 2_000n,
            commissionAmount: 1_000n,
        });
    });

    test('seen before the earning by a delivery that was delayed: the earning cannot be paid before the daily read has lowered it', async () => {
        const affiliate = await creator();
        refund('order_1', 10_000);
        await deliver('order.refunded', { id: 'order_1' });
        // `order.paid` arrives late, as Polar made it: it knows of no refund.
        await paid({ id: 'order_1', discount: 'disc_creator20' });
        expect((await earning('order_1'))!.commissionAmount).toBe(2_000n);
        expect((await markPaid(affiliate.id)).paid).toBe(0);
        expect(await billing.reconcileAffiliateEarnings()).toMatchObject({
            refundsRead: 1,
            refundsFailed: 0,
        });
        expect((await earning('order_1'))!.commissionAmount).toBe(0n);
    });

    test('listed over more than one page is added up over every page, and a page that fails is a read that failed, never fewer refunds', async () => {
        await creator();
        await paid({ id: 'order_1', discount: 'disc_creator20' });
        // 150 refunds of 0.50: 75.00 of 100.00, a page and a half of Polar's list.
        for (let count = 0; count < 150; count += 1) refund('order_1', 50);
        polar.calls = [];
        polar.refundPageFails = 2;
        const request = await signedWebhook({
            type: 'refund.created',
            data: { id: 'refund_150', order_id: 'order_1' },
        });
        // The first page alone says 50.00 was refunded. It is not believed.
        await expect(billing.handleWebhook(request())).rejects.toMatchObject({ status: 503 });
        expect(await earning('order_1')).toMatchObject({
            commissionAmount: 2_000n,
            refundedAmount: 0n,
            refundsReadAt: null,
        });
        await errorsOf(async () => {
            expect(await billing.reconcileAffiliateEarnings()).toMatchObject({
                refundsRead: 0,
                refundsFailed: 1,
            });
        });
        expect((await earning('order_1'))!.commissionAmount).toBe(2_000n);
        expect((await growth.affiliateLedgerStatus()) as object).toMatchObject({
            refunds: { readAt: null },
        });
        polar.refundPageFails = null;
        polar.calls = [];
        expect((await billing.handleWebhook(request())).status).toBe(200);
        expect(polar.calls).toEqual(['refunds.list:order_1', 'refunds.page:2']);
        expect(await earning('order_1')).toMatchObject({
            commissionAmount: 500n,
            refundedAmount: 7_500n,
        });
    });

    test('read twice at once: the answer Polar gave first and delivered last does not undo the newer one', async () => {
        await creator();
        await paid({ id: 'order_1', discount: 'disc_creator20' });
        // The first read reaches Polar before the refund exists, and its answer is slow.
        let release!: () => void;
        const stalled = new Promise<void>((resolve) => (release = resolve));
        let reached!: () => void;
        const atPolar = new Promise<void>((resolve) => (reached = resolve));
        polar.onRefundList = async () => {
            reached();
            await stalled;
        };
        const slow = deliver('refund.updated', { id: 'r0', order_id: 'order_1' });
        await atPolar;
        // Meanwhile the order is refunded whole, and that delivery is read and applied.
        refund('order_1', 10_000);
        expect(await deliver('refund.created', { id: 'refund_1', order_id: 'order_1' })).toBe(200);
        expect((await earning('order_1'))!.commissionAmount).toBe(0n);
        const newer = (await earning('order_1'))!.refundsReadAt!;
        release();
        expect(await slow).toBe(200);
        expect(await earning('order_1')).toMatchObject({
            commissionAmount: 0n,
            refundedAmount: 10_000n,
            refundsReadAt: newer,
        });
    });

    test('for an order with no earning asks Polar nothing, and one Polar can’t answer for is delivered again', async () => {
        await creator();
        polar.calls = [];
        expect(await deliver('refund.created', { id: 'r', order_id: 'order_unknown' })).toBe(200);
        expect(await deliver('order.refunded', { id: 'order_unknown' })).toBe(200);
        expect(await deliver('refund.created', { id: 'r' })).toBe(200);
        expect(polar.calls).toEqual([]);
        await paid({ id: 'order_1', discount: 'disc_creator20' });
        refund('order_1', 5_000);
        polar.refundsDown = true;
        // The delivery fails (the route answers 503), so Polar sends it again; nothing was
        // lowered on a guess, and the same delivery sent again is not taken for a replay.
        const request = await signedWebhook({
            type: 'refund.created',
            data: { id: 'refund_1', order_id: 'order_1' },
        });
        await expect(billing.handleWebhook(request())).rejects.toMatchObject({ status: 503 });
        expect((await earning('order_1'))!.commissionAmount).toBe(2_000n);
        polar.refundsDown = false;
        expect((await billing.handleWebhook(request())).status).toBe(200);
        expect((await earning('order_1'))!.commissionAmount).toBe(1_000n);
        polar.refunds = [];
        polar.refundsForbidden = true;
        // A token that may not read refunds: said loudly, and the delivery is not sent for ever.
        const said = await errorsOf(async () => {
            expect(await deliver('refund.created', { id: 'refund_1', order_id: 'order_1' })).toBe(
                200,
            );
        });
        expect(said.join(' ')).toContain('refunds:read');
    });
});

describe('the daily read of Polar’s disputes', () => {
    const NOW = new Date();
    const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

    test('an open dispute keeps an earning from being paid; lost takes all of an unpaid one; won clears it and leaves the amount', async () => {
        const affiliate = await creator();
        for (const id of ['order_open', 'order_lost', 'order_won'])
            await paid({ id, discount: 'disc_creator20' });
        // Opened days ago, and first seen now: still found.
        dispute('order_open', 'needs_response', ago(9));
        dispute('order_lost', 'lost', ago(20));
        dispute('order_won', 'under_review', ago(3));
        expect(await billing.reconcileAffiliateEarnings(NOW)).toMatchObject({
            disputesRead: true,
            disputes: 3,
        });
        expect(await earning('order_open')).toMatchObject({
            disputeId: 'dp_order_open',
            disputeStatus: 'needs_response',
            disputedAt: ago(9),
            commissionAmount: 2_000n,
        });
        expect(await earning('order_lost')).toMatchObject({
            potAmount: 2_000n,
            commissionAmount: 0n,
        });
        for (const id of ['order_open', 'order_lost', 'order_won']) await age(id);
        expect((await markPaid(affiliate.id)).paid).toBe(0);
        dispute('order_won', 'won', ago(3));
        await billing.reconcileAffiliateEarnings(new Date(NOW.getTime() + DAY));
        expect(await markPaid(affiliate.id)).toEqual({
            paid: 1,
            payouts: { usd: { owed: '2000', netted: '0', payout: '2000' } },
        });
        expect((await earning('order_won'))!.paidAt).not.toBeNull();
        expect((await earning('order_open'))!.paidAt).toBeNull();
    });

    test('a paid earning whose dispute is lost gains a clawback of all of it, and keeps it through the refund read that finds no refund', async () => {
        const affiliate = await creator();
        await paid({ id: 'order_1', discount: 'disc_creator20', net: 384_000 });
        await age('order_1');
        await markPaid(affiliate.id);
        dispute('order_1', 'lost', ago(1));
        await billing.reconcileAffiliateEarnings(NOW);
        // The next mornings: disputes read again, and the order's refunds, which list nothing.
        await deliver('order.refunded', { id: 'order_1' });
        await billing.reconcileAffiliateEarnings(new Date(NOW.getTime() + DAY));
        expect(await earning('order_1')).toMatchObject({
            paidAmount: 76_800n,
            commissionAmount: 0n,
            clawbackAmount: 76_800n,
            clawbackOrigin: null,
        });
    });

    test('a prevented dispute has its order’s refunds read in the same run and takes nothing beyond the refund', async () => {
        await creator();
        await paid({ id: 'order_1', discount: 'disc_creator20' });
        const affiliate = (await db.select().from(affiliates))[0]!;
        await age('order_1');
        await markPaid(affiliate.id);
        // Polar refunded half before the dispute escalated. No delivery told HushOS.
        refund('order_1', 5_000);
        dispute('order_1', 'prevented', ago(1));
        polar.calls = [];
        await billing.reconcileAffiliateEarnings(NOW);
        expect(callsTo('refunds.list')).toEqual(['refunds.list:order_1']);
        expect(await earning('order_1')).toMatchObject({
            disputeStatus: 'prevented',
            commissionAmount: 1_000n,
            clawbackAmount: 1_000n,
        });
    });

    test('a dispute read before its earning exists still reaches it: by the delivery, and by the job that grants kept rewards', async () => {
        const affiliate = await creator();
        dispute('order_open', 'under_review', ago(2));
        dispute('order_lost', 'lost', ago(2));
        dispute('order_prevented', 'prevented', ago(2));
        refund('order_prevented', 2_500);
        await billing.reconcileAffiliateEarnings(NOW);
        expect(await db.select().from(affiliateDisputes)).toHaveLength(3);
        expect(await db.select().from(affiliateEarnings)).toEqual([]);
        await paid({ id: 'order_open', discount: 'disc_creator20' });
        await billing.grantOrderRewards((await createTestAccount()).userId, {
            id: 'order_lost',
            net_amount: 10_000,
            currency: 'usd',
            discount_id: 'disc_creator20',
        });
        // The delivery knows of no refund; the prevented dispute says to read them first.
        await paid({ id: 'order_prevented', discount: 'disc_creator20' });
        expect(await earning('order_open')).toMatchObject({
            disputeStatus: 'under_review',
            commissionAmount: 2_000n,
        });
        expect(await earning('order_lost')).toMatchObject({
            disputeStatus: 'lost',
            potAmount: 2_000n,
            commissionAmount: 0n,
        });
        expect(await earning('order_prevented')).toMatchObject({
            disputeStatus: 'prevented',
            commissionAmount: 1_500n,
        });
        for (const id of ['order_open', 'order_lost', 'order_prevented']) await age(id);
        // Only what the refund left of the prevented one can be paid.
        expect(await markPaid(affiliate.id)).toMatchObject({
            paid: 1,
            payouts: { usd: { payout: '1500' } },
        });
    });

    test('reads down to the newest dispute it has seen, and again every one it holds as open, however old', async () => {
        await creator();
        await paid({ id: 'order_old', discount: 'disc_creator20' });
        dispute('order_old', 'needs_response', ago(40));
        dispute('order_other', 'won', ago(30));
        await billing.reconcileAffiliateEarnings(NOW);
        // The old one closes at Polar, with nothing new above it; a new one is opened elsewhere.
        dispute('order_old', 'lost', ago(40));
        dispute('order_new', 'early_warning', ago(1));
        polar.calls = [];
        await billing.reconcileAffiliateEarnings(new Date(NOW.getTime() + DAY));
        // The list is read from the top to the newest seen (the 30-day-old one, read again and
        // stopped at); the 40-day-old one is below it and is fetched by its id because it was open.
        expect(callsTo('disputes.')).toEqual([
            'disputes.list:-created_at',
            'disputes.read:dp_order_new',
            'disputes.read:dp_order_other',
            'disputes.read:dp_order_old',
            'disputes.get:dp_order_old',
        ]);
        expect(await earning('order_old')).toMatchObject({
            disputeStatus: 'lost',
            commissionAmount: 0n,
        });
        // The same read again the next day: nothing changes, the closed one is not asked for
        // again, and the list is read no further down than the newest one seen.
        const before = await earning('order_old');
        polar.calls = [];
        await billing.reconcileAffiliateEarnings(new Date(NOW.getTime() + 2 * DAY));
        expect(callsTo('disputes.')).toEqual([
            'disputes.list:-created_at',
            'disputes.read:dp_order_new',
            'disputes.read:dp_order_other',
        ]);
        expect(await earning('order_old')).toEqual({
            ...before,
            refundsReadAt: expect.any(Date),
        });
        expect(await db.select().from(affiliateDisputes)).toHaveLength(3);
    });

    test('with the scope missing the run says so loudly and on the operators’ page, and refunds are still handled', async () => {
        const affiliate = await creator();
        await paid({ id: 'order_1', discount: 'disc_creator20' });
        dispute('order_1', 'lost', ago(1));
        refund('order_1', 5_000);
        polar.disputesForbidden = true;
        let outcome: Awaited<ReturnType<typeof billing.reconcileAffiliateEarnings>> = null;
        const said = await errorsOf(async () => {
            outcome = await billing.reconcileAffiliateEarnings(NOW);
        });
        expect(said).toEqual([
            'Disputes can’t be read: the Polar token has no disputes:read scope. Commission on a charged-back order is not taken back until it has',
        ]);
        expect(outcome).toEqual({
            disputesRead: false,
            disputesFailure: 'scope',
            disputes: 0,
            refundsRead: 1,
            refundsFailed: 0,
            stopped: false,
        });
        expect(await growth.affiliateLedgerStatus()).toMatchObject({
            enabled: true,
            holdDays: 30,
            disputes: { readAt: null, failure: 'scope' },
        });
        // The refund was read all the same; the dispute, unseen, took nothing.
        expect((await earning('order_1'))!.commissionAmount).toBe(1_000n);
        // The token is fixed: the next run reads the dispute it missed, and the page is clear again.
        polar.disputesForbidden = false;
        await billing.reconcileAffiliateEarnings(new Date(NOW.getTime() + DAY));
        expect((await earning('order_1'))!.commissionAmount).toBe(0n);
        expect(await growth.affiliateLedgerStatus()).toMatchObject({
            disputes: { failure: null, readAt: expect.any(String) },
        });
        expect((await markPaid(affiliate.id)).paid).toBe(0);
    });

    test('a token that is wrong or revoked is a failure, not a missing scope, and the page says which', async () => {
        await creator();
        await paid({ id: 'order_1', discount: 'disc_creator20' });
        polar.unauthorized = true;
        let outcome: Awaited<ReturnType<typeof billing.reconcileAffiliateEarnings>> = null;
        const said = await errorsOf(async () => {
            outcome = await billing.reconcileAffiliateEarnings(NOW);
        });
        expect(said).toEqual([
            'Polar’s disputes could not be read; the next daily run reads them again',
        ]);
        expect(outcome).toMatchObject({
            disputesRead: false,
            disputesFailure: 'failed',
            refundsFailed: 1,
        });
        expect(await growth.affiliateLedgerStatus()).toMatchObject({
            disputes: { readAt: null, failure: 'failed' },
            refunds: { readAt: null },
        });
        // A refund's delivery with such a token is refused, so Polar sends it again: it is
        // not waved through as a missing scope would be.
        const request = await signedWebhook({
            type: 'refund.created',
            data: { id: 'r', order_id: 'order_1' },
        });
        await expect(billing.handleWebhook(request())).rejects.toMatchObject({ status: 503 });
        polar.unauthorized = false;
        await billing.reconcileAffiliateEarnings(new Date(NOW.getTime() + DAY));
        const status = await growth.affiliateLedgerStatus();
        expect(status).toMatchObject({
            enabled: true,
            recordKeepDays: 120,
            disputes: { failure: null, readAt: expect.any(String) },
            refunds: { readAt: expect.any(String) },
        });
        // `since` is when the switch first ran here: before any read.
        if (!status.enabled) throw new Error('unreachable');
        expect(Date.parse(status.since)).toBeLessThanOrEqual(Date.parse(status.disputes.readAt!));
    });

    test('one prevented dispute whose refunds can’t be read does not stop the others, and is met again the next day', async () => {
        const affiliate = await creator();
        for (const id of ['order_prevented', 'order_lost'])
            await paid({ id, discount: 'disc_creator20' });
        // The daily runs of their 30 days read both, as they do before anything is paid.
        await billing.reconcileAffiliateEarnings(ago(1));
        for (const id of ['order_prevented', 'order_lost']) await age(id);
        await markPaid(affiliate.id);
        refund('order_prevented', 10_000);
        dispute('order_prevented', 'prevented', ago(2));
        // Older than the prevented one: read after it, so it shows the read went on.
        dispute('order_lost', 'lost', ago(6));
        polar.refundPageFails = 1;
        let outcome: Awaited<ReturnType<typeof billing.reconcileAffiliateEarnings>> = null;
        await errorsOf(async () => {
            outcome = await billing.reconcileAffiliateEarnings(NOW);
        });
        expect(outcome).toMatchObject({ disputesRead: true, disputes: 2, refundsFailed: 1 });
        expect((await earning('order_lost'))!.clawbackAmount).toBe(2_000n);
        expect(await earning('order_prevented')).toMatchObject({
            disputeStatus: 'prevented',
            clawbackAmount: 0n,
        });
        // The marker did not move past what was not finished: the whole list is read again,
        // and this time the refund is found. A paid earning, so nothing else would have read it.
        polar.refundPageFails = null;
        polar.calls = [];
        await billing.reconcileAffiliateEarnings(new Date(NOW.getTime() + DAY));
        expect(callsTo('disputes.read')).toEqual([
            'disputes.read:dp_order_prevented',
            'disputes.read:dp_order_lost',
        ]);
        expect((await earning('order_prevented'))!.clawbackAmount).toBe(2_000n);
    });

    test('a dispute that appears in the list below the newest one already seen is found within three days of it, and not below that', async () => {
        await creator();
        for (const id of ['order_late', 'order_too_late'])
            await paid({ id, discount: 'disc_creator20' });
        dispute('order_seen', 'won', ago(1));
        await billing.reconcileAffiliateEarnings(NOW);
        // Committed at Polar after that read, with an earlier time of its own.
        dispute('order_late', 'lost', ago(3.5));
        dispute('order_too_late', 'lost', ago(4.5));
        polar.calls = [];
        await billing.reconcileAffiliateEarnings(new Date(NOW.getTime() + DAY));
        expect(callsTo('disputes.read')).toEqual([
            'disputes.read:dp_order_seen',
            'disputes.read:dp_order_late',
            'disputes.read:dp_order_too_late',
        ]);
        expect((await earning('order_late'))!.commissionAmount).toBe(0n);
        // More than three days below the marker: read to (the list stops there), not taken.
        expect((await earning('order_too_late'))!.commissionAmount).toBe(2_000n);
        expect(await db.select().from(affiliateDisputes)).toHaveLength(2);
    });

    test('a run that is being stopped starts nothing more, and says it stopped short', async () => {
        await creator();
        await paid({ id: 'order_1', discount: 'disc_creator20' });
        refund('order_1', 10_000);
        dispute('order_elsewhere', 'lost', ago(1));
        const stopping = new AbortController();
        stopping.abort();
        polar.calls = [];
        expect(
            await billing.reconcileAffiliateEarnings(NOW, { signal: stopping.signal }),
        ).toMatchObject({ stopped: true, refundsRead: 0, disputes: 0 });
        expect(callsTo('refunds.')).toEqual([]);
        expect((await earning('order_1'))!.commissionAmount).toBe(2_000n);
        // Nothing is recorded as read, and the reach back is not called done.
        expect(await growth.affiliateLedgerStatus()).toMatchObject({
            disputes: { readAt: null, failure: null },
            refunds: { readAt: null },
        });
        expect((await growthRepository.getLedgerState())!.reachBackDoneAt).toBeNull();
        expect(await billing.reconcileAffiliateEarnings(NOW)).toMatchObject({
            stopped: false,
            disputes: 1,
            refundsRead: 1,
        });
        expect((await earning('order_1'))!.commissionAmount).toBe(0n);
    });

    test('the daily job fails, to be run again, when disputes or refunds could not be read, and does not for a missing disputes scope', async () => {
        const { reconcileBilling } = await import('../../jobs/src/jobs/reconcile-billing');
        const daily = (signal?: AbortSignal) =>
            reconcileBilling({ id: 'daily', name: 'billing.reconcile', data: {}, signal } as never);
        await creator();
        await paid({ id: 'order_1', discount: 'disc_creator20' });
        refund('order_1', 5_000);
        // A missing scope would fail every retry the same way: said, and the job is done.
        polar.disputesForbidden = true;
        await errorsOf(daily);
        expect((await earning('order_1'))!.commissionAmount).toBe(1_000n);
        // Polar down for disputes, or for refunds: the job fails so that it is run again.
        polar.disputesForbidden = false;
        polar.disputesFailAfter = 0;
        dispute('order_x', 'won', ago(1));
        await errorsOf(async () => {
            await expect(daily()).rejects.toThrow('Some customers could not be reconciled.');
        });
        polar.disputesFailAfter = null;
        polar.refundsDown = true;
        await errorsOf(async () => {
            await expect(daily()).rejects.toThrow('Some customers could not be reconciled.');
        });
        polar.refundsDown = false;
        // Stopped by the worker: it starts no read, and that is not a failure.
        const stopping = new AbortController();
        stopping.abort();
        polar.refunds = [];
        polar.calls = [];
        await daily(stopping.signal);
        expect(callsTo('refunds.')).toEqual([]);
        expect((await earning('order_1'))!.commissionAmount).toBe(1_000n);
        await daily();
        expect((await earning('order_1'))!.commissionAmount).toBe(2_000n);
    });

    test('a read that fails half-way does not move the marker: the disputes below it are read the next day', async () => {
        await creator();
        await paid({ id: 'order_below', discount: 'disc_creator20' });
        dispute('order_above', 'won', ago(1));
        dispute('order_below', 'lost', ago(5));
        polar.disputesFailAfter = 1;
        await errorsOf(() => billing.reconcileAffiliateEarnings(NOW));
        expect((await earning('order_below'))!.commissionAmount).toBe(2_000n);
        expect(await growth.affiliateLedgerStatus()).toMatchObject({
            disputes: { failure: 'failed' },
        });
        polar.disputesFailAfter = null;
        await billing.reconcileAffiliateEarnings(new Date(NOW.getTime() + DAY));
        expect((await earning('order_below'))!.commissionAmount).toBe(0n);
    });
});

describe('pausing', () => {
    /* A customer who signed up through the creator, `daysAgo` days ago. */
    async function customerFrom(daysAgo: number) {
        const customer = await createTestAccount();
        await growthRepository.attributeSignup({ userId: customer.userId, code: 'CREATOR20' });
        await rawSql(
            `update referrals set created_at = now() - make_interval(days => $2) where referred_user_id = $1`,
            [customer.userId, daysAgo],
        );
        return customer.userId;
    }

    test('a customer attributed before the pause still earns; a stale code typed at Polar’s checkout ties nobody new', async () => {
        const affiliate = await creator();
        const before = await customerFrom(10);
        const usedCode = (await createTestAccount()).userId;
        await paid({ id: 'order_code_before', discount: 'disc_creator20', customer: usedCode });
        await rawSql(
            `update affiliate_earnings set created_at = now() - interval '5 days' where order_id = 'order_code_before'`,
        );
        const paused = await growth.updateAffiliate(affiliate.id, { active: false });
        expect(paused).toMatchObject({ active: false, pausedAt: expect.any(String) });
        expect(paused.discountNotice).toBeUndefined();
        // Polar was asked to end the discount, and never to delete it.
        expect(callsTo('discounts.update')).toEqual(['discounts.update:disc_creator20:ends_at']);
        expect(callsTo('discounts.delete')).toEqual([]);
        expect(polar.discounts.get('disc_creator20')!.ends_at).not.toBeNull();
        // Someone new types the code at Polar, where it still got through.
        const stranger = (await createTestAccount()).userId;
        await paid({ id: 'order_new_code', discount: 'disc_creator20', customer: stranger });
        await paid({ id: 'order_new_code_nobody', discount: 'disc_creator20' });
        // The two brought before the pause renew: by their sign-up, and by their earlier order.
        await paid({ id: 'order_renewal', customer: before });
        await paid({ id: 'order_code_renewal', discount: 'disc_creator20', customer: usedCode });
        const earned = (await db.select().from(affiliateEarnings)).map((row) => row.orderId);
        expect(earned.sort()).toEqual(['order_code_before', 'order_code_renewal', 'order_renewal']);
        // No page and no code while paused, as before.
        expect(await growth.getOfferLanding('creator', '192.0.2.1')).toBeNull();
        // Pausing them again does not move the line.
        const again = await growth.updateAffiliate(affiliate.id, { active: false });
        expect(again.pausedAt).toBe(paused.pausedAt);
    });

    test('a customer attributed after the pause began earns nothing, and resuming brings everyone back', async () => {
        const affiliate = await creator();
        const late = await customerFrom(0);
        await growth.updateAffiliate(affiliate.id, { active: false });
        // The pause is dated before the sign-up: that customer was not brought before it.
        await rawSql(`update affiliates set paused_at = now() - interval '1 day' where id = $1`, [
            affiliate.id,
        ]);
        await paid({ id: 'order_during', customer: late });
        expect(await db.select().from(affiliateEarnings)).toEqual([]);
        const resumed = await growth.updateAffiliate(affiliate.id, { active: true });
        expect(resumed).toMatchObject({ active: true, pausedAt: null });
        expect(polar.discounts.get('disc_creator20')!.ends_at).toBeNull();
        await paid({ id: 'order_after', customer: late });
        expect((await earning('order_after'))!.commissionAmount).toBe(2_000n);
    });

    test('when Polar refuses to end the discount it is left as it is, never deleted, and the pause still stands', async () => {
        const affiliate = await creator();
        polar.discountsFixed = true;
        let paused: Awaited<ReturnType<typeof growth.updateAffiliate>> | undefined;
        await errorsOf(async () => {
            paused = await growth.updateAffiliate(affiliate.id, { active: false });
        });
        expect(paused).toMatchObject({ active: false, discountNotice: 'still-live' });
        expect(polar.discounts.get('disc_creator20')).toMatchObject({ ends_at: null });
        expect(callsTo('discounts.delete')).toEqual([]);
        // The code still applies at Polar, and earns them nothing.
        await paid({
            id: 'order_stale',
            discount: 'disc_creator20',
            customer: (await createTestAccount()).userId,
        });
        expect(await db.select().from(affiliateEarnings)).toEqual([]);
        // Resuming finds nothing to reopen and says nothing.
        const resumed = await growth.updateAffiliate(affiliate.id, { active: true });
        expect(resumed.discountNotice).toBeUndefined();
    });
});

describe('removing', () => {
    test('keeps the row and its ledger, with its dispute records and settled clawbacks, and nothing earns afterwards', async () => {
        const affiliate = await creator({ notes: 'Paid by bank transfer' });
        const customer = await createTestAccount();
        await growthRepository.attributeSignup({ userId: customer.userId, code: 'CREATOR20' });
        await paid({ id: 'order_1', customer: customer.userId });
        await age('order_1');
        await markPaid(affiliate.id);
        dispute('order_1', 'lost', new Date(Date.now() - DAY));
        await billing.reconcileAffiliateEarnings();
        const [owing] = await growth.listAffiliateEarnings(affiliate.id);
        // A clawback not settled: they cannot be removed past it.
        await expect(growth.deleteAffiliate(affiliate.id)).rejects.toMatchObject({ status: 409 });
        expect((await db.select().from(affiliates))[0]!.removedAt).toBeNull();
        await growth.settleAffiliateClawback(affiliate.id, owing!.id, {
            kind: 'repaid',
            amount: '2000',
            by: OPERATOR,
        });
        polar.calls = [];
        expect(await growth.deleteAffiliate(affiliate.id)).toEqual({ deleted: true });
        const [kept] = await db.select().from(affiliates);
        expect(kept).toMatchObject({
            active: false,
            removedAt: expect.any(Date),
            notes: 'Paid by bank transfer',
        });
        // The discount is ended as a pause ends it, and not deleted.
        expect(callsTo('discounts.')).toEqual(['discounts.update:disc_creator20:ends_at']);
        expect(await db.select().from(affiliateEarnings)).toEqual([
            expect.objectContaining({
                orderId: 'order_1',
                disputeStatus: 'lost',
                clawbackAmount: 2_000n,
                clawbackSettledAmount: 2_000n,
                clawbackSettledBy: OPERATOR,
            }),
        ]);
        expect(await db.select().from(affiliateDisputes)).toHaveLength(1);
        expect(await db.select().from(referrals)).toHaveLength(1);
        // Removed: the customer they brought renews and nothing is recorded; no page; no changes.
        await paid({ id: 'order_2', customer: customer.userId });
        await paid({ id: 'order_3', discount: 'disc_creator20', customer: customer.userId });
        expect(await db.select().from(affiliateEarnings)).toHaveLength(1);
        expect(await growth.getOfferLanding('creator', '192.0.2.1')).toBeNull();
        await expect(growth.updateAffiliate(affiliate.id, { active: true })).rejects.toMatchObject({
            status: 409,
        });
        await expect(growth.deleteAffiliate(affiliate.id)).rejects.toMatchObject({ status: 409 });
        // Still listed for operators, as removed, with what was paid.
        const [listed] = await growth.listAffiliates();
        expect(listed).toMatchObject({ removedAt: expect.any(String) });
        expect(listed!.ledger!.usd).toMatchObject({ paidOut: '2000', clawbackOpen: '0' });
    });

    test('is refused while anything is held or flagged, and a voided earning no longer blocks it', async () => {
        const affiliate = await creator();
        await paid({ id: 'order_held', discount: 'disc_creator20' });
        await expect(growth.deleteAffiliate(affiliate.id)).rejects.toThrow(
            'This affiliate still has commission that is owed, held or flagged, or a clawback that is not settled.',
        );
        const [held] = await growth.listAffiliateEarnings(affiliate.id);
        await expect(
            growth.voidAffiliateEarning(affiliate.id, held!.id, { by: OPERATOR, reason: '   ' }),
        ).rejects.toMatchObject({ status: 400 });
        await growth.voidAffiliateEarning(affiliate.id, held!.id, {
            by: OPERATOR,
            reason: 'Tested their own checkout with a stolen card',
        });
        expect(await growth.deleteAffiliate(affiliate.id)).toEqual({ deleted: true });
    });

    test('the record itself is deleted only after removal, and only with nothing open on its ledger', async () => {
        const affiliate = await creator();
        await paid({ id: 'order_1', discount: 'disc_creator20' });
        await expect(growth.deleteAffiliateRecord(affiliate.id)).rejects.toMatchObject({
            status: 409,
        });
        await age('order_1');
        await markPaid(affiliate.id);
        await growth.deleteAffiliate(affiliate.id);
        // A refund lands on the removed affiliate's paid order: a clawback keeps the record.
        refund('order_1', 10_000);
        await deliver('order.refunded', { id: 'order_1' });
        await expect(growth.deleteAffiliateRecord(affiliate.id)).rejects.toMatchObject({
            status: 409,
        });
        const [owing] = await growth.listAffiliateEarnings(affiliate.id);
        await expect(
            growth.settleAffiliateClawback(affiliate.id, owing!.id, {
                kind: 'written-off',
                note: '  ',
                by: OPERATOR,
            }),
        ).rejects.toMatchObject({ status: 400 });
        await growth.settleAffiliateClawback(affiliate.id, owing!.id, {
            kind: 'written-off',
            note: 'Account closed',
            by: OPERATOR,
        });
        polar.calls = [];
        // Settled, but paid moments ago: a refund or a lost dispute must still find the row.
        const [listed] = await growth.listAffiliates();
        const keptUntil = new Date(listed!.recordKeptUntil!);
        expect(keptUntil.getTime() - Date.now()).toBeGreaterThan(119 * DAY);
        expect(keptUntil.getTime() - Date.now()).toBeLessThanOrEqual(120 * DAY);
        await expect(growth.deleteAffiliateRecord(affiliate.id)).rejects.toMatchObject({
            status: 409,
            message: expect.stringContaining(
                `Their record can be deleted from ${keptUntil.toISOString().slice(0, 10)}`,
            ),
        });
        expect(await db.select().from(affiliateEarnings)).toHaveLength(1);
        // 119 days after the payout it still stays; past the 120th it may go.
        await rawSql(`update affiliate_earnings set paid_at = paid_at - interval '119 days'`);
        await expect(growth.deleteAffiliateRecord(affiliate.id)).rejects.toMatchObject({
            status: 409,
        });
        await rawSql(`update affiliate_earnings set paid_at = paid_at - interval '1 day 1 minute'`);
        expect((await growth.listAffiliates())[0]!.recordKeptUntil).toBeNull();
        expect(await growth.deleteAffiliateRecord(affiliate.id)).toEqual({ deleted: true });
        expect(await db.select().from(affiliates)).toEqual([]);
        expect(await db.select().from(affiliateEarnings)).toEqual([]);
        expect(callsTo('discounts.delete')).toEqual([]);
    });
});

describe('the cut-over, through the daily run', () => {
    /* An earning as the code before the switch left it. */
    async function legacy(
        affiliateId: string,
        orderId: string,
        recordedDaysAgo: number,
        paidDaysAgo?: number,
    ) {
        await growthRepository.recordEarning({
            affiliateId,
            orderId,
            userId: null,
            currency: 'usd',
            netAmount: 10_000,
            commissionBps: 2000,
        });
        await rawSql(
            `update affiliate_earnings
             set created_at = now() - make_interval(days => $2),
                 paid_at = case when $3::int is null then null else now() - make_interval(days => $3::int) end
             where order_id = $1`,
            [orderId, recordedDaysAgo, paidDaysAgo ?? null],
        );
    }

    test('the first run lowers an unpaid old earning whose order was refunded in Polar, gives one paid 100 days back an unconfirmed clawback, and leaves one paid 200 days back alone; a second run changes nothing', async () => {
        const { id } = await growthRepository.createAffiliate({
            name: 'Creator',
            slug: 'creator',
            code: 'CREATOR20',
            percentOff: 20,
            duration: 'forever',
            durationMonths: null,
            commissionBps: 2000,
            userId: null,
            notes: null,
            providerDiscountId: 'disc_creator20',
        });
        await legacy(id, 'order_unpaid_old', 400);
        await legacy(id, 'order_unpaid_clean', 3);
        await legacy(id, 'order_paid_100', 130, 100);
        await legacy(id, 'order_paid_200', 230, 200);
        for (const orderId of ['order_unpaid_old', 'order_paid_100', 'order_paid_200'])
            refund(orderId, 10_000);
        const first = await billing.reconcileAffiliateEarnings();
        expect(first).toMatchObject({ refundsRead: 3, refundsFailed: 0 });
        expect(callsTo('refunds.list').sort()).toEqual([
            'refunds.list:order_paid_100',
            'refunds.list:order_unpaid_clean',
            'refunds.list:order_unpaid_old',
        ]);
        expect(await earning('order_unpaid_old')).toMatchObject({
            potAmount: 2_000n,
            commissionAmount: 0n,
        });
        expect(await earning('order_paid_100')).toMatchObject({
            paidAmount: 2_000n,
            clawbackAmount: 2_000n,
            clawbackOrigin: 'cutover',
            clawbackConfirmedAt: null,
        });
        expect(await earning('order_paid_200')).toMatchObject({
            clawbackAmount: 0n,
            commissionAmount: 2_000n,
        });
        // The old unpaid earning that was not refunded is not held: it can be paid as before, and
        // the cut-over's clawback takes nothing from it until an operator says yes.
        expect(await markPaid(id)).toEqual({
            paid: 1,
            payouts: { usd: { owed: '2000', netted: '0', payout: '2000' } },
        });
        const before = await db.select().from(affiliateEarnings).orderBy(affiliateEarnings.orderId);
        const state = await growthRepository.getLedgerState();
        expect(state!.reachBackDoneAt).not.toBeNull();
        await billing.reconcileAffiliateEarnings(new Date(Date.now() + DAY));
        const after = await db.select().from(affiliateEarnings).orderBy(affiliateEarnings.orderId);
        expect(after.map(({ refundsReadAt: _read, ...row }) => row)).toEqual(
            before.map(({ refundsReadAt: _read, ...row }) => row),
        );
        expect((await growthRepository.getLedgerState())!.cutoverAt).toEqual(state!.cutoverAt);
        // Confirmed, it nets against the next payout like any other.
        const [owing] = (await growth.listAffiliateEarnings(id)).filter(
            (row) => row.orderId === 'order_paid_100',
        );
        expect(owing!.clawback).toMatchObject({ cutover: true, confirmed: false, open: '2000' });
        await growth.confirmAffiliateClawback(id, owing!.id, OPERATOR);
        await paid({ id: 'order_new', discount: 'disc_creator20' });
        await age('order_new');
        expect(await markPaid(id)).toEqual({
            paid: 1,
            payouts: { usd: { owed: '2000', netted: '2000', payout: '0' } },
        });
    });

    test('an operator who opens the page the moment the switch is on cannot mark an old, refunded earning paid before the daily run has read it', async () => {
        const affiliate = await creator();
        await legacy(affiliate.id, 'order_refunded', 200);
        await legacy(affiliate.id, 'order_fine', 3);
        refund('order_refunded', 10_000);
        // Opening the Affiliates page is the cut-over. Nothing has been read yet.
        const [shown] = await growth.listAffiliates();
        expect(shown!.ledger!.usd).toMatchObject({ payable: '0', held: '4000', payout: '0' });
        const rows = await growth.listAffiliateEarnings(affiliate.id);
        expect(rows.map((row) => row.state)).toEqual(['unread', 'unread']);
        expect(await markPaid(affiliate.id)).toEqual({ paid: 0, payouts: {} });
        // Nor with the figures a page loaded before the switch would send, nor with none.
        await expect(
            growth.markAffiliatePaid(affiliate.id, {
                by: OPERATOR,
                expected: { usd: { owed: '4000', netted: '0' } },
            }),
        ).rejects.toMatchObject({ status: 409 });
        await expect(
            growth.markAffiliatePaid(affiliate.id, { by: OPERATOR }),
        ).rejects.toMatchObject({ status: 400 });
        expect((await db.select().from(affiliateEarnings)).map((row) => row.paidAt)).toEqual([
            null,
            null,
        ]);
        await billing.reconcileAffiliateEarnings();
        expect(await markPaid(affiliate.id)).toEqual({
            paid: 1,
            payouts: { usd: { owed: '2000', netted: '0', payout: '2000' } },
        });
        expect(await earning('order_refunded')).toMatchObject({
            paidAt: null,
            commissionAmount: 0n,
        });
    });

    test('a reach back that could not read an order stays open and reads it the next day, still as the cut-over’s', async () => {
        const affiliate = await creator();
        await legacy(affiliate.id, 'order_paid_50', 80, 50);
        refund('order_paid_50', 10_000);
        polar.refundsDown = true;
        await errorsOf(async () => {
            expect(await billing.reconcileAffiliateEarnings()).toMatchObject({ refundsFailed: 1 });
        });
        expect((await growthRepository.getLedgerState())!.reachBackDoneAt).toBeNull();
        polar.refundsDown = false;
        await billing.reconcileAffiliateEarnings(new Date(Date.now() + DAY));
        expect(await earning('order_paid_50')).toMatchObject({
            clawbackAmount: 2_000n,
            clawbackOrigin: 'cutover',
        });
        expect((await growthRepository.getLedgerState())!.reachBackDoneAt).not.toBeNull();
    });
});

describe('what each side reads', () => {
    test('the affiliate’s own view carries no notes, discount id, pending email or account, no order, customer, flag or reason, and its totals account for earned against paid', async () => {
        const account = await createTestAccount();
        const customer = await createTestAccount();
        const affiliate = await creator({ notes: 'SECRET-NOTE pays late' });
        await growthRepository.updateAffiliate(affiliate.id, { userId: account.userId });
        const order = (id: string, net: number, buyer = customer.userId) =>
            paid({ id, net, discount: 'disc_creator20', customer: buyer });
        // Paid, then refunded whole in Polar: a clawback, confirmed by being made after the switch.
        await order('order_PAIDBACK', 10_000);
        await age('order_PAIDBACK');
        await markPaid(affiliate.id);
        refund('order_PAIDBACK', 10_000);
        await deliver('order.refunded', { id: 'order_PAIDBACK' });
        await order('order_HELD', 20_000);
        await order('order_SELF', 30_000, account.userId);
        await order('order_DISPUTED', 40_000);
        dispute('order_DISPUTED', 'under_review', new Date(Date.now() - DAY));
        await order('order_HALF', 50_000);
        refund('order_HALF', 25_000);
        await deliver('refund.created', { id: 'r', order_id: 'order_HALF' });
        await order('order_VOID', 60_000);
        await order('order_PAYABLE', 70_000);
        await age('order_PAYABLE');
        await billing.reconcileAffiliateEarnings();
        const voided = (await growth.listAffiliateEarnings(affiliate.id)).find(
            (row) => row.orderId === 'order_VOID',
        )!;
        await growth.voidAffiliateEarning(affiliate.id, voided.id, {
            by: OPERATOR,
            reason: 'VOID-REASON card testing',
        });
        // An unconfirmed cut-over clawback, on an order paid before the switch.
        await rawSql(
            `update affiliate_earnings set clawback_origin = 'cutover', clawback_confirmed_at = null where order_id = 'order_PAIDBACK'`,
        );
        const unconfirmed = await growth.getReferralSummary(account.userId);
        expect(unconfirmed.affiliates[0]!.totals!.usd!.toReturn).toBe('0');
        const owing = (await growth.listAffiliateEarnings(affiliate.id)).find(
            (row) => row.orderId === 'order_PAIDBACK',
        )!;
        await growth.confirmAffiliateClawback(affiliate.id, owing.id, OPERATOR);

        const summary = await growth.getReferralSummary(account.userId);
        const [own] = summary.affiliates;
        expect(Object.keys(own!).sort()).toEqual([
            'active',
            'code',
            'commissionBps',
            'createdAt',
            'duration',
            'durationMonths',
            'id',
            'name',
            'percentOff',
            'slug',
            'stats',
            'totals',
            'url',
        ]);
        const totals = own!.totals!.usd!;
        expect(totals).toEqual({
            earned: '56000',
            paidOut: '2000',
            payable: '14000',
            held: '9000',
            underReview: '14000',
            reversed: '17000',
            toReturn: '2000',
        });
        const sum = (keys: (keyof typeof totals)[]) =>
            keys.reduce((total, key) => total + BigInt(totals[key]), 0n);
        expect(sum(['paidOut', 'payable', 'held', 'underReview', 'reversed'])).toBe(
            BigInt(totals.earned),
        );
        const body = JSON.stringify(summary.affiliates);
        for (const leak of [
            'SECRET-NOTE',
            'disc_creator20',
            'order_',
            customer.userId,
            account.userId,
            'VOID-REASON',
            'self',
            'dispute',
            'under_review',
            'flag',
        ])
            expect(body, leak).not.toContain(leak);
        // The operators' list has all of it.
        const [listed] = await growth.listAffiliates();
        expect(listed).toMatchObject({
            notes: 'SECRET-NOTE pays late',
            providerDiscountId: 'disc_creator20',
            userId: account.userId,
        });
        expect(listed!.ledger!.usd).toMatchObject({
            flagged: '14000',
            voided: '12000',
            lowered: '5000',
            clawbackOpen: '2000',
            clawbackUnconfirmed: '0',
            netted: '2000',
            payout: '12000',
        });
    });

    test('a removed creator is no longer on their own page, and someone else’s earnings never are', async () => {
        const account = await createTestAccount();
        const other = await createTestAccount();
        const affiliate = await creator();
        await growthRepository.updateAffiliate(affiliate.id, { userId: account.userId });
        expect((await growth.getReferralSummary(account.userId)).affiliates).toHaveLength(1);
        expect((await growth.getReferralSummary(other.userId)).affiliates).toEqual([]);
        await growth.deleteAffiliate(affiliate.id);
        expect((await growth.getReferralSummary(account.userId)).affiliates).toEqual([]);
    });

    test('an operator cannot mark paid on figures that have moved, nor change an earning through another affiliate', async () => {
        const affiliate = await creator();
        const other = await creator({ slug: 'other', code: 'OTHER20' });
        await paid({ id: 'order_1', discount: 'disc_creator20' });
        await age('order_1');
        const [shown] = (await growth.listAffiliates()).filter((row) => row.id === affiliate.id);
        refund('order_1', 5_000);
        await deliver('refund.created', { id: 'r', order_id: 'order_1' });
        await expect(
            growth.markAffiliatePaid(affiliate.id, {
                by: OPERATOR,
                expected: { usd: { owed: shown!.ledger!.usd!.payable, netted: '0' } },
            }),
        ).rejects.toMatchObject({
            status: 409,
            message:
                'The amounts changed since this page loaded. Check the figures, then mark it paid again.',
        });
        expect((await earning('order_1'))!.paidAt).toBeNull();
        const [row] = await growth.listAffiliateEarnings(affiliate.id);
        await expect(
            growth.voidAffiliateEarning(other.id, row!.id, { by: OPERATOR, reason: 'Wrong one' }),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
            growth.settleAffiliateClawback(affiliate.id, row!.id, {
                kind: 'repaid',
                amount: '12.50',
                by: OPERATOR,
            }),
        ).rejects.toMatchObject({ status: 400 });
        expect((await earning('order_1'))!.voidedAt).toBeNull();
    });
});
