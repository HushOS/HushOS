import { and, asc, eq, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { db } from './client';
import type { Tx } from './drive';
import { heldObjectCondition } from './reports';
import {
    ENVIRONMENT_REPLICA_STORE_ID,
    driveObjectDeletions,
    driveObjects,
    type DeletionReason,
} from './schema';

/*
 * The deletion outbox (docs/company-storage-design.md 8.4): one row per copy
 * to remove, keyed by the object and the store that copy is in. Everything
 * that queues a copy, takes one back, removes one or asks whether a key is
 * accounted for at a store is here, so the rules are in one place:
 *
 * - a new row replaces a finished row for the same object and store, whole;
 * - a new row that meets an unfinished one leaves it, except that `purged`
 *   replaces `moved` or `stray` and clears the hold and the wait;
 * - a `moved` row waits for its move and then for `not_before`, and before it
 *   deletes anything the worker sees the object's new copy again;
 * - no row ever deletes the copy at the store its object's row names;
 * - an open or held report keeps every copy of what it names;
 * - a copy is deleted only by whoever holds its row's lock, which a flip back
 *   to that store takes too, so a copy is never deleted while it is being
 *   taken back;
 * - a finished row goes 30 days after it finished, and from the moment it
 *   finishes it no longer makes its key known at its store.
 *
 * Nothing here opens a store. The worker's jobs pass in what asks and deletes
 * there, and it runs while the row is locked.
 */

export type ObjectDeletion = typeof driveObjectDeletions.$inferSelect;
export type DeletionKey = { objectId: string; storeId: string };

/* How long a finished row is kept, and how long a backup copy outlives its primary: the window for undoing a bad purge. */
export const FINISHED_DELETION_DAYS = 30;
export const BACKUP_UNDO_DAYS = 30;
/* Backup copies that may fail in a row before the copy job leaves an object alone. */
export const COPY_FAILURE_LIMIT = 10;

/*
 * Where a row's backup copy is. `replicated_at` (or an outbox row's
 * `replicated`) with no store named is the shape a worker of the release before
 * `backup_store_id` writes, and it knows one backup: the environment's replica.
 */
export function backupOfMark(mark: { backedUp: boolean; backupStoreId: string | null }) {
    if (!mark.backedUp) return null;
    return mark.backupStoreId ?? ENVIRONMENT_REPLICA_STORE_ID;
}

const backupOfRow = (row: Pick<ObjectDeletion, 'replicated' | 'backupStoreId'>) =>
    backupOfMark({ backedUp: row.replicated, backupStoreId: row.backupStoreId });

/* The same, in SQL, over `drive_objects o`. */
const objectBackup = sql`case when o.replicated_at is null then null else coalesce(o.backup_store_id, ${ENVIRONMENT_REPLICA_STORE_ID}::uuid) end`;

/*
 * The replacement rule, as one statement's ON CONFLICT. `d` is the row already
 * there. Finished: everything is the new row's. Unfinished and met by a purge,
 * whatever its own reason: the reason is `purged`, the hold, the wait and the
 * attention mark go, the copy at the store is removed again whatever the row
 * had recorded, and what either row knows is kept (that the object was
 * published, that a backup copy exists and where), so a second purge of the
 * same copy can add a fact and never drops one. Unfinished and met by anything
 * else: left as it is.
 */
const REPLACE = sql`
    on conflict (object_id, store_id) do update set
        workspace_id = excluded.workspace_id,
        object_key = excluded.object_key,
        reason = excluded.reason,
        published = case when d.done_at is null then d.published or excluded.published else excluded.published end,
        replicated = case when d.done_at is null then d.replicated or excluded.replicated else excluded.replicated end,
        backup_store_id = case when d.done_at is null then coalesce(excluded.backup_store_id, d.backup_store_id) else excluded.backup_store_id end,
        export_store_id = case when d.done_at is null then d.export_store_id else excluded.export_store_id end,
        export_last_seq = case when d.done_at is null then d.export_last_seq else excluded.export_last_seq end,
        held_by_move = excluded.held_by_move,
        not_before = excluded.not_before,
        backup_left = false,
        attention = false,
        failures = 0,
        failed_at = null,
        primary_deleted_at = null,
        delete_replica_after = null,
        done_at = null,
        created_at = case when d.done_at is null then d.created_at else excluded.created_at end
    where d.done_at is not null or excluded.reason = 'purged'
`;

export type QueuedCopy = {
    objectId: string;
    workspaceId: string;
    objectKey: string;
    /* The store the copy to remove is in. */
    storeId: string;
    reason: DeletionReason;
    /* Whether the object was ever readable: a copy nobody could read waits for no backup. */
    published: boolean;
    /* The store that already holds a backup of this copy, or null. */
    backupStoreId: string | null;
    /* The move a `moved` copy waits for. */
    heldByMove?: string | null;
};

/* Queues one copy for removal, under the replacement rule. True when a row was written or replaced. */
export async function queueCopy(tx: Tx, copy: QueuedCopy) {
    const result = await tx.execute<{ object_id: string }>(sql`
        insert into ${driveObjectDeletions} as d
            (object_id, store_id, workspace_id, object_key, reason, published, replicated, backup_store_id, held_by_move)
        values (
            ${copy.objectId}, ${copy.storeId}, ${copy.workspaceId}, ${copy.objectKey}, ${copy.reason},
            ${copy.published}, ${copy.backupStoreId !== null}, ${copy.backupStoreId}, ${copy.heldByMove ?? null}
        )
        ${REPLACE}
        returning d.object_id
    `);
    return result.rows.length > 0;
}

/*
 * Nothing can be undone for an object that is gone: the copies its moves left
 * behind stop waiting for their move and for their date.
 */
async function releaseMovedCopies(tx: Tx, where: SQL) {
    await tx.execute(sql`
        update ${driveObjectDeletions} set held_by_move = null, not_before = null
        where ${where} and reason = 'moved' and done_at is null
    `);
}

/*
 * A purged object: its row is gone (the caller deleted it in this transaction
 * and passes what it held), and the copy at the store that row named is queued
 * with the backup copy it had.
 */
export async function queuePurgedObject(
    tx: Tx,
    object: {
        id: string;
        workspaceId: string;
        objectKey: string;
        storeId: string;
        status: 'pending' | 'ready' | 'missing';
        replicatedAt: Date | null;
        backupStoreId: string | null;
    },
) {
    await queueCopy(tx, {
        objectId: object.id,
        workspaceId: object.workspaceId,
        objectKey: object.objectKey,
        storeId: object.storeId,
        reason: 'purged',
        published: object.status === 'ready',
        backupStoreId: backupOfMark({
            backedUp: object.replicatedAt !== null,
            backupStoreId: object.backupStoreId,
        }),
    });
    await releaseMovedCopies(tx, sql`object_id = ${object.id}`);
}

/*
 * Every object of a workspace that is about to be deleted whole (a purged
 * family folder, a deleted account's own space), each at the store its row
 * names. The workspace's rows go by cascade right after, in the same
 * transaction; without this nothing would name their bytes, and a backup copy
 * would never be removed at all. Returns how many were queued.
 */
export async function queueWorkspaceObjects(tx: Tx, workspaceId: string) {
    // The objects are locked before anything is queued, in id order. A flip locks the object's
    // row and then its outbox rows, so this takes the same order and cannot deadlock with one;
    // and a flip that commits while this waits is seen whole: the row read here is the one it
    // wrote, so the copy queued is the one the object lives on now, not the one it had left.
    const result = await tx.execute<{ object_id: string }>(sql`
        with o as materialized (
            select id, store_id, workspace_id, object_key, status, replicated_at, backup_store_id
            from ${driveObjects}
            where workspace_id = ${workspaceId}
            order by id
            for update
        )
        insert into ${driveObjectDeletions} as d
            (object_id, store_id, workspace_id, object_key, reason, published, replicated, backup_store_id)
        select o.id, o.store_id, o.workspace_id, o.object_key, 'purged', o.status = 'ready',
               o.replicated_at is not null, ${objectBackup}
        from o
        ${REPLACE}
        returning d.object_id
    `);
    await releaseMovedCopies(tx, sql`workspace_id = ${workspaceId}`);
    return result.rows.length;
}

/* ------------------------------------------------------------------------- */
/* What the worker's deletion job reads and does                              */
/* ------------------------------------------------------------------------- */

/* Not waiting on a move or on its date. */
const released = sql`${driveObjectDeletions.heldByMove} is null and (${driveObjectDeletions.notBefore} is null or ${driveObjectDeletions.notBefore} <= now())`;
/* The rows that have waited longest since a failure first, so one that keeps failing cannot hold the rest. */
const fairly = [
    sql`${driveObjectDeletions.failedAt} asc nulls first`,
    asc(driveObjectDeletions.createdAt),
];
/*
 * A row's place in its own store's line. Ordered by it first, a page holds the
 * first row of every store, then the second of each, and so on: a store with
 * ten thousand rows waiting takes no more of a page than a store with ten
 * (2.4). `store` is the store the row's next call goes to.
 */
const turnAt = (store: SQL) =>
    sql`row_number() over (partition by ${store} order by ${driveObjectDeletions.failedAt} asc nulls first, ${driveObjectDeletions.createdAt} asc)`;

/*
 * Rows whose copy at their own store is still there and may go now: not held by
 * a report, not waiting on a move. Each store's rows in turn.
 */
export async function listPendingObjectDeletions(limit = 200) {
    return db
        .select()
        .from(driveObjectDeletions)
        .where(
            and(
                isNull(driveObjectDeletions.doneAt),
                isNull(driveObjectDeletions.primaryDeletedAt),
                released,
                // An open or held report names the object: it stays until the report lets go.
                heldObjectCondition(driveObjectDeletions.objectId),
            ),
        )
        .orderBy(turnAt(sql`${driveObjectDeletions.storeId}`), ...fairly)
        .limit(limit);
}

/* Rows whose backup copy has outlived its undo window, each backup store's rows in turn. */
export async function listBackupDeletionsDue(limit = 200) {
    return db
        .select()
        .from(driveObjectDeletions)
        .where(
            and(
                isNull(driveObjectDeletions.doneAt),
                sql`${driveObjectDeletions.primaryDeletedAt} is not null`,
                sql`${driveObjectDeletions.deleteReplicaAfter} <= now()`,
            ),
        )
        .orderBy(
            turnAt(
                sql`coalesce(${driveObjectDeletions.backupStoreId}, ${ENVIRONMENT_REPLICA_STORE_ID}::uuid)`,
            ),
            ...fairly,
        )
        .limit(limit);
}

/* What the deletion job can do at a store. Each call throws when the store did not answer. */
export type CopyStore = {
    /* The backup store this worker keeps for objects at `storeId`, or null when it keeps none. */
    backupOf: (storeId: string) => string | null;
    /* Whether this worker can open the backup store `storeId` at all. */
    keepsBackup: (storeId: string) => boolean;
    /* Whether the object is at `storeId` at exactly `size` bytes. */
    present: (storeId: string, objectKey: string, size: bigint) => Promise<boolean>;
    /* Whether `storeId` holds anything at all under that key. */
    exists: (storeId: string, objectKey: string) => Promise<boolean>;
    /* Deletes the copy at `storeId`. */
    remove: (storeId: string, objectKey: string) => Promise<void>;
};

export type CopyRemoval =
    /* The copy is deleted. `backup` says what became of its backup copy. */
    | { status: 'removed'; backup: 'none' | 'later' | 'left' }
    /* Not this run: the row finished or was taken back meanwhile, or another worker has it. */
    | { status: 'skipped' }
    /* A report or a move holds it. */
    | { status: 'held' }
    /* Its only copy must reach the backup first. */
    | { status: 'waiting' }
    /* Deleting it could lose the object. `first` is true when this run is the one that marked it. */
    | { status: 'attention'; why: 'lives-here' | 'new-copy-absent'; first: boolean };

async function lockRow(tx: Tx, key: DeletionKey) {
    const [row] = await tx
        .select({
            row: driveObjectDeletions,
            free: sql<boolean>`${heldObjectCondition(driveObjectDeletions.objectId)}`,
            due: sql<boolean>`${released}`,
            backupDue: sql<boolean>`${driveObjectDeletions.deleteReplicaAfter} <= now()`,
        })
        .from(driveObjectDeletions)
        .where(
            and(
                eq(driveObjectDeletions.objectId, key.objectId),
                eq(driveObjectDeletions.storeId, key.storeId),
            ),
        )
        // Whoever holds the row is deleting its copy or taking it back: not ours this run.
        .for('update', { skipLocked: true });
    return row ?? null;
}

/*
 * How long Postgres lets a removal sit idle inside its transaction, which is
 * what it does while it waits for the store. Every store call has a total
 * deadline now (2.4), and the worker gives one removal's calls a single
 * deadline of 60 seconds between them, so this is the second bound and not the
 * first: three times that, and under the five minutes between runs. It is what
 * holds if a call ever outlives its deadline, or the worker stalls with the
 * row locked: without it such a removal would hold the row's lock, hold back
 * vacuum for the whole database, and block whoever needs the row or a lock on
 * the table behind it. When it fires the session is ended, the transaction
 * with it, nothing is marked, and the row is tried again.
 */
export const REMOVAL_IDLE_SECONDS = 180;

async function boundIdle(tx: Tx, idleMs: number) {
    if (!Number.isInteger(idleMs) || idleMs <= 0) throw new Error('Unexpected idle timeout.');
    await tx.execute(sql.raw(`set local idle_in_transaction_session_timeout = ${idleMs}`));
}

const rowIs = (key: DeletionKey) =>
    and(
        eq(driveObjectDeletions.objectId, key.objectId),
        eq(driveObjectDeletions.storeId, key.storeId),
    );

/*
 * Removes the copy one row names from the row's own store, under the row's
 * lock from the first look to the mark, so that nothing takes the copy back
 * while it is being deleted and no second worker deletes it again.
 *
 * Before anything is deleted:
 * - a report's hold, a move's hold and `not_before` are read again under the lock;
 * - if the object's row names this very store, the copy is the live one and is
 *   never deleted, whatever the reason says (`attention`);
 * - a `moved` copy goes only once the store the object now names shows it at
 *   the row's size (`attention` otherwise); an object purged since has no row,
 *   and nothing depends on the copy;
 * - a purged, published object whose backup copy does not exist yet waits for
 *   it, where this worker keeps a backup of that store.
 *
 * A store that throws rolls everything back: the caller records the failure
 * and the row is tried again. A store that never answers throws too, at its
 * call's deadline; were that ever to fail, Postgres ends the transaction after
 * `REMOVAL_IDLE_SECONDS` (`idleMs` is for tests).
 */
export async function removeQueuedCopy(
    key: DeletionKey,
    store: CopyStore,
    idleMs = REMOVAL_IDLE_SECONDS * 1000,
): Promise<CopyRemoval> {
    return db.transaction(async (tx): Promise<CopyRemoval> => {
        await boundIdle(tx, idleMs);
        const locked = await lockRow(tx, key);
        if (!locked) return { status: 'skipped' };
        const { row } = locked;
        if (row.doneAt || row.primaryDeletedAt) return { status: 'skipped' };
        if (!locked.free || !locked.due) return { status: 'held' };

        const [object] = await tx
            .select({ storeId: driveObjects.storeId, ciphertextSize: driveObjects.ciphertextSize })
            .from(driveObjects)
            .where(eq(driveObjects.id, row.objectId));
        const attention = async (why: 'lives-here' | 'new-copy-absent'): Promise<CopyRemoval> => {
            // The time of the look, so a row that keeps failing it goes to the back of the line.
            await tx
                .update(driveObjectDeletions)
                .set({ attention: true, failedAt: new Date() })
                .where(rowIs(key));
            return { status: 'attention', why, first: !row.attention };
        };
        if (object?.storeId === row.storeId) return attention('lives-here');
        if (
            row.reason === 'moved' &&
            object &&
            !(await store.present(object.storeId, row.objectKey, object.ciphertextSize))
        )
            return attention('new-copy-absent');

        const backedUpAt = backupOfRow(row);
        if (
            row.reason === 'purged' &&
            row.published &&
            backedUpAt === null &&
            store.backupOf(row.storeId) !== null &&
            // A copy that is not there can never reach the backup: waiting for it would be
            // for ever. The store said so itself; one that did not answer throws instead.
            (await store.exists(row.storeId, row.objectKey))
        )
            return { status: 'waiting' };

        await store.remove(row.storeId, row.objectKey);

        // The database's clock, read after the store answered: a flip compares it with when
        // its own copy began (`databaseNow`), and must never read a deletion as older than it was.
        const base = {
            primaryDeletedAt: sql`clock_timestamp()`,
            attention: false,
            failures: 0,
            failedAt: null,
        };
        if (backedUpAt === null) {
            await tx
                .update(driveObjectDeletions)
                .set({ ...base, doneAt: sql`clock_timestamp()` })
                .where(rowIs(key));
            return { status: 'removed', backup: 'none' };
        }
        if (!(await backupPruned(tx, backedUpAt))) {
            // Not HushOS's to delete there: recorded, and finished.
            await tx
                .update(driveObjectDeletions)
                .set({ ...base, backupLeft: true, doneAt: sql`clock_timestamp()` })
                .where(rowIs(key));
            return { status: 'removed', backup: 'left' };
        }
        await tx
            .update(driveObjectDeletions)
            .set({
                ...base,
                deleteReplicaAfter: sql`clock_timestamp() + make_interval(days => ${BACKUP_UNDO_DAYS})`,
            })
            .where(rowIs(key));
        return { status: 'removed', backup: 'later' };
    });
}

/* Whether HushOS removes deleted files' copies from this backup store: some region names it as its backup, with pruning on. */
async function backupPruned(tx: Tx, backupStoreId: string) {
    const result = await tx.execute<{ found: number }>(sql`
        select 1 as found from storage_regions
        where backup_store_id = ${backupStoreId} and backup_prune
        limit 1
    `);
    return result.rows.length > 0;
}

export type BackupRemoval =
    | { status: 'removed' }
    /* Finished without deleting: the copy is a live object's again, or is not HushOS's to delete. */
    | { status: 'kept'; why: 'live' | 'left' }
    | { status: 'skipped' };

/*
 * Removes the backup copy of a row whose primary copy is gone and whose undo
 * window has passed, under the row's lock, and finishes the row.
 *
 * The copy stays, and the row finishes without it, when the object has a row
 * again that names this backup store as where its backup is (it came back to
 * the store this backup serves and was copied afresh under the same key): that
 * copy is a live object's. It is left for whoever runs the backup, and recorded
 * so, when pruning is off for that backup or this worker cannot open it.
 */
export async function removeQueuedBackupCopy(
    key: DeletionKey,
    store: Pick<CopyStore, 'keepsBackup' | 'remove'>,
    idleMs = REMOVAL_IDLE_SECONDS * 1000,
): Promise<BackupRemoval> {
    return db.transaction(async (tx): Promise<BackupRemoval> => {
        await boundIdle(tx, idleMs);
        const locked = await lockRow(tx, key);
        if (!locked) return { status: 'skipped' };
        const { row } = locked;
        if (row.doneAt || !row.primaryDeletedAt || !locked.backupDue) return { status: 'skipped' };
        const finish = async (set: { backupLeft?: boolean } = {}) => {
            await tx
                .update(driveObjectDeletions)
                .set({ ...set, doneAt: new Date(), failures: 0, failedAt: null })
                .where(rowIs(key));
        };
        const backupStoreId = backupOfRow(row);
        if (backupStoreId === null) {
            await finish();
            return { status: 'skipped' };
        }
        const live = await tx.execute<{ found: number }>(sql`
            select 1 as found from ${driveObjects} o
            where o.id = ${row.objectId} and ${objectBackup} = ${backupStoreId}
        `);
        if (live.rows.length) {
            await finish();
            return { status: 'kept', why: 'live' };
        }
        if (!store.keepsBackup(backupStoreId) || !(await backupPruned(tx, backupStoreId))) {
            await finish({ backupLeft: true });
            return { status: 'kept', why: 'left' };
        }
        await store.remove(backupStoreId, row.objectKey);
        await finish();
        return { status: 'removed' };
    });
}

/* A try that threw: counted on the row, which goes to the back of the line and is tried again. */
export async function recordObjectDeletionFailure(key: DeletionKey) {
    await db
        .update(driveObjectDeletions)
        .set({ failures: sql`${driveObjectDeletions.failures} + 1`, failedAt: new Date() })
        .where(and(rowIs(key), isNull(driveObjectDeletions.doneAt)));
}

/*
 * Finished rows past their 30 days, a bounded batch a call. A row that left a
 * backup copy behind is not removed here: the list of what an operator may
 * delete from that backup names it first (10.1), and that list is not written
 * yet.
 */
export async function deleteFinishedObjectDeletions(
    days = FINISHED_DELETION_DAYS,
    limit = 5000,
    now = new Date(),
) {
    const cutoff = new Date(now.getTime() - days * 24 * 3600 * 1000);
    const result = await db.execute<{ object_id: string }>(sql`
        delete from ${driveObjectDeletions}
        where (object_id, store_id) in (
            select object_id, store_id from ${driveObjectDeletions}
            where done_at < ${cutoff} and not backup_left
            limit ${limit}
        )
        -- Again, on the row as it is when the delete reaches it: one queued anew for the
        -- same copy since the batch was chosen is unfinished, and is not this statement's.
        and done_at < ${cutoff} and not backup_left
        returning object_id
    `);
    return result.rows.length;
}

/* ------------------------------------------------------------------------- */
/* The backup mark                                                            */
/* ------------------------------------------------------------------------- */

/*
 * What the store `backupStoreId` backs up and does not hold yet, among what is
 * at `storeId`: live ready objects, and outbox rows for published objects
 * purged before the copy job caught up, whose only copy must reach the backup
 * before the primary may go. Objects that have failed least come first, and
 * one that has failed `COPY_FAILURE_LIMIT` times in a row is left alone.
 *
 * `ciphertextSize` is what bounds the copy's reads (2.4). An object purged
 * since has no row left to say it, and none is kept on its outbox row: null.
 */
export async function listUnreplicatedObjects(storeId: string, limit = 100) {
    const live = await db
        .select({
            objectId: driveObjects.id,
            objectKey: driveObjects.objectKey,
            ciphertextSize: driveObjects.ciphertextSize,
        })
        .from(driveObjects)
        .where(
            and(
                eq(driveObjects.status, 'ready'),
                eq(driveObjects.storeId, storeId),
                isNull(driveObjects.replicatedAt),
                lt(driveObjects.copyFailures, COPY_FAILURE_LIMIT),
            ),
        )
        .orderBy(asc(driveObjects.copyFailures), asc(driveObjects.createdAt))
        .limit(limit);
    const retired = await db
        .select({
            objectId: driveObjectDeletions.objectId,
            objectKey: driveObjectDeletions.objectKey,
        })
        .from(driveObjectDeletions)
        .where(
            and(
                eq(driveObjectDeletions.storeId, storeId),
                eq(driveObjectDeletions.reason, 'purged'),
                eq(driveObjectDeletions.published, true),
                eq(driveObjectDeletions.replicated, false),
                isNull(driveObjectDeletions.primaryDeletedAt),
                isNull(driveObjectDeletions.doneAt),
            ),
        )
        .orderBy(...fairly)
        .limit(Math.max(0, limit - live.length));
    return [
        ...live.map((row) => ({ ...row, ciphertextSize: row.ciphertextSize as bigint | null })),
        ...retired.map((row) => ({ ...row, ciphertextSize: null })),
    ].map((row) => ({ ...row, storeId }));
}

/* How many ready objects at `storeId` the copy job has given up on for now. */
export async function countObjectsNotCopied(storeId: string) {
    const [row] = await db
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(driveObjects)
        .where(
            and(
                eq(driveObjects.status, 'ready'),
                eq(driveObjects.storeId, storeId),
                isNull(driveObjects.replicatedAt),
                sql`${driveObjects.copyFailures} >= ${COPY_FAILURE_LIMIT}`,
            ),
        );
    return row?.count ?? 0;
}

/*
 * The backup at `backupStoreId` holds a copy read from `storeId`. Recorded by
 * compare-and-set (8.3): on the object's row only while the object is still at
 * the store that copy was read from, so a copy racing a move never marks an
 * object as backed up in the backup of a region it has left. Otherwise on the
 * outbox row for that copy, when a purge or a move got there first: the backup
 * copy is then removed with it. `neither` means nothing accounts for the copy
 * just made.
 */
export async function markObjectReplicated(input: {
    objectId: string;
    storeId: string;
    backupStoreId: string;
}): Promise<'object' | 'outbox' | 'neither'> {
    return db.transaction(async (tx) => {
        const marked = await tx
            .update(driveObjects)
            .set({ replicatedAt: new Date(), backupStoreId: input.backupStoreId, copyFailures: 0 })
            .where(
                and(eq(driveObjects.id, input.objectId), eq(driveObjects.storeId, input.storeId)),
            )
            .returning({ id: driveObjects.id });
        if (marked.length) return 'object';
        const queued = await tx
            .update(driveObjectDeletions)
            .set({
                replicated: true,
                backupStoreId: input.backupStoreId,
                failures: 0,
                failedAt: null,
            })
            .where(
                and(
                    rowIs(input),
                    isNull(driveObjectDeletions.doneAt),
                    isNull(driveObjectDeletions.primaryDeletedAt),
                ),
            )
            .returning({ id: driveObjectDeletions.objectId });
        return queued.length ? 'outbox' : 'neither';
    });
}

/* A backup copy that threw: counted on the object while it is still at that store, else on its outbox row. */
export async function recordObjectCopyFailure(key: DeletionKey) {
    const counted = await db
        .update(driveObjects)
        .set({ copyFailures: sql`${driveObjects.copyFailures} + 1` })
        .where(and(eq(driveObjects.id, key.objectId), eq(driveObjects.storeId, key.storeId)))
        .returning({ id: driveObjects.id });
    if (!counted.length) await recordObjectDeletionFailure(key);
}

/*
 * Rows a worker of the release before `backup_store_id` marked: backed up, at
 * no store named. It knew one backup, the environment's replica, so they are
 * rewritten to name it (11.1). The worker runs this at every start, since such
 * a worker may have run beside it until then. Objects are walked by id, a
 * bounded page a statement, so no statement holds many row locks for long.
 */
export async function adoptLegacyBackupMarks(batch = 5000) {
    let objects = 0;
    let cursor: string | null = null;
    // Asked first, in one read: once that release is gone there are none, and the walk
    // below would otherwise visit every object at every start to find that out.
    const legacy = await db.execute<{ found: boolean }>(sql`
        select exists(
            select 1 from ${driveObjects} where replicated_at is not null and backup_store_id is null
        ) as found
    `);
    for (; legacy.rows[0]?.found;) {
        const page: { rows: { last: string | null; changed: string }[] } = await db.execute<{
            last: string | null;
            changed: string;
        }>(sql`
            with page as (
                select id from ${driveObjects}
                where ${cursor === null ? sql`true` : sql`id > ${cursor}`}
                order by id limit ${batch}
            ), changed as (
                update ${driveObjects} o set backup_store_id = ${ENVIRONMENT_REPLICA_STORE_ID}
                from page
                where o.id = page.id and o.replicated_at is not null and o.backup_store_id is null
                returning 1
            )
            select (select id from page order by id desc limit 1) as last,
                   (select count(*) from changed)::text as changed
        `);
        const row = page.rows[0];
        objects += Number(row?.changed ?? 0);
        if (!row?.last) break;
        cursor = row.last;
    }
    const outbox = await db
        .update(driveObjectDeletions)
        .set({ backupStoreId: ENVIRONMENT_REPLICA_STORE_ID })
        .where(
            and(
                eq(driveObjectDeletions.replicated, true),
                isNull(driveObjectDeletions.backupStoreId),
                isNull(driveObjectDeletions.doneAt),
            ),
        )
        .returning({ id: driveObjectDeletions.objectId });
    return { objects, outbox: outbox.length };
}

/* ------------------------------------------------------------------------- */
/* Known at this store                                                        */
/* ------------------------------------------------------------------------- */

/*
 * The keys among `keys` that something accounts for at `storeId` (8.4): an
 * object row that names that store as where it is or as where its backup is
 * (which covers an upload still in flight: its object row is written at begin,
 * with the upload's store), or an unfinished outbox row for that key and that
 * store, as the copy to remove or as its backup. A row that names another
 * store, and a finished outbox row, make nothing known here.
 */
export async function knownObjectKeys(storeId: string, keys: string[]) {
    if (!keys.length) return new Set<string>();
    const objects = await db.execute<{ key: string }>(sql`
        select o.object_key as key from ${driveObjects} o
        where ${inArray(sql`o.object_key`, keys)}
          and (o.store_id = ${storeId} or ${objectBackup} = ${storeId})
    `);
    const deletions = await db.execute<{ key: string }>(sql`
        select d.object_key as key from ${driveObjectDeletions} d
        where ${inArray(sql`d.object_key`, keys)}
          and d.done_at is null
          and (d.store_id = ${storeId}
               or (d.replicated and coalesce(d.backup_store_id, ${ENVIRONMENT_REPLICA_STORE_ID}::uuid) = ${storeId}))
    `);
    return new Set([...objects.rows, ...deletions.rows].map((row) => row.key));
}

/* ------------------------------------------------------------------------- */
/* What a move will call (8.2 step 4, 8.4). No move exists yet.               */
/* ------------------------------------------------------------------------- */

/*
 * The database's clock, which is the one the outbox's dates are written with,
 * to the microsecond and as text: a JavaScript date would round it down to the
 * millisecond, and a deletion in that same millisecond would then read as later
 * than a copy that began after it.
 */
export type DatabaseInstant = string;
export async function databaseNow(): Promise<DatabaseInstant> {
    const result = await db.execute<{ now: string }>(
        sql`select to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`,
    );
    return result.rows[0]!.now;
}

export type ObjectFlip =
    /* The object's row now names the target. `reused` when the copy it had left there was taken back. */
    | { status: 'flipped'; reused: boolean }
    /* It was at the target already. */
    | { status: 'already' }
    /* The object was purged meanwhile; a copy just made at the target is queued as a stray. */
    | { status: 'gone' }
    /* Its row names a third store; a copy just made at the target is queued as a stray. */
    | { status: 'elsewhere' }
    /* It is pending or missing, and stays where it is; a copy just made at the target is queued as a stray. */
    | { status: 'not-ready' }
    /* Nothing was changed: the target's copy cannot be relied on, and the bytes must be copied (again). */
    | { status: 'copy-needed' };

/*
 * The flip: an object's row moves from one store to another, and the outbox
 * follows in the same transaction. This is the only place an object's
 * `store_id` changes, so the rule that no unfinished row names the copy an
 * object lives on is kept here.
 *
 * `copiedSince` is when the caller began the copy it has just made and verified
 * at the target (`databaseNow()`, read before the copy), or null when it made
 * none and means to take back the copy the object left there, having seen it
 * at the row's size.
 *
 * - The row flips only if it still names `fromStoreId` (compare-and-set), and
 *   only if the object is `ready`.
 * - An unfinished row for the target whose copy is still there is withdrawn:
 *   the copy is the live one again. Its lock is taken here, and the deletion
 *   job holds the same lock while it deletes, so one of them goes first. If the
 *   job did, there is no such row: with no fresh copy that is `copy-needed`.
 * - A deletion at the target recorded since `copiedSince` may have removed the
 *   copy just made: `copy-needed`, and nothing changes.
 * - A row whose copy at the target is long gone and that only waits to remove
 *   the backup copy is finished without removing it: the object is back at the
 *   store that backup serves, and its copy there is made afresh under the same key.
 * - The backup mark is cleared, the storage class is `standard` again, and the
 *   copy left behind is queued as `moved`, held for this move, with the backup
 *   copy it had.
 */
export async function flipObjectStore(input: {
    object: { id: string; workspaceId: string; objectKey: string };
    fromStoreId: string;
    toStoreId: string;
    moveId: string;
    copiedSince: DatabaseInstant | null;
}): Promise<ObjectFlip> {
    const { object, fromStoreId, toStoreId, copiedSince } = input;
    if (fromStoreId === toStoreId) throw new Error('A flip needs two stores.');
    return db.transaction(async (tx): Promise<ObjectFlip> => {
        const stray = async () => {
            if (copiedSince === null) return;
            await queueCopy(tx, {
                objectId: object.id,
                workspaceId: object.workspaceId,
                objectKey: object.objectKey,
                storeId: toStoreId,
                reason: 'stray',
                published: false,
                backupStoreId: null,
            });
        };
        const [current] = await tx
            .select({
                storeId: driveObjects.storeId,
                status: driveObjects.status,
                replicatedAt: driveObjects.replicatedAt,
                backupStoreId: driveObjects.backupStoreId,
            })
            .from(driveObjects)
            .where(eq(driveObjects.id, object.id))
            .for('update');
        if (!current) {
            await stray();
            return { status: 'gone' };
        }
        if (current.storeId === toStoreId) return { status: 'already' };
        if (current.storeId !== fromStoreId) {
            await stray();
            return { status: 'elsewhere' };
        }
        // Only an object that is whole where its row says moves. A pending one is an upload
        // still in flight, which finishes where it began and is copied once it is ready; a
        // missing one has no bytes to have been copied, and stays where the audit left it.
        if (current.status !== 'ready') {
            await stray();
            return { status: 'not-ready' };
        }

        const target = { objectId: object.id, storeId: toStoreId };
        const [found] = await tx
            .select({
                row: driveObjectDeletions,
                // Compared in the database, at its own precision.
                deletedSinceCopy:
                    copiedSince === null
                        ? sql<boolean>`false`
                        : sql<boolean>`coalesce(${driveObjectDeletions.primaryDeletedAt} >= ${copiedSince}::timestamptz, false)`,
            })
            .from(driveObjectDeletions)
            .where(rowIs(target))
            .for('update');
        const queued = found?.row;
        const deletedSinceCopy = found?.deletedSinceCopy ?? false;
        let reused = false;
        if (!queued || queued.doneAt) {
            if (copiedSince === null || deletedSinceCopy) return { status: 'copy-needed' };
        } else if (queued.reason === 'purged') {
            // A purge of this very object is queued there. Nothing may live on that copy.
            return { status: 'copy-needed' };
        } else if (queued.primaryDeletedAt === null) {
            await tx.delete(driveObjectDeletions).where(rowIs(target));
            reused = copiedSince === null;
        } else {
            if (copiedSince === null || deletedSinceCopy) return { status: 'copy-needed' };
            await tx
                .update(driveObjectDeletions)
                .set({ doneAt: new Date(), deleteReplicaAfter: null })
                .where(rowIs(target));
        }

        await tx
            .update(driveObjects)
            .set({
                storeId: toStoreId,
                replicatedAt: null,
                backupStoreId: null,
                storageClass: 'standard',
                copyFailures: 0,
            })
            .where(eq(driveObjects.id, object.id));
        await queueCopy(tx, {
            objectId: object.id,
            workspaceId: object.workspaceId,
            objectKey: object.objectKey,
            storeId: fromStoreId,
            reason: 'moved',
            published: current.status === 'ready',
            backupStoreId: backupOfMark({
                backedUp: current.replicatedAt !== null,
                backupStoreId: current.backupStoreId,
            }),
            heldByMove: input.moveId,
        });
        return { status: 'flipped', reused };
    });
}

/*
 * A move is done: the copies it left behind stop waiting for it and wait for
 * `notBefore` instead, which is how long an old copy is kept. A move that is
 * blocked or incomplete never calls this, so nothing of it is ever deleted.
 * Returns how many rows were released.
 */
export async function releaseMoveHolds(moveId: string, notBefore: Date) {
    const rows = await db
        .update(driveObjectDeletions)
        .set({ heldByMove: null, notBefore })
        .where(
            and(eq(driveObjectDeletions.heldByMove, moveId), isNull(driveObjectDeletions.doneAt)),
        )
        .returning({ id: driveObjectDeletions.objectId });
    return rows.length;
}
