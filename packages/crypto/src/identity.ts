import { CryptoError } from './errors';
import sodium from 'libsodium-wrappers';
import { encryptKey, decryptKey } from './aead';
import { encode, decode } from './keys';

export type IdentityEnvelope = {
    version: 1;
    keyVersion: number;
    wrappingSalt: string;
    encryptionPublicKey: string;
    encryptionPrivateKeyNonce: string;
    encryptedEncryptionPrivateKey: string;
    signingPublicKey: string;
    signingSeedNonce: string;
    encryptedSigningSeed: string;
};
async function identityWrappingKey(
    root: Uint8Array<ArrayBuffer>,
    salt: Uint8Array<ArrayBuffer>,
    purpose: string,
) {
    const key = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(
        await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt,
                info: new TextEncoder().encode(`hushos/identity/${purpose}/v1`),
            },
            key,
            256,
        ),
    );
}
function identityContext(userId: string, keyVersion: number, purpose: string, publicKey: string) {
    return new TextEncoder().encode(
        JSON.stringify([
            'hushos/identity',
            1,
            userId.toLowerCase(),
            keyVersion,
            purpose,
            publicKey,
        ]),
    );
}
// Independent long-lived identity. Recovery rotates recovery credentials, never these keys.
export async function createIdentity(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    keyVersion = 1,
): Promise<IdentityEnvelope> {
    await sodium.ready;
    const encryption = sodium.crypto_box_keypair();
    const signingSeed = crypto.getRandomValues(new Uint8Array(32));
    const signing = sodium.crypto_sign_seed_keypair(signingSeed);
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const encryptionNonce = crypto.getRandomValues(new Uint8Array(24));
    const signingNonce = crypto.getRandomValues(new Uint8Array(24));
    const encryptionWrap = await identityWrappingKey(root, salt, 'encryption-private-wrap');
    const signingWrap = await identityWrappingKey(root, salt, 'signing-seed-wrap');
    const encryptionPublicKey = encode(encryption.publicKey);
    const signingPublicKey = encode(signing.publicKey);
    try {
        return {
            version: 1,
            keyVersion,
            wrappingSalt: encode(salt),
            encryptionPublicKey,
            signingPublicKey,
            encryptionPrivateKeyNonce: encode(encryptionNonce),
            encryptedEncryptionPrivateKey: encode(
                await encryptKey(
                    encryption.privateKey,
                    encryptionWrap,
                    encryptionNonce,
                    identityContext(
                        userId,
                        keyVersion,
                        'encryption-private-wrap',
                        encryptionPublicKey,
                    ),
                ),
            ),
            signingSeedNonce: encode(signingNonce),
            encryptedSigningSeed: encode(
                await encryptKey(
                    signingSeed,
                    signingWrap,
                    signingNonce,
                    identityContext(userId, keyVersion, 'signing-seed-wrap', signingPublicKey),
                ),
            ),
        };
    } finally {
        encryption.privateKey.fill(0);
        signing.privateKey.fill(0);
        signingSeed.fill(0);
        encryptionWrap.fill(0);
        signingWrap.fill(0);
    }
}

// Rewrap the existing private keys; master-key rotation must preserve public identity.
export async function rewrapIdentity(
    oldRoot: Uint8Array<ArrayBuffer>,
    newRoot: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: IdentityEnvelope,
    keyVersion: number,
): Promise<IdentityEnvelope> {
    if (
        envelope.version !== 1 ||
        !Number.isSafeInteger(envelope.keyVersion) ||
        envelope.keyVersion < 1
    )
        throw new CryptoError('Unsupported identity envelope.');
    await sodium.ready;
    const oldSalt = decode(envelope.wrappingSalt, 32);
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const secrets: Uint8Array[] = [];
    async function rewrap(ciphertext: string, nonce: string, purpose: string, publicKey: string) {
        const oldWrap = await identityWrappingKey(oldRoot, oldSalt, purpose);
        secrets.push(oldWrap);
        const privateKey = await decryptKey(
            decode(ciphertext, 48),
            oldWrap,
            decode(nonce, 24),
            identityContext(userId, envelope.keyVersion, purpose, publicKey),
        );
        secrets.push(privateKey);
        const derivedPublic =
            purpose === 'encryption-private-wrap'
                ? sodium.crypto_scalarmult_base(privateKey)
                : (() => {
                      const pair = sodium.crypto_sign_seed_keypair(privateKey);
                      secrets.push(pair.privateKey);
                      return pair.publicKey;
                  })();
        if (encode(derivedPublic) !== publicKey)
            throw new CryptoError('Identity keys do not match.');
        const wrap = await identityWrappingKey(newRoot, salt, purpose);
        secrets.push(wrap);
        const nextNonce = crypto.getRandomValues(new Uint8Array(24));
        return {
            nonce: encode(nextNonce),
            encrypted: encode(
                await encryptKey(
                    privateKey,
                    wrap,
                    nextNonce,
                    identityContext(userId, keyVersion, purpose, publicKey),
                ),
            ),
        };
    }
    try {
        const encryption = await rewrap(
            envelope.encryptedEncryptionPrivateKey,
            envelope.encryptionPrivateKeyNonce,
            'encryption-private-wrap',
            envelope.encryptionPublicKey,
        );
        const signing = await rewrap(
            envelope.encryptedSigningSeed,
            envelope.signingSeedNonce,
            'signing-seed-wrap',
            envelope.signingPublicKey,
        );
        return {
            ...envelope,
            keyVersion,
            wrappingSalt: encode(salt),
            encryptionPrivateKeyNonce: encryption.nonce,
            encryptedEncryptionPrivateKey: encryption.encrypted,
            signingSeedNonce: signing.nonce,
            encryptedSigningSeed: signing.encrypted,
        };
    } finally {
        for (const secret of secrets) secret.fill(0);
    }
}
