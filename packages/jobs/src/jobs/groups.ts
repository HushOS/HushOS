import { groupsRepository } from '@hushos/db';
import { TRASH_RETENTION_DAYS } from '@hushos/drive/protocol';
import type { sendFamilyDissolved } from '@hushos/emails/server';
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

const deletesOnFormat = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
});

/*
 * The emails dissolving a family owes (docs/groups-design.md 3.3), written in the
 * transaction that dissolved it: the last member is told when its folders are deleted,
 * and whoever was still joining it that it no longer exists. Each is claimed before it
 * is sent, so two runs never both send one; a send whose provider reply was lost counts
 * as failed and may be sent again by the next run. The folders' date uses the
 * retention drive.purge is given (TRASH_RETENTION_DAYS), the one that deletes them.
 * The mail module and the app origin are loaded here, not with the worker: both read
 * settings when they load, and a worker an operator gave no email settings must still
 * start. Without them nothing is sent and each run says so; what is owed waits (a week
 * at most) for a run that has them. One wide event a run.
 */
export async function groupsDissolveNotices(
    job: Job<JobPayloads[typeof queues.groupsDissolveNotices]>,
) {
    const event = createLogger({ job: { id: job.id, queue: job.name } });
    try {
        let mail: typeof sendFamilyDissolved;
        let appOrigin: string;
        try {
            mail = (await import('@hushos/emails/server')).sendFamilyDissolved;
            appOrigin = (await import('@hushos/env/app')).appEnv.APP_ORIGIN;
        } catch (error) {
            event.set({ failure: sanitizeFailure(error) });
            event.warn(
                'Family dissolved emails not sent: the worker has no email or APP_ORIGIN settings',
            );
            return { sent: 0, dropped: 0 };
        }
        const outcome = await groupsRepository.deliverDissolveNotices({
            folderRetentionDays: TRASH_RETENTION_DAYS,
            send: (notice) =>
                mail(
                    notice.email,
                    notice.kind === 'dissolved'
                        ? {
                              kind: 'dissolved',
                              groupName: notice.groupName,
                              deletesOn: deletesOnFormat.format(notice.foldersDeletedAt),
                              appUrl: appOrigin,
                          }
                        : { kind: notice.kind, groupName: notice.groupName, appUrl: appOrigin },
                ),
        });
        event.set({
            notices: { sent: outcome.sent, dropped: outcome.dropped, failed: outcome.failed },
        });
        if (outcome.failure) {
            event.set({ failure: sanitizeFailure(outcome.failure) });
            event.warn('Family dissolved email not sent: the next run tries again');
        }
        return { sent: outcome.sent, dropped: outcome.dropped };
    } catch (error) {
        if (error instanceof Error) event.error(error);
        event.set({ failure: sanitizeFailure(error) });
        throw error;
    } finally {
        event.emit();
    }
}
