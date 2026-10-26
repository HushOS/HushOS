import { groupsEnv } from '@hushos/env/groups';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { db } from './client';
import type { Tx } from './drive';
import {
    groupDissolveNotices,
    groupInvitations,
    groupMemberships,
    groups,
    users,
    workspaces,
    type DissolveNoticeKind,
} from './schema';

/*
 * The emails a family's dissolving owes (docs/groups-design.md 3.3). The last
 * member is told the family is gone and when its folders are deleted; whoever
 * was still joining it (accepted and not let in, or holding an invitation still
 * open) is told it no longer exists. Nobody else: a dissolved family has no
 * other active member, and its payer has the plan-ending email of its own.
 */

/*
 * In the transaction that dissolves `groupId` (depart, under the group's lock):
 * every acceptance not let in is ended (`removed`, as a manager turning it down
 * ends one) and every invitation still open is revoked, so nothing about the
 * family stays pending; then, with families served, one email is owed to the
 * last member and to each of those people. A person is owed one email however
 * they were joining: an invitation to an address the last member or someone
 * accepted already holds is closed without one of its own. The rows roll back
 * with the leave that wrote them, so a leave refused or previewed owes nothing.
 */
export async function recordDissolveNotices(
    tx: Tx,
    groupId: string,
    lastUserId: string,
    now: Date,
) {
    const accepted = await tx
        .update(groupMemberships)
        .set({ state: 'removed', leftAt: now, updatedAt: now })
        .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.state, 'accepted')))
        .returning({ userId: groupMemberships.userId });
    // One already past its expiry is left for the cleanup job to mark expired: it invited no one.
    const invited = await tx
        .update(groupInvitations)
        .set({ state: 'revoked', updatedAt: now })
        .where(
            and(
                eq(groupInvitations.groupId, groupId),
                eq(groupInvitations.state, 'open'),
                gt(groupInvitations.expiresAt, now),
            ),
        )
        .returning({ id: groupInvitations.id, normalizedEmail: groupInvitations.normalizedEmail });
    // GROUPS_ENABLED=false (hushos.com until families launch): nobody is emailed about a family.
    if (!groupsEnv.GROUPS_ENABLED) return;
    const accounts = [lastUserId, ...accepted.map((row) => row.userId)];
    const held = new Set(
        (
            await tx
                .select({ normalizedEmail: users.normalizedEmail })
                .from(users)
                .where(inArray(users.id, accounts))
        ).map((row) => row.normalizedEmail),
    );
    const owed: (typeof groupDissolveNotices.$inferInsert)[] = [
        { groupId, kind: 'dissolved', userId: lastUserId },
        ...accepted.map((row) => ({ groupId, kind: 'accepted' as const, userId: row.userId })),
        ...invited
            .filter((row) => row.normalizedEmail && !held.has(row.normalizedEmail))
            .map((row) => ({ groupId, kind: 'invited' as const, invitationId: row.id })),
    ];
    await tx.insert(groupDissolveNotices).values(owed).onConflictDoNothing();
}

export type DissolveNotice = {
    id: string;
    kind: DissolveNoticeKind;
    email: string;
    /* The family's name, as its organiser typed it. */
    groupName: string;
    dissolvedAt: Date;
    /*
     * When Drive's purge takes the last of the family's folders: the latest time one was
     * deleted (dissolving retires every live one at that instant) plus the retention the
     * purge is given. A folder an open or held report names waits for the report.
     */
    foldersDeletedAt: Date;
};

/*
 * Sends what is owed, oldest first, at most `limit` a run, through `send`. Each
 * email is claimed before it is handed over, by a conditional update only one
 * run can win, so two runs at once, or a job retried after it sent, never send
 * one twice; a crash between the claim and the send loses that email rather
 * than repeating it. A send that throws gives its claim back for the next run
 * and stops this one (the provider is down or unconfigured, so the rest would
 * fail too). One whose account or address is gone is dropped. Emails owed more
 * than `maxAgeDays` ago are no longer news and are left unsent; the family's
 * purge deletes them with it.
 */
export async function deliverDissolveNotices(input: {
    folderRetentionDays: number;
    send: (notice: DissolveNotice) => Promise<void>;
    limit?: number;
    maxAgeDays?: number;
}) {
    const outcome = { sent: 0, dropped: 0, failure: undefined as unknown };
    const due = await db
        .select({ id: groupDissolveNotices.id })
        .from(groupDissolveNotices)
        .where(
            and(
                isNull(groupDissolveNotices.sentAt),
                sql`${groupDissolveNotices.createdAt} > now() - make_interval(days => ${input.maxAgeDays ?? 7})`,
            ),
        )
        .orderBy(asc(groupDissolveNotices.createdAt))
        .limit(input.limit ?? 100);
    for (const { id } of due) {
        const [claimed] = await db
            .update(groupDissolveNotices)
            .set({ sentAt: sql`now()` })
            .where(and(eq(groupDissolveNotices.id, id), isNull(groupDissolveNotices.sentAt)))
            .returning({ id: groupDissolveNotices.id });
        // Another run claimed it first.
        if (!claimed) continue;
        const notice = await readNotice(id, input.folderRetentionDays);
        if (!notice) {
            outcome.dropped++;
            continue;
        }
        try {
            await input.send(notice);
            outcome.sent++;
        } catch (error) {
            await db
                .update(groupDissolveNotices)
                .set({ sentAt: null })
                .where(eq(groupDissolveNotices.id, id));
            outcome.failure = error;
            break;
        }
    }
    return outcome;
}

async function readNotice(id: string, folderRetentionDays: number): Promise<DissolveNotice | null> {
    const lastDeleted = sql`(select max(${workspaces.deletedAt}) from ${workspaces} where ${workspaces.groupId} = ${groups.id})`;
    const [row] = await db
        .select({
            id: groupDissolveNotices.id,
            kind: groupDissolveNotices.kind,
            email: sql<string | null>`coalesce(${users.email}, ${groupInvitations.email})`,
            groupName: groups.name,
            dissolvedAt: groups.dissolvedAt,
            foldersDeletedAt:
                sql<Date>`coalesce(${lastDeleted}, ${groups.dissolvedAt}) + make_interval(days => ${folderRetentionDays})`.mapWith(
                    groups.dissolvedAt,
                ),
        })
        .from(groupDissolveNotices)
        .innerJoin(groups, eq(groups.id, groupDissolveNotices.groupId))
        .leftJoin(users, eq(users.id, groupDissolveNotices.userId))
        .leftJoin(groupInvitations, eq(groupInvitations.id, groupDissolveNotices.invitationId))
        .where(eq(groupDissolveNotices.id, id));
    if (!row?.email || !row.dissolvedAt) return null;
    return { ...row, email: row.email, dissolvedAt: row.dissolvedAt };
}
