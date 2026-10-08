import { queryOptions } from '@tanstack/react-query';
import { apiClient, unwrap } from '@/lib/api-client';

/* The management overview; the server answers a member with 404. */
export const adminOverviewQueryOptions = queryOptions({
    queryKey: ['admin', 'overview'],
    queryFn: () => unwrap(apiClient().admin.overview.get()),
    staleTime: 15_000,
    retry: false,
});

export type AccountFilters = {
    role?: 'admin' | 'member';
    q?: string;
    sort?: 'joined' | 'stored';
    offset?: number;
};

export const adminAccountsQueryOptions = (filters: AccountFilters) =>
    queryOptions({
        queryKey: ['admin', 'accounts', filters],
        queryFn: () => unwrap(apiClient().admin.accounts.get({ query: filters })),
        staleTime: 15_000,
        retry: false,
    });

export const adminAccountQueryOptions = (id: string) =>
    queryOptions({
        queryKey: ['admin', 'account', id],
        queryFn: () => unwrap(apiClient().admin.accounts({ id }).get()),
        staleTime: 15_000,
        retry: false,
    });

export const adminWorkspacesQueryOptions = (filters: {
    sort?: 'stored' | 'created';
    offset?: number;
}) =>
    queryOptions({
        queryKey: ['admin', 'workspaces', filters],
        queryFn: () => unwrap(apiClient().admin.workspaces.get({ query: filters })),
        staleTime: 15_000,
        retry: false,
    });

/* Suspends or reinstates one account; its sessions end at once when suspended. */
export function setAccountSuspended(id: string, suspended: boolean) {
    return unwrap(apiClient().admin.accounts({ id }).suspension.post({ suspended }));
}
