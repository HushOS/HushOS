import '@/lib/server-only';
import { t } from 'elysia';

/*
 * What the account and session reads answer (auth.server.ts), field for field. Elysia checks a
 * reply against its schema and drops every field the schema does not name, so a column added to
 * a row later stays on the server. Each mirrors the type the handler returns: a field the schema
 * misses is silently dropped, and one it requires that the handler leaves out fails the request.
 * Key material is Base64url, kept as plain strings; lengths are the writers' to check.
 */

/* GET /auth/setup: which parts of account setup are still missing, or null without a user row. */
export const accountSetupResponse = t.Object({
    missing: t.Nullable(
        t.Object({
            recovery: t.Boolean(),
            identity: t.Boolean(),
            workspace: t.Boolean(),
            workspaceKey: t.Boolean(),
            workspaceId: t.Nullable(t.String()),
        }),
    ),
});

/* GET /auth/register and /auth/recover: the verified enrollment behind the cookie, or null. */
export const enrollmentResponse = t.Object({
    enrollment: t.Nullable(
        t.Object({ id: t.String(), email: t.String(), profileVersion: t.Integer() }),
    ),
});

/*
 * GET /auth/storage: byte counts as decimal strings (they pass 2^53). `pool` and `own` are set
 * together, while the account's files draw from a family's pool; null without a personal workspace.
 */
export const storageResponse = t.Object({
    storage: t.Nullable(
        t.Object({
            workspaceId: t.String(),
            quotaBytes: t.String(),
            usedBytes: t.String(),
            reservedBytes: t.String(),
            availableBytes: t.String(),
            pool: t.Nullable(t.Object({ groupId: t.String(), name: t.String() })),
            own: t.Nullable(t.Object({ usedBytes: t.String(), allowanceBytes: t.String() })),
        }),
    ),
});

/* GET /auth/recovery-key: the recovery envelope (RecoveryEnvelope) and whether it was saved. */
export const recoveryBackupResponse = t.Object({
    userId: t.String(),
    recovery: t.Object({
        version: t.Literal(1),
        keyVersion: t.Integer(),
        recoveryVersion: t.Integer(),
        wrappingSalt: t.String(),
        wrappingNonce: t.String(),
        encryptedKey: t.String(),
        backupNonce: t.String(),
        encryptedRecoveryKey: t.String(),
        publicKey: t.String(),
    }),
    confirmed: t.Boolean(),
});

/* An identity envelope (IdentityEnvelope in @hushos/crypto/identity), current or earlier. */
const identityCommon = {
    keyVersion: t.Integer(),
    wrappingSalt: t.String(),
    encryptionPublicKey: t.String(),
    encryptionPrivateKeyNonce: t.String(),
    encryptedEncryptionPrivateKey: t.String(),
    signingPublicKey: t.String(),
    signingSeedNonce: t.String(),
    encryptedSigningSeed: t.String(),
};
const seedHalf = { publicKey: t.String(), seedNonce: t.String(), encryptedSeed: t.String() };
const identityEnvelope = t.Union([
    t.Object({
        version: t.Literal(2),
        ...identityCommon,
        kem: t.Object(seedHalf),
        mlDsa: t.Object(seedHalf),
        keysSignature: t.String(),
    }),
    // Served with `kem` always present (null on the oldest) and never `mlDsa` or `keysSignature`;
    // the type allows them absent or null, and so does this.
    t.Object({
        version: t.Literal(1),
        ...identityCommon,
        kem: t.Optional(
            t.Nullable(t.Object({ ...seedHalf, signature: t.Optional(t.Nullable(t.String())) })),
        ),
        mlDsa: t.Optional(t.Null()),
        keysSignature: t.Optional(t.Null()),
    }),
]);

/* GET /auth/identity. */
export const identityResponse = t.Object({ identity: identityEnvelope });

/* GET /auth/identity/history: the earlier identities, oldest first. */
export const identityHistoryResponse = t.Object({ identities: t.Array(identityEnvelope) });

/* GET /auth/contacts/:userId/succession: hybrid (version 2) links only; consent null without one. */
export const contactSuccessionResponse = t.Object({
    links: t.Array(
        t.Object({
            oldKeyVersion: t.Integer(),
            newKeyVersion: t.Integer(),
            oldEncryptionPublicKey: t.String(),
            oldSigningPublicKey: t.String(),
            oldMlDsaPublicKey: t.String(),
            newEncryptionPublicKey: t.String(),
            newSigningPublicKey: t.String(),
            newMlDsaPublicKey: t.String(),
            newKemPublicKey: t.String(),
            signature: t.String(),
            consent: t.Nullable(t.String()),
        }),
    ),
});

/* GET /auth/settings: a version 2 document or none, the wrapped settings key or none, the sequence. */
export const settingsResponse = t.Object({
    settings: t.Nullable(
        t.Object({
            version: t.Literal(2),
            settingsVersion: t.Integer(),
            nonce: t.String(),
            ciphertext: t.String(),
        }),
    ),
    settingsKey: t.Nullable(t.Object({ nonce: t.String(), ciphertext: t.String() })),
    settingsVersion: t.Integer(),
});

/*
 * GET /auth/session: the user and the session's device, or neither, then `removed` when the
 * token's device was removed. The removed variant comes first: a union keeps the first variant
 * that matches, and the bare one matches a removed reply too, which would drop `removed`.
 */
export const sessionResponse = t.Union([
    t.Object({
        user: t.Object({
            id: t.String(),
            name: t.String(),
            email: t.String(),
            role: t.Union([t.Literal('member'), t.Literal('admin')]),
            credentialVersion: t.Integer(),
        }),
        device: t.Object({ id: t.String(), registered: t.Boolean() }),
    }),
    t.Object({ user: t.Null(), device: t.Null(), removed: t.Literal(true) }),
    t.Object({ user: t.Null(), device: t.Null() }),
]);

/* GET /auth/devices: the asking device first. Dates are ISO strings, to the hour. */
export const devicesResponse = t.Object({
    devices: t.Array(
        t.Object({
            id: t.String(),
            kind: t.Nullable(t.Union([t.Literal('web'), t.Literal('ios'), t.Literal('android')])),
            name: t.Nullable(t.String()),
            approvedBy: t.Nullable(
                t.Union([
                    t.Literal('enrolment'),
                    t.Literal('password'),
                    t.Literal('device'),
                    t.Literal('phrase'),
                    t.Literal('email-wait'),
                    t.Literal('guardian'),
                    t.Literal('existing'),
                ]),
            ),
            approvedByDeviceId: t.Nullable(t.String()),
            createdAt: t.String(),
            lastSeenAt: t.String(),
            current: t.Boolean(),
            signedIn: t.Boolean(),
        }),
    ),
});
