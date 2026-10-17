import { change, findCardSubscription, once } from './card';
import { polar, show } from './sandbox';

/*
 * E8 with the Indian test card (4000 0035 6000 0008). Run after the owner pays the India link.
 * RBI e-mandates let a merchant charge off-session without the cardholder up to ₹15,000;
 * above that, authentication is required, which Polar reports as 402 PaymentActionRequired.
 *
 * Step 1 raises by one member, far below the threshold. Step 2 raises enough members that the
 * proration order's net alone (before 18% GST) exceeds ₹15,000 by 10%. With the placeholder
 * ₹2 per member a month, that is thousands of units; E7 showed Polar has no cap.
 *
 * The threshold is in INR. If the link checked out in another currency, pass
 * --threshold=<minor units in that currency> (₹15,000 converted), or the script stops.
 */
const RBI_THRESHOLD_PAISE = 1_500_000;

await once('e8-india', async () => {
    const sub = await findCardSubscription('monthlyIndia');
    const arg = process.argv.find((a) => a.startsWith('--threshold='));
    const threshold =
        sub.currency === 'inr' ? RBI_THRESHOLD_PAISE : arg ? Number(arg.split('=')[1]) : NaN;
    if (!Number.isFinite(threshold)) {
        console.error(
            `The India subscription is in ${sub.currency}, not INR; pass --threshold=<minor units>.`,
        );
        process.exit(1);
    }
    const unitPrice = sub.prices
        .map((p) => p as unknown as Record<string, unknown>)
        .find((p) => p.amount_type === 'unit_based' && p.price_currency === sub.currency);
    const tiers = (
        (unitPrice?.tiers as { tiers: { bound: number | null; unit_amount: string }[] }) ?? {
            tiers: [],
        }
    ).tiers;
    const perMember = Number(tiers.find((t) => t.bound === null)?.unit_amount ?? NaN);

    await change('E8 step 1 below threshold (+1 member, invoice)', sub.id, {
        units: sub.units! + 1,
        proration_behavior: 'invoice',
    });

    const now = await polar.subscriptions.get(sub.id);
    const start = Date.parse(now.current_period_start);
    const end = Date.parse(now.current_period_end!);
    const fraction = (end - Date.now()) / (end - start);
    const extra = Math.ceil((threshold * 1.1) / (perMember * fraction));
    show('E8 step 2 plan', {
        currency: now.currency,
        threshold,
        per_member: perMember,
        fraction_left: fraction.toFixed(5),
        extra_members: extra,
        expected_net: Math.round(extra * perMember * fraction),
    });
    await change('E8 step 2 above threshold (invoice)', sub.id, {
        units: now.units! + extra,
        proration_behavior: 'invoice',
    });
    console.log(
        'After a 402, ask the owner what the portal asks for; the pending order is listed above.',
    );
});
