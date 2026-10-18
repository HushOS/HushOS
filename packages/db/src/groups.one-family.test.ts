import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
    closeDatabase,
    createTestAccount,
    createTestFamily,
    createTestIdentity,
    resetDatabase,
} from '../test/helpers';
import { db } from './client';
import * as groups from './groups';
import { scopedId } from './ids';
import {
    groupInvitations,
    groupMemberships,
    groupRosters,
    groups as groupsTable,
    type GroupKind,
    type GroupRole,
} from './schema';

/*
 * One family per account (docs/families-shared-pool.md 4): creating,
 * accepting into and being admitted to a second family answer `in-family`,
 * under the group lock and, past it, through the unique index on active
 * family memberships; companies (`org`) are outside the rule; and the
 * migration that adds the index stops on an account already in two families
 * rather than choosing one. Statements are opaque bytes, as in groups.test.ts.
 */

beforeEach(resetDatabase);
afterAll(closeDatabase);

type Account = { userId: string; email: string };
type Head = groups.Head;

const ORGANIZER: GroupRole[] = ['billing', 'guardian', 'members'];
const seed = () => randomBytes(16).toString('base64url');
const signatures = () => ({
    ed25519Signature: randomBytes(64),
    mlDsaSignature: randomBytes(3309),
    signerSignature: randomBytes(3373),
});

function grant(head: Head, workspaceId: string, granteeUserId: string, granterUserId: string) {
    return {
        workspaceId,
        workspaceKeyVersion: 1,
        granteeUserId,
        granteeKeyVersion: 1,
        granterUserId,
        rosterVersion: head.rosterVersion,
        rosterDigest: head.rosterDigest,
        envelope: randomBytes(4565),
    };
}

/* What a client sends to create a group of `kind`: id, first roster, seal, area and grant. */
function creation(creator: Account, kind: GroupKind = 'family', name = 'Lindqvist family') {
    const idSeed = seed();
    const groupId = scopedId('group', creator.userId, idSeed)!;
    const areaSeed = seed();
    const areaId = scopedId('workspace', groupId, areaSeed)!;
    const statement = Buffer.from(`roster 1 ${groupId}`);
    const head: Head = {
        rosterVersion: 1,
        rosterDigest: groups.statementDigest(statement),
        groupKeyVersion: 1,
        revision: 1,
    };
    return {
        groupId,
        areaId,
        input: {
            id: groupId,
            idSeed,
            kind,
            name,
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
                changes: [{ userId: creator.userId, status: 'active', roles: ORGANIZER }],
                dropsHolder: false,
            } as groups.ParsedRoster,
            keySeal: {
                groupKeyVersion: 1,
                holderUserId: creator.userId,
                holderKeyVersion: 1,
                sealerUserId: creator.userId,
                rosterVersion: 1,
                rosterDigest: head.rosterDigest,
                envelope: randomBytes(4597),
            },
            area: {
                workspaceId: areaId,
                idSeed: areaSeed,
                quotaBytes: 1n << 30n,
                selfGrant: {
                    keyVersion: 1,
                    workspaceKeyVersion: 1,
                    wrappingSalt: randomBytes(32),
                    wrappingNonce: randomBytes(24),
                    encryptedKey: randomBytes(48),
                },
            },
            grants: [grant(head, areaId, creator.userId, creator.userId)],
            cache: { through: 1 },
        },
    };
}

async function person(): Promise<Account> {
    const account = await createTestAccount();
    await createTestIdentity(account.userId);
    return account;
}

/* A group `creator` made through the repository, with its head. */
async function created(creator: Account, kind: GroupKind = 'family', name?: string) {
    const made = creation(creator, kind, name);
    const result = await groups.createGroup(made.input);
    if (result.status !== 'created') throw new Error(`createGroup ${JSON.stringify(result)}`);
    return { groupId: made.groupId, areaId: made.areaId, head: result.head };
}
type Group = Awaited<ReturnType<typeof created>>;

/* An open invitation for `account` to `groupId`; its token's hash. */
async function invited(groupId: string, inviter: string, account: Account) {
    const tokenHash = randomBytes(32);
    const result = await groups.createInvitation({
        groupId,
        email: account.email,
        normalizedEmail: account.email,
        tokenHash,
        roles: [],
        invitedBy: inviter,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
    });
    if (result.status !== 'created') throw new Error(`createInvitation ${result.status}`);
    return tokenHash;
}

/* The roster that admits `userId` without roles, signed by `admin`, with the area's grant. */
function admission(group: Group, admin: string, userId: string) {
    const statement = Buffer.from(`roster 2 admit ${userId} to ${group.groupId}`);
    const next: Head = {
        ...group.head,
        rosterVersion: 2,
        rosterDigest: groups.statementDigest(statement),
    };
    return {
        groupId: group.groupId,
        uploaderUserId: admin,
        expectedRevision: group.head.revision,
        route: { kind: 'admit' as const, userId, seatLimitDefault: 6 },
        roster: {
            statement,
            ...signatures(),
            version: 2,
            previousDigest: group.head.rosterDigest,
            groupKeyVersion: 1,
            signerUserId: admin,
            signerMlDsaPublicKey: randomBytes(1952),
            changes: [{ userId, status: 'active', roles: [] }] as groups.EntryChange[],
            dropsHolder: false,
        } as groups.ParsedRoster,
        grants: [grant(next, group.areaId, userId, admin)],
        seals: [],
        cache: { through: 2 },
    };
}

async function stateIn(groupId: string, userId: string) {
    const [row] = await db
        .select({ state: groupMemberships.state })
        .from(groupMemberships)
        .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, userId)));
    return row?.state ?? null;
}

async function activeFamilies(userId: string) {
    return db
        .select({ groupId: groupMemberships.groupId })
        .from(groupMemberships)
        .where(
            and(
                eq(groupMemberships.userId, userId),
                eq(groupMemberships.groupKind, 'family'),
                eq(groupMemberships.state, 'active'),
            ),
        );
}

describe('creating a family', () => {
    test('is refused while the creator is in one, and writes nothing; after they leave, it works', async () => {
        const maya = await person();
        const first = await created(maya);
        const second = creation(maya, 'family', 'Ortega family');
        // Asked before the creation limit: with one family allowed per account, that limit
        // (here one) would otherwise answer first and say the wrong thing.
        expect(await groups.createGroup({ ...second.input, ownedLimit: 1 })).toEqual({
            status: 'in-family',
        });
        expect(
            await db.select().from(groupsTable).where(eq(groupsTable.id, second.groupId)),
        ).toEqual([]);
        // The last member leaving dissolves the first family: the account is personal again.
        expect(await groups.leaveGroup(first.groupId, maya.userId)).toEqual({
            status: 'dissolved',
        });
        expect((await groups.createGroup(second.input)).status).toBe('created');
        expect(await activeFamilies(maya.userId)).toEqual([{ groupId: second.groupId }]);
    });

    test('a resend of the same creation in flight is still a replay, not a second family', async () => {
        const maya = await person();
        const { input } = creation(maya);
        const results = await Promise.all([groups.createGroup(input), groups.createGroup(input)]);
        expect(results.map((result) => result.status).sort()).toEqual(['created', 'replayed']);
    });

    test('a family does not stop its member creating a company group, nor a company a family', async () => {
        const maya = await person();
        await created(maya);
        expect((await groups.createGroup(creation(maya, 'org', 'Ortega & Co').input)).status).toBe(
            'created',
        );
        const sam = await person();
        await created(sam, 'org', 'Berg & Co');
        expect((await groups.createGroup(creation(sam).input)).status).toBe('created');
    });
});

describe('accepting an invitation', () => {
    test('is refused while in another family, naming theirs, and leaves the invitation open', async () => {
        const maya = await person();
        const ortega = await created(maya, 'family', 'Ortega family');
        const sam = await person();
        const lindqvist = await created(sam, 'family', 'Lindqvist family');
        const token = await invited(ortega.groupId, maya.userId, sam);
        expect(await groups.acceptInvitation({ tokenHash: token, userId: sam.userId })).toEqual({
            status: 'in-family',
            family: { groupId: lindqvist.groupId, name: 'Lindqvist family' },
        });
        // Nothing in Ortega family's waiting list, and the link still works once Sam leaves.
        expect(await stateIn(ortega.groupId, sam.userId)).toBeNull();
        const [invitation] = await db
            .select({ state: groupInvitations.state })
            .from(groupInvitations)
            .where(eq(groupInvitations.tokenHash, token));
        expect(invitation!.state).toBe('open');
        expect(await groups.leaveGroup(lindqvist.groupId, sam.userId)).toEqual({
            status: 'dissolved',
        });
        expect(await groups.acceptInvitation({ tokenHash: token, userId: sam.userId })).toEqual({
            status: 'accepted',
            groupId: ortega.groupId,
        });
    });

    test('is allowed while only waiting to join another family, or while in a company', async () => {
        const maya = await person();
        const ortega = await created(maya, 'family', 'Ortega family');
        const ana = await person();
        const berg = await created(ana, 'family', 'Berg family');
        const sam = await person();
        await created(sam, 'org', 'Lindqvist & Co');
        expect(
            await groups.acceptInvitation({
                tokenHash: await invited(berg.groupId, ana.userId, sam),
                userId: sam.userId,
            }),
        ).toMatchObject({ status: 'accepted' });
        expect(
            await groups.acceptInvitation({
                tokenHash: await invited(ortega.groupId, maya.userId, sam),
                userId: sam.userId,
            }),
        ).toMatchObject({ status: 'accepted' });
    });
});

describe('letting someone in', () => {
    test('is refused once they are in another family, before the seat count, and changes nothing', async () => {
        const maya = await person();
        // Full: without the one-family check first, this would answer `seats` and hide why.
        const ortega = await created(maya, 'family', 'Ortega family');
        await db
            .update(groupsTable)
            .set({ seatLimit: 1 })
            .where(eq(groupsTable.id, ortega.groupId));
        const sam = await person();
        await groups.acceptInvitation({
            tokenHash: await invited(ortega.groupId, maya.userId, sam),
            userId: sam.userId,
        });
        // Since accepting, Sam made a family of their own.
        await created(sam, 'family', 'Lindqvist family');
        expect(await groups.waitingButInFamily(ortega.groupId, sam.userId)).toBe(true);
        expect(await groups.appendChain(admission(ortega, maya.userId, sam.userId))).toEqual({
            status: 'in-family',
        });
        expect(await stateIn(ortega.groupId, sam.userId)).toBe('accepted');
        const rosters = await db
            .select({ version: groupRosters.version })
            .from(groupRosters)
            .where(eq(groupRosters.groupId, ortega.groupId));
        expect(rosters).toEqual([{ version: 1 }]);
    });

    test('a company membership does not stop an admission to a family', async () => {
        const maya = await person();
        const ortega = await created(maya, 'family', 'Ortega family');
        const sam = await person();
        await groups.acceptInvitation({
            tokenHash: await invited(ortega.groupId, maya.userId, sam),
            userId: sam.userId,
        });
        await created(sam, 'org', 'Lindqvist & Co');
        expect(await groups.waitingButInFamily(ortega.groupId, sam.userId)).toBe(false);
        expect((await groups.appendChain(admission(ortega, maya.userId, sam.userId))).status).toBe(
            'ok',
        );
    });

    test('two families letting the same person in at once: exactly one admits them, the other is in-family', async () => {
        const maya = await person();
        const ortega = await created(maya, 'family', 'Ortega family');
        const ana = await person();
        const berg = await created(ana, 'family', 'Berg family');
        const sam = await person();
        // Two accepts at once both stand: waiting to join is not being in a family.
        const accepts = await Promise.all([
            groups.acceptInvitation({
                tokenHash: await invited(ortega.groupId, maya.userId, sam),
                userId: sam.userId,
            }),
            groups.acceptInvitation({
                tokenHash: await invited(berg.groupId, ana.userId, sam),
                userId: sam.userId,
            }),
        ]);
        expect(accepts.map((result) => result.status)).toEqual(['accepted', 'accepted']);

        /*
         * Both admissions must pass their check under their own group's lock before either
         * commits, or the second simply reads the first and the index is never reached. Sam's
         * account row, held here, stops each at its grant (whose foreign key reads it), after
         * the check; once both wait, it is let go.
         */
        const blocker = new Client({ connectionString: process.env.DATABASE_URL });
        await blocker.connect();
        try {
            await blocker.query('begin');
            await blocker.query('select id from users where id = $1 for update', [sam.userId]);
            const racing = Promise.all([
                groups.appendChain(admission(ortega, maya.userId, sam.userId)),
                groups.appendChain(admission(berg, ana.userId, sam.userId)),
            ]);
            for (let waited = 0; waited < 100; waited++) {
                const { rows } = await blocker.query<{ waiting: number }>(
                    `select count(*)::int as waiting from pg_stat_activity
                     where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
                );
                if (rows[0]!.waiting >= 2) break;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            await blocker.query('commit');
            const results = await racing;
            expect(results.map((result) => result.status).sort()).toEqual(['in-family', 'ok']);
        } finally {
            await blocker.end();
        }
        expect(await activeFamilies(sam.userId)).toHaveLength(1);
        const states = [
            await stateIn(ortega.groupId, sam.userId),
            await stateIn(berg.groupId, sam.userId),
        ];
        expect(new Set(states)).toEqual(new Set(['accepted', 'active']));
    });
});

describe('the one-family index', () => {
    test('refuses a second active family membership written past the repository, and only that', async () => {
        const maya = await person();
        const { groupId: ortega } = await createTestFamily({ organizerId: maya.userId });
        const sam = await person();
        const { groupId: lindqvist } = await createTestFamily({ organizerId: sam.userId });
        const row = {
            groupId: ortega,
            groupKind: 'family' as const,
            userId: sam.userId,
            roles: [],
            admittedAt: new Date(),
        };
        // Waiting, or gone, sit beside a family; active does not.
        await db.insert(groupMemberships).values({ ...row, state: 'accepted' });
        await db
            .update(groupMemberships)
            .set({ state: 'left', leftAt: new Date() })
            .where(
                and(eq(groupMemberships.groupId, ortega), eq(groupMemberships.userId, sam.userId)),
            );
        const activate = db
            .update(groupMemberships)
            .set({ state: 'active', leftAt: null })
            .where(
                and(eq(groupMemberships.groupId, ortega), eq(groupMemberships.userId, sam.userId)),
            );
        await expect(activate).rejects.toMatchObject({
            cause: { code: '23505', constraint: 'group_memberships_one_family_idx' },
        });
        // A row can't claim a kind its group doesn't have.
        const company = { ...row, groupKind: 'org' as const, state: 'active' as const };
        const stranger = (await person()).userId;
        await expect(
            db.insert(groupMemberships).values({ ...company, userId: stranger }),
        ).rejects.toMatchObject({
            cause: { code: '23503', constraint: 'group_memberships_group_kind_fk' },
        });
        // In a company group, active beside a family is fine.
        const [org] = await db
            .insert(groupsTable)
            .values({
                id: scopedId('group', maya.userId, seed())!,
                idSeed: seed(),
                kind: 'org',
                name: 'Ortega & Co',
                creatorUserId: maya.userId,
                firstEd25519PublicKey: randomBytes(32),
                firstMlDsaPublicKey: randomBytes(1952),
                rosterVersion: 1,
                rosterDigest: randomBytes(32),
                groupKeyVersion: 1,
            })
            .returning({ id: groupsTable.id });
        await db.insert(groupMemberships).values({ ...company, groupId: org!.id });
        expect(await activeFamilies(sam.userId)).toEqual([{ groupId: lindqvist }]);
    });
});

describe('the migration', () => {
    const folder = readdirSync(new URL('../drizzle/', import.meta.url)).find((name) =>
        /^\d{14}_one_family$/.test(name),
    )!;
    const statements = readFileSync(
        new URL(`../drizzle/${folder}/migration.sql`, import.meta.url),
        'utf8',
    )
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean);

    /*
     * Runs the migration on the schema as it was before it, inside one transaction that is
     * always rolled back: `seed` writes the old shape (no group_kind) first. Answers the error
     * the run stopped with, or null and what `inspect` read after it ran.
     */
    async function migrateFromBefore<T>(
        seed: (client: Client) => Promise<void>,
        inspect: (client: Client) => Promise<T>,
    ) {
        const client = new Client({ connectionString: process.env.DATABASE_URL });
        await client.connect();
        try {
            await client.query('begin');
            await client.query('drop index group_memberships_one_family_idx');
            await client.query(
                'alter table group_memberships drop constraint group_memberships_group_kind_fk',
            );
            await client.query('alter table group_memberships drop column group_kind');
            await client.query('alter table groups drop constraint groups_id_kind');
            await seed(client);
            try {
                for (const statement of statements) await client.query(statement);
            } catch (error) {
                return { error: error as Error & { hint?: string }, after: null };
            }
            return { error: null, after: await inspect(client) };
        } finally {
            await client.query('rollback').catch(() => undefined);
            await client.end();
        }
    }

    const join = (client: Client, groupId: string, userId: string, state: string) =>
        client.query(
            `insert into group_memberships (group_id, user_id, state, roles, accepted_at, admitted_at, left_at)
             values ($1, $2, $3, '{}', now(), case when $3 = 'accepted' then null else now() end,
                     case when $3 in ('left', 'removed') then now() else null end)`,
            [groupId, userId, state],
        );

    test('stops, naming the count and where to read on, when an account is active in two families', async () => {
        const maya = await person();
        const { groupId: ortega } = await createTestFamily({ organizerId: maya.userId });
        const sam = await person();
        await createTestFamily({ organizerId: sam.userId });
        const { error } = await migrateFromBefore(
            async (client) => {
                await join(client, ortega, sam.userId, 'active');
            },
            async () => null,
        );
        expect(error?.message).toMatch(/^HushOS: 1 account\(s\) are in more than one family/);
        expect(error?.hint).toContain('docs/self-hosting.md');
        expect(error?.hint).toContain('having count(*) > 1');
    });

    test('runs when nobody is in two families, copying each group’s kind onto its memberships', async () => {
        const maya = await person();
        const { groupId: ortega } = await createTestFamily({ organizerId: maya.userId });
        const { groupId: former } = await createTestFamily({
            organizerId: (await person()).userId,
        });
        const { groupId: company } = await createTestFamily({
            organizerId: (await person()).userId,
        });
        const sam = await person();
        const { groupId: lindqvist } = await createTestFamily({ organizerId: sam.userId });
        const { error, after } = await migrateFromBefore(
            async (client) => {
                // Sam: active in one family, waiting for another, gone from a third, in a company.
                await client.query(`update groups set kind = 'org' where id = $1`, [company]);
                await join(client, ortega, sam.userId, 'accepted');
                await join(client, former, sam.userId, 'left');
                await join(client, company, sam.userId, 'active');
            },
            async (client) => {
                const { rows } = await client.query<{ group_id: string; group_kind: string }>(
                    'select group_id, group_kind from group_memberships where user_id = $1 order by group_kind, state',
                    [sam.userId],
                );
                const { rows: index } = await client.query(
                    `select 1 from pg_indexes where indexname = 'group_memberships_one_family_idx'`,
                );
                return { rows, indexed: index.length === 1 };
            },
        );
        expect(error).toBeNull();
        expect(after).toEqual({
            rows: [
                { group_id: ortega, group_kind: 'family' }, // accepted
                { group_id: lindqvist, group_kind: 'family' }, // active
                { group_id: former, group_kind: 'family' }, // left
                { group_id: company, group_kind: 'org' }, // active
            ],
            indexed: true,
        });
    });
});
