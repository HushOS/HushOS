import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { CryptoError } from './errors';

/*
 * ML-KEM-768 (FIPS 203), the lattice half of hybrid sealing. libsodium has no
 * post-quantum primitive, so this is the one place noble is used. A key pair is
 * expanded from a 64-byte seed the identity keeps wrapped under the account
 * root, the way the Ed25519 signing key is, so nothing larger than the seed
 * ever needs storing on the private side.
 */
export const KEM_SEED_BYTES = 64;
export const KEM_PUBLIC_KEY_BYTES = 1184;
export const KEM_SECRET_KEY_BYTES = 2400;
export const KEM_CIPHERTEXT_BYTES = 1088;
export const KEM_SHARED_SECRET_BYTES = 32;

export function kemKeypair(seed: Uint8Array) {
    if (seed.length !== KEM_SEED_BYTES) throw new CryptoError('Invalid key seed.');
    const { publicKey, secretKey } = ml_kem768.keygen(seed);
    return {
        publicKey: publicKey as Uint8Array<ArrayBuffer>,
        secretKey: secretKey as Uint8Array<ArrayBuffer>,
    };
}

/* A fresh shared secret for the holder of `publicKey`, and the ciphertext that carries it. */
export function kemEncapsulate(publicKey: Uint8Array) {
    if (publicKey.length !== KEM_PUBLIC_KEY_BYTES) throw new CryptoError('Invalid identity key.');
    try {
        const { cipherText, sharedSecret } = ml_kem768.encapsulate(publicKey);
        return {
            ciphertext: cipherText as Uint8Array<ArrayBuffer>,
            sharedSecret: sharedSecret as Uint8Array<ArrayBuffer>,
        };
    } catch {
        throw new CryptoError('Invalid identity key.');
    }
}

/*
 * The shared secret behind a ciphertext. ML-KEM rejects implicitly: a tampered
 * ciphertext yields a different secret, never an error, and it is the AEAD
 * over the share body that then refuses.
 */
export function kemDecapsulate(ciphertext: Uint8Array, secretKey: Uint8Array) {
    if (ciphertext.length !== KEM_CIPHERTEXT_BYTES)
        throw new CryptoError('Invalid share envelope.');
    if (secretKey.length !== KEM_SECRET_KEY_BYTES) throw new CryptoError('Invalid identity key.');
    return ml_kem768.decapsulate(ciphertext, secretKey) as Uint8Array<ArrayBuffer>;
}
