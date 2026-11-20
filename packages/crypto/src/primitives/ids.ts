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
 *
 * Groups add two kinds (docs/groups-design.md 5): a `group` id is scoped to
 * the account that creates the group, and a `workspace` id (a group's area)
 * to its group, so neither can be made to collide with someone else's.
 */

export type IdKind = 'node' | 'version' | 'object' | 'link' | 'report';
/* Kept apart from IdKind, which Drive's code (and the server's twin) take as exactly its five. */
export type GroupIdKind = 'group' | 'workspace';
export const ID_SEED_BYTES = 16;
const KINDS: readonly (IdKind | GroupIdKind)[] = [
    'node',
    'version',
    'object',
    'link',
    'report',
    'group',
    'workspace',
];

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
 * reported item; for a group, the creating account; for a group's area, the
 * group.
 */
export async function deriveId(kind: IdKind | GroupIdKind, scopeId: string, seed: string) {
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
export async function newId(kind: IdKind | GroupIdKind, scopeId: string) {
    const seed = encode(crypto.getRandomValues(new Uint8Array(ID_SEED_BYTES)));
    return { id: await deriveId(kind, scopeId, seed), seed };
}

/*
 * Refuses an id that `seed` does not derive for `kind` in `scopeId`, with one
 * answer for every cause (a malformed seed, another scope, another kind), as
 * the server refuses it: a client never takes a group or area id it could not
 * derive itself.
 */
export async function checkId(
    kind: IdKind | GroupIdKind,
    scopeId: string,
    seed: string,
    id: string,
) {
    let derived: string | null = null;
    try {
        derived = await deriveId(kind, scopeId, seed);
    } catch {
        // Refused below with every other cause.
    }
    if (derived === null || derived !== id)
        throw new CryptoError('This id was not made for this workspace or group.');
    return id;
}
