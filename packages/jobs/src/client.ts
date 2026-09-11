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
} as const;

export type QueueName = (typeof queues)[keyof typeof queues];

export type JobPayloads = {
    [queues.cleanupExpired]: { batchSize?: number };
    [queues.reconcileBilling]: Record<string, never>;
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
}

/*
 * For the API side: a lazily started, send-only client. Nothing sends yet; Drive's
 * upload commit will be the first caller, ideally inside its own transaction.
 */
let client: Promise<PgBoss> | undefined;
export function getJobClient() {
    client ??= (async () => {
        const boss = createBoss('client');
        boss.on('error', (error) => log.error(error));
        await boss.start();
        return boss;
    })();
    return client;
}

export async function enqueue<N extends QueueName>(name: N, data: JobPayloads[N]) {
    const boss = await getJobClient();
    return boss.send(name, data);
}
