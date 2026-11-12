import { argon2id } from 'hash-wasm';
import sodium from 'libsodium-wrappers';
import { CryptoError } from './errors';
import { encode } from './keys';
import { BACKUP_CODE_ALPHABET, BACKUP_CODE_LENGTH } from './two-step';

/*
 * Two-step sign-in, the server's half (docs/two-step-design.md 2, 8). The step is a server
 * rule, and nothing here is end-to-end encrypted: the server computes an authenticator's codes
 * itself, so it holds the secret. What this module gives is protection at rest, against a
 * copy of the database taken without the two-step key: secrets are sealed under it, and
 * backup codes are stored only as a keyed, slow hash.
 */

const text = new TextEncoder();
const bytes = (value: Uint8Array) => new Uint8Array(value);

/* ------------------------------------------------------------------------- */
/* The two-step key                                                           */
/* ------------------------------------------------------------------------- */

export const TWO_STEP_KEY_BYTES = 32;
const KEY_INFO = 'hushos/two-step/key/v1';

/*
 * The key when the operator sets none: HKDF-SHA-256 of the OPAQUE server setup, with its own
 * `info`, so it is independent of the server hash key derived from the same setup. The setup
 * is the same value in the environment or in the database, so moving it changes nothing here.
 */
export async function deriveTwoStepKey(serverSetup: Uint8Array) {
    const material = await crypto.subtle.importKey('raw', bytes(serverSetup), 'HKDF', false, [
        'deriveBits',
    ]);
    return new Uint8Array(
        await crypto.subtle.deriveBits(
            { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: text.encode(KEY_INFO) },
            material,
            TWO_STEP_KEY_BYTES * 8,
        ),
    );
}

/* What a row records of the key it was sealed or hashed under: the first 8 bytes of SHA-256(key). */
export async function twoStepKeyId(key: Uint8Array) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(key))).slice(0, 8);
}

/* ------------------------------------------------------------------------- */
/* Authenticator apps (RFC 6238)                                              */
/* ------------------------------------------------------------------------- */

export const TOTP_SECRET_BYTES = 20;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

/* 160 bits, the length RFC 4226 recommends. */
export function generateTotpSecret() {
    return crypto.getRandomValues(new Uint8Array(TOTP_SECRET_BYTES));
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/* RFC 4648 base32 without padding: how authenticator apps take a secret. */
export function base32(value: Uint8Array) {
    let bits = 0;
    let buffer = 0;
    let out = '';
    for (const byte of value) {
        buffer = (buffer << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32[(buffer >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
    return out;
}

/* The time step a moment falls in. */
export function totpStep(now: number = Date.now()) {
    return Math.floor(now / (TOTP_PERIOD_SECONDS * 1000));
}

/* The six digits for one time step: HMAC-SHA-1 and RFC 4226's dynamic truncation. */
export async function totpCode(secret: Uint8Array, step: number) {
    const counter = new Uint8Array(8);
    new DataView(counter.buffer).setBigUint64(0, BigInt(step));
    const key = await crypto.subtle.importKey(
        'raw',
        bytes(secret),
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign'],
    );
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
    const offset = mac[19]! & 15;
    const value =
        ((mac[offset]! & 127) << 24) |
        (mac[offset + 1]! << 16) |
        (mac[offset + 2]! << 8) |
        mac[offset + 3]!;
    return String(value % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/* Compared in full whatever the result: where two strings first differ never shows in the time taken. */
function sameText(a: string, b: string) {
    let difference = a.length ^ b.length;
    for (let index = 0; index < Math.max(a.length, b.length); index++)
        difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
    return difference === 0;
}

/*
 * The time steps a typed code is right for, of T-1, T and T+1: the 90 seconds RFC 6238 5.2
 * allows for network delay. All three are computed and compared every time. Usually one step
 * or none; the caller decides which to spend, since a step is accepted only once.
 */
export async function totpMatches(secret: Uint8Array, typed: string, now: number = Date.now()) {
    const code = typed.replace(/\s/g, '');
    const current = totpStep(now);
    const steps: number[] = [];
    for (const step of [current - 1, current, current + 1]) {
        const matches = sameText(await totpCode(secret, step), code);
        if (matches) steps.push(step);
    }
    return steps;
}

/*
 * The key URI an authenticator app scans (Google's Key Uri Format): SHA-1, six digits and 30
 * seconds, the defaults every app honours. The label carries the email, as every service's
 * does; the issuer tells two servers' entries apart.
 */
export function totpUri(input: { secret: Uint8Array; email: string; issuer: string }) {
    const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.email)}`;
    const query = `secret=${base32(input.secret)}&issuer=${encodeURIComponent(input.issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
    return `otpauth://totp/${label}?${query}`;
}

/*
 * The secret at rest: XChaCha20-Poly1305 under the two-step key, bound to the account, the
 * factor and the key it was sealed under, so a row copied onto another account or factor
 * does not open.
 */
function sealContext(input: { userId: string; factorId: string; keyId: Uint8Array }) {
    return text.encode(
        JSON.stringify([
            'hushos/two-step/totp',
            1,
            input.userId.toLowerCase(),
            input.factorId.toLowerCase(),
            encode(input.keyId),
        ]),
    );
}

export async function sealTotpSecret(input: {
    secret: Uint8Array;
    key: Uint8Array;
    userId: string;
    factorId: string;
}) {
    await sodium.ready;
    if (input.secret.length !== TOTP_SECRET_BYTES || input.key.length !== TWO_STEP_KEY_BYTES)
        throw new CryptoError('Invalid two-step secret.');
    const keyId = await twoStepKeyId(input.key);
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const sealed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        input.secret,
        sealContext({ ...input, keyId }),
        null,
        nonce,
        input.key,
    );
    return { keyId, nonce, sealed: new Uint8Array(sealed) };
}

/* The secret, or null when the key, the account, the factor or the bytes are not the ones it was sealed with. */
export async function openTotpSecret(input: {
    sealed: Uint8Array;
    nonce: Uint8Array;
    key: Uint8Array;
    userId: string;
    factorId: string;
}) {
    await sodium.ready;
    try {
        return new Uint8Array(
            sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                null,
                input.sealed,
                sealContext({ ...input, keyId: await twoStepKeyId(input.key) }),
                input.nonce,
                input.key,
            ),
        );
    } catch {
        return null;
    }
}

/* ------------------------------------------------------------------------- */
/* Backup codes                                                               */
/* ------------------------------------------------------------------------- */

export const BACKUP_CODES = 10;
export const BACKUP_CODE_SALT_BYTES = 16;
/* OWASP's minimum for Argon2id: 19 MiB, two passes, one lane. */
const ARGON2 = { memorySize: 19 * 1024, iterations: 2, parallelism: 1, hashLength: 32 } as const;

/* A set of codes: 50 random bits each, five to a character. */
export function generateBackupCodes() {
    return Array.from({ length: BACKUP_CODES }, () => {
        const random = crypto.getRandomValues(new Uint8Array(BACKUP_CODE_LENGTH));
        let code = '';
        // Each byte's low five bits: 32 symbols, so no value is likelier than another.
        for (const byte of random) code += BACKUP_CODE_ALPHABET[byte & 31];
        return code;
    });
}

/*
 * What is stored of a code: Argon2id(HMAC-SHA-256(twoStepKey, code), accountSalt). Keyed, so a
 * copy of the database without the key gives nothing to test a guess against; slow, so with
 * the key each guess at a 50-bit code still costs one Argon2id run. `code` is the ten
 * characters as `normalizeBackupCode` leaves them.
 */
export async function hashBackupCode(input: { code: string; key: Uint8Array; salt: Uint8Array }) {
    if (
        input.code.length !== BACKUP_CODE_LENGTH ||
        input.key.length !== TWO_STEP_KEY_BYTES ||
        input.salt.length !== BACKUP_CODE_SALT_BYTES
    )
        throw new CryptoError('Invalid backup code.');
    const key = await crypto.subtle.importKey(
        'raw',
        bytes(input.key),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const keyed = new Uint8Array(await crypto.subtle.sign('HMAC', key, text.encode(input.code)));
    try {
        return await argon2id({
            ...ARGON2,
            password: keyed,
            salt: bytes(input.salt),
            outputType: 'binary',
        });
    } finally {
        keyed.fill(0);
    }
}
