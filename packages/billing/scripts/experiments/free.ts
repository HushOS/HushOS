import { attempt, loadState, polar, saveState, show, unique } from './sandbox';

/*
 * Card-free subscriptions: a checkout carrying the 100%-off `exp-free` discount, confirmed
 * through the public client endpoint with no Stripe confirmation token.
 */
export async function freeCheckout(
    label: string,
    body: Parameters<typeof polar.checkouts.create>[0],
) {
    const state = await loadState();
    const free = state.freeDiscount;
    if (typeof free !== 'string') throw new Error('Run e2-product-shape.ts first.');
    const created = await attempt(`${label}: checkouts.create`, () =>
        polar.checkouts.create({ ...body, discount_id: free }),
    );
    if (!created.ok) return null;
    show(`${label}: quote`, {
        id: created.value.id,
        amount: created.value.amount,
        discount_amount: created.value.discount_amount,
        total_amount: created.value.total_amount,
        is_payment_required: created.value.is_payment_required,
        is_payment_setup_required: created.value.is_payment_setup_required,
        is_payment_form_required: created.value.is_payment_form_required,
        units: created.value.units,
    });
    const confirmed = await attempt(
        `${label}: checkouts.clientConfirm (no confirmation token)`,
        () =>
            polar.checkouts.clientConfirm(created.value.client_secret, {
                customer_billing_address: { country: 'IE' },
            }),
    );
    if (!confirmed.ok) return created.value;
    // The order and subscription are made asynchronously once the checkout succeeds.
    for (let i = 0; i < 20; i++) {
        const checkout = await polar.checkouts.get(created.value.id);
        if (checkout.status === 'succeeded' || checkout.status === 'failed') {
            show(`${label}: final`, { status: checkout.status, customer_id: checkout.customer_id });
            return checkout;
        }
        await Bun.sleep(1500);
    }
    return polar.checkouts.get(created.value.id);
}

export async function subscriptionsOf(customerId: string) {
    for (let i = 0; i < 20; i++) {
        const list = await polar.subscriptions.list({ customer_id: customerId, limit: 10 });
        if (list.items.length > 0) return list.items;
        await Bun.sleep(1500);
    }
    return [];
}

/*
 * A team customer `group:<uuid>` owned by a fresh `exp-` address, with a free subscription to
 * the given product at `units`. Cached in state under `key`, so reruns reuse it.
 */
export async function freeGroupSubscription(key: string, productId: string, units: number) {
    const state = await loadState();
    const cached = state[key] as
        | { customer: string; subscription: string; checkout: string }
        | undefined;
    if (cached?.subscription) return polar.subscriptions.get(cached.subscription);
    const n = unique();
    const team = await attempt(`${key}: customers.create team`, () =>
        polar.customers.create({
            type: 'team',
            external_id: `group:${crypto.randomUUID()}`,
            name: `exp-${key}`,
            owner: {
                email: `exp-owner+${n}@thebinary.dev`,
                name: 'exp-owner',
                external_id: `exp-user-${n}`,
            },
            metadata: { hushos_experiment: 'true', hushos_owner_kind: 'group' },
        }),
    );
    if (!team.ok) throw new Error(`${key}: could not create the team customer`);
    const record = { customer: team.value.id, subscription: '', checkout: '' };
    state[key] = record;
    await saveState(state);
    const checkout = await freeCheckout(key, {
        products: [productId],
        customer_id: team.value.id,
        currency: 'usd',
        units,
    });
    record.checkout = checkout?.id ?? '';
    const [subscription] = await subscriptionsOf(team.value.id);
    if (!subscription) throw new Error(`${key}: no subscription appeared`);
    record.subscription = subscription.id;
    state[key] = record;
    await saveState(state);
    return subscription;
}
