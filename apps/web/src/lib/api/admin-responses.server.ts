import '@/lib/server-only';
import { t } from 'elysia';
import {
    downloadUrlResponse,
    listingResponse,
    node,
    objectUrlsResponse,
    servedIdentityFields,
} from '@/lib/api/drive-responses.server';

/*
 * What every operator route answers (admin.server.ts) and the two system routes
 * (system.server.ts), field for field. Elysia checks a reply against its schema and drops every
 * field the schema does not name, so a column added to a row later stays on the server. Reports
 * mirror the views in @hushos/drive/server (reportView, reportEventView, evidenceRequestView,
 * reportItemView, publicIdentity); accounts, the overview and workspaces mirror what
 * @hushos/auth/server builds, which spreads repository rows: a field the schema misses is
 * silently dropped, and one it requires that the handler leaves out fails the request.
 *
 * Operator-only, and full of what nobody else may see (reporters' and uploaders' addresses, the
 * report key sealed to this operator, evidence URLs), but the console reads all of it, so none is
 * left out. Byte counts are decimal strings and dates ISO strings, as the handlers make them;
 * counts are integers. Statuses, categories and roles are the database's own sets (its check
 * constraints); a report event's action, a grant's source and Polar's statuses are free text
 * there, so plain strings here.
 */

/* ------------------------------------------------------------------------- */
/* Reports */

const reportStatus = t.Union([
    t.Literal('open'),
    t.Literal('dismissed'),
    t.Literal('removed'),
    t.Literal('filed'),
]);

/*
 * ReportView. A released report has its reason and reporter cleared (null), and its uploader's
 * address; `uploader.userId` null when the workspace had no personal owner on record.
 */
const report = t.Object({
    id: t.String(),
    workspaceId: t.String(),
    nodeId: t.String(),
    nodeKind: t.Union([t.Literal('folder'), t.Literal('file')]),
    keyEpoch: t.Integer(),
    via: t.Union([t.Literal('link'), t.Literal('share')]),
    // REPORT_CATEGORIES, spelled out: a mapped union does not type as the set.
    category: t.Union([
        t.Literal('csam'),
        t.Literal('terrorism'),
        t.Literal('ncii'),
        t.Literal('malware'),
        t.Literal('copyright'),
        t.Literal('harassment'),
        t.Literal('other'),
    ]),
    reason: t.Nullable(t.String()),
    reporter: t.Object({ userId: t.Nullable(t.String()), email: t.Nullable(t.String()) }),
    uploader: t.Object({
        userId: t.Nullable(t.String()),
        email: t.Nullable(t.String()),
        suspended: t.Boolean(),
    }),
    status: reportStatus,
    heldAt: t.Nullable(t.String()),
    releasedAt: t.Nullable(t.String()),
    evidenceStatus: t.Union([
        t.Literal('pending'),
        t.Literal('copied'),
        t.Literal('skipped'),
        t.Literal('failed'),
        t.Literal('purged'),
    ]),
    itemCount: t.Integer(),
    itemsTruncated: t.Boolean(),
    filedWith: t.Nullable(t.String()),
    filedReference: t.Nullable(t.String()),
    resolvedAt: t.Nullable(t.String()),
    createdAt: t.String(),
    updatedAt: t.String(),
});

/* ReportEventView: the audit trail. The reporter's own event has no actor when they had no account. */
const reportEvent = t.Object({
    id: t.String(),
    actorUserId: t.Nullable(t.String()),
    action: t.String(),
    note: t.Nullable(t.String()),
    createdAt: t.String(),
});

/* EvidenceRequestView: the worker's answer, URLs by version id once ready, an error once failed. */
const evidenceRequest = t.Object({
    id: t.String(),
    status: t.Union([t.Literal('pending'), t.Literal('ready'), t.Literal('failed')]),
    urls: t.Nullable(t.Record(t.String(), t.String())),
    urlExpiresAt: t.Nullable(t.String()),
    error: t.Nullable(t.String()),
    createdAt: t.String(),
});

/* GET /admin/reports: newest work first, and the counts the tabs show. */
export const reportsResponse = t.Object({
    reports: t.Array(report),
    counts: t.Object({ open: t.Integer(), held: t.Integer(), total: t.Integer() }),
});

/* GET /admin/reports/:id: the report and its trail. */
export const reportDetailResponse = t.Object({ report, events: t.Array(reportEvent) });

/*
 * POST /admin/reports/:id/open: the reported node from the snapshot (changeSeq null, never
 * mid-rotation) and the report key sealed to this operator, null when it predates them.
 */
export const openedReportResponse = t.Object({
    report,
    node,
    keyEnvelope: t.Nullable(t.String()),
});

/* GET /admin/reports/:id/nodes/:nodeId/children: the snapshot as a listing, one page. */
export const reportChildrenResponse = listingResponse;

/* POST /admin/reports/:id/versions/urls and GET .../thumbnails: presigned GETs by version. */
export const reportUrlsResponse = objectUrlsResponse;

/* GET /admin/reports/:id/versions/:versionId/url: one version's GET, its node and framing. */
export const reportDownloadUrlResponse = downloadUrlResponse;

/* POST /admin/reports/:id/evidence and GET .../evidence/:requestId. */
export const evidenceRequestResponse = t.Object({ request: evidenceRequest });

/* GET /admin/reports/:id/keys: every current operator's identity, and whether they hold a key. */
export const reportKeyHoldersResponse = t.Object({
    operators: t.Array(
        t.Object({ ...servedIdentityFields, userId: t.String(), sealed: t.Boolean() }),
    ),
});

/* POST /admin/reports/:id/keys: how many keys were added (an existing one is never replaced). */
export const resealedReportResponse = t.Object({ added: t.Integer() });

/* POST /admin/reports/:id/{resolve,hold,reopen,uploader}: the report as it stands after. */
export const reportResponse = t.Object({ report });

/* POST /admin/reports/:id/{notes,packet}: the event put on the record. */
export const reportEventResponse = t.Object({ event: reportEvent });

/* ------------------------------------------------------------------------- */
/* Overview */

/*
 * GET /admin/overview: counts and bytes, the store audit's missing objects, and the billing lists
 * operators act on in Polar's dashboard (ids and amounts only). Amounts are minor units.
 */
export const overviewResponse = t.Object({
    people: t.Object({ total: t.Integer(), admins: t.Integer() }),
    workspaces: t.Object({ total: t.Integer(), usedBytes: t.String() }),
    objects: t.Object({
        total: t.Integer(),
        ready: t.Integer(),
        missing: t.Integer(),
        pending: t.Integer(),
        unreplicated: t.Integer(),
        cold: t.Integer(),
        bytes: t.String(),
        lastAuditedAt: t.Nullable(t.String()),
    }),
    outbox: t.Object({ pending: t.Integer() }),
    reports: t.Object({ open: t.Integer(), held: t.Integer() }),
    missing: t.Array(
        t.Object({
            objectId: t.String(),
            workspaceId: t.String(),
            ciphertextSize: t.String(),
            replicatedAt: t.Nullable(t.String()),
            auditedAt: t.Nullable(t.String()),
        }),
    ),
    stuckPlanChanges: t.Array(
        t.Object({
            groupId: t.String(),
            subscriptionId: t.String(),
            wanted: t.Nullable(t.String()),
            reason: t.Nullable(t.String()),
            since: t.Nullable(t.String()),
        }),
    ),
    refundsOwed: t.Array(
        t.Object({
            orderId: t.String(),
            subscriptionId: t.String(),
            userId: t.String(),
            groupId: t.Nullable(t.String()),
            amount: t.Integer(),
            currency: t.String(),
            failures: t.Integer(),
            since: t.Nullable(t.String()),
        }),
    ),
    unrefundable: t.Array(
        t.Object({
            subscriptionId: t.String(),
            userId: t.String(),
            groupId: t.Nullable(t.String()),
            amount: t.Integer(),
            currency: t.String(),
            since: t.String(),
        }),
    ),
    // A family's plans or a person's: each subscription that can still charge, with Polar's status.
    doubleCharges: t.Array(
        t.Union([
            t.Object({
                kind: t.Literal('family'),
                id: t.String(),
                subscriptions: t.Array(t.Object({ id: t.String(), status: t.String() })),
            }),
            t.Object({
                kind: t.Literal('person'),
                id: t.String(),
                subscriptions: t.Array(t.Object({ id: t.String(), status: t.String() })),
            }),
        ]),
    ),
    lapsedRevokeRefusals: t.Array(
        t.Object({
            groupId: t.String(),
            subscriptionId: t.String(),
            status: t.String(),
            refusal: t.Nullable(t.String()),
            since: t.Nullable(t.String()),
        }),
    ),
    unlistedFamilies: t.Array(t.Object({ groupId: t.String(), since: t.Nullable(t.String()) })),
    orphanedPlans: t.Array(
        t.Object({
            groupId: t.String(),
            why: t.Union([t.Literal('second-plan'), t.Literal('deleted-family')]),
            subscriptionId: t.String(),
            status: t.String(),
            revoked: t.Boolean(),
            refunded: t.Integer(),
            toRefund: t.Integer(),
            currency: t.String(),
            since: t.String(),
        }),
    ),
});

/* ------------------------------------------------------------------------- */
/* Accounts and workspaces */

const accountRole = t.Union([t.Literal('member'), t.Literal('admin')]);

/*
 * GET /admin/accounts: one page. `workspaceId` and `quotaBytes` null for an account with no
 * storage yet (its used bytes then "0"); `lastSeenAt` null with no session ever.
 */
export const accountsResponse = t.Object({
    total: t.Integer(),
    pageSize: t.Integer(),
    accounts: t.Array(
        t.Object({
            id: t.String(),
            name: t.String(),
            email: t.String(),
            role: accountRole,
            suspendedAt: t.Nullable(t.String()),
            createdAt: t.String(),
            workspaceId: t.Nullable(t.String()),
            usedBytes: t.String(),
            quotaBytes: t.Nullable(t.String()),
            lastSeenAt: t.Nullable(t.String()),
        }),
    ),
});

/*
 * GET /admin/accounts/:id: details, storage (every byte count null with no storage yet) and every
 * grant, revoked and expired ones too; `grantedByEmail` null for a plan's, an invite's or a gone
 * operator's.
 */
export const accountResponse = t.Object({
    id: t.String(),
    name: t.String(),
    email: t.String(),
    role: accountRole,
    suspendedAt: t.Nullable(t.String()),
    createdAt: t.String(),
    emailVerifiedAt: t.Nullable(t.String()),
    workspaceId: t.Nullable(t.String()),
    baseQuotaBytes: t.Nullable(t.String()),
    usedBytes: t.Nullable(t.String()),
    reservedBytes: t.Nullable(t.String()),
    quotaBytes: t.Nullable(t.String()),
    lastSeenAt: t.Nullable(t.String()),
    grants: t.Array(
        t.Object({
            id: t.String(),
            source: t.String(),
            quotaBytes: t.String(),
            startsAt: t.String(),
            expiresAt: t.Nullable(t.String()),
            revokedAt: t.Nullable(t.String()),
            grantedByEmail: t.Nullable(t.String()),
            note: t.Nullable(t.String()),
        }),
    ),
    activeSessions: t.Integer(),
    reports: t.Object({ total: t.Integer(), open: t.Integer() }),
    objects: t.Object({ ready: t.Integer(), missing: t.Integer() }),
});

/* POST /admin/accounts/:id/suspension: null once reinstated. */
export const suspensionResponse = t.Object({ suspendedAt: t.Nullable(t.String()) });

/* POST /admin/accounts/:id/storage: the new grant and the account's allowance with it. */
export const storageGrantResponse = t.Object({ entitlementId: t.String(), quotaBytes: t.String() });

/* POST /admin/accounts/:id/storage/:entitlementId/revoke: the allowance without it. */
export const storageRevokedResponse = t.Object({ quotaBytes: t.String() });

/* GET /admin/workspaces: one page; the owner null for a workspace with no personal owner (a group's). */
export const workspacesResponse = t.Object({
    total: t.Integer(),
    pageSize: t.Integer(),
    workspaces: t.Array(
        t.Object({
            id: t.String(),
            createdAt: t.String(),
            ownerId: t.Nullable(t.String()),
            ownerEmail: t.Nullable(t.String()),
            usedBytes: t.String(),
            quotaBytes: t.Nullable(t.String()),
            missing: t.Integer(),
        }),
    ),
});

/* ------------------------------------------------------------------------- */
/* System */

/* GET /health: the process answers, and which service it is. */
export const healthResponse = t.Object({ status: t.Literal('ok'), service: t.String() });

/* GET /ready: the database answers (200), or it does not (503). */
export const readyResponse = t.Object({ status: t.Literal('ok') });
export const unavailableResponse = t.Object({ status: t.Literal('unavailable') });
