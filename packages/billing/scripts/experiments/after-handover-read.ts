import { createPolar } from '@polar-sh/sdk/2026-04';
import { showOrders, subscriptionSummary } from './card';
import { loadState, polar, SANDBOX_URL, show } from './sandbox';

/* Read-only: the 0341 subscription and the E6 team after their raises; cards, defaults, orders. */
async function view(
    label: string,
    body: Parameters<typeof polar.customerSessions.create>[0],
    subscriptionId: string,
) {
    const session = await polar.customerSessions.create(body);
    const portal = createPolar({
        accessToken: session.token,
        environment: 'sandbox',
        baseUrl: SANDBOX_URL,
    });
    const me = (await portal.customerPortal.customers.get()) as unknown as Record<string, unknown>;
    const cards = await portal.customerPortal.customers.listPaymentMethods({ limit: 10 });
    show(`${label}: cards`, {
        default_payment_method_id: me.default_payment_method_id,
        cards: cards.items.map((m) => {
            const raw = m as unknown as Record<string, unknown>;
            return {
                id: raw.id,
                last4: (raw.method_metadata as Record<string, unknown>).last4,
                created_at: raw.created_at,
            };
        }),
    });
    show(
        `${label}: subscription`,
        subscriptionSummary(await polar.subscriptions.get(subscriptionId)),
    );
    await showOrders(label, subscriptionId);
    const orders = await portal.customerPortal.orders.list({
        subscription_id: subscriptionId,
        limit: 20,
    });
    show(
        `${label}: portal order keys`,
        orders.items.map((o) => {
            const raw = o as unknown as Record<string, unknown>;
            return {
                id: raw.id,
                status: raw.status,
                keys: Object.keys(raw).filter((k) => /pay|card|method/.test(k)),
            };
        }),
    );
}
const state = await loadState();
const e6 = state.e6 as Record<string, string>;
await view(
    '0341 customer',
    { customer_id: '357f3005-3ab9-434e-9876-291eaf64579d' },
    '90197bd1-98cd-4408-a273-15d4552a1096',
);
const [e6Sub] = (await polar.subscriptions.list({ customer_id: e6.customer!, limit: 5 })).items;
await view(
    'e6 team (as new payer)',
    { external_customer_id: e6.group!, external_member_id: e6.newPayer! },
    e6Sub!.id,
);
