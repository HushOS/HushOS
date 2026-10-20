import {
    createDeviceSigningKey,
    deviceSessionStatement,
    emailDigest,
} from '@hushos/crypto/device-identity';
import { describe, expect, test } from 'vitest';
import type { AuthApi } from './api';
import type { CryptoTransport } from './crypto-transport';
import {
    DeviceStorageBlocked,
    DeviceStorageTimeout,
    DeviceStorageUnavailable,
    type DeviceIdentityStore,
    type DeviceKeyStore,
    type StoredDeviceIdentity,
} from './device-storage';
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
/* `pagehide` listeners, so a test can leave the page. */
const pagehide = new Set<() => void>();
Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
        localStorage,
        addEventListener(type: string, listener: () => void) {
            if (type === 'pagehide') pagehide.add(listener);
        },
        removeEventListener() {},
    },
});

const { createAuthClient, DeviceStorageUnreadable } = await import('./client');

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

/*
 * A device store that is blocked (another tab holding it), slow (the open gave up) or could not
 * be opened is not a store without a key. Signing in past it would register this browser as a
 * new device, with a notice and an email about a sign-in that may have been this device all
 * along. So the store is read before the sign-in begins, and a store that did not answer stops
 * it with a reason and a choice; only "no key" signs in as a new device without asking.
 */
describe('a device store that does not answer at sign-in', () => {
    const deviceId = '5b1c0d9e-8f7a-4c3b-9a2d-1e0f2a3b4c5d';
    const blocked = async () => {
        throw new DeviceStorageBlocked();
    };
    const slow = async () => {
        throw new DeviceStorageTimeout();
    };
    const unavailable = async () => {
        throw new DeviceStorageUnavailable({
            cause: new DOMException('Internal error opening backing store.', 'UnknownError'),
        });
    };

    async function client(answers: (() => Promise<StoredDeviceIdentity | null>)[]) {
        items.clear();
        const key = await createDeviceSigningKey();
        if (!key) throw new Error('This runtime has no Ed25519 in Web Crypto.');
        const stored: StoredDeviceIdentity = {
            userId: user.id,
            emailHash: await emailDigest('maya@example.com'),
            deviceId,
            privateKey: key.privateKey,
            publicKey: key.publicKey,
        };
        let reads = 0;
        let cleared = 0;
        const identities: DeviceIdentityStore = {
            load: async () => {
                const answer = answers[reads++] ?? (async () => stored);
                return answer();
            },
            save: async () => {},
            clear: async () => void cleared++,
        };
        const calls: string[] = [];
        const finished: { device?: { id: string } }[] = [];
        let registered = 0;
        const signing = {
            ...api,
            loginStart: async () => {
                calls.push('loginStart');
                return { attemptToken: 'attempt' };
            },
            loginFinish: async (input: (typeof finished)[number]) => {
                finished.push(input);
                return {
                    user: { ...user, email: 'maya@example.com' },
                    envelope: { keyVersion: 1, credentialVersion: 1 },
                    // A sign-in without a proof is a new device the server has not described yet.
                    device: input.device
                        ? { id: deviceId, attached: true, registered: true }
                        : { id: 'new-device', attached: false, registered: false },
                };
            },
            session: async () => ({
                user: { ...user, email: 'maya@example.com' },
                device: { id: 'new-device', registered: false },
            }),
            registerDevice: async () => {
                registered++;
                return { device: { id: 'new-device' } };
            },
            registerStart: async () => ({}),
            registerFinish: async () => ({}),
            recoverStart: async () => ({
                userId: user.id,
                attemptToken: 'recover',
                credentialVersion: 1,
            }),
            recoverFinish: async () => ({}),
            securityStart: async ({ action }: { action: string }) => ({
                userId: user.id,
                action,
                attemptToken: 'security',
            }),
            securityFinish: async () => ({}),
        } as unknown as AuthApi;
        const auth = createAuthClient(() => transport, keyStore([]).store, signing, {
            identities,
            describeDevice: () => ({ kind: 'web', name: 'Test browser' }),
        });
        return {
            auth,
            calls,
            finished,
            reads: () => reads,
            registered: () => registered,
            cleared: () => cleared,
        };
    }
    async function refused(promise: Promise<unknown>) {
        const error = await promise.then(
            () => {
                throw new Error('expected the sign-in to stop');
            },
            (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(DeviceStorageUnreadable);
        return error as InstanceType<typeof DeviceStorageUnreadable>;
    }

    test.each([
        ['blocked', blocked, true],
        ['timeout', slow, false],
    ] as const)(
        'read again once when %s, then stops before the password is checked',
        async (reason, fail, blamesTabs) => {
            const { auth, calls, finished, reads, registered } = await client([fail, fail]);
            const error = await refused(auth.login('maya@example.com', 'correct horse'));
            expect(error.reason).toBe(reason);
            expect(error.message.includes('other HushOS tabs')).toBe(blamesTabs);
            expect(error.message).toContain('sign in as a new device');
            expect(reads()).toBe(2);
            // Read before the sign-in began: no password check, no attempt spent, no session.
            expect(calls).toEqual([]);
            expect(finished).toEqual([]);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(registered()).toBe(0);
            expect(auth.store.getState().unlockedUserId).toBeNull();
        },
    );

    test('a store that could not be opened is not read again and does not blame other tabs', async () => {
        const { auth, calls, reads } = await client([unavailable, unavailable]);
        const error = await refused(auth.login('maya@example.com', 'correct horse'));
        expect(error.reason).toBe('unavailable');
        expect(error.message).not.toContain('tabs');
        expect(reads()).toBe(1);
        expect(calls).toEqual([]);
    });

    test('signs in as this device when the store answers the second time', async () => {
        const { auth, finished, reads, registered } = await client([blocked]);
        await auth.login('maya@example.com', 'correct horse');
        expect(reads()).toBe(2);
        expect(finished).toHaveLength(1);
        expect(finished[0]!.device?.id).toBe(deviceId);
        expect(registered()).toBe(0);
    });

    test('signs in as a new device, without asking, when the store answers it holds no key', async () => {
        const { auth, finished, registered } = await client([async () => null]);
        await auth.login('maya@example.com', 'correct horse');
        expect(finished).toHaveLength(1);
        expect(finished[0]!.device).toBeUndefined();
        await expect.poll(registered).toBe(1);
    });

    test('signs in as a new device when the person chooses it, without reading the store', async () => {
        const { auth, finished, reads, registered } = await client([unavailable]);
        await auth.login('maya@example.com', 'correct horse', { asNewDevice: true });
        expect(reads()).toBe(0);
        expect(finished[0]!.device).toBeUndefined();
        await expect.poll(registered).toBe(1);
    });

    test('a new account signs in without reading the store', async () => {
        const { auth, reads, finished } = await client([unavailable]);
        await auth.register('maya@example.com', 'Maya', 'correct horse');
        expect(reads()).toBe(0);
        expect(finished).toHaveLength(1);
    });

    test('a reset with the recovery phrase says why it did not sign in here', async () => {
        const { auth, calls } = await client([unavailable]);
        const error = await auth.recover('maya@example.com', 'new horse', 'words').then(
            () => null,
            (caught: unknown) => caught as Error,
        );
        expect(error?.message).toBe(
            'Your password was changed, but this browser’s storage for HushOS can’t be read, so you weren’t signed in here. Sign in with your new password.',
        );
        expect(calls).toEqual([]);
    });

    test('a password change that cannot sign in here leaves the person signed out with the reason, the device key kept', async () => {
        const { auth, calls, cleared } = await client([blocked, blocked]);
        const result = await auth.changeSecurity(
            { ...user, email: 'maya@example.com' } as SessionUser,
            'password',
            'correct horse',
            'new horse',
        );
        expect(result).toEqual({ signedIn: false, uncertain: false, storage: 'blocked' });
        expect(calls).toEqual([]);
        const state = auth.store.getState();
        expect(state.unlockedUserId).toBeNull();
        expect(state.device).toBeNull();
        // The device's own key stays: the next sign-in here can still prove this device.
        expect(cleared()).toBe(0);
    });
});

/*
 * Restoring the saved unlock on a fresh page. Only a verdict on the saved access erases it:
 * the device key gone, the worker finding the two do not open, or the server saying the
 * session or device is gone. Anything that merely cuts the restore short keeps it, or a person
 * who clicks away while Drive opens is asked for the password on the next visit.
 */
describe('restoring the saved unlock', () => {
    const savedDevice = () =>
        (JSON.parse(items.get('hushos-device-unlock')!) as { state: { device: unknown } }).state
            .device;

    /*
     * A transport like the browser's: `restore` waits for the worker, unless `answer` says how
     * it ends, and a lock rejects what is in flight. `opening` settles once the worker was asked.
     */
    function restoreClient(
        options: {
            answer?: () => Promise<never>;
            load?: () => Promise<CryptoKey | null>;
            session?: () => Promise<unknown>;
        } = {},
    ) {
        items.clear();
        pagehide.clear();
        items.set(
            'hushos-device-unlock',
            JSON.stringify({ state: { device: bundle, lockRevision: 3 }, version: 1 }),
        );
        let asked!: () => void;
        const opening = new Promise<void>((resolve) => (asked = resolve));
        const pending = new Set<(error: Error) => void>();
        const browserLike: CryptoTransport = {
            request: (operation) => {
                if (operation !== 'restore') return Promise.resolve({} as never);
                asked();
                if (options.answer) return options.answer();
                return new Promise<never>((_, reject) => pending.add(reject));
            },
            lock() {
                for (const reject of pending) reject(new Error('Your account was locked.'));
                pending.clear();
            },
            onLock() {},
        };
        const keys = keyStore([]).store;
        const auth = createAuthClient(
            () => browserLike,
            { ...keys, load: options.load ?? (async () => ({}) as CryptoKey) },
            { ...api, session: options.session } as unknown as AuthApi,
        );
        return { auth, opening };
    }

    test('leaving the page while the worker opens the key keeps it', async () => {
        const { auth, opening } = restoreClient();
        const restoring = auth.restore(user, { validated: true });
        await opening;
        for (const leave of pagehide) leave();
        await restoring;
        expect(auth.store.getState().unlockedUserId).toBeNull();
        expect(savedDevice()).toEqual(bundle);
    });

    test('device storage that fails to answer keeps it', async () => {
        const { auth } = restoreClient({
            load: () => Promise.reject(new Error('Device storage is busy in another tab.')),
        });
        await auth.restore(user, { validated: true });
        expect(savedDevice()).toEqual(bundle);
        expect(auth.store.getState().rememberError).toMatch(/password/);
    });

    test('a worker that fails without a verdict keeps it', async () => {
        const { auth } = restoreClient({
            answer: () => Promise.reject(new Error('Something went wrong on this device.')),
        });
        await auth.restore(user, { validated: true });
        expect(savedDevice()).toEqual(bundle);
    });

    test('a saved access the worker cannot open with its device key is erased', async () => {
        const { auth } = restoreClient({
            answer: () =>
                Promise.reject(
                    Object.assign(new Error('The saved account key does not open.'), {
                        invalid: true,
                    }),
                ),
        });
        await auth.restore(user, { validated: true });
        expect(auth.store.getState().unlockedUserId).toBeNull();
        expect(savedDevice()).toBeNull();
    });

    test('a device key gone from this browser erases it', async () => {
        const { auth } = restoreClient({ load: async () => null });
        await auth.restore(user, { validated: true });
        expect(savedDevice()).toBeNull();
    });

    test('a session that ended, or moved to a newer password, erases it', async () => {
        for (const answer of [
            { user: null, device: null },
            { user: { ...user, credentialVersion: 2 }, device: null },
        ]) {
            const { auth } = restoreClient({ session: async () => answer });
            await auth.restore(user);
            expect(savedDevice()).toBeNull();
        }
    });
});

describe('a device the server says was removed', () => {
    /*
     * `answers`: what the server says at each session check, in order; the last repeats.
     * `onRemoved` stands for the app's clearDevice, which rejects when a store did not clear.
     */
    function removedClient(
        answers: ('removed' | 'signed-in')[],
        options: { appFails?: boolean; appThrowsNothing?: boolean } = {},
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
                    if (options.appThrowsNothing) throw undefined;
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

    test('found by a restore, loses the saved unlock and the device key', async () => {
        const { auth, seen } = removedClient(['removed']);
        await auth.restore(user);
        expect(auth.store.getState().unlockedUserId).toBeNull();
        expect(JSON.parse(items.get('hushos-device-unlock')!).state.device).toBeNull();
        expect(seen.identity).toBeNull();
        expect([seen.keys, seen.app, seen.forgotten]).toEqual([1, 1, 1]);
    });

    test('an app wipe that fails still clears the device key and identity, and is tried again', async () => {
        const { auth, seen } = removedClient(['removed'], { appFails: true });
        await auth.session();
        // The saved unlock, the device key and the identity go whatever the app's copies did.
        expect(JSON.parse(items.get('hushos-device-unlock')!).state.device).toBeNull();
        expect(seen.keys).toBe(1);
        expect(seen.identity).toBeNull();
        // Not acknowledged, so the next check tries the app's copies again.
        expect(seen.forgotten).toBe(0);
        await auth.session();
        expect(seen.app).toBe(2);
    });

    test('an app wipe that throws nothing at all still counts as failed, and is not acknowledged', async () => {
        const { auth, seen } = removedClient(['removed'], { appThrowsNothing: true });
        await auth.session();
        expect(seen.keys).toBe(1);
        expect(seen.forgotten).toBe(0);
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
