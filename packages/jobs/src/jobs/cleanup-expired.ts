import { authRepository } from '@hushos/db';
import { createLogger } from '@hushos/logging';
import type { Job } from 'pg-boss';
import type { JobPayloads, queues } from '../client';

/*
 * Deletes expired auth rows (enrollments, login and recovery attempts, sessions,
 * rate-limit buckets) in bounded batches until each table is clean. Runs on a
 * schedule and once at worker start, so a backlog after downtime never lands on
 * a user's request. Each run is one wide event.
 */
export async function cleanupExpired(job: Job<JobPayloads[typeof queues.cleanupExpired]>) {
    const event = createLogger({ job: { id: job.id, queue: job.name } });
    const started = performance.now();
    try {
        const counts = await authRepository.cleanupExpired({
            batchSize: job.data.batchSize ?? 500,
            signal: job.signal,
        });
        event.set({ removed: counts, durationMs: Math.round(performance.now() - started) });
        return counts;
    } catch (error) {
        if (error instanceof Error) event.error(error);
        throw error;
    } finally {
        event.emit();
    }
}
