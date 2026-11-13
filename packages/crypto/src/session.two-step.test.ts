import { client, ready, server } from '@serenity-kit/opaque';
import { describe, expect, test } from 'vitest';
import { RefusedError } from './errors';
import { encryptKey } from './aead';
import { wrappingKey } from './keys';
import {
    accountKeyContext,
    ENVELOPE_VERSION,
    KEY_STRETCHING,
    OPAQUE_IDENTIFIERS,
    OPAQUE_PROFILE_VERSION,
} from './protocol';
import { createIdentity } from './identity';
import { createRecovery } from './recovery';
import { createCryptoSession } from './session';
import {
    recoveryStepKey,
    signTwoStepPhrase,
    stepTokenDigest,
    verifyTwoStepPhrase,
} from './two-step';

/*
 * The recovery phrase as a second step, in the worker (docs/two-step-design.md 5). A sign-in
 * stops between its two halves while the person answers the step: the worker holds what the
 * password gave it and waits for the envelope. Answering with the phrase runs in that same
 * worker, so it must leave that state alone, right phrase or mistyped: otherwise the step
 * passes at the server and the account then fails to open.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const PASSWORD = 'correct horse battery staple';
const STEP_TOKEN = 'k3JtY2hlY2stdGhpcy1pcy1hLXN0ZXAtdG9rZW4tNDNjaGFycw';

async function waitingAtTheStep() {
    await ready;
    const serverSetup = server.createSetup();
    const registration = client.startRegistration({ password: PASSWORD });
    const { registrationResponse } = server.createRegistrationResponse({
        serverSetup,
        userIdentifier: USER,
        registrationRequest: registration.registrationRequest,
    });
    const registered = client.finishRegistration({
        password: PASSWORD,
        clientRegistrationState: registration.clientRegistrationState,
        registrationResponse,
        identifiers: OPAQUE_IDENTIFIERS,
        keyStretching: KEY_STRETCHING,
    });
    // The account key under the password, as the server would hand it over after the step.
    const root = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const encrypted = await encryptKey(
        root,
        await wrappingKey(registered.exportKey, salt),
        nonce,
        accountKeyContext(USER, 1, 1),
    );
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
    const envelope = {
        envelopeVersion: ENVELOPE_VERSION,
        keyVersion: 1,
        credentialVersion: 1,
        wrappingSalt: b64(salt),
        wrappingNonce: b64(nonce),
        encryptedKey: b64(encrypted),
    };
    const made = await createRecovery(root, USER);

    const session = createCryptoSession();
    let id = 0;
    const call = (operation: string, input: unknown) =>
        session.handle({ id: ++id, operation, input } as Parameters<typeof session.handle>[0]);
    // The password's half of a sign-in: everything up to the server's "answer your second step".
    const start = (await call('loginStart', { password: PASSWORD })) as {
        startLoginRequest: string;
    };
    const { loginResponse } = server.startLogin({
        serverSetup,
        userIdentifier: USER,
        registrationRecord: registered.registrationRecord,
        startLoginRequest: start.startLoginRequest,
        identifiers: OPAQUE_IDENTIFIERS,
    });
    await call('loginFinish', { loginResponse, profileVersion: OPAQUE_PROFILE_VERSION });
    const sign = (phrase: string) =>
        call('twoStepPhrase', {
            phrase,
            userId: USER,
            wrappingSalt: made.recovery.wrappingSalt,
            stepToken: STEP_TOKEN,
        }) as Promise<{ signature: string }>;
    const unlock = () => call('unlock', { userId: USER, envelope });
    return { sign, unlock, made };
}

describe('answering the second step with the recovery phrase', () => {
    test('the worker signs what the server checks, and the sign-in waiting at the step still opens the account', async () => {
        const { sign, unlock, made } = await waitingAtTheStep();
        const { signature } = await sign(made.phrase);
        expect(
            await verifyTwoStepPhrase(
                { userId: USER, tokenDigest: await stepTokenDigest(STEP_TOKEN) },
                signature,
                made.recovery.publicKey,
            ),
        ).toBe(true);
        await expect(unlock()).resolves.toEqual({ userId: USER });
    });

    test('a mistyped phrase is a refusal: the waiting sign-in is kept, and the right phrase still passes', async () => {
        const { sign, unlock, made } = await waitingAtTheStep();
        const words = made.phrase.split(' ');
        for (const typed of ['', 'not a phrase', words.slice(0, 23).join(' ')]) {
            // The worker resets on any failure but a refusal, and a reset drops the sign-in.
            await expect(sign(typed)).rejects.toBeInstanceOf(RefusedError);
        }
        expect((await sign(made.phrase)).signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
        await expect(unlock()).resolves.toEqual({ userId: USER });
    });

    test('another account’s phrase signs, and the server’s check is what refuses it', async () => {
        const { sign, made } = await waitingAtTheStep();
        const other = await createRecovery(crypto.getRandomValues(new Uint8Array(32)), USER);
        const { signature } = await sign(other.phrase);
        expect(
            await verifyTwoStepPhrase(
                { userId: USER, tokenDigest: await stepTokenDigest(STEP_TOKEN) },
                signature,
                made.recovery.publicKey,
            ),
        ).toBe(false);
    });
});

/*
 * A reset with the recovery phrase makes a new phrase, and the old one stops working once the
 * server accepts the reset. The worker hands the new words over once, so they reach the
 * person whatever becomes of the sign-in that follows, and so that sign-in's second step can
 * be answered with them.
 */
describe('the phrase a reset makes', () => {
    async function reset() {
        await ready;
        const serverSetup = server.createSetup();
        const root = crypto.getRandomValues(new Uint8Array(32));
        const old = await createRecovery(root.slice(), USER);
        const session = createCryptoSession();
        let id = 0;
        const call = (operation: string, input: unknown) =>
            session.handle({ id: ++id, operation, input } as Parameters<typeof session.handle>[0]);
        const start = (await call('registerStart', { password: 'a new password entirely' })) as {
            registrationRequest: string;
        };
        const { registrationResponse } = server.createRegistrationResponse({
            serverSetup,
            userIdentifier: USER,
            registrationRequest: start.registrationRequest,
        });
        const finished = (await call('recoverFinish', {
            registrationResponse,
            userId: USER,
            profileVersion: OPAQUE_PROFILE_VERSION,
            credentialVersion: 1,
            attemptToken: STEP_TOKEN,
            recovery: old.recovery,
            phrase: old.phrase,
        })) as { recovery: { publicKey: string; wrappingSalt: string; recoveryVersion: number } };
        return { call, old, finished };
    }

    test('is handed over once, and is the phrase of the recovery key the reset sends: it answers a step where the old one does not', async () => {
        const { call, old, finished } = await reset();
        const { phrase } = (await call('recoveredPhrase', {})) as { phrase: string };
        expect(phrase.split(' ')).toHaveLength(24);
        expect(phrase).not.toBe(old.phrase);
        expect(finished.recovery.recoveryVersion).toBe(2);
        const statement = { userId: USER, tokenDigest: await stepTokenDigest(STEP_TOKEN) };
        const sign = async (words: string) =>
            signTwoStepPhrase(await recoveryStepKey(words, finished.recovery.wrappingSalt), {
                userId: USER,
                stepToken: STEP_TOKEN,
            });
        // Checked against the public key the server stores with the reset.
        expect(
            await verifyTwoStepPhrase(statement, await sign(phrase), finished.recovery.publicKey),
        ).toBe(true);
        expect(
            await verifyTwoStepPhrase(
                statement,
                await sign(old.phrase),
                finished.recovery.publicKey,
            ),
        ).toBe(false);
        // Once: nothing of it stays in the worker for a later caller.
        await expect(call('recoveredPhrase', {})).rejects.toBeInstanceOf(RefusedError);
    });

    test('there is none without a reset', async () => {
        const session = createCryptoSession();
        await expect(
            session.handle({ id: 1, operation: 'recoveredPhrase', input: {} } as Parameters<
                typeof session.handle
            >[0]),
        ).rejects.toBeInstanceOf(RefusedError);
    });
});

/*
 * A new recovery phrase, or a new account key, from Account: both replace the phrase, and the
 * worker hands the new words over the same way a reset's are. A password change makes none.
 */
describe('the phrase a rotation makes', () => {
    async function change(action: 'recovery-key' | 'master-key' | 'password') {
        await ready;
        const serverSetup = server.createSetup();
        const registration = client.startRegistration({ password: PASSWORD });
        const registered = client.finishRegistration({
            password: PASSWORD,
            clientRegistrationState: registration.clientRegistrationState,
            registrationResponse: server.createRegistrationResponse({
                serverSetup,
                userIdentifier: USER,
                registrationRequest: registration.registrationRequest,
            }).registrationResponse,
            identifiers: OPAQUE_IDENTIFIERS,
            keyStretching: KEY_STRETCHING,
        });
        const root = crypto.getRandomValues(new Uint8Array(32));
        const salt = crypto.getRandomValues(new Uint8Array(32));
        const nonce = crypto.getRandomValues(new Uint8Array(24));
        const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
        const envelope = {
            envelopeVersion: ENVELOPE_VERSION,
            keyVersion: 1,
            credentialVersion: 1,
            wrappingSalt: b64(salt),
            wrappingNonce: b64(nonce),
            encryptedKey: b64(
                await encryptKey(
                    root,
                    await wrappingKey(registered.exportKey, salt),
                    nonce,
                    accountKeyContext(USER, 1, 1),
                ),
            ),
        };
        const old = await createRecovery(root.slice(), USER);
        const session = createCryptoSession();
        let id = 0;
        const call = (operation: string, input: unknown) =>
            session.handle({ id: ++id, operation, input } as Parameters<typeof session.handle>[0]);
        const start = (await call('securityStart', {
            action,
            password: PASSWORD,
            newPassword: 'another password entirely',
        })) as { startLoginRequest: string; registrationRequest: string };
        const update = (await call('securityFinish', {
            action,
            userId: USER,
            attemptToken: STEP_TOKEN,
            profileVersion: OPAQUE_PROFILE_VERSION,
            loginResponse: server.startLogin({
                serverSetup,
                userIdentifier: USER,
                registrationRecord: registered.registrationRecord,
                startLoginRequest: start.startLoginRequest,
                identifiers: OPAQUE_IDENTIFIERS,
            }).loginResponse,
            registrationResponse: server.createRegistrationResponse({
                serverSetup,
                userIdentifier: USER,
                registrationRequest: start.registrationRequest,
            }).registrationResponse,
            envelope,
            recovery: old.recovery,
            identity: await createIdentity(root.slice(), USER),
            identityHistory: [],
            settingsKey: null,
            workspaces: [],
        })) as { recovery?: { publicKey: string; wrappingSalt: string; recoveryVersion: number } };
        return { call, old, update };
    }

    test.each(['recovery-key', 'master-key'] as const)(
        'a %s change hands its new phrase over once: the phrase of the recovery key it sends, which answers a step where the old one does not',
        async (action) => {
            const { call, old, update } = await change(action);
            const { phrase } = (await call('recoveredPhrase', {})) as { phrase: string };
            expect(phrase.split(' ')).toHaveLength(24);
            expect(phrase).not.toBe(old.phrase);
            expect(update.recovery!.recoveryVersion).toBe(2);
            const statement = { userId: USER, tokenDigest: await stepTokenDigest(STEP_TOKEN) };
            const sign = async (words: string) =>
                signTwoStepPhrase(await recoveryStepKey(words, update.recovery!.wrappingSalt), {
                    userId: USER,
                    stepToken: STEP_TOKEN,
                });
            expect(
                await verifyTwoStepPhrase(
                    statement,
                    await sign(phrase),
                    update.recovery!.publicKey,
                ),
            ).toBe(true);
            expect(
                await verifyTwoStepPhrase(
                    statement,
                    await sign(old.phrase),
                    update.recovery!.publicKey,
                ),
            ).toBe(false);
            await expect(call('recoveredPhrase', {})).rejects.toBeInstanceOf(RefusedError);
        },
    );

    test('a password change makes no new phrase, and hands none over', async () => {
        const { call, update } = await change('password');
        expect(update.recovery).toBeUndefined();
        await expect(call('recoveredPhrase', {})).rejects.toBeInstanceOf(RefusedError);
    });
});
