import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GroupSubscriptionSnapshot } from './billing';
import type { EntryChange, ParsedRoster } from './groups';
import type * as PoolModule from './pool';

/*
 * A family's name read while its row goes (a dissolution between resolving the pool and naming
 * it): only that one race test sets it; every other test reads the real name.
 */
const race = vi.hoisted(() => ({ nameGone: false }));
vi.mock('./pool', async (importOriginal) => {
    const actual = await importOriginal<typeof PoolModule>();
    return {
        ...actual,
        poolName: (...args: Parameters<typeof actual.poolName>) =>
            race.nameGone ? Promise.resolve(null) : actual.poolName(...args),
    };
});

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

/* The pool's exact bytes: what its parts sum to, which no check and no figure uses. */
async function exactUsage(groupId: string) {
    const { used, reserved } = await poolUsage(db, groupId);
    return { used, reserved };
}
const GIB = 1n << 30n;
const MIB = 1n << 20n;
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
        readingFrom: await billing.readingStamp(),
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
async function prepareBegin(userId: string, workspaceId: string, root: Root, bytes: bigint) {
    const epoch = (await drive.allocateKeyEpochs(workspaceId, 1))!.from;
    const objectId = randomUUID();
    const nodeId = randomUUID();
    const versionId = randomUUID();
    const begin = async () =>
        signed.beginUpload({
            workspaceId,
            userId,
            node: {
                existing: false,
                id: nodeId,
                parentId: root.id,
                envelopes: {
                    keyEpoch: epoch,
                    parentKeyEpoch: root.epoch,
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
                ciphertextSize: bytes,
            },
            multipartId: `mp-${objectId}`,
            expiresAt: new Date(Date.now() + DAY),
        });
    return { begin, nodeId, versionId };
}

async function prepareUpload(userId: string, workspaceId: string, root: Root, bytes: bigint) {
    const { begin } = await prepareBegin(userId, workspaceId, root, bytes);
    return async () => (await begin()).status;
}

/* A finished upload of `bytes` into `who`'s top folder: a file whose current version is ready. */
async function stored(who: Person, bytes: bigint) {
    const { begin, nodeId, versionId } = await prepareBegin(
        who.userId,
        who.workspaceId,
        who.root,
        bytes,
    );
    const result = await begin();
    if (result.status !== 'ok') throw new Error(`beginUpload ${result.status}`);
    expect((await drive.startCompleting(who.workspaceId, result.uploadId)).status).toBe('ok');
    expect((await drive.finishCompleting(who.workspaceId, result.uploadId, bytes)).status).toBe(
        'published',
    );
    return { nodeId, versionId };
}

/* A copy of `source` into `who`'s top folder (no bytes move; the copy pays for the object). */
async function copy(who: Person, source: { nodeId: string; versionId: string }) {
    const epoch = (await drive.allocateKeyEpochs(who.workspaceId, 1))!.from;
    return (
        await signed.copyFile({
            workspaceId: who.workspaceId,
            userId: who.userId,
            sourceNodeId: source.nodeId,
            sourceVersionId: source.versionId,
            node: {
                id: randomUUID(),
                parentId: who.root.id,
                envelopes: {
                    keyEpoch: epoch,
                    parentKeyEpoch: who.root.epoch,
                    keyEnvelope: randomBytes(72),
                    metadataEnvelope: randomBytes(100),
                },
            },
            version: { id: randomUUID(), contentKeyEnvelope: randomBytes(84) },
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

/* The roster that removes `userId` (no roles), built on the group's head as stored. */
async function removal(groupId: string, admin: string, userId: string) {
    const call = await admission(groupId, admin, userId);
    return {
        ...call,
        route: { kind: 'remove' as const, userId },
        roster: {
            ...call.roster,
            changes: [{ userId, status: 'left', roles: [] }] as EntryChange[],
        } as ParsedRoster,
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
            quota: 10n * GIB,
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

        expect(await exactUsage(groupId)).toEqual({ used: 780n, reserved: 4n });
        // Four parts, each counted as a whole GiB: the folders together, and three members.
        expect((await poolUsage(db, groupId)).counted).toBe(4n * GIB);
        // Drive's check, the account's figures and the family's summary read the same parts.
        // Ana may take the pool less the other three parts (3 GiB) less her own 200 bytes.
        expect(await drive.getStorage(ana.workspaceId)).toEqual({
            allowance: 10n * GIB,
            used: 780n,
            reserved: 4n,
            free: 7n * GIB - 200n,
            shown: { used: 4n * GIB, free: 6n * GIB },
            pool: { groupId },
        });
        // A folder: the pool less the three members' parts less the folders' part, which is
        // everyone's, counted in whole GiB too (a writer there doesn't learn its exact bytes).
        expect(await drive.getStorage(areaIds[0]!)).toMatchObject({
            used: 780n,
            reserved: 4n,
            free: 6n * GIB,
        });
        // The account's figures are the pool's as it counts them (see 'what one member sees').
        expect(await auth.getStorageAllowance(sam.userId)).toEqual({
            workspaceId: sam.workspaceId,
            quotaBytes: String(10n * GIB),
            usedBytes: String(4n * GIB),
            reservedBytes: '0',
            availableBytes: String(6n * GIB),
            pool: { groupId, name: 'The Family' },
            // Beside the pool's: Sam's own 400 bytes, exactly, and his own 100-byte allowance,
            // never anyone else's bytes.
            own: { usedBytes: '400', allowanceBytes: '100' },
        });
        expect((await billing.getPoolUsage(groupId)).used).toBe(4n * GIB);
        // The leaver and the outsider keep their own allowances, counting only their own bytes.
        expect(await auth.getStorageAllowance(leaver.userId)).toMatchObject({
            quotaBytes: '100',
            usedBytes: '800',
            availableBytes: '0',
            pool: null,
            own: null,
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
        await apply(groupId, [plan(2n * GIB)]);
        expect(await upload(ana, 500n)).toBe('ok');
        expect(await drive.getStorage(ana.workspaceId)).toMatchObject({
            allowance: 2n * GIB,
            reserved: 500n,
            free: 2n * GIB - 500n,
            pool: { groupId },
        });
        expect((await auth.getStorageAllowance(ana.userId))?.pool).toEqual({
            groupId,
            name: 'The Family',
        });
        // Past the period end and the grace days: back on her own 100 bytes, over it with the
        // 500 reserved, and the folders read an empty pool.
        await apply(groupId, [lapsed(2n * GIB)]);
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

    test('a personal plan doesn’t keep its owner out of the pool: pooled at once, and the plan adds nothing', async () => {
        const organizer = await person(100n);
        await entitle(organizer.workspaceId, 'polar', 3n * GIB);
        const ana = await person();
        const { groupId } = await family({ organizer, members: [ana], quota: null });
        await setBytes(organizer.workspaceId, 50n);
        // No family plan: Free's base and Pro.
        expect((await drive.getStorage(organizer.workspaceId))?.allowance).toBe(3n * GIB + 100n);
        // The family plan goes live: their files draw from the pool at once (owner decision 2),
        // and Pro's 3 GiB, until billing ends it, adds nothing.
        await apply(groupId, [plan(2n * GIB)]);
        expect(await drive.getStorage(organizer.workspaceId)).toMatchObject({
            allowance: 2n * GIB,
            used: 50n,
            free: 2n * GIB - 50n,
            pool: { groupId },
        });
        expect(await exactUsage(groupId)).toEqual({ used: 50n, reserved: 0n });
        expect((await auth.getStorageAllowance(organizer.userId))?.pool).toEqual({
            groupId,
            name: 'The Family',
        });
        // What a pooled member may spend is the pool less the others' parts (none stored) less
        // their own exact bytes: one byte more is refused, though Pro would hold it.
        expect(await upload(organizer, 2n * GIB - 49n)).toBe('over-quota');
        expect(await upload(organizer, 2n * GIB - 50n)).toBe('ok');
        // The family plan lapses: their own allowance again, with whatever it still holds.
        await apply(groupId, [lapsed(2n * GIB)]);
        expect(await drive.getStorage(organizer.workspaceId)).toMatchObject({
            allowance: 3n * GIB + 100n,
            pool: null,
        });
    });

    test('a pooled member’s referral bonus and operator grant add nothing, and count again once they leave', async () => {
        const organizer = await person();
        const ana = await person(100n);
        await entitle(ana.workspaceId, 'referral', 50n);
        await entitle(ana.workspaceId, 'admin', 25n);
        const { groupId } = await family({ organizer, members: [ana], quota: 10n * GIB });
        await setBytes(organizer.workspaceId, 300n);
        // Exactly the pool less the organizer's files as it counts them (a whole GiB).
        expect(await drive.getStorage(ana.workspaceId)).toMatchObject({
            allowance: 10n * GIB,
            used: 300n,
            free: 9n * GIB,
        });
        // What the leave dialog reads: the allowance she'd have on her own, her bonus and grant
        // included, beside the pool's figures, and her own files only.
        await setBytes(ana.workspaceId, 40n);
        expect(await auth.getStorageAllowance(ana.userId)).toMatchObject({
            quotaBytes: String(10n * GIB),
            own: { usedBytes: '40', allowanceBytes: '175' },
        });
        await setBytes(ana.workspaceId, 0n);
        expect(await groups.leaveGroup(groupId, ana.userId)).toEqual({ status: 'left' });
        expect(await drive.getStorage(ana.workspaceId)).toMatchObject({
            allowance: 175n,
            used: 0n,
            free: 175n,
            pool: null,
        });
        // And the pool no longer counts anything of hers.
        await setBytes(ana.workspaceId, 60n);
        expect(await exactUsage(groupId)).toEqual({ used: 300n, reserved: 0n });
    });
});

describe('what one member sees', () => {
    test('one member’s storage figures can’t give away another’s bytes to better than 1 GB, nor their uploads', async () => {
        const maya = await person();
        const sam = await person();
        const { groupId, areaIds } = await family({
            organizer: maya,
            members: [sam],
            quota: 100n * GIB,
        });
        await setBytes(areaIds[0]!, 3n * GIB + 5n);
        await setBytes(maya.workspaceId, 2n * GIB + 7n);
        await setBytes(sam.workspaceId, 5n * GIB + 123n);
        const before = await auth.getStorageAllowance(maya.userId);
        // Three parts, each rounded up on its own: the folders 4, Maya 3, Sam 6.
        expect(before).toEqual({
            workspaceId: maya.workspaceId,
            quotaBytes: String(100n * GIB),
            usedBytes: String(13n * GIB),
            reservedBytes: '0',
            availableBytes: String(87n * GIB),
            pool: { groupId, name: 'The Family' },
            // Her own files exactly, which she knows; nothing of Sam's.
            own: { usedBytes: String(2n * GIB + 7n), allowanceBytes: '100' },
        });
        // Sam stores half a gigabyte more and starts a 300 MB upload: Maya's figures don't move.
        await setBytes(sam.workspaceId, 5n * GIB + 500n * MIB + 12n, 300n * MIB);
        expect(await auth.getStorageAllowance(maya.userId)).toEqual(before);
        // A refusal names what Maya may take: the pool less the others' parts (10 GiB) less her
        // own exact bytes, which she knows; nothing of Sam's finer than his whole GiB.
        const refused = await (
            await prepareBegin(maya.userId, maya.workspaceId, maya.root, 200n * GIB)
        ).begin();
        expect(refused).toEqual({ status: 'over-quota', free: 88n * GIB - 7n });
        expect(await upload(maya, 88n * GIB - 6n)).toBe('over-quota');
        expect(await upload(maya, 88n * GIB - 7n)).toBe('ok');
        expect(await auth.getStorageAllowance(maya.userId)).toMatchObject({
            usedBytes: String(13n * GIB),
            availableBytes: '0',
            reservedBytes: '0',
        });
    });

    test('probing upload sizes can’t tell apart two usages within the same GB', async () => {
        const maya = await person();
        const sam = await person();
        const { areaIds } = await family({ organizer: maya, members: [sam], quota: 100n * GIB });
        await setBytes(areaIds[0]!, 3n * GIB);
        // Sam stores 11 GiB and 100 MiB, or 11 GiB and 900 MiB. Maya asks about the sizes around
        // what may be spent and around each usage's exact free space.
        const exactFree = (samBytes: bigint) => 100n * GIB - 3n * GIB - samBytes;
        const sizes = [85n * GIB - 1n, 85n * GIB, 85n * GIB + 1n, 86n * GIB];
        for (const samBytes of [11n * GIB + 100n * MIB, 11n * GIB + 900n * MIB])
            for (const d of [-1n, 0n, 1n]) sizes.push(exactFree(samBytes) + d);
        // Every answer upload begin gives, each accepted one then cancelled (her counters set back).
        async function probe(samBytes: bigint) {
            await setBytes(sam.workspaceId, samBytes);
            const out: string[] = [];
            for (const size of sizes) {
                const result = await (
                    await prepareBegin(maya.userId, maya.workspaceId, maya.root, size)
                ).begin();
                out.push(result.status === 'over-quota' ? `refused:${result.free}` : result.status);
                await setBytes(maya.workspaceId, 0n, 0n);
            }
            return out;
        }
        const near = await probe(11n * GIB + 100n * MIB);
        const far = await probe(11n * GIB + 900n * MIB);
        expect(near).toEqual(far);
        // 85 GiB may be spent in both (100 - 3 - 12, rounded down): it fits, a byte more doesn't.
        expect(near.slice(0, 4)).toEqual([
            'ok',
            'ok',
            `refused:${85n * GIB}`,
            `refused:${85n * GIB}`,
        ]);
    });

    test('changing her own files byte by byte can’t tell Maya another member’s usage within a GB', async () => {
        const maya = await person();
        const sam = await person();
        const newcomer = await person();
        const { groupId, areaIds } = await family({
            organizer: maya,
            members: [sam],
            quota: 100n * GIB,
        });
        await setBytes(areaIds[0]!, 3n * GIB);
        await setTestMember({ groupId, userId: newcomer.userId, state: 'accepted' });
        // Sam stores 11 GiB and 100 MiB, or 11 GiB and 900 MiB. Counted exactly, the pool's total
        // would cross a whole GiB at a different size of Maya's own files in each case (900 MiB
        // and 100 MiB); she steps her own files across both, a byte at a time.
        const sizes: bigint[] = [];
        for (const edge of [100n * MIB, 900n * MIB, GIB]) sizes.push(edge - 1n, edge, edge + 1n);
        // Everything she or a payer can read: her figures, what an upload is refused with, the
        // family's total (the summary and the downgrade and first-purchase guards), whether a
        // newcomer of 85 GiB less a few bytes would fit (pool-full).
        async function observe(samBytes: bigint) {
            await setBytes(sam.workspaceId, samBytes);
            await setBytes(newcomer.workspaceId, 85n * GIB - 3n);
            const out: unknown[] = [];
            for (const mine of sizes) {
                await setBytes(maya.workspaceId, mine);
                const figures = await auth.getStorageAllowance(maya.userId);
                const refused = await (
                    await prepareBegin(maya.userId, maya.workspaceId, maya.root, 200n * GIB)
                ).begin();
                await setBytes(maya.workspaceId, mine);
                out.push([
                    mine,
                    figures?.usedBytes,
                    figures?.availableBytes,
                    refused.status === 'over-quota' ? refused.free + mine : refused.status,
                    (await billing.getPoolUsage(groupId)).used,
                    await groups.admissionFitsNow(groupId, newcomer.userId),
                ]);
            }
            return out;
        }
        expect(await observe(11n * GIB + 100n * MIB)).toEqual(
            await observe(11n * GIB + 900n * MIB),
        );
    });

    test('a payer stepping the family folders byte by byte can’t tell a member’s usage within a GB', async () => {
        const maya = await person();
        const sam = await person();
        const { groupId, areaIds } = await family({
            organizer: maya,
            members: [sam],
            quota: 100n * GIB,
        });
        await holdArea(areaIds[0]!, maya.userId);
        const folderRoot = await rootOf(areaIds[0]!, maya.userId);
        await setBytes(maya.workspaceId, 2n * GIB);
        // Maya pays and manages; she steps the folders' bytes across where the exact total would
        // cross a GiB with Sam at 100 MiB or 900 MiB over 11 GiB, and around whole GiB.
        const sizes: bigint[] = [];
        for (const edge of [3n * GIB + 100n * MIB, 3n * GIB + 900n * MIB, 4n * GIB])
            sizes.push(edge - 1n, edge, edge + 1n);
        // What the downgrade and first-purchase guards and the summary compare (the family's
        // total), and what an upload into the folder is refused with.
        async function observe(samBytes: bigint) {
            await setBytes(sam.workspaceId, samBytes);
            const out: unknown[] = [];
            for (const folders of sizes) {
                await setBytes(areaIds[0]!, folders);
                const refused = await (
                    await prepareBegin(maya.userId, areaIds[0]!, folderRoot, 200n * GIB)
                ).begin();
                await setBytes(areaIds[0]!, folders);
                out.push([
                    folders,
                    (await billing.getPoolUsage(groupId)).used,
                    refused.status === 'over-quota' ? refused.free : refused.status,
                ]);
            }
            return out;
        }
        expect(await observe(11n * GIB + 100n * MIB)).toEqual(
            await observe(11n * GIB + 900n * MIB),
        );
        // Someone else's upload into the folder, 100 MiB or 300 MiB in flight: a writer there is
        // refused with the same figure, so it doesn't show the folders' exact bytes either.
        async function inFlight(reserved: bigint) {
            await setBytes(areaIds[0]!, 3n * GIB, reserved);
            const result = await (
                await prepareBegin(maya.userId, areaIds[0]!, folderRoot, 200n * GIB)
            ).begin();
            await setBytes(areaIds[0]!, 3n * GIB, reserved);
            return result;
        }
        expect(await inFlight(100n * MIB)).toEqual(await inFlight(300n * MIB));
    });

    test('an empty pool reads 0 used; anything up to 1 GB reads as 1 GB', async () => {
        const maya = await person();
        const sam = await person();
        await family({ organizer: maya, members: [sam], quota: 100n * GIB });
        expect(await auth.getStorageAllowance(maya.userId)).toMatchObject({
            usedBytes: '0',
            availableBytes: String(100n * GIB),
        });
        await setBytes(sam.workspaceId, 1n);
        expect(await auth.getStorageAllowance(maya.userId)).toMatchObject({
            usedBytes: String(GIB),
            availableBytes: String(99n * GIB),
        });
        await setBytes(sam.workspaceId, GIB);
        expect((await auth.getStorageAllowance(maya.userId))?.usedBytes).toBe(String(GIB));
        await setBytes(sam.workspaceId, GIB + 1n);
        expect((await auth.getStorageAllowance(maya.userId))?.usedBytes).toBe(String(2n * GIB));
    });

    test('a pool whose name can’t be read answers nothing, never the pool’s exact figures', async () => {
        const maya = await person();
        const sam = await person();
        const { areaIds } = await family({ organizer: maya, members: [sam], quota: 100n * GIB });
        await setBytes(areaIds[0]!, 3n * GIB + 5n);
        await setBytes(sam.workspaceId, 5n * GIB + 123n, 7n);
        race.nameGone = true;
        try {
            // The exact figures (Sam's bytes to the byte, in flight included) would give Sam's
            // usage away to Maya; read without the family's name, there is no answer at all.
            expect(await auth.getStorageAllowance(maya.userId)).toBeNull();
        } finally {
            race.nameGone = false;
        }
        expect((await auth.getStorageAllowance(maya.userId))?.usedBytes).toBe(String(10n * GIB));
    });

    test('the endpoint reads without the pool’s lock: a held pool doesn’t stall a member’s figures', async () => {
        const maya = await person();
        const sam = await person();
        const { groupId } = await family({ organizer: maya, members: [sam], quota: 100n * GIB });
        await holding(
            'select group_id from group_storage where group_id = $1 for update',
            [groupId],
            async () => {
                expect((await auth.getStorageAllowance(sam.userId))?.pool).toEqual({
                    groupId,
                    name: 'The Family',
                });
                return {};
            },
        );
    });
});

describe('copies', () => {
    test('a copy in a member’s own files spends the pool, not their own allowance', async () => {
        const maya = await person();
        const sam = await person(10n * GIB);
        const { groupId } = await family({ organizer: maya, members: [sam], quota: 2n * GIB });
        const source = await stored(sam, 700n * MIB);
        // 700 MiB used leaves 1 GiB to spend: one copy fits; the second, against what then rounds
        // down to nothing, doesn't, though
        // Sam's own 10,000 would hold both.
        expect(await copy(sam, source)).toBe('ok');
        expect(await copy(sam, source)).toBe('over-quota');
        expect(await exactUsage(groupId)).toEqual({ used: 1400n * MIB, reserved: 0n });
    });
});

describe('races', () => {
    test('two members’ uploads into their own files that each fit alone: exactly one is reserved', async () => {
        const organizer = await person();
        const ana = await person(10n * GIB);
        const sam = await person(10n * GIB);
        const { groupId } = await family({ organizer, members: [ana, sam], quota: 2n * GIB });
        const begins = [
            await prepareUpload(ana.userId, ana.workspaceId, ana.root, 1200n * MIB),
            await prepareUpload(sam.userId, sam.workspaceId, sam.root, 1200n * MIB),
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
        expect(usage.reserved).toBe(1200n * MIB);
        expect(usage.used + usage.reserved).toBeLessThanOrEqual(2n * GIB);
    });

    test('an upload into a member’s own files and one into a family folder spend the same pool', async () => {
        const organizer = await person();
        const ana = await person(10n * GIB);
        const { groupId, areaIds } = await family({ organizer, members: [ana], quota: 2n * GIB });
        await holdArea(areaIds[0]!, organizer.userId);
        const areaRoot = await rootOf(areaIds[0]!, organizer.userId);
        const begins = [
            await prepareUpload(ana.userId, ana.workspaceId, ana.root, 1200n * MIB),
            await prepareUpload(organizer.userId, areaIds[0]!, areaRoot, 1200n * MIB),
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
        expect((await poolUsage(db, groupId)).reserved).toBe(1200n * MIB);
    });

    test('a leave waits for an upload that holds the pool; the leaver’s own allowance then counts it', async () => {
        const organizer = await person();
        const ana = await person(100n);
        const { groupId } = await family({ organizer, members: [ana], quota: 2n * GIB });
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
        expect(await exactUsage(groupId)).toEqual({ used: 0n, reserved: 0n });
        expect(await upload(ana, 32n)).toBe('over-quota');
    });

    test('an upload that waited on a leave reads the membership again and lands on the leaver’s own allowance', async () => {
        const organizer = await person();
        const ana = await person(100n);
        const { groupId } = await family({ organizer, members: [ana], quota: 2n * GIB });
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
        // Not the pool's 2 GiB: her own 100, which 500 doesn't fit.
        expect(await uploading).toBe('over-quota');
        expect(await own(ana.workspaceId)).toEqual({ used: 0n, reserved: 0n });
        expect(await exactUsage(groupId)).toEqual({ used: 0n, reserved: 0n });
    });

    test('an upload that waited on a removal reads the membership again and lands on the removed member’s own allowance', async () => {
        const organizer = await person();
        const ana = await person(100n);
        const { groupId } = await family({ organizer, members: [ana], quota: 2n * GIB });
        const begin = await prepareUpload(ana.userId, ana.workspaceId, ana.root, 500n);
        const call = await removal(groupId, organizer.userId, ana.userId);
        // Ana's membership row, held here, stops the removal after it took the pool's lock.
        const { uploading, removing } = await holding(
            'select user_id from group_memberships where group_id = $1 and user_id = $2 for update',
            [groupId, ana.userId],
            async (blocker) => {
                const removing = groups.appendChain(call);
                expect(await lockWaiters(blocker, 1)).toBeGreaterThanOrEqual(1);
                const uploading = begin();
                expect(await lockWaiters(blocker, 2)).toBeGreaterThanOrEqual(2);
                return { uploading, removing };
            },
        );
        expect((await removing).status).toBe('ok');
        expect(await stateIn(groupId, ana.userId)).toBe('removed');
        expect(await uploading).toBe('over-quota');
        expect(await own(ana.workspaceId)).toEqual({ used: 0n, reserved: 0n });
    });

    test('a group made before billing serialises its first plan against an upload into its folder', async () => {
        const organizer = await person();
        // No group_storage row: the folder keeps its own 10 GiB until a plan writes a pool.
        const { groupId, areaIds } = await createTestFamily({
            organizerId: organizer.userId,
            areas: 1,
        });
        await holdArea(areaIds[0]!, organizer.userId);
        const areaRoot = await rootOf(areaIds[0]!, organizer.userId);
        const begin = await prepareUpload(organizer.userId, areaIds[0]!, areaRoot, 500n);
        // The pool's lock, held here: the plan's write queues on it first, then the upload.
        const { writing, uploading } = await holding(
            'select pg_advisory_xact_lock($1::int, hashtext($2))',
            [0x706f6f6c, groupId],
            async (blocker) => {
                const writing = apply(groupId, [plan(100n)]);
                expect(await lockWaiters(blocker, 1)).toBeGreaterThanOrEqual(1);
                const uploading = begin();
                expect(await lockWaiters(blocker, 2)).toBeGreaterThanOrEqual(2);
                return { writing, uploading };
            },
        );
        expect(await writing).toMatchObject({ outcome: 'applied', superseded: [] });
        // Checked against the 100-byte pool the plan wrote, not the folder's old 10 GiB.
        expect(await uploading).toBe('over-quota');
    });

    test('an admission counts the newcomer’s upload in flight: it waits for it, then refuses', async () => {
        const organizer = await person();
        const newcomer = await person(10n * GIB);
        const { groupId, areaIds } = await family({ organizer, quota: 10n * GIB });
        await setBytes(areaIds[0]!, 8n * GIB);
        await setBytes(newcomer.workspaceId, GIB + 512n * MIB);
        await setTestMember({ groupId, userId: newcomer.userId, state: 'accepted' });
        const begin = await prepareUpload(
            newcomer.userId,
            newcomer.workspaceId,
            newcomer.root,
            600n * MIB,
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
        // On their own 10 GiB the upload fits; with it, theirs counts 3 GiB, more than the 2 free.
        expect(await uploading).toBe('ok');
        expect(await admitting).toEqual({ status: 'pool-full' });
        expect(await stateIn(groupId, newcomer.userId)).toBe('accepted');
    });

    test('an upload that waited on an admission finds its owner in the family and checks the pool', async () => {
        const organizer = await person();
        const newcomer = await person(10n * GIB);
        const { groupId, areaIds } = await family({ organizer, quota: 10n * GIB });
        await setBytes(areaIds[0]!, 8n * GIB);
        await setBytes(newcomer.workspaceId, GIB + 512n * MIB);
        await setTestMember({ groupId, userId: newcomer.userId, state: 'accepted' });
        const begin = await prepareUpload(
            newcomer.userId,
            newcomer.workspaceId,
            newcomer.root,
            600n * MIB,
        );
        const call = await admission(groupId, organizer.userId, newcomer.userId);
        // The chain caches, held here, stop the admission at its last write, with its locks.
        const { uploading, admitting } = await holding(
            'lock table group_chain_caches in access exclusive mode',
            [],
            async (blocker) => {
                const admitting = groups.appendChain(call);
                expect(await lockWaiters(blocker, 1)).toBeGreaterThanOrEqual(1);
                // Still in no family as it starts: their own 10 GiB would take it.
                const uploading = begin();
                expect(await lockWaiters(blocker, 2)).toBeGreaterThanOrEqual(2);
                return { uploading, admitting };
            },
        );
        expect((await admitting).status).toBe('ok');
        // 1.5 GiB fitted the 2 free; the pool now has 512 MiB for them, which 600 MiB doesn't fit.
        expect(await uploading).toBe('over-quota');
        expect(await exactUsage(groupId)).toEqual({ used: 9n * GIB + 512n * MIB, reserved: 0n });
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
            expect(written).toMatchObject({ outcome: 'applied', superseded: [] });
            expect(uploads).toEqual(['ok', 'ok', 'ok']);
        }
    }, 180_000);
});

describe('pool-full', () => {
    test('a newcomer whose own files are more than the free space is refused; one byte less is admitted', async () => {
        const organizer = await person();
        const newcomer = await person();
        const { groupId, areaIds } = await family({ organizer, quota: 10n * GIB });
        await setBytes(areaIds[0]!, 3n * GIB);
        // A GiB and a half stored and half a GiB on its way: counted as 2 GiB.
        await setBytes(organizer.workspaceId, GIB + 512n * MIB, 512n * MIB);
        await setTestMember({ groupId, userId: newcomer.userId, state: 'accepted' });
        // 5 GiB free; theirs, used and reserved together, a byte more.
        await setBytes(newcomer.workspaceId, 4n * GIB, GIB + 1n);
        const call = await admission(groupId, organizer.userId, newcomer.userId);
        expect(await groups.admissionFitsNow(groupId, newcomer.userId)).toBe(false);
        expect(await groups.appendChain(call)).toEqual({ status: 'pool-full' });
        expect(await stateIn(groupId, newcomer.userId)).toBe('accepted');
        const [head] = await db.select().from(groupsTable).where(eq(groupsTable.id, groupId));
        expect(head!.rosterVersion).toBe(1);
        // Exactly what is free.
        await setBytes(newcomer.workspaceId, 4n * GIB, GIB);
        expect(await groups.admissionFitsNow(groupId, newcomer.userId)).toBe(true);
        expect((await groups.appendChain(call)).status).toBe('ok');
        expect(await drive.getStorage(newcomer.workspaceId)).toMatchObject({
            allowance: 10n * GIB,
            free: 0n,
            pool: { groupId },
        });
    });

    test('a newcomer who pays for a personal plan is counted at admission and pooled from the moment they’re in', async () => {
        const organizer = await person();
        const newcomer = await person(100n);
        await entitle(newcomer.workspaceId, 'polar', 50n * GIB);
        const { groupId, areaIds } = await family({ organizer, quota: 10n * GIB });
        await setBytes(areaIds[0]!, 3n * GIB);
        await setTestMember({ groupId, userId: newcomer.userId, state: 'accepted' });
        const call = await admission(groupId, organizer.userId, newcomer.userId);
        // 7 GiB free; theirs a byte more, though their own plan would hold it.
        await setBytes(newcomer.workspaceId, 7n * GIB + 1n);
        expect(await groups.appendChain(call)).toEqual({ status: 'pool-full' });
        await setBytes(newcomer.workspaceId, 4n * GIB);
        expect((await groups.appendChain(call)).status).toBe('ok');
        expect(await exactUsage(groupId)).toEqual({ used: 7n * GIB, reserved: 0n });
        expect(await drive.getStorage(newcomer.workspaceId)).toMatchObject({
            allowance: 10n * GIB,
            used: 7n * GIB,
            free: 3n * GIB,
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
