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
 * The first half of an OPAQUE sign-in (startLogin): POST /auth/login/start, /auth/devices/reauth
 * and /auth/delete/start. At /auth/login/start an unknown address gets a decoy KE2 from the same
 * call, the same three fields at the same lengths: one shape, nothing optional, so the schema
 * cannot tell the two apart either.
 */
export const loginChallengeResponse = t.Object({
    attemptToken: t.String(),
    loginResponse: t.String(),
    profileVersion: t.Integer(),
});

/*
 * POST /auth/login/start: the same, and the server's word that it reads `twoStepMethods`
 * (docs/two-step-design.md 12). A client names the methods it can answer only to a server that
 * says this, so a release from before passkeys, whose schema would refuse the field, never
 * sees it. It is in every reply, the decoy for an unknown address included: a constant, so it
 * says nothing about the account.
 */
export const loginStartResponse = t.Object({
    attemptToken: t.String(),
    loginResponse: t.String(),
    profileVersion: t.Integer(),
    twoStepMethods: t.Literal(true),
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
 * POST /auth/login/finish: the account, its wrapped key, and the session's device: whether a
 * device key's proof brought it back (`attached`) and whether it has described itself.
 */
export const loginResponse = t.Object({
    user: authUser,
    envelope: accountKeyEnvelope,
    device: t.Object({ id: t.String(), attached: t.Boolean(), registered: t.Boolean() }),
});

/*
 * What a client must answer before a session or a change (StepChallenge, docs/two-step-design.md
 * 4): the step token, which methods can answer it, when it ends, and what the device needs to
 * sign with the recovery phrase. Told only to someone who has just proved the password.
 */
const stepMethod = t.Union([
    t.Literal('webauthn'),
    t.Literal('totp'),
    t.Literal('device'),
    t.Literal('backup'),
    t.Literal('phrase'),
]);
const keyDescriptor = t.Object({
    id: t.String(),
    type: t.Literal('public-key'),
    transports: t.Optional(t.Array(t.String())),
});
/*
 * What a passkey or security key is asked (PublicKeyCredentialRequestOptionsJSON): the step
 * token's own challenge, the RP ID, and the account's keys with their transports. No user
 * verification: the password was the knowledge factor.
 */
const keyRequestOptions = t.Object({
    challenge: t.String(),
    rpId: t.String(),
    timeout: t.Integer(),
    userVerification: t.Literal('discouraged'),
    allowCredentials: t.Array(keyDescriptor),
});
/*
 * `methods` is ordered: the account's usual way first (docs/two-step-design.md 12). `webauthn`
 * goes with the `webauthn` method. `withheld`: a way to answer was left out because the client
 * did not name it. `defaultUnavailable`: the usual way is not first for this step, whatever the
 * reason. Neither is sent to a client that named no methods.
 */
const stepChallenge = t.Object({
    token: t.String(),
    methods: t.Array(stepMethod),
    expiresAt: t.String(),
    phrase: t.Optional(
        t.Object({ userId: t.String(), recoveryVersion: t.Integer(), wrappingSalt: t.String() }),
    ),
    webauthn: t.Optional(keyRequestOptions),
    withheld: t.Optional(t.Literal(true)),
    defaultUnavailable: t.Optional(t.Literal(true)),
});

/*
 * POST /auth/login/finish, whole: the session's reply, or, for an account that asks for a
 * second step, the step to answer and nothing else. No cookie goes with the second.
 */
export const loginFinishResponse = t.Union([loginResponse, t.Object({ twoStep: stepChallenge })]);

/* POST /auth/two-step/challenge: the step a signed-in session answers before a change. */
export const stepChallengeResponse = stepChallenge;

/* A method as the list shows it: a name only where one was given, and whether a key is synced. */
const twoStepMethod = t.Object({
    id: t.String(),
    kind: t.Union([t.Literal('totp'), t.Literal('webauthn'), t.Literal('device')]),
    name: t.Nullable(t.String()),
    createdAt: t.String(),
    lastUsedAt: t.Nullable(t.String()),
    synced: t.Boolean(),
});
const defaultKind = t.Union([t.Literal('webauthn'), t.Literal('totp'), t.Literal('device')]);

/*
 * GET /auth/two-step: whether the step is on, its methods by kind, how many backup codes are
 * left, and whether the app is paused for new devices. The list holds the app and the kinds
 * the client named in `?methods=`; `defaultKind`, the kind offered first, is sent only to a
 * client that named some. Never a secret, a credential id or a public key.
 */
export const twoStepResponse = t.Object({
    on: t.Boolean(),
    methods: t.Array(twoStepMethod),
    backupCodesLeft: t.Integer(),
    totpFrozen: t.Boolean(),
    defaultKind: t.Optional(t.Nullable(defaultKind)),
    // Whether this device could turn on Approve on another device now, and the devices the
    // person can choose from to approve it; only to a client that named the method in `?methods=`.
    otherDevice: t.Optional(t.Boolean()),
    approvers: t.Optional(
        t.Array(
            t.Object({
                id: t.String(),
                kind: t.Nullable(
                    t.Union([t.Literal('web'), t.Literal('ios'), t.Literal('android')]),
                ),
                name: t.Nullable(t.String()),
                createdAt: t.String(),
            }),
        ),
    ),
});

/*
 * Approving on another device (docs/two-step-design.md 12).
 * POST /auth/approvals: the request, the account it is for (a sign-in has not been told yet,
 * and the code covers it), and when it ends with its token.
 */
export const approvalStartedResponse = t.Object({
    requestId: t.String(),
    userId: t.String(),
    expiresAt: t.String(),
});
/* GET /auth/approvals/:id: where the request stands, for the device that made it. */
export const approvalStatusResponse = t.Object({
    state: t.Union([
        t.Literal('waiting'),
        t.Literal('opened'),
        t.Literal('revealed'),
        t.Literal('approved'),
        t.Literal('ended'),
    ]),
    approverKey: t.Optional(t.String()),
    ended: t.Optional(t.Union([t.Literal('replaced'), t.Literal('over'), t.Literal('refused')])),
});
export const approvalRevealedResponse = t.Object({ revealed: t.Literal(true) });
/*
 * GET /auth/approvals: what this device may answer. `device` is the asking device as the
 * server knows it, or in its own words for one it does not know yet. `location` is roughly
 * where it is ("near Lyon, France"), as the operator's proxy said it; null where the server
 * was told nothing.
 */
export const approvalsResponse = t.Object({
    userId: t.String(),
    approvals: t.Array(
        t.Object({
            id: t.String(),
            purpose: t.String(),
            class: t.Union([t.Literal('unknown'), t.Literal('known'), t.Literal('change')]),
            device: t.Object({
                kind: t.Nullable(
                    t.Union([t.Literal('web'), t.Literal('ios'), t.Literal('android')]),
                ),
                name: t.Nullable(t.String()),
            }),
            location: t.Nullable(t.String()),
            // The name is the asking device's own words: the server does not know the device.
            selfNamed: t.Boolean(),
            // The asking device chose this device to answer.
            chosen: t.Boolean(),
            createdAt: t.String(),
            expiresAt: t.String(),
            tokenDigest: t.String(),
            commitment: t.String(),
            approverKey: t.Optional(t.String()),
            reveal: t.Optional(t.Object({ deviceSigningKey: t.String(), nonce: t.String() })),
        }),
    ),
});
export const approvalOpenedResponse = t.Object({ approverKey: t.String() });
export const approvalApprovedResponse = t.Object({ approved: t.Literal(true) });
export const approvalEndedResponse = t.Object({ ended: t.Literal(true) });
/* POST /auth/two-step/device: the pending method and the step token its one approval runs from. */
export const deviceEnrolmentResponse = t.Object({
    id: t.String(),
    token: t.String(),
    expiresAt: t.String(),
});
/* POST /auth/two-step/device/:id/confirm: the backup codes when this turned the step on, or `added`. */
export const deviceConfirmedResponse = t.Union([
    t.Object({ backupCodes: t.Array(t.String()) }),
    t.Object({ added: t.Literal(true) }),
]);

/*
 * POST /auth/two-step/keys/options: what `navigator.credentials.create` is given
 * (PublicKeyCredentialCreationOptionsJSON), and the registration token the key's answer comes
 * back with. No attestation, no resident key, no user verification.
 */
export const keyOptionsResponse = t.Object({
    registrationToken: t.String(),
    expiresAt: t.String(),
    options: t.Object({
        challenge: t.String(),
        rp: t.Object({ id: t.String(), name: t.String() }),
        user: t.Object({ id: t.String(), name: t.String(), displayName: t.String() }),
        pubKeyCredParams: t.Array(t.Object({ type: t.Literal('public-key'), alg: t.Integer() })),
        timeout: t.Integer(),
        attestation: t.Literal('none'),
        excludeCredentials: t.Array(keyDescriptor),
        authenticatorSelection: t.Object({
            residentKey: t.Literal('discouraged'),
            userVerification: t.Literal('discouraged'),
            requireResidentKey: t.Literal(false),
        }),
    }),
});

/* POST /auth/two-step/keys: the key as the list shows it, and the backup codes when this turned the step on. */
export const keyAddedResponse = t.Object({
    method: twoStepMethod,
    backupCodes: t.Optional(t.Array(t.String())),
});

/* PUT /auth/two-step/methods/:id: the renamed key. */
export const methodResponse = t.Object({ method: twoStepMethod });

/* PUT /auth/two-step/default: the kind now offered first. */
export const defaultKindResponse = t.Object({ defaultKind });

/* POST /auth/two-step/totp: the pending app's secret, shown once, and its key URI for the QR code. */
export const totpEnrolmentResponse = t.Object({
    id: t.String(),
    secret: t.String(),
    uri: t.String(),
    expiresAt: t.String(),
});

/*
 * POST /auth/two-step/totp/:id/confirm: the backup codes when this turned the step on, or
 * `replaced: true` when the app took over from an earlier one. One or the other, never an
 * empty object: a client reads anything else as a reply that was not the server's.
 */
export const totpConfirmedResponse = t.Union([
    t.Object({ backupCodes: t.Array(t.String()) }),
    t.Object({ replaced: t.Literal(true) }),
]);

/* DELETE /auth/two-step/methods/:id: gone, and whether the step is still on. */
export const methodRemovedResponse = t.Object({ removed: t.Boolean(), on: t.Boolean() });

/* POST /auth/two-step/backup-codes: the new set, shown once. */
export const backupCodesResponse = t.Object({ codes: t.Array(t.String()) });

/*
 * GET /auth/security-events: the last 90 days, newest first. A kind of event, a kind of method
 * and a kind of device; never a name, an address or a browser.
 */
export const securityEventsResponse = t.Object({
    events: t.Array(
        t.Object({
            id: t.String(),
            kind: t.String(),
            method: t.Nullable(
                t.Union([
                    t.Literal('totp'),
                    t.Literal('webauthn'),
                    t.Literal('device'),
                    t.Literal('backup'),
                    t.Literal('phrase'),
                ]),
            ),
            deviceId: t.Nullable(t.String()),
            deviceKind: t.Nullable(
                t.Union([t.Literal('web'), t.Literal('ios'), t.Literal('android')]),
            ),
            createdAt: t.String(),
        }),
    ),
});

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
