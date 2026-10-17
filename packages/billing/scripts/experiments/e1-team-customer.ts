import { freeCheckout, subscriptionsOf } from './free';
import { attempt, loadState, polar, saveState, show, unique } from './sandbox';

/*
 * E1: a team customer `group:<uuid>` with no email, owned by X, who already has a personal
 * subscription on an individual customer. Does a Family checkout with `customer_id` land on
 * the team customer, does it stay `team`, and does a member portal session open?
 *
 * Card-free: both checkouts carry the 100%-off `exp-free` discount and are confirmed through
 * the public client endpoint with no Stripe confirmation token.
 */
const state = await loadState();
const personal = state.personalMonthly as string;
const family = state.familyMonthly as string;
if (!personal || !family || typeof state.freeDiscount !== 'string')
    throw new Error('Run e2-product-shape.ts first.');

const n = (state.e1Suffix as string | undefined) ?? unique();
state.e1Suffix = n;
const email = `exp-owner+${n}@thebinary.dev`;
const ownerExternalId = `exp-user-${n}`;
const groupExternalId = `group:${(state.e1GroupId as string | undefined) ?? crypto.randomUUID()}`;
state.e1GroupId = groupExternalId.slice('group:'.length);
await saveState(state);

{
    // 1. X's individual customer and personal subscription.
    if (typeof state.e1Individual !== 'string') {
        const individual = await attempt('customers.create individual', () =>
            polar.customers.create({
                type: 'individual',
                email,
                name: 'exp-owner',
                metadata: { hushos_experiment: 'true' },
            }),
        );
        if (!individual.ok) process.exit(1);
        state.e1Individual = individual.value.id;
        await saveState(state);
    }
    const individualId = state.e1Individual as string;
    if (typeof state.e1PersonalCheckout !== 'string') {
        const checkout = await freeCheckout('personal', {
            products: [personal],
            customer_id: individualId,
        });
        if (checkout) state.e1PersonalCheckout = checkout.id;
        await saveState(state);
    }
    const personalSubs = await subscriptionsOf(individualId);
    show(
        'personal subscriptions',
        personalSubs.map((s) => ({
            id: s.id,
            status: s.status,
            product: s.product_id,
            amount: s.amount,
        })),
    );
    state.e1PersonalSubscription = personalSubs[0]?.id ?? null;

    // 2. The team customer: no email, owner X.
    if (typeof state.e1Team !== 'string') {
        const team = await attempt('customers.create team (no email, owner X)', () =>
            polar.customers.create({
                type: 'team',
                external_id: groupExternalId,
                name: 'exp-family',
                owner: { email, name: 'exp-owner', external_id: ownerExternalId },
                metadata: { hushos_experiment: 'true', hushos_owner_kind: 'group' },
            }),
        );
        if (!team.ok) process.exit(1);
        state.e1Team = team.value.id;
        await saveState(state);
    }
    const teamId = state.e1Team as string;
    const before = await polar.customers.get(teamId);
    show('team customer before checkout', {
        id: before.id,
        type: before.type,
        email: before.email,
    });

    // 3. Family checkout on the team customer, 6 units, free.
    if (typeof state.e1FamilyCheckout !== 'string') {
        const checkout = await freeCheckout('family', {
            products: [family],
            customer_id: teamId,
            currency: 'usd',
            units: 6,
            min_units: 6,
            metadata: { hushos_group_id: state.e1GroupId as string },
        });
        if (checkout) state.e1FamilyCheckout = checkout.id;
        await saveState(state);
    }
    const familySubs = await subscriptionsOf(teamId);
    show(
        'team subscriptions',
        familySubs.map((s) => ({
            id: s.id,
            status: s.status,
            customer_id: s.customer_id,
            product: s.product_id,
            units: s.units,
            amount: s.amount,
            currency: s.currency,
            discount: s.discount_id,
        })),
    );
    state.e1FamilySubscription = familySubs[0]?.id ?? null;
    const personalAfter = await polar.subscriptions.list({ customer_id: individualId, limit: 10 });
    show(
        'individual subscriptions after family checkout',
        personalAfter.items.map((s) => ({ id: s.id, product: s.product_id })),
    );

    // 4. Who owns it, and is the customer still a team?
    const after = await polar.customers.get(teamId);
    show('team customer after checkout', { id: after.id, type: after.type, email: after.email });
    const members = await attempt('customers.members.listExternal', () =>
        polar.customers.members.listExternal(groupExternalId, { limit: 10 }),
    );
    if (members.ok)
        show(
            'members',
            members.value.items.map((m) => ({
                id: m.id,
                role: m.role,
                email: m.email,
                external_id: m.external_id,
            })),
        );

    // 5. A portal session for the owner member. The token and URL are secrets; only their presence is shown.
    const session = await attempt('customerSessions.create external_member_id', () =>
        polar.customerSessions.create({
            external_customer_id: groupExternalId,
            external_member_id: ownerExternalId,
        }),
    );
    if (session.ok)
        show('session', {
            has_token: Boolean(session.value.token),
            portal_host: new URL(session.value.customer_portal_url).host,
            customer_id: session.value.customer_id,
            fields: Object.keys(session.value),
            expires_at: session.value.expires_at,
        });
    const noMember = await attempt('customerSessions.create team without member', () =>
        polar.customerSessions.create({ external_customer_id: groupExternalId }),
    );
    if (noMember.ok) show('session without member', { has_token: Boolean(noMember.value.token) });
    const stranger = await attempt(
        'customerSessions.create with a member id that is not on the team',
        () =>
            polar.customerSessions.create({
                external_customer_id: groupExternalId,
                external_member_id: `exp-nobody-${n}`,
            }),
    );
    if (stranger.ok) show('session for a stranger', { has_token: Boolean(stranger.value.token) });

    // 6. The order: whose email is on it, and is a receipt available.
    const orders = await attempt('orders.list', () =>
        polar.orders.list({ customer_id: teamId, limit: 10 }),
    );
    for (const order of orders.ok ? orders.value.items : []) {
        const raw = order as unknown as Record<string, unknown>;
        show('team order', {
            id: order.id,
            billing_reason: order.billing_reason,
            status: order.status,
            total_amount: order.total_amount,
            customer_email: (raw.customer as Record<string, unknown> | undefined)?.email ?? null,
            billing_name: raw.billing_name,
            items: order.items.map((i) => ({ label: i.label, amount: i.amount })),
        });
        state.e1FamilyOrder = order.id;
        const receipt = await attempt('orders.receipt', () => polar.orders.receipt(order.id));
        if (receipt.ok) show('receipt url host', new URL(receipt.value.url).host);
    }
    await saveState(state);
}
