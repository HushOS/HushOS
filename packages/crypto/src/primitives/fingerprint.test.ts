import { describe, expect, test } from 'vitest';
import { fingerprint, fingerprintOfKeys, fingerprintWords, FINGERPRINT_WORDS } from './fingerprint';

/* A fingerprint as fingerprint() prints it, from a 160-bit value. */
function print(value: bigint) {
    return value.toString(16).padStart(40, '0').match(/.{4}/g)!.join(' ');
}

const key = (fill: number) => new Uint8Array(32).fill(fill);

describe('fingerprint words', () => {
    // The BIP-39 English list starts with "abandon" and "ability" and ends with "zoo",
    // so these vectors are checkable against the published list, not against this code.
    test('all zero bits read as the first word, all one bits as the last', () => {
        expect(fingerprintWords(print(0n))).toEqual(Array(12).fill('abandon'));
        expect(fingerprintWords(print((1n << 160n) - 1n))).toEqual(Array(12).fill('zoo'));
    });

    test('words are read eleven bits at a time from the most significant end', () => {
        // Index 1 in the first word's eleven bits, nothing else.
        const first = fingerprintWords(print(1n << 149n));
        expect(first[0]).toBe('ability');
        expect(first.slice(1)).toEqual(Array(11).fill('abandon'));
        // Index 2047 in the twelfth word's eleven bits, the last ones shown.
        const last = fingerprintWords(print(2047n << 28n));
        expect(last.slice(0, 11)).toEqual(Array(11).fill('abandon'));
        expect(last[11]).toBe('zoo');
    });

    test('the 28 bits past the twelfth word are not shown', () => {
        const shown = 2047n << 28n;
        expect(fingerprintWords(print(shown | ((1n << 28n) - 1n)))).toEqual(
            fingerprintWords(print(shown)),
        );
    });

    test('one changed bit among the shown ones changes a word', () => {
        const base = fingerprintWords(print(0n));
        for (const bit of [28n, 100n, 159n]) {
            expect(fingerprintWords(print(1n << bit))).not.toEqual(base);
        }
    });

    test('the same keys give the same twelve words, and another key of any of the four kinds different ones', async () => {
        const one = fingerprintWords(await fingerprint(key(1), key(2), key(3), key(4)));
        expect(one).toHaveLength(FINGERPRINT_WORDS);
        expect(fingerprintWords(await fingerprint(key(1), key(2), key(3), key(4)))).toEqual(one);
        // X25519, Ed25519, and the digests of the ML-DSA and ML-KEM keys: a swap of any one shows.
        for (const swapped of [
            [key(9), key(2), key(3), key(4)],
            [key(1), key(9), key(3), key(4)],
            [key(1), key(2), key(9), key(4)],
            [key(1), key(2), key(3), key(9)],
        ] as const)
            expect(fingerprintWords(await fingerprint(...swapped))).not.toEqual(one);
    });

    test('the lattice keys enter by their digests, and a changed ML-DSA or ML-KEM key changes the words', async () => {
        const mlDsa = new Uint8Array(1952).fill(5);
        const kem = new Uint8Array(1184).fill(6);
        const one = await fingerprintOfKeys(key(1), key(2), mlDsa, kem);
        const digestOf = async (bytes: Uint8Array<ArrayBuffer>) =>
            new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        expect(one).toBe(
            await fingerprint(key(1), key(2), await digestOf(mlDsa), await digestOf(kem)),
        );
        const otherMlDsa = mlDsa.slice();
        otherMlDsa[1951] = 7;
        const otherKem = kem.slice();
        otherKem[0] = 7;
        expect(await fingerprintOfKeys(key(1), key(2), otherMlDsa, kem)).not.toBe(one);
        expect(await fingerprintOfKeys(key(1), key(2), mlDsa, otherKem)).not.toBe(one);
        // Keys of the wrong size are refused rather than digested.
        await expect(fingerprintOfKeys(key(1), key(2), key(3), kem)).rejects.toThrow();
    });

    test('is the vector the native core prints for the same keys', async () => {
        // crates/hushos-core contacts.rs checks the same value; recomputed independently with
        // SHA-256("hushos/identity/fingerprint/v3" || 32×01 || 32×02 || 32×03 || 32×04).
        expect(await fingerprint(key(1), key(2), key(3), key(4))).toBe(
            '8b16 2a14 2a5b cb5b 1070 8017 ae93 b2e6 b496 7640',
        );
    });

    test('anything that is not a fingerprint is refused', () => {
        expect(() => fingerprintWords('')).toThrow();
        expect(() => fingerprintWords('0'.repeat(39))).toThrow();
        expect(() => fingerprintWords('0'.repeat(41))).toThrow();
        expect(() => fingerprintWords('g'.repeat(40))).toThrow();
        expect(() => fingerprintWords('F'.repeat(40))).toThrow();
    });
});
