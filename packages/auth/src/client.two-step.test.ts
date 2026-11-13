import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AuthApi, KeyAssertion, KeyRequestOptions } from './api';
import type { PasskeyDriver } from './client';
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

const { createAuthClient, LostReply, PASSWORD_EXCHANGE_MS, StepFailure, TwoStepRequired } =
    await import('./client');

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
/* A refusal whose body was the server's own, as the web's API client marks it. */
const answered = (message: string, status: number) =>
    Object.assign(new Error(message), { status, answered: true });

/* A client whose worker and server record what reaches them. */
function setup(
    server: Partial<Record<keyof AuthApi, (...input: never[]) => unknown>>,
    passkeys?: PasskeyDriver,
) {
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
    const client = createAuthClient(() => transport, keys, api, { passkeys });
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

    describe('how long a step is held', () => {
        afterEach(() => {
            vi.useRealTimers();
            vi.restoreAllMocks();
        });

        test('a device whose clock runs fast can still answer: the step’s life is counted from when it arrived, never read off the date', async () => {
            // The phone's clock is twenty minutes ahead of the server's: by its date, the
            // step the server just made ended a quarter of an hour ago.
            vi.useFakeTimers({ now: Date.now() + 20 * 60_000, toFake: ['Date'] });
            const { client, toStep, locks } = setup({ loginTwoStep: async () => session });
            expect(await toStep()).toBeInstanceOf(TwoStepRequired);
            expect(Date.parse(step.expiresAt)).toBeLessThan(Date.now() - 10 * 60_000);
            // Still held, and still answerable: the server is the one that says when it ended.
            expect(client.isAuthenticating()).toBe(true);
            expect(locks()).toBe(0);
            expect(await client.answerStep({ kind: 'totp', code: '123456' })).toEqual(user);
        });

        test('it is let go six minutes after it arrived, on a clock that only runs forward, whatever the date does', async () => {
            const clock = vi.spyOn(performance, 'now').mockReturnValue(1_000);
            const { client, toStep, locks } = setup({ loginTwoStep: async () => session });
            await toStep();
            // The date jumps back an hour (the clock was corrected): nothing changes.
            vi.useFakeTimers({ now: Date.now() - 60 * 60_000, toFake: ['Date'] });
            clock.mockReturnValue(1_000 + 6 * 60_000 - 1);
            expect(client.isAuthenticating()).toBe(true);
            clock.mockReturnValue(1_000 + 6 * 60_000 + 1);
            expect(client.isAuthenticating()).toBe(false);
            expect(locks()).toBe(1);
            await expect(client.answerStep({ kind: 'totp', code: '123456' })).rejects.toMatchObject(
                { reason: 'over' },
            );
        });
    });

    test('a step nobody answers lets go of what the worker holds when its time is up, with nothing else happening', async () => {
        const clock = vi.spyOn(performance, 'now').mockReturnValue(1_000);
        vi.useFakeTimers({ toFake: ['setTimeout'] });
        try {
            const { client, toStep, locks } = setup({ loginTwoStep: async () => session });
            await toStep();
            expect(locks()).toBe(0);
            // The form sits idle: no operation looks at the step, but its time runs out.
            clock.mockReturnValue(1_000 + 6 * 60_000 + 2_000);
            vi.advanceTimersByTime(6 * 60_000 + 1_000);
            expect(locks()).toBe(1);
            expect(client.isAuthenticating()).toBe(false);
        } finally {
            vi.useRealTimers();
            clock.mockRestore();
        }
    });

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
        ).toEqual({ signedIn: true, uncertain: false, storage: null, phrase: null });
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
        ).toEqual({ signedIn: false, uncertain: false, storage: null, phrase: null });
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
        const cannotCheck = refusal('Unavailable right now.', 503, 'step-unavailable');
        const unchecked = change(() => Promise.reject(cannotCheck));
        await expect(
            unchecked.client.changeSecurity(
                user,
                'password',
                'correct horse',
                'a new one',
                twoStep,
            ),
        ).rejects.toBe(cannotCheck);
        expect(unchecked.cleared()).toBe(0);
        // The address's limit, and any refusal in the server's own words, say the same of the
        // change and say it plainly: nothing changed.
        for (const refused of [
            refusal('Too many requests.', 429),
            answered('Account security could not be changed. Sign in again and retry.', 409),
        ]) {
            const busy = change(() => Promise.reject(refused));
            const said = await busy.client
                .changeSecurity(user, 'password', 'correct horse', 'a new one', twoStep)
                .catch((error: Error) => error.message);
            expect(said).toBe(
                `${refused.message} Your password was not changed. Nothing changed, and your recovery phrase is still the one you have. Please try again.`,
            );
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
            ).toEqual({ signedIn: false, uncertain: true, storage: null, phrase: null });
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

    test('one waiting its turn when the browser locks never runs, so it cannot act for an account that signs in after', async () => {
        let answerFirst!: (challenge: unknown) => void;
        const started: unknown[] = [];
        let secondExchange = false;
        const client = oneExchange({
            devicesReauth: () => new Promise((resolve) => (answerFirst = resolve)),
            removeOtherDevices: async () => ({ removed: 0 }),
            twoStepReauth: async () => {
                secondExchange = true;
                return { attemptToken: 'second' };
            },
            twoStepStartTotp: async (input: never) => {
                started.push(input);
                return { id: 'app', secret: 'KEY', uri: 'otpauth://totp/x' };
            },
        });
        const removal = client.removeOtherDevices('the password');
        await vi.waitFor(() => expect(answerFirst).toBeTypeOf('function'));
        const another = client.startAuthenticator('the password');
        // The browser is locked (or signed out) while the second waits its turn.
        await client.lock();
        answerFirst({ attemptToken: 'first' });
        await expect(removal).rejects.toThrow(/locked or signed out meanwhile/);
        await expect(another).rejects.toThrow(/locked or signed out meanwhile/);
        // Neither exchange was finished for whoever is signed in now, and nothing was started.
        expect(secondExchange).toBe(false);
        expect(started).toEqual([]);
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
 * A reset with the recovery phrase, and a new recovery phrase or a new account key from
 * Account, each replace the phrase. The old words stop working the moment the server accepts
 * the change, and the page that shows the new ones is behind the sign-in. With two-step
 * sign-in on, someone whose only second step is their phrase would be locked out for good:
 * the old phrase refused, the new one never seen. So:
 *
 * - the change's own sign-in answers a second step with the new phrase;
 * - once the request has left, the new words always come back, unless the server answered a
 *   refusal in its own words. Nothing else says the change was not made: a probe that sees
 *   the account as it was proves nothing, since the server can commit a moment later, and
 *   words thrown away could turn out to be the only way in;
 * - "applied" is said only when the server said so, or serves back what this change made (the
 *   salt of the envelope it sealed, or of the recovery key it sent). A version number is not
 *   that: another device's change moves it to the same number. Otherwise the outcome is
 *   unknown, and the page says to keep both phrases.
 */
const MADE = {
    envelope: { wrappingSalt: 'bWFkZS1lbnZlbG9wZQ' },
    recovery: { wrappingSalt: 'bWFkZS1yZWNvdmVyeQ' },
};
// The account as this change leaves it, and a step that names the recovery key it sent.
const afterChange = {
    ...session,
    envelope: {
        ...session.envelope,
        credentialVersion: 2,
        wrappingSalt: MADE.envelope.wrappingSalt,
    },
};
const stepAfterChange = {
    ...step,
    phrase: { ...step.phrase, recoveryVersion: 2, wrappingSalt: MADE.recovery.wrappingSalt },
};
// The account at the same versions, by another device's change: not this one's salts.
const afterAnothersChange = { ...session, envelope: { ...session.envelope, credentialVersion: 2 } };
const stepAfterAnothersChange = { ...step, phrase: { ...step.phrase, recoveryVersion: 2 } };
const lostReplies = [
    ['no answer', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a gateway’s 502', () => Promise.reject(refusal('Please try again.', 502))],
    ['a portal’s page', async () => '<html>Sign in to Wi-Fi</html>'],
    // A 4xx is not the server's refusal unless the body was the server's.
    ['a proxy’s 403', () => Promise.reject(refusal('Please try again.', 403))],
] as const;

/* A client whose worker makes `fresh` and the salts in MADE, and whose server is `server`. */
function changing(
    fresh: string,
    server: Partial<Record<keyof AuthApi, (...input: never[]) => unknown>>,
    worker: { wrongPassword?: boolean } = {},
) {
    items.clear();
    const signed: string[] = [];
    const reached: string[] = [];
    let signedOut = 0;
    const transport: CryptoTransport = {
        request: async (operation, input) => {
            if (operation === 'recoverFinish' || operation === 'securityFinish')
                return MADE as never;
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
        loginStart: async () => {
            reached.push('loginStart');
            return { attemptToken: 'attempt' };
        },
        loginFinish: async () => afterChange,
        logout: async () => void signedOut++,
        ...server,
    } as unknown as AuthApi);
    return { client, signed, reached, signedOut: () => signedOut };
}

describe('a reset with the recovery phrase', () => {
    const fresh = 'fresh words made by the reset';
    function resetting(
        server: Partial<Record<keyof AuthApi, (...input: never[]) => unknown>>,
        worker: { wrongPassword?: boolean } = {},
    ) {
        const made = changing(
            fresh,
            {
                recoverStart: async () => ({
                    userId: user.id,
                    attemptToken: 'a',
                    credentialVersion: 1,
                }),
                recoverFinish: async () => ({ user }),
                ...server,
            },
            worker,
        );
        return {
            ...made,
            reset: () => made.client.recover(user.email, 'a new password', 'the old words'),
        };
    }
    const unknown = { user: null, phrase: fresh, applied: 'unknown', storage: null };

    test('signs in with the new password and hands back the new words', async () => {
        const { reset } = resetting({});
        expect(await reset()).toEqual({ user, phrase: fresh, applied: true, storage: null });
    });

    test('a second step at that sign-in is answered with the new phrase, never the old one', async () => {
        const answers: unknown[] = [];
        const { reset, signed, client } = resetting({
            loginFinish: async () => ({ twoStep: stepAfterChange }),
            loginTwoStep: async (answer: never) => {
                answers.push(answer);
                return afterChange;
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
                loginFinish: async () => ({ twoStep: stepAfterChange }),
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

    test('only a refusal in the server’s own words says the password was not changed: then no new words are handed over', async () => {
        const { reset, reached } = resetting({
            recoverFinish: () => Promise.reject(answered('This link has expired.', 400)),
        });
        const said = await reset().catch((error: Error) => error.message);
        expect(said).toBe(
            'This link has expired. Your password was not changed. Nothing changed, and your recovery phrase is still the one you have. Please try again.',
        );
        expect(reached).toEqual([]);
    });

    describe.each(lostReplies)(
        'when the server’s answer to the reset is lost (%s)',
        (_name, recoverFinish) => {
            const lost = { recoverFinish: recoverFinish as never };

            test('the server handing back the envelope this reset sealed shows it was applied', async () => {
                const { reset } = resetting(lost);
                expect(await reset()).toEqual({
                    user,
                    phrase: fresh,
                    applied: true,
                    storage: null,
                });
            });

            test('a step that names the recovery key this reset sent shows it was applied, and the new phrase answers it', async () => {
                const { reset, signed } = resetting({
                    ...lost,
                    loginFinish: async () => ({ twoStep: stepAfterChange }),
                    loginTwoStep: async () => afterChange,
                });
                expect(await reset()).toEqual({
                    user,
                    phrase: fresh,
                    applied: true,
                    storage: null,
                });
                expect(signed).toEqual([fresh]);
            });

            test('the same password as before signing in to the account as it was is not "applied", and not "unchanged" either: the words are kept, beside the old', async () => {
                // The reset has not landed (yet), and the new password is the one the account
                // already had: the sign-in works, on the old credential.
                const { reset, signedOut, client } = resetting({
                    ...lost,
                    loginFinish: async () => session,
                });
                expect(await reset()).toEqual(unknown);
                // The session that answered the question is not left open behind the page.
                expect(signedOut()).toBe(1);
                expect(client.store.getState().unlockedUserId).toBeNull();
            });

            test('the account at the reset’s version numbers, by another device’s change, is not this reset: unknown', async () => {
                const { reset } = resetting({
                    ...lost,
                    loginFinish: async () => afterAnothersChange,
                });
                expect(await reset()).toEqual(unknown);
                const atStep = resetting({
                    ...lost,
                    loginFinish: async () => ({ twoStep: stepAfterAnothersChange }),
                    loginTwoStep: async () => afterAnothersChange,
                });
                expect(await atStep.reset()).toEqual(unknown);
                // The new words are not that account's phrase: sent, they would be a counted wrong answer.
                expect(atStep.signed).toEqual([]);
            });

            test('a step that names the old recovery key is left unanswered, and the words are kept: the server may commit a moment later', async () => {
                const answers: unknown[] = [];
                const { reset, signed } = resetting({
                    ...lost,
                    loginFinish: async () => ({ twoStep: step }),
                    loginTwoStep: async (answer: never) => void answers.push(answer),
                });
                expect(await reset()).toEqual(unknown);
                expect(signed).toEqual([]);
                expect(answers).toEqual([]);
            });

            test('the new password being refused does not throw the words away', async () => {
                const { reset } = resetting(lost, { wrongPassword: true });
                expect(await reset()).toEqual(unknown);
            });

            test('with the server still out of reach, the new words are kept and nothing is claimed', async () => {
                const { reset } = resetting({
                    ...lost,
                    loginStart: () => Promise.reject(new TypeError('Failed to fetch')),
                });
                expect(await reset()).toEqual(unknown);
            });

            test('a step that shows the reset landed, then cannot be finished: applied, and the words come back', async () => {
                const { reset } = resetting({
                    ...lost,
                    loginFinish: async () => ({ twoStep: stepAfterChange }),
                    loginTwoStep: () => Promise.reject(new TypeError('Failed to fetch')),
                });
                expect(await reset()).toEqual({
                    user: null,
                    phrase: fresh,
                    applied: true,
                    storage: null,
                });
            });
        },
    );
});

describe.each(['recovery-key', 'master-key'] as const)(
    'a %s change, with the step on',
    (action) => {
        const fresh = 'fresh words made by the rotation';
        function rotating(server: Partial<Record<keyof AuthApi, (...input: never[]) => unknown>>) {
            const made = changing(fresh, {
                securityStart: async () => ({ userId: user.id, action, attemptToken: 'a' }),
                // Committed on the server; the reply, and the session cookie with it, never arrive.
                securityFinish: () => Promise.reject(new TypeError('Failed to fetch')),
                // Every session ended with the change.
                session: async () => ({ user: null, device: null }),
                // The cookie was lost, so the sign-in meets the step, which names the new key.
                loginFinish: async () => ({ twoStep: stepAfterChange }),
                loginTwoStep: async () => afterChange,
                ...server,
            });
            return {
                ...made,
                change: () => made.client.changeSecurity(user, action, 'correct horse', ''),
            };
        }
        const notRotated =
            action === 'master-key'
                ? 'Your account key was not rotated. Nothing changed, and your recovery phrase is still the one you have. Please try again.'
                : 'Your recovery phrase was not replaced. Nothing changed, and your recovery phrase is still the one you have. Please try again.';

        test('only a refusal in the server’s own words says nothing changed: then no new words are handed over, and nothing is cleared', async () => {
            const { change, reached } = rotating({
                securityFinish: () =>
                    Promise.reject(
                        answered(
                            'Account security could not be changed. Sign in again and retry.',
                            409,
                        ),
                    ),
            });
            const said = await change().catch((error: Error) => error.message);
            expect(said).toBe(
                `Account security could not be changed. Sign in again and retry. ${notRotated}`,
            );
            expect(reached).toEqual([]);
        });

        describe.each(lostReplies)('when the reply is lost (%s)', (_name, securityFinish) => {
            const lost = { securityFinish: securityFinish as never };

            test('the step names the recovery key this change sent: it landed, the new phrase answers the step, and the person is signed in', async () => {
                const { change, signed } = rotating(lost);
                expect(await change()).toEqual({
                    signedIn: true,
                    uncertain: false,
                    storage: null,
                    phrase: null,
                });
                // Only the phrase could answer, and only the new one: the old is dead.
                expect(signed).toEqual([fresh]);
            });

            test.each([
                [
                    'the step’s answer cannot be sent',
                    { loginTwoStep: () => Promise.reject(new TypeError('Failed to fetch')) },
                ],
                [
                    'the step’s answer is refused',
                    { loginTwoStep: () => Promise.reject(refusal('No.', 401, 'step-wrong')) },
                ],
            ])(
                'it landed and %s: not signed in, and the new words come back to be shown',
                async (_case, server) => {
                    const { change, client } = rotating({ ...lost, ...(server as object) });
                    expect(await change()).toEqual({
                        signedIn: false,
                        uncertain: false,
                        storage: null,
                        phrase: fresh,
                    });
                    expect(client.isAuthenticating()).toBe(false);
                },
            );

            test('nothing can be reached again: unknown, and the new words still come back, to be kept beside the old', async () => {
                const { change } = rotating({
                    ...lost,
                    loginStart: () => Promise.reject(new TypeError('Failed to fetch')),
                });
                expect(await change()).toEqual({
                    signedIn: false,
                    uncertain: true,
                    storage: null,
                    phrase: fresh,
                });
            });

            test('the account looks as it was: that is no proof, so the words are kept and nothing is called unchanged', async () => {
                // Signed in on the old credential (the session it was made from still stood).
                const asItWas = rotating({ ...lost, loginFinish: async () => session });
                expect(await asItWas.change()).toEqual({
                    signedIn: true,
                    uncertain: true,
                    storage: null,
                    phrase: fresh,
                });
                // Or a step that names the old recovery key: left unanswered, since the new words
                // are not (yet) the account's and would only be a counted wrong answer.
                const answers: unknown[] = [];
                const oldKey = rotating({
                    ...lost,
                    loginFinish: async () => ({ twoStep: step }),
                    loginTwoStep: async (answer: never) => void answers.push(answer),
                });
                expect(await oldKey.change()).toEqual({
                    signedIn: false,
                    uncertain: true,
                    storage: null,
                    phrase: fresh,
                });
                expect(oldKey.signed).toEqual([]);
                expect(answers).toEqual([]);
            });

            test('the account at this change’s version numbers, by another device’s change, is not this change: unknown', async () => {
                const session2 = rotating({
                    ...lost,
                    loginFinish: async () => afterAnothersChange,
                });
                expect(await session2.change()).toMatchObject({ uncertain: true, phrase: fresh });
                const atStep = rotating({
                    ...lost,
                    loginFinish: async () => ({ twoStep: stepAfterAnothersChange }),
                });
                expect(await atStep.change()).toEqual({
                    signedIn: false,
                    uncertain: true,
                    storage: null,
                    phrase: fresh,
                });
                expect(atStep.signed).toEqual([]);
            });
        });

        test('the server said the change was made, and the sign-in after it fails: the new words come back', async () => {
            const { change } = rotating({
                securityFinish: async () => ({ success: true }),
                loginFinish: () => Promise.reject(new TypeError('Failed to fetch')),
            });
            expect(await change()).toEqual({
                signedIn: false,
                uncertain: false,
                storage: null,
                phrase: fresh,
            });
        });
    },
);

describe('a lost reply to a password change', () => {
    test('hands over no phrase (the phrase is not replaced) and is not probed by signing in, as before', async () => {
        const reached: string[] = [];
        const { client } = setup({
            securityStart: async () => ({ userId: user.id, action: 'password', attemptToken: 'a' }),
            securityFinish: () => Promise.reject(new TypeError('Failed to fetch')),
            session: async () => ({ user: null, device: null }),
            loginStart: async () => {
                reached.push('loginStart');
                return { attemptToken: 'attempt' };
            },
        });
        expect(await client.changeSecurity(user, 'password', 'correct horse', 'a new one')).toEqual(
            { signedIn: false, uncertain: true, storage: null, phrase: null },
        );
        expect(reached).toEqual([]);
    });
});

describe('a password exchange that never settles', () => {
    afterEach(() => vi.useRealTimers());

    test('is given up on after its time, so the next one goes through; its late reply then touches nothing', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        items.clear();
        const worker: string[] = [];
        let held = '';
        const transport: CryptoTransport = {
            request: async (operation, input) => {
                worker.push(String(operation));
                if (operation === 'reauthStart') held = (input as { password: string }).password;
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
        let answerStalled!: (challenge: unknown) => void;
        const removed: unknown[] = [];
        const client = createAuthClient(() => transport, keys, {
            // The first exchange's request hangs: no answer, no error.
            devicesReauth: () => new Promise((resolve) => (answerStalled = resolve)),
            removeOtherDevices: async (proof: never) => void removed.push(proof),
            twoStepReauth: async () => ({ attemptToken: 'second' }),
            twoStepStartTotp: async () => ({ id: 'app', secret: 'KEY', uri: 'otpauth://totp/x' }),
        } as unknown as AuthApi);

        const stalled = client.removeOtherDevices('first password').catch((error: Error) => error);
        // Not `vi.waitFor`: under fake timers it would run the very clock this test is about.
        for (let turn = 0; turn < 50 && !answerStalled; turn++) await Promise.resolve();
        expect(answerStalled).toBeTypeOf('function');
        const next = client.startAuthenticator('second password');
        // The second waits its turn for as long as the first is given.
        await vi.advanceTimersByTimeAsync(PASSWORD_EXCHANGE_MS - 1);
        expect(worker.filter((operation) => operation === 'reauthStart')).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(2);
        expect((await stalled) as Error).toMatchObject({
            message: 'This took too long. Please try again.',
        });
        // And then goes through, on its own exchange.
        expect(await next).toMatchObject({ id: 'app' });
        // The stalled request answers at last, while a third exchange is under way: it does
        // not finish that one's exchange, clear it, or send anything on its behalf.
        const third = client.startAuthenticator('third password');
        answerStalled({ attemptToken: 'first' });
        expect(await third).toMatchObject({ id: 'app' });
        expect(removed).toEqual([]);
        expect(worker.filter((operation) => operation === 'reauthFinish')).toHaveLength(2);
    });
});

describe('passkeys, and what this client tells the server it can answer', () => {
    const webauthn: KeyRequestOptions = {
        challenge: 'Y2hhbGxlbmdl',
        rpId: 'hushos.com',
        timeout: 300_000,
        userVerification: 'discouraged',
        allowCredentials: [{ id: 'a2V5', type: 'public-key' }],
    };
    const keyStep = { ...step, methods: ['webauthn', 'backup', 'phrase'], webauthn };
    const assertion: KeyAssertion = {
        id: 'a2V5',
        rawId: 'a2V5',
        type: 'public-key',
        response: { clientDataJSON: 'ZGF0YQ', authenticatorData: 'YXV0aA', signature: 'c2ln' },
    };
    /* A device with a key that answers, and a record of when its sheet was opened. */
    function driver(overrides: Partial<PasskeyDriver> = {}) {
        const asked: KeyRequestOptions[] = [];
        const passkeys: PasskeyDriver = {
            supported: () => true,
            get: async (options) => {
                asked.push(options);
                return assertion;
            },
            create: async () => {
                throw new Error('Not asked for in these tests.');
            },
            ...overrides,
        };
        return { passkeys, asked };
    }
    const advertising = {
        loginStart: async () => ({ attemptToken: 'attempt', twoStepMethods: true }),
    };

    test('the key’s sheet opens only when its answer is sent, for this step’s challenge, and its assertion is what goes', async () => {
        const sent: unknown[] = [];
        const { passkeys, asked } = driver();
        const { client, toStep } = setup(
            {
                ...advertising,
                loginFinish: async () => ({ twoStep: keyStep }),
                loginTwoStep: async (input: never) => {
                    sent.push(input);
                    return session;
                },
            },
            passkeys,
        );
        const stopped = await toStep();
        expect(stopped).toBeInstanceOf(TwoStepRequired);
        // The step is on screen and nothing has asked the key yet: no sheet on page load.
        expect(asked).toEqual([]);
        expect(await client.answerStep({ kind: 'webauthn' })).toEqual(user);
        expect(asked).toEqual([webauthn]);
        expect(sent).toEqual([
            { token: step.token, proof: { kind: 'webauthn', response: assertion } },
        ]);
    });

    test('a sheet that was closed sends nothing and leaves the step, and what the worker holds, where they were', async () => {
        const sent: unknown[] = [];
        const { passkeys } = driver({
            get: async () => {
                throw new DOMException('The operation was cancelled.', 'NotAllowedError');
            },
        });
        const { client, toStep, locks } = setup(
            {
                ...advertising,
                loginFinish: async () => ({ twoStep: keyStep }),
                loginTwoStep: async (input: never) => {
                    sent.push(input);
                    return session;
                },
            },
            passkeys,
        );
        await toStep();
        const failure = await client
            .answerStep({ kind: 'webauthn' })
            .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(StepFailure);
        expect(failure).toMatchObject({ reason: 'wrong', again: true });
        expect(sent).toEqual([]);
        expect(locks()).toBe(0);
        // Another way still answers the same step.
        expect(await client.answerStep({ kind: 'backup', code: '7KQ2M-9XD4P' })).toEqual(user);
    });

    test('methods are named only to a server that said it reads them, and only the ones this device can use', async () => {
        const finish = async (server: object, passkeys?: PasskeyDriver) => {
            const bodies: Record<string, unknown>[] = [];
            const { toStep } = setup(
                {
                    ...server,
                    loginFinish: async (input: never) => {
                        bodies.push(input);
                        return { twoStep: step };
                    },
                },
                passkeys,
            );
            await toStep();
            return bodies;
        };
        // A release from before passkeys says nothing at login/start, and is sent nothing new.
        const old = await finish({}, driver().passkeys);
        expect(old).toHaveLength(1);
        expect('twoStepMethods' in old[0]!).toBe(false);
        // One that advertises is told what this device can answer.
        expect((await finish(advertising, driver().passkeys))[0]!.twoStepMethods).toEqual([
            'webauthn',
        ]);
        // A device that cannot use a passkey for this server names none, so it is never shown one.
        expect(
            (await finish(advertising, driver({ supported: () => false }).passkeys))[0]!
                .twoStepMethods,
        ).toEqual([]);
        expect((await finish(advertising))[0]!.twoStepMethods).toEqual([]);
    });

    test('a login/finish that refuses the field is asked once more without it, on the same attempt', async () => {
        for (const status of [422, 400]) {
            const bodies: Record<string, unknown>[] = [];
            const { client, toStep } = setup(
                {
                    ...advertising,
                    loginFinish: async (input: never) => {
                        bodies.push(input);
                        if ('twoStepMethods' in (input as object))
                            throw refusal('Please check your information and try again.', status);
                        return { twoStep: step };
                    },
                    loginTwoStep: async () => session,
                },
                driver().passkeys,
            );
            expect(await toStep()).toBeInstanceOf(TwoStepRequired);
            expect(bodies.map((body) => 'twoStepMethods' in body)).toEqual([true, false]);
            expect(bodies[1]!.attemptToken).toBe(bodies[0]!.attemptToken);
            expect(await client.answerStep({ kind: 'totp', code: '123456' })).toEqual(user);
        }
        // A wrong password is not that: it is not sent twice.
        let asked = 0;
        const { toStep } = setup(
            {
                ...advertising,
                loginFinish: async () => {
                    asked += 1;
                    throw refusal('Unable to sign in.', 401);
                },
            },
            driver().passkeys,
        );
        await toStep();
        expect(asked).toBe(1);
    });

    test('a change’s step names methods by what the server last said, tries once when it never said, and remembers a refusal', async () => {
        const calls: unknown[][] = [];
        let refuse = false;
        const server = {
            twoStepChallenge: async (...input: never[]) => {
                calls.push(input);
                if (refuse && input[1] !== undefined) throw refusal('Please check.', 400);
                return keyStep;
            },
        };
        // The server advertised at the last sign-in: named.
        const signedIn = setup({ ...advertising, ...server }, driver().passkeys);
        await signedIn.toStep();
        await signedIn.client.stepChallenge('password');
        expect(calls.at(-1)).toEqual(['password', ['webauthn']]);
        // It said nothing (a release from before passkeys): not named.
        const old = setup(server, driver().passkeys);
        await old.toStep();
        await old.client.stepChallenge('password');
        expect(calls.at(-1)).toEqual(['password']);

        // Never said either way (a session from before this client): tried, and a refusal is
        // answered by asking again without, then remembered.
        const unknown = setup(server, driver().passkeys);
        refuse = true;
        calls.length = 0;
        expect(await unknown.client.stepChallenge('delete')).toMatchObject({ token: step.token });
        expect(calls).toEqual([['delete', ['webauthn']], ['delete']]);
        await unknown.client.stepChallenge('delete');
        expect(calls.at(-1)).toEqual(['delete']);
        expect(calls).toHaveLength(3);
    });
});
