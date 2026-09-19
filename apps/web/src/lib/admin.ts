import { queryOptions } from '@tanstack/react-query';
import { apiClient, unwrap } from '@/lib/api-client';

/* The management overview; the server answers a member with 404. */
export const adminOverviewQueryOptions = queryOptions({
    queryKey: ['admin', 'overview'],
    queryFn: () => unwrap(apiClient().admin.overview.get()),
    staleTime: 15_000,
    retry: false,
});
