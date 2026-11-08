// @vitest-environment node
import { Elysia, type AnySchema } from 'elysia';
import { describe, expect, test, vi } from 'vitest';
import type * as auth from '@hushos/auth/server';
import { REPORT_CATEGORIES } from '@hushos/drive/api';
import type * as drive from '@hushos/drive/server';
import { API_SERVICE } from '@hushos/shared';
import {
    accountResponse,
    accountsResponse,
    evidenceRequestResponse,
    healthResponse,
    openedReportResponse,
    overviewResponse,
    readyResponse,
    reportChildrenResponse,
    reportDetailResponse,
    reportDownloadUrlResponse,
    reportEventResponse,
    reportKeyHoldersResponse,
    reportResponse,
    reportsResponse,
    reportUrlsResponse,
    resealedReportResponse,
    storageGrantResponse,
    storageRevokedResponse,
    suspensionResponse,
    unavailableResponse,
    workspacesResponse,
} from '@/lib/api/admin-responses.server';
import { loadApi, type ApiRoute } from '@/test/api-app';

/*
 * The operator and system routes' reply schemas, through a real Elysia route so normalisation
 * runs as it does in the app: what the drive and auth packages return goes out unchanged (every
 * variant: open, held, filed and released reports, an anonymous reporter, a suspended or missing
 * uploader, evidence pending, ready and failed, an operator who cannot open a report yet, an
 * account with no storage, a gone granter, every billing list the overview carries), a field the
 * schema does not name is dropped, and a reply missing a field the console reads fails instead
 * of going out short. Samples are typed as the packages' return types, so a sample that drifts
 * from what the handler returns fails typecheck.
 */

type Reply<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

async function serve(schema: AnySchema, value: unknown, status: 200 | 503 = 200) {
    const app = new Elysia().get('/x', { response: { [status]: schema } }, ({ set }) => {
        set.status = status;
        return value as never;
    });
    const response = await app.handle(new Request('http://localhost/x'));
    return {
        status: response.status,
        body: response.status === status ? ((await response.json()) as unknown) : null,
    };
}

const clone = <T>(value: T): T => structuredClone(value);
const b64 = (length: number, fill = 7) => Buffer.alloc(length, fill).toString('base64url');
const iso = (hour: number) => new Date(Date.UTC(2026, 10, 8, hour)).toISOString();
const GiB = (n: number) => String(BigInt(n) << 30n);

const reportId = '0b5e0d1c-6a4e-4c41-9a43-2b1f4d8f9e10';
const workspaceId = '1c6f1e2d-7b5f-4d52-8b54-3c2a5e9a0f21';
const nodeId = '2d7a2f3e-8c6a-4e63-9c65-4d3b6fab1a32';
const childId = '3e8b3a4f-9d7b-4f74-8d76-5e4c7abc2b43';
const reporter = '4f9c4b5a-ae8c-4a85-9e87-6f5d8bcd3c54';
const uploader = '5a0d5c6b-bf9d-4b96-8f98-7a6e9cde4d65';
const operator = '6b1e6d7c-c0ae-4ca7-9a09-8b7fadef5e76';
const newOperator = '7c2f7e8d-d1bf-4db8-8b1a-9c80bef06f87';
const versionId = '8d308f9e-e2c0-4ec9-9c2b-ad91cf017098';
const objectId = '9e41908f-f3d1-4fda-8d3c-bea2d01281a9';
const eventId = 'af52a190-04e2-40eb-9e4d-cfb3e12392ba';
const requestId = 'b063c2a1-15f3-41fc-8f5e-d0c4f234a3cc';
const groupId = 'c174d3b2-2604-42ad-9a6f-e1d5f345b4dd';
const entitlementId = 'd285e4c3-3715-43be-8b70-f2e60456c5ee';
const presigned = (id: string) =>
    `https://store.example.test/ws/${workspaceId}/${id}?X-Amz-Signature=abc`;

/* ------------------------------------------------------------------------- */
/* Reports */

type Report = Reply<typeof drive.getReport>['report'];
/* Open, held, reported through a share by someone signed in. */
const openReport: Report = {
    id: reportId,
    workspaceId,
    nodeId,
    nodeKind: 'folder',
    keyEpoch: 3,
    via: 'share',
    category: 'csam',
    reason: 'Images of a child.',
    reporter: { userId: reporter, email: null },
    uploader: { userId: uploader, email: 'uploader@example.com', suspended: true },
    status: 'open',
    heldAt: iso(9),
    releasedAt: null,
    evidenceStatus: 'copied',
    itemCount: 14,
    itemsTruncated: false,
    filedWith: null,
    filedReference: null,
    resolvedAt: null,
    createdAt: iso(8),
    updatedAt: iso(9),
};
/* Filed with an authority, still held; reported through a link by someone without an account. */
const filedReport: Report = {
    ...openReport,
    via: 'link',
    category: 'terrorism',
    reporter: { userId: null, email: 'someone@example.org' },
    status: 'filed',
    filedWith: 'NCMEC',
    filedReference: 'CT-123456',
    resolvedAt: iso(11),
    itemsTruncated: true,
    itemCount: 2000,
};
/* Dismissed without a hold: reason, reporter and the uploader's address cleared, evidence purged. */
const releasedReport: Report = {
    ...openReport,
    nodeKind: 'file',
    category: 'other',
    reason: null,
    reporter: { userId: null, email: null },
    uploader: { userId: uploader, email: null, suspended: false },
    status: 'dismissed',
    heldAt: null,
    releasedAt: iso(12),
    evidenceStatus: 'purged',
    resolvedAt: iso(12),
};
/* The workspace had no personal owner on record, and no evidence store is configured. */
const ownerlessReport: Report = {
    ...openReport,
    category: 'copyright',
    uploader: { userId: null, email: null, suspended: false },
    status: 'removed',
    evidenceStatus: 'skipped',
    resolvedAt: iso(10),
};

type ReportEvent = Reply<typeof drive.getReport>['events'][number];
const reported: ReportEvent = {
    id: eventId,
    actorUserId: null,
    action: 'reported',
    note: null,
    createdAt: iso(8),
};
const noted: ReportEvent = {
    id: requestId,
    actorUserId: operator,
    action: 'note',
    note: 'Asked the uploader for context.',
    createdAt: iso(10),
};

/* The reported nodes as reportItemView serves them from the snapshot: changeSeq null, no rotation. */
type Node = Reply<typeof drive.openReport>['node'];
const folder: Node = {
    id: nodeId,
    workspaceId,
    parentId: null,
    kind: 'folder',
    keyEpoch: 3,
    parentKeyEpoch: 3,
    keyEnvelope: b64(72, 1),
    prevKeyEnvelope: null,
    prevKeyEpoch: null,
    prevParentKeyEpoch: null,
    metadataVersion: 2,
    metadataEnvelope: b64(296, 2),
    currentVersion: null,
    trashedAt: null,
    changeSeq: null,
    createdAt: iso(8),
    updatedAt: iso(8),
    envelopeSuite: 1,
    metadataSigner: { id: uploader },
    metadataSignature: b64(64, 3),
    metadataRekey: null,
    metadataOriginDropped: null,
};
type Version = Reply<typeof drive.reportDownloadUrl>['version'];
const version: Version = {
    id: versionId,
    objectId,
    contentKeyEnvelope: b64(84, 4),
    status: 'ready',
    objectStatus: 'ready',
    contentSuite: 3,
    chunkSize: 4_194_304,
    chunkCount: 2,
    contentNonce: b64(16, 5),
    plaintextSize: null,
    ciphertextSize: '5242912',
    readyAt: null,
    signer: { id: uploader },
    signature: b64(64, 6),
    rekey: null,
    originDropped: null,
};
/* A file from before signatures: no signer or signature on the node or its version. */
const file: Node = {
    ...folder,
    id: childId,
    parentId: nodeId,
    kind: 'file',
    metadataSigner: null,
    metadataSignature: null,
    currentVersion: { ...version, signer: null, signature: null, plaintextSize: '5242880' },
};

const identity = (fill: number) => ({
    keyVersion: 2,
    identityVersion: 2 as const,
    encryptionPublicKey: b64(32, fill),
    signingPublicKey: b64(32, fill + 1),
    mlDsaPublicKey: b64(1952, fill),
    kemPublicKey: b64(1184, fill),
    keysSignature: b64(3373, fill),
});

/* ------------------------------------------------------------------------- */
/* Overview, accounts, workspaces */

type Overview = Reply<typeof auth.getAdminOverview>;
const overview: Overview = {
    people: { total: 42, admins: 2 },
    workspaces: { total: 47, usedBytes: GiB(310) },
    objects: {
        total: 9100,
        ready: 9001,
        missing: 2,
        pending: 7,
        unreplicated: 90,
        cold: 1200,
        bytes: GiB(305),
        lastAuditedAt: iso(3),
    },
    outbox: { pending: 5 },
    reports: { open: 1, held: 2 },
    missing: [
        {
            objectId,
            workspaceId,
            ciphertextSize: '5242912',
            replicatedAt: iso(1),
            auditedAt: iso(3),
        },
        // Never replicated, and lost before the audit caught it again.
        {
            objectId: eventId,
            workspaceId,
            ciphertextSize: '0',
            replicatedAt: null,
            auditedAt: null,
        },
    ],
    stuckPlanChanges: [
        {
            groupId,
            subscriptionId: 'sub_stuck',
            wanted: 'units:4',
            reason: 'polar-ignored',
            since: iso(2),
        },
        { groupId, subscriptionId: 'sub_dissolved', wanted: null, reason: null, since: iso(3) },
    ],
    refundsOwed: [
        {
            orderId: 'order_a',
            subscriptionId: 'sub_a',
            userId: reporter,
            groupId: null,
            amount: 499,
            currency: 'usd',
            failures: 5,
            since: iso(4),
        },
        {
            orderId: 'order_b',
            subscriptionId: 'sub_b',
            userId: groupId,
            groupId,
            amount: 1299,
            currency: 'eur',
            failures: 6,
            since: null,
        },
    ],
    unrefundable: [
        {
            subscriptionId: 'sub_c',
            userId: reporter,
            groupId: null,
            amount: 250,
            currency: 'usd',
            since: iso(5),
        },
    ],
    doubleCharges: [
        {
            kind: 'family',
            id: groupId,
            subscriptions: [
                { id: 'sub_d', status: 'active' },
                { id: 'sub_e', status: 'past_due' },
            ],
        },
        {
            kind: 'person',
            id: reporter,
            subscriptions: [
                { id: 'sub_f', status: 'active' },
                { id: 'sub_g', status: 'unpaid' },
            ],
        },
    ],
    lapsedRevokeRefusals: [
        {
            groupId,
            subscriptionId: 'sub_h',
            status: 'unpaid',
            refusal: 'status:409',
            since: iso(6),
        },
    ],
    unlistedFamilies: [
        { groupId, since: iso(7) },
        { groupId: workspaceId, since: null },
    ],
    orphanedPlans: [
        {
            groupId,
            why: 'second-plan',
            subscriptionId: 'sub_i',
            status: 'canceled',
            revoked: true,
            refunded: 999,
            toRefund: 0,
            currency: 'usd',
            since: iso(2),
        },
        {
            groupId: workspaceId,
            why: 'deleted-family',
            subscriptionId: 'sub_j',
            status: 'active',
            revoked: false,
            refunded: 0,
            toRefund: 2,
            currency: 'eur',
            since: iso(1),
        },
    ],
};
/* Nothing to act on: every list empty, nothing audited yet, nothing stored. */
const quietOverview: Overview = {
    ...overview,
    workspaces: { total: 0, usedBytes: '0' },
    objects: { ...overview.objects, bytes: '0', lastAuditedAt: null },
    missing: [],
    stuckPlanChanges: [],
    refundsOwed: [],
    unrefundable: [],
    doubleCharges: [],
    lapsedRevokeRefusals: [],
    unlistedFamilies: [],
    orphanedPlans: [],
};

type Account = Reply<typeof auth.getAdminAccount>;
const account: Account = {
    id: uploader,
    name: 'Ada',
    email: 'ada@example.com',
    role: 'member',
    suspendedAt: iso(9),
    createdAt: iso(1),
    emailVerifiedAt: iso(1),
    workspaceId,
    baseQuotaBytes: GiB(5),
    usedBytes: GiB(3),
    reservedBytes: '1048576',
    quotaBytes: GiB(105),
    lastSeenAt: iso(8),
    grants: [
        {
            id: entitlementId,
            source: 'admin',
            quotaBytes: GiB(100),
            startsAt: iso(2),
            expiresAt: iso(20),
            revokedAt: null,
            grantedByEmail: 'operator@example.com',
            note: 'Support case 41.',
        },
        // A plan's: nobody granted it by hand.
        {
            id: eventId,
            source: 'polar',
            quotaBytes: GiB(200),
            startsAt: iso(1),
            expiresAt: null,
            revokedAt: iso(4),
            grantedByEmail: null,
            note: null,
        },
    ],
    activeSessions: 0,
    reports: { total: 2, open: 1 },
    objects: { ready: 120, missing: 1 },
};
/* An operator with no storage yet and no session on record. */
const bareAccount: Account = {
    ...account,
    id: operator,
    role: 'admin',
    suspendedAt: null,
    workspaceId: null,
    baseQuotaBytes: null,
    usedBytes: null,
    reservedBytes: null,
    quotaBytes: null,
    lastSeenAt: null,
    grants: [],
    reports: { total: 0, open: 0 },
    objects: { ready: 0, missing: 0 },
};

/*
 * Per route: the replies the package can give, the objects a new column would surface in (a stray
 * field is planted there and at the top), and a field the reply cannot go out without.
 */
type Case = {
    schema: AnySchema;
    /* The status the route answers with, when not 200. */
    status?: 503;
    samples: Record<string, unknown>;
    stray: (value: any) => Record<string, unknown>[];
    /* The samples a nested stray can be planted in, when some have nowhere to put one. */
    strayIn?: string[];
    /* Which sample to cut, and the cut. */
    required: [string, (value: any) => void];
};
const reportParts = (r: any) => [r, r.reporter, r.uploader];
const nodeParts = (n: any) =>
    [n, n.metadataSigner, n.currentVersion, n.currentVersion?.signer].filter(Boolean);
const cases: Record<string, Case> = {
    'GET /admin/reports': {
        schema: reportsResponse,
        samples: {
            'every kind': {
                reports: [openReport, filedReport, releasedReport, ownerlessReport],
                counts: { open: 1, held: 2, total: 4 },
            } satisfies Reply<typeof drive.listReports>,
            none: { reports: [], counts: { open: 0, held: 0, total: 0 } } satisfies Reply<
                typeof drive.listReports
            >,
        },
        stray: (v) => [v.counts, ...v.reports.flatMap(reportParts)],
        required: ['every kind', (v) => delete v.reports[2].uploader.suspended],
    },
    'GET /admin/reports/:id': {
        schema: reportDetailResponse,
        samples: {
            'held, with notes': { report: openReport, events: [reported, noted] } satisfies Reply<
                typeof drive.getReport
            >,
            released: { report: releasedReport, events: [reported] } satisfies Reply<
                typeof drive.getReport
            >,
        },
        stray: (v) => [...reportParts(v.report), ...v.events],
        required: ['held, with notes', (v) => delete v.events[0].actorUserId],
    },
    'POST /admin/reports/:id/open': {
        schema: openedReportResponse,
        samples: {
            'a folder, sealed to this operator': {
                report: openReport,
                node: folder,
                keyEnvelope: b64(1224, 8),
            } satisfies Reply<typeof drive.openReport>,
            // Filed before this operator was one: nothing sealed to them yet.
            'a file, nothing sealed to this operator': {
                report: filedReport,
                node: file,
                keyEnvelope: null,
            } satisfies Reply<typeof drive.openReport>,
        },
        stray: (v) => [...reportParts(v.report), ...nodeParts(v.node)],
        required: ['a folder, sealed to this operator', (v) => delete v.keyEnvelope],
    },
    'GET /admin/reports/:id/nodes/:nodeId/children': {
        schema: reportChildrenResponse,
        samples: {
            'a folder with a file': {
                folder: { ...folder, id: childId, parentId: nodeId },
                ancestors: [folder],
                children: [file],
                nextCursor: null,
            } satisfies Reply<typeof drive.reportChildren>,
            'the reported folder, empty': {
                folder,
                ancestors: [],
                children: [],
                nextCursor: null,
            } satisfies Reply<typeof drive.reportChildren>,
        },
        stray: (v) => [
            ...nodeParts(v.folder),
            ...v.ancestors.flatMap(nodeParts),
            ...v.children.flatMap(nodeParts),
        ],
        required: ['a folder with a file', (v) => delete v.children[0].currentVersion.contentNonce],
    },
    'POST /admin/reports/:id/versions/urls and GET .../thumbnails': {
        schema: reportUrlsResponse,
        samples: {
            two: {
                urls: [
                    { versionId, url: presigned(objectId) },
                    { versionId: eventId, url: presigned(requestId) },
                ],
                urlExpiresAt: iso(13),
            } satisfies Reply<typeof drive.reportDownloadUrls>,
            // None readable: a version id not in the snapshot is left out.
            none: { urls: [], urlExpiresAt: iso(13) } satisfies Reply<
                typeof drive.reportThumbnailUrls
            >,
        },
        stray: (v) => v.urls,
        strayIn: ['two'],
        required: ['two', (v) => delete v.urlExpiresAt],
    },
    'GET /admin/reports/:id/versions/:versionId/url': {
        schema: reportDownloadUrlResponse,
        samples: {
            signed: {
                url: presigned(objectId),
                urlExpiresAt: iso(13),
                node: { ...file, currentVersion: version },
                version,
            } satisfies Reply<typeof drive.reportDownloadUrl>,
        },
        stray: (v) => [...nodeParts(v.node), v.version, v.version.signer],
        required: ['signed', (v) => delete v.version.chunkCount],
    },
    'POST /admin/reports/:id/evidence and GET .../evidence/:requestId': {
        schema: evidenceRequestResponse,
        samples: {
            pending: {
                request: {
                    id: requestId,
                    status: 'pending',
                    urls: null,
                    urlExpiresAt: null,
                    error: null,
                    createdAt: iso(10),
                },
            } satisfies Reply<typeof drive.requestEvidence>,
            ready: {
                request: {
                    id: requestId,
                    status: 'ready',
                    urls: { [versionId]: presigned('evidence-a'), [eventId]: presigned('e-b') },
                    urlExpiresAt: iso(11),
                    error: null,
                    createdAt: iso(10),
                },
            } satisfies Reply<typeof drive.getEvidenceRequest>,
            failed: {
                request: {
                    id: requestId,
                    status: 'failed',
                    urls: null,
                    urlExpiresAt: null,
                    error: 'The evidence store refused the request.',
                    createdAt: iso(10),
                },
            } satisfies Reply<typeof drive.getEvidenceRequest>,
        },
        // Not inside `urls`: its keys are version ids, any of which goes out.
        stray: (v) => [v.request],
        required: ['ready', (v) => delete v.request.urlExpiresAt],
    },
    'GET /admin/reports/:id/keys': {
        schema: reportKeyHoldersResponse,
        samples: {
            'one sealed, one promoted since': {
                operators: [
                    { ...identity(1), userId: operator, sealed: true },
                    { ...identity(2), userId: newOperator, sealed: false },
                ],
            } satisfies Reply<typeof drive.reportKeyHolders>,
            // A version 1 identity: no ML-DSA key, KEM key or statement.
            'a version 1 operator': {
                operators: [
                    {
                        keyVersion: 1,
                        identityVersion: 1,
                        encryptionPublicKey: b64(32, 3),
                        signingPublicKey: b64(32, 4),
                        mlDsaPublicKey: null,
                        kemPublicKey: null,
                        keysSignature: null,
                        userId: operator,
                        sealed: true,
                    },
                ],
            } satisfies Reply<typeof drive.reportKeyHolders>,
            'no operators': { operators: [] } satisfies Reply<typeof drive.reportKeyHolders>,
        },
        stray: (v) => v.operators,
        strayIn: ['one sealed, one promoted since', 'a version 1 operator'],
        required: ['one sealed, one promoted since', (v) => delete v.operators[1].sealed],
    },
    'POST /admin/reports/:id/keys': {
        schema: resealedReportResponse,
        samples: {
            added: { added: 1 } satisfies Reply<typeof drive.resealReport>,
            'all already held': { added: 0 } satisfies Reply<typeof drive.resealReport>,
        },
        stray: () => [],
        strayIn: [],
        required: ['added', (v) => delete v.added],
    },
    'POST /admin/reports/:id/{resolve,hold,reopen,uploader}': {
        schema: reportResponse,
        samples: {
            filed: { report: filedReport } satisfies Reply<typeof drive.resolveReport>,
            'released by a dismissal': { report: releasedReport } satisfies Reply<
                typeof drive.resolveReport
            >,
            held: { report: openReport } satisfies Reply<typeof drive.holdReport>,
            reopened: { report: { ...filedReport, status: 'open' } } satisfies Reply<
                typeof drive.reopenReport
            >,
            'uploader reinstated': {
                report: { ...openReport, uploader: { ...openReport.uploader, suspended: false } },
            } satisfies Reply<typeof drive.suspendUploader>,
            'no uploader on record': { report: ownerlessReport } satisfies Reply<
                typeof drive.holdReport
            >,
        },
        stray: (v) => reportParts(v.report),
        required: ['filed', (v) => delete v.report.filedReference],
    },
    'POST /admin/reports/:id/{notes,packet}': {
        schema: reportEventResponse,
        samples: {
            note: { event: noted } satisfies Reply<typeof drive.noteReport>,
            packet: {
                event: { ...noted, action: 'packet', note: null },
            } satisfies Reply<typeof drive.recordPacket>,
        },
        stray: (v) => [v.event],
        required: ['note', (v) => delete v.event.note],
    },
    'GET /admin/overview': {
        schema: overviewResponse,
        samples: { 'everything to act on': overview, quiet: quietOverview },
        stray: (v) =>
            [v.people, v.workspaces, v.objects, v.outbox, v.reports].concat(
                v.missing,
                v.stuckPlanChanges,
                v.refundsOwed,
                v.unrefundable,
                v.doubleCharges,
                v.doubleCharges.flatMap((row: any) => row.subscriptions),
                v.lapsedRevokeRefusals,
                v.unlistedFamilies,
                v.orphanedPlans,
            ),
        required: ['everything to act on', (v) => delete v.refundsOwed[1].userId],
    },
    'GET /admin/accounts': {
        schema: accountsResponse,
        samples: {
            'a page': {
                total: 51,
                pageSize: 50,
                accounts: [
                    {
                        id: uploader,
                        name: 'Ada',
                        email: 'ada@example.com',
                        role: 'member',
                        suspendedAt: iso(9),
                        createdAt: iso(1),
                        workspaceId,
                        usedBytes: GiB(3),
                        quotaBytes: GiB(105),
                        lastSeenAt: iso(8),
                    },
                    // No storage yet, never signed in since sessions were kept.
                    {
                        id: operator,
                        name: 'Grace',
                        email: 'grace@example.com',
                        role: 'admin',
                        suspendedAt: null,
                        createdAt: iso(0),
                        workspaceId: null,
                        usedBytes: '0',
                        quotaBytes: null,
                        lastSeenAt: null,
                    },
                ],
            } satisfies Reply<typeof auth.listAdminAccounts>,
            'no match': { total: 0, pageSize: 50, accounts: [] } satisfies Reply<
                typeof auth.listAdminAccounts
            >,
        },
        stray: (v) => v.accounts,
        strayIn: ['a page'],
        required: ['a page', (v) => delete v.accounts[1].quotaBytes],
    },
    'GET /admin/accounts/:id': {
        schema: accountResponse,
        samples: { 'suspended, with grants': account, 'no storage': bareAccount },
        stray: (v) => [v.reports, v.objects, ...v.grants],
        required: ['suspended, with grants', (v) => delete v.grants[1].grantedByEmail],
    },
    'POST /admin/accounts/:id/suspension': {
        schema: suspensionResponse,
        samples: {
            suspended: { suspendedAt: iso(9) } satisfies Pick<
                Reply<typeof auth.setAdminAccountSuspended>,
                'suspendedAt'
            >,
            reinstated: { suspendedAt: null } satisfies Pick<
                Reply<typeof auth.setAdminAccountSuspended>,
                'suspendedAt'
            >,
        },
        stray: () => [],
        strayIn: [],
        required: ['reinstated', (v) => delete v.suspendedAt],
    },
    'POST /admin/accounts/:id/storage': {
        schema: storageGrantResponse,
        samples: {
            granted: { entitlementId, quotaBytes: GiB(105) } satisfies Pick<
                Reply<typeof auth.grantAdminAccountStorage>,
                'entitlementId' | 'quotaBytes'
            >,
        },
        stray: () => [],
        strayIn: [],
        required: ['granted', (v) => delete v.entitlementId],
    },
    'POST /admin/accounts/:id/storage/:entitlementId/revoke': {
        schema: storageRevokedResponse,
        samples: {
            revoked: { quotaBytes: GiB(5) } satisfies Pick<
                Reply<typeof auth.revokeAdminAccountStorage>,
                'quotaBytes'
            >,
        },
        stray: () => [],
        strayIn: [],
        required: ['revoked', (v) => delete v.quotaBytes],
    },
    'GET /admin/workspaces': {
        schema: workspacesResponse,
        samples: {
            'a page': {
                total: 2,
                pageSize: 50,
                workspaces: [
                    {
                        id: workspaceId,
                        createdAt: iso(1),
                        ownerId: uploader,
                        ownerEmail: 'ada@example.com',
                        usedBytes: GiB(3),
                        quotaBytes: GiB(105),
                        missing: 1,
                    },
                    // A family's folder: no personal owner, no storage row.
                    {
                        id: groupId,
                        createdAt: iso(2),
                        ownerId: null,
                        ownerEmail: null,
                        usedBytes: '0',
                        quotaBytes: null,
                        missing: 0,
                    },
                ],
            } satisfies Reply<typeof auth.listAdminWorkspaces>,
            none: { total: 0, pageSize: 50, workspaces: [] } satisfies Reply<
                typeof auth.listAdminWorkspaces
            >,
        },
        stray: (v) => v.workspaces,
        strayIn: ['a page'],
        required: ['a page', (v) => delete v.workspaces[0].missing],
    },
    'GET /health': {
        schema: healthResponse,
        samples: { up: { status: 'ok', service: API_SERVICE } },
        stray: () => [],
        strayIn: [],
        required: ['up', (v) => delete v.service],
    },
    'GET /ready (the database answers)': {
        schema: readyResponse,
        samples: { ready: { status: 'ok' } },
        stray: () => [],
        strayIn: [],
        required: ['ready', (v) => delete v.status],
    },
    'GET /ready (the database is down)': {
        schema: unavailableResponse,
        status: 503,
        samples: { down: { status: 'unavailable' } },
        stray: () => [],
        strayIn: [],
        required: ['down', (v) => delete v.status],
    },
};

describe.each(Object.entries(cases))(
    '%s',
    (_route, { schema, status, samples, stray, strayIn, required }) => {
        test.each(Object.entries(samples))('goes out unchanged: %s', async (_name, sample) => {
            expect(await serve(schema, sample, status)).toEqual({
                status: status ?? 200,
                body: sample,
            });
        });

        test.each(Object.entries(samples))(
            'drops a field the schema does not name: %s',
            async (name, sample) => {
                const planted = clone(sample) as Record<string, unknown>;
                planted.leaked = 'top';
                const nested = stray(planted);
                // Where the sample has objects inside, the stray goes in every one of them.
                if (!strayIn || strayIn.includes(name)) expect(nested.length).toBeGreaterThan(0);
                for (const object of nested) object.reporterAddressHash = 'nested';
                const { status: served, body } = await serve(schema, planted, status);
                expect(served).toBe(status ?? 200);
                expect(body).toEqual(sample);
                expect(JSON.stringify(body)).not.toMatch(/leaked|reporterAddressHash/);
            },
        );

        test('fails rather than send a reply missing a required field', async () => {
            const [name, cut] = required;
            const short = clone(samples[name]);
            cut(short);
            expect((await serve(schema, short, status)).status).toBe(500);
        });
    },
);

/* Every category a report can be filed under goes out; the schema spells the list out by hand. */
test('passes every report category', async () => {
    for (const category of REPORT_CATEGORIES) {
        const value = { report: { ...openReport, category } };
        expect(await serve(reportResponse, value), category).toEqual({ status: 200, body: value });
    }
});

/* A status, category, kind or role outside the database's own set fails rather than going out. */
test('refuses a value outside its set', async () => {
    const refused: [AnySchema, unknown][] = [
        [reportResponse, { report: { ...openReport, status: 'closed' } }],
        [reportResponse, { report: { ...openReport, category: 'spam' } }],
        [reportResponse, { report: { ...openReport, evidenceStatus: 'lost' } }],
        [reportResponse, { report: { ...openReport, via: 'email' } }],
        [reportResponse, { report: { ...openReport, nodeKind: 'link' } }],
        [
            evidenceRequestResponse,
            {
                request: {
                    ...(
                        cases['POST /admin/reports/:id/evidence and GET .../evidence/:requestId']!
                            .samples.pending as any
                    ).request,
                    status: 'expired',
                },
            },
        ],
        [accountResponse, { ...account, role: 'owner' }],
        [
            overviewResponse,
            { ...overview, orphanedPlans: [{ ...overview.orphanedPlans[0]!, why: 'refunded' }] },
        ],
        [
            overviewResponse,
            { ...overview, doubleCharges: [{ ...overview.doubleCharges[0]!, kind: 'household' }] },
        ],
    ];
    for (const [schema, value] of refused) expect((await serve(schema, value)).status).toBe(500);
});

/* Evidence URLs are keyed by version id, so any key goes out; a value that is not a URL string fails. */
test("an evidence request's URLs keep every version id and refuse a value that is not a string", async () => {
    const ready = cases['POST /admin/reports/:id/evidence and GET .../evidence/:requestId']!.samples
        .ready as Reply<typeof drive.getEvidenceRequest>;
    const served = await serve(evidenceRequestResponse, ready);
    expect(Object.keys((served.body as typeof ready).request.urls!)).toEqual([versionId, eventId]);
    const wrong = clone(ready) as any;
    wrong.request.urls[versionId] = { url: presigned('evidence-a') };
    expect((await serve(evidenceRequestResponse, wrong)).status).toBe(500);
});

/* Readiness: each answer is held to its own status's shape, so neither can pass as the other. */
test('a readiness answer under the wrong status fails', async () => {
    expect((await serve(readyResponse, { status: 'unavailable' })).status).toBe(500);
    expect((await serve(unavailableResponse, { status: 'ok' }, 503)).status).toBe(500);
});

/*
 * The real system routes, with the database out of reach (port 1): health answers, readiness
 * answers 503 through its declared schema rather than a 500 for a reply the schema refused.
 */
test('the real health and readiness routes answer through their schemas', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@127.0.0.1:1/test');
    const app = await loadApi();
    const health = await app.handle(new Request('http://localhost/api/health'));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', service: API_SERVICE });
    const ready = await app.handle(new Request('http://localhost/api/ready'));
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: 'unavailable' });
});

/* The schemas guard nothing unless the routes carry them: every operator and system route names its own. */
const expectedSchemas: Record<string, { 200: AnySchema; 503?: AnySchema }> = {
    'GET /api/admin/reports': { 200: reportsResponse },
    'GET /api/admin/reports/:id': { 200: reportDetailResponse },
    'POST /api/admin/reports/:id/open': { 200: openedReportResponse },
    'GET /api/admin/reports/:id/nodes/:nodeId/children': { 200: reportChildrenResponse },
    'POST /api/admin/reports/:id/versions/urls': { 200: reportUrlsResponse },
    'GET /api/admin/reports/:id/versions/:versionId/url': { 200: reportDownloadUrlResponse },
    'GET /api/admin/reports/:id/thumbnails': { 200: reportUrlsResponse },
    'POST /api/admin/reports/:id/evidence': { 200: evidenceRequestResponse },
    'GET /api/admin/reports/:id/evidence/:requestId': { 200: evidenceRequestResponse },
    'GET /api/admin/reports/:id/keys': { 200: reportKeyHoldersResponse },
    'POST /api/admin/reports/:id/keys': { 200: resealedReportResponse },
    'POST /api/admin/reports/:id/packet': { 200: reportEventResponse },
    'POST /api/admin/reports/:id/resolve': { 200: reportResponse },
    'POST /api/admin/reports/:id/hold': { 200: reportResponse },
    'POST /api/admin/reports/:id/reopen': { 200: reportResponse },
    'POST /api/admin/reports/:id/uploader': { 200: reportResponse },
    'POST /api/admin/reports/:id/notes': { 200: reportEventResponse },
    'GET /api/admin/overview': { 200: overviewResponse },
    'GET /api/admin/accounts': { 200: accountsResponse },
    'GET /api/admin/accounts/:id': { 200: accountResponse },
    'POST /api/admin/accounts/:id/suspension': { 200: suspensionResponse },
    'POST /api/admin/accounts/:id/storage': { 200: storageGrantResponse },
    'POST /api/admin/accounts/:id/storage/:entitlementId/revoke': { 200: storageRevokedResponse },
    'GET /api/admin/workspaces': { 200: workspacesResponse },
    'GET /api/health': { 200: healthResponse },
    'GET /api/ready': { 200: readyResponse, 503: unavailableResponse },
};
/*
 * Routes deliberately served without a schema, each with its reason. None today: every handler
 * answers JSON built field by field, the packet route included (it puts the download on the
 * record; the page builds the packet itself), and readiness declares its 503 as well as its 200.
 */
const leftOut: Record<string, string> = {};

test('each operator and system route carries its reply schema', async () => {
    const app = await loadApi();
    const routes = (
        app.routes as unknown as (ApiRoute & { hooks: { response?: unknown } })[]
    ).filter(
        (r) => r.path.startsWith('/api/admin/') || ['/api/health', '/api/ready'].includes(r.path),
    );
    for (const [key, statuses] of Object.entries(expectedSchemas)) {
        const [method, path] = key.split(' ');
        const route = routes.find((r) => r.method === method && r.path === path);
        expect(route, key).toBeDefined();
        const response = route!.hooks.response as Record<number, unknown>;
        // A status the route answers with but has no schema for goes out unchecked.
        expect(Object.keys(response).sort(), key).toEqual(Object.keys(statuses).sort());
        for (const [status, schema] of Object.entries(statuses))
            // Elysia keeps a copy of each schema, so equal in structure, not the same object.
            expect(response[Number(status)], `${key} ${status}`).toEqual(schema);
    }
    // A route added later without a schema, or one this list forgot, fails here.
    const unlisted = routes
        .map((r) => `${r.method} ${r.path}`)
        .filter((key) => !(key in expectedSchemas) && !(key in leftOut));
    expect(unlisted).toEqual([]);
});
