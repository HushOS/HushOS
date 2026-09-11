import { queryOptions } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { authClient } from '@/lib/auth-client';

/* The signed-in user's workspace storage allowance. Null until the account is initialised. */
export const storageQueryOptions = queryOptions({
    queryKey: ['auth', 'storage'],
    queryFn: async () => (await authClient.storage()).storage,
    staleTime: 30_000,
    retry: false,
});

const GIB = 1_073_741_824;
export function formatGiB(bytes: string | number) {
    const gib = Number(bytes) / GIB;
    const [value, unit] = gib >= 1024 ? [gib / 1024, 'TiB'] : [gib, 'GiB'];
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;
}

export { billingQueryOptions, catalogueQueryOptions } from '@/lib/billing';

export function formatMoney(amount: number, currency: string) {
    return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currency.toUpperCase(),
        minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
    }).format(amount / 100);
}

/* Whether this server sells plans; false on self-hosted instances, so billing UI never shows. */
export function useBillingEnabled() {
    return useRouteContext({ from: '__root__' }).billingEnabled;
}
