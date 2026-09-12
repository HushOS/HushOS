import type { BillingApi } from '@hushos/billing/api';
import { apiClient, unwrap } from '@/lib/api-client';

const api = () => apiClient().billing;

export const billingApi: BillingApi = {
    catalogue: () => unwrap(api().catalogue.get()),
    summary: () => unwrap(api().get()),
    checkout: (productId, currency) => unwrap(api().checkout.post({ productId, currency })),
    portal: () => unwrap(api().portal.post({})),
    sync: () => unwrap(api().sync.post({})),
    cancel: (input) => unwrap(api().cancel.post(input)),
    resume: () => unwrap(api().resume.post({})),
};
