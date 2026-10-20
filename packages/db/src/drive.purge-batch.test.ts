import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
    closeDatabase,
    createTestAccount,
    createTestFamily,
    createTestIdentity,
    resetDatabase,
} from '../test/helpers';
import * as signed from '../test/signed';
import { db } from './client';
import * as drive from './drive';
import {
    driveNodes,
    driveObjectDeletions,
    groupHolds,
    workspaceKeys,
    workspaceStorage,
} from './schema';

/*
 * Delete forever for a selection (purgeNodes): each node goes as purgeNode
 * would send it, through the same purgeOne (versions, the outbox, the
 * tombstone), or is refused on its own; nothing about one keeps another back.
 */

type Account = Awaited<ReturnType<typeof createTestAccount>>;
type Folder = { id: string; keyEpoch: number };
type Where = { workspaceId: string; userId: string };

const MiB = 1024n * 1024n;
let owner: Account;
let root: Folder;

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
async function makeRoot(where: Where): Promise<Folder> {
    const keyEpoch = (await drive.allocateKeyEpochs(where.workspaceId, 1))!.from;
    const created = await signed.createRoot({
        ...where,
        id: randomUUID(),
        envelopes: {
            keyEpoch,
            parentKeyEpoch: 1,
            keyEnvelope: randomBytes(72),
            metadataEnvelope: randomBytes(100),
        },
    });
    if (created.status !== 'created') throw new Error(created.status);
    return { id: created.root.id, keyEpoch: created.root.keyEpoch };
}
async function folders(parent: Folder, count: number, where: Where = owner): Promise<Folder[]> {
    const range = (await drive.allocateKeyEpochs(where.workspaceId, count))!;
    const made = Array.from({ length: count }, (_, i) => ({
        id: randomUUID(),
        parentId: parent.id,
        envelopes: {
            keyEpoch: range.from + i,
            parentKeyEpoch: parent.keyEpoch,
            keyEnvelope: randomBytes(72),
            metadataEnvelope: randomBytes(100),
        },
    }));
    for (let start = 0; start < made.length; start += 100) {
        const created = await signed.createFolders({
            ...where,
            folders: made.slice(start, start + 100),
        });
        if (created.status !== 'created') throw new Error(created.status);
    }
    return made.map((folder) => ({ id: folder.id, keyEpoch: folder.envelopes.keyEpoch }));
}
/* A published file of one 1 MiB chunk under `parent`: its node id, object and stored size. */
async function file(parent: Folder, where: Where = owner) {
    const ciphertext = MiB + 16n;
    const objectId = randomUUID();
    const begun = await signed.beginUpload({
        ...where,
        node: {
            existing: false,
            id: randomUUID(),
            parentId: parent.id,
            envelopes: {
                keyEpoch: (await drive.allocateKeyEpochs(where.workspaceId, 1))!.from,
                parentKeyEpoch: parent.keyEpoch,
                keyEnvelope: randomBytes(72),
                metadataEnvelope: randomBytes(100),
            },
        },
        version: { id: randomUUID(), contentKeyEnvelope: randomBytes(72) },
        object: {
            id: objectId,
            objectKey: `ws/${where.workspaceId}/${objectId}`,
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
    await drive.startCompleting(where.workspaceId, begun.uploadId);
    const done = await drive.finishCompleting(where.workspaceId, begun.uploadId, ciphertext);
    if (done.status !== 'published') throw new Error(done.status);
    return { id: done.node.id, keyEpoch: done.node.keyEpoch, objectId, ciphertext };
}
const trashOne = (nodeId: string, where: Where = owner) =>
    drive.trashNode({ workspaceId: where.workspaceId, nodeId, writer: where.userId });
async function trashEach(ids: string[], where: Where = owner) {
    for (const id of ids) {
        const result = await trashOne(id, where);
        if (result.status !== 'ok') throw new Error(result.status);
    }
}
const purgeAll = (nodeIds: string[], writer = owner.userId, workspaceId = owner.workspaceId) =>
    drive.purgeNodes({ workspaceId, nodeIds, writer });
const summary = (outcomes: drive.PurgeOutcome[]) =>
    Object.fromEntries(
        outcomes.map((outcome) => [
            outcome.id,
            outcome.status === 'refused'
                ? `refused ${outcome.reason}`
                : outcome.status === 'covered'
                  ? `covered by ${outcome.by}`
                  : outcome.status,
        ]),
    );
async function rows(ids: string[]) {
    const found = await db
        .select({
            id: driveNodes.id,
            purgedAt: driveNodes.purgedAt,
            trashedAt: driveNodes.trashedAt,
            keyEnvelope: driveNodes.keyEnvelope,
            changeSeq: driveNodes.changeSeq,
        })
        .from(driveNodes)
        .where(inArray(driveNodes.id, ids));
    return new Map(found.map((row) => [row.id, row]));
}
async function inOutbox(objectIds: string[]) {
    const found = await db
        .select({ objectId: driveObjectDeletions.objectId })
        .from(driveObjectDeletions)
        .where(inArray(driveObjectDeletions.objectId, objectIds));
    return new Set(found.map((row) => row.objectId));
}
async function used(workspaceId = owner.workspaceId) {
    const [row] = await db
        .select({ used: workspaceStorage.usedBytes })
        .from(workspaceStorage)
        .where(eq(workspaceStorage.workspaceId, workspaceId));
    return row!.used;
}
async function workspaceSeq(workspaceId = owner.workspaceId) {
    const result = await db.execute<{ change_seq: string }>(
        sql`select change_seq from workspaces where id = ${workspaceId}::uuid`,
    );
    return Number(result.rows[0]!.change_seq);
}
async function purgedCount(workspaceId = owner.workspaceId) {
    const found = await db
        .select({ id: driveNodes.id })
        .from(driveNodes)
        .where(and(eq(driveNodes.workspaceId, workspaceId), isNotNull(driveNodes.purgedAt)));
    return found.length;
}
/* Another transaction holding the workspace's row, as a long write would, until released. */
async function holdingLock(workspaceId = owner.workspaceId) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const done = db.transaction(async (tx) => {
        await tx.execute(sql`select id from workspaces where id = ${workspaceId}::uuid for update`);
        locked();
        await released;
    });
    await holding;
    return async () => {
        release();
        await done;
    };
}
const within = <T>(pending: Promise<T>, ms: number) =>
    Promise.race([
        pending.then((value) => ({ settled: true as const, value })),
        new Promise<{ settled: false }>((resolve) =>
            setTimeout(() => resolve({ settled: false }), ms),
        ),
    ]);

beforeEach(async () => {
    await resetDatabase();
    owner = await createTestAccount({ quotaBytes: 1024n * MiB });
    await createTestIdentity(owner.userId);
    await hold(owner.workspaceId, owner.userId);
    root = await makeRoot(owner);
});
afterAll(closeDatabase);

describe('deleting a selection forever', () => {
    test('a refused item keeps none of the rest back; what went reaches the outbox and frees its bytes', async () => {
        const [a, live, d] = [await file(root), await file(root), await file(root)];
        await trashEach([a.id, d.id]);
        const before = await used();
        const missing = randomUUID();
        const outcomes = await purgeAll([a.id, live.id, missing, root.id, d.id]);
        expect(outcomes.map((outcome) => outcome.id)).toEqual([
            a.id,
            live.id,
            missing,
            root.id,
            d.id,
        ]);
        expect(summary(outcomes)).toEqual({
            [a.id]: 'purged',
            [live.id]: 'refused not-trashed',
            [missing]: 'refused not-found',
            [root.id]: 'refused root',
            [d.id]: 'purged',
        });
        const after = await rows([a.id, live.id, d.id, root.id]);
        for (const id of [a.id, d.id]) {
            expect(after.get(id)!.purgedAt).not.toBeNull();
            expect(after.get(id)!.keyEnvelope).toBeNull();
        }
        expect(after.get(live.id)).toMatchObject({ purgedAt: null, trashedAt: null });
        expect(after.get(root.id)!.purgedAt).toBeNull();
        expect(await inOutbox([a.objectId, live.objectId, d.objectId])).toEqual(
            new Set([a.objectId, d.objectId]),
        );
        expect(await used()).toBe(before - a.ciphertext - d.ciphertext);
    });

    test('a folder and a trashed item inside it: the folder is purged, the item goes with it by the fan-out', async () => {
        const [folder] = await folders(root, 1);
        const inside = await file(folder!);
        // Each in the Trash on its own: two rows of the Trash.
        await trashEach([inside.id, folder!.id]);
        const outcomes = await purgeAll([inside.id, folder!.id]);
        expect(summary(outcomes)).toEqual({
            [inside.id]: `covered by ${folder!.id}`,
            [folder!.id]: 'purged',
        });
        // Not this request's to purge: unreachable now, gone once the fan-out reaches it, as
        // after a single purge of the folder.
        expect((await rows([inside.id])).get(inside.id)!.purgedAt).toBeNull();
        expect(await inOutbox([inside.objectId])).toEqual(new Set());
        expect(await drive.purgeDescendants()).toBe(1);
        expect((await rows([inside.id])).get(inside.id)!.purgedAt).not.toBeNull();
        expect(await inOutbox([inside.objectId])).toEqual(new Set([inside.objectId]));
    });

    test('an id from another workspace is not found, and its node is left alone', async () => {
        const other = await createTestAccount();
        await createTestIdentity(other.userId);
        await hold(other.workspaceId, other.userId);
        const theirs = await file(await makeRoot(other), other);
        await trashEach([theirs.id], other);
        const mine = await file(root);
        await trashEach([mine.id]);
        expect(summary(await purgeAll([theirs.id, mine.id]))).toEqual({
            [theirs.id]: 'refused not-found',
            [mine.id]: 'purged',
        });
        expect((await rows([theirs.id])).get(theirs.id)!.purgedAt).toBeNull();
        expect(await inOutbox([theirs.objectId])).toEqual(new Set());
    });

    test('change numbers: one each, in the order sent', async () => {
        const made = await folders(root, 3);
        await trashEach(made.map((node) => node.id));
        const [a, b, c] = made;
        const start = await workspaceSeq();
        const outcomes = await purgeAll([c!.id, a!.id, b!.id]);
        expect(
            outcomes.map((outcome) => (outcome.status === 'purged' ? outcome.changeSeq : null)),
        ).toEqual([start + 1, start + 2, start + 3]);
        const after = await rows([a!.id, b!.id, c!.id]);
        expect([c!, a!, b!].map((node) => after.get(node.id)!.changeSeq)).toEqual([
            start + 1,
            start + 2,
            start + 3,
        ]);
        expect(await workspaceSeq()).toBe(start + 3);
    });

    test('takes at most 200 items, each named once; 200 files split by the lock’s budget, the rest sent again until all are gone', async () => {
        const many: Awaited<ReturnType<typeof file>>[] = [];
        for (let i = 0; i < 200; i++) many.push(await file(root));
        const ids = many.map((entry) => entry.id);
        await drive.trashNodes({
            workspaceId: owner.workspaceId,
            nodeIds: ids,
            writer: owner.userId,
        });
        await expect(purgeAll([...ids, randomUUID()])).rejects.toThrow(RangeError);
        await expect(purgeAll([ids[0]!, ids[1]!, ids[0]!])).rejects.toThrow(RangeError);
        await expect(purgeAll([])).rejects.toThrow(RangeError);
        expect(await purgedCount()).toBe(0);
        const before = await used();
        const isBusy = (outcome: drive.PurgeOutcome) =>
            outcome.status === 'refused' && outcome.reason === 'busy';
        // A budget no database purges 200 files in: the split is certain, not the machine's luck.
        const first = await drive.purgeNodes({
            workspaceId: owner.workspaceId,
            nodeIds: ids,
            writer: owner.userId,
            budgetMs: 50,
        });
        const purged = first.filter((outcome) => outcome.status === 'purged').length;
        expect(purged).toBeGreaterThan(0);
        expect(purged).toBeLessThan(200);
        // In the order given: what went is the front, every one after it waits.
        expect(first.map((outcome) => outcome.status)).toEqual([
            ...Array<string>(purged).fill('purged'),
            ...Array<string>(200 - purged).fill('refused'),
        ]);
        expect(first.slice(purged).every(isBusy)).toBe(true);
        // What it purged stays purged: committed, its bytes freed, nothing of the rest touched.
        expect(await purgedCount()).toBe(purged);
        expect(await used()).toBe(before - BigInt(purged) * many[0]!.ciphertext);
        expect((await inOutbox(many.map((entry) => entry.objectId))).size).toBe(purged);
        // As the web sends them, with the real budget: the busy ones again, while that gets further.
        const took: number[] = [];
        let left = first.filter(isBusy).map((outcome) => outcome.id);
        while (left.length) {
            const started = performance.now();
            const outcomes = await purgeAll(left);
            took.push(performance.now() - started);
            expect(
                outcomes.every((outcome) => outcome.status === 'purged' || isBusy(outcome)),
            ).toBe(true);
            expect(
                outcomes.filter((outcome) => outcome.status === 'purged').length,
            ).toBeGreaterThan(0);
            left = outcomes.filter(isBusy).map((outcome) => outcome.id);
        }
        expect(await purgedCount()).toBe(200);
        expect((await inOutbox(many.map((entry) => entry.objectId))).size).toBe(200);
        expect(await used()).toBe(before - 200n * many[0]!.ciphertext);
        // The budget keeps each request inside the lock's limit, so none rolls back.
        for (const ms of took) expect(ms).toBeLessThan(drive.BATCH_HOLD_MS);
    }, 120_000);

    test('out of time, it keeps what it purged and answers the rest busy, with what they cover', async () => {
        const [first, second] = await folders(root, 2);
        const insideSecond = await file(second!);
        const loose = await file(root);
        await trashEach([insideSecond.id, first!.id, second!.id, loose.id]);
        // No time at all: the first goes, as every request must get somewhere; the rest wait.
        const outcomes = await drive.purgeNodes({
            workspaceId: owner.workspaceId,
            nodeIds: [first!.id, insideSecond.id, second!.id, loose.id],
            writer: owner.userId,
            budgetMs: 0,
        });
        expect(summary(outcomes)).toEqual({
            [first!.id]: 'purged',
            [insideSecond.id]: 'refused busy',
            [second!.id]: 'refused busy',
            [loose.id]: 'refused busy',
        });
        const after = await rows([first!.id, second!.id, loose.id, insideSecond.id]);
        expect(after.get(first!.id)!.purgedAt).not.toBeNull();
        for (const id of [second!.id, loose.id, insideSecond.id])
            expect(after.get(id)!.purgedAt).toBeNull();
        expect(await inOutbox([loose.objectId, insideSecond.objectId])).toEqual(new Set());
        // Sent again, they go.
        expect(summary(await purgeAll([insideSecond.id, second!.id, loose.id]))).toEqual({
            [insideSecond.id]: `covered by ${second!.id}`,
            [second!.id]: 'purged',
            [loose.id]: 'purged',
        });
    });
});

describe('the workspace’s lock', () => {
    test('someone who is not a member is answered without ever taking it, an editor included', async () => {
        const guest = await createTestAccount();
        await createTestIdentity(guest.userId);
        const [shared] = await folders(root, 1);
        const inside = await file(shared!);
        await trashEach([inside.id]);
        const made = await drive.createShare({
            workspaceId: owner.workspaceId,
            nodeId: shared!.id,
            granterUserId: owner.userId,
            granteeUserId: guest.userId,
            role: 'editor',
            keyEpoch: shared!.keyEpoch,
            shareEnvelope: randomBytes(4565),
        });
        if (made.status !== 'ok') throw new Error(made.status);
        const seq = await workspaceSeq();
        const release = await holdingLock();
        try {
            const answered = await within(purgeAll([inside.id, randomUUID()], guest.userId), 1_000);
            expect(answered.settled).toBe(true);
            if (!answered.settled) return;
            expect(answered.value.map((outcome) => outcome.status)).toEqual(['refused', 'refused']);
        } finally {
            await release();
        }
        expect(await workspaceSeq()).toBe(seq);
        expect((await rows([inside.id])).get(inside.id)!.purgedAt).toBeNull();
    });

    test('a member waits for it only a few seconds, then gives up having purged nothing', async () => {
        const item = await file(root);
        await trashEach([item.id]);
        const seq = await workspaceSeq();
        const release = await holdingLock();
        try {
            const started = performance.now();
            const answered = await within(
                purgeAll([item.id]).then(
                    () => 'answered',
                    (error: unknown) => error,
                ),
                6_000,
            );
            expect(answered.settled).toBe(true);
            if (!answered.settled) return;
            expect(answered.value).toBeInstanceOf(drive.BatchBusyError);
            expect(performance.now() - started).toBeGreaterThan(1_500);
            expect(performance.now() - started).toBeLessThan(4_000);
        } finally {
            await release();
        }
        expect(await workspaceSeq()).toBe(seq);
        expect(await inOutbox([item.objectId])).toEqual(new Set());
    }, 30_000);

    test('a family member held ahead of a removal purges nothing', async () => {
        const ben = await createTestAccount();
        await createTestIdentity(ben.userId);
        const { groupId, areaIds } = await createTestFamily({
            organizerId: owner.userId,
            members: [{ userId: ben.userId }],
        });
        const areaId = areaIds[0]!;
        for (const person of [owner, ben]) await hold(areaId, person.userId);
        const area = { workspaceId: areaId, userId: owner.userId };
        const item = await file(await makeRoot(area), area);
        await trashEach([item.id], area);
        await db.insert(groupHolds).values({
            groupId,
            userId: ben.userId,
            expiresAt: new Date(Date.now() + 86_400_000),
        });
        await expect(purgeAll([item.id], ben.userId, areaId)).rejects.toBeInstanceOf(
            drive.AccessEndedError,
        );
        expect((await rows([item.id])).get(item.id)!.purgedAt).toBeNull();
        expect(await inOutbox([item.objectId])).toEqual(new Set());
    });
});
