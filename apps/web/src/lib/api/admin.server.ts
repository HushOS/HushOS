import '@/lib/server-only';
import { Elysia, t } from 'elysia';
import * as auth from '@hushos/auth/server';
import { REPORT_CATEGORIES } from '@hushos/drive/api';
import * as drive from '@hushos/drive/server';
import { useLogger } from '@/lib/logging.server';
import {
    accountResponse,
    accountsResponse,
    evidenceRequestResponse,
    openedReportResponse,
    overviewResponse,
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
    workspacesResponse,
} from '@/lib/api/admin-responses.server';
import {
    MAX_REPORT_OPERATORS,
    guards,
    reportEnvelopeSchema,
    uuidSchema,
} from '@/lib/api/shared.server';

/* The operator's side: reports, accounts and workspaces (/api/admin). A 404 to anyone else. */
export const adminApi = new Elysia().use(guards).guard({ mutation: true, admin: true }, (app) =>
    app
        // The operator's side: every route is a 404 to anyone but an operator.
        .get(
            '/admin/reports',
            {
                query: t.Object({
                    status: t.Optional(
                        t.Union([
                            t.Literal('open'),
                            t.Literal('dismissed'),
                            t.Literal('removed'),
                            t.Literal('filed'),
                            t.Literal('all'),
                            t.Literal('held'),
                        ]),
                    ),
                    // Not UnionEnum: Elysia fills an absent optional UnionEnum query field with its first value.
                    category: t.Optional(
                        t.Union(REPORT_CATEGORIES.map((value) => t.Literal(value))),
                    ),
                }),
                response: { 200: reportsResponse },
            },
            async ({ query, set }) => {
                set.headers['Cache-Control'] = 'no-store';
                return drive.listReports(query);
            },
        )
        .get(
            '/admin/reports/:id',
            { params: t.Object({ id: uuidSchema }), response: { 200: reportDetailResponse } },
            async ({ params, set }) => {
                set.headers['Cache-Control'] = 'no-store';
                return drive.getReport(params.id);
            },
        )
        .post(
            '/admin/reports/:id/open',
            {
                params: t.Object({ id: uuidSchema }),
                body: t.Object({}),
                response: { 200: openedReportResponse },
            },
            async ({ operator, params }) => {
                return drive.openReport(operator.id, params.id);
            },
        )
        .get(
            '/admin/reports/:id/nodes/:nodeId/children',
            {
                params: t.Object({ id: uuidSchema, nodeId: uuidSchema }),
                response: { 200: reportChildrenResponse },
            },
            async ({ params }) => {
                return drive.reportChildren(params.id, params.nodeId);
            },
        )
        .post(
            '/admin/reports/:id/versions/urls',
            {
                params: t.Object({ id: uuidSchema }),
                body: t.Object({ versionIds: t.Array(uuidSchema, { minItems: 1, maxItems: 100 }) }),
                response: { 200: reportUrlsResponse },
            },
            async ({ params, body }) => {
                return drive.reportDownloadUrls(params.id, body.versionIds);
            },
        )
        .get(
            '/admin/reports/:id/versions/:versionId/url',
            {
                params: t.Object({ id: uuidSchema, versionId: uuidSchema }),
                response: { 200: reportDownloadUrlResponse },
            },
            async ({ params }) => {
                return drive.reportDownloadUrl(params.id, params.versionId);
            },
        )
        .get(
            '/admin/reports/:id/thumbnails',
            {
                params: t.Object({ id: uuidSchema }),
                query: t.Object({ versions: t.String({ minLength: 36, maxLength: 3700 }) }),
                response: { 200: reportUrlsResponse },
            },
            async ({ params, query }) => {
                return drive.reportThumbnailUrls(
                    params.id,
                    query.versions.split(',').filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
                );
            },
        )
        .post(
            '/admin/reports/:id/evidence',
            {
                params: t.Object({ id: uuidSchema }),
                body: t.Object({}),
                response: { 200: evidenceRequestResponse },
            },
            async ({ operator, params }) => {
                return drive.requestEvidence(operator.id, params.id);
            },
        )
        .get(
            '/admin/reports/:id/evidence/:requestId',
            {
                params: t.Object({ id: uuidSchema, requestId: uuidSchema }),
                response: { 200: evidenceRequestResponse },
            },
            async ({ params, set }) => {
                set.headers['Cache-Control'] = 'no-store';
                return drive.getEvidenceRequest(params.id, params.requestId);
            },
        )
        .get(
            '/admin/reports/:id/keys',
            { params: t.Object({ id: uuidSchema }), response: { 200: reportKeyHoldersResponse } },
            async ({ params, set }) => {
                set.headers['Cache-Control'] = 'no-store';
                return drive.reportKeyHolders(params.id);
            },
        )
        .post(
            '/admin/reports/:id/keys',
            {
                params: t.Object({ id: uuidSchema }),
                body: t.Object({
                    keys: t.Array(
                        t.Object({
                            operatorUserId: uuidSchema,
                            keyEnvelope: reportEnvelopeSchema,
                        }),
                        // One envelope per current operator; an instance with more operators than this cannot take reports.
                        { minItems: 1, maxItems: MAX_REPORT_OPERATORS },
                    ),
                }),
                response: { 200: resealedReportResponse },
            },
            async ({ operator, params, body }) => {
                return drive.resealReport(operator.id, params.id, body.keys);
            },
        )
        .post(
            '/admin/reports/:id/packet',
            {
                params: t.Object({ id: uuidSchema }),
                body: t.Object({}),
                response: { 200: reportEventResponse },
            },
            async ({ operator, params }) => {
                return drive.recordPacket(operator.id, params.id);
            },
        )
        .post(
            '/admin/reports/:id/resolve',
            {
                params: t.Object({ id: uuidSchema }),
                body: t.Union([
                    t.Object({ status: t.Literal('dismissed'), hold: t.Boolean() }),
                    t.Object({ status: t.Literal('removed'), hold: t.Boolean() }),
                    t.Object({
                        status: t.Literal('filed'),
                        filedWith: t.String({ minLength: 1, maxLength: 200 }),
                        filedReference: t.Nullable(t.String({ maxLength: 200 })),
                    }),
                ]),
                response: { 200: reportResponse },
            },
            async ({ operator, params, body }) => {
                return drive.resolveReport(operator.id, params.id, body);
            },
        )
        .post(
            '/admin/reports/:id/hold',
            {
                params: t.Object({ id: uuidSchema }),
                body: t.Object({ held: t.Boolean() }),
                response: { 200: reportResponse },
            },
            async ({ operator, params, body }) => {
                return drive.holdReport(operator.id, params.id, body.held);
            },
        )
        .post(
            '/admin/reports/:id/reopen',
            {
                params: t.Object({ id: uuidSchema }),
                body: t.Object({}),
                response: { 200: reportResponse },
            },
            async ({ operator, params }) => {
                return drive.reopenReport(operator.id, params.id);
            },
        )
        .post(
            '/admin/reports/:id/uploader',
            {
                params: t.Object({ id: uuidSchema }),
                body: t.Object({ suspended: t.Boolean() }),
                response: { 200: reportResponse },
            },
            async ({ operator, params, body }) => {
                return drive.suspendUploader(operator.id, params.id, body.suspended);
            },
        )
        .post(
            '/admin/reports/:id/notes',
            {
                params: t.Object({ id: uuidSchema }),
                body: t.Object({ note: t.String({ minLength: 1, maxLength: 2000 }) }),
                response: { 200: reportEventResponse },
            },
            async ({ operator, params, body }) => {
                return drive.noteReport(operator.id, params.id, body.note);
            },
        )
        .get(
            '/admin/overview',
            { response: { 200: overviewResponse } },
            async ({ sessionToken, set }) => {
                set.headers['Cache-Control'] = 'no-store';
                return auth.getAdminOverview(sessionToken);
            },
        )
        // Not UnionEnum: Elysia fills an absent optional UnionEnum query field with its first value.
        .get(
            '/admin/accounts',
            {
                query: t.Object({
                    role: t.Optional(t.Union([t.Literal('admin'), t.Literal('member')])),
                    q: t.Optional(t.String({ maxLength: 254 })),
                    sort: t.Optional(t.Union([t.Literal('joined'), t.Literal('stored')])),
                    offset: t.Optional(t.Numeric({ minimum: 0, maximum: 1_000_000 })),
                }),
                response: { 200: accountsResponse },
            },
            async ({ sessionToken, query, set }) => {
                set.headers['Cache-Control'] = 'no-store';
                return auth.listAdminAccounts(sessionToken, {
                    role: query.role,
                    query: query.q,
                    sort: query.sort,
                    offset: query.offset,
                });
            },
        )
        .get(
            '/admin/accounts/:id',
            { params: t.Object({ id: uuidSchema }), response: { 200: accountResponse } },
            async ({ sessionToken, params, set }) => {
                set.headers['Cache-Control'] = 'no-store';
                return auth.getAdminAccount(sessionToken, params.id);
            },
        )
        .post(
            '/admin/accounts/:id/suspension',
            {
                params: t.Object({ id: uuidSchema }),
                body: t.Object({ suspended: t.Boolean() }),
                response: { 200: suspensionResponse },
            },
            async ({ sessionToken, params, body }) => {
                const result = await auth.setAdminAccountSuspended(
                    sessionToken,
                    params.id,
                    body.suspended,
                );
                // There is no audit table yet; the request log is the record of who did it.
                useLogger().set({
                    admin: {
                        action: body.suspended ? 'account-suspended' : 'account-reinstated',
                        operatorId: result.operatorId,
                        accountId: params.id,
                    },
                });
                return { suspendedAt: result.suspendedAt };
            },
        )
        .post(
            '/admin/accounts/:id/storage',
            {
                params: t.Object({ id: uuidSchema }),
                body: t.Object({
                    // Decimal bytes, as every byte count on the wire; the bound is the server's.
                    quotaBytes: t.String({ pattern: '^[0-9]{1,20}$' }),
                    expiresAt: t.Optional(t.Nullable(t.String({ format: 'date-time' }))),
                    note: t.Optional(t.Nullable(t.String({ maxLength: 500 }))),
                }),
                response: { 200: storageGrantResponse },
            },
            async ({ sessionToken, params, body }) => {
                const result = await auth.grantAdminAccountStorage(sessionToken, params.id, body);
                useLogger().set({
                    admin: {
                        action: 'storage-granted',
                        operatorId: result.operatorId,
                        accountId: params.id,
                    },
                });
                return { entitlementId: result.entitlementId, quotaBytes: result.quotaBytes };
            },
        )
        .post(
            '/admin/accounts/:id/storage/:entitlementId/revoke',
            {
                params: t.Object({ id: uuidSchema, entitlementId: uuidSchema }),
                body: t.Object({}),
                response: { 200: storageRevokedResponse },
            },
            async ({ sessionToken, params }) => {
                const result = await auth.revokeAdminAccountStorage(
                    sessionToken,
                    params.id,
                    params.entitlementId,
                );
                useLogger().set({
                    admin: {
                        action: 'storage-revoked',
                        operatorId: result.operatorId,
                        accountId: params.id,
                    },
                });
                return { quotaBytes: result.quotaBytes };
            },
        )
        .get(
            '/admin/workspaces',
            {
                query: t.Object({
                    sort: t.Optional(t.Union([t.Literal('stored'), t.Literal('created')])),
                    offset: t.Optional(t.Numeric({ minimum: 0, maximum: 1_000_000 })),
                }),
                response: { 200: workspacesResponse },
            },
            async ({ sessionToken, query, set }) => {
                set.headers['Cache-Control'] = 'no-store';
                return auth.listAdminWorkspaces(sessionToken, query);
            },
        ),
);
