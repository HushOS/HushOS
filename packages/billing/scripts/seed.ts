import { createPolar, type models } from '@polar-sh/sdk/2026-04';
import {
    DEFAULT_CURRENCY,
    PLAN_METADATA_KEY,
    QUOTA_METADATA_KEY,
    RECOMMENDED_METADATA_KEY,
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
        tier.quota >= 1024n * GIB ? `${tier.quota / (1024n * GIB)} TiB` : `${tier.quota / GIB} GiB`;
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
