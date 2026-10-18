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

/* A family plan's name without its billing period: "Family Pro (monthly)" → "Family Pro". */
export const familyTierName = (plan: Pick<FamilyPlan, 'name'>) =>
    plan.name.replace(/\s*\((monthly|yearly|annual)\)\s*$/i, '');

export type FamilyOffer = {
    plan: FamilyPlan;
    /* "Family Pro". */
    name: string;
    /* "2 TB". */
    storage: string;
    /* "$20 a month", or a yearly plan's month: "$16.67 a month". */
    price: string;
    /* "Billed monthly. $200 a year if you pay yearly." or "Billed $200 yearly." */
    billed: string;
    /* "For up to 4 members, sharing 2 TB." */
    size: string;
    /* "Then $1.50 a month for each member after that, up to 20." */
    extra: string;
};

/*
 * The family tiers the pricing page offers, smallest pool first, or none:
 * with billing off, or where the server lists no family plan (it lists none
 * without GROUPS_ENABLED). Each tier is its plan billed at `interval`, else its
 * other one, priced in `currency` or the default; whole amounts drop the cents.
 */
export function familyOffers(
    catalogue: Pick<Catalogue, 'enabled' | 'families'>,
    interval: 'month' | 'year',
    currency: string,
): FamilyOffer[] {
    if (!catalogue.enabled) return [];
    // The catalogue sorts by pool; a tier is its monthly and yearly product of one pool.
    const sizes = [...new Set(catalogue.families.map((plan) => plan.quotaBytes))];
    return sizes.flatMap((quotaBytes) => {
        const both = catalogue.families.filter((plan) => plan.quotaBytes === quotaBytes);
        const plan = both.find((candidate) => candidate.interval === interval) ?? both[0];
        const price = plan && familyPrice(plan, currency);
        if (!plan || !price) return [];
        const money = (minor: number) => formatMoney(minor, price.currency);
        const yearly = both.find((candidate) => candidate.interval === 'year');
        const yearlyPrice = yearly && familyPrice(yearly, price.currency);
        const per = plan.interval === 'year' ? 'a year' : 'a month';
        const storage = formatQuota(plan.quotaBytes);
        return [
            {
                plan,
                name: familyTierName(plan),
                storage,
                price: `${money(plan.interval === 'year' ? Math.round(price.base / 12) : price.base)} a month`,
                billed:
                    plan.interval === 'year'
                        ? `Billed ${money(price.base)} yearly.`
                        : yearlyPrice && yearlyPrice.currency === price.currency
                          ? `Billed monthly. ${money(yearlyPrice.base)} a year if you pay yearly.`
                          : 'Billed monthly.',
                size: `For up to ${plan.includedMembers} members, sharing ${storage}.`,
                extra: `Then ${money(price.perMember)} ${per} for each member after that, up to ${plan.maxMembers}.`,
            },
        ];
    });
}

/* The pool counts only family folders; a member's own drive keeps its own allowance. */
export const FAMILY_POOL_LINE =
    'The storage is for family folders; each member’s own files stay on their own plan, Free included.';

/*
 * The pricing page's lede. "Nothing else" holds only while no family plan is
 * offered: a family plan adds family folders, so with one shown the lede says so.
 */
export function pricingLede(family: readonly FamilyOffer[]) {
    const same = 'Every plan protects your files the same way.';
    const max = Math.max(0, ...family.map((offer) => offer.plan.maxMembers));
    return family.length
        ? `${same} Paid plans add space; a family plan adds folders you share with up to ${max} members.`
        : `${same} Paid plans add space, and nothing else.`;
}
