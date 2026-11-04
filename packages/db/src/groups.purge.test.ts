import { randomBytes, randomUUID } from 'node:crypto';
import { and, count, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { AnyPgTable } from 'drizzle-orm/pg-core';
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import type { Head as ChainHead, ParsedRoster, ParsedSuccession } from './groups';
import type { GroupRole } from './schema';

// A plan still running keeps a family: that rule reads billing, which is off with `none`.
process.env.BILLING_PROVIDER = 'polar';

const { closeDatabase, createTestAccount, createTestIdentity, resetDatabase } =
    await import('../test/helpers');
const signed = await import('../test/signed');
const billing = await import('./billing');
const { db } = await import('./client');
const drive = await import('./drive');
const groups = await import('./groups');
const { scopedId } = await import('./ids');
const s = await import('./schema');

/*
 * A dissolved family's purge (docs/groups-design.md 3.3): after
 * DISSOLVED_FAMILY_RETENTION_DAYS everything that was only the family's goes,
 * its stored objects through the deletion outbox; nothing else does. Every
 * family here is made and dissolved through the repository as the routes do
 * it (creation, invitation, admission, a succession, leaving), so the rows the
 * purge must find are the rows a real family leaves.
 */

beforeEach(resetDatabase);
afterAll(closeDatabase);

const DAYS = groups.DISSOLVED_FAMILY_RETENTION_DAYS;
const ORGANIZER: GroupRole[] = ['billing', 'guardian', 'members'];
const MiB = 1024n * 1024n;
// The purge's advisory lock space (groups.ts PURGE_LOCK_SPACE), held here as another run would.
const PURGE_LOCK_SPACE = 0x70757267;

type Account = Awaited<ReturnType<typeof createTestAccount>>;
type Head = Awaited<ReturnType<typeof groups.getGroupRow>> & {};

const seed = () => randomBytes(16).toString('base64url');
const signatures = () => ({
    ed25519Signature: randomBytes(64),
    mlDsaSignature: randomBytes(3309),
    signerSignature: randomBytes(3373),
});
const headOf = (row: Head) => ({
    rosterVersion: row.rosterVersion,
    rosterDigest: row.rosterDigest,
    groupKeyVersion: row.groupKeyVersion,
    revision: row.chainRevision,
});
async function head(groupId: string) {
    return headOf((await groups.getGroupRow(groupId))!);
}
function grant(h: ChainHead, workspaceId: string, granteeUserId: string, granterUserId: string) {
    return {
        workspaceId,
        workspaceKeyVersion: 1,
        granteeUserId,
        granteeKeyVersion: 1,
        granterUserId,
        rosterVersion: h.rosterVersion,
        rosterDigest: h.rosterDigest,
        envelope: randomBytes(4565),
    };
}
const selfGrant = () => ({
    keyVersion: 1,
    workspaceKeyVersion: 1,
    wrappingSalt: randomBytes(32),
    wrappingNonce: randomBytes(24),
    encryptedKey: randomBytes(48),
});

async function account() {
    const made = await createTestAccount();
    await createTestIdentity(made.userId);
    return made;
}

/* A family made by `creator` through createGroup, its first roster listing one area commitment. */
async function createFamily(creator: Account, options: { commitments?: boolean } = {}) {
    const idSeed = seed();
    const groupId = scopedId('group', creator.userId, idSeed)!;
    const areaSeed = seed();
    const areaId = scopedId('workspace', groupId, areaSeed)!;
    const first = {
        statement: Buffer.from(`roster 1 ${groupId}`),
        ...signatures(),
        version: 1,
        previousDigest: null,
        groupKeyVersion: 1,
        signerUserId: creator.userId,
        signerMlDsaPublicKey: randomBytes(1952),
        changes: [{ userId: creator.userId, status: 'active', roles: ORGANIZER }],
        dropsHolder: false,
        commitments: options.commitments === false ? [] : [randomBytes(32)],
    } as unknown as ParsedRoster;
    const firstHead = {
        rosterVersion: 1,
        rosterDigest: groups.statementDigest(first.statement),
        groupKeyVersion: 1,
        revision: 1,
    };
    const input = {
        id: groupId,
        idSeed,
        kind: 'family' as const,
        name: 'Lindqvist family',
        creatorUserId: creator.userId,
        firstEd25519PublicKey: randomBytes(32),
        firstMlDsaPublicKey: randomBytes(1952),
        roster: first,
        keySeal: {
            groupKeyVersion: 1,
            holderUserId: creator.userId,
            holderKeyVersion: 1,
            sealerUserId: creator.userId,
            rosterVersion: 1,
            rosterDigest: firstHead.rosterDigest,
            envelope: randomBytes(4597),
        },
        area: {
            workspaceId: areaId,
            idSeed: areaSeed,
            quotaBytes: 1n << 30n,
            selfGrant: selfGrant(),
        },
        grants: [grant(firstHead, areaId, creator.userId, creator.userId)],
        cache: { through: 1 },
    };
    const created = await groups.createGroup(input);
    if (created.status !== 'created') throw new Error(`createGroup ${JSON.stringify(created)}`);
    return { groupId, areaId, input };
}

async function invite(groupId: string, inviter: string, email: string) {
    const token = randomBytes(32);
    const invited = await groups.createInvitation({
        groupId,
        email,
        normalizedEmail: email,
        tokenHash: token,
        roles: [],
        invitedBy: inviter,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
    });
    return { invited, token };
}

/* `member` invited, accepted and let in by `creator`, with a grant of the area. */
async function admit(
    family: { groupId: string; areaId: string },
    creator: Account,
    member: Account,
) {
    const { token } = await invite(family.groupId, creator.userId, member.email);
    const accepted = await groups.acceptInvitation({ tokenHash: token, userId: member.userId });
    if (accepted.status !== 'accepted') throw new Error(`accept ${accepted.status}`);
    const h = await head(family.groupId);
    const roster = {
        statement: Buffer.from(`roster ${h.rosterVersion + 1} admit ${member.userId}`),
        ...signatures(),
        version: h.rosterVersion + 1,
        previousDigest: h.rosterDigest,
        groupKeyVersion: h.groupKeyVersion,
        signerUserId: creator.userId,
        signerMlDsaPublicKey: randomBytes(1952),
        changes: [{ userId: member.userId, status: 'active', roles: [] }],
        dropsHolder: false,
    } as unknown as ParsedRoster;
    const next = {
        ...h,
        rosterVersion: roster.version,
        rosterDigest: groups.statementDigest(roster.statement),
    };
    const result = await groups.appendChain({
        groupId: family.groupId,
        uploaderUserId: creator.userId,
        expectedRevision: h.revision,
        route: { kind: 'admit', userId: member.userId, seatLimitDefault: 6 },
        roster,
        grants: [grant(next, family.areaId, member.userId, creator.userId)],
        cache: {},
    });
    if (result.status !== 'ok') throw new Error(`admit ${JSON.stringify(result)}`);
}

/* A group key succession on its own, as a holder's device makes one. */
async function succeed(groupId: string, signer: Account) {
    const h = await head(groupId);
    const result = await groups.appendChain({
        groupId,
        uploaderUserId: signer.userId,
        expectedRevision: h.revision,
        route: { kind: 'succession' },
        succession: {
            statement: Buffer.from(`succession ${h.groupKeyVersion} ${groupId}`),
            ...signatures(),
            oldVersion: h.groupKeyVersion,
            newVersion: h.groupKeyVersion + 1,
            lastRosterVersion: h.rosterVersion,
            lastRosterDigest: h.rosterDigest,
            newEd25519PublicKey: randomBytes(32),
            newMlDsaPublicKey: randomBytes(1952),
            signerUserId: signer.userId,
            signerMlDsaPublicKey: randomBytes(1952),
        } as unknown as ParsedSuccession,
        cache: {},
    });
    if (result.status !== 'ok') throw new Error(`succession ${JSON.stringify(result)}`);
}

/* A root folder in `workspaceId` with one published file; the file's object id. */
async function fileIn(workspaceId: string, userId: string) {
    const epoch = async () => (await drive.allocateKeyEpochs(workspaceId, 1))!.from;
    const root = await signed.createRoot({
        workspaceId,
        userId,
        id: randomUUID(),
        envelopes: {
            keyEpoch: await epoch(),
            parentKeyEpoch: 1,
            keyEnvelope: randomBytes(72),
            metadataEnvelope: randomBytes(100),
        },
    });
    if (root.status !== 'created') throw new Error(root.status);
    const objectId = randomUUID();
    const ciphertext = MiB + 16n;
    const begun = await signed.beginUpload({
        workspaceId,
        userId,
        node: {
            existing: false,
            id: randomUUID(),
            parentId: root.root.id,
            envelopes: {
                keyEpoch: await epoch(),
                parentKeyEpoch: root.root.keyEpoch,
                keyEnvelope: randomBytes(72),
                metadataEnvelope: randomBytes(100),
            },
        },
        version: { id: randomUUID(), contentKeyEnvelope: randomBytes(72) },
        object: {
            id: objectId,
            objectKey: `ws/${workspaceId}/${objectId}`,
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
    if ((await drive.startCompleting(workspaceId, begun.uploadId)).status !== 'ok')
        throw new Error('startCompleting');
    const done = await drive.finishCompleting(workspaceId, begun.uploadId, ciphertext);
    if (done.status !== 'published') throw new Error(done.status);
    return { objectId, nodeId: done.node.id, rootId: root.root.id };
}

/*
 * A family as people leave one: made, a member let in, a succession, a file
 * in its folder, a rotation and an origin drop there, an invitation still
 * open, then the member leaves (a departure still to be marked) and the
 * organizer leaves last, which dissolves it. The member keeps a file of their
 * own, as one moved out of the family folder would be.
 */
async function dissolvedFamily(options: { commitments?: boolean } = {}) {
    const creator = await account();
    const member = await account();
    const family = await createFamily(creator, options);
    await admit(family, creator, member);
    await succeed(family.groupId, creator);
    const shared = await fileIn(family.areaId, creator.userId);
    await db.insert(s.driveRotations).values({
        workspaceId: family.areaId,
        nodeId: shared.rootId,
        targetEpoch: 9,
        startedBy: creator.userId,
    });
    await db.insert(s.driveOriginDrops).values({
        workspaceId: family.areaId,
        nodeId: shared.nodeId,
        metadataVersion: 1,
        originSignerId: member.userId,
        originEnvelope: randomBytes(100),
        originSignature: randomBytes(64),
        originKeyEnvelope: randomBytes(72),
        previousRekeySignature: randomBytes(64),
        previousRekeyerId: member.userId,
        droppedBy: creator.userId,
        targetEpoch: 9,
    });
    const invitee = await account();
    const pending = await invite(family.groupId, creator.userId, invitee.email);
    if (pending.invited.status !== 'created') throw new Error(pending.invited.status);
    const own = await fileIn(member.workspaceId, member.userId);
    expect(await groups.leaveGroup(family.groupId, member.userId)).toEqual({ status: 'left' });
    expect(await groups.leaveGroup(family.groupId, creator.userId)).toEqual({
        status: 'dissolved',
    });
    return { ...family, creator, member, invitee, shared, own, pendingToken: pending.token };
}

/*
 * Moves the clock: the family dissolved, and its folders retired with it, `days` ago.
 * Dissolving set both to the same instant; time passing moves both.
 */
async function dissolvedAgo(groupId: string, days: number) {
    await db
        .update(s.groups)
        .set({ dissolvedAt: sql`now() - make_interval(days => ${days})` })
        .where(eq(s.groups.id, groupId));
    await db
        .update(s.workspaces)
        .set({ deletedAt: sql`now() - make_interval(days => ${days})` })
        // Only what dissolving retired: a folder it left live stays live.
        .where(and(eq(s.workspaces.groupId, groupId), isNotNull(s.workspaces.deletedAt)));
}

/*
 * What the worker does, in the order a run of each job would: drive.purge's deleted
 * family folders (purgeDeletedAreas, at Drive's trash retention, 30 days like the
 * family's), then groups.purge-dissolved.
 */
async function purge() {
    const areas = await groups.purgeDeletedAreas(DAYS);
    return { areas, ...(await groups.purgeDissolvedFamilies(DAYS)) };
}
const NOTHING = { areas: 0, retired: 0, families: 0, busy: 0 };

async function rows(table: AnyPgTable, where: SQL | undefined) {
    const [row] = await db.select({ n: count() }).from(table).where(where);
    return row!.n;
}

/* What a family leaves in every table the purge must empty, by table. */
async function familyRows(groupId: string, areaIds: string[]) {
    const inAreas = <T extends { workspaceId: unknown }>(table: T) =>
        inArray((table as unknown as { workspaceId: never }).workspaceId, areaIds);
    return {
        groups: await rows(s.groups, eq(s.groups.id, groupId)),
        memberships: await rows(s.groupMemberships, eq(s.groupMemberships.groupId, groupId)),
        rosters: await rows(s.groupRosters, eq(s.groupRosters.groupId, groupId)),
        successions: await rows(s.groupKeySuccessions, eq(s.groupKeySuccessions.groupId, groupId)),
        seals: await rows(s.groupKeySeals, eq(s.groupKeySeals.groupId, groupId)),
        invitations: await rows(s.groupInvitations, eq(s.groupInvitations.groupId, groupId)),
        departures: await rows(s.groupDepartures, eq(s.groupDepartures.groupId, groupId)),
        chainCaches: await rows(s.groupChainCaches, eq(s.groupChainCaches.groupId, groupId)),
        areaGrants: await rows(s.areaGrants, eq(s.areaGrants.groupId, groupId)),
        workspaces: await rows(s.workspaces, eq(s.workspaces.groupId, groupId)),
        workspaceKeys: await rows(s.workspaceKeys, inAreas(s.workspaceKeys)),
        workspaceStorage: await rows(s.workspaceStorage, inAreas(s.workspaceStorage)),
        nodes: await rows(s.driveNodes, inAreas(s.driveNodes)),
        versions: await rows(s.fileVersions, inAreas(s.fileVersions)),
        objects: await rows(s.driveObjects, inAreas(s.driveObjects)),
        originDrops: await rows(s.driveOriginDrops, inAreas(s.driveOriginDrops)),
        rotations: await rows(s.driveRotations, inAreas(s.driveRotations)),
    };
}

async function outbox(objectId: string) {
    const [row] = await db
        .select()
        .from(s.driveObjectDeletions)
        .where(eq(s.driveObjectDeletions.objectId, objectId));
    return row ?? null;
}

/* The member's own drive, whole: their root, their file and its object, nothing queued. */
async function expectOwnDriveWhole(own: { objectId: string; nodeId: string }, workspaceId: string) {
    expect(await rows(s.workspaces, eq(s.workspaces.id, workspaceId))).toBe(1);
    expect(await rows(s.driveNodes, eq(s.driveNodes.id, own.nodeId))).toBe(1);
    expect(await rows(s.driveObjects, eq(s.driveObjects.id, own.objectId))).toBe(1);
    expect(await outbox(own.objectId)).toBeNull();
}

describe('purging a dissolved family', () => {
    test('dissolving retires its folders; nothing goes a day before the retention ends, then everything does', async () => {
        const family = await dissolvedFamily();
        // Dissolving marked the folder deleted, as deleting a family folder does: Drive's purge owns it.
        const [area] = await db
            .select()
            .from(s.workspaces)
            .where(eq(s.workspaces.id, family.areaId));
        const [group] = await db.select().from(s.groups).where(eq(s.groups.id, family.groupId));
        expect(area!.deletedAt).toEqual(group!.dissolvedAt);
        const before = await familyRows(family.groupId, [family.areaId]);
        // Dissolving already took every key sealed to a member: each leaver's seals, grants and
        // self-grants go when they leave, the last one's included.
        const sealedToMembers = ['seals', 'areaGrants', 'workspaceKeys'];
        for (const table of sealedToMembers)
            expect([table, before[table as keyof typeof before]]).toEqual([table, 0]);
        // Every other table holds something of the family, so the emptiness below means something.
        for (const [table, n] of Object.entries(before))
            if (!sealedToMembers.includes(table)) expect([table, n > 0]).toEqual([table, true]);

        await dissolvedAgo(family.groupId, DAYS - 1);
        expect(await purge()).toEqual(NOTHING);
        expect(await familyRows(family.groupId, [family.areaId])).toEqual(before);
        expect(await outbox(family.shared.objectId)).toBeNull();

        await dissolvedAgo(family.groupId, DAYS + 1);
        expect(await purge()).toEqual({ ...NOTHING, areas: 1, families: 1 });
        for (const [table, n] of Object.entries(await familyRows(family.groupId, [family.areaId])))
            expect([table, n]).toEqual([table, 0]);
        // The folder's stored object is queued for the store, by its key, as a purged file's is.
        expect(await outbox(family.shared.objectId)).toMatchObject({
            workspaceId: family.areaId,
            objectKey: `ws/${family.areaId}/${family.shared.objectId}`,
            published: true,
            doneAt: null,
        });
        // The member's own files, moved out or never in, are untouched.
        await expectOwnDriveWhole(family.own, family.member.workspaceId);
        expect(await rows(s.users, eq(s.users.id, family.member.userId))).toBe(1);
    });

    test('a family whose folders went earlier keeps its records for the whole retention', async () => {
        const family = await dissolvedFamily();
        // Its folder was deleted long before the family was dissolved, and is past the trash.
        await db
            .update(s.workspaces)
            .set({ deletedAt: sql`now() - make_interval(days => ${DAYS + 10})` })
            .where(eq(s.workspaces.groupId, family.groupId));
        await db
            .update(s.groups)
            .set({ dissolvedAt: sql`now() - make_interval(days => ${DAYS - 1})` })
            .where(eq(s.groups.id, family.groupId));
        expect(await purge()).toEqual({ ...NOTHING, areas: 1 });
        const kept = await familyRows(family.groupId, [family.areaId]);
        expect([kept.groups, kept.memberships, kept.rosters]).toEqual([1, 2, 2]);

        await db
            .update(s.groups)
            .set({ dissolvedAt: sql`now() - make_interval(days => ${DAYS + 1})` })
            .where(eq(s.groups.id, family.groupId));
        expect(await purge()).toEqual({ ...NOTHING, families: 1 });
        expect((await familyRows(family.groupId, [family.areaId])).groups).toBe(0);
    });

    test('a family dissolved long ago, before folders were retired on dissolving, gets the whole retention from now', async () => {
        const family = await dissolvedFamily();
        // As an earlier release (or one still serving in a rolling update) dissolved it, 60 days ago.
        await db
            .update(s.workspaces)
            .set({ deletedAt: null })
            .where(eq(s.workspaces.groupId, family.groupId));
        await db
            .update(s.groups)
            .set({ dissolvedAt: sql`now() - make_interval(days => 60)` })
            .where(eq(s.groups.id, family.groupId));
        const before = await familyRows(family.groupId, [family.areaId]);

        // The run that retires its folder, and every run after it, keep everything for now.
        expect(await purge()).toEqual({ ...NOTHING, retired: 1 });
        expect(await purge()).toEqual(NOTHING);
        expect(await familyRows(family.groupId, [family.areaId])).toEqual(before);
        expect(await outbox(family.shared.objectId)).toBeNull();
        const [area] = await db
            .select()
            .from(s.workspaces)
            .where(eq(s.workspaces.id, family.areaId));
        expect(Date.now() - area!.deletedAt!.getTime()).toBeLessThan(60_000);

        // 30 days after that, it goes.
        await db
            .update(s.workspaces)
            .set({ deletedAt: sql`now() - make_interval(days => ${DAYS + 1})` })
            .where(eq(s.workspaces.groupId, family.groupId));
        expect(await purge()).toEqual({ ...NOTHING, areas: 1, families: 1 });
        expect((await familyRows(family.groupId, [family.areaId])).groups).toBe(0);
    });

    test('the release’s migration gives families dissolved before it 30 days from the upgrade', async () => {
        // One with its folder still live, one whose only folder was deleted and purged long ago.
        const withFolder = await dissolvedFamily();
        const withoutFolder = await dissolvedFamily();
        await db
            .update(s.workspaces)
            .set({ deletedAt: null })
            .where(eq(s.workspaces.groupId, withFolder.groupId));
        await db
            .update(s.workspaces)
            .set({ deletedAt: sql`now() - make_interval(days => 90)` })
            .where(eq(s.workspaces.groupId, withoutFolder.groupId));
        expect(await groups.purgeDeletedAreas(DAYS)).toBe(1);
        await db
            .update(s.groups)
            .set({ dissolvedAt: sql`now() - make_interval(days => 60)` })
            .where(inArray(s.groups.id, [withFolder.groupId, withoutFolder.groupId]));

        // The migration's data statements, as the file holds them.
        const migration = readFileSync(
            new URL(
                '../drizzle/20261020151204_group_billing_no_group_fk/migration.sql',
                import.meta.url,
            ),
            'utf8',
        );
        const updates = migration
            .split('--> statement-breakpoint')
            .map((statement) => statement.replace(/^--.*$/gm, '').trim())
            .filter((statement) => statement.startsWith('UPDATE'));
        expect(updates).toHaveLength(2);
        for (const statement of updates) await db.execute(sql.raw(statement));

        expect(await purge()).toEqual(NOTHING);
        expect(await purge()).toEqual(NOTHING);
        expect((await familyRows(withFolder.groupId, [withFolder.areaId])).workspaces).toBe(1);
        for (const family of [withFolder, withoutFolder])
            expect((await familyRows(family.groupId, [family.areaId])).groups).toBe(1);
    });

    test('another family, dissolved recently or live, and personal drives are untouched', async () => {
        const gone = await dissolvedFamily();
        const recent = await dissolvedFamily();
        const liveOwner = await account();
        const live = await createFamily(liveOwner);
        const liveFile = await fileIn(live.areaId, liveOwner.userId);
        await dissolvedAgo(gone.groupId, DAYS + 1);
        await dissolvedAgo(recent.groupId, DAYS - 1);
        const recentBefore = await familyRows(recent.groupId, [recent.areaId]);
        const liveBefore = await familyRows(live.groupId, [live.areaId]);

        expect(await purge()).toEqual({ ...NOTHING, areas: 1, families: 1 });
        expect((await familyRows(gone.groupId, [gone.areaId])).groups).toBe(0);
        expect(await familyRows(recent.groupId, [recent.areaId])).toEqual(recentBefore);
        expect(await familyRows(live.groupId, [live.areaId])).toEqual(liveBefore);
        const [liveArea] = await db
            .select()
            .from(s.workspaces)
            .where(eq(s.workspaces.id, live.areaId));
        expect(liveArea!.deletedAt).toBeNull();
        for (const objectId of [recent.shared.objectId, liveFile.objectId])
            expect(await outbox(objectId)).toBeNull();
        for (const family of [gone, recent]) {
            await expectOwnDriveWhole(family.own, family.member.workspaceId);
            // The organizer's own drive too: an account's workspace is never the family's.
            expect(await rows(s.workspaces, eq(s.workspaces.id, family.creator.workspaceId))).toBe(
                1,
            );
        }
        // Only the purged family's objects were queued at all.
        expect(await rows(s.driveObjectDeletions, undefined)).toBe(1);
    });

    test('billing and refund records are kept, by the family’s id', async () => {
        const family = await dissolvedFamily();
        expect(
            await billing.applyGroupState({
                readingFrom: await billing.readingStamp(),
                groupId: family.groupId,
                provider: 'polar',
                customerId: 'cus_family',
                subscriptions: [
                    {
                        id: 'sub_family',
                        productId: 'prod_family',
                        productName: 'Family Plus (monthly)',
                        status: 'canceled',
                        recurringInterval: 'month',
                        amount: 1000,
                        currency: 'usd',
                        units: 4,
                        paidUnits: 4,
                        pendingUnits: null,
                        pendingProductId: null,
                        paidTier: { productId: 'prod_family', quotaBytes: 100n },
                        includedMembers: 4,
                        quotaBytes: 100n,
                        currentPeriodStart: new Date(Date.now() - 60 * 86_400_000),
                        currentPeriodEnd: new Date(Date.now() - 30 * 86_400_000),
                        cancelAtPeriodEnd: true,
                        endedAt: new Date(Date.now() - 30 * 86_400_000),
                    },
                ],
                graceMs: 3 * 86_400_000,
            }),
        ).toBe('applied');
        // A member's personal plan ended when they were pooled, and its refund: by ids only.
        await db.insert(s.personalPlanEndings).values({
            subscriptionId: 'sub_personal',
            userId: family.member.userId,
            groupId: family.groupId,
            admittedAt: new Date(),
            pooledAt: new Date(),
            outcome: 'settled',
        });
        await db.insert(s.personalPlanRefunds).values({
            orderId: 'order_personal',
            subscriptionId: 'sub_personal',
            refundKey: 'refund_personal',
            amount: 250,
            currency: 'usd',
            status: 'succeeded',
        });
        await dissolvedAgo(family.groupId, DAYS + 1);

        expect((await purge()).families).toBe(1);
        expect((await familyRows(family.groupId, [family.areaId])).groups).toBe(0);
        expect(await billing.getGroupCustomer(family.groupId)).toMatchObject({
            providerCustomerId: 'cus_family',
        });
        expect(
            await rows(
                s.groupBillingSubscriptions,
                eq(s.groupBillingSubscriptions.groupId, family.groupId),
            ),
        ).toBe(1);
        expect(
            await rows(s.personalPlanEndings, eq(s.personalPlanEndings.groupId, family.groupId)),
        ).toBe(1);
        expect(await billing.listPlanRefunds('sub_personal')).toHaveLength(1);
    });

    test('a plan still running keeps the family’s records, not its folders, until it ends', async () => {
        const family = await dissolvedFamily();
        const plan = (endedAt: Date | null, status: string) => ({
            id: 'sub_family',
            productId: 'prod_family',
            productName: 'Family Plus (yearly)',
            status,
            recurringInterval: 'year',
            amount: 9600,
            currency: 'usd',
            units: 4,
            paidUnits: 4,
            pendingUnits: null,
            pendingProductId: null,
            paidTier: { productId: 'prod_family', quotaBytes: 100n },
            includedMembers: 4,
            quotaBytes: 100n,
            currentPeriodStart: new Date(Date.now() - 100 * 86_400_000),
            currentPeriodEnd: new Date(Date.now() + 265 * 86_400_000),
            // Set to cancel, which is what let its last member dissolve it.
            cancelAtPeriodEnd: true,
            endedAt,
        });
        // One subscription as a webhook delivers it (not a full reconcile, which ends what it omits).
        const apply = async (subscription: ReturnType<typeof plan>) =>
            billing.applyGroupState({
                readingFrom: await billing.readingStamp(),
                groupId: family.groupId,
                provider: 'polar',
                customerId: 'cus_family',
                subscriptions: [subscription],
                graceMs: 3 * 86_400_000,
                complete: false,
            });
        expect(await apply(plan(null, 'active'))).toBe('applied');
        await dissolvedAgo(family.groupId, DAYS + 1);

        // The folder goes on time; the group's row, which billing still writes, waits.
        expect(await purge()).toEqual({ ...NOTHING, areas: 1 });
        const kept = await familyRows(family.groupId, [family.areaId]);
        expect([kept.groups, kept.rosters, kept.workspaces, kept.objects]).toEqual([1, 2, 0, 0]);
        expect(await outbox(family.shared.objectId)).not.toBeNull();
        // Any state the plan can still become active from keeps them too.
        for (const status of ['past_due', 'unpaid', 'incomplete', 'trialing']) {
            expect(await apply(plan(null, status))).toBe('applied');
            expect([status, await purge()]).toEqual([status, NOTHING]);
        }

        expect(await apply(plan(new Date(), 'canceled'))).toBe('applied');
        expect(await purge()).toEqual({ ...NOTHING, families: 1 });
        expect((await familyRows(family.groupId, [family.areaId])).groups).toBe(0);
    });

    test('a folder a report holds waits, and the family’s records with it, until the report lets go', async () => {
        const family = await dissolvedFamily();
        await dissolvedAgo(family.groupId, DAYS + 1);
        const reportId = randomUUID();
        await db.insert(s.driveReports).values({
            id: reportId,
            workspaceId: family.areaId,
            nodeId: family.shared.nodeId,
            nodeKind: 'file',
            keyEpoch: 1,
            category: 'other',
            reason: 'Reported before the family was dissolved',
        });
        const before = await familyRows(family.groupId, [family.areaId]);

        // Open: nothing of the family goes.
        expect(await purge()).toEqual(NOTHING);
        expect(await familyRows(family.groupId, [family.areaId])).toEqual(before);
        // Resolved but held: still nothing.
        await db
            .update(s.driveReports)
            .set({ status: 'dismissed', heldAt: new Date() })
            .where(eq(s.driveReports.id, reportId));
        expect(await purge()).toEqual(NOTHING);
        expect(await familyRows(family.groupId, [family.areaId])).toEqual(before);
        expect(await outbox(family.shared.objectId)).toBeNull();

        // Let go: the family goes, and the report itself stays.
        await db
            .update(s.driveReports)
            .set({ heldAt: null })
            .where(eq(s.driveReports.id, reportId));
        expect(await purge()).toEqual({ ...NOTHING, areas: 1, families: 1 });
        expect((await familyRows(family.groupId, [family.areaId])).groups).toBe(0);
        expect(await rows(s.driveReports, eq(s.driveReports.id, reportId))).toBe(1);
    });

    test('running again finds nothing, and a run on a family another run holds skips it', async () => {
        const family = await dissolvedFamily();
        await dissolvedAgo(family.groupId, DAYS + 1);
        expect(await groups.purgeDeletedAreas(DAYS)).toBe(1);

        // Another run is on this family: this one leaves it, then the next run finishes it.
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        let taken!: () => void;
        const holding = new Promise<void>((resolve) => (taken = resolve));
        const other = db.transaction(async (tx) => {
            await tx.execute(
                sql`select pg_advisory_xact_lock(${PURGE_LOCK_SPACE}::int, hashtext(${family.groupId}))`,
            );
            taken();
            await released;
        });
        await holding;
        const before = await familyRows(family.groupId, [family.areaId]);
        try {
            expect(await groups.purgeDissolvedFamilies(DAYS)).toEqual({
                retired: 0,
                families: 0,
                busy: 1,
            });
            expect(await familyRows(family.groupId, [family.areaId])).toEqual(before);
        } finally {
            release();
            await other;
        }

        // Two runs at once: the family goes once, and neither fails.
        const both = await Promise.all([purge(), purge()]);
        expect(both.reduce((sum, run) => sum + run.families, 0)).toBe(1);
        expect(both.reduce((sum, run) => sum + run.areas, 0)).toBe(0);
        const queued = await outbox(family.shared.objectId);
        expect(queued).not.toBeNull();

        // And again: nothing left to do, and the outbox row is not written twice.
        expect(await purge()).toEqual(NOTHING);
        expect(await rows(s.driveObjectDeletions, undefined)).toBe(1);
        expect(await outbox(family.shared.objectId)).toEqual(queued);
    });
});

describe('a dissolved family during its retention', () => {
    test('nothing reopens or rejoins it, and once purged it cannot be made again', async () => {
        const family = await dissolvedFamily();
        const { creator, member } = family;
        // An invitation still open from before: accepting it is refused, and none can be made.
        expect(
            await groups.acceptInvitation({
                tokenHash: family.pendingToken,
                userId: family.invitee.userId,
            }),
        ).toEqual({ status: 'gone' });
        expect((await invite(family.groupId, creator.userId, member.email)).invited).toEqual({
            status: 'not-member',
        });
        // No chain write, no leave, and no space lists it.
        const h = await head(family.groupId);
        expect(
            await groups.appendChain({
                groupId: family.groupId,
                uploaderUserId: creator.userId,
                expectedRevision: h.revision,
                route: { kind: 'succession' },
                succession: {
                    statement: Buffer.from('succession after dissolve'),
                    ...signatures(),
                    oldVersion: h.groupKeyVersion,
                    newVersion: h.groupKeyVersion + 1,
                    lastRosterVersion: h.rosterVersion,
                    lastRosterDigest: h.rosterDigest,
                    newEd25519PublicKey: randomBytes(32),
                    newMlDsaPublicKey: randomBytes(1952),
                    signerUserId: creator.userId,
                    signerMlDsaPublicKey: randomBytes(1952),
                } as unknown as ParsedSuccession,
                cache: {},
            }),
        ).toEqual({ status: 'not-member' });
        expect(await groups.leaveGroup(family.groupId, creator.userId)).toEqual({
            status: 'not-member',
        });
        for (const userId of [creator.userId, member.userId])
            expect((await groups.spacesFor(userId)).map((space) => space.groupId)).not.toContain(
                family.groupId,
            );
        expect(await drive.isMember(creator.userId, family.areaId)).toBe(false);

        // Purged, a resent creation of the same family is refused: its id stays taken.
        await dissolvedAgo(family.groupId, DAYS + 1);
        expect((await purge()).families).toBe(1);
        expect(
            await rows(s.groupAreaCommitments, eq(s.groupAreaCommitments.groupId, family.groupId)),
        ).toBe(1);
        expect(await groups.createGroup(family.input)).toEqual({ status: 'taken' });
        expect((await familyRows(family.groupId, [family.areaId])).groups).toBe(0);
    });

    test('a purged family’s id stays taken by its billing records when its rosters listed no folder key', async () => {
        const family = await dissolvedFamily({ commitments: false });
        expect(
            await billing.applyGroupState({
                readingFrom: await billing.readingStamp(),
                groupId: family.groupId,
                provider: 'polar',
                customerId: 'cus_family',
                subscriptions: [],
                graceMs: 3 * 86_400_000,
            }),
        ).toBe('applied');
        await dissolvedAgo(family.groupId, DAYS + 1);
        expect((await purge()).families).toBe(1);
        expect(
            await rows(s.groupAreaCommitments, eq(s.groupAreaCommitments.groupId, family.groupId)),
        ).toBe(0);
        expect(await groups.createGroup(family.input)).toEqual({ status: 'taken' });
        expect((await familyRows(family.groupId, [family.areaId])).groups).toBe(0);
    });
});

describe('a plan billing writes while the purge waits for the family', () => {
    test('is seen: the family stays', async () => {
        const family = await dissolvedFamily();
        await dissolvedAgo(family.groupId, DAYS + 1);
        expect(await groups.purgeDeletedAreas(DAYS)).toBe(1);

        // A webhook's write as applyGroupState makes it: the group's row held while a live plan lands.
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        let taken!: () => void;
        const holding = new Promise<void>((resolve) => (taken = resolve));
        const webhook = db.transaction(async (tx) => {
            await tx
                .select({ id: s.groups.id })
                .from(s.groups)
                .where(eq(s.groups.id, family.groupId))
                .for('no key update');
            await tx.insert(s.groupBillingSubscriptions).values({
                id: 'sub_resumed',
                groupId: family.groupId,
                provider: 'polar',
                productId: 'prod_family',
                productName: 'Family Plus (monthly)',
                status: 'active',
                recurringInterval: 'month',
                units: 4,
                includedMembers: 4,
                quotaBytes: 100n,
                currentPeriodStart: new Date(),
                currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
            });
            taken();
            await released;
        });
        await holding;
        const purging = groups.purgeDissolvedFamilies(DAYS);
        // The purge chose the family before the plan was committed, and now waits for its row.
        for (let tries = 0; ; tries++) {
            const waiting = await db.execute<{ n: number }>(
                sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
            );
            if (waiting.rows[0]!.n > 0) break;
            if (tries > 200) throw new Error('the purge never waited for the family');
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        release();
        await webhook;
        expect(await purging).toEqual({ retired: 0, families: 0, busy: 0 });
        expect((await familyRows(family.groupId, [family.areaId])).groups).toBe(1);
    });
});
