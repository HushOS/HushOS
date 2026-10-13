import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { metadataStatement, versionStatement } from '../../db/src/signatures';
import {
    closeDatabase,
    createTestAccount,
    createTestIdentity,
    resetDatabase,
    signerFor,
} from '../../db/test/helpers';
import { epoch, file, folder, member, root, share, type Account } from '../test/fixtures';
import * as server from './server';

/*
 * What someone who is not a member of a workspace learns about it through a
 * share: no bytes left when a write is refused for space, and nothing that
 * counts the owner's changes (the feed's cursor is sealed, and nodes come
 * without the owner's change sequence). A member keeps both.
 */

vi.mock('./storage', () => ({
    objectKey: (workspaceId: string, objectId: string) => `ws/${workspaceId}/${objectId}`,
    primaryStore: () => ({
        createMultipart: async () => 'multipart-test',
        abortMultipart: async () => {},
        presignGet: async (key: string) => `https://store.test/${key}`,
        presignPart: async (key: string, _id: string, part: number) =>
            `https://store.test/${key}?part=${part}`,
    }),
}));

const MiB = 1024n * 1024n;
const b64 = (bytes: Buffer) => bytes.toString('base64url');
// A metadata envelope as every client pads it: 256 bytes of plaintext, its nonce and tag.
const paddedMetadata = () => randomBytes(24 + 256 + 16);

let owner: Account;
let guest: Account;
let top: Awaited<ReturnType<typeof root>>;
let project: Awaited<ReturnType<typeof folder>>;
let shareId: string;

beforeEach(async () => {
    await resetDatabase();
    // 3 MiB, 2 of them taken by a file: 1 MiB left, too little for another copy of it.
    owner = await member({ quotaBytes: 3n * MiB });
    guest = await createTestAccount();
    await createTestIdentity(guest.userId);
    top = await root(owner);
    project = await folder(owner, top);
    shareId = await share(owner, project, guest, 'editor');
});
afterAll(closeDatabase);

/* A new file's begin as `writer` signs it, into the shared folder. */
async function beginAs(writer: Account, size: bigint) {
    const nodeId = randomUUID();
    const versionId = randomUUID();
    const objectId = randomUUID();
    const metadata = paddedMetadata();
    const content = randomBytes(84);
    const sign = signerFor(writer.userId).sign;
    return server.beginUpload(writer.userId, owner.workspaceId, {
        node: {
            existing: false,
            id: nodeId,
            parentId: project.id,
            keyEpoch: await epoch(owner.workspaceId),
            parentKeyEpoch: project.keyEpoch,
            keyEnvelope: b64(randomBytes(72)),
            metadataEnvelope: b64(metadata),
            metadataSignature: b64(
                sign(
                    metadataStatement({
                        workspaceId: owner.workspaceId,
                        nodeId,
                        kind: 'file',
                        metadataVersion: 1,
                        metadataEnvelope: metadata,
                    }),
                ),
            ),
        },
        versionId,
        objectId,
        contentKeyEnvelope: b64(content),
        versionSignature: b64(
            sign(
                versionStatement({
                    workspaceId: owner.workspaceId,
                    nodeId,
                    versionId,
                    objectId,
                    contentSuite: 3,
                    contentKeyEnvelope: content,
                }),
            ),
        ),
        contentNonce: b64(randomBytes(16)),
        contentSuite: 3,
        chunkCount: 1,
        ciphertextSize: size.toString(),
    });
}

/* A copy of `source` into the shared folder as `writer` signs it. */
async function copyAs(writer: Account, source: Awaited<ReturnType<typeof file>>) {
    const nodeId = randomUUID();
    const versionId = randomUUID();
    const metadata = paddedMetadata();
    const content = randomBytes(84);
    const sign = signerFor(writer.userId).sign;
    return server.copyNode(writer.userId, owner.workspaceId, source.id, {
        sourceVersionId: source.currentVersion!.id,
        node: {
            id: nodeId,
            parentId: project.id,
            keyEpoch: await epoch(owner.workspaceId),
            parentKeyEpoch: project.keyEpoch,
            keyEnvelope: b64(randomBytes(72)),
            metadataEnvelope: b64(metadata),
            metadataSignature: b64(
                sign(
                    metadataStatement({
                        workspaceId: owner.workspaceId,
                        nodeId,
                        kind: 'file',
                        metadataVersion: 1,
                        metadataEnvelope: metadata,
                    }),
                ),
            ),
        },
        versionId,
        contentKeyEnvelope: b64(content),
        versionSignature: b64(
            sign(
                versionStatement({
                    workspaceId: owner.workspaceId,
                    nodeId,
                    versionId,
                    objectId: source.currentVersion!.objectId,
                    contentSuite: 3,
                    contentKeyEnvelope: content,
                }),
            ),
        ),
    });
}

describe('a write refused for space', () => {
    test('tells a member the bytes left and an editor through a share nothing', async () => {
        const source = await file(owner, project, 2n * MiB);
        const refusals = {
            member: [
                await beginAs(owner, 2n * MiB).catch((error: unknown) => error),
                await copyAs(owner, source).catch((error: unknown) => error),
            ],
            editor: [
                await beginAs(guest, 2n * MiB).catch((error: unknown) => error),
                await copyAs(guest, source).catch((error: unknown) => error),
            ],
        };
        for (const error of refusals.member)
            expect(error).toMatchObject({
                status: 402,
                code: 'over-quota',
                data: { freeBytes: String(1n * MiB) },
            });
        for (const error of refusals.editor) {
            expect(error).toMatchObject({ status: 402, code: 'over-quota' });
            expect((error as server.DriveError).data).toBeUndefined();
        }
        // Within the allowance the editor's upload goes through: the refusal was about space.
        expect((await beginAs(guest, 512n * 1024n)).upload.status).toBe('open');
    });
});

describe('a grantee', () => {
    test('is handed a sealed feed cursor and nodes without the owner’s change sequence', async () => {
        const listed = await server.listSharedWithMe(guest.userId);
        expect(listed.shares).toHaveLength(1);
        expect(listed.shares[0]).not.toHaveProperty('changeSeq');
        expect(listed.shares[0]!.cursor).toMatch(/^[A-Za-z0-9_-]{48}$/);
        expect(listed.shares[0]!.node.changeSeq).toBeNull();

        const inner = await folder(owner, project);
        await folder(owner, top);
        const feed = await server.shareChanges(guest.userId, shareId, listed.shares[0]!.cursor);
        expect(feed.changes.map((c) => (c.kind === 'node' ? c.node.id : c.kind))).toEqual([
            inner.id,
        ]);
        for (const change of feed.changes) {
            expect(change).not.toHaveProperty('changeSeq');
            if (change.kind === 'node') expect(change.node.changeSeq).toBeNull();
        }

        // The owner's listing of the same folder keeps the sequence; the grantee's does not.
        const ownView = await server.listChildren(owner.userId, owner.workspaceId, project.id);
        const guestView = await server.listChildren(guest.userId, owner.workspaceId, project.id);
        expect(ownView.children[0]?.changeSeq).toEqual(expect.any(Number));
        expect(guestView.children[0]?.changeSeq).toBeNull();
        expect(guestView.folder.changeSeq).toBeNull();
    });

    test('is refused with 400 for a cursor the server did not seal for this share', async () => {
        const listed = await server.listSharedWithMe(guest.userId);
        const cursor = listed.shares[0]!.cursor;
        const other = await folder(owner, top);
        const otherShare = await share(owner, other, guest, 'viewer');
        const foreign = (await server.shareChanges(guest.userId, otherShare)).cursor;
        for (const bad of [`${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`, foreign])
            await expect(server.shareChanges(guest.userId, shareId, bad)).rejects.toMatchObject({
                status: 400,
                code: 'invalid',
            });
        expect((await server.shareChanges(guest.userId, shareId, cursor)).changes).toEqual([]);
    });
});
