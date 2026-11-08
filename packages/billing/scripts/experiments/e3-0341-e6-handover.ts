import { createPolar } from '@polar-sh/sdk/2026-04';
import { change, findCardSubscription, once, showWebhookTrail, subscriptionSummary } from './card';
import { attempt, loadState, polar, SANDBOX_URL, show } from './sandbox';

/*
 * After the owner set default cards in the portal:
 * 1. E3 0341: the monthly 4242 subscription now defaults to 0341; raise by one with `invoice`.
 * 2. E6: the team subscription's new payer (billing_manager) added 4242 and made it default;
 *    raise by one with `invoice`, see which card paid, then delete the old payer's card as the
 *    new payer through the customer portal API.
 * Portal calls use a customer session token held in memory only, never printed.
 */
async function portalAs(
    body: Parameters<typeof polar.customerSessions.create>[0],
): Promise<ReturnType<typeof createPolar> | null> {
    const session = await attempt('customerSessions.create', () =>
        polar.customerSessions.create(body),
    );
    if (!session.ok) return null;
    return createPolar({
        accessToken: session.value.token,
        environment: 'sandbox',
        baseUrl: SANDBOX_URL,
    });
}

async function portalCards(label: string, portal: ReturnType<typeof createPolar>) {
    const list = await attempt(`${label}: portal listPaymentMethods`, () =>
        portal.customerPortal.customers.listPaymentMethods({ limit: 10 }),
    );
    // The list's `is_default` is declared but not returned; the customer's
    // `default_payment_method_id` is the source of truth.
    const me = await portal.customerPortal.customers.get();
    const defaultId = (me as unknown as Record<string, unknown>).default_payment_method_id;
    const cards = list.ok
        ? list.value.items.map((m) => {
              const raw = m as unknown as Record<string, unknown>;
              const meta = (raw.method_metadata ?? {}) as Record<string, unknown>;
              return {
                  id: raw.id as string,
                  last4: meta.last4 as string,
                  default: raw.id === defaultId,
                  created_at: raw.created_at,
              };
          })
        : [];
    show(`${label}: cards`, cards);
    return cards;
}

/* The card an order was paid with, from the portal's order view if it exposes one. */
async function orderPaymentFields(
    label: string,
    portal: ReturnType<typeof createPolar>,
    subscriptionId: string,
) {
    const orders = await attempt(`${label}: portal orders.list`, () =>
        portal.customerPortal.orders.list({ subscription_id: subscriptionId, limit: 20 }),
    );
    if (!orders.ok) return;
    show(
        `${label}: portal orders (payment fields)`,
        orders.value.items.map((o) => {
            const raw = o as unknown as Record<string, unknown>;
            return {
                id: raw.id,
                billing_reason: raw.billing_reason,
                status: raw.status,
                total: raw.total_amount,
                ...Object.fromEntries(Object.entries(raw).filter(([k]) => k.includes('payment'))),
            };
        }),
    );
}

// 1. E3 0341 on the monthly 4242 subscription; raises only once the default card is 0341.
{
    const sub = await findCardSubscription('monthly4242');
    if (sub.id !== '90197bd1-98cd-4408-a273-15d4552a1096')
        throw new Error(`unexpected subscription ${sub.id}`);
    const portal = await portalAs({ customer_id: sub.customer_id });
    const cards = portal ? await portalCards('0341 customer', portal) : [];
    const def = cards.find((c) => c.default === true);
    if (!portal || def?.last4 !== '0341')
        console.log(`E3 0341: default card is ${def?.last4 ?? 'none'}, not 0341; not raising.`);
    else
        await once('e3-monthly4242-with-0341', async () => {
            const since = new Date().toISOString();
            const { result } = await change('E3 0341 raise', sub.id, {
                units: sub.units! + 1,
                proration_behavior: 'invoice',
            });
            if (!result.ok) show('E3 0341 error', { status: result.status, error: result.error });
            await Bun.sleep(10_000);
            show(
                'E3 0341 re-read after 15 s',
                subscriptionSummary(await polar.subscriptions.get(sub.id)),
            );
            await orderPaymentFields('0341 customer', portal, sub.id);
            await showWebhookTrail('E3 0341', [sub.id, sub.customer_id], since);
        });
}

// 2. E6 handover.
const e6 = (await loadState()).e6 as Record<string, string>;
const [e6Sub] = (await polar.subscriptions.list({ customer_id: e6.customer!, limit: 5 })).items;
if (!e6Sub) throw new Error('no e6 subscription');
const e6Portal = await portalAs({
    external_customer_id: e6.group!,
    external_member_id: e6.newPayer!,
});
const e6Cards = e6Portal ? await portalCards('e6 (as new payer)', e6Portal) : [];
const e6Default = e6Cards.find((c) => c.default === true);
// The old payer's card is the one the checkout saved; the new payer's card must be the default.
const e6OldCard = [...e6Cards].sort((a, b) =>
    String(a.created_at).localeCompare(String(b.created_at)),
)[0];
show('e6 default card', e6Default ?? null);
if (!e6Portal || !e6Default || !e6OldCard || e6Cards.length < 2 || e6Default.id === e6OldCard.id)
    console.log("E6: the new payer's card is not on file as the default; not raising.");
else
    await once('e6-handover-raise', async () => {
        const sub = e6Sub;
        const portal = e6Portal;
        const cards = e6Cards;
        const { result } = await change('E6 raise after handover', sub.id, {
            units: sub.units! + 1,
            proration_behavior: 'invoice',
        });
        if (!result.ok) show('E6 raise error', { status: result.status, error: result.error });
        await orderPaymentFields('e6 (as new payer)', portal, sub.id);
        const oldCard = e6OldCard!;
        if (cards.find((c) => c.id === oldCard.id)?.default)
            throw new Error('old card is the default');
        const removed = await attempt(
            `e6: portal deletePaymentMethod old card ${oldCard.last4} (${oldCard.id})`,
            () => portal.customerPortal.customers.deletePaymentMethod(oldCard.id),
        );
        if (!removed.ok) show('e6 delete error', { status: removed.status, error: removed.error });
        await portalCards('e6 after delete', portal);
    });
