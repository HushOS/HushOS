import {
    cancelDissolvedPlan,
    endPersonalPlans,
    reconcileCustomer,
    reconcileGroup,
    reconcilePlanEndings,
    reissueCut,
    relistUnlistedFamilies,
} from '@hushos/billing/server';
import { billingRepository } from '@hushos/db';
import { createLogger, sanitizeFailure } from '@hushos/logging';
import type { Job } from 'pg-boss';
import type { JobPayloads, queues } from '../client';

/*
 * Re-reads every billing customer from the provider, people and families, so a
 * delivery that never arrived cannot leave an allowance, a family's pool or its
 * seats behind past the grace period. One wide event.
 */
export async function reconcileBilling(job: Job<JobPayloads[typeof queues.reconcileBilling]>) {
    const event = createLogger({ job: { id: job.id, queue: job.name } });
    const started = performance.now();
    let reconciled = 0;
    let failed = 0;
    try {
        for (const userId of await billingRepository.listCustomerIds('polar')) {
            if (job.signal?.aborted) break;
            try {
                await reconcileCustomer(userId);
                reconciled += 1;
            } catch (error) {
                failed += 1;
                if (error instanceof Error) event.error(error);
            }
        }
        for (const groupId of await billingRepository.listGroupCustomerIds('polar')) {
            if (job.signal?.aborted) break;
            try {
                await reconcileGroup(groupId);
                reconciled += 1;
            } catch (error) {
                failed += 1;
                if (error instanceof Error) event.error(error);
            }
        }
        // Families whose list of plans at Polar is owed (a read that failed): listed again, so a
        // plan the mirror never held is found even after a dissolved family's job gave up.
        try {
            failed += (await relistUnlistedFamilies()).failed;
        } catch (error) {
            failed += 1;
            if (error instanceof Error) event.error(error);
        }
        // Family checkout claims past their hold (purged families, gone accounts, plain expiry).
        try {
            await billingRepository.deleteExpiredGroupCheckouts();
        } catch (error) {
            failed += 1;
            if (error instanceof Error) event.error(error);
        }
        // Pooled members' personal plans still live, and endings with a refund pending or owed.
        let endings = 0;
        try {
            endings = await reconcilePlanEndings();
        } catch (error) {
            failed += 1;
            if (error instanceof Error) event.error(error);
        }
        event.set({
            reconciled,
            failed,
            endingsQueued: endings,
            durationMs: Math.round(performance.now() - started),
        });
        if (failed) throw new Error('Some customers could not be reconciled.');
    } catch (error) {
        // Listing the customers can fail too; that run must not read as a quiet success.
        if (error instanceof Error) event.error(error);
        event.set({ failure: sanitizeFailure(error) });
        throw error;
    } finally {
        event.emit();
    }
}

/*
 * One family's recorded cut, asked of Polar again. A failure throws, so
 * pg-boss retries the job with backoff; a cut already in place is done.
 */
export async function reissueGroupCut(
    job: Job<JobPayloads[typeof queues.billingReissueCut | typeof queues.billingReissuePending]>,
) {
    const event = createLogger({ job: { id: job.id, queue: job.name } });
    try {
        await reissueCut(job.data.groupId);
        event.set({ outcome: 'reissued' });
    } catch (error) {
        event.set({ failure: sanitizeFailure(error) });
        throw error;
    } finally {
        event.emit();
    }
}

/*
 * A dissolved family's plan set to end at its period's end. A failure throws, so
 * pg-boss retries with backoff.
 */
export async function cancelDissolvedFamilyPlan(
    job: Job<JobPayloads[typeof queues.billingCancelDissolved]>,
) {
    const event = createLogger({ job: { id: job.id, queue: job.name } });
    try {
        const result = await cancelDissolvedPlan(job.data.groupId);
        event.set({
            outcome: 'done',
            cancelled: result.cancelled,
            refused: result.refused,
            revoked: result.revoked,
        });
    } catch (error) {
        event.set({ failure: sanitizeFailure(error) });
        throw error;
    } finally {
        event.emit();
    }
}

/*
 * One person's personal plan ended because their files joined a family's pool:
 * revoked at Polar and the unused days refunded. A failure throws, so pg-boss
 * retries with backoff; refunds still pending at Polar wait for the daily reconcile.
 */
export async function endPersonalPlan(job: Job<JobPayloads[typeof queues.billingEndPersonalPlan]>) {
    const event = createLogger({ job: { id: job.id, queue: job.name } });
    try {
        const result = await endPersonalPlans(job.data, { signal: job.signal });
        event.set({
            outcome: 'done',
            settled: result.settled,
            pending: result.pending,
            owed: result.owed,
        });
    } catch (error) {
        event.set({ failure: sanitizeFailure(error) });
        throw error;
    } finally {
        event.emit();
    }
}
