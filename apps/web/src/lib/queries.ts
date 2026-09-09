import { queryOptions } from '@tanstack/react-query';
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
    return `${(Number(bytes) / GIB).toLocaleString(undefined, { maximumFractionDigits: 2 })} GiB`;
}
