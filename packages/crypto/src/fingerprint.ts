import { wordlist } from '@scure/bip39/wordlists/english.js';
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

export const FINGERPRINT_WORDS = 12;

/*
 * The same fingerprint as words, for reading aloud: its first 132 bits taken
 * eleven at a time, most significant first, each naming a word in the BIP-39
 * English list. A plain index, not a mnemonic: no checksum, and the last 28
 * bits of the fingerprint are not shown. 132 bits is far past what anyone could
 * forge a matching key for. Every client must draw the same words from the
 * same fingerprint, so this mapping never changes without a new version.
 */
export function fingerprintWords(fingerprint: string) {
    const hex = fingerprint.replaceAll(' ', '');
    if (!/^[0-9a-f]{40}$/.test(hex)) throw new CryptoError('Invalid fingerprint.');
    let bits = BigInt(`0x${hex}`) >> 28n;
    const words: string[] = [];
    for (let index = 0; index < FINGERPRINT_WORDS; index++) {
        words.unshift(wordlist[Number(bits & 2047n)]!);
        bits >>= 11n;
    }
    return words;
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
