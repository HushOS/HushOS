import { change, findCardSubscription, once, showSystemEvents, showWebhookTrail } from './card';
import { show } from './sandbox';

/*
 * E3 with cards. Run only after the owner reports the 0341, 3184 and monthly 4242 links paid.
 *
 * - 0341 (attaches, then declines): raise 6→7 with `invoice`. Expect 402 `PaymentFailed`;
 *   the record shows whether `units` moved anyway, which fails the `invoice` design.
 * - 3184 (always authenticates): raise 6→7 with `invoice`. Expect 402
 *   `PaymentActionRequired`; the record shows the pending order and whether `units` moved.
 * - 4242: raise 6→7 with `invoice`, cut to 6 with `next_period`, raise to 8 with `invoice`.
 *   Expect a proration order for each raise, `pending_update.units: 6` after the cut, and the
 *   second raise deleting it.
 * - The webhook order for each, if the organisation has a webhook endpoint by then (it had
 *   none on 2026-10-17); Polar's system events need `events:read`.
 *
 * Each case runs once; pass --force to repeat one.
 */
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length);

for (const key of ['monthly0341', 'monthly3184'] as const) {
    if (only && only !== key) continue;
    await once(`e3-${key}`, async () => {
        const since = new Date().toISOString();
        const sub = await findCardSubscription(key);
        const { result } = await change(`E3 ${key} raise`, sub.id, {
            units: sub.units! + 1,
            proration_behavior: 'invoice',
        });
        if (!result.ok)
            show(`E3 ${key} error body`, { status: result.status, error: result.error });
        await showWebhookTrail(`E3 ${key}`, [sub.id, sub.customer_id], since);
        await showSystemEvents(`E3 ${key}`, sub.customer_id);
    });
}

if (!only || only === 'monthly4242')
    await once('e3-monthly4242', async () => {
        const since = new Date().toISOString();
        const sub = await findCardSubscription('monthly4242');
        const start = sub.units!;
        await change('E3 4242 step 1 raise (invoice)', sub.id, {
            units: start + 1,
            proration_behavior: 'invoice',
        });
        await change('E3 4242 step 2 cut (next_period)', sub.id, {
            units: start,
            proration_behavior: 'next_period',
        });
        await change('E3 4242 step 3 raise (invoice)', sub.id, {
            units: start + 2,
            proration_behavior: 'invoice',
        });
        await showWebhookTrail('E3 4242', [sub.id, sub.customer_id], since);
        await showSystemEvents('E3 4242', sub.customer_id);
    });
