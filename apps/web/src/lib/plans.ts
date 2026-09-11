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
