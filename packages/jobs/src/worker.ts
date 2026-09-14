import { billingEnabled } from '@hushos/billing/server';
import { initProcessLogger, log } from '@hushos/logging';
import type { Job } from 'pg-boss';
import { createBoss, ensureQueues, queues, type JobPayloads } from './client';
import { evidenceConfigured, replicaConfigured } from '@hushos/env/storage';
import { cleanupExpired } from './jobs/cleanup-expired';
import {
    driveAuditObjects,
    driveAuditReplica,
    driveAuditUsage,
    driveDeleteObjects,
    driveExpireUploads,
    driveOrphanSweep,
    drivePurge,
    driveReplicate,
    driveTier,
    reportsEvidence,
    reportsRequests,
} from './jobs/drive';
import { reconcileBilling } from './jobs/reconcile-billing';

/*
 * The background worker: one process, started with `bun run --cwd packages/jobs start`
 * (source) or `bun worker.js` (the bundled entry that is the whole worker image).
 * It owns pg-boss maintenance and schedules; the web app only ever sends jobs.
 */
initProcessLogger('HushOS Worker');

const boss = createBoss('worker');
boss.on('error', (error) => log.error(error));

await boss.start();
await ensureQueues(boss);
log.info({ message: 'Worker started', schema: 'pgboss' });

// Every five minutes, and once now so a backlog after downtime is cleared immediately.
await boss.schedule(queues.cleanupExpired, '*/5 * * * *', {}, { tz: 'UTC' });
await boss.send(queues.cleanupExpired, {});

await boss.work<JobPayloads[typeof queues.cleanupExpired]>(
    queues.cleanupExpired,
    { batchSize: 1, pollingIntervalSeconds: 5 },
    async ([job]) => {
        if (job) await cleanupExpired(job);
    },
);

// Once a day, and once now: a delivery missed during downtime is caught before its grace ends.
if (billingEnabled()) {
    await boss.schedule(queues.reconcileBilling, '15 3 * * *', {}, { tz: 'UTC' });
    await boss.send(queues.reconcileBilling, {});
    await boss.work<JobPayloads[typeof queues.reconcileBilling]>(
        queues.reconcileBilling,
        { batchSize: 1, pollingIntervalSeconds: 30 },
        async ([job]) => {
            if (job) await reconcileBilling(job);
        },
    );
} else await boss.unschedule(queues.reconcileBilling);

/*
 * Drive: uploads past their expiry hourly, the deletion outbox and replication
 * every five minutes, the purge sweep every fifteen, the accounting and object
 * audits and tiering nightly, the replica audit weekly, and the orphan sweep a
 * bounded page of the bucket every night. Each also runs once at start so a
 * backlog after downtime clears.
 */
const replica = replicaConfigured();
log.info({
    message: replica
        ? 'Object replication is on'
        : 'No replica configured: deletions are immediate',
    schema: 'drive',
});
const driveJobs: [string, string, (job: Job<unknown>) => Promise<unknown>][] = [
    [queues.driveExpireUploads, '7 * * * *', driveExpireUploads],
    [queues.driveDeleteObjects, '*/5 * * * *', driveDeleteObjects],
    [queues.drivePurge, '*/15 * * * *', drivePurge],
    [queues.driveAuditUsage, '45 3 * * *', driveAuditUsage],
    [queues.driveAuditObjects, '20 4 * * *', driveAuditObjects],
    [queues.driveTier, '10 5 * * *', driveTier],
    [queues.driveOrphanSweep, '30 5 * * *', driveOrphanSweep],
    // Reports: the evidence copy every five minutes, whether or not a store is configured.
    [queues.reportsEvidence, '*/5 * * * *', reportsEvidence],
    // Every minute, and each run answers requests for most of that minute.
    [queues.reportsRequests, '* * * * *', reportsRequests],
];
log.info({
    message: evidenceConfigured()
        ? 'Evidence store is on: reported objects are copied there'
        : 'No evidence store configured: a report holds its bytes in the primary bucket only',
    schema: 'drive',
});
if (replica) {
    driveJobs.push([queues.driveReplicate, '*/5 * * * *', driveReplicate]);
    driveJobs.push([queues.driveAuditReplica, '40 4 * * 0', driveAuditReplica]);
} else {
    await boss.unschedule(queues.driveReplicate);
    await boss.unschedule(queues.driveAuditReplica);
}
for (const [queue, cron, handler] of driveJobs) {
    await boss.schedule(queue, cron, {}, { tz: 'UTC' });
    await boss.send(queue, {});
    await boss.work(queue, { batchSize: 1, pollingIntervalSeconds: 10 }, async ([job]) => {
        if (job) await handler(job);
    });
}

let stopping = false;
async function shutdown(signal: string) {
    if (stopping) return;
    stopping = true;
    log.info({ message: 'Worker stopping', signal });
    try {
        await boss.stop({ graceful: true, timeout: 30_000, close: true });
    } finally {
        process.exit(0);
    }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
