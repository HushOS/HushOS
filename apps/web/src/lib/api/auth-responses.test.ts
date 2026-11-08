// @vitest-environment node
import { readFileSync } from 'node:fs';
import { Elysia, type AnySchema } from 'elysia';
import { describe, expect, test } from 'vitest';
import type * as auth from '@hushos/auth/server';
import { OPAQUE_IDENTIFIERS } from '@hushos/crypto';
import { client, ready, server } from '@hushos/crypto/server';
import {
    accountSetupResponse,
    authUserResponse,
    consentStoredResponse,
    contactResponse,
    contactSuccessionResponse,
    deviceResponse,
    devicesRemovedResponse,
    devicesResponse,
    emailSentResponse,
    enrollmentResponse,
    forgottenResponse,
    identityHistoryResponse,
    identityResponse,
    loginChallengeResponse,
    loginResponse,
    profileResponse,
    recoveryBackupResponse,
    recoveryChallengeResponse,
    registrationChallengeResponse,
    securityChallengeResponse,
    sessionResponse,
    settingsKeyStoredResponse,
    settingsResponse,
    settingsSavedResponse,
    setupResponse,
    storageResponse,
    successionResponse,
    successResponse,
    verifiedEnrollmentResponse,
} from '@/lib/api/auth-responses.server';
import { loadApi, type ApiRoute } from '@/test/api-app';

/*
 * Every account and session route's reply schema, through a real Elysia route so normalisation
 * runs as it does in the app: what the auth package returns goes out unchanged (every variant,
 * nulls and absent fields included), a field the schema does not name is dropped, and a reply
 * missing a field the client needs fails instead of going out short. Samples are typed as the
 * package's return types (or, where the handler picks from them, its pick), so a sample that
 * drifts from what the handler returns fails typecheck. OPAQUE messages, tokens and envelopes are
 * compared whole: the clients feed them to OPAQUE and the key derivations byte for byte.
 */

type Reply<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

async function serve(schema: AnySchema, value: unknown) {
    const app = new Elysia().get('/x', { response: { 200: schema } }, () => value as never);
    const response = await app.handle(new Request('http://localhost/x'));
    return {
        status: response.status,
        body: response.ok ? ((await response.json()) as unknown) : null,
    };
}

const clone = <T>(value: T): T => structuredClone(value);
const b64 = (bytes: number, fill = 7) => Buffer.alloc(bytes, fill).toString('base64url');

const identityV1: Reply<typeof auth.getIdentityEnvelope>['identity'] = {
    version: 1,
    keyVersion: 1,
    wrappingSalt: b64(32),
    encryptionPublicKey: b64(32),
    encryptionPrivateKeyNonce: b64(24),
    encryptedEncryptionPrivateKey: b64(48),
    signingPublicKey: b64(32),
    signingSeedNonce: b64(24),
    encryptedSigningSeed: b64(48),
    kem: {
        publicKey: b64(1184),
        seedNonce: b64(24),
        encryptedSeed: b64(80),
        signature: b64(64),
    },
};
const identityV1NoKem: Reply<typeof auth.getIdentityEnvelope>['identity'] = {
    ...identityV1,
    keyVersion: 2,
    kem: null,
};
const identityV2: Reply<typeof auth.getIdentityEnvelope>['identity'] = {
    version: 2,
    keyVersion: 3,
    wrappingSalt: b64(32),
    encryptionPublicKey: b64(32),
    encryptionPrivateKeyNonce: b64(24),
    encryptedEncryptionPrivateKey: b64(48),
    signingPublicKey: b64(32),
    signingSeedNonce: b64(24),
    encryptedSigningSeed: b64(48),
    kem: { publicKey: b64(1184), seedNonce: b64(24), encryptedSeed: b64(80) },
    mlDsa: { publicKey: b64(1952), seedNonce: b64(24), encryptedSeed: b64(48) },
    keysSignature: b64(3373),
};

const userId = '0b5e0d1c-6a4e-4c41-9a43-2b1f4d8f9e10';
const deviceId = '7c2d4f0e-1a3b-4c5d-8e9f-0a1b2c3d4e5f';
const groupId = '3e8b3a4f-9d7b-4f74-8d76-5e4c7abc2b43';

const recovery: Reply<typeof auth.getRecoveryBackup>['recovery'] = {
    version: 1,
    keyVersion: 2,
    recoveryVersion: 3,
    wrappingSalt: b64(32),
    wrappingNonce: b64(24),
    encryptedKey: b64(48),
    backupNonce: b64(24),
    encryptedRecoveryKey: b64(48),
    publicKey: b64(32),
};
const accountKey: Reply<typeof auth.finishLogin>['envelope'] = {
    envelopeVersion: 1,
    keyVersion: 2,
    credentialVersion: 3,
    wrappingSalt: b64(32),
    wrappingNonce: b64(24),
    encryptedKey: b64(48),
};
/* Lengths as serenity-kit makes them: KE2 is 320 bytes, a registration response 64. */
const loginChallenge: Reply<typeof auth.startLogin> = {
    attemptToken: b64(32),
    loginResponse: b64(320),
    profileVersion: 1,
};
const registrationResponse = b64(64);
const device: Reply<typeof auth.registerDevice>['device'] = {
    id: deviceId,
    kind: 'ios',
    name: 'iPhone',
    approvedBy: 'password',
    approvedByDeviceId: null,
    createdAt: '2026-11-08T14:00:00.000Z',
    lastSeenAt: '2026-11-08T14:00:00.000Z',
    current: true,
    signedIn: true,
};
const grant = (workspaceId: string, fill: number) => ({
    version: 1 as const,
    workspaceId,
    keyVersion: 2,
    workspaceKeyVersion: 1,
    wrappingSalt: b64(32, fill),
    wrappingNonce: b64(24, fill),
    encryptedKey: b64(48, fill),
});

const succession: Reply<typeof auth.contactSuccession> = {
    links: [
        {
            oldKeyVersion: 1,
            newKeyVersion: 2,
            oldEncryptionPublicKey: b64(32),
            oldSigningPublicKey: b64(32),
            oldMlDsaPublicKey: b64(1952),
            newEncryptionPublicKey: b64(32, 8),
            newSigningPublicKey: b64(32, 8),
            newMlDsaPublicKey: b64(1952, 8),
            newKemPublicKey: b64(1184, 8),
            signature: b64(3373),
            consent: b64(6746),
        },
        {
            oldKeyVersion: 2,
            newKeyVersion: 3,
            oldEncryptionPublicKey: b64(32, 8),
            oldSigningPublicKey: b64(32, 8),
            oldMlDsaPublicKey: b64(1952, 8),
            newEncryptionPublicKey: b64(32, 9),
            newSigningPublicKey: b64(32, 9),
            newMlDsaPublicKey: b64(1952, 9),
            newKemPublicKey: b64(1184, 9),
            signature: b64(3373, 8),
            consent: null,
        },
    ],
};

/*
 * Per route: the replies the package can give, the object a new column would surface in (a stray
 * field is planted there and at the top), and a field the reply cannot go out without.
 */
type Case = {
    schema: AnySchema;
    samples: Record<string, unknown>;
    stray: (value: any) => Record<string, unknown>;
    /* Which sample to cut, and the cut. */
    required: [string, (value: any) => void];
};
const cases: Record<string, Case> = {
    'GET /auth/setup': {
        schema: accountSetupResponse,
        samples: {
            missing: {
                missing: {
                    recovery: true,
                    identity: false,
                    workspace: true,
                    workspaceKey: true,
                    workspaceId: null,
                },
            } satisfies Reply<typeof auth.getAccountSetup>,
            complete: {
                missing: {
                    recovery: false,
                    identity: false,
                    workspace: false,
                    workspaceKey: false,
                    workspaceId: deviceId,
                },
            } satisfies Reply<typeof auth.getAccountSetup>,
            'no user row': { missing: null } satisfies Reply<typeof auth.getAccountSetup>,
        },
        stray: (v) => v.missing ?? v,
        required: ['missing', (v) => delete v.missing.workspaceId],
    },
    'GET /auth/register and /auth/recover': {
        schema: enrollmentResponse,
        samples: {
            enrollment: {
                enrollment: { id: userId, email: 'ada@example.com', profileVersion: 1 },
            } satisfies { enrollment: Reply<typeof auth.getEnrollment> },
            none: { enrollment: null } satisfies { enrollment: Reply<typeof auth.getEnrollment> },
        },
        stray: (v) => v.enrollment ?? v,
        required: ['enrollment', (v) => delete v.enrollment.email],
    },
    'GET /auth/storage': {
        schema: storageResponse,
        samples: {
            own: {
                storage: {
                    workspaceId: deviceId,
                    quotaBytes: '5368709120',
                    usedBytes: '123456789',
                    reservedBytes: '1024',
                    availableBytes: '5245251307',
                    pool: null,
                    own: null,
                },
            } satisfies Reply<typeof auth.getStorageAllowance>,
            pool: {
                storage: {
                    workspaceId: deviceId,
                    // Past 2^53: the reason these are strings.
                    quotaBytes: '10995116277760000',
                    usedBytes: '2147483648',
                    reservedBytes: '0',
                    availableBytes: '10995114130276352',
                    pool: { groupId: userId, name: 'The Lovelaces' },
                    own: { usedBytes: '1999999999', allowanceBytes: '5368709120' },
                },
            } satisfies Reply<typeof auth.getStorageAllowance>,
            none: { storage: null } satisfies Reply<typeof auth.getStorageAllowance>,
        },
        stray: (v) => v.storage ?? v,
        required: ['pool', (v) => delete v.storage.own.allowanceBytes],
    },
    'GET /auth/recovery-key': {
        schema: recoveryBackupResponse,
        samples: {
            backup: {
                userId,
                recovery: {
                    version: 1,
                    keyVersion: 2,
                    recoveryVersion: 3,
                    wrappingSalt: b64(32),
                    wrappingNonce: b64(24),
                    encryptedKey: b64(48),
                    backupNonce: b64(24),
                    encryptedRecoveryKey: b64(48),
                    publicKey: b64(32),
                },
                confirmed: false,
            } satisfies Reply<typeof auth.getRecoveryBackup>,
        },
        stray: (v) => v.recovery,
        required: ['backup', (v) => delete v.recovery.encryptedKey],
    },
    'GET /auth/identity': {
        schema: identityResponse,
        samples: {
            'version 2': { identity: identityV2 } satisfies Reply<typeof auth.getIdentityEnvelope>,
            'version 1 with a KEM key': { identity: identityV1 } satisfies Reply<
                typeof auth.getIdentityEnvelope
            >,
            'version 1 without one': { identity: identityV1NoKem } satisfies Reply<
                typeof auth.getIdentityEnvelope
            >,
        },
        stray: (v) => v.identity,
        required: ['version 2', (v) => delete v.identity.keysSignature],
    },
    'GET /auth/identity/history': {
        schema: identityHistoryResponse,
        samples: {
            history: { identities: [identityV1NoKem, identityV1, identityV2] } satisfies Reply<
                typeof auth.getIdentityHistory
            >,
            empty: { identities: [] } satisfies Reply<typeof auth.getIdentityHistory>,
        },
        stray: (v) => v.identities[2] ?? v,
        required: ['history', (v) => delete v.identities[2].mlDsa],
    },
    'GET /auth/contacts/:userId/succession': {
        schema: contactSuccessionResponse,
        samples: {
            links: succession,
            none: { links: [] } satisfies Reply<typeof auth.contactSuccession>,
        },
        stray: (v) => v.links[1] ?? v,
        required: ['links', (v) => delete v.links[1].consent],
    },
    'GET /auth/settings': {
        schema: settingsResponse,
        samples: {
            stored: {
                settings: { version: 2, settingsVersion: 4, nonce: b64(24), ciphertext: b64(400) },
                settingsKey: { nonce: b64(24), ciphertext: b64(48) },
                settingsVersion: 4,
            } satisfies Reply<typeof auth.getSettings>,
            'version 1 stored': {
                settings: null,
                settingsKey: null,
                settingsVersion: 3,
            } satisfies Reply<typeof auth.getSettings>,
            nothing: { settings: null, settingsKey: null, settingsVersion: 0 } satisfies Reply<
                typeof auth.getSettings
            >,
        },
        stray: (v) => v.settingsKey ?? v,
        required: ['stored', (v) => delete v.settingsVersion],
    },
    'GET /auth/session': {
        schema: sessionResponse,
        samples: {
            'signed in': {
                user: {
                    id: userId,
                    name: 'Ada',
                    email: 'ada@example.com',
                    role: 'member',
                    credentialVersion: 2,
                },
                device: { id: deviceId, registered: true },
            } satisfies Reply<typeof auth.sessionState>,
            // The bare signed-out variant matches this too: tried first, normalisation would
            // strip `removed` and the device would never wipe what it kept.
            removed: { user: null, device: null, removed: true } satisfies Reply<
                typeof auth.sessionState
            >,
            'signed out': { user: null, device: null } satisfies Reply<typeof auth.sessionState>,
        },
        stray: (v) => v.user ?? v,
        required: ['signed in', (v) => delete v.user.credentialVersion],
    },
    'GET /auth/devices': {
        schema: devicesResponse,
        samples: {
            devices: {
                devices: [
                    {
                        id: deviceId,
                        kind: 'web',
                        name: 'Firefox on Mac',
                        approvedBy: 'password',
                        approvedByDeviceId: null,
                        createdAt: '2026-11-01T09:00:00.000Z',
                        lastSeenAt: '2026-11-08T14:00:00.000Z',
                        current: true,
                        signedIn: true,
                    },
                    {
                        id: userId,
                        kind: null,
                        name: null,
                        approvedBy: 'device',
                        approvedByDeviceId: deviceId,
                        createdAt: '2026-11-02T10:00:00.000Z',
                        lastSeenAt: '2026-11-02T10:00:00.000Z',
                        current: false,
                        signedIn: false,
                    },
                ],
            } satisfies Reply<typeof auth.listDevices>,
            'none but this one, unapproved fields null': {
                devices: [
                    {
                        id: deviceId,
                        kind: 'android',
                        name: 'Pixel',
                        approvedBy: null,
                        approvedByDeviceId: null,
                        createdAt: '2026-11-01T09:00:00.000Z',
                        lastSeenAt: '2026-11-01T09:00:00.000Z',
                        current: true,
                        signedIn: true,
                    },
                ],
            } satisfies Reply<typeof auth.listDevices>,
        },
        stray: (v) => v.devices[0],
        required: ['devices', (v) => delete v.devices[1].current],
    },

    /* --------------------------------------------------------------------- */
    /* Registration, sign-in, recovery */

    'POST /auth/register/email and /auth/recover/email': {
        schema: emailSentResponse,
        samples: {
            sent: {
                message: 'Check your inbox for a verification link.',
            } satisfies Reply<typeof auth.requestRegistrationEmail>,
        },
        stray: (v) => v,
        required: ['sent', (v) => delete v.message],
    },
    'POST /auth/register/verify': {
        schema: verifiedEnrollmentResponse,
        samples: {
            register: {
                enrollment: { id: userId, email: 'ada@example.com', purpose: 'register' },
            } satisfies Pick<Reply<typeof auth.verifyEmail>, 'enrollment'>,
            recover: {
                enrollment: { id: userId, email: 'ada@example.com', purpose: 'recover' },
            } satisfies Pick<Reply<typeof auth.verifyEmail>, 'enrollment'>,
        },
        stray: (v) => v.enrollment,
        // Both phones refuse a link opened in the wrong flow by this field.
        required: ['recover', (v) => delete v.enrollment.purpose],
    },
    'POST /auth/register/start': {
        schema: registrationChallengeResponse,
        samples: {
            challenge: {
                registrationResponse,
                userId,
                profileVersion: 1,
            } satisfies Reply<typeof auth.startRegistration>,
        },
        stray: (v) => v,
        required: ['challenge', (v) => delete v.registrationResponse],
    },
    'POST /auth/register/finish and /auth/recover/finish': {
        schema: authUserResponse,
        samples: {
            registered: {
                user: { id: userId, name: 'Ada', email: 'ada@example.com', role: 'member' },
            } satisfies Reply<typeof auth.finishRegistration>,
            recovered: {
                user: { id: userId, name: 'Ada', email: 'ada@example.com', role: 'admin' },
            } satisfies Reply<typeof auth.finishRecovery>,
        },
        stray: (v) => v.user,
        required: ['registered', (v) => delete v.user.id],
    },
    'POST /auth/login/start, /auth/devices/reauth and /auth/delete/start': {
        schema: loginChallengeResponse,
        samples: {
            'sign-in': loginChallenge satisfies Reply<typeof auth.startLogin>,
            'device removal': {
                ...loginChallenge,
                attemptToken: b64(32, 8),
            } satisfies Reply<typeof auth.startDeviceRemoval>,
            deletion: {
                ...loginChallenge,
                attemptToken: b64(32, 9),
            } satisfies Reply<typeof auth.startAccountDeletion>,
        },
        stray: (v) => v,
        required: ['sign-in', (v) => delete v.loginResponse],
    },
    'POST /auth/login/finish': {
        schema: loginResponse,
        samples: {
            'a new device': {
                user: { id: userId, name: 'Ada', email: 'ada@example.com', role: 'member' },
                envelope: accountKey,
                device: { id: deviceId, attached: false, registered: false },
            } satisfies Pick<Reply<typeof auth.finishLogin>, 'user' | 'envelope' | 'device'>,
            'a device its key brought back': {
                user: { id: userId, name: 'Ada', email: 'ada@example.com', role: 'admin' },
                envelope: accountKey,
                device: { id: deviceId, attached: true, registered: true },
            } satisfies Pick<Reply<typeof auth.finishLogin>, 'user' | 'envelope' | 'device'>,
        },
        stray: (v) => v.envelope,
        required: ['a new device', (v) => delete v.envelope.encryptedKey],
    },
    'POST /auth/recover/start': {
        schema: recoveryChallengeResponse,
        samples: {
            challenge: {
                registrationResponse,
                attemptToken: b64(32),
                userId,
                credentialVersion: 3,
                profileVersion: 1,
                recovery,
            } satisfies Reply<typeof auth.startRecovery>,
        },
        stray: (v) => v.recovery,
        required: ['challenge', (v) => delete v.recovery.encryptedRecoveryKey],
    },
    'POST /auth/security/start': {
        schema: securityChallengeResponse,
        samples: {
            // A master-key rotation on an account with a family area, earlier identities and settings.
            'everything to re-wrap': {
                ...loginChallenge,
                registrationResponse,
                action: 'master-key',
                userId,
                envelope: accountKey,
                recovery,
                workspaces: [
                    { ...grant(deviceId, 7), groupId: null },
                    { ...grant(userId, 8), groupId },
                ],
                identity: identityV2,
                identityHistory: [identityV1NoKem, identityV1],
                settingsKey: { nonce: b64(24), ciphertext: b64(48) },
            } satisfies Reply<typeof auth.startSecurityChange>,
            'a password change on a new account': {
                ...loginChallenge,
                registrationResponse,
                action: 'password',
                userId,
                envelope: accountKey,
                recovery,
                workspaces: [{ ...grant(deviceId, 7), groupId: null }],
                identity: identityV2,
                identityHistory: [],
                settingsKey: null,
            } satisfies Reply<typeof auth.startSecurityChange>,
            // SecurityWorkspaceGrant allows the group absent; the server always sends it.
            'a grant without its group': {
                ...loginChallenge,
                registrationResponse,
                action: 'recovery-key',
                userId,
                envelope: accountKey,
                recovery,
                workspaces: [grant(deviceId, 7)],
                identity: identityV1,
                identityHistory: [],
                settingsKey: null,
            } satisfies Reply<typeof auth.startSecurityChange>,
        },
        stray: (v) => v.workspaces[1] ?? v.workspaces[0],
        required: ['everything to re-wrap', (v) => delete v.identityHistory],
    },
    'POST /auth/security/finish, /auth/delete/finish, /auth/recovery-key/confirm, /auth/logout': {
        schema: successResponse,
        samples: {
            'security change': { success: true } satisfies Reply<typeof auth.finishSecurityChange>,
            deletion: { success: true } satisfies Reply<typeof auth.finishAccountDeletion>,
            confirmed: { success: true } satisfies Reply<typeof auth.confirmRecoveryBackup>,
        },
        stray: (v) => v,
        required: ['confirmed', (v) => delete v.success],
    },

    /* --------------------------------------------------------------------- */
    /* Setup, profile, identity, contacts, settings, devices */

    'POST /auth/setup': {
        schema: setupResponse,
        samples: { done: { ok: true } satisfies Reply<typeof auth.initializeAccount> },
        stray: (v) => v,
        required: ['done', (v) => delete v.ok],
    },
    'POST /auth/profile': {
        schema: profileResponse,
        samples: {
            renamed: {
                user: {
                    id: userId,
                    name: 'Ada Lovelace',
                    email: 'ada@example.com',
                    role: 'member',
                    credentialVersion: 2,
                },
            } satisfies Reply<typeof auth.updateProfile>,
        },
        stray: (v) => v.user,
        required: ['renamed', (v) => delete v.user.credentialVersion],
    },
    'POST /auth/identity/upgrade': {
        schema: identityResponse,
        samples: {
            upgraded: { identity: identityV2 } satisfies Reply<typeof auth.upgradeIdentity>,
        },
        stray: (v) => v.identity.mlDsa,
        required: ['upgraded', (v) => delete v.identity.mlDsa.encryptedSeed],
    },
    'POST /auth/identity/succession': {
        schema: successionResponse,
        samples: { succeeded: { keyVersion: 4 } satisfies Reply<typeof auth.succeedIdentity> },
        stray: (v) => v,
        required: ['succeeded', (v) => delete v.keyVersion],
    },
    'POST /auth/identity/succession/consent': {
        schema: consentStoredResponse,
        samples: {
            stored: { stored: true } satisfies Reply<typeof auth.backfillSuccessionConsent>,
            'already there': {
                stored: false,
            } satisfies Reply<typeof auth.backfillSuccessionConsent>,
        },
        stray: (v) => v,
        required: ['already there', (v) => delete v.stored],
    },
    'POST /auth/contacts/lookup': {
        schema: contactResponse,
        samples: {
            'version 2': {
                contact: {
                    userId,
                    name: 'Grace',
                    email: 'grace@example.com',
                    keyVersion: 3,
                    identityVersion: 2,
                    encryptionPublicKey: b64(32),
                    signingPublicKey: b64(32),
                    mlDsaPublicKey: b64(1952),
                    kemPublicKey: b64(1184),
                    keysSignature: b64(3373),
                },
            } satisfies Reply<typeof auth.lookupContact>,
            'version 1, no KEM key': {
                contact: {
                    userId,
                    name: 'Grace',
                    email: 'grace@example.com',
                    keyVersion: 1,
                    identityVersion: 1,
                    encryptionPublicKey: b64(32),
                    signingPublicKey: b64(32),
                    mlDsaPublicKey: null,
                    kemPublicKey: null,
                    keysSignature: null,
                },
            } satisfies Reply<typeof auth.lookupContact>,
        },
        stray: (v) => v.contact,
        required: ['version 1, no KEM key', (v) => delete v.contact.kemPublicKey],
    },
    'PUT /auth/settings-key': {
        schema: settingsKeyStoredResponse,
        samples: { stored: { ok: true } satisfies Reply<typeof auth.putSettingsKey> },
        stray: (v) => v,
        required: ['stored', (v) => delete v.ok],
    },
    'PUT /auth/settings': {
        schema: settingsSavedResponse,
        samples: { saved: { settingsVersion: 5 } satisfies Reply<typeof auth.putSettings> },
        stray: (v) => v,
        required: ['saved', (v) => delete v.settingsVersion],
    },
    'POST /auth/session/forget': {
        schema: forgottenResponse,
        samples: {
            forgotten: { forgotten: true } satisfies {
                forgotten: Reply<typeof auth.mayForgetSession>;
            },
            kept: { forgotten: false } satisfies { forgotten: Reply<typeof auth.mayForgetSession> },
        },
        stray: (v) => v,
        required: ['kept', (v) => delete v.forgotten],
    },
    'POST /auth/devices and PUT /auth/devices/:id': {
        schema: deviceResponse,
        samples: {
            registered: { device } satisfies Reply<typeof auth.registerDevice>,
            'renamed, another device': {
                device: {
                    ...device,
                    kind: null,
                    name: 'Old laptop',
                    approvedBy: 'device',
                    approvedByDeviceId: userId,
                    current: false,
                    signedIn: false,
                },
            } satisfies Reply<typeof auth.renameDevice>,
        },
        stray: (v) => v.device,
        required: ['registered', (v) => delete v.device.approvedBy],
    },
    'DELETE /auth/devices/:id and /auth/devices/others': {
        schema: devicesRemovedResponse,
        samples: {
            one: { removed: 1 } satisfies Pick<Reply<typeof auth.removeDevice>, 'removed'>,
            none: { removed: 0 } satisfies Pick<Reply<typeof auth.removeOtherDevices>, 'removed'>,
        },
        stray: (v) => v,
        required: ['one', (v) => delete v.removed],
    },
};

describe.each(Object.entries(cases))('%s', (_route, { schema, samples, stray, required }) => {
    test.each(Object.entries(samples))('goes out unchanged: %s', async (_name, sample) => {
        expect(await serve(schema, sample)).toEqual({ status: 200, body: sample });
    });

    test.each(Object.entries(samples))(
        'drops a field the schema does not name: %s',
        async (_name, sample) => {
            const planted = clone(sample) as Record<string, unknown>;
            planted.leaked = 'top';
            stray(planted).signingPrivateKey = 'nested';
            const { status, body } = await serve(schema, planted);
            expect(status).toBe(200);
            expect(body).toEqual(sample);
            expect(JSON.stringify(body)).not.toMatch(/leaked|signingPrivateKey/);
        },
    );

    test('fails rather than send a reply missing a required field', async () => {
        const [name, cut] = required;
        const short = clone(samples[name]);
        cut(short);
        expect((await serve(schema, short)).status).toBe(500);
    });
});

/* A field typed as one of a set: a value outside it fails rather than going out. */
test('refuses a role, device kind, security action or identity version outside its set', async () => {
    const user = clone(cases['GET /auth/session']!.samples['signed in']) as any;
    user.user.role = 'owner';
    expect((await serve(sessionResponse, user)).status).toBe(500);
    const devices = clone(cases['GET /auth/devices']!.samples.devices) as any;
    devices.devices[0].kind = 'windows';
    expect((await serve(devicesResponse, devices)).status).toBe(500);
    const challenge = clone(
        cases['POST /auth/security/start']!.samples['everything to re-wrap'],
    ) as any;
    challenge.action = 'delete';
    expect((await serve(securityChallengeResponse, challenge)).status).toBe(500);
    const contact = clone(cases['POST /auth/contacts/lookup']!.samples['version 2']) as any;
    contact.contact.identityVersion = 3;
    expect((await serve(contactResponse, contact)).status).toBe(500);
});

/*
 * Sign-in gives an unknown address a decoy KE2, so the reply does not say who has an account.
 * The schema must keep it that way: the real and the decoy challenge go out with the same keys, in
 * the same order, every value the same length. Both come from OPAQUE's server.startLogin, the
 * real one with the stored record and the decoy without one, as auth's startLogin calls it.
 * (Sign-up and recovery return one constant object on both paths; auth's own tests cover that.)
 */
const sameShape = (a: unknown, b: unknown) => {
    const shape = (value: unknown) =>
        Object.entries(value as Record<string, unknown>).map(([key, field]) => [
            key,
            typeof field,
            String(field).length,
        ]);
    expect(shape(a)).toEqual(shape(b));
    expect(JSON.stringify(a).length).toBe(JSON.stringify(b).length);
};

test("sign-in's decoy challenge goes out exactly as wide as a real one", async () => {
    await ready;
    const serverSetup = server.createSetup();
    const password = 'correct horse battery staple';
    const registration = client.startRegistration({ password });
    const { registrationResponse: response } = server.createRegistrationResponse({
        serverSetup,
        userIdentifier: userId,
        registrationRequest: registration.registrationRequest,
    });
    const { registrationRecord } = client.finishRegistration({
        password,
        registrationResponse: response,
        clientRegistrationState: registration.clientRegistrationState,
        identifiers: OPAQUE_IDENTIFIERS,
    });
    const challenge = (record: string | null, userIdentifier: string) => {
        const { startLoginRequest } = client.startLogin({ password });
        const { loginResponse } = server.startLogin({
            serverSetup,
            userIdentifier,
            registrationRecord: record,
            startLoginRequest,
            identifiers: OPAQUE_IDENTIFIERS,
        });
        return {
            attemptToken: b64(32, Math.floor(Math.random() * 256)),
            loginResponse,
            profileVersion: 1,
        } satisfies Reply<typeof auth.startLogin>;
    };
    const real = await serve(loginChallengeResponse, challenge(registrationRecord, userId));
    const decoy = await serve(
        loginChallengeResponse,
        challenge(null, Buffer.alloc(32, 3).toString('hex')),
    );
    expect(real.status).toBe(200);
    expect(decoy.status).toBe(200);
    sameShape(real.body, decoy.body);
});

/*
 * Role and approval kind are closed sets in the response, so a value the database later allows
 * but the schema does not would turn sign-in and the device list into a 500 after the write has
 * committed (a phone that cannot read its own device back registers again on every sign-in).
 * Each set must be exactly the one the database's check constraint allows.
 */
const allowedByCheck = (name: string) => {
    const source = readFileSync(
        new URL('../../../../../packages/db/src/schema/auth.ts', import.meta.url),
        'utf8',
    );
    const check = source.slice(source.indexOf(`'${name}'`));
    const list = /\bin \(([^)]*)\)/.exec(check.slice(0, check.indexOf('),')))?.[1];
    expect(list, name).toBeDefined();
    return [...list!.matchAll(/'([^']*)'/g)]
        .map((match) => match[1])
        .sort((a, b) => a.localeCompare(b));
};
const literals = (schema: unknown): string[] =>
    JSON.stringify(schema)
        .match(/"const":"[^"]*"/g)!
        .map((entry) => entry.slice(9, -1))
        .sort((a, b) => a.localeCompare(b));

test('role and approval kind allow exactly what the database allows', () => {
    const session = sessionResponse.anyOf[0].properties.user.properties;
    const device = devicesResponse.properties.devices.items.properties;
    expect(literals(session.role)).toEqual(allowedByCheck('users_role_valid'));
    expect(literals(authUserResponse.properties.user.properties.role)).toEqual(
        allowedByCheck('users_role_valid'),
    );
    expect(literals(device.approvedBy)).toEqual(
        allowedByCheck('account_devices_approved_by_valid'),
    );
    expect(literals(device.kind)).toEqual(allowedByCheck('account_devices_kind_valid'));
});

/* The schemas guard nothing unless the routes carry them: every auth route names its own. */
const expectedSchemas: Record<string, { 200: AnySchema }> = {
    'GET /api/auth/setup': { 200: accountSetupResponse },
    'POST /api/auth/setup': { 200: setupResponse },
    'POST /api/auth/register/email': { 200: emailSentResponse },
    'POST /api/auth/register/verify': { 200: verifiedEnrollmentResponse },
    'GET /api/auth/register': { 200: enrollmentResponse },
    'POST /api/auth/register/start': { 200: registrationChallengeResponse },
    'POST /api/auth/register/finish': { 200: authUserResponse },
    'POST /api/auth/login/start': { 200: loginChallengeResponse },
    'POST /api/auth/login/finish': { 200: loginResponse },
    'POST /api/auth/recover/email': { 200: emailSentResponse },
    'GET /api/auth/recover': { 200: enrollmentResponse },
    'POST /api/auth/recover/start': { 200: recoveryChallengeResponse },
    'POST /api/auth/recover/finish': { 200: authUserResponse },
    'POST /api/auth/delete/start': { 200: loginChallengeResponse },
    'POST /api/auth/delete/finish': { 200: successResponse },
    'POST /api/auth/security/start': { 200: securityChallengeResponse },
    'POST /api/auth/security/finish': { 200: successResponse },
    'GET /api/auth/storage': { 200: storageResponse },
    'GET /api/auth/recovery-key': { 200: recoveryBackupResponse },
    'POST /api/auth/recovery-key/confirm': { 200: successResponse },
    'GET /api/auth/identity': { 200: identityResponse },
    'POST /api/auth/identity/upgrade': { 200: identityResponse },
    'POST /api/auth/identity/succession': { 200: successionResponse },
    'POST /api/auth/identity/succession/consent': { 200: consentStoredResponse },
    'GET /api/auth/identity/history': { 200: identityHistoryResponse },
    'GET /api/auth/contacts/:userId/succession': { 200: contactSuccessionResponse },
    'POST /api/auth/contacts/lookup': { 200: contactResponse },
    'GET /api/auth/settings': { 200: settingsResponse },
    'PUT /api/auth/settings-key': { 200: settingsKeyStoredResponse },
    'PUT /api/auth/settings': { 200: settingsSavedResponse },
    'GET /api/auth/session': { 200: sessionResponse },
    'POST /api/auth/session/forget': { 200: forgottenResponse },
    'GET /api/auth/devices': { 200: devicesResponse },
    'POST /api/auth/devices': { 200: deviceResponse },
    'POST /api/auth/devices/reauth': { 200: loginChallengeResponse },
    'DELETE /api/auth/devices/others': { 200: devicesRemovedResponse },
    'PUT /api/auth/devices/:id': { 200: deviceResponse },
    'DELETE /api/auth/devices/:id': { 200: devicesRemovedResponse },
    'POST /api/auth/profile': { 200: profileResponse },
    'POST /api/auth/logout': { 200: successResponse },
};
/*
 * Routes deliberately served without a schema, each with its reason. None today: every handler
 * answers 200 with a reply built field by field, the OPAQUE messages included (serenity-kit's
 * results carry the one message each, spread in by name).
 */
const leftOut: Record<string, string> = {};

test('each auth route carries its reply schema', async () => {
    const app = await loadApi();
    const routes = (
        app.routes as unknown as (ApiRoute & { hooks: { response?: unknown } })[]
    ).filter((r) => r.path.startsWith('/api/auth/'));
    for (const [key, statuses] of Object.entries(expectedSchemas)) {
        const [method, path] = key.split(' ');
        const route = routes.find((r) => r.method === method && r.path === path);
        expect(route, key).toBeDefined();
        const response = route!.hooks.response as Record<number, unknown>;
        // A status the route answers with but has no schema for goes out unchecked.
        expect(Object.keys(response).sort(), key).toEqual(Object.keys(statuses).sort());
        // Elysia keeps a copy of each schema, so equal in structure. Routes sharing a reply share
        // its schema; any two different schemas differ in shape.
        for (const [status, schema] of Object.entries(statuses))
            expect(response[Number(status)], `${key} ${status}`).toEqual(schema);
    }
    // A route added later without a schema, or one this list forgot, fails here.
    const unlisted = routes
        .map((r) => `${r.method} ${r.path}`)
        .filter((key) => !(key in expectedSchemas) && !(key in leftOut));
    expect(unlisted).toEqual([]);
});
