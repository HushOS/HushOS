import type * as PolarSdk from '@polar-sh/sdk/2026-04';
import { PolarClientError } from '@polar-sh/sdk';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * Runs the billing server against the test database with Polar's client
 * replaced by an in-memory fake. Webhook signatures are real: the payload is
 * signed the way Polar signs it, so the verification path is exercised.
 */
process.env.APP_ORIGIN = 'http://localhost:5173';
process.env.BILLING_PROVIDER = 'polar';
process.env.POLAR_ENVIRONMENT = 'sandbox';
process.env.POLAR_ACCESS_TOKEN = 'polar_oat_test';
const SECRET_BYTES = Buffer.from('0123456789abcdef0123456789abcdef');
process.env.POLAR_WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
process.env.BILLING_GRACE_DAYS = '3';

const GIB = 1_073_741_824n;
const DAY = 24 * 60 * 60 * 1000;
const PRO = '11111111-aaaa-4aaa-8aaa-111111111111';
const MAX = '22222222-aaaa-4aaa-8aaa-222222222222';

type FakeSubscription = {
    id: string;
    status: string;
    product_id: string;
    recurring_interval: 'month' | 'year';
    amount: number;
    currency: string;
    current_period_end: string;
    cancel_at_period_end: boolean;
    ended_at?: string | null;
};

/* The state of the fake Polar organisation, mutated by tests. */
const polar = {
    products: [
        product(PRO, 'Pro (monthly)', 'month', { usd: 1000, inr: 79900 }, 500n * GIB, {
            hushos_recommended: 'true',
        }),
        product(MAX, 'Max (yearly)', 'year', { usd: 15000 }, 1024n * GIB),
        product(
            '33333333-aaaa-4aaa-8aaa-333333333333',
            'Not a plan',
            'month',
            { usd: 100 },
            0n,
            {},
            false,
        ),
        // Priced only in a currency that is not the organisation's default: never a plan.
        product(
            '44444444-aaaa-4aaa-8aaa-444444444444',
            'Euro only',
            'month',
            { eur: 900 },
            100n * GIB,
        ),
    ],
    customers: new Map<string, { id: string; subscriptions: FakeSubscription[] }>(),
    subscriptions: new Map<string, FakeSubscription>(),
    discounts: [] as ({ code: string; duration: string } & Record<string, unknown>)[],
    checkouts: [] as Record<string, unknown>[],
    calls: [] as string[],
};

function product(
    id: string,
    name: string,
    interval: 'month' | 'year',
    amounts: Record<string, number>,
    quota: bigint,
    extra: Record<string, string> = {},
    plan = true,
) {
    return {
        id,
        name,
        description: null,
        is_recurring: true,
        is_archived: false,
        recurring_interval: interval,
        metadata: plan
            ? { hushos_plan: name.toLowerCase(), quota_bytes: quota.toString(), ...extra }
            : {},
        prices: Object.entries(amounts).map(([currency, amount]) => ({
            amount_type: 'fixed',
            price_amount: amount,
            price_currency: currency,
            is_archived: false,
        })),
    };
}

function notFound() {
    const error = new PolarClientError(404, { error: 'ResourceNotFound' });
    return error;
}

const fakeClient = {
    products: {
        async *iterList() {
            polar.calls.push('products.iterList');
            for (const item of polar.products) yield item;
        },
    },
    customers: {
        async getStateExternal(externalId: string) {
            polar.calls.push(`customers.getStateExternal:${externalId}`);
            const customer = polar.customers.get(externalId);
            if (!customer) throw notFound();
            return {
                id: customer.id,
                external_id: externalId,
                active_subscriptions: customer.subscriptions.filter((s) =>
                    ['active', 'trialing'].includes(s.status),
                ),
                granted_benefits: [],
                active_meters: [],
            };
        },
        async deleteExternal(externalId: string) {
            polar.calls.push(`customers.deleteExternal:${externalId}`);
            polar.customers.delete(externalId);
        },
    },
    discounts: {
        async create(body: { code: string; basis_points: number; duration: string }) {
            polar.calls.push(`discounts.create:${body.code}`);
            polar.discounts.push(body);
            return { id: `disc_${body.code.toLowerCase()}`, ...body };
        },
        // Polar's search matches name or code loosely; the caller must pick the exact code.
        async list(query: { query?: string | null }) {
            polar.calls.push(`discounts.list:${query.query}`);
            const needle = (query.query ?? '').toUpperCase();
            return {
                items: polar.discounts
                    .filter((d) => d.code.toUpperCase().includes(needle))
                    .map((d) => ({
                        id: `disc_${d.code.toLowerCase()}`,
                        type: 'basis_points' in d ? 'percentage' : 'fixed',
                        name: d.code,
                        starts_at: null,
                        ends_at: null,
                        max_redemptions: null,
                        redemptions_count: 0,
                        products: [],
                        ...d,
                    })),
                pagination: { total_count: 0, max_page: 1 },
            };
        },
    },
    checkouts: {
        async create(body: Record<string, unknown>) {
            polar.calls.push('checkouts.create');
            polar.checkouts.push(body);
            return { id: `chk_${polar.checkouts.length}`, url: 'https://polar.test/checkout' };
        },
    },
    subscriptions: {
        async get(id: string) {
            polar.calls.push(`subscriptions.get:${id}`);
            const subscription = polar.subscriptions.get(id);
            if (!subscription) throw notFound();
            return subscription;
        },
        async revoke(id: string) {
            polar.calls.push(`subscriptions.revoke:${id}`);
            const subscription = polar.subscriptions.get(id);
            if (subscription) {
                subscription.status = 'canceled';
                subscription.ended_at = new Date().toISOString();
            }
            return subscription;
        },
    },
};

vi.mock('@polar-sh/sdk/2026-04', async (importOriginal) => {
    const real = await importOriginal<typeof PolarSdk>();
    return { ...real, createPolar: () => fakeClient };
});

const { closeDatabase, createTestAccount, resetDatabase } = await import('../../db/test/helpers');
const { billingRepository, authRepository, growthRepository } = await import('@hushos/db');
const billing = await import('./server');
const growth = await import('./growth');

function subscribe(userId: string, subscription: Partial<FakeSubscription> & { id: string }) {
    const full: FakeSubscription = {
        status: 'active',
        product_id: PRO,
        recurring_interval: 'month',
        amount: 1000,
        currency: 'usd',
        current_period_end: new Date(Date.now() + 30 * DAY).toISOString(),
        cancel_at_period_end: false,
        ended_at: null,
        ...subscription,
    };
    const customer = polar.customers.get(userId) ?? {
        id: `cus_${userId.slice(0, 8)}`,
        subscriptions: [],
    };
    customer.subscriptions = customer.subscriptions.filter((s) => s.id !== full.id).concat(full);
    polar.customers.set(userId, customer);
    polar.subscriptions.set(full.id, full);
    return full;
}

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
    return new Request('http://localhost/api/billing/webhook', {
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

beforeEach(async () => {
    await resetDatabase();
    polar.customers.clear();
    polar.subscriptions.clear();
    polar.discounts = [];
    polar.checkouts = [];
    polar.calls = [];
});
afterAll(closeDatabase);

describe('catalogue', () => {
    test('lists only recurring products with plan metadata, in quota order', async () => {
        const catalogue = await billing.listCatalogue();
        expect(catalogue.enabled).toBe(true);
        expect(catalogue.plans.map((plan) => plan.name)).toEqual(['Pro (monthly)', 'Max (yearly)']);
        expect(catalogue.plans[0]).toMatchObject({
            id: PRO,
            interval: 'month',
            amount: 1000,
            currency: 'usd',
            prices: { usd: 1000, inr: 79900 },
            quotaBytes: (500n * GIB).toString(),
            recommended: true,
        });
        expect(catalogue.plans[1]?.recommended).toBe(false);
    });
});

describe('reconcileCustomer', () => {
    test('grants the allowance for an active subscription and records the customer', async () => {
        const { userId } = await createTestAccount();
        subscribe(userId, { id: 'sub_a' });
        await billing.reconcileCustomer(userId);
        const allowance = await authRepository.getStorageAllowance(userId);
        expect(allowance?.quotaBytes).toBe((501n * GIB).toString());
        const summary = await billing.getSummary({
            id: userId,
            name: 'Test',
            email: 'x@hushos.test',
        });
        expect(summary.subscription?.productName).toBe('Pro (monthly)');
        expect(summary.subscription?.amount).toBe(1000);
        expect(summary.subscription?.currency).toBe('usd');
        expect(summary.hasCustomer).toBe(true);
    });

    test('keeps a past-due subscription by reading it directly', async () => {
        const { userId } = await createTestAccount();
        const sub = subscribe(userId, { id: 'sub_b' });
        await billing.reconcileCustomer(userId);
        sub.status = 'past_due';
        await billing.reconcileCustomer(userId);
        expect(polar.calls).toContain('subscriptions.get:sub_b');
        expect((await authRepository.getStorageAllowance(userId))?.quotaBytes).toBe(
            (501n * GIB).toString(),
        );
        expect((await billingRepository.getBillingSummary(userId)).subscription?.status).toBe(
            'past_due',
        );
    });

    test('revokes the allowance when the subscription has ended', async () => {
        const { userId } = await createTestAccount();
        const sub = subscribe(userId, { id: 'sub_c' });
        await billing.reconcileCustomer(userId);
        sub.status = 'canceled';
        sub.ended_at = new Date().toISOString();
        await billing.reconcileCustomer(userId);
        expect((await authRepository.getStorageAllowance(userId))?.quotaBytes).toBe(GIB.toString());
    });

    test('ignores a subscription whose product is not a HushOS plan', async () => {
        const { userId } = await createTestAccount();
        subscribe(userId, { id: 'sub_d', product_id: '33333333-aaaa-4aaa-8aaa-333333333333' });
        await billing.reconcileCustomer(userId);
        expect((await authRepository.getStorageAllowance(userId))?.quotaBytes).toBe(GIB.toString());
    });

    test('a customer unknown to Polar leaves nothing behind', async () => {
        const { userId } = await createTestAccount();
        await billing.reconcileCustomer(userId);
        expect(await billingRepository.getCustomer(userId)).toBeNull();
    });
});

describe('handleWebhook', () => {
    test('a signed delivery is applied once and a replay is acknowledged without work', async () => {
        const { userId } = await createTestAccount();
        subscribe(userId, { id: 'sub_e' });
        const request = await signedWebhook({
            type: 'customer.state_changed',
            data: { id: 'cus_x', external_id: userId, email: 'x@hushos.test' },
        });
        const first = await billing.handleWebhook(request.clone());
        expect(first.status).toBe(200);
        expect((await authRepository.getStorageAllowance(userId))?.quotaBytes).toBe(
            (501n * GIB).toString(),
        );
        const reads = polar.calls.filter((call) =>
            call.startsWith('customers.getStateExternal'),
        ).length;
        const second = await billing.handleWebhook(request);
        expect(second.status).toBe(200);
        expect(
            polar.calls.filter((call) => call.startsWith('customers.getStateExternal')),
        ).toHaveLength(reads);
    });

    test('a bad signature is refused before anything is read', async () => {
        const request = await signedWebhook({
            type: 'customer.state_changed',
            data: { external_id: 'x' },
        });
        const tampered = new Request(request.url, {
            method: 'POST',
            headers: request.headers,
            body: '{"type":"customer.state_changed","data":{"external_id":"y"}}',
        });
        const response = await billing.handleWebhook(tampered);
        expect(response.status).toBe(403);
        expect(polar.calls).toEqual([]);
    });

    test('an unknown event type is acknowledged and ignored', async () => {
        const response = await billing.handleWebhook(
            await signedWebhook({ type: 'something.new', data: {} }),
        );
        expect(response.status).toBe(200);
        expect(polar.calls).toEqual([]);
    });
});

describe('revokeForDeletion', () => {
    test('revokes active subscriptions and deletes the customer', async () => {
        const { userId } = await createTestAccount();
        subscribe(userId, { id: 'sub_f' });
        await billing.reconcileCustomer(userId);
        await billing.revokeForDeletion(userId);
        expect(polar.calls).toContain('subscriptions.revoke:sub_f');
        expect(polar.calls).toContain(`customers.deleteExternal:${userId}`);
    });

    test('does nothing for an account that never bought anything', async () => {
        const { userId } = await createTestAccount();
        await billing.revokeForDeletion(userId);
        expect(polar.calls).toEqual([]);
    });
});

describe('affiliates', () => {
    const creator = () =>
        growth.createAffiliate({
            name: 'Creator',
            slug: 'creator',
            code: 'creator25',
            percentOff: 25,
            duration: 'forever',
            commissionBps: 2000,
        });

    test('enrolling a creator registers the discount at Polar first, as a percentage', async () => {
        const affiliate = await creator();
        expect(polar.discounts).toEqual([
            expect.objectContaining({ code: 'CREATOR25', basis_points: 2500, duration: 'forever' }),
        ]);
        expect(affiliate.providerDiscountId).toBe('disc_creator25');
        expect(affiliate.url).toBe('http://localhost:5173/go/creator');
        const landing = await growth.getOfferLanding('creator');
        expect(landing).toMatchObject({ kind: 'affiliate', name: 'Creator', code: 'CREATOR25' });
        expect(landing?.catalogue.plans.length).toBe(2);
        // The creator's code reaches the same page as their slug.
        expect((await growth.getOfferLanding('creator25'))?.kind).toBe('affiliate');
        expect(await growth.getOfferLanding('nobody')).toBeNull();
    });

    test('a checkout by someone who arrived through the affiliate carries its discount; others carry none', async () => {
        await creator();
        const fan = await createTestAccount();
        await growth.attributeNewAccount(fan.userId, 'CREATOR25');
        await billing.startCheckout({ id: fan.userId, name: 'Fan', email: fan.email }, PRO);
        expect(polar.checkouts.at(-1)).toMatchObject({
            discount_id: 'disc_creator25',
            allow_discount_codes: true,
        });
        const stranger = await createTestAccount();
        await billing.startCheckout(
            { id: stranger.userId, name: 'Stranger', email: stranger.email },
            PRO,
        );
        expect(polar.checkouts.at(-1)).toMatchObject({ discount_id: null });
        // A signed-in visitor who opened the creator's page carries the code too.
        const visitor = await createTestAccount();
        expect(await growth.rememberCoupon(visitor.userId, 'creator25')).toEqual({
            code: 'CREATOR25',
        });
        await billing.startCheckout(
            { id: visitor.userId, name: 'Visitor', email: visitor.email },
            PRO,
        );
        expect(polar.checkouts.at(-1)).toMatchObject({ discount_id: 'disc_creator25' });
        // Once used, it is not applied again on its own.
        await billing
            .startCheckout({ id: visitor.userId, name: 'Visitor', email: visitor.email }, MAX)
            .catch(() => {});
        await expect(growth.rememberCoupon(visitor.userId, 'nope')).rejects.toThrow(
            'That code is not valid.',
        );
        // The discount is withdrawn with the affiliate.
        const [row] = await growth.listAffiliates();
        await growth.updateAffiliate(row!.id, { active: false });
        const late = await createTestAccount();
        await growth.attributeNewAccount(late.userId, 'CREATOR25');
        await billing.startCheckout({ id: late.userId, name: 'Late', email: late.email }, PRO);
        expect(polar.checkouts.at(-1)).toMatchObject({ discount_id: null });
    });

    test('a paid order pays the commission once, however often Polar reports it', async () => {
        const affiliate = await creator();
        const fan = await createTestAccount();
        await growth.attributeNewAccount(fan.userId, 'creator25');
        const order = {
            id: 'order_9',
            discount_id: 'disc_creator25',
            net_amount: 750,
            currency: 'usd',
            billing_reason: 'subscription_create',
            customer: { id: 'cus_fan', external_id: fan.userId },
        };
        const first = await signedWebhook({ type: 'order.paid', data: order });
        expect((await billing.handleWebhook(first.clone())).status).toBe(200);
        expect((await billing.handleWebhook(first)).status).toBe(200);
        // The same order under a fresh delivery id is still the same order.
        const again = await signedWebhook({ type: 'order.paid', data: order });
        expect((await billing.handleWebhook(again)).status).toBe(200);
        const [row] = await growth.listAffiliates();
        expect(row!.id).toBe(affiliate.id);
        expect(row!.stats).toEqual({
            signups: 1,
            orders: 1,
            earnings: { usd: { unpaid: 150, paid: 0 } },
        });
        expect(await growth.markAffiliatePaid(affiliate.id)).toEqual({ paid: 1 });
        // An order without the discount still pays, through the sign-up attribution.
        const renewal = await signedWebhook({
            type: 'order.paid',
            data: {
                ...order,
                id: 'order_10',
                discount_id: null,
                billing_reason: 'subscription_cycle',
            },
        });
        await billing.handleWebhook(renewal);
        const [after] = await growth.listAffiliates();
        expect(after!.stats.earnings).toEqual({ usd: { unpaid: 150, paid: 150 } });
    });
});

describe('offers made at Polar', () => {
    test('a code the operator made at Polar has a page and rides to checkout without an affiliate', async () => {
        polar.discounts.push({
            code: 'LAUNCH20',
            basis_points: 2000,
            duration: 'repeating',
            duration_in_months: 3,
            name: 'Launch week',
            ends_at: new Date(Date.now() + 7 * DAY).toISOString(),
            products: [{ id: PRO }],
        });
        const landing = await growth.getOfferLanding('launch20');
        expect(landing).toMatchObject({
            kind: 'code',
            name: 'Launch week',
            code: 'LAUNCH20',
            terms: { type: 'percentage', percentOff: 20, duration: 'repeating', durationMonths: 3 },
            productIds: [PRO],
        });
        expect(landing?.endsAt).not.toBeNull();
        // A visitor who signs up from the page: the code rides in their sign-up intent,
        // no referral is recorded for it, and yet the checkout carries the discount.
        const fan = await createTestAccount();
        await growthRepository.rememberCoupon(fan.userId, 'LAUNCH20');
        await growth.attributeNewAccount(fan.userId, 'LAUNCH20');
        expect(await growthRepository.pendingReferralCode(fan.userId)).toBe('LAUNCH20');
        await billing.startCheckout({ id: fan.userId, name: 'Fan', email: fan.email }, PRO);
        expect(polar.checkouts.at(-1)).toMatchObject({
            discount_id: 'disc_launch20',
            allow_discount_codes: true,
        });
        // A signed-in visitor keeps it the same way, whatever the case they typed.
        const visitor = await createTestAccount();
        expect(await growth.rememberCoupon(visitor.userId, 'Launch20')).toEqual({
            code: 'LAUNCH20',
        });
        await billing.startCheckout(
            { id: visitor.userId, name: 'Visitor', email: visitor.email },
            PRO,
        );
        expect(polar.checkouts.at(-1)).toMatchObject({ discount_id: 'disc_launch20' });
    });

    test('a fixed amount is shown in its currency; an ended or spent code has no page and no discount', async () => {
        polar.discounts.push(
            { code: 'FIVER', amount: 500, currency: 'usd', duration: 'once', name: 'Five off' },
            {
                code: 'OLD10',
                basis_points: 1000,
                duration: 'forever',
                ends_at: new Date(Date.now() - DAY).toISOString(),
            },
            {
                code: 'SPENT',
                basis_points: 1000,
                duration: 'forever',
                max_redemptions: 5,
                redemptions_count: 5,
            },
            {
                code: 'SOON',
                basis_points: 1000,
                duration: 'forever',
                starts_at: new Date(Date.now() + DAY).toISOString(),
            },
        );
        expect((await growth.getOfferLanding('fiver'))?.terms).toEqual({
            type: 'fixed',
            amount: 500,
            currency: 'usd',
            duration: 'once',
            durationMonths: null,
        });
        for (const code of ['OLD10', 'SPENT', 'SOON']) {
            expect(await growth.getOfferLanding(code)).toBeNull();
            const person = await createTestAccount();
            await expect(growth.rememberCoupon(person.userId, code)).rejects.toThrow(
                'That code is not valid.',
            );
            // Even a code already sitting in the intent carries nothing once it is dead.
            await growthRepository.rememberCoupon(person.userId, code);
            await growth.attributeNewAccount(person.userId, code);
            await billing.startCheckout(
                { id: person.userId, name: 'Person', email: person.email },
                PRO,
            );
            expect(polar.checkouts.at(-1)).toMatchObject({ discount_id: null });
        }
    });
});

describe('referrals', () => {
    test('an invite gives both people storage, and a code that resolves to nobody gives nothing', async () => {
        const inviter = await createTestAccount();
        const summary = await growth.getReferralSummary(inviter.userId);
        expect(summary.url).toBe(`http://localhost:5173/r/${summary.code}`);
        const joiner = await createTestAccount();
        await growth.attributeNewAccount(joiner.userId, summary.code);
        expect((await authRepository.getStorageAllowance(inviter.userId))?.quotaBytes).toBe(
            (2n * GIB).toString(),
        );
        expect((await authRepository.getStorageAllowance(joiner.userId))?.quotaBytes).toBe(
            (2n * GIB).toString(),
        );
        expect(await growth.getReferralSummary(inviter.userId)).toMatchObject({
            joined: 1,
            signup: { count: 1, bytes: GIB.toString(), capBytes: (5n * GIB).toString() },
            paid: { count: 0, bytes: '0', bonusBytes: (5n * GIB).toString() },
        });
        // The person they invited pays for a plan: the inviter earns the paid bonus, once.
        const order = {
            id: 'order_ref_1',
            net_amount: 1000,
            currency: 'usd',
            billing_reason: 'subscription_create',
            customer: { id: 'cus_joiner', external_id: joiner.userId },
        };
        await billing.handleWebhook(await signedWebhook({ type: 'order.paid', data: order }));
        await billing.handleWebhook(
            await signedWebhook({
                type: 'order.paid',
                data: { ...order, id: 'order_ref_2', billing_reason: 'subscription_cycle' },
            }),
        );
        expect((await authRepository.getStorageAllowance(inviter.userId))?.quotaBytes).toBe(
            (7n * GIB).toString(),
        );
        expect((await growth.getReferralSummary(inviter.userId)).paid).toMatchObject({
            count: 1,
            bytes: (5n * GIB).toString(),
        });
        expect((await growth.getReferralLanding(summary.code))?.inviter).toBe('Test');
        expect(await growth.getReferralLanding('zzzzzzzz')).toBeNull();
        const nobody = await createTestAccount();
        await growth.attributeNewAccount(nobody.userId, 'zzzzzzzz');
        expect((await authRepository.getStorageAllowance(nobody.userId))?.quotaBytes).toBe(
            GIB.toString(),
        );
    });
});
