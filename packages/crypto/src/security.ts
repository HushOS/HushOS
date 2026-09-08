import { client, ready } from '@serenity-kit/opaque';
import { decryptKey, encryptKey } from './aead';
import { checkProfile, decode, encode, wrappingKey } from './keys';
import {
    accountKeyContext,
    KEY_STRETCHING,
    OPAQUE_IDENTIFIERS,
    type AccountKeyEnvelope,
} from './protocol';
import { rewrapIdentity, type IdentityEnvelope } from './identity';
import { createRecovery, type RecoveryEnvelope } from './recovery';

export type SecurityAction = 'password' | 'master-key' | 'recovery-key';
export type SecurityChallenge = {
    action: SecurityAction;
    userId: string;
    attemptToken: string;
    profileVersion: number;
    loginResponse: string;
    registrationResponse: string;
    envelope: AccountKeyEnvelope;
    recovery: RecoveryEnvelope;
    identity: IdentityEnvelope;
};
export type SecurityUpdate = {
    finishLoginRequest: string;
    registrationRecord: string;
    envelope: AccountKeyEnvelope;
    recovery?: RecoveryEnvelope;
    identity?: IdentityEnvelope;
};

// A single short-lived exchange proves the current password and prepares replacement
// envelopes. Plaintext roots stay here; only encrypted bundles leave the worker.
export function createSecurityChange() {
    let pending:
        | {
              password: string;
              nextPassword: string;
              loginState: string;
              registrationState: string;
              action: SecurityAction;
          }
        | undefined;
    function reset() {
        pending = undefined;
    }
    async function start(input: {
        password: string;
        newPassword?: string;
        action: SecurityAction;
    }) {
        reset();
        await ready;
        const nextPassword = input.action === 'password' ? input.newPassword : input.password;
        if (!nextPassword || nextPassword.length < 12 || nextPassword.length > 128)
            throw new Error('Use a password between 12 and 128 characters.');
        const login = client.startLogin({ password: input.password });
        const registration = client.startRegistration({ password: nextPassword });
        pending = {
            password: input.password,
            nextPassword,
            action: input.action,
            loginState: login.clientLoginState,
            registrationState: registration.clientRegistrationState,
        };
        return {
            startLoginRequest: login.startLoginRequest,
            registrationRequest: registration.registrationRequest,
        };
    }
    async function finish(input: SecurityChallenge): Promise<SecurityUpdate> {
        const attempt = pending;
        reset();
        if (!attempt || attempt.action !== input.action)
            throw new Error('Security change expired. Please try again.');
        const secrets: Uint8Array[] = [];
        try {
            await ready;
            checkProfile(input.profileVersion);
            const old = input.envelope;
            if (
                old.envelopeVersion !== 1 ||
                !Number.isSafeInteger(old.keyVersion) ||
                old.keyVersion < 1 ||
                !Number.isSafeInteger(old.credentialVersion) ||
                old.credentialVersion < 1 ||
                old.keyVersion >= 2147483646 ||
                old.credentialVersion >= 2147483646 ||
                input.recovery.keyVersion !== old.keyVersion ||
                input.identity.keyVersion !== old.keyVersion
            )
                throw new Error('Unsupported account-key envelope.');
            const login = client.finishLogin({
                password: attempt.password,
                clientLoginState: attempt.loginState,
                loginResponse: input.loginResponse,
                identifiers: OPAQUE_IDENTIFIERS,
                keyStretching: KEY_STRETCHING,
            });
            if (!login) throw new Error('Your current password is incorrect.');
            const oldWrap = await wrappingKey(login.exportKey, decode(old.wrappingSalt, 32));
            secrets.push(oldWrap);
            const root = await decryptKey(
                decode(old.encryptedKey, 48),
                oldWrap,
                decode(old.wrappingNonce, 24),
                accountKeyContext(input.userId, old.keyVersion, old.credentialVersion),
            );
            secrets.push(root);
            const nextRoot =
                input.action === 'master-key' ? crypto.getRandomValues(new Uint8Array(32)) : root;
            secrets.push(nextRoot);
            const keyVersion = old.keyVersion + (input.action === 'master-key' ? 1 : 0);
            const credentialVersion = old.credentialVersion + 1;
            const registration = client.finishRegistration({
                password: attempt.nextPassword,
                clientRegistrationState: attempt.registrationState,
                registrationResponse: input.registrationResponse,
                identifiers: OPAQUE_IDENTIFIERS,
                keyStretching: KEY_STRETCHING,
            });
            const salt = crypto.getRandomValues(new Uint8Array(32));
            const nonce = crypto.getRandomValues(new Uint8Array(24));
            const wrap = await wrappingKey(registration.exportKey, salt);
            secrets.push(wrap);
            return {
                finishLoginRequest: login.finishLoginRequest,
                registrationRecord: registration.registrationRecord,
                envelope: {
                    envelopeVersion: 1,
                    keyVersion,
                    credentialVersion,
                    wrappingSalt: encode(salt),
                    wrappingNonce: encode(nonce),
                    encryptedKey: encode(
                        await encryptKey(
                            nextRoot,
                            wrap,
                            nonce,
                            accountKeyContext(input.userId, keyVersion, credentialVersion),
                        ),
                    ),
                },
                recovery:
                    input.action !== 'password'
                        ? (
                              await createRecovery(
                                  nextRoot,
                                  input.userId,
                                  input.recovery.recoveryVersion + 1,
                                  keyVersion,
                              )
                          ).recovery
                        : undefined,
                identity:
                    input.action === 'master-key'
                        ? await rewrapIdentity(
                              root,
                              nextRoot,
                              input.userId,
                              input.identity,
                              keyVersion,
                          )
                        : undefined,
            };
        } finally {
            attempt.password = '';
            attempt.nextPassword = '';
            attempt.loginState = '';
            attempt.registrationState = '';
            for (const secret of secrets) secret.fill(0);
        }
    }
    return { start, finish, reset };
}
