import type { models } from '@polar-sh/sdk/2026-04';
import { freeGroupSubscription } from './free';
import { attempt, loadState, polar, show } from './sandbox';

/*
 * T1: can a pending product change and a pending units change coexist? Free Family Pro
 * (monthly) subscriptions at 6 units (EXPFREE), then next_period changes in both orders and
 * in one call. Records what `pending_update` keeps after each step.
 */
const FAMILY_PLUS_MONTHLY = '1b9924fe-976f-422d-9e22-82da14aff772';
const FAMILY_PRO_MONTHLY = 'f43e960e-600a-45c1-b714-79fe45b81014';
const FAMILY_MAX_MONTHLY = '2e97ab39-861a-404f-9213-d4ce15d0ec78';
const names: Record<string, string> = {
    [FAMILY_PLUS_MONTHLY]: 'Family Plus (monthly)',
    [FAMILY_PRO_MONTHLY]: 'Family Pro (monthly)',
    [FAMILY_MAX_MONTHLY]: 'Family Max (monthly)',
};

// EXPFREE is limited to named products; add the monthly tiers.
const state = await loadState();
const discount = await polar.discounts.get(state.freeDiscount as string);
const have = new Set(discount.products.map((p) => p.id));
const want = [FAMILY_PLUS_MONTHLY, FAMILY_PRO_MONTHLY, FAMILY_MAX_MONTHLY].filter(
    (id) => !have.has(id),
);
if (want.length > 0)
    await attempt('discounts.update EXPFREE add the monthly family tiers', () =>
        polar.discounts.update(discount.id, { products: [...have, ...want] }),
    );

function pending(s: models.Subscription) {
    return {
        product: names[s.product_id] ?? s.product_id,
        units: s.units,
        pending_update: s.pending_update
            ? {
                  id: s.pending_update.id,
                  product: s.pending_update.product_id
                      ? (names[s.pending_update.product_id] ?? s.pending_update.product_id)
                      : null,
                  units: s.pending_update.units,
                  applies_at: s.pending_update.applies_at,
              }
            : null,
    };
}

async function step(label: string, id: string, body: models.SubscriptionUpdate) {
    const result = await attempt(`${label} ${JSON.stringify(body)}`, () =>
        polar.subscriptions.update(id, body),
    );
    if (!result.ok) show(`${label} error`, { status: result.status, error: result.error });
    await Bun.sleep(1500);
    show(`${label} re-read`, pending(await polar.subscriptions.get(id)));
}

const a = await freeGroupSubscription('t1a', FAMILY_PRO_MONTHLY, 6);
show('A start', pending(a));
if (!a.pending_update) {
    await step('A1 units 6→5 next_period', a.id, { units: 5, proration_behavior: 'next_period' });
    await step('A2 product → Plus next_period', a.id, {
        product_id: FAMILY_PLUS_MONTHLY,
        proration_behavior: 'next_period',
    });
}

const b = await freeGroupSubscription('t1b', FAMILY_PRO_MONTHLY, 6);
show('B start', pending(b));
if (!b.pending_update) {
    await step('B1 product → Plus next_period', b.id, {
        product_id: FAMILY_PLUS_MONTHLY,
        proration_behavior: 'next_period',
    });
    await step('B2 units 6→5 next_period', b.id, { units: 5, proration_behavior: 'next_period' });
}

const c = await freeGroupSubscription('t1c', FAMILY_PRO_MONTHLY, 6);
show('C start', pending(c));
if (!c.pending_update)
    await step('C1 product → Plus and units 5 in one call, next_period', c.id, {
        product_id: FAMILY_PLUS_MONTHLY,
        units: 5,
        proration_behavior: 'next_period',
    } as unknown as models.SubscriptionUpdate);
