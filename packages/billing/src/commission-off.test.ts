import type * as PolarSdk from '@polar-sh/sdk/2026-10';
import { PolarClientError } from '@polar-sh/sdk';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * The same billing server with AFFILIATE_V2_ENABLED off, which is how every server runs until
 * its operator turns it on: affiliates must work exactly as they did before commission safety
 * existed. Each test here sets up what the switch would act on (a refund at Polar, a dispute
 * already on record, the affiliate's own account as the buyer, a paused affiliate) and fails if
 * any of it leaks through. `server.test.ts` holds the rest of today's behaviour.
 */
process.env.APP_ORIGIN = 'http://localhost:5173';
process.env.BILLING_PROVIDER = 'polar';
process.env.POLAR_ENVIRONMENT = 'sandbox';
process.env.POLAR_ACCESS_TOKEN = 'polar_oat_test';
const SECRET_BYTES = Buffer.from('0123456789abcdef0123456789abcdef');
process.env.POLAR_WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
delete process.env.AFFILIATE_V2_ENABLED;

const polar = {
    refunds: [] as { id: string; order_id: string; amount: number; status: string }[],
    discounts: new Map<string, { id: string; code: string; ends_at: string | null }>(),
    calls: [] as string[],
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
    refunds: {
        async list(query: { order_id?: string }) {
            polar.calls.push(`refunds.list:${query.order_id}`);
            return {
                items: polar.refunds.filter((refund) => refund.order_id === query.order_id),
                pagination: { total_count: 0, max_page: 1 },
            };
        },
    },
    disputes: {
        // oxlint-disable-next-line require-yield -- never reached with the switch off
        async *iterList() {
            polar.calls.push('disputes.list');
        },
        async get(id: string) {
            polar.calls.push(`disputes.get:${id}`);
            throw missing();
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
            return { ...polar.discounts.get(id)! };
        },
        async update(id: string, body: Record<string, unknown>) {
            polar.calls.push(`discounts.update:${id}:${Object.keys(body).join()}`);
            return { ...polar.discounts.get(id)! };
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
const { affiliateEarnings, affiliateLedgerState, affiliateWithdrawnOrders, affiliates } =
    await import('@hushos/db/schema');
const billing = await import('./server');
const growth = await import('./growth');
const commission = await import('./commission');

async function deliver(type: string, data: object) {
    const payload = JSON.stringify({ type, data });
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
    const response = await billing.handleWebhook(
        new Request('http://localhost/api/billing/webhook', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'webhook-id': id,
                'webhook-timestamp': timestamp,
                'webhook-signature': `v1,${signature}`,
            },
            body: payload,
        }),
    );
    return response.status;
}

const paid = (id: string, customer: string | null, discount: string | null = 'disc_creator20') =>
    deliver('order.paid', {
        id,
        subscription_id: null,
        created_at: new Date().toISOString(),
        currency: 'usd',
        net_amount: 10_000,
        refunded_amount: 5_000,
        discount_id: discount,
        customer: customer ? { external_id: customer } : null,
    });

const creator = () =>
    growth.createAffiliate({
        name: 'Creator',
        slug: 'creator',
        code: 'CREATOR20',
        percentOff: 20,
        duration: 'forever',
        commissionBps: 2000,
        notes: 'Paid by bank transfer',
    });

beforeEach(async () => {
    await resetDatabase();
    polar.refunds = [];
    polar.discounts.clear();
    polar.calls = [];
});
afterAll(closeDatabase);

describe('with commission safety off', () => {
    test('an earning is recorded as it always was: not held, not flagged, untouched by a dispute on record or a refund at Polar, and paid whole at once', async () => {
        expect(commission.affiliateV2()).toBe(false);
        const account = await createTestAccount();
        const affiliate = await creator();
        await growthRepository.updateAffiliate(affiliate.id, { userId: account.userId });
        // Everything the switch would act on: a lost dispute already on record for the order, half
        // of it refunded at Polar, and the affiliate's own account as the buyer.
        await growthRepository.recordDispute({
            id: 'dp_1',
            orderId: 'order_1',
            status: 'lost',
            openedAt: new Date(),
        });
        polar.refunds.push({
            id: 'refund_1',
            order_id: 'order_1',
            amount: 5_000,
            status: 'succeeded',
        });
        polar.calls = [];
        expect(await paid('order_1', account.userId)).toBe(200);
        const [row] = await db.select().from(affiliateEarnings);
        expect(row).toMatchObject({
            orderId: 'order_1',
            part: 'main',
            netAmount: 10_000n,
            commissionAmount: 2_000n,
            potAmount: null,
            payableAt: null,
            paidAmount: null,
            flag: null,
            refundedAmount: 0n,
            disputeId: null,
            disputeStatus: null,
        });
        // A refund's deliveries read nothing at Polar and change nothing.
        expect(await deliver('refund.created', { id: 'refund_1', order_id: 'order_1' })).toBe(200);
        expect(await deliver('refund.updated', { id: 'refund_1', order_id: 'order_1' })).toBe(200);
        expect(await deliver('order.refunded', { id: 'order_1' })).toBe(200);
        expect(polar.calls).toEqual([]);
        expect((await db.select().from(affiliateEarnings))[0]).toEqual(row);
        // Owed in full straight away, in the figures the page has always read, and nothing else.
        const [listed] = await growth.listAffiliates();
        expect(listed!.stats.earnings).toEqual({ usd: { unpaid: 2000, paid: 0 } });
        for (const key of ['ledger', 'pausedAt', 'removedAt', 'discountNotice'])
            expect(listed).not.toHaveProperty(key);
        expect(await growth.markAffiliatePaid(affiliate.id, { by: account.userId })).toEqual({
            paid: 1,
        });
        expect((await growth.listAffiliates())[0]!.stats.earnings).toEqual({
            usd: { unpaid: 0, paid: 2000 },
        });
        // The cut-over never began.
        expect(await db.select().from(affiliateLedgerState)).toEqual([]);
    });

    test('the daily run reads no dispute and no refund, and the operators’ routes for the ledger are not there', async () => {
        const affiliate = await creator();
        await paid('order_1', null);
        polar.calls = [];
        expect(await billing.reconcileAffiliateEarnings()).toBeNull();
        expect(polar.calls).toEqual([]);
        expect(await growth.affiliateLedgerStatus()).toEqual({ enabled: false });
        const [row] = await db.select().from(affiliateEarnings);
        const gone = { status: 404 };
        await expect(growth.listAffiliateEarnings(affiliate.id)).rejects.toMatchObject(gone);
        await expect(
            growth.voidAffiliateEarning(affiliate.id, row!.id, { by: affiliate.id, reason: 'No' }),
        ).rejects.toMatchObject(gone);
        await expect(
            growth.releaseAffiliateEarning(affiliate.id, row!.id, affiliate.id),
        ).rejects.toMatchObject(gone);
        await expect(
            growth.confirmAffiliateClawback(affiliate.id, row!.id, affiliate.id),
        ).rejects.toMatchObject(gone);
        await expect(
            growth.settleAffiliateClawback(affiliate.id, row!.id, {
                kind: 'written-off',
                note: 'No',
                by: affiliate.id,
            }),
        ).rejects.toMatchObject(gone);
        await expect(growth.deleteAffiliateRecord(affiliate.id)).rejects.toMatchObject(gone);
        expect((await db.select().from(affiliateEarnings))[0]).toEqual(row);
    });

    test('pausing writes `active` and nothing else, asks Polar nothing, and a paused affiliate’s code typed at checkout still earns', async () => {
        const affiliate = await creator();
        polar.calls = [];
        const paused = await growth.updateAffiliate(affiliate.id, { active: false });
        expect(paused.active).toBe(false);
        expect(polar.calls).toEqual([]);
        expect((await db.select().from(affiliates))[0]).toMatchObject({
            active: false,
            pausedAt: null,
            removedAt: null,
        });
        const stranger = await createTestAccount();
        await paid('order_paused', stranger.userId);
        expect(await db.select().from(affiliateEarnings)).toHaveLength(1);
        await growth.updateAffiliate(affiliate.id, { active: true });
        expect(polar.calls).toEqual([]);
    });

    test('removing deletes the discount at Polar, the row and its ledger, and is refused only while commission is unpaid', async () => {
        const affiliate = await creator();
        await paid('order_1', null);
        await expect(growth.deleteAffiliate(affiliate.id)).rejects.toThrow(
            'This affiliate is still owed commission. Mark it paid first, or pause them instead.',
        );
        await growth.markAffiliatePaid(affiliate.id);
        polar.calls = [];
        expect(await growth.deleteAffiliate(affiliate.id)).toEqual({ deleted: true });
        expect(polar.calls).toEqual(['discounts.delete:disc_creator20']);
        expect(await db.select().from(affiliates)).toEqual([]);
        expect(await db.select().from(affiliateEarnings)).toEqual([]);
    });

    test('an order HushOS refunds whole has its unpaid earning deleted, not kept at nothing', async () => {
        await creator();
        await paid('order_1', null);
        expect(await commission.withdrawOrderEarning('order_1')).toBe('withdrawn');
        expect(await db.select().from(affiliateEarnings)).toEqual([]);
        expect(await db.select().from(affiliateWithdrawnOrders)).toHaveLength(1);
    });

    test('a creator’s own page is sent what it always was: the operators’ view, notes and all, and no totals', async () => {
        const account = await createTestAccount();
        const affiliate = await creator();
        await growthRepository.updateAffiliate(affiliate.id, { userId: account.userId });
        const [own] = (await growth.getReferralSummary(account.userId)).affiliates;
        expect(own).toMatchObject({
            notes: 'Paid by bank transfer',
            providerDiscountId: 'disc_creator20',
            pendingEmail: null,
            userId: account.userId,
        });
        expect(own).not.toHaveProperty('totals');
    });
});
