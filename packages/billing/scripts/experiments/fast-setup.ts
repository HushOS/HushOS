import { attempt, loadState, polar, saveState, show, unique } from './sandbox';

/*
 * Setup for the E3 0341 case and E6 handover:
 * 1. EXPFIRST (100% off, once) and a Family monthly link with it preset, for card 0341.
 * 2. A team customer with an owner and a second member, a checkout on that team (no discount,
 *    for 4242), and a portal session for the second member.
 */
const state = await loadState();
const monthly = state.familyMonthly as string;

if (typeof state.firstDiscount !== 'string') {
    const d = await attempt('discounts.create EXPFIRST', () =>
        polar.discounts.create({
            name: 'exp-first',
            code: 'EXPFIRST',
            type: 'percentage',
            basis_points: 10_000,
            duration: 'once',
            products: [monthly],
            metadata: { hushos_experiment: 'true' },
        }),
    );
    if (d.ok) state.firstDiscount = d.value.id;
    await saveState(state);
}
const links = (state.links as Record<string, unknown>) ?? {};
if (!links.monthly0341b && typeof state.firstDiscount === 'string') {
    const link = await attempt('checkoutLinks.create 0341b', () =>
        polar.checkoutLinks.create({
            payment_processor: 'stripe',
            product_id: monthly,
            units: 6,
            label: 'exp-family-monthly-card-0341b',
            discount_id: state.firstDiscount as string,
            allow_discount_codes: false,
            metadata: {
                hushos_experiment: 'true',
                hushos_card: '0341b',
                hushos_link: 'monthly0341b',
            },
        }),
    );
    if (link.ok) {
        const email = `exp-card0341b+${unique()}@thebinary.dev`;
        links.monthly0341b = {
            id: link.value.id,
            card: '4000000000000341',
            email,
            url: `${link.value.url}?customer_email=${encodeURIComponent(email)}`,
        };
        state.links = links;
        await saveState(state);
    }
}

const e6 = (state.e6 as Record<string, string> | undefined) ?? {};
if (!e6.customer) {
    const n = unique();
    const groupId = crypto.randomUUID();
    const team = await attempt('customers.create e6 team', () =>
        polar.customers.create({
            type: 'team',
            external_id: `group:${groupId}`,
            name: 'exp-e6',
            owner: {
                email: `exp-payer+${n}@thebinary.dev`,
                name: 'exp-payer',
                external_id: `exp-payer-${n}`,
            },
            metadata: { hushos_experiment: 'true', hushos_owner_kind: 'group' },
        }),
    );
    if (!team.ok) process.exit(1);
    Object.assign(e6, {
        customer: team.value.id,
        group: `group:${groupId}`,
        payer: `exp-payer-${n}`,
        newPayer: `exp-newpayer-${n}`,
        newPayerEmail: `exp-newpayer+${n}@thebinary.dev`,
    });
    state.e6 = e6;
    await saveState(state);
}
if (!e6.memberCreated) {
    const member = await attempt('customers.members.createExternal billing_manager', () =>
        polar.customers.members.createExternal(e6.group!, {
            email: e6.newPayerEmail!,
            name: 'exp-newpayer',
            external_id: e6.newPayer!,
            role: 'billing_manager',
        }),
    );
    if (member.ok) {
        e6.memberCreated = 'billing_manager';
        e6.memberId = member.value.id;
        show('member', { id: member.value.id, role: member.value.role });
    }
    await saveState(state);
}
if (!e6.checkout) {
    const checkout = await attempt('checkouts.create e6 (no discount)', () =>
        polar.checkouts.create({
            products: [monthly],
            customer_id: e6.customer!,
            units: 6,
            allow_discount_codes: false,
            metadata: { hushos_experiment: 'true', hushos_link: 'e6' },
        }),
    );
    if (checkout.ok) {
        e6.checkout = checkout.value.id;
        e6.checkoutUrl = checkout.value.url;
        e6.checkoutExpires = checkout.value.expires_at;
    }
    await saveState(state);
}
show('0341b link', (links.monthly0341b as { url: string } | undefined)?.url ?? null);
show('e6 checkout', {
    url: e6.checkoutUrl ?? null,
    expires: e6.checkoutExpires ?? null,
    currency_note: 'by IP',
});
