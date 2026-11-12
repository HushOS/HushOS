import { describe, expect, test } from 'vitest';
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

const { createAuthClient, StepFailure, TwoStepRequired } = await import('./client');

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
        ['a server that cannot check', refusal('Unavailable right now.', 503), 'unavailable'],
        ['no connection', new TypeError('Failed to fetch'), 'offline'],
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
        const { client } = change(async (input: never) => void sent.push(input));
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
        // Any other failure may be a lost reply, and is still cleaned up after as before.
        const unknown = change(() => Promise.reject(new TypeError('Failed to fetch')));
        await expect(
            unknown.client.changeSecurity(user, 'password', 'correct horse', 'a new one', twoStep),
        ).rejects.toThrow('Failed to fetch');
        expect(unknown.cleared()).toBe(1);
    });
});
