import { freeGroupSubscription } from './free';
import { attempt, loadState, polar, saveState, show } from './sandbox';

/*
 * E7: is there a cap on quantity? Units 1001 (and 10001) on a free unit-priced Family
 * subscription; seats 1001 on a throwaway seat-based product, both as a checkout quote and as
 * an update of a free seat subscription. The portal setting is for the owner to check.
 */
const monthly = (await loadState()).familyMonthly as string;

const unitSub = await freeGroupSubscription('e7Units', monthly, 6);
for (const units of [1001, 10001]) {
    const updated = await attempt(`unit subscription units=${units} (invoice)`, () =>
        polar.subscriptions.update(unitSub.id, { units, proration_behavior: 'invoice' }),
    );
    if (updated.ok)
        show(`after units=${units}`, { units: updated.value.units, amount: updated.value.amount });
}
const unitQuote = await attempt('unit checkout quote units=1001', () =>
    polar.checkouts.create({ products: [monthly], currency: 'usd', units: 1001 }),
);
if (unitQuote.ok)
    show('unit quote 1001', {
        id: unitQuote.value.id,
        units: unitQuote.value.units,
        amount: unitQuote.value.amount,
    });

const state = await loadState();
if (typeof state.seatProduct !== 'string') {
    const product = await attempt('products.create exp-Seat throwaway (monthly)', () =>
        polar.products.create({
            name: 'exp-Seat throwaway (monthly)',
            description: 'Experiment: seat-based cap check.',
            recurring_interval: 'month',
            prices: [
                {
                    amount_type: 'seat_based',
                    price_currency: 'usd',
                    seat_tiers: { tiers: [{ min_seats: 1, max_seats: null, price_per_seat: 100 }] },
                },
            ],
            metadata: { hushos_experiment: 'true' },
        }),
    );
    if (!product.ok) process.exit(1);
    state.seatProduct = product.value.id;
    await saveState(state);
    // The free code is limited to named products, so add this one.
    const discount = await polar.discounts.get(state.freeDiscount as string);
    await attempt('discounts.update add seat product', () =>
        polar.discounts.update(discount.id, {
            products: [...discount.products.map((p) => p.id), product.value.id],
        }),
    );
}
const seatProduct = state.seatProduct as string;
const seatQuote = await attempt('seat checkout quote seats=1001', () =>
    polar.checkouts.create({ products: [seatProduct], currency: 'usd', seats: 1001 }),
);
if (seatQuote.ok)
    show('seat quote 1001', {
        id: seatQuote.value.id,
        seats: seatQuote.value.seats,
        amount: seatQuote.value.amount,
    });
const seatQuote1000 = await attempt('seat checkout quote seats=1000', () =>
    polar.checkouts.create({ products: [seatProduct], currency: 'usd', seats: 1000 }),
);
if (seatQuote1000.ok)
    show('seat quote 1000', {
        id: seatQuote1000.value.id,
        seats: seatQuote1000.value.seats,
        amount: seatQuote1000.value.amount,
    });

// A free seat subscription at 2 seats, then 1001.
const latest = await loadState();
let seatSubId = (latest.e7Seats as { subscription?: string } | undefined)?.subscription;
if (!seatSubId) {
    const { freeCheckout, subscriptionsOf } = await import('./free');
    const n = Date.now().toString(36);
    const team = await attempt('e7Seats: customers.create team', () =>
        polar.customers.create({
            type: 'team',
            external_id: `group:${crypto.randomUUID()}`,
            name: 'exp-e7Seats',
            owner: {
                email: `exp-owner+${n}@thebinary.dev`,
                name: 'exp-owner',
                external_id: `exp-user-${n}`,
            },
            metadata: { hushos_experiment: 'true' },
        }),
    );
    if (!team.ok) process.exit(1);
    latest.e7Seats = { customer: team.value.id };
    await saveState(latest);
    const checkout = await freeCheckout('e7Seats', {
        products: [seatProduct],
        customer_id: team.value.id,
        currency: 'usd',
        seats: 2,
    });
    const [sub] = await subscriptionsOf(team.value.id);
    seatSubId = sub?.id;
    latest.e7Seats = { customer: team.value.id, checkout: checkout?.id, subscription: seatSubId };
    await saveState(latest);
}
if (seatSubId) {
    const updated = await attempt('seat subscription seats=1001 (invoice)', () =>
        polar.subscriptions.update(seatSubId, { seats: 1001, proration_behavior: 'invoice' }),
    );
    if (updated.ok)
        show('after seats=1001', { seats: updated.value.seats, amount: updated.value.amount });
}
