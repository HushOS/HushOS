import { createPolar } from '@polar-sh/sdk/2026-04';
import { change, once, subscriptionSummary } from './card';
import { attempt, loadState, polar, SANDBOX_URL, show } from './sandbox';

/*
 * T2: what does a mid-period, same-interval tier change with `invoice` charge? On a card-paid
 * subscription: exp-Family → Family Pro with next_period (then cleared), exp-Family → Family Pro
 * with invoice, then Pro → Max with invoice. If the charge declines (the customer's default is
 * 0341), the same runs on the E6 team subscription (`--target=e6`).
 */
const FAMILY_PRO_MONTHLY = 'f43e960e-600a-45c1-b714-79fe45b81014';
const FAMILY_MAX_MONTHLY = '2e97ab39-861a-404f-9213-d4ce15d0ec78';
const target = process.argv.includes('--target=e6') ? 'e6' : '4242';
const state = await loadState();
const e6 = state.e6 as Record<string, string>;
const subscriptionId =
    target === 'e6'
        ? (await polar.subscriptions.list({ customer_id: e6.customer!, limit: 5 })).items[0]!.id
        : '90197bd1-98cd-4408-a273-15d4552a1096';

const sub = await polar.subscriptions.get(subscriptionId);
const session = await polar.customerSessions.create(
    target === 'e6'
        ? { external_customer_id: e6.group!, external_member_id: e6.payer! }
        : { customer_id: sub.customer_id },
);
const portal = createPolar({
    accessToken: session.token,
    environment: 'sandbox',
    baseUrl: SANDBOX_URL,
});
const me = (await portal.customerPortal.customers.get()) as unknown as Record<string, unknown>;
const cards = await portal.customerPortal.customers.listPaymentMethods({ limit: 10 });
show(`T2 ${target} start`, {
    ...subscriptionSummary(sub),
    product: sub.product.name,
    default_payment_method_id: me.default_payment_method_id,
    cards: cards.items.map((m) => {
        const raw = m as unknown as Record<string, unknown>;
        return { id: raw.id, last4: (raw.method_metadata as Record<string, unknown>).last4 };
    }),
});
const payments = await attempt('payments.list (which card paid)', () =>
    polar.payments.list({ customer_id: sub.customer_id, limit: 50 }),
);
if (payments.ok)
    show(
        'payments',
        payments.value.items.map((p) => {
            const raw = p as unknown as Record<string, unknown>;
            return {
                created_at: raw.created_at,
                status: raw.status,
                amount: raw.amount,
                order_id: raw.order_id,
                last4: (raw.method_metadata as Record<string, unknown> | undefined)?.last4,
                decline_reason: raw.decline_reason,
            };
        }),
    );

await once(`t2-${target}`, async () => {
    if (sub.product_id !== FAMILY_PRO_MONTHLY && sub.product_id !== FAMILY_MAX_MONTHLY) {
        await change(`T2 ${target} to Pro, next_period`, sub.id, {
            product_id: FAMILY_PRO_MONTHLY,
            proration_behavior: 'next_period',
        });
        await change(`T2 ${target} clear the pending change`, sub.id, { pending_update: null });
        const { result } = await change(`T2 ${target} to Pro, invoice`, sub.id, {
            product_id: FAMILY_PRO_MONTHLY,
            proration_behavior: 'invoice',
        });
        if (!result.ok) {
            show(`T2 ${target} to Pro error`, { status: result.status, error: result.error });
            return;
        }
    }
    const { result } = await change(`T2 ${target} Pro to Max, invoice`, sub.id, {
        product_id: FAMILY_MAX_MONTHLY,
        proration_behavior: 'invoice',
    });
    if (!result.ok)
        show(`T2 ${target} to Max error`, { status: result.status, error: result.error });
    show(`T2 ${target} end`, subscriptionSummary(await polar.subscriptions.get(sub.id)));
});
