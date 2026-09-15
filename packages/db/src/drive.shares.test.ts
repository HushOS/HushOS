import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, createTestAccount, resetDatabase } from '../test/helpers';
import { db } from './client';
import * as drive from './drive';
import { accountIdentities, workspaceKeys } from './schema';

/*
 * Authorization is the walk. A member owns everything; a grantee holds the
 * role of the nearest live share above the node; a stranger and a revoked
 * grantee get nothing, which is the same answer as a node that does not exist.
 */

const MiB = 1024n * 1024n;
const keyEnvelope = () => randomBytes(72);
const metadataEnvelope = () => randomBytes(100);

let owner: Awaited<ReturnType<typeof createTestAccount>>;
let guest: Awaited<ReturnType<typeof createTestAccount>>;
let stranger: Awaited<ReturnType<typeof createTestAccount>>;
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
    return { node: done.node, uploadId: begun.uploadId };
}
async function share(
    node: { id: string; keyEpoch: number },
    granteeUserId: string,
    role: 'viewer' | 'editor' = 'viewer',
    overrides: Partial<drive.CreateShare> = {},
) {
    return drive.createShare({
        workspaceId: owner.workspaceId,
        nodeId: node.id,
        granterUserId: owner.userId,
        granteeUserId,
        role,
        keyEpoch: node.keyEpoch,
        shareEnvelope: keyEnvelope(),
        ...overrides,
    });
}
async function identityFor(userId: string) {
    await db.insert(accountIdentities).values({
        userId,
        wrappingSalt: randomBytes(32),
        encryptionPublicKey: randomBytes(32),
        encryptionPrivateKeyNonce: randomBytes(24),
        encryptedEncryptionPrivateKey: randomBytes(48),
        signingPublicKey: randomBytes(32),
        signingSeedNonce: randomBytes(24),
        encryptedSigningSeed: randomBytes(48),
    });
}

beforeEach(async () => {
    await resetDatabase();
    owner = await createTestAccount();
    guest = await createTestAccount();
    stranger = await createTestAccount();
    // The owner is a member of their workspace; the others are not.
    await db.insert(workspaceKeys).values({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        keyVersion: 1,
        wrappingSalt: randomBytes(32),
        wrappingNonce: randomBytes(24),
        encryptedKey: randomBytes(48),
    });
    await identityFor(owner.userId);
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

describe('authorization', () => {
    test('a member owns everything; a grantee holds the nearest share’s role; a stranger has nothing', async () => {
        const project = await folder(rootId, rootEpoch);
        const inner = await folder(project.id, project.keyEpoch);
        const deep = await folder(inner.id, inner.keyEpoch);
        const sibling = await folder(rootId, rootEpoch);

        expect(await drive.authorize(owner.userId, owner.workspaceId, deep.id)).toMatchObject({
            role: 'owner',
            shareId: null,
        });
        expect(await drive.authorize(guest.userId, owner.workspaceId, deep.id)).toBeNull();

        const outer = await share(project, guest.userId, 'viewer');
        if (outer.status !== 'ok') throw new Error(outer.status);
        const nearer = await share(inner, guest.userId, 'editor');
        if (nearer.status !== 'ok') throw new Error(nearer.status);

        expect(await drive.authorize(guest.userId, owner.workspaceId, project.id)).toMatchObject({
            role: 'viewer',
            shareId: outer.share.id,
            shareRootId: project.id,
        });
        // The nearer share wins on the subtree it covers, whatever the outer one says.
        expect(await drive.authorize(guest.userId, owner.workspaceId, deep.id)).toMatchObject({
            role: 'editor',
            shareId: nearer.share.id,
            shareRootId: inner.id,
        });
        expect(await drive.authorize(guest.userId, owner.workspaceId, sibling.id)).toBeNull();
        expect(await drive.authorize(guest.userId, owner.workspaceId, rootId)).toBeNull();
        expect(await drive.authorize(stranger.userId, owner.workspaceId, deep.id)).toBeNull();
        // The workspace named must be the node's: a share does not leak across.
        expect(await drive.authorize(guest.userId, guest.workspaceId, deep.id)).toBeNull();
        expect(drive.atLeast('editor', 'viewer')).toBe(true);
        expect(drive.atLeast('viewer', 'editor')).toBe(false);
    });

    test('revocation takes effect on the next check, and versions are filtered by access', async () => {
        const project = await folder(rootId, rootEpoch);
        const shared = await file(project.id, project.keyEpoch);
        const outside = await file(rootId, rootEpoch);
        const granted = await share(project, guest.userId);
        if (granted.status !== 'ok') throw new Error(granted.status);
        const versionIds = [
            shared.node.currentVersionId!,
            outside.node.currentVersionId!,
            randomUUID(),
        ];
        expect(await drive.authorizeVersions(guest.userId, owner.workspaceId, versionIds)).toEqual(
            new Set([shared.node.currentVersionId]),
        );
        expect(await drive.authorizeVersions(owner.userId, owner.workspaceId, versionIds)).toEqual(
            new Set([shared.node.currentVersionId, outside.node.currentVersionId]),
        );
        expect(
            (
                await drive.authorizeVersion(
                    guest.userId,
                    owner.workspaceId,
                    shared.node.currentVersionId!,
                )
            )?.role,
        ).toBe('viewer');
        expect(
            (await drive.authorizeUpload(guest.userId, owner.workspaceId, shared.uploadId))?.role,
        ).toBe('viewer');

        expect(await drive.revokeShare(owner.workspaceId, granted.share.id)).toMatchObject({
            nodeId: project.id,
        });
        expect(await drive.authorize(guest.userId, owner.workspaceId, shared.node.id)).toBeNull();
        expect(await drive.authorizeVersions(guest.userId, owner.workspaceId, versionIds)).toEqual(
            new Set(),
        );
        // Revoking twice is not a second revocation.
        expect(await drive.revokeShare(owner.workspaceId, granted.share.id)).toBeNull();
        expect(await drive.listSharesForGrantee(guest.userId)).toEqual([]);
    });
});

describe('shares', () => {
    test('create needs the current epoch and a live node; re-sharing replaces; the grantee sees the node', async () => {
        const project = await folder(rootId, rootEpoch);
        expect(
            (await share({ id: project.id, keyEpoch: project.keyEpoch + 1 }, guest.userId)).status,
        ).toBe('stale');
        expect((await share(project, owner.userId)).status).toBe('self');
        expect((await share({ id: randomUUID(), keyEpoch: 1 }, guest.userId)).status).toBe(
            'not-found',
        );

        const first = await share(project, guest.userId, 'viewer');
        if (first.status !== 'ok') throw new Error(first.status);
        const again = await share(project, guest.userId, 'editor');
        if (again.status !== 'ok') throw new Error(again.status);
        expect(again.replaced).toBe(true);
        expect(again.share.id).toBe(first.share.id);
        const listed = await drive.listNodeShares(owner.workspaceId, project.id);
        expect(listed.map((row) => [row.grantee.id, row.role])).toEqual([[guest.userId, 'editor']]);

        const mine = await drive.listSharesForGrantee(guest.userId);
        expect(mine).toHaveLength(1);
        expect(mine[0]!.node.id).toBe(project.id);
        expect(mine[0]!.workspaceId).toBe(owner.workspaceId);
        expect(mine[0]!.granter.id).toBe(owner.userId);
        expect(mine[0]!.granter.encryptionPublicKey).toHaveLength(32);
        expect(mine[0]!.shareEnvelope).toHaveLength(72);

        // A trashed node cannot be shared, and an existing share on it is not listed.
        await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: project.id });
        expect((await share(project, stranger.userId)).status).toBe('trashed');
        expect(await drive.listSharesForGrantee(guest.userId)).toEqual([]);
        await drive.restoreNode({ workspaceId: owner.workspaceId, nodeId: project.id });
        expect(await drive.listSharesForGrantee(guest.userId)).toHaveLength(1);
    });

    test('a grantee’s listing stops at the share root', async () => {
        const project = await folder(rootId, rootEpoch);
        const inner = await folder(project.id, project.keyEpoch);
        await folder(inner.id, inner.keyEpoch);
        const listing = await drive.listChildren({
            workspaceId: owner.workspaceId,
            parentId: inner.id,
            boundary: project.id,
        });
        if (listing.status !== 'ok') throw new Error(listing.status);
        expect(listing.ancestors.map((row) => row.id)).toEqual([project.id]);
        const top = await drive.listChildren({
            workspaceId: owner.workspaceId,
            parentId: project.id,
            boundary: project.id,
        });
        if (top.status !== 'ok') throw new Error(top.status);
        expect(top.ancestors).toEqual([]);
        const owners = await drive.listChildren({
            workspaceId: owner.workspaceId,
            parentId: inner.id,
        });
        if (owners.status !== 'ok') throw new Error(owners.status);
        expect(owners.ancestors.map((row) => row.id)).toEqual([rootId, project.id]);
    });
});

describe('shares and the trash', () => {
    test('the granter’s listing hides what is in the trash, by itself or by an ancestor, until restored', async () => {
        const outer = await folder(rootId, rootEpoch);
        const project = await folder(outer.id, outer.keyEpoch);
        const shared = await share(project, guest.userId);
        if (shared.status !== 'ok') throw new Error(shared.status);
        const mine = async () =>
            (await drive.listSharesByGranter(owner.userId)).map((row) => row.node.id);
        expect(await mine()).toEqual([project.id]);
        await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: project.id });
        expect(await mine()).toEqual([]);
        await drive.restoreNode({ workspaceId: owner.workspaceId, nodeId: project.id });
        expect(await mine()).toEqual([project.id]);
        // An ancestor in the trash cuts the share off the same way, on both sides.
        await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: outer.id });
        expect(await mine()).toEqual([]);
        expect(await drive.listSharesForGrantee(guest.userId)).toEqual([]);
        await drive.restoreNode({ workspaceId: owner.workspaceId, nodeId: outer.id });
        expect(await mine()).toEqual([project.id]);
        expect((await drive.listSharesForGrantee(guest.userId)).map((row) => row.node.id)).toEqual([
            project.id,
        ]);
    });

    test('delete forever revokes the shares on the node and, through the fan-out, beneath it', async () => {
        const top = await folder(rootId, rootEpoch);
        const inner = await folder(top.id, top.keyEpoch);
        const keep = await folder(rootId, rootEpoch);
        for (const node of [top, inner, keep]) {
            const shared = await share(node, guest.userId);
            if (shared.status !== 'ok') throw new Error(shared.status);
        }
        await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: top.id });
        expect(
            (await drive.purgeNode({ workspaceId: owner.workspaceId, nodeId: top.id })).status,
        ).toBe('ok');
        expect(await drive.listNodeShares(owner.workspaceId, top.id)).toEqual([]);
        // The share beneath lives until the fan-out reaches its node.
        expect(await drive.listNodeShares(owner.workspaceId, inner.id)).toHaveLength(1);
        await drive.purgeDescendants(1000);
        expect(await drive.listNodeShares(owner.workspaceId, inner.id)).toEqual([]);
        expect((await drive.listSharesByGranter(owner.userId)).map((row) => row.node.id)).toEqual([
            keep.id,
        ]);
        expect((await drive.listSharesForGrantee(guest.userId)).map((row) => row.node.id)).toEqual([
            keep.id,
        ]);
    });
});
