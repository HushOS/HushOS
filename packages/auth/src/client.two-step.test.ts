import { beforeEach, describe, expect, test } from 'vitest';
import type { AuthApi, StepChallenge, StepSubmission } from './api';
import type { AskStep, StepAnswer, StepRequest } from './client';
import type { CryptoTransport } from './crypto-transport';
import type { DeviceKeyStore } from './device-storage';
import type { SessionUser } from './protocol';

/*
 * The second step in the auth client (docs/two-step-design.md 4 and 10, "Codes a client acts
 * on"): what a sign-in and a guarded change send, and what each of the server's answers does
 * next. The server and the worker are stand-ins that record what they were handed, so each
 * test fails on what a person would meet: a sign-in that opens without the step, a password
 * asked for twice, a phrase that leaves the device, a wrong code that ends a change.
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
const signedIn = { user, envelope, device: { id: 'device', attached: false, registered: true } };
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const notAPhrase = 'That is not a valid recovery phrase. Check each word and try again.';
const soon = () => new Date(Date.now() + 5 * 60_000).toISOString();
const challenge = (token: string, extra: Partial<StepChallenge> = {}): StepChallenge => ({
    token,
    methods: ['totp', 'backup', 'phrase'],
    expiresAt: soon(),
    phrase: { userId: user.id, recoveryVersion: 3, wrappingSalt: 'salt' },
    ...extra,
});
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
    let locks = 0;
    const transport: CryptoTransport = {
        request: async (operation, input) => {
            asked.push({ operation, input });
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
            return {} as never;
        },
        lock: () => void locks++,
        onLock() {},
    };
    const did = (operation: string) => asked.filter((entry) => entry.operation === operation);
    return { transport, asked, did, locks: () => locks };
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
        replies: (Error | typeof signedIn)[],
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
        const offer = challenge('step-1');
        const { auth, finished, sent, crypto } = signIn([signedIn], offer);
        const { ask, shown } = screen([{ kind: 'totp', code: '123 456' }]);
        const result = await auth.login(user.email, 'correct horse', { step: ask });
        expect(result).toEqual(user);
        expect(finished).toEqual([expect.objectContaining({ twoStep: 1 })]);
        expect(shown).toEqual([
            { methods: ['totp', 'backup', 'phrase'], expiresAt: offer.expiresAt },
        ]);
        // The code as the server reads it, on the token it issued.
        expect(sent).toEqual([{ token: 'step-1', proof: { kind: 'totp', code: '123456' } }]);
        // Nothing was unlocked before the step: the one unlock carries the step reply's envelope.
        expect(crypto.did('unlock')).toEqual([
            { operation: 'unlock', input: { userId: user.id, envelope } },
        ]);
        expect(auth.store.getState().unlockedUserId).toBe(user.id);
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
        const wrong = 'That code didn’t work. Codes change every 30 seconds.';
        const { auth, sent, crypto } = signIn([refused(wrong, 401, 'two-step'), signedIn]);
        const { ask, shown } = screen([
            { kind: 'totp', code: '111111' },
            { kind: 'totp', code: '222222' },
        ]);
        await auth.login(user.email, 'correct horse', { step: ask });
        expect(shown[1]?.error).toBe(wrong);
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

    test('paused codes and a spent budget take those methods off the screen; the phrase stays', async () => {
        const frozen = 'Authenticator codes are paused here after too many wrong ones.';
        const spent = 'Too many wrong codes. Try again in 15 minutes, or use your recovery phrase.';
        const { auth, sent } = signIn([
            refused(frozen, 403, 'totp-frozen'),
            refused(spent, 429),
            signedIn,
        ]);
        const { ask, shown } = screen([
            { kind: 'totp', code: '111111' },
            { kind: 'backup', code: '7KQ2M9XD4P' },
            { kind: 'phrase', phrase: PHRASE },
        ]);
        await auth.login(user.email, 'correct horse', { step: ask });
        expect(shown.map((request) => [request.methods, request.error])).toEqual([
            [['totp', 'backup', 'phrase'], undefined],
            [['backup', 'phrase'], frozen],
            [['phrase'], spent],
        ]);
        expect(sent.at(-1)).toEqual({
            token: 'step-1',
            proof: { kind: 'phrase', signature: 'signed:step-1' },
        });
    });

    test('with no method left the refusal ends the sign-in', async () => {
        const spent = refused('Too many wrong codes. Try again in 15 minutes.', 429);
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
        expect(error).toMatchObject({
            code: 'update-required',
            message: 'Update HushOS to sign in. This account asks for a second step.',
        });
        expect(shown).toEqual([]);
        expect(sent).toEqual([]);
    });

    test('a change of password ends signed out at the sign-in page, where the step is asked', async () => {
        const api = {
            twoStepChallenge: async () => {
                throw refused('Two-step sign-in is not on for this account.', 409);
            },
            securityStart: async () => ({ userId: user.id, action: 'password', attemptToken: 'a' }),
            securityFinish: async () => ({ success: true }),
            loginStart: async () => ({ attemptToken: 'attempt', loginResponse: 'r' }),
            loginFinish: async () => ({ twoStep: challenge('step-1') }),
            loginTwoStep: async () => {
                throw new Error('The sign-in after a change never answers a step by itself.');
            },
        } as unknown as AuthApi;
        const auth = createAuthClient(() => worker().transport, keys, api);
        await expect(
            auth.changeSecurity(user, 'password', 'correct horse', 'new horse'),
        ).resolves.toEqual({ signedIn: false, uncertain: false, storage: null });
        expect(auth.store.getState().unlockedUserId).toBeNull();
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
        const expiry: string[] = [];
        const api = {
            twoStepChallenge: async (purpose: string) => {
                if (!on) throw refused('Two-step sign-in is not on for this account.', 409);
                challenges++;
                return challenge(`${purpose}-${challenges}`, {
                    expiresAt: expiry.shift() ?? soon(),
                });
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

    test('a wrong password is said before the step is asked for', async () => {
        const { api, removals } = account(true);
        const wrong = Object.assign(new Error('That password isn’t right.'), { kept: true });
        const crypto = worker({
            reauthFinish: () => {
                throw wrong;
            },
        });
        const auth = createAuthClient(() => crypto.transport, keys, api);
        const { ask, shown } = screen([]);
        await expect(auth.removeTwoStepMethod('method', 'wrong horse', { step: ask })).rejects.toBe(
            wrong,
        );
        expect(shown).toEqual([]);
        expect(removals).toEqual([]);
        // The password does not stay in the worker after a refused exchange.
        expect(crypto.did('reauthCancel')).toHaveLength(1);
    });

    test('carries the step on the token issued for it, with the password proof', async () => {
        const { api, removals } = account(true, [{ on: false }]);
        const auth = createAuthClient(() => worker().transport, keys, api);
        const { ask } = screen([{ kind: 'totp', code: '123456' }]);
        await auth.removeTwoStepMethod('method', 'correct horse', { step: ask });
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

    test('an answer the server did not read as a code keeps the password proof', async () => {
        const slip = refused('Enter the six digits your authenticator app shows.', 400);
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
        // The same status as a slip, but the server's words for a change that failed.
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
        const wrong = refused(
            'That code didn’t work. Codes change every 30 seconds.',
            403,
            'two-step',
        );
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

    test('a token that is gone is replaced, and the person is asked again', async () => {
        const gone = refused('Too many wrong answers. Try again.', 403, 'two-step-expired');
        const { api, removals, challenges } = account(true, [gone, { on: false }]);
        const auth = createAuthClient(() => worker().transport, keys, api);
        const { ask, shown } = screen([
            { kind: 'backup', code: '7KQ2M-9XD4P' },
            { kind: 'backup', code: '8KQ2M-9XD4P' },
        ]);
        await auth.removeTwoStepMethod('method', 'correct horse', { step: ask });
        expect(shown[1]?.error).toBe(gone.message);
        expect(challenges()).toBe(2);
        expect(removals.map((entry) => entry.proof.twoStep)).toEqual([
            { token: 'two-step-1', proof: { kind: 'backup', code: '7KQ2M9XD4P' } },
            { token: 'two-step-2', proof: { kind: 'backup', code: '8KQ2M9XD4P' } },
        ]);
    });

    test('a token about to end is replaced before the phrase signs it', async () => {
        const { api, removals, expiry } = account(true, [{ on: false }]);
        // The first token has five seconds left by the time the person answers. As a Date: the
        // web's API client parses timestamps, whatever the contract's type says.
        expiry.push(new Date(Date.now() + 5_000) as unknown as string);
        const crypto = worker();
        const auth = createAuthClient(() => crypto.transport, keys, api);
        const { ask } = screen([{ kind: 'phrase', phrase: PHRASE }]);
        await auth.removeTwoStepMethod('method', 'correct horse', { step: ask });
        expect(removals[0]?.proof.twoStep).toEqual({
            token: 'two-step-2',
            proof: { kind: 'phrase', signature: 'signed:two-step-2' },
        });
    });

    test('backing out changes nothing', async () => {
        const { api, removals } = account(true);
        const auth = createAuthClient(() => worker().transport, keys, api);
        const { ask } = screen([null]);
        await expect(
            auth.removeTwoStepMethod('method', 'correct horse', { step: ask }),
        ).rejects.toBeInstanceOf(StepCancelled);
        expect(removals).toEqual([]);
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

    test('deleting the account sends the step with the deletion, and a wrong code does not delete', async () => {
        const wrong = refused(
            'That code didn’t work. Codes change every 30 seconds.',
            403,
            'two-step',
        );
        const deletions: Record<string, unknown>[] = [];
        let starts = 0;
        const api = {
            twoStepChallenge: async () => challenge('delete-1'),
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

    test('a password change with the step is refused on a wrong code and goes through on the next', async () => {
        const wrong = refused(
            'That code didn’t work. Codes change every 30 seconds.',
            403,
            'two-step',
        );
        const finishes: Record<string, unknown>[] = [];
        let starts = 0;
        const api = {
            twoStepChallenge: async () => challenge('password-1'),
            securityStart: async () => ({
                userId: user.id,
                action: 'password',
                attemptToken: `change-${++starts}`,
            }),
            securityFinish: async (input: Record<string, unknown>) => {
                finishes.push(input);
                if (finishes.length === 1) throw wrong;
                return { success: true };
            },
            loginStart: async () => ({ attemptToken: 'attempt', loginResponse: 'r' }),
            loginFinish: async () => ({ twoStep: challenge('step-1') }),
        } as unknown as AuthApi;
        const auth = createAuthClient(() => worker().transport, keys, api);
        const { ask, shown } = screen([
            { kind: 'totp', code: '111111' },
            { kind: 'totp', code: '222222' },
        ]);
        const result = await auth.changeSecurity(user, 'password', 'correct horse', 'new horse', {
            step: ask,
        });
        // The wrong code was not read as a lost response: the person was asked again.
        expect(shown[1]?.error).toBe(wrong.message);
        expect(finishes.map((entry) => [entry.attemptToken, entry.twoStep])).toEqual([
            ['change-1', { token: 'password-1', proof: { kind: 'totp', code: '111111' } }],
            ['change-2', { token: 'password-1', proof: { kind: 'totp', code: '222222' } }],
        ]);
        expect(result).toEqual({ signedIn: false, uncertain: false, storage: null });
    });
});
