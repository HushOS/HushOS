import { describe, expect, test } from 'vitest';
import { fingerprint, fingerprintWords, FINGERPRINT_WORDS } from './fingerprint';

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

    test('the same keys give the same twelve words, and another key of either kind different ones', async () => {
        const one = fingerprintWords(await fingerprint(key(1), key(2)));
        expect(one).toHaveLength(FINGERPRINT_WORDS);
        expect(fingerprintWords(await fingerprint(key(1), key(2)))).toEqual(one);
        expect(fingerprintWords(await fingerprint(key(4), key(2)))).not.toEqual(one);
        // The signing key vouches for the ML-KEM key, so swapping it alone must show.
        expect(fingerprintWords(await fingerprint(key(1), key(3)))).not.toEqual(one);
    });

    test('is the vector the native core prints for the same keys', async () => {
        // crates/hushos-core contacts.rs checks the same value.
        expect(await fingerprint(key(1), key(2))).toBe(
            '8e5f 7614 6df7 df81 0a13 a5aa 35c7 ac7d b5db 2e38',
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
