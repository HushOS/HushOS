import { afterEach, expect, test, vi } from 'vitest';
import { createBrowserCryptoTransport, LOCK_DRAIN_MS } from './crypto-transport';

/*
 * A lock ends the worker: at once, or, when a request was asked for just before it (an editor's
 * last draft, `drainOnLock`), once that request has its answer, never later than LOCK_DRAIN_MS.
 * Nothing else outlives the lock, and nothing new is taken.
 */
type Posted = { id: number; operation: string };
function fakeWorker() {
    const posted: Posted[] = [];
    let terminated = false;
    const worker = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        onerror: null as (() => void) | null,
        postMessage(message: Posted) {
            posted.push(message);
        },
        terminate() {
            terminated = true;
        },
    };
    return {
        worker,
        posted,
        terminated: () => terminated,
        answer(id: number, result: unknown) {
            worker.onmessage?.({ data: { id, result } } as MessageEvent);
        },
    };
}
afterEach(() => vi.useRealTimers());

test('a lock waits for a request asked for just before it, then ends the worker', async () => {
    const fake = fakeWorker();
    const transport = createBrowserCryptoTransport(() => fake.worker as unknown as Worker);
    const sealing = transport.request('driveDraftSlot' as never, {} as never, {
        drainOnLock: true,
    });
    const other = transport.request('driveDraftSlot' as never, {} as never);
    transport.lock();
    await expect(other).rejects.toThrow('locked');
    await expect(
        transport.request('driveDraftSlot' as never, {} as never, { drainOnLock: true }),
    ).rejects.toThrow('locked');
    expect(fake.terminated()).toBe(false);
    fake.answer(fake.posted[0]!.id, { slot: 'kept' });
    await expect(sealing).resolves.toEqual({ slot: 'kept' });
    await Promise.resolve();
    expect(fake.terminated()).toBe(true);
});

test('with nothing to finish the worker ends at once; a request that never answers ends it on time', async () => {
    const quiet = fakeWorker();
    createBrowserCryptoTransport(() => quiet.worker as unknown as Worker).lock();
    expect(quiet.terminated()).toBe(true);

    vi.useFakeTimers();
    const stuck = fakeWorker();
    const transport = createBrowserCryptoTransport(() => stuck.worker as unknown as Worker);
    const never = transport.request('driveDraftSlot' as never, {} as never, { drainOnLock: true });
    never.catch(() => {});
    transport.lock();
    await vi.advanceTimersByTimeAsync(LOCK_DRAIN_MS - 1);
    expect(stuck.terminated()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stuck.terminated()).toBe(true);
    await expect(never).rejects.toThrow('locked');
});
