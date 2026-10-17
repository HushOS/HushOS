import type { models } from '@polar-sh/sdk/2026-04';
import { freeGroupSubscription } from './free';
import { attempt, loadState, polar, show } from './sandbox';

/*
 * E4 part 2: switch a free Family (monthly) subscription with 8 units to Family (yearly).
 * Do the units stay at 8, and does the switch start a new period at once (an immediate
 * invoice)? Order reads need `orders:read`; without it the period dates are the evidence.
 */
const state = await loadState();
const monthly = state.familyMonthly as string;
const yearly = state.familyYearly as string;

function summary(s: models.Subscription) {
    return {
        id: s.id,
        status: s.status,
        product:
            s.product_id === monthly
                ? 'monthly'
                : s.product_id === yearly
                  ? 'yearly'
                  : s.product_id,
        interval: s.recurring_interval,
        units: s.units,
        amount: s.amount,
        currency: s.currency,
        current_period_start: s.current_period_start,
        current_period_end: s.current_period_end,
        pending_update: s.pending_update,
        prices: s.prices.map((p) => (p as unknown as Record<string, unknown>).id),
    };
}

const before = await freeGroupSubscription('e4', monthly, 8);
show('before', summary(before));
if (before.product_id === monthly) {
    // `prorate` is passed on purpose: the docs say an interval change forces `invoice`.
    const switched = await attempt('subscriptions.update product_id=yearly proration=prorate', () =>
        polar.subscriptions.update(before.id, {
            product_id: yearly,
            proration_behavior: 'prorate',
        }),
    );
    if (switched.ok) show('response', summary(switched.value));
}
await Bun.sleep(3000);
show('re-read', summary(await polar.subscriptions.get(before.id)));
const e4Customer = ((await loadState()).e4 as { customer: string }).customer;
const customerState = await attempt('customers.getState', () =>
    polar.customers.getState(e4Customer),
);
if (customerState.ok)
    show(
        'customer state subscriptions',
        customerState.value.active_subscriptions.map((s) => ({
            id: s.id,
            units: (s as unknown as Record<string, unknown>).units,
            interval: s.recurring_interval,
            current_period_start: s.current_period_start,
            current_period_end: s.current_period_end,
        })),
    );
