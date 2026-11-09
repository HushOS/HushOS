import { argon2id } from 'hash-wasm';
import sodium from 'libsodium-wrappers';
import { decryptKey, encryptKey } from './aead';
import { encode } from './keys';

/*
 * Two-step sign-in, what only the server computes (docs/two-step-design.md 2):
 * authenticator codes, the seal a TOTP secret is stored under, and backup
 * codes with the keyed, slow hash they are stored as. Nothing here is
 * end-to-end encrypted, and the design never says it is: TOTP is a shared
 * secret the server must read to check a code. The seal and the keyed hash
 * protect a copy of the database taken without the two-step key, and nothing
 * else. Never import this from client code.
 */

/* RFC 6238 with the defaults every authenticator app assumes: SHA-1, six digits, 30 seconds. */
export const TOTP_SECRET_BYTES = 20;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/* Steps accepted either side of the current one (RFC 6238 5.2): 90 seconds in all. */
export const TOTP_WINDOW = 1;

const KEY_INFO = 'hushos/two-step/key/v1';
const TOTP_DOMAIN = 'hushos/two-step/totp';
const KEY_BYTES = 32;

const bytes = (value: Uint8Array) => new Uint8Array(value);

/*
 * The two-step key an instance has when its operator sets none: HKDF-SHA-256
 * of the OPAQUE server setup, with its own `info`, so it is independent of the
 * server hash key (`hushos/server/hash-key/v1`) and the same wherever the setup
 * is kept, in the environment or in the database.
 */
export async function deriveTwoStepKey(serverSetup: Uint8Array) {
    const material = await crypto.subtle.importKey('raw', bytes(serverSetup), 'HKDF', false, [
        'deriveBits',
    ]);
    return new Uint8Array(
        await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new Uint8Array(0),
                info: new TextEncoder().encode(KEY_INFO),
            },
            material,
            KEY_BYTES * 8,
        ),
    );
}

/* What a row records of the key it was made under: the first 8 bytes of the key's SHA-256. */
export async function twoStepKeyId(key: Uint8Array) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(key))).subarray(0, 8);
}

/* ------------------------------------------------------------------------- */
/* Authenticator codes                                                        */
/* ------------------------------------------------------------------------- */

export function generateTotpSecret() {
    return crypto.getRandomValues(new Uint8Array(TOTP_SECRET_BYTES));
}

/* The time step a moment falls in: whole 30-second periods since the Unix epoch. */
export function totpStep(at: number | Date = Date.now()) {
    return Math.floor(Number(at) / 1000 / TOTP_PERIOD_SECONDS);
}

/* The code for one time step (RFC 4226 5.3 over RFC 6238's counter), zero-padded. */
export async function totpCode(secret: Uint8Array, step: number, digits = TOTP_DIGITS) {
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
    const offset = mac[mac.length - 1]! & 0x0f;
    const binary =
        ((mac[offset]! & 0x7f) << 24) |
        (mac[offset + 1]! << 16) |
        (mac[offset + 2]! << 8) |
        mac[offset + 3]!;
    return String(binary % 10 ** digits).padStart(digits, '0');
}

/* Equal or not, in time that depends on the length alone. */
function sameText(a: string, b: string) {
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let index = 0; index < a.length; index++)
        difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
    return difference === 0;
}

/*
 * The time steps `code` is the code for, among T−1, T and T+1, oldest first
 * (two only if two steps happen to share a code). Every candidate is computed
 * and compared whatever the result, so the check takes the same time for a
 * right code, a wrong one and one that is not six digits at all.
 */
export async function matchTotp(secret: Uint8Array, code: string, at: number | Date = Date.now()) {
    const current = totpStep(at);
    const typed = /^[0-9]{6}$/.test(code) ? code : 'xxxxxx';
    const matches: number[] = [];
    for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++)
        if (sameText(await totpCode(secret, step), typed)) matches.push(step);
    return matches;
}

function totpContext(binding: { userId: string; factorId: string; keyId: Uint8Array }) {
    return new TextEncoder().encode(
        JSON.stringify([
            TOTP_DOMAIN,
            1,
            binding.userId.toLowerCase(),
            binding.factorId.toLowerCase(),
            encode(binding.keyId),
        ]),
    );
}

/*
 * Seals a TOTP secret for storage: XChaCha20-Poly1305 under the two-step key,
 * bound to the account, the factor and the key's id, so a sealed secret moved
 * to another account's row, or another factor's, does not open.
 */
export async function sealTotpSecret(
    secret: Uint8Array,
    key: Uint8Array,
    binding: { userId: string; factorId: string; keyId: Uint8Array },
) {
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    return { nonce, sealed: await encryptKey(secret, key, nonce, totpContext(binding)) };
}

/* Opens a sealed TOTP secret, or throws: another key, another row, or a changed ciphertext. */
export function openTotpSecret(
    sealed: Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
    binding: { userId: string; factorId: string; keyId: Uint8Array },
) {
    return decryptKey(sealed, key, nonce, totpContext(binding));
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/* RFC 4648 base32 without padding: how an authenticator app takes a secret typed by hand. */
export function base32(value: Uint8Array) {
    let out = '';
    let buffer = 0;
    let bits = 0;
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

/*
 * The key URI an authenticator app scans (Google's Key Uri Format). The label
 * carries the issuer and the account's email; `issuer` is `HushOS`, or
 * `HushOS (<host>)` on a self-hosted server so two servers' entries can be
 * told apart in the app.
 */
export function totpUri(input: { issuer: string; email: string; secret: Uint8Array }) {
    const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.email)}`;
    return `otpauth://totp/${label}?secret=${base32(input.secret)}&issuer=${encodeURIComponent(input.issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}

/* ------------------------------------------------------------------------- */
/* Backup codes                                                               */
/* ------------------------------------------------------------------------- */

/* Crockford base32: no I, L, O or U. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const BACKUP_CODE_LENGTH = 10;
/* The OWASP minimum for Argon2id: 19 MiB, two passes, one lane. */
const BACKUP_HASH = { memorySize: 19 * 1024, iterations: 2, parallelism: 1 } as const;

/* A new backup code, 50 bits, as it is stored and checked: ten characters, no hyphen. */
export function generateBackupCode() {
    const random = crypto.getRandomValues(new Uint8Array(BACKUP_CODE_LENGTH));
    // 32 divides 256, so the low five bits of a random byte are an unbiased index.
    return Array.from(random, (byte) => CROCKFORD[byte & 31]).join('');
}

/* A code as a person reads it: `7KQ2M-9XD4P`. */
export function formatBackupCode(code: string) {
    return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/*
 * What a person typed, as the code it stands for: case, spaces and hyphens are
 * ignored, I and L read as 1 and O as 0. Null when that is not ten characters
 * of the alphabet.
 */
export function normalizeBackupCode(input: string) {
    const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
    return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(code) ? code : null;
}

/*
 * A backup code as it is stored: Argon2id(HMAC-SHA-256(twoStepKey, code), salt),
 * 32 bytes, with the account's 16-byte salt. Keyed, a copy of the database
 * without the key gives nothing to guess against; slow, each guess with the
 * key still costs one Argon2id run. `code` is a normalised code.
 */
export async function hashBackupCode(code: string, key: Uint8Array, salt: Uint8Array) {
    const hmacKey = await crypto.subtle.importKey(
        'raw',
        bytes(key),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const keyed = new Uint8Array(
        await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(code)),
    );
    try {
        return await argon2id({
            password: keyed,
            salt: bytes(salt),
            ...BACKUP_HASH,
            hashLength: 32,
            outputType: 'binary',
        });
    } finally {
        keyed.fill(0);
    }
}

/* Whether two hashes are the same, in constant time. */
export async function sameHash(a: Uint8Array, b: Uint8Array) {
    await sodium.ready;
    return a.length === b.length && sodium.memcmp(a, b);
}
