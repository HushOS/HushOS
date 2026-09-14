import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, createTestAccount, resetDatabase } from '../test/helpers';
import { db } from './client';
import * as drive from './drive';
import { driveObjects } from './schema';

/*
 * The queries behind the audit, the orphan sweep and tiering. Each one decides
 * whether bytes at the store are kept, deleted or moved, so each is checked
 * against the row states that must and must not qualify.
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
async function upload(plaintext = 1n * MiB) {
    const objectId = randomUUID();
    const ciphertext = plaintext + 16n;
    const begun = await drive.beginUpload({
        workspaceId: account.workspaceId,
        userId: account.userId,
        node: {
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
            chunkCount: 1,
            contentNonce: randomBytes(16),
            ciphertextSize: ciphertext,
        },
        multipartId: `mp-${objectId}`,
        expiresAt: new Date(Date.now() + 3600_000),
    });
    if (begun.status !== 'ok') throw new Error(begun.status);
    return { objectId, key: `ws/${account.workspaceId}/${objectId}`, uploadId: begun.uploadId };
}
async function published(plaintext = 1n * MiB) {
    const pending = await upload(plaintext);
    const started = await drive.startCompleting(account.workspaceId, pending.uploadId);
    if (started.status !== 'ok') throw new Error(started.status);
    const done = await drive.finishCompleting(
        account.workspaceId,
        pending.uploadId,
        plaintext + 16n,
    );
    if (done.status !== 'published') throw new Error(done.status);
    return { ...pending, node: done.node };
}
async function setObject(objectId: string, values: Partial<typeof driveObjects.$inferInsert>) {
    await db.update(driveObjects).set(values).where(eq(driveObjects.id, objectId));
}
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 3600 * 1000);

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

describe('audit', () => {
    test('walks objects least recently confirmed first and only replicated ones for the replica', async () => {
        const a = await published();
        const b = await published();
        const c = await published();
        await setObject(a.objectId, { auditedAt: daysAgo(1) });
        await setObject(b.objectId, { auditedAt: daysAgo(3) });
        await setObject(c.objectId, { replicatedAt: new Date() });
        // Never audited comes first, then the oldest confirmation.
        expect((await drive.listObjectsForAudit('primary')).map((row) => row.objectId)).toEqual([
            c.objectId,
            b.objectId,
            a.objectId,
        ]);
        expect((await drive.listObjectsForAudit('replica')).map((row) => row.objectId)).toEqual([
            c.objectId,
        ]);
        // A pending upload's object is not the audit's business.
        const pending = await upload();
        expect(
            (await drive.listObjectsForAudit('primary', 10)).map((row) => row.objectId),
        ).not.toContain(pending.objectId);
    });

    test('a miss makes the file unavailable to download and a later hit brings it back', async () => {
        const { objectId, node } = await published();
        const versionId = node.currentVersionId!;
        await drive.recordObjectAudit(objectId, 'missing');
        expect(await drive.getVersionForDownload(account.workspaceId, versionId)).toMatchObject({
            status: 'not-ready',
            objectStatus: 'missing',
        });
        expect(await drive.getVersionsForDownload(account.workspaceId, [versionId])).toEqual([]);
        // The row stays in the audit's rotation, marked as checked.
        const [row] = await drive.listObjectsForAudit('primary', 1);
        expect(row).toMatchObject({ objectId, status: 'missing' });
        expect(
            (await db.select().from(driveObjects).where(eq(driveObjects.id, objectId)))[0]
                ?.auditedAt,
        ).not.toBeNull();

        await drive.recordObjectAudit(objectId, 'recovered');
        expect((await drive.getVersionForDownload(account.workspaceId, versionId)).status).toBe(
            'ok',
        );
    });

    test('a replica miss re-enqueues the copy without touching the primary status', async () => {
        const { objectId } = await published();
        await setObject(objectId, { replicatedAt: new Date() });
        expect((await drive.listUnreplicatedObjects()).map((row) => row.objectId)).toEqual([]);
        await drive.recordObjectAudit(objectId, 'replica-missing');
        expect((await drive.listUnreplicatedObjects()).map((row) => row.objectId)).toEqual([
            objectId,
        ]);
        expect((await drive.getVersionsForDownload(account.workspaceId, [])).length).toBe(0);
        const [row] = await db.select().from(driveObjects).where(eq(driveObjects.id, objectId));
        expect(row?.status).toBe('ready');
    });
});

describe('orphan sweep', () => {
    test('knows a key by its object row or its outbox row, and nothing else', async () => {
        const live = await published();
        const pending = await upload();
        const retired = await published();
        await drive.trashNode({ workspaceId: account.workspaceId, nodeId: retired.node.id });
        await drive.purgeNode({ workspaceId: account.workspaceId, nodeId: retired.node.id });
        const stray = `ws/${account.workspaceId}/${randomUUID()}`;
        const known = await drive.knownObjectKeys([live.key, pending.key, retired.key, stray]);
        expect(known).toEqual(new Set([live.key, pending.key, retired.key]));
        expect(await drive.knownObjectKeys([])).toEqual(new Set());
    });

    test('the cursor survives between runs and clears when a pass completes', async () => {
        expect(await drive.getSweepCursor('orphans')).toBeNull();
        await drive.setSweepCursor('orphans', 'ws/abc/def');
        expect(await drive.getSweepCursor('orphans')).toBe('ws/abc/def');
        await drive.setSweepCursor('orphans', 'ws/abc/xyz');
        expect(await drive.getSweepCursor('orphans')).toBe('ws/abc/xyz');
        await drive.setSweepCursor('orphans', null);
        expect(await drive.getSweepCursor('orphans')).toBeNull();
    });
});

describe('tiering', () => {
    test('offers objects idle past the window and warms cold ones read since', async () => {
        const idle = await published();
        const neverRead = await published();
        const fresh = await published();
        const cold = await published();
        const coldUntouched = await published();
        await setObject(idle.objectId, { lastReadAt: daysAgo(100) });
        await setObject(neverRead.objectId, { readyAt: daysAgo(120) });
        await setObject(fresh.objectId, { lastReadAt: daysAgo(10), readyAt: daysAgo(200) });
        await setObject(cold.objectId, { storageClass: 'cold', lastReadAt: daysAgo(2) });
        await setObject(coldUntouched.objectId, { storageClass: 'cold', lastReadAt: daysAgo(400) });

        expect((await drive.listTierCandidates(90)).map((row) => row.objectId).sort()).toEqual(
            [neverRead.objectId, idle.objectId].sort(),
        );
        expect((await drive.listWarmCandidates(90)).map((row) => row.objectId)).toEqual([
            cold.objectId,
        ]);
        await drive.setObjectStorageClass(idle.objectId, 'cold');
        expect((await drive.listTierCandidates(90)).map((row) => row.objectId)).toEqual([
            neverRead.objectId,
        ]);
        // A pending object is never moved, whatever its age.
        const pending = await upload();
        await db
            .update(driveObjects)
            .set({ createdAt: sql`now() - interval '200 days'` })
            .where(eq(driveObjects.id, pending.objectId));
        expect((await drive.listTierCandidates(90)).map((row) => row.objectId)).not.toContain(
            pending.objectId,
        );
    });
});
