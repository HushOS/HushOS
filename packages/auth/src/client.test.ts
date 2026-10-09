import { beforeEach, describe, expect, test } from 'vitest';
import type { AuthApi } from './api';
import type { CryptoTransport } from './crypto-transport';
import type { DeviceKeyStore } from './device-storage';
import type { SessionUser } from './protocol';

/*
 * Restoring a saved unlock on a page that just loaded. WebKit has handed such a page
 * an older localStorage value with the unlock written over, so restore also reads the
 * copy committed beside the device key. That copy must open the account only for the
 * sign-in it was made for, and never after a deliberate lock.
 */
const items = new Map<string, string>();
const localStorage = {
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => void items.set(name, value),
    removeItem: (name: string) => void items.delete(name),
    get length() {
        return items.size;
    },
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage, addEventListener() {}, removeEventListener() {} },
});

const { createAuthClient } = await import('./client');

const USER_ID = '0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const KEY_ID = '5d2c8ae0-1111-4222-8333-944455556666';
const user = { id: USER_ID, credentialVersion: 1 } as SessionUser;
const bundle = {
    version: 1 as const,
    keyVersion: 1,
    credentialVersion: 1,
    userId: USER_ID,
    deviceKeyId: KEY_ID,
    nonce: 'AAAAAAAAAAAAAAAA',
    encryptedKey: 'B'.repeat(64),
};
const deviceKey = {} as CryptoKey;

/* The device key store, in memory, with the same rules: create and clear drop the copy. */
function keyStore() {
    const entries = new Map<string, unknown>();
    const store: DeviceKeyStore = {
        async create() {
            entries.clear();
            entries.set(KEY_ID, deviceKey);
            return { id: KEY_ID, key: deviceKey };
        },
        load: async (id) => (entries.get(id) as CryptoKey | undefined) ?? null,
        keep: async (value) => void entries.set('unlock', value),
        kept: async () => entries.get('unlock') ?? null,
        clear: async () => entries.clear(),
    };
    return { store, entries };
}

/* The crypto worker: records what it was asked to restore, answers sign-in steps. */
function transport(restored: unknown[]): CryptoTransport {
    return {
        async request(operation, input) {
            if (operation === 'restore') restored.push((input as { bundle: unknown }).bundle);
            if (operation === 'remember') return bundle as never;
            return {} as never;
        },
        lock() {},
        onLock() {},
    };
}

const api = {
    loginStart: async () => ({ attemptToken: 'attempt' }),
    loginFinish: async () => ({
        user,
        envelope: { keyVersion: 1, credentialVersion: 1 },
    }),
    session: async () => ({ user }),
} as unknown as AuthApi;

/* The shared copy as WebKit handed it to the next page: written over, never locked. */
function sharedWrittenOver() {
    items.set(
        'hushos-device-unlock',
        JSON.stringify({ state: { device: null, lockRevision: 0 }, version: 1 }),
    );
}

beforeEach(() => items.clear());

describe('restoring a saved unlock', () => {
    test('signing in keeps a committed copy beside the device key', async () => {
        const { store, entries } = keyStore();
        const client = createAuthClient(() => transport([]), store, api);
        await client.login('maya@example.com', 'correct horse');
        expect(entries.get('unlock')).toEqual(bundle);
    });

    test('opens from that copy when the shared one was written over', async () => {
        const { store } = keyStore();
        await store.create();
        await store.keep(bundle);
        sharedWrittenOver();
        const restored: unknown[] = [];
        const client = createAuthClient(() => transport(restored), store, api);
        await client.restore(user, { validated: true });
        expect(client.store.getState().unlockedUserId).toBe(USER_ID);
        expect(restored).toEqual([bundle]);
    });

    test('a copy made for an earlier sign-in stays locked', async () => {
        const { store } = keyStore();
        await store.create();
        await store.keep({ ...bundle, credentialVersion: 1 });
        sharedWrittenOver();
        const restored: unknown[] = [];
        const client = createAuthClient(() => transport(restored), store, api);
        await client.restore({ ...user, credentialVersion: 2 }, { validated: true });
        expect(client.store.getState().unlockedUserId).toBeNull();
        expect(restored).toEqual([]);
    });

    test('a copy for another account stays locked', async () => {
        const { store } = keyStore();
        await store.create();
        await store.keep(bundle);
        sharedWrittenOver();
        const restored: unknown[] = [];
        const client = createAuthClient(() => transport(restored), store, api);
        const other = { ...user, id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' };
        await client.restore(other, { validated: true });
        expect(client.store.getState().unlockedUserId).toBeNull();
        expect(restored).toEqual([]);
    });

    test('after a deliberate lock nothing brings the unlock back', async () => {
        const { store } = keyStore();
        const signedIn = createAuthClient(() => transport([]), store, api);
        await signedIn.login('maya@example.com', 'correct horse');
        await signedIn.lock();
        const restored: unknown[] = [];
        const nextPage = createAuthClient(() => transport(restored), store, api);
        await nextPage.restore(user, { validated: true });
        expect(nextPage.store.getState().unlockedUserId).toBeNull();
        expect(restored).toEqual([]);
    });
});
