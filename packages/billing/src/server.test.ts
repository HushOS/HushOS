import type * as PolarSdk from '@polar-sh/sdk/2026-10';
import type { EndPersonalPlanJob } from './endings';
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
/* The three tiers (owner, 2026-10-18): four included, then 1.50 a member, the same on each. */
const PLUS = 'b1111111-aaaa-4aaa-8aaa-b11111111111';
const PRO_FAMILY = 'b2222222-aaaa-4aaa-8aaa-b22222222222';
const MAX_FAMILY = 'b3333333-aaaa-4aaa-8aaa-b33333333333';
const PRO_YEARLY = 'b4444444-aaaa-4aaa-8aaa-b44444444444';
const PLUS_POOL = 800n * GIB;
const MAX_POOL = 4096n * GIB;

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
    pending_update?: {
        units: number | null;
        product_id?: string | null;
        applies_at: string;
    } | null;
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
        product(MAX, 'Max (yearly)', 'year', { usd: 14400 }, 1024n * GIB),
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
        // The tiers, listed out of order: the catalogue orders them by pool.
        tierProduct(MAX_FAMILY, 'Family Max (monthly)', 'max', MAX_POOL, {
            usd: 3000,
            eur: 3000,
            gbp: 2400,
            inr: 139900,
        }),
        tierProduct(PLUS, 'Family Plus (monthly)', 'plus', PLUS_POOL, {
            usd: 1000,
            eur: 1000,
            gbp: 800,
            inr: 39900,
        }),
        tierProduct(
            PRO_FAMILY,
            'Family Pro (monthly)',
            'pro',
            FAMILY_POOL,
            { usd: 2000, eur: 2000, gbp: 1600, inr: 79900 },
            { hushos_recommended: 'true' },
        ),
        tierProduct(
            PRO_YEARLY,
            'Family Pro (yearly)',
            'pro',
            FAMILY_POOL,
            { usd: 19200, eur: 19200, gbp: 14400, inr: 780000 },
            { hushos_recommended: 'true' },
            'year',
        ),
        // A tier key HushOS doesn't know: not offered, whatever else it gets right.
        tierProduct(
            'b5555555-aaaa-4aaa-8aaa-b55555555555',
            'Family Mega (monthly)',
            'mega',
            8192n * GIB,
            { usd: 5000 },
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
    /* Runs once as Polar takes the next product change: an admission landing mid-flight. */
    beforeProductChange: null as (() => Promise<void>) | null,
    /* Runs once as Polar takes the next raise: an upgrade landing mid-flight. */
    beforeRaise: null as (() => Promise<void>) | null,
    /* Runs once just after the next subscription read: a change landing behind it. */
    afterGet: null as (() => void) | null,
    /*
     * A Polar that answers 200 to a scheduled product change and keeps none of it: a
     * pending update HushOS can never see settle, to prove re-issues don't repeat.
     */
    ignoresMoves: false,
    orders: [] as {
        id: string;
        subscription_id: string;
        status: string;
        due_amount: number;
        created_at: string;
        /* The plan the order bills: a raise's is the product it was made on (spike 8). */
        product_id?: string | null;
        billing_reason?: string;
        refunded_amount?: number;
        net_amount?: number;
        /* Sales tax on top of `net_amount`; never part of what HushOS refunds. */
        tax_amount?: number;
        /* Customer balance Polar applied: negative when a credit paid part of the order. */
        applied_balance_amount?: number;
        currency?: string;
        units?: number;
        /* Made, but not listed yet (Polar's listing lagging the change). */
        hidden?: boolean;
    }[],
    /* Refunds Polar holds, as its refunds API lists them. */
    refunds: [] as {
        id: string;
        order_id: string;
        amount: number;
        status: 'pending' | 'succeeded' | 'failed' | 'canceled';
        metadata: Record<string, string | number | boolean>;
        created_at: string;
        comment?: string | null;
    }[],
    /* How many refund calls fail (503) before Polar takes one again. */
    refundFailures: 0,
    /* How many refund calls Polar refuses outright (422) before it takes one. */
    refundRefusals: 0,
    /*
     * The next refund call times out and Polar makes nothing yet; it makes it later, when the
     * test calls `lateRefund` (Polar committing a timed-out request after the fact).
     */
    refundLandsLate: false,
    lateRefund: null as (() => void) | null,
    /* The next refund call is made at Polar but its answer is lost (a timeout). */
    refundAnswerLost: false,
    /*
     * The next refund call errors after the card was refunded, and Polar records that
     * refund without the metadata HushOS sent (a refund it learned of from Stripe).
     */
    refundErrorsAfterStripe: false,
    /* Run once right after the next refund is made at Polar. */
    afterRefundCreate: null as null | (() => Promise<void>),
    /* Each refunds call waits this long, so two runs can interleave. */
    refundLatencyMs: 0,
    /* Awaited once inside the next refunds listing: a run that stalls there. */
    onRefundList: null as (() => Promise<void>) | null,
    /*
     * Orders older than this many days can't be refunded: Stripe refuses the charge and Polar
     * re-raises it, which reaches HushOS as a 500. Neither documents such a window for cards;
     * this is how the fake stands for one.
     */
    refundWindowDays: null as number | null,
    /* Orders Polar refuses a refund on, by its error name (RefundsBlocked, RefundDisputedPayment). */
    refusedOrders: new Map<string, string>(),
    /* Orders Polar says are refunded whole, though their refunds don't list it (a lagging listing). */
    refundedAlreadyOrders: new Set<string>(),
    /* The status Polar gives a new refund. */
    refundStatus: 'succeeded' as 'pending' | 'succeeded' | 'failed',
    /* The refunds API can't be read (a token without `refunds:read`). */
    refundsUnreadable: false,
    /* When Polar's clock says a revoke happened; now if null. */
    revokeAt: null as string | null,
    /* The next revoke is made at Polar but its answer is lost (a timeout). */
    revokeAnswerLost: false,
    /* The next revoke times out before Polar makes it: nothing changes there. */
    revokeTimesOut: false,
    /* Revokes Polar refuses for a subscription, by its id (status and error name). */
    revokeRefusals: new Map<string, { status: number; error: string }>(),
    /* How many revokes fail (503, nothing changed) before Polar takes one. */
    revokeFailures: 0,
    /* Setting a plan to end (or not) fails this many times with a 503 first. */
    cancelFailures: 0,
    /* Run inside the next call that sets a plan to end, before Polar keeps it. */
    beforeCancel: null as null | (() => Promise<void>),
    /*
     * Setting a plan to end is answered with this status and error name while set: 403
     * `InactiveSubscription` (a past-due plan), 409 `SubscriptionLocked` (a renewal under way).
     */
    cancelRefusal: null as null | { status: number; error: string },
    /* The next set-to-end is kept at Polar but its answer is lost (a timeout). */
    cancelAnswerLost: false,
    /* Every customer-state and subscription call is refused with a 401 (a revoked token). */
    unauthorized: false,
    /* The next product change's order is made but not listed yet. */
    ordersLag: false,
    /* Each family subscription's checkout order (kept apart so tests can index `orders`). */
    checkoutOrders: [] as {
        id: string;
        subscription_id: string;
        status: string;
        due_amount: number;
        created_at: string;
        product_id: string;
        billing_reason: string;
        refunded_amount?: number;
        net_amount?: number;
        hidden?: boolean;
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

/*
 * A family tier as seed.ts makes it: four included, then 150 a member (1.50
 * USD, EUR; 1.20 GBP; 59 INR), ten times that on a yearly product, whose base
 * is passed at its own yearly price.
 */
function tierProduct(
    id: string,
    name: string,
    tier: string,
    pool: bigint,
    base: Record<string, number>,
    extra: Record<string, string> = {},
    interval: 'month' | 'year' = 'month',
) {
    const perMember: Record<string, number> = { usd: 150, eur: 150, gbp: 120, inr: 5900 };
    const factor = interval === 'year' ? 10 : 1;
    const made = familyProduct(
        id,
        name,
        Object.fromEntries(
            Object.entries(base).map(([currency, amount]) => [
                currency,
                { base: amount, perMember: String(perMember[currency]! * factor), bound: 4 },
            ]),
        ),
        { hushos_tier: tier, included_members: '4', quota_bytes: pool.toString(), ...extra },
    );
    return { ...made, recurring_interval: interval };
}

/* What a family pays a period on `productId` at `units` places, in `currency`, as Polar bills it. */
function planAmount(productId: string, units: number, currency: string) {
    const found = polar.products.find((candidate) => candidate.id === productId);
    const prices = (found?.prices ?? []) as Record<string, unknown>[];
    const base = prices.find(
        (price) => price.amount_type === 'fixed' && price.price_currency === currency,
    )?.price_amount as number;
    const unit = prices.find(
        (price) => price.amount_type === 'unit_based' && price.price_currency === currency,
    ) as { tiers: { tiers: { bound: number | null; unit_amount: string }[] } } | undefined;
    const [free, paid] = unit?.tiers.tiers ?? [];
    return base + Number(paid?.unit_amount ?? 0) * Math.max(0, units - (free?.bound ?? 0));
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
            if (polar.unauthorized) throw new PolarClientError(401, { error: 'Unauthorized' });
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
        async list(query: {
            subscription_id?: string;
            external_customer_id?: string;
            status?: string;
            product_id?: string;
            created_after?: string;
        }) {
            polar.calls.push(
                `orders.list:${query.subscription_id ?? `customer:${query.external_customer_id}`}`,
            );
            if (polar.ordersFail) throw new PolarClientError(403, { error: 'NotPermitted' });
            // A customer's orders: every one of its subscriptions', ended ones included.
            const ofCustomer = query.external_customer_id
                ? new Set(
                      [...polar.orders, ...polar.checkoutOrders]
                          .map((order) => order.subscription_id)
                          .filter((id) =>
                              (
                                  polar.customers.get(query.external_customer_id!)?.subscriptions ??
                                  []
                              )
                                  .map((sub) => sub.id)
                                  .includes(id),
                          ),
                  )
                : null;
            return {
                // Listed in no particular order: HushOS must sort.
                items: [...polar.checkoutOrders, ...polar.orders]
                    .filter(
                        (order) =>
                            !order.hidden &&
                            (ofCustomer
                                ? ofCustomer.has(order.subscription_id)
                                : order.subscription_id === query.subscription_id) &&
                            (!query.status || order.status === query.status) &&
                            // `created_after` is taken loosely here: HushOS checks dates itself.
                            (!query.product_id || order.product_id === query.product_id),
                    )
                    // As Polar keeps them: a refunded order stays paid, with its refunds counted;
                    // one refunded whole is marked so. `net_amount` is what it charged.
                    .map((order) => ({
                        billing_reason: 'subscription_update',
                        refunded_amount: 0,
                        net_amount: order.status === 'pending' ? order.due_amount : 1000,
                        // Polar adds sales tax on top of net; HushOS must never refund it.
                        tax_amount: order.status === 'pending' ? 0 : 180,
                        currency: 'usd',
                        ...order,
                        paid: ['paid', 'partially_refunded', 'refunded'].includes(order.status),
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
        // A customer's subscriptions, ended ones included, as Polar lists them.
        // One page, as Polar's SDK answers it: 100 at most.
        async list(query: { external_customer_id?: string }) {
            polar.calls.push(`subscriptions.list:${query.external_customer_id}`);
            const customer = query.external_customer_id
                ? polar.customers.get(query.external_customer_id)
                : undefined;
            const all = customer?.subscriptions ?? [];
            return {
                items: all.slice(0, 100).map((sub) => structuredClone(sub)),
                pagination: { total_count: all.length, max_page: Math.ceil(all.length / 100) },
            };
        },
        // Every page.
        async *iterList(query: { external_customer_id?: string }) {
            polar.calls.push(`subscriptions.list:${query.external_customer_id}`);
            const customer = query.external_customer_id
                ? polar.customers.get(query.external_customer_id)
                : undefined;
            for (const sub of customer?.subscriptions ?? []) yield structuredClone(sub);
        },
        async get(id: string) {
            polar.calls.push(`subscriptions.get:${id}`);
            if (polar.unauthorized) throw new PolarClientError(401, { error: 'Unauthorized' });
            const subscription = polar.subscriptions.get(id);
            if (!subscription) throw notFound();
            // A copy, as an API answer is: later changes at Polar don't reach it.
            const answer = structuredClone(subscription);
            const hook = polar.afterGet;
            polar.afterGet = null;
            hook?.();
            return answer;
        },
        /*
         * Polar's quantity rules as the sandbox showed them (spike E3, E8): a cut
         * waits for the period's end and never goes below the minimum; a raise is
         * charged at once and deletes a pending cut; a refused charge (402)
         * leaves everything as it was; a plan set to cancel refuses both (403).
         */
        async update(id: string, body: Record<string, unknown>) {
            polar.calls.push(`subscriptions.update:${id}:${JSON.stringify(body)}`);
            if (polar.unauthorized) throw new PolarClientError(401, { error: 'Unauthorized' });
            const subscription = polar.subscriptions.get(id);
            if (!subscription) throw notFound();
            if ('pending_update' in body && body.pending_update === null) {
                subscription.pending_update = null;
                return structuredClone(subscription);
            }
            // Spike 8, T1: a product change and units in one call are refused.
            if (typeof body.product_id === 'string' && typeof body.units === 'number')
                throw new PolarClientError(422, { error: 'HTTPValidationError' });
            // A product change keeps `units` (unit to unit, spike 1); a plan set to end refuses it.
            if (typeof body.product_id === 'string') {
                if (subscription.cancel_at_period_end)
                    throw new PolarClientError(403, { error: 'AlreadyCanceledSubscription' });
                const hook = polar.beforeProductChange;
                polar.beforeProductChange = null;
                polar.beforeRaise = null;
                polar.afterGet = null;
                await hook?.();
                // T1: a scheduled change overwrites only its own part of the pending update.
                if (body.proration_behavior === 'next_period') {
                    if (polar.ignoresMoves) return structuredClone(subscription);
                    subscription.pending_update = {
                        units: subscription.pending_update?.units ?? null,
                        product_id: body.product_id,
                        applies_at: subscription.current_period_end,
                    };
                    return structuredClone(subscription);
                }
                // A refused charge changes nothing (T2, 0341), unless the change is kept with
                // its order waiting (raiseLeavesOrder), the case the sandbox never showed.
                if (polar.raiseRefusal && !polar.raiseLeavesOrder)
                    throw new PolarClientError(402, polar.raiseRefusal);
                // Every immediate change is its own `subscription_update` order, charged at once,
                // or left waiting.
                polar.orders.push({
                    id: `order_${polar.orders.length + 1}`,
                    subscription_id: id,
                    status: polar.raiseLeavesOrder ? 'pending' : 'paid',
                    due_amount: polar.raiseLeavesOrder ? 1000 : 0,
                    created_at: new Date().toISOString(),
                    product_id: body.product_id,
                    billing_reason: 'subscription_update',
                    hidden: polar.ordersLag,
                });
                // T1: an immediate product change drops the whole pending update.
                subscription.product_id = body.product_id;
                subscription.amount = planAmount(
                    body.product_id,
                    subscription.units ?? 0,
                    subscription.currency,
                );
                subscription.pending_update = null;
                if (polar.raiseRefusal) throw new PolarClientError(402, polar.raiseRefusal);
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
                        product_id: subscription.pending_update?.product_id ?? null,
                        applies_at: subscription.current_period_end,
                    };
                    return structuredClone(subscription);
                }
                const raise = body.units > (subscription.units ?? 0);
                if (raise) {
                    const hook = polar.beforeRaise;
                    polar.beforeRaise = null;
                    await hook?.();
                }
                // T1: an immediate raise drops only the pending units; a scheduled move survives.
                const dropUnits = () => {
                    const product = subscription.pending_update?.product_id ?? null;
                    subscription.pending_update = product
                        ? {
                              units: null,
                              product_id: product,
                              applies_at: subscription.current_period_end,
                          }
                        : null;
                };
                if (raise && polar.raiseLeavesOrder) {
                    subscription.units = body.units;
                    dropUnits();
                    polar.orders.push({
                        id: `order_${polar.orders.length + 1}`,
                        subscription_id: id,
                        status: 'pending',
                        due_amount: 235,
                        created_at: new Date().toISOString(),
                        product_id: subscription.product_id,
                        billing_reason: 'subscription_update',
                    });
                }
                if (raise && polar.raiseRefusal)
                    throw new PolarClientError(402, polar.raiseRefusal);
                subscription.units = body.units;
                dropUnits();
                return structuredClone(subscription);
            }
            if (typeof body.cancel_at_period_end === 'boolean') {
                if (polar.cancelFailures > 0) {
                    polar.cancelFailures -= 1;
                    throw new PolarClientError(503, { error: 'ServiceUnavailable' });
                }
                if (polar.cancelRefusal)
                    throw new PolarClientError(polar.cancelRefusal.status, {
                        error: polar.cancelRefusal.error,
                        detail: 'Refused.',
                    });
                const hook = polar.beforeCancel;
                polar.beforeCancel = null;
                await hook?.();
                subscription.cancel_at_period_end = body.cancel_at_period_end;
                if (polar.cancelAnswerLost) {
                    polar.cancelAnswerLost = false;
                    throw new Error('The request timed out.');
                }
            }
            return structuredClone(subscription);
        },
        // Ends it now; one already ended is refused as Polar refuses it (403).
        async revoke(id: string) {
            polar.calls.push(`subscriptions.revoke:${id}`);
            const subscription = polar.subscriptions.get(id);
            if (!subscription) throw notFound();
            const refusal = polar.revokeRefusals.get(id);
            if (refusal) throw new PolarClientError(refusal.status, { error: refusal.error });
            if (polar.revokeTimesOut) {
                polar.revokeTimesOut = false;
                throw new Error('The request timed out.');
            }
            if (polar.revokeFailures > 0) {
                polar.revokeFailures -= 1;
                throw new PolarClientError(503, { error: 'ServiceUnavailable' });
            }
            if (subscription.ended_at)
                throw new PolarClientError(403, {
                    error: 'AlreadyCanceledSubscription',
                    detail: 'This subscription is already revoked.',
                });
            subscription.status = 'canceled';
            subscription.ended_at = polar.revokeAt ?? new Date().toISOString();
            if (polar.revokeAnswerLost) {
                polar.revokeAnswerLost = false;
                throw new Error('The request timed out.');
            }
            return structuredClone(subscription);
        },
    },
    /*
     * Polar's refunds as the reviewer read Polar's code: at most the order's net amount
     * plus the balance applied to it (negative when a credit paid part) less
     * `refunded_amount`, which moves only when a refund succeeds, so pending refunds
     * don't count against it; 403 RefundedAlready once nothing is left. No
     * idempotency: the same call twice makes two refunds.
     */
    refunds: {
        async list(query: { order_id?: string }) {
            polar.calls.push(`refunds.list:${query.order_id}`);
            if (polar.refundsUnreadable) throw new PolarClientError(403, { error: 'NotPermitted' });
            // What Polar held when it answered; the answer may then be slow to arrive.
            const items = polar.refunds
                .filter((refund) => refund.order_id === query.order_id)
                .map((refund) => ({ ...refund }));
            const stall = polar.onRefundList;
            polar.onRefundList = null;
            await stall?.();
            if (polar.refundLatencyMs)
                await new Promise((r) => setTimeout(r, polar.refundLatencyMs));
            return { items, pagination: { total_count: 0, max_page: 1 } };
        },
        async create(body: {
            order_id: string;
            amount: number;
            metadata?: Record<string, string>;
            revoke_benefits?: boolean;
            comment?: string | null;
        }) {
            polar.calls.push(`refunds.create:${body.order_id}:${body.amount}`);
            if (polar.refundLatencyMs)
                await new Promise((r) => setTimeout(r, polar.refundLatencyMs));
            if (polar.refundFailures > 0) {
                polar.refundFailures -= 1;
                throw new PolarClientError(503, { error: 'ServiceUnavailable' });
            }
            if (polar.refundRefusals > 0) {
                polar.refundRefusals -= 1;
                throw new PolarClientError(422, { error: 'HTTPValidationError' });
            }
            const order = polar.orders.find((candidate) => candidate.id === body.order_id);
            if (!order) throw notFound();
            if (polar.refundedAlreadyOrders.has(order.id))
                throw new PolarClientError(403, { error: 'RefundedAlready' });
            const refused = polar.refusedOrders.get(order.id);
            if (refused) throw new PolarClientError(403, { error: refused, detail: refused });
            if (
                polar.refundWindowDays !== null &&
                Date.now() - Date.parse(order.created_at) > polar.refundWindowDays * DAY
            )
                throw new PolarClientError(500, { error: 'InternalServerError' });
            const left =
                (order.net_amount ?? 1000) +
                Math.min(0, order.applied_balance_amount ?? 0) -
                (order.refunded_amount ?? 0);
            if (left <= 0) throw new PolarClientError(403, { error: 'RefundedAlready' });
            if (body.amount < 1 || body.amount > left)
                throw new PolarClientError(422, { error: 'HTTPValidationError' });
            if (polar.refundLandsLate) {
                polar.refundLandsLate = false;
                polar.lateRefund = () => {
                    polar.refunds.push({
                        id: `refund_${polar.refunds.length + 1}`,
                        order_id: order.id,
                        amount: body.amount,
                        status: 'succeeded',
                        metadata: body.metadata ?? {},
                        created_at: new Date().toISOString(),
                    });
                    order.refunded_amount = (order.refunded_amount ?? 0) + body.amount;
                };
                throw new Error('The request timed out.');
            }
            const refund = {
                id: `refund_${polar.refunds.length + 1}`,
                order_id: order.id,
                amount: body.amount,
                status: polar.refundStatus,
                metadata: polar.refundErrorsAfterStripe ? {} : (body.metadata ?? {}),
                created_at: new Date().toISOString(),
                comment: body.comment ?? null,
            };
            polar.refunds.push(refund);
            if (refund.status === 'succeeded')
                order.refunded_amount = (order.refunded_amount ?? 0) + refund.amount;
            if (polar.refundErrorsAfterStripe) {
                polar.refundErrorsAfterStripe = false;
                throw new PolarClientError(500, { error: 'InternalServerError' });
            }
            const after = polar.afterRefundCreate;
            polar.afterRefundCreate = null;
            await after?.();
            if (polar.refundAnswerLost) {
                polar.refundAnswerLost = false;
                throw new Error('The request timed out.');
            }
            return { ...refund, tax_amount: 18, currency: order.currency ?? 'usd' };
        },
    },
};

vi.mock('@polar-sh/sdk/2026-10', async (importOriginal) => {
    const real = await importOriginal<typeof PolarSdk>();
    return { ...real, createPolar: () => fakeClient };
});

/* The plan-ending mail a dissolved family's payer was sent, in order (its words are the template's). */
const planEndingMail: { to: string; endsOn: string }[] = [];
/* How many plan-ending mails fail (the provider down, no email settings) before one is sent. */
const mailer = { failures: 0 };
vi.mock('@hushos/emails/server', () => ({
    sendFamilyPlanEnding: async (to: string, input: { endsOn: string }) => {
        if (mailer.failures > 0) {
            mailer.failures -= 1;
            throw new Error('Email is not configured.');
        }
        planEndingMail.push({ to, endsOn: input.endsOn });
    },
}));

const {
    closeDatabase,
    createTestAccount,
    createTestFamily,
    deleteTestAccount,
    resetDatabase,
    setTestMember,
    setTestUsedBytes,
} = await import('../../db/test/helpers');
const {
    billingRepository,
    authRepository,
    db,
    driveRepository,
    groupsRepository,
    growthRepository,
} = await import('@hushos/db');
/* Raw SQL on the test database, for fault injection only. */
const rawSql = (text: string) => db.$client.query(text);

const { log } = await import('@hushos/logging');
const billing = await import('./server');
const growth = await import('./growth');
/* `billing.end-personal-plan` jobs sent, in order; tests run them as the worker would. */
const endingJobs: EndPersonalPlanJob[] = [];
/* `billing.cancel-dissolved` jobs sent (their families), in order; run as the worker would. */
const cancelJobs: string[] = [];

function subscribe(userId: string, subscription: Partial<FakeSubscription> & { id: string }) {
    const full: FakeSubscription = {
        status: 'active',
        product_id: PRO,
        recurring_interval: 'month',
        amount: 1000,
        currency: 'usd',
        current_period_start: new Date(Date.now() - DAY).toISOString(),
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
    polar.beforeProductChange = null;
    polar.ignoresMoves = false;
    polar.ordersLag = false;
    polar.checkoutOrders = [];
    polar.orders = [];
    polar.refunds = [];
    polar.refundFailures = 0;
    polar.refundAnswerLost = false;
    polar.refundRefusals = 0;
    polar.refundLandsLate = false;
    polar.lateRefund = null;
    polar.refundErrorsAfterStripe = false;
    polar.refundLatencyMs = 0;
    polar.afterRefundCreate = null;
    polar.refundWindowDays = null;
    polar.refusedOrders = new Map();
    polar.refundedAlreadyOrders = new Set();
    polar.onRefundList = null;
    polar.refundStatus = 'succeeded';
    polar.refundsUnreadable = false;
    polar.revokeAt = null;
    polar.revokeAnswerLost = false;
    polar.revokeTimesOut = false;
    polar.revokeRefusals = new Map();
    polar.revokeFailures = 0;
    polar.cancelFailures = 0;
    polar.beforeCancel = null;
    polar.cancelRefusal = null;
    polar.cancelAnswerLost = false;
    polar.unauthorized = false;
    planEndingMail.length = 0;
    mailer.failures = 0;
    cancelJobs.length = 0;
    billing.setDissolveCancelQueue(async (groupId) => {
        cancelJobs.push(groupId);
    });
    endingJobs.length = 0;
    billing.setEndPersonalPlanQueue(async (job) => {
        endingJobs.push(job);
    });
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

    test('lists the valid family plans with families on, smallest pool first', async () => {
        const catalogue = await billing.listCatalogue();
        // The mismatched, off-bound, low-minimum, fractional, per-member and unknown-tier
        // products are dropped, and with the tiers on sale the single plan is not offered.
        expect(catalogue.families.map((family) => family.id)).toEqual([
            PLUS,
            PRO_FAMILY,
            PRO_YEARLY,
            MAX_FAMILY,
        ]);
        expect(catalogue.families[0]).not.toHaveProperty('archived');
    });

    test('a family product with a tier key HushOS does not know is dropped', async () => {
        const { readFamilyProduct } = await import('./provider');
        const mega = polar.products.find((candidate) => candidate.name === 'Family Mega (monthly)');
        expect(mega?.metadata).toMatchObject({ hushos_tier: 'mega' });
        expect(readFamilyProduct(mega as never)).toBeNull();
        // The same product with a known key reads.
        expect(
            readFamilyProduct({
                ...mega,
                metadata: { ...mega!.metadata, hushos_tier: 'max' },
            } as never),
        ).toMatchObject({ tier: 'max' });
        expect((await billing.listCatalogue()).families.map((family) => family.name)).not.toContain(
            'Family Mega (monthly)',
        );
    });

    test('two products for one tier and period: the newest is offered, whatever the order', async () => {
        const { offeredFamilies, readFamilyProduct } = await import('./provider');
        const read = (id: string, createdAt: string, newId = id) => ({
            ...readFamilyProduct(polar.products.find((candidate) => candidate.id === id) as never)!,
            id: newId,
            createdAt,
        });
        const older = read(PLUS, '2026-10-01T00:00:00Z');
        const newer = read(PLUS, '2026-10-18T00:00:00Z', 'plus-again');
        const max = read(MAX_FAMILY, '2026-10-01T00:00:00Z');
        expect(offeredFamilies([older, newer, max])).toEqual([newer, max]);
        expect(offeredFamilies([newer, older, max])).toEqual([newer, max]);
        // The same moment: the larger id, so every server picks the same one.
        const twin = { ...older, id: 'zzz' };
        expect(offeredFamilies([twin, older])).toEqual([twin]);
        expect(offeredFamilies([older, twin])).toEqual([twin]);
        // An archived newer one leaves the older on sale.
        expect(offeredFamilies([older, { ...newer, archived: true }])).toEqual([older]);
    });

    test('the single plan is hidden only in a billing period a tier is offered in', async () => {
        const { offeredFamilies, readFamilyProduct } = await import('./provider');
        const single = readFamilyProduct(
            polar.products.find((candidate) => candidate.id === FAMILY) as never,
        )!;
        const singleYearly = { ...single, id: 'family-yearly', interval: 'year' as const };
        const read = (id: string) =>
            readFamilyProduct(polar.products.find((candidate) => candidate.id === id) as never)!;
        // Monthly tiers only: the yearly single plan stays on sale; the monthly one goes.
        expect(offeredFamilies([single, singleYearly, read(PLUS), read(MAX_FAMILY)])).toEqual([
            singleYearly,
            read(PLUS),
            read(MAX_FAMILY),
        ]);
        expect(offeredFamilies([single, singleYearly, read(PRO_YEARLY)])).toEqual([
            single,
            read(PRO_YEARLY),
        ]);
    });

    test('the single plan is offered only while no tier is, and never once archived', async () => {
        const { offeredFamilies, readFamilyProduct } = await import('./provider');
        const read = (id: string) =>
            readFamilyProduct(polar.products.find((candidate) => candidate.id === id) as never)!;
        const single = read(FAMILY);
        expect(single).toMatchObject({ tier: null, includedMembers: 6 });
        expect(offeredFamilies([single])).toEqual([single]);
        expect(offeredFamilies([single, read(PLUS), read(MAX_FAMILY)])).toEqual([
            read(PLUS),
            read(MAX_FAMILY),
        ]);
        expect(offeredFamilies([{ ...single, archived: true }])).toEqual([]);
        // An archived tier still counts as none on sale.
        expect(offeredFamilies([single, { ...read(PLUS), archived: true }])).toEqual([single]);
    });

    test('reads the three tiers with four included and the same price a member on each', async () => {
        const families = (await billing.listCatalogue()).families.filter(
            (family) => family.tier !== null,
        );
        expect(
            families.map(({ name, tier, interval, quotaBytes, recommended }) => ({
                name,
                tier,
                interval,
                quotaBytes,
                recommended,
            })),
        ).toEqual([
            {
                name: 'Family Plus (monthly)',
                tier: 'plus',
                interval: 'month',
                quotaBytes: PLUS_POOL.toString(),
                recommended: false,
            },
            {
                name: 'Family Pro (monthly)',
                tier: 'pro',
                interval: 'month',
                quotaBytes: FAMILY_POOL.toString(),
                recommended: true,
            },
            {
                name: 'Family Pro (yearly)',
                tier: 'pro',
                interval: 'year',
                quotaBytes: FAMILY_POOL.toString(),
                recommended: true,
            },
            {
                name: 'Family Max (monthly)',
                tier: 'max',
                interval: 'month',
                quotaBytes: MAX_POOL.toString(),
                recommended: false,
            },
        ]);
        for (const family of families) {
            expect(family.includedMembers).toBe(4);
            expect(family.maxMembers).toBe(20);
        }
        // Unit amounts arrive as strings and are read as whole minor units, per currency.
        expect(families[0]?.prices).toEqual({
            usd: { base: 1000, perMember: 150 },
            eur: { base: 1000, perMember: 150 },
            gbp: { base: 800, perMember: 120 },
            inr: { base: 39900, perMember: 5900 },
        });
        expect(families[2]?.prices.usd).toEqual({ base: 19200, perMember: 1500 });
        // A tier is never offered as a person's plan.
        expect((await billing.listCatalogue()).plans.map((plan) => plan.name)).toEqual([
            'Pro (monthly)',
            'Max (yearly)',
        ]);
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

    test('revokes a past-due plan listed after a full page of ended ones', async () => {
        const { userId } = await createTestAccount();
        subscribe(userId, { id: 'sub_live' });
        await billing.reconcileCustomer(userId);
        const customer = polar.customers.get(userId)!;
        const ended = Array.from({ length: 100 }, (_, i) => ({
            ...customer.subscriptions[0]!,
            id: `sub_old_${i}`,
            status: 'canceled',
            ended_at: new Date(Date.now() - DAY).toISOString(),
        }));
        // Past due: not in the customer's state, and not in the mirror (reconciled while active,
        // it went past due without a delivery reaching HushOS). Only Polar's list has it, last.
        const live = customer.subscriptions[0]!;
        live.status = 'past_due';
        customer.subscriptions = [...ended, live];
        await rawSql(`update billing_subscriptions set ended_at = now() where id = 'sub_live'`);
        await billing.revokeForDeletion(userId);
        expect(polar.calls).toContain('subscriptions.revoke:sub_live');
    });

    test('does nothing for an account that never bought anything', async () => {
        const { userId } = await createTestAccount();
        await billing.revokeForDeletion(userId);
        expect(polar.calls).toEqual([]);
    });
});

describe('a personal plan whose payment failed, or that is paused', () => {
    const userOfId = (userId: string) => ({ id: userId, name: 'Test', email: 'x@hushos.test' });
    const mirrored = async (userId: string) =>
        (await billingRepository.getBillingSummary(userId)).subscription;

    /* Someone on Pro whose plan Polar now answers as `status`, reconciled. */
    async function lapsedSubscriber(status: string, id = 'sub_lapsed') {
        const { userId } = await createTestAccount();
        const subscription = subscribe(userId, { id });
        await billing.reconcileCustomer(userId);
        subscription.status = status;
        await billing.reconcileCustomer(userId);
        polar.calls = [];
        return { userId, subscription };
    }

    test.each(['unpaid', 'incomplete', 'paused'])(
        'one Polar answers as %s is kept with its status and read again, gives Free’s storage, and is no current plan',
        async (status) => {
            const { userId, subscription } = await lapsedSubscriber(status);
            expect(await mirrored(userId)).toMatchObject({ status, endedAt: null });
            expect((await authRepository.getStorageAllowance(userId))?.quotaBytes).toBe(
                GIB.toString(),
            );
            // The summary still names it, so the page can say why; it is not the live plan.
            const summary = await billing.getSummary(userOfId(userId));
            expect(summary.subscription).toMatchObject({ id: 'sub_lapsed', status });
            // A cancel or resume has nothing to act on, and asks Polar nothing.
            await expect(billing.cancelAtPeriodEnd(userOfId(userId), {})).rejects.toMatchObject({
                status: 404,
            });
            await expect(billing.resume(userOfId(userId))).rejects.toMatchObject({ status: 404 });
            expect(polar.calls.filter((call) => call.startsWith('subscriptions.update'))).toEqual(
                [],
            );
            // The next reconcile reads it from Polar again.
            await billing.reconcileCustomer(userId);
            expect(polar.calls).toContain('subscriptions.get:sub_lapsed');
            expect(await mirrored(userId)).toMatchObject({ status, endedAt: null });
            // Paid, or resumed: live again.
            subscription.status = 'active';
            await billing.reconcileCustomer(userId);
            expect((await authRepository.getStorageAllowance(userId))?.quotaBytes).toBe(
                (501n * GIB).toString(),
            );
        },
    );

    test('an unpaid plan Polar no longer has (404) is recorded as ended', async () => {
        const { userId } = await lapsedSubscriber('unpaid');
        polar.subscriptions.delete('sub_lapsed');
        polar.customers.get(userId)!.subscriptions = [];
        await billing.reconcileCustomer(userId);
        expect(await mirrored(userId)).toMatchObject({
            status: 'unpaid',
            endedAt: expect.any(String),
        });
        expect(await billingRepository.listUnendedSubscriptionIds(userId)).toEqual([]);
    });

    test.each(['unpaid', 'incomplete', 'paused'])(
        'a checkout with a %s plan revokes it at Polar first, then opens a new checkout',
        async (status) => {
            const { userId, subscription } = await lapsedSubscriber(status);
            const result = await billing.startCheckout(userOfId(userId), MAX);
            expect(result).toEqual({ url: 'https://polar.test/checkout' });
            // Revoked before the checkout was made, never switched in place.
            const revoked = polar.calls.indexOf('subscriptions.revoke:sub_lapsed');
            expect(revoked).toBeGreaterThanOrEqual(0);
            expect(revoked).toBeLessThan(polar.calls.indexOf('checkouts.create'));
            expect(polar.calls.filter((call) => call.startsWith('subscriptions.update'))).toEqual(
                [],
            );
            expect(subscription.ended_at).toBeTruthy();
            expect(await billingRepository.listUnendedSubscriptionIds(userId)).toEqual([]);
            // Recorded, so a payment Polar takes for it afterwards is refunded.
            expect(await billingRepository.getPlanEnding('sub_lapsed')).toMatchObject({
                userId,
                groupId: null,
                outcome: 'settled',
            });
        },
    );

    test('a second click, or a plan gone at Polar, is nothing to revoke and the checkout opens', async () => {
        const { userId, subscription } = await lapsedSubscriber('unpaid');
        // Another tab's checkout revoked it between this one's second read and its revoke: 403.
        polar.afterGet = () => {
            polar.afterGet = () => {
                subscription.status = 'canceled';
                subscription.ended_at = new Date().toISOString();
            };
        };
        await expect(billing.startCheckout(userOfId(userId), MAX)).resolves.toEqual({
            url: 'https://polar.test/checkout',
        });
        expect(polar.calls).toContain('subscriptions.revoke:sub_lapsed');
        // Gone at Polar between the read and the revoke: 404.
        const other = await lapsedSubscriber('paused', 'sub_gone');
        polar.afterGet = () => {
            polar.afterGet = () => {
                polar.subscriptions.delete('sub_gone');
            };
        };
        await expect(billing.startCheckout(userOfId(other.userId), MAX)).resolves.toEqual({
            url: 'https://polar.test/checkout',
        });
        expect(polar.calls).toContain('subscriptions.revoke:sub_gone');
    });

    test('a payment Polar takes after the checkout revoked it is refunded whole; an order paid before is left alone', async () => {
        const { userId, subscription } = await lapsedSubscriber('paused');
        subscription.current_period_start = new Date(Date.now() - 2 * DAY).toISOString();
        // The paused plan's last period, paid and used before the pause took effect.
        addPaidOrder(subscription, 'order_used', subscription.current_period_start);
        await billing.startCheckout(userOfId(userId), MAX);
        // A late delivery of that order's order.paid: not refunded, nothing queued.
        await deliverPaid(userId, subscription, 'order_used');
        expect(endingJobs).toEqual([]);
        // An order Polar takes after the revoke (made when the period began, paid now in the
        // portal): refunded whole, not for what was left of the period.
        addPaidOrder(subscription, 'order_late', subscription.current_period_start);
        await deliverPaid(userId, subscription, 'order_late');
        expect(endingJobs).toEqual([expect.objectContaining({ userId, groupId: null })]);
        await runQueued(0);
        expect(refundsMade()).toEqual([['order_late', 999]]);
        expect(polar.refunds[0]).toMatchObject({
            comment: 'Paid after HushOS ended this plan, which no longer runs',
            metadata: { hushos_refund: expect.stringContaining(':order_late') },
        });
        expect(await billingRepository.getPlanEnding('sub_lapsed')).toMatchObject({
            outcome: 'settled',
        });
        // Run again (a retry, the daily reconcile), and the delivery again: nothing twice.
        await deliverPaid(userId, subscription, 'order_late');
        await runQueued(0);
        expect(refundsMade()).toEqual([['order_late', 999]]);
    });

    test('a second payment noted while the job is refunding the first is refunded too', async () => {
        const { userId, subscription } = await lapsedSubscriber('unpaid');
        await billing.startCheckout(userOfId(userId), MAX);
        addPaidOrder(subscription, 'order_late');
        await deliverPaid(userId, subscription, 'order_late');
        const [job] = endingJobs;
        // The second order.paid lands after the run read the orders, before it closes.
        polar.onRefundList = async () => {
            addPaidOrder(subscription, 'order_later');
            await deliverPaid(userId, subscription, 'order_later');
        };
        const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
        try {
            await expect(billing.endPersonalPlans(job!)).rejects.toThrow();
            expect(refundsMade()).toEqual([['order_late', 999]]);
            expect((await billingRepository.getPlanEnding('sub_lapsed'))?.outcome).toBeNull();
            // pg-boss's retry of the same job.
            await billing.endPersonalPlans(job!);
        } finally {
            warn.mockRestore();
        }
        expect(refundsMade()).toEqual([
            ['order_late', 999],
            ['order_later', 999],
        ]);
        expect((await billingRepository.getPlanEnding('sub_lapsed'))?.outcome).toBe('settled');
    });

    test('a revoke whose answer is lost still has a later payment refunded', async () => {
        const { userId, subscription } = await lapsedSubscriber('unpaid');
        // The revoke lands at Polar; its answer doesn't arrive, so the checkout is refused.
        polar.revokeAnswerLost = true;
        await expect(billing.startCheckout(userOfId(userId), MAX)).rejects.toMatchObject({
            status: 503,
        });
        expect(subscription.ended_at).toBeTruthy();
        expect(await billingRepository.getPlanEnding('sub_lapsed')).toMatchObject({
            groupId: null,
            revokedAt: null,
            outcome: 'settled',
        });
        addPaidOrder(subscription, 'order_late');
        await deliverPaid(userId, subscription, 'order_late');
        await runQueued(0);
        expect(refundsMade()).toEqual([['order_late', 999]]);
        expect((await billingRepository.getPlanEnding('sub_lapsed'))?.revokedAt).toBeInstanceOf(
            Date,
        );
    });

    test('such a payment partly made from the customer’s balance is refunded on that order only; the rest goes to operators', async () => {
        const { userId, subscription } = await lapsedSubscriber('unpaid');
        // An earlier card payment of theirs, which the pooled-member refund would draw on.
        polar.orders.push({
            id: 'order_earlier',
            subscription_id: subscription.id,
            status: 'paid',
            due_amount: 0,
            created_at: new Date(Date.now() - 40 * DAY).toISOString(),
            product_id: PRO,
            currency: 'usd',
            billing_reason: 'subscription_create',
            net_amount: 999,
            tax_amount: 180,
        });
        await billing.startCheckout(userOfId(userId), MAX);
        polar.orders.push({
            id: 'order_late',
            subscription_id: subscription.id,
            status: 'paid',
            due_amount: 0,
            created_at: subscription.current_period_start!,
            product_id: PRO,
            currency: 'usd',
            billing_reason: 'subscription_cycle',
            net_amount: 999,
            tax_amount: 180,
            applied_balance_amount: -300,
        });
        expect(
            (
                await billing.handleWebhook(
                    await signedWebhook({
                        type: 'order.paid',
                        data: {
                            id: 'order_late',
                            subscription_id: subscription.id,
                            created_at: subscription.current_period_start,
                            currency: 'usd',
                            customer: { external_id: userId },
                        },
                    }),
                )
            ).status,
        ).toBe(200);
        const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
        try {
            await runQueued(0);
        } finally {
            warn.mockRestore();
        }
        expect(refundsMade()).toEqual([['order_late', 699]]);
        expect(await billingRepository.listUnrefundable()).toEqual([
            expect.objectContaining({ subscriptionId: 'sub_lapsed', amount: 300 }),
        ]);
    });

    test('such a payment made wholly from the customer’s balance settles with nothing refunded, listed for operators', async () => {
        const { userId, subscription } = await lapsedSubscriber('unpaid');
        await billing.startCheckout(userOfId(userId), MAX);
        addPaidOrder(subscription, 'order_late');
        polar.orders.at(-1)!.applied_balance_amount = -999;
        await deliverPaid(userId, subscription, 'order_late');
        const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
        try {
            await runQueued(0);
        } finally {
            warn.mockRestore();
        }
        expect(refundsMade()).toEqual([]);
        expect(await billingRepository.getPlanEnding('sub_lapsed')).toMatchObject({
            outcome: 'settled',
            unrefundableAmount: 999,
        });
    });

    test('a refund of such a payment that keeps failing is logged as an error and listed as owed', async () => {
        const { userId, subscription } = await lapsedSubscriber('unpaid');
        await billing.startCheckout(userOfId(userId), MAX);
        addPaidOrder(subscription, 'order_late');
        await deliverPaid(userId, subscription, 'order_late');
        const [job] = endingJobs;
        polar.refundRefusals = 5;
        const error = vi.spyOn(log, 'error').mockImplementation(() => {});
        const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
        try {
            for (let attempt = 1; attempt <= 4; attempt++) {
                await expect(billing.endPersonalPlans(job!)).rejects.toThrow();
                expect(await billingRepository.listRefundsOwed()).toEqual([]);
            }
            expect(await billing.endPersonalPlans(job!)).toMatchObject({ owed: 1 });
            expect(await billingRepository.listRefundsOwed()).toEqual([
                expect.objectContaining({
                    orderId: 'order_late',
                    userId,
                    amount: 999,
                    currency: 'usd',
                    failures: 5,
                }),
            ]);
            expect(error).toHaveBeenCalledWith(
                expect.objectContaining({ message: 'Refund owed: Polar has not refunded it' }),
            );
        } finally {
            error.mockRestore();
            warn.mockRestore();
        }
        expect(refundsMade()).toEqual([]);
    });

    test('a plan chosen at sign-up isn’t carried to checkout past a lapsed plan', async () => {
        const { userId } = await lapsedSubscriber('unpaid');
        await rawSql(
            `insert into account_intents (user_id, plan_product_id) values ('${userId}', '${MAX}')`,
        );
        expect((await billing.getSummary(userOfId(userId))).intendedPlan).toBeNull();
        // Without the lapsed plan it would be.
        await rawSql(
            `update billing_subscriptions set ended_at = now() where user_id = '${userId}'`,
        );
        expect((await billing.getSummary(userOfId(userId))).intendedPlan).toBe(MAX);
    });

    test.each(['past_due', 'unpaid', 'paused'])(
        'deleting the account revokes a %s plan before the Polar customer goes',
        async (status) => {
            const { userId } = await lapsedSubscriber(status);
            await billing.revokeForDeletion(userId);
            const revoked = polar.calls.indexOf('subscriptions.revoke:sub_lapsed');
            expect(revoked).toBeGreaterThanOrEqual(0);
            expect(revoked).toBeLessThan(polar.calls.indexOf(`customers.deleteExternal:${userId}`));
        },
    );

    test('deleting the account goes on when a plan the mirror holds was already revoked', async () => {
        const { userId, subscription } = await lapsedSubscriber('unpaid');
        subscription.status = 'canceled';
        subscription.ended_at = new Date().toISOString();
        await billing.revokeForDeletion(userId);
        expect(polar.calls).toContain(`customers.deleteExternal:${userId}`);
    });

    test('a lapsed plan Polar has made live again meanwhile is kept and switched in place', async () => {
        const { userId, subscription } = await lapsedSubscriber('unpaid');
        // Paid in the portal just now; no delivery has arrived yet.
        subscription.status = 'active';
        const result = await billing.startCheckout(userOfId(userId), MAX);
        expect(result).toEqual({ url: null });
        expect(polar.calls).not.toContain('subscriptions.revoke:sub_lapsed');
        expect(polar.calls).not.toContain('checkouts.create');
        expect(subscription.product_id).toBe(MAX);
    });

    test('a revoke that times out without landing: the payment that restores the plan is theirs, and nothing of it is refunded later', async () => {
        const { userId, subscription } = await lapsedSubscriber('unpaid');
        polar.revokeTimesOut = true;
        await expect(billing.startCheckout(userOfId(userId), MAX)).rejects.toMatchObject({
            status: 503,
        });
        expect(subscription.ended_at).toBeNull();
        // They pay in the portal instead: the plan runs again.
        subscription.status = 'active';
        addPaidOrder(subscription, 'order_a', new Date(Date.now() - DAY).toISOString());
        await deliverPaid(userId, subscription, 'order_a');
        await runQueued(0);
        // Polar shows it running: never revoked, so the payment is theirs, unrefunded.
        expect(refundsMade()).toEqual([]);
        expect((await billingRepository.getPlanEnding('sub_lapsed'))?.outcome).toBe('dropped');
        expect((await billingRepository.getPlanRefund('order_a'))?.status).toBe('none');
        // Months later it lapses again, and another checkout revokes it; then a dunning email is
        // answered: that order alone is refunded, never the month they used.
        // Its next renewal fails: a new period, unpaid.
        subscription.status = 'unpaid';
        subscription.current_period_start = new Date().toISOString();
        await billing.reconcileCustomer(userId);
        await billing.startCheckout(userOfId(userId), MAX);
        expect(subscription.ended_at).toBeTruthy();
        addPaidOrder(subscription, 'order_b');
        const before = endingJobs.length;
        await deliverPaid(userId, subscription, 'order_b');
        await runQueued(before);
        expect(refundsMade()).toEqual([['order_b', 999]]);
    });

    test('after a dropped revoke, the plan renews and its owner joins a family: its ending settles', async () => {
        const { userId, subscription } = await lapsedSubscriber('unpaid');
        polar.revokeTimesOut = true;
        await expect(billing.startCheckout(userOfId(userId), MAX)).rejects.toMatchObject({
            status: 503,
        });
        subscription.status = 'active';
        addPaidOrder(subscription, 'order_a', new Date(Date.now() - 3 * DAY).toISOString());
        await deliverPaid(userId, subscription, 'order_a');
        await runQueued(0);
        // It renews: order_a now lies before the plan's period.
        subscription.current_period_start = new Date(Date.now() - DAY).toISOString();
        await billing.reconcileCustomer(userId);
        const { groupId } = await familyOnPlan();
        await setTestMember({ groupId, userId, state: 'active' });
        endingJobs.length = 0;
        expect(await billing.queuePlanEnding(userId)).toBe(true);
        const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
        try {
            await runQueued(0);
        } finally {
            warn.mockRestore();
        }
        expect(await billingRepository.getPlanEnding('sub_lapsed')).toMatchObject({
            groupId,
            outcome: 'settled',
        });
        // Revoked for the family; order_a paid the period before, used: nothing refunded.
        expect(callsTo('subscriptions.revoke')).toContain('subscriptions.revoke:sub_lapsed');
        expect(refundsMade()).toEqual([]);
        expect((await billingRepository.getPlanRefund('order_a'))?.status).toBe('none');
    });

    test('a revoke that lands but answers 502 keeps the ending: a payment just before it is refunded', async () => {
        const { userId, subscription } = await lapsedSubscriber('unpaid');
        const original = fakeClient.subscriptions.revoke.bind(fakeClient.subscriptions);
        const spy = vi
            .spyOn(fakeClient.subscriptions, 'revoke')
            .mockImplementation(async (id: string) => {
                // A payment lands between HushOS's second read and the revoke.
                addPaidOrder(subscription, 'order_y');
                await original(id);
                throw new PolarClientError(502, { error: 'BadGateway' });
            });
        try {
            await expect(billing.startCheckout(userOfId(userId), MAX)).rejects.toBeTruthy();
        } finally {
            spy.mockRestore();
        }
        expect(subscription.ended_at).toBeTruthy();
        expect(await billingRepository.getPlanEnding('sub_lapsed')).toMatchObject({
            groupId: null,
            outcome: 'settled',
        });
        const before = endingJobs.length;
        await deliverPaid(userId, subscription, 'order_y');
        await runQueued(before);
        expect(refundsMade()).toEqual([['order_y', 999]]);
    });

    test('a noted payment on a plan Polar no longer has is refunded, as for a family ending', async () => {
        const { userId, subscription } = await lapsedSubscriber('unpaid');
        polar.revokeTimesOut = true;
        await expect(billing.startCheckout(userOfId(userId), MAX)).rejects.toMatchObject({
            status: 503,
        });
        addPaidOrder(subscription, 'order_late');
        await deliverPaid(userId, subscription, 'order_late');
        polar.subscriptions.delete('sub_lapsed');
        await runQueued(0);
        expect(refundsMade()).toEqual([['order_late', 999]]);
    });

    test('a checkout while the plan-ending job holds the lapsed ending is refused, and revokes nothing', async () => {
        const { userId } = await lapsedSubscriber('unpaid');
        polar.revokeTimesOut = true;
        await expect(billing.startCheckout(userOfId(userId), MAX)).rejects.toMatchObject({
            status: 503,
        });
        expect(await billingRepository.takePlanEndingLease('sub_lapsed', 'a-job', 60_000)).toBe(
            true,
        );
        polar.calls = [];
        await expect(billing.startCheckout(userOfId(userId), MAX)).rejects.toMatchObject({
            status: 409,
            message: 'Your Pro plan is still being ended. Try again in a few minutes.',
        });
        expect(callsTo('subscriptions.revoke')).toEqual([]);
        expect(polar.calls).not.toContain('checkouts.create');
    });

    test('an unpaid plan with its period’s order paid is never revoked: the checkout waits', async () => {
        const { userId, subscription } = await lapsedSubscriber('unpaid');
        // Paid just before Polar's status caught up.
        addPaidOrder(subscription, 'order_paid', subscription.current_period_start);
        const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
        try {
            await expect(billing.startCheckout(userOfId(userId), MAX)).rejects.toMatchObject({
                status: 409,
                message:
                    'Polar shows a payment for your Pro plan that hasn’t taken effect yet, so it can’t be ended. Try again in a few minutes, or contact support.',
            });
        } finally {
            warn.mockRestore();
        }
        expect(callsTo('subscriptions.revoke')).toEqual([]);
        expect(polar.calls).not.toContain('checkouts.create');
        expect(subscription.ended_at).toBeNull();
        expect((await billingRepository.getPlanEnding('sub_lapsed'))?.outcome).toBe('dropped');
    });

    test('an unpaid plan whose period’s order was refunded whole is revoked as usual', async () => {
        const { userId, subscription } = await lapsedSubscriber('unpaid');
        addPaidOrder(subscription, 'order_refunded', subscription.current_period_start);
        polar.orders.at(-1)!.refunded_amount = 999;
        expect(await billing.startCheckout(userOfId(userId), MAX)).toEqual({
            url: 'https://polar.test/checkout',
        });
        expect(callsTo('subscriptions.revoke')).toEqual(['subscriptions.revoke:sub_lapsed']);
    });

    test('the job closes an ending only while it holds it', async () => {
        const { userId, subscription } = await lapsedSubscriber('unpaid');
        await billing.startCheckout(userOfId(userId), MAX);
        addPaidOrder(subscription, 'order_late');
        await deliverPaid(userId, subscription, 'order_late');
        // Its lease runs out mid-run, and another run takes the ending.
        polar.afterRefundCreate = async () => {
            await rawSql(
                "update personal_plan_endings set lease_owner = 'another-run', lease_until = now() + interval '1 hour' where subscription_id = 'sub_lapsed'",
            );
        };
        await expect(billing.endPersonalPlans(endingJobs[0]!)).rejects.toThrow(
            'Another run took this plan’s ending over; this one stops.',
        );
        expect((await billingRepository.getPlanEnding('sub_lapsed'))?.outcome).toBeNull();
    });

    test('a payment whose first delivery could not queue the job is refunded on its redelivery', async () => {
        const { userId, subscription } = await lapsedSubscriber('unpaid');
        await billing.startCheckout(userOfId(userId), MAX);
        addPaidOrder(subscription, 'order_late');
        billing.setEndPersonalPlanQueue(async () => {
            throw new Error('The queue is down.');
        });
        await deliverPaid(userId, subscription, 'order_late');
        billing.setEndPersonalPlanQueue(async (job) => {
            endingJobs.push(job);
        });
        expect(endingJobs).toEqual([]);
        // Polar delivers it again (a new delivery id): the job is queued this time.
        await deliverPaid(userId, subscription, 'order_late');
        expect(endingJobs).toHaveLength(1);
        await runQueued(0);
        expect(refundsMade()).toEqual([['order_late', 999]]);
    });

    test('a payment between reading the plan and listing its paid orders keeps the plan, switched in place', async () => {
        const { userId, subscription } = await lapsedSubscriber('unpaid');
        // Paid in the portal just after the checkout read it.
        polar.afterGet = () => {
            subscription.status = 'active';
            addPaidOrder(subscription, 'order_paid');
        };
        expect(await billing.startCheckout(userOfId(userId), MAX)).toEqual({ url: null });
        expect(polar.calls).not.toContain('subscriptions.revoke:sub_lapsed');
        expect(polar.calls).not.toContain('checkouts.create');
        expect(subscription.product_id).toBe(MAX);
        expect((await billingRepository.getPlanEnding('sub_lapsed'))?.outcome).toBe('dropped');
    });

    test('Polar answering already ended for a plan still running refuses the checkout', async () => {
        const { userId } = await lapsedSubscriber('unpaid');
        polar.revokeRefusals.set('sub_lapsed', {
            status: 403,
            error: 'AlreadyCanceledSubscription',
        });
        await expect(billing.startCheckout(userOfId(userId), MAX)).rejects.toMatchObject({
            status: 409,
        });
        expect(polar.calls).not.toContain('checkouts.create');
        expect((await billingRepository.getPlanEnding('sub_lapsed'))?.outcome).toBe('dropped');
    });

    test('a plan Polar has locked refuses the checkout with words, and tells operators', async () => {
        const { userId } = await lapsedSubscriber('unpaid');
        polar.revokeRefusals.set('sub_lapsed', { status: 409, error: 'SubscriptionLocked' });
        const error = vi.spyOn(log, 'error').mockImplementation(() => {});
        try {
            await expect(billing.startCheckout(userOfId(userId), MAX)).rejects.toMatchObject({
                status: 409,
                message:
                    'Polar is still working on a change to your Pro plan, so it can’t be ended yet. Try again later, or contact support.',
            });
            expect(error).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'A lapsed personal plan could not be revoked: Polar says it is locked',
                }),
            );
        } finally {
            error.mockRestore();
        }
        expect(polar.calls).not.toContain('checkouts.create');
    });

    test('a revoke Polar refuses stops the checkout and leaves the plan theirs', async () => {
        const { userId } = await lapsedSubscriber('unpaid');
        polar.revokeRefusals.set('sub_lapsed', { status: 422, error: 'HTTPValidationError' });
        await expect(billing.startCheckout(userOfId(userId), MAX)).rejects.toMatchObject({
            status: 400,
        });
        expect(polar.calls).not.toContain('checkouts.create');
        expect(await mirrored(userId)).toMatchObject({ status: 'unpaid', endedAt: null });
        expect((await billingRepository.getPlanEnding('sub_lapsed'))?.outcome).toBe('dropped');
    });

    test('a revoke answered 503 that never landed: the payment that then restores the plan is theirs', async () => {
        const { userId, subscription } = await lapsedSubscriber('unpaid');
        polar.revokeFailures = 1;
        await expect(billing.startCheckout(userOfId(userId), MAX)).rejects.toMatchObject({
            status: 503,
        });
        expect(polar.calls).not.toContain('checkouts.create');
        // A 5xx may have landed: the ending stays until Polar's answer is read.
        expect(await billingRepository.getPlanEnding('sub_lapsed')).toMatchObject({
            outcome: 'settled',
            revokedAt: null,
        });
        // It hadn't: they pay in the portal, the plan runs again, and the payment is theirs.
        subscription.status = 'active';
        addPaidOrder(subscription, 'order_late');
        await deliverPaid(userId, subscription, 'order_late');
        await runQueued(0);
        expect(refundsMade()).toEqual([]);
        expect((await billingRepository.getPlanEnding('sub_lapsed'))?.outcome).toBe('dropped');
        expect(await mirrored(userId)).toMatchObject({ status: 'active', endedAt: null });
    });

    test('deleting the account revokes a past-due plan HushOS never recorded', async () => {
        const { userId } = await lapsedSubscriber('unpaid');
        // A plan that went past due before any delivery reached HushOS.
        subscribe(userId, { id: 'sub_unrecorded', status: 'past_due' });
        await billing.revokeForDeletion(userId);
        const revoked = polar.calls.indexOf('subscriptions.revoke:sub_unrecorded');
        expect(revoked).toBeGreaterThanOrEqual(0);
        expect(revoked).toBeLessThan(polar.calls.indexOf(`customers.deleteExternal:${userId}`));
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

    test('a payment that restores a plan whose revoke never landed earns its commission once the job knows', async () => {
        await creator();
        const { userId } = await createTestAccount();
        await growth.attributeNewAccount(userId, 'creator25');
        const subscription = subscribe(userId, { id: 'sub_lapsed' });
        await billing.reconcileCustomer(userId);
        subscription.status = 'unpaid';
        await billing.reconcileCustomer(userId);
        polar.revokeTimesOut = true;
        await billing
            .startCheckout({ id: userId, name: 'Fan', email: 'x@hushos.test' }, MAX)
            .catch(() => {});
        subscription.status = 'active';
        addPaidOrder(subscription, 'order_a');
        await deliverPaid(userId, subscription, 'order_a');
        // Held back by the delivery: the job hasn't decided yet.
        expect((await growth.listAffiliates())[0]!.stats.orders).toBe(0);
        await runQueued(0);
        const [row] = await growth.listAffiliates();
        expect(row!.stats.orders).toBe(1);
        expect(refundsMade()).toEqual([]);
    });

    /* A kept payment noted on a lapsed ending, then its owner joins a family (the review's probe). */
    async function keptThenFamily() {
        await creator();
        const { userId } = await createTestAccount();
        await growth.attributeNewAccount(userId, 'creator25');
        const subscription = subscribe(userId, { id: 'sub_lapsed' });
        await billing.reconcileCustomer(userId);
        subscription.status = 'unpaid';
        await billing.reconcileCustomer(userId);
        polar.revokeTimesOut = true;
        await billing
            .startCheckout({ id: userId, name: 'Fan', email: 'x@hushos.test' }, MAX)
            .catch(() => {});
        // Paid in the portal; the delivery arrives and is noted on the lapsed ending.
        subscription.status = 'active';
        addPaidOrder(subscription, 'order_a', subscription.current_period_start);
        await deliverPaid(userId, subscription, 'order_a');
        // Joins a family before the queued job runs.
        const { groupId } = await familyOnPlan();
        await setTestMember({ groupId, userId, state: 'active' });
        await billing.reconcileCustomer(userId);
        endingJobs.length = 0;
        expect(await billing.queuePlanEnding(userId)).toBe(true);
        return { userId, groupId };
    }

    test('a kept payment the family ending then partly refunds still earns its commission, under the family’s key', async () => {
        const { groupId } = await keptThenFamily();
        await runQueued(0);
        expect(callsTo('subscriptions.revoke')).toEqual(['subscriptions.revoke:sub_lapsed']);
        expect(refundsMade()).toEqual([['order_a', 966]]);
        expect(polar.refunds[0]?.metadata).toEqual({
            hushos_refund: expect.stringContaining(`:${groupId}:`),
        });
        expect(await billingRepository.getPlanRefund('order_a')).toMatchObject({
            status: 'succeeded',
            rewardsPending: false,
        });
        expect((await growth.listAffiliates())[0]!.stats.orders).toBe(1);
    });

    test('rewards that can’t be granted never hold back the refresh of a plan just ended for a family', async () => {
        const { userId } = await keptThenFamily();
        // Polar's orders become unreadable once the family's refund is made.
        polar.afterRefundCreate = async () => {
            polar.ordersFail = true;
        };
        const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
        try {
            await expect(billing.endPersonalPlans(endingJobs[0]!)).rejects.toThrow(
                'A kept payment’s rewards have not been granted yet.',
            );
        } finally {
            warn.mockRestore();
        }
        // The plan's end is in the mirror already: no second allowance meanwhile.
        expect(await billingRepository.listUnendedSubscriptionIds(userId)).toEqual([]);
        expect((await billingRepository.getPlanRefund('order_a'))?.rewardsPending).toBe(true);
        polar.ordersFail = false;
        await billing.endPersonalPlans(endingJobs[0]!);
        expect((await growth.listAffiliates())[0]!.stats.orders).toBe(1);
    });

    test('a late delivery of an order paid before HushOS revoked its plan still earns its commission', async () => {
        await creator();
        const { userId } = await createTestAccount();
        await growth.attributeNewAccount(userId, 'creator25');
        const subscription = subscribe(userId, { id: 'sub_lapsed' });
        await billing.reconcileCustomer(userId);
        addPaidOrder(subscription, 'order_used', subscription.current_period_start);
        subscription.status = 'paused';
        await billing.reconcileCustomer(userId);
        await billing.startCheckout({ id: userId, name: 'Fan', email: 'x@hushos.test' }, MAX);
        await deliverPaid(userId, subscription, 'order_used');
        expect(endingJobs).toEqual([]);
        expect((await growth.listAffiliates())[0]!.stats.orders).toBe(1);
    });

    test('a kept payment’s commission is granted by a later run when granting fails', async () => {
        await creator();
        const { userId } = await createTestAccount();
        await growth.attributeNewAccount(userId, 'creator25');
        const subscription = subscribe(userId, { id: 'sub_lapsed' });
        await billing.reconcileCustomer(userId);
        subscription.status = 'unpaid';
        await billing.reconcileCustomer(userId);
        polar.revokeTimesOut = true;
        await billing
            .startCheckout({ id: userId, name: 'Fan', email: 'x@hushos.test' }, MAX)
            .catch(() => {});
        subscription.status = 'active';
        addPaidOrder(subscription, 'order_a');
        await deliverPaid(userId, subscription, 'order_a');
        // The run drops the ending, then can't read the orders to grant the reward.
        const [job] = endingJobs;
        polar.ordersFail = true;
        await expect(billing.endPersonalPlans(job!)).rejects.toBeTruthy();
        polar.ordersFail = false;
        expect((await growth.listAffiliates())[0]!.stats.orders).toBe(0);
        expect((await billingRepository.getPlanRefund('order_a'))?.rewardsPending).toBe(true);
        // The daily reconcile finds it and a later run grants it, once.
        const before = endingJobs.length;
        await billing.reconcilePlanEndings();
        await runQueued(before);
        await runQueued(before);
        expect((await growth.listAffiliates())[0]!.stats.orders).toBe(1);
        expect((await billingRepository.getPlanRefund('order_a'))?.rewardsPending).toBe(false);
        expect(refundsMade()).toEqual([]);
    });

    test('a payment refunded because its plan was revoked earns no commission', async () => {
        await creator();
        const { userId } = await createTestAccount();
        await growth.attributeNewAccount(userId, 'creator25');
        const subscription = subscribe(userId, { id: 'sub_lapsed' });
        await billing.reconcileCustomer(userId);
        subscription.status = 'unpaid';
        await billing.reconcileCustomer(userId);
        await billing.startCheckout({ id: userId, name: 'Fan', email: 'x@hushos.test' }, MAX);
        addPaidOrder(subscription, 'order_late');
        await deliverPaid(userId, subscription, 'order_late');
        const [row] = await growth.listAffiliates();
        expect(row!.stats.orders).toBe(0);
        expect(row!.stats.earnings).toEqual({});
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
function familySubscription(
    groupId: string,
    subscription: Partial<FakeSubscription> = {},
    checkout: 'paid' | 'pending' = 'paid',
) {
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
    // Its checkout's order, paid (or still waiting for the bank).
    if (!polar.checkoutOrders.some((order) => order.subscription_id === full.id))
        polar.checkoutOrders.push({
            id: `order_create_${full.id}`,
            subscription_id: full.id,
            status: checkout,
            due_amount: checkout === 'paid' ? 0 : 1000,
            // Long before anything a test does to the plan.
            created_at: new Date(Date.now() - 60 * DAY).toISOString(),
            product_id: full.product_id,
            billing_reason: 'subscription_create',
        });
    return full;
}

/* A renewal Polar billed, and was paid for, on `product`: a `subscription_cycle` order. */
function renew(subscription: FakeSubscription, product: string, status = 'paid') {
    subscription.product_id = product;
    subscription.pending_update = null;
    subscription.current_period_start = new Date().toISOString();
    subscription.current_period_end = new Date(Date.now() + 30 * DAY).toISOString();
    polar.orders.push({
        id: `order_cycle_${polar.orders.length + 1}`,
        subscription_id: subscription.id,
        status,
        due_amount: status === 'paid' ? 0 : 1000,
        created_at: new Date().toISOString(),
        product_id: product,
        billing_reason: 'subscription_cycle',
    });
}

/*
 * A family on a plan, the way it gets there: the organizer (who holds
 * `billing`) checks out, Polar completes it on the team customer, and a
 * delivery for that customer is reconciled. `members` more people are active.
 */
async function familyOnPlan(
    options: { units?: number; members?: number; product?: string; currency?: string } = {},
) {
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
    const product = options.product ?? FAMILY;
    await billing.startGroupCheckout(payer, groupId, { productId: product });
    const units = options.units ?? (product === FAMILY ? 6 : 4);
    const currency = options.currency ?? 'usd';
    const subscription = familySubscription(groupId, {
        units,
        product_id: product,
        currency,
        // The single plan's tests read its list amount; a tier's is what Polar would bill.
        amount: product === FAMILY ? 1500 : planAmount(product, units, currency),
    });
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
        expect(summary.plans.find((plan) => plan.id === FAMILY)).toEqual({
            id: FAMILY,
            name: 'Family (monthly)',
            description: null,
            interval: 'month',
            tier: null,
            recommended: false,
            prices: {
                usd: { base: 1500, perMember: 200 },
                eur: { base: 1500, perMember: 200 },
            },
            includedMembers: 6,
            maxMembers: 20,
            quotaBytes: FAMILY_POOL.toString(),
        });
        expect(summary.plans.map((plan) => plan.id)).toEqual([
            PLUS,
            FAMILY,
            PRO_FAMILY,
            PRO_YEARLY,
            MAX_FAMILY,
        ]);
    });

    test('an archived tier is read for those on it but never offered', async () => {
        const plus = polar.products.find((candidate) => candidate.id === PLUS)!;
        const clock = vi.spyOn(Date, 'now');
        catalogueClock += 10 * 60_000;
        try {
            plus.is_archived = true;
            clock.mockReturnValue(new Date().getTime() + catalogueClock);
            expect((await billing.listCatalogue()).families.map((plan) => plan.id)).not.toContain(
                PLUS,
            );
            const { payer, groupId } = await familyOnPlan({ product: PRO_FAMILY });
            const summary = await priced(billing.getGroupBilling(payer, groupId));
            expect(summary.plans.map((plan) => plan.id)).not.toContain(PLUS);
            await expect(billing.changeGroupPlan(payer, groupId, PLUS)).rejects.toMatchObject({
                status: 404,
            });
            expect(polar.calls.filter((call) => call.startsWith('subscriptions.update'))).toEqual(
                [],
            );
        } finally {
            plus.is_archived = false;
            clock.mockReturnValue(new Date().getTime() + catalogueClock + 5 * 60_000);
            await billing.listCatalogue();
            clock.mockRestore();
        }
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

describe('tier quotes', () => {
    const start = new Date('2026-10-17T04:32:15Z');
    const end = new Date('2026-11-17T04:32:15Z');
    const at = (share: number) =>
        new Date(end.getTime() - share * (end.getTime() - start.getTime()));
    const pro = { base: 2000, perMember: 150, includedMembers: 4 };
    const max = { base: 3000, perMember: 150, includedMembers: 4 };
    const quote = (from: typeof pro, to: typeof pro, units: number, now: Date) =>
        billing.quoteTierChange({ from, to, units, periodStart: start, periodEnd: end, now });

    test('an upgrade charges the difference for the time left, each line rounded to the cent', () => {
        expect(quote(pro, max, 4, start)).toBe(1000);
        expect(quote(pro, max, 7, at(0.5))).toBe(500);
        // Spike 8, T2: 0.98961 of the period left was 2969 charged less 1979 credited, 990.
        expect(quote(pro, max, 4, at(0.98961))).toBe(990);
        // Two thirds: 2000 charged less 1333.33 credited, rounded to 1333: 667, not 666.
        expect(quote(pro, max, 4, at(2 / 3))).toBe(667);
        // A third: 1000 less 666.67, rounded to 667: 333.
        expect(quote(pro, max, 4, at(1 / 3))).toBe(333);
        // Places carry over at the same per-member rate: seven places cost no more to move.
        expect(quote(pro, max, 7, start)).toBe(quote(pro, max, 4, start));
        // A different rate counts only the places past those included.
        expect(quote(pro, { ...max, perMember: 200 }, 7, start)).toBe(1000 + 3 * 50);
        // Each line rounds on its own: 3 × 150 × 1/3 is 150 exactly, 3000 × 1/3 is 1000.
        expect(quote({ ...pro, base: 1001 }, max, 4, at(1 / 3))).toBe(1000 - 334);
    });

    test('a downgrade costs nothing now, and nothing is left past the period', () => {
        expect(quote(max, pro, 7, start)).toBe(0);
        expect(quote(pro, max, 4, end)).toBe(0);
        expect(quote(pro, max, 4, new Date(end.getTime() + DAY))).toBe(0);
        expect(quote(pro, max, 4, new Date(start.getTime() - DAY))).toBe(1000);
    });

    test('space to free rounds up, never to nothing, and the rest to the nearest hundredth', () => {
        expect(billing.spaceOf(PLUS_POOL)).toBe('800 GB');
        expect(billing.spaceOf(MAX_POOL)).toBe('4 TB');
        expect(billing.spaceOf(1n, 'up')).toBe('0.01 MB');
        expect(billing.spaceOf(GIB + 1n, 'up')).toBe('1.01 GB');
        expect(billing.spaceOf(GIB + 1n)).toBe('1 GB');
        expect(billing.spaceOf((15n * GIB) / 10n)).toBe('1.5 GB');
    });
});

describe('family checkout on a tier', () => {
    test('four places are included and the floor; a family with more members buys them all', async () => {
        const organizer = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: organizer.userId, pooled: true });
        await billing.startGroupCheckout(userOf(organizer), groupId, { productId: PRO_FAMILY });
        expect(polar.checkouts.at(-1)).toMatchObject({ units: 4, min_units: 4, max_units: 20 });
        const bigger = await createTestAccount();
        const others = [];
        for (let index = 0; index < 4; index++) others.push(await createTestAccount());
        const five = await createTestFamily({
            organizerId: bigger.userId,
            members: others.map((other) => ({ userId: other.userId, roles: ['members'] })),
            pooled: true,
        });
        await expect(
            billing.startGroupCheckout(userOf(bigger), five.groupId, {
                productId: PLUS,
                units: 4,
            }),
        ).rejects.toMatchObject({ status: 400 });
        await billing.startGroupCheckout(userOf(bigger), five.groupId, { productId: PLUS });
        expect(polar.checkouts.at(-1)).toMatchObject({ units: 5, min_units: 5 });
    });
});

describe('where Polar sends a family’s payer back', () => {
    // The family page is Account → Family, /app/family (docs/families-shared-pool.md 7.2). A
    // return to another page (an old address, or one without the checkout id) would leave the
    // payer without "Finishing your payment…", or on a redirect that might not keep it.
    test('checkout returns to /app/family with the checkout id, and the portal to /app/family', async () => {
        const organizer = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: organizer.userId, pooled: true });
        await billing.startGroupCheckout(userOf(organizer), groupId, { productId: FAMILY });
        expect(polar.checkouts.at(-1)).toMatchObject({
            success_url: 'http://localhost:5173/app/family?checkout_id={CHECKOUT_ID}',
            return_url: 'http://localhost:5173/app/family',
        });
        const { payer, groupId: paid } = await familyOnPlan({ members: 1 });
        await billing.createGroupPortalSession(payer, paid);
        expect(polar.sessions.at(-1)).toMatchObject({
            return_url: 'http://localhost:5173/app/family',
        });
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
            // Their own files exactly, the folders rounded, and nobody else's.
            usage: { ownBytes: '0', foldersBytes: (300n * GIB).toString(), members: null },
        };
        // Exactly these fields: no product, places, payer, status or amounts.
        expect(await billing.getGroupBilling(userOf(member), groupId)).toEqual(glance);
        // A manager without `billing` (familyOnPlan's others hold `members`) gets the same,
        // with each member's own files rounded (see 'who stores what').
        expect(await billing.getGroupBilling(userOf(others[0]!), groupId)).toEqual({
            ...glance,
            usage: { ...glance.usage, members: expect.any(Array) },
        });
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

    test.each(['unpaid', 'incomplete'])(
        'a plan kept while %s is no plan to buy against: another billing holder checks out and becomes the payer',
        async (status) => {
            const { groupId, subscription } = await familyOnPlan({ units: 6 });
            const heir = await createTestAccount();
            await setTestMember({
                groupId,
                userId: heir.userId,
                state: 'active',
                roles: ['billing'],
            });
            // Kept, not ended: Polar may still take a payment for it. But nothing is being
            // charged, and it gives the family nothing, so it holds nobody to it.
            subscription.status = status;
            await billing.reconcileGroup(groupId);
            expect(await billingRepository.getGroupSubscription(subscription.id)).toMatchObject({
                status,
                endedAt: null,
            });
            await billing.startGroupCheckout(userOf(heir), groupId, { productId: FAMILY });
            expect((await billingRepository.getGroupCustomer(groupId))?.payerUserId).toBe(
                heir.userId,
            );
            expect(polar.customers.get(`group:${groupId}`)!.members).toEqual([heir.userId]);
            expect(callsTo('checkouts.create')).toHaveLength(1);
        },
    );

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

describe('family tiers', () => {
    const updates = () => polar.calls.filter((call) => call.startsWith('subscriptions.update'));
    const pool = async (groupId: string) =>
        (await billingRepository.getGroupPool(groupId))?.quotaBytes ?? null;
    const live = (groupId: string) => billingRepository.getLiveGroupSubscription(groupId);

    test('an upgrade changes the product now with invoice proration, and the pool grows at once', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ product: PRO_FAMILY });
        const result = await billing.changeGroupPlan(payer, groupId, MAX_FAMILY);
        expect(updates()).toEqual([
            `subscriptions.update:${subscription.id}:${JSON.stringify({ product_id: MAX_FAMILY, proration_behavior: 'invoice' })}`,
        ]);
        expect(result).toMatchObject({ when: 'now', url: null });
        expect(subscription.product_id).toBe(MAX_FAMILY);
        expect(await pool(groupId)).toBe(MAX_POOL);
        const summary = await priced(Promise.resolve(result.billing));
        expect(summary.subscription).toMatchObject({
            productId: MAX_FAMILY,
            productName: 'Family Max (monthly)',
            quotaBytes: MAX_POOL.toString(),
            pendingProductId: null,
        });
        expect(summary.storage?.quotaBytes).toBe(MAX_POOL.toString());
    });

    test('a downgrade is scheduled for the renewal, recorded, and applies only then', async () => {
        const { payer, groupId, subscription, areaIds } = await familyOnPlan({
            product: MAX_FAMILY,
        });
        await setTestUsedBytes(areaIds[0]!, 100n * GIB);
        const result = await billing.changeGroupPlan(payer, groupId, PLUS);
        expect(result.when).toBe('renewal');
        expect(updates()).toEqual([
            `subscriptions.update:${subscription.id}:${JSON.stringify({ product_id: PLUS, proration_behavior: 'next_period' })}`,
        ]);
        // Nothing changes before the renewal: the family keeps what it paid for.
        expect(subscription.product_id).toBe(MAX_FAMILY);
        expect(await pool(groupId)).toBe(MAX_POOL);
        expect(await live(groupId)).toMatchObject({
            productId: MAX_FAMILY,
            pendingProductId: PLUS,
            intendedProductId: PLUS,
        });
        expect((await priced(Promise.resolve(result.billing))).subscription?.pendingProductId).toBe(
            PLUS,
        );
        // The renewal: Polar applies the pending update and starts a period on Family Plus.
        subscription.product_id = PLUS;
        subscription.pending_update = null;
        subscription.current_period_start = new Date().toISOString();
        subscription.current_period_end = new Date(Date.now() + 30 * DAY).toISOString();
        await billing.reconcileGroup(groupId);
        expect(await pool(groupId)).toBe(PLUS_POOL);
        expect(await live(groupId)).toMatchObject({
            productId: PLUS,
            pendingProductId: null,
            intendedProductId: null,
        });
    });

    test('a downgrade is refused while the family stores more than the smaller pool, and says how much to free', async () => {
        const { payer, groupId, areaIds } = await familyOnPlan({ product: PRO_FAMILY });
        // 1.2 TB in the folders: Family Plus has 800 GB, so 428.8 GB must go first.
        await setTestUsedBytes(areaIds[0]!, (12n * 1024n * GIB) / 10n);
        await expect(billing.changeGroupPlan(payer, groupId, PLUS)).rejects.toMatchObject({
            status: 409,
            message:
                'Your family stores 1.2 TB, more than Family Plus’s 800 GB. Free at least 429 GB, then change the plan.',
        });
        // One byte over: refused, and the amount to free rounds up to a whole GB, never to nothing.
        await setTestUsedBytes(areaIds[0]!, PLUS_POOL + 1n);
        await expect(billing.changeGroupPlan(payer, groupId, PLUS)).rejects.toMatchObject({
            status: 409,
            message: expect.stringContaining('Free at least 1 GB'),
        });
        expect(updates()).toEqual([]);
        expect((await live(groupId))?.intendedProductId).toBeNull();
        // Exactly the smaller pool fits.
        await setTestUsedBytes(areaIds[0]!, PLUS_POOL);
        expect((await billing.changeGroupPlan(payer, groupId, PLUS)).when).toBe('renewal');
    });

    test('a downgrade counts members’ own files with the family folders', async () => {
        const { payer, groupId, areaIds, others } = await familyOnPlan({
            product: PRO_FAMILY,
            members: 1,
        });
        // 100 GB in the folders and 750 GB of one member's own: 850 GB against Plus's 800 GB.
        await setTestUsedBytes(areaIds[0]!, 100n * GIB);
        await setTestUsedBytes(others[0]!.workspaceId, 750n * GIB);
        await expect(billing.changeGroupPlan(payer, groupId, PLUS)).rejects.toMatchObject({
            status: 409,
            message:
                'Your family stores 850 GB, more than Family Plus’s 800 GB. Free at least 50 GB, then change the plan.',
        });
        expect(updates()).toEqual([]);
        await setTestUsedBytes(others[0]!.workspaceId, 700n * GIB);
        expect((await billing.changeGroupPlan(payer, groupId, PLUS)).when).toBe('renewal');
    });

    test('places carry over both ways, and a move never touches the seats', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({
            product: PRO_FAMILY,
            units: 7,
            members: 6,
        });
        expect(await seatLimit(groupId)).toBe(7);
        await billing.changeGroupPlan(payer, groupId, MAX_FAMILY);
        expect(subscription.units).toBe(7);
        expect(await seatLimit(groupId)).toBe(7);
        // Seven places on Max: the base and three members past the four included.
        expect(subscription.amount).toBe(3000 + 3 * 150);
        await billing.changeGroupPlan(payer, groupId, PLUS);
        expect(subscription).toMatchObject({ units: 7, pending_update: { product_id: PLUS } });
        expect(await seatLimit(groupId)).toBe(7);
        expect(await groupsRepository.seatsUsed(groupId)).toBe(7);
    });

    test('a place purchase and an upgrade at once: whichever comes second is refused', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({
            product: PRO_FAMILY,
            units: 4,
            members: 3,
        });
        await setTestMember({
            groupId,
            userId: (await createTestAccount()).userId,
            state: 'accepted',
        });
        // A place is asked for while Polar is taking the upgrade.
        polar.beforeProductChange = async () => {
            expect(await billing.ensureGroupSeat(groupId, payer.id)).toEqual({ status: 'busy' });
        };
        await billing.changeGroupPlan(payer, groupId, MAX_FAMILY);
        expect(subscription).toMatchObject({ product_id: MAX_FAMILY, units: 4 });
        expect(raises().filter((call) => call.includes('"units"'))).toEqual([]);
        // And an upgrade asked for while Polar is taking a raise.
        const other = await familyOnPlan({ product: PLUS, units: 4, members: 3 });
        await setTestMember({
            groupId: other.groupId,
            userId: (await createTestAccount()).userId,
            state: 'accepted',
        });
        polar.beforeRaise = async () => {
            await expect(
                billing.changeGroupPlan(other.payer, other.groupId, MAX_FAMILY),
            ).rejects.toMatchObject({
                status: 409,
                message: 'Another change to this plan is in progress. Try again in a moment.',
            });
        };
        expect(await billing.ensureGroupSeat(other.groupId, other.payer.id)).toEqual({
            status: 'ok',
        });
        expect(other.subscription).toMatchObject({ product_id: PLUS, units: 5 });
        // Both done, the claim is free again.
        expect((await live(other.groupId))?.changeClaimUntil).toBeNull();
    });

    test('an admission that buys a place keeps a scheduled downgrade, and nothing is sent again', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({
            product: PRO_FAMILY,
            units: 4,
            members: 3,
        });
        await billing.changeGroupPlan(payer, groupId, PLUS);
        await setTestMember({
            groupId,
            userId: (await createTestAccount()).userId,
            state: 'accepted',
        });
        polar.calls = [];
        expect(await billing.ensureGroupSeat(groupId, payer.id)).toEqual({ status: 'ok' });
        // The raise drops only Polar's pending units (T1): the move to Family Plus survives.
        expect(updates()).toEqual([
            `subscriptions.update:${subscription.id}:${JSON.stringify({ units: 5, proration_behavior: 'invoice' })}`,
        ]);
        expect(subscription).toMatchObject({
            product_id: PRO_FAMILY,
            units: 5,
            pending_update: { product_id: PLUS },
        });
        expect(await seatLimit(groupId)).toBe(5);
    });

    test('a move Polar lost is re-issued by reconcile; a refusal is queued and the retry puts it in place', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ product: PRO_FAMILY });
        await billing.changeGroupPlan(payer, groupId, PLUS);
        const queued: string[] = [];
        billing.setCutRetryQueue(async (id) => queued.push(id));
        // Lost at Polar (support cleared it, say); asking for it again fails once.
        subscription.pending_update = null;
        const update = fakeClient.subscriptions.update.bind(fakeClient.subscriptions);
        let failures = 1;
        fakeClient.subscriptions.update = async (id, body) => {
            if (body.proration_behavior === 'next_period' && 'product_id' in body && failures-- > 0)
                throw new PolarClientError(503, { error: 'ServiceUnavailable' });
            return update(id, body);
        };
        try {
            await billing.reconcileGroup(groupId);
        } finally {
            fakeClient.subscriptions.update = update;
        }
        expect(subscription.pending_update ?? null).toBeNull();
        expect(queued).toEqual([groupId]);
        expect((await live(groupId))?.intendedProductId).toBe(PLUS);
        await billing.reissueCut(groupId);
        expect(subscription.pending_update).toMatchObject({ product_id: PLUS });
        // Asked again with the move in place, nothing more is sent.
        polar.calls = [];
        await billing.reissueCut(groupId);
        expect(updates()).toEqual([]);
    });

    test('a scheduled cut survives a downgrade, an upgrade and a withdrawn move', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({
            product: PRO_FAMILY,
            units: 8,
        });
        await billing.setGroupUnits(payer, groupId, 6);
        await billing.changeGroupPlan(payer, groupId, PLUS);
        expect(subscription.pending_update).toMatchObject({ units: 6, product_id: PLUS });
        // Keeping Family Pro clears Polar's whole pending update; the cut is asked for again.
        expect((await billing.changeGroupPlan(payer, groupId, PRO_FAMILY)).when).toBe('kept');
        expect(subscription.pending_update).toMatchObject({ units: 6, product_id: null });
        expect(await live(groupId)).toMatchObject({ intendedProductId: null, intendedUnits: 6 });
        // An upgrade drops the whole pending update (T1); the cut comes back, at the new tier.
        await billing.changeGroupPlan(payer, groupId, PLUS);
        await billing.changeGroupPlan(payer, groupId, MAX_FAMILY);
        // The upgrade replaced the move to Family Plus: that is not asked for again.
        expect(subscription).toMatchObject({
            product_id: MAX_FAMILY,
            units: 8,
            pending_update: { units: 6, product_id: null },
        });
        expect((await live(groupId))?.intendedProductId).toBeNull();
        expect(await seatLimit(groupId)).toBe(6);
    });

    test('a renewal is billed at what the payer chose, and reconciles settle with no further writes', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({
            product: PRO_FAMILY,
            units: 8,
        });
        await billing.setGroupUnits(payer, groupId, 6);
        await billing.changeGroupPlan(payer, groupId, PLUS);
        const renewal = () =>
            planAmount(
                subscription.pending_update?.product_id ?? subscription.product_id,
                subscription.pending_update?.units ?? subscription.units ?? 0,
                'usd',
            );
        // Family Plus at six places, not Family Pro at eight (2600) nor either one alone.
        expect(renewal()).toBe(1000 + 2 * 150);
        // Polar loses all of it (the dashboard, support): one reconcile puts back both parts...
        subscription.pending_update = null;
        polar.calls = [];
        await billing.reconcileGroup(groupId);
        expect(updates()).toEqual([
            `subscriptions.update:${subscription.id}:${JSON.stringify({ product_id: PLUS, proration_behavior: 'next_period' })}`,
            `subscriptions.update:${subscription.id}:${JSON.stringify({ units: 6, proration_behavior: 'next_period' })}`,
        ]);
        expect(renewal()).toBe(1300);
        // ...and the deliveries those writes cause, and any later, send nothing.
        polar.calls = [];
        for (let delivery = 0; delivery < 3; delivery++)
            await billing.handleWebhook(
                await signedWebhook({
                    type: 'subscription.updated',
                    data: { id: subscription.id, customer: { external_id: `group:${groupId}` } },
                }),
            );
        expect(
            polar.calls.filter((call) => call.startsWith('customers.getStateExternal')),
        ).toHaveLength(3);
        expect(updates()).toEqual([]);
        expect(renewal()).toBe(1300);
    });

    test('a pending update that never settles is re-issued once per guard window, never per delivery', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ product: PRO_FAMILY });
        polar.ignoresMoves = true;
        await billing.changeGroupPlan(payer, groupId, PLUS);
        expect(subscription.pending_update ?? null).toBeNull();
        const delivery = async () =>
            billing.handleWebhook(
                await signedWebhook({
                    type: 'customer.state_changed',
                    data: { id: 'cus_team', external_id: `group:${groupId}`, type: 'team' },
                }),
            );
        polar.calls = [];
        // The first delivery re-issues; that write's own deliveries, and more, write nothing.
        for (let index = 0; index < 4; index++) await delivery();
        expect(updates()).toHaveLength(1);
        // Past the guard the next reconcile asks once more.
        const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date().getTime() + 16 * 60_000);
        try {
            polar.calls = [];
            await delivery();
            await delivery();
            expect(updates()).toHaveLength(1);
        } finally {
            clock.mockRestore();
        }
    });

    test('the plan is changed by its payer only, and an upgrade needs them in the family', async () => {
        const { payer, groupId, others } = await familyOnPlan({
            product: PRO_FAMILY,
            members: 1,
        });
        const manager = userOf(others[0]!);
        await expect(billing.changeGroupPlan(manager, groupId, MAX_FAMILY)).rejects.toMatchObject({
            status: 403,
        });
        // A payer who has left the family may pay for less, never for more.
        await setTestMember({ groupId, userId: payer.id, state: 'left' });
        await expect(billing.changeGroupPlan(payer, groupId, MAX_FAMILY)).rejects.toMatchObject({
            status: 404,
        });
        expect(updates()).toEqual([]);
        expect((await billing.changeGroupPlan(payer, groupId, PLUS)).when).toBe('renewal');
    });

    test('refused: another billing period, a plan set to end or overdue, an unconfirmed charge, the same plan', async () => {
        // A bigger tier billed yearly is still another billing period.
        const monthly = await familyOnPlan({ product: PLUS });
        await expect(
            billing.changeGroupPlan(monthly.payer, monthly.groupId, PRO_YEARLY),
        ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/monthly plan/) });
        expect(monthly.subscription.product_id).toBe(PLUS);
        const { payer, groupId, subscription } = await familyOnPlan({ product: PRO_FAMILY });
        await expect(billing.changeGroupPlan(payer, groupId, PRO_YEARLY)).rejects.toMatchObject({
            status: 400,
        });
        await expect(billing.changeGroupPlan(payer, groupId, PRO_FAMILY)).rejects.toMatchObject({
            status: 409,
            message: 'The family is already on that plan.',
        });
        // The single plan from before the tiers is no longer offered beside them.
        await expect(billing.changeGroupPlan(payer, groupId, FAMILY)).rejects.toMatchObject({
            status: 404,
        });
        subscription.cancel_at_period_end = true;
        await expect(billing.changeGroupPlan(payer, groupId, MAX_FAMILY)).rejects.toMatchObject({
            status: 409,
            message: expect.stringMatching(/set to end/),
        });
        subscription.cancel_at_period_end = false;
        subscription.status = 'past_due';
        await expect(billing.changeGroupPlan(payer, groupId, PLUS)).rejects.toMatchObject({
            status: 409,
            message: expect.stringMatching(/didn’t go through/),
        });
        subscription.status = 'active';
        expect(updates()).toEqual([]);
        // A raise the bank hasn't confirmed: no second charge on top of it.
        polar.raiseLeavesOrder = true;
        await billing.setGroupUnits(payer, groupId, 5);
        polar.raiseLeavesOrder = false;
        polar.calls = [];
        await expect(billing.changeGroupPlan(payer, groupId, MAX_FAMILY)).rejects.toMatchObject({
            status: 409,
            message: expect.stringMatching(/hasn’t confirmed/),
        });
        expect(updates()).toEqual([]);
    });

    test('a declined upgrade changes nothing; one the bank must confirm goes to the portal', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ product: PLUS });
        polar.raiseRefusal = { error: 'PaymentFailed', detail: 'card_error' };
        await expect(billing.changeGroupPlan(payer, groupId, MAX_FAMILY)).rejects.toMatchObject({
            status: 402,
            message: expect.stringMatching(/plan didn’t change/),
        });
        expect(subscription.product_id).toBe(PLUS);
        expect(await pool(groupId)).toBe(PLUS_POOL);
        polar.raiseRefusal = { error: 'PaymentActionRequired', detail: 'action' };
        expect(await billing.changeGroupPlan(payer, groupId, MAX_FAMILY)).toMatchObject({
            confirmPayment: true,
            url: expect.stringContaining(payer.id),
        });
        expect(await pool(groupId)).toBe(PLUS_POOL);
        // Polar took the change but its order waits for the bank: the portal, and no bigger pool.
        polar.raiseRefusal = null;
        polar.raiseLeavesOrder = true;
        expect(await billing.changeGroupPlan(payer, groupId, MAX_FAMILY)).toMatchObject({
            confirmPayment: true,
            when: 'now',
        });
        expect(subscription.product_id).toBe(MAX_FAMILY);
        expect(await pool(groupId)).toBe(PLUS_POOL);
    });

    test('an unpaid upgrade keeps the old pool; once its order is paid, the new one', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({
            product: PRO_FAMILY,
            units: 5,
        });
        polar.raiseLeavesOrder = true;
        const result = await billing.changeGroupPlan(payer, groupId, MAX_FAMILY);
        polar.raiseLeavesOrder = false;
        expect(result).toMatchObject({
            confirmPayment: true,
            url: expect.stringContaining(payer.id),
        });
        expect(subscription.product_id).toBe(MAX_FAMILY);
        expect(await pool(groupId)).toBe(FAMILY_POOL);
        expect(await live(groupId)).toMatchObject({
            productId: MAX_FAMILY,
            paidProductId: PRO_FAMILY,
            paidQuotaBytes: FAMILY_POOL,
            paidUnits: 5,
        });
        expect((await priced(Promise.resolve(result.billing))).subscription?.paidProductId).toBe(
            PRO_FAMILY,
        );
        await billing.reconcileGroup(groupId);
        expect(await pool(groupId)).toBe(FAMILY_POOL);
        // A newer paid order for Family Max that pays for no tier (a one-off purchase): nothing.
        polar.orders.push({
            id: 'order_purchase',
            subscription_id: subscription.id,
            status: 'paid',
            due_amount: 0,
            created_at: new Date(Date.now() + 60_000).toISOString(),
            product_id: MAX_FAMILY,
            billing_reason: 'purchase',
        });
        await billing.reconcileGroup(groupId);
        expect(await pool(groupId)).toBe(FAMILY_POOL);
        polar.orders.pop();
        // Orders that can't be read change nothing either way.
        polar.ordersFail = true;
        await billing.reconcileGroup(groupId);
        expect(await live(groupId)).toMatchObject({ paidProductId: PRO_FAMILY });
        polar.ordersFail = false;
        // Paid: the bigger pool now.
        for (const order of polar.orders) order.status = 'paid';
        await billing.reconcileGroup(groupId);
        expect(await pool(groupId)).toBe(MAX_POOL);
        expect(await live(groupId)).toMatchObject({ paidProductId: MAX_FAMILY, paidUnits: 5 });
    });

    test('a paid renewal of the bigger tier gives it, though the change order still waits', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ product: PLUS });
        polar.raiseLeavesOrder = true;
        await billing.changeGroupPlan(payer, groupId, MAX_FAMILY);
        polar.raiseLeavesOrder = false;
        expect(await pool(groupId)).toBe(PLUS_POOL);
        // The period ends on Family Max and its renewal is paid; the change order never was.
        renew(subscription, MAX_FAMILY);
        await billing.reconcileGroup(groupId);
        expect(await pool(groupId)).toBe(MAX_POOL);
        expect(await live(groupId)).toMatchObject({
            paidProductId: MAX_FAMILY,
            tierMismatchSince: null,
        });
    });

    test('a partial refund keeps the tier; a refund in full falls back to the order paid before', async () => {
        const { payer, groupId } = await familyOnPlan({ product: PLUS });
        await billing.changeGroupPlan(payer, groupId, MAX_FAMILY);
        expect(await pool(groupId)).toBe(MAX_POOL);
        const upgrade = polar.orders.find((order) => order.product_id === MAX_FAMILY)!;
        // A goodwill credit of 3.00 of the 10.00: the upgrade still pays for Family Max.
        upgrade.status = 'partially_refunded';
        upgrade.refunded_amount = 300;
        await billing.reconcileGroup(groupId);
        expect(await pool(groupId)).toBe(MAX_POOL);
        // Refunded whole (support, a dispute): back to Family Plus's pool, by either sign.
        upgrade.refunded_amount = 1000;
        await billing.reconcileGroup(groupId);
        expect(await pool(groupId)).toBe(PLUS_POOL);
        upgrade.refunded_amount = 0;
        upgrade.status = 'refunded';
        await billing.reconcileGroup(groupId);
        expect(await pool(groupId)).toBe(PLUS_POOL);
        expect(await live(groupId)).toMatchObject({ productId: MAX_FAMILY, paidProductId: PLUS });
        // And nothing paid at all once the checkout is refunded too.
        polar.checkoutOrders[0]!.status = 'refunded';
        await billing.reconcileGroup(groupId);
        expect(await pool(groupId)).toBe(0n);
    });

    test('a second upgrade is refused while the first waits for the bank; a downgrade is not', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ product: PLUS });
        polar.raiseLeavesOrder = true;
        await billing.changeGroupPlan(payer, groupId, PRO_FAMILY);
        polar.raiseLeavesOrder = false;
        polar.calls = [];
        await expect(billing.changeGroupPlan(payer, groupId, MAX_FAMILY)).rejects.toMatchObject({
            status: 409,
            message: expect.stringMatching(/hasn’t confirmed/),
        });
        expect(updates()).toEqual([]);
        expect(subscription.product_id).toBe(PRO_FAMILY);
        expect(await pool(groupId)).toBe(PLUS_POOL);
    });

    test('an upgrade left unpaid past seven days is reverted at the period end; the revert goes if it is paid', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ product: PLUS });
        polar.raiseLeavesOrder = true;
        await billing.changeGroupPlan(payer, groupId, MAX_FAMILY);
        polar.raiseLeavesOrder = false;
        // Six days: not yet, though another order (a raise's) has waited eight. The upgrade's
        // order was made six days ago.
        const upgrade = polar.orders.find((order) => order.product_id === MAX_FAMILY)!;
        await rawSql(
            `update group_billing_subscriptions set tier_mismatch_since = null where group_id = '${groupId}'`,
        );
        upgrade.created_at = new Date(Date.now() - 6 * DAY).toISOString();
        polar.orders.push({
            id: 'order_raise',
            subscription_id: subscription.id,
            status: 'pending',
            due_amount: 235,
            created_at: new Date(Date.now() - 8 * DAY).toISOString(),
            product_id: PLUS,
        });
        await billing.reconcileGroup(groupId);
        expect(subscription.pending_update?.product_id ?? null).toBeNull();
        polar.orders.pop();
        upgrade.created_at = new Date(Date.now() - 8 * DAY).toISOString();
        await billing.reconcileGroup(groupId);
        // Renews on Family Plus, the tier paid for, never on the unpaid Family Max.
        expect(subscription).toMatchObject({
            product_id: MAX_FAMILY,
            pending_update: { product_id: PLUS },
        });
        expect(await live(groupId)).toMatchObject({
            intendedProductId: PLUS,
            intendedProductStale: true,
        });
        expect(await pool(groupId)).toBe(PLUS_POOL);
        // Paid after all: the revert is withdrawn and Family Max is the family's.
        upgrade.status = 'paid';
        await billing.reconcileGroup(groupId);
        expect(subscription.pending_update ?? null).toBeNull();
        expect(await live(groupId)).toMatchObject({
            intendedProductId: null,
            paidProductId: MAX_FAMILY,
            tierMismatchSince: null,
        });
        expect(await pool(groupId)).toBe(MAX_POOL);
    });

    test('no place is bought while an upgrade waits for the bank', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({
            product: PRO_FAMILY,
            units: 4,
            members: 3,
        });
        polar.raiseLeavesOrder = true;
        await billing.changeGroupPlan(payer, groupId, MAX_FAMILY);
        polar.raiseLeavesOrder = false;
        await setTestMember({
            groupId,
            userId: (await createTestAccount()).userId,
            state: 'accepted',
        });
        polar.calls = [];
        expect(await billing.ensureGroupSeat(groupId, payer.id)).toMatchObject({
            status: 'confirm',
        });
        await expect(billing.setGroupUnits(payer, groupId, 6)).resolves.toMatchObject({
            confirmPayment: true,
        });
        expect(raises()).toEqual([]);
        expect(subscription.units).toBe(4);
    });

    test('a revert withdrawal Polar refuses keeps its record, and the retry withdraws it', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ product: PLUS });
        polar.raiseLeavesOrder = true;
        await billing.changeGroupPlan(payer, groupId, MAX_FAMILY);
        polar.raiseLeavesOrder = false;
        const order = polar.orders.find((candidate) => candidate.product_id === MAX_FAMILY)!;
        // Its order made eight days ago.
        order.created_at = new Date(Date.now() - 8 * DAY).toISOString();
        await billing.reconcileGroup(groupId);
        expect(subscription.pending_update).toMatchObject({ product_id: PLUS });
        // Paid after all; clearing the revert at Polar fails once.
        order.status = 'paid';
        const queued: string[] = [];
        billing.setCutRetryQueue(async (id) => queued.push(id));
        const update = fakeClient.subscriptions.update.bind(fakeClient.subscriptions);
        let failures = 1;
        fakeClient.subscriptions.update = async (id, body) => {
            if ('pending_update' in body && failures-- > 0)
                throw new PolarClientError(503, { error: 'ServiceUnavailable' });
            return update(id, body);
        };
        try {
            await billing.reconcileGroup(groupId);
        } finally {
            fakeClient.subscriptions.update = update;
        }
        expect(queued).toEqual([groupId]);
        expect(subscription.pending_update).toMatchObject({ product_id: PLUS });
        expect(await live(groupId)).toMatchObject({
            intendedProductId: PLUS,
            intendedProductStale: true,
        });
        // The retry job: Polar first, then the record.
        await billing.reissueCut(groupId);
        expect(subscription.pending_update ?? null).toBeNull();
        expect(await live(groupId)).toMatchObject({ intendedProductId: null });
        expect(await pool(groupId)).toBe(MAX_POOL);
    });

    test('a move dropped inside the guard window is re-sent when the window ends, before the renewal', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ product: PRO_FAMILY });
        await billing.changeGroupPlan(payer, groupId, PLUS);
        const queued: [string, number | undefined][] = [];
        billing.setCutRetryQueue(async (id, after) => queued.push([id, after]));
        const delivery = async () =>
            billing.handleWebhook(
                await signedWebhook({
                    type: 'customer.state_changed',
                    data: { id: 'cus_team', external_id: `group:${groupId}`, type: 'team' },
                }),
            );
        // Lost once: the next delivery re-sends it.
        subscription.pending_update = null;
        await delivery();
        expect(subscription.pending_update).toMatchObject({ product_id: PLUS });
        // Lost again inside the window: nothing is sent, and a retry is queued for its end.
        subscription.pending_update = null;
        polar.calls = [];
        await delivery();
        expect(updates()).toEqual([]);
        expect(queued).toHaveLength(1);
        expect(queued[0]![0]).toBe(groupId);
        expect(queued[0]![1]).toBeGreaterThan(14 * 60);
        expect(queued[0]![1]).toBeLessThanOrEqual(15 * 60);
        // The retry runs when the window ends, before the period does.
        const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date().getTime() + 15 * 60_000);
        try {
            await billing.reissueCut(groupId);
        } finally {
            clock.mockRestore();
        }
        expect(subscription.pending_update).toMatchObject({ product_id: PLUS });
        // The renewal applies it: Family Plus and its pool.
        subscription.product_id = PLUS;
        subscription.pending_update = null;
        await billing.reconcileGroup(groupId);
        expect(await pool(groupId)).toBe(PLUS_POOL);
        expect((await live(groupId))?.intendedProductId).toBeNull();
    });

    test('deliveries inside the window queue one retry, however many arrive', async () => {
        const { payer, groupId } = await familyOnPlan({ product: PRO_FAMILY });
        polar.ignoresMoves = true;
        await billing.changeGroupPlan(payer, groupId, PLUS);
        const queued: string[] = [];
        billing.setCutRetryQueue(async (id) => queued.push(id));
        const delivery = async () =>
            billing.handleWebhook(
                await signedWebhook({
                    type: 'customer.state_changed',
                    data: { id: 'cus_team', external_id: `group:${groupId}`, type: 'team' },
                }),
            );
        polar.calls = [];
        for (let index = 0; index < 8; index++) await delivery();
        // One re-send, then the window: one retry queued for its end, not seven.
        expect(updates()).toHaveLength(1);
        expect(queued).toEqual([groupId]);
    });

    test('a Polar that never keeps the change is asked five times, then left to operators', async () => {
        const { payer, groupId } = await familyOnPlan({ product: PRO_FAMILY });
        polar.ignoresMoves = true;
        await billing.changeGroupPlan(payer, groupId, PLUS);
        polar.calls = [];
        // The retry job, again and again (it isn't held back by the window).
        for (let index = 0; index < 10; index++) await billing.reissueCut(groupId);
        expect(updates()).toHaveLength(billing.MAX_REISSUES);
        expect((await live(groupId))?.reissueAttempts).toBe(billing.MAX_REISSUES);
        // Polar holds it at last: the count starts again.
        polar.ignoresMoves = false;
        const subscription = polar.subscriptions.get((await live(groupId))!.id)!;
        subscription.pending_update = {
            units: null,
            product_id: PLUS,
            applies_at: subscription.current_period_end,
        };
        await billing.reissueCut(groupId);
        expect((await live(groupId))?.reissueAttempts).toBe(0);
    });

    test('a place is refused while Polar holds an upgrade the row hasn’t caught up with', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({
            product: PRO_FAMILY,
            units: 4,
            members: 3,
        });
        // Polar moved to Family Max and HushOS never wrote it (a write that failed).
        subscription.product_id = MAX_FAMILY;
        await setTestMember({
            groupId,
            userId: (await createTestAccount()).userId,
            state: 'accepted',
        });
        polar.calls = [];
        expect((await billing.ensureGroupSeat(groupId, payer.id)).status).toBe('confirm');
        expect(raises()).toEqual([]);
        expect(subscription.units).toBe(4);
    });

    test('an upgrade the bank must confirm, which Polar kept, is written as Polar holds it', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ product: PLUS });
        polar.raiseLeavesOrder = true;
        polar.raiseRefusal = { error: 'PaymentActionRequired', detail: 'action' };
        expect(await billing.changeGroupPlan(payer, groupId, MAX_FAMILY)).toMatchObject({
            confirmPayment: true,
        });
        expect(subscription.product_id).toBe(MAX_FAMILY);
        expect(await live(groupId)).toMatchObject({
            productId: MAX_FAMILY,
            paidProductId: PLUS,
        });
        expect(await pool(groupId)).toBe(PLUS_POOL);
    });

    test('an upgrade whose write fails after Polar took it is reconciled at once', async () => {
        const { payer, groupId } = await familyOnPlan({ product: PLUS });
        // The database refuses the first write of Family Max (a sequence survives the rollback).
        await rawSql(`
            create sequence if not exists test_fail_once;
            create or replace function test_fail_once() returns trigger language plpgsql as $$
            begin
                if new.product_id = '${MAX_FAMILY}' and nextval('test_fail_once') = 1 then
                    raise exception 'injected write failure';
                end if;
                return new;
            end $$;
            create trigger test_fail_once before update on group_billing_subscriptions
                for each row execute function test_fail_once();
        `);
        try {
            expect((await billing.changeGroupPlan(payer, groupId, MAX_FAMILY)).when).toBe('now');
        } finally {
            await rawSql(`
                drop trigger if exists test_fail_once on group_billing_subscriptions;
                drop function if exists test_fail_once();
                drop sequence if exists test_fail_once;
            `);
        }
        expect(await live(groupId)).toMatchObject({
            productId: MAX_FAMILY,
            paidProductId: MAX_FAMILY,
        });
        expect(await pool(groupId)).toBe(MAX_POOL);
    });

    test('a first checkout unpaid past seven days is never "reverted" to itself', async () => {
        const organizer = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: organizer.userId, pooled: true });
        await billing.startGroupCheckout(userOf(organizer), groupId, { productId: PRO_FAMILY });
        familySubscription(
            groupId,
            {
                product_id: PRO_FAMILY,
                units: 4,
                current_period_start: new Date(Date.now() - 8 * DAY).toISOString(),
            },
            'pending',
        );
        await billing.reconcileGroup(groupId);
        expect(await pool(groupId)).toBe(0n);
        polar.calls = [];
        await billing.reconcileGroup(groupId);
        await billing.reconcileGroup(groupId);
        expect(updates()).toEqual([]);
        expect((await live(groupId))?.intendedProductId).toBeNull();
        // Paid: its pool.
        polar.checkoutOrders[0]!.status = 'paid';
        await billing.reconcileGroup(groupId);
        expect(await pool(groupId)).toBe(FAMILY_POOL);
    });

    test('outages don’t count toward giving up; answers of 200 that Polar didn’t keep do', async () => {
        const { payer, groupId } = await familyOnPlan({ product: PRO_FAMILY });
        await billing.changeGroupPlan(payer, groupId, PLUS);
        const subscription = polar.subscriptions.get((await live(groupId))!.id)!;
        subscription.pending_update = null;
        // Polar is down for ten tries: each throws, none counts.
        const update = fakeClient.subscriptions.update.bind(fakeClient.subscriptions);
        fakeClient.subscriptions.update = async () => {
            throw new PolarClientError(503, { error: 'ServiceUnavailable' });
        };
        try {
            for (let index = 0; index < 10; index++)
                await expect(billing.reissueCut(groupId)).rejects.toBeDefined();
        } finally {
            fakeClient.subscriptions.update = update;
        }
        expect((await live(groupId))?.reissueAttempts).toBe(0);
        // Up again, but keeping nothing: those count, and stop at the cap.
        polar.ignoresMoves = true;
        polar.calls = [];
        for (let index = 0; index < 10; index++) await billing.reissueCut(groupId);
        expect(updates()).toHaveLength(billing.MAX_REISSUES);
        expect((await live(groupId))?.reissueAttempts).toBe(billing.MAX_REISSUES);
    });

    test('giving up puts the family in front of operators until Polar holds the change', async () => {
        const { payer, groupId } = await familyOnPlan({ product: PRO_FAMILY });
        polar.ignoresMoves = true;
        await billing.changeGroupPlan(payer, groupId, PLUS);
        expect(await billingRepository.listGivenUpReissues()).toEqual([]);
        for (let index = 0; index <= billing.MAX_REISSUES; index++)
            await billing.reissueCut(groupId);
        const subscriptionId = (await live(groupId))!.id;
        expect(await billingRepository.listGivenUpReissues()).toEqual([
            {
                groupId,
                subscriptionId,
                wanted: JSON.stringify({ units: null, product: PLUS }),
                reason: 'not-kept',
                since: expect.any(Date),
            },
        ]);
        // An operator sets it in Polar's dashboard: the next pass finds it held, and it goes.
        const subscription = polar.subscriptions.get(subscriptionId)!;
        subscription.pending_update = {
            units: null,
            product_id: PLUS,
            applies_at: subscription.current_period_end,
        };
        await billing.reissueCut(groupId);
        expect(await billingRepository.listGivenUpReissues()).toEqual([]);
        expect((await live(groupId))?.reissueAttempts).toBe(0);
    });

    test('a retry that can’t be queued lets its claim go, so the next one can', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ product: PRO_FAMILY });
        await billing.changeGroupPlan(payer, groupId, PLUS);
        let fail = true;
        const queued: string[] = [];
        billing.setCutRetryQueue(async (id) => {
            if (fail) throw new Error('queue billing.reissue-pending does not exist');
            queued.push(id);
        });
        const lose = async () => {
            subscription.pending_update = null;
            const update = fakeClient.subscriptions.update.bind(fakeClient.subscriptions);
            fakeClient.subscriptions.update = async () => {
                throw new PolarClientError(503, { error: 'ServiceUnavailable' });
            };
            try {
                await billing.reconcileGroup(groupId);
            } finally {
                fakeClient.subscriptions.update = update;
            }
        };
        await lose();
        expect((await live(groupId))?.reissueRetryAt).toBeNull();
        fail = false;
        await lose();
        expect(queued).toEqual([groupId]);
    });

    test('orders that can’t be read leave a paid tier in force', async () => {
        const { groupId } = await familyOnPlan({ product: PRO_FAMILY });
        polar.ordersFail = true;
        await billing.reconcileGroup(groupId);
        expect(await pool(groupId)).toBe(FAMILY_POOL);
        expect((await live(groupId))?.paidProductId).toBe(PRO_FAMILY);
    });

    test('no upgrade goes on top of a product Polar holds and HushOS hasn’t seen paid', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ product: PLUS });
        // Polar moved to Family Pro behind HushOS's back (a write that failed); the row says Plus.
        subscription.product_id = PRO_FAMILY;
        polar.calls = [];
        await expect(billing.changeGroupPlan(payer, groupId, MAX_FAMILY)).rejects.toMatchObject({
            status: 409,
        });
        expect(updates()).toEqual([]);
    });

    test('the seven days run from when HushOS first saw an unpaid upgrade, whatever orders show', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ product: PLUS });
        // The change's order isn't listed: only HushOS's own date can start the clock.
        polar.ordersLag = true;
        await billing.changeGroupPlan(payer, groupId, MAX_FAMILY);
        polar.ordersLag = false;
        await billing.reconcileGroup(groupId);
        expect(subscription.pending_update ?? null).toBeNull();
        await rawSql(
            `update group_billing_subscriptions set tier_mismatch_since = now() - interval '8 days' where group_id = '${groupId}'`,
        );
        await billing.reconcileGroup(groupId);
        expect(subscription.pending_update).toMatchObject({ product_id: PLUS });
    });

    test('a re-send Polar keeps starts the count again', async () => {
        const { payer, groupId } = await familyOnPlan({ product: PRO_FAMILY });
        polar.ignoresMoves = true;
        await billing.changeGroupPlan(payer, groupId, PLUS);
        await billing.reissueCut(groupId);
        await billing.reissueCut(groupId);
        expect((await live(groupId))?.reissueAttempts).toBe(2);
        polar.ignoresMoves = false;
        await billing.reissueCut(groupId);
        expect((await live(groupId))?.reissueAttempts).toBe(0);
    });

    test('an old unpaid order for the same tier doesn’t start the clock on a fresh upgrade', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ product: PLUS });
        // Months ago an upgrade to Family Max was never paid (and was reverted).
        polar.orders.push({
            id: 'order_old_max',
            subscription_id: subscription.id,
            status: 'pending',
            due_amount: 1000,
            created_at: new Date(Date.now() - 90 * DAY).toISOString(),
            product_id: MAX_FAMILY,
            billing_reason: 'subscription_update',
        });
        polar.raiseLeavesOrder = true;
        await billing.changeGroupPlan(payer, groupId, MAX_FAMILY);
        polar.raiseLeavesOrder = false;
        await billing.reconcileGroup(groupId);
        expect(subscription.pending_update ?? null).toBeNull();
        expect(Date.now() - (await live(groupId))!.tierMismatchSince!.getTime()).toBeLessThan(DAY);
    });

    test('a refund since the last reconcile is read before a place is bought', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({
            product: PLUS,
            units: 4,
            members: 3,
        });
        await billing.changeGroupPlan(payer, groupId, MAX_FAMILY);
        expect((await live(groupId))?.paidProductId).toBe(MAX_FAMILY);
        // Refunded at Polar; no delivery has arrived yet.
        const upgrade = polar.orders.find((order) => order.product_id === MAX_FAMILY)!;
        upgrade.status = 'refunded';
        upgrade.refunded_amount = 1000;
        await setTestMember({
            groupId,
            userId: (await createTestAccount()).userId,
            state: 'accepted',
        });
        polar.calls = [];
        expect((await billing.ensureGroupSeat(groupId, payer.id)).status).toBe('confirm');
        expect(raises()).toEqual([]);
        expect(subscription.units).toBe(4);
        expect((await live(groupId))?.paidProductId).toBe(PLUS);
    });

    test('an unpaid upgrade whose paid plan is no longer offered stays small and goes to operators', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ product: PLUS });
        polar.raiseLeavesOrder = true;
        await billing.changeGroupPlan(payer, groupId, MAX_FAMILY);
        polar.raiseLeavesOrder = false;
        polar.orders.find((order) => order.product_id === MAX_FAMILY)!.created_at = new Date(
            Date.now() - 8 * DAY,
        ).toISOString();
        const plus = polar.products.find((candidate) => candidate.id === PLUS)!;
        const clock = vi.spyOn(Date, 'now');
        catalogueClock += 10 * 60_000;
        try {
            plus.is_archived = true;
            clock.mockReturnValue(new Date().getTime() + catalogueClock);
            polar.calls = [];
            for (let index = 0; index < 3; index++) await billing.reconcileGroup(groupId);
            // No move back to a plan not on sale, and no loop asking for one.
            expect(updates()).toEqual([]);
            expect(subscription.pending_update ?? null).toBeNull();
            expect((await live(groupId))?.intendedProductId).toBeNull();
            expect(await pool(groupId)).toBe(PLUS_POOL);
            expect(await billingRepository.listGivenUpReissues()).toEqual([
                expect.objectContaining({ groupId, reason: 'revert-unavailable' }),
            ]);
            // Paid after all: no longer stuck.
            polar.orders.find((order) => order.product_id === MAX_FAMILY)!.status = 'paid';
            await billing.reconcileGroup(groupId);
            expect(await billingRepository.listGivenUpReissues()).toEqual([]);
            expect(await pool(groupId)).toBe(MAX_POOL);
        } finally {
            plus.is_archived = false;
            clock.mockReturnValue(new Date().getTime() + catalogueClock + 5 * 60_000);
            await billing.listCatalogue();
            clock.mockRestore();
        }
    });

    test('a 100%-off checkout, which charged nothing, pays for its tier', async () => {
        const organizer = await createTestAccount();
        const { groupId } = await createTestFamily({ organizerId: organizer.userId, pooled: true });
        await billing.startGroupCheckout(userOf(organizer), groupId, { productId: PRO_FAMILY });
        familySubscription(groupId, { product_id: PRO_FAMILY, units: 4, amount: 0 });
        // As the sandbox showed: paid, net 0, nothing refunded.
        polar.checkoutOrders[0]!.net_amount = 0;
        await billing.reconcileGroup(groupId);
        expect(await pool(groupId)).toBe(FAMILY_POOL);
        expect((await live(groupId))?.paidProductId).toBe(PRO_FAMILY);
    });

    test('a raise Polar billed on another product is not credited, nor its order', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({
            product: PRO_FAMILY,
            units: 4,
            members: 3,
        });
        await setTestMember({
            groupId,
            userId: (await createTestAccount()).userId,
            state: 'accepted',
        });
        // Someone moves the plan to Family Max in Polar's dashboard while the raise is on its way;
        // Polar bills the raise on Family Max and its order is paid.
        polar.beforeRaise = async () => {
            subscription.product_id = MAX_FAMILY;
        };
        const update = fakeClient.subscriptions.update.bind(fakeClient.subscriptions);
        fakeClient.subscriptions.update = async (id, body) => {
            const answer = await update(id, body);
            if (body.proration_behavior === 'invoice' && typeof body.units === 'number')
                polar.orders.push({
                    id: 'order_raise_on_max',
                    subscription_id: id,
                    status: 'paid',
                    due_amount: 0,
                    created_at: new Date().toISOString(),
                    product_id: MAX_FAMILY,
                    billing_reason: 'subscription_update',
                    units: body.units,
                });
            return answer;
        };
        try {
            const result = await billing.ensureGroupSeat(groupId, payer.id);
            expect(result).toEqual({ status: 'changed' });
            // Polar charged: the payer is told so, never asked to try again.
            const told = billing.seatError(result as { status: 'changed' }).message;
            expect(told).toBe(
                'The charge went through but the plan changed at the same time. Refresh to see your places.',
            );
            expect(told).not.toMatch(/try again/i);
        } finally {
            fakeClient.subscriptions.update = update;
        }
        // Nobody is let in on it, and the paid raise on Family Max never pays for Family Max:
        // the family keeps Family Pro's tier and pool (the places themselves were paid for).
        expect(await live(groupId)).toMatchObject({
            productId: MAX_FAMILY,
            paidProductId: PRO_FAMILY,
            uncreditedOrderIds: ['order_raise_on_max'],
        });
        expect(await pool(groupId)).toBe(FAMILY_POOL);
        await billing.reconcileGroup(groupId);
        expect(await pool(groupId)).toBe(FAMILY_POOL);
    });

    test('the upgrade guard reads the tier paid for from Polar, not the row', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ product: PLUS });
        await billing.changeGroupPlan(payer, groupId, PRO_FAMILY);
        expect((await live(groupId))?.paidProductId).toBe(PRO_FAMILY);
        // Family Pro refunded at Polar; no delivery has arrived. The row still says it's paid.
        const order = polar.orders.find((candidate) => candidate.product_id === PRO_FAMILY)!;
        order.status = 'refunded';
        order.refunded_amount = 1000;
        polar.calls = [];
        await expect(billing.changeGroupPlan(payer, groupId, MAX_FAMILY)).rejects.toMatchObject({
            status: 409,
            message: expect.stringMatching(/hasn’t confirmed/),
        });
        expect(updates()).toEqual([]);
        expect(subscription.product_id).toBe(PRO_FAMILY);
    });

    test('a claim left by a change that never finished lapses; one still running holds', async () => {
        const { payer, groupId } = await familyOnPlan({
            product: PRO_FAMILY,
            units: 4,
            members: 3,
        });
        await setTestMember({
            groupId,
            userId: (await createTestAccount()).userId,
            state: 'accepted',
        });
        const set = (interval: string) =>
            rawSql(
                `update group_billing_subscriptions set change_claim_until = now() + interval '${interval}' where group_id = '${groupId}'`,
            );
        await set('1 minute');
        expect(await billing.ensureGroupSeat(groupId, payer.id)).toEqual({ status: 'busy' });
        await set('-1 minute');
        expect(await billing.ensureGroupSeat(groupId, payer.id)).toEqual({ status: 'ok' });
    });

    test('a raise that lands between the first read and the claim is seen by the upgrade’s guard', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({ product: PLUS, units: 4 });
        // Right after the upgrade's first read, a place purchase finishes at Polar, its charge
        // still waiting for the bank.
        polar.afterGet = () => {
            subscription.units = 5;
            polar.orders.push({
                id: 'order_raise_waiting',
                subscription_id: subscription.id,
                status: 'pending',
                due_amount: 150,
                created_at: new Date().toISOString(),
                product_id: PLUS,
                billing_reason: 'subscription_update',
                units: 5,
            });
        };
        polar.calls = [];
        await expect(billing.changeGroupPlan(payer, groupId, MAX_FAMILY)).rejects.toMatchObject({
            status: 409,
            message: expect.stringMatching(/hasn’t confirmed/),
        });
        expect(updates()).toEqual([]);
        expect(subscription.product_id).toBe(PLUS);
    });

    test('a change that outlived its claim releases only its own, never a newer one', async () => {
        const { payer, groupId } = await familyOnPlan({ product: PLUS });
        const sub = (await live(groupId))!.id;
        let newer: Date | null = null;
        // Polar is slow: the upgrade's claim runs out and another change takes the family's.
        polar.beforeProductChange = async () => {
            await rawSql(
                `update group_billing_subscriptions set change_claim_until = now() - interval '1 second' where id = '${sub}'`,
            );
            newer = await billingRepository.claimPlanChange(sub, 60_000);
            expect(newer).not.toBeNull();
        };
        await billing.changeGroupPlan(payer, groupId, MAX_FAMILY);
        expect((await live(groupId))?.changeClaimUntil).toEqual(newer);
        // While it is held, nothing else gets in, whatever this server's clock says.
        const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date().getTime() + 10 * 60_000);
        try {
            expect(await billingRepository.claimPlanChange(sub, 60_000)).toBeNull();
        } finally {
            clock.mockRestore();
        }
        await billingRepository.releasePlanChange(sub, newer!);
        expect((await live(groupId))?.changeClaimUntil).toBeNull();
    });

    test('an upgrade that lands between a place purchase’s first read and its claim stops the raise', async () => {
        const { payer, groupId, subscription } = await familyOnPlan({
            product: PLUS,
            units: 4,
            members: 3,
        });
        await setTestMember({
            groupId,
            userId: (await createTestAccount()).userId,
            state: 'accepted',
        });
        // Right after the place purchase's first read, an upgrade to Family Max finishes at
        // Polar, its charge still waiting for the bank.
        polar.afterGet = () => {
            subscription.product_id = MAX_FAMILY;
            polar.orders.push({
                id: 'order_upgrade_waiting',
                subscription_id: subscription.id,
                status: 'pending',
                due_amount: 2000,
                created_at: new Date().toISOString(),
                product_id: MAX_FAMILY,
                billing_reason: 'subscription_update',
            });
        };
        polar.calls = [];
        expect((await billing.ensureGroupSeat(groupId, payer.id)).status).toBe('confirm');
        expect(raises()).toEqual([]);
        expect(subscription.units).toBe(4);
    });
});

/* ------------------------------------------------------------------------- */
/* A pooled member's personal plan (docs/families-shared-pool.md 5.1)         */
/* ------------------------------------------------------------------------- */

const HOUR = 60 * 60 * 1000;
type FakeOrder = (typeof polar.orders)[number];

/*
 * A member of a family on a live plan who also pays for Pro: the subscription at
 * Polar, its orders, and HushOS's mirror of it, then let in (what an admission
 * does once it commits: queuePlanEnding). By default the period is 30 days, half
 * used at `now` (whole seconds), with one renewal order of 999 before tax and
 * 180 of tax on top. Polar's clock puts the revoke at `now`.
 */
async function pooledSubscriber(
    options: {
        periodStart?: number;
        periodEnd?: number;
        orders?: (now: number) => Partial<FakeOrder>[];
    } = {},
) {
    const { payer, groupId } = await familyOnPlan();
    const member = await createTestAccount();
    const now = Math.floor(Date.now() / 1000) * 1000;
    const subscription = subscribe(member.userId, {
        id: 'sub_personal',
        current_period_start: new Date(now + (options.periodStart ?? -15 * DAY)).toISOString(),
        current_period_end: new Date(now + (options.periodEnd ?? 15 * DAY)).toISOString(),
        amount: 999,
    });
    const orders = options.orders?.(now) ?? [
        {
            id: 'order_cycle',
            created_at: subscription.current_period_start!,
            billing_reason: 'subscription_cycle',
            net_amount: 999,
            tax_amount: 180,
        },
    ];
    for (const order of orders)
        polar.orders.push({
            id: 'order_x',
            subscription_id: subscription.id,
            status: 'paid',
            due_amount: 0,
            created_at: new Date(now).toISOString(),
            product_id: PRO,
            currency: 'usd',
            ...order,
        });
    await billing.reconcileCustomer(member.userId);
    // Nothing is queued while they are not in the family.
    expect(endingJobs).toEqual([]);
    await setTestMember({ groupId, userId: member.userId, state: 'active' });
    expect(await billing.queuePlanEnding(member.userId)).toBe(true);
    polar.revokeAt = new Date(now).toISOString();
    polar.calls = [];
    return { member, groupId, payer, subscription, now, job: endingJobs[0]! };
}

const refundsMade = () => polar.refunds.map((refund) => [refund.order_id, refund.amount]);
const callsTo = (prefix: string) => polar.calls.filter((call) => call.startsWith(prefix));

/* Runs every job queued since `from`, as the worker would, one after another. */
async function runQueued(from: number) {
    for (const job of endingJobs.slice(from)) await billing.endPersonalPlans(job);
}

describe('a personal plan ends when its owner’s files join a family', () => {
    test('revoked at once and the unused half refunded before tax, exactly once across a retry, a webhook replay and a reconcile', async () => {
        const { member, groupId, job } = await pooledSubscriber();
        expect(job).toMatchObject({ userId: member.userId, groupId });
        // While pooled the plan adds nothing; it still counts in the mirror until it ends.
        expect(await billingRepository.listUnendedSubscriptionIds(member.userId)).toEqual([
            'sub_personal',
        ]);
        await billing.endPersonalPlans(job);
        expect(callsTo('subscriptions.revoke')).toEqual(['subscriptions.revoke:sub_personal']);
        // Half of 999 before tax, rounded down: not 589 with its tax, not 500.
        expect(refundsMade()).toEqual([['order_cycle', 499]]);
        // Keyed by the membership and the order, at Polar.
        const membership = await billingRepository.getPooledFamily(member.userId);
        expect(polar.refunds[0]?.metadata).toEqual({
            hushos_refund: `${member.userId}:${groupId}:${membership?.admittedAt.toISOString()}:order_cycle`,
        });
        expect(job.admittedAt).toBe(membership?.admittedAt.toISOString());
        // The plan has ended here too: the mirror holds nothing live.
        expect(await billingRepository.listUnendedSubscriptionIds(member.userId)).toEqual([]);

        // pg-boss runs the same job again: the worker died after Polar refunded, before the
        // refund and the ending were marked done here, and (a restore from an older backup)
        // without even the record that HushOS had asked. Only the key ties Polar's refund to it.
        await rawSql(
            "update personal_plan_refunds set status = 'requested', provider_refund_id = null, first_attempted_at = null, last_attempted_at = null",
        );
        await rawSql('update personal_plan_endings set outcome = null');
        await billing.endPersonalPlans(job);
        // Polar delivers the renewal's order.paid again, twice, the second a replay.
        const mark = endingJobs.length;
        const delivery = await signedWebhook({
            type: 'order.paid',
            data: { id: 'order_cycle', customer: { external_id: member.userId } },
        });
        const replay = delivery.clone();
        expect((await billing.handleWebhook(delivery)).status).toBe(200);
        expect((await billing.handleWebhook(replay)).status).toBe(200);
        expect(
            (
                await billing.handleWebhook(
                    await signedWebhook({
                        type: 'order.paid',
                        data: { id: 'order_cycle', customer: { external_id: member.userId } },
                    }),
                )
            ).status,
        ).toBe(200);
        await runQueued(mark);
        // And the daily reconcile.
        const daily = endingJobs.length;
        await billing.reconcilePlanEndings();
        await runQueued(daily);
        expect(callsTo('refunds.create')).toHaveLength(1);
        expect(refundsMade()).toEqual([['order_cycle', 499]]);
        expect(callsTo('subscriptions.revoke')).toHaveLength(1);
    });

    test('a refund whose answer was lost is found by its key, not made twice', async () => {
        const { job } = await pooledSubscriber();
        polar.refundAnswerLost = true;
        await expect(billing.endPersonalPlans(job)).rejects.toThrow();
        // Polar made it; the retry lists the order's refunds first and finds it.
        await billing.endPersonalPlans(job);
        expect(callsTo('refunds.create')).toHaveLength(1);
        expect(refundsMade()).toEqual([['order_cycle', 499]]);
    });

    test('a failed refund is retried from the stored revoke time, listed as owed after five failures in a row, then tried daily', async () => {
        const { member, job, now } = await pooledSubscriber();
        // Revoked, then the orders can't be read: nothing computed yet.
        polar.ordersFail = true;
        await expect(billing.endPersonalPlans(job)).rejects.toThrow();
        expect(callsTo('subscriptions.revoke')).toHaveLength(1);
        polar.ordersFail = false;
        // Refused outright five times (an outage would hold the next ask back; see below).
        polar.refundRefusals = 5;
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            // Every retry an hour after the last: an hour less would be 498 by the first.
            for (let attempt = 1; attempt <= 4; attempt++) {
                vi.setSystemTime(now + attempt * HOUR);
                await expect(billing.endPersonalPlans(job)).rejects.toThrow();
                expect(await billingRepository.listRefundsOwed()).toEqual([]);
            }
            // The fifth in a row: owed, listed, and no longer retried by pg-boss.
            vi.setSystemTime(now + 5 * HOUR);
            expect(await billing.endPersonalPlans(job)).toMatchObject({ owed: 1 });
            expect(await billingRepository.listRefundsOwed()).toEqual([
                expect.objectContaining({
                    orderId: 'order_cycle',
                    userId: member.userId,
                    amount: 499,
                    currency: 'usd',
                    failures: 5,
                }),
            ]);
            // A delivery an hour later doesn't ask Polar again: an owed refund waits a day.
            vi.setSystemTime(now + 6 * HOUR);
            await billing.endPersonalPlans(job);
            expect(callsTo('refunds.create')).toHaveLength(5);
            vi.setSystemTime(now + 29 * HOUR);
            await billing.endPersonalPlans(job);
        } finally {
            vi.useRealTimers();
        }
        expect(callsTo('subscriptions.revoke')).toHaveLength(1);
        expect(refundsMade()).toEqual([['order_cycle', 499]]);
        // Landed: off the operators' list.
        expect(await billingRepository.listRefundsOwed()).toEqual([]);
    });

    test('a pending refund counts as made, and is made again when it later fails', async () => {
        const { member, job } = await pooledSubscriber();
        polar.refundStatus = 'pending';
        await billing.endPersonalPlans(job);
        // Waiting at Polar: not made again by a retry.
        await billing.endPersonalPlans(job);
        expect(callsTo('refunds.create')).toHaveLength(1);
        // Polar's refund then fails (the card can't take it back).
        polar.refunds[0]!.status = 'failed';
        polar.refundStatus = 'succeeded';
        const daily = endingJobs.length;
        await billing.reconcilePlanEndings();
        expect(endingJobs.slice(daily).map((queued) => queued.userId)).toEqual([member.userId]);
        await runQueued(daily);
        expect(polar.refunds.map((refund) => [refund.amount, refund.status])).toEqual([
            [499, 'failed'],
            [499, 'succeeded'],
        ]);
        // Settled: the next daily reconcile has nothing to queue.
        const next = endingJobs.length;
        await billing.reconcilePlanEndings();
        expect(endingJobs.slice(next)).toEqual([]);
    });

    test('tax is never part of the refund: the order’s net amount less what it refunded already', async () => {
        const { job } = await pooledSubscriber({
            orders: (now) => [
                {
                    id: 'order_cycle',
                    created_at: new Date(now - 15 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    // 1250 less a 250 discount, 200 of tax on top, 200 refunded as goodwill.
                    net_amount: 1000,
                    tax_amount: 200,
                    refunded_amount: 200,
                },
            ],
        });
        polar.refunds.push({
            id: 'refund_goodwill',
            order_id: 'order_cycle',
            amount: 200,
            status: 'succeeded',
            metadata: {},
            created_at: new Date(Date.now() - DAY).toISOString(),
        });
        await billing.endPersonalPlans(job);
        expect(refundsMade()).toEqual([
            ['order_cycle', 200],
            ['order_cycle', 400],
        ]);
    });

    test('an operator’s pending refund on the order is allowed for, not stacked on', async () => {
        const { job } = await pooledSubscriber();
        // Made by hand a day ago, still pending: not yet in the order's refunded total.
        polar.refunds.push({
            id: 'refund_by_hand',
            order_id: 'order_cycle',
            amount: 199,
            status: 'pending',
            metadata: {},
            created_at: new Date(Date.now() - DAY).toISOString(),
        });
        await billing.endPersonalPlans(job);
        // Half of 999 less 199: 400, not 499 on top of the 199.
        expect(refundsMade()).toEqual([
            ['order_cycle', 199],
            ['order_cycle', 400],
        ]);
    });

    test('an operator’s pending refund that later fails is owed again, though HushOS already asked for its own', async () => {
        const { member, job } = await pooledSubscriber();
        polar.refunds.push({
            id: 'refund_by_hand',
            order_id: 'order_cycle',
            amount: 199,
            status: 'pending',
            metadata: {},
            created_at: new Date(Date.now() - DAY).toISOString(),
        });
        await billing.endPersonalPlans(job);
        expect(refundsMade()).toEqual([
            ['order_cycle', 199],
            ['order_cycle', 400],
        ]);
        // Something is still pending on the order: it is read again, not settled.
        const daily = endingJobs.length;
        await billing.reconcilePlanEndings();
        expect(endingJobs.slice(daily).map((queued) => queued.userId)).toEqual([member.userId]);
        // The operator's refund fails; the next run owes the 99 it no longer covers.
        polar.refunds[0]!.status = 'failed';
        await runQueued(daily);
        expect(
            polar.refunds
                .filter((refund) => refund.status === 'succeeded')
                .map((refund) => refund.amount),
        ).toEqual([400, 99]);
        const next = endingJobs.length;
        await billing.reconcilePlanEndings();
        expect(endingJobs.slice(next)).toEqual([]);
    });

    test('an order paid partly from the customer’s balance refunds its unused share, within what Polar takes', async () => {
        // 300 of the 999 came from credit (from an earlier period): the unused half, 499, is
        // within the 699 Polar will refund on it.
        const { job } = await pooledSubscriber({
            orders: (now) => [
                {
                    id: 'order_cycle',
                    created_at: new Date(now - 15 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 999,
                    applied_balance_amount: -300,
                },
            ],
        });
        await billing.endPersonalPlans(job);
        expect(refundsMade()).toEqual([['order_cycle', 499]]);
        expect(await billingRepository.listRefundsOwed()).toEqual([]);
    });

    test('a credit of most of the order leaves a refund Polar will take, not one refused for ever', async () => {
        // 800 of credit: Polar takes at most 199 back on it, so 199, never 499 refused for ever.
        const { job } = await pooledSubscriber({
            orders: (now) => [
                {
                    id: 'order_cycle',
                    created_at: new Date(now - 15 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 999,
                    applied_balance_amount: -800,
                },
            ],
        });
        await billing.endPersonalPlans(job);
        expect(refundsMade()).toEqual([['order_cycle', 199]]);
        expect(await billingRepository.listRefundsOwed()).toEqual([]);
        // The 300 Polar won't take is in front of operators, not lost quietly.
        expect(await billingRepository.listUnrefundable()).toEqual([
            expect.objectContaining({
                subscriptionId: 'sub_personal',
                amount: 300,
                currency: 'usd',
            }),
        ]);
    });

    test('what the balance paid is refunded on the earlier card order the balance came from', async () => {
        // 800 of the 999 came from credit an earlier card order left; Polar takes 199 back on
        // this order, and the other 300 of the unused half on that earlier one.
        const { job } = await pooledSubscriber({
            orders: (now) => [
                {
                    id: 'order_cycle',
                    created_at: new Date(now - 15 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 999,
                    applied_balance_amount: -800,
                },
                {
                    id: 'order_earlier',
                    created_at: new Date(now - 45 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 1000,
                },
                // Newer, but in another currency: never where this balance came from.
                {
                    id: 'order_in_euros',
                    created_at: new Date(now - 20 * DAY).toISOString(),
                    billing_reason: 'subscription_update',
                    net_amount: 900,
                    currency: 'eur',
                },
            ],
        });
        await billing.endPersonalPlans(job);
        expect(refundsMade()).toEqual([
            ['order_cycle', 199],
            ['order_earlier', 300],
        ]);
        expect(polar.refunds[1]?.metadata.hushos_refund).toMatch(/:order_earlier$/);
        // It lands against an older payment, so it says what it returns.
        expect(polar.refunds[1]?.comment).toMatch(/balance credit/);
        expect(polar.refunds[0]?.comment).not.toMatch(/balance credit/);
        expect(await billingRepository.listUnrefundable()).toEqual([]);
    });

    test('each earlier order takes at most what Polar will refund on it; the rest goes to the next', async () => {
        const { job } = await pooledSubscriber({
            orders: (now) => [
                {
                    id: 'order_cycle',
                    created_at: new Date(now - 15 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 999,
                    applied_balance_amount: -800,
                },
                // A small top-up: Polar takes back at most 200 on it.
                {
                    id: 'order_earlier',
                    created_at: new Date(now - 45 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 200,
                },
                {
                    id: 'order_older',
                    created_at: new Date(now - 75 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 1000,
                },
            ],
        });
        await billing.endPersonalPlans(job);
        expect(refundsMade()).toEqual([
            ['order_cycle', 199],
            ['order_earlier', 200],
            ['order_older', 100],
        ]);
    });

    test('an earlier order too old to refund is given up after five unanswered asks, listed as owed, never moved', async () => {
        const { job } = await pooledSubscriber({
            orders: (now) => [
                {
                    id: 'order_cycle',
                    created_at: new Date(now - 15 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 999,
                    applied_balance_amount: -800,
                },
                {
                    id: 'order_earlier',
                    created_at: new Date(now - 45 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 1000,
                },
                {
                    id: 'order_older',
                    created_at: new Date(now - 75 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 1000,
                },
            ],
        });
        // Older than Stripe will refund: each ask comes back from Polar as a 500, which may yet
        // have made the refund, so it is asked again only once the wait is over.
        polar.refundWindowDays = 30;
        for (let attempt = 1; attempt <= 5; attempt++) {
            const run = billing.endPersonalPlans(job);
            if (attempt < 5) await expect(run).rejects.toThrow();
            else await expect(run).resolves.toMatchObject({ owed: 1 });
            // The wait after an unanswered ask, over.
            await rawSql('update personal_plan_refunds set unsure_until = null');
        }
        // Given up: listed as owed with what it carries, and nothing moves to the older order;
        // not even the daily retry a day later asks again.
        await billing.endPersonalPlans(job);
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(Date.now() + 25 * HOUR);
            await billing.endPersonalPlans(job);
        } finally {
            vi.useRealTimers();
        }
        expect(callsTo('refunds.create:order_earlier')).toHaveLength(5);
        expect(callsTo('refunds.create:order_older')).toEqual([]);
        expect(refundsMade()).toEqual([['order_cycle', 199]]);
        expect(await billingRepository.listRefundsOwed()).toEqual([
            expect.objectContaining({ orderId: 'order_earlier', amount: 300, failures: 5 }),
        ]);
    });

    test('a disputed renewal’s share is dropped and listed, never moved to an earlier order', async () => {
        const { job } = await pooledSubscriber({
            orders: (now) => [
                {
                    id: 'order_cycle',
                    created_at: new Date(now - 15 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 999,
                },
                {
                    id: 'order_earlier',
                    created_at: new Date(now - 45 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 1000,
                },
            ],
        });
        // A lost dispute returns all 999 by chargeback; 499 on top would be 1,498.
        polar.refusedOrders.set('order_cycle', 'RefundDisputedPayment');
        await billing.endPersonalPlans(job);
        await billing.endPersonalPlans(job);
        expect(callsTo('refunds.create:order_earlier')).toEqual([]);
        expect(callsTo('refunds.create:order_cycle')).toHaveLength(1);
        expect(polar.refunds).toEqual([]);
        expect(await billingRepository.listUnrefundable()).toEqual([
            expect.objectContaining({ subscriptionId: 'sub_personal', amount: 499 }),
        ]);
    });

    test('a disputed earlier order keeps its share out of every other order', async () => {
        const { job } = await pooledSubscriber({
            orders: (now) => [
                {
                    id: 'order_cycle',
                    created_at: new Date(now - 15 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 999,
                    applied_balance_amount: -800,
                },
                {
                    id: 'order_earlier',
                    created_at: new Date(now - 45 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 1000,
                },
                {
                    id: 'order_older',
                    created_at: new Date(now - 75 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 1000,
                },
            ],
        });
        polar.refusedOrders.set('order_earlier', 'RefundDisputedPayment');
        await billing.endPersonalPlans(job);
        await billing.endPersonalPlans(job);
        expect(refundsMade()).toEqual([['order_cycle', 199]]);
        expect(callsTo('refunds.create:order_older')).toEqual([]);
        expect(await billingRepository.listUnrefundable()).toEqual([
            expect.objectContaining({ amount: 300 }),
        ]);
    });

    test('a refusal that can be lifted (refunds blocked) is a failure, retried, never moved', async () => {
        const { job } = await pooledSubscriber({
            orders: (now) => [
                {
                    id: 'order_cycle',
                    created_at: new Date(now - 15 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 999,
                },
                {
                    id: 'order_earlier',
                    created_at: new Date(now - 45 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 1000,
                },
            ],
        });
        polar.refusedOrders.set('order_cycle', 'RefundsBlocked');
        await expect(billing.endPersonalPlans(job)).rejects.toThrow();
        await expect(billing.endPersonalPlans(job)).rejects.toThrow();
        expect(callsTo('refunds.create:order_earlier')).toEqual([]);
        // The block is lifted (the organisation reviewed, the order's flag cleared).
        polar.refusedOrders.clear();
        await billing.endPersonalPlans(job);
        expect(refundsMade()).toEqual([['order_cycle', 499]]);
        expect(await billingRepository.listUnrefundable()).toEqual([]);
    });

    test('refunds already made count first: a refill of the period never adds to what earlier orders hold', async () => {
        // A 1000 card renewal with an operator's 900 refund pending, a 600 upgrade paid from
        // balance, an earlier 1000 card order. Half the period unused.
        const { job, member } = await pooledSubscriber({
            orders: (now) => [
                {
                    id: 'order_cycle',
                    created_at: new Date(now - 15 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 1000,
                },
                {
                    id: 'order_upgrade',
                    created_at: new Date(now - 15 * DAY + HOUR).toISOString(),
                    billing_reason: 'subscription_update',
                    net_amount: 600,
                    applied_balance_amount: -600,
                },
                {
                    id: 'order_earlier',
                    created_at: new Date(now - 45 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 1000,
                },
            ],
        });
        polar.refunds.push({
            id: 'refund_by_hand',
            order_id: 'order_cycle',
            amount: 900,
            status: 'pending',
            metadata: {},
            created_at: new Date(Date.now() - DAY).toISOString(),
        });
        // Owed: 50 (half of what the renewal still holds) + 300 (half the upgrade) = 350: 100 on
        // the renewal (all Polar takes), 250 on the earlier order.
        await billing.endPersonalPlans(job);
        const ours = () =>
            polar.refunds
                .filter((refund) => refund.status === 'succeeded' && refund.metadata.hushos_refund)
                .map((refund) => [refund.order_id, refund.amount]);
        expect(ours()).toEqual([
            ['order_cycle', 100],
            ['order_earlier', 250],
        ]);
        // The operator's refund fails: now 500 + 300 = 800 is owed, of which 350 is back already.
        polar.refunds[0]!.status = 'failed';
        const daily = endingJobs.length;
        await billing.reconcilePlanEndings();
        expect(endingJobs.slice(daily).map((queued) => queued.userId)).toEqual([member.userId]);
        await runQueued(daily);
        expect(ours()).toEqual([
            ['order_cycle', 100],
            ['order_earlier', 250],
            ['order_cycle', 450],
        ]);
        const total = ours().reduce((sum, [, amount]) => sum + Number(amount), 0);
        expect(total).toBe(800);
    });

    test('a refund on the earlier order is made once across a lost write, retries and a reconcile', async () => {
        const { job } = await pooledSubscriber({
            orders: (now) => [
                {
                    id: 'order_cycle',
                    created_at: new Date(now - 15 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 999,
                    applied_balance_amount: -800,
                },
                {
                    id: 'order_earlier',
                    created_at: new Date(now - 45 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 1000,
                },
            ],
        });
        await billing.endPersonalPlans(job);
        // The worker died after Polar refunded, before anything was written here.
        await rawSql(
            "update personal_plan_refunds set status = 'requested', provider_refund_id = null, first_attempted_at = null, last_attempted_at = null",
        );
        await rawSql('update personal_plan_endings set outcome = null');
        await billing.endPersonalPlans(job);
        await billing.endPersonalPlans(job);
        const daily = endingJobs.length;
        await billing.reconcilePlanEndings();
        await runQueued(daily);
        expect(callsTo('refunds.create')).toHaveLength(2);
        expect(refundsMade()).toEqual([
            ['order_cycle', 199],
            ['order_earlier', 300],
        ]);
    });

    test('a mid-period downgrade’s credit is netted against the refund', async () => {
        // 30 days, 15 used: the renewal paid 1000; a downgrade 10 days in credited 400 for the
        // 20 days left, 300 of it for the 15 still unused. 500 less 300.
        const { job } = await pooledSubscriber({
            orders: (now) => [
                {
                    id: 'order_cycle',
                    created_at: new Date(now - 15 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 1000,
                },
                {
                    id: 'order_downgrade',
                    created_at: new Date(now - 5 * DAY).toISOString(),
                    billing_reason: 'subscription_update',
                    net_amount: -400,
                },
            ],
        });
        await billing.endPersonalPlans(job);
        expect(refundsMade()).toEqual([['order_cycle', 200]]);
        expect(callsTo('refunds.list:order_downgrade')).toEqual([]);
    });

    test('a downgrade then an upgrade paid from its credit: every unused share counts, signed', async () => {
        // 30 days, revoked on day 15. Day 0 renewal 1000; day 10 a downgrade credits 400 to the
        // balance (300 of it for days 10-30 still unused at day 15); day 12 an upgrade charges
        // 360 for days 12-30, all of it from that balance (300 for the 15 days unused). Owed:
        // 500 - 300 + 300 = 500, all on the renewal, the only order Polar refunds by card. The
        // 40 left in the balance is what the days used were worth.
        const { job } = await pooledSubscriber({
            orders: (now) => [
                {
                    id: 'order_cycle',
                    created_at: new Date(now - 15 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 1000,
                },
                {
                    id: 'order_downgrade',
                    created_at: new Date(now - 5 * DAY).toISOString(),
                    billing_reason: 'subscription_update',
                    net_amount: -400,
                },
                {
                    id: 'order_upgrade',
                    created_at: new Date(now - 3 * DAY).toISOString(),
                    billing_reason: 'subscription_update',
                    net_amount: 360,
                    applied_balance_amount: -360,
                },
            ],
        });
        await billing.endPersonalPlans(job);
        expect(refundsMade()).toEqual([['order_cycle', 500]]);
        // Polar would refund nothing on the upgrade: its refunds are never even listed.
        expect(callsTo('refunds.list:order_upgrade')).toEqual([]);
    });

    test('an order that charged nothing is settled without listing its refunds', async () => {
        const { member, job } = await pooledSubscriber({
            orders: (now) => [
                {
                    id: 'order_cycle',
                    created_at: new Date(now - 15 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    // A 100%-off code.
                    net_amount: 0,
                },
            ],
        });
        // Even with a token that can't read refunds: there is nothing to ask about.
        polar.refundsUnreadable = true;
        await billing.endPersonalPlans(job);
        expect(callsTo('refunds.')).toEqual([]);
        expect(await billingRepository.listPlanRefunds('sub_personal')).toEqual([
            expect.objectContaining({ orderId: 'order_cycle', amount: 0, status: 'none' }),
        ]);
        const daily = endingJobs.length;
        await billing.reconcilePlanEndings();
        expect(endingJobs.slice(daily).map((queued) => queued.userId)).not.toContain(member.userId);
    });

    test('two runs at once (pg-boss retrying one it took for dead) refund once', async () => {
        const { job } = await pooledSubscriber();
        // The first run takes the ending's lease, revokes, then is held inside its refunds listing
        // until the second run has come and gone: the overlap doesn't depend on timing.
        let release = () => {};
        let held = () => {};
        const holding = new Promise<void>((resolve) => (held = resolve));
        polar.onRefundList = () =>
            new Promise<void>((resolve) => {
                release = resolve;
                held();
            });
        const first = billing.endPersonalPlans(job);
        await holding;
        const second = await Promise.allSettled([billing.endPersonalPlans(job)]);
        release();
        await first;
        // The money: one refund, of the unused half, whatever the runs did.
        expect(callsTo('refunds.create')).toHaveLength(1);
        expect(refundsMade()).toEqual([['order_cycle', 499]]);
        expect(callsTo('subscriptions.revoke')).toHaveLength(1);
        // The second, run while the first held the lease, stopped before asking Polar for any
        // refund: refused as busy, its listing never made.
        expect(second[0]).toMatchObject({
            status: 'rejected',
            reason: expect.objectContaining({ name: 'PlanEndingBusyError' }),
        });
        expect(callsTo('refunds.list')).toHaveLength(1);
        // The retry pg-boss makes of the one that stopped finds it done.
        await billing.endPersonalPlans(job);
        expect(refundsMade()).toEqual([['order_cycle', 499]]);
    });

    test('a run that stalled past its lease, which another run took, asks Polar for nothing more', async () => {
        const { job } = await pooledSubscriber();
        // The first run revokes, then stalls in its refunds listing.
        let resume = () => {};
        let stalled = () => {};
        const reached = new Promise<void>((resolve) => (stalled = resolve));
        polar.onRefundList = () =>
            new Promise<void>((resolve) => {
                resume = resolve;
                stalled();
            });
        const first = billing.endPersonalPlans(job);
        await reached;
        // Its lease runs out on the database's clock (pg-boss's ten minutes, say): a retry
        // takes the ending and refunds.
        await rawSql("update personal_plan_endings set lease_until = now() - interval '1 second'");
        await billing.endPersonalPlans(job);
        expect(refundsMade()).toEqual([['order_cycle', 499]]);
        // The first resumes with its stale listing: it must not ask for 499 again.
        resume();
        await expect(first).rejects.toMatchObject({ name: 'PlanEndingBusyError' });
        expect(callsTo('refunds.create')).toHaveLength(1);
        expect(refundsMade()).toEqual([['order_cycle', 499]]);
    });

    test('a refund Stripe fails after it was settled is found by the daily reconcile and made again', async () => {
        const { member, job } = await pooledSubscriber();
        await billing.endPersonalPlans(job);
        expect(refundsMade()).toEqual([['order_cycle', 499]]);
        // Two weeks on, Stripe fails it (the card was closed): Polar marks it failed and takes it
        // back off the order. The ending was settled.
        polar.refunds[0]!.status = 'failed';
        polar.orders.find((order) => order.id === 'order_cycle')!.refunded_amount = 0;
        const daily = endingJobs.length;
        await billing.reconcilePlanEndings();
        expect(endingJobs.slice(daily).map((queued) => queued.userId)).toEqual([member.userId]);
        await runQueued(daily);
        expect(polar.refunds.map((refund) => [refund.amount, refund.status])).toEqual([
            [499, 'failed'],
            [499, 'succeeded'],
        ]);
        // Held again: the next reconcile opens nothing.
        const next = endingJobs.length;
        await billing.reconcilePlanEndings();
        expect(endingJobs.slice(next)).toEqual([]);
    });

    test('Polar’s refund.updated for a failed refund of HushOS’s opens its settled ending at once', async () => {
        const { member, job } = await pooledSubscriber();
        await billing.endPersonalPlans(job);
        const refund = polar.refunds[0]!;
        refund.status = 'failed';
        polar.orders.find((order) => order.id === 'order_cycle')!.refunded_amount = 0;
        const mark = endingJobs.length;
        const delivery = await signedWebhook({
            type: 'refund.updated',
            timestamp: new Date().toISOString(),
            data: {
                ...refund,
                modified_at: new Date().toISOString(),
                reason: 'customer_request',
                tax_amount: 90,
                currency: 'usd',
                organization_id: 'org_test',
                subscription_id: 'sub_personal',
                customer_id: 'cus_personal',
                revoke_benefits: false,
                dispute: null,
            },
        });
        expect((await billing.handleWebhook(delivery)).status).toBe(200);
        expect(endingJobs.slice(mark).map((queued) => queued.userId)).toEqual([member.userId]);
        await runQueued(mark);
        expect(polar.refunds.filter((r) => r.status === 'succeeded').map((r) => r.amount)).toEqual([
            499,
        ]);
    });

    test('Polar saying refunded whole while its listing never shows it ends on the owed list', async () => {
        const { job } = await pooledSubscriber();
        polar.refundedAlreadyOrders.add('order_cycle');
        for (let run = 1; run <= 4; run++) {
            await expect(billing.endPersonalPlans(job)).rejects.toThrow();
            expect(await billingRepository.listRefundsOwed()).toEqual([]);
        }
        await expect(billing.endPersonalPlans(job)).resolves.toMatchObject({ owed: 1 });
        expect(await billingRepository.listRefundsOwed()).toEqual([
            expect.objectContaining({ orderId: 'order_cycle', amount: 499, failures: 5 }),
        ]);
    });

    test('a refund that timed out and lands at Polar later is not asked for twice', async () => {
        const { job } = await pooledSubscriber();
        polar.refundLandsLate = true;
        await expect(billing.endPersonalPlans(job)).rejects.toThrow();
        // pg-boss retries a minute later: nothing is listed yet, and nothing is asked.
        await expect(billing.endPersonalPlans(job)).rejects.toThrow();
        expect(callsTo('refunds.create')).toHaveLength(1);
        // Two minutes after the timeout, Polar commits it; the next run finds it by its key.
        polar.lateRefund?.();
        await billing.endPersonalPlans(job);
        expect(callsTo('refunds.create')).toHaveLength(1);
        expect(refundsMade()).toEqual([['order_cycle', 499]]);
    });

    test('a run whose job signal fired stops before asking Polar for anything', async () => {
        const { job } = await pooledSubscriber();
        const expired = new AbortController();
        expired.abort();
        await expect(
            billing.endPersonalPlans(job, { signal: expired.signal }),
        ).rejects.toMatchObject({ name: 'PlanEndingBusyError' });
        expect(callsTo('subscriptions.revoke')).toEqual([]);
        expect(polar.refunds).toEqual([]);
    });

    test('a refund Polar errored on after the card was refunded is not made again', async () => {
        const { job } = await pooledSubscriber();
        // Stripe refunded it; Polar errored and recorded the refund without HushOS's key.
        polar.refundErrorsAfterStripe = true;
        await expect(billing.endPersonalPlans(job)).rejects.toThrow();
        await billing.endPersonalPlans(job);
        expect(callsTo('refunds.create')).toHaveLength(1);
        expect(refundsMade()).toEqual([['order_cycle', 499]]);
    });

    test('a mid-period upgrade’s two orders are each prorated over what they paid for', async () => {
        // 30 days, 20 used: the renewal paid for all 30, the upgrade for the last 20.
        const { job } = await pooledSubscriber({
            periodStart: -20 * DAY,
            periodEnd: 10 * DAY,
            orders: (now) => [
                {
                    id: 'order_cycle',
                    created_at: new Date(now - 20 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 1000,
                },
                {
                    id: 'order_upgrade',
                    created_at: new Date(now - 10 * DAY).toISOString(),
                    billing_reason: 'subscription_update',
                    net_amount: 600,
                },
                // The period before: paid for days already used. Not refunded.
                {
                    id: 'order_before',
                    created_at: new Date(now - 50 * DAY).toISOString(),
                    billing_reason: 'subscription_cycle',
                    net_amount: 1000,
                },
            ],
        });
        await billing.endPersonalPlans(job);
        expect(refundsMade().sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
            ['order_cycle', 333],
            ['order_upgrade', 300],
        ]);
    });

    test('already revoked at Polar on the first try: prorated from its ended_at, not from now', async () => {
        const { job, now } = await pooledSubscriber();
        // The revoke lands at Polar at `now`, but its answer is lost: no revoke time is stored.
        polar.revokeAnswerLost = true;
        await expect(billing.endPersonalPlans(job)).rejects.toThrow();
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            // The retry an hour later is told 403 AlreadyCanceledSubscription.
            vi.setSystemTime(now + HOUR);
            await billing.endPersonalPlans(job);
        } finally {
            vi.useRealTimers();
        }
        expect(callsTo('subscriptions.revoke')).toHaveLength(2);
        // From its ended_at: half of 999, 499; from the retry's now it would be 498.
        expect(refundsMade()).toEqual([['order_cycle', 499]]);
    });

    test('a plan that had already ended before its owner was pooled refunds nothing', async () => {
        const { member, job, subscription, now } = await pooledSubscriber();
        // It ended three days ago; the delivery that said so never came.
        subscription.status = 'canceled';
        subscription.ended_at = new Date(now - 3 * DAY).toISOString();
        await billing.endPersonalPlans(job);
        expect(callsTo('subscriptions.revoke')).toEqual([]);
        expect(callsTo('refunds.')).toEqual([]);
        expect(polar.refunds).toEqual([]);
        // Recorded as ended, here too: nothing is queued again.
        expect(await billingRepository.listUnendedSubscriptionIds(member.userId)).toEqual([]);
        const daily = endingJobs.length;
        await billing.reconcilePlanEndings();
        expect(endingJobs.slice(daily)).toEqual([]);
    });

    test('someone who leaves before their plan is revoked keeps it', async () => {
        const { member, groupId, job, subscription } = await pooledSubscriber();
        // The first try can't reach Polar; they leave before the retry.
        polar.revokeFailures = 1;
        await expect(billing.endPersonalPlans(job)).rejects.toThrow();
        await setTestMember({ groupId, userId: member.userId, state: 'left' });
        await billing.endPersonalPlans(job);
        expect(subscription.ended_at).toBeNull();
        expect(callsTo('subscriptions.revoke')).toHaveLength(1);
        expect(polar.refunds).toEqual([]);
        expect(await billingRepository.listUnendedSubscriptionIds(member.userId)).toEqual([
            'sub_personal',
        ]);
    });

    test('someone whose revoke landed unheard before they left is still refunded', async () => {
        const { member, groupId, job } = await pooledSubscriber();
        // The revoke lands at Polar but its answer is lost; then they leave.
        polar.revokeAnswerLost = true;
        await expect(billing.endPersonalPlans(job)).rejects.toThrow();
        await setTestMember({ groupId, userId: member.userId, state: 'left' });
        await billing.endPersonalPlans(job);
        // Their plan ended while they were pooled: the unused half is theirs all the same.
        expect(refundsMade()).toEqual([['order_cycle', 499]]);
    });

    test('the daily reconcile finds a pooled member whose job was lost, and ends their plan', async () => {
        const { member } = await pooledSubscriber();
        endingJobs.length = 0;
        await billing.reconcilePlanEndings();
        expect(endingJobs.map((queued) => queued.userId)).toEqual([member.userId]);
        await runQueued(0);
        expect(refundsMade()).toEqual([['order_cycle', 499]]);
    });

    test('a personal renewal paid while its owner is pooled is ended and refunded whole', async () => {
        const { member, subscription } = await pooledSubscriber();
        // The job never ran. Polar renews the plan a moment later and says so.
        const renewedAt = Date.now() + 5_000;
        subscription.current_period_start = new Date(renewedAt).toISOString();
        subscription.current_period_end = new Date(renewedAt + 30 * DAY).toISOString();
        polar.orders.push({
            id: 'order_renewal',
            subscription_id: subscription.id,
            status: 'paid',
            due_amount: 0,
            created_at: new Date(renewedAt).toISOString(),
            product_id: PRO,
            billing_reason: 'subscription_cycle',
            net_amount: 999,
            tax_amount: 180,
            currency: 'usd',
        });
        polar.revokeAt = new Date(renewedAt + 60_000).toISOString();
        const mark = endingJobs.length;
        const delivery = await signedWebhook({
            type: 'order.paid',
            data: { id: 'order_renewal', customer: { external_id: member.userId } },
        });
        expect((await billing.handleWebhook(delivery)).status).toBe(200);
        expect(endingJobs.slice(mark).map((queued) => queued.userId)).toContain(member.userId);
        // The queue keeps the first job sent for a person (stately): the admission's.
        await billing.endPersonalPlans(endingJobs[0]!);
        // Paid after they were pooled: all of it back, not the prorated rest.
        expect(refundsMade()).toEqual([['order_renewal', 999]]);
        expect(await billingRepository.listPlanRefunds(subscription.id)).toEqual([
            expect.objectContaining({ orderId: 'order_renewal', amount: 999, status: 'succeeded' }),
        ]);
    });

    test('a family’s first plan going live queues the end of its organizer’s personal plan', async () => {
        const organizer = await createTestAccount();
        const { groupId } = await createTestFamily({
            organizerId: organizer.userId,
            pooled: true,
        });
        subscribe(organizer.userId, { id: 'sub_organizer' });
        await billing.reconcileCustomer(organizer.userId);
        // No plan yet: they keep their own.
        expect(endingJobs).toEqual([]);
        await billing.startGroupCheckout(userOf(organizer), groupId, { productId: FAMILY });
        familySubscription(groupId, { units: 6 });
        await billing.reconcileGroup(groupId);
        expect(endingJobs.map((queued) => [queued.userId, queued.groupId])).toEqual([
            [organizer.userId, groupId],
        ]);
    });
});

/* Its period runs out and a new one starts, its renewal unpaid (an `unpaid` plan's own period). */
function renewUnpaid(subscription: FakeSubscription) {
    const start = Date.parse(subscription.current_period_end);
    subscription.current_period_start = new Date(Math.min(start, Date.now())).toISOString();
    subscription.current_period_end = new Date(Date.now() + 30 * DAY).toISOString();
}

/* An order of `subscription` that Polar holds as paid, made at `createdAt` (now by default). */
function addPaidOrder(
    subscription: FakeSubscription,
    orderId: string,
    createdAt = new Date().toISOString(),
) {
    polar.orders.push({
        id: orderId,
        subscription_id: subscription.id,
        status: 'paid',
        due_amount: 0,
        created_at: createdAt,
        product_id: subscription.product_id,
        currency: 'usd',
        billing_reason: 'subscription_cycle',
        net_amount: 999,
        tax_amount: 180,
    });
}

/* Polar's `order.paid` for an order `addPaidOrder` made. */
async function deliverPaid(userId: string, subscription: FakeSubscription, orderId: string) {
    const order = polar.orders.find((candidate) => candidate.id === orderId)!;
    const delivery = await signedWebhook({
        type: 'order.paid',
        data: {
            id: orderId,
            subscription_id: subscription.id,
            created_at: order.created_at,
            currency: 'usd',
            net_amount: order.net_amount,
            discount_id: null,
            customer: { external_id: userId },
        },
    });
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
        expect((await billing.handleWebhook(delivery)).status).toBe(200);
    } finally {
        error.mockRestore();
        warn.mockRestore();
    }
}

describe('a pooled member’s lapsed personal plan', () => {
    test.each(['unpaid', 'incomplete', 'paused'])(
        'one Polar answers as %s is revoked with nothing refunded; a payment Polar takes afterwards is refunded whole',
        async (status) => {
            const { member, subscription, job } = await pooledSubscriber();
            subscription.status = status;
            // Unpaid or incomplete: a renewal (or first payment) that failed, its period unpaid.
            if (status !== 'paused') renewUnpaid(subscription);
            const mark = endingJobs.length;
            await billing.reconcileCustomer(member.userId);
            // Still the job's: a paused plan would resume on its date and charge.
            expect(endingJobs.length).toBe(mark + 1);
            await billing.endPersonalPlans(job);
            expect(callsTo('subscriptions.revoke')).toEqual(['subscriptions.revoke:sub_personal']);
            // Nothing of its period was paid for: the paid checkout order of the fixture isn't
            // prorated back as a live plan's would be.
            expect(refundsMade()).toEqual([]);
            expect(await billingRepository.getPlanEnding('sub_personal')).toMatchObject({
                groupId: null,
                outcome: 'settled',
            });
            expect(await billingRepository.listUnendedSubscriptionIds(member.userId)).toEqual([]);
            // A run again (a retry, the daily reconcile) asks Polar nothing more.
            await billing.endPersonalPlans(job);
            expect(callsTo('subscriptions.revoke')).toHaveLength(1);
            // Polar takes a payment for it all the same (a dunning email answered): refunded
            // whole, before tax, that order alone.
            const before = endingJobs.length;
            addPaidOrder(subscription, 'order_late');
            await deliverPaid(member.userId, subscription, 'order_late');
            await runQueued(before);
            expect(refundsMade()).toEqual([['order_late', 999]]);
            expect(await billingRepository.getPlanEnding('sub_personal')).toMatchObject({
                outcome: 'settled',
            });
        },
    );
});

describe('a pooled member’s lapsed plan after leaving and coming back', () => {
    test('a plan whose ending was dropped is revoked once it lapses, and a later payment is refunded', async () => {
        const { member, groupId, job, subscription } = await pooledSubscriber();
        // The first revoke can't reach Polar; they leave before the retry: the ending is dropped.
        polar.revokeFailures = 1;
        await expect(billing.endPersonalPlans(job)).rejects.toThrow();
        await setTestMember({ groupId, userId: member.userId, state: 'left' });
        await billing.endPersonalPlans(job);
        expect((await billingRepository.getPlanEnding('sub_personal'))?.outcome).toBe('dropped');
        // Back in the family; their plan's next renewal fails.
        await setTestMember({ groupId, userId: member.userId, state: 'active' });
        subscription.status = 'unpaid';
        renewUnpaid(subscription);
        const before = endingJobs.length;
        await billing.reconcileCustomer(member.userId);
        await runQueued(before);
        expect(callsTo('subscriptions.revoke')).toEqual([
            'subscriptions.revoke:sub_personal',
            'subscriptions.revoke:sub_personal',
        ]);
        expect(await billingRepository.getPlanEnding('sub_personal')).toMatchObject({
            groupId: null,
            outcome: 'settled',
        });
        expect(refundsMade()).toEqual([]);
        // The daily reconcile has nothing more to queue for them.
        const daily = endingJobs.length;
        await billing.reconcilePlanEndings();
        expect(endingJobs.slice(daily)).toEqual([]);
        // A payment Polar takes for it afterwards is refunded whole.
        addPaidOrder(subscription, 'order_late');
        await deliverPaid(member.userId, subscription, 'order_late');
        await runQueued(daily);
        expect(refundsMade()).toEqual([['order_late', 999]]);
    });
});

describe('a pooled member’s lapsed plan HushOS set out to revoke before', () => {
    test('one whose earlier revoke never landed is revoked by the pooled job', async () => {
        const { userId, subscription } = await (async () => {
            const { userId } = await createTestAccount();
            const subscription = subscribe(userId, { id: 'sub_lapsed' });
            await billing.reconcileCustomer(userId);
            subscription.status = 'unpaid';
            await billing.reconcileCustomer(userId);
            return { userId, subscription };
        })();
        polar.revokeTimesOut = true;
        await expect(
            billing.startCheckout({ id: userId, name: 'Test', email: 'x@hushos.test' }, MAX),
        ).rejects.toMatchObject({ status: 503 });
        expect(subscription.ended_at).toBeNull();
        // They join a family instead.
        const { groupId } = await familyOnPlan();
        await setTestMember({ groupId, userId, state: 'active' });
        endingJobs.length = 0;
        expect(await billing.queuePlanEnding(userId)).toBe(true);
        await runQueued(0);
        expect(subscription.ended_at).toBeTruthy();
        expect((await billingRepository.getPlanEnding('sub_lapsed'))?.revokedAt).toBeInstanceOf(
            Date,
        );
        expect(refundsMade()).toEqual([]);
    });

    test('a revived plan whose lapsed ending was never revoked is ended when its owner joins a family', async () => {
        const { userId, subscription } = await (async () => {
            const { userId } = await createTestAccount();
            const subscription = subscribe(userId, { id: 'sub_lapsed' });
            await billing.reconcileCustomer(userId);
            subscription.status = 'unpaid';
            await billing.reconcileCustomer(userId);
            return { userId, subscription };
        })();
        polar.revokeTimesOut = true;
        await expect(
            billing.startCheckout({ id: userId, name: 'Test', email: 'x@hushos.test' }, MAX),
        ).rejects.toMatchObject({ status: 503 });
        // Paid in the portal; the order.paid delivery is lost.
        subscription.status = 'active';
        addPaidOrder(subscription, 'order_a', subscription.current_period_start);
        await billing.reconcileCustomer(userId);
        const { groupId } = await familyOnPlan();
        await setTestMember({ groupId, userId, state: 'active' });
        endingJobs.length = 0;
        polar.calls = [];
        expect(await billing.queuePlanEnding(userId)).toBe(true);
        await runQueued(0);
        // Ended for the family at once, the unused part of the paid period refunded.
        expect(callsTo('subscriptions.revoke')).toEqual(['subscriptions.revoke:sub_lapsed']);
        expect(await billingRepository.getPlanEnding('sub_lapsed')).toMatchObject({
            groupId,
            outcome: 'settled',
        });
        expect(refundsMade()).toEqual([['order_a', 966]]);
    });

    test('a family ending its owner left before the revoke is taken over by a checkout once the plan lapses', async () => {
        const { member, groupId, job, subscription } = await pooledSubscriber();
        // The family's revoke can't reach Polar; they leave; the plan's payment then fails.
        polar.revokeFailures = 1;
        await expect(billing.endPersonalPlans(job)).rejects.toThrow();
        await setTestMember({ groupId, userId: member.userId, state: 'left' });
        subscription.status = 'unpaid';
        renewUnpaid(subscription);
        await billing.reconcileCustomer(member.userId);
        expect(await billing.startCheckout(userOf(member), MAX)).toEqual({
            url: 'https://polar.test/checkout',
        });
        expect(subscription.ended_at).toBeTruthy();
        expect(await billingRepository.getPlanEnding('sub_personal')).toMatchObject({
            groupId: null,
            outcome: 'settled',
        });
        expect(refundsMade()).toEqual([]);
    });

    test('a lapsed plan Polar has locked doesn’t hold back the end of their live plan', async () => {
        const { member, job } = await pooledSubscriber();
        const other = subscribe(member.userId, { id: 'sub_other' });
        await billing.reconcileCustomer(member.userId);
        other.status = 'unpaid';
        await billing.reconcileCustomer(member.userId);
        polar.revokeRefusals.set('sub_other', { status: 409, error: 'SubscriptionLocked' });
        const error = vi.spyOn(log, 'error').mockImplementation(() => {});
        const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
        try {
            await expect(billing.endPersonalPlans(job)).rejects.toThrow(
                'A lapsed personal plan has not been revoked yet.',
            );
        } finally {
            error.mockRestore();
            warn.mockRestore();
        }
        expect(refundsMade()).toEqual([['order_cycle', 499]]);
        expect(callsTo('subscriptions.revoke')).toContain('subscriptions.revoke:sub_personal');
    });
});

describe('a personal plan while pooled', () => {
    test('checkout and resume are refused with in-family; after leaving, the ended plan is gone and checkout works', async () => {
        const { member, groupId, job } = await pooledSubscriber();
        const user = userOf(member);
        const refusal = {
            status: 409,
            code: 'in-family',
            message:
                'Your storage comes from The Family’s plan. Leave the family to choose a plan of your own.',
        };
        // Before the job ends it (a plan still live) and after.
        await expect(billing.startCheckout(user, MAX)).rejects.toMatchObject(refusal);
        await expect(billing.resume(user)).rejects.toMatchObject(refusal);
        expect(await billing.getSummary(user)).toMatchObject({
            family: { name: 'The Family', planName: 'Family (monthly)' },
        });
        await billing.endPersonalPlans(job);
        await expect(billing.startCheckout(user, PRO)).rejects.toMatchObject(refusal);
        await expect(billing.resume(user)).rejects.toMatchObject(refusal);
        expect(callsTo('checkouts.create')).toEqual([]);
        expect(callsTo('subscriptions.update')).toEqual([]);
        // Leaving: their own allowance again, the free base only (the ended Pro doesn't return).
        await setTestMember({ groupId, userId: member.userId, state: 'left' });
        expect((await authRepository.getStorageAllowance(member.userId))?.quotaBytes).toBe(
            GIB.toString(),
        );
        expect((await billing.getSummary(user)).family).toBeNull();
        expect(await billing.startCheckout(user, PRO)).toMatchObject({
            url: 'https://polar.test/checkout',
        });
    });
});

describe('who stores what in a family', () => {
    test('managers see each member’s own files in whole GiB rounded up; a member sees only their own', async () => {
        const { payer, groupId, areaIds, others } = await familyOnPlan({ members: 1 });
        const plain = await createTestAccount();
        await setTestMember({ groupId, userId: plain.userId, state: 'active' });
        const workspaceOf = async (userId: string) =>
            (await authRepository.getStorageAllowance(userId))!.workspaceId;
        await setTestUsedBytes(await workspaceOf(payer.id), GIB + 1n);
        await setTestUsedBytes(await workspaceOf(others[0]!.userId), 512n * 1024n * 1024n);
        await setTestUsedBytes(await workspaceOf(plain.userId), GIB);
        await setTestUsedBytes(areaIds[0]!, 3n * GIB + 5n);
        const members = [
            { userId: payer.id, ownBytesRounded: (2n * GIB).toString() },
            { userId: plain.userId, ownBytesRounded: GIB.toString() },
            // Under 1 GiB: "0", read as "Under 1 GB".
            { userId: others[0]!.userId, ownBytesRounded: '0' },
        ];
        // The payer (billing) and a `members` holder: everyone, largest first, never exact.
        expect((await billing.getGroupBilling(payer, groupId)).usage).toEqual({
            ownBytes: (GIB + 1n).toString(),
            foldersBytes: (4n * GIB).toString(),
            members,
        });
        expect((await billing.getGroupBilling(userOf(others[0]!), groupId)).usage?.members).toEqual(
            members,
        );
        // A member without either role: their own figure, and nobody else's in any form.
        const glance = await billing.getGroupBilling(userOf(plain), groupId);
        expect(glance.usage).toEqual({
            ownBytes: GIB.toString(),
            foldersBytes: (4n * GIB).toString(),
            members: null,
        });
        const body = JSON.stringify(glance);
        expect(body).not.toContain((GIB + 1n).toString());
        expect(body).not.toContain(String(512n * 1024n * 1024n));
        expect(body).not.toContain(payer.id);
    });
});

describe('a family’s first plan', () => {
    test('is refused when the organizer’s own files are more than its pool', async () => {
        const organizer = await createTestAccount();
        const { groupId } = await createTestFamily({
            organizerId: organizer.userId,
            pooled: true,
        });
        await setTestUsedBytes(organizer.workspaceId, 950n * GIB);
        await expect(
            billing.startGroupCheckout(userOf(organizer), groupId, { productId: PLUS }),
        ).rejects.toMatchObject({
            status: 409,
            message:
                'Your files take 950 GB, more than Family Plus’s 800 GB. Choose a bigger plan or free at least 150 GB.',
        });
        expect(callsTo('checkouts.create')).toEqual([]);
        await setTestUsedBytes(organizer.workspaceId, 700n * GIB);
        expect(
            await billing.startGroupCheckout(userOf(organizer), groupId, { productId: PLUS }),
        ).toMatchObject({ url: 'https://polar.test/checkout' });
    });

    test('past the biggest tier on offer it says only what to free: products not offered aren’t a bigger plan', async () => {
        const organizer = await createTestAccount();
        const { groupId } = await createTestFamily({
            organizerId: organizer.userId,
            pooled: true,
        });
        await setTestUsedBytes(organizer.workspaceId, MAX_POOL + 512n * GIB);
        // The catalogue also has Family Mega (8 TB, a tier key HushOS doesn't offer).
        await expect(
            billing.startGroupCheckout(userOf(organizer), groupId, { productId: MAX_FAMILY }),
        ).rejects.toMatchObject({
            status: 409,
            message: 'Your files take 4.5 TB, more than Family Max’s 4 TB. Free at least 512 GB.',
        });
        // With every bigger tier archived (other tests add some), Plus is the biggest on offer.
        // The untiered family products (2 TB) stay on sale at Polar, but no page offers them
        // beside the tiers, so none is "a bigger plan".
        const archived = polar.products.filter((candidate) => {
            const metadata = (candidate.metadata ?? {}) as Record<string, string | undefined>;
            return (
                !candidate.is_archived &&
                metadata.hushos_tier !== undefined &&
                BigInt(metadata.quota_bytes ?? '0') > PLUS_POOL
            );
        });
        const clock = vi.spyOn(Date, 'now');
        // Past every clock an earlier test read the catalogue at (fake timers reach 29 h ahead),
        // so it is read again.
        catalogueClock = Math.max(catalogueClock + 10 * 60_000, 48 * 60 * 60_000);
        try {
            for (const product of archived) product.is_archived = true;
            clock.mockReturnValue(new Date().getTime() + catalogueClock);
            await setTestUsedBytes(organizer.workspaceId, 950n * GIB);
            await expect(
                billing.startGroupCheckout(userOf(organizer), groupId, { productId: PLUS }),
            ).rejects.toMatchObject({
                status: 409,
                message:
                    'Your files take 950 GB, more than Family Plus’s 800 GB. Free at least 150 GB.',
            });
        } finally {
            for (const product of archived) product.is_archived = false;
            clock.mockReturnValue(new Date().getTime() + catalogueClock + 5 * 60_000);
            await billing.listCatalogue();
            clock.mockRestore();
        }
        expect(callsTo('checkouts.create')).toEqual([]);
    });
});

/*
 * A dissolved family's plan (docs/groups-design.md 3.3): set to end at its period's end
 * by the worker, never revoked or refunded, set again every time its payer resumes it
 * (mailed once a period), left to operators when Polar refuses, and its records purged
 * only once it has ended.
 */
describe('a dissolved family’s plan', () => {
    const setToEnd = () =>
        polar.calls.filter((call) => call.includes('"cancel_at_period_end":true'));
    const endsOn = (iso: string) =>
        new Intl.DateTimeFormat('en-GB', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
        }).format(new Date(iso));
    /* The worker: every queued job, in order; the first failure throws. */
    async function runCancelJobs() {
        const outcomes = [];
        for (const groupId of cancelJobs.splice(0))
            outcomes.push(await billing.cancelDissolvedPlan(groupId));
        return outcomes;
    }
    const row = async (subscriptionId: string) =>
        (await billingRepository.getGroupSubscription(subscriptionId))!;
    const resumedWebhook = (groupId: string) =>
        signedWebhook({
            type: 'customer.state_changed',
            data: { id: 'cus_team', external_id: `group:${groupId}`, type: 'team' },
        });

    /*
     * A family on a plan, dissolved as it can be: its payer set the plan to end (leaving
     * last needs that), then took it back in the portal with no delivery yet, so the mirror
     * still says it ends; the payer, its last member, leaves, and the leave route queues
     * the job. Polar holds a plan that renews.
     */
    async function dissolvedResumed() {
        const family = await familyOnPlan({ units: 6 });
        family.subscription.cancel_at_period_end = true;
        await billing.reconcileGroup(family.groupId);
        family.subscription.cancel_at_period_end = false;
        expect(await groupsRepository.leaveGroup(family.groupId, family.payer.id)).toEqual({
            status: 'dissolved',
        });
        await billing.queueDissolvedCancel(family.groupId);
        polar.calls = [];
        return family;
    }

    test('dissolving with a plan that can still charge sets it to end at its period’s end, once, and tells the payer when', async () => {
        const { payer, groupId, subscription } = await dissolvedResumed();
        expect(cancelJobs).toEqual([groupId]);
        expect(await runCancelJobs()).toEqual([{ cancelled: 1, refused: 0 }]);
        expect(setToEnd()).toEqual([
            `subscriptions.update:${subscription.id}:{"cancel_at_period_end":true}`,
        ]);
        // Ended at the period's end, never now: nothing revoked, nothing refunded.
        expect(subscription).toMatchObject({ cancel_at_period_end: true, status: 'active' });
        expect(polar.calls.filter((call) => /revoke|refunds\./.test(call))).toEqual([]);
        expect(await row(subscription.id)).toMatchObject({
            cancelAtPeriodEnd: true,
            endedAt: null,
            dissolveCancels: 1,
        });
        expect(planEndingMail).toEqual([
            { to: payer.email, endsOn: endsOn(subscription.current_period_end) },
        ]);
        // Queued again (a webhook, the daily reconcile): nothing more is set or sent.
        await billing.queueDissolvedCancel(groupId);
        polar.calls = [];
        expect(await runCancelJobs()).toEqual([{ cancelled: 0, refused: 0 }]);
        expect(setToEnd()).toEqual([]);
        expect(planEndingMail).toHaveLength(1);
    });

    test('a payer who takes the ending back is set to end again every time, and mailed once a period', async () => {
        const { payer, groupId, subscription } = await dissolvedResumed();
        await runCancelJobs();
        for (let resumed = 2; resumed <= 6; resumed++) {
            subscription.cancel_at_period_end = false;
            expect((await billing.handleWebhook(await resumedWebhook(groupId))).status).toBe(200);
            expect(cancelJobs).toEqual([groupId]);
            expect(await runCancelJobs()).toEqual([{ cancelled: 1, refused: 0 }]);
            expect(subscription.cancel_at_period_end).toBe(true);
            expect((await row(subscription.id)).dissolveCancels).toBe(resumed);
        }
        // One mail for the period, however often it was resumed in it; nothing for operators.
        expect(planEndingMail).toEqual([
            { to: payer.email, endsOn: endsOn(subscription.current_period_end) },
        ]);
        expect(await billingRepository.listGivenUpReissues()).toEqual([]);
        // Resumed into a new period (it renewed): set to end again, and mailed for that period.
        renew(subscription, subscription.product_id);
        subscription.cancel_at_period_end = false;
        await billing.handleWebhook(await resumedWebhook(groupId));
        expect(await runCancelJobs()).toEqual([{ cancelled: 1, refused: 0 }]);
        expect(planEndingMail).toEqual([
            { to: payer.email, endsOn: expect.any(String) },
            { to: payer.email, endsOn: endsOn(subscription.current_period_end) },
        ]);
    });

    test('a refusal at Polar is listed for operators and not asked again until the plan changes', async () => {
        const { groupId, subscription } = await dissolvedResumed();
        polar.cancelRefusal = { status: 403, error: 'InactiveSubscription' };
        const error = vi.spyOn(log, 'error');
        try {
            // Not thrown, so pg-boss doesn't retry it for ever.
            expect(await runCancelJobs()).toEqual([{ cancelled: 0, refused: 1 }]);
            expect(error).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'Polar refused to end a dissolved family’s plan: cancel it in Polar',
                }),
            );
        } finally {
            error.mockRestore();
        }
        expect(await billingRepository.listGivenUpReissues()).toEqual([
            expect.objectContaining({
                groupId,
                subscriptionId: subscription.id,
                reason: 'dissolved-refused',
            }),
        ]);
        expect(planEndingMail).toEqual([]);
        // The same plan in the same state: no delivery or reconcile queues it, no run asks Polar.
        polar.calls = [];
        await billing.handleWebhook(await resumedWebhook(groupId));
        await billing.reconcileGroup(groupId);
        expect(cancelJobs).toEqual([]);
        await billing.queueDissolvedCancel(groupId);
        expect(await runCancelJobs()).toEqual([{ cancelled: 0, refused: 0 }]);
        expect(setToEnd()).toEqual([]);
        // Its state changes (it renewed, and Polar no longer refuses): asked again, and set.
        polar.cancelRefusal = null;
        renew(subscription, subscription.product_id);
        await billing.handleWebhook(await resumedWebhook(groupId));
        expect(cancelJobs).toEqual([groupId]);
        expect(await runCancelJobs()).toEqual([{ cancelled: 1, refused: 0 }]);
        expect(subscription.cancel_at_period_end).toBe(true);
        expect(await billingRepository.listGivenUpReissues()).toEqual([]);
    });

    test('an answer that can pass (409 SubscriptionLocked during a renewal, 401, 402, a 403 for a plan still renewing) throws for a retry and is never recorded as a refusal', async () => {
        const { payer, groupId, subscription } = await dissolvedResumed();
        cancelJobs.length = 0;
        for (const refusal of [
            { status: 409, error: 'SubscriptionLocked' },
            { status: 401, error: 'Unauthorized' },
            { status: 402, error: 'PaymentFailed' },
            // Polar says it is already set to end, but a read shows it renewing.
            { status: 403, error: 'AlreadyCanceledSubscription' },
        ]) {
            polar.cancelRefusal = refusal;
            await expect(billing.cancelDissolvedPlan(groupId)).rejects.toBeInstanceOf(
                billing.BillingError,
            );
            expect(await row(subscription.id)).toMatchObject({
                cancelAtPeriodEnd: false,
                dissolveRefusedAt: null,
                dissolveRefusedState: null,
            });
            expect(await billingRepository.listGivenUpReissues()).toEqual([]);
            // Still to be set: the next delivery queues it again, as it would a refused one not.
            await billing.handleWebhook(await resumedWebhook(groupId));
            expect(cancelJobs.splice(0)).toEqual([groupId]);
        }
        // The renewal went through and the lock cleared: the retry sets it to end.
        polar.cancelRefusal = null;
        expect(await billing.cancelDissolvedPlan(groupId)).toEqual({ cancelled: 1, refused: 0 });
        expect(subscription.cancel_at_period_end).toBe(true);
        expect(planEndingMail).toEqual([
            { to: payer.email, endsOn: endsOn(subscription.current_period_end) },
        ]);
    });

    test('a failure Polar keeps repeating (a revoked token) lists the plan for operators after a day, not before, until it is set to end', async () => {
        const { groupId, subscription } = await dissolvedResumed();
        polar.unauthorized = true;
        const listed = async () =>
            (await billingRepository.listGivenUpReissues()).map((row) => [
                row.subscriptionId,
                row.reason,
            ]);
        // Time passes between runs (pg-boss's backoff, then the daily reconcile's re-queue).
        const later = (hours: number) =>
            rawSql(
                `update group_billing_subscriptions set dissolve_failing_since = dissolve_failing_since - interval '${hours} hours' where id = '${subscription.id}'`,
            );
        const run = () =>
            expect(billing.cancelDissolvedPlan(groupId)).rejects.toBeInstanceOf(
                billing.BillingError,
            );
        await run();
        expect((await row(subscription.id)).dissolveFailingSince).not.toBeNull();
        expect(await listed()).toEqual([]);
        await later(23);
        await run();
        expect(await listed()).toEqual([]);
        // A day after the first failure, though later runs failed too: listed, from the first.
        await later(2);
        await run();
        expect(await listed()).toEqual([[subscription.id, 'dissolved-failing']]);
        const since = (await billingRepository.listGivenUpReissues())[0]!.since!;
        expect(Date.now() - since.getTime()).toBeGreaterThan(25 * 60 * 60 * 1000 - 60_000);
        await later(23);
        await run();
        expect(await listed()).toEqual([[subscription.id, 'dissolved-failing']]);
        // The token is fixed and an operator cancels it in Polar: its delivery clears the row.
        polar.unauthorized = false;
        subscription.cancel_at_period_end = true;
        expect((await billing.handleWebhook(await resumedWebhook(groupId))).status).toBe(200);
        expect(await listed()).toEqual([]);
        expect((await row(subscription.id)).dissolveFailingSince).toBeNull();
        expect(setToEnd()).toEqual([]);
    });

    test('a failing plan close to its renewal is listed at its first failure; one renewing later waits a day', async () => {
        const soon = await dissolvedResumed();
        const later = await dissolvedResumed();
        // The mirror knows when each renews: in 30 hours, and in 10 days.
        soon.subscription.current_period_end = new Date(Date.now() + 30 * HOUR).toISOString();
        later.subscription.current_period_end = new Date(Date.now() + 10 * DAY).toISOString();
        for (const family of [soon, later])
            await billing.handleWebhook(await resumedWebhook(family.groupId));
        const listed = async () =>
            (await billingRepository.listGivenUpReissues()).map((row) => [
                row.subscriptionId,
                row.reason,
            ]);
        // Renewing soon is not failing: nothing is listed before a run fails.
        expect(await listed()).toEqual([]);
        polar.unauthorized = true;
        for (const family of [soon, later])
            await expect(billing.cancelDissolvedPlan(family.groupId)).rejects.toBeInstanceOf(
                billing.BillingError,
            );
        expect(await listed()).toEqual([[soon.subscription.id, 'dissolved-failing']]);
        await rawSql(
            `update group_billing_subscriptions set dissolve_failing_since = dissolve_failing_since - interval '25 hours' where id = '${later.subscription.id}'`,
        );
        expect(new Set((await listed()).map(([id, reason]) => `${id} ${reason}`))).toEqual(
            new Set([
                `${soon.subscription.id} dissolved-failing`,
                `${later.subscription.id} dissolved-failing`,
            ]),
        );
    });

    test('setting a failing plan to end clears the failure itself, before any reconcile', async () => {
        const { groupId, subscription } = await dissolvedResumed();
        polar.cancelFailures = 1;
        await expect(billing.cancelDissolvedPlan(groupId)).rejects.toMatchObject({ status: 503 });
        expect((await row(subscription.id)).dissolveFailingSince).not.toBeNull();
        // What a run records once Polar keeps it, before its closing reconcile reads Polar.
        await billingRepository.recordDissolveCancel(subscription.id);
        expect(await row(subscription.id)).toMatchObject({
            dissolveFailingSince: null,
            dissolveCancels: 1,
        });
    });

    test('a refused plan leaves the operators’ list once it is set to end in Polar', async () => {
        const { payer, groupId, subscription } = await dissolvedResumed();
        polar.cancelRefusal = { status: 403, error: 'InactiveSubscription' };
        const error = vi.spyOn(log, 'error').mockImplementation(() => {});
        try {
            expect(await runCancelJobs()).toEqual([{ cancelled: 0, refused: 1 }]);
        } finally {
            error.mockRestore();
        }
        expect(await billingRepository.listGivenUpReissues()).toEqual([
            expect.objectContaining({
                subscriptionId: subscription.id,
                reason: 'dissolved-refused',
            }),
        ]);
        // An operator cancels it in Polar's dashboard, and its delivery is reconciled: the row
        // goes, though nothing cleared the refusal.
        subscription.cancel_at_period_end = true;
        expect((await billing.handleWebhook(await resumedWebhook(groupId))).status).toBe(200);
        expect((await row(subscription.id)).dissolveRefusedAt).not.toBeNull();
        expect(await billingRepository.listGivenUpReissues()).toEqual([]);
        // HushOS asked this period, so the payer is told the date.
        expect(await runCancelJobs()).toEqual([{ cancelled: 0, refused: 0 }]);
        expect(planEndingMail).toEqual([
            { to: payer.email, endsOn: endsOn(subscription.current_period_end) },
        ]);
        // Resumed again, in the state Polar refused: back on the list, and not asked again.
        subscription.cancel_at_period_end = false;
        polar.calls = [];
        await billing.handleWebhook(await resumedWebhook(groupId));
        expect(await billingRepository.listGivenUpReissues()).toEqual([
            expect.objectContaining({
                subscriptionId: subscription.id,
                reason: 'dissolved-refused',
            }),
        ]);
        await runCancelJobs();
        expect(setToEnd()).toEqual([]);
    });

    test('a mail that fails is sent by a later run, which every reconcile queues while it is owed', async () => {
        const { payer, groupId, subscription } = await dissolvedResumed();
        mailer.failures = 1;
        const warn = vi.spyOn(log, 'warn');
        try {
            expect(await runCancelJobs()).toEqual([{ cancelled: 1, refused: 0 }]);
            expect(warn).toHaveBeenCalledWith(
                expect.objectContaining({ message: 'Plan ending email not sent' }),
            );
        } finally {
            warn.mockRestore();
        }
        expect(subscription.cancel_at_period_end).toBe(true);
        expect(planEndingMail).toEqual([]);
        // The plan already ends, and still a delivery (or the daily reconcile) queues the job.
        await billing.reconcileGroup(groupId);
        expect(cancelJobs).toEqual([groupId]);
        polar.calls = [];
        expect(await runCancelJobs()).toEqual([{ cancelled: 0, refused: 0 }]);
        expect(setToEnd()).toEqual([]);
        expect(planEndingMail).toEqual([
            { to: payer.email, endsOn: endsOn(subscription.current_period_end) },
        ]);
        // Sent: nothing more is queued or mailed.
        await billing.reconcileGroup(groupId);
        expect(cancelJobs).toEqual([]);
        await billing.queueDissolvedCancel(groupId);
        await runCancelJobs();
        expect(planEndingMail).toHaveLength(1);
    });

    test('a set whose answer was lost is mailed by the retry that finds the plan ending', async () => {
        const { payer, groupId, subscription } = await dissolvedResumed();
        polar.cancelAnswerLost = true;
        await expect(billing.cancelDissolvedPlan(groupId)).rejects.toMatchObject({ status: 503 });
        // Polar kept it; HushOS never heard.
        expect(subscription.cancel_at_period_end).toBe(true);
        expect(planEndingMail).toEqual([]);
        // pg-boss's retry: it reads the plan ending, sets nothing, and tells the payer.
        expect(await billing.cancelDissolvedPlan(groupId)).toEqual({ cancelled: 0, refused: 0 });
        expect(setToEnd()).toHaveLength(1);
        expect(planEndingMail).toEqual([
            { to: payer.email, endsOn: endsOn(subscription.current_period_end) },
        ]);
    });

    test('a payer who sets the plan to end themselves in a later period is not mailed for it', async () => {
        const { groupId, subscription } = await dissolvedResumed();
        await runCancelJobs();
        expect(planEndingMail).toHaveLength(1);
        // Resumed with no delivery, renewed, then set to end by the payer: HushOS asked for none of it.
        subscription.cancel_at_period_end = false;
        renew(subscription, subscription.product_id);
        subscription.cancel_at_period_end = true;
        expect((await billing.handleWebhook(await resumedWebhook(groupId))).status).toBe(200);
        expect(cancelJobs).toEqual([]);
        await billing.queueDissolvedCancel(groupId);
        expect(await runCancelJobs()).toEqual([{ cancelled: 0, refused: 0 }]);
        expect(planEndingMail).toHaveLength(1);
    });

    test('a plan set to end after the job read Polar is not set again', async () => {
        const { groupId, subscription } = await dissolvedResumed();
        // The reconcile's read sees it renewing; the payer sets it to end just after.
        polar.afterGet = () => {
            subscription.cancel_at_period_end = true;
        };
        expect(await billing.cancelDissolvedPlan(groupId)).toEqual({ cancelled: 0, refused: 0 });
        expect(setToEnd()).toEqual([]);
        expect((await row(subscription.id)).dissolveCancels).toBe(0);
        expect(planEndingMail).toEqual([]);
    });

    test('a paused plan of a dissolved family still counts: kept by the reconcile, and the purge waits', async () => {
        const { groupId, subscription } = await dissolvedResumed();
        // Paused in the portal (customer pause enabled): it may be resumed and charge again.
        subscription.status = 'paused';
        polar.cancelRefusal = { status: 403, error: 'InactiveSubscription' };
        await billing.reconcileGroup(groupId);
        expect(await row(subscription.id)).toMatchObject({ status: 'paused', endedAt: null });
        await runCancelJobs();
        await rawSql(
            `update groups set dissolved_at = now() - interval '31 days' where id = '${groupId}'`,
        );
        await rawSql(
            `update workspaces set deleted_at = now() - interval '31 days' where group_id = '${groupId}'`,
        );
        expect(await groupsRepository.purgeDeletedAreas(30)).toBe(1);
        expect(await groupsRepository.purgeDissolvedFamilies(30)).toMatchObject({ families: 0 });
        expect(await groupsRepository.getGroupRow(groupId)).not.toBeNull();
    });

    const listedAs = async () =>
        (await billingRepository.listGivenUpReissues()).map((entry) => [
            entry.subscriptionId,
            entry.reason,
        ]);
    const purgeDue = async (groupId: string) => {
        await rawSql(
            `update groups set dissolved_at = now() - interval '31 days' where id = '${groupId}'`,
        );
        await rawSql(
            `update workspaces set deleted_at = now() - interval '31 days' where group_id = '${groupId}'`,
        );
        await groupsRepository.purgeDeletedAreas(30);
    };
    const quietly = async <T>(run: () => Promise<T>) => {
        const error = vi.spyOn(log, 'error').mockImplementation(() => {});
        try {
            return await run();
        } finally {
            error.mockRestore();
        }
    };

    test.each(['unpaid', 'incomplete'])(
        'a plan Polar answers as %s still counts: kept, refused on its status without asking Polar, listed until it ends, and the purge waits',
        async (status) => {
            const { groupId, subscription } = await dissolvedResumed();
            // Polar's retries ran out (`unpaid`), or a payment never went through
            // (`incomplete`): Polar hasn't ended it, and a payment can still bring it back.
            subscription.status = status;
            await billing.reconcileGroup(groupId);
            expect(await row(subscription.id)).toMatchObject({ status, endedAt: null });
            // The daily reconcile reads it again and still keeps it, without reading its orders.
            polar.calls = [];
            await billing.reconcileGroup(groupId);
            expect(await row(subscription.id)).toMatchObject({ status, endedAt: null });
            expect(polar.calls.filter((call) => call.startsWith('orders.'))).toEqual([]);
            // The leave's job and each reconcile's: refused once, on its status alone. Polar
            // would have kept the end (the fake refuses nothing), so it was never asked.
            expect(await quietly(runCancelJobs)).toEqual([
                { cancelled: 0, refused: 1 },
                { cancelled: 0, refused: 0 },
                { cancelled: 0, refused: 0 },
            ]);
            expect(setToEnd()).toEqual([]);
            expect(subscription.cancel_at_period_end).toBe(false);
            expect(await listedAs()).toEqual([[subscription.id, 'dissolved-inactive']]);
            // Not queued again by the reconciles that follow.
            await billing.reconcileGroup(groupId);
            expect(cancelJobs).toEqual([]);
            // An operator sets it to end instead of revoking it: it hasn't ended, so it stays
            // listed, and the purge still waits.
            subscription.cancel_at_period_end = true;
            expect((await billing.handleWebhook(await resumedWebhook(groupId))).status).toBe(200);
            expect(await row(subscription.id)).toMatchObject({ cancelAtPeriodEnd: true });
            expect(await listedAs()).toEqual([[subscription.id, 'dissolved-inactive']]);
            await purgeDue(groupId);
            expect(await groupsRepository.purgeDissolvedFamilies(30)).toMatchObject({
                families: 0,
            });
            expect(await groupsRepository.getGroupRow(groupId)).not.toBeNull();
            // Revoked in Polar, and the delivery reconciled: off the list, and the records go.
            subscription.status = 'canceled';
            subscription.ended_at = new Date().toISOString();
            expect((await billing.handleWebhook(await resumedWebhook(groupId))).status).toBe(200);
            expect(await listedAs()).toEqual([]);
            expect(await groupsRepository.purgeDissolvedFamilies(30)).toMatchObject({
                families: 1,
            });
        },
    );

    test('a plan refused while past due that turns unpaid is asked about again, then left alone', async () => {
        const { groupId, subscription } = await dissolvedResumed();
        subscription.status = 'past_due';
        polar.cancelRefusal = { status: 403, error: 'InactiveSubscription' };
        await billing.reconcileGroup(groupId);
        cancelJobs.splice(0);
        await billing.queueDissolvedCancel(groupId);
        expect(await quietly(runCancelJobs)).toEqual([{ cancelled: 0, refused: 1 }]);
        expect(setToEnd()).toHaveLength(1);
        expect(await listedAs()).toEqual([[subscription.id, 'dissolved-refused']]);
        // Polar's retries run out: a new state, so the next reconcile queues the job again.
        subscription.status = 'unpaid';
        await billing.reconcileGroup(groupId);
        expect(cancelJobs).toEqual([groupId]);
        expect(await quietly(runCancelJobs)).toEqual([{ cancelled: 0, refused: 1 }]);
        // Refused on its status this time, without asking Polar.
        expect(setToEnd()).toHaveLength(1);
        expect(await row(subscription.id)).toMatchObject({
            dissolveRefusal: 'status:unpaid',
            dissolveRefusedState: expect.stringMatching(/^unpaid\|/),
        });
        expect(await listedAs()).toEqual([[subscription.id, 'dissolved-inactive']]);
        await billing.reconcileGroup(groupId);
        expect(cancelJobs).toEqual([]);
    });

    test('an unpaid plan Polar no longer has is recorded as ended, and the purge goes ahead', async () => {
        const { groupId, subscription } = await dissolvedResumed();
        subscription.status = 'unpaid';
        await billing.reconcileGroup(groupId);
        expect(await row(subscription.id)).toMatchObject({ status: 'unpaid', endedAt: null });
        cancelJobs.splice(0);
        // Gone at Polar (404): nothing can charge, so the sweep ends it, its status as last seen.
        polar.subscriptions.delete(subscription.id);
        await billing.reconcileGroup(groupId);
        expect(await row(subscription.id)).toMatchObject({
            status: 'unpaid',
            endedAt: expect.any(Date),
        });
        expect(cancelJobs).toEqual([]);
        await rawSql(
            `update groups set dissolved_at = now() - interval '31 days' where id = '${groupId}'`,
        );
        await rawSql(
            `update workspaces set deleted_at = now() - interval '31 days' where group_id = '${groupId}'`,
        );
        expect(await groupsRepository.purgeDeletedAreas(30)).toBe(1);
        expect(await groupsRepository.purgeDissolvedFamilies(30)).toMatchObject({ families: 1 });
    });

    test('a failure at Polar throws for a retry, and the retry sets it to end once', async () => {
        const { payer, groupId, subscription } = await dissolvedResumed();
        polar.cancelFailures = 1;
        await expect(billing.cancelDissolvedPlan(groupId)).rejects.toMatchObject({ status: 503 });
        expect(subscription.cancel_at_period_end).toBe(false);
        expect((await row(subscription.id)).dissolveCancels).toBe(0);
        expect(planEndingMail).toEqual([]);
        // pg-boss's retry: the claim was let go, and this time Polar keeps it.
        expect(await billing.cancelDissolvedPlan(groupId)).toEqual({ cancelled: 1, refused: 0 });
        expect(subscription.cancel_at_period_end).toBe(true);
        expect(setToEnd()).toHaveLength(2);
        expect((await row(subscription.id)).dissolveCancels).toBe(1);
        expect(planEndingMail).toEqual([
            { to: payer.email, endsOn: endsOn(subscription.current_period_end) },
        ]);
    });

    test('two runs at once set it to end once: the second finds the plan claimed', async () => {
        const { groupId, subscription } = await dissolvedResumed();
        let second: Promise<unknown> | undefined;
        // The second run starts while the first is inside Polar's call, before Polar keeps it.
        polar.beforeCancel = async () => {
            second = billing.cancelDissolvedPlan(groupId);
            await second.catch(() => {});
        };
        expect(await billing.cancelDissolvedPlan(groupId)).toEqual({ cancelled: 1, refused: 0 });
        await expect(second).rejects.toBeInstanceOf(billing.DissolveCancelBusyError);
        expect(setToEnd()).toHaveLength(1);
        expect((await row(subscription.id)).dissolveCancels).toBe(1);
        expect(planEndingMail).toHaveLength(1);
        // Its retry finds it set.
        expect(await billing.cancelDissolvedPlan(groupId)).toEqual({ cancelled: 0, refused: 0 });
        expect(setToEnd()).toHaveLength(1);
    });

    test('dissolving a family without a plan that can still charge asks Polar nothing', async () => {
        // Never bought one.
        const organizer = await createTestAccount();
        const never = await createTestFamily({ organizerId: organizer.userId });
        expect(await groupsRepository.leaveGroup(never.groupId, organizer.userId)).toEqual({
            status: 'dissolved',
        });
        // Had one, which ended.
        const ended = await familyOnPlan({ units: 6 });
        ended.subscription.status = 'canceled';
        ended.subscription.cancel_at_period_end = true;
        ended.subscription.ended_at = new Date().toISOString();
        await billing.reconcileGroup(ended.groupId);
        expect(await groupsRepository.leaveGroup(ended.groupId, ended.payer.id)).toEqual({
            status: 'dissolved',
        });
        polar.calls = [];
        for (const groupId of [never.groupId, ended.groupId])
            await billing.queueDissolvedCancel(groupId);
        expect(await runCancelJobs()).toEqual([
            { cancelled: 0, refused: 0 },
            { cancelled: 0, refused: 0 },
        ]);
        expect(polar.calls).toEqual([]);
        expect(planEndingMail).toEqual([]);
    });

    test('the family’s records are purged only once its plan has actually ended', async () => {
        const { groupId, subscription } = await dissolvedResumed();
        await runCancelJobs();
        // 31 days on: its folders went with the trash's retention.
        await rawSql(
            `update groups set dissolved_at = now() - interval '31 days' where id = '${groupId}'`,
        );
        await rawSql(
            `update workspaces set deleted_at = now() - interval '31 days' where group_id = '${groupId}'`,
        );
        expect(await groupsRepository.purgeDeletedAreas(30)).toBe(1);
        // Set to end, still running: the records stay.
        expect(await groupsRepository.purgeDissolvedFamilies(30)).toMatchObject({ families: 0 });
        expect(await groupsRepository.getGroupRow(groupId)).not.toBeNull();
        // The period ends at Polar and its delivery is reconciled: now they go.
        subscription.status = 'canceled';
        subscription.ended_at = new Date().toISOString();
        expect((await billing.handleWebhook(await resumedWebhook(groupId))).status).toBe(200);
        expect(cancelJobs).toEqual([]);
        expect(await groupsRepository.purgeDissolvedFamilies(30)).toMatchObject({ families: 1 });
        expect(await groupsRepository.getGroupRow(groupId)).toBeNull();
        // The billing records are kept, by the family's id.
        expect(await row(subscription.id)).toMatchObject({ groupId, status: 'canceled' });
    });
});
