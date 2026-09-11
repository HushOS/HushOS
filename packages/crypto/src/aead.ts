import sodium from 'libsodium-wrappers';
import { CryptoError } from './errors';

export async function encryptKey(
    plaintext: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
    context: Uint8Array,
) {
    await sodium.ready;
    return new Uint8Array(
        sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, context, null, nonce, key),
    );
}
/*
 * A failed decryption is a wrong key, a wrong context, or a changed ciphertext;
 * libsodium cannot tell them apart and neither can we. It is reported as a
 * CryptoError so the message survives the worker boundary instead of the
 * generic fallback, which would hide a corrupted envelope behind "try again".
 */
export async function decryptKey(
    ciphertext: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
    context: Uint8Array,
) {
    await sodium.ready;
    try {
        return new Uint8Array(
            sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                null,
                ciphertext,
                context,
                nonce,
                key,
            ),
        );
    } catch {
        throw new CryptoError(
            'This encrypted key could not be opened. It may belong to a different account or version, or it may be damaged.',
        );
    }
}
