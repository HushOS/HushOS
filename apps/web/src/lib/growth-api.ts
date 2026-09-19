import type { GrowthApi } from '@hushos/billing/api';
import { apiClient, unwrap } from '@/lib/api-client';

const api = () => apiClient().billing;

export const growthApi: GrowthApi = {
    referrals: () => unwrap(api().referrals.get()),
    rememberCoupon: (code) => unwrap(api().coupon.post({ code })),
    listAffiliates: () => unwrap(api().affiliates.get()),
    createAffiliate: (input) => unwrap(api().affiliates.post(input)),
    updateAffiliate: (id, patch) => unwrap(api().affiliates({ id }).patch(patch)),
    deleteAffiliate: (id) => unwrap(api().affiliates({ id }).delete({})),
    markAffiliatePaid: (id) => unwrap(api().affiliates({ id }).paid.post({})),
};
