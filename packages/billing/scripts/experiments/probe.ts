import { attempt, polar, SANDBOX_URL } from './sandbox';

/* Read-only: confirms which sandbox organisation the token belongs to and what already exists. */
console.log(`server ${SANDBOX_URL}`);
const orgs = await attempt('organizations.list', () => polar.organizations.list({ limit: 10 }));
if (orgs.ok)
    for (const org of orgs.value.items)
        console.log(
            `  org ${org.id} ${org.slug} default_currency=${org.default_presentment_currency}`,
        );
const products = await attempt('products.list', () => polar.products.list({ limit: 100 }));
if (products.ok)
    for (const p of products.value.items)
        console.log(
            `  product ${p.id} ${p.is_archived ? '(archived) ' : ''}${p.name} ${p.recurring_interval}`,
        );
const discounts = await attempt('discounts.list', () => polar.discounts.list({ limit: 100 }));
if (discounts.ok)
    for (const d of discounts.value.items) console.log(`  discount ${d.id} ${d.name} ${d.code}`);
const hooks = await attempt('webhooks.listWebhookEndpoints', () =>
    polar.webhooks.listWebhookEndpoints({ limit: 10 }),
);
if (hooks.ok)
    for (const h of hooks.value.items) console.log(`  webhook ${h.id} events=${h.events.length}`);
