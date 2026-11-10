import {
    deepFreeze,
    markAccepted,
    markStored,
    requireAccepted,
    requireStoredOrAccepted,
    STORED_ACCEPTANCE,
} from './accepted';
import { NOTHING_LISTED, RETIRED, rowsAfter } from './area-keys';
import { ascending, bytesOf, digestOf, integer, uuid } from './canonical';
import { CryptoError } from './errors';
import {
    digestBase64url,
    digestHex,
    fingerprint,
    fingerprintWords,
    keyDigest,
    sameKeyDigest,
} from './fingerprint';
import {
    activeWith,
    MAX_FAMILY_AREAS,
    areaRows,
    groupKeyDigest,
    parseGroupSuccession,
    parseRoster,
    rosterDigest,
    rosterEntry,
    rosterFormat,
    rosterStatement,
    sameGroupKey,
    verifyGroup,
    type AreaKey,
    type RosterFormat,
    type GroupKeySuccession,
    type GroupKind,
    type GroupPublicKey,
    type GroupRole,
    type Roster,
    type RosterMember,
    type SignedGroupStatement,
} from './groups';
import {
    verifyIdentityKeys,
    type PinnedKeys,
    type ServedKeys,
    type SuccessionLink,
} from './identity';
import { decode, encode } from './keys';
import { checkGroupPin, checkTime, pinTrust, type GroupPin } from './pins';
import { successionPath } from './succession-path';
import { ML_DSA_PUBLIC_KEY_BYTES } from './pq';
import type { ContactPin } from './contacts';
import {
    digest,
    integrityOf,
    rekeyedChecks,
    verifyHybrid,
    type Integrity,
    type RekeyedRecord,
    type StatementForms,
    type TrustedSigner,
} from './signatures';

/*
 * What a member's device accepts as a group's history, and what it shows for
 * the records in a group's areas (docs/groups-design.md 2.4, 2.5, 2.7, 2.8):
 * - acceptRosters verifies the roster chain the server serves from version 1
 *   (or from the device's own cache of it), each roster under the group key
 *   current at that point and signed by a `members` holder of the roster
 *   before it; the person's own marks (pins and cache) must agree with each
 *   other and with it, or it is a fork, the one hard warning;
 * - checkNextRoster and checkNextSuccession are acceptance itself, continued
 *   from an accepted chain by one statement: clients run them before signing
 *   (nextRoster applies the same roster rules, and firstRoster those of
 *   roster version 1), and the server must run them before storing;
 * - groupWriterTrust and groupIntegrityOf give the scoped verdicts: a roster
 *   vouches only inside its own group's areas;
 * - newRosterEntry, foldInEntry and trustAsGroupDoes move keys between
 *   personal pins and roster entries only after the checks that let them;
 *   ownRosterEntry makes a creator's own entry.
 * `hushos-core` (group_trust.rs) gives the same answers.
 */

/*
 * The type of what acceptRosters returns carries a symbol this module never
 * exports, so it cannot be written out by hand; at runtime only the frozen
 * objects acceptRosters made are taken (accepted.ts), so a copy with a field
 * swapped is refused too.
 */
const ACCEPTED: unique symbol = Symbol('accepted rosters');
/*
 * The type of what the server's acceptance returns (acceptStoredChain,
 * checkNextRoster, checkNextSuccession): the same fields under another brand,
 * registered apart (accepted.ts). No seal, opening or verdict takes it (a type
 * error, and refused at runtime): it anchors on what the server stored, with
 * no words check and no marks.
 */
const STORED: unique symbol = Symbol('stored rosters');

/* A member's keys as an entry names them: what a succession chain starts from. */
export type KeySet = {
    encryptionPublicKey: string;
    signingPublicKey: string;
    mlDsaPublicKeyDigest: string;
};

/*
 * What a device keeps of a chain it verified, so the next sync continues
 * from it instead of from version 1. Its own record (local, never synced):
 * the served chain must extend it, and every digest in it is one of the
 * person's marks. Bound to its group and to the roster it is through: the
 * last of `rosterDigests` (one per version, version 1 first) is the digest
 * of `statement`, whose version is their count.
 */
export type GroupChainCache = {
    groupId: string;
    rosterDigests: string[];
    /* The last roster's statement (base64url), and whether it took a `members` holder away. */
    statement: string;
    droppedHolder: boolean;
    /* Every group key, version 1 first, and every succession, from key 1 on: its tie, digest and signer. */
    groupKeys: GroupPublicKey[];
    successions: { lastRosterVersion: number; digest: string; signerUserId: string }[];
    creatorUserId: string;
    /* Every key set each member's entries named, oldest first. */
    keyHistory: Record<string, KeySet[]>;
    /* Every commitment each area's rows named, version 1 first. */
    areaKeys: Record<string, string[]>;
    /*
     * Every root commitment each area's key rows named, beside areaKeys, null
     * for a format 1 row (design 2.10). Absent in a cache from before format
     * 2, which then had none.
     */
    areaRoots?: Record<string, (string | null)[]>;
    /* The areas the chain retired, sorted (design 2.10). Absent before format 2: none. */
    retiredAreas?: string[];
    /*
     * The cache's own format: 2 (CACHE_VERSION) carries areaRoots and retiredAreas;
     * absent is a cache written before format 2, which carries neither.
     */
    cacheVersion?: number;
    ownEntryWrongAt: number[];
    /* A device's own cache never has an origin; the server's record says 'server' (StoredChainCache). */
    origin?: undefined;
};

/*
 * The server's record of the history it stores, from a StoredChain
 * (storedRecord, in the server entry). Marked as the server's, so a reader's
 * acceptance refuses it as a cache, by type and at run time: the server's
 * record anchors on no words check and no marks of the reader's.
 */
export type StoredChainCache = Omit<GroupChainCache, 'origin'> & { readonly origin: 'server' };

/* A roster chain verified from version 1, with the group keys behind it. Frozen. */
export type AcceptedRosters = ChainBody & {
    readonly [ACCEPTED]: true;
    readonly status: 'accepted';
};
/*
 * The server's acceptance of what it stores: never a reader's (see STORED).
 * Frozen. Its record to continue from is not on it: only the server entry's
 * storedRecord gives it, as a StoredChainCache no reader takes.
 */
export type StoredChain = Omit<ChainBody, 'cache'> & {
    readonly [STORED]: true;
    readonly status: 'stored';
};
type ChainBody = {
    readonly groupId: string;
    readonly kind: GroupKind;
    readonly roster: Roster;
    readonly statement: Uint8Array;
    readonly rosterDigest: string;
    /* Every roster's digest, version 1 first: what a pin's mark is checked against. */
    readonly rosterDigests: readonly string[];
    /* The latest roster took a `members` holder away: it is the last under its key. */
    readonly droppedHolder: boolean;
    /* The group key now: the highest version the verified successions reach. */
    readonly groupKeyVersion: number;
    readonly groupKey: GroupPublicKey;
    readonly groupKeyDigest: string;
    /* Every group key, version 1 first, each succession checked in full. */
    readonly groupKeys: readonly GroupPublicKey[];
    /* The signer of roster version 1. */
    readonly creatorUserId: string;
    /* The latest roster dropped a `members` holder, and no succession has followed yet. */
    readonly successionDue: boolean;
    /*
     * Every key set each member's entries named, oldest first. A key here is
     * never trusted for being here: only the first set (the one a words check
     * admitted) starts the succession chains a reader relying on the roster, or
     * a seal's opener, follows to the member's served identity.
     */
    readonly keyHistory: Readonly<Record<string, readonly KeySet[]>>;
    /*
     * Every area key commitment the chain's rosters listed, by area, version 1
     * first, folded from their delta rows (each roster carries only the areas
     * it creates or rotates): a grant of any version, an earlier one included
     * (a key a reader needs for older files), is checked against the
     * commitment the roster that introduced it listed.
     */
    readonly areaKeys: Readonly<Record<string, readonly string[]>>;
    /*
     * Every area root commitment, beside areaKeys (design 2.10): what the
     * root's key at that area version must commit to, or null for a version
     * a format 1 roster listed. checkAreaRoot reads it.
     */
    readonly areaRoots: Readonly<Record<string, readonly (string | null)[]>>;
    /* The areas the chain retired (tombstones, design 2.10), sorted: never written, granted or rotated again. */
    readonly retiredAreas: readonly string[];
    /*
     * The roster versions whose entry for the reader named none of the
     * reader's own identities: a hard warning, even when a later roster put it
     * right again.
     */
    readonly ownEntryWrongAt: readonly number[];
    /*
     * The roster versions, among those this acceptance added, at which the
     * reader's entry changed to one of their own identities older than their
     * newest: a soft note (a holder folded in a replaced identity, or the
     * reader rotated just after a fold-in). Not kept in the cache: it is
     * reported by the acceptance that adds the roster.
     */
    readonly ownEntryBehindAt: readonly number[];
    /*
     * Rosters the server served that are not on the accepted chain, by
     * version and the signer they name (unverified): dead branches, such as a
     * removed holder's rival or a roster the server never stored. A note,
     * never a warning, and never anyone's fault on its own.
     */
    readonly deadBranches: readonly { version: number; signerUserId: string }[];
    /* What to keep locally and pass back next time. */
    readonly cache: GroupChainCache;
    /*
     * Whether this person vouched for the family in this acceptance, and
     * through which roster (docs/optional-verification.md 3.3): they created
     * it, compared a join code, or compared a pair code with another member
     * (a pair mark held). Worked out by acceptance from its anchor and the
     * marks, never passed in; null for a first-use chain and for one accepted
     * on marks alone. Not kept in the cache.
     */
    readonly checked: FamilyChecked | null;
};

/*
 * What vouches for a family's version 1 keys when nothing marks it on this
 * device (docs/optional-verification.md 3.3), replacing `firstKeysChecked`:
 * - created: the worker holds the seed of this creation, and the served first
 *   keys are its public key;
 * - join: the join code the person compared (the join mark, which then must
 *   be given), the chain passing through its roster;
 * - first-use: nothing; the served keys are taken because nothing contradicts
 *   them, only on the join path, only with no mark at all, and only for an
 *   account whose own entry is active at the head of the served chain.
 * With any mark the marks decide the version 1 keys and an anchor vouches for
 * nothing; with no mark and no anchor nothing is accepted.
 */
export type GroupAnchor = 'created' | 'join' | 'first-use';

/*
 * A family check this person made (docs/optional-verification.md 3.4): the
 * pair code they compared with member `with` over the roster at
 * `rosterVersion`. Held as a mark: the chain must hold a roster there over
 * which the pair code of this account and `with` is `code`, else the hard
 * warning, and a chain short of it is a rollback. Never a join mark.
 */
export type PairMark = { rosterVersion: number; with: string; code: string[] };

/* How a family was vouched for in an acceptance, and through which roster (AcceptedRosters.checked). */
export type FamilyChecked = { how: 'created' | 'join' | 'compared'; rosterVersion: number };

/* One side of a conflict between marks: a digest, who holds it, and the signer of its statement when known. */
export type MarkSide = {
    digest: string;
    from: ('pin' | 'cache' | 'join' | 'pair' | 'served')[];
    signerUserId: string | null;
};
/*
 * This person's own marks (the pins their devices wrote, this device's
 * cache) disagree with each other, or with the chain the server serves: a
 * roster (or group key) at `version` with two digests. The hard warning
 * "Acme's member list was shown differently to you"; roster verdicts drop to
 * personal checks until the group's words are checked again. Every side is
 * named, sorted by digest; none is the culprit.
 */
export type RosterFork = {
    status: 'fork';
    of: 'roster' | 'group-key';
    version: number;
    sides: MarkSide[];
};
export type RosterChain = AcceptedRosters | RosterFork;

class Fork extends Error {
    constructor(readonly fork: RosterFork) {
        super('fork');
    }
}

type Held = { roster: Roster; statement: Uint8Array; digest: string; droppedHolder: boolean };
type Verified = { lastRosterVersion: number; digest: string; signerUserId: string };
/* A served statement and every distinct copy of its signatures. */
type Served<T> = {
    value: T;
    statement: Uint8Array;
    digest: string;
    copies: SignedGroupStatement[];
};

/* Whether `next` takes away a `members` holder of `previous`: marked left, or the role removed. */
function dropsHolder(previous: Roster, next: Roster) {
    return previous.members.some(
        (entry) =>
            activeWith(entry, 'members') && !activeWith(rosterEntry(next, entry.userId), 'members'),
    );
}

function sameKeys(a: RosterMember, b: RosterMember) {
    return (
        a.keyVersion === b.keyVersion &&
        a.encryptionPublicKey === b.encryptionPublicKey &&
        a.signingPublicKey === b.signingPublicKey &&
        a.mlDsaPublicKeyDigest === b.mlDsaPublicKeyDigest &&
        a.kemPublicKeyDigest === b.kemPublicKeyDigest
    );
}
function sameEntry(a: RosterMember, b: RosterMember) {
    return sameKeys(a, b) && a.status === b.status && a.roles.join() === b.roles.join();
}

/*
 * The entry rules (2.4): entries never disappear (former members stay,
 * marked `left`), and each entry's `sinceVersion` is the version it last
 * changed at. A roster's keys for a member are a holder's claim, nothing
 * more: what each reader trusts follows from the member's own succession
 * chain and the words checks (2.8), and the server checks every changed
 * entry against the member's served identities before storing (4).
 */
function checkEntries(previous: Roster, next: Roster) {
    const refuse = () => {
        throw new CryptoError('This member list does not follow from the one before.');
    };
    for (const entry of previous.members) if (!rosterEntry(next, entry.userId)) refuse();
    for (const entry of next.members) {
        const before = rosterEntry(previous, entry.userId);
        const since = before && sameEntry(before, entry) ? before.sinceVersion : next.rosterVersion;
        if (entry.sinceVersion !== since) refuse();
    }
}

const NOT_ROTATED = 'A roster that removes a family member rotates every area.';
const ADMITS_ON_REMOVAL = 'No one is admitted on the roster that removes a key holder.';
const TOO_MANY_AREAS = 'A family has at most 1,024 areas.';
const REUSED_KEY = 'This area key was used before: a rotation needs a new one.';
const REUSED_ROOT = 'This folder key was used before: a rotation needs a new one.';
const DOWNGRADE = 'This member list is in an older format than the one before it.';
/* The cache format this core writes (GroupChainCache.cacheVersion): root commitments and retired areas. */
const CACHE_VERSION = 2;
const NOT_FOLLOWING_AREAS = 'This member list does not follow from the one before.';

/*
 * What the chain has listed of its areas so far (2.4, 2.6, 2.10), folded from
 * the held rosters' rows: every key and root commitment by area, version 1
 * first (null roots for format 1 rows), the retired areas, and every key and
 * root commitment of any area, so a repeat is one set lookup.
 */
type AreaLedger = {
    keys: Map<string, string[]>;
    roots: Map<string, (string | null)[]>;
    retired: Set<string>;
    commitments: Set<string>;
    rootCommitments: Set<string>;
};

function ledgerOf(cached: Cached | null): AreaLedger {
    const roots = new Map(
        Object.entries(cached?.areaRoots ?? {}).map(([id, list]) => [id, [...list]]),
    );
    return {
        keys: new Map(Object.entries(cached?.areaKeys ?? {}).map(([id, list]) => [id, [...list]])),
        roots,
        retired: new Set(cached?.retiredAreas ?? []),
        commitments: new Set(Object.values(cached?.areaKeys ?? {}).flat()),
        rootCommitments: new Set(
            [...roots.values()].flat().filter((at): at is string => at !== null),
        ),
    };
}

/*
 * The area rows and what a removal asks (2.4, 2.6, 2.10). Each key row a
 * roster carries is a new area at version 1, or a rotation one above the
 * area's latest version on the chain, so every version of every area is
 * listed exactly once, and its commitment (of the key alone) is one the chain
 * never listed before, in any area; in format 2 so is its root commitment. A
 * retirement row stands at the next version of an area the chain lists, and
 * after it nothing more is listed for that area. A chain never goes back to
 * format 1 after a format 2 roster. In a family, where every member opens
 * every area, a roster that marks anyone `left` rotates every live area in
 * the same statement (one it retires counts): a device that knows of the
 * removal knows of the rotation. A family lists at most MAX_FAMILY_AREAS live
 * areas. And no roster both removes a `members` holder and admits anyone: the
 * admission waits for the roster after the succession, under a key the
 * removed holder never held (the join mark's coverage, 2.4).
 */
function checkAreas(ledger: AreaLedger, previous: Roster | undefined, next: Roster) {
    if (previous && rosterFormat(next) < rosterFormat(previous)) throw new CryptoError(DOWNGRADE);
    const rows = next.areas ?? [];
    for (const row of rows) {
        // A retired area is spent for good: nothing more is listed for it, a tombstone included.
        if (ledger.retired.has(row.workspaceId)) throw new CryptoError(RETIRED);
        const versions = ledger.keys.get(row.workspaceId)?.length ?? 0;
        if (row.workspaceKeyVersion !== versions + 1 || (row.retired && versions === 0))
            throw new CryptoError(NOT_FOLLOWING_AREAS);
    }
    // A commitment depends on the key alone: one listed before, in any area, or twice in this
    // roster, is a key used before, and a rotation to it rotates nothing. The same for a root's.
    const fresh = new Set<string>();
    const freshRoots = new Set<string>();
    for (const row of rows) {
        if (row.retired) continue;
        if (ledger.commitments.has(row.commitment) || fresh.has(row.commitment))
            throw new CryptoError(REUSED_KEY);
        fresh.add(row.commitment);
        if (row.rootCommitment === undefined) continue;
        if (ledger.rootCommitments.has(row.rootCommitment) || freshRoots.has(row.rootCommitment))
            throw new CryptoError(REUSED_ROOT);
        freshRoots.add(row.rootCommitment);
    }
    // A family's removal rotates every live area in one roster, so the live areas stay within one
    // roster: those listed and not retired, after this roster's new areas and tombstones.
    const created = rows.filter((row) => !ledger.keys.has(row.workspaceId)).length;
    const retiring = rows.filter((row) => row.retired).length;
    if (
        next.kind === 'family' &&
        ledger.keys.size - ledger.retired.size + created - retiring > MAX_FAMILY_AREAS
    )
        throw new CryptoError(TOO_MANY_AREAS);
    if (!previous) return;
    const leaving = next.members.some(
        (entry) =>
            entry.status === 'left' && rosterEntry(previous, entry.userId)?.status === 'active',
    );
    if (next.kind === 'family' && leaving) {
        const handled = new Set(rows.map((row) => row.workspaceId));
        for (const workspaceId of ledger.keys.keys())
            if (!ledger.retired.has(workspaceId) && !handled.has(workspaceId))
                throw new CryptoError(NOT_ROTATED);
    }
    const admits = next.members.some(
        (entry) =>
            entry.status === 'active' && rosterEntry(previous, entry.userId)?.status !== 'active',
    );
    if (admits && dropsHolder(previous, next)) throw new CryptoError(ADMITS_ON_REMOVAL);
}

/* Folds a held roster's area rows into the ledger (checkAreas saw to their versions). */
function foldAreas(ledger: AreaLedger, roster: Roster) {
    for (const row of roster.areas ?? []) {
        if (row.retired) {
            ledger.retired.add(row.workspaceId);
            continue;
        }
        const keys = ledger.keys.get(row.workspaceId) ?? [];
        keys.push(row.commitment);
        ledger.keys.set(row.workspaceId, keys);
        const roots = ledger.roots.get(row.workspaceId) ?? [];
        roots.push(row.rootCommitment ?? null);
        ledger.roots.set(row.workspaceId, roots);
        ledger.commitments.add(row.commitment);
        if (row.rootCommitment !== undefined) ledger.rootCommitments.add(row.rootCommitment);
    }
}

/*
 * Whether `signed` carries `signerUserId`'s hybrid identity signature under
 * their entry on `authority`: the Ed25519 key it names, and the served
 * ML-DSA key whose SHA-256 is its digest (`mlDsaKeys` is keyed by that
 * digest, so a signer whose identity changed along the chain is checked under
 * the right key at each point).
 *
 * A roster is checked against the signer's entry on the roster before it, so
 * a member who replaced their identity and signs the roster that folds it in
 * signs with their previous keys. That works because an account keeps every
 * earlier identity's private keys after a succession (they still open shares
 * sealed to them); a client that dropped them could not sign that roster.
 */
async function signedByMember(
    authority: Roster,
    signerUserId: string,
    signed: SignedGroupStatement,
    mlDsaKeys: Record<string, string>,
) {
    const entry = rosterEntry(authority, signerUserId);
    if (!entry) return false;
    try {
        const mlDsaPublicKey = decode(
            mlDsaKeys[entry.mlDsaPublicKeyDigest] ?? '',
            ML_DSA_PUBLIC_KEY_BYTES,
        );
        return (
            (await digest(mlDsaPublicKey)) === entry.mlDsaPublicKeyDigest &&
            (await verifyHybrid(signed.statement, signed.signerSignature, {
                signingPublicKey: decode(entry.signingPublicKey, 32),
                mlDsaPublicKey,
            }))
        );
    } catch {
        return false;
    }
}

async function mlDsaDigest(publicKey: string) {
    try {
        return await digest(decode(publicKey, ML_DSA_PUBLIC_KEY_BYTES));
    } catch {
        return null;
    }
}

/* Whether the served identity is exactly the one an entry names: X25519, Ed25519, both digests, key version. */
export async function servedIsEntry(served: ServedKeys, entry: RosterMember) {
    return served.keyVersion === entry.keyVersion && (await servedKeysAreEntry(served, entry));
}

/*
 * Whether the served identity's four keys are the ones an entry names, its key
 * version aside: for a served identity whose keys statement was not checked,
 * whose version is then only the server's word.
 */
async function servedKeysAreEntry(served: ServedKeys, entry: RosterMember) {
    try {
        return (
            served.encryptionPublicKey === entry.encryptionPublicKey &&
            served.signingPublicKey === entry.signingPublicKey &&
            (await digest(decode(served.mlDsaPublicKey, ML_DSA_PUBLIC_KEY_BYTES))) ===
                entry.mlDsaPublicKeyDigest &&
            (await digest(decode(served.kemPublicKey, 1184))) === entry.kemPublicKeyDigest
        );
    } catch {
        return false;
    }
}

/* What every acceptance takes, its anchor, reader and cache aside. */
type AcceptBase = {
    groupId: string;
    firstKeys: GroupPublicKey;
    pins: GroupPin[];
    rosters: SignedGroupStatement[];
    successions: SignedGroupStatement[];
    mlDsaKeys: Record<string, string>;
    /* The join code a newcomer compared with the admitting admin's screen (2.4, 3.2): with anchor `join`, or beside marks. */
    joinMark?: JoinMark | null;
    /* The family checks this person made (familyChecks in the settings), each a mark. */
    pairMarks?: PairMark[] | null;
};
export type AcceptInput = AcceptBase & {
    /* What vouches for `firstKeys` when nothing marks the family (GroupAnchor), or null. */
    anchor: GroupAnchor | null;
    me: { userId: string; identities: ServedKeys[] };
    cache: GroupChainCache | null;
};

/*
 * What a newcomer's join code comparison fixes about the roster that admitted
 * them: its version and a twelve-word code (joinCode, 132 bits) over its
 * digest, the group key it is under and that key's version. Acceptance holds
 * it as one of the person's marks: the verified chain must pass through a
 * roster at that version whose code is these words, or it is the hard
 * warning; a chain short of it is a rollback, refused. At 132 bits nothing a
 * holder can vary (a roster's free fields, an Ed25519 half of a key) can be
 * ground to match. It covers an admission after the branch point under a key
 * the removed holder lacks; no roster both removes a holder and admits anyone
 * (checkAreas), so a removal's own roster never admits.
 */
export type JoinMark = { rosterVersion: number; code: string[] };

const twelveWords = (code: unknown): code is string[] =>
    Array.isArray(code) &&
    code.length === 12 &&
    code.every((word) => typeof word === 'string' && /^[a-z]{3,8}$/.test(word));

function checkJoinMark(mark: JoinMark) {
    // A pair mark (it names the member compared with) is never a join mark: the two codes have
    // their own domains, and neither may stand for the other.
    if (
        typeof mark !== 'object' ||
        mark === null ||
        Object.hasOwn(mark, 'with') ||
        !twelveWords(mark.code)
    )
        throw new CryptoError('Invalid join mark.');
    return { rosterVersion: integer(mark.rosterVersion, 'join mark'), code: [...mark.code] };
}

/* A pair mark as acceptance takes it (the user id a uuid, the code twelve words), or refused; the fuzz kind `settings` reads check records through it. */
export function checkPairMark(mark: PairMark) {
    if (
        typeof mark !== 'object' ||
        mark === null ||
        typeof mark.with !== 'string' ||
        !twelveWords(mark.code)
    )
        throw new CryptoError('Invalid pair mark.');
    return {
        rosterVersion: integer(mark.rosterVersion, 'pair mark'),
        with: uuid(mark.with, 'user id'),
        code: [...mark.code],
    };
}

/*
 * The join code an admitting admin's client shows over the roster it signed
 * (2.4, 3.2): the first 160 bits of SHA-256("hushos/group/join-code/v1" ||
 * rosterDigest || groupKeyDigest || groupKeyVersion as 8 bytes big-endian),
 * as fingerprintWords reads them (twelve words, 132 bits). rosterDigest is
 * the 32 bytes its base64url names; groupKeyDigest is groupKeyDigest of the
 * key the roster is under (SHA-256 of its Ed25519 key followed by its whole
 * ML-DSA key), never a pin's first-keys digest.
 */
const JOIN_CODE_DOMAIN = 'hushos/group/join-code/v1';

export async function joinCode(
    rosterDigest: string,
    groupKey: GroupPublicKey,
    groupKeyVersion: number,
): Promise<string[]> {
    const domain = new TextEncoder().encode(JOIN_CODE_DOMAIN);
    const input = new Uint8Array(domain.length + 72);
    input.set(domain);
    input.set(decode(digestOf(rosterDigest, 'roster digest'), 32), domain.length);
    input.set(decode(await groupKeyDigest(groupKey), 32), domain.length + 32);
    new DataView(input.buffer).setBigUint64(
        domain.length + 64,
        BigInt(integer(groupKeyVersion, 'group key version')),
    );
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    return fingerprintWords(
        Array.from(hash.subarray(0, 20), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    );
}

/*
 * The pair code two members compare to check each other and their view of
 * the family (docs/optional-verification.md 3.4): the first 160 bits of
 * SHA-256("hushos/group/pair-code/v1" || rosterDigest || groupKeyDigest ||
 * groupKeyVersion as 8 bytes big-endian || lowerId || higherId), read as the
 * join code is (twelve words, 132 bits). The ids are the two lowercase
 * account ids, sorted, 36 ASCII bytes each: with the roster alone every pair
 * a later member is part of would share one code, so a server labelling a
 * planted entry with another member's name could borrow a match. Its own
 * domain: a pair code never stands for a join code, nor the reverse. Two
 * equal ids are refused. The Rust core's `pair_code_of` gives the same words.
 */
const PAIR_CODE_DOMAIN = 'hushos/group/pair-code/v1';

export async function pairCodeOf(
    rosterDigest: string,
    groupKey: GroupPublicKey,
    groupKeyVersion: number,
    userId: string,
    otherUserId: string,
): Promise<string[]> {
    const ids = [uuid(userId, 'user id'), uuid(otherUserId, 'user id')].sort();
    if (ids[0] === ids[1]) throw new CryptoError('A pair code is between two members.');
    const text = new TextEncoder();
    const domain = text.encode(PAIR_CODE_DOMAIN);
    const input = new Uint8Array(domain.length + 72 + 72);
    input.set(domain);
    input.set(decode(digestOf(rosterDigest, 'roster digest'), 32), domain.length);
    input.set(decode(await groupKeyDigest(groupKey), 32), domain.length + 32);
    new DataView(input.buffer).setBigUint64(
        domain.length + 64,
        BigInt(integer(groupKeyVersion, 'group key version')),
    );
    input.set(text.encode(ids[0]!), domain.length + 72);
    input.set(text.encode(ids[1]!), domain.length + 108);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    return fingerprintWords(
        Array.from(hash.subarray(0, 20), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    );
}

/* The group key version the roster at `version` is under: one above every succession tied to an earlier roster. */
function keyVersionAt(successions: Iterable<{ lastRosterVersion: number }>, version: number) {
    let keyVersion = 1;
    for (const out of successions) if (out.lastRosterVersion < version) keyVersion++;
    return keyVersion;
}

/*
 * The pair code of this account and `otherUserId` over the roster at
 * `version` on an accepted chain, under the group key it is under. Checks no
 * entry: the chain-level pairCode (session-groups.ts) is what a screen shows.
 */
export async function pairCodeAt(
    chain: AcceptedRosters,
    version: number,
    userId: string,
    otherUserId: string,
) {
    requireAccepted(chain);
    if (!Number.isSafeInteger(version) || version < 1 || version > chain.rosterDigests.length)
        throw new CryptoError('This member list is not on the family’s history.');
    const keyVersion = keyVersionAt(chain.cache.successions, version);
    return pairCodeOf(
        chain.rosterDigests[version - 1]!,
        chain.groupKeys[keyVersion - 1]!,
        keyVersion,
        userId,
        otherUserId,
    );
}

/*
 * Accepts a group's roster chain (2.4, 2.5, 2.7):
 * - `firstKeys` are the version 1 group keys as served. They must be the ones
 *   every pin and the cache name; with neither, `anchor` must vouch for them
 *   (GroupAnchor; `first-use` only with no pair mark either, and only for a
 *   reader whose entry is active at the head), or nothing is accepted;
 * - `joinMark` (with anchor `join` only) and `pairMarks` are codes the person
 *   compared: the chain must pass through a roster at each one's version
 *   whose code is that one's, or it is a fork; short of it, a rollback;
 * - `pins` are every group pin this person holds (the settings' and the
 *   device's own) and `cache` this device's record of what it verified
 *   (AcceptedRosters.cache, or null): the person's marks;
 * - `rosters` are every roster from version 1, or with a cache every one
 *   after it, in any order; `successions` every group key succession;
 * - `mlDsaKeys` maps the SHA-256 (base64url) of every ML-DSA key a signer's
 *   entry names to that key;
 * - `me`, the reader's own user id and every identity it has had, so each
 *   roster's entry for it is checked.
 *
 * The chain is the one ending at the latest roster served, linked by digest
 * back to version 1 (or to the cache); anything else served is a dead branch
 * and is ignored. The person's marks must agree with each other and with
 * that chain, or this is a fork (the hard warning); a chain short of a mark
 * is a rollback, refused. Then each roster must hold under the group key
 * current at its version (rosters under key v come after the succession into
 * v and no later than the succession out of it), be signed by a member active
 * with `members` on the roster before it (version 1: on itself, the creator),
 * keep the entry rules, and follow the succession a roster that drops a
 * `members` holder makes due. Anything that does not verify is refused, and
 * nothing in the group is then vouched for by its roster.
 */
export async function acceptRosters(input: AcceptInput): Promise<RosterChain> {
    try {
        return asAccepted((await accept(input)).body);
    } catch (error) {
        if (error instanceof Fork) return error.fork;
        throw error;
    }
}

const NOT_FOLLOWING = 'This roster does not follow the last one.';
const REPLACED_KEY = 'This roster was signed by a group key that has been replaced.';
const OLDER = 'This is an older member list than this device has seen.';
const HOLDER_LEFT = 'A member who held the group key left, so the key must be replaced first.';
const NOT_HOLDER = 'This was not signed by a member who holds the group key.';
const SIGNER_LEFT =
    'A member list is signed by a member who stays on it: another holder signs a departure.';
const NO_HOLDER = 'A member list keeps an active member who holds the group key.';
const NOT_MEMBER = 'This is not signed by the member it names.';
const NOT_GROUP_SIGNED = 'This roster is not signed by the group key.';
const NO_SUCCESSION = 'A group key succession is missing.';
const NOT_CHECKED = 'These are not the group keys this person checked.';
const NOT_BY_OLD_KEY = 'This group key succession is not signed by the key it replaces.';
const NOT_TIED = 'This group key succession is not tied to a roster on the member list.';
const OUT_OF_ORDER = 'This group key succession is out of order.';
const NOT_NEW_KEY = 'This group key succession does not replace the key with a new one.';
const NOT_EXTENDING =
    'This member list does not continue the one this device holds: fetch it again from version 1.';

/* The cache as given, every part in its canonical form and consistent, or refused. */
async function checkCache(groupId: string, value: unknown, server: boolean) {
    const bad = () => new CryptoError('Invalid member list cache.');
    const plain = (v: unknown): v is Record<string, unknown> =>
        typeof v === 'object' && v !== null && !Array.isArray(v);
    if (!plain(value)) throw bad();
    const cache = value as Record<string, unknown>;
    if (cache.groupId !== groupId) throw bad();
    // The server's record continues only the server's acceptance; a device's only a device's.
    if (server ? cache.origin !== 'server' : cache.origin !== undefined) throw bad();
    try {
        if (!Array.isArray(cache.rosterDigests) || cache.rosterDigests.length === 0) throw bad();
        const rosterDigests = cache.rosterDigests.map((at) => digestOf(at, 'roster digest'));
        if (typeof cache.statement !== 'string') throw bad();
        const statement = decode(cache.statement);
        const roster = parseRoster(statement);
        if (
            roster.groupId !== groupId ||
            roster.rosterVersion !== rosterDigests.length ||
            (await rosterDigest(statement)) !== rosterDigests.at(-1)
        )
            throw bad();
        if (typeof cache.droppedHolder !== 'boolean') throw bad();
        if (!Array.isArray(cache.groupKeys)) throw bad();
        const groupKeys = cache.groupKeys.map((key) => {
            if (!plain(key)) throw bad();
            return {
                ed25519PublicKey: bytesOf(key.ed25519PublicKey, 32, 'group key'),
                mlDsaPublicKey: bytesOf(key.mlDsaPublicKey, ML_DSA_PUBLIC_KEY_BYTES, 'group key'),
            };
        });
        // Also refuses an empty list: the last roster's key version is at least 1.
        if (roster.groupKeyVersion > groupKeys.length) throw bad();
        if (!Array.isArray(cache.successions) || cache.successions.length !== groupKeys.length - 1)
            throw bad();
        const successions = cache.successions.map((at) => {
            if (!plain(at)) throw bad();
            return {
                lastRosterVersion: integer(at.lastRosterVersion, 'roster version'),
                digest: digestOf(at.digest, 'statement digest'),
                signerUserId: uuid(at.signerUserId, 'user id'),
            };
        });
        successions.forEach((at, index) => {
            const before = successions[index - 1];
            if (
                at.lastRosterVersion > rosterDigests.length ||
                (before && at.lastRosterVersion < before.lastRosterVersion)
            )
                throw bad();
        });
        const creatorUserId = uuid(cache.creatorUserId, 'user id');
        if (!plain(cache.keyHistory)) throw bad();
        const keyHistory: Record<string, KeySet[]> = {};
        for (const [userId, sets] of Object.entries(cache.keyHistory)) {
            if (!Array.isArray(sets)) throw bad();
            const list = sets.map((set) => {
                if (!plain(set)) throw bad();
                return {
                    encryptionPublicKey: bytesOf(set.encryptionPublicKey, 32, 'encryption key'),
                    signingPublicKey: bytesOf(set.signingPublicKey, 32, 'signing key'),
                    mlDsaPublicKeyDigest: digestOf(set.mlDsaPublicKeyDigest, 'key digest'),
                };
            });
            if (new Set(list.map((set) => JSON.stringify(set))).size !== list.length) throw bad();
            keyHistory[uuid(userId, 'user id')] = list;
        }
        if (!plain(cache.areaKeys)) throw bad();
        const areaKeys: Record<string, string[]> = {};
        for (const [workspaceId, list] of Object.entries(cache.areaKeys)) {
            if (!Array.isArray(list) || list.length === 0) throw bad();
            areaKeys[uuid(workspaceId, 'workspace id')] = list.map((at) =>
                digestOf(at, 'area key commitment'),
            );
        }
        // Root commitments beside them (null for a format 1 row), and the retired areas, as the
        // cache's own version says (design 2.10): version 2 carries both, every area's roots
        // listed; a cache written before format 2 (no version) has neither and described none.
        const cacheVersion = cache.cacheVersion ?? 1;
        if (cacheVersion !== 1 && cacheVersion !== CACHE_VERSION) throw bad();
        const beforeFormat2 = cacheVersion === 1;
        if (cache.areaRoots !== undefined && !plain(cache.areaRoots)) throw bad();
        const cachedRoots = (cache.areaRoots ?? {}) as Record<string, unknown>;
        if (Object.keys(cachedRoots).some((id) => !Object.hasOwn(areaKeys, id))) throw bad();
        if (
            beforeFormat2 &&
            (Object.keys(cachedRoots).length > 0 ||
                ((cache.retiredAreas as unknown[] | undefined)?.length ?? 0) > 0)
        )
            throw bad();
        if (!beforeFormat2 && (cache.areaRoots === undefined || cache.retiredAreas === undefined))
            throw bad();
        const areaRoots: Record<string, (string | null)[]> = {};
        for (const [workspaceId, list] of Object.entries(areaKeys)) {
            const roots = beforeFormat2
                ? list.map(() => null)
                : Object.hasOwn(cachedRoots, workspaceId)
                  ? cachedRoots[workspaceId]
                  : [];
            if (!Array.isArray(roots) || roots.length !== list.length) throw bad();
            areaRoots[workspaceId] = roots.map((at: unknown) =>
                at === null ? null : digestOf(at, 'area root commitment'),
            );
        }
        if (cache.retiredAreas !== undefined && !Array.isArray(cache.retiredAreas)) throw bad();
        const retiredAreas = ascending(
            ((cache.retiredAreas as unknown[] | undefined) ?? []).map((at) =>
                uuid(at, 'workspace id'),
            ),
            'retired areas',
        );
        if (retiredAreas.some((id) => !Object.hasOwn(areaKeys, id))) throw bad();
        // The last roster's rows are each its area's latest key (and root), or its tombstone.
        // Earlier commitments are this device's own record, trusted as stored (a compromised
        // device is out of scope). At the first roster there is nothing earlier: its rows are
        // every area there is.
        for (const area of roster.areas ?? []) {
            const list = areaKeys[area.workspaceId];
            if (area.retired) {
                if (
                    !retiredAreas.includes(area.workspaceId) ||
                    list?.length !== area.workspaceKeyVersion - 1
                )
                    throw bad();
                continue;
            }
            if (
                list?.length !== area.workspaceKeyVersion ||
                list.at(-1) !== area.commitment ||
                areaRoots[area.workspaceId]!.at(-1) !== (area.rootCommitment ?? null) ||
                retiredAreas.includes(area.workspaceId)
            )
                throw bad();
        }
        if (
            roster.rosterVersion === 1 &&
            Object.keys(areaKeys).length !== (roster.areas ?? []).length
        )
            throw bad();
        if (!Array.isArray(cache.ownEntryWrongAt)) throw bad();
        const ownEntryWrongAt = cache.ownEntryWrongAt.map((at) => integer(at, 'roster version'));
        ownEntryWrongAt.forEach((at, index) => {
            if (at > rosterDigests.length || (index > 0 && at <= ownEntryWrongAt[index - 1]!))
                throw bad();
        });
        return {
            rosterDigests,
            statement,
            roster,
            droppedHolder: cache.droppedHolder,
            groupKeys,
            successions,
            creatorUserId,
            keyHistory,
            areaKeys,
            areaRoots,
            retiredAreas,
            ownEntryWrongAt,
        };
    } catch (error) {
        if (error instanceof CryptoError) throw bad();
        throw error;
    }
}
type Cached = Awaited<ReturnType<typeof checkCache>>;

/*
 * What acceptance carries from roster to roster: the group keys so far with
 * the successions that reached them, the chain's rosters held so far, the
 * served successions by the key they replace, and the person's group key
 * marks. A chain's cache rebuilds it, so the next roster or succession is
 * judged by the very same rules (checkNextRoster, checkNextSuccession).
 */
type State = {
    groupId: string;
    mlDsaKeys: Record<string, string>;
    keys: GroupPublicKey[];
    verified: Map<number, Verified>;
    held: Held[];
    candidates: Map<number, Served<GroupKeySuccession>[]>;
    keyMarks: Map<number, MarkSide>;
    /* Why the successions from a key were not taken, for checkNextSuccession. */
    refused: Map<number, CryptoError>;
    /* Valid successions from a key that the person's group key mark there does not name. */
    waiting: Map<number, { side: MarkSide; key: GroupPublicKey }[]>;
    /*
     * Each candidate succession's signatures, checked once: its old key and the roster it is
     * tied to (so its signer's entry) are fixed by its statement, whenever it is looked at.
     */
    signatures: Map<string, 'held' | 'not-member' | 'not-old-key'>;
    /* What the held rosters listed of the areas (foldAreas): keys, roots, tombstones. */
    areas: AreaLedger;
};

function stateOf(groupId: string, mlDsaKeys: Record<string, string>, cached: Cached | null): State {
    const verified = new Map<number, Verified>();
    cached?.successions.forEach((at, index) => verified.set(index + 1, { ...at }));
    return {
        groupId,
        mlDsaKeys,
        keys: cached ? cached.groupKeys.map((key) => ({ ...key })) : [],
        verified,
        held: cached
            ? [
                  {
                      roster: cached.roster,
                      statement: cached.statement,
                      digest: cached.rosterDigests.at(-1)!,
                      droppedHolder: cached.droppedHolder,
                  },
              ]
            : [],
        candidates: new Map(),
        keyMarks: new Map(),
        refused: new Map(),
        waiting: new Map(),
        signatures: new Map(),
        areas: ledgerOf(cached),
    };
}

/* Served statements by digest, every distinct copy of their signatures kept. */
async function byDigest<T>(signed: SignedGroupStatement[], parse: (statement: Uint8Array) => T) {
    const out = new Map<string, Served<T>>();
    const same = (x: Uint8Array, y: Uint8Array) =>
        x.length === y.length && x.every((byte, index) => byte === y[index]);
    for (const copy of signed) {
        const value = parse(copy.statement);
        const key = await digest(copy.statement);
        const held = out.get(key) ?? { value, statement: copy.statement, digest: key, copies: [] };
        if (
            !held.copies.some(
                (c) =>
                    same(c.signature.ed25519, copy.signature.ed25519) &&
                    same(c.signature.mlDsa, copy.signature.mlDsa) &&
                    same(c.signerSignature, copy.signerSignature),
            )
        )
            held.copies.push(copy);
        out.set(key, held);
    }
    return out;
}

/*
 * The succession from key `oldVersion` if it holds: it names the chain's key
 * there, one copy is signed by that key and by its signer, active with
 * `members` on the roster it is tied to (held, by digest), and it is tied no
 * earlier than the succession into it. Otherwise why not. Acceptance takes a
 * succession as soon as the roster it is tied to is held, before any later
 * roster, so one tied before the last roster under the old key is never
 * taken in time: that later roster is refused as under a replaced key.
 */
async function admissibleSuccession(
    state: State,
    served: Served<GroupKeySuccession>,
    oldVersion: number,
): Promise<GroupKeySuccession | CryptoError> {
    const succession = served.value;
    const old = state.keys[oldVersion - 1]!;
    if (
        succession.groupId !== state.groupId ||
        !sameGroupKey(old, {
            ed25519PublicKey: succession.oldEd25519PublicKey,
            mlDsaPublicKey: succession.oldMlDsaPublicKey,
        })
    )
        return new CryptoError(NOT_BY_OLD_KEY);
    // A new key must be new: not the old one, nor any the group had before.
    const next = {
        ed25519PublicKey: succession.newEd25519PublicKey,
        mlDsaPublicKey: succession.newMlDsaPublicKey,
    };
    if (state.keys.some((key) => sameGroupKey(key, next))) return new CryptoError(NOT_NEW_KEY);
    const last = state.held.find((at) => at.roster.rosterVersion === succession.lastRosterVersion);
    if (!last || last.digest !== succession.lastRosterDigest) return new CryptoError(NOT_TIED);
    const into = state.verified.get(oldVersion - 1);
    if (into && succession.lastRosterVersion < into.lastRosterVersion)
        return new CryptoError(OUT_OF_ORDER);
    if (!activeWith(rosterEntry(last.roster, succession.signerUserId), 'members'))
        return new CryptoError(NOT_HOLDER);
    let verdict = state.signatures.get(served.digest);
    if (verdict === undefined) {
        verdict = 'not-old-key';
        for (const copy of served.copies) {
            if (!(await verifyGroup(served.statement, copy.signature, old))) continue;
            verdict = 'not-member';
            if (await signedByMember(last.roster, succession.signerUserId, copy, state.mlDsaKeys)) {
                verdict = 'held';
                break;
            }
        }
        state.signatures.set(served.digest, verdict);
    }
    if (verdict === 'held') return succession;
    return new CryptoError(verdict === 'not-member' ? NOT_MEMBER : NOT_BY_OLD_KEY);
}

/*
 * The succession from the current key, or none yet: of the served ones that
 * hold now, the one a group key mark names, or the only one. Ones that do not
 * hold are ignored (why is kept, for checkNextSuccession). Two that hold with
 * no mark to choose are the server's to resolve: refused. Ones a mark does not
 * name wait (rosterRules).
 */
async function nextSuccession(state: State) {
    const oldVersion = state.keys.length;
    const served = [...(state.candidates.get(oldVersion) ?? [])].sort((x, y) =>
        x.digest < y.digest ? -1 : 1,
    );
    const valid: [Served<GroupKeySuccession>, GroupKeySuccession, string][] = [];
    let reason: CryptoError | null = null;
    for (const at of served) {
        const result = await admissibleSuccession(state, at, oldVersion);
        if (result instanceof CryptoError) reason ??= result;
        else
            valid.push([
                at,
                result,
                await groupKeyDigest({
                    ed25519PublicKey: result.newEd25519PublicKey,
                    mlDsaPublicKey: result.newMlDsaPublicKey,
                }),
            ]);
    }
    const mark = state.keyMarks.get(oldVersion + 1);
    let chosen = valid[0];
    if (mark) {
        chosen = valid.find(([, , keyDigest]) => keyDigest === mark.digest);
        // Valid successions the mark does not name wait: the one it names may be tied to a roster
        // not reached yet. They are the warning only if a roster needing the next key holds under
        // one of them (a holder-signed history the person's mark contradicts).
        if (!chosen && valid.length > 0)
            state.waiting.set(
                oldVersion,
                valid.map(([, s, keyDigest]) => ({
                    side: {
                        digest: keyDigest,
                        from: ['served' as const],
                        signerUserId: s.signerUserId,
                    },
                    key: {
                        ed25519PublicKey: s.newEd25519PublicKey,
                        mlDsaPublicKey: s.newMlDsaPublicKey,
                    },
                })),
            );
    } else if (valid.length > 1)
        throw new CryptoError('The server served more than one group key succession from one key.');
    if (!chosen) {
        state.refused.set(oldVersion, reason ?? new CryptoError(NO_SUCCESSION));
        return null;
    }
    return chosen;
}

/* Takes the succession from the current key, as nextSuccession chose it. */
async function establishNext(state: State) {
    const next = await nextSuccession(state);
    if (!next) return false;
    const [served, succession] = next;
    state.verified.set(state.keys.length, {
        lastRosterVersion: succession.lastRosterVersion,
        digest: served.digest,
        signerUserId: succession.signerUserId,
    });
    state.keys.push({
        ed25519PublicKey: succession.newEd25519PublicKey,
        mlDsaPublicKey: succession.newMlDsaPublicKey,
    });
    return true;
}

/* The sides of a conflict, merged by digest and sorted by it. */
function sides(all: MarkSide[]): MarkSide[] {
    const order = ['pin', 'cache', 'join', 'pair', 'served'] as const;
    const merged = new Map<string, MarkSide>();
    for (const side of all) {
        const held = merged.get(side.digest);
        if (!held) merged.set(side.digest, { ...side, from: [...side.from] });
        else {
            held.from = order.filter((f) => held.from.includes(f) || side.from.includes(f));
            held.signerUserId ??= side.signerUserId;
        }
    }
    return [...merged.values()].sort((x, y) => (x.digest < y.digest ? -1 : 1));
}

/*
 * Every rule a roster must keep at the position after `previous` (2.4, 2.5):
 * the group's kind; the group key current at its version (the succession into
 * it held, none out of it before this roster); a signer active with `members`
 * on the roster before it (version 1: on itself); one copy carrying both a
 * group signature by that key and the signer's identity signature (skipped
 * for an unsigned roster, as nextRoster builds); the succession a dropped
 * holder made due; and the entry rules.
 */
async function rosterRules(
    state: State,
    roster: Roster,
    statement: Uint8Array,
    copies: SignedGroupStatement[] | null,
    previous: Held | undefined,
) {
    if (previous && roster.kind !== previous.roster.kind) throw new CryptoError(NOT_FOLLOWING);
    // Successions are taken as soon as the roster they are tied to is held (acceptance does so),
    // so a key not reached by now has none that holds.
    if (state.keys.length < roster.groupKeyVersion) {
        // Rivals waiting for a mark they do not meet: the warning only if this roster holds under
        // one of them, signed by a holder; a roster the real (withheld) key signed is refused.
        const rivals = state.waiting.get(state.keys.length);
        const mark = state.keyMarks.get(state.keys.length + 1);
        const authority = previous?.roster ?? roster;
        if (rivals && mark && copies && roster.groupKeyVersion === state.keys.length + 1)
            for (const rival of rivals)
                for (const copy of copies)
                    if (
                        (await verifyGroup(statement, copy.signature, rival.key)) &&
                        activeWith(rosterEntry(authority, roster.signerUserId), 'members') &&
                        // A rival roster that breaks the departure rules is refused, not a warning.
                        rosterEntry(roster, roster.signerUserId)?.status === 'active' &&
                        roster.members.some((entry) => activeWith(entry, 'members')) &&
                        (await signedByMember(
                            authority,
                            roster.signerUserId,
                            copy,
                            state.mlDsaKeys,
                        ))
                    )
                        throw new Fork({
                            status: 'fork',
                            of: 'group-key',
                            version: state.keys.length + 1,
                            sides: sides([mark, ...rivals.map((r) => r.side)]),
                        });
        throw state.refused.get(state.keys.length) ?? new CryptoError(NO_SUCCESSION);
    }
    // Never before the succession into its key: that succession is tied to a roster already held.
    const out = state.verified.get(roster.groupKeyVersion);
    if (out && roster.rosterVersion > out.lastRosterVersion) throw new CryptoError(REPLACED_KEY);
    const authority = previous?.roster ?? roster;
    if (!activeWith(rosterEntry(authority, roster.signerUserId), 'members'))
        throw new CryptoError(NOT_HOLDER);
    // The signer stays active on what they sign (a holder's departure is another holder's to
    // sign, with its rotations), and the group keeps someone who can sign the next one.
    if (rosterEntry(roster, roster.signerUserId)?.status !== 'active')
        throw new CryptoError(SIGNER_LEFT);
    if (!roster.members.some((entry) => activeWith(entry, 'members')))
        throw new CryptoError(NO_HOLDER);
    if (copies) {
        const key = state.keys[roster.groupKeyVersion - 1]!;
        let groupSigned = false;
        let signed = false;
        for (const copy of copies) {
            if (!(await verifyGroup(statement, copy.signature, key))) continue;
            groupSigned = true;
            if (await signedByMember(authority, roster.signerUserId, copy, state.mlDsaKeys)) {
                signed = true;
                break;
            }
        }
        if (!groupSigned) throw new CryptoError(NOT_GROUP_SIGNED);
        if (!signed) throw new CryptoError(NOT_MEMBER);
    }
    if (previous?.droppedHolder) {
        // The roster that took a holder away was the last under that key.
        // (A roster still under that key is then one after its succession, refused above.)
        const outOfPrevious = state.verified.get(previous.roster.groupKeyVersion);
        if (outOfPrevious?.lastRosterVersion !== previous.roster.rosterVersion)
            throw new CryptoError(HOLDER_LEFT);
    }
    if (previous) checkEntries(previous.roster, roster);
    checkAreas(state.areas, previous?.roster, roster);
}

/*
 * What acceptance takes: AcceptInput, with no reader to check (`me` null) when
 * a chain is extended for a check, and one more anchor no device passes:
 * `stored`, the server's version 1 keys as stored at creation (acceptStored).
 */
type Accepting = AcceptBase & {
    anchor: GroupAnchor | 'stored' | null;
    me: AcceptInput['me'] | null;
    cache: GroupChainCache | StoredChainCache | null;
    /* The server's acceptance: its cache must be the server's record, a device's never. */
    server?: boolean;
};

/* Refused when anchor `first-use` vouches for a chain whose head has no active entry for the reader. */
export const NOT_LET_IN = 'This account is not in this family yet.';

/* SHA-256 of the version 1 Ed25519 key and the ML-DSA key's digest: how a pin's first keys compare. */
async function firstKeysMark(ed25519PublicKey: string, mlDsaPublicKeyDigest: string | null) {
    try {
        const bytes = new Uint8Array(64);
        bytes.set(decode(ed25519PublicKey, 32));
        bytes.set(decode(mlDsaPublicKeyDigest ?? '', 32), 32);
        return await digest(bytes);
    } catch {
        return '';
    }
}

/*
 * Acceptance, in four steps, each needing no more from the server than the one before:
 * (1) the person's own marks against each other, and the served version 1 keys
 *     against the marks' (needs nothing from the server but those keys);
 * (2) the chain, linked from the latest roster served down to version 1 or to
 *     the cache;
 * (3) the chain verified in one pass, rosters and successions, anything that
 *     fails refused;
 * (4) the marks against the verified chain.
 * A side of a conflict names a signer only when its statement was verified
 * (in step 3, or by this device before, for the cache).
 */
async function accept(input: Accepting) {
    const groupId = uuid(input.groupId, 'group id');
    const { firstKeys } = input;
    const pins = input.pins.map((pin) => checkGroupPin(groupId, pin));
    const cached = input.cache
        ? await checkCache(groupId, input.cache, input.server ?? false)
        : null;
    const joinMark = input.joinMark ? checkJoinMark(input.joinMark) : null;
    const pairMarks = (input.pairMarks ?? []).map(checkPairMark);
    // What vouches for the version 1 keys (named apart from the field, which only callers set).
    const vouching = input.anchor;
    if (
        vouching !== null &&
        vouching !== 'created' &&
        vouching !== 'join' &&
        vouching !== 'first-use' &&
        vouching !== 'stored'
    )
        throw new CryptoError('Invalid anchor.');
    // A join is anchored by the code compared; a join mark comes with a join, or beside the marks
    // that decide (a rejoin), never with another anchor.
    if (
        (vouching === 'join' && joinMark === null) ||
        (joinMark !== null && vouching !== 'join' && vouching !== null)
    )
        throw new CryptoError('A join is anchored by the join code compared, and only a join is.');
    if (pairMarks.length > 0 && !input.me) throw new CryptoError('Invalid pair mark.');
    const conflict = (of: RosterFork['of'], version: number, all: MarkSide[]) => {
        const merged = sides(all);
        if (merged.length > 1) throw new Fork({ status: 'fork', of, version, sides: merged });
    };

    // (1) The person's marks: the pins' and the cache's rosters, group keys and version 1 keys.
    const rosterMarks = new Map<number, MarkSide[]>();
    const keyMarkSides = new Map<number, MarkSide[]>();
    const add = (map: Map<number, MarkSide[]>, version: number, side: MarkSide) =>
        map.set(version, [...(map.get(version) ?? []), side]);
    const firstMarks: MarkSide[] = [];
    for (const pin of pins) {
        add(rosterMarks, pin.rosterVersion, {
            digest: pin.rosterDigest,
            from: ['pin'],
            signerUserId: null,
        });
        add(keyMarkSides, pin.keyVersion, {
            digest: pin.groupKeyDigest,
            from: ['pin'],
            signerUserId: null,
        });
        firstMarks.push({
            digest: await firstKeysMark(pin.firstEd25519PublicKey, pin.firstMlDsaPublicKeyDigest),
            from: ['pin'],
            signerUserId: null,
        });
    }
    if (cached) {
        // This device verified the cache's statements: its last roster's signer, its
        // successions' and the creator are known.
        const last = cached.rosterDigests.length;
        cached.rosterDigests.forEach((at, index) =>
            add(rosterMarks, index + 1, {
                digest: at,
                from: ['cache'],
                signerUserId: index + 1 === last ? cached.roster.signerUserId : null,
            }),
        );
        for (const [index, key] of cached.groupKeys.entries())
            add(keyMarkSides, index + 1, {
                digest: await groupKeyDigest(key),
                from: ['cache'],
                signerUserId: cached.successions[index - 1]?.signerUserId ?? null,
            });
        firstMarks.push({
            digest: await firstKeysMark(
                cached.groupKeys[0]!.ed25519PublicKey,
                await mlDsaDigest(cached.groupKeys[0]!.mlDsaPublicKey),
            ),
            from: ['cache'],
            signerUserId: cached.creatorUserId,
        });
    }
    // Marks that disagree with each other need nothing from the server: version 1 keys first,
    // then rosters, then group keys, by version.
    conflict('group-key', 1, firstMarks);
    for (const version of [...rosterMarks.keys()].sort((x, y) => x - y))
        conflict('roster', version, rosterMarks.get(version)!);
    for (const version of [...keyMarkSides.keys()].sort((x, y) => x - y))
        conflict('group-key', version, keyMarkSides.get(version)!);
    // Only now is anything served looked at: junk the server adds can refuse, never hide the
    // warning the person's own marks raise.
    const rosters = await byDigest(input.rosters, parseRoster);
    for (const { value } of rosters.values())
        if (value.groupId !== groupId) throw new CryptoError('This roster is for another group.');
    const successions = await byDigest(input.successions, parseGroupSuccession);
    // The served version 1 keys must be the ones the marks agree on, or, with no mark at all, the
    // ones the anchor vouches for. First use vouches only where nothing at all marks the family:
    // a family check is a mark too, though it fixes no first keys.
    const firstUse = firstMarks.length === 0 && vouching === 'first-use' && pairMarks.length === 0;
    if (firstMarks.length > 0) {
        const served = await firstKeysMark(
            firstKeys.ed25519PublicKey,
            await mlDsaDigest(firstKeys.mlDsaPublicKey),
        );
        if (served !== firstMarks[0]!.digest) throw new CryptoError(NOT_CHECKED);
    } else if (vouching === null || (vouching === 'first-use' && !firstUse))
        throw new CryptoError(
            'These group keys have not been checked: compare the join code first.',
        );

    // (2) The chain: from the latest roster served, linked by digest down to the cache or to 1.
    const cachedVersion = cached?.rosterDigests.length ?? 0;
    const servedVersions = [...rosters.values()].map(({ value }) => value.rosterVersion);
    const extending = cached !== null && servedVersions.every((v) => v > cachedVersion);
    const head = servedVersions.reduce(
        (max, v) => (v > max ? v : max),
        extending ? cachedVersion : 0,
    );
    if (head === 0) throw new CryptoError('This group has no member list yet.');
    const bottom = extending ? cachedVersion : 0;
    const path = new Map<number, Served<Roster>>();
    if (head > bottom) {
        const tops = [...rosters.values()].filter(({ value }) => value.rosterVersion === head);
        if (tops.length > 1)
            throw new CryptoError('The server served more than one latest member list.');
        let at: Served<Roster> | undefined = tops[0];
        for (let version = head; version > bottom; version--) {
            if (!at || at.value.rosterVersion !== version) throw new CryptoError(NOT_FOLLOWING);
            path.set(version, at);
            at = version > 1 ? rosters.get(at.value.previousRosterDigest) : undefined;
        }
        // Rosters after the cache that do not continue it: fetch the chain again from version 1,
        // where the cache is one more mark.
        if (
            extending &&
            path.get(bottom + 1)!.value.previousRosterDigest !== cached.rosterDigests.at(-1)
        )
            throw new CryptoError(NOT_EXTENDING);
    }

    // (3) One pass along the chain: keys, signers and entries. A group key mark the marks agree on
    // chooses among valid successions; each is taken as soon as the roster it is tied to is held,
    // so the rosters after it are judged under the new key.
    const state = stateOf(groupId, input.mlDsaKeys, extending ? cached : null);
    if (!extending) state.keys.push(firstKeys);
    for (const [version, all] of keyMarkSides) state.keyMarks.set(version, sides(all)[0]!);
    for (const at of successions.values()) {
        const list = state.candidates.get(at.value.oldVersion) ?? [];
        list.push(at);
        state.candidates.set(at.value.oldVersion, list);
    }
    while (await establishNext(state));
    for (let version = bottom + 1; version <= head; version++) {
        const at = path.get(version)!;
        const previous = state.held.at(-1);
        await rosterRules(state, at.value, at.statement, at.copies, previous);
        foldAreas(state.areas, at.value);
        state.held.push({
            roster: at.value,
            statement: at.statement,
            digest: at.digest,
            droppedHolder: previous ? dropsHolder(previous.roster, at.value) : false,
        });
        while (await establishNext(state));
    }

    // (4) The marks against the verified chain. A signer is named only for a statement verified
    // here, or by this device before (the cache's).
    const verifiedSigners = new Map(state.held.map((at) => [at.digest, at.roster.signerUserId]));
    const signed = (side: MarkSide) => ({
        ...side,
        signerUserId: side.signerUserId ?? verifiedSigners.get(side.digest) ?? null,
    });
    const creatorUserId = extending ? cached.creatorUserId : state.held[0]!.roster.signerUserId;
    // Roster marks the chain does not pass through: a fork; beyond it: a rollback.
    const chainDigest = (version: number) =>
        version <= bottom ? cached!.rosterDigests[version - 1]! : path.get(version)!.digest;
    const marked = [...rosterMarks.keys()].sort((x, y) => x - y);
    for (const version of marked.filter((v) => v <= head))
        conflict('roster', version, [
            ...rosterMarks.get(version)!.map(signed),
            signed({ digest: chainDigest(version), from: ['served'], signerUserId: null }),
        ]);
    if (marked.some((v) => v > head)) throw new CryptoError(OLDER);
    // The join mark: the roster that admitted the newcomer, by its twelve-word code.
    if (joinMark) {
        if (joinMark.rosterVersion > head) throw new CryptoError(OLDER);
        const digest = chainDigest(joinMark.rosterVersion);
        // The group key that roster is under: one above every succession tied to an earlier roster.
        const keyVersion = keyVersionAt(state.verified.values(), joinMark.rosterVersion);
        const code = await joinCode(digest, state.keys[keyVersion - 1]!, keyVersion);
        if (code.join(' ') !== joinMark.code.join(' '))
            throw new Fork({
                status: 'fork',
                of: 'roster',
                version: joinMark.rosterVersion,
                sides: sides([
                    { digest: joinMark.code.join(' '), from: ['join'], signerUserId: null },
                    {
                        digest,
                        from: ['served'],
                        signerUserId: verifiedSigners.get(digest) ?? null,
                    },
                ]),
            });
    }
    // The pair marks: each family check this person made, by its code over the roster compared
    // and the two accounts (this one, and the member compared with), in version order.
    for (const mark of [...pairMarks].sort((x, y) => x.rosterVersion - y.rosterVersion)) {
        if (mark.rosterVersion > head) throw new CryptoError(OLDER);
        const digest = chainDigest(mark.rosterVersion);
        const keyVersion = keyVersionAt(state.verified.values(), mark.rosterVersion);
        const code = await pairCodeOf(
            digest,
            state.keys[keyVersion - 1]!,
            keyVersion,
            input.me!.userId,
            mark.with,
        );
        if (code.join(' ') !== mark.code.join(' '))
            throw new Fork({
                status: 'fork',
                of: 'roster',
                version: mark.rosterVersion,
                sides: sides([
                    { digest: mark.code.join(' '), from: ['pair'], signerUserId: null },
                    {
                        digest,
                        from: ['served'],
                        signerUserId: verifiedSigners.get(digest) ?? null,
                    },
                ]),
            });
    }
    // First use takes the served version 1 keys only for a reader the head admits.
    if (
        firstUse &&
        !(input.me && activeWith(rosterEntry(state.held.at(-1)!.roster, input.me.userId)))
    )
        throw new CryptoError(NOT_LET_IN);
    // Group key marks: each the chain's; beyond it, a rollback (or a succession withheld).
    for (const version of [...state.keyMarks.keys()].sort((x, y) => x - y)) {
        if (version > state.keys.length) continue;
        conflict('group-key', version, [
            state.keyMarks.get(version)!,
            {
                digest: await groupKeyDigest(state.keys[version - 1]!),
                from: ['served'],
                signerUserId: state.verified.get(version - 1)?.signerUserId ?? null,
            },
        ]);
    }
    if ([...keyMarkSides.keys()].some((v) => v > state.keys.length)) throw new CryptoError(OLDER);

    // The keys each member's entries named and the reader's own entries, on the rosters this
    // acceptance added (the cache's last roster is already in its history). The reader's entry
    // must name one of their identities, and never one older than the roster before named.
    const fresh = extending ? state.held.slice(1) : state.held;
    const keyHistory: Record<string, KeySet[]> = Object.fromEntries(
        Object.entries(extending ? cached.keyHistory : {}).map(([id, list]) => [
            id,
            list.map((set) => ({ ...set })),
        ]),
    );
    // Every area key the rosters listed, each area's versions in order (checkAreas, foldAreas),
    // with their roots, and the retired areas.
    const areaKeys: Record<string, string[]> = Object.fromEntries(
        [...state.areas.keys.entries()].map(([id, list]) => [id, [...list]]),
    );
    const areaRoots: Record<string, (string | null)[]> = Object.fromEntries(
        [...state.areas.roots.entries()].map(([id, list]) => [id, [...list]]),
    );
    const retiredAreas = [...state.areas.retired].sort();
    const ownEntryWrongAt = extending ? [...cached.ownEntryWrongAt] : [];
    const mineAt = async (roster: Roster) => {
        const entry = input.me ? rosterEntry(roster, input.me.userId) : undefined;
        if (!entry) return { listed: false, keyVersion: null };
        for (const identity of input.me!.identities)
            if (await servedIsEntry(identity, entry))
                return { listed: true, keyVersion: identity.keyVersion };
        return { listed: true, keyVersion: null };
    };
    let lastOwn = extending ? (await mineAt(cached.roster)).keyVersion : null;
    const ownEntryBehindAt: number[] = [];
    const newestOwn = (input.me?.identities ?? []).reduce(
        (max, identity) => (identity.keyVersion > max ? identity.keyVersion : max),
        0,
    );
    for (const at of fresh) {
        for (const entry of at.roster.members) {
            const seen = (keyHistory[entry.userId] ??= []);
            const set = keySetOf(entry);
            if (!seen.some((s) => sameKeySet(s, set))) seen.push(set);
        }
        const mine = await mineAt(at.roster);
        if (!mine.listed) continue;
        if (mine.keyVersion === null || (lastOwn !== null && mine.keyVersion < lastOwn))
            ownEntryWrongAt.push(at.roster.rosterVersion);
        else if (
            mine.keyVersion < newestOwn &&
            rosterEntry(at.roster, input.me!.userId)!.sinceVersion === at.roster.rosterVersion
        )
            ownEntryBehindAt.push(at.roster.rosterVersion);
        if (mine.keyVersion !== null) lastOwn = mine.keyVersion;
    }
    const latest = state.held.at(-1)!;
    const rosterDigests = [
        ...(extending ? cached.rosterDigests : []),
        ...[...path.entries()].sort(([x], [y]) => x - y).map(([, at]) => at.digest),
    ];
    const onChain = new Set(rosterDigests);
    const deadBranches = [...rosters.values()]
        .filter((at) => !onChain.has(at.digest))
        .sort(
            (x, y) =>
                x.value.rosterVersion - y.value.rosterVersion || (x.digest < y.digest ? -1 : 1),
        )
        .map((at) => ({ version: at.value.rosterVersion, signerUserId: at.value.signerUserId }));
    const successionsKept = [...state.verified.entries()]
        .sort(([x], [y]) => x - y)
        .map(([, at]) => ({ ...at }));
    const outOfLatest = state.verified.get(latest.roster.groupKeyVersion);
    const body: ChainBody = {
        groupId,
        kind: latest.roster.kind,
        roster: latest.roster,
        statement: latest.statement.slice(),
        rosterDigest: latest.digest,
        rosterDigests: [...rosterDigests],
        droppedHolder: latest.droppedHolder,
        groupKeyVersion: state.keys.length,
        groupKey: state.keys.at(-1)!,
        groupKeyDigest: await groupKeyDigest(state.keys.at(-1)!),
        groupKeys: state.keys,
        creatorUserId,
        successionDue:
            latest.droppedHolder && outOfLatest?.lastRosterVersion !== latest.roster.rosterVersion,
        keyHistory,
        areaKeys,
        areaRoots,
        retiredAreas,
        ownEntryWrongAt,
        ownEntryBehindAt,
        deadBranches,
        cache: {
            groupId,
            rosterDigests: [...rosterDigests],
            statement: encode(latest.statement),
            droppedHolder: latest.droppedHolder,
            groupKeys: state.keys.map((key) => ({ ...key })),
            successions: successionsKept,
            creatorUserId,
            keyHistory: Object.fromEntries(
                Object.entries(keyHistory).map(([id, list]) => [
                    id,
                    list.map((set) => ({ ...set })),
                ]),
            ),
            areaKeys: Object.fromEntries(
                Object.entries(areaKeys).map(([id, list]) => [id, [...list]]),
            ),
            areaRoots: Object.fromEntries(
                Object.entries(areaRoots).map(([id, list]) => [id, [...list]]),
            ),
            retiredAreas: [...retiredAreas],
            cacheVersion: CACHE_VERSION,
            ownEntryWrongAt: [...ownEntryWrongAt],
        },
        checked:
            vouching === 'created'
                ? { how: 'created', rosterVersion: 1 }
                : joinMark
                  ? { how: 'join', rosterVersion: joinMark.rosterVersion }
                  : pairMarks.length > 0
                    ? {
                          how: 'compared',
                          rosterVersion: Math.min(...pairMarks.map((at) => at.rosterVersion)),
                      }
                    : null,
    };
    return { body, state };
}

function asAccepted(body: ChainBody): AcceptedRosters {
    return markAccepted(
        deepFreeze({ ...body, [ACCEPTED]: true as const, status: 'accepted' as const }),
    );
}
/* Every StoredChain's record, kept off the chain itself: only the server entry reads it. */
const storedCaches = new WeakMap<object, StoredChainCache>();
function asStored(body: ChainBody): StoredChain {
    const { cache, ...rest } = body;
    const chain = markStored(
        deepFreeze({ ...rest, [STORED]: true as const, status: 'stored' as const }),
    );
    storedCaches.set(chain, deepFreeze({ ...cache!, origin: 'server' as const }));
    return chain;
}

/* A StoredChain's record to continue from: for the server entry only (storedRecord). */
export function storedCacheOf(
    chain: StoredChain,
    capability: typeof STORED_ACCEPTANCE,
): StoredChainCache {
    if (capability !== STORED_ACCEPTANCE)
        throw new CryptoError('Only the server reads a stored member list’s record.');
    const cache = storedCaches.get(chain);
    if (!cache) throw new CryptoError('This is not a member list the server accepted.');
    return cache;
}

function keySetOf(entry: {
    encryptionPublicKey: string;
    signingPublicKey: string;
    mlDsaPublicKeyDigest: string;
}): KeySet {
    return {
        encryptionPublicKey: entry.encryptionPublicKey,
        signingPublicKey: entry.signingPublicKey,
        mlDsaPublicKeyDigest: entry.mlDsaPublicKeyDigest,
    };
}
function sameKeySet(a: KeySet, b: KeySet) {
    return (
        a.encryptionPublicKey === b.encryptionPublicKey &&
        a.signingPublicKey === b.signingPublicKey &&
        a.mlDsaPublicKeyDigest === b.mlDsaPublicKeyDigest
    );
}

/* Acceptance continuing from `chain`'s cache with `rosters` and `successions` after it. */
async function extend(
    chain: AcceptedRosters | StoredChain,
    rosters: SignedGroupStatement[],
    successions: SignedGroupStatement[],
    mlDsaKeys: Record<string, string>,
) {
    requireStoredOrAccepted(chain);
    const stored = storedCaches.get(chain) ?? null;
    try {
        return await accept({
            groupId: chain.groupId,
            firstKeys: chain.groupKeys[0]!,
            // The cache is the mark: its first keys are the chain's own, vouched for when it was
            // first accepted, so no anchor is passed.
            anchor: null,
            pins: [],
            rosters,
            successions,
            mlDsaKeys,
            me: null,
            cache: stored ?? (chain as AcceptedRosters).cache,
            server: stored !== null,
        });
    } catch (error) {
        if (error instanceof Fork) throw new CryptoError(NOT_FOLLOWING);
        throw error;
    }
}

/*
 * Whether `signed` is a roster every device holding `chain` will accept as
 * the next one: acceptance itself, continuing from the chain's cache with
 * this one roster. With `identities` (every identity each member has had, as
 * the server holds them), every entry new or changed in it must also be one
 * of its member's identities, keys statement holding: a holder cannot write
 * keys the member never had. The server must run this before it stores a
 * roster (4): one it stored that fails stops every device's sync. Returns the
 * chain extended by it as a StoredChain (frozen, in the stored registry, never
 * an accepted chain), whose record (storedRecord) the server stores next.
 */
export async function checkNextRoster(
    chain: AcceptedRosters | StoredChain,
    signed: SignedGroupStatement,
    mlDsaKeys: Record<string, string>,
    identities: Record<string, ServedIdentity[]> | null,
): Promise<StoredChain> {
    const { body: next } = await extend(chain, [signed], [], mlDsaKeys);
    if (!identities) return asStored(next);
    for (const entry of next.roster.members) {
        const before = rosterEntry(chain.roster, entry.userId);
        if (before && sameKeys(before, entry)) continue;
        let known = false;
        for (const identity of identities[entry.userId] ?? [])
            if (
                (await servedIsEntry(identity, entry)) &&
                (await verifyIdentityKeys(entry.userId, identity))
            )
                known = true;
        if (!known) throw new CryptoError('This entry names keys its member never had.');
    }
    return asStored(next);
}

/*
 * Whether `signed` is a group key succession every device holding `chain`
 * will take: acceptance itself, continuing from the chain's cache with this
 * one succession, which must then replace the chain's current key. It is
 * tied to the latest roster. Clients run this before signing one, and the
 * server must run it before storing one (4): a stored succession that no
 * device takes stops the group at its next roster. Returns the chain extended
 * by it as a StoredChain (frozen, in the stored registry, never an accepted
 * chain), whose record (storedRecord) the server stores next.
 */
export async function checkNextSuccession(
    chain: AcceptedRosters | StoredChain,
    signed: SignedGroupStatement,
    mlDsaKeys: Record<string, string>,
): Promise<StoredChain> {
    const { body: next, state } = await extend(chain, [], [signed], mlDsaKeys);
    if (next.groupKeyVersion !== chain.groupKeyVersion + 1)
        throw state.refused.get(chain.groupKeyVersion) ?? new CryptoError(NO_SUCCESSION);
    return asStored(next);
}

/*
 * The server's acceptance of the history it stores (group milestone 1b),
 * never a reader's: reached only through the server entry
 * (`@hushos/crypto/group-trust/server`), which alone holds the capability.
 * The version 1 keys it stored when the group was created are the anchor
 * (there is no words check, no pin and no reader), and `cache` is the
 * server's own record from the last statement it stored (storedRecord of a
 * StoredChain), or null to verify from version 1. Every rule a device applies holds;
 * a stored history that conflicts with its own cache is refused. What it
 * returns is a StoredChain, which no seal, opening or verdict takes.
 */
export async function acceptStored(
    input: {
        groupId: string;
        firstKeys: GroupPublicKey;
        rosters: SignedGroupStatement[];
        successions: SignedGroupStatement[];
        mlDsaKeys: Record<string, string>;
        cache: StoredChainCache | null;
    },
    capability: typeof STORED_ACCEPTANCE,
): Promise<StoredChain> {
    if (capability !== STORED_ACCEPTANCE)
        throw new CryptoError('Only the server accepts a stored member list.');
    try {
        return asStored(
            (
                await accept({
                    ...input,
                    anchor: 'stored',
                    pins: [],
                    me: null,
                    server: true,
                })
            ).body,
        );
    } catch (error) {
        if (error instanceof Fork)
            throw new CryptoError('The stored member list does not continue its own cache.');
        throw error;
    }
}

/*
 * The group pin to write after an accepted chain: the chain's latest roster
 * and group key, the areas' highest marks across every pin held, and the
 * earliest words check (`checkedAt` when there is no pin yet, a newcomer).
 * Every pin given must already be on the chain (acceptRosters with them).
 */
export async function pinAfter(
    pins: GroupPin[],
    chain: AcceptedRosters,
    checkedAt: string,
): Promise<GroupPin> {
    requireAccepted(chain);
    checkTime(checkedAt);
    for (const pin of pins)
        if (
            chain.rosterDigests[checkGroupPin(chain.groupId, pin).rosterVersion - 1] !==
            pin.rosterDigest
        )
            throw new CryptoError('This pin is not on the accepted member list.');
    const areas: Record<string, number> = {};
    for (const pin of pins)
        for (const [workspaceId, version] of Object.entries(pin.areas))
            areas[workspaceId] = Math.max(areas[workspaceId] ?? 0, version);
    const first = chain.groupKeys[0]!;
    const checked = pins.map((pin) => pin.checkedAt).sort()[0];
    return {
        firstEd25519PublicKey: first.ed25519PublicKey,
        firstMlDsaPublicKeyDigest: (await mlDsaDigest(first.mlDsaPublicKey))!,
        checkedAt: checked ?? checkedAt,
        keyVersion: chain.groupKeyVersion,
        groupKeyDigest: chain.groupKeyDigest,
        rosterVersion: chain.roster.rosterVersion,
        rosterDigest: chain.rosterDigest,
        areas,
    };
}

/*
 * Who a succession leaves out (2.5): the `members` holders active on the
 * roster it is tied to that are not among `sealedTo`, the holders the new seed
 * was sealed to. Anyone listed was dropped without being removed: a warning.
 */
export function droppedHolders(roster: Roster, sealedTo: readonly string[]) {
    return roster.members
        .filter((entry) => activeWith(entry, 'members') && !sealedTo.includes(entry.userId))
        .map((entry) => entry.userId);
}

/* Folding in changes (2.4) ------------------------------------------------ */

/* An identity as the server serves it, with the keys statement's hybrid signature. */
export type ServedIdentity = ServedKeys & { keysSignature: string };

/* A roster entry's keys as a pin keeps them (the ML-DSA digest in hex): where a succession walk starts. */
/*
 * Where a succession chain starts from a set of keys an entry named. No key
 * version: an entry's key version is a holder's claim, so it sets no floor
 * for the member's own chain.
 */
function pinnedOf(set: KeySet): PinnedKeys {
    return {
        keyVersion: null,
        encryptionPublicKey: set.encryptionPublicKey,
        signingPublicKey: set.signingPublicKey,
        mlDsaPublicKeyHash: digestHex(set.mlDsaPublicKeyDigest),
    };
}

/*
 * A new member's entry, only from keys this person's devices pinned: a
 * version 3 pin of them, verified (a words check) or first-seen
 * (docs/optional-verification.md 3.3: the keys served when they were let
 * in), and a served identity whose four keys are the pinned ones (the lattice
 * keys by digest) and whose keys statement holds. Never from a pin trusted
 * through a group, which is that group's word. Anything else and nobody is
 * added. Which roles such an entry may carry is the caller's rule (3.6).
 */
export async function newRosterEntry(
    pin: ContactPin,
    served: ServedIdentity,
    options: { roles: GroupRole[]; rosterVersion: number },
): Promise<RosterMember> {
    // A pin trusted through a group is that group's word, not a pin of the newcomer.
    if (pin.trustedVia !== undefined && pin.trustedVia !== null)
        throw new CryptoError('These are not the keys whose words were checked.');
    const trust = await pinTrust(pin);
    if (
        (trust !== 'verified' && trust !== 'seen') ||
        !(await verifyIdentityKeys(pin.userId, served)) ||
        served.encryptionPublicKey !== pin.encryptionPublicKey ||
        served.signingPublicKey !== pin.signingPublicKey ||
        (await keyDigest(decode(served.mlDsaPublicKey, ML_DSA_PUBLIC_KEY_BYTES))) !==
            pin.mlDsaPublicKeyHash ||
        (await keyDigest(decode(served.kemPublicKey, 1184))) !== pin.kemPublicKeyHash
    )
        throw new CryptoError('These are not the keys whose words were checked.');
    return {
        userId: pin.userId,
        keyVersion: served.keyVersion,
        encryptionPublicKey: served.encryptionPublicKey,
        signingPublicKey: served.signingPublicKey,
        mlDsaPublicKeyDigest: digestBase64url(pin.mlDsaPublicKeyHash!),
        kemPublicKeyDigest: digestBase64url(pin.kemPublicKeyHash!),
        status: 'active',
        roles: [...options.roles].sort(),
        sinceVersion: options.rosterVersion,
    };
}

/*
 * The creator's own entry on roster version 1 (`sinceVersion` 1), and for
 * nothing else: no one pins themselves, so newRosterEntry does not apply, and
 * every later change to one's own entry is a fold-in (foldInEntry).
 * `identity` is the account's own current identity as its device opened it
 * (publicIdentity of the envelope verifyOwnIdentity checked). Its keys
 * statement must hold under `userId`, so the entry names a version 2 identity
 * whose four keys belong together, the lattice keys by digest; anything else
 * and no entry is made. It does not prove the identity is the caller's
 * current one (an earlier identity's statement holds too). Roster version 1's
 * signer signature, which acceptance checks under the keys this entry names,
 * proves the entry and the signer are the same identity; that the identity is
 * the account's newest is the creating client's check (design 3.1: the staged
 * acceptance with freshly fetched own identities reports no wrong or behind
 * own entry).
 */
export async function ownRosterEntry(
    userId: string,
    identity: ServedIdentity,
    options: { roles: GroupRole[] },
): Promise<RosterMember> {
    if (!(await verifyIdentityKeys(userId, identity)))
        throw new CryptoError('These are not this account’s keys.');
    return {
        userId,
        keyVersion: identity.keyVersion,
        encryptionPublicKey: identity.encryptionPublicKey,
        signingPublicKey: identity.signingPublicKey,
        mlDsaPublicKeyDigest: await digest(
            decode(identity.mlDsaPublicKey, ML_DSA_PUBLIC_KEY_BYTES),
        ),
        kemPublicKeyDigest: await digest(decode(identity.kemPublicKey, 1184)),
        status: 'active',
        roles: [...options.roles].sort(),
        sinceVersion: 1,
    };
}

/*
 * An existing entry, folded in before the next roster is signed: unchanged
 * when the served identity is the entry's; moved to the served identity only
 * when its keys statement holds and the member's version 2 succession chain
 * leads from the entry's keys (ML-DSA digest included; not its key version,
 * a holder's claim) to it, however many links that takes; otherwise
 * unchanged, and the member needs a check. The server's word alone never
 * changes an entry.
 */
export async function foldInEntry(
    entry: RosterMember,
    served: ServedIdentity,
    links: SuccessionLink[],
    rosterVersion: number,
): Promise<{ entry: RosterMember; changed: boolean; needsCheck: boolean }> {
    const unchanged = (needsCheck: boolean) => ({ entry, changed: false, needsCheck });
    if (await servedIsEntry(served, entry)) return unchanged(false);
    if (
        !(await verifyIdentityKeys(entry.userId, served)) ||
        // The group walk from the entry's keys, on each link's version 2 signature: the entry is
        // a holder's claim already, and a planter could consent to his own successor anyway.
        (await successionPath(entry.userId, pinnedOf(entry), served, links)).status !== 'path'
    )
        return unchanged(true);
    return {
        entry: {
            ...entry,
            keyVersion: served.keyVersion,
            encryptionPublicKey: served.encryptionPublicKey,
            signingPublicKey: served.signingPublicKey,
            mlDsaPublicKeyDigest: (await mlDsaDigest(served.mlDsaPublicKey))!,
            kemPublicKeyDigest: await digest(decode(served.kemPublicKey, 1184)),
            sinceVersion: rosterVersion,
        },
        changed: true,
        needsCheck: false,
    };
}

/*
 * A group's first roster, for its creator to sign (2.4, 3.1): version 1, no
 * previous digest, under group key 1, the creator as its only entry and its
 * signer (roles sorted, `sinceVersion` 1), and a row at version 1 for each of
 * `areaKeys` (computed here, as nextRoster does: a client never hands in a
 * row of its own making). Refused unless it keeps every rule acceptance holds
 * roster version 1 to, signatures aside: the creator active with `members`,
 * only the kind's roles, no area named twice, no key used twice, at most
 * MAX_FAMILY_AREAS areas. So a creator never signs a first roster that no
 * device, the server included, would take.
 */
export async function firstRoster(
    groupId: string,
    creator: RosterMember,
    options: { kind: GroupKind; areaKeys?: AreaKey[]; format?: RosterFormat },
): Promise<Roster> {
    if (typeof creator !== 'object' || creator === null || !Array.isArray(creator.roles))
        throw new CryptoError('Invalid roster entry.');
    const format = rosterFormat({ format: options.format });
    const roster: Roster = {
        groupId,
        kind: options.kind,
        rosterVersion: 1,
        previousRosterDigest: '',
        groupKeyVersion: 1,
        signerUserId: creator.userId,
        members: [
            {
                userId: creator.userId,
                keyVersion: creator.keyVersion,
                encryptionPublicKey: creator.encryptionPublicKey,
                signingPublicKey: creator.signingPublicKey,
                mlDsaPublicKeyDigest: creator.mlDsaPublicKeyDigest,
                kemPublicKeyDigest: creator.kemPublicKeyDigest,
                status: creator.status,
                roles: [...creator.roles].sort(),
                sinceVersion: 1,
            },
        ],
        areas: await rowsAfter(NOTHING_LISTED, options.areaKeys ?? [], format),
        ...(format === 2 ? { format } : {}),
    };
    const statement = rosterStatement(roster);
    // The very rules acceptance applies to version 1, signatures aside. Unsigned, the group key
    // is never read: the one placeholder says only that the roster is under key 1.
    const state = stateOf(uuid(groupId, 'group id'), {}, null);
    state.keys.push({ ed25519PublicKey: '', mlDsaPublicKey: '' });
    await rosterRules(state, roster, statement, null, undefined);
    return roster;
}

/*
 * The roster after `chain`'s latest, for `signerUserId` to sign: the next
 * version, chained to its digest, under the current group key, members
 * sorted by id with their roles sorted, and each entry's `sinceVersion` set
 * here (the previous one when nothing in the entry changed, this version
 * when anything did). Refused unless every device holding the chain would
 * accept it (checkNext): a holder never signs a roster the group cannot
 * take.
 */
export async function nextRoster(
    chain: AcceptedRosters,
    members: RosterMember[],
    options: {
        signerUserId: string;
        /*
         * The new keys of the areas this roster creates or rotates (areasToRotate says which a
         * removal needs). The rows are computed here (areaRows), and refused when a key is any
         * of the group's earlier ones: a client cannot hand in a row of its own making.
         */
        areaKeys?: AreaKey[];
        /*
         * The areas this roster retires (design 2.10: a deleted family folder), each a tombstone
         * at its next version. Format 2 only.
         */
        retireAreas?: string[];
        /*
         * The format to build: the chain's latest by default; a higher one switches the chain
         * (format 2 keys need their root's key, AreaKey.rootKey); a lower one is refused.
         */
        format?: RosterFormat;
    },
): Promise<Roster> {
    requireAccepted(chain);
    const latest = rosterFormat(chain.roster);
    const format = rosterFormat({ format: options.format ?? latest });
    if (format < latest) throw new CryptoError(DOWNGRADE);
    const areas = await areaRows(chain, options.areaKeys ?? [], {
        format,
        retire: options.retireAreas,
    });
    const version = chain.roster.rosterVersion + 1;
    const roster: Roster = {
        groupId: chain.groupId,
        kind: chain.kind,
        rosterVersion: version,
        previousRosterDigest: chain.rosterDigest,
        groupKeyVersion: chain.groupKeyVersion,
        signerUserId: options.signerUserId,
        members: members
            .map((member) => {
                const entry = { ...member, roles: [...member.roles].sort() };
                const before = rosterEntry(chain.roster, member.userId);
                return {
                    ...entry,
                    sinceVersion:
                        before && sameEntry(before, entry) ? before.sinceVersion : version,
                };
            })
            .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)),
        areas,
        ...(format === 2 ? { format } : {}),
    };
    const statement = rosterStatement(roster);
    // The very rules acceptance applies, from the chain's cache, signatures aside.
    const state = stateOf(chain.groupId, {}, await checkCache(chain.groupId, chain.cache, false));
    await rosterRules(state, roster, statement, null, state.held.at(-1));
    return roster;
}

/*
 * Whether the reader's own entry names their own keys (each member checks on
 * every roster: acceptRosters reports every version where it did not). `absent`
 * when they are not on it.
 */
export async function ownEntry(
    roster: Roster,
    me: { userId: string } & ServedKeys,
): Promise<'ok' | 'absent' | 'wrong'> {
    const entry = rosterEntry(roster, me.userId);
    if (!entry) return 'absent';
    return (await servedIsEntry(me, entry)) ? 'ok' : 'wrong';
}

/*
 * "Trust as Acme does" (2.8): a version 3 personal pin written from the
 * member's active entry on the accepted roster and the served identity that
 * matches it (all four keys, the lattice ones by digest, and its keys
 * statement), as an explicit act by the reader. The roster's own trust never
 * leaves its group; this pin does.
 */
export async function trustAsGroupDoes(
    chain: AcceptedRosters,
    userId: string,
    served: ServedIdentity,
    contact: { email: string; name: string; pinnedAt: string },
): Promise<ContactPin> {
    requireAccepted(chain);
    const entry = rosterEntry(chain.roster, userId);
    if (
        !entry ||
        !activeWith(entry) ||
        !(await servedIsEntry(served, entry)) ||
        !(await verifyIdentityKeys(entry.userId, served))
    )
        throw new CryptoError('These are not the keys on the group’s member list.');
    return {
        userId: entry.userId,
        email: contact.email,
        name: contact.name,
        keyVersion: entry.keyVersion,
        pinnedAt: contact.pinnedAt,
        encryptionPublicKey: entry.encryptionPublicKey,
        signingPublicKey: entry.signingPublicKey,
        mlDsaPublicKeyHash: digestHex(entry.mlDsaPublicKeyDigest),
        kemPublicKeyHash: digestHex(entry.kemPublicKeyDigest),
        fingerprint: await fingerprint(
            decode(entry.encryptionPublicKey, 32),
            decode(entry.signingPublicKey, 32),
            decode(entry.mlDsaPublicKeyDigest, 32),
            decode(entry.kemPublicKeyDigest, 32),
        ),
        trustedVia: chain.groupId,
    };
}

/* Scoped verdicts (2.8) --------------------------------------------------- */

/* What the reader knows of a group's roster: accepted, forked, or not loaded or not verified. */
export type GroupReading =
    | { status: 'accepted'; chain: AcceptedRosters }
    | { status: 'fork' }
    | { status: 'unavailable' };

/*
 * Whose key a writer's signature in a group's area is checked under:
 * - outside: the roster does not speak here (another workspace, a writer not
 *   on it, or a fork): use the personal verdicts, as without groups;
 * - unchecked: the roster, or what a disagreeing pin needs checking against,
 *   did not load or verify; fails closed;
 * - roster: the roster's key for them, `via` the group when no personal pin
 *   agreed with it already, `followed` the identity the reader's pin should
 *   now follow. When the writer has replaced their identity and no roster has
 *   folded it in yet, their served identity is current instead, if their
 *   succession chain leads to it from the entry's keys. Earlier keys are
 *   retired only along links the chain verifier followed to the served
 *   identity: from the reader's personal pin when there is one, otherwise from
 *   the entry's keys and from the member's first set of keys on the chain
 *   (the one a words check admitted), never a set a holder wrote in later;
 * - key-conflict: the reader's personal pin differs and no chain joins them;
 * - former-member: their entry is `left`.
 * `linksLoaded` is false when the writer's served identity or succession
 * links did not load: a signature their known keys do not hold then reads as
 * unchecked, not bad, since the key it needs may be on the chain not loaded.
 */
export type GroupWriterTrust =
    | { trust: 'outside' }
    | { trust: 'unchecked' }
    | {
          trust: 'roster';
          signer: TrustedSigner;
          via: string | null;
          followed: ServedKeys | null;
          linksLoaded: boolean;
      }
    | { trust: 'key-conflict' }
    | { trust: 'former-member'; signer: TrustedSigner; linksLoaded: boolean };

/*
 * The keys a verified succession chain retired on the way from `from` to the
 * served identity: `from`'s and each verified link's new key but the last.
 * Only the links the verifier returned count, never whatever else was served
 * beside them.
 */
function retiredAlong(from: PinnedKeys, chain: SuccessionLink[]) {
    return [
        decode(from.signingPublicKey, 32),
        ...chain.slice(0, -1).map((link) => decode(link.newSigningPublicKey, 32)),
    ];
}

/* The links of `chain` up to and including the one leading to `keys`; null when none does. */
async function upTo(chain: SuccessionLink[], keys: PinnedKeys) {
    for (let index = 0; index < chain.length; index++) {
        const link = chain[index]!;
        if (
            link.newEncryptionPublicKey === keys.encryptionPublicKey &&
            link.newSigningPublicKey === keys.signingPublicKey &&
            sameKeyDigest(
                keys.mlDsaPublicKeyHash,
                (await mlDsaDigest(link.newMlDsaPublicKey)) ?? '',
            )
        )
            return chain.slice(0, index + 1);
    }
    return null;
}

/*
 * The keys before `pinned` on a verified chain from `from`: when the reader's
 * pin is at one of the member's later identities on that chain, the keys the
 * member had before it are their earlier keys too. Nothing when the chain
 * does not pass through the pinned keys.
 */
async function retiredBefore(from: PinnedKeys, chain: SuccessionLink[], pinned: PinnedKeys) {
    for (let index = 0; index < chain.length; index++) {
        const link = chain[index]!;
        if (
            link.newEncryptionPublicKey === pinned.encryptionPublicKey &&
            link.newSigningPublicKey === pinned.signingPublicKey &&
            sameKeyDigest(
                pinned.mlDsaPublicKeyHash,
                (await mlDsaDigest(link.newMlDsaPublicKey)) ?? '',
            )
        )
            return retiredAlong(from, chain.slice(0, index + 1));
    }
    return [];
}

/*
 * A reader's pin of a writer, as group verdicts take it: its keys and its
 * origin together, so a caller cannot pass the keys and drop the origin.
 * `trustedVia` is the group the pin was trusted through ("Trust as Acme
 * does", trustAsGroupDoes), null for a pin from the reader's own words check.
 * Such a pin is no anchor of the reader's own: links from it need the
 * successor's consent up to the entry's keys, wherever its keys sit in the
 * member's history. An empty `trustedVia` is no origin at all: unchecked.
 */
export type WriterPin = PinnedKeys & { trustedVia: string | null };

export async function groupWriterTrust(input: {
    groupId: string;
    /* The group pin's areas: the workspaces a verified grant tied to this group. */
    areas: Record<string, number>;
    reading: GroupReading;
    workspaceId: string;
    writerUserId: string;
    /* The reader's verified version 3 pin of the writer, with where it came from; null for none. */
    pinned: WriterPin | null;
    /* The writer's identity as served and all their succession links; null when they did not load. */
    served: ServedKeys | null;
    links: SuccessionLink[] | null;
    /*
     * A verification cache to share across calls (a session's), keyed by the SHA-256 of member,
     * proof and link and bounded (successionPath), so each record read does not verify the same
     * links again.
     */
    verified?: Map<string, boolean>;
}): Promise<GroupWriterTrust> {
    if (!Object.hasOwn(input.areas, input.workspaceId)) return { trust: 'outside' };
    if (input.reading.status === 'unavailable') return { trust: 'unchecked' };
    if (input.reading.status === 'fork') return { trust: 'outside' };
    const { chain } = input.reading;
    requireAccepted(chain);
    if (chain.groupId !== input.groupId) return { trust: 'unchecked' };
    const entry = rosterEntry(chain.roster, input.writerUserId);
    if (!entry) return { trust: 'outside' };
    const { pinned } = input;
    if (pinned && (pinned.trustedVia === '' || pinned.trustedVia === undefined))
        return { trust: 'unchecked' };
    let { served, links } = input;
    const verified = input.verified ?? new Map<string, boolean>();
    let forked = false;
    let overflow = false;
    const own = keySetOf(entry);
    const history = chain.keyHistory[entry.userId] ?? [];
    const path = async (from: PinnedKeys, fromFirstKeys = false, consent = fromFirstKeys) => {
        if (!served || !links) return null;
        const found = await successionPath(input.writerUserId, from, served, links, {
            verified,
            // Only links the successor consented to, up to the entry's keys: from the first keys,
            // and from a pin of keys a holder wrote into an entry later (`consent`).
            consentUntil: consent ? pinnedOf(own) : null,
            memberKeys: history.map(pinnedOf),
        });
        // An identity fork, or a served identity a verified link has already left (rolled back):
        // nothing tells which identity is the member's now. More links than anyone has is no
        // verdict on the member (their keys are public, so anyone can serve them): the links are
        // read as not loaded. On the walk from the first keys either only voids that walk:
        // whoever holds the first keys (a holder who planted them) could otherwise turn every
        // verdict of the member unchecked.
        if (!fromFirstKeys && (found.status === 'fork' || found.status === 'stale')) forked = true;
        if (!fromFirstKeys && found.status === 'too-many') overflow = true;
        return found.status === 'path' ? found.links : null;
    };
    const first = chain.keyHistory[entry.userId]?.[0];
    let fromFirst = first && !sameKeySet(first, own) ? await path(pinnedOf(first), true) : null;
    // The first keys' chain counts only up to the entry's keys: past them it is no evidence that
    // the first keys were the member's (a planter consents to his own successor).
    let toEntry = fromFirst ? await upTo(fromFirst, pinnedOf(own)) : null;
    // A succession no roster has folded in yet: from the entry's keys to the served identity.
    // (A chain from the entry's keys never ends at the entry itself, so this is a change.)
    let lag = await path(pinnedOf(own));
    // A pin trusted through a group is the group's word, not the reader's: links from it need
    // the successor's consent up to the entry's keys, as from the first keys.
    let fromPin = pinned ? await path(pinned, false, pinned.trustedVia !== null) : null;
    // Two successions the member signed from one key, or a served identity the member has already
    // replaced: nothing tells which identity is theirs now.
    if (forked) return { trust: 'unchecked' };
    // Too many links on the lag or pin walk: as if the links had not loaded. The entry's key
    // stays current, nothing is retired, and a signature under an unknown key reads unchecked.
    if (overflow) {
        served = null;
        links = null;
        fromFirst = toEntry = lag = fromPin = null;
    }
    const linksLoaded = served !== null && links !== null;
    const lagging = lag !== null;
    const retired: Uint8Array[] = [];
    const retire = (keys: Uint8Array[]) => {
        for (const key of keys) retired.push(key);
    };
    if (pinned) {
        // A reader with a personal pin retires keys along the chain from that pin, and, before
        // it, along the member's chain from their entry or first keys up to the pinned keys.
        if (fromPin) retire(retiredAlong(pinned, fromPin));
        if (lag) retire(await retiredBefore(pinnedOf(own), lag, pinned));
        if (toEntry) {
            const beforePin = await retiredBefore(pinnedOf(first!), toEntry, pinned);
            // A pin past the entry's keys: every first-chain key before the entry is before it.
            if (beforePin.length) retire(beforePin);
            else if ((await retiredBefore(pinnedOf(first!), fromFirst!, pinned)).length)
                retire(retiredAlong(pinnedOf(first!), toEntry));
        }
    } else {
        if (lag) retire(retiredAlong(pinnedOf(own), lag));
        // Earlier keys count only along a verified chain from the member's first set of keys on
        // the chain, the one a words check admitted, to their entry's: never from a set a holder
        // wrote in later, and never past the entry.
        if (toEntry) retire(retiredAlong(pinnedOf(first!), toEntry));
    }
    const signer: TrustedSigner = {
        current: decode(lagging ? served!.signingPublicKey : entry.signingPublicKey, 32),
        retired,
    };
    // A former member still holds their keys, and a signature has no trustworthy date. Marked
    // before any personal pin is consulted: inside the group's areas, leaving is what matters.
    if (entry.status === 'left') return { trust: 'former-member', signer, linksLoaded };
    const agrees = (
        keys: { encryptionPublicKey: string; signingPublicKey: string },
        digest: string,
    ) =>
        pinned !== null &&
        pinned.encryptionPublicKey === keys.encryptionPublicKey &&
        pinned.signingPublicKey === keys.signingPublicKey &&
        sameKeyDigest(pinned.mlDsaPublicKeyHash, digest);
    if (!pinned)
        return { trust: 'roster', signer, via: chain.groupId, followed: null, linksLoaded };
    // The pin agrees with the entry (then follows a succession no roster has folded in yet), or
    // with that succession's identity already.
    // A pin trusted through a group is that group's word, not the reader's own check.
    const via = pinned.trustedVia ?? null;
    if (agrees(entry, entry.mlDsaPublicKeyDigest))
        return {
            trust: 'roster',
            signer,
            via,
            followed: lagging ? served : null,
            linksLoaded,
        };
    if (served && lagging && agrees(served, (await mlDsaDigest(served.mlDsaPublicKey))!))
        return { trust: 'roster', signer, via, followed: null, linksLoaded };
    // Without what the pin needs checking against, nothing is known to disagree.
    if (!served || !links) return { trust: 'unchecked' };
    // A legitimate succession, not a conflict: the keys it replaced, from the pinned one on, only
    // ever vouch as retired.
    // (Keys only: the served version is unsigned here, so it never decides a conflict.)
    if (((await servedKeysAreEntry(served, entry)) || lagging) && fromPin)
        return { trust: 'roster', signer, via: chain.groupId, followed: served, linksLoaded };
    return { trust: 'key-conflict' };
}

/* A record's verdict inside a group's areas, beyond the personal ones: a key conflict, or a former member's. */
export type GroupIntegrity = Integrity | 'key-conflict' | 'former-member';

/*
 * What a reader shows for one record in light of `trust` (groupWriterTrust):
 * outside the roster's reach the personal verdict under `personal`; a roster
 * key gives integrityOf's verdicts, `verified` carrying `via` when the roster
 * vouched; a former member's valid signature is `former-member`, drawn as
 * Unverified; a key conflict is worse than Unverified; and an unchecked
 * roster never reads as clean. A signature none of the writer's keys holds is
 * bad when their served identity and links loaded, and unchecked when they
 * did not (a key their chain retired may be the one missing).
 */
export async function groupIntegrityOf(
    statements: () => Promise<StatementForms>,
    signature: Uint8Array | null,
    trust: GroupWriterTrust,
    personal: TrustedSigner | null,
): Promise<{ integrity: GroupIntegrity; via: string | null }> {
    return groupVerdictOf(trust, personal, !!signature, (signer) =>
        integrityOf(statements, signature, signer),
    );
}

/* groupIntegrityOf over any check of one signature under the keys it is given (Rust's group_integrity). */
async function groupVerdictOf(
    trust: GroupWriterTrust,
    personal: TrustedSigner | null,
    signed: boolean,
    check: (signer: TrustedSigner | null) => Promise<Integrity>,
): Promise<{ integrity: GroupIntegrity; via: string | null }> {
    // No signature is unsigned whatever the roster says: an unloaded roster must not hide a stripped one.
    if (!signed) return { integrity: 'unsigned', via: null };
    // Without the writer's served identity and links, a key their chain retired may be missing.
    const unknown = (integrity: Integrity, linksLoaded: boolean): Integrity =>
        integrity === 'bad-signature' && !linksLoaded ? 'unchecked' : integrity;
    switch (trust.trust) {
        case 'outside':
            return { integrity: await check(personal), via: null };
        case 'unchecked':
            return { integrity: 'unchecked', via: null };
        case 'key-conflict':
            return { integrity: 'key-conflict', via: null };
        case 'former-member': {
            const integrity = unknown(await check(trust.signer), trust.linksLoaded);
            const valid = ['verified', 'seen', 'saved-from-link', 'resealed', 'retired-key'];
            return {
                integrity: valid.includes(integrity) ? 'former-member' : integrity,
                via: null,
            };
        }
        case 'roster': {
            const integrity = unknown(await check(trust.signer), trust.linksLoaded);
            const vouched = integrity === 'verified' || integrity === 'saved-from-link';
            return { integrity, via: vouched ? trust.via : null };
        }
    }
}

/*
 * Whose keys a re-keyed record's two signatures are checked under in a
 * group's area: groupWriterTrust for the origin's signer and for the
 * re-keyer, and the personal keys the reader trusts for each (outside the
 * roster's reach).
 */
export type GroupRekeyedTrust = {
    origin: GroupWriterTrust;
    originPersonal: TrustedSigner | null;
    rekeyer: GroupWriterTrust;
    rekeyerPersonal: TrustedSigner | null;
};
export type GroupVerdictWithVia = { integrity: GroupIntegrity; via: string | null };
/*
 * A re-keyed record in a group's area, as RekeyedVerdict says: the origin's
 * verdict in light of the origin signer's trust (so a removed member's file
 * reads `former-member`, named after them, never as the re-keyer's) when
 * `bound` is true, `bad-signature` when it is false, `unchecked` when null;
 * and the re-keyer's in light of theirs. A missing or bad re-key signature,
 * or a re-keyer in key conflict, is an Unverified mark, never a mismatch on
 * its own.
 */
export type GroupRekeyedVerdict = {
    origin: GroupVerdictWithVia;
    rekeyer: GroupVerdictWithVia;
    bound: boolean | null;
};

/*
 * rekeyedIntegrityOf in a group's area. `nodeKey` is the node's key at the
 * record's epoch, null when the reader does not hold it (`unchecked`); a roster
 * that did not load is `{ trust: 'unchecked' }` in `trust`.
 */
export async function groupRekeyedIntegrityOf(
    record: RekeyedRecord,
    nodeKey: Uint8Array | null,
    trust: GroupRekeyedTrust,
): Promise<GroupRekeyedVerdict> {
    const unchecked = (): GroupRekeyedVerdict => ({
        origin: { integrity: 'unchecked', via: null },
        rekeyer: { integrity: 'unchecked', via: null },
        bound: null,
    });
    if (!nodeKey) return unchecked();
    try {
        const checks = await rekeyedChecks(record, nodeKey);
        // Attested: the re-key signature verified under the current key the group's trust names for them.
        let attested = false;
        const rekeyer = await groupVerdictOf(
            trust.rekeyer,
            trust.rekeyerPersonal,
            checks.rekeySigned,
            async (signer) => {
                const integrity = await checks.rekeyer(signer);
                attested = integrity === 'verified' || integrity === 'seen';
                return integrity;
            },
        );
        const bound = checks.bound(attested);
        if (bound === false)
            return { origin: { integrity: 'bad-signature', via: null }, rekeyer, bound };
        if (bound === null)
            return { origin: { integrity: 'unchecked', via: null }, rekeyer, bound };
        // With no origin signer named, no roster or pin speaks for anyone: judged under no keys at all.
        const origin = checks.originSignerGone
            ? await groupVerdictOf({ trust: 'outside' }, null, checks.originSigned, checks.origin)
            : await groupVerdictOf(
                  trust.origin,
                  trust.originPersonal,
                  checks.originSigned,
                  checks.origin,
              );
        return { origin, rekeyer, bound };
    } catch {
        return unchecked();
    }
}
