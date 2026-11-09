import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    base32,
    deriveTwoStepKey,
    formatBackupCode,
    generateBackupCode,
    generateTotpSecret,
    hashBackupCode,
    matchTotp,
    normalizeBackupCode,
    normalizeTotpCode,
    openTotpSecret,
    sameHash,
    sealTotpSecret,
    totpCode,
    totpStep,
    totpUri,
    twoStepKeyId,
} from './two-step-server';

/*
 * What the server computes for the second step (docs/two-step-design.md 2 and
 * 10): authenticator codes to the RFC's vectors and window, the seal of a TOTP
 * secret, and backup codes as they are typed and stored. Keys, salts and
 * secrets are fixed values, so a failure reproduces.
 */
const ascii = (value: string) => new TextEncoder().encode(value);
const fill = (length: number, seed: number) =>
    Uint8Array.from({ length }, (_, i) => (i * 17 + seed) & 0xff);

/* RFC 6238 Appendix B, the SHA-1 rows: the 20-byte ASCII secret, eight digits. */
const RFC_SECRET = ascii('12345678901234567890');
const RFC_VECTORS: [seconds: number, step: number, code: string][] = [
    [59, 0x1, '94287082'],
    [1111111109, 0x23523ec, '07081804'],
    [1111111111, 0x23523ed, '14050471'],
    [1234567890, 0x273ef07, '89005924'],
    [2000000000, 0x3f940aa, '69279037'],
    [20000000000, 0x27bc86aa, '65353130'],
];

describe('authenticator codes', () => {
    it('match RFC 6238’s SHA-1 test vectors, and the six-digit code is their last six digits', async () => {
        for (const [seconds, step, code] of RFC_VECTORS) {
            expect(totpStep(seconds * 1000)).toBe(step);
            expect(await totpCode(RFC_SECRET, step, 8)).toBe(code);
            expect(await totpCode(RFC_SECRET, step)).toBe(code.slice(2));
        }
    });

    it('are accepted for T−1, T and T+1, each for its own step, and refused for T−2 and T+2', async () => {
        const at = 1_700_000_015_000;
        const now = totpStep(at);
        for (const offset of [-1, 0, 1])
            expect(
                await matchTotp(RFC_SECRET, await totpCode(RFC_SECRET, now + offset), at),
            ).toEqual([now + offset]);
        for (const offset of [-2, 2])
            expect(
                await matchTotp(RFC_SECRET, await totpCode(RFC_SECRET, now + offset), at),
            ).toEqual([]);
    });

    it('move with the 30-second boundary: a code is good until 60 seconds after its own period ends', async () => {
        const step = 56_666_666;
        const code = await totpCode(RFC_SECRET, step);
        const periodStart = step * 30_000;
        // The first millisecond it is accepted (as T+1), and the last (as T−1).
        expect(await matchTotp(RFC_SECRET, code, periodStart - 30_000)).toEqual([step]);
        expect(await matchTotp(RFC_SECRET, code, periodStart + 60_000 - 1)).toEqual([step]);
        expect(await matchTotp(RFC_SECRET, code, periodStart - 30_000 - 1)).toEqual([]);
        expect(await matchTotp(RFC_SECRET, code, periodStart + 60_000)).toEqual([]);
    });

    it('are refused when they are another secret’s, or not six digits', async () => {
        const at = 1_700_000_015_000;
        const right = await totpCode(RFC_SECRET, totpStep(at));
        expect(await matchTotp(fill(20, 3), right, at)).toEqual([]);
        for (const typed of ['', right.slice(1), `${right}0`, ` ${right.slice(1)}`, 'abcdef'])
            expect(await matchTotp(RFC_SECRET, typed, at)).toEqual([]);
    });

    it('are read as typed: spaces and hyphens ignored, and anything but six digits is no code', () => {
        expect(normalizeTotpCode('123 456')).toBe('123456');
        expect(normalizeTotpCode(' 123-456\n')).toBe('123456');
        expect(normalizeTotpCode('1 2 3 4 5 6')).toBe('123456');
        expect(normalizeTotpCode('000000')).toBe('000000');
        for (const typed of ['', '12345', '1234567', '12345a', 'abcdef', '123.456', '１２３４５６'])
            expect(normalizeTotpCode(typed), typed).toBeNull();
    });

    it('come from a 20-byte secret, shown as base32 in a key URI an authenticator app reads', () => {
        const secret = generateTotpSecret();
        expect(secret).toHaveLength(20);
        expect(generateTotpSecret()).not.toEqual(secret);
        // RFC 4648's vectors.
        expect(base32(ascii('foobar'))).toBe('MZXW6YTBOI');
        expect(base32(ascii('fooba'))).toBe('MZXW6YTB');
        expect(base32(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
        const uri = new URL(
            totpUri({
                issuer: 'HushOS (files.example.org)',
                email: 'maya+work@example.org',
                secret: RFC_SECRET,
            }),
        );
        expect(uri.protocol).toBe('otpauth:');
        expect(uri.host).toBe('totp');
        expect(decodeURIComponent(uri.pathname)).toBe(
            '/HushOS (files.example.org):maya+work@example.org',
        );
        expect(Object.fromEntries(uri.searchParams)).toEqual({
            secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
            issuer: 'HushOS (files.example.org)',
            algorithm: 'SHA1',
            digits: '6',
            period: '30',
        });
    });
});

describe('the two-step key', () => {
    const setup = fill(96, 9);

    it('is HKDF-SHA-256 of the OPAQUE setup under its own info, and not the server hash key', async () => {
        const key = await deriveTwoStepKey(setup);
        expect(Buffer.from(key)).toEqual(
            Buffer.from(hkdfSync('sha256', setup, Buffer.alloc(0), 'hushos/two-step/key/v1', 32)),
        );
        expect(Buffer.from(key)).not.toEqual(
            Buffer.from(
                hkdfSync('sha256', setup, Buffer.alloc(0), 'hushos/server/hash-key/v1', 32),
            ),
        );
        expect(await deriveTwoStepKey(fill(96, 10))).not.toEqual(key);
    });

    it('is named in a row by the first eight bytes of its SHA-256', async () => {
        const key = await deriveTwoStepKey(setup);
        expect(Buffer.from(await twoStepKeyId(key))).toEqual(
            createHash('sha256').update(key).digest().subarray(0, 8),
        );
    });
});

describe('a sealed TOTP secret', () => {
    const key = fill(32, 1);
    const binding = {
        userId: '0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4',
        factorId: '7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
        keyId: fill(8, 2),
    };

    it('is 36 bytes under a fresh 24-byte nonce, and opens for its own account, factor and key', async () => {
        const first = await sealTotpSecret(RFC_SECRET, key, binding);
        const second = await sealTotpSecret(RFC_SECRET, key, binding);
        expect(first.sealed).toHaveLength(36);
        expect(first.nonce).toHaveLength(24);
        expect(second.nonce).not.toEqual(first.nonce);
        expect(Buffer.from(first.sealed).includes(Buffer.from(RFC_SECRET))).toBe(false);
        expect(await openTotpSecret(first.sealed, first.nonce, key, binding)).toEqual(RFC_SECRET);
    });

    it('does not open as another account’s, another factor’s, under another key id or another key', async () => {
        const { sealed, nonce } = await sealTotpSecret(RFC_SECRET, key, binding);
        const elsewhere = [
            { ...binding, userId: '1c8f2d3e-4e5b-4c6d-9e7f-8091a2b3c4d5' },
            { ...binding, factorId: '1c8f2d3e-4e5b-4c6d-9e7f-8091a2b3c4d5' },
            { ...binding, keyId: fill(8, 3) },
        ];
        for (const other of elsewhere)
            await expect(openTotpSecret(sealed, nonce, key, other)).rejects.toThrow();
        await expect(openTotpSecret(sealed, nonce, fill(32, 4), binding)).rejects.toThrow();
        const changed = sealed.slice();
        changed[0]! ^= 1;
        await expect(openTotpSecret(changed, nonce, key, binding)).rejects.toThrow();
    });
});

describe('backup codes', () => {
    const key = fill(32, 5);
    const salt = fill(16, 6);

    it('are ten characters of Crockford base32, shown in two groups of five', () => {
        const seen = new Set<string>();
        for (let index = 0; index < 200; index++) {
            const code = generateBackupCode();
            expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
            expect(normalizeBackupCode(formatBackupCode(code))).toBe(code);
            seen.add(code);
        }
        expect(seen.size).toBe(200);
        expect(formatBackupCode('7KQ2M9XD4P')).toBe('7KQ2M-9XD4P');
    });

    it('are read as typed: any case, spaces and hyphens, I and L as 1, O as 0', () => {
        expect(normalizeBackupCode('7kq2m 9xd4p')).toBe('7KQ2M9XD4P');
        expect(normalizeBackupCode(' 7KQ2M-9XD4P ')).toBe('7KQ2M9XD4P');
        expect(normalizeBackupCode('ilo0o-IL1oO')).toBe('1100011100');
        // Nine or eleven characters, a U, or anything outside the alphabet is no code.
        for (const typed of [
            '7KQ2M-9XD4',
            '7KQ2M-9XD4PP',
            '7KQ2M-9XD4U',
            '7KQ2M_9XD4P',
            '',
            '287082',
        ])
            expect(normalizeBackupCode(typed)).toBeNull();
    });

    it('are stored as Argon2id over an HMAC under the two-step key: not the code, nor a plain hash of it', async () => {
        const code = '7KQ2M9XD4P';
        const stored = await hashBackupCode(code, key, salt);
        expect(stored).toHaveLength(32);
        expect(await sameHash(stored, await hashBackupCode(code, key, salt))).toBe(true);
        const plain = [
            createHash('sha256').update(code).digest(),
            createHash('sha256').update(formatBackupCode(code)).digest(),
            createHmac('sha256', key).update(code).digest(),
        ];
        for (const guess of plain) expect(await sameHash(stored, guess)).toBe(false);
        expect(Buffer.from(stored).includes(Buffer.from(code))).toBe(false);
    });

    it('do not verify under another account’s salt, another two-step key, or for another code', async () => {
        const stored = await hashBackupCode('7KQ2M9XD4P', key, salt);
        expect(await sameHash(stored, await hashBackupCode('7KQ2M9XD4P', key, fill(16, 7)))).toBe(
            false,
        );
        expect(await sameHash(stored, await hashBackupCode('7KQ2M9XD4P', fill(32, 8), salt))).toBe(
            false,
        );
        expect(await sameHash(stored, await hashBackupCode('7KQ2M9XD4Q', key, salt))).toBe(false);
        expect(await sameHash(stored, stored.subarray(0, 31))).toBe(false);
    });
});
