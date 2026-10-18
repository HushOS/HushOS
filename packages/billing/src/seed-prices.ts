import { DEFAULT_CURRENCY } from './protocol';

/*
 * The prices scripts/seed.ts gives the plan products at Polar, in minor units per currency,
 * kept apart from the script so the table is checked by tests (seed-prices.test.ts) and
 * again by the script before it calls Polar.
 *
 * Personal plans: 5, 10 and 15 USD or EUR a month, 4, 8 and 12 GBP, 199, 399 and 699 INR.
 * A year (owner, 2026-10-19) is a round total that splits evenly into twelve, at more than
 * two months free (2.1 to 3, so the pages say "More than 2 months free"), so the pricing
 * page can show it by the month without cents: 48, 96 and 144 USD or EUR (4, 8 and 12 a
 * month), 36, 72 and 108 GBP (3, 6, 9), and 1,980, 3,900 and 6,900 INR (165, 325, 575). It replaced "a year is ten months". Changing a live price
 * takes the seed's `--update`, which gives new checkouts and plan switches the new price
 * while existing subscribers keep the one they signed up at.
 */
export const GIB = 1_073_741_824n;
export type PriceTable = Record<string, number> & Record<typeof DEFAULT_CURRENCY, number>;

export const tiers: {
    name: string;
    quota: bigint;
    recommended: boolean;
    month: PriceTable;
    year: PriceTable;
}[] = [
    {
        name: 'Plus',
        quota: 200n * GIB,
        recommended: false,
        month: { usd: 500, eur: 500, gbp: 400, inr: 19900 },
        year: { usd: 4800, eur: 4800, gbp: 3600, inr: 198000 },
    },
    {
        name: 'Pro',
        quota: 500n * GIB,
        recommended: true,
        month: { usd: 1000, eur: 1000, gbp: 800, inr: 39900 },
        year: { usd: 9600, eur: 9600, gbp: 7200, inr: 390000 },
    },
    {
        name: 'Max',
        quota: 1024n * GIB,
        recommended: false,
        month: { usd: 1500, eur: 1500, gbp: 1200, inr: 69900 },
        year: { usd: 14400, eur: 14400, gbp: 10800, inr: 690000 },
    },
];

/*
 * Family plans (owner, 2026-10-18): Family Plus 800 GB, Pro 2 TB, Max 4 TB at 10, 20
 * and 30 USD a month, four members included, then 1.50 USD a member a month,
 * the same on every tier, up to 20 members (protocol.ts). EUR at parity, GBP at
 * 0.8; INR follows the personal plans' ratio (199/399/699 rupees against 5/10/15
 * dollars, about 40 to the dollar and nearer 47 at the top): 399, 799 and 1,399
 * rupees, so Plus costs what personal Pro does and Pro and Max twice personal Pro
 * and Max, and 59 rupees a member.
 *
 * A year (owner, 2026-10-19), like the personal plans', is a round total that splits
 * evenly into twelve: 96, 192 and 288 USD or EUR (8, 16 and 24 a month), 72, 144 and 216
 * GBP (6, 12, 18), and 3,900, 7,800 and 13,800 INR (325, 650, 1,150). A member past the
 * included ones still costs ten months a year: 15 USD or EUR, 12 GBP, 590 INR. It replaced
 * "a year is ten months" for the base; `--update` gives new checkouts and tier changes the
 * new price, and families already paying keep theirs.
 */
export const familyIncluded = 4;
/* A month's price for each member past the included ones; a year's is ten of them. */
export const familyPerMember: PriceTable = { usd: 150, eur: 150, gbp: 120, inr: 5900 };
export const FAMILY_PER_MEMBER_YEAR_FACTOR = 10;
export const familyTiers: {
    tier: string;
    name: string;
    quota: bigint;
    recommended: boolean;
    month: PriceTable;
    year: PriceTable;
}[] = [
    {
        tier: 'plus',
        name: 'Family Plus',
        quota: 800n * GIB,
        recommended: false,
        month: { usd: 1000, eur: 1000, gbp: 800, inr: 39900 },
        year: { usd: 9600, eur: 9600, gbp: 7200, inr: 390000 },
    },
    {
        tier: 'pro',
        name: 'Family Pro',
        quota: 2048n * GIB,
        recommended: true,
        month: { usd: 2000, eur: 2000, gbp: 1600, inr: 79900 },
        year: { usd: 19200, eur: 19200, gbp: 14400, inr: 780000 },
    },
    {
        tier: 'max',
        name: 'Family Max',
        quota: 4096n * GIB,
        recommended: false,
        month: { usd: 3000, eur: 3000, gbp: 2400, inr: 139900 },
        year: { usd: 28800, eur: 28800, gbp: 21600, inr: 1380000 },
    },
];

/*
 * Why a table can't be seeded, or null: a typo caught before anything reaches Polar. Every
 * price has a default-currency amount (Polar treats a missing one as free); a year is priced
 * in the same currencies as the month, splits into twelve whole units of its currency (the
 * pricing page shows it by the month only then), and costs less than ten months, since the
 * pages say "More than 2 months free".
 */
export function priceProblem(name: string, month: PriceTable, year: PriceTable) {
    if (!(DEFAULT_CURRENCY in month) || !(DEFAULT_CURRENCY in year))
        return `${name} has no ${DEFAULT_CURRENCY.toUpperCase()} price; Polar treats that as free.`;
    if (Object.keys(year).sort().join() !== Object.keys(month).sort().join())
        return `${name} is priced yearly in other currencies than monthly.`;
    for (const [currency, amount] of Object.entries(year)) {
        if (!Number.isInteger(amount) || amount <= 0 || amount % 1200 !== 0)
            return `${name} yearly in ${currency} doesn’t split into twelve whole units.`;
        if (amount >= month[currency]! * 10)
            return `${name} yearly in ${currency} isn’t more than two months free.`;
    }
    return null;
}

/* Every table's problems, empty when the seed may run. */
export function seedPriceProblems() {
    const problems = [...tiers, ...familyTiers].map((tier) =>
        priceProblem(tier.name, tier.month, tier.year),
    );
    for (const currency of Object.keys(familyTiers[0]!.month))
        if (!(currency in familyPerMember))
            problems.push(`Family has no per-member ${currency} price.`);
    return problems.filter((problem): problem is string => problem !== null);
}
