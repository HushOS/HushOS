import sodium from 'libsodium-wrappers';

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
export async function decryptKey(
    ciphertext: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
    context: Uint8Array,
) {
    await sodium.ready;
    return new Uint8Array(
        sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, context, nonce, key),
    );
}
