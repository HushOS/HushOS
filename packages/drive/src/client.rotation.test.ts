import { describe, expect, test } from 'vitest';
import { createCryptoSession, type CryptoRequests, type CryptoResults } from '@hushos/crypto';
import { createDeviceKey, rememberAccountKey } from '@hushos/crypto/device';
import { createIdentity } from '@hushos/crypto/identity';
import { createWorkspaceGrant } from '../../crypto/src/workspace';
import type { DriveApi, NodeView, RotateNodeWire, RotationWorkNode, UploadNodeInput } from './api';
import { DriveApiError } from './api';
import { createDriveClient, type DriveNode, type Rpc } from './client';
import { createTransferManager } from './transfers';

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
// ROOT ─ S (rotated) ─ P ─ C ─ D, and S ─ Q beside P; ROOT ─ M beside S, made since the
// rotation began (its key epoch above the target), which a move takes into P.
const [ROOT, S, P, Q, C, D, M] = ['a', 'b', 'c', 'd', 'e', 'f', '9'].map(uuid) as [
    string,
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
    [M]: 'M',
};
const TREE: [id: string, parent: string | null, epoch: number][] = [
    [ROOT, null, 1],
    [S, ROOT, 2],
    [P, S, 3],
    [Q, S, 4],
    [C, P, 5],
    [D, C, 6],
    [M, ROOT, 50],
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

async function setup(options: { rotationPartBytes?: number } = {}) {
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

    /*
     * This tab's worker as the Drive client and the transfer engine share it: the real session,
     * but for the store's PUTs, which land at once. Every operation is noted as it is asked.
     */
    const asked: string[] = [];
    let askedNext: ((operation: string) => void) | null = null;
    /* What this tab's walk committed and dropped after each batch, as it told the worker. */
    const settled = { committed: [] as string[][], dropped: [] as string[][] };
    const tab = (async (operation: string, input: unknown) => {
        asked.push(operation);
        if (operation === 'driveRotateCommit' || operation === 'driveRotateDrop')
            settled[operation === 'driveRotateCommit' ? 'committed' : 'dropped'].push(
                (input as { nodeIds: string[] }).nodeIds,
            );
        askedNext?.(operation);
        if (operation === 'driveUploadSend')
            return { ok: true, etag: `etag-${(input as { index: number }).index}`, bytes: 0 };
        return (mine as (operation: string, input: unknown) => Promise<unknown>)(operation, input);
    }) as Rpc;
    /* Resolves true once the tab asks the worker for `operation`, false if it has not after `ms`. */
    const asks = (operation: string, ms: number) =>
        new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
                askedNext = null;
                resolve(false);
            }, ms);
            askedNext = (asked) => {
                if (asked !== operation) return;
                clearTimeout(timer);
                askedNext = null;
                resolve(true);
            };
        });

    /* The parent a write names must be at the epoch the write was wrapped under, as the server checks. */
    const judgeParent = (parentId: string, parentKeyEpoch: number) => {
        if (row(parentId).keyEpoch !== parentKeyEpoch)
            throw new DriveApiError('This folder changed.', 'stale', 409);
    };
    let epochs = 100;
    const uploads = new Map<
        string,
        { node: UploadNodeInput; version: NodeView['currentVersion'] }
    >();
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
        allocateEpochs: async (_ws: string, count: number) => {
            const from = epochs;
            epochs += count;
            return { from, to: from + count - 1 };
        },
        move: async (
            _ws: string,
            nodeId: string,
            input: { parentId: string; parentKeyEpoch: number; keyEnvelope: string },
        ) => {
            judgeParent(input.parentId, input.parentKeyEpoch);
            rows.set(nodeId, {
                ...row(nodeId),
                parentId: input.parentId,
                parentKeyEpoch: input.parentKeyEpoch,
                keyEnvelope: input.keyEnvelope,
                changeSeq: seq++,
            });
            return { node: row(nodeId) };
        },
        // A new file's node is taken at begin, judged against its folder as it is then.
        beginUpload: async (_ws: string, input: Parameters<DriveApi['beginUpload']>[1]) => {
            const node = input.node;
            if (node.existing) throw new Error('only new files here');
            judgeParent(node.parentId, node.parentKeyEpoch);
            const id = `upload-${uploads.size + 1}`;
            uploads.set(id, {
                node,
                version: {
                    id: input.versionId,
                    objectId: input.objectId,
                    contentKeyEnvelope: input.contentKeyEnvelope,
                    contentSuite: input.contentSuite,
                } as NodeView['currentVersion'],
            });
            const expiresAt = '2099-01-01T00:00:00.000Z';
            return {
                upload: {
                    id,
                    nodeId: node.id,
                    versionId: input.versionId,
                    objectId: input.objectId,
                    status: 'open' as const,
                    chunkCount: input.chunkCount,
                    ciphertextSize: input.ciphertextSize,
                    expiresAt,
                },
                parts: Array.from({ length: input.chunkCount }, (_, i) => ({
                    partNumber: i + 1,
                    length: 0,
                    url: `https://store.test/${id}/${i + 1}`,
                })),
                urlExpiresAt: expiresAt,
            };
        },
        // Completed where begin put it.
        completeUpload: async (_ws: string, uploadId: string) => {
            const { node, version } = uploads.get(uploadId)!;
            if (node.existing) throw new Error('only new files here');
            rows.set(node.id, {
                ...row(ROOT),
                id: node.id,
                parentId: node.parentId,
                kind: 'file',
                keyEpoch: node.keyEpoch,
                parentKeyEpoch: node.parentKeyEpoch,
                keyEnvelope: node.keyEnvelope,
                metadataEnvelope: node.metadataEnvelope,
                metadataSignature: node.metadataSignature ?? null,
                currentVersion: version,
                changeSeq: seq++,
            });
            return { status: 'completed' as const, node: row(node.id) };
        },
        abortUpload: async () => ({ aborted: true }),
    } as unknown as DriveApi;

    const client = createDriveClient(tab, api, {
        signers: async () => ({}),
        ...options,
    });
    await client.open(USER);
    const finished = new Map<string, (outcome: string) => void>();
    const transfers = createTransferManager({
        rpc: tab,
        api,
        onEvent: ({ type, item }) => {
            if (type === 'done' || type === 'failed')
                finished.get(item.id)?.(type === 'done' ? type : `failed: ${item.error}`);
        },
    });
    /* Uploads `bytes` as `name` into `parent`; resolves once it is done (or failed). */
    const upload = (parent: DriveNode, name: string, bytes: Uint8Array) => {
        const [id] = transfers.enqueue([
            {
                parent,
                file: {
                    kind: 'memory',
                    name,
                    size: bytes.byteLength,
                    type: 'application/octet-stream',
                    lastModified: 1_000,
                    parts: [bytes.slice()],
                },
            },
        ]);
        return new Promise<string>((resolve) => finished.set(id!, resolve));
    };
    return {
        client,
        upload,
        asks,
        asked,
        rows,
        batches,
        settled,
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

describe('a batch sent in parts', () => {
    /*
     * P and Q go in one batch, here one part each. The first part lands; the second is lost on
     * the way. What the server applied must be committed in the worker and the rest dropped, so
     * the worker never holds a key the server refused nor drops one it kept; the retry finishes
     * from there and a device that never saw any of it reads the whole tree.
     */
    test('a part that landed stays applied when a later part is lost', async () => {
        const h = await setup({ rotationPartBytes: 1 });
        h.setBeforeNode(async () => {
            if (h.batches.length === 3) throw new Error('The connection dropped.');
        });

        await expect(h.client.rotate(h.row(S) as never)).rejects.toThrow('The connection dropped.');

        // S alone, then P and Q one part each.
        expect(h.batches.map((batch) => batch.length)).toEqual([1, 1, 1]);
        const [landed, lost] = [h.batches[1]![0]!, h.batches[2]![0]!];
        expect([landed, lost].sort()).toEqual([P, Q].sort());
        expect(h.row(landed).keyEpoch).toBe(TARGET);
        expect(h.row(lost).keyEpoch).toBeLessThan(TARGET);
        // The batch that failed settles what the server holds: the landed part kept, the lost one dropped.
        expect(h.settled.committed.at(-1)).toEqual([landed]);
        expect(h.settled.dropped.at(-1)).toContain(lost);
        expect(h.settled.dropped.at(-1)).not.toContain(landed);

        await h.client.rotate(h.row(S) as never);
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
    });
});

/*
 * The same race, met by a write in this tab rather than by the walk's own
 * child. While this tab's batch holding P is on its way, the other device
 * re-keys P first; this tab lists P (the other device's key, at the target)
 * and writes into it. The worker holds this walk's fresh key for P pending at
 * that same epoch, and would wrap the write under it; the server takes the
 * write (P is at the target), refuses this walk's P as stale, and the key is
 * dropped: the write would open for nobody. So a write waits out the batch
 * holding its folder and is wrapped under the key the server kept.
 */
async function writeDuringBatch(
    h: Awaited<ReturnType<typeof setup>>,
    operation: 'driveCreateNodes' | 'driveRewrapNode',
    write: (listed: DriveNode) => Promise<unknown>,
) {
    let theirs: string | null = null;
    let wrote: Promise<{ value?: unknown; error?: unknown }> | null = null;
    // Whether the write had its key made while the batch holding P was still on its way.
    let madeDuringBatch: boolean | null = null;
    h.setBeforeNode(async (id) => {
        if (id === P && theirs === null && h.row(S).keyEpoch === TARGET) {
            await h.rekeyedElsewhere(P);
            theirs = h.row(P).keyEnvelope;
            const { folder } = await h.client.listFolder(P);
            expect(folder.keyEpoch).toBe(TARGET);
            const asked = h.asks(operation, 500);
            wrote = write(folder).then(
                (value) => ({ value }),
                (error: unknown) => ({ error }),
            );
            madeDuringBatch = await asked;
        }
    });
    await h.client.rotate(h.row(S) as never);
    expect(wrote).not.toBeNull();
    const outcome = await wrote!;
    // The other device won P, and its key is the one the server kept.
    expect(theirs).not.toBeNull();
    expect(h.row(P).keyEnvelope).toBe(theirs);
    for (const id of [S, P, Q, C, D]) expect(h.row(id).keyEpoch).toBe(TARGET);
    return { outcome, madeDuringBatch };
}

describe('a write in this tab while its walk holds a folder', () => {
    test('an upload into a folder the other device re-keyed first opens for a device that never saw it', async () => {
        const h = await setup();
        const bytes = new TextEncoder().encode('kept under the key the server kept');
        const { outcome, madeDuringBatch } = await writeDuringBatch(
            h,
            'driveCreateNodes',
            (folder) => h.upload(folder, 'notes.txt', bytes),
        );
        expect(outcome).toEqual({ value: 'done' });
        const file = [...h.rows.values()].find((r) => r.kind === 'file')!;
        // Taken by the server under P at the walk's target: the epoch this walk's key had too.
        expect(file.parentId).toBe(P);
        expect(file.parentKeyEpoch).toBe(TARGET);

        const fresh = await h.open('fresh-device');
        const { nodes } = await fresh('driveOpenNodes', {
            workspaceId: WS,
            nodes: [...[ROOT, S, P].map((id) => h.row(id)), file].map(envelopesOf),
        });
        expect(nodes.map((n) => n.error ?? n.metadata?.name)).toEqual([
            'Files',
            'S',
            'P',
            'notes.txt',
        ]);
        const version = file.currentVersion!;
        const { versions } = await fresh('driveOpenVersions', {
            workspaceId: WS,
            nodeId: file.id,
            versions: [
                {
                    id: version.id,
                    objectId: version.objectId,
                    contentKeyEnvelope: version.contentKeyEnvelope,
                    contentSuite: version.contentSuite,
                    plaintextSize: null,
                },
            ],
        });
        expect(versions).toEqual([
            expect.objectContaining({ id: version.id, plaintextSize: bytes.byteLength }),
        ]);
        // It waited for the batch rather than taking the key the batch held.
        expect(madeDuringBatch).toBe(false);
    });

    test('a move into a folder the other device re-keyed first opens for a device that never saw it', async () => {
        const h = await setup();
        const { children } = await h.client.listFolder(ROOT);
        const moving = children.find((n) => n.id === M)!;
        const { outcome, madeDuringBatch } = await writeDuringBatch(
            h,
            'driveRewrapNode',
            (folder) => h.client.move(moving, folder),
        );
        expect(outcome.error).toBeUndefined();
        expect(h.row(M).parentId).toBe(P);
        expect(h.row(M).parentKeyEpoch).toBe(TARGET);

        const fresh = await h.open('fresh-device');
        const { nodes } = await fresh('driveOpenNodes', {
            workspaceId: WS,
            nodes: [ROOT, S, P, M].map((id) => envelopesOf(h.row(id))),
        });
        expect(nodes.map((n) => n.error ?? n.metadata?.name)).toEqual(['Files', 'S', 'P', 'M']);
        expect(madeDuringBatch).toBe(false);
    });

    test('an upload into the folder at its earlier epoch goes at once and is re-keyed with the rest', async () => {
        const h = await setup();
        // P as this tab listed it before the walk: at its own epoch, not the target.
        const { folder: before } = await h.client.listFolder(P);
        expect(before.keyEpoch).toBe(3);
        const bytes = new TextEncoder().encode('made under the key the walk replaces');
        let outcome: Promise<string> | null = null;
        let tookBeforeBatch: boolean | null = null;
        h.setBeforeNode(async (id) => {
            if (id === P && outcome === null && h.row(S).keyEpoch === TARGET) {
                outcome = h.upload(before, 'early.txt', bytes);
                // Never wrapped under the pending key, so nothing holds it: the server takes it
                // while P is still at its own epoch. Held back, it would come after the batch
                // re-keyed P and be refused as stale.
                tookBeforeBatch = await Promise.race([
                    outcome.then((o) => o === 'done'),
                    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
                ]);
            }
        });
        await h.client.rotate(h.row(S) as never);
        expect(outcome).not.toBeNull();
        expect(await outcome!).toBe('done');
        expect(tookBeforeBatch).toBe(true);
        const file = [...h.rows.values()].find((r) => r.kind === 'file')!;
        // Re-keyed by the walk like everything else beneath S.
        expect(file.parentKeyEpoch).toBe(TARGET);
        const fresh = await h.open('fresh-device');
        const { nodes } = await fresh('driveOpenNodes', {
            workspaceId: WS,
            nodes: [...[ROOT, S, P].map((id) => h.row(id)), file].map(envelopesOf),
        });
        expect(nodes.map((n) => n.error ?? n.metadata?.name)).toEqual([
            'Files',
            'S',
            'P',
            'early.txt',
        ]);
    });
});
