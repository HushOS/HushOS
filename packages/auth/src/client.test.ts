import {
    createDeviceSigningKey,
    deviceSessionStatement,
    emailDigest,
} from '@hushos/crypto/device-identity';
import { describe, expect, test } from 'vitest';
import type { AuthApi } from './api';
import type { CryptoTransport } from './crypto-transport';
import type { DeviceIdentityStore, DeviceKeyStore, StoredDeviceIdentity } from './device-storage';
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
const tabItems = new Map<string, string>();
Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
        getItem: (name: string) => tabItems.get(name) ?? null,
        setItem: (name: string, value: string) => void tabItems.set(name, value),
        removeItem: (name: string) => void tabItems.delete(name),
    },
});
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

describe('a worker refusal', () => {
    test('that kept the keys, or of a family, leaves the account unlocked; any other failure locks it', async () => {
        items.clear();
        const refusing: CryptoTransport = {
            request: async (operation) => {
                if (operation === 'identitySucceed')
                    throw Object.assign(new Error('Your keys changed on another device.'), {
                        kept: true,
                    });
                if (operation === 'identityOpen') throw new Error('Identity keys do not match.');
                if (operation === 'groupAccept')
                    throw new Error('The server sent a member list this device cannot read.');
                return (operation === 'remember' ? bundle : {}) as never;
            },
            lock() {},
            onLock() {},
        };
        const client = createAuthClient(() => refusing, keyStore([]).store, api);
        await client.login('maya@example.com', 'correct horse');
        expect(client.store.getState().unlockedUserId).toBe(user.id);
        await expect(client.rpc('identitySucceed', {} as never)).rejects.toThrow('changed');
        expect(client.store.getState().unlockedUserId).toBe(user.id);
        // A family the server serves a bad member list for is that family's problem: refusing it
        // must not lock the account, or the server could lock it on every sync.
        await expect(client.rpc('groupAccept', {} as never)).rejects.toThrow('member list');
        expect(client.store.getState().unlockedUserId).toBe(user.id);
        await expect(client.rpc('identityOpen', {} as never)).rejects.toThrow('do not match');
        expect(client.store.getState().unlockedUserId).toBeNull();
    });
});

/*
 * The device key at sign-in (docs/devices-design.md): the proof goes only with a
 * sign-in to the account the key was made for, it signs this attempt, and the key
 * outlives a lock but not a sign-out.
 */
describe('the device key at sign-in', () => {
    const deviceId = '5b1c0d9e-8f7a-4c3b-9a2d-1e0f2a3b4c5d';

    async function client() {
        items.clear();
        const key = await createDeviceSigningKey();
        if (!key) throw new Error('This runtime has no Ed25519 in Web Crypto.');
        let stored: StoredDeviceIdentity | null = {
            userId: user.id,
            emailHash: await emailDigest('maya@example.com'),
            deviceId,
            privateKey: key.privateKey,
            publicKey: key.publicKey,
        };
        const identities: DeviceIdentityStore = {
            load: async () => stored,
            save: async (identity) => void (stored = identity),
            clear: async () => void (stored = null),
        };
        const sent: { attemptToken: string; device?: { id: string; signature: string } }[] = [];
        let attempt = 0;
        const signing = {
            ...api,
            loginStart: async () => ({ attemptToken: `attempt-${++attempt}` }),
            loginFinish: async (input: (typeof sent)[number]) => {
                sent.push(input);
                return {
                    user: { ...user, email: 'maya@example.com' },
                    envelope: { keyVersion: 1, credentialVersion: 1 },
                    device: { id: deviceId, attached: true, registered: true },
                };
            },
            logout: async () => ({}),
        } as unknown as AuthApi;
        const auth = createAuthClient(() => transport, keyStore([]).store, signing, {
            identities,
            describeDevice: () => ({ kind: 'web', name: 'Test browser' }),
        });
        return { auth, sent, key, stored: () => stored };
    }

    test('a key made for one email sends no proof when another signs in here', async () => {
        const { auth, sent } = await client();
        await auth.login('sam@example.com', 'correct horse');
        expect(sent).toHaveLength(1);
        expect(sent[0]!.device).toBeUndefined();
    });

    test('for its own email, the proof names the device and holds for this attempt only', async () => {
        const { auth, sent, key } = await client();
        // Typed with other case and spaces: the same account.
        await auth.login('  Maya@Example.com ', 'correct horse');
        const proof = sent[0]!.device!;
        expect(proof.id).toBe(deviceId);
        const publicKey = await crypto.subtle.importKey(
            'raw',
            Uint8Array.from(atob(key.publicKey.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
                c.charCodeAt(0),
            ),
            { name: 'Ed25519' },
            false,
            ['verify'],
        );
        const signature = Uint8Array.from(
            atob(proof.signature.replaceAll('-', '+').replaceAll('_', '/')),
            (c) => c.charCodeAt(0),
        );
        const verify = async (attemptToken: string) =>
            crypto.subtle.verify(
                { name: 'Ed25519' },
                publicKey,
                signature,
                await deviceSessionStatement({ userId: user.id, deviceId, attemptToken }),
            );
        expect(await verify(sent[0]!.attemptToken)).toBe(true);
        expect(await verify('attempt-2')).toBe(false);
    });

    test('locking keeps the device key; signing out clears it', async () => {
        const { auth, stored } = await client();
        await auth.login('maya@example.com', 'correct horse');
        await auth.lock();
        expect(stored()?.deviceId).toBe(deviceId);
        await auth.logout();
        expect(stored()).toBeNull();
    });
});

describe('a device the server says was removed', () => {
    /*
     * `answers`: what the server says at each session check, in order; the last repeats.
     * `onRemoved` stands for the app's clearDevice, which rejects when a store did not clear.
     */
    function removedClient(
        answers: ('removed' | 'signed-in')[],
        options: { appFails?: boolean } = {},
    ) {
        items.clear();
        // A saved unlock from an earlier visit; this page never restored it (the sign-in page).
        items.set(
            'hushos-device-unlock',
            JSON.stringify({ state: { device: bundle, lockRevision: 3 }, version: 1 }),
        );
        const seen = {
            identity: { deviceId: 'd' } as StoredDeviceIdentity | null,
            keys: 0,
            app: 0,
            forgotten: 0,
            logouts: 0,
        };
        let asked = 0;
        const removedApi = {
            ...api,
            session: async () => {
                const answer = answers[Math.min(asked++, answers.length - 1)];
                return answer === 'removed'
                    ? { user: null, device: null, removed: true }
                    : { user, device: { id: 'new', registered: true } };
            },
            forgetSession: async () => {
                seen.forgotten++;
                return { forgotten: true };
            },
            logout: async () => void seen.logouts++,
        } as unknown as AuthApi;
        const store = keyStore([]).store;
        const auth = createAuthClient(
            () => transport,
            { ...store, clear: async () => void seen.keys++ },
            removedApi,
            {
                identities: {
                    load: async () => seen.identity,
                    save: async () => {},
                    clear: async () => void (seen.identity = null),
                },
                onRemoved: async () => {
                    seen.app++;
                    if (options.appFails) throw new Error('Device storage is busy in another tab.');
                },
            },
        );
        return { auth, seen };
    }

    test('loses its saved unlock, its device key and the app’s copies, then lets go of the cookie, even before anything loaded', async () => {
        const { auth, seen } = removedClient(['removed']);
        expect((await auth.session()).user).toBeNull();
        expect(JSON.parse(items.get('hushos-device-unlock')!).state.device).toBeNull();
        expect(seen.identity).toBeNull();
        expect([seen.keys, seen.app]).toEqual([1, 1]);
        // Acknowledged, never signed out: sign-out would end a session someone just opened.
        expect([seen.forgotten, seen.logouts]).toEqual([1, 0]);
        expect(auth.takeRemovedNotice()).toBe(true);
        expect(auth.takeRemovedNotice()).toBe(false);
    });

    test('a wipe cut short is not acknowledged, so the next check tries again', async () => {
        const { auth, seen } = removedClient(['removed'], { appFails: true });
        await auth.session();
        expect(seen.forgotten).toBe(0);
        // The keys come after the app's copies: nothing past the failure was touched.
        expect(seen.keys).toBe(0);
        await auth.session();
        expect(seen.app).toBe(2);
    });

    test('someone signing in again meanwhile stops the wipe before it reaches their keys', async () => {
        // Removed at first; by the check after the app's copies, a new session is there.
        const { auth, seen } = removedClient(['removed', 'removed', 'signed-in']);
        await auth.session();
        expect(seen.app).toBe(1);
        expect(seen.keys).toBe(0);
        expect(seen.identity).not.toBeNull();
        expect(seen.forgotten).toBe(0);
    });

    test('a session that merely ended keeps them', async () => {
        items.clear();
        items.set(
            'hushos-device-unlock',
            JSON.stringify({ state: { device: bundle, lockRevision: 3 }, version: 1 }),
        );
        let identity: StoredDeviceIdentity | null = { deviceId: 'd' } as StoredDeviceIdentity;
        const endedApi = {
            ...api,
            session: async () => ({ user: null, device: null }),
        } as unknown as AuthApi;
        const auth = createAuthClient(() => transport, keyStore([]).store, endedApi, {
            identities: {
                load: async () => identity,
                save: async () => {},
                clear: async () => void (identity = null),
            },
        });
        await auth.session();
        expect(JSON.parse(items.get('hushos-device-unlock')!).state.device).toEqual(bundle);
        expect(identity).not.toBeNull();
    });
});
