import type { DiscountTerms, OfferLanding, ReferralLanding } from '@hushos/billing/api';
import { getOfferLanding, getReferralLanding } from '@hushos/billing/growth';
import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { formatMoney } from '@/lib/format';
import { growthApi } from '@/lib/growth-api';

/*
 * Referrals and affiliates in the web app: the signed-in person's invite page
 * and the operator's affiliate list through the API; the two public landing
 * pages through server functions, since they render before the browser can ask.
 */

export const referralsQueryOptions = queryOptions({
    queryKey: ['growth', 'referrals'],
    queryFn: () => growthApi.referrals(),
    staleTime: 30_000,
    retry: false,
});

export const affiliatesQueryOptions = queryOptions({
    queryKey: ['growth', 'affiliates'],
    queryFn: () => growthApi.listAffiliates(),
    staleTime: 10_000,
    retry: false,
});

const codeInput = z.object({ code: z.string().min(1).max(64) });
export const getReferralLandingServerFn = createServerFn()
    .validator((input: unknown) => codeInput.parse(input))
    .handler(({ data }): Promise<ReferralLanding | null> => getReferralLanding(data.code));

const slugInput = z.object({ slug: z.string().min(1).max(64) });
export const getOfferLandingServerFn = createServerFn()
    .validator((input: unknown) => slugInput.parse(input))
    .handler(({ data }): Promise<OfferLanding | null> => getOfferLanding(data.slug));

/* "20%" or "$5.00": the size of a discount, for a headline. */
export function discountAmount(input: DiscountTerms | { percentOff: number }) {
    return 'type' in input && input.type === 'fixed'
        ? formatMoney(input.amount, input.currency)
        : `${input.percentOff}%`;
}

/* A discount's shape in words: "20% off, forever" or "$5.00 off your first 3 months". */
export function describeDiscount(
    input:
        | DiscountTerms
        | {
              percentOff: number;
              duration: 'once' | 'forever' | 'repeating';
              durationMonths: number | null;
          },
) {
    const what = `${discountAmount(input)} off`;
    if (input.duration === 'forever') return `${what}, for as long as you stay`;
    if (input.duration === 'once') return `${what} your first payment`;
    const months = input.durationMonths ?? 1;
    return `${what} your first ${months === 1 ? 'month' : `${months} months`}`;
}

/* Commission in words, from basis points. */
export function describeCommission(bps: number) {
    return `${(bps / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 })}%`;
}

/* A price after the offer, or null for a fixed amount in another currency, which only the checkout can convert. */
export function discounted(amount: number, currency: string, terms: DiscountTerms) {
    if (terms.type === 'percentage')
        return Math.max(0, Math.round(amount * (1 - terms.percentOff / 100)));
    return terms.currency === currency ? Math.max(0, amount - terms.amount) : null;
}
