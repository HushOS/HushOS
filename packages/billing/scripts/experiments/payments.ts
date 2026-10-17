import { showPayments } from './card';
import { attempt, polar, show } from './sandbox';

/* Read-only: a checkout's state and its payment attempts, by checkout id (argument). */
const checkoutId = process.argv[2];
if (!checkoutId) throw new Error('Usage: payments.ts <checkout id>');
const checkout = await attempt('checkouts.get', () => polar.checkouts.get(checkoutId));
if (checkout.ok) {
    const raw = checkout.value as unknown as Record<string, unknown>;
    show('checkout', {
        status: raw.status,
        currency: raw.currency,
        total_amount: raw.total_amount,
        expires_at: raw.expires_at,
        customer_id: raw.customer_id,
        payment_processor_metadata_keys: Object.keys(
            (raw.payment_processor_metadata ?? {}) as object,
        ),
    });
}
await showPayments('checkout', { checkout_id: checkoutId });
if (checkout.ok && checkout.value.customer_id)
    await showPayments('customer', { customer_id: checkout.value.customer_id });
