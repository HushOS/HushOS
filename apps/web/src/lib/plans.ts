import type { Catalogue, FamilyPlan, Plan } from '@hushos/billing/api';
import { DEFAULT_CURRENCY } from '@hushos/billing/protocol';
import { formatMoney, formatQuota, PRICE_LOCALE } from '@/lib/format';

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

/* A price in minor units as the pricing page writes it, in its fixed locale. */
export const formatPrice = (minor: number, currency: string) =>
    formatMoney(minor, currency, PRICE_LOCALE);

/* Whether a yearly price in minor units splits into twelve whole units of its currency. */
export const splitsIntoMonths = (amount: number) => amount % 1200 === 0;

/*
 * Whether every yearly price the catalogue lists, in `currency`, splits into whole months, as
 * every price HushOS sells does. The pricing page then shows each year by its month, and
 * otherwise (a self-hoster's own prices, say) each by the year alone: never a mix in one row.
 */
export function yearsByMonth(catalogue: Pick<Catalogue, 'plans' | 'families'>, currency: string) {
    const personal = catalogue.plans
        .filter((plan) => plan.interval === 'year')
        .map((plan) => priceOf(plan, currency).amount);
    const family = catalogue.families
        .filter((plan) => plan.interval === 'year')
        .flatMap((plan) => familyPrice(plan, currency)?.base ?? []);
    return [...personal, ...family].every(splitsIntoMonths);
}

/*
 * A yearly price as a card shows it: by the month ("₹325 a month", "Billed ₹3,900 yearly.")
 * when `byMonth` (see yearsByMonth) and the year splits into whole months, otherwise by the
 * year alone ("₹3,990 a year", "Billed yearly."), never a month with cents in it. `line` is
 * the planner's one sentence.
 */
export function yearlyPrice(amount: number, currency: string, byMonth = true) {
    const money = (minor: number) => formatPrice(minor, currency);
    return byMonth && splitsIntoMonths(amount)
        ? {
              price: `${money(amount / 12)} a month`,
              billed: `Billed ${money(amount)} yearly.`,
              line: `${money(amount / 12)} a month, billed ${money(amount)} yearly.`,
          }
        : {
              price: `${money(amount)} a year`,
              billed: 'Billed yearly.',
              line: `${money(amount)} a year.`,
          };
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
    /* "$20 a month", or a yearly plan as yearlyPrice writes it: "$16 a month". */
    price: string;
    /* "Billed monthly. $192 a year if you pay yearly." or "Billed $192 yearly." */
    billed: string;
    /* "Each extra member is $1.50 a month." The members included are said once, above the tiers. */
    extra: string;
};

/*
 * The family tiers the pricing page offers, smallest pool first, or none:
 * with billing off, or where the server lists no family plan (it lists none
 * without GROUPS_ENABLED). Each tier is its plan billed at `interval`, else its
 * other one, priced in `currency` or the default; whole amounts drop the cents.
 * A yearly tier shows its month only when `byMonth` (yearsByMonth, for the page).
 */
export function familyOffers(
    catalogue: Pick<Catalogue, 'enabled' | 'families'>,
    interval: 'month' | 'year',
    currency: string,
    byMonth = yearsByMonth({ plans: [], families: catalogue.families }, currency),
): FamilyOffer[] {
    if (!catalogue.enabled) return [];
    // The catalogue sorts by pool; a tier is its monthly and yearly product of one pool.
    const sizes = [...new Set(catalogue.families.map((plan) => plan.quotaBytes))];
    return sizes.flatMap((quotaBytes) => {
        const both = catalogue.families.filter((plan) => plan.quotaBytes === quotaBytes);
        const plan = both.find((candidate) => candidate.interval === interval) ?? both[0];
        const price = plan && familyPrice(plan, currency);
        if (!plan || !price) return [];
        const money = (minor: number) => formatPrice(minor, price.currency);
        const yearly = both.find((candidate) => candidate.interval === 'year');
        const yearlyBase = yearly && familyPrice(yearly, price.currency);
        const per = plan.interval === 'year' ? 'a year' : 'a month';
        const byYear =
            plan.interval === 'year' ? yearlyPrice(price.base, price.currency, byMonth) : null;
        return [
            {
                plan,
                name: familyTierName(plan),
                storage: formatQuota(plan.quotaBytes),
                price: byYear ? byYear.price : `${money(price.base)} a month`,
                billed: byYear
                    ? byYear.billed
                    : yearlyBase && yearlyBase.currency === price.currency
                      ? `Billed monthly. ${money(yearlyBase.base)} a year if you pay yearly.`
                      : 'Billed monthly.',
                extra: `Each extra member is ${money(price.perMember)} ${per}.`,
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
