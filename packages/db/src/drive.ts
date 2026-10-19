import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { db } from './client';
import { holdsWorkspace } from './membership';
import { heldObjectCondition } from './reports';
import { settlingPool, storageFigures, type StorageFigures } from './pool';
import { openShareCursor, sealShareCursor } from './share-cursor';
import {
    metadataSigned as metadataSignedStatement,
    verifySigned,
    versionSigned as versionSignedStatement,
    type SignedStatement,
} from './signatures';
import {
    accountIdentities,
    driveLinks,
    driveNodes,
    driveObjectDeletions,
    driveObjects,
    driveRotations,
    driveShareEvents,
    driveShares,
    driveSweeps,
    driveUploads,
    fileVersions,
    groupHolds,
    groupMemberships,
    groups,
    personalWorkspaces,
    users,
    workspaceKeys,
    workspaceStorage,
    workspaces,
    workspaceDocuments,
} from './schema';

/*
 * The Drive tree, as docs/drive-design.md fixes it. Every write is one
 * transaction that first takes the workspace's next `change_seq`, which locks the
 * workspace row and serialises writes within a workspace; that lock is what makes
 * the cycle and depth checks sound. Every operation reads a fixed number of rows
 * whatever the size of the tree: the ancestor walk is capped, listings are paged,
 * and nothing here fans out over a subtree.
 *
 * Results are discriminated by `status`; the API layer turns them into HTTP
 * codes and messages. Envelopes are opaque Buffers here.
 */

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/* Thrown to undo a transaction whose result is a refusal; carries the result out. */
class Refusal extends Error {
    constructor(readonly result: unknown) {
        super('refused');
    }
}

/*
 * A transaction that commits only the outcomes named in `keep`; any other
 * result is returned with every write before it undone. For writes that can
 * be refused partway (an id already taken, a later folder in a batch), where a
 * plain return would commit what came before: a storage reservation, a node
 * with no version, the first folders of a batch that "lands whole or not at all".
 */
async function transactionKeeping<T extends { status: string }>(
    keep: readonly T['status'][],
    work: (tx: Tx) => Promise<T>,
): Promise<T> {
    try {
        return await db.transaction(async (tx) => {
            const result = await work(tx);
            if (!keep.includes(result.status)) throw new Refusal(result);
            return result;
        });
    } catch (error) {
        if (error instanceof Refusal) return error.result as T;
        throw error;
    }
}

export const MAX_DEPTH = 64;
export const WALK_CAP = 128;
export const PAGE_SIZE = 500;

export type NodeKind = 'folder' | 'file';

type ChainRow = {
    id: string;
    parent_id: string | null;
    workspace_id: string;
    kind: NodeKind;
    key_epoch: number;
    trashed_at: Date | null;
    purged_at: Date | null;
    height_bound: number;
    depth: number;
};

export type Ancestor = { id: string; parentId: string | null; keyEpoch: number };

export type Walk = {
    node: ChainRow;
    /* Root first, ending with the node's parent; empty for the root. */
    ancestors: Ancestor[];
    depth: number; // the root is 0
    trashed: boolean; // the node or any ancestor
    purged: boolean;
    rootId: string;
};

/*
 * One recursive query from a node up to the root, capped at WALK_CAP rows. A
 * chain that does not reach a root inside the cap is treated as not found: no
 * legal tree is that deep, so it is corruption, not a limit anyone can hit.
 */
export async function walk(tx: Tx, nodeId: string): Promise<Walk | null> {
    const result = await tx.execute<ChainRow>(sql`
        with recursive chain as (
            select id, parent_id, workspace_id, kind, key_epoch, trashed_at, purged_at,
                   height_bound, 1 as depth
            from drive_nodes where id = ${nodeId}
            union all
            select n.id, n.parent_id, n.workspace_id, n.kind, n.key_epoch, n.trashed_at,
                   n.purged_at, n.height_bound, c.depth + 1
            from drive_nodes n join chain c on n.id = c.parent_id
            where c.depth < ${WALK_CAP}
        )
        select * from chain order by depth
    `);
    const rows = result.rows;
    const node = rows[0];
    const top = rows.at(-1);
    if (!node || !top || top.parent_id !== null) return null;
    const ancestors = rows
        .slice(1)
        .reverse()
        .map((row) => ({ id: row.id, parentId: row.parent_id, keyEpoch: row.key_epoch }));
    return {
        node,
        ancestors,
        depth: rows.length - 1,
        trashed: rows.some((row) => row.trashed_at !== null),
        purged: rows.some((row) => row.purged_at !== null),
        rootId: top.id,
    };
}

/*
 * A move across a share boundary: shares above the old parent but not the
 * new one see the node leave; shares above the new parent but not the old
 * one see it enter. A share on the moved node itself is on both sides.
 */
async function recordShareEvents(
    tx: Tx,
    changeSeq: number,
    nodeId: string,
    fromChain: string[],
    toChain: string[],
) {
    const ids = [...new Set([...fromChain, ...toChain])];
    if (!ids.length) return;
    const shares = await tx
        .select({ id: driveShares.id, nodeId: driveShares.nodeId })
        .from(driveShares)
        .where(and(inArray(driveShares.nodeId, ids), isNull(driveShares.revokedAt)));
    const from = new Set(fromChain);
    const to = new Set(toChain);
    const events = shares.flatMap((share) => {
        const before = from.has(share.nodeId);
        const after = to.has(share.nodeId);
        if (before === after) return [];
        return [
            {
                shareId: share.id,
                changeSeq,
                nodeId,
                kind: before ? ('left' as const) : ('entered' as const),
            },
        ];
    });
    if (events.length) await tx.insert(driveShareEvents).values(events);
}

/* The rotation running in a workspace, if any. */
export async function activeRotation(tx: Tx | typeof db, workspaceId: string) {
    const [row] = await tx
        .select({
            id: driveRotations.id,
            nodeId: driveRotations.nodeId,
            targetEpoch: driveRotations.targetEpoch,
        })
        .from(driveRotations)
        .where(and(eq(driveRotations.workspaceId, workspaceId), isNull(driveRotations.finishedAt)));
    return row ?? null;
}

/*
 * In a group area while a rotation runs: whether `parent` (or, for a new
 * version, the file itself) is inside the run's
 * subtree and not re-keyed yet (its key epoch below the target). A node made
 * there, or moved there, would be wrapped under a key a removed member holds,
 * and the walk only re-wraps a node already at the target, never re-keys it,
 * so that key would stay theirs for good (docs/groups-server.md 8, "Uploads
 * wait"). Refused as `rotating`: the client waits for the walk and tries again.
 * Personal workspaces keep their rules (a share's rotation there is the
 * owner's own, and nobody was removed).
 */
export async function underUnrotatedParent(tx: Tx, workspaceId: string, parent: Walk) {
    const rotation = await activeRotation(tx, workspaceId);
    if (!rotation) return false;
    const inside =
        parent.node.id === rotation.nodeId ||
        parent.ancestors.some((ancestor) => ancestor.id === rotation.nodeId);
    if (!inside) return false;
    if (parent.node.key_epoch >= rotation.targetEpoch) {
        // At the target but still wrapped under its parent's old key (made under an unreached
        // folder before this rule, or by a server that did not keep it): not reached either.
        // A top folder is wrapped under its area's key version, which is no node epoch.
        if (parent.node.parent_id === null) return false;
        const [row] = await tx
            .select({ parentKeyEpoch: driveNodes.parentKeyEpoch })
            .from(driveNodes)
            .where(eq(driveNodes.id, parent.node.id));
        if (!row || row.parentKeyEpoch >= rotation.targetEpoch) return false;
    }
    const [workspace] = await tx
        .select({ ownerKind: workspaces.ownerKind })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
    return workspace?.ownerKind === 'group';
}

/*
 * Locks the workspace row and takes the next change sequence number. With the
 * writer named, a group area also checks, under that lock, that they may
 * still write there (requireStillWriter).
 */
export async function nextChangeSeq(
    tx: Tx,
    workspaceId: string,
    writer?: string,
    /* A roster's own Drive writes (its area rotations): membership checked, holds not. */
    options: { roster?: boolean } = {},
) {
    const [row] = await tx
        .update(workspaces)
        .set({ changeSeq: sql`${workspaces.changeSeq} + 1` })
        .where(eq(workspaces.id, workspaceId))
        .returning({ changeSeq: workspaces.changeSeq, groupId: workspaces.groupId });
    if (!row) throw new Error('Workspace not found.');
    // The row is locked by the update: a personal workspace (no group) needs nothing more.
    if (writer) await requireStillWriter(tx, workspaceId, writer, row.groupId, options);
    return row.changeSeq;
}

/*
 * Whether the account may start a subtree rotation here: anyone who owns a
 * personal workspace; in a group area only an active `members` holder, since
 * a group's area keys move only through its rosters (docs/groups-server.md
 * 8), and a rotation someone else started and left would otherwise stall
 * every roster that rotates the area.
 */
export async function mayStartRotation(userId: string, workspaceId: string) {
    const [row] = await db
        .select({
            ownerKind: workspaces.ownerKind,
            roles: groupMemberships.roles,
            state: groupMemberships.state,
        })
        .from(workspaces)
        .leftJoin(
            groupMemberships,
            and(
                eq(groupMemberships.groupId, workspaces.groupId),
                eq(groupMemberships.userId, userId),
            ),
        )
        .where(eq(workspaces.id, workspaceId));
    if (!row) return false;
    if (row.ownerKind === 'personal') return true;
    return row.state === 'active' && (row.roles ?? []).includes('members');
}

/*
 * Whether `nodeId` is the root of a group area (a family folder's top folder):
 * its key changes only with a roster rotation, which commits to it
 * (docs/groups-design.md 2.10), never with a Drive rotation started there.
 */
export async function isGroupAreaRoot(workspaceId: string, nodeId: string) {
    const [row] = await db
        .select({ id: driveNodes.id })
        .from(driveNodes)
        .innerJoin(workspaces, eq(workspaces.id, driveNodes.workspaceId))
        .where(
            and(
                eq(driveNodes.id, nodeId),
                eq(driveNodes.workspaceId, workspaceId),
                isNull(driveNodes.parentId),
                eq(workspaces.ownerKind, 'group'),
            ),
        );
    return row !== undefined;
}

/*
 * A write in a group area its writer may no longer make: their access ended after the
 * Drive domain checked it (`ended`), or a holder holds them ahead of a removal (`held`).
 */
export class AccessEndedError extends Error {
    constructor(readonly reason: 'ended' | 'held' = 'ended') {
        super(reason === 'held' ? 'Writes here are paused.' : 'Access to this workspace ended.');
        this.name = 'AccessEndedError';
    }
}

/*
 * Inside a Drive write, after the workspace row is locked: in a group area,
 * the writer must still be a member (membership.ts) or hold a live editor
 * share there. The Drive domain checked access before the write's
 * transaction; a departure takes the same row lock (lockAreas) and revokes
 * the person's key and shares to them in one transaction, so this check,
 * under the lock, sees it either fully or not at all. Without it a removal
 * committing in between would let one write (a share or link that escapes the
 * revocation, say) land after it. A writer a holder holds ahead of their
 * removal (group_holds) is refused too, so they cannot keep moving the area's
 * epochs past the remover's rotation. Personal workspaces take nothing more.
 */
export async function requireStillWriter(
    tx: Tx,
    workspaceId: string,
    writer: string,
    /* The area's group, when the caller already holds the workspace row locked (null: personal). */
    locked?: string | null,
    /*
     * A roster's own writes skip the hold: holders are equal peers who race on rosters, and a
     * target who holds their remover must not be able to block the removal's rotation.
     */
    options: { roster?: boolean } = {},
) {
    let groupId = locked;
    if (groupId === undefined) {
        // A personal workspace takes no lock and no wait here: only its owner writes there.
        const [kind] = await tx
            .select({ groupId: workspaces.groupId })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId));
        if (!kind?.groupId) return;
        // A group area's row under a share lock, which a departure's lock on it waits for.
        await tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .for('share');
        groupId = kind.groupId;
    }
    if (!groupId) return;
    const [held] = options.roster
        ? []
        : await tx
              .select({ userId: groupHolds.userId })
              .from(groupHolds)
              .where(
                  and(
                      eq(groupHolds.groupId, groupId),
                      eq(groupHolds.userId, writer),
                      gt(groupHolds.expiresAt, sql`now()`),
                  ),
              );
    if (held) throw new AccessEndedError('held');
    if (await holdsWorkspace(tx, writer, workspaceId)) return;
    const [share] = await tx
        .select({ id: driveShares.id })
        .from(driveShares)
        .where(
            and(
                eq(driveShares.workspaceId, workspaceId),
                eq(driveShares.granteeUserId, writer),
                eq(driveShares.role, 'editor'),
                isNull(driveShares.revokedAt),
            ),
        )
        .limit(1);
    if (!share) throw new AccessEndedError();
}

/*
 * Reserves `count` node key epochs. The client wraps keys under the epochs it
 * was given; an epoch a client never uses is a gap, and gaps are harmless because
 * the counter only has to exceed every epoch a node has ever carried.
 */
/* With the writer named, a group area refuses a writer who is held or no longer in it. */
export async function allocateKeyEpochs(workspaceId: string, count: number, writer?: string) {
    if (!Number.isInteger(count) || count < 1 || count > 10_000)
        throw new Error('Invalid epoch count.');
    return db.transaction(async (tx) => {
        const [row] = await tx
            .update(workspaces)
            .set({ keyEpochSeq: sql`${workspaces.keyEpochSeq} + ${count}` })
            .where(eq(workspaces.id, workspaceId))
            .returning({ keyEpochSeq: workspaces.keyEpochSeq, groupId: workspaces.groupId });
        if (!row) return null;
        if (writer) await requireStillWriter(tx, workspaceId, writer, row.groupId);
        return { from: row.keyEpochSeq - count + 1, to: row.keyEpochSeq };
    });
}

async function epochWasAllocated(tx: Tx, workspaceId: string, keyEpoch: number) {
    const [row] = await tx
        .select({ keyEpochSeq: workspaces.keyEpochSeq })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
    return row !== undefined && keyEpoch >= 1 && keyEpoch <= row.keyEpochSeq;
}

/* Raises the height bound on every ancestor lower than its distance to a new leaf. */
async function raiseHeightBounds(tx: Tx, ancestors: Ancestor[], leafHeight: number) {
    // ancestors is root first; the parent is last and one level above the leaf.
    for (let i = 0; i < ancestors.length; i++) {
        const distance = ancestors.length - i + leafHeight;
        const ancestor = ancestors[i]!;
        await tx
            .update(driveNodes)
            .set({ heightBound: distance })
            .where(and(eq(driveNodes.id, ancestor.id), lt(driveNodes.heightBound, distance)));
    }
}

const nodeColumns = {
    id: driveNodes.id,
    envelopeSuite: driveNodes.envelopeSuite,
    metadataSignerId: driveNodes.metadataSignerId,
    metadataSignature: driveNodes.metadataSignature,
    metadataOriginEnvelope: driveNodes.metadataOriginEnvelope,
    metadataOriginKeyEnvelope: driveNodes.metadataOriginKeyEnvelope,
    metadataOriginSignerId: driveNodes.metadataOriginSignerId,
    metadataOriginSignature: driveNodes.metadataOriginSignature,
    metadataRekeySignature: driveNodes.metadataRekeySignature,
    metadataDroppedSignerId: driveNodes.metadataDroppedSignerId,
    metadataOriginDroppedBy: driveNodes.metadataOriginDroppedBy,
    workspaceId: driveNodes.workspaceId,
    parentId: driveNodes.parentId,
    kind: driveNodes.kind,
    keyEpoch: driveNodes.keyEpoch,
    parentKeyEpoch: driveNodes.parentKeyEpoch,
    keyEnvelope: driveNodes.keyEnvelope,
    prevKeyEnvelope: driveNodes.prevKeyEnvelope,
    prevKeyEpoch: driveNodes.prevKeyEpoch,
    prevParentKeyEpoch: driveNodes.prevParentKeyEpoch,
    metadataVersion: driveNodes.metadataVersion,
    metadataEnvelope: driveNodes.metadataEnvelope,
    currentVersionId: driveNodes.currentVersionId,
    trashedAt: driveNodes.trashedAt,
    changeSeq: driveNodes.changeSeq,
    heightBound: driveNodes.heightBound,
    createdAt: driveNodes.createdAt,
    updatedAt: driveNodes.updatedAt,
};
const versionColumns = {
    id: fileVersions.id,
    objectId: fileVersions.objectId,
    contentKeyEnvelope: fileVersions.contentKeyEnvelope,
    status: fileVersions.status,
    plaintextSize: driveObjects.plaintextSize,
    ciphertextSize: driveObjects.ciphertextSize,
    chunkSize: driveObjects.chunkSize,
    chunkCount: driveObjects.chunkCount,
    contentNonce: driveObjects.contentNonce,
    contentSuite: driveObjects.contentSuite,
    objectStatus: driveObjects.status,
    readyAt: fileVersions.readyAt,
    signerId: fileVersions.signerId,
    signature: fileVersions.signature,
    originEnvelope: fileVersions.originEnvelope,
    originKeyEnvelope: fileVersions.originKeyEnvelope,
    originSignerId: fileVersions.originSignerId,
    originSignature: fileVersions.originSignature,
    rekeySignature: fileVersions.rekeySignature,
    droppedSignerId: fileVersions.droppedSignerId,
    originDroppedBy: fileVersions.originDroppedBy,
};
/*
 * What every write that sets a record's envelope outside a rotation clears: the
 * origin a rotation kept and the re-keyer's signature over it, which describe
 * the envelope being replaced (docs/integrity-design.md, "What the server
 * enforces").
 */
export const NO_METADATA_ORIGIN = {
    metadataOriginEnvelope: null,
    metadataOriginKeyEnvelope: null,
    metadataOriginSignerId: null,
    metadataOriginSignature: null,
    metadataRekeySignature: null,
} as const;
export const NO_VERSION_ORIGIN = {
    originEnvelope: null,
    originKeyEnvelope: null,
    originSignerId: null,
    originSignature: null,
    rekeySignature: null,
} as const;
/*
 * A purge clears a dropped origin's trace with everything else; a rename does
 * not, so writing a record again never hides that its origin was dropped
 * (drive_origin_drops keeps the evidence either way).
 */
export const PURGED_METADATA_ORIGIN = {
    ...NO_METADATA_ORIGIN,
    metadataDroppedSignerId: null,
    metadataOriginDroppedBy: null,
} as const;
export const PURGED_VERSION_ORIGIN = {
    ...NO_VERSION_ORIGIN,
    droppedSignerId: null,
    originDroppedBy: null,
} as const;
/*
 * Who wrote a record: the account id alone. A client names a signer from its
 * own pins ("you", a checked contact) or not at all; the server hands out no
 * name or email of a co-editor to whoever can see the record.
 */
export type Signer = { id: string };
type RawNodeRow = Omit<
    typeof driveNodes.$inferSelect,
    'createdBy' | 'purgedAt' | 'purgedAncestorIds'
>;
export type NodeRow = RawNodeRow & { metadataSigner: Signer | null };
type RawVersionRow = Omit<VersionRow, 'signer'>;
export type VersionRow = {
    id: string;
    objectId: string;
    contentKeyEnvelope: Buffer | null;
    signerId: string | null;
    signature: Buffer | null;
    signer: Signer | null;
    /* A re-keyed version's origin (see fileVersions); all null otherwise. */
    originEnvelope: Buffer | null;
    originKeyEnvelope: Buffer | null;
    originSignerId: string | null;
    originSignature: Buffer | null;
    rekeySignature: Buffer | null;
    /* A dropped origin's signer and who dropped it (see fileVersions); null otherwise. */
    droppedSignerId: string | null;
    originDroppedBy: string | null;
    status: 'pending' | 'ready' | 'purged';
    /* Suite 1 only; null under suite 2, where the envelope carries it. */
    plaintextSize: bigint | null;
    ciphertextSize: bigint;
    chunkSize: number;
    chunkCount: number;
    contentNonce: Buffer;
    contentSuite: number;
    objectStatus: 'pending' | 'ready' | 'missing';
    readyAt: Date | null;
};

/* A signer column as the view it is served as; a deleted account's is already null. */
export function signerOf(id: string | null | undefined): Signer | null {
    return id ? { id } : null;
}
function withVersionSigner(version: RawVersionRow): VersionRow {
    return { ...version, signer: signerOf(version.signerId) };
}
/* Node rows read without their versions (an update's returning clause), with their signers. */
function signNodes(nodes: RawNodeRow[]): NodeRow[] {
    return nodes.map((node) => ({ ...node, metadataSigner: signerOf(node.metadataSignerId) }));
}

export async function selectNodes(tx: Tx, ids: string[]) {
    if (!ids.length) return [] as (NodeRow & { currentVersion: VersionRow | null })[];
    const rows = await tx
        .select({ node: nodeColumns, version: versionColumns })
        .from(driveNodes)
        .leftJoin(fileVersions, eq(fileVersions.id, driveNodes.currentVersionId))
        .leftJoin(driveObjects, eq(driveObjects.id, fileVersions.objectId))
        .where(inArray(driveNodes.id, ids));
    return rows.map((row) => ({
        ...(row.node as RawNodeRow),
        metadataSigner: signerOf(row.node.metadataSignerId),
        currentVersion: row.version.id ? withVersionSigner(row.version as RawVersionRow) : null,
    }));
}

/*
 * Whether every statement carries a valid signature by `userId`'s current
 * version 2 identity's Ed25519 key, in either form (ordinary, or re-sealed for a record
 * the writer re-locked without vouching for it). Checked inside the writing
 * transaction, before any row changes, so a write either lands signed or not
 * at all.
 */
export type { SignedStatement };
/*
 * A signed write from an account whose identity is still version 1: clients
 * upgrade on unlock before any write (docs/identity-pq-design.md 5), so this is
 * an outdated build. Thrown, not reported as a bad signature, so the API can
 * tell it to update (409) instead of calling its signature forged.
 */
export class OutdatedIdentityError extends Error {
    override name = 'OutdatedIdentityError';
    constructor() {
        super('Update HushOS to save changes.');
    }
}
export async function signedBy(tx: Tx, userId: string, statements: SignedStatement[]) {
    const key = await currentSigningKey(tx, userId);
    return key !== null && statements.every((statement) => verifySigned(key, statement));
}
/*
 * The Ed25519 key `userId` signs records with now, or null without an
 * identity. A version 1 identity signs nothing: clients upgrade it on unlock
 * before any write (docs/identity-pq-design.md 5), so only an outdated client
 * gets here, and it is told so.
 */
export async function currentSigningKey(tx: Tx, userId: string) {
    const [identity] = await tx
        .select({
            version: accountIdentities.version,
            signingPublicKey: accountIdentities.signingPublicKey,
        })
        .from(accountIdentities)
        .where(eq(accountIdentities.userId, userId));
    if (!identity) return null;
    if (identity.version !== 2) throw new OutdatedIdentityError();
    return identity.signingPublicKey;
}
/* The metadata statement for a node's envelope as it is about to be stored. */
function metadataSigned(
    workspaceId: string,
    nodeId: string,
    kind: NodeKind,
    metadataVersion: number,
    envelopes: { metadataEnvelope: Buffer; metadataSignature: Buffer },
): SignedStatement {
    return metadataSignedStatement(
        {
            workspaceId,
            nodeId,
            kind,
            metadataVersion,
            metadataEnvelope: envelopes.metadataEnvelope,
        },
        envelopes.metadataSignature,
    );
}
function versionSigned(input: {
    workspaceId: string;
    nodeId: string;
    versionId: string;
    objectId: string;
    contentSuite: number;
    contentKeyEnvelope: Buffer;
    signature: Buffer;
}): SignedStatement {
    const { signature, ...statement } = input;
    return versionSignedStatement(statement, signature);
}

/* The user's personal workspace and their grant to its key, for opening Drive. */
export async function getPersonalWorkspace(userId: string) {
    const [row] = await db
        .select({
            workspaceId: personalWorkspaces.workspaceId,
            grant: workspaceKeys,
            changeSeq: workspaces.changeSeq,
        })
        .from(personalWorkspaces)
        .innerJoin(workspaces, eq(workspaces.id, personalWorkspaces.workspaceId))
        .leftJoin(
            workspaceKeys,
            and(
                eq(workspaceKeys.workspaceId, personalWorkspaces.workspaceId),
                eq(workspaceKeys.userId, userId),
            ),
        )
        .where(eq(personalWorkspaces.userId, userId));
    if (!row) return null;
    const [rootId] = await db
        .select({ id: driveNodes.id })
        .from(driveNodes)
        .where(and(eq(driveNodes.workspaceId, row.workspaceId), isNull(driveNodes.parentId)));
    const [root] = rootId
        ? await db.transaction((tx) => selectNodes(tx, [rootId.id]))
        : [undefined];
    return {
        workspaceId: row.workspaceId,
        changeSeq: row.changeSeq,
        grant: row.grant?.workspaceId ? row.grant : null,
        root: root ?? null,
        rotation: await activeRotation(db, row.workspaceId),
    };
}

/*
 * Whether the person holds the workspace's key and may use it: their own
 * personal workspace, or an area of a group they are an active member of
 * (membership.ts, the one definition Drive's authorization also uses).
 */
export async function isMember(userId: string, workspaceId: string) {
    return holdsWorkspace(db, userId, workspaceId);
}

export type NodeEnvelopes = {
    keyEpoch: number;
    parentKeyEpoch: number;
    keyEnvelope: Buffer;
    metadataEnvelope: Buffer;
    /* The writer's Ed25519 signature over the metadata statement (docs/integrity-design.md). */
    metadataSignature: Buffer;
};

/*
 * The root: created once, in the request that stores its envelope. Its parent key
 * is the workspace key, so `parentKeyEpoch` is the workspace key's own version.
 */
export type CreateRootInput = {
    workspaceId: string;
    userId: string;
    id: string;
    envelopes: NodeEnvelopes;
};
export async function createRoot(input: CreateRootInput) {
    return db.transaction((tx) => createRootIn(tx, input));
}

/* createRoot inside a caller's transaction: a group area's root lands with the area itself. */
export async function createRootIn(tx: Tx, input: CreateRootInput) {
    const changeSeq = await nextChangeSeq(tx, input.workspaceId, input.userId);
    const [existing] = await tx
        .select({ id: driveNodes.id })
        .from(driveNodes)
        .where(and(eq(driveNodes.workspaceId, input.workspaceId), isNull(driveNodes.parentId)));
    if (existing)
        return { status: 'exists' as const, root: (await selectNodes(tx, [existing.id]))[0]! };
    if (!(await epochWasAllocated(tx, input.workspaceId, input.envelopes.keyEpoch)))
        return { status: 'stale' as const };
    if (
        !(await signedBy(tx, input.userId, [
            metadataSigned(input.workspaceId, input.id, 'folder', 1, input.envelopes),
        ]))
    )
        return { status: 'bad-signature' as const };
    await tx.insert(driveNodes).values({
        id: input.id,
        workspaceId: input.workspaceId,
        parentId: null,
        kind: 'folder',
        ...input.envelopes,
        metadataSignerId: input.userId,
        createdBy: input.userId,
        changeSeq,
    });
    return { status: 'created' as const, root: (await selectNodes(tx, [input.id]))[0]! };
}

/*
 * A folder's live children, keyed by id, with the ancestor chain for breadcrumbs.
 * A listing inside a trashed or purged subtree is refused: nothing under a
 * trashed folder is reachable. Children without a `change_seq` are invisible.
 */
export async function listChildren(input: {
    workspaceId: string;
    parentId: string;
    after?: string;
    limit?: number;
    /* The share root a grantee entered through: ancestors above it are not theirs to see. */
    boundary?: string | null;
}) {
    return db.transaction(async (tx) => {
        const chain = await walk(tx, input.parentId);
        if (!chain || chain.node.workspace_id !== input.workspaceId || chain.purged)
            return { status: 'not-found' as const };
        if (chain.trashed) return { status: 'trashed' as const };
        if (chain.node.kind !== 'folder') return { status: 'not-found' as const };
        const limit = Math.min(input.limit ?? PAGE_SIZE, PAGE_SIZE);
        const ids = await tx
            .select({ id: driveNodes.id })
            .from(driveNodes)
            .where(
                and(
                    eq(driveNodes.parentId, input.parentId),
                    isNull(driveNodes.trashedAt),
                    isNull(driveNodes.purgedAt),
                    sql`${driveNodes.changeSeq} is not null`,
                    input.after ? gt(driveNodes.id, input.after) : undefined,
                ),
            )
            .orderBy(asc(driveNodes.id))
            .limit(limit + 1);
        const page = ids.slice(0, limit).map((row) => row.id);
        const children = await selectNodes(tx, page);
        children.sort((a, b) => (a.id < b.id ? -1 : 1));
        const [folder] = await selectNodes(tx, [input.parentId]);
        const ancestors = await selectNodes(
            tx,
            chain.ancestors.map((ancestor) => ancestor.id),
        );
        let ordered = chain.ancestors.map((a) => ancestors.find((row) => row.id === a.id)!);
        if (input.boundary) {
            const at = ordered.findIndex((row) => row.id === input.boundary);
            ordered = at >= 0 ? ordered.slice(at) : input.parentId === input.boundary ? [] : [];
        }
        return {
            status: 'ok' as const,
            folder: folder!,
            ancestors: ordered,
            children,
            nextCursor: ids.length > limit ? page.at(-1)! : null,
        };
    });
}

export async function getNode(workspaceId: string, nodeId: string) {
    return db.transaction(async (tx) => {
        const chain = await walk(tx, nodeId);
        if (!chain || chain.node.workspace_id !== workspaceId || chain.purged) return null;
        const [node] = await selectNodes(tx, [nodeId]);
        const ancestors = await selectNodes(
            tx,
            chain.ancestors.map((ancestor) => ancestor.id),
        );
        return {
            node: node!,
            ancestors: chain.ancestors.map((a) => ancestors.find((row) => row.id === a.id)!),
            trashed: chain.trashed,
            depth: chain.depth,
        };
    });
}

export type NewFolder = { id: string; envelopes: NodeEnvelopes };

/*
 * Creates folders under one parent in one transaction, in the order given. A
 * folder may name an earlier folder in the same batch as its parent, which is how
 * "one/two/three" becomes a chain in one request. Every envelope states the parent
 * key epoch it wrapped under and is refused if that epoch has moved.
 */
export async function createFolders(input: {
    workspaceId: string;
    userId: string;
    folders: (NewFolder & { parentId: string })[];
}) {
    return transactionKeeping(['created'], async (tx) => {
        const changeSeq = await nextChangeSeq(tx, input.workspaceId, input.userId);
        // Every folder's signature first: a batch lands whole or not at all.
        if (
            !(await signedBy(
                tx,
                input.userId,
                input.folders.map((folder) =>
                    metadataSigned(input.workspaceId, folder.id, 'folder', 1, folder.envelopes),
                ),
            ))
        )
            return { status: 'bad-signature' as const, id: null };
        const created = new Map<
            string,
            { depth: number; keyEpoch: number; ancestors: Ancestor[] }
        >();
        const ids: string[] = [];
        for (const folder of input.folders) {
            const inBatch = created.get(folder.parentId);
            let parentDepth: number;
            let parentEpoch: number;
            let ancestors: Ancestor[];
            if (inBatch) {
                parentDepth = inBatch.depth;
                parentEpoch = inBatch.keyEpoch;
                ancestors = inBatch.ancestors;
            } else {
                const chain = await walk(tx, folder.parentId);
                if (
                    !chain ||
                    chain.node.workspace_id !== input.workspaceId ||
                    chain.purged ||
                    chain.node.kind !== 'folder'
                )
                    return { status: 'not-found' as const, id: folder.parentId };
                if (chain.trashed)
                    return { status: 'parent-trashed' as const, id: folder.parentId };
                if (await underUnrotatedParent(tx, input.workspaceId, chain))
                    return { status: 'rotating' as const, id: folder.parentId };
                parentDepth = chain.depth;
                parentEpoch = chain.node.key_epoch;
                ancestors = [
                    ...chain.ancestors,
                    { id: chain.node.id, parentId: chain.node.parent_id, keyEpoch: parentEpoch },
                ];
            }
            if (parentDepth + 1 > MAX_DEPTH) return { status: 'too-deep' as const, id: folder.id };
            if (folder.envelopes.parentKeyEpoch !== parentEpoch)
                return { status: 'stale' as const, id: folder.parentId };
            if (!(await epochWasAllocated(tx, input.workspaceId, folder.envelopes.keyEpoch)))
                return { status: 'stale' as const, id: folder.id };
            const [row] = await tx
                .insert(driveNodes)
                .values({
                    id: folder.id,
                    workspaceId: input.workspaceId,
                    parentId: folder.parentId,
                    kind: 'folder',
                    ...folder.envelopes,
                    metadataSignerId: input.userId,
                    createdBy: input.userId,
                    changeSeq,
                })
                .onConflictDoNothing()
                .returning({ id: driveNodes.id });
            if (!row) return { status: 'conflict' as const, id: folder.id };
            ids.push(row.id);
            await raiseHeightBounds(tx, ancestors, 0);
            created.set(folder.id, {
                depth: parentDepth + 1,
                keyEpoch: folder.envelopes.keyEpoch,
                ancestors: [
                    ...ancestors,
                    {
                        id: folder.id,
                        parentId: folder.parentId,
                        keyEpoch: folder.envelopes.keyEpoch,
                    },
                ],
            });
        }
        const rows = await selectNodes(tx, ids);
        const nodes = ids.map((id) => rows.find((row) => row.id === id)!);
        return { status: 'created' as const, nodes, changeSeq };
    });
}

/* Replaces the metadata envelope; refuses a stale version or epoch with the current row. */
export async function renameNode(input: {
    workspaceId: string;
    nodeId: string;
    /* The account writing, whose signature this must be. */
    userId: string;
    metadataVersion: number; // the version the client saw
    keyEpoch: number; // the epoch the new envelope was encrypted under
    metadataEnvelope: Buffer;
    /* Signed over the version the envelope will have: the one seen, plus one. */
    metadataSignature: Buffer;
}) {
    return db.transaction(async (tx) => {
        const changeSeq = await nextChangeSeq(tx, input.workspaceId, input.userId);
        const chain = await walk(tx, input.nodeId);
        if (!chain || chain.node.workspace_id !== input.workspaceId || chain.purged)
            return { status: 'not-found' as const };
        if (chain.trashed) return { status: 'trashed' as const };
        if (
            !(await signedBy(tx, input.userId, [
                metadataSigned(
                    input.workspaceId,
                    input.nodeId,
                    chain.node.kind,
                    input.metadataVersion + 1,
                    input,
                ),
            ]))
        )
            return { status: 'bad-signature' as const };
        const [updated] = await tx
            .update(driveNodes)
            .set({
                metadataEnvelope: input.metadataEnvelope,
                metadataVersion: input.metadataVersion + 1,
                metadataSignerId: input.userId,
                metadataSignature: input.metadataSignature,
                ...NO_METADATA_ORIGIN,
                changeSeq,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(driveNodes.id, input.nodeId),
                    eq(driveNodes.metadataVersion, input.metadataVersion),
                    eq(driveNodes.keyEpoch, input.keyEpoch),
                ),
            )
            .returning(nodeColumns);
        if (updated)
            return {
                status: 'ok' as const,
                node: signNodes([updated as RawNodeRow])[0]!,
            };
        const [current] = await selectNodes(tx, [input.nodeId]);
        return { status: 'stale' as const, node: current! };
    });
}

/*
 * Moves a node: the same node key rewrapped under the destination's key. Two
 * bounded walks and one row update, whatever the size of the subtree.
 */
export async function moveNode(input: {
    workspaceId: string;
    /* The account writing: in a group area, checked again under the lock. */
    writer?: string;
    nodeId: string;
    parentId: string;
    parentKeyEpoch: number;
    keyEnvelope: Buffer;
}) {
    return db.transaction(async (tx) => {
        const changeSeq = await nextChangeSeq(tx, input.workspaceId, input.writer);
        const chain = await walk(tx, input.nodeId);
        if (!chain || chain.node.workspace_id !== input.workspaceId || chain.purged)
            return { status: 'not-found' as const };
        if (chain.node.parent_id === null) return { status: 'root' as const };
        if (chain.trashed) return { status: 'trashed' as const };
        const destination = await walk(tx, input.parentId);
        if (
            !destination ||
            destination.node.workspace_id !== input.workspaceId ||
            destination.purged ||
            destination.node.kind !== 'folder'
        )
            return { status: 'not-found' as const };
        if (destination.trashed) return { status: 'parent-trashed' as const };
        if (
            destination.node.id === input.nodeId ||
            destination.ancestors.some((ancestor) => ancestor.id === input.nodeId)
        )
            return { status: 'cycle' as const };
        if (destination.depth + 1 + chain.node.height_bound > MAX_DEPTH)
            return { status: 'too-deep' as const };
        // While a rotation runs, nothing leaves its subtree and a node the rotation has
        // reached (one still carrying its previous envelope) stays put.
        const rotation = await activeRotation(tx, input.workspaceId);
        if (rotation) {
            const [self] = await tx
                .select({ prev: driveNodes.prevKeyEnvelope })
                .from(driveNodes)
                .where(eq(driveNodes.id, input.nodeId));
            const inside = (walked: Walk) =>
                walked.node.id === rotation.nodeId ||
                walked.ancestors.some((a) => a.id === rotation.nodeId);
            if (self?.prev || (inside(chain) && !inside(destination)))
                return { status: 'rotating' as const };
            if (await underUnrotatedParent(tx, input.workspaceId, destination))
                return { status: 'rotating' as const };
        }
        if (input.parentKeyEpoch !== destination.node.key_epoch) {
            const [current] = await selectNodes(tx, [input.parentId]);
            return { status: 'stale' as const, node: current! };
        }
        const [moved] = await tx
            .update(driveNodes)
            .set({
                parentId: input.parentId,
                parentKeyEpoch: input.parentKeyEpoch,
                keyEnvelope: input.keyEnvelope,
                changeSeq,
                updatedAt: new Date(),
            })
            .where(eq(driveNodes.id, input.nodeId))
            .returning(nodeColumns);
        await recordShareEvents(
            tx,
            changeSeq,
            input.nodeId,
            chain.ancestors.map((a) => a.id),
            [...destination.ancestors.map((a) => a.id), destination.node.id],
        );
        await raiseHeightBounds(
            tx,
            [
                ...destination.ancestors,
                {
                    id: destination.node.id,
                    parentId: destination.node.parent_id,
                    keyEpoch: destination.node.key_epoch,
                },
            ],
            chain.node.height_bound,
        );
        return { status: 'ok' as const, node: signNodes([moved as RawNodeRow])[0]! };
    });
}

export async function trashNode(input: { workspaceId: string; nodeId: string; writer?: string }) {
    return db.transaction(async (tx) => {
        const changeSeq = await nextChangeSeq(tx, input.workspaceId, input.writer);
        const chain = await walk(tx, input.nodeId);
        if (!chain || chain.node.workspace_id !== input.workspaceId || chain.purged)
            return { status: 'not-found' as const };
        if (chain.node.parent_id === null) return { status: 'root' as const };
        if (chain.trashed) return { status: 'trashed' as const };
        const [node] = await tx
            .update(driveNodes)
            // Trashing is not a change to the item: its date stays what it was, trashedAt says when.
            .set({ trashedAt: new Date(), changeSeq })
            .where(eq(driveNodes.id, input.nodeId))
            .returning(nodeColumns);
        return { status: 'ok' as const, node: signNodes([node as RawNodeRow])[0]! };
    });
}

/*
 * Restores a node. If its parent is itself effectively trashed the caller must
 * supply a new home: a rewrapped envelope for the root, applied as a move and a
 * restore in one transaction.
 */
/*
 * An operator's removal on a report: trashed like the owner would, marked so the
 * owner cannot restore it, and every live share and link on the node revoked.
 * Anything shared or linked beneath it is cut by the trashed ancestor.
 */
export async function removeNode(input: { workspaceId: string; nodeId: string }) {
    return db.transaction((tx) => removeNodeIn(tx, input));
}
/* The same inside a caller's transaction: resolving a report removes and closes at once. */
export async function removeNodeIn(tx: Tx, input: { workspaceId: string; nodeId: string }) {
    const changeSeq = await nextChangeSeq(tx, input.workspaceId);
    const chain = await walk(tx, input.nodeId);
    if (!chain || chain.node.workspace_id !== input.workspaceId || chain.purged)
        return { status: 'not-found' as const };
    if (chain.node.parent_id === null) return { status: 'root' as const };
    const now = new Date();
    await tx
        .update(driveNodes)
        .set({
            trashedAt: chain.node.trashed_at ?? now,
            removedAt: now,
            changeSeq,
            updatedAt: now,
        })
        .where(eq(driveNodes.id, input.nodeId));
    const shares = await tx
        .update(driveShares)
        .set({ revokedAt: now, updatedAt: now })
        .where(and(eq(driveShares.nodeId, input.nodeId), isNull(driveShares.revokedAt)))
        .returning({ id: driveShares.id });
    const links = await tx
        .update(driveLinks)
        .set({ revokedAt: now })
        .where(and(eq(driveLinks.nodeId, input.nodeId), isNull(driveLinks.revokedAt)))
        .returning({ id: driveLinks.id });
    return { status: 'ok' as const, shares: shares.length, links: links.length };
}

export async function restoreNode(input: {
    workspaceId: string;
    /* The account writing: in a group area, checked again under the lock. */
    writer?: string;
    nodeId: string;
    toRoot?: { parentKeyEpoch: number; keyEnvelope: Buffer };
}) {
    return db.transaction(async (tx) => {
        const changeSeq = await nextChangeSeq(tx, input.workspaceId, input.writer);
        const chain = await walk(tx, input.nodeId);
        if (!chain || chain.node.workspace_id !== input.workspaceId || chain.purged)
            return { status: 'not-found' as const };
        if (chain.node.trashed_at === null) return { status: 'not-trashed' as const };
        const [removal] = await tx
            .select({ removedAt: driveNodes.removedAt })
            .from(driveNodes)
            .where(eq(driveNodes.id, input.nodeId));
        if (removal?.removedAt) return { status: 'removed' as const };
        const parent = chain.node.parent_id ? await walk(tx, chain.node.parent_id) : null;
        const parentTrashed = parent?.trashed ?? false;
        // Restoring is not a change either: a folder comes back with the date it had, not today's.
        const set: Partial<typeof driveNodes.$inferInsert> = {
            trashedAt: null,
            changeSeq,
        };
        if (parentTrashed) {
            if (!input.toRoot) return { status: 'parent-trashed' as const };
            const root = await walk(tx, chain.rootId);
            if (!root) return { status: 'not-found' as const };
            if (await underUnrotatedParent(tx, input.workspaceId, root))
                return { status: 'rotating' as const };
            if (input.toRoot.parentKeyEpoch !== root.node.key_epoch)
                return { status: 'stale' as const };
            if (1 + chain.node.height_bound > MAX_DEPTH) return { status: 'too-deep' as const };
            set.parentId = chain.rootId;
            set.parentKeyEpoch = input.toRoot.parentKeyEpoch;
            set.keyEnvelope = input.toRoot.keyEnvelope;
        }
        const [node] = await tx
            .update(driveNodes)
            .set(set)
            .where(eq(driveNodes.id, input.nodeId))
            .returning(nodeColumns);
        if (parentTrashed) {
            const root = await walk(tx, chain.rootId);
            if (root)
                await raiseHeightBounds(
                    tx,
                    [{ id: root.node.id, parentId: null, keyEpoch: root.node.key_epoch }],
                    chain.node.height_bound,
                );
        }
        return { status: 'ok' as const, node: signNodes([node as RawNodeRow])[0]! };
    });
}

/*
 * A trash page's cursor: where the last row stood in the order, as the microseconds
 * of its `trashed_at` and its id, "1790320010367123.<uuid>". Microseconds because
 * that is what Postgres keeps: a millisecond cursor would skip or repeat rows
 * trashed within the same millisecond.
 */
export const TRASH_CURSOR_PATTERN =
    '^[0-9]{1,18}\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

export function parseTrashCursor(cursor: string): { micros: bigint; id: string } | null {
    if (!new RegExp(TRASH_CURSOR_PATTERN).test(cursor)) return null;
    const [micros, id] = cursor.split('.') as [string, string];
    return { micros: BigInt(micros), id };
}

const trashedMicros = sql`(extract(epoch from ${driveNodes.trashedAt}) * 1000000)::bigint`;

/* Every node with its own `trashed_at`, newest first (the id breaking ties), with its chain for context. */
export async function listTrash(input: { workspaceId: string; after?: string; limit?: number }) {
    const after = input.after === undefined ? null : parseTrashCursor(input.after);
    if (input.after !== undefined && !after) throw new TypeError('Malformed trash cursor');
    return db.transaction(async (tx) => {
        const limit = Math.min(input.limit ?? PAGE_SIZE, PAGE_SIZE);
        const ids = await tx
            .select({ id: driveNodes.id, micros: sql<string>`${trashedMicros}::text` })
            .from(driveNodes)
            .where(
                and(
                    eq(driveNodes.workspaceId, input.workspaceId),
                    sql`${driveNodes.trashedAt} is not null`,
                    isNull(driveNodes.purgedAt),
                    // Keyset on the order itself: older, or as old with a later id.
                    after
                        ? sql`(${trashedMicros} < ${after.micros.toString()}::bigint or (${trashedMicros} = ${after.micros.toString()}::bigint and ${driveNodes.id} > ${after.id}::uuid))`
                        : undefined,
                ),
            )
            .orderBy(desc(driveNodes.trashedAt), asc(driveNodes.id))
            .limit(limit + 1);
        const page = ids.slice(0, limit).map((row) => row.id);
        const nodes = await selectNodes(tx, page);
        const ordered = page.map((id) => nodes.find((node) => node.id === id)!);
        const items = [];
        for (const node of ordered) {
            const chain = await walk(tx, node.id);
            // Under a purged ancestor the row is gone as far as the person is concerned:
            // the fan-out will purge it, and nothing they do here could reach it.
            if (!chain || chain.purged) continue;
            const ancestors = await selectNodes(
                tx,
                chain.ancestors.map((a) => a.id),
            );
            items.push({
                node,
                ancestors: chain.ancestors.map((a) => ancestors.find((row) => row.id === a.id)!),
                // An ancestor is itself in the trash: a restore needs a new home.
                parentTrashed: ancestors.some((ancestor) => ancestor.trashedAt !== null),
            });
        }
        const last = ids[limit - 1];
        return {
            items,
            nextCursor: ids.length > limit && last ? `${last.micros}.${last.id}` : null,
        };
    });
}

/* ------------------------------------------------------------------------- */
/* Uploads                                                                    */
/* ------------------------------------------------------------------------- */

/*
 * The upload protocol from the design: begin reserves bytes and inserts pending
 * rows; complete moves open -> completing, finishes at the store (the caller's
 * job, between the two steps), then publishes under the workspace lock after
 * rechecking every precondition; abort and expiry release. `used_bytes` and
 * `reserved_bytes` change only here and in purge, never from a client number.
 */

/*
 * What a workspace may still take, under the locks the reservation needs: a
 * family folder, or a family member's own files, read the family's pool
 * (docs/families-shared-pool.md 3.6, pool.ts); anything else its own
 * allowance. The pool row is locked before the storage row, so reservations
 * anywhere in one pool queue on it and cannot both spend the same free bytes;
 * each workspace still counts its own bytes, so purges and releases are
 * unchanged. Throws PoolMovedError when the owner's family changed under the
 * check: the caller runs its transaction again (settlingPool).
 */
async function freeBytes(tx: Tx, workspaceId: string) {
    return storageFigures(tx, workspaceId, { lock: true });
}

/*
 * The free space a reservation is checked against, and that a refusal names. A
 * pool's counts every other part (the family folders, each other member's own
 * files) in whole GiB and only the workspace's own part to the byte (pool.ts
 * PoolPart), so the answers to a run of upload begins, each cancelled once it
 * got through, learn the writer's own bytes and nothing finer than a GiB of
 * anyone else's (docs/families-shared-pool.md 3.6). A workspace's own
 * allowance is checked to the byte.
 */
function spendable(storage: StorageFigures) {
    return storage.free;
}
const named = (free: bigint) => (free > 0n ? free : 0n);

async function adjustStorage(tx: Tx, workspaceId: string, used: bigint, reserved: bigint) {
    await tx
        .update(workspaceStorage)
        .set({
            usedBytes: sql`${workspaceStorage.usedBytes} + ${used}`,
            reservedBytes: sql`${workspaceStorage.reservedBytes} + ${reserved}`,
            updatedAt: new Date(),
        })
        .where(eq(workspaceStorage.workspaceId, workspaceId));
}

/* The version envelope's length follows the object's suite: the key alone (1), or the key with the sizes (2 and 3). */
export function envelopeLengthFor(contentSuite: number) {
    return contentSuite === 1 ? 72 : 84;
}

/*
 * When a version's last reference to an object goes, the object row is replaced
 * by an outbox row in the same transaction; the worker takes it from there.
 */
async function retireObjectIfUnreferenced(tx: Tx, objectId: string) {
    const [live] = await tx
        .select({ id: fileVersions.id })
        .from(fileVersions)
        .where(and(eq(fileVersions.objectId, objectId), ne(fileVersions.status, 'purged')))
        .limit(1);
    if (live) return false;
    const [object] = await tx.delete(driveObjects).where(eq(driveObjects.id, objectId)).returning({
        workspaceId: driveObjects.workspaceId,
        objectKey: driveObjects.objectKey,
        status: driveObjects.status,
        replicatedAt: driveObjects.replicatedAt,
    });
    if (!object) return false;
    await tx
        .insert(driveObjectDeletions)
        .values({
            objectId,
            workspaceId: object.workspaceId,
            objectKey: object.objectKey,
            published: object.status === 'ready',
            replicated: object.replicatedAt !== null,
        })
        .onConflictDoNothing();
    return true;
}

export type UploadBegin = {
    workspaceId: string;
    userId: string;
    /* A new file node, invisible until its first version is ready, or an existing file. */
    node:
        | { existing: false; id: string; parentId: string; envelopes: NodeEnvelopes }
        | { existing: true; id: string; keyEpoch: number; expectedVersionId: string | null };
    /* The content-key envelope and the writer's signature over the version statement. */
    version: { id: string; contentKeyEnvelope: Buffer; signature: Buffer };
    /* Suites 2 and 3: the sizes are in the envelope, so the row carries only the declared object size. */
    object: {
        id: string;
        objectKey: string;
        contentSuite: number;
        chunkSize: number;
        chunkCount: number;
        contentNonce: Buffer;
        ciphertextSize: bigint;
    };
    multipartId: string;
    expiresAt: Date;
    /*
     * The file this upload moves here from another workspace of the same pool: the
     * new file is its copy, re-encrypted on the device under this workspace's keys,
     * and completion removes it (docs/families-shared-pool.md 3.8).
     */
    moveOf?: MoveOf;
};

/* A move's source as the client names it: the file and the version it read. */
export type MoveOf = { workspaceId: string; nodeId: string; versionId: string };

/* A move's source as begin found it, which completion holds it to. */
type MoveRecord = MoveOf & { changeSeq: number; freedBytes: bigint; by: string };

/* What removing `nodeId` gives back: every ready version's object, the current one and older ones (as purgeOne releases them). */
async function bytesFreedBy(tx: Tx, nodeId: string) {
    const [row] = await tx
        .select({ bytes: sql<string>`coalesce(sum(${driveObjects.ciphertextSize}), 0)::text` })
        .from(fileVersions)
        .innerJoin(driveObjects, eq(driveObjects.id, fileVersions.objectId))
        .where(and(eq(fileVersions.nodeId, nodeId), eq(fileVersions.status, 'ready')));
    return BigInt(row?.bytes ?? '0');
}

/*
 * Whether `userId` may still delete what `workspaceId` holds: they hold it (its
 * owner, or an active member of the family whose folder it is) and no holder holds
 * them ahead of a removal (requireStillWriter's rule, without the throw).
 */
async function mayStillRemove(tx: Tx, userId: string, workspaceId: string) {
    if (!(await holdsWorkspace(tx, userId, workspaceId))) return false;
    const [held] = await tx
        .select({ userId: groupHolds.userId })
        .from(groupHolds)
        .innerJoin(workspaces, eq(workspaces.groupId, groupHolds.groupId))
        .where(
            and(
                eq(workspaces.id, workspaceId),
                eq(groupHolds.userId, userId),
                gt(groupHolds.expiresAt, sql`now()`),
            ),
        );
    return held === undefined;
}

/*
 * The company hook (docs/families-shared-pool.md 6.4): HushOS's own move takes
 * nothing out of a company's area unless the company's policy allows it, for that
 * person or for everyone. Company plans and their policies don't exist yet, so
 * every company area refuses: this is where the rule attaches, not the rule. It
 * stops HushOS's move and nothing more: anyone who can open a company file can
 * save a copy of it, so no copy may say a file "can't leave", only that HushOS
 * won't move it. Personal and family workspaces are always allowed.
 */
async function movePolicyAllows(tx: Tx, sourceWorkspaceId: string, _userId: string) {
    const [row] = await tx
        .select({ kind: groups.kind })
        .from(workspaces)
        .innerJoin(groups, eq(groups.id, workspaces.groupId))
        .where(eq(workspaces.id, sourceWorkspaceId));
    return row?.kind !== 'org';
}

/*
 * Whether a move's source draws from the destination's pool, the destination's
 * figures having been read under the pool's lock (freeBytes): a member's own
 * files and their family's folders while the family's plan is live, or two
 * folders of one family. Under that lock the source owner's membership and the
 * plan are settled (every membership change and billing's pool write take it),
 * so the answer holds until commit. A destination on its own allowance (billing
 * off, no live plan, a group made before billing) shares a pool with nothing,
 * and a company area's pool is never a family's.
 */
async function samePool(tx: Tx, destination: StorageFigures, sourceWorkspaceId: string) {
    if (!destination.pool) return false;
    const source = await storageFigures(tx, sourceWorkspaceId, { lock: false });
    return source?.pool?.groupId === destination.pool.groupId;
}

/*
 * A move's source at begin (docs/families-shared-pool.md 3.8): a file in another
 * workspace, which the mover holds as a member (never through a share) and may
 * delete, at the version they read, and not in the Trash. The destination must be
 * the mover's too: a move lands in their own files or their family's folders, not
 * in a folder someone shares with them. What its versions free is what the move's
 * reservation is lowered by.
 */
async function moveSourceAtBegin(
    tx: Tx,
    input: UploadBegin & { moveOf: MoveOf },
): Promise<MoveRecord | { status: 'invalid' | 'not-found' | 'policy' | 'stale' }> {
    const { moveOf } = input;
    if (input.node.existing || moveOf.workspaceId === input.workspaceId)
        return { status: 'invalid' };
    if (!(await holdsWorkspace(tx, input.userId, input.workspaceId)))
        return { status: 'not-found' };
    if (!(await mayStillRemove(tx, input.userId, moveOf.workspaceId)))
        return { status: 'not-found' };
    if (!(await movePolicyAllows(tx, moveOf.workspaceId, input.userId)))
        return { status: 'policy' };
    const chain = await walk(tx, moveOf.nodeId);
    if (
        !chain ||
        chain.node.workspace_id !== moveOf.workspaceId ||
        chain.purged ||
        chain.node.kind !== 'file'
    )
        return { status: 'not-found' };
    if (chain.trashed) return { status: 'stale' };
    const [node] = await tx
        .select({ currentVersionId: driveNodes.currentVersionId, changeSeq: driveNodes.changeSeq })
        .from(driveNodes)
        .where(eq(driveNodes.id, moveOf.nodeId));
    if (!node || node.changeSeq === null || node.currentVersionId !== moveOf.versionId)
        return { status: 'stale' };
    return {
        ...moveOf,
        changeSeq: node.changeSeq,
        freedBytes: await bytesFreedBy(tx, moveOf.nodeId),
        by: input.userId,
    };
}

export async function beginUpload(input: UploadBegin) {
    return settlingPool(() => beginUploadOnce(input));
}

async function beginUploadOnce(input: UploadBegin) {
    return transactionKeeping(['ok'], async (tx) => {
        await nextChangeSeq(tx, input.workspaceId, input.userId);
        let keyEpoch: number;
        let expectedVersionId: string | null = null;
        let ancestors: Ancestor[] = [];
        if (input.node.existing) {
            const chain = await walk(tx, input.node.id);
            if (
                !chain ||
                chain.node.workspace_id !== input.workspaceId ||
                chain.purged ||
                chain.node.kind !== 'file'
            )
                return { status: 'not-found' as const };
            if (chain.trashed) return { status: 'trashed' as const };
            // A new version goes under the file's own key: one the walk has not reached is a key
            // a removed member may hold (the same rule as for a new node's parent).
            if (await underUnrotatedParent(tx, input.workspaceId, chain))
                return { status: 'rotating' as const };
            if (chain.node.key_epoch !== input.node.keyEpoch) return { status: 'stale' as const };
            const [current] = await tx
                .select({ currentVersionId: driveNodes.currentVersionId })
                .from(driveNodes)
                .where(eq(driveNodes.id, input.node.id));
            expectedVersionId = current?.currentVersionId ?? null;
            if (expectedVersionId !== input.node.expectedVersionId)
                return { status: 'stale' as const };
            keyEpoch = input.node.keyEpoch;
        } else {
            const parent = await walk(tx, input.node.parentId);
            if (
                !parent ||
                parent.node.workspace_id !== input.workspaceId ||
                parent.purged ||
                parent.node.kind !== 'folder'
            )
                return { status: 'not-found' as const };
            if (parent.trashed) return { status: 'parent-trashed' as const };
            if (await underUnrotatedParent(tx, input.workspaceId, parent))
                return { status: 'rotating' as const };
            if (parent.depth + 1 > MAX_DEPTH) return { status: 'too-deep' as const };
            if (input.node.envelopes.parentKeyEpoch !== parent.node.key_epoch)
                return { status: 'stale' as const };
            if (!(await epochWasAllocated(tx, input.workspaceId, input.node.envelopes.keyEpoch)))
                return { status: 'stale' as const };
            keyEpoch = input.node.envelopes.keyEpoch;
            ancestors = [
                ...parent.ancestors,
                {
                    id: parent.node.id,
                    parentId: parent.node.parent_id,
                    keyEpoch: parent.node.key_epoch,
                },
            ];
        }
        const statements = [
            versionSigned({
                workspaceId: input.workspaceId,
                nodeId: input.node.id,
                versionId: input.version.id,
                objectId: input.object.id,
                contentSuite: input.object.contentSuite,
                contentKeyEnvelope: input.version.contentKeyEnvelope,
                signature: input.version.signature,
            }),
        ];
        if (!input.node.existing)
            statements.push(
                metadataSigned(input.workspaceId, input.node.id, 'file', 1, input.node.envelopes),
            );
        if (!(await signedBy(tx, input.userId, statements)))
            return { status: 'bad-signature' as const };
        let move: MoveRecord | null = null;
        if (input.moveOf) {
            const source = await moveSourceAtBegin(tx, { ...input, moveOf: input.moveOf });
            if ('status' in source) return { status: source.status };
            move = source;
        }
        const storage = await freeBytes(tx, input.workspaceId);
        if (!storage) return { status: 'not-found' as const };
        // A move is pool-neutral: both sides are one pool, so it reserves only what the copy
        // takes beyond what the source frees, and a move into a full pool still goes. Across
        // pools it is refused as a move; the client copies and deletes instead.
        if (move && !(await samePool(tx, storage, move.workspaceId)))
            return { status: 'not-pooled' as const };
        const size = input.object.ciphertextSize;
        const reserve = move ? (size > move.freedBytes ? size - move.freedBytes : 0n) : size;
        if (reserve > 0n && spendable(storage) < reserve)
            return { status: 'over-quota' as const, free: named(spendable(storage)) };
        await adjustStorage(tx, input.workspaceId, 0n, reserve);
        if (!input.node.existing) {
            const [node] = await tx
                .insert(driveNodes)
                .values({
                    id: input.node.id,
                    workspaceId: input.workspaceId,
                    parentId: input.node.parentId,
                    kind: 'file',
                    ...input.node.envelopes,
                    metadataSignerId: input.userId,
                    createdBy: input.userId,
                    changeSeq: null,
                })
                .onConflictDoNothing()
                .returning({ id: driveNodes.id });
            if (!node) return { status: 'conflict' as const };
            void ancestors;
        }
        // Client-generated ids: one already taken, in this workspace or any other, is the
        // same refusal as a taken node id, and undoes the reservation above.
        const [object] = await tx
            .insert(driveObjects)
            .values({
                id: input.object.id,
                workspaceId: input.workspaceId,
                objectKey: input.object.objectKey,
                contentSuite: input.object.contentSuite,
                chunkSize: input.object.chunkSize,
                chunkCount: input.object.chunkCount,
                contentNonce: input.object.contentNonce,
                plaintextSize: null,
                ciphertextSize: input.object.ciphertextSize,
                status: 'pending',
            })
            .onConflictDoNothing()
            .returning({ id: driveObjects.id });
        if (!object) return { status: 'conflict' as const };
        const [version] = await tx
            .insert(fileVersions)
            .values({
                id: input.version.id,
                nodeId: input.node.id,
                workspaceId: input.workspaceId,
                objectId: input.object.id,
                contentKeyEnvelope: input.version.contentKeyEnvelope,
                signerId: input.userId,
                signature: input.version.signature,
                status: 'pending',
            })
            .onConflictDoNothing()
            .returning({ id: fileVersions.id });
        if (!version) return { status: 'conflict' as const };
        const [upload] = await tx
            .insert(driveUploads)
            .values({
                workspaceId: input.workspaceId,
                nodeId: input.node.id,
                versionId: input.version.id,
                objectId: input.object.id,
                objectKey: input.object.objectKey,
                keyEpoch,
                expectedVersionId,
                newNode: !input.node.existing,
                multipartId: input.multipartId,
                reservedBytes: reserve,
                expiresAt: input.expiresAt,
                status: 'open',
                ...(move && {
                    moveWorkspaceId: move.workspaceId,
                    moveNodeId: move.nodeId,
                    moveVersionId: move.versionId,
                    moveChangeSeq: move.changeSeq,
                    moveFreedBytes: move.freedBytes,
                    moveBy: move.by,
                }),
            })
            // The one conflict left is drive_uploads_one_move_idx: another move of the same
            // file is under way, and its source's bytes can't lower two reservations.
            .onConflictDoNothing()
            .returning({ id: driveUploads.id });
        if (!upload) return { status: 'moving' as const };
        return { status: 'ok' as const, uploadId: upload.id };
    });
}

const uploadColumns = {
    id: driveUploads.id,
    workspaceId: driveUploads.workspaceId,
    nodeId: driveUploads.nodeId,
    versionId: driveUploads.versionId,
    objectId: driveUploads.objectId,
    keyEpoch: driveUploads.keyEpoch,
    expectedVersionId: driveUploads.expectedVersionId,
    newNode: driveUploads.newNode,
    multipartId: driveUploads.multipartId,
    reservedBytes: driveUploads.reservedBytes,
    expiresAt: driveUploads.expiresAt,
    status: driveUploads.status,
    completingAt: driveUploads.completingAt,
    createdAt: driveUploads.createdAt,
    objectKey: driveUploads.objectKey,
    chunkSize: driveObjects.chunkSize,
    chunkCount: driveObjects.chunkCount,
    ciphertextSize: driveObjects.ciphertextSize,
};
/* The object framing is null once the object row was retired (aborted uploads). */
export type UploadRow = Omit<
    { [K in keyof typeof uploadColumns]: (typeof uploadColumns)[K]['_']['data'] },
    'chunkSize' | 'chunkCount' | 'ciphertextSize' | 'expectedVersionId'
> & {
    expectedVersionId: string | null;
    chunkSize: number | null;
    chunkCount: number | null;
    ciphertextSize: bigint | null;
};

export async function getUpload(workspaceId: string, uploadId: string): Promise<UploadRow | null> {
    const [row] = await db
        .select(uploadColumns)
        .from(driveUploads)
        .leftJoin(driveObjects, eq(driveObjects.id, driveUploads.objectId))
        .where(and(eq(driveUploads.id, uploadId), eq(driveUploads.workspaceId, workspaceId)));
    return (row as UploadRow | undefined) ?? null;
}

/*
 * Step one of complete: open -> completing. A repeat while completing is allowed (a retry).
 * With the writer named, a group area re-checks under the area's lock that they may still
 * write there; the area row first, as finishCompleting takes it, then the upload.
 */
export async function startCompleting(workspaceId: string, uploadId: string, writer?: string) {
    return db.transaction(async (tx) => {
        if (writer) await requireStillWriter(tx, workspaceId, writer);
        const [upload] = await tx
            .select(uploadColumns)
            .from(driveUploads)
            .leftJoin(driveObjects, eq(driveObjects.id, driveUploads.objectId))
            .where(and(eq(driveUploads.id, uploadId), eq(driveUploads.workspaceId, workspaceId)))
            .for('update', { of: driveUploads });
        if (!upload) return { status: 'not-found' as const };
        if (upload.status === 'completed') return { status: 'completed' as const, upload };
        if (upload.status === 'aborted') return { status: 'aborted' as const };
        if (upload.status === 'conflicted') return { status: 'conflicted' as const, upload };
        if (upload.status === 'open' && upload.expiresAt.getTime() <= Date.now())
            return { status: 'expired' as const };
        if (upload.status === 'open') {
            await tx
                .update(driveUploads)
                .set({ status: 'completing', completingAt: new Date() })
                .where(eq(driveUploads.id, uploadId));
        }
        // Fail early on a version race; the authoritative check runs again under the lock.
        const [node] = await tx
            .select({
                currentVersionId: driveNodes.currentVersionId,
                keyEpoch: driveNodes.keyEpoch,
            })
            .from(driveNodes)
            .where(eq(driveNodes.id, upload.nodeId));
        const stale =
            !node ||
            node.keyEpoch !== upload.keyEpoch ||
            (!upload.newNode && node.currentVersionId !== upload.expectedVersionId);
        return { status: 'ok' as const, upload: upload as UploadRow, stale };
    });
}

/*
 * Releases what an upload holds: bytes back from reserved, the pending version
 * purged, the object retired through the outbox (a delete at the store for a key
 * that never existed is harmless, and the rule that every key is named by an
 * object row or an outbox row stays whole), and a never-published node removed
 * without a tombstone.
 */
async function releaseUpload(tx: Tx, upload: UploadRow, status: 'aborted' | 'completed') {
    await adjustStorage(tx, upload.workspaceId, 0n, -upload.reservedBytes);
    await tx
        .update(fileVersions)
        .set({
            status: 'purged',
            contentKeyEnvelope: null,
            signerId: null,
            signature: null,
            ...PURGED_VERSION_ORIGIN,
            purgedAt: new Date(),
        })
        .where(eq(fileVersions.id, upload.versionId));
    await tx
        .update(driveUploads)
        .set({ status, reservedBytes: 0n })
        .where(eq(driveUploads.id, upload.id));
    if (upload.objectId) await retireObjectIfUnreferenced(tx, upload.objectId);
    if (upload.newNode) {
        await tx.delete(fileVersions).where(eq(fileVersions.nodeId, upload.nodeId));
        await tx.delete(driveNodes).where(eq(driveNodes.id, upload.nodeId));
    }
}

/*
 * The source a move upload names, read before its completion's transaction so
 * that both workspaces can be locked in order. Written once at begin and never
 * changed, so a read outside the transaction is the one inside it.
 */
async function moveOfUpload(workspaceId: string, uploadId: string): Promise<MoveRecord | null> {
    const [row] = await db
        .select({
            workspaceId: driveUploads.moveWorkspaceId,
            nodeId: driveUploads.moveNodeId,
            versionId: driveUploads.moveVersionId,
            changeSeq: driveUploads.moveChangeSeq,
            freedBytes: driveUploads.moveFreedBytes,
            by: driveUploads.moveBy,
        })
        .from(driveUploads)
        .where(and(eq(driveUploads.id, uploadId), eq(driveUploads.workspaceId, workspaceId)));
    if (!row?.workspaceId || !row.nodeId || !row.versionId || row.changeSeq === null) return null;
    if (row.freedBytes === null || !row.by) return null;
    return row as MoveRecord;
}

/*
 * The workspace locks a completion or attach takes: the destination's, and for a
 * move the source's too, in id order (as lockAreas takes a family's folders), so
 * two moves in opposite directions queue instead of deadlocking. Returns each
 * one's next change sequence; the source's is null when its workspace is gone
 * (an account deleted, a family folder purged), which makes the move stale.
 */
async function lockForCompletion(
    tx: Tx,
    workspaceId: string,
    writer: string | undefined,
    move: MoveRecord | null,
) {
    if (!move) return { changeSeq: await nextChangeSeq(tx, workspaceId, writer), sourceSeq: null };
    let changeSeq = 0;
    let sourceSeq: number | null = null;
    const ids = [workspaceId, move.workspaceId].sort((a, b) =>
        a.toLowerCase() < b.toLowerCase() ? -1 : 1,
    );
    for (const id of ids) {
        if (id === workspaceId) {
            changeSeq = await nextChangeSeq(tx, workspaceId, writer);
            continue;
        }
        const [row] = await tx
            .update(workspaces)
            .set({ changeSeq: sql`${workspaces.changeSeq} + 1` })
            .where(eq(workspaces.id, id))
            .returning({ changeSeq: workspaces.changeSeq });
        sourceSeq = row?.changeSeq ?? null;
    }
    return { changeSeq, sourceSeq };
}

/*
 * Whether a move may still finish, under both workspaces' locks and the pool's
 * (docs/families-shared-pool.md 3.8): the source's workspace is there, its mover
 * may still delete in it, both sides are still one pool (a member who left, or a
 * plan that ended, makes it two), and the file is as begin found it: not trashed
 * or deleted, nothing written to it (its change sequence: no rename, move, new or
 * restored version), and its versions free what begin counted (none discarded).
 * Anything else is stale: the copy is released and the source left as it is.
 */
async function moveStillHolds(
    tx: Tx,
    workspaceId: string,
    move: MoveRecord,
    sourceSeq: number | null,
) {
    if (sourceSeq === null) return false;
    const [space] = await tx
        .select({ deletedAt: workspaces.deletedAt })
        .from(workspaces)
        .where(eq(workspaces.id, move.workspaceId));
    if (!space || space.deletedAt) return false;
    if (!(await mayStillRemove(tx, move.by, move.workspaceId))) return false;
    const destination = await freeBytes(tx, workspaceId);
    if (!destination || !(await samePool(tx, destination, move.workspaceId))) return false;
    const chain = await walk(tx, move.nodeId);
    if (
        !chain ||
        chain.node.workspace_id !== move.workspaceId ||
        chain.purged ||
        chain.trashed ||
        chain.node.kind !== 'file'
    )
        return false;
    const [node] = await tx
        .select({ currentVersionId: driveNodes.currentVersionId, changeSeq: driveNodes.changeSeq })
        .from(driveNodes)
        .where(eq(driveNodes.id, move.nodeId));
    if (!node || node.currentVersionId !== move.versionId || node.changeSeq !== move.changeSeq)
        return false;
    return (await bytesFreedBy(tx, move.nodeId)) === move.freedBytes;
}

/*
 * Step three of complete, under the workspace lock. `storedSize` is what the
 * store reports after the multipart upload finished; anything but the reserved
 * size aborts. A precondition that moved leaves the upload `conflicted` with
 * its bytes still reserved and its object in the store, for attach or abort.
 *
 * A move (docs/families-shared-pool.md 3.8) also removes its source here, in the
 * same transaction as the copy's publish: deleted outright, never to the Trash,
 * so no commit leaves both counted or neither there. A source that changed is
 * `stale`: the copy is released, the source untouched.
 */
export async function finishCompleting(
    workspaceId: string,
    uploadId: string,
    storedSize: bigint | null,
    writer?: string,
) {
    const move = await moveOfUpload(workspaceId, uploadId);
    return settlingPool(() =>
        finishCompletingOnce(workspaceId, uploadId, storedSize, move, writer),
    );
}

async function finishCompletingOnce(
    workspaceId: string,
    uploadId: string,
    storedSize: bigint | null,
    move: MoveRecord | null,
    writer?: string,
) {
    return db.transaction(async (tx) => {
        const { changeSeq, sourceSeq } = await lockForCompletion(tx, workspaceId, writer, move);
        const [upload] = await tx
            .select(uploadColumns)
            .from(driveUploads)
            .leftJoin(driveObjects, eq(driveObjects.id, driveUploads.objectId))
            .where(and(eq(driveUploads.id, uploadId), eq(driveUploads.workspaceId, workspaceId)))
            .for('update', { of: driveUploads });
        if (!upload) return { status: 'not-found' as const };
        if (upload.status === 'completed') return { status: 'completed' as const, upload };
        if (upload.status !== 'completing' && upload.status !== 'conflicted')
            return { status: 'not-completing' as const, uploadStatus: upload.status };
        const row = upload as UploadRow;
        // A deleted family folder takes nothing more (the expiry job reaches this without any
        // route's check): the upload is released, its object retired, as for a purged node.
        const [space] = await tx
            .select({ deletedAt: workspaces.deletedAt })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId));
        if (space?.deletedAt) {
            await releaseUpload(tx, row, 'aborted');
            return { status: 'purged' as const };
        }
        if (
            storedSize === null ||
            row.ciphertextSize === null ||
            storedSize !== row.ciphertextSize
        ) {
            await releaseUpload(tx, row, 'aborted');
            return { status: 'size-mismatch' as const, storedSize };
        }
        const chain = await walk(tx, row.nodeId);
        if (!chain || chain.purged) {
            await releaseUpload(tx, row, 'aborted');
            return { status: 'purged' as const };
        }
        if (move && !(await moveStillHolds(tx, workspaceId, move, sourceSeq))) {
            await releaseUpload(tx, row, 'aborted');
            return { status: 'move-stale' as const };
        }
        let conflicted = chain.node.key_epoch !== row.keyEpoch;
        const [node] = await tx
            .select({
                currentVersionId: driveNodes.currentVersionId,
                parentId: driveNodes.parentId,
                parentKeyEpoch: driveNodes.parentKeyEpoch,
            })
            .from(driveNodes)
            .where(eq(driveNodes.id, row.nodeId));
        if (!node) return { status: 'not-found' as const };
        if (row.newNode) {
            const parent = chain.ancestors.at(-1);
            if (!parent || parent.keyEpoch !== node.parentKeyEpoch) conflicted = true;
        } else if (node.currentVersionId !== row.expectedVersionId) conflicted = true;
        if (conflicted) {
            await tx
                .update(driveUploads)
                .set({ status: 'conflicted' })
                .where(eq(driveUploads.id, uploadId));
            return { status: 'conflicted' as const, currentVersionId: node.currentVersionId };
        }

        const published = await publishUpload(
            tx,
            row,
            chain.ancestors,
            node.currentVersionId,
            changeSeq,
        );
        if (move) await purgeOne(tx, move.workspaceId, move.nodeId, sourceSeq!);
        return published;
    });
}

/*
 * The publish step shared by complete and attach, under the workspace lock the
 * caller took: bytes move from reserved to used, the version becomes current, the
 * displaced version is superseded, and the one it had superseded is purged.
 */
async function publishUpload(
    tx: Tx,
    row: UploadRow,
    ancestors: Ancestor[],
    displacedId: string | null,
    changeSeq: number,
) {
    const now = new Date();
    await adjustStorage(tx, row.workspaceId, row.ciphertextSize!, -row.reservedBytes);
    await tx
        .update(driveObjects)
        .set({ status: 'ready', readyAt: now })
        .where(eq(driveObjects.id, row.objectId!));
    await tx
        .update(fileVersions)
        .set({ status: 'ready', readyAt: now })
        .where(eq(fileVersions.id, row.versionId));
    if (displacedId) {
        const older = await tx
            .select({
                id: fileVersions.id,
                objectId: fileVersions.objectId,
                size: driveObjects.ciphertextSize,
            })
            .from(fileVersions)
            .innerJoin(driveObjects, eq(driveObjects.id, fileVersions.objectId))
            .where(
                and(
                    eq(fileVersions.nodeId, row.nodeId),
                    eq(fileVersions.status, 'ready'),
                    ne(fileVersions.id, displacedId),
                    ne(fileVersions.id, row.versionId),
                ),
            );
        for (const version of older) {
            await tx
                .update(fileVersions)
                .set({
                    status: 'purged',
                    contentKeyEnvelope: null,
                    signerId: null,
                    signature: null,
                    ...PURGED_VERSION_ORIGIN,
                    purgedAt: now,
                })
                .where(eq(fileVersions.id, version.id));
            await adjustStorage(tx, row.workspaceId, -version.size, 0n);
            if (version.objectId) await retireObjectIfUnreferenced(tx, version.objectId);
        }
        await tx
            .update(fileVersions)
            .set({ supersededAt: now })
            .where(eq(fileVersions.id, displacedId));
    }
    await tx
        .update(driveNodes)
        .set({ currentVersionId: row.versionId, changeSeq, updatedAt: now })
        .where(eq(driveNodes.id, row.nodeId));
    if (row.newNode) await raiseHeightBounds(tx, ancestors, 0);
    await tx
        .update(driveUploads)
        .set({ status: 'completed', reservedBytes: 0n })
        .where(eq(driveUploads.id, row.id));
    const [withVersion] = await selectNodes(tx, [row.nodeId]);
    return {
        status: 'published' as const,
        node: withVersion!,
        displacedVersionId: displacedId,
    };
}

/* Either way a fresh content-key envelope, so a fresh signature by the account attaching. */
export type AttachInput = {
    userId: string;
    contentKeyEnvelope: Buffer;
    versionSignature: Buffer;
} & (
    | { mode: 'same-node'; keyEpoch: number }
    | {
          mode: 'sibling';
          node: {
              id: string;
              parentId: string;
              keyEpoch: number;
              parentKeyEpoch: number;
              keyEnvelope: Buffer;
              metadataEnvelope: Buffer;
              metadataSignature: Buffer;
          };
      }
);

/*
 * Attach: a `conflicted` upload's finished object is published under fresh keys
 * without a second upload, because the content's associated data names the
 * object and not the node. Same node for an epoch race, which still requires
 * the version precondition begin recorded; a new sibling for a version race,
 * which overwrites nothing. Every envelope's epoch is checked against the tree as
 * it is now, never against what begin saw.
 */
export async function attachUpload(
    workspaceId: string,
    uploadId: string,
    input: AttachInput,
    writer?: string,
) {
    const move = await moveOfUpload(workspaceId, uploadId);
    return settlingPool(() => attachUploadOnce(workspaceId, uploadId, input, move, writer));
}

async function attachUploadOnce(
    workspaceId: string,
    uploadId: string,
    input: AttachInput,
    move: MoveRecord | null,
    writer?: string,
) {
    return db.transaction(async (tx) => {
        const { changeSeq, sourceSeq } = await lockForCompletion(tx, workspaceId, writer, move);
        // A move's source goes with the copy's publish, in this transaction (finishCompleting).
        const settled = async <T>(published: T) => {
            if (move) await purgeOne(tx, move.workspaceId, move.nodeId, sourceSeq!);
            return published;
        };
        const [upload] = await tx
            .select(uploadColumns)
            .from(driveUploads)
            .leftJoin(driveObjects, eq(driveObjects.id, driveUploads.objectId))
            .where(and(eq(driveUploads.id, uploadId), eq(driveUploads.workspaceId, workspaceId)))
            .for('update', { of: driveUploads });
        if (!upload) return { status: 'not-found' as const };
        if (upload.status === 'completed') return { status: 'completed' as const, upload };
        if (upload.status !== 'conflicted')
            return { status: 'not-conflicted' as const, uploadStatus: upload.status };
        const row = upload as UploadRow;
        if (row.objectId === null || row.ciphertextSize === null)
            return { status: 'not-conflicted' as const, uploadStatus: row.status };
        const [object] = await tx
            .select({ contentSuite: driveObjects.contentSuite })
            .from(driveObjects)
            .where(eq(driveObjects.id, row.objectId));
        if (!object) return { status: 'not-conflicted' as const, uploadStatus: row.status };
        if (move && !(await moveStillHolds(tx, workspaceId, move, sourceSeq))) {
            await releaseUpload(tx, row, 'aborted');
            return { status: 'move-stale' as const };
        }
        const nodeId = input.mode === 'same-node' ? row.nodeId : input.node.id;
        const statements = [
            versionSigned({
                workspaceId,
                nodeId,
                versionId: row.versionId,
                objectId: row.objectId,
                contentSuite: object.contentSuite,
                contentKeyEnvelope: input.contentKeyEnvelope,
                signature: input.versionSignature,
            }),
        ];
        if (input.mode === 'sibling')
            statements.push(metadataSigned(workspaceId, nodeId, 'file', 1, input.node));
        if (!(await signedBy(tx, input.userId, statements)))
            return { status: 'bad-signature' as const };
        const signed = {
            signerId: input.userId,
            signature: input.versionSignature,
            ...NO_VERSION_ORIGIN,
        };

        if (input.mode === 'same-node') {
            const chain = await walk(tx, row.nodeId);
            if (!chain || chain.purged) {
                await releaseUpload(tx, row, 'aborted');
                return { status: 'purged' as const };
            }
            if (await underUnrotatedParent(tx, workspaceId, chain))
                return { status: 'rotating' as const };
            if (chain.node.key_epoch !== input.keyEpoch) return { status: 'stale' as const };
            const [node] = await tx
                .select({ currentVersionId: driveNodes.currentVersionId })
                .from(driveNodes)
                .where(eq(driveNodes.id, row.nodeId));
            if (!node) return { status: 'not-found' as const };
            if (row.newNode || node.currentVersionId !== row.expectedVersionId)
                return { status: 'conflicted' as const, currentVersionId: node.currentVersionId };
            await tx
                .update(fileVersions)
                .set({ contentKeyEnvelope: input.contentKeyEnvelope, ...signed })
                .where(eq(fileVersions.id, row.versionId));
            await tx
                .update(driveUploads)
                .set({ keyEpoch: input.keyEpoch })
                .where(eq(driveUploads.id, uploadId));
            return settled(
                await publishUpload(
                    tx,
                    { ...row, keyEpoch: input.keyEpoch },
                    chain.ancestors,
                    node.currentVersionId,
                    changeSeq,
                ),
            );
        }

        const parent = await walk(tx, input.node.parentId);
        if (
            !parent ||
            parent.node.workspace_id !== workspaceId ||
            parent.purged ||
            parent.node.kind !== 'folder'
        )
            return { status: 'not-found' as const };
        if (parent.trashed) return { status: 'parent-trashed' as const };
        if (await underUnrotatedParent(tx, workspaceId, parent))
            return { status: 'rotating' as const };
        if (parent.depth + 1 > MAX_DEPTH) return { status: 'too-deep' as const };
        if (input.node.parentKeyEpoch !== parent.node.key_epoch)
            return { status: 'stale' as const };
        if (!(await epochWasAllocated(tx, workspaceId, input.node.keyEpoch)))
            return { status: 'stale' as const };
        const [created] = await tx
            .insert(driveNodes)
            .values({
                id: input.node.id,
                workspaceId,
                parentId: input.node.parentId,
                kind: 'file',
                keyEpoch: input.node.keyEpoch,
                parentKeyEpoch: input.node.parentKeyEpoch,
                keyEnvelope: input.node.keyEnvelope,
                metadataEnvelope: input.node.metadataEnvelope,
                metadataSignerId: input.userId,
                metadataSignature: input.node.metadataSignature,
                createdBy: input.userId,
                changeSeq: null,
            })
            .onConflictDoNothing()
            .returning({ id: driveNodes.id });
        if (!created) return { status: 'conflict' as const };
        // The version moves to the new node with its fresh envelope; a node begin
        // created for this upload, which nobody has seen, goes with the old plan.
        await tx
            .update(fileVersions)
            .set({ nodeId: input.node.id, contentKeyEnvelope: input.contentKeyEnvelope, ...signed })
            .where(eq(fileVersions.id, row.versionId));
        await tx
            .update(driveUploads)
            .set({
                nodeId: input.node.id,
                keyEpoch: input.node.keyEpoch,
                expectedVersionId: null,
                newNode: true,
            })
            .where(eq(driveUploads.id, uploadId));
        if (row.newNode) {
            await tx.delete(fileVersions).where(eq(fileVersions.nodeId, row.nodeId));
            await tx.delete(driveNodes).where(eq(driveNodes.id, row.nodeId));
        }
        const ancestors: Ancestor[] = [
            ...parent.ancestors,
            {
                id: parent.node.id,
                parentId: parent.node.parent_id,
                keyEpoch: parent.node.key_epoch,
            },
        ];
        return settled(
            await publishUpload(
                tx,
                {
                    ...row,
                    nodeId: input.node.id,
                    keyEpoch: input.node.keyEpoch,
                    expectedVersionId: null,
                    newNode: true,
                },
                ancestors,
                null,
                changeSeq,
            ),
        );
    });
}

/* Abort, from the client or from expiry. Refuses an upload that is completing. */
export async function abortUpload(
    workspaceId: string,
    uploadId: string,
    options: { force?: boolean } = {},
) {
    return db.transaction(async (tx) => {
        await nextChangeSeq(tx, workspaceId);
        const [upload] = await tx
            .select(uploadColumns)
            .from(driveUploads)
            .leftJoin(driveObjects, eq(driveObjects.id, driveUploads.objectId))
            .where(and(eq(driveUploads.id, uploadId), eq(driveUploads.workspaceId, workspaceId)))
            .for('update', { of: driveUploads });
        if (!upload) return { status: 'not-found' as const };
        const row = upload as UploadRow;
        // Only the expiry sweep, which has asked the store what happened, may abort
        // an upload that is completing.
        if (row.status === 'completing' && !options.force) return { status: 'completing' as const };
        if (row.status === 'completed') return { status: 'completed' as const };
        if (row.status === 'aborted')
            return { status: 'ok' as const, upload: row, alreadyAborted: true };
        await releaseUpload(tx, row, 'aborted');
        return { status: 'ok' as const, upload: row, alreadyAborted: false };
    });
}

/* Uploads past their expiry, for the worker's sweep. Completing ones older than an hour too. */
export async function listExpiredUploads(limit = 100) {
    const rows = await db
        .select(uploadColumns)
        .from(driveUploads)
        .leftJoin(driveObjects, eq(driveObjects.id, driveUploads.objectId))
        .where(
            sql`(${driveUploads.status} in ('open', 'conflicted') and ${driveUploads.expiresAt} <= now()) or (${driveUploads.status} = 'completing' and ${driveUploads.completingAt} <= now() - interval '1 hour')`,
        )
        .orderBy(asc(driveUploads.expiresAt))
        .limit(limit);
    return rows as UploadRow[];
}

/*
 * Storage figures for a workspace, exact, read once without locks: the path
 * the account's figures take (getStorageAllowance), not the one a reservation
 * takes (freeBytes).
 */
export async function getStorage(workspaceId: string) {
    return storageFigures(db, workspaceId, { lock: false });
}

/* ------------------------------------------------------------------------- */
/* Downloads                                                                  */
/* ------------------------------------------------------------------------- */

/*
 * A version a member may read: the walk grants access and refuses a purged
 * chain, and only a version whose object the store has confirmed is offered.
 * Trash does not block reads; being over quota never does.
 */
export async function getVersionForDownload(workspaceId: string, versionId: string) {
    return db.transaction(async (tx) => {
        const [row] = await tx
            .select({ version: versionColumns, nodeId: fileVersions.nodeId })
            .from(fileVersions)
            .innerJoin(driveObjects, eq(driveObjects.id, fileVersions.objectId))
            .where(and(eq(fileVersions.id, versionId), eq(fileVersions.workspaceId, workspaceId)));
        if (!row) return { status: 'not-found' as const };
        const chain = await walk(tx, row.nodeId);
        if (!chain || chain.purged) return { status: 'not-found' as const };
        const version = withVersionSigner(row.version as RawVersionRow);
        if (version.status !== 'ready' || version.objectStatus !== 'ready')
            return { status: 'not-ready' as const, objectStatus: version.objectStatus };
        const [node] = await selectNodes(tx, [row.nodeId]);
        return {
            status: 'ok' as const,
            version,
            node: node!,
            objectKey: objectKeyFor(workspaceId, version.objectId),
        };
    });
}

/* The same check for many versions at once; a version that fails it is simply absent. */
export async function getVersionsForDownload(workspaceId: string, versionIds: string[]) {
    if (!versionIds.length) return [];
    return db.transaction(async (tx) => {
        const rows = await tx
            .select({ version: versionColumns, nodeId: fileVersions.nodeId })
            .from(fileVersions)
            .innerJoin(driveObjects, eq(driveObjects.id, fileVersions.objectId))
            .where(
                and(
                    inArray(fileVersions.id, versionIds),
                    eq(fileVersions.workspaceId, workspaceId),
                ),
            );
        const out: { version: RawVersionRow; objectKey: string }[] = [];
        for (const row of rows) {
            const version = row.version as RawVersionRow;
            if (version.status !== 'ready' || version.objectStatus !== 'ready') continue;
            const chain = await walk(tx, row.nodeId);
            if (!chain || chain.purged) continue;
            out.push({ version, objectKey: objectKeyFor(workspaceId, version.objectId) });
        }
        return out;
    });
}

function objectKeyFor(workspaceId: string, objectId: string) {
    return `ws/${workspaceId}/${objectId}`;
}

/* Marks an object read, at most once an hour, so tiering can tell cold objects from warm. */
export async function touchObjectRead(objectId: string) {
    await db
        .update(driveObjects)
        .set({ lastReadAt: new Date() })
        .where(
            and(
                eq(driveObjects.id, objectId),
                sql`(${driveObjects.lastReadAt} is null or ${driveObjects.lastReadAt} < now() - interval '1 hour')`,
            ),
        );
}

/* ------------------------------------------------------------------------- */
/* Copy and versions                                                          */
/* ------------------------------------------------------------------------- */

export type CopyFile = {
    workspaceId: string;
    userId: string;
    sourceNodeId: string;
    /* The version the client rewrapped; anything else means the file moved on. */
    sourceVersionId: string;
    node: { id: string; parentId: string; envelopes: NodeEnvelopes };
    version: { id: string; contentKeyEnvelope: Buffer; signature: Buffer };
};

/*
 * Copy within a workspace moves no bytes: a new file node with a fresh key,
 * whose first version points at the same object as the source's current
 * version, under a version envelope the client resealed in the object's own
 * suite (the object is shared, so the envelope's format must follow it). The
 * allowance is checked exactly as upload begin does, and the copy pays for the
 * object like any other version, so purging either copy gives its bytes back
 * and the object retires when the last reference goes.
 */
export async function copyFile(input: CopyFile) {
    return settlingPool(() => copyFileOnce(input));
}

async function copyFileOnce(input: CopyFile) {
    return transactionKeeping(['ok'], async (tx) => {
        const changeSeq = await nextChangeSeq(tx, input.workspaceId, input.userId);
        const source = await walk(tx, input.sourceNodeId);
        if (
            !source ||
            source.node.workspace_id !== input.workspaceId ||
            source.purged ||
            source.node.kind !== 'file'
        )
            return { status: 'not-found' as const };
        if (source.trashed) return { status: 'trashed' as const };
        const [current] = await tx
            .select({ version: versionColumns })
            .from(driveNodes)
            .innerJoin(fileVersions, eq(fileVersions.id, driveNodes.currentVersionId))
            .innerJoin(driveObjects, eq(driveObjects.id, fileVersions.objectId))
            .where(eq(driveNodes.id, input.sourceNodeId));
        const version = current?.version as VersionRow | undefined;
        if (!version || version.id !== input.sourceVersionId || version.status !== 'ready')
            return { status: 'stale' as const };
        if (version.objectStatus !== 'ready')
            return { status: 'unavailable' as const, objectStatus: version.objectStatus };
        const parent = await walk(tx, input.node.parentId);
        if (
            !parent ||
            parent.node.workspace_id !== input.workspaceId ||
            parent.purged ||
            parent.node.kind !== 'folder'
        )
            return { status: 'not-found' as const };
        if (parent.trashed) return { status: 'parent-trashed' as const };
        if (await underUnrotatedParent(tx, input.workspaceId, parent))
            return { status: 'rotating' as const };
        if (parent.depth + 1 > MAX_DEPTH) return { status: 'too-deep' as const };
        if (input.node.envelopes.parentKeyEpoch !== parent.node.key_epoch)
            return { status: 'stale' as const };
        if (!(await epochWasAllocated(tx, input.workspaceId, input.node.envelopes.keyEpoch)))
            return { status: 'stale' as const };
        if (input.version.contentKeyEnvelope.length !== envelopeLengthFor(version.contentSuite))
            return { status: 'invalid' as const };
        if (
            !(await signedBy(tx, input.userId, [
                metadataSigned(input.workspaceId, input.node.id, 'file', 1, input.node.envelopes),
                versionSigned({
                    workspaceId: input.workspaceId,
                    nodeId: input.node.id,
                    versionId: input.version.id,
                    objectId: version.objectId,
                    contentSuite: version.contentSuite,
                    contentKeyEnvelope: input.version.contentKeyEnvelope,
                    signature: input.version.signature,
                }),
            ]))
        )
            return { status: 'bad-signature' as const };
        const cost = version.ciphertextSize;
        const storage = await freeBytes(tx, input.workspaceId);
        if (!storage) return { status: 'not-found' as const };
        if (spendable(storage) < cost)
            return { status: 'over-quota' as const, free: named(spendable(storage)) };
        const now = new Date();
        const [node] = await tx
            .insert(driveNodes)
            .values({
                id: input.node.id,
                workspaceId: input.workspaceId,
                parentId: input.node.parentId,
                kind: 'file',
                ...input.node.envelopes,
                metadataSignerId: input.userId,
                createdBy: input.userId,
                changeSeq,
            })
            .onConflictDoNothing()
            .returning({ id: driveNodes.id });
        if (!node) return { status: 'conflict' as const };
        const [inserted] = await tx
            .insert(fileVersions)
            .values({
                id: input.version.id,
                nodeId: input.node.id,
                workspaceId: input.workspaceId,
                objectId: version.objectId,
                contentKeyEnvelope: input.version.contentKeyEnvelope,
                signerId: input.userId,
                signature: input.version.signature,
                status: 'ready',
                readyAt: now,
            })
            .onConflictDoNothing()
            .returning({ id: fileVersions.id });
        if (!inserted) return { status: 'conflict' as const };
        await adjustStorage(tx, input.workspaceId, cost, 0n);
        await tx
            .update(driveNodes)
            .set({ currentVersionId: input.version.id, updatedAt: now })
            .where(eq(driveNodes.id, input.node.id));
        await raiseHeightBounds(
            tx,
            [
                ...parent.ancestors,
                {
                    id: parent.node.id,
                    parentId: parent.node.parent_id,
                    keyEpoch: parent.node.key_epoch,
                },
            ],
            0,
        );
        const [row] = await selectNodes(tx, [input.node.id]);
        return { status: 'ok' as const, node: row!, changeSeq };
    });
}

export type VersionListRow = VersionRow & { supersededAt: Date | null; createdAt: Date };

/* A file's current version and the one it displaced, newest first; purged ones are gone. */
export async function listVersions(workspaceId: string, nodeId: string) {
    return db.transaction(async (tx) => {
        const chain = await walk(tx, nodeId);
        if (
            !chain ||
            chain.node.workspace_id !== workspaceId ||
            chain.purged ||
            chain.node.kind !== 'file'
        )
            return null;
        const [node] = await tx
            .select({ currentVersionId: driveNodes.currentVersionId })
            .from(driveNodes)
            .where(eq(driveNodes.id, nodeId));
        const rows = await tx
            .select({
                version: versionColumns,
                supersededAt: fileVersions.supersededAt,
                createdAt: fileVersions.createdAt,
            })
            .from(fileVersions)
            .innerJoin(driveObjects, eq(driveObjects.id, fileVersions.objectId))
            .where(and(eq(fileVersions.nodeId, nodeId), eq(fileVersions.status, 'ready')))
            .orderBy(desc(fileVersions.readyAt));
        return {
            currentVersionId: node?.currentVersionId ?? null,
            versions: rows.map((row) => ({
                ...withVersionSigner(row.version as RawVersionRow),
                supersededAt: row.supersededAt,
                createdAt: row.createdAt,
            })),
        };
    });
}

/*
 * Restoring an earlier version is one swap under the workspace lock: the
 * superseded version becomes current and the displaced one takes its place as
 * the earlier version, so nothing is purged and no bytes move. Refused for a
 * version that is not the file's superseded one, and for a file in the trash.
 */
export async function restoreVersion(workspaceId: string, versionId: string, writer?: string) {
    return db.transaction(async (tx) => {
        const changeSeq = await nextChangeSeq(tx, workspaceId, writer);
        const [row] = await tx
            .select({
                nodeId: fileVersions.nodeId,
                status: fileVersions.status,
                supersededAt: fileVersions.supersededAt,
                objectStatus: driveObjects.status,
            })
            .from(fileVersions)
            .innerJoin(driveObjects, eq(driveObjects.id, fileVersions.objectId))
            .where(and(eq(fileVersions.id, versionId), eq(fileVersions.workspaceId, workspaceId)));
        if (!row || row.status !== 'ready') return { status: 'not-found' as const };
        const chain = await walk(tx, row.nodeId);
        if (!chain || chain.purged) return { status: 'not-found' as const };
        if (chain.trashed) return { status: 'trashed' as const };
        const [node] = await tx
            .select({ currentVersionId: driveNodes.currentVersionId })
            .from(driveNodes)
            .where(eq(driveNodes.id, row.nodeId))
            .for('update');
        if (!node?.currentVersionId || node.currentVersionId === versionId || !row.supersededAt)
            return { status: 'not-superseded' as const };
        if (row.objectStatus !== 'ready')
            return { status: 'unavailable' as const, objectStatus: row.objectStatus };
        const now = new Date();
        await tx
            .update(fileVersions)
            .set({ supersededAt: now })
            .where(eq(fileVersions.id, node.currentVersionId));
        await tx
            .update(fileVersions)
            .set({ supersededAt: null })
            .where(eq(fileVersions.id, versionId));
        await tx
            .update(driveNodes)
            .set({ currentVersionId: versionId, changeSeq, updatedAt: now })
            .where(eq(driveNodes.id, row.nodeId));
        const [restored] = await selectNodes(tx, [row.nodeId]);
        return {
            status: 'ok' as const,
            node: restored!,
            displacedVersionId: node.currentVersionId,
        };
    });
}

/* Discards a file's earlier version now, giving its bytes back; the current version is never touched. */
export async function discardVersion(workspaceId: string, versionId: string, writer?: string) {
    return db.transaction(async (tx) => {
        await nextChangeSeq(tx, workspaceId, writer);
        const [version] = (await tx
            .select({
                id: fileVersions.id,
                status: fileVersions.status,
                objectId: fileVersions.objectId,
                size: driveObjects.ciphertextSize,
                nodeId: fileVersions.nodeId,
                supersededAt: fileVersions.supersededAt,
            })
            .from(fileVersions)
            .leftJoin(driveObjects, eq(driveObjects.id, fileVersions.objectId))
            .where(and(eq(fileVersions.id, versionId), eq(fileVersions.workspaceId, workspaceId)))
            .for('update', { of: fileVersions })) as (PurgedVersion & {
            nodeId: string;
            supersededAt: Date | null;
        })[];
        if (!version || version.status !== 'ready') return { status: 'not-found' as const };
        const chain = await walk(tx, version.nodeId);
        if (!chain || chain.purged) return { status: 'not-found' as const };
        const [node] = await tx
            .select({ currentVersionId: driveNodes.currentVersionId })
            .from(driveNodes)
            .where(eq(driveNodes.id, version.nodeId))
            .for('update');
        if (node?.currentVersionId === versionId || !version.supersededAt)
            return { status: 'current' as const };
        await purgeVersion(tx, workspaceId, version);
        return { status: 'ok' as const };
    });
}

/* ------------------------------------------------------------------------- */
/* Purge, the outbox, and the worker                                          */
/* ------------------------------------------------------------------------- */

type PurgedVersion = {
    id: string;
    status: 'pending' | 'ready' | 'purged';
    objectId: string | null;
    size: bigint | null;
};

/*
 * Purges one version: a ready one gives its bytes back from `used`, a pending
 * one is the upload's to release, and both send their objects to the outbox
 * once nothing else references them.
 */
async function purgeVersion(tx: Tx, workspaceId: string, version: PurgedVersion) {
    if (version.status === 'purged') return;
    if (version.status === 'pending') {
        const [upload] = await tx
            .select(uploadColumns)
            .from(driveUploads)
            .leftJoin(driveObjects, eq(driveObjects.id, driveUploads.objectId))
            .where(eq(driveUploads.versionId, version.id))
            .for('update', { of: driveUploads });
        const row = upload as UploadRow | undefined;
        // A completing upload takes the same lock later, finds the node purged and
        // aborts itself; touching it here would race the store.
        if (row && row.status === 'completing') return;
        if (row && (row.status === 'open' || row.status === 'conflicted')) {
            await releaseUpload(tx, { ...row, newNode: false }, 'aborted');
            return;
        }
    }
    await tx
        .update(fileVersions)
        .set({
            status: 'purged',
            contentKeyEnvelope: null,
            signerId: null,
            signature: null,
            ...PURGED_VERSION_ORIGIN,
            purgedAt: new Date(),
        })
        .where(eq(fileVersions.id, version.id));
    if (version.status === 'ready' && version.size !== null)
        await adjustStorage(tx, workspaceId, -version.size, 0n);
    if (version.objectId) await retireObjectIfUnreferenced(tx, version.objectId);
}

/*
 * Purges one node under the workspace lock the caller took: every version goes,
 * the envelopes are cleared, every live share and link on the node is revoked
 * (nothing comes back from a purge), and the row stays as a tombstone with the
 * next change sequence. Descendants are left to the fan-out; until it reaches
 * them they are unreachable through this node.
 */
async function purgeOne(tx: Tx, workspaceId: string, nodeId: string, changeSeq: number) {
    const [node] = await tx
        .select({ id: driveNodes.id, purgedAt: driveNodes.purgedAt })
        .from(driveNodes)
        .where(and(eq(driveNodes.id, nodeId), eq(driveNodes.workspaceId, workspaceId)))
        .for('update');
    if (!node || node.purgedAt) return false;
    const versions = (await tx
        .select({
            id: fileVersions.id,
            status: fileVersions.status,
            objectId: fileVersions.objectId,
            size: driveObjects.ciphertextSize,
        })
        .from(fileVersions)
        .leftJoin(driveObjects, eq(driveObjects.id, fileVersions.objectId))
        .where(eq(fileVersions.nodeId, nodeId))) as PurgedVersion[];
    for (const version of versions) await purgeVersion(tx, workspaceId, version);
    // Where it was when it went, for the share feeds: tombstones keep their parent, so
    // the walk reaches the root through any ancestor purged before it.
    const chain = await walk(tx, nodeId);
    const now = new Date();
    await tx
        .update(driveNodes)
        .set({
            purgedAt: now,
            purgedAncestorIds: chain ? chain.ancestors.map((ancestor) => ancestor.id) : [],
            keyEnvelope: null,
            metadataEnvelope: null,
            metadataSignerId: null,
            metadataSignature: null,
            ...PURGED_METADATA_ORIGIN,
            changeSeq,
            updatedAt: now,
        })
        .where(eq(driveNodes.id, nodeId));
    await tx
        .update(driveShares)
        .set({ revokedAt: now, updatedAt: now })
        .where(and(eq(driveShares.nodeId, nodeId), isNull(driveShares.revokedAt)));
    await tx
        .update(driveLinks)
        .set({ revokedAt: now })
        .where(and(eq(driveLinks.nodeId, nodeId), isNull(driveLinks.revokedAt)));
    return true;
}

/*
 * Delete forever: a person's request for one trashed node, or the sweep's for a
 * trash root past retention. The node itself must carry `trashed_at`; anything
 * merely inside a trashed folder goes with that folder.
 */
export async function purgeNode(input: { workspaceId: string; nodeId: string; writer?: string }) {
    return db.transaction(async (tx) => {
        const changeSeq = await nextChangeSeq(tx, input.workspaceId, input.writer);
        const chain = await walk(tx, input.nodeId);
        if (!chain || chain.node.workspace_id !== input.workspaceId || chain.purged)
            return { status: 'not-found' as const };
        if (chain.node.parent_id === null) return { status: 'root' as const };
        if (chain.node.trashed_at === null) return { status: 'not-trashed' as const };
        await purgeOne(tx, input.workspaceId, input.nodeId, changeSeq);
        return { status: 'ok' as const };
    });
}

/*
 * The trash roots a person can still act on: rows with their own `trashed_at`
 * and no purged ancestor, oldest first. A trashed item inside a folder that was
 * since deleted forever is not one of them: the fan-out purges it, purgeNode
 * refuses it, and counting it would leave the trash "not empty" until then.
 */
async function liveTrashRoots(workspaceId: string, limit: number) {
    const result = await db.execute<{ root: string }>(sql`
        with recursive up as (
            select n.id as root, n.parent_id, n.trashed_at as root_trashed_at, false as gone
            from drive_nodes n
            where n.workspace_id = ${workspaceId}
              and n.trashed_at is not null and n.purged_at is null
            union all
            select u.root, p.parent_id, u.root_trashed_at, p.purged_at is not null
            from up u join drive_nodes p on p.id = u.parent_id
            where not u.gone
        )
        select root from up
        group by root, root_trashed_at
        having not bool_or(gone)
        order by root_trashed_at asc, root asc
        limit ${limit}
    `);
    return result.rows.map((row) => row.root);
}

/*
 * Empty trash, in bounded steps: up to `limit` trash roots are purged in their
 * own transactions, and the caller learns how many remain, so a trash holding
 * a hundred thousand roots is drained by repeated requests rather than one.
 */
export async function emptyTrash(workspaceId: string, limit = 100, writer?: string) {
    const roots = await liveTrashRoots(workspaceId, limit);
    let purged = 0;
    for (const root of roots) {
        const result = await purgeNode({ workspaceId, nodeId: root, writer });
        if (result.status === 'ok') purged++;
    }
    // Bounded like the batch itself: the caller only needs zero or not.
    const remaining = (await liveTrashRoots(workspaceId, limit + 1)).length;
    return { purged, remaining };
}

/*
 * The fan-out: nodes whose parent is purged but which are not themselves. One
 * level per call; the worker calls until nothing is returned. Each node is its
 * own short transaction, so a huge subtree never holds the workspace lock long.
 */
export async function purgeDescendants(limit = 1000) {
    const parent = sql`p`;
    const rows = await db.execute<{ id: string; workspace_id: string }>(sql`
        select n.id, n.workspace_id
        from drive_nodes n
        join drive_nodes ${parent} on p.id = n.parent_id
        where p.purged_at is not null and n.purged_at is null
        order by n.workspace_id
        limit ${limit}
    `);
    let purged = 0;
    for (const row of rows.rows) {
        const done = await db.transaction(async (tx) => {
            const changeSeq = await nextChangeSeq(tx, row.workspace_id);
            return purgeOne(tx, row.workspace_id, row.id, changeSeq);
        });
        if (done) purged++;
    }
    return purged;
}

/* Trash roots past retention, purged like a person's delete-forever would. */
export async function purgeExpiredTrash(retentionDays: number, limit = 100) {
    const rows = await db
        .select({ id: driveNodes.id, workspaceId: driveNodes.workspaceId })
        .from(driveNodes)
        .where(
            and(
                sql`${driveNodes.trashedAt} < now() - make_interval(days => ${retentionDays})`,
                isNull(driveNodes.purgedAt),
            ),
        )
        .orderBy(asc(driveNodes.trashedAt))
        .limit(limit);
    let purged = 0;
    for (const row of rows) {
        const result = await purgeNode({ workspaceId: row.workspaceId, nodeId: row.id });
        if (result.status === 'ok') purged++;
    }
    return purged;
}

/*
 * Superseded versions past retention. A current version is never touched,
 * whatever its timestamps say: the check is on the node's pointer, not the row.
 */
export async function purgeExpiredSupersededVersions(
    retentionDays: number,
    limit = 500,
    workspaceId?: string,
) {
    const rows = await db.execute<{ id: string; workspace_id: string }>(sql`
        select v.id, v.workspace_id
        from file_versions v
        join drive_nodes n on n.id = v.node_id
        where v.status = 'ready'
          and v.superseded_at is not null
          and v.superseded_at < now() - make_interval(days => ${retentionDays})
          and n.current_version_id is distinct from v.id
          ${workspaceId ? sql`and v.workspace_id = ${workspaceId}` : sql``}
        order by v.superseded_at
        limit ${limit}
    `);
    let purged = 0;
    for (const row of rows.rows) {
        await db.transaction(async (tx) => {
            await nextChangeSeq(tx, row.workspace_id);
            const [version] = (await tx
                .select({
                    id: fileVersions.id,
                    status: fileVersions.status,
                    objectId: fileVersions.objectId,
                    size: driveObjects.ciphertextSize,
                })
                .from(fileVersions)
                .leftJoin(driveObjects, eq(driveObjects.id, fileVersions.objectId))
                .where(eq(fileVersions.id, row.id))
                .for('update', { of: fileVersions })) as PurgedVersion[];
            const [node] = await tx
                .select({ current: driveNodes.currentVersionId })
                .from(driveNodes)
                .innerJoin(fileVersions, eq(fileVersions.nodeId, driveNodes.id))
                .where(eq(fileVersions.id, row.id));
            if (!version || version.status !== 'ready' || node?.current === version.id) return;
            await purgeVersion(tx, row.workspace_id, version);
            purged++;
        });
    }
    return purged;
}

/*
 * Tombstones past their window, leaves first: a row with children still present
 * is skipped, and the non-cascading parent key would refuse it anyway.
 */
export async function deleteExpiredTombstones(tombstoneDays: number, limit = 1000) {
    return db.transaction(async (tx) => {
        const result = await tx.execute<{
            id: string;
            workspace_id: string;
            change_seq: string | null;
        }>(sql`
            delete from drive_nodes
            where id in (
                select t.id from drive_nodes t
                where t.purged_at is not null
                  and t.purged_at < now() - make_interval(days => ${tombstoneDays})
                  and not exists (select 1 from drive_nodes c where c.parent_id = t.id)
                limit ${limit}
            )
            returning id, workspace_id, change_seq
        `);
        // Each workspace remembers the newest deletion it can no longer tell a client about.
        const highest = new Map<string, number>();
        for (const row of result.rows) {
            const seq = row.change_seq === null ? 0 : Number(row.change_seq);
            highest.set(row.workspace_id, Math.max(highest.get(row.workspace_id) ?? 0, seq));
        }
        for (const [workspaceId, seq] of highest)
            await tx
                .update(workspaces)
                .set({
                    tombstonesDroppedThrough: sql`greatest(${workspaces.tombstonesDroppedThrough}, ${seq})`,
                })
                .where(eq(workspaces.id, workspaceId));
        return result.rows.length;
    });
}

/*
 * What a person could free without losing anything current: bytes held by
 * everything in the trash (trashed roots and all beneath them) and by earlier
 * versions of files. Both count against quota until purged.
 */
export async function getStorageBreakdown(workspaceId: string) {
    const [row] = (
        await db.execute<{
            trash_bytes: string;
            trash_items: number;
            superseded_bytes: string;
            superseded_versions: number;
        }>(sql`
            with recursive trashed as (
                select id from drive_nodes
                where workspace_id = ${workspaceId} and trashed_at is not null and purged_at is null
                union
                select n.id from drive_nodes n join trashed t on n.parent_id = t.id
                where n.purged_at is null
            ),
            trash_versions as (
                select v.id, o.ciphertext_size as bytes
                from file_versions v
                join drive_objects o on o.id = v.object_id
                where v.node_id in (select id from trashed) and v.status = 'ready'
            ),
            superseded as (
                select v.id, o.ciphertext_size as bytes
                from file_versions v
                join drive_nodes n on n.id = v.node_id
                join drive_objects o on o.id = v.object_id
                where v.workspace_id = ${workspaceId}
                  and v.status = 'ready'
                  and v.superseded_at is not null
                  and n.current_version_id is distinct from v.id
                  and n.purged_at is null
                  and v.node_id not in (select id from trashed)
            )
            select
                (select coalesce(sum(bytes), 0) from trash_versions)::text as trash_bytes,
                (select count(*) from trashed)::int as trash_items,
                (select coalesce(sum(bytes), 0) from superseded)::text as superseded_bytes,
                (select count(*) from superseded)::int as superseded_versions
        `)
    ).rows;
    return {
        trashBytes: BigInt(row?.trash_bytes ?? '0'),
        trashItems: row?.trash_items ?? 0,
        supersededBytes: BigInt(row?.superseded_bytes ?? '0'),
        supersededVersions: row?.superseded_versions ?? 0,
    };
}

/* Outbox rows whose primary copy is still there, oldest first. */
export async function listPendingObjectDeletions(limit = 200) {
    return db
        .select()
        .from(driveObjectDeletions)
        .where(
            and(
                isNull(driveObjectDeletions.doneAt),
                isNull(driveObjectDeletions.primaryDeletedAt),
                // An open or held report names the object: it stays until the report lets go.
                heldObjectCondition(driveObjectDeletions.objectId),
            ),
        )
        .orderBy(asc(driveObjectDeletions.createdAt))
        .limit(limit);
}

/*
 * The primary copy is gone. With a replica copy to keep for the undo window the
 * row waits until `deleteReplicaAfter`; without one it is done.
 */
export async function markPrimaryDeleted(objectId: string, deleteReplicaAfter: Date | null) {
    const now = new Date();
    await db
        .update(driveObjectDeletions)
        .set({
            primaryDeletedAt: now,
            deleteReplicaAfter,
            doneAt: deleteReplicaAfter ? null : now,
        })
        .where(eq(driveObjectDeletions.objectId, objectId));
}

/* Replica copies whose undo window has passed. */
export async function listReplicaDeletionsDue(limit = 200) {
    return db
        .select()
        .from(driveObjectDeletions)
        .where(
            and(
                isNull(driveObjectDeletions.doneAt),
                sql`${driveObjectDeletions.primaryDeletedAt} is not null`,
                sql`${driveObjectDeletions.deleteReplicaAfter} <= now()`,
            ),
        )
        .orderBy(asc(driveObjectDeletions.deleteReplicaAfter))
        .limit(limit);
}

export async function markObjectDeletionDone(objectId: string) {
    await db
        .update(driveObjectDeletions)
        .set({ doneAt: new Date() })
        .where(eq(driveObjectDeletions.objectId, objectId));
}

/*
 * Objects the replica does not hold yet: live ready objects, and outbox rows for
 * published objects that were purged before replication caught up, whose only
 * copy must reach the replica before the primary may go.
 */
export async function listUnreplicatedObjects(limit = 100) {
    const live = await db
        .select({ objectId: driveObjects.id, objectKey: driveObjects.objectKey })
        .from(driveObjects)
        .where(and(eq(driveObjects.status, 'ready'), isNull(driveObjects.replicatedAt)))
        .orderBy(asc(driveObjects.createdAt))
        .limit(limit);
    const retired = await db
        .select({
            objectId: driveObjectDeletions.objectId,
            objectKey: driveObjectDeletions.objectKey,
        })
        .from(driveObjectDeletions)
        .where(
            and(
                eq(driveObjectDeletions.published, true),
                eq(driveObjectDeletions.replicated, false),
                isNull(driveObjectDeletions.primaryDeletedAt),
            ),
        )
        .orderBy(asc(driveObjectDeletions.createdAt))
        .limit(Math.max(0, limit - live.length));
    return [...live, ...retired];
}

/* The replica holds the object: recorded on the object row, or on its outbox row if purge got there first. */
export async function markObjectReplicated(objectId: string) {
    const now = new Date();
    await db.update(driveObjects).set({ replicatedAt: now }).where(eq(driveObjects.id, objectId));
    await db
        .update(driveObjectDeletions)
        .set({ replicated: true })
        .where(eq(driveObjectDeletions.objectId, objectId));
}

/*
 * The nightly accounting check: `used_bytes` against the sum of every ready
 * version's object, for a sample of workspaces. A pending version's bytes are
 * the upload's reservation, not usage, so they are left out. Drift is
 * reported, never corrected here; a bug is something to look at, not paper over.
 */
export async function auditUsage(sample = 50) {
    const rows = await db.execute<{
        workspace_id: string;
        used_bytes: string;
        computed: string;
    }>(sql`
        with sampled as (
            select workspace_id, used_bytes from workspace_storage order by random() limit ${sample}
        ),
        content as (
            select v.workspace_id, coalesce(sum(o.ciphertext_size), 0) as bytes
            from file_versions v join drive_objects o on o.id = v.object_id
            where v.status = 'ready' and v.workspace_id in (select workspace_id from sampled)
            group by v.workspace_id
        )
        select s.workspace_id, s.used_bytes::text,
               coalesce(c.bytes, 0)::text as computed
        from sampled s
        left join content c on c.workspace_id = s.workspace_id
    `);
    return rows.rows
        .filter((row) => row.used_bytes !== row.computed)
        .map((row) => ({
            workspaceId: row.workspace_id,
            usedBytes: BigInt(row.used_bytes),
            computedBytes: BigInt(row.computed),
        }));
}

/* ------------------------------------------------------------------------- */
/* Audit, the orphan sweep, and tiering                                       */
/* ------------------------------------------------------------------------- */

export type AuditTarget = 'primary' | 'replica';

/*
 * Objects for the audit, least recently confirmed first so every object comes
 * around in turn. The replica audit only considers objects the copy job says
 * it holds.
 */
export async function listObjectsForAudit(target: AuditTarget, limit = 200) {
    return db
        .select({
            objectId: driveObjects.id,
            objectKey: driveObjects.objectKey,
            ciphertextSize: driveObjects.ciphertextSize,
            status: driveObjects.status,
            replicatedAt: driveObjects.replicatedAt,
        })
        .from(driveObjects)
        .where(
            and(
                inArray(driveObjects.status, ['ready', 'missing']),
                target === 'replica' ? sql`${driveObjects.replicatedAt} is not null` : sql`true`,
            ),
        )
        .orderBy(sql`${driveObjects.auditedAt} asc nulls first`, asc(driveObjects.createdAt))
        .limit(limit);
}

export type AuditOutcome = 'present' | 'missing' | 'recovered' | 'replica-missing';

/*
 * What the audit found. A primary miss marks the object `missing` so the client
 * says the file is unavailable instead of failing to decrypt; an object found
 * again, or recovered from the replica, goes back to `ready`. A replica miss
 * clears `replicated_at`, which re-enqueues the copy.
 */
export async function recordObjectAudit(objectId: string, outcome: AuditOutcome) {
    const now = new Date();
    if (outcome === 'replica-missing') {
        await db
            .update(driveObjects)
            .set({ replicatedAt: null, auditedAt: now })
            .where(eq(driveObjects.id, objectId));
        return;
    }
    await db
        .update(driveObjects)
        .set({ status: outcome === 'missing' ? 'missing' : 'ready', auditedAt: now })
        .where(
            and(eq(driveObjects.id, objectId), inArray(driveObjects.status, ['ready', 'missing'])),
        );
}

/* The keys among `keys` that a row still names: an object, or a deletion still in the outbox. */
export async function knownObjectKeys(keys: string[]) {
    if (!keys.length) return new Set<string>();
    const objects = await db
        .select({ key: driveObjects.objectKey })
        .from(driveObjects)
        .where(inArray(driveObjects.objectKey, keys));
    const deletions = await db
        .select({ key: driveObjectDeletions.objectKey })
        .from(driveObjectDeletions)
        .where(inArray(driveObjectDeletions.objectKey, keys));
    return new Set([...objects, ...deletions].map((row) => row.key));
}

export async function getSweepCursor(name: string) {
    const [row] = await db
        .select({ cursor: driveSweeps.cursor })
        .from(driveSweeps)
        .where(eq(driveSweeps.name, name));
    return row?.cursor ?? null;
}

export async function setSweepCursor(name: string, cursor: string | null) {
    await db
        .insert(driveSweeps)
        .values({ name, cursor, updatedAt: new Date() })
        .onConflictDoUpdate({ target: driveSweeps.name, set: { cursor, updatedAt: new Date() } });
}

/*
 * Tiering candidates: ready objects in the standard class that nobody has read
 * for `idleDays` (or ever, counting from when they became ready), oldest read
 * first. Cold objects read since they went cold come back the other way.
 */
export async function listTierCandidates(idleDays: number, limit = 200) {
    return db
        .select({ objectId: driveObjects.id, objectKey: driveObjects.objectKey })
        .from(driveObjects)
        .where(
            and(
                eq(driveObjects.status, 'ready'),
                eq(driveObjects.storageClass, 'standard'),
                sql`coalesce(${driveObjects.lastReadAt}, ${driveObjects.readyAt}, ${driveObjects.createdAt}) < now() - make_interval(days => ${idleDays})`,
            ),
        )
        .orderBy(sql`coalesce(${driveObjects.lastReadAt}, ${driveObjects.readyAt}) asc`)
        .limit(limit);
}

export async function listWarmCandidates(idleDays: number, limit = 200) {
    return db
        .select({ objectId: driveObjects.id, objectKey: driveObjects.objectKey })
        .from(driveObjects)
        .where(
            and(
                eq(driveObjects.status, 'ready'),
                eq(driveObjects.storageClass, 'cold'),
                sql`${driveObjects.lastReadAt} >= now() - make_interval(days => ${idleDays})`,
            ),
        )
        .orderBy(desc(driveObjects.lastReadAt))
        .limit(limit);
}

export async function setObjectStorageClass(objectId: string, storageClass: 'standard' | 'cold') {
    await db.update(driveObjects).set({ storageClass }).where(eq(driveObjects.id, objectId));
}

/* ------------------------------------------------------------------------- */
/* Shares and authorization                                                   */
/* ------------------------------------------------------------------------- */

export type Role = 'owner' | 'editor' | 'viewer';
export type Access = {
    role: Role;
    /* The share that grants the access, and the node it was granted on; null for a member. */
    shareId: string | null;
    shareRootId: string | null;
};

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
export function atLeast(role: Role, needed: Role) {
    return RANK[role] >= RANK[needed];
}

/*
 * Authorization is the walk: a member of the workspace (membership.ts) owns everything in it;
 * anyone else needs a live share on the node or an ancestor, and the nearest
 * one sets the role. No access and no node are the same answer.
 */
async function accessFor(tx: Tx, userId: string, chain: Walk): Promise<Access | null> {
    if (await holdsWorkspace(tx, userId, chain.node.workspace_id))
        return { role: 'owner', shareId: null, shareRootId: null };
    // Nearest first: the node, its parent, and so on up to the root.
    const ids = [chain.node.id, ...chain.ancestors.map((a) => a.id).reverse()];
    const shares = await tx
        .select({ id: driveShares.id, nodeId: driveShares.nodeId, role: driveShares.role })
        .from(driveShares)
        .where(
            and(
                inArray(driveShares.nodeId, ids),
                eq(driveShares.granteeUserId, userId),
                isNull(driveShares.revokedAt),
                servedShare,
            ),
        );
    if (!shares.length) return null;
    const nearest = shares.reduce((best, share) =>
        ids.indexOf(share.nodeId) < ids.indexOf(best.nodeId) ? share : best,
    );
    return { role: nearest.role, shareId: nearest.id, shareRootId: nearest.nodeId };
}

export async function authorize(userId: string, workspaceId: string, nodeId: string) {
    return db.transaction(async (tx) => {
        const chain = await walk(tx, nodeId);
        if (!chain || chain.node.workspace_id !== workspaceId || chain.purged) return null;
        const access = await accessFor(tx, userId, chain);
        return access ? { ...access, kind: chain.node.kind, trashed: chain.trashed } : null;
    });
}

/* The subset of `versionIds` the caller may read, for batch URL requests. */
export async function authorizeVersions(userId: string, workspaceId: string, versionIds: string[]) {
    if (!versionIds.length) return new Set<string>();
    return db.transaction(async (tx) => {
        const rows = await tx
            .select({ id: fileVersions.id, nodeId: fileVersions.nodeId })
            .from(fileVersions)
            .where(
                and(
                    inArray(fileVersions.id, versionIds),
                    eq(fileVersions.workspaceId, workspaceId),
                ),
            );
        const allowed = new Set<string>();
        const byNode = new Map<string, Access | null>();
        for (const row of rows) {
            if (!byNode.has(row.nodeId)) {
                const chain = await walk(tx, row.nodeId);
                byNode.set(
                    row.nodeId,
                    chain && !chain.purged ? await accessFor(tx, userId, chain) : null,
                );
            }
            if (byNode.get(row.nodeId)) allowed.add(row.id);
        }
        return allowed;
    });
}

/* Whether the caller may draw key epochs in a workspace they are not a member of: any live editor share. */
export async function hasEditorShare(userId: string, workspaceId: string) {
    const [row] = await db
        .select({ id: driveShares.id })
        .from(driveShares)
        .where(
            and(
                eq(driveShares.granteeUserId, userId),
                eq(driveShares.workspaceId, workspaceId),
                eq(driveShares.role, 'editor'),
                isNull(driveShares.revokedAt),
                servedShare,
            ),
        )
        .limit(1);
    return row !== undefined;
}

export async function authorizeVersion(userId: string, workspaceId: string, versionId: string) {
    const [row] = await db
        .select({ nodeId: fileVersions.nodeId })
        .from(fileVersions)
        .where(and(eq(fileVersions.id, versionId), eq(fileVersions.workspaceId, workspaceId)));
    return row ? authorize(userId, workspaceId, row.nodeId) : null;
}

export async function authorizeUpload(userId: string, workspaceId: string, uploadId: string) {
    const [row] = await db
        .select({ nodeId: driveUploads.nodeId })
        .from(driveUploads)
        .where(and(eq(driveUploads.id, uploadId), eq(driveUploads.workspaceId, workspaceId)));
    return row ? authorize(userId, workspaceId, row.nodeId) : null;
}

/*
 * A suite 4 share envelope, 4565 bytes (the granter's hybrid signature,
 * docs/identity-pq-design.md), the only kind written or served: a row of suite
 * 1, 2 or 3 left from before grants nothing and is shown to nobody but its
 * granter, whose next upgrade pass re-seals it, or who revokes it.
 */
export const SHARE_ENVELOPE_BYTES = 4565;
const servedShare = sql`octet_length(${driveShares.shareEnvelope}) = ${SHARE_ENVELOPE_BYTES}`;

/* A share's suite, told apart by length: 72 bytes is 1, 1160 is 2 (hybrid), 1256 is 3 (signed), 4565 is 4 (hybrid signature). */
const shareSuite = sql<number>`case octet_length(${driveShares.shareEnvelope}) when 72 then 1 when 1160 then 2 when 1256 then 3 else 4 end`;

/*
 * Someone's public identity as a share shows it (docs/identity-pq-design.md):
 * all four public keys and a version 2 identity's keys statement; a version 1
 * identity has no ML-DSA key and no statement, and clients trust it with nothing.
 */
export const publicIdentityColumns = {
    keyVersion: accountIdentities.keyVersion,
    identityVersion: accountIdentities.version,
    encryptionPublicKey: accountIdentities.encryptionPublicKey,
    signingPublicKey: accountIdentities.signingPublicKey,
    mlDsaPublicKey: accountIdentities.mlDsaPublicKey,
    kemPublicKey: accountIdentities.kemPublicKey,
    keysSignature: accountIdentities.keysSignature,
};

export type CreateShare = {
    workspaceId: string;
    nodeId: string;
    granterUserId: string;
    granteeUserId: string;
    role: 'viewer' | 'editor';
    keyEpoch: number;
    shareEnvelope: Buffer;
};

/*
 * Sharing is not offered in family folders (docs/groups-design.md 3.4): a walk
 * re-seals only the shares and links in the walker's own sharing ledger, so
 * another member's would be closed silently at the next removal, and both
 * clients' walks refuse a family-folder node that has any. A group area takes
 * no new share or link, and no new seal or expiry on one a server before this
 * refusal let in; stopping one stays open. A workspace's owner never changes,
 * so this needs no lock.
 */
async function inGroupArea(tx: Tx, workspaceId: string) {
    const [row] = await tx
        .select({ ownerKind: workspaces.ownerKind })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
    return row?.ownerKind === 'group';
}
const familySharing = { status: 'family-sharing' as const };

/*
 * A share or link sealed on a node moves the node's own change sequence to the
 * one its write drew: a rotation that read the node before it names the old
 * one and is refused (`stale` on the walk, `root-moved` on a group's roster
 * rotation), instead of revoking the new grant as one it did not re-seal
 * (rotateNodeIn). Devices re-read the node, as for any change to it.
 */
async function sealedOnNode(tx: Tx, nodeId: string, changeSeq: number) {
    await tx.update(driveNodes).set({ changeSeq }).where(eq(driveNodes.id, nodeId));
}

/*
 * Shares a node with an account. The envelope must be sealed under the node's
 * current key epoch; a live share to the same person is replaced (a new role
 * or a fresh seal), never duplicated. Refused for a node in the trash.
 */
export async function createShare(input: CreateShare) {
    if (input.shareEnvelope.length !== SHARE_ENVELOPE_BYTES)
        return { status: 'unsupported' as const };
    return db.transaction(async (tx) => {
        if (await inGroupArea(tx, input.workspaceId)) return familySharing;
        const changeSeq = await nextChangeSeq(tx, input.workspaceId, input.granterUserId);
        const chain = await walk(tx, input.nodeId);
        if (!chain || chain.node.workspace_id !== input.workspaceId || chain.purged)
            return { status: 'not-found' as const };
        if (chain.trashed) return { status: 'trashed' as const };
        if (chain.node.key_epoch !== input.keyEpoch) return { status: 'stale' as const };
        if (input.granteeUserId === input.granterUserId) return { status: 'self' as const };
        await sealedOnNode(tx, input.nodeId, changeSeq);
        const [existing] = await tx
            .select({ id: driveShares.id })
            .from(driveShares)
            .where(
                and(
                    eq(driveShares.nodeId, input.nodeId),
                    eq(driveShares.granteeUserId, input.granteeUserId),
                    isNull(driveShares.revokedAt),
                ),
            )
            .for('update');
        const values = {
            workspaceId: input.workspaceId,
            nodeId: input.nodeId,
            granterUserId: input.granterUserId,
            granteeUserId: input.granteeUserId,
            role: input.role,
            keyEpoch: input.keyEpoch,
            shareEnvelope: input.shareEnvelope,
            updatedAt: new Date(),
        };
        const [row] = existing
            ? await tx
                  .update(driveShares)
                  .set(values)
                  .where(eq(driveShares.id, existing.id))
                  .returning()
            : await tx.insert(driveShares).values(values).returning();
        return { status: 'ok' as const, share: row!, replaced: Boolean(existing) };
    });
}

/* The live shares on one node, with who holds them. Owner's view. */
export async function listNodeShares(workspaceId: string, nodeId: string) {
    return db
        .select({
            id: driveShares.id,
            role: driveShares.role,
            keyEpoch: driveShares.keyEpoch,
            createdAt: driveShares.createdAt,
            suite: shareSuite,
            grantee: { id: users.id, name: users.name, email: users.email },
        })
        .from(driveShares)
        .innerJoin(users, eq(users.id, driveShares.granteeUserId))
        .where(
            and(
                eq(driveShares.workspaceId, workspaceId),
                eq(driveShares.nodeId, nodeId),
                isNull(driveShares.revokedAt),
            ),
        )
        .orderBy(asc(driveShares.createdAt));
}

/*
 * "Shared with me": every live share to the caller whose node still exists
 * and is not in the trash, with the node itself and the granter's identity
 * key, which the client checks against its pin before opening the envelope.
 */
export async function listSharesForGrantee(userId: string) {
    return db.transaction(async (tx) => {
        const rows = await tx
            .select({
                id: driveShares.id,
                workspaceId: driveShares.workspaceId,
                nodeId: driveShares.nodeId,
                role: driveShares.role,
                keyEpoch: driveShares.keyEpoch,
                shareEnvelope: driveShares.shareEnvelope,
                // The envelope a rotation in flight replaced, served only when it is suite 3
                // too: a rotation that re-seals a row left from before keeps its suite 1 or 2
                // envelope here, which opens on no client now.
                prevShareEnvelope:
                    sql<Buffer | null>`case when octet_length(${driveShares.prevShareEnvelope}) = ${SHARE_ENVELOPE_BYTES} then ${driveShares.prevShareEnvelope} end`.mapWith(
                        driveShares.prevShareEnvelope,
                    ),
                prevKeyEpoch: sql<
                    number | null
                >`case when octet_length(${driveShares.prevShareEnvelope}) = ${SHARE_ENVELOPE_BYTES} then ${driveShares.prevKeyEpoch} end`.mapWith(
                    driveShares.prevKeyEpoch,
                ),
                createdAt: driveShares.createdAt,
                changeSeq: workspaces.changeSeq,
                // A suite 4 share is signed by the granter: the grantee checks both halves
                // against the pin, and after a succession asks for the chain from the pinned version.
                granter: {
                    id: users.id,
                    name: users.name,
                    email: users.email,
                    ...publicIdentityColumns,
                },
            })
            .from(driveShares)
            .innerJoin(users, eq(users.id, driveShares.granterUserId))
            .innerJoin(accountIdentities, eq(accountIdentities.userId, driveShares.granterUserId))
            .innerJoin(workspaces, eq(workspaces.id, driveShares.workspaceId))
            .where(
                and(
                    eq(driveShares.granteeUserId, userId),
                    isNull(driveShares.revokedAt),
                    servedShare,
                ),
            )
            .orderBy(desc(driveShares.createdAt));
        const out: (Omit<(typeof rows)[number], 'nodeId' | 'changeSeq'> & {
            /* Where the share's feed starts: the owner's sequence now, sealed. */
            feedCursor: string;
            node: NodeRow & { currentVersion: VersionRow | null };
        })[] = [];
        for (const row of rows) {
            const chain = await walk(tx, row.nodeId);
            if (!chain || chain.purged || chain.trashed) continue;
            const [node] = await selectNodes(tx, [row.nodeId]);
            if (!node) continue;
            const { nodeId: _nodeId, changeSeq, ...rest } = row;
            out.push({ ...rest, feedCursor: sealShareCursor(row.id, changeSeq), node });
        }
        return out;
    });
}

/*
 * The nodes among `ids` anyone can still reach: not purged, and not in the trash
 * by themselves or by an ancestor. A share or link on anything else is hidden
 * from its owner's list exactly as it is from the other side, until a restore.
 */
async function reachableNodes(tx: Tx, ids: string[]) {
    const out = new Map<string, NodeRow & { currentVersion: VersionRow | null }>();
    for (const node of await selectNodes(tx, ids)) {
        const chain = await walk(tx, node.id);
        if (chain && !chain.purged && !chain.trashed) out.set(node.id, node);
    }
    return out;
}

/* Everything the caller has shared with accounts, with the nodes, for managing in one place. */
export async function listSharesByGranter(userId: string) {
    return db.transaction(async (tx) => {
        const rows = await tx
            .select({
                id: driveShares.id,
                workspaceId: driveShares.workspaceId,
                nodeId: driveShares.nodeId,
                role: driveShares.role,
                keyEpoch: driveShares.keyEpoch,
                createdAt: driveShares.createdAt,
                suite: shareSuite,
                grantee: { id: users.id, name: users.name, email: users.email },
                // The grantee's served identity, for the owner to check against the pin
                // before re-sealing an older share in suite 4.
                granteeIdentity: publicIdentityColumns,
            })
            .from(driveShares)
            .innerJoin(users, eq(users.id, driveShares.granteeUserId))
            .innerJoin(accountIdentities, eq(accountIdentities.userId, driveShares.granteeUserId))
            .where(and(eq(driveShares.granterUserId, userId), isNull(driveShares.revokedAt)))
            .orderBy(desc(driveShares.createdAt));
        const nodes = await reachableNodes(tx, [...new Set(rows.map((row) => row.nodeId))]);
        return rows.flatMap((row) => {
            const node = nodes.get(row.nodeId);
            return node ? [{ ...row, node }] : [];
        });
    });
}

/*
 * Replaces a live share's envelope under the node's current key epoch with a
 * suite 3 one: how a share is sealed to a grantee's new keys, or a suite 1 or
 * 2 row left from before is brought back into service. Only the granter,
 * only the current epoch (a rotation in flight re-seals on its own), and
 * never a share that is revoked or on a purged node.
 */
export async function resealShare(input: {
    workspaceId: string;
    shareId: string;
    granterUserId: string;
    keyEpoch: number;
    shareEnvelope: Buffer;
}) {
    if (input.shareEnvelope.length !== SHARE_ENVELOPE_BYTES)
        return { status: 'unsupported' as const };
    return db.transaction(async (tx) => {
        if (await inGroupArea(tx, input.workspaceId)) return familySharing;
        const changeSeq = await nextChangeSeq(tx, input.workspaceId, input.granterUserId);
        const [share] = await tx
            .select({
                id: driveShares.id,
                nodeId: driveShares.nodeId,
                granterUserId: driveShares.granterUserId,
            })
            .from(driveShares)
            .where(
                and(
                    eq(driveShares.id, input.shareId),
                    eq(driveShares.workspaceId, input.workspaceId),
                    isNull(driveShares.revokedAt),
                ),
            )
            .for('update');
        if (!share || share.granterUserId !== input.granterUserId)
            return { status: 'not-found' as const };
        const chain = await walk(tx, share.nodeId);
        if (!chain || chain.purged) return { status: 'not-found' as const };
        if (chain.node.key_epoch !== input.keyEpoch) return { status: 'stale' as const };
        await sealedOnNode(tx, share.nodeId, changeSeq);
        await tx
            .update(driveShares)
            .set({
                shareEnvelope: input.shareEnvelope,
                keyEpoch: input.keyEpoch,
                updatedAt: new Date(),
            })
            .where(eq(driveShares.id, share.id));
        return { status: 'ok' as const };
    });
}

/*
 * Stopping a share or link does not take back the node key its recipient
 * already has: only a rotation does. In a group area every revocation marks
 * the area due for rotation, whoever made it, and its holders see it in
 * `due.rotations` (docs/groups-server.md 3): a member without `members` may
 * not rotate at all, and a holder whose device stops before it rotates would
 * otherwise leave no trace of the rotation owed. Only a roster rotation of the
 * area clears the mark. The area's row is locked before the share's, as a
 * departure locks them, so the two cannot wait on each other.
 */
async function lockForRevocation(tx: Tx, workspaceId: string) {
    const [row] = await tx
        .select({ ownerKind: workspaces.ownerKind })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for('no key update');
    return row ?? null;
}
async function rotationDueAfterRevocation(
    tx: Tx,
    workspace: { ownerKind: string },
    workspaceId: string,
) {
    if (workspace.ownerKind !== 'group') return;
    await tx
        .update(workspaces)
        .set({ rotationDueAt: sql`coalesce(${workspaces.rotationDueAt}, now())` })
        .where(eq(workspaces.id, workspaceId));
}

export async function revokeShare(workspaceId: string, shareId: string) {
    return db.transaction(async (tx) => {
        const workspace = await lockForRevocation(tx, workspaceId);
        if (!workspace) return null;
        const [row] = await tx
            .update(driveShares)
            .set({ revokedAt: new Date(), updatedAt: new Date() })
            .where(
                and(
                    eq(driveShares.id, shareId),
                    eq(driveShares.workspaceId, workspaceId),
                    isNull(driveShares.revokedAt),
                ),
            )
            .returning({ id: driveShares.id, nodeId: driveShares.nodeId });
        if (row) await rotationDueAfterRevocation(tx, workspace, workspaceId);
        return row ?? null;
    });
}

/* ------------------------------------------------------------------------- */
/* Links                                                                      */
/* ------------------------------------------------------------------------- */

export type CreateLink = {
    /* Client-generated, because it is sealed into the envelope's context before the row exists. */
    id: string;
    workspaceId: string;
    nodeId: string;
    granterUserId: string;
    tokenHash: Buffer;
    keyEpoch: number;
    linkEnvelope: Buffer;
    linkSalt: Buffer;
    secretEnvelope: Buffer | null;
    hasPassword: boolean;
    expiresAt: Date | null;
};

/* A new link on a live node, sealed under the node's current key epoch. Several links per node are fine. */
export async function createLink(input: CreateLink) {
    return db.transaction(async (tx) => {
        if (await inGroupArea(tx, input.workspaceId)) return familySharing;
        // The workspace lock a rotation batch takes too: in a personal workspace as well, a link
        // made on one device and a rotation applied on another are ordered, never interleaved.
        const changeSeq = await nextChangeSeq(tx, input.workspaceId, input.granterUserId);
        const chain = await walk(tx, input.nodeId);
        if (!chain || chain.node.workspace_id !== input.workspaceId || chain.purged)
            return { status: 'not-found' as const };
        if (chain.trashed) return { status: 'trashed' as const };
        if (chain.node.key_epoch !== input.keyEpoch) return { status: 'stale' as const };
        const [row] = await tx.insert(driveLinks).values(input).onConflictDoNothing().returning();
        if (!row) return { status: 'conflict' as const };
        await sealedOnNode(tx, input.nodeId, changeSeq);
        return { status: 'ok' as const, link: row };
    });
}

const linkColumns = {
    id: driveLinks.id,
    workspaceId: driveLinks.workspaceId,
    nodeId: driveLinks.nodeId,
    keyEpoch: driveLinks.keyEpoch,
    secretEnvelope: driveLinks.secretEnvelope,
    hasPassword: driveLinks.hasPassword,
    kdfVersion: driveLinks.kdfVersion,
    expiresAt: driveLinks.expiresAt,
    useCount: driveLinks.useCount,
    lastUsedAt: driveLinks.lastUsedAt,
    createdAt: driveLinks.createdAt,
    revokedAt: driveLinks.revokedAt,
};

/* The owner's view of a node's links: live ones, never the token, which was shown once. */
export async function listNodeLinks(workspaceId: string, nodeId: string) {
    return db
        .select(linkColumns)
        .from(driveLinks)
        .where(
            and(
                eq(driveLinks.workspaceId, workspaceId),
                eq(driveLinks.nodeId, nodeId),
                isNull(driveLinks.revokedAt),
            ),
        )
        .orderBy(asc(driveLinks.createdAt));
}

export async function listLinksByGranter(userId: string) {
    return db.transaction(async (tx) => {
        const rows = await tx
            .select(linkColumns)
            .from(driveLinks)
            .where(and(eq(driveLinks.granterUserId, userId), isNull(driveLinks.revokedAt)))
            .orderBy(desc(driveLinks.createdAt));
        const nodes = await reachableNodes(tx, [...new Set(rows.map((row) => row.nodeId))]);
        return rows.flatMap((row) => {
            const node = nodes.get(row.nodeId);
            return node ? [{ ...row, node }] : [];
        });
    });
}

/*
 * Changes what a link asks for or how long it lasts, keeping the link itself:
 * a new seal under a new password (the owner re-sealed the same secret), or a
 * new expiry. Refused when the node's key epoch moved since the envelope was sealed.
 */
export async function updateLink(input: {
    workspaceId: string;
    linkId: string;
    keyEpoch: number;
    seal?: {
        linkEnvelope: Buffer;
        linkSalt: Buffer;
        hasPassword: boolean;
        secretEnvelope?: Buffer;
    };
    expiresAt?: Date | null;
}) {
    return db.transaction(async (tx) => {
        if (await inGroupArea(tx, input.workspaceId)) return familySharing;
        // A new seal takes the workspace lock first, as a revocation and a rotation batch do.
        const changeSeq = input.seal ? await nextChangeSeq(tx, input.workspaceId) : null;
        const [link] = await tx
            .select({ id: driveLinks.id, nodeId: driveLinks.nodeId })
            .from(driveLinks)
            .where(
                and(
                    eq(driveLinks.id, input.linkId),
                    eq(driveLinks.workspaceId, input.workspaceId),
                    isNull(driveLinks.revokedAt),
                ),
            )
            .for('update');
        if (!link) return { status: 'not-found' as const };
        const chain = await walk(tx, link.nodeId);
        if (!chain || chain.purged) return { status: 'not-found' as const };
        if (chain.node.key_epoch !== input.keyEpoch) return { status: 'stale' as const };
        if (changeSeq !== null) await sealedOnNode(tx, link.nodeId, changeSeq);
        const [row] = await tx
            .update(driveLinks)
            .set({
                ...input.seal,
                // A fresh seal is made with the derivation every client uses now.
                ...(input.seal ? { kdfVersion: LINK_KDF_VERSION } : {}),
                ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
            })
            .where(eq(driveLinks.id, link.id))
            .returning(linkColumns);
        return { status: 'ok' as const, link: row! };
    });
}

/* A link stopped; in a group area the area is due for rotation (revokeShare). */
export async function revokeLink(workspaceId: string, linkId: string) {
    return db.transaction(async (tx) => {
        const workspace = await lockForRevocation(tx, workspaceId);
        if (!workspace) return null;
        const [row] = await tx
            .update(driveLinks)
            .set({ revokedAt: new Date() })
            .where(
                and(
                    eq(driveLinks.id, linkId),
                    eq(driveLinks.workspaceId, workspaceId),
                    isNull(driveLinks.revokedAt),
                ),
            )
            .returning({ id: driveLinks.id, nodeId: driveLinks.nodeId });
        if (row) await rotationDueAfterRevocation(tx, workspace, workspaceId);
        return row ?? null;
    });
}

/*
 * What a visitor with the token gets: the link and its node, when the link is
 * live, unexpired, and the node still exists outside the trash. Anything else
 * is the same absence, so a token cannot be probed for why it stopped working.
 */
export async function resolveLink(tokenHash: Buffer) {
    return db.transaction(async (tx) => {
        const [link] = await tx
            .select({
                ...linkColumns,
                linkEnvelope: driveLinks.linkEnvelope,
                linkSalt: driveLinks.linkSalt,
            })
            .from(driveLinks)
            .where(and(eq(driveLinks.tokenHash, tokenHash), isNull(driveLinks.revokedAt)));
        if (!link || (link.expiresAt && link.expiresAt.getTime() <= Date.now())) return null;
        const chain = await walk(tx, link.nodeId);
        if (!chain || chain.purged || chain.trashed) return null;
        const [node] = await selectNodes(tx, [link.nodeId]);
        if (!node) return null;
        return { link, node };
    });
}

/* A visit: counted at most once a minute per link so the owner sees use without a write per request. */
export async function touchLink(linkId: string) {
    await db
        .update(driveLinks)
        .set({ useCount: sql`${driveLinks.useCount} + 1`, lastUsedAt: new Date() })
        .where(
            and(
                eq(driveLinks.id, linkId),
                sql`(${driveLinks.lastUsedAt} is null or ${driveLinks.lastUsedAt} < now() - interval '1 minute')`,
            ),
        );
}

/*
 * Whether a node lies inside a live link's subtree: the walk must pass through
 * the link's node, nothing in the chain may be purged or trashed, and the link
 * must still be live. Returns the link's node id as the listing boundary.
 */
export async function authorizeLink(tokenHash: Buffer, nodeId: string) {
    return db.transaction(async (tx) => {
        const [link] = await tx
            .select({
                id: driveLinks.id,
                nodeId: driveLinks.nodeId,
                workspaceId: driveLinks.workspaceId,
                expiresAt: driveLinks.expiresAt,
            })
            .from(driveLinks)
            .where(and(eq(driveLinks.tokenHash, tokenHash), isNull(driveLinks.revokedAt)));
        if (!link || (link.expiresAt && link.expiresAt.getTime() <= Date.now())) return null;
        const chain = await walk(tx, nodeId);
        if (!chain || chain.purged || chain.trashed || chain.node.workspace_id !== link.workspaceId)
            return null;
        const inside =
            chain.node.id === link.nodeId || chain.ancestors.some((a) => a.id === link.nodeId);
        return inside
            ? { linkId: link.id, workspaceId: link.workspaceId, boundary: link.nodeId }
            : null;
    });
}

/* The subset of `versionIds` inside a live link's subtree. */
export async function authorizeLinkVersions(tokenHash: Buffer, versionIds: string[]) {
    if (!versionIds.length) return { workspaceId: null, allowed: new Set<string>() };
    const rows = await db
        .select({ id: fileVersions.id, nodeId: fileVersions.nodeId })
        .from(fileVersions)
        .where(inArray(fileVersions.id, versionIds));
    const allowed = new Set<string>();
    let workspaceId: string | null = null;
    const byNode = new Map<string, boolean>();
    for (const row of rows) {
        if (!byNode.has(row.nodeId)) {
            const access = await authorizeLink(tokenHash, row.nodeId);
            byNode.set(row.nodeId, access !== null);
            if (access) workspaceId = access.workspaceId;
        }
        if (byNode.get(row.nodeId)) allowed.add(row.id);
    }
    return { workspaceId, allowed };
}

/* ------------------------------------------------------------------------- */
/* Change feeds                                                               */
/* ------------------------------------------------------------------------- */

export type Change =
    | { kind: 'node'; changeSeq: number; node: NodeRow & { currentVersion: VersionRow | null } }
    | { kind: 'tombstone'; changeSeq: number; nodeId: string; parentId: string | null }
    | { kind: 'entered' | 'left'; changeSeq: number; nodeId: string };

/*
 * Nodes changed since a cursor, in order, tombstones included; the cursor is
 * the last sequence examined. A node without a sequence is invisible here.
 */
export async function listChanges(input: { workspaceId: string; since: number; limit?: number }) {
    const limit = Math.min(input.limit ?? 200, 500);
    // A cursor older than the newest dropped tombstone may have missed a deletion:
    // the client must start over. A cursor of zero is starting over already.
    const [workspace] = await db
        .select({ dropped: workspaces.tombstonesDroppedThrough })
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId));
    const resync = input.since > 0 && input.since < (workspace?.dropped ?? 0);
    const ids = await db
        .select({ id: driveNodes.id, changeSeq: driveNodes.changeSeq })
        .from(driveNodes)
        .where(
            and(
                eq(driveNodes.workspaceId, input.workspaceId),
                sql`${driveNodes.changeSeq} > ${input.since}`,
            ),
        )
        .orderBy(asc(driveNodes.changeSeq))
        .limit(limit + 1);
    const page = ids.slice(0, limit);
    const nodes = await db.transaction((tx) =>
        selectNodes(
            tx,
            page.map((row) => row.id),
        ),
    );
    const changes: Change[] = page.map((row) => {
        const node = nodes.find((n) => n.id === row.id)!;
        return node.keyEnvelope
            ? { kind: 'node', changeSeq: row.changeSeq!, node }
            : {
                  kind: 'tombstone',
                  changeSeq: row.changeSeq!,
                  nodeId: node.id,
                  parentId: node.parentId,
              };
    });
    return {
        changes,
        nextCursor: page.at(-1)?.changeSeq ?? input.since,
        hasMore: ids.length > limit,
        resync,
    };
}

/* A change as a grantee sees it: in order, but without the owner's sequence numbers. */
export type ShareChange =
    | { kind: 'node'; node: NodeRow & { currentVersion: VersionRow | null } }
    | { kind: 'tombstone'; nodeId: string; parentId: string | null }
    | { kind: 'entered' | 'left'; nodeId: string };

/* How many of the owner's changes one poll of a share feed looks at, at most. */
export const SHARE_FEED_SCAN = 2000;

/*
 * A share's feed: the owner's changes inside the shared subtree, tombstones
 * included, merged with the share's membership events. Only what was inside
 * the share is shown: a live node by its chain, a tombstone by the ancestors
 * recorded when it was purged (older tombstones, which have none, are never
 * shown). The cursor is sealed (see share-cursor.ts), so neither the changes
 * nor the cursor tell a grantee what the owner did elsewhere or how often; a
 * missing cursor starts from the beginning and a tampered one is refused.
 * Each poll looks at a bounded number of the owner's changes. Revoked means
 * there is nothing more to say.
 */
export async function listShareChanges(input: {
    shareId: string;
    granteeUserId: string;
    cursor?: string | null;
    limit?: number;
}) {
    const [share] = await db
        .select({
            id: driveShares.id,
            workspaceId: driveShares.workspaceId,
            nodeId: driveShares.nodeId,
            revokedAt: driveShares.revokedAt,
        })
        .from(driveShares)
        .where(
            and(
                eq(driveShares.id, input.shareId),
                eq(driveShares.granteeUserId, input.granteeUserId),
                servedShare,
            ),
        );
    if (!share) return { status: 'not-found' as const };
    if (share.revokedAt) return { status: 'revoked' as const };
    let since = 0;
    if (input.cursor !== undefined && input.cursor !== null) {
        const opened = openShareCursor(share.id, input.cursor);
        if (opened === null) return { status: 'bad-cursor' as const };
        since = opened;
    }
    const limit = Math.min(input.limit ?? 200, 500);
    const scanned = await db.transaction(async (tx) => {
        // Read before the scan: every change at or below it has committed (see nextChangeSeq).
        const [workspace] = await tx
            .select({
                changeSeq: workspaces.changeSeq,
                dropped: workspaces.tombstonesDroppedThrough,
            })
            .from(workspaces)
            .where(eq(workspaces.id, share.workspaceId));
        const kept: { seq: number; change: ShareChange | { kind: 'node'; nodeId: string } }[] = [];
        let position = since;
        let examined = 0;
        let exhausted = false;
        while (kept.length < limit && examined < SHARE_FEED_SCAN) {
            const take = Math.min(500, SHARE_FEED_SCAN - examined);
            const rows = await tx
                .select({
                    id: driveNodes.id,
                    parentId: driveNodes.parentId,
                    changeSeq: driveNodes.changeSeq,
                    purgedAt: driveNodes.purgedAt,
                    purgedAncestorIds: driveNodes.purgedAncestorIds,
                })
                .from(driveNodes)
                .where(
                    and(
                        eq(driveNodes.workspaceId, share.workspaceId),
                        sql`${driveNodes.changeSeq} > ${position}`,
                    ),
                )
                .orderBy(asc(driveNodes.changeSeq))
                .limit(take);
            for (const row of rows) {
                examined++;
                position = row.changeSeq!;
                if (row.purgedAt) {
                    if (row.purgedAncestorIds?.includes(share.nodeId))
                        kept.push({
                            seq: position,
                            change: { kind: 'tombstone', nodeId: row.id, parentId: row.parentId },
                        });
                } else {
                    const chain = await walk(tx, row.id);
                    if (
                        chain &&
                        (chain.node.id === share.nodeId ||
                            chain.ancestors.some((a) => a.id === share.nodeId))
                    )
                        kept.push({ seq: position, change: { kind: 'node', nodeId: row.id } });
                }
                if (kept.length === limit) break;
            }
            if (rows.length < take && kept.length < limit) {
                exhausted = true;
                break;
            }
        }
        // Everything up to the sequence read first has been seen once the scan ran dry.
        if (exhausted) position = Math.max(position, workspace?.changeSeq ?? 0);
        const [more] = exhausted
            ? []
            : await tx
                  .select({ id: driveNodes.id })
                  .from(driveNodes)
                  .where(
                      and(
                          eq(driveNodes.workspaceId, share.workspaceId),
                          sql`${driveNodes.changeSeq} > ${position}`,
                      ),
                  )
                  .limit(1);
        const nodeIds = kept.flatMap((entry) =>
            entry.change.kind === 'node' && 'nodeId' in entry.change ? [entry.change.nodeId] : [],
        );
        const nodes = new Map((await selectNodes(tx, nodeIds)).map((node) => [node.id, node]));
        const events = await tx
            .select()
            .from(driveShareEvents)
            .where(
                and(
                    eq(driveShareEvents.shareId, share.id),
                    sql`${driveShareEvents.changeSeq} > ${since}`,
                    sql`${driveShareEvents.changeSeq} <= ${position}`,
                ),
            );
        const ordered: { seq: number; change: ShareChange }[] = kept.flatMap((entry) => {
            if (entry.change.kind !== 'node' || !('nodeId' in entry.change))
                return [{ seq: entry.seq, change: entry.change as ShareChange }];
            const node = nodes.get(entry.change.nodeId);
            return node ? [{ seq: entry.seq, change: { kind: 'node' as const, node } }] : [];
        });
        for (const event of events)
            ordered.push({
                seq: event.changeSeq,
                change: { kind: event.kind, nodeId: event.nodeId },
            });
        ordered.sort((a, b) => a.seq - b.seq);
        return {
            changes: ordered.map((entry) => entry.change),
            position,
            hasMore: more !== undefined,
            resync: since > 0 && since < (workspace?.dropped ?? 0),
        };
    });
    return {
        status: 'ok' as const,
        changes: scanned.changes,
        cursor: sealShareCursor(share.id, scanned.position),
        hasMore: scanned.hasMore,
        resync: scanned.resync,
    };
}

/*
 * Sealed workspace documents: one row per kind, replaced whole. The version a
 * client saw is the precondition; 0 means it saw none and expects to create
 * the row. A stale write returns the current row so the client can merge.
 */
/*
 * How every client derives a link key today (@hushos/crypto/links): what a link
 * sealed again, by a password change or a rotation, is recorded as.
 */
export const LINK_KDF_VERSION = 2;

export type DocumentRow = {
    kind: string;
    version: number;
    envelope: Buffer;
    envelopeSuite: number;
    updatedAt: Date;
};
export async function getWorkspaceDocument(workspaceId: string, kind: string) {
    const [row] = await db
        .select({
            kind: workspaceDocuments.kind,
            version: workspaceDocuments.version,
            envelope: workspaceDocuments.envelope,
            envelopeSuite: workspaceDocuments.envelopeSuite,
            updatedAt: workspaceDocuments.updatedAt,
        })
        .from(workspaceDocuments)
        .where(
            and(eq(workspaceDocuments.workspaceId, workspaceId), eq(workspaceDocuments.kind, kind)),
        );
    return (row as DocumentRow | undefined) ?? null;
}
export async function putWorkspaceDocument(input: {
    workspaceId: string;
    kind: string;
    version: number; // the version the client saw; 0 for none
    envelope: Buffer;
    /* With the writer named, a group area re-checks under its lock that they may still write. */
    writer?: string;
    /*
     * The most kinds the workspace may hold, and the most stored envelope bytes between them
     * (WORKSPACE_DOCUMENT_KINDS and WORKSPACE_DOCUMENT_BYTES in @hushos/drive/protocol).
     */
    limits: { kinds: number; bytes: number };
}) {
    return db.transaction(async (tx) => {
        /*
         * The workspace's row first, as every Drive write and a roster's area lock take it:
         * writes to its documents queue here, so two cannot both pass the limits below, and a
         * roster that re-seals them (lockAreas, then the rows) sees each write whole or not.
         */
        const [workspace] = await tx
            .select({ groupId: workspaces.groupId })
            .from(workspaces)
            .where(eq(workspaces.id, input.workspaceId))
            .for('no key update');
        if (!workspace) throw new Error('Workspace not found.');
        if (input.writer)
            await requireStillWriter(tx, input.workspaceId, input.writer, workspace.groupId);
        const columns = {
            kind: workspaceDocuments.kind,
            version: workspaceDocuments.version,
            envelope: workspaceDocuments.envelope,
            envelopeSuite: workspaceDocuments.envelopeSuite,
            updatedAt: workspaceDocuments.updatedAt,
        };
        const held = await tx
            .select({
                kind: workspaceDocuments.kind,
                version: workspaceDocuments.version,
                bytes: sql<number>`octet_length(${workspaceDocuments.envelope})`.mapWith(Number),
            })
            .from(workspaceDocuments)
            .where(eq(workspaceDocuments.workspaceId, input.workspaceId));
        const mine = held.find((row) => row.kind === input.kind);
        // A stale write is answered stale first: the client merges, and only then meets a limit.
        if ((mine?.version ?? 0) === input.version) {
            if (!mine && held.length >= input.limits.kinds)
                return { status: 'limit' as const, limit: 'kinds' as const };
            const others = held
                .filter((row) => row.kind !== input.kind)
                .reduce((sum, row) => sum + row.bytes, 0);
            if (others + input.envelope.length > input.limits.bytes)
                return { status: 'limit' as const, limit: 'bytes' as const };
        }
        if (input.version === 0) {
            const [inserted] = await tx
                .insert(workspaceDocuments)
                .values({
                    workspaceId: input.workspaceId,
                    kind: input.kind,
                    version: 1,
                    envelope: input.envelope,
                })
                .onConflictDoNothing()
                .returning(columns);
            if (inserted) return { status: 'ok' as const, document: inserted as DocumentRow };
        } else {
            const [updated] = await tx
                .update(workspaceDocuments)
                .set({
                    version: input.version + 1,
                    envelope: input.envelope,
                    updatedAt: new Date(),
                })
                .where(
                    and(
                        eq(workspaceDocuments.workspaceId, input.workspaceId),
                        eq(workspaceDocuments.kind, input.kind),
                        eq(workspaceDocuments.version, input.version),
                    ),
                )
                .returning(columns);
            if (updated) return { status: 'ok' as const, document: updated as DocumentRow };
        }
        const [current] = await tx
            .select(columns)
            .from(workspaceDocuments)
            .where(
                and(
                    eq(workspaceDocuments.workspaceId, input.workspaceId),
                    eq(workspaceDocuments.kind, input.kind),
                ),
            );
        return { status: 'stale' as const, document: (current as DocumentRow | undefined) ?? null };
    });
}
