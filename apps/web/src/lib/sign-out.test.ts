import { beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * What a removed browser clears (docs/devices-design.md, step 1). The auth client
 * acknowledges the removal, and so lets go of the cookie, only when this resolves;
 * a store that did not clear (IndexedDB busy in another tab) must reject, or the
 * stashed copies and mirror would stay with nothing left to try again. Signing
 * out goes on regardless, as before.
 */

const stores = vi.hoisted(() => ({ transfers: vi.fn(), mirror: vi.fn(), groups: vi.fn() }));
vi.mock('@/lib/transfers', () => ({ transfers: { forgetAll: stores.transfers } }));
vi.mock('@/lib/drive', () => ({ driveClient: { forgetMirror: stores.mirror } }));
vi.mock('@/lib/groups/store', () => ({ deleteGroupDevice: stores.groups }));
vi.mock('@/lib/auth-client', () => ({ authClient: { logout: vi.fn() } }));
vi.mock('@/lib/return-to', () => ({ forgetReturn: vi.fn() }));

const { clearDevice, forgetDevice } = await import('./sign-out');

beforeEach(() => {
    stores.transfers.mockResolvedValue(undefined);
    stores.mirror.mockResolvedValue(undefined);
    stores.groups.mockResolvedValue(undefined);
});

describe('clearing a removed browser', () => {
    test('resolves only once every store cleared', async () => {
        await expect(clearDevice()).resolves.toBeUndefined();
        expect(stores.transfers).toHaveBeenCalledOnce();
        expect(stores.mirror).toHaveBeenCalledOnce();
        expect(stores.groups).toHaveBeenCalledOnce();
    });

    test.each([
        ['the stashed uploads', 'transfers'],
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
});
