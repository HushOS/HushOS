import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, createTestAccount, resetDatabase } from '../test/helpers';
import { db } from './client';
import * as drive from './drive';
import { driveNodes, workspaces } from './schema';

/*
 * The tree's rules, exercised against a real database: one root, epochs come
 * from the workspace counter, stale preconditions are refused with 409-shaped
 * results, cycles and depth are checked under the lock, and trash hides subtrees.
 * Envelopes are random bytes of the right length; the repository never opens them.
 */

const keyEnvelope = () => randomBytes(72);
const metadataEnvelope = () => randomBytes(100);

let account: Awaited<ReturnType<typeof createTestAccount>>;
let rootId: string;

async function epochs(count: number) {
    const range = await drive.allocateKeyEpochs(account.workspaceId, count);
    if (!range) throw new Error('no workspace');
    return Array.from({ length: count }, (_, i) => range.from + i);
}

async function makeRoot() {
    const [keyEpoch] = await epochs(1);
    const result = await drive.createRoot({
        workspaceId: account.workspaceId,
        userId: account.userId,
        id: randomUUID(),
        envelopes: {
            keyEpoch: keyEpoch!,
            parentKeyEpoch: 1,
            keyEnvelope: keyEnvelope(),
            metadataEnvelope: metadataEnvelope(),
        },
    });
    if (result.status !== 'created') throw new Error(result.status);
    return result.root;
}

async function folder(parentId: string, parentKeyEpoch: number) {
    const [keyEpoch] = await epochs(1);
    const result = await drive.createFolders({
        workspaceId: account.workspaceId,
        userId: account.userId,
        folders: [
            {
                id: randomUUID(),
                parentId,
                envelopes: {
                    keyEpoch: keyEpoch!,
                    parentKeyEpoch,
                    keyEnvelope: keyEnvelope(),
                    metadataEnvelope: metadataEnvelope(),
                },
            },
        ],
    });
    if (result.status !== 'created') throw new Error(result.status);
    return result.nodes[0]!;
}

async function node(id: string) {
    const [row] = await db.select().from(driveNodes).where(eq(driveNodes.id, id));
    return row!;
}

beforeEach(async () => {
    await resetDatabase();
    account = await createTestAccount();
    rootId = (await makeRoot()).id;
});
afterAll(closeDatabase);

describe('root and epochs', () => {
    test('a workspace has exactly one root, and a second create returns it', async () => {
        const [keyEpoch] = await epochs(1);
        const again = await drive.createRoot({
            workspaceId: account.workspaceId,
            userId: account.userId,
            id: randomUUID(),
            envelopes: {
                keyEpoch: keyEpoch!,
                parentKeyEpoch: 1,
                keyEnvelope: keyEnvelope(),
                metadataEnvelope: metadataEnvelope(),
            },
        });
        expect(again.status).toBe('exists');
        if (again.status === 'exists') expect(again.root.id).toBe(rootId);
    });

    test('an epoch the workspace never issued is refused', async () => {
        const root = await node(rootId);
        const result = await drive.createFolders({
            workspaceId: account.workspaceId,
            userId: account.userId,
            folders: [
                {
                    id: randomUUID(),
                    parentId: rootId,
                    envelopes: {
                        keyEpoch: 999,
                        parentKeyEpoch: root.keyEpoch,
                        keyEnvelope: keyEnvelope(),
                        metadataEnvelope: metadataEnvelope(),
                    },
                },
            ],
        });
        expect(result.status).toBe('stale');
    });

    test('epoch ranges are contiguous and strictly increasing', async () => {
        const first = await drive.allocateKeyEpochs(account.workspaceId, 3);
        const second = await drive.allocateKeyEpochs(account.workspaceId, 2);
        expect(first!.to - first!.from).toBe(2);
        expect(second!.from).toBe(first!.to + 1);
    });
});

describe('create and list', () => {
    test('a chain created in one batch lands in order with rising height bounds', async () => {
        const root = await node(rootId);
        const [e1, e2, e3] = await epochs(3);
        const one = randomUUID();
        const two = randomUUID();
        const three = randomUUID();
        const result = await drive.createFolders({
            workspaceId: account.workspaceId,
            userId: account.userId,
            folders: [
                {
                    id: one,
                    parentId: rootId,
                    envelopes: {
                        keyEpoch: e1!,
                        parentKeyEpoch: root.keyEpoch,
                        keyEnvelope: keyEnvelope(),
                        metadataEnvelope: metadataEnvelope(),
                    },
                },
                {
                    id: two,
                    parentId: one,
                    envelopes: {
                        keyEpoch: e2!,
                        parentKeyEpoch: e1!,
                        keyEnvelope: keyEnvelope(),
                        metadataEnvelope: metadataEnvelope(),
                    },
                },
                {
                    id: three,
                    parentId: two,
                    envelopes: {
                        keyEpoch: e3!,
                        parentKeyEpoch: e2!,
                        keyEnvelope: keyEnvelope(),
                        metadataEnvelope: metadataEnvelope(),
                    },
                },
            ],
        });
        expect(result.status).toBe('created');
        expect((await node(rootId)).heightBound).toBe(3);
        expect((await node(one)).heightBound).toBe(2);
        expect((await node(three)).heightBound).toBe(0);
        const listing = await drive.listChildren({
            workspaceId: account.workspaceId,
            parentId: two,
        });
        expect(listing.status).toBe('ok');
        if (listing.status === 'ok') {
            expect(listing.children.map((child) => child.id)).toEqual([three]);
            expect(listing.ancestors.map((a) => a.id)).toEqual([rootId, one]);
        }
    });

    test('a batch that wraps under the wrong parent epoch is refused whole', async () => {
        const [e1] = await epochs(1);
        const result = await drive.createFolders({
            workspaceId: account.workspaceId,
            userId: account.userId,
            folders: [
                {
                    id: randomUUID(),
                    parentId: rootId,
                    envelopes: {
                        keyEpoch: e1!,
                        parentKeyEpoch: 42,
                        keyEnvelope: keyEnvelope(),
                        metadataEnvelope: metadataEnvelope(),
                    },
                },
            ],
        });
        expect(result.status).toBe('stale');
        const listing = await drive.listChildren({
            workspaceId: account.workspaceId,
            parentId: rootId,
        });
        if (listing.status === 'ok') expect(listing.children).toHaveLength(0);
    });

    test('nothing can be created below depth 64', async () => {
        let parent = await node(rootId);
        for (let depth = 1; depth <= drive.MAX_DEPTH; depth++)
            parent = await node((await folder(parent.id, parent.keyEpoch)).id);
        const [e] = await epochs(1);
        const result = await drive.createFolders({
            workspaceId: account.workspaceId,
            userId: account.userId,
            folders: [
                {
                    id: randomUUID(),
                    parentId: parent.id,
                    envelopes: {
                        keyEpoch: e!,
                        parentKeyEpoch: parent.keyEpoch,
                        keyEnvelope: keyEnvelope(),
                        metadataEnvelope: metadataEnvelope(),
                    },
                },
            ],
        });
        expect(result.status).toBe('too-deep');
        expect((await node(rootId)).heightBound).toBe(drive.MAX_DEPTH);
    });

    test('a listing inside a trashed folder is refused and trashed children are hidden', async () => {
        const root = await node(rootId);
        const a = await folder(rootId, root.keyEpoch);
        const b = await folder(a.id, a.keyEpoch);
        const c = await folder(rootId, root.keyEpoch);
        expect(
            (await drive.trashNode({ workspaceId: account.workspaceId, nodeId: a.id })).status,
        ).toBe('ok');
        const inside = await drive.listChildren({
            workspaceId: account.workspaceId,
            parentId: b.id,
        });
        expect(inside.status).toBe('trashed');
        const top = await drive.listChildren({
            workspaceId: account.workspaceId,
            parentId: rootId,
        });
        if (top.status === 'ok') expect(top.children.map((child) => child.id)).toEqual([c.id]);
        const trash = await drive.listTrash({ workspaceId: account.workspaceId });
        expect(trash.items.map((item) => item.node.id)).toEqual([a.id]);
    });

    test('every write takes a strictly increasing change sequence', async () => {
        const root = await node(rootId);
        const a = await folder(rootId, root.keyEpoch);
        const b = await folder(rootId, root.keyEpoch);
        expect(b.changeSeq!).toBeGreaterThan(a.changeSeq!);
        const [ws] = await db
            .select()
            .from(workspaces)
            .where(eq(workspaces.id, account.workspaceId));
        expect(ws!.changeSeq).toBe(b.changeSeq);
    });
});

describe('rename', () => {
    test('a stale metadata version or epoch is refused with the current row', async () => {
        const root = await node(rootId);
        const a = await folder(rootId, root.keyEpoch);
        const first = await drive.renameNode({
            workspaceId: account.workspaceId,
            nodeId: a.id,
            metadataVersion: 1,
            keyEpoch: a.keyEpoch,
            metadataEnvelope: metadataEnvelope(),
        });
        expect(first.status).toBe('ok');
        if (first.status === 'ok') expect(first.node.metadataVersion).toBe(2);
        const replay = await drive.renameNode({
            workspaceId: account.workspaceId,
            nodeId: a.id,
            metadataVersion: 1,
            keyEpoch: a.keyEpoch,
            metadataEnvelope: metadataEnvelope(),
        });
        expect(replay.status).toBe('stale');
        if (replay.status === 'stale') expect(replay.node.metadataVersion).toBe(2);
        const rotated = await drive.renameNode({
            workspaceId: account.workspaceId,
            nodeId: a.id,
            metadataVersion: 2,
            keyEpoch: a.keyEpoch + 1,
            metadataEnvelope: metadataEnvelope(),
        });
        expect(rotated.status).toBe('stale');
    });
});

describe('move', () => {
    test('refuses the root, a cycle, a trashed destination, and a stale destination epoch', async () => {
        const root = await node(rootId);
        const a = await folder(rootId, root.keyEpoch);
        const b = await folder(a.id, a.keyEpoch);
        const t = await folder(rootId, root.keyEpoch);
        await drive.trashNode({ workspaceId: account.workspaceId, nodeId: t.id });
        const move = (nodeId: string, parentId: string, parentKeyEpoch: number) =>
            drive.moveNode({
                workspaceId: account.workspaceId,
                nodeId,
                parentId,
                parentKeyEpoch,
                keyEnvelope: keyEnvelope(),
            });
        expect((await move(rootId, a.id, a.keyEpoch)).status).toBe('root');
        expect((await move(a.id, b.id, b.keyEpoch)).status).toBe('cycle');
        expect((await move(a.id, a.id, a.keyEpoch)).status).toBe('cycle');
        expect((await move(a.id, t.id, t.keyEpoch)).status).toBe('parent-trashed');
        expect((await move(b.id, rootId, root.keyEpoch + 5)).status).toBe('stale');
        const ok = await move(b.id, rootId, root.keyEpoch);
        expect(ok.status).toBe('ok');
        if (ok.status === 'ok') {
            expect(ok.node.parentId).toBe(rootId);
            expect(ok.node.parentKeyEpoch).toBe(root.keyEpoch);
        }
    });

    test('depth is a hard ceiling: a subtree cannot be moved where its height overflows', async () => {
        const root = await node(rootId);
        // A chain of 40 under `deep`, and a 30-deep landing spot: 30 + 1 + 40 > 64.
        const deep = await folder(rootId, root.keyEpoch);
        let parent = deep;
        for (let i = 0; i < 40; i++) parent = await folder(parent.id, parent.keyEpoch);
        let landing = await folder(rootId, root.keyEpoch);
        for (let i = 0; i < 29; i++) landing = await folder(landing.id, landing.keyEpoch);
        const result = await drive.moveNode({
            workspaceId: account.workspaceId,
            nodeId: deep.id,
            parentId: landing.id,
            parentKeyEpoch: landing.keyEpoch,
            keyEnvelope: keyEnvelope(),
        });
        expect(result.status).toBe('too-deep');
        // A shallower landing spot takes it and its bound propagates upward.
        const shallow = await folder(rootId, root.keyEpoch);
        const ok = await drive.moveNode({
            workspaceId: account.workspaceId,
            nodeId: deep.id,
            parentId: shallow.id,
            parentKeyEpoch: shallow.keyEpoch,
            keyEnvelope: keyEnvelope(),
        });
        expect(ok.status).toBe('ok');
        expect((await node(shallow.id)).heightBound).toBe(41);
    });
});

describe('trash and restore', () => {
    test('the root cannot be trashed; a node cannot be trashed twice', async () => {
        const root = await node(rootId);
        const a = await folder(rootId, root.keyEpoch);
        expect(
            (await drive.trashNode({ workspaceId: account.workspaceId, nodeId: rootId })).status,
        ).toBe('root');
        expect(
            (await drive.trashNode({ workspaceId: account.workspaceId, nodeId: a.id })).status,
        ).toBe('ok');
        expect(
            (await drive.trashNode({ workspaceId: account.workspaceId, nodeId: a.id })).status,
        ).toBe('trashed');
    });

    test('restoring under a trashed parent needs a new home at the root', async () => {
        const root = await node(rootId);
        const a = await folder(rootId, root.keyEpoch);
        const b = await folder(a.id, a.keyEpoch);
        await drive.trashNode({ workspaceId: account.workspaceId, nodeId: b.id });
        await drive.trashNode({ workspaceId: account.workspaceId, nodeId: a.id });
        const trash = await drive.listTrash({ workspaceId: account.workspaceId });
        expect(trash.items.find((item) => item.node.id === b.id)?.parentTrashed).toBe(true);
        expect(trash.items.find((item) => item.node.id === a.id)?.parentTrashed).toBe(false);
        const blocked = await drive.restoreNode({ workspaceId: account.workspaceId, nodeId: b.id });
        expect(blocked.status).toBe('parent-trashed');
        const stale = await drive.restoreNode({
            workspaceId: account.workspaceId,
            nodeId: b.id,
            toRoot: { parentKeyEpoch: root.keyEpoch + 1, keyEnvelope: keyEnvelope() },
        });
        expect(stale.status).toBe('stale');
        const moved = await drive.restoreNode({
            workspaceId: account.workspaceId,
            nodeId: b.id,
            toRoot: { parentKeyEpoch: root.keyEpoch, keyEnvelope: keyEnvelope() },
        });
        expect(moved.status).toBe('ok');
        if (moved.status === 'ok') {
            expect(moved.node.parentId).toBe(rootId);
            expect(moved.node.trashedAt).toBeNull();
        }
        const again = await drive.restoreNode({ workspaceId: account.workspaceId, nodeId: b.id });
        expect(again.status).toBe('not-trashed');
        const plain = await drive.restoreNode({ workspaceId: account.workspaceId, nodeId: a.id });
        expect(plain.status).toBe('ok');
    });
});
