import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from './client';
import { selectNodes, walk, type NodeRow, type VersionRow } from './drive';
import {
    accountIdentities,
    driveNodes,
    driveReportEvents,
    driveReportItems,
    driveReportRequests,
    driveReportKeys,
    driveReports,
    personalWorkspaces,
    users,
    type EvidenceStatus,
    type ReportCategory,
    type ReportStatus,
} from './schema';

/*
 * Reports, as the design fixes them: a row that outlives the tree, the node
 * key sealed to every operator, a bounded snapshot of the reported subtree,
 * and an audit trail. The server can open nothing here; it keeps the sealed
 * bodies, the framing, and the object keys the hold and the evidence copy work
 * from. Results are discriminated by `status` for the API layer.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/* How many nodes one report snapshots; past it the report says so and the operator asks for more by hand. */
export const REPORT_ITEM_CAP = 2000;

export type ReportRow = typeof driveReports.$inferSelect;
export type ReportItemRow = typeof driveReportItems.$inferSelect;
export type ReportEventRow = typeof driveReportEvents.$inferSelect;

/* Every operator a report must be sealed to: admins with a published identity. */
export async function listOperators() {
    return db
        .select({
            userId: users.id,
            encryptionPublicKey: accountIdentities.encryptionPublicKey,
        })
        .from(users)
        .innerJoin(accountIdentities, eq(accountIdentities.userId, users.id))
        .where(and(eq(users.role, 'admin'), isNull(users.suspendedAt)))
        .orderBy(asc(users.id));
}

export type CreateReport = {
    id: string;
    workspaceId: string;
    nodeId: string;
    keyEpoch: number;
    linkId: string | null;
    shareId: string | null;
    category: ReportCategory;
    reason: string;
    reporterUserId: string | null;
    reporterEmail: string | null;
    reporterAddressHash: Buffer | null;
    contentHash: Buffer | null;
    keys: { operatorUserId: string; keyEnvelope: Buffer }[];
};

type Snapshot = NodeRow & { currentVersion: VersionRow | null; depth: number };

/*
 * The live subtree beneath a node, breadth first, bounded. Children come in id
 * order like a listing, so the operator's view is the visitor's view frozen.
 */
async function snapshotSubtree(tx: Tx, root: NodeRow & { currentVersion: VersionRow | null }) {
    const out: Snapshot[] = [{ ...root, depth: 0 }];
    let frontier = root.kind === 'folder' ? [{ id: root.id, depth: 0 }] : [];
    let truncated = false;
    while (frontier.length && !truncated) {
        const next: { id: string; depth: number }[] = [];
        for (const parent of frontier) {
            const ids = await tx
                .select({ id: driveNodes.id })
                .from(driveNodes)
                .where(
                    and(
                        eq(driveNodes.parentId, parent.id),
                        isNull(driveNodes.trashedAt),
                        isNull(driveNodes.purgedAt),
                        sql`${driveNodes.changeSeq} is not null`,
                    ),
                )
                .orderBy(asc(driveNodes.id))
                .limit(REPORT_ITEM_CAP - out.length + 1);
            const room = REPORT_ITEM_CAP - out.length;
            if (ids.length > room) truncated = true;
            const page = ids.slice(0, room).map((row) => row.id);
            const rows = await selectNodes(tx, page);
            rows.sort((a, b) => (a.id < b.id ? -1 : 1));
            for (const row of rows) {
                out.push({ ...row, depth: parent.depth + 1 });
                if (row.kind === 'folder') next.push({ id: row.id, depth: parent.depth + 1 });
            }
            if (truncated) break;
        }
        frontier = next;
    }
    return { items: out, truncated };
}

export async function createReport(input: CreateReport) {
    return db.transaction(async (tx) => {
        const chain = await walk(tx, input.nodeId);
        if (!chain || chain.purged || chain.node.workspace_id !== input.workspaceId)
            return { status: 'not-found' as const };
        if (chain.trashed) return { status: 'not-found' as const };
        if (chain.node.key_epoch !== input.keyEpoch) return { status: 'stale' as const };
        // Every current operator must be able to open it, or the report is not filed.
        const operators = await listOperators();
        const sealedTo = new Set(input.keys.map((key) => key.operatorUserId));
        if (
            !operators.length ||
            operators.length !== sealedTo.size ||
            operators.some((operator) => !sealedTo.has(operator.userId))
        )
            return { status: 'operators-changed' as const };
        const reporter = input.reporterUserId
            ? eq(driveReports.reporterUserId, input.reporterUserId)
            : input.reporterAddressHash
              ? eq(driveReports.reporterAddressHash, input.reporterAddressHash)
              : undefined;
        if (reporter) {
            const [open] = await tx
                .select({ id: driveReports.id })
                .from(driveReports)
                .where(
                    and(
                        eq(driveReports.nodeId, input.nodeId),
                        eq(driveReports.status, 'open'),
                        reporter,
                    ),
                );
            if (open) return { status: 'duplicate' as const, reportId: open.id };
        }
        const [root] = await selectNodes(tx, [input.nodeId]);
        if (!root) return { status: 'not-found' as const };
        const [owner] = await tx
            .select({ id: users.id, email: users.email })
            .from(personalWorkspaces)
            .innerJoin(users, eq(users.id, personalWorkspaces.userId))
            .where(eq(personalWorkspaces.workspaceId, input.workspaceId));
        const { items, truncated } = await snapshotSubtree(tx, root);
        const [report] = await tx
            .insert(driveReports)
            .values({
                id: input.id,
                workspaceId: input.workspaceId,
                nodeId: input.nodeId,
                nodeKind: root.kind,
                keyEpoch: input.keyEpoch,
                linkId: input.linkId,
                shareId: input.shareId,
                category: input.category,
                reason: input.reason,
                reporterUserId: input.reporterUserId,
                reporterEmail: input.reporterEmail,
                reporterAddressHash: input.reporterAddressHash,
                uploaderUserId: owner?.id ?? null,
                uploaderEmail: owner?.email ?? null,
                contentHash: input.contentHash,
                itemCount: items.length,
                itemsTruncated: truncated,
            })
            .returning();
        await tx.insert(driveReportKeys).values(
            input.keys.map((key) => ({
                reportId: input.id,
                operatorUserId: key.operatorUserId,
                keyEnvelope: key.keyEnvelope,
            })),
        );
        for (let at = 0; at < items.length; at += 200)
            await tx.insert(driveReportItems).values(
                items.slice(at, at + 200).map((item) => ({
                    reportId: input.id,
                    nodeId: item.id,
                    parentId: item.depth === 0 ? null : item.parentId,
                    depth: item.depth,
                    kind: item.kind,
                    keyEpoch: item.keyEpoch,
                    parentKeyEpoch: item.parentKeyEpoch,
                    keyEnvelope: item.keyEnvelope!,
                    metadataVersion: item.metadataVersion,
                    metadataEnvelope: item.metadataEnvelope!,
                    versionId: item.currentVersion?.id ?? null,
                    objectId: item.currentVersion?.objectId ?? null,
                    objectKey: item.currentVersion ? objectKeyOf(item) : null,
                    contentKeyEnvelope: item.currentVersion?.contentKeyEnvelope ?? null,
                    contentNonce: item.currentVersion?.contentNonce ?? null,
                    contentSuite: item.currentVersion?.contentSuite ?? null,
                    chunkSize: item.currentVersion?.chunkSize ?? null,
                    chunkCount: item.currentVersion?.chunkCount ?? null,
                    plaintextSize: item.currentVersion?.plaintextSize ?? null,
                    ciphertextSize: item.currentVersion?.ciphertextSize ?? null,
                })),
            );
        await tx.insert(driveReportEvents).values({
            reportId: input.id,
            actorUserId: input.reporterUserId,
            action: 'reported',
            note: null,
        });
        return { status: 'ok' as const, report: report! };
    });
}

/* Object keys are "ws/{workspaceId}/{objectId}" everywhere; the snapshot spells them out so it needs no join later. */
function objectKeyOf(item: NodeRow & { currentVersion: VersionRow | null }) {
    return `ws/${item.workspaceId}/${item.currentVersion!.objectId}`;
}

/* ------------------------------------------------------------------------- */
/* Triage                                                                     */
/* ------------------------------------------------------------------------- */

export async function listReports(input: {
    status?: ReportStatus | 'all';
    category?: ReportCategory;
    limit?: number;
}) {
    const status = input.status ?? 'open';
    const query = db
        .select()
        .from(driveReports)
        .where(
            and(
                status === 'all' ? undefined : eq(driveReports.status, status),
                input.category ? eq(driveReports.category, input.category) : undefined,
            ),
        )
        .orderBy(status === 'open' ? asc(driveReports.createdAt) : desc(driveReports.updatedAt))
        .limit(Math.min(input.limit ?? 200, 500));
    return query;
}

export async function countReports() {
    const [row] = await db
        .select({
            open: sql<number>`count(*) filter (where ${driveReports.status} = 'open')`.mapWith(
                Number,
            ),
            held: sql<number>`count(*) filter (where ${driveReports.heldAt} is not null)`.mapWith(
                Number,
            ),
            total: sql<number>`count(*)`.mapWith(Number),
        })
        .from(driveReports);
    return row ?? { open: 0, held: 0, total: 0 };
}

export async function getReport(reportId: string) {
    const [report] = await db.select().from(driveReports).where(eq(driveReports.id, reportId));
    if (!report) return null;
    const events = await db
        .select()
        .from(driveReportEvents)
        .where(eq(driveReportEvents.reportId, reportId))
        .orderBy(asc(driveReportEvents.createdAt), asc(driveReportEvents.id));
    const [uploader] = report.uploaderUserId
        ? await db
              .select({ suspendedAt: users.suspendedAt })
              .from(users)
              .where(eq(users.id, report.uploaderUserId))
        : [];
    return { report, events, uploader: uploader ?? null };
}

/* The envelope sealed to one operator, or null when the report predates them. */
export async function getReportKey(reportId: string, operatorUserId: string) {
    const [row] = await db
        .select({ keyEnvelope: driveReportKeys.keyEnvelope })
        .from(driveReportKeys)
        .where(
            and(
                eq(driveReportKeys.reportId, reportId),
                eq(driveReportKeys.operatorUserId, operatorUserId),
            ),
        );
    return row?.keyEnvelope ?? null;
}

/* Which operators hold a key for the report, against who the operators are now. */
export async function listReportKeyHolders(reportId: string) {
    const [operators, holders] = await Promise.all([
        listOperators(),
        db
            .select({ operatorUserId: driveReportKeys.operatorUserId })
            .from(driveReportKeys)
            .where(eq(driveReportKeys.reportId, reportId)),
    ]);
    const held = new Set(holders.map((row) => row.operatorUserId));
    return operators.map((operator) => ({ ...operator, sealed: held.has(operator.userId) }));
}

/*
 * Keys sealed later by an operator who could open the report, for operators
 * promoted after it was filed. Only current operators are accepted and an
 * existing key is never replaced, so a compromised later seal cannot swap out
 * the one the reporter made.
 */
export async function addReportKeys(
    reportId: string,
    actorUserId: string,
    keys: { operatorUserId: string; keyEnvelope: Buffer }[],
) {
    return db.transaction(async (tx) => {
        const [report] = await tx
            .select({ id: driveReports.id })
            .from(driveReports)
            .where(eq(driveReports.id, reportId));
        if (!report) return { status: 'not-found' as const };
        const operators = new Set((await listOperators()).map((o) => o.userId));
        const accepted = keys.filter((key) => operators.has(key.operatorUserId));
        if (!accepted.length) return { status: 'ok' as const, added: 0 };
        const inserted = await tx
            .insert(driveReportKeys)
            .values(
                accepted.map((key) => ({
                    reportId,
                    operatorUserId: key.operatorUserId,
                    keyEnvelope: key.keyEnvelope,
                })),
            )
            .onConflictDoNothing()
            .returning({ operatorUserId: driveReportKeys.operatorUserId });
        if (inserted.length)
            await tx.insert(driveReportEvents).values({
                reportId,
                actorUserId,
                action: 'resealed',
                note: `${inserted.length} more operator${inserted.length === 1 ? '' : 's'} can open it`,
            });
        return { status: 'ok' as const, added: inserted.length };
    });
}

export async function addReportEvent(
    reportId: string,
    actorUserId: string | null,
    action: string,
    note: string | null = null,
) {
    const [row] = await db
        .insert(driveReportEvents)
        .values({ reportId, actorUserId, action, note })
        .returning();
    return row!;
}

/* The snapshot as a listing: the folder, its chain up to the reported node, and its children. */
export async function listReportChildren(reportId: string, parentId: string) {
    const [folder] = await db
        .select()
        .from(driveReportItems)
        .where(and(eq(driveReportItems.reportId, reportId), eq(driveReportItems.nodeId, parentId)));
    if (!folder || folder.kind !== 'folder') return null;
    const children = await db
        .select()
        .from(driveReportItems)
        .where(
            and(eq(driveReportItems.reportId, reportId), eq(driveReportItems.parentId, parentId)),
        )
        .orderBy(asc(driveReportItems.nodeId));
    const ancestors: ReportItemRow[] = [];
    let cursor = folder.parentId;
    while (cursor && ancestors.length < REPORT_ITEM_CAP) {
        const [row] = await db
            .select()
            .from(driveReportItems)
            .where(
                and(eq(driveReportItems.reportId, reportId), eq(driveReportItems.nodeId, cursor)),
            );
        if (!row) break;
        ancestors.unshift(row);
        cursor = row.parentId;
    }
    return { folder, ancestors, children };
}

export async function getReportItem(reportId: string, nodeId: string) {
    const [row] = await db
        .select()
        .from(driveReportItems)
        .where(and(eq(driveReportItems.reportId, reportId), eq(driveReportItems.nodeId, nodeId)));
    return row ?? null;
}

export async function getReportVersions(reportId: string, versionIds: string[]) {
    if (!versionIds.length) return [];
    return db
        .select()
        .from(driveReportItems)
        .where(
            and(
                eq(driveReportItems.reportId, reportId),
                inArray(driveReportItems.versionId, versionIds),
            ),
        );
}

export type Resolution =
    | { status: 'dismissed'; hold: boolean }
    | { status: 'removed'; hold: boolean }
    | { status: 'filed'; filedWith: string; filedReference: string | null };

/* Closes a report; a filed one is always held, since someone else now relies on the bytes. */
export async function resolveReport(reportId: string, actorUserId: string, resolution: Resolution) {
    return db.transaction(async (tx) => {
        const [current] = await tx
            .select({ status: driveReports.status, heldAt: driveReports.heldAt })
            .from(driveReports)
            .where(eq(driveReports.id, reportId))
            .for('update');
        if (!current) return { status: 'not-found' as const };
        const now = new Date();
        const hold = resolution.status === 'filed' ? true : resolution.hold;
        const [report] = await tx
            .update(driveReports)
            .set({
                status: resolution.status,
                heldAt: hold ? (current.heldAt ?? now) : null,
                filedWith: resolution.status === 'filed' ? resolution.filedWith : undefined,
                filedReference:
                    resolution.status === 'filed' ? resolution.filedReference : undefined,
                resolvedAt: now,
                resolvedBy: actorUserId,
                updatedAt: now,
            })
            .where(eq(driveReports.id, reportId))
            .returning();
        await tx.insert(driveReportEvents).values({
            reportId,
            actorUserId,
            action: resolution.status,
            note:
                resolution.status === 'filed'
                    ? [resolution.filedWith, resolution.filedReference].filter(Boolean).join(' · ')
                    : hold
                      ? 'kept on hold'
                      : null,
        });
        return { status: 'ok' as const, report: report! };
    });
}

export async function setReportHold(reportId: string, actorUserId: string, held: boolean) {
    return db.transaction(async (tx) => {
        const [report] = await tx
            .update(driveReports)
            .set({
                heldAt: held ? sql`coalesce(${driveReports.heldAt}, now())` : null,
                updatedAt: new Date(),
            })
            .where(eq(driveReports.id, reportId))
            .returning();
        if (!report) return null;
        await tx.insert(driveReportEvents).values({
            reportId,
            actorUserId,
            action: held ? 'held' : 'released',
        });
        return report;
    });
}

export async function reopenReport(reportId: string, actorUserId: string) {
    return db.transaction(async (tx) => {
        const [report] = await tx
            .update(driveReports)
            .set({ status: 'open', resolvedAt: null, resolvedBy: null, updatedAt: new Date() })
            .where(eq(driveReports.id, reportId))
            .returning();
        if (!report) return null;
        await tx.insert(driveReportEvents).values({ reportId, actorUserId, action: 'reopened' });
        return report;
    });
}

/* ------------------------------------------------------------------------- */
/* Holds and evidence                                                         */
/* ------------------------------------------------------------------------- */

/* Objects an open or held report names: the deletion outbox leaves these where they are. */
export function heldObjectCondition(objectIdColumn: { getSQL(): unknown }) {
    return sql`not exists (
        select 1 from ${driveReportItems} i
        join ${driveReports} r on r.id = i.report_id
        where i.object_id = ${objectIdColumn}
          and (r.status = 'open' or r.held_at is not null)
    )`;
}

export async function isObjectHeld(objectId: string) {
    const [row] = await db
        .select({ id: driveReportItems.reportId })
        .from(driveReportItems)
        .innerJoin(driveReports, eq(driveReports.id, driveReportItems.reportId))
        .where(
            and(
                eq(driveReportItems.objectId, objectId),
                or(eq(driveReports.status, 'open'), sql`${driveReports.heldAt} is not null`),
            ),
        )
        .limit(1);
    return Boolean(row);
}

/* Reports whose evidence has not been copied yet, oldest first. */
export async function listReportsAwaitingEvidence(limit = 20) {
    return db
        .select({ id: driveReports.id, evidenceStatus: driveReports.evidenceStatus })
        .from(driveReports)
        .where(eq(driveReports.evidenceStatus, 'pending'))
        .orderBy(asc(driveReports.createdAt))
        .limit(limit);
}

export async function listReportObjectsToCopy(reportId: string) {
    return db
        .select({
            nodeId: driveReportItems.nodeId,
            objectId: driveReportItems.objectId,
            objectKey: driveReportItems.objectKey,
        })
        .from(driveReportItems)
        .where(
            and(
                eq(driveReportItems.reportId, reportId),
                sql`${driveReportItems.objectKey} is not null`,
                isNull(driveReportItems.evidenceCopiedAt),
            ),
        )
        .orderBy(asc(driveReportItems.depth), asc(driveReportItems.nodeId));
}

export async function markReportItemCopied(reportId: string, nodeId: string) {
    await db
        .update(driveReportItems)
        .set({ evidenceCopiedAt: new Date() })
        .where(and(eq(driveReportItems.reportId, reportId), eq(driveReportItems.nodeId, nodeId)));
}

export async function setEvidenceStatus(reportId: string, status: EvidenceStatus) {
    await db
        .update(driveReports)
        .set({ evidenceStatus: status, updatedAt: new Date() })
        .where(eq(driveReports.id, reportId));
}

/* Dismissed without a hold: the copy has no reason to exist and goes. */
export async function listReportsForEvidencePurge(limit = 20) {
    return db
        .select({ id: driveReports.id })
        .from(driveReports)
        .where(
            and(
                eq(driveReports.status, 'dismissed'),
                isNull(driveReports.heldAt),
                eq(driveReports.evidenceStatus, 'copied'),
            ),
        )
        .orderBy(asc(driveReports.updatedAt))
        .limit(limit);
}

export async function listReportObjectsCopied(reportId: string) {
    return db
        .select({
            nodeId: driveReportItems.nodeId,
            objectId: driveReportItems.objectId,
            versionId: driveReportItems.versionId,
        })
        .from(driveReportItems)
        .where(
            and(
                eq(driveReportItems.reportId, reportId),
                sql`${driveReportItems.evidenceCopiedAt} is not null`,
            ),
        );
}

export async function clearReportItemCopies(reportId: string) {
    await db
        .update(driveReportItems)
        .set({ evidenceCopiedAt: null })
        .where(eq(driveReportItems.reportId, reportId));
}

/* ------------------------------------------------------------------------- */
/* Evidence requests                                                          */
/* ------------------------------------------------------------------------- */

export type EvidenceRequestRow = typeof driveReportRequests.$inferSelect;

export async function createEvidenceRequest(reportId: string, requestedBy: string) {
    return db.transaction(async (tx) => {
        const [report] = await tx
            .select({ id: driveReports.id, evidenceStatus: driveReports.evidenceStatus })
            .from(driveReports)
            .where(eq(driveReports.id, reportId));
        if (!report) return { status: 'not-found' as const };
        if (report.evidenceStatus !== 'copied')
            return { status: 'no-evidence' as const, evidenceStatus: report.evidenceStatus };
        const [request] = await tx
            .insert(driveReportRequests)
            .values({ reportId, requestedBy })
            .returning();
        await tx.insert(driveReportEvents).values({
            reportId,
            actorUserId: requestedBy,
            action: 'evidence-requested',
        });
        return { status: 'ok' as const, request: request! };
    });
}

export async function getEvidenceRequest(reportId: string, requestId: string) {
    const [row] = await db
        .select()
        .from(driveReportRequests)
        .where(
            and(eq(driveReportRequests.id, requestId), eq(driveReportRequests.reportId, reportId)),
        );
    return row ?? null;
}

export async function listPendingEvidenceRequests(limit = 20) {
    return db
        .select()
        .from(driveReportRequests)
        .where(eq(driveReportRequests.status, 'pending'))
        .orderBy(asc(driveReportRequests.createdAt))
        .limit(limit);
}

export async function answerEvidenceRequest(
    requestId: string,
    answer:
        | { status: 'ready'; urls: Record<string, string>; urlExpiresAt: Date }
        | { status: 'failed'; error: string },
) {
    const [row] = await db
        .update(driveReportRequests)
        .set({
            status: answer.status,
            urls: answer.status === 'ready' ? answer.urls : null,
            urlExpiresAt: answer.status === 'ready' ? answer.urlExpiresAt : null,
            error: answer.status === 'failed' ? answer.error : null,
            answeredAt: new Date(),
        })
        .where(
            and(eq(driveReportRequests.id, requestId), eq(driveReportRequests.status, 'pending')),
        )
        .returning();
    return row ?? null;
}

/* Answered requests older than a day carry expired URLs and go. */
export async function deleteStaleEvidenceRequests() {
    const rows = await db
        .delete(driveReportRequests)
        .where(sql`${driveReportRequests.createdAt} < now() - interval '1 day'`)
        .returning({ id: driveReportRequests.id });
    return rows.length;
}
