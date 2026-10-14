import { fingerprint, hexBytes, publicKeyBytes } from './fingerprint';

/*
 * The rules a device applies to the pins and settings the server hands back.
 * Web Crypto only, so the main thread can apply them without libsodium.
 */

/*
 * Whether a pin stands for a words check over the keys it holds: a version 3
 * pin (docs/identity-pq-design.md), carrying the X25519 and Ed25519 keys, the
 * digests of the ML-DSA and ML-KEM keys, and the version 3 fingerprint over
 * all four. Pins made before (version 2, over X25519 and Ed25519 alone, or
 * made automatically) trust nothing until the two people compare words again,
 * whatever the server serves for that contact.
 */
export async function pinVerified(pin: {
    encryptionPublicKey: string;
    signingPublicKey: string;
    mlDsaPublicKeyHash?: string | null;
    kemPublicKeyHash?: string | null;
    fingerprint: string;
}) {
    if (!pin.signingPublicKey || !pin.mlDsaPublicKeyHash || !pin.kemPublicKeyHash) return false;
    try {
        const print = await fingerprint(
            canonicalKey(pin.encryptionPublicKey),
            canonicalKey(pin.signingPublicKey),
            hexBytes(pin.mlDsaPublicKeyHash),
            hexBytes(pin.kemPublicKeyHash),
        );
        return print === pin.fingerprint;
    } catch {
        return false;
    }
}

/*
 * A 32-byte key in canonical base64url (no padding, no other alphabet), as every
 * client writes it; anything else throws, so a pin verifies on every client or
 * on none (the Rust core refuses the same encodings).
 */
function canonicalKey(value: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Invalid key.');
    const bytes = publicKeyBytes(value);
    // The last character carries 2 spare bits, which must be zero in the canonical form.
    if (!/[AEIMQUYcgkosw048]$/.test(value) || bytes.length !== 32) throw new Error('Invalid key.');
    return bytes;
}

/*
 * Whether settings the server served are older than this device has seen: an
 * older version, or none at all after one was seen. The server keeps the
 * settings and could otherwise bring back a pin the person replaced or drop
 * one they made.
 */
export function settingsRolledBack(served: number | null, seen: number) {
    return served === null ? seen > 0 : served < seen;
}
