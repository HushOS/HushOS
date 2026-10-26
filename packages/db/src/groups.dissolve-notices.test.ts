import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import type { GroupSubscriptionSnapshot } from './billing';
import type { DissolveNotice } from './groups';

// A plan still paid for refuses the last member's leave: that rule reads billing, off with `none`.
process.env.BILLING_PROVIDER = 'polar';

const { closeDatabase, createTestAccount, createTestFamily, resetDatabase, setTestMember } =
    await import('../test/helpers');
const billing = await import('./billing');
const { db } = await import('./client');
const groups = await import('./groups');
const s = await import('./schema');

/*
 * The emails a family's dissolving owes (docs/groups-design.md 3.3): the last
 * member, everyone who accepted and was not let in, and every invitation still
 * open, each once, and nobody else; owed only by a leave that commits; sent
 * once however many runs and retries; dated by the rule Drive's purge deletes
 * the folders by.
 */

beforeEach(resetDatabase);
afterAll(closeDatabase);

const DAY = 24 * 60 * 60 * 1000;
// What drive.purge gives purgeDeletedAreas (TRASH_RETENTION_DAYS) and the worker gives the notices.
const RETENTION = 30;

async function invite(groupId: string, inviter: string, email: string, expiresAt?: Date) {
    const made = await groups.createInvitation({
        groupId,
        email,
        normalizedEmail: email,
        tokenHash: randomBytes(32),
        roles: [],
        invitedBy: inviter,
        expiresAt: expiresAt ?? new Date(Date.now() + 7 * DAY),
    });
    if (made.status !== 'created') throw new Error(`invite ${made.status}`);
    return made.id;
}

/* An invitation still marked open whose week ran out (the cleanup job has not marked it yet). */
async function lapsedInvitation(groupId: string, inviter: string, email: string) {
    const [row] = await db
        .insert(s.groupInvitations)
        .values({
            groupId,
            email,
            normalizedEmail: email,
            tokenHash: randomBytes(32),
            invitedBy: inviter,
            state: 'open',
            createdAt: new Date(Date.now() - 8 * DAY),
            expiresAt: new Date(Date.now() - DAY),
        })
        .returning({ id: s.groupInvitations.id });
    return row!.id;
}

async function owed(groupId?: string) {
    const rows = await db
        .select({
            kind: s.groupDissolveNotices.kind,
            userId: s.groupDissolveNotices.userId,
            invitationId: s.groupDissolveNotices.invitationId,
        })
        .from(s.groupDissolveNotices)
        .where(groupId ? eq(s.groupDissolveNotices.groupId, groupId) : undefined);
    return rows.sort((a, b) =>
        `${a.kind}${a.userId}${a.invitationId}`.localeCompare(
            `${b.kind}${b.userId}${b.invitationId}`,
        ),
    );
}

async function invitationStates(ids: string[]) {
    const rows = await db
        .select({ id: s.groupInvitations.id, state: s.groupInvitations.state })
        .from(s.groupInvitations)
        .where(inArray(s.groupInvitations.id, ids));
    return Object.fromEntries(rows.map((row) => [row.id, row.state]));
}

async function membershipState(groupId: string, userId: string) {
    const [row] = await db
        .select({ state: s.groupMemberships.state })
        .from(s.groupMemberships)
        .where(and(eq(s.groupMemberships.groupId, groupId), eq(s.groupMemberships.userId, userId)));
    return row?.state;
}

/* Every notice sent by one run, as the worker's job sends them. */
async function deliver(
    send: (notice: DissolveNotice) => Promise<void> = async () => {},
    sent: DissolveNotice[] = [],
) {
    const outcome = await groups.deliverDissolveNotices({
        folderRetentionDays: RETENTION,
        send: async (notice) => {
            await send(notice);
            sent.push(notice);
        },
    });
    return { ...outcome, notices: sent };
}

/*
 * A family at the moment its last member leaves: the organizer still in, a member
 * who left earlier and one a manager turned down, someone accepted and waiting,
 * an invitation open, one whose week ran out and one cancelled. Beside it another
 * family with someone waiting and an invitation of its own.
 */
async function familyAboutToDissolve() {
    const organizer = await createTestAccount();
    const left = await createTestAccount();
    const turnedDown = await createTestAccount();
    const waiting = await createTestAccount();
    const family = await createTestFamily({ organizerId: organizer.userId });
    await setTestMember({ groupId: family.groupId, userId: left.userId, state: 'left' });
    await setTestMember({ groupId: family.groupId, userId: turnedDown.userId, state: 'accepted' });
    expect(
        await groups.declinePending({
            groupId: family.groupId,
            holderUserId: organizer.userId,
            userId: turnedDown.userId,
        }),
    ).toEqual({ status: 'declined' });
    await setTestMember({ groupId: family.groupId, userId: waiting.userId, state: 'accepted' });
    const open = await invite(family.groupId, organizer.userId, 'sam@hushos.test');
    const lapsed = await lapsedInvitation(family.groupId, organizer.userId, 'kim@hushos.test');
    const cancelled = await invite(family.groupId, organizer.userId, 'lee@hushos.test');
    expect(await groups.revokeInvitation(family.groupId, cancelled)).toBe('revoked');

    const neighbour = await createTestAccount();
    const neighbourWaiting = await createTestAccount();
    const other = await createTestFamily({ organizerId: neighbour.userId });
    await setTestMember({
        groupId: other.groupId,
        userId: neighbourWaiting.userId,
        state: 'accepted',
    });
    const otherOpen = await invite(other.groupId, neighbour.userId, 'ana@hushos.test');
    return {
        ...family,
        organizer,
        left,
        turnedDown,
        waiting,
        open,
        lapsed,
        cancelled,
        other: { ...other, waiting: neighbourWaiting, open: otherOpen },
    };
}

function plan(): GroupSubscriptionSnapshot {
    return {
        paidTier: { productId: 'prod_family', quotaBytes: 100n },
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
        includedMembers: 6,
        quotaBytes: 100n,
        currentPeriodStart: new Date(Date.now() - DAY),
        currentPeriodEnd: new Date(Date.now() + 29 * DAY),
        cancelAtPeriodEnd: false,
        endedAt: null,
    };
}

describe('who a dissolving owes an email', () => {
    test('the last member, whoever was waiting and every open invitation, once each, and nobody else', async () => {
        const f = await familyAboutToDissolve();
        expect(await groups.leaveGroup(f.groupId, f.organizer.userId)).toEqual({
            status: 'dissolved',
        });
        expect(await owed()).toEqual(
            [
                { kind: 'accepted', userId: f.waiting.userId, invitationId: null },
                { kind: 'dissolved', userId: f.organizer.userId, invitationId: null },
                { kind: 'invited', userId: null, invitationId: f.open },
            ].sort((a, b) =>
                `${a.kind}${a.userId}${a.invitationId}`.localeCompare(
                    `${b.kind}${b.userId}${b.invitationId}`,
                ),
            ),
        );
        // Nothing about the family stays pending: the wait is ended, the open invitation closed.
        expect(await membershipState(f.groupId, f.waiting.userId)).toBe('removed');
        expect(await invitationStates([f.open, f.lapsed, f.cancelled])).toEqual({
            [f.open]: 'revoked',
            // Its week ran out before the family went: nobody was still invited by it.
            [f.lapsed]: 'open',
            [f.cancelled]: 'revoked',
        });
        // The family beside it is untouched.
        expect(await membershipState(f.other.groupId, f.other.waiting.userId)).toBe('accepted');
        expect(await invitationStates([f.other.open])).toEqual({ [f.other.open]: 'open' });

        const { notices } = await deliver();
        expect(
            notices
                .map((notice) => [notice.kind, notice.email, notice.groupName])
                .sort(([a], [b]) => a!.localeCompare(b!)),
        ).toEqual([
            ['accepted', f.waiting.email, 'The Family'],
            ['dissolved', f.organizer.email, 'The Family'],
            ['invited', 'sam@hushos.test', 'The Family'],
        ]);
    });

    test('an address that is already owed one is not owed a second through an invitation', async () => {
        const organizer = await createTestAccount();
        const waiting = await createTestAccount();
        const family = await createTestFamily({ organizerId: organizer.userId });
        await setTestMember({ groupId: family.groupId, userId: waiting.userId, state: 'accepted' });
        // An invitation to an address already waiting, as a resent one from before the check was.
        await db.insert(s.groupInvitations).values({
            groupId: family.groupId,
            email: waiting.email,
            normalizedEmail: waiting.email,
            tokenHash: randomBytes(32),
            invitedBy: organizer.userId,
            expiresAt: new Date(Date.now() + 7 * DAY),
        });
        expect(await groups.leaveGroup(family.groupId, organizer.userId)).toEqual({
            status: 'dissolved',
        });
        const { notices } = await deliver();
        expect(notices.map((notice) => notice.email).sort()).toEqual(
            [organizer.email, waiting.email].sort(),
        );
    });

    test('a leave that does not dissolve the family owes nothing', async () => {
        const organizer = await createTestAccount();
        const member = await createTestAccount();
        const waiting = await createTestAccount();
        const family = await createTestFamily({
            organizerId: organizer.userId,
            members: [{ userId: member.userId }],
        });
        await setTestMember({ groupId: family.groupId, userId: waiting.userId, state: 'accepted' });
        const open = await invite(family.groupId, organizer.userId, 'sam@hushos.test');
        expect(await groups.leaveGroup(family.groupId, member.userId)).toEqual({ status: 'left' });
        // Someone waiting who withdraws is not the family dissolving either.
        expect(await groups.leaveGroup(family.groupId, waiting.userId)).toEqual({ status: 'left' });
        expect(await owed()).toEqual([]);
        expect(await invitationStates([open])).toEqual({ [open]: 'open' });
    });

    test('the last member deleting their account owes nothing to them, and still tells the rest', async () => {
        const organizer = await createTestAccount();
        const waiting = await createTestAccount();
        const family = await createTestFamily({ organizerId: organizer.userId });
        await setTestMember({ groupId: family.groupId, userId: waiting.userId, state: 'accepted' });
        const open = await invite(family.groupId, organizer.userId, 'sam@hushos.test');
        // As deleteAccount does it: every group departed, then the account row, in one transaction.
        await db.transaction(async (tx) => {
            expect(await groups.departAllForDeletion(tx, organizer.userId)).toEqual({
                status: 'ok',
            });
            await tx.delete(s.users).where(eq(s.users.id, organizer.userId));
        });
        expect(await owed(family.groupId)).toEqual(
            [
                { kind: 'accepted', userId: waiting.userId, invitationId: null },
                { kind: 'invited', userId: null, invitationId: open },
            ].sort((a, b) => a.kind.localeCompare(b.kind)),
        );
    });
});

describe('a departure that is refused or rolled back', () => {
    test('the last member of a family still paid for is refused, and nobody is owed or turned away', async () => {
        const organizer = await createTestAccount();
        const waiting = await createTestAccount();
        const family = await createTestFamily({ organizerId: organizer.userId, pooled: true });
        await setTestMember({ groupId: family.groupId, userId: waiting.userId, state: 'accepted' });
        const open = await invite(family.groupId, organizer.userId, 'sam@hushos.test');
        await billing.applyGroupState({
            groupId: family.groupId,
            provider: 'polar',
            customerId: 'cus_team',
            subscriptions: [plan()],
            graceMs: 3 * DAY,
        });
        expect(await groups.leaveGroup(family.groupId, organizer.userId)).toEqual({
            status: 'billed',
        });
        expect(await owed()).toEqual([]);
        expect(await membershipState(family.groupId, waiting.userId)).toBe('accepted');
        expect(await invitationStates([open])).toEqual({ [open]: 'open' });
        expect((await deliver()).notices).toEqual([]);
    });

    test('the preview of a leave that would dissolve the family owes nothing and closes nothing', async () => {
        const f = await familyAboutToDissolve();
        expect(await groups.previewLeave(f.groupId, f.organizer.userId)).toEqual({
            status: 'dissolved',
        });
        expect(await owed()).toEqual([]);
        expect(await membershipState(f.groupId, f.waiting.userId)).toBe('accepted');
        expect(await invitationStates([f.open])).toEqual({ [f.open]: 'open' });
        expect((await groups.getGroupRow(f.groupId))?.dissolvedAt).toBeNull();
        expect((await deliver()).notices).toEqual([]);
    });

    test('an account deletion refused by a later group rolls back the dissolving of a family', async () => {
        const person = await createTestAccount();
        const other = await createTestAccount();
        const family = await createTestFamily({ organizerId: person.userId });
        // A company (one account may be in a family and any number of them) after it in id
        // order, where they hold the only `billing` and someone else stays: departAllForDeletion
        // dissolves the family first, then is refused there, and deleteAccount rolls back.
        const company = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
        await db.insert(s.groups).values({
            id: company,
            idSeed: randomBytes(16).toString('base64url'),
            kind: 'org',
            name: 'The Company',
            creatorUserId: person.userId,
            firstEd25519PublicKey: randomBytes(32),
            firstMlDsaPublicKey: randomBytes(1952),
            rosterVersion: 1,
            rosterDigest: randomBytes(32),
            groupKeyVersion: 1,
        });
        await db.insert(s.groupMemberships).values([
            {
                groupId: company,
                groupKind: 'org',
                userId: person.userId,
                state: 'active',
                roles: ['billing', 'members'],
                admittedAt: new Date(),
            },
            {
                groupId: company,
                groupKind: 'org',
                userId: other.userId,
                state: 'active',
                roles: [],
                admittedAt: new Date(),
            },
        ]);
        const open = await invite(family.groupId, person.userId, 'sam@hushos.test');
        class Holder extends Error {}
        await expect(
            db.transaction(async (tx) => {
                const result = await groups.departAllForDeletion(tx, person.userId);
                expect(result).toEqual({ status: 'organizer', groupId: company });
                throw new Holder();
            }),
        ).rejects.toBeInstanceOf(Holder);
        expect(await owed()).toEqual([]);
        expect(await invitationStates([open])).toEqual({ [open]: 'open' });
        expect((await groups.getGroupRow(family.groupId))?.dissolvedAt).toBeNull();
        expect((await deliver()).notices).toEqual([]);
    });
});

describe('sending what is owed', () => {
    test('a second run, a retry and a run started while one is sending send nothing twice', async () => {
        const f = await familyAboutToDissolve();
        await groups.leaveGroup(f.groupId, f.organizer.userId);
        const sent: DissolveNotice[] = [];
        let nested: Awaited<ReturnType<typeof deliver>> | undefined;
        // While the first run is handing over its first email, a second run starts and finishes.
        const first = await deliver(async () => {
            nested ??= await deliver(async () => {}, sent);
        }, sent);
        expect(sent.map((notice) => notice.email).sort()).toEqual(
            [f.organizer.email, f.waiting.email, 'sam@hushos.test'].sort(),
        );
        // The first run sent the one it held; the second took the other two.
        expect([first.sent, nested!.sent]).toEqual([1, 2]);
        // The job retried, or the next minute's run: nothing is left to send.
        expect((await deliver()).notices).toEqual([]);
    });

    test('a send that fails gives its email back for the next run and stops this one', async () => {
        const f = await familyAboutToDissolve();
        await groups.leaveGroup(f.groupId, f.organizer.userId);
        const refused = new Error('provider down');
        const failed = await deliver(async () => {
            throw refused;
        });
        expect(failed).toMatchObject({ sent: 0, notices: [], failure: refused });
        const next = await deliver();
        expect(next.notices.map((notice) => notice.email).sort()).toEqual(
            [f.organizer.email, f.waiting.email, 'sam@hushos.test'].sort(),
        );
        expect((await deliver()).notices).toEqual([]);
    });

    test('one whose account went before it was sent is dropped, and a week-old one is left unsent', async () => {
        const f = await familyAboutToDissolve();
        await groups.leaveGroup(f.groupId, f.organizer.userId);
        await db.delete(s.users).where(eq(s.users.id, f.waiting.userId));
        await db
            .update(s.groupDissolveNotices)
            .set({ createdAt: sql`now() - interval '8 days'` })
            .where(eq(s.groupDissolveNotices.invitationId, f.open));
        const { notices } = await deliver();
        expect(notices.map((notice) => notice.email)).toEqual([f.organizer.email]);
    });
});

describe('the date the last member is given', () => {
    /* Moves the clock `ms` on: the family's dissolving and every folder's deletion that long earlier. */
    async function later(groupId: string, ms: number) {
        const by = sql`make_interval(secs => ${ms / 1000})`;
        await db
            .update(s.groups)
            .set({ dissolvedAt: sql`${s.groups.dissolvedAt} - ${by}` })
            .where(eq(s.groups.id, groupId));
        await db
            .update(s.workspaces)
            .set({ deletedAt: sql`${s.workspaces.deletedAt} - ${by}` })
            .where(eq(s.workspaces.groupId, groupId));
    }
    /* The date the last member's email gives, as a run would send it now. */
    async function noticeDate() {
        await db.update(s.groupDissolveNotices).set({ sentAt: null });
        const { notices } = await deliver();
        return notices.find((notice) => notice.kind === 'dissolved')!.foldersDeletedAt;
    }
    async function live(groupId: string) {
        return (
            await db
                .select({ id: s.workspaces.id })
                .from(s.workspaces)
                .where(eq(s.workspaces.groupId, groupId))
        ).map((row) => row.id);
    }

    test('is the moment Drive’s purge takes the last of the family’s folders', async () => {
        const organizer = await createTestAccount();
        const family = await createTestFamily({ organizerId: organizer.userId, areas: 2 });
        const [early, last] = family.areaIds as [string, string];
        // One folder was deleted ten days before the family went: it goes ten days sooner.
        await db
            .update(s.workspaces)
            .set({ deletedAt: new Date(Date.now() - 10 * DAY) })
            .where(eq(s.workspaces.id, early));
        expect(await groups.leaveGroup(family.groupId, organizer.userId)).toEqual({
            status: 'dissolved',
        });

        // A minute before the date the last folder is still there.
        await later(family.groupId, RETENTION * DAY - 60_000);
        const before = await noticeDate();
        expect(before.getTime()).toBeGreaterThan(Date.now());
        expect(before.getTime() - Date.now()).toBeLessThan(2 * 60_000);
        await groups.purgeDeletedAreas(RETENTION);
        expect(await live(family.groupId)).toEqual([last]);

        // A minute after it, the purge takes it.
        await later(family.groupId, 2 * 60_000);
        const after = await noticeDate();
        expect(after.getTime()).toBeLessThan(Date.now());
        await groups.purgeDeletedAreas(RETENTION);
        expect(await live(family.groupId)).toEqual([]);
    });

    test('is the retention from the moment it was dissolved, for a family just dissolved', async () => {
        const organizer = await createTestAccount();
        const family = await createTestFamily({ organizerId: organizer.userId });
        await groups.leaveGroup(family.groupId, organizer.userId);
        const dissolvedAt = (await groups.getGroupRow(family.groupId))!.dissolvedAt!;
        const { notices } = await deliver();
        expect(notices).toHaveLength(1);
        expect(notices[0]!.dissolvedAt).toEqual(dissolvedAt);
        expect(notices[0]!.foldersDeletedAt).toEqual(
            new Date(dissolvedAt.getTime() + RETENTION * DAY),
        );
    });
});
