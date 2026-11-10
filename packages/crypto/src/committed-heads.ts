import type { HeadRow } from './area-lists';
import { CryptoError } from './errors';

/*
 * The heads a roster's signer commits to (docs/companies-design.md 2.3, "A
 * signer's device commits the heads it verified"), as headsToCommit
 * (area-lists.ts) builds them from the folders the device read, and as
 * nextRoster and firstRoster (group-trust.ts) take them: only an object made
 * here is taken, so a digest of a caller's own making signs no roster. Not
 * exported from the package.
 */
export type CommittedHeads = {
    readonly groupId: string;
    /* The roster they were built on (0 before roster 1); null for heads no device verified (unverifiedHeads). */
    readonly rosterVersion: number | null;
    /* Every live area after the roster, sorted by workspace id. */
    readonly rows: readonly HeadRow[];
    readonly headsDigest: string;
    /* The base lists of the areas the roster creates or rotates, and the areas it retires: its rows are exactly those. */
    readonly changed: readonly {
        workspaceId: string;
        workspaceKeyVersion: number;
        listDigest: string;
    }[];
    readonly retired: readonly string[];
};

export const NOT_BUILT =
    'A member list’s heads are the ones this device built from the folders it verified.';

const built = new WeakSet<object>();

export function markCommittedHeads(heads: CommittedHeads): CommittedHeads {
    built.add(Object.freeze(heads));
    return heads;
}

export function requireCommittedHeads(heads: unknown): CommittedHeads {
    if (typeof heads !== 'object' || heads === null || !built.has(heads))
        throw new CryptoError(NOT_BUILT);
    return heads as CommittedHeads;
}

/*
 * Heads no device verified, by their digest alone: for the tests and fuzzers
 * that build rosters over histories whose folders have no lists. Never for an
 * app: a roster signed over them commits to nothing anyone read.
 */
export function unverifiedHeads(headsDigest: string): CommittedHeads {
    return markCommittedHeads({
        groupId: '',
        rosterVersion: null,
        rows: [],
        headsDigest,
        changed: [],
        retired: [],
    });
}
