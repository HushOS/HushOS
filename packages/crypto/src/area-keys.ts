import { CryptoError } from './errors';
import { encode } from './keys';

/*
 * Not in the package's exports: a client never builds an area row by hand.
 * nextRoster (group-trust.ts) computes the rows from the new keys; acceptance
 * refuses any commitment the chain listed before; the grant openers check a
 * key against the commitment the chain lists for that area and version.
 */
const AREA_COMMIT_INFO = 'hushos/group/area-key/v2';

/*
 * The commitment a roster lists for an area key (design 2.6): HKDF-SHA-256 of
 * the key, salt 32 zero bytes, info "hushos/group/area-key/v2", 32 bytes,
 * base64url. It depends on the key alone, so a repeat anywhere on the chain is
 * a key used before (acceptance refuses it, one HKDF per key and a set
 * lookup); the area and version it belongs to are where the roster lists it,
 * and a grant opens only to the key whose commitment is listed at its area and
 * version. It reveals nothing of the key but whether two keys are equal.
 */
export async function areaKeyCommitment(workspaceKey: Uint8Array) {
    if (!(workspaceKey instanceof Uint8Array) || workspaceKey.length !== 32)
        throw new CryptoError('Invalid workspace key.');
    const material = await crypto.subtle.importKey(
        'raw',
        Uint8Array.from(workspaceKey),
        'HKDF',
        false,
        ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new Uint8Array(32),
            info: new TextEncoder().encode(AREA_COMMIT_INFO),
        },
        material,
        256,
    );
    return encode(new Uint8Array(bits));
}
