import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, createTestAccount, resetDatabase } from '../test/helpers';
import { db } from './client';
import * as drive from './drive';
import { driveLinks } from './schema';

/*
 * Links are resolved by the hash of a token the server never stores in the
 * clear, answer only while live and unexpired and while the node is outside
 * the trash, and authorize exactly the subtree beneath the linked node.
 */

const MiB = 1024n * 1024n;
const keyEnvelope = () => randomBytes(72);
const metadataEnvelope = () => randomBytes(100);
const hash = (token: string) => createHash('sha256').update(token).digest();

let owner: Awaited<ReturnType<typeof createTestAccount>>;
let rootId: string;
let rootEpoch: number;

async function epoch() {
    const range = await drive.allocateKeyEpochs(owner.workspaceId, 1);
    return range!.from;
}
async function folder(parentId: string, parentKeyEpoch: number) {
    const id = randomUUID();
    const created = await drive.createFolders({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
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
async function file(parentId: string, parentKeyEpoch: number) {
    const plaintext = 1n * MiB;
    const objectId = randomUUID();
    const begun = await drive.beginUpload({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
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
            objectKey: `ws/${owner.workspaceId}/${objectId}`,
            contentSuite: 2,
            chunkSize: Number(8n * MiB),
            chunkCount: 1,
            contentNonce: randomBytes(16),
            ciphertextSize: plaintext + 16n,
        },
        multipartId: `mp-${objectId}`,
        expiresAt: new Date(Date.now() + 3600_000),
    });
    if (begun.status !== 'ok') throw new Error(begun.status);
    const started = await drive.startCompleting(owner.workspaceId, begun.uploadId);
    if (started.status !== 'ok') throw new Error(started.status);
    const done = await drive.finishCompleting(owner.workspaceId, begun.uploadId, plaintext + 16n);
    if (done.status !== 'published') throw new Error(done.status);
    return done.node;
}
async function link(
    node: { id: string; keyEpoch: number },
    token: string,
    overrides: Partial<drive.CreateLink> = {},
) {
    return drive.createLink({
        id: randomUUID(),
        workspaceId: owner.workspaceId,
        nodeId: node.id,
        granterUserId: owner.userId,
        tokenHash: hash(token),
        keyEpoch: node.keyEpoch,
        linkEnvelope: keyEnvelope(),
        linkSalt: randomBytes(16),
        secretEnvelope: randomBytes(104),
        hasPassword: false,
        expiresAt: null,
        ...overrides,
    });
}

beforeEach(async () => {
    await resetDatabase();
    owner = await createTestAccount();
    const created = await drive.createRoot({
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

describe('links', () => {
    test('resolve by token hash while live, unexpired, and the node is outside the trash', async () => {
        const project = await folder(rootId, rootEpoch);
        const made = await link(project, 'token-a');
        if (made.status !== 'ok') throw new Error(made.status);
        expect(made.link.tokenHash.equals(hash('token-a'))).toBe(true);

        const resolved = await drive.resolveLink(hash('token-a'));
        expect(resolved?.node.id).toBe(project.id);
        expect(resolved?.link.linkEnvelope).toHaveLength(72);
        expect(await drive.resolveLink(hash('token-b'))).toBeNull();

        // Expired, trashed, and revoked all look the same from outside.
        const expired = await link(project, 'token-old', {
            expiresAt: new Date(Date.now() - 1000),
        });
        expect(expired.status).toBe('ok');
        expect(await drive.resolveLink(hash('token-old'))).toBeNull();
        await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: project.id });
        expect(await drive.resolveLink(hash('token-a'))).toBeNull();
        expect((await link(project, 'token-c')).status).toBe('trashed');
        await drive.restoreNode({ workspaceId: owner.workspaceId, nodeId: project.id });
        expect(await drive.resolveLink(hash('token-a'))).not.toBeNull();
        expect(await drive.revokeLink(owner.workspaceId, made.link.id)).toMatchObject({
            nodeId: project.id,
        });
        expect(await drive.resolveLink(hash('token-a'))).toBeNull();
        expect(await drive.revokeLink(owner.workspaceId, made.link.id)).toBeNull();
        // The owner's list shows only live links, and never the token.
        const listed = await drive.listNodeLinks(owner.workspaceId, project.id);
        expect(listed.map((row) => row.id)).toEqual([
            expired.status === 'ok' ? expired.link.id : '',
        ]);
        expect(Object.keys(listed[0]!)).not.toContain('tokenHash');
        expect((await link({ id: project.id, keyEpoch: project.keyEpoch + 1 }, 'x')).status).toBe(
            'stale',
        );
    });

    test('authorizes exactly the subtree beneath the linked node', async () => {
        const project = await folder(rootId, rootEpoch);
        const inner = await folder(project.id, project.keyEpoch);
        const insideFile = await file(inner.id, inner.keyEpoch);
        const outside = await folder(rootId, rootEpoch);
        const outsideFile = await file(rootId, rootEpoch);
        const made = await link(project, 'token-a');
        if (made.status !== 'ok') throw new Error(made.status);

        expect(await drive.authorizeLink(hash('token-a'), project.id)).toMatchObject({
            linkId: made.link.id,
            boundary: project.id,
        });
        expect(await drive.authorizeLink(hash('token-a'), inner.id)).toMatchObject({
            boundary: project.id,
        });
        expect(await drive.authorizeLink(hash('token-a'), insideFile.id)).not.toBeNull();
        expect(await drive.authorizeLink(hash('token-a'), outside.id)).toBeNull();
        expect(await drive.authorizeLink(hash('token-a'), rootId)).toBeNull();
        expect(await drive.authorizeLink(hash('nope'), inner.id)).toBeNull();

        const versions = await drive.authorizeLinkVersions(hash('token-a'), [
            insideFile.currentVersionId!,
            outsideFile.currentVersionId!,
        ]);
        expect(versions.allowed).toEqual(new Set([insideFile.currentVersionId]));
        expect(versions.workspaceId).toBe(owner.workspaceId);

        // A trashed folder inside the link takes its contents out of reach.
        await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: inner.id });
        expect(await drive.authorizeLink(hash('token-a'), insideFile.id)).toBeNull();
        expect(await drive.authorizeLink(hash('token-a'), project.id)).not.toBeNull();
    });

    test('use is counted at most once a minute', async () => {
        const project = await folder(rootId, rootEpoch);
        const made = await link(project, 'token-a');
        if (made.status !== 'ok') throw new Error(made.status);
        await drive.touchLink(made.link.id);
        await drive.touchLink(made.link.id);
        const [row] = await db.select().from(driveLinks).where(eq(driveLinks.id, made.link.id));
        expect(row?.useCount).toBe(1);
        expect(row?.lastUsedAt).not.toBeNull();
    });
});

describe('updating a link', () => {
    test('changes the seal or the expiry in place and refuses a moved epoch', async () => {
        const project = await folder(rootId, rootEpoch);
        const made = await link(project, 'token-a');
        if (made.status !== 'ok') throw new Error(made.status);
        const seal = {
            linkEnvelope: randomBytes(72),
            linkSalt: randomBytes(16),
            hasPassword: true,
        };
        const updated = await drive.updateLink({
            workspaceId: owner.workspaceId,
            linkId: made.link.id,
            keyEpoch: project.keyEpoch,
            seal,
            expiresAt: new Date(Date.now() + 86_400_000),
        });
        if (updated.status !== 'ok') throw new Error(updated.status);
        expect(updated.link.hasPassword).toBe(true);
        expect(updated.link.expiresAt).not.toBeNull();
        const resolved = await drive.resolveLink(hash('token-a'));
        expect(resolved?.link.linkEnvelope.equals(seal.linkEnvelope)).toBe(true);
        expect(resolved?.link.linkSalt.equals(seal.linkSalt)).toBe(true);
        // The token and the owner's secret envelope are untouched: the link itself did not change.
        expect(resolved?.link.secretEnvelope?.equals(made.link.secretEnvelope!)).toBe(true);
        expect(
            (
                await drive.updateLink({
                    workspaceId: owner.workspaceId,
                    linkId: made.link.id,
                    keyEpoch: project.keyEpoch + 1,
                    expiresAt: null,
                })
            ).status,
        ).toBe('stale');
        await drive.revokeLink(owner.workspaceId, made.link.id);
        expect(
            (
                await drive.updateLink({
                    workspaceId: owner.workspaceId,
                    linkId: made.link.id,
                    keyEpoch: project.keyEpoch,
                    expiresAt: null,
                })
            ).status,
        ).toBe('not-found');
    });
});
