import type { SecurityAction, SecurityChallenge, SecurityUpdate } from '@hushos/crypto';
import type { IdentityEnvelope } from '@hushos/crypto/identity';
import {
    verifyRecoveryReset,
    type RecoveryEnvelope,
    type RecoveryReset,
} from '@hushos/crypto/recovery';
import { authEnv } from '@hushos/env/auth';
import { createHash, randomBytes } from 'node:crypto';
import { authRepository } from '@hushos/db';
import { ready, server, client } from '@hushos/crypto/server';

import {
    ENVELOPE_VERSION,
    OPAQUE_IDENTIFIERS,
    OPAQUE_PROFILE_VERSION,
    type AccountKeyEnvelope,
} from '@hushos/crypto';
import { sendVerificationEmail } from '@hushos/emails/server';

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const ENROLLMENT_SECONDS = 30 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class AuthError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 401 | 403 | 409 | 429 | 503 = 400,
    ) {
        super(message);
        this.name = 'AuthError';
    }
}

function config() {
    return {
        origin: authEnv.APP_ORIGIN,
        secure: authEnv.APP_ORIGIN.startsWith('https:'),
        serverSetup: authEnv.OPAQUE_SERVER_SETUP,
        serverSetupId: authEnv.OPAQUE_SERVER_SETUP_ID,
    };
}

function hash(value: string) {
    return createHash('sha256').update(value).digest();
}

function randomToken() {
    return randomBytes(32).toString('base64url');
}

function cookieName(kind: 'session' | 'enrollment') {
    return `${config().secure ? '__Host-' : ''}hushos-${kind}`;
}

function readToken(request: Request, kind: 'session' | 'enrollment') {
    const name = cookieName(kind);
    const value = request.headers
        .get('cookie')
        ?.split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name}=`))
        ?.slice(name.length + 1);
    return value && TOKEN_PATTERN.test(value) ? value : null;
}

export function authCookie(kind: 'session' | 'enrollment', token: string | null) {
    const seconds = token ? (kind === 'session' ? SESSION_SECONDS : ENROLLMENT_SECONDS) : 0;
    return `${cookieName(kind)}=${token ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${config().secure ? '; Secure' : ''}`;
}

export function normalizeEmail(email: string) {
    return email.trim().toLowerCase();
}

let nextCleanupAt = 0;

export async function guardAuthMutation(request: Request) {
    if (request.headers.get('origin') !== config().origin)
        throw new AuthError('This request must come from HushOS.', 403);
    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
        throw new AuthError('Expected a JSON request.', 400);
    if (!(await authRepository.consumeRateLimit(hash('auth:global'), 600, 60_000)))
        throw new AuthError('Too many requests. Please try again shortly.', 429);
    if (Date.now() >= nextCleanupAt) {
        nextCleanupAt = Date.now() + 60_000;
        await authRepository.cleanupExpired();
    }
}

async function limitEmail(kind: 'register' | 'recover' | 'login', email: string) {
    const limit = kind === 'login' ? 10 : 3;
    if (
        !(await authRepository.consumeRateLimit(hash(`auth:${kind}:${email}`), limit, 15 * 60_000))
    ) {
        throw new AuthError('Too many attempts. Please try again in 15 minutes.', 429);
    }
}

export async function requestRegistrationEmail(
    email: string,
    purpose: 'register' | 'recover' = 'register',
) {
    const normalizedEmail = normalizeEmail(email);
    await limitEmail(purpose, normalizedEmail);
    const token = randomToken();
    await authRepository.createEnrollment({
        purpose,
        email: email.trim(),
        normalizedEmail,
        verificationTokenHash: hash(token),
        expiresAt: new Date(Date.now() + ENROLLMENT_SECONDS * 1000),
    });
    try {
        // The fragment is never sent in an HTTP request or recorded in access logs.
        await sendVerificationEmail(
            email.trim(),
            `${config().origin}/${purpose === 'register' ? 'register' : 'recover'}/complete#verify=${token}`,
            purpose,
        );
    } catch {
        await authRepository.removeEnrollment(hash(token));
        throw new AuthError(
            'Could not send the verification email. Please try again shortly.',
            503,
        );
    }
    return { message: 'Check your inbox for a verification link.' };
}

export async function verifyEmail(token: string) {
    if (!TOKEN_PATTERN.test(token))
        throw new AuthError('This verification link is invalid or has expired. Request a new one.');
    const enrollmentToken = randomToken();
    const enrollment = await authRepository.verifyEnrollment(
        hash(token),
        hash(enrollmentToken),
        new Date(Date.now() + ENROLLMENT_SECONDS * 1000),
    );
    if (!enrollment)
        throw new AuthError('This verification link is invalid or has expired. Request a new one.');
    return { enrollment, cookie: authCookie('enrollment', enrollmentToken) };
}

export async function getEnrollment(
    request: Request,
    purpose: 'register' | 'recover' = 'register',
) {
    const token = readToken(request, 'enrollment');
    if (!token) return null;
    const enrollment = await authRepository.getEnrollment(hash(token));
    return enrollment?.purpose === purpose
        ? { id: enrollment.id, email: enrollment.email, profileVersion: OPAQUE_PROFILE_VERSION }
        : null;
}

export async function startRegistration(request: Request, registrationRequest: string) {
    const enrollment = await getEnrollment(request);
    if (!enrollment) throw new AuthError('Verify your email before creating an account.', 401);
    await ready;
    try {
        return {
            ...server.createRegistrationResponse({
                serverSetup: config().serverSetup,
                userIdentifier: enrollment.id,
                registrationRequest,
            }),
            userId: enrollment.id,
            profileVersion: OPAQUE_PROFILE_VERSION,
        };
    } catch {
        throw new AuthError('Could not start registration. Please try again.');
    }
}

function decodeField(value: string, length: number) {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length !== length || bytes.toString('base64url') !== value)
        throw new AuthError('Invalid account-key envelope.');
    return bytes;
}

export async function finishRegistration(
    request: Request,
    input: {
        name: string;
        registrationRecord: string;
        envelope: AccountKeyEnvelope;
        recovery: RecoveryEnvelope;
        identity: IdentityEnvelope;
    },
) {
    const token = readToken(request, 'enrollment');
    const enrollment = token ? await getEnrollment(request) : null;
    if (!token || !enrollment)
        throw new AuthError('Your registration session expired. Verify your email again.', 401);
    const name = input.name.trim().normalize('NFC');
    if (Array.from(name).length < 1 || Array.from(name).length > 100)
        throw new AuthError('Use a name between 1 and 100 characters.');
    if (
        input.envelope.envelopeVersion !== ENVELOPE_VERSION ||
        input.envelope.keyVersion !== 1 ||
        input.envelope.credentialVersion !== 1
    )
        throw new AuthError('Unsupported account-key envelope.');

    // Parse the registration record through OPAQUE before persisting it.
    await ready;
    try {
        const { startLoginRequest } = client.startLogin({ password: randomToken() });
        server.startLogin({
            serverSetup: config().serverSetup,
            userIdentifier: enrollment.id,
            registrationRecord: input.registrationRecord,
            startLoginRequest,
            identifiers: OPAQUE_IDENTIFIERS,
        });
    } catch {
        throw new AuthError('Invalid registration record. Please try again.');
    }

    const result = await authRepository.registerAccount({
        enrollmentTokenHash: hash(token),
        recovery: decodeRecovery(input.recovery, 1),
        identity: decodeIdentity(input.identity),
        initialQuotaBytes: authEnv.INITIAL_STORAGE_QUOTA_BYTES,
        name,
        registrationRecord: input.registrationRecord,
        profileVersion: OPAQUE_PROFILE_VERSION,
        serverSetupId: config().serverSetupId,
        envelope: {
            envelopeVersion: ENVELOPE_VERSION,
            wrappingSalt: decodeField(input.envelope.wrappingSalt, 32),
            wrappingNonce: decodeField(input.envelope.wrappingNonce, 24),
            encryptedKey: decodeField(input.envelope.encryptedKey, 48),
        },
    });
    if (result.status === 'exists')
        throw new AuthError('An account already uses this email. Please sign in.', 409);
    if (result.status === 'expired')
        throw new AuthError('Your registration session expired. Verify your email again.', 401);
    return { user: result.user, cookie: authCookie('enrollment', null) };
}

export async function startLogin(
    email: string,
    startLoginRequest: string,
    binding?: { purpose: SecurityAction | 'delete'; sessionTokenHash: Buffer },
) {
    const normalizedEmail = normalizeEmail(email);
    await limitEmail('login', normalizedEmail);
    const credential = await authRepository.findCredential(normalizedEmail);
    if (
        credential &&
        (credential.profileVersion !== OPAQUE_PROFILE_VERSION ||
            credential.serverSetupId !== config().serverSetupId)
    )
        throw new AuthError('This account requires a supported authentication configuration.', 503);
    await ready;
    let response;
    try {
        response = server.startLogin({
            serverSetup: config().serverSetup,
            userIdentifier:
                credential?.userId ??
                hash(`hushos/opaque/decoy/v1:${normalizedEmail}`).toString('hex'),
            registrationRecord: credential?.registrationRecord ?? null,
            startLoginRequest,
            identifiers: OPAQUE_IDENTIFIERS,
        });
    } catch {
        throw new AuthError('Unable to sign in. Check your email and password.', 401);
    }
    const attemptToken = randomToken();
    await authRepository.createLoginAttempt({
        tokenHash: hash(attemptToken),
        userId: credential?.userId ?? null,
        credentialVersion: credential?.version ?? null,
        profileVersion: OPAQUE_PROFILE_VERSION,
        serverState: response.serverLoginState,
        purpose: binding?.purpose ?? 'login',
        sessionTokenHash: binding?.sessionTokenHash ?? null,
        expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    return {
        attemptToken,
        loginResponse: response.loginResponse,
        profileVersion: OPAQUE_PROFILE_VERSION,
    };
}

export async function finishLogin(
    request: Request,
    attemptToken: string,
    finishLoginRequest: string,
) {
    const failure = () => new AuthError('Unable to sign in. Check your email and password.', 401);
    if (!TOKEN_PATTERN.test(attemptToken)) throw failure();
    const attempt = await authRepository.consumeLoginAttempt(hash(attemptToken));
    if (
        !attempt ||
        attempt.purpose !== 'login' ||
        attempt.expiresAt.getTime() <= Date.now() ||
        attempt.profileVersion !== OPAQUE_PROFILE_VERSION
    )
        throw failure();
    await ready;
    try {
        server.finishLogin({
            serverLoginState: attempt.serverState,
            finishLoginRequest,
            identifiers: OPAQUE_IDENTIFIERS,
        });
    } catch {
        throw failure();
    }
    if (!attempt.userId || !attempt.credentialVersion) throw failure();

    const token = randomToken();
    const previousToken = readToken(request, 'session');
    const result = await authRepository.createSession({
        userId: attempt.userId,
        credentialVersion: attempt.credentialVersion,
        tokenHash: hash(token),
        previousTokenHash: previousToken ? hash(previousToken) : null,
        expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000),
    });
    if (!result) throw failure();
    const { key, user } = result;
    return {
        user,
        envelope: {
            envelopeVersion: key.envelopeVersion,
            keyVersion: key.keyVersion,
            credentialVersion: key.credentialVersion,
            wrappingSalt: key.wrappingSalt.toString('base64url'),
            wrappingNonce: key.wrappingNonce.toString('base64url'),
            encryptedKey: key.encryptedKey.toString('base64url'),
        },
        cookie: authCookie('session', token),
    };
}

export async function getSessionUser(request: Request) {
    const token = readToken(request, 'session');
    return token ? authRepository.getSessionUser(hash(token)) : null;
}

export async function logout(request: Request) {
    const token = readToken(request, 'session');
    if (token) await authRepository.deleteSession(hash(token));
    return authCookie('session', null);
}

function decodeRecovery(input: RecoveryEnvelope, expectedVersion: number, keyVersion = 1) {
    if (
        input.version !== 1 ||
        input.keyVersion !== keyVersion ||
        input.recoveryVersion !== expectedVersion
    )
        throw new AuthError('Unsupported recovery key envelope.');
    return {
        version: 1,
        keyVersion,
        recoveryVersion: input.recoveryVersion,
        wrappingSalt: decodeField(input.wrappingSalt, 32),
        wrappingNonce: decodeField(input.wrappingNonce, 24),
        encryptedKey: decodeField(input.encryptedKey, 48),
        backupNonce: decodeField(input.backupNonce, 24),
        encryptedRecoveryKey: decodeField(input.encryptedRecoveryKey, 48),
        publicKey: decodeField(input.publicKey, 32),
    };
}
function encodeRecovery(
    key: NonNullable<Awaited<ReturnType<typeof authRepository.getRecoveryKey>>>,
): RecoveryEnvelope {
    return {
        version: 1,
        keyVersion: key.keyVersion,
        recoveryVersion: key.recoveryVersion,
        wrappingSalt: key.wrappingSalt.toString('base64url'),
        wrappingNonce: key.wrappingNonce.toString('base64url'),
        encryptedKey: key.encryptedKey.toString('base64url'),
        backupNonce: key.backupNonce.toString('base64url'),
        encryptedRecoveryKey: key.encryptedRecoveryKey.toString('base64url'),
        publicKey: key.publicKey.toString('base64url'),
    };
}
export async function getRecoveryBackup(request: Request) {
    const user = await getSessionUser(request);
    if (!user) throw new AuthError('Sign in to view your recovery key.', 401);
    const key = await authRepository.getRecoveryKey(user.id);
    if (!key) throw new AuthError('This account does not have a recovery key.', 409);
    return { userId: user.id, recovery: encodeRecovery(key), confirmed: key.confirmedAt !== null };
}
export async function confirmRecoveryBackup(request: Request, recoveryVersion: number) {
    const user = await getSessionUser(request);
    if (!user) throw new AuthError('Sign in to confirm your recovery key.', 401);
    if (!(await authRepository.confirmRecoveryKey(user.id, recoveryVersion)))
        throw new AuthError('Your recovery key changed. Save the current key.');
    return { success: true };
}
export async function startRecovery(request: Request, registrationRequest: string) {
    const enrollment = await getEnrollment(request, 'recover');
    if (!enrollment) throw new AuthError('Verify your email before recovering your account.', 401);
    await limitEmail('recover', normalizeEmail(enrollment.email));
    const credential = await authRepository.findCredential(normalizeEmail(enrollment.email));
    const recovery = credential ? await authRepository.getRecoveryKey(credential.userId) : null;
    if (!credential || !recovery)
        throw new AuthError('No recovery key is available for this account.', 409);
    await ready;
    let response;
    try {
        response = server.createRegistrationResponse({
            serverSetup: config().serverSetup,
            userIdentifier: credential.userId,
            registrationRequest,
        });
    } catch {
        throw new AuthError('Could not start recovery. Please try again.');
    }
    const attemptToken = randomToken();
    await authRepository.createRecoveryAttempt({
        tokenHash: hash(attemptToken),
        userId: credential.userId,
        enrollmentId: enrollment.id,
        credentialVersion: credential.version,
        expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    return {
        ...response,
        attemptToken,
        userId: credential.userId,
        credentialVersion: credential.version,
        profileVersion: OPAQUE_PROFILE_VERSION,
        recovery: encodeRecovery(recovery),
    };
}
export async function finishRecovery(
    request: Request,
    input: RecoveryReset & { signature: string },
) {
    const token = readToken(request, 'enrollment');
    const enrollment = token ? await getEnrollment(request, 'recover') : null;
    if (!token || !enrollment)
        throw new AuthError('Your recovery session expired. Verify your email again.', 401);
    const failure = () =>
        new AuthError('Could not recover your account. Check your recovery phrase and try again.');
    if (!TOKEN_PATTERN.test(input.attemptToken)) throw failure();
    const attempt = await authRepository.consumeRecoveryAttempt(hash(input.attemptToken));
    if (
        !attempt ||
        attempt.expiresAt.getTime() <= Date.now() ||
        attempt.userId !== input.userId ||
        attempt.enrollmentId !== enrollment.id ||
        attempt.credentialVersion !== input.credentialVersion
    )
        throw failure();
    const oldRecovery = await authRepository.getRecoveryKey(attempt.userId);
    if (!oldRecovery) throw failure();
    try {
        if (
            !(await verifyRecoveryReset(
                input,
                input.signature,
                oldRecovery.publicKey.toString('base64url'),
            ))
        )
            throw failure();
    } catch {
        throw failure();
    }
    if (
        input.envelope.envelopeVersion !== 1 ||
        input.envelope.keyVersion !== oldRecovery.keyVersion ||
        input.envelope.credentialVersion !== attempt.credentialVersion + 1
    )
        throw failure();
    await ready;
    try {
        const { startLoginRequest } = client.startLogin({ password: randomToken() });
        server.startLogin({
            serverSetup: config().serverSetup,
            userIdentifier: attempt.userId,
            registrationRecord: input.registrationRecord,
            startLoginRequest,
            identifiers: OPAQUE_IDENTIFIERS,
        });
    } catch {
        throw failure();
    }
    const user = await authRepository.resetAccountPassword({
        userId: attempt.userId,
        enrollmentId: enrollment.id,
        enrollmentTokenHash: hash(token),
        credentialVersion: attempt.credentialVersion,
        registrationRecord: input.registrationRecord,
        profileVersion: OPAQUE_PROFILE_VERSION,
        serverSetupId: config().serverSetupId,
        envelope: {
            keyVersion: input.envelope.keyVersion,
            wrappingSalt: decodeField(input.envelope.wrappingSalt, 32),
            wrappingNonce: decodeField(input.envelope.wrappingNonce, 24),
            encryptedKey: decodeField(input.envelope.encryptedKey, 48),
        },
        recovery: decodeRecovery(
            input.recovery,
            oldRecovery.recoveryVersion + 1,
            oldRecovery.keyVersion,
        ),
    });
    if (!user) throw failure();
    return { user, cookie: authCookie('enrollment', null) };
}

export async function getStorageAllowance(request: Request) {
    const user = await getSessionUser(request);
    if (!user) throw new AuthError('Sign in to view your storage allowance.', 401);
    return { storage: await authRepository.getStorageAllowance(user.id) };
}

function decodeIdentity(input: IdentityEnvelope, keyVersion = 1) {
    if (input.version !== 1 || input.keyVersion !== keyVersion)
        throw new AuthError('Unsupported identity key version.');
    return {
        version: 1,
        keyVersion,
        wrappingSalt: decodeField(input.wrappingSalt, 32),
        encryptionPublicKey: decodeField(input.encryptionPublicKey, 32),
        encryptionPrivateKeyNonce: decodeField(input.encryptionPrivateKeyNonce, 24),
        encryptedEncryptionPrivateKey: decodeField(input.encryptedEncryptionPrivateKey, 48),
        signingPublicKey: decodeField(input.signingPublicKey, 32),
        signingSeedNonce: decodeField(input.signingSeedNonce, 24),
        encryptedSigningSeed: decodeField(input.encryptedSigningSeed, 48),
    };
}

export async function startAccountDeletion(request: Request, startLoginRequest: string) {
    const user = await getSessionUser(request);
    const token = readToken(request, 'session');
    if (!user || !token) throw new AuthError('Sign in before deleting your account.', 401);
    return startLogin(user.email, startLoginRequest, {
        purpose: 'delete',
        sessionTokenHash: hash(token),
    });
}
export async function finishAccountDeletion(
    request: Request,
    input: { attemptToken: string; finishLoginRequest: string },
) {
    const user = await getSessionUser(request);
    const token = readToken(request, 'session');
    if (!user || !token) throw new AuthError('Sign in before deleting your account.', 401);
    const failure = () =>
        new AuthError('Could not delete your account. Check your password and try again.');
    if (!TOKEN_PATTERN.test(input.attemptToken)) throw failure();
    const attempt = await authRepository.consumeLoginAttempt(hash(input.attemptToken));
    if (
        !attempt ||
        attempt.purpose !== 'delete' ||
        attempt.userId !== user.id ||
        attempt.credentialVersion !== user.credentialVersion ||
        !attempt.sessionTokenHash?.equals(hash(token)) ||
        attempt.expiresAt.getTime() <= Date.now() ||
        attempt.profileVersion !== OPAQUE_PROFILE_VERSION
    )
        throw failure();
    await ready;
    try {
        server.finishLogin({
            serverLoginState: attempt.serverState,
            finishLoginRequest: input.finishLoginRequest,
            identifiers: OPAQUE_IDENTIFIERS,
        });
    } catch {
        throw failure();
    }
    if (
        !(await authRepository.deleteAccount({
            userId: user.id,
            credentialVersion: user.credentialVersion,
            sessionTokenHash: hash(token),
        }))
    )
        throw failure();
    return { success: true };
}

export async function getAccountSetup(request: Request) {
    const user = await getSessionUser(request);
    if (!user) throw new AuthError('Sign in to finish account setup.', 401);
    return { missing: await authRepository.getAccountSetup(user.id) };
}

export async function initializeAccount(
    request: Request,
    input: { recovery?: RecoveryEnvelope; identity?: IdentityEnvelope },
) {
    const user = await getSessionUser(request);
    const token = readToken(request, 'session');
    if (!user || !token) throw new AuthError('Sign in to finish account setup.', 401);
    const initialized = await authRepository.initializeAccount({
        userId: user.id,
        credentialVersion: user.credentialVersion,
        sessionTokenHash: hash(token),
        initialQuotaBytes: authEnv.INITIAL_STORAGE_QUOTA_BYTES,
        recovery: input.recovery ? decodeRecovery(input.recovery, 1) : undefined,
        identity: input.identity ? decodeIdentity(input.identity) : undefined,
    });
    if (!initialized) throw new AuthError('Sign in to finish account setup.', 401);
    return { ok: true };
}

export async function startSecurityChange(
    request: Request,
    input: {
        action: SecurityAction;
        startLoginRequest: string;
        registrationRequest: string;
    },
): Promise<SecurityChallenge> {
    const user = await getSessionUser(request);
    const token = readToken(request, 'session');
    if (!user || !token) throw new AuthError('Sign in before changing account security.', 401);
    const bundles = await authRepository.getSecurityBundles(user.id);
    if (!bundles || bundles.envelope.credentialVersion !== user.credentialVersion)
        throw new AuthError('Unlock your account and finish recovery setup first.', 409);
    if (input.action === 'master-key') {
        const storage = await authRepository.getStorageAllowance(user.id);
        if (!storage || storage.usedBytes !== '0' || storage.reservedBytes !== '0')
            throw new AuthError(
                'Master-key rotation is not available for accounts with stored data yet.',
                409,
            );
    }
    const challenge = await startLogin(user.email, input.startLoginRequest, {
        purpose: input.action,
        sessionTokenHash: hash(token),
    });
    let registration;
    try {
        registration = server.createRegistrationResponse({
            serverSetup: config().serverSetup,
            userIdentifier: user.id,
            registrationRequest: input.registrationRequest,
        });
    } catch {
        throw new AuthError('Could not start the security change. Please try again.');
    }
    const e = bundles.envelope;
    const i = bundles.identity;
    return {
        ...challenge,
        ...registration,
        action: input.action,
        userId: user.id,
        envelope: {
            envelopeVersion: e.envelopeVersion,
            keyVersion: e.keyVersion,
            credentialVersion: e.credentialVersion,
            wrappingSalt: e.wrappingSalt.toString('base64url'),
            wrappingNonce: e.wrappingNonce.toString('base64url'),
            encryptedKey: e.encryptedKey.toString('base64url'),
        },
        recovery: encodeRecovery(bundles.recovery),
        identity: {
            version: 1,
            keyVersion: i.keyVersion,
            wrappingSalt: i.wrappingSalt.toString('base64url'),
            encryptionPublicKey: i.encryptionPublicKey.toString('base64url'),
            encryptionPrivateKeyNonce: i.encryptionPrivateKeyNonce.toString('base64url'),
            encryptedEncryptionPrivateKey: i.encryptedEncryptionPrivateKey.toString('base64url'),
            signingPublicKey: i.signingPublicKey.toString('base64url'),
            signingSeedNonce: i.signingSeedNonce.toString('base64url'),
            encryptedSigningSeed: i.encryptedSigningSeed.toString('base64url'),
        },
    };
}

export async function finishSecurityChange(
    request: Request,
    input: SecurityUpdate & { action: SecurityAction; attemptToken: string },
) {
    const user = await getSessionUser(request);
    const token = readToken(request, 'session');
    if (!user || !token) throw new AuthError('Sign in before changing account security.', 401);
    const failure = () =>
        new AuthError('Account security could not be changed. Sign in again and retry.', 409);
    if (!TOKEN_PATTERN.test(input.attemptToken)) throw failure();
    const attempt = await authRepository.consumeLoginAttempt(hash(input.attemptToken));
    if (
        !attempt ||
        attempt.purpose !== input.action ||
        attempt.userId !== user.id ||
        attempt.credentialVersion !== user.credentialVersion ||
        !attempt.sessionTokenHash?.equals(hash(token)) ||
        attempt.expiresAt.getTime() <= Date.now() ||
        attempt.profileVersion !== OPAQUE_PROFILE_VERSION
    )
        throw failure();
    await ready;
    try {
        server.finishLogin({
            serverLoginState: attempt.serverState,
            finishLoginRequest: input.finishLoginRequest,
            identifiers: OPAQUE_IDENTIFIERS,
        });
        const { startLoginRequest } = client.startLogin({ password: randomToken() });
        server.startLogin({
            serverSetup: config().serverSetup,
            userIdentifier: user.id,
            registrationRecord: input.registrationRecord,
            startLoginRequest,
            identifiers: OPAQUE_IDENTIFIERS,
        });
    } catch {
        throw failure();
    }
    const old = await authRepository.getSecurityBundles(user.id);
    if (!old) throw failure();
    const keyVersion = old.envelope.keyVersion + (input.action === 'master-key' ? 1 : 0);
    if (
        input.envelope.envelopeVersion !== 1 ||
        input.envelope.keyVersion !== keyVersion ||
        input.envelope.credentialVersion !== user.credentialVersion + 1 ||
        (input.action === 'password' ? input.recovery !== undefined : !input.recovery) ||
        (input.action === 'master-key' ? !input.identity : input.identity !== undefined)
    )
        throw failure();
    const changed = await authRepository.changeAccountSecurity({
        userId: user.id,
        action: input.action,
        sessionTokenHash: hash(token),
        credentialVersion: user.credentialVersion,
        registrationRecord: input.registrationRecord,
        envelope: {
            keyVersion,
            wrappingSalt: decodeField(input.envelope.wrappingSalt, 32),
            wrappingNonce: decodeField(input.envelope.wrappingNonce, 24),
            encryptedKey: decodeField(input.envelope.encryptedKey, 48),
        },
        recovery: input.recovery
            ? decodeRecovery(input.recovery, old.recovery.recoveryVersion + 1, keyVersion)
            : undefined,
        identity: input.identity ? decodeIdentity(input.identity, keyVersion) : undefined,
    });
    if (!changed) throw failure();
    return { success: true };
}
