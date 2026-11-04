import type { BillingSubscription, Catalogue, FamilyPlan, Plan } from '@hushos/billing/api';
import { DEFAULT_CURRENCY, planStanding, planTierName } from '@hushos/billing/protocol';
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
            name: planTierName(plan),
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
 * when `byMonth` (yearsByMonth, decided once for the page) and the year splits into whole
 * months, otherwise by the year alone ("₹3,990 a year", "Billed yearly."), never a month with
 * cents in it. `line` is the planner's one sentence.
 */
export function yearlyPrice(amount: number, currency: string, byMonth: boolean) {
    const money = (minor: number) => formatMoney(minor, currency);
    return byMonth && splitsIntoMonths(amount)
        ? {
              byMonth: true,
              price: `${money(amount / 12)} a month`,
              billed: `Billed ${money(amount)} yearly.`,
              line: `${money(amount / 12)} a month, billed ${money(amount)} yearly.`,
          }
        : {
              byMonth: false,
              price: `${money(amount)} a year`,
              billed: 'Billed yearly.',
              line: `${money(amount)} a year.`,
          };
}

/*
 * Whether "2 months free" is true of every plan priced both ways, in `currency`: each yearly
 * price is at most ten months of its monthly one (personal and family bases, and a family's
 * extra member). A catalogue with a year dearer than that, or none priced both ways, gets no
 * saving label at all. Each pair is one tier's monthly and yearly price.
 */
export function twoMonthsFree(pairs: readonly { month?: number; year?: number }[]) {
    const both = pairs.filter(
        (pair): pair is { month: number; year: number } =>
            pair.month !== undefined && pair.year !== undefined,
    );
    return both.length > 0 && both.every((pair) => pair.year <= pair.month * 10);
}

/* The monthly and yearly price pairs of the personal tiers, in `currency`. */
export function personalPairs(plans: readonly Plan[], currency: string) {
    return tiersOf([...plans]).map((tier) => ({
        month: tier.month && priceOf(tier.month, currency).amount,
        year: tier.year && priceOf(tier.year, currency).amount,
    }));
}

/* The monthly and yearly price pairs of the family tiers (base and extra member), in `currency`. */
export function familyPairs(plans: readonly FamilyPlan[], currency: string) {
    const sizes = [...new Set(plans.map((plan) => plan.quotaBytes))];
    return sizes.flatMap((quotaBytes) => {
        const of = (interval: 'month' | 'year') => {
            const plan = plans.find(
                (candidate) =>
                    candidate.quotaBytes === quotaBytes && candidate.interval === interval,
            );
            const price = plan && familyPrice(plan, currency);
            return price && price.currency === currency ? price : undefined;
        };
        const month = of('month');
        const year = of('year');
        return [
            { month: month?.base, year: year?.base },
            { month: month?.perMember, year: year?.perMember },
        ];
    });
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

/*
 * What happens to a personal plan of theirs when someone's files join a family's pool
 * (docs/families-shared-pool.md 5.1), said before they pay or are let in; `when` ends
 * the clause ("the family’s plan starts", "you’re let in"). A live plan ends with its
 * unused days refunded. A lapsed one (its payment failed, or paused) is ended too, with
 * nothing refunded: no part of it is in use. Null when they have neither.
 */
export function personalPlanEnding(
    subscription: BillingSubscription | null | undefined,
    when: string,
): string | null {
    if (!subscription) return null;
    const standing = planStanding(subscription);
    const name = familyTierName({ name: subscription.productName });
    if (standing === 'live')
        return `Your ${name} plan ends when ${when}, and the unused days are refunded.`;
    if (standing === 'payment-failed')
        return `Your ${name} plan, whose payment didn’t go through, ends when ${when}. Nothing is refunded: no part of it is in use.`;
    if (standing === 'paused')
        return `Your paused ${name} plan ends when ${when}. Nothing is refunded: no part of it is in use.`;
    return null;
}

/* A family plan's name without its billing period: "Family Pro (monthly)" → "Family Pro". */
export const familyTierName = (plan: Pick<FamilyPlan, 'name'>) => planTierName(plan);

export type FamilyOffer = {
    plan: FamilyPlan;
    /* "Family Pro". */
    name: string;
    /* "2 TB". */
    storage: string;
    /* The currency it is priced in: the one asked for, or the default where it has none. */
    currency: string;
    /* "$20 a month", or a yearly plan as yearlyPrice writes it: "$16 a month". */
    price: string;
    /*
     * "Billed monthly. $192 a year if you pay yearly.", or by the month "Billed $192 yearly,
     * plus $15 for each extra member.", so every figure after the month is a yearly one.
     */
    billed: string;
    /*
     * "Each extra member is $1.50 a month." ("$15 a year" on a yearly plan shown by the year),
     * or null where `billed` says it. The members included are said once, above the tiers.
     */
    extra: string | null;
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
        const money = (minor: number) => formatMoney(minor, price.currency);
        const yearly = both.find((candidate) => candidate.interval === 'year');
        const yearlyBase = yearly && familyPrice(yearly, price.currency);
        const per = plan.interval === 'year' ? 'a year' : 'a month';
        const byYear =
            plan.interval === 'year' ? yearlyPrice(price.base, price.currency, byMonth) : null;
        const extra = money(price.perMember);
        return [
            {
                plan,
                name: familyTierName(plan),
                storage: formatQuota(plan.quotaBytes),
                currency: price.currency,
                price: byYear ? byYear.price : `${money(price.base)} a month`,
                billed: byYear?.byMonth
                    ? `Billed ${money(price.base)} yearly, plus ${extra} for each extra member.`
                    : byYear
                      ? byYear.billed
                      : yearlyBase && yearlyBase.currency === price.currency
                        ? `Billed monthly. ${money(yearlyBase.base)} a year if you pay yearly.`
                        : 'Billed monthly.',
                extra: byYear?.byMonth ? null : `Each extra member is ${extra} ${per}.`,
            },
        ];
    });
}

/*
 * One pool covers every member's own files and the family folders (docs/families-shared-pool.md),
 * said the same way on the pricing page and on Plans. "Storage", never "pool", in what people read.
 */
export const FAMILY_POOL_LINE =
    'A family’s storage covers everyone’s own files and the family folders. Each person’s own files stay private to them.';

/*
 * The pricing page's lede. "Nothing else" holds only while no family plan is
 * offered: a family plan covers everyone in it and adds folders they share, so
 * with one shown the lede says so.
 */
export function pricingLede(family: readonly FamilyOffer[]) {
    const same = 'Every plan protects your files the same way.';
    const max = Math.max(0, ...family.map((offer) => offer.plan.maxMembers));
    return family.length
        ? `${same} Paid plans add space; a family plan covers up to ${max} people, with folders you share.`
        : `${same} Paid plans add space, and nothing else.`;
}
