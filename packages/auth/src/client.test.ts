import { describe, expect, test } from 'vitest';
import type { AuthApi } from './api';
import type { CryptoTransport } from './crypto-transport';
import type { DeviceKeyStore } from './device-storage';
import type { SessionUser } from './protocol';

/*
 * Saving device access at sign-in. WebKit sometimes refuses to store the device key
 * in IndexedDB with DataCloneError; without a second try the browser forgets the
 * unlock and the next page asks for the password.
 */
const items = new Map<string, string>();
const localStorage = {
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => void items.set(name, value),
    removeItem: (name: string) => void items.delete(name),
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage, addEventListener() {}, removeEventListener() {} },
});

const { createAuthClient } = await import('./client');

const user = { id: '0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4', credentialVersion: 1 } as SessionUser;
const bundle = {
    version: 1 as const,
    keyVersion: 1,
    credentialVersion: 1,
    userId: user.id,
    deviceKeyId: 'device-key-1',
    nonce: 'AAAAAAAAAAAAAAAA',
    encryptedKey: 'B'.repeat(64),
};
const transport: CryptoTransport = {
    request: async (operation) => (operation === 'remember' ? bundle : {}) as never,
    lock() {},
    onLock() {},
};
const api = {
    loginStart: async () => ({ attemptToken: 'attempt' }),
    loginFinish: async () => ({ user, envelope: { keyVersion: 1, credentialVersion: 1 } }),
} as unknown as AuthApi;

/* A device key store whose create() fails with each of `failures` in turn, then works. */
function keyStore(failures: string[]) {
    let calls = 0;
    const store: DeviceKeyStore = {
        async create() {
            const failure = failures[calls++];
            if (failure) throw Object.assign(new Error(failure), { name: failure });
            return { id: 'device-key-1', key: {} as CryptoKey };
        },
        load: async () => null,
        clear: async () => {},
    };
    return { store, calls: () => calls };
}

async function signIn(failures: string[]) {
    items.clear();
    const keys = keyStore(failures);
    const client = createAuthClient(() => transport, keys.store, api);
    await client.login('maya@example.com', 'correct horse');
    return { state: client.store.getState(), calls: keys.calls() };
}

describe('saving device access at sign-in', () => {
    test('a DataCloneError from the key store is tried again and the unlock is saved', async () => {
        const { state, calls } = await signIn(['DataCloneError']);
        expect(calls).toBe(2);
        expect(state.device).toEqual(bundle);
        expect(state.rememberError).toBe('');
        expect(JSON.parse(items.get('hushos-device-unlock')!).state.device).toEqual(bundle);
    });

    test('a key store that keeps refusing is given up on after three tries', async () => {
        const { state, calls } = await signIn([
            'DataCloneError',
            'DataCloneError',
            'DataCloneError',
        ]);
        expect(calls).toBe(3);
        expect(state.device).toBeNull();
        expect(state.rememberError).not.toBe('');
    });

    test('any other failure is not retried', async () => {
        const { state, calls } = await signIn(['QuotaExceededError']);
        expect(calls).toBe(1);
        expect(state.device).toBeNull();
        expect(state.rememberError).not.toBe('');
    });
});
