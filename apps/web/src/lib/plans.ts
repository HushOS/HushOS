import type { Plan } from '@hushos/billing/api';

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
