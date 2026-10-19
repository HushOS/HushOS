import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import type { GroupSubscriptionSnapshot } from './billing';
import type { EntryChange, ParsedRoster } from './groups';

/*
 * One pool for a family's folders and every member's own files
 * (docs/families-shared-pool.md 3), on real Postgres: what the pool counts and
 * what it doesn't, when a member's own files draw from it, and the races its
 * lock settles, with real uploads, admissions and departures run against
 * each other on separate connections.
 */
process.env.BILLING_PROVIDER = 'polar';

const {
    closeDatabase,
    createTestAccount,
    createTestFamily,
    createTestIdentity,
    resetDatabase,
    setTestMember,
} = await import('../test/helpers');
const signed = await import('../test/signed');
const auth = await import('./auth');
const billing = await import('./billing');
const { db } = await import('./client');
const drive = await import('./drive');
const groups = await import('./groups');
const { poolUsage } = await import('./pool');
const {
    groupDepartures,
    groupMemberships,
    groups: groupsTable,
    storageEntitlements,
    workspaceKeys,
    workspaceStorage,
    workspaces,
} = await import('./schema');

beforeEach(resetDatabase);
afterAll(closeDatabase);

const DAY = 24 * 60 * 60 * 1000;
const GRACE = 3 * DAY;

type Root = { id: string; epoch: number };
type Person = { userId: string; workspaceId: string; email: string; root: Root };

/* A family's plan as Polar reports it, paid for, with a pool of `quotaBytes`. */
function plan(quotaBytes: bigint, overrides: Partial<GroupSubscriptionSnapshot> = {}) {
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
        ...overrides,
    } satisfies GroupSubscriptionSnapshot;
}

async function apply(groupId: string, subscriptions: GroupSubscriptionSnapshot[]) {
    return billing.applyGroupState({
        groupId,
        provider: 'polar',
        customerId: 'cus_family',
        subscriptions,
        graceMs: GRACE,
    });
}

/* Past its period end and the grace days, never re-read: billing wrote it, then nothing. */
const lapsed = (quotaBytes: bigint) =>
    plan(quotaBytes, {
        status: 'past_due',
        currentPeriodStart: new Date(Date.now() - 34 * DAY),
        currentPeriodEnd: new Date(Date.now() - 4 * DAY),
    });

async function rootOf(workspaceId: string, userId: string): Promise<Root> {
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

/* An account with an identity and a top folder, whose own allowance is `quotaBytes`. */
async function person(quotaBytes = 100n): Promise<Person> {
    const account = await createTestAccount({ quotaBytes });
    await createTestIdentity(account.userId);
    return { ...account, root: await rootOf(account.workspaceId, account.userId) };
}

/* `userId` holds the family folder's key, as a member does: one `workspace_keys` row per member. */
async function holdArea(areaId: string, userId: string) {
    await db.insert(workspaceKeys).values({
        workspaceId: areaId,
        userId,
        keyVersion: 1,
        workspaceKeyVersion: 1,
        wrappingSalt: randomBytes(32),
        wrappingNonce: randomBytes(24),
        encryptedKey: randomBytes(48),
    });
}

/* A family of `organizer` and `members` with `areas` folders, and a live plan unless `quota` is null. */
async function family(input: {
    organizer: Person;
    members?: Person[];
    areas?: number;
    quota: bigint | null;
}) {
    const made = await createTestFamily({
        organizerId: input.organizer.userId,
        members: (input.members ?? []).map((member) => ({ userId: member.userId })),
        areas: input.areas ?? 1,
        pooled: true,
    });
    if (input.quota !== null) await apply(made.groupId, [plan(input.quota)]);
    return made;
}

/*
 * An upload begin of `bytes` into `root` of `workspaceId` by `userId`, with its epoch drawn
 * now, so that the begin itself can be started later, at the same time as another.
 */
async function prepareUpload(userId: string, workspaceId: string, root: Root, bytes: bigint) {
    const epoch = (await drive.allocateKeyEpochs(workspaceId, 1))!.from;
    const objectId = randomUUID();
    return async () =>
        (
            await signed.beginUpload({
                workspaceId,
                userId,
                node: {
                    existing: false,
                    id: randomUUID(),
                    parentId: root.id,
                    envelopes: {
                        keyEpoch: epoch,
                        parentKeyEpoch: root.epoch,
                        keyEnvelope: randomBytes(72),
                        metadataEnvelope: randomBytes(100),
                    },
                },
                version: { id: randomUUID(), contentKeyEnvelope: randomBytes(72) },
                object: {
                    id: objectId,
                    objectKey: `ws/${workspaceId}/${objectId}`,
                    contentSuite: 2,
                    chunkSize: 8 * 1024 * 1024,
                    chunkCount: 1,
                    contentNonce: randomBytes(16),
                    ciphertextSize: bytes,
                },
                multipartId: `mp-${objectId}`,
                expiresAt: new Date(Date.now() + DAY),
            })
        ).status;
}

async function upload(who: Person, bytes: bigint) {
    return (await prepareUpload(who.userId, who.workspaceId, who.root, bytes))();
}

async function setBytes(workspaceId: string, used: bigint, reserved = 0n) {
    await db
        .update(workspaceStorage)
        .set({ usedBytes: used, reservedBytes: reserved })
        .where(eq(workspaceStorage.workspaceId, workspaceId));
}

async function own(workspaceId: string) {
    const [row] = await db
        .select({ used: workspaceStorage.usedBytes, reserved: workspaceStorage.reservedBytes })
        .from(workspaceStorage)
        .where(eq(workspaceStorage.workspaceId, workspaceId));
    return row!;
}

async function entitle(workspaceId: string, source: string, quotaBytes: bigint) {
    const [row] = await db
        .insert(storageEntitlements)
        .values({
            workspaceId,
            source,
            sourceReference: `${source}_${randomUUID()}`,
            quotaBytes,
            expiresAt: new Date(Date.now() + 10 * DAY),
        })
        .returning({ id: storageEntitlements.id });
    return row!.id;
}

/* The roster that admits `userId`, built on the group's head as stored (statements are opaque here). */
async function admission(groupId: string, admin: string, userId: string) {
    const [head] = await db.select().from(groupsTable).where(eq(groupsTable.id, groupId));
    return {
        groupId,
        uploaderUserId: admin,
        expectedRevision: head!.chainRevision,
        route: { kind: 'admit' as const, userId, seatLimitDefault: 20 },
        roster: {
            statement: randomBytes(64),
            ed25519Signature: randomBytes(64),
            mlDsaSignature: randomBytes(3309),
            signerSignature: randomBytes(3373),
            version: head!.rosterVersion + 1,
            previousDigest: head!.rosterDigest,
            groupKeyVersion: head!.groupKeyVersion,
            signerUserId: admin,
            signerMlDsaPublicKey: randomBytes(1952),
            changes: [{ userId, status: 'active', roles: [] }] as EntryChange[],
            dropsHolder: false,
        } as ParsedRoster,
        grants: [],
        seals: [],
        cache: { through: head!.rosterVersion + 1 },
    };
}

async function stateIn(groupId: string, userId: string) {
    const [row] = await db
        .select({ state: groupMemberships.state })
        .from(groupMemberships)
        .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, userId)));
    return row?.state ?? null;
}

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

/*
 * Holds the lock `statement` takes on its own connection while `during` starts work that
 * queues on it, then lets it go. `during` returns that work unawaited (in an object, so it
 * isn't awaited here) and the caller awaits it after the lock is gone.
 */
async function holding<T>(
    statement: string,
    params: unknown[],
    during: (blocker: Client) => Promise<T>,
): Promise<T> {
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    try {
        await blocker.query('begin');
        await blocker.query(statement, params);
        return await during(blocker);
    } finally {
        await blocker.query('commit');
        await blocker.end();
    }
}

describe('pool usage', () => {
    test('counts each family folder and each member’s own files once, a leaver’s not at all', async () => {
        const organizer = await person();
        const ana = await person();
        const sam = await person();
        const leaver = await person();
        const outsider = await person();
        const { groupId, areaIds } = await family({
            organizer,
            members: [ana, sam],
            areas: 3,
            quota: 10_000n,
        });
        // Every member holds every folder's key: three rows per folder, which a join through
        // them would multiply each folder's bytes by.
        for (const areaId of areaIds)
            for (const member of [organizer, ana, sam]) await holdArea(areaId, member.userId);
        await setTestMember({ groupId, userId: leaver.userId, state: 'left' });
        await setBytes(areaIds[0]!, 10n, 1n);
        await setBytes(areaIds[1]!, 20n);
        // Deleted, not purged: its files are still stored and still draw from the pool.
        await setBytes(areaIds[2]!, 50n);
        await db
            .update(workspaces)
            .set({ deletedAt: sql`now()` })
            .where(eq(workspaces.id, areaIds[2]!));
        await setBytes(organizer.workspaceId, 100n, 3n);
        await setBytes(ana.workspaceId, 200n);
        await setBytes(sam.workspaceId, 400n);
        await setBytes(leaver.workspaceId, 800n);
        await setBytes(outsider.workspaceId, 1600n);

        expect(await poolUsage(db, groupId)).toEqual({ used: 780n, reserved: 4n });
        // Drive's check, the account's figures and the family's summary read the same numbers.
        expect(await drive.getStorage(ana.workspaceId)).toEqual({
            allowance: 10_000n,
            used: 780n,
            reserved: 4n,
            free: 10_000n - 784n,
            pool: { groupId },
        });
        expect(await drive.getStorage(areaIds[0]!)).toMatchObject({ used: 780n, reserved: 4n });
        expect(await auth.getStorageAllowance(sam.userId)).toEqual({
            workspaceId: sam.workspaceId,
            quotaBytes: '10000',
            usedBytes: '780',
            reservedBytes: '4',
            availableBytes: String(10_000 - 784),
            pool: { groupId, name: 'The Family' },
        });
        expect((await billing.getPoolUsage(groupId)).used).toBe(780n);
        // The leaver and the outsider keep their own allowances, counting only their own bytes.
        expect(await auth.getStorageAllowance(leaver.userId)).toMatchObject({
            quotaBytes: '100',
            usedBytes: '800',
            availableBytes: '0',
            pool: null,
        });
    });

    test('a member’s own files draw from the pool only while the family’s plan is live', async () => {
        const organizer = await person();
        const ana = await person(100n);
        const { groupId, areaIds } = await family({ organizer, members: [ana], quota: null });
        // No plan yet: Ana's own 100 bytes, and the folders hold nothing.
        expect(await drive.getStorage(ana.workspaceId)).toMatchObject({
            allowance: 100n,
            pool: null,
        });
        expect(await upload(ana, 500n)).toBe('over-quota');
        // The plan goes live: the pool, not her own allowance.
        await apply(groupId, [plan(1000n)]);
        expect(await upload(ana, 500n)).toBe('ok');
        expect(await drive.getStorage(ana.workspaceId)).toMatchObject({
            allowance: 1000n,
            reserved: 500n,
            free: 500n,
            pool: { groupId },
        });
        expect((await auth.getStorageAllowance(ana.userId))?.pool).toEqual({
            groupId,
            name: 'The Family',
        });
        // Past the period end and the grace days: back on her own 100 bytes, over it with the
        // 500 reserved, and the folders read an empty pool.
        await apply(groupId, [lapsed(1000n)]);
        expect(await drive.getStorage(ana.workspaceId)).toMatchObject({
            allowance: 100n,
            reserved: 500n,
            free: -400n,
            pool: null,
        });
        expect(await upload(ana, 32n)).toBe('over-quota');
        expect((await drive.getStorage(areaIds[0]!))?.allowance).toBe(0n);
        expect((await auth.getStorageAllowance(ana.userId))?.pool).toBeNull();
    });

    test('a personal plan in force keeps its owner on it until it ends; then the pool, never both', async () => {
        const organizer = await person(100n);
        const pro = await entitle(organizer.workspaceId, 'polar', 300n);
        const ana = await person();
        const { groupId } = await family({ organizer, members: [ana], quota: null });
        await setBytes(organizer.workspaceId, 50n);
        // No family plan: Free's base and Pro.
        expect((await drive.getStorage(organizer.workspaceId))?.allowance).toBe(400n);
        // The family plan goes live: the organizer stays on Pro to the end of what they paid
        // for (owner decision 2), and their files are not the pool's.
        await apply(groupId, [plan(1000n)]);
        expect(await drive.getStorage(organizer.workspaceId)).toMatchObject({
            allowance: 400n,
            used: 50n,
            pool: null,
        });
        expect(await poolUsage(db, groupId)).toEqual({ used: 0n, reserved: 0n });
        expect(await upload(organizer, 351n)).toBe('over-quota');
        // Pro ends: the pool, Pro and the base gone from the figures, their bytes in the pool's.
        await db
            .update(storageEntitlements)
            .set({ revokedAt: new Date() })
            .where(eq(storageEntitlements.id, pro));
        expect(await drive.getStorage(organizer.workspaceId)).toMatchObject({
            allowance: 1000n,
            used: 50n,
            pool: { groupId },
        });
        expect(await poolUsage(db, groupId)).toEqual({ used: 50n, reserved: 0n });
        expect(await upload(organizer, 351n)).toBe('ok');
        // The family plan lapses too: their own base again.
        await apply(groupId, [lapsed(1000n)]);
        expect((await drive.getStorage(organizer.workspaceId))?.allowance).toBe(100n);
    });

    test('a pooled member’s referral bonus and operator grant add nothing, and count again once they leave', async () => {
        const organizer = await person();
        const ana = await person(100n);
        await entitle(ana.workspaceId, 'referral', 50n);
        await entitle(ana.workspaceId, 'admin', 25n);
        const { groupId } = await family({ organizer, members: [ana], quota: 1000n });
        await setBytes(organizer.workspaceId, 300n);
        expect(await drive.getStorage(ana.workspaceId)).toMatchObject({
            allowance: 1000n,
            used: 300n,
            free: 700n,
        });
        expect((await auth.getStorageAllowance(ana.userId))?.availableBytes).toBe('700');
        expect(await groups.leaveGroup(groupId, ana.userId)).toEqual({ status: 'left' });
        expect(await drive.getStorage(ana.workspaceId)).toMatchObject({
            allowance: 175n,
            used: 0n,
            free: 175n,
            pool: null,
        });
        // And the pool no longer counts anything of hers.
        await setBytes(ana.workspaceId, 60n);
        expect(await poolUsage(db, groupId)).toEqual({ used: 300n, reserved: 0n });
    });
});

describe('races', () => {
    test('two members’ uploads into their own files that each fit alone: exactly one is reserved', async () => {
        const organizer = await person();
        const ana = await person(10_000n);
        const sam = await person(10_000n);
        const { groupId } = await family({ organizer, members: [ana, sam], quota: 1000n });
        const begins = [
            await prepareUpload(ana.userId, ana.workspaceId, ana.root, 600n),
            await prepareUpload(sam.userId, sam.workspaceId, sam.root, 600n),
        ];
        // The pool row, held here, queues both behind it; let go, they race for it.
        const { results } = await holding(
            'select group_id from group_storage where group_id = $1 for update',
            [groupId],
            async (blocker) => {
                const results = Promise.all(begins.map((begin) => begin()));
                expect(await lockWaiters(blocker, 2)).toBeGreaterThanOrEqual(2);
                return { results };
            },
        );
        expect((await results).sort()).toEqual(['ok', 'over-quota']);
        const usage = await poolUsage(db, groupId);
        expect(usage.reserved).toBe(600n);
        expect(usage.used + usage.reserved).toBeLessThanOrEqual(1000n);
    });

    test('an upload into a member’s own files and one into a family folder spend the same pool', async () => {
        const organizer = await person();
        const ana = await person(10_000n);
        const { groupId, areaIds } = await family({ organizer, members: [ana], quota: 1000n });
        await holdArea(areaIds[0]!, organizer.userId);
        const areaRoot = await rootOf(areaIds[0]!, organizer.userId);
        const begins = [
            await prepareUpload(ana.userId, ana.workspaceId, ana.root, 600n),
            await prepareUpload(organizer.userId, areaIds[0]!, areaRoot, 600n),
        ];
        const { results } = await holding(
            'select group_id from group_storage where group_id = $1 for update',
            [groupId],
            async (blocker) => {
                const results = Promise.all(begins.map((begin) => begin()));
                expect(await lockWaiters(blocker, 2)).toBeGreaterThanOrEqual(2);
                return { results };
            },
        );
        expect((await results).sort()).toEqual(['ok', 'over-quota']);
        expect((await poolUsage(db, groupId)).reserved).toBe(600n);
    });

    test('a leave waits for an upload that holds the pool; the leaver’s own allowance then counts it', async () => {
        const organizer = await person();
        const ana = await person(100n);
        const { groupId } = await family({ organizer, members: [ana], quota: 1000n });
        const begin = await prepareUpload(ana.userId, ana.workspaceId, ana.root, 500n);
        // Ana's storage row, held here, stops her upload after it took the pool's lock.
        const { uploading, leaving } = await holding(
            'select workspace_id from workspace_storage where workspace_id = $1 for update',
            [ana.workspaceId],
            async (blocker) => {
                const uploading = begin();
                expect(await lockWaiters(blocker, 1)).toBeGreaterThanOrEqual(1);
                let finished = false;
                const leaving = groups.leaveGroup(groupId, ana.userId).finally(() => {
                    finished = true;
                });
                // The leave queues on the pool behind the upload: it can't finish first.
                expect(await lockWaiters(blocker, 2)).toBeGreaterThanOrEqual(2);
                expect(finished).toBe(false);
                return { uploading, leaving };
            },
        );
        expect(await uploading).toBe('ok');
        expect(await leaving).toEqual({ status: 'left' });
        // Checked against the pool while she was in the family; hers alone now, over her 100.
        expect(await drive.getStorage(ana.workspaceId)).toMatchObject({
            allowance: 100n,
            reserved: 500n,
            free: -400n,
            pool: null,
        });
        expect(await poolUsage(db, groupId)).toEqual({ used: 0n, reserved: 0n });
        expect(await upload(ana, 32n)).toBe('over-quota');
    });

    test('an upload that waited on a leave reads the membership again and lands on the leaver’s own allowance', async () => {
        const organizer = await person();
        const ana = await person(100n);
        const { groupId } = await family({ organizer, members: [ana], quota: 1000n });
        const begin = await prepareUpload(ana.userId, ana.workspaceId, ana.root, 500n);
        // Ana's membership row, held here, stops the leave after it took the pool's lock.
        const { uploading, leaving } = await holding(
            'select user_id from group_memberships where group_id = $1 and user_id = $2 for update',
            [groupId, ana.userId],
            async (blocker) => {
                const leaving = groups.leaveGroup(groupId, ana.userId);
                expect(await lockWaiters(blocker, 1)).toBeGreaterThanOrEqual(1);
                // She is still a member as the upload starts, so it resolves the family's pool.
                const uploading = begin();
                expect(await lockWaiters(blocker, 2)).toBeGreaterThanOrEqual(2);
                return { uploading, leaving };
            },
        );
        expect(await leaving).toEqual({ status: 'left' });
        // Not the pool's 1000 free: her own 100, which 500 doesn't fit.
        expect(await uploading).toBe('over-quota');
        expect(await own(ana.workspaceId)).toEqual({ used: 0n, reserved: 0n });
        expect(await poolUsage(db, groupId)).toEqual({ used: 0n, reserved: 0n });
    });

    test('an admission counts the newcomer’s upload in flight: it waits for it, then refuses', async () => {
        const organizer = await person();
        const newcomer = await person(10_000n);
        const { groupId, areaIds } = await family({ organizer, quota: 1000n });
        await setBytes(areaIds[0]!, 800n);
        await setBytes(newcomer.workspaceId, 150n);
        await setTestMember({ groupId, userId: newcomer.userId, state: 'accepted' });
        const begin = await prepareUpload(
            newcomer.userId,
            newcomer.workspaceId,
            newcomer.root,
            500n,
        );
        const call = await admission(groupId, organizer.userId, newcomer.userId);
        // Their top folder, held here, stops the upload at its new file, after it reserved.
        const { uploading, admitting } = await holding(
            'select id from drive_nodes where id = $1 for update',
            [newcomer.root.id],
            async (blocker) => {
                const uploading = begin();
                expect(await lockWaiters(blocker, 1)).toBeGreaterThanOrEqual(1);
                const admitting = groups.appendChain(call);
                expect(await lockWaiters(blocker, 2)).toBeGreaterThanOrEqual(2);
                return { uploading, admitting };
            },
        );
        // On their own 10,000 the upload fits; with it, 650 of theirs is more than the 200 free.
        expect(await uploading).toBe('ok');
        expect(await admitting).toEqual({ status: 'pool-full' });
        expect(await stateIn(groupId, newcomer.userId)).toBe('accepted');
    });

    test('an upload that waited on an admission finds its owner in the family and checks the pool', async () => {
        const organizer = await person();
        const newcomer = await person(10_000n);
        const { groupId, areaIds } = await family({ organizer, quota: 1000n });
        await setBytes(areaIds[0]!, 800n);
        await setBytes(newcomer.workspaceId, 150n);
        await setTestMember({ groupId, userId: newcomer.userId, state: 'accepted' });
        const begin = await prepareUpload(
            newcomer.userId,
            newcomer.workspaceId,
            newcomer.root,
            500n,
        );
        const call = await admission(groupId, organizer.userId, newcomer.userId);
        // The chain caches, held here, stop the admission at its last write, with its locks.
        const { uploading, admitting } = await holding(
            'lock table group_chain_caches in access exclusive mode',
            [],
            async (blocker) => {
                const admitting = groups.appendChain(call);
                expect(await lockWaiters(blocker, 1)).toBeGreaterThanOrEqual(1);
                // Still in no family as it starts: their own 10,000 would take it.
                const uploading = begin();
                expect(await lockWaiters(blocker, 2)).toBeGreaterThanOrEqual(2);
                return { uploading, admitting };
            },
        );
        expect((await admitting).status).toBe('ok');
        // 150 fitted the 200 free; the pool now has 50, which 500 doesn't fit.
        expect(await uploading).toBe('over-quota');
        expect(await poolUsage(db, groupId)).toEqual({ used: 950n, reserved: 0n });
    });

    test('admissions, leaves, billing’s pool writes and uploads in three workspaces of one family never deadlock', async () => {
        const organizer = await person();
        const one = await person(1n << 30n);
        const two = await person(1n << 30n);
        const { groupId, areaIds } = await family({ organizer, members: [one], quota: 1n << 40n });
        await holdArea(areaIds[0]!, organizer.userId);
        const areaRoot = await rootOf(areaIds[0]!, organizer.userId);
        for (let round = 0; round < 200; round++) {
            const [leaver, newcomer] = round % 2 === 0 ? [one, two] : [two, one];
            // Each round starts from one leaver in and one newcomer waiting, departures marked.
            await db.delete(groupDepartures).where(eq(groupDepartures.groupId, groupId));
            await setTestMember({ groupId, userId: leaver.userId, state: 'active' });
            await setTestMember({ groupId, userId: newcomer.userId, state: 'accepted' });
            const call = await admission(groupId, organizer.userId, newcomer.userId);
            const begins = [
                await prepareUpload(leaver.userId, leaver.workspaceId, leaver.root, 32n),
                await prepareUpload(newcomer.userId, newcomer.workspaceId, newcomer.root, 32n),
                await prepareUpload(organizer.userId, areaIds[0]!, areaRoot, 32n),
            ];
            const [admitted, left, written, ...uploads] = await Promise.all([
                groups.appendChain(call),
                groups.leaveGroup(groupId, leaver.userId),
                apply(groupId, [plan(1n << 40n)]),
                ...begins.map((begin) => begin()),
            ]);
            // A leave that lands first makes the admission wait for its marking; never a deadlock.
            expect(['ok', 'left-due']).toContain(admitted.status);
            expect(left).toEqual({ status: 'left' });
            expect(written).toBe(true);
            expect(uploads).toEqual(['ok', 'ok', 'ok']);
        }
    }, 180_000);
});

describe('pool-full', () => {
    test('a newcomer whose own files are more than the free space is refused; one byte less is admitted', async () => {
        const organizer = await person();
        const newcomer = await person();
        const { groupId, areaIds } = await family({ organizer, quota: 1000n });
        await setBytes(areaIds[0]!, 300n);
        await setBytes(organizer.workspaceId, 150n, 50n);
        await setTestMember({ groupId, userId: newcomer.userId, state: 'accepted' });
        // 500 free; theirs, used and reserved together, 501.
        await setBytes(newcomer.workspaceId, 400n, 101n);
        const call = await admission(groupId, organizer.userId, newcomer.userId);
        expect(await groups.admissionFitsNow(groupId, newcomer.userId)).toBe(false);
        expect(await groups.appendChain(call)).toEqual({ status: 'pool-full' });
        expect(await stateIn(groupId, newcomer.userId)).toBe('accepted');
        const [head] = await db.select().from(groupsTable).where(eq(groupsTable.id, groupId));
        expect(head!.rosterVersion).toBe(1);
        // 500: exactly what is free.
        await setBytes(newcomer.workspaceId, 400n, 100n);
        expect(await groups.admissionFitsNow(groupId, newcomer.userId)).toBe(true);
        expect((await groups.appendChain(call)).status).toBe('ok');
        expect(await drive.getStorage(newcomer.workspaceId)).toMatchObject({
            allowance: 1000n,
            free: 0n,
            pool: { groupId },
        });
    });

    test('a family without a live plan lets anyone in: nobody is pooled yet', async () => {
        const organizer = await person();
        const newcomer = await person();
        const { groupId } = await family({ organizer, quota: null });
        await setTestMember({ groupId, userId: newcomer.userId, state: 'accepted' });
        await setBytes(newcomer.workspaceId, 5000n);
        expect(
            (await groups.appendChain(await admission(groupId, organizer.userId, newcomer.userId)))
                .status,
        ).toBe('ok');
        expect((await drive.getStorage(newcomer.workspaceId))?.pool).toBeNull();
    });
});
