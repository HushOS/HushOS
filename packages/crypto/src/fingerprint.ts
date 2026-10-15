import { wordlist } from '@scure/bip39/wordlists/english.js';
import { CryptoError } from './errors';

/*
 * What two people compare over another channel before trusting a key the
 * server handed them (version 3, docs/identity-pq-design.md): SHA-256 over the
 * identity's four public keys, shown as ten groups of four hex digits and read
 * aloud as words. The two lattice keys enter by their SHA-256 digests, which
 * is what a pin keeps of them, so a pin can check its own fingerprint without
 * holding 3 KB of keys; SHA-256's collision resistance makes that as binding
 * as the keys themselves. Covering the ML-DSA key is what makes the words
 * post-quantum: a key only Ed25519 vouched for would fall with Ed25519. Web
 * Crypto only, so the main thread can show it without loading libsodium.
 */
export async function fingerprint(
    encryptionPublicKey: Uint8Array,
    signingPublicKey: Uint8Array,
    mlDsaPublicKeyDigest: Uint8Array,
    kemPublicKeyDigest: Uint8Array,
) {
    if (
        encryptionPublicKey.length !== 32 ||
        signingPublicKey.length !== 32 ||
        mlDsaPublicKeyDigest.length !== 32 ||
        kemPublicKeyDigest.length !== 32
    )
        throw new CryptoError('Invalid identity key.');
    const prefix = new TextEncoder().encode('hushos/identity/fingerprint/v3');
    const input = new Uint8Array(prefix.length + 128);
    input.set(prefix);
    input.set(encryptionPublicKey, prefix.length);
    input.set(signingPublicKey, prefix.length + 32);
    input.set(mlDsaPublicKeyDigest, prefix.length + 64);
    input.set(kemPublicKeyDigest, prefix.length + 96);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    const hex = Array.from(digest.subarray(0, 20), (byte) =>
        byte.toString(16).padStart(2, '0'),
    ).join('');
    return hex.match(/.{4}/g)!.join(' ');
}

/* The fingerprint from the four public keys themselves, digesting the two lattice keys. */
export async function fingerprintOfKeys(
    encryptionPublicKey: Uint8Array,
    signingPublicKey: Uint8Array,
    mlDsaPublicKey: Uint8Array,
    kemPublicKey: Uint8Array,
) {
    if (mlDsaPublicKey.length !== 1952 || kemPublicKey.length !== 1184)
        throw new CryptoError('Invalid identity key.');
    return fingerprint(
        encryptionPublicKey,
        signingPublicKey,
        hexBytes(await keyDigest(mlDsaPublicKey)),
        hexBytes(await keyDigest(kemPublicKey)),
    );
}

/* Hex to bytes, refusing anything but a 32-byte digest. */
export function hexBytes(hex: string) {
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new CryptoError('Invalid key digest.');
    return Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
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

/* SHA-256 of a public key, as hex: what a pin keeps of a contact's ML-DSA and ML-KEM keys instead of 3 KB. */
export async function keyDigest(publicKey: Uint8Array) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey.slice()));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/* Base64url to bytes without the keys module, which pulls in the password profile. */
export function publicKeyBytes(value: string) {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
