import type { QueryClient } from '@tanstack/react-query';
import { driveClient, driveKeys, driveOpenQueryOptions } from '@/lib/drive';

/*
 * Empties the trash a batch at a time until the server reports nothing left.
 * Opens Drive first, so it works from any page, and refreshes every listing
 * after each batch so the person watches it drain. Returns what was purged.
 */
export async function emptyTrashAll(
    queryClient: QueryClient,
    userId: string,
    onProgress?: (purged: number) => void,
) {
    await queryClient.fetchQuery(driveOpenQueryOptions(userId));
    let purged = 0;
    for (;;) {
        const step = await driveClient.emptyTrash();
        purged += step.purged;
        onProgress?.(purged);
        await queryClient.invalidateQueries({ queryKey: driveKeys.all });
        if (step.remaining === 0 || step.purged === 0) break;
    }
    return purged;
}
