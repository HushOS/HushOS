import { initProcessLogger, log } from '@hushos/logging';
import { createBoss, ensureQueues, queues, type JobPayloads } from './client';
import { cleanupExpired } from './jobs/cleanup-expired';

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
