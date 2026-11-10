import { and, eq, sql } from 'drizzle-orm';
import { db } from './client';
import type { Tx } from './drive';
import { ENVIRONMENT_REPLICA_STORE_ID, objectStores, storageRegions } from './schema';

/*
 * Stores and regions (docs/company-storage-design.md 2 and 11.1). Rows here say
 * where bytes are; nothing here opens a store, and an environment row holds
 * nothing to open one with.
 */

/*
 * Which store a new upload in `workspaceId` goes to (2.2), read inside the
 * transaction that records the upload and under a share lock on the row it is
 * read from. A move's switch takes that row for update, so an upload either
 * commits before the switch or reads what the switch wrote: it never chooses a
 * store the switch has left.
 *
 * Every workspace resolves to the default region today. A company's own bucket
 * and a company's region are read here first, under a share lock on the
 * company's row, once `groups` carries them.
 */
export async function uploadStoreFor(tx: Tx, _workspaceId: string) {
    const [region] = await tx
        .select({ storeId: storageRegions.storeId })
        .from(storageRegions)
        .where(eq(storageRegions.isDefault, true))
        .for('share');
    if (!region) throw new Error('There is no default storage region.');
    return region.storeId;
}

/*
 * What the worker says at start about its own environment: whether it describes
 * the replica. Without it the default region has no working backup. The web
 * process never calls this: it holds no replica variables and cannot know.
 * Returns whether the row changed.
 */
export async function recordEnvironmentReplica(present: boolean) {
    const rows = await db
        .update(objectStores)
        .set({
            envPresent: present,
            version: sql`${objectStores.version} + 1`,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(objectStores.id, ENVIRONMENT_REPLICA_STORE_ID),
                sql`${objectStores.envPresent} is distinct from ${present}`,
            ),
        )
        .returning({ id: objectStores.id });
    return rows.length > 0;
}
