import {
    ENVIRONMENT_PRIMARY_STORE_ID,
    ENVIRONMENT_REPLICA_STORE_ID,
    driveRepository,
    groupsRepository,
    reportsRepository,
    storesRepository,
} from '@hushos/db';
import { log, sanitizeFailure } from '@hushos/logging';
import { STORE_BOUNDS, deadline } from './bounds';
import { TOMBSTONE_DAYS, TRASH_RETENTION_DAYS } from './protocol';
import type { ObjectStore } from './storage';
import { STORE_RUN_MS, byStore, createShares, inTurn } from './turns';

export { leftForNextRun } from './turns';

/*
 * What the worker does for Drive, as plain functions over the repository and
 * the object stores. The worker wraps each in a job with logging and a
 * schedule; nothing here knows about queues. Every function is bounded per call
 * and safe to run again: a run that stops halfway leaves rows the next run
 * picks up, and no store deletion happens before the row that authorises it.
 *
 * Every loop over rows or stores survives one of them failing: the failure is
 * counted by its class, recorded on the row where the row has somewhere to
 * record it, and tried again on a later run, while the rest of the run goes on.
 *
 * Every loop is also shared between stores, and no store may hold it
 * (docs/company-storage-design.md 2.4, `turns.ts`): a run takes one item from
 * each store in turn, a store that has used its share of the run leaves the
 * rest of its work to the next one (`deferred`), and a store whose breaker is
 * open, or that keeps answering late, is left alone (`avoided`). A run that
 * deferred anything is run again at once by the worker, so a share bounds one
 * run and not how fast a healthy store's backlog drains.
 */

/* Where the evidence store keeps a reported object: by report, so one report's copies purge together. */
export function evidenceKey(reportId: string, objectId: string) {
    return `reports/${reportId}/${objectId}`;
}

/*
 * The stores a job works with. `open` gives the store a row names (an object's,
 * an upload's, an outbox row's `store_id`, a backup's), and every copy is
 * reached through it; nothing here reads "the" store. `backups` says which
 * stores this worker keeps a second copy of, and where: today one pair at most,
 * the environment's primary with the environment's replica, when the worker's
 * environment describes one. Objects at any other store have no backup until a
 * region's own exists.
 */
export type BackupPair = { storeId: string; backupStoreId: string };
export type Stores = {
    open: (storeId: string) => Promise<ObjectStore>;
    backups: BackupPair[];
    /* One store's share of one run of one job, in milliseconds (`STORAGE_STORE_RUN_SECONDS`). */
    budgetMs?: number;
    /* The one deadline every store call of one outbox row shares; a call that carries no bytes gets as long. */
    itemMs?: number;
};

/*
 * The shares of one run. Whether a store is well is its own breaker's word; a
 * store that cannot be opened has none to ask, and its items fail one by one
 * and are recorded, as they always were.
 */
function sharesFor({ open, budgetMs = STORE_RUN_MS }: Pick<Stores, 'open' | 'budgetMs'>) {
    return createShares({
        budgetMs,
        health: (storeId) =>
            open(storeId).then(
                (store) => store.health(),
                () => 'ok' as const,
            ),
    });
}

/* Runs `work` with a signal that aborts after `ms`: one deadline for every store call made with it. */
async function within<T>(ms: number, work: (signal: AbortSignal) => Promise<T>) {
    const limit = deadline(ms);
    try {
        return await work(limit.signal);
    } finally {
        limit.clear();
    }
}

/*
 * The class of a failure and nothing else: an error's message can carry a
 * store's address or its answer, and neither belongs in an event.
 */
export type Failures = Record<string, number>;
function failureClass(error: unknown) {
    const failure = sanitizeFailure(error);
    return failure?.code ?? failure?.kind ?? 'unknown';
}
function tally(failures: Failures, error: unknown) {
    const reason = failureClass(error);
    failures[reason] = (failures[reason] ?? 0) + 1;
}

/*
 * Uploads past their expiry are aborted and their reservations released. One
 * stuck completing for an hour is resolved by asking the store: an object present
 * at the reserved size is published as complete's last step would have, anything
 * else is aborted. One whose store never started its multipart upload within a
 * minute of begin is expired the same way, unless the store's answer was written
 * since it was listed, in which case it is a live upload and is left alone.
 * Each is resolved at the store its own row names.
 *
 * "The store says the object is not there" is the only answer that aborts a
 * completing upload. A store this process cannot open, or one that did not
 * answer, says nothing about the object: the row is skipped and asked about
 * again at the next run, since aborting it would retire bytes that may be
 * fully uploaded.
 *
 * The stores are served in turn and each within its share. A store's health is
 * not asked here: an expired upload holds reserved bytes, and giving them back
 * is the database's work, which must not wait for a store to get well. An open
 * breaker refuses the abort at once and costs nothing. An upload the store
 * never started asks no store at all, and waits for no turn.
 */
export async function expireUploads(stores: Stores, limit = 200) {
    const { open } = stores;
    const rows = await driveRepository.listExpiredUploads(limit);
    let aborted = 0;
    let finalised = 0;
    let skipped = 0;
    let failed = 0;
    const resolve = async (row: (typeof rows)[number]) => {
        if (row.status === 'completing' && row.objectId && row.ciphertextSize !== null) {
            // `head` answers null for an object that is not there and throws for anything else.
            const asked = await open(row.storeId)
                .then((store) => store.head(row.objectKey))
                .then(
                    (stored) => ({ stored }),
                    () => null,
                );
            if (!asked) {
                skipped++;
                return;
            }
            const { stored } = asked;
            if (stored && BigInt(stored.size) === row.ciphertextSize) {
                const result = await driveRepository.finishCompleting(
                    row.workspaceId,
                    row.id,
                    BigInt(stored.size),
                );
                if (result.status === 'published') {
                    finalised++;
                    return;
                }
            }
        }
        const result =
            row.multipartId === null
                ? await driveRepository.expireUnstartedUpload(row.workspaceId, row.id)
                : await driveRepository.abortUpload(row.workspaceId, row.id, { force: true });
        if (result.status === 'ok') {
            // The id read under the abort's lock, not the listing's: the store's answer may
            // have been written in between.
            const { multipartId, storeId, objectKey } = result.upload;
            if (!result.alreadyAborted && multipartId !== null)
                await open(storeId)
                    .then((store) => store.abortMultipart(objectKey, multipartId))
                    .catch(() => {});
            aborted++;
        }
    };
    // One upload that throws is left as it is for the next run; the others are still resolved.
    const tried = (row: (typeof rows)[number]) =>
        resolve(row).catch(() => {
            failed++;
        });
    for (const row of rows) if (row.multipartId === null) await tried(row);
    const shares = createShares({ budgetMs: stores.budgetMs ?? STORE_RUN_MS, health: () => 'ok' });
    const left = await inTurn(
        byStore(
            rows.filter((row) => row.multipartId !== null),
            (row) => row.storeId,
        ),
        shares,
        tried,
    );
    return {
        examined: rows.length,
        aborted,
        finalised,
        skipped,
        failed,
        deferred: left.deferred,
    };
}

/*
 * What the outbox may ask of the stores, and do there, while it holds a row's
 * lock. Every call of one row shares `signal`, so the row's lock and its
 * transaction are held for one deadline at most, however many stores are asked.
 */
function copyStore(
    { open, backups }: Stores,
    signal: AbortSignal,
): Parameters<typeof driveRepository.removeQueuedCopy>[1] {
    const shared = { signal };
    return {
        backupOf: (storeId) =>
            backups.find((pair) => pair.storeId === storeId)?.backupStoreId ?? null,
        keepsBackup: (storeId) => backups.some((pair) => pair.backupStoreId === storeId),
        present: async (storeId, objectKey, size) => {
            const head = await (await open(storeId)).head(objectKey, shared);
            return head !== null && BigInt(head.size) === size;
        },
        exists: async (storeId, objectKey) =>
            (await (await open(storeId)).head(objectKey, shared)) !== null,
        remove: async (storeId, objectKey) => {
            await (await open(storeId)).delete(objectKey, shared);
        },
    };
}

/*
 * Drains the deletion outbox, one copy (an object at a store) at a time, each
 * under its row's lock (docs/company-storage-design.md 8.4).
 *
 * A copy is deleted from the store its row names. Where this worker keeps a
 * backup of that store, a published object's copy waits until the backup holds
 * it; the backup copy follows after the undo window, or is left and recorded
 * where HushOS does not delete from that backup. A copy a move left behind goes
 * only once the object is seen again where its row now says it is; when it is
 * not, nothing is deleted, the row is marked for attention and the first time
 * is logged. A copy at the store its object lives at is never deleted. Rows a
 * report or a move holds are left alone.
 *
 * A row that throws (a store that is down, or that this process cannot open)
 * is counted, goes to the back of the line, and is tried again; the run goes
 * on. Finished rows older than 30 days are removed at the end.
 */
export async function deleteObjects(stores: Stores, limit = 200) {
    const itemMs = stores.itemMs ?? STORE_BOUNDS.callMs;
    const shares = sharesFor(stores);
    const counts = {
        primaries: 0,
        replicas: 0,
        waiting: 0,
        held: 0,
        attention: 0,
        left: 0,
        failed: 0,
        cleared: 0,
        avoided: 0,
        deferred: 0,
    };
    const failures: Failures = {};
    const failedRow = async (key: { objectId: string; storeId: string }, error: unknown) => {
        counts.failed++;
        tally(failures, error);
        await driveRepository.recordObjectDeletionFailure(key).catch(() => undefined);
    };
    const leftBy = (left: { avoided: number; deferred: number }) => {
        counts.avoided += left.avoided;
        counts.deferred += left.deferred;
    };
    leftBy(
        await inTurn(
            byStore(await driveRepository.listPendingObjectDeletions(limit), (row) => row.storeId),
            shares,
            async (row) => {
                const key = { objectId: row.objectId, storeId: row.storeId };
                try {
                    const result = await within(itemMs, (signal) =>
                        driveRepository.removeQueuedCopy(key, copyStore(stores, signal)),
                    );
                    if (result.status === 'removed') {
                        counts.primaries++;
                        if (result.backup === 'left') counts.left++;
                    } else if (result.status === 'waiting') counts.waiting++;
                    else if (result.status === 'held') counts.held++;
                    else if (result.status === 'attention') {
                        counts.attention++;
                        // Once, when the row is first marked: ids and the class of reason, nothing of the store's.
                        if (result.first)
                            log.error({
                                message:
                                    'An old copy was not deleted: the object could not be confirmed where its row says it is',
                                schema: 'drive',
                                objectId: row.objectId,
                                storeId: row.storeId,
                                reason: result.why,
                            });
                    }
                } catch (error) {
                    await failedRow(key, error);
                }
            },
        ),
    );
    leftBy(
        await inTurn(
            // The call goes to the backup store: that is whose turn and share it is.
            byStore(
                await driveRepository.listBackupDeletionsDue(limit),
                (row) => row.backupStoreId ?? ENVIRONMENT_REPLICA_STORE_ID,
            ),
            shares,
            async (row) => {
                const key = { objectId: row.objectId, storeId: row.storeId };
                try {
                    const result = await within(itemMs, (signal) =>
                        driveRepository.removeQueuedBackupCopy(key, copyStore(stores, signal)),
                    );
                    if (result.status === 'removed') counts.replicas++;
                    else if (result.status === 'kept' && result.why === 'left') counts.left++;
                } catch (error) {
                    await failedRow(key, error);
                }
            },
        ),
    );
    try {
        counts.cleared = await driveRepository.deleteFinishedObjectDeletions();
    } catch (error) {
        counts.failed++;
        tally(failures, error);
    }
    return { ...counts, failures };
}

/*
 * Copies what each backup this worker keeps does not hold yet, from the store
 * that backup serves and from no other. Objects are immutable, so a retry is
 * harmless.
 *
 * The mark is a compare-and-set: it lands on the object's row only while the
 * object is still at the store the copy was read from, else on the outbox row
 * of the copy a purge or a move has since queued, so the backup copy goes with
 * it. A copy nothing accounts for is removed from the backup again.
 *
 * One object that fails to copy is counted on its row and tried again later,
 * after the ones that have failed less; the run goes on. After ten failures in
 * a row an object is left alone, and counted here as `skipped`.
 *
 * Every read is bounded by the size on the object's row; the source must say
 * the same before a byte is read. With more than one backup, one copy is made
 * for each pair in turn.
 */
export async function replicateObjects(stores: Stores, limit = 100) {
    const { open, backups } = stores;
    const counts = { copied: 0, failed: 0, unmarked: 0, skipped: 0, avoided: 0, deferred: 0 };
    const failures: Failures = {};
    const served: BackupPair[] = [];
    const groups: { stores: string[]; items: (() => Promise<void>)[] }[] = [];
    for (const pair of backups) {
        let backup: ObjectStore;
        let source: ObjectStore;
        try {
            backup = await open(pair.backupStoreId);
            source = await open(pair.storeId);
        } catch (error) {
            counts.failed++;
            tally(failures, error);
            continue;
        }
        served.push(pair);
        const rows = await driveRepository.listUnreplicatedObjects(pair.storeId, limit);
        groups.push({
            // A copy calls both: either one unwell, or out of its share, ends the pair's run.
            stores: [pair.storeId, pair.backupStoreId],
            items: rows.map((row) => async () => {
                const key = { objectId: row.objectId, storeId: pair.storeId };
                try {
                    await backup.copyFrom(source, row.objectKey, row.objectKey, {
                        size: row.ciphertextSize,
                    });
                    const marked = await driveRepository.markObjectReplicated({
                        ...key,
                        backupStoreId: pair.backupStoreId,
                    });
                    if (marked !== 'neither') {
                        counts.copied++;
                        return;
                    }
                    // The object left that store and nothing queued its copy there: the copy just
                    // made belongs to nobody, unless a row does name this backup for that key.
                    counts.unmarked++;
                    const known = await driveRepository.knownObjectKeys(pair.backupStoreId, [
                        row.objectKey,
                    ]);
                    if (!known.has(row.objectKey)) await backup.delete(row.objectKey);
                } catch (error) {
                    counts.failed++;
                    tally(failures, error);
                    await driveRepository.recordObjectCopyFailure(key).catch(() => undefined);
                }
            }),
        });
    }
    const left = await inTurn(groups, sharesFor(stores), (copy) => copy());
    counts.avoided = left.avoided;
    counts.deferred = left.deferred;
    for (const pair of served)
        counts.skipped += await driveRepository.countObjectsNotCopied(pair.storeId);
    return { ...counts, failures };
}

/*
 * The purge sweep: trash roots past retention, then the fan-out under every
 * purged node until it is exhausted, superseded versions past retention,
 * tombstones past their window, and family folders deleted longer ago than
 * the trash keeps things. Each part is bounded per pass.
 */
export async function purgeDue(options: { passes?: number } = {}) {
    const passes = options.passes ?? 20;
    const trash = await driveRepository.purgeExpiredTrash(TRASH_RETENTION_DAYS);
    let descendants = 0;
    for (let pass = 0; pass < passes; pass++) {
        const purged = await driveRepository.purgeDescendants(1000);
        descendants += purged;
        if (!purged) break;
    }
    const versions = await driveRepository.purgeExpiredSupersededVersions(TRASH_RETENTION_DAYS);
    let tombstones = 0;
    for (let pass = 0; pass < passes; pass++) {
        const deleted = await driveRepository.deleteExpiredTombstones(TOMBSTONE_DAYS);
        tombstones += deleted;
        if (!deleted) break;
    }
    // Deleted family folders go whole after the same retention as the trash (groups design 2.10).
    const areas = await groupsRepository.purgeDeletedAreas(TRASH_RETENTION_DAYS);
    return { trash, descendants, versions, tombstones, areas };
}

/* Accounting drift, for the log. */
export async function auditUsage(sample = 50) {
    return driveRepository.auditUsage(sample);
}

/* ------------------------------------------------------------------------- */
/* Audit, the orphan sweep, and tiering                                       */
/* ------------------------------------------------------------------------- */

export const TIER_IDLE_DAYS = 90;
export const ORPHAN_MIN_AGE_DAYS = 7;
export const ORPHAN_PREFIX = 'ws/';

type Head = { size: number } | null;
type AuditRow = { ciphertextSize: bigint };

/*
 * What one audited object turns out to be. The primary audit asks the primary,
 * and the replica when the primary is wrong, so a lost primary copy is
 * recovered rather than reported. The replica audit asks only the replica.
 * A copy of the wrong size counts as absent: the bytes are ciphertext framed by
 * size, and a truncated object would fail to decrypt.
 */
export function judgeObject(
    target: 'primary' | 'replica',
    row: AuditRow,
    heads: { primary: Head; replica: Head },
): 'present' | 'missing' | 'recoverable' | 'replica-missing' {
    const matches = (head: Head) => head !== null && BigInt(head.size) === row.ciphertextSize;
    if (target === 'replica') return matches(heads.replica) ? 'present' : 'replica-missing';
    if (matches(heads.primary)) return 'present';
    return matches(heads.replica) ? 'recoverable' : 'missing';
}

/*
 * Confirms a page of objects, each at the store its row names, or the copies a
 * backup this worker keeps is marked as holding. Every miss is recorded, so the
 * UI can say a file is unavailable instead of failing to decrypt, and a primary
 * copy its backup still holds is copied back to the store the row names. A
 * lost object is looked for only in the backup its own mark names.
 *
 * A store that does not answer says nothing about an object: that row is
 * counted as failed and left as it was, and the rest of the page is still
 * confirmed.
 */
export async function auditObjects(stores: Stores, target: 'primary' | 'replica', limit = 200) {
    const { open, backups } = stores;
    if (target === 'replica' && !backups.length)
        return { examined: 0, skipped: 'no replica' as const };
    const counts = {
        examined: 0,
        present: 0,
        missing: 0,
        recovered: 0,
        replicaMissing: 0,
        failed: 0,
        avoided: 0,
        deferred: 0,
    };
    const failures: Failures = {};
    const kept = (storeId: string | null) =>
        storeId !== null && backups.some((pair) => pair.backupStoreId === storeId);
    // A page of each store's own: the primary audit of every store that holds objects, the
    // replica audit of every backup this worker keeps. The store that is asked is the group's.
    const asked =
        target === 'primary'
            ? await storesRepository.listStoresHoldingObjects()
            : [...new Set(backups.map((pair) => pair.backupStoreId))];
    const groups = await Promise.all(
        asked.map(async (storeId) => ({
            stores: [storeId],
            items: await driveRepository.listObjectsForAudit(target, limit, storeId),
        })),
    );
    const matches = (row: AuditRow, head: Head) =>
        head !== null && BigInt(head.size) === row.ciphertextSize;
    const left = await inTurn(groups, sharesFor(stores), async (row) => {
        counts.examined++;
        try {
            const primary = target === 'primary' ? await open(row.storeId) : null;
            const backup = kept(row.backupStoreId) ? await open(row.backupStoreId!) : null;
            const heads = {
                primary: primary ? await primary.head(row.objectKey) : null,
                replica: null as Head,
            };
            // The replica audit must hear from the backup itself; a lookup for a lost primary
            // copy that gets no answer finds nothing.
            if (backup && target === 'replica') heads.replica = await backup.head(row.objectKey);
            else if (backup && !matches(row, heads.primary))
                heads.replica = await backup.head(row.objectKey).catch(() => null);
            const verdict = judgeObject(target, row, heads);
            switch (verdict) {
                case 'present':
                    counts.present++;
                    await driveRepository.recordObjectAudit(row.objectId, 'present');
                    break;
                case 'missing':
                    counts.missing++;
                    await driveRepository.recordObjectAudit(row.objectId, 'missing');
                    break;
                case 'recoverable':
                    await primary!.copyFrom(backup!, row.objectKey, row.objectKey, {
                        size: row.ciphertextSize,
                    });
                    counts.recovered++;
                    await driveRepository.recordObjectAudit(row.objectId, 'recovered');
                    break;
                case 'replica-missing':
                    counts.replicaMissing++;
                    await driveRepository.recordObjectAudit(row.objectId, 'replica-missing');
                    break;
            }
        } catch (error) {
            counts.failed++;
            tally(failures, error);
        }
    });
    return { ...counts, ...left, failures };
}

type Listed = { key: string; modifiedAt: Date | null };

/*
 * The keys in a listing that nothing names and that are old enough to be sure
 * of it. A key no row names may be an upload whose complete is in flight, so
 * anything younger than the age bound waits for the next pass, and a key with
 * no timestamp is never touched.
 */
export function selectOrphans(listed: Listed[], known: Set<string>, now: Date, minAgeDays: number) {
    const cutoff = now.getTime() - minAgeDays * 24 * 3600 * 1000;
    return listed.filter(
        (entry) =>
            !known.has(entry.key) &&
            entry.modifiedAt !== null &&
            entry.modifiedAt.getTime() < cutoff,
    );
}

/* A sweep's cursor is its store's own (`drive_sweeps.name`). */
export function orphanSweepName(storeId: string) {
    return `orphans/${storeId}`;
}

/*
 * A rolling sweep of every region's store, one after the other: a bounded
 * number of pages of each bucket per run, continuing from where that store's
 * last run stopped and starting over when its listing is exhausted. Paused
 * after a database restore until the operator says the restored database is
 * complete.
 *
 * A key is deleted from the store it was listed at, and only when nothing
 * accounts for it there ("known at this store", 8.4): no object row names that
 * store as where the object or its backup is, and no unfinished outbox row is
 * for that key and that store. A row that names another store does not make a
 * copy here known: a leftover copy is an orphan wherever its object lives, and
 * the object's own copy, at its own store, is never touched by a sweep of
 * this one.
 *
 * A store this worker cannot open, or one that fails mid-listing, is counted
 * and keeps the cursor it reached; the other stores are still swept. So is one
 * that is unwell or has used its share of the run.
 */
export async function sweepOrphans(
    stores: Stores,
    options: { pausedUntil?: Date | null; pages?: number; now?: Date } = {},
) {
    const { open } = stores;
    const now = options.now ?? new Date();
    if (options.pausedUntil && options.pausedUntil > now)
        return { skipped: 'paused' as const, pausedUntil: options.pausedUntil.toISOString() };
    const pages = options.pages ?? 20;
    // `avoided` and `deferred` count stores here, not pages: the ones a round found unwell
    // or out of their share before their listing was exhausted.
    const counts = { stores: 0, listed: 0, deleted: 0, failed: 0, avoided: 0, deferred: 0 };
    const failures: Failures = {};
    const shares = sharesFor(stores);
    type Sweep = {
        storeId: string;
        name: string;
        store: ObjectStore | null;
        cursor: string | null;
        exhausted: boolean;
        stopped: boolean;
    };
    /* One page of one store's listing; the cursor is kept after every page that got through. */
    const page = async (sweep: Sweep) => {
        try {
            if (!sweep.store) {
                sweep.cursor = await driveRepository.getSweepCursor(sweep.name);
                sweep.store = await open(sweep.storeId);
            }
            const { store, storeId } = sweep;
            const result = await store.list(ORPHAN_PREFIX, sweep.cursor, 1000);
            counts.listed += result.objects.length;
            const known = await driveRepository.knownObjectKeys(
                storeId,
                result.objects.map((o) => o.key),
            );
            for (const orphan of selectOrphans(result.objects, known, now, ORPHAN_MIN_AGE_DAYS))
                try {
                    await store.delete(orphan.key);
                    counts.deleted++;
                } catch (error) {
                    // Still there, and still an orphan the next time round.
                    counts.failed++;
                    tally(failures, error);
                }
            sweep.cursor = result.objects.at(-1)?.key ?? sweep.cursor;
            if (!result.truncated) {
                sweep.exhausted = true;
                sweep.stopped = true;
                sweep.cursor = null;
            }
            await driveRepository.setSweepCursor(sweep.name, sweep.cursor);
        } catch (error) {
            // The store keeps the cursor of the last page that got through.
            counts.failed++;
            tally(failures, error);
            sweep.stopped = true;
        }
    };
    const sweeps: Sweep[] = (await storesRepository.listSweepStores()).map((storeId) => ({
        storeId,
        name: orphanSweepName(storeId),
        store: null,
        cursor: null,
        exhausted: false,
        stopped: false,
    }));
    counts.stores = sweeps.length;
    // A page of each store in turn, up to `pages` of each.
    let waiting = sweeps;
    for (let round = 0; round < pages && waiting.length; round++) {
        const next: Sweep[] = [];
        for (const sweep of waiting) {
            const state = await shares.state([sweep.storeId]);
            if (state !== 'ok') {
                counts[state]++;
                continue;
            }
            await shares.spend([sweep.storeId], () => page(sweep));
            if (!sweep.stopped) next.push(sweep);
        }
        waiting = next;
    }
    return {
        ...counts,
        completed: sweeps.every((sweep) => sweep.exhausted),
        failures,
    };
}

/*
 * Moves objects nobody has read in a season to the provider's cheaper class,
 * and brings back the ones read since they went cold; both are a rewrite in
 * place at the store and a column here. Without a configured class it does
 * nothing, which is the case on Garage and B2 today. The class is the
 * environment's (`STORAGE_COLD_CLASS`), so only objects in the environment's
 * primary store are candidates.
 */
export async function tierObjects(
    stores: Stores,
    options: { coldClass: string | null; limit?: number },
) {
    if (!options.coldClass) return { skipped: 'no cold class' as const };
    const primary = await stores.open(ENVIRONMENT_PRIMARY_STORE_ID);
    const limit = options.limit ?? 200;
    let cooled = 0;
    let warmed = 0;
    let failed = 0;
    const failures: Failures = {};
    const rewrites = [
        ...(await driveRepository.listWarmCandidates(TIER_IDLE_DAYS, limit)).map(
            (row) => async () => {
                await primary.setStorageClass(row.objectKey, 'STANDARD', {
                    size: Number(row.ciphertextSize),
                });
                await driveRepository.setObjectStorageClass(row.objectId, 'standard');
                warmed++;
            },
        ),
        ...(await driveRepository.listTierCandidates(TIER_IDLE_DAYS, limit)).map(
            (row) => async () => {
                await primary.setStorageClass(row.objectKey, options.coldClass!, {
                    size: Number(row.ciphertextSize),
                });
                await driveRepository.setObjectStorageClass(row.objectId, 'cold');
                cooled++;
            },
        ),
    ];
    // One store, so no turns to take: its share of the run and its health still hold.
    const left = await inTurn(
        [{ stores: [ENVIRONMENT_PRIMARY_STORE_ID], items: rewrites }],
        sharesFor(stores),
        async (rewrite) => {
            // One object the store refuses to rewrite stays in its class; the others still move.
            try {
                await rewrite();
            } catch (error) {
                failed++;
                tally(failures, error);
            }
        },
    );
    return { cooled, warmed, failed, ...left, failures };
}

/* ------------------------------------------------------------------------- */
/* Evidence                                                                   */
/* ------------------------------------------------------------------------- */

/*
 * Copies what each new report names into the evidence store, by report, and
 * deletes the copies of released reports, however they closed; a released
 * report is never copied, and one released mid-copy is purged on the same or
 * the next run. Without an evidence store every new report is marked skipped
 * and the hold on the primary bucket is the only preservation. A copy that
 * fails leaves the report failed for the operator to see, with the class of the
 * reason in the run's log; the next run tries the remaining objects again. The copy is
 * verified: the store checks the digest. Each object is read from the store
 * that holds its primary copy: the one its row names or, once purged, its
 * outbox row.
 */
class ObjectInNoStore extends Error {
    override name = 'ObjectInNoStore';
    constructor() {
        super('The reported object is no longer in any store.');
    }
}

export async function copyEvidence(
    {
        open,
        evidence,
        budgetMs,
    }: { open: Stores['open']; evidence: ObjectStore | null; budgetMs?: number },
    limit = 20,
) {
    const counts = {
        reports: 0,
        copied: 0,
        skipped: 0,
        failed: 0,
        avoided: 0,
        deferred: 0,
        purged: 0,
        purgeFailed: 0,
        failures: [] as { report: string; object: string; error: string }[],
    };
    // The share is the store's a reported object is read from. The evidence store is the
    // operator's own and every copy lands there: it has no share to keep to, only its health.
    const shares = sharesFor({ open, budgetMs });
    for (const report of await reportsRepository.listReportsAwaitingEvidence(limit)) {
        counts.reports++;
        if (!evidence) {
            await reportsRepository.setEvidenceStatus(report.id, 'skipped');
            counts.skipped++;
            continue;
        }
        let failed = false;
        let untried = false;
        const objects = await reportsRepository.listReportObjectsToCopy(report.id);
        const stores = await reportsRepository.storesOfReportObjects(
            objects.map((object) => object.objectId!),
        );
        for (const object of objects) {
            const storeId = stores.get(object.objectId!);
            const state =
                evidence.health() !== 'ok'
                    ? 'avoided'
                    : storeId
                      ? await shares.state([storeId])
                      : 'ok';
            if (state !== 'ok') {
                counts[state]++;
                untried = true;
                continue;
            }
            try {
                // No row names it any more: its primary copy was deleted before this run.
                if (!storeId) throw new ObjectInNoStore();
                await shares.spend([storeId], async () =>
                    evidence.copyFrom(
                        await open(storeId),
                        object.objectKey!,
                        evidenceKey(report.id, object.objectId!),
                        // The size the report's snapshot took from the version's row.
                        { size: object.ciphertextSize, verified: true },
                    ),
                );
                await reportsRepository.markReportItemCopied(report.id, object.nodeId);
                counts.copied++;
            } catch (error) {
                failed = true;
                counts.failed++;
                if (counts.failures.length < 5)
                    counts.failures.push({
                        report: report.id,
                        object: object.objectId!,
                        // The class only: a store's error message can carry its address.
                        error: failureClass(error),
                    });
            }
        }
        // A report with objects this run did not try keeps its status and comes round again.
        if (failed) await reportsRepository.setEvidenceStatus(report.id, 'failed');
        else if (!untried) await reportsRepository.setEvidenceStatus(report.id, 'copied');
    }
    if (evidence)
        for (const report of await reportsRepository.listReportsForEvidencePurge(limit))
            // One report whose copies cannot be deleted now is tried again; the others still go.
            try {
                for (const object of await reportsRepository.listReportObjectsCopied(report.id))
                    await evidence.delete(evidenceKey(report.id, object.objectId!));
                await reportsRepository.clearReportItemCopies(report.id);
                await reportsRepository.setEvidenceStatus(report.id, 'purged');
                counts.purged++;
            } catch {
                counts.purgeFailed++;
            }
    return counts;
}

/*
 * Answers operators' requests for the evidence copies: a presigned GET per
 * copied object, fifteen minutes, keyed by version so the page can read them
 * where it would read the primary copy. Requests of released reports are
 * neither listed nor answered. Runs for most of a minute polling the
 * table, so the operator waits seconds, not the schedule. Without an evidence
 * store every request fails with the reason.
 */
export const EVIDENCE_URL_TTL_SECONDS = 15 * 60;
export async function answerEvidenceRequests(
    { evidence }: { evidence: ObjectStore | null },
    options: { until?: number; pollMs?: number } = {},
) {
    const until = options.until ?? Date.now() + 50_000;
    const pollMs = options.pollMs ?? 2_000;
    const counts = { answered: 0, failed: 0, expired: 0 };
    counts.expired = await reportsRepository.deleteStaleEvidenceRequests();
    for (;;) {
        const pending = await reportsRepository.listPendingEvidenceRequests();
        for (const request of pending) {
            if (!evidence) {
                await reportsRepository.answerEvidenceRequest(request.id, {
                    status: 'failed',
                    error: 'No evidence store is configured on this instance.',
                });
                counts.failed++;
                continue;
            }
            try {
                const urls: Record<string, string> = {};
                for (const object of await reportsRepository.listReportObjectsCopied(
                    request.reportId,
                ))
                    if (object.versionId)
                        urls[object.versionId] = await evidence.presignGet(
                            evidenceKey(request.reportId, object.objectId!),
                            EVIDENCE_URL_TTL_SECONDS,
                        );
                await reportsRepository.answerEvidenceRequest(request.id, {
                    status: 'ready',
                    urls,
                    urlExpiresAt: new Date(Date.now() + EVIDENCE_URL_TTL_SECONDS * 1000),
                });
                counts.answered++;
            } catch (error) {
                await reportsRepository.answerEvidenceRequest(request.id, {
                    status: 'failed',
                    // Shown to the operator who asked: a class, never the store's own words.
                    error: `The evidence store could not sign the links (${failureClass(error)}).`,
                });
                counts.failed++;
            }
        }
        if (Date.now() >= until) break;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return counts;
}
