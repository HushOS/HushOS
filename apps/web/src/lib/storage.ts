import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { driveClient, driveOpenQueryOptions, invalidateFolders } from '@/lib/drive';
import { storageQueryOptions } from '@/lib/queries';

/*
 * What fills the space: files, earlier versions of files and the trash. The
 * server counts all three against the allowance; the sidebar's total is their
 * sum. Opening Drive first lets this work from any page.
 */

export const storageBreakdownQueryOptions = (queryClient: QueryClient, userId: string) =>
    queryOptions({
        queryKey: ['drive', 'storage', 'breakdown'],
        queryFn: async () => {
            await queryClient.fetchQuery(driveOpenQueryOptions(userId));
            return driveClient.storageBreakdown();
        },
        staleTime: 0,
        retry: false,
    });

/* Every earlier version of every file, a batch at a time. Returns how many went. */
export async function removeEarlierVersions(queryClient: QueryClient, userId: string) {
    await queryClient.fetchQuery(driveOpenQueryOptions(userId));
    let purged = 0;
    for (;;) {
        const step = await driveClient.discardSupersededVersions();
        purged += step.purged;
        if (step.remaining === 0 || step.purged === 0) break;
    }
    await Promise.all([
        invalidateFolders(queryClient),
        queryClient.invalidateQueries({ queryKey: storageQueryOptions.queryKey }),
        queryClient.invalidateQueries({ queryKey: ['drive', 'storage', 'breakdown'] }),
    ]);
    return purged;
}
