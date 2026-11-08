// @vitest-environment node
import { Elysia, type AnySchema } from 'elysia';
import { describe, expect, test } from 'vitest';
import type * as growth from '@hushos/billing/growth';
import type * as billing from '@hushos/billing/server';
import {
    affiliateDeletedResponse,
    affiliatePaidResponse,
    affiliateResponse,
    affiliatesResponse,
    catalogueResponse,
    checkoutResponse,
    couponResponse,
    forgottenResponse,
    groupBillingChangedResponse,
    groupBillingResponse,
    groupPlanResponse,
    groupUnitsResponse,
    handleResponse,
    referralsResponse,
    summaryResponse,
    urlResponse,
} from '@/lib/api/billing-responses.server';
import { loadApi, type ApiRoute } from '@/test/api-app';

/*
 * The billing routes' reply schemas, through a real Elysia route so normalisation runs as it does
 * in the app: what the billing package returns goes out unchanged (every variant: billing off, no
 * customer, a lapsed or ended plan, a family's payer, manager and member), a field the schema does
 * not name is dropped, and a reply missing a field a client needs fails instead of going out
 * short. Samples are typed as the package's return types, so a sample that drifts from what the
 * handler returns fails typecheck.
 */

type Reply<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

async function serve(schema: AnySchema, value: unknown) {
    const app = new Elysia().get('/x', { response: { 200: schema } }, () => value as never);
    const response = await app.handle(new Request('http://localhost/x'));
    return {
        status: response.status,
        body: response.ok ? ((await response.json()) as unknown) : null,
    };
}

const clone = <T>(value: T): T => structuredClone(value);

const userId = '0b5e0d1c-6a4e-4c41-9a43-2b1f4d8f9e10';
const otherId = '2d7a2f3e-8c6a-4e63-9c65-4d3b6fab1a32';
const affiliateId = '3e8b3a4f-9d7b-4f74-8d76-5e4c7abc2b43';
const portal = 'https://polar.sh/hushos/portal?customer_session_token=polar_cst_test';
const checkoutUrl = 'https://buy.polar.sh/polar_c_test';
const GiB = (n: number) => String(BigInt(n) << 30n);

/* ------------------------------------------------------------------------- */
/* Plans */

type Catalogue = Reply<typeof billing.listCatalogue>;
const plus: Catalogue['families'][number] = {
    id: 'prod_family_plus_month',
    name: 'Family Plus (monthly)',
    description: null,
    interval: 'month',
    tier: 'plus',
    recommended: false,
    prices: { usd: { base: 999, perMember: 200 }, eur: { base: 899, perMember: 180 } },
    includedMembers: 3,
    maxMembers: 50,
    quotaBytes: GiB(2048),
};
const pro: Catalogue['families'][number] = {
    ...plus,
    id: 'prod_family_pro_month',
    name: 'Family Pro (monthly)',
    description: 'For the whole household.',
    tier: 'pro',
    recommended: true,
    prices: { usd: { base: 1999, perMember: 300 } },
    includedMembers: 5,
    quotaBytes: GiB(6144),
};
// The single Family plan from before the tiers, kept priced for a family still on it.
const untiered: Catalogue['families'][number] = { ...plus, id: 'prod_family', tier: null };

const catalogue: Catalogue = {
    enabled: true,
    // Past 2^53 is not a free quota, but every byte count is a string all the same.
    freeQuotaBytes: GiB(5),
    plans: [
        {
            id: 'prod_pro_month',
            name: 'Pro (monthly)',
            description: '200 GB for one person.',
            interval: 'month',
            amount: 499,
            currency: 'usd',
            prices: { usd: 499, eur: 459, jpy: 780 },
            quotaBytes: GiB(200),
            recommended: true,
        },
        {
            id: 'prod_pro_year',
            name: 'Pro (yearly)',
            description: null,
            interval: 'year',
            amount: 4990,
            currency: 'usd',
            prices: { usd: 4990 },
            quotaBytes: GiB(200),
            recommended: false,
        },
    ],
    families: [plus, pro],
};

type Summary = Reply<typeof billing.getSummary>;
const liveSummary: Summary = {
    enabled: true,
    hasCustomer: true,
    subscription: {
        id: 'sub_live',
        productId: 'prod_pro_month',
        productName: 'Pro (monthly)',
        status: 'active',
        recurringInterval: 'month',
        amount: 459,
        currency: 'eur',
        quotaBytes: GiB(200),
        currentPeriodEnd: '2026-12-08T09:00:00.000Z',
        cancelAtPeriodEnd: false,
        endedAt: null,
    },
    intendedPlan: null,
    intendedFamily: null,
    family: null,
};

/* ------------------------------------------------------------------------- */
/* Families */

type GroupBilling = Reply<typeof billing.getGroupBilling>;
const managerLive: GroupBilling = {
    enabled: true,
    view: 'manage',
    plans: [plus, pro, untiered],
    payer: { userId, you: true },
    subscription: {
        id: 'sub_family',
        productId: 'prod_family_pro_month',
        productName: 'Family Pro (monthly)',
        status: 'past_due',
        recurringInterval: 'month',
        amount: 2299,
        currency: 'usd',
        units: 6,
        paidUnits: 5,
        pendingUnits: null,
        pendingProductId: 'prod_family_plus_month',
        paidProductId: 'prod_family_plus_month',
        includedMembers: 5,
        quotaBytes: GiB(6144),
        currentPeriodStart: '2026-11-01T00:00:00.000Z',
        currentPeriodEnd: '2026-12-01T00:00:00.000Z',
        cancelAtPeriodEnd: false,
    },
    lastPlan: null,
    lapsedPlan: null,
    storage: { usedBytes: GiB(310), quotaBytes: GiB(6144) },
    usage: {
        ownBytes: '123456789',
        foldersBytes: GiB(12),
        members: [
            { userId: otherId, ownBytesRounded: GiB(300) },
            { userId, ownBytesRounded: '0' },
        ],
    },
    seats: { used: 4, limit: 6 },
    nextPlace: { amount: 173, currency: 'usd' },
};
const managerEnding: GroupBilling = {
    ...managerLive,
    subscription: { ...managerLive.subscription!, cancelAtPeriodEnd: true },
};
const managerLapsed: GroupBilling = {
    enabled: true,
    view: 'manage',
    plans: [plus, pro],
    payer: { userId: otherId, you: false },
    subscription: null,
    lastPlan: { productName: 'Family Plus (monthly)', endedAt: '2026-10-01T00:00:00.000Z' },
    lapsedPlan: { productName: 'Family plan', standing: 'paused', ids: ['sub_a', 'sub_b'] },
    // The pool is empty past its period and grace.
    storage: { usedBytes: GiB(40), quotaBytes: '0' },
    usage: { ownBytes: null, foldersBytes: '0', members: null },
    seats: { used: 2, limit: 2 },
    nextPlace: null,
};
// Billing off: no lapsed plan or usage at all, and no pool.
const managerBillingOff: GroupBilling = {
    enabled: false,
    view: 'manage',
    plans: [],
    payer: null,
    subscription: null,
    lastPlan: null,
    storage: null,
    seats: { used: 3, limit: 3 },
    nextPlace: null,
};
const memberLive: GroupBilling = {
    enabled: true,
    view: 'member',
    hasPlan: true,
    planName: 'Family Pro (monthly)',
    storage: { usedBytes: GiB(310), quotaBytes: GiB(6144) },
    usage: { ownBytes: '1024', foldersBytes: GiB(12), members: null },
};
const memberPaysLapsed: GroupBilling = {
    enabled: true,
    view: 'member',
    hasPlan: false,
    planName: null,
    lapsedPlan: {
        productName: 'Family Plus (monthly)',
        standing: 'payment-failed',
        youPay: true,
        ids: ['sub_a'],
    },
    storage: { usedBytes: GiB(40), quotaBytes: '0' },
    usage: { ownBytes: '0', foldersBytes: '0', members: null },
};
const memberLapsed: GroupBilling = {
    ...memberPaysLapsed,
    lapsedPlan: { productName: 'Family Plus (monthly)', standing: 'paused', youPay: false },
};
const memberNoPlan: GroupBilling = { ...memberPaysLapsed, lapsedPlan: null, storage: null };
const memberBillingOff: GroupBilling = {
    enabled: false,
    view: 'member',
    hasPlan: false,
    planName: null,
    storage: null,
};
const groupSamples = {
    'manager, live plan': managerLive,
    'manager, lapsed and an ended plan': managerLapsed,
    'manager, billing off': managerBillingOff,
    'member, live plan': memberLive,
    'member who pays a lapsed plan': memberPaysLapsed,
    'member, lapsed plan': memberLapsed,
    'member, no plan': memberNoPlan,
    'member, billing off': memberBillingOff,
};

/* ------------------------------------------------------------------------- */
/* Referrals and affiliates */

type Affiliate = Reply<typeof growth.listAffiliates>[number];
const creator: Affiliate = {
    id: affiliateId,
    name: 'Ada Reviews',
    slug: 'ada',
    code: 'ADA20',
    url: 'http://localhost:5173/go/ada',
    percentOff: 20,
    duration: 'repeating',
    durationMonths: 3,
    commissionBps: 2500,
    active: true,
    userId,
    pendingEmail: null,
    notes: 'Video in December.',
    providerDiscountId: 'disc_ada',
    createdAt: '2026-10-01T12:00:00.000Z',
    stats: {
        signups: 12,
        orders: 3,
        earnings: { usd: { unpaid: 374, paid: 1248 }, eur: { unpaid: 0, paid: 114 } },
    },
};
const pending: Affiliate = {
    ...creator,
    id: otherId,
    slug: 'grace',
    code: 'GRACE',
    url: 'http://localhost:5173/go/grace',
    duration: 'once',
    durationMonths: null,
    active: false,
    userId: null,
    pendingEmail: 'grace@example.com',
    notes: null,
    providerDiscountId: null,
    stats: { signups: 0, orders: 0, earnings: {} },
};

/*
 * Per route: the replies the package can give, the object a new column would surface in (a stray
 * field is planted there and at the top), and a field the reply cannot go out without.
 */
type Case = {
    schema: AnySchema;
    samples: Record<string, unknown>;
    /* Where the top-level stray goes: the reply, or its first element for a list. */
    top?: (value: any) => Record<string, unknown>;
    stray: (value: any) => Record<string, unknown>;
    /* Which sample to cut, and the cut. */
    required: [string, (value: any) => void];
};
const cases: Record<string, Case> = {
    'GET /billing/catalogue': {
        schema: catalogueResponse,
        samples: {
            'on sale': catalogue satisfies Reply<typeof billing.listCatalogue>,
            'billing off': {
                enabled: false,
                freeQuotaBytes: GiB(5),
                plans: [],
                families: [],
            } satisfies Reply<typeof billing.listCatalogue>,
        },
        stray: (v) => v.families[0] ?? v,
        required: ['on sale', (v) => delete v.families[1].includedMembers],
    },
    'GET /billing, and sync, cancel and resume': {
        schema: summaryResponse,
        samples: {
            live: liveSummary,
            'billing off': {
                enabled: false,
                hasCustomer: false,
                subscription: null,
                intendedPlan: null,
                intendedFamily: null,
                family: null,
            } satisfies Summary,
            'no customer, a plan and a family chosen at signup': {
                enabled: true,
                hasCustomer: false,
                subscription: null,
                intendedPlan: 'prod_pro_month',
                intendedFamily: { plan: 'prod_family_pro_month', currency: 'eur' },
                family: null,
            } satisfies Summary,
            'lapsed, in no currency': {
                ...liveSummary,
                subscription: {
                    ...liveSummary.subscription!,
                    status: 'unpaid',
                    amount: null,
                    currency: null,
                },
                intendedFamily: { plan: 'prod_family', currency: null },
            } satisfies Summary,
            'ended, pooled in a family with no live plan': {
                ...liveSummary,
                subscription: {
                    ...liveSummary.subscription!,
                    status: 'canceled',
                    cancelAtPeriodEnd: true,
                    endedAt: '2026-11-08T10:00:00.000Z',
                },
                family: { name: 'The Lovelaces', planName: null },
            } satisfies Summary,
            pooled: {
                ...liveSummary,
                subscription: null,
                family: { name: 'The Lovelaces', planName: 'Family Pro (monthly)' },
            } satisfies Summary,
        },
        stray: (v) => v.subscription ?? v.family ?? v.intendedFamily ?? v,
        required: ['live', (v) => delete v.subscription.endedAt],
    },
    'POST /billing/checkout': {
        schema: checkoutResponse,
        samples: {
            'a new checkout': { url: checkoutUrl } satisfies Reply<typeof billing.startCheckout>,
            'switched in place': { url: null } satisfies Reply<typeof billing.startCheckout>,
            'the bank wants a confirmation': {
                url: portal,
                confirmPayment: true,
            } satisfies Reply<typeof billing.startCheckout>,
        },
        stray: (v) => v,
        required: ['a new checkout', (v) => delete v.url],
    },
    'POST /billing/portal and the family checkout and portal': {
        schema: urlResponse,
        samples: {
            portal: { url: portal } satisfies Reply<typeof billing.createPortalSession>,
            'family portal': { url: portal } satisfies Reply<
                typeof billing.createGroupPortalSession
            >,
            'family checkout': { url: checkoutUrl } satisfies Reply<
                typeof billing.startGroupCheckout
            >,
        },
        stray: (v) => v,
        required: ['portal', (v) => delete v.url],
    },
    'POST /billing/coupon': {
        schema: couponResponse,
        samples: { kept: { code: 'ADA20' } satisfies Reply<typeof growth.rememberCoupon> },
        stray: (v) => v,
        required: ['kept', (v) => delete v.code],
    },
    'POST /billing/intended-family/forget': {
        schema: forgottenResponse,
        samples: { forgotten: { success: true as const } },
        stray: (v) => v,
        required: ['forgotten', (v) => delete v.success],
    },
    'GET /billing/groups/:id and its sync': {
        schema: groupBillingResponse,
        samples: groupSamples satisfies Record<string, Reply<typeof billing.syncGroup>>,
        stray: (v) => v.subscription ?? v.lapsedPlan ?? v.usage ?? v,
        required: ['manager, live plan', (v) => delete v.subscription.paidUnits],
    },
    'POST /billing/groups/:id/cancel and resume': {
        schema: groupBillingChangedResponse,
        samples: {
            'set to end': { billing: managerEnding } satisfies Reply<
                typeof billing.cancelGroupPlan
            >,
            resumed: { billing: managerLive } satisfies Reply<typeof billing.resumeGroupPlan>,
        },
        stray: (v) => v.billing,
        required: ['set to end', (v) => delete v.billing.seats],
    },
    'POST /billing/groups/:id/units': {
        schema: groupUnitsResponse,
        samples: {
            raised: { billing: managerLive, url: null } satisfies Reply<
                typeof billing.setGroupUnits
            >,
            'the bank wants the payer': {
                billing: managerLive,
                url: portal,
                confirmPayment: true,
            } satisfies Reply<typeof billing.setGroupUnits>,
        },
        stray: (v) => v.billing.usage,
        required: ['raised', (v) => delete v.url],
    },
    'POST /billing/groups/:id/plan': {
        schema: groupPlanResponse,
        samples: {
            now: { billing: managerLive, url: null, when: 'now' } satisfies Reply<
                typeof billing.changeGroupPlan
            >,
            'now, the bank wants the payer': {
                billing: managerLive,
                url: portal,
                confirmPayment: true,
                when: 'now',
            } satisfies Reply<typeof billing.changeGroupPlan>,
            renewal: { billing: managerLive, url: null, when: 'renewal' } satisfies Reply<
                typeof billing.changeGroupPlan
            >,
            kept: { billing: managerLive, url: null, when: 'kept' } satisfies Reply<
                typeof billing.changeGroupPlan
            >,
        },
        stray: (v) => v.billing.plans[0],
        required: ['renewal', (v) => delete v.when],
    },
    'GET /billing/referrals': {
        schema: referralsResponse,
        samples: {
            'runs a creator': {
                code: 'k3x9q2',
                url: 'http://localhost:5173/r/k3x9q2',
                joined: 4,
                signup: { count: 3, bytes: GiB(3), bonusBytes: GiB(1), capBytes: GiB(10) },
                paid: { count: 1, bytes: GiB(5), bonusBytes: GiB(5), capBytes: GiB(50) },
                affiliates: [creator],
            } satisfies Reply<typeof growth.getReferralSummary>,
            'nothing yet': {
                code: 'k3x9q2',
                url: 'http://localhost:5173/r/k3x9q2',
                joined: 0,
                signup: { count: 0, bytes: '0', bonusBytes: GiB(1), capBytes: GiB(10) },
                paid: { count: 0, bytes: '0', bonusBytes: '0', capBytes: '0' },
                affiliates: [],
            } satisfies Reply<typeof growth.getReferralSummary>,
        },
        stray: (v) => v.affiliates[0]?.stats ?? v.signup,
        required: ['runs a creator', (v) => delete v.affiliates[0].providerDiscountId],
    },
    'GET /billing/affiliates': {
        schema: affiliatesResponse,
        samples: {
            two: [creator, pending] satisfies Reply<typeof growth.listAffiliates>,
            none: [] satisfies Reply<typeof growth.listAffiliates>,
        },
        top: (v) => v[0] ?? {},
        stray: (v) => v[1]?.stats ?? {},
        required: ['two', (v) => delete v[1].pendingEmail],
    },
    'POST /billing/affiliates and PATCH /billing/affiliates/:id': {
        schema: affiliateResponse,
        samples: {
            created: pending satisfies Reply<typeof growth.createAffiliate>,
            updated: creator satisfies Reply<typeof growth.updateAffiliate>,
        },
        stray: (v) => v.stats,
        required: ['updated', (v) => delete v.stats.earnings],
    },
    'GET /billing/affiliates/handle': {
        schema: handleResponse,
        samples: { free: { free: true }, taken: { free: false } },
        stray: (v) => v,
        required: ['taken', (v) => delete v.free],
    },
    'DELETE /billing/affiliates/:id': {
        schema: affiliateDeletedResponse,
        samples: { deleted: { deleted: true } satisfies Reply<typeof growth.deleteAffiliate> },
        stray: (v) => v,
        required: ['deleted', (v) => delete v.deleted],
    },
    'POST /billing/affiliates/:id/paid': {
        schema: affiliatePaidResponse,
        samples: {
            paid: { paid: 3 } satisfies Reply<typeof growth.markAffiliatePaid>,
            'nothing owed': { paid: 0 } satisfies Reply<typeof growth.markAffiliatePaid>,
        },
        stray: (v) => v,
        required: ['paid', (v) => delete v.paid],
    },
};

describe.each(Object.entries(cases))('%s', (_route, { schema, samples, top, stray, required }) => {
    test.each(Object.entries(samples))('goes out unchanged: %s', async (_name, sample) => {
        expect(await serve(schema, sample)).toEqual({ status: 200, body: sample });
    });

    test.each(Object.entries(samples))(
        'drops a field the schema does not name: %s',
        async (_name, sample) => {
            const planted = clone(sample) as any;
            (top ?? ((v) => v))(planted).leaked = 'top';
            stray(planted).customerEmail = 'nested';
            const { status, body } = await serve(schema, planted);
            expect(status).toBe(200);
            expect(body).toEqual(sample);
            expect(JSON.stringify(body)).not.toMatch(/leaked|customerEmail/);
        },
    );

    test('fails rather than send a reply missing a required field', async () => {
        const [name, cut] = required;
        const short = clone(samples[name]);
        cut(short);
        expect((await serve(schema, short)).status).toBe(500);
    });
});

/* A family member who doesn't manage the plan sees no prices, payer or places, whatever is planted. */
test("a member's glance never carries the manager's plan", async () => {
    const planted = {
        ...clone(memberLive),
        plans: managerLive.plans,
        payer: managerLive.payer,
        subscription: managerLive.subscription,
        seats: managerLive.seats,
        nextPlace: managerLive.nextPlace,
    };
    const { status, body } = await serve(groupBillingResponse, planted);
    expect(status).toBe(200);
    expect(body).toEqual(memberLive);
});

/* Prices and earnings are keyed by currency: a field planted inside one is dropped too. */
test('drops a field planted inside a per-currency price or earning', async () => {
    const prices = clone(catalogue) as any;
    prices.families[0].prices.usd.providerPriceId = 'price_x';
    expect(await serve(catalogueResponse, prices)).toEqual({ status: 200, body: catalogue });
    const earnings = clone(creator) as any;
    earnings.stats.earnings.usd.orderIds = ['order_x'];
    expect(await serve(affiliateResponse, earnings)).toEqual({ status: 200, body: creator });
});

/* A price is whole minor units: a decimal amount is a bug upstream, never sent as a price. */
test('refuses an amount that is not whole minor units', async () => {
    const catalogueDecimal = clone(catalogue) as any;
    catalogueDecimal.plans[0].prices.eur = 4.59;
    expect((await serve(catalogueResponse, catalogueDecimal)).status).toBe(500);
    const family = clone(catalogue) as any;
    family.families[0].prices.usd.perMember = 2.5;
    expect((await serve(catalogueResponse, family)).status).toBe(500);
    const summary = clone(liveSummary) as any;
    summary.subscription.amount = '4.59';
    expect((await serve(summaryResponse, summary)).status).toBe(500);
    const place = clone(managerLive) as any;
    place.nextPlace.amount = 172.8;
    expect((await serve(groupBillingResponse, place)).status).toBe(500);
    const earnings = clone(creator) as any;
    earnings.stats.earnings.usd.unpaid = '374';
    expect((await serve(affiliateResponse, earnings)).status).toBe(500);
});

/* A field typed as one of a set: a value outside it fails rather than going out. */
test('refuses a view, tier, standing, change or duration outside its set', async () => {
    const view = clone(memberLive) as any;
    view.view = 'owner';
    expect((await serve(groupBillingResponse, view)).status).toBe(500);
    const tier = clone(catalogue) as any;
    tier.families[0].tier = 'ultra';
    expect((await serve(catalogueResponse, tier)).status).toBe(500);
    const interval = clone(catalogue) as any;
    interval.plans[0].interval = 'week';
    expect((await serve(catalogueResponse, interval)).status).toBe(500);
    const standing = clone(managerLapsed) as any;
    standing.lapsedPlan.standing = 'ended';
    expect((await serve(groupBillingResponse, standing)).status).toBe(500);
    const when = clone(cases['POST /billing/groups/:id/plan']!.samples.now) as any;
    when.when = 'later';
    expect((await serve(groupPlanResponse, when)).status).toBe(500);
    const duration = clone(creator) as any;
    duration.duration = 'weekly';
    expect((await serve(affiliateResponse, duration)).status).toBe(500);
});

/*
 * A status Polar adds later goes out as it is: the clients read an unknown one as an ended plan,
 * where a refusal would break the billing page and Account on the phones.
 */
test('passes a subscription status it does not know', async () => {
    const summary = clone(liveSummary) as any;
    summary.subscription.status = 'some_new_status';
    expect(await serve(summaryResponse, summary)).toEqual({ status: 200, body: summary });
});

/* The schemas guard nothing unless the routes carry them: every billing route names its own. */
const expectedSchemas: Record<string, AnySchema> = {
    'GET /api/billing/catalogue': catalogueResponse,
    'GET /api/billing': summaryResponse,
    'POST /api/billing/checkout': checkoutResponse,
    'GET /api/billing/referrals': referralsResponse,
    'POST /api/billing/coupon': couponResponse,
    'POST /api/billing/portal': urlResponse,
    'POST /api/billing/sync': summaryResponse,
    'POST /api/billing/cancel': summaryResponse,
    'POST /api/billing/resume': summaryResponse,
    'POST /api/billing/intended-family/forget': forgottenResponse,
    'GET /api/billing/groups/:id': groupBillingResponse,
    'POST /api/billing/groups/:id/checkout': urlResponse,
    'POST /api/billing/groups/:id/units': groupUnitsResponse,
    'POST /api/billing/groups/:id/plan': groupPlanResponse,
    'POST /api/billing/groups/:id/portal': urlResponse,
    'POST /api/billing/groups/:id/cancel': groupBillingChangedResponse,
    'POST /api/billing/groups/:id/resume': groupBillingChangedResponse,
    'POST /api/billing/groups/:id/sync': groupBillingResponse,
    'GET /api/billing/affiliates': affiliatesResponse,
    'GET /api/billing/affiliates/handle': handleResponse,
    'POST /api/billing/affiliates': affiliateResponse,
    'PATCH /api/billing/affiliates/:id': affiliateResponse,
    'DELETE /api/billing/affiliates/:id': affiliateDeletedResponse,
    'POST /api/billing/affiliates/:id/paid': affiliatePaidResponse,
};

test('each billing route carries its reply schema', async () => {
    const app = await loadApi();
    const routes = (
        app.routes as unknown as (ApiRoute & { hooks: { response?: unknown } })[]
    ).filter((r) => r.path === '/api/billing' || r.path.startsWith('/api/billing/'));
    for (const [key, schema] of Object.entries(expectedSchemas)) {
        const [method, path] = key.split(' ');
        const route = routes.find((r) => r.method === method && r.path === path);
        expect(route, key).toBeDefined();
        expect((route!.hooks.response as Record<number, unknown>)[200], key).toEqual(schema);
    }
    // A route added later without a schema, or one this list forgot, fails here.
    const unlisted = routes
        .map((r) => `${r.method} ${r.path}`)
        .filter((key) => !(key in expectedSchemas));
    expect(unlisted).toEqual([]);
});
