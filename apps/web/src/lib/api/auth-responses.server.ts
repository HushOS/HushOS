import '@/lib/server-only';
import { t } from 'elysia';

/*
 * What every account and session route answers (auth.server.ts), field for field. Elysia checks a
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

/* A recovery envelope (RecoveryEnvelope in @hushos/crypto/recovery): the sealed key and its backup. */
const recoveryEnvelope = t.Object({
    version: t.Literal(1),
    keyVersion: t.Integer(),
    recoveryVersion: t.Integer(),
    wrappingSalt: t.String(),
    wrappingNonce: t.String(),
    encryptedKey: t.String(),
    backupNonce: t.String(),
    encryptedRecoveryKey: t.String(),
    publicKey: t.String(),
});

/* GET /auth/recovery-key: the recovery envelope and whether it was saved. */
export const recoveryBackupResponse = t.Object({
    userId: t.String(),
    recovery: recoveryEnvelope,
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

/* GET /auth/identity, and POST /auth/identity/upgrade with the version 2 identity it stored. */
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

/* The settings key wrapped under the account root (SettingsKeyEnvelope). */
const settingsKeyEnvelope = t.Object({ nonce: t.String(), ciphertext: t.String() });

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
    settingsKey: t.Nullable(settingsKeyEnvelope),
    settingsVersion: t.Integer(),
});

/* A user row as registration, sign-in and recovery return it (userFields in @hushos/db). */
const authUserFields = {
    id: t.String(),
    name: t.String(),
    email: t.String(),
    role: t.Union([t.Literal('member'), t.Literal('admin')]),
};
const authUser = t.Object(authUserFields);
/* The same with the session's credential version: GET /auth/session and POST /auth/profile. */
const sessionUser = t.Object({ ...authUserFields, credentialVersion: t.Integer() });

/*
 * GET /auth/session: the user and the session's device, or neither, then `removed` when the
 * token's device was removed. The removed variant comes first: a union keeps the first variant
 * that matches, and the bare one matches a removed reply too, which would drop `removed`.
 */
export const sessionResponse = t.Union([
    t.Object({ user: sessionUser, device: t.Object({ id: t.String(), registered: t.Boolean() }) }),
    t.Object({ user: t.Null(), device: t.Null(), removed: t.Literal(true) }),
    t.Object({ user: t.Null(), device: t.Null() }),
]);

/* A device as encodeDevice serves it (AccountDevice). Dates are ISO strings, to the hour. */
const accountDevice = t.Object({
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
});

/* GET /auth/devices: the asking device first. */
export const devicesResponse = t.Object({ devices: t.Array(accountDevice) });

/* POST /auth/devices (the device describes itself) and PUT /auth/devices/:id (a rename). */
export const deviceResponse = t.Object({ device: accountDevice });

/* DELETE /auth/devices/:id and /auth/devices/others: how many devices were signed out. */
export const devicesRemovedResponse = t.Object({ removed: t.Integer() });

/* POST /auth/session/forget: whether the removed device's cookie was let go. */
export const forgottenResponse = t.Object({ forgotten: t.Boolean() });

/* ------------------------------------------------------------------------- */
/* Registration, sign-in, recovery and the password proofs                    */
/* ------------------------------------------------------------------------- */

/*
 * POST /auth/register/email and /auth/recover/email. The one sentence goes out whether a link
 * was minted or the address only heard where to go instead (it has an account, or has none to
 * recover): one object in the handler, one shape here, so the reply never says which.
 */
export const emailSentResponse = t.Object({ message: t.String() });

/*
 * POST /auth/register/verify: the enrollment the link opened. `purpose` stays: both phones refuse
 * a recovery link opened as a sign-up's, and a sign-up's as a recovery's, by reading it.
 */
export const verifiedEnrollmentResponse = t.Object({
    enrollment: t.Object({ id: t.String(), email: t.String(), purpose: t.String() }),
});

/* POST /auth/register/start: the OPAQUE registration response, for the enrollment's id. */
export const registrationChallengeResponse = t.Object({
    registrationResponse: t.String(),
    userId: t.String(),
    profileVersion: t.Integer(),
});

/* POST /auth/register/finish and /auth/recover/finish: the account, without a session. */
export const authUserResponse = t.Object({ user: authUser });

/*
 * The first half of an OPAQUE sign-in (startLogin): POST /auth/login/start, /auth/devices/reauth,
 * /auth/two-step/reauth and /auth/delete/start. At /auth/login/start an unknown address gets a decoy KE2 from the same
 * call, the same three fields at the same lengths: one shape, nothing optional, so the schema
 * cannot tell the two apart either.
 */
export const loginChallengeResponse = t.Object({
    attemptToken: t.String(),
    loginResponse: t.String(),
    profileVersion: t.Integer(),
});

/* The account key wrapped under the password's export key (AccountKeyEnvelope). */
const accountKeyEnvelope = t.Object({
    envelopeVersion: t.Literal(1),
    keyVersion: t.Integer(),
    credentialVersion: t.Integer(),
    wrappingSalt: t.String(),
    wrappingNonce: t.String(),
    encryptedKey: t.String(),
});

/*
 * A finished sign-in (POST /auth/login/two-step, and /auth/login/finish without a step): the
 * account, its wrapped key, and the session's device: whether a device key's proof brought it
 * back (`attached`) and whether it has described itself.
 */
export const loginResponse = t.Object({
    user: authUser,
    envelope: accountKeyEnvelope,
    device: t.Object({ id: t.String(), attached: t.Boolean(), registered: t.Boolean() }),
});

/* What can answer the second step. `webauthn` is listed once a security key can be checked. */
const stepMethod = t.Union([
    t.Literal('webauthn'),
    t.Literal('totp'),
    t.Literal('backup'),
    t.Literal('phrase'),
]);

/*
 * A step token and what can answer it (docs/two-step-design.md 4): the methods the account has,
 * when the token ends, and for the recovery phrase what its statement and signing key need: the
 * account's id, which a device that kept nothing does not know, and the recovery envelope's
 * salt and version. Never a secret, a method's name or anything of the account beyond that.
 */
const stepChallengeFields = {
    token: t.String(),
    methods: t.Array(stepMethod),
    expiresAt: t.String(),
    /* The same as seconds from now, for a client whose clock is not the server's. */
    expiresIn: t.Integer(),
    phrase: t.Optional(
        t.Object({ userId: t.String(), recoveryVersion: t.Integer(), wrappingSalt: t.String() }),
    ),
};
const stepChallenge = t.Object(stepChallengeFields);

/*
 * POST /auth/login/finish: a finished sign-in, or, for an account with a second step, a step
 * token and nothing else: no user, no envelope, no device. The step comes first in the union: a
 * union keeps the first variant that matches, and the two share no field.
 */
export const loginOrStepResponse = t.Union([t.Object({ twoStep: stepChallenge }), loginResponse]);

/*
 * POST /auth/two-step/challenge: a step token for one change, bound to the session asking, or
 * `on: false` for an account without a second step, which then changes on its password alone.
 */
export const stepChallengeResponse = t.Union([
    t.Object({ on: t.Literal(false) }),
    t.Object({ on: t.Literal(true), ...stepChallengeFields }),
]);

const sessionDevice = t.Object({ id: t.String(), attached: t.Boolean(), registered: t.Boolean() });

/*
 * POST /auth/login/two-step: a finished sign-in, with what the step leaves to say: whether
 * this server lets the account change its second step, and after a backup code how many are
 * left.
 */
export const steppedLoginResponse = t.Object({
    user: authUser,
    envelope: accountKeyEnvelope,
    device: sessionDevice,
    twoStep: t.Object({ offered: t.Boolean(), backupCodesLeft: t.Optional(t.Integer()) }),
});

/*
 * POST /auth/security/finish: the change is made, every session of the account is ended, and
 * the device that asked has the session that replaces its own (the cookie): the account, its
 * key as now wrapped, and that device, as a sign-in answers.
 */
export const securityChangedResponse = t.Object({
    success: t.Literal(true),
    user: authUser,
    envelope: accountKeyEnvelope,
    device: sessionDevice,
});

/* A method as Settings lists it: never its secret or public key. Dates are ISO strings, rounded. */
const twoStepMethod = t.Object({
    id: t.String(),
    kind: t.Union([t.Literal('totp'), t.Literal('webauthn')]),
    name: t.String(),
    createdAt: t.String(),
    lastUsedAt: t.Nullable(t.String()),
    synced: t.Boolean(),
});

/* GET /auth/two-step: whether the step is on, its methods, the backup codes left, the freeze. */
export const twoStepResponse = t.Object({
    on: t.Boolean(),
    methods: t.Array(twoStepMethod),
    backupCodesLeft: t.Integer(),
    totpFrozen: t.Boolean(),
});

/*
 * POST /auth/two-step/totp: the new authenticator app's id, its secret (base32) and the key URI
 * the QR code encodes. The one time the secret leaves the server.
 */
export const totpSetupResponse = t.Object({ id: t.String(), secret: t.String(), uri: t.String() });

/* POST /auth/two-step/totp/:id/confirm: the ten backup codes, only when this turned the step on. */
export const totpConfirmedResponse = t.Object({ backupCodes: t.Optional(t.Array(t.String())) });

/* PUT /auth/two-step/methods/:id: the renamed method. */
export const twoStepMethodResponse = t.Object({ method: twoStepMethod });

/* DELETE /auth/two-step/methods/:id: whether the step is still on. */
export const twoStepMethodRemovedResponse = t.Object({ on: t.Boolean() });

/* POST /auth/two-step/backup-codes: the new set, once. */
export const backupCodesResponse = t.Object({ codes: t.Array(t.String()) });

/* POST /auth/recover/start: the OPAQUE registration response and the recovery envelope to open. */
export const recoveryChallengeResponse = t.Object({
    registrationResponse: t.String(),
    attemptToken: t.String(),
    userId: t.String(),
    credentialVersion: t.Integer(),
    profileVersion: t.Integer(),
    recovery: recoveryEnvelope,
});

/*
 * POST /auth/security/start (ServerSecurityChallenge): both OPAQUE halves and every envelope the
 * change re-wraps. A grant's `groupId` is null on the personal workspace and the group's id on a
 * family area's self-grant; the type has it optional too, and so does this.
 */
export const securityChallengeResponse = t.Object({
    attemptToken: t.String(),
    loginResponse: t.String(),
    profileVersion: t.Integer(),
    registrationResponse: t.String(),
    action: t.Union([t.Literal('password'), t.Literal('master-key'), t.Literal('recovery-key')]),
    userId: t.String(),
    envelope: accountKeyEnvelope,
    recovery: recoveryEnvelope,
    workspaces: t.Array(
        t.Object({
            version: t.Literal(1),
            workspaceId: t.String(),
            groupId: t.Optional(t.Nullable(t.String())),
            keyVersion: t.Integer(),
            workspaceKeyVersion: t.Integer(),
            wrappingSalt: t.String(),
            wrappingNonce: t.String(),
            encryptedKey: t.String(),
        }),
    ),
    identity: identityEnvelope,
    identityHistory: t.Array(identityEnvelope),
    settingsKey: t.Nullable(settingsKeyEnvelope),
});

/*
 * The finished changes that answer only that they happened: POST /auth/security/finish,
 * /auth/delete/finish, /auth/recovery-key/confirm and /auth/logout. Typed `boolean` where they
 * are built, always true.
 */
export const successResponse = t.Object({ success: t.Boolean() });

/* ------------------------------------------------------------------------- */
/* Account setup, profile, identity, contacts, settings                       */
/* ------------------------------------------------------------------------- */

/* POST /auth/setup: typed `boolean` where it is built, always true. */
export const setupResponse = t.Object({ ok: t.Boolean() });

/* POST /auth/profile: the renamed user with the session's credential version. */
export const profileResponse = t.Object({ user: sessionUser });

/* POST /auth/identity/succession: the new identity's key version. */
export const successionResponse = t.Object({ keyVersion: t.Integer() });

/* POST /auth/identity/succession/consent: false when a consent was already stored. */
export const consentStoredResponse = t.Object({ stored: t.Boolean() });

/*
 * POST /auth/contacts/lookup: the person and their public identity (publicIdentityOf). A version
 * 1 identity has no ML-DSA key or keys statement, and its KEM key may be missing too.
 */
export const contactResponse = t.Object({
    contact: t.Object({
        userId: t.String(),
        name: t.String(),
        email: t.String(),
        keyVersion: t.Integer(),
        identityVersion: t.Union([t.Literal(1), t.Literal(2)]),
        encryptionPublicKey: t.String(),
        signingPublicKey: t.String(),
        mlDsaPublicKey: t.Nullable(t.String()),
        kemPublicKey: t.Nullable(t.String()),
        keysSignature: t.Nullable(t.String()),
    }),
});

/* PUT /auth/settings-key: stored. Another device's key already there is a 409, not a reply. */
export const settingsKeyStoredResponse = t.Object({ ok: t.Literal(true) });

/* PUT /auth/settings: the sequence the document is now stored at. */
export const settingsSavedResponse = t.Object({ settingsVersion: t.Integer() });
