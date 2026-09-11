import { billingEnabled } from '@hushos/billing/server';
import { initProcessLogger, log } from '@hushos/logging';
import { createBoss, ensureQueues, queues, type JobPayloads } from './client';
import { cleanupExpired } from './jobs/cleanup-expired';
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
