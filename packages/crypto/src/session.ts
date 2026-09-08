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
    let password = '';
    let state = '';
    let phase: 'idle' | 'register' | 'login' | 'unlock' = 'idle';
    let exportKey = '';
    let accountKey: Uint8Array<ArrayBuffer> | undefined;
    let unlockedUserId: string | null = null;

    function reset() {
        password = '';
        state = '';
        exportKey = '';
        phase = 'idle';
        accountKey?.fill(0);
        accountKey = undefined;
        unlockedUserId = null;
    }
    async function handle(message: Message): Promise<CryptoResults[keyof CryptoResults]> {
        await ready;
        switch (message.operation) {
            case 'initialize': {
                if (!accountKey || unlockedUserId !== message.input.userId)
                    throw new Error('Unlock your account to finish setup.');
                return {
                    recovery: message.input.recovery
                        ? (await createRecovery(accountKey, unlockedUserId, 1)).recovery
                        : undefined,
                    identity: message.input.identity
                        ? await createIdentity(accountKey, unlockedUserId)
                        : undefined,
                };
            }
            case 'backup': {
                if (!accountKey || unlockedUserId !== message.input.userId)
                    throw new Error('Unlock your account to view your recovery key.');
                return {
                    phrase: await readRecoveryPhrase(
                        accountKey,
                        unlockedUserId,
                        message.input.recovery,
                    ),
                };
            }
            case 'remember': {
                if (!accountKey || unlockedUserId !== message.input.identity.userId)
                    throw new Error('Unlock your account before saving it on this device.');
                return rememberAccountKey(
                    accountKey,
                    message.input.deviceKey,
                    message.input.identity,
                );
            }
            case 'restore': {
                reset();
                accountKey = await restoreAccountKey(message.input.bundle, message.input.deviceKey);
                unlockedUserId = message.input.bundle.userId;
                return { userId: unlockedUserId };
            }

            case 'registerStart': {
                reset();
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
                accountKey = recovered?.accountKey ?? crypto.getRandomValues(new Uint8Array(32));
                const credentialVersion = recovering ? message.input.credentialVersion + 1 : 1;
                const key = await wrappingKey(result.exportKey, salt);
                try {
                    const encrypted = await encryptKey(
                        accountKey,
                        key,
                        nonce,
                        accountKeyContext(message.input.userId, 1, credentialVersion),
                    );
                    const { recovery } = await createRecovery(
                        accountKey,
                        message.input.userId,
                        recovering ? message.input.recovery.recoveryVersion + 1 : 1,
                    );
                    const output = {
                        recovery,
                        registrationRecord: result.registrationRecord,
                        envelope: {
                            envelopeVersion: ENVELOPE_VERSION,
                            keyVersion: 1,
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
                        identity: await createIdentity(accountKey, message.input.userId),
                    };
                } finally {
                    recovered?.signingKey.fill(0);
                    key.fill(0);
                    reset();
                }
            }
            case 'loginStart': {
                reset();
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
                    envelope.keyVersion !== 1 ||
                    !Number.isSafeInteger(envelope.credentialVersion) ||
                    envelope.credentialVersion < 1
                )
                    throw new Error('This account-key version is not supported.');
                const key = await wrappingKey(exportKey, decode(envelope.wrappingSalt, 32));
                exportKey = '';
                phase = 'idle';
                try {
                    accountKey = await decryptKey(
                        decode(envelope.encryptedKey, 48),
                        key,
                        decode(envelope.wrappingNonce, 24),
                        accountKeyContext(userId, envelope.keyVersion, envelope.credentialVersion),
                    );
                    if (accountKey.length !== 32) throw new Error('Invalid account key.');
                    unlockedUserId = userId;
                    return { userId };
                } finally {
                    key.fill(0);
                }
            }
        }
    }

    return { handle, reset };
}
