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
    markAffiliatePaid: (id, expected) =>
        unwrap(
            api()
                .affiliates({ id })
                .paid.post(expected ? { expected } : {}),
        ),
    affiliateLedgerStatus: () => unwrap(api().affiliates.ledger.get()),
    affiliateEarnings: (id) => unwrap(api().affiliates({ id }).earnings.get()),
    voidAffiliateEarning: (id, earning, reason) =>
        unwrap(api().affiliates({ id }).earnings({ earning }).void.post({ reason })),
    releaseAffiliateEarning: (id, earning) =>
        unwrap(api().affiliates({ id }).earnings({ earning }).release.post({})),
    confirmAffiliateClawback: (id, earning) =>
        unwrap(api().affiliates({ id }).earnings({ earning }).clawback.confirm.post({})),
    settleAffiliateClawback: (id, earning, input) =>
        unwrap(api().affiliates({ id }).earnings({ earning }).clawback.settle.post(input)),
    deleteAffiliateRecord: (id) => unwrap(api().affiliates({ id }).record.delete({})),
    affiliateHandle: (value, except, signal) =>
        unwrap(
            api().affiliates.handle.get({
                query: { value, ...(except ? { except } : {}) },
                fetch: { signal },
            }),
        ),
};
