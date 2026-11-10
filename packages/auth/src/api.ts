import type {
    CryptoResults,
    SecurityAction,
    SecurityChallenge,
    SecurityUpdate,
} from '@hushos/crypto';
import type { SettingsEnvelope } from '@hushos/crypto/contacts';
export type { ContactPin, Settings, SettingsEnvelope } from '@hushos/crypto/contacts';
import type { IdentityEnvelope } from '@hushos/crypto/identity';
import type { RecoveryEnvelope } from '@hushos/crypto/recovery';
import type {
    AccountDevice,
    AccountKeyEnvelope,
    AuthUser,
    DeviceKind,
    SessionDevice,
    SessionUser,
    SignupIntent,
} from './protocol';

/*
 * What the auth client needs from the server, as a contract the app implements.
 * The web app builds it from an Eden Treaty client typed by the Elysia app, so its
 * typecheck is where a changed route or response shape shows up. This package
 * never sees the server code; a native shell can implement the same interface.
 */
export type Enrollment = { id: string; email: string };
export type LoginChallenge = {
    attemptToken: string;
    loginResponse: string;
    profileVersion: number;
};
/* The finished password exchange a device removal carries. */
export type DeviceRemovalProof = { attemptToken: string; finishLoginRequest: string };

/*
 * Two-step sign-in (docs/two-step-design.md 4 and 10). A step token and what can answer it:
 * the methods the account has, when the token ends, and for the recovery phrase what its
 * statement and signing key need. `webauthn` is listed once security keys exist; a client
 * offers only the methods it can answer.
 */
export type StepMethod = 'webauthn' | 'totp' | 'backup' | 'phrase';
export type StepChallenge = {
    token: string;
    methods: StepMethod[];
    expiresAt: string;
    /* The same, as seconds from when the server answered: count from receipt, on the local clock. */
    expiresIn: number;
    phrase?: { userId: string; recoveryVersion: number; wrappingSalt: string };
};
/* What a session is answered when it asks for a step token: none, for an account without the step. */
export type StepOffer = { on: false } | ({ on: true } & StepChallenge);
/* An answer as it is sent: a code as typed, or the phrase's signature over the step's statement. */
export type StepProof =
    | { kind: 'totp'; code: string }
    | { kind: 'backup'; code: string }
    | { kind: 'phrase'; signature: string };
export type StepSubmission = { token: string; proof: StepProof };
/* The changes a session may ask a step token for (POST /auth/two-step/challenge). */
export type StepPurpose = 'password' | 'master-key' | 'recovery-key' | 'delete' | 'two-step';
/* A change to the second step: the finished password exchange, and the step once it is on. */
export type TwoStepChangeProof = DeviceRemovalProof & { twoStep?: StepSubmission };
/*
 * A method as Settings lists it. Dates are ISO strings, rounded by the server; a client that
 * parses timestamps as it reads a reply (the web's does) holds Date objects here at runtime,
 * so read them with `new Date(value)`, never as text.
 */
export type TwoStepMethod = {
    id: string;
    kind: 'totp' | 'webauthn';
    name: string;
    createdAt: string;
    lastUsedAt: string | null;
    synced: boolean;
};
export type TwoStepStatus = {
    on: boolean;
    methods: TwoStepMethod[];
    backupCodesLeft: number;
    /* Authenticator codes are paused for devices the account has not used. */
    totpFrozen: boolean;
};
/* A finished sign-in: the account, its wrapped key and the session's device. */
export type SignedIn = {
    user: AuthUser;
    envelope: AccountKeyEnvelope;
    device: SessionDevice & { attached: boolean };
};
/*
 * A sign-in finished by the second step, with what the step leaves to say: whether this
 * server lets the account change its step (TWO_STEP_ENABLED), and after a backup code how
 * many are left.
 */
export type SteppedIn = SignedIn & { twoStep: { offered: boolean; backupCodesLeft?: number } };
/*
 * A security change as the server answers it: every session of the account is ended, and the
 * device that asked has the one that replaces its own (the cookie), with the account's key as
 * now wrapped.
 */
export type SecurityChanged = {
    user: AuthUser;
    envelope: AccountKeyEnvelope;
    device: SessionDevice & { attached: boolean };
};
export type RegistrationChallenge = {
    registrationResponse: string;
    userId: string;
    profileVersion: number;
};
export type AccountSetup = {
    recovery: boolean;
    identity: boolean;
    workspace: boolean;
    workspaceKey: boolean;
    workspaceId: string | null;
};
export type StorageAllowance = {
    workspaceId: string;
    quotaBytes: string;
    usedBytes: string;
    reservedBytes: string;
    availableBytes: string;
    /*
     * The family whose pool these figures are, while the account's files draw from it
     * (docs/families-shared-pool.md 3.1); null on the account's own allowance. While set, the
     * figures are whole GiB (used rounded up, available down) and `reservedBytes` is "0", so
     * they never give away another member's usage (3.9); uploads are still checked exactly.
     */
    pool: { groupId: string; name: string } | null;
    /*
     * While `pool` is set, the account's own figures beside the pool's: what its files take
     * (My files with its Trash and earlier versions), exact, and the allowance it would have
     * on its own (Free and any grants), which is what it keeps after leaving the family.
     * Null on the account's own allowance, where the figures above are already its own.
     */
    own: { usedBytes: string; allowanceBytes: string } | null;
};

export type ContactIdentity = {
    userId: string;
    name: string;
    email: string;
    /* Raised by each succession; a pin remembers it to ask for the chain from there. */
    keyVersion: number;
} & PublicIdentity;

/*
 * Someone's public keys as the server serves them (docs/identity-pq-design.md).
 * A version 2 identity carries all four keys and its keys statement; a version
 * 1 identity (not yet upgraded) has no ML-DSA key and no statement, and is
 * trusted with nothing.
 */
export type PublicIdentity = {
    keyVersion: number;
    identityVersion: 1 | 2;
    encryptionPublicKey: string;
    signingPublicKey: string;
    mlDsaPublicKey: string | null;
    kemPublicKey: string | null;
    keysSignature: string | null;
};

/*
 * One identity succession, as a contact walks it: the identity it replaced, the
 * one that replaced it (the KEM key whole, the statement signs its digest), and
 * the replaced signing key's signature over the statement in
 * docs/integrity-design.md. Keys Base64url.
 */
export type SuccessionLink = {
    oldKeyVersion: number;
    newKeyVersion: number;
    oldEncryptionPublicKey: string;
    oldSigningPublicKey: string;
    oldMlDsaPublicKey: string;
    newEncryptionPublicKey: string;
    newSigningPublicKey: string;
    newMlDsaPublicKey: string;
    newKemPublicKey: string;
    /* The old identity's hybrid signature (3373 bytes). Only version 2 links are served. */
    signature: string;
    /*
     * The successor's consent (6746 bytes: the old identity's hybrid signature
     * over the consent statement as "old", then the new one's as "new"), when
     * the link was uploaded with it. Absent or null for links made before it
     * was uploaded and not yet backfilled; the group core asks it of links
     * from a member's first keys up to their entry's (docs/groups-design.md 2.8).
     */
    consent?: string | null;
};

/* The settings key wrapped under the account root: a 24-byte nonce and the 48-byte sealed key. */
export type SettingsKeyEnvelope = { nonce: string; ciphertext: string };
/* A settings envelope as stored: version 2 sealed under the settings key, 1 under the identity. */
export type StoredSettingsEnvelope = Omit<SettingsEnvelope, 'version'> & { version: 1 | 2 };

/*
 * A security change's challenge and request, with what a master key re-wraps
 * beyond the worker's own bundle: the earlier identities and the settings key
 * (required in the request whenever the challenge served one).
 */
export type AccountSecurityChallenge = SecurityChallenge & {
    identityHistory: IdentityEnvelope[];
    settingsKey: SettingsKeyEnvelope | null;
};
export type AccountSecurityUpdate = SecurityUpdate & {
    identityHistory?: IdentityEnvelope[];
    settingsKey?: SettingsKeyEnvelope;
};

export interface AuthApi {
    identity(): Promise<{ identity: IdentityEnvelope }>;
    /* The account's earlier identities, oldest first, still sealed under the root. */
    identityHistory(): Promise<{ identities: IdentityEnvelope[] }>;
    /*
     * Replaces the identity with one at the current key version + 1 (KEM key
     * required), signed by the current signing key; 409 when the version is
     * not the next one, 400 when the signature does not verify.
     */
    succeedIdentity(input: {
        identity: IdentityEnvelope;
        signature: string;
        /* The successor's consent (6746 bytes, base64url); optional until iOS and Android send it. */
        consent?: string;
    }): Promise<{ keyVersion: number }>;
    /* A contact's successions from key version `from` to the current one, in order. */
    contactSuccession(userId: string, from: number): Promise<{ links: SuccessionLink[] }>;
    /*
     * The successor's consent for one of this account's own earlier
     * successions that landed without it (docs/groups-server.md 5). Stored
     * only where the link has none: `stored` is false when one was there.
     */
    backfillSuccessionConsent(input: {
        oldKeyVersion: number;
        consent: string;
    }): Promise<{ stored: boolean }>;
    /*
     * The upgrade of a version 1 identity to version 2 (same keys, plus ML-DSA
     * and the keys statement). 409 when another device upgraded first: read
     * the identity again and open that one.
     */
    upgradeIdentity(input: { identity: IdentityEnvelope }): Promise<{ identity: IdentityEnvelope }>;
    lookupContact(email: string): Promise<{ contact: ContactIdentity }>;
    /*
     * `settingsVersion` is the stored sequence whatever is stored (0 for
     * nothing); `settings` is null when nothing is stored or the stored
     * document is version 1, which no client opens.
     */
    settings(): Promise<{
        settings: StoredSettingsEnvelope | null;
        settingsKey: SettingsKeyEnvelope | null;
        settingsVersion: number;
    }>;
    /*
     * `expectedVersion` is the stored sequence read; the document must be
     * sealed at that plus one, the sequence it is stored at. Version 2 only,
     * refused with 409 until the settings key is stored.
     */
    saveSettings(input: {
        expectedVersion: number;
        version?: 1 | 2;
        nonce: string;
        ciphertext: string;
    }): Promise<{ settingsVersion: number }>;
    /* Stores the wrapped settings key once; 409 when one exists (read it and use that). */
    saveSettingsKey(input: SettingsKeyEnvelope): Promise<{ ok: true }>;
    requestEmail(
        purpose: 'register' | 'recover',
        email: string,
        intent?: SignupIntent,
    ): Promise<{ message: string }>;
    verifyEmail(token: string): Promise<{ enrollment: Enrollment & { purpose: string } }>;
    enrollment(purpose: 'register' | 'recover'): Promise<{ enrollment: Enrollment | null }>;
    registerStart(input: { registrationRequest: string }): Promise<RegistrationChallenge>;
    registerFinish(
        input: { name: string } & CryptoResults['registerFinish'],
    ): Promise<{ user: AuthUser }>;
    loginStart(input: { email: string; startLoginRequest: string }): Promise<LoginChallenge>;
    /*
     * `device`: a device key's proof for this attempt. The reply says which
     * device the session is on, whether the proof brought it back (`attached`),
     * and whether that device has described itself yet (`registered`).
     */
    /*
     * `twoStep: 1` says this client can answer a second step. An account that has one then
     * gets a step token and nothing else (no session, no envelope) unless the sign-in is
     * exempt; without it the server answers 409 `update-required`.
     */
    loginFinish(input: {
        attemptToken: string;
        finishLoginRequest: string;
        device?: { id: string; signature: string };
        twoStep: 1;
    }): Promise<SignedIn | { twoStep: StepChallenge }>;
    /*
     * The second step of a sign-in. 401 `two-step` for a wrong answer (the token takes
     * another), 401 `two-step-expired` once the token is gone, 403 `totp-frozen`, 429
     * `code-budget`, 503 `two-step-unavailable`, 400 `not-a-code`.
     */
    loginTwoStep(input: StepSubmission): Promise<SteppedIn>;
    /* 501 `unsupported` while the server does not offer two-step sign-in. */
    twoStep(): Promise<TwoStepStatus>;
    /* Changing the second step asks for the password: this starts the exchange, bound to the session. */
    twoStepReauth(input: { startLoginRequest: string }): Promise<LoginChallenge>;
    /* A step token for one change, or `on: false` when the account has no second step. */
    twoStepChallenge(purpose: StepPurpose): Promise<StepOffer>;
    /* A pending authenticator app, for ten minutes: its secret (base32) and key URI, once. */
    startTotp(proof: TwoStepChangeProof): Promise<{ id: string; secret: string; uri: string }>;
    /* The ten backup codes only when this turned the step on; only then are other devices signed out. */
    confirmTotp(
        id: string,
        input: { code: string; signOutOthers?: boolean },
    ): Promise<{ backupCodes?: string[] }>;
    /* `on`: whether the step is still on; removing the last method turns it off. */
    removeTwoStepMethod(id: string, proof: TwoStepChangeProof): Promise<{ on: boolean }>;
    replaceBackupCodes(proof: TwoStepChangeProof): Promise<{ codes: string[] }>;
    /* No user: `removed` when this session ended because its device was removed. */
    session(): Promise<{
        user: SessionUser | null;
        device: SessionDevice | null;
        removed?: boolean;
    }>;
    /* After a removed device cleared what it kept: drops the cookie, only if it is still the removed one. */
    forgetSession(): Promise<{ forgotten: boolean }>;
    devices(): Promise<{ devices: AccountDevice[] }>;
    /* Once per device; 409 `registered` after that. The key is 32 bytes, base64url. */
    registerDevice(input: {
        kind: DeviceKind;
        name: string;
        signingPublicKey?: string;
    }): Promise<{ device: AccountDevice }>;
    renameDevice(id: string, name: string): Promise<{ device: AccountDevice }>;
    /* Removing devices asks for the password: this starts the exchange, bound to the session. */
    devicesReauth(input: { startLoginRequest: string }): Promise<LoginChallenge>;
    /* 409 `current` for the device asking: sign out instead. 403 for a wrong password. */
    removeDevice(id: string, proof: DeviceRemovalProof): Promise<{ removed: number }>;
    removeOtherDevices(proof: DeviceRemovalProof): Promise<{ removed: number }>;
    logout(): Promise<unknown>;
    setup(): Promise<{ missing: AccountSetup | null }>;
    initialize(input: CryptoResults['initialize']): Promise<unknown>;
    recoverStart(input: { registrationRequest: string }): Promise<
        RegistrationChallenge & {
            credentialVersion: number;
            attemptToken: string;
            recovery: RecoveryEnvelope;
        }
    >;
    recoverFinish(
        input: {
            userId: string;
            attemptToken: string;
            credentialVersion: number;
        } & CryptoResults['recoverFinish'],
    ): Promise<unknown>;
    recoveryBackup(): Promise<{ userId: string; recovery: RecoveryEnvelope; confirmed: boolean }>;
    confirmRecoveryBackup(recoveryVersion: number): Promise<unknown>;
    storage(): Promise<{ storage: StorageAllowance | null }>;
    securityStart(input: {
        action: SecurityAction;
        startLoginRequest: string;
        registrationRequest: string;
    }): Promise<AccountSecurityChallenge>;
    /* `twoStep`: the second step, for an account that has one (403 `two-step` without it). */
    securityFinish(
        input: {
            action: SecurityAction;
            attemptToken: string;
            twoStep?: StepSubmission;
        } & AccountSecurityUpdate,
    ): Promise<SecurityChanged>;
    deleteStart(input: { startLoginRequest: string }): Promise<LoginChallenge>;
    deleteFinish(input: {
        attemptToken: string;
        finishLoginRequest: string;
        twoStep?: StepSubmission;
    }): Promise<unknown>;
    updateProfile(name: string): Promise<{ user: SessionUser }>;
}
