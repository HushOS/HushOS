// @vitest-environment node
import { Elysia, type AnySchema } from 'elysia';
import { describe, expect, test } from 'vitest';
import type * as auth from '@hushos/auth/server';
import {
    accountSetupResponse,
    contactSuccessionResponse,
    devicesResponse,
    enrollmentResponse,
    identityHistoryResponse,
    identityResponse,
    recoveryBackupResponse,
    sessionResponse,
    settingsResponse,
    storageResponse,
} from '@/lib/api/auth-responses.server';

/*
 * The account and session reads' reply schemas, through a real Elysia route so normalisation
 * runs as it does in the app: what the auth package returns goes out unchanged (every variant,
 * nulls and absent fields included), a field the schema does not name is dropped, and a reply
 * missing a field the client needs fails instead of going out short. Samples are typed as the
 * package's return types, so a sample that drifts from what the handler returns fails typecheck.
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
test('refuses a role or a device kind outside its set', async () => {
    const user = clone(cases['GET /auth/session']!.samples['signed in']) as any;
    user.user.role = 'owner';
    expect((await serve(sessionResponse, user)).status).toBe(500);
    const devices = clone(cases['GET /auth/devices']!.samples.devices) as any;
    devices.devices[0].kind = 'windows';
    expect((await serve(devicesResponse, devices)).status).toBe(500);
});
