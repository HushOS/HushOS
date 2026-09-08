import { queryOptions } from '@tanstack/react-query';
import { getApi, getApiFetch } from '@/lib/api';
import { authClient } from '@/lib/auth-client';

export const healthQueryOptions = queryOptions({
    queryKey: ['api', 'health'],
    queryFn: async ({ signal }) => {
        const { data, error } = await getApi().health.get({
            fetch: { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) },
        });
        if (error) throw new Error(`API returned ${String(error.status)}.`);
        return data;
    },
});

export const greetingQueryOptions = queryOptions({
    queryKey: ['api', 'greeting'],
    queryFn: async ({ signal }) => {
        const { data, error } = await getApiFetch()('/api/greeting', {
            method: 'GET',
            signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
        });
        if (error) throw new Error(`API returned ${String(error.status)}.`);
        return data;
    },
});

/* The signed-in user's workspace storage allowance. Null until the account is initialised. */
export const storageQueryOptions = queryOptions({
    queryKey: ['auth', 'storage'],
    queryFn: async () => (await authClient.storage()).storage,
    staleTime: 30_000,
    retry: false,
});

const GIB = 1_073_741_824;
export function formatGiB(bytes: string | number) {
    return `${(Number(bytes) / GIB).toLocaleString(undefined, { maximumFractionDigits: 2 })} GiB`;
}
