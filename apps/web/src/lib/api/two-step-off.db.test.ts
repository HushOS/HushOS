import { randomBytes, randomUUID } from 'node:crypto';
import { KEY_STRETCHING, OPAQUE_IDENTIFIERS } from '@hushos/crypto';
import { client } from '@hushos/crypto/server';
import {
    base32,
    deriveTwoStepKey,
    generateTotpSecret,
    sealTotpSecret,
} from '@hushos/crypto/two-step/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { appCode, loadEdge, type Account, type Edge } from '@/test/auth-edge.server';

/*
 * TWO_STEP_ENABLED off, which is how every instance runs until the apps that answer the step
 * are out (docs/two-step-design.md 6, 8), through the HTTP edge, real OPAQUE and Postgres.
 * Two things must hold. An account without the step meets exactly today's sign-in, password
 * change and deletion: the same replies, the same cookies, nothing new stored. And the flag
 * only decides who may turn the step on: an account that already has it is still asked.
 */

let edge: Edge;
const b64 = (bytes: number) => randomBytes(bytes).toString('base64url');

beforeAll(async () => {
    // Nothing set: the default is what is under test.
    vi.stubEnv('TWO_STEP_ENABLED', '');
    edge = await loadEdge();
});
beforeEach(async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    await edge.resetDatabase();
    edge.outbox.length = 0;
});
afterEach(() => {
    vi.useRealTimers();
});
afterAll(() => edge.closeDatabase());

async function signedIn() {
    const who = await edge.account();
    const first = await edge.signIn(who);
    expect(first.status).toBe(200);
    return { who, cookie: first.session!, deviceId: first.body.device.id as string };
}

async function changePassword(cookie: string, to: string) {
    const registration = client.startRegistration({ password: to });
    const { challenge, proof } = await edge.passwordProof(
        '/security/start',
        { action: 'password', registrationRequest: registration.registrationRequest },
        { cookie },
    );
    const { registrationRecord } = client.finishRegistration({
        password: to,
        clientRegistrationState: registration.clientRegistrationState,
        registrationResponse: challenge.registrationResponse,
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
                keyVersion: challenge.envelope.keyVersion,
                credentialVersion: challenge.envelope.credentialVersion + 1,
                wrappingSalt: b64(32),
                wrappingNonce: b64(24),
                encryptedKey: b64(48),
            },
        },
        { cookie },
    );
}

/* Every table two-step sign-in writes, counted: nothing of it may appear for an account without the step. */
async function twoStepRows() {
    const { schema, db } = edge;
    const counts: Record<string, number> = {};
    for (const [name, table] of Object.entries({
        factors: schema.twoStepFactors,
        codes: schema.twoStepBackupCodes,
        attempts: schema.twoStepAttempts,
        state: schema.twoStepState,
        log: schema.accountSecurityEvents,
    }))
        counts[name] = (await db.select().from(table)).length;
    return counts;
}
const NOTHING = { factors: 0, codes: 0, attempts: 0, state: 0, log: 0 };

/*
 * An account that turned the step on while the flag was on: its app's secret sealed under this
 * server's own key, as the server seals it, written through the repository.
 */
async function withStep(who: Account, cookie: string) {
    const key = await deriveTwoStepKey(
        new Uint8Array(Buffer.from(process.env.OPAQUE_SERVER_SETUP!, 'base64url')),
    );
    const secret = generateTotpSecret();
    const id = randomUUID();
    const sealed = await sealTotpSecret({ secret, key, userId: who.userId, factorId: id });
    await edge.twoStepRepository.startTotpFactor({
        id,
        userId: who.userId,
        keyId: Buffer.from(sealed.keyId),
        nonce: Buffer.from(sealed.nonce),
        sealedSecret: Buffer.from(sealed.sealed),
    });
    const confirmed = await edge.twoStepRepository.confirmTotpFactor({
        userId: who.userId,
        factorId: id,
        step: 1_000,
        sessionTokenHash: edge.sha256(cookie),
        credentialVersion: 1,
        backupCodes: {
            keyId: Buffer.from(sealed.keyId),
            hashes: Array.from({ length: 10 }, () => randomBytes(32)),
        },
    });
    expect(confirmed.status).toBe('ok');
    return { id, secret: base32(secret) };
}

describe('with TWO_STEP_ENABLED off', () => {
    test('nobody can turn the step on or manage it: every such route answers 501', async () => {
        const { cookie } = await signedIn();
        const off = {
            status: 501,
            body: { message: 'Two-step sign-in isn’t available on this server.' },
        };
        const change = { attemptToken: b64(32), finishLoginRequest: b64(64) };
        const id = randomUUID();
        for (const [method, path, body] of [
            ['GET', '/two-step', undefined],
            ['POST', '/two-step/reauth', { startLoginRequest: b64(64) }],
            ['POST', '/two-step/totp', change],
            ['POST', `/two-step/totp/${id}/confirm`, { code: '123456' }],
            ['DELETE', `/two-step/methods/${id}`, change],
            ['POST', '/two-step/backup-codes', change],
            ['GET', '/security-events', undefined],
        ] as const)
            expect(
                await edge.call(method, path, body, { cookie }),
                `${method} ${path}`,
            ).toMatchObject(off);
        expect(await twoStepRows()).toEqual(NOTHING);
        // An account without the step has no step to be challenged for.
        expect(
            (await edge.call('POST', '/two-step/challenge', { purpose: 'password' }, { cookie }))
                .status,
        ).toBe(409);
    }, 60_000);

    test('an account without the step signs in, changes its password and is deleted exactly as before', async () => {
        const who = await edge.account();
        // Sign-in: the reply and the cookie, whether or not the client says it could answer a step.
        const first = await edge.signIn(who);
        expect(first.status).toBe(200);
        expect(Object.keys(first.body).sort()).toEqual(['device', 'envelope', 'user']);
        expect(first.body.device).toEqual({
            id: expect.any(String),
            attached: false,
            registered: false,
        });
        expect(first.session).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const capable = await edge.signIn(who, { twoStep: true });
        expect(capable.status).toBe(200);
        expect(Object.keys(capable.body).sort()).toEqual(['device', 'envelope', 'user']);
        expect(capable.session).toBeTruthy();
        // The first sign-in after sign-up is the account's own device; the second is a new one,
        // and its notice reads as it always has.
        expect(await edge.notices('new-device')).toEqual([
            { to: who.email, kind: 'new-device', count: undefined, method: undefined },
        ]);
        // The web's unlock: the same device, a new cookie.
        const unlocked = await edge.signIn(who, { cookie: first.session });
        expect(unlocked.body.device).toMatchObject({ id: first.body.device.id, attached: true });
        const stored = await edge.db.select().from(edge.schema.sessions);
        expect(stored).toHaveLength(2);
        expect(stored.every((row) => row.twoStepAt === null)).toBe(true);

        // A password change: no step asked, every session ended, the new password signs in.
        const cookie = unlocked.session!;
        const changed = await changePassword(cookie, 'a new password entirely');
        expect(changed).toEqual({ status: 200, body: { success: true }, session: null });
        expect(await edge.db.select().from(edge.schema.sessions)).toHaveLength(0);
        expect((await edge.signIn(who)).status).toBe(401);
        const again = await edge.signIn(who, { password: 'a new password entirely' });
        expect(again.status).toBe(200);

        // Deletion: the password again, and the account is gone.
        const { proof } = await edge.passwordProof(
            '/delete/start',
            {},
            { cookie: again.session, password: 'a new password entirely' },
        );
        expect(await edge.call('POST', '/delete/finish', proof, { cookie: again.session })).toEqual(
            {
                status: 200,
                body: { success: true },
                session: null,
            },
        );
        expect(await edge.db.select().from(edge.schema.users)).toHaveLength(0);
        // None of it wrote a row of two-step sign-in, or a line of its log.
        expect(await twoStepRows()).toEqual(NOTHING);
    }, 120_000);

    test('an account that already has the step is still asked for it, at sign-in and at a change', async () => {
        const { who, cookie } = await signedIn();
        const { secret } = await withStep(who, cookie);
        const sessions = (await edge.db.select().from(edge.schema.sessions)).length;

        expect(await edge.signIn(who)).toMatchObject({
            status: 409,
            body: { code: 'update-required' },
        });
        const asked = await edge.signIn(who, { twoStep: true });
        expect(asked.status).toBe(200);
        expect(asked.session).toBeUndefined();
        expect(asked.body.twoStep.methods).toEqual(['totp', 'backup', 'phrase']);
        expect(await edge.db.select().from(edge.schema.sessions)).toHaveLength(sessions);
        // A change from its live session: refused without the step.
        expect(await changePassword(cookie, 'a new password entirely')).toMatchObject({
            status: 403,
            body: { code: 'two-step' },
        });
        expect(
            (await edge.signIn(who, { twoStep: true, password: 'a new password entirely' })).status,
        ).toBe(401);
        // The step itself still works: the sign-in above, answered with the app's code.
        const passed = await edge.call('POST', '/login/two-step', {
            token: asked.body.twoStep.token,
            proof: { kind: 'totp', code: await appCode(secret) },
        });
        expect(passed.status).toBe(200);
        expect(passed.session).toBeTruthy();
        // But nothing about the step can be seen or changed while the flag is off.
        expect(
            (await edge.call('GET', '/two-step', undefined, { cookie: passed.session })).status,
        ).toBe(501);
    }, 120_000);
});
