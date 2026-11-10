import {
    ENVIRONMENT_PRIMARY_STORE_ID,
    driveRepository,
    groupsRepository,
    reportsRepository,
    storesRepository,
} from '@hushos/db';
import { log, sanitizeFailure } from '@hushos/logging';
import { TOMBSTONE_DAYS, TRASH_RETENTION_DAYS } from './protocol';
import type { ObjectStore } from './storage';

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
};

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
 */
export async function expireUploads({ open }: Stores, limit = 200) {
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
    for (const row of rows) await resolve(row).catch(() => failed++);
    return { examined: rows.length, aborted, finalised, skipped, failed };
}

/* What the outbox may ask of the stores, and do there, while it holds a row's lock. */
function copyStore({
    open,
    backups,
}: Stores): Parameters<typeof driveRepository.removeQueuedCopy>[1] {
    return {
        backupOf: (storeId) =>
            backups.find((pair) => pair.storeId === storeId)?.backupStoreId ?? null,
        keepsBackup: (storeId) => backups.some((pair) => pair.backupStoreId === storeId),
        present: async (storeId, objectKey, size) => {
            const head = await (await open(storeId)).head(objectKey);
            return head !== null && BigInt(head.size) === size;
        },
        exists: async (storeId, objectKey) =>
            (await (await open(storeId)).head(objectKey)) !== null,
        remove: async (storeId, objectKey) => {
            await (await open(storeId)).delete(objectKey);
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
    const store = copyStore(stores);
    const counts = {
        primaries: 0,
        replicas: 0,
        waiting: 0,
        held: 0,
        attention: 0,
        left: 0,
        failed: 0,
        cleared: 0,
    };
    const failures: Failures = {};
    const failedRow = async (key: { objectId: string; storeId: string }, error: unknown) => {
        counts.failed++;
        tally(failures, error);
        await driveRepository.recordObjectDeletionFailure(key).catch(() => undefined);
    };
    for (const row of await driveRepository.listPendingObjectDeletions(limit)) {
        const key = { objectId: row.objectId, storeId: row.storeId };
        try {
            const result = await driveRepository.removeQueuedCopy(key, store);
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
    }
    for (const row of await driveRepository.listBackupDeletionsDue(limit)) {
        const key = { objectId: row.objectId, storeId: row.storeId };
        try {
            const result = await driveRepository.removeQueuedBackupCopy(key, store);
            if (result.status === 'removed') counts.replicas++;
            else if (result.status === 'kept' && result.why === 'left') counts.left++;
        } catch (error) {
            await failedRow(key, error);
        }
    }
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
 */
export async function replicateObjects({ open, backups }: Stores, limit = 100) {
    const counts = { copied: 0, failed: 0, unmarked: 0, skipped: 0 };
    const failures: Failures = {};
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
        for (const row of await driveRepository.listUnreplicatedObjects(pair.storeId, limit)) {
            const key = { objectId: row.objectId, storeId: pair.storeId };
            try {
                await backup.copyFrom(source, row.objectKey);
                const marked = await driveRepository.markObjectReplicated({
                    ...key,
                    backupStoreId: pair.backupStoreId,
                });
                if (marked !== 'neither') {
                    counts.copied++;
                    continue;
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
        }
        counts.skipped += await driveRepository.countObjectsNotCopied(pair.storeId);
    }
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
export async function auditObjects(
    { open, backups }: Stores,
    target: 'primary' | 'replica',
    limit = 200,
) {
    if (target === 'replica' && !backups.length)
        return { examined: 0, skipped: 'no replica' as const };
    const counts = {
        examined: 0,
        present: 0,
        missing: 0,
        recovered: 0,
        replicaMissing: 0,
        failed: 0,
    };
    const failures: Failures = {};
    const kept = (storeId: string | null) =>
        storeId !== null && backups.some((pair) => pair.backupStoreId === storeId);
    const rows =
        target === 'primary'
            ? await driveRepository.listObjectsForAudit('primary', limit)
            : (
                  await Promise.all(
                      [...new Set(backups.map((pair) => pair.backupStoreId))].map((storeId) =>
                          driveRepository.listObjectsForAudit('replica', limit, storeId),
                      ),
                  )
              ).flat();
    const matches = (row: AuditRow, head: Head) =>
        head !== null && BigInt(head.size) === row.ciphertextSize;
    for (const row of rows) {
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
                    await primary!.copyFrom(backup!, row.objectKey);
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
    }
    return { ...counts, failures };
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
 * and keeps the cursor it reached; the other stores are still swept.
 */
export async function sweepOrphans(
    { open }: Stores,
    options: { pausedUntil?: Date | null; pages?: number; now?: Date } = {},
) {
    const now = options.now ?? new Date();
    if (options.pausedUntil && options.pausedUntil > now)
        return { skipped: 'paused' as const, pausedUntil: options.pausedUntil.toISOString() };
    const pages = options.pages ?? 20;
    const counts = { stores: 0, listed: 0, deleted: 0, failed: 0 };
    const failures: Failures = {};
    let completed = true;
    for (const storeId of await storesRepository.listSweepStores()) {
        counts.stores++;
        const name = orphanSweepName(storeId);
        let cursor: string | null = null;
        let exhausted = false;
        try {
            cursor = await driveRepository.getSweepCursor(name);
            const store = await open(storeId);
            for (let page = 0; page < pages; page++) {
                const result = await store.list(ORPHAN_PREFIX, cursor, 1000);
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
                cursor = result.objects.at(-1)?.key ?? cursor;
                if (!result.truncated) {
                    exhausted = true;
                    cursor = null;
                    break;
                }
            }
            await driveRepository.setSweepCursor(name, cursor);
        } catch (error) {
            counts.failed++;
            tally(failures, error);
            // Keep what this run got through, if anything can be written at all.
            if (cursor !== null)
                await driveRepository.setSweepCursor(name, cursor).catch(() => undefined);
        }
        if (!exhausted) completed = false;
    }
    return { ...counts, completed, failures };
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
    { open }: Stores,
    options: { coldClass: string | null; limit?: number },
) {
    if (!options.coldClass) return { skipped: 'no cold class' as const };
    const primary = await open(ENVIRONMENT_PRIMARY_STORE_ID);
    const limit = options.limit ?? 200;
    let cooled = 0;
    let warmed = 0;
    let failed = 0;
    const failures: Failures = {};
    // One object the store refuses to rewrite stays in its class; the others still move.
    const each = async (work: () => Promise<void>) => {
        try {
            await work();
        } catch (error) {
            failed++;
            tally(failures, error);
        }
    };
    for (const row of await driveRepository.listWarmCandidates(TIER_IDLE_DAYS, limit))
        await each(async () => {
            await primary.setStorageClass(row.objectKey, 'STANDARD');
            await driveRepository.setObjectStorageClass(row.objectId, 'standard');
            warmed++;
        });
    for (const row of await driveRepository.listTierCandidates(TIER_IDLE_DAYS, limit))
        await each(async () => {
            await primary.setStorageClass(row.objectKey, options.coldClass!);
            await driveRepository.setObjectStorageClass(row.objectId, 'cold');
            cooled++;
        });
    return { cooled, warmed, failed, failures };
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
    { open, evidence }: { open: Stores['open']; evidence: ObjectStore | null },
    limit = 20,
) {
    const counts = {
        reports: 0,
        copied: 0,
        skipped: 0,
        failed: 0,
        purged: 0,
        purgeFailed: 0,
        failures: [] as { report: string; object: string; error: string }[],
    };
    for (const report of await reportsRepository.listReportsAwaitingEvidence(limit)) {
        counts.reports++;
        if (!evidence) {
            await reportsRepository.setEvidenceStatus(report.id, 'skipped');
            counts.skipped++;
            continue;
        }
        let failed = false;
        const objects = await reportsRepository.listReportObjectsToCopy(report.id);
        const stores = await reportsRepository.storesOfReportObjects(
            objects.map((object) => object.objectId!),
        );
        for (const object of objects) {
            try {
                const storeId = stores.get(object.objectId!);
                // No row names it any more: its primary copy was deleted before this run.
                if (!storeId) throw new ObjectInNoStore();
                await evidence.copyFrom(
                    await open(storeId),
                    object.objectKey!,
                    evidenceKey(report.id, object.objectId!),
                    { verified: true },
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
        await reportsRepository.setEvidenceStatus(report.id, failed ? 'failed' : 'copied');
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
