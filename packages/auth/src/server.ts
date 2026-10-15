import type {
    SecurityAction,
    SecurityChallenge,
    SecurityUpdate,
    WorkspaceKeyEnvelope,
} from '@hushos/crypto';
import type { IdentityEnvelope } from '@hushos/crypto/identity';

/* Ed25519 then ML-DSA-65: a person's hybrid signature (docs/identity-pq-design.md). */
const HYBRID_SIGNATURE_BYTES = 3373;
import { SETTINGS_MAX_BYTES, SETTINGS_PAD_STEP } from '@hushos/crypto/contacts';
import {
    verifyRecoveryReset,
    type RecoveryEnvelope,
    type RecoveryReset,
} from '@hushos/crypto/recovery';
import { authEnv } from '@hushos/env/auth';
import { createHash, randomBytes } from 'node:crypto';
import { adminRepository, authRepository } from '@hushos/db';
import type { SignupIntent } from '@hushos/db/schema';
import { sendShareEmail, sendVerificationEmail } from '@hushos/emails/server';
import { ready, server, client } from '@hushos/crypto/server';
import { SECURITY_CHANGE_IDENTITY_BYTES, SECURITY_CHANGE_REST_BYTES } from './limits';

import {
    ENVELOPE_VERSION,
    OPAQUE_IDENTIFIERS,
    OPAQUE_PROFILE_VERSION,
    type AccountKeyEnvelope,
} from '@hushos/crypto';

import {
    AuthError,
    ENROLLMENT_SECONDS,
    SESSION_IDLE_SECONDS,
    SESSION_MAX_SECONDS,
    TOKEN_PATTERN,
} from './tokens';

export { AuthError } from './tokens';
export { SECURITY_CHANGE_IDENTITY_BYTES, SECURITY_CHANGE_REST_BYTES } from './limits';

/*
 * The auth domain. Nothing here reads a request: callers hand in the session or
 * enrollment token they found (see `http.ts`) and get tokens back to store.
 */
export const EMAIL_ADDRESS_PATTERN =
    /^(?=.{1,64}@)[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function config() {
    return {
        origin: authEnv.APP_ORIGIN,
        serverSetupId: authEnv.OPAQUE_SERVER_SETUP_ID,
    };
}

/*
 * The OPAQUE server setup: from the environment when the operator provides one,
 * otherwise made once on first start and kept in the database under the setup
 * id, so a fresh stack registers accounts without anyone minting a secret by
 * hand. Every password depends on it; the database backup is what keeps it.
 */
let setup: Promise<string> | undefined;
function serverSetup() {
    setup ??= (async () => {
        if (authEnv.OPAQUE_SERVER_SETUP) return authEnv.OPAQUE_SERVER_SETUP;
        // Beside the password records, a dump of the database is all an offline guess needs.
        if (process.env.NODE_ENV === 'production')
            console.warn(
                'OPAQUE_SERVER_SETUP is not set, so the server setup lives in the database beside the password records. Move it to the environment (see docs/self-hosting.md).',
            );
        await ready;
        return authRepository.ensureServerSecret(
            `opaque-setup:${authEnv.OPAQUE_SERVER_SETUP_ID}`,
            () => server.createSetup(),
        );
    })().catch((error: unknown) => {
        setup = undefined;
        throw error;
    });
    return setup;
}

function hash(value: string) {
    return createHash('sha256').update(value).digest();
}

function randomToken() {
    return randomBytes(32).toString('base64url');
}

export function normalizeEmail(email: string) {
    const normalized = email.trim().toLowerCase();
    if (normalized.length > 254 || !EMAIL_ADDRESS_PATTERN.test(normalized))
        throw new AuthError('Enter a valid email address.');
    return normalized;
}

function normalizeName(value: string) {
    const name = value.trim().normalize('NFC');
    if (Array.from(name).length < 1 || Array.from(name).length > 100)
        throw new AuthError('Use a name between 1 and 100 characters.');
    return name;
}

// Per-address first, so one client cannot exhaust everyone's budget; the global
// bucket is a circuit breaker for the whole instance, not the working limit.
export async function limitAuthMutation(address: string) {
    if (!(await authRepository.consumeRateLimit(hash(`auth:address:${address}`), 120, 60_000)))
        throw new AuthError('Too many requests. Please try again shortly.', 429);
    if (!(await authRepository.consumeRateLimit(hash('auth:global'), 6_000, 60_000)))
        throw new AuthError('Too many requests. Please try again shortly.', 429);
}

// Outbound mail is the expensive, abusable resource: bound it per address and per hour.
async function limitEmailSend(address: string) {
    if (
        !(await authRepository.consumeRateLimit(
            hash(`auth:email:address:${address}`),
            20,
            60 * 60_000,
        )) ||
        !(await authRepository.consumeRateLimit(hash('auth:email:global'), 600, 60 * 60_000))
    )
        throw new AuthError('Too many verification emails. Please try again later.', 429);
}

async function limitEmail(kind: 'register' | 'recover-email' | 'recover-start', email: string) {
    if (!(await authRepository.consumeRateLimit(hash(`auth:${kind}:${email}`), 3, 15 * 60_000)))
        throw new AuthError('Too many attempts. Please try again in 15 minutes.', 429);
}

/*
 * Password attempts are counted per email *and* client address, so a stranger who
 * knows your email cannot lock you out. Authenticated security actions count per
 * account instead: they already require a live session.
 */
async function limitPasswordAttempts(key: string) {
    if (!(await authRepository.consumeRateLimit(hash(key), 10, 15 * 60_000)))
        throw new AuthError('Too many attempts. Please try again in 15 minutes.', 429);
}

const INTENT_VALUE = /^[A-Za-z0-9_-]{1,64}$/;
function normalizeIntent(intent: SignupIntent | undefined) {
    if (!intent) return undefined;
    const clean: SignupIntent = {};
    for (const key of ['plan', 'referral', 'source'] as const) {
        const value = intent[key];
        if (typeof value === 'string' && INTENT_VALUE.test(value)) clean[key] = value;
    }
    return Object.keys(clean).length ? clean : undefined;
}

export async function requestRegistrationEmail(
    email: string,
    purpose: 'register' | 'recover' = 'register',
    address = 'unknown',
    intent?: SignupIntent,
) {
    const normalizedEmail = normalizeEmail(email);
    await limitEmailSend(address);
    await limitEmail(purpose === 'recover' ? 'recover-email' : 'register', normalizedEmail);
    const token = randomToken();
    await authRepository.createEnrollment({
        purpose,
        email: normalizedEmail,
        normalizedEmail,
        verificationTokenHash: hash(token),
        expiresAt: new Date(Date.now() + ENROLLMENT_SECONDS * 1000),
        intent: purpose === 'register' ? normalizeIntent(intent) : undefined,
    });
    try {
        // The fragment is never sent in an HTTP request or recorded in access logs.
        await sendVerificationEmail(
            normalizedEmail,
            `${config().origin}/${purpose === 'register' ? 'register' : 'recover'}/complete#verify=${token}`,
            purpose,
        );
    } catch (error) {
        await authRepository.removeEnrollment(hash(token));
        throw new AuthError(
            'Could not send the verification email. Please try again shortly.',
            503,
            { cause: error },
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
    return { enrollment, enrollmentToken };
}

/* The verified enrollment behind a token, if it exists and serves the given purpose. */
export async function getEnrollment(
    enrollmentToken: string | null,
    purpose: 'register' | 'recover' = 'register',
) {
    if (!enrollmentToken || !TOKEN_PATTERN.test(enrollmentToken)) return null;
    const enrollment = await authRepository.getEnrollment(hash(enrollmentToken));
    return enrollment?.purpose === purpose
        ? { id: enrollment.id, email: enrollment.email, profileVersion: OPAQUE_PROFILE_VERSION }
        : null;
}

async function requireEnrollment(
    enrollmentToken: string | null,
    purpose: 'register' | 'recover',
    message: string,
) {
    const enrollment = await getEnrollment(enrollmentToken, purpose);
    if (!enrollmentToken || !enrollment) throw new AuthError(message, 401);
    return { enrollment, token: enrollmentToken };
}

export async function startRegistration(
    enrollmentToken: string | null,
    registrationRequest: string,
) {
    const { enrollment } = await requireEnrollment(
        enrollmentToken,
        'register',
        'Verify your email before creating an account.',
    );
    await ready;
    try {
        return {
            ...server.createRegistrationResponse({
                serverSetup: await serverSetup(),
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

function supportedEnvelope(version: number): typeof ENVELOPE_VERSION {
    if (version !== ENVELOPE_VERSION)
        throw new AuthError('This account-key envelope is not supported.', 503);
    return ENVELOPE_VERSION;
}

function decodeField(value: string, length: number) {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length !== length || bytes.toString('base64url') !== value)
        throw new AuthError('Invalid account-key envelope.');
    return bytes;
}

export async function finishRegistration(
    enrollmentToken: string | null,
    input: {
        name: string;
        registrationRecord: string;
        envelope: AccountKeyEnvelope;
        recovery: RecoveryEnvelope;
        identity: IdentityEnvelope;
        workspace: { id: string; grant: WorkspaceKeyEnvelope };
    },
) {
    const { enrollment, token } = await requireEnrollment(
        enrollmentToken,
        'register',
        'Your registration session expired. Verify your email again.',
    );
    const name = normalizeName(input.name);
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
            serverSetup: await serverSetup(),
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
        identity: decodeIdentity(input.identity, 1, enrollment.id, { current: true }),
        workspace: decodeWorkspaceGrant(input.workspace, 1),
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
    return { user: result.user };
}

// Refusing every sign-in, not only stranded accounts, keeps known and unknown emails
// indistinguishable after a setup rotation.
let setupChecked = 0;
async function assertCredentialsMatchSetup() {
    if (Date.now() - setupChecked < 60_000) return;
    if (await authRepository.hasCredentialsOutside(OPAQUE_PROFILE_VERSION, config().serverSetupId))
        throw new AuthError(
            'Sign-in is unavailable until the server configuration is fixed.',
            503,
            {
                cause: Object.assign(new Error('OPAQUE setup mismatch'), {
                    name: 'ConfigurationError',
                    code: 'OPAQUE_SETUP_MISMATCH',
                }),
            },
        );
    setupChecked = Date.now();
}

export async function startLogin(
    email: string,
    startLoginRequest: string,
    binding?: { purpose: SecurityAction | 'delete'; sessionTokenHash: Buffer; userId: string },
    address = 'unknown',
) {
    const normalizedEmail = normalizeEmail(email);
    await limitPasswordAttempts(
        binding ? `auth:security:${binding.userId}` : `auth:login:${normalizedEmail}:${address}`,
    );
    await assertCredentialsMatchSetup();
    const credential = await authRepository.findCredential(normalizedEmail);
    await ready;
    let response;
    try {
        response = server.startLogin({
            serverSetup: await serverSetup(),
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

/*
 * Completes a sign-in and opens a session. `previousSessionToken` is the session the
 * browser still holds, if any, so the repository can retire it in the same step.
 */
export async function finishLogin(
    attemptToken: string,
    finishLoginRequest: string,
    previousSessionToken: string | null = null,
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
    const previousToken =
        previousSessionToken && TOKEN_PATTERN.test(previousSessionToken)
            ? previousSessionToken
            : null;
    const result = await authRepository.createSession({
        userId: attempt.userId,
        credentialVersion: attempt.credentialVersion,
        tokenHash: hash(token),
        previousTokenHash: previousToken ? hash(previousToken) : null,
        expiresAt: new Date(Date.now() + SESSION_IDLE_SECONDS * 1000),
    });
    if (!result) throw failure();
    if ('suspended' in result)
        throw new AuthError('This account is suspended. Contact whoever runs this instance.', 403);
    const { key, user } = result;
    return {
        user,
        envelope: {
            envelopeVersion: supportedEnvelope(key.envelopeVersion),
            keyVersion: key.keyVersion,
            credentialVersion: key.credentialVersion,
            wrappingSalt: key.wrappingSalt.toString('base64url'),
            wrappingNonce: key.wrappingNonce.toString('base64url'),
            encryptedKey: key.encryptedKey.toString('base64url'),
        },
        sessionToken: token,
    };
}

/* The user behind a session token, or null when the token is missing, malformed, or expired. */
export async function getSessionUser(sessionToken: string | null) {
    if (!sessionToken || !TOKEN_PATTERN.test(sessionToken)) return null;
    return authRepository.getSessionUser(hash(sessionToken), {
        idleSeconds: SESSION_IDLE_SECONDS,
        maxSeconds: SESSION_MAX_SECONDS,
    });
}

async function requireSession(sessionToken: string | null, message: string) {
    const user = await getSessionUser(sessionToken);
    if (!sessionToken || !user) throw new AuthError(message, 401);
    return { user, token: sessionToken };
}

/* ------------------------------------------------------------------------- */
/* Identity, contacts, settings                                               */
/* ------------------------------------------------------------------------- */

/* The columns an identity envelope is made of: the current row and every row of its history. */
type IdentityRow = Pick<
    NonNullable<Awaited<ReturnType<typeof authRepository.getIdentity>>>,
    | 'keyVersion'
    | 'wrappingSalt'
    | 'encryptionPublicKey'
    | 'encryptionPrivateKeyNonce'
    | 'encryptedEncryptionPrivateKey'
    | 'signingPublicKey'
    | 'signingSeedNonce'
    | 'encryptedSigningSeed'
    | 'version'
    | 'kemPublicKey'
    | 'kemSeedNonce'
    | 'encryptedKemSeed'
    | 'kemSignature'
    | 'mlDsaPublicKey'
    | 'mlDsaSeedNonce'
    | 'encryptedMlDsaSeed'
    | 'keysSignature'
>;
function encodeIdentity(i: IdentityRow): IdentityEnvelope {
    const b64 = (bytes: Buffer) => bytes.toString('base64url');
    if (i.version === 2)
        return {
            version: 2,
            keyVersion: i.keyVersion,
            wrappingSalt: b64(i.wrappingSalt),
            encryptionPublicKey: b64(i.encryptionPublicKey),
            encryptionPrivateKeyNonce: b64(i.encryptionPrivateKeyNonce),
            encryptedEncryptionPrivateKey: b64(i.encryptedEncryptionPrivateKey),
            signingPublicKey: b64(i.signingPublicKey),
            signingSeedNonce: b64(i.signingSeedNonce),
            encryptedSigningSeed: b64(i.encryptedSigningSeed),
            kem: {
                publicKey: b64(i.kemPublicKey!),
                seedNonce: b64(i.kemSeedNonce!),
                encryptedSeed: b64(i.encryptedKemSeed!),
            },
            mlDsa: {
                publicKey: b64(i.mlDsaPublicKey!),
                seedNonce: b64(i.mlDsaSeedNonce!),
                encryptedSeed: b64(i.encryptedMlDsaSeed!),
            },
            keysSignature: b64(i.keysSignature!),
        };
    return {
        version: 1,
        keyVersion: i.keyVersion,
        wrappingSalt: i.wrappingSalt.toString('base64url'),
        encryptionPublicKey: i.encryptionPublicKey.toString('base64url'),
        encryptionPrivateKeyNonce: i.encryptionPrivateKeyNonce.toString('base64url'),
        encryptedEncryptionPrivateKey: i.encryptedEncryptionPrivateKey.toString('base64url'),
        signingPublicKey: i.signingPublicKey.toString('base64url'),
        signingSeedNonce: i.signingSeedNonce.toString('base64url'),
        encryptedSigningSeed: i.encryptedSigningSeed.toString('base64url'),
        kem:
            i.kemPublicKey && i.kemSeedNonce && i.encryptedKemSeed && i.kemSignature
                ? {
                      publicKey: i.kemPublicKey.toString('base64url'),
                      seedNonce: i.kemSeedNonce.toString('base64url'),
                      encryptedSeed: i.encryptedKemSeed.toString('base64url'),
                      signature: i.kemSignature.toString('base64url'),
                  }
                : null,
    };
}

/* The person's own identity envelope, for the worker to open the private keys. */
export async function getIdentityEnvelope(sessionToken: string | null) {
    const { user } = await requireSession(sessionToken, 'Sign in to open your identity.');
    const i = await authRepository.getIdentity(user.id);
    if (!i) throw new AuthError('Finish account setup first.', 409);
    return { identity: encodeIdentity(i) };
}

/*
 * The upgrade of a version 1 identity to version 2, made on the person's device
 * (docs/identity-pq-design.md 2): the same keys and key version plus an ML-DSA
 * key and the keys statement, checked here before the repository, under the
 * account's lock, checks the keys are the current ones. A device that lost a
 * race is answered 409 with the identity that won, to open and adopt.
 */
export async function upgradeIdentity(
    sessionToken: string | null,
    input: { identity: IdentityEnvelope },
) {
    const { user, token } = await requireSession(sessionToken, 'Sign in to upgrade your keys.');
    const decoded = decodeIdentity(input.identity, input.identity.keyVersion, user.id, {
        current: true,
    });
    const result = await authRepository.upgradeIdentity({
        userId: user.id,
        credentialVersion: user.credentialVersion,
        sessionTokenHash: hash(token),
        identity: decoded as authRepository.IdentityV2,
    });
    switch (result.status) {
        case 'ok':
            return { identity: encodeIdentity({ ...decoded, version: 2 } as IdentityRow) };
        case 'stale':
            // Another device won: the caller reads the identity again and opens that one.
            throw new AuthError('Your keys were upgraded on another device.', 409);
        case 'session':
            throw new AuthError('Sign in again to upgrade your keys.', 401);
        case 'no-identity':
            throw new AuthError('Finish account setup first.', 409);
        case 'mismatch':
            throw new AuthError('An upgrade must keep your current keys.', 400);
    }
}

/*
 * Replaces the person's identity with one minted on their device at the next
 * key version, vouched for by the current identity's hybrid signature
 * (docs/identity-pq-design.md 2). The new identity's keys statement is checked
 * here; the succession statement, the key version and the session under the
 * account's lock in the repository. The old identity stays, sealed, in the
 * history, because shares sealed to it still open only with it.
 */
export async function succeedIdentity(
    sessionToken: string | null,
    input: { identity: IdentityEnvelope; signature: string },
) {
    const { user, token } = await requireSession(sessionToken, 'Sign in to replace your keys.');
    const decoded = decodeIdentity(input.identity, input.identity.keyVersion, user.id, {
        current: true,
    });
    const result = await authRepository.succeedIdentity({
        userId: user.id,
        credentialVersion: user.credentialVersion,
        sessionTokenHash: hash(token),
        identity: decoded as authRepository.IdentityV2,
        signature: decodeField(input.signature, HYBRID_SIGNATURE_BYTES),
    });
    switch (result.status) {
        case 'ok':
            return { keyVersion: result.keyVersion };
        case 'session':
            throw new AuthError('Sign in again to replace your keys.', 401);
        case 'no-identity':
            throw new AuthError('Finish account setup first.', 409);
        case 'not-upgraded':
            throw new AuthError('Update HushOS to replace your keys.', 409);
        case 'stale':
            throw new AuthError('Your keys changed on another device. Reload and try again.', 409);
        case 'unchanged':
            throw new AuthError('The new keys must differ from the current ones.', 400);
        case 'bad-signature':
            throw new AuthError('The new keys are not signed by your current keys.', 400);
        case 'history-full':
            throw new AuthError('This account has replaced its keys as many times as it can.', 409);
    }
}

/*
 * The most bytes a security change may send for this session's account (see
 * limits.ts). Null without a current session.
 */
export async function securityChangeBodyLimit(sessionToken: string | null) {
    const user = await getSessionUser(sessionToken);
    if (!user) return null;
    const earlier = await authRepository.countIdentityHistory(user.id);
    return (earlier + 1) * SECURITY_CHANGE_IDENTITY_BYTES + SECURITY_CHANGE_REST_BYTES;
}

/* The person's own earlier identities, oldest first, to open shares sealed to earlier keys. */
export async function getIdentityHistory(sessionToken: string | null) {
    const { user } = await requireSession(sessionToken, 'Sign in to open your identity.');
    const history = await authRepository.listIdentityHistory(user.id);
    return { identities: history.map(encodeIdentity) };
}

/*
 * Lookups walk the directory, so they are bounded per account and per client
 * address: someone with many accounts behind one address gets no more than a
 * busy household would, and one account cannot spread across addresses either.
 */
async function limitLookups(kind: 'lookup' | 'succession', userId: string, address: string) {
    if (
        !(await authRepository.consumeRateLimit(hash(`contacts:${kind}:${userId}`), 60, 60_000)) ||
        !(await authRepository.consumeRateLimit(
            hash(`contacts:${kind}:address:${address}`),
            120,
            60_000,
        ))
    )
        throw new AuthError('Too many lookups. Please try again shortly.', 429);
}

/*
 * How an account's identity got from key version `from` to the current one:
 * each succession with the keys on both sides and the old signing key's
 * signature. A contact whose pin is at `from` checks every link before taking
 * the new keys. Bounded per person and per address like a lookup.
 */
export async function contactSuccession(
    sessionToken: string | null,
    userId: string,
    from: number,
    address: string,
) {
    const { user } = await requireSession(sessionToken, 'Sign in to look up a contact.');
    await limitLookups('succession', user.id, address);
    if (!Number.isSafeInteger(from) || from < 1)
        throw new AuthError('Ask from a key version of 1 or more.', 400);
    const chain = await authRepository.successionChain(userId, from);
    if (!chain) throw new AuthError('No HushOS account with that id has finished setup.', 404);
    const b64 = (bytes: Buffer) => bytes.toString('base64url');
    // Only hybrid (version 2) links: a chain through a link signed with Ed25519 alone is
    // not followed anywhere, so it is not served; the gap shows as the changed-key warning.
    return {
        links: chain.flatMap((link) =>
            link.oldMlDsaPublicKey && link.newMlDsaPublicKey
                ? [
                      {
                          oldKeyVersion: link.oldKeyVersion,
                          newKeyVersion: link.newKeyVersion,
                          oldEncryptionPublicKey: b64(link.oldEncryptionPublicKey),
                          oldSigningPublicKey: b64(link.oldSigningPublicKey),
                          oldMlDsaPublicKey: b64(link.oldMlDsaPublicKey),
                          newEncryptionPublicKey: b64(link.newEncryptionPublicKey),
                          newSigningPublicKey: b64(link.newSigningPublicKey),
                          newMlDsaPublicKey: b64(link.newMlDsaPublicKey),
                          newKemPublicKey: b64(link.newKemPublicKey),
                          signature: b64(link.signature),
                      },
                  ]
                : [],
        ),
    };
}

/*
 * Another person's public identity, by email. Bounded per person and per
 * address so the directory cannot be walked; an unknown address and an
 * account without an identity are the same answer.
 */
export async function lookupContact(sessionToken: string | null, email: string, address: string) {
    const { user } = await requireSession(sessionToken, 'Sign in to look up a contact.');
    await limitLookups('lookup', user.id, address);
    const found = await authRepository.lookupIdentity(normalizeEmail(email));
    if (!found) throw new AuthError('No HushOS account with that email has finished setup.', 404);
    return {
        contact: {
            userId: found.userId,
            name: found.name,
            email: found.email,
            ...publicIdentityOf(found),
        },
    };
}

/* The settings key wrapped under the account root: a nonce and the sealed 32-byte key. */
export type SettingsKeyEnvelope = { nonce: string; ciphertext: string };
function encodeSettingsKey(key: { nonce: Buffer; ciphertext: Buffer } | null) {
    return key
        ? {
              nonce: key.nonce.toString('base64url'),
              ciphertext: key.ciphertext.toString('base64url'),
          }
        : null;
}
function decodeSettingsKey(key: SettingsKeyEnvelope) {
    return { nonce: decodeField(key.nonce, 24), ciphertext: decodeField(key.ciphertext, 48) };
}

export async function getSettings(sessionToken: string | null) {
    const { user } = await requireSession(sessionToken, 'Sign in to read your settings.');
    const [stored, settingsKey] = await Promise.all([
        authRepository.getSettings(user.id),
        authRepository.getSettingsKey(user.id),
    ]);
    // A version 1 document is served as none, beside the stored sequence: clients open version 2
    // only, and the next save names that sequence, is sealed at the one after, and replaces it.
    const document = stored.document;
    return {
        settings: document
            ? {
                  version: 2 as const,
                  settingsVersion: document.settingsVersion,
                  nonce: document.nonce.toString('base64url'),
                  ciphertext: document.ciphertext.toString('base64url'),
              }
            : null,
        settingsKey: encodeSettingsKey(settingsKey),
        settingsVersion: stored.settingsVersion,
    };
}

/*
 * Stores the settings key once, wrapped on the person's device under the
 * account root. A device that raced is told so, and uses the stored one.
 */
export async function putSettingsKey(sessionToken: string | null, input: SettingsKeyEnvelope) {
    const { user } = await requireSession(sessionToken, 'Sign in to save your settings.');
    if (!(await authRepository.putSettingsKey({ userId: user.id, ...decodeSettingsKey(input) })))
        throw new AuthError(
            'Your settings key was already saved on another device. Reload and try again.',
            409,
        );
    return { ok: true as const };
}

export async function putSettings(
    sessionToken: string | null,
    input: {
        expectedVersion: number;
        /* 2, sealed under the settings key, is the only version taken; an older client hears 409. */
        version?: number;
        nonce: string;
        ciphertext: string;
    },
) {
    const { user } = await requireSession(sessionToken, 'Sign in to save your settings.');
    // Settings sealed the old way (version 1, under a key derived from the identity) no longer
    // open on any client: refused before anything else, so an old client is told to update.
    if ((input.version ?? 1) !== 2)
        throw new AuthError('Update HushOS to save your settings.', 409);
    // Every client pads settings to 1 KiB steps (see @hushos/crypto/contacts); an unpadded one
    // would tell the server how many people are pinned, so it is refused rather than stored.
    const body = Buffer.from(input.ciphertext, 'base64url').length - 16;
    if (body < SETTINGS_PAD_STEP || body > SETTINGS_MAX_BYTES || body % SETTINGS_PAD_STEP !== 0)
        throw new AuthError('These settings were not sealed the way this server expects.', 400);
    const result = await authRepository.putSettings({
        userId: user.id,
        expectedVersion: input.expectedVersion,
        version: input.version ?? 1,
        nonce: Buffer.from(input.nonce, 'base64url'),
        ciphertext: Buffer.from(input.ciphertext, 'base64url'),
    });
    if (result.status === 'conflict')
        throw new AuthError(
            'Your settings changed on another device. They have been reloaded; try again.',
            409,
        );
    if (result.status === 'no-key')
        throw new AuthError('Save your settings key before settings sealed under it.', 409);
    if (result.status === 'unsupported')
        throw new AuthError('Update HushOS to save your settings.', 409);
    return { settingsVersion: result.settingsVersion };
}

/*
 * Tells someone that something was shared with them: who and what role, with
 * a link to Shared with me. The server cannot name the item. Mail failures are
 * logged, never surfaced: the share itself already succeeded.
 */
export async function notifyShare(
    granterUserId: string,
    granteeUserId: string,
    role: 'viewer' | 'editor',
) {
    const [granter, grantee] = await Promise.all([
        authRepository.getUserById(granterUserId),
        authRepository.getUserById(granteeUserId),
    ]);
    if (!granter || !grantee) return;
    await sendShareEmail(grantee.email, {
        granterName: granter.name,
        granterEmail: granter.email,
        role,
        sharedUrl: new URL('/app/shared', authEnv.APP_ORIGIN).href,
    });
}

/* ------------------------------------------------------------------------- */
/* Management                                                                 */
/* ------------------------------------------------------------------------- */

/* Operator-only. The role is on the session user; a member gets the same 404 as a missing page. */
export async function requireAdmin(sessionToken: string | null) {
    const { user } = await requireSession(sessionToken, 'Sign in to continue.');
    if (user.role !== 'admin') throw new AuthError('This page does not exist.', 404);
    return user;
}

export async function getAdminOverview(sessionToken: string | null) {
    await requireAdmin(sessionToken);
    const overview = await adminRepository.getOverview();
    return {
        ...overview,
        workspaces: { ...overview.workspaces, usedBytes: String(overview.workspaces.usedBytes) },
        objects: {
            ...overview.objects,
            lastAuditedAt: overview.objects.lastAuditedAt
                ? new Date(overview.objects.lastAuditedAt).toISOString()
                : null,
        },
        missing: overview.missing.map((row) => ({
            ...row,
            ciphertextSize: row.ciphertextSize.toString(),
            replicatedAt: row.replicatedAt?.toISOString() ?? null,
            auditedAt: row.auditedAt?.toISOString() ?? null,
        })),
    };
}

const iso = (value: Date | string | null | undefined) =>
    value ? new Date(value).toISOString() : null;

/* Accounts for an operator to find someone: details and numbers, no content. */
export async function listAdminAccounts(
    sessionToken: string | null,
    input: {
        role?: 'admin' | 'member';
        query?: string;
        sort?: 'joined' | 'stored';
        offset?: number;
    },
) {
    await requireAdmin(sessionToken);
    const { total, accounts } = await adminRepository.listAccounts(input);
    return {
        total,
        pageSize: adminRepository.ADMIN_PAGE,
        accounts: accounts.map((row) => ({
            ...row,
            suspendedAt: iso(row.suspendedAt),
            createdAt: iso(row.createdAt)!,
            lastSeenAt: iso(row.lastSeenAt),
        })),
    };
}

/*
 * Suspends or reinstates an account from the console: sign-in is refused and
 * its sessions end at once. Not yourself, and not another admin, whose role is
 * taken away from the command line first.
 */
export async function setAdminAccountSuspended(
    sessionToken: string | null,
    userId: string,
    suspended: boolean,
) {
    const operator = await requireAdmin(sessionToken);
    if (userId === operator.id) throw new AuthError('You cannot suspend yourself.', 409);
    const account = await adminRepository.getAccount(userId);
    if (!account) throw new AuthError('This account does not exist.', 404);
    if (suspended && account.role === 'admin')
        throw new AuthError(
            'This account is an admin. Take the role away from the command line first.',
            409,
        );
    const result = await authRepository.setUserSuspended(userId, suspended);
    if (!result) throw new AuthError('This account does not exist.', 404);
    return { operatorId: operator.id, suspendedAt: iso(result.suspendedAt) };
}

export async function getAdminAccount(sessionToken: string | null, userId: string) {
    await requireAdmin(sessionToken);
    const account = await adminRepository.getAccount(userId);
    if (!account) throw new AuthError('This account does not exist.', 404);
    return {
        ...account,
        suspendedAt: iso(account.suspendedAt),
        createdAt: iso(account.createdAt)!,
        emailVerifiedAt: iso(account.emailVerifiedAt),
        lastSeenAt: iso(account.lastSeenAt),
        baseQuotaBytes: account.baseQuotaBytes?.toString() ?? null,
        usedBytes: account.usedBytes?.toString() ?? null,
        reservedBytes: account.reservedBytes?.toString() ?? null,
        grants: account.grants.map((grant) => ({
            ...grant,
            quotaBytes: grant.quotaBytes.toString(),
            startsAt: iso(grant.startsAt)!,
            expiresAt: iso(grant.expiresAt),
            revokedAt: iso(grant.revokedAt),
        })),
    };
}

/*
 * Adds storage to an account by hand, for a support case, a trial or a
 * correction, optionally until a date. It counts at once and is listed with
 * the account's other grants, naming who granted it. Amounts are decimal byte
 * strings, as every byte count on the wire is.
 */
export async function grantAdminAccountStorage(
    sessionToken: string | null,
    userId: string,
    input: { quotaBytes: string; expiresAt?: string | null; note?: string | null },
) {
    const operator = await requireAdmin(sessionToken);
    if (!/^[0-9]{1,20}$/.test(input.quotaBytes)) throw new AuthError('Enter an amount of storage.');
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new AuthError('Enter a valid date.');
    const account = await adminRepository.getAccount(userId);
    if (!account) throw new AuthError('This account does not exist.', 404);
    if (!account.workspaceId) throw new AuthError('This account has no storage yet.', 409);
    const result = await adminRepository.grantAdminStorage({
        workspaceId: account.workspaceId,
        quotaBytes: BigInt(input.quotaBytes),
        expiresAt,
        actorUserId: operator.id,
        note: input.note,
    });
    switch (result.status) {
        case 'invalid-amount':
            throw new AuthError('Add between 1 byte and 100 TiB at a time.');
        case 'invalid-expiry':
            throw new AuthError('The end date has to be in the future.');
        case 'invalid-note':
            throw new AuthError('Keep the note under 500 characters.');
        case 'not-found':
            throw new AuthError('This account has no storage yet.', 409);
        case 'ok':
            return {
                operatorId: operator.id,
                entitlementId: result.entitlementId,
                quotaBytes: result.quotaBytes,
            };
    }
}

/* Ends storage an operator added; a plan's or an invite bonus's is not theirs to end here. */
export async function revokeAdminAccountStorage(
    sessionToken: string | null,
    userId: string,
    entitlementId: string,
) {
    const operator = await requireAdmin(sessionToken);
    const account = await adminRepository.getAccount(userId);
    if (!account?.workspaceId) throw new AuthError('This account does not exist.', 404);
    const result = await adminRepository.revokeAdminStorage(entitlementId, account.workspaceId);
    if (result.status !== 'ok')
        throw new AuthError('There is no storage an operator added with that id.', 404);
    return { operatorId: operator.id, quotaBytes: result.quotaBytes };
}

export async function listAdminWorkspaces(
    sessionToken: string | null,
    input: { sort?: 'stored' | 'created'; offset?: number },
) {
    await requireAdmin(sessionToken);
    const { total, workspaces } = await adminRepository.listWorkspaces(input);
    return {
        total,
        pageSize: adminRepository.ADMIN_PAGE,
        workspaces: workspaces.map((row) => ({ ...row, createdAt: iso(row.createdAt)! })),
    };
}

export async function updateProfile(sessionToken: string | null, input: { name: string }) {
    const { user } = await requireSession(sessionToken, 'Sign in to update your profile.');
    const updated = await authRepository.updateUserName(user.id, normalizeName(input.name));
    if (!updated) throw new AuthError('Sign in to update your profile.', 401);
    return { user: { ...updated, credentialVersion: user.credentialVersion } };
}

/* Ends the session behind the token, if there is one. Clearing the cookie is the caller's job. */
export async function logout(sessionToken: string | null) {
    if (sessionToken && TOKEN_PATTERN.test(sessionToken))
        await authRepository.deleteSession(hash(sessionToken));
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
export async function getRecoveryBackup(sessionToken: string | null) {
    const { user } = await requireSession(sessionToken, 'Sign in to view your recovery key.');
    const key = await authRepository.getRecoveryKey(user.id);
    if (!key) throw new AuthError('This account does not have a recovery key.', 409);
    return { userId: user.id, recovery: encodeRecovery(key), confirmed: key.confirmedAt !== null };
}
export async function confirmRecoveryBackup(sessionToken: string | null, recoveryVersion: number) {
    const { user } = await requireSession(sessionToken, 'Sign in to confirm your recovery key.');
    if (!(await authRepository.confirmRecoveryKey(user.id, recoveryVersion)))
        throw new AuthError('Your recovery key changed. Save the current key.');
    return { success: true };
}
export async function startRecovery(enrollmentToken: string | null, registrationRequest: string) {
    const { enrollment } = await requireEnrollment(
        enrollmentToken,
        'recover',
        'Verify your email before recovering your account.',
    );
    await limitEmail('recover-start', normalizeEmail(enrollment.email));
    const credential = await authRepository.findCredential(normalizeEmail(enrollment.email));
    const recovery = credential ? await authRepository.getRecoveryKey(credential.userId) : null;
    if (!credential || !recovery)
        throw new AuthError('No recovery key is available for this account.', 409);
    await ready;
    let response;
    try {
        response = server.createRegistrationResponse({
            serverSetup: await serverSetup(),
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
    enrollmentToken: string | null,
    input: RecoveryReset & { signature: string },
) {
    const { enrollment, token } = await requireEnrollment(
        enrollmentToken,
        'recover',
        'Your recovery session expired. Verify your email again.',
    );
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
            serverSetup: await serverSetup(),
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
    return { user };
}

export async function getStorageAllowance(sessionToken: string | null) {
    const { user } = await requireSession(sessionToken, 'Sign in to view your storage allowance.');
    return { storage: await authRepository.getStorageAllowance(user.id) };
}

const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function decodeWorkspaceGrant(
    input: { id: string; grant: WorkspaceKeyEnvelope },
    keyVersion?: number,
    workspaceKeyVersion?: number,
) {
    const grant = input.grant;
    if (
        grant.version !== 1 ||
        !WORKSPACE_ID_PATTERN.test(input.id) ||
        grant.workspaceId !== input.id ||
        !Number.isSafeInteger(grant.keyVersion) ||
        grant.keyVersion < 1 ||
        (keyVersion !== undefined && grant.keyVersion !== keyVersion) ||
        !Number.isSafeInteger(grant.workspaceKeyVersion) ||
        grant.workspaceKeyVersion < 1 ||
        (workspaceKeyVersion !== undefined && grant.workspaceKeyVersion !== workspaceKeyVersion)
    )
        throw new AuthError('Unsupported workspace key envelope.');
    return {
        id: input.id,
        grant: {
            version: 1 as const,
            keyVersion: grant.keyVersion,
            workspaceKeyVersion: grant.workspaceKeyVersion,
            wrappingSalt: decodeField(grant.wrappingSalt, 32),
            wrappingNonce: decodeField(grant.wrappingNonce, 24),
            encryptedKey: decodeField(grant.encryptedKey, 48),
        },
    };
}
function encodeWorkspaceGrant(
    grant: NonNullable<
        Awaited<ReturnType<typeof authRepository.getSecurityBundles>>
    >['workspaces'][number],
): WorkspaceKeyEnvelope {
    return {
        version: 1,
        workspaceId: grant.workspaceId,
        keyVersion: grant.keyVersion,
        workspaceKeyVersion: grant.workspaceKeyVersion,
        wrappingSalt: grant.wrappingSalt.toString('base64url'),
        wrappingNonce: grant.wrappingNonce.toString('base64url'),
        encryptedKey: grant.encryptedKey.toString('base64url'),
    };
}
/*
 * Someone's public identity as contacts and shares see it: every public key,
 * and a version 2 identity's keys statement. A version 1 identity (not yet
 * upgraded) has no ML-DSA key and no keys statement, and nothing about it is
 * trusted; its ML-KEM key is served bare, without the old binding.
 */
export function publicIdentityOf(i: {
    keyVersion: number;
    identityVersion: number;
    encryptionPublicKey: Buffer;
    signingPublicKey: Buffer;
    mlDsaPublicKey: Buffer | null;
    kemPublicKey: Buffer | null;
    keysSignature: Buffer | null;
}) {
    const b64 = (bytes: Buffer | null) => bytes?.toString('base64url') ?? null;
    return {
        keyVersion: i.keyVersion,
        identityVersion: i.identityVersion === 2 ? (2 as const) : (1 as const),
        encryptionPublicKey: i.encryptionPublicKey.toString('base64url'),
        signingPublicKey: i.signingPublicKey.toString('base64url'),
        mlDsaPublicKey: b64(i.mlDsaPublicKey),
        kemPublicKey: b64(i.kemPublicKey),
        keysSignature: b64(i.keysSignature),
    };
}

/*
 * An identity envelope's columns, refused unless well formed. A version 2
 * identity needs its ML-KEM and ML-DSA halves and a keys statement that holds
 * for `userId`; `current` (registration, initialization, upgrade, succession)
 * accepts version 2 only. Version 1 is accepted only where an existing one is
 * rewrapped (master-key rotation), with its old KEM binding as stored.
 */
function decodeIdentity(
    input: IdentityEnvelope,
    keyVersion: number,
    userId: string,
    options: { current?: boolean } = {},
) {
    if (
        (input.version !== 1 && input.version !== 2) ||
        (options.current && input.version !== 2) ||
        input.keyVersion !== keyVersion ||
        !Number.isSafeInteger(keyVersion) ||
        keyVersion < 1
    )
        throw new AuthError(
            input.version === 1
                ? 'Update HushOS to save changes.'
                : 'Unsupported identity version.',
            input.version === 1 ? 409 : 400,
        );
    const common = {
        version: input.version,
        keyVersion,
        wrappingSalt: decodeField(input.wrappingSalt, 32),
        encryptionPublicKey: decodeField(input.encryptionPublicKey, 32),
        encryptionPrivateKeyNonce: decodeField(input.encryptionPrivateKeyNonce, 24),
        encryptedEncryptionPrivateKey: decodeField(input.encryptedEncryptionPrivateKey, 48),
        signingPublicKey: decodeField(input.signingPublicKey, 32),
        signingSeedNonce: decodeField(input.signingSeedNonce, 24),
        encryptedSigningSeed: decodeField(input.encryptedSigningSeed, 48),
    };
    if (input.version === 1)
        return {
            ...common,
            kemPublicKey: input.kem ? decodeField(input.kem.publicKey, 1184) : null,
            kemSeedNonce: input.kem ? decodeField(input.kem.seedNonce, 24) : null,
            encryptedKemSeed: input.kem ? decodeField(input.kem.encryptedSeed, 80) : null,
            kemSignature: input.kem?.signature ? decodeField(input.kem.signature, 64) : null,
            mlDsaPublicKey: null,
            mlDsaSeedNonce: null,
            encryptedMlDsaSeed: null,
            keysSignature: null,
        };
    if (!input.kem || !input.mlDsa || !input.keysSignature)
        throw new AuthError('An identity needs all four of its keys.', 400);
    const identity = {
        ...common,
        version: 2 as const,
        kemPublicKey: decodeField(input.kem.publicKey, 1184),
        kemSeedNonce: decodeField(input.kem.seedNonce, 24),
        encryptedKemSeed: decodeField(input.kem.encryptedSeed, 80),
        kemSignature: null,
        mlDsaPublicKey: decodeField(input.mlDsa.publicKey, 1952),
        mlDsaSeedNonce: decodeField(input.mlDsa.seedNonce, 24),
        encryptedMlDsaSeed: decodeField(input.mlDsa.encryptedSeed, 48),
        keysSignature: decodeField(input.keysSignature, HYBRID_SIGNATURE_BYTES),
    };
    if (!authRepository.identityKeysHold(userId, identity))
        throw new AuthError('These keys are not signed by this identity.', 400);
    return identity;
}

export async function startAccountDeletion(sessionToken: string | null, startLoginRequest: string) {
    const { user, token } = await requireSession(
        sessionToken,
        'Sign in before deleting your account.',
    );
    return startLogin(user.email, startLoginRequest, {
        purpose: 'delete',
        sessionTokenHash: hash(token),
        userId: user.id,
    });
}
export async function finishAccountDeletion(
    sessionToken: string | null,
    input: { attemptToken: string; finishLoginRequest: string },
    beforeDelete?: (userId: string) => Promise<void>,
) {
    const { user, token } = await requireSession(
        sessionToken,
        'Sign in before deleting your account.',
    );
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
    // Anything billed to the account stops before the account goes; an outage there
    // leaves the account in place rather than a subscription without an owner.
    await beforeDelete?.(user.id);
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

export async function getAccountSetup(sessionToken: string | null) {
    const { user } = await requireSession(sessionToken, 'Sign in to finish account setup.');
    return { missing: await authRepository.getAccountSetup(user.id) };
}

export async function initializeAccount(
    sessionToken: string | null,
    input: {
        recovery?: RecoveryEnvelope;
        identity?: IdentityEnvelope;
        workspace?: { id: string; grant: WorkspaceKeyEnvelope };
    },
) {
    const { user, token } = await requireSession(sessionToken, 'Sign in to finish account setup.');
    const keyVersion = await authRepository.getAccountKeyVersion(user.id);
    if (!keyVersion) throw new AuthError('Sign in to finish account setup.', 401);
    const initialized = await authRepository.initializeAccount({
        userId: user.id,
        credentialVersion: user.credentialVersion,
        sessionTokenHash: hash(token),
        initialQuotaBytes: authEnv.INITIAL_STORAGE_QUOTA_BYTES,
        recovery: input.recovery ? decodeRecovery(input.recovery, 1, keyVersion) : undefined,
        identity: input.identity
            ? decodeIdentity(input.identity, keyVersion, user.id, { current: true })
            : undefined,
        workspace: input.workspace
            ? decodeWorkspaceGrant(input.workspace, undefined, keyVersion)
            : undefined,
    });
    if (!initialized) throw new AuthError('Sign in to finish account setup.', 401);
    return { ok: true };
}

export async function startSecurityChange(
    sessionToken: string | null,
    input: {
        action: SecurityAction;
        startLoginRequest: string;
        registrationRequest: string;
    },
): Promise<ServerSecurityChallenge> {
    const { user, token } = await requireSession(
        sessionToken,
        'Sign in before changing account security.',
    );
    const bundles = await authRepository.getSecurityBundles(user.id);
    if (!bundles || bundles.envelope.credentialVersion !== user.credentialVersion)
        throw new AuthError('Unlock your account and finish recovery setup first.', 409);
    const challenge = await startLogin(user.email, input.startLoginRequest, {
        purpose: input.action,
        sessionTokenHash: hash(token),
        userId: user.id,
    });
    let registration;
    try {
        registration = server.createRegistrationResponse({
            serverSetup: await serverSetup(),
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
            envelopeVersion: supportedEnvelope(e.envelopeVersion),
            keyVersion: e.keyVersion,
            credentialVersion: e.credentialVersion,
            wrappingSalt: e.wrappingSalt.toString('base64url'),
            wrappingNonce: e.wrappingNonce.toString('base64url'),
            encryptedKey: e.encryptedKey.toString('base64url'),
        },
        recovery: encodeRecovery(bundles.recovery),
        workspaces: bundles.workspaces.map(encodeWorkspaceGrant),
        identity: encodeIdentity(i),
        identityHistory: bundles.identityHistory.map(encodeIdentity),
        settingsKey: encodeSettingsKey(bundles.settingsKey),
    };
}

/*
 * What a security change carries beyond the worker's own types: every earlier
 * identity and the settings key, since a master-key rotation must re-wrap
 * those under the new root too or what they open is lost with the old root.
 */
export type ServerSecurityChallenge = SecurityChallenge & {
    identityHistory: IdentityEnvelope[];
    settingsKey: SettingsKeyEnvelope | null;
};
export type ServerSecurityUpdate = SecurityUpdate & {
    identityHistory?: IdentityEnvelope[];
    settingsKey?: SettingsKeyEnvelope;
};

export async function finishSecurityChange(
    sessionToken: string | null,
    input: ServerSecurityUpdate & { action: SecurityAction; attemptToken: string },
) {
    const { user, token } = await requireSession(
        sessionToken,
        'Sign in before changing account security.',
    );
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
            serverSetup: await serverSetup(),
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
        (input.action === 'master-key' ? !input.identity : input.identity !== undefined) ||
        (input.action === 'master-key' ? !input.workspaces : input.workspaces !== undefined) ||
        (input.action !== 'master-key' &&
            (input.identityHistory !== undefined || input.settingsKey !== undefined))
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
        // The identity keeps its own key version (or takes the root's, when higher); the
        // repository holds it to the current one, since a succession moves it on its own.
        identity: input.identity
            ? decodeIdentity(input.identity, input.identity.keyVersion, user.id)
            : undefined,
        identityHistory: input.identityHistory?.map((earlier) =>
            decodeIdentity(earlier, earlier.keyVersion, user.id),
        ),
        settingsKey: input.settingsKey ? decodeSettingsKey(input.settingsKey) : undefined,
        workspaces: input.workspaces?.map((grant) =>
            decodeWorkspaceGrant({ id: grant.workspaceId, grant }, keyVersion),
        ),
    });
    if (!changed) throw failure();
    return { success: true };
}
