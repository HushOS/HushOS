import { CryptoError } from './errors';
import { checkPassword, normalizePassword } from './password';
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
import { rewrapSettingsKey, type SettingsKeyEnvelope } from './contacts';
import { createRecovery, type RecoveryEnvelope } from './recovery';
import { rewrapAreaSelfGrant, rewrapWorkspaceGrant, type WorkspaceKeyEnvelope } from './workspace';

/*
 * A grant as a security change is served it: the envelope, and for a group
 * area's self-grant the group it is bound to (its workspace's group). The
 * group only picks the context the grant must open under; a wrong or missing
 * one makes the rewrap refuse, never pick another context.
 */
export type SecurityWorkspaceGrant = WorkspaceKeyEnvelope & { groupId?: string | null };

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
    /* The account's earlier identities (GET /api/auth/identity/history), oldest first. */
    identityHistory?: IdentityEnvelope[];
    /* The settings key as GET /api/auth/settings serves it; null before the account has one. */
    settingsKey?: SettingsKeyEnvelope | null;
    workspaces: SecurityWorkspaceGrant[];
};
export type SecurityUpdate = {
    finishLoginRequest: string;
    registrationRecord: string;
    envelope: AccountKeyEnvelope;
    recovery?: RecoveryEnvelope;
    identity?: IdentityEnvelope;
    /* Master-key rotation: every earlier identity rewrapped under the new root, in the same order. */
    identityHistory?: IdentityEnvelope[];
    /* Master-key rotation: the same settings key under the new root, when there is one. */
    settingsKey?: SettingsKeyEnvelope;
    workspaces?: WorkspaceKeyEnvelope[];
};

/*
 * What a master-key rotation carries over to the new root, beside the password
 * and recovery envelopes: the identity and every earlier one (shares sealed to
 * them open with nothing else), each keeping its key version and public keys;
 * the settings key, when the account has one; and every workspace grant, at
 * the new root revision with its workspace key epoch unchanged. A group
 * area's self-grant is rewrapped as its group's (rewrapAreaSelfGrant), since
 * the personal context cannot open it. The server refuses a rotation that
 * leaves any of them behind.
 */
export async function rewrapAccountKeys(
    root: Uint8Array<ArrayBuffer>,
    nextRoot: Uint8Array<ArrayBuffer>,
    userId: string,
    keyVersion: number,
    keys: Pick<SecurityChallenge, 'identity' | 'identityHistory' | 'settingsKey' | 'workspaces'>,
) {
    return {
        identity: await rewrapIdentity(root, nextRoot, userId, keys.identity),
        identityHistory: await Promise.all(
            (keys.identityHistory ?? []).map((earlier) =>
                rewrapIdentity(root, nextRoot, userId, earlier),
            ),
        ),
        settingsKey: keys.settingsKey
            ? await rewrapSettingsKey(root, nextRoot, userId, keys.settingsKey)
            : undefined,
        workspaces: await Promise.all(
            keys.workspaces.map(({ groupId, ...grant }) =>
                groupId
                    ? rewrapAreaSelfGrant(root, nextRoot, userId, groupId, grant, keyVersion)
                    : rewrapWorkspaceGrant(root, nextRoot, userId, grant, keyVersion),
            ),
        ),
    };
}

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
        const current = normalizePassword(input.password);
        const nextPassword =
            input.action === 'password' ? checkPassword(input.newPassword) : current;
        const login = client.startLogin({ password: current });
        const registration = client.startRegistration({ password: nextPassword });
        pending = {
            password: current,
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
            throw new CryptoError('Security change expired. Please try again.');
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
                input.workspaces.some((grant) => grant.keyVersion !== old.keyVersion)
            )
                throw new CryptoError('Unsupported account-key envelope.');
            const login = client.finishLogin({
                password: attempt.password,
                clientLoginState: attempt.loginState,
                loginResponse: input.loginResponse,
                identifiers: OPAQUE_IDENTIFIERS,
                keyStretching: KEY_STRETCHING,
            });
            if (!login) throw new CryptoError('Your current password is incorrect.');
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
                ...(input.action === 'master-key'
                    ? await rewrapAccountKeys(root, nextRoot, input.userId, keyVersion, input)
                    : {}),
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
