import type { models } from '@polar-sh/sdk/2026-04';
import { attempt, loadState, polar, show } from './sandbox';

/*
 * Shared by the checkout-link script and the card scripts that run after the owner pays:
 * which link is for which card, how to find the subscription a link produced, and how to
 * read a subscription's orders and webhook trail.
 */
export type LinkKey = 'monthly0341' | 'monthly3184' | 'monthly4242' | 'yearly4242' | 'monthlyIndia';
export type LinkRecord = { id: string; card: string; email: string; url: string };

export const CARD_LINKS: {
    key: LinkKey;
    card: string;
    label: string;
    product: 'monthly' | 'yearly';
    emailPrefix: string;
}[] = [
    {
        key: 'monthly0341',
        card: '4000000000000341',
        label: 'exp-family-monthly-card-0341',
        product: 'monthly',
        emailPrefix: 'exp-card0341',
    },
    {
        key: 'monthly3184',
        card: '4000002760003184',
        label: 'exp-family-monthly-card-3184',
        product: 'monthly',
        emailPrefix: 'exp-card3184',
    },
    {
        key: 'monthly4242',
        card: '4242424242424242',
        label: 'exp-family-monthly-card-4242',
        product: 'monthly',
        emailPrefix: 'exp-card4242',
    },
    {
        key: 'yearly4242',
        card: '4242424242424242',
        label: 'exp-family-yearly-card-4242',
        product: 'yearly',
        emailPrefix: 'exp-yearly4242',
    },
    {
        key: 'monthlyIndia',
        card: '4000003560000008',
        label: 'exp-family-monthly-card-india-0008',
        product: 'monthly',
        emailPrefix: 'exp-cardindia',
    },
];

/*
 * Every subscription a paid link produced, in any status: first by the link metadata copied
 * onto the subscription, then by the customer whose email the link pre-filled.
 */
export async function lookupCardSubscriptions(
    key: LinkKey,
): Promise<{ via: 'metadata' | 'email' | 'none'; subscriptions: models.Subscription[] }> {
    const state = await loadState();
    const link = (state.links as Record<string, LinkRecord> | undefined)?.[key];
    if (!link) throw new Error(`No link ${key} in state.json; run e6-checkout-links.ts first.`);
    const productKey = CARD_LINKS.find((item) => item.key === key)!.product;
    const productId = (
        productKey === 'monthly' ? state.familyMonthly : state.familyYearly
    ) as string;
    const byMetadata: models.Subscription[] = [];
    for await (const subscription of polar.subscriptions.iterList({
        product_id: productId,
        limit: 100,
    }))
        if ((subscription.metadata as Record<string, unknown>).hushos_link === key)
            byMetadata.push(subscription);
    if (byMetadata.length > 0) return { via: 'metadata', subscriptions: byMetadata };
    const byEmail: models.Subscription[] = [];
    const customers = await polar.customers.list({ email: link.email, limit: 5 });
    for (const customer of customers.items) {
        const subs = await polar.subscriptions.list({
            customer_id: customer.id,
            product_id: productId,
            limit: 5,
        });
        byEmail.push(...subs.items);
    }
    return { via: byEmail.length > 0 ? 'email' : 'none', subscriptions: byEmail };
}

/* The one active subscription a paid link produced; exits if there is not exactly one. */
export async function findCardSubscription(key: LinkKey): Promise<models.Subscription> {
    const { subscriptions } = await lookupCardSubscriptions(key);
    const active = subscriptions.filter((s) => s.status === 'active');
    if (active.length !== 1) {
        console.error(
            `Expected one active subscription from link ${key}, found ${active.length}. ` +
                'Has the owner paid it, with the pre-filled email?',
        );
        process.exit(1);
    }
    return active[0]!;
}

export function subscriptionSummary(s: models.Subscription) {
    return {
        id: s.id,
        status: s.status,
        units: s.units,
        amount: s.amount,
        currency: s.currency,
        interval: s.recurring_interval,
        current_period_start: s.current_period_start,
        current_period_end: s.current_period_end,
        pending_update: s.pending_update,
        cancel_at_period_end: s.cancel_at_period_end,
    };
}

export async function showOrders(label: string, subscriptionId: string) {
    const orders = await attempt(`${label}: orders.list`, () =>
        polar.orders.list({ subscription_id: subscriptionId, limit: 50, sorting: ['created_at'] }),
    );
    if (!orders.ok) return [];
    show(
        `${label}: orders`,
        orders.value.items.map((o) => ({
            id: o.id,
            created_at: o.created_at,
            billing_reason: o.billing_reason,
            status: o.status,
            paid: o.paid,
            units: o.units,
            currency: o.currency,
            subtotal: o.subtotal_amount,
            discount: o.discount_amount,
            net: o.net_amount,
            tax: o.tax_amount,
            total: o.total_amount,
            applied_balance: o.applied_balance_amount,
            due: o.due_amount,
            next_payment_attempt_at: o.next_payment_attempt_at ?? null,
            items: o.items.map((i) => ({
                label: i.label,
                amount: i.amount,
                tax: i.tax_amount,
                proration: i.proration,
            })),
        })),
    );
    return orders.value.items;
}

/*
 * Webhook events since `since` whose payload mentions the subscription or its customer, in
 * the order Polar created them. Payloads are not printed (they carry customer emails).
 */
export async function showWebhookTrail(label: string, ids: string[], since: string) {
    const deliveries = await attempt(`${label}: webhooks.listWebhookDeliveries`, () =>
        polar.webhooks.listWebhookDeliveries({ start_timestamp: since, limit: 100 }),
    );
    if (!deliveries.ok) return;
    const events = new Map<string, { type: string; created_at: string; http: number | null }>();
    for (const delivery of deliveries.value.items) {
        const event = delivery.webhook_event;
        if (!event.payload || !ids.some((id) => event.payload!.includes(id))) continue;
        events.set(event.id, {
            type: event.type,
            created_at: event.created_at,
            http: delivery.http_code,
        });
    }
    show(
        `${label}: webhook events (by creation time)`,
        [...events.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    );
}

/*
 * Polar's own system events for a customer (the Events API), oldest first. These exist even
 * when the organisation has no webhook endpoint, and carry `subscription.units_updated`.
 */
export async function showSystemEvents(label: string, customerId: string) {
    const events = await attempt(`${label}: events.list`, () =>
        polar.events.list({
            customer_id: customerId,
            source: 'system',
            limit: 100,
            sorting: ['timestamp'],
        }),
    );
    if (!events.ok) return;
    show(
        `${label}: system events`,
        events.value.items.map((e) => {
            const raw = e as unknown as Record<string, unknown>;
            const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
            return {
                name: raw.name,
                timestamp: raw.timestamp,
                old_units: metadata.old_units,
                new_units: metadata.new_units,
                proration_behavior: metadata.proration_behavior,
                amount: metadata.amount,
            };
        }),
    );
}

/*
 * One quantity change on a paid subscription, recorded in full: the call's result or error
 * (402 bodies included), the subscription re-read a few seconds later, and its orders.
 */
export async function change(
    label: string,
    subscriptionId: string,
    body: models.SubscriptionUpdate,
) {
    const before = await polar.subscriptions.get(subscriptionId);
    show(`${label}: before`, subscriptionSummary(before));
    const result = await attempt(`${label}: subscriptions.update ${JSON.stringify(body)}`, () =>
        polar.subscriptions.update(subscriptionId, body),
    );
    if (result.ok) show(`${label}: response`, subscriptionSummary(result.value));
    await Bun.sleep(5000);
    const after = await polar.subscriptions.get(subscriptionId);
    show(`${label}: re-read after 5 s`, subscriptionSummary(after));
    if (!result.ok && after.units !== before.units)
        console.log(
            `${label}: UNITS CHANGED DESPITE THE ERROR (${before.units} -> ${after.units})`,
        );
    await showOrders(label, subscriptionId);
    return { result, before, after };
}

/* Refuses to repeat a money-moving run unless --force is passed; marks the run done in state. */
export async function once(key: string, run: () => Promise<void>) {
    const { loadState: load, saveState: save } = await import('./sandbox');
    const state = await load();
    const runs = (state.cardRuns as Record<string, string> | undefined) ?? {};
    if (runs[key] && !process.argv.includes('--force')) {
        console.log(`${key} already ran at ${runs[key]}; pass --force to run it again.`);
        return;
    }
    await run();
    runs[key] = new Date().toISOString();
    state.cardRuns = runs;
    await save(state);
}

/* Payment attempts (successful or declined) for a customer or checkout, oldest first. */
export async function showPayments(
    label: string,
    query: { customer_id?: string; checkout_id?: string },
) {
    const payments = await attempt(`${label}: payments.list`, () =>
        polar.payments.list({ ...query, limit: 50, sorting: ['created_at'] }),
    );
    if (!payments.ok) return;
    show(
        `${label}: payments`,
        payments.value.items.map((p) => {
            const raw = p as unknown as Record<string, unknown>;
            const card = (raw.method_metadata ?? {}) as Record<string, unknown>;
            return {
                created_at: raw.created_at,
                status: raw.status,
                amount: raw.amount,
                currency: raw.currency,
                trigger: raw.trigger,
                decline_reason: raw.decline_reason,
                decline_message: raw.decline_message,
                last4: card.last4,
                checkout_id: raw.checkout_id,
                order_id: raw.order_id,
            };
        }),
    );
}
