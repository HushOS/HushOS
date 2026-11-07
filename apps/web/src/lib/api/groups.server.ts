import '@/lib/server-only';
import { Elysia, t } from 'elysia';
import { CLIENT_HEADER, parseClientHeader } from '@hushos/drive/protocol';
import * as groups from '@hushos/groups/server';
import { MAX_GRANTS_PER_CALL, MAX_SEALS_PER_CALL } from '@hushos/groups/protocol';
import {
    areaParams,
    areaSchema,
    b64Schema,
    emailSchema,
    endsLapsedSchema,
    grantSchema,
    groupParams,
    groupRoleSchema,
    groupUser,
    groupWriter,
    groupsGate,
    keyEnvelopeSchema,
    memberParams,
    requestAddress,
    requestContext,
    revisionSchema,
    rosterCallFields,
    rotationSchema,
    sealSchema,
    signedStatementSchema,
    tokenSchema,
    uuidSchema,
    workspaceKeySchema,
} from '@/lib/api/shared.server';

/* Families (docs/groups-server.md 4): groups and invitations, served only with GROUPS_ENABLED. */
export const groupsApi = new Elysia()
    .use(requestContext)
    // Groups (docs/groups-server.md 4): served only with GROUPS_ENABLED. The edge
    // (handleGroupRequest) refuses first; this gate holds if a route is ever
    // reached some other way, such as a test or a future mount that skips it.
    .guard({ beforeHandle: groupsGate }, (app) =>
        app
            .post(
                '/groups',
                {
                    body: t.Object({
                        id: uuidSchema,
                        idSeed: t.String({ maxLength: 64 }),
                        kind: t.Union([t.Literal('family'), t.Literal('org')]),
                        name: t.String({ minLength: 1, maxLength: 400 }),
                        groupKey: t.Object({
                            ed25519PublicKey: b64Schema(43),
                            mlDsaPublicKey: b64Schema(2603),
                        }),
                        roster: signedStatementSchema,
                        keySeal: t.Object({ envelope: b64Schema(6130) }),
                        area: t.Object({
                            ...areaSchema.properties,
                            grant: t.Object({ envelope: b64Schema(6087) }),
                        }),
                    }),
                },
                async ({ request, sessionToken, body, set }) => {
                    const result = await groups.createGroup(
                        (await groupUser(request, sessionToken)).id,
                        body,
                    );
                    set.status = result.replayed ? 200 : 201;
                    return { group: result.group };
                },
            )
            .get('/groups', async ({ request, sessionToken }) =>
                groups.listGroups((await groupUser(request, sessionToken)).id),
            )
            .get(
                '/groups/:id',
                { params: groupParams },
                async ({ request, sessionToken, params }) =>
                    groups.getGroup((await groupUser(request, sessionToken)).id, params.id),
            )
            .patch(
                '/groups/:id',
                {
                    params: groupParams,
                    body: t.Object({ name: t.String({ minLength: 1, maxLength: 400 }) }),
                },
                async ({ request, sessionToken, params, body }) =>
                    groups.renameGroup(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        body,
                    ),
            )
            .get(
                '/groups/:id/rosters',
                {
                    params: groupParams,
                    query: t.Object({
                        after: t.Optional(t.Numeric({ minimum: 0, maximum: 9007199254740991 })),
                        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
                    }),
                },
                async ({ request, sessionToken, params, query }) =>
                    groups.getRosters(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        query,
                    ),
            )
            .get(
                '/groups/:id/identities',
                { params: groupParams, query: t.Object({ after: t.Optional(uuidSchema) }) },
                async ({ request, sessionToken, params, query }) =>
                    groups.getIdentities(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        query.after ?? null,
                    ),
            )
            .post(
                '/groups/:id/rosters',
                { params: groupParams, body: t.Object(rosterCallFields) },
                async ({ request, sessionToken, params, body }) =>
                    groups.postRoster(
                        (await groupWriter(request, sessionToken)).id,
                        params.id,
                        body,
                    ),
            )
            .get(
                '/groups/:id/key-seal',
                { params: groupParams },
                async ({ request, sessionToken, params }) =>
                    groups.getKeySeal((await groupUser(request, sessionToken)).id, params.id),
            )
            .put(
                '/groups/:id/key-seals',
                {
                    params: groupParams,
                    body: t.Object({
                        seals: t.Array(sealSchema, { minItems: 1, maxItems: MAX_SEALS_PER_CALL }),
                    }),
                },
                async ({ request, sessionToken, params, body }) =>
                    groups.putKeySeals(
                        (await groupWriter(request, sessionToken)).id,
                        params.id,
                        body,
                    ),
            )
            .post(
                '/groups/:id/key-successions',
                {
                    params: groupParams,
                    body: t.Object({
                        expectedRevision: revisionSchema,
                        succession: signedStatementSchema,
                        seals: t.Array(sealSchema, { maxItems: MAX_SEALS_PER_CALL }),
                    }),
                },
                async ({ request, sessionToken, params, body }) =>
                    groups.postSuccession(
                        (await groupWriter(request, sessionToken)).id,
                        params.id,
                        body,
                    ),
            )
            .post(
                '/groups/:id/invitations',
                {
                    params: groupParams,
                    body: t.Object({
                        email: emailSchema,
                        roles: t.Array(groupRoleSchema, { maxItems: 3 }),
                    }),
                },
                async ({ request, sessionToken, params, body, set }) => {
                    const result = await groups.invite(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        body,
                    );
                    set.status = 201;
                    return result;
                },
            )
            .get(
                '/groups/:id/invitations',
                { params: groupParams },
                async ({ request, sessionToken, params }) =>
                    groups.listInvitations((await groupUser(request, sessionToken)).id, params.id),
            )
            .delete(
                '/groups/:id/invitations/:invitationId',
                // A JSON body ({}), as every mutation here: the request guard refuses one without.
                {
                    params: t.Object({ id: uuidSchema, invitationId: uuidSchema }),
                    body: t.Object({}),
                },
                async ({ request, sessionToken, params }) =>
                    groups.revokeInvitation(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        params.invitationId,
                    ),
            )
            .get('/invitations', async ({ request, sessionToken }) =>
                groups.listMyInvitations((await groupUser(request, sessionToken)).id),
            )
            .post(
                '/invitations/open',
                { body: t.Object({ token: tokenSchema }) },
                async ({ request, sessionToken, body }) =>
                    groups.openInvitation(
                        (await groupUser(request, sessionToken)).id,
                        body.token,
                        requestAddress(request),
                    ),
            )
            .post(
                '/invitations/accept',
                { body: t.Object({ token: tokenSchema }) },
                async ({ request, sessionToken, body }) =>
                    groups.acceptInvitation(
                        (await groupUser(request, sessionToken)).id,
                        body.token,
                        requestAddress(request),
                    ),
            )
            .get(
                '/groups/:id/pending',
                { params: groupParams },
                async ({ request, sessionToken, params }) =>
                    groups.listPending((await groupUser(request, sessionToken)).id, params.id),
            )
            .post(
                '/groups/:id/members/:userId/admit',
                {
                    params: memberParams,
                    body: t.Object({ ...rosterCallFields, keySeal: t.Optional(sealSchema) }),
                },
                async ({ request, sessionToken, params, body }) =>
                    groups.admit(
                        (await groupWriter(request, sessionToken)).id,
                        params.id,
                        params.userId,
                        body,
                        // Only the web buys a place for a full plan (it says the cost first); the
                        // phone apps never do, resends of their kept calls included.
                        {
                            mayBuy: groups.mayBuySeatFrom(
                                parseClientHeader(request.headers.get(CLIENT_HEADER))?.name,
                            ),
                        },
                    ),
            )
            .patch(
                '/groups/:id/members/:userId',
                {
                    params: memberParams,
                    body: t.Object({ ...rosterCallFields, keySeal: t.Optional(sealSchema) }),
                },
                async ({ request, sessionToken, params, body }) =>
                    groups.patchMember(
                        (await groupWriter(request, sessionToken)).id,
                        params.id,
                        params.userId,
                        body,
                    ),
            )
            .post(
                '/groups/:id/members/:userId/remove',
                {
                    params: memberParams,
                    body: t.Object({ ...rosterCallFields, endsLapsed: endsLapsedSchema }),
                },
                async ({ request, sessionToken, params, body }) =>
                    groups.removeMember(
                        (await groupWriter(request, sessionToken)).id,
                        params.id,
                        params.userId,
                        body,
                    ),
            )
            .post(
                '/groups/:id/members/:userId/remove-preview',
                { params: memberParams, body: t.Object({}) },
                async ({ request, sessionToken, params }) =>
                    groups.removalPreview(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        params.userId,
                    ),
            )
            .post(
                '/groups/:id/members/:userId/decline',
                { params: memberParams, body: t.Object({}) },
                async ({ request, sessionToken, params }) =>
                    groups.declinePending(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        params.userId,
                    ),
            )
            .post(
                '/groups/:id/members/:userId/hold',
                { params: memberParams, body: t.Object({}) },
                async ({ request, sessionToken, params }) =>
                    groups.hold(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        params.userId,
                    ),
            )
            .post(
                '/groups/:id/leave',
                {
                    params: groupParams,
                    body: t.Object({
                        endsLapsed: endsLapsedSchema,
                        expect: t.Optional(t.Literal('accepted')),
                    }),
                },
                async ({ request, sessionToken, params, body }) =>
                    groups.leave((await groupUser(request, sessionToken)).id, params.id, body),
            )
            .post(
                '/groups/:id/areas',
                { params: groupParams, body: t.Object({ ...rosterCallFields, area: areaSchema }) },
                async ({ request, sessionToken, params, body }) =>
                    groups.createArea(
                        (await groupWriter(request, sessionToken)).id,
                        params.id,
                        body,
                    ),
            )
            .post(
                '/groups/:id/areas/:workspaceId/grants',
                {
                    params: areaParams,
                    body: t.Object({
                        grants: t.Array(grantSchema, {
                            minItems: 1,
                            maxItems: MAX_GRANTS_PER_CALL,
                        }),
                    }),
                },
                async ({ request, sessionToken, params, body }) =>
                    groups.postGrants(
                        (await groupWriter(request, sessionToken)).id,
                        params.id,
                        params.workspaceId,
                        body,
                    ),
            )
            .put(
                '/groups/:id/areas/:workspaceId/self-grant',
                { params: areaParams, body: t.Object({ grant: workspaceKeySchema }) },
                async ({ request, sessionToken, params, body }) =>
                    groups.putSelfGrant(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        params.workspaceId,
                        body,
                    ),
            )
            // Route 28: a holder repairs the root's previous envelope while the area's rotation runs.
            .put(
                '/groups/:id/areas/:workspaceId/previous-root',
                {
                    params: areaParams,
                    body: t.Object({
                        rotationId: uuidSchema,
                        previousRootKeyEnvelope: keyEnvelopeSchema,
                    }),
                },
                async ({ request, sessionToken, params, body }) =>
                    groups.putPreviousRoot(
                        (await groupWriter(request, sessionToken)).id,
                        params.id,
                        params.workspaceId,
                        body,
                    ),
            )
            // Route 29: what a holder's device re-keys when a roster rotates the area.
            .get(
                '/groups/:id/areas/:workspaceId/root',
                { params: areaParams },
                async ({ request, sessionToken, params }) =>
                    groups.areaRoot(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        params.workspaceId,
                    ),
            )
            // Deleting a family folder: its tombstone on the next roster (groups design 2.10).
            .post(
                '/groups/:id/areas/:workspaceId/delete',
                { params: areaParams, body: t.Object(rosterCallFields) },
                async ({ request, sessionToken, params, body }) =>
                    groups.deleteArea(
                        (await groupWriter(request, sessionToken)).id,
                        params.id,
                        params.workspaceId,
                        body,
                    ),
            )
            .post(
                '/groups/:id/areas/:workspaceId/rotations',
                {
                    params: areaParams,
                    body: t.Object({ ...rosterCallFields, rotation: rotationSchema }),
                },
                async ({ request, sessionToken, params, body }) =>
                    groups.rotateArea(
                        (await groupWriter(request, sessionToken)).id,
                        params.id,
                        params.workspaceId,
                        body,
                    ),
            ),
    );
