import type { models } from '@polar-sh/sdk/2026-04';
import { freeGroupSubscription } from './free';
import { attempt, loadState, polar, show } from './sandbox';

/*
 * E3, the parts a 100%-off subscription can answer: raise 6→7 with `invoice`, cut to 6 with
 * `next_period`, raise to 8 with `invoice`, and read `pending_update` after each. Amounts are
 * all zero here, so nothing about charges, 402s or proration amounts is tested. Also: a cut
 * below the minimum, and a change while the plan is set to cancel.
 */
const monthly = (await loadState()).familyMonthly as string;
const sub = await freeGroupSubscription('e3', monthly, 6);

function summary(s: models.Subscription) {
    return {
        units: s.units,
        amount: s.amount,
        pending_update: s.pending_update,
        cancel_at_period_end: s.cancel_at_period_end,
        current_period_end: s.current_period_end,
    };
}

async function step(label: string, body: models.SubscriptionUpdate) {
    const result = await attempt(label, () => polar.subscriptions.update(sub.id, body));
    if (result.ok) show(`${label} response`, summary(result.value));
    await Bun.sleep(1500);
    show(`${label} re-read`, summary(await polar.subscriptions.get(sub.id)));
}

show('start', summary(await polar.subscriptions.get(sub.id)));
if ((await polar.subscriptions.get(sub.id)).units === 6) {
    await step('1. units=7 invoice', { units: 7, proration_behavior: 'invoice' });
    await step('2. units=6 next_period', { units: 6, proration_behavior: 'next_period' });
    await step('3. units=8 invoice', { units: 8, proration_behavior: 'invoice' });
    await step('4. units=5 next_period (below minimum)', {
        units: 5,
        proration_behavior: 'next_period',
    });
    await step('5. units=7 next_period again', { units: 7, proration_behavior: 'next_period' });
    await step('6. units=9 prorate while a cut is pending', {
        units: 9,
        proration_behavior: 'prorate',
    });
    await step('7. cancel at period end', { cancel_at_period_end: true });
    await step('8. units=10 invoice while set to cancel', {
        units: 10,
        proration_behavior: 'invoice',
    });
    await step('9. resume', { cancel_at_period_end: false });
}
