import { randomBytes } from 'node:crypto';
import { KEY_STRETCHING, OPAQUE_IDENTIFIERS } from '@hushos/crypto';
import { createRecovery } from '@hushos/crypto/recovery';
import { client } from '@hushos/crypto/server';
import { totpCode, totpStep } from '@hushos/crypto/two-step/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    appCode,
    fromBase32,
    loadEdge,
    type Account,
    type Edge,
    type Reply,
} from '@/test/auth-edge.server';

/*
 * Two-step sign-in through the HTTP edge, real OPAQUE and Postgres, with TWO_STEP_ENABLED on
 * (docs/two-step-design.md 2, 4, 5, 7). What must hold whatever a client sends: an account
 * with the step gets no session, no cookie and no envelope for the password alone; no
 * security change, deletion or change to the step happens without it; a code or a token is
 * used once; five answers a token and ten wrong codes in 15 minutes are all anyone gets,
 * charged before the answer is looked at; and the account hears what happened.
 *
 * The clock is pinned for each test, so a code's 30-second step never turns under it:
 * `appCode(secret, -1 | 0 | 1)` are the three codes the server accepts.
 */

let edge: Edge;
const b64 = (bytes: number) => randomBytes(bytes).toString('base64url');

beforeAll(async () => {
    edge = await loadEdge({ TWO_STEP_ENABLED: 'true' });
});
beforeEach(async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    await edge.resetDatabase();
    edge.outbox.length = 0;
    edge.emitted.length = 0;
    edge.state.address = '203.0.113.1';
});
afterEach(() => {
    vi.useRealTimers();
});
afterAll(() => edge.closeDatabase());

/* A new account, signed in with its password. */
async function signedIn() {
    const who = await edge.account();
    const first = await edge.signIn(who);
    expect(first.status).toBe(200);
    return { who, cookie: first.session!, deviceId: first.body.device.id as string };
}

/* Turns the step on as the settings page does: the password again, the secret it shows, a code from it. */
async function turnOn(cookie: string) {
    const { proof } = await edge.passwordProof('/two-step/reauth', {}, { cookie });
    const enrol = await edge.call('POST', '/two-step/totp', proof, { cookie });
    expect(enrol.status).toBe(200);
    // The code of the step before: accepted, and it leaves this step's and the next one's unused.
    const confirmed = await edge.call(
        'POST',
        `/two-step/totp/${enrol.body.id}/confirm`,
        { code: await appCode(enrol.body.secret, -1) },
        { cookie },
    );
    expect(confirmed.status).toBe(200);
    return {
        factorId: enrol.body.id as string,
        secret: enrol.body.secret as string,
        codes: confirmed.body.backupCodes as string[],
    };
}

async function stepped() {
    const account = await signedIn();
    return { ...account, ...(await turnOn(account.cookie)) };
}

/* A sign-in as far as the step, by a client that can answer one. */
async function toStep(who: Account, options: Parameters<Edge['signIn']>[1] = {}) {
    const reply = await edge.signIn(who, { twoStep: true, ...options });
    expect(reply.status).toBe(200);
    expect(reply.body.twoStep).toBeDefined();
    return reply.body.twoStep as {
        token: string;
        methods: string[];
        expiresAt: string;
        phrase: { userId: string; recoveryVersion: number; wrappingSalt: string };
    };
}

const answer = (token: string, proof: Record<string, string>) =>
    edge.call('POST', '/login/two-step', { token, proof });

/* Six digits that are none of the three the server would accept. */
async function wrongCode(secret: string) {
    const right = new Set<string>();
    for (const offset of [-1, 0, 1]) right.add(await appCode(secret, offset));
    for (let guess = 0; ; guess++) {
        const code = String(guess).padStart(6, '0');
        if (!right.has(code)) return code;
    }
}

/* A step for a change this session is about to make. */
async function challenge(cookie: string, purpose: string) {
    const reply = await edge.call('POST', '/two-step/challenge', { purpose }, { cookie });
    expect(reply.status).toBe(200);
    return reply.body as Awaited<ReturnType<typeof toStep>>;
}

/* A password change as the client sends it: the old password proved, a record for the new one. */
async function changePassword(
    cookie: string,
    to: string,
    twoStep?: unknown,
    extra: Record<string, unknown> = {},
): Promise<Reply> {
    const registration = client.startRegistration({ password: to });
    const { challenge: started, proof } = await edge.passwordProof(
        '/security/start',
        { action: 'password', registrationRequest: registration.registrationRequest },
        { cookie },
    );
    const { registrationRecord } = client.finishRegistration({
        password: to,
        clientRegistrationState: registration.clientRegistrationState,
        registrationResponse: started.registrationResponse,
        identifiers: OPAQUE_IDENTIFIERS,
        keyStretching: KEY_STRETCHING,
    });
    return edge.call(
        'POST',
        '/security/finish',
        {
            action: 'password',
            ...proof,
            registrationRecord,
            envelope: {
                envelopeVersion: 1,
                keyVersion: started.envelope.keyVersion,
                credentialVersion: started.envelope.credentialVersion + 1,
                wrappingSalt: b64(32),
                wrappingNonce: b64(24),
                encryptedKey: b64(48),
            },
            ...(twoStep ? { twoStep } : {}),
            ...extra,
        },
        { cookie },
    );
}

/* Rows as they are stored, past every route. The tables hold a test's few rows, so they are read whole. */
const rows = {
    sessions: () => edge.db.select().from(edge.schema.sessions),
    state: async (userId: string) =>
        (await edge.db.select().from(edge.schema.twoStepState)).find(
            (row) => row.userId === userId,
        )!,
    factor: async (id: string) =>
        (await edge.db.select().from(edge.schema.twoStepFactors)).find((row) => row.id === id),
    log: async (userId: string) =>
        (await edge.db.select().from(edge.schema.accountSecurityEvents))
            .filter((row) => row.userId === userId)
            .map((row) => `${row.kind}:${row.method ?? '-'}`),
};

describe('turning the step on', () => {
    test('from the secret the page shows: the app is confirmed, the codes are shown once, and the account is told', async () => {
        const { who, cookie } = await signedIn();
        expect((await edge.call('GET', '/two-step', undefined, { cookie })).body).toEqual({
            on: false,
            methods: [],
            backupCodesLeft: 0,
            totpFrozen: false,
        });
        // The password again first: without it nothing is started.
        const wrong = await edge.passwordProof('/two-step/reauth', {}, { cookie, password: 'no' });
        expect((await edge.call('POST', '/two-step/totp', wrong.proof, { cookie })).status).toBe(
            403,
        );
        const { proof } = await edge.passwordProof('/two-step/reauth', {}, { cookie });
        const enrol = await edge.call('POST', '/two-step/totp', proof, { cookie });
        expect(enrol.status).toBe(200);
        expect(enrol.body.secret).toMatch(/^[A-Z2-7]{32}$/);
        const uri = new URL(enrol.body.uri);
        expect(uri.searchParams.get('secret')).toBe(enrol.body.secret);
        expect(decodeURIComponent(uri.pathname)).toBe(`/HushOS (localhost:5173):${who.email}`);
        // The password proof is one use: the same one starts nothing again.
        expect((await edge.call('POST', '/two-step/totp', proof, { cookie })).status).toBe(403);

        // Pending, the app is not the step, and its secret is nowhere in plain text.
        expect((await edge.call('GET', '/two-step', undefined, { cookie })).body.on).toBe(false);
        const stored = (await rows.factor(enrol.body.id))!;
        expect(stored.totpSecret).toHaveLength(36);
        expect(stored.totpSecret!.includes(Buffer.from(fromBase32(enrol.body.secret)))).toBe(false);

        const confirmPath = `/two-step/totp/${enrol.body.id}/confirm`;
        const mistyped = await edge.call(
            'POST',
            confirmPath,
            { code: await wrongCode(enrol.body.secret) },
            { cookie },
        );
        expect(mistyped).toMatchObject({ status: 400, body: { code: 'step-wrong' } });
        expect((await edge.call('GET', '/two-step', undefined, { cookie })).body.on).toBe(false);
        // Another account's session cannot confirm it.
        const other = await signedIn();
        expect(
            (
                await edge.call(
                    'POST',
                    confirmPath,
                    { code: await appCode(enrol.body.secret) },
                    { cookie: other.cookie },
                )
            ).status,
        ).toBe(404);

        const confirmed = await edge.call(
            'POST',
            confirmPath,
            { code: await appCode(enrol.body.secret) },
            { cookie },
        );
        expect(confirmed.status).toBe(200);
        expect(confirmed.body.backupCodes).toHaveLength(10);
        for (const code of confirmed.body.backupCodes)
            expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
        // What is stored of the codes is none of them.
        const hashes = await edge.db.select().from(edge.schema.twoStepBackupCodes);
        expect(hashes).toHaveLength(10);
        const everything = Buffer.concat(hashes.map((row) => row.codeHash)).toString('latin1');
        for (const code of confirmed.body.backupCodes)
            expect(everything).not.toContain(code.replace('-', ''));

        const status = (await edge.call('GET', '/two-step', undefined, { cookie })).body;
        expect(status).toMatchObject({ on: true, backupCodesLeft: 10, totpFrozen: false });
        expect(status.methods).toMatchObject([{ id: enrol.body.id, kind: 'totp', name: null }]);
        // The codes are never shown again: confirming twice answers nothing.
        expect(
            (
                await edge.call(
                    'POST',
                    confirmPath,
                    { code: await appCode(enrol.body.secret, 1) },
                    { cookie },
                )
            ).status,
        ).toBe(404);
        expect(await edge.notices('two-step-on')).toMatchObject([
            {
                to: who.email,
                kind: 'two-step-on',
                count: undefined,
                method: 'An authenticator app',
            },
        ]);
        expect(await rows.log(who.userId)).toEqual(['two-step-on:totp']);
    }, 60_000);
});

describe('signing in to an account with the step on', () => {
    test('the password alone opens nothing: an old client is told to update, a new one is asked for the step', async () => {
        const { who, deviceId, secret } = await stepped();
        const before = await rows.sessions();

        // A client that cannot answer a step.
        const old = await edge.signIn(who);
        expect(old.status).toBe(409);
        expect(old.body).toEqual({
            message: 'Update HushOS to sign in. This account asks for a second step.',
            code: 'update-required',
        });
        expect(old.session).toBeUndefined();

        // One that can: a token and what can answer it, and nothing a session would carry.
        const asked = await edge.signIn(who, { twoStep: true });
        expect(asked.status).toBe(200);
        expect(asked.session).toBeUndefined();
        expect(Object.keys(asked.body)).toEqual(['twoStep']);
        expect(asked.body.twoStep).toMatchObject({
            token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
            methods: ['totp', 'backup', 'phrase'],
            phrase: { userId: who.userId, recoveryVersion: 1 },
        });
        expect(JSON.stringify(asked.body)).not.toMatch(/envelope|encryptedKey|wrappingNonce/);
        // A wrong password fails exactly as it does for an account without the step.
        const guessed = await edge.signIn(who, { twoStep: true, password: 'not the password' });
        expect(guessed).toMatchObject({
            status: 401,
            body: { message: 'Unable to sign in. Check your email and password.' },
        });
        // Nothing was opened by any of it.
        expect(await rows.sessions()).toEqual(before);

        // The step, answered: what a sign-in answers today, and the cookie.
        const passed = await answer(asked.body.twoStep.token, {
            kind: 'totp',
            code: await appCode(secret),
        });
        expect(passed.status).toBe(200);
        expect(Object.keys(passed.body).sort()).toEqual(['device', 'envelope', 'user']);
        expect(passed.body.user).toMatchObject({ id: who.userId, email: who.email });
        expect(passed.body.device).toMatchObject({ attached: false, registered: false });
        expect(passed.body.device.id).not.toBe(deviceId);
        const session = await edge.call('GET', '/session', undefined, { cookie: passed.session });
        expect(session.body.user).toMatchObject({ id: who.userId });
        // The new device's notice says how it came in.
        expect(await edge.notices('new-device')).toMatchObject([
            { to: who.email, method: 'Your password and an authenticator code' },
        ]);
        // The token is used up with the session it opened.
        expect(
            await answer(asked.body.twoStep.token, {
                kind: 'totp',
                code: await appCode(secret, 1),
            }),
        ).toMatchObject({ status: 401, body: { code: 'step-expired' } });
    }, 60_000);

    test('a device that keeps its session is not asked again at an unlock; any other sign-in is', async () => {
        const { who, cookie, deviceId } = await stepped();
        // The web's unlock after a lock, by a client that knows nothing of the step: the live,
        // stepped session's cookie on the same device.
        const unlocked = await edge.signIn(who, { cookie });
        expect(unlocked.status).toBe(200);
        expect(unlocked.body.device).toMatchObject({ id: deviceId, attached: true });
        expect(unlocked.session).toBeTruthy();
        // The same browser without its cookie, and with one that is no session of this account.
        expect((await edge.signIn(who)).body.code).toBe('update-required');
        const stranger = await signedIn();
        expect((await edge.signIn(who, { cookie: stranger.cookie })).body.code).toBe(
            'update-required',
        );
        expect(await rows.sessions()).toHaveLength(2);
    }, 60_000);

    test('a code passes once: its replay is refused at sign-in and for a change, and counted', async () => {
        const { who, cookie, secret, factorId } = await stepped();
        const code = await appCode(secret);
        const first = await toStep(who);
        expect((await answer(first.token, { kind: 'totp', code })).status).toBe(200);

        // The same code on another sign-in, within its 30 seconds.
        const second = await toStep(who);
        expect(await answer(second.token, { kind: 'totp', code })).toMatchObject({
            status: 401,
            body: {
                code: 'step-wrong',
                message: 'That code didn’t work. Codes change every 30 seconds.',
            },
        });
        expect((await rows.sessions()).length).toBe(2);
        expect((await rows.state(who.userId)).consecutiveFailures).toBe(1);
        // And for a security change from the session that is signed in.
        const step = await challenge(cookie, 'password');
        const changed = await changePassword(cookie, 'a new password entirely', {
            token: step.token,
            proof: { kind: 'totp', code },
        });
        expect(changed).toMatchObject({ status: 403, body: { code: 'step-wrong' } });
        expect((await edge.signIn(who, { twoStep: true })).status).toBe(200);
        // A code from before the last one used, though still inside its 90 seconds.
        expect(
            (await answer(second.token, { kind: 'totp', code: await appCode(secret, -1) })).status,
        ).toBe(401);
        // The next code passes, and a code too far ahead never does.
        expect((await rows.factor(factorId))!.totpLastStep).toBe(totpStep());
        const third = await toStep(who);
        const ahead = await totpCode(fromBase32(secret), totpStep() + 3);
        expect((await answer(third.token, { kind: 'totp', code: ahead })).status).toBe(401);
        expect(
            (await answer(third.token, { kind: 'totp', code: await appCode(secret, 1) })).status,
        ).toBe(200);
    }, 60_000);

    test('a token takes five answers however many arrive at once, and only those five are counted or charged', async () => {
        const { who, secret } = await stepped();
        const step = await toStep(who);
        const wrong = await wrongCode(secret);
        const replies = await Promise.all(
            Array.from({ length: 30 }, () => answer(step.token, { kind: 'totp', code: wrong })),
        );
        expect(replies.map((reply) => reply.status)).toEqual(Array.from({ length: 30 }, () => 401));
        expect(replies.every((reply) => reply.session === undefined)).toBe(true);
        // Five were checked; the other twenty-five never were.
        expect((await rows.state(who.userId)).consecutiveFailures).toBe(5);
        expect(
            (await rows.log(who.userId)).filter((line) => line === 'step-failed:totp'),
        ).toHaveLength(5);
        expect(await edge.db.select().from(edge.schema.twoStepAttempts)).toHaveLength(0);
        // The token is over, for a right answer too.
        expect(
            await answer(step.token, { kind: 'totp', code: await appCode(secret) }),
        ).toMatchObject({
            status: 401,
            body: { code: 'step-expired' },
        });
        // The 15-minute budget was charged five, not thirty: five more wrong codes are still
        // checked, and the eleventh is refused unchecked.
        const next = await toStep(who);
        for (let guess = 0; guess < 5; guess++)
            expect((await answer(next.token, { kind: 'totp', code: wrong })).body.code).toMatch(
                /^step-(wrong|expired)$/,
            );
        const last = await toStep(who);
        expect(await answer(last.token, { kind: 'totp', code: wrong })).toMatchObject({
            status: 429,
            body: { code: 'step-limited' },
        });
        expect((await rows.state(who.userId)).consecutiveFailures).toBe(10);
    }, 60_000);

    test('the budget is charged before a code is looked at: past ten wrong codes even the right one is refused, and the phrase still passes', async () => {
        const { who, secret, factorId } = await stepped();
        const wrong = await wrongCode(secret);
        const guess = async (token: string) =>
            (await answer(token, { kind: 'totp', code: wrong })).body.code;

        const first = await toStep(who);
        for (let index = 0; index < 5; index++) await guess(first.token);
        // From another address: the budget is the account's, not the address's.
        edge.state.address = '198.51.100.7';
        const second = await toStep(who);
        for (let index = 0; index < 4; index++)
            expect(await guess(second.token)).toBe('step-wrong');
        // Nine wrong, then a right code in the token's fifth slot: it passes, and its charge is handed back.
        expect(
            (await answer(second.token, { kind: 'totp', code: await appCode(secret) })).status,
        ).toBe(200);
        expect((await rows.state(who.userId)).consecutiveFailures).toBe(0);
        const third = await toStep(who);
        // So a tenth wrong code is still checked and counted.
        expect(await guess(third.token)).toBe('step-wrong');
        expect((await rows.state(who.userId)).consecutiveFailures).toBe(1);

        // The eleventh code is refused whatever it is: the right one, and a backup code.
        const right = await answer(third.token, { kind: 'totp', code: await appCode(secret, 1) });
        expect(right).toMatchObject({ status: 429, body: { code: 'step-limited' } });
        expect(right.session).toBeUndefined();
        expect((await rows.factor(factorId))!.totpLastStep).toBe(totpStep());
        expect((await rows.state(who.userId)).consecutiveFailures).toBe(1);
        // Refused unchecked, it was not spent: only the budget stands in its way.
        expect((await answer(third.token, { kind: 'backup', code: 'AAAAA-AAAAA' })).status).toBe(
            429,
        );
        // The phrase is never refused for a spent budget.
        const passed = await answer(third.token, await edge.phraseProof(who.phrase, third));
        expect(passed.status).toBe(200);
        expect(passed.session).toBeTruthy();
    }, 90_000);

    test('a backup code passes once, however it is typed, and only for its own account', async () => {
        const { who, codes } = await stepped();
        const other = await stepped();
        const step = await toStep(who);
        // Another account's code is no code here.
        expect(await answer(step.token, { kind: 'backup', code: other.codes[0]! })).toMatchObject({
            status: 401,
            body: {
                code: 'step-wrong',
                message: 'That backup code didn’t work. Each code works once.',
            },
        });
        // Typed in lower case with a space, it is the same code.
        const typed = codes[0]!.toLowerCase().replace('-', ' ');
        const passed = await answer(step.token, { kind: 'backup', code: typed });
        expect(passed.status).toBe(200);
        expect(passed.session).toBeTruthy();
        expect(await edge.notices('backup-code-used')).toMatchObject([
            { to: who.email, kind: 'backup-code-used', count: 9, method: undefined },
        ]);
        expect((await edge.notices('new-device')).at(-1)).toMatchObject({
            method: 'Your password and a backup code',
        });
        // Used, it is refused the second time; the next one works.
        const again = await toStep(who);
        expect((await answer(again.token, { kind: 'backup', code: codes[0]! })).status).toBe(401);
        expect((await answer(again.token, { kind: 'backup', code: codes[1]! })).status).toBe(200);
        expect(
            (await edge.call('GET', '/two-step', undefined, { cookie: passed.session })).body
                .backupCodesLeft,
        ).toBe(8);
        expect(
            (await edge.call('GET', '/two-step', undefined, { cookie: other.cookie })).body
                .backupCodesLeft,
        ).toBe(10);
    }, 90_000);

    test('the recovery phrase passes the step at once, signed for this token by this account’s phrase and no other', async () => {
        const { who } = await stepped();
        const other = await stepped();
        const step = await toStep(who);
        const refused = { status: 401, body: { code: 'step-wrong' } };
        // Another account's phrase; this account's phrase over another sign-in's token.
        expect(
            await answer(step.token, await edge.phraseProof(other.who.phrase, step)),
        ).toMatchObject(refused);
        const elsewhere = await toStep(who);
        expect(
            await answer(step.token, await edge.phraseProof(who.phrase, elsewhere)),
        ).toMatchObject(refused);
        // Signed with the right phrase under another salt than the one the step carries.
        expect(
            await answer(
                step.token,
                await edge.phraseProof(who.phrase, {
                    ...step,
                    phrase: { ...step.phrase, wrappingSalt: b64(32) },
                }),
            ),
        ).toMatchObject(refused);
        expect((await rows.state(who.userId)).consecutiveFailures).toBe(3);
        expect(await rows.sessions()).toHaveLength(2);

        const passed = await answer(step.token, await edge.phraseProof(who.phrase, step));
        expect(passed.status).toBe(200);
        expect(passed.body.user.id).toBe(who.userId);
        expect(passed.session).toBeTruthy();
        expect(await edge.notices('phrase-used')).toMatchObject([
            { to: who.email, kind: 'phrase-used', count: undefined, method: undefined },
        ]);
        expect((await edge.notices('new-device')).at(-1)).toMatchObject({
            method: 'Your password and your recovery phrase',
        });
        expect(await rows.log(who.userId)).toContain('sign-in:phrase');
        // The signature was for that token, and the token is gone.
        expect(
            await answer(elsewhere.token, await edge.phraseProof(who.phrase, step)),
        ).toMatchObject(refused);
    }, 90_000);

    test('wrong answers tell the account once an hour from the fifth, and the hundredth pauses the app for new devices only', async () => {
        const { who, cookie, deviceId, secret } = await stepped();
        const laptop = await edge.giveDeviceKey(cookie, deviceId);
        const garbage = { kind: 'phrase', signature: b64(64) };
        const first = await toStep(who);
        for (let index = 0; index < 4; index++) await answer(first.token, garbage);
        await edge.quiet();
        expect(edge.outbox.filter((notice) => notice.kind === 'step-failed')).toEqual([]);
        expect(await answer(first.token, garbage)).toMatchObject({
            status: 401,
            body: { code: 'step-expired' },
        });
        expect(await edge.notices('step-failed')).toHaveLength(1);
        // Five more, the same hour: counted, and no second notice.
        const second = await toStep(who);
        for (let index = 0; index < 5; index++) await answer(second.token, garbage);
        await edge.quiet();
        expect(edge.outbox.filter((notice) => notice.kind === 'step-failed')).toHaveLength(1);
        expect((await rows.state(who.userId)).consecutiveFailures).toBe(10);

        // As ninety-nine wrong answers in a row leave it; the hundredth arrives over HTTP.
        await edge.db.$client.query(
            'update two_step_state set consecutive_failures = 99 where user_id = $1',
            [who.userId],
        );
        edge.state.address = '198.51.100.9';
        const third = await toStep(who);
        expect(third.methods).toContain('totp');
        await answer(third.token, garbage);
        expect(await edge.notices('totp-frozen')).toMatchObject([
            { to: who.email, kind: 'totp-frozen', count: undefined, method: undefined },
        ]);
        // A sign-in that proves no device is no longer offered the app, and its code is refused unchecked.
        const frozen = await toStep(who);
        expect(frozen.methods).toEqual(['backup', 'phrase']);
        expect(
            await answer(frozen.token, { kind: 'totp', code: await appCode(secret) }),
        ).toMatchObject({
            status: 403,
            body: { code: 'step-frozen' },
        });
        expect((await rows.state(who.userId)).consecutiveFailures).toBe(100);

        // The device that proves its key still takes the app's code, on its own count.
        const known = await toStep(who, { device: laptop });
        expect(known.methods).toEqual(['totp', 'backup', 'phrase']);
        const back = await answer(known.token, { kind: 'totp', code: await appCode(secret) });
        expect(back.status).toBe(200);
        expect(back.body.device).toMatchObject({ id: deviceId, attached: true });
        // The app's own code lifts nothing; the phrase from a new device does.
        expect((await toStep(who)).methods).toEqual(['backup', 'phrase']);
        const lifted = await answer(frozen.token, await edge.phraseProof(who.phrase, frozen));
        expect(lifted.status).toBe(200);
        expect((await toStep(who)).methods).toEqual(['totp', 'backup', 'phrase']);
        expect(await rows.log(who.userId)).toContain('totp-frozen:totp');
    }, 120_000);
});

describe('changes that need the step', () => {
    test('a password change without the step, or with a wrong one, saves nothing; with it, the password changes', async () => {
        const { who, cookie, secret, codes } = await stepped();
        const next = 'a new password entirely';
        const unchanged = async () => {
            // The old password still proves itself, and the new one does not.
            expect((await edge.signIn(who, { twoStep: true })).status).toBe(200);
            expect((await edge.signIn(who, { twoStep: true, password: next })).status).toBe(401);
        };

        expect(await changePassword(cookie, next)).toMatchObject({
            status: 403,
            body: { code: 'two-step', message: 'This needs your second step.' },
        });
        await unchanged();
        // A wrong code, and a step made for another purpose.
        const forPassword = await challenge(cookie, 'password');
        expect(
            await changePassword(cookie, next, {
                token: forPassword.token,
                proof: { kind: 'totp', code: await wrongCode(secret) },
            }),
        ).toMatchObject({ status: 403, body: { code: 'step-wrong' } });
        const forDeletion = await challenge(cookie, 'delete');
        expect(
            await changePassword(cookie, next, {
                token: forDeletion.token,
                proof: { kind: 'totp', code: await appCode(secret) },
            }),
        ).toMatchObject({ status: 403, body: { code: 'step-expired' } });
        // Another session of this account, itself signed in through the step: a step made for
        // that session's password change is not this session's.
        const other = await answer((await toStep(who)).token, { kind: 'backup', code: codes[0]! });
        expect(other.status).toBe(200);
        const theirs = await challenge(other.session!, 'password');
        expect(
            await changePassword(cookie, next, {
                token: theirs.token,
                proof: { kind: 'totp', code: await appCode(secret) },
            }),
        ).toMatchObject({ status: 403, body: { code: 'step-expired' } });
        // Nor is a sign-in's token a step for a change.
        const signIn = await toStep(who);
        expect(
            await changePassword(cookie, next, {
                token: signIn.token,
                proof: { kind: 'totp', code: await appCode(secret) },
            }),
        ).toMatchObject({ status: 403, body: { code: 'step-expired' } });
        await unchanged();
        expect(await edge.call('GET', '/session', undefined, { cookie })).toMatchObject({
            body: { user: { id: who.userId } },
        });

        // The step for this change, from this session, with a right code.
        const changed = await changePassword(cookie, next, {
            token: forPassword.token,
            proof: { kind: 'totp', code: await appCode(secret) },
        });
        expect(changed).toMatchObject({ status: 200, body: { success: true } });
        expect((await edge.signIn(who, { twoStep: true })).status).toBe(401);
        // The new password signs in, and is still asked for the step.
        const after = await edge.signIn(who, { twoStep: true, password: next });
        expect(after.status).toBe(200);
        expect(after.body.twoStep.methods).toContain('totp');
        expect(after.session).toBeUndefined();
    }, 120_000);

    test('deleting the account needs the step, and a refused deletion leaves the account whole', async () => {
        const { who, cookie, codes } = await stepped();
        const remove = async (twoStep?: unknown) => {
            const { proof } = await edge.passwordProof('/delete/start', {}, { cookie });
            return edge.call(
                'POST',
                '/delete/finish',
                { ...proof, ...(twoStep ? { twoStep } : {}) },
                { cookie },
            );
        };
        expect(await remove()).toMatchObject({ status: 403, body: { code: 'two-step' } });
        const step = await challenge(cookie, 'delete');
        expect(
            await remove({ token: step.token, proof: { kind: 'backup', code: 'AAAAA-AAAAA' } }),
        ).toMatchObject({ status: 403, body: { code: 'step-wrong' } });
        expect(await edge.db.select().from(edge.schema.users)).toHaveLength(1);
        expect((await edge.call('GET', '/two-step', undefined, { cookie })).body).toMatchObject({
            on: true,
            backupCodesLeft: 10,
        });
        const logged = vi.spyOn(edge.logging.log, 'error');
        const deleted = await remove({
            token: step.token,
            proof: { kind: 'backup', code: codes[0]! },
        });
        expect(deleted).toMatchObject({ status: 200, body: { success: true }, session: null });
        expect(await edge.db.select().from(edge.schema.users)).toHaveLength(0);
        expect(await edge.authRepository.accountExists(who.email)).toBe(false);
        // Nothing is logged for an account that is gone: a deletion that worked raises no error.
        await edge.quiet();
        expect(logged).not.toHaveBeenCalled();
    }, 90_000);

    test('the step itself changes only with the step: new codes, another app, and turning it off', async () => {
        const { who, cookie, secret, codes, factorId } = await stepped();
        const change = async (method: 'POST' | 'DELETE', path: string, twoStep?: unknown) => {
            const { proof } = await edge.passwordProof('/two-step/reauth', {}, { cookie });
            return edge.call(
                method,
                path,
                { ...proof, ...(twoStep ? { twoStep } : {}) },
                { cookie },
            );
        };
        const refused = { status: 403, body: { code: 'two-step' } };
        expect(await change('POST', '/two-step/backup-codes')).toMatchObject(refused);
        expect(await change('POST', '/two-step/totp')).toMatchObject(refused);
        expect(await change('DELETE', `/two-step/methods/${factorId}`)).toMatchObject(refused);
        expect((await edge.call('GET', '/two-step', undefined, { cookie })).body).toMatchObject({
            on: true,
            backupCodesLeft: 10,
        });

        // New codes, passed with one of the old ones: the old set is gone with it.
        const first = await challenge(cookie, 'two-step');
        const made = await change('POST', '/two-step/backup-codes', {
            token: first.token,
            proof: { kind: 'backup', code: codes[0]! },
        });
        expect(made.status).toBe(200);
        expect(made.body.codes).toHaveLength(10);
        expect(made.body.codes).not.toContain(codes[1]);
        expect(await edge.notices('backup-codes-made')).toHaveLength(1);
        const old = await challenge(cookie, 'two-step');
        expect(
            await change('DELETE', `/two-step/methods/${factorId}`, {
                token: old.token,
                proof: { kind: 'backup', code: codes[1]! },
            }),
        ).toMatchObject({ status: 403, body: { code: 'step-wrong' } });
        expect((await edge.call('GET', '/two-step', undefined, { cookie })).body.on).toBe(true);

        // Turning it off, with the app's own code: its last use and its removal together.
        const off = await change('DELETE', `/two-step/methods/${factorId}`, {
            token: old.token,
            proof: { kind: 'totp', code: await appCode(secret) },
        });
        expect(off).toMatchObject({ status: 200, body: { removed: true, on: false } });
        expect(await edge.notices('two-step-off')).toHaveLength(1);
        expect((await edge.call('GET', '/two-step', undefined, { cookie })).body).toEqual({
            on: false,
            methods: [],
            backupCodesLeft: 0,
            totpFrozen: false,
        });
        // The password alone signs in again, on a client that knows nothing of the step.
        const plain = await edge.signIn(who);
        expect(plain.status).toBe(200);
        expect(plain.session).toBeTruthy();
        expect(await rows.log(who.userId)).toEqual(
            expect.arrayContaining([
                'two-step-on:totp',
                'backup-codes-made:-',
                'backup-code-used:backup',
                'two-step-off:totp',
            ]),
        );
    }, 120_000);

    test('replacing the app answers that it was replaced, with no codes: the new app signs in and the old one no longer does', async () => {
        const { who, cookie, secret, codes } = await stepped();
        const step = await challenge(cookie, 'two-step');
        const { proof } = await edge.passwordProof('/two-step/reauth', {}, { cookie });
        const enrol = await edge.call(
            'POST',
            '/two-step/totp',
            {
                ...proof,
                twoStep: { token: step.token, proof: { kind: 'backup', code: codes[0]! } },
            },
            { cookie },
        );
        expect(enrol.status).toBe(200);
        const confirmed = await edge.call(
            'POST',
            `/two-step/totp/${enrol.body.id}/confirm`,
            { code: await appCode(enrol.body.secret, -1) },
            { cookie },
        );
        // Exactly this: a client takes nothing else without codes for a confirmation.
        expect(confirmed).toMatchObject({ status: 200 });
        expect(confirmed.body).toEqual({ replaced: true });
        const status = (await edge.call('GET', '/two-step', undefined, { cookie })).body;
        expect(status.methods).toMatchObject([{ id: enrol.body.id, kind: 'totp' }]);
        expect(status.backupCodesLeft).toBe(9);
        // The old app's code is a wrong answer now; the new app's passes.
        const asked = await toStep(who);
        expect(
            await answer(asked.token, { kind: 'totp', code: await appCode(secret) }),
        ).toMatchObject({ status: 401, body: { code: 'step-wrong' } });
        expect(
            (await answer(asked.token, { kind: 'totp', code: await appCode(enrol.body.secret) }))
                .status,
        ).toBe(200);
    }, 90_000);

    test('the security log lists what happened, for the account’s own sessions only', async () => {
        const { who, cookie, secret } = await stepped();
        const step = await toStep(who);
        await answer(step.token, { kind: 'totp', code: await wrongCode(secret) });
        const passed = await answer(step.token, { kind: 'totp', code: await appCode(secret) });
        const log = await edge.call('GET', '/security-events', undefined, { cookie });
        expect(log.status).toBe(200);
        expect(
            log.body.events.map((event: { kind: string; method: string | null }) => [
                event.kind,
                event.method,
            ]),
        ).toEqual([
            ['sign-in', 'totp'],
            ['step-failed', 'totp'],
            ['two-step-on', 'totp'],
        ]);
        expect(log.body.events[0]).toMatchObject({
            deviceId: passed.body.device.id,
            deviceKind: null,
        });
        expect(JSON.stringify(log.body)).not.toContain(who.email);
        // Another account's sessions see their own, and no session sees none.
        const other = await signedIn();
        expect(
            (await edge.call('GET', '/security-events', undefined, { cookie: other.cookie })).body,
        ).toEqual({
            events: [],
        });
        expect((await edge.call('GET', '/security-events')).status).toBe(401);
    }, 60_000);
});

/* A recovery-key rotation as the client sends it: the password proved, a new record, a new recovery envelope. */
async function rotateRecoveryKey(who: Account, cookie: string, twoStep: unknown, versions = 1) {
    const registration = client.startRegistration({ password: 'correct horse battery staple' });
    const { challenge: started, proof } = await edge.passwordProof(
        '/security/start',
        { action: 'recovery-key', registrationRequest: registration.registrationRequest },
        { cookie },
    );
    const { registrationRecord } = client.finishRegistration({
        password: 'correct horse battery staple',
        clientRegistrationState: registration.clientRegistrationState,
        registrationResponse: started.registrationResponse,
        identifiers: OPAQUE_IDENTIFIERS,
        keyStretching: KEY_STRETCHING,
    });
    const made = await createRecovery(
        new Uint8Array(randomBytes(32)),
        who.userId,
        started.recovery.recoveryVersion + versions,
        started.envelope.keyVersion,
    );
    const reply = await edge.call(
        'POST',
        '/security/finish',
        {
            action: 'recovery-key',
            ...proof,
            registrationRecord,
            envelope: {
                envelopeVersion: 1,
                keyVersion: started.envelope.keyVersion,
                credentialVersion: started.envelope.credentialVersion + 1,
                wrappingSalt: b64(32),
                wrappingNonce: b64(24),
                encryptedKey: b64(48),
            },
            recovery: made.recovery,
            twoStep,
        },
        { cookie },
    );
    return { reply, phrase: made.phrase };
}

describe('the recovery phrase and the step', () => {
    test('after the recovery key is rotated, the old phrase no longer passes the step and the new one does', async () => {
        const { who, cookie, secret, deviceId } = await stepped();
        // Nine codes already charged to this device's budget of ten, as nine wrong ones leave it.
        const budget = edge.sha256(`auth:two-step:codes:device:${deviceId}`);
        for (let used = 0; used < 9; used++)
            expect(await edge.authRepository.consumeRateLimit(budget, 10, 15 * 60_000)).toBe(true);
        // A right code with a recovery envelope the server will not take (it skips a version):
        // the change stops for its own reason, nothing is rotated, and the code is not charged.
        const first = await challenge(cookie, 'recovery-key');
        const malformed = await rotateRecoveryKey(
            who,
            cookie,
            { token: first.token, proof: { kind: 'totp', code: await appCode(secret) } },
            2,
        );
        expect(malformed.reply.status).toBe(400);
        // So the tenth place is still there for the real one, with the same unspent code.
        const step = await challenge(cookie, 'recovery-key');
        const rotated = await rotateRecoveryKey(who, cookie, {
            token: step.token,
            proof: { kind: 'totp', code: await appCode(secret) },
        });
        expect(rotated.reply).toMatchObject({ status: 200, body: { success: true } });

        const asked = await toStep(who);
        expect(asked.phrase.recoveryVersion).toBe(2);
        // The phrase from before, signed as a device would with what this step carries.
        expect(await answer(asked.token, await edge.phraseProof(who.phrase, asked))).toMatchObject({
            status: 401,
            body: { code: 'step-wrong' },
        });
        expect(await rows.sessions()).toHaveLength(0);
        const passed = await answer(asked.token, await edge.phraseProof(rotated.phrase, asked));
        expect(passed.status).toBe(200);
        expect(passed.session).toBeTruthy();
    }, 90_000);

    test('the step is not turned on for an account without a recovery key, and none can be added from a session once it is on', async () => {
        const recoveryRows = async () =>
            (await edge.db.select().from(edge.schema.accountRecoveryKeys)).map((row) => row.userId);
        const envelope = async (userId: string) =>
            (await createRecovery(new Uint8Array(randomBytes(32)), userId)).recovery;
        // An account whose setup never stored a recovery key.
        const bare = await signedIn();
        await edge.db.$client.query('delete from account_recovery_keys where user_id = $1', [
            bare.who.userId,
        ]);
        const unfinished = {
            status: 409,
            body: { code: 'setup-required', message: 'Finish setting up your account first.' },
        };
        const { proof } = await edge.passwordProof('/two-step/reauth', {}, { cookie: bare.cookie });
        expect(
            await edge.call('POST', '/two-step/totp', proof, { cookie: bare.cookie }),
        ).toMatchObject(unfinished);
        expect(await edge.db.select().from(edge.schema.twoStepFactors)).toHaveLength(0);
        // Without the step, account setup stores the key as it always has; then the step can be set up.
        expect(
            await edge.call(
                'POST',
                '/setup',
                { recovery: await envelope(bare.who.userId) },
                { cookie: bare.cookie },
            ),
        ).toMatchObject({ status: 200, body: { ok: true } });
        expect(await recoveryRows()).toEqual([bare.who.userId]);

        // A pending app, and the key gone before it is confirmed: confirming is refused too.
        const late = await signedIn();
        const started = await edge.passwordProof('/two-step/reauth', {}, { cookie: late.cookie });
        const enrol = await edge.call('POST', '/two-step/totp', started.proof, {
            cookie: late.cookie,
        });
        expect(enrol.status).toBe(200);
        await edge.db.$client.query('delete from account_recovery_keys where user_id = $1', [
            late.who.userId,
        ]);
        expect(
            await edge.call(
                'POST',
                `/two-step/totp/${enrol.body.id}/confirm`,
                { code: await appCode(enrol.body.secret) },
                { cookie: late.cookie },
            ),
        ).toMatchObject(unfinished);
        expect(
            (await edge.call('GET', '/two-step', undefined, { cookie: late.cookie })).body.on,
        ).toBe(false);

        // The step on, and no recovery key (as only an account from before this rule could be):
        // a session alone cannot give it one, or that phrase would pass a step nobody passed.
        const on = await stepped();
        await edge.db.$client.query('delete from account_recovery_keys where user_id = $1', [
            on.who.userId,
        ]);
        expect(
            await edge.call(
                'POST',
                '/setup',
                { recovery: await envelope(on.who.userId) },
                { cookie: on.cookie },
            ),
        ).toMatchObject({ status: 200, body: { ok: true } });
        expect(await recoveryRows()).toEqual([bare.who.userId]);
        const asked = await edge.signIn(on.who, { twoStep: true });
        expect(asked.body.twoStep.methods).toEqual(['totp', 'backup']);
        expect(asked.body.twoStep.phrase).toBeUndefined();
    }, 120_000);
});

describe('what the server does about its own faults', () => {
    test('a row under a key this server no longer has is the server’s fault: 503, nothing counted or used up, and the log names the key', async () => {
        const { who, secret, codes, factorId } = await stepped();
        // The operator's log as it is emitted, after redaction: what names the key must survive it.
        const named = () =>
            edge.emitted
                .filter((event) => String(event.message).startsWith('A two-step row names a key'))
                .map((event) => event.twoStep);
        const limits = async () => (await edge.db.select().from(edge.schema.authRateLimits)).length;
        const lost = randomBytes(8);
        await edge.db.$client.query('update two_step_factors set totp_key_id = $1 where id = $2', [
            lost,
            factorId,
        ]);
        const step = await toStep(who);
        const charged = await limits();
        const unavailable = {
            status: 503,
            body: {
                // The server's own 503, told from a proxy's by its code.
                code: 'step-unavailable',
                message:
                    'Two-step sign-in is unavailable on this server right now. Use your recovery phrase, or try again later.',
            },
        };
        expect(
            await answer(step.token, { kind: 'totp', code: await appCode(secret) }),
        ).toMatchObject(unavailable);
        // A right code and a wrong one get the same answer: neither was looked at.
        expect(
            await answer(step.token, { kind: 'totp', code: await wrongCode(secret) }),
        ).toMatchObject(unavailable);
        expect(named()).toEqual([
            { row: 'totp', sealedWith: lost.toString('hex') },
            { row: 'totp', sealedWith: lost.toString('hex') },
        ]);
        // Nothing was counted, the token has all five answers, and the budget is as it was.
        expect((await rows.state(who.userId)).consecutiveFailures).toBe(0);
        expect(await edge.db.select().from(edge.schema.twoStepAttempts)).toMatchObject([
            { answers: 0, failures: 0 },
        ]);
        expect(await limits()).toBe(charged);
        expect(
            (await rows.log(who.userId)).filter((line) => line.startsWith('step-failed')),
        ).toEqual([]);

        // The backup codes, hashed under a key that is gone, the same.
        const gone = randomBytes(8);
        await edge.db.$client.query(
            'update two_step_backup_codes set key_id = $1 where user_id = $2',
            [gone, who.userId],
        );
        expect(await answer(step.token, { kind: 'backup', code: codes[0]! })).toMatchObject(
            unavailable,
        );
        expect(named().at(-1)).toEqual({ row: 'backup-codes', sealedWith: gone.toString('hex') });
        expect((await rows.state(who.userId)).consecutiveFailures).toBe(0);
        // The phrase needs no key of the server's, and still passes on the same token.
        expect((await answer(step.token, await edge.phraseProof(who.phrase, step))).status).toBe(
            200,
        );
    }, 90_000);

    test('a backup-code set only partly under a lost key is still checked: its other codes pass, and a code that matches none is a wrong answer', async () => {
        const { who, codes } = await stepped();
        // Five of the ten under a key that is gone.
        await edge.db.$client.query(
            `update two_step_backup_codes set key_id = $1 where user_id = $2 and code_hash in
                 (select code_hash from two_step_backup_codes where user_id = $2 order by code_hash limit 5)`,
            [randomBytes(8), who.userId],
        );
        const tryCode = async (code: string, from: number) => {
            edge.state.address = `198.51.100.${from}`;
            return answer((await toStep(who)).token, { kind: 'backup', code });
        };
        // A code that is none of the ten was compared with the five the server can read: wrong,
        // and counted, not "unavailable" for as long as the lost key stays lost.
        expect(await tryCode('AAAAA-AAAAA', 1)).toMatchObject({
            status: 401,
            body: { code: 'step-wrong' },
        });
        expect((await rows.state(who.userId)).consecutiveFailures).toBe(1);
        // The five under the known key sign in. One under the lost key cannot be told from a
        // wrong code while any readable code is left to compare it with; once those are all
        // used, nothing can be compared, and that is the server's fault again.
        let passed = 0;
        for (const [index, code] of codes.entries()) {
            const reply = await tryCode(code, index + 2);
            if (reply.status === 200) passed++;
            else expect(reply.status, `after ${passed} passed`).toBe(passed < 5 ? 401 : 503);
        }
        expect(passed).toBe(5);
    }, 120_000);

    test('a sign-in that passed stays passed when handing its budget back fails', async () => {
        const { who, secret } = await stepped();
        const step = await toStep(who);
        const logged = vi.spyOn(edge.logging.log, 'error');
        const { rows: before } = await edge.db.$client.query('select count from auth_rate_limits');
        // The database refuses the one statement that hands the budget back.
        await edge.db.$client.query(
            `create or replace function refuse_release() returns trigger language plpgsql as $$
             begin raise exception 'no release'; end $$`,
        );
        await edge.db.$client.query(
            'create trigger refuse_release before delete on auth_rate_limits for each row execute function refuse_release()',
        );
        try {
            const passed = await answer(step.token, { kind: 'totp', code: await appCode(secret) });
            expect(passed.status).toBe(200);
            expect(passed.session).toBeTruthy();
            expect(passed.body.user.id).toBe(who.userId);
        } finally {
            await edge.db.$client.query('drop trigger refuse_release on auth_rate_limits');
            await edge.db.$client.query('drop function refuse_release()');
        }
        expect(before.length).toBeGreaterThan(0);
        expect(logged).toHaveBeenCalledWith(
            expect.objectContaining({ twoStep: expect.objectContaining({ what: 'release' }) }),
        );
    }, 60_000);
});

describe('what the account hears and keeps of wrong answers', () => {
    test('a failed sign-in and a failed change are told apart: only the first can say nobody got in', async () => {
        const { who, cookie } = await stepped();
        const wrong = { kind: 'backup', code: 'AAAAA-AAAAA' };
        // Five wrong answers at sign-in.
        const signIn = await toStep(who);
        for (let index = 0; index < 5; index++) await answer(signIn.token, wrong);
        const [atSignIn] = await edge.notices('step-failed');
        expect(atSignIn).toMatchObject({
            to: who.email,
            subject: expect.stringMatching(
                /^Someone signed in with your password but did not pass the second step · .* UTC · HushOS$/,
            ),
        });
        expect(atSignIn!.text).toContain('Nobody got in.');
        expect(atSignIn!.text).toContain('If this wasn’t you, change your password.');
        await edge.quiet();
        expect(edge.outbox.filter((notice) => notice.kind === 'change-step-failed')).toEqual([]);

        // Five wrong answers from a session that is signed in, at a password change.
        const step = await challenge(cookie, 'password');
        for (let index = 0; index < 5; index++)
            expect(
                (
                    await changePassword(cookie, 'another password', {
                        token: step.token,
                        proof: wrong,
                    })
                ).status,
            ).toBe(403);
        const [atChange] = await edge.notices('change-step-failed');
        expect(atChange).toMatchObject({
            to: who.email,
            subject: expect.stringMatching(
                /^Someone tried to change your account and did not pass the second step · .* UTC · HushOS$/,
            ),
        });
        expect(atChange!.text).toContain(
            'Someone signed in to your account tried to change it and did not pass the second step.',
        );
        expect(atChange!.text).toContain(
            'If this wasn’t you, check your devices and change your password.',
        );
        // Whoever failed there is signed in: this notice must not say otherwise.
        expect(atChange!.text).not.toContain('Nobody got in');
        expect(edge.outbox.filter((notice) => notice.kind === 'step-failed')).toHaveLength(1);
    }, 120_000);

    test('wrong answers cannot bury the security log: ten lines an hour, however many there are', async () => {
        const { who } = await stepped();
        const garbage = { kind: 'phrase', signature: b64(64) };
        for (let token = 0; token < 3; token++) {
            edge.state.address = `198.51.100.${token + 1}`;
            const step = await toStep(who);
            for (let index = 0; index < 5; index++) await answer(step.token, garbage);
        }
        // All fifteen were counted; ten were written down.
        expect((await rows.state(who.userId)).consecutiveFailures).toBe(15);
        const log = await rows.log(who.userId);
        expect(log.filter((line) => line === 'step-failed:phrase')).toHaveLength(10);
        expect(log).toContain('two-step-on:totp');
    }, 90_000);
});

describe('a spent code budget', () => {
    test('takes nothing from the token: after four wrong answers and a refused code, the phrase still signs in', async () => {
        const { who, secret } = await stepped();
        // Ten wrong codes on two tokens: the 15-minute budget is spent.
        for (let token = 0; token < 2; token++) {
            edge.state.address = `198.51.100.${token + 1}`;
            const spent = await toStep(who);
            for (let index = 0; index < 5; index++)
                expect(
                    (await answer(spent.token, { kind: 'totp', code: await wrongCode(secret) }))
                        .status,
                ).toBe(401);
        }
        // A new token, with four of its five answers used on wrong phrases.
        edge.state.address = '198.51.100.3';
        const step = await toStep(who);
        for (let index = 0; index < 4; index++)
            expect(await answer(step.token, { kind: 'phrase', signature: b64(64) })).toMatchObject({
                status: 401,
                body: { code: 'step-wrong' },
            });
        // A code now, even the right one, is refused unchecked, and told what still works.
        expect(
            await answer(step.token, { kind: 'totp', code: await appCode(secret) }),
        ).toMatchObject({
            status: 429,
            body: {
                code: 'step-limited',
                message:
                    'Too many wrong codes. Try again in 15 minutes, or use your recovery phrase.',
            },
        });
        expect(await edge.db.select().from(edge.schema.twoStepAttempts)).toMatchObject([
            { answers: 4, failures: 4 },
        ]);
        // So the phrase must: the refusal did not take the token's last answer.
        const passed = await answer(step.token, await edge.phraseProof(who.phrase, step));
        expect(passed.status).toBe(200);
        expect(passed.session).toBeTruthy();
    }, 120_000);
});

describe('the session of the device that made a security change', () => {
    const next = 'a new password entirely';
    const code = async (cookie: string, secret: string) => ({
        token: (await challenge(cookie, 'password')).token,
        proof: { kind: 'totp', code: await appCode(secret) },
    });

    test('is written with the change when the client asks and the step passed: capped, on the same device, and the sign-in that follows needs no second code', async () => {
        const { who, cookie, secret, deviceId } = await stepped();
        const changed = await changePassword(cookie, next, await code(cookie, secret), {
            keepSession: 1,
        });
        expect(changed).toMatchObject({ status: 200, body: { success: true } });
        // The token is the cookie and nowhere in the reply.
        expect(changed.session).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(JSON.stringify(changed.body)).not.toContain(changed.session!);
        const [kept, ...others] = await rows.sessions();
        expect(others).toEqual([]);
        expect(kept).toMatchObject({ userId: who.userId, deviceId, credentialVersion: 2 });
        expect(kept!.tokenHash.equals(edge.sha256(changed.session!))).toBe(true);
        expect(kept!.twoStepAt).toBeInstanceOf(Date);
        // Ten minutes at most, however long an ordinary session lasts.
        expect(kept!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
        expect(kept!.expiresAt.getTime()).toBeGreaterThan(Date.now());

        // The device signs in with the new password. The code it just used is spent, and it
        // is not asked for another: the session it replaces passed the step a moment ago.
        const back = await edge.signIn(who, {
            cookie: changed.session,
            twoStep: true,
            password: next,
        });
        expect(back.status).toBe(200);
        expect(back.body.twoStep).toBeUndefined();
        expect(back.body.user.id).toBe(who.userId);
        expect(back.body.device.id).toBe(deviceId);
        expect(await rows.sessions()).toHaveLength(1);
        // Anyone without that cookie is asked for the step, new password or not.
        const stranger = await edge.signIn(who, { twoStep: true, password: next });
        expect(stranger.body.twoStep).toBeDefined();
        expect(stranger.session).toBeUndefined();
    }, 90_000);

    test('lasts its ten minutes and no longer, however much its cookie is used', async () => {
        const { who, cookie, secret } = await stepped();
        const changed = await changePassword(cookie, next, await code(cookie, secret), {
            keepSession: 1,
        });
        const kept = changed.session!;
        const session = () => edge.call('GET', '/session', undefined, { cookie: kept });
        const start = Date.now();
        expect((await session()).body.user.id).toBe(who.userId);
        // Minute six: used, which slides an ordinary session's deadline by days.
        vi.setSystemTime(start + 6 * 60_000);
        expect((await session()).body.user.id).toBe(who.userId);
        const [row] = await rows.sessions();
        expect(row!.expiresAt.getTime()).toBeLessThanOrEqual(start + 10 * 60_000);
        // Minute eleven: gone.
        vi.setSystemTime(start + 11 * 60_000);
        expect((await session()).body.user).toBeNull();
    }, 90_000);

    test('is not written for a client that did not ask, for a change the step refused, or for an account without the step', async () => {
        // The phone apps and older bundles: today's reply, every session ended, the cookie cleared.
        const quiet = await stepped();
        const plain = await changePassword(
            quiet.cookie,
            next,
            await code(quiet.cookie, quiet.secret),
        );
        expect(plain).toMatchObject({ status: 200, session: null });
        expect(await rows.sessions()).toHaveLength(0);

        // Asked for, with a wrong code: nothing changes and nothing is minted.
        const refused = await stepped();
        const wrong = await changePassword(
            refused.cookie,
            next,
            {
                token: (await challenge(refused.cookie, 'password')).token,
                proof: { kind: 'totp', code: await wrongCode(refused.secret) },
            },
            { keepSession: 1 },
        );
        expect(wrong).toMatchObject({ status: 403, body: { code: 'step-wrong' } });
        expect(wrong.session).toBeUndefined();
        expect((await rows.sessions()).map((row) => row.credentialVersion)).toEqual([1]);

        // No step on the account: asking changes nothing about today's password change.
        await edge.resetDatabase();
        const without = await signedIn();
        const today = await changePassword(without.cookie, next, undefined, { keepSession: 1 });
        expect(today).toMatchObject({ status: 200, body: { success: true }, session: null });
        expect(await rows.sessions()).toHaveLength(0);
    }, 120_000);
});
