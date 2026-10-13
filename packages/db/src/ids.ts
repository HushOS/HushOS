import { createHash } from 'node:crypto';

/*
 * Ids derived from a seed and a scope, as docs/integrity-design.md fixes them
 * ("Ids derived from a seed and a scope"): the server's own builder, beside
 * the statements in signatures.ts, rebuilt here rather than imported from the
 * client so a mistake on either side shows as a mismatch, not as agreement.
 *
 *   id = uuidv8(SHA-256(["hushos/id", 1, kind, scopeId, seed])[0..16])
 *
 * The scope is lowercased; the seed is 16 bytes, Base64url without padding.
 */

export type IdKind = 'node' | 'version' | 'object' | 'link' | 'report';
export const ID_SEED_BYTES = 16;
const SEED = /^[A-Za-z0-9_-]{22}$/;

/* The id `seed` derives for `kind` in `scopeId`, or null when the seed is not 16 canonical bytes. */
export function scopedId(kind: IdKind, scopeId: string, seed: string): string | null {
    if (!SEED.test(seed)) return null;
    const bytes = Buffer.from(seed, 'base64url');
    if (bytes.length !== ID_SEED_BYTES || bytes.toString('base64url') !== seed) return null;
    const digest = createHash('sha256')
        .update(JSON.stringify(['hushos/id', 1, kind, scopeId.toLowerCase(), seed]), 'utf8')
        .digest()
        .subarray(0, 16);
    digest[6] = (digest[6]! & 0x0f) | 0x80;
    digest[8] = (digest[8]! & 0x3f) | 0x80;
    const hex = digest.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* Whether `id` is the one `seed` derives for `kind` in `scopeId`; a missing seed never is. */
export function madeFor(
    kind: IdKind,
    scopeId: string,
    id: string,
    seed: string | null | undefined,
) {
    return typeof seed === 'string' && scopedId(kind, scopeId, seed) === id;
}
