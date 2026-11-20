// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';

/*
 * A lock reaches every tab at once: the tab that locks asks the others' editors to write first,
 * and waits for them, but never long. Each "tab" is its own copy of the module, sharing the
 * BroadcastChannel as two tabs of one browser do.
 */
async function tab() {
    vi.resetModules();
    return import('./draft-flush');
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const forgets: (() => void)[] = [];
afterEach(() => {
    for (const forget of forgets.splice(0)) forget();
});

test('a lock started in another tab waits for this tab’s editor to write its draft', async () => {
    const editing = await tab();
    const locking = await tab();
    let written = false;
    forgets.push(
        editing.flushBeforeLock(async () => {
            await sleep(400);
            written = true;
        }),
    );
    await locking.flushDrafts();
    expect(written).toBe(true);
});

test('with no editor open anywhere, a lock waits only a moment', async () => {
    const locking = await tab();
    const started = Date.now();
    await locking.flushDrafts();
    expect(Date.now() - started).toBeLessThan(800);
});

test('a tab whose write never ends holds the lock no longer than its bound', async () => {
    const editing = await tab();
    const locking = await tab();
    forgets.push(editing.flushBeforeLock(() => new Promise<void>(() => {})));
    const started = Date.now();
    await locking.flushDrafts(600);
    expect(Date.now() - started).toBeLessThan(1_500);
});

test('with no BroadcastChannel and an editor whose write fails, flushing still settles', async () => {
    vi.stubGlobal(
        'BroadcastChannel',
        class {
            constructor() {
                throw new Error('BroadcastChannel is not available');
            }
        },
    );
    try {
        const locking = await tab();
        forgets.push(locking.flushBeforeLock(() => Promise.reject(new Error('quota'))));
        await expect(locking.flushDrafts(300)).resolves.toBeUndefined();
    } finally {
        vi.unstubAllGlobals();
    }
});
