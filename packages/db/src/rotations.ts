import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from './client';
import {
    activeRotation,
    nextChangeSeq,
    selectNodes,
    walk,
    type NodeRow,
    type Tx,
    type VersionRow,
} from './drive';
import {
    accountIdentities,
    driveLinks,
    driveNodes,
    driveObjects,
    driveRotations,
    driveShares,
    fileVersions,
    workspaces,
} from './schema';

/*
 * Subtree key rotation, as docs/drive-design.md fixes it: one per workspace, a
 * target epoch above every epoch any node ever carried, a work query over the
 * nodes still below it (by their own epoch or the parent epoch they are
 * wrapped under), batches applied parents first with the change sequence as
 * the precondition, previous envelopes kept until the end, and a finish that
 * clears them. The client does the cryptography; nothing here opens a key.
 */

export const ROTATION_BATCH = 200;

export type RotationRow = typeof driveRotations.$inferSelect;

export async function startRotation(input: {
    workspaceId: string;
    nodeId: string;
    startedBy: string | null;
}) {
    return db.transaction(async (tx) => {
        await nextChangeSeq(tx, input.workspaceId);
        const chain = await walk(tx, input.nodeId);
        if (!chain || chain.node.workspace_id !== input.workspaceId || chain.purged)
            return { status: 'not-found' as const };
        const active = await activeRotation(tx, input.workspaceId);
        if (active) return { status: 'active' as const, rotation: active };
        // Drawn inside the transaction: the workspace row is already locked here.
        const [counter] = await tx
            .update(workspaces)
            .set({ keyEpochSeq: sql`${workspaces.keyEpochSeq} + 1` })
            .where(eq(workspaces.id, input.workspaceId))
            .returning({ keyEpochSeq: workspaces.keyEpochSeq });
        if (!counter) return { status: 'not-found' as const };
        const [rotation] = await tx
            .insert(driveRotations)
            .values({
                workspaceId: input.workspaceId,
                nodeId: input.nodeId,
                targetEpoch: counter.keyEpochSeq,
                startedBy: input.startedBy,
            })
            .returning({
                id: driveRotations.id,
                nodeId: driveRotations.nodeId,
                targetEpoch: driveRotations.targetEpoch,
            });
        return { status: 'ok' as const, rotation: rotation! };
    });
}

export async function getRotation(workspaceId: string, nodeId: string) {
    const active = await activeRotation(db, workspaceId);
    return active && active.nodeId === nodeId ? active : null;
}

type SubtreeRow = { id: string; depth: number };

/* Every non-purged node beneath the root, root first, then by depth and id. */
async function subtree(tx: Tx, rootId: string) {
    const result = await tx.execute<SubtreeRow>(sql`
        with recursive tree as (
            select id, 0 as depth from drive_nodes where id = ${rootId}
            union all
            select n.id, t.depth + 1 from drive_nodes n join tree t on n.parent_id = t.id
            where n.purged_at is null and t.depth < 64
        )
        select id, depth from tree
    `);
    return result.rows;
}

export type RotationWorkNode = NodeRow & {
    currentVersion: VersionRow | null;
    depth: number;
    /* Each version with what the worker needs to reseal it in its object's own suite. */
    versions: {
        id: string;
        objectId: string;
        contentKeyEnvelope: Buffer;
        contentSuite: number;
        plaintextSize: bigint | null;
    }[];
    shares: { id: string; granteeUserId: string; granteePublicKey: Buffer }[];
    links: { id: string; hasPassword: boolean; secretEnvelope: Buffer | null }[];
};

/*
 * The nodes the rotation still has to visit: the root while its own epoch is
 * below the target, anything else while its own epoch or the parent epoch it
 * is wrapped under is. Breadth first, so a batch's parents come before its
 * children; `after` continues past a node the client could not apply yet.
 */
export async function listRotationWork(input: {
    workspaceId: string;
    rootId: string;
    targetEpoch: number;
    after?: { depth: number; id: string } | null;
    limit?: number;
}) {
    return db.transaction(async (tx) => {
        const limit = Math.min(input.limit ?? ROTATION_BATCH, ROTATION_BATCH);
        const after = input.after;
        const result = await tx.execute<SubtreeRow>(sql`
            with recursive tree as (
                select id, 0 as depth from drive_nodes
                where id = ${input.rootId} and workspace_id = ${input.workspaceId}
                union all
                select n.id, t.depth + 1 from drive_nodes n join tree t on n.parent_id = t.id
                where n.purged_at is null and t.depth < 64
            )
            select t.id, t.depth from tree t join drive_nodes n on n.id = t.id
            where n.purged_at is null
              and (n.key_epoch < ${input.targetEpoch}
                   or (t.depth > 0 and n.parent_key_epoch < ${input.targetEpoch}))
              ${after ? sql`and (t.depth, n.id) > (${after.depth}, ${after.id}::uuid)` : sql``}
            order by t.depth, n.id
            limit ${limit + 1}
        `);
        const page = result.rows.slice(0, limit);
        const ids = page.map((row) => row.id);
        const nodes = await selectNodes(tx, ids);
        const byId = new Map(nodes.map((node) => [node.id, node]));
        const versions = ids.length
            ? await tx
                  .select({
                      id: fileVersions.id,
                      nodeId: fileVersions.nodeId,
                      objectId: fileVersions.objectId,
                      contentKeyEnvelope: fileVersions.contentKeyEnvelope,
                      contentSuite: driveObjects.contentSuite,
                      plaintextSize: driveObjects.plaintextSize,
                  })
                  .from(fileVersions)
                  .innerJoin(driveObjects, eq(driveObjects.id, fileVersions.objectId))
                  .where(and(inArray(fileVersions.nodeId, ids), eq(fileVersions.status, 'ready')))
            : [];
        const shares = ids.length
            ? await tx
                  .select({
                      id: driveShares.id,
                      nodeId: driveShares.nodeId,
                      granteeUserId: driveShares.granteeUserId,
                      granteePublicKey: accountIdentities.encryptionPublicKey,
                  })
                  .from(driveShares)
                  .innerJoin(
                      accountIdentities,
                      eq(accountIdentities.userId, driveShares.granteeUserId),
                  )
                  .where(and(inArray(driveShares.nodeId, ids), isNull(driveShares.revokedAt)))
            : [];
        const links = ids.length
            ? await tx
                  .select({
                      id: driveLinks.id,
                      nodeId: driveLinks.nodeId,
                      hasPassword: driveLinks.hasPassword,
                      secretEnvelope: driveLinks.secretEnvelope,
                  })
                  .from(driveLinks)
                  .where(and(inArray(driveLinks.nodeId, ids), isNull(driveLinks.revokedAt)))
            : [];
        const out: RotationWorkNode[] = page.flatMap((row) => {
            const node = byId.get(row.id);
            if (!node) return [];
            return [
                {
                    ...node,
                    depth: row.depth,
                    versions: versions
                        .filter((v) => v.nodeId === row.id && v.objectId && v.contentKeyEnvelope)
                        .map((v) => ({
                            id: v.id,
                            objectId: v.objectId!,
                            contentKeyEnvelope: v.contentKeyEnvelope!,
                            contentSuite: v.contentSuite,
                            plaintextSize: v.plaintextSize,
                        })),
                    shares: shares
                        .filter((s) => s.nodeId === row.id)
                        .map((s) => ({
                            id: s.id,
                            granteeUserId: s.granteeUserId,
                            granteePublicKey: s.granteePublicKey,
                        })),
                    links: links
                        .filter((l) => l.nodeId === row.id)
                        .map((l) => ({
                            id: l.id,
                            hasPassword: l.hasPassword,
                            secretEnvelope: l.secretEnvelope,
                        })),
                },
            ];
        });
        const last = page.at(-1);
        return {
            nodes: out,
            nextCursor:
                result.rows.length > limit && last ? { depth: last.depth, id: last.id } : null,
        };
    });
}

export type RotatedNodeInput = {
    id: string;
    changeSeq: number;
    /* The parent's current epoch the new envelope is wrapped under. */
    parentKeyEpoch: number;
    keyEnvelope: Buffer;
    /* Absent for a rewrap: a node already at the target moved under a rotated parent keeps its key. */
    rotated: {
        metadataEnvelope: Buffer;
        versions: { id: string; contentKeyEnvelope: Buffer }[];
        shares: { id: string; shareEnvelope: Buffer }[];
        links: { id: string; linkEnvelope: Buffer; secretEnvelope: Buffer }[];
        /* Links the owner's device could not re-seal: revoked, since nobody could open them anyway. */
        unsealableLinks: string[];
    } | null;
};

export type RotateOutcome = 'ok' | 'stale' | 'not-found' | 'parent-not-ready' | 'already';

/*
 * Applies a batch parents first, each node in its own transaction under the
 * workspace lock: the change sequence must be what the client read, the parent
 * must already be at the target (or be the root's outside parent), and the
 * previous envelope is kept for a rotated node until the rotation finishes.
 */
export async function rotateNodes(input: {
    workspaceId: string;
    rootId: string;
    targetEpoch: number;
    nodes: RotatedNodeInput[];
}) {
    const results: { id: string; status: RotateOutcome }[] = [];
    for (const item of input.nodes) {
        const status = await db.transaction(async (tx): Promise<RotateOutcome> => {
            const changeSeq = await nextChangeSeq(tx, input.workspaceId);
            const rotation = await activeRotation(tx, input.workspaceId);
            if (
                !rotation ||
                rotation.nodeId !== input.rootId ||
                rotation.targetEpoch !== input.targetEpoch
            )
                return 'not-found';
            const [node] = await tx
                .select()
                .from(driveNodes)
                .where(
                    and(eq(driveNodes.id, item.id), eq(driveNodes.workspaceId, input.workspaceId)),
                )
                .for('update');
            if (!node || node.purgedAt) return 'not-found';
            if (node.changeSeq !== item.changeSeq) return 'stale';
            const root = item.id === input.rootId;
            if (!root) {
                const [parent] = await tx
                    .select({ keyEpoch: driveNodes.keyEpoch })
                    .from(driveNodes)
                    .where(eq(driveNodes.id, node.parentId!));
                if (!parent || parent.keyEpoch < input.targetEpoch) return 'parent-not-ready';
                if (parent.keyEpoch !== item.parentKeyEpoch) return 'stale';
            } else if (node.parentId) {
                const [parent] = await tx
                    .select({ keyEpoch: driveNodes.keyEpoch })
                    .from(driveNodes)
                    .where(eq(driveNodes.id, node.parentId));
                if (!parent || parent.keyEpoch !== item.parentKeyEpoch) return 'stale';
            }
            const rewrap = node.keyEpoch >= input.targetEpoch;
            if (rewrap !== (item.rotated === null)) return 'stale';
            if (rewrap && node.parentKeyEpoch >= input.targetEpoch) return 'already';
            const now = new Date();
            if (rewrap) {
                await tx
                    .update(driveNodes)
                    .set({
                        keyEnvelope: item.keyEnvelope,
                        parentKeyEpoch: item.parentKeyEpoch,
                        changeSeq,
                        updatedAt: now,
                    })
                    .where(eq(driveNodes.id, item.id));
                return 'ok';
            }
            const rotated = item.rotated!;
            await tx
                .update(driveNodes)
                .set({
                    // The first rotation of this node keeps its old envelope; a re-rotation
                    // within the same run (never expected) would keep the oldest one.
                    prevKeyEnvelope: node.prevKeyEnvelope ?? node.keyEnvelope,
                    prevKeyEpoch: node.prevKeyEpoch ?? node.keyEpoch,
                    prevParentKeyEpoch: node.prevParentKeyEpoch ?? node.parentKeyEpoch,
                    keyEnvelope: item.keyEnvelope,
                    keyEpoch: input.targetEpoch,
                    parentKeyEpoch: item.parentKeyEpoch,
                    metadataEnvelope: rotated.metadataEnvelope,
                    changeSeq,
                    updatedAt: now,
                })
                .where(eq(driveNodes.id, item.id));
            for (const version of rotated.versions)
                await tx
                    .update(fileVersions)
                    .set({ contentKeyEnvelope: version.contentKeyEnvelope })
                    .where(and(eq(fileVersions.id, version.id), eq(fileVersions.nodeId, item.id)));
            for (const share of rotated.shares)
                await tx
                    .update(driveShares)
                    .set({
                        prevShareEnvelope: sql`coalesce(${driveShares.prevShareEnvelope}, ${driveShares.shareEnvelope})`,
                        prevKeyEpoch: sql`coalesce(${driveShares.prevKeyEpoch}, ${driveShares.keyEpoch})`,
                        shareEnvelope: share.shareEnvelope,
                        keyEpoch: input.targetEpoch,
                        updatedAt: now,
                    })
                    .where(
                        and(
                            eq(driveShares.id, share.id),
                            eq(driveShares.nodeId, item.id),
                            isNull(driveShares.revokedAt),
                        ),
                    );
            for (const link of rotated.links)
                await tx
                    .update(driveLinks)
                    .set({
                        linkEnvelope: link.linkEnvelope,
                        secretEnvelope: link.secretEnvelope,
                        keyEpoch: input.targetEpoch,
                    })
                    .where(and(eq(driveLinks.id, link.id), eq(driveLinks.nodeId, item.id)));
            if (rotated.unsealableLinks.length)
                await tx
                    .update(driveLinks)
                    .set({ revokedAt: now })
                    .where(
                        and(
                            inArray(driveLinks.id, rotated.unsealableLinks),
                            eq(driveLinks.nodeId, item.id),
                            isNull(driveLinks.revokedAt),
                        ),
                    );
            // Anything still sealed under the old key that the client did not re-seal is dead: revoke it.
            await tx
                .update(driveShares)
                .set({ revokedAt: now, updatedAt: now })
                .where(
                    and(
                        eq(driveShares.nodeId, item.id),
                        isNull(driveShares.revokedAt),
                        sql`${driveShares.keyEpoch} < ${input.targetEpoch}`,
                    ),
                );
            await tx
                .update(driveLinks)
                .set({ revokedAt: now })
                .where(
                    and(
                        eq(driveLinks.nodeId, item.id),
                        isNull(driveLinks.revokedAt),
                        sql`${driveLinks.keyEpoch} < ${input.targetEpoch}`,
                    ),
                );
            return 'ok';
        });
        results.push({ id: item.id, status });
    }
    return results;
}

/*
 * Finishes when nothing is left to visit: previous envelopes and grants go,
 * the row is closed. Returns false while work remains.
 */
export async function finishRotation(input: {
    workspaceId: string;
    rootId: string;
    targetEpoch: number;
}) {
    const remaining = await listRotationWork({ ...input, limit: 1 });
    if (remaining.nodes.length) return false;
    return db.transaction(async (tx) => {
        await nextChangeSeq(tx, input.workspaceId);
        const rotation = await activeRotation(tx, input.workspaceId);
        if (!rotation || rotation.nodeId !== input.rootId) return false;
        const ids = (await subtree(tx, input.rootId)).map((row) => row.id);
        for (let at = 0; at < ids.length; at += 1000) {
            const slice = ids.slice(at, at + 1000);
            await tx
                .update(driveNodes)
                .set({ prevKeyEnvelope: null, prevKeyEpoch: null, prevParentKeyEpoch: null })
                .where(inArray(driveNodes.id, slice));
            await tx
                .update(driveShares)
                .set({ prevShareEnvelope: null, prevKeyEpoch: null })
                .where(inArray(driveShares.nodeId, slice));
        }
        await tx
            .update(driveRotations)
            .set({ finishedAt: new Date() })
            .where(eq(driveRotations.id, rotation.id));
        return true;
    });
}
