import { CryptoError } from './errors';
import sodium from 'libsodium-wrappers';
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { encryptKey, decryptKey } from './aead';
import { encode, decode } from './keys';
import type { AccountKeyEnvelope } from './protocol';

export type RecoveryEnvelope = {
    version: 1;
    keyVersion: number;
    recoveryVersion: number;
    wrappingSalt: string;
    wrappingNonce: string;
    encryptedKey: string;
    backupNonce: string;
    encryptedRecoveryKey: string;
    publicKey: string;
};
export type RecoveryReset = {
    userId: string;
    attemptToken: string;
    credentialVersion: number;
    registrationRecord: string;
    envelope: AccountKeyEnvelope;
    recovery: RecoveryEnvelope;
};
function context(purpose: string, userId: string, version: number, keyVersion: number) {
    return new TextEncoder().encode(
        JSON.stringify(['hushos/recovery', 1, purpose, userId.toLowerCase(), keyVersion, version]),
    );
}
async function derive(
    secret: Uint8Array<ArrayBuffer>,
    salt: Uint8Array<ArrayBuffer>,
    purpose: string,
) {
    const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(
        await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt,
                info: new TextEncoder().encode(`hushos/recovery/${purpose}/v1`),
            },
            key,
            256,
        ),
    );
}
export function recoveryResetMessage(input: RecoveryReset) {
    const e = input.envelope;
    const r = input.recovery;
    // Fixed field order binds the signature to every replacement field.
    return new TextEncoder().encode(
        JSON.stringify([
            'hushos/recovery/reset',
            1,
            input.userId.toLowerCase(),
            input.attemptToken,
            input.credentialVersion,
            input.registrationRecord,
            [
                e.envelopeVersion,
                e.keyVersion,
                e.credentialVersion,
                e.wrappingSalt,
                e.wrappingNonce,
                e.encryptedKey,
            ],
            [
                r.version,
                r.keyVersion,
                r.recoveryVersion,
                r.wrappingSalt,
                r.wrappingNonce,
                r.encryptedKey,
                r.backupNonce,
                r.encryptedRecoveryKey,
                r.publicKey,
            ],
        ]),
    );
}
export async function createRecovery(
    accountKey: Uint8Array<ArrayBuffer>,
    userId: string,
    recoveryVersion = 1,
    keyVersion = 1,
) {
    await sodium.ready;
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const backupNonce = crypto.getRandomValues(new Uint8Array(24));
    const wrapping = await derive(secret, salt, 'account-wrap');
    const backup = await derive(accountKey, salt, 'secret-backup');
    const signingSeed = await derive(secret, salt, 'authentication');
    const pair = sodium.crypto_sign_seed_keypair(signingSeed);
    try {
        const envelope: RecoveryEnvelope = {
            version: 1,
            keyVersion,
            recoveryVersion,
            wrappingSalt: encode(salt),
            wrappingNonce: encode(nonce),
            encryptedKey: encode(
                await encryptKey(
                    accountKey,
                    wrapping,
                    nonce,
                    context('account-wrap', userId, recoveryVersion, keyVersion),
                ),
            ),
            backupNonce: encode(backupNonce),
            encryptedRecoveryKey: encode(
                await encryptKey(
                    secret,
                    backup,
                    backupNonce,
                    context('secret-backup', userId, recoveryVersion, keyVersion),
                ),
            ),
            publicKey: encode(pair.publicKey),
        };
        return { recovery: envelope, phrase: entropyToMnemonic(secret, wordlist) };
    } finally {
        secret.fill(0);
        wrapping.fill(0);
        backup.fill(0);
        signingSeed.fill(0);
        pair.privateKey.fill(0);
    }
}
function checkEnvelope(envelope: RecoveryEnvelope) {
    if (
        envelope.version !== 1 ||
        !Number.isSafeInteger(envelope.keyVersion) ||
        envelope.keyVersion < 1 ||
        !Number.isSafeInteger(envelope.recoveryVersion) ||
        envelope.recoveryVersion < 1
    )
        throw new CryptoError('Unsupported recovery key version.');
}
export async function readRecoveryPhrase(
    accountKey: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: RecoveryEnvelope,
) {
    checkEnvelope(envelope);
    const key = await derive(accountKey, decode(envelope.wrappingSalt, 32), 'secret-backup');
    let secret: Uint8Array | undefined;
    try {
        secret = await decryptKey(
            decode(envelope.encryptedRecoveryKey, 48),
            key,
            decode(envelope.backupNonce, 24),
            context('secret-backup', userId, envelope.recoveryVersion, envelope.keyVersion),
        );
        return entropyToMnemonic(secret, wordlist);
    } finally {
        key.fill(0);
        secret?.fill(0);
    }
}
export async function openRecovery(phrase: string, userId: string, envelope: RecoveryEnvelope) {
    checkEnvelope(envelope);
    await sodium.ready;
    let secret: Uint8Array<ArrayBuffer>;
    try {
        secret = new Uint8Array(
            mnemonicToEntropy(phrase.trim().toLowerCase().split(/\s+/).join(' '), wordlist),
        );
    } catch {
        throw new CryptoError(
            'That is not a valid recovery phrase. Check each word and try again.',
        );
    }
    if (secret.length !== 32) {
        secret.fill(0);
        throw new CryptoError('Enter your 24-word recovery phrase.');
    }
    const salt = decode(envelope.wrappingSalt, 32);
    const key = await derive(secret, salt, 'account-wrap');
    const seed = await derive(secret, salt, 'authentication');
    const pair = sodium.crypto_sign_seed_keypair(seed);
    try {
        if (encode(pair.publicKey) !== envelope.publicKey)
            throw new CryptoError('The recovery phrase does not match this account.');
        const accountKey = await decryptKey(
            decode(envelope.encryptedKey, 48),
            key,
            decode(envelope.wrappingNonce, 24),
            context('account-wrap', userId, envelope.recoveryVersion, envelope.keyVersion),
        );
        return { accountKey, signingKey: new Uint8Array(pair.privateKey) };
    } finally {
        secret.fill(0);
        key.fill(0);
        seed.fill(0);
        pair.privateKey.fill(0);
    }
}
export async function signRecoveryReset(input: RecoveryReset, signingKey: Uint8Array) {
    await sodium.ready;
    return encode(sodium.crypto_sign_detached(recoveryResetMessage(input), signingKey));
}
export async function verifyRecoveryReset(
    input: RecoveryReset,
    signature: string,
    publicKey: string,
) {
    await sodium.ready;
    return sodium.crypto_sign_verify_detached(
        decode(signature, 64),
        recoveryResetMessage(input),
        decode(publicKey, 32),
    );
}
