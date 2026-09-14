import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, createTestAccount, resetDatabase } from '../test/helpers';
import { db } from './client';
import * as drive from './drive';
import * as rotations from './rotations';
import { accountIdentities, driveLinks, driveNodes, driveShares, workspaceKeys } from './schema';

/*
 * Rotation on the server: one per workspace, work listed parents first and
 * only for what is still below the target, batches refused when stale or
 * out of order, previous envelopes kept until the finish clears them, shares
 * and links re-sealed or revoked, and moves out of the subtree refused while
 * it runs.
 */

const MiB = 1024n * 1024n;
const env = () => randomBytes(72);
const meta = () => randomBytes(100);
const hash = (value: string) => createHash('sha256').update(value).digest();

let owner: Awaited<ReturnType<typeof createTestAccount>>;
let guest: Awaited<ReturnType<typeof createTestAccount>>;
let rootId: string;
let rootEpoch: number;

async function epoch() {
    return (await drive.allocateKeyEpochs(owner.workspaceId, 1))!.from;
}
async function folder(parentId: string, parentKeyEpoch: number) {
    const created = await drive.createFolders({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        folders: [
            {
                id: randomUUID(),
                parentId,
                envelopes: {
                    keyEpoch: await epoch(),
                    parentKeyEpoch,
                    keyEnvelope: env(),
                    metadataEnvelope: meta(),
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
                keyEnvelope: env(),
                metadataEnvelope: meta(),
            },
        },
        version: { id: randomUUID(), contentKeyEnvelope: env() },
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
    await drive.startCompleting(owner.workspaceId, begun.uploadId);
    const done = await drive.finishCompleting(owner.workspaceId, begun.uploadId, plaintext + 16n);
    if (done.status !== 'published') throw new Error(done.status);
    return done.node;
}
async function current(id: string) {
    const [row] = await db.select().from(driveNodes).where(eq(driveNodes.id, id));
    return row!;
}
function rotated(
    node: { id: string; changeSeq: number | null },
    parentKeyEpoch: number,
    extra: Partial<NonNullable<rotations.RotatedNodeInput['rotated']>> = {},
) {
    return {
        id: node.id,
        changeSeq: node.changeSeq!,
        parentKeyEpoch,
        keyEnvelope: env(),
        rotated: {
            metadataEnvelope: meta(),
            versions: [],
            shares: [],
            links: [],
            unsealableLinks: [],
            ...extra,
        },
    };
}

beforeEach(async () => {
    await resetDatabase();
    owner = await createTestAccount();
    guest = await createTestAccount();
    await db.insert(workspaceKeys).values({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        keyVersion: 1,
        wrappingSalt: randomBytes(32),
        wrappingNonce: randomBytes(24),
        encryptedKey: randomBytes(48),
    });
    for (const userId of [owner.userId, guest.userId])
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
    const created = await drive.createRoot({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        id: randomUUID(),
        envelopes: {
            keyEpoch: await epoch(),
            parentKeyEpoch: 1,
            keyEnvelope: env(),
            metadataEnvelope: meta(),
        },
    });
    if (created.status !== 'created') throw new Error(created.status);
    rootId = created.root.id;
    rootEpoch = created.root.keyEpoch;
});
afterAll(closeDatabase);

describe('rotation', () => {
    test('runs one at a time, lists work parents first, applies in order, and finishes clean', async () => {
        const project = await folder(rootId, rootEpoch);
        const inner = await folder(project.id, project.keyEpoch);
        const doc = await file(inner.id, inner.keyEpoch);
        const outside = await folder(rootId, rootEpoch);
        const shared = await drive.createShare({
            workspaceId: owner.workspaceId,
            nodeId: project.id,
            granterUserId: owner.userId,
            granteeUserId: guest.userId,
            role: 'viewer',
            keyEpoch: project.keyEpoch,
            shareEnvelope: env(),
        });
        if (shared.status !== 'ok') throw new Error(shared.status);
        const linked = await drive.createLink({
            id: randomUUID(),
            workspaceId: owner.workspaceId,
            nodeId: inner.id,
            granterUserId: owner.userId,
            tokenHash: hash('t1'),
            keyEpoch: inner.keyEpoch,
            linkEnvelope: env(),
            linkSalt: randomBytes(16),
            secretEnvelope: randomBytes(136),
            hasPassword: true,
            expiresAt: null,
        });
        if (linked.status !== 'ok') throw new Error(linked.status);
        const legacy = await drive.createLink({
            id: randomUUID(),
            workspaceId: owner.workspaceId,
            nodeId: inner.id,
            granterUserId: owner.userId,
            tokenHash: hash('t2'),
            keyEpoch: inner.keyEpoch,
            linkEnvelope: env(),
            linkSalt: randomBytes(16),
            secretEnvelope: randomBytes(104),
            hasPassword: true,
            expiresAt: null,
        });
        if (legacy.status !== 'ok') throw new Error(legacy.status);

        const started = await rotations.startRotation({
            workspaceId: owner.workspaceId,
            nodeId: project.id,
            startedBy: owner.userId,
        });
        if (started.status !== 'ok') throw new Error(started.status);
        const { targetEpoch } = started.rotation;
        expect(targetEpoch).toBeGreaterThan(doc.keyEpoch);
        expect(
            (
                await rotations.startRotation({
                    workspaceId: owner.workspaceId,
                    nodeId: outside.id,
                    startedBy: null,
                })
            ).status,
        ).toBe('active');
        expect((await drive.getPersonalWorkspace(owner.userId))?.rotation?.nodeId).toBe(project.id);

        const ws = { workspaceId: owner.workspaceId, rootId: project.id, targetEpoch };
        const work = await rotations.listRotationWork(ws);
        expect(work.nodes.map((n) => n.id)).toEqual([project.id, inner.id, doc.id]);
        expect(work.nodes[0]!.shares.map((s) => s.granteeUserId)).toEqual([guest.userId]);
        expect(work.nodes[0]!.shares[0]!.granteePublicKey).toHaveLength(32);
        expect(work.nodes[1]!.links.map((l) => l.id).sort()).toEqual(
            [linked.link.id, legacy.link.id].sort(),
        );
        expect(work.nodes[2]!.versions.map((v) => v.id)).toEqual([doc.currentVersionId]);
        expect(work.nextCursor).toBeNull();
        // The sibling outside the subtree is not work.
        expect(work.nodes.some((n) => n.id === outside.id)).toBe(false);

        // A child before its parent is refused; a stale change sequence is refused.
        expect(
            await rotations.rotateNodes({ ...ws, nodes: [rotated(inner, targetEpoch)] }),
        ).toEqual([{ id: inner.id, status: 'parent-not-ready' }]);
        expect(
            await rotations.rotateNodes({
                ...ws,
                nodes: [rotated({ id: project.id, changeSeq: project.changeSeq! - 1 }, rootEpoch)],
            }),
        ).toEqual([{ id: project.id, status: 'stale' }]);

        // The root, with its share re-sealed; the previous envelope and grant stay.
        const first = await rotations.rotateNodes({
            ...ws,
            nodes: [
                rotated(project, rootEpoch, {
                    shares: [{ id: shared.share.id, shareEnvelope: env() }],
                }),
            ],
        });
        expect(first).toEqual([{ id: project.id, status: 'ok' }]);
        const afterRoot = await current(project.id);
        expect(afterRoot.keyEpoch).toBe(targetEpoch);
        expect(afterRoot.prevKeyEnvelope?.equals(project.keyEnvelope!)).toBe(true);
        expect(afterRoot.prevKeyEpoch).toBe(project.keyEpoch);
        expect(afterRoot.prevParentKeyEpoch).toBe(rootEpoch);
        const [share] = await db
            .select()
            .from(driveShares)
            .where(eq(driveShares.id, shared.share.id));
        expect(share?.keyEpoch).toBe(targetEpoch);
        expect(share?.prevKeyEpoch).toBe(project.keyEpoch);
        expect(share?.prevShareEnvelope).toHaveLength(72);
        expect(share?.revokedAt).toBeNull();
        // The grantee's view carries both envelopes mid-rotation.
        const mine = await drive.listSharesForGrantee(guest.userId);
        expect(mine[0]?.prevKeyEpoch).toBe(project.keyEpoch);

        // Work now excludes the root; the same batch again is stale (the row moved on).
        expect((await rotations.listRotationWork(ws)).nodes.map((n) => n.id)).toEqual([
            inner.id,
            doc.id,
        ]);
        expect(
            await rotations.rotateNodes({ ...ws, nodes: [rotated(project, rootEpoch)] }),
        ).toEqual([{ id: project.id, status: 'stale' }]);

        // While it runs: nothing leaves the subtree, and a reached node cannot move.
        expect(
            (
                await drive.moveNode({
                    workspaceId: owner.workspaceId,
                    nodeId: inner.id,
                    parentId: outside.id,
                    parentKeyEpoch: outside.keyEpoch,
                    keyEnvelope: env(),
                })
            ).status,
        ).toBe('rotating');
        expect(
            (
                await drive.moveNode({
                    workspaceId: owner.workspaceId,
                    nodeId: project.id,
                    parentId: outside.id,
                    parentKeyEpoch: outside.keyEpoch,
                    keyEnvelope: env(),
                })
            ).status,
        ).toBe('rotating');
        // Moving in stays allowed.
        expect(
            (
                await drive.moveNode({
                    workspaceId: owner.workspaceId,
                    nodeId: outside.id,
                    parentId: project.id,
                    parentKeyEpoch: targetEpoch,
                    keyEnvelope: env(),
                })
            ).status,
        ).toBe('ok');
        // ...and it becomes work: its own epoch is below the target.
        expect((await rotations.listRotationWork(ws)).nodes.map((n) => n.id).sort()).toEqual(
            [inner.id, doc.id, outside.id].sort(),
        );

        // inner: one link re-sealed, the legacy password link cannot be and is revoked.
        const innerNow = await current(inner.id);
        const second = await rotations.rotateNodes({
            ...ws,
            nodes: [
                rotated(innerNow, targetEpoch, {
                    links: [
                        {
                            id: linked.link.id,
                            linkEnvelope: env(),
                            secretEnvelope: randomBytes(136),
                        },
                    ],
                    unsealableLinks: [legacy.link.id],
                }),
            ],
        });
        expect(second).toEqual([{ id: inner.id, status: 'ok' }]);
        expect(await drive.resolveLink(hash('t1'))).not.toBeNull();
        expect((await drive.resolveLink(hash('t1')))?.link.keyEpoch).toBe(targetEpoch);
        expect(await drive.resolveLink(hash('t2'))).toBeNull();

        // The file's version envelope is replaced.
        const docNow = await current(doc.id);
        const newContent = env();
        expect(
            await rotations.rotateNodes({
                ...ws,
                nodes: [
                    rotated(docNow, targetEpoch, {
                        versions: [{ id: doc.currentVersionId!, contentKeyEnvelope: newContent }],
                    }),
                ],
            }),
        ).toEqual([{ id: doc.id, status: 'ok' }]);
        const listed = await drive.listVersions(owner.workspaceId, doc.id);
        expect(listed?.versions[0]?.contentKeyEnvelope?.equals(newContent)).toBe(true);
        expect((await current(doc.id)).prevKeyEnvelope).toHaveLength(72);

        // Not finished while work remains; the moved-in folder is rotated last.
        expect(await rotations.finishRotation(ws)).toBe(false);
        const outsideNow = await current(outside.id);
        await rotations.rotateNodes({ ...ws, nodes: [rotated(outsideNow, targetEpoch)] });
        expect((await rotations.listRotationWork(ws)).nodes).toEqual([]);
        expect(await rotations.finishRotation(ws)).toBe(true);
        for (const id of [project.id, inner.id, doc.id, outside.id]) {
            const row = await current(id);
            expect(row.prevKeyEnvelope).toBeNull();
            expect(row.prevKeyEpoch).toBeNull();
            expect(row.keyEpoch).toBe(targetEpoch);
        }
        const [cleared] = await db
            .select()
            .from(driveShares)
            .where(eq(driveShares.id, shared.share.id));
        expect(cleared?.prevShareEnvelope).toBeNull();
        expect(await rotations.getRotation(owner.workspaceId, project.id)).toBeNull();
        expect((await drive.getPersonalWorkspace(owner.userId))?.rotation).toBeNull();
        // A second rotation may start now, and moves out are allowed again.
        expect(
            (
                await rotations.startRotation({
                    workspaceId: owner.workspaceId,
                    nodeId: inner.id,
                    startedBy: null,
                })
            ).status,
        ).toBe('ok');
    });

    test('a node at the target under an unrotated parent is a rewrap, and a share left unsealed is revoked', async () => {
        const project = await folder(rootId, rootEpoch);
        const inner = await folder(project.id, project.keyEpoch);
        const shared = await drive.createShare({
            workspaceId: owner.workspaceId,
            nodeId: inner.id,
            granterUserId: owner.userId,
            granteeUserId: guest.userId,
            role: 'viewer',
            keyEpoch: inner.keyEpoch,
            shareEnvelope: env(),
        });
        if (shared.status !== 'ok') throw new Error(shared.status);
        const started = await rotations.startRotation({
            workspaceId: owner.workspaceId,
            nodeId: project.id,
            startedBy: null,
        });
        if (started.status !== 'ok') throw new Error(started.status);
        const ws = {
            workspaceId: owner.workspaceId,
            rootId: project.id,
            targetEpoch: started.rotation.targetEpoch,
        };
        await rotations.rotateNodes({ ...ws, nodes: [rotated(project, rootEpoch)] });
        // A folder created under the rotated root draws an epoch above the target but is
        // wrapped under... the new key already, so it is not work. Create one under the
        // unrotated child instead: wrapped under inner's old key, its own epoch above target.
        const late = await folder(inner.id, inner.keyEpoch);
        expect(late.keyEpoch).toBeGreaterThan(ws.targetEpoch);
        // inner rotates; the share on it is not re-sealed by the client: revoked, not left dead.
        const innerNow = await current(inner.id);
        await rotations.rotateNodes({ ...ws, nodes: [rotated(innerNow, ws.targetEpoch)] });
        const [share] = await db
            .select()
            .from(driveShares)
            .where(eq(driveShares.id, shared.share.id));
        expect(share?.revokedAt).not.toBeNull();
        // late is work by its parent epoch alone, and applies as a rewrap.
        const work = await rotations.listRotationWork(ws);
        expect(work.nodes.map((n) => n.id)).toEqual([late.id]);
        const lateNow = await current(late.id);
        expect(
            await rotations.rotateNodes({
                ...ws,
                nodes: [
                    {
                        id: late.id,
                        changeSeq: lateNow.changeSeq!,
                        parentKeyEpoch: ws.targetEpoch,
                        keyEnvelope: env(),
                        rotated: null,
                    },
                ],
            }),
        ).toEqual([{ id: late.id, status: 'ok' }]);
        const lateAfter = await current(late.id);
        expect(lateAfter.keyEpoch).toBe(late.keyEpoch);
        expect(lateAfter.parentKeyEpoch).toBe(ws.targetEpoch);
        expect(lateAfter.prevKeyEnvelope).toBeNull();
        // Sending a full rotation for a rewrap, or a rewrap for a rotation, is refused.
        expect(
            (
                await rotations.rotateNodes({
                    ...ws,
                    nodes: [rotated(await current(late.id), ws.targetEpoch)],
                })
            )[0]?.status,
        ).toBe('stale');
        expect(await rotations.finishRotation(ws)).toBe(true);
        expect((await db.select().from(driveLinks)).length).toBe(0);
    });
});
