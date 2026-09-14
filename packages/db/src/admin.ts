import { count, desc, eq, isNull, sql, sum } from 'drizzle-orm';
import { db } from './client';
import {
    driveObjectDeletions,
    driveObjects,
    driveReports,
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
