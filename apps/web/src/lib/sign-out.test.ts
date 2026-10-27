import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type * as DeviceData from '@/lib/device-data';

/*
 * What a removed browser clears (docs/devices-design.md, step 1). The auth client
 * acknowledges the removal, and so lets go of the cookie, only when this resolves;
 * a store that did not clear (IndexedDB busy in another tab) must reject, or the
 * stashed copies and mirror would stay with nothing left to try again. Signing
 * out goes on regardless, as before.
 */

const stores = vi.hoisted(() => ({
    // Every store of an account, deleted by name once Drive's own parts are cleared.
    browser: vi.fn(),
    transfers: vi.fn(),
    stash: vi.fn(),
    // Uploads stopped before the logout, while the session can still release them.
    uploads: vi.fn(),
    groups: vi.fn(),
}));
/* What the open app holds in memory, and the auth client with a real store to lock. */
const memory = vi.hoisted(() => ({
    close: vi.fn(),
    spaces: vi.fn(),
    thumbnails: vi.fn(),
    previews: vi.fn(),
}));
/* Family work stopped at the start of a sign-out: no memory a page draws from goes with it. */
const stopSpaces = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({
    store: undefined as unknown as StoreApi<{ unlockedUserId: string | null }>,
    logout: vi.fn(),
}));
const forgetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/transfers', () => ({
    transfers: { forgetAll: stores.uploads, invalidate: stores.transfers },
}));
vi.mock('@/lib/stash', () => ({ forgetStash: stores.stash }));
vi.mock('@/lib/drive', () => ({
    driveClient: { close: memory.close },
    closeSpaces: memory.spaces,
    stopSpaces,
}));
vi.mock('@/lib/thumbnails', () => ({ forgetThumbnails: memory.thumbnails }));
vi.mock('@/lib/previews', () => ({ forgetPreviews: memory.previews }));
vi.mock('@/lib/groups/store', () => ({ deleteGroupDevice: stores.groups }));
vi.mock('@/lib/auth-client', () => ({ authClient: auth }));
vi.mock('@/lib/return-to', () => ({ forgetReturn: vi.fn() }));
vi.mock('@/lib/session', () => ({ forgetSession }));
const session = vi.hoisted(() => ({ signedOut: vi.fn() }));
vi.mock('@/lib/device-session', () => ({ deviceSession: session }));
const loadPage = vi.hoisted(() => vi.fn());
vi.mock('@/lib/load-page', () => ({ loadPage }));
const announced = vi.hoisted(() => vi.fn());
vi.mock('@/lib/device-data', async (importOriginal) => ({
    ...(await importOriginal<typeof DeviceData>()),
    forgetBrowserData: stores.browser,
    announceSignOut: announced,
}));

const {
    clearDevice,
    CLEAR_PART_MS,
    DeviceNotCleared,
    forgetDevice,
    leaveApp,
    signOut,
    NAVIGATE_TIMEOUT_MS,
    SIGN_OUT_TIMEOUT_MS,
    STOP_UPLOADS_MS,
} = await import('./sign-out');
const { useAuthView } = await import('./auth-view');
const {
    afterSignOut,
    markSignedOut,
    signOutSettled,
    SIGN_IN_WAIT_MS,
    SIGNED_OUT_MEANWHILE,
    UNFINISHED,
} = await import('./sign-in-gate');

beforeEach(() => {
    stores.browser.mockResolvedValue(undefined);
    stores.transfers.mockResolvedValue(undefined);
    stores.stash.mockResolvedValue(undefined);
    stores.uploads.mockResolvedValue(undefined);
    stores.groups.mockResolvedValue(undefined);
    auth.store = createStore(() => ({ unlockedUserId: 'maya' as string | null }));
    // Logging out locks this device at once, as the auth client does, then asks the server.
    auth.logout.mockImplementation(async () => auth.store.setState({ unlockedUserId: null }));
    for (const forget of Object.values(memory)) forget.mockImplementation(() => {});
});

describe('clearing a removed browser', () => {
    test('resolves only once every store cleared', async () => {
        await expect(clearDevice()).resolves.toBeUndefined();
        expect(stores.browser).toHaveBeenCalledOnce();
        expect(stores.transfers).toHaveBeenCalledOnce();
        expect(stores.stash).toHaveBeenCalledOnce();
        expect(stores.groups).toHaveBeenCalledOnce();
        // Nothing is opened to be emptied: an open waits behind a deletion another tab holds up.
        expect(stores.uploads).not.toHaveBeenCalled();
    });

    test.each([
        ['what this browser keeps for the account', 'browser'],
        ['the uploads and their journal', 'transfers'],
        ['the sealed stash', 'stash'],
        ['the families and their folders’ mirrors', 'groups'],
    ] as const)(
        'rejects when %s did not clear, so the removal is not acknowledged',
        async (_label, store) => {
            stores[store].mockRejectedValue(new Error('Device storage is busy in another tab.'));
            const failure = await clearDevice().catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(DeviceNotCleared);
            expect(String((failure as Error).cause)).toContain('busy');
            // Signing out does not care: it goes on and ends the session,
            // and says that something stayed rather than swallow it.
            const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
            await expect(forgetDevice()).resolves.toBe(false);
            expect(logged).toHaveBeenCalled();
        },
    );

    test('deletes the stores by name only once Drive’s parts stopped writing to them', async () => {
        let uploadsStopped = false;
        stores.transfers.mockImplementation(
            () =>
                new Promise((resolve) =>
                    setTimeout(() => {
                        uploadsStopped = true;
                        resolve(undefined);
                    }, 20),
                ),
        );
        let stoppedFirst: boolean | undefined;
        stores.browser.mockImplementation(async () => {
            stoppedFirst = uploadsStopped;
        });
        await clearDevice();
        // An upload still running would write its journal again after its database was deleted.
        expect(stoppedFirst).toBe(true);
    });

    test('settles, failing, when a store never answers, rather than wait on it', async () => {
        vi.useFakeTimers();
        try {
            const never = new Promise<undefined>(() => {});
            stores.groups.mockReturnValue(never);
            stores.browser.mockReturnValue(never);
            const failure = clearDevice().catch((error: unknown) => error);
            await vi.advanceTimersByTimeAsync(2 * CLEAR_PART_MS + 10);
            expect(await failure).toBeInstanceOf(DeviceNotCleared);
        } finally {
            vi.useRealTimers();
        }
    });

    test('deletes the stores by name even when a Drive part failed', async () => {
        stores.groups.mockRejectedValue(new Error('Device storage is busy in another tab.'));
        await expect(clearDevice()).rejects.toBeInstanceOf(DeviceNotCleared);
        expect(stores.browser).toHaveBeenCalledOnce();
    });

    test('clears every other store when one fails, then says it failed', async () => {
        stores.stash.mockRejectedValue(new Error('The stash could not be deleted.'));
        let familiesCleared = false;
        stores.groups.mockImplementation(
            () =>
                new Promise((resolve) =>
                    setTimeout(() => {
                        familiesCleared = true;
                        resolve(undefined);
                    }, 20),
                ),
        );
        const failure = await clearDevice().catch((error: unknown) => error);
        expect(String((failure as Error).cause)).toContain('could not be deleted');
        // Reported only after the slower stores finished, not as soon as the first one failed.
        expect(familiesCleared).toBe(true);
        expect(stores.transfers).toHaveBeenCalledOnce();
        expect(stores.groups).toHaveBeenCalledOnce();
    });
});

/*
 * Signing out from inside the app (leaveApp). The page being left draws the state the sign-out
 * started from until the sign-in page replaces it, while the keys are locked and the device
 * cleared underneath. After the navigation go the decrypted thumbnails and previews, the open
 * workspace and the query cache, and the device is cleared again, since a pull of the feed on
 * its way can write the tree back before the workspace is closed. A logout that fails or
 * stalls never leaves.
 */
describe('signing out of the app', () => {
    /* The tree on this device: written by a feed pull, deleted with the device's databases. */
    let mirrorRows = 0;
    beforeEach(() => {
        mirrorRows = 3;
        stores.browser.mockImplementation(async () => {
            mirrorRows = 0;
        });
    });

    function leaving(onNavigate: () => void | Promise<void> = () => {}) {
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
            seen.mirrorRows = mirrorRows;
            seen.memoryForgotten = Object.values(memory).some((forget) => forget.mock.calls.length);
            seen.cacheCleared = clear.mock.calls.length;
            await onNavigate();
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

    test('a database another tab never lets go of still lets leaving finish, and says what stayed', async () => {
        vi.useFakeTimers();
        try {
            const never = new Promise<undefined>(() => {});
            stores.browser.mockReturnValue(never);
            stores.groups.mockReturnValue(never);
            const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
            const { router, navigate } = leaving();
            let left = false;
            void leaveApp(router).then(() => (left = true));
            // The sign-out's own wipe, then the one after the page has gone: each part bounded.
            await vi.advanceTimersByTimeAsync(4 * CLEAR_PART_MS);
            expect(left).toBe(true);
            expect(navigate).toHaveBeenCalledOnce();
            // And the wait a sign-in makes on it is over too.
            let settled = false;
            void signOutSettled().then(() => (settled = true));
            await vi.advanceTimersByTimeAsync(10);
            expect(settled).toBe(true);
            const failures = logged.mock.calls
                .flat()
                .filter((value) => value instanceof DeviceNotCleared);
            expect(failures.length).toBeGreaterThanOrEqual(2);
        } finally {
            vi.useRealTimers();
        }
    });

    test('holds the page until the sign-in page replaces it, then forgets what it drew from', async () => {
        const { router, navigate, clear, draw, seen } = leaving();
        expect(draw()).toBe('maya');
        await leaveApp(router);
        expect(navigate).toHaveBeenCalledExactlyOnceWith({ to: '/login' });
        expect(seen).toEqual({
            // The page still drew the unlocked folder as it left...
            drawn: 'maya',
            // ...though its keys were already locked and the device's tree cleared.
            live: null,
            mirrorRows: 0,
            // What it drew from was still there for it until it had gone.
            memoryForgotten: false,
            cacheCleared: 0,
        });
        for (const forget of Object.values(memory)) expect(forget).toHaveBeenCalledOnce();
        expect(clear).toHaveBeenCalledOnce();
        // Released: whatever mounts next draws the truth.
        expect(draw()).toBeNull();
    });

    test('a feed pull that lands while leaving does not leave the tree on the device', async () => {
        // The pull was on its way before the sign-out began and writes after the first wipe.
        const { router } = leaving(() => {
            mirrorRows = 3;
        });
        await leaveApp(router);
        expect(mirrorRows).toBe(0);
        // Wiped again only once the workspace that pulls the feed was closed.
        const lastWipe = stores.browser.mock.invocationCallOrder.at(-1)!;
        expect(lastWipe).toBeGreaterThan(memory.close.mock.invocationCallOrder[0]!);
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
        // Try again is a new attempt, not the failed one again.
        auth.logout.mockImplementation(async () => {});
        await leaveApp(router);
        expect(auth.logout).toHaveBeenCalledTimes(2);
        expect(navigate).toHaveBeenCalledOnce();
    });

    /* A logout the server has not answered yet: it locks at once, as the auth client does. */
    function stalledLogout() {
        let answer!: () => void;
        auth.logout.mockImplementation(() => {
            auth.store.setState({ unlockedUserId: null });
            return new Promise<void>((resolve) => (answer = resolve));
        });
        return () => answer();
    }

    test('a logout that stalls is given up on, a retry joins it, and its late answer leaves', async () => {
        vi.useFakeTimers();
        try {
            const { router, navigate, draw } = leaving();
            const answer = stalledLogout();
            const first = leaveApp(router);
            const givenUp = expect(first).rejects.toThrow('too long');
            await vi.advanceTimersByTimeAsync(SIGN_OUT_TIMEOUT_MS);
            await givenUp;
            expect(navigate).not.toHaveBeenCalled();
            expect(draw()).toBeNull();
            // Try again while the first is still out: no second logout, which the client would
            // refuse while the first holds it.
            const retry = leaveApp(router);
            await vi.advanceTimersByTimeAsync(0);
            expect(auth.logout).toHaveBeenCalledOnce();
            answer();
            await retry;
            expect(navigate).toHaveBeenCalledOnce();
            expect(mirrorRows).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    test('a logout that answers after it was given up on still leaves, without a second press', async () => {
        vi.useFakeTimers();
        try {
            const { router, navigate, clear } = leaving();
            const answer = stalledLogout();
            const first = expect(leaveApp(router)).rejects.toThrow('too long');
            await vi.advanceTimersByTimeAsync(SIGN_OUT_TIMEOUT_MS);
            await first;
            answer();
            await vi.advanceTimersByTimeAsync(0);
            await signOutSettled();
            expect(navigate).toHaveBeenCalledExactlyOnceWith({ to: '/login' });
            for (const forget of Object.values(memory)) expect(forget).toHaveBeenCalledOnce();
            expect(clear).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    test('signed out on the server but the sign-in page did not open: it is loaded instead', async () => {
        const { router, clear } = leaving(() => {
            throw new Error('The sign-in page did not load.');
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        // Not a failure to the person: the session is gone, and Try again would only fail.
        await expect(leaveApp(router)).resolves.toBeUndefined();
        expect(loadPage).toHaveBeenCalledExactlyOnceWith('/login');
        // What the page drew from went before the document did.
        for (const forget of Object.values(memory)) expect(forget).toHaveBeenCalledOnce();
        expect(clear).toHaveBeenCalledOnce();
        expect(mirrorRows).toBe(0);
        expect(clear.mock.invocationCallOrder[0]).toBeLessThan(
            loadPage.mock.invocationCallOrder[0]!,
        );
    });

    test('a sign-in started while the last wipe waits does not lose its stores to it', async () => {
        // The second wipe of the families' stores waits on a database another tab holds.
        let families: string | null = 'old account';
        let unblock!: () => void;
        stores.groups
            .mockImplementationOnce(async () => {
                families = null;
            })
            .mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        unblock = () => {
                            families = null;
                            resolve();
                        };
                    }),
            );
        let signIn: Promise<unknown> | undefined;
        const signedIn = afterSignOut({
            login: async () => {
                families = 'new account';
            },
            register: async () => {},
            recover: async () => {},
            logout: async () => {},
        });
        // The person signs straight back in from the sign-in page.
        const { router } = leaving(() => {
            signIn = signedIn.login();
        });
        const left = leaveApp(router);
        await expect.poll(() => unblock).toBeDefined();
        unblock();
        await left;
        await signIn;
        expect(families).toBe('new account');
    });

    /* A client whose sign-ins say what they opened, behind the sign-out gate. */
    function sessions() {
        const opened: string[] = [];
        const closed: string[] = [];
        let finishLogin: (() => void) | undefined;
        const client = afterSignOut({
            login: async (who: string, slow = false) => {
                if (slow) await new Promise<void>((resolve) => (finishLogin = resolve));
                opened.push(who);
            },
            register: async () => {},
            recover: async () => {},
            logout: async () => {
                closed.push(opened.at(-1) ?? '');
            },
        });
        return { client, opened, closed, finishLogin: () => finishLogin?.() };
    }

    test('an unlock queued behind a stalled sign-out is refused once that sign-out lands', async () => {
        vi.useFakeTimers();
        try {
            const { router, navigate } = leaving();
            const answer = stalledLogout();
            const first = expect(leaveApp(router)).rejects.toThrow('too long');
            await vi.advanceTimersByTimeAsync(SIGN_OUT_TIMEOUT_MS);
            await first;
            // On the locked screen, the person unlocks while the logout is still out.
            const { client, opened } = sessions();
            const unlock = client.login('maya');
            const refused = expect(unlock).rejects.toThrow(SIGNED_OUT_MEANWHILE);
            answer();
            await vi.advanceTimersByTimeAsync(0);
            await refused;
            expect(navigate).toHaveBeenCalledOnce();
            // No session was opened behind the sign-in page.
            expect(opened).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    test('a sign-in that got its session as a sign-out landed signs out again', async () => {
        const { client, opened, closed, finishLogin } = sessions();
        const signIn = client.login('maya', true);
        const refused = expect(signIn).rejects.toThrow(SIGNED_OUT_MEANWHILE);
        await expect.poll(() => typeof finishLogin).toBe('function');
        markSignedOut();
        finishLogin();
        await refused;
        expect(opened).toEqual(['maya']);
        expect(closed).toEqual(['maya']);
    });

    test('a sign-out that never finishes holds sign-in only so long, then lets it go', async () => {
        vi.useFakeTimers();
        try {
            const { router } = leaving();
            const answer = stalledLogout();
            const left = expect(leaveApp(router)).rejects.toThrow('too long');
            const { client, opened } = sessions();
            const waiting = expect(client.login('maya')).rejects.toThrow(UNFINISHED);
            await vi.advanceTimersByTimeAsync(SIGN_IN_WAIT_MS);
            await left;
            await waiting;
            expect(opened).toEqual([]);
            // Let go: the next sign-in does not wait on it again.
            const next = client.login('maya');
            await vi.advanceTimersByTimeAsync(0);
            await next;
            expect(opened).toEqual(['maya']);
            // Clean up: the late answer finishes that sign-out.
            answer();
            await vi.advanceTimersByTimeAsync(0);
        } finally {
            vi.useRealTimers();
        }
    });

    test('a sign-in page that never opens is loaded from the server instead', async () => {
        vi.useFakeTimers();
        try {
            const { router, clear, draw } = leaving(() => new Promise(() => {}));
            const left = leaveApp(router);
            await vi.advanceTimersByTimeAsync(NAVIGATE_TIMEOUT_MS);
            vi.spyOn(console, 'error').mockImplementation(() => {});
            await left;
            expect(loadPage).toHaveBeenCalledExactlyOnceWith('/login');
            expect(clear).toHaveBeenCalledOnce();
            expect(draw()).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    test('forgets every decrypted copy and the cache even when one part fails, and says so only in the log', async () => {
        const { router, clear } = leaving();
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        memory.thumbnails.mockImplementation(() => {
            throw new Error('A thumbnail URL could not be revoked.');
        });
        // The person is on the sign-in page by now: nothing there says signing out failed.
        await expect(leaveApp(router)).resolves.toBeUndefined();
        expect(memory.previews).toHaveBeenCalledOnce();
        expect(memory.close).toHaveBeenCalledOnce();
        expect(memory.spaces).toHaveBeenCalledOnce();
        expect(clear).toHaveBeenCalledOnce();
        expect(logged).toHaveBeenCalled();
    });
});

describe('signing out, before the device is cleared', () => {
    test('family work stops first, while still unlocked, so no retry syncs into a store being deleted', async () => {
        const order: string[] = [];
        stopSpaces.mockImplementation(() => {
            order.push(`stop (unlocked: ${auth.store.getState().unlockedUserId})`);
        });
        stores.groups.mockImplementation(async () => {
            order.push('families store deleted');
        });
        await signOut();
        expect(order).toEqual(['stop (unlocked: maya)', 'families store deleted']);
    });

    test('other tabs hear of it first, then the session ends, then the device is cleared', async () => {
        await signOut();
        const first = (mock: { mock: { invocationCallOrder: number[] } }) =>
            mock.mock.invocationCallOrder[0]!;
        expect(first(announced)).toBeLessThan(first(auth.logout));
        // Nothing new is queued to upload from before the uploads are stopped.
        expect(first(session.signedOut)).toBeLessThan(first(stores.uploads));
        expect(first(auth.logout)).toBeLessThan(first(stores.browser));
        expect(first(auth.logout)).toBeLessThan(first(stores.groups));
    });

    test('the session ends only after other tabs released their uploads, or stopped being waited on', async () => {
        let released!: () => void;
        announced.mockReturnValue(
            new Promise((resolve) => {
                released = () => resolve({ heard: 1, released: 1 });
            }),
        );
        const signingOut = signOut();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(auth.logout).not.toHaveBeenCalled();
        released();
        await signingOut;
        expect(auth.logout).toHaveBeenCalledOnce();
    });

    test('a database delete that never answers never keeps the server session from ending', async () => {
        const never = new Promise<undefined>(() => {});
        stores.browser.mockReturnValue(never);
        stores.groups.mockReturnValue(never);
        void signOut();
        await vi.waitFor(() => expect(auth.logout).toHaveBeenCalledOnce());
    });

    test('uploads that never stop hold the session up only so long', async () => {
        vi.useFakeTimers();
        try {
            stores.uploads.mockReturnValue(new Promise(() => {}));
            const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
            void signOut();
            await vi.advanceTimersByTimeAsync(STOP_UPLOADS_MS - 10);
            expect(auth.logout).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(20);
            expect(auth.logout).toHaveBeenCalledOnce();
            expect(logged).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
