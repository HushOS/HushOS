import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, expect, test } from 'vitest';
import type { MoveOf } from './drive';

/*
 * Switching back to BILLING_PROVIDER=none stops reading pools: a family folder
 * falls back to its own allowance, which is 0 for one made while billing was on.
 */
process.env.BILLING_PROVIDER = 'none';

const { closeDatabase, createTestAccount, createTestFamily, createTestIdentity, resetDatabase } =
    await import('../test/helpers');
const signed = await import('../test/signed');
const billing = await import('./billing');
const { getStorageAllowance } = await import('./auth');
const drive = await import('./drive');
const { getStorage } = drive;
const { db } = await import('./client');
const { driveNodes, workspaceKeys, workspaceStorage } = await import('./schema');

beforeEach(resetDatabase);
afterAll(closeDatabase);

function familyPlan() {
    return {
        id: 'sub_family',
        productId: 'prod_family',
        productName: 'Family (monthly)',
        status: 'active',
        recurringInterval: 'month',
        amount: 1500,
        currency: 'usd',
        units: 6,
        paidUnits: 6,
        pendingUnits: null,
        pendingProductId: null,
        paidTier: { productId: 'prod_family', quotaBytes: 100n },
        includedMembers: 6,
        quotaBytes: 100n,
        currentPeriodStart: new Date(Date.now() - 1000),
        currentPeriodEnd: new Date(Date.now() + 86_400_000),
        cancelAtPeriodEnd: false,
        endedAt: null,
    };
}

test('without billing a family member’s own files keep their own allowance, whatever the family’s plan', async () => {
    const organizer = await createTestAccount({ quotaBytes: 2000n });
    const member = await createTestAccount({ quotaBytes: 3000n });
    const { groupId } = await createTestFamily({
        organizerId: organizer.userId,
        members: [{ userId: member.userId }],
        pooled: true,
    });
    await billing.applyGroupState({
        groupId,
        provider: 'polar',
        customerId: 'cus_team',
        subscriptions: [familyPlan()],
        graceMs: 0,
    });
    expect(await getStorage(member.workspaceId)).toEqual({
        allowance: 3000n,
        used: 0n,
        reserved: 0n,
        free: 3000n,
        shown: null,
        pool: null,
    });
    expect(await getStorageAllowance(organizer.userId)).toMatchObject({
        quotaBytes: '2000',
        pool: null,
    });
});

test('without billing a pooled group’s folders read their own allowance, not the pool', async () => {
    const { userId } = await createTestAccount();
    const { groupId, areaIds } = await createTestFamily({
        organizerId: userId,
        areas: 2,
        pooled: true,
    });
    // Someone else's: an account is in one family at most.
    const { areaIds: older } = await createTestFamily({
        organizerId: (await createTestAccount()).userId,
    });
    await billing.applyGroupState({
        groupId,
        provider: 'polar',
        customerId: 'cus_team',
        subscriptions: [
            {
                id: 'sub_family',
                productId: 'prod_family',
                productName: 'Family (monthly)',
                status: 'active',
                recurringInterval: 'month',
                amount: 1500,
                currency: 'usd',
                units: 6,
                paidUnits: 6,
                pendingUnits: null,
                pendingProductId: null,
                paidTier: { productId: 'prod_family', quotaBytes: 100n },
                includedMembers: 6,
                quotaBytes: 100n,
                currentPeriodStart: new Date(Date.now() - 1000),
                currentPeriodEnd: new Date(Date.now() + 86_400_000),
                cancelAtPeriodEnd: false,
                endedAt: null,
            },
        ],
        graceMs: 0,
    });
    expect((await getStorage(areaIds[0]!))?.allowance).toBe(0n);
    // A folder made before billing keeps its own free allowance.
    expect((await getStorage(older[0]!))?.allowance).toBe(10n * 1_073_741_824n);
});

/*
 * Without billing nothing is pooled (docs/families-shared-pool.md 8), so a member's own files
 * and the family's folder are two allowances: a move between them charges the copy to the
 * folder in full, as an upload, and still deletes the original in the completion's transaction.
 */
test('without billing a move into a family folder needs the folder’s room, and the original goes with it', async () => {
    const ana = await createTestAccount({ quotaBytes: 1000n });
    await createTestIdentity(ana.userId);
    const { areaIds } = await createTestFamily({ organizerId: ana.userId, areaQuotaBytes: 1000n });
    const areaId = areaIds[0]!;
    for (const workspaceId of [ana.workspaceId, areaId])
        await db.insert(workspaceKeys).values({
            workspaceId,
            userId: ana.userId,
            keyVersion: 1,
            workspaceKeyVersion: 1,
            wrappingSalt: randomBytes(32),
            wrappingNonce: randomBytes(24),
            encryptedKey: randomBytes(48),
        });
    async function rootOf(workspaceId: string) {
        const epoch = (await drive.allocateKeyEpochs(workspaceId, 1))!.from;
        const created = await signed.createRoot({
            workspaceId,
            userId: ana.userId,
            id: randomUUID(),
            envelopes: {
                keyEpoch: epoch,
                parentKeyEpoch: 1,
                keyEnvelope: randomBytes(72),
                metadataEnvelope: randomBytes(100),
            },
        });
        if (created.status !== 'created') throw new Error(created.status);
        return created.root;
    }
    async function begin(
        workspaceId: string,
        root: { id: string; keyEpoch: number },
        moveOf?: MoveOf,
    ) {
        const epoch = (await drive.allocateKeyEpochs(workspaceId, 1))!.from;
        const objectId = randomUUID();
        const nodeId = randomUUID();
        const versionId = randomUUID();
        const result = await signed.beginUpload({
            workspaceId,
            userId: ana.userId,
            node: {
                existing: false,
                id: nodeId,
                parentId: root.id,
                envelopes: {
                    keyEpoch: epoch,
                    parentKeyEpoch: root.keyEpoch,
                    keyEnvelope: randomBytes(72),
                    metadataEnvelope: randomBytes(100),
                },
            },
            version: { id: versionId, contentKeyEnvelope: randomBytes(72) },
            object: {
                id: objectId,
                objectKey: `ws/${workspaceId}/${objectId}`,
                contentSuite: 2,
                chunkSize: 8 * 1024 * 1024,
                chunkCount: 1,
                contentNonce: randomBytes(16),
                ciphertextSize: 100n,
            },
            multipartId: `mp-${objectId}`,
            expiresAt: new Date(Date.now() + 86_400_000),
            ...(moveOf && { moveOf }),
        });
        return { result, nodeId, versionId };
    }
    const mine = await rootOf(ana.workspaceId);
    const folder = await rootOf(areaId);
    const file = await begin(ana.workspaceId, mine);
    if (file.result.status !== 'ok') throw new Error(file.result.status);
    await drive.startCompleting(ana.workspaceId, file.result.uploadId);
    expect((await drive.finishCompleting(ana.workspaceId, file.result.uploadId, 100n)).status).toBe(
        'published',
    );
    const source = { workspaceId: ana.workspaceId, nodeId: file.nodeId, versionId: file.versionId };
    const storage = async (workspaceId: string) =>
        (
            await db
                .select({
                    used: workspaceStorage.usedBytes,
                    reserved: workspaceStorage.reservedBytes,
                })
                .from(workspaceStorage)
                .where(eq(workspaceStorage.workspaceId, workspaceId))
        )[0]!;
    // The folder's own allowance is what pays: with 950 of its 1000 bytes used, 100 won't fit,
    // whatever the original frees in Ana's own files.
    await db
        .update(workspaceStorage)
        .set({ usedBytes: 950n })
        .where(eq(workspaceStorage.workspaceId, areaId));
    expect((await begin(areaId, folder, source)).result.status).toBe('over-quota');
    await db
        .update(workspaceStorage)
        .set({ usedBytes: 0n })
        .where(eq(workspaceStorage.workspaceId, areaId));
    const moved = await begin(areaId, folder, source);
    if (moved.result.status !== 'ok') throw new Error(moved.result.status);
    expect(await storage(areaId)).toEqual({ used: 0n, reserved: 100n });
    await drive.startCompleting(areaId, moved.result.uploadId);
    expect((await drive.finishCompleting(areaId, moved.result.uploadId, 100n)).status).toBe(
        'published',
    );
    // In one transaction: the copy counted in the folder, the original gone from Ana's files.
    expect(await storage(areaId)).toEqual({ used: 100n, reserved: 0n });
    expect(await storage(ana.workspaceId)).toEqual({ used: 0n, reserved: 0n });
    const [original] = await db
        .select({ purgedAt: driveNodes.purgedAt })
        .from(driveNodes)
        .where(eq(driveNodes.id, file.nodeId));
    expect(original!.purgedAt).not.toBeNull();
});
