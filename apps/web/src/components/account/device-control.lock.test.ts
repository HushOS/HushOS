import { expect, test, vi } from 'vitest';

/*
 * Lock on this browser always locks: writing the open editors' drafts first is best effort, and
 * nothing it does (a store or a channel that fails) stops the lock.
 */
const lock = vi.fn(async () => {});
vi.mock('@/lib/auth/auth-client', () => ({ authClient: { lock } }));
vi.mock('@/lib/editor/draft-flush', () => ({
    flushDrafts: () => Promise.reject(new Error('BroadcastChannel is not available')),
}));
vi.mock('@/components/ui/toast', () => ({ toast: { add: vi.fn() } }));
vi.mock('@/lib/platform/sounds', () => ({ cue: vi.fn() }));

test('a draft flush that fails still locks', async () => {
    const { lockDevice } = await import('./device-control');
    await lockDevice();
    expect(lock).toHaveBeenCalledTimes(1);
});
