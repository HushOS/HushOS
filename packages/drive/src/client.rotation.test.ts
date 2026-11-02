import { describe, expect, test } from 'vitest';
import { createCryptoSession, type CryptoRequests, type CryptoResults } from '@hushos/crypto';
import { createDeviceKey, rememberAccountKey } from '@hushos/crypto/device';
import { createIdentity } from '@hushos/crypto/identity';
import { createWorkspaceGrant } from '../../crypto/src/workspace';
import type { DriveApi, NodeView, RotateNodeWire, RotationWorkNode } from './api';
import { createDriveClient, type Rpc } from './client';

/*
 * Two devices of one account walk the same rotation, and the server judges
 * every node of a batch on its own (packages/db rotateNodeIn). The other
 * device re-keys folder P in the moment between this device's batch reaching
 * the server and P's turn in it: this device's P comes back stale and its
 * fresh key is dropped. Had P's child C gone in the same batch, wrapped under
 * that fresh key, the server would have taken it (P is at the target epoch,
 * and both devices aim at the same one) and C would be lost to everyone. So
 * no batch holds a node beside its parent, and C is wrapped under the key the
 * server holds for P. Real crypto sessions on both devices, and a fresh third
 * one that reads the tree afterwards; the server is in memory.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const uuid = (c: string) =>
    `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
// ROOT ─ S (rotated) ─ P ─ C ─ D, and S ─ Q beside P.
const [ROOT, S, P, Q, C, D] = ['a', 'b', 'c', 'd', 'e', 'f'].map(uuid) as [
    string,
    string,
    string,
    string,
    string,
    string,
];
const NAMES: Record<string, string> = {
    [ROOT]: 'Files',
    [S]: 'S',
    [P]: 'P',
    [Q]: 'Q',
    [C]: 'C',
    [D]: 'D',
};
const TREE: [id: string, parent: string | null, epoch: number][] = [
    [ROOT, null, 1],
    [S, ROOT, 2],
    [P, S, 3],
    [Q, S, 4],
    [C, P, 5],
    [D, C, 6],
];
const TARGET = 10;

type Call = <K extends keyof CryptoRequests>(
    operation: K,
    input: CryptoRequests[K],
) => Promise<CryptoResults[K]>;

async function device(root: Uint8Array<ArrayBuffer>, deviceKeyId: string): Promise<Call> {
    const deviceKey = await createDeviceKey();
    const bundle = await rememberAccountKey(root, deviceKey, {
        userId: USER,
        keyVersion: 1,
        credentialVersion: 1,
        deviceKeyId,
    });
    const session = createCryptoSession();
    let id = 0;
    const call = ((operation: string, input: unknown) =>
        session.handle({ id: ++id, operation, input } as Parameters<
            typeof session.handle
        >[0])) as unknown as Call;
    await call('restore', { deviceKey, bundle });
    return call;
}

/* What the worker opens a row from: its current envelope, and the previous one mid-rotation. */
const envelopesOf = (row: NodeView) => ({
    id: row.id,
    parentId: row.parentId ?? WS,
    parentKeyEpoch: row.parentKeyEpoch,
    keyEpoch: row.keyEpoch,
    keyEnvelope: row.keyEnvelope,
    metadataVersion: row.metadataVersion,
    metadataEnvelope: row.metadataEnvelope,
    prevKeyEnvelope: row.prevKeyEnvelope,
    prevKeyEpoch: row.prevKeyEpoch,
    prevParentKeyEpoch: row.prevParentKeyEpoch,
    version: null,
});

async function setup() {
    const root = crypto.getRandomValues(new Uint8Array(32));
    const grant = await createWorkspaceGrant(root, USER, WS, 1);
    const identity = await createIdentity(root, USER);
    const open = async (deviceKeyId: string) => {
        const call = await device(root, deviceKeyId);
        await call('identityOpen', { userId: USER, identity });
        await call('driveOpenWorkspace', { userId: USER, grant });
        return call;
    };
    const mine = await open('this-device');
    const other = await open('other-device');

    // The tree as the server holds it, made by this device before the rotation.
    const { nodes: made } = await mine('driveCreateNodes', {
        workspaceId: WS,
        nodes: TREE.map(([id, parent, epoch]) => ({
            id,
            kind: 'folder' as const,
            parentId: parent ?? WS,
            parentKeyEpoch: parent ? TREE.find(([p]) => p === parent)![2] : 1,
            keyEpoch: epoch,
            metadata: { name: NAMES[id]!, mime: null, size: null, modified: null },
        })),
    });
    let seq = 1;
    const rows = new Map<string, NodeView>();
    for (const [index, [id, parent, epoch]] of TREE.entries()) {
        const sealed = made[index]!;
        rows.set(id, {
            id,
            workspaceId: WS,
            parentId: parent,
            kind: 'folder',
            keyEpoch: epoch,
            parentKeyEpoch: parent ? TREE.find(([p]) => p === parent)![2] : 1,
            keyEnvelope: sealed.keyEnvelope,
            prevKeyEnvelope: null,
            prevKeyEpoch: null,
            prevParentKeyEpoch: null,
            metadataVersion: 1,
            metadataEnvelope: sealed.metadataEnvelope,
            currentVersion: null,
            trashedAt: null,
            changeSeq: seq++,
            createdAt: '2026-11-02T00:00:00.000Z',
            updatedAt: '2026-11-02T00:00:00.000Z',
            envelopeSuite: 1,
            metadataSigner: { id: USER },
            metadataSignature: sealed.metadataSignature,
        });
    }
    const row = (id: string) => rows.get(id)!;
    const ancestors = (id: string) => {
        const out: NodeView[] = [];
        for (let at = row(id).parentId; at; at = row(at).parentId) out.unshift(row(at));
        return out;
    };
    const subtree = (id: string): NodeView[] => {
        // Breadth first, by depth then id, as listRotationWork orders it.
        const out: NodeView[] = [];
        let level = [row(id)];
        while (level.length) {
            out.push(...level);
            level = level
                .flatMap((n) => [...rows.values()].filter((r) => r.parentId === n.id))
                .sort((a, b) => a.id.localeCompare(b.id));
        }
        return out;
    };
    /* A re-key the server applies, keeping the envelope before it until the rotation finishes. */
    const apply = (
        id: string,
        sent: { keyEnvelope: string; parentKeyEpoch: number },
        rotated: { metadataEnvelope: string; metadataSignature?: string | null } | null,
    ) => {
        const before = row(id);
        rows.set(id, {
            ...before,
            ...(rotated
                ? {
                      keyEpoch: TARGET,
                      metadataEnvelope: rotated.metadataEnvelope,
                      metadataSignature: rotated.metadataSignature ?? null,
                      prevKeyEnvelope: before.prevKeyEnvelope ?? before.keyEnvelope,
                      prevKeyEpoch: before.prevKeyEpoch ?? before.keyEpoch,
                      prevParentKeyEpoch: before.prevParentKeyEpoch ?? before.parentKeyEpoch,
                  }
                : {}),
            keyEnvelope: sent.keyEnvelope,
            parentKeyEpoch: sent.parentKeyEpoch,
            changeSeq: seq++,
        });
    };

    /* The other device's walk re-keys `id` first, with a key of its own, under its parent's key at the target. */
    const rekeyedElsewhere = async (id: string) => {
        const node = row(id);
        await other('driveOpenNodes', {
            workspaceId: WS,
            nodes: [...ancestors(id), node].map(envelopesOf),
        });
        const { nodes } = await other('driveRotateNodes', {
            workspaceId: WS,
            targetEpoch: TARGET,
            granterUserId: USER,
            signers: {},
            nodes: [
                {
                    id,
                    kind: 'folder',
                    parentId: node.parentId!,
                    parentKeyEpoch: TARGET,
                    keyEpoch: node.keyEpoch,
                    wrappedParentKeyEpoch: node.parentKeyEpoch,
                    keyEnvelope: node.keyEnvelope,
                    metadataVersion: node.metadataVersion,
                    metadataEnvelope: node.metadataEnvelope,
                    metadataSigner: USER,
                    metadataSignature: node.metadataSignature ?? null,
                    versions: [],
                    shares: [],
                    links: [],
                },
            ],
        });
        const result = nodes[0]!;
        if (result.error !== undefined) throw new Error(result.error);
        apply(
            id,
            { keyEnvelope: result.keyEnvelope, parentKeyEpoch: TARGET },
            {
                metadataEnvelope: result.metadataEnvelope,
                metadataSignature: result.metadataSignature,
            },
        );
        await other('driveRotateCommit', { workspaceId: WS, nodeIds: [id] });
    };

    const batches: string[][] = [];
    /* Runs as each node of a batch comes up, before the server judges it: another device's transaction landing first. */
    let beforeNode: (id: string) => Promise<void> = async () => {};
    const api = {
        workspace: async () => ({
            workspaceId: WS,
            changeSeq: 0,
            grant,
            root: row(ROOT),
            rotation: null,
        }),
        children: async (_ws: string, folderId: string) => ({
            folder: row(folderId),
            ancestors: ancestors(folderId),
            children: [...rows.values()].filter((r) => r.parentId === folderId),
            nextCursor: null,
        }),
        startRotation: async (_ws: string, nodeId: string) => ({
            rotation: { nodeId, targetEpoch: TARGET },
        }),
        rotationWork: async (_ws: string, rootId: string) => {
            const due = subtree(rootId).filter(
                (n) => n.keyEpoch < TARGET || (n.id !== rootId && n.parentKeyEpoch < TARGET),
            );
            // Finished: the previous envelopes go, as finishRotation clears them.
            if (!due.length)
                for (const [id, r] of rows)
                    rows.set(id, {
                        ...r,
                        prevKeyEnvelope: null,
                        prevKeyEpoch: null,
                        prevParentKeyEpoch: null,
                    });
            return {
                rotation: { nodeId: rootId, targetEpoch: TARGET },
                nodes: due.map((n): RotationWorkNode => ({
                    ...n,
                    depth: ancestors(n.id).length - ancestors(rootId).length,
                    versions: [],
                    shares: [],
                    links: [],
                })),
                nextCursor: null,
                done: !due.length,
            };
        },
        // Each node on its own, as rotateNodeIn judges it.
        rotateNodes: async (_ws: string, rootId: string, batch: RotateNodeWire[]) => {
            batches.push(batch.map((n) => n.id));
            const results = [];
            for (const item of batch) {
                await beforeNode(item.id);
                const node = row(item.id);
                const parent = node.parentId ? row(node.parentId) : null;
                let status: 'ok' | 'stale' | 'parent-not-ready' | 'already' = 'ok';
                if (node.changeSeq !== item.changeSeq) status = 'stale';
                else if (item.id !== rootId && parent!.keyEpoch < TARGET)
                    status = 'parent-not-ready';
                else if (parent && parent.keyEpoch !== item.parentKeyEpoch) status = 'stale';
                else if (node.keyEpoch >= TARGET !== (item.rotated === null)) status = 'stale';
                else if (node.keyEpoch >= TARGET && node.parentKeyEpoch >= TARGET)
                    status = 'already';
                if (status === 'ok') apply(item.id, item, item.rotated);
                results.push({ id: item.id, status });
            }
            return { results };
        },
    } as unknown as DriveApi;

    const client = createDriveClient(mine as unknown as Rpc, api, {
        signers: async () => ({}),
    });
    await client.open(USER);
    return {
        client,
        rows,
        batches,
        row,
        rekeyedElsewhere,
        open,
        setBeforeNode: (hook: typeof beforeNode) => {
            beforeNode = hook;
        },
    };
}

describe('two devices walking one rotation', () => {
    test('a folder the other device re-keys first never leaves its child under a key nobody kept', async () => {
        const h = await setup();
        let theirs: string | null = null;
        h.setBeforeNode(async (id) => {
            // The other device's batch reaches P first, once S (P's parent) is at the target.
            if (id === P && theirs === null && h.row(S).keyEpoch === TARGET) {
                await h.rekeyedElsewhere(P);
                theirs = h.row(P).keyEnvelope;
            }
        });

        await h.client.rotate(h.row(S) as never);

        // The other device won P, and its key is the one the server kept.
        expect(theirs).not.toBeNull();
        expect(h.row(P).keyEnvelope).toBe(theirs);
        // Everything below S is at the target, and a device that never saw any of it reads the
        // whole tree from what the server holds, previous envelopes gone: C is wrapped under the
        // other device's key for P, not the one this device dropped.
        for (const id of [S, P, Q, C, D]) expect(h.row(id).keyEpoch).toBe(TARGET);
        const fresh = await h.open('fresh-device');
        const { nodes } = await fresh('driveOpenNodes', {
            workspaceId: WS,
            nodes: [ROOT, S, P, Q, C, D].map((id) => envelopesOf(h.row(id))),
        });
        expect(nodes.map((n) => n.error ?? n.metadata?.name)).toEqual([
            'Files',
            'S',
            'P',
            'Q',
            'C',
            'D',
        ]);
        // No batch held a node beside its parent; siblings still went together.
        for (const batch of h.batches)
            for (const id of batch) expect(batch).not.toContain(h.row(id).parentId);
        expect(h.batches.map((batch) => [...batch].sort())).toEqual([[S], [P, Q].sort(), [C], [D]]);
    });
});
