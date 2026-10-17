import type { Catalogue, FamilyPlan, Plan } from '@hushos/billing/api';
import { DEFAULT_CURRENCY } from '@hushos/billing/protocol';
import { formatMoney, formatQuota } from '@/lib/format';

export type Tier = {
    key: string;
    name: string;
    description: string | null;
    quotaBytes: string;
    recommended: boolean;
    month?: Plan;
    year?: Plan;
};

/*
 * Monthly and yearly are separate products at Polar; the pricing page shows one
 * column per storage size. Tiers keep the catalogue's order, which is by quota.
 */
/* The plan's price in a currency, or its default price when it has none there. */
export function priceOf(plan: Plan, currency: string) {
    const amount = plan.prices[currency];
    return amount === undefined
        ? { amount: plan.amount, currency: plan.currency }
        : { amount, currency };
}

/*
 * The currencies every plan is priced in, default first, so a selector never
 * shows a currency some column would have to fall back from.
 */
export function currenciesOf(plans: Plan[]) {
    if (!plans.length) return [];
    const shared = plans
        .map((plan) => new Set(Object.keys(plan.prices)))
        .reduce((common, set) => new Set([...common].filter((currency) => set.has(currency))));
    const fallback = plans[0]!.currency;
    return [fallback, ...[...shared].filter((currency) => currency !== fallback).sort()];
}

export function tiersOf(plans: Plan[]) {
    const tiers = new Map<string, Tier>();
    for (const plan of plans) {
        const tier = tiers.get(plan.quotaBytes) ?? {
            key: plan.quotaBytes,
            name: plan.name.replace(/\s*\((monthly|yearly|annual)\)\s*$/i, ''),
            description: plan.description,
            quotaBytes: plan.quotaBytes,
            recommended: false,
        };
        tier[plan.interval] = plan;
        tier.recommended ||= plan.recommended;
        tiers.set(plan.quotaBytes, tier);
    }
    return [...tiers.values()];
}

/* Said beside every family price (lib/family-billing.ts explains why). */
export const TAX_LINE = 'Plus tax where it applies; Polar adds it at checkout.';

/* A family plan's prices in a currency, or in the default when it has none there. */
export function familyPrice(plan: FamilyPlan, currency: string) {
    const price = plan.prices[currency];
    if (price) return { ...price, currency };
    const fallback = plan.prices[DEFAULT_CURRENCY];
    return fallback ? { ...fallback, currency: DEFAULT_CURRENCY } : null;
}

export type FamilyOffer = {
    plan: FamilyPlan;
    /* "$15 a month", or a yearly plan's month: "$12.50 a month". */
    price: string;
    /* "Billed monthly. $150 a year if you pay yearly." or "Billed $150 yearly." */
    billed: string;
    /* "For up to 6 members, sharing 2 TB." */
    size: string;
    /* "The 2 TB is for family folders; each member’s own files stay on their own plan, Free included." */
    pool: string;
    /* "Then $2 a month for each member after that, up to 20." */
    extra: string;
};

/*
 * What the pricing page offers a family, or null when it offers none: with
 * billing off, or where the server lists no family plan (it lists none
 * without GROUPS_ENABLED). The plan is the one billed at `interval`, else the
 * other one, priced in `currency` or the default; whole amounts drop the cents.
 */
export function familyOffer(
    catalogue: Pick<Catalogue, 'enabled' | 'families'>,
    interval: 'month' | 'year',
    currency: string,
): FamilyOffer | null {
    if (!catalogue.enabled) return null;
    const { families } = catalogue;
    const plan =
        families.find((candidate) => candidate.interval === interval) ??
        families.find((candidate) => candidate.interval === 'month') ??
        families[0];
    const price = plan && familyPrice(plan, currency);
    if (!plan || !price) return null;
    const money = (minor: number) => formatMoney(minor, price.currency);
    const yearly = families.find((candidate) => candidate.interval === 'year');
    const yearlyPrice = yearly && familyPrice(yearly, price.currency);
    const per = plan.interval === 'year' ? 'a year' : 'a month';
    return {
        plan,
        price: `${money(plan.interval === 'year' ? Math.round(price.base / 12) : price.base)} a month`,
        billed:
            plan.interval === 'year'
                ? `Billed ${money(price.base)} yearly.`
                : yearlyPrice && yearlyPrice.currency === price.currency
                  ? `Billed monthly. ${money(yearlyPrice.base)} a year if you pay yearly.`
                  : 'Billed monthly.',
        size: `For up to ${plan.includedMembers} members, sharing ${formatQuota(plan.quotaBytes)}.`,
        // The pool counts only family folders; a member's own drive keeps its own allowance.
        pool: `The ${formatQuota(plan.quotaBytes)} is for family folders; each member’s own files stay on their own plan, Free included.`,
        extra: `Then ${money(price.perMember)} ${per} for each member after that, up to ${plan.maxMembers}.`,
    };
}

/*
 * The pricing page's lede. "Nothing else" holds only while no family plan is
 * offered: a family plan adds family folders, so with one shown the lede says so.
 */
export function pricingLede(family: FamilyOffer | null) {
    const same = 'Every plan protects your files the same way.';
    return family
        ? `${same} Paid plans add space; a family plan adds folders you share with up to ${family.plan.maxMembers} members.`
        : `${same} Paid plans add space, and nothing else.`;
}
