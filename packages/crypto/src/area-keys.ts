import { uuid } from './canonical';
import { CryptoError } from './errors';
import type { RosterArea } from './groups';
import { encode } from './keys';

/*
 * Not in the package's exports: a client never builds an area row by hand.
 * nextRoster and firstRoster (group-trust.ts) compute the rows from the new
 * keys (rowsAfter); acceptance refuses any commitment the chain listed
 * before; the grant openers check a key against the commitment the chain
 * lists for that area and version.
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

/*
 * The rows a roster carries for new area keys (2.4, 2.6), after the
 * commitments `listed` already holds (a chain's areaKeys; nothing for roster
 * version 1): each key at its area's next version (1 for a new area), with
 * its commitment, sorted by workspace id. Refused when an area appears twice,
 * or a key's commitment repeats: two of the new keys alike, or any key listed
 * before, in any area at any version. Only commitments are kept, never copies
 * of the keys. areaRows (an accepted chain) and firstRoster (no chain yet)
 * are its only callers.
 */
export async function rowsAfter(
    listed: Readonly<Record<string, readonly string[]>>,
    keys: readonly { workspaceId: string; workspaceKey: Uint8Array }[],
): Promise<RosterArea[]> {
    if (!Array.isArray(keys)) throw new CryptoError('Invalid roster areas.');
    const areas = new Set<string>();
    for (const { workspaceId } of keys) {
        uuid(workspaceId, 'workspace id');
        if (areas.has(workspaceId)) throw new CryptoError('Invalid roster areas.');
        areas.add(workspaceId);
    }
    const before = new Set(Object.values(listed).flat());
    const fresh = new Set<string>();
    const rows: RosterArea[] = [];
    for (const { workspaceId, workspaceKey } of keys) {
        const commitment = await areaKeyCommitment(workspaceKey);
        if (before.has(commitment) || fresh.has(commitment)) throw new CryptoError(EARLIER_KEY);
        fresh.add(commitment);
        rows.push({
            workspaceId,
            workspaceKeyVersion:
                (Object.hasOwn(listed, workspaceId) ? listed[workspaceId]!.length : 0) + 1,
            commitment,
        });
    }
    return rows.sort((a, b) =>
        a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0,
    );
}

const EARLIER_KEY = 'This is one of the group’s earlier keys: a rotation needs a new one.';
