import { decryptKey, encryptKey } from './aead';
import { decode, encode } from './keys';

/*
 * The envelope every record a device keeps for itself is sealed in: a
 * family's device records (session-groups.ts, "The device store") and the
 * contact guard (contact-guard.ts). One byte of format version, a 24-byte
 * random nonce, then XChaCha20-Poly1305 of the bytes, with associated data
 * that binds the record to its account, its store and what it is found by,
 * so a record moved anywhere else does not open. The key never leaves the
 * worker; each caller derives its own from key material that exists only
 * while the account is unlocked.
 */
export const DEVICE_STORE_VERSION = 1;

export async function deriveStoreKey(material: Uint8Array<ArrayBuffer>, info: string) {
    const imported = await crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(
        await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new Uint8Array(32),
                info: new TextEncoder().encode(info),
            },
            imported,
            256,
        ),
    );
}

/* `plaintext` sealed under `key` for `context`; the caller zeroes both. */
export async function sealStoreBytes(key: Uint8Array, context: Uint8Array, plaintext: Uint8Array) {
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const sealed = await encryptKey(plaintext, key, nonce, context);
    const out = new Uint8Array(1 + nonce.length + sealed.length);
    out[0] = DEVICE_STORE_VERSION;
    out.set(nonce, 1);
    out.set(sealed, 1 + nonce.length);
    return encode(out);
}

/* The bytes an envelope holds, the caller's to zero; `refused` for anything that does not open. */
export async function openStoreBytes(
    key: Uint8Array,
    context: Uint8Array,
    envelope: string,
    refused: () => Error,
) {
    let bytes: Uint8Array;
    try {
        bytes = decode(envelope);
    } catch {
        throw refused();
    }
    if (bytes.length < 1 + 24 + 16 || bytes[0] !== DEVICE_STORE_VERSION) throw refused();
    try {
        return await decryptKey(bytes.subarray(25), key, bytes.subarray(1, 25), context);
    } catch {
        throw refused();
    }
}
