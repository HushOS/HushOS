import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import type { GroupSubscriptionSnapshot } from './billing';
import type { MoveOf } from './drive';

/*
 * Moving a file between a family member's own files and the family's folders
 * (docs/families-shared-pool.md 3.8, section 10 "Moves"), on real Postgres: the
 * move is an upload that names its source (`moveOf`), reserves only what the copy
 * takes beyond what the source frees, and removes the source in the completion's
 * transaction, or fails `move-stale` and releases the copy. Across pools it is
 * refused as a move.
 */
process.env.BILLING_PROVIDER = 'polar';

const { closeDatabase, createTestAccount, createTestFamily, createTestIdentity, resetDatabase } =
    await import('../test/helpers');
const signed = await import('../test/signed');
const { registered, signedIn } = await import('../test/accounts');
const auth = await import('./auth');
const billing = await import('./billing');
const { db } = await import('./client');
const drive = await import('./drive');
const groups = await import('./groups');
const { poolUsage } = await import('./pool');
const {
    accountIdentities,
    driveNodes,
    driveObjectDeletions,
    driveUploads,
    fileVersions,
    groupHolds,
    groupMemberships,
    groupStorage,
    groups: groupsTable,
    workspaceKeys,
    workspaceStorage,
    workspaces,
} = await import('./schema');

beforeEach(resetDatabase);
afterAll(closeDatabase);

const DAY = 24 * 60 * 60 * 1000;
const GIB = 1n << 30n;
const MIB = 1n << 20n;

type Place = { workspaceId: string; root: { id: string; epoch: number } };
type Person = Place & { userId: string };

function plan(quotaBytes: bigint): GroupSubscriptionSnapshot {
    return {
        id: 'sub_family',
        productId: 'prod_family',
        productName: 'Family Plus (monthly)',
        status: 'active',
        recurringInterval: 'month',
        amount: 1000,
        currency: 'usd',
        units: 6,
        paidUnits: 6,
        pendingUnits: null,
        pendingProductId: null,
        paidTier: { productId: 'prod_family', quotaBytes },
        includedMembers: 4,
        quotaBytes,
        currentPeriodStart: new Date(Date.now() - DAY),
        currentPeriodEnd: new Date(Date.now() + 29 * DAY),
        cancelAtPeriodEnd: false,
        endedAt: null,
    };
}

async function rootOf(workspaceId: string, userId: string) {
    const epoch = (await drive.allocateKeyEpochs(workspaceId, 1))!.from;
    const created = await signed.createRoot({
        workspaceId,
        userId,
        id: randomUUID(),
        envelopes: {
            keyEpoch: epoch,
            parentKeyEpoch: 1,
            keyEnvelope: randomBytes(72),
            metadataEnvelope: randomBytes(100),
        },
    });
    if (created.status !== 'created') throw new Error(`createRoot ${created.status}`);
    return { id: created.root.id, epoch: created.root.keyEpoch };
}

/* `userId` holds the workspace's key, as its owner or a member of the family whose folder it is. */
async function hold(workspaceId: string, userId: string) {
    await db.insert(workspaceKeys).values({
        workspaceId,
        userId,
        keyVersion: 1,
        workspaceKeyVersion: 1,
        wrappingSalt: randomBytes(32),
        wrappingNonce: randomBytes(24),
        encryptedKey: randomBytes(48),
    });
}

async function person(): Promise<Person> {
    const account = await createTestAccount({ quotaBytes: 100n });
    await createTestIdentity(account.userId);
    await hold(account.workspaceId, account.userId);
    return { ...account, root: await rootOf(account.workspaceId, account.userId) };
}

/*
 * Ana (the organizer) and Ben in one family with one folder both hold, and a live plan of
 * `quota` unless it is null.
 */
async function family(quota: bigint | null) {
    const ana = await person();
    const ben = await person();
    const { groupId, areaIds } = await createTestFamily({
        organizerId: ana.userId,
        members: [{ userId: ben.userId }],
        pooled: true,
    });
    const areaId = areaIds[0]!;
    await hold(areaId, ana.userId);
    await hold(areaId, ben.userId);
    if (quota !== null)
        await billing.applyGroupState({
            groupId,
            provider: 'polar',
            customerId: 'cus_family',
            subscriptions: [plan(quota)],
            graceMs: 3 * DAY,
        });
    const area: Place = { workspaceId: areaId, root: await rootOf(areaId, ana.userId) };
    return { ana, ben, groupId, area };
}

/* An upload begin of `bytes` into `into`'s top folder, a move of `moveOf` when given. */
async function begin(
    userId: string,
    into: Place,
    bytes: bigint,
    moveOf?: MoveOf,
    parent = into.root,
) {
    const epoch = (await drive.allocateKeyEpochs(into.workspaceId, 1))!.from;
    const objectId = randomUUID();
    const nodeId = randomUUID();
    const versionId = randomUUID();
    const result = await signed.beginUpload({
        workspaceId: into.workspaceId,
        userId,
        node: {
            existing: false,
            id: nodeId,
            parentId: parent.id,
            envelopes: {
                keyEpoch: epoch,
                parentKeyEpoch: parent.epoch,
                keyEnvelope: randomBytes(72),
                metadataEnvelope: randomBytes(100),
            },
        },
        version: { id: versionId, contentKeyEnvelope: randomBytes(72) },
        object: {
            id: objectId,
            objectKey: `ws/${into.workspaceId}/${objectId}`,
            contentSuite: 2,
            chunkSize: 8 * 1024 * 1024,
            chunkCount: 1,
            contentNonce: randomBytes(16),
            ciphertextSize: bytes,
        },
        multipartId: `mp-${objectId}`,
        expiresAt: new Date(Date.now() + DAY),
        ...(moveOf && { moveOf }),
    });
    return { result, nodeId, versionId, objectId };
}

async function complete(workspaceId: string, uploadId: string, bytes: bigint) {
    expect((await drive.startCompleting(workspaceId, uploadId)).status).toBe('ok');
    return drive.finishCompleting(workspaceId, uploadId, bytes);
}

/* A finished file of `bytes` in `into`'s top folder (or `parent`). */
async function stored(
    userId: string,
    into: Place,
    bytes: bigint,
    parent?: { id: string; epoch: number },
) {
    const made = await begin(userId, into, bytes, undefined, parent);
    if (made.result.status !== 'ok') throw new Error(`beginUpload ${made.result.status}`);
    expect((await complete(into.workspaceId, made.result.uploadId, bytes)).status).toBe(
        'published',
    );
    return { workspaceId: into.workspaceId, nodeId: made.nodeId, versionId: made.versionId };
}

/* A new version of `file` of `bytes`, finished: the old one becomes the earlier version. */
async function newVersion(
    userId: string,
    file: { workspaceId: string; nodeId: string; versionId: string },
) {
    const [node] = await db
        .select({ keyEpoch: driveNodes.keyEpoch })
        .from(driveNodes)
        .where(eq(driveNodes.id, file.nodeId));
    const objectId = randomUUID();
    const versionId = randomUUID();
    const bytes = 100n * MIB;
    const result = await signed.beginUpload({
        workspaceId: file.workspaceId,
        userId,
        node: {
            existing: true,
            id: file.nodeId,
            keyEpoch: node!.keyEpoch,
            expectedVersionId: file.versionId,
        },
        version: { id: versionId, contentKeyEnvelope: randomBytes(72) },
        object: {
            id: objectId,
            objectKey: `ws/${file.workspaceId}/${objectId}`,
            contentSuite: 2,
            chunkSize: 8 * 1024 * 1024,
            chunkCount: 1,
            contentNonce: randomBytes(16),
            ciphertextSize: bytes,
        },
        multipartId: `mp-${objectId}`,
        expiresAt: new Date(Date.now() + DAY),
    });
    if (result.status !== 'ok') throw new Error(`beginUpload ${result.status}`);
    expect((await complete(file.workspaceId, result.uploadId, bytes)).status).toBe('published');
    return { ...file, versionId, bytes };
}

async function own(workspaceId: string) {
    const [row] = await db
        .select({ used: workspaceStorage.usedBytes, reserved: workspaceStorage.reservedBytes })
        .from(workspaceStorage)
        .where(eq(workspaceStorage.workspaceId, workspaceId));
    return row!;
}

async function setUsed(workspaceId: string, used: bigint) {
    await db
        .update(workspaceStorage)
        .set({ usedBytes: used })
        .where(eq(workspaceStorage.workspaceId, workspaceId));
}

/* The pool's exact bytes, which no check uses but which a move must leave as they were. */
async function exactUsage(groupId: string) {
    const { used, reserved } = await poolUsage(db, groupId);
    return { used, reserved };
}

async function node(nodeId: string) {
    const [row] = await db
        .select({
            purgedAt: driveNodes.purgedAt,
            trashedAt: driveNodes.trashedAt,
            currentVersionId: driveNodes.currentVersionId,
        })
        .from(driveNodes)
        .where(eq(driveNodes.id, nodeId));
    return row ?? null;
}

async function uploadRow(uploadId: string) {
    const [row] = await db
        .select({ status: driveUploads.status, reservedBytes: driveUploads.reservedBytes })
        .from(driveUploads)
        .where(eq(driveUploads.id, uploadId));
    return row ?? null;
}

const moveOf = (file: { workspaceId: string; nodeId: string; versionId: string }) => ({
    workspaceId: file.workspaceId,
    nodeId: file.nodeId,
    versionId: file.versionId,
});

/* How many other sessions wait on a lock, once at least `count` do (or about two seconds pass). */
async function lockWaiters(client: Client, count: number) {
    let waiting = 0;
    for (let tries = 0; tries < 100 && waiting < count; tries++) {
        if (tries > 0) await new Promise((resolve) => setTimeout(resolve, 20));
        await client.query('select pg_stat_clear_snapshot()');
        const { rows } = await client.query<{ waiting: number }>(
            `select count(*)::int as waiting from pg_stat_activity
             where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
        );
        waiting = rows[0]!.waiting;
    }
    return waiting;
}

describe('moves within one pool', () => {
    test('a move into a full pool succeeds and leaves usage unchanged', async () => {
        const { ana, ben, groupId, area } = await family(4n * GIB);
        const file = await stored(ana.userId, ana, GIB);
        // Ben's files fill the rest: Ana's 1 GiB, Ben's 3 GiB, the folders nothing.
        await setUsed(ben.workspaceId, 3n * GIB);
        const before = await exactUsage(groupId);
        expect(before).toEqual({ used: 4n * GIB, reserved: 0n });
        // Full: an ordinary upload of a single byte into the folder is refused.
        expect((await begin(ana.userId, area, 16n)).result.status).toBe('over-quota');
        // A copy one byte larger than what the source frees needs that byte, and there is none.
        expect((await begin(ana.userId, area, GIB + 1n, moveOf(file))).result.status).toBe(
            'over-quota',
        );
        const moved = await begin(ana.userId, area, GIB, moveOf(file));
        expect(moved.result.status).toBe('ok');
        if (moved.result.status !== 'ok') return;
        // Nothing reserved: the source frees all the copy takes.
        expect(await uploadRow(moved.result.uploadId)).toMatchObject({ reservedBytes: 0n });
        expect(await exactUsage(groupId)).toEqual(before);
        expect((await complete(area.workspaceId, moved.result.uploadId, GIB)).status).toBe(
            'published',
        );
        expect(await exactUsage(groupId)).toEqual(before);
        expect(await own(ana.workspaceId)).toEqual({ used: 0n, reserved: 0n });
        expect(await own(area.workspaceId)).toEqual({ used: GIB, reserved: 0n });
        // Done, the upload keeps no link from the copy back to where it came from.
        const [link] = await db
            .select({
                workspaceId: driveUploads.moveWorkspaceId,
                nodeId: driveUploads.moveNodeId,
                versionId: driveUploads.moveVersionId,
                by: driveUploads.moveBy,
            })
            .from(driveUploads)
            .where(eq(driveUploads.id, moved.result.uploadId));
        expect(link).toEqual({ workspaceId: null, nodeId: null, versionId: null, by: null });
        expect((await node(file.nodeId))?.purgedAt).not.toBeNull();
        expect((await node(moved.nodeId))?.currentVersionId).toBe(moved.versionId);
    });

    test('the source’s earlier version counts in what it frees, and is gone with it', async () => {
        const { ana, ben, groupId, area } = await family(4n * GIB);
        const first = await stored(ana.userId, area, 400n * MIB);
        // The folder's file now holds 100 MiB current and 400 MiB earlier: 500 MiB in all.
        const file = await newVersion(ana.userId, first);
        await setUsed(ben.workspaceId, 4n * GIB - 500n * MIB);
        const before = await exactUsage(groupId);
        expect(before.used).toBe(4n * GIB);
        // Into Ana's own files, full: 500 MiB of copy reserves nothing; one byte more is refused.
        expect((await begin(ana.userId, ana, 500n * MIB + 1n, moveOf(file))).result.status).toBe(
            'over-quota',
        );
        const moved = await begin(ana.userId, ana, 500n * MIB, moveOf(file));
        expect(moved.result.status).toBe('ok');
        if (moved.result.status !== 'ok') return;
        expect((await complete(ana.workspaceId, moved.result.uploadId, 500n * MIB)).status).toBe(
            'published',
        );
        expect(await exactUsage(groupId)).toEqual(before);
        expect(await own(area.workspaceId)).toEqual({ used: 0n, reserved: 0n });
        // Both versions went, each to the deletion outbox.
        const versions = await db
            .select({ status: fileVersions.status })
            .from(fileVersions)
            .where(eq(fileVersions.nodeId, file.nodeId));
        expect(versions.map((version) => version.status)).toEqual(['purged', 'purged']);
    });

    test('after the completion’s transaction the source is gone and its bytes freed, and no reader sees both counted', async () => {
        const { ana, groupId, area } = await family(4n * GIB);
        const file = await stored(ana.userId, ana, 300n * MIB);
        const moved = await begin(ana.userId, area, 300n * MIB, moveOf(file));
        if (moved.result.status !== 'ok') throw new Error(moved.result.status);
        const uploadId = moved.result.uploadId;
        expect((await drive.startCompleting(area.workspaceId, uploadId)).status).toBe('ok');
        const before = await exactUsage(groupId);
        // A third connection holds the source's storage row: the completion publishes the copy,
        // then waits to take the source's bytes off, inside its transaction.
        const blocker = new Client({ connectionString: process.env.DATABASE_URL });
        await blocker.connect();
        let finishing: Promise<Awaited<ReturnType<typeof drive.finishCompleting>>>;
        try {
            await blocker.query('begin');
            await blocker.query(
                'select used_bytes from workspace_storage where workspace_id = $1 for update',
                [ana.workspaceId],
            );
            finishing = drive.finishCompleting(area.workspaceId, uploadId, 300n * MIB);
            expect(await lockWaiters(blocker, 1)).toBeGreaterThanOrEqual(1);
            // Mid-completion, every reader sees the state before it: the source counted, the
            // copy neither counted nor visible. Never both.
            expect(await exactUsage(groupId)).toEqual(before);
            expect(await own(area.workspaceId)).toEqual({ used: 0n, reserved: 0n });
            expect((await node(moved.nodeId))?.currentVersionId).toBeNull();
            expect((await node(file.nodeId))?.purgedAt).toBeNull();
        } finally {
            await blocker.query('commit');
            await blocker.end();
        }
        expect((await finishing!).status).toBe('published');
        // Then, at once, the state after: the copy counted, the source gone and its bytes freed.
        expect(await exactUsage(groupId)).toEqual(before);
        expect(await own(ana.workspaceId)).toEqual({ used: 0n, reserved: 0n });
        expect(await own(area.workspaceId)).toEqual({ used: 300n * MIB, reserved: 0n });
        expect((await node(file.nodeId))?.purgedAt).not.toBeNull();
        expect((await node(moved.nodeId))?.currentVersionId).toBe(moved.versionId);
    });

    test('one move of a file at a time: a second is refused, so the source’s bytes lower one reservation', async () => {
        const { ana, area } = await family(4n * GIB);
        const file = await stored(ana.userId, ana, 300n * MIB);
        const first = await begin(ana.userId, area, 300n * MIB, moveOf(file));
        expect(first.result.status).toBe('ok');
        const second = await begin(ana.userId, area, 300n * MIB, moveOf(file));
        expect(second.result.status).toBe('moving');
        expect(await node(second.nodeId)).toBeNull();
        expect(await own(area.workspaceId)).toEqual({ used: 0n, reserved: 0n });
    });

    test('moves in opposite directions at once all finish (no deadlock)', async () => {
        const { ana, groupId, area } = await family(64n * GIB);
        const rounds = 10;
        const pairs = [];
        for (let round = 0; round < rounds; round++) {
            const mine = await stored(ana.userId, ana, MIB);
            const theirs = await stored(ana.userId, area, MIB);
            const out = await begin(ana.userId, area, MIB, moveOf(mine));
            const back = await begin(ana.userId, ana, MIB, moveOf(theirs));
            if (out.result.status !== 'ok' || back.result.status !== 'ok')
                throw new Error('begin refused');
            expect(
                (await drive.startCompleting(area.workspaceId, out.result.uploadId)).status,
            ).toBe('ok');
            expect(
                (await drive.startCompleting(ana.workspaceId, back.result.uploadId)).status,
            ).toBe('ok');
            pairs.push({ out: out.result.uploadId, back: back.result.uploadId });
        }
        const before = await exactUsage(groupId);
        const results = await Promise.all(
            pairs.flatMap(({ out, back }) => [
                drive.finishCompleting(area.workspaceId, out, MIB),
                drive.finishCompleting(ana.workspaceId, back, MIB),
            ]),
        );
        expect(results.map((result) => result.status)).toEqual(
            Array.from({ length: rounds * 2 }, () => 'published'),
        );
        expect(await exactUsage(groupId)).toEqual(before);
        expect(await own(ana.workspaceId)).toEqual({ used: BigInt(rounds) * MIB, reserved: 0n });
        expect(await own(area.workspaceId)).toEqual({ used: BigInt(rounds) * MIB, reserved: 0n });
    }, 60_000);
});

describe('a move racing its mover’s account deletion', () => {
    test('completion and deletion queue on the family folder; neither deadlocks', async () => {
        const ana = await person();
        // Ben deletes his account, so he is a registered account with a live session. His
        // workspace's id sorts before the family folder's (fixed, below): locking the two in id
        // order would take his workspace first, the reverse of what deleting his account takes,
        // and deadlock every time.
        const benSpace = '00000000-0000-4000-8000-000000000001' as const;
        const areaId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
        const { user } = await registered(undefined, benSpace);
        await db.delete(accountIdentities).where(eq(accountIdentities.userId, user.id));
        await createTestIdentity(user.id);
        const token = await signedIn(user.id);
        const { groupId } = await createTestFamily({
            organizerId: ana.userId,
            members: [{ userId: user.id }],
            areas: 0,
            pooled: true,
        });
        await db.insert(workspaces).values({
            id: areaId,
            ownerKind: 'group',
            groupId,
            areaKind: 'shared',
            idSeed: randomBytes(16).toString('base64url'),
        });
        await db.insert(workspaceStorage).values({ workspaceId: areaId, baseQuotaBytes: 0n });
        await billing.applyGroupState({
            groupId,
            provider: 'polar',
            customerId: 'cus_family',
            subscriptions: [plan(4n * GIB)],
            graceMs: 3 * DAY,
        });
        await hold(areaId, user.id);
        const mine: Place = { workspaceId: benSpace, root: await rootOf(benSpace, user.id) };
        const area: Place = { workspaceId: areaId, root: await rootOf(areaId, user.id) };
        const file = await stored(user.id, mine, 300n * MIB);
        const moved = await begin(user.id, area, 300n * MIB, moveOf(file));
        if (moved.result.status !== 'ok') throw new Error(moved.result.status);
        expect((await drive.startCompleting(areaId, moved.result.uploadId)).status).toBe('ok');
        // A third connection holds Ben's workspace: the completion queues on it, then the
        // deletion starts behind them both.
        const blocker = new Client({ connectionString: process.env.DATABASE_URL });
        await blocker.connect();
        let finishing: Promise<unknown>;
        let deleting: Promise<unknown>;
        try {
            await blocker.query('begin');
            await blocker.query('select id from workspaces where id = $1 for update', [benSpace]);
            finishing = drive.finishCompleting(areaId, moved.result.uploadId, 300n * MIB).then(
                (result) => result.status,
                (error: unknown) => error,
            );
            expect(await lockWaiters(blocker, 1)).toBeGreaterThanOrEqual(1);
            deleting = auth
                .deleteAccount({ userId: user.id, credentialVersion: 1, sessionTokenHash: token })
                .then(
                    (result) => result,
                    (error: unknown) => error,
                );
            expect(await lockWaiters(blocker, 2)).toBeGreaterThanOrEqual(2);
        } finally {
            await blocker.query('commit');
            await blocker.end();
        }
        // Both finish: the move first (it held the folder), then the deletion, never a deadlock
        // (which the deletion answers as 'unavailable', and the completion throws).
        expect(await finishing!).toBe('published');
        expect(await deleting!).toBe(true);
    });
});

describe('a move whose source changed', () => {
    /* Each change made between the move's begin and its completion. */
    const changes: [
        string,
        (input: {
            ana: Person;
            file: { workspaceId: string; nodeId: string; versionId: string };
            folderId: string;
        }) => Promise<unknown>,
    ][] = [
        ['a new version', ({ ana, file }) => newVersion(ana.userId, file)],
        [
            'a rename',
            async ({ ana, file }) => {
                const [row] = await db
                    .select({
                        metadataVersion: driveNodes.metadataVersion,
                        keyEpoch: driveNodes.keyEpoch,
                    })
                    .from(driveNodes)
                    .where(eq(driveNodes.id, file.nodeId));
                const result = await signed.renameNode({
                    workspaceId: file.workspaceId,
                    userId: ana.userId,
                    nodeId: file.nodeId,
                    metadataVersion: row!.metadataVersion,
                    keyEpoch: row!.keyEpoch,
                    metadataEnvelope: randomBytes(100),
                });
                expect(result.status).toBe('ok');
            },
        ],
        [
            'its folder moved to the Trash',
            async ({ file, folderId }) =>
                expect(
                    (await drive.trashNode({ workspaceId: file.workspaceId, nodeId: folderId }))
                        .status,
                ).toBe('ok'),
        ],
        [
            'deleted',
            async ({ file }) => {
                await drive.trashNode({ workspaceId: file.workspaceId, nodeId: file.nodeId });
                expect(
                    (await drive.purgeNode({ workspaceId: file.workspaceId, nodeId: file.nodeId }))
                        .status,
                ).toBe('ok');
            },
        ],
    ];

    test.each(changes)(
        '%s: fails stale, releases the copy and leaves the source',
        async (_name, change) => {
            const { ana, groupId, area } = await family(4n * GIB);
            const made = await signed.createFolders({
                workspaceId: ana.workspaceId,
                userId: ana.userId,
                folders: [
                    {
                        id: randomUUID(),
                        parentId: ana.root.id,
                        envelopes: {
                            keyEpoch: (await drive.allocateKeyEpochs(ana.workspaceId, 1))!.from,
                            parentKeyEpoch: ana.root.epoch,
                            keyEnvelope: randomBytes(72),
                            metadataEnvelope: randomBytes(100),
                        },
                    },
                ],
            });
            if (made.status !== 'created') throw new Error(made.status);
            const folder = made.nodes[0]!;
            const folderId = folder.id;
            const file = await stored(ana.userId, ana, 300n * MIB, {
                id: folder.id,
                epoch: folder.keyEpoch,
            });
            const moved = await begin(ana.userId, area, 300n * MIB, moveOf(file));
            if (moved.result.status !== 'ok') throw new Error(moved.result.status);
            expect(
                (await drive.startCompleting(area.workspaceId, moved.result.uploadId)).status,
            ).toBe('ok');
            await change({ ana, file, folderId });
            const after = await node(file.nodeId);
            const usage = await exactUsage(groupId);
            expect(
                (await drive.finishCompleting(area.workspaceId, moved.result.uploadId, 300n * MIB))
                    .status,
            ).toBe('move-stale');
            // The copy is released: nothing reserved or used in the folder, its node gone (and the
            // upload with it, as for any new file aborted), its object in the deletion outbox.
            expect(await uploadRow(moved.result.uploadId)).toBeNull();
            expect(await own(area.workspaceId)).toEqual({ used: 0n, reserved: 0n });
            expect(await node(moved.nodeId)).toBeNull();
            expect(
                await db
                    .select({ objectId: driveObjectDeletions.objectId })
                    .from(driveObjectDeletions)
                    .where(eq(driveObjectDeletions.objectId, moved.objectId)),
            ).toHaveLength(1);
            // The source is as the change left it, not purged by the move.
            expect(await node(file.nodeId)).toEqual(after);
            expect(await exactUsage(groupId)).toEqual(usage);
        },
    );

    test('a new version still uploading when the move completes: stale, and the new version lands on the original', async () => {
        const { ana, area } = await family(4n * GIB);
        const file = await stored(ana.userId, ana, 300n * MIB);
        const moved = await begin(ana.userId, area, 300n * MIB, moveOf(file));
        if (moved.result.status !== 'ok') throw new Error(moved.result.status);
        // Someone uploads a new version of the original; it has begun, not landed.
        const [row] = await db
            .select({ keyEpoch: driveNodes.keyEpoch })
            .from(driveNodes)
            .where(eq(driveNodes.id, file.nodeId));
        const objectId = randomUUID();
        const versionId = randomUUID();
        const update = await signed.beginUpload({
            workspaceId: ana.workspaceId,
            userId: ana.userId,
            node: {
                existing: true,
                id: file.nodeId,
                keyEpoch: row!.keyEpoch,
                expectedVersionId: file.versionId,
            },
            version: { id: versionId, contentKeyEnvelope: randomBytes(72) },
            object: {
                id: objectId,
                objectKey: `ws/${ana.workspaceId}/${objectId}`,
                contentSuite: 2,
                chunkSize: 8 * 1024 * 1024,
                chunkCount: 1,
                contentNonce: randomBytes(16),
                ciphertextSize: 100n * MIB,
            },
            multipartId: `mp-${objectId}`,
            expiresAt: new Date(Date.now() + DAY),
        });
        if (update.status !== 'ok') throw new Error(update.status);
        // The move finishes first: deleting the original would throw the new version away.
        expect((await complete(area.workspaceId, moved.result.uploadId, 300n * MIB)).status).toBe(
            'move-stale',
        );
        expect(await node(moved.nodeId)).toBeNull();
        expect(await own(area.workspaceId)).toEqual({ used: 0n, reserved: 0n });
        // Then the new version lands, on the original, which is still there.
        expect((await complete(ana.workspaceId, update.uploadId, 100n * MIB)).status).toBe(
            'published',
        );
        expect(await node(file.nodeId)).toMatchObject({
            purgedAt: null,
            currentVersionId: versionId,
        });
    });

    test('an earlier version discarded meanwhile: the source frees less than begin counted, so it is stale', async () => {
        const { ana, ben, area } = await family(4n * GIB);
        const first = await stored(ana.userId, ana, 400n * MIB);
        const file = await newVersion(ana.userId, first);
        const moved = await begin(ana.userId, area, 500n * MIB, moveOf(file));
        if (moved.result.status !== 'ok') throw new Error(moved.result.status);
        expect(await uploadRow(moved.result.uploadId)).toMatchObject({ reservedBytes: 0n });
        expect((await drive.discardVersion(ana.workspaceId, first.versionId)).status).toBe('ok');
        // The pool fills meanwhile, so finishing would land 400 MiB past it.
        await setUsed(ben.workspaceId, 4n * GIB - 100n * MIB);
        expect((await complete(area.workspaceId, moved.result.uploadId, 500n * MIB)).status).toBe(
            'move-stale',
        );
        expect(await own(area.workspaceId)).toEqual({ used: 0n, reserved: 0n });
        expect((await node(file.nodeId))?.currentVersionId).toBe(file.versionId);
    });

    test('a version other than the current one is refused at begin', async () => {
        const { ana, area } = await family(4n * GIB);
        const first = await stored(ana.userId, ana, 400n * MIB);
        await newVersion(ana.userId, first);
        expect((await begin(ana.userId, area, 400n * MIB, moveOf(first))).result.status).toBe(
            'stale',
        );
        expect(await own(area.workspaceId)).toEqual({ used: 0n, reserved: 0n });
    });

    test('the family’s plan lapses before it finishes: it leaned on one pool, so it is stale and the file stays', async () => {
        const { ana, groupId, area } = await family(4n * GIB);
        const file = await stored(ana.userId, ana, 300n * MIB);
        const moved = await begin(ana.userId, area, 300n * MIB, moveOf(file));
        if (moved.result.status !== 'ok') throw new Error(moved.result.status);
        // Within one pool: nothing reserved, the original's bytes stand in for the copy's.
        expect(await uploadRow(moved.result.uploadId)).toMatchObject({ reservedBytes: 0n });
        await billing.applyGroupState({
            groupId,
            provider: 'polar',
            customerId: 'cus_family',
            subscriptions: [
                {
                    ...plan(4n * GIB),
                    status: 'past_due',
                    currentPeriodStart: new Date(Date.now() - 34 * DAY),
                    currentPeriodEnd: new Date(Date.now() - 4 * DAY),
                },
            ],
            graceMs: 3 * DAY,
        });
        // Ana still holds both sides; only the pool is gone. Finishing would put 300 MiB in a
        // folder with no room, paid for by bytes freed in another allowance.
        expect((await complete(area.workspaceId, moved.result.uploadId, 300n * MIB)).status).toBe(
            'move-stale',
        );
        expect((await node(file.nodeId))?.purgedAt).toBeNull();
        expect(await own(area.workspaceId)).toEqual({ used: 0n, reserved: 0n });
    });

    test('a member who leaves before it finishes: no longer one pool, so it is stale and their file stays', async () => {
        const { ben, groupId, area } = await family(4n * GIB);
        const file = await stored(ben.userId, ben, 300n * MIB);
        const moved = await begin(ben.userId, area, 300n * MIB, moveOf(file));
        if (moved.result.status !== 'ok') throw new Error(moved.result.status);
        expect((await drive.startCompleting(area.workspaceId, moved.result.uploadId)).status).toBe(
            'ok',
        );
        expect(await groups.leaveGroup(groupId, ben.userId)).toEqual({ status: 'left' });
        expect(
            (await drive.finishCompleting(area.workspaceId, moved.result.uploadId, 300n * MIB))
                .status,
        ).toBe('move-stale');
        expect((await node(file.nodeId))?.purgedAt).toBeNull();
        expect(await own(ben.workspaceId)).toEqual({ used: 300n * MIB, reserved: 0n });
        expect(await own(area.workspaceId)).toEqual({ used: 0n, reserved: 0n });
    });
});

describe('a move finished by attach or by the expiry job', () => {
    /* A move whose completion met an epoch race, as finishCompleting leaves it: conflicted. */
    async function conflictedMove() {
        const { ana, groupId, area } = await family(4n * GIB);
        const file = await stored(ana.userId, ana, 300n * MIB);
        const moved = await begin(ana.userId, area, 300n * MIB, moveOf(file));
        if (moved.result.status !== 'ok') throw new Error(moved.result.status);
        const uploadId = moved.result.uploadId;
        expect((await drive.startCompleting(area.workspaceId, uploadId)).status).toBe('ok');
        await db
            .update(driveUploads)
            .set({ status: 'conflicted' })
            .where(eq(driveUploads.id, uploadId));
        const sibling = async () =>
            signed.attachUpload(area.workspaceId, uploadId, {
                userId: ana.userId,
                contentKeyEnvelope: randomBytes(72),
                mode: 'sibling',
                node: {
                    id: randomUUID(),
                    parentId: area.root.id,
                    keyEpoch: (await drive.allocateKeyEpochs(area.workspaceId, 1))!.from,
                    parentKeyEpoch: area.root.epoch,
                    keyEnvelope: randomBytes(72),
                    metadataEnvelope: randomBytes(100),
                },
            });
        return { ana, groupId, area, file, sibling };
    }

    test('attached as a sibling, it removes the source in the same transaction', async () => {
        const { ana, groupId, area, file, sibling } = await conflictedMove();
        const before = await exactUsage(groupId);
        expect((await sibling()).status).toBe('published');
        expect((await node(file.nodeId))?.purgedAt).not.toBeNull();
        expect(await own(ana.workspaceId)).toEqual({ used: 0n, reserved: 0n });
        expect(await own(area.workspaceId)).toEqual({ used: 300n * MIB, reserved: 0n });
        expect(await exactUsage(groupId)).toEqual(before);
    });

    test('attached after the source changed, it is stale and leaves the source', async () => {
        const { ana, area, file, sibling } = await conflictedMove();
        await newVersion(ana.userId, file);
        expect((await sibling()).status).toBe('move-stale');
        expect((await node(file.nodeId))?.purgedAt).toBeNull();
        expect(await own(area.workspaceId)).toEqual({ used: 0n, reserved: 0n });
    });

    test('a mover held ahead of a removal after begin: the expiry job finds it stale, and the family’s file stays', async () => {
        const { ben, groupId, area } = await family(4n * GIB);
        const file = await stored(ben.userId, area, 300n * MIB);
        const moved = await begin(ben.userId, ben, 300n * MIB, moveOf(file));
        if (moved.result.status !== 'ok') throw new Error(moved.result.status);
        expect((await drive.startCompleting(ben.workspaceId, moved.result.uploadId)).status).toBe(
            'ok',
        );
        await db.insert(groupHolds).values({
            groupId,
            userId: ben.userId,
            expiresAt: new Date(Date.now() + DAY),
        });
        // No writer: the expiry job's completion, which holds the mover to the same rules.
        expect(
            (await drive.finishCompleting(ben.workspaceId, moved.result.uploadId, 300n * MIB))
                .status,
        ).toBe('move-stale');
        expect((await node(file.nodeId))?.purgedAt).toBeNull();
        expect(await own(area.workspaceId)).toEqual({ used: 300n * MIB, reserved: 0n });
        expect(await own(ben.workspaceId)).toEqual({ used: 0n, reserved: 0n });
    });
});

describe('moves across two pools are charged in full, and still atomic', () => {
    test('a family whose plan ended: out of the folder the copy pays its own way and the original goes with it; into the folder there is no room', async () => {
        const { ana, groupId, area } = await family(4n * GIB);
        const theirs = await stored(ana.userId, area, 50n);
        // The plan lapses (past its period and the grace days): Ana is back on her own
        // allowance, with room to spare, and the folder reads an empty pool.
        await billing.applyGroupState({
            groupId,
            provider: 'polar',
            customerId: 'cus_family',
            subscriptions: [
                {
                    ...plan(4n * GIB),
                    status: 'past_due',
                    currentPeriodStart: new Date(Date.now() - 34 * DAY),
                    currentPeriodEnd: new Date(Date.now() - 4 * DAY),
                },
            ],
            graceMs: 3 * DAY,
        });
        await db
            .update(workspaceStorage)
            .set({ baseQuotaBytes: 10n * GIB })
            .where(eq(workspaceStorage.workspaceId, ana.workspaceId));
        // Into the folder: two pools, so the copy needs the folder's room, and it has none.
        const mine = await stored(ana.userId, ana, 50n);
        expect((await begin(ana.userId, area, 50n, moveOf(mine))).result.status).toBe('over-quota');
        expect((await node(mine.nodeId))?.purgedAt).toBeNull();
        // Out of the folder: charged in full to her own allowance (the source frees the
        // folder's bytes, not hers), and the source deleted in the same transaction.
        const moved = await begin(ana.userId, ana, 50n, moveOf(theirs));
        if (moved.result.status !== 'ok') throw new Error(moved.result.status);
        expect(await uploadRow(moved.result.uploadId)).toMatchObject({ reservedBytes: 50n });
        expect((await complete(ana.workspaceId, moved.result.uploadId, 50n)).status).toBe(
            'published',
        );
        expect((await node(theirs.nodeId))?.purgedAt).not.toBeNull();
        expect(await own(area.workspaceId)).toEqual({ used: 0n, reserved: 0n });
        expect(await own(ana.workspaceId)).toEqual({ used: 100n, reserved: 0n });
    });

    test('a family that never had a plan: refused for room, not as a move, and nothing reserved', async () => {
        const { ana, area } = await family(null);
        await db
            .update(workspaceStorage)
            .set({ baseQuotaBytes: 10n * GIB })
            .where(eq(workspaceStorage.workspaceId, ana.workspaceId));
        const mine = await stored(ana.userId, ana, 50n);
        expect((await begin(ana.userId, area, 50n, moveOf(mine))).result.status).toBe('over-quota');
        expect(await own(area.workspaceId)).toEqual({ used: 0n, reserved: 0n });
    });

    test('a company area: out of it is refused by its policy; into it is another pool, charged in full', async () => {
        const { ana, groupId, area } = await family(4n * GIB);
        // A company (an org group) with its own live pool, and a folder Ana holds as a member.
        const orgId = randomUUID();
        await db.insert(groupsTable).values({
            id: orgId,
            idSeed: randomBytes(16).toString('base64url'),
            kind: 'org',
            name: 'Acme',
            creatorUserId: ana.userId,
            firstEd25519PublicKey: randomBytes(32),
            firstMlDsaPublicKey: randomBytes(1952),
            rosterVersion: 1,
            rosterDigest: randomBytes(32),
            groupKeyVersion: 1,
        });
        await db.insert(groupMemberships).values({
            groupId: orgId,
            groupKind: 'org',
            userId: ana.userId,
            state: 'active',
            roles: ['members'],
            admittedAt: new Date(),
        });
        const [made] = await db
            .insert(workspaces)
            .values({
                ownerKind: 'group',
                groupId: orgId,
                areaKind: 'shared',
                idSeed: randomBytes(16).toString('base64url'),
            })
            .returning({ id: workspaces.id });
        await db.insert(workspaceStorage).values({ workspaceId: made!.id, baseQuotaBytes: 0n });
        await db.insert(groupStorage).values({
            groupId: orgId,
            quotaBytes: 10n * GIB,
            expiresAt: new Date(Date.now() + 10 * DAY),
        });
        await hold(made!.id, ana.userId);
        const company: Place = { workspaceId: made!.id, root: await rootOf(made!.id, ana.userId) };
        const report = await stored(ana.userId, company, 50n);
        // Company → You: HushOS won't move it, into her own files or the family's folder.
        expect((await begin(ana.userId, ana, 50n, moveOf(report))).result.status).toBe('policy');
        expect((await begin(ana.userId, area, 50n, moveOf(report))).result.status).toBe('policy');
        // You → company: allowed (owner decision 1), and charged to the company's pool in full.
        const mine = await stored(ana.userId, ana, 50n);
        const moved = await begin(ana.userId, company, 50n, moveOf(mine));
        if (moved.result.status !== 'ok') throw new Error(moved.result.status);
        expect(await uploadRow(moved.result.uploadId)).toMatchObject({ reservedBytes: 50n });
        expect(await own(company.workspaceId)).toEqual({ used: 50n, reserved: 50n });
        expect(await exactUsage(groupId)).toEqual({ used: 50n, reserved: 0n });
    });

    test('someone else’s file is no source, and someone else’s workspace no destination', async () => {
        const { ana, ben, area } = await family(4n * GIB);
        const bens = await stored(ben.userId, ben, 50n);
        // Ana can't name Ben's own files as a source.
        expect((await begin(ana.userId, area, 50n, moveOf(bens))).result.status).toBe('not-found');
        expect((await node(bens.nodeId))?.purgedAt).toBeNull();
        // Nor move into a workspace she doesn't hold (a folder shared with her included: the
        // route lets an editor upload there, the move asks for the workspace itself).
        const mine = await stored(ana.userId, ana, 50n);
        expect((await begin(ana.userId, ben, 50n, moveOf(mine))).result.status).toBe('not-found');
        // A move within one workspace is the tree's own move, not an upload.
        expect((await begin(ana.userId, ana, 50n, moveOf(mine))).result.status).toBe('invalid');
        expect(await own(area.workspaceId)).toEqual({ used: 0n, reserved: 0n });
    });
});
