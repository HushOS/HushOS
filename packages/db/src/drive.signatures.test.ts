import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
    closeDatabase,
    createTestAccount,
    createTestIdentity,
    resetDatabase,
    type TestSigner,
} from '../test/helpers';
import * as signed from '../test/signed';
import { db } from './client';
import * as drive from './drive';
import * as rotations from './rotations';
import { driveNodes, fileVersions, users, workspaceStorage } from './schema';
import { metadataStatement, versionStatement } from './signatures';

/*
 * Every write that sets a metadata or content-key envelope carries the
 * writer's signature over the statement in docs/integrity-design.md, checked
 * here against the writer's current signing key before anything is stored. A
 * signature by someone else, over another version of the statement, or from
 * an account without an identity is refused and changes nothing.
 */

const MiB = 1024n * 1024n;
const keyEnvelope = () => randomBytes(72);
const metadataEnvelope = () => randomBytes(100);

let owner: Awaited<ReturnType<typeof createTestAccount>>;
let ownerKey: TestSigner;
let otherKey: TestSigner;
let rootId: string;
let rootEpoch: number;

async function epoch() {
    return (await drive.allocateKeyEpochs(owner.workspaceId, 1))!.from;
}
function signMetadata(
    signer: TestSigner,
    nodeId: string,
    kind: 'folder' | 'file',
    envelope: Buffer,
    metadataVersion = 1,
) {
    return signer.sign(
        metadataStatement({
            workspaceId: owner.workspaceId,
            nodeId,
            kind,
            metadataVersion,
            metadataEnvelope: envelope,
        }),
    );
}
function signVersion(
    signer: TestSigner,
    input: { nodeId: string; versionId: string; objectId: string; contentSuite: number },
    envelope: Buffer,
) {
    return signer.sign(
        versionStatement({
            workspaceId: owner.workspaceId,
            ...input,
            contentKeyEnvelope: envelope,
        }),
    );
}
async function nodeRow(id: string) {
    const [row] = await db.select().from(driveNodes).where(eq(driveNodes.id, id));
    return row ?? null;
}
async function storage() {
    const [row] = await db
        .select({ reserved: workspaceStorage.reservedBytes, used: workspaceStorage.usedBytes })
        .from(workspaceStorage)
        .where(eq(workspaceStorage.workspaceId, owner.workspaceId));
    return row!;
}

/* A new file's begin with explicit signatures, so a test can get one of them wrong. */
async function beginWith(sign: {
    metadata?: (nodeId: string, envelope: Buffer) => Buffer;
    version?: (ids: { nodeId: string; versionId: string; objectId: string }, e: Buffer) => Buffer;
}) {
    const nodeId = randomUUID();
    const versionId = randomUUID();
    const objectId = randomUUID();
    const metadata = metadataEnvelope();
    const content = randomBytes(84);
    const result = await drive.beginUpload({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        node: {
            existing: false,
            id: nodeId,
            parentId: rootId,
            envelopes: {
                keyEpoch: await epoch(),
                parentKeyEpoch: rootEpoch,
                keyEnvelope: keyEnvelope(),
                metadataEnvelope: metadata,
                metadataSignature: (
                    sign.metadata ?? ((id, e) => signMetadata(ownerKey, id, 'file', e))
                )(nodeId, metadata),
            },
        },
        version: {
            id: versionId,
            contentKeyEnvelope: content,
            signature: (
                sign.version ?? ((ids, e) => signVersion(ownerKey, { ...ids, contentSuite: 3 }, e))
            )({ nodeId, versionId, objectId }, content),
        },
        object: {
            id: objectId,
            objectKey: `ws/${owner.workspaceId}/${objectId}`,
            contentSuite: 3,
            chunkSize: Number(8n * MiB),
            chunkCount: 1,
            contentNonce: randomBytes(16),
            ciphertextSize: 4096n,
        },
        multipartId: `mp-${objectId}`,
        expiresAt: new Date(Date.now() + 3600_000),
    });
    return { result, nodeId, versionId, objectId };
}
async function publish(uploadId: string) {
    await drive.startCompleting(owner.workspaceId, uploadId);
    const done = await drive.finishCompleting(owner.workspaceId, uploadId, 4096n);
    if (done.status !== 'published') throw new Error(done.status);
    return done.node;
}

beforeEach(async () => {
    await resetDatabase();
    owner = await createTestAccount();
    const other = await createTestAccount();
    ownerKey = await createTestIdentity(owner.userId);
    otherKey = await createTestIdentity(other.userId);
    const created = await signed.createRoot({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
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

describe('creating', () => {
    test('a root signed by another account is refused and no root exists', async () => {
        await resetDatabase();
        owner = await createTestAccount();
        ownerKey = await createTestIdentity(owner.userId);
        otherKey = await createTestIdentity((await createTestAccount()).userId);
        const id = randomUUID();
        const envelope = metadataEnvelope();
        const envelopes = {
            keyEpoch: await epoch(),
            parentKeyEpoch: 1,
            keyEnvelope: keyEnvelope(),
            metadataEnvelope: envelope,
        };
        const forged = await drive.createRoot({
            workspaceId: owner.workspaceId,
            userId: owner.userId,
            id,
            envelopes: {
                ...envelopes,
                metadataSignature: signMetadata(otherKey, id, 'folder', envelope),
            },
        });
        expect(forged.status).toBe('bad-signature');
        expect(await nodeRow(id)).toBeNull();
        const genuine = await drive.createRoot({
            workspaceId: owner.workspaceId,
            userId: owner.userId,
            id,
            envelopes: {
                ...envelopes,
                metadataSignature: signMetadata(ownerKey, id, 'folder', envelope),
            },
        });
        if (genuine.status !== 'created') throw new Error(genuine.status);
        // Stored with the signer, and served with what the server knows of the account.
        expect(genuine.root.metadataSigner).toEqual({
            id: owner.userId,
            name: 'Test',
            email: owner.email,
        });
        expect(genuine.root.metadataSignature).toHaveLength(64);
    });

    test('one bad signature refuses the whole folder batch', async () => {
        const good = { id: randomUUID(), envelope: metadataEnvelope() };
        const bad = { id: randomUUID(), envelope: metadataEnvelope() };
        const folder = async (f: typeof good, signature: Buffer, parentId = rootId) => ({
            id: f.id,
            parentId,
            envelopes: {
                keyEpoch: await epoch(),
                parentKeyEpoch: rootEpoch,
                keyEnvelope: keyEnvelope(),
                metadataEnvelope: f.envelope,
                metadataSignature: signature,
            },
        });
        const result = await drive.createFolders({
            workspaceId: owner.workspaceId,
            userId: owner.userId,
            folders: [
                await folder(good, signMetadata(ownerKey, good.id, 'folder', good.envelope)),
                // Signed as a file: the kind is part of the statement.
                await folder(bad, signMetadata(ownerKey, bad.id, 'file', bad.envelope)),
            ],
        });
        expect(result.status).toBe('bad-signature');
        expect(await nodeRow(good.id)).toBeNull();
        expect(await nodeRow(bad.id)).toBeNull();
    });

    test('an account without an identity cannot write at all', async () => {
        const stranger = await createTestAccount();
        const id = randomUUID();
        const envelope = metadataEnvelope();
        const result = await drive.createFolders({
            workspaceId: owner.workspaceId,
            userId: stranger.userId,
            folders: [
                {
                    id,
                    parentId: rootId,
                    envelopes: {
                        keyEpoch: await epoch(),
                        parentKeyEpoch: rootEpoch,
                        keyEnvelope: keyEnvelope(),
                        metadataEnvelope: envelope,
                        metadataSignature: signMetadata(ownerKey, id, 'folder', envelope),
                    },
                },
            ],
        });
        expect(result.status).toBe('bad-signature');
    });
});

describe('re-sealed statements', () => {
    function signResealed(signer: TestSigner) {
        return {
            metadata: (nodeId: string, envelope: Buffer) =>
                signer.sign(
                    metadataStatement(
                        {
                            workspaceId: owner.workspaceId,
                            nodeId,
                            kind: 'file',
                            metadataVersion: 1,
                            metadataEnvelope: envelope,
                        },
                        'resealed',
                    ),
                ),
            version: (ids: { nodeId: string; versionId: string; objectId: string }, e: Buffer) =>
                signer.sign(
                    versionStatement(
                        {
                            workspaceId: owner.workspaceId,
                            ...ids,
                            contentSuite: 3,
                            contentKeyEnvelope: e,
                        },
                        'resealed',
                    ),
                ),
        };
    }

    test('a write signed with the re-sealed statements by the writer lands, signed', async () => {
        const { result, nodeId, versionId } = await beginWith(signResealed(ownerKey));
        expect(result.status).toBe('ok');
        expect((await nodeRow(nodeId))?.metadataSignerId).toBe(owner.userId);
        const [version] = await db
            .select({ signerId: fileVersions.signerId })
            .from(fileVersions)
            .where(eq(fileVersions.id, versionId));
        expect(version?.signerId).toBe(owner.userId);
    });

    test('a re-sealed statement signed by someone else is refused and reserves nothing', async () => {
        const before = await storage();
        const { result, nodeId } = await beginWith(signResealed(otherKey));
        expect(result.status).toBe('bad-signature');
        expect(await nodeRow(nodeId)).toBeNull();
        expect(await storage()).toEqual(before);
    });

    test('a statement under a label of neither form is refused', async () => {
        const { result, nodeId } = await beginWith({
            metadata: (id, envelope) =>
                ownerKey.sign(
                    Buffer.from(
                        metadataStatement({
                            workspaceId: owner.workspaceId,
                            nodeId: id,
                            kind: 'file',
                            metadataVersion: 1,
                            metadataEnvelope: envelope,
                        })
                            .toString('utf8')
                            .replace('sig/metadata"', 'sig/metadata-copied"'),
                    ),
                ),
        });
        expect(result.status).toBe('bad-signature');
        expect(await nodeRow(nodeId)).toBeNull();
    });
});

describe('renaming', () => {
    test('is signed over the version it creates: the previous signature does not replay', async () => {
        const id = randomUUID();
        const first = metadataEnvelope();
        const created = await drive.createFolders({
            workspaceId: owner.workspaceId,
            userId: owner.userId,
            folders: [
                {
                    id,
                    parentId: rootId,
                    envelopes: {
                        keyEpoch: await epoch(),
                        parentKeyEpoch: rootEpoch,
                        keyEnvelope: keyEnvelope(),
                        metadataEnvelope: first,
                        metadataSignature: signMetadata(ownerKey, id, 'folder', first),
                    },
                },
            ],
        });
        if (created.status !== 'created') throw new Error(created.status);
        const keyEpoch = created.nodes[0]!.keyEpoch;
        const renamed = metadataEnvelope();
        // Signed over version 1, the one seen: the server stores version 2.
        const replayed = await drive.renameNode({
            workspaceId: owner.workspaceId,
            nodeId: id,
            userId: owner.userId,
            metadataVersion: 1,
            keyEpoch,
            metadataEnvelope: renamed,
            metadataSignature: signMetadata(ownerKey, id, 'folder', renamed, 1),
        });
        expect(replayed.status).toBe('bad-signature');
        expect((await nodeRow(id))?.metadataEnvelope?.equals(first)).toBe(true);
        const ok = await drive.renameNode({
            workspaceId: owner.workspaceId,
            nodeId: id,
            userId: owner.userId,
            metadataVersion: 1,
            keyEpoch,
            metadataEnvelope: renamed,
            metadataSignature: signMetadata(ownerKey, id, 'folder', renamed, 2),
        });
        if (ok.status !== 'ok') throw new Error(ok.status);
        expect(ok.node.metadataVersion).toBe(2);
        expect(ok.node.metadataSigner?.id).toBe(owner.userId);
    });

    test('a rename by another writer moves the signer to them', async () => {
        const editor = await createTestAccount();
        const editorKey = await createTestIdentity(editor.userId);
        const [root] = await db.transaction((tx) => drive.selectNodes(tx, [rootId]));
        const envelope = metadataEnvelope();
        const result = await drive.renameNode({
            workspaceId: owner.workspaceId,
            nodeId: rootId,
            userId: editor.userId,
            metadataVersion: root!.metadataVersion,
            keyEpoch: root!.keyEpoch,
            metadataEnvelope: envelope,
            metadataSignature: signMetadata(
                editorKey,
                rootId,
                'folder',
                envelope,
                root!.metadataVersion + 1,
            ),
        });
        if (result.status !== 'ok') throw new Error(result.status);
        expect(result.node.metadataSigner?.id).toBe(editor.userId);
        // The editor's account goes: the signature stays, the name it was shown under does not.
        await db.delete(users).where(eq(users.id, editor.userId));
        const [after] = await db.transaction((tx) => drive.selectNodes(tx, [rootId]));
        expect(after!.metadataSigner).toBeNull();
        expect(after!.metadataSignerId).toBeNull();
        expect(after!.metadataSignature?.equals(result.node.metadataSignature!)).toBe(true);
    });
});

describe('versions', () => {
    test('a version signed for another object is refused before anything is reserved', async () => {
        const { result, nodeId } = await beginWith({
            version: (ids, envelope) =>
                signVersion(
                    ownerKey,
                    { ...ids, objectId: randomUUID(), contentSuite: 3 },
                    envelope,
                ),
        });
        expect(result.status).toBe('bad-signature');
        expect(await storage()).toEqual({ reserved: 0n, used: 0n });
        expect(await nodeRow(nodeId)).toBeNull();
    });

    test('a version signed under another content suite is refused', async () => {
        const { result } = await beginWith({
            version: (ids, envelope) =>
                signVersion(ownerKey, { ...ids, contentSuite: 2 }, envelope),
        });
        expect(result.status).toBe('bad-signature');
    });

    test('a published file serves the signer on its node and its current version', async () => {
        const { result, versionId } = await beginWith({});
        if (result.status !== 'ok') throw new Error(result.status);
        const node = await publish(result.uploadId);
        expect(node.metadataSigner?.id).toBe(owner.userId);
        expect(node.currentVersion?.id).toBe(versionId);
        expect(node.currentVersion?.signer?.id).toBe(owner.userId);
        expect(node.currentVersion?.signature).toHaveLength(64);
        const listed = await drive.listVersions(owner.workspaceId, node.id);
        expect(listed?.versions[0]?.signer?.email).toBe(owner.email);
    });

    test('a copy is signed over its own node and the source object, never the source node', async () => {
        const { result } = await beginWith({});
        if (result.status !== 'ok') throw new Error(result.status);
        const source = await publish(result.uploadId);
        const [stored] = await db
            .select({ objectId: fileVersions.objectId })
            .from(fileVersions)
            .where(eq(fileVersions.id, source.currentVersionId!));
        const copyId = randomUUID();
        const copyVersion = randomUUID();
        const metadata = metadataEnvelope();
        const content = randomBytes(84);
        const copy = (versionSignature: Buffer) =>
            epoch().then((keyEpoch) =>
                drive.copyFile({
                    workspaceId: owner.workspaceId,
                    userId: owner.userId,
                    sourceNodeId: source.id,
                    sourceVersionId: source.currentVersionId!,
                    node: {
                        id: copyId,
                        parentId: rootId,
                        envelopes: {
                            keyEpoch,
                            parentKeyEpoch: rootEpoch,
                            keyEnvelope: keyEnvelope(),
                            metadataEnvelope: metadata,
                            metadataSignature: signMetadata(ownerKey, copyId, 'file', metadata),
                        },
                    },
                    version: {
                        id: copyVersion,
                        contentKeyEnvelope: content,
                        signature: versionSignature,
                    },
                }),
            );
        const ids = { versionId: copyVersion, objectId: stored!.objectId!, contentSuite: 3 };
        expect(
            (await copy(signVersion(ownerKey, { ...ids, nodeId: source.id }, content))).status,
        ).toBe('bad-signature');
        expect((await storage()).used).toBe(4096n);
        const done = await copy(signVersion(ownerKey, { ...ids, nodeId: copyId }, content));
        if (done.status !== 'ok') throw new Error(done.status);
        expect(done.node.currentVersion?.signer?.id).toBe(owner.userId);
    });

    test('attaching as a sibling needs a signature over the new node, not the one begin named', async () => {
        const { result, nodeId, versionId, objectId } = await beginWith({});
        if (result.status !== 'ok') throw new Error(result.status);
        // A rotation moved the parent's epoch while the bytes uploaded: begin's node is stale.
        await db
            .update(driveNodes)
            .set({ keyEpoch: await epoch() })
            .where(eq(driveNodes.id, rootId));
        await drive.startCompleting(owner.workspaceId, result.uploadId);
        expect(
            (await drive.finishCompleting(owner.workspaceId, result.uploadId, 4096n)).status,
        ).toBe('conflicted');
        const [root] = await db.transaction((tx) => drive.selectNodes(tx, [rootId]));
        const siblingId = randomUUID();
        const metadata = metadataEnvelope();
        const content = randomBytes(84);
        const attach = async (signedNodeId: string) =>
            drive.attachUpload(owner.workspaceId, result.uploadId, {
                mode: 'sibling',
                userId: owner.userId,
                contentKeyEnvelope: content,
                versionSignature: signVersion(
                    ownerKey,
                    { nodeId: signedNodeId, versionId, objectId, contentSuite: 3 },
                    content,
                ),
                node: {
                    id: siblingId,
                    parentId: rootId,
                    keyEpoch: await epoch(),
                    parentKeyEpoch: root!.keyEpoch,
                    keyEnvelope: keyEnvelope(),
                    metadataEnvelope: metadata,
                    metadataSignature: signMetadata(ownerKey, siblingId, 'file', metadata),
                },
            });
        expect((await attach(nodeId)).status).toBe('bad-signature');
        const attached = await attach(siblingId);
        if (attached.status !== 'published') throw new Error(attached.status);
        expect(attached.node.id).toBe(siblingId);
        expect(attached.node.currentVersion?.signature).toHaveLength(64);
    });
});

describe('rotation', () => {
    test('a rotated node needs the rotating account’s signature over its unchanged metadata version', async () => {
        const started = await rotations.startRotation({
            workspaceId: owner.workspaceId,
            nodeId: rootId,
            startedBy: owner.userId,
        });
        if (started.status !== 'ok') throw new Error(started.status);
        const [root] = await db.transaction((tx) => drive.selectNodes(tx, [rootId]));
        const envelope = metadataEnvelope();
        const rotate = (signature: Buffer) =>
            rotations.rotateNodes({
                workspaceId: owner.workspaceId,
                rootId,
                targetEpoch: started.rotation.targetEpoch,
                userId: owner.userId,
                nodes: [
                    {
                        id: rootId,
                        changeSeq: root!.changeSeq!,
                        parentKeyEpoch: root!.parentKeyEpoch,
                        keyEnvelope: keyEnvelope(),
                        rotated: {
                            metadataEnvelope: envelope,
                            metadataSignature: signature,
                            versions: [],
                            shares: [],
                            links: [],
                            unsealableLinks: [],
                        },
                    },
                ],
            });
        // A rotation does not bump the metadata version, so a signature over the next one fails.
        expect(
            await rotate(
                signMetadata(ownerKey, rootId, 'folder', envelope, root!.metadataVersion + 1),
            ),
        ).toEqual([{ id: rootId, status: 'bad-signature' }]);
        expect((await nodeRow(rootId))?.keyEpoch).toBe(rootEpoch);
        expect(
            await rotate(signMetadata(ownerKey, rootId, 'folder', envelope, root!.metadataVersion)),
        ).toEqual([{ id: rootId, status: 'ok' }]);
        expect((await nodeRow(rootId))?.keyEpoch).toBe(started.rotation.targetEpoch);
    });
});
