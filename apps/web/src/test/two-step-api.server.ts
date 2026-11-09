import '@/lib/server-only';
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import { OPAQUE_IDENTIFIERS } from '@hushos/crypto';
import { deviceSessionStatement } from '@hushos/crypto/device-identity';
import { createRecovery } from '@hushos/crypto/recovery';
import { client, ready, server } from '@hushos/crypto/server';
import { signTwoStepPhrase } from '@hushos/crypto/two-step';
import {
    deriveTwoStepKey,
    formatBackupCode,
    generateBackupCode,
    hashBackupCode,
    sealTotpSecret,
    totpCode,
    totpStep,
    twoStepKeyId,
} from '@hushos/crypto/two-step/server';
import { loadApiModule } from '@/test/api-app';

/*
 * Two-step sign-in through the real routes, the real OPAQUE exchange and a real
 * database (the `db` project): what the `*.db.test.ts` files beside the auth API
 * share. Requests go through the API's HTTP edge (`handleApiRequest`), so the
 * route allowlist, the body cap and the Origin check are in the way as they are
 * in production. Accounts are registered through the repository with a record
 * the OPAQUE client really made, and a recovery key a real phrase derives.
 *
 * Nothing that reads the environment is imported at the top of this file or of
 * a test that uses it: the server's settings are read once, when its modules
 * load, so `startApi` sets them first and imports the rest after.
 *
 * The clock is the tests' own (`at`): authenticator codes are per 30 seconds,
 * and a test that computed "the previous code" across a boundary would fail
 * once in a while. Only `Date` is faked; timers and the database run as usual.
 */

const ORIGIN = 'http://localhost:5173';
const HOUR = 60 * 60 * 1000;
export const PASSWORD = 'correct horse battery staple';

export type Sent = { to: string; subject: string; text: string };
/* Every email the server sent, as the `log` adapter writes it: who to, the subject, the text. */
export const outbox: Sent[] = [];

/*
 * The server runs with EMAIL_ADAPTER=log, which writes each message, composed from the real
 * templates, to the console. Kept here instead. Call in `beforeEach`: spies are restored
 * between tests.
 */
export function captureMail() {
    outbox.length = 0;
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
        const lines = String(args[0]).split('\n');
        if (!lines[0]?.startsWith('[email] To: ')) return;
        const line = (index: number) => lines[index]!.replace(/^\[email\] ?/, '');
        outbox.push({
            to: line(0).slice('To: '.length),
            subject: line(1).slice('Subject: '.length),
            text: lines
                .slice(2)
                .map((_, index) => line(index + 2))
                .join('\n'),
        });
    });
}

export type Account = Awaited<ReturnType<Harness['account']>>;
export type Harness = Awaited<ReturnType<typeof startApi>>;
export type Reply = { status: number; body: any; cookie: string | null | undefined };

let addresses = 0;
/* A fresh client address: the per-address limits are not what these tests are about. */
const nextAddress = () => `203.0.113.${(addresses++ % 250) + 1}`;

/* The middle of the current 30-second period, so a few seconds of test never cross a boundary. */
export function steadyClock() {
    const now = Math.floor(Date.now() / 30_000) * 30_000 + 15_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    return now;
}

/* The API as the server mounts it, with `env` on top of the test defaults. Once per test file. */
export async function startApi(env: Record<string, string> = {}) {
    await ready;
    const setup = server.createSetup();
    vi.stubEnv('OPAQUE_SERVER_SETUP', setup);
    vi.stubEnv('TRUSTED_PROXY_HEADER', 'x-forwarded-for');
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    // Outside Nitro there is no request to read a socket address from.
    vi.doMock('nitro/context', () => ({ useRequest: () => ({ ip: '198.51.100.1' }) }));
    const { handleApiRequest } = await loadApiModule();
    const auth = await import('@hushos/auth/server');
    const { authRepository, twoStepRepository } = await import('@hushos/db');
    const { registration, sha256 } = await import('../../../../packages/db/test/accounts');
    const helpers = await import('../../../../packages/db/test/helpers');
    const rows = await import('../../../../packages/db/test/two-step');
    const { signingKeyFromSeed } = helpers;

    async function call(
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        path: string,
        body?: unknown,
        options: { cookie?: string | null; address?: string } = {},
    ): Promise<Reply> {
        const headers: Record<string, string> = {
            origin: ORIGIN,
            'x-forwarded-for': options.address ?? nextAddress(),
        };
        if (options.cookie) headers.cookie = `hushos-session=${options.cookie}`;
        const init: RequestInit = { method, headers };
        if (method !== 'GET') {
            headers['content-type'] = 'application/json';
            init.body = JSON.stringify(body ?? {});
        }
        const response = await handleApiRequest(new Request(`${ORIGIN}/api/auth${path}`, init));
        const text = await response.text();
        const set = response.headers.get('set-cookie');
        return {
            status: response.status,
            body: text ? JSON.parse(text) : null,
            // The session token a reply set, '' when it cleared the cookie, null when it set none.
            cookie: set === null ? null : /hushos-session=([^;]*)/.exec(set)?.[1],
        };
    }

    /* An account as registration leaves it: a real OPAQUE record and a recovery key its phrase derives. */
    async function account(password = PASSWORD) {
        const email = `${randomUUID()}@hushos.test`;
        const verification = randomUUID();
        const enrollment = randomUUID();
        const expiresAt = new Date(Date.now() + HOUR);
        await authRepository.createEnrollment({
            purpose: 'register',
            email,
            normalizedEmail: email,
            verificationTokenHash: sha256(verification),
            expiresAt,
        });
        const verified = await authRepository.verifyEnrollment(
            sha256(verification),
            sha256(enrollment),
            expiresAt,
        );
        if (!verified) throw new Error('The enrollment did not verify.');
        const start = client.startRegistration({ password });
        const { registrationResponse } = server.createRegistrationResponse({
            serverSetup: setup,
            userIdentifier: verified.id,
            registrationRequest: start.registrationRequest,
        });
        const { registrationRecord } = client.finishRegistration({
            password,
            registrationResponse,
            clientRegistrationState: start.clientRegistrationState,
            identifiers: OPAQUE_IDENTIFIERS,
        });
        const made = await recoveryKey(verified.id, 1);
        const result = await authRepository.registerAccount({
            enrollmentTokenHash: sha256(enrollment),
            ...registration(),
            registrationRecord,
            recovery: made.row,
        });
        if (result.status !== 'created') throw new Error(`Registration ${result.status}.`);
        return { id: verified.id, email, password, phrase: made.phrase, recovery: made.envelope };
    }

    /* A recovery key as the client makes it: the envelope, its phrase, and the row the server stores. */
    async function recoveryKey(userId: string, recoveryVersion: number) {
        const { recovery, phrase } = await createRecovery(randomBytes(32), userId, recoveryVersion);
        const bytes = (value: string) => Buffer.from(value, 'base64url');
        return {
            phrase,
            envelope: recovery,
            row: {
                recoveryVersion,
                wrappingSalt: bytes(recovery.wrappingSalt),
                wrappingNonce: bytes(recovery.wrappingNonce),
                encryptedKey: bytes(recovery.encryptedKey),
                backupNonce: bytes(recovery.backupNonce),
                encryptedRecoveryKey: bytes(recovery.encryptedRecoveryKey),
                publicKey: bytes(recovery.publicKey),
            },
        };
    }

    /*
     * The password, proved: the OPAQUE exchange a client runs against a start route, and what
     * its finish route takes. `/login/start` for a sign-in; a session's own start route
     * (`/two-step/reauth`, `/delete/start`, `/security/start`) for a change.
     */
    async function prove(
        who: { email: string; password: string },
        startPath = '/login/start',
        options: { cookie?: string | null; extra?: Record<string, unknown>; address?: string } = {},
    ) {
        const start = client.startLogin({ password: who.password });
        const challenge = await call(
            'POST',
            startPath,
            {
                ...(startPath === '/login/start' ? { email: who.email } : {}),
                startLoginRequest: start.startLoginRequest,
                ...options.extra,
            },
            options,
        );
        expect(challenge.status, JSON.stringify(challenge.body)).toBe(200);
        const finish = client.finishLogin({
            clientLoginState: start.clientLoginState,
            loginResponse: challenge.body.loginResponse,
            password: who.password,
            identifiers: OPAQUE_IDENTIFIERS,
        });
        if (!finish) throw new Error('The password did not open the OPAQUE envelope.');
        return {
            attemptToken: challenge.body.attemptToken as string,
            finishLoginRequest: finish.finishLoginRequest,
            challenge: challenge.body,
        };
    }

    /* A device key, and its proof for one sign-in attempt. */
    function deviceKey(label: string) {
        const key = signingKeyFromSeed(sha256(`device-key:${label}`));
        return {
            publicKey: key.publicKey.toString('base64url'),
            async proof(userId: string, deviceId: string, attemptToken: string) {
                const statement = await deviceSessionStatement({ userId, deviceId, attemptToken });
                return {
                    id: deviceId,
                    signature: key.sign(Buffer.from(statement)).toString('base64url'),
                };
            },
        };
    }

    /*
     * `login/finish` after a correct password. `twoStep: 1` unless `old` (a client from before
     * the step); `cookie` is the session the browser still holds; `device` a known device's proof.
     */
    async function signIn(
        who: { id: string; email: string; password: string },
        options: {
            old?: boolean;
            cookie?: string | null;
            device?: { id: string; key: ReturnType<typeof deviceKey>; as?: string };
            address?: string;
        } = {},
    ) {
        const proof = await prove(who, '/login/start', { address: options.address });
        return call(
            'POST',
            '/login/finish',
            {
                attemptToken: proof.attemptToken,
                finishLoginRequest: proof.finishLoginRequest,
                ...(options.old ? {} : { twoStep: 1 }),
                ...(options.device
                    ? {
                          device: await options.device.key.proof(
                              options.device.as ?? who.id,
                              options.device.id,
                              proof.attemptToken,
                          ),
                      }
                    : {}),
            },
            { cookie: options.cookie, address: options.address },
        );
    }

    /* The two-step key this server derives, as the design gives it: tests seal and hash under it. */
    const twoStepKey = async () => {
        const key = await deriveTwoStepKey(Buffer.from(setup, 'base64url'));
        return { key, id: Buffer.from(await twoStepKeyId(key)) };
    };

    /*
     * Turns the step on for an account without the enrolment routes: an authenticator app whose
     * secret the test holds, confirmed at a step well in the past, and ten backup codes. Sealed
     * and hashed as the design says, under the key the server derives, so the routes must open
     * and check exactly that. `under` is another key instead: one this server does not have,
     * as after an operator changed TWO_STEP_KEY and dropped the old one.
     */
    async function enrol(
        userId: string,
        options: { sessionToken?: string; under?: Uint8Array } = {},
    ) {
        const { key, id: keyId } = options.under
            ? { key: options.under, id: Buffer.from(await twoStepKeyId(options.under)) }
            : await twoStepKey();
        const secret = new Uint8Array(randomBytes(20));
        const factorId = randomUUID();
        const { nonce, sealed } = await sealTotpSecret(secret, key, { userId, factorId, keyId });
        await twoStepRepository.createPendingTotp({
            id: factorId,
            userId,
            name: 'Authenticator app',
            keyId,
            nonce: Buffer.from(nonce),
            secret: Buffer.from(sealed),
        });
        const state = await twoStepRepository.ensureState(userId);
        if (!state) throw new Error('No two-step state.');
        const backupCodes = Array.from({ length: 10 }, generateBackupCode);
        const confirmed = await twoStepRepository.confirmTotp({
            userId,
            factorId,
            step: totpStep() - 100,
            backupCodes: await Promise.all(
                backupCodes.map(async (code) => ({
                    codeHash: Buffer.from(await hashBackupCode(code, key, state.backupCodeSalt)),
                    keyId,
                })),
            ),
            sessionTokenHash: options.sessionToken ? sha256(options.sessionToken) : undefined,
        });
        if (confirmed.status !== 'ok') throw new Error(`Enrolment ${confirmed.status}.`);
        return {
            factorId,
            secret,
            backupCodes: backupCodes.map(formatBackupCode),
            /* The app's code now, or `offset` 30-second steps away. */
            code: (offset = 0) => totpCode(secret, totpStep() + offset),
        };
    }

    /* The recovery phrase's answer to a step token. */
    const phraseProof = async (
        who: { id: string; phrase: string },
        offer: { token: string; phrase?: { wrappingSalt: string } },
    ) => ({
        kind: 'phrase' as const,
        signature: await signTwoStepPhrase(who.phrase, {
            userId: who.id,
            stepToken: offer.token,
            wrappingSalt: offer.phrase!.wrappingSalt,
        }),
    });

    /* Every notice sent so far has been composed; then what is in the outbox. */
    async function notices() {
        await auth.twoStepNoticesSettled();
        return outbox;
    }

    return {
        setup,
        call,
        account,
        recoveryKey,
        prove,
        deviceKey,
        signIn,
        enrol,
        twoStepKey,
        phraseProof,
        notices,
        auth,
        authRepository,
        twoStepRepository,
        rows,
        sha256,
        resetDatabase: helpers.resetDatabase,
        closeDatabase: helpers.closeDatabase,
        createTestFamily: helpers.createTestFamily,
        lockObserver: helpers.lockObserver,
    };
}
