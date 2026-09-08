import sodium from 'libsodium-wrappers';
import { encryptKey } from './aead';
import { encode } from './keys';

export type IdentityEnvelope = {
    version: 1;
    keyVersion: 1;
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
function identityContext(userId: string, purpose: string, publicKey: string) {
    return new TextEncoder().encode(
        JSON.stringify(['hushos/identity', 1, userId.toLowerCase(), 1, purpose, publicKey]),
    );
}
// Independent long-lived identity. Recovery rotates recovery credentials, never these keys.
export async function createIdentity(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
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
            keyVersion: 1,
            wrappingSalt: encode(salt),
            encryptionPublicKey,
            signingPublicKey,
            encryptionPrivateKeyNonce: encode(encryptionNonce),
            encryptedEncryptionPrivateKey: encode(
                await encryptKey(
                    encryption.privateKey,
                    encryptionWrap,
                    encryptionNonce,
                    identityContext(userId, 'encryption-private-wrap', encryptionPublicKey),
                ),
            ),
            signingSeedNonce: encode(signingNonce),
            encryptedSigningSeed: encode(
                await encryptKey(
                    signingSeed,
                    signingWrap,
                    signingNonce,
                    identityContext(userId, 'signing-seed-wrap', signingPublicKey),
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
