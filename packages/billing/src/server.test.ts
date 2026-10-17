import type * as PolarSdk from '@polar-sh/sdk/2026-10';
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
process.env.GROUPS_ENABLED = 'true';

const GIB = 1_073_741_824n;
const DAY = 24 * 60 * 60 * 1000;
const PRO = '11111111-aaaa-4aaa-8aaa-111111111111';
const MAX = '22222222-aaaa-4aaa-8aaa-222222222222';
const FAMILY = '55555555-aaaa-4aaa-8aaa-555555555555';
const FAMILY_POOL = 2048n * GIB;

type FakeSubscription = {
    id: string;
    status: string;
    product_id: string;
    recurring_interval: 'month' | 'year';
    amount: number;
    currency: string;
    current_period_start?: string;
    current_period_end: string;
    cancel_at_period_end: boolean;
    ended_at?: string | null;
    units?: number | null;
    pending_update?: { units: number; applies_at: string } | null;
};

/* A customer at the fake Polar; a team one has members (external ids), its owner first. */
type FakeCustomer = {
    id: string;
    subscriptions: FakeSubscription[];
    type?: 'individual' | 'team';
    members?: string[];
    metadata?: Record<string, string>;
    name?: string | null;
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
        // Family plans: unit amounts come back as decimal strings (spike E2).
        familyProduct(FAMILY, 'Family (monthly)', {
            usd: { base: 1500, perMember: '200' },
            eur: { base: 1500, perMember: '200.000000000000' },
        }),
        // EUR includes five while USD includes six: a smaller family sold in EUR (spike E2).
        familyProduct('66666666-aaaa-4aaa-8aaa-666666666666', 'Family mismatch (monthly)', {
            usd: { base: 1500, perMember: '200' },
            eur: { base: 1500, perMember: '200', bound: 5 },
        }),
        // Six included by its metadata and its minimum, but the free tier ends at five.
        familyProduct('77777777-aaaa-4aaa-8aaa-777777777777', 'Family five (monthly)', {
            usd: { base: 1500, perMember: '200', bound: 5, minimum: 6 },
        }),
        // The free tier ends at six, but the minimum lets a checkout buy five.
        familyProduct('88888888-aaaa-4aaa-8aaa-888888888888', 'Family low minimum (monthly)', {
            usd: { base: 1500, perMember: '200', minimum: 5 },
        }),
        // A fraction of a cent cannot be quoted or charged in whole minor units.
        familyProduct('99999999-aaaa-4aaa-8aaa-999999999999', 'Family fraction (monthly)', {
            usd: { base: 1500, perMember: '200.5' },
        }),
        // The Business shape: a pool that grows per member is not a family plan.
        familyProduct(
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'Family per member (monthly)',
            { usd: { base: 1500, perMember: '200' } },
            { quota_bytes_per_member: String(100n * GIB) },
        ),
    ],
    customers: new Map<string, FakeCustomer>(),
    subscriptions: new Map<string, FakeSubscription>(),
    discounts: [] as ({ code: string; duration: string } & Record<string, unknown>)[],
    checkouts: [] as Record<string, unknown>[],
    sessions: [] as Record<string, unknown>[],
    /* The body of the 402 the next raise gets, as Polar answers a refused off-session charge. */
    raiseRefusal: null as { error: string; detail: string } | null,
    /*
     * The case the sandbox never showed (spike 8): a raise Polar keeps, with its
     * order left waiting for the bank, whether it answered 402 or 200.
     */
    raiseLeavesOrder: false,
    /* How many scheduled cuts (next_period) fail before Polar takes one again. */
    cutFailures: 0,
    /* Runs once as Polar takes the next cut: an admission landing mid-flight. */
    beforeCut: null as (() => Promise<void>) | null,
    /* Orders cannot be read (a token without orders:read, an outage). */
    ordersFail: false,
    orders: [] as {
        id: string;
        subscription_id: string;
        status: string;
        due_amount: number;
        created_at: string;
    }[],
    calls: [] as string[],
};

function familyProduct(
    id: string,
    name: string,
    prices: Record<string, { base: number; perMember: string; bound?: number; minimum?: number }>,
    extra: Record<string, string> = {},
) {
    return {
        id,
        name,
        description: null,
        is_recurring: true,
        is_archived: false,
        recurring_interval: 'month' as const,
        metadata: {
            hushos_plan: 'family',
            hushos_group_kind: 'family',
            quota_bytes: FAMILY_POOL.toString(),
            included_members: '6',
            ...extra,
        },
        prices: Object.entries(prices).flatMap(([currency, price]) => [
            {
                amount_type: 'fixed',
                price_amount: price.base,
                price_currency: currency,
                is_archived: false,
            },
            {
                amount_type: 'unit_based',
                price_currency: currency,
                is_archived: false,
                tiers: {
                    type: 'graduated',
                    tiers: [
                        { bound: price.bound ?? 6, unit_amount: '0' },
                        { bound: null, unit_amount: price.perMember },
                    ],
                },
                minimum_units: price.minimum ?? price.bound ?? 6,
                unit_label: null,
                maximum_units: null,
            },
        ]),
    };
}

/* The unit price's minimum in the subscription's currency, which Polar enforces on cuts. */
function minimumUnits(subscription: FakeSubscription) {
    const found = polar.products.find((candidate) => candidate.id === subscription.product_id);
    const unit = (found?.prices as Record<string, unknown>[] | undefined)?.find(
        (price) =>
            price.amount_type === 'unit_based' && price.price_currency === subscription.currency,
    );
    return (unit?.minimum_units as number | undefined) ?? 1;
}

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
        // External ids are unique per organisation, as at Polar.
        async create(body: {
            type: 'team';
            external_id: string;
            name?: string;
            owner: { email: string; external_id: string };
            metadata: Record<string, string>;
        }) {
            polar.calls.push(`customers.create:${body.external_id}`);
            if (polar.customers.has(body.external_id))
                throw new PolarClientError(422, { error: 'HTTPValidationError' });
            const customer: FakeCustomer = {
                id: `cus_${polar.customers.size + 1}`,
                type: body.type,
                name: body.name ?? null,
                members: [body.owner.external_id],
                metadata: body.metadata,
                subscriptions: [],
            };
            polar.customers.set(body.external_id, customer);
            return { id: customer.id, type: body.type, metadata: body.metadata };
        },
        async updateExternal(externalId: string, body: { metadata?: Record<string, string> }) {
            polar.calls.push(`customers.updateExternal:${externalId}`);
            const customer = polar.customers.get(externalId);
            if (!customer) throw notFound();
            if (body.metadata) customer.metadata = body.metadata;
            return { id: customer.id, type: customer.type, metadata: customer.metadata ?? {} };
        },
        // A team customer's members, owner first; promoting one demotes the owner (spike 3).
        members: {
            async createExternal(externalId: string, body: { external_id: string; role: string }) {
                polar.calls.push(`members.createExternal:${externalId}:${body.external_id}`);
                const customer = polar.customers.get(externalId);
                if (!customer) throw notFound();
                if (customer.members?.includes(body.external_id))
                    throw new PolarClientError(409, { error: 'MemberAlreadyExists' });
                customer.members = [...(customer.members ?? []), body.external_id];
                return { external_id: body.external_id, role: body.role };
            },
            async updateExternal(externalId: string, memberId: string, body: { role?: string }) {
                polar.calls.push(`members.updateExternal:${externalId}:${memberId}:${body.role}`);
                const customer = polar.customers.get(externalId);
                if (!customer?.members?.includes(memberId)) throw notFound();
                if (body.role === 'owner')
                    customer.members = [
                        memberId,
                        ...customer.members.filter((m) => m !== memberId),
                    ];
                return { external_id: memberId, role: body.role };
            },
            async deleteExternal(externalId: string, memberId: string) {
                polar.calls.push(`members.deleteExternal:${externalId}:${memberId}`);
                const customer = polar.customers.get(externalId);
                if (!customer?.members?.includes(memberId)) throw notFound();
                customer.members = customer.members.filter((m) => m !== memberId);
            },
        },
        async getExternal(externalId: string) {
            polar.calls.push(`customers.getExternal:${externalId}`);
            const customer = polar.customers.get(externalId);
            if (!customer) throw notFound();
            return { id: customer.id, type: customer.type, metadata: customer.metadata ?? {} };
        },
    },
    // As the sandbox answered (spike E1): a team customer's session needs one of its members.
    customerSessions: {
        async create(body: { external_customer_id: string; external_member_id?: string | null }) {
            polar.calls.push(`customerSessions.create:${body.external_customer_id}`);
            polar.sessions.push(body);
            const customer = polar.customers.get(body.external_customer_id);
            if (!customer) throw notFound();
            if (customer.type === 'team') {
                if (!body.external_member_id)
                    throw new PolarClientError(422, {
                        detail: 'member_id is required for team customers.',
                    });
                if (!customer.members?.includes(body.external_member_id))
                    throw new PolarClientError(422, {
                        detail: 'Member does not exist for this customer.',
                    });
            }
            return {
                customer_portal_url: `https://polar.test/portal/${customer.id}/${body.external_member_id ?? 'self'}`,
            };
        },
    },
    discounts: {
        async create(body: { code: string; basis_points: number; duration: string }) {
            polar.calls.push(`discounts.create:${body.code}`);
            // The id is minted from the first code and never changes, however the code does.
            const id = `disc_${body.code.toLowerCase()}`;
            polar.discounts.push({ id, ...body });
            return { id, ...body };
        },
        // A code another discount already has is refused, as Polar does.
        async update(id: string, body: { code?: string } & Record<string, unknown>) {
            polar.calls.push(`discounts.update:${id}`);
            const discount = polar.discounts.find((d) => d.id === id);
            if (!discount) throw new PolarClientError(404, { error: 'ResourceNotFound' });
            if (body.code && polar.discounts.some((d) => d !== discount && d.code === body.code))
                throw new PolarClientError(422, { error: 'HTTPValidationError' });
            Object.assign(discount, body);
            return { id, ...discount };
        },
        async delete(id: string) {
            polar.calls.push(`discounts.delete:${id}`);
            const index = polar.discounts.findIndex((d) => d.id === id);
            if (index < 0) throw new PolarClientError(404, { error: 'ResourceNotFound' });
            polar.discounts.splice(index, 1);
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
    orders: {
        async list(query: { subscription_id?: string; status?: string }) {
            polar.calls.push(`orders.list:${query.subscription_id}`);
            if (polar.ordersFail) throw new PolarClientError(403, { error: 'NotPermitted' });
            return {
                items: polar.orders.filter(
                    (order) =>
                        order.subscription_id === query.subscription_id &&
                        (!query.status || order.status === query.status),
                ),
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
        /*
         * Polar's quantity rules as the sandbox showed them (spike E3, E8): a cut
         * waits for the period's end and never goes below the minimum; a raise is
         * charged at once and deletes a pending cut; a refused charge (402)
         * leaves everything as it was; a plan set to cancel refuses both (403).
         */
        async update(id: string, body: Record<string, unknown>) {
            polar.calls.push(`subscriptions.update:${id}:${JSON.stringify(body)}`);
            const subscription = polar.subscriptions.get(id);
            if (!subscription) throw notFound();
            if ('pending_update' in body && body.pending_update === null) {
                subscription.pending_update = null;
                return structuredClone(subscription);
            }
            if (typeof body.units === 'number') {
                if (subscription.cancel_at_period_end)
                    throw new PolarClientError(403, { error: 'AlreadyCanceledSubscription' });
                if (body.units < minimumUnits(subscription))
                    throw new PolarClientError(422, { error: 'BelowMinimumUnits' });
                if (body.proration_behavior === 'next_period') {
                    if (polar.cutFailures > 0) {
                        polar.cutFailures -= 1;
                        throw new PolarClientError(503, { error: 'ServiceUnavailable' });
                    }
                    const hook = polar.beforeCut;
                    polar.beforeCut = null;
                    await hook?.();
                    subscription.pending_update = {
                        units: body.units,
                        applies_at: subscription.current_period_end,
                    };
                    return structuredClone(subscription);
                }
                const raise = body.units > (subscription.units ?? 0);
                if (raise && polar.raiseLeavesOrder) {
                    subscription.units = body.units;
                    subscription.pending_update = null;
                    polar.orders.push({
                        id: `order_${polar.orders.length + 1}`,
                        subscription_id: id,
                        status: 'pending',
                        due_amount: 235,
                        created_at: new Date().toISOString(),
                    });
                }
                if (raise && polar.raiseRefusal)
                    throw new PolarClientError(402, polar.raiseRefusal);
                subscription.units = body.units;
                subscription.pending_update = null;
                return structuredClone(subscription);
            }
            if (typeof body.cancel_at_period_end === 'boolean')
                subscription.cancel_at_period_end = body.cancel_at_period_end;
            return structuredClone(subscription);
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

vi.mock('@polar-sh/sdk/2026-10', async (importOriginal) => {
    const real = await importOriginal<typeof PolarSdk>();
    return { ...real, createPolar: () => fakeClient };
});

const {
    closeDatabase,
    createTestAccount,
    createTestFamily,
    deleteTestAccount,
    resetDatabase,
    setTestMember,
    setTestUsedBytes,
} = await import('../../db/test/helpers');
const { billingRepository, authRepository, driveRepository, groupsRepository, growthRepository } =
    await import('@hushos/db');

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
    polar.sessions = [];
    polar.raiseRefusal = null;
    polar.raiseLeavesOrder = false;
    polar.cutFailures = 0;
    polar.beforeCut = null;
    polar.ordersFail = false;
    polar.orders = [];
    billing.setCutRetryQueue(undefined);
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

    test('lists the valid family plans with families on', async () => {
        const catalogue = await billing.listCatalogue();
        // The mismatched, off-bound, low-minimum, fractional and per-member products are dropped.
        expect(catalogue.families.map((family) => family.id)).toEqual([FAMILY]);
        expect(catalogue.families[0]).toMatchObject({
            prices: { usd: { base: 1500, perMember: 200 } },
            includedMembers: 6,
            maxMembers: 20,
            quotaBytes: FAMILY_POOL.toString(),
        });
        expect(catalogue.families[0]).not.toHaveProperty('archived');
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

    test('a person’s sync is rate-limited per person, and a refused one asks Polar nothing', async () => {
        const [first, second] = await Promise.all([createTestAccount(), createTestAccount()]);
        const user = (userId: string) => ({ id: userId, name: 'Test', email: 'x@hushos.test' });
        subscribe(first.userId, { id: 'sub_e' });
        for (let index = 0; index < 10; index++) await billing.sync(user(first.userId));
        polar.calls = [];
        await expect(billing.sync(user(first.userId))).rejects.toMatchObject({ status: 429 });
        expect(polar.calls).toEqual([]);
        // Someone else's budget is their own.
        await expect(billing.sync(user(second.userId))).resolves.toMatchObject({
            subscription: null,
        });
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

    test('pausing a creator takes down their page under both the slug and the code', async () => {
        const affiliate = await creator();
        await growth.updateAffiliate(affiliate.id, { active: false });
        // Polar still knows the code; the page must not fall back to it.
        expect(await growth.getOfferLanding('creator')).toBeNull();
        expect(await growth.getOfferLanding('creator25')).toBeNull();
        await growth.updateAffiliate(affiliate.id, { active: true });
        expect((await growth.getOfferLanding('creator'))?.kind).toBe('affiliate');
    });

    test('editing the code or terms changes the discount at Polar first; a refusal changes nothing here', async () => {
        const affiliate = await creator();
        const edited = await growth.updateAffiliate(affiliate.id, {
            code: 'creator30',
            percentOff: 30,
            slug: 'ada',
        });
        expect(edited).toMatchObject({
            code: 'CREATOR30',
            percentOff: 30,
            slug: 'ada',
            providerDiscountId: 'disc_creator25',
        });
        expect(polar.calls).toContain('discounts.update:disc_creator25');
        expect(polar.discounts).toEqual([
            expect.objectContaining({
                code: 'CREATOR30',
                basis_points: 3000,
                name: 'Creator (CREATOR30)',
            }),
        ]);
        // The page follows the new slug and code; the old ones are gone.
        expect((await growth.getOfferLanding('ada'))?.code).toBe('CREATOR30');
        expect((await growth.getOfferLanding('creator30'))?.kind).toBe('affiliate');
        expect(await growth.getOfferLanding('creator')).toBeNull();
        // Commission and notes are this site's alone: no call to Polar.
        polar.calls = [];
        await growth.updateAffiliate(affiliate.id, { commissionBps: 1000, notes: 'Paid monthly' });
        expect(polar.calls.filter((call) => call.startsWith('discounts.'))).toEqual([]);
        // Polar refusing the change, a code already there, leaves the affiliate as it was.
        polar.discounts.push({ code: 'TAKEN', duration: 'forever', basis_points: 1000 });
        await expect(growth.updateAffiliate(affiliate.id, { code: 'taken' })).rejects.toThrow(
            /did not accept/,
        );
        expect((await growth.listAffiliates())[0]).toMatchObject({
            code: 'CREATOR30',
            commissionBps: 1000,
            notes: 'Paid monthly',
        });
    });

    test('a handle another affiliate already uses, as slug or code, is refused', async () => {
        await creator();
        const other = await growth.createAffiliate({
            name: 'Other',
            slug: 'other',
            code: 'OTHER10',
            percentOff: 10,
            duration: 'once',
            commissionBps: 0,
        });
        await expect(growth.updateAffiliate(other.id, { slug: 'creator25' })).rejects.toThrow(
            /belongs to another/,
        );
        await expect(growth.updateAffiliate(other.id, { code: 'creator' })).rejects.toThrow(
            /belongs to another/,
        );
        expect(polar.calls.filter((call) => call.startsWith('discounts.update'))).toEqual([]);
    });

    test('removing an affiliate deletes the discount at Polar, and waits while commission is owed', async () => {
        const affiliate = await creator();
        const fan = await createTestAccount();
        await growthRepository.attributeSignup({ userId: fan.userId, code: 'CREATOR25' });
        await growthRepository.recordEarning({
            affiliateId: affiliate.id,
            orderId: 'order_1',
            userId: fan.userId,
            currency: 'usd',
            netAmount: 1000,
            commissionBps: 2000,
        });
        await expect(growth.deleteAffiliate(affiliate.id)).rejects.toThrow(/still owed/);
        expect(polar.discounts).toHaveLength(1);
        await growth.markAffiliatePaid(affiliate.id);
        await expect(growth.deleteAffiliate(affiliate.id)).resolves.toEqual({ deleted: true });
        expect(polar.calls).toContain('discounts.delete:disc_creator25');
        expect(polar.discounts).toEqual([]);
        expect(await growth.listAffiliates()).toEqual([]);
        // No page under either handle, and no discount left at Polar for the code to fall back to.
        expect(await growth.getOfferLanding('creator')).toBeNull();
        expect(await growth.getOfferLanding('creator25')).toBeNull();
        // The fan keeps their account, no longer attributed to anyone.
        expect(await growthRepository.findAffiliateForCustomer(fan.userId)).toBeNull();
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

/* ------------------------------------------------------------------------- */
/* Families                                                                   */
/* ------------------------------------------------------------------------- */

/* The priced summary a payer or `billing` holder gets; anything else fails the test. */
async function priced(pending: ReturnType<typeof billing.getGroupBilling>) {
    const summary = await pending;
    if (summary.view !== 'manage')
        throw new Error(`Expected the priced summary, got ${summary.view}.`);
    return summary;
}

const userOf = (account: { userId: string; email: string }, name = 'Test') => ({
    id: account.userId,
    name,
    email: account.email,
});

/* The subscription Polar puts on the family's team customer once its checkout completes. */
function familySubscription(groupId: string, subscription: Partial<FakeSubscription> = {}) {
    const customer = polar.customers.get(`group:${groupId}`);
    if (!customer) throw new Error('No team customer for this family.');
    const full: FakeSubscription = {
        id: `sub_${groupId.slice(0, 8)}`,
        status: 'active',
        product_id: FAMILY,
        recurring_interval: 'month',
        amount: 1500,
        currency: 'usd',
        current_period_start: new Date(Date.now() - DAY).toISOString(),
        current_period_end: new Date(Date.now() + 29 * DAY).toISOString(),
        cancel_at_period_end: false,
        ended_at: null,
        units: 6,
        pending_update: null,
        ...subscription,
    };
    customer.subscriptions = customer.subscriptions.filter((s) => s.id !== full.id).concat(full);
    polar.subscriptions.set(full.id, full);
    return full;
}

/*
 * A family on a plan, the way it gets there: the organizer (who holds
 * `billing`) checks out, Polar completes it on the team customer, and a
 * delivery for that customer is reconciled. `members` more people are active.
 */
async function familyOnPlan(options: { units?: number; members?: number } = {}) {
    const organizer = await createTestAccount();
    const others = [];
    for (let index = 0; index < (options.members ?? 0); index++)
        others.push(await createTestAccount());
    const { groupId, areaIds } = await createTestFamily({
        organizerId: organizer.userId,
        members: others.map((other) => ({ userId: other.userId, roles: ['members'] })),
        pooled: true,
    });
    const payer = userOf(organizer, 'Payer');
    await billing.startGroupCheckout(payer, groupId, { productId: FAMILY });
    const subscription = familySubscription(groupId, { units: options.units ?? 6 });
    const delivery = await signedWebhook({
        type: 'customer.state_changed',
        data: { id: 'cus_team', external_id: `group:${groupId}`, type: 'team' },
    });
    expect((await billing.handleWebhook(delivery)).status).toBe(200);
    polar.calls = [];
    return { payer, groupId, areaIds, subscription, others };
}

const raises = () => polar.calls.filter((call) => call.includes('"proration_behavior":"invoice"'));

/*
 * An operator edits the family product so the catalogue drops it (no
 * `included_members`), past the catalogue's one-minute cache. Afterwards the
 * product is put back and the cache refreshed at a later clock, so the tests
 * after see the real catalogue again.
 */
let catalogueClock = 0;
async function withFamilyProductEdited(run: () => Promise<void>) {
    const family = polar.products.find((candidate) => candidate.id === FAMILY)!;
    const metadata = { ...family.metadata };
    const clock = vi.spyOn(Date, 'now');
    // Each edit runs later than the last refresh, so the cache always expires for it.
    catalogueClock += 10 * 60_000;
    try {
        delete (family.metadata as Record<string, string>).included_members;
        clock.mockReturnValue(new Date().getTime() + catalogueClock);
        await run();
    } finally {
        family.metadata = metadata;
        clock.mockReturnValue(new Date().getTime() + catalogueClock + 5 * 60_000);
        await billing.listCatalogue();
        clock.mockRestore();
    }
}
const seatLimit = async (groupId: string) =>
    (await groupsRepository.getGroupRow(groupId))?.seatLimit ?? null;

describe('family catalogue', () => {
    test('family plans are read from decimal strings and never offered as personal plans', async () => {
        expect((await billing.listCatalogue()).plans.map((plan) => plan.name)).toEqual([
            'Pro (monthly)',
            'Max (yearly)',
        ]);
        const { payer, groupId } = await familyOnPlan();
        const summary = await priced(billing.getGroupBilling(payer, groupId));
        // The mismatched, off-bound, low-minimum, fractional and per-member products are dropped whole.
        expect(summary.plans).toEqual([
            {
                id: FAMILY,
                name: 'Family (monthly)',
                description: null,
                interval: 'month',
                prices: {
                    usd: { base: 1500, perMember: 200 },
                    eur: { base: 1500, perMember: 200 },
                },
                includedMembers: 6,
                maxMembers: 20,
                quotaBytes: FAMILY_POOL.toString(),
            },
        ]);
    });

    test('a unit amount parses only as whole minor units', () => {
        expect(billing.parseMinorUnits('200')).toBe(200);
        expect(billing.parseMinorUnits('200.000000000000')).toBe(200);
        expect(billing.parseMinorUnits('0')).toBe(0);
        expect(billing.parseMinorUnits('200.5')).toBeNull();
        expect(billing.parseMinorUnits('-200')).toBeNull();
        expect(billing.parseMinorUnits('2e2')).toBeNull();
        expect(billing.parseMinorUnits('')).toBeNull();
    });
});

describe('family quotes', () => {
    const start = new Date('2026-10-17T04:32:15Z');
    const month = new Date('2026-11-17T04:32:15Z');
    const year = new Date('2027-10-17T04:32:15Z');

    test('a raise is prorated by the second and truncated, as Polar charged it', () => {
        // Spike E3 with 4242: 200 a member, 0.99994 of the month left, charged 199.
        const monthLeft = 0.99994 * (month.getTime() - start.getTime());
        expect(
            billing.quoteUnitsChange({
                perMember: 200,
                includedMembers: 6,
                fromUnits: 6,
                toUnits: 7,
                periodStart: start,
                periodEnd: month,
                now: new Date(month.getTime() - monthLeft),
            }),
        ).toBe(199);
        // Spike E4: 2000 a member a year, 0.999994 of it left, charged 1999.
        const yearLeft = 0.999994 * (year.getTime() - start.getTime());
        expect(
            billing.quoteUnitsChange({
                perMember: 2000,
                includedMembers: 6,
                fromUnits: 6,
                toUnits: 7,
                periodStart: start,
                periodEnd: year,
                now: new Date(year.getTime() - yearLeft),
            }),
        ).toBe(1999);
    });

    test('included places are free, a cut costs nothing now, and the period bounds the charge', () => {
        const quote = (fromUnits: number, toUnits: number, now: Date) =>
            billing.quoteUnitsChange({
                perMember: 200,
                includedMembers: 6,
                fromUnits,
                toUnits,
                periodStart: start,
                periodEnd: month,
                now,
            });
        expect(quote(4, 6, start)).toBe(0);
        // From five to eight: only the two places past the included six are charged.
        expect(quote(5, 8, start)).toBe(400);
        expect(quote(8, 7, start)).toBe(0);
        expect(quote(6, 7, month)).toBe(0);
        expect(quote(6, 7, new Date(start.getTime() - DAY))).toBe(200);
        // Half the period left: 300 of 600, and a third: 66.66 floors to 66.
        expect(quote(6, 9, new Date((start.getTime() + month.getTime()) / 2))).toBe(300);
        expect(
            quote(6, 7, new Date(month.getTime() - (month.getTime() - start.getTime()) / 3)),
        ).toBe(66);
    });
});

describe('family checkout and webhooks', () => {
    test('checkout makes one team customer owned by the payer, and the plan reaches the family through a delivery', async () => {
        const organizer = await createTestAccount();
        const member = await createTestAccount();
        const { groupId, areaIds } = await createTestFamily({
            organizerId: organizer.userId,
            members: [{ userId: member.userId, roles: ['members'] }],
            pooled: true,
        });
        // A manager without `billing` cannot buy for the family.
        await expect(
            billing.startGroupCheckout(userOf(member), groupId, { productId: FAMILY }),
        ).rejects.toMatchObject({ status: 403 });
        // Past the family maximum: refused before anything is made at Polar.
        await expect(
            billing.startGroupCheckout(userOf(organizer), groupId, {
                productId: FAMILY,
                units: 21,
            }),
        ).rejects.toMatchObject({ status: 400 });
        expect(polar.calls.filter((call) => call.startsWith('customers.create'))).toEqual([]);
        await billing.startGroupCheckout(userOf(organizer), groupId, { productId: FAMILY });
        const customer = polar.customers.get(`group:${groupId}`);
        expect(customer).toMatchObject({ type: 'team', members: [organizer.userId] });
        // Polar learns nothing of the family but that it is one: not its name.
        expect(customer?.name).toBe('HushOS family');
        expect(polar.checkouts.at(-1)).toMatchObject({
            products: [FAMILY],
            customer_id: customer?.id,
            units: 6,
            min_units: 6,
            max_units: 20,
            metadata: { hushos_group_id: groupId },
        });
        expect(polar.checkouts.at(-1)).not.toHaveProperty('customer_email');
        // Another payer's family is theirs while its plan runs (and open to a billing holder once
        // it has none): see 'a new payer'.
        // Before the plan: the organizer alone, and an empty pool.
        expect(await seatLimit(groupId)).toBeNull();
        expect((await driveRepository.getStorage(areaIds[0]!))?.allowance).toBe(0n);
        familySubscription(groupId, { units: 7 });
        const delivery = await signedWebhook({
            type: 'customer.state_changed',
            data: { id: customer?.id, external_id: `group:${groupId}`, type: 'team' },
        });
        expect((await billing.handleWebhook(delivery)).status).toBe(200);
        expect(polar.calls).toContain(`customers.getStateExternal:group:${groupId}`);
        expect(await seatLimit(groupId)).toBe(7);
        expect((await driveRepository.getStorage(areaIds[0]!))?.allowance).toBe(FAMILY_POOL);
        // The family already has a plan: no second checkout.
        await expect(
            billing.startGroupCheckout(userOf(organizer), groupId, { productId: FAMILY }),
        ).rejects.toMatchObject({ status: 409 });
    });

    test('a plan Polar ended is read on its own and leaves the family with no seats or pool', async () => {
        const { groupId, areaIds, subscription } = await familyOnPlan({ units: 8 });
        subscription.status = 'canceled';
        subscription.ended_at = new Date().toISOString();
        await billing.reconcileGroup(groupId);
        expect(polar.calls).toContain(`subscriptions.get:${subscription.id}`);
        expect(await seatLimit(groupId)).toBeNull();
        expect((await driveRepository.getStorage(areaIds[0]!))?.allowance).toBe(0n);
    });

    test('a delivery for a group HushOS never billed changes nothing', async () => {
        const organizer = await createTestAccount();
        const { groupId, areaIds } = await createTestFamily({ organizerId: organizer.userId });
        await billing.handleWebhook(
            await signedWebhook({
                type: 'customer.state_changed',
                data: { id: 'cus_x', external_id: `group:${groupId}`, type: 'team' },
            }),
        );
        // No pool appears, so the area keeps its own allowance.
        expect((await driveRepository.getStorage(areaIds[0]!))?.allowance).toBe(10n * GIB);
    });
});

describe('family places', () => {
    test('a raise is capped by HushOS, since Polar caps nothing', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ units: 18 });
        await expect(billing.setGroupUnits(payer, groupId, 21)).rejects.toMatchObject({
            status: 400,
        });
        const small = await familyOnPlan({ units: 6 });
        // Six more at once is past the step; five is not.
        await expect(billing.setGroupUnits(small.payer, small.groupId, 12)).rejects.toMatchObject({
            status: 400,
        });
        expect(raises()).toEqual([]);
        expect(subscription.units).toBe(18);
        await billing.setGroupUnits(small.payer, small.groupId, 11);
        expect(small.subscription.units).toBe(11);
        expect(await seatLimit(small.groupId)).toBe(11);
        // An admission at the family maximum asks Polar for nothing either.
        await billing.setGroupUnits(payer, groupId, 20);
        for (let used = await groupsRepository.seatsUsed(groupId); used < 20; used++)
            await setTestMember({
                groupId,
                userId: (await createTestAccount()).userId,
                state: 'active',
            });
        polar.calls = [];
        expect(await billing.ensureGroupSeat(groupId, payer.id)).toMatchObject({
            status: 'cap',
            max: 20,
        });
        expect(raises()).toEqual([]);
    });

    test('an explicit raise replaces a scheduled cut: no places paid for and blocked', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ units: 8 });
        await billing.setGroupUnits(payer, groupId, 6);
        expect(subscription).toMatchObject({ units: 8, pending_update: { units: 6 } });
        // The cut blocks admissions at once.
        expect(await seatLimit(groupId)).toBe(6);
        await billing.setGroupUnits(payer, groupId, 9);
        expect(subscription).toMatchObject({ units: 9, pending_update: null });
        expect(await seatLimit(groupId)).toBe(9);
        const summary = await priced(billing.getGroupBilling(payer, groupId));
        expect(summary.subscription).toMatchObject({ units: 9, pendingUnits: null });
        expect(
            (await billingRepository.getLiveGroupSubscription(groupId))?.intendedUnits,
        ).toBeNull();
        // Nothing puts the cut back later either.
        await billing.reconcileGroup(groupId);
        expect(subscription.pending_update).toBeNull();
        // Below the members admitted, or the plan's six, a cut is refused before Polar.
        polar.calls = [];
        await expect(billing.setGroupUnits(payer, groupId, 5)).rejects.toMatchObject({
            status: 400,
        });
        expect(polar.calls.filter((call) => call.startsWith('subscriptions.update'))).toEqual([]);
    });

    test('a scheduled cut that blocks the payer’s admission moves up, free', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ units: 9, members: 5 });
        await billing.setGroupUnits(payer, groupId, 6);
        const seventh = await createTestAccount();
        await setTestMember({ groupId, userId: seventh.userId, state: 'accepted' });
        polar.calls = [];
        expect(await billing.ensureGroupSeat(groupId, payer.id)).toEqual({ status: 'ok' });
        expect(raises()).toEqual([]);
        expect(subscription).toMatchObject({ units: 9, pending_update: { units: 7 } });
        expect(await seatLimit(groupId)).toBe(7);
    });

    test('an admission that lands while a cut is scheduled moves the cut up to the members', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ units: 8, members: 5 });
        // The payer counts six members and cuts to six; a seventh is admitted before the cut lands.
        polar.beforeCut = async () =>
            setTestMember({
                groupId,
                userId: (await createTestAccount()).userId,
                state: 'active',
            });
        await billing.setGroupUnits(payer, groupId, 6);
        expect(subscription).toMatchObject({ units: 8, pending_update: { units: 7 } });
        expect(await seatLimit(groupId)).toBe(7);
        expect((await billingRepository.getLiveGroupSubscription(groupId))?.intendedUnits).toBe(7);
    });

    test('a declined raise says the bank declined it and changes nothing; a confirmation goes to the portal', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ units: 6 });
        // As the India card was refused above the RBI limit (spike E8).
        polar.raiseRefusal = {
            error: 'PaymentFailed',
            detail: 'Payment failed with reason: card_error.',
        };
        await expect(billing.setGroupUnits(payer, groupId, 7)).rejects.toMatchObject({
            status: 402,
            message: expect.stringMatching(/bank declined/),
        });
        expect(subscription.units).toBe(6);
        expect(await seatLimit(groupId)).toBe(6);
        // Nothing waits in the portal for a decline: no session is opened.
        expect(polar.sessions).toEqual([]);
        // The bank wants the payer to confirm (3-D Secure, an Indian e-mandate): the portal.
        polar.raiseRefusal = {
            error: 'PaymentActionRequired',
            detail: 'The payment requires an action.',
        };
        const confirm = await billing.setGroupUnits(payer, groupId, 7);
        expect(confirm).toMatchObject({
            confirmPayment: true,
            url: `https://polar.test/portal/${polar.customers.get(`group:${groupId}`)?.id}/${payer.id}`,
        });
        expect(subscription.units).toBe(6);
        expect(await seatLimit(groupId)).toBe(6);
    });

    test('an admission gets a place only from the payer, and only on a 200', async () => {
        const { payer, groupId, subscription, others } = await familyOnPlan({
            units: 6,
            members: 5,
        });
        const manager = others[0]!;
        // Full at six. A manager who does not pay cannot buy the seventh place.
        expect(await billing.ensureGroupSeat(groupId, manager.userId)).toEqual({
            status: 'payer',
        });
        expect(raises()).toEqual([]);
        polar.raiseRefusal = { error: 'PaymentFailed', detail: 'card_error' };
        expect(await billing.ensureGroupSeat(groupId, payer.id)).toEqual({ status: 'declined' });
        expect(subscription.units).toBe(6);
        expect(await seatLimit(groupId)).toBe(6);
        polar.raiseRefusal = { error: 'PaymentActionRequired', detail: 'action' };
        expect(await billing.ensureGroupSeat(groupId, payer.id)).toEqual({
            status: 'confirm',
            url: expect.stringContaining(payer.id),
        });
        expect(await seatLimit(groupId)).toBe(6);
        polar.raiseRefusal = null;
        expect(await billing.ensureGroupSeat(groupId, payer.id)).toEqual({ status: 'ok' });
        expect(subscription.units).toBe(7);
        expect(await seatLimit(groupId)).toBe(7);
        // A plan set to end refuses quantity changes at Polar: said so, nothing charged.
        subscription.cancel_at_period_end = true;
        await setTestMember({
            groupId,
            userId: (await createTestAccount()).userId,
            state: 'active',
        });
        polar.calls = [];
        expect(await billing.ensureGroupSeat(groupId, payer.id)).toEqual({ status: 'canceling' });
        expect(raises()).toEqual([]);
    });

    test('without a plan nobody is admitted, and nothing is asked of Polar', async () => {
        const organizer = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: organizer.userId, pooled: true });
        expect(await billing.ensureGroupSeat(groupId, organizer.userId)).toEqual({
            status: 'no-plan',
        });
        expect(polar.calls).toEqual([]);
    });
});

describe('family portal', () => {
    test('the portal opens for the payer as the team’s member, and for nobody else', async () => {
        const { payer, groupId, others } = await familyOnPlan({ members: 1 });
        const portal = await billing.createGroupPortalSession(payer, groupId);
        const customer = polar.customers.get(`group:${groupId}`);
        expect(portal.url).toBe(`https://polar.test/portal/${customer?.id}/${payer.id}`);
        expect(polar.sessions.at(-1)).toMatchObject({
            external_customer_id: `group:${groupId}`,
            external_member_id: payer.id,
        });
        // A member who manages the family but does not pay holds no `billing`: refused here.
        polar.sessions = [];
        const member = others[0]!;
        await expect(
            billing.createGroupPortalSession(userOf(member), groupId),
        ).rejects.toMatchObject({ status: 403 });
        // A second `billing` holder is still not the payer.
        await setTestMember({
            groupId,
            userId: member.userId,
            state: 'active',
            roles: ['billing', 'members'],
        });
        await expect(
            billing.createGroupPortalSession(userOf(member), groupId),
        ).rejects.toMatchObject({ status: 403 });
        expect(polar.sessions).toEqual([]);
    });

    test('a family without a billing account has no portal', async () => {
        const organizer = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: organizer.userId });
        await expect(
            billing.createGroupPortalSession(userOf(organizer), groupId),
        ).rejects.toMatchObject({ status: 404 });
        expect(polar.calls).toEqual([]);
    });
});

describe('a family’s payer', () => {
    test('cannot delete their account while the plan is live, and nothing is revoked meanwhile', async () => {
        const { payer, groupId, subscription } = await familyOnPlan();
        subscribe(payer.id, { id: 'sub_personal' });
        await billing.reconcileCustomer(payer.id);
        await expect(billing.revokeForDeletion(payer.id)).rejects.toMatchObject({ status: 409 });
        expect(polar.calls.filter((call) => call.startsWith('subscriptions.revoke'))).toEqual([]);
        subscription.status = 'canceled';
        subscription.ended_at = new Date().toISOString();
        await billing.reconcileGroup(groupId);
        await billing.revokeForDeletion(payer.id);
        expect(polar.calls).toContain('subscriptions.revoke:sub_personal');
    });
});

describe('unpaid places', () => {
    test('a raise waiting for the bank opens no place on sync; its order.paid opens it', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ units: 6, members: 5 });
        polar.raiseRefusal = { error: 'PaymentActionRequired', detail: 'Confirm the payment.' };
        polar.raiseLeavesOrder = true;
        expect(await billing.ensureGroupSeat(groupId, payer.id)).toMatchObject({
            status: 'confirm',
        });
        // Polar kept the seventh place, unpaid: a sync must not open it.
        expect(subscription.units).toBe(7);
        await billing.reconcileGroup(groupId);
        expect(await seatLimit(groupId)).toBe(6);
        expect((await priced(billing.getGroupBilling(payer, groupId))).subscription).toMatchObject({
            units: 7,
            paidUnits: 6,
        });
        // Asking again charges nothing more and still lets nobody in.
        polar.raiseRefusal = null;
        polar.raiseLeavesOrder = false;
        expect(await billing.ensureGroupSeat(groupId, payer.id)).toMatchObject({
            status: 'confirm',
        });
        expect(raises()).toHaveLength(1);
        // The payer confirms in the portal; Polar reports the order paid.
        polar.orders[0]!.status = 'paid';
        const paid = await signedWebhook({
            type: 'order.paid',
            data: {
                id: polar.orders[0]!.id,
                billing_reason: 'subscription_update',
                customer: { id: 'cus_team', external_id: `group:${groupId}` },
            },
        });
        expect((await billing.handleWebhook(paid)).status).toBe(200);
        expect(await seatLimit(groupId)).toBe(7);
        expect(await billing.ensureGroupSeat(groupId, payer.id)).toEqual({ status: 'ok' });
        expect(raises()).toHaveLength(1);
    });

    test('a raise answered 200 whose order still waits opens nothing either', async () => {
        const { payer, groupId } = await familyOnPlan({ units: 6, members: 5 });
        polar.raiseLeavesOrder = true;
        expect(await billing.ensureGroupSeat(groupId, payer.id)).toMatchObject({
            status: 'confirm',
        });
        expect(await seatLimit(groupId)).toBe(6);
    });
});

describe('cuts Polar lost', () => {
    test('a recorded cut Polar lost is re-issued by reconcile; a refusal is queued and the retry puts it back', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ units: 8 });
        const queued: string[] = [];
        billing.setCutRetryQueue(async (id) => {
            queued.push(id);
        });
        await billing.setGroupUnits(payer, groupId, 6);
        // Polar drops the cut on its own, and refuses it back once.
        subscription.pending_update = null;
        polar.cutFailures = 1;
        await billing.reconcileGroup(groupId);
        expect(subscription.pending_update).toBeNull();
        expect(queued).toEqual([groupId]);
        expect((await billingRepository.getLiveGroupSubscription(groupId))?.intendedUnits).toBe(6);
        // The job's first run meets Polar failing again and throws, so pg-boss retries it.
        polar.cutFailures = 1;
        await expect(billing.reissueCut(groupId)).rejects.toBeInstanceOf(PolarClientError);
        expect(subscription.pending_update).toBeNull();
        await billing.reissueCut(groupId);
        expect(subscription).toMatchObject({ units: 8, pending_update: { units: 6 } });
        expect(await seatLimit(groupId)).toBe(6);
        // Run again (a duplicate job), it asks Polar for nothing.
        polar.calls = [];
        await billing.reissueCut(groupId);
        expect(polar.calls.filter((call) => call.startsWith('subscriptions.update'))).toEqual([]);
    });

    test('the daily reconcile re-issues a recorded cut, never below the members, and forgets it once it applied', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ units: 9, members: 5 });
        await billing.setGroupUnits(payer, groupId, 6);
        subscription.pending_update = null;
        // A seventh member arrived since, and arrives again while the cut is re-issued.
        await setTestMember({
            groupId,
            userId: (await createTestAccount()).userId,
            state: 'active',
        });
        polar.beforeCut = async () =>
            setTestMember({
                groupId,
                userId: (await createTestAccount()).userId,
                state: 'active',
            });
        await billing.reconcileGroup(groupId);
        expect(subscription).toMatchObject({ units: 9, pending_update: { units: 8 } });
        // The period renews at eight: nothing is due any more.
        subscription.units = 8;
        subscription.pending_update = null;
        await billing.reconcileGroup(groupId);
        expect(
            (await billingRepository.getLiveGroupSubscription(groupId))?.intendedUnits,
        ).toBeNull();
        expect(subscription.pending_update).toBeNull();
    });
});

describe('review fixes', () => {
    test('a raise whose orders cannot be read opens no place', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ units: 6, members: 5 });
        polar.ordersFail = true;
        expect(await billing.ensureGroupSeat(groupId, payer.id)).toMatchObject({
            status: 'confirm',
        });
        expect(subscription.units).toBe(7);
        expect(await seatLimit(groupId)).toBe(6);
    });

    test('a raise left unconfirmed past seven days is cut back to the places paid for', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ units: 6, members: 5 });
        polar.raiseRefusal = { error: 'PaymentActionRequired', detail: 'Confirm the payment.' };
        polar.raiseLeavesOrder = true;
        await billing.ensureGroupSeat(groupId, payer.id);
        expect(subscription.units).toBe(7);
        // Six days: the payer may still answer their bank.
        polar.orders[0]!.created_at = new Date(Date.now() - 6 * DAY).toISOString();
        await billing.reconcileGroup(groupId);
        expect(subscription.pending_update).toBeNull();
        polar.orders[0]!.created_at = new Date(Date.now() - 8 * DAY).toISOString();
        await billing.reconcileGroup(groupId);
        expect(subscription).toMatchObject({ units: 7, pending_update: { units: 6 } });
        expect(await seatLimit(groupId)).toBe(6);
        // Day nine: the payer answers their bank and the order is paid. The cut is withdrawn,
        // and nothing re-issues it.
        polar.orders[0]!.status = 'paid';
        polar.calls = [];
        await billing.reconcileGroup(groupId);
        expect(subscription).toMatchObject({ units: 7, pending_update: null });
        expect(await seatLimit(groupId)).toBe(7);
        expect(await billingRepository.getLiveGroupSubscription(groupId)).toMatchObject({
            paidUnits: 7,
            intendedUnits: null,
            intendedStale: false,
        });
        expect(polar.calls.filter((call) => call.includes('next_period'))).toEqual([]);
        await billing.reconcileGroup(groupId);
        expect(subscription.pending_update).toBeNull();
    });

    test('a payer’s own cut is not withdrawn when a raise is paid', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ units: 9, members: 5 });
        await billing.setGroupUnits(payer, groupId, 7);
        await billing.reconcileGroup(groupId);
        expect(subscription.pending_update).toEqual(expect.objectContaining({ units: 7 }));
        expect((await billingRepository.getLiveGroupSubscription(groupId))?.intendedStale).toBe(
            false,
        );
    });

    test('a plan whose product an operator edited out of the catalogue is never swept as ended', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ units: 8 });
        await withFamilyProductEdited(async () => {
            await billing.reconcileGroup(groupId);
        });
        const live = await billingRepository.getLiveGroupSubscription(groupId);
        expect(live).toMatchObject({ id: subscription.id, status: 'active', endedAt: null });
        expect(await seatLimit(groupId)).toBe(8);
        expect(await billingRepository.listGroupsPaidBy(payer.id)).toEqual([groupId]);
        await expect(billing.revokeForDeletion(payer.id)).rejects.toMatchObject({ status: 409 });
    });

    test('a cut on a plan HushOS cannot read is refused, and Polar is not asked', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ units: 8 });
        await withFamilyProductEdited(async () => {
            polar.calls = [];
            await expect(billing.setGroupUnits(payer, groupId, 6)).rejects.toMatchObject({
                status: 503,
            });
        });
        expect(polar.calls.filter((call) => call.startsWith('subscriptions.update'))).toEqual([]);
        expect(subscription.pending_update).toBeNull();
    });

    test('a former payer can still open the portal and pay for less, but not for more', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ units: 8 });
        await setTestMember({ groupId, userId: payer.id, state: 'left' });
        expect((await billing.createGroupPortalSession(payer, groupId)).url).toContain(payer.id);
        await billing.setGroupUnits(payer, groupId, 6);
        expect(subscription.pending_update).toEqual(expect.objectContaining({ units: 6 }));
        await expect(billing.setGroupUnits(payer, groupId, 9)).rejects.toMatchObject({
            status: 404,
        });
        expect(subscription.units).toBe(8);
    });

    test('a checkout is refused while Polar holds a plan HushOS has not seen yet', async () => {
        const organizer = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: organizer.userId, pooled: true });
        await billing.startGroupCheckout(userOf(organizer), groupId, { productId: FAMILY });
        familySubscription(groupId, { units: 7 });
        polar.checkouts = [];
        await expect(
            billing.startGroupCheckout(userOf(organizer), groupId, { productId: FAMILY }),
        ).rejects.toMatchObject({ status: 409 });
        expect(polar.checkouts).toEqual([]);
        // The plan it found reached the family.
        expect(await seatLimit(groupId)).toBe(7);
    });

    test('a family’s sync is rate-limited per person', async () => {
        const { payer, groupId } = await familyOnPlan();
        for (let index = 0; index < 10; index++) await billing.syncGroup(payer, groupId);
        await expect(billing.syncGroup(payer, groupId)).rejects.toMatchObject({ status: 429 });
    });
});

describe('family summary', () => {
    test('a member without billing, a manager included, sees the plan’s name and the pool, nothing priced, and can’t refresh it', async () => {
        const { payer, groupId, areaIds, subscription, others } = await familyOnPlan({
            units: 7,
            members: 1,
        });
        const member = await createTestAccount();
        await setTestMember({ groupId, userId: member.userId, state: 'active' });
        await setTestUsedBytes(areaIds[0]!, 300n * GIB);
        const glance = {
            enabled: true,
            view: 'member',
            hasPlan: true,
            planName: 'Family (monthly)',
            storage: { usedBytes: (300n * GIB).toString(), quotaBytes: FAMILY_POOL.toString() },
        };
        // Exactly these fields: no product, places, payer, status or amounts.
        expect(await billing.getGroupBilling(userOf(member), groupId)).toEqual(glance);
        // A manager without `billing` (familyOnPlan's others hold `members`) gets the same.
        expect(await billing.getGroupBilling(userOf(others[0]!), groupId)).toEqual(glance);
        for (const who of [member, others[0]!])
            await expect(billing.syncGroup(userOf(who), groupId)).rejects.toMatchObject({
                status: 403,
            });
        // The payer gets the amounts, and the period a raise is prorated over.
        const full = await priced(billing.getGroupBilling(payer, groupId));
        expect(full.subscription).toMatchObject({
            amount: 1500,
            currency: 'usd',
            currentPeriodStart: subscription.current_period_start,
        });
        expect(full.plans.length).toBeGreaterThan(0);
        // Someone outside the family learns nothing of it.
        const outsider = await createTestAccount();
        await expect(billing.getGroupBilling(userOf(outsider), groupId)).rejects.toMatchObject({
            status: 404,
        });
        // Nor does someone who only accepted an invitation.
        const waiting = await createTestAccount();
        await setTestMember({ groupId, userId: waiting.userId, state: 'accepted' });
        await expect(billing.getGroupBilling(userOf(waiting), groupId)).rejects.toMatchObject({
            status: 404,
        });
    });

    test('the pool counts every family folder, and a plan that ended is named with its end', async () => {
        const organizer = await createTestAccount();
        const { groupId, areaIds } = await createTestFamily({
            organizerId: organizer.userId,
            areas: 2,
            pooled: true,
        });
        const before = await priced(billing.getGroupBilling(userOf(organizer), groupId));
        // Never paid: nothing ended, so it is a family still choosing, not a lapsed one.
        expect(before).toMatchObject({ subscription: null, lastPlan: null });
        await billing.startGroupCheckout(userOf(organizer), groupId, { productId: FAMILY });
        const subscription = familySubscription(groupId, { units: 6 });
        await billing.reconcileGroup(groupId);
        await setTestUsedBytes(areaIds[0]!, 5n * GIB);
        await setTestUsedBytes(areaIds[1]!, 7n * GIB);
        expect((await billing.getGroupBilling(userOf(organizer), groupId)).storage).toEqual({
            usedBytes: (12n * GIB).toString(),
            quotaBytes: FAMILY_POOL.toString(),
        });
        subscription.status = 'canceled';
        subscription.ended_at = new Date().toISOString();
        await billing.reconcileGroup(groupId);
        const after = await priced(billing.getGroupBilling(userOf(organizer), groupId));
        expect(after.subscription).toBeNull();
        expect(after.lastPlan?.productName).toBe('Family (monthly)');
        expect(Date.parse(after.lastPlan!.endedAt)).toBeGreaterThan(Date.now() - 60_000);
        // The files stay; the pool they count against is gone until a plan returns.
        expect(after.storage).toEqual({ usedBytes: (12n * GIB).toString(), quotaBytes: '0' });
    });

    test('a family made before plans were sold has no pool until a plan, and none left once it ends', async () => {
        const organizer = await createTestAccount();
        // No group_storage row: its folder keeps its own 10 GB, as before billing.
        const { groupId, areaIds } = await createTestFamily({ organizerId: organizer.userId });
        expect(
            (await priced(billing.getGroupBilling(userOf(organizer), groupId))).storage,
        ).toBeNull();
        expect((await driveRepository.getStorage(areaIds[0]!))?.allowance).toBe(10n * GIB);
        await billing.startGroupCheckout(userOf(organizer), groupId, { productId: FAMILY });
        const subscription = familySubscription(groupId, { units: 6 });
        await billing.reconcileGroup(groupId);
        expect((await driveRepository.getStorage(areaIds[0]!))?.allowance).toBe(FAMILY_POOL);
        subscription.status = 'canceled';
        subscription.ended_at = new Date().toISOString();
        await billing.reconcileGroup(groupId);
        // Lapsed: the pool row stays at zero, so the old per-folder allowance never comes back.
        expect((await driveRepository.getStorage(areaIds[0]!))?.allowance).toBe(0n);
        expect((await priced(billing.getGroupBilling(userOf(organizer), groupId))).storage).toEqual(
            {
                usedBytes: '0',
                quotaBytes: '0',
            },
        );
    });
});

describe('a new payer', () => {
    test('once the plan has ended, another billing holder checks out and becomes the payer, at Polar too', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ units: 6 });
        const heir = await createTestAccount();
        await setTestMember({ groupId, userId: heir.userId, state: 'active', roles: ['billing'] });
        // While the plan runs, the payer stays the payer.
        await expect(
            billing.startGroupCheckout(userOf(heir), groupId, { productId: FAMILY }),
        ).rejects.toMatchObject({ status: 409 });
        subscription.status = 'canceled';
        subscription.ended_at = new Date().toISOString();
        await billing.reconcileGroup(groupId);
        polar.calls = [];
        await billing.startGroupCheckout(userOf(heir), groupId, { productId: FAMILY });
        const customer = polar.customers.get(`group:${groupId}`)!;
        // The heir is the owner, and the former payer is off the customer.
        expect(customer.members).toEqual([heir.userId]);
        expect(customer.metadata?.hushos_payer).toBe(heir.userId);
        expect((await billingRepository.getGroupCustomer(groupId))?.payerUserId).toBe(heir.userId);
        expect(polar.checkouts.at(-1)).toMatchObject({ customer_id: customer.id });
        // The family's billing page names the new payer to both of them.
        expect((await priced(billing.getGroupBilling(userOf(heir), groupId))).payer).toEqual({
            userId: heir.userId,
            you: true,
        });
        // The former payer has no portal into it now.
        await expect(billing.createGroupPortalSession(payer, groupId)).rejects.toMatchObject({
            status: 403,
        });
    });

    test('an abandoned checkout doesn’t lock the family to whoever started it', async () => {
        const organizer = await createTestAccount();
        const heir = await createTestAccount();
        const { groupId } = await createTestFamily({
            organizerId: organizer.userId,
            members: [{ userId: heir.userId, roles: ['billing'] }],
            pooled: true,
        });
        await billing.startGroupCheckout(userOf(organizer), groupId, { productId: FAMILY });
        await billing.startGroupCheckout(userOf(heir), groupId, { productId: FAMILY });
        expect((await billingRepository.getGroupCustomer(groupId))?.payerUserId).toBe(heir.userId);
        // Someone without `billing` never takes it over.
        const plain = await createTestAccount();
        await setTestMember({ groupId, userId: plain.userId, state: 'active', roles: ['members'] });
        await expect(
            billing.startGroupCheckout(userOf(plain), groupId, { productId: FAMILY }),
        ).rejects.toMatchObject({ status: 403 });
        expect((await billingRepository.getGroupCustomer(groupId))?.payerUserId).toBe(heir.userId);
    });

    test('a plan Polar has that HushOS hasn’t heard of yet still keeps its payer', async () => {
        const organizer = await createTestAccount();
        const heir = await createTestAccount();
        const { groupId } = await createTestFamily({
            organizerId: organizer.userId,
            members: [{ userId: heir.userId, roles: ['billing'] }],
            pooled: true,
        });
        await billing.startGroupCheckout(userOf(organizer), groupId, { productId: FAMILY });
        // Paid at Polar; the delivery hasn't arrived.
        familySubscription(groupId, { units: 6 });
        await expect(
            billing.startGroupCheckout(userOf(heir), groupId, { productId: FAMILY }),
        ).rejects.toMatchObject({ status: 409 });
        expect(polar.customers.get(`group:${groupId}`)!.members).toEqual([organizer.userId]);
        expect((await billingRepository.getGroupCustomer(groupId))?.payerUserId).toBe(
            organizer.userId,
        );
    });
});

describe('cancelling and payers', () => {
    test('a cancelled plan frees its payer; the family keeps its places and pool until it ends', async () => {
        const { payer, groupId, areaIds, subscription } = await familyOnPlan({ units: 7 });
        expect(await billingRepository.listGroupsPaidBy(payer.id)).toEqual([groupId]);
        subscription.cancel_at_period_end = true;
        await billing.reconcileGroup(groupId);
        expect(await billingRepository.listGroupsPaidBy(payer.id)).toEqual([]);
        await expect(billing.revokeForDeletion(payer.id)).resolves.toBeUndefined();
        expect(await seatLimit(groupId)).toBe(7);
        expect((await driveRepository.getStorage(areaIds[0]!))?.allowance).toBe(FAMILY_POOL);
    });

    test('a live plan whose payer’s account is gone is revoked at once; one set to end runs out', async () => {
        const { payer, groupId, areaIds, subscription } = await familyOnPlan({ units: 7 });
        await deleteTestAccount(payer.id);
        const delivery = await signedWebhook({
            type: 'customer.state_changed',
            data: { id: 'cus_team', external_id: `group:${groupId}`, type: 'team' },
        });
        expect((await billing.handleWebhook(delivery)).status).toBe(200);
        expect(polar.calls).toContain(`subscriptions.revoke:${subscription.id}`);
        expect(await billingRepository.getLiveGroupSubscription(groupId)).toBeNull();
        expect(await seatLimit(groupId)).toBeNull();
        expect((await driveRepository.getStorage(areaIds[0]!))?.allowance).toBe(0n);

        const ending = await familyOnPlan({ units: 7 });
        ending.subscription.cancel_at_period_end = true;
        await billing.reconcileGroup(ending.groupId);
        await deleteTestAccount(ending.payer.id);
        polar.calls = [];
        await billing.reconcileGroup(ending.groupId);
        expect(polar.calls.filter((call) => call.startsWith('subscriptions.revoke'))).toEqual([]);
        expect(await seatLimit(ending.groupId)).toBe(7);
    });

    test('a former payer sees the plan only while it is live', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ units: 7 });
        await setTestMember({ groupId, userId: payer.id, state: 'left' });
        await expect(billing.getGroupBilling(payer, groupId)).resolves.toMatchObject({
            enabled: true,
        });
        subscription.status = 'canceled';
        subscription.ended_at = new Date().toISOString();
        await billing.reconcileGroup(groupId);
        await expect(billing.getGroupBilling(payer, groupId)).rejects.toMatchObject({
            status: 404,
        });
    });
});
