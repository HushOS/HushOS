import { getSessionUser } from '@hushos/auth/server';
import type { BillingSummary } from '@hushos/billing/api';
import { billingEnabled, getSummary, listCatalogue } from '@hushos/billing/server';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { createIsomorphicFn, createServerFn } from '@tanstack/react-start';
import { useRequest } from 'nitro/context';
import { billingApi } from '@/lib/billing-api';

/* The public plan catalogue, for pages rendered before the browser can ask the API. */
export const getCatalogueServerFn = createServerFn().handler(() => listCatalogue());

/*
 * The catalogue and the signed-in person's subscription, read directly on the
 * server during SSR and through the API in the browser, so a page's first paint
 * already knows which plan is current.
 */
const readCatalogue = createIsomorphicFn()
    .server(() => listCatalogue())
    .client(() => billingApi.catalogue());

const signedOut: BillingSummary = {
    enabled: false,
    hasCustomer: false,
    subscription: null,
    intendedPlan: null,
};
const readBillingSummary = createIsomorphicFn()
    .server(async () => {
        const user = await getSessionUser(useRequest());
        return user ? getSummary(user) : signedOut;
    })
    .client(() => billingApi.summary());

export const catalogueQueryOptions = queryOptions({
    queryKey: ['billing', 'catalogue'],
    queryFn: () => readCatalogue(),
    staleTime: 5 * 60_000,
    retry: false,
});

export const billingQueryOptions = queryOptions({
    queryKey: ['billing', 'summary'],
    queryFn: () => readBillingSummary(),
    staleTime: 30_000,
    retry: false,
});

const readBillingEnabled = createIsomorphicFn()
    .server(() => billingEnabled())
    .client(() => false);

/*
 * Whether this instance sells plans: answered once on the server, dehydrated
 * with the first document, and never refetched in the browser.
 */
const billingEnabledQueryOptions = queryOptions({
    queryKey: ['billing', 'enabled'],
    queryFn: () => readBillingEnabled(),
    staleTime: Infinity,
    gcTime: Infinity,
});

export function billingHint(queryClient: QueryClient) {
    return queryClient.ensureQueryData(billingEnabledQueryOptions);
}
