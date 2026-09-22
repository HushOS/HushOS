import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, createTestAccount, resetDatabase } from '../test/helpers';
import { db } from './client';
import * as drive from './drive';
import { workspaceKeys } from './schema';

/*
 * The change feed is a range over the workspace's sequence, tombstones
 * included; a share's feed is that range filtered to the shared subtree plus
 * the moves across its boundary, and it ends with the share.
 */

const env = () => randomBytes(72);
const meta = () => randomBytes(100);

let owner: Awaited<ReturnType<typeof createTestAccount>>;
let guest: Awaited<ReturnType<typeof createTestAccount>>;
let rootId: string;
let rootEpoch: number;

async function epoch() {
    return (await drive.allocateKeyEpochs(owner.workspaceId, 1))!.from;
}
async function folder(parentId: string, parentKeyEpoch: number) {
    const created = await drive.createFolders({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        folders: [
            {
                id: randomUUID(),
                parentId,
                envelopes: {
                    keyEpoch: await epoch(),
                    parentKeyEpoch,
                    keyEnvelope: env(),
                    metadataEnvelope: meta(),
                },
            },
        ],
    });
    if (created.status !== 'created') throw new Error(created.status);
    return created.nodes[0]!;
}

beforeEach(async () => {
    await resetDatabase();
    owner = await createTestAccount();
    guest = await createTestAccount();
    await db.insert(workspaceKeys).values({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        keyVersion: 1,
        wrappingSalt: randomBytes(32),
        wrappingNonce: randomBytes(24),
        encryptedKey: randomBytes(48),
    });
    const created = await drive.createRoot({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        id: randomUUID(),
        envelopes: {
            keyEpoch: await epoch(),
            parentKeyEpoch: 1,
            keyEnvelope: env(),
            metadataEnvelope: meta(),
        },
    });
    if (created.status !== 'created') throw new Error(created.status);
    rootId = created.root.id;
    rootEpoch = created.root.keyEpoch;
});
afterAll(closeDatabase);

describe('change feeds', () => {
    test("trash and restore reach the feed but leave the item's date alone", async () => {
        const a = await folder(rootId, rootEpoch);
        const before = a.updatedAt;
        const trashed = await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: a.id });
        if (trashed.status !== 'ok') throw new Error(trashed.status);
        expect(trashed.node.trashedAt).not.toBeNull();
        expect(trashed.node.updatedAt).toEqual(before);
        expect(trashed.node.changeSeq).toBeGreaterThan(a.changeSeq);
        const restored = await drive.restoreNode({ workspaceId: owner.workspaceId, nodeId: a.id });
        if (restored.status !== 'ok') throw new Error(restored.status);
        expect(restored.node.trashedAt).toBeNull();
        expect(restored.node.updatedAt).toEqual(before);
        expect(restored.node.changeSeq).toBeGreaterThan(trashed.node.changeSeq);
    });

    test('the workspace feed is ordered, cursored, and carries tombstones', async () => {
        const start = (await drive.getPersonalWorkspace(owner.userId))!.changeSeq;
        const a = await folder(rootId, rootEpoch);
        const b = await folder(rootId, rootEpoch);
        const first = await drive.listChanges({
            workspaceId: owner.workspaceId,
            since: start,
            limit: 1,
        });
        expect(first.changes.map((c) => (c.kind === 'node' ? c.node.id : null))).toEqual([a.id]);
        expect(first.hasMore).toBe(true);
        const rest = await drive.listChanges({
            workspaceId: owner.workspaceId,
            since: first.nextCursor,
        });
        expect(rest.changes.map((c) => (c.kind === 'node' ? c.node.id : null))).toEqual([b.id]);
        expect(rest.hasMore).toBe(false);
        // Nothing new: the cursor stays put.
        const quiet = await drive.listChanges({
            workspaceId: owner.workspaceId,
            since: rest.nextCursor,
        });
        expect(quiet.changes).toEqual([]);
        expect(quiet.nextCursor).toBe(rest.nextCursor);
        // Trash, then purge: a change, then a tombstone with its parent still named.
        await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: b.id });
        await drive.purgeNode({ workspaceId: owner.workspaceId, nodeId: b.id });
        const after = await drive.listChanges({
            workspaceId: owner.workspaceId,
            since: rest.nextCursor,
        });
        expect(after.changes.map((c) => c.kind)).toEqual(['tombstone']);
        expect(after.changes[0]).toMatchObject({ nodeId: b.id, parentId: rootId });
        // Another workspace's changes never show.
        expect(
            (await drive.listChanges({ workspaceId: guest.workspaceId, since: 0 })).changes,
        ).toEqual([]);
    });

    test('a share’s feed is the subtree only, with moves across the boundary as events, until the share ends', async () => {
        const project = await folder(rootId, rootEpoch);
        const outside = await folder(rootId, rootEpoch);
        const shared = await drive.createShare({
            workspaceId: owner.workspaceId,
            nodeId: project.id,
            granterUserId: owner.userId,
            granteeUserId: guest.userId,
            role: 'viewer',
            keyEpoch: project.keyEpoch,
            shareEnvelope: env(),
        });
        if (shared.status !== 'ok') throw new Error(shared.status);
        const since = (await drive.getPersonalWorkspace(owner.userId))!.changeSeq;
        const inner = await folder(project.id, project.keyEpoch);
        const elsewhere = await folder(outside.id, outside.keyEpoch);
        const feed = await drive.listShareChanges({
            shareId: shared.share.id,
            granteeUserId: guest.userId,
            since,
        });
        if (feed.status !== 'ok') throw new Error(feed.status);
        expect(feed.changes.map((c) => (c.kind === 'node' ? c.node.id : c.kind))).toEqual([
            inner.id,
        ]);
        // The cursor advanced past the outside change too, so it is never re-examined.
        expect(feed.nextCursor).toBe(elsewhere.changeSeq);

        // Move inner out: the grantee sees it leave. Move elsewhere in: it enters.
        await drive.moveNode({
            workspaceId: owner.workspaceId,
            nodeId: inner.id,
            parentId: outside.id,
            parentKeyEpoch: outside.keyEpoch,
            keyEnvelope: env(),
        });
        await drive.moveNode({
            workspaceId: owner.workspaceId,
            nodeId: elsewhere.id,
            parentId: project.id,
            parentKeyEpoch: project.keyEpoch,
            keyEnvelope: env(),
        });
        const moved = await drive.listShareChanges({
            shareId: shared.share.id,
            granteeUserId: guest.userId,
            since: feed.nextCursor,
        });
        if (moved.status !== 'ok') throw new Error(moved.status);
        expect(moved.changes.map((c) => [c.kind, 'nodeId' in c ? c.nodeId : c.node.id])).toEqual([
            ['left', inner.id],
            ['node', elsewhere.id],
            ['entered', elsewhere.id],
        ]);
        // A move within the subtree is a plain change, no event; and the feed is state, not a
        // log: a node created and then moved since the cursor appears once, as it is now.
        const deeper = await folder(elsewhere.id, elsewhere.keyEpoch);
        await drive.moveNode({
            workspaceId: owner.workspaceId,
            nodeId: deeper.id,
            parentId: project.id,
            parentKeyEpoch: project.keyEpoch,
            keyEnvelope: env(),
        });
        const within = await drive.listShareChanges({
            shareId: shared.share.id,
            granteeUserId: guest.userId,
            since: moved.nextCursor,
        });
        if (within.status !== 'ok') throw new Error(within.status);
        expect(within.changes.map((c) => [c.kind, 'nodeId' in c ? c.nodeId : c.node.id])).toEqual([
            ['node', deeper.id],
        ]);
        expect(within.changes[0]?.kind === 'node' && within.changes[0].node.parentId).toBe(
            project.id,
        );

        // Someone else's share id, or a revoked share, gets nothing.
        expect(
            (
                await drive.listShareChanges({
                    shareId: shared.share.id,
                    granteeUserId: owner.userId,
                    since: 0,
                })
            ).status,
        ).toBe('not-found');
        await drive.revokeShare(owner.workspaceId, shared.share.id);
        expect(
            (
                await drive.listShareChanges({
                    shareId: shared.share.id,
                    granteeUserId: guest.userId,
                    since: 0,
                })
            ).status,
        ).toBe('revoked');
    });
});
