import { authRepository, groupsRepository } from '@hushos/db';
import { createLogger, sanitizeFailure } from '@hushos/logging';
import type { Job } from 'pg-boss';
import type { JobPayloads, queues } from '../client';

/*
 * Deletes expired auth rows (enrollments, login and recovery attempts, sessions,
 * rate-limit buckets, removed devices' tokens) and devices that can never come
 * back, revokes keyed devices idle for 90 days, and deletes revoked devices 90
 * days on; closes expired group invitations and forgets the address on any
 * no longer open for 30 days; in bounded batches until each table is clean. Runs on a
 * schedule and once at worker start, so a backlog after downtime never lands on
 * a user's request. Each run is one wide event.
 */
export async function cleanupExpired(job: Job<JobPayloads[typeof queues.cleanupExpired]>) {
    const event = createLogger({ job: { id: job.id, queue: job.name } });
    const started = performance.now();
    try {
        const options = { batchSize: job.data.batchSize ?? 500, signal: job.signal };
        const counts = {
            ...(await authRepository.cleanupExpired(options)),
            invitations: await groupsRepository.cleanupInvitations(options),
        };
        event.set({ removed: counts, durationMs: Math.round(performance.now() - started) });
        return counts;
    } catch (error) {
        if (error instanceof Error) event.error(error);
        event.set({ failure: sanitizeFailure(error) });
        throw error;
    } finally {
        event.emit();
    }
}
