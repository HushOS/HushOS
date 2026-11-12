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
import { createRecovery } from './recovery';
import { createCryptoSession } from './session';
import { stepTokenDigest, verifyTwoStepPhrase } from './two-step';

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
