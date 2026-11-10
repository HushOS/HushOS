import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { OPAQUE_IDENTIFIERS } from '@hushos/crypto';
import { client } from '@hushos/crypto/server';
import { captureMail, startApi, steadyClock, type Harness } from '@/test/two-step-api.server';

/*
 * TWO_STEP_ENABLED off, as it ships (docs/two-step-design.md 8): nobody can
 * turn the step on, and the routes that set it up or change it answer 501. An
 * account that already has a method is still held to it, at sign-in and at
 * every change the step guards: turning the flag off must never be a way to
 * take someone's second step away.
 */

let api: Harness;

beforeAll(async () => {
    // Nothing set: the default is off.
    api = await startApi();
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

const b64 = (bytes: number) => randomBytes(bytes).toString('base64url');
const UNSUPPORTED = {
    message: 'This server does not offer two-step sign-in yet.',
    code: 'unsupported',
};

describe('with two-step sign-in off', () => {
    test('every route that sets the step up or changes it answers 501, signed in or not', async () => {
        const who = await api.account();
        const { cookie } = await api.signIn(who);
        const proof = { attemptToken: b64(32), finishLoginRequest: b64(64) };
        const id = randomUUID();
        const routes: [method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown][] =
            [
                ['GET', '/two-step'],
                ['POST', '/two-step/reauth', { startLoginRequest: b64(32) }],
                ['POST', '/two-step/totp', proof],
                ['POST', `/two-step/totp/${id}/confirm`, { code: '123456' }],
                ['PUT', `/two-step/methods/${id}`, { name: 'Phone' }],
                ['DELETE', `/two-step/methods/${id}`, proof],
                ['POST', '/two-step/backup-codes', proof],
            ];
        for (const as of [cookie, null])
            for (const [method, path, body] of routes) {
                const reply = await api.call(method, path, body, { cookie: as });
                expect(reply.status, `${method} ${path}`).toBe(501);
                expect(reply.body, `${method} ${path}`).toEqual(UNSUPPORTED);
            }
    });

    test('an account cannot enrol: the password proved, the app is still refused and nothing is stored', async () => {
        const who = await api.account();
        const { cookie } = await api.signIn(who);
        // The password exchange cannot even start for this purpose.
        const start = client.startLogin({ password: who.password });
        expect(
            (
                await api.call(
                    'POST',
                    '/two-step/reauth',
                    { startLoginRequest: start.startLoginRequest },
                    { cookie },
                )
            ).status,
        ).toBe(501);
        // Nor does a proof made for another purpose get an app started.
        const other = await api.prove(who, '/devices/reauth', { cookie });
        const reply = await api.call(
            'POST',
            '/two-step/totp',
            { attemptToken: other.attemptToken, finishLoginRequest: other.finishLoginRequest },
            { cookie },
        );
        expect(reply.status).toBe(501);
        expect(await api.rows.factorRows()).toEqual([]);
        expect((await api.twoStepRepository.getTwoStep(who.id)).on).toBe(false);
        // And the account signs in on its password, as before.
        expect((await api.signIn(who, { old: true })).body.envelope).toBeDefined();
    });

    test('an account that already has a method is still asked for it at sign-in', async () => {
        const who = await api.account();
        const app = await api.enrol(who.id);

        const asked = await api.signIn(who);
        expect(asked.status).toBe(200);
        expect(Object.keys(asked.body)).toEqual(['twoStep']);
        expect(asked.cookie).toBeNull();
        expect(await api.rows.sessionRows()).toEqual([]);
        // A client that cannot answer is told to update, not let in.
        const old = await api.signIn(who, { old: true });
        expect(old.status).toBe(409);
        expect(old.body.code).toBe('update-required');
        expect(await api.rows.sessionRows()).toEqual([]);

        const wrong = await api.call('POST', '/login/two-step', {
            token: asked.body.twoStep.token,
            proof: { kind: 'backup', code: '00000-00000' },
        });
        expect(wrong.status).toBe(401);
        const done = await api.call('POST', '/login/two-step', {
            token: asked.body.twoStep.token,
            proof: { kind: 'totp', code: await app.code() },
        });
        expect(done.status).toBe(200);
        expect(done.body.envelope).toBeDefined();
        // The reply says this server lets nobody change their step, so a client suggests
        // nothing it could not do; after a backup code it still says how many are left.
        expect(done.body.twoStep).toEqual({ offered: false });
        const again = await api.signIn(who);
        const byCode = await api.call('POST', '/login/two-step', {
            token: again.body.twoStep.token,
            proof: { kind: 'backup', code: app.backupCodes[0] },
        });
        expect(byCode.body.twoStep).toEqual({ offered: false, backupCodesLeft: 9 });
    });

    test('a step token is still answered, and an account without the step is told it has none', async () => {
        const plain = await api.account();
        const { cookie } = await api.signIn(plain);
        const none = await api.call(
            'POST',
            '/two-step/challenge',
            { purpose: 'password' },
            { cookie },
        );
        expect([none.status, none.body]).toEqual([200, { on: false }]);
    });

    test('and at the changes the step guards, which it can still answer', async () => {
        const who = await api.account();
        const app = await api.enrol(who.id);
        const asked = await api.signIn(who);
        const { cookie } = await api.call('POST', '/login/two-step', {
            token: asked.body.twoStep.token,
            proof: { kind: 'totp', code: await app.code() },
        });
        const change = async (twoStep?: unknown) => {
            const registration = client.startRegistration({ password: 'a new password' });
            const proof = await api.prove(who, '/security/start', {
                cookie,
                extra: {
                    action: 'password',
                    registrationRequest: registration.registrationRequest,
                },
            });
            const { registrationRecord } = client.finishRegistration({
                password: 'a new password',
                registrationResponse: proof.challenge.registrationResponse,
                clientRegistrationState: registration.clientRegistrationState,
                identifiers: OPAQUE_IDENTIFIERS,
            });
            return api.call(
                'POST',
                '/security/finish',
                {
                    action: 'password',
                    attemptToken: proof.attemptToken,
                    finishLoginRequest: proof.finishLoginRequest,
                    registrationRecord,
                    envelope: {
                        envelopeVersion: 1,
                        keyVersion: proof.challenge.envelope.keyVersion,
                        credentialVersion: proof.challenge.envelope.credentialVersion + 1,
                        wrappingSalt: b64(32),
                        wrappingNonce: b64(24),
                        encryptedKey: b64(48),
                    },
                    ...(twoStep ? { twoStep } : {}),
                },
                { cookie },
            );
        };
        const without = await change();
        expect(without.status).toBe(403);
        expect(without.body.code).toBe('two-step');

        // The challenge is not behind the flag: without it this account could never
        // change its password or delete itself while the flag is off.
        const token = await api.call(
            'POST',
            '/two-step/challenge',
            { purpose: 'password' },
            { cookie },
        );
        expect(token.status).toBe(200);
        const changed = await change({
            token: token.body.token,
            proof: { kind: 'backup', code: app.backupCodes[0] },
        });
        expect(changed.status).toBe(200);
        // The asking device carries on in the session opened with the change; no other is left.
        expect((await api.rows.sessionRows()).map((row) => row.tokenHash)).toEqual([
            api.sha256(changed.cookie as string),
        ]);
    });
});
