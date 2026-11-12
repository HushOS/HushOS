import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { KEY_STRETCHING, OPAQUE_IDENTIFIERS, OPAQUE_PROFILE_VERSION } from '@hushos/crypto';
import { client, ready, server } from '@hushos/crypto/server';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * Deleting an account that has two-step sign-in on, against the test database with a real
 * OPAQUE exchange. The route stops whatever is billed to the account before the account goes
 * (`beforeDelete`: the web app revokes the plan and deletes the customer at the payment
 * provider there). An account with the step on is deleted only with its second step, and
 * this server cannot take one yet: it must refuse before billing is touched, or the account
 * would survive with its plan destroyed.
 */
await ready;
process.env.APP_ORIGIN = 'https://hush.example';
process.env.OPAQUE_SERVER_SETUP = server.createSetup();
process.env.EMAIL_ADAPTER = 'log';
process.env.EMAIL_FROM = 'HushOS <hushos@hushos.test>';

const { closeDatabase, resetDatabase } = await import('../../db/test/helpers');
const { registration } = await import('../../db/test/accounts');
const { authRepository, db, twoStepRepository } = await import('@hushos/db');
const { users } = await import('@hushos/db/schema');
const auth = await import('./server');

const PASSWORD = 'correct horse battery staple';
const HOUR = 60 * 60 * 1000;
const sha256 = (value: string) => createHash('sha256').update(value).digest();

beforeEach(resetDatabase);
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
    return { userId: registered.user.id, sessionToken };
}

/* Turns two-step sign-in on for the account, from its session. */
async function turnOnTwoStep(userId: string, sessionToken: string) {
    const factorId = randomUUID();
    await twoStepRepository.startTotpFactor({
        id: factorId,
        userId,
        keyId: randomBytes(8),
        nonce: randomBytes(24),
        sealedSecret: randomBytes(36),
    });
    const confirmed = await twoStepRepository.confirmTotpFactor({
        userId,
        factorId,
        step: 1_000,
        sessionTokenHash: sha256(sessionToken),
        credentialVersion: 1,
        backupCodes: {
            keyId: randomBytes(8),
            hashes: Array.from({ length: 10 }, () => randomBytes(32)),
        },
    });
    if (confirmed.status !== 'ok') throw new Error(`Confirmation ${confirmed.status}.`);
}

/* The deletion as the client runs it: the password proved again, then the request. */
async function deleteWithPassword(
    sessionToken: string,
    beforeDelete: (userId: string) => Promise<void>,
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
        { attemptToken, finishLoginRequest: finish!.finishLoginRequest },
        beforeDelete,
    );
}

describe('deleting an account', () => {
    test('with two-step sign-in on, it is refused before anything billed to the account is touched', async () => {
        const maya = await account();
        await turnOnTwoStep(maya.userId, maya.sessionToken);
        const billing = vi.fn(async () => undefined);
        await expect(deleteWithPassword(maya.sessionToken, billing)).rejects.toMatchObject({
            name: 'AuthError',
            status: 403,
            message: 'Your account was not deleted: it asks for a second step.',
        });
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
});
