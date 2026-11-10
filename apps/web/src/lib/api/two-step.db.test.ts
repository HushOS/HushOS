import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { OPAQUE_IDENTIFIERS } from '@hushos/crypto';
import { client } from '@hushos/crypto/server';
import { signTwoStepPhrase } from '@hushos/crypto/two-step';
import { totpCode, totpStep } from '@hushos/crypto/two-step/server';
import {
    captureMail,
    startApi,
    steadyClock,
    type Account,
    type Harness,
    type Reply,
} from '@/test/two-step-api.server';

/*
 * Two-step sign-in through the real routes (docs/two-step-design.md 10, "Tests
 * that must exist"), with TWO_STEP_ENABLED on: the real OPAQUE exchange, the
 * API's HTTP edge, and Postgres. What is checked is what a person or an attacker
 * would notice: a correct password that opens nothing before the step, codes
 * and tokens that work once and die where the design says, the step at every
 * change it guards, who is exempt, and what the account is told. The flag off
 * is two-step.off.db.test.ts.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let api: Harness;

beforeAll(async () => {
    api = await startApi({ TWO_STEP_ENABLED: 'true' });
});
beforeEach(async () => {
    steadyClock();
    await api.resetDatabase();
    captureMail();
});
afterAll(async () => {
    vi.useRealTimers();
    await api.closeDatabase();
});

type App = Awaited<ReturnType<Harness['enrol']>>;

const b64 = (bytes: number) => randomBytes(bytes).toString('base64url');
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
/* A code the app has not used: the clock moves on one period first. */
const nextCode = (app: App) => {
    later(30_000);
    return app.code();
};
/* Six digits that are no code of this app in the window. */
async function wrongCode(app: Pick<App, 'code'>) {
    const good = await Promise.all([-1, 0, 1].map((offset) => app.code(offset)));
    for (let guess = 0; ; guess++) {
        const code = String(guess).padStart(6, '0');
        if (!good.includes(code)) return code;
    }
}

const sessionRows = () => api.rows.sessionRows();
const deviceRows = () => api.rows.deviceRows();
const attemptRows = () => api.rows.attemptRows();
const sessionOf = (cookie: string) => api.rows.sessionRow(api.sha256(cookie));
const subjects = async () => (await api.notices()).map((message) => message.subject);

/* The step asked for after a correct password: the token and what can answer it. */
async function asked(who: Account, options: Parameters<Harness['signIn']>[1] = {}) {
    const reply = await api.signIn(who, options);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.twoStep, JSON.stringify(reply.body)).toBeDefined();
    return reply.body.twoStep as {
        token: string;
        methods: string[];
        expiresAt: string;
        phrase: { userId: string; recoveryVersion: number; wrappingSalt: string };
    };
}
const answer = (token: string, proof: unknown, options: { address?: string } = {}) =>
    api.call('POST', '/login/two-step', { token, proof }, options);
const totp = (code: string) => ({ kind: 'totp' as const, code });
const backup = (code: string) => ({ kind: 'backup' as const, code });

/* A whole sign-in from a new device: the password, then a fresh authenticator code. */
async function signedIn(who: Account, app: App, options: Parameters<Harness['signIn']>[1] = {}) {
    const offer = await asked(who, options);
    const done = await answer(offer.token, totp(await nextCode(app)));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return { cookie: done.cookie as string, body: done.body };
}

/* An account with the step on, and its authenticator app. */
async function stepped() {
    const who = await api.account();
    const app = await api.enrol(who.id);
    return { who, app };
}

/* A step token for a change, asked from a session. */
async function challenge(cookie: string, purpose: string) {
    const reply = await api.call('POST', '/two-step/challenge', { purpose }, { cookie });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return reply.body as { token: string; phrase: { userId: string; wrappingSalt: string } };
}

/* The password proved again by a session, for a change to the step. */
async function reauth(who: Account, cookie: string) {
    const { attemptToken, finishLoginRequest } = await api.prove(who, '/two-step/reauth', {
        cookie,
    });
    return { attemptToken, finishLoginRequest };
}

/*
 * A password change made ready: the password proved once, and `send` to finish it with a
 * given answer to the step. Sending twice sends the same proof twice.
 */
async function passwordChange(
    who: Account,
    cookie: string,
    newPassword: string,
    action: 'password' | 'recovery-key' = 'password',
) {
    const registration = client.startRegistration({ password: newPassword });
    const proof = await api.prove(who, '/security/start', {
        cookie,
        extra: { action, registrationRequest: registration.registrationRequest },
    });
    const { registrationRecord } = client.finishRegistration({
        password: newPassword,
        registrationResponse: proof.challenge.registrationResponse,
        clientRegistrationState: registration.clientRegistrationState,
        identifiers: OPAQUE_IDENTIFIERS,
    });
    const current = proof.challenge.envelope;
    const rotated =
        action === 'recovery-key'
            ? await api.recoveryKey(who.id, proof.challenge.recovery.recoveryVersion + 1)
            : null;
    const body = {
        action,
        attemptToken: proof.attemptToken,
        finishLoginRequest: proof.finishLoginRequest,
        registrationRecord,
        envelope: {
            envelopeVersion: 1,
            keyVersion: current.keyVersion,
            credentialVersion: current.credentialVersion + 1,
            wrappingSalt: b64(32),
            wrappingNonce: b64(24),
            encryptedKey: b64(48),
        },
        ...(rotated ? { recovery: rotated.envelope } : {}),
    };
    const send = (twoStep?: unknown) =>
        api.call(
            'POST',
            '/security/finish',
            { ...body, ...(twoStep ? { twoStep } : {}) },
            {
                cookie,
            },
        );
    return { send, rotated };
}

/* A password change as a client sends it: the proof, a real new record, a re-wrapped envelope. */
async function changePassword(
    who: Account,
    cookie: string,
    newPassword: string,
    twoStep?: unknown,
    action: 'password' | 'recovery-key' = 'password',
) {
    const change = await passwordChange(who, cookie, newPassword, action);
    return { reply: await change.send(twoStep), rotated: change.rotated };
}

async function deleteAccount(who: Account, cookie: string, twoStep?: unknown) {
    const proof = await api.prove(who, '/delete/start', { cookie });
    return api.call(
        'POST',
        '/delete/finish',
        {
            attemptToken: proof.attemptToken,
            finishLoginRequest: proof.finishLoginRequest,
            ...(twoStep ? { twoStep } : {}),
        },
        { cookie },
    );
}

const refusedStep = (reply: Reply) => ({ status: reply.status, code: reply.body?.code });

describe('a correct password with the step on', () => {
    test('opens nothing: no envelope, no cookie, no session and no device, only a step token', async () => {
        const { who } = await stepped();
        const reply = await api.signIn(who);
        expect(reply.status).toBe(200);
        expect(Object.keys(reply.body)).toEqual(['twoStep']);
        expect(reply.body.twoStep).toEqual({
            token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
            methods: ['totp', 'backup', 'phrase'],
            expiresAt: new Date(Date.now() + 5 * MINUTE).toISOString(),
            // The same, counted from now: for a client whose clock is not this server's.
            expiresIn: 300,
            phrase: {
                userId: who.id,
                recoveryVersion: 1,
                wrappingSalt: who.recovery.wrappingSalt,
            },
        });
        expect(JSON.stringify(reply.body)).not.toMatch(/envelope|encryptedKey|"user"|"device"/);
        expect(reply.cookie).toBeNull();
        expect(await sessionRows()).toEqual([]);
        expect(await deviceRows()).toEqual([]);
        // The server keeps the token's hash, never the token.
        const [attempt] = await attemptRows();
        expect(attempt).toMatchObject({ userId: who.id, purpose: 'login', failures: 0 });
        expect(attempt!.tokenHash).toEqual(api.sha256(reply.body.twoStep.token));
    });

    test('tells a client that cannot answer a step to update, and makes nothing for it', async () => {
        const { who } = await stepped();
        const reply = await api.signIn(who, { old: true });
        expect(reply.status).toBe(409);
        expect(reply.body).toEqual({
            message: 'Update HushOS to sign in. This account asks for a second step.',
            code: 'update-required',
        });
        expect(reply.cookie).toBeNull();
        expect(await sessionRows()).toEqual([]);
        expect(await deviceRows()).toEqual([]);
        expect(await attemptRows()).toEqual([]);
    });

    test('a wrong password fails the same with the step on as with it off', async () => {
        const { who } = await stepped();
        const plain = await api.account();
        const wrong = async (account: Account) => {
            const start = client.startLogin({ password: 'not the password' });
            const challenge = await api.call('POST', '/login/start', {
                email: account.email,
                startLoginRequest: start.startLoginRequest,
            });
            // The client cannot finish a wrong password; whatever it sends instead is refused.
            return api.call('POST', '/login/finish', {
                attemptToken: challenge.body.attemptToken,
                finishLoginRequest: b64(64),
                twoStep: 1,
            });
        };
        const [withStep, without] = [await wrong(who), await wrong(plain)];
        expect(withStep).toEqual(without);
        expect(withStep.status).toBe(401);
        expect(await attemptRows()).toEqual([]);
    });

    test('an account without the step signs in as before, from a client old or new', async () => {
        const who = await api.account();
        for (const old of [true, false]) {
            const reply = await api.signIn(who, { old });
            expect(reply.status).toBe(200);
            expect(reply.body).toMatchObject({ user: { id: who.id }, envelope: {}, device: {} });
            expect(reply.cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
        }
        expect(await attemptRows()).toEqual([]);
    });

    test('the right code then opens the session, stepped now, and the token is spent', async () => {
        const { who, app } = await stepped();
        const offer = await asked(who);
        const code = await app.code();
        const done = await answer(offer.token, totp(code));
        expect(done.status).toBe(200);
        expect(done.body).toEqual({
            user: { id: who.id, name: 'Test Person', email: who.email, role: 'member' },
            envelope: expect.objectContaining({ envelopeVersion: 1, credentialVersion: 1 }),
            device: { id: expect.any(String), attached: false, registered: false },
            // Offered here, and no backup code was used: nothing to say of how many are left.
            twoStep: { offered: true },
        });
        const session = await sessionOf(done.cookie!);
        expect(session).toMatchObject({ userId: who.id, deviceId: done.body.device.id });
        expect(session!.twoStepAt!.getTime()).toBe(Date.now());
        expect(await attemptRows()).toEqual([]);
        // The token again, with any answer: gone.
        later(30_000);
        expect(refusedStep(await answer(offer.token, totp(await app.code())))).toEqual({
            status: 401,
            code: 'two-step-expired',
        });
        expect(await sessionRows()).toHaveLength(1);
    });
});

describe('an authenticator code', () => {
    test('is accepted once: the same code at the next sign-in reads as any wrong code', async () => {
        const { who, app } = await stepped();
        const code = await app.code();
        expect((await answer((await asked(who)).token, totp(code))).status).toBe(200);
        const replayed = await answer((await asked(who)).token, totp(code));
        const never = await answer((await asked(who)).token, totp(await wrongCode(app)));
        expect(replayed.status).toBe(401);
        expect(replayed.body).toEqual({
            message: 'That code didn’t work. Codes change every 30 seconds.',
            code: 'two-step',
        });
        // A used code and one that never was a code are the same answer.
        expect(replayed).toEqual(never);
        expect(await sessionRows()).toHaveLength(1);
    });

    test('is taken for the step before, the current one and the next, and not two away', async () => {
        const { who, app } = await stepped();
        for (const offset of [-2, 2])
            expect(
                refusedStep(await answer((await asked(who)).token, totp(await app.code(offset)))),
                `T${offset}`,
            ).toEqual({ status: 401, code: 'two-step' });
        for (const offset of [-1, 0, 1])
            expect(
                (await answer((await asked(who)).token, totp(await app.code(offset)))).status,
                `T${offset}`,
            ).toBe(200);
    });

    test('is read as an app shows it and a person types it: “123 456”, or with a hyphen', async () => {
        const { who, app } = await stepped();
        const spaced = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;
        expect(
            (await answer((await asked(who)).token, totp(spaced(await app.code())))).status,
        ).toBe(200);
        const next = await nextCode(app);
        expect(
            (await answer((await asked(who)).token, totp(` ${next.slice(0, 3)}-${next.slice(3)} `)))
                .status,
        ).toBe(200);
    });

    test('that is not six digits, or a backup code that is not one, is a 400 and counts nowhere', async () => {
        const { who, app } = await stepped();
        // One wrong code away from the freeze, so a single count would show.
        await api.rows.setSharedFailures(who.id, 99);
        const offer = await asked(who);
        const malformed = [
            totp('12345'),
            totp('1234567'),
            totp('12345a'),
            totp('abc def'),
            totp('12.34.56'),
            backup('7KQ2M-9XD4'),
            backup('7KQ2M-9XD4PP'),
            backup('7KQ2M-9XD4U'),
            backup('123456'),
        ];
        // More of them than a token, a budget or the notice would take.
        for (const proof of [...malformed, ...malformed]) {
            const reply = await answer(offer.token, proof);
            expect(reply.status, JSON.stringify(proof)).toBe(400);
            // Told apart from every other 400 by its code, never by its words.
            expect(reply.body.code).toBe('not-a-code');
        }
        expect((await answer(offer.token, totp('12345'))).body.message).toBe(
            'Enter the six digits your authenticator app shows.',
        );
        expect((await answer(offer.token, backup('nope'))).body.message).toBe(
            'Enter a backup code as it was shown: ten letters and numbers.',
        );
        // Not against the token, the freeze or the notice…
        expect((await attemptRows()).map((row) => row.failures)).toEqual([0]);
        expect(await api.rows.sharedFailures(who.id)).toBe(99);
        expect(await subjects()).toEqual([]);
        // …nor the budget: the same token still takes the right code.
        expect((await answer(offer.token, totp(await app.code()))).status).toBe(200);
    });

    test('of two sign-ins sending the same code at once, exactly one gets in', async () => {
        const { who, app } = await stepped();
        const [first, second] = [await asked(who), await asked(who)];
        const code = await app.code();
        const replies = await Promise.all([
            answer(first.token, totp(code)),
            answer(second.token, totp(code)),
        ]);
        expect(replies.map((reply) => reply.status).sort((a, b) => a - b)).toEqual([200, 401]);
        expect(await sessionRows()).toHaveLength(1);
        // The one that lost is a wrong answer on its own token: counted, token kept.
        expect((await attemptRows()).map((row) => row.failures)).toEqual([1]);
    });

    test('from another account’s app passes nothing here', async () => {
        const { who } = await stepped();
        const other = await stepped();
        const reply = await answer((await asked(who)).token, totp(await other.app.code()));
        expect(refusedStep(reply)).toEqual({ status: 401, code: 'two-step' });
    });
});

describe('a backup code', () => {
    test('passes once, however it is typed, and the account hears how many are left', async () => {
        const { who, app } = await stepped();
        const typed = app.backupCodes[0]!.toLowerCase().replace('-', ' ');
        const done = await answer((await asked(who)).token, backup(` ${typed} `));
        expect(done.status).toBe(200);
        expect(done.body.envelope).toBeDefined();
        // The reply carries the count, so a client can suggest a new set without asking again.
        expect(done.body.twoStep).toEqual({ offered: true, backupCodesLeft: 9 });
        const notices = await api.notices();
        const used = notices.find((message) =>
            message.subject.startsWith('A backup code was used'),
        );
        expect(used?.to).toBe(who.email);
        expect(used?.text).toMatch(/Codes left\s+9/);

        // The same code again, and a code that never was one: the same refusal.
        const again = await answer((await asked(who)).token, backup(app.backupCodes[0]!));
        const never = await answer((await asked(who)).token, backup('00000-00000'));
        expect(again.status).toBe(401);
        expect(again.body.code).toBe('two-step');
        expect(again).toEqual(never);
        expect((await api.twoStepRepository.getTwoStep(who.id)).backupCodes).toHaveLength(9);
    });

    test('of two sign-ins sending one code at once, exactly one gets in', async () => {
        const { who, app } = await stepped();
        const [first, second] = [await asked(who), await asked(who)];
        const replies = await Promise.all([
            answer(first.token, backup(app.backupCodes[3]!)),
            answer(second.token, backup(app.backupCodes[3]!)),
        ]);
        expect(replies.map((reply) => reply.status).sort((a, b) => a - b)).toEqual([200, 401]);
        expect((await api.twoStepRepository.getTwoStep(who.id)).backupCodes).toHaveLength(9);
    });

    test('of another account is refused here, and stays unspent there', async () => {
        const { who } = await stepped();
        const other = await stepped();
        const reply = await answer((await asked(who)).token, backup(other.app.backupCodes[0]!));
        expect(refusedStep(reply)).toEqual({ status: 401, code: 'two-step' });
        expect((await api.twoStepRepository.getTwoStep(other.who.id)).backupCodes).toHaveLength(10);
    });
});

describe('the recovery phrase', () => {
    test('passes the step at once, and the account is told it was used', async () => {
        const { who } = await stepped();
        const offer = await asked(who);
        const done = await answer(offer.token, await api.phraseProof(who, offer));
        expect(done.status).toBe(200);
        expect(done.body).toMatchObject({ user: { id: who.id }, envelope: {} });
        expect((await sessionOf(done.cookie!))?.twoStepAt).toBeInstanceOf(Date);
        expect(await subjects()).toContainEqual(
            expect.stringMatching(/^Your recovery phrase was used for the second step · /),
        );
    });

    test('signs in a device that kept nothing: the email, the password, the phrase, and what the replies gave', async () => {
        const { email, password, phrase } = (await stepped()).who;
        // From here on, nothing of the account but those three. The OPAQUE exchange first.
        const start = client.startLogin({ password });
        const challenge = await api.call('POST', '/login/start', {
            email,
            startLoginRequest: start.startLoginRequest,
        });
        // Nothing before the password is proved says who the account is.
        expect(Object.keys(challenge.body).sort()).toEqual([
            'attemptToken',
            'loginResponse',
            'profileVersion',
        ]);
        const finish = client.finishLogin({
            clientLoginState: start.clientLoginState,
            loginResponse: challenge.body.loginResponse,
            password,
            identifiers: OPAQUE_IDENTIFIERS,
        });
        const asked = await api.call('POST', '/login/finish', {
            attemptToken: challenge.body.attemptToken,
            finishLoginRequest: finish!.finishLoginRequest,
            twoStep: 1,
        });
        const offer = asked.body.twoStep;
        // The statement names the account, so the offer must: the device knows no id of its own.
        const signature = await signTwoStepPhrase(phrase, {
            userId: offer.phrase.userId,
            stepToken: offer.token,
            wrappingSalt: offer.phrase.wrappingSalt,
        });
        const done = await api.call('POST', '/login/two-step', {
            token: offer.token,
            proof: { kind: 'phrase', signature },
        });
        expect(done.status, JSON.stringify(done.body)).toBe(200);
        expect(done.body.envelope).toBeDefined();
        expect(done.body.user).toMatchObject({ id: offer.phrase.userId, email });
    });

    test('answers a change the same way, from what the challenge gave', async () => {
        const { who, app } = await stepped();
        const { cookie } = await signedIn(who, app);
        const offer = await challenge(cookie, 'two-step');
        expect(offer.phrase.userId).toBe(who.id);
        const signature = await signTwoStepPhrase(who.phrase, {
            userId: offer.phrase.userId,
            stepToken: offer.token,
            wrappingSalt: offer.phrase.wrappingSalt,
        });
        const made = await api.call(
            'POST',
            '/two-step/backup-codes',
            {
                ...(await reauth(who, cookie)),
                twoStep: { token: offer.token, proof: { kind: 'phrase', signature } },
            },
            { cookie },
        );
        expect(made.status).toBe(200);
    });

    test('signs one step token: its signature passes no other, and no second time', async () => {
        const { who } = await stepped();
        const [first, second] = [await asked(who), await asked(who)];
        const proof = await api.phraseProof(who, first);
        // Lifted to another sign-in's token.
        expect(refusedStep(await answer(second.token, proof))).toEqual({
            status: 401,
            code: 'two-step',
        });
        expect((await answer(first.token, proof)).status).toBe(200);
        // Replayed on its own token, which is spent.
        expect(refusedStep(await answer(first.token, proof))).toEqual({
            status: 401,
            code: 'two-step-expired',
        });
        expect(await sessionRows()).toHaveLength(1);
    });

    test('is refused when the signature is tampered with, another account’s, or made with another salt', async () => {
        const { who } = await stepped();
        const stranger = await api.account();
        const offer = await asked(who);
        const good = await api.phraseProof(who, offer);
        const flipped = Buffer.from(good.signature, 'base64url');
        flipped[10]! ^= 1;
        const wrong = [
            { kind: 'phrase', signature: flipped.toString('base64url') },
            // The stranger's phrase, signing this account's statement.
            await api.phraseProof({ id: who.id, phrase: stranger.phrase }, offer),
            // This account's phrase with a salt the step response never gave.
            await api.phraseProof(who, { ...offer, phrase: { wrappingSalt: b64(32) } }),
            // A statement for another account's id, signed with the right phrase.
            {
                kind: 'phrase',
                signature: await signTwoStepPhrase(who.phrase, {
                    userId: stranger.id,
                    stepToken: offer.token,
                    wrappingSalt: offer.phrase.wrappingSalt,
                }),
            },
        ];
        for (const proof of wrong.slice(0, 4))
            expect(refusedStep(await answer(offer.token, proof))).toEqual({
                status: 401,
                code: 'two-step',
            });
        expect(await sessionRows()).toEqual([]);
        // Four wrong answers on the token; the right one still passes.
        expect((await answer(offer.token, good)).status).toBe(200);
    });
});

describe('a step token', () => {
    test('takes four wrong answers and still passes; the fifth ends it', async () => {
        const { who, app } = await stepped();
        const bad = await wrongCode(app);
        const survivor = await asked(who);
        for (let wrong = 1; wrong <= 4; wrong++)
            expect(refusedStep(await answer(survivor.token, totp(bad)))).toEqual({
                status: 401,
                code: 'two-step',
            });
        expect((await answer(survivor.token, totp(await app.code()))).status).toBe(200);

        // A phrase's wrong answers count on the token too.
        const ended = await asked(who);
        const junk = { kind: 'phrase', signature: b64(64) };
        for (let wrong = 1; wrong <= 4; wrong++)
            expect(refusedStep(await answer(ended.token, junk)).code).toBe('two-step');
        const fifth = await answer(ended.token, junk);
        expect(fifth.status).toBe(401);
        expect(fifth.body).toEqual({
            message: 'Too many wrong answers. Sign in again.',
            code: 'two-step-expired',
        });
        expect(refusedStep(await answer(ended.token, await api.phraseProof(who, ended)))).toEqual({
            status: 401,
            code: 'two-step-expired',
        });
        expect(await sessionRows()).toHaveLength(1);
    });

    test('lasts five minutes and no longer', async () => {
        const { who, app } = await stepped();
        const inTime = await asked(who);
        const late = await asked(who);
        later(5 * MINUTE - 1_000);
        expect((await answer(inTime.token, totp(await app.code()))).status).toBe(200);
        later(2_000);
        expect(refusedStep(await answer(late.token, totp(await app.code(1))))).toEqual({
            status: 401,
            code: 'two-step-expired',
        });
        expect(await sessionRows()).toHaveLength(1);
    });

    test('is not a token for anything else: a sign-in’s authorises no change, a change’s opens no session', async () => {
        const { who, app } = await stepped();
        const { cookie } = await signedIn(who, app);
        const login = await asked(who);
        const change = await challenge(cookie, 'password');

        // A change's token at sign-in.
        expect(refusedStep(await answer(change.token, totp(await nextCode(app))))).toEqual({
            status: 401,
            code: 'two-step-expired',
        });
        // A sign-in's token on a password change.
        const withLogin = await changePassword(who, cookie, 'a new password', {
            token: login.token,
            proof: totp(await nextCode(app)),
        });
        expect(refusedStep(withLogin.reply)).toEqual({ status: 403, code: 'two-step-expired' });
        // A token for another purpose on the deletion.
        expect(
            refusedStep(
                await deleteAccount(who, cookie, {
                    token: change.token,
                    proof: totp(await nextCode(app)),
                }),
            ),
        ).toEqual({ status: 403, code: 'two-step-expired' });
        // Each is still good for what it was issued for.
        const left = (await attemptRows()).map((row) => `${row.purpose}: ${row.failures}`);
        expect(left.sort()).toEqual(['login: 0', 'password: 0']);
        expect((await answer(login.token, totp(await nextCode(app)))).status).toBe(200);
        expect(await api.authRepository.getUserById(who.id)).not.toBeNull();
    });

    test('is bound to the session that asked: another session of the account cannot spend it', async () => {
        const { who, app } = await stepped();
        const mine = await signedIn(who, app);
        const theirs = await signedIn(who, app);
        const token = await challenge(mine.cookie, 'two-step');
        const stolen = await api.call(
            'POST',
            '/two-step/backup-codes',
            {
                ...(await reauth(who, theirs.cookie)),
                twoStep: { token: token.token, proof: totp(await nextCode(app)) },
            },
            { cookie: theirs.cookie },
        );
        expect(refusedStep(stolen)).toEqual({ status: 403, code: 'two-step-expired' });
        expect((await api.twoStepRepository.getTwoStep(who.id)).backupCodes).toHaveLength(10);
        // The session it was issued to still can.
        const own = await api.call(
            'POST',
            '/two-step/backup-codes',
            {
                ...(await reauth(who, mine.cookie)),
                twoStep: { token: token.token, proof: totp(await nextCode(app)) },
            },
            { cookie: mine.cookie },
        );
        expect(own.status).toBe(200);
    });
});

describe('the budget for wrong codes', () => {
    /* `count` wrong codes from sign-ins that proved no device, five to a token, each from its own address. */
    async function wrongCodes(who: Account, app: App, count: number) {
        const bad = await wrongCode(app);
        let token = '';
        for (let index = 0; index < count; index++) {
            if (index % 5 === 0) token = (await asked(who)).token;
            expect(refusedStep(await answer(token, totp(bad))).status).toBe(401);
        }
    }

    test('nine wrong codes in 15 minutes leave room for the right one', async () => {
        const { who, app } = await stepped();
        await wrongCodes(who, app, 9);
        expect((await answer((await asked(who)).token, totp(await app.code()))).status).toBe(200);
    });

    test('after ten, the eleventh code is refused unchecked, across tokens and addresses, until the window ends', async () => {
        const { who, app } = await stepped();
        await wrongCodes(who, app, 10);
        const offer = await asked(who, { address: '198.51.100.77' });
        // The right code, from an address that never sent a wrong one.
        const refused = await answer(offer.token, totp(await app.code()), {
            address: '198.51.100.78',
        });
        expect(refused.status).toBe(429);
        // The step's own 429, by its code: the per-address limiter's has none.
        expect(refused.body.code).toBe('code-budget');
        // A backup code shares the budget.
        expect((await answer(offer.token, backup(app.backupCodes[0]!))).status).toBe(429);
        // Refused unchecked: nothing counted on the token, no code or step spent.
        expect((await attemptRows()).find((row) => row.failures === 0)).toBeDefined();
        expect((await api.twoStepRepository.getTwoStep(who.id)).backupCodes).toHaveLength(10);
        expect(await sessionRows()).toEqual([]);

        // One above: still refused. Then the window ends and the code passes.
        expect((await answer(offer.token, totp(await app.code()))).status).toBe(429);
        later(15 * MINUTE + 1_000);
        expect((await answer((await asked(who)).token, totp(await app.code()))).status).toBe(200);
    });

    test('thirty wrong codes sent at once get ten of them checked, and no more', async () => {
        const { who, app } = await stepped();
        const bad = await wrongCode(app);
        const tokens: string[] = [];
        for (let index = 0; index < 6; index++) tokens.push((await asked(who)).token);
        // Five on each of six tokens, all at the same moment: room for thirty, were it not
        // for the budget. An answer takes its place before it is checked, so ten get in.
        const replies = await Promise.all(
            tokens.flatMap((token) => Array.from({ length: 5 }, () => answer(token, totp(bad)))),
        );
        const statuses = replies.map((reply) => reply.status);
        expect(statuses.filter((status) => status === 401)).toHaveLength(10);
        expect(statuses.filter((status) => status === 429)).toHaveLength(20);
        // Ten were counted as wrong codes, in the pool and on the tokens together.
        expect(await api.rows.sharedFailures(who.id)).toBe(10);
        const counted = (await attemptRows()).reduce((sum, row) => sum + row.failures, 0);
        const ended = tokens.length - (await attemptRows()).length;
        expect(counted + ended * 5).toBe(10);
    });

    test('is for wrong codes only: a dozen right ones in a row all pass', async () => {
        const { who, app } = await stepped();
        for (let index = 0; index < 12; index++)
            expect(
                (await answer((await asked(who)).token, totp(await nextCode(app)))).status,
                `sign-in ${index + 1}`,
            ).toBe(200);
    });

    test('never refuses the recovery phrase, which cannot be guessed', async () => {
        const { who, app } = await stepped();
        await wrongCodes(who, app, 10);
        const offer = await asked(who);
        expect((await answer(offer.token, totp(await app.code()))).status).toBe(429);
        expect((await answer(offer.token, await api.phraseProof(who, offer))).status).toBe(200);
    });

    test('is a known device’s own: spent for new devices, a device that proves its key still signs in, and the other way round', async () => {
        const { who, app } = await stepped();
        const laptop = await knownDevice(who, app, 'laptop');
        await wrongCodes(who, app, 10);
        // New devices are out of budget; the laptop is not.
        expect((await answer((await asked(who)).token, totp(await nextCode(app)))).status).toBe(
            429,
        );
        const fromLaptop = await asked(who, { device: laptop });
        expect((await answer(fromLaptop.token, totp(await nextCode(app)))).status).toBe(200);

        // The laptop spends its own ten: its eleventh code is refused, a new device's is not.
        later(15 * MINUTE + 1_000);
        const bad = await wrongCode(app);
        for (let index = 0; index < 10; index++) {
            const offer = index % 5 === 0 ? await asked(who, { device: laptop }) : null;
            if (offer) laptopToken = offer.token;
            expect((await answer(laptopToken, totp(bad))).status).toBe(401);
        }
        const again = await asked(who, { device: laptop });
        expect((await answer(again.token, totp(await nextCode(app)))).status).toBe(429);
        expect((await answer((await asked(who)).token, totp(await nextCode(app)))).status).toBe(
            200,
        );
    });
    let laptopToken = '';

    test('a forged device proof, or another account’s device, buys no budget of its own', async () => {
        const { who, app } = await stepped();
        const laptop = await knownDevice(who, app, 'laptop');
        const stranger = await stepped();
        const theirs = await knownDevice(stranger.who, stranger.app, 'theirs');
        await wrongCodes(who, app, 10);
        const forged = { id: laptop.id, key: api.deviceKey('not the laptop’s key') };
        for (const device of [forged, { ...theirs, as: stranger.who.id }]) {
            const offer = await asked(who, { device });
            expect((await answer(offer.token, totp(await nextCode(app)))).status).toBe(429);
        }
    });
});

/*
 * A device the account has signed in on and that registered a key, whose session has since ended:
 * what a browser or a phone is when it comes back. Its proof at `login/finish` names its row.
 */
async function knownDevice(who: Account, app: App, label: string) {
    const key = api.deviceKey(`${who.id}:${label}`);
    const { cookie, body } = await signedIn(who, app);
    const registered = await api.call(
        'POST',
        '/devices',
        { kind: 'web', name: label, signingPublicKey: key.publicKey },
        { cookie },
    );
    expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    // The session ends (seven idle days, say); the device and its key stay.
    await api.rows.endSession(api.sha256(cookie));
    return { id: body.device.id as string, key };
}

describe('the hundredth wrong code in a row', () => {
    const setShared = (userId: string, count: number) => api.rows.setSharedFailures(userId, count);
    const setDevice = (deviceId: string, count: number) =>
        api.rows.setDeviceFailures(deviceId, count);
    const frozenNotices = async () =>
        (await subjects()).filter((subject) =>
            subject.startsWith('Authenticator codes are paused'),
        );

    test('from new devices freezes the app for new devices only, and not the ninety-ninth', async () => {
        const { who, app } = await stepped();
        const laptop = await knownDevice(who, app, 'laptop');
        const bad = await wrongCode(app);

        await setShared(who.id, 98);
        expect((await answer((await asked(who)).token, totp(bad))).status).toBe(401);
        // Ninety-nine: the right code still passes, and the count starts again.
        expect((await answer((await asked(who)).token, totp(await nextCode(app)))).status).toBe(
            200,
        );
        expect(await frozenNotices()).toEqual([]);

        await setShared(who.id, 99);
        expect((await answer((await asked(who)).token, totp(bad))).status).toBe(401);
        expect(await frozenNotices()).toEqual([
            expect.stringMatching(/^Authenticator codes are paused for new devices · /),
        ]);
        // Frozen: the right code and a wrong one are refused alike, unchecked.
        const offer = await asked(who);
        const right = await answer(offer.token, totp(await nextCode(app)));
        expect(right.status).toBe(403);
        expect(right.body.code).toBe('totp-frozen');
        expect(await answer(offer.token, totp(bad))).toEqual(right);
        expect(
            (await attemptRows()).find((row) => row.tokenHash.equals(api.sha256(offer.token)))!
                .failures,
        ).toBe(0);
        // One notice, however long it stays frozen.
        expect(await frozenNotices()).toHaveLength(1);

        // The known device still takes codes.
        const fromLaptop = await asked(who, { device: laptop });
        expect((await answer(fromLaptop.token, totp(await nextCode(app)))).status).toBe(200);
        expect((await answer(offer.token, totp(await nextCode(app)))).status).toBe(403);

        // A backup code is not frozen, and switches codes back on for new devices.
        expect((await answer(offer.token, backup(app.backupCodes[0]!))).status).toBe(200);
        expect((await answer((await asked(who)).token, totp(await nextCode(app)))).status).toBe(
            200,
        );
    });

    test('from a known device freezes the app on that device alone, and thaws as the shared one does', async () => {
        const { who, app } = await stepped();
        const laptop = await knownDevice(who, app, 'laptop');
        const bad = await wrongCode(app);
        const laptopCode = async (code: string) =>
            answer((await asked(who, { device: laptop })).token, totp(code));

        await setDevice(laptop.id, 98);
        expect((await laptopCode(bad)).status).toBe(401);
        // Ninety-nine on the laptop: its right code passes.
        expect((await laptopCode(await nextCode(app))).status).toBe(200);
        expect(await frozenNotices()).toEqual([]);

        await setDevice(laptop.id, 99);
        expect((await laptopCode(bad)).status).toBe(401);
        expect(await frozenNotices()).toEqual([
            expect.stringMatching(/^Authenticator codes are paused on one of your devices · /),
        ]);
        const refused = await laptopCode(await nextCode(app));
        expect(refusedStep(refused)).toEqual({ status: 403, code: 'totp-frozen' });
        // One above: still frozen, and no second notice.
        await setDevice(laptop.id, 101);
        expect((await laptopCode(await nextCode(app))).status).toBe(403);
        expect(await frozenNotices()).toHaveLength(1);

        // Nowhere else: a new device's code passes. It is the app itself, so it thaws nothing.
        expect((await answer((await asked(who)).token, totp(await nextCode(app)))).status).toBe(
            200,
        );
        expect((await laptopCode(await nextCode(app))).status).toBe(403);
        // The phrase, from any device, does.
        const offer = await asked(who);
        expect((await answer(offer.token, await api.phraseProof(who, offer))).status).toBe(200);
        expect((await laptopCode(await nextCode(app))).status).toBe(200);
    });
});

describe('a code made under a key this server no longer has', () => {
    test('is an outage, not a wrong code: 503, and nothing is counted', async () => {
        const who = await api.account();
        // As after the operator replaced TWO_STEP_KEY and did not keep the old one.
        const app = await api.enrol(who.id, { under: randomBytes(32) });
        await api.rows.setSharedFailures(who.id, 99);
        const offer = await asked(who);
        // More than a token or a budget would take, were they counted.
        for (let round = 0; round < 6; round++)
            for (const proof of [totp(await app.code()), backup(app.backupCodes[0]!)]) {
                const reply = await answer(offer.token, proof);
                expect(reply.status, proof.kind).toBe(503);
                // Its own code: a gateway's 503 has none, and is not this.
                expect(reply.body.code).toBe('two-step-unavailable');
            }
        expect((await attemptRows()).map((row) => row.failures)).toEqual([0]);
        expect(await api.rows.sharedFailures(who.id)).toBe(99);
        expect(await subjects()).toEqual([]);
        expect((await api.twoStepRepository.getTwoStep(who.id)).backupCodes).toHaveLength(10);
        // The phrase needs no key of the server's, and still answers on the same token.
        expect((await answer(offer.token, await api.phraseProof(who, offer))).status).toBe(200);
    });

    test('one backup code under a missing key makes every backup code an outage: no guess is called wrong, none is matched', async () => {
        const { who, app } = await stepped();
        // Nine codes under the server's key, one under a key nobody has.
        await api.rows.strandOneBackupCode(who.id);
        await api.rows.setSharedFailures(who.id, 99);
        const offer = await asked(who);
        // A wrong guess is not "wrong": it might be the code that cannot be checked. More of
        // them than a token or the budget would take, were they counted.
        for (let index = 0; index < 12; index++) {
            const reply = await answer(offer.token, backup('00000-00000'));
            expect(reply.status).toBe(503);
            expect(reply.body.code).toBe('two-step-unavailable');
        }
        // Nothing is compared with the codes that could be checked either: each of the ten
        // codes that were shown gets the same 503, and none is spent.
        for (const code of app.backupCodes)
            expect((await answer(offer.token, backup(code))).status).toBe(503);
        expect((await api.twoStepRepository.getTwoStep(who.id)).backupCodes).toHaveLength(10);
        expect((await attemptRows()).map((row) => row.failures)).toEqual([0]);
        expect(await api.rows.sharedFailures(who.id)).toBe(99);
        expect(await subjects()).toEqual([]);
        expect(await sessionRows()).toEqual([]);
        // The authenticator app is under a key the server has, and answers on the same token.
        expect((await answer(offer.token, totp(await app.code()))).status).toBe(200);
    });
});

describe('“someone signed in with your password but did not pass the second step”', () => {
    const failedNotices = async () =>
        (await api.notices()).filter((message) =>
            message.subject.startsWith('Someone signed in with your password'),
        );

    test('is sent at the fifth failed step of any kind, not the fourth, and once an hour at most', async () => {
        const { who, app } = await stepped();
        const bad = await wrongCode(app);
        const junk = { kind: 'phrase', signature: b64(64) };
        const first = await asked(who);
        // A wrong code, a wrong backup code and two failed phrase signatures: four.
        for (const proof of [totp(bad), backup('00000-00000'), junk, junk])
            expect((await answer(first.token, proof)).status).toBe(401);
        expect(await failedNotices()).toEqual([]);

        // The fifth, a failed phrase signature, which no code count sees.
        expect((await answer(first.token, junk)).status).toBe(401);
        const sent = await failedNotices();
        expect(sent).toHaveLength(1);
        expect(sent[0]!.to).toBe(who.email);
        expect(sent[0]!.text).toContain(
            'Someone signed in with your password but did not pass the second step.',
        );
        expect(sent[0]!.text).toContain('Change your password.');

        // More failures in the same hour: no second notice.
        const second = await asked(who);
        for (let index = 0; index < 4; index++) await answer(second.token, junk);
        expect(await failedNotices()).toHaveLength(1);
        // After the hour, the next failure says it again.
        later(HOUR + MINUTE);
        expect((await answer((await asked(who)).token, junk)).status).toBe(401);
        expect(await failedNotices()).toHaveLength(2);
    });

    test('counts from the pool’s last success: four failures, a sign-in, and four more send nothing', async () => {
        const { who, app } = await stepped();
        const junk = { kind: 'phrase', signature: b64(64) };
        for (let round = 0; round < 2; round++) {
            const offer = await asked(who);
            for (let index = 0; index < 4; index++) await answer(offer.token, junk);
            expect((await answer(offer.token, totp(await nextCode(app)))).status).toBe(200);
        }
        expect(await failedNotices()).toEqual([]);
    });

    test('never uses up the notices that say the step was changed', async () => {
        const { who, app } = await stepped();
        const { cookie } = await signedIn(who, app);
        // The failed-step notice has gone out, and the devices' ten an hour are spent.
        const offer = await asked(who);
        for (let index = 0; index < 5; index++)
            await answer(offer.token, { kind: 'phrase', signature: b64(64) });
        for (let index = 0; index < 12; index++)
            await api.auth.notifyDevices(who.id, 'device-removed');
        expect(await failedNotices()).toHaveLength(1);
        const before = (await api.notices()).length;

        const token = await challenge(cookie, 'two-step');
        const removed = await api.call(
            'DELETE',
            `/two-step/methods/${app.factorId}`,
            {
                ...(await reauth(who, cookie)),
                twoStep: { token: token.token, proof: totp(await nextCode(app)) },
            },
            { cookie },
        );
        expect(removed.status).toBe(200);
        expect(removed.body).toEqual({ on: false });
        const after = await api.notices();
        expect(after.slice(before).map((message) => message.subject)).toEqual([
            expect.stringMatching(/^Two-step sign-in is off · /),
        ]);
    });
});

describe('a change the step guards', () => {
    test('a password change without the step is refused and changes nothing; with it, it goes through', async () => {
        const { who, app } = await stepped();
        const { cookie } = await signedIn(who, app);
        const outstanding = await asked(who);

        const without = await changePassword(who, cookie, 'a new password');
        expect(without.reply.status).toBe(403);
        expect(without.reply.body).toEqual({
            message: 'Confirm it’s you with your second step.',
            code: 'two-step',
        });
        const token = await challenge(cookie, 'password');
        const wrong = await changePassword(who, cookie, 'a new password', {
            token: token.token,
            proof: totp(await wrongCode(app)),
        });
        expect(refusedStep(wrong.reply)).toEqual({ status: 403, code: 'two-step' });
        // Still the old password, and still signed in.
        expect((await api.call('GET', '/session', undefined, { cookie })).body.user?.id).toBe(
            who.id,
        );
        await asked(who);

        const changed = await changePassword(who, cookie, 'a new password', {
            token: token.token,
            proof: totp(await nextCode(app)),
        });
        expect(changed.reply.status).toBe(200);
        // Every session ended but the one that replaces the asking device's own.
        expect((await sessionRows()).map((row) => row.tokenHash)).toEqual([
            api.sha256(changed.reply.cookie as string),
        ]);
        // A step token from before the change answers nothing after it.
        expect(refusedStep(await answer(outstanding.token, totp(await nextCode(app))))).toEqual({
            status: 401,
            code: 'two-step-expired',
        });
        // The new password signs in, and is asked for the step as before.
        const renewed = { ...who, password: 'a new password' };
        expect((await asked(renewed)).methods).toContain('totp');
    });

    test('an answer that is not a code costs nothing at a change: the same password proof finishes it once corrected', async () => {
        const { who, app } = await stepped();
        const { cookie } = await signedIn(who, app);

        // A password change: one proof of the password, sent with a slip and then with the code.
        const change = await passwordChange(who, cookie, 'a new password');
        const forPassword = await challenge(cookie, 'password');
        for (const proof of [totp('12345'), backup('7KQ2M-9XD4')]) {
            const slip = await change.send({ token: forPassword.token, proof });
            expect(slip.status).toBe(400);
            expect(slip.body.code).toBe('not-a-code');
        }
        expect((await attemptRows()).map((row) => row.failures)).toEqual([0]);
        // New backup codes, the same way: the proof made for it survives the slip.
        const password = await reauth(who, cookie);
        const forCodes = await challenge(cookie, 'two-step');
        const codes = (proof: unknown) =>
            api.call(
                'POST',
                '/two-step/backup-codes',
                { ...password, twoStep: { token: forCodes.token, proof } },
                { cookie },
            );
        expect((await codes(totp('abc def'))).status).toBe(400);
        expect((await codes(totp(await nextCode(app)))).status).toBe(200);
        // And the password change, with the proof it started with.
        const changed = await change.send({
            token: forPassword.token,
            proof: totp(await nextCode(app)),
        });
        expect(changed.status, JSON.stringify(changed.body)).toBe(200);
        // Only the session that replaces the asking device's is left.
        expect(await sessionRows()).toHaveLength(1);
    });

    test('nor at deletion: a mistyped code leaves the password proof for the right one', async () => {
        const { who, app } = await stepped();
        const { cookie } = await signedIn(who, app);
        const proof = await api.prove(who, '/delete/start', { cookie });
        const token = await challenge(cookie, 'delete');
        const finish = (answer: unknown) =>
            api.call(
                'POST',
                '/delete/finish',
                {
                    attemptToken: proof.attemptToken,
                    finishLoginRequest: proof.finishLoginRequest,
                    twoStep: { token: token.token, proof: answer },
                },
                { cookie },
            );
        expect((await finish(totp('1234567'))).status).toBe(400);
        expect((await finish(backup('nope'))).status).toBe(400);
        expect(await api.authRepository.getUserById(who.id)).not.toBeNull();
        const gone = await finish(totp(await nextCode(app)));
        expect(gone.status, JSON.stringify(gone.body)).toBe(200);
        expect(await api.authRepository.getUserById(who.id)).toBeNull();
    });

    test('a code used to sign in is refused for a change in the same 30 seconds', async () => {
        const { who, app } = await stepped();
        const offer = await asked(who);
        const code = await app.code();
        const done = await answer(offer.token, totp(code));
        const token = await challenge(done.cookie!, 'password');
        const replayed = await changePassword(who, done.cookie!, 'a new password', {
            token: token.token,
            proof: totp(code),
        });
        expect(refusedStep(replayed.reply)).toEqual({ status: 403, code: 'two-step' });
        const fresh = await changePassword(who, done.cookie!, 'a new password', {
            token: token.token,
            proof: totp(await nextCode(app)),
        });
        expect(fresh.reply.status).toBe(200);
    });

    test('a recovery-key rotation needs the step, and the old phrase then answers no step', async () => {
        const { who, app } = await stepped();
        const { cookie } = await signedIn(who, app);
        expect(
            refusedStep(
                (await changePassword(who, cookie, who.password, undefined, 'recovery-key')).reply,
            ),
        ).toEqual({ status: 403, code: 'two-step' });
        const token = await challenge(cookie, 'recovery-key');
        const { reply, rotated } = await changePassword(
            who,
            cookie,
            who.password,
            { token: token.token, proof: totp(await nextCode(app)) },
            'recovery-key',
        );
        expect(reply.status).toBe(200);

        // The step now offers the new recovery key's version and salt.
        const offer = await asked(who);
        expect(offer.phrase).toEqual({
            userId: who.id,
            recoveryVersion: 2,
            wrappingSalt: rotated!.envelope.wrappingSalt,
        });
        // The old phrase, with the new salt and with its own: the wrong recovery version.
        const old = [
            await api.phraseProof(who, offer),
            await api.phraseProof(who, {
                ...offer,
                phrase: { wrappingSalt: who.recovery.wrappingSalt },
            }),
        ];
        for (const proof of old)
            expect(refusedStep(await answer(offer.token, proof))).toEqual({
                status: 401,
                code: 'two-step',
            });
        const done = await answer(
            offer.token,
            await api.phraseProof({ id: who.id, phrase: rotated!.phrase }, offer),
        );
        expect(done.status).toBe(200);
    });

    /* A master-key rotation as a client sends it: everything the root wraps, wrapped again. */
    async function rotateMasterKey(who: Account, cookie: string, twoStep?: unknown) {
        const registration = client.startRegistration({ password: who.password });
        const proof = await api.prove(who, '/security/start', {
            cookie,
            extra: { action: 'master-key', registrationRequest: registration.registrationRequest },
        });
        const { registrationRecord } = client.finishRegistration({
            password: who.password,
            registrationResponse: proof.challenge.registrationResponse,
            clientRegistrationState: registration.clientRegistrationState,
            identifiers: OPAQUE_IDENTIFIERS,
        });
        const { envelope, recovery, identity, workspaces } = proof.challenge;
        const keyVersion = envelope.keyVersion + 1;
        const next = await api.recoveryKey(who.id, recovery.recoveryVersion + 1);
        return api.call(
            'POST',
            '/security/finish',
            {
                action: 'master-key',
                attemptToken: proof.attemptToken,
                finishLoginRequest: proof.finishLoginRequest,
                registrationRecord,
                envelope: {
                    envelopeVersion: 1,
                    keyVersion,
                    credentialVersion: envelope.credentialVersion + 1,
                    wrappingSalt: b64(32),
                    wrappingNonce: b64(24),
                    encryptedKey: b64(48),
                },
                recovery: { ...next.envelope, keyVersion },
                // The same public keys, wrapped under the new root.
                identity: { ...identity, kem: undefined },
                workspaces: workspaces.map((grant: Record<string, unknown>) => ({
                    version: 1,
                    workspaceId: grant.workspaceId,
                    keyVersion,
                    workspaceKeyVersion: grant.workspaceKeyVersion,
                    wrappingSalt: grant.wrappingSalt,
                    wrappingNonce: grant.wrappingNonce,
                    encryptedKey: grant.encryptedKey,
                })),
                ...(twoStep ? { twoStep } : {}),
            },
            { cookie },
        );
    }

    test('a master-key rotation is refused without the step and with another change’s token, and goes through with its own', async () => {
        const { who, app } = await stepped();
        const { cookie } = await signedIn(who, app);
        const keyVersion = async () => (await api.authRepository.getAccountKeyVersion(who.id)) ?? 0;
        const before = await keyVersion();

        expect(refusedStep(await rotateMasterKey(who, cookie))).toEqual({
            status: 403,
            code: 'two-step',
        });
        // A token asked for a password change, with a right code: the same body, refused by
        // the step and nothing else.
        const other = await challenge(cookie, 'password');
        expect(
            refusedStep(
                await rotateMasterKey(who, cookie, {
                    token: other.token,
                    proof: totp(await nextCode(app)),
                }),
            ),
        ).toEqual({ status: 403, code: 'two-step-expired' });
        expect(await keyVersion()).toBe(before);
        expect((await api.call('GET', '/session', undefined, { cookie })).body.user?.id).toBe(
            who.id,
        );

        // That very body with a token for this change: the rotation happens.
        const token = await challenge(cookie, 'master-key');
        const rotated = await rotateMasterKey(who, cookie, {
            token: token.token,
            proof: totp(await nextCode(app)),
        });
        expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
        expect(await keyVersion()).toBe(before + 1);
        expect(await sessionRows()).toHaveLength(1);
        // The step is still on afterwards, with the new recovery key on offer.
        expect((await asked(who)).phrase.recoveryVersion).toBe(2);
    });

    test('deleting the account without the step is refused; with it, the account goes', async () => {
        const { who, app } = await stepped();
        const { cookie } = await signedIn(who, app);
        expect(refusedStep(await deleteAccount(who, cookie))).toEqual({
            status: 403,
            code: 'two-step',
        });
        expect(await api.authRepository.getUserById(who.id)).not.toBeNull();
        const token = await challenge(cookie, 'delete');
        const wrong = await deleteAccount(who, cookie, {
            token: token.token,
            proof: backup('00000-00000'),
        });
        expect(refusedStep(wrong)).toEqual({ status: 403, code: 'two-step' });
        expect(await api.authRepository.getUserById(who.id)).not.toBeNull();

        const gone = await deleteAccount(who, cookie, {
            token: token.token,
            proof: backup(app.backupCodes[0]!),
        });
        expect(gone.status).toBe(200);
        expect(await api.authRepository.getUserById(who.id)).toBeNull();
    });

    test('adding an app, removing a method and making backup codes each need the step once it is on', async () => {
        const { who, app } = await stepped();
        const { cookie } = await signedIn(who, app);
        const routes: [method: 'POST' | 'DELETE', path: string][] = [
            ['POST', '/two-step/totp'],
            ['DELETE', `/two-step/methods/${app.factorId}`],
            ['POST', '/two-step/backup-codes'],
        ];
        for (const [method, path] of routes) {
            const without = await api.call(method, path, await reauth(who, cookie), { cookie });
            expect(refusedStep(without), path).toEqual({ status: 403, code: 'two-step' });
            // A token for another purpose is no better.
            const other = await challenge(cookie, 'password');
            const misused = await api.call(
                method,
                path,
                {
                    ...(await reauth(who, cookie)),
                    twoStep: { token: other.token, proof: totp(await nextCode(app)) },
                },
                { cookie },
            );
            expect(refusedStep(misused), path).toEqual({ status: 403, code: 'two-step-expired' });
        }
        // Nothing changed: the app, its codes, and no pending enrolment.
        const two = await api.twoStepRepository.getTwoStep(who.id);
        expect(two.factors.map((factor) => factor.id)).toEqual([app.factorId]);
        expect(two.backupCodes).toHaveLength(10);
        expect(await api.rows.factorRows()).toHaveLength(1);
    });

    test('none of them is asked of an account without the step, and each still needs the password', async () => {
        const who = await api.account();
        const { cookie } = await api.signIn(who);
        // A finish request that does not prove the password.
        const noPassword = await api.call(
            'POST',
            '/two-step/totp',
            { attemptToken: b64(32), finishLoginRequest: b64(64) },
            { cookie },
        );
        expect(noPassword.status).toBe(403);
        expect(noPassword.body.code).toBeUndefined();
        expect(await api.rows.factorRows()).toEqual([]);
        const started = await api.call('POST', '/two-step/totp', await reauth(who, cookie!), {
            cookie,
        });
        expect(started.status).toBe(200);
        expect((await changePassword(who, cookie!, 'a new password')).reply.status).toBe(200);
    });
});

/*
 * A password change, a new recovery phrase and a rotation end every session of the account.
 * The device that asked is handed the session that replaces its own, in the same transaction
 * and in the same reply: were it to sign in again, the step it met could be one it can no
 * longer answer (the phrase just replaced, the last backup code just spent), and the account
 * would be lost for good.
 */
describe('a security change leaves the device that asked signed in', () => {
    const rotation = async (who: Account, cookie: string, twoStep: unknown) => {
        const registration = client.startRegistration({ password: who.password });
        const proof = await api.prove(who, '/security/start', {
            cookie,
            extra: { action: 'master-key', registrationRequest: registration.registrationRequest },
        });
        const { registrationRecord } = client.finishRegistration({
            password: who.password,
            registrationResponse: proof.challenge.registrationResponse,
            clientRegistrationState: registration.clientRegistrationState,
            identifiers: OPAQUE_IDENTIFIERS,
        });
        const { envelope, recovery, identity, workspaces } = proof.challenge;
        const keyVersion = envelope.keyVersion + 1;
        const next = await api.recoveryKey(who.id, recovery.recoveryVersion + 1);
        return api.call(
            'POST',
            '/security/finish',
            {
                action: 'master-key',
                attemptToken: proof.attemptToken,
                finishLoginRequest: proof.finishLoginRequest,
                registrationRecord,
                envelope: {
                    envelopeVersion: 1,
                    keyVersion,
                    credentialVersion: envelope.credentialVersion + 1,
                    wrappingSalt: b64(32),
                    wrappingNonce: b64(24),
                    encryptedKey: b64(48),
                },
                recovery: { ...next.envelope, keyVersion },
                identity: { ...identity, kem: undefined },
                workspaces: workspaces.map((grant: Record<string, unknown>) => ({
                    version: 1,
                    workspaceId: grant.workspaceId,
                    keyVersion,
                    workspaceKeyVersion: grant.workspaceKeyVersion,
                    wrappingSalt: grant.wrappingSalt,
                    wrappingNonce: grant.wrappingNonce,
                    encryptedKey: grant.encryptedKey,
                })),
                twoStep,
            },
            { cookie },
        );
    };
    const whoIs = async (cookie: string) =>
        (await api.call('GET', '/session', undefined, { cookie })).body;

    test.each(['password', 'recovery-key', 'master-key'] as const)(
        'a %s change answered with the recovery phrase: this device carries on, stepped, and every other session ends',
        async (action) => {
            // The case that lost accounts: the app is gone and so are the codes, so the phrase
            // answers the step, and after a new phrase nothing the person holds would again.
            const { who, app } = await stepped();
            const here = await signedIn(who, app);
            const there = await signedIn(who, app);
            const before = (await sessionOf(here.cookie))!;
            const purpose = action;
            const token = await challenge(here.cookie, purpose);
            const twoStep = { token: token.token, proof: await api.phraseProof(who, token) };
            const reply =
                action === 'master-key'
                    ? await rotation(who, here.cookie, twoStep)
                    : (
                          await changePassword(
                              who,
                              here.cookie,
                              // A new phrase keeps the password; only a password change moves it.
                              action === 'password' ? 'a new password' : who.password,
                              twoStep,
                              action,
                          )
                      ).reply;
            expect(reply.status, JSON.stringify(reply.body)).toBe(200);
            expect(reply.body).toEqual({
                success: true,
                user: { id: who.id, name: 'Test Person', email: who.email, role: 'member' },
                envelope: expect.objectContaining({ envelopeVersion: 1, credentialVersion: 2 }),
                device: { id: before.deviceId, attached: true, registered: false },
            });
            // A new session, handed over as a sign-in hands one over, and none of the old ones.
            const cookie = reply.cookie as string;
            expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(cookie).not.toBe(here.cookie);
            expect((await whoIs(cookie)).user).toMatchObject({ id: who.id, credentialVersion: 2 });
            expect((await whoIs(here.cookie)).user).toBeNull();
            expect((await whoIs(there.cookie)).user).toBeNull();
            const rows = await sessionRows();
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                tokenHash: api.sha256(cookie),
                deviceId: before.deviceId,
                credentialVersion: 2,
            });
            // The same sign-in on new credentials: stepped when the old one was, begun when it began.
            expect(rows[0]!.twoStepAt?.getTime()).toBe(before.twoStepAt?.getTime());
            expect(rows[0]!.createdAt.getTime()).toBe(before.createdAt.getTime());
            expect(await deviceRows()).toHaveLength(2);
            // It can go straight on to what the change promised: the new phrase, to save.
            const kit = await api.call('GET', '/recovery-key', undefined, { cookie });
            expect(kit.status).toBe(200);
            if (action !== 'password') {
                expect(kit.body.recovery.recoveryVersion).toBe(2);
                expect(kit.body.confirmed).toBe(false);
                // The old phrase answers nothing now. Without the session above, this account
                // would be out of reach: no app, no codes, and a phrase nobody has seen.
                const offer = await asked(who);
                const old = await answer(offer.token, await api.phraseProof(who, offer));
                expect(refusedStep(old)).toEqual({ status: 401, code: 'two-step' });
            }
        },
    );

    test('a session that never passed the step is stepped by the change it answers, and so is the one that replaces it', async () => {
        // Signed in before the step was turned on: this session has no `two_step_at`.
        const who = await api.account();
        const { cookie } = await api.signIn(who);
        const app = await api.enrol(who.id);
        expect((await sessionOf(cookie as string))?.twoStepAt).toBeNull();
        const token = await challenge(cookie as string, 'password');
        const changed = await changePassword(who, cookie as string, 'a new password', {
            token: token.token,
            proof: totp(await app.code()),
        });
        expect(changed.reply.status, JSON.stringify(changed.reply.body)).toBe(200);
        expect((await sessionOf(changed.reply.cookie as string))?.twoStepAt).toBeInstanceOf(Date);
    });

    test('an account without the step carries on the same way, with no step to its session', async () => {
        const who = await api.account();
        const here = await api.signIn(who);
        const there = await api.signIn(who);
        const changed = await changePassword(who, here.cookie as string, 'a new password');
        expect(changed.reply.status, JSON.stringify(changed.reply.body)).toBe(200);
        const cookie = changed.reply.cookie as string;
        expect((await whoIs(cookie)).user).toMatchObject({ id: who.id, credentialVersion: 2 });
        expect((await whoIs(there.cookie as string)).user).toBeNull();
        expect((await sessionOf(cookie))?.twoStepAt).toBeNull();
    });

    test('when that session cannot be opened nothing is changed: the password, the step and every session stand', async () => {
        const { who, app } = await stepped();
        const here = await signedIn(who, app);
        const there = await signedIn(who, app);
        const token = await challenge(here.cookie, 'password');
        const code = await nextCode(app);
        const allow = await api.rows.refuseNewSessions(who.id);
        try {
            const refused = await changePassword(who, here.cookie, 'a new password', {
                token: token.token,
                proof: totp(code),
            });
            // The database's refusal, not the step's or the password's: a server failure.
            expect(refused.reply.status).toBeGreaterThanOrEqual(500);
            expect(refused.reply.cookie).toBeNull();
        } finally {
            await allow();
        }
        // Both devices are still signed in, on the old password.
        expect((await whoIs(here.cookie)).user).toMatchObject({ id: who.id, credentialVersion: 1 });
        expect((await whoIs(there.cookie)).user).toMatchObject({ id: who.id });
        expect((await api.signIn(who)).body.twoStep).toBeDefined();
        // The step was not spent on a change that did not happen: the same token and the same
        // code, with a new proof of the password, now make it.
        expect((await attemptRows()).some((row) => row.failures > 0)).toBe(false);
        const made = await changePassword(who, here.cookie, 'a new password', {
            token: token.token,
            proof: totp(code),
        });
        expect(made.reply.status, JSON.stringify(made.reply.body)).toBe(200);
        expect((await whoIs(made.reply.cookie as string)).user).toMatchObject({
            credentialVersion: 2,
        });
    });
});

describe('the step and what it authorises commit together', () => {
    test('a sign-in whose session cannot be opened spends nothing: the same token and backup code pass afterwards', async () => {
        const { who, app } = await stepped();
        const offer = await asked(who);
        // Suspended between the password and the step.
        await api.authRepository.setUserSuspended(who.id, true);
        const refused = await answer(offer.token, backup(app.backupCodes[0]!));
        expect(refused.status).toBe(403);
        expect(refused.cookie).toBeNull();
        expect(await sessionRows()).toEqual([]);
        expect((await api.twoStepRepository.getTwoStep(who.id)).backupCodes).toHaveLength(10);
        expect((await attemptRows()).map((row) => row.failures)).toEqual([0]);
        expect(await subjects()).toEqual([]);

        await api.authRepository.setUserSuspended(who.id, false);
        const done = await answer(offer.token, backup(app.backupCodes[0]!));
        expect(done.status).toBe(200);
        expect((await api.twoStepRepository.getTwoStep(who.id)).backupCodes).toHaveLength(9);
    });

    test('a change that does not happen spends nothing: the same token and code then make the change', async () => {
        const { who, app } = await stepped();
        const { cookie } = await signedIn(who, app);
        const token = await challenge(cookie, 'two-step');
        const code = await nextCode(app);
        const twoStep = { token: token.token, proof: totp(code) };
        // A method that is not on the account: the step passes, the removal does not.
        const missing = await api.call(
            'DELETE',
            `/two-step/methods/${randomUUID()}`,
            { ...(await reauth(who, cookie)), twoStep },
            { cookie },
        );
        expect(missing.status).toBe(404);
        expect((await attemptRows()).map((row) => [row.purpose, row.failures])).toEqual([
            ['two-step', 0],
        ]);
        // Nothing was removed, so nothing says so.
        expect((await subjects()).filter((line) => !line.startsWith('New sign-in'))).toEqual([]);
        // The very same code and token, still unspent.
        const removed = await api.call(
            'DELETE',
            `/two-step/methods/${app.factorId}`,
            { ...(await reauth(who, cookie)), twoStep },
            { cookie },
        );
        expect(removed.status).toBe(200);
        expect(removed.body).toEqual({ on: false });
    });

    test('a code that was already used never gets as far as stopping billing', async () => {
        const { who, app } = await stepped();
        const offer = await asked(who);
        const used = await app.code();
        const { cookie } = await answer(offer.token, totp(used));
        const token = await challenge(cookie!, 'delete');
        // What the route mounts before the account goes: the plan is stopped here.
        const billing: string[] = [];
        const beforeDelete = async (userId: string) => {
            billing.push(userId);
        };
        const finish = async (code: string) => {
            const proof = await api.prove(who, '/delete/start', { cookie });
            return api.auth.finishAccountDeletion(
                cookie!,
                {
                    attemptToken: proof.attemptToken,
                    finishLoginRequest: proof.finishLoginRequest,
                    twoStep: { token: token.token, proof: totp(code) },
                },
                beforeDelete,
            );
        };

        await expect(finish(used)).rejects.toMatchObject({ status: 403, code: 'two-step' });
        expect(billing).toEqual([]);
        expect(await api.authRepository.getUserById(who.id)).not.toBeNull();
        // Counted as the wrong answer it is.
        expect((await attemptRows()).map((row) => [row.purpose, row.failures])).toEqual([
            ['delete', 1],
        ]);

        // A fresh code: billing is stopped, once, and then the account goes.
        expect(await finish(await nextCode(app))).toEqual({ success: true });
        expect(billing).toEqual([who.id]);
        expect(await api.authRepository.getUserById(who.id)).toBeNull();
    });

    test('a deletion whose code is taken by another request while it waits takes back the person’s leaving their family', async () => {
        const { who, app } = await stepped();
        const organizer = await api.account();
        const family = await api.createTestFamily({
            organizerId: organizer.id,
            members: [{ userId: who.id }],
        });
        const membership = () => api.rows.membershipState(family.groupId, who.id);
        const { cookie } = await signedIn(who, app);
        const token = await challenge(cookie, 'delete');
        // Fresh, and right, when the deletion checks it.
        const code = await nextCode(app);
        const observer = api.lockObserver();
        let refused: Reply;
        try {
            // A group write under way holds the family's row, so the deletion waits for it:
            // after its answer was checked, before the step is passed under the lock.
            await observer.query('begin');
            await observer.query('select id from groups where id = $1 for update', [
                family.groupId,
            ]);
            const deletion = deleteAccount(who, cookie, { token: token.token, proof: totp(code) });
            await vi.waitFor(async () => expect(await observer.waitingOn('groups')).toBe(true), {
                timeout: 4_000,
            });
            // Meanwhile the same code signs in somewhere else, and takes the time step.
            expect((await answer((await asked(who)).token, totp(code))).status).toBe(200);
            await observer.query('commit');
            refused = await deletion;
        } finally {
            await observer.query('rollback').catch(() => {});
            await observer.end();
        }
        // Refused under the lock, as a wrong answer, and everything put back.
        expect(refusedStep(refused)).toEqual({ status: 403, code: 'two-step' });
        expect(await api.authRepository.getUserById(who.id)).not.toBeNull();
        expect(await membership()).toBe('active');
        expect(
            (await attemptRows())
                .filter((row) => row.purpose === 'delete')
                .map((row) => row.failures),
        ).toEqual([1]);

        const gone = await deleteAccount(who, cookie, {
            token: token.token,
            proof: totp(await nextCode(app)),
        });
        expect(gone.status).toBe(200);
        expect(await membership()).toBeUndefined();
    });
});

describe('the unlock on a device that passed the step', () => {
    const setSteppedAt = (cookie: string, at: Date) =>
        api.rows.setSteppedAt(api.sha256(cookie), at);

    test('passes without the step within 30 days, and keeps the time the step was passed', async () => {
        const { who, app } = await stepped();
        const first = await signedIn(who, app);
        const at = new Date(Date.now() - 29 * DAY);
        await setSteppedAt(first.cookie, at);

        const unlock = await api.signIn(who, { cookie: first.cookie });
        expect(unlock.status).toBe(200);
        expect(unlock.body).toMatchObject({
            envelope: {},
            device: { id: first.body.device.id },
        });
        expect(unlock.body.twoStep).toBeUndefined();
        // Inherited, not extended; and an old client is exempt the same way.
        expect((await sessionOf(unlock.cookie!))?.twoStepAt).toEqual(at);
        const again = await api.signIn(who, { cookie: unlock.cookie, old: true });
        expect(again.status).toBe(200);
        expect((await sessionOf(again.cookie!))?.twoStepAt).toEqual(at);
        expect(await deviceRows()).toHaveLength(1);
    });

    test('is asked for the step once the thirty days are over, by a minute', async () => {
        const { who, app } = await stepped();
        const first = await signedIn(who, app);
        const edge = 30 * DAY;
        await setSteppedAt(first.cookie, new Date(Date.now() - edge + MINUTE));
        const inside = await api.signIn(who, { cookie: first.cookie });
        expect(inside.body.envelope).toBeDefined();

        await setSteppedAt(inside.cookie!, new Date(Date.now() - edge - MINUTE));
        const past = await api.signIn(who, { cookie: inside.cookie });
        expect(Object.keys(past.body)).toEqual(['twoStep']);
        expect(past.cookie).toBeNull();
    });

    test('is not for another device, another account’s session, or a device that was removed', async () => {
        const { who, app } = await stepped();
        const laptop = await signedIn(who, app);
        const phoneKey = api.deviceKey('phone');
        const phone = await signedIn(who, app);
        await api.call(
            'POST',
            '/devices',
            { kind: 'web', name: 'Phone', signingPublicKey: phoneKey.publicKey },
            { cookie: phone.cookie },
        );
        const stranger = await stepped();
        const theirs = await signedIn(stranger.who, stranger.app);
        const stepOnly = (reply: Reply) => {
            expect(reply.status).toBe(200);
            expect(Object.keys(reply.body)).toEqual(['twoStep']);
            expect(reply.cookie).toBeNull();
        };

        // The laptop's stepped cookie, presented by the phone with the phone's own key.
        stepOnly(
            await api.signIn(who, {
                cookie: laptop.cookie,
                device: { id: phone.body.device.id, key: phoneKey },
            }),
        );
        // Another account's stepped session.
        stepOnly(await api.signIn(who, { cookie: theirs.cookie }));
        // No cookie at all.
        stepOnly(await api.signIn(who));
        expect(await sessionRows()).toHaveLength(3);

        // The laptop is removed from the phone: its cookie exempts nothing.
        const removal = await api.prove(who, '/devices/reauth', { cookie: phone.cookie });
        const removed = await api.call(
            'DELETE',
            `/devices/${laptop.body.device.id}`,
            { attemptToken: removal.attemptToken, finishLoginRequest: removal.finishLoginRequest },
            { cookie: phone.cookie },
        );
        expect(removed.status).toBe(200);
        stepOnly(await api.signIn(who, { cookie: laptop.cookie }));
        expect(await deviceRows()).toHaveLength(3);
    });

    test('a session from before the step was turned on is asked, until a change it makes passes the step', async () => {
        const who = await api.account();
        const early = await api.signIn(who);
        const app = await api.enrol(who.id);
        expect(Object.keys((await api.signIn(who, { cookie: early.cookie })).body)).toEqual([
            'twoStep',
        ]);
        // It makes new backup codes, answering the step: it has now passed it.
        const token = await challenge(early.cookie!, 'two-step');
        const made = await api.call(
            'POST',
            '/two-step/backup-codes',
            {
                ...(await reauth(who, early.cookie!)),
                twoStep: { token: token.token, proof: totp(await nextCode(app)) },
            },
            { cookie: early.cookie },
        );
        expect(made.status).toBe(200);
        expect((await sessionOf(early.cookie!))?.twoStepAt!.getTime()).toBe(Date.now());
        const unlock = await api.signIn(who, { cookie: early.cookie });
        expect(unlock.body.envelope).toBeDefined();
    });
});

describe('a two-step sign-in and the device list', () => {
    const signInNotices = async () =>
        (await api.notices()).filter((message) => message.subject.startsWith('New sign-in'));

    test('from a known device comes back to that device: no new row, and no new-device notice', async () => {
        const { who, app } = await stepped();
        const laptop = await knownDevice(who, app, 'laptop');
        await vi.waitFor(async () => expect(await signInNotices()).toHaveLength(1));
        const devices = await deviceRows();
        expect(devices).toHaveLength(1);

        const offer = await asked(who, { device: laptop });
        const done = await answer(offer.token, totp(await nextCode(app)));
        expect(done.status).toBe(200);
        expect(done.body.device).toEqual({ id: laptop.id, attached: true, registered: true });
        expect((await deviceRows()).map((row) => row.id)).toEqual([laptop.id]);
        expect((await sessionOf(done.cookie!))?.deviceId).toBe(laptop.id);
        // And again: the same device, however many times it signs in.
        const again = await asked(who, { device: laptop });
        const back = await answer(again.token, backup(app.backupCodes[0]!));
        expect(back.body.device.id).toBe(laptop.id);
        expect(await deviceRows()).toHaveLength(1);
        // Give a stray notice time to show up before saying there is none.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await signInNotices()).toHaveLength(1);
    });

    test('from a new device is a new row, and the notice names the password and what answered the step', async () => {
        const { who, app } = await stepped();
        const methods: [
            proof: (offer: Awaited<ReturnType<typeof asked>>) => Promise<unknown>,
            line: string,
        ][] = [
            [async () => totp(await nextCode(app)), 'Your password and an authenticator code'],
            [async () => backup(app.backupCodes[0]!), 'Your password and a backup code'],
            [(offer) => api.phraseProof(who, offer), 'Your password and your recovery phrase'],
        ];
        for (const [index, [proof, line]] of methods.entries()) {
            const offer = await asked(who);
            const done = await answer(offer.token, await proof(offer));
            expect(done.body.device).toMatchObject({ attached: false, registered: false });
            await vi.waitFor(async () => expect(await signInNotices()).toHaveLength(index + 1));
            const notice = (await signInNotices())[index]!;
            expect(notice.text).toContain(line);
        }
        expect(await deviceRows()).toHaveLength(3);
    });
});

describe('setting the step up', () => {
    /* The enrolment a signed-in person runs: the password again, the app, then its code. */
    async function startApp(who: Account, cookie: string, twoStep?: unknown) {
        const reply = await api.call(
            'POST',
            '/two-step/totp',
            { ...(await reauth(who, cookie)), ...(twoStep ? { twoStep } : {}) },
            { cookie },
        );
        expect(reply.status, JSON.stringify(reply.body)).toBe(200);
        const secret = base32Decode(reply.body.secret);
        return {
            ...(reply.body as { id: string; secret: string; uri: string }),
            code: (offset = 0) => totpCode(secret, totpStep() + offset),
        };
    }
    const confirm = (cookie: string, id: string, code: string, signOutOthers?: boolean) =>
        api.call(
            'POST',
            `/two-step/totp/${id}/confirm`,
            signOutOthers === undefined ? { code } : { code, signOutOthers },
            { cookie },
        );
    const signedInAs = async (cookie: string) =>
        (await api.call('GET', '/session', undefined, { cookie })).body;
    const removalNotices = async () =>
        (await api.notices()).filter((message) =>
            message.subject.startsWith('Devices were removed from your account'),
        );

    test('an authenticator app is confirmed by its code, turns the step on and shows the backup codes once', async () => {
        const who = await api.account();
        const { cookie } = await api.signIn(who);
        const app = await startApp(who, cookie!);
        expect(app.secret).toMatch(/^[A-Z2-7]{32}$/);
        const uri = new URL(app.uri);
        expect(decodeURIComponent(uri.pathname)).toBe(`/HushOS (localhost:5173):${who.email}`);
        expect(Object.fromEntries(uri.searchParams)).toEqual({
            secret: app.secret,
            issuer: 'HushOS (localhost:5173)',
            algorithm: 'SHA1',
            digits: '6',
            period: '30',
        });
        // Pending: the step is not on, and the stored secret is sealed, not the secret.
        expect((await api.call('GET', '/two-step', undefined, { cookie })).body).toEqual({
            on: false,
            methods: [],
            backupCodesLeft: 0,
            totpFrozen: false,
        });
        const [row] = await api.rows.factorRows();
        expect(row!.totpSecret).toHaveLength(36);
        expect(row!.totpSecret!.includes(Buffer.from(base32Decode(app.secret)))).toBe(false);
        expect((await api.signIn(who)).body.envelope).toBeDefined();

        // A wrong code confirms nothing.
        const wrong = await confirm(cookie!, app.id, 'abcdef');
        expect(wrong.status).toBe(400);
        expect((await api.twoStepRepository.getTwoStep(who.id)).on).toBe(false);

        const code = await app.code();
        const confirmed = await confirm(cookie!, app.id, code);
        expect(confirmed.status).toBe(200);
        expect(confirmed.body.backupCodes).toHaveLength(10);
        for (const backupCode of confirmed.body.backupCodes)
            expect(backupCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
        // On: this session passed the step by enrolling, and the account is told.
        expect((await sessionOf(cookie!))?.twoStepAt).toBeInstanceOf(Date);
        expect(await subjects()).toContainEqual(
            expect.stringMatching(/^Two-step sign-in is on · /),
        );
        expect((await api.notices()).at(-1)!.text).toContain('An authenticator app');
        const listed = (await api.call('GET', '/two-step', undefined, { cookie })).body;
        expect(listed).toEqual({
            on: true,
            methods: [
                {
                    id: app.id,
                    kind: 'totp',
                    name: 'Authenticator app',
                    createdAt: expect.stringMatching(/:00:00\.000Z$/),
                    lastUsedAt: null,
                    synced: false,
                },
            ],
            backupCodesLeft: 10,
            totpFrozen: false,
        });
        expect(JSON.stringify(listed)).not.toContain(app.secret);

        // The code that confirmed it cannot sign in; a backup code it showed can.
        expect(refusedStep(await answer((await asked(who)).token, totp(code)))).toEqual({
            status: 401,
            code: 'two-step',
        });
        const offer = await asked(who);
        expect((await answer(offer.token, backup(confirmed.body.backupCodes[0]))).status).toBe(200);
        // Confirming again answers nothing: the codes are shown once.
        expect((await confirm(cookie!, app.id, await app.code(1))).status).toBe(404);
    });

    test('turning the step on can sign the other devices out with it, and keeps the one that enrolled', async () => {
        const who = await api.account();
        const [here, laptop, phone] = [
            await api.signIn(who),
            await api.signIn(who),
            await api.signIn(who),
        ];
        const app = await startApp(who, here.cookie!);
        const confirmed = await confirm(here.cookie!, app.id, await app.code(), true);
        expect(confirmed.status).toBe(200);
        // The reply is the codes and nothing else.
        expect(Object.keys(confirmed.body)).toEqual(['backupCodes']);
        expect(confirmed.body.backupCodes).toHaveLength(10);

        // The other two are signed out, and told their device was removed.
        for (const other of [laptop, phone])
            expect(await signedInAs(other.cookie!)).toEqual({
                user: null,
                device: null,
                removed: true,
            });
        expect((await signedInAs(here.cookie!)).user?.id).toBe(who.id);
        expect((await sessionRows()).map((row) => row.tokenHash)).toEqual([
            api.sha256(here.cookie!),
        ]);
        expect((await sessionOf(here.cookie!))?.twoStepAt).toBeInstanceOf(Date);
        // Their cookies exempt nothing afterwards: the password alone no longer signs in.
        expect(Object.keys((await api.signIn(who, { cookie: laptop.cookie })).body)).toEqual([
            'twoStep',
        ]);
        // The account hears both: the step is on, and devices were removed.
        expect(await subjects()).toContainEqual(
            expect.stringMatching(/^Two-step sign-in is on · /),
        );
        await vi.waitFor(async () => expect(await removalNotices()).toHaveLength(1));
        expect((await removalNotices())[0]!.text).toMatch(/Devices removed\s+2/);
    });

    test('left unticked, or left out, the other devices stay signed in', async () => {
        for (const flag of [false, undefined]) {
            const who = await api.account();
            const [here, laptop] = [await api.signIn(who), await api.signIn(who)];
            const app = await startApp(who, here.cookie!);
            expect((await confirm(here.cookie!, app.id, await app.code(), flag)).status).toBe(200);
            expect((await signedInAs(laptop.cookie!)).user?.id).toBe(who.id);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await removalNotices()).toEqual([]);
    });

    test('confirming a replacement signs nobody out, whatever it asks', async () => {
        const { who, app: old } = await stepped();
        const here = await signedIn(who, old);
        const laptop = await signedIn(who, old);
        const token = await challenge(here.cookie, 'two-step');
        const app = await startApp(who, here.cookie, {
            token: token.token,
            proof: totp(await nextCode(old)),
        });
        const confirmed = await confirm(here.cookie, app.id, await app.code(), true);
        expect(confirmed.status).toBe(200);
        expect(confirmed.body).toEqual({});
        expect((await signedInAs(laptop.cookie)).user?.id).toBe(who.id);
        expect(await sessionRows()).toHaveLength(2);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await removalNotices()).toEqual([]);
    });

    test('a code typed “123 456” confirms the app, and one that is not six digits counts as no guess', async () => {
        const who = await api.account();
        const { cookie } = await api.signIn(who);
        const app = await startApp(who, cookie!);
        // More than the ten guesses a quarter of an hour allows, none of them a guess.
        for (let index = 0; index < 12; index++) {
            const reply = await confirm(cookie!, app.id, index % 2 ? 'abc def' : '12345');
            expect(reply.status).toBe(400);
            expect(reply.body.message).toBe('Enter the six digits your authenticator app shows.');
        }
        const code = await app.code();
        const confirmed = await confirm(cookie!, app.id, `${code.slice(0, 3)} ${code.slice(3)}`);
        expect(confirmed.status).toBe(200);
        expect(confirmed.body.backupCodes).toHaveLength(10);
    });

    test('nobody can use up the guesses for an app that is not theirs to confirm', async () => {
        const who = await api.account();
        const { cookie } = await api.signIn(who);
        const app = await startApp(who, cookie!);
        const other = await api.signIn(who);
        const stranger = await api.account();
        const theirs = await api.signIn(stranger);
        const bad = await wrongCode(app);
        // Another session of the account, at ids that are no pending app of it; and another
        // account, at this one's id. Eleven each: one more than the budget.
        for (let index = 0; index < 11; index++) {
            expect((await confirm(other.cookie!, randomUUID(), bad)).status).toBe(404);
            expect((await confirm(theirs.cookie!, app.id, bad)).status).toBe(404);
        }
        // The owner's own confirmation is not kept waiting.
        expect((await confirm(cookie!, app.id, await app.code())).status).toBe(200);
    });

    test('an enrolment nobody confirms lasts ten minutes, and never answers the step', async () => {
        const who = await api.account();
        const { cookie } = await api.signIn(who);
        const app = await startApp(who, cookie!);
        // Pending, the account still signs in on its password.
        expect((await api.signIn(who)).body.envelope).toBeDefined();
        later(10 * MINUTE + 1_000);
        expect((await confirm(cookie!, app.id, await app.code())).status).toBe(404);
        expect((await api.twoStepRepository.getTwoStep(who.id)).on).toBe(false);
    });

    test('another account cannot confirm someone’s pending app', async () => {
        const who = await api.account();
        const { cookie } = await api.signIn(who);
        const app = await startApp(who, cookie!);
        const stranger = await api.account();
        const theirs = await api.signIn(stranger);
        expect((await confirm(theirs.cookie!, app.id, await app.code())).status).toBe(404);
        expect((await api.twoStepRepository.getTwoStep(who.id)).on).toBe(false);
    });

    test('a new app replaces the old one, after the step: the old app’s codes stop, the backup codes stay', async () => {
        const { who, app: old } = await stepped();
        const { cookie } = await signedIn(who, old);
        const token = await challenge(cookie, 'two-step');
        const app = await startApp(who, cookie, {
            token: token.token,
            proof: totp(await nextCode(old)),
        });
        // Until it is confirmed the old app still answers.
        expect((await answer((await asked(who)).token, totp(await nextCode(old)))).status).toBe(
            200,
        );
        const confirmed = await confirm(cookie, app.id, await app.code());
        expect(confirmed.status).toBe(200);
        expect(confirmed.body).toEqual({});
        expect(await subjects()).toContainEqual(
            expect.stringMatching(/^A second step was added to your account · /),
        );
        expect(
            refusedStep(await answer((await asked(who)).token, totp(await nextCode(old)))),
        ).toEqual({
            status: 401,
            code: 'two-step',
        });
        expect((await answer((await asked(who)).token, totp(await app.code(1)))).status).toBe(200);
        expect((await answer((await asked(who)).token, backup(old.backupCodes[0]!))).status).toBe(
            200,
        );
    });

    test('new backup codes replace every old one, and the account is told', async () => {
        const { who, app } = await stepped();
        const { cookie } = await signedIn(who, app);
        const token = await challenge(cookie, 'two-step');
        const made = await api.call(
            'POST',
            '/two-step/backup-codes',
            {
                ...(await reauth(who, cookie)),
                twoStep: { token: token.token, proof: backup(app.backupCodes[0]!) },
            },
            { cookie },
        );
        expect(made.status).toBe(200);
        expect(made.body.codes).toHaveLength(10);
        expect(new Set(made.body.codes).size).toBe(10);
        expect(await subjects()).toContainEqual(
            expect.stringMatching(/^New backup codes were made · /),
        );
        expect(
            refusedStep(await answer((await asked(who)).token, backup(app.backupCodes[1]!))),
        ).toEqual({ status: 401, code: 'two-step' });
        expect((await answer((await asked(who)).token, backup(made.body.codes[9]))).status).toBe(
            200,
        );
    });

    test('removing the last method turns the step off: the codes go, and the password alone signs in', async () => {
        const { who, app } = await stepped();
        const { cookie } = await signedIn(who, app);
        const token = await challenge(cookie, 'two-step');
        const removed = await api.call(
            'DELETE',
            `/two-step/methods/${app.factorId}`,
            {
                ...(await reauth(who, cookie)),
                twoStep: { token: token.token, proof: totp(await nextCode(app)) },
            },
            { cookie },
        );
        expect(removed.body).toEqual({ on: false });
        expect(await subjects()).toContainEqual(
            expect.stringMatching(/^Two-step sign-in is off · /),
        );
        expect(await api.rows.backupCodeRows()).toEqual([]);
        expect((await api.call('GET', '/two-step', undefined, { cookie })).body).toMatchObject({
            on: false,
            methods: [],
            backupCodesLeft: 0,
        });
        expect((await api.signIn(who, { old: true })).body.envelope).toBeDefined();
        // And a challenge says so, as an answer: every password change asks this first, and a
        // refusal would be a failed request on each of them.
        const none = await api.call(
            'POST',
            '/two-step/challenge',
            { purpose: 'two-step' },
            { cookie },
        );
        expect([none.status, none.body]).toEqual([200, { on: false }]);
    });

    test('a method is renamed by any session, within the rules a device name follows', async () => {
        const { who, app } = await stepped();
        const { cookie } = await signedIn(who, app);
        const rename = (id: string, name: string, as = cookie) =>
            api.call('PUT', `/two-step/methods/${id}`, { name }, { cookie: as });
        const renamed = await rename(app.factorId, '  Maya’s   phone ');
        expect(renamed.status).toBe(200);
        expect(renamed.body.method).toMatchObject({ id: app.factorId, name: 'Maya’s phone' });
        // A bidi override, which would let a name read backwards in the list.
        expect((await rename(app.factorId, 'phone‮evil')).status).toBe(400);
        expect((await rename(app.factorId, 'x'.repeat(41))).status).toBe(400);
        // Another account's method is not there.
        const stranger = await stepped();
        const theirs = await signedIn(stranger.who, stranger.app);
        expect((await rename(app.factorId, 'Mine now', theirs.cookie)).status).toBe(404);
        expect(
            (await api.twoStepRepository.getTwoStep(who.id)).factors.map((factor) => factor.name),
        ).toEqual(['Maya’s phone']);
    });

    test('a session gets thirty step tokens in fifteen minutes, and the thirty-first is refused', async () => {
        const { who, app } = await stepped();
        const { cookie } = await signedIn(who, app);
        const ask = () =>
            api.call('POST', '/two-step/challenge', { purpose: 'two-step' }, { cookie });
        for (let index = 0; index < 30; index++) expect((await ask()).status).toBe(200);
        expect((await ask()).status).toBe(429);
        later(15 * MINUTE + 1_000);
        expect((await ask()).status).toBe(200);
    });

    test('guessing a pending app’s code is bounded: ten wrong in fifteen minutes, then even the right one waits', async () => {
        const who = await api.account();
        const { cookie } = await api.signIn(who);
        const app = await startApp(who, cookie!);
        const bad = await wrongCode(app);
        for (let index = 0; index < 10; index++)
            expect((await confirm(cookie!, app.id, bad)).status).toBe(400);
        // Still inside its ten minutes, and the code is right.
        expect((await confirm(cookie!, app.id, await app.code())).status).toBe(429);
        expect((await api.twoStepRepository.getTwoStep(who.id)).on).toBe(false);
    });

    test('a step token for a change is asked by a session, for a purpose the step guards', async () => {
        const { who, app } = await stepped();
        const { cookie } = await signedIn(who, app);
        const ask = (purpose: string, as: string | null = cookie) =>
            api.call('POST', '/two-step/challenge', { purpose }, { cookie: as });
        expect((await ask('two-step', null)).status).toBe(401);
        for (const purpose of ['login', 'enrol', 'device-approval', 'child-reset', 'anything'])
            expect((await ask(purpose)).status, purpose).toBe(400);
        const offer = await ask('delete');
        expect(offer.status).toBe(200);
        expect(offer.body).toEqual({
            on: true,
            token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
            methods: ['totp', 'backup', 'phrase'],
            expiresAt: new Date(Date.now() + 5 * MINUTE).toISOString(),
            // The same, counted from now: for a client whose clock is not this server's.
            expiresIn: 300,
            phrase: {
                userId: who.id,
                recoveryVersion: 1,
                wrappingSalt: who.recovery.wrappingSalt,
            },
        });
        const [row] = (await attemptRows()).filter((attempt) => attempt.purpose === 'delete');
        expect(row!.sessionTokenHash).toEqual(api.sha256(cookie));
    });
});

describe('what the account is told', () => {
    // The longest a method or device name may be (40), in the characters it may use.
    const HOSTILE = 'HushOS Support call 5550100 evil.example';
    const DISTINCTIVE = ['Support', 'call', '5550100', 'evil.example', 'evil'];
    const word = (piece: string) =>
        new RegExp(`(?<![\\p{L}\\p{N}])${piece.replaceAll('.', '\\.')}(?![\\p{L}\\p{N}])`, 'iu');

    test('never carries the name a method or a device was given, in any notice the step sends', async () => {
        const who = await api.account();
        const first = await api.signIn(who);
        const cookie = first.cookie!;
        const key = api.deviceKey('named');
        expect(
            (
                await api.call(
                    'POST',
                    '/devices',
                    { kind: 'web', name: HOSTILE, signingPublicKey: key.publicKey },
                    { cookie },
                )
            ).status,
        ).toBe(200);
        const device = { id: first.body.device.id as string, key };

        // On, through the routes; then the app is named by whoever holds the session.
        const started = await api.call('POST', '/two-step/totp', await reauth(who, cookie), {
            cookie,
        });
        const secret = base32Decode(started.body.secret);
        const code = (offset = 0) => totpCode(secret, totpStep() + offset);
        const next = () => {
            later(30_000);
            return code();
        };
        const confirmed = await api.call(
            'POST',
            `/two-step/totp/${started.body.id}/confirm`,
            { code: await code() },
            { cookie },
        );
        const codes = confirmed.body.backupCodes as string[];
        expect(
            (
                await api.call(
                    'PUT',
                    `/two-step/methods/${started.body.id}`,
                    { name: HOSTILE },
                    { cookie },
                )
            ).body.method.name,
        ).toBe(HOSTILE);

        // A backup code and the phrase used, each from a new device.
        expect((await answer((await asked(who)).token, backup(codes[0]!))).status).toBe(200);
        const offer = await asked(who);
        expect((await answer(offer.token, await api.phraseProof(who, offer))).status).toBe(200);
        // Five failed steps; then the freeze, for new devices and on the named device.
        const junk = { kind: 'phrase', signature: b64(64) };
        const failing = await asked(who);
        for (let index = 0; index < 5; index++) await answer(failing.token, junk);
        await api.rows.setSharedFailures(who.id, 99);
        await answer((await asked(who)).token, totp(await wrongCode({ code })));
        await api.rows.setDeviceFailures(device.id, 99);
        later(16 * MINUTE);
        await answer((await asked(who, { device })).token, totp(await wrongCode({ code })));
        // New codes (which thaws the app), a second app, and the step turned off.
        const step = async (proof: unknown) => ({
            ...(await reauth(who, cookie)),
            twoStep: { token: (await challenge(cookie, 'two-step')).token, proof },
        });
        const made = await api.call(
            'POST',
            '/two-step/backup-codes',
            await step(backup(codes[1]!)),
            {
                cookie,
            },
        );
        expect(made.status).toBe(200);
        const second = await api.call('POST', '/two-step/totp', await step(totp(await next())), {
            cookie,
        });
        const replacement = base32Decode(second.body.secret);
        later(30_000);
        expect(
            (
                await api.call(
                    'POST',
                    `/two-step/totp/${second.body.id}/confirm`,
                    { code: await totpCode(replacement, totpStep()) },
                    { cookie },
                )
            ).status,
        ).toBe(200);
        await api.call('PUT', `/two-step/methods/${second.body.id}`, { name: HOSTILE }, { cookie });
        later(30_000);
        const off = await api.call(
            'DELETE',
            `/two-step/methods/${second.body.id}`,
            await step(totp(await totpCode(replacement, totpStep()))),
            { cookie },
        );
        expect(off.body).toEqual({ on: false });

        const expected = [
            'Two-step sign-in is on',
            'A backup code was used',
            'Your recovery phrase was used for the second step',
            'Someone signed in with your password but did not pass the second step',
            'Authenticator codes are paused for new devices',
            'Authenticator codes are paused on one of your devices',
            'New backup codes were made',
            'A second step was added to your account',
            'Two-step sign-in is off',
            'New sign-in to your account',
        ];
        await vi.waitFor(async () => {
            const sent = await subjects();
            for (const subject of expected)
                expect(
                    sent.some((line) => line.startsWith(`${subject} · `)),
                    subject,
                ).toBe(true);
        });
        for (const message of await api.notices()) {
            expect(message.to).toBe(who.email);
            expect(message.subject).toMatch(/· HushOS$/);
            for (const part of [message.subject, message.text]) {
                expect(part.toLowerCase()).not.toContain(HOSTILE.toLowerCase());
                for (const piece of DISTINCTIVE)
                    expect(part, message.subject).not.toMatch(word(piece));
                // Nor an address or a browser: the requests all came from 203.0.113.x.
                expect(part).not.toMatch(/203\.0\.113\.|198\.51\.100\./);
            }
        }
    });
});

/* RFC 4648 base32, as the enrolment route shows a secret. */
function base32Decode(text: string) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const out: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (const char of text) {
        buffer = (buffer << 5) | alphabet.indexOf(char);
        bits += 5;
        if (bits >= 8) {
            out.push((buffer >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Uint8Array.from(out);
}
