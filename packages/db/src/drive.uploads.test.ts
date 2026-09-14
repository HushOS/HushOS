import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, createTestAccount, resetDatabase } from '../test/helpers';
import { db } from './client';
import * as drive from './drive';
import {
    driveNodes,
    driveObjectDeletions,
    driveObjects,
    driveUploads,
    fileVersions,
    workspaceStorage,
} from './schema';

/*
 * The upload protocol's accounting and state machine against a real database:
 * reservation and quota, invisibility until publish, the three-step complete,
 * conflicts that keep bytes reserved, version retention, and abort/expiry.
 * The store is not involved; the caller passes the size it reported.
 */

const MiB = 1024n * 1024n;
const keyEnvelope = () => randomBytes(72);
const metadataEnvelope = () => randomBytes(100);

let account: Awaited<ReturnType<typeof createTestAccount>>;
let rootId: string;
let rootEpoch: number;

async function epoch() {
    const range = await drive.allocateKeyEpochs(account.workspaceId, 1);
    return range!.from;
}

async function storage() {
    const [row] = await db
        .select()
        .from(workspaceStorage)
        .where(eq(workspaceStorage.workspaceId, account.workspaceId));
    return { used: row!.usedBytes, reserved: row!.reservedBytes };
}

/* Begins an upload of `plaintext` bytes as a new file under the root, or a new version of `nodeId`. */
async function begin(
    plaintext: bigint,
    existing?: { nodeId: string; keyEpoch: number; expectedVersionId: string | null },
) {
    const chunkCount = Number(plaintext === 0n ? 1n : (plaintext + 8n * MiB - 1n) / (8n * MiB));
    const ciphertext = plaintext + 16n * BigInt(chunkCount);
    const objectId = randomUUID();
    const result = await drive.beginUpload({
        workspaceId: account.workspaceId,
        userId: account.userId,
        node: existing
            ? {
                  existing: true,
                  id: existing.nodeId,
                  keyEpoch: existing.keyEpoch,
                  expectedVersionId: existing.expectedVersionId,
              }
            : {
                  existing: false,
                  id: randomUUID(),
                  parentId: rootId,
                  envelopes: {
                      keyEpoch: await epoch(),
                      parentKeyEpoch: rootEpoch,
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
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    });
    return { result, ciphertext, objectId };
}

async function publish(uploadId: string, size: bigint) {
    const started = await drive.startCompleting(account.workspaceId, uploadId);
    expect(started.status).toBe('ok');
    return drive.finishCompleting(account.workspaceId, uploadId, size);
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

describe('begin', () => {
    test('reserves the ciphertext size and refuses what the allowance cannot hold', async () => {
        const first = await begin(60n * MiB);
        expect(first.result.status).toBe('ok');
        expect((await storage()).reserved).toBe(first.ciphertext);
        const second = await begin(60n * MiB);
        expect(second.result.status).toBe('over-quota');
        if (second.result.status === 'over-quota')
            expect(second.result.free).toBe(100n * MiB - first.ciphertext);
        // Reads are never blocked: the reservation is exactly what was granted, nothing more.
        expect((await storage()).reserved).toBe(first.ciphertext);
        expect((await storage()).used).toBe(0n);
    });

    test('a file being uploaded is invisible until its version is ready', async () => {
        const { result } = await begin(1n * MiB);
        if (result.status !== 'ok') throw new Error(result.status);
        const listing = await drive.listChildren({
            workspaceId: account.workspaceId,
            parentId: rootId,
        });
        if (listing.status === 'ok') expect(listing.children).toHaveLength(0);
        const upload = await drive.getUpload(account.workspaceId, result.uploadId);
        expect(upload?.status).toBe('open');
        expect(upload?.newNode).toBe(true);
    });

    test('a new version must name the version it saw and the current key epoch', async () => {
        const { result, ciphertext } = await begin(1n * MiB);
        if (result.status !== 'ok') throw new Error(result.status);
        const published = await publish(result.uploadId, ciphertext);
        expect(published.status).toBe('published');
        if (published.status !== 'published') return;
        const node = published.node;
        const stale = await begin(1n * MiB, {
            nodeId: node.id,
            keyEpoch: node.keyEpoch,
            expectedVersionId: null,
        });
        expect(stale.result.status).toBe('stale');
        const rotated = await begin(1n * MiB, {
            nodeId: node.id,
            keyEpoch: node.keyEpoch + 1,
            expectedVersionId: node.currentVersionId,
        });
        expect(rotated.result.status).toBe('stale');
        const ok = await begin(1n * MiB, {
            nodeId: node.id,
            keyEpoch: node.keyEpoch,
            expectedVersionId: node.currentVersionId,
        });
        expect(ok.result.status).toBe('ok');
    });
});

describe('complete', () => {
    test('publishes: bytes move from reserved to used, the node appears with its version', async () => {
        const { result, ciphertext, objectId } = await begin(3n * MiB);
        if (result.status !== 'ok') throw new Error(result.status);
        const published = await publish(result.uploadId, ciphertext);
        expect(published.status).toBe('published');
        expect(await storage()).toEqual({ used: ciphertext, reserved: 0n });
        const listing = await drive.listChildren({
            workspaceId: account.workspaceId,
            parentId: rootId,
        });
        if (listing.status !== 'ok') throw new Error(listing.status);
        expect(listing.children).toHaveLength(1);
        expect(listing.children[0]!.currentVersion?.objectId).toBe(objectId);
        expect(listing.children[0]!.currentVersion?.status).toBe('ready');
        expect(listing.children[0]!.changeSeq).not.toBeNull();
        expect((await drive.getUpload(account.workspaceId, result.uploadId))?.status).toBe(
            'completed',
        );
        // A repeated call is answered, not re-applied.
        const again = await drive.finishCompleting(
            account.workspaceId,
            result.uploadId,
            ciphertext,
        );
        expect(again.status).toBe('completed');
        expect(await storage()).toEqual({ used: ciphertext, reserved: 0n });
    });

    test('a store size that differs from the reservation aborts and queues the object', async () => {
        const { result, ciphertext, objectId } = await begin(2n * MiB);
        if (result.status !== 'ok') throw new Error(result.status);
        const mismatch = await publish(result.uploadId, ciphertext - 1n);
        expect(mismatch.status).toBe('size-mismatch');
        expect(await storage()).toEqual({ used: 0n, reserved: 0n });
        expect(await db.select().from(driveNodes).where(eq(driveNodes.kind, 'file'))).toHaveLength(
            0,
        );
        const [queued] = await db
            .select()
            .from(driveObjectDeletions)
            .where(eq(driveObjectDeletions.objectId, objectId));
        expect(queued?.published).toBe(false);
    });

    test('an upload whose precondition moved is conflicted and keeps its reservation', async () => {
        const first = await begin(1n * MiB);
        if (first.result.status !== 'ok') throw new Error(first.result.status);
        const published = await publish(first.result.uploadId, first.ciphertext);
        if (published.status !== 'published') throw new Error(published.status);
        const node = published.node;
        const v1 = node.currentVersionId;
        // Two clients both start from v1.
        const a = await begin(1n * MiB, {
            nodeId: node.id,
            keyEpoch: node.keyEpoch,
            expectedVersionId: v1,
        });
        const b = await begin(1n * MiB, {
            nodeId: node.id,
            keyEpoch: node.keyEpoch,
            expectedVersionId: v1,
        });
        if (a.result.status !== 'ok' || b.result.status !== 'ok') throw new Error('begin');
        expect((await publish(a.result.uploadId, a.ciphertext)).status).toBe('published');
        const loser = await publish(b.result.uploadId, b.ciphertext);
        expect(loser.status).toBe('conflicted');
        expect((await storage()).reserved).toBe(b.ciphertext);
        expect((await drive.getUpload(account.workspaceId, b.result.uploadId))?.status).toBe(
            'conflicted',
        );
        // Abort releases the reservation and queues the object that reached the store.
        const aborted = await drive.abortUpload(account.workspaceId, b.result.uploadId);
        expect(aborted.status).toBe('ok');
        expect((await storage()).reserved).toBe(0n);
        const [queued] = await db
            .select()
            .from(driveObjectDeletions)
            .where(eq(driveObjectDeletions.objectId, b.objectId));
        expect(queued?.published).toBe(false);
    });

    test('a conflicted upload attaches as a sibling when the version moved, never over the winner', async () => {
        const first = await begin(1n * MiB);
        if (first.result.status !== 'ok') throw new Error(first.result.status);
        const published = await publish(first.result.uploadId, first.ciphertext);
        if (published.status !== 'published') throw new Error(published.status);
        const node = published.node;
        const v1 = node.currentVersionId;
        const a = await begin(2n * MiB, {
            nodeId: node.id,
            keyEpoch: node.keyEpoch,
            expectedVersionId: v1,
        });
        const b = await begin(3n * MiB, {
            nodeId: node.id,
            keyEpoch: node.keyEpoch,
            expectedVersionId: v1,
        });
        if (a.result.status !== 'ok' || b.result.status !== 'ok') throw new Error('begin');
        const winner = await publish(a.result.uploadId, a.ciphertext);
        if (winner.status !== 'published') throw new Error(winner.status);
        expect((await publish(b.result.uploadId, b.ciphertext)).status).toBe('conflicted');

        // Same node is refused: the version begin recorded is no longer current.
        const sameNode = await drive.attachUpload(account.workspaceId, b.result.uploadId, {
            mode: 'same-node',
            keyEpoch: node.keyEpoch,
            contentKeyEnvelope: keyEnvelope(),
        });
        expect(sameNode.status).toBe('conflicted');
        expect((await storage()).reserved).toBe(b.ciphertext);

        // A sibling under the same parent publishes the bytes already at the store.
        const siblingId = randomUUID();
        const attached = await drive.attachUpload(account.workspaceId, b.result.uploadId, {
            mode: 'sibling',
            userId: account.userId,
            node: {
                id: siblingId,
                parentId: rootId,
                keyEpoch: await epoch(),
                parentKeyEpoch: rootEpoch,
                keyEnvelope: keyEnvelope(),
                metadataEnvelope: metadataEnvelope(),
            },
            contentKeyEnvelope: keyEnvelope(),
        });
        expect(attached.status).toBe('published');
        expect(await storage()).toEqual({
            used: first.ciphertext + a.ciphertext + b.ciphertext,
            reserved: 0n,
        });
        const listing = await drive.listChildren({
            workspaceId: account.workspaceId,
            parentId: rootId,
        });
        if (listing.status !== 'ok') throw new Error(listing.status);
        const byId = new Map(listing.children.map((child) => [child.id, child]));
        expect(byId.get(node.id)?.currentVersion?.id).toBe(winner.node.currentVersionId);
        expect(byId.get(siblingId)?.currentVersion?.objectId).toBe(b.objectId);
        expect(byId.get(siblingId)?.currentVersion?.status).toBe('ready');
        expect(byId.get(siblingId)?.changeSeq).not.toBeNull();
        expect((await drive.getUpload(account.workspaceId, b.result.uploadId))?.status).toBe(
            'completed',
        );
        // Attach is not repeatable as a write, and a finished upload cannot be attached again.
        const again = await drive.attachUpload(account.workspaceId, b.result.uploadId, {
            mode: 'same-node',
            keyEpoch: node.keyEpoch,
            contentKeyEnvelope: keyEnvelope(),
        });
        expect(again.status).toBe('completed');
    });

    test('an epoch race attaches to the same node only with the current epoch and version', async () => {
        const first = await begin(1n * MiB);
        if (first.result.status !== 'ok') throw new Error(first.result.status);
        const published = await publish(first.result.uploadId, first.ciphertext);
        if (published.status !== 'published') throw new Error(published.status);
        const node = published.node;
        const next = await begin(2n * MiB, {
            nodeId: node.id,
            keyEpoch: node.keyEpoch,
            expectedVersionId: node.currentVersionId,
        });
        if (next.result.status !== 'ok') throw new Error(next.result.status);
        // The node's key rotates while the bytes are in flight.
        await db
            .update(driveNodes)
            .set({ keyEpoch: node.keyEpoch + 1 })
            .where(eq(driveNodes.id, node.id));
        expect((await publish(next.result.uploadId, next.ciphertext)).status).toBe('conflicted');

        // An open upload cannot be attached; a stale epoch is refused; the fresh one publishes.
        const open = await begin(1n * MiB);
        if (open.result.status !== 'ok') throw new Error(open.result.status);
        expect(
            (
                await drive.attachUpload(account.workspaceId, open.result.uploadId, {
                    mode: 'same-node',
                    keyEpoch: node.keyEpoch,
                    contentKeyEnvelope: keyEnvelope(),
                })
            ).status,
        ).toBe('not-conflicted');
        expect(
            (
                await drive.attachUpload(account.workspaceId, next.result.uploadId, {
                    mode: 'same-node',
                    keyEpoch: node.keyEpoch,
                    contentKeyEnvelope: keyEnvelope(),
                })
            ).status,
        ).toBe('stale');
        const freshEnvelope = keyEnvelope();
        const attached = await drive.attachUpload(account.workspaceId, next.result.uploadId, {
            mode: 'same-node',
            keyEpoch: node.keyEpoch + 1,
            contentKeyEnvelope: freshEnvelope,
        });
        if (attached.status !== 'published') throw new Error(attached.status);
        const row = await drive.getUpload(account.workspaceId, next.result.uploadId);
        expect(attached.node.currentVersionId).toBe(row?.versionId);
        expect(attached.displacedVersionId).toBe(node.currentVersionId);
        const [version] = await db
            .select({ envelope: fileVersions.contentKeyEnvelope, status: fileVersions.status })
            .from(fileVersions)
            .where(eq(fileVersions.id, attached.node.currentVersionId!));
        expect(version?.status).toBe('ready');
        expect(Buffer.from(version!.envelope!).equals(freshEnvelope)).toBe(true);
        expect(await storage()).toEqual({
            used: first.ciphertext + next.ciphertext,
            reserved: open.ciphertext,
        });
    });

    test('a file keeps the current version and the one it displaced; older ones are purged', async () => {
        const first = await begin(1n * MiB);
        if (first.result.status !== 'ok') throw new Error(first.result.status);
        const p1 = await publish(first.result.uploadId, first.ciphertext);
        if (p1.status !== 'published') throw new Error(p1.status);
        let node = p1.node;
        const sizes = [first.ciphertext];
        const objects = [first.objectId];
        for (const size of [2n * MiB, 3n * MiB]) {
            const next = await begin(size, {
                nodeId: node.id,
                keyEpoch: node.keyEpoch,
                expectedVersionId: node.currentVersionId,
            });
            if (next.result.status !== 'ok') throw new Error(next.result.status);
            const published = await publish(next.result.uploadId, next.ciphertext);
            if (published.status !== 'published') throw new Error(published.status);
            node = published.node;
            sizes.push(next.ciphertext);
            objects.push(next.objectId);
        }
        const versions = await db
            .select()
            .from(fileVersions)
            .where(eq(fileVersions.nodeId, node.id));
        expect(versions.filter((version) => version.status === 'ready')).toHaveLength(2);
        const purged = versions.filter((version) => version.status === 'purged');
        expect(purged).toHaveLength(1);
        // The retired object's pointer is cleared; nothing names a key the outbox now owns.
        expect(purged[0]!.objectId).toBeNull();
        expect(versions.find((v) => v.objectId === objects[1])?.supersededAt).not.toBeNull();
        expect(versions.find((v) => v.objectId === objects[2])?.supersededAt).toBeNull();
        expect((await storage()).used).toBe(sizes[1]! + sizes[2]!);
        expect(
            await db.select().from(driveObjects).where(eq(driveObjects.id, objects[0]!)),
        ).toHaveLength(0);
        const [queued] = await db
            .select()
            .from(driveObjectDeletions)
            .where(eq(driveObjectDeletions.objectId, objects[0]!));
        expect(queued?.published).toBe(true);
    });
});

describe('the object row', () => {
    test('a suite 2 object carries no plaintext size, and the store must confirm exactly the declared size', async () => {
        const { result, ciphertext, objectId } = await begin(1n * MiB);
        if (result.status !== 'ok') throw new Error(result.status);
        const [object] = await db
            .select({
                suite: driveObjects.contentSuite,
                plaintextSize: driveObjects.plaintextSize,
                ciphertextSize: driveObjects.ciphertextSize,
            })
            .from(driveObjects)
            .where(eq(driveObjects.id, objectId));
        expect(object).toEqual({ suite: 2, plaintextSize: null, ciphertextSize: ciphertext });
        // One byte over what was declared (a trailer the envelope did not promise, or a
        // padded object) is refused and the reservation goes back.
        const finished = await publish(result.uploadId, ciphertext + 1n);
        expect(finished.status).toBe('size-mismatch');
        expect(await storage()).toEqual({ used: 0n, reserved: 0n });
        const again = await begin(1n * MiB);
        if (again.result.status !== 'ok') throw new Error(again.result.status);
        expect((await publish(again.result.uploadId, again.ciphertext)).status).toBe('published');
        expect(await storage()).toEqual({ used: again.ciphertext, reserved: 0n });
        expect(await drive.auditUsage(50)).toEqual([]);
    });
});

describe('abort and expiry', () => {
    test('abort releases an open upload and removes its unseen node; completing refuses abort', async () => {
        const { result, ciphertext } = await begin(4n * MiB);
        if (result.status !== 'ok') throw new Error(result.status);
        expect((await storage()).reserved).toBe(ciphertext);
        const started = await drive.startCompleting(account.workspaceId, result.uploadId);
        expect(started.status).toBe('ok');
        expect((await drive.abortUpload(account.workspaceId, result.uploadId)).status).toBe(
            'completing',
        );
        // Finish as the store would report an absent object: abort, and the key still goes
        // through the outbox so the rule "every key is named by a row" holds.
        const finished = await drive.finishCompleting(account.workspaceId, result.uploadId, null);
        expect(finished.status).toBe('size-mismatch');
        expect(await storage()).toEqual({ used: 0n, reserved: 0n });
        expect(await db.select().from(driveNodes).where(eq(driveNodes.kind, 'file'))).toHaveLength(
            0,
        );
        const queued = await db.select().from(driveObjectDeletions);
        expect(queued).toHaveLength(1);
        expect(queued[0]!.published).toBe(false);
        // The node nobody saw is gone without a trace, and its upload record with it.
        expect(await drive.getUpload(account.workspaceId, result.uploadId)).toBeNull();
        expect((await drive.abortUpload(account.workspaceId, result.uploadId)).status).toBe(
            'not-found',
        );
    });

    test('the sweep finds uploads past their expiry and ones stuck completing', async () => {
        const fresh = await begin(1n * MiB);
        const old = await begin(1n * MiB);
        if (fresh.result.status !== 'ok' || old.result.status !== 'ok') throw new Error('begin');
        await db
            .update(driveUploads)
            .set({ expiresAt: new Date(Date.now() - 1000) })
            .where(eq(driveUploads.id, old.result.uploadId));
        const expired = await drive.listExpiredUploads();
        expect(expired.map((row) => row.id)).toEqual([old.result.uploadId]);
        expect((await drive.startCompleting(account.workspaceId, old.result.uploadId)).status).toBe(
            'expired',
        );
    });
});
