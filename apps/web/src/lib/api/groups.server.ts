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
    guards,
    keyEnvelopeSchema,
    memberParams,
    requestAddress,
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
    .use(guards)
    // Groups (docs/groups-server.md 4): served only with GROUPS_ENABLED. The edge
    // (handleGroupRequest) refuses first; this gate holds if a route is ever
    // reached some other way, such as a test or a future mount that skips it.
    .guard({ groups: true, mutation: true, client: true, session: 'groups' }, (app) =>
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
                async ({ user, body, set }) => {
                    const result = await groups.createGroup(user.id, body);
                    set.status = result.replayed ? 200 : 201;
                    return { group: result.group };
                },
            )
            .get('/groups', async ({ user }) => groups.listGroups(user.id))
            .get('/groups/:id', { params: groupParams }, async ({ user, params }) =>
                groups.getGroup(user.id, params.id),
            )
            .patch(
                '/groups/:id',
                {
                    params: groupParams,
                    body: t.Object({ name: t.String({ minLength: 1, maxLength: 400 }) }),
                },
                async ({ user, params, body }) => groups.renameGroup(user.id, params.id, body),
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
                async ({ user, params, query }) => groups.getRosters(user.id, params.id, query),
            )
            .get(
                '/groups/:id/identities',
                { params: groupParams, query: t.Object({ after: t.Optional(uuidSchema) }) },
                async ({ user, params, query }) =>
                    groups.getIdentities(user.id, params.id, query.after ?? null),
            )
            .post(
                '/groups/:id/rosters',
                { groupWrite: true, params: groupParams, body: t.Object(rosterCallFields) },
                async ({ user, params, body }) => groups.postRoster(user.id, params.id, body),
            )
            .get('/groups/:id/key-seal', { params: groupParams }, async ({ user, params }) =>
                groups.getKeySeal(user.id, params.id),
            )
            .put(
                '/groups/:id/key-seals',
                {
                    groupWrite: true,
                    params: groupParams,
                    body: t.Object({
                        seals: t.Array(sealSchema, { minItems: 1, maxItems: MAX_SEALS_PER_CALL }),
                    }),
                },
                async ({ user, params, body }) => groups.putKeySeals(user.id, params.id, body),
            )
            .post(
                '/groups/:id/key-successions',
                {
                    groupWrite: true,
                    params: groupParams,
                    body: t.Object({
                        expectedRevision: revisionSchema,
                        succession: signedStatementSchema,
                        seals: t.Array(sealSchema, { maxItems: MAX_SEALS_PER_CALL }),
                    }),
                },
                async ({ user, params, body }) => groups.postSuccession(user.id, params.id, body),
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
                async ({ user, params, body, set }) => {
                    const result = await groups.invite(user.id, params.id, body);
                    set.status = 201;
                    return result;
                },
            )
            .get('/groups/:id/invitations', { params: groupParams }, async ({ user, params }) =>
                groups.listInvitations(user.id, params.id),
            )
            .delete(
                '/groups/:id/invitations/:invitationId',
                // A JSON body ({}), as every mutation here: the request guard refuses one without.
                {
                    params: t.Object({ id: uuidSchema, invitationId: uuidSchema }),
                    body: t.Object({}),
                },
                async ({ user, params }) =>
                    groups.revokeInvitation(user.id, params.id, params.invitationId),
            )
            .get('/invitations', async ({ user }) => groups.listMyInvitations(user.id))
            .post(
                '/invitations/open',
                { body: t.Object({ token: tokenSchema }) },
                async ({ user, request, body }) =>
                    groups.openInvitation(user.id, body.token, requestAddress(request)),
            )
            .post(
                '/invitations/accept',
                { body: t.Object({ token: tokenSchema }) },
                async ({ user, request, body }) =>
                    groups.acceptInvitation(user.id, body.token, requestAddress(request)),
            )
            .get('/groups/:id/pending', { params: groupParams }, async ({ user, params }) =>
                groups.listPending(user.id, params.id),
            )
            .post(
                '/groups/:id/members/:userId/admit',
                {
                    groupWrite: true,
                    params: memberParams,
                    body: t.Object({ ...rosterCallFields, keySeal: t.Optional(sealSchema) }),
                },
                async ({ user, request, params, body }) =>
                    groups.admit(
                        user.id,
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
                    groupWrite: true,
                    params: memberParams,
                    body: t.Object({ ...rosterCallFields, keySeal: t.Optional(sealSchema) }),
                },
                async ({ user, params, body }) =>
                    groups.patchMember(user.id, params.id, params.userId, body),
            )
            .post(
                '/groups/:id/members/:userId/remove',
                {
                    groupWrite: true,
                    params: memberParams,
                    body: t.Object({ ...rosterCallFields, endsLapsed: endsLapsedSchema }),
                },
                async ({ user, params, body }) =>
                    groups.removeMember(user.id, params.id, params.userId, body),
            )
            .post(
                '/groups/:id/members/:userId/remove-preview',
                { params: memberParams, body: t.Object({}) },
                async ({ user, params }) =>
                    groups.removalPreview(user.id, params.id, params.userId),
            )
            .post(
                '/groups/:id/members/:userId/decline',
                { params: memberParams, body: t.Object({}) },
                async ({ user, params }) =>
                    groups.declinePending(user.id, params.id, params.userId),
            )
            .post(
                '/groups/:id/members/:userId/hold',
                { params: memberParams, body: t.Object({}) },
                async ({ user, params }) => groups.hold(user.id, params.id, params.userId),
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
                async ({ user, params, body }) => groups.leave(user.id, params.id, body),
            )
            .post(
                '/groups/:id/areas',
                {
                    groupWrite: true,
                    params: groupParams,
                    body: t.Object({ ...rosterCallFields, area: areaSchema }),
                },
                async ({ user, params, body }) => groups.createArea(user.id, params.id, body),
            )
            .post(
                '/groups/:id/areas/:workspaceId/grants',
                {
                    groupWrite: true,
                    params: areaParams,
                    body: t.Object({
                        grants: t.Array(grantSchema, {
                            minItems: 1,
                            maxItems: MAX_GRANTS_PER_CALL,
                        }),
                    }),
                },
                async ({ user, params, body }) =>
                    groups.postGrants(user.id, params.id, params.workspaceId, body),
            )
            .put(
                '/groups/:id/areas/:workspaceId/self-grant',
                { params: areaParams, body: t.Object({ grant: workspaceKeySchema }) },
                async ({ user, params, body }) =>
                    groups.putSelfGrant(user.id, params.id, params.workspaceId, body),
            )
            // Route 28: a holder repairs the root's previous envelope while the area's rotation runs.
            .put(
                '/groups/:id/areas/:workspaceId/previous-root',
                {
                    groupWrite: true,
                    params: areaParams,
                    body: t.Object({
                        rotationId: uuidSchema,
                        previousRootKeyEnvelope: keyEnvelopeSchema,
                    }),
                },
                async ({ user, params, body }) =>
                    groups.putPreviousRoot(user.id, params.id, params.workspaceId, body),
            )
            // Route 29: what a holder's device re-keys when a roster rotates the area.
            .get(
                '/groups/:id/areas/:workspaceId/root',
                { params: areaParams },
                async ({ user, params }) => groups.areaRoot(user.id, params.id, params.workspaceId),
            )
            // Deleting a family folder: its tombstone on the next roster (groups design 2.10).
            .post(
                '/groups/:id/areas/:workspaceId/delete',
                { groupWrite: true, params: areaParams, body: t.Object(rosterCallFields) },
                async ({ user, params, body }) =>
                    groups.deleteArea(user.id, params.id, params.workspaceId, body),
            )
            .post(
                '/groups/:id/areas/:workspaceId/rotations',
                {
                    groupWrite: true,
                    params: areaParams,
                    body: t.Object({ ...rosterCallFields, rotation: rotationSchema }),
                },
                async ({ user, params, body }) =>
                    groups.rotateArea(user.id, params.id, params.workspaceId, body),
            ),
    );
