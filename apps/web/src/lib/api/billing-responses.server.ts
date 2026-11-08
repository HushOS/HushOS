import '@/lib/server-only';
import { t } from 'elysia';

/*
 * What every billing route answers (billing.server.ts), field for field: plans and checkout,
 * families' plans, referrals and affiliates. Elysia checks a reply against its schema and drops
 * every field the schema does not name, so a column added to a row later stays on the server.
 * Each mirrors the type in @hushos/billing/api that the handler returns: a field the schema
 * misses is silently dropped, and one it requires that the handler leaves out fails the request.
 * Amounts are whole minor units (integers), byte counts decimal strings, dates ISO strings.
 * Polar's subscription status and interval stay plain strings: Polar may add one, and the
 * clients read an unknown status as an ended plan, so the server must not refuse it.
 */

const interval = t.Union([t.Literal('month'), t.Literal('year')]);

/* Plan: one fixed price per currency, minor units by lowercase ISO code. */
const plan = t.Object({
    id: t.String(),
    name: t.String(),
    description: t.Nullable(t.String()),
    interval,
    amount: t.Integer(),
    currency: t.String(),
    prices: t.Record(t.String(), t.Integer()),
    quotaBytes: t.String(),
    recommended: t.Boolean(),
});

/* FamilyPlan: a base and a per-member price per currency; tier null for the plan before the tiers. */
const familyPlan = t.Object({
    id: t.String(),
    name: t.String(),
    description: t.Nullable(t.String()),
    interval,
    tier: t.Nullable(t.Union([t.Literal('plus'), t.Literal('pro'), t.Literal('max')])),
    recommended: t.Boolean(),
    prices: t.Record(t.String(), t.Object({ base: t.Integer(), perMember: t.Integer() })),
    includedMembers: t.Integer(),
    maxMembers: t.Integer(),
    quotaBytes: t.String(),
});

/* GET /billing/catalogue (Catalogue): empty lists with billing off. */
export const catalogueResponse = t.Object({
    enabled: t.Boolean(),
    freeQuotaBytes: t.String(),
    plans: t.Array(plan),
    families: t.Array(familyPlan),
});

/*
 * BillingSummary: GET /billing, and what sync, cancel and resume answer. The subscription is the
 * live plan, else a lapsed one, else the last; `endedAt` set once it ended. All null with billing off.
 */
export const summaryResponse = t.Object({
    enabled: t.Boolean(),
    hasCustomer: t.Boolean(),
    subscription: t.Nullable(
        t.Object({
            id: t.String(),
            productId: t.String(),
            productName: t.String(),
            status: t.String(),
            recurringInterval: t.String(),
            amount: t.Nullable(t.Integer()),
            currency: t.Nullable(t.String()),
            quotaBytes: t.String(),
            currentPeriodEnd: t.String(),
            cancelAtPeriodEnd: t.Boolean(),
            endedAt: t.Nullable(t.String()),
        }),
    ),
    intendedPlan: t.Nullable(t.String()),
    intendedFamily: t.Nullable(t.Object({ plan: t.String(), currency: t.Nullable(t.String()) })),
    family: t.Nullable(t.Object({ name: t.String(), planName: t.Nullable(t.String()) })),
});

/*
 * POST /billing/checkout: Polar's checkout; or, for a switch in place, null, or the portal with
 * `confirmPayment` when the bank wants the person to confirm the charge.
 */
export const checkoutResponse = t.Object({
    url: t.Nullable(t.String()),
    // Always true when present; typed boolean by startCheckout and BillingApi.
    confirmPayment: t.Optional(t.Boolean()),
});

/* A Polar page to send the person to: a portal, or a family's checkout. */
export const urlResponse = t.Object({ url: t.String() });

/* POST /billing/coupon: the code kept for the next checkout, as the provider or creator spells it. */
export const couponResponse = t.Object({ code: t.String() });

/* POST /billing/intended-family/forget. */
export const forgottenResponse = t.Object({ success: t.Literal(true) });

/* ------------------------------------------------------------------------- */
/* Families */

const standing = t.Union([t.Literal('payment-failed'), t.Literal('paused')]);
const pool = t.Nullable(t.Object({ usedBytes: t.String(), quotaBytes: t.String() }));
/* FamilyUsage: absent with billing off; `members` null for anyone who manages no one. */
const usage = t.Optional(
    t.Object({
        ownBytes: t.Nullable(t.String()),
        foldersBytes: t.String(),
        members: t.Nullable(t.Array(t.Object({ userId: t.String(), ownBytesRounded: t.String() }))),
    }),
);

/*
 * GroupBillingSummary, told apart by `view`. The manager's (FamilyBillingDetail) has no
 * `lapsedPlan` or `usage` with billing off; the member's glance (FamilyPlanGlance) has no
 * `lapsedPlan` while a plan is live, and its lapsed plan carries `ids` only for whoever pays.
 */
const groupBilling = t.Union([
    t.Object({
        enabled: t.Boolean(),
        view: t.Literal('manage'),
        plans: t.Array(familyPlan),
        payer: t.Nullable(t.Object({ userId: t.String(), you: t.Boolean() })),
        subscription: t.Nullable(
            t.Object({
                id: t.String(),
                productId: t.String(),
                productName: t.String(),
                status: t.String(),
                recurringInterval: t.String(),
                amount: t.Nullable(t.Integer()),
                currency: t.Nullable(t.String()),
                units: t.Integer(),
                paidUnits: t.Integer(),
                pendingUnits: t.Nullable(t.Integer()),
                pendingProductId: t.Nullable(t.String()),
                paidProductId: t.Nullable(t.String()),
                includedMembers: t.Integer(),
                quotaBytes: t.String(),
                currentPeriodStart: t.String(),
                currentPeriodEnd: t.String(),
                cancelAtPeriodEnd: t.Boolean(),
            }),
        ),
        lastPlan: t.Nullable(t.Object({ productName: t.String(), endedAt: t.String() })),
        lapsedPlan: t.Optional(
            t.Nullable(t.Object({ productName: t.String(), standing, ids: t.Array(t.String()) })),
        ),
        storage: pool,
        usage,
        seats: t.Object({ used: t.Integer(), limit: t.Integer() }),
        nextPlace: t.Nullable(t.Object({ amount: t.Integer(), currency: t.String() })),
    }),
    t.Object({
        enabled: t.Boolean(),
        view: t.Literal('member'),
        hasPlan: t.Boolean(),
        planName: t.Nullable(t.String()),
        lapsedPlan: t.Optional(
            t.Nullable(
                t.Object({
                    productName: t.String(),
                    standing,
                    youPay: t.Boolean(),
                    ids: t.Optional(t.Array(t.String())),
                }),
            ),
        ),
        storage: pool,
        usage,
    }),
]);

/* GET /billing/groups/:id and POST /billing/groups/:id/sync. */
export const groupBillingResponse = groupBilling;

/* POST /billing/groups/:id/cancel and /resume: the family's plan as Polar holds it after. */
export const groupBillingChangedResponse = t.Object({ billing: groupBilling });

/* POST /billing/groups/:id/units: the portal with `confirmPayment` when the bank wants the payer. */
export const groupUnitsResponse = t.Object({
    billing: groupBilling,
    url: t.Nullable(t.String()),
    confirmPayment: t.Optional(t.Literal(true)),
});

/* POST /billing/groups/:id/plan (PlanChange): a bigger tier now, a smaller one at renewal, or kept. */
export const groupPlanResponse = t.Object({
    billing: groupBilling,
    url: t.Nullable(t.String()),
    confirmPayment: t.Optional(t.Literal(true)),
    when: t.Union([t.Literal('now'), t.Literal('renewal'), t.Literal('kept')]),
});

/* ------------------------------------------------------------------------- */
/* Referrals and affiliates */

const duration = t.Union([t.Literal('once'), t.Literal('forever'), t.Literal('repeating')]);

/* AffiliateView: commission earned per currency, minor units, paid out or still owed. */
const affiliate = t.Object({
    id: t.String(),
    name: t.String(),
    slug: t.String(),
    code: t.String(),
    url: t.String(),
    percentOff: t.Integer(),
    duration,
    durationMonths: t.Nullable(t.Integer()),
    commissionBps: t.Integer(),
    active: t.Boolean(),
    userId: t.Nullable(t.String()),
    pendingEmail: t.Nullable(t.String()),
    notes: t.Nullable(t.String()),
    providerDiscountId: t.Nullable(t.String()),
    createdAt: t.String(),
    stats: t.Object({
        signups: t.Integer(),
        orders: t.Integer(),
        earnings: t.Record(t.String(), t.Object({ unpaid: t.Integer(), paid: t.Integer() })),
    }),
});

const rewards = t.Object({
    count: t.Integer(),
    bytes: t.String(),
    bonusBytes: t.String(),
    capBytes: t.String(),
});

/* GET /billing/referrals (ReferralSummary): the person's invite, and every creator they run. */
export const referralsResponse = t.Object({
    code: t.String(),
    url: t.String(),
    joined: t.Integer(),
    signup: rewards,
    paid: rewards,
    affiliates: t.Array(affiliate),
});

/* GET /billing/affiliates: newest first. */
export const affiliatesResponse = t.Array(affiliate);

/* POST /billing/affiliates and PATCH /billing/affiliates/:id. */
export const affiliateResponse = affiliate;

/* GET /billing/affiliates/handle. */
export const handleResponse = t.Object({ free: t.Boolean() });

/* DELETE /billing/affiliates/:id. */
export const affiliateDeletedResponse = t.Object({ deleted: t.Literal(true) });

/* POST /billing/affiliates/:id/paid: how many earnings were marked paid. */
export const affiliatePaidResponse = t.Object({ paid: t.Integer() });
