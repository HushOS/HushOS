import type {
    CryptoResults,
    SecurityAction,
    SecurityChallenge,
    SecurityUpdate,
} from '@hushos/crypto';
import type { SettingsEnvelope } from '@hushos/crypto/contacts';
export type { ContactPin, Settings, SettingsEnvelope } from '@hushos/crypto/contacts';
import type { IdentityEnvelope, IdentityKem } from '@hushos/crypto/identity';
import type { RecoveryEnvelope } from '@hushos/crypto/recovery';
import type { AccountKeyEnvelope, AuthUser, SessionUser, SignupIntent } from './protocol';

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
};

export type ContactIdentity = {
    userId: string;
    name: string;
    email: string;
    /* Raised by each succession; a pin remembers it to ask for the chain from there. */
    keyVersion: number;
    encryptionPublicKey: string;
    signingPublicKey: string;
    /* The ML-KEM key and the signing key's binding of it; null until the person unlocks on the new code. */
    kem: { publicKey: string; signature: string } | null;
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
    newEncryptionPublicKey: string;
    newSigningPublicKey: string;
    newKemPublicKey: string;
    signature: string;
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
    }): Promise<{ keyVersion: number }>;
    /* A contact's successions from key version `from` to the current one, in order. */
    contactSuccession(userId: string, from: number): Promise<{ links: SuccessionLink[] }>;
    /* Gives an identity made before hybrid sharing its KEM key, once; 409 when it already has one. */
    addIdentityKem(kem: IdentityKem): Promise<{ ok: true }>;
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
    loginFinish(input: {
        attemptToken: string;
        finishLoginRequest: string;
    }): Promise<{ user: AuthUser; envelope: AccountKeyEnvelope }>;
    session(): Promise<{ user: SessionUser | null }>;
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
    securityFinish(
        input: { action: SecurityAction; attemptToken: string } & AccountSecurityUpdate,
    ): Promise<unknown>;
    deleteStart(input: { startLoginRequest: string }): Promise<LoginChallenge>;
    deleteFinish(input: { attemptToken: string; finishLoginRequest: string }): Promise<unknown>;
    updateProfile(name: string): Promise<{ user: SessionUser }>;
}
