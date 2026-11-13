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

/*
 * Two-step sign-in (docs/two-step-design.md 4). What an account that has the step on is told
 * after its password: the step token, which methods can answer it, and what the device needs
 * to sign with the recovery phrase. `methods` holds only what this client can answer.
 */
export type StepMethod = 'webauthn' | 'totp' | 'device' | 'backup' | 'phrase';
/*
 * Passkeys and security keys (docs/two-step-design.md 3), in WebAuthn's JSON forms with every
 * field the server sets present: what a key is asked at a step, what it is asked when it is
 * added, and its two answers. Bytes are Base64url without padding.
 */
export type KeyDescriptor = { id: string; type: 'public-key'; transports?: string[] };
export type KeyRequestOptions = {
    challenge: string;
    rpId: string;
    timeout: number;
    userVerification: 'discouraged';
    allowCredentials: KeyDescriptor[];
};
export type KeyCreationOptions = {
    challenge: string;
    rp: { id: string; name: string };
    user: { id: string; name: string; displayName: string };
    pubKeyCredParams: { type: 'public-key'; alg: number }[];
    timeout: number;
    attestation: 'none';
    excludeCredentials: KeyDescriptor[];
    authenticatorSelection: {
        residentKey: 'discouraged';
        userVerification: 'discouraged';
        requireResidentKey: false;
    };
};
export type KeyAssertion = {
    id: string;
    rawId: string;
    type: 'public-key';
    response: { clientDataJSON: string; authenticatorData: string; signature: string };
};
export type KeyRegistration = {
    id: string;
    rawId: string;
    type: 'public-key';
    response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
};
/*
 * The kinds of method a client names beyond the ones every client answers (the app's code, a
 * backup code, the phrase), in `twoStepMethods` and `?methods=` (docs/two-step-design.md 12).
 */
export type NamedStepMethod = 'webauthn' | 'device';
export type StepChallenge = {
    token: string;
    /* In the order to offer them: the account's usual way first. */
    methods: StepMethod[];
    expiresAt: string;
    phrase?: { userId: string; recoveryVersion: number; wrappingSalt: string };
    /* What a passkey or security key is asked. Present whenever `methods` has `webauthn`. */
    webauthn?: KeyRequestOptions;
    /* A way to answer was left out because this client did not name it. */
    withheld?: true;
    /* The account's usual way can't be used for this step. */
    defaultUnavailable?: true;
};
/* An answer as the server takes it: a code, the recovery phrase's signature, or a key's assertion. */
export type StepProof =
    | { kind: 'totp'; code: string }
    | { kind: 'backup'; code: string }
    | { kind: 'phrase'; signature: string }
    | { kind: 'webauthn'; response: KeyAssertion }
    /* The request another device approved. */
    | { kind: 'device'; requestId: string };
export type StepInput = { token: string; proof: StepProof };
/* What a change to the account sends its step for. */
export type StepPurpose = SecurityAction | 'delete' | 'two-step';
/* What a sign-in ends with: the user, the password envelope, and the session's device. */
export type LoginSession = {
    user: AuthUser;
    envelope: AccountKeyEnvelope;
    device: SessionDevice & { attached: boolean };
};
export type TwoStepMethod = {
    id: string;
    kind: 'totp' | 'webauthn' | 'device';
    /* A key's name, as whoever added it typed it; an app and another device have none. */
    name: string | null;
    createdAt: string;
    lastUsedAt: string | null;
    /* A passkey a password manager syncs, as the key last reported it. */
    synced: boolean;
};
/* The kind of method an account is offered first. */
export type TwoStepDefaultKind = 'webauthn' | 'totp' | 'device';
export type TwoStepStatus = {
    on: boolean;
    methods: TwoStepMethod[];
    backupCodesLeft: number;
    totpFrozen: boolean;
    /* The kind offered first; null with the step off, absent from a server before defaults. */
    defaultKind?: TwoStepDefaultKind | null;
    /* Whether this device could turn on Approve on another device now: another one could approve it. */
    otherDevice?: boolean;
};
export type SecurityEvent = {
    id: string;
    kind: string;
    method: 'totp' | 'webauthn' | 'device' | 'backup' | 'phrase' | null;
    deviceId: string | null;
    deviceKind: DeviceKind | null;
    createdAt: string;
};
/* The password proved again for a change to the step, and the step once it is on. */
export type TwoStepChange = DeviceRemovalProof & { twoStep?: StepInput };

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
    /*
     * `twoStepMethods: true` is the server's word that it reads that field at `loginFinish`
     * and `twoStepChallenge` (docs/two-step-design.md 12). A server from before passkeys says
     * nothing, and is never sent it.
     */
    loginStart(input: {
        email: string;
        startLoginRequest: string;
    }): Promise<LoginChallenge & { twoStepMethods?: boolean }>;
    /*
     * `device`: a device key's proof for this attempt. The reply says which
     * device the session is on, whether the proof brought it back (`attached`),
     * and whether that device has described itself yet (`registered`).
     */
    /*
     * The reply is handed over as it came, unread: the session, the step to answer first, or
     * something that is not the server's answer at all (a proxy's page with a 200). The client
     * tells them apart (login-reply.ts), so an odd reply is never taken for a sign-in. The
     * implementation says this client can answer a step (`twoStep: 1`).
     */
    loginFinish(input: {
        attemptToken: string;
        finishLoginRequest: string;
        device?: { id: string; signature: string };
        /* What else this client can answer a step with; only to a server that said it reads it. */
        twoStepMethods?: string[];
    }): Promise<unknown>;
    /* A sign-in's answer to its step: the session, read the same way. */
    loginTwoStep(input: StepInput): Promise<unknown>;
    /*
     * The account's step as its settings show it, with the methods of the kinds this client
     * names (the implementation names every kind it can show). 501 on a server that has
     * two-step off.
     */
    twoStep(): Promise<TwoStepStatus>;
    /* Changing the step asks for the password again: this starts that exchange. */
    twoStepReauth(input: { startLoginRequest: string }): Promise<LoginChallenge>;
    /* A step for a change this session is about to make. 409 when the account has no step. */
    twoStepChallenge(purpose: StepPurpose, twoStepMethods?: string[]): Promise<StepChallenge>;
    /*
     * The replies below, and a security change's and a deletion's, are handed over unread too:
     * only the server's own answer says the change was made (login-reply.ts).
     */
    twoStepStartTotp(input: TwoStepChange): Promise<unknown>;
    twoStepConfirmTotp(id: string, code: string): Promise<unknown>;
    twoStepRemoveMethod(id: string, input: TwoStepChange): Promise<unknown>;
    twoStepBackupCodes(input: TwoStepChange): Promise<unknown>;
    /* Starts adding a passkey or security key: what the key is asked, and a registration token. */
    twoStepKeyOptions(input: TwoStepChange): Promise<unknown>;
    /* The key's answer: the key as the list shows it, and the backup codes when this turned the step on. */
    twoStepAddKey(input: {
        registrationToken: string;
        name?: string;
        response: KeyRegistration;
    }): Promise<unknown>;
    twoStepRenameMethod(id: string, name: string): Promise<{ method: TwoStepMethod }>;
    /* Which kind is offered first. 403 from a session that never passed the step. */
    twoStepSetDefault(kind: TwoStepDefaultKind): Promise<{ defaultKind: TwoStepDefaultKind }>;
    /*
     * Approve on another device (docs/two-step-design.md 12). Every reply is handed over unread
     * (device-step.ts reads them). Turning it on: the pending method and the step token its one
     * approval runs from, then the confirmation once another device approved.
     */
    twoStepStartDevice(input: TwoStepChange): Promise<unknown>;
    twoStepConfirmDevice(id: string, input: { token: string; requestId: string }): Promise<unknown>;
    /* The device that holds a step token asks, polls (the token in a header) and reveals. */
    approvalStart(input: {
        stepToken: string;
        commitment: string;
        kind?: DeviceKind;
        name?: string;
    }): Promise<unknown>;
    approvalStatus(id: string, stepToken: string): Promise<unknown>;
    approvalReveal(
        id: string,
        input: { stepToken: string; deviceSigningKey: string; nonce: string },
    ): Promise<unknown>;
    /* The device that approves, from its own session. */
    approvals(): Promise<unknown>;
    approvalOpen(id: string, ephemeralKey: string): Promise<unknown>;
    approvalApprove(id: string, signature: string): Promise<unknown>;
    approvalDeny(
        id: string,
        reason: 'denied' | 'wrong-code' | 'not-me' | 'mismatch',
    ): Promise<unknown>;
    securityEvents(): Promise<{ events: SecurityEvent[] }>;
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
    /*
     * `twoStep`: the second step, for an account that has it on. `keepSession`: this client
     * takes a session for this device with the change, so it is not asked for the step again
     * a moment later; the server writes one only when the change passed the step.
     */
    securityFinish(
        input: {
            action: SecurityAction;
            attemptToken: string;
            twoStep?: StepInput;
            keepSession?: 1;
        } & AccountSecurityUpdate,
    ): Promise<unknown>;
    deleteStart(input: { startLoginRequest: string }): Promise<LoginChallenge>;
    deleteFinish(input: {
        attemptToken: string;
        finishLoginRequest: string;
        twoStep?: StepInput;
    }): Promise<unknown>;
    updateProfile(name: string): Promise<{ user: SessionUser }>;
}
