import { fingerprint, publicKeyBytes } from './fingerprint';

/*
 * The rules a device applies to the pins and settings the server hands back.
 * Web Crypto only, so the main thread can apply them without libsodium.
 */

/*
 * Whether a pin stands for a words check over the keys it holds: its signing
 * key is there, and its fingerprint is the v2 one over both keys. Pins made
 * before (automatically from a received share, or compared over X25519 alone)
 * are trusted with nothing until the two people compare words again.
 */
export async function pinVerified(pin: {
    encryptionPublicKey: string;
    signingPublicKey: string;
    fingerprint: string;
}) {
    if (!pin.signingPublicKey) return false;
    try {
        const print = await fingerprint(
            publicKeyBytes(pin.encryptionPublicKey),
            publicKeyBytes(pin.signingPublicKey),
        );
        return print === pin.fingerprint;
    } catch {
        return false;
    }
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
