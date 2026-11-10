import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AuthApi, StepChallenge, StepOffer, StepSubmission, SteppedIn } from './api';
import type { AskStep, StepAnswer, StepRequest } from './client';
import type { CryptoTransport } from './crypto-transport';
import type { DeviceKeyStore } from './device-storage';
import type { SessionUser } from './protocol';

/*
 * The second step in the auth client (docs/two-step-design.md 4 and 10, "Codes a client acts
 * on"): what a sign-in and a guarded change send, and what each of the server's answers does
 * next. The server and the worker are stand-ins that record what they were handed, so each
 * test fails on what a person would meet: a sign-in that opens without the step, a password
 * asked for twice, a phrase that leaves the device, a wrong code that ends a change, a change
 * that signs its own device out.
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

const { createAuthClient, StepCancelled } = await import('./client');

const user = {
    id: '0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4',
    email: 'maya@example.com',
    credentialVersion: 1,
} as SessionUser;
const envelope = { envelopeVersion: 1, keyVersion: 1, credentialVersion: 1 };
const signedIn = {
    user,
    envelope,
    device: { id: 'device', attached: false, registered: true },
    twoStep: { offered: true },
} as unknown as SteppedIn;
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const notAPhrase = 'That is not a valid recovery phrase. Check each word and try again.';
const WRONG = 'That code didn’t work. Codes change every 30 seconds.';
const challenge = (token: string, extra: Partial<StepChallenge> = {}): StepChallenge => ({
    token,
    methods: ['totp', 'backup', 'phrase'],
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    expiresIn: 300,
    phrase: { userId: user.id, recoveryVersion: 3, wrappingSalt: 'salt' },
    ...extra,
});
/* A refusal as the web's API adapter throws it: the server's words, its status, its code if any. */
const refused = (message: string, status: number, code?: string) =>
    Object.assign(new Error(message), { status }, code ? { code } : {});

const keys: DeviceKeyStore = {
    create: async () => ({ id: 'device-key-1', key: {} as CryptoKey }),
    load: async () => null,
    clear: async () => {},
};

/*
 * The worker: every operation it was asked for, and how often it was locked. `answers`
 * replaces an operation's reply (or throws in its place).
 */
function worker(answers: Record<string, (input: unknown) => unknown> = {}) {
    const asked: { operation: string; input: unknown }[] = [];
    /* Operations and locks in the order they came: what the worker held when it was locked. */
    const order: string[] = [];
    let locks = 0;
    const transport: CryptoTransport = {
        request: async (operation, input) => {
            asked.push({ operation, input });
            order.push(operation);
            const answer = answers[operation];
            if (answer) return answer(input) as never;
            if (operation === 'twoStepPhrase')
                return {
                    signature: `signed:${(input as { stepToken: string }).stepToken}`,
                } as never;
            if (operation === 'reauthStart' || operation === 'loginStart')
                return {
                    startLoginRequest: `start:${(input as { password: string }).password}`,
                } as never;
            if (operation === 'reauthFinish' || operation === 'loginFinish')
                return { finishLoginRequest: 'finish' } as never;
            if (operation === 'remember') return { userId: user.id, deviceKeyId: 'k' } as never;
            return {} as never;
        },
        lock: () => {
            locks++;
            order.push('lock');
        },
        onLock() {},
    };
    const did = (operation: string) => asked.filter((entry) => entry.operation === operation);
    return { transport, asked, order, did, locks: () => locks };
}

/* A screen that answers each request with the next of `answers`, and records what it was shown. */
function screen(answers: (StepAnswer | null)[]) {
    const shown: StepRequest[] = [];
    const ask: AskStep = async (request) => {
        shown.push(request);
        const answer = answers.shift();
        if (answer === undefined) throw new Error('The screen was asked more often than expected.');
        return answer;
    };
    return { ask, shown };
}

beforeEach(() => items.clear());

describe('signing in to an account with a second step', () => {
    /* A server that asks for the step and answers each try with the next of `replies`. */
    function signIn(
        replies: (Error | SteppedIn)[],
        offer = challenge('step-1'),
        answers?: Parameters<typeof worker>[0],
    ) {
        const finished: unknown[] = [];
        const sent: StepSubmission[] = [];
        const api = {
            loginStart: async () => ({ attemptToken: 'attempt', loginResponse: 'r' }),
            loginFinish: async (input: unknown) => {
                finished.push(input);
                return { twoStep: offer };
            },
            loginTwoStep: async (input: StepSubmission) => {
                sent.push(input);
                const reply = replies.shift();
                if (!reply) throw new Error('The server was asked more often than expected.');
                if (reply instanceof Error) throw reply;
                return reply;
            },
        } as unknown as AuthApi;
        const crypto = worker(answers);
        const auth = createAuthClient(() => crypto.transport, keys, api);
        return { auth, finished, sent, crypto };
    }

    test('says it can answer one, asks, and opens the account only with the answer’s envelope', async () => {
        const { auth, finished, sent, crypto } = signIn([signedIn]);
        const { ask, shown } = screen([{ kind: 'totp', code: '123 456' }]);
        const result = await auth.login(user.email, 'correct horse', { step: ask });
        expect(result).toEqual({ user, step: { answered: 'totp', offered: true } });
        expect(finished).toEqual([expect.objectContaining({ twoStep: 1 })]);
        expect(shown).toEqual([
            { methods: ['totp', 'backup', 'phrase'], endsIn: expect.any(Number) },
        ]);
        // The code as the server reads it, on the token it issued.
        expect(sent).toEqual([{ token: 'step-1', proof: { kind: 'totp', code: '123456' } }]);
        // Nothing was unlocked before the step: the one unlock carries the step reply's envelope.
        expect(crypto.did('unlock')).toEqual([
            { operation: 'unlock', input: { userId: user.id, envelope } },
        ]);
        expect(auth.store.getState().unlockedUserId).toBe(user.id);
    });

    test('a backup code’s sign-in says how many are left, and whether a new set can be made', async () => {
        const reply = { ...signedIn, twoStep: { offered: false, backupCodesLeft: 2 } };
        const { auth } = signIn([reply]);
        const { ask } = screen([{ kind: 'backup', code: '7KQ2M-9XD4P' }]);
        expect(await auth.login(user.email, 'correct horse', { step: ask })).toEqual({
            user,
            step: { answered: 'backup', offered: false, backupCodesLeft: 2 },
        });
    });

    test('the time left is counted from when the offer arrived, whatever this device’s clock says', async () => {
        // The server's clock is ten minutes behind this one: its `expiresAt` is already past here.
        const offer = challenge('step-1', {
            expiresAt: new Date(Date.now() - 300_000).toISOString(),
        });
        const { auth } = signIn([signedIn], offer);
        const { ask, shown } = screen([{ kind: 'totp', code: '123456' }]);
        await auth.login(user.email, 'correct horse', { step: ask });
        expect(shown[0]!.endsIn).toBeGreaterThan(295_000);
        expect(shown[0]!.endsIn).toBeLessThanOrEqual(300_000);
    });

    test('what is not a code is asked again in the server’s words, without a request', async () => {
        const { auth, sent } = signIn([signedIn]);
        const { ask, shown } = screen([
            { kind: 'totp', code: '12345' },
            { kind: 'backup', code: 'short' },
            { kind: 'backup', code: '7kq2m 9xd4p' },
        ]);
        await auth.login(user.email, 'correct horse', { step: ask });
        expect(shown.map((request) => request.error)).toEqual([
            undefined,
            'Enter the six digits your authenticator app shows.',
            'Enter a backup code as it was shown: ten letters and numbers.',
        ]);
        expect(sent).toEqual([{ token: 'step-1', proof: { kind: 'backup', code: '7KQ2M9XD4P' } }]);
    });

    test('a wrong code is asked again on the same token, and the password is not', async () => {
        const { auth, sent, crypto } = signIn([refused(WRONG, 401, 'two-step'), signedIn]);
        const { ask, shown } = screen([
            { kind: 'totp', code: '111111' },
            { kind: 'totp', code: '222222' },
        ]);
        await auth.login(user.email, 'correct horse', { step: ask });
        expect(shown[1]).toMatchObject({ error: WRONG });
        expect(shown[1]!.notice).toBeUndefined();
        expect(sent.map((entry) => entry.token)).toEqual(['step-1', 'step-1']);
        expect(crypto.did('loginStart')).toHaveLength(1);
        expect(auth.store.getState().unlockedUserId).toBe(user.id);
    });

    test('a token that is gone ends the sign-in, and the key the password opened is dropped', async () => {
        const gone = refused('Your sign-in timed out. Sign in again.', 401, 'two-step-expired');
        const { auth, crypto } = signIn([gone]);
        const { ask, shown } = screen([{ kind: 'totp', code: '111111' }]);
        await expect(auth.login(user.email, 'correct horse', { step: ask })).rejects.toBe(gone);
        expect(shown).toHaveLength(1);
        expect(crypto.locks()).toBe(1);
        expect(crypto.did('unlock')).toEqual([]);
        expect(auth.store.getState().unlockedUserId).toBeNull();
    });

    test('backing out sends nothing, opens nothing and drops the key', async () => {
        const { auth, sent, crypto } = signIn([signedIn]);
        const { ask } = screen([null]);
        await expect(auth.login(user.email, 'correct horse', { step: ask })).rejects.toBeInstanceOf(
            StepCancelled,
        );
        expect(sent).toEqual([]);
        expect(crypto.locks()).toBe(1);
        expect(auth.store.getState().unlockedUserId).toBeNull();
    });

    test('paused codes and a spent budget take those methods off the screen and are said as notices; the phrase stays', async () => {
        const frozen = 'Authenticator codes are paused here after too many wrong ones.';
        const spent = 'Too many wrong codes. Try again in 15 minutes, or use your recovery phrase.';
        const { auth, sent } = signIn([
            refused(frozen, 403, 'totp-frozen'),
            refused(spent, 429, 'code-budget'),
            signedIn,
        ]);
        const { ask, shown } = screen([
            { kind: 'totp', code: '111111' },
            { kind: 'backup', code: '7KQ2M9XD4P' },
            { kind: 'phrase', phrase: PHRASE },
        ]);
        await auth.login(user.email, 'correct horse', { step: ask });
        // About the step, not the field in front of the person: a notice, never the field's error.
        expect(shown.map((request) => [request.methods, request.notice, request.error])).toEqual([
            [['totp', 'backup', 'phrase'], undefined, undefined],
            [['backup', 'phrase'], frozen, undefined],
            [['phrase'], spent, undefined],
        ]);
        expect(sent.at(-1)).toEqual({
            token: 'step-1',
            proof: { kind: 'phrase', signature: 'signed:step-1' },
        });
    });

    test('a key the server no longer has takes that kind of code away, and the phrase still answers', async () => {
        const down = refused(
            'Two-step sign-in is unavailable. Please try again later.',
            503,
            'two-step-unavailable',
        );
        const { auth } = signIn([down, signedIn]);
        const { ask, shown } = screen([
            { kind: 'totp', code: '111111' },
            { kind: 'phrase', phrase: PHRASE },
        ]);
        await auth.login(user.email, 'correct horse', { step: ask });
        expect(shown[1]).toMatchObject({ methods: ['backup', 'phrase'], notice: down.message });
    });

    test.each([
        ['a gateway’s 503', refused('Service unavailable.', 503)],
        ['the per-address 429', refused('Too many attempts. Please try again in 15 minutes.', 429)],
        ['a 400 that is not about the code', refused('Bad request.', 400)],
    ])('%s is not taken for the step’s own refusal: the sign-in ends with it', async (_, error) => {
        const { auth } = signIn([error]);
        const { ask, shown } = screen([{ kind: 'totp', code: '111111' }]);
        await expect(auth.login(user.email, 'correct horse', { step: ask })).rejects.toBe(error);
        expect(shown).toHaveLength(1);
    });

    test('with no method left the refusal ends the sign-in', async () => {
        const spent = refused('Too many wrong codes. Try again in 15 minutes.', 429, 'code-budget');
        const { auth } = signIn([spent], challenge('step-1', { methods: ['totp', 'backup'] }));
        const { ask, shown } = screen([{ kind: 'totp', code: '111111' }]);
        await expect(auth.login(user.email, 'correct horse', { step: ask })).rejects.toBe(spent);
        expect(shown).toHaveLength(1);
    });

    test('the phrase is signed in the worker from what the offer carries, and never sent', async () => {
        const { auth, sent, finished, crypto } = signIn([signedIn]);
        const { ask } = screen([{ kind: 'phrase', phrase: PHRASE }]);
        await auth.login(user.email, 'correct horse', { step: ask });
        expect(crypto.did('twoStepPhrase')).toEqual([
            {
                operation: 'twoStepPhrase',
                input: {
                    phrase: PHRASE,
                    userId: user.id,
                    stepToken: 'step-1',
                    wrappingSalt: 'salt',
                },
            },
        ]);
        expect(JSON.stringify([sent, finished])).not.toContain('winner');
    });

    test('a phrase the worker cannot read is asked again and keeps the sign-in', async () => {
        const { auth, sent, finished, crypto } = signIn([signedIn], challenge('step-1'), {
            // The worker's refusal (RefusedError) reaches the client as an error marked `kept`.
            twoStepPhrase: (input) => {
                if ((input as { phrase: string }).phrase !== PHRASE)
                    throw Object.assign(new Error(notAPhrase), { kept: true });
                return { signature: 'signed' };
            },
        });
        const { ask, shown } = screen([
            { kind: 'phrase', phrase: 'legal winner' },
            { kind: 'phrase', phrase: PHRASE },
        ]);
        await auth.login(user.email, 'correct horse', { step: ask });
        expect(shown[1]?.error).toBe(notAPhrase);
        // One password exchange, and the key it opened was never dropped.
        expect(finished).toHaveLength(1);
        expect(crypto.locks()).toBe(0);
        expect(sent).toEqual([{ token: 'step-1', proof: { kind: 'phrase', signature: 'signed' } }]);
    });

    test('a step this version cannot answer is told to update, not shown an empty screen', async () => {
        const { auth, sent } = signIn([signedIn], challenge('step-1', { methods: ['webauthn'] }));
        const { ask, shown } = screen([]);
        const error = await auth
            .login(user.email, 'correct horse', { step: ask })
            .catch((caught: unknown) => caught as Error & { code?: string });
        expect(error).toMatchObject({ code: 'update-required' });
        expect(shown).toEqual([]);
        expect(sent).toEqual([]);
    });
});

describe('a change the second step guards', () => {
    /*
     * An account's settings: `on` decides whether the server issues step tokens, and each
     * removal is answered with the next of `replies`.
     */
    function account(on: boolean, replies: (Error | { on: boolean })[] = [{ on: false }]) {
        const removals: { id: string; proof: Record<string, unknown> }[] = [];
        let challenges = 0;
        let reauths = 0;
        const expiry: number[] = [];
        const api = {
            twoStepChallenge: async (purpose: string): Promise<StepOffer> => {
                if (!on) return { on: false };
                challenges++;
                return {
                    on: true,
                    ...challenge(`${purpose}-${challenges}`, { expiresIn: expiry.shift() ?? 300 }),
                };
            },
            twoStepReauth: async (input: { startLoginRequest: string }) => ({
                attemptToken: `attempt-${++reauths}:${input.startLoginRequest}`,
                loginResponse: 'r',
                profileVersion: 1,
            }),
            removeTwoStepMethod: async (id: string, proof: Record<string, unknown>) => {
                removals.push({ id, proof });
                const reply = replies.shift();
                if (!reply) throw new Error('The server was asked more often than expected.');
                if (reply instanceof Error) throw reply;
                return reply;
            },
        } as unknown as AuthApi;
        return { api, removals, reauths: () => reauths, challenges: () => challenges, expiry };
    }
    const attempt = (n: number) => `attempt-${n}:start:correct horse`;

    test('an account without the step changes on its password alone, and is never asked', async () => {
        const { api, removals } = account(false);
        const auth = createAuthClient(() => worker().transport, keys, api);
        const { ask, shown } = screen([]);
        await expect(
            auth.removeTwoStepMethod('method', 'correct horse', { step: ask }),
        ).resolves.toEqual({ on: false });
        expect(shown).toEqual([]);
        expect(removals).toEqual([
            { id: 'method', proof: { attemptToken: attempt(1), finishLoginRequest: 'finish' } },
        ]);
    });

    test('carries the step on the token issued for it, with a password proof made once the answer is in', async () => {
        const { api, removals, reauths } = account(true, [{ on: false }]);
        const auth = createAuthClient(() => worker().transport, keys, api);
        let proofsWhenAsked = -1;
        const ask: AskStep = async () => {
            proofsWhenAsked = reauths();
            return { kind: 'totp', code: '123456' };
        };
        await auth.removeTwoStepMethod('method', 'correct horse', { step: ask });
        // Nothing of the password was sent before the person answered.
        expect(proofsWhenAsked).toBe(0);
        expect(removals).toEqual([
            {
                id: 'method',
                proof: {
                    attemptToken: attempt(1),
                    finishLoginRequest: 'finish',
                    twoStep: { token: 'two-step-1', proof: { kind: 'totp', code: '123456' } },
                },
            },
        ]);
    });

    test('backing out changes nothing, and leaves no password proof begun', async () => {
        const { api, removals, reauths } = account(true);
        const auth = createAuthClient(() => worker().transport, keys, api);
        const { ask } = screen([null]);
        await expect(
            auth.removeTwoStepMethod('method', 'correct horse', { step: ask }),
        ).rejects.toBeInstanceOf(StepCancelled);
        expect(removals).toEqual([]);
        // An unfinished proof counts toward the "kept trying to confirm your password" notice.
        expect(reauths()).toBe(0);
    });

    test('an answer the server did not read as a code keeps the password proof', async () => {
        const slip = refused(
            'Enter the six digits your authenticator app shows.',
            400,
            'not-a-code',
        );
        const { api, removals, reauths } = account(true, [slip, { on: false }]);
        const auth = createAuthClient(() => worker().transport, keys, api);
        const { ask, shown } = screen([
            { kind: 'totp', code: '111111' },
            { kind: 'totp', code: '222222' },
        ]);
        await auth.removeTwoStepMethod('method', 'correct horse', { step: ask });
        expect(shown[1]?.error).toBe(slip.message);
        // One password exchange: the proof the first request carried goes with the second.
        expect(reauths()).toBe(1);
        expect(removals.map((entry) => entry.proof.attemptToken)).toEqual([attempt(1), attempt(1)]);
    });

    test('a refusal that is not about the answer ends the change, and is not asked about again', async () => {
        // The same status as a slip, without its code: the server's words for a change that failed.
        const failed = refused(
            'Could not delete your account. Check your password and try again.',
            400,
        );
        const { api, removals, reauths } = account(true, [failed]);
        const auth = createAuthClient(() => worker().transport, keys, api);
        const { ask, shown } = screen([{ kind: 'totp', code: '111111' }]);
        await expect(
            auth.removeTwoStepMethod('method', 'correct horse', { step: ask }),
        ).rejects.toBe(failed);
        expect(shown).toHaveLength(1);
        expect(removals).toHaveLength(1);
        expect(reauths()).toBe(1);
    });

    test('a wrong answer spends the password proof: the next goes with a new one, on the same token', async () => {
        const wrong = refused(WRONG, 403, 'two-step');
        const { api, removals, reauths } = account(true, [wrong, { on: true }]);
        const auth = createAuthClient(() => worker().transport, keys, api);
        const { ask, shown } = screen([
            { kind: 'totp', code: '111111' },
            { kind: 'totp', code: '222222' },
        ]);
        await expect(
            auth.removeTwoStepMethod('method', 'correct horse', { step: ask }),
        ).resolves.toEqual({ on: true });
        expect(shown[1]?.error).toBe(wrong.message);
        expect(reauths()).toBe(2);
        expect(removals.map((entry) => entry.proof.attemptToken)).toEqual([attempt(1), attempt(2)]);
        expect(removals.map((entry) => (entry.proof.twoStep as StepSubmission).token)).toEqual([
            'two-step-1',
            'two-step-1',
        ]);
    });

    test('a token that is gone is replaced, and the person is asked again with a notice', async () => {
        const gone = refused('Too many wrong answers. Try again.', 403, 'two-step-expired');
        const { api, removals, challenges } = account(true, [gone, { on: false }]);
        const auth = createAuthClient(() => worker().transport, keys, api);
        const { ask, shown } = screen([
            { kind: 'backup', code: '7KQ2M-9XD4P' },
            { kind: 'backup', code: '8KQ2M-9XD4P' },
        ]);
        await auth.removeTwoStepMethod('method', 'correct horse', { step: ask });
        expect(shown[1]).toMatchObject({ notice: gone.message });
        expect(challenges()).toBe(2);
        expect(removals.map((entry) => entry.proof.twoStep)).toEqual([
            { token: 'two-step-1', proof: { kind: 'backup', code: '7KQ2M9XD4P' } },
            { token: 'two-step-2', proof: { kind: 'backup', code: '8KQ2M9XD4P' } },
        ]);
    });

    test('a token about to end is replaced before the phrase signs it', async () => {
        const { api, removals, expiry } = account(true, [{ on: false }]);
        // The first token has five seconds left when it arrives.
        expiry.push(5);
        const auth = createAuthClient(() => worker().transport, keys, api);
        const { ask } = screen([{ kind: 'phrase', phrase: PHRASE }]);
        await auth.removeTwoStepMethod('method', 'correct horse', { step: ask });
        expect(removals[0]?.proof.twoStep).toEqual({
            token: 'two-step-2',
            proof: { kind: 'phrase', signature: 'signed:two-step-2' },
        });
    });

    test('a password proof the person took too long over is made again, its age counted from before it was made', async () => {
        vi.useFakeTimers({ now: Date.now() });
        try {
            const slip = refused(
                'Enter the six digits your authenticator app shows.',
                400,
                'not-a-code',
            );
            const { api, removals } = account(true, [slip, { on: false }]);
            const auth = createAuthClient(() => worker().transport, keys, api);
            let asks = 0;
            const ask: AskStep = async () => {
                // The second answer comes four minutes and fifty seconds after the first proof.
                if (++asks === 2) vi.advanceTimersByTime(290_000);
                return { kind: 'totp', code: asks === 1 ? '111111' : '222222' };
            };
            await auth.removeTwoStepMethod('method', 'correct horse', { step: ask });
            expect(removals.map((entry) => entry.proof.attemptToken)).toEqual([
                attempt(1),
                attempt(2),
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    test('without a screen to ask on, an account with the step is refused before its password is used', async () => {
        const { api, removals, reauths } = account(true);
        const auth = createAuthClient(() => worker().transport, keys, api);
        await expect(auth.removeTwoStepMethod('method', 'correct horse')).rejects.toMatchObject({
            code: 'two-step',
        });
        expect(reauths()).toBe(0);
        expect(removals).toEqual([]);
    });

    test('deleting the account says a wrong password before it asks for the step', async () => {
        const deletions: unknown[] = [];
        const api = {
            twoStepChallenge: async () => ({ on: true, ...challenge('delete-1') }),
            deleteStart: async () => ({ attemptToken: 'a', loginResponse: 'r', profileVersion: 1 }),
            deleteFinish: async (input: unknown) => void deletions.push(input),
        } as unknown as AuthApi;
        const wrong = new Error('Unable to sign in. Check your email and password.');
        const crypto = worker({
            loginFinish: () => {
                throw wrong;
            },
        });
        const auth = createAuthClient(() => crypto.transport, keys, api);
        const { ask, shown } = screen([]);
        await expect(auth.deleteAccount('wrong horse', { step: ask })).rejects.toBe(wrong);
        expect(shown).toEqual([]);
        expect(deletions).toEqual([]);
    });

    test('deleting the account sends the step with the deletion, and a wrong code does not delete', async () => {
        const wrong = refused(WRONG, 403, 'two-step');
        const deletions: Record<string, unknown>[] = [];
        let starts = 0;
        const api = {
            twoStepChallenge: async () => ({ on: true, ...challenge('delete-1') }),
            deleteStart: async () => ({
                attemptToken: `delete-attempt-${++starts}`,
                loginResponse: 'r',
                profileVersion: 1,
            }),
            deleteFinish: async (input: Record<string, unknown>) => {
                deletions.push(input);
                if (deletions.length === 1) throw wrong;
                return { success: true };
            },
        } as unknown as AuthApi;
        const auth = createAuthClient(() => worker().transport, keys, api);
        const { ask, shown } = screen([
            { kind: 'totp', code: '111111' },
            { kind: 'totp', code: '222222' },
        ]);
        await auth.deleteAccount('correct horse', { step: ask });
        expect(shown[1]?.error).toBe(wrong.message);
        expect(deletions).toEqual([
            {
                attemptToken: 'delete-attempt-1',
                finishLoginRequest: 'finish',
                twoStep: { token: 'delete-1', proof: { kind: 'totp', code: '111111' } },
            },
            {
                attemptToken: 'delete-attempt-2',
                finishLoginRequest: 'finish',
                twoStep: { token: 'delete-1', proof: { kind: 'totp', code: '222222' } },
            },
        ]);
    });
});

/*
 * A password change, a new recovery phrase and a rotation end every session, and the server
 * opens the one this device carries on in with the change. The client must not sign in
 * again: with a second step that sign-in can be one the person cannot answer (the phrase
 * just replaced, the last backup code just spent), and the account would be lost.
 */
describe('carrying on after a security change', () => {
    const changedEnvelope = { envelopeVersion: 1, keyVersion: 1, credentialVersion: 2 };
    function changing(options: { on: boolean; replies?: (Error | null)[] }) {
        const finishes: Record<string, unknown>[] = [];
        const signIns: unknown[] = [];
        let starts = 0;
        const replies = options.replies ?? [null];
        const api = {
            twoStepChallenge: async (): Promise<StepOffer> =>
                options.on ? { on: true, ...challenge('change-1') } : { on: false },
            securityStart: async ({ action }: { action: string }) => ({
                userId: user.id,
                action,
                attemptToken: `change-${++starts}`,
            }),
            securityFinish: async (input: Record<string, unknown>) => {
                finishes.push(input);
                const reply = replies.shift();
                if (reply) throw reply;
                return {
                    user: { id: user.id, name: 'Maya', email: user.email },
                    envelope: changedEnvelope,
                    device: { id: 'device', attached: true, registered: true },
                };
            },
            loginStart: async (input: unknown) => {
                signIns.push(input);
                return { attemptToken: 'attempt', loginResponse: 'r' };
            },
            loginFinish: async () => ({ twoStep: challenge('step-1') }),
            session: async () => ({ user: null, device: null }),
        } as unknown as AuthApi;
        const crypto = worker();
        const auth = createAuthClient(() => crypto.transport, keys, api);
        return { auth, crypto, finishes, signIns };
    }

    test.each(['recovery-key', 'master-key', 'password'] as const)(
        'a %s change answered with the recovery phrase leaves this device signed in and open, and signs in nowhere again',
        async (action) => {
            const { auth, crypto, finishes, signIns } = changing({ on: true });
            const { ask } = screen([{ kind: 'phrase', phrase: PHRASE }]);
            const result = await auth.changeSecurity(user, action, 'correct horse', 'new horse', {
                step: ask,
            });
            expect(result).toEqual({ signedIn: true, uncertain: false });
            expect(finishes).toHaveLength(1);
            expect(finishes[0]!.twoStep).toEqual({
                token: 'change-1',
                proof: { kind: 'phrase', signature: 'signed:change-1' },
            });
            // No second sign-in, so no second step to answer.
            expect(signIns).toEqual([]);
            expect(crypto.did('loginStart')).toEqual([]);
            // Opened from the envelope the server answered with, and saved for this device.
            expect(crypto.did('unlock')).toEqual([
                { operation: 'unlock', input: { userId: user.id, envelope: changedEnvelope } },
            ]);
            expect(auth.store.getState().unlockedUserId).toBe(user.id);
            expect(auth.store.getState().device).not.toBeNull();
        },
    );

    test('a wrong code is asked again, not read as a lost response, and one right code is enough', async () => {
        const wrong = refused(WRONG, 403, 'two-step');
        const { auth, finishes, signIns } = changing({ on: true, replies: [wrong, null] });
        const { ask, shown } = screen([
            { kind: 'totp', code: '111111' },
            { kind: 'totp', code: '222222' },
        ]);
        const result = await auth.changeSecurity(user, 'password', 'correct horse', 'new horse', {
            step: ask,
        });
        expect(shown[1]?.error).toBe(wrong.message);
        // Each try carries its own password proof, on the one step token.
        expect(finishes.map((entry) => [entry.attemptToken, entry.twoStep])).toEqual([
            ['change-1', { token: 'change-1', proof: { kind: 'totp', code: '111111' } }],
            ['change-2', { token: 'change-1', proof: { kind: 'totp', code: '222222' } }],
        ]);
        expect(shown).toHaveLength(2);
        expect(signIns).toEqual([]);
        expect(result).toEqual({ signedIn: true, uncertain: false });
    });

    test('an account without the step carries on the same way', async () => {
        const { auth, signIns, finishes } = changing({ on: false });
        expect(await auth.changeSecurity(user, 'password', 'correct horse', 'new horse')).toEqual({
            signedIn: true,
            uncertain: false,
        });
        expect(finishes[0]!.twoStep).toBeUndefined();
        expect(signIns).toEqual([]);
        expect(auth.store.getState().unlockedUserId).toBe(user.id);
    });

    test('a reply that never arrived leaves the outcome open: locked, the saved unlock gone, and said so', async () => {
        const lost = new Error('Failed to fetch');
        const { auth } = changing({ on: false, replies: [lost] });
        expect(await auth.changeSecurity(user, 'password', 'correct horse', 'new horse')).toEqual({
            signedIn: false,
            uncertain: true,
        });
        expect(auth.store.getState().unlockedUserId).toBeNull();
        expect(auth.store.getState().device).toBeNull();
    });
});

/*
 * The reply to a new phrase or a rotation that never arrived (docs/two-step-design.md 4,
 * "When the reply is lost"). The server may have made the change, and then the second step
 * of the next sign-in can ask for a phrase only this device ever held. So the client reads
 * it out of what it sent, before it locks, and hands it back to be shown.
 */
describe('a new recovery phrase whose reply never arrived', () => {
    const NEW_PHRASE =
        'zebra obtain quantum velvet zebra obtain quantum velvet zebra obtain quantum velvet zebra obtain quantum velvet zebra obtain quantum velvet zebra obtain quantum velvet';
    const sentEnvelope = { envelopeVersion: 1, keyVersion: 2, credentialVersion: 2, sent: true };
    const sentRecovery = { envelopeVersion: 1, recoveryVersion: 4, keyVersion: 2 };
    const lost = () => new Error('Failed to fetch');
    /* The worker's update, as `securityFinish` makes it: a password change carries no phrase. */
    const update = (input: unknown) => ({
        finishLoginRequest: 'finish',
        registrationRecord: 'record',
        envelope: sentEnvelope,
        ...((input as { action: string }).action === 'password' ? {} : { recovery: sentRecovery }),
    });
    const answers = (extra: Record<string, (input: unknown) => unknown> = {}) => ({
        securityFinish: update,
        backup: () => ({ phrase: NEW_PHRASE }),
        ...extra,
    });
    function changing(options: {
        on?: boolean;
        /* What the server answers the change with: no answer at all, unless given. */
        reply?: Error;
        /* Replaces the worker's replies, as `worker` takes them. */
        answers?: Record<string, (input: unknown) => unknown>;
        /* What the session says once the change is over: signed out, unless given. */
        session?: () => Promise<{ user: SessionUser | null; device: null }>;
        /* Runs while the server holds the change, before the reply is lost. */
        during?: () => void;
        keys?: DeviceKeyStore;
    }) {
        const api = {
            twoStepChallenge: async (): Promise<StepOffer> =>
                options.on ? { on: true, ...challenge('change-1') } : { on: false },
            // The server hands back the action it was asked for, as the client checks.
            securityStart: async ({ action }: { action: string }) => ({
                userId: user.id,
                action,
                attemptToken: 'change-1',
            }),
            securityFinish: async () => {
                options.during?.();
                throw options.reply ?? lost();
            },
            session: options.session ?? (async () => ({ user: null, device: null })),
        } as unknown as AuthApi;
        const crypto = worker(options.answers ?? answers());
        const auth = createAuthClient(() => crypto.transport, options.keys ?? keys, api);
        return { auth, crypto };
    }
    const change = (
        auth: ReturnType<typeof changing>['auth'],
        action: 'recovery-key' | 'master-key' | 'password',
        ask?: AskStep,
    ) =>
        auth.changeSecurity(
            user,
            action,
            'correct horse',
            action === 'password' ? 'new horse' : '',
            ask ? { step: ask } : {},
        );

    test.each(['recovery-key', 'master-key'] as const)(
        'a %s change hands back the phrase it made, read from what was sent, and only then locks',
        async (action) => {
            const { auth, crypto } = changing({ on: true });
            const { ask } = screen([{ kind: 'phrase', phrase: PHRASE }]);
            expect(await change(auth, action, ask)).toStrictEqual({
                signedIn: false,
                uncertain: true,
                kit: { phrase: NEW_PHRASE, recovery: sentRecovery },
            });
            // Opened from the envelope this device sent (the server answered with none), and
            // the phrase read from the recovery envelope sent beside it.
            expect(crypto.did('unlock')).toEqual([
                { operation: 'unlock', input: { userId: user.id, envelope: sentEnvelope } },
            ]);
            expect(crypto.did('backup')).toEqual([
                { operation: 'backup', input: { userId: user.id, recovery: sentRecovery } },
            ]);
            // Read while the worker still held the new password's key, and locked straight
            // after: the account is not left open on a device that is signed out.
            const read = crypto.order.lastIndexOf('backup');
            expect(crypto.order.slice(crypto.order.lastIndexOf('securityFinish'), read)).toEqual([
                'securityFinish',
                'twoStepPhrase',
                'unlock',
            ]);
            expect(crypto.order.slice(read + 1)).toEqual(['lock']);
            expect(auth.store.getState().unlockedUserId).toBeNull();
            expect(auth.store.getState().device).toBeNull();
        },
    );

    test('a password change makes no phrase: nothing is opened, and it ends as it did before', async () => {
        const { auth, crypto } = changing({});
        expect(await change(auth, 'password')).toStrictEqual({ signedIn: false, uncertain: true });
        expect(crypto.did('unlock')).toEqual([]);
        expect(crypto.did('backup')).toEqual([]);
        expect(auth.store.getState().unlockedUserId).toBeNull();
    });

    test('a server still at work when the wait ran out: the session says nothing changed yet, and the phrase is shown all the same', async () => {
        // The change lands after this device stopped waiting. Told "it failed" and nothing
        // else, the person would meet a second step asking for a phrase they never saw.
        const { auth } = changing({ session: async () => ({ user, device: null }) });
        expect(await change(auth, 'master-key')).toStrictEqual({
            signedIn: false,
            uncertain: true,
            kit: { phrase: NEW_PHRASE, recovery: sentRecovery },
        });
        // A password change in the same spot is still the failure it was: nothing to save.
        const password = changing({ session: async () => ({ user, device: null }) });
        await expect(change(password.auth, 'password')).rejects.toThrow('Failed to fetch');
    });

    test.each([
        ['the per-address limit', refused('Too many attempts. Try again later.', 429)],
        [
            'a change the server cannot check',
            refused('Try again later.', 503, 'two-step-unavailable'),
        ],
    ])(
        'a refusal is not a lost reply (%s): the old phrase stands, and no new one is shown',
        async (_name, reply) => {
            const { auth, crypto } = changing({
                reply,
                session: async () => ({ user, device: null }),
            });
            await expect(change(auth, 'recovery-key')).rejects.toBe(reply);
            expect(crypto.did('unlock')).toEqual([]);
            expect(crypto.did('backup')).toEqual([]);
        },
    );

    test.each([
        [
            'the worker refuses to open (it dropped the key)',
            () =>
                answers({
                    unlock: () =>
                        Promise.reject(new Error('Sign in again to unlock your account.')),
                }),
        ],
        [
            'the worker cannot read the phrase',
            () =>
                answers({
                    backup: () =>
                        Promise.reject(new Error('Unlock your account to view your recovery key.')),
                }),
        ],
    ])('falls back to the sign-in page when %s', async (_name, replies) => {
        const { auth, crypto } = changing({ answers: replies() });
        expect(await change(auth, 'recovery-key')).toStrictEqual({
            signedIn: false,
            uncertain: true,
        });
        expect(crypto.order.at(-1)).toBe('lock');
        expect(auth.store.getState().unlockedUserId).toBeNull();
    });

    test('a lock while the server held the change: the key is gone, so a new worker is not asked for it', async () => {
        const run = changing({ during: () => run.auth.resync() });
        expect(await change(run.auth, 'recovery-key')).toStrictEqual({
            signedIn: false,
            uncertain: true,
        });
        expect(run.crypto.did('unlock')).toEqual([]);
        expect(run.crypto.did('backup')).toEqual([]);
    });

    test('a lock while the worker reads the phrase drops it', async () => {
        const run = changing({
            answers: answers({
                backup: () => {
                    run.auth.resync();
                    return { phrase: NEW_PHRASE };
                },
            }),
        });
        expect(await change(run.auth, 'recovery-key')).toStrictEqual({
            signedIn: false,
            uncertain: true,
        });
    });

    test('the phrase goes nowhere but back to the caller: not into a log, storage or an error', async () => {
        const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
            vi.spyOn(console, level).mockImplementation(() => {}),
        );
        const said = () =>
            JSON.stringify(spies.flatMap((spy) => spy.mock.calls.flat().map(String)));
        const leaks = (text: string) => text.includes('zebra') || text.includes('velvet');
        try {
            // Everything after the read fails: the device store, and the session check.
            const failing = changing({
                keys: { ...keys, clear: async () => Promise.reject(new Error('store')) },
                session: async () => Promise.reject(new Error('offline')),
            });
            const result = await change(failing.auth, 'master-key');
            expect(result).toMatchObject({ kit: { phrase: NEW_PHRASE } });
            expect(leaks(said())).toBe(false);
            expect(leaks(JSON.stringify([...items]))).toBe(false);
            expect(leaks(JSON.stringify(failing.auth.store.getState()))).toBe(false);
            // Read, then locked out from under it, with the old session still live: the
            // change ends as the failure it was, and the error carries none of the words.
            const locked = changing({
                session: async () => ({ user, device: null }),
                answers: answers({
                    backup: () => {
                        locked.auth.resync();
                        return { phrase: NEW_PHRASE };
                    },
                }),
            });
            const error = await change(locked.auth, 'master-key').then(
                () => null,
                (cause: Error) => cause,
            );
            expect(error?.message).toBe('Failed to fetch');
            expect(leaks(`${error?.message} ${error?.stack} ${JSON.stringify(error)}`)).toBe(false);
            expect(leaks(said())).toBe(false);
        } finally {
            for (const spy of spies) spy.mockRestore();
        }
    });
});
