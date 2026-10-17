import type { models } from '@polar-sh/sdk/2026-04';
import { attempt, loadState, polar, saveState, show } from './sandbox';

/*
 * E2: can a product carry a fixed base plus a graduated unit price in four currencies, and
 * what do checkouts at 6 and 7 units quote? Also: are mismatched bounds across currencies
 * accepted, and the 100%-off `exp-free` code the later experiments use instead of a card.
 *
 * Prices are placeholders (the spike sets none): base 15 USD/EUR, 12 GBP, 599 INR a month,
 * yearly ten months; 2.00 (minor units 200) per member beyond six a month, 20.00 a year.
 */
type Currency = models.PresentmentCurrency;
const currencies: Currency[] = ['usd', 'eur', 'gbp', 'inr'];
const base: Record<string, number> = { usd: 1500, eur: 1500, gbp: 1200, inr: 59900 };
const unitLabel = { en: { '=1': 'member', other: 'members' } };

function prices(interval: 'month' | 'year', bound: (c: Currency) => number = () => 6) {
    const factor = interval === 'month' ? 1 : 10;
    return currencies.flatMap((currency) => [
        {
            amount_type: 'fixed',
            price_currency: currency,
            price_amount: base[currency]! * factor,
        } satisfies models.ProductPriceFixedCreate,
        {
            amount_type: 'unit_based',
            price_currency: currency,
            tiers: {
                type: 'graduated',
                tiers: [
                    { bound: bound(currency), unit_amount: 0 },
                    { bound: null, unit_amount: 200 * factor },
                ],
            },
            minimum_units: bound(currency),
            unit_label: unitLabel,
        } satisfies models.ProductPriceUnitBasedCreate,
    ]);
}

const metadata = {
    hushos_experiment: 'true',
    hushos_group_kind: 'family',
    included_members: 6,
    quota_bytes: String(2n * 1024n ** 4n),
};

const state = await loadState();

async function product(key: string, body: models.ProductCreate) {
    if (typeof state[key] === 'string') return polar.products.get(state[key] as string);
    const created = await attempt(`products.create ${body.name}`, () =>
        polar.products.create(body),
    );
    if (!created.ok) return null;
    state[key] = created.value.id;
    await saveState(state);
    return created.value;
}

const monthly = await product('familyMonthly', {
    name: 'exp-Family (monthly)',
    description: 'Experiment: fixed base plus graduated unit price.',
    recurring_interval: 'month',
    prices: prices('month'),
    metadata,
});
await product('familyYearly', {
    name: 'exp-Family (yearly)',
    description: 'Experiment: fixed base plus graduated unit price.',
    recurring_interval: 'year',
    prices: prices('year'),
    metadata,
});
if (monthly)
    show(
        'monthly prices',
        monthly.prices.map((p) => {
            const price = p as unknown as Record<string, unknown>;
            return {
                id: price.id,
                amount_type: price.amount_type,
                currency: price.price_currency,
                amount: price.price_amount,
                tiers: price.tiers,
                minimum_units: price.minimum_units,
                unit_label: price.unit_label,
            };
        }),
    );

// Mismatched bounds: EUR and INR include 5 members while USD and GBP include 6.
const mismatch = await product('familyMismatch', {
    name: 'exp-Family mismatch (monthly)',
    description: 'Experiment: tier bounds and minimums differ across currencies.',
    recurring_interval: 'month',
    prices: prices('month', (c) => (c === 'eur' || c === 'inr' ? 5 : 6)),
    metadata,
});
if (mismatch)
    show(
        'mismatch unit prices',
        mismatch.prices
            .map((p) => p as unknown as Record<string, unknown>)
            .filter((p) => p.amount_type === 'unit_based')
            .map((p) => ({
                currency: p.price_currency,
                tiers: p.tiers,
                minimum_units: p.minimum_units,
            })),
    );

// A personal plan for X's own subscription in E1, without `hushos_plan` so the app ignores it.
await product('personalMonthly', {
    name: 'exp-Personal (monthly)',
    description: 'Experiment: stands in for a personal plan.',
    recurring_interval: 'month',
    prices: [{ amount_type: 'fixed', price_currency: 'usd', price_amount: 500 }],
    metadata: { hushos_experiment: 'true' },
});

// Quotes: create checkouts and read their amounts; none is confirmed.
const quotes: Record<string, unknown>[] = [];
const quoted = Array.isArray(state.e2Checkouts);
for (const [key, label] of quoted
    ? []
    : ([
          ['familyMonthly', 'monthly'],
          ['familyYearly', 'yearly'],
      ] as const)) {
    const productId = state[key] as string | undefined;
    if (!productId) continue;
    for (const currency of currencies)
        for (const units of [5, 6, 7]) {
            const checkout = await attempt(`checkout ${label} ${currency} units=${units}`, () =>
                polar.checkouts.create({ products: [productId], currency, units }),
            );
            quotes.push(
                checkout.ok
                    ? {
                          label,
                          currency,
                          requested: units,
                          id: checkout.value.id,
                          units: checkout.value.units,
                          min_units: checkout.value.min_units,
                          amount: checkout.value.amount,
                          discount_amount: checkout.value.discount_amount,
                          net_amount: checkout.value.net_amount,
                          tax_amount: checkout.value.tax_amount,
                          total_amount: checkout.value.total_amount,
                          checkout_currency: checkout.value.currency,
                      }
                    : {
                          label,
                          currency,
                          requested: units,
                          status: checkout.status,
                          error: checkout.error,
                      },
            );
        }
}
if (!quoted) {
    show('quotes', quotes);
    state.e2Checkouts = quotes.map((q) => q.id).filter(Boolean);
}

// Does a checkout honour each currency's own minimum on the mismatched product?
if (typeof state.familyMismatch === 'string' && !Array.isArray(state.e2MismatchCheckouts)) {
    const ids: string[] = [];
    for (const currency of ['usd', 'eur'] as const) {
        const checkout = await attempt(`mismatch checkout ${currency} units=5`, () =>
            polar.checkouts.create({
                products: [state.familyMismatch as string],
                currency,
                units: 5,
            }),
        );
        if (checkout.ok) {
            ids.push(checkout.value.id);
            show(`mismatch ${currency} 5`, {
                units: checkout.value.units,
                amount: checkout.value.amount,
                currency: checkout.value.currency,
            });
        }
    }
    state.e2MismatchCheckouts = ids;
}

// The free code, limited to the experiment products.
if (typeof state.freeDiscount !== 'string') {
    const products = ['familyMonthly', 'familyYearly', 'personalMonthly']
        .map((key) => state[key])
        .filter((id): id is string => typeof id === 'string');
    const discount = await attempt('discounts.create exp-free', () =>
        polar.discounts.create({
            name: 'exp-free',
            // Polar refuses non-alphanumeric codes, so the code is EXPFREE; the name keeps the prefix.
            code: 'EXPFREE',
            type: 'percentage',
            basis_points: 10_000,
            duration: 'forever',
            products,
            metadata: { hushos_experiment: 'true' },
        }),
    );
    if (discount.ok) {
        state.freeDiscount = discount.value.id;
        show('discount', {
            id: discount.value.id,
            code: discount.value.code,
            duration: discount.value.duration,
        });
    }
}
await saveState(state);
