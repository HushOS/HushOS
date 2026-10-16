import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';

/*
 * Replacing this account's identity sends the successor's consent with the
 * link (F8; docs/groups-server.md 5). Dropped, the link lands without it:
 * every family that walks it then reads this person's records as unchecked
 * until the backfill pass catches up, and once the server's consent gate is
 * on, the replacement is refused outright.
 */

const USER = '5d2c1b0a-3f4e-4d5c-8b7a-6e5f4d3c2b1a';
const auth = vi.hoisted(() => ({
    rpc: vi.fn(),
    succeedIdentity: vi.fn(),
    settings: vi.fn(),
    saveSettings: vi.fn(),
}));
vi.mock('@/lib/auth-client', () => ({
    authClient: {
        ...auth,
        store: { subscribe: () => () => {}, getState: () => ({ unlockedUserId: USER }) },
    },
}));
vi.mock('@/lib/drive-api', () => ({ onStaleIdentity: () => {} }));
vi.mock('@/lib/own-identity', () => ({
    openOwnIdentity: async () => ({ envelope: { keyVersion: 1 }, keyVersion: 1 }),
}));

const { succeedIdentity } = await import('./contacts');

describe('replacing this account’s identity', () => {
    test('sends the successor’s consent the worker signed, with the link', async () => {
        auth.settings.mockResolvedValue({
            settings: null,
            settingsKey: { nonce: 'n', ciphertext: 'c' },
            settingsVersion: 0,
        });
        auth.saveSettings.mockResolvedValue({ settingsVersion: 1 });
        auth.succeedIdentity.mockResolvedValue({ keyVersion: 2 });
        auth.rpc.mockImplementation(async (operation: string) => {
            if (operation === 'settingsSeal') return { envelope: { nonce: 'n', ciphertext: 'c' } };
            if (operation === 'identitySucceed')
                return { identity: { keyVersion: 2 }, signature: 'link', consent: 'both-halves' };
            return {};
        });
        await succeedIdentity(new QueryClient(), USER);
        expect(auth.succeedIdentity).toHaveBeenCalledWith({
            identity: { keyVersion: 2 },
            signature: 'link',
            consent: 'both-halves',
        });
    });
});
