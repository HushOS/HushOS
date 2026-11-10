import type { Job } from 'pg-boss';
import { describe, expect, test, vi } from 'vitest';
import { thenAgain } from './rerun';

/*
 * The wiring between a job's result and its next run (packages/jobs/src/worker.ts):
 * what is given to `boss.work` for every Drive queue.
 */

const job = { id: 'job-1', name: 'drive.replicate', data: {} } as unknown as Job<unknown>;

describe('a run of a job that takes its stores in turn', () => {
    test('is sent again, once, when it stopped at a store’s share, and only after it has returned', async () => {
        const order: string[] = [];
        const again = vi.fn(async () => {
            order.push('sent');
        });
        const work = thenAgain(async () => {
            order.push('ran');
            return { copied: 2, failed: 0, avoided: 0, deferred: 7 };
        }, again);
        await work([job]);
        expect(again).toHaveBeenCalledTimes(1);
        expect(order).toEqual(['ran', 'sent']);
    });

    test('is not sent again when it left nothing, or left work because a store is unwell or failing', async () => {
        const again = vi.fn(async () => {});
        for (const result of [
            { copied: 9, failed: 0, avoided: 0, deferred: 0 },
            { copied: 0, failed: 5, avoided: 12, deferred: 0 },
            { skipped: 'paused' },
            { trash: 3, descendants: 0 },
        ])
            await thenAgain(async () => result, again)([job]);
        expect(again).not.toHaveBeenCalled();
    });

    test('sends nothing when the run throws, and lets the failure reach pg-boss to retry', async () => {
        const again = vi.fn(async () => {});
        const failure = new Error('the database went away');
        await expect(
            thenAgain(async () => {
                throw failure;
            }, again)([job]),
        ).rejects.toBe(failure);
        expect(again).not.toHaveBeenCalled();
    });

    test('does nothing with an empty fetch', async () => {
        const handler = vi.fn(async () => ({ deferred: 3 }));
        const again = vi.fn(async () => {});
        await thenAgain(handler, again)([]);
        expect(handler).not.toHaveBeenCalled();
        expect(again).not.toHaveBeenCalled();
    });
});
