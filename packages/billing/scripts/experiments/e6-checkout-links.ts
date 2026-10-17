import { CARD_LINKS, type LinkRecord } from './card';
import { attempt, loadState, polar, saveState, show } from './sandbox';

/*
 * Long-lived checkout links for the owner to pay with Stripe test cards (E3, E4 part 1, E8).
 * Nothing here opens them.
 *
 * A link carries no currency and no customer:
 * - Polar picks the currency from the visitor's IP country (falling back to USD), and the
 *   redirect takes no `currency` parameter. An INR-only product is refused (the default
 *   currency must be present), so from an Indian IP every link here checks out in INR.
 * - The customer is made from the email typed at checkout, so each link pre-fills a distinct
 *   `exp-` email through the redirect's `customer_email` query parameter.
 *
 * Each link's label and metadata name its card (`hushos_card`) and key (`hushos_link`); the
 * card scripts find the resulting subscription by that metadata, or by the pre-filled email.
 * Discount codes are off, so EXPFREE cannot be used on them.
 */
const state = await loadState();
const products: Record<'monthly' | 'yearly', string> = {
    monthly: state.familyMonthly as string,
    yearly: state.familyYearly as string,
};

const links = (state.links as Record<string, LinkRecord> | undefined) ?? {};
for (const item of CARD_LINKS) {
    if (links[item.key]) continue;
    const link = await attempt(`checkoutLinks.create ${item.label}`, () =>
        polar.checkoutLinks.create({
            payment_processor: 'stripe',
            product_id: products[item.product],
            units: 6,
            label: item.label,
            allow_discount_codes: false,
            metadata: { hushos_experiment: 'true', hushos_card: item.card, hushos_link: item.key },
        }),
    );
    if (!link.ok) continue;
    const email = `${item.emailPrefix}+${Date.now().toString(36)}@thebinary.dev`;
    links[item.key] = {
        id: link.value.id,
        card: item.card,
        email,
        url: `${link.value.url}?customer_email=${encodeURIComponent(email)}`,
    };
    state.links = links;
    await saveState(state);
}
show('links', links);
