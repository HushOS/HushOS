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
    fileVersions,
    workspaceStorage,
} from './schema';

/*
 * Copy and versions, with bytes as the witness. A copy pays for the object it
 * shares and the object retires only when the last copy goes; restoring an
 * earlier version moves no bytes; discarding one gives exactly its bytes back
 * and never touches the current version. Thumbnails follow the same rule: each
 * live version pays for the thumbnail it references, whether or not a copy
 * points at the same object.
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
/* A published file of `plaintext` bytes: as a new node under the root, or as a new version of `existing`. */
async function upload(
    plaintext: bigint,
    existing?: { nodeId: string; keyEpoch: number; expectedVersionId: string | null },
) {
    const chunkCount = Number(plaintext === 0n ? 1n : (plaintext + 8n * MiB - 1n) / (8n * MiB));
    const ciphertext = plaintext + 16n * BigInt(chunkCount);
    const objectId = randomUUID();
    const begun = await drive.beginUpload({
        workspaceId: account.workspaceId,
        userId: account.userId,
        node: existing
            ? { existing: true, ...existing, id: existing.nodeId }
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
        expiresAt: new Date(Date.now() + 3600_000),
    });
    if (begun.status !== 'ok') throw new Error(begun.status);
    const started = await drive.startCompleting(account.workspaceId, begun.uploadId);
    if (started.status !== 'ok') throw new Error(started.status);
    const done = await drive.finishCompleting(account.workspaceId, begun.uploadId, ciphertext);
    if (done.status !== 'published') throw new Error(done.status);
    return { node: done.node, objectId, ciphertext };
}
async function copy(
    source: { id: string; currentVersionId: string | null },
    parent: { id: string; keyEpoch: number },
    overrides: Partial<drive.CopyFile> = {},
) {
    return drive.copyFile({
        workspaceId: account.workspaceId,
        userId: account.userId,
        sourceNodeId: source.id,
        sourceVersionId: source.currentVersionId!,
        node: {
            id: randomUUID(),
            parentId: parent.id,
            envelopes: {
                keyEpoch: await epoch(),
                parentKeyEpoch: parent.keyEpoch,
                keyEnvelope: keyEnvelope(),
                metadataEnvelope: metadataEnvelope(),
            },
        },
        version: { id: randomUUID(), contentKeyEnvelope: randomBytes(84) },
        ...overrides,
    });
}
async function objectRow(objectId: string) {
    const [row] = await db.select().from(driveObjects).where(eq(driveObjects.id, objectId));
    return row ?? null;
}
async function outboxHas(objectId: string) {
    const [row] = await db
        .select()
        .from(driveObjectDeletions)
        .where(eq(driveObjectDeletions.objectId, objectId));
    return Boolean(row);
}

beforeEach(async () => {
    await resetDatabase();
    account = await createTestAccount({ quotaBytes: 10n * MiB });
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

describe('copy', () => {
    test('shares the object, pays for it again, and the object outlives either copy but not both', async () => {
        const { node, objectId, ciphertext } = await upload(1n * MiB);
        const before = await storage();
        const dest = await folder(rootId, rootEpoch);

        const copied = await copy(node, dest);
        if (copied.status !== 'ok') throw new Error(copied.status);
        expect(copied.node.parentId).toBe(dest.id);
        expect(copied.node.currentVersion?.objectId).toBe(objectId);
        expect(copied.node.currentVersion?.id).not.toBe(node.currentVersionId);
        expect((await storage()).used).toBe(before.used + ciphertext);
        // Both copies are readable and the copy is a child of its new parent.
        const listing = await drive.listChildren({
            workspaceId: account.workspaceId,
            parentId: dest.id,
        });
        if (listing.status !== 'ok') throw new Error(listing.status);
        expect(listing.children.map((child) => child.id)).toEqual([copied.node.id]);
        const readable = await drive.getVersionsForDownload(account.workspaceId, [
            node.currentVersionId!,
            copied.node.currentVersion!.id,
        ]);
        expect(readable).toHaveLength(2);

        // Purging the original gives back only its own bytes; the object stays for the copy.
        await drive.trashNode({ workspaceId: account.workspaceId, nodeId: node.id });
        expect(
            (await drive.purgeNode({ workspaceId: account.workspaceId, nodeId: node.id })).status,
        ).toBe('ok');
        expect((await storage()).used).toBe(before.used);
        expect(await objectRow(objectId)).not.toBeNull();
        expect(await outboxHas(objectId)).toBe(false);
        expect(
            await drive.getVersionsForDownload(account.workspaceId, [
                copied.node.currentVersion!.id,
            ]),
        ).toHaveLength(1);

        // The last copy going retires the object exactly once.
        await drive.trashNode({ workspaceId: account.workspaceId, nodeId: copied.node.id });
        expect(
            (await drive.purgeNode({ workspaceId: account.workspaceId, nodeId: copied.node.id }))
                .status,
        ).toBe('ok');
        expect(await storage()).toEqual({ used: 0n, reserved: 0n });
        expect(await objectRow(objectId)).toBeNull();
        expect(await outboxHas(objectId)).toBe(true);
    });

    test('a copy reseals in the object’s suite: the envelope’s length must follow it', async () => {
        const { node } = await upload(1n * MiB);
        // Suite 2: the 84-byte version envelope, never the bare 72-byte key envelope.
        expect((await copy(node, { id: rootId, keyEpoch: rootEpoch })).status).toBe('ok');
        expect(
            (
                await copy(
                    node,
                    { id: rootId, keyEpoch: rootEpoch },
                    { version: { id: randomUUID(), contentKeyEnvelope: randomBytes(72) } },
                )
            ).status,
        ).toBe('invalid');
        // A first-release object: suite 1, its size on the row, a 72-byte envelope, still
        // listed, copied and downloadable, and never given a suite 2 envelope.
        const legacy = await upload(2n * MiB);
        await db
            .update(driveObjects)
            .set({ contentSuite: 1, plaintextSize: 2n * MiB })
            .where(eq(driveObjects.id, legacy.objectId));
        await db
            .update(fileVersions)
            .set({ contentKeyEnvelope: randomBytes(72) })
            .where(eq(fileVersions.id, legacy.node.currentVersionId!));
        const listing = await drive.listChildren({
            workspaceId: account.workspaceId,
            parentId: rootId,
        });
        if (listing.status !== 'ok') throw new Error(listing.status);
        const listed = listing.children.find((child) => child.id === legacy.node.id);
        expect(listed?.currentVersion).toMatchObject({ contentSuite: 1, plaintextSize: 2n * MiB });
        expect(
            (
                await copy(
                    legacy.node,
                    { id: rootId, keyEpoch: rootEpoch },
                    { version: { id: randomUUID(), contentKeyEnvelope: randomBytes(72) } },
                )
            ).status,
        ).toBe('ok');
        expect((await copy(legacy.node, { id: rootId, keyEpoch: rootEpoch })).status).toBe(
            'invalid',
        );
        expect(await drive.auditUsage(50)).toEqual([]);
    });

    test('is refused over the allowance, into the trash, from the trash, and with stale preconditions', async () => {
        const { node, ciphertext } = await upload(4n * MiB);
        const dest = await folder(rootId, rootEpoch);
        // 10 MiB allowance, 4 used: one copy fits, a second does not.
        const first = await copy(node, dest);
        expect(first.status).toBe('ok');
        const second = await copy(node, dest);
        expect(second).toMatchObject({ status: 'over-quota', free: 10n * MiB - 2n * ciphertext });
        expect((await storage()).used).toBe(2n * ciphertext);

        // The version the client rewrapped must still be current.
        expect((await copy({ id: node.id, currentVersionId: randomUUID() }, dest)).status).toBe(
            'stale',
        );
        // Destination epoch, from a listing that has since rotated.
        expect((await copy(node, { id: dest.id, keyEpoch: dest.keyEpoch + 1 })).status).toBe(
            'stale',
        );
        // An epoch the workspace never handed out.
        expect(
            (
                await copy(node, dest, {
                    node: {
                        id: randomUUID(),
                        parentId: dest.id,
                        envelopes: {
                            keyEpoch: 999_999,
                            parentKeyEpoch: dest.keyEpoch,
                            keyEnvelope: keyEnvelope(),
                            metadataEnvelope: metadataEnvelope(),
                        },
                    },
                })
            ).status,
        ).toBe('stale');

        await drive.trashNode({ workspaceId: account.workspaceId, nodeId: dest.id });
        expect((await copy(node, dest)).status).toBe('parent-trashed');
        await drive.trashNode({ workspaceId: account.workspaceId, nodeId: node.id });
        expect((await copy(node, { id: rootId, keyEpoch: rootEpoch })).status).toBe('trashed');
        // A folder is not a file: nothing to copy at the server, clients walk it themselves.
        expect((await copy({ id: rootId, currentVersionId: null }, dest)).status).toBe('not-found');
        expect((await storage()).used).toBe(2n * ciphertext);
    });

    test('a copy of a file whose object the store lost is refused as unavailable', async () => {
        const { node, objectId } = await upload(1n * MiB);
        await drive.recordObjectAudit(objectId, 'missing');
        const result = await copy(node, { id: rootId, keyEpoch: rootEpoch });
        expect(result).toMatchObject({ status: 'unavailable', objectStatus: 'missing' });
    });
});

describe('versions', () => {
    test('a file lists its current and earlier version; restore swaps them without moving bytes', async () => {
        const first = await upload(1n * MiB);
        const second = await upload(2n * MiB, {
            nodeId: first.node.id,
            keyEpoch: first.node.keyEpoch,
            expectedVersionId: first.node.currentVersionId,
        });
        const used = (await storage()).used;
        expect(used).toBe(first.ciphertext + second.ciphertext);

        const listed = await drive.listVersions(account.workspaceId, first.node.id);
        expect(listed?.currentVersionId).toBe(second.node.currentVersionId);
        expect(listed?.versions.map((v) => [v.id, v.supersededAt !== null])).toEqual([
            [second.node.currentVersionId, false],
            [first.node.currentVersionId, true],
        ]);

        // The current version cannot be "restored"; the earlier one can, and the roles swap.
        expect(
            (await drive.restoreVersion(account.workspaceId, second.node.currentVersionId!)).status,
        ).toBe('not-superseded');
        const restored = await drive.restoreVersion(
            account.workspaceId,
            first.node.currentVersionId!,
        );
        if (restored.status !== 'ok') throw new Error(restored.status);
        expect(restored.node.currentVersionId).toBe(first.node.currentVersionId);
        expect(restored.node.changeSeq).toBeGreaterThan(second.node.changeSeq!);
        expect((await storage()).used).toBe(used);
        const after = await drive.listVersions(account.workspaceId, first.node.id);
        expect(after?.versions.map((v) => [v.id, v.supersededAt !== null])).toEqual([
            [second.node.currentVersionId, true],
            [first.node.currentVersionId, false],
        ]);
        // Both versions stay readable throughout.
        expect(
            await drive.getVersionsForDownload(account.workspaceId, [
                first.node.currentVersionId!,
                second.node.currentVersionId!,
            ]),
        ).toHaveLength(2);
        // A file in the trash keeps its versions as they are.
        await drive.trashNode({ workspaceId: account.workspaceId, nodeId: first.node.id });
        expect(
            (await drive.restoreVersion(account.workspaceId, second.node.currentVersionId!)).status,
        ).toBe('trashed');
    });

    test('discard gives back exactly the earlier version, never the current one', async () => {
        const first = await upload(1n * MiB);
        const second = await upload(2n * MiB, {
            nodeId: first.node.id,
            keyEpoch: first.node.keyEpoch,
            expectedVersionId: first.node.currentVersionId,
        });
        expect((await storage()).used).toBe(first.ciphertext + second.ciphertext);

        expect(
            (await drive.discardVersion(account.workspaceId, second.node.currentVersionId!)).status,
        ).toBe('current');
        expect((await drive.discardVersion(account.workspaceId, randomUUID())).status).toBe(
            'not-found',
        );
        expect(
            (await drive.discardVersion(account.workspaceId, first.node.currentVersionId!)).status,
        ).toBe('ok');
        expect((await storage()).used).toBe(second.ciphertext);
        expect(await outboxHas(first.objectId)).toBe(true);
        expect(
            await drive.getVersionsForDownload(account.workspaceId, [first.node.currentVersionId!]),
        ).toEqual([]);
        // Discarding it again is a no-op, not a second refund.
        expect(
            (await drive.discardVersion(account.workspaceId, first.node.currentVersionId!)).status,
        ).toBe('not-found');
        expect((await storage()).used).toBe(second.ciphertext);
        const [node] = await db.select().from(driveNodes).where(eq(driveNodes.id, first.node.id));
        expect(node?.currentVersionId).toBe(second.node.currentVersionId);
    });

    test('a third upload purges the oldest version and gives its bytes back', async () => {
        const first = await upload(1n * MiB);
        const second = await upload(1n * MiB, {
            nodeId: first.node.id,
            keyEpoch: first.node.keyEpoch,
            expectedVersionId: first.node.currentVersionId,
        });
        const third = await upload(1n * MiB, {
            nodeId: first.node.id,
            keyEpoch: first.node.keyEpoch,
            expectedVersionId: second.node.currentVersionId,
        });
        expect((await storage()).used).toBe(second.ciphertext + third.ciphertext);
        expect(await outboxHas(first.objectId)).toBe(true);
        const [purged] = await db
            .select({ status: fileVersions.status })
            .from(fileVersions)
            .where(eq(fileVersions.id, first.node.currentVersionId!));
        expect(purged?.status).toBe('purged');
        expect(await drive.auditUsage(50)).toEqual([]);
    });
});
