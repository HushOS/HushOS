import { dbEnv } from '@hushos/env/db';
import { log } from '@hushos/logging';
import { PgBoss } from 'pg-boss';

/*
 * Every queue is named here, with its payload type and its policy, so the API and
 * the worker agree on both. pg-boss keeps its own tables in the `pgboss` schema of
 * the application database; the worker migrates that schema on start.
 */
export const queues = {
    cleanupExpired: 'auth.cleanup-expired',
    reconcileBilling: 'billing.reconcile',
    billingReissueCut: 'billing.reissue-cut',
    billingReissuePending: 'billing.reissue-pending',
    billingEndPersonalPlan: 'billing.end-personal-plan',
    billingCancelDissolved: 'billing.cancel-dissolved',
    driveExpireUploads: 'drive.expire-uploads',
    driveDeleteObjects: 'drive.delete-objects',
    driveReplicate: 'drive.replicate',
    drivePurge: 'drive.purge',
    driveAuditUsage: 'drive.audit-usage',
    driveAuditObjects: 'drive.audit-objects',
    driveAuditReplica: 'drive.audit-replica',
    driveOrphanSweep: 'drive.orphan-sweep',
    driveTier: 'drive.tier',
    reportsEvidence: 'reports.evidence',
    reportsRequests: 'reports.requests',
    groupsPurgeDissolved: 'groups.purge-dissolved',
} as const;

export type QueueName = (typeof queues)[keyof typeof queues];

export type JobPayloads = {
    [queues.cleanupExpired]: { batchSize?: number };
    [queues.reconcileBilling]: Record<string, never>;
    [queues.billingReissueCut]: { groupId: string };
    [queues.billingReissuePending]: { groupId: string };
    [queues.billingEndPersonalPlan]: {
        userId: string;
        groupId: string;
        admittedAt: string;
        seenAt: string;
    };
    [queues.billingCancelDissolved]: { groupId: string };
    [queues.driveExpireUploads]: Record<string, never>;
    [queues.driveDeleteObjects]: Record<string, never>;
    [queues.driveReplicate]: Record<string, never>;
    [queues.drivePurge]: Record<string, never>;
    [queues.driveAuditUsage]: Record<string, never>;
    [queues.driveAuditObjects]: Record<string, never>;
    [queues.driveAuditReplica]: Record<string, never>;
    [queues.driveOrphanSweep]: Record<string, never>;
    [queues.driveTier]: Record<string, never>;
    [queues.reportsEvidence]: Record<string, never>;
    [queues.reportsRequests]: Record<string, never>;
    [queues.groupsPurgeDissolved]: { batchSize?: number };
};

export const SCHEMA = 'pgboss';

export function createBoss(role: 'worker' | 'client') {
    const worker = role === 'worker';
    return new PgBoss({
        connectionString: dbEnv.DATABASE_URL,
        schema: SCHEMA,
        // Only the worker migrates, supervises (retries, expiry, retention) and fires schedules.
        migrate: worker,
        supervise: worker,
        schedule: worker,
        max: worker ? 4 : 2,
        persistWarnings: true,
        persistQueueStats: true,
    });
}

/* Idempotent: pg-boss updates an existing queue's options in place. */
export async function ensureQueues(boss: PgBoss) {
    await boss.createQueue(queues.cleanupExpired, {
        // One cleanup queued or running at a time; a second send while one waits is dropped.
        policy: 'singleton',
        retryLimit: 3,
        retryDelay: 30,
        retryBackoff: true,
        expireInSeconds: 10 * 60,
        retentionSeconds: 7 * 24 * 60 * 60,
    });
    await boss.createQueue(queues.reconcileBilling, {
        policy: 'singleton',
        retryLimit: 2,
        retryDelay: 5 * 60,
        retryBackoff: true,
        expireInSeconds: 30 * 60,
        retentionSeconds: 7 * 24 * 60 * 60,
    });
    /*
     * A family's scheduled cut Polar lost to a raise and HushOS could not put back
     * at once. Re-issuing sets an absolute count, so a retry or a duplicate is
     * harmless; backoff from a minute up to a few hours, then the daily reconcile.
     */
    await boss.createQueue(queues.billingReissueCut, {
        retryLimit: 8,
        retryDelay: 60,
        retryBackoff: true,
        expireInSeconds: 5 * 60,
        retentionSeconds: 7 * 24 * 60 * 60,
    });
    /*
     * Its successor, sent with the group id as `singletonKey`: `stately` keeps at most one
     * queued and one active job per family, however many reconciles ask (a queue's policy
     * can't change once made, so billing.reissue-cut stays only to drain what it holds).
     */
    // A failure (Polar down, a 5xx, a timeout) is retried for as long as it takes, backing off to
    // six hours; HushOS gives up only on answers of 200 that Polar didn't keep (MAX_REISSUES).
    await boss.createQueue(queues.billingReissuePending, {
        policy: 'stately',
        retryLimit: 100_000,
        retryDelay: 60,
        retryBackoff: true,
        retryDelayMax: 6 * 60 * 60,
        expireInSeconds: 5 * 60,
        retentionSeconds: 7 * 24 * 60 * 60,
    });
    /*
     * A pooled member's personal plan, revoked at Polar and its unused days refunded
     * (docs/families-shared-pool.md 5.1), sent with the user id as `singletonKey`: one
     * queued and one active per person. Every step is idempotent (the revoke time is
     * stored once, refunds are matched by their key, and one person's runs hold a lock),
     * so a retry is harmless. A failure is retried ten times, backing off from a minute
     * to six hours (about a day in all); a refund that failed five times in a row is
     * listed for operators, and the daily reconcile queues the job again for as long as
     * anything is owed, so an owed refund is tried at most once a day.
     */
    await boss.createQueue(queues.billingEndPersonalPlan, {
        policy: 'stately',
        retryLimit: 10,
        retryDelay: 60,
        retryBackoff: true,
        retryDelayMax: 6 * 60 * 60,
        expireInSeconds: 10 * 60,
        retentionSeconds: 30 * 24 * 60 * 60,
    });
    /*
     * Dissolved families past their retention: idempotent and bounded, and each family
     * is purged under its own advisory lock, so a second run at once skips it.
     */
    await boss.createQueue(queues.groupsPurgeDissolved, {
        policy: 'singleton',
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        expireInSeconds: 30 * 60,
        retentionSeconds: 7 * 24 * 60 * 60,
    });
    /*
     * A dissolved family's plan set to end at its period's end (docs/groups-design.md 3.3),
     * sent with the group id as `singletonKey`: one queued and one active per family. Each
     * plan is set under its change claim and read again first, so a retry, a webhook's job
     * and the leave route's never set it twice. A failure (Polar down, the claim held) is
     * retried ten times, backing off from a minute to six hours; the daily reconcile queues
     * it again while the plan can still charge.
     */
    await boss.createQueue(queues.billingCancelDissolved, {
        policy: 'stately',
        retryLimit: 10,
        retryDelay: 60,
        retryBackoff: true,
        retryDelayMax: 6 * 60 * 60,
        expireInSeconds: 5 * 60,
        retentionSeconds: 30 * 24 * 60 * 60,
    });
    // Drive's sweeps are idempotent and bounded; one of each at a time is enough.
    for (const queue of [
        queues.driveExpireUploads,
        queues.driveDeleteObjects,
        queues.driveReplicate,
        queues.drivePurge,
        queues.driveAuditUsage,
        queues.driveAuditObjects,
        queues.driveAuditReplica,
        queues.driveOrphanSweep,
        queues.driveTier,
        queues.reportsEvidence,
        queues.reportsRequests,
    ])
        await boss.createQueue(queue, {
            policy: 'singleton',
            retryLimit: 3,
            retryDelay: 60,
            retryBackoff: true,
            expireInSeconds: 30 * 60,
            retentionSeconds: 7 * 24 * 60 * 60,
        });
}

/*
 * For the API side: a lazily started, send-only client (billing's cut retries
 * are its first caller). A start that fails is forgotten, so the next send
 * tries again instead of failing for the life of the process.
 */
let client: Promise<PgBoss> | undefined;
export function getJobClient() {
    client ??= (async () => {
        const boss = createBoss('client');
        boss.on('error', (error) => log.error(error));
        await boss.start();
        return boss;
    })().catch((error: unknown) => {
        client = undefined;
        throw error;
    });
    return client;
}

export async function enqueue<N extends QueueName>(
    name: N,
    data: JobPayloads[N],
    options: { startAfterSeconds?: number; singletonKey?: string } = {},
) {
    const boss = await getJobClient();
    const send = {
        ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
        ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
    };
    return Object.keys(send).length ? boss.send(name, data, send) : boss.send(name, data);
}
