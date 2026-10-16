import { createHash } from 'node:crypto';
import { KEY_STRETCHING, OPAQUE_IDENTIFIERS, OPAQUE_PROFILE_VERSION } from '@hushos/crypto';
import { client, ready, server } from '@hushos/crypto/server';
import { beforeAll, describe, expect, test } from 'vitest';
import { boundAttemptHolds, type StoredAttempt } from './bound-attempt';

/*
 * A password proved again by a signed-in session: deleting the account, a
 * security change and removing devices all accept a proof only through this
 * check. Each case is a proof that must not pass: made for another action, by
 * another session or account, against an earlier credential, too late, already
 * used (the store then hands back nothing), or with its last message altered.
 * The exchange is real OPAQUE, as the client and server run it.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const PASSWORD = 'correct horse battery staple';
const session = createHash('sha256').update('session-a').digest();
const expected = {
    purpose: 'devices' as const,
    userId: USER,
    credentialVersion: 3,
    sessionTokenHash: session,
};

let serverSetup: string;
let registrationRecord: string;

beforeAll(async () => {
    await ready;
    serverSetup = server.createSetup();
    const registration = client.startRegistration({ password: PASSWORD });
    const { registrationResponse } = server.createRegistrationResponse({
        serverSetup,
        userIdentifier: USER,
        registrationRequest: registration.registrationRequest,
    });
    registrationRecord = client.finishRegistration({
        password: PASSWORD,
        clientRegistrationState: registration.clientRegistrationState,
        registrationResponse,
        identifiers: OPAQUE_IDENTIFIERS,
        keyStretching: KEY_STRETCHING,
    }).registrationRecord;
});

/* A stored attempt as startLogin writes it, and the client's KE3 for `password`. */
function exchange(password = PASSWORD) {
    const start = client.startLogin({ password });
    const { loginResponse, serverLoginState } = server.startLogin({
        serverSetup,
        userIdentifier: USER,
        registrationRecord,
        startLoginRequest: start.startLoginRequest,
        identifiers: OPAQUE_IDENTIFIERS,
    });
    const finish = client.finishLogin({
        password,
        clientLoginState: start.clientLoginState,
        loginResponse,
        identifiers: OPAQUE_IDENTIFIERS,
        keyStretching: KEY_STRETCHING,
    });
    const attempt: StoredAttempt = {
        purpose: 'devices',
        userId: USER,
        credentialVersion: 3,
        sessionTokenHash: session,
        expiresAt: new Date(Date.now() + 5 * 60_000),
        profileVersion: OPAQUE_PROFILE_VERSION,
        serverState: serverLoginState,
    };
    return { attempt, finishLoginRequest: finish?.finishLoginRequest ?? '' };
}

describe('a password proof bound to a session', () => {
    test('holds for its own purpose, account, credential and session', async () => {
        const { attempt, finishLoginRequest } = exchange();
        expect(await boundAttemptHolds(attempt, expected, finishLoginRequest)).toBe(true);
    });

    test.each([
        ['made for deleting the account', { purpose: 'delete' }],
        ['made for a password change', { purpose: 'password' }],
        [
            'started by another session',
            { sessionTokenHash: createHash('sha256').update('session-b').digest() },
        ],
        ['started for another account', { userId: '22222222-2222-4222-8222-222222222222' }],
        ['against the credential before a password change', { credentialVersion: 2 }],
    ] as const)('refuses a proof %s', async (_label, change) => {
        const { attempt, finishLoginRequest } = exchange();
        expect(
            await boundAttemptHolds({ ...attempt, ...change }, expected, finishLoginRequest),
        ).toBe(false);
    });

    test('refuses a proof after the attempt expired', async () => {
        const { attempt, finishLoginRequest } = exchange();
        expect(
            await boundAttemptHolds(
                attempt,
                expected,
                finishLoginRequest,
                attempt.expiresAt.getTime(),
            ),
        ).toBe(false);
    });

    test('refuses a replay: the attempt was consumed, so the store hands back nothing', async () => {
        const { finishLoginRequest } = exchange();
        expect(await boundAttemptHolds(null, expected, finishLoginRequest)).toBe(false);
    });

    test('refuses an altered KE3, and one from another exchange', async () => {
        const { attempt, finishLoginRequest } = exchange();
        const bytes = Buffer.from(finishLoginRequest, 'base64url');
        const last = bytes.length - 1;
        bytes[last] = (bytes[last] ?? 0) ^ 1;
        expect(await boundAttemptHolds(attempt, expected, bytes.toString('base64url'))).toBe(false);
        const other = exchange();
        expect(await boundAttemptHolds(attempt, expected, other.finishLoginRequest)).toBe(false);
    });

    test('a wrong password yields no KE3 the server takes', async () => {
        const { attempt, finishLoginRequest } = exchange('not the password');
        expect(finishLoginRequest).toBe('');
        expect(await boundAttemptHolds(attempt, expected, finishLoginRequest)).toBe(false);
    });
});
