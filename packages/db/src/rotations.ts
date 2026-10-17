import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from './client';
import {
    LINK_KDF_VERSION,
    SHARE_ENVELOPE_BYTES,
    activeRotation,
    currentSigningKey,
    nextChangeSeq,
    selectNodes,
    signerOf,
    walk,
    type NodeRow,
    type Signer,
    type SignedStatement,
    type Tx,
    type VersionRow,
} from './drive';
import { rekeyedFor } from '@hushos/crypto/rekeyed-scope';
import { grantedByMember } from './membership';
import {
    metadataRekeyedStatement,
    metadataSigned,
    signedForm,
    verifySignature,
    versionRekeyedStatement,
    versionSigned,
    type RecordOriginInput,
} from './signatures';
import {
    accountIdentities,
    driveLinks,
    driveNodes,
    driveObjects,
    driveOriginDrops,
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

export type StartRotationInput = {
    workspaceId: string;
    nodeId: string;
    startedBy: string | null;
    /*
     * A target the caller drew itself (allocateKeyEpochs) so it could seal the
     * root's new key under it before starting: a group area's rotation re-keys
     * the root in the same transaction. It must be allocated and above every
     * epoch any node in the workspace carries. Without it, one is drawn here.
     */
    targetEpoch?: number;
    /* Started by a roster's rotation (groups.ts): a hold on the uploader does not apply. */
    byRoster?: boolean;
};
export async function startRotation(input: StartRotationInput) {
    return db.transaction((tx) => startRotationIn(tx, input));
}

export async function startRotationIn(tx: Tx, input: StartRotationInput) {
    await nextChangeSeq(tx, input.workspaceId, input.startedBy ?? undefined, {
        roster: input.byRoster,
    });
    const chain = await walk(tx, input.nodeId);
    if (!chain || chain.node.workspace_id !== input.workspaceId || chain.purged)
        return { status: 'not-found' as const };
    const active = await activeRotation(tx, input.workspaceId);
    if (active) return { status: 'active' as const, rotation: active };
    let targetEpoch: number;
    if (input.targetEpoch === undefined) {
        // Drawn inside the transaction: the workspace row is already locked here.
        const [counter] = await tx
            .update(workspaces)
            .set({ keyEpochSeq: sql`${workspaces.keyEpochSeq} + 1` })
            .where(eq(workspaces.id, input.workspaceId))
            .returning({ keyEpochSeq: workspaces.keyEpochSeq });
        if (!counter) return { status: 'not-found' as const };
        targetEpoch = counter.keyEpochSeq;
    } else {
        const [bounds] = await tx
            .select({
                allocated: workspaces.keyEpochSeq,
                carried:
                    sql<number>`(select coalesce(max(greatest(${driveNodes.keyEpoch}, coalesce(${driveNodes.prevKeyEpoch}, 0))), 0) from ${driveNodes} where ${driveNodes.workspaceId} = ${input.workspaceId})`.mapWith(
                        Number,
                    ),
            })
            .from(workspaces)
            .where(eq(workspaces.id, input.workspaceId));
        if (!bounds || input.targetEpoch > bounds.allocated || input.targetEpoch <= bounds.carried)
            return { status: 'stale' as const };
        targetEpoch = input.targetEpoch;
    }
    const [rotation] = await tx
        .insert(driveRotations)
        .values({
            workspaceId: input.workspaceId,
            nodeId: input.nodeId,
            targetEpoch,
            startedBy: input.startedBy,
        })
        .returning({
            id: driveRotations.id,
            nodeId: driveRotations.nodeId,
            targetEpoch: driveRotations.targetEpoch,
        });
    return { status: 'ok' as const, rotation: rotation! };
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
        /* Who signed the envelope being replaced, so the client knows what it re-signs. */
        signer: Signer | null;
        signature: Buffer | null;
        /* The origin an earlier rotation kept, which the next one carries (see fileVersions). */
        originEnvelope: Buffer | null;
        originKeyEnvelope: Buffer | null;
        originSignerId: string | null;
        originSignature: Buffer | null;
        rekeySignature: Buffer | null;
    }[];
    shares: {
        id: string;
        granteeUserId: string;
        granteePublicKey: Buffer;
        granteeSigningPublicKey: Buffer;
        granteeMlDsaPublicKey: Buffer | null;
        granteeKemPublicKey: Buffer | null;
        granteeKeysSignature: Buffer | null;
        granteeKeyVersion: number;
        granteeIdentityVersion: number;
    }[];
    links: { id: string; hasPassword: boolean; secretEnvelope: Buffer | null }[];
};

/*
 * Each node with everything sealed under its key, as the rotation re-seals it:
 * its ready versions, its live shares with the grantee's identity, and its live
 * links, leaving out any share or link whose granter has left the group (the
 * rotation revokes those as unsealed). Rows in `page` order.
 */
async function workNodes(tx: Tx, page: SubtreeRow[]): Promise<RotationWorkNode[]> {
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
                  signerId: fileVersions.signerId,
                  signature: fileVersions.signature,
                  originEnvelope: fileVersions.originEnvelope,
                  originKeyEnvelope: fileVersions.originKeyEnvelope,
                  originSignerId: fileVersions.originSignerId,
                  originSignature: fileVersions.originSignature,
                  rekeySignature: fileVersions.rekeySignature,
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
                  granteeSigningPublicKey: accountIdentities.signingPublicKey,
                  granteeMlDsaPublicKey: accountIdentities.mlDsaPublicKey,
                  granteeKemPublicKey: accountIdentities.kemPublicKey,
                  granteeKeysSignature: accountIdentities.keysSignature,
                  granteeKeyVersion: accountIdentities.keyVersion,
                  granteeIdentityVersion: accountIdentities.version,
              })
              .from(driveShares)
              .innerJoin(accountIdentities, eq(accountIdentities.userId, driveShares.granteeUserId))
              .where(
                  and(
                      inArray(driveShares.nodeId, ids),
                      isNull(driveShares.revokedAt),
                      // A departed member's share is not handed on: unsealed, rotateNodeIn revokes it.
                      grantedByMember(driveShares.granterUserId, driveShares.workspaceId),
                  ),
              )
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
              .where(
                  and(
                      inArray(driveLinks.nodeId, ids),
                      isNull(driveLinks.revokedAt),
                      grantedByMember(driveLinks.granterUserId, driveLinks.workspaceId),
                  ),
              )
        : [];
    return page.flatMap<RotationWorkNode>((row) => {
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
                        signer: signerOf(v.signerId),
                        signature: v.signature,
                        originEnvelope: v.originEnvelope,
                        originKeyEnvelope: v.originKeyEnvelope,
                        originSignerId: v.originSignerId,
                        originSignature: v.originSignature,
                        rekeySignature: v.rekeySignature,
                    })),
                shares: shares
                    .filter((s) => s.nodeId === row.id)
                    .map((s) => ({
                        id: s.id,
                        granteeUserId: s.granteeUserId,
                        granteePublicKey: s.granteePublicKey,
                        granteeSigningPublicKey: s.granteeSigningPublicKey,
                        granteeMlDsaPublicKey: s.granteeMlDsaPublicKey,
                        granteeKemPublicKey: s.granteeKemPublicKey,
                        granteeKeysSignature: s.granteeKeysSignature,
                        granteeKeyVersion: s.granteeKeyVersion,
                        granteeIdentityVersion: s.granteeIdentityVersion,
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
}

/*
 * A workspace's top-level root as a rotation re-seals it, whether or not a
 * rotation runs: what a group area's roster rotation (route 24, or a family
 * removal) re-keys in its own transaction, read before any Drive rotation
 * exists to list it. Null when the workspace has no root.
 */
export async function rootWorkIn(tx: Tx, workspaceId: string) {
    const [root] = await tx
        .select({ id: driveNodes.id })
        .from(driveNodes)
        .where(
            and(
                eq(driveNodes.workspaceId, workspaceId),
                isNull(driveNodes.parentId),
                isNull(driveNodes.purgedAt),
            ),
        );
    if (!root) return null;
    const [node] = await workNodes(tx, [{ id: root.id, depth: 0 }]);
    return node ?? null;
}

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
        const last = page.at(-1);
        return {
            nodes: await workNodes(tx, page),
            nextCursor:
                result.rows.length > limit && last ? { depth: last.depth, id: last.id } : null,
        };
    });
}

/*
 * A re-keyed record's part of a rotation (docs/integrity-design.md, "Re-keyed
 * records"): the origin's opening key wrapped under the new node key, and the
 * rotating account's signature over the rekeyed statement. The origin itself
 * is never the client's: the server copies it from the row.
 */
export type RekeyInput = { originKeyEnvelope: Buffer; signature: Buffer };
/*
 * How one record of a rotated node is signed: the re-keyed form (`rekey`),
 * with or without a legacy signature beside it for readers that do not know
 * that form yet, or the legacy signature alone. `dropOrigin` says a legacy
 * re-seal means to drop the origin the row carries (the rotating client found
 * it unbound, or its signer gone); without it such a re-seal is refused, since
 * it is what a client that does not know origins sends.
 */
export type RotatedRecordSignatures = {
    signature: Buffer | null;
    rekey?: RekeyInput | null;
    dropOrigin?: boolean;
};

export type RotatedNodeInput = {
    id: string;
    changeSeq: number;
    /* The parent's current epoch the new envelope is wrapped under. */
    parentKeyEpoch: number;
    keyEnvelope: Buffer;
    /*
     * Absent for a rewrap: a node already at the target moved under a rotated parent keeps its key.
     * A rotated node's re-sealed metadata and versions carry the signatures of the account rotating.
     */
    rotated: {
        metadataEnvelope: Buffer;
        metadataSignature: Buffer | null;
        metadataRekey?: RekeyInput | null;
        metadataDropOrigin?: boolean;
        versions: ({ id: string; contentKeyEnvelope: Buffer } & RotatedRecordSignatures)[];
        shares: { id: string; shareEnvelope: Buffer }[];
        links: { id: string; linkEnvelope: Buffer; secretEnvelope: Buffer }[];
        /* Links the owner's device could not re-seal: revoked, since nobody could open them anyway. */
        unsealableLinks: string[];
    } | null;
};

/*
 * `unsupported`: a record signed in a form the server does not take there (a
 * legacy re-seal of a row that carries an origin, a re-key of a row with
 * nothing to keep, or in a group's area anything that would claim authorship).
 */
export type RotateOutcome =
    | 'ok'
    | 'stale'
    | 'not-found'
    | 'parent-not-ready'
    | 'already'
    | 'bad-signature'
    | 'unsupported'
    /* A group area's top folder, which only its roster re-keys (docs/groups-design.md 2.10). */
    | 'forbidden';

/* A record as the row holds it now: its envelope's signer and signature, and any origin kept. */
type StoredRecord = {
    envelope: Buffer | null;
    signerId: string | null;
    signature: Buffer | null;
    originEnvelope: Buffer | null;
    originSignerId: string | null;
    originSignature: Buffer | null;
    /* The kept origin's wrap and the binding its re-keyer (`signerId`) signed: a drop's evidence. */
    originKeyEnvelope?: Buffer | null;
    rekeySignature?: Buffer | null;
};
/* What one checked record writes: its signer and legacy signature, and its origin columns. */
export type SignedRecord = {
    signature: Buffer | null;
    origin: {
        envelope: Buffer;
        signerId: string;
        signature: Buffer;
        keyEnvelope: Buffer;
        rekeySignature: Buffer;
    } | null;
    /*
     * The kept origin a legacy re-seal dropped (dropOrigin), recorded whole as evidence, with
     * the envelope the previous re-keyer sealed over it: their statement covers both.
     */
    dropped: {
        envelope: Buffer;
        signerId: string;
        signature: Buffer;
        keyEnvelope: Buffer;
        rekeySignature: Buffer;
        previousRekeyerId: string | null;
        previousEnvelope: Buffer;
    } | null;
};

/*
 * One re-sealed record against the rules (docs/integrity-design.md, "What the
 * server enforces"), before anything is written:
 * - a re-keyed record's origin is the row's: the origin it already carries,
 *   else its current envelope, signer and signature, read under the rotation's
 *   change sequence precondition; never one the client sent. A record with no
 *   signature or no signer has nothing to keep and is refused re-keyed;
 * - the rekeyed statement is built from that origin, the submitted envelope
 *   and wrapped key and the target epoch, and verified under the rotating
 *   account's current key;
 * - a legacy signature beside it holds in any form, but claims authorship
 *   (ordinary or saved) only over the rotating account's own origin, in the
 *   very form that origin is signed in under the rotating account's key (a
 *   re-sealed origin never comes back ordinary), and in a group's area never;
 * - a legacy signature alone, on a row that carries an origin, only with
 *   `dropOrigin` and only re-sealed (decision D9); in a group's area only
 *   re-sealed, and only for a record there is no writer's signature to keep.
 * Outside the re-keyed scope (`inScope` false: rekeyedFor, personal
 * workspaces until native clients read origins) a re-key is refused and the
 * legacy form is taken exactly as before, writing no origin.
 */
export function checkRotatedRecord(input: {
    stored: StoredRecord;
    sent: RotatedRecordSignatures;
    key: Uint8Array;
    rotator: string;
    inScope: boolean;
    group: boolean;
    /* The writer statements over an envelope, in the three forms (metadataSigned, versionSigned). */
    legacy: (envelope: Buffer, signature: Buffer) => SignedStatement;
    /* The submitted envelope, as `legacy` takes it. */
    envelope: Buffer;
    rekeyed: (origin: RecordOriginInput) => Buffer;
}): SignedRecord | 'bad-signature' | 'unsupported' {
    const { stored, sent, key, rotator, group } = input;
    const legacyForm = sent.signature
        ? signedForm(key, input.legacy(input.envelope, sent.signature))
        : null;
    if (sent.signature && legacyForm === null) return 'bad-signature';
    // Personal workspaces, for now: what shipped clients write, and nothing that leaves an origin.
    if (!input.inScope) {
        if (sent.rekey) return 'unsupported';
        if (!sent.signature || legacyForm === null) return 'bad-signature';
        return { signature: sent.signature, origin: null, dropped: null };
    }
    const kept =
        stored.originEnvelope && stored.originSignature
            ? {
                  envelope: stored.originEnvelope,
                  signerId: stored.originSignerId,
                  signature: stored.originSignature,
              }
            : null;
    if (sent.rekey) {
        if (sent.dropOrigin) return 'unsupported';
        const origin =
            kept ??
            (stored.envelope && stored.signature
                ? {
                      envelope: stored.envelope,
                      signerId: stored.signerId,
                      signature: stored.signature,
                  }
                : null);
        // Unsigned, or its writer no longer named: nothing to keep (decision D6), re-sealed instead.
        if (!origin || !origin.signerId) return 'unsupported';
        const full = {
            ...origin,
            signerId: origin.signerId,
            keyEnvelope: sent.rekey.originKeyEnvelope,
        };
        if (!verifySignature(key, input.rekeyed(full), sent.rekey.signature))
            return 'bad-signature';
        if (legacyForm !== null && legacyForm !== 'resealed') {
            if (group || origin.signerId.toLowerCase() !== rotator.toLowerCase())
                return 'unsupported';
            // Only the form the rotator's own origin holds in: never more than it signed.
            if (signedForm(key, input.legacy(origin.envelope, origin.signature)) !== legacyForm)
                return 'unsupported';
        }
        return {
            signature: sent.signature,
            origin: { ...full, rekeySignature: sent.rekey.signature },
            dropped: null,
        };
    }
    if (!sent.signature || legacyForm === null) return 'bad-signature';
    if (kept && (!sent.dropOrigin || legacyForm !== 'resealed')) return 'unsupported';
    if (group) {
        if (legacyForm !== 'resealed') return 'unsupported';
        // A signed record with a named writer is kept, never re-signed in the walker's name.
        if (!kept && stored.signature && stored.signerId) return 'unsupported';
    }
    return {
        signature: sent.signature,
        origin: null,
        // The server cannot check binding, so a drop leaves a trace of whose signature went.
        dropped:
            kept &&
            kept.signerId &&
            stored.originKeyEnvelope &&
            stored.rekeySignature &&
            stored.envelope
                ? {
                      envelope: kept.envelope,
                      signerId: kept.signerId,
                      signature: kept.signature,
                      keyEnvelope: stored.originKeyEnvelope,
                      rekeySignature: stored.rekeySignature,
                      previousRekeyerId: stored.signerId,
                      previousEnvelope: stored.envelope,
                  }
                : null,
    };
}

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
    /* The account rotating: every re-sealed envelope must carry its signature. */
    userId: string;
    nodes: RotatedNodeInput[];
    /*
     * The roster's own re-key of a group area's root (applyRotation does it in the roster's
     * transaction; tests stand in for it here). The Drive routes never set it, so no batch
     * re-keys or re-wraps a family folder's top folder.
     */
    byRoster?: boolean;
}) {
    const results: { id: string; status: RotateOutcome }[] = [];
    for (const item of input.nodes) {
        const status = await db.transaction((tx) => rotateNodeIn(tx, input, item));
        results.push({ id: item.id, status });
    }
    return results;
}

/*
 * One node of a rotation batch inside a caller's transaction: what rotateNodes
 * does per node, and what a group area's rotation does for the root in the
 * transaction that bumps the area's key version.
 */
export async function rotateNodeIn(
    tx: Tx,
    input: {
        workspaceId: string;
        rootId: string;
        targetEpoch: number;
        userId: string;
        /* The roster's own re-key of an area root: a hold on the uploader does not apply. */
        byRoster?: boolean;
    },
    item: RotatedNodeInput,
): Promise<RotateOutcome> {
    const changeSeq = await nextChangeSeq(tx, input.workspaceId, input.userId, {
        roster: input.byRoster,
    });
    const rotation = await activeRotation(tx, input.workspaceId);
    if (!rotation || rotation.nodeId !== input.rootId || rotation.targetEpoch !== input.targetEpoch)
        return 'not-found';
    const [node] = await tx
        .select()
        .from(driveNodes)
        .where(and(eq(driveNodes.id, item.id), eq(driveNodes.workspaceId, input.workspaceId)))
        .for('update');
    if (!node || node.purgedAt) return 'not-found';
    if (node.changeSeq !== item.changeSeq) return 'stale';
    const root = item.id === input.rootId;
    // Whose area this is: a group's takes no rotation that claims authorship (decision D3).
    const [workspace] = await tx
        .select({ ownerKind: workspaces.ownerKind, version: workspaces.workspaceKeyVersion })
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId));
    const group = workspace?.ownerKind === 'group';
    // The one switch for where records are re-keyed (personal workspaces wait for native).
    const inScope = rekeyedFor({ ownerKind: group ? 'group' : 'personal' });
    if (!root) {
        const [parent] = await tx
            .select({ keyEpoch: driveNodes.keyEpoch })
            .from(driveNodes)
            .where(eq(driveNodes.id, node.parentId!));
        if (!parent || parent.keyEpoch < input.targetEpoch) return 'parent-not-ready';
        if (parent.keyEpoch !== item.parentKeyEpoch) return 'stale';
    } else if (!node.parentId) {
        // A group area's root is re-keyed or re-wrapped only by the roster that commits to its
        // key (applyRotation, docs/groups-design.md 2.10), never by a Drive batch, even during
        // the walk that roster started: its epoch and its area version are different counters,
        // so no "already" check below can tell a re-wrap of it apart.
        if (group && !input.byRoster) return 'forbidden';
        // Wrapped under the area's key at its current version: only a roster moves that version
        // (applyRotation bumps it first).
        if (group && item.parentKeyEpoch !== workspace.version) return 'stale';
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
                // A new change sequence so devices sync, but not a new updated time:
                // rotating keys is not a change anyone made to the item.
                changeSeq,
            })
            .where(eq(driveNodes.id, item.id));
        return 'ok';
    }
    const rotated = item.rotated!;
    // Exactly the node's ready versions, each once, as the work listed them: one left out
    // would stay sealed under the old key, which nobody can reach once the rotation
    // finishes, and one that is not ready (discarded since the read, which does not move
    // the node's change sequence) cannot be stored. Either way the client re-reads.
    const ready = await tx
        .select({
            id: fileVersions.id,
            objectId: fileVersions.objectId,
            contentSuite: driveObjects.contentSuite,
            envelope: fileVersions.contentKeyEnvelope,
            signerId: fileVersions.signerId,
            signature: fileVersions.signature,
            originEnvelope: fileVersions.originEnvelope,
            originSignerId: fileVersions.originSignerId,
            originSignature: fileVersions.originSignature,
            originKeyEnvelope: fileVersions.originKeyEnvelope,
            rekeySignature: fileVersions.rekeySignature,
            droppedSignerId: fileVersions.droppedSignerId,
            originDroppedBy: fileVersions.originDroppedBy,
        })
        .from(fileVersions)
        .innerJoin(driveObjects, eq(driveObjects.id, fileVersions.objectId))
        .where(and(eq(fileVersions.nodeId, item.id), eq(fileVersions.status, 'ready')));
    const submitted = new Set(rotated.versions.map((v) => v.id));
    if (
        submitted.size !== rotated.versions.length ||
        submitted.size !== ready.length ||
        ready.some((row) => !submitted.has(row.id))
    )
        return 'stale';
    const key = await currentSigningKey(tx, input.userId);
    if (!key) return 'bad-signature';
    // Every record is checked before anything is written. Signed over what is stored: the
    // node's kind and unchanged metadata version, each version's own object and suite, and
    // the epoch the rotation moves the node to.
    const metadataFields = {
        workspaceId: input.workspaceId,
        nodeId: item.id,
        kind: node.kind,
        metadataVersion: node.metadataVersion,
        metadataEnvelope: rotated.metadataEnvelope,
    };
    const metadata = checkRotatedRecord({
        stored: {
            envelope: node.metadataEnvelope,
            signerId: node.metadataSignerId,
            signature: node.metadataSignature,
            originEnvelope: node.metadataOriginEnvelope,
            originSignerId: node.metadataOriginSignerId,
            originSignature: node.metadataOriginSignature,
            originKeyEnvelope: node.metadataOriginKeyEnvelope,
            rekeySignature: node.metadataRekeySignature,
        },
        sent: {
            signature: rotated.metadataSignature,
            rekey: rotated.metadataRekey,
            dropOrigin: rotated.metadataDropOrigin,
        },
        key,
        rotator: input.userId,
        inScope,
        group,
        legacy: (envelope, signature) =>
            metadataSigned({ ...metadataFields, metadataEnvelope: envelope }, signature),
        envelope: rotated.metadataEnvelope,
        rekeyed: (origin) =>
            metadataRekeyedStatement({ ...metadataFields, keyEpoch: input.targetEpoch }, origin),
    });
    if (typeof metadata === 'string') return metadata;
    const versions: {
        id: string;
        contentKeyEnvelope: Buffer;
        signed: SignedRecord;
        row: (typeof ready)[number];
    }[] = [];
    for (const version of rotated.versions) {
        const row = ready.find((v) => v.id === version.id)!;
        const fields = {
            workspaceId: input.workspaceId,
            nodeId: item.id,
            versionId: version.id,
            objectId: row.objectId!,
            contentSuite: row.contentSuite,
            contentKeyEnvelope: version.contentKeyEnvelope,
        };
        const signed = checkRotatedRecord({
            stored: row,
            sent: version,
            key,
            rotator: input.userId,
            inScope,
            group,
            legacy: (envelope, signature) =>
                versionSigned({ ...fields, contentKeyEnvelope: envelope }, signature),
            envelope: version.contentKeyEnvelope,
            rekeyed: (origin) =>
                versionRekeyedStatement({ ...fields, keyEpoch: input.targetEpoch }, origin),
        });
        if (typeof signed === 'string') return signed;
        versions.push({
            id: version.id,
            contentKeyEnvelope: version.contentKeyEnvelope,
            signed,
            row,
        });
    }
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
            // The account rotating sealed the envelope: the re-keyer, whatever else it signed.
            metadataSignerId: input.userId,
            metadataSignature: metadata.signature,
            metadataOriginEnvelope: metadata.origin?.envelope ?? null,
            metadataOriginKeyEnvelope: metadata.origin?.keyEnvelope ?? null,
            metadataOriginSignerId: metadata.origin?.signerId ?? null,
            metadataOriginSignature: metadata.origin?.signature ?? null,
            metadataRekeySignature: metadata.origin?.rekeySignature ?? null,
            // A drop's trace stays with the record until it is purged: the first one counts.
            ...(metadata.dropped && !node.metadataDroppedSignerId
                ? {
                      metadataDroppedSignerId: metadata.dropped.signerId,
                      metadataOriginDroppedBy: input.userId,
                  }
                : {}),
            changeSeq,
        })
        .where(eq(driveNodes.id, item.id));
    for (const version of versions)
        await tx
            .update(fileVersions)
            .set({
                contentKeyEnvelope: version.contentKeyEnvelope,
                signerId: input.userId,
                signature: version.signed.signature,
                originEnvelope: version.signed.origin?.envelope ?? null,
                originKeyEnvelope: version.signed.origin?.keyEnvelope ?? null,
                originSignerId: version.signed.origin?.signerId ?? null,
                originSignature: version.signed.origin?.signature ?? null,
                rekeySignature: version.signed.origin?.rekeySignature ?? null,
                ...(version.signed.dropped && !version.row.droppedSignerId
                    ? {
                          droppedSignerId: version.signed.dropped.signerId,
                          originDroppedBy: input.userId,
                      }
                    : {}),
            })
            .where(and(eq(fileVersions.id, version.id), eq(fileVersions.nodeId, item.id)));
    // Every drop, as evidence that outlives the record: whose signature, which, who, when, and
    // every field of the previous re-keyer's statement that this rotation overwrites or a purge
    // takes (the envelope they sealed, its epoch, the node's kind or the version's object and
    // suite), so the row alone rebuilds that statement (docs/integrity-design.md).
    const drops = [
        ...(metadata.dropped
            ? [
                  {
                      dropped: metadata.dropped,
                      metadataVersion: node.metadataVersion,
                      nodeKind: node.kind,
                      versionId: null,
                      objectId: null,
                      contentSuite: null,
                  },
              ]
            : []),
        ...versions.flatMap((version) =>
            version.signed.dropped
                ? [
                      {
                          dropped: version.signed.dropped,
                          metadataVersion: null,
                          nodeKind: null,
                          versionId: version.id,
                          objectId: version.row.objectId,
                          contentSuite: version.row.contentSuite,
                      },
                  ]
                : [],
        ),
    ];
    if (drops.length)
        await tx.insert(driveOriginDrops).values(
            drops.map((drop) => ({
                workspaceId: input.workspaceId,
                nodeId: item.id,
                metadataVersion: drop.metadataVersion,
                versionId: drop.versionId,
                originSignerId: drop.dropped.signerId,
                originEnvelope: drop.dropped.envelope,
                originSignature: drop.dropped.signature,
                originKeyEnvelope: drop.dropped.keyEnvelope,
                previousRekeySignature: drop.dropped.rekeySignature,
                previousRekeyerId: drop.dropped.previousRekeyerId,
                previousEnvelope: drop.dropped.previousEnvelope,
                previousKeyEpoch: node.keyEpoch,
                nodeKind: drop.nodeKind,
                objectId: drop.objectId,
                contentSuite: drop.contentSuite,
                droppedBy: input.userId,
                targetEpoch: input.targetEpoch,
            })),
        );
    // Only suite 3 is written; anything else is left unsealed and revoked below.
    for (const share of rotated.shares.filter(
        (entry) => entry.shareEnvelope.length === SHARE_ENVELOPE_BYTES,
    ))
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
                    grantedByMember(driveShares.granterUserId, driveShares.workspaceId),
                ),
            );
    for (const link of rotated.links)
        await tx
            .update(driveLinks)
            .set({
                linkEnvelope: link.linkEnvelope,
                secretEnvelope: link.secretEnvelope,
                keyEpoch: input.targetEpoch,
                kdfVersion: LINK_KDF_VERSION,
            })
            .where(
                and(
                    eq(driveLinks.id, link.id),
                    eq(driveLinks.nodeId, item.id),
                    grantedByMember(driveLinks.granterUserId, driveLinks.workspaceId),
                ),
            );
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
