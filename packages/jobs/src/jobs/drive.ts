import {
    answerEvidenceRequests,
    auditObjects,
    auditUsage,
    copyEvidence,
    deleteObjects,
    expireUploads,
    leftForNextRun,
    purgeDue,
    replicateObjects,
    sweepOrphans,
    tierObjects,
    type Stores,
} from '@hushos/drive/jobs';
import { ENVIRONMENT_PRIMARY_STORE_ID, ENVIRONMENT_REPLICA_STORE_ID } from '@hushos/db';
import { evidenceStore, replicaStore, storeFor } from '@hushos/drive/storage';
import { storageEnv } from '@hushos/env/storage';
import { createLogger, sanitizeFailure } from '@hushos/logging';
import type { Job } from 'pg-boss';

/*
 * Drive's background work, each job one wide event: what it examined, what it
 * did, how long it took, and what failed by class. Every copy is reached
 * through the store its row names; the replica comes from the worker's
 * environment, is optional, and its absence is a fact the events carry.
 */

/*
 * The one backup this worker keeps today: the environment's replica, of the
 * environment's primary, when its own environment describes one. An object at
 * any other store is not copied there.
 */
function stores(): Stores {
    return {
        open: storeFor,
        budgetMs: storageEnv.STORAGE_STORE_RUN_SECONDS * 1000,
        backups: replicaStore()
            ? [
                  {
                      storeId: ENVIRONMENT_PRIMARY_STORE_ID,
                      backupStoreId: ENVIRONMENT_REPLICA_STORE_ID,
                  },
              ]
            : [],
    };
}

async function run<T extends Record<string, unknown>>(job: Job<unknown>, work: () => Promise<T>) {
    const event = createLogger({ job: { id: job.id, queue: job.name } });
    const started = performance.now();
    try {
        const result = await work();
        event.set({ ...result, durationMs: Math.round(performance.now() - started) });
        return result;
    } catch (error) {
        // The event redacts the error's name and cause; the failure keeps their classes and codes.
        if (error instanceof Error) event.error(error);
        event.set({ failure: sanitizeFailure(error) });
        throw error;
    } finally {
        event.emit();
    }
}

export const driveExpireUploads = (job: Job<unknown>) => run(job, () => expireUploads(stores()));
export const driveDeleteObjects = (job: Job<unknown>) => run(job, () => deleteObjects(stores()));
export const driveReplicate = (job: Job<unknown>) => run(job, () => replicateObjects(stores()));
export const drivePurge = (job: Job<unknown>) => run(job, () => purgeDue());
export const driveAuditUsage = (job: Job<unknown>) =>
    run(job, async () => {
        const drift = await auditUsage();
        return {
            drifted: drift.length,
            workspaces: drift.map((entry) => ({
                workspaceId: entry.workspaceId,
                usedBytes: entry.usedBytes.toString(),
                computedBytes: entry.computedBytes.toString(),
            })),
        };
    });
export const driveAuditObjects = (job: Job<unknown>) =>
    run(job, () => auditObjects(stores(), 'primary'));
export const driveAuditReplica = (job: Job<unknown>) =>
    run(job, () => auditObjects(stores(), 'replica'));
export const driveOrphanSweep = (job: Job<unknown>) =>
    run(job, () =>
        sweepOrphans(stores(), {
            pausedUntil: storageEnv.DRIVE_ORPHAN_SWEEP_PAUSED_UNTIL
                ? new Date(storageEnv.DRIVE_ORPHAN_SWEEP_PAUSED_UNTIL)
                : null,
        }),
    );
export const driveTier = (job: Job<unknown>) =>
    run(job, () => tierObjects(stores(), { coldClass: storageEnv.STORAGE_COLD_CLASS ?? null }));
export const reportsEvidence = (job: Job<unknown>) =>
    run(job, () =>
        copyEvidence({
            open: storeFor,
            evidence: evidenceStore(),
            budgetMs: storageEnv.STORAGE_STORE_RUN_SECONDS * 1000,
        }),
    );
export const reportsRequests = (job: Job<unknown>) =>
    run(job, () => answerEvidenceRequests({ evidence: evidenceStore() }));

/* Whether the run a handler just finished stopped at a store's share and should go on at once. */
export { leftForNextRun };
