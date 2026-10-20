import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

/*
 * A family page checks a running key change again from `pollWhileWalking`, twice as long as
 * the walk goes on (useFamilySync). TanStack Query asks a query's `refetchInterval` on every
 * render and on every update of the query, so a page that rendered or refetched often must
 * not push its next check further out: a manager's device that stopped walking (a batch cut
 * off by the client's timeout) waits on that check to walk again, and uploads wait on the walk.
 */
const syncs = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/auth-view', () => ({
    useAuthView: (select: (state: { unlockedUserId: string }) => unknown) =>
        select({ unlockedUserId: 'u1' }),
}));
vi.mock('@/lib/groups/client', () => ({ groupContext: () => ({}) }));
vi.mock('@/lib/groups/outbox', () => ({
    dropHeldBack: async () => [],
    resumeOutbox: async () => ({ notices: [] }),
}));
vi.mock('@/lib/groups/sync', () => ({
    syncAll: async () => new Map(),
    // A key change still walking one of the family's folders, at every sync.
    syncGroup: async () => {
        syncs.count++;
        return {
            status: 'accepted',
            areas: [{ workspaceId: 'w1', view: { rotation: { id: 'r1' } } }],
            notices: [],
        };
    },
}));
vi.mock('@/lib/family-work', () => ({ startFamilyWork: () => {} }));
const { useFamilySync } = await import('./families');

const POLL = 15_000;
const summary = { id: 'g1', state: 'active', rosterVersion: 3, roles: [] } as never;

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
    vi.useFakeTimers();
    syncs.count = 0;
    client = new QueryClient();
});
afterEach(() => {
    client.clear();
    vi.useRealTimers();
});

async function mounted() {
    const hook = renderHook(() => useFamilySync('u1', 'g1', summary, { pollWhileWalking: POLL }), {
        wrapper,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(syncs.count).toBe(1);
    return hook;
}

test('rendering the page any number of times doesn’t push the next check out', async () => {
    const hook = await mounted();
    for (let i = 0; i < 30; i++) hook.rerender();
    await vi.advanceTimersByTimeAsync(POLL);
    expect(syncs.count).toBe(2);
    hook.unmount();
});

test('refetching any number of times doesn’t double the wait: it follows the clock', async () => {
    const hook = await mounted();
    for (let i = 0; i < 6; i++) {
        await client.refetchQueries();
        await vi.advanceTimersByTimeAsync(0);
    }
    const before = syncs.count;
    // The walk has run for well under one base period: the next check is one base period
    // after the last sync, never 2^6 of them.
    await vi.advanceTimersByTimeAsync(POLL);
    expect(syncs.count).toBe(before + 1);
    hook.unmount();
});

test('the wait does grow with how long the walk has run, and stops at ten minutes', async () => {
    const hook = await mounted();
    // Checks at 15 s, then 30 s apart once 15 s have passed, 60 s once 45 s have, and so on.
    await vi.advanceTimersByTimeAsync(POLL);
    expect(syncs.count).toBe(2);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(syncs.count).toBe(2);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(syncs.count).toBe(3);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const late = syncs.count;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(syncs.count).toBe(late + 1);
    hook.unmount();
});
