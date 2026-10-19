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
const { workspaceKeys, workspaceStorage } = await import('./schema');

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
 * and the family's folder are two allowances: a move between them is refused as a move
 * (`not-pooled`), and the client copies and deletes instead, which needs the folder's room.
 */
test('without billing a move between My files and a family folder is refused as a move', async () => {
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
    // Both sides have room; only the pool refuses it.
    const moved = await begin(areaId, folder, {
        workspaceId: ana.workspaceId,
        nodeId: file.nodeId,
        versionId: file.versionId,
    });
    expect(moved.result.status).toBe('not-pooled');
    const [area] = await db
        .select({ reserved: workspaceStorage.reservedBytes })
        .from(workspaceStorage)
        .where(eq(workspaceStorage.workspaceId, areaId));
    expect(area!.reserved).toBe(0n);
    // An ordinary upload of the same size fits: it was the move that was refused, not the room.
    expect((await begin(areaId, folder)).result.status).toBe('ok');
});
