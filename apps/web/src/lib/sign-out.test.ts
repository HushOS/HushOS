import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';

/*
 * What a removed browser clears (docs/devices-design.md, step 1). The auth client
 * acknowledges the removal, and so lets go of the cookie, only when this resolves;
 * a store that did not clear (IndexedDB busy in another tab) must reject, or the
 * stashed copies and mirror would stay with nothing left to try again. Signing
 * out goes on regardless, as before.
 */

const stores = vi.hoisted(() => ({
    transfers: vi.fn(),
    stash: vi.fn(),
    mirror: vi.fn(),
    groups: vi.fn(),
}));
/* What the open app holds in memory, and the auth client with a real store to lock. */
const memory = vi.hoisted(() => ({
    close: vi.fn(),
    spaces: vi.fn(),
    thumbnails: vi.fn(),
    previews: vi.fn(),
}));
const auth = vi.hoisted(() => ({
    store: undefined as unknown as StoreApi<{ unlockedUserId: string | null }>,
    logout: vi.fn(),
}));
const forgetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/transfers', () => ({ transfers: { forgetAll: stores.transfers } }));
vi.mock('@/lib/stash', () => ({ forgetStash: stores.stash }));
vi.mock('@/lib/drive', () => ({
    driveClient: { forgetMirror: stores.mirror, close: memory.close },
    closeSpaces: memory.spaces,
}));
vi.mock('@/lib/thumbnails', () => ({ forgetThumbnails: memory.thumbnails }));
vi.mock('@/lib/previews', () => ({ forgetPreviews: memory.previews }));
vi.mock('@/lib/groups/store', () => ({ deleteGroupDevice: stores.groups }));
vi.mock('@/lib/auth-client', () => ({ authClient: auth }));
vi.mock('@/lib/return-to', () => ({ forgetReturn: vi.fn() }));
vi.mock('@/lib/session', () => ({ forgetSession }));

const { clearDevice, forgetDevice, leaveApp } = await import('./sign-out');
const { useAuthView } = await import('./auth-view');

beforeEach(() => {
    stores.transfers.mockResolvedValue(undefined);
    stores.stash.mockResolvedValue(undefined);
    stores.mirror.mockResolvedValue(undefined);
    stores.groups.mockResolvedValue(undefined);
    auth.store = createStore(() => ({ unlockedUserId: 'maya' as string | null }));
    // Logging out locks this device at once, as the auth client does, then asks the server.
    auth.logout.mockImplementation(async () => auth.store.setState({ unlockedUserId: null }));
    for (const forget of Object.values(memory)) forget.mockImplementation(() => {});
});

describe('clearing a removed browser', () => {
    test('resolves only once every store cleared', async () => {
        await expect(clearDevice()).resolves.toBeUndefined();
        expect(stores.transfers).toHaveBeenCalledOnce();
        expect(stores.stash).toHaveBeenCalledOnce();
        expect(stores.mirror).toHaveBeenCalledOnce();
        expect(stores.groups).toHaveBeenCalledOnce();
    });

    test.each([
        ['the uploads and their journal', 'transfers'],
        ['the sealed stash', 'stash'],
        ['the mirror', 'mirror'],
        ['the families and their folders’ mirrors', 'groups'],
    ] as const)(
        'rejects when %s did not clear, so the removal is not acknowledged',
        async (_label, store) => {
            stores[store].mockRejectedValue(new Error('Device storage is busy in another tab.'));
            await expect(clearDevice()).rejects.toThrow('busy');
            // Signing out does not care: it goes on and ends the session,
            // and says that something stayed rather than swallow it.
            const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
            await expect(forgetDevice()).resolves.toBe(false);
            expect(logged).toHaveBeenCalled();
        },
    );

    test('clears every other store when one fails, then says it failed', async () => {
        stores.stash.mockRejectedValue(new Error('The stash could not be deleted.'));
        let mirrorCleared = false;
        stores.mirror.mockImplementation(
            () =>
                new Promise((resolve) =>
                    setTimeout(() => {
                        mirrorCleared = true;
                        resolve(undefined);
                    }, 20),
                ),
        );
        await expect(clearDevice()).rejects.toThrow('could not be deleted');
        // Reported only after the slower stores finished, not as soon as the first one failed.
        expect(mirrorCleared).toBe(true);
        expect(stores.transfers).toHaveBeenCalledOnce();
        expect(stores.groups).toHaveBeenCalledOnce();
    });
});

/*
 * Signing out from inside the app (leaveApp). The page being left draws the state the sign-out
 * started from until the sign-in page replaces it, while the keys are locked and the device
 * cleared underneath; only after the navigation go the decrypted thumbnails and previews, the
 * open workspace and the query cache the old page drew from. A logout that fails never leaves.
 */
describe('signing out of the app', () => {
    function leaving() {
        // What a component of the page being left draws, rendered fresh on demand.
        const drawn = renderHook(() => useAuthView((state) => state.unlockedUserId));
        const draw = () => {
            drawn.rerender();
            return drawn.result.current;
        };
        const clear = vi.fn();
        const seen: Record<string, unknown> = {};
        const navigate = vi.fn(async () => {
            seen.drawn = draw();
            seen.live = auth.store.getState().unlockedUserId;
            seen.deviceCleared = stores.mirror.mock.calls.length;
            seen.memoryForgotten = Object.values(memory).some((forget) => forget.mock.calls.length);
            seen.cacheCleared = clear.mock.calls.length;
        });
        const router = { navigate, options: { context: { queryClient: { clear } } } };
        return {
            router: router as unknown as Parameters<typeof leaveApp>[0],
            navigate,
            clear,
            draw,
            seen,
        };
    }

    test('holds the page until the sign-in page replaces it, then forgets what it drew from', async () => {
        const { router, navigate, clear, draw, seen } = leaving();
        expect(draw()).toBe('maya');
        await leaveApp(router);
        expect(navigate).toHaveBeenCalledExactlyOnceWith({ to: '/login' });
        expect(seen).toEqual({
            // The page still drew the unlocked folder as it left...
            drawn: 'maya',
            // ...though its keys were already locked and the device's copies cleared.
            live: null,
            deviceCleared: 1,
            // What it drew from was still there for it until it had gone.
            memoryForgotten: false,
            cacheCleared: 0,
        });
        for (const forget of Object.values(memory)) expect(forget).toHaveBeenCalledOnce();
        expect(clear).toHaveBeenCalledOnce();
        // Released: whatever mounts next draws the truth.
        expect(draw()).toBeNull();
    });

    test('a logout that fails stays, says so, and draws the lock', async () => {
        const { router, navigate, draw } = leaving();
        auth.logout.mockImplementation(async () => {
            auth.store.setState({ unlockedUserId: null });
            throw new Error('Network unreachable.');
        });
        await expect(leaveApp(router)).rejects.toThrow('unreachable');
        expect(navigate).not.toHaveBeenCalled();
        // Still signed in on the server, so the session is not forgotten here either.
        expect(forgetSession).not.toHaveBeenCalled();
        expect(draw()).toBeNull();
    });

    test('forgets every decrypted copy and the cache even when one part fails', async () => {
        const { router, clear } = leaving();
        memory.thumbnails.mockImplementation(() => {
            throw new Error('A thumbnail URL could not be revoked.');
        });
        await expect(leaveApp(router)).rejects.toThrow('revoked');
        expect(memory.previews).toHaveBeenCalledOnce();
        expect(memory.close).toHaveBeenCalledOnce();
        expect(memory.spaces).toHaveBeenCalledOnce();
        expect(clear).toHaveBeenCalledOnce();
    });
});
