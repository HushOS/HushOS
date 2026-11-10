import {
    billingEnabled,
    setCutRetryQueue,
    setDissolveCancelQueue,
    setEndPersonalPlanQueue,
} from '@hushos/billing/server';
import {
    LATEST_MIGRATION,
    driveRepository,
    missingTablePrivileges,
    pendingSchemaSteps,
    schemaState,
    storesRepository,
} from '@hushos/db';
import { initProcessLogger, log } from '@hushos/logging';
import type { Job } from 'pg-boss';
import { createBoss, ensureQueues, queues, type JobPayloads } from './client';
import { groupsEnv } from '@hushos/env/groups';
import { evidenceConfigured, replicaConfigured } from '@hushos/env/storage';
import { cleanupExpired } from './jobs/cleanup-expired';
import { groupsDissolveNotices, groupsPurgeDissolved } from './jobs/groups';
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
    leftForNextRun,
    reportsEvidence,
    reportsRequests,
} from './jobs/drive';
import {
    cancelDissolvedFamilyPlan,
    endPersonalPlan,
    reconcileBilling,
    reissueGroupCut,
} from './jobs/reconcile-billing';

/*
 * The background worker: one process, started with `bun run --cwd packages/jobs start`
 * (source) or `bun worker.js` (the bundled entry that is the whole worker image).
 * It owns pg-boss maintenance and schedules; the web app only ever sends jobs.
 */
initProcessLogger('HushOS Worker');

/*
 * The worker never migrates the application schema: the migrate job or the web
 * image does, once per release. It waits for the migration this build was made
 * against, up to ten minutes, and refuses to run without the table privileges
 * its jobs need, so a role missing a grant fails here once, by name, instead of
 * failing every job in a loop.
 */
function refuse(message: string): never {
    log.error({ message });
    process.exit(1);
}
const deadline = Date.now() + 10 * 60_000;
for (;;) {
    const state = await schemaState();
    if (state === 'current') break;
    if (state === 'unreadable')
        refuse(
            'The worker cannot read the migrations ledger: grant USAGE on schema drizzle and SELECT on drizzle.__drizzle_migrations to its role.',
        );
    if (Date.now() >= deadline)
        refuse(`The database is behind this build: migration ${LATEST_MIGRATION} is not applied.`);
    log.warn({ message: 'Waiting for the database to be migrated', migration: LATEST_MIGRATION });
    await Bun.sleep(5_000);
}
const missing = await missingTablePrivileges();
if (missing.length)
    refuse(
        `The worker's role lacks SELECT, INSERT, UPDATE or DELETE on: ${missing.join(', ')}. See docs/self-hosting.md.`,
    );

// What `db:migrate` does after the migration (constraint validations, an index built without
// blocking writes). Nothing waits for it and nothing is wrong without it; it is named here so a
// step that failed is not forgotten.
const pendingSteps = await pendingSchemaSteps();
if (pendingSteps.length)
    log.warn({
        message:
            'Schema steps that run after the migration are still pending: run db:migrate again (docs/self-hosting.md, "After the migration")',
        steps: pendingSteps,
    });

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

/*
 * Hourly, and once now: dissolved families past DISSOLVED_FAMILY_RETENTION_DAYS go,
 * folders and stored objects (through the deletion outbox) and then their records.
 */
await boss.schedule(queues.groupsPurgeDissolved, '25 * * * *', {}, { tz: 'UTC' });
await boss.send(queues.groupsPurgeDissolved, {});
await boss.work<JobPayloads[typeof queues.groupsPurgeDissolved]>(
    queues.groupsPurgeDissolved,
    { batchSize: 1, pollingIntervalSeconds: 30 },
    async ([job]) => {
        if (job) await groupsPurgeDissolved(job);
    },
);

/*
 * Every minute, and once now, while families are served: the emails a dissolved family
 * owes its last member and whoever was still joining it. With GROUPS_ENABLED=false
 * (hushos.com until families launch) nobody is emailed about a family.
 */
if (groupsEnv.GROUPS_ENABLED) {
    await boss.schedule(queues.groupsDissolveNotices, '* * * * *', {}, { tz: 'UTC' });
    await boss.send(queues.groupsDissolveNotices, {});
    await boss.work<JobPayloads[typeof queues.groupsDissolveNotices]>(
        queues.groupsDissolveNotices,
        { batchSize: 1, pollingIntervalSeconds: 10 },
        async ([job]) => {
            if (job) await groupsDissolveNotices(job);
        },
    );
} else await boss.unschedule(queues.groupsDissolveNotices);

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
    // The daily reconcile re-issues a family's lost cut too; a failure there is queued here.
    // One pending retry per family: the stately queue, keyed by the group.
    setCutRetryQueue((groupId, startAfterSeconds) =>
        boss.send(
            queues.billingReissuePending,
            { groupId },
            {
                singletonKey: groupId,
                ...(startAfterSeconds ? { startAfter: startAfterSeconds } : {}),
            },
        ),
    );
    // A pooled member's personal plan ends (docs/families-shared-pool.md 5.1): one job per person.
    setEndPersonalPlanQueue((data) =>
        boss.send(queues.billingEndPersonalPlan, data, { singletonKey: data.userId }),
    );
    await boss.work<JobPayloads[typeof queues.billingEndPersonalPlan]>(
        queues.billingEndPersonalPlan,
        { batchSize: 1, pollingIntervalSeconds: 30 },
        async ([job]) => {
            if (job) await endPersonalPlan(job);
        },
    );
    // A dissolved family's plan set to end at its period's end: one job per family.
    setDissolveCancelQueue((groupId) =>
        boss.send(queues.billingCancelDissolved, { groupId }, { singletonKey: groupId }),
    );
    await boss.work<JobPayloads[typeof queues.billingCancelDissolved]>(
        queues.billingCancelDissolved,
        { batchSize: 1, pollingIntervalSeconds: 30 },
        async ([job]) => {
            if (job) await cancelDissolvedFamilyPlan(job);
        },
    );
    for (const queue of [queues.billingReissuePending, queues.billingReissueCut] as const)
        await boss.work<JobPayloads[typeof queue]>(
            queue,
            { batchSize: 1, pollingIntervalSeconds: 30 },
            async ([job]) => {
                if (job) await reissueGroupCut(job);
            },
        );
} else await boss.unschedule(queues.reconcileBilling);

/*
 * Drive: uploads past their expiry, the deletion outbox (which also removes its
 * own finished rows after 30 days) and replication every five minutes (an upload whose store never started it holds its reserved bytes
 * until expiry's next run), the purge sweep every fifteen, the accounting and object
 * audits and tiering nightly, the replica audit weekly, and the orphan sweep a
 * bounded number of pages of every region's bucket every night. Each also runs once at start so a
 * backlog after downtime clears. A run takes its stores in turn and gives each a share of
 * itself (STORAGE_STORE_RUN_SECONDS); one that left work only for that reason is sent again
 * at once.
 */
const replica = replicaConfigured();
// The replica's row holds no settings, only whether this worker's environment has them: the
// default region has a working backup exactly when it does (docs/company-storage-design.md 2.1).
await storesRepository.recordEnvironmentReplica(replica);
// A worker of the release before this one marked an object as backed up without naming the
// backup; it knew only the replica. Such a worker may have run until a moment ago, so every
// start rewrites what it left (docs/company-storage-design.md 11.1).
const adopted = await driveRepository.adoptLegacyBackupMarks();
if (adopted.objects || adopted.outbox)
    log.info({
        message: 'Backup marks of the previous release now name the replica',
        schema: 'drive',
        ...adopted,
    });
log.info({
    message: replica
        ? 'Object replication is on'
        : 'No replica configured: deletions are immediate',
    schema: 'drive',
});
const driveJobs: [string, string, (job: Job<unknown>) => Promise<unknown>][] = [
    [queues.driveExpireUploads, '*/5 * * * *', driveExpireUploads],
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
        if (!job) return;
        // A run that stopped at a store's share of it goes on in the next one, now.
        if (leftForNextRun(await handler(job))) await boss.send(queue, {});
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
