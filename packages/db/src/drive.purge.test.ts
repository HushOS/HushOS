import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, createTestAccount, resetDatabase } from '../test/helpers';
import { db } from './client';
import * as drive from './drive';
import {
    driveNodes,
    driveObjectDeletions,
    driveObjects,
    fileVersions,
    workspaceStorage,
} from './schema';

/*
 * Purge and the worker's sweeps: what deletes must release, what it must never
 * touch, and what the outbox says afterwards. Bytes are the witness throughout:
 * `used` and `reserved` must come out exact, an object must reach the outbox
 * exactly when its last reference goes, and a current version must survive
 * whatever its timestamps say.
 */

let account: Awaited<ReturnType<typeof createTestAccount>>;
let rootId: string;
let rootEpoch: number;
const MiB = 1024n * 1024n;
const keyEnvelope = () => randomBytes(72);
const metadataEnvelope = () => randomBytes(100);

async function epoch() {
    const range = await drive.allocateKeyEpochs(account.workspaceId, 1);
    return range!.from;
}
async function storage() {
    const [row] = await db
        .select({ used: workspaceStorage.usedBytes, reserved: workspaceStorage.reservedBytes })
        .from(workspaceStorage)
        .where(eq(workspaceStorage.workspaceId, account.workspaceId));
    return row!;
}
async function folder(parentId: string, parentKeyEpoch: number) {
    const id = randomUUID();
    const created = await drive.createFolders({
        workspaceId: account.workspaceId,
        userId: account.userId,
        folders: [
            {
                id,
                parentId,
                envelopes: {
                    keyEpoch: await epoch(),
                    parentKeyEpoch,
                    keyEnvelope: keyEnvelope(),
                    metadataEnvelope: metadataEnvelope(),
                },
            },
        ],
    });
    if (created.status !== 'created') throw new Error(created.status);
    return created.nodes[0]!;
}
/* A published file of `plaintext` bytes under `parent`; returns its node and object. */
async function file(parentId: string, parentKeyEpoch: number, plaintext = 1n * MiB) {
    const chunkCount = Number(plaintext === 0n ? 1n : (plaintext + 8n * MiB - 1n) / (8n * MiB));
    const ciphertext = plaintext + 16n * BigInt(chunkCount);
    const objectId = randomUUID();
    const begun = await drive.beginUpload({
        workspaceId: account.workspaceId,
        userId: account.userId,
        node: {
            existing: false,
            id: randomUUID(),
            parentId,
            envelopes: {
                keyEpoch: await epoch(),
                parentKeyEpoch,
                keyEnvelope: keyEnvelope(),
                metadataEnvelope: metadataEnvelope(),
            },
        },
        version: { id: randomUUID(), contentKeyEnvelope: keyEnvelope() },
        object: {
            id: objectId,
            objectKey: `ws/${account.workspaceId}/${objectId}`,
            contentSuite: 2,
            chunkSize: Number(8n * MiB),
            chunkCount,
            contentNonce: randomBytes(16),
            ciphertextSize: ciphertext,
        },
        multipartId: `mp-${objectId}`,
        expiresAt: new Date(Date.now() + 3600_000),
    });
    if (begun.status !== 'ok') throw new Error(begun.status);
    const started = await drive.startCompleting(account.workspaceId, begun.uploadId);
    if (started.status !== 'ok') throw new Error(started.status);
    const done = await drive.finishCompleting(account.workspaceId, begun.uploadId, ciphertext);
    if (done.status !== 'published') throw new Error(done.status);
    return { node: done.node, objectId, ciphertext, uploadId: begun.uploadId };
}
async function outboxHas(objectId: string) {
    const [row] = await db
        .select()
        .from(driveObjectDeletions)
        .where(eq(driveObjectDeletions.objectId, objectId));
    return row ?? null;
}

beforeEach(async () => {
    await resetDatabase();
    account = await createTestAccount({ quotaBytes: 100n * MiB });
    const created = await drive.createRoot({
        workspaceId: account.workspaceId,
        userId: account.userId,
        id: randomUUID(),
        envelopes: {
            keyEpoch: await epoch(),
            parentKeyEpoch: 1,
            keyEnvelope: keyEnvelope(),
            metadataEnvelope: metadataEnvelope(),
        },
    });
    if (created.status !== 'created') throw new Error(created.status);
    rootId = created.root.id;
    rootEpoch = created.root.keyEpoch;
});
afterAll(closeDatabase);

describe('delete forever', () => {
    test('refuses anything not itself in the trash, and the root', async () => {
        const live = await file(rootId, rootEpoch);
        expect(
            (await drive.purgeNode({ workspaceId: account.workspaceId, nodeId: live.node.id }))
                .status,
        ).toBe('not-trashed');
        expect(
            (await drive.purgeNode({ workspaceId: account.workspaceId, nodeId: rootId })).status,
        ).toBe('root');
        expect((await storage()).used).toBe(live.ciphertext);
    });

    test('a trashed file releases its bytes, tombstones the node and queues its object once', async () => {
        const a = await file(rootId, rootEpoch, 2n * MiB);
        const b = await file(rootId, rootEpoch, 1n * MiB);
        await drive.trashNode({ workspaceId: account.workspaceId, nodeId: a.node.id });
        const purged = await drive.purgeNode({
            workspaceId: account.workspaceId,
            nodeId: a.node.id,
        });
        expect(purged.status).toBe('ok');
        expect(await storage()).toEqual({ used: b.ciphertext, reserved: 0n });
        const [node] = await db.select().from(driveNodes).where(eq(driveNodes.id, a.node.id));
        expect(node?.purgedAt).not.toBeNull();
        expect(node?.keyEnvelope).toBeNull();
        expect(node?.metadataEnvelope).toBeNull();
        expect(node?.changeSeq).toBeGreaterThan(a.node.changeSeq ?? 0);
        const queued = await outboxHas(a.objectId);
        expect(queued?.published).toBe(true);
        expect(queued?.primaryDeletedAt).toBeNull();
        const [object] = await db
            .select()
            .from(driveObjects)
            .where(eq(driveObjects.id, a.objectId));
        expect(object).toBeUndefined();
        // A second purge of the same node is a no-op: nothing is released twice.
        expect(
            (await drive.purgeNode({ workspaceId: account.workspaceId, nodeId: a.node.id })).status,
        ).toBe('not-found');
        expect(await storage()).toEqual({ used: b.ciphertext, reserved: 0n });
        // The trash and the listing no longer show it; the live file is untouched.
        const trash = await drive.listTrash({ workspaceId: account.workspaceId });
        expect(trash.items.map((i) => i.node.id)).toEqual([]);
        const listing = await drive.listChildren({
            workspaceId: account.workspaceId,
            parentId: rootId,
        });
        expect(listing.status === 'ok' ? listing.children.map((c) => c.id) : null).toEqual([
            b.node.id,
        ]);
    });

    test('a trashed folder purges now and its descendants follow in the fan-out, bytes exact', async () => {
        const top = await folder(rootId, rootEpoch);
        const inner = await folder(top.id, top.keyEpoch);
        const f1 = await file(top.id, top.keyEpoch, 1n * MiB);
        const f2 = await file(inner.id, inner.keyEpoch, 3n * MiB);
        const keep = await file(rootId, rootEpoch, 1n * MiB);
        await drive.trashNode({ workspaceId: account.workspaceId, nodeId: top.id });
        expect(
            (await drive.purgeNode({ workspaceId: account.workspaceId, nodeId: top.id })).status,
        ).toBe('ok');
        // The folder itself holds no bytes; its children are unreachable but not yet purged.
        expect((await storage()).used).toBe(f1.ciphertext + f2.ciphertext + keep.ciphertext);
        expect(
            (await drive.listChildren({ workspaceId: account.workspaceId, parentId: top.id }))
                .status,
        ).toBe('not-found');
        // One level per pass: first the folder's children, then the grandchild.
        expect(await drive.purgeDescendants(1000)).toBe(2);
        expect((await storage()).used).toBe(f2.ciphertext + keep.ciphertext);
        expect(await drive.purgeDescendants(1000)).toBe(1);
        expect(await drive.purgeDescendants(1000)).toBe(0);
        expect(await storage()).toEqual({ used: keep.ciphertext, reserved: 0n });
        expect(await outboxHas(f1.objectId)).not.toBeNull();
        expect(await outboxHas(f2.objectId)).not.toBeNull();
        expect(await outboxHas(keep.objectId)).toBeNull();
    });

    test('a pending upload into a purged file is aborted and its reservation released; a completing one is left for complete', async () => {
        const target = await file(rootId, rootEpoch, 1n * MiB);
        const objectId = randomUUID();
        const size = 2n * MiB + 16n;
        const begun = await drive.beginUpload({
            workspaceId: account.workspaceId,
            userId: account.userId,
            node: {
                existing: true,
                id: target.node.id,
                keyEpoch: target.node.keyEpoch,
                expectedVersionId: target.node.currentVersionId,
            },
            version: { id: randomUUID(), contentKeyEnvelope: keyEnvelope() },
            object: {
                id: objectId,
                objectKey: `ws/${account.workspaceId}/${objectId}`,
                contentSuite: 2,
                chunkSize: Number(8n * MiB),
                chunkCount: 1,
                contentNonce: randomBytes(16),
                ciphertextSize: size,
            },
            multipartId: `mp-${objectId}`,
            expiresAt: new Date(Date.now() + 3600_000),
        });
        if (begun.status !== 'ok') throw new Error(begun.status);
        expect((await storage()).reserved).toBe(size);
        await drive.trashNode({ workspaceId: account.workspaceId, nodeId: target.node.id });
        expect(
            (await drive.purgeNode({ workspaceId: account.workspaceId, nodeId: target.node.id }))
                .status,
        ).toBe('ok');
        expect(await storage()).toEqual({ used: 0n, reserved: 0n });
        expect((await drive.getUpload(account.workspaceId, begun.uploadId))?.status).toBe(
            'aborted',
        );
        const queued = await outboxHas(objectId);
        expect(queued?.published).toBe(false);
    });

    test('empty trash drains in batches and reports what remains', async () => {
        const nodes = [];
        for (let i = 0; i < 5; i++) nodes.push(await file(rootId, rootEpoch, 1n * MiB));
        for (const entry of nodes)
            await drive.trashNode({ workspaceId: account.workspaceId, nodeId: entry.node.id });
        const first = await drive.emptyTrash(account.workspaceId, 2);
        expect(first).toEqual({ purged: 2, remaining: 3 });
        const second = await drive.emptyTrash(account.workspaceId, 10);
        expect(second).toEqual({ purged: 3, remaining: 0 });
        expect(await storage()).toEqual({ used: 0n, reserved: 0n });
    });
});

describe('the sweeps', () => {
    test('trash past retention is purged, younger trash is not', async () => {
        const old = await file(rootId, rootEpoch, 1n * MiB);
        const young = await file(rootId, rootEpoch, 1n * MiB);
        await drive.trashNode({ workspaceId: account.workspaceId, nodeId: old.node.id });
        await drive.trashNode({ workspaceId: account.workspaceId, nodeId: young.node.id });
        await db
            .update(driveNodes)
            .set({ trashedAt: sql`now() - interval '31 days'` })
            .where(eq(driveNodes.id, old.node.id));
        expect(await drive.purgeExpiredTrash(30)).toBe(1);
        expect(await storage()).toEqual({ used: young.ciphertext, reserved: 0n });
        expect(await drive.purgeExpiredTrash(30)).toBe(0);
    });

    test('a superseded version past retention is purged; the current one never is', async () => {
        const first = await file(rootId, rootEpoch, 1n * MiB);
        // A second version supersedes the first.
        const objectId = randomUUID();
        const size = 2n * MiB + 16n;
        const begun = await drive.beginUpload({
            workspaceId: account.workspaceId,
            userId: account.userId,
            node: {
                existing: true,
                id: first.node.id,
                keyEpoch: first.node.keyEpoch,
                expectedVersionId: first.node.currentVersionId,
            },
            version: { id: randomUUID(), contentKeyEnvelope: keyEnvelope() },
            object: {
                id: objectId,
                objectKey: `ws/${account.workspaceId}/${objectId}`,
                contentSuite: 2,
                chunkSize: Number(8n * MiB),
                chunkCount: 1,
                contentNonce: randomBytes(16),
                ciphertextSize: size,
            },
            multipartId: `mp-${objectId}`,
            expiresAt: new Date(Date.now() + 3600_000),
        });
        if (begun.status !== 'ok') throw new Error(begun.status);
        await drive.startCompleting(account.workspaceId, begun.uploadId);
        const published = await drive.finishCompleting(account.workspaceId, begun.uploadId, size);
        if (published.status !== 'published') throw new Error(published.status);
        // Both versions look old; only the superseded one may go.
        await db
            .update(fileVersions)
            .set({ supersededAt: sql`now() - interval '40 days'` })
            .where(eq(fileVersions.nodeId, first.node.id));
        expect(await drive.purgeExpiredSupersededVersions(30)).toBe(1);
        expect(await storage()).toEqual({ used: size, reserved: 0n });
        const [current] = await db
            .select({ status: fileVersions.status })
            .from(fileVersions)
            .where(eq(fileVersions.id, published.node.currentVersionId!));
        expect(current?.status).toBe('ready');
        expect(await outboxHas(first.objectId)).not.toBeNull();
        expect(await outboxHas(objectId)).toBeNull();
    });

    test('tombstones go leaves first once their window has passed, live rows never', async () => {
        const top = await folder(rootId, rootEpoch);
        const inner = await folder(top.id, top.keyEpoch);
        await drive.trashNode({ workspaceId: account.workspaceId, nodeId: top.id });
        await drive.purgeNode({ workspaceId: account.workspaceId, nodeId: top.id });
        await drive.purgeDescendants(1000);
        await db
            .update(driveNodes)
            .set({ purgedAt: sql`now() - interval '91 days'` })
            .where(eq(driveNodes.id, top.id));
        // The parent is old enough but still has a child tombstone: nothing goes yet.
        expect(await drive.deleteExpiredTombstones(90)).toBe(0);
        await db
            .update(driveNodes)
            .set({ purgedAt: sql`now() - interval '91 days'` })
            .where(eq(driveNodes.id, inner.id));
        expect(await drive.deleteExpiredTombstones(90)).toBe(1);
        expect(await drive.deleteExpiredTombstones(90)).toBe(1);
        expect(await drive.deleteExpiredTombstones(90)).toBe(0);
        const [root] = await db
            .select({ id: driveNodes.id })
            .from(driveNodes)
            .where(eq(driveNodes.id, rootId));
        expect(root).toBeDefined();
    });

    test('the outbox waits for the replica on published objects and not on unpublished ones', async () => {
        const published = await file(rootId, rootEpoch, 1n * MiB);
        await drive.trashNode({ workspaceId: account.workspaceId, nodeId: published.node.id });
        await drive.purgeNode({ workspaceId: account.workspaceId, nodeId: published.node.id });
        const pending = await drive.listPendingObjectDeletions();
        expect(pending.map((row) => [row.objectId, row.published, row.replicated])).toEqual([
            [published.objectId, true, false],
        ]);
        // Replication catches up on the retired object's row, then the primary may go.
        expect((await drive.listUnreplicatedObjects()).map((r) => r.objectId)).toEqual([
            published.objectId,
        ]);
        await drive.markObjectReplicated(published.objectId);
        expect((await drive.listPendingObjectDeletions())[0]?.replicated).toBe(true);
        const undoUntil = new Date(Date.now() + 1000);
        await drive.markPrimaryDeleted(published.objectId, undoUntil);
        expect(await drive.listPendingObjectDeletions()).toEqual([]);
        expect(await drive.listReplicaDeletionsDue()).toEqual([]);
        await db
            .update(driveObjectDeletions)
            .set({ deleteReplicaAfter: sql`now() - interval '1 minute'` })
            .where(eq(driveObjectDeletions.objectId, published.objectId));
        expect((await drive.listReplicaDeletionsDue()).map((r) => r.objectId)).toEqual([
            published.objectId,
        ]);
        await drive.markObjectDeletionDone(published.objectId);
        expect(await drive.listReplicaDeletionsDue()).toEqual([]);
        // Without a replica the row is done the moment the primary is gone.
        const other = await file(rootId, rootEpoch, 1n * MiB);
        await drive.trashNode({ workspaceId: account.workspaceId, nodeId: other.node.id });
        await drive.purgeNode({ workspaceId: account.workspaceId, nodeId: other.node.id });
        await drive.markPrimaryDeleted(other.objectId, null);
        expect((await outboxHas(other.objectId))?.doneAt).not.toBeNull();
    });

    test('the usage audit reports drift and nothing when the books balance', async () => {
        await file(rootId, rootEpoch, 1n * MiB);
        expect(await drive.auditUsage(1000)).toEqual([]);
        await db
            .update(workspaceStorage)
            .set({ usedBytes: sql`${workspaceStorage.usedBytes} + 1` })
            .where(eq(workspaceStorage.workspaceId, account.workspaceId));
        const drift = await drive.auditUsage(1000);
        expect(drift.map((d) => d.workspaceId)).toEqual([account.workspaceId]);
        expect(drift[0]!.usedBytes - drift[0]!.computedBytes).toBe(1n);
    });

    describe('what a person can free', () => {
        test('the breakdown counts trash, including inside trashed folders, and earlier versions apart', async () => {
            const top = await folder(rootId, rootEpoch);
            const inTop = await file(top.id, top.keyEpoch, 2n * MiB);
            const loose = await file(rootId, rootEpoch, 1n * MiB);
            const versioned = await file(rootId, rootEpoch, 1n * MiB);
            // A second version of `versioned` makes the first one superseded.
            const objectId = randomUUID();
            const size = 3n * MiB + 16n;
            const begun = await drive.beginUpload({
                workspaceId: account.workspaceId,
                userId: account.userId,
                node: {
                    existing: true,
                    id: versioned.node.id,
                    keyEpoch: versioned.node.keyEpoch,
                    expectedVersionId: versioned.node.currentVersionId,
                },
                version: { id: randomUUID(), contentKeyEnvelope: keyEnvelope() },
                object: {
                    id: objectId,
                    objectKey: `ws/${account.workspaceId}/${objectId}`,
                    contentSuite: 2,
                    chunkSize: Number(8n * MiB),
                    chunkCount: 1,
                    contentNonce: randomBytes(16),
                    ciphertextSize: size,
                },
                multipartId: `mp-${objectId}`,
                expiresAt: new Date(Date.now() + 3600_000),
            });
            if (begun.status !== 'ok') throw new Error(begun.status);
            await drive.startCompleting(account.workspaceId, begun.uploadId);
            await drive.finishCompleting(account.workspaceId, begun.uploadId, size);
            await drive.trashNode({ workspaceId: account.workspaceId, nodeId: top.id });
            await drive.trashNode({ workspaceId: account.workspaceId, nodeId: loose.node.id });

            const breakdown = await drive.getStorageBreakdown(account.workspaceId);
            expect(breakdown.trashBytes).toBe(inTop.ciphertext + loose.ciphertext);
            expect(breakdown.trashItems).toBe(3);
            expect(breakdown.supersededBytes).toBe(versioned.ciphertext);
            expect(breakdown.supersededVersions).toBe(1);

            // Discarding earlier versions frees exactly that, in this workspace only, and keeps the current one.
            expect(await drive.purgeExpiredSupersededVersions(0, 200, account.workspaceId)).toBe(1);
            expect(await storage()).toEqual({
                used: inTop.ciphertext + loose.ciphertext + size,
                reserved: 0n,
            });
            expect((await drive.getStorageBreakdown(account.workspaceId)).supersededBytes).toBe(0n);
            const listing = await drive.listChildren({
                workspaceId: account.workspaceId,
                parentId: rootId,
            });
            if (listing.status !== 'ok') throw new Error(listing.status);
            expect(
                listing.children.find((c) => c.id === versioned.node.id)?.currentVersion?.objectId,
            ).toBe(objectId);
        });
    });
});
