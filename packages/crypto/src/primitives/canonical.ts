import { CryptoError } from './errors';
import { decode } from './keys';

/*
 * The canonical encoding of group statements (docs/groups-design.md 2.1).
 * Every statement is the compact JSON array JSON.stringify writes, built only
 * from values these checks let through, so the bytes of one statement are
 * the same on every client and a verifier can rebuild them from the parsed
 * fields and refuse anything that differs:
 * - ids are 36-character lowercase hyphenated UUIDs, never lowercased for the
 *   caller (anything else is refused, so no two spellings name one id);
 * - byte strings, digests included, are canonical base64url without padding;
 * - integers run from 1 to 2^53 - 1, which the Rust core refuses beyond too;
 * - lists are strictly ascending by the bytes of their sort key.
 * `hushos-core` (canonical.rs) applies the same rules.
 *
 * Beneath those field rules, every statement keeps one grammar, enforced by
 * encodeStatement and parseStatement alike (design 2.1):
 * - at most MAX_STATEMENT_BYTES bytes, no byte-order mark;
 * - a JSON array, nested at most four deep, of strings and integers only (no
 *   objects, booleans, null, floats, exponents or -0);
 * - strings of printable ASCII other than `"` and `\`, so there is never an
 *   escape, a lone surrogate or a non-ASCII byte;
 * - integers from 0 to 2^53 - 1;
 * - the bytes are exactly the compact encoding of what they hold.
 */

/* The most bytes a statement may have: 4 MiB, far beyond the largest roster allowed. */
export const MAX_STATEMENT_BYTES = 4 * 1024 * 1024;
const PLAIN = /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/;

/* Whether `value` keeps the statement grammar: arrays (at most four deep) of plain strings and safe integers. */
function grammatical(value: unknown, depth: number): boolean {
    if (typeof value === 'string') return PLAIN.test(value);
    if (typeof value === 'number')
        return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
    if (Array.isArray(value)) return depth < 4 && value.every((v) => grammatical(v, depth + 1));
    return false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* A lowercase hyphenated UUID, or refused. */
export function uuid(value: unknown, what: string) {
    if (typeof value !== 'string' || !UUID.test(value)) throw new CryptoError(`Invalid ${what}.`);
    return value;
}

/* An integer from 1 to 2^53 - 1, or refused. */
export function integer(value: unknown, what: string) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
        throw new CryptoError(`Invalid ${what}.`);
    return value;
}

/* Canonical base64url of exactly `length` bytes, returned as given, or refused. */
export function bytesOf(value: unknown, length: number, what: string) {
    if (typeof value !== 'string') throw new CryptoError(`Invalid ${what}.`);
    try {
        decode(value, length);
    } catch {
        throw new CryptoError(`Invalid ${what}.`);
    }
    return value;
}

/* A SHA-256 digest as a statement carries it: base64url of 32 bytes, never hex. */
export function digestOf(value: unknown, what: string) {
    return bytesOf(value, 32, what);
}

/* One of `allowed`, or refused. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
    if (typeof value !== 'string' || !allowed.includes(value as T))
        throw new CryptoError(`Invalid ${what}.`);
    return value as T;
}

/*
 * Strictly ascending, so neither order nor duplicates can vary. The values
 * are ASCII (ids and fixed words), whose UTF-16 order is their byte order.
 */
export function ascending(values: readonly string[], what: string) {
    for (let index = 1; index < values.length; index++)
        if (!(values[index - 1]! < values[index]!)) throw new CryptoError(`Invalid ${what}.`);
    return values;
}

export function encodeStatement(parts: readonly unknown[]) {
    if (!grammatical(parts, 0)) throw new CryptoError('Invalid statement.');
    const bytes = new TextEncoder().encode(JSON.stringify(parts));
    if (bytes.length > MAX_STATEMENT_BYTES) throw new CryptoError('Invalid statement.');
    return bytes;
}

/*
 * The JSON array a statement's bytes hold, or refused: too long, not UTF-8, a
 * byte-order mark, not JSON, outside the grammar, or not exactly the compact
 * encoding of what it holds.
 */
export function parseStatement(bytes: Uint8Array, what: string): unknown[] {
    if (bytes.length <= MAX_STATEMENT_BYTES)
        try {
            const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
            const parsed: unknown = JSON.parse(text);
            if (
                Array.isArray(parsed) &&
                grammatical(parsed, 0) &&
                sameBytes(new TextEncoder().encode(JSON.stringify(parsed)), bytes)
            )
                return parsed;
        } catch {
            // Refused below with the rest.
        }
    throw new CryptoError(`Invalid ${what}.`);
}

export function sameBytes(a: Uint8Array, b: Uint8Array) {
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!;
    return difference === 0;
}

/*
 * Refuses a statement whose bytes are not the canonical encoding of what was
 * parsed out of them: another spacing, key order, escape or number form. A
 * statement then has exactly one encoding, and two clients can never read the
 * same signed bytes differently.
 */
export function requireCanonical(served: Uint8Array, rebuilt: Uint8Array, what: string) {
    if (!sameBytes(served, rebuilt)) throw new CryptoError(`Invalid ${what}.`);
}
