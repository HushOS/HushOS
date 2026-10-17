import { attempt, loadState, polar } from './sandbox';

/* Read-only: which scopes the current sandbox token has, by calling one list endpoint per scope. */
await attempt('orders:read (orders.list)', () => polar.orders.list({ limit: 1 }));
await attempt('webhooks:read (webhooks.listWebhookEndpoints)', () =>
    polar.webhooks.listWebhookEndpoints({ limit: 1 }),
);
await attempt('checkout_links:read (checkoutLinks.list)', () =>
    polar.checkoutLinks.list({ limit: 1 }),
);
const team = (await loadState()).e1Team as string;
await attempt('members:read (customers.members.list)', () =>
    polar.customers.members.list(team, { limit: 1 }),
);
await attempt('events:read (events.list)', () => polar.events.list({ limit: 1 }));
await attempt('organizations:read (organizations.list)', () =>
    polar.organizations.list({ limit: 1 }),
);
