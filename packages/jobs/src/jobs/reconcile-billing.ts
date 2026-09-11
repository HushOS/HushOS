import { reconcileCustomer } from '@hushos/billing/server';
import { billingRepository } from '@hushos/db';
import { createLogger } from '@hushos/logging';
import type { Job } from 'pg-boss';
import type { JobPayloads, queues } from '../client';

/*
 * Re-reads every billing customer from the provider, so a delivery that never
 * arrived cannot leave an allowance behind past its grace period. One wide event.
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
        event.set({ reconciled, failed, durationMs: Math.round(performance.now() - started) });
        if (failed) throw new Error('Some customers could not be reconciled.');
    } finally {
        event.emit();
    }
}
