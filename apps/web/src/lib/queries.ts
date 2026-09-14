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

export { formatGiB, formatMoney } from '@/lib/format';
export { billingQueryOptions, catalogueQueryOptions, localeHintQueryOptions } from '@/lib/billing';

/* Whether this server sells plans; false on self-hosted instances, so billing UI never shows. */
export function useBillingEnabled() {
    return useRouteContext({ from: '__root__' }).billingEnabled;
}
