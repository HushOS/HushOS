import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
    closeDatabase,
    createTestAccount,
    createTestIdentity,
    resetDatabase,
} from '../test/helpers';
import * as signed from '../test/signed';
import { db } from './client';
import * as drive from './drive';
import { eq } from 'drizzle-orm';
import { driveNodes, workspaceKeys } from './schema';
import { sealShareCursor } from './share-cursor';

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
    const created = await signed.createFolders({
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

/* A suite 3 share of `node` to the guest, the only kind served; its id. */
async function shareWithGuest(node: { id: string; keyEpoch: number }) {
    const shared = await drive.createShare({
        workspaceId: owner.workspaceId,
        nodeId: node.id,
        granterUserId: owner.userId,
        granteeUserId: guest.userId,
        role: 'viewer',
        keyEpoch: node.keyEpoch,
        shareEnvelope: randomBytes(4565),
    });
    if (shared.status !== 'ok') throw new Error(shared.status);
    return shared.share.id;
}
/* Where a feed starts for a share listed now, as shared-with-me hands it out. */
async function cursorNow(shareId: string) {
    return sealShareCursor(shareId, (await drive.getPersonalWorkspace(owner.userId))!.changeSeq);
}
async function feedOf(shareId: string, cursor?: string) {
    const page = await drive.listShareChanges({ shareId, granteeUserId: guest.userId, cursor });
    if (page.status !== 'ok') throw new Error(page.status);
    return page;
}

beforeEach(async () => {
    await resetDatabase();
    owner = await createTestAccount();
    guest = await createTestAccount();
    for (const person of [owner, guest]) await createTestIdentity(person.userId);
    await db.insert(workspaceKeys).values({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        keyVersion: 1,
        wrappingSalt: randomBytes(32),
        wrappingNonce: randomBytes(24),
        encryptedKey: randomBytes(48),
    });
    const created = await signed.createRoot({
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
        expect(trashed.node.changeSeq).toBeGreaterThan(a.changeSeq ?? 0);
        const restored = await drive.restoreNode({ workspaceId: owner.workspaceId, nodeId: a.id });
        if (restored.status !== 'ok') throw new Error(restored.status);
        expect(restored.node.trashedAt).toBeNull();
        expect(restored.node.updatedAt).toEqual(before);
        expect(restored.node.changeSeq).toBeGreaterThan(trashed.node.changeSeq ?? 0);
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
        const shareId = await shareWithGuest(project);
        const start = await cursorNow(shareId);
        const inner = await folder(project.id, project.keyEpoch);
        await folder(outside.id, outside.keyEpoch);
        const feed = await feedOf(shareId, start);
        expect(feed.changes.map((c) => (c.kind === 'node' ? c.node.id : c.kind))).toEqual([
            inner.id,
        ]);
        // The cursor advanced past the outside change too, so it is never re-examined.
        expect((await feedOf(shareId, feed.cursor)).changes).toEqual([]);
        const elsewhere = await folder(outside.id, outside.keyEpoch);
        const skipped = await feedOf(shareId, feed.cursor);
        expect(skipped.changes).toEqual([]);

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
        const moved = await feedOf(shareId, skipped.cursor);
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
        const within = await feedOf(shareId, moved.cursor);
        expect(within.changes.map((c) => [c.kind, 'nodeId' in c ? c.nodeId : c.node.id])).toEqual([
            ['node', deeper.id],
        ]);
        expect(within.changes[0]?.kind === 'node' && within.changes[0].node.parentId).toBe(
            project.id,
        );

        // Someone else's share id, or a revoked share, gets nothing.
        expect(
            (await drive.listShareChanges({ shareId, granteeUserId: owner.userId })).status,
        ).toBe('not-found');
        await drive.revokeShare(owner.workspaceId, shareId);
        expect(
            (await drive.listShareChanges({ shareId, granteeUserId: guest.userId })).status,
        ).toBe('revoked');
    });

    test('deletions show only inside the share, however they were purged; older tombstones never', async () => {
        const project = await folder(rootId, rootEpoch);
        const outside = await folder(rootId, rootEpoch);
        const sub = await folder(project.id, project.keyEpoch);
        const leaf = await folder(sub.id, sub.keyEpoch);
        const gone = await folder(outside.id, outside.keyEpoch);
        const shareId = await shareWithGuest(project);
        const start = await cursorNow(shareId);
        // Inside: a folder deleted forever, and its child purged after it by the fan-out.
        await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: sub.id });
        await drive.purgeNode({ workspaceId: owner.workspaceId, nodeId: sub.id });
        expect(await drive.purgeDescendants()).toBe(1);
        // Outside: a deletion elsewhere in the owner's drive.
        await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: gone.id });
        await drive.purgeNode({ workspaceId: owner.workspaceId, nodeId: gone.id });
        const feed = await feedOf(shareId, start);
        const tombstones = feed.changes.filter((c) => c.kind === 'tombstone');
        expect(tombstones).toEqual([
            { kind: 'tombstone', nodeId: sub.id, parentId: project.id },
            { kind: 'tombstone', nodeId: leaf.id, parentId: sub.id },
        ]);
        // Nothing about the outside folder, in any form: not its trashing, not its tombstone.
        expect(JSON.stringify(feed.changes)).not.toContain(gone.id);
        // The owner's own feed still has every deletion.
        const own = await drive.listChanges({ workspaceId: owner.workspaceId, since: 0 });
        expect(own.changes.filter((c) => c.kind === 'tombstone').map((c) => c.nodeId)).toEqual(
            expect.arrayContaining([sub.id, leaf.id, gone.id]),
        );

        // A tombstone from before ancestors were recorded is never shown to a grantee.
        const old = await folder(project.id, project.keyEpoch);
        const before = await feedOf(shareId, feed.cursor);
        await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: old.id });
        await drive.purgeNode({ workspaceId: owner.workspaceId, nodeId: old.id });
        await db
            .update(driveNodes)
            .set({ purgedAncestorIds: null })
            .where(eq(driveNodes.id, old.id));
        const after = await feedOf(shareId, before.cursor);
        expect(after.changes.filter((c) => c.kind === 'tombstone')).toEqual([]);
    });

    test('the cursor is sealed: no sequence numbers, a fresh value each poll, refused when tampered or moved', async () => {
        const project = await folder(rootId, rootEpoch);
        const other = await folder(rootId, rootEpoch);
        const shareId = await shareWithGuest(project);
        const otherShareId = await shareWithGuest(other);
        await folder(project.id, project.keyEpoch);
        const first = await feedOf(shareId);
        expect(first.changes.length).toBeGreaterThan(0);
        // Changes are in order but carry no sequence of the owner's.
        for (const change of first.changes) expect(change).not.toHaveProperty('changeSeq');
        // The same position seals to a different string every time.
        const again = await feedOf(shareId, first.cursor);
        const third = await feedOf(shareId, again.cursor);
        expect(again.changes).toEqual([]);
        expect(third.cursor).not.toBe(again.cursor);
        // One flipped character, a truncated cursor, or another share's cursor is refused.
        const flipped = `${first.cursor.slice(0, 10)}${first.cursor[10] === 'A' ? 'B' : 'A'}${first.cursor.slice(11)}`;
        for (const cursor of [flipped, first.cursor.slice(1), 'not a cursor'])
            expect(
                (await drive.listShareChanges({ shareId, granteeUserId: guest.userId, cursor }))
                    .status,
            ).toBe('bad-cursor');
        const foreign = await feedOf(otherShareId);
        expect(
            (
                await drive.listShareChanges({
                    shareId,
                    granteeUserId: guest.userId,
                    cursor: foreign.cursor,
                })
            ).status,
        ).toBe('bad-cursor');
    });
});
