import {
    createCryptoSession,
    OPAQUE_IDENTIFIERS,
    OPAQUE_PROFILE_VERSION,
    type CryptoRequests,
    type CryptoResults,
} from '@hushos/crypto';
import { createDeviceKey } from '@hushos/crypto/device';
import { ready, server } from '@hushos/crypto/server';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AuthApi, StepChallenge } from './api';
import type { DeviceKeyStore } from './device-storage';
import type { SessionUser } from './protocol';

/*
 * What a sign-in or a security change holds in the worker between its two halves, and until
 * the account opens: the password, its OPAQUE state, then the export key. Anything else that
 * reaches the worker meanwhile can end it: an account operation that fails makes the worker
 * start over (worker.ts), the saved unlock's restore starts its state over, and a lock ends the
 * worker itself. A person then reads "Security change expired" or "Sign-in expired" on a first
 * try, for something they did not do.
 *
 * The worker here is the real one, run in process: the transport, the worker's handler and the
 * crypto session, one per worker the client starts, with a real OPAQUE server behind the API
 * stand-in. So each test fails on what the person would meet, not on a copy of the rule.
 */
const items = new Map<string, string>();
const localStorage = {
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => void items.set(name, value),
    removeItem: (name: string) => void items.delete(name),
};
/* The page's listeners as the auth client registered them: `pagehide` is its lock. */
const listeners = new Map<string, () => void>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: localStorage });
Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
        localStorage,
        addEventListener: (type: string, listener: () => void) =>
            void listeners.set(type, listener),
        removeEventListener() {},
    },
});
// As in a worker, `self` is the global scope: the OPAQUE module looks for its randomness there
// first, and would otherwise take the `window` stand-in above, which has none.
vi.stubGlobal('self', globalThis);

const { serve } = await import('./worker-handler');
const { createBrowserCryptoTransport } = await import('./crypto-transport');
const { createAuthClient, StepCancelled } = await import('./client');

const PASSWORD = 'correct horse battery staple 9';
const NEXT = 'a new password for the account 4';
const user = {
    id: '0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4',
    email: 'maya@example.com',
    credentialVersion: 1,
} as SessionUser;
const device = { id: 'device', attached: false, registered: true };

/* The account as the server keeps it, made once by a real registration in a worker session. */
let serverSetup: string;
let made: CryptoResults['registerFinish'];
beforeAll(async () => {
    await ready;
    serverSetup = server.createSetup();
    const session = createCryptoSession();
    const call = <K extends keyof CryptoRequests>(operation: K, input: CryptoRequests[K]) =>
        session.handle({ id: 0, operation, input } as Parameters<
            typeof session.handle
        >[0]) as Promise<CryptoResults[K]>;
    const { registrationRequest } = await call('registerStart', { password: PASSWORD });
    made = await call('registerFinish', {
        registrationResponse: registrationResponse(registrationRequest),
        userId: user.id,
        profileVersion: OPAQUE_PROFILE_VERSION,
    });
});
beforeEach(() => {
    items.clear();
    listeners.clear();
    vi.spyOn(console, 'info').mockImplementation(() => {});
});

const registrationResponse = (registrationRequest: string) =>
    server.createRegistrationResponse({ serverSetup, userIdentifier: user.id, registrationRequest })
        .registrationResponse;

/*
 * The workers the client starts, each the real handler over a session of its own, as a new
 * Worker is. `stall` leaves an operation unanswered, as a worker still at work on it would;
 * `sent` resolves once one was posted.
 */
function workers() {
    const stalled = new Set<string>();
    const awaited = new Map<string, () => void>();
    let started = 0;
    const create = () => {
        started++;
        let alive = true;
        const worker = {
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null,
            postMessage(data: { operation: string }) {
                if (!stalled.has(data.operation)) void handle({ data } as never);
                awaited.get(data.operation)?.();
            },
            terminate() {
                alive = false;
            },
        };
        const handle = serve((message) => {
            if (alive) worker.onmessage?.({ data: message });
        });
        return worker as unknown as Worker;
    };
    return {
        create,
        started: () => started,
        stall: (operation: string) => void stalled.add(operation),
        sent: (operation: string) =>
            new Promise<void>((resolve) => void awaited.set(operation, resolve)),
    };
}

/* This browser's device keys, real ones; `hold` keeps the next reads waiting until released. */
function deviceKeys() {
    const kept = new Map<string, CryptoKey>();
    let gate: Promise<void> | undefined;
    const store: DeviceKeyStore = {
        create: async () => {
            const id = `device-key-${kept.size + 1}`;
            const key = await createDeviceKey();
            kept.set(id, key);
            return { id, key };
        },
        load: async (id) => {
            await gate;
            return kept.get(id) ?? null;
        },
        clear: async () => kept.clear(),
    };
    const hold = () => {
        let release!: () => void;
        gate = new Promise<void>((resolve) => (release = resolve));
        return release;
    };
    return { store, hold };
}

type Moment =
    | 'twoStepChallenge'
    | 'session'
    | 'loginStart'
    | 'loginFinish'
    | 'loginTwoStep'
    | 'securityStart'
    | 'deleteStart'
    | 'registerStart'
    | 'recoverStart';

/*
 * A browser: the auth client over real workers, and a server that answers each exchange with
 * real OPAQUE messages for the account above. `during` runs while the client waits for the
 * server's answer to that request: the moment something else gets its turn.
 */
function browser(options: { step?: StepChallenge; session?: SessionUser } = {}) {
    let record = made.registrationRecord;
    let envelope = made.envelope;
    let credentialVersion = 1;
    const during: Partial<Record<Moment, () => Promise<unknown> | void>> = {};
    const login = (startLoginRequest: string) => ({
        attemptToken: 'attempt',
        profileVersion: OPAQUE_PROFILE_VERSION,
        loginResponse: server.startLogin({
            serverSetup,
            userIdentifier: user.id,
            registrationRecord: record,
            startLoginRequest,
            identifiers: OPAQUE_IDENTIFIERS,
        }).loginResponse,
    });
    const signedIn = () => ({ user: { ...user, credentialVersion }, envelope, device });
    const registration = (registrationRequest: string) => ({
        registrationResponse: registrationResponse(registrationRequest),
        userId: user.id,
        profileVersion: OPAQUE_PROFILE_VERSION,
    });
    const api = {
        twoStepChallenge: async () => {
            await during.twoStepChallenge?.();
            return { on: false };
        },
        loginStart: async (input: { startLoginRequest: string }) => {
            const reply = login(input.startLoginRequest);
            await during.loginStart?.();
            return reply;
        },
        loginFinish: async () => {
            await during.loginFinish?.();
            return options.step ? { twoStep: options.step } : signedIn();
        },
        loginTwoStep: async () => {
            await during.loginTwoStep?.();
            return { ...signedIn(), twoStep: { offered: true } };
        },
        /* The live session, as another tab's password change left it when `session` says so. */
        session: async () => {
            await during.session?.();
            return { user: options.session ?? { ...user, credentialVersion }, device: null };
        },
        securityStart: async (input: {
            action: 'password';
            startLoginRequest: string;
            registrationRequest: string;
        }) => {
            const reply = {
                action: input.action,
                userId: user.id,
                ...login(input.startLoginRequest),
                registrationResponse: registrationResponse(input.registrationRequest),
                envelope,
                recovery: made.recovery,
                identity: made.identity,
                identityHistory: [],
                settingsKey: null,
                workspaces: [],
            };
            await during.securityStart?.();
            return reply;
        },
        securityFinish: async (update: {
            registrationRecord: string;
            envelope: typeof envelope;
        }) => {
            record = update.registrationRecord;
            envelope = update.envelope;
            credentialVersion++;
            return signedIn();
        },
        deleteStart: async (input: { startLoginRequest: string }) => {
            const reply = login(input.startLoginRequest);
            await during.deleteStart?.();
            return reply;
        },
        deleteFinish: async () => ({}),
        setup: async () => ({ missing: null }),
        recoveryBackup: async () => ({ userId: user.id, recovery: made.recovery }),
        registerStart: async (input: { registrationRequest: string }) => {
            const reply = registration(input.registrationRequest);
            await during.registerStart?.();
            return reply;
        },
        recoverStart: async (input: { registrationRequest: string }) => {
            const reply = {
                ...registration(input.registrationRequest),
                credentialVersion,
                attemptToken: 'attempt',
                recovery: made.recovery,
            };
            await during.recoverStart?.();
            return reply;
        },
    } as unknown as AuthApi;
    const crypto = workers();
    const keys = deviceKeys();
    const auth = createAuthClient(
        () => createBrowserCryptoTransport(crypto.create),
        keys.store,
        api,
    );
    /* A read the app makes in the background after an unlock (lib/contacts.ts, settingsKeyReady). */
    const backgroundRead = () =>
        auth.rpc('settingsKeyOpen', { userId: user.id, settingsKey: {} as never }).then(
            () => 'answered',
            (error: Error) => error.message,
        );
    /* The page is left, or another tab locks: the auth client's own lock, as its listener runs it. */
    const lockNow = () => listeners.get('pagehide')!();
    return { auth, during, crypto, keys, backgroundRead, lockNow, options };
}

const changed = { signedIn: true, uncertain: false };

describe('a background read that arrives while an exchange waits for the server', () => {
    test('does not end a password change: the change is made and this browser is open', async () => {
        const { auth, during, backgroundRead } = browser();
        let read: string | undefined;
        during.securityStart = async () => {
            read = await backgroundRead();
        };
        await expect(auth.changeSecurity(user, 'password', PASSWORD, NEXT)).resolves.toEqual(
            changed,
        );
        expect(auth.store.getState().unlockedUserId).toBe(user.id);
        // The read is refused as a locked account refuses it, and the new password signs in.
        expect(read).toBe('Unlock your account first.');
        auth.resync();
        await expect(auth.login(user.email, NEXT)).resolves.toMatchObject({
            user: { id: user.id },
        });
    });

    test('does not end a sign-in', async () => {
        const { auth, during, backgroundRead } = browser();
        during.loginStart = backgroundRead;
        await expect(auth.login(user.email, PASSWORD)).resolves.toMatchObject({
            user: { id: user.id },
        });
        expect(auth.store.getState().unlockedUserId).toBe(user.id);
    });

    test('does not drop the key a sign-in holds while the person answers the second step', async () => {
        const step: StepChallenge = {
            token: 'step-1',
            methods: ['totp'],
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            expiresIn: 300,
        };
        const { auth, backgroundRead } = browser({ step });
        const signIn = auth.login(user.email, PASSWORD, {
            step: async () => {
                await backgroundRead();
                return { kind: 'totp', code: '123456' };
            },
        });
        await expect(signIn).resolves.toMatchObject({ step: { answered: 'totp' } });
        expect(auth.store.getState().unlockedUserId).toBe(user.id);
    });

    test('does not end the password proof of an account deletion', async () => {
        const { auth, during, backgroundRead } = browser();
        await auth.login(user.email, PASSWORD);
        during.deleteStart = backgroundRead;
        await expect(auth.deleteAccount(PASSWORD)).resolves.toBeUndefined();
    });

    test('of Drive’s reaches the worker all the same, and its refusal there ends nothing', async () => {
        const { auth, during } = browser();
        let read: string | undefined;
        during.securityStart = async () => {
            read = await auth
                .rpc('driveOpenWorkspace', { userId: user.id, grant: made.workspace.grant })
                .then(
                    () => 'opened',
                    (error: Error) => error.message,
                );
        };
        await expect(auth.changeSecurity(user, 'password', PASSWORD, NEXT)).resolves.toEqual(
            changed,
        );
        // The worker's own words for it, not the client's refusal: a visitor's link, which
        // needs no account, is opened by the same road.
        expect(read).toBe('Unlock your account to open Drive.');
    });

    test('is answered again after the second step was backed out of, once the saved unlock has opened the account', async () => {
        const here = browser();
        const { auth } = here;
        await auth.login(user.email, PASSWORD);
        auth.resync();
        here.options.step = {
            token: 'step-1',
            methods: ['totp'],
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            expiresIn: 300,
        };
        // Null is also what a step screen that has gone away answers (two-step-prompt.tsx).
        await expect(
            auth.login(user.email, PASSWORD, { step: async () => null }),
        ).rejects.toBeInstanceOf(StepCancelled);
        await auth.restore(user, { validated: true });
        expect(auth.store.getState().unlockedUserId).toBe(user.id);
        const { phrase } = await auth.recoveryBackup(user);
        expect(phrase.split(' ')).toHaveLength(24);
    });

    test('is answered as soon as a sign-in shows the account as open, while it still saves the unlock', async () => {
        const { auth } = browser();
        // What the app does when the store says unlocked: it starts reading.
        let read: Promise<{ phrase: string }> | undefined;
        auth.store.subscribe((state, previous) => {
            if (state.unlockedUserId && !previous.unlockedUserId) read = auth.recoveryBackup(user);
        });
        await auth.login(user.email, PASSWORD);
        expect((await read!).phrase.split(' ')).toHaveLength(24);
    });

    test('is answered again after a sign-in that failed, once the saved unlock has opened the account', async () => {
        const { auth } = browser();
        await auth.login(user.email, PASSWORD);
        auth.resync();
        await expect(auth.login(user.email, 'not the password at all')).rejects.toThrow(
            'Unable to sign in. Check your email and password.',
        );
        await auth.restore(user, { validated: true });
        const { phrase } = await auth.recoveryBackup(user);
        expect(phrase.split(' ')).toHaveLength(24);
    });
});

describe('the saved unlock', () => {
    /* Signed in, so this browser has a saved unlock, then locked in this tab alone. */
    async function lockedWithSavedUnlock() {
        const here = browser();
        await here.auth.login(user.email, PASSWORD);
        here.auth.resync();
        expect(here.auth.store.getState().device).not.toBeNull();
        return here;
    }

    test('is not opened in the worker of a password change under way', async () => {
        const { auth, during } = await lockedWithSavedUnlock();
        during.securityStart = () => auth.restore(user, { validated: true });
        await expect(auth.changeSecurity(user, 'password', PASSWORD, NEXT)).resolves.toEqual(
            changed,
        );
        expect(auth.store.getState().unlockedUserId).toBe(user.id);
    });

    test('that was still reading its device key stands down for a sign-in', async () => {
        const { auth, during, keys } = await lockedWithSavedUnlock();
        const release = keys.hold();
        const restored = auth.restore(user, { validated: true });
        during.loginStart = async () => {
            release();
            await restored;
        };
        await expect(auth.login(user.email, PASSWORD)).resolves.toMatchObject({
            user: { id: user.id },
        });
        expect(auth.store.getState().unlockedUserId).toBe(user.id);
    });

    test('that the worker answers after a sign-in began does not show this browser as open', async () => {
        const { auth, during, crypto } = await lockedWithSavedUnlock();
        const asked = crypto.sent('restore');
        const restored = auth.restore(user, { validated: true });
        await asked;
        // The sign-in's first half follows the restore into the same worker, and starts it over.
        let open: string | null = null;
        during.loginStart = async () => {
            await restored;
            open = auth.store.getState().unlockedUserId;
        };
        await auth.login(user.email, PASSWORD);
        expect(open).toBeNull();
    });

    test('that finds the password changed in another tab erases itself, and leaves a sign-in under way alone', async () => {
        const here = await lockedWithSavedUnlock();
        const { auth, during } = here;
        // The session now carries the other tab's new credentials; this tab is asked while
        // the person is already signing in here.
        here.options.session = { ...user, credentialVersion: 2 } as SessionUser;
        let answer!: () => void;
        during.session = () => new Promise<void>((resolve) => (answer = resolve));
        const restored = auth.restore(user);
        let kept: unknown = 'not asked';
        during.loginStart = async () => {
            answer();
            await restored;
            kept = auth.store.getState().device;
        };
        await expect(auth.login(user.email, PASSWORD)).resolves.toMatchObject({
            user: { id: user.id },
        });
        expect(kept).toBeNull();
        expect(auth.store.getState().unlockedUserId).toBe(user.id);
    });

    test('that the change’s own lock cut short does not lock the change in turn', async () => {
        const { auth, during, crypto } = await lockedWithSavedUnlock();
        // The worker is still opening the saved key when the change locks it and begins.
        crypto.stall('restore');
        const asked = crypto.sent('restore');
        const restored = auth.restore(user, { validated: true });
        await asked;
        during.securityStart = () => restored;
        await expect(auth.changeSecurity(user, 'password', PASSWORD, NEXT)).resolves.toEqual(
            changed,
        );
        expect(auth.store.getState().unlockedUserId).toBe(user.id);
    });
});

/*
 * A real lock still wins: the exchange ends, and is said to have ended as the lock it was. The
 * worker that began it is gone, so no new one is started and asked to finish what it never
 * began (which is where "expired" came from).
 */
describe('a lock while an exchange waits for the server', () => {
    const step: StepChallenge = {
        token: 'step-1',
        methods: ['totp'],
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        expiresIn: 300,
    };
    const code = { step: async () => ({ kind: 'totp' as const, code: '123456' }) };
    type Here = ReturnType<typeof browser>;
    const change = ({ auth }: Here) => auth.changeSecurity(user, 'password', PASSWORD, NEXT);
    const signIn = ({ auth }: Here) => auth.login(user.email, PASSWORD, code);
    const again = 'Your account was locked. Please try again.';
    const signInAgain = 'Your account was locked. Please sign in again.';
    test.each([
        ['a password change', 'securityStart', change, again, {}],
        ['a sign-in', 'loginStart', signIn, signInAgain, {}],
        ['a sign-in whose password the server is checking', 'loginFinish', signIn, signInAgain, {}],
        [
            'a sign-in whose second step the server is checking',
            'loginTwoStep',
            signIn,
            signInAgain,
            { step },
        ],
        [
            'a registration',
            'registerStart',
            ({ auth }: Here) => auth.register(user.email, 'Maya', PASSWORD),
            again,
            {},
        ],
        [
            'a recovery',
            'recoverStart',
            ({ auth }: Here) => auth.recover(user.email, NEXT, 'a phrase never read'),
            again,
            {},
        ],
        [
            'an account deletion',
            'deleteStart',
            ({ auth }: Here) => auth.deleteAccount(PASSWORD),
            again,
            {},
        ],
    ] as const)(
        'ends %s as a lock, with no second worker',
        async (_flow, moment, run, message, options) => {
            const here = browser(options);
            here.during[moment] = here.lockNow;
            await expect(run(here)).rejects.toThrow(message);
            expect(here.crypto.started()).toBe(1);
            expect(here.auth.store.getState().unlockedUserId).toBeNull();
        },
    );
});
