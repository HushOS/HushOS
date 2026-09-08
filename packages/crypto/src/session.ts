import {
    createSecurityChange,
    type SecurityAction,
    type SecurityChallenge,
    type SecurityUpdate,
} from './security';
import { createIdentity, type IdentityEnvelope } from './identity';
import {
    createRecovery,
    openRecovery,
    readRecoveryPhrase,
    signRecoveryReset,
    type RecoveryEnvelope,
} from './recovery';
import { rememberAccountKey, restoreAccountKey, type RememberedAccount } from './device';
import { client, ready } from '@serenity-kit/opaque';
import { encryptKey, decryptKey } from './aead';
import { encode, decode, wrappingKey, checkProfile } from './keys';
import {
    accountKeyContext,
    ENVELOPE_VERSION,
    KEY_STRETCHING,
    OPAQUE_IDENTIFIERS,
    type AccountKeyEnvelope,
} from './protocol';

export type CryptoRequests = {
    securityStart: { password: string; newPassword?: string; action: SecurityAction };
    securityFinish: SecurityChallenge;
    initialize: { userId: string; recovery: boolean; identity: boolean };
    remember: {
        deviceKey: CryptoKey;
        identity: Omit<RememberedAccount, 'nonce' | 'encryptedKey' | 'version'>;
    };
    restore: { deviceKey: CryptoKey; bundle: RememberedAccount };
    backup: { userId: string; recovery: RecoveryEnvelope };
    registerStart: { password: string };
    recoverFinish: {
        registrationResponse: string;
        userId: string;
        profileVersion: number;
        credentialVersion: number;
        attemptToken: string;
        recovery: RecoveryEnvelope;
        phrase: string;
    };
    registerFinish: { registrationResponse: string; userId: string; profileVersion: number };
    loginStart: { password: string };
    loginFinish: { loginResponse: string; profileVersion: number };
    unlock: { userId: string; envelope: AccountKeyEnvelope };
};
export type CryptoResults = {
    securityStart: { startLoginRequest: string; registrationRequest: string };
    securityFinish: SecurityUpdate;
    initialize: { recovery?: RecoveryEnvelope; identity?: IdentityEnvelope };
    backup: { phrase: string };
    recoverFinish: {
        registrationRecord: string;
        envelope: AccountKeyEnvelope;
        recovery: RecoveryEnvelope;
        signature: string;
    };
    remember: RememberedAccount;
    restore: { userId: string };
    registerStart: { registrationRequest: string };
    registerFinish: {
        registrationRecord: string;
        envelope: AccountKeyEnvelope;
        recovery: RecoveryEnvelope;
        identity: IdentityEnvelope;
    };
    loginStart: { startLoginRequest: string };
    loginFinish: { finishLoginRequest: string };
    unlock: { userId: string };
};
type Message = {
    [K in keyof CryptoRequests]: { id: number; operation: K; input: CryptoRequests[K] };
}[keyof CryptoRequests];

export function createCryptoSession() {
    const security = createSecurityChange();
    let generation = 0;
    let queue = Promise.resolve();
    const pending = new Set<(error: Error) => void>();
    let accountKeyVersion = 1;
    let password = '';
    let state = '';
    let phase: 'idle' | 'register' | 'login' | 'unlock' = 'idle';
    let exportKey = '';
    let accountKey: Uint8Array<ArrayBuffer> | undefined;
    let unlockedUserId: string | null = null;

    function clearState() {
        security.reset();
        accountKeyVersion = 1;
        password = '';
        state = '';
        exportKey = '';
        phase = 'idle';
        accountKey?.fill(0);
        accountKey = undefined;
        unlockedUserId = null;
    }
    function reset() {
        generation++;
        clearState();
        const error = new Error('Your account was locked. Please try again.');
        for (const reject of pending) reject(error);
        pending.clear();
    }
    function checkGeneration(expected: number) {
        if (expected !== generation) throw new Error('Your account was locked. Please try again.');
    }
    async function execute(
        message: Message,
        expected: number,
    ): Promise<CryptoResults[keyof CryptoResults]> {
        await ready;
        checkGeneration(expected);
        switch (message.operation) {
            case 'securityStart':
                clearState();
                return security.start(message.input);
            case 'securityFinish':
                return security.finish(message.input);
            case 'initialize': {
                if (!accountKey || unlockedUserId !== message.input.userId)
                    throw new Error('Unlock your account to finish setup.');
                const root = accountKey.slice();
                const userId = unlockedUserId;
                const keyVersion = accountKeyVersion;
                try {
                    return {
                        recovery: message.input.recovery
                            ? (await createRecovery(root, userId, 1, keyVersion)).recovery
                            : undefined,
                        identity: message.input.identity
                            ? await createIdentity(root, userId, keyVersion)
                            : undefined,
                    };
                } finally {
                    root.fill(0);
                }
            }
            case 'backup': {
                if (!accountKey || unlockedUserId !== message.input.userId)
                    throw new Error('Unlock your account to view your recovery key.');
                const root = accountKey.slice();
                try {
                    return {
                        phrase: await readRecoveryPhrase(
                            root,
                            unlockedUserId,
                            message.input.recovery,
                        ),
                    };
                } finally {
                    root.fill(0);
                }
            }
            case 'remember': {
                if (!accountKey || unlockedUserId !== message.input.identity.userId)
                    throw new Error('Unlock your account before saving it on this device.');
                const root = accountKey.slice();
                try {
                    return await rememberAccountKey(
                        root,
                        message.input.deviceKey,
                        message.input.identity,
                    );
                } finally {
                    root.fill(0);
                }
            }
            case 'restore': {
                clearState();
                const root = await restoreAccountKey(message.input.bundle, message.input.deviceKey);
                if (expected !== generation) {
                    root.fill(0);
                    checkGeneration(expected);
                }
                accountKey = root;
                unlockedUserId = message.input.bundle.userId;
                accountKeyVersion = message.input.bundle.keyVersion;
                return { userId: unlockedUserId };
            }

            case 'registerStart': {
                clearState();
                password = message.input.password;
                const result = client.startRegistration({ password });
                state = result.clientRegistrationState;
                phase = 'register';
                return { registrationRequest: result.registrationRequest };
            }
            case 'recoverFinish':
            case 'registerFinish': {
                checkProfile(message.input.profileVersion);
                if (phase !== 'register')
                    throw new Error('Registration expired. Please try again.');
                const result = client.finishRegistration({
                    password,
                    clientRegistrationState: state,
                    registrationResponse: message.input.registrationResponse,
                    identifiers: OPAQUE_IDENTIFIERS,
                    keyStretching: KEY_STRETCHING,
                });
                password = '';
                state = '';
                phase = 'idle';
                const salt = crypto.getRandomValues(new Uint8Array(32));
                const nonce = crypto.getRandomValues(new Uint8Array(24));
                const recovering = message.operation === 'recoverFinish';
                const recovered = recovering
                    ? await openRecovery(
                          message.input.phrase,
                          message.input.userId,
                          message.input.recovery,
                      )
                    : undefined;
                const root = recovered?.accountKey ?? crypto.getRandomValues(new Uint8Array(32));
                const keyVersion = recovering ? message.input.recovery.keyVersion : 1;
                const credentialVersion = recovering ? message.input.credentialVersion + 1 : 1;
                let key: Uint8Array<ArrayBuffer> | undefined;
                try {
                    key = await wrappingKey(result.exportKey, salt);
                    const encrypted = await encryptKey(
                        root,
                        key,
                        nonce,
                        accountKeyContext(message.input.userId, keyVersion, credentialVersion),
                    );
                    const { recovery } = await createRecovery(
                        root,
                        message.input.userId,
                        recovering ? message.input.recovery.recoveryVersion + 1 : 1,
                        keyVersion,
                    );
                    const output = {
                        recovery,
                        registrationRecord: result.registrationRecord,
                        envelope: {
                            envelopeVersion: ENVELOPE_VERSION,
                            keyVersion,
                            credentialVersion,
                            wrappingSalt: encode(salt),
                            wrappingNonce: encode(nonce),
                            encryptedKey: encode(encrypted),
                        },
                    };
                    if (recovering && recovered)
                        return {
                            ...output,
                            signature: await signRecoveryReset(
                                {
                                    ...output,
                                    userId: message.input.userId,
                                    attemptToken: message.input.attemptToken,
                                    credentialVersion: message.input.credentialVersion,
                                },
                                recovered.signingKey,
                            ),
                        };
                    return {
                        ...output,
                        identity: await createIdentity(root, message.input.userId),
                    };
                } finally {
                    recovered?.signingKey.fill(0);
                    root.fill(0);
                    key?.fill(0);
                    clearState();
                }
            }
            case 'loginStart': {
                clearState();
                password = message.input.password;
                const result = client.startLogin({ password });
                state = result.clientLoginState;
                phase = 'login';
                return { startLoginRequest: result.startLoginRequest };
            }
            case 'loginFinish': {
                checkProfile(message.input.profileVersion);
                if (phase !== 'login') throw new Error('Sign-in expired. Please try again.');
                const result = client.finishLogin({
                    password,
                    clientLoginState: state,
                    loginResponse: message.input.loginResponse,
                    identifiers: OPAQUE_IDENTIFIERS,
                    keyStretching: KEY_STRETCHING,
                });
                password = '';
                state = '';
                if (!result) throw new Error('Unable to sign in. Check your email and password.');
                exportKey = result.exportKey;
                phase = 'unlock';
                return { finishLoginRequest: result.finishLoginRequest };
            }
            case 'unlock': {
                if (phase !== 'unlock') throw new Error('Sign in again to unlock your account.');
                const { userId, envelope } = message.input;
                if (
                    envelope.envelopeVersion !== ENVELOPE_VERSION ||
                    !Number.isSafeInteger(envelope.keyVersion) ||
                    envelope.keyVersion < 1 ||
                    !Number.isSafeInteger(envelope.credentialVersion) ||
                    envelope.credentialVersion < 1
                )
                    throw new Error('This account-key version is not supported.');
                const key = await wrappingKey(exportKey, decode(envelope.wrappingSalt, 32));
                exportKey = '';
                phase = 'idle';
                try {
                    const root = await decryptKey(
                        decode(envelope.encryptedKey, 48),
                        key,
                        decode(envelope.wrappingNonce, 24),
                        accountKeyContext(userId, envelope.keyVersion, envelope.credentialVersion),
                    );
                    if (expected !== generation || root.length !== 32) {
                        root.fill(0);
                        checkGeneration(expected);
                        throw new Error('Invalid account key.');
                    }
                    accountKey = root;
                    unlockedUserId = userId;
                    accountKeyVersion = envelope.keyVersion;
                    return { userId };
                } finally {
                    key.fill(0);
                }
            }
        }
    }

    function handle(message: Message): Promise<CryptoResults[keyof CryptoResults]> {
        const expected = generation;
        return new Promise((resolve, reject) => {
            pending.add(reject);
            // Keep a cancelled operation on the queue until its local secrets are cleared.
            // Reset rejects callers immediately; later generations cannot share its state.
            queue = queue.then(async () => {
                try {
                    checkGeneration(expected);
                    const result = await execute(message, expected);
                    checkGeneration(expected);
                    resolve(result);
                } catch (error) {
                    reject(error);
                } finally {
                    if (expected !== generation) clearState();
                    pending.delete(reject);
                }
            });
        });
    }

    return { handle, reset };
}
