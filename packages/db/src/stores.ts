import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
    const defaultRegion = () =>
        tx
            .select({ storeId: storageRegions.storeId })
            .from(storageRegions)
            .where(eq(storageRegions.isDefault, true))
            .for('share');
    /*
     * Asked twice when the first answer is empty. If the default flag moved from one region
     * to another while this waited for the lock, the row it waited on is no longer the
     * default when the lock comes, and the region that now is was not the default when the
     * statement began, so the statement finds neither (READ COMMITTED). A second statement
     * sees what the change committed.
     */
    const [region] = await defaultRegion().then((rows) => (rows.length ? rows : defaultRegion()));
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

/*
 * The stores whose whole bucket the orphan sweep walks: every region's store
 * that holds, or may hold, objects. A draft or a store still being checked holds
 * none. Backup stores are not swept, and a company's own bucket will be walked
 * by its workspaces' prefixes, never whole (4.3).
 *
 * A store that is the target of a move still preparing or copying must be left
 * out here once moves exist (8.3): a copy that has landed and not yet flipped is
 * known nowhere.
 */
export async function listSweepStores() {
    const rows = await db
        .select({ id: objectStores.id })
        .from(objectStores)
        .where(
            and(
                eq(objectStores.kind, 'region'),
                inArray(objectStores.status, ['ready', 'failing']),
            ),
        )
        .orderBy(asc(objectStores.id));
    return rows.map((row) => row.id);
}

/*
 * The stores that hold some object's own copy, whatever their kind or status:
 * the audit confirms each store's objects apart, a page a store (2.4). Asked of
 * the objects themselves, by the store index, so a store nothing is at costs
 * one probe.
 */
export async function listStoresHoldingObjects() {
    const rows = await db
        .select({ id: objectStores.id })
        .from(objectStores)
        .where(sql`exists (select 1 from drive_objects o where o.store_id = ${objectStores.id})`)
        .orderBy(asc(objectStores.id));
    return rows.map((row) => row.id);
}
