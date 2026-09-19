import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { db } from './client';
import { heldObjectCondition } from './reports';
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
    personalWorkspaces,
    storageEntitlements,
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

/* Locks the workspace row and takes the next change sequence number. */
export async function nextChangeSeq(tx: Tx, workspaceId: string) {
    const [row] = await tx
        .update(workspaces)
        .set({ changeSeq: sql`${workspaces.changeSeq} + 1` })
        .where(eq(workspaces.id, workspaceId))
        .returning({ changeSeq: workspaces.changeSeq });
    if (!row) throw new Error('Workspace not found.');
    return row.changeSeq;
}

/*
 * Reserves `count` node key epochs. The client wraps keys under the epochs it
 * was given; an epoch a client never uses is a gap, and gaps are harmless because
 * the counter only has to exceed every epoch a node has ever carried.
 */
export async function allocateKeyEpochs(workspaceId: string, count: number) {
    if (!Number.isInteger(count) || count < 1 || count > 10_000)
        throw new Error('Invalid epoch count.');
    const [row] = await db
        .update(workspaces)
        .set({ keyEpochSeq: sql`${workspaces.keyEpochSeq} + ${count}` })
        .where(eq(workspaces.id, workspaceId))
        .returning({ keyEpochSeq: workspaces.keyEpochSeq });
    if (!row) return null;
    return { from: row.keyEpochSeq - count + 1, to: row.keyEpochSeq };
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
};
export type NodeRow = Omit<typeof driveNodes.$inferSelect, 'createdBy' | 'purgedAt'>;
export type VersionRow = {
    id: string;
    objectId: string;
    contentKeyEnvelope: Buffer | null;
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

export async function selectNodes(tx: Tx, ids: string[]) {
    if (!ids.length) return [] as (NodeRow & { currentVersion: VersionRow | null })[];
    const rows = await tx
        .select({ node: nodeColumns, version: versionColumns })
        .from(driveNodes)
        .leftJoin(fileVersions, eq(fileVersions.id, driveNodes.currentVersionId))
        .leftJoin(driveObjects, eq(driveObjects.id, fileVersions.objectId))
        .where(inArray(driveNodes.id, ids));
    return rows.map((row) => ({
        ...(row.node as NodeRow),
        currentVersion: row.version.id ? (row.version as VersionRow) : null,
    }));
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
    const [root] = await db
        .select(nodeColumns)
        .from(driveNodes)
        .where(and(eq(driveNodes.workspaceId, row.workspaceId), isNull(driveNodes.parentId)));
    return {
        workspaceId: row.workspaceId,
        changeSeq: row.changeSeq,
        grant: row.grant?.workspaceId ? row.grant : null,
        root: (root as NodeRow | undefined) ?? null,
        rotation: await activeRotation(db, row.workspaceId),
    };
}

export async function isMember(userId: string, workspaceId: string) {
    const [row] = await db
        .select({ userId: workspaceKeys.userId })
        .from(workspaceKeys)
        .where(and(eq(workspaceKeys.workspaceId, workspaceId), eq(workspaceKeys.userId, userId)));
    return row !== undefined;
}

export type NodeEnvelopes = {
    keyEpoch: number;
    parentKeyEpoch: number;
    keyEnvelope: Buffer;
    metadataEnvelope: Buffer;
};

/*
 * The root: created once, in the request that stores its envelope. Its parent key
 * is the workspace key, so `parentKeyEpoch` is the workspace key's own version.
 */
export async function createRoot(input: {
    workspaceId: string;
    userId: string;
    id: string;
    envelopes: NodeEnvelopes;
}) {
    return db.transaction(async (tx) => {
        const changeSeq = await nextChangeSeq(tx, input.workspaceId);
        const [existing] = await tx
            .select(nodeColumns)
            .from(driveNodes)
            .where(and(eq(driveNodes.workspaceId, input.workspaceId), isNull(driveNodes.parentId)));
        if (existing) return { status: 'exists' as const, root: existing as NodeRow };
        if (!(await epochWasAllocated(tx, input.workspaceId, input.envelopes.keyEpoch)))
            return { status: 'stale' as const };
        const [root] = await tx
            .insert(driveNodes)
            .values({
                id: input.id,
                workspaceId: input.workspaceId,
                parentId: null,
                kind: 'folder',
                ...input.envelopes,
                createdBy: input.userId,
                changeSeq,
            })
            .returning(nodeColumns);
        return { status: 'created' as const, root: root as NodeRow };
    });
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
    return db.transaction(async (tx) => {
        const changeSeq = await nextChangeSeq(tx, input.workspaceId);
        const created = new Map<
            string,
            { depth: number; keyEpoch: number; ancestors: Ancestor[] }
        >();
        const rows: NodeRow[] = [];
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
                    createdBy: input.userId,
                    changeSeq,
                })
                .onConflictDoNothing()
                .returning(nodeColumns);
            if (!row) return { status: 'conflict' as const, id: folder.id };
            rows.push(row as NodeRow);
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
        return { status: 'created' as const, nodes: rows, changeSeq };
    });
}

/* Replaces the metadata envelope; refuses a stale version or epoch with the current row. */
export async function renameNode(input: {
    workspaceId: string;
    nodeId: string;
    metadataVersion: number; // the version the client saw
    keyEpoch: number; // the epoch the new envelope was encrypted under
    metadataEnvelope: Buffer;
}) {
    return db.transaction(async (tx) => {
        const changeSeq = await nextChangeSeq(tx, input.workspaceId);
        const chain = await walk(tx, input.nodeId);
        if (!chain || chain.node.workspace_id !== input.workspaceId || chain.purged)
            return { status: 'not-found' as const };
        if (chain.trashed) return { status: 'trashed' as const };
        const [updated] = await tx
            .update(driveNodes)
            .set({
                metadataEnvelope: input.metadataEnvelope,
                metadataVersion: input.metadataVersion + 1,
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
        if (updated) return { status: 'ok' as const, node: updated as NodeRow };
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
    nodeId: string;
    parentId: string;
    parentKeyEpoch: number;
    keyEnvelope: Buffer;
}) {
    return db.transaction(async (tx) => {
        const changeSeq = await nextChangeSeq(tx, input.workspaceId);
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
        return { status: 'ok' as const, node: moved as NodeRow };
    });
}

export async function trashNode(input: { workspaceId: string; nodeId: string }) {
    return db.transaction(async (tx) => {
        const changeSeq = await nextChangeSeq(tx, input.workspaceId);
        const chain = await walk(tx, input.nodeId);
        if (!chain || chain.node.workspace_id !== input.workspaceId || chain.purged)
            return { status: 'not-found' as const };
        if (chain.node.parent_id === null) return { status: 'root' as const };
        if (chain.trashed) return { status: 'trashed' as const };
        const [node] = await tx
            .update(driveNodes)
            .set({ trashedAt: new Date(), changeSeq, updatedAt: new Date() })
            .where(eq(driveNodes.id, input.nodeId))
            .returning(nodeColumns);
        return { status: 'ok' as const, node: node as NodeRow };
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
    return db.transaction(async (tx) => {
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
    });
}

export async function restoreNode(input: {
    workspaceId: string;
    nodeId: string;
    toRoot?: { parentKeyEpoch: number; keyEnvelope: Buffer };
}) {
    return db.transaction(async (tx) => {
        const changeSeq = await nextChangeSeq(tx, input.workspaceId);
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
        const set: Partial<typeof driveNodes.$inferInsert> = {
            trashedAt: null,
            changeSeq,
            updatedAt: new Date(),
        };
        if (parentTrashed) {
            if (!input.toRoot) return { status: 'parent-trashed' as const };
            const root = await walk(tx, chain.rootId);
            if (!root) return { status: 'not-found' as const };
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
        return { status: 'ok' as const, node: node as NodeRow };
    });
}

/* Every node with its own `trashed_at`, newest first, with its chain for context. */
export async function listTrash(input: { workspaceId: string; after?: string; limit?: number }) {
    return db.transaction(async (tx) => {
        const limit = Math.min(input.limit ?? PAGE_SIZE, PAGE_SIZE);
        const ids = await tx
            .select({ id: driveNodes.id, trashedAt: driveNodes.trashedAt })
            .from(driveNodes)
            .where(
                and(
                    eq(driveNodes.workspaceId, input.workspaceId),
                    sql`${driveNodes.trashedAt} is not null`,
                    isNull(driveNodes.purgedAt),
                    input.after ? gt(driveNodes.id, input.after) : undefined,
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
        return { items, nextCursor: ids.length > limit ? page.at(-1)! : null };
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

async function freeBytes(tx: Tx, workspaceId: string) {
    const [storage] = await tx
        .select({
            baseQuotaBytes: workspaceStorage.baseQuotaBytes,
            usedBytes: workspaceStorage.usedBytes,
            reservedBytes: workspaceStorage.reservedBytes,
        })
        .from(workspaceStorage)
        .where(eq(workspaceStorage.workspaceId, workspaceId))
        .for('update');
    if (!storage) return null;
    const grants = await tx
        .select({ quotaBytes: storageEntitlements.quotaBytes })
        .from(storageEntitlements)
        .where(
            and(
                eq(storageEntitlements.workspaceId, workspaceId),
                isNull(storageEntitlements.revokedAt),
                sql`${storageEntitlements.startsAt} <= now()`,
                sql`(${storageEntitlements.expiresAt} is null or ${storageEntitlements.expiresAt} > now())`,
            ),
        );
    const allowance = grants.reduce((sum, grant) => sum + grant.quotaBytes, storage.baseQuotaBytes);
    return {
        allowance,
        used: storage.usedBytes,
        reserved: storage.reservedBytes,
        free: allowance - storage.usedBytes - storage.reservedBytes,
    };
}

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

/* The version envelope's length follows the object's suite: the key alone, or the key with the sizes. */
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
    version: { id: string; contentKeyEnvelope: Buffer };
    /* Suite 2: the sizes are in the envelope, so the row carries only the declared object size. */
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
};

export async function beginUpload(input: UploadBegin) {
    return db.transaction(async (tx) => {
        await nextChangeSeq(tx, input.workspaceId);
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
        const storage = await freeBytes(tx, input.workspaceId);
        if (!storage) return { status: 'not-found' as const };
        if (storage.free < input.object.ciphertextSize)
            return { status: 'over-quota' as const, free: storage.free > 0n ? storage.free : 0n };
        await adjustStorage(tx, input.workspaceId, 0n, input.object.ciphertextSize);
        if (!input.node.existing) {
            const [node] = await tx
                .insert(driveNodes)
                .values({
                    id: input.node.id,
                    workspaceId: input.workspaceId,
                    parentId: input.node.parentId,
                    kind: 'file',
                    ...input.node.envelopes,
                    createdBy: input.userId,
                    changeSeq: null,
                })
                .onConflictDoNothing()
                .returning({ id: driveNodes.id });
            if (!node) return { status: 'conflict' as const };
            void ancestors;
        }
        await tx.insert(driveObjects).values({
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
        });
        await tx.insert(fileVersions).values({
            id: input.version.id,
            nodeId: input.node.id,
            workspaceId: input.workspaceId,
            objectId: input.object.id,
            contentKeyEnvelope: input.version.contentKeyEnvelope,
            status: 'pending',
        });
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
                reservedBytes: input.object.ciphertextSize,
                expiresAt: input.expiresAt,
                status: 'open',
            })
            .returning({ id: driveUploads.id });
        return { status: 'ok' as const, uploadId: upload!.id };
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

/* Step one of complete: open -> completing. A repeat while completing is allowed (a retry). */
export async function startCompleting(workspaceId: string, uploadId: string) {
    return db.transaction(async (tx) => {
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
        .set({ status: 'purged', contentKeyEnvelope: null, purgedAt: new Date() })
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
 * Step three of complete, under the workspace lock. `storedSize` is what the
 * store reports after the multipart upload finished; anything but the reserved
 * size aborts. A precondition that moved leaves the upload `conflicted` with
 * its bytes still reserved and its object in the store, for attach or abort.
 */
export async function finishCompleting(
    workspaceId: string,
    uploadId: string,
    storedSize: bigint | null,
) {
    return db.transaction(async (tx) => {
        const changeSeq = await nextChangeSeq(tx, workspaceId);
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

        return publishUpload(tx, row, chain.ancestors, node.currentVersionId, changeSeq);
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
                .set({ status: 'purged', contentKeyEnvelope: null, purgedAt: now })
                .where(eq(fileVersions.id, version.id));
            await adjustStorage(tx, row.workspaceId, -version.size, 0n);
            if (version.objectId) await retireObjectIfUnreferenced(tx, version.objectId);
        }
        await tx
            .update(fileVersions)
            .set({ supersededAt: now })
            .where(eq(fileVersions.id, displacedId));
    }
    const [published] = await tx
        .update(driveNodes)
        .set({ currentVersionId: row.versionId, changeSeq, updatedAt: now })
        .where(eq(driveNodes.id, row.nodeId))
        .returning(nodeColumns);
    if (row.newNode) await raiseHeightBounds(tx, ancestors, 0);
    await tx
        .update(driveUploads)
        .set({ status: 'completed', reservedBytes: 0n })
        .where(eq(driveUploads.id, row.id));
    const [withVersion] = await selectNodes(tx, [row.nodeId]);
    return {
        status: 'published' as const,
        node: withVersion ?? (published as NodeRow),
        displacedVersionId: displacedId,
    };
}

export type AttachInput =
    | { mode: 'same-node'; keyEpoch: number; contentKeyEnvelope: Buffer }
    | {
          mode: 'sibling';
          userId: string;
          node: {
              id: string;
              parentId: string;
              keyEpoch: number;
              parentKeyEpoch: number;
              keyEnvelope: Buffer;
              metadataEnvelope: Buffer;
          };
          contentKeyEnvelope: Buffer;
      };

/*
 * Attach: a `conflicted` upload's finished object is published under fresh keys
 * without a second upload, because the content's associated data names the
 * object and not the node. Same node for an epoch race, which still requires
 * the version precondition begin recorded; a new sibling for a version race,
 * which overwrites nothing. Every envelope's epoch is checked against the tree as
 * it is now, never against what begin saw.
 */
export async function attachUpload(workspaceId: string, uploadId: string, input: AttachInput) {
    return db.transaction(async (tx) => {
        const changeSeq = await nextChangeSeq(tx, workspaceId);
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

        if (input.mode === 'same-node') {
            const chain = await walk(tx, row.nodeId);
            if (!chain || chain.purged) {
                await releaseUpload(tx, row, 'aborted');
                return { status: 'purged' as const };
            }
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
                .set({ contentKeyEnvelope: input.contentKeyEnvelope })
                .where(eq(fileVersions.id, row.versionId));
            await tx
                .update(driveUploads)
                .set({ keyEpoch: input.keyEpoch })
                .where(eq(driveUploads.id, uploadId));
            return publishUpload(
                tx,
                { ...row, keyEpoch: input.keyEpoch },
                chain.ancestors,
                node.currentVersionId,
                changeSeq,
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
            .set({ nodeId: input.node.id, contentKeyEnvelope: input.contentKeyEnvelope })
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
        return publishUpload(
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

/* Storage figures for a workspace, for the UI and the audit job. */
export async function getStorage(workspaceId: string) {
    return db.transaction((tx) => freeBytes(tx, workspaceId));
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
        const version = row.version as VersionRow;
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
        const out: { version: VersionRow; objectKey: string }[] = [];
        for (const row of rows) {
            const version = row.version as VersionRow;
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
    version: { id: string; contentKeyEnvelope: Buffer };
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
    return db.transaction(async (tx) => {
        const changeSeq = await nextChangeSeq(tx, input.workspaceId);
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
        if (parent.depth + 1 > MAX_DEPTH) return { status: 'too-deep' as const };
        if (input.node.envelopes.parentKeyEpoch !== parent.node.key_epoch)
            return { status: 'stale' as const };
        if (!(await epochWasAllocated(tx, input.workspaceId, input.node.envelopes.keyEpoch)))
            return { status: 'stale' as const };
        if (input.version.contentKeyEnvelope.length !== envelopeLengthFor(version.contentSuite))
            return { status: 'invalid' as const };
        const cost = version.ciphertextSize;
        const storage = await freeBytes(tx, input.workspaceId);
        if (!storage) return { status: 'not-found' as const };
        if (storage.free < cost)
            return { status: 'over-quota' as const, free: storage.free > 0n ? storage.free : 0n };
        const now = new Date();
        const [node] = await tx
            .insert(driveNodes)
            .values({
                id: input.node.id,
                workspaceId: input.workspaceId,
                parentId: input.node.parentId,
                kind: 'file',
                ...input.node.envelopes,
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
                ...(row.version as VersionRow),
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
export async function restoreVersion(workspaceId: string, versionId: string) {
    return db.transaction(async (tx) => {
        const changeSeq = await nextChangeSeq(tx, workspaceId);
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
export async function discardVersion(workspaceId: string, versionId: string) {
    return db.transaction(async (tx) => {
        await nextChangeSeq(tx, workspaceId);
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
        .set({ status: 'purged', contentKeyEnvelope: null, purgedAt: new Date() })
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
    const now = new Date();
    await tx
        .update(driveNodes)
        .set({
            purgedAt: now,
            keyEnvelope: null,
            metadataEnvelope: null,
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
export async function purgeNode(input: { workspaceId: string; nodeId: string }) {
    return db.transaction(async (tx) => {
        const changeSeq = await nextChangeSeq(tx, input.workspaceId);
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
export async function emptyTrash(workspaceId: string, limit = 100) {
    const roots = await liveTrashRoots(workspaceId, limit);
    let purged = 0;
    for (const root of roots) {
        const result = await purgeNode({ workspaceId, nodeId: root });
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
 * Authorization is the walk: a member of the workspace owns everything in it;
 * anyone else needs a live share on the node or an ancestor, and the nearest
 * one sets the role. No access and no node are the same answer.
 */
async function accessFor(tx: Tx, userId: string, chain: Walk): Promise<Access | null> {
    const [member] = await tx
        .select({ userId: workspaceKeys.userId })
        .from(workspaceKeys)
        .where(
            and(
                eq(workspaceKeys.workspaceId, chain.node.workspace_id),
                eq(workspaceKeys.userId, userId),
            ),
        );
    if (member) return { role: 'owner', shareId: null, shareRootId: null };
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
 * Shares a node with an account. The envelope must be sealed under the node's
 * current key epoch; a live share to the same person is replaced (a new role
 * or a fresh seal), never duplicated. Refused for a node in the trash.
 */
export async function createShare(input: CreateShare) {
    return db.transaction(async (tx) => {
        await nextChangeSeq(tx, input.workspaceId);
        const chain = await walk(tx, input.nodeId);
        if (!chain || chain.node.workspace_id !== input.workspaceId || chain.purged)
            return { status: 'not-found' as const };
        if (chain.trashed) return { status: 'trashed' as const };
        if (chain.node.key_epoch !== input.keyEpoch) return { status: 'stale' as const };
        if (input.granteeUserId === input.granterUserId) return { status: 'self' as const };
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
            /* 1 for X25519 alone (72 bytes), 2 for the hybrid envelope (1160). */
            suite: sql<number>`case when octet_length(${driveShares.shareEnvelope}) = 72 then 1 else 2 end`,
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
                prevShareEnvelope: driveShares.prevShareEnvelope,
                prevKeyEpoch: driveShares.prevKeyEpoch,
                createdAt: driveShares.createdAt,
                changeSeq: workspaces.changeSeq,
                granter: {
                    id: users.id,
                    name: users.name,
                    email: users.email,
                    encryptionPublicKey: accountIdentities.encryptionPublicKey,
                },
            })
            .from(driveShares)
            .innerJoin(users, eq(users.id, driveShares.granterUserId))
            .innerJoin(accountIdentities, eq(accountIdentities.userId, driveShares.granterUserId))
            .innerJoin(workspaces, eq(workspaces.id, driveShares.workspaceId))
            .where(and(eq(driveShares.granteeUserId, userId), isNull(driveShares.revokedAt)))
            .orderBy(desc(driveShares.createdAt));
        const out: (Omit<(typeof rows)[number], 'nodeId'> & {
            node: NodeRow & { currentVersion: VersionRow | null };
        })[] = [];
        for (const row of rows) {
            const chain = await walk(tx, row.nodeId);
            if (!chain || chain.purged || chain.trashed) continue;
            const [node] = await selectNodes(tx, [row.nodeId]);
            if (!node) continue;
            const { nodeId: _nodeId, ...rest } = row;
            out.push({ ...rest, node });
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
                suite: sql<number>`case when octet_length(${driveShares.shareEnvelope}) = 72 then 1 else 2 end`,
                grantee: { id: users.id, name: users.name, email: users.email },
                // The grantee's served identity, for the owner to check against the pin
                // and re-seal a suite 1 share to a KEM key that appeared since.
                granteeIdentity: {
                    encryptionPublicKey: accountIdentities.encryptionPublicKey,
                    signingPublicKey: accountIdentities.signingPublicKey,
                    kemPublicKey: accountIdentities.kemPublicKey,
                    kemSignature: accountIdentities.kemSignature,
                },
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
 * Replaces a live share's envelope under the node's current key epoch: how a
 * share sealed before the grantee had a KEM key is re-sealed hybrid. Only the
 * granter, only the current epoch (a rotation in flight re-seals on its own),
 * and never a share that is revoked or on a purged node.
 */
export async function resealShare(input: {
    workspaceId: string;
    shareId: string;
    granterUserId: string;
    keyEpoch: number;
    shareEnvelope: Buffer;
}) {
    return db.transaction(async (tx) => {
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

export async function revokeShare(workspaceId: string, shareId: string) {
    const [row] = await db
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
    return row ?? null;
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
        const chain = await walk(tx, input.nodeId);
        if (!chain || chain.node.workspace_id !== input.workspaceId || chain.purged)
            return { status: 'not-found' as const };
        if (chain.trashed) return { status: 'trashed' as const };
        if (chain.node.key_epoch !== input.keyEpoch) return { status: 'stale' as const };
        const [row] = await tx.insert(driveLinks).values(input).onConflictDoNothing().returning();
        if (!row) return { status: 'conflict' as const };
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
        const [row] = await tx
            .update(driveLinks)
            .set({
                ...input.seal,
                ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
            })
            .where(eq(driveLinks.id, link.id))
            .returning(linkColumns);
        return { status: 'ok' as const, link: row! };
    });
}

export async function revokeLink(workspaceId: string, linkId: string) {
    const [row] = await db
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
    return row ?? null;
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

/*
 * A share's feed: the owner's workspace feed filtered to rows whose chain
 * contains the shared node, one walk per row, merged with the share's
 * membership events. Revoked means there is nothing more to say.
 */
export async function listShareChanges(input: {
    shareId: string;
    granteeUserId: string;
    since: number;
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
            ),
        );
    if (!share) return { status: 'not-found' as const };
    if (share.revokedAt) return { status: 'revoked' as const };
    const page = await listChanges({
        workspaceId: share.workspaceId,
        since: input.since,
        limit: input.limit,
    });
    const events = await db
        .select()
        .from(driveShareEvents)
        .where(
            and(
                eq(driveShareEvents.shareId, share.id),
                sql`${driveShareEvents.changeSeq} > ${input.since}`,
                sql`${driveShareEvents.changeSeq} <= ${page.nextCursor}`,
            ),
        );
    const changes: Change[] = await db.transaction(async (tx) => {
        const kept: Change[] = [];
        for (const change of page.changes) {
            if (change.kind === 'tombstone') {
                // A tombstone's chain is gone with it; the grantee learns of it through
                // its parent, which was inside if the node was, or drops it on `left`.
                kept.push(change);
                continue;
            }
            if (change.kind !== 'node') continue;
            const chain = await walk(tx, change.node.id);
            const inside =
                chain !== null &&
                (chain.node.id === share.nodeId ||
                    chain.ancestors.some((a) => a.id === share.nodeId));
            if (inside) kept.push(change);
        }
        return kept;
    });
    for (const event of events)
        changes.push({ kind: event.kind, changeSeq: event.changeSeq, nodeId: event.nodeId });
    changes.sort((a, b) => a.changeSeq - b.changeSeq);
    return {
        status: 'ok' as const,
        changes,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        resync: page.resync,
    };
}

/*
 * Sealed workspace documents: one row per kind, replaced whole. The version a
 * client saw is the precondition; 0 means it saw none and expects to create
 * the row. A stale write returns the current row so the client can merge.
 */
export type DocumentRow = { kind: string; version: number; envelope: Buffer; updatedAt: Date };
export async function getWorkspaceDocument(workspaceId: string, kind: string) {
    const [row] = await db
        .select({
            kind: workspaceDocuments.kind,
            version: workspaceDocuments.version,
            envelope: workspaceDocuments.envelope,
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
}) {
    return db.transaction(async (tx) => {
        const columns = {
            kind: workspaceDocuments.kind,
            version: workspaceDocuments.version,
            envelope: workspaceDocuments.envelope,
            updatedAt: workspaceDocuments.updatedAt,
        };
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
