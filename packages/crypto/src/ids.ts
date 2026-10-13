import { CryptoError } from './errors';
import { decode, encode } from './keys';

/*
 * Ids derived from a seed and a scope (docs/integrity-design.md, "Ids derived
 * from a seed and a scope"). A client never names an id directly: it draws a
 * 16-byte seed and derives
 *
 *   id = uuidv8(SHA-256(["hushos/id", 1, kind, scopeId, seed])[0..16])
 *
 * with the statement in the canonical JSON of associated data (the scope
 * lowercased, the seed base64url without padding), the version nibble set to
 * 8 and the variant bits to 10. The server derives the id again from the
 * seed, the kind and the workspace of the request, so an id made for one
 * workspace cannot be asked about in another. `hushos-core` (ids.rs) derives
 * the same ids, pinned by the shared fixtures.
 */

export type IdKind = 'node' | 'version' | 'object' | 'link' | 'report';
export const ID_SEED_BYTES = 16;
const KINDS: readonly IdKind[] = ['node', 'version', 'object', 'link', 'report'];

function uuidV8(digest: Uint8Array) {
    const bytes = digest.slice(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x80;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/*
 * The id `seed` (base64url, exactly 16 bytes) derives for `kind` in `scopeId`:
 * the workspace the item is created in; for a report, the workspace of the
 * reported item.
 */
export async function deriveId(kind: IdKind, scopeId: string, seed: string) {
    if (!KINDS.includes(kind)) throw new CryptoError('Invalid id kind.');
    if (typeof scopeId !== 'string' || scopeId.length === 0)
        throw new CryptoError('Invalid scope id.');
    try {
        decode(seed, ID_SEED_BYTES);
    } catch {
        throw new CryptoError('Invalid id seed.');
    }
    const statement = new TextEncoder().encode(
        JSON.stringify(['hushos/id', 1, kind, scopeId.toLowerCase(), seed]),
    );
    return uuidV8(new Uint8Array(await crypto.subtle.digest('SHA-256', statement)));
}

/* A fresh id for `kind` in `scopeId`: a random seed (send it beside the id) and the id it derives. */
export async function newId(kind: IdKind, scopeId: string) {
    const seed = encode(crypto.getRandomValues(new Uint8Array(ID_SEED_BYTES)));
    return { id: await deriveId(kind, scopeId, seed), seed };
}
