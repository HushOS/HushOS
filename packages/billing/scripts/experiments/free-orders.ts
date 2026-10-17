import { showOrders, showSystemEvents, showWebhookTrail } from './card';
import { attempt, loadState, polar, show } from './sandbox';

/*
 * Read-only, after the scopes widened: the orders and webhook trail of the free subscriptions
 * from E1, E4 part 2, E3 and E7, to fill in what `orders:read` and `webhooks:read` hid.
 */
const state = await loadState();
const endpoints = await attempt('webhooks.listWebhookEndpoints', () =>
    polar.webhooks.listWebhookEndpoints({ limit: 10 }),
);
if (endpoints.ok)
    show(
        'endpoints',
        endpoints.value.items.map((e) => ({
            id: e.id,
            events: e.events,
            enabled: (e as unknown as Record<string, unknown>).enabled,
        })),
    );

const subjects: [string, string | undefined, string | undefined][] = [
    ['E1 family', state.e1FamilySubscription as string, state.e1Team as string],
    [
        'E4',
        (state.e4 as { subscription: string }).subscription,
        (state.e4 as { customer: string }).customer,
    ],
    [
        'E3',
        (state.e3 as { subscription: string }).subscription,
        (state.e3 as { customer: string }).customer,
    ],
    [
        'E7 units',
        (state.e7Units as { subscription: string }).subscription,
        (state.e7Units as { customer: string }).customer,
    ],
];
for (const [label, subscription, customer] of subjects) {
    if (!subscription || !customer) continue;
    await showOrders(label, subscription);
    await showWebhookTrail(label, [subscription, customer], '2026-10-17T02:30:00Z');
    await showSystemEvents(label, customer);
}
