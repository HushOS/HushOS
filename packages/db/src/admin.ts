import { and, asc, count, desc, eq, ilike, isNull, or, sql, sum, type SQL } from 'drizzle-orm';
import { db } from './client';
import {
    driveObjectDeletions,
    driveObjects,
    driveReports,
    personalWorkspaces,
    sessions,
    storageEntitlements,
    users,
    workspaceStorage,
    workspaces,
} from './schema';

/*
 * What an operator sees: counts and bytes, never names or content. The store
 * audit's findings surface here so a lost object is the operator's discovery
 * before it is a customer's.
 */
export async function getOverview() {
    const [people] = await db
        .select({
            total: count(),
            admins: sql<number>`count(*) filter (where ${users.role} = 'admin')`.mapWith(Number),
        })
        .from(users);
    const [space] = await db
        .select({ total: count(), usedBytes: sum(workspaceStorage.usedBytes) })
        .from(workspaces)
        .leftJoin(workspaceStorage, eq(workspaceStorage.workspaceId, workspaces.id));
    const [objects] = await db
        .select({
            total: count(),
            ready: sql<number>`count(*) filter (where ${driveObjects.status} = 'ready')`.mapWith(
                Number,
            ),
            missing:
                sql<number>`count(*) filter (where ${driveObjects.status} = 'missing')`.mapWith(
                    Number,
                ),
            pending:
                sql<number>`count(*) filter (where ${driveObjects.status} = 'pending')`.mapWith(
                    Number,
                ),
            unreplicated:
                sql<number>`count(*) filter (where ${driveObjects.status} = 'ready' and ${driveObjects.replicatedAt} is null)`.mapWith(
                    Number,
                ),
            cold: sql<number>`count(*) filter (where ${driveObjects.storageClass} = 'cold')`.mapWith(
                Number,
            ),
            bytes: sql<string>`coalesce(sum(${driveObjects.ciphertextSize}) filter (where ${driveObjects.status} = 'ready'), 0)::text`,
            lastAuditedAt: sql<Date | null>`max(${driveObjects.auditedAt})`,
        })
        .from(driveObjects);
    const [outbox] = await db
        .select({ pending: count() })
        .from(driveObjectDeletions)
        .where(isNull(driveObjectDeletions.doneAt));
    const [reports] = await db
        .select({
            open: sql<number>`count(*) filter (where ${driveReports.status} = 'open')`.mapWith(
                Number,
            ),
            held: sql<number>`count(*) filter (where ${driveReports.heldAt} is not null)`.mapWith(
                Number,
            ),
        })
        .from(driveReports);
    const missing = await db
        .select({
            objectId: driveObjects.id,
            workspaceId: driveObjects.workspaceId,
            ciphertextSize: driveObjects.ciphertextSize,
            replicatedAt: driveObjects.replicatedAt,
            auditedAt: driveObjects.auditedAt,
        })
        .from(driveObjects)
        .where(eq(driveObjects.status, 'missing'))
        .orderBy(desc(driveObjects.auditedAt))
        .limit(100);
    return {
        people: { total: people?.total ?? 0, admins: people?.admins ?? 0 },
        workspaces: { total: space?.total ?? 0, usedBytes: space?.usedBytes ?? '0' },
        objects: {
            total: objects?.total ?? 0,
            ready: objects?.ready ?? 0,
            missing: objects?.missing ?? 0,
            pending: objects?.pending ?? 0,
            unreplicated: objects?.unreplicated ?? 0,
            cold: objects?.cold ?? 0,
            bytes: objects?.bytes ?? '0',
            lastAuditedAt: objects?.lastAuditedAt ?? null,
        },
        outbox: { pending: outbox?.pending ?? 0 },
        reports: { open: reports?.open ?? 0, held: reports?.held ?? 0 },
        missing,
    };
}

/*
 * The lists behind the counts: accounts and workspaces, for an operator who
 * needs to find a person or see where the space goes. Account details (name,
 * email, role, dates) and numbers; never a file name or any content.
 */

/*
 * A workspace's allowance: its base plus every grant in force now, the same
 * rule getStorageAllowance applies one account at a time. Revoked, expired and
 * not-yet-started grants don't count.
 */
const quotaOf = sql<string>`(${workspaceStorage.baseQuotaBytes} + coalesce((select sum(${storageEntitlements.quotaBytes}) from ${storageEntitlements} where ${storageEntitlements.workspaceId} = ${workspaceStorage.workspaceId} and ${storageEntitlements.revokedAt} is null and ${storageEntitlements.startsAt} <= now() and (${storageEntitlements.expiresAt} is null or ${storageEntitlements.expiresAt} > now())), 0))::text`;

const lastSeenOf = sql<Date | null>`(select max(${sessions.lastSeenAt}) from ${sessions} where ${sessions.userId} = ${users.id})`;

export const ADMIN_PAGE = 50;

export async function listAccounts(input: {
    role?: 'admin' | 'member';
    query?: string;
    sort?: 'joined' | 'stored';
    offset?: number;
}) {
    const filters: SQL[] = [];
    if (input.role) filters.push(eq(users.role, input.role));
    const query = input.query?.trim();
    if (query) {
        // A search is literal text, not a pattern.
        const pattern = `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
        filters.push(or(ilike(users.email, pattern), ilike(users.name, pattern))!);
    }
    const where = filters.length ? and(...filters) : undefined;
    const [total] = await db.select({ total: count() }).from(users).where(where);
    const rows = await db
        .select({
            id: users.id,
            name: users.name,
            email: users.email,
            role: users.role,
            suspendedAt: users.suspendedAt,
            createdAt: users.createdAt,
            workspaceId: personalWorkspaces.workspaceId,
            usedBytes: sql<string>`coalesce(${workspaceStorage.usedBytes}, 0)::text`,
            quotaBytes: sql<
                string | null
            >`case when ${workspaceStorage.workspaceId} is null then null else ${quotaOf} end`,
            lastSeenAt: lastSeenOf,
        })
        .from(users)
        .leftJoin(personalWorkspaces, eq(personalWorkspaces.userId, users.id))
        .leftJoin(
            workspaceStorage,
            eq(workspaceStorage.workspaceId, personalWorkspaces.workspaceId),
        )
        .where(where)
        .orderBy(
            ...(input.sort === 'stored'
                ? [desc(sql`coalesce(${workspaceStorage.usedBytes}, 0)`), asc(users.id)]
                : [desc(users.createdAt), asc(users.id)]),
        )
        .limit(ADMIN_PAGE)
        .offset(Math.max(0, input.offset ?? 0));
    return { total: total?.total ?? 0, accounts: rows };
}

export async function getAccount(userId: string) {
    const [account] = await db
        .select({
            id: users.id,
            name: users.name,
            email: users.email,
            role: users.role,
            suspendedAt: users.suspendedAt,
            createdAt: users.createdAt,
            emailVerifiedAt: users.emailVerifiedAt,
            workspaceId: personalWorkspaces.workspaceId,
            baseQuotaBytes: workspaceStorage.baseQuotaBytes,
            usedBytes: workspaceStorage.usedBytes,
            reservedBytes: workspaceStorage.reservedBytes,
            quotaBytes: sql<
                string | null
            >`case when ${workspaceStorage.workspaceId} is null then null else ${quotaOf} end`,
            lastSeenAt: lastSeenOf,
        })
        .from(users)
        .leftJoin(personalWorkspaces, eq(personalWorkspaces.userId, users.id))
        .leftJoin(
            workspaceStorage,
            eq(workspaceStorage.workspaceId, personalWorkspaces.workspaceId),
        )
        .where(eq(users.id, userId));
    if (!account) return null;
    const grants = account.workspaceId
        ? await db
              .select({
                  source: storageEntitlements.source,
                  quotaBytes: storageEntitlements.quotaBytes,
                  startsAt: storageEntitlements.startsAt,
                  expiresAt: storageEntitlements.expiresAt,
                  revokedAt: storageEntitlements.revokedAt,
              })
              .from(storageEntitlements)
              .where(eq(storageEntitlements.workspaceId, account.workspaceId))
              .orderBy(desc(storageEntitlements.startsAt))
        : [];
    const [activeSessions] = await db
        .select({ total: count() })
        .from(sessions)
        .where(and(eq(sessions.userId, userId), sql`${sessions.expiresAt} > now()`));
    const [reports] = await db
        .select({
            total: count(),
            open: sql<number>`count(*) filter (where ${driveReports.status} = 'open')`.mapWith(
                Number,
            ),
        })
        .from(driveReports)
        .where(eq(driveReports.uploaderUserId, userId));
    const [objects] = account.workspaceId
        ? await db
              .select({
                  ready: sql<number>`count(*) filter (where ${driveObjects.status} = 'ready')`.mapWith(
                      Number,
                  ),
                  missing:
                      sql<number>`count(*) filter (where ${driveObjects.status} = 'missing')`.mapWith(
                          Number,
                      ),
              })
              .from(driveObjects)
              .where(eq(driveObjects.workspaceId, account.workspaceId))
        : [{ ready: 0, missing: 0 }];
    return {
        ...account,
        grants,
        activeSessions: activeSessions?.total ?? 0,
        reports: { total: reports?.total ?? 0, open: reports?.open ?? 0 },
        objects: { ready: objects?.ready ?? 0, missing: objects?.missing ?? 0 },
    };
}

export async function listWorkspaces(input: { sort?: 'stored' | 'created'; offset?: number }) {
    const [total] = await db.select({ total: count() }).from(workspaces);
    const rows = await db
        .select({
            id: workspaces.id,
            createdAt: workspaces.createdAt,
            ownerId: personalWorkspaces.userId,
            ownerEmail: users.email,
            usedBytes: sql<string>`coalesce(${workspaceStorage.usedBytes}, 0)::text`,
            quotaBytes: sql<
                string | null
            >`case when ${workspaceStorage.workspaceId} is null then null else ${quotaOf} end`,
            missing:
                sql<number>`(select count(*) from ${driveObjects} where ${driveObjects.workspaceId} = ${workspaces.id} and ${driveObjects.status} = 'missing')`.mapWith(
                    Number,
                ),
        })
        .from(workspaces)
        .leftJoin(workspaceStorage, eq(workspaceStorage.workspaceId, workspaces.id))
        .leftJoin(personalWorkspaces, eq(personalWorkspaces.workspaceId, workspaces.id))
        .leftJoin(users, eq(users.id, personalWorkspaces.userId))
        .orderBy(
            ...(input.sort === 'created'
                ? [desc(workspaces.createdAt), asc(workspaces.id)]
                : [desc(sql`coalesce(${workspaceStorage.usedBytes}, 0)`), asc(workspaces.id)]),
        )
        .limit(ADMIN_PAGE)
        .offset(Math.max(0, input.offset ?? 0));
    return { total: total?.total ?? 0, workspaces: rows };
}
