import { CryptoError } from './errors';

/*
 * What two people compare over another channel before trusting a key the
 * server handed them: SHA-256 over the identity encryption public key, shown
 * as ten groups of four hex digits. Web Crypto only, so the main thread can
 * show it without loading libsodium.
 */
export async function fingerprint(encryptionPublicKey: Uint8Array) {
    if (encryptionPublicKey.length !== 32) throw new CryptoError('Invalid identity key.');
    const prefix = new TextEncoder().encode('hushos/identity/fingerprint/v1');
    const input = new Uint8Array(prefix.length + 32);
    input.set(prefix);
    input.set(encryptionPublicKey, prefix.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    const hex = Array.from(digest.subarray(0, 20), (byte) =>
        byte.toString(16).padStart(2, '0'),
    ).join('');
    return hex.match(/.{4}/g)!.join(' ');
}

/* SHA-256 of a public key, as hex: what a pin keeps of a contact's ML-KEM key instead of 1184 bytes. */
export async function keyDigest(publicKey: Uint8Array) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey.slice()));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/* Base64url to bytes without the keys module, which pulls in the password profile. */
export function publicKeyBytes(value: string) {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
