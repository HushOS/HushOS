import { createPolar, type models } from '@polar-sh/sdk/2026-04';
import { PLAN_METADATA_KEY, QUOTA_METADATA_KEY, RECOMMENDED_METADATA_KEY } from '../src/protocol';

/*
 * Creates the HushOS plan products in the Polar organisation the token belongs to.
 * Idempotent by product name: existing products are left alone unless `--update`
 * is passed, which makes this file the source of truth for price, description,
 * and metadata. A changed price replaces the product's price for new checkouts
 * and plan switches; existing subscribers keep the price they signed up at.
 */
const token = process.env.POLAR_ACCESS_TOKEN;
const environment = process.env.POLAR_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production';
if (!token) throw new Error('Set POLAR_ACCESS_TOKEN (needs products:read and products:write).');
const update = process.argv.includes('--update');

const GIB = 1_073_741_824n;
const tiers = [
    { name: 'Plus', quota: 200n * GIB, month: 500, year: 5000, recommended: false },
    { name: 'Pro', quota: 500n * GIB, month: 1000, year: 10000, recommended: true },
    { name: 'Max', quota: 1024n * GIB, month: 1500, year: 15000, recommended: false },
];

const polar = createPolar({ accessToken: token, environment });
const existing = new Map<string, models.Product>();
for await (const product of polar.products.iterList({ is_recurring: true, limit: 100 }))
    if (!product.is_archived) existing.set(product.name, product);

console.log(`Seeding ${environment} organisation${update ? ' (updating existing products)' : ''}`);
for (const tier of tiers) {
    const storage =
        tier.quota >= 1024n * GIB ? `${tier.quota / (1024n * GIB)} TiB` : `${tier.quota / GIB} GiB`;
    for (const interval of ['month', 'year'] as const) {
        const name = `${tier.name} (${interval === 'month' ? 'monthly' : 'yearly'})`;
        const amount = interval === 'month' ? tier.month : tier.year;
        const description = `${storage} of end-to-end encrypted storage.`;
        const metadata = {
            [PLAN_METADATA_KEY]: tier.name.toLowerCase(),
            [QUOTA_METADATA_KEY]: tier.quota.toString(),
            [RECOMMENDED_METADATA_KEY]: tier.recommended ? 'true' : 'false',
        };
        const price: models.ProductPriceFixedCreate = {
            amount_type: 'fixed',
            price_amount: amount,
            price_currency: 'usd',
        };
        const current = existing.get(name);
        if (!current) {
            const product = await polar.products.create({
                name,
                description,
                recurring_interval: interval,
                prices: [price],
                metadata,
            });
            console.log(`  created  ${name}  ${product.id}`);
            continue;
        }
        if (!update) {
            console.log(`  exists   ${name}`);
            continue;
        }
        const live = current.prices.find(
            (candidate): candidate is models.ProductPriceFixed =>
                'amount_type' in candidate &&
                candidate.amount_type === 'fixed' &&
                !candidate.is_archived,
        );
        const samePrice = live?.price_amount === amount && live.price_currency === 'usd';
        const sameRest =
            current.description === description &&
            Object.entries(metadata).every(
                ([key, value]) => String(current.metadata[key] ?? 'false') === value,
            );
        if (samePrice && sameRest) {
            console.log(`  current  ${name}`);
            continue;
        }
        await polar.products.update(current.id, {
            description,
            metadata,
            // A new price replaces the old one; leaving the old one out archives it.
            prices: samePrice && live ? [{ id: live.id }] : [price],
        });
        const change = samePrice
            ? ''
            : `  ${(live?.price_amount ?? 0) / 100} -> ${amount / 100} USD`;
        console.log(`  updated  ${name}${change}`);
    }
}
