import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
    closeDatabase,
    createTestAccount,
    createTestIdentity,
    resetDatabase,
} from '../test/helpers';
import * as signed from '../test/signed';
import { db } from './client';
import * as drive from './drive';
import * as reports from './reports';
import { driveObjectDeletions, driveReports, users, workspaceKeys } from './schema';

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
    const created = await signed.createFolders({
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
    const begun = await signed.beginUpload({
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
    await createTestIdentity(userId);
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
        // Who wrote what, as it stood: the snapshot keeps the signatures and names the signer.
        const [live] = await db.transaction((tx) => drive.selectNodes(tx, [inside.id]));
        expect(deep?.children[0]?.metadataSignature?.equals(live!.metadataSignature!)).toBe(true);
        expect(deep?.children[0]?.versionSignature?.equals(live!.currentVersion!.signature!)).toBe(
            true,
        );
        expect(deep?.children[0]?.metadataSigner).toEqual({ id: owner.userId });
        expect(deep?.children[0]?.versionSigner?.id).toBe(owner.userId);
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

    test('a key envelope is a sealed box or a hybrid envelope, and nothing between', async () => {
        const inner = await folder(rootId, rootEpoch);
        const operators = await reports.listOperators();
        // The reporter needs each operator's full identity to seal a hybrid envelope and check the binding.
        for (const operator of operators) {
            expect(operator.encryptionPublicKey).toHaveLength(32);
            expect(operator.signingPublicKey).toHaveLength(32);
            expect('kemPublicKey' in operator && 'kemSignature' in operator).toBe(true);
        }
        const hybrid = await report(inner, {
            keys: operators.map((o) => ({
                operatorUserId: o.userId,
                keyEnvelope: randomBytes(1224),
            })),
        });
        if (hybrid.status !== 'ok') throw new Error(hybrid.status);
        // Each attempt is a different reporter, so it is refused for its envelope, not as a duplicate.
        for (const size of [111, 113, 1223, 1225]) {
            await expect(
                report(inner, {
                    id: randomUUID(),
                    reporterAddressHash: hash(`reporter-${size}`),
                    keys: operators.map((o) => ({
                        operatorUserId: o.userId,
                        keyEnvelope: randomBytes(size),
                    })),
                }),
            ).rejects.toThrow();
        }
        // A later seal for a promoted operator may be hybrid while the reporter's was not.
        const later = await createTestAccount();
        await identityFor(later.userId);
        await db.update(users).set({ role: 'admin' }).where(eq(users.id, later.userId));
        const added = await reports.addReportKeys(hybrid.report.id, operators[0]!.userId, [
            { operatorUserId: later.userId, keyEnvelope: randomBytes(112) },
        ]);
        expect(added).toEqual({ status: 'ok', added: 1 });
        expect((await reports.getReportKey(hybrid.report.id, later.userId))!.length).toBe(112);
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
        // Released is final: filing it now would put the drained bytes back under a hold.
        expect(
            (
                await reports.resolveReport(made.report.id, operator.userId, {
                    status: 'filed',
                    filedWith: 'NCMEC CyberTipline',
                    filedReference: 'CT-1',
                })
            ).status,
        ).toBe('released');
        expect(await reports.isObjectHeld(objectId)).toBe(false);
        // Filing with an authority always holds, whatever the caller says.
        const second = await report(await folder(rootId, rootEpoch));
        if (second.status !== 'ok') throw new Error(second.status);
        const filed = await reports.resolveReport(second.report.id, operator.userId, {
            status: 'filed',
            filedWith: 'NCMEC CyberTipline',
            filedReference: 'CT-1',
        });
        if (filed.status !== 'ok') throw new Error(filed.status);
        expect(filed.report.heldAt).not.toBeNull();
        expect(filed.report.filedWith).toBe('NCMEC CyberTipline');
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
        // A run that failed leaves the report to be tried again; only a copy settles it.
        await reports.setEvidenceStatus(made.report.id, 'failed');
        expect((await reports.listReportsAwaitingEvidence()).map((r) => r.id)).toEqual([
            made.report.id,
        ]);
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

    test('any release purges the copy, however it closed, and a released report is never copied', async () => {
        const removed = await report(await file(rootId, rootEpoch));
        const partial = await report(await folder(rootId, rootEpoch));
        const uncopied = await report(await file(rootId, rootEpoch));
        const held = await report(await file(rootId, rootEpoch));
        if (
            removed.status !== 'ok' ||
            partial.status !== 'ok' ||
            uncopied.status !== 'ok' ||
            held.status !== 'ok'
        )
            throw new Error('not filed');
        await reports.setEvidenceStatus(removed.report.id, 'copied');
        await reports.setEvidenceStatus(partial.report.id, 'failed');
        await reports.setEvidenceStatus(held.report.id, 'copied');
        await reports.resolveReport(removed.report.id, operator.userId, {
            status: 'removed',
            hold: false,
        });
        await reports.setReportHold(partial.report.id, operator.userId, true);
        await reports.resolveReport(partial.report.id, operator.userId, {
            status: 'dismissed',
            hold: true,
        });
        await reports.setReportHold(partial.report.id, operator.userId, false);
        await reports.resolveReport(uncopied.report.id, operator.userId, {
            status: 'dismissed',
            hold: false,
        });
        await reports.resolveReport(held.report.id, operator.userId, {
            status: 'removed',
            hold: true,
        });

        expect((await reports.listReportsForEvidencePurge()).map((r) => r.id).sort()).toEqual(
            [removed.report.id, partial.report.id, uncopied.report.id].sort(),
        );
        // Released before its copy was made: there is nothing to keep it for.
        expect(await reports.listReportsAwaitingEvidence()).toEqual([]);
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
            shareEnvelope: randomBytes(1256),
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

    test('a release deletes the report’s requests, and nothing asks for, answers or serves evidence after it', async () => {
        const doc = await file(rootId, rootEpoch);
        const made = await report(doc);
        if (made.status !== 'ok') throw new Error(made.status);
        await reports.markReportItemCopied(made.report.id, doc.id);
        await reports.setEvidenceStatus(made.report.id, 'copied');
        const answered = await reports.createEvidenceRequest(made.report.id, operator.userId);
        const pending = await reports.createEvidenceRequest(made.report.id, operator.userId);
        if (answered.status !== 'ok' || pending.status !== 'ok') throw new Error('not requested');
        await reports.answerEvidenceRequest(answered.request.id, {
            status: 'ready',
            urls: { [doc.currentVersionId!]: 'https://evidence.example/x' },
            urlExpiresAt: new Date(Date.now() + 900_000),
        });
        // The worker listed the pending one just before the release.
        const listed = await reports.listPendingEvidenceRequests();
        expect(listed.map((r) => r.id)).toEqual([pending.request.id]);

        await reports.resolveReport(made.report.id, operator.userId, {
            status: 'dismissed',
            hold: false,
        });
        expect(
            await reports.answerEvidenceRequest(pending.request.id, {
                status: 'ready',
                urls: { [doc.currentVersionId!]: 'https://evidence.example/late' },
                urlExpiresAt: new Date(Date.now() + 900_000),
            }),
        ).toBeNull();
        expect(await reports.listPendingEvidenceRequests()).toEqual([]);
        expect(await reports.getEvidenceRequest(made.report.id, answered.request.id)).toBeNull();
        expect(await reports.getEvidenceRequest(made.report.id, pending.request.id)).toBeNull();
        expect(await reports.createEvidenceRequest(made.report.id, operator.userId)).toEqual({
            status: 'released',
        });
    });

    test('a request of a released report that survived the release is neither listed, answered nor served', async () => {
        const doc = await file(rootId, rootEpoch);
        const made = await report(doc);
        if (made.status !== 'ok') throw new Error(made.status);
        await reports.setEvidenceStatus(made.report.id, 'copied');
        const created = await reports.createEvidenceRequest(made.report.id, operator.userId);
        if (created.status !== 'ok') throw new Error(created.status);
        // As if written by a build from before releases deleted requests.
        await db
            .update(driveReports)
            .set({ status: 'dismissed', releasedAt: new Date() })
            .where(eq(driveReports.id, made.report.id));
        expect(await reports.listPendingEvidenceRequests()).toEqual([]);
        expect(
            await reports.answerEvidenceRequest(created.request.id, {
                status: 'failed',
                error: 'late',
            }),
        ).toBeNull();
        expect(await reports.getEvidenceRequest(made.report.id, created.request.id)).toBeNull();
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

describe('release', () => {
    test('closing without a hold deletes every operator key and the reporter’s address; with a hold both stay', async () => {
        const dismissed = await report(await folder(rootId, rootEpoch), {
            reporterEmail: 'someone@example.com',
        });
        const held = await report(await folder(rootId, rootEpoch));
        if (dismissed.status !== 'ok' || held.status !== 'ok') throw new Error('not filed');

        await reports.resolveReport(dismissed.report.id, operator.userId, {
            status: 'dismissed',
            hold: false,
        });
        await reports.resolveReport(held.report.id, operator.userId, {
            status: 'dismissed',
            hold: true,
        });
        expect(await reports.getReportKey(dismissed.report.id, operator.userId)).toBeNull();
        const closed = (await reports.getReport(dismissed.report.id))!.report;
        expect(reports.isReleased(closed)).toBe(true);
        expect(closed.reporterAddressHash).toBeNull();
        // Who reported it and whose it was go too; the audit trail stays.
        expect(closed.reporterEmail).toBeNull();
        expect(closed.uploaderEmail).toBeNull();
        expect(closed.releasedAt).not.toBeNull();
        expect((await reports.getReport(dismissed.report.id))?.events.map((e) => e.action)).toEqual(
            ['reported', 'dismissed'],
        );
        expect(await reports.getReportKey(held.report.id, operator.userId)).toHaveLength(112);
        const kept = (await reports.getReport(held.report.id))!.report;
        expect(reports.isReleased(kept)).toBe(false);
        expect(kept.reporterAddressHash).toHaveLength(32);
        expect(kept.uploaderEmail).toBe(owner.email);
    });

    test('a released report refuses every way back: resolve, hold, reopen', async () => {
        const project = await folder(rootId, rootEpoch);
        const made = await report(project);
        if (made.status !== 'ok') throw new Error(made.status);
        await reports.resolveReport(made.report.id, operator.userId, {
            status: 'dismissed',
            hold: false,
        });
        const before = (await reports.getReport(made.report.id))!;

        for (const resolution of [
            { status: 'dismissed', hold: true },
            { status: 'removed', hold: false },
            { status: 'filed', filedWith: 'A hotline', filedReference: null },
        ] as const)
            expect(
                (await reports.resolveReport(made.report.id, operator.userId, resolution)).status,
            ).toBe('released');
        expect((await reports.setReportHold(made.report.id, operator.userId, true)).status).toBe(
            'released',
        );
        expect((await reports.setReportHold(made.report.id, operator.userId, false)).status).toBe(
            'released',
        );
        expect((await reports.reopenReport(made.report.id, operator.userId)).status).toBe(
            'released',
        );

        const after = (await reports.getReport(made.report.id))!;
        expect(after.report).toEqual(before.report);
        expect(after.events).toEqual(before.events);
        // Removal on a released report would have taken the owner's folder down.
        expect((await drive.authorize(owner.userId, owner.workspaceId, project.id))?.trashed).toBe(
            false,
        );
        expect((await reports.reopenReport(randomUUID(), operator.userId)).status).toBe(
            'not-found',
        );
        expect((await reports.setReportHold(randomUUID(), operator.userId, true)).status).toBe(
            'not-found',
        );
    });

    test('a closed report is not resolved again, held or not: it is reopened first', async () => {
        const project = await folder(rootId, rootEpoch);
        const made = await report(project);
        if (made.status !== 'ok') throw new Error(made.status);
        await reports.resolveReport(made.report.id, operator.userId, {
            status: 'dismissed',
            hold: true,
        });
        expect(
            (
                await reports.resolveReport(made.report.id, operator.userId, {
                    status: 'removed',
                    hold: true,
                })
            ).status,
        ).toBe('closed');
        expect((await drive.authorize(owner.userId, owner.workspaceId, project.id))?.trashed).toBe(
            false,
        );
        const reopened = await reports.reopenReport(made.report.id, operator.userId);
        if (reopened.status !== 'ok') throw new Error(reopened.status);
        expect(reopened.report.status).toBe('open');
        expect(reopened.report.heldAt).not.toBeNull();
        const removed = await reports.resolveReport(made.report.id, operator.userId, {
            status: 'removed',
            hold: true,
        });
        if (removed.status !== 'ok') throw new Error(removed.status);
        expect((await drive.authorize(owner.userId, owner.workspaceId, project.id))?.trashed).toBe(
            true,
        );
        expect((await reports.getReport(made.report.id))?.events.map((e) => e.action)).toEqual([
            'reported',
            'dismissed',
            'reopened',
            'content-removed',
            'removed',
        ]);
    });

    test('two operators closing at once: one closes it, the other is refused, and a release stays released', async () => {
        const made = await report(await folder(rootId, rootEpoch));
        if (made.status !== 'ok') throw new Error(made.status);
        const results = await Promise.all([
            reports.resolveReport(made.report.id, operator.userId, {
                status: 'dismissed',
                hold: false,
            }),
            reports.resolveReport(made.report.id, operator.userId, {
                status: 'filed',
                filedWith: 'A hotline',
                filedReference: null,
            }),
            reports.setReportHold(made.report.id, operator.userId, true),
        ]);
        const [dismissal, filing, hold] = results.map((result) => result.status);
        const final = (await reports.getReport(made.report.id))!.report;
        // Whichever closed it first decided; nothing after a release could hold it again.
        if (final.releasedAt) {
            expect([dismissal, filing]).toEqual(['ok', 'released']);
            expect(final.status).toBe('dismissed');
            expect(final.heldAt).toBeNull();
            expect(await reports.getReportKey(made.report.id, operator.userId)).toBeNull();
        } else {
            expect([dismissal, filing]).toEqual(['closed', 'ok']);
            expect(final.status).toBe('filed');
            expect(final.heldAt).not.toBeNull();
            expect(await reports.getReportKey(made.report.id, operator.userId)).toHaveLength(112);
        }
        expect(['ok', 'released']).toContain(hold);
    });

    test('releasing the hold of a closed report releases it; of an open one, nothing is lost', async () => {
        const open = await report(await folder(rootId, rootEpoch));
        const closed = await report(await folder(rootId, rootEpoch));
        if (open.status !== 'ok' || closed.status !== 'ok') throw new Error('not filed');
        await reports.setReportHold(open.report.id, operator.userId, true);
        await reports.setReportHold(open.report.id, operator.userId, false);
        expect(await reports.getReportKey(open.report.id, operator.userId)).toHaveLength(112);

        await reports.resolveReport(closed.report.id, operator.userId, {
            status: 'removed',
            hold: true,
        });
        expect(await reports.getReportKey(closed.report.id, operator.userId)).toHaveLength(112);
        await reports.setReportHold(closed.report.id, operator.userId, false);
        expect(await reports.getReportKey(closed.report.id, operator.userId)).toBeNull();
    });

    test('a released report takes no new keys, so it cannot be re-sealed to anyone', async () => {
        const made = await report(await folder(rootId, rootEpoch));
        if (made.status !== 'ok') throw new Error(made.status);
        await reports.resolveReport(made.report.id, operator.userId, {
            status: 'dismissed',
            hold: false,
        });
        const later = await createTestAccount();
        await identityFor(later.userId);
        await db.update(users).set({ role: 'admin' }).where(eq(users.id, later.userId));
        expect(
            await reports.addReportKeys(made.report.id, operator.userId, [
                { operatorUserId: later.userId, keyEnvelope: randomBytes(112) },
            ]),
        ).toEqual({ status: 'released' });
        expect(await reports.getReportKey(made.report.id, later.userId)).toBeNull();
    });
});
