import { CARD_LINKS, lookupCardSubscriptions } from './card';
import { attempt, polar, show } from './sandbox';

/*
 * Read-only: for each paid link, the subscription it produced, how it was found, its status,
 * currency and units, and the last four digits of the customer's cards.
 */
for (const item of CARD_LINKS) {
    const { via, subscriptions } = await lookupCardSubscriptions(item.key);
    if (subscriptions.length === 0) {
        console.log(`${item.key}: NO SUBSCRIPTION FOUND`);
        continue;
    }
    for (const s of subscriptions) {
        const methods = await attempt(`${item.key}: customers.listPaymentMethods`, () =>
            polar.customers.listPaymentMethods(s.customer_id, { limit: 10 }),
        );
        const customer = await polar.customers.get(s.customer_id);
        show(item.key, {
            found_via: via,
            subscription: s.id,
            customer: s.customer_id,
            customer_type: customer.type,
            status: s.status,
            currency: s.currency,
            units: s.units,
            amount: s.amount,
            interval: s.recurring_interval,
            current_period_start: s.current_period_start,
            current_period_end: s.current_period_end,
            metadata: s.metadata,
            default_payment_method_id:
                (customer as unknown as Record<string, unknown>).default_payment_method_id ?? null,
            cards: methods.ok
                ? methods.value.items.map((m) => {
                      const raw = m as unknown as Record<string, unknown>;
                      const meta = (raw.method_metadata ?? {}) as Record<string, unknown>;
                      return { id: raw.id, type: raw.type, brand: meta.brand, last4: meta.last4 };
                  })
                : null,
        });
    }
}
