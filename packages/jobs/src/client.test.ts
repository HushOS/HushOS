import { afterEach, expect, test, vi } from 'vitest';

/*
 * The API's send-only client: a pg-boss start that fails must not be cached,
 * or every later enqueue (billing's cut retries) fails until the process
 * restarts. pg-boss is replaced; nothing here reaches a database.
 */
process.env.DATABASE_URL ??= 'postgresql://hushos:hushos@127.0.0.1:1/none';

const starts = { failures: 0, calls: 0, sent: [] as unknown[] };
vi.mock('pg-boss', () => ({
    PgBoss: class {
        on() {}
        async start() {
            starts.calls += 1;
            if (starts.failures > 0) {
                starts.failures -= 1;
                throw new Error('connection refused');
            }
        }
        async send(name: string, data: unknown) {
            starts.sent.push({ name, data });
            return 'job_1';
        }
    },
}));

const { enqueue, queues } = await import('./client');

afterEach(() => {
    starts.failures = 0;
    starts.calls = 0;
    starts.sent = [];
});

test('a failed start is retried by the next send, and a good one is kept', async () => {
    starts.failures = 1;
    await expect(enqueue(queues.billingReissueCut, { groupId: 'g' })).rejects.toThrow(
        'connection refused',
    );
    await expect(enqueue(queues.billingReissueCut, { groupId: 'g' })).resolves.toBe('job_1');
    await enqueue(queues.billingReissueCut, { groupId: 'h' });
    expect(starts.calls).toBe(2);
    expect(starts.sent).toEqual([
        { name: 'billing.reissue-cut', data: { groupId: 'g' } },
        { name: 'billing.reissue-cut', data: { groupId: 'h' } },
    ]);
});
