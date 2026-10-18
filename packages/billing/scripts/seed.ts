import { createPolar, type models } from '@polar-sh/sdk/2026-10';
import {
    DEFAULT_CURRENCY,
    GROUP_KIND_METADATA_KEY,
    INCLUDED_MEMBERS_METADATA_KEY,
    PLAN_METADATA_KEY,
    QUOTA_METADATA_KEY,
    RECOMMENDED_METADATA_KEY,
    TIER_METADATA_KEY,
} from '../src/protocol';

/*
 * Creates the HushOS plan products in the Polar organisation the token belongs to.
 * Idempotent by product name: existing products are left alone unless `--update`
 * is passed, which makes this file the source of truth for prices, description,
 * and metadata. A changed price replaces the product's price in that currency for
 * new checkouts and plan switches; existing subscribers keep the price they signed
 * up at. Polar shows a customer the price in their local currency when the product
 * has one, and falls back to the organisation's default currency otherwise.
 */
/*
 * Flags: `--update` (above), and `--archive-legacy-family`, which archives the
 * single Family plan once the three family tiers exist (see the end of this file).
 */
const token = process.env.POLAR_ACCESS_TOKEN;
const environment = process.env.POLAR_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production';
if (!token) throw new Error('Set POLAR_ACCESS_TOKEN (needs products:read and products:write).');
const update = process.argv.includes('--update');

const GIB = 1_073_741_824n;
type Currency = models.PresentmentCurrency;
/* Monthly prices in minor units per currency; yearly is ten months. */
type Amounts = Partial<Record<Currency, number>> & Record<typeof DEFAULT_CURRENCY, number>;
const tiers: { name: string; quota: bigint; recommended: boolean; month: Amounts }[] = [
    {
        name: 'Plus',
        quota: 200n * GIB,
        recommended: false,
        month: { usd: 500, eur: 500, gbp: 400, inr: 19900 },
    },
    {
        name: 'Pro',
        quota: 500n * GIB,
        recommended: true,
        month: { usd: 1000, eur: 1000, gbp: 800, inr: 39900 },
    },
    {
        name: 'Max',
        quota: 1024n * GIB,
        recommended: false,
        month: { usd: 1500, eur: 1500, gbp: 1200, inr: 69900 },
    },
];

for (const tier of tiers)
    if (!(DEFAULT_CURRENCY in tier.month))
        throw new Error(
            `${tier.name} has no ${DEFAULT_CURRENCY.toUpperCase()} price; Polar treats that as free.`,
        );

const polar = createPolar({ accessToken: token, environment });
const existing = new Map<string, models.Product>();
for await (const product of polar.products.iterList({ is_recurring: true, limit: 100 }))
    if (!product.is_archived) existing.set(product.name, product);

function livePrices(product: models.Product) {
    const prices = new Map<string, models.ProductPriceFixed>();
    for (const candidate of product.prices)
        if (
            'amount_type' in candidate &&
            candidate.amount_type === 'fixed' &&
            !candidate.is_archived &&
            !prices.has(candidate.price_currency)
        )
            prices.set(candidate.price_currency, candidate);
    return prices;
}

function describe(amounts: Record<string, number>) {
    return Object.entries(amounts)
        .map(([currency, amount]) => `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`)
        .join(', ');
}

console.log(`Seeding ${environment} organisation${update ? ' (updating existing products)' : ''}`);
for (const tier of tiers) {
    const storage =
        // Counted in 1024s and labelled GB and TB, as the app shows sizes.
        tier.quota >= 1024n * GIB ? `${tier.quota / (1024n * GIB)} TB` : `${tier.quota / GIB} GB`;
    for (const interval of ['month', 'year'] as const) {
        const name = `${tier.name} (${interval === 'month' ? 'monthly' : 'yearly'})`;
        const amounts = Object.fromEntries(
            Object.entries(tier.month).map(([currency, amount]) => [
                currency,
                interval === 'month' ? amount : amount * 10,
            ]),
        ) as Amounts;
        const description = `${storage} of end-to-end encrypted storage.`;
        const metadata = {
            [PLAN_METADATA_KEY]: tier.name.toLowerCase(),
            [QUOTA_METADATA_KEY]: tier.quota.toString(),
            [RECOMMENDED_METADATA_KEY]: tier.recommended ? 'true' : 'false',
        };
        const creates = Object.entries(amounts).map(([currency, amount]) => ({
            currency: currency as Currency,
            create: {
                amount_type: 'fixed',
                price_amount: amount,
                price_currency: currency as Currency,
            } satisfies models.ProductPriceFixedCreate,
        }));
        const current = existing.get(name);
        if (!current) {
            const product = await polar.products.create({
                name,
                description,
                recurring_interval: interval,
                prices: creates.map(({ create }) => create),
                metadata,
            });
            console.log(`  created  ${name}  ${product.id}  ${describe(amounts)}`);
            continue;
        }
        if (!update) {
            console.log(`  exists   ${name}`);
            continue;
        }
        const live = livePrices(current);
        // Unchanged currencies keep their price row; changed or new ones get a fresh
        // row, and a currency left out of the table is archived by omission.
        const prices = creates.map(({ currency, create }) => {
            const row = live.get(currency);
            return row && row.price_amount === create.price_amount ? { id: row.id } : create;
        });
        const samePrices = prices.every((price) => 'id' in price) && live.size === creates.length;
        const sameRest =
            current.description === description &&
            Object.entries(metadata).every(
                ([key, value]) => String(current.metadata[key] ?? 'false') === value,
            );
        if (samePrices && sameRest) {
            console.log(`  current  ${name}`);
            continue;
        }
        await polar.products.update(current.id, { description, metadata, prices });
        console.log(`  updated  ${name}${samePrices ? '' : `  ${describe(amounts)}`}`);
    }
}

/*
 * Family plans (docs/groups-design.md 3.5; the shape is the spike's E2
 * product, docs/polar-group-billing-spike.md 8): three tiers, each a monthly
 * and a yearly product. Per currency, a fixed base and a graduated unit price,
 * free up to the included members, then a per-member rate, with
 * `minimum_units` at the included count and the same bound in every currency
 * (the catalogue drops a product whose currencies disagree). `quota_bytes` is
 * the whole family's pool; `hushos_tier` names the tier.
 *
 * Prices (owner, 2026-10-18): Family Plus 800 GB, Pro 2 TB, Max 4 TB at 10, 20
 * and 30 USD a month, four members included, then 1.50 USD a member a month,
 * the same on every tier, up to 20 members (protocol.ts). EUR at parity, GBP at
 * 0.8; INR follows the personal plans' ratio (199/399/699 rupees against 5/10/15
 * dollars, about 40 to the dollar and nearer 47 at the top): 399, 799 and 1,399
 * rupees, so Plus costs what personal Pro does and Pro and Max twice personal Pro
 * and Max, and 59 rupees a member. A year is ten months in every currency.
 *
 * FAMILY_PRICES_CONFIRMED gates production: until the owner confirms the
 * currency table, a production run skips the family products. Nothing in CI,
 * Docker or `dev` runs this file.
 */
const FAMILY_PRICES_CONFIRMED = false;
const archiveLegacyFamily = process.argv.includes('--archive-legacy-family');
const familyIncluded = 4;
const familyPerMember = { usd: 150, eur: 150, gbp: 120, inr: 5900 } as Amounts;
const familyTiers: {
    tier: string;
    name: string;
    quota: bigint;
    recommended: boolean;
    base: Amounts;
}[] = [
    {
        tier: 'plus',
        name: 'Family Plus',
        quota: 800n * GIB,
        recommended: false,
        base: { usd: 1000, eur: 1000, gbp: 800, inr: 39900 },
    },
    {
        tier: 'pro',
        name: 'Family Pro',
        quota: 2048n * GIB,
        recommended: true,
        base: { usd: 2000, eur: 2000, gbp: 1600, inr: 79900 },
    },
    {
        tier: 'max',
        name: 'Family Max',
        quota: 4096n * GIB,
        recommended: false,
        base: { usd: 3000, eur: 3000, gbp: 2400, inr: 139900 },
    },
];
const unitLabel = { en: { '=1': 'member', other: 'members' } };

function familyPrices(base: Amounts, interval: 'month' | 'year') {
    const factor = interval === 'month' ? 1 : 10;
    return Object.entries(base).flatMap(([currency, amount]) => {
        const perMember = familyPerMember[currency as Currency];
        if (perMember === undefined) throw new Error(`Family has no per-member ${currency} price.`);
        return [
            {
                amount_type: 'fixed',
                price_currency: currency as Currency,
                price_amount: amount * factor,
            } satisfies models.ProductPriceFixedCreate,
            {
                amount_type: 'unit_based',
                price_currency: currency as Currency,
                tiers: {
                    type: 'graduated',
                    tiers: [
                        { bound: familyIncluded, unit_amount: 0 },
                        { bound: null, unit_amount: perMember * factor },
                    ],
                },
                minimum_units: familyIncluded,
                unit_label: unitLabel,
            } satisfies models.ProductPriceUnitBasedCreate,
        ];
    });
}

/* A live unit price that already says what `create` says: kept by id, as fixed prices are. */
function sameUnitPrice(
    row: models.ProductPriceUnitBased,
    create: models.ProductPriceUnitBasedCreate,
) {
    const tiers = row.tiers.tiers.map((tier) => [tier.bound ?? null, Number(tier.unit_amount)]);
    const wanted = create.tiers.tiers.map((tier) => [tier.bound ?? null, Number(tier.unit_amount)]);
    return (
        row.tiers.type === create.tiers.type &&
        JSON.stringify(tiers) === JSON.stringify(wanted) &&
        row.minimum_units === (create.minimum_units ?? null)
    );
}

/* Every family product this run wants, by name, so the archive step can check they all exist. */
const familyNames: string[] = [];
if (environment === 'production' && !FAMILY_PRICES_CONFIRMED) {
    console.log(
        '  skipped  Family plans: their prices are not confirmed (FAMILY_PRICES_CONFIRMED)',
    );
} else {
    for (const tier of familyTiers) {
        const storage =
            tier.quota >= 1024n * GIB
                ? `${tier.quota / (1024n * GIB)} TB`
                : `${tier.quota / GIB} GB`;
        for (const interval of ['month', 'year'] as const) {
            const name = `${tier.name} (${interval === 'month' ? 'monthly' : 'yearly'})`;
            familyNames.push(name);
            const description = `${storage} of end-to-end encrypted storage for the whole family, ${familyIncluded} members included.`;
            const metadata = {
                [PLAN_METADATA_KEY]: 'family',
                [GROUP_KIND_METADATA_KEY]: 'family',
                [TIER_METADATA_KEY]: tier.tier,
                [QUOTA_METADATA_KEY]: tier.quota.toString(),
                [INCLUDED_MEMBERS_METADATA_KEY]: String(familyIncluded),
                [RECOMMENDED_METADATA_KEY]: tier.recommended ? 'true' : 'false',
            };
            const creates = familyPrices(tier.base, interval);
            const current = existing.get(name);
            if (!current) {
                const product = await polar.products.create({
                    name,
                    description,
                    recurring_interval: interval,
                    prices: creates,
                    metadata,
                });
                existing.set(name, product);
                console.log(`  created  ${name}  ${product.id}`);
                continue;
            }
            if (!update) {
                console.log(`  exists   ${name}`);
                continue;
            }
            // Both kinds of price are matched per currency; a price left out would be archived.
            const live = current.prices.filter(
                (price): price is models.ProductPriceFixed | models.ProductPriceUnitBased =>
                    'amount_type' in price &&
                    !price.is_archived &&
                    (price.amount_type === 'fixed' || price.amount_type === 'unit_based'),
            );
            const prices = creates.map((create) => {
                const row = live.find(
                    (price) =>
                        price.amount_type === create.amount_type &&
                        price.price_currency === create.price_currency,
                );
                if (!row) return create;
                const same =
                    row.amount_type === 'fixed' && create.amount_type === 'fixed'
                        ? row.price_amount === create.price_amount
                        : row.amount_type === 'unit_based' && create.amount_type === 'unit_based'
                          ? sameUnitPrice(row, create)
                          : false;
                return same ? { id: row.id } : create;
            });
            const samePrices =
                prices.every((price) => 'id' in price) && live.length === creates.length;
            const sameRest =
                current.description === description &&
                Object.entries(metadata).every(
                    ([key, value]) => String(current.metadata[key]) === value,
                );
            if (samePrices && sameRest) {
                console.log(`  current  ${name}`);
                continue;
            }
            await polar.products.update(current.id, { description, metadata, prices });
            console.log(`  updated  ${name}`);
        }
    }
}

/*
 * `--archive-legacy-family` archives the single Family plan the tiers replace
 * ("Family (monthly)" and "Family (yearly)", a family product without
 * `hushos_tier`). Only on request, and only once all six tier products exist,
 * so a family can always buy a plan. Archiving stops new checkouts; anyone
 * still on the old plan keeps it and renews as before, and the catalogue still
 * reads it for them.
 */
if (archiveLegacyFamily) {
    const missing = familyNames.length
        ? familyNames.filter((name) => !existing.has(name))
        : ['the family tiers (skipped above)'];
    if (missing.length) {
        console.log(`  kept     Family (monthly), Family (yearly): ${missing.join(', ')} missing`);
    } else {
        for (const name of ['Family (monthly)', 'Family (yearly)']) {
            const legacy = existing.get(name);
            if (!legacy) {
                console.log(`  absent   ${name}`);
                continue;
            }
            if (
                legacy.metadata[GROUP_KIND_METADATA_KEY] !== 'family' ||
                legacy.metadata[TIER_METADATA_KEY] !== undefined
            ) {
                console.log(`  kept     ${name}: not the single Family plan`);
                continue;
            }
            await polar.products.update(legacy.id, { is_archived: true });
            console.log(`  archived ${name}  ${legacy.id}`);
        }
    }
}
