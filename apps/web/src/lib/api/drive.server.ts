import '@/lib/server-only';
import { Elysia, t } from 'elysia';
import * as auth from '@hushos/auth/server';
import { LINK_TOKEN_HEADER } from '@hushos/drive/protocol';
import { REPORT_CATEGORIES } from '@hushos/drive/api';
import * as drive from '@hushos/drive/server';
import * as groups from '@hushos/groups/server';
import {
    MAX_REPORT_OPERATORS,
    anyVersionEnvelopeSchema,
    cursorSchema,
    describeFailure,
    documentEnvelopeSchema,
    documentKindSchema,
    emailSchema,
    epochSchema,
    guards,
    idSeedSchema,
    keyEnvelopeSchema,
    linkHeadersSchema,
    linkSaltSchema,
    linkSecretSchema,
    linkTokenSchema,
    metadataEnvelopeSchema,
    nodeBatchSchema,
    nodeEnvelopesSchema,
    partSchema,
    reportEnvelopeSchema,
    requestAddress,
    requireClient,
    rotatedNodeSchema,
    shareEnvelopeSchema,
    signatureSchema,
    trashCursorSchema,
    uploadNodeSchema,
    uuidSchema,
    versionEnvelopeSchema,
} from '@/lib/api/shared.server';

/* Drive: workspaces, nodes, uploads, versions, shares, links, reports and spaces (/api/drive). */
export const driveApi = new Elysia()
    .use(guards)
    .get('/drive/capabilities', ({ request, set }) => {
        requireClient(request);
        set.headers['Cache-Control'] = 'public, max-age=300';
        return drive.capabilities();
    })
    /*
     * The visitor's surface: no session, the token in the x-link-token header names
     * the link (never the path, which reverse proxies log), bounded per address and
     * token. The paths that carried the token answer 410 so an old client says why.
     */
    .get('/drive/links/open', { headers: linkHeadersSchema }, ({ request, headers }) => {
        requireClient(request);
        return drive.openLink(headers[LINK_TOKEN_HEADER], requestAddress(request));
    })
    .get(
        '/drive/links/nodes/:nodeId/children',
        {
            headers: linkHeadersSchema,
            params: t.Object({ nodeId: uuidSchema }),
            query: t.Object({ after: cursorSchema }),
        },
        ({ request, headers, params, query }) => {
            requireClient(request);
            return drive.linkChildren(
                headers[LINK_TOKEN_HEADER],
                requestAddress(request),
                params.nodeId,
                query.after,
            );
        },
    )
    .get(
        '/drive/links/versions/:versionId/url',
        { headers: linkHeadersSchema, params: t.Object({ versionId: uuidSchema }) },
        ({ request, headers, params }) => {
            requireClient(request);
            return drive.linkDownloadUrl(
                headers[LINK_TOKEN_HEADER],
                requestAddress(request),
                params.versionId,
            );
        },
    )
    .post(
        '/drive/links/versions/urls',
        {
            headers: linkHeadersSchema,
            body: t.Object({ versionIds: t.Array(uuidSchema, { minItems: 1, maxItems: 100 }) }),
        },
        ({ request, headers, body }) => {
            requireClient(request);
            return drive.linkDownloadUrls(
                headers[LINK_TOKEN_HEADER],
                requestAddress(request),
                body.versionIds,
            );
        },
    )
    .get(
        '/drive/links/thumbnails',
        {
            headers: linkHeadersSchema,
            query: t.Object({ versions: t.String({ minLength: 36, maxLength: 3700 }) }),
        },
        ({ request, headers, query }) => {
            requireClient(request);
            return drive.linkThumbnailUrls(
                headers[LINK_TOKEN_HEADER],
                requestAddress(request),
                query.versions.split(',').filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
            );
        },
    )
    .get('/drive/links/:id/open', () => drive.linkPathRetired())
    .get('/drive/links/:id/nodes/:nodeId/children', () => drive.linkPathRetired())
    .get('/drive/links/:id/versions/:versionId/url', () => drive.linkPathRetired())
    .post('/drive/links/:id/versions/urls', () => drive.linkPathRetired())
    .get('/drive/links/:id/thumbnails', () => drive.linkPathRetired())
    // Reports: anyone who can see a node through a link or a share may file one, session or not.
    .get('/drive/reports/operators', ({ request }) => {
        requireClient(request);
        return drive.reportOperators();
    })
    .post(
        '/drive/reports',
        {
            mutation: true,
            body: t.Object({
                id: uuidSchema,
                reportIdSeed: idSeedSchema,
                workspaceId: uuidSchema,
                nodeId: uuidSchema,
                keyEpoch: epochSchema,
                category: t.UnionEnum(REPORT_CATEGORIES),
                reason: t.String({ minLength: 1, maxLength: 2000 }),
                via: t.Union([
                    t.Object({ link: linkTokenSchema }),
                    t.Object({ share: t.Literal(true) }),
                ]),
                reporterEmail: t.Nullable(emailSchema),
                keys: t.Array(
                    t.Object({
                        operatorUserId: uuidSchema,
                        keyEnvelope: reportEnvelopeSchema,
                    }),
                    // One envelope per current operator; an instance with more operators than this cannot take reports.
                    { minItems: 1, maxItems: MAX_REPORT_OPERATORS },
                ),
            }),
        },
        async ({ request, sessionToken, body }) => {
            requireClient(request);
            const user = await auth.getSessionUser(sessionToken);
            return drive.fileReport(
                { userId: user?.id ?? null, address: requestAddress(request) },
                body,
            );
        },
    )
    .guard({ mutation: true, client: true, session: 'drive' }, (app) =>
        app
            .get('/drive/workspace', async ({ user }) => drive.getWorkspace(user.id))
            .post(
                '/drive/workspaces/:id/epochs',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({ count: t.Integer({ minimum: 1, maximum: 10_000 }) }),
                },
                async ({ user, params, body }) =>
                    drive.allocateEpochs(user.id, params.id, body.count),
            )
            .post(
                '/drive/workspaces/:id/root',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({
                        id: uuidSchema,
                        idSeed: idSeedSchema,
                        ...nodeEnvelopesSchema,
                    }),
                },
                async ({ user, params, body }) => drive.createRoot(user.id, params.id, body),
            )
            .get(
                '/drive/nodes/:id/children',
                {
                    params: t.Object({ id: uuidSchema }),
                    query: t.Object({ workspaceId: uuidSchema, after: cursorSchema }),
                },
                async ({ user, params, query }) =>
                    drive.listChildren(user.id, query.workspaceId, params.id, query.after),
            )
            .post(
                '/drive/folders',
                {
                    body: t.Object({
                        workspaceId: uuidSchema,
                        folders: t.Array(
                            t.Object({
                                id: uuidSchema,
                                idSeed: idSeedSchema,
                                parentId: uuidSchema,
                                ...nodeEnvelopesSchema,
                            }),
                            {
                                minItems: 1,
                                maxItems: 64,
                            },
                        ),
                    }),
                },
                async ({ user, body }) =>
                    drive.createFolders(user.id, body.workspaceId, body.folders),
            )
            .post(
                '/drive/nodes/:id/metadata',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({
                        workspaceId: uuidSchema,
                        metadataVersion: epochSchema,
                        keyEpoch: epochSchema,
                        metadataEnvelope: metadataEnvelopeSchema,
                        metadataSignature: signatureSchema,
                    }),
                },
                async ({ user, params, body }) =>
                    drive.renameNode(user.id, body.workspaceId, params.id, body),
            )
            .post(
                '/drive/nodes/:id/parent',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({
                        workspaceId: uuidSchema,
                        parentId: uuidSchema,
                        parentKeyEpoch: epochSchema,
                        keyEnvelope: keyEnvelopeSchema,
                    }),
                },
                async ({ user, params, body }) =>
                    drive.moveNode(user.id, body.workspaceId, params.id, body),
            )
            .post(
                '/drive/nodes/:id/trash',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({ workspaceId: uuidSchema }),
                },
                async ({ user, params, body }) =>
                    drive.trashNode(user.id, body.workspaceId, params.id),
            )
            .post(
                '/drive/nodes/:id/restore',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({
                        workspaceId: uuidSchema,
                        toRoot: t.Optional(
                            t.Object({
                                parentKeyEpoch: epochSchema,
                                keyEnvelope: keyEnvelopeSchema,
                            }),
                        ),
                    }),
                },
                async ({ user, params, body }) =>
                    drive.restoreNode(user.id, body.workspaceId, params.id, body.toRoot),
            )
            // A selection to the trash, or back in place, in one request: per-item results, in order.
            .post(
                '/drive/workspaces/:id/trash-batch',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({ nodeIds: nodeBatchSchema }),
                },
                async ({ user, params, body }) =>
                    drive.trashNodes(user.id, params.id, body.nodeIds),
            )
            .post(
                '/drive/workspaces/:id/restore-batch',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({ nodeIds: nodeBatchSchema }),
                },
                async ({ user, params, body }) =>
                    drive.restoreNodes(user.id, params.id, body.nodeIds),
            )
            // Delete forever for a selection in the Trash: per-item results, in order.
            .post(
                '/drive/workspaces/:id/purge-batch',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({ nodeIds: nodeBatchSchema }),
                },
                async ({ user, params, body }) =>
                    drive.purgeNodes(user.id, params.id, body.nodeIds),
            )
            .post(
                '/drive/uploads',
                {
                    body: t.Object({
                        workspaceId: uuidSchema,
                        node: uploadNodeSchema,
                        versionId: uuidSchema,
                        versionIdSeed: idSeedSchema,
                        objectId: uuidSchema,
                        objectIdSeed: idSeedSchema,
                        contentKeyEnvelope: versionEnvelopeSchema,
                        versionSignature: signatureSchema,
                        contentNonce: t.String({
                            minLength: 22,
                            maxLength: 22,
                            pattern: '^[A-Za-z0-9_-]+$',
                        }),
                        contentSuite: t.Integer({ minimum: 1, maximum: 255 }),
                        chunkCount: t.Integer({ minimum: 1, maximum: 10_000 }),
                        ciphertextSize: t.String({ pattern: '^[0-9]{1,16}$' }),
                        moveOf: t.Optional(
                            t.Object({
                                workspaceId: uuidSchema,
                                nodeId: uuidSchema,
                                versionId: uuidSchema,
                            }),
                        ),
                    }),
                },
                async ({ user, body }) => drive.beginUpload(user.id, body.workspaceId, body),
            )
            .get(
                '/drive/uploads/:id',
                {
                    params: t.Object({ id: uuidSchema }),
                    query: t.Object({ workspaceId: uuidSchema }),
                },
                async ({ user, params, query }) =>
                    drive.getUploadState(user.id, query.workspaceId, params.id),
            )
            .get(
                '/drive/uploads/:id/parts',
                {
                    params: t.Object({ id: uuidSchema }),
                    query: t.Object({
                        workspaceId: uuidSchema,
                        from: t.Integer({ minimum: 1, maximum: 10_000 }),
                        count: t.Optional(t.Integer({ minimum: 1, maximum: 64 })),
                    }),
                },
                async ({ user, params, query }) =>
                    drive.uploadPartUrls(
                        user.id,
                        query.workspaceId,
                        params.id,
                        query.from,
                        query.count ?? 64,
                    ),
            )
            .post(
                '/drive/uploads/:id/complete',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({
                        workspaceId: uuidSchema,
                        parts: t.Array(partSchema, { minItems: 1, maxItems: 10_000 }),
                    }),
                },
                async ({ user, params, body }) =>
                    drive.completeUpload(user.id, body.workspaceId, params.id, body.parts),
            )
            .post(
                '/drive/uploads/:id/attach',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({
                        workspaceId: uuidSchema,
                        attach: t.Union([
                            t.Object({
                                mode: t.Literal('same-node'),
                                keyEpoch: epochSchema,
                                contentKeyEnvelope: versionEnvelopeSchema,
                                versionSignature: signatureSchema,
                            }),
                            t.Object({
                                mode: t.Literal('sibling'),
                                node: t.Object({
                                    id: uuidSchema,
                                    idSeed: idSeedSchema,
                                    parentId: uuidSchema,
                                    ...nodeEnvelopesSchema,
                                }),
                                contentKeyEnvelope: versionEnvelopeSchema,
                                versionSignature: signatureSchema,
                            }),
                        ]),
                    }),
                },
                async ({ user, params, body }) =>
                    drive.attachUpload(user.id, body.workspaceId, params.id, body.attach),
            )
            .post(
                '/drive/uploads/:id/abort',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({ workspaceId: uuidSchema }),
                },
                async ({ user, params, body }) =>
                    drive.abortUpload(user.id, body.workspaceId, params.id),
            )
            .get(
                '/drive/thumbnails',
                {
                    query: t.Object({
                        workspaceId: uuidSchema,
                        versions: t.String({ minLength: 36, maxLength: 3700 }),
                    }),
                },
                async ({ user, query }) =>
                    drive.thumbnailUrls(
                        user.id,
                        query.workspaceId,
                        query.versions.split(',').filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
                    ),
            )
            .delete(
                '/drive/nodes/:id',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({ workspaceId: uuidSchema }),
                },
                async ({ user, params, body }) =>
                    drive.purgeNode(user.id, body.workspaceId, params.id),
            )
            .post(
                '/drive/nodes/:id/copy',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({
                        workspaceId: uuidSchema,
                        sourceVersionId: uuidSchema,
                        node: t.Object({
                            id: uuidSchema,
                            idSeed: idSeedSchema,
                            parentId: uuidSchema,
                            ...nodeEnvelopesSchema,
                        }),
                        versionId: uuidSchema,
                        versionIdSeed: idSeedSchema,
                        contentKeyEnvelope: anyVersionEnvelopeSchema,
                        versionSignature: signatureSchema,
                    }),
                },
                async ({ user, params, body }) =>
                    drive.copyNode(user.id, body.workspaceId, params.id, body),
            )
            .get(
                '/drive/nodes/:id/versions',
                {
                    params: t.Object({ id: uuidSchema }),
                    query: t.Object({ workspaceId: uuidSchema }),
                },
                async ({ user, params, query }) =>
                    drive.listVersions(user.id, query.workspaceId, params.id),
            )
            .post(
                '/drive/versions/:id/restore',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({ workspaceId: uuidSchema }),
                },
                async ({ user, params, body }) =>
                    drive.restoreVersion(user.id, body.workspaceId, params.id),
            )
            .delete(
                '/drive/versions/:id',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({ workspaceId: uuidSchema }),
                },
                async ({ user, params, body }) =>
                    drive.discardVersion(user.id, body.workspaceId, params.id),
            )
            .post(
                '/drive/nodes/:id/shares',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({
                        workspaceId: uuidSchema,
                        granteeUserId: uuidSchema,
                        role: t.Union([t.Literal('viewer'), t.Literal('editor')]),
                        keyEpoch: epochSchema,
                        shareEnvelope: shareEnvelopeSchema,
                    }),
                },
                async ({ user, params, body, log }) => {
                    const result = await drive.shareNode(
                        user.id,
                        body.workspaceId,
                        params.id,
                        body,
                    );
                    // The person is told by mail; a mail problem is the operator's, not the sharer's.
                    void auth
                        .notifyShare(user.id, body.granteeUserId, body.role)
                        .then((notice) => {
                            if (notice === 'limited') log.set({ share: { notify: 'limited' } });
                        })
                        .catch((error: unknown) => {
                            // The class and code only: a mail error's message often names the recipient.
                            log.set({
                                share: { notify: 'failed', failure: describeFailure(error) },
                            });
                            log.error(new Error('Share notification failed.'));
                        });
                    return result;
                },
            )
            .get(
                '/drive/nodes/:id/shares',
                {
                    params: t.Object({ id: uuidSchema }),
                    query: t.Object({ workspaceId: uuidSchema }),
                },
                async ({ user, params, query }) =>
                    drive.listNodeShares(user.id, query.workspaceId, params.id),
            )
            .put(
                '/drive/shares/:id/envelope',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({
                        workspaceId: uuidSchema,
                        keyEpoch: epochSchema,
                        shareEnvelope: shareEnvelopeSchema,
                    }),
                },
                async ({ user, params, body }) =>
                    drive.resealShare(user.id, body.workspaceId, params.id, body),
            )
            .delete(
                '/drive/shares/:id',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({ workspaceId: uuidSchema }),
                },
                async ({ user, params, body }) =>
                    drive.revokeShare(user.id, body.workspaceId, params.id),
            )
            .get('/drive/shares', async ({ user }) => drive.listSharedWithMe(user.id))
            .get('/drive/shares/mine', async ({ user }) => drive.listSharedByMe(user.id))
            .post(
                '/drive/nodes/:id/links',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({
                        workspaceId: uuidSchema,
                        linkId: uuidSchema,
                        linkIdSeed: idSeedSchema,
                        token: linkTokenSchema,
                        keyEpoch: epochSchema,
                        linkEnvelope: keyEnvelopeSchema,
                        linkSalt: linkSaltSchema,
                        secretEnvelope: linkSecretSchema,
                        hasPassword: t.Boolean(),
                        expiresAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
                    }),
                },
                async ({ user, params, body }) =>
                    drive.createLink(user.id, body.workspaceId, params.id, body),
            )
            .get(
                '/drive/nodes/:id/links',
                {
                    params: t.Object({ id: uuidSchema }),
                    query: t.Object({ workspaceId: uuidSchema }),
                },
                async ({ user, params, query }) =>
                    drive.listNodeLinks(user.id, query.workspaceId, params.id),
            )
            .patch(
                '/drive/links/:id',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({
                        workspaceId: uuidSchema,
                        keyEpoch: epochSchema,
                        seal: t.Optional(
                            t.Object({
                                linkEnvelope: keyEnvelopeSchema,
                                linkSalt: linkSaltSchema,
                                hasPassword: t.Boolean(),
                                secretEnvelope: t.Optional(linkSecretSchema),
                            }),
                        ),
                        expiresAt: t.Optional(
                            t.Union([t.String({ format: 'date-time' }), t.Null()]),
                        ),
                    }),
                },
                async ({ user, params, body }) =>
                    drive.updateLink(user.id, body.workspaceId, params.id, body),
            )
            .delete(
                '/drive/links/:id',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({ workspaceId: uuidSchema }),
                },
                async ({ user, params, body }) =>
                    drive.revokeLink(user.id, body.workspaceId, params.id),
            )
            // Sealed workspace documents: the tag registry, replaced whole under a version precondition.
            .get(
                '/drive/workspaces/:id/documents/:kind',
                { params: t.Object({ id: uuidSchema, kind: documentKindSchema }) },
                async ({ user, params }) =>
                    drive.workspaceDocument(user.id, params.id, params.kind),
            )
            .put(
                '/drive/workspaces/:id/documents/:kind',
                {
                    params: t.Object({ id: uuidSchema, kind: documentKindSchema }),
                    body: t.Object({
                        version: t.Integer({ minimum: 0, maximum: 2147483646 }),
                        envelope: documentEnvelopeSchema,
                    }),
                },
                async ({ user, params, body }) =>
                    drive.putWorkspaceDocument(user.id, params.id, params.kind, body),
            )
            // Change feeds: a range over the workspace's sequence; a share's is filtered to its subtree.
            .get(
                '/drive/workspaces/:id/changes',
                {
                    params: t.Object({ id: uuidSchema }),
                    query: t.Object({
                        since: t.Integer({ minimum: 0 }),
                        limit: t.Optional(t.Integer({ minimum: 1, maximum: 500 })),
                    }),
                },
                async ({ user, params, query }) =>
                    drive.changes(user.id, params.id, query.since, query.limit),
            )
            .get(
                '/drive/shares/:id/changes',
                {
                    params: t.Object({ id: uuidSchema }),
                    // Opaque and sealed by the server; absent means from the start of the share.
                    query: t.Object({ cursor: t.Optional(t.String({ maxLength: 128 })) }),
                },
                async ({ user, params, query }) =>
                    drive.shareChanges(user.id, params.id, query.cursor),
            )
            // Rotation: the owner's device re-keys a subtree after a revocation, in batches.
            .post(
                '/drive/nodes/:id/rotation',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({ workspaceId: uuidSchema }),
                },
                async ({ user, params, body }) =>
                    drive.startRotation(user.id, body.workspaceId, params.id),
            )
            .get(
                '/drive/nodes/:id/rotation/work',
                {
                    params: t.Object({ id: uuidSchema }),
                    query: t.Object({
                        workspaceId: uuidSchema,
                        after: t.Optional(t.String({ minLength: 38, maxLength: 40 })),
                    }),
                },
                async ({ user, params, query }) =>
                    drive.rotationWork(user.id, query.workspaceId, params.id, query.after ?? null),
            )
            .post(
                '/drive/nodes/:id/rotation/nodes',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({
                        workspaceId: uuidSchema,
                        nodes: t.Array(rotatedNodeSchema, { minItems: 1, maxItems: 200 }),
                    }),
                },
                async ({ user, params, body }) =>
                    drive.rotateNodes(user.id, body.workspaceId, params.id, body.nodes),
            )
            .get(
                '/drive/workspaces/:id/storage',
                { params: t.Object({ id: uuidSchema }) },
                async ({ user, params }) => drive.storageBreakdown(user.id, params.id),
            )
            .post(
                '/drive/workspaces/:id/versions/discard-superseded',
                { params: t.Object({ id: uuidSchema }), body: t.Object({}) },
                async ({ user, params }) => drive.discardSupersededVersions(user.id, params.id),
            )
            .post(
                '/drive/workspaces/:id/trash/empty',
                // A JSON body, empty or not: the mutation guard accepts nothing else.
                { params: t.Object({ id: uuidSchema }), body: t.Object({}) },
                async ({ user, params }) => drive.emptyTrash(user.id, params.id),
            )
            .post(
                '/drive/versions/urls',
                {
                    body: t.Object({
                        workspaceId: uuidSchema,
                        versionIds: t.Array(uuidSchema, { minItems: 1, maxItems: 100 }),
                    }),
                },
                async ({ user, body }) =>
                    drive.downloadUrls(user.id, body.workspaceId, body.versionIds),
            )
            .get(
                '/drive/versions/:id/url',
                {
                    params: t.Object({ id: uuidSchema }),
                    query: t.Object({ workspaceId: uuidSchema }),
                },
                async ({ user, params, query }) =>
                    drive.downloadUrl(user.id, query.workspaceId, params.id),
            )
            .get(
                '/drive/workspaces/:id/trash',
                {
                    params: t.Object({ id: uuidSchema }),
                    query: t.Object({ after: trashCursorSchema }),
                },
                async ({ user, params, query }) => drive.listTrash(user.id, params.id, query.after),
            )
            // Every space the account can open: their own, and each group's areas once groups are on.
            .get('/drive/spaces', async ({ user }) => {
                const personal = await drive.getWorkspace(user.id);
                return {
                    spaces: [
                        {
                            space: { kind: 'personal' as const },
                            areas: [
                                {
                                    workspaceId: personal.workspaceId,
                                    workspaceKeyVersion: personal.grant?.workspaceKeyVersion ?? 1,
                                    changeSeq: personal.changeSeq,
                                    root: personal.root,
                                    rotation: personal.rotation,
                                    selfGrant: personal.grant,
                                },
                            ],
                        },
                        ...(groups.groupsEnabled() ? await groups.spaces(user.id) : []),
                    ],
                };
            }),
    );
