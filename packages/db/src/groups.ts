import { createHash } from 'node:crypto';
import { billingEnv } from '@hushos/env/billing';
import { and, count, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from './client';
import {
    activeRotation,
    createRootIn,
    nextChangeSeq,
    selectNodes,
    type NodeEnvelopes,
    type Tx,
} from './drive';
import { madeFor } from './ids';
import { pgCode } from './readiness';
import { unheldWorkspaceCondition } from './reports';
import {
    rootWorkIn,
    rotateNodeIn,
    startRotationIn,
    type RotatedNodeInput,
    type RotationWorkNode,
} from './rotations';
import {
    accountIdentities,
    accountIdentityHistory,
    areaGrants,
    driveLinks,
    driveNodes,
    driveObjectDeletions,
    driveObjects,
    driveRotations,
    driveShares,
    groupAreaCommitments,
    groupChainCaches,
    groupDepartures,
    groupHolds,
    groupInvitations,
    groupKeySeals,
    groupKeySuccessions,
    groupMemberships,
    groupBillingSubscriptions,
    groupRosters,
    groupStorage,
    groups,
    users,
    workspaceDocuments,
    workspaceKeys,
    workspaceStorage,
    workspaces,
    ONE_FAMILY_INDEX,
    type GroupKind,
    type GroupRole,
} from './schema';

/*
 * The group chain's storage (docs/groups-server.md 3): rosters, successions,
 * seals, grants and memberships, written under one lock on the group row.
 *
 * This module never parses a statement and never verifies a signature. The
 * caller (@hushos/groups, phase B) runs the crypto core's checks and hands
 * over a ParsedRoster or ParsedSuccession: the statement's bytes with the
 * fields acceptance parsed from them. What this module owns is what only the
 * database can make true, under the group's lock:
 *
 * - one statement per roster version and per old group key, whatever races;
 * - a compare-and-set on `chain_revision`, so a write checked against one
 *   chain never lands on another (a succession moves the chain without a new
 *   roster version);
 * - a call whose every statement is already stored is a replay, answered
 *   without writing; a call only partly stored is stale;
 * - the seat count, read and taken under the same lock;
 * - the route's diff policy (docs/groups-server.md 6) against the server's
 *   own memberships: who may be added, marked left or given other roles;
 * - whether the roster drops a `members` holder, derived from the stored
 *   roles and compared with acceptance's answer;
 * - departures still to be marked left, which block every other roster;
 * - seals and grants that name a stored roster, an active member and, for
 *   grants, an area of this group;
 * - access that ends with membership: grants, seals, self-grants, and the
 *   shares and links in the group's areas;
 * - one family per account (docs/families-shared-pool.md 4): creating,
 *   accepting into or being admitted to a second family is `in-family`,
 *   checked under the lock and held by group_memberships_one_family_idx.
 *
 * Every refusal rolls back everything the call wrote.
 */

/* SHA-256 of a statement's bytes: the digest a roster or succession is named by. */
export function statementDigest(statement: Uint8Array) {
    return createHash('sha256').update(statement).digest();
}

export type SignedStatementInput = {
    statement: Buffer;
    ed25519Signature: Buffer;
    mlDsaSignature: Buffer;
    signerSignature: Buffer;
};

/* A roster entry the roster changed (`sinceVersion` is its version), as parsed. */
export type EntryChange = { userId: string; status: 'active' | 'left'; roles: GroupRole[] };

/*
 * Brands only @hushos/groups mints: after the crypto core accepted the
 * statement, it casts the parse to these types, and that cast is the only one
 * allowed outside this package's tests. Nothing here can tell a parse from a
 * request body, so the type is what keeps a route from filling `changes` or
 * `signerUserId` from what a client sent. The symbol is not exported, so no
 * other module can name the property and build one without the cast.
 */
declare const parsed: unique symbol;

/* A roster as the crypto core parsed it. */
export type ParsedRoster = SignedStatementInput & {
    version: number;
    previousDigest: Buffer | null;
    groupKeyVersion: number;
    signerUserId: string;
    /* The ML-DSA key the signer's identity signature verified under. */
    signerMlDsaPublicKey: Buffer;
    /* Every entry new or changed at this version, as parsed. */
    changes: EntryChange[];
    /* Acceptance's own answer: whether it takes `members` from someone active before. */
    dropsHolder: boolean;
    /*
     * Every area key and root commitment the roster's key rows list, as parsed (32 bytes
     * each): refused when another group's roster listed one already (recordCommitments).
     */
    commitments?: Buffer[];
    readonly [parsed]: 'roster';
};

/* A group key succession as the crypto core parsed it. */
export type ParsedSuccession = SignedStatementInput & {
    oldVersion: number;
    newVersion: number;
    lastRosterVersion: number;
    lastRosterDigest: Buffer;
    newEd25519PublicKey: Buffer;
    newMlDsaPublicKey: Buffer;
    signerUserId: string;
    signerMlDsaPublicKey: Buffer;
    readonly [parsed]: 'succession';
};

export type SealInput = {
    groupKeyVersion: number;
    holderUserId: string;
    holderKeyVersion: number;
    sealerUserId: string;
    rosterVersion: number;
    rosterDigest: Buffer;
    envelope: Buffer;
};

export type GrantInput = {
    workspaceId: string;
    workspaceKeyVersion: number;
    granteeUserId: string;
    granteeKeyVersion: number;
    granterUserId: string;
    rosterVersion: number;
    rosterDigest: Buffer;
    envelope: Buffer;
};

/* An area's key wrapped under the uploader's own account root, as for a personal workspace. */
export type SelfGrantInput = Omit<typeof workspaceKeys.$inferInsert, 'userId' | 'workspaceId'>;

/* A new area: its workspace, the quota it starts with, and its creator's self-grant. */
export type AreaInput = {
    workspaceId: string;
    idSeed: string;
    quotaBytes: bigint;
    selfGrant: SelfGrantInput;
    /*
     * The area's root folder, at key epoch 1 under workspace key version 1,
     * signed by the creator: it lands with the area, so an area never exists
     * without its root.
     */
    root?: { id: string; envelopes: NodeEnvelopes };
    /* The most areas the group may have (GROUP_AREA_LIMIT), counted under the group's lock. */
    limit?: number;
};

/*
 * A rotation of an area's key (docs/groups-server.md 4, route 24, and every
 * roster that marks someone left in a family): the area moves from
 * `fromVersion` to `toVersion`, and its root gets a new node key under the new
 * workspace key in the same transaction (a drive rotation starts at
 * `targetEpoch`, which the rotator drew with allocateKeyEpochs and sealed the
 * root's key under), so a cached root key opens nothing written after it. The
 * rest of the subtree rotates through Drive's rotation batches.
 *
 * `previousRootKeyEnvelope` is the root's old key (the one its unrotated
 * children are still wrapped under) wrapped again under the new area key, at
 * the root's old key epoch and parent epoch `toVersion` (docs/groups-server.md
 * 8, "Old area keys during a rotation"). It is stored as the root's previous
 * envelope, so a member who holds only the current area key (a fresh device,
 * someone admitted mid-walk) can still open what the walk has not reached.
 * The removed member already holds that old key, so it tells them nothing.
 *
 * `documents` are the area's workspace documents (the tags registry, ...)
 * sealed again under the new area key: one per document the area holds, each
 * naming the version the rotator read and stored at the next, as a document
 * write would (docs/groups-server.md 8, "Workspace documents ride on the
 * rotation"). Nothing re-seals them after the roster lands.
 */
export type RotationInput = {
    workspaceId: string;
    fromVersion: number;
    toVersion: number;
    targetEpoch: number;
    root: RotatedNodeInput;
    previousRootKeyEnvelope: Buffer;
    selfGrant: SelfGrantInput;
    documents: RotationDocumentInput[];
};

/* A workspace document re-sealed under a rotation's new area key, for `version + 1`. */
export type RotationDocumentInput = { kind: string; version: number; envelope: Buffer };

/*
 * Which route the write comes from, and so which roster changes it may make
 * (docs/groups-server.md 6). Every route allows fold-ins (an entry moving to
 * its member's newer identity, roles unchanged) and marking left those the
 * server already has as gone.
 */
export type ChainRoute =
    /* POST rosters: nothing more. */
    | { kind: 'roster' }
    /* Admit: the accepted person becomes active, with roles within their invitation's. */
    | { kind: 'admit'; userId: string; seatLimitDefault: number }
    /* PATCH member: the target's roles, and only theirs. */
    | { kind: 'member'; userId: string }
    /* Remove: the active target is marked left. */
    | { kind: 'remove'; userId: string }
    /* A new area, listed at version 1 on the roster. */
    | { kind: 'area'; area: AreaInput }
    /* An area's key rotation, listed on the roster at the next version. */
    | { kind: 'rotation' }
    /* A family folder's deletion: its tombstone on the roster (docs/groups-design.md 2.10). */
    | { kind: 'retire'; workspaceId: string }
    /* A succession on its own, no roster. */
    | { kind: 'succession' };

export type Head = {
    rosterVersion: number;
    rosterDigest: Buffer;
    groupKeyVersion: number;
    revision: number;
};

export type StoredRoster = typeof groupRosters.$inferSelect;
export type StoredSuccession = typeof groupKeySuccessions.$inferSelect;

export type ChainResult =
    | ({ status: 'ok' | 'replayed' } & Head)
    /* The chain moved: the head, and the stored winner at the contested version or old key. */
    | {
          status: 'stale';
          head: Head;
          roster: StoredRoster | null;
          succession: StoredSuccession | null;
      }
    | { status: 'seats'; used: number; limit: number }
    /* Departures still to be marked left: no other roster lands first. */
    | { status: 'left-due'; userIds: string[] }
    /*
     * A Drive rotation in the area has re-keyed nodes already: closing it would lose the key
     * those nodes sit under. Finish it (any member may do the work), then resend.
     */
    | {
          status: 'rotating';
          workspaceId: string;
          rotationId: string;
          nodeId: string;
          targetEpoch: number;
      }
    /*
     * Workspace documents of the rotated areas not at the version the rotation names, or
     * left out of it: every one in `stale`, the first also as `workspaceId` and `kind`.
     * Re-read them, re-seal, resend with the same roster bytes.
     */
    | {
          status: 'document-stale';
          workspaceId: string;
          kind: string;
          stale: { workspaceId: string; kind: string }[];
      }
    | {
          status:
              | 'not-member'
              | 'succession-due'
              | 'not-pending'
              | 'forbidden'
              | 'unavailable'
              /* The target epoch the rotator drew is no longer above every node's: redraw it. */
              | 'epoch-stale'
              /* An area root a rotation re-keys changed since it was read: re-read it. */
              | 'root-moved'
              /*
               * The area root still carries a previous envelope: a key change is under way that
               * no running Drive rotation accounts for. Re-read the area; an operator clears it.
               */
              | 'root-mid-rotation';
      }
    /*
     * Membership moved under the call (someone left, was declined or deleted
     * their account) in a way the call did not make: re-read and rebuild, never
     * resend the same bytes (docs/groups-server.md 3).
     */
    | { status: 'members-changed'; reason: string }
    /* The group already has as many areas as the instance allows. */
    | { status: 'area-limit'; limit: number }
    /* The person being admitted is in another family now (one family per account). */
    | { status: 'in-family' }
    | { status: 'invalid'; reason: string };

/* Thrown inside a transaction to roll it back; carries the result out. */
class Refusal extends Error {
    constructor(readonly result: unknown) {
        super('refused');
    }
}
const refuse = (result: unknown): never => {
    throw new Refusal(result);
};
const invalid = (reason: string): never => refuse({ status: 'invalid', reason });
const membersChanged = (reason: string): never => refuse({ status: 'members-changed', reason });

/* Whether `error` is a deadlock or serialization failure: retryable, answered `unavailable`. */
function transient(error: unknown) {
    const code = pgCode(error);
    return code === '40P01' || code === '40001';
}

/* The constraint a Postgres error names, through the query wrapper that carries it. */
function pgConstraint(error: unknown): string | undefined {
    for (
        let current = error, depth = 0;
        current && typeof current === 'object' && depth < 3;
        depth++
    ) {
        const { constraint, cause } = current as { constraint?: unknown; cause?: unknown };
        if (typeof constraint === 'string') return constraint;
        current = cause;
    }
    return undefined;
}

/* The two keys whose violation means another writer took the same place: stale, not invalid. */
const RACE_KEYS = new Set(['group_rosters_pkey', 'group_key_successions_pkey']);

/*
 * Runs `work`, turning a Refusal into its result and database errors into
 * answers: a race on a roster or succession key goes to `onRace`; the
 * one-family index to `onFamily`, for the callers that can hit it; any other
 * unique or foreign key is `invalid`, named by its constraint (a client that
 * re-signed on a stale answer for those would loop for ever); a deadlock or a
 * serialization failure is `unavailable`, which a client retries.
 */
async function answering<T>(
    work: () => Promise<T>,
    onRace: (constraint: string) => Promise<T>,
    onFamily?: () => T,
): Promise<T> {
    try {
        return await work();
    } catch (error) {
        if (error instanceof Refusal) return error.result as T;
        const code = pgCode(error);
        const constraint = pgConstraint(error) ?? 'unknown';
        if (code === '23505' && RACE_KEYS.has(constraint)) return onRace(constraint);
        // Another family took the person between the check and the write: the index is the backstop.
        if (code === '23505' && constraint === ONE_FAMILY_INDEX && onFamily) return onFamily();
        // The constraint's name stays here: it is schema, not something a client acts on.
        if (code === '23505') return { status: 'invalid', reason: 'taken' } as T;
        if (code === '23503') return { status: 'invalid', reason: 'reference' } as T;
        if (code === '23514') return { status: 'invalid', reason: 'shape' } as T;
        if (transient(error)) return { status: 'unavailable' } as T;
        throw error;
    }
}

function headOf(group: typeof groups.$inferSelect): Head {
    return {
        rosterVersion: group.rosterVersion,
        rosterDigest: group.rosterDigest,
        groupKeyVersion: group.groupKeyVersion,
        revision: group.chainRevision,
    };
}

async function storedRoster(tx: Tx | typeof db, groupId: string, version: number) {
    const [row] = await tx
        .select()
        .from(groupRosters)
        .where(and(eq(groupRosters.groupId, groupId), eq(groupRosters.version, version)));
    return row ?? null;
}

async function storedSuccession(tx: Tx | typeof db, groupId: string, oldVersion: number) {
    const [row] = await tx
        .select()
        .from(groupKeySuccessions)
        .where(
            and(
                eq(groupKeySuccessions.groupId, groupId),
                eq(groupKeySuccessions.oldVersion, oldVersion),
            ),
        );
    return row ?? null;
}

/* What a loser of a race is handed: the head as it now is, and the winner it lost to. */
async function staleResult(
    tx: Tx | typeof db,
    groupId: string,
    roster: { version: number } | undefined,
    succession: { oldVersion: number } | undefined,
): Promise<ChainResult> {
    const [group] = await tx.select().from(groups).where(eq(groups.id, groupId));
    if (!group || group.dissolvedAt) return { status: 'not-member' };
    return {
        status: 'stale',
        head: headOf(group),
        roster: roster ? await storedRoster(tx, groupId, roster.version) : null,
        succession: succession ? await storedSuccession(tx, groupId, succession.oldVersion) : null,
    };
}

function rosterRow(groupId: string, roster: ParsedRoster, digest: Buffer) {
    return {
        groupId,
        version: roster.version,
        digest,
        previousDigest: roster.previousDigest,
        groupKeyVersion: roster.groupKeyVersion,
        signerUserId: roster.signerUserId,
        signerMlDsaPublicKey: roster.signerMlDsaPublicKey,
        statement: roster.statement,
        ed25519Signature: roster.ed25519Signature,
        mlDsaSignature: roster.mlDsaSignature,
        signerSignature: roster.signerSignature,
    };
}

/*
 * A roster's area and root commitments, kept across groups (design 2.10): one
 * already listed by another group's roster refuses the write, so no family
 * folder's key, or top folder's key, is ever another group's. Within a group
 * the core refuses a repeat before this is reached.
 */
async function recordCommitments(tx: Tx, groupId: string, roster: ParsedRoster) {
    const commitments = roster.commitments ?? [];
    if (commitments.length === 0) return;
    const stored = await tx
        .insert(groupAreaCommitments)
        .values(
            commitments.map((commitment) => ({
                commitment,
                groupId,
                rosterVersion: roster.version,
            })),
        )
        .onConflictDoNothing()
        .returning({ commitment: groupAreaCommitments.commitment });
    if (stored.length !== commitments.length) invalid('area-commitment');
}

async function writeCache(tx: Tx, groupId: string, revision: number, cache: unknown) {
    await tx
        .insert(groupChainCaches)
        .values({ groupId, chainRevision: revision, cache })
        .onConflictDoUpdate({
            target: groupChainCaches.groupId,
            set: { chainRevision: revision, cache, updatedAt: new Date() },
        });
}

async function lockGroup(tx: Tx, groupId: string) {
    const [group] = await tx.select().from(groups).where(eq(groups.id, groupId)).for('update');
    return group && !group.dissolvedAt ? group : null;
}

/* Active members of the group among `userIds`, with their roles. */
async function activeMembers(tx: Tx, groupId: string, userIds: string[]) {
    if (userIds.length === 0) return new Map<string, GroupRole[]>();
    const rows = await tx
        .select({ userId: groupMemberships.userId, roles: groupMemberships.roles })
        .from(groupMemberships)
        .where(
            and(
                eq(groupMemberships.groupId, groupId),
                inArray(groupMemberships.userId, userIds),
                eq(groupMemberships.state, 'active'),
            ),
        );
    return new Map(rows.map((row) => [row.userId, row.roles]));
}

/*
 * The family `userId` is an active member of, other than `except`: what the
 * one-family index counts (every active family row, dissolved or not, though
 * a dissolved family has none: its last member left it). Null when none.
 */
async function activeFamily(tx: Tx | typeof db, userId: string, except?: string) {
    const [row] = await tx
        .select({ groupId: groups.id, name: groups.name })
        .from(groupMemberships)
        .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
        .where(
            and(
                eq(groupMemberships.userId, userId),
                eq(groupMemberships.groupKind, 'family'),
                eq(groupMemberships.state, 'active'),
                except ? ne(groupMemberships.groupId, except) : undefined,
            ),
        )
        .limit(1);
    return row ?? null;
}

/* The account's family (one at most), with its name: for route checks and the join page. */
export async function familyOf(userId: string) {
    return activeFamily(db, userId);
}

/*
 * Whether someone waiting to join `groupId` (accepted, not admitted) is
 * active in another family: route 17 asks before it charges for a place, and
 * only after the caller is known to manage the group, so it tells nobody else.
 */
export async function waitingButInFamily(groupId: string, userId: string) {
    const [row] = await db
        .select({ state: groupMemberships.state })
        .from(groupMemberships)
        .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, userId)));
    if (row?.state !== 'accepted') return false;
    return (await activeFamily(db, userId, groupId)) !== null;
}

/*
 * Refuses a seal or grant naming a key version above its recipient's current
 * identity: a version they have not reached would win every later overwrite
 * contest. Checked under the group lock; key versions only rise, so a check
 * that passed holds until commit.
 */
async function refuseFutureKeys(tx: Tx, pairs: [string, number][], reason: string) {
    const current = new Map(
        (
            await tx
                .select({
                    userId: accountIdentities.userId,
                    keyVersion: accountIdentities.keyVersion,
                })
                .from(accountIdentities)
                .where(
                    inArray(
                        accountIdentities.userId,
                        pairs.map(([userId]) => userId),
                    ),
                )
        ).map((row) => [row.userId, row.keyVersion]),
    );
    for (const [userId, keyVersion] of pairs)
        if (keyVersion > (current.get(userId) ?? 0)) invalid(reason);
}

/*
 * Seals of the group seed: each to an active `members` holder, by the
 * uploader, naming a stored roster (its foreign key) at a key version the
 * group has, for a key version the holder has reached. A holder's seal at
 * that key version is never moved to an older identity of theirs, by anyone;
 * at the same identity it is replaced only by the holder or a `members`
 * holder, so a member cannot overwrite a working seal with one that opens
 * nothing.
 */
async function upsertSeals(
    tx: Tx,
    groupId: string,
    uploader: string,
    uploaderHolds: boolean,
    groupKeyVersion: number,
    seals: readonly SealInput[],
) {
    if (seals.length === 0) return 0;
    const holders = await activeMembers(
        tx,
        groupId,
        seals.map((seal) => seal.holderUserId),
    );
    for (const seal of seals) {
        if (seal.sealerUserId !== uploader) refuse({ status: 'forbidden' });
        if (!holders.get(seal.holderUserId)?.includes('members')) membersChanged('seal-holder');
        if (seal.groupKeyVersion > groupKeyVersion) invalid('seal-key-version');
    }
    await refuseFutureKeys(
        tx,
        seals.map((seal) => [seal.holderUserId, seal.holderKeyVersion]),
        'seal-holder-key-version',
    );
    const stored = await tx
        .insert(groupKeySeals)
        .values(seals.map((seal) => ({ ...seal, groupId })))
        .onConflictDoUpdate({
            target: [
                groupKeySeals.groupId,
                groupKeySeals.groupKeyVersion,
                groupKeySeals.holderUserId,
            ],
            set: {
                holderKeyVersion: sql`excluded.holder_key_version`,
                sealerUserId: sql`excluded.sealer_user_id`,
                rosterVersion: sql`excluded.roster_version`,
                rosterDigest: sql`excluded.roster_digest`,
                envelope: sql`excluded.envelope`,
                updatedAt: new Date(),
            },
            setWhere: sql`excluded.holder_key_version >= ${groupKeySeals.holderKeyVersion} and (excluded.holder_key_version > ${groupKeySeals.holderKeyVersion} or ${groupKeySeals.holderUserId} = ${uploader} or ${uploaderHolds})`,
        })
        .returning({ holder: groupKeySeals.holderUserId });
    return stored.length;
}

/*
 * Grants of area keys: each to an active member, by the uploader, for an area
 * of this group (the composite foreign key) at a key version the area has
 * reached, naming a stored roster, for a key version the grantee has reached.
 * Each identity of the grantee's has its own row, so a grant to a newer one
 * never replaces a grant that opens; a grant to the same identity is replaced
 * only by the grantee or a `members` holder. A member without `members` only
 * fills a gap: their grant is stored only while the grantee has none at all at
 * that area version, since the newest identity's grant is the one served and
 * the one the grants-due gate counts, and a junk one there would hide a
 * working grant from the grantee's devices.
 */
async function upsertGrants(
    tx: Tx,
    groupId: string,
    uploader: string,
    uploaderHolds: boolean,
    grants: readonly GrantInput[],
) {
    if (grants.length === 0) return 0;
    const grantees = await activeMembers(
        tx,
        groupId,
        grants.map((grant) => grant.granteeUserId),
    );
    const areas = new Map(
        (
            await tx
                .select({ id: workspaces.id, version: workspaces.workspaceKeyVersion })
                .from(workspaces)
                .where(
                    and(
                        eq(workspaces.groupId, groupId),
                        // A deleted area is granted no more (docs/groups-design.md 2.10).
                        isNull(workspaces.deletedAt),
                        inArray(
                            workspaces.id,
                            grants.map((grant) => grant.workspaceId),
                        ),
                    ),
                )
        ).map((row) => [row.id, row.version]),
    );
    for (const grant of grants) {
        if (grant.granterUserId !== uploader) refuse({ status: 'forbidden' });
        if (!grantees.has(grant.granteeUserId)) membersChanged('grantee');
        const current = areas.get(grant.workspaceId);
        // Another group's area, or a personal workspace: the foreign key would refuse it too.
        if (current === undefined) invalid('area');
        if (grant.workspaceKeyVersion > current!) invalid('area-key-version');
    }
    await refuseFutureKeys(
        tx,
        grants.map((grant) => [grant.granteeUserId, grant.granteeKeyVersion]),
        'grantee-key-version',
    );
    let writable = grants;
    if (!uploaderHolds) {
        const existing = await tx
            .select({
                workspaceId: areaGrants.workspaceId,
                workspaceKeyVersion: areaGrants.workspaceKeyVersion,
                granteeUserId: areaGrants.granteeUserId,
            })
            .from(areaGrants)
            .where(
                and(
                    eq(areaGrants.groupId, groupId),
                    inArray(
                        areaGrants.granteeUserId,
                        grants.map((grant) => grant.granteeUserId),
                    ),
                ),
            );
        const taken = new Set(
            existing.map(
                (row) => `${row.workspaceId}:${row.workspaceKeyVersion}:${row.granteeUserId}`,
            ),
        );
        writable = grants.filter(
            (grant) =>
                grant.granteeUserId === uploader ||
                !taken.has(
                    `${grant.workspaceId}:${grant.workspaceKeyVersion}:${grant.granteeUserId}`,
                ),
        );
        if (writable.length === 0) return 0;
    }
    const stored = await tx
        .insert(areaGrants)
        .values(writable.map((grant) => ({ ...grant, groupId })))
        .onConflictDoUpdate({
            target: [
                areaGrants.workspaceId,
                areaGrants.workspaceKeyVersion,
                areaGrants.granteeUserId,
                areaGrants.granteeKeyVersion,
            ],
            set: {
                granteeKeyVersion: sql`excluded.grantee_key_version`,
                granterUserId: sql`excluded.granter_user_id`,
                rosterVersion: sql`excluded.roster_version`,
                rosterDigest: sql`excluded.roster_digest`,
                envelope: sql`excluded.envelope`,
            },
            // The same identity's grant: replaced only by the grantee or a `members` holder.
            setWhere: sql`${areaGrants.granteeUserId} = ${uploader} or ${uploaderHolds}`,
        })
        .returning({ grantee: areaGrants.granteeUserId });
    return stored.length;
}

/* A new area of the group: its workspace, its starting quota and the creator's self-grant. */
async function insertArea(tx: Tx, groupId: string, uploader: string, area: AreaInput) {
    if (!madeFor('workspace', groupId, area.workspaceId, area.idSeed)) invalid('area-id');
    if (
        area.selfGrant.workspaceKeyVersion !== undefined &&
        area.selfGrant.workspaceKeyVersion !== 1
    )
        invalid('area-key-version');
    const [taken] = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, area.workspaceId));
    if (taken) invalid('area-taken');
    if (area.limit !== undefined) {
        const [row] = await tx
            .select({ areas: count() })
            .from(workspaces)
            // A deleted area no longer counts (docs/groups-design.md 2.10).
            .where(and(eq(workspaces.groupId, groupId), isNull(workspaces.deletedAt)));
        if ((row?.areas ?? 0) >= area.limit) refuse({ status: 'area-limit', limit: area.limit });
    }
    await tx.insert(workspaces).values({
        id: area.workspaceId,
        ownerKind: 'group',
        groupId,
        areaKind: 'shared',
        idSeed: area.idSeed,
        workspaceKeyVersion: 1,
        // The root's epoch, allocated with the area.
        keyEpochSeq: area.root ? 1 : 0,
    });
    await tx
        .insert(workspaceStorage)
        .values({ workspaceId: area.workspaceId, baseQuotaBytes: area.quotaBytes });
    await tx
        .insert(workspaceKeys)
        .values({ ...area.selfGrant, workspaceId: area.workspaceId, userId: uploader });
    if (area.root) {
        if (area.root.envelopes.keyEpoch !== 1 || area.root.envelopes.parentKeyEpoch !== 1)
            invalid('area-root-epoch');
        const created = await createRootIn(tx, {
            workspaceId: area.workspaceId,
            userId: uploader,
            id: area.root.id,
            envelopes: area.root.envelopes,
        });
        if (created.status !== 'created') invalid(`area-root-${created.status}`);
    }
}

/*
 * A family folder's deletion inside the chain write (docs/groups-design.md
 * 2.10), the roster carrying its tombstone: the area, live and this group's,
 * is marked deleted, so nothing serves it from now on (spaces, Drive, grants,
 * rotations, the area count), no rotation is due for it any more, and every
 * share and link inside it is revoked. Its files stay until
 * purgeDeletedAreas takes them with the rest, after Drive's trash retention.
 * The roster carries no entry change, so no lockAreas ran: the UPDATE takes
 * the area's row lock itself, after the group's, the order Drive writes
 * (nextChangeSeq) and departures take them in.
 */
async function retireArea(tx: Tx, groupId: string, workspaceId: string) {
    const [area] = await tx
        .update(workspaces)
        .set({ deletedAt: new Date(), rotationDueAt: null })
        .where(
            and(
                eq(workspaces.id, workspaceId),
                eq(workspaces.groupId, groupId),
                isNull(workspaces.deletedAt),
            ),
        )
        .returning({ id: workspaces.id });
    if (!area) invalid('area');
    const now = new Date();
    await tx
        .update(driveShares)
        .set({ revokedAt: now, updatedAt: now })
        .where(and(eq(driveShares.workspaceId, workspaceId), isNull(driveShares.revokedAt)));
    await tx
        .update(driveLinks)
        .set({ revokedAt: now })
        .where(and(eq(driveLinks.workspaceId, workspaceId), isNull(driveLinks.revokedAt)));
}

/*
 * An area's key rotation inside the chain write: the area at `fromVersion`,
 * no Drive rotation already running there, the root re-keyed at the target
 * under the new workspace key (its metadata re-sealed and signed by the
 * uploader, its shares and links re-sealed or revoked), the area at
 * `toVersion` and no longer due, and the uploader's self-grant at the new
 * version. Called after lockAreas.
 */
async function applyRotation(tx: Tx, groupId: string, uploader: string, rotation: RotationInput) {
    const [area] = await tx
        .select({ version: workspaces.workspaceKeyVersion })
        .from(workspaces)
        .where(
            and(
                eq(workspaces.id, rotation.workspaceId),
                eq(workspaces.groupId, groupId),
                isNull(workspaces.deletedAt),
            ),
        );
    if (!area) invalid('rotation-area');
    if (area!.version !== rotation.fromVersion || rotation.toVersion !== rotation.fromVersion + 1)
        invalid('rotation-version');
    if (rotation.selfGrant.workspaceKeyVersion !== rotation.toVersion)
        invalid('rotation-self-grant');
    if (!rotation.root.rotated || rotation.root.parentKeyEpoch !== rotation.toVersion)
        invalid('rotation-root');
    const [root] = await tx
        .select({
            id: driveNodes.id,
            keyEpoch: driveNodes.keyEpoch,
            prevKeyEnvelope: driveNodes.prevKeyEnvelope,
        })
        .from(driveNodes)
        .where(and(eq(driveNodes.workspaceId, rotation.workspaceId), isNull(driveNodes.parentId)));
    if (!root || root.id !== rotation.root.id) invalid('rotation-root');
    if (rotation.previousRootKeyEnvelope.length !== 72) invalid('rotation-root-previous');
    /*
     * The rotator's own wrap of the new key first: the Drive writes below check, under
     * the area's lock, that the writer holds the area (requireStillWriter), and a holder
     * may so far have had only a grant of it. The whole call commits or none of it does.
     */
    await tx
        .insert(workspaceKeys)
        .values({ ...rotation.selfGrant, workspaceId: rotation.workspaceId, userId: uploader })
        .onConflictDoUpdate({
            target: [workspaceKeys.workspaceId, workspaceKeys.userId],
            set: { ...rotation.selfGrant, updatedAt: new Date() },
        });
    const start = () =>
        startRotationIn(tx, {
            workspaceId: rotation.workspaceId,
            nodeId: root!.id,
            startedBy: uploader,
            targetEpoch: rotation.targetEpoch,
            byRoster: true,
        });
    let started = await start();
    if (started.status === 'active') {
        /*
         * A Drive rotation already running in the area. Once it has re-keyed any node, those
         * nodes (and anything made under them since) sit under keys only its run's envelopes
         * hold; re-rotating over it would keep each node's oldest envelope and lose those
         * keys for good. So the roster waits: the caller finishes the run, then resends. A
         * run that has re-keyed nothing holds no such key and is closed here instead, so an
         * abandoned start never blocks a removal.
         */
        const running = started.rotation;
        const [progressed] = await tx
            .select({ id: driveNodes.id })
            .from(driveNodes)
            .where(
                and(
                    eq(driveNodes.workspaceId, rotation.workspaceId),
                    eq(driveNodes.keyEpoch, running.targetEpoch),
                ),
            )
            .limit(1);
        if (progressed)
            refuse({
                status: 'rotating',
                workspaceId: rotation.workspaceId,
                rotationId: running.id,
                nodeId: running.nodeId,
                targetEpoch: running.targetEpoch,
            });
        await tx
            .update(driveRotations)
            .set({ finishedAt: new Date() })
            .where(eq(driveRotations.id, running.id));
        started = await start();
    }
    // The epoch the rotator drew was overtaken (a node was created above it): redraw and resend.
    if (started.status === 'stale') refuse({ status: 'epoch-stale' });
    if (started.status !== 'ok') invalid(`rotation-${started.status}`);
    /*
     * A root still carrying a previous envelope is mid-rotation: a run that re-keyed it has
     * made progress and answered `rotating` above, and a finished one cleared it. Refused
     * all the same (its own 409, since resending cannot fix it), because overwriting it
     * below would lose the key its unrotated children are wrapped under.
     */
    if (root!.prevKeyEnvelope) refuse({ status: 'root-mid-rotation' });
    // The area moves to the new version first: the root is re-keyed under it.
    await tx
        .update(workspaces)
        .set({ workspaceKeyVersion: rotation.toVersion, rotationDueAt: null })
        .where(eq(workspaces.id, rotation.workspaceId));
    const outcome = await rotateNodeIn(
        tx,
        {
            workspaceId: rotation.workspaceId,
            rootId: root!.id,
            targetEpoch: rotation.targetEpoch,
            userId: uploader,
            byRoster: true,
        },
        rotation.root,
    );
    // The root changed since the rotator read it: re-read, re-seal, resend.
    if (outcome === 'stale') refuse({ status: 'root-moved' });
    if (outcome !== 'ok') invalid(`rotation-root-${outcome}`);
    /*
     * The root's previous envelope is its old key under the new area key, not the old
     * area key the Drive batch kept: a member given only the new version opens it, and
     * through it every child the walk has not reached (docs/groups-server.md 8).
     */
    await tx
        .update(driveNodes)
        .set({
            prevKeyEnvelope: rotation.previousRootKeyEnvelope,
            prevKeyEpoch: root!.keyEpoch,
            prevParentKeyEpoch: rotation.toVersion,
        })
        .where(eq(driveNodes.id, root!.id));
    await resealDocuments(tx, rotation.workspaceId, rotation.documents);
}

/*
 * Every rotated area's workspace documents against the call, before any of
 * the call is written: exactly one entry per document each area holds now,
 * each at the version stored. Called after lockAreas, so the rows are taken
 * after the areas' rows, in the order putWorkspaceDocument takes them (the
 * workspace's row first), and stay locked until the rotations re-seal them.
 *
 * A kind an area does not hold, or one named twice, is the client's mistake:
 * documents are never deleted, so no race makes one. One left out, or one at
 * another version, was written after the rotator read it, or is a kind its
 * client does not know: every such document across the call is named in one
 * `document-stale`, so the client re-reads them all before it resends.
 */
async function checkRotationDocuments(
    tx: Tx,
    groupId: string,
    rotations: readonly RotationInput[],
) {
    const stale: { workspaceId: string; kind: string }[] = [];
    for (const rotation of rotations) {
        const sent = new Map(rotation.documents.map((document) => [document.kind, document]));
        if (sent.size !== rotation.documents.length) invalid('rotation-documents');
        const [area] = await tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(and(eq(workspaces.id, rotation.workspaceId), eq(workspaces.groupId, groupId)));
        if (!area) invalid('rotation-area');
        const stored = await tx
            .select({ kind: workspaceDocuments.kind, version: workspaceDocuments.version })
            .from(workspaceDocuments)
            .where(eq(workspaceDocuments.workspaceId, rotation.workspaceId))
            .orderBy(workspaceDocuments.kind)
            .for('update');
        const held = new Set(stored.map((row) => row.kind));
        if (rotation.documents.some((document) => !held.has(document.kind)))
            invalid('rotation-documents');
        for (const row of stored)
            if (sent.get(row.kind)?.version !== row.version)
                stale.push({ workspaceId: rotation.workspaceId, kind: row.kind });
    }
    if (stale.length > 0) refuse({ status: 'document-stale', ...stale[0]!, stale });
}

/*
 * A rotated area's workspace documents, sealed again under the new area key in
 * the roster's own transaction, after checkRotationDocuments held them to the
 * call: each stored at the next version as a document write stores it
 * (putWorkspaceDocument: suite 1, `updated_at` moved; documents are not on the
 * change feed). Without this every rotation would leave them under a key
 * version clients no longer open them with.
 */
async function resealDocuments(
    tx: Tx,
    workspaceId: string,
    documents: readonly RotationDocumentInput[],
) {
    for (const document of documents) {
        const [stored] = await tx
            .update(workspaceDocuments)
            .set({
                version: document.version + 1,
                envelope: document.envelope,
                envelopeSuite: 1,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(workspaceDocuments.workspaceId, workspaceId),
                    eq(workspaceDocuments.kind, document.kind),
                    eq(workspaceDocuments.version, document.version),
                ),
            )
            .returning({ kind: workspaceDocuments.kind });
        // Checked under the same locks a moment ago: a miss here is a bug, never a race.
        if (!stored) throw new Error('A rotation document moved under its lock.');
    }
}

/*
 * Locks the group's areas, in id order, before any membership row. Drive
 * writes lock an area's workspace row (no key update, as nextChangeSeq does)
 * and then, from phase B, share-lock the writer's membership; a write that
 * changes memberships and areas must take the areas first, or the two could
 * wait on each other. No key update, so inserts that reference the areas
 * (nodes, grants) are not blocked.
 */
async function lockAreas(tx: Tx, groupId: string) {
    await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.groupId, groupId))
        .orderBy(workspaces.id)
        .for('no key update');
}

/*
 * What a departure takes away at once, in the group's areas: the person's
 * area grants, seals and self-grants (so they are no longer a member of any
 * area); every share and link they granted there (a link they kept would
 * otherwise outlive them, re-sealed by every rotation); and every share
 * granted to them there (they leave the group's files, not just its keys).
 * Shares other members made to people outside the group stay. Every area
 * they could reach (by a grant, a self-grant or a share to them) is marked
 * due for rotation.
 */
async function revokeAccess(tx: Tx, groupId: string, userId: string) {
    // A hold on them, and every hold they placed, ends with their membership.
    await tx
        .delete(groupHolds)
        .where(
            and(
                eq(groupHolds.groupId, groupId),
                or(eq(groupHolds.userId, userId), eq(groupHolds.heldBy, userId)),
            ),
        );
    const areaIds = (
        await tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.groupId, groupId))
    ).map((row) => row.id);
    // Every area whose key they could reach: by a grant, a self-grant, or a share made to them.
    const reached = new Set(
        (
            await tx
                .delete(areaGrants)
                .where(and(eq(areaGrants.groupId, groupId), eq(areaGrants.granteeUserId, userId)))
                .returning({ workspaceId: areaGrants.workspaceId })
        ).map((row) => row.workspaceId),
    );
    await tx
        .delete(groupKeySeals)
        .where(and(eq(groupKeySeals.groupId, groupId), eq(groupKeySeals.holderUserId, userId)));
    if (areaIds.length > 0) {
        const now = new Date();
        for (const row of await tx
            .delete(workspaceKeys)
            .where(
                and(eq(workspaceKeys.userId, userId), inArray(workspaceKeys.workspaceId, areaIds)),
            )
            .returning({ workspaceId: workspaceKeys.workspaceId }))
            reached.add(row.workspaceId);
        for (const row of await tx
            .update(driveShares)
            .set({ revokedAt: now, updatedAt: now })
            .where(
                and(
                    inArray(driveShares.workspaceId, areaIds),
                    isNull(driveShares.revokedAt),
                    or(
                        eq(driveShares.granterUserId, userId),
                        eq(driveShares.granteeUserId, userId),
                    ),
                ),
            )
            .returning({
                workspaceId: driveShares.workspaceId,
                granteeUserId: driveShares.granteeUserId,
            }))
            if (row.granteeUserId === userId) reached.add(row.workspaceId);
        await tx
            .update(driveLinks)
            .set({ revokedAt: now })
            .where(
                and(
                    inArray(driveLinks.workspaceId, areaIds),
                    isNull(driveLinks.revokedAt),
                    eq(driveLinks.granterUserId, userId),
                ),
            );
    }
    if (reached.size > 0)
        await tx
            .update(workspaces)
            .set({ rotationDueAt: sql`coalesce(${workspaces.rotationDueAt}, now())` })
            .where(inArray(workspaces.id, [...reached]));
}

/* ------------------------------------------------------------------------- */
/* Creation                                                                   */
/* ------------------------------------------------------------------------- */

export type CreateResult =
    | { status: 'created' | 'replayed'; head: Head }
    /* The id is someone else's group, or this creator's with another first roster. */
    | { status: 'taken' }
    | { status: 'forbidden' | 'unavailable' }
    /* The creator already has as many groups as the instance allows. */
    | { status: 'area-limit'; limit: number }
    | { status: 'group-limit'; limit: number }
    /*
     * The creator is in a family already, and this is one (one family per account):
     * which, or null when the index refused a family that landed after the check.
     */
    | { status: 'in-family'; family: { groupId: string; name: string } | null }
    | { status: 'invalid'; reason: string };

/*
 * A new group: its row with the version 1 keys, roster version 1, the
 * creator's membership (active, with the roles their entry names, which must
 * include `billing` and `members`), the seal of the seed to the creator, and
 * optionally the first area with its grant to the creator. The id must derive
 * from the seed under the creator. The same group again (same id, same first
 * roster) is a replay.
 */
export async function createGroup(input: {
    id: string;
    idSeed: string;
    kind: GroupKind;
    name: string;
    creatorUserId: string;
    firstEd25519PublicKey: Buffer;
    firstMlDsaPublicKey: Buffer;
    roster: ParsedRoster;
    keySeal: SealInput;
    area?: AreaInput;
    grants?: GrantInput[];
    cache: unknown;
    /* The most live groups one account may have created (GROUP_OWNED_LIMIT). */
    ownedLimit?: number;
    /* SHA-256 of the creation call, kept so an identical resend is a replay (route 1). */
    creationDigest?: Buffer;
    /*
     * With billing on, the group's areas draw from a pool its plan fills: the
     * group starts with an empty one, so nothing is stored free (group_storage).
     */
    pooled?: boolean;
}): Promise<CreateResult> {
    const digest = statementDigest(input.roster.statement);
    const replay = async (): Promise<CreateResult> => {
        const [group] = await db.select().from(groups).where(eq(groups.id, input.id));
        if (!group) return { status: 'taken' };
        const first = await storedRoster(db, input.id, 1);
        return group.creatorUserId === input.creatorUserId && first?.digest.equals(digest)
            ? { status: 'replayed', head: headOf(group) }
            : { status: 'taken' };
    };
    if (!madeFor('group', input.creatorUserId, input.id, input.idSeed))
        return { status: 'invalid', reason: 'group-id' };
    if (input.roster.signerUserId !== input.creatorUserId) return { status: 'forbidden' };
    const [creator, ...others] = input.roster.changes;
    if (
        input.roster.version !== 1 ||
        input.roster.previousDigest !== null ||
        input.roster.groupKeyVersion !== 1 ||
        input.roster.dropsHolder ||
        others.length > 0 ||
        creator?.userId !== input.creatorUserId ||
        creator.status !== 'active' ||
        !creator.roles.includes('members') ||
        !creator.roles.includes('billing')
    )
        return { status: 'invalid', reason: 'first-roster' };
    const [existing] = await db
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.id, input.id));
    if (existing) return replay();
    return answering<CreateResult>(
        () =>
            db.transaction(async (tx) => {
                // The creator's row serialises their creations, so two at once cannot both slip
                // under the limit, or both find them in no family.
                await tx
                    .select({ id: users.id })
                    .from(users)
                    .where(eq(users.id, input.creatorUserId))
                    .for('no key update');
                // A resend of a creation that committed while this one waited is a replay, not a
                // second family: answered before the one-family check, which would count it.
                const [landed] = await tx
                    .select({ id: groups.id })
                    .from(groups)
                    .where(eq(groups.id, input.id));
                if (landed) return refuse(await replay());
                // Admissions elsewhere don't take that lock: group_memberships_one_family_idx
                // refuses the loser of such a race, and `answering` reads it as in-family.
                const family =
                    input.kind === 'family' ? await activeFamily(tx, input.creatorUserId) : null;
                if (family) refuse({ status: 'in-family', family });
                if (input.ownedLimit !== undefined) {
                    // Only groups they are still in: one handed on and left is no longer theirs.
                    const [owned] = await tx
                        .select({ groups: count() })
                        .from(groups)
                        .innerJoin(
                            groupMemberships,
                            and(
                                eq(groupMemberships.groupId, groups.id),
                                eq(groupMemberships.userId, input.creatorUserId),
                                eq(groupMemberships.state, 'active'),
                            ),
                        )
                        .where(
                            and(
                                eq(groups.creatorUserId, input.creatorUserId),
                                isNull(groups.dissolvedAt),
                            ),
                        );
                    if ((owned?.groups ?? 0) >= input.ownedLimit)
                        refuse({ status: 'group-limit', limit: input.ownedLimit });
                }
                const [group] = await tx
                    .insert(groups)
                    .values({
                        id: input.id,
                        idSeed: input.idSeed,
                        kind: input.kind,
                        name: input.name,
                        creatorUserId: input.creatorUserId,
                        firstEd25519PublicKey: input.firstEd25519PublicKey,
                        firstMlDsaPublicKey: input.firstMlDsaPublicKey,
                        creationDigest: input.creationDigest ?? null,
                        rosterVersion: 1,
                        rosterDigest: digest,
                        groupKeyVersion: 1,
                        chainRevision: 1,
                    })
                    // A duplicate in flight (a client that timed out and resent) waits for the
                    // first to commit, then finds the row: answered as a replay, or taken.
                    .onConflictDoNothing({ target: groups.id })
                    .returning();
                if (!group) return refuse(await replay());
                await tx.insert(groupRosters).values(rosterRow(input.id, input.roster, digest));
                await recordCommitments(tx, input.id, input.roster);
                await tx.insert(groupMemberships).values({
                    groupId: input.id,
                    groupKind: input.kind,
                    userId: input.creatorUserId,
                    state: 'active',
                    roles: creator.roles,
                    admittedAt: new Date(),
                });
                if (input.keySeal.holderUserId !== input.creatorUserId) invalid('seal-holder');
                await upsertSeals(tx, input.id, input.creatorUserId, true, 1, [input.keySeal]);
                if (input.pooled)
                    await tx.insert(groupStorage).values({ groupId: input.id, quotaBytes: 0n });
                if (input.area) await insertArea(tx, input.id, input.creatorUserId, input.area);
                await upsertGrants(tx, input.id, input.creatorUserId, true, input.grants ?? []);
                await writeCache(tx, input.id, 1, input.cache);
                return { status: 'created' as const, head: headOf(group) };
            }),
        // The group's id cannot reach here (on conflict do nothing); no other key races.
        async () => ({ status: 'invalid', reason: 'taken' }),
        () => ({ status: 'in-family', family: null }),
    );
}

/* ------------------------------------------------------------------------- */
/* The chain                                                                  */
/* ------------------------------------------------------------------------- */

/*
 * Appends to a group's chain under its row lock: a roster, a succession, or
 * both (a removal of a `members` holder carries its succession), with the
 * seals, grants, area and membership changes that ride on it, and the chain
 * cache the caller's checks produced. In order, under the lock:
 *
 * 1. the uploader must have signed what it uploads, and be an active
 *    `members` holder;
 * 2. a call whose every statement is stored already is a replay; one only
 *    partly stored is stale;
 * 3. an admission must fit the seats, counted now (before the revision, so a
 *    racing second admission learns it is out of seats, not merely stale);
 * 4. `expectedRevision` must still be the chain's, or the result is `stale`
 *    with the stored winner;
 * 5. departures due to be marked left come first;
 * 6. the route's diff policy holds against the server's memberships, and the
 *    roster drops a holder exactly when the stored roles say it does;
 * 7. everything is written, the head moves and the revision goes up by one.
 */
export async function appendChain(input: {
    groupId: string;
    uploaderUserId: string;
    expectedRevision: number;
    route: ChainRoute;
    roster?: ParsedRoster;
    succession?: ParsedSuccession;
    seals?: SealInput[];
    grants?: GrantInput[];
    /* Area rotations the roster lists (a family's left-marking roster rotates every area). */
    rotations?: RotationInput[];
    /* The chain cache as of the new head, from the caller's checks. */
    cache: unknown;
}): Promise<ChainResult> {
    const { groupId, uploaderUserId: uploader, route, roster, succession } = input;
    if (route.kind === 'succession' ? roster || !succession : !roster)
        return { status: 'invalid', reason: 'route-shape' };
    // Deleting a family folder changes nothing else: no entry, no succession, no rotation.
    if (
        route.kind === 'retire' &&
        (roster!.changes.length > 0 ||
            succession ||
            (input.rotations?.length ?? 0) > 0 ||
            (input.grants?.length ?? 0) > 0 ||
            (input.seals?.length ?? 0) > 0)
    )
        return { status: 'invalid', reason: 'area-delete' };
    if (
        (roster && roster.signerUserId !== uploader) ||
        (succession && succession.signerUserId !== uploader)
    )
        return { status: 'forbidden' };
    const rosterDigest = roster ? statementDigest(roster.statement) : null;
    const successionDigest = succession ? statementDigest(succession.statement) : null;
    return answering<ChainResult>(
        () =>
            db.transaction(async (tx) => {
                const group = await lockGroup(tx, groupId);
                if (!group) return refuse({ status: 'not-member' });
                // The crypto checks ask the same of the roster's signer; this is the server's own state.
                const uploaderRoles = (await activeMembers(tx, groupId, [uploader])).get(uploader);
                if (!uploaderRoles) return refuse({ status: 'not-member' });
                if (!uploaderRoles.includes('members')) return refuse({ status: 'forbidden' });
                if (
                    roster &&
                    (roster.changes.length > 0 ||
                        route.kind === 'remove' ||
                        (input.rotations?.length ?? 0) > 0)
                )
                    await lockAreas(tx, groupId);

                // 2. A replay only when everything the call carries is what is stored.
                const storedR = roster ? await storedRoster(tx, groupId, roster.version) : null;
                const storedS = succession
                    ? await storedSuccession(tx, groupId, succession.oldVersion)
                    : null;
                const rosterMatch = !roster || Boolean(storedR?.digest.equals(rosterDigest!));
                const successionMatch =
                    !succession || Boolean(storedS?.digest.equals(successionDigest!));
                if (rosterMatch && successionMatch)
                    return refuse({ status: 'replayed', ...headOf(group) });
                if ((roster && rosterMatch) || (succession && successionMatch))
                    return refuse(await staleResult(tx, groupId, roster, succession));

                // 3. Seats, under the lock that every admission and departure takes.
                let target: typeof groupMemberships.$inferSelect | undefined;
                if (route.kind === 'admit') {
                    [target] = await tx
                        .select()
                        .from(groupMemberships)
                        .where(
                            and(
                                eq(groupMemberships.groupId, groupId),
                                eq(groupMemberships.userId, route.userId),
                            ),
                        )
                        .for('update');
                    // One family per account: someone who joined or made another family since
                    // they accepted waits here until they leave it. Before seats, so a full
                    // family doesn't hide why; the index refuses whoever loses a race past this.
                    if (
                        group.kind === 'family' &&
                        target?.state === 'accepted' &&
                        (await activeFamily(tx, route.userId, groupId))
                    )
                        return refuse({ status: 'in-family' });
                    const [row] = await tx
                        .select({ used: count() })
                        .from(groupMemberships)
                        .where(
                            and(
                                eq(groupMemberships.groupId, groupId),
                                eq(groupMemberships.state, 'active'),
                            ),
                        );
                    const used = row?.used ?? 0;
                    const limit = group.seatLimit ?? route.seatLimitDefault;
                    if (target?.state !== 'active' && used + 1 > limit)
                        return refuse({ status: 'seats', used, limit });
                }

                // 4. The chain the caller checked against must still be the chain.
                if (group.chainRevision !== input.expectedRevision)
                    return refuse(await staleResult(tx, groupId, roster, succession));

                let head = headOf(group);
                let successionDue = group.successionDue;
                if (roster) {
                    if (successionDue) return refuse({ status: 'succession-due' });
                    if (
                        roster.version !== group.rosterVersion + 1 ||
                        !roster.previousDigest?.equals(group.rosterDigest) ||
                        roster.groupKeyVersion !== group.groupKeyVersion
                    )
                        invalid('roster-head');
                    if (route.kind === 'admit' && target?.state !== 'accepted')
                        refuse({ status: 'not-pending' });
                    // 5. Departures first: every one still listed active is marked left here.
                    const departed = new Map(
                        (
                            await tx
                                .select({
                                    userId: groupDepartures.userId,
                                    heldMembers: groupDepartures.heldMembers,
                                })
                                .from(groupDepartures)
                                .where(eq(groupDepartures.groupId, groupId))
                        ).map((row) => [row.userId, row.heldMembers]),
                    );
                    const marked = new Set(
                        roster.changes
                            .filter((change) => change.status === 'left')
                            .map((change) => change.userId),
                    );
                    const pending = [...departed.keys()].filter((userId) => !marked.has(userId));
                    if (pending.length > 0)
                        return refuse({ status: 'left-due', userIds: pending.sort() });
                    await tx.insert(groupRosters).values(rosterRow(groupId, roster, rosterDigest!));
                    await recordCommitments(tx, groupId, roster);
                    // 6. The diff policy, and whether a holder is dropped.
                    const dropsHolder = await applyRoster(
                        tx,
                        groupId,
                        uploader,
                        route,
                        roster,
                        departed,
                    );
                    if (dropsHolder !== roster.dropsHolder) invalid('drops-holder');
                    // A hold lasts only while its placer holds `members`: a demotion ends theirs.
                    if (dropsHolder) await dropOrphanHolds(tx, groupId);
                    /*
                     * Any roster that takes `members` from someone carries its succession in the
                     * same call, on every route: a succession left due in between could be wedged
                     * for good by the next holder's departure (route 10's seals would then name
                     * someone the server no longer seals to).
                     */
                    if (dropsHolder && !succession) invalid('succession-required');
                    if (departed.size > 0)
                        await tx
                            .delete(groupDepartures)
                            .where(eq(groupDepartures.groupId, groupId));
                    head = { ...head, rosterVersion: roster.version, rosterDigest: rosterDigest! };
                    successionDue = dropsHolder;
                }
                if (succession) {
                    if (
                        succession.oldVersion !== head.groupKeyVersion ||
                        succession.newVersion !== succession.oldVersion + 1 ||
                        succession.lastRosterVersion !== head.rosterVersion ||
                        !succession.lastRosterDigest.equals(head.rosterDigest)
                    )
                        invalid('succession-head');
                    await tx.insert(groupKeySuccessions).values({
                        groupId,
                        oldVersion: succession.oldVersion,
                        newVersion: succession.newVersion,
                        lastRosterVersion: succession.lastRosterVersion,
                        lastRosterDigest: succession.lastRosterDigest,
                        newEd25519PublicKey: succession.newEd25519PublicKey,
                        newMlDsaPublicKey: succession.newMlDsaPublicKey,
                        signerUserId: succession.signerUserId,
                        signerMlDsaPublicKey: succession.signerMlDsaPublicKey,
                        digest: successionDigest!,
                        statement: succession.statement,
                        ed25519Signature: succession.ed25519Signature,
                        mlDsaSignature: succession.mlDsaSignature,
                        signerSignature: succession.signerSignature,
                    });
                    head = { ...head, groupKeyVersion: succession.newVersion };
                    successionDue = false;
                }
                if (route.kind === 'area') await insertArea(tx, groupId, uploader, route.area);
                if (route.kind === 'retire') await retireArea(tx, groupId, route.workspaceId);
                if ((input.rotations?.length ?? 0) > 0 && !roster) invalid('rotation-roster');
                await checkRotationDocuments(tx, groupId, input.rotations ?? []);
                for (const rotation of input.rotations ?? [])
                    await applyRotation(tx, groupId, uploader, rotation);
                await upsertSeals(
                    tx,
                    groupId,
                    uploader,
                    true,
                    head.groupKeyVersion,
                    input.seals ?? [],
                );
                await upsertGrants(tx, groupId, uploader, true, input.grants ?? []);

                head = { ...head, revision: group.chainRevision + 1 };
                await tx
                    .update(groups)
                    .set({
                        rosterVersion: head.rosterVersion,
                        rosterDigest: head.rosterDigest,
                        groupKeyVersion: head.groupKeyVersion,
                        chainRevision: head.revision,
                        successionDue,
                        updatedAt: new Date(),
                    })
                    .where(eq(groups.id, groupId));
                await writeCache(tx, groupId, head.revision, input.cache);
                return { status: 'ok' as const, ...head };
            }),
        () => staleResult(db, groupId, roster, succession),
        () => ({ status: 'in-family' }),
    );
}

/*
 * For a call built on another revision than the chain's, whose statements the
 * domain therefore did not check: under the group's lock, a replay when every
 * statement it carries is already stored at its place, and otherwise stale,
 * with the head and the stored winners. It never writes, whatever the revision
 * is by the time the lock is taken: an unchecked statement can only ever be
 * compared, never stored.
 */
export async function classifyResend(input: {
    groupId: string;
    uploaderUserId: string;
    roster?: { version: number; statement: Buffer };
    succession?: { oldVersion: number; statement: Buffer };
}): Promise<ChainResult> {
    const { groupId, roster, succession } = input;
    if (!roster && !succession) return { status: 'invalid', reason: 'empty' };
    return answering<ChainResult>(
        () =>
            db.transaction(async (tx) => {
                const group = await lockGroup(tx, groupId);
                if (!group) return { status: 'not-member' as const };
                const roles = (await activeMembers(tx, groupId, [input.uploaderUserId])).get(
                    input.uploaderUserId,
                );
                if (!roles) return { status: 'not-member' as const };
                if (!roles.includes('members')) return { status: 'forbidden' as const };
                const storedR = roster ? await storedRoster(tx, groupId, roster.version) : null;
                const storedS = succession
                    ? await storedSuccession(tx, groupId, succession.oldVersion)
                    : null;
                const rosterMatch =
                    !roster || Boolean(storedR?.digest.equals(statementDigest(roster.statement)));
                const successionMatch =
                    !succession ||
                    Boolean(storedS?.digest.equals(statementDigest(succession.statement)));
                if (rosterMatch && successionMatch)
                    return { status: 'replayed' as const, ...headOf(group) };
                return staleResult(tx, groupId, roster, succession);
            }),
        () => staleResult(db, groupId, roster, succession),
    );
}

const sameRoles = (a: readonly GroupRole[], b: readonly GroupRole[]) =>
    a.length === b.length && [...a].sort().join() === [...b].sort().join();

/*
 * The membership projection of a roster's changes, under the route's policy
 * (docs/groups-server.md 6), and whether the roster drops a `members` holder
 * by the server's own account: someone listed active before (an active member,
 * or a departure still to be marked left) whose stored roles held `members`
 * and whose entry now is left or without it.
 *
 * - The admitted person becomes active, with roles within their invitation's.
 * - The removed person, active, becomes removed, and loses their access.
 * - Any other active entry must be an active member; its roles may change
 *   only on the member route, and only the target's.
 * - Any other left entry must be someone the server has as gone (left,
 *   removed, departed, or whose account is gone).
 * - Afterwards someone active still holds `members`, and someone `billing`.
 */
async function applyRoster(
    tx: Tx,
    groupId: string,
    uploader: string,
    route: ChainRoute,
    roster: ParsedRoster,
    departed: Map<string, boolean>,
) {
    const changes = roster.changes;
    const byUser = new Map(changes.map((change) => [change.userId, change]));
    if (byUser.size !== changes.length) invalid('changes');
    const target =
        route.kind === 'admit' || route.kind === 'member' || route.kind === 'remove'
            ? route.userId
            : null;
    if (target && !byUser.has(target)) invalid(`${route.kind}-entry`);
    const stored = new Map(
        changes.length === 0
            ? []
            : (
                  await tx
                      .select({
                          userId: groupMemberships.userId,
                          state: groupMemberships.state,
                          roles: groupMemberships.roles,
                          invitationRoles: groupInvitations.roles,
                      })
                      .from(groupMemberships)
                      .leftJoin(
                          groupInvitations,
                          eq(groupInvitations.id, groupMemberships.invitationId),
                      )
                      .where(
                          and(
                              eq(groupMemberships.groupId, groupId),
                              inArray(
                                  groupMemberships.userId,
                                  changes.map((change) => change.userId),
                              ),
                          ),
                      )
                      .for('update', { of: groupMemberships })
              ).map((row) => [row.userId, row]),
    );
    const now = new Date();
    let dropsHolder = false;
    for (const change of changes) {
        const member = stored.get(change.userId);
        // Whether the previous roster listed them as an active holder of `members`.
        const heldBefore =
            member?.state === 'active'
                ? member.roles.includes('members')
                : (departed.get(change.userId) ?? false);
        const where = and(
            eq(groupMemberships.groupId, groupId),
            eq(groupMemberships.userId, change.userId),
        );
        if (route.kind === 'admit' && change.userId === target) {
            if (change.status !== 'active') invalid('admit-entry');
            const allowed = member?.invitationRoles ?? [];
            if (change.roles.some((role) => !allowed.includes(role))) invalid('admit-roles');
            await tx
                .update(groupMemberships)
                .set({
                    state: 'active',
                    roles: change.roles,
                    admittedAt: now,
                    admittedBy: uploader,
                    leftAt: null,
                    updatedAt: now,
                })
                .where(where);
        } else if (route.kind === 'remove' && change.userId === target) {
            if (change.status !== 'left') invalid('remove-entry');
            // They left (or their account went) while the removal was in flight: a plain mark-left.
            if (member?.state !== 'active' && departed.has(change.userId)) {
                dropsHolder ||= heldBefore;
                continue;
            }
            if (member?.state !== 'active') membersChanged('remove-target');
            dropsHolder ||= heldBefore;
            await tx
                .update(groupMemberships)
                .set({ state: 'removed', leftAt: now, updatedAt: now })
                .where(where);
            await revokeAccess(tx, groupId, change.userId);
        } else if (change.status === 'active') {
            if (member?.state !== 'active') membersChanged('entry-not-member');
            if (!sameRoles(member!.roles, change.roles)) {
                if (route.kind !== 'member' || change.userId !== target) invalid('role-change');
                await tx
                    .update(groupMemberships)
                    .set({ roles: change.roles, updatedAt: now })
                    .where(where);
            }
            if (heldBefore && !change.roles.includes('members')) dropsHolder = true;
        } else {
            // A departed person may have accepted a new invitation since: marked left all the same,
            // and admitted on a later roster.
            if (
                member?.state === 'active' ||
                (member?.state === 'accepted' && !departed.has(change.userId))
            )
                invalid('entry-left');
            if (departed.has(change.userId)) dropsHolder ||= heldBefore;
        }
    }
    const [held] = await tx
        .select({
            members:
                sql<number>`count(*) filter (where 'members' = any(${groupMemberships.roles}))`.mapWith(
                    Number,
                ),
            billing:
                sql<number>`count(*) filter (where 'billing' = any(${groupMemberships.roles}))`.mapWith(
                    Number,
                ),
        })
        .from(groupMemberships)
        .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.state, 'active')));
    if (!held || held.members === 0) invalid('no-holder');
    if (held!.billing === 0) invalid('no-billing');
    return dropsHolder;
}

/* ------------------------------------------------------------------------- */
/* Grants and seals outside the chain                                         */
/* ------------------------------------------------------------------------- */

export type StoreResult =
    | { status: 'ok'; stored: number }
    | { status: 'not-member' | 'forbidden' | 'unavailable' }
    | { status: 'members-changed' | 'invalid'; reason: string };

/*
 * Area grants from any active member (route 22), and seals from a `members`
 * holder (route 9), under the group's lock. A grant or seal already stored is
 * replaced only on the terms upsertGrants and upsertSeals set; `stored` counts
 * those written.
 */
export async function storeGrants(input: {
    groupId: string;
    uploaderUserId: string;
    grants?: GrantInput[];
    seals?: SealInput[];
}): Promise<StoreResult> {
    return answering<StoreResult>(
        () =>
            db.transaction(async (tx) => {
                const group = await lockGroup(tx, input.groupId);
                if (!group) return refuse({ status: 'not-member' });
                const roles = (await activeMembers(tx, input.groupId, [input.uploaderUserId])).get(
                    input.uploaderUserId,
                );
                if (!roles) return refuse({ status: 'not-member' });
                const holds = roles.includes('members');
                if ((input.seals?.length ?? 0) > 0 && !holds)
                    return refuse({ status: 'forbidden' });
                const stored =
                    (await upsertGrants(
                        tx,
                        input.groupId,
                        input.uploaderUserId,
                        holds,
                        input.grants ?? [],
                    )) +
                    (await upsertSeals(
                        tx,
                        input.groupId,
                        input.uploaderUserId,
                        holds,
                        group.groupKeyVersion,
                        input.seals ?? [],
                    ));
                return { status: 'ok' as const, stored };
            }),
        async () => ({ status: 'invalid', reason: 'race' }),
    );
}

/* ------------------------------------------------------------------------- */
/* Departures                                                                 */
/* ------------------------------------------------------------------------- */

export type LeaveResult =
    | { status: 'left' | 'dissolved' }
    | { status: 'not-member' | 'organizer' | 'last-holder' | 'billed' | 'unavailable' };

/*
 * Whether the family has a plan someone is still paying for: live, and not set
 * to cancel at the period's end. Such a family is never dissolved, whoever
 * leaves last: its payer would go on being charged for nothing. Only with
 * billing on; with BILLING_PROVIDER=none a plan's rows are history.
 */
async function billedPlan(tx: Tx | typeof db, groupId: string) {
    if (billingEnv.BILLING_PROVIDER === 'none') return false;
    const [row] = await tx
        .select({ id: groupBillingSubscriptions.id })
        .from(groupBillingSubscriptions)
        .where(
            and(
                eq(groupBillingSubscriptions.groupId, groupId),
                isNull(groupBillingSubscriptions.endedAt),
                inArray(groupBillingSubscriptions.status, ['active', 'trialing', 'past_due']),
                eq(groupBillingSubscriptions.cancelAtPeriodEnd, false),
            ),
        )
        .limit(1);
    return Boolean(row);
}

/*
 * A member's departure, under the group's lock (taken by the caller, with the
 * areas): the `billing` holder or the last `members` holder may not go while
 * others remain; the last active member dissolves the group; anyone else loses
 * their access at once and is recorded as due to be marked left. Someone
 * accepted but not admitted simply withdraws.
 */
async function depart(tx: Tx, groupId: string, userId: string): Promise<LeaveResult> {
    const [membership] = await tx
        .select()
        .from(groupMemberships)
        .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, userId)))
        .for('update');
    if (!membership || (membership.state !== 'active' && membership.state !== 'accepted'))
        return { status: 'not-member' };
    const now = new Date();
    const leave = () =>
        tx
            .update(groupMemberships)
            .set({ state: 'left', leftAt: now, updatedAt: now })
            .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, userId)));
    if (membership.state === 'accepted') {
        await leave();
        return { status: 'left' };
    }
    const others = await othersOf(tx, groupId, userId);
    if (others.length === 0) {
        if (await billedPlan(tx, groupId)) return { status: 'billed' };
        await leave();
        await revokeAccess(tx, groupId, userId);
        await tx
            .update(groups)
            .set({ dissolvedAt: now, updatedAt: now })
            .where(eq(groups.id, groupId));
        return { status: 'dissolved' };
    }
    const blocked = blocker(membership.roles, others);
    if (blocked) return { status: blocked };
    await leave();
    await revokeAccess(tx, groupId, userId);
    await tx
        .insert(groupDepartures)
        .values({ groupId, userId, heldMembers: membership.roles.includes('members') })
        .onConflictDoNothing();
    return { status: 'left' };
}

/*
 * What keeps an active member from leaving while others remain: being the
 * only `billing` holder, or the only `members` holder. One rule for leaving,
 * deletion and its pre-check.
 */
function blocker(
    roles: readonly GroupRole[],
    others: readonly { roles: readonly GroupRole[]; sealed: boolean }[],
) {
    if (roles.includes('billing') && !others.some((other) => other.roles.includes('billing')))
        return 'organizer' as const;
    // Another holder counts only with a seal of the current group key: one without the seed
    // could never sign the roster that marks this person left.
    if (
        roles.includes('members') &&
        !others.some((other) => other.roles.includes('members') && other.sealed)
    )
        return 'last-holder' as const;
    return null;
}

/* The group's other active members: their roles, and whether they hold a seal of the current key. */
async function othersOf(tx: Tx | typeof db, groupId: string, userId: string) {
    return tx
        .select({
            roles: groupMemberships.roles,
            sealed: sql<boolean>`exists (select 1 from ${groupKeySeals} s join ${groups} g on g.id = s.group_id and g.group_key_version = s.group_key_version where s.group_id = ${groupMemberships.groupId} and s.holder_user_id = ${groupMemberships.userId})`,
        })
        .from(groupMemberships)
        .where(
            and(
                eq(groupMemberships.groupId, groupId),
                eq(groupMemberships.state, 'active'),
                ne(groupMemberships.userId, userId),
            ),
        );
}

/*
 * The groups that would refuse this account's deletion now, by the rule
 * leaving follows (the last active member does not block: they dissolve the
 * group). The deletion flow asks this before it stops billing; deleteAccount
 * asks again under the locks, since another holder may leave in between.
 */
export async function deletionBlockers(userId: string) {
    const mine = await db
        .select({ groupId: groupMemberships.groupId, roles: groupMemberships.roles })
        .from(groupMemberships)
        .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
        .where(
            and(
                eq(groupMemberships.userId, userId),
                eq(groupMemberships.state, 'active'),
                isNull(groups.dissolvedAt),
            ),
        )
        .orderBy(groupMemberships.groupId);
    const blockers: { groupId: string; reason: 'organizer' | 'last-holder' | 'billed' }[] = [];
    for (const { groupId, roles } of mine) {
        const others = await othersOf(db, groupId, userId);
        if (others.length === 0) {
            // The last member would dissolve a family whose plan is still being paid for.
            if (await billedPlan(db, groupId)) blockers.push({ groupId, reason: 'billed' });
            continue;
        }
        const reason = blocker(roles, others);
        if (reason) blockers.push({ groupId, reason });
    }
    return blockers;
}

/*
 * A member leaves at once (route 20): membership `left`, access gone, the
 * areas they could open due for rotation, and a departure every other roster
 * waits on until one marks them left.
 */
export async function leaveGroup(groupId: string, userId: string): Promise<LeaveResult> {
    return answering<LeaveResult>(
        () =>
            db.transaction(async (tx): Promise<LeaveResult> => {
                if (!(await lockGroup(tx, groupId))) return { status: 'not-member' };
                await lockAreas(tx, groupId);
                return depart(tx, groupId, userId);
            }),
        async () => ({ status: 'unavailable' }),
    );
}

/*
 * Before an account is deleted (inside deleteAccount's transaction, before it
 * locks the account): every group the person is in, in id order, is departed
 * as leaveGroup would. The first group they may not leave (the only `billing`
 * holder, or the last `members` holder with others active) is returned, and
 * the caller rolls everything back.
 */
export async function departAllForDeletion(
    tx: Tx,
    userId: string,
): Promise<{ status: 'ok' } | { status: 'organizer' | 'last-holder' | 'billed'; groupId: string }> {
    const memberships = await tx
        .select({ groupId: groupMemberships.groupId })
        .from(groupMemberships)
        .where(
            and(
                eq(groupMemberships.userId, userId),
                inArray(groupMemberships.state, ['active', 'accepted']),
            ),
        )
        .orderBy(groupMemberships.groupId);
    for (const { groupId } of memberships) {
        if (!(await lockGroup(tx, groupId))) continue;
        await lockAreas(tx, groupId);
        const result = await depart(tx, groupId, userId);
        if (
            result.status === 'organizer' ||
            result.status === 'last-holder' ||
            result.status === 'billed'
        )
            return { status: result.status, groupId };
    }
    return { status: 'ok' };
}

/*
 * A `members` holder turns down someone who accepted but was not admitted
 * (they could otherwise read the member list indefinitely). Their membership
 * is `removed`; their invitation stays spent.
 */
/*
 * A holder's hold on a member ahead of their removal (route 27): for
 * `minutes`, the member's Drive writes, epoch draws and rotation starts in the
 * group's areas are refused (requireStillWriter), so the removal's rotation
 * cannot be overtaken. Placing it again extends it; it ends when they are
 * removed or depart.
 */
export type HoldResult =
    | { status: 'placed'; expiresAt: Date }
    /* The caller is on hold themselves: a held holder cannot hold anyone back. */
    | { status: 'held' | 'not-member' | 'forbidden' | 'unavailable' }
    | { status: 'members-changed' | 'invalid'; reason: string };
export async function placeHold(input: {
    groupId: string;
    holderUserId: string;
    userId: string;
    minutes: number;
}): Promise<HoldResult> {
    if (input.holderUserId === input.userId) return { status: 'invalid', reason: 'hold-self' };
    return answering<HoldResult>(
        () =>
            db.transaction(async (tx) => {
                if (!(await lockGroup(tx, input.groupId))) return { status: 'not-member' as const };
                const roles = await activeMembers(tx, input.groupId, [
                    input.holderUserId,
                    input.userId,
                ]);
                const holder = roles.get(input.holderUserId);
                if (!holder) return { status: 'not-member' as const };
                if (!holder.includes('members')) return { status: 'forbidden' as const };
                if (await liveHold(tx, input.groupId, input.holderUserId))
                    return { status: 'held' as const };
                if (!roles.has(input.userId))
                    return { status: 'members-changed' as const, reason: 'hold-target' };
                const expiresAt = new Date(Date.now() + input.minutes * 60_000);
                await tx
                    .insert(groupHolds)
                    .values({
                        groupId: input.groupId,
                        userId: input.userId,
                        heldBy: input.holderUserId,
                        expiresAt,
                    })
                    .onConflictDoUpdate({
                        target: [groupHolds.groupId, groupHolds.userId],
                        set: { heldBy: input.holderUserId, expiresAt },
                    });
                return { status: 'placed' as const, expiresAt };
            }),
        async () => ({ status: 'unavailable' as const }),
    );
}

async function liveHold(tx: Tx, groupId: string, userId: string) {
    const [row] = await tx
        .select({ userId: groupHolds.userId })
        .from(groupHolds)
        .where(
            and(
                eq(groupHolds.groupId, groupId),
                eq(groupHolds.userId, userId),
                sql`${groupHolds.expiresAt} > now()`,
            ),
        );
    return row !== undefined;
}

/* Holds whose placer no longer holds `members` (or whose account is gone) end. */
async function dropOrphanHolds(tx: Tx, groupId: string) {
    await tx
        .delete(groupHolds)
        .where(
            and(
                eq(groupHolds.groupId, groupId),
                sql`(${groupHolds.heldBy} is null or not exists (select 1 from ${groupMemberships} m where m.group_id = ${groupId} and m.user_id = ${groupHolds.heldBy} and m.state = 'active' and 'members' = any(m.roles)))`,
            ),
        );
}

/* Live holds, for the group's `members` holders to see (route 3). */
export async function listHolds(groupId: string) {
    return db
        .select({
            userId: groupHolds.userId,
            heldBy: groupHolds.heldBy,
            expiresAt: groupHolds.expiresAt,
        })
        .from(groupHolds)
        .where(and(eq(groupHolds.groupId, groupId), sql`${groupHolds.expiresAt} > now()`))
        .orderBy(groupHolds.expiresAt);
}

export type DeclineResult = {
    status: 'declined' | 'not-member' | 'forbidden' | 'not-pending' | 'unavailable';
};
export async function declinePending(input: {
    groupId: string;
    holderUserId: string;
    userId: string;
}): Promise<DeclineResult> {
    return answering<DeclineResult>(
        () =>
            db.transaction(async (tx) => {
                if (!(await lockGroup(tx, input.groupId))) return { status: 'not-member' as const };
                const roles = (await activeMembers(tx, input.groupId, [input.holderUserId])).get(
                    input.holderUserId,
                );
                if (!roles) return { status: 'not-member' as const };
                if (!roles.includes('members')) return { status: 'forbidden' as const };
                const where = and(
                    eq(groupMemberships.groupId, input.groupId),
                    eq(groupMemberships.userId, input.userId),
                    eq(groupMemberships.state, 'accepted'),
                );
                const now = new Date();
                const rows = await tx
                    .update(groupMemberships)
                    .set({ state: 'removed', leftAt: now, updatedAt: now })
                    .where(where)
                    .returning({ userId: groupMemberships.userId });
                return {
                    status: rows.length > 0 ? ('declined' as const) : ('not-pending' as const),
                };
            }),
        async () => ({ status: 'unavailable' as const }),
    );
}

/* ------------------------------------------------------------------------- */
/* Invitations                                                                */
/* ------------------------------------------------------------------------- */

export type InvitationResult =
    | { status: 'created'; id: string; expiresAt: Date }
    | { status: 'not-member' | 'exists' | 'already-member' | 'unavailable' };

/*
 * An invitation to an address, by a member. One open invitation per address
 * per group: an expired one still marked open is closed first, so it never
 * blocks a new one. An address that is already an active or accepted member
 * is refused.
 */
export async function createInvitation(input: {
    groupId: string;
    email: string;
    normalizedEmail: string;
    tokenHash: Buffer;
    roles: GroupRole[];
    invitedBy: string;
    expiresAt: Date;
}): Promise<InvitationResult> {
    try {
        return await db.transaction(async (tx) => {
            const [group] = await tx
                .select({ dissolvedAt: groups.dissolvedAt })
                .from(groups)
                .where(eq(groups.id, input.groupId))
                .for('share');
            if (!group || group.dissolvedAt) return { status: 'not-member' as const };
            const [member] = await tx
                .select({ state: groupMemberships.state })
                .from(groupMemberships)
                .innerJoin(users, eq(users.id, groupMemberships.userId))
                .where(
                    and(
                        eq(groupMemberships.groupId, input.groupId),
                        eq(users.normalizedEmail, input.normalizedEmail),
                        inArray(groupMemberships.state, ['active', 'accepted']),
                    ),
                );
            if (member) return { status: 'already-member' as const };
            await tx
                .update(groupInvitations)
                .set({ state: 'expired', updatedAt: new Date() })
                .where(
                    and(
                        eq(groupInvitations.groupId, input.groupId),
                        eq(groupInvitations.normalizedEmail, input.normalizedEmail),
                        eq(groupInvitations.state, 'open'),
                        sql`${groupInvitations.expiresAt} <= now()`,
                    ),
                );
            const [row] = await tx
                .insert(groupInvitations)
                .values({ ...input, state: 'open' })
                .returning({ id: groupInvitations.id, expiresAt: groupInvitations.expiresAt });
            return { status: 'created' as const, id: row!.id, expiresAt: row!.expiresAt };
        });
    } catch (error) {
        if (pgCode(error) === '23505') return { status: 'exists' };
        if (transient(error)) return { status: 'unavailable' };
        throw error;
    }
}

/* An open invitation by its token's hash, with its group; null when used, revoked, expired or the group is gone. */
export async function openInvitation(tokenHash: Buffer) {
    const [row] = await db
        .select({
            invitation: groupInvitations,
            group: { id: groups.id, kind: groups.kind, name: groups.name },
            inviter: { id: users.id, name: users.name, email: users.email },
        })
        .from(groupInvitations)
        .innerJoin(groups, eq(groups.id, groupInvitations.groupId))
        .leftJoin(users, eq(users.id, groupInvitations.invitedBy))
        .where(
            and(
                eq(groupInvitations.tokenHash, tokenHash),
                eq(groupInvitations.state, 'open'),
                sql`${groupInvitations.expiresAt} > now()`,
                sql`${groups.dissolvedAt} is null`,
            ),
        );
    return row ?? null;
}

export type AcceptResult =
    | { status: 'accepted'; groupId: string }
    /* The account is in another family: it leaves that one before it accepts (one per account). */
    | { status: 'in-family'; family: { groupId: string; name: string } }
    | { status: 'gone' | 'email-mismatch' | 'already-member' | 'unavailable' };

/*
 * Binds an open invitation to the signed-in account, which must hold the
 * invited address (decision Q3): membership `accepted`, no seat taken, nothing
 * opened. One use: the invitation is spent here.
 */
export async function acceptInvitation(input: {
    tokenHash: Buffer;
    userId: string;
}): Promise<AcceptResult> {
    const [found] = await db
        .select({ groupId: groupInvitations.groupId })
        .from(groupInvitations)
        .where(eq(groupInvitations.tokenHash, input.tokenHash));
    if (!found) return { status: 'gone' };
    try {
        return await acceptUnder(found.groupId, input);
    } catch (error) {
        if (transient(error)) return { status: 'unavailable' };
        throw error;
    }
}

async function acceptUnder(
    groupId: string,
    input: { tokenHash: Buffer; userId: string },
): Promise<AcceptResult> {
    return db.transaction(async (tx) => {
        // Lock order as everywhere: the group row first.
        const group = await lockGroup(tx, groupId);
        const [invitation] = await tx
            .select()
            .from(groupInvitations)
            .where(eq(groupInvitations.tokenHash, input.tokenHash))
            .for('update');
        if (
            !group ||
            !invitation ||
            invitation.state !== 'open' ||
            invitation.expiresAt <= new Date()
        )
            return { status: 'gone' as const };
        const [user] = await tx
            .select({ normalizedEmail: users.normalizedEmail })
            .from(users)
            .where(eq(users.id, input.userId));
        if (!user || user.normalizedEmail !== invitation.normalizedEmail)
            return { status: 'email-mismatch' as const };
        const [membership] = await tx
            .select({ state: groupMemberships.state })
            .from(groupMemberships)
            .where(
                and(
                    eq(groupMemberships.groupId, invitation.groupId),
                    eq(groupMemberships.userId, input.userId),
                ),
            )
            .for('update');
        if (membership?.state === 'active') return { status: 'already-member' as const };
        /*
         * Refused here, not only at admission: an accepted row would sit in this family's
         * waiting list, and its managers would learn the person is in some family. Read
         * under the group lock only; an admission elsewhere that commits after this read is
         * the same as one after the accept, which admission then refuses.
         */
        if (group.kind === 'family') {
            const family = await activeFamily(tx, input.userId, group.id);
            if (family) return { status: 'in-family' as const, family };
        }
        const now = new Date();
        await tx
            .insert(groupMemberships)
            .values({
                groupId: invitation.groupId,
                groupKind: group.kind,
                userId: input.userId,
                state: 'accepted',
                invitationId: invitation.id,
                acceptedAt: now,
            })
            .onConflictDoUpdate({
                target: [groupMemberships.groupId, groupMemberships.userId],
                set: {
                    state: 'accepted',
                    roles: sql`'{}'::text[]`,
                    invitationId: invitation.id,
                    acceptedAt: now,
                    admittedAt: null,
                    admittedBy: null,
                    leftAt: null,
                    updatedAt: now,
                },
            });
        await tx
            .update(groupInvitations)
            .set({ state: 'accepted', acceptedBy: input.userId, updatedAt: now })
            .where(eq(groupInvitations.id, invitation.id));
        return { status: 'accepted' as const, groupId: invitation.groupId };
    });
}

/* Revokes an open invitation of the group; `gone` when it was not open. */
export async function revokeInvitation(groupId: string, invitationId: string) {
    const rows = await db
        .update(groupInvitations)
        .set({ state: 'revoked', updatedAt: new Date() })
        .where(
            and(
                eq(groupInvitations.id, invitationId),
                eq(groupInvitations.groupId, groupId),
                eq(groupInvitations.state, 'open'),
            ),
        )
        .returning({ id: groupInvitations.id });
    return rows.length > 0 ? ('revoked' as const) : ('gone' as const);
}

/* How long an address is kept on an invitation that is no longer open. */
export const INVITATION_EMAIL_DAYS = 30;

/*
 * For the cleanup job: closes open invitations past their expiry, and forgets
 * the address of every invitation that has not been open for 30 days, in
 * bounded batches.
 */
export async function cleanupInvitations(
    options: { batchSize?: number; signal?: AbortSignal; now?: Date } = {},
) {
    const batch = Math.max(1, Math.min(options.batchSize ?? 500, 5_000));
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - INVITATION_EMAIL_DAYS * 24 * 60 * 60 * 1000);
    async function repeat(statement: () => ReturnType<typeof db.execute>) {
        let total = 0;
        while (!options.signal?.aborted) {
            const affected = (await statement()).rowCount ?? 0;
            total += affected;
            if (affected < batch) break;
        }
        return total;
    }
    return {
        expired: await repeat(() =>
            db.execute(
                sql`update ${groupInvitations} set state = 'expired', updated_at = ${now} where ${groupInvitations.id} in (select ${groupInvitations.id} from ${groupInvitations} where ${groupInvitations.state} = 'open' and ${groupInvitations.expiresAt} <= ${now} limit ${batch})`,
            ),
        ),
        forgotten: await repeat(() =>
            db.execute(
                sql`update ${groupInvitations} set email = null, normalized_email = null where ${groupInvitations.id} in (select ${groupInvitations.id} from ${groupInvitations} where ${groupInvitations.state} <> 'open' and ${groupInvitations.email} is not null and ${groupInvitations.updatedAt} < ${cutoff} limit ${batch})`,
            ),
        ),
    };
}

/* ------------------------------------------------------------------------- */
/* Reads                                                                      */
/* ------------------------------------------------------------------------- */

/* The group's head and the caller's membership; null for a stranger, a former member or a dissolved group. */
export async function getGroupFor(groupId: string, userId: string) {
    const [row] = await db
        .select({ group: groups, membership: groupMemberships })
        .from(groups)
        .innerJoin(
            groupMemberships,
            and(eq(groupMemberships.groupId, groups.id), eq(groupMemberships.userId, userId)),
        )
        .where(
            and(
                eq(groups.id, groupId),
                isNull(groups.dissolvedAt),
                inArray(groupMemberships.state, ['accepted', 'active']),
            ),
        );
    return row ? { ...row, head: headOf(row.group) } : null;
}

export async function getRoster(groupId: string, version: number) {
    return storedRoster(db, groupId, version);
}

/* Who is due to be marked left, oldest first: what `due.markLeft` reports to holders. */
export async function listDepartures(groupId: string) {
    return db
        .select()
        .from(groupDepartures)
        .where(eq(groupDepartures.groupId, groupId))
        .orderBy(groupDepartures.departedAt);
}

/* The areas due for rotation in a group: what `due.rotations` reports. */
export async function listRotationsDue(groupId: string) {
    return (
        await db
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(
                and(
                    eq(workspaces.groupId, groupId),
                    isNotNull(workspaces.rotationDueAt),
                    isNull(workspaces.deletedAt),
                ),
            )
    ).map((row) => row.id);
}

/*
 * The stored chain cache, if it is at the group's current revision (null means
 * rebuild), with the head read in the same statement: a record at the right
 * revision can still name another head (one a bug stored short), which the
 * caller checks before trusting it.
 */
export async function getChainCache(groupId: string) {
    const [row] = await db
        .select({
            revision: groups.chainRevision,
            rosterVersion: groups.rosterVersion,
            rosterDigest: groups.rosterDigest,
            groupKeyVersion: groups.groupKeyVersion,
            cached: groupChainCaches,
        })
        .from(groups)
        .leftJoin(groupChainCaches, eq(groupChainCaches.groupId, groups.id))
        .where(eq(groups.id, groupId));
    if (!row) return null;
    return {
        revision: row.revision,
        head: {
            rosterVersion: row.rosterVersion,
            rosterDigest: row.rosterDigest,
            groupKeyVersion: row.groupKeyVersion,
        },
        cache: row.cached?.chainRevision === row.revision ? row.cached.cache : null,
    };
}

/*
 * Stores a rebuilt chain cache, only if the chain is still at `revision`: a
 * rebuild that raced a write loses, harmlessly, to the write's own cache.
 */
export async function putChainCache(groupId: string, revision: number, cache: unknown) {
    return db.transaction(async (tx) => {
        const [group] = await tx
            .select({ revision: groups.chainRevision })
            .from(groups)
            .where(eq(groups.id, groupId))
            .for('share');
        if (group?.revision !== revision) return false;
        await writeCache(tx, groupId, revision, cache);
        return true;
    });
}

/* ------------------------------------------------------------------------- */
/* Reads for the routes                                                       */
/* ------------------------------------------------------------------------- */

/* The group row, dissolved or not; null when there is none. */
export async function getGroupRow(groupId: string) {
    const [row] = await db.select().from(groups).where(eq(groups.id, groupId));
    return row ?? null;
}

/* The account's groups, accepted and active, newest membership first. */
export async function listGroupsFor(userId: string) {
    return db
        .select({
            id: groups.id,
            kind: groups.kind,
            name: groups.name,
            roles: groupMemberships.roles,
            state: groupMemberships.state,
            rosterVersion: groups.rosterVersion,
            groupKeyVersion: groups.groupKeyVersion,
        })
        .from(groupMemberships)
        .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
        .where(
            and(
                eq(groupMemberships.userId, userId),
                inArray(groupMemberships.state, ['accepted', 'active']),
                isNull(groups.dissolvedAt),
            ),
        )
        .orderBy(sql`${groupMemberships.createdAt} desc`);
}

/* Every membership of the group with the member's name: what the group page lists. */
export async function listMembers(groupId: string) {
    return db
        .select({
            userId: groupMemberships.userId,
            name: users.name,
            email: users.email,
            state: groupMemberships.state,
            roles: groupMemberships.roles,
        })
        .from(groupMemberships)
        .innerJoin(users, eq(users.id, groupMemberships.userId))
        .where(eq(groupMemberships.groupId, groupId))
        .orderBy(groupMemberships.userId);
}

export async function renameGroup(groupId: string, name: string) {
    const [row] = await db
        .update(groups)
        .set({ name, updatedAt: new Date() })
        .where(and(eq(groups.id, groupId), isNull(groups.dissolvedAt)))
        .returning();
    return row ?? null;
}

/*
 * Rosters after `after`, oldest first, at most `limit` of them and about
 * `maxBytes` of statements (always at least one, so a page always moves).
 */
export async function listRosters(
    groupId: string,
    options: { after?: number; limit: number; maxBytes: number },
) {
    const rows = await db
        .select()
        .from(groupRosters)
        .where(
            and(
                eq(groupRosters.groupId, groupId),
                sql`${groupRosters.version} > ${options.after ?? 0}`,
            ),
        )
        .orderBy(groupRosters.version)
        .limit(options.limit + 1);
    const page: StoredRoster[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, options.limit)) {
        if (page.length > 0 && bytes + row.statement.length > options.maxBytes) break;
        page.push(row);
        bytes += row.statement.length;
    }
    const more = page.length < rows.length;
    return { rosters: page, next: more ? page.at(-1)!.version : null };
}

/* Every succession of the group, from key version 1. */
export async function listSuccessions(groupId: string) {
    return db
        .select()
        .from(groupKeySuccessions)
        .where(eq(groupKeySuccessions.groupId, groupId))
        .orderBy(groupKeySuccessions.oldVersion);
}

const identityFields = {
    userId: accountIdentities.userId,
    version: accountIdentities.version,
    keyVersion: accountIdentities.keyVersion,
    encryptionPublicKey: accountIdentities.encryptionPublicKey,
    signingPublicKey: accountIdentities.signingPublicKey,
    mlDsaPublicKey: accountIdentities.mlDsaPublicKey,
    kemPublicKey: accountIdentities.kemPublicKey,
    keysSignature: accountIdentities.keysSignature,
};

/*
 * Every version 2 identity each account has had, current first then the
 * replaced ones newest first, with the public halves only: what checkNextRoster
 * matches a changed entry against, and where a signer's ML-DSA keys come from.
 * Version 1 identities have no ML-DSA key and are never in a roster.
 */
export async function identitiesOf(userIds: readonly string[]) {
    const out = new Map<
        string,
        {
            keyVersion: number;
            encryptionPublicKey: Buffer;
            signingPublicKey: Buffer;
            mlDsaPublicKey: Buffer;
            kemPublicKey: Buffer;
            keysSignature: Buffer;
            current: boolean;
        }[]
    >();
    if (userIds.length === 0) return out;
    const current = await db
        .select(identityFields)
        .from(accountIdentities)
        .where(
            and(inArray(accountIdentities.userId, [...userIds]), eq(accountIdentities.version, 2)),
        );
    const earlier = await db
        .select({
            userId: accountIdentityHistory.userId,
            version: accountIdentityHistory.version,
            keyVersion: accountIdentityHistory.keyVersion,
            encryptionPublicKey: accountIdentityHistory.encryptionPublicKey,
            signingPublicKey: accountIdentityHistory.signingPublicKey,
            mlDsaPublicKey: accountIdentityHistory.mlDsaPublicKey,
            kemPublicKey: accountIdentityHistory.kemPublicKey,
            keysSignature: accountIdentityHistory.keysSignature,
        })
        .from(accountIdentityHistory)
        .where(
            and(
                inArray(accountIdentityHistory.userId, [...userIds]),
                eq(accountIdentityHistory.version, 2),
            ),
        )
        .orderBy(sql`${accountIdentityHistory.keyVersion} desc`);
    for (const [rows, isCurrent] of [
        [current, true],
        [earlier, false],
    ] as const)
        for (const row of rows) {
            if (!row.mlDsaPublicKey || !row.kemPublicKey || !row.keysSignature) continue;
            const list = out.get(row.userId) ?? [];
            list.push({
                keyVersion: row.keyVersion,
                encryptionPublicKey: row.encryptionPublicKey,
                signingPublicKey: row.signingPublicKey,
                mlDsaPublicKey: row.mlDsaPublicKey,
                kemPublicKey: row.kemPublicKey,
                keysSignature: row.keysSignature,
                current: isCurrent,
            });
            out.set(row.userId, list);
        }
    return out;
}

/*
 * The active members on the group's head, in user id order after `after`, a
 * page of `limit`: the accounts route 6 serves identities and links for.
 */
export async function listActiveMemberIds(groupId: string, after: string | null, limit: number) {
    return (
        await db
            .select({ userId: groupMemberships.userId })
            .from(groupMemberships)
            .where(
                and(
                    eq(groupMemberships.groupId, groupId),
                    eq(groupMemberships.state, 'active'),
                    after ? sql`${groupMemberships.userId} > ${after}` : sql`true`,
                ),
            )
            .orderBy(groupMemberships.userId)
            .limit(limit)
    ).map((row) => row.userId);
}

/* The memberships of `userIds` in the group, whatever their state: what route 6 bounds links by. */
export async function membershipsOf(groupId: string, userIds: readonly string[]) {
    if (userIds.length === 0) return new Map<string, { state: string; leftAt: Date | null }>();
    const rows = await db
        .select({
            userId: groupMemberships.userId,
            state: groupMemberships.state,
            leftAt: groupMemberships.leftAt,
        })
        .from(groupMemberships)
        .where(
            and(
                eq(groupMemberships.groupId, groupId),
                inArray(groupMemberships.userId, [...userIds]),
            ),
        );
    return new Map(rows.map((row) => [row.userId, { state: row.state, leftAt: row.leftAt }]));
}

/* Who accepted and waits to be admitted, with the identity a words check compares. */
export async function listPending(groupId: string) {
    return db
        .select({
            userId: groupMemberships.userId,
            name: users.name,
            email: users.email,
            acceptedAt: groupMemberships.acceptedAt,
            invitationRoles: groupInvitations.roles,
            // In another family since they accepted: they can't be let in until they leave it.
            inFamily: sql<boolean>`exists (select 1 from ${groupMemberships} other where other.user_id = ${groupMemberships.userId} and other.group_kind = 'family' and other.state = 'active' and other.group_id <> ${groupMemberships.groupId})`,
        })
        .from(groupMemberships)
        .innerJoin(users, eq(users.id, groupMemberships.userId))
        .leftJoin(groupInvitations, eq(groupInvitations.id, groupMemberships.invitationId))
        .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.state, 'accepted')))
        .orderBy(groupMemberships.acceptedAt);
}

/* The group's open invitations, newest first. */
export async function listOpenInvitations(groupId: string) {
    return db
        .select({
            id: groupInvitations.id,
            email: groupInvitations.email,
            roles: groupInvitations.roles,
            invitedBy: groupInvitations.invitedBy,
            expiresAt: groupInvitations.expiresAt,
        })
        .from(groupInvitations)
        .where(
            and(
                eq(groupInvitations.groupId, groupId),
                eq(groupInvitations.state, 'open'),
                sql`${groupInvitations.expiresAt} > now()`,
            ),
        )
        .orderBy(sql`${groupInvitations.createdAt} desc`);
}

/* The holder's seal of the group's current key; null when there is none. */
export async function keySealFor(groupId: string, userId: string) {
    const [row] = await db
        .select({ seal: groupKeySeals })
        .from(groupKeySeals)
        .innerJoin(
            groups,
            and(
                eq(groups.id, groupKeySeals.groupId),
                eq(groups.groupKeyVersion, groupKeySeals.groupKeyVersion),
            ),
        )
        .where(and(eq(groupKeySeals.groupId, groupId), eq(groupKeySeals.holderUserId, userId)));
    return row?.seal ?? null;
}

/*
 * A member's self-grant to an area (route 23): their own wrap of the area key,
 * at the area's current version and only while they hold a grant at it, so a
 * self-grant never names a key the member was not given.
 */
export type SelfGrantResult = {
    status: 'ok' | 'not-member' | 'area' | 'no-grant' | 'stale' | 'unavailable';
};
export async function putSelfGrant(input: {
    groupId: string;
    workspaceId: string;
    userId: string;
    grant: SelfGrantInput;
}): Promise<SelfGrantResult> {
    return answering<SelfGrantResult>(
        () =>
            db.transaction(async (tx) => {
                if (!(await lockGroup(tx, input.groupId))) return { status: 'not-member' as const };
                if (!(await activeMembers(tx, input.groupId, [input.userId])).has(input.userId))
                    return { status: 'not-member' as const };
                const [area] = await tx
                    .select({ version: workspaces.workspaceKeyVersion })
                    .from(workspaces)
                    .where(
                        and(
                            eq(workspaces.id, input.workspaceId),
                            eq(workspaces.groupId, input.groupId),
                            // A deleted area (docs/groups-design.md 2.10) is no area any more.
                            isNull(workspaces.deletedAt),
                        ),
                    );
                // An area of another group, or none: the caller is a member, so not `not-member`.
                if (!area) return { status: 'area' as const };
                if (input.grant.workspaceKeyVersion !== area.version)
                    return { status: 'stale' as const };
                const [granted] = await tx
                    .select({ grantee: areaGrants.granteeUserId })
                    .from(areaGrants)
                    .where(
                        and(
                            eq(areaGrants.workspaceId, input.workspaceId),
                            eq(areaGrants.workspaceKeyVersion, area.version),
                            eq(areaGrants.granteeUserId, input.userId),
                        ),
                    );
                if (!granted) return { status: 'no-grant' as const };
                await tx
                    .insert(workspaceKeys)
                    .values({
                        ...input.grant,
                        workspaceId: input.workspaceId,
                        userId: input.userId,
                    })
                    .onConflictDoUpdate({
                        target: [workspaceKeys.workspaceId, workspaceKeys.userId],
                        set: { ...input.grant, updatedAt: new Date() },
                    });
                return { status: 'ok' as const };
            }),
        async () => ({ status: 'unavailable' as const }),
    );
}

/*
 * Replaces an area root's previous envelope while the Drive rotation a
 * roster started on that root is still running (route 28): the repair for a
 * previous envelope that does not open, which would otherwise keep everyone
 * given only the new area key out of the part of the area the walk has not
 * reached until it finishes. Only an active `members` holder who is not held
 * may do it, under the group's lock and then the area's (the change sequence
 * moves, so devices re-read the root); only for the run the caller names,
 * still running and rooted at the area root; only while the root carries a
 * previous envelope under the area's current key version (the form a roster
 * rotation leaves). The envelope's epoch stays: it is the same old root key,
 * wrapped again. The server cannot tell a good envelope from a bad one, so
 * this is as open to a hostile holder as the rotation itself.
 */
export type PreviousRootResult =
    | { status: 'ok'; changeSeq: number }
    | { status: 'not-member' | 'forbidden' | 'held' | 'area' | 'not-rotating' | 'unavailable' };
export async function replacePreviousRoot(input: {
    groupId: string;
    workspaceId: string;
    userId: string;
    rotationId: string;
    envelope: Buffer;
}): Promise<PreviousRootResult> {
    if (input.envelope.length !== 72) return { status: 'area' };
    return answering<PreviousRootResult>(
        () =>
            db.transaction(async (tx) => {
                if (!(await lockGroup(tx, input.groupId))) return { status: 'not-member' as const };
                const roles = (await activeMembers(tx, input.groupId, [input.userId])).get(
                    input.userId,
                );
                if (!roles) return { status: 'not-member' as const };
                if (!roles.includes('members')) return { status: 'forbidden' as const };
                if (await liveHold(tx, input.groupId, input.userId))
                    return { status: 'held' as const };
                const [area] = await tx
                    .select({ version: workspaces.workspaceKeyVersion })
                    .from(workspaces)
                    .where(
                        and(
                            eq(workspaces.id, input.workspaceId),
                            eq(workspaces.groupId, input.groupId),
                            // A deleted area (docs/groups-design.md 2.10) is no area any more.
                            isNull(workspaces.deletedAt),
                        ),
                    )
                    .for('no key update');
                if (!area) return { status: 'area' as const };
                const running = await activeRotation(tx, input.workspaceId);
                const [root] = await tx
                    .select({
                        id: driveNodes.id,
                        prevKeyEnvelope: driveNodes.prevKeyEnvelope,
                        prevParentKeyEpoch: driveNodes.prevParentKeyEpoch,
                    })
                    .from(driveNodes)
                    .where(
                        and(
                            eq(driveNodes.workspaceId, input.workspaceId),
                            isNull(driveNodes.parentId),
                        ),
                    )
                    .for('update');
                if (
                    !running ||
                    running.id !== input.rotationId ||
                    !root ||
                    running.nodeId !== root.id ||
                    !root.prevKeyEnvelope ||
                    root.prevParentKeyEpoch !== area.version
                )
                    return { status: 'not-rotating' as const };
                const changeSeq = await nextChangeSeq(tx, input.workspaceId);
                await tx
                    .update(driveNodes)
                    .set({ prevKeyEnvelope: input.envelope, changeSeq })
                    .where(eq(driveNodes.id, root.id));
                return { status: 'ok' as const, changeSeq };
            }),
        async () => ({ status: 'unavailable' as const }),
    );
}

/*
 * An area's root with everything a roster rotation re-seals on it (route 29):
 * the node, its versions, its live shares with their grantees' identities and
 * its live links, as Drive's rotation work lists them. Only for someone who
 * holds the area's current key, as route 3's `due.grants` counts it (a grant
 * at the current version from a granter still active, or a self-grant at it):
 * nobody else could open the root to re-key it, so nobody else is shown who it
 * is shared with. One read-only snapshot, so the key check, the change sequence
 * the rotator must name and the grants it re-seals belong together. `area` for
 * an area of another group, or none. The caller's role is the domain's to check.
 */
export type AreaRootResult =
    | { status: 'ok'; root: RotationWorkNode }
    | { status: 'area' | 'no-key' };
export async function areaRootWork(input: {
    groupId: string;
    workspaceId: string;
    userId: string;
}): Promise<AreaRootResult> {
    return db.transaction(
        async (tx) => {
            const [area] = await tx
                .select({ version: workspaces.workspaceKeyVersion })
                .from(workspaces)
                .where(
                    and(
                        eq(workspaces.id, input.workspaceId),
                        eq(workspaces.groupId, input.groupId),
                        isNull(workspaces.deletedAt),
                    ),
                );
            if (!area) return { status: 'area' as const };
            const held = await tx.execute<{ holds: boolean }>(sql`
                select exists (
                    select 1 from ${areaGrants} g
                    join ${groupMemberships} granter
                      on granter.group_id = ${input.groupId}
                     and granter.user_id = g.granter_user_id
                     and granter.state = 'active'
                    where g.workspace_id = ${input.workspaceId}
                      and g.workspace_key_version = ${area.version}
                      and g.grantee_user_id = ${input.userId}
                ) or exists (
                    select 1 from ${workspaceKeys} k
                    where k.workspace_id = ${input.workspaceId}
                      and k.user_id = ${input.userId}
                      and k.workspace_key_version = ${area.version}
                ) as holds
            `);
            if (!held.rows[0]?.holds) return { status: 'no-key' as const };
            const root = await rootWorkIn(tx, input.workspaceId);
            // Every area is created with its root and a root is never purged: none is no area to rotate.
            return root ? { status: 'ok' as const, root } : { status: 'area' as const };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
}

/*
 * The account's spaces in groups: each group they are active in, with every
 * area, its seed, current key version and change sequence, its root (whose
 * previous envelope, while a rotation runs, is the old root key under the
 * current area key), the Drive rotation running in it, their newest grant to
 * it and their self-grant: what /drive/workspace gives for the personal one
 * (getPersonalWorkspace), so a client opens an area the same way.
 */
export async function spacesFor(userId: string) {
    // One snapshot: a rotation landing between the reads would otherwise pair an area's new
    // key version with its old root, or a root with a rotation that has since finished.
    return db.transaction(
        async (tx) => {
            const memberships = await tx
                .select({ groupId: groups.id, kind: groups.kind, name: groups.name })
                .from(groupMemberships)
                .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
                .where(
                    and(
                        eq(groupMemberships.userId, userId),
                        eq(groupMemberships.state, 'active'),
                        isNull(groups.dissolvedAt),
                    ),
                )
                .orderBy(groups.name, groups.id);
            if (memberships.length === 0) return [];
            const areas = await tx
                .select({
                    groupId: workspaces.groupId,
                    workspaceId: workspaces.id,
                    idSeed: workspaces.idSeed,
                    workspaceKeyVersion: workspaces.workspaceKeyVersion,
                    changeSeq: workspaces.changeSeq,
                })
                .from(workspaces)
                .where(
                    and(
                        inArray(
                            workspaces.groupId,
                            memberships.map((m) => m.groupId),
                        ),
                        // A deleted family folder is gone for everyone (docs/groups-design.md 2.10).
                        isNull(workspaces.deletedAt),
                    ),
                )
                .orderBy(workspaces.createdAt, workspaces.id);
            const areaIds = areas.map((area) => area.workspaceId);
            const rootIds = areaIds.length
                ? await tx
                      .select({ id: driveNodes.id })
                      .from(driveNodes)
                      .where(
                          and(
                              inArray(driveNodes.workspaceId, areaIds),
                              isNull(driveNodes.parentId),
                              isNull(driveNodes.purgedAt),
                          ),
                      )
                : [];
            const roots = rootIds.length
                ? await selectNodes(
                      tx,
                      rootIds.map((row) => row.id),
                  )
                : [];
            const running = areaIds.length
                ? await tx
                      .select({
                          id: driveRotations.id,
                          workspaceId: driveRotations.workspaceId,
                          nodeId: driveRotations.nodeId,
                          targetEpoch: driveRotations.targetEpoch,
                      })
                      .from(driveRotations)
                      .where(
                          and(
                              inArray(driveRotations.workspaceId, areaIds),
                              isNull(driveRotations.finishedAt),
                          ),
                      )
                : [];
            const grants = areaIds.length
                ? await tx
                      .select()
                      .from(areaGrants)
                      .where(
                          and(
                              eq(areaGrants.granteeUserId, userId),
                              inArray(areaGrants.workspaceId, areaIds),
                          ),
                      )
                      .orderBy(
                          sql`${areaGrants.workspaceKeyVersion} desc, ${areaGrants.granteeKeyVersion} desc`,
                      )
                : [];
            const selfGrants = areaIds.length
                ? await tx
                      .select()
                      .from(workspaceKeys)
                      .where(
                          and(
                              eq(workspaceKeys.userId, userId),
                              inArray(workspaceKeys.workspaceId, areaIds),
                          ),
                      )
                : [];
            return memberships.map((membership) => ({
                ...membership,
                areas: areas
                    .filter((area) => area.groupId === membership.groupId)
                    .map((area) => ({
                        workspaceId: area.workspaceId,
                        idSeed: area.idSeed!,
                        workspaceKeyVersion: area.workspaceKeyVersion,
                        changeSeq: area.changeSeq,
                        root: roots.find((root) => root.workspaceId === area.workspaceId) ?? null,
                        rotation:
                            running.find((row) => row.workspaceId === area.workspaceId) ?? null,
                        grant:
                            grants.find((grant) => grant.workspaceId === area.workspaceId) ?? null,
                        selfGrant:
                            selfGrants.find((grant) => grant.workspaceId === area.workspaceId) ??
                            null,
                    })),
            }));
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
}

/* The group's areas with their current key versions and roots: what a rotation or removal names. */
export async function listAreas(groupId: string) {
    return db
        .select({
            workspaceId: workspaces.id,
            idSeed: workspaces.idSeed,
            workspaceKeyVersion: workspaces.workspaceKeyVersion,
            rotationDueAt: workspaces.rotationDueAt,
        })
        .from(workspaces)
        .where(and(eq(workspaces.groupId, groupId), isNull(workspaces.deletedAt)))
        .orderBy(workspaces.id);
}

/* How many members are active: the seats used. */
export async function seatsUsed(groupId: string) {
    const [row] = await db
        .select({ used: count() })
        .from(groupMemberships)
        .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.state, 'active')));
    return row?.used ?? 0;
}

/*
 * Who lacks a grant of an area's current key: each (area, active member)
 * with no grant at the area's current version. In a family every member opens
 * every area, so these are owed before the next roster (docs/groups-server.md
 * 8, "Grants after a rotation").
 */
export async function missingGrants(groupId: string) {
    const result = await db.execute<{ workspace_id: string; user_id: string }>(sql`
        select w.id as workspace_id, m.user_id
        from ${workspaces} w
        join ${groupMemberships} m on m.group_id = w.group_id and m.state = 'active'
        where w.group_id = ${groupId}
          and w.deleted_at is null
          and not exists (
              select 1 from ${areaGrants} g
              where g.workspace_id = w.id
                and g.workspace_key_version = w.workspace_key_version
                and g.grantee_user_id = m.user_id
          )
        order by w.id, m.user_id
    `);
    return result.rows.map((row) => ({ workspaceId: row.workspace_id, userId: row.user_id }));
}

/*
 * The gaps `userId` could fill themselves (route 3's `due.grants`): each
 * (area, other active member) with no grant of the area's current key, in the
 * areas where `userId` holds that key (a grant at the current version from a
 * granter still active, which their client accepts, or a self-grant at it),
 * since a grant is the key sealed by someone who has it. Never a gap of their
 * own: route 22 refuses a grant to the uploader. "Holds" is the server's word
 * for it: a grant that opens nothing still counts.
 */
export async function fillableGrants(groupId: string, userId: string) {
    const result = await db.execute<{ workspace_id: string; user_id: string }>(sql`
        select w.id as workspace_id, m.user_id
        from ${workspaces} w
        join ${groupMemberships} m on m.group_id = w.group_id and m.state = 'active'
        where w.group_id = ${groupId}
          and w.deleted_at is null
          and m.user_id <> ${userId}
          and not exists (
              select 1 from ${areaGrants} g
              where g.workspace_id = w.id
                and g.workspace_key_version = w.workspace_key_version
                and g.grantee_user_id = m.user_id
          )
          and (
              exists (
                  select 1 from ${areaGrants} own
                  join ${groupMemberships} granter
                    on granter.group_id = w.group_id
                   and granter.user_id = own.granter_user_id
                   and granter.state = 'active'
                  where own.workspace_id = w.id
                    and own.workspace_key_version = w.workspace_key_version
                    and own.grantee_user_id = ${userId}
              )
              or exists (
                  select 1 from ${workspaceKeys} k
                  where k.workspace_id = w.id
                    and k.user_id = ${userId}
                    and k.workspace_key_version = w.workspace_key_version
              )
          )
        order by w.id, m.user_id
    `);
    return result.rows.map((row) => ({ workspaceId: row.workspace_id, userId: row.user_id }));
}

/*
 * Family folders deleted more than `days` ago (docs/groups-design.md 2.10:
 * Drive's trash retention) that no open or held report names (a report's
 * evidence, origin drops included, stays until it lets go, as the deletion
 * outbox keeps the objects it names), each purged whole in its own transaction under
 * its group's lock and then its own row: every object in it queued for
 * deletion from the store (the outbox the delete-objects job drains, replica
 * copies after their own window), then the workspace row, which takes its
 * nodes, versions, grants, self-grants, documents, storage row, shares,
 * links and rotations with it. At most `limit` folders a pass; how many went.
 */
export async function purgeDeletedAreas(days: number, limit = 20) {
    const due = await db
        .select({ id: workspaces.id, groupId: workspaces.groupId })
        .from(workspaces)
        .where(
            and(
                isNotNull(workspaces.deletedAt),
                sql`${workspaces.deletedAt} < now() - make_interval(days => ${days})`,
                // Evidence first: a folder an open or held report names waits for the report.
                unheldWorkspaceCondition(workspaces.id),
            ),
        )
        .orderBy(workspaces.deletedAt)
        .limit(limit);
    let purged = 0;
    for (const { id, groupId } of due) {
        const gone = await db.transaction(async (tx) => {
            // The order every chain write takes: the group first, then its areas.
            if (groupId) await lockGroup(tx, groupId);
            const [area] = await tx
                .select({ id: workspaces.id })
                .from(workspaces)
                .where(
                    and(
                        eq(workspaces.id, id),
                        isNotNull(workspaces.deletedAt),
                        unheldWorkspaceCondition(workspaces.id),
                    ),
                )
                .for('update');
            if (!area) return false;
            await tx.execute(sql`
                insert into ${driveObjectDeletions}
                    (object_id, workspace_id, object_key, published, replicated)
                select o.id, o.workspace_id, o.object_key, o.status = 'ready', o.replicated_at is not null
                from ${driveObjects} o
                where o.workspace_id = ${id}
                on conflict do nothing
            `);
            await tx.delete(workspaces).where(eq(workspaces.id, id));
            return true;
        });
        if (gone) purged++;
    }
    return purged;
}
