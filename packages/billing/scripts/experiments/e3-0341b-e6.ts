import { change, lookupCardSubscriptions, once, showOrders, subscriptionSummary } from './card';
import { attempt, loadState, polar, show } from './sandbox';

/*
 * E3 0341: the 0341b subscription (first period free through EXPFIRST, card saved) raised
 * 6→7 with `invoice`, which is the first real charge on 0341. Then clearing a pending cut with
 * `{ pending_update: null }` on the free E3 subscription. Then E6, read-only: the paid team
 * subscription, its customer and the card the next raise would charge.
 */
function cards(customerId: string) {
    return polar.customers.listPaymentMethods(customerId, { limit: 10 }).then((list) =>
        list.items.map((m) => {
            const raw = m as unknown as Record<string, unknown>;
            const meta = (raw.method_metadata ?? {}) as Record<string, unknown>;
            return { id: raw.id, last4: meta.last4, created_at: raw.created_at };
        }),
    );
}
function paymentFields(value: object) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key.includes('payment')));
}

// 1. E3 0341.
const { via, subscriptions } = await lookupCardSubscriptions('monthly0341b');
show('0341b lookup', { via, found: subscriptions.map((s) => ({ id: s.id, status: s.status })) });
const sub = subscriptions.find((s) => s.status === 'active');
if (sub) {
    const customer = await polar.customers.get(sub.customer_id);
    show('0341b state', {
        ...subscriptionSummary(sub),
        discount: sub.discount_id,
        customer_type: customer.type,
        customer_payment_fields: paymentFields(customer),
        subscription_payment_fields: paymentFields(sub),
        cards: await cards(sub.customer_id),
    });
    await showOrders('0341b before', sub.id);
    await once('e3-monthly0341b', async () => {
        const { result } = await change('E3 0341b raise', sub.id, {
            units: sub.units! + 1,
            proration_behavior: 'invoice',
        });
        if (!result.ok) show('E3 0341b error', { status: result.status, error: result.error });
        await Bun.sleep(10_000);
        show(
            'E3 0341b re-read after 15 s',
            subscriptionSummary(await polar.subscriptions.get(sub.id)),
        );
        const state = await polar.customers.getState(sub.customer_id);
        show(
            'E3 0341b customer state (what a sync sees)',
            state.active_subscriptions.map((s) => ({
                id: s.id,
                status: s.status,
                units: (s as unknown as Record<string, unknown>).units,
                amount: s.amount,
            })),
        );
        await showOrders('E3 0341b after 15 s', sub.id);
    });
}

// 2. Clearing a pending cut, on the free E3 subscription (cut to 9 pending since api-2026-10.ts).
const freeId = ((await loadState()).e3 as { subscription: string }).subscription;
const before = await polar.subscriptions.get(freeId);
show('free E3 before clear', { units: before.units, pending_update: before.pending_update });
if (before.pending_update) {
    const cleared = await attempt('subscriptions.update { pending_update: null }', () =>
        polar.subscriptions.update(freeId, { pending_update: null }),
    );
    if (cleared.ok)
        show('clear response', {
            units: cleared.value.units,
            pending_update: cleared.value.pending_update,
        });
    const after = await polar.subscriptions.get(freeId);
    show('free E3 re-read after clear', {
        units: after.units,
        pending_update: after.pending_update,
    });
}

// 3. E6, read-only.
const e6 = (await loadState()).e6 as Record<string, string>;
const checkout = await polar.checkouts.get(e6.checkout!);
show('e6 checkout', {
    status: checkout.status,
    currency: checkout.currency,
    total: checkout.total_amount,
    customer_id: checkout.customer_id,
});
const teamSubs = await polar.subscriptions.list({ customer_id: e6.customer!, limit: 5 });
const team = await polar.customers.get(e6.customer!);
show('e6 team', {
    type: team.type,
    email: team.email,
    external_id: team.external_id,
    payment_fields: paymentFields(team),
    cards: await cards(e6.customer!),
    subscriptions: teamSubs.items.map((s) => ({
        ...subscriptionSummary(s),
        customer_id: s.customer_id,
        owned_by_team: s.customer_id === e6.customer,
        payment_fields: paymentFields(s),
    })),
});
for (const s of teamSubs.items) await showOrders('e6', s.id);
const session = await attempt('customerSessions.create for the payer (owner member)', () =>
    polar.customerSessions.create({
        external_customer_id: e6.group!,
        external_member_id: e6.payer!,
    }),
);
if (session.ok)
    show('payer session', {
        works: Boolean(session.value.token),
        expires_at: session.value.expires_at,
    });
