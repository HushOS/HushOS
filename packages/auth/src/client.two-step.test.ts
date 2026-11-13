import { describe, expect, test, vi } from 'vitest';
import type { AuthApi } from './api';
import type { CryptoTransport } from './crypto-transport';
import type { DeviceKeyStore } from './device-storage';
import type { SessionUser } from './protocol';

/*
 * A sign-in that stops at its second step, in the auth client (docs/two-step-design.md 4).
 * Between the password and the envelope the worker holds what the password gave it, for as
 * long as a person takes to find a code. What must hold: nothing else reaches the worker in
 * that time; a wrong answer leaves the step answerable; a step that is over, or a reply that
 * was lost, leaves the person able to start again at once; and a refused step never costs
 * this browser what it keeps.
 */
const items = new Map<string, string>();
const localStorage = {
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => void items.set(name, value),
    removeItem: (name: string) => void items.delete(name),
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: localStorage });
Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage, addEventListener() {}, removeEventListener() {} },
});

const { createAuthClient, LostReply, StepFailure, TwoStepRequired } = await import('./client');

const user = {
    id: '0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4',
    email: 'maya@example.com',
    credentialVersion: 1,
} as SessionUser;
const session = {
    user,
    envelope: {
        envelopeVersion: 1,
        keyVersion: 1,
        credentialVersion: 1,
        wrappingSalt: 'c2FsdA',
        wrappingNonce: 'bm9uY2U',
        encryptedKey: 'a2V5',
    },
    device: { id: 'device', attached: false, registered: true },
};
const step = {
    token: 'a-step-token_'.padEnd(43, 'x'),
    methods: ['totp', 'backup', 'phrase'],
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    phrase: { userId: user.id, recoveryVersion: 1, wrappingSalt: 'c2FsdA' },
};
const refusal = (message: string, status: number, code?: string) =>
    Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

/* A client whose worker and server record what reaches them. */
function setup(server: Partial<Record<keyof AuthApi, (...input: never[]) => unknown>>) {
    items.clear();
    const worker: string[] = [];
    let locks = 0;
    const transport: CryptoTransport = {
        request: async (operation) => {
            worker.push(String(operation));
            if (operation === 'twoStepPhrase') return { signature: 's'.repeat(86) } as never;
            return {} as never;
        },
        lock: () => void locks++,
        onLock() {},
    };
    let cleared = 0;
    const keys: DeviceKeyStore = {
        create: async () => ({ id: 'device-key-1', key: {} as CryptoKey }),
        load: async () => null,
        clear: async () => void cleared++,
    };
    const api = {
        loginStart: async () => ({ attemptToken: 'attempt' }),
        loginFinish: async () => ({ twoStep: step }),
        ...server,
    } as unknown as AuthApi;
    const client = createAuthClient(() => transport, keys, api);
    const toStep = () => client.login(user.email, 'correct horse').catch((error: unknown) => error);
    return { client, worker, toStep, locks: () => locks, cleared: () => cleared };
}

describe('a sign-in that stops at its second step', () => {
    test('stops with the step and no session, and a right answer opens the account with what the worker kept', async () => {
        const sent: unknown[] = [];
        const { client, worker, toStep, locks } = setup({
            loginTwoStep: async (input: never) => {
                sent.push(input);
                return session;
            },
        });
        const asked = await toStep();
        expect(asked).toBeInstanceOf(TwoStepRequired);
        expect((asked as InstanceType<typeof TwoStepRequired>).challenge).toEqual(step);
        expect(client.store.getState().unlockedUserId).toBeNull();
        // Nothing was dropped: the worker still holds what the password gave it.
        expect(locks()).toBe(0);
        expect(worker).toEqual(['loginStart', 'loginFinish']);

        expect(await client.answerStep({ kind: 'totp', code: ' 123456 ' })).toEqual(user);
        expect(sent).toEqual([{ token: step.token, proof: { kind: 'totp', code: '123456' } }]);
        expect(worker).toEqual(['loginStart', 'loginFinish', 'unlock', 'remember']);
        expect(client.store.getState().unlockedUserId).toBe(user.id);
        expect(client.isAuthenticating()).toBe(false);
    });

    test('while it waits, no other account operation reaches the worker, and a restore does not run', async () => {
        const { client, worker, toStep, locks } = setup({ loginTwoStep: async () => session });
        await toStep();
        expect(client.isAuthenticating()).toBe(true);
        // An identity read, a setup, a password proof for something else: each would reset or
        // replace what the worker holds for the sign-in. None is sent.
        await expect(client.rpc('identityOpen', {} as never)).rejects.toThrow('Please wait');
        await expect(client.rpc('restore', {} as never)).rejects.toThrow('Please wait');
        await expect(client.removeOtherDevices('correct horse')).rejects.toThrow('Please wait');
        // A saved unlock whose device key is gone: a restore that ran would find that out,
        // erase it and lock the worker under the waiting sign-in.
        const saved = {
            version: 1,
            keyVersion: 1,
            credentialVersion: 1,
            userId: user.id,
            deviceKeyId: 'device-key-1',
            nonce: 'AAAAAAAAAAAAAAAA',
            encryptedKey: 'B'.repeat(64),
        };
        items.set(
            'hushos-device-unlock',
            JSON.stringify({ state: { device: saved, lockRevision: 0 }, version: 1 }),
        );
        await client.restore(user, { validated: true });
        expect(JSON.parse(items.get('hushos-device-unlock')!).state.device).toEqual(saved);
        expect(worker).toEqual(['loginStart', 'loginFinish']);
        expect(locks()).toBe(0);
        // Drive's operations fail without touching the sign-in's state, so they still go.
        await client.rpc('driveLock' as never, {} as never);
        expect(worker.at(-1)).toBe('driveLock');
        // And the step is still answerable.
        expect(await client.answerStep({ kind: 'backup', code: '7KQ2M-9XD4P' })).toEqual(user);
    });

    test('the phrase is signed in the worker, by the sign-in that owns it, and only its signature is sent', async () => {
        const sent: unknown[] = [];
        const { client, worker, toStep } = setup({
            loginTwoStep: async (input: never) => {
                sent.push(input);
                return session;
            },
        });
        await toStep();
        await client.answerStep({ kind: 'phrase', phrase: 'abandon ability able' });
        expect(worker).toEqual([
            'loginStart',
            'loginFinish',
            'twoStepPhrase',
            'unlock',
            'remember',
        ]);
        expect(sent).toEqual([
            { token: step.token, proof: { kind: 'phrase', signature: 's'.repeat(86) } },
        ]);
        expect(JSON.stringify(sent)).not.toContain('abandon');
    });

    test.each([
        ['a wrong code', refusal('That code didn’t work.', 401, 'step-wrong'), 'wrong'],
        ['a paused app', refusal('Paused on this device.', 403, 'step-frozen'), 'frozen'],
        ['a spent budget', refusal('Too many wrong codes.', 429, 'step-limited'), 'limited'],
        [
            'a server that cannot check',
            refusal('Unavailable right now.', 503, 'step-unavailable'),
            'unavailable',
        ],
        // A 5xx without the server's code says nothing of the step, and its token may still be
        // good: the same answer goes again, and the server says if the step is over.
        ['a gateway’s 503', refusal('Service unavailable.', 503), 'offline'],
        ['a bare 500', refusal('Please try again.', 500), 'offline'],
        ['a gateway’s 502', refusal('Please try again.', 502), 'offline'],
        ['a gateway’s 504', refusal('Please try again.', 504), 'offline'],
        ['no connection', new TypeError('Failed to fetch'), 'offline'],
        // The address's own limit at the HTTP edge, which carries no step code.
        ['too many requests from this address', refusal('Too many requests.', 429), 'busy'],
    ])('%s leaves the step answerable and the worker untouched', async (_name, failure, reason) => {
        let tries = 0;
        const { client, worker, toStep, locks } = setup({
            loginTwoStep: async () => {
                if (tries++ === 0) throw failure;
                return session;
            },
        });
        await toStep();
        const refused = await client.answerStep({ kind: 'totp', code: '000000' }).catch((e) => e);
        expect(refused).toBeInstanceOf(StepFailure);
        expect(refused).toMatchObject({ reason, again: true });
        expect(locks()).toBe(0);
        expect(client.isAuthenticating()).toBe(true);
        // The next answer passes on the same step, with the same held state.
        expect(await client.answerStep({ kind: 'totp', code: '123456' })).toEqual(user);
        expect(worker.filter((operation) => operation === 'loginStart')).toHaveLength(1);
    });

    test.each([
        [
            'a step that is over',
            () => Promise.reject(refusal('Timed out.', 401, 'step-expired')),
            'over',
        ],
        [
            'a proxy’s page in place of the answer',
            async () => '<html>Sign in to Wi-Fi</html>',
            'lost',
        ],
        ['an empty 200', async () => null, 'lost'],
        ['an answer without the envelope', async () => ({ user }), 'lost'],
        ['some other refusal', () => Promise.reject(refusal('Not allowed.', 403)), 'over'],
    ])(
        '%s ends the step: what the worker held is dropped, and the person can sign in again at once',
        async (_name, reply, reason) => {
            const { client, worker, toStep, locks } = setup({ loginTwoStep: reply as never });
            await toStep();
            const ended = await client.answerStep({ kind: 'totp', code: '123456' }).catch((e) => e);
            expect(ended).toBeInstanceOf(StepFailure);
            expect(ended).toMatchObject({ reason, again: false });
            expect(locks()).toBe(1);
            expect(client.store.getState().unlockedUserId).toBeNull();
            // Not stuck: nothing owns the worker, an answer to the old step says it is over, and
            // the password starts a new sign-in.
            expect(client.isAuthenticating()).toBe(false);
            await expect(client.answerStep({ kind: 'totp', code: '123456' })).rejects.toMatchObject(
                {
                    reason: 'over',
                },
            );
            expect(await toStep()).toBeInstanceOf(TwoStepRequired);
            expect(worker.filter((operation) => operation === 'loginStart')).toHaveLength(2);
        },
    );

    test.each([
        ['a proxy’s page', '<html>Sign in to Wi-Fi</html>'],
        ['a success without a user or a step', { success: true }],
        ['nothing', null],
    ])(
        'a 200 from login/finish that is %s is a lost reply, never a sign-in',
        async (_name, reply) => {
            let lost = true;
            const { client, toStep, locks } = setup({
                loginFinish: async () => (lost ? reply : session),
            });
            const failure = await toStep();
            expect(failure).toBeInstanceOf(StepFailure);
            expect(failure).toMatchObject({ reason: 'lost', again: false });
            expect(client.store.getState().unlockedUserId).toBeNull();
            expect(locks()).toBe(1);
            expect(client.isAuthenticating()).toBe(false);
            lost = false;
            expect(await client.login(user.email, 'correct horse')).toEqual(user);
        },
    );

    test('a page that left before the server answered is not left a step: the late challenge is refused, and nothing holds the worker', async () => {
        let answer!: (reply: unknown) => void;
        const { client, locks } = setup({
            loginFinish: () => new Promise((resolve) => (answer = resolve)),
        });
        // Sign in is pressed, and the page (or the dialog) goes away while the request is out.
        const signingIn = client
            .login(user.email, 'correct horse')
            .catch((error: unknown) => error);
        await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
        client.cancelStep();
        answer({ twoStep: step });
        const late = await signingIn;
        expect(late).toBeInstanceOf(Error);
        expect(late).not.toBeInstanceOf(TwoStepRequired);
        // Nobody could answer it, so nothing waits: the worker is let go and the next
        // account operation, or the next sign-in, goes through.
        expect(client.isAuthenticating()).toBe(false);
        expect(locks()).toBe(1);
        await expect(client.answerStep({ kind: 'totp', code: '123456' })).rejects.toMatchObject({
            reason: 'over',
        });
        await expect(client.rpc('identityOpen', {} as never)).resolves.toEqual({});
    });

    test('a form that goes away lets go of its own sign-in only: another form’s step, waiting or still on its way, is left alone', async () => {
        const mine = {};
        const other = {};
        const { client, locks } = setup({ loginTwoStep: async () => session });
        const asked = await client
            .login(user.email, 'correct horse', { owner: mine })
            .catch((error: unknown) => error);
        expect(asked).toBeInstanceOf(TwoStepRequired);
        // The same form, mounted elsewhere and closed: nothing of this sign-in is touched.
        client.cancelStep(other);
        expect(locks()).toBe(0);
        expect(client.isAuthenticating()).toBe(true);
        expect(await client.answerStep({ kind: 'totp', code: '123456' })).toEqual(user);

        // A sign-in still on its way to the server, when the other form closes: its step is
        // installed for the form that asked.
        let answer!: (reply: unknown) => void;
        const flight = setup({ loginFinish: () => new Promise((resolve) => (answer = resolve)) });
        const signingIn = flight.client
            .login(user.email, 'correct horse', { owner: mine })
            .catch((error: unknown) => error);
        await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
        flight.client.cancelStep(other);
        answer({ twoStep: step });
        expect(await signingIn).toBeInstanceOf(TwoStepRequired);
        // Its own form going away does drop it.
        flight.client.cancelStep(mine);
        expect(flight.locks()).toBe(1);
        expect(flight.client.isAuthenticating()).toBe(false);
    });

    test.each([
        ['a sign-in with the password alone', false],
        ['a sign-in that answered its step', true],
    ])(
        'once the account is open after %s, other operations go through, though device access is still being saved',
        async (_name, viaStep) => {
            items.clear();
            const worker: string[] = [];
            const transport: CryptoTransport = {
                request: async (operation) => {
                    worker.push(String(operation));
                    return {} as never;
                },
                lock() {},
                onLock() {},
            };
            // The device key store is slow, as it is on a loaded phone: the sign-in is not over.
            let saved!: () => void;
            const keys: DeviceKeyStore = {
                create: () =>
                    new Promise((resolve) => {
                        saved = () => resolve({ id: 'device-key-1', key: {} as CryptoKey });
                    }),
                load: async () => null,
                clear: async () => {},
            };
            const client = createAuthClient(() => transport, keys, {
                loginStart: async () => ({ attemptToken: 'attempt' }),
                loginFinish: async () => (viaStep ? { twoStep: step } : session),
                loginTwoStep: async () => session,
            } as unknown as AuthApi);
            // What the app does the moment it hears "unlocked": Drive opens the identity.
            let opened: Promise<string> | undefined;
            client.store.subscribe((state, previous) => {
                if (state.unlockedUserId && !previous.unlockedUserId)
                    opened = client.rpc('identityOpen', {} as never).then(
                        () => 'opened',
                        (error: Error) => error.message,
                    );
            });
            const signIn = viaStep
                ? client
                      .login(user.email, 'correct horse')
                      .catch(() => client.answerStep({ kind: 'totp', code: '123456' }))
                : client.login(user.email, 'correct horse');
            await vi.waitFor(() => expect(opened).toBeDefined());
            // Not "Please wait for the current sign-in attempt.": that ends at "Your files didn't
            // open" for a sign-in that worked.
            expect(await opened).toBe('opened');
            expect(worker).toContain('identityOpen');
            // The sign-in itself is still going, and finishes when the store answers.
            expect(client.isAuthenticating()).toBe(true);
            saved();
            expect(await signIn).toEqual(user);
        },
    );

    test('leaving the step, or starting another sign-in, drops it', async () => {
        const { client, toStep, locks } = setup({ loginTwoStep: async () => session });
        await toStep();
        client.cancelStep();
        expect(locks()).toBe(1);
        expect(client.isAuthenticating()).toBe(false);
        await expect(client.answerStep({ kind: 'totp', code: '123456' })).rejects.toMatchObject({
            reason: 'over',
        });
        // A second press of Sign in while a step waits is a new sign-in, not "please wait".
        await toStep();
        expect(await toStep()).toBeInstanceOf(TwoStepRequired);
        expect(await client.answerStep({ kind: 'totp', code: '123456' })).toEqual(user);
    });

    test('a sign-in that needs no step, started while another waits at its step, leaves nothing waiting', async () => {
        let asks = true;
        const { client, toStep } = setup({
            loginFinish: async () => (asks ? { twoStep: step } : session),
        });
        await toStep();
        asks = false;
        // Another account in the same tab, say: its sign-in takes the worker over and finishes.
        expect(await client.login(user.email, 'correct horse')).toEqual(user);
        expect(client.isAuthenticating()).toBe(false);
        // The old step is gone with what the worker held for it.
        await expect(client.answerStep({ kind: 'totp', code: '123456' })).rejects.toMatchObject({
            reason: 'over',
        });
        expect(client.store.getState().unlockedUserId).toBe(user.id);
    });

    test('a sign-in made on the person’s behalf has nobody to ask: it stops, and nothing is left waiting', async () => {
        const { client, locks } = setup({
            registerStart: async () => ({}),
            registerFinish: async () => ({ user }),
        });
        await expect(client.register(user.email, 'Maya', 'correct horse')).rejects.toThrow(
            'Your account was created. Please sign in to unlock it.',
        );
        expect(client.isAuthenticating()).toBe(false);
        expect(locks()).toBeGreaterThan(0);
    });
});

describe('the second step at a security change', () => {
    const change = (finish: (input: never) => unknown) =>
        setup({
            securityStart: async () => ({ userId: user.id, action: 'password', attemptToken: 'a' }),
            securityFinish: finish,
            session: async () => ({ user, device: null }),
            loginFinish: async () => session,
        });
    const twoStep = { token: step.token, proof: { kind: 'totp', code: '123456' } } as const;

    test('goes with the change, which asks to keep this device signed in', async () => {
        const sent: Record<string, unknown>[] = [];
        const { client } = change(async (input: never) => {
            sent.push(input);
            return { success: true };
        });
        expect(
            await client.changeSecurity(user, 'password', 'correct horse', 'a new one', twoStep),
        ).toEqual({ signedIn: true, uncertain: false, storage: null });
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ action: 'password', twoStep, keepSession: 1 });
    });

    test('when the sign-in after the change is asked for the step anyway, the person signs in themselves and nothing is left waiting', async () => {
        // The reply that carried the kept session was lost, so the sign-in meets the step.
        const { client } = setup({
            securityStart: async () => ({ userId: user.id, action: 'password', attemptToken: 'a' }),
            securityFinish: async () => ({ success: true }),
            session: async () => ({ user, device: null }),
        });
        expect(
            await client.changeSecurity(user, 'password', 'correct horse', 'a new one', twoStep),
        ).toEqual({ signedIn: false, uncertain: false, storage: null });
        // Nothing owns the worker: the sign-in page's own sign-in can begin at once.
        expect(client.isAuthenticating()).toBe(false);
        await expect(client.answerStep({ kind: 'totp', code: '123456' })).rejects.toMatchObject({
            reason: 'over',
        });
    });

    test('a refused step is the server’s answer: nothing this browser keeps is cleared, and the refusal reaches the page', async () => {
        const wrong = refusal('That code didn’t work.', 403, 'step-wrong');
        const { client, cleared } = change(() => Promise.reject(wrong));
        await expect(
            client.changeSecurity(user, 'password', 'correct horse', 'a new one', twoStep),
        ).rejects.toBe(wrong);
        expect(cleared()).toBe(0);
        // So are the address's limit and a method the server says it cannot check: answered,
        // unchanged.
        for (const answered of [
            refusal('Too many requests.', 429),
            refusal('Unavailable right now.', 503, 'step-unavailable'),
        ]) {
            const busy = change(() => Promise.reject(answered));
            await expect(
                busy.client.changeSecurity(user, 'password', 'correct horse', 'a new one', twoStep),
            ).rejects.toBe(answered);
            expect(busy.cleared()).toBe(0);
        }
        // A 503 without the server's code may be a proxy's, sent after the change went
        // through: it is cleaned up after and the live session decides, as for no reply.
        const gateway = change(() => Promise.reject(refusal('Bad gateway.', 503)));
        await expect(
            gateway.client.changeSecurity(user, 'password', 'correct horse', 'a new one', twoStep),
        ).rejects.toThrow('Bad gateway.');
        expect(gateway.cleared()).toBe(1);
        // Any other failure may be a lost reply, and is still cleaned up after as before.
        const unknown = change(() => Promise.reject(new TypeError('Failed to fetch')));
        await expect(
            unknown.client.changeSecurity(user, 'password', 'correct horse', 'a new one', twoStep),
        ).rejects.toThrow('Failed to fetch');
        expect(unknown.cleared()).toBe(1);
    });

    test.each([
        ['a portal’s page', '<html>Sign in to Wi-Fi</html>'],
        ['an empty body', null],
        ['a reply that does not say it succeeded', { ok: 'yes' }],
    ])(
        'a 200 that is %s is not a changed password: the outcome is unknown, and said so',
        async (_name, reply) => {
            // The session can no longer be read either, as behind a portal: nothing proves the change.
            const unknown = setup({
                securityStart: async () => ({
                    userId: user.id,
                    action: 'password',
                    attemptToken: 'a',
                }),
                securityFinish: async () => reply,
                session: async () => {
                    throw new TypeError('Failed to fetch');
                },
            });
            expect(
                await unknown.client.changeSecurity(user, 'password', 'correct horse', 'a new one'),
            ).toEqual({ signedIn: false, uncertain: true, storage: null });
            // The session is still there on the old credential: nothing changed, and that is the error.
            const unchanged = change(async () => reply);
            await expect(
                unchanged.client.changeSecurity(user, 'password', 'correct horse', 'a new one'),
            ).rejects.toBeInstanceOf(LostReply);
        },
    );
});

describe('other replies that say a change was made', () => {
    const page = '<html>Sign in to Wi-Fi</html>';
    const reauth = {
        twoStepReauth: async () => ({ attemptToken: 'attempt' }),
    };

    test('a 200 that is not the server’s answer never deletes the account here', async () => {
        const { client, cleared } = setup({
            deleteStart: async () => ({ attemptToken: 'a' }),
            deleteFinish: async () => page,
        });
        await expect(client.deleteAccount('correct horse')).rejects.toBeInstanceOf(LostReply);
        // What this browser keeps for the account is not thrown away on a reply nobody sent.
        expect(cleared()).toBe(0);
    });

    test('confirming a code, making codes, turning the step off and starting an app each need the server’s own answer', async () => {
        const { client } = setup({
            ...reauth,
            twoStepConfirmTotp: async () => page,
            twoStepBackupCodes: async () => ({ codes: [] }),
            twoStepRemoveMethod: async () => ({ removed: 'yes' }),
            twoStepStartTotp: async () => ({ id: 'app' }),
        });
        await expect(client.confirmAuthenticator('app', '123456')).rejects.toBeInstanceOf(
            LostReply,
        );
        const twoStep = { token: step.token, proof: { kind: 'totp', code: '123456' } } as const;
        await expect(client.newBackupCodes('correct horse', twoStep)).rejects.toBeInstanceOf(
            LostReply,
        );
        await expect(
            client.removeTwoStepMethod('app', 'correct horse', twoStep),
        ).rejects.toBeInstanceOf(LostReply);
        await expect(client.startAuthenticator('correct horse')).rejects.toBeInstanceOf(LostReply);
    });

    test('the server’s own answers are read as what they are', async () => {
        const codes = Array.from({ length: 10 }, (_, index) => `CODE${index}-AAAAA`);
        const { client } = setup({
            ...reauth,
            twoStepConfirmTotp: async (id: never) =>
                id === ('first' as never) ? { backupCodes: codes } : { replaced: true },
            twoStepBackupCodes: async () => ({ codes }),
            twoStepRemoveMethod: async () => ({ removed: true, on: false }),
            twoStepStartTotp: async () => ({ id: 'app', secret: 'KEY', uri: 'otpauth://totp/x' }),
        });
        expect(await client.confirmAuthenticator('first', '123456')).toEqual({
            backupCodes: codes,
        });
        expect(await client.confirmAuthenticator('second', '123456')).toEqual({ replaced: true });
    });

    test.each([
        // What a proxy, or a server from before `replaced`, sends: it says nothing happened.
        ['an empty object', {}],
        ['a proxy’s error object', { error: 'upstream unavailable' }],
        ['a replacement that is not true', { replaced: 'yes' }],
        ['a replacement beside something else', { replaced: true, backupCodes: ['CODE0-AAAAA'] }],
        ['a success flag the server never sends here', { success: true }],
        ['codes beside something else', { backupCodes: ['CODE0-AAAAA'], error: 'x' }],
        ['codes that are not codes', { backupCodes: 'CODE0-AAAAA' }],
    ])('a 200 with %s is not a confirmed authenticator app', async (_name, reply) => {
        const { client } = setup({ twoStepConfirmTotp: async () => reply });
        await expect(client.confirmAuthenticator('app', '123456')).rejects.toBeInstanceOf(
            LostReply,
        );
    });

    test('the other answers the server gives to a change of the step are read as what they are', async () => {
        const codes = Array.from({ length: 10 }, (_, index) => `CODE${index}-AAAAA`);
        const { client } = setup({
            ...reauth,
            twoStepBackupCodes: async () => ({ codes }),
            twoStepRemoveMethod: async () => ({ removed: true, on: false }),
            twoStepStartTotp: async () => ({ id: 'app', secret: 'KEY', uri: 'otpauth://totp/x' }),
        });
        const twoStep = { token: step.token, proof: { kind: 'totp', code: '123456' } } as const;
        expect(await client.newBackupCodes('correct horse', twoStep)).toEqual({ codes });
        expect(await client.removeTwoStepMethod('app', 'correct horse', twoStep)).toEqual({
            removed: true,
            on: false,
        });
        expect(await client.startAuthenticator('correct horse')).toEqual({
            id: 'app',
            secret: 'KEY',
            uri: 'otpauth://totp/x',
        });
    });
});

/*
 * The worker keeps one password exchange's state between its start and its finish. Two
 * exchanges at once is not a double press: after two-step sign-in is turned on, the other
 * devices are removed in the background, and the person may go on to something else that asks
 * for the password while that request is still out.
 */
describe('proving the password again for two things at once', () => {
    /* A worker that holds one exchange, as the real session does. */
    function oneExchange(server: Partial<Record<keyof AuthApi, (...input: never[]) => unknown>>) {
        items.clear();
        let held = '';
        const transport: CryptoTransport = {
            request: async (operation, input) => {
                if (operation === 'reauthStart') {
                    held = (input as { password: string }).password;
                    return { startLoginRequest: `start:${held}` } as never;
                }
                if (operation === 'reauthFinish') {
                    const password = held;
                    held = '';
                    if (!password)
                        throw Object.assign(new Error('Enter your password again.'), {
                            kept: true,
                        });
                    return { finishLoginRequest: `finish:${password}` } as never;
                }
                if (operation === 'reauthCancel') held = '';
                return {} as never;
            },
            lock() {},
            onLock() {},
        };
        const keys: DeviceKeyStore = {
            create: async () => ({ id: 'device-key-1', key: {} as CryptoKey }),
            load: async () => null,
            clear: async () => {},
        };
        return createAuthClient(() => transport, keys, server as unknown as AuthApi);
    }

    test('the second waits for the first, so neither loses its exchange and both requests are sent', async () => {
        let answerFirst!: (challenge: unknown) => void;
        const removed: unknown[] = [];
        const started: unknown[] = [];
        const client = oneExchange({
            // The removal's exchange is slow to come back.
            devicesReauth: () => new Promise((resolve) => (answerFirst = resolve)),
            removeOtherDevices: async (proof: never) => {
                removed.push(proof);
                return { removed: 2 };
            },
            twoStepReauth: async () => ({ attemptToken: 'second' }),
            twoStepStartTotp: async (input: never) => {
                started.push(input);
                return { id: 'app', secret: 'KEY', uri: 'otpauth://totp/x' };
            },
        });
        const removal = client.removeOtherDevices('the password');
        await vi.waitFor(() => expect(answerFirst).toBeTypeOf('function'));
        // Meanwhile the person starts something else that asks for the password.
        const another = client.startAuthenticator('the password');
        await new Promise((resolve) => setTimeout(resolve, 20));
        // It has not begun its exchange over the first one's.
        expect(started).toEqual([]);
        answerFirst({ attemptToken: 'first' });
        // The removal reaches its endpoint with its own finished exchange.
        expect(await removal).toEqual({ removed: 2 });
        expect(removed).toEqual([
            { attemptToken: 'first', finishLoginRequest: 'finish:the password' },
        ]);
        // And the second then runs its own.
        expect(await another).toMatchObject({ id: 'app' });
        expect(started).toEqual([
            { attemptToken: 'second', finishLoginRequest: 'finish:the password' },
        ]);
    });

    test('an exchange that fails does not hold up the next, and a slow request does not hold up the next exchange', async () => {
        let finishRemoval!: (result: unknown) => void;
        let refuse = true;
        const client = oneExchange({
            devicesReauth: async () => {
                if (refuse) throw new Error('Too many attempts.');
                return { attemptToken: 'first' };
            },
            // The request itself hangs, after its exchange is done.
            removeOtherDevices: () => new Promise((resolve) => (finishRemoval = resolve)),
            twoStepReauth: async () => ({ attemptToken: 'second' }),
            twoStepStartTotp: async () => ({ id: 'app', secret: 'KEY', uri: 'otpauth://totp/x' }),
        });
        await expect(client.removeOtherDevices('the password')).rejects.toThrow(
            'Too many attempts.',
        );
        refuse = false;
        const removal = client.removeOtherDevices('the password');
        await vi.waitFor(() => expect(finishRemoval).toBeTypeOf('function'));
        // The removal's request is still out; the next thing that asks for the password goes ahead.
        expect(await client.startAuthenticator('the password')).toMatchObject({ id: 'app' });
        finishRemoval({ removed: 1 });
        expect(await removal).toEqual({ removed: 1 });
    });
});

/*
 * A reset with the recovery phrase replaces the phrase. The old words stop working the moment
 * the server accepts the reset, and the page that shows the new ones is behind the sign-in.
 * With two-step sign-in on, someone whose only second step is their phrase would be locked
 * out for good: the old phrase refused, the new one never seen. So the reset's own sign-in
 * answers the step with the new phrase, and the new words come back with the result whatever
 * the sign-in does.
 */
describe('a reset with the recovery phrase', () => {
    const fresh = 'fresh words made by the reset';
    // The account as the reset leaves it: its credential and its recovery key one version on.
    const after = { ...session, envelope: { ...session.envelope, credentialVersion: 2 } };
    const stepAfter = { ...step, phrase: { ...step.phrase, recoveryVersion: 2 } };
    // And as it was, when the reset never landed.
    const before = session;
    const stepBefore = step;
    function resetting(
        server: Partial<Record<keyof AuthApi, (...input: never[]) => unknown>>,
        worker: { wrongPassword?: boolean } = {},
    ) {
        items.clear();
        const signed: unknown[] = [];
        const transport: CryptoTransport = {
            request: async (operation, input) => {
                if (operation === 'recoveredPhrase') return { phrase: fresh } as never;
                if (operation === 'twoStepPhrase') {
                    signed.push((input as { phrase: string }).phrase);
                    return { signature: 's'.repeat(86) } as never;
                }
                // The server's record refuses the password: the worker finds out here.
                if (operation === 'loginFinish' && worker.wrongPassword)
                    throw new Error('Unable to sign in. Check your email and password.');
                return {} as never;
            },
            lock() {},
            onLock() {},
        };
        const keys: DeviceKeyStore = {
            create: async () => ({ id: 'device-key-1', key: {} as CryptoKey }),
            load: async () => null,
            clear: async () => {},
        };
        const client = createAuthClient(() => transport, keys, {
            recoverStart: async () => ({
                userId: user.id,
                attemptToken: 'a',
                credentialVersion: 1,
                recovery: { recoveryVersion: 1 },
            }),
            recoverFinish: async () => ({ user }),
            loginStart: async () => ({ attemptToken: 'attempt' }),
            loginFinish: async () => after,
            logout: async () => ({}),
            ...server,
        } as unknown as AuthApi);
        return {
            reset: () => client.recover(user.email, 'a new password', 'the old words'),
            signed,
            client,
        };
    }

    test('signs in with the new password and hands back the new words', async () => {
        const { reset } = resetting({});
        expect(await reset()).toEqual({ user, phrase: fresh, applied: true, storage: null });
    });

    test('a second step at that sign-in is answered with the new phrase, never the old one', async () => {
        const answers: unknown[] = [];
        const { reset, signed, client } = resetting({
            loginFinish: async () => ({ twoStep: stepAfter }),
            loginTwoStep: async (answer: never) => {
                answers.push(answer);
                return after;
            },
        });
        expect(await reset()).toMatchObject({ user, phrase: fresh, applied: true });
        expect(signed).toEqual([fresh]);
        expect(answers).toEqual([
            { token: step.token, proof: { kind: 'phrase', signature: 's'.repeat(86) } },
        ]);
        expect(client.isAuthenticating()).toBe(false);
    });

    test.each([
        [
            'the step cannot be answered',
            {
                loginFinish: async () => ({
                    twoStep: { ...step, methods: ['totp'], phrase: undefined },
                }),
            },
        ],
        [
            'the step’s answer is refused',
            {
                loginFinish: async () => ({ twoStep: stepAfter }),
                loginTwoStep: () => Promise.reject(refusal('No.', 401, 'step-wrong')),
            },
        ],
        [
            'the sign-in cannot reach the server',
            { loginFinish: () => Promise.reject(new TypeError('Failed to fetch')) },
        ],
    ])(
        'when %s, the reset the server confirmed still stands and the new words still come back',
        async (_name, server) => {
            const { reset, client } = resetting(server as never);
            // Not signed in here, and not an error either: the page shows the words.
            expect(await reset()).toEqual({
                user: null,
                phrase: fresh,
                applied: true,
                storage: null,
            });
            expect(client.isAuthenticating()).toBe(false);
        },
    );

    test('a refusal the server answered is the reset not applied: it is thrown, and no new words are handed over', async () => {
        const { reset } = resetting({
            recoverFinish: () => Promise.reject(refusal('This link has expired.', 400)),
        });
        await expect(reset()).rejects.toThrow('This link has expired.');
    });

    /*
     * The reset's reply never arrived. Whether it landed is read from the reset itself: the
     * account's credential version in the envelope, or its recovery key's version at the step.
     * Never from the new password signing in: someone may reset to the password they already
     * have, and then it signs in either way. Saying "applied" on that would tell them their
     * working phrase is dead and hand them new words that open nothing.
     */
    describe('when the server’s answer to the reset is lost', () => {
        const lost = [
            ['no answer', () => Promise.reject(new TypeError('Failed to fetch'))],
            ['a gateway’s 502', () => Promise.reject(refusal('Please try again.', 502))],
            ['a portal’s page', async () => '<html>Sign in to Wi-Fi</html>'],
        ] as const;

        test.each(lost)(
            'after %s, the account at the reset’s credential version shows it was applied',
            async (_name, recoverFinish) => {
                const { reset } = resetting({ recoverFinish: recoverFinish as never });
                expect(await reset()).toEqual({
                    user,
                    phrase: fresh,
                    applied: true,
                    storage: null,
                });
            },
        );

        test.each(lost)(
            'after %s, the same password as before signing in to the account as it was is not "applied": the old phrase is still the phrase',
            async (_name, recoverFinish) => {
                let signedOut = 0;
                // The reset never landed, and the new password is the one the account already
                // had: the sign-in works, on the old credential.
                const { reset, client } = resetting({
                    recoverFinish: recoverFinish as never,
                    loginFinish: async () => before,
                    logout: async () => void signedOut++,
                });
                const result = await reset().catch((error: unknown) => error);
                expect(result).toBeInstanceOf(Error);
                expect((result as Error).message).toContain('Your password was not changed');
                // No new words are handed over as the account's phrase, and the session that
                // answered the question is not left open behind the page.
                expect(signedOut).toBe(1);
                expect(client.store.getState().unlockedUserId).toBeNull();
            },
        );

        test.each(lost)(
            'after %s, a step that names the old recovery key is not answered: the new words are not the account’s, and would only be a counted wrong answer',
            async (_name, recoverFinish) => {
                const answers: unknown[] = [];
                const { reset, signed } = resetting({
                    recoverFinish: recoverFinish as never,
                    loginFinish: async () => ({ twoStep: stepBefore }),
                    loginTwoStep: async (answer: never) => void answers.push(answer),
                });
                await expect(reset()).rejects.toThrow('Your password was not changed');
                expect(signed).toEqual([]);
                expect(answers).toEqual([]);
            },
        );

        test.each(lost)(
            'after %s, a step that names the reset’s recovery key shows it was applied, and the new phrase answers it',
            async (_name, recoverFinish) => {
                const { reset, signed } = resetting({
                    recoverFinish: recoverFinish as never,
                    loginFinish: async () => ({ twoStep: stepAfter }),
                    loginTwoStep: async () => after,
                });
                expect(await reset()).toEqual({
                    user,
                    phrase: fresh,
                    applied: true,
                    storage: null,
                });
                expect(signed).toEqual([fresh]);
            },
        );

        test.each(lost)(
            'after %s, the new password being refused shows it was not applied',
            async (_name, recoverFinish) => {
                const { reset } = resetting(
                    { recoverFinish: recoverFinish as never },
                    { wrongPassword: true },
                );
                await expect(reset()).rejects.toThrow('Your password was not changed');
            },
        );

        test.each(lost)(
            'after %s, with the server still out of reach, the new words are kept and nothing is claimed',
            async (_name, recoverFinish) => {
                const { reset } = resetting({
                    recoverFinish: recoverFinish as never,
                    loginStart: () => Promise.reject(new TypeError('Failed to fetch')),
                });
                expect(await reset()).toEqual({
                    user: null,
                    phrase: fresh,
                    applied: 'unknown',
                    storage: null,
                });
            },
        );

        test('the password matching, with no reply that shows the account’s versions, is not evidence: the outcome stays unknown', async () => {
            // The password's half of the sign-in went through, and then the connection dropped.
            const { reset } = resetting({
                recoverFinish: () => Promise.reject(new TypeError('Failed to fetch')),
                loginFinish: () => Promise.reject(new TypeError('Failed to fetch')),
            });
            expect(await reset()).toEqual({
                user: null,
                phrase: fresh,
                applied: 'unknown',
                storage: null,
            });
        });

        test('a step that shows the reset landed, then cannot be finished: applied, and the words come back', async () => {
            const { reset } = resetting({
                recoverFinish: () => Promise.reject(new TypeError('Failed to fetch')),
                loginFinish: async () => ({ twoStep: stepAfter }),
                loginTwoStep: () => Promise.reject(new TypeError('Failed to fetch')),
            });
            expect(await reset()).toEqual({
                user: null,
                phrase: fresh,
                applied: true,
                storage: null,
            });
        });
    });
});
