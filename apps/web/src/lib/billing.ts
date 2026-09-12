import { readSessionToken } from '@hushos/auth/http';
import { getSessionUser } from '@hushos/auth/server';
import { appEnv } from '@hushos/env/app';
import type { BillingSummary } from '@hushos/billing/api';
import { billingEnabled, getSummary, listCatalogue } from '@hushos/billing/server';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { createIsomorphicFn, createServerFn } from '@tanstack/react-start';
import { useRequest } from 'nitro/context';
import { billingApi } from '@/lib/billing-api';
import type { LocaleHint } from '@/lib/currency';

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
        const user = await getSessionUser(readSessionToken(useRequest()));
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

/*
 * Where the visitor is, as far as the request says: the country a geolocating
 * proxy reports in the configured header, and the browser's language preference.
 * Read once on the server, dehydrated with the document, and reused in the browser
 * so the currency the page opened in does not change under the visitor.
 */
const readLocaleHint = createIsomorphicFn()
    .server((): LocaleHint => {
        const headers = useRequest().headers;
        const header = appEnv.TRUSTED_COUNTRY_HEADER;
        return {
            country: header ? headers.get(header) : null,
            acceptLanguage: headers.get('accept-language'),
            trusted: Boolean(header),
        };
    })
    .client((): LocaleHint => ({
        country: null,
        acceptLanguage: navigator.languages?.join(',') || navigator.language || null,
        trusted: false,
    }));

export const localeHintQueryOptions = queryOptions({
    queryKey: ['locale', 'hint'],
    queryFn: () => readLocaleHint(),
    staleTime: Infinity,
    gcTime: Infinity,
});

export function billingHint(queryClient: QueryClient) {
    return queryClient.ensureQueryData(billingEnabledQueryOptions);
}
