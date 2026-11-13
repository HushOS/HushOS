import '@/lib/server-only';
import { randomBytes, randomUUID } from 'node:crypto';
import { KEY_STRETCHING, OPAQUE_IDENTIFIERS, OPAQUE_PROFILE_VERSION } from '@hushos/crypto';
import { deviceSessionStatement } from '@hushos/crypto/device-identity';
import { createRecovery, openRecovery, signRecoveryReset } from '@hushos/crypto/recovery';
import { client, ready, server } from '@hushos/crypto/server';
import { formatBackupCode, recoveryStepKey, signTwoStepPhrase } from '@hushos/crypto/two-step';
import {
    base32,
    generateBackupCodes,
    generateTotpSecret,
    hashBackupCode,
    sealTotpSecret,
    totpCode,
    totpStep,
} from '@hushos/crypto/two-step/server';
import { vi } from 'vitest';
import { loadApiModule } from './api-app';

/*
 * The auth API as a browser or a phone app reaches it, for tests that must not skip a layer:
 * every request goes through the HTTP edge (`handleApiRequest`: the Origin check, the body
 * cap, the per-address limit), the Elysia routes and their schemas, a real OPAQUE exchange,
 * and Postgres. Only three things are stood in for: the client address (Nitro's request
 * context, which a test has none of), outgoing mail (kept in `outbox`), and the request's
 * logger. The process logger is the real one, set up as production sets it up, and what it
 * emits after redaction is kept in `emitted`.
 *
 * The environment is read when the server's modules load, so everything that loads them is
 * imported here, after it is set: nothing of the server is imported at the top of this file.
 */

const ORIGIN = 'http://localhost:5173';
export const PASSWORD = 'correct horse battery staple';

export type Reply = { status: number; body: any; session: string | null | undefined };
export type Notice = {
    to: string;
    kind: string;
    count?: number;
    method?: string;
    /* The message as it would be sent: its subject and its plain-text part. */
    subject: string;
    text: string;
};
export type Account = { userId: string; email: string; phrase: string };

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/* An authenticator app's reading of the secret the page shows. */
export function fromBase32(value: string) {
    let bits = 0;
    let buffer = 0;
    const out: number[] = [];
    for (const character of value) {
        buffer = (buffer << 5) | BASE32.indexOf(character);
        bits += 5;
        if (bits >= 8) {
            out.push((buffer >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return new Uint8Array(out);
}

/* The code an authenticator app shows now, or `offset` steps from now. */
export function appCode(secret: string, offset = 0) {
    return totpCode(fromBase32(secret), totpStep() + offset);
}

/*
 * `setup: 'database'` leaves OPAQUE_SERVER_SETUP unset, so the server makes its setup on first
 * use and keeps it in `server_secrets`, as an instance does when its operator sets none.
 */
export async function loadEdge(
    env: Record<string, string> = {},
    options: { setup?: 'environment' | 'database' } = {},
) {
    await ready;
    const fromDatabase = options.setup === 'database';
    vi.stubEnv('OPAQUE_SERVER_SETUP', fromDatabase ? '' : server.createSetup());
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const state = { address: '203.0.113.1' };
    const outbox: Notice[] = [];
    vi.doMock('nitro/context', () => ({
        useRequest: () => ({ ip: state.address, headers: new Headers(), context: {} }),
    }));
    // The emails package is not a dependency of the web app, so it is named by its file.
    type SecurityNotice = { kind: string; count?: number; method?: string };
    vi.doMock(
        new URL('../../../../packages/emails/src/service.ts', import.meta.url).pathname,
        async (importOriginal) => {
            const emails = (await importOriginal()) as {
                composeSecurityNotice: (
                    to: string,
                    input: SecurityNotice,
                ) => { subject: string; text: string };
            };
            return {
                ...emails,
                sendSecurityNotice: async (to: string, input: SecurityNotice) => {
                    // Composed for real: a notice whose template lacks a value fails here too.
                    const { subject, text } = emails.composeSecurityNotice(to, input);
                    outbox.push({
                        to,
                        kind: input.kind,
                        count: input.count,
                        method: input.method,
                        subject,
                        text,
                    });
                },
            };
        },
    );
    const { handleApiRequest } = await loadApiModule();
    const { authRepository, db, twoStepRepository } = await import('@hushos/db');
    const schema = await import('@hushos/db/schema');
    const { registration, sha256 } = await import('../../../../packages/db/test/accounts');
    const helpers = await import('../../../../packages/db/test/helpers');
    const { closeDatabase, signingKeyFromSeed } = helpers;
    const logging = await import('@hushos/logging');
    // What the operator's log receives: each event as it leaves the logger, redaction applied.
    const emitted: Record<string, unknown>[] = [];
    logging.initLogger({
        ...logging.loggingOptions,
        redact: {
            ...logging.loggingOptions.redact,
            transform: logging.redactAuthenticationEvent,
        },
        silent: true,
        drain: ({ event }) => {
            emitted.push(event);
        },
    });

    /*
     * The OPAQUE setup this server uses. Kept in the database, it is made once and outlives
     * every reset here, as it outlives everything on a real instance: the server holds it in
     * memory after first use, so a reset that dropped the row puts the same value back.
     */
    let databaseSetup: string | undefined;
    async function serverSetup() {
        if (!fromDatabase) return process.env.OPAQUE_SERVER_SETUP!;
        databaseSetup = await authRepository.ensureServerSecret(
            'opaque-setup:primary',
            () => databaseSetup ?? server.createSetup(),
        );
        return databaseSetup;
    }
    async function resetDatabase() {
        await helpers.resetDatabase();
        if (fromDatabase) await serverSetup();
    }

    /*
     * One request to /api/auth (or to `options.api`, another part of the API), as a client
     * sends it. `session` is the cookie it set: a token, null when cleared.
     */
    async function call(
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        path: string,
        body?: unknown,
        options: {
            cookie?: string | null;
            origin?: string;
            enrollment?: string;
            api?: string;
        } = {},
    ): Promise<Reply> {
        const init: RequestInit = {
            method,
            headers: {
                origin: options.origin ?? ORIGIN,
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                ...(options.cookie ? { cookie: `hushos-session=${options.cookie}` } : {}),
                // A confirmed email's cookie, which sign-up and a reset are asked under.
                ...(options.enrollment
                    ? { cookie: `hushos-enrollment=${options.enrollment}` }
                    : {}),
            },
        };
        if (body !== undefined) init.body = JSON.stringify(body);
        const response = await handleApiRequest(
            new Request(`${ORIGIN}${options.api ?? '/api/auth'}${path}`, init),
        );
        const cookie = response.headers
            .getSetCookie()
            .map((value) => /^hushos-session=([^;]*);/.exec(value)?.[1])
            .find((value) => value !== undefined);
        return {
            status: response.status,
            body: await response.json().catch(() => null),
            session: cookie === undefined ? undefined : cookie || null,
        };
    }

    /* An account whose password really is PASSWORD and whose recovery phrase really opens its recovery key. */
    async function account(password = PASSWORD): Promise<Account> {
        const email = `${randomUUID()}@hush.example`;
        const verification = randomUUID();
        const enrollment = randomUUID();
        const later = new Date(Date.now() + 60 * 60 * 1000);
        await authRepository.createEnrollment({
            purpose: 'register',
            email,
            normalizedEmail: email,
            verificationTokenHash: sha256(verification),
            expiresAt: later,
        });
        const verified = await authRepository.verifyEnrollment(
            sha256(verification),
            sha256(enrollment),
            later,
        );
        const start = client.startRegistration({ password });
        const { registrationResponse } = server.createRegistrationResponse({
            serverSetup: await serverSetup(),
            userIdentifier: verified!.id,
            registrationRequest: start.registrationRequest,
        });
        const { registrationRecord } = client.finishRegistration({
            password,
            clientRegistrationState: start.clientRegistrationState,
            registrationResponse,
            identifiers: OPAQUE_IDENTIFIERS,
            keyStretching: KEY_STRETCHING,
        });
        const made = await createRecovery(new Uint8Array(randomBytes(32)), verified!.id);
        const bytes = (value: string) => Buffer.from(value, 'base64url');
        const registered = await authRepository.registerAccount({
            enrollmentTokenHash: sha256(enrollment),
            ...registration(),
            registrationRecord,
            profileVersion: OPAQUE_PROFILE_VERSION,
            serverSetupId: 'primary',
            recovery: {
                wrappingSalt: bytes(made.recovery.wrappingSalt),
                wrappingNonce: bytes(made.recovery.wrappingNonce),
                encryptedKey: bytes(made.recovery.encryptedKey),
                backupNonce: bytes(made.recovery.backupNonce),
                encryptedRecoveryKey: bytes(made.recovery.encryptedRecoveryKey),
                publicKey: bytes(made.recovery.publicKey),
            },
        });
        if (registered.status !== 'created') throw new Error(`Registration ${registered.status}.`);
        return { userId: registered.user.id, email, phrase: made.phrase };
    }

    /*
     * A reset as the client does it: the email confirmed (the link in the mail, past here), then
     * a new password, a new account-key envelope and a new recovery key, signed by the key the
     * old phrase opens. `spoiled` signs with another key, as someone without the phrase would.
     */
    async function reset(
        who: Account,
        phrase: string,
        password: string,
        options: { spoiled?: boolean } = {},
    ) {
        const verification = randomUUID();
        const enrollment = randomBytes(32).toString('base64url');
        const later = new Date(Date.now() + 60 * 60 * 1000);
        await authRepository.createEnrollment({
            purpose: 'recover',
            email: who.email,
            normalizedEmail: who.email,
            verificationTokenHash: sha256(verification),
            expiresAt: later,
        });
        await authRepository.verifyEnrollment(sha256(verification), sha256(enrollment), later);
        const registration = client.startRegistration({ password });
        const started = await call(
            'POST',
            '/recover/start',
            { registrationRequest: registration.registrationRequest },
            { enrollment },
        );
        if (started.status !== 200) throw new Error(`/recover/start answered ${started.status}.`);
        const { registrationRecord } = client.finishRegistration({
            password,
            clientRegistrationState: registration.clientRegistrationState,
            registrationResponse: started.body.registrationResponse,
            identifiers: OPAQUE_IDENTIFIERS,
            keyStretching: KEY_STRETCHING,
        });
        const old = started.body.recovery;
        const opened = await openRecovery(phrase, who.userId, old);
        const made = await createRecovery(
            opened.accountKey,
            who.userId,
            old.recoveryVersion + 1,
            old.keyVersion,
        );
        const change = {
            userId: who.userId,
            attemptToken: started.body.attemptToken as string,
            credentialVersion: started.body.credentialVersion as number,
            registrationRecord,
            envelope: {
                envelopeVersion: 1 as const,
                keyVersion: old.keyVersion as number,
                credentialVersion: (started.body.credentialVersion as number) + 1,
                wrappingSalt: randomBytes(32).toString('base64url'),
                wrappingNonce: randomBytes(24).toString('base64url'),
                encryptedKey: randomBytes(48).toString('base64url'),
            },
            recovery: made.recovery,
        };
        const signature = await signRecoveryReset(
            change,
            options.spoiled ? new Uint8Array(randomBytes(64)) : opened.signingKey,
        );
        const reply = await call(
            'POST',
            '/recover/finish',
            { ...change, signature },
            { enrollment },
        );
        return { reply, phrase: made.phrase };
    }

    type Proof = { deviceId: string; seed: Buffer };

    /* The password, proved to `path`'s start route: what its finish route then takes. */
    async function passwordProof(
        startPath: string,
        body: Record<string, unknown>,
        options: { cookie?: string | null; password?: string } = {},
    ) {
        const password = options.password ?? PASSWORD;
        const start = client.startLogin({ password });
        const challenge = await call(
            'POST',
            startPath,
            { ...body, startLoginRequest: start.startLoginRequest },
            options,
        );
        if (challenge.status !== 200) throw new Error(`${startPath} answered ${challenge.status}.`);
        const finish = client.finishLogin({
            password,
            clientLoginState: start.clientLoginState,
            loginResponse: challenge.body.loginResponse,
            identifiers: OPAQUE_IDENTIFIERS,
            keyStretching: KEY_STRETCHING,
        });
        return {
            challenge: challenge.body,
            // A wrong password yields no KE3; a made-up one stands in for whatever a client would send.
            proof: {
                attemptToken: challenge.body.attemptToken as string,
                finishLoginRequest:
                    finish?.finishLoginRequest ?? randomBytes(64).toString('base64url'),
            },
        };
    }

    /* A sign-in's two requests. `twoStep` is what a client that can answer a step sends. */
    async function signIn(
        who: Account,
        options: {
            cookie?: string | null;
            twoStep?: boolean;
            device?: Proof;
            password?: string;
        } = {},
    ): Promise<Reply> {
        const { proof } = await passwordProof('/login/start', { email: who.email }, options);
        const device = options.device
            ? {
                  id: options.device.deviceId,
                  signature: signingKeyFromSeed(options.device.seed)
                      .sign(
                          Buffer.from(
                              await deviceSessionStatement({
                                  userId: who.userId,
                                  deviceId: options.device.deviceId,
                                  attemptToken: proof.attemptToken,
                              }),
                          ),
                      )
                      .toString('base64url'),
              }
            : undefined;
        return call(
            'POST',
            '/login/finish',
            { ...proof, ...(options.twoStep ? { twoStep: 1 } : {}), ...(device ? { device } : {}) },
            { cookie: options.cookie },
        );
    }

    /* The recovery phrase's answer to a step, made as a device makes it from what the step's reply carries. */
    async function phraseProof(
        phrase: string,
        step: { token: string; phrase: { userId: string; wrappingSalt: string } },
    ) {
        const key = await recoveryStepKey(phrase, step.phrase.wrappingSalt);
        return {
            kind: 'phrase' as const,
            signature: await signTwoStepPhrase(key, {
                userId: step.phrase.userId,
                stepToken: step.token,
            }),
        };
    }

    /* Gives the session's device a key of its own, as the app does after signing in. */
    async function giveDeviceKey(cookie: string, deviceId: string): Promise<Proof> {
        const seed = randomBytes(32);
        const registered = await call(
            'POST',
            '/devices',
            {
                kind: 'web',
                name: 'Laptop',
                signingPublicKey: signingKeyFromSeed(seed).publicKey.toString('base64url'),
            },
            { cookie },
        );
        if (registered.status !== 200) throw new Error(`Device ${registered.status}.`);
        return { deviceId, seed };
    }

    /*
     * Turns the step on for an account past the routes, with its app's secret sealed and its
     * codes hashed under `key`: rows as a server holding that key wrote them. For what the
     * routes cannot set up: a row from before a key rotation, or from while the flag was on.
     */
    async function stepUnder(key: Uint8Array, who: Account, cookie: string) {
        const secret = generateTotpSecret();
        const id = randomUUID();
        const sealed = await sealTotpSecret({ secret, key, userId: who.userId, factorId: id });
        await twoStepRepository.startTotpFactor({
            id,
            userId: who.userId,
            keyId: Buffer.from(sealed.keyId),
            nonce: Buffer.from(sealed.nonce),
            sealedSecret: Buffer.from(sealed.sealed),
        });
        const { backupCodeSalt } = await twoStepRepository.ensureTwoStepState(who.userId);
        const codes = generateBackupCodes();
        const hashes = [];
        for (const code of codes)
            hashes.push(Buffer.from(await hashBackupCode({ code, key, salt: backupCodeSalt })));
        const confirmed = await twoStepRepository.confirmTotpFactor({
            userId: who.userId,
            factorId: id,
            step: 1_000,
            sessionTokenHash: sha256(cookie),
            credentialVersion: 1,
            backupCodes: { keyId: Buffer.from(sealed.keyId), hashes },
        });
        if (confirmed.status !== 'ok') throw new Error(`Confirmation ${confirmed.status}.`);
        return { factorId: id, secret: base32(secret), codes: codes.map(formatBackupCode) };
    }

    /* Notices are sent after the reply and not awaited: wait for the ones a test expects. */
    async function notices(kind: string, count = 1) {
        for (let waited = 0; waited < 200; waited++) {
            if (outbox.filter((notice) => notice.kind === kind).length >= count) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return outbox.filter((notice) => notice.kind === kind);
    }

    /* Lets anything still being sent land, for asserting that a notice was not sent. */
    const quiet = () => new Promise((resolve) => setTimeout(resolve, 150));

    return {
        call,
        account,
        signIn,
        passwordProof,
        reset,
        phraseProof,
        giveDeviceKey,
        stepUnder,
        notices,
        quiet,
        outbox,
        emitted,
        state,
        db,
        schema,
        authRepository,
        twoStepRepository,
        sha256,
        serverSetup,
        logging,
        resetDatabase,
        closeDatabase,
    };
}

export type Edge = Awaited<ReturnType<typeof loadEdge>>;
