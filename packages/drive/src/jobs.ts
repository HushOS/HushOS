import {
    ENVIRONMENT_PRIMARY_STORE_ID,
    driveRepository,
    groupsRepository,
    reportsRepository,
} from '@hushos/db';
import { TOMBSTONE_DAYS, TRASH_RETENTION_DAYS } from './protocol';
import type { ObjectStore } from './storage';

/*
 * What the worker does for Drive, as plain functions over the repository and
 * the object stores. The worker wraps each in a job with logging and a
 * schedule; nothing here knows about queues. Every function is bounded per call
 * and safe to run again: a run that stops halfway leaves rows the next run
 * picks up, and no store deletion happens before the row that authorises it.
 */

export const REPLICA_UNDO_DAYS = 30;

/* Where the evidence store keeps a reported object: by report, so one report's copies purge together. */
export function evidenceKey(reportId: string, objectId: string) {
    return `reports/${reportId}/${objectId}`;
}

/*
 * The stores a job works with. `open` gives the store a row names (an object's,
 * an upload's, an outbox row's `store_id`), and every primary copy is reached
 * through it; nothing here reads "the" store. `replica` is the environment's
 * replica, the default region's backup, or null without one.
 */
export type Stores = {
    open: (storeId: string) => Promise<ObjectStore>;
    replica: ObjectStore | null;
};

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
    for (const row of rows) {
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
                continue;
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
                    continue;
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
    }
    return { examined: rows.length, aborted, finalised, skipped };
}

/*
 * Drains the deletion outbox. With a replica configured, a published object's
 * primary copy waits until the replica holds it, then goes; the replica copy
 * follows after the undo window. Without a replica the primary goes at once.
 * An object that was never published waits for nothing. The primary copy is
 * deleted from the store the outbox row names, which is where the object's row
 * said it was when it was retired.
 */
export async function deleteObjects({ open, replica }: Stores, limit = 200) {
    let primaries = 0;
    let replicas = 0;
    let waiting = 0;
    for (const row of await driveRepository.listPendingObjectDeletions(limit)) {
        const keepReplicaCopy = replica !== null && row.published;
        if (keepReplicaCopy && !row.replicated) {
            waiting++;
            continue;
        }
        await (await open(row.storeId)).delete(row.objectKey);
        await driveRepository.markPrimaryDeleted(
            row.objectId,
            keepReplicaCopy ? new Date(Date.now() + REPLICA_UNDO_DAYS * 24 * 3600 * 1000) : null,
        );
        primaries++;
    }
    if (replica)
        for (const row of await driveRepository.listReplicaDeletionsDue(limit)) {
            await replica.delete(row.objectKey);
            await driveRepository.markObjectDeletionDone(row.objectId);
            replicas++;
        }
    return { primaries, replicas, waiting };
}

/*
 * Copies objects the replica does not hold yet, each from the store its row
 * names. Objects are immutable, so a retry is harmless.
 */
export async function replicateObjects({ open, replica }: Stores, limit = 100) {
    if (!replica) return { copied: 0 };
    let copied = 0;
    for (const row of await driveRepository.listUnreplicatedObjects(limit)) {
        await replica.copyFrom(await open(row.storeId), row.objectKey);
        await driveRepository.markObjectReplicated(row.objectId);
        copied++;
    }
    return { copied };
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
 * Confirms a page of objects, each at the store its row names (or at the
 * replica). Every miss is recorded, so the UI can say a file is unavailable
 * instead of failing to decrypt, and a primary copy the replica still holds is
 * copied back to the store the row names.
 */
export async function auditObjects(
    { open, replica }: Stores,
    target: 'primary' | 'replica',
    limit = 200,
) {
    if (target === 'replica' && !replica) return { examined: 0, skipped: 'no replica' as const };
    const counts = { examined: 0, present: 0, missing: 0, recovered: 0, replicaMissing: 0 };
    for (const row of await driveRepository.listObjectsForAudit(target, limit)) {
        counts.examined++;
        const primary = target === 'primary' ? await open(row.storeId) : null;
        const heads = {
            primary: primary ? await primary.head(row.objectKey) : null,
            replica: null as Head,
        };
        if (replica && (target === 'replica' || heads.primary === null))
            heads.replica = await replica.head(row.objectKey).catch(() => null);
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
                await primary!.copyFrom(replica!, row.objectKey);
                counts.recovered++;
                await driveRepository.recordObjectAudit(row.objectId, 'recovered');
                break;
            case 'replica-missing':
                counts.replicaMissing++;
                await driveRepository.recordObjectAudit(row.objectId, 'replica-missing');
                break;
        }
    }
    return counts;
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

/*
 * A rolling sweep of the environment's primary bucket: a bounded number of
 * pages per run, continuing from where the last run stopped and starting over
 * when the listing is exhausted. Paused after a database restore until the
 * operator says the restored database is complete. It walks that one bucket
 * and no other: it is the only store that holds objects, and a key counts as
 * known when any row names it.
 */
export async function sweepOrphans(
    { open }: Stores,
    options: { pausedUntil?: Date | null; pages?: number; now?: Date } = {},
) {
    const now = options.now ?? new Date();
    if (options.pausedUntil && options.pausedUntil > now)
        return { skipped: 'paused' as const, pausedUntil: options.pausedUntil.toISOString() };
    const primary = await open(ENVIRONMENT_PRIMARY_STORE_ID);
    const pages = options.pages ?? 20;
    let cursor = await driveRepository.getSweepCursor('orphans');
    let listed = 0;
    let deleted = 0;
    let completed = false;
    for (let page = 0; page < pages; page++) {
        const result = await primary.list(ORPHAN_PREFIX, cursor, 1000);
        listed += result.objects.length;
        const known = await driveRepository.knownObjectKeys(result.objects.map((o) => o.key));
        for (const orphan of selectOrphans(result.objects, known, now, ORPHAN_MIN_AGE_DAYS)) {
            await primary.delete(orphan.key);
            deleted++;
        }
        cursor = result.objects.at(-1)?.key ?? cursor;
        if (!result.truncated) {
            completed = true;
            cursor = null;
            break;
        }
    }
    await driveRepository.setSweepCursor('orphans', cursor);
    return { listed, deleted, completed };
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
    for (const row of await driveRepository.listWarmCandidates(TIER_IDLE_DAYS, limit)) {
        await primary.setStorageClass(row.objectKey, 'STANDARD');
        await driveRepository.setObjectStorageClass(row.objectId, 'standard');
        warmed++;
    }
    for (const row of await driveRepository.listTierCandidates(TIER_IDLE_DAYS, limit)) {
        await primary.setStorageClass(row.objectKey, options.coldClass);
        await driveRepository.setObjectStorageClass(row.objectId, 'cold');
        cooled++;
    }
    return { cooled, warmed };
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
 * fails leaves the report failed for the operator to see, with the reason in
 * the run's log; the next run tries the remaining objects again. The copy is
 * verified: the store checks the digest. Each object is read from the store
 * that holds its primary copy: the one its row names or, once purged, its
 * outbox row.
 */
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
                if (!storeId) throw new Error('The reported object is no longer in any store.');
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
                        error:
                            error instanceof Error
                                ? `${error.name}: ${error.message}`
                                : String(error),
                    });
            }
        }
        await reportsRepository.setEvidenceStatus(report.id, failed ? 'failed' : 'copied');
    }
    if (evidence)
        for (const report of await reportsRepository.listReportsForEvidencePurge(limit)) {
            for (const object of await reportsRepository.listReportObjectsCopied(report.id))
                await evidence.delete(evidenceKey(report.id, object.objectId!));
            await reportsRepository.clearReportItemCopies(report.id);
            await reportsRepository.setEvidenceStatus(report.id, 'purged');
            counts.purged++;
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
                    error: error instanceof Error ? error.message : 'The store refused.',
                });
                counts.failed++;
            }
        }
        if (Date.now() >= until) break;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return counts;
}
