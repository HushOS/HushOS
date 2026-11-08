import type { models } from '@polar-sh/sdk/2026-04';
import { attempt, loadState, polar, show } from './sandbox';

/*
 * T1 follow-up on the merged pending updates: does a second next_period change replace only
 * its own field, and does an immediate raise (or a clear) drop the pending product change too?
 */
const FAMILY_PLUS_MONTHLY = '1b9924fe-976f-422d-9e22-82da14aff772';
const FAMILY_MAX_MONTHLY = '2e97ab39-861a-404f-9213-d4ce15d0ec78';
const names: Record<string, string> = {
    [FAMILY_PLUS_MONTHLY]: 'Plus',
    [FAMILY_MAX_MONTHLY]: 'Max',
    'f43e960e-600a-45c1-b714-79fe45b81014': 'Pro',
};
const state = await loadState();
const a = (state.t1a as { subscription: string }).subscription;
const b = (state.t1b as { subscription: string }).subscription;

async function step(label: string, id: string, body: models.SubscriptionUpdate) {
    const result = await attempt(`${label} ${JSON.stringify(body)}`, () =>
        polar.subscriptions.update(id, body),
    );
    if (!result.ok) show(`${label} error`, { status: result.status, error: result.error });
    await Bun.sleep(1500);
    const s = await polar.subscriptions.get(id);
    show(`${label} re-read`, {
        product: names[s.product_id] ?? s.product_id,
        units: s.units,
        pending: s.pending_update
            ? {
                  id: s.pending_update.id,
                  product: s.pending_update.product_id ? names[s.pending_update.product_id] : null,
                  units: s.pending_update.units,
              }
            : null,
    });
}

await step('A3 units → 4 next_period (pending was Plus + 5)', a, {
    units: 4,
    proration_behavior: 'next_period',
});
await step('A4 units 6→7 invoice (immediate raise)', a, {
    units: 7,
    proration_behavior: 'invoice',
});
await step('B3 product → Max next_period (pending was Plus + 5)', b, {
    product_id: FAMILY_MAX_MONTHLY,
    proration_behavior: 'next_period',
});
await step('B4 product → Max invoice (immediate upgrade)', b, {
    product_id: FAMILY_MAX_MONTHLY,
    proration_behavior: 'invoice',
});
