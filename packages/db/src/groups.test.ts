import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { registered, signedIn } from '../test/accounts';
import {
    closeDatabase,
    createTestAccount,
    createTestIdentity,
    insertLegacyLink,
    insertLegacyShare,
    resetDatabase,
    signerFor,
} from '../test/helpers';
import * as signed from '../test/signed';
import * as auth from './auth';
import { db } from './client';
import * as drive from './drive';
import { isMember } from './drive';
import * as groups from './groups';
import { scopedId } from './ids';
import * as rotations from './rotations';
import { metadataStatement } from './signatures';
import {
    accountIdentities,
    accountKeys,
    areaGrants,
    driveLinks,
    driveNodes,
    driveObjectDeletions,
    driveObjects,
    driveReports,
    driveShares,
    driveUploads,
    fileVersions,
    groupInvitations,
    groupKeySeals,
    groupKeySuccessions,
    groupMemberships,
    groupRosters,
    groups as groupsTable,
    users,
    workspaceDocuments,
    workspaceKeys,
    workspaceStorage,
    workspaces,
    type GroupRole,
} from './schema';

/*
 * The group chain's storage, with opaque statement bytes: what this suite
 * pins is what only the database makes true (one statement per version and
 * per old key whatever races, the compare-and-set, replays, seats under the
 * lock, the route's diff policy, departures, atomic writes, access that ends
 * with membership), never what the crypto core checks. A statement here is
 * any bytes; its digest is computed by the repository. The parsed fields are
 * cast to the brands, as @hushos/groups will after acceptance.
 */

beforeEach(resetDatabase);
afterAll(closeDatabase);

const seed = () => randomBytes(16).toString('base64url');
const signatures = () => ({
    ed25519Signature: randomBytes(64),
    mlDsaSignature: randomBytes(3309),
    signerSignature: randomBytes(3373),
});
const digestOf = (statement: Buffer) => groups.statementDigest(statement);

type Head = groups.Head;
type Account = { userId: string; workspaceId: string; email: string };
type Change = groups.EntryChange;

function roster(
    head: Head,
    signerUserId: string,
    label: string,
    options: { changes?: Change[]; dropsHolder?: boolean; groupKeyVersion?: number } = {},
) {
    return {
        statement: Buffer.from(`roster ${head.rosterVersion + 1} ${label}`),
        ...signatures(),
        version: head.rosterVersion + 1,
        previousDigest: head.rosterDigest,
        groupKeyVersion: options.groupKeyVersion ?? head.groupKeyVersion,
        signerUserId,
        signerMlDsaPublicKey: randomBytes(1952),
        changes: options.changes ?? [],
        dropsHolder: options.dropsHolder ?? false,
    } as groups.ParsedRoster;
}

/* The head a roster makes, before the revision moves. */
const after = (head: Head, next: groups.ParsedRoster): Head => ({
    ...head,
    rosterVersion: next.version,
    rosterDigest: digestOf(next.statement),
});

function succession(head: Head, signerUserId: string, label: string) {
    return {
        statement: Buffer.from(`succession ${head.groupKeyVersion} ${label}`),
        ...signatures(),
        oldVersion: head.groupKeyVersion,
        newVersion: head.groupKeyVersion + 1,
        lastRosterVersion: head.rosterVersion,
        lastRosterDigest: head.rosterDigest,
        newEd25519PublicKey: randomBytes(32),
        newMlDsaPublicKey: randomBytes(1952),
        signerUserId,
        signerMlDsaPublicKey: randomBytes(1952),
    } as groups.ParsedSuccession;
}

function seal(head: Head, holderUserId: string, sealerUserId: string): groups.SealInput {
    return {
        groupKeyVersion: head.groupKeyVersion,
        holderUserId,
        holderKeyVersion: 1,
        sealerUserId,
        rosterVersion: head.rosterVersion,
        rosterDigest: head.rosterDigest,
        envelope: randomBytes(4597),
    };
}

function grant(
    head: Head,
    workspaceId: string,
    granteeUserId: string,
    granterUserId: string,
    options: { workspaceKeyVersion?: number; granteeKeyVersion?: number } = {},
): groups.GrantInput {
    return {
        workspaceId,
        workspaceKeyVersion: options.workspaceKeyVersion ?? 1,
        granteeUserId,
        granteeKeyVersion: options.granteeKeyVersion ?? 1,
        granterUserId,
        rosterVersion: head.rosterVersion,
        rosterDigest: head.rosterDigest,
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

const ORGANIZER: GroupRole[] = ['billing', 'guardian', 'members'];
/* Drive's workspace document limits (@hushos/drive/protocol). */
const DOCUMENT_LIMITS = { kinds: 8, bytes: 2 * 1048616 };

/*
 * Every member needs an identity: a grant or seal may not name a key version
 * above the recipient's. A test identity (createTestIdentity) also lets the
 * account sign Drive writes; accounts registered for real already have one.
 */
async function ensureIdentity(userId: string) {
    const [row] = await db
        .select({ userId: accountIdentities.userId })
        .from(accountIdentities)
        .where(eq(accountIdentities.userId, userId));
    if (!row) await createTestIdentity(userId);
}

/* A family made by `creator`, with its first area granted to them; the head after creation. */
/* What a client sends to create a family: its id, first roster, seal, area and grant. */
function familyInput(creator: { userId: string }, idSeed = seed()) {
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
    } as groups.ParsedRoster;
    const firstHead: Head = {
        rosterVersion: 1,
        rosterDigest: digestOf(first.statement),
        groupKeyVersion: 1,
        revision: 1,
    };
    const input = {
        id: groupId,
        idSeed,
        kind: 'family' as const,
        name: 'Family',
        creatorUserId: creator.userId,
        firstEd25519PublicKey: randomBytes(32),
        firstMlDsaPublicKey: randomBytes(1952),
        roster: first,
        keySeal: seal(firstHead, creator.userId, creator.userId),
        area: {
            workspaceId: areaId,
            idSeed: areaSeed,
            quotaBytes: 1n << 30n,
            selfGrant: selfGrant(),
        },
        grants: [grant(firstHead, areaId, creator.userId, creator.userId)],
        cache: { through: 1 },
    };
    return { groupId, areaId, areaSeed, input };
}

async function family(
    creator: { userId: string },
    options: { seatLimit?: number; idSeed?: string; kind?: 'family' | 'org' } = {},
) {
    await ensureIdentity(creator.userId);
    const { groupId, areaId, areaSeed, input } = familyInput(creator, options.idSeed);
    const created = await groups.createGroup({ ...input, kind: options.kind ?? 'family' });
    if (created.status !== 'created') throw new Error(`createGroup ${JSON.stringify(created)}`);
    if (options.seatLimit)
        await db
            .update(groupsTable)
            .set({ seatLimit: options.seatLimit })
            .where(eq(groupsTable.id, groupId));
    return { groupId, areaId, areaSeed, head: created.head, input };
}
type Family = Awaited<ReturnType<typeof family>>;

/* Invites `account` with `roles` and has them accept: pending admission. */
async function acceptInto(groupId: string, inviter: string, account: Account, roles: GroupRole[]) {
    await ensureIdentity(account.userId);
    const token = randomBytes(32);
    const invited = await groups.createInvitation({
        groupId,
        email: account.email,
        normalizedEmail: account.email,
        tokenHash: token,
        roles,
        invitedBy: inviter,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
    });
    if (invited.status !== 'created') throw new Error(`createInvitation ${invited.status}`);
    const result = await groups.acceptInvitation({ tokenHash: token, userId: account.userId });
    if (result.status !== 'accepted') throw new Error(`acceptInvitation ${result.status}`);
    return account;
}
async function accepted(groupId: string, inviter: string, roles: GroupRole[] = []) {
    return acceptInto(groupId, inviter, await createTestAccount(), roles);
}

/* The roster that admits `userId` with `roles`, signed by `admin`, with a grant of the area. */
function admission(
    group: { groupId: string; areaId: string },
    head: Head,
    admin: string,
    userId: string,
    roles: GroupRole[] = [],
    label = userId,
) {
    const next = roster(head, admin, `admit ${label}`, {
        changes: [{ userId, status: 'active', roles }],
    });
    const nextHead = after(head, next);
    return {
        groupId: group.groupId,
        uploaderUserId: admin,
        expectedRevision: head.revision,
        route: { kind: 'admit' as const, userId, seatLimitDefault: 6 },
        roster: next,
        grants: [grant(nextHead, group.areaId, userId, admin)],
        seals: roles.includes('members') ? [seal(nextHead, userId, admin)] : [],
        cache: { through: next.version },
    };
}

/* A plain roster write (route A) with these changes. */
function rosterWrite(
    group: { groupId: string },
    head: Head,
    uploader: string,
    label: string,
    options: Parameters<typeof roster>[3] = {},
) {
    return {
        groupId: group.groupId,
        uploaderUserId: uploader,
        expectedRevision: head.revision,
        route: { kind: 'roster' as const },
        roster: roster(head, uploader, label, options),
        cache: {},
    };
}

async function okHead(result: groups.ChainResult): Promise<Head> {
    if (result.status !== 'ok') throw new Error(`appendChain ${JSON.stringify(result)}`);
    return result;
}

const rostersAt = async (groupId: string, version: number) =>
    db
        .select()
        .from(groupRosters)
        .where(and(eq(groupRosters.groupId, groupId), eq(groupRosters.version, version)));

async function membership(groupId: string, userId: string) {
    const [row] = await db
        .select()
        .from(groupMemberships)
        .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, userId)));
    return row;
}

async function headNow(groupId: string): Promise<Head & typeof groupsTable.$inferSelect> {
    const [row] = await db.select().from(groupsTable).where(eq(groupsTable.id, groupId));
    return { ...row!, revision: row!.chainRevision };
}

async function areaRow(areaId: string) {
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, areaId));
    return row!;
}

describe('creating a group', () => {
    test('stores the first roster, the creator as an active holder, the seal, the area and its grant', async () => {
        const creator = await createTestAccount();
        const { groupId, areaId, head } = await family(creator);
        expect(head).toMatchObject({ rosterVersion: 1, groupKeyVersion: 1, revision: 1 });
        expect(await membership(groupId, creator.userId)).toMatchObject({
            state: 'active',
            roles: ORGANIZER,
        });
        expect(await areaRow(areaId)).toMatchObject({
            ownerKind: 'group',
            groupId,
            areaKind: 'shared',
        });
        expect(await isMember(creator.userId, areaId)).toBe(true);
    });

    test('the same group sent twice at once: one creates it, the other is told it was a replay', async () => {
        const creator = await createTestAccount();
        await ensureIdentity(creator.userId);
        const { groupId, input } = familyInput(creator);
        const results = await Promise.all([groups.createGroup(input), groups.createGroup(input)]);
        expect(results.map((result) => result.status).sort()).toEqual(['created', 'replayed']);
        expect(await rostersAt(groupId, 1)).toHaveLength(1);
        expect(
            await db.select().from(workspaces).where(eq(workspaces.groupId, groupId)),
        ).toHaveLength(1);
    });

    test('the same group sent again is a replay; another first roster for its id, or an id not derived from its seed, is refused', async () => {
        const creator = await createTestAccount();
        const made = await family(creator);
        expect((await groups.createGroup(made.input)).status).toBe('replayed');
        expect(
            await groups.createGroup({
                ...made.input,
                roster: { ...made.input.roster, statement: Buffer.from('another first roster') },
            }),
        ).toEqual({ status: 'taken' });
        const other = await createTestAccount();
        expect(
            await groups.createGroup({
                ...made.input,
                creatorUserId: other.userId,
                roster: { ...made.input.roster, signerUserId: other.userId },
            }),
        ).toEqual({ status: 'invalid', reason: 'group-id' });
        const [rows] = await db.select({ count: count() }).from(groupRosters);
        expect(rows!.count).toBe(1);
    });

    test('a first roster must name only its creator, active, holding billing and members', async () => {
        const creator = await createTestAccount();
        const stranger = await createTestAccount();
        const idSeed = seed();
        const groupId = scopedId('group', creator.userId, idSeed)!;
        const attempt = (changes: Change[]) => {
            const statement = Buffer.from(`roster 1 ${JSON.stringify(changes)}`);
            const head: Head = {
                rosterVersion: 1,
                rosterDigest: digestOf(statement),
                groupKeyVersion: 1,
                revision: 1,
            };
            return groups.createGroup({
                id: groupId,
                idSeed,
                kind: 'family',
                name: 'Family',
                creatorUserId: creator.userId,
                firstEd25519PublicKey: randomBytes(32),
                firstMlDsaPublicKey: randomBytes(1952),
                roster: {
                    statement,
                    ...signatures(),
                    version: 1,
                    previousDigest: null,
                    groupKeyVersion: 1,
                    signerUserId: creator.userId,
                    signerMlDsaPublicKey: randomBytes(1952),
                    changes,
                    dropsHolder: false,
                } as groups.ParsedRoster,
                keySeal: seal(head, creator.userId, creator.userId),
                cache: {},
            });
        };
        for (const changes of [
            [{ userId: creator.userId, status: 'active', roles: ['members'] }],
            [{ userId: creator.userId, status: 'active', roles: ['billing'] }],
            [
                { userId: creator.userId, status: 'active', roles: ORGANIZER },
                { userId: stranger.userId, status: 'active', roles: [] },
            ],
        ] as Change[][])
            expect(await attempt(changes)).toEqual({ status: 'invalid', reason: 'first-roster' });
        expect(await db.select().from(groupsTable)).toEqual([]);
    });

    test('an area whose id is not derived under the group is refused, and the group with it', async () => {
        const creator = await createTestAccount();
        await ensureIdentity(creator.userId);
        const made = await family(await createTestAccount());
        const idSeed = seed();
        const groupId = scopedId('group', creator.userId, idSeed)!;
        const areaSeed = seed();
        const result = await groups.createGroup({
            ...made.input,
            id: groupId,
            idSeed,
            creatorUserId: creator.userId,
            roster: {
                ...made.input.roster,
                signerUserId: creator.userId,
                changes: [{ userId: creator.userId, status: 'active', roles: ORGANIZER }],
            },
            keySeal: {
                ...made.input.keySeal,
                holderUserId: creator.userId,
                sealerUserId: creator.userId,
            },
            // Derived under the creator, not the group.
            area: {
                workspaceId: scopedId('workspace', creator.userId, areaSeed)!,
                idSeed: areaSeed,
                quotaBytes: 1n,
                selfGrant: selfGrant(),
            },
            grants: [],
        });
        expect(result).toEqual({ status: 'invalid', reason: 'area-id' });
        expect(await db.select().from(groupsTable).where(eq(groupsTable.id, groupId))).toEqual([]);
    });
});

describe('the chain under one lock', () => {
    test('a second roster at a version already taken is stale, carries the first bytes, and is not stored', async () => {
        const creator = await createTestAccount();
        const group = await family(creator);
        const first = rosterWrite(group, group.head, creator.userId, 'first');
        await okHead(await groups.appendChain(first));
        const lost = await groups.appendChain(
            rosterWrite(group, group.head, creator.userId, 'second'),
        );
        expect(lost.status).toBe('stale');
        if (lost.status !== 'stale') return;
        expect(lost.roster!.statement.equals(first.roster.statement)).toBe(true);
        expect(lost.roster!.signerSignature.equals(first.roster.signerSignature)).toBe(true);
        expect(lost.head).toMatchObject({ rosterVersion: 2, revision: 2 });
        const stored = await rostersAt(group.groupId, 2);
        expect(stored).toHaveLength(1);
        expect(stored[0]!.statement.equals(first.roster.statement)).toBe(true);
    });

    test('resending the stored bytes is a replay that writes nothing, even after the chain moved on', async () => {
        const creator = await createTestAccount();
        const group = await family(creator);
        const write = {
            ...rosterWrite(group, group.head, creator.userId, 'two'),
            cache: { through: 2 },
        };
        const two = await okHead(await groups.appendChain(write));
        await okHead(
            await groups.appendChain({
                ...rosterWrite(group, two, creator.userId, 'three'),
                cache: { through: 3 },
            }),
        );
        // Other signatures over the same statement are the same roster: still a replay.
        const replay = await groups.appendChain({
            ...write,
            roster: { ...write.roster, ...signatures() },
        });
        expect(replay).toMatchObject({ status: 'replayed', rosterVersion: 3, revision: 3 });
        expect((await headNow(group.groupId)).chainRevision).toBe(3);
        expect(await rostersAt(group.groupId, 2)).toHaveLength(1);
        expect((await groups.getChainCache(group.groupId))!.cache).toEqual({ through: 3 });
    });

    test('a free roster version checked against a chain a succession has since moved is stale', async () => {
        const creator = await createTestAccount();
        const group = await family(creator);
        const moved = await okHead(
            await groups.appendChain({
                groupId: group.groupId,
                uploaderUserId: creator.userId,
                expectedRevision: group.head.revision,
                route: { kind: 'succession' },
                succession: succession(group.head, creator.userId, 'a'),
                cache: {},
            }),
        );
        expect(moved).toMatchObject({ rosterVersion: 1, groupKeyVersion: 2, revision: 2 });
        const behind = await groups.appendChain(
            rosterWrite(group, group.head, creator.userId, 'under key 1'),
        );
        expect(behind).toMatchObject({
            status: 'stale',
            head: { revision: 2, groupKeyVersion: 2 },
        });
        expect(await rostersAt(group.groupId, 2)).toEqual([]);
        await okHead(
            await groups.appendChain(rosterWrite(group, moved, creator.userId, 'under key 2')),
        );
    });

    test('one succession per old key: a second is stale against the old chain and refused against the new one', async () => {
        const creator = await createTestAccount();
        const group = await family(creator);
        const write = (s: groups.ParsedSuccession, expectedRevision: number) =>
            groups.appendChain({
                groupId: group.groupId,
                uploaderUserId: creator.userId,
                expectedRevision,
                route: { kind: 'succession' },
                succession: s,
                cache: {},
            });
        const first = succession(group.head, creator.userId, 'first');
        await okHead(await write(first, 1));
        const second = succession(group.head, creator.userId, 'second');
        const stale = await write(second, 1);
        expect(stale.status).toBe('stale');
        if (stale.status === 'stale')
            expect(stale.succession!.statement.equals(first.statement)).toBe(true);
        expect(await write(second, 2)).toEqual({ status: 'invalid', reason: 'succession-head' });
        expect((await write(first, 1)).status).toBe('replayed');
        const [rows] = await db
            .select({ count: count() })
            .from(groupKeySuccessions)
            .where(eq(groupKeySuccessions.groupId, group.groupId));
        expect(rows!.count).toBe(1);
    });

    test('a succession must tie to the head roster', async () => {
        const creator = await createTestAccount();
        const group = await family(creator);
        const two = await okHead(
            await groups.appendChain(rosterWrite(group, group.head, creator.userId, 'two')),
        );
        expect(
            await groups.appendChain({
                groupId: group.groupId,
                uploaderUserId: creator.userId,
                expectedRevision: two.revision,
                route: { kind: 'succession' },
                succession: succession(group.head, creator.userId, 'early'),
                cache: {},
            }),
        ).toEqual({ status: 'invalid', reason: 'succession-head' });
    });

    test('a seal or grant naming a roster that is not stored is refused, and the roster with it', async () => {
        const creator = await createTestAccount();
        const group = await family(creator);
        const missing = { ...group.head, rosterVersion: 7 };
        const otherDigest = { ...group.head, rosterDigest: randomBytes(32) };
        for (const bad of [
            { seals: [seal(missing, creator.userId, creator.userId)] },
            { seals: [seal(otherDigest, creator.userId, creator.userId)] },
            { grants: [grant(missing, group.areaId, creator.userId, creator.userId)] },
            { grants: [grant(otherDigest, group.areaId, creator.userId, creator.userId)] },
        ])
            expect(
                await groups.appendChain({
                    ...rosterWrite(group, group.head, creator.userId, 'two'),
                    ...bad,
                }),
            ).toEqual({ status: 'invalid', reason: 'reference' });
        expect(await rostersAt(group.groupId, 2)).toEqual([]);
        expect((await headNow(group.groupId)).chainRevision).toBe(1);
    });

    test('a seal goes only to an active members holder, at a key the group has', async () => {
        const creator = await createTestAccount();
        const group = await family(creator);
        const member = await accepted(group.groupId, creator.userId);
        const head = await okHead(
            await groups.appendChain(admission(group, group.head, creator.userId, member.userId)),
        );
        const write = rosterWrite(group, head, creator.userId, 'reseal');
        const next = after(head, write.roster);
        expect(
            await groups.appendChain({
                ...write,
                seals: [seal(next, member.userId, creator.userId)],
            }),
        ).toEqual({ status: 'members-changed', reason: 'seal-holder' });
        expect(
            await groups.appendChain({
                ...write,
                seals: [seal({ ...next, groupKeyVersion: 2 }, creator.userId, creator.userId)],
            }),
        ).toEqual({ status: 'invalid', reason: 'seal-key-version' });
        expect(await rostersAt(group.groupId, 3)).toEqual([]);
    });

    test("a grant can name neither another group's area nor a personal workspace, even written directly", async () => {
        const creator = await createTestAccount();
        const ours = await family(creator);
        const theirs = await family(await createTestAccount());
        for (const workspaceId of [theirs.areaId, creator.workspaceId])
            expect(
                await groups.appendChain({
                    ...rosterWrite(ours, ours.head, creator.userId, 'two'),
                    grants: [grant(ours.head, workspaceId, creator.userId, creator.userId)],
                }),
            ).toEqual({ status: 'invalid', reason: 'area' });
        await expect(
            db.insert(areaGrants).values({
                ...grant(ours.head, theirs.areaId, creator.userId, creator.userId),
                groupId: ours.groupId,
            }),
        ).rejects.toThrow();
        expect(
            await groups.appendChain({
                ...rosterWrite(ours, ours.head, creator.userId, 'two'),
                grants: [
                    grant(ours.head, ours.areaId, creator.userId, creator.userId, {
                        workspaceKeyVersion: 2,
                    }),
                ],
            }),
        ).toEqual({ status: 'invalid', reason: 'area-key-version' });
    });

    test('an area id already in use is invalid, not stale, so a client never re-signs into a loop', async () => {
        const creator = await createTestAccount();
        const group = await family(creator);
        const result = await groups.appendChain({
            ...rosterWrite(group, group.head, creator.userId, 'area again'),
            route: {
                kind: 'area',
                area: {
                    workspaceId: group.areaId,
                    idSeed: group.areaSeed,
                    quotaBytes: 1n,
                    selfGrant: selfGrant(),
                },
            },
        });
        expect(result).toEqual({ status: 'invalid', reason: 'area-taken' });
        expect(await rostersAt(group.groupId, 2)).toEqual([]);
        // A second area with its own id lands.
        const areaSeed = seed();
        await okHead(
            await groups.appendChain({
                ...rosterWrite(group, group.head, creator.userId, 'new area'),
                route: {
                    kind: 'area',
                    area: {
                        workspaceId: scopedId('workspace', group.groupId, areaSeed)!,
                        idSeed: areaSeed,
                        quotaBytes: 1n,
                        selfGrant: selfGrant(),
                    },
                },
            }),
        );
    });

    test('only an active members holder who signed it can upload a roster', async () => {
        const creator = await createTestAccount();
        const group = await family(creator);
        const member = await accepted(group.groupId, creator.userId);
        const stranger = await createTestAccount();
        const head = await okHead(
            await groups.appendChain(admission(group, group.head, creator.userId, member.userId)),
        );
        expect(
            await groups.appendChain(rosterWrite(group, head, stranger.userId, 'stranger')),
        ).toEqual({
            status: 'not-member',
        });
        expect(await groups.appendChain(rosterWrite(group, head, member.userId, 'member'))).toEqual(
            {
                status: 'forbidden',
            },
        );
        expect(
            await groups.appendChain({
                ...rosterWrite(group, head, creator.userId, 'x'),
                roster: roster(head, member.userId, 'signed by another'),
            }),
        ).toEqual({ status: 'forbidden' });
        expect(await rostersAt(group.groupId, 3)).toEqual([]);
    });
});

describe('the route policy', () => {
    async function setup() {
        const creator = await createTestAccount();
        const group = await family(creator);
        const member = await accepted(group.groupId, creator.userId);
        const pending = await accepted(group.groupId, creator.userId);
        const head = await okHead(
            await groups.appendChain(admission(group, group.head, creator.userId, member.userId)),
        );
        return { creator, group, member, pending, head };
    }

    test("a roster's changes must match the server's memberships", async () => {
        const { creator, group, member, pending, head } = await setup();
        const attempt = (changes: Change[], route: groups.ChainRoute = { kind: 'roster' }) =>
            groups.appendChain({
                ...rosterWrite(group, head, creator.userId, JSON.stringify([changes, route]), {
                    changes,
                }),
                route,
            });
        expect(await attempt([{ userId: member.userId, status: 'left', roles: [] }])).toEqual({
            status: 'invalid',
            reason: 'entry-left',
        });
        // Not a member: someone may have left or been declined since the roster was built.
        expect(await attempt([{ userId: pending.userId, status: 'active', roles: [] }])).toEqual({
            status: 'members-changed',
            reason: 'entry-not-member',
        });
        expect(
            await attempt([{ userId: pending.userId, status: 'left', roles: [] }], {
                kind: 'remove',
                userId: member.userId,
            }),
        ).toEqual({ status: 'invalid', reason: 'remove-entry' });
        expect((await membership(group.groupId, member.userId))!.state).toBe('active');
        expect((await membership(group.groupId, pending.userId))!.state).toBe('accepted');
    });

    test('roles change only on the member route, and only for its target', async () => {
        const { creator, group, member, head } = await setup();
        const attempt = (changes: Change[], route: groups.ChainRoute, label = '') =>
            groups.appendChain({
                ...rosterWrite(
                    group,
                    head,
                    creator.userId,
                    JSON.stringify([changes, route]) + label,
                    {
                        changes,
                    },
                ),
                route,
            });
        const guardian: Change = { userId: member.userId, status: 'active', roles: ['guardian'] };
        // A plain roster, an area or a removal that also changes someone's roles.
        expect(await attempt([guardian], { kind: 'roster' })).toEqual({
            status: 'invalid',
            reason: 'role-change',
        });
        // The member route, changing someone other than its target.
        expect(
            await attempt(
                [
                    { userId: creator.userId, status: 'active', roles: ['billing', 'members'] },
                    { userId: member.userId, status: 'active', roles: [] },
                ],
                { kind: 'member', userId: member.userId },
            ),
        ).toEqual({ status: 'invalid', reason: 'role-change' });
        // Taking `members` from the only holder, or `billing` from the only payer.
        expect(
            await attempt([{ userId: creator.userId, status: 'active', roles: ['billing'] }], {
                kind: 'member',
                userId: creator.userId,
            }),
        ).toEqual({ status: 'invalid', reason: 'no-holder' });
        expect(
            await attempt([{ userId: creator.userId, status: 'active', roles: ['members'] }], {
                kind: 'member',
                userId: creator.userId,
            }),
        ).toEqual({ status: 'invalid', reason: 'no-billing' });
        expect((await membership(group.groupId, creator.userId))!.roles).toEqual(ORGANIZER);
        // The target's own role change lands.
        await okHead(await attempt([guardian], { kind: 'member', userId: member.userId }));
        expect((await membership(group.groupId, member.userId))!.roles).toEqual(['guardian']);
    });

    test('taking members from a holder must say so, and carry its succession', async () => {
        const creator = await createTestAccount();
        const group = await family(creator);
        const holder = await accepted(group.groupId, creator.userId, ['members']);
        const head = await okHead(
            await groups.appendChain(
                admission(group, group.head, creator.userId, holder.userId, ['members']),
            ),
        );
        const changes: Change[] = [{ userId: holder.userId, status: 'active', roles: [] }];
        const route: groups.ChainRoute = { kind: 'member', userId: holder.userId };
        const demote = (dropsHolder: boolean) =>
            roster(head, creator.userId, 'demote', { changes, dropsHolder });
        const base = {
            groupId: group.groupId,
            uploaderUserId: creator.userId,
            expectedRevision: head.revision,
            route,
            cache: {},
        };
        // Acceptance and the server's own roles must agree on whether a holder goes.
        expect(await groups.appendChain({ ...base, roster: demote(false) })).toEqual({
            status: 'invalid',
            reason: 'drops-holder',
        });
        expect(await groups.appendChain({ ...base, roster: demote(true) })).toEqual({
            status: 'invalid',
            reason: 'succession-required',
        });
        const next = demote(true);
        await okHead(
            await groups.appendChain({
                ...base,
                roster: next,
                succession: succession(after(head, next), creator.userId, 'demote'),
            }),
        );
        expect(await headNow(group.groupId)).toMatchObject({
            groupKeyVersion: 2,
            successionDue: false,
        });
    });
});

describe('admission', () => {
    test('is atomic: a bad grant leaves the membership, the roster and the seats as they were', async () => {
        const creator = await createTestAccount();
        const group = await family(creator, { seatLimit: 2 });
        const newcomer = await accepted(group.groupId, creator.userId);
        const write = admission(group, group.head, creator.userId, newcomer.userId);
        const bad = { ...write, grants: [{ ...write.grants[0]!, workspaceKeyVersion: 2 }] };
        expect(await groups.appendChain(bad)).toEqual({
            status: 'invalid',
            reason: 'area-key-version',
        });
        expect((await membership(group.groupId, newcomer.userId))!.state).toBe('accepted');
        expect(await rostersAt(group.groupId, 2)).toEqual([]);
        await okHead(await groups.appendChain(write));
        expect(await membership(group.groupId, newcomer.userId)).toMatchObject({
            state: 'active',
            admittedBy: creator.userId,
        });
        expect((await groups.appendChain(write)).status).toBe('replayed');
    });

    test('two admissions racing for the last seat: exactly one lands, the other is told the seats are full', async () => {
        const creator = await createTestAccount();
        const group = await family(creator, { seatLimit: 2 });
        const a = await accepted(group.groupId, creator.userId);
        const b = await accepted(group.groupId, creator.userId);
        const results = await Promise.all([
            groups.appendChain(admission(group, group.head, creator.userId, a.userId)),
            groups.appendChain(admission(group, group.head, creator.userId, b.userId)),
        ]);
        expect(results.map((result) => result.status).sort()).toEqual(['ok', 'seats']);
        expect(results.find((result) => result.status === 'seats')).toMatchObject({
            used: 2,
            limit: 2,
        });
        const [active] = await db
            .select({ count: count() })
            .from(groupMemberships)
            .where(
                and(
                    eq(groupMemberships.groupId, group.groupId),
                    eq(groupMemberships.state, 'active'),
                ),
            );
        expect(active!.count).toBe(2);
        expect(await rostersAt(group.groupId, 2)).toHaveLength(1);
    });

    test('only an accepted person is admitted, with no more roles than their invitation names', async () => {
        const creator = await createTestAccount();
        const group = await family(creator);
        const outsider = await createTestAccount();
        expect(
            await groups.appendChain(admission(group, group.head, creator.userId, outsider.userId)),
        ).toEqual({ status: 'not-pending' });
        const invited = await accepted(group.groupId, creator.userId, ['guardian']);
        expect(
            await groups.appendChain(
                admission(group, group.head, creator.userId, invited.userId, [
                    'guardian',
                    'members',
                ]),
            ),
        ).toEqual({ status: 'invalid', reason: 'admit-roles' });
        expect((await membership(group.groupId, invited.userId))!.state).toBe('accepted');
        await okHead(
            await groups.appendChain(
                admission(group, group.head, creator.userId, invited.userId, ['guardian']),
            ),
        );
        expect((await membership(group.groupId, invited.userId))!.roles).toEqual(['guardian']);
    });

    test('a holder can decline someone who accepted, who then reads nothing', async () => {
        const creator = await createTestAccount();
        const group = await family(creator);
        const pending = await accepted(group.groupId, creator.userId);
        expect(await groups.getGroupFor(group.groupId, pending.userId)).not.toBeNull();
        expect(
            await groups.declinePending({
                groupId: group.groupId,
                holderUserId: pending.userId,
                userId: pending.userId,
            }),
        ).toEqual({ status: 'not-member' });
        expect(
            await groups.declinePending({
                groupId: group.groupId,
                holderUserId: creator.userId,
                userId: pending.userId,
            }),
        ).toEqual({ status: 'declined' });
        expect(await groups.getGroupFor(group.groupId, pending.userId)).toBeNull();
        expect(
            await groups.declinePending({
                groupId: group.groupId,
                holderUserId: creator.userId,
                userId: pending.userId,
            }),
        ).toEqual({ status: 'not-pending' });
        expect(
            await groups.appendChain(admission(group, group.head, creator.userId, pending.userId)),
        ).toEqual({ status: 'not-pending' });
    });
});

describe('departures', () => {
    /* A family of three: the creator, a second `members` holder, and a member with no roles. */
    async function threeMembers() {
        const creator = await createTestAccount();
        const group = await family(creator);
        const leaver = await accepted(group.groupId, creator.userId, ['members']);
        const stayer = await accepted(group.groupId, creator.userId);
        let head = await okHead(
            await groups.appendChain(
                admission(group, group.head, creator.userId, leaver.userId, ['members']),
            ),
        );
        head = await okHead(
            await groups.appendChain(admission(group, head, creator.userId, stayer.userId)),
        );
        for (const account of [leaver, stayer])
            await db
                .insert(workspaceKeys)
                .values({ ...selfGrant(), workspaceId: group.areaId, userId: account.userId });
        await db
            .insert(workspaceKeys)
            .values({ ...selfGrant(), workspaceId: leaver.workspaceId, userId: leaver.userId });
        return { creator, group, leaver, stayer, head };
    }

    /* A root in the family's area, written by the creator. */
    async function areaRoot(group: Family, creatorId: string) {
        const range = await drive.allocateKeyEpochs(group.areaId, 1);
        const created = await signed.createRoot({
            workspaceId: group.areaId,
            userId: creatorId,
            id: randomUUID(),
            envelopes: {
                keyEpoch: range!.from,
                parentKeyEpoch: 1,
                keyEnvelope: randomBytes(72),
                metadataEnvelope: randomBytes(100),
            },
        });
        if (created.status !== 'created') throw new Error(created.status);
        return created.root;
    }
    async function shareOf(
        group: Family,
        root: { id: string; keyEpoch: number },
        granter: string,
        grantee: string,
    ) {
        // Left by a server before family folders refused sharing: the repository makes none now.
        const share = await insertLegacyShare({
            workspaceId: group.areaId,
            nodeId: root.id,
            granterUserId: granter,
            granteeUserId: grantee,
            role: 'editor',
            keyEpoch: root.keyEpoch,
            shareEnvelope: randomBytes(4565),
        });
        return share.id;
    }
    async function linkOf(group: Family, root: { id: string; keyEpoch: number }, granter: string) {
        const link = await insertLegacyLink({
            id: randomUUID(),
            workspaceId: group.areaId,
            nodeId: root.id,
            granterUserId: granter,
            tokenHash: randomBytes(32),
            keyEpoch: root.keyEpoch,
            linkEnvelope: randomBytes(72),
            linkSalt: randomBytes(16),
            secretEnvelope: randomBytes(104),
            hasPassword: false,
            expiresAt: null,
        });
        return link.id;
    }
    const liveShare = async (id: string) =>
        (
            await db
                .select()
                .from(driveShares)
                .where(and(eq(driveShares.id, id), isNull(driveShares.revokedAt)))
        ).length === 1;
    const liveLink = async (id: string) =>
        (
            await db
                .select()
                .from(driveLinks)
                .where(and(eq(driveLinks.id, id), isNull(driveLinks.revokedAt)))
        ).length === 1;

    test("leaving takes away the person's grants, seals and self-grants at once, and nothing of anyone else's", async () => {
        const { group, leaver, stayer } = await threeMembers();
        expect(await isMember(leaver.userId, group.areaId)).toBe(true);
        expect(await groups.leaveGroup(group.groupId, leaver.userId)).toEqual({ status: 'left' });
        expect(await isMember(leaver.userId, group.areaId)).toBe(false);
        const grantsTo = (userId: string) =>
            db.select().from(areaGrants).where(eq(areaGrants.granteeUserId, userId));
        expect(await grantsTo(leaver.userId)).toEqual([]);
        expect(
            await db
                .select()
                .from(groupKeySeals)
                .where(eq(groupKeySeals.holderUserId, leaver.userId)),
        ).toEqual([]);
        expect(
            await db
                .select()
                .from(workspaceKeys)
                .where(
                    and(
                        eq(workspaceKeys.userId, leaver.userId),
                        eq(workspaceKeys.workspaceId, group.areaId),
                    ),
                ),
        ).toEqual([]);
        expect(await isMember(leaver.userId, leaver.workspaceId)).toBe(true);
        expect(await isMember(stayer.userId, group.areaId)).toBe(true);
        expect(await grantsTo(stayer.userId)).toHaveLength(1);
        expect((await areaRow(group.areaId)).rotationDueAt).not.toBeNull();
        expect((await membership(group.groupId, leaver.userId))!.state).toBe('left');
    });

    test('a departure ends access through Drive too: shares and links they made, shares made to them', async () => {
        const { creator, group, leaver, stayer } = await threeMembers();
        const outsider = await createTestAccount();
        // One live share per grantee per node: the other member's share goes to someone else.
        const otherOutsider = await createTestAccount();
        for (const person of [outsider, otherOutsider]) await ensureIdentity(person.userId);
        const root = await areaRoot(group, creator.userId);
        const theirShare = await shareOf(group, root, leaver.userId, outsider.userId);
        const theirLink = await linkOf(group, root, leaver.userId);
        const toThem = await shareOf(group, root, creator.userId, leaver.userId);
        const othersShare = await shareOf(group, root, stayer.userId, otherOutsider.userId);
        expect(await groups.leaveGroup(group.groupId, leaver.userId)).toEqual({ status: 'left' });
        expect(await liveShare(theirShare)).toBe(false);
        expect(await drive.authorize(outsider.userId, group.areaId, root.id)).toBeNull();
        expect(await liveLink(theirLink)).toBe(false);
        expect(await liveShare(toThem)).toBe(false);
        expect(await drive.authorize(leaver.userId, group.areaId, root.id)).toBeNull();
        // What another member shared with someone outside the group stays theirs to stop.
        expect(await liveShare(othersShare)).toBe(true);
        expect(await drive.authorize(otherOutsider.userId, group.areaId, root.id)).toMatchObject({
            role: 'editor',
        });
    });

    test('a key the server still holds for someone no longer active opens nothing in Drive', async () => {
        const { creator, group, stayer } = await threeMembers();
        const root = await areaRoot(group, creator.userId);
        expect(await drive.authorize(stayer.userId, group.areaId, root.id)).toMatchObject({
            role: 'owner',
        });
        await db
            .update(groupMemberships)
            .set({ state: 'left', leftAt: new Date() })
            .where(
                and(
                    eq(groupMemberships.groupId, group.groupId),
                    eq(groupMemberships.userId, stayer.userId),
                ),
            );
        expect(
            await db.select().from(workspaceKeys).where(eq(workspaceKeys.userId, stayer.userId)),
        ).not.toEqual([]);
        expect(await drive.authorize(stayer.userId, group.areaId, root.id)).toBeNull();
        expect(await isMember(stayer.userId, group.areaId)).toBe(false);
    });

    test('while a walk runs in a family folder, nothing is made or moved under a folder it has not re-keyed', async () => {
        const { creator, group } = await threeMembers();
        const root = await areaRoot(group, creator.userId);
        const at = async () => (await drive.allocateKeyEpochs(group.areaId, 1))!.from;
        const folderUnder = async (parentId: string, parentKeyEpoch: number) =>
            signed.createFolders({
                workspaceId: group.areaId,
                userId: creator.userId,
                folders: [
                    {
                        id: randomUUID(),
                        parentId,
                        envelopes: {
                            keyEpoch: await at(),
                            parentKeyEpoch,
                            keyEnvelope: randomBytes(72),
                            metadataEnvelope: randomBytes(100),
                        },
                    },
                ],
            });
        const made = await folderUnder(root.id, root.keyEpoch);
        if (made.status !== 'created') throw new Error(made.status);
        const trips = made.nodes[0]!;
        const loose = await folderUnder(root.id, root.keyEpoch);
        if (loose.status !== 'created') throw new Error(loose.status);
        const started = await rotations.startRotation({
            workspaceId: group.areaId,
            nodeId: root.id,
            startedBy: creator.userId,
        });
        if (started.status !== 'ok') throw new Error(started.status);
        const target = started.rotation.targetEpoch;
        // Trips is below the target: a new folder there, or one moved in, would sit under a key the
        // walk only re-wraps. Refused, as the walk's own subtree.
        expect(await folderUnder(trips.id, trips.keyEpoch)).toMatchObject({
            status: 'rotating',
            id: trips.id,
        });
        expect(
            await drive.moveNode({
                workspaceId: group.areaId,
                writer: creator.userId,
                nodeId: loose.nodes[0]!.id,
                parentId: trips.id,
                parentKeyEpoch: trips.keyEpoch,
                keyEnvelope: randomBytes(72),
            }),
        ).toMatchObject({ status: 'rotating' });
        // The walk re-keys the root, then Trips: from then on it takes new folders again.
        const nodeRow = async (id: string) =>
            (await db.select().from(driveNodes).where(eq(driveNodes.id, id)))[0]!;
        for (const [id, parentKeyEpoch] of [
            [root.id, 1],
            [trips.id, target],
        ] as const)
            expect(
                await signed.rotateNodes({
                    workspaceId: group.areaId,
                    rootId: root.id,
                    targetEpoch: target,
                    userId: creator.userId,
                    // The root's re-key stands in for its roster's (applyRotation).
                    byRoster: id === root.id,
                    nodes: [
                        {
                            id,
                            changeSeq: (await nodeRow(id)).changeSeq!,
                            parentKeyEpoch,
                            keyEnvelope: randomBytes(72),
                            rotated: {
                                metadataEnvelope: randomBytes(100),
                                versions: [],
                                shares: [],
                                links: [],
                                unsealableLinks: [],
                            },
                        },
                    ],
                }),
            ).toEqual([{ id, status: 'ok' }]);
        expect(await folderUnder(trips.id, target)).toMatchObject({ status: 'created' });
    });

    test('while a walk runs, no new version goes under a file it has not re-keyed', async () => {
        const { creator, group } = await threeMembers();
        const root = await areaRoot(group, creator.userId);
        const at = async () => (await drive.allocateKeyEpochs(group.areaId, 1))!.from;
        const upload = async (
            node:
                | { existing: false; id: string; parentId: string; envelopes: never }
                | {
                      existing: true;
                      id: string;
                      keyEpoch: number;
                      expectedVersionId: string | null;
                  },
        ) => {
            const objectId = randomUUID();
            return signed.beginUpload({
                workspaceId: group.areaId,
                userId: creator.userId,
                node,
                version: { id: randomUUID(), contentKeyEnvelope: randomBytes(72) },
                object: {
                    id: objectId,
                    objectKey: `ws/${group.areaId}/${objectId}`,
                    contentSuite: 2,
                    chunkSize: 8 * 1024 * 1024,
                    chunkCount: 1,
                    contentNonce: randomBytes(16),
                    ciphertextSize: 1024n,
                },
                multipartId: `mp-${objectId}`,
                expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
            });
        };
        const fileId = randomUUID();
        const first = await upload({
            existing: false,
            id: fileId,
            parentId: root.id,
            envelopes: {
                keyEpoch: await at(),
                parentKeyEpoch: root.keyEpoch,
                keyEnvelope: randomBytes(72),
                metadataEnvelope: randomBytes(100),
            } as never,
        });
        if (first.status !== 'ok') throw new Error(first.status);
        expect((await drive.startCompleting(group.areaId, first.uploadId)).status).toBe('ok');
        const published = await drive.finishCompleting(group.areaId, first.uploadId, 1024n);
        if (published.status !== 'published') throw new Error(published.status);
        const file = published.node;
        // A second version under way before the walk starts, which then conflicts.
        const second = await upload({
            existing: true,
            id: file.id,
            keyEpoch: file.keyEpoch,
            expectedVersionId: file.currentVersionId,
        });
        if (second.status !== 'ok') throw new Error(second.status);
        const started = await rotations.startRotation({
            workspaceId: group.areaId,
            nodeId: root.id,
            startedBy: creator.userId,
        });
        if (started.status !== 'ok') throw new Error(started.status);
        const target = started.rotation.targetEpoch;
        // A new version would be sealed under the file's key, which the walk has not replaced.
        expect(
            await upload({
                existing: true,
                id: file.id,
                keyEpoch: file.keyEpoch,
                expectedVersionId: file.currentVersionId,
            }),
        ).toMatchObject({ status: 'rotating' });
        // Nor attached to the same node after a conflict.
        await db
            .update(driveUploads)
            .set({ status: 'conflicted' })
            .where(eq(driveUploads.id, second.uploadId));
        expect(
            await signed.attachUpload(group.areaId, second.uploadId, {
                mode: 'same-node',
                userId: creator.userId,
                keyEpoch: file.keyEpoch,
                contentKeyEnvelope: randomBytes(72),
            }),
        ).toMatchObject({ status: 'rotating' });
        // The walk re-keys the top folder and the file: then a new version goes again.
        const nodeRow = async (id: string) =>
            (await db.select().from(driveNodes).where(eq(driveNodes.id, id)))[0]!;
        for (const [id, parentKeyEpoch] of [
            [root.id, 1],
            [file.id, target],
        ] as const)
            expect(
                await signed.rotateNodes({
                    workspaceId: group.areaId,
                    rootId: root.id,
                    targetEpoch: target,
                    userId: creator.userId,
                    // The root's re-key stands in for its roster's (applyRotation).
                    byRoster: id === root.id,
                    nodes: [
                        {
                            id,
                            changeSeq: (await nodeRow(id)).changeSeq!,
                            parentKeyEpoch,
                            keyEnvelope: randomBytes(72),
                            rotated: {
                                metadataEnvelope: randomBytes(100),
                                // Every ready version goes with the file's new key (#37): the one published.
                                versions:
                                    id === file.id
                                        ? [
                                              {
                                                  id: file.currentVersionId!,
                                                  contentKeyEnvelope: randomBytes(72),
                                              },
                                          ]
                                        : [],
                                shares: [],
                                links: [],
                                unsealableLinks: [],
                            },
                        },
                    ],
                }),
            ).toEqual([{ id, status: 'ok' }]);
        const after = await nodeRow(file.id);
        expect(
            await upload({
                existing: true,
                id: file.id,
                keyEpoch: target,
                expectedVersionId: after.currentVersionId,
            }),
        ).toMatchObject({ status: 'ok' });
    });

    test('while a walk runs, nothing is restored to a top folder it has not re-keyed', async () => {
        const { creator, group } = await threeMembers();
        const root = await areaRoot(group, creator.userId);
        const at = async () => (await drive.allocateKeyEpochs(group.areaId, 1))!.from;
        const folderUnder = async (parentId: string, parentKeyEpoch: number) => {
            const made = await signed.createFolders({
                workspaceId: group.areaId,
                userId: creator.userId,
                folders: [
                    {
                        id: randomUUID(),
                        parentId,
                        envelopes: {
                            keyEpoch: await at(),
                            parentKeyEpoch,
                            keyEnvelope: randomBytes(72),
                            metadataEnvelope: randomBytes(100),
                        },
                    },
                ],
            });
            if (made.status !== 'created') throw new Error(made.status);
            return made.nodes[0]!;
        };
        // A folder in a folder, both in Trash: restoring the inner one goes to the top folder.
        const outer = await folderUnder(root.id, root.keyEpoch);
        const inner = await folderUnder(outer.id, outer.keyEpoch);
        for (const nodeId of [inner.id, outer.id])
            expect(
                (
                    await drive.trashNode({
                        workspaceId: group.areaId,
                        writer: creator.userId,
                        nodeId,
                    })
                ).status,
            ).toBe('ok');
        const started = await rotations.startRotation({
            workspaceId: group.areaId,
            nodeId: root.id,
            startedBy: creator.userId,
        });
        if (started.status !== 'ok') throw new Error(started.status);
        const target = started.rotation.targetEpoch;
        const restore = (parentKeyEpoch: number) =>
            drive.restoreNode({
                workspaceId: group.areaId,
                writer: creator.userId,
                nodeId: inner.id,
                toRoot: { parentKeyEpoch, keyEnvelope: randomBytes(72) },
            });
        // The top folder is below the target: wrapped under it, the folder's key stays exposed.
        expect(await restore(root.keyEpoch)).toMatchObject({ status: 'rotating' });
        // The walk re-keys the top folder: the same restore, under its new key, goes.
        const rootRow = (await db.select().from(driveNodes).where(eq(driveNodes.id, root.id)))[0]!;
        expect(
            await signed.rotateNodes({
                workspaceId: group.areaId,
                rootId: root.id,
                targetEpoch: target,
                userId: creator.userId,
                // The root's re-key stands in for its roster's (applyRotation).
                byRoster: true,
                nodes: [
                    {
                        id: root.id,
                        changeSeq: rootRow.changeSeq!,
                        parentKeyEpoch: 1,
                        keyEnvelope: randomBytes(72),
                        rotated: {
                            metadataEnvelope: randomBytes(100),
                            versions: [],
                            shares: [],
                            links: [],
                            unsealableLinks: [],
                        },
                    },
                ],
            }),
        ).toEqual([{ id: root.id, status: 'ok' }]);
        expect(await restore(target)).toMatchObject({ status: 'ok' });
    });

    test('a personal workspace keeps adding under a folder its own rotation has not reached', async () => {
        const owner = await createTestAccount();
        await ensureIdentity(owner.userId);
        const root = await signed.createRoot({
            workspaceId: owner.workspaceId,
            userId: owner.userId,
            id: randomUUID(),
            envelopes: {
                keyEpoch: (await drive.allocateKeyEpochs(owner.workspaceId, 1))!.from,
                parentKeyEpoch: 1,
                keyEnvelope: randomBytes(72),
                metadataEnvelope: randomBytes(100),
            },
        });
        if (root.status !== 'created') throw new Error(root.status);
        const started = await rotations.startRotation({
            workspaceId: owner.workspaceId,
            nodeId: root.root.id,
            startedBy: owner.userId,
        });
        if (started.status !== 'ok') throw new Error(started.status);
        expect(
            await signed.createFolders({
                workspaceId: owner.workspaceId,
                userId: owner.userId,
                folders: [
                    {
                        id: randomUUID(),
                        parentId: root.root.id,
                        envelopes: {
                            keyEpoch: (await drive.allocateKeyEpochs(owner.workspaceId, 1))!.from,
                            parentKeyEpoch: root.root.keyEpoch,
                            keyEnvelope: randomBytes(72),
                            metadataEnvelope: randomBytes(100),
                        },
                    },
                ],
            }),
        ).toMatchObject({ status: 'created' });
    });

    test("a rotation does not hand the new key on through a departed member's share or link", async () => {
        const { creator, group, stayer } = await threeMembers();
        const outsider = await createTestAccount();
        await ensureIdentity(outsider.userId);
        const root = await areaRoot(group, creator.userId);
        const departedShare = await shareOf(group, root, stayer.userId, outsider.userId);
        const departedLink = await linkOf(group, root, stayer.userId);
        const keptShare = await shareOf(group, root, creator.userId, stayer.userId);
        // Their membership ends without revokeAccess, as a missed revocation would leave it.
        await db
            .update(groupMemberships)
            .set({ state: 'left', leftAt: new Date() })
            .where(
                and(
                    eq(groupMemberships.groupId, group.groupId),
                    eq(groupMemberships.userId, stayer.userId),
                ),
            );
        const started = await rotations.startRotation({
            workspaceId: group.areaId,
            nodeId: root.id,
            startedBy: creator.userId,
        });
        if (started.status !== 'ok') throw new Error(started.status);
        const work = await rotations.listRotationWork({
            workspaceId: group.areaId,
            rootId: root.id,
            targetEpoch: started.rotation.targetEpoch,
        });
        const node = work.nodes.find((entry) => entry.id === root.id)!;
        // The creator's share is re-sealed; the departed member's share and link are left out,
        // so the rotation revokes them as unsealed.
        expect(node.shares.map((share) => share.id)).toEqual([keptShare]);
        expect(node.shares.map((share) => share.id)).not.toContain(departedShare);
        expect(node.links.map((link) => link.id)).not.toContain(departedLink);
        expect(node.links).toEqual([]);
        const target = started.rotation.targetEpoch;
        // An area root re-keyed under another parent epoch than the area's key version is stale.
        expect(
            await signed.rotateNodes({
                workspaceId: group.areaId,
                rootId: root.id,
                targetEpoch: target,
                userId: creator.userId,
                // The root's re-key stands in for its roster's (applyRotation).
                byRoster: true,
                nodes: [
                    {
                        id: root.id,
                        changeSeq: node.changeSeq!,
                        parentKeyEpoch: node.parentKeyEpoch + 1,
                        keyEnvelope: randomBytes(72),
                        rotated: {
                            metadataEnvelope: randomBytes(100),
                            versions: [],
                            shares: [],
                            links: [],
                            unsealableLinks: [],
                        },
                    },
                ],
            }),
        ).toEqual([{ id: root.id, status: 'stale' }]);
        // A rotating client that sends them anyway re-seals nothing for them: they are revoked.
        expect(
            await signed.rotateNodes({
                workspaceId: group.areaId,
                rootId: root.id,
                targetEpoch: target,
                userId: creator.userId,
                // The root's re-key stands in for its roster's (applyRotation).
                byRoster: true,
                nodes: [
                    {
                        id: root.id,
                        changeSeq: node.changeSeq!,
                        parentKeyEpoch: node.parentKeyEpoch,
                        keyEnvelope: randomBytes(72),
                        rotated: {
                            metadataEnvelope: randomBytes(100),
                            versions: [],
                            shares: [keptShare, departedShare].map((id) => ({
                                id,
                                shareEnvelope: randomBytes(drive.SHARE_ENVELOPE_BYTES),
                            })),
                            links: [
                                {
                                    id: departedLink,
                                    linkEnvelope: randomBytes(72),
                                    secretEnvelope: randomBytes(104),
                                },
                            ],
                            unsealableLinks: [],
                        },
                    },
                ],
            }),
        ).toEqual([{ id: root.id, status: 'ok' }]);
        const share = async (id: string) =>
            (await db.select().from(driveShares).where(eq(driveShares.id, id)))[0]!;
        expect(await share(keptShare)).toMatchObject({ keyEpoch: target, revokedAt: null });
        expect((await share(departedShare)).revokedAt).not.toBeNull();
        expect((await share(departedShare)).keyEpoch).toBeLessThan(target);
        const [link] = await db.select().from(driveLinks).where(eq(driveLinks.id, departedLink));
        expect(link!.revokedAt).not.toBeNull();
        expect(link!.keyEpoch).toBeLessThan(target);
    });

    test('a departure blocks every roster until one marks them left; a holder marked left carries the succession', async () => {
        const { creator, group, leaver, stayer, head } = await threeMembers();
        expect(await groups.leaveGroup(group.groupId, leaver.userId)).toEqual({ status: 'left' });
        expect(await groups.listDepartures(group.groupId)).toMatchObject([
            { userId: leaver.userId, heldMembers: true },
        ]);
        expect(
            await groups.appendChain(rosterWrite(group, head, creator.userId, 'unrelated')),
        ).toEqual({
            status: 'left-due',
            userIds: [leaver.userId],
        });
        const markLeft: Change[] = [{ userId: leaver.userId, status: 'left', roles: ['members'] }];
        expect(
            await groups.appendChain(
                rosterWrite(group, head, creator.userId, 'mark left', {
                    changes: markLeft,
                    dropsHolder: false,
                }),
            ),
        ).toEqual({ status: 'invalid', reason: 'drops-holder' });
        // On the plain roster route too: a succession left due could be wedged by the next departure.
        const marking = rosterWrite(group, head, creator.userId, 'mark left', {
            changes: markLeft,
            dropsHolder: true,
        });
        expect(await groups.appendChain(marking)).toEqual({
            status: 'invalid',
            reason: 'succession-required',
        });
        expect(await groups.listDepartures(group.groupId)).toHaveLength(1);
        const next = after(head, marking.roster);
        const rekeyed = await okHead(
            await groups.appendChain({
                ...marking,
                succession: succession(next, creator.userId, 'after leave'),
                seals: [seal({ ...next, groupKeyVersion: 2 }, creator.userId, creator.userId)],
            }),
        );
        expect(await groups.listDepartures(group.groupId)).toEqual([]);
        expect(await headNow(group.groupId)).toMatchObject({
            groupKeyVersion: 2,
            successionDue: false,
        });
        // A member without `members` leaving drops no holder.
        expect(await groups.leaveGroup(group.groupId, stayer.userId)).toEqual({ status: 'left' });
        await okHead(
            await groups.appendChain(
                rosterWrite(group, rekeyed, creator.userId, 'mark stayer', {
                    changes: [{ userId: stayer.userId, status: 'left', roles: [] }],
                }),
            ),
        );
    });

    test('a removal revokes access, marks the areas due, and a holder removed carries the succession', async () => {
        const { creator, group, leaver, head } = await threeMembers();
        const changes: Change[] = [{ userId: leaver.userId, status: 'left', roles: ['members'] }];
        const route = { kind: 'remove' as const, userId: leaver.userId };
        const removal = roster(head, creator.userId, 'remove', { changes, dropsHolder: true });
        const withRemoval = succession(after(head, removal), creator.userId, 'with removal');
        const base = {
            groupId: group.groupId,
            uploaderUserId: creator.userId,
            expectedRevision: head.revision,
            route,
            cache: {},
        };
        expect(await groups.appendChain({ ...base, roster: removal })).toEqual({
            status: 'invalid',
            reason: 'succession-required',
        });
        const removed = await okHead(
            await groups.appendChain({ ...base, roster: removal, succession: withRemoval }),
        );
        expect(removed).toMatchObject({ groupKeyVersion: 2 });
        expect((await membership(group.groupId, leaver.userId))!.state).toBe('removed');
        expect(await isMember(leaver.userId, group.areaId)).toBe(false);
        expect(
            await db.select().from(areaGrants).where(eq(areaGrants.granteeUserId, leaver.userId)),
        ).toEqual([]);
        expect((await areaRow(group.areaId)).rotationDueAt).not.toBeNull();
        expect(await groups.listRotationsDue(group.groupId)).toEqual([group.areaId]);
        // The same roster with another succession is not a replay: the client must not think its own landed.
        const retry = await groups.appendChain({
            ...base,
            roster: removal,
            succession: succession(after(head, removal), creator.userId, 'a different one'),
        });
        expect(retry.status).toBe('stale');
        if (retry.status === 'stale')
            expect(retry.succession!.statement.equals(withRemoval.statement)).toBe(true);
        // The very same call again is a replay.
        expect(
            (await groups.appendChain({ ...base, roster: removal, succession: withRemoval }))
                .status,
        ).toBe('replayed');
    });

    test('someone who left and accepted a new invitation is marked left, then admitted', async () => {
        const { creator, group, stayer, head } = await threeMembers();
        expect(await groups.leaveGroup(group.groupId, stayer.userId)).toEqual({ status: 'left' });
        await acceptInto(group.groupId, creator.userId, stayer, []);
        expect((await membership(group.groupId, stayer.userId))!.state).toBe('accepted');
        // Admitting them first is not how it goes: the departure is marked before anything else.
        expect(
            await groups.appendChain(admission(group, head, creator.userId, stayer.userId)),
        ).toEqual({ status: 'left-due', userIds: [stayer.userId] });
        const marked = await okHead(
            await groups.appendChain(
                rosterWrite(group, head, creator.userId, 'mark stayer left', {
                    changes: [{ userId: stayer.userId, status: 'left', roles: [] }],
                }),
            ),
        );
        // Still accepted: marking the old departure left does not touch the new acceptance.
        expect((await membership(group.groupId, stayer.userId))!.state).toBe('accepted');
        await okHead(
            await groups.appendChain(admission(group, marked, creator.userId, stayer.userId)),
        );
        expect((await membership(group.groupId, stayer.userId))!.state).toBe('active');
    });

    test('a removal racing the person leaving lands as a plain mark-left; one of someone not active is a membership change', async () => {
        const { creator, group, leaver, head } = await threeMembers();
        // The holder built the removal; the leaver left before it arrived.
        const removal = roster(head, creator.userId, 'remove leaver', {
            changes: [{ userId: leaver.userId, status: 'left', roles: ['members'] }],
            dropsHolder: true,
        });
        expect(await groups.leaveGroup(group.groupId, leaver.userId)).toEqual({ status: 'left' });
        const after1 = await okHead(
            await groups.appendChain({
                groupId: group.groupId,
                uploaderUserId: creator.userId,
                expectedRevision: head.revision,
                route: { kind: 'remove', userId: leaver.userId },
                roster: removal,
                succession: succession(after(head, removal), creator.userId, 'remove leaver'),
                cache: {},
            }),
        );
        expect((await membership(group.groupId, leaver.userId))!.state).toBe('left');
        expect(await groups.listDepartures(group.groupId)).toEqual([]);
        // Someone declined (not active, no departure): the remover's view is out of date.
        const pending = await accepted(group.groupId, creator.userId);
        await groups.declinePending({
            groupId: group.groupId,
            holderUserId: creator.userId,
            userId: pending.userId,
        });
        expect(
            await groups.appendChain({
                ...rosterWrite(group, after1, creator.userId, 'remove declined', {
                    changes: [{ userId: pending.userId, status: 'left', roles: [] }],
                }),
                route: { kind: 'remove', userId: pending.userId },
            }),
        ).toEqual({ status: 'members-changed', reason: 'remove-target' });
    });

    test('a holder who only had a self-grant to an area they made leaves it due for rotation', async () => {
        const { group, leaver, head } = await threeMembers();
        const areaSeed = seed();
        const theirArea = scopedId('workspace', group.groupId, areaSeed)!;
        await okHead(
            await groups.appendChain({
                ...rosterWrite(group, head, leaver.userId, 'their area'),
                route: {
                    kind: 'area',
                    area: {
                        workspaceId: theirArea,
                        idSeed: areaSeed,
                        quotaBytes: 1n,
                        selfGrant: selfGrant(),
                    },
                },
            }),
        );
        expect(
            await db.select().from(areaGrants).where(eq(areaGrants.workspaceId, theirArea)),
        ).toEqual([]);
        expect(await groups.leaveGroup(group.groupId, leaver.userId)).toEqual({ status: 'left' });
        expect((await areaRow(theirArea)).rotationDueAt).not.toBeNull();
    });

    test("deleting an account that one group blocks leaves the account's other groups exactly as they were", async () => {
        const owner = await createTestAccount();
        const first = await family(owner);
        const person = await registered();
        const personAccount = {
            userId: person.user.id,
            workspaceId: person.workspaceId,
            email: person.user.email,
        };
        await acceptInto(first.groupId, owner.userId, personAccount, []);
        await okHead(
            await groups.appendChain(admission(first, first.head, owner.userId, person.user.id)),
        );
        // Their own group, created so its id sorts after the first: departed second, after the first.
        // A company group: an account is in one family at most, and in any number of companies.
        let idSeed = seed();
        while (scopedId('group', person.user.id, idSeed)! < first.groupId) idSeed = seed();
        const own = await family({ userId: person.user.id }, { idSeed, kind: 'org' });
        const helper = await accepted(own.groupId, person.user.id);
        await okHead(
            await groups.appendChain(admission(own, own.head, person.user.id, helper.userId)),
        );
        expect(await groups.deletionBlockers(person.user.id)).toEqual([
            { groupId: own.groupId, reason: 'organizer' },
        ]);
        // The first group's organizer is blocked there too; a member without roles is blocked nowhere.
        expect(await groups.deletionBlockers(owner.userId)).toEqual([
            { groupId: first.groupId, reason: 'organizer' },
        ]);
        expect(await groups.deletionBlockers(helper.userId)).toEqual([]);
        expect(
            await auth.deleteAccount({
                userId: person.user.id,
                credentialVersion: 1,
                sessionTokenHash: await signedIn(person.user.id),
            }),
        ).toBe('group-holder');
        // The first group's departure rolled back with the refusal.
        expect((await membership(first.groupId, person.user.id))!.state).toBe('active');
        expect(await groups.listDepartures(first.groupId)).toEqual([]);
        expect(
            await db.select().from(areaGrants).where(eq(areaGrants.granteeUserId, person.user.id)),
        ).toHaveLength(2);
        expect((await areaRow(first.areaId)).rotationDueAt).toBeNull();
    });

    test('the billing holder and the last members holder cannot leave while others remain; the last member dissolves the group', async () => {
        const { creator, group, leaver, stayer } = await threeMembers();
        expect(await groups.leaveGroup(group.groupId, creator.userId)).toEqual({
            status: 'organizer',
        });
        await db
            .update(groupMemberships)
            .set({ roles: ['members'] })
            .where(
                and(
                    eq(groupMemberships.groupId, group.groupId),
                    eq(groupMemberships.userId, creator.userId),
                ),
            );
        expect(await groups.leaveGroup(group.groupId, leaver.userId)).toEqual({ status: 'left' });
        expect(await groups.leaveGroup(group.groupId, creator.userId)).toEqual({
            status: 'last-holder',
        });
        expect(await groups.leaveGroup(group.groupId, stayer.userId)).toEqual({ status: 'left' });
        expect(await groups.leaveGroup(group.groupId, creator.userId)).toEqual({
            status: 'dissolved',
        });
        expect((await headNow(group.groupId)).dissolvedAt).not.toBeNull();
        expect(await groups.getGroupFor(group.groupId, creator.userId)).toBeNull();
        expect(await groups.leaveGroup(group.groupId, creator.userId)).toEqual({
            status: 'not-member',
        });
    });

    test('deleting an account departs its groups first: refused for the only payer, and recorded for holders to mark left', async () => {
        const organizer = await registered();
        const organizerSession = await signedIn(organizer.user.id);
        const group = await family({ userId: organizer.user.id });
        const holder = await registered();
        await acceptInto(
            group.groupId,
            organizer.user.id,
            { userId: holder.user.id, workspaceId: holder.workspaceId, email: holder.user.email },
            ['members'],
        );
        const head = await okHead(
            await groups.appendChain(
                admission(group, group.head, organizer.user.id, holder.user.id, ['members']),
            ),
        );
        const rostersBefore = await db
            .select()
            .from(groupRosters)
            .where(eq(groupRosters.groupId, group.groupId));
        // The only `billing` holder, with others active: nothing changes.
        expect(
            await auth.deleteAccount({
                userId: organizer.user.id,
                credentialVersion: 1,
                sessionTokenHash: organizerSession,
            }),
        ).toBe('group-holder');
        expect(await db.select().from(users).where(eq(users.id, organizer.user.id))).toHaveLength(
            1,
        );
        expect((await membership(group.groupId, organizer.user.id))!.state).toBe('active');
        // A holder's deletion: gone, with a departure that blocks rosters until one marks them left.
        expect(
            await auth.deleteAccount({
                userId: holder.user.id,
                credentialVersion: 1,
                sessionTokenHash: await signedIn(holder.user.id),
            }),
        ).toBe(true);
        expect(await membership(group.groupId, holder.user.id)).toBeUndefined();
        expect(await groups.listDepartures(group.groupId)).toMatchObject([
            { userId: holder.user.id, heldMembers: true },
        ]);
        expect(
            await db.select().from(groupRosters).where(eq(groupRosters.groupId, group.groupId)),
        ).toEqual(rostersBefore);
        expect((await areaRow(group.areaId)).rotationDueAt).not.toBeNull();
        expect(
            await groups.appendChain(rosterWrite(group, head, organizer.user.id, 'unrelated')),
        ).toEqual({
            status: 'left-due',
            userIds: [holder.user.id],
        });
        const marking = rosterWrite(group, head, organizer.user.id, 'mark deleted left', {
            changes: [{ userId: holder.user.id, status: 'left', roles: ['members'] }],
            dropsHolder: true,
        });
        await okHead(
            await groups.appendChain({
                ...marking,
                succession: succession(
                    after(head, marking.roster),
                    organizer.user.id,
                    'mark deleted',
                ),
            }),
        );
        // Alone now, the organizer's own deletion dissolves the group.
        expect(
            await auth.deleteAccount({
                userId: organizer.user.id,
                credentialVersion: 1,
                sessionTokenHash: organizerSession,
            }),
        ).toBe(true);
        expect((await headNow(group.groupId)).dissolvedAt).not.toBeNull();
    });
    test('the last members holder with a seal of the current key cannot leave, whoever else holds the role', async () => {
        const { creator, group, leaver, head } = await threeMembers();
        await db
            .update(groupMemberships)
            .set({ roles: ['members'] })
            .where(
                and(
                    eq(groupMemberships.groupId, group.groupId),
                    eq(groupMemberships.userId, creator.userId),
                ),
            );
        // The creator holds `members` but nothing seals the current key to them: they could never sign.
        await db
            .delete(groupKeySeals)
            .where(
                and(
                    eq(groupKeySeals.groupId, group.groupId),
                    eq(groupKeySeals.holderUserId, creator.userId),
                ),
            );
        expect(await groups.leaveGroup(group.groupId, leaver.userId)).toEqual({
            status: 'last-holder',
        });
        expect(await groups.deletionBlockers(leaver.userId)).toEqual([
            { groupId: group.groupId, reason: 'last-holder' },
        ]);
        expect((await membership(group.groupId, leaver.userId))!.state).toBe('active');
        // Once the leaver seals the key to them, they may go.
        expect(
            await groups.storeGrants({
                groupId: group.groupId,
                uploaderUserId: leaver.userId,
                seals: [seal(head, creator.userId, leaver.userId)],
            }),
        ).toEqual({ status: 'ok', stored: 1 });
        expect(await groups.leaveGroup(group.groupId, leaver.userId)).toEqual({ status: 'left' });
    });

    test('a Drive write that lands after its writer left the group is refused under the lock', async () => {
        const { creator, group, stayer } = await threeMembers();
        await ensureIdentity(stayer.userId);
        const root = await areaRoot(group, creator.userId);
        const folderBy = async (userId: string) =>
            signed.createFolders({
                workspaceId: group.areaId,
                userId,
                folders: [
                    {
                        id: randomUUID(),
                        parentId: root.id,
                        envelopes: {
                            keyEpoch: (await drive.allocateKeyEpochs(group.areaId, 1))!.from,
                            parentKeyEpoch: root.keyEpoch,
                            keyEnvelope: randomBytes(72),
                            metadataEnvelope: randomBytes(100),
                        },
                    },
                ],
            });
        // The Drive domain checked access before this; the departure commits in between.
        expect(await groups.leaveGroup(group.groupId, stayer.userId)).toEqual({ status: 'left' });
        await expect(folderBy(stayer.userId)).rejects.toBeInstanceOf(drive.AccessEndedError);
        await expect(
            drive.putWorkspaceDocument({
                limits: DOCUMENT_LIMITS,
                workspaceId: group.areaId,
                kind: 'tags',
                version: 0,
                envelope: randomBytes(64),
                writer: stayer.userId,
            }),
        ).rejects.toBeInstanceOf(drive.AccessEndedError);
        expect(await drive.getWorkspaceDocument(group.areaId, 'tags')).toBeNull();
        // Someone still in the group writes as before.
        expect(await folderBy(creator.userId)).toMatchObject({ status: 'created' });
        expect(
            await drive.putWorkspaceDocument({
                limits: DOCUMENT_LIMITS,
                workspaceId: group.areaId,
                kind: 'tags',
                version: 0,
                envelope: randomBytes(64),
                writer: creator.userId,
            }),
        ).toMatchObject({ status: 'ok' });
    });

    test('a family folder takes no share or link, nor a new seal or expiry on one left from before, and stopping one still works', async () => {
        const { creator, group } = await threeMembers();
        const outsider = await createTestAccount();
        await ensureIdentity(outsider.userId);
        const root = await areaRoot(group, creator.userId);
        const changeSeqOf = async () =>
            (await db.select().from(driveNodes).where(eq(driveNodes.id, root.id)))[0]!.changeSeq;
        const before = await changeSeqOf();
        const share = {
            workspaceId: group.areaId,
            nodeId: root.id,
            granterUserId: creator.userId,
            granteeUserId: outsider.userId,
            role: 'viewer' as const,
            keyEpoch: root.keyEpoch,
            shareEnvelope: randomBytes(drive.SHARE_ENVELOPE_BYTES),
        };
        const link = {
            workspaceId: group.areaId,
            nodeId: root.id,
            granterUserId: creator.userId,
            keyEpoch: root.keyEpoch,
            linkEnvelope: randomBytes(72),
            linkSalt: randomBytes(16),
            secretEnvelope: randomBytes(104),
            hasPassword: false,
            expiresAt: null,
        };
        // The organizer, who may do anything else here, makes neither.
        expect(await drive.createShare(share)).toEqual({ status: 'family-sharing' });
        expect(
            await drive.createLink({ ...link, id: randomUUID(), tokenHash: randomBytes(32) }),
        ).toEqual({ status: 'family-sharing' });
        expect(await db.select().from(driveShares).where(eq(driveShares.nodeId, root.id))).toEqual(
            [],
        );
        expect(await db.select().from(driveLinks).where(eq(driveLinks.nodeId, root.id))).toEqual(
            [],
        );
        // A refusal moves nothing a rotation that read the root would then find stale.
        expect(await changeSeqOf()).toBe(before);
        // One each left by a server before this: neither sealed again nor given a new expiry.
        const legacyShare = await insertLegacyShare(share);
        const legacyLink = await insertLegacyLink({
            ...link,
            id: randomUUID(),
            tokenHash: randomBytes(32),
        });
        expect(
            await drive.resealShare({
                workspaceId: group.areaId,
                shareId: legacyShare.id,
                granterUserId: creator.userId,
                keyEpoch: root.keyEpoch,
                shareEnvelope: randomBytes(drive.SHARE_ENVELOPE_BYTES),
            }),
        ).toEqual({ status: 'family-sharing' });
        for (const change of [
            {
                seal: {
                    linkEnvelope: randomBytes(72),
                    linkSalt: randomBytes(16),
                    hasPassword: true,
                    secretEnvelope: randomBytes(104),
                },
            },
            { expiresAt: new Date(Date.now() + 24 * 3600 * 1000) },
        ])
            expect(
                await drive.updateLink({
                    workspaceId: group.areaId,
                    linkId: legacyLink.id,
                    keyEpoch: root.keyEpoch,
                    ...change,
                }),
            ).toEqual({ status: 'family-sharing' });
        const [shareRow] = await db
            .select()
            .from(driveShares)
            .where(eq(driveShares.id, legacyShare.id));
        expect(shareRow!.shareEnvelope).toEqual(legacyShare.shareEnvelope);
        const [linkRow] = await db
            .select()
            .from(driveLinks)
            .where(eq(driveLinks.id, legacyLink.id));
        expect(linkRow).toMatchObject({
            linkEnvelope: legacyLink.linkEnvelope,
            hasPassword: false,
            expiresAt: null,
        });
        expect(await changeSeqOf()).toBe(before);
        // Stopping them is how such a folder is cleared, and marks it due for rotation.
        expect((await areaRow(group.areaId)).rotationDueAt).toBeNull();
        expect(await drive.revokeShare(group.areaId, legacyShare.id)).not.toBeNull();
        expect(await drive.revokeLink(group.areaId, legacyLink.id)).not.toBeNull();
        expect(await liveShare(legacyShare.id)).toBe(false);
        expect(await liveLink(legacyLink.id)).toBe(false);
        expect((await areaRow(group.areaId)).rotationDueAt).not.toBeNull();
    });

    test('a roster rotation waits for a Drive rotation that re-keyed nodes, and those nodes still open from server rows after both', async () => {
        const { creator, group, stayer, head } = await threeMembers();
        const area = group.areaId;
        const root = await areaRoot(group, creator.userId);
        const childEpoch = (await drive.allocateKeyEpochs(area, 1))!.from;
        const made = await signed.createFolders({
            workspaceId: area,
            userId: creator.userId,
            folders: [
                {
                    id: randomUUID(),
                    parentId: root.id,
                    envelopes: {
                        keyEpoch: childEpoch,
                        parentKeyEpoch: root.keyEpoch,
                        keyEnvelope: randomBytes(72),
                        metadataEnvelope: randomBytes(100),
                    },
                },
            ],
        });
        if (made.status !== 'created') throw new Error(made.status);
        const child = made.nodes[0]!;
        const nodeRow = async (id: string) =>
            (await db.select().from(driveNodes).where(eq(driveNodes.id, id)))[0]!;
        const reseal = () => ({
            metadataEnvelope: randomBytes(100),
            versions: [],
            shares: [],
            links: [],
            unsealableLinks: [],
        });
        // Run 1 (a holder's, after revoking a share) re-keys the root and one child, then stalls.
        const run = await rotations.startRotation({
            workspaceId: area,
            nodeId: root.id,
            startedBy: creator.userId,
        });
        if (run.status !== 'ok') throw new Error(run.status);
        const t1 = run.rotation.targetEpoch;
        const rootUnderT1 = randomBytes(72);
        const childUnderT1 = randomBytes(72);
        for (const [id, parentKeyEpoch, keyEnvelope] of [
            [root.id, 1, rootUnderT1],
            [child.id, t1, childUnderT1],
        ] as const)
            expect(
                await signed.rotateNodes({
                    workspaceId: area,
                    rootId: root.id,
                    targetEpoch: t1,
                    userId: creator.userId,
                    // The root's re-key stands in for its roster's (applyRotation).
                    byRoster: id === root.id,
                    nodes: [
                        {
                            id,
                            changeSeq: (await nodeRow(id)).changeSeq!,
                            parentKeyEpoch,
                            keyEnvelope,
                            rotated: reseal(),
                        },
                    ],
                }),
            ).toEqual([{ id, status: 'ok' }]);
        // A removal's roster rotates the area: it must not close run 1 over its re-keyed nodes.
        const removal = roster(head, creator.userId, 'remove stayer', {
            changes: [{ userId: stayer.userId, status: 'left', roles: [] }],
        });
        const target = (await drive.allocateKeyEpochs(area, 1))!.from;
        const rootUnderV2 = randomBytes(72);
        // The root's key at t1, wrapped again under area key version 2 (option A).
        const rootT1UnderV2 = randomBytes(72);
        const rotationOf = async (): Promise<groups.RotationInput> => {
            const current = await nodeRow(root.id);
            const metadataEnvelope = randomBytes(100);
            return {
                workspaceId: area,
                fromVersion: 1,
                toVersion: 2,
                targetEpoch: target,
                root: {
                    id: root.id,
                    changeSeq: current.changeSeq!,
                    parentKeyEpoch: 2,
                    keyEnvelope: rootUnderV2,
                    rotated: {
                        ...reseal(),
                        metadataEnvelope,
                        // In a family folder a rotation keeps the writer's record (re-keyed).
                        metadataSignature: null,
                        metadataRekey: await signed.metadataRekey(
                            creator.userId,
                            area,
                            root.id,
                            target,
                            metadataEnvelope,
                        ),
                    },
                },
                previousRootKeyEnvelope: rootT1UnderV2,
                selfGrant: { ...selfGrant(), workspaceKeyVersion: 2 },
                documents: [],
            };
        };
        const call = {
            groupId: group.groupId,
            uploaderUserId: creator.userId,
            expectedRevision: head.revision,
            route: { kind: 'remove' as const, userId: stayer.userId },
            roster: removal,
            cache: {},
        };
        expect(await groups.appendChain({ ...call, rotations: [await rotationOf()] })).toEqual({
            status: 'rotating',
            workspaceId: area,
            rotationId: run.rotation.id,
            nodeId: root.id,
            targetEpoch: t1,
        });
        expect((await areaRow(area)).workspaceKeyVersion).toBe(1);
        expect((await membership(group.groupId, stayer.userId))!.state).toBe('active');
        // The remover finishes run 1, then resends: the roster lands.
        expect(
            await rotations.finishRotation({ workspaceId: area, rootId: root.id, targetEpoch: t1 }),
        ).toBe(true);
        await okHead(await groups.appendChain({ ...call, rotations: [await rotationOf()] }));
        // From server rows alone: the child sits under the root's key at t1, and that key is
        // still stored, as the root's previous envelope, until the new run finishes: wrapped
        // under area key version 2, so someone given only version 2 opens the child.
        const rootAfter = await nodeRow(root.id);
        const childAfter = await nodeRow(child.id);
        expect(rootAfter).toMatchObject({
            keyEpoch: target,
            parentKeyEpoch: 2,
            prevKeyEpoch: t1,
            prevParentKeyEpoch: 2,
        });
        expect(rootAfter.keyEnvelope!.equals(rootUnderV2)).toBe(true);
        expect(rootAfter.prevKeyEnvelope!.equals(rootT1UnderV2)).toBe(true);
        expect(childAfter).toMatchObject({ keyEpoch: t1, parentKeyEpoch: t1 });
        expect(childAfter.keyEnvelope!.equals(childUnderT1)).toBe(true);
    });

    /*
     * The creator's rotation of the area from version 1, re-keying the root as it is now, with
     * `documents` re-sealed (any bytes: the server never opens them).
     */
    async function rotationNow(
        group: Family,
        rootId: string,
        creatorId: string,
        documents: groups.RotationDocumentInput[],
    ): Promise<groups.RotationInput> {
        const [current] = await db.select().from(driveNodes).where(eq(driveNodes.id, rootId));
        const metadataEnvelope = randomBytes(100);
        const targetEpoch = (await drive.allocateKeyEpochs(group.areaId, 1))!.from;
        return {
            workspaceId: group.areaId,
            fromVersion: 1,
            toVersion: 2,
            targetEpoch,
            root: {
                id: rootId,
                changeSeq: current!.changeSeq!,
                parentKeyEpoch: 2,
                keyEnvelope: randomBytes(72),
                rotated: {
                    metadataEnvelope,
                    metadataSignature: null,
                    metadataRekey: await signed.metadataRekey(
                        creatorId,
                        group.areaId,
                        rootId,
                        targetEpoch,
                        metadataEnvelope,
                    ),
                    versions: [],
                    shares: [],
                    links: [],
                    unsealableLinks: [],
                },
            },
            previousRootKeyEnvelope: randomBytes(72),
            selfGrant: { ...selfGrant(), workspaceKeyVersion: 2 },
            documents,
        };
    }
    const documentRows = (workspaceId: string) =>
        db
            .select()
            .from(workspaceDocuments)
            .where(eq(workspaceDocuments.workspaceId, workspaceId))
            .orderBy(workspaceDocuments.kind);
    async function writeDocument(workspaceId: string, kind: string, version: number) {
        const written = await drive.putWorkspaceDocument({
            limits: DOCUMENT_LIMITS,
            workspaceId,
            kind,
            version,
            envelope: randomBytes(64),
        });
        if (written.status !== 'ok') throw new Error(written.status);
        return written.document;
    }
    /* A rotation roster on route 24's policy. */
    const rotationCall = (group: Family, head: Head, uploader: string) => ({
        groupId: group.groupId,
        uploaderUserId: uploader,
        expectedRevision: head.revision,
        route: { kind: 'rotation' as const },
        roster: roster(head, uploader, 'rotate'),
        cache: {},
    });

    test("a rotation stores the area's documents at the next version in the roster's transaction, as a document write would", async () => {
        const { creator, group, head } = await threeMembers();
        const root = await areaRoot(group, creator.userId);
        await writeDocument(group.areaId, 'tags', 0);
        const tagsRead = await writeDocument(group.areaId, 'tags', 1);
        const pinsRead = await writeDocument(group.areaId, 'pins', 0);
        const resealed = { tags: randomBytes(64), pins: randomBytes(64) };
        await okHead(
            await groups.appendChain({
                ...rotationCall(group, head, creator.userId),
                rotations: [
                    await rotationNow(group, root.id, creator.userId, [
                        { kind: 'tags', version: 2, envelope: resealed.tags },
                        { kind: 'pins', version: 1, envelope: resealed.pins },
                    ]),
                ],
            }),
        );
        const [pins, tags] = await documentRows(group.areaId);
        expect(tags).toMatchObject({ version: 3, envelopeSuite: 1 });
        expect(pins).toMatchObject({ version: 2, envelopeSuite: 1 });
        expect(tags!.envelope.equals(resealed.tags)).toBe(true);
        expect(pins!.envelope.equals(resealed.pins)).toBe(true);
        // Moved as a write moves it: what a reader compares to know it changed.
        expect(tags!.updatedAt.getTime()).toBeGreaterThan(tagsRead.updatedAt.getTime());
        expect(pins!.updatedAt.getTime()).toBeGreaterThan(pinsRead.updatedAt.getTime());
        expect((await areaRow(group.areaId)).workspaceKeyVersion).toBe(2);
        // The next ordinary write names the version the rotation made.
        expect(
            (
                await drive.putWorkspaceDocument({
                    limits: DOCUMENT_LIMITS,
                    workspaceId: group.areaId,
                    kind: 'tags',
                    version: 2,
                    envelope: randomBytes(64),
                })
            ).status,
        ).toBe('stale');
        expect((await writeDocument(group.areaId, 'tags', 3)).version).toBe(4);
    });

    test('an area with no documents rotates with an empty list', async () => {
        const { creator, group, head } = await threeMembers();
        const root = await areaRoot(group, creator.userId);
        await okHead(
            await groups.appendChain({
                ...rotationCall(group, head, creator.userId),
                rotations: [await rotationNow(group, root.id, creator.userId, [])],
            }),
        );
        expect(await documentRows(group.areaId)).toEqual([]);
        expect((await areaRow(group.areaId)).workspaceKeyVersion).toBe(2);
    });

    test('a rotation whose self-grant is wrapped under a root the account has since replaced is invalid, and changes nothing', async () => {
        const { creator, group, head } = await threeMembers();
        const root = await areaRoot(group, creator.userId);
        // The creator rotated their account key (a master-key rotation) after reading the area.
        await db
            .update(accountKeys)
            .set({ keyVersion: 2 })
            .where(eq(accountKeys.userId, creator.userId));
        expect(
            await groups.appendChain({
                ...rotationCall(group, head, creator.userId),
                rotations: [await rotationNow(group, root.id, creator.userId, [])],
            }),
        ).toEqual({ status: 'invalid', reason: 'self-grant-key-version' });
        expect((await areaRow(group.areaId)).workspaceKeyVersion).toBe(1);
        const rotation = await rotationNow(group, root.id, creator.userId, []);
        await okHead(
            await groups.appendChain({
                ...rotationCall(group, head, creator.userId),
                rotations: [{ ...rotation, selfGrant: { ...rotation.selfGrant, keyVersion: 2 } }],
            }),
        );
        expect((await areaRow(group.areaId)).workspaceKeyVersion).toBe(2);
    });

    test('a kind the area does not hold, or one named twice, is invalid; one left out or at another version is stale; each leaves nothing behind', async () => {
        const { creator, group, head } = await threeMembers();
        const root = await areaRoot(group, creator.userId);
        await writeDocument(group.areaId, 'tags', 0);
        const rootBefore = (
            await db.select().from(driveNodes).where(eq(driveNodes.id, root.id))
        )[0]!;
        const call = rotationCall(group, head, creator.userId);
        const attempt = async (documents: groups.RotationDocumentInput[]) =>
            groups.appendChain({
                ...call,
                rotations: [await rotationNow(group, root.id, creator.userId, documents)],
            });
        const tags = (version: number) => ({ kind: 'tags', version, envelope: randomBytes(64) });
        const invalidDocuments = { status: 'invalid', reason: 'rotation-documents' };
        expect(
            await attempt([tags(1), { kind: 'pins', version: 1, envelope: randomBytes(64) }]),
        ).toEqual(invalidDocuments);
        expect(await attempt([tags(1), tags(1)])).toEqual(invalidDocuments);
        // Left out: a kind created after the rotator read the area, or one its client does not know.
        const staleTags = { workspaceId: group.areaId, kind: 'tags' };
        const stale = { status: 'document-stale', ...staleTags, stale: [staleTags] };
        expect(await attempt([])).toEqual(stale);
        // A member rewrites it after the rotator read version 1.
        await writeDocument(group.areaId, 'tags', 1);
        expect(await attempt([tags(1)])).toEqual(stale);
        expect(await attempt([tags(3)])).toEqual(stale);
        // Every stale document in one answer: another kind created since, and the tags.
        await writeDocument(group.areaId, 'pins', 0);
        expect(await attempt([tags(1)])).toEqual({
            ...stale,
            stale: [{ workspaceId: group.areaId, kind: 'pins' }, staleTags],
            kind: 'pins',
        });
        // Nothing of any refused call stayed: roster, area key, self-grant, root, Drive run, document.
        expect(await rostersAt(group.groupId, call.roster.version)).toEqual([]);
        expect(await areaRow(group.areaId)).toMatchObject({ workspaceKeyVersion: 1 });
        const [ownGrant] = await db
            .select()
            .from(workspaceKeys)
            .where(
                and(
                    eq(workspaceKeys.workspaceId, group.areaId),
                    eq(workspaceKeys.userId, creator.userId),
                ),
            );
        expect(ownGrant!.workspaceKeyVersion).toBe(1);
        const rootAfter = (
            await db.select().from(driveNodes).where(eq(driveNodes.id, root.id))
        )[0]!;
        expect(rootAfter).toMatchObject({
            keyEpoch: rootBefore.keyEpoch,
            changeSeq: rootBefore.changeSeq,
            prevKeyEnvelope: null,
        });
        expect(await drive.activeRotation(db, group.areaId)).toBeNull();
        expect((await documentRows(group.areaId)).map((row) => [row.kind, row.version])).toEqual([
            ['pins', 1],
            ['tags', 2],
        ]);
        // The same roster with the versions now stored lands.
        const resealed = tags(2);
        await okHead(
            await attempt([resealed, { kind: 'pins', version: 1, envelope: randomBytes(64) }]),
        );
        const [pins, stored] = await documentRows(group.areaId);
        expect(pins!.version).toBe(2);
        expect(stored!.version).toBe(3);
        expect(stored!.envelope.equals(resealed.envelope)).toBe(true);
    });

    test('a held member cannot write a workspace document in the area; the holder still can', async () => {
        const { creator, group, stayer } = await threeMembers();
        expect(
            await groups.placeHold({
                groupId: group.groupId,
                holderUserId: creator.userId,
                userId: stayer.userId,
                minutes: 15,
            }),
        ).toMatchObject({ status: 'placed' });
        const write = (writer: string) =>
            drive.putWorkspaceDocument({
                limits: DOCUMENT_LIMITS,
                workspaceId: group.areaId,
                kind: 'tags',
                version: 0,
                envelope: randomBytes(64),
                writer,
            });
        await expect(write(stayer.userId)).rejects.toMatchObject({
            name: 'AccessEndedError',
            reason: 'held',
        });
        expect(await documentRows(group.areaId)).toEqual([]);
        expect((await write(creator.userId)).status).toBe('ok');
    });

    test('in a group area only an active members holder may start a Drive rotation', async () => {
        const { creator, group, leaver, stayer } = await threeMembers();
        expect(await drive.mayStartRotation(creator.userId, group.areaId)).toBe(true);
        expect(await drive.mayStartRotation(stayer.userId, group.areaId)).toBe(false);
        expect(await drive.mayStartRotation(stayer.userId, stayer.workspaceId)).toBe(true);
        await groups.leaveGroup(group.groupId, leaver.userId);
        expect(await drive.mayStartRotation(leaver.userId, group.areaId)).toBe(false);
        const stranger = await createTestAccount();
        expect(await drive.mayStartRotation(stranger.userId, group.areaId)).toBe(false);
    });

    test('stopping a share or link in an area marks it due for rotation, whoever stops it, held or not', async () => {
        const { creator, group, leaver: holder, stayer } = await threeMembers();
        const outsider = await createTestAccount();
        await ensureIdentity(outsider.userId);
        const root = await areaRoot(group, creator.userId);
        const dueAt = async (workspaceId: string) => (await areaRow(workspaceId)).rotationDueAt;
        const clear = () =>
            db
                .update(workspaces)
                .set({ rotationDueAt: null })
                .where(eq(workspaces.id, group.areaId));
        await clear();
        // A member without `members`, who may not rotate: the area is due, and holders see it.
        const memberShare = await shareOf(group, root, stayer.userId, outsider.userId);
        expect(await drive.revokeShare(group.areaId, memberShare)).not.toBeNull();
        expect(await dueAt(group.areaId)).not.toBeNull();
        expect(await groups.listRotationsDue(group.groupId)).toEqual([group.areaId]);
        // Stopping what is stopped already marks nothing.
        await clear();
        expect(await drive.revokeShare(group.areaId, memberShare)).toBeNull();
        expect(await dueAt(group.areaId)).toBeNull();
        // A holder too: if their device stops before it rotates, the mark is all that is left.
        const holderShare = await shareOf(group, root, holder.userId, outsider.userId);
        // Held ahead of a removal, the holder can still stop a share, and it still marks the area.
        expect(
            await groups.placeHold({
                groupId: group.groupId,
                holderUserId: creator.userId,
                userId: holder.userId,
                minutes: 15,
            }),
        ).toMatchObject({ status: 'placed' });
        expect(await drive.revokeShare(group.areaId, holderShare)).not.toBeNull();
        expect(await dueAt(group.areaId)).not.toBeNull();
        // Links the same way, and an earlier mark keeps its time.
        await clear();
        const first = await linkOf(group, root, stayer.userId);
        expect(await drive.revokeLink(group.areaId, first)).not.toBeNull();
        const since = await dueAt(group.areaId);
        expect(since).not.toBeNull();
        const second = await linkOf(group, root, creator.userId);
        expect(await drive.revokeLink(group.areaId, second)).not.toBeNull();
        expect(await dueAt(group.areaId)).toEqual(since);
        // In a personal workspace its owner rotates; nothing is ever marked due.
        const range = await drive.allocateKeyEpochs(stayer.workspaceId, 1);
        const own = await signed.createRoot({
            workspaceId: stayer.workspaceId,
            userId: stayer.userId,
            id: randomUUID(),
            envelopes: {
                keyEpoch: range!.from,
                parentKeyEpoch: 1,
                keyEnvelope: randomBytes(72),
                metadataEnvelope: randomBytes(100),
            },
        });
        if (own.status !== 'created') throw new Error(own.status);
        const personal = await drive.createShare({
            workspaceId: stayer.workspaceId,
            nodeId: own.root.id,
            granterUserId: stayer.userId,
            granteeUserId: outsider.userId,
            role: 'viewer',
            keyEpoch: own.root.keyEpoch,
            shareEnvelope: randomBytes(4565),
        });
        if (personal.status !== 'ok') throw new Error(personal.status);
        expect(await drive.revokeShare(stayer.workspaceId, personal.share.id)).not.toBeNull();
        expect(await dueAt(stayer.workspaceId)).toBeNull();
    });

    /*
     * Decision D3 (docs/integrity-design.md, "What the server enforces"): a rotation in a
     * family folder never claims authorship. A record with a writer's signature to keep is
     * taken only re-keyed (a legacy signature beside it only re-sealed); a record with none,
     * only re-sealed.
     */
    test('a rotation in a family folder takes only the re-keyed form, or re-sealed where there is no writer to keep', async () => {
        const { creator, group } = await threeMembers();
        const root = await areaRoot(group, creator.userId);
        const childEpoch = (await drive.allocateKeyEpochs(group.areaId, 1))!.from;
        const made = await signed.createFolders({
            workspaceId: group.areaId,
            userId: creator.userId,
            folders: [
                {
                    id: randomUUID(),
                    parentId: root.id,
                    envelopes: {
                        keyEpoch: childEpoch,
                        parentKeyEpoch: root.keyEpoch,
                        keyEnvelope: randomBytes(72),
                        metadataEnvelope: randomBytes(100),
                    },
                },
            ],
        });
        if (made.status !== 'created') throw new Error(made.status);
        const child = made.nodes[0]!;
        // The child was written before signatures: nobody's record to keep.
        await db
            .update(driveNodes)
            .set({ metadataSignerId: null, metadataSignature: null })
            .where(eq(driveNodes.id, child.id));
        const started = await rotations.startRotation({
            workspaceId: group.areaId,
            nodeId: root.id,
            startedBy: creator.userId,
        });
        if (started.status !== 'ok') throw new Error(started.status);
        const target = started.rotation.targetEpoch;
        const sign = signerFor(creator.userId);
        const nodeNow = async (id: string) =>
            (await db.select().from(driveNodes).where(eq(driveNodes.id, id)))[0]!;
        const send = async (
            id: string,
            parentKeyEpoch: number,
            signing: { legacy?: 'ordinary' | 'saved' | 'resealed'; rekey?: boolean },
        ) => {
            const node = await nodeNow(id);
            const metadataEnvelope = randomBytes(100);
            const [result] = await rotations.rotateNodes({
                workspaceId: group.areaId,
                rootId: root.id,
                targetEpoch: target,
                userId: creator.userId,
                // The root's re-key stands in for its roster's (applyRotation).
                byRoster: id === root.id,
                nodes: [
                    {
                        id,
                        changeSeq: node.changeSeq!,
                        parentKeyEpoch,
                        keyEnvelope: randomBytes(72),
                        rotated: {
                            metadataEnvelope,
                            metadataSignature: signing.legacy
                                ? sign.sign(
                                      metadataStatement(
                                          {
                                              workspaceId: group.areaId,
                                              nodeId: id,
                                              kind: 'folder',
                                              metadataVersion: node.metadataVersion,
                                              metadataEnvelope,
                                          },
                                          signing.legacy,
                                      ),
                                  )
                                : null,
                            // An unsigned record has no origin to sign over: any bytes do.
                            metadataRekey: signing.rekey
                                ? ((await signed.metadataRekey(
                                      creator.userId,
                                      group.areaId,
                                      id,
                                      target,
                                      metadataEnvelope,
                                  )) ?? {
                                      originKeyEnvelope: randomBytes(72),
                                      signature: randomBytes(64),
                                  })
                                : null,
                            versions: [],
                            shares: [],
                            links: [],
                            unsealableLinks: [],
                        },
                    },
                ],
            });
            return result!.status;
        };
        // The creator's own root: ordinary or saved would claim it as the walker's, alone or
        // beside the re-key, and a bare re-seal would drop the creator's signature. Refused.
        for (const legacy of ['ordinary', 'saved', 'resealed'] as const)
            expect(await send(root.id, 1, { legacy })).toBe('unsupported');
        for (const legacy of ['ordinary', 'saved'] as const)
            expect(await send(root.id, 1, { legacy, rekey: true })).toBe('unsupported');
        expect((await nodeNow(root.id)).keyEpoch).toBe(root.keyEpoch);
        expect(await send(root.id, 1, { rekey: true, legacy: 'resealed' })).toBe('ok');
        const rekeyed = await nodeNow(root.id);
        expect(rekeyed.metadataOriginSignerId).toBe(creator.userId);
        expect(rekeyed.metadataOriginEnvelope).not.toBeNull();

        // The unsigned child: nothing to re-key, and only re-sealed.
        expect(await send(child.id, target, { rekey: true })).toBe('unsupported');
        expect(await send(child.id, target, { legacy: 'ordinary' })).toBe('unsupported');
        expect(await send(child.id, target, { legacy: 'resealed' })).toBe('ok');
        expect((await nodeNow(child.id)).metadataOriginEnvelope).toBeNull();
    });

    /*
     * A removal and the walk its rotation starts, against the Drive writes that
     * could leave something under keys the removed member held: emptying the
     * trash, and completing an upload begun before the removal. Every one of
     * those writes and every walk step locks the area's row first, so the
     * orders below are the ones the database can produce; each test fixes
     * one: the removal commits, the walk reads its work, the write lands, the
     * walk sends what it read.
     */
    describe('a removal racing its walk', () => {
        const nodeRow = async (id: string) =>
            (await db.select().from(driveNodes).where(eq(driveNodes.id, id)))[0]!;
        const epoch = async (group: Family) =>
            (await drive.allocateKeyEpochs(group.areaId, 1))!.from;

        async function folder(
            group: Family,
            userId: string,
            parent: { id: string; keyEpoch: number },
        ) {
            const made = await signed.createFolders({
                workspaceId: group.areaId,
                userId,
                folders: [
                    {
                        id: randomUUID(),
                        parentId: parent.id,
                        envelopes: {
                            keyEpoch: await epoch(group),
                            parentKeyEpoch: parent.keyEpoch,
                            keyEnvelope: randomBytes(72),
                            metadataEnvelope: randomBytes(100),
                        },
                    },
                ],
            });
            if (made.status !== 'created') throw new Error(made.status);
            return made.nodes[0]!;
        }

        /* Begins an upload of a new file under `parent`, or of a new version of `file`. */
        async function begin(
            group: Family,
            userId: string,
            into:
                | { parent: { id: string; keyEpoch: number } }
                | { file: { id: string; keyEpoch: number; currentVersionId: string | null } },
        ) {
            const objectId = randomUUID();
            const contentKeyEnvelope = randomBytes(72);
            const node =
                'parent' in into
                    ? {
                          existing: false as const,
                          id: randomUUID(),
                          parentId: into.parent.id,
                          envelopes: {
                              keyEpoch: await epoch(group),
                              parentKeyEpoch: into.parent.keyEpoch,
                              keyEnvelope: randomBytes(72),
                              metadataEnvelope: randomBytes(100),
                          },
                      }
                    : {
                          existing: true as const,
                          id: into.file.id,
                          keyEpoch: into.file.keyEpoch,
                          expectedVersionId: into.file.currentVersionId,
                      };
            const begun = await signed.beginUpload({
                workspaceId: group.areaId,
                userId,
                node,
                version: { id: randomUUID(), contentKeyEnvelope },
                object: {
                    id: objectId,
                    objectKey: `ws/${group.areaId}/${objectId}`,
                    contentSuite: 2,
                    chunkSize: 8 * 1024 * 1024,
                    chunkCount: 1,
                    contentNonce: randomBytes(16),
                    ciphertextSize: 1024n,
                },
                multipartId: `mp-${objectId}`,
                expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
            });
            if (begun.status !== 'ok') throw new Error(begun.status);
            return { uploadId: begun.uploadId, nodeId: node.id, contentKeyEnvelope };
        }

        /* Both steps of completing, as the Drive domain runs them for `writer`. */
        async function complete(group: Family, uploadId: string, writer: string) {
            const started = await drive.startCompleting(group.areaId, uploadId, writer);
            if (started.status !== 'ok') return started;
            return drive.finishCompleting(group.areaId, uploadId, 1024n, writer);
        }

        async function file(
            group: Family,
            userId: string,
            parent: { id: string; keyEpoch: number },
        ) {
            const begun = await begin(group, userId, { parent });
            const done = await complete(group, begun.uploadId, userId);
            if (done.status !== 'published') throw new Error(done.status);
            return { node: done.node, contentKeyEnvelope: begun.contentKeyEnvelope };
        }

        /* Three members, the area's root, a folder Trips in it, and a photo there. */
        async function familyFolder() {
            const members = await threeMembers();
            const root = await areaRoot(members.group, members.creator.userId);
            const trips = await folder(members.group, members.creator.userId, root);
            const photo = await file(members.group, members.creator.userId, trips);
            return { ...members, root, trips, photo };
        }

        /* The creator removes `stayer` (route 19), rotating the area: the walk's target. */
        async function removeStayer(family: Awaited<ReturnType<typeof familyFolder>>) {
            const { creator, stayer, group, head, root } = family;
            const rotation = await rotationNow(group, root.id, creator.userId, []);
            await okHead(
                await groups.appendChain({
                    groupId: group.groupId,
                    uploaderUserId: creator.userId,
                    expectedRevision: head.revision,
                    route: { kind: 'remove' as const, userId: stayer.userId },
                    roster: roster(head, creator.userId, 'remove stayer', {
                        changes: [{ userId: stayer.userId, status: 'left', roles: [] }],
                    }),
                    rotations: [rotation],
                    cache: {},
                }),
            );
            expect((await membership(group.groupId, stayer.userId))!.state).toBe('removed');
            return rotation.targetEpoch;
        }

        /* What the walk reads: every node it still has to visit (one page holds them here). */
        async function work(group: Family, rootId: string, targetEpoch: number) {
            const page = await rotations.listRotationWork({
                workspaceId: group.areaId,
                rootId,
                targetEpoch,
            });
            expect(page.nextCursor).toBeNull();
            return page.nodes;
        }

        /*
         * Sends what the walk read, parents first, as a client does: a fresh key
         * for each node below the target, every version it listed re-wrapped
         * under it. Each node's outcome, by id.
         */
        async function send(
            group: Family,
            rootId: string,
            targetEpoch: number,
            userId: string,
            nodes: rotations.RotationWorkNode[],
        ) {
            const outcomes: Record<string, string> = {};
            for (const node of nodes) {
                const [result] = await signed.rotateNodes({
                    workspaceId: group.areaId,
                    rootId,
                    targetEpoch,
                    userId,
                    nodes: [
                        {
                            id: node.id,
                            changeSeq: node.changeSeq!,
                            parentKeyEpoch: targetEpoch,
                            keyEnvelope: randomBytes(72),
                            rotated:
                                node.keyEpoch >= targetEpoch
                                    ? null
                                    : {
                                          metadataEnvelope: randomBytes(100),
                                          versions: node.versions.map((version) => ({
                                              id: version.id,
                                              contentKeyEnvelope: randomBytes(72),
                                          })),
                                          shares: [],
                                          links: [],
                                          unsealableLinks: [],
                                      },
                        },
                    ],
                });
                outcomes[node.id] = result!.status;
            }
            return outcomes;
        }

        /*
         * What is still under a key the removed member held: a live node of the
         * area below the target (by its own epoch, or, below the top folder, by
         * the one it is wrapped under), or a ready version still carrying a
         * content key envelope written before the walk re-keyed its file.
         */
        async function underOldKeys(group: Family, targetEpoch: number, written: Buffer[]) {
            const nodes = await db
                .select()
                .from(driveNodes)
                .where(and(eq(driveNodes.workspaceId, group.areaId), isNull(driveNodes.purgedAt)));
            const versions = await db
                .select()
                .from(fileVersions)
                .where(
                    and(
                        eq(fileVersions.workspaceId, group.areaId),
                        eq(fileVersions.status, 'ready'),
                    ),
                );
            return [
                ...nodes
                    .filter(
                        (node) =>
                            node.keyEpoch < targetEpoch ||
                            (node.parentId !== null && node.parentKeyEpoch < targetEpoch),
                    )
                    .map((node) => `node ${node.id}`),
                ...versions
                    .filter((version) =>
                        written.some((envelope) => version.contentKeyEnvelope?.equals(envelope)),
                    )
                    .map((version) => `version ${version.id}`),
            ];
        }

        /* The SQLSTATE of a database error, through the driver's wrapping. */
        function codeOf(error: unknown): string | undefined {
            for (let at = error as { code?: string; cause?: unknown } | undefined; at;) {
                if (typeof at.code === 'string') return at.code;
                at = at.cause as typeof at;
            }
            return undefined;
        }

        /*
         * Transaction A: takes the area's row as a departure does (lockAreas, for no key update)
         * and, holding it, removes `userId`; it commits on `commit()`. Before handing back it
         * shows the lock is held: a share lock on the row, as a Drive write's check takes,
         * times out instead of being granted.
         */
        async function removalHoldingArea(group: Family, userId: string) {
            let release!: () => void;
            const released = new Promise<void>((resolve) => (release = resolve));
            let held!: () => void;
            const holding = new Promise<void>((resolve) => (held = resolve));
            const done = db.transaction(async (tx) => {
                await tx.execute(
                    sql`select id from workspaces where id = ${group.areaId} for no key update`,
                );
                await tx
                    .update(groupMemberships)
                    .set({ state: 'removed', leftAt: new Date() })
                    .where(
                        and(
                            eq(groupMemberships.groupId, group.groupId),
                            eq(groupMemberships.userId, userId),
                        ),
                    );
                held();
                await released;
            });
            await holding;
            const probe = await db
                .transaction(async (tx) => {
                    await tx.execute(sql`set local lock_timeout = '100ms'`);
                    await tx.execute(
                        sql`select id from workspaces where id = ${group.areaId} for share`,
                    );
                })
                .then(
                    () => 'granted',
                    (error: unknown) => codeOf(error),
                );
            expect(probe).toBe('55P03');
            return async () => {
                release();
                await done;
            };
        }

        /* Until another backend of this database waits on a lock (the write queued behind A). */
        async function someoneWaits() {
            for (let tries = 0; tries < 100; tries++) {
                const { rows } = await db.execute<{ waiting: number }>(
                    sql`select count(*)::int as waiting from pg_stat_activity
                        where datname = current_database() and wait_event_type = 'Lock'`,
                );
                if (rows[0]!.waiting > 0) return true;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return false;
        }
        const settled = (promise: Promise<unknown>) =>
            Promise.race([
                promise.then(() => true),
                new Promise((resolve) => setTimeout(() => resolve(false), 50)),
            ]);

        test('a removal holding the area’s row: the removed member’s empty trash waits for it, then is refused', async () => {
            const { creator, stayer, group, trips } = await familyFolder();
            const old = await file(group, creator.userId, trips);
            await drive.trashNode({
                workspaceId: group.areaId,
                nodeId: old.node.id,
                writer: creator.userId,
            });
            const commit = await removalHoldingArea(group, stayer.userId);
            let emptying: Promise<unknown> | null = null;
            try {
                emptying = drive.emptyTrash(group.areaId, 100, stayer.userId).then(
                    (result) => result,
                    (error: unknown) => error,
                );
                // Queued behind A on the area's row, so it cannot decide on what A has not committed.
                expect(await someoneWaits()).toBe(true);
                expect(await settled(emptying)).toBe(false);
            } finally {
                await commit();
            }
            expect(await emptying).toBeInstanceOf(drive.AccessEndedError);
            expect((await nodeRow(old.node.id)).purgedAt).toBeNull();
        });

        test('a removal holding the area’s row: the removed member’s upload completion waits for it, then is refused', async () => {
            const { stayer, group, trips } = await familyFolder();
            const theirs = await begin(group, stayer.userId, { parent: trips });
            // Step one landed before the removal; the store finished; step three races it.
            expect(
                (await drive.startCompleting(group.areaId, theirs.uploadId, stayer.userId)).status,
            ).toBe('ok');
            const commit = await removalHoldingArea(group, stayer.userId);
            let finishing: Promise<unknown> | null = null;
            try {
                finishing = drive
                    .finishCompleting(group.areaId, theirs.uploadId, 1024n, stayer.userId)
                    .then(
                        (result) => result,
                        (error: unknown) => error,
                    );
                expect(await someoneWaits()).toBe(true);
                expect(await settled(finishing)).toBe(false);
            } finally {
                await commit();
            }
            expect(await finishing).toBeInstanceOf(drive.AccessEndedError);
            expect((await nodeRow(theirs.nodeId)).currentVersionId).toBeNull();
        });

        test('emptying the trash mid-walk: refused to the removed member; a member’s purge drops out of the walk, which still finishes', async () => {
            const family = await familyFolder();
            const { creator, stayer, group, root, trips, photo } = family;
            // In the trash: a file with a ready version, and a folder, which has no version for
            // the walk's exact-versions rule (#37) to catch it by.
            const old = await file(group, creator.userId, trips);
            const attic = await folder(group, creator.userId, trips);
            for (const nodeId of [old.node.id, attic.id])
                expect(
                    await drive.trashNode({
                        workspaceId: group.areaId,
                        nodeId,
                        writer: creator.userId,
                    }),
                ).toMatchObject({ status: 'ok' });
            const target = await removeStayer(family);
            const read = await work(group, root.id, target);
            expect(read.map((node) => node.id).sort()).toEqual(
                [trips.id, photo.node.id, old.node.id, attic.id].sort(),
            );
            // The removed member empties the trash: refused under the area's lock, nothing purged.
            await expect(drive.emptyTrash(group.areaId, 100, stayer.userId)).rejects.toBeInstanceOf(
                drive.AccessEndedError,
            );
            expect((await nodeRow(old.node.id)).purgedAt).toBeNull();
            // A member empties it between the walk's read and its send.
            expect(await drive.emptyTrash(group.areaId, 100, creator.userId)).toEqual({
                purged: 2,
                remaining: 0,
            });
            // The walk sends what it read. The purged two are not found and get no key back: a
            // tombstone keeps no envelope, and its version stays purged.
            expect(await send(group, root.id, target, creator.userId, read)).toEqual({
                [trips.id]: 'ok',
                [photo.node.id]: 'ok',
                [old.node.id]: 'not-found',
                [attic.id]: 'not-found',
            });
            for (const nodeId of [old.node.id, attic.id])
                expect(await nodeRow(nodeId)).toMatchObject({
                    keyEnvelope: null,
                    metadataEnvelope: null,
                });
            const [oldVersion] = await db
                .select()
                .from(fileVersions)
                .where(eq(fileVersions.id, old.node.currentVersionId!));
            expect(oldVersion).toMatchObject({ status: 'purged', contentKeyEnvelope: null });
            // Nothing the purge left is work the walk waits on: it finishes, all under new keys.
            expect(await work(group, root.id, target)).toEqual([]);
            expect(
                await rotations.finishRotation({
                    workspaceId: group.areaId,
                    rootId: root.id,
                    targetEpoch: target,
                }),
            ).toBe(true);
            expect(
                await underOldKeys(group, target, [
                    photo.contentKeyEnvelope,
                    old.contentKeyEnvelope,
                ]),
            ).toEqual([]);
        });

        test('completing an upload mid-walk: refused to the removed member; a member’s lands only where the walk re-keys it, or by attaching under the new key', async () => {
            const family = await familyFolder();
            const { creator, stayer, group, root, trips, photo } = family;
            const doc = await file(group, creator.userId, trips);
            // Begun before the removal, under keys every member held: two new versions of the
            // photo, one of the doc, a new file in Trips, and one by the member about to go.
            const winner = await begin(group, creator.userId, { file: photo.node });
            const loser = await begin(group, creator.userId, { file: photo.node });
            const late = await begin(group, creator.userId, { file: doc.node });
            const fresh = await begin(group, creator.userId, { parent: trips });
            const theirs = await begin(group, stayer.userId, { parent: trips });
            const target = await removeStayer(family);

            // The removed member's upload never becomes a file: refused under the area's lock at
            // either step (as if the first had landed before the removal).
            await expect(
                drive.startCompleting(group.areaId, theirs.uploadId, stayer.userId),
            ).rejects.toBeInstanceOf(drive.AccessEndedError);
            await db
                .update(driveUploads)
                .set({ status: 'completing', completingAt: new Date() })
                .where(eq(driveUploads.id, theirs.uploadId));
            await expect(
                drive.finishCompleting(group.areaId, theirs.uploadId, 1024n, stayer.userId),
            ).rejects.toBeInstanceOf(drive.AccessEndedError);

            const read = await work(group, root.id, target);
            expect(read.map((node) => node.id).sort()).toEqual(
                [trips.id, photo.node.id, doc.node.id, fresh.nodeId, theirs.nodeId].sort(),
            );
            // Before the walk reaches Trips: two uploads finish. They publish under keys the
            // walk has yet to replace (their envelopes were written at begin, before the
            // removal), so the walk must not take a batch that leaves them out.
            expect(await complete(group, winner.uploadId, creator.userId)).toMatchObject({
                status: 'published',
            });
            expect(await complete(group, fresh.uploadId, creator.userId)).toMatchObject({
                status: 'published',
            });
            // The photo's other version now conflicts. Attached to the photo or beside it in
            // Trips, it would go under a key the removed member holds: it waits.
            expect(await complete(group, loser.uploadId, creator.userId)).toMatchObject({
                status: 'conflicted',
            });
            const photoNow = await nodeRow(photo.node.id);
            expect(
                await signed.attachUpload(group.areaId, loser.uploadId, {
                    mode: 'same-node',
                    userId: creator.userId,
                    keyEpoch: photoNow.keyEpoch,
                    contentKeyEnvelope: randomBytes(72),
                }),
            ).toMatchObject({ status: 'rotating' });
            const besideTrips = async (parentKeyEpoch: number) =>
                signed.attachUpload(group.areaId, loser.uploadId, {
                    mode: 'sibling',
                    userId: creator.userId,
                    node: {
                        id: randomUUID(),
                        parentId: trips.id,
                        keyEpoch: await epoch(group),
                        parentKeyEpoch,
                        keyEnvelope: randomBytes(72),
                        metadataEnvelope: randomBytes(100),
                    },
                    contentKeyEnvelope: randomBytes(72),
                });
            expect(await besideTrips(trips.keyEpoch)).toMatchObject({ status: 'rotating' });

            // The walk sends what it read: the photo and the new file moved since, so it is told
            // to read again rather than leave their new versions under the old keys.
            expect(await send(group, root.id, target, creator.userId, read)).toEqual({
                [trips.id]: 'ok',
                [photo.node.id]: 'stale',
                [doc.node.id]: 'ok',
                [fresh.nodeId]: 'stale',
                [theirs.nodeId]: 'ok',
            });
            const again = await work(group, root.id, target);
            expect(again.map((node) => node.id).sort()).toEqual(
                [photo.node.id, fresh.nodeId].sort(),
            );
            expect(await send(group, root.id, target, creator.userId, again)).toEqual({
                [photo.node.id]: 'ok',
                [fresh.nodeId]: 'ok',
            });

            // After the walk passed the doc: its new version, begun under the doc's old key, is
            // conflicted, and lands only attached under the doc's new key.
            expect(await complete(group, late.uploadId, creator.userId)).toMatchObject({
                status: 'conflicted',
            });
            const docNow = await nodeRow(doc.node.id);
            expect(docNow.keyEpoch).toBe(target);
            expect(
                await signed.attachUpload(group.areaId, late.uploadId, {
                    mode: 'same-node',
                    userId: creator.userId,
                    keyEpoch: docNow.keyEpoch,
                    contentKeyEnvelope: randomBytes(72),
                }),
            ).toMatchObject({ status: 'published' });
            // Trips is re-keyed: the waiting version goes in beside it, under Trips' new key.
            expect(await besideTrips(target)).toMatchObject({ status: 'published' });

            // The walk finishes, and nothing is under a key the removed member held; their own
            // upload never published.
            expect(await work(group, root.id, target)).toEqual([]);
            expect(
                await rotations.finishRotation({
                    workspaceId: group.areaId,
                    rootId: root.id,
                    targetEpoch: target,
                }),
            ).toBe(true);
            expect(
                await underOldKeys(group, target, [
                    photo.contentKeyEnvelope,
                    doc.contentKeyEnvelope,
                    winner.contentKeyEnvelope,
                    loser.contentKeyEnvelope,
                    late.contentKeyEnvelope,
                    fresh.contentKeyEnvelope,
                ]),
            ).toEqual([]);
            expect((await nodeRow(theirs.nodeId)).currentVersionId).toBeNull();
        });
    });
});

describe('a resend on another revision', () => {
    test('is compared, never written: unknown bytes at a free version are stale even when that version is next', async () => {
        const creator = await createTestAccount();
        const group = await family(creator);
        // A roster nobody checked, naming the very next version: classifying it must not store it.
        const unchecked = roster(group.head, creator.userId, 'never checked');
        expect(
            await groups.classifyResend({
                groupId: group.groupId,
                uploaderUserId: creator.userId,
                roster: { version: 2, statement: unchecked.statement },
            }),
        ).toMatchObject({ status: 'stale' });
        expect(await rostersAt(group.groupId, 2)).toEqual([]);
        expect((await headNow(group.groupId)).revision).toBe(1);
        // Once a roster is stored at that version, the same bytes are a replay and others are stale.
        const stored = rosterWrite(group, group.head, creator.userId, 'stored');
        await okHead(await groups.appendChain(stored));
        expect(
            await groups.classifyResend({
                groupId: group.groupId,
                uploaderUserId: creator.userId,
                roster: { version: 2, statement: stored.roster.statement },
            }),
        ).toMatchObject({ status: 'replayed', revision: 2 });
        const lost = await groups.classifyResend({
            groupId: group.groupId,
            uploaderUserId: creator.userId,
            roster: { version: 2, statement: unchecked.statement },
        });
        expect(lost.status).toBe('stale');
        if (lost.status === 'stale')
            expect(lost.roster!.statement.equals(stored.roster.statement)).toBe(true);
        expect(await rostersAt(group.groupId, 2)).toHaveLength(1);
    });

    test('answers only an active members holder', async () => {
        const creator = await createTestAccount();
        const group = await family(creator);
        const plain = await accepted(group.groupId, creator.userId);
        await okHead(
            await groups.appendChain(admission(group, group.head, creator.userId, plain.userId)),
        );
        const stranger = await createTestAccount();
        const ask = (userId: string) =>
            groups.classifyResend({
                groupId: group.groupId,
                uploaderUserId: userId,
                roster: { version: 2, statement: Buffer.from('x') },
            });
        expect(await ask(plain.userId)).toEqual({ status: 'forbidden' });
        expect(await ask(stranger.userId)).toEqual({ status: 'not-member' });
    });
});

describe('grants and seals outside the chain', () => {
    test('a member cannot replace a working grant; the grantee or a holder can; a newer identity gets its own row', async () => {
        const creator = await createTestAccount();
        const group = await family(creator);
        const a = await accepted(group.groupId, creator.userId);
        const b = await accepted(group.groupId, creator.userId);
        let head = await okHead(
            await groups.appendChain(admission(group, group.head, creator.userId, a.userId)),
        );
        head = await okHead(
            await groups.appendChain(admission(group, head, creator.userId, b.userId)),
        );
        const envelopeOfB = async (granteeKeyVersion = 1) =>
            (
                await db
                    .select()
                    .from(areaGrants)
                    .where(
                        and(
                            eq(areaGrants.granteeUserId, b.userId),
                            eq(areaGrants.granteeKeyVersion, granteeKeyVersion),
                        ),
                    )
            )[0]?.envelope;
        const working = await envelopeOfB();
        const store = (uploader: string, granteeKeyVersion = 1) =>
            groups.storeGrants({
                groupId: group.groupId,
                uploaderUserId: uploader,
                grants: [grant(head, group.areaId, b.userId, uploader, { granteeKeyVersion })],
            });
        // Another member, at the same identity: the working grant stays.
        expect(await store(a.userId)).toEqual({ status: 'ok', stored: 0 });
        expect((await envelopeOfB())!.equals(working!)).toBe(true);
        // A member without `members` cannot seal.
        expect(
            await groups.storeGrants({
                groupId: group.groupId,
                uploaderUserId: a.userId,
                seals: [seal(head, creator.userId, a.userId)],
            }),
        ).toEqual({ status: 'forbidden' });
        // A version the grantee has not reached is refused outright: it would win every later contest.
        expect(await store(a.userId, 2)).toEqual({
            status: 'invalid',
            reason: 'grantee-key-version',
        });
        // Once their identity moves on, a grant for the newer one is a row of its own. Only a holder
        // adds it: it is the one served, so another member's junk there would hide the working one.
        await db
            .update(accountIdentities)
            .set({ keyVersion: 2 })
            .where(eq(accountIdentities.userId, b.userId));
        expect(await store(a.userId, 2)).toEqual({ status: 'ok', stored: 0 });
        expect(await envelopeOfB(2)).toBeUndefined();
        expect(await store(creator.userId, 2)).toEqual({ status: 'ok', stored: 1 });
        const newer = await envelopeOfB(2);
        // A grant for the older identity, even from a holder, replaces only that identity's row:
        // the newer one stays, so a stale client can never take the key from a moved-on member.
        expect(await store(creator.userId, 1)).toEqual({ status: 'ok', stored: 1 });
        expect((await envelopeOfB(2))!.equals(newer!)).toBe(true);
        const [space] = await groups.spacesFor(b.userId);
        expect(space!.areas[0]!.grant).toMatchObject({ granteeKeyVersion: 2 });
        // At the same identity, the grantee and a holder may replace it; another member may not.
        expect(await store(a.userId, 2)).toEqual({ status: 'ok', stored: 0 });
        expect((await envelopeOfB(2))!.equals(newer!)).toBe(true);
        expect(await store(b.userId, 2)).toEqual({ status: 'ok', stored: 1 });
        expect(await store(creator.userId, 2)).toEqual({ status: 'ok', stored: 1 });
        // A member fills a gap: with no grant to b at that area version at all, theirs is stored.
        await db.delete(areaGrants).where(eq(areaGrants.granteeUserId, b.userId));
        expect(await store(a.userId, 2)).toEqual({ status: 'ok', stored: 1 });
        const stranger = await createTestAccount();
        expect(await store(stranger.userId)).toEqual({ status: 'not-member' });
    });

    test('a grant to someone who left meanwhile is a membership change to rebuild on, not a final refusal', async () => {
        const creator = await createTestAccount();
        const group = await family(creator);
        const member = await accepted(group.groupId, creator.userId);
        const head = await okHead(
            await groups.appendChain(admission(group, group.head, creator.userId, member.userId)),
        );
        expect(await groups.leaveGroup(group.groupId, member.userId)).toEqual({ status: 'left' });
        expect(
            await groups.storeGrants({
                groupId: group.groupId,
                uploaderUserId: creator.userId,
                grants: [grant(head, group.areaId, member.userId, creator.userId)],
            }),
        ).toEqual({ status: 'members-changed', reason: 'grantee' });
    });
});

describe('invitations', () => {
    test('are spent once, and refused when expired, revoked, or taken by another address', async () => {
        const creator = await createTestAccount();
        const { groupId } = await family(creator);
        const invitee = await createTestAccount();
        const other = await createTestAccount();
        const invite = async (email: string) => {
            const tokenHash = randomBytes(32);
            const result = await groups.createInvitation({
                groupId,
                email,
                normalizedEmail: email,
                tokenHash,
                roles: [],
                invitedBy: creator.userId,
                expiresAt: new Date(Date.now() + 86_400_000),
            });
            return { tokenHash, result };
        };
        const first = await invite(invitee.email);
        expect(first.result.status).toBe('created');
        expect((await invite(invitee.email)).result).toEqual({ status: 'exists' });
        expect(
            await groups.acceptInvitation({ tokenHash: first.tokenHash, userId: other.userId }),
        ).toEqual({
            status: 'email-mismatch',
        });
        expect(
            await groups.acceptInvitation({ tokenHash: first.tokenHash, userId: invitee.userId }),
        ).toEqual({
            status: 'accepted',
            groupId,
        });
        expect(
            await groups.acceptInvitation({ tokenHash: first.tokenHash, userId: invitee.userId }),
        ).toEqual({
            status: 'gone',
        });
        expect(await groups.openInvitation(first.tokenHash)).toBeNull();
        expect((await membership(groupId, invitee.userId))!.state).toBe('accepted');

        const late = await invite(other.email);
        await db
            .update(groupInvitations)
            .set({
                createdAt: new Date(Date.now() - 2 * 86_400_000),
                expiresAt: new Date(Date.now() - 1000),
            })
            .where(eq(groupInvitations.tokenHash, late.tokenHash));
        expect(await groups.openInvitation(late.tokenHash)).toBeNull();
        expect(
            await groups.acceptInvitation({ tokenHash: late.tokenHash, userId: other.userId }),
        ).toEqual({
            status: 'gone',
        });
        const again = await invite(other.email);
        expect(again.result.status).toBe('created');
        if (again.result.status !== 'created') return;
        expect(await groups.revokeInvitation(groupId, again.result.id)).toBe('revoked');
        expect(
            await groups.acceptInvitation({ tokenHash: again.tokenHash, userId: other.userId }),
        ).toEqual({
            status: 'gone',
        });
        expect(await groups.revokeInvitation(groupId, again.result.id)).toBe('gone');
        expect((await invite(invitee.email)).result).toEqual({ status: 'already-member' });
    });

    test('the cleanup closes expired invitations and forgets addresses 30 days after an invitation closed', async () => {
        const creator = await createTestAccount();
        const { groupId } = await family(creator);
        const make = async (email: string, expiresAt: Date) => {
            const tokenHash = randomBytes(32);
            await groups.createInvitation({
                groupId,
                email,
                normalizedEmail: email,
                tokenHash,
                roles: [],
                invitedBy: creator.userId,
                expiresAt,
            });
            return tokenHash;
        };
        const row = async (tokenHash: Buffer) =>
            (
                await db
                    .select()
                    .from(groupInvitations)
                    .where(eq(groupInvitations.tokenHash, tokenHash))
            )[0]!;
        const live = await make('live@hushos.test', new Date(Date.now() + 86_400_000));
        const lapsed = await make('lapsed@hushos.test', new Date(Date.now() + 86_400_000));
        await db
            .update(groupInvitations)
            .set({
                createdAt: new Date(Date.now() - 2 * 86_400_000),
                expiresAt: new Date(Date.now() - 1000),
            })
            .where(eq(groupInvitations.tokenHash, lapsed));
        const old = await make('old@hushos.test', new Date(Date.now() + 86_400_000));
        await db
            .update(groupInvitations)
            .set({ state: 'revoked', updatedAt: new Date(Date.now() - 31 * 86_400_000) })
            .where(eq(groupInvitations.tokenHash, old));
        expect(await groups.cleanupInvitations()).toEqual({ expired: 1, forgotten: 1 });
        expect(await row(live)).toMatchObject({ state: 'open', email: 'live@hushos.test' });
        expect(await row(lapsed)).toMatchObject({ state: 'expired', email: 'lapsed@hushos.test' });
        expect(await row(old)).toMatchObject({
            state: 'revoked',
            email: null,
            normalizedEmail: null,
        });
        // Thirty days on, the lapsed one's address goes too.
        expect(
            await groups.cleanupInvitations({ now: new Date(Date.now() + 31 * 86_400_000) }),
        ).toMatchObject({ forgotten: 1 });
        expect(await row(lapsed)).toMatchObject({ email: null });
    });
});

describe('the chain cache', () => {
    test('is served only at the current revision, and a rebuild that raced a write is not stored', async () => {
        const creator = await createTestAccount();
        const group = await family(creator);
        expect(await groups.getChainCache(group.groupId)).toEqual({
            revision: 1,
            head: {
                rosterVersion: 1,
                rosterDigest: digestOf(group.input.roster.statement),
                groupKeyVersion: 1,
            },
            cache: { through: 1 },
        });
        await db.execute(sql`delete from group_chain_caches where group_id = ${group.groupId}`);
        expect(await groups.getChainCache(group.groupId)).toMatchObject({
            revision: 1,
            cache: null,
        });
        const two = rosterWrite(group, group.head, creator.userId, 'two');
        await okHead(await groups.appendChain({ ...two, cache: { through: 2 } }));
        expect(await groups.putChainCache(group.groupId, 1, { through: 1 })).toBe(false);
        // The head comes with the record, read together: version 2 and its digest.
        expect(await groups.getChainCache(group.groupId)).toEqual({
            revision: 2,
            head: {
                rosterVersion: 2,
                rosterDigest: digestOf(two.roster.statement),
                groupKeyVersion: 1,
            },
            cache: { through: 2 },
        });
        expect(await groups.putChainCache(group.groupId, 2, { rebuilt: true })).toBe(true);
        expect((await groups.getChainCache(group.groupId))!.cache).toEqual({ rebuilt: true });
    });
});

/*
 * The workspace owners migration, run against the tables as they were before
 * it, in a scratch schema that shadows them, inside a transaction that is
 * always rolled back.
 */
describe('the workspace owners backfill', () => {
    const folder = readdirSync(new URL('../drizzle', import.meta.url)).find((name) =>
        name.endsWith('_workspace_owners'),
    )!;
    const statements = readFileSync(
        new URL(`../drizzle/${folder}/migration.sql`, import.meta.url),
        'utf8',
    )
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean);

    async function migrate(seedRows: string[]) {
        const schema = `owners_${randomUUID().replaceAll('-', '')}`;
        class Rollback extends Error {}
        let result: { ownerKinds: string[]; keyVersions: number[] } | undefined;
        try {
            await db.transaction(async (tx) => {
                await tx.execute(sql.raw(`create schema ${schema}`));
                await tx.execute(sql.raw(`set local search_path to ${schema}`));
                await tx.execute(
                    sql.raw(`create table workspaces (
                        id uuid primary key,
                        change_seq bigint not null default 0,
                        key_epoch_seq integer not null default 0,
                        tombstones_dropped_through bigint not null default 0,
                        created_at timestamptz not null default now())`),
                );
                await tx.execute(
                    sql.raw(`create table personal_workspaces (
                        user_id uuid primary key,
                        workspace_id uuid not null unique references workspaces(id))`),
                );
                await tx.execute(
                    sql.raw(`create table workspace_keys (
                        workspace_id uuid not null,
                        user_id uuid not null,
                        workspace_key_version integer not null default 1)`),
                );
                for (const row of seedRows) await tx.execute(sql.raw(row));
                for (const statement of statements) await tx.execute(sql.raw(statement));
                const rows = await tx.execute<{
                    owner_kind: string;
                    workspace_key_version: number;
                }>(sql.raw(`select owner_kind, workspace_key_version from workspaces order by id`));
                result = {
                    ownerKinds: rows.rows.map((row) => row.owner_kind),
                    keyVersions: rows.rows.map((row) => row.workspace_key_version),
                };
                throw new Rollback();
            });
        } catch (error) {
            if (!(error instanceof Rollback)) throw error;
        }
        return result!;
    }

    const A = '00000000-0000-4000-8000-00000000000a';
    const B = '00000000-0000-4000-8000-00000000000b';

    test('labels every owned workspace personal and carries the highest grant version over', async () => {
        expect(
            await migrate([
                `insert into workspaces (id) values ('${A}'), ('${B}')`,
                `insert into personal_workspaces values ('${randomUUID()}', '${A}'), ('${randomUUID()}', '${B}')`,
                `insert into workspace_keys values ('${B}', '${randomUUID()}', 3)`,
            ]),
        ).toEqual({ ownerKinds: ['personal', 'personal'], keyVersions: [1, 3] });
    });

    test('refuses to run when a workspace has no owner', async () => {
        const error = await migrate([
            `insert into workspaces (id) values ('${A}'), ('${B}')`,
            `insert into personal_workspaces values ('${randomUUID()}', '${A}')`,
        ]).then(
            () => null,
            (reason: unknown) => reason,
        );
        // The query wrapper's message is the query; Postgres's own is on its cause.
        const messages: string[] = [];
        for (
            let at = error as { message?: string; cause?: unknown } | undefined;
            at;
            at = at.cause as typeof at
        )
            messages.push(String(at.message));
        expect(messages.join('\n')).toMatch(
            /workspace_owners: 1 workspace\(s\) have no personal_workspaces row/,
        );
    });
});

describe('deleting a family folder (groups design 2.10)', () => {
    /* A family of two with a second folder, "photos", holding a root, a share and a link. */
    async function withPhotos() {
        const creator = await createTestAccount();
        const group = await family(creator);
        const member = await accepted(group.groupId, creator.userId);
        let head = await okHead(
            await groups.appendChain(admission(group, group.head, creator.userId, member.userId)),
        );
        const areaSeed = seed();
        const photos = scopedId('workspace', group.groupId, areaSeed)!;
        head = await okHead(
            await groups.appendChain({
                ...rosterWrite(group, head, creator.userId, 'photos'),
                route: {
                    kind: 'area',
                    area: {
                        workspaceId: photos,
                        idSeed: areaSeed,
                        quotaBytes: 1n << 30n,
                        selfGrant: selfGrant(),
                    },
                },
            }),
        );
        const granted = await groups.storeGrants({
            groupId: group.groupId,
            uploaderUserId: creator.userId,
            grants: [grant(head, photos, member.userId, creator.userId)],
        });
        expect(granted.status).toBe('ok');
        for (const workspaceId of [group.areaId, photos])
            await db
                .insert(workspaceKeys)
                .values({ ...selfGrant(), workspaceId, userId: member.userId });
        const range = await drive.allocateKeyEpochs(photos, 1);
        const made = await signed.createRoot({
            workspaceId: photos,
            userId: creator.userId,
            id: randomUUID(),
            envelopes: {
                keyEpoch: range!.from,
                parentKeyEpoch: 1,
                keyEnvelope: randomBytes(72),
                metadataEnvelope: randomBytes(100),
            },
        });
        if (made.status !== 'created') throw new Error(made.status);
        const outsider = await createTestAccount();
        const shared = await insertLegacyShare({
            workspaceId: photos,
            nodeId: made.root.id,
            granterUserId: creator.userId,
            granteeUserId: outsider.userId,
            role: 'viewer',
            keyEpoch: made.root.keyEpoch,
            shareEnvelope: randomBytes(4565),
        });
        return { creator, member, group, head, photos, root: made.root, share: shared.id };
    }
    const retire = (group: Family, head: Head, uploader: string, workspaceId: string) =>
        groups.appendChain({
            ...rosterWrite(group, head, uploader, `retire ${workspaceId}`),
            route: { kind: 'retire', workspaceId },
        });
    const areaIdsOf = async (userId: string) =>
        (await groups.spacesFor(userId)).flatMap((space) => space.areas.map((a) => a.workspaceId));

    test('is gone for every member at once: spaces, Drive, grants, self-grants and shares', async () => {
        const { creator, member, group, head, photos, share } = await withPhotos();
        expect(await areaIdsOf(member.userId)).toContain(photos);
        expect(await isMember(member.userId, photos)).toBe(true);
        const next = await okHead(await retire(group, head, creator.userId, photos));
        expect((await areaRow(photos)).deletedAt).not.toBeNull();
        for (const userId of [creator.userId, member.userId]) {
            expect(await areaIdsOf(userId)).toEqual([group.areaId]);
            expect(await isMember(userId, photos)).toBe(false);
        }
        // The family's other folder is untouched.
        expect(await isMember(member.userId, group.areaId)).toBe(true);
        // Shares inside it stop at once.
        const [row] = await db.select().from(driveShares).where(eq(driveShares.id, share));
        expect(row!.revokedAt).not.toBeNull();
        // Nothing more is granted or wrapped there, and nothing more is owed or due there.
        expect(
            await groups.storeGrants({
                groupId: group.groupId,
                uploaderUserId: creator.userId,
                grants: [grant(next, photos, member.userId, creator.userId)],
            }),
        ).toEqual({ status: 'invalid', reason: 'area' });
        expect(
            await groups.putSelfGrant({
                groupId: group.groupId,
                workspaceId: photos,
                userId: member.userId,
                grant: selfGrant(),
            }),
        ).toEqual({ status: 'area' });
        expect((await groups.listAreas(group.groupId)).map((a) => a.workspaceId)).toEqual([
            group.areaId,
        ]);
        expect((await groups.missingGrants(group.groupId)).map((g) => g.workspaceId)).not.toContain(
            photos,
        );
        // A second deletion of the same folder is refused, and nothing is written.
        expect(await retire(group, next, creator.userId, photos)).toEqual({
            status: 'invalid',
            reason: 'area',
        });
        expect(await rostersAt(group.groupId, next.rosterVersion + 1)).toEqual([]);
    });

    test('the delete route changes nothing but the folder: a roster that also changes an entry is refused', async () => {
        const { creator, member, group, head, photos } = await withPhotos();
        expect(
            await groups.appendChain({
                ...rosterWrite(group, head, creator.userId, 'retire and promote', {
                    changes: [{ userId: member.userId, status: 'active', roles: ['members'] }],
                }),
                route: { kind: 'retire', workspaceId: photos },
            }),
        ).toEqual({ status: 'invalid', reason: 'area-delete' });
        expect((await areaRow(photos)).deletedAt).toBeNull();
        expect((await membership(group.groupId, member.userId))!.roles).toEqual([]);
    });

    test('only a members holder deletes, and only a folder of this family', async () => {
        const { creator, member, group, head, photos } = await withPhotos();
        expect(await retire(group, head, member.userId, photos)).toEqual({ status: 'forbidden' });
        const other = await family(await createTestAccount());
        expect(await retire(group, head, creator.userId, other.areaId)).toEqual({
            status: 'invalid',
            reason: 'area',
        });
        expect((await areaRow(photos)).deletedAt).toBeNull();
        expect((await areaRow(other.areaId)).deletedAt).toBeNull();
    });

    test('a removal after it marks only the live folders due, and the folder stops counting', async () => {
        const { creator, member, group, head, photos } = await withPhotos();
        const next = await okHead(await retire(group, head, creator.userId, photos));
        await okHead(
            await groups.appendChain({
                ...rosterWrite(group, next, creator.userId, 'remove member', {
                    changes: [{ userId: member.userId, status: 'left', roles: [] }],
                }),
                route: { kind: 'remove', userId: member.userId },
            }),
        );
        expect(await groups.listRotationsDue(group.groupId)).toEqual([group.areaId]);
        // The limit counts live folders: with two allowed, the deleted one leaves room for one.
        const areaSeed = seed();
        const head3 = await headNow(group.groupId);
        await okHead(
            await groups.appendChain({
                ...rosterWrite(group, head3, creator.userId, 'third'),
                route: {
                    kind: 'area',
                    area: {
                        workspaceId: scopedId('workspace', group.groupId, areaSeed)!,
                        idSeed: areaSeed,
                        quotaBytes: 1n,
                        selfGrant: selfGrant(),
                        limit: 2,
                    },
                },
            }),
        );
    });

    test('an upload left completing in it is released by the expiry, never published there', async () => {
        const { creator, group, head, photos, root } = await withPhotos();
        const objectId = randomUUID();
        const nodeId = randomUUID();
        const size = 1n << 20n;
        const begun = await signed.beginUpload({
            workspaceId: photos,
            userId: creator.userId,
            node: {
                existing: false,
                id: nodeId,
                parentId: root.id,
                envelopes: {
                    keyEpoch: (await drive.allocateKeyEpochs(photos, 1))!.from,
                    parentKeyEpoch: root.keyEpoch,
                    keyEnvelope: randomBytes(72),
                    metadataEnvelope: randomBytes(100),
                },
            },
            version: { id: randomUUID(), contentKeyEnvelope: randomBytes(84) },
            object: {
                id: objectId,
                objectKey: `ws/${photos}/${objectId}`,
                contentSuite: 2,
                chunkSize: Number(size),
                chunkCount: 1,
                contentNonce: randomBytes(16),
                ciphertextSize: size,
            },
            multipartId: `mp-${objectId}`,
            expiresAt: new Date(Date.now() + 3600_000),
        });
        if (begun.status !== 'ok') throw new Error(begun.status);
        expect((await drive.startCompleting(photos, begun.uploadId)).status).toBe('ok');
        await okHead(await retire(group, head, creator.userId, photos));
        // The expiry job finds the object stored at its size and finishes the upload: refused.
        expect(await drive.finishCompleting(photos, begun.uploadId, size)).toEqual({
            status: 'purged',
        });
        // The never-published node goes, and its upload row with it.
        expect(
            await db.select().from(driveUploads).where(eq(driveUploads.id, begun.uploadId)),
        ).toEqual([]);
        const [storage] = await db
            .select()
            .from(workspaceStorage)
            .where(eq(workspaceStorage.workspaceId, photos));
        expect(storage).toMatchObject({ usedBytes: 0n, reservedBytes: 0n });
        expect(await db.select().from(driveNodes).where(eq(driveNodes.id, nodeId))).toEqual([]);
        // Its object goes from the store through the outbox.
        const [queued] = await db
            .select()
            .from(driveObjectDeletions)
            .where(eq(driveObjectDeletions.objectId, objectId));
        expect(queued).toMatchObject({ objectKey: `ws/${photos}/${objectId}` });
    });

    test('the purge takes it with everything in it after 30 days, never before', async () => {
        const { creator, group, head, photos, root } = await withPhotos();
        const objectId = randomUUID();
        await db.insert(driveObjects).values({
            id: objectId,
            workspaceId: photos,
            objectKey: `ws/${photos}/${objectId}`,
            chunkSize: 1,
            chunkCount: 1,
            contentNonce: randomBytes(16),
            ciphertextSize: 10n,
            status: 'ready',
        });
        await okHead(await retire(group, head, creator.userId, photos));
        const deletedAgo = (days: number) =>
            db
                .update(workspaces)
                .set({ deletedAt: sql`now() - make_interval(days => ${days})` })
                .where(eq(workspaces.id, photos));
        await deletedAgo(29);
        expect(await groups.purgeDeletedAreas(30)).toBe(0);
        expect(await areaRow(photos)).toBeDefined();
        const [kept] = await db.select().from(driveNodes).where(eq(driveNodes.id, root.id));
        expect(kept).toBeDefined();
        await deletedAgo(31);
        expect(await groups.purgeDeletedAreas(30)).toBe(1);
        expect(await db.select().from(workspaces).where(eq(workspaces.id, photos))).toEqual([]);
        expect(await db.select().from(driveNodes).where(eq(driveNodes.id, root.id))).toEqual([]);
        expect(
            await db.select().from(areaGrants).where(eq(areaGrants.workspaceId, photos)),
        ).toEqual([]);
        // Its objects are queued for deletion from the store, not left for the orphan sweep.
        const [queued] = await db
            .select()
            .from(driveObjectDeletions)
            .where(eq(driveObjectDeletions.objectId, objectId));
        expect(queued).toMatchObject({ objectKey: `ws/${photos}/${objectId}`, published: true });
        // The family and its live folder stay.
        expect(await isMember(creator.userId, group.areaId)).toBe(true);
        expect(await groups.purgeDeletedAreas(30)).toBe(0);
    });

    test('a folder an open or held report names waits for the report, evidence and all', async () => {
        const { creator, group, head, photos, root } = await withPhotos();
        await okHead(await retire(group, head, creator.userId, photos));
        await db
            .update(workspaces)
            .set({ deletedAt: sql`now() - make_interval(days => 31)` })
            .where(eq(workspaces.id, photos));
        const reportId = randomUUID();
        await db.insert(driveReports).values({
            id: reportId,
            workspaceId: photos,
            nodeId: root.id,
            nodeKind: 'folder',
            keyEpoch: root.keyEpoch,
            category: 'other',
            reason: 'Reported before the folder was deleted',
        });
        // Open: nothing of it goes.
        expect(await groups.purgeDeletedAreas(30)).toBe(0);
        expect(await db.select().from(driveNodes).where(eq(driveNodes.id, root.id))).toHaveLength(
            1,
        );
        // Resolved but held: still nothing.
        await db
            .update(driveReports)
            .set({ status: 'dismissed', heldAt: new Date() })
            .where(eq(driveReports.id, reportId));
        expect(await groups.purgeDeletedAreas(30)).toBe(0);
        // Let go: the folder goes.
        await db.update(driveReports).set({ heldAt: null }).where(eq(driveReports.id, reportId));
        expect(await groups.purgeDeletedAreas(30)).toBe(1);
        expect(await db.select().from(workspaces).where(eq(workspaces.id, photos))).toEqual([]);
    });
});

/*
 * A self-grant and a master-key rotation of its writer, racing: the writer
 * holds the user's row for share while it checks the account's key version
 * and writes, the rotation holds it for update. Whichever goes first, no
 * self-grant may end under a root other than the account's current one.
 */
describe('a self-grant written while its writer rotates their account key', () => {
    /* A transaction held open until released; rolled back if `commit` is false. */
    function held(
        work: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>,
    ) {
        let release!: (commit: boolean) => void;
        const gate = new Promise<boolean>((resolve) => (release = resolve));
        let ready!: () => void;
        const started = new Promise<void>((resolve) => (ready = resolve));
        const done = db
            .transaction(async (tx) => {
                await work(tx);
                ready();
                if (!(await gate)) throw new Error('rolled back');
            })
            .catch((error: Error) => {
                if (error.message !== 'rolled back') throw error;
            });
        return { started, release, done };
    }
    const pending = async (promise: Promise<unknown>) =>
        (await Promise.race([
            promise.then(() => 'settled'),
            new Promise((resolve) => setTimeout(() => resolve('pending'), 300)),
        ])) === 'pending';

    async function member() {
        const { user, workspaceId } = await registered();
        const group = await family({ userId: user.id });
        return { user, workspaceId, group, sessionTokenHash: await signedIn(user.id) };
    }
    /* Every grant the account holds, at the key version its root is now at. */
    async function consistent(userId: string) {
        const [account] = await db
            .select({ keyVersion: accountKeys.keyVersion })
            .from(accountKeys)
            .where(eq(accountKeys.userId, userId));
        const rows = await db
            .select({ keyVersion: workspaceKeys.keyVersion })
            .from(workspaceKeys)
            .where(eq(workspaceKeys.userId, userId));
        return rows.every((row) => row.keyVersion === account!.keyVersion);
    }
    /* changeAccountSecurity for a master-key rotation carrying `workspaceIds`' grants (each at version 1). */
    async function rotate(m: Awaited<ReturnType<typeof member>>, workspaceIds: string[]) {
        const stored = (await auth.getIdentity(m.user.id))!;
        return auth.changeAccountSecurity({
            userId: m.user.id,
            action: 'master-key',
            sessionTokenHash: m.sessionTokenHash,
            credentialVersion: 1,
            registrationRecord: 'record-2',
            envelope: {
                keyVersion: 2,
                wrappingSalt: randomBytes(32),
                wrappingNonce: randomBytes(24),
                encryptedKey: randomBytes(48),
            },
            recovery: {
                keyVersion: 2,
                recoveryVersion: 2,
                wrappingSalt: randomBytes(32),
                wrappingNonce: randomBytes(24),
                encryptedKey: randomBytes(48),
                backupNonce: randomBytes(24),
                encryptedRecoveryKey: randomBytes(48),
                publicKey: randomBytes(32),
            },
            identity: {
                keyVersion: 2,
                wrappingSalt: randomBytes(32),
                encryptionPublicKey: stored.encryptionPublicKey,
                encryptionPrivateKeyNonce: randomBytes(24),
                encryptedEncryptionPrivateKey: randomBytes(48),
                signingPublicKey: stored.signingPublicKey,
                signingSeedNonce: randomBytes(24),
                encryptedSigningSeed: randomBytes(48),
            },
            workspaces: workspaceIds.map((id) => ({
                id,
                grant: { ...selfGrant(), keyVersion: 2 },
            })),
        });
    }
    const put = (m: Awaited<ReturnType<typeof member>>, keyVersion: number) =>
        groups.putSelfGrant({
            groupId: m.group.groupId,
            workspaceId: m.group.areaId,
            userId: m.user.id,
            grant: { ...selfGrant(), keyVersion },
        });

    test('rotation first: the writer waits for it, then is refused under the old root', async () => {
        const m = await member();
        // The rotation's lock and its new root, not yet committed.
        const rotation = held(async (tx) => {
            await tx
                .select({ id: users.id })
                .from(users)
                .where(eq(users.id, m.user.id))
                .for('update');
            await tx
                .update(accountKeys)
                .set({ keyVersion: 2 })
                .where(eq(accountKeys.userId, m.user.id));
        });
        await rotation.started;
        const write = put(m, 1);
        try {
            // Without the share lock it would read key version 1 and write under the retired root.
            expect(await pending(write)).toBe(true);
        } finally {
            rotation.release(true);
            await rotation.done;
        }
        expect(await write).toEqual({ status: 'stale' });
        // The client re-makes it from the area grant under the new root.
        expect(await put(m, 2)).toEqual({ status: 'ok' });
        await db
            .update(workspaceKeys)
            .set({ keyVersion: 2 })
            .where(eq(workspaceKeys.workspaceId, m.workspaceId));
        expect(await consistent(m.user.id)).toBe(true);
        // A new family folder made by the same member under the old root is refused too.
        expect(await groups.createGroup(familyInput({ userId: m.user.id }).input)).toEqual({
            status: 'invalid',
            reason: 'self-grant-key-version',
        });
    });

    test('writer first: the rotation waits for it, then is refused for leaving the new row behind', async () => {
        const m = await member();
        // A member who has not stored a self-grant for the folder yet.
        await db
            .delete(workspaceKeys)
            .where(
                and(
                    eq(workspaceKeys.userId, m.user.id),
                    eq(workspaceKeys.workspaceId, m.group.areaId),
                ),
            );
        // Holds the writer between its check and its insert: the same row, uncommitted.
        const blocker = held(async (tx) => {
            await tx
                .insert(workspaceKeys)
                .values({ ...selfGrant(), workspaceId: m.group.areaId, userId: m.user.id });
        });
        await blocker.started;
        const write = put(m, 1);
        // The client read only the personal grant: the folder's self-grant did not exist yet.
        let rotation: Promise<boolean> | undefined;
        try {
            expect(await pending(write)).toBe(true);
            rotation = rotate(m, [m.workspaceId]);
            // Without the share lock it would commit now, and the write land under the old root.
            expect(await pending(rotation)).toBe(true);
        } finally {
            blocker.release(false);
            await blocker.done;
        }
        expect(await write).toEqual({ status: 'ok' });
        expect(await rotation).toBe(false);
        expect(await consistent(m.user.id)).toBe(true);
        // Read again, with the new row, the rotation goes through.
        expect(await rotate(m, [m.workspaceId, m.group.areaId])).toBe(true);
        expect(await consistent(m.user.id)).toBe(true);
    });
});
