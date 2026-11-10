import { readFileSync } from 'node:fs';
import { client, ready, server } from '@serenity-kit/opaque';
import { describe, expect, test } from 'vitest';
import { encryptKey } from './aead';
import { createDeviceKey, rememberAccountKey } from './device';
import { RefusedError } from './errors';
import { encode, wrappingKey } from './keys';
import {
    accountKeyContext,
    KEY_STRETCHING,
    OPAQUE_IDENTIFIERS,
    OPAQUE_PROFILE_VERSION,
} from './protocol';
import { createCryptoSession } from './session';
import { createIdentity } from './identity';
import { createRecovery } from './recovery';
import type { SecurityUpdate } from './security';
import { verifyTwoStepPhrase } from './two-step';
import { createWorkspaceGrant } from './workspace';

/*
 * The recovery phrase answering the second step, in the worker
 * (docs/two-step-design.md 5). At sign-in the worker is holding the password's
 * export key while the person types the phrase: the answer it signs must be the
 * one the server checks, and a phrase with a typo must be a refusal that keeps
 * that sign-in (and, at a change, the open account), not the failure that
 * resets the worker and sends the person back to their password.
 */
const fixture = JSON.parse(
    readFileSync(
        new URL('../../../crates/hushos-core/fixtures/web-two-step.json', import.meta.url),
        'utf8',
    ),
).phrase as {
    userId: string;
    phrase: string;
    wrappingSalt: string;
    stepToken: string;
    publicKey: string;
    signature: string;
};

const USER = fixture.userId;
const WS = '22222222-2222-4222-8222-222222222222';
const PASSWORD = 'correct horse battery staple';

function worker() {
    const session = createCryptoSession();
    let id = 0;
    const call = (operation: string, input: unknown) =>
        session.handle({ id: ++id, operation, input } as Parameters<typeof session.handle>[0]);
    const sign = (phrase: string, step: Partial<typeof fixture> = {}) =>
        call('twoStepPhrase', {
            phrase,
            userId: step.userId ?? fixture.userId,
            stepToken: step.stepToken ?? fixture.stepToken,
            wrappingSalt: step.wrappingSalt ?? fixture.wrappingSalt,
        }) as Promise<{ signature: string }>;
    return { call, sign };
}

/* A sign-in as far as the step: the password checked, the export key held, nothing unlocked yet. */
async function signInToTheStep() {
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
    // The account key as sign-up wraps it, under the password's export key.
    const root = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const key = await wrappingKey(registered.exportKey, salt);
    const envelope = {
        envelopeVersion: 1 as const,
        keyVersion: 1,
        credentialVersion: 1,
        wrappingSalt: encode(salt),
        wrappingNonce: encode(nonce),
        encryptedKey: encode(await encryptKey(root, key, nonce, accountKeyContext(USER, 1, 1))),
    };
    const { call, sign } = worker();
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
    return { sign, unlock: () => call('unlock', { userId: USER, envelope }) };
}

describe('the recovery phrase answering the second step, in the worker', () => {
    test('signs the answer the server checks: this token, this account, this phrase', async () => {
        const { sign } = worker();
        const { signature } = await sign(fixture.phrase);
        // The bytes the Rust core must produce too.
        expect(signature).toBe(fixture.signature);
        expect(await verifyTwoStepPhrase(fixture, signature, fixture.publicKey)).toBe(true);
        // An answer made for one step does not pass another, or another account's.
        const other = await sign(fixture.phrase, { stepToken: `${fixture.stepToken}x` });
        expect(await verifyTwoStepPhrase(fixture, other.signature, fixture.publicKey)).toBe(false);
        const stranger = await sign(fixture.phrase, {
            userId: '33333333-3333-4333-8333-333333333333',
        });
        expect(await verifyTwoStepPhrase(fixture, stranger.signature, fixture.publicKey)).toBe(
            false,
        );
    });

    test('reads the phrase as a person types it: capitals, line breaks and extra spaces', async () => {
        const { sign } = worker();
        const typed = `  ${fixture.phrase.toUpperCase().split(' ').join('\n  ')} `;
        expect((await sign(typed)).signature).toBe(fixture.signature);
    });

    test('a mistyped phrase is refused without losing the sign-in that waits on it', async () => {
        const { sign, unlock } = await signInToTheStep();
        const words = fixture.phrase.split(' ');
        for (const typed of [
            words.slice(0, 23).join(' '),
            [...words.slice(0, 23), 'zzzz'].join(' '),
            '',
        ])
            await expect(sign(typed), typed).rejects.toBeInstanceOf(RefusedError);
        // The export key is still there: the corrected phrase signs, and the envelope opens.
        expect((await sign(fixture.phrase)).signature).toBe(fixture.signature);
        await expect(unlock()).resolves.toEqual({ userId: USER });
    });

    test('a mistyped phrase at a change leaves the open account open', async () => {
        const root = crypto.getRandomValues(new Uint8Array(32));
        const deviceKey = await createDeviceKey();
        const bundle = await rememberAccountKey(root, deviceKey, {
            userId: USER,
            keyVersion: 1,
            credentialVersion: 1,
            deviceKeyId: 'device',
        });
        const { call, sign } = worker();
        await call('restore', { deviceKey, bundle });
        const grant = await createWorkspaceGrant(root, USER, WS, 1);
        await expect(sign('not a phrase at all')).rejects.toBeInstanceOf(RefusedError);
        // Only an unlocked root opens a workspace grant.
        await expect(call('driveOpenWorkspace', { userId: USER, grant })).resolves.toBeDefined();
    });
});

/*
 * After a password change the server ends every session and opens the one this device
 * carries on in, with the change (docs/two-step-design.md 4). The worker must then open the
 * account from the envelope the server answers with, on the new password's key, without the
 * password being typed again: a sign-in there could ask for a second step the person can no
 * longer answer.
 */
describe('carrying on after a security change, in the worker', () => {
    async function changed(action: 'password' | 'master-key') {
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
        const old = {
            envelopeVersion: 1 as const,
            keyVersion: 1,
            credentialVersion: 1,
            wrappingSalt: encode(salt),
            wrappingNonce: encode(nonce),
            encryptedKey: encode(
                await encryptKey(
                    root,
                    await wrappingKey(registered.exportKey, salt),
                    nonce,
                    accountKeyContext(USER, 1, 1),
                ),
            ),
        };
        const grant = await createWorkspaceGrant(root, USER, WS, 1);
        const { call } = worker();
        const start = (await call('securityStart', {
            action,
            password: PASSWORD,
            newPassword: 'a new password for the account',
        })) as { startLoginRequest: string; registrationRequest: string };
        const update = (await call('securityFinish', {
            action,
            userId: USER,
            attemptToken: 'attempt',
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
            envelope: old,
            recovery: (await createRecovery(root, USER, 1, 1)).recovery,
            identity: await createIdentity(root, USER),
            workspaces: [grant],
        })) as SecurityUpdate;
        return { call, old, update, grant };
    }

    test('opens the account from the envelope the change made, with no password typed again', async () => {
        const { call, update, grant } = await changed('password');
        expect(update.envelope).toMatchObject({ keyVersion: 1, credentialVersion: 2 });
        await expect(call('unlock', { userId: USER, envelope: update.envelope })).resolves.toEqual({
            userId: USER,
        });
        // The same root as before the change: what it wrapped still opens.
        await expect(call('driveOpenWorkspace', { userId: USER, grant })).resolves.toBeDefined();
    });

    test('after a rotation it is the new root that is open', async () => {
        const { call, update, grant } = await changed('master-key');
        await expect(call('unlock', { userId: USER, envelope: update.envelope })).resolves.toEqual({
            userId: USER,
        });
        // The grant as it was before the rotation no longer opens; the re-wrapped one does.
        await expect(call('driveOpenWorkspace', { userId: USER, grant })).rejects.toThrow();
        await expect(
            call('driveOpenWorkspace', { userId: USER, grant: update.workspaces![0] }),
        ).resolves.toBeDefined();
    });

    test('opens nothing from an envelope the change did not make', async () => {
        const { call, old } = await changed('password');
        await expect(call('unlock', { userId: USER, envelope: old })).rejects.toThrow();
    });
});
