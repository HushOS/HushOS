import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, expect, test } from 'vitest';

// hushos.com until families launch: read once, when the settings load.
process.env.GROUPS_ENABLED = 'false';

const { closeDatabase, createTestAccount, createTestFamily, resetDatabase, setTestMember } =
    await import('../test/helpers');
const { db } = await import('./client');
const groups = await import('./groups');
const s = await import('./schema');

beforeEach(resetDatabase);
afterAll(closeDatabase);

/*
 * With families off nobody is emailed about a family, though a family made while
 * they were on (or a test one) can still dissolve when its last member deletes
 * their account. What was still pending is closed all the same.
 */
test('with families off a dissolving owes nobody an email, and still closes what was pending', async () => {
    const organizer = await createTestAccount();
    const waiting = await createTestAccount();
    const family = await createTestFamily({ organizerId: organizer.userId });
    await setTestMember({ groupId: family.groupId, userId: waiting.userId, state: 'accepted' });
    const made = await groups.createInvitation({
        groupId: family.groupId,
        email: 'sam@hushos.test',
        normalizedEmail: 'sam@hushos.test',
        tokenHash: randomBytes(32),
        roles: [],
        invitedBy: organizer.userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    if (made.status !== 'created') throw new Error(made.status);
    expect(await groups.leaveGroup(family.groupId, organizer.userId)).toEqual({
        status: 'dissolved',
    });
    expect(await db.select().from(s.groupDissolveNotices)).toEqual([]);
    const [invitation] = await db
        .select({ state: s.groupInvitations.state })
        .from(s.groupInvitations)
        .where(eq(s.groupInvitations.id, made.id));
    expect(invitation?.state).toBe('revoked');
    const sent: string[] = [];
    await groups.deliverDissolveNotices({
        folderRetentionDays: 30,
        send: async (notice) => {
            sent.push(notice.email);
        },
    });
    expect(sent).toEqual([]);
});
