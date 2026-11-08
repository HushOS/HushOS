import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { metadataStatement, versionStatement } from '../../db/src/signatures';
import {
    closeDatabase,
    createTestAccount,
    createTestIdentity,
    resetDatabase,
    signerFor,
} from '../../db/test/helpers';
import { epoch, file, folder, member, minted, root, share, type Account } from '../test/fixtures';
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
    const node = minted('node', owner.workspaceId);
    const version = minted('version', owner.workspaceId);
    const object = minted('object', owner.workspaceId);
    const [nodeId, versionId, objectId] = [node.id, version.id, object.id];
    const metadata = paddedMetadata();
    const content = randomBytes(84);
    const sign = signerFor(writer.userId).sign;
    return server.beginUpload(writer.userId, owner.workspaceId, {
        node: {
            existing: false,
            id: nodeId,
            idSeed: node.seed,
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
        versionIdSeed: version.seed,
        objectId,
        objectIdSeed: object.seed,
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
    const node = minted('node', owner.workspaceId);
    const version = minted('version', owner.workspaceId);
    const [nodeId, versionId] = [node.id, version.id];
    const metadata = paddedMetadata();
    const content = randomBytes(84);
    const sign = signerFor(writer.userId).sign;
    return server.copyNode(writer.userId, owner.workspaceId, source.id, {
        sourceVersionId: source.currentVersion!.id,
        node: {
            id: nodeId,
            idSeed: node.seed,
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
        versionIdSeed: version.seed,
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

/* A new folder in `parent` as `writer` signs it, in the shape createFolders takes. */
async function folderAs(
    writer: Account,
    parent: { id: string; keyEpoch: number },
    keyEpoch?: number,
) {
    const node = minted('node', owner.workspaceId);
    const metadata = paddedMetadata();
    return {
        id: node.id,
        idSeed: node.seed,
        parentId: parent.id,
        keyEpoch: keyEpoch ?? (await epoch(owner.workspaceId)),
        parentKeyEpoch: parent.keyEpoch,
        keyEnvelope: b64(randomBytes(72)),
        metadataEnvelope: b64(metadata),
        metadataSignature: b64(
            signerFor(writer.userId).sign(
                metadataStatement({
                    workspaceId: owner.workspaceId,
                    nodeId: node.id,
                    kind: 'folder',
                    metadataVersion: 1,
                    metadataEnvelope: metadata,
                }),
            ),
        ),
    };
}

/* A rename of `node` as `writer` signs it: new metadata at the next version. */
function renameAs(
    writer: Account,
    node: { id: string; keyEpoch: number; metadataVersion: number },
) {
    const metadata = paddedMetadata();
    return server.renameNode(writer.userId, owner.workspaceId, node.id, {
        metadataVersion: node.metadataVersion,
        keyEpoch: node.keyEpoch,
        metadataEnvelope: b64(metadata),
        metadataSignature: b64(
            signerFor(writer.userId).sign(
                metadataStatement({
                    workspaceId: owner.workspaceId,
                    nodeId: node.id,
                    kind: 'folder',
                    metadataVersion: node.metadataVersion + 1,
                    metadataEnvelope: metadata,
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

    /*
     * Every write an editor makes through the share answers as reads do: without the owner's
     * change sequence, which climbs with every change anywhere in the drive. A member's keeps it.
     */
    test('is served its own writes without the owner’s change sequence; a member keeps it', async () => {
        const ws = owner.workspaceId;
        const made = await server.createFolders(guest.userId, ws, [await folderAs(guest, project)]);
        expect(made.changeSeq).toBeNull();
        expect(made.nodes[0]!.changeSeq).toBeNull();
        const own = await server.createFolders(owner.userId, ws, [await folderAs(owner, project)]);
        expect(own.changeSeq).toEqual(expect.any(Number));
        expect(own.nodes[0]!.changeSeq).toEqual(expect.any(Number));

        const renamed = await renameAs(guest, made.nodes[0]!);
        expect(renamed.node.changeSeq).toBeNull();
        // A rename from a version the server has moved past: the refusal's node is a grantee's too.
        const stale = await renameAs(guest, made.nodes[0]!).catch((error: unknown) => error);
        expect(stale).toMatchObject({ status: 409, code: 'stale' });
        expect((stale as server.DriveError).data).toMatchObject({ node: { changeSeq: null } });
        const moved = await server.moveNode(guest.userId, ws, made.nodes[0]!.id, {
            parentId: own.nodes[0]!.id,
            parentKeyEpoch: own.nodes[0]!.keyEpoch,
            keyEnvelope: b64(randomBytes(72)),
        });
        expect(moved.node.changeSeq).toBeNull();
        const source = await file(owner, project, 1024n);
        const copied = await copyAs(guest, source);
        expect(copied.node.changeSeq).toBeNull();
        expect(
            (await server.trashNode(guest.userId, ws, made.nodes[0]!.id)).node.changeSeq,
        ).toBeNull();
        expect((await server.trashNodes(guest.userId, ws, [copied.node.id])).results).toEqual([
            expect.objectContaining({ status: 'trashed', changeSeq: null }),
        ]);

        // The owner's own writes keep it.
        expect((await renameAs(owner, own.nodes[0]!)).node.changeSeq).toEqual(expect.any(Number));
        expect((await server.trashNodes(owner.userId, ws, [source.id])).results).toEqual([
            expect.objectContaining({ status: 'trashed', changeSeq: expect.any(Number) }),
        ]);
    });

    /*
     * A batch of folders is checked parent by parent: one inside the share does not carry the
     * next, outside it, past the check. Else an editor could make folders in the owner's own.
     */
    test('cannot make a folder outside the share by naming a parent inside it first', async () => {
        const secret = await folder(owner, top);
        const refused = await server
            .createFolders(guest.userId, owner.workspaceId, [
                await folderAs(guest, project),
                await folderAs(guest, secret),
            ])
            .catch((error: unknown) => error);
        expect(refused).toMatchObject({ status: 404, code: 'not-found' });
        const listed = await server.listChildren(owner.userId, owner.workspaceId, secret.id);
        expect(listed.children).toEqual([]);
        expect(
            (await server.listChildren(owner.userId, owner.workspaceId, project.id)).children,
        ).toEqual([]);
    });

    /*
     * The owner's epoch counter climbs with every node and rotation anywhere in their drive. An
     * editor asking for epochs gets 1 to n whatever the owner has done, epochs the server takes,
     * and the counter itself never moves for them beyond n.
     */
    test('draws epochs that say nothing of the owner’s counter, and the server takes them', async () => {
        const ws = owner.workspaceId;
        expect(await server.allocateEpochs(guest.userId, ws, 3)).toEqual({ from: 1, to: 3 });
        const before = await server.allocateEpochs(owner.userId, ws, 1);
        for (let i = 0; i < 3; i++) await folder(owner, top);
        expect(await server.allocateEpochs(guest.userId, ws, 3)).toEqual({ from: 1, to: 3 });
        // The owner's own draws go on from where theirs were, untouched by the editor's.
        const after = await server.allocateEpochs(owner.userId, ws, 1);
        expect(after.from).toBe(before.from + 3 + 1);
        // Past the counter, an editor's range still holds: the counter is raised to cover it.
        const wide = await server.allocateEpochs(guest.userId, ws, 5_000);
        expect(wide).toEqual({ from: 1, to: 5_000 });
        const made = await server.createFolders(guest.userId, ws, [
            await folderAs(guest, project, 5_000),
        ]);
        expect(made.nodes[0]!.keyEpoch).toBe(5_000);
        // Or another editor's node at the same epoch: each node's context binds its own id.
        const twin = await server.createFolders(guest.userId, ws, [
            await folderAs(guest, project, 5_000),
        ]);
        expect(twin.nodes[0]!.keyEpoch).toBe(5_000);
    });

    /*
     * A rotation's target is drawn above the counter, so a node an editor made at a low epoch is
     * below it and is re-keyed with the rest when the share is stopped, never left under a key
     * the stopped editor holds.
     */
    test('makes nodes the next rotation of the share re-keys', async () => {
        const ws = owner.workspaceId;
        const { from } = await server.allocateEpochs(guest.userId, ws, 1);
        const made = await server.createFolders(guest.userId, ws, [
            await folderAs(guest, project, from),
        ]);
        const { rotation } = await server.startRotation(owner.userId, ws, project.id);
        expect(rotation.targetEpoch).toBeGreaterThan(from);
        const work = await server.rotationWork(owner.userId, ws, project.id, null);
        expect(work.nodes.map((node) => node.id)).toContain(made.nodes[0]!.id);
    });
});
