import { change, findCardSubscription, once } from './card';
import { show } from './sandbox';

/*
 * E4 part 1 with a card. Run about a day after the owner pays the yearly 4242 link: add one
 * member with `invoice` and compare the charge with the yearly per-member price scaled by the
 * time left in the period (Polar prorates per second).
 */
await once('e4-yearly4242', async () => {
    const sub = await findCardSubscription('yearly4242');
    const unitPrice = sub.prices
        .map((p) => p as unknown as Record<string, unknown>)
        .find((p) => p.amount_type === 'unit_based' && p.price_currency === sub.currency);
    const tiers = (
        (unitPrice?.tiers as { tiers: { bound: number | null; unit_amount: string }[] }) ?? {
            tiers: [],
        }
    ).tiers;
    const perMember = Number(tiers.find((t) => t.bound === null)?.unit_amount ?? NaN);
    const start = Date.parse(sub.current_period_start);
    const end = Date.parse(sub.current_period_end!);
    const now = Date.now();
    const fraction = (end - now) / (end - start);
    show('E4 expectation', {
        currency: sub.currency,
        per_member_per_year: perMember,
        days_into_period: ((now - start) / 86_400_000).toFixed(2),
        fraction_left: fraction.toFixed(5),
        expected_net_charge: Math.round(perMember * fraction),
    });
    await change('E4 yearly add a member', sub.id, {
        units: sub.units! + 1,
        proration_behavior: 'invoice',
    });
    console.log('Compare the subscription_update order net with expected_net_charge above.');
});
