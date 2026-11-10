import { uuid } from './canonical';
import { CryptoError } from './errors';
import type { RosterArea, RosterFormat } from './groups';
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
 * The area root's key commitment (design 2.10): its own label, so a root key
 * and an area key never share a commitment, even with equal bytes.
 */
const AREA_ROOT_COMMIT_INFO = 'hushos/group/area-root/v1';

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
    return commit(workspaceKey, AREA_COMMIT_INFO);
}

/*
 * The commitment a format 2 roster lists for an area root's node key at an
 * area version (design 2.10): HKDF-SHA-256 of the key, salt 32 zero bytes,
 * info "hushos/group/area-root/v1", 32 bytes, base64url. Of the key alone;
 * the root, area and version are where the roster lists it and what the
 * root's key envelope binds.
 */
export async function areaRootCommitment(rootKey: Uint8Array) {
    if (!(rootKey instanceof Uint8Array) || rootKey.length !== 32)
        throw new CryptoError('Invalid area root key.');
    return commit(rootKey, AREA_ROOT_COMMIT_INFO);
}

async function commit(key: Uint8Array, info: string) {
    const material = await crypto.subtle.importKey('raw', Uint8Array.from(key), 'HKDF', false, [
        'deriveBits',
    ]);
    const bits = await crypto.subtle.deriveBits(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new Uint8Array(32),
            info: new TextEncoder().encode(info),
        },
        material,
        256,
    );
    return encode(new Uint8Array(bits));
}

/* What a chain has listed so far, as the rows that come next must follow it. */
export type ListedAreas = {
    /* Every area key commitment, by area, version 1 first (AcceptedRosters.areaKeys). */
    keys: Readonly<Record<string, readonly string[]>>;
    /* Every root commitment, by area, version 1 first, null for format 1 rows. */
    roots: Readonly<Record<string, readonly (string | null)[]>>;
    /* The retired areas. */
    retired: readonly string[];
};

export const NOTHING_LISTED: ListedAreas = { keys: {}, roots: {}, retired: [] };

/*
 * The rows a roster carries for new area keys and retirements (2.4, 2.6,
 * 2.10), after what `listed` already holds (a chain's; nothing for roster
 * version 1): each key at its area's next version (1 for a new area), with
 * its commitment and, in format 2, its root key's commitment; each retired
 * area at its next version with no key; sorted by workspace id. Refused when
 * an area appears twice, a key's commitment or a root key's commitment
 * repeats (two of the new ones alike, or any listed before, in any area at
 * any version), a retired area gets a key or a second tombstone, an area the
 * chain never listed is retired, format 2 lacks a root key or format 1 is
 * given one or a retirement. Only commitments are kept, never copies of the
 * keys. areaRows (an accepted chain) and firstRoster (no chain yet) are its
 * only callers.
 */
export async function rowsAfter(
    listed: ListedAreas,
    keys: readonly { workspaceId: string; workspaceKey: Uint8Array; rootKey?: Uint8Array }[],
    format: RosterFormat,
    retire: readonly string[] = [],
): Promise<RosterArea[]> {
    if (!Array.isArray(keys) || !Array.isArray(retire))
        throw new CryptoError('Invalid roster areas.');
    if (format === 1 && retire.length > 0) throw new CryptoError(OLD_FORMAT);
    const retired = new Set(listed.retired);
    const areas = new Set<string>();
    for (const workspaceId of [...keys.map((key) => key.workspaceId), ...retire]) {
        uuid(workspaceId, 'workspace id');
        if (areas.has(workspaceId)) throw new CryptoError('Invalid roster areas.');
        if (retired.has(workspaceId)) throw new CryptoError(RETIRED);
        areas.add(workspaceId);
    }
    const versions = (workspaceId: string) =>
        Object.hasOwn(listed.keys, workspaceId) ? listed.keys[workspaceId]!.length : 0;
    const before = new Set(Object.values(listed.keys).flat());
    const rootsBefore = new Set(
        Object.values(listed.roots)
            .flat()
            .filter((at) => at !== null),
    );
    const fresh = new Set<string>();
    const freshRoots = new Set<string>();
    const rows: RosterArea[] = [];
    for (const { workspaceId, workspaceKey, rootKey } of keys) {
        if ((format === 1) !== (rootKey === undefined))
            throw new CryptoError(format === 1 ? OLD_FORMAT : NO_ROOT_KEY);
        const commitment = await areaKeyCommitment(workspaceKey);
        if (before.has(commitment) || fresh.has(commitment)) throw new CryptoError(EARLIER_KEY);
        fresh.add(commitment);
        const row: RosterArea = {
            workspaceId,
            workspaceKeyVersion: versions(workspaceId) + 1,
            commitment,
        };
        if (rootKey !== undefined) {
            const rootCommitment = await areaRootCommitment(rootKey);
            if (rootsBefore.has(rootCommitment) || freshRoots.has(rootCommitment))
                throw new CryptoError(EARLIER_ROOT);
            freshRoots.add(rootCommitment);
            row.rootCommitment = rootCommitment;
        }
        rows.push(row);
    }
    for (const workspaceId of retire) {
        if (versions(workspaceId) === 0) throw new CryptoError(NOT_AN_AREA);
        rows.push({
            workspaceId,
            workspaceKeyVersion: versions(workspaceId) + 1,
            commitment: '',
            retired: true,
        });
    }
    return rows.sort((a, b) =>
        a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0,
    );
}

const EARLIER_KEY = 'This is one of the group’s earlier keys: a rotation needs a new one.';
const EARLIER_ROOT = 'This folder key was used before: a rotation needs a new one.';
const NO_ROOT_KEY = 'A new area key needs its folder’s key beside it.';
const OLD_FORMAT = 'This member list format has no folder keys or deleted folders.';
const NOT_AN_AREA = 'This folder is not one of the group’s.';
export const RETIRED = 'This family folder was deleted: it cannot be used again.';
