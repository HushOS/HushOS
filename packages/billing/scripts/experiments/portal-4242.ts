import { findCardSubscription } from './card';
import { attempt, polar, show } from './sandbox';

/*
 * A portal session for the customer of the monthly 4242 subscription, so the owner can add
 * 0341 as its default card. Prints the URL, a bearer secret valid for about an hour.
 */
const sub = await findCardSubscription('monthly4242');
const session = await attempt('customerSessions.create monthly4242 customer', () =>
    polar.customerSessions.create({ customer_id: sub.customer_id }),
);
if (session.ok)
    show('monthly4242 portal', {
        subscription: sub.id,
        customer: sub.customer_id,
        url: session.value.customer_portal_url,
        expires_at: session.value.expires_at,
    });
