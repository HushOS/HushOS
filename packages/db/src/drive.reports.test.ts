import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, createTestAccount, resetDatabase } from '../test/helpers';
import { db } from './client';
import * as drive from './drive';
import * as reports from './reports';
import { accountIdentities, driveObjectDeletions, users, workspaceKeys } from './schema';

/*
 * A report freezes what was reported, holds its bytes for as long as it is
 * open or held, and survives everything the owner can do to the tree. Removal
 * cuts every way in and cannot be undone by the owner.
 */

const MiB = 1024n * 1024n;
const keyEnvelope = () => randomBytes(72);
const metadataEnvelope = () => randomBytes(100);
const hash = (value: string) => createHash('sha256').update(value).digest();

let owner: Awaited<ReturnType<typeof createTestAccount>>;
let guest: Awaited<ReturnType<typeof createTestAccount>>;
let operator: Awaited<ReturnType<typeof createTestAccount>>;
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
async function report(
    node: { id: string; keyEpoch: number },
    overrides: Partial<reports.CreateReport> = {},
) {
    const operators = await reports.listOperators();
    return reports.createReport({
        id: randomUUID(),
        workspaceId: owner.workspaceId,
        nodeId: node.id,
        keyEpoch: node.keyEpoch,
        linkId: null,
        shareId: null,
        category: 'other',
        reason: 'Looks wrong.',
        reporterUserId: null,
        reporterEmail: null,
        reporterAddressHash: hash('1.2.3.4'),
        contentHash: null,
        keys: operators.map((o) => ({ operatorUserId: o.userId, keyEnvelope: randomBytes(112) })),
        ...overrides,
    });
}

beforeEach(async () => {
    await resetDatabase();
    owner = await createTestAccount();
    guest = await createTestAccount();
    operator = await createTestAccount();
    await db.insert(workspaceKeys).values({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        keyVersion: 1,
        wrappingSalt: randomBytes(32),
        wrappingNonce: randomBytes(24),
        encryptedKey: randomBytes(48),
    });
    await identityFor(owner.userId);
    await identityFor(operator.userId);
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, operator.userId));
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

describe('filing a report', () => {
    test('freezes the live subtree beneath the node and nothing else, sealed to every operator', async () => {
        const project = await folder(rootId, rootEpoch);
        const inner = await folder(project.id, project.keyEpoch);
        const inside = await file(inner.id, inner.keyEpoch);
        const gone = await file(project.id, project.keyEpoch);
        await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: gone.id });
        await file(rootId, rootEpoch); // outside the reported folder

        const made = await report(project, { reporterUserId: guest.userId });
        if (made.status !== 'ok') throw new Error(made.status);
        expect(made.report.itemCount).toBe(3);
        expect(made.report.itemsTruncated).toBe(false);
        expect(made.report.uploaderEmail).toBe(owner.email);
        expect(made.report.nodeKind).toBe('folder');
        expect(made.report.status).toBe('open');

        const top = await reports.listReportChildren(made.report.id, project.id);
        expect(top?.ancestors).toEqual([]);
        expect(top?.children.map((c) => c.nodeId)).toEqual([inner.id]);
        const deep = await reports.listReportChildren(made.report.id, inner.id);
        expect(deep?.ancestors.map((a) => a.nodeId)).toEqual([project.id]);
        expect(deep?.children[0]).toMatchObject({
            nodeId: inside.id,
            kind: 'file',
            versionId: inside.currentVersionId,
            objectKey: `ws/${owner.workspaceId}/${deep?.children[0]?.objectId}`,
            depth: 2,
        });
        expect(deep?.children[0]?.contentKeyEnvelope).toHaveLength(72);
        expect(await reports.listReportChildren(made.report.id, rootId)).toBeNull();
        expect(await reports.getReportKey(made.report.id, operator.userId)).toHaveLength(112);
        expect(await reports.getReportKey(made.report.id, guest.userId)).toBeNull();
        const detail = await reports.getReport(made.report.id);
        expect(detail?.events.map((e) => e.action)).toEqual(['reported']);

        // The same person cannot pile up open reports on one node; another person can.
        expect(await report(project, { reporterUserId: guest.userId })).toMatchObject({
            status: 'duplicate',
            reportId: made.report.id,
        });
        expect((await report(project, { reporterAddressHash: hash('9.9.9.9') })).status).toBe('ok');
        expect((await report({ id: project.id, keyEpoch: project.keyEpoch + 1 })).status).toBe(
            'stale',
        );
        expect((await report({ id: randomUUID(), keyEpoch: 1 })).status).toBe('not-found');
        expect((await report(gone)).status).toBe('not-found');
        // Sealed to a stale operator set: refused, so no operator is ever left out.
        expect(
            (
                await report(inner, {
                    keys: [{ operatorUserId: guest.userId, keyEnvelope: randomBytes(112) }],
                })
            ).status,
        ).toBe('operators-changed');
        expect((await report(inner, { keys: [] })).status).toBe('operators-changed');
    });

    test('a file report and a folder report survive the owner purging the tree', async () => {
        const project = await folder(rootId, rootEpoch);
        const doc = await file(project.id, project.keyEpoch);
        const made = await report(doc);
        if (made.status !== 'ok') throw new Error(made.status);
        expect(made.report.itemCount).toBe(1);
        await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: project.id });
        expect(
            (await drive.purgeNode({ workspaceId: owner.workspaceId, nodeId: project.id })).status,
        ).toBe('ok');
        await drive.purgeDescendants(100);
        const item = await reports.getReportItem(made.report.id, doc.id);
        expect(item?.keyEnvelope).toHaveLength(72);
        expect(item?.contentKeyEnvelope).toHaveLength(72);
        expect(
            (await reports.getReportVersions(made.report.id, [doc.currentVersionId!]))[0]
                ?.objectKey,
        ).toBe(`ws/${owner.workspaceId}/${item?.objectId}`);
    });
});

describe('holds', () => {
    test('the deletion outbox skips what an open or held report names, and drains it once released', async () => {
        const project = await folder(rootId, rootEpoch);
        const doc = await file(project.id, project.keyEpoch);
        const other = await file(rootId, rootEpoch);
        const made = await report(project);
        if (made.status !== 'ok') throw new Error(made.status);
        const objectId = (await reports.getReportItem(made.report.id, doc.id))!.objectId!;

        // The owner deletes everything forever: rows purge, objects enter the outbox.
        for (const id of [project.id, other.id])
            await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: id });
        await drive.emptyTrash(owner.workspaceId);
        await drive.purgeDescendants(100);
        const outbox = await db.select().from(driveObjectDeletions);
        expect(outbox).toHaveLength(2);
        expect(outbox.map((row) => row.objectId)).toContain(objectId);
        expect(await reports.isObjectHeld(objectId)).toBe(true);
        let pending = await drive.listPendingObjectDeletions();
        expect(pending.map((row) => row.objectId)).not.toContain(objectId);
        expect(pending).toHaveLength(1);

        // Dismissed but kept on hold: still skipped. Released: drained.
        const resolved = await reports.resolveReport(made.report.id, operator.userId, {
            status: 'dismissed',
            hold: true,
        });
        if (resolved.status !== 'ok') throw new Error(resolved.status);
        expect(resolved.report.heldAt).not.toBeNull();
        expect(await reports.isObjectHeld(objectId)).toBe(true);
        expect((await drive.listPendingObjectDeletions()).map((r) => r.objectId)).not.toContain(
            objectId,
        );
        await reports.setReportHold(made.report.id, operator.userId, false);
        expect(await reports.isObjectHeld(objectId)).toBe(false);
        pending = await drive.listPendingObjectDeletions();
        expect(pending.map((row) => row.objectId)).toContain(objectId);
        expect((await reports.getReport(made.report.id))?.events.map((e) => e.action)).toEqual([
            'reported',
            'dismissed',
            'released',
        ]);
        // Filing with an authority always holds, whatever the caller says.
        const filed = await reports.resolveReport(made.report.id, operator.userId, {
            status: 'filed',
            filedWith: 'NCMEC CyberTipline',
            filedReference: 'CT-1',
        });
        if (filed.status !== 'ok') throw new Error(filed.status);
        expect(filed.report.heldAt).not.toBeNull();
        expect(filed.report.filedWith).toBe('NCMEC CyberTipline');
        expect(await reports.isObjectHeld(objectId)).toBe(true);
        expect(
            (
                await reports.resolveReport(randomUUID(), operator.userId, {
                    status: 'dismissed',
                    hold: false,
                })
            ).status,
        ).toBe('not-found');
    });

    test('evidence bookkeeping: pending reports list their objects once, and a released dismissal purges the copy', async () => {
        const project = await folder(rootId, rootEpoch);
        const doc = await file(project.id, project.keyEpoch);
        await folder(project.id, project.keyEpoch);
        const made = await report(project);
        if (made.status !== 'ok') throw new Error(made.status);
        expect((await reports.listReportsAwaitingEvidence()).map((r) => r.id)).toEqual([
            made.report.id,
        ]);
        const toCopy = await reports.listReportObjectsToCopy(made.report.id);
        expect(toCopy.map((row) => row.nodeId)).toEqual([doc.id]);
        await reports.markReportItemCopied(made.report.id, doc.id);
        expect(await reports.listReportObjectsToCopy(made.report.id)).toEqual([]);
        await reports.setEvidenceStatus(made.report.id, 'copied');
        expect(await reports.listReportsAwaitingEvidence()).toEqual([]);
        expect(await reports.listReportsForEvidencePurge()).toEqual([]);
        await reports.resolveReport(made.report.id, operator.userId, {
            status: 'dismissed',
            hold: false,
        });
        expect((await reports.listReportsForEvidencePurge()).map((r) => r.id)).toEqual([
            made.report.id,
        ]);
        expect(
            (await reports.listReportObjectsCopied(made.report.id)).map((r) => r.nodeId),
        ).toEqual([doc.id]);
        await reports.clearReportItemCopies(made.report.id);
        await reports.setEvidenceStatus(made.report.id, 'purged');
        expect(await reports.listReportsForEvidencePurge()).toEqual([]);
        expect(await reports.countReports()).toEqual({ open: 0, held: 0, total: 1 });
    });
});

describe('removal', () => {
    test('trashes the node, revokes its shares and links, and refuses the owner’s restore', async () => {
        const project = await folder(rootId, rootEpoch);
        const inner = await folder(project.id, project.keyEpoch);
        const shared = await drive.createShare({
            workspaceId: owner.workspaceId,
            nodeId: project.id,
            granterUserId: owner.userId,
            granteeUserId: guest.userId,
            role: 'viewer',
            keyEpoch: project.keyEpoch,
            shareEnvelope: keyEnvelope(),
        });
        if (shared.status !== 'ok') throw new Error(shared.status);
        const linked = await drive.createLink({
            id: randomUUID(),
            workspaceId: owner.workspaceId,
            nodeId: inner.id,
            granterUserId: owner.userId,
            tokenHash: hash('token'),
            keyEpoch: inner.keyEpoch,
            linkEnvelope: keyEnvelope(),
            linkSalt: randomBytes(16),
            secretEnvelope: randomBytes(104),
            hasPassword: false,
            expiresAt: null,
        });
        if (linked.status !== 'ok') throw new Error(linked.status);

        expect(
            await drive.removeNode({ workspaceId: owner.workspaceId, nodeId: project.id }),
        ).toEqual({
            status: 'ok',
            shares: 1,
            links: 0,
        });
        expect(await drive.authorize(guest.userId, owner.workspaceId, project.id)).toBeNull();
        // The link sits beneath the removed folder: cut by the trashed ancestor.
        expect(await drive.resolveLink(hash('token'))).toBeNull();
        expect(
            await drive.restoreNode({ workspaceId: owner.workspaceId, nodeId: project.id }),
        ).toEqual({
            status: 'removed',
        });
        // A member's ordinary trash still restores.
        const mine = await folder(rootId, rootEpoch);
        await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: mine.id });
        expect(
            (await drive.restoreNode({ workspaceId: owner.workspaceId, nodeId: mine.id })).status,
        ).toBe('ok');
        expect(
            (await drive.removeNode({ workspaceId: owner.workspaceId, nodeId: rootId })).status,
        ).toBe('root');
        expect(
            (await drive.removeNode({ workspaceId: owner.workspaceId, nodeId: randomUUID() }))
                .status,
        ).toBe('not-found');
        // Removing again is harmless and the owner can still delete it forever.
        expect(
            (await drive.removeNode({ workspaceId: owner.workspaceId, nodeId: project.id })).status,
        ).toBe('ok');
        expect(
            (await drive.purgeNode({ workspaceId: owner.workspaceId, nodeId: project.id })).status,
        ).toBe('ok');
    });
});

describe('evidence requests', () => {
    test('an evidence request is answered once, only for a report whose copy exists, and expires away', async () => {
        const project = await folder(rootId, rootEpoch);
        const doc = await file(project.id, project.keyEpoch);
        const made = await report(project);
        if (made.status !== 'ok') throw new Error(made.status);
        expect(await reports.createEvidenceRequest(made.report.id, operator.userId)).toMatchObject({
            status: 'no-evidence',
            evidenceStatus: 'pending',
        });
        expect((await reports.createEvidenceRequest(randomUUID(), operator.userId)).status).toBe(
            'not-found',
        );
        await reports.markReportItemCopied(made.report.id, doc.id);
        await reports.setEvidenceStatus(made.report.id, 'copied');
        const created = await reports.createEvidenceRequest(made.report.id, operator.userId);
        if (created.status !== 'ok') throw new Error(created.status);
        expect((await reports.listPendingEvidenceRequests()).map((r) => r.id)).toEqual([
            created.request.id,
        ]);
        expect((await reports.listReportObjectsCopied(made.report.id))[0]?.versionId).toBe(
            doc.currentVersionId,
        );
        const expires = new Date(Date.now() + 900_000);
        const answered = await reports.answerEvidenceRequest(created.request.id, {
            status: 'ready',
            urls: { [doc.currentVersionId!]: 'https://evidence.example/x' },
            urlExpiresAt: expires,
        });
        expect(answered?.status).toBe('ready');
        expect(answered?.urls).toEqual({ [doc.currentVersionId!]: 'https://evidence.example/x' });
        // Answering again does nothing: the worker cannot overwrite what the page already read.
        expect(
            await reports.answerEvidenceRequest(created.request.id, {
                status: 'failed',
                error: 'late',
            }),
        ).toBeNull();
        expect(await reports.listPendingEvidenceRequests()).toEqual([]);
        expect(
            (
                await reports.getEvidenceRequest(made.report.id, created.request.id)
            )?.urlExpiresAt?.getTime(),
        ).toBe(expires.getTime());
        expect(await reports.getEvidenceRequest(randomUUID(), created.request.id)).toBeNull();
        expect((await reports.getReport(made.report.id))?.events.map((e) => e.action)).toContain(
            'evidence-requested',
        );
        expect(await reports.deleteStaleEvidenceRequests()).toBe(0);
    });
});

describe('re-sealing', () => {
    test('keys are added only for current operators, never replace an existing one, and show who can open', async () => {
        const project = await folder(rootId, rootEpoch);
        const made = await report(project);
        if (made.status !== 'ok') throw new Error(made.status);
        const original = (await reports.getReportKey(made.report.id, operator.userId))!;

        // A second operator promoted after the report: listed as unsealed.
        const later = await createTestAccount();
        await identityFor(later.userId);
        await db.update(users).set({ role: 'admin' }).where(eq(users.id, later.userId));
        expect(
            (await reports.listReportKeyHolders(made.report.id)).map((o) => [o.userId, o.sealed]),
        ).toEqual(
            expect.arrayContaining([
                [operator.userId, true],
                [later.userId, false],
            ]),
        );
        expect(await reports.getReportKey(made.report.id, later.userId)).toBeNull();

        const added = await reports.addReportKeys(made.report.id, operator.userId, [
            { operatorUserId: later.userId, keyEnvelope: randomBytes(112) },
            // The original operator's key must not be swapped out.
            { operatorUserId: operator.userId, keyEnvelope: randomBytes(112) },
            // A member is not an operator, whatever the caller says.
            { operatorUserId: guest.userId, keyEnvelope: randomBytes(112) },
        ]);
        expect(added).toEqual({ status: 'ok', added: 1 });
        expect(
            (await reports.getReportKey(made.report.id, operator.userId))!.equals(original),
        ).toBe(true);
        expect(await reports.getReportKey(made.report.id, later.userId)).toHaveLength(112);
        expect(await reports.getReportKey(made.report.id, guest.userId)).toBeNull();
        expect((await reports.listReportKeyHolders(made.report.id)).every((o) => o.sealed)).toBe(
            true,
        );
        expect((await reports.getReport(made.report.id))?.events.map((e) => e.action)).toEqual([
            'reported',
            'resealed',
        ]);
        // Nothing to add is not an event.
        expect(
            await reports.addReportKeys(made.report.id, operator.userId, [
                { operatorUserId: later.userId, keyEnvelope: randomBytes(112) },
            ]),
        ).toEqual({ status: 'ok', added: 0 });
        expect((await reports.getReport(made.report.id))?.events).toHaveLength(2);
        expect((await reports.addReportKeys(randomUUID(), operator.userId, [])).status).toBe(
            'not-found',
        );
    });
});
