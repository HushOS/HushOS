import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { KEY_STRETCHING, OPAQUE_IDENTIFIERS, OPAQUE_PROFILE_VERSION } from '@hushos/crypto';
import { client, ready, server } from '@hushos/crypto/server';
import {
    deriveTwoStepKey,
    generateTotpSecret,
    sealTotpSecret,
    totpCode,
    totpStep,
} from '@hushos/crypto/two-step/server';
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * Deleting an account that has two-step sign-in on, against the test database with a real
 * OPAQUE exchange. The route stops whatever is billed to the account before the account goes
 * (`beforeDelete`: the web app revokes the plan and deletes the customer at the payment
 * provider there). An account with the step on is deleted only with its second step: a
 * missing or wrong answer must be refused before billing is touched, or the account would
 * survive with its plan destroyed.
 */
await ready;
process.env.APP_ORIGIN = 'https://hush.example';
process.env.OPAQUE_SERVER_SETUP = server.createSetup();
process.env.EMAIL_ADAPTER = 'log';
process.env.EMAIL_FROM = 'HushOS <hushos@hushos.test>';

const { closeDatabase, resetDatabase } = await import('../../db/test/helpers');
const { registration } = await import('../../db/test/accounts');
const { authRepository, db, twoStepRepository } = await import('@hushos/db');
const { accountDevices, users } = await import('@hushos/db/schema');
const auth = await import('./server');

const PASSWORD = 'correct horse battery staple';
const HOUR = 60 * 60 * 1000;
const sha256 = (value: string) => createHash('sha256').update(value).digest();

beforeEach(resetDatabase);
afterEach(() => {
    vi.useRealTimers();
});
afterAll(closeDatabase);

/* An account whose password really is PASSWORD under this server's setup, signed in. */
async function account() {
    const email = `${randomUUID()}@hush.example`;
    const verification = randomUUID();
    const enrollment = randomUUID();
    await authRepository.createEnrollment({
        purpose: 'register',
        email,
        normalizedEmail: email,
        verificationTokenHash: sha256(verification),
        expiresAt: new Date(Date.now() + HOUR),
    });
    const verified = await authRepository.verifyEnrollment(
        sha256(verification),
        sha256(enrollment),
        new Date(Date.now() + HOUR),
    );
    const start = client.startRegistration({ password: PASSWORD });
    const { registrationResponse } = server.createRegistrationResponse({
        serverSetup: process.env.OPAQUE_SERVER_SETUP!,
        userIdentifier: verified!.id,
        registrationRequest: start.registrationRequest,
    });
    const { registrationRecord } = client.finishRegistration({
        password: PASSWORD,
        clientRegistrationState: start.clientRegistrationState,
        registrationResponse,
        identifiers: OPAQUE_IDENTIFIERS,
        keyStretching: KEY_STRETCHING,
    });
    const registered = await authRepository.registerAccount({
        enrollmentTokenHash: sha256(enrollment),
        ...registration(),
        registrationRecord,
        profileVersion: OPAQUE_PROFILE_VERSION,
        serverSetupId: 'primary',
    });
    if (registered.status !== 'created') throw new Error(`Registration ${registered.status}.`);
    const sessionToken = randomBytes(32).toString('base64url');
    const session = await authRepository.createSession({
        userId: registered.user.id,
        credentialVersion: 1,
        tokenHash: sha256(sessionToken),
        previousTokenHash: null,
        expiresAt: new Date(Date.now() + HOUR),
    });
    if (!session || 'suspended' in session || 'twoStep' in session) throw new Error('No session.');
    return { userId: registered.user.id, email, sessionToken };
}

/*
 * Turns the step on with an authenticator app whose secret is sealed under this server's own
 * key, as the enrolment route stores it: the server can open it, so real codes pass.
 */
async function turnOnWithApp(userId: string, sessionToken: string) {
    const secret = generateTotpSecret();
    const factorId = randomUUID();
    const key = await deriveTwoStepKey(
        new Uint8Array(Buffer.from(process.env.OPAQUE_SERVER_SETUP!, 'base64url')),
    );
    const sealed = await sealTotpSecret({ secret, key, userId, factorId });
    await twoStepRepository.startTotpFactor({
        id: factorId,
        userId,
        keyId: Buffer.from(sealed.keyId),
        nonce: Buffer.from(sealed.nonce),
        sealedSecret: Buffer.from(sealed.sealed),
    });
    const confirmed = await twoStepRepository.confirmTotpFactor({
        userId,
        factorId,
        step: 1_000,
        sessionTokenHash: sha256(sessionToken),
        credentialVersion: 1,
        backupCodes: {
            keyId: Buffer.from(sealed.keyId),
            hashes: Array.from({ length: 10 }, () => randomBytes(32)),
        },
    });
    if (confirmed.status !== 'ok') throw new Error(`Confirmation ${confirmed.status}.`);
    return secret;
}

/* A sign-in as a client that answers the step runs it: the password, then a code from the app. */
async function signInWithCode(email: string, code: string) {
    const start = client.startLogin({ password: PASSWORD });
    const { attemptToken, loginResponse } = await auth.startLogin(email, start.startLoginRequest);
    const finish = client.finishLogin({
        password: PASSWORD,
        clientLoginState: start.clientLoginState,
        loginResponse,
        identifiers: OPAQUE_IDENTIFIERS,
        keyStretching: KEY_STRETCHING,
    });
    const asked = await auth.finishLogin(
        attemptToken,
        finish!.finishLoginRequest,
        null,
        undefined,
        {
            twoStep: true,
        },
    );
    if (!('twoStep' in asked) || !asked.twoStep) throw new Error('No step was asked for.');
    return auth.finishLoginStep({ token: asked.twoStep.token, proof: { kind: 'totp', code } });
}

/* The deletion as the client runs it: the password proved again, then the request. */
async function deleteWithPassword(
    sessionToken: string,
    beforeDelete: (userId: string) => Promise<void>,
    twoStep?: Parameters<typeof auth.finishAccountDeletion>[1]['twoStep'],
) {
    const start = client.startLogin({ password: PASSWORD });
    const { attemptToken, loginResponse } = await auth.startAccountDeletion(
        sessionToken,
        start.startLoginRequest,
    );
    const finish = client.finishLogin({
        password: PASSWORD,
        clientLoginState: start.clientLoginState,
        loginResponse,
        identifiers: OPAQUE_IDENTIFIERS,
        keyStretching: KEY_STRETCHING,
    });
    return auth.finishAccountDeletion(
        sessionToken,
        { attemptToken, finishLoginRequest: finish!.finishLoginRequest, twoStep },
        beforeDelete,
    );
}

describe('deleting an account', () => {
    test('with two-step sign-in on, it is refused before anything billed to the account is touched', async () => {
        const maya = await account();
        await turnOnWithApp(maya.userId, maya.sessionToken);
        const billing = vi.fn(async () => undefined);
        await expect(deleteWithPassword(maya.sessionToken, billing)).rejects.toMatchObject({
            name: 'AuthError',
            status: 403,
            code: 'two-step',
            message: 'This needs your second step.',
        });
        expect(billing).not.toHaveBeenCalled();
        // A wrong answer to the step is refused at the same place.
        const step = await auth.startStepChallenge(maya.sessionToken, 'delete');
        await expect(
            deleteWithPassword(maya.sessionToken, billing, {
                token: step.token,
                proof: { kind: 'backup', code: 'AAAAA-AAAAA' },
            }),
        ).rejects.toMatchObject({ status: 403, code: 'step-wrong' });
        expect(billing).not.toHaveBeenCalled();
        expect((await db.select().from(users)).map((user) => user.id)).toEqual([maya.userId]);
        // The session that asked is still signed in, and the step is still on.
        expect(await auth.getSessionUser(maya.sessionToken)).toMatchObject({ id: maya.userId });
        expect(await twoStepRepository.hasTwoStep(maya.userId)).toBe(true);
    }, 60_000);

    test('without it, billing is stopped first and the account goes, as before', async () => {
        const sam = await account();
        const order: string[] = [];
        const billing = vi.fn(async (userId: string) => {
            // The account is still there when billing is asked to stop.
            const rows = await db.select().from(users);
            order.push(rows.some((user) => user.id === userId) ? 'billing' : 'billing-late');
        });
        expect(await deleteWithPassword(sam.sessionToken, billing)).toEqual({ success: true });
        expect(billing).toHaveBeenCalledExactlyOnceWith(sam.userId);
        expect(order).toEqual(['billing']);
        expect(await db.select().from(users)).toHaveLength(0);
    }, 60_000);

    test('a code already used to sign in does not delete the account, and billing is never asked to stop', async () => {
        const maya = await account();
        const secret = await turnOnWithApp(maya.userId, maya.sessionToken);
        // The code the app shows now signs her in. Whoever watched it typed has it too, and it
        // is still the app's current code.
        const code = await totpCode(secret, totpStep());
        const signedIn = await signInWithCode(maya.email, code);
        const billing = vi.fn(async () => undefined);
        const replay = await auth.startStepChallenge(signedIn.sessionToken, 'delete');
        await expect(
            deleteWithPassword(signedIn.sessionToken, billing, {
                token: replay.token,
                proof: { kind: 'totp', code },
            }),
        ).rejects.toMatchObject({
            status: 403,
            code: 'step-wrong',
            message: 'That code didn’t work. Codes change every 30 seconds.',
        });
        // Refused where a wrong code is: before the plan, and counted against the device.
        expect(billing).not.toHaveBeenCalled();
        expect((await db.select().from(users)).map((user) => user.id)).toEqual([maya.userId]);
        const devices = await db.select().from(accountDevices);
        expect(devices.find((device) => device.id === signedIn.device.id)?.twoStepFailures).toBe(1);

        // The app's next code is unused: with it the plan is stopped and the account goes.
        const fresh = await auth.startStepChallenge(signedIn.sessionToken, 'delete');
        expect(
            await deleteWithPassword(signedIn.sessionToken, billing, {
                token: fresh.token,
                proof: { kind: 'totp', code: await totpCode(secret, totpStep() + 1) },
            }),
        ).toEqual({ success: true });
        expect(billing).toHaveBeenCalledExactlyOnceWith(maya.userId);
        expect(await db.select().from(users)).toHaveLength(0);
    }, 60_000);

    test('a right code is not charged to the 15-minute budget when billing stops the deletion', async () => {
        const maya = await account();
        const secret = await turnOnWithApp(maya.userId, maya.sessionToken);
        const [device] = await db.select().from(accountDevices);
        // Nine codes already charged to this device's budget of ten, as nine wrong ones leave it.
        const budget = sha256(`auth:two-step:codes:device:${device!.id}`);
        for (let used = 0; used < 9; used++)
            expect(await authRepository.consumeRateLimit(budget, 10, 15 * 60_000)).toBe(true);

        const outage = vi.fn(async () => {
            throw new Error('The payment provider is down.');
        });
        const first = await auth.startStepChallenge(maya.sessionToken, 'delete');
        await expect(
            deleteWithPassword(maya.sessionToken, outage, {
                token: first.token,
                proof: { kind: 'totp', code: await totpCode(secret, totpStep()) },
            }),
        ).rejects.toThrow('The payment provider is down.');
        expect(outage).toHaveBeenCalledOnce();
        expect(await db.select().from(users)).toHaveLength(1);

        // The tenth place is still there: the retry is checked, not refused as one code too many.
        const billing = vi.fn(async () => undefined);
        const retry = await auth.startStepChallenge(maya.sessionToken, 'delete');
        expect(
            await deleteWithPassword(maya.sessionToken, billing, {
                token: retry.token,
                proof: { kind: 'totp', code: await totpCode(secret, totpStep()) },
            }),
        ).toEqual({ success: true });
        expect(billing).toHaveBeenCalledExactlyOnceWith(maya.userId);
        expect(await db.select().from(users)).toHaveLength(0);
    }, 60_000);

    test('a right code whose step ran out while billing was being stopped is refused uncharged, and says the plan was stopped', async () => {
        const maya = await account();
        const secret = await turnOnWithApp(maya.userId, maya.sessionToken);
        const [device] = await db.select().from(accountDevices);
        const budget = sha256(`auth:two-step:codes:device:${device!.id}`);
        for (let used = 0; used < 9; used++)
            expect(await authRepository.consumeRateLimit(budget, 10, 15 * 60_000)).toBe(true);

        // The payment provider answers after the step's five minutes are over.
        vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
        const slow = vi.fn(async () => {
            vi.setSystemTime(Date.now() + 6 * 60_000);
        });
        const first = await auth.startStepChallenge(maya.sessionToken, 'delete');
        await expect(
            deleteWithPassword(maya.sessionToken, slow, {
                token: first.token,
                proof: { kind: 'totp', code: await totpCode(secret, totpStep()) },
            }),
        ).rejects.toMatchObject({
            status: 403,
            code: 'step-expired',
            message:
                'Your plan was stopped, but your account was not deleted: it needs your second step first. Try again.',
        });
        expect(slow).toHaveBeenCalledOnce();
        expect(await db.select().from(users)).toHaveLength(1);
        // Nothing was guessed: no wrong answer is counted, and the tenth place is still there.
        expect((await db.select().from(accountDevices))[0]!.twoStepFailures).toBe(0);
        const billing = vi.fn(async () => undefined);
        const retry = await auth.startStepChallenge(maya.sessionToken, 'delete');
        expect(
            await deleteWithPassword(maya.sessionToken, billing, {
                token: retry.token,
                proof: { kind: 'totp', code: await totpCode(secret, totpStep()) },
            }),
        ).toEqual({ success: true });
        expect(await db.select().from(users)).toHaveLength(0);
    }, 60_000);
});
