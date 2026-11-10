import { leftForNextRun } from '@hushos/drive/turns';
import type { Job } from 'pg-boss';

/*
 * What the worker hands pg-boss for a queue whose job takes its stores in turn
 * (docs/company-storage-design.md 2.4). A run that stopped at a store's share
 * left work behind that nothing is wrong with, so the job is sent again at
 * once and the next run goes on with it; the queue lets one run be active at a
 * time, so that is after this one has returned. A run that left nothing, or
 * left work only because a store is unwell, waits for the schedule. A run that
 * threw sends nothing: pg-boss retries it.
 */
export function thenAgain<T>(
    handler: (job: Job<T>) => Promise<unknown>,
    again: () => Promise<unknown>,
) {
    return async ([job]: Job<T>[]) => {
        if (!job) return;
        if (leftForNextRun(await handler(job))) await again();
    };
}
