import type {
    CryptoResults,
    SecurityAction,
    SecurityChallenge,
    SecurityUpdate,
} from '@hushos/crypto';
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

export interface AuthApi {
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
    }): Promise<SecurityChallenge>;
    securityFinish(
        input: { action: SecurityAction; attemptToken: string } & SecurityUpdate,
    ): Promise<unknown>;
    deleteStart(input: { startLoginRequest: string }): Promise<LoginChallenge>;
    deleteFinish(input: { attemptToken: string; finishLoginRequest: string }): Promise<unknown>;
    updateProfile(name: string): Promise<{ user: SessionUser }>;
}
