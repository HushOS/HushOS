import type { BillingApi, GroupBillingApi } from '@hushos/billing/api';
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

const group = (id: string) => api().groups({ id });

/* A family's plan (docs/groups-design.md 3.5). */
export const groupBillingApi: GroupBillingApi = {
    summary: (groupId) => unwrap(group(groupId).get()),
    checkout: (groupId, productId, currency) =>
        unwrap(group(groupId).checkout.post({ productId, currency })),
    setUnits: (groupId, units) => unwrap(group(groupId).units.post({ units })),
    portal: (groupId) => unwrap(group(groupId).portal.post({})),
    sync: (groupId) => unwrap(group(groupId).sync.post({})),
};
