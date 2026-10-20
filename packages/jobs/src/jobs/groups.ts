import { groupsRepository } from '@hushos/db';
import { createLogger, sanitizeFailure } from '@hushos/logging';
import type { Job } from 'pg-boss';
import type { JobPayloads, queues } from '../client';

/*
 * What dissolved families leave, after DISSOLVED_FAMILY_RETENTION_DAYS
 * (docs/groups-design.md 3.3). Their folders are not deleted here: dissolving
 * marks them deleted, and drive.purge (purgeDeletedAreas) deletes them with their
 * files, through the deletion outbox, as it does any deleted family folder. This
 * job retires the folders of a family dissolved without that (by a container of the
 * previous release during a rollout) as of now, so they too get the whole retention,
 * and deletes a family's own records (member lists, key changes, memberships,
 * invitations) once none of its folders is left and no plan of it is live. Each
 * call is bounded; the run repeats until nothing more is done or the job's time is
 * nearly up. Each run is one wide event.
 */
export async function groupsPurgeDissolved(
    job: Job<JobPayloads[typeof queues.groupsPurgeDissolved]>,
) {
    const event = createLogger({ job: { id: job.id, queue: job.name } });
    const started = performance.now();
    try {
        const counts = { retired: 0, families: 0, busy: 0 };
        for (let pass = 0; pass < 20 && !job.signal?.aborted; pass++) {
            const step = await groupsRepository.purgeDissolvedFamilies(
                groupsRepository.DISSOLVED_FAMILY_RETENTION_DAYS,
                job.data.batchSize ?? 50,
            );
            counts.retired += step.retired;
            counts.families += step.families;
            counts.busy += step.busy;
            // Nothing more done: what is left is held, busy elsewhere, or not due.
            if (step.families === 0 && step.retired === 0) break;
        }
        event.set({ purged: counts, durationMs: Math.round(performance.now() - started) });
        return counts;
    } catch (error) {
        if (error instanceof Error) event.error(error);
        event.set({ failure: sanitizeFailure(error) });
        throw error;
    } finally {
        event.emit();
    }
}
