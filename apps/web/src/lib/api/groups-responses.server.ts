import '@/lib/server-only';
import { t } from 'elysia';
import { rotationWorkNode } from '@/lib/api/drive-responses.server';

/*
 * What every groups and invitations route answers (groups.server.ts), field for field. Elysia
 * checks a reply against its schema and drops every field the schema does not name, so a column
 * added to a row later stays on the server. Each mirrors what @hushos/groups/server builds (every
 * reply is an object literal there, never a row passed through): a field the schema misses is
 * silently dropped, and one it requires that the handler leaves out fails the request.
 *
 * Signed statements, signatures, keys, digests and envelopes are Base64url strings, kept exactly
 * as plain strings: the clients verify them byte for byte (rosters, successions, identities and
 * their links, seals, the area root), so none is optional here that the handler always sends.
 * Dates are ISO strings. Roles, states and kinds are the database's own sets (GroupRole,
 * MembershipState, GroupKind), wider than what a family uses today, so the server never refuses
 * a row the database allows.
 */

const role = t.Union([
    t.Literal('billing'),
    t.Literal('data_admin'),
    t.Literal('guardian'),
    t.Literal('members'),
    t.Literal('recovery'),
]);
const kind = t.Union([t.Literal('family'), t.Literal('org')]);
const membershipState = t.Union([
    t.Literal('accepted'),
    t.Literal('active'),
    t.Literal('left'),
    t.Literal('removed'),
]);

/* groupView: the group's place in its chain. */
const group = t.Object({
    id: t.String(),
    kind,
    name: t.String(),
    rosterVersion: t.Integer(),
    groupKeyVersion: t.Integer(),
    revision: t.Integer(),
});

/* Head (headView): the head roster by version and digest, the chain's revision and key version. */
const headFields = {
    version: t.Integer(),
    digest: t.String(),
    revision: t.Integer(),
    groupKeyVersion: t.Integer(),
};
const head = t.Object(headFields);

/* SignedStatementWire: the statement's bytes, the group's hybrid signature, the signer's own. */
const signedStatementFields = {
    statement: t.String(),
    signature: t.Object({ ed25519: t.String(), mlDsa: t.String() }),
    signerSignature: t.String(),
};

/* ServedIdentity (served): an account's current hybrid identity, every key present. */
const servedIdentity = t.Object({
    keyVersion: t.Integer(),
    encryptionPublicKey: t.String(),
    signingPublicKey: t.String(),
    mlDsaPublicKey: t.String(),
    kemPublicKey: t.String(),
    keysSignature: t.String(),
});

/* POST /groups (route 1, 201 or 200 for a replay), PATCH /groups/:id (4). */
export const groupResponse = t.Object({ group });

/* GET /groups (route 2): the account's groups, accepted or active. */
export const groupsResponse = t.Object({
    groups: t.Array(
        t.Object({
            id: t.String(),
            kind,
            name: t.String(),
            roles: t.Array(role),
            state: membershipState,
            rosterVersion: t.Integer(),
            groupKeyVersion: t.Integer(),
        }),
    ),
});

/*
 * GET /groups/:id (route 3). `due` is absent for someone only accepted; an active member's has
 * `grants` alone, a `members` holder's every field. A member's address is null unless active.
 */
export const groupDetailResponse = t.Object({
    group,
    head,
    members: t.Array(
        t.Object({
            userId: t.String(),
            name: t.String(),
            email: t.Nullable(t.String()),
            state: membershipState,
            roles: t.Array(role),
        }),
    ),
    seats: t.Object({ used: t.Integer(), limit: t.Integer() }),
    due: t.Optional(
        t.Object({
            grants: t.Array(t.Object({ workspaceId: t.String(), userId: t.String() })),
            markLeft: t.Optional(t.Array(t.String())),
            foldIn: t.Optional(t.Array(t.String())),
            succession: t.Optional(t.Boolean()),
            rotations: t.Optional(t.Array(t.String())),
            holds: t.Optional(
                t.Array(
                    t.Object({
                        userId: t.String(),
                        heldBy: t.Nullable(t.String()),
                        expiresAt: t.String(),
                    }),
                ),
            ),
        }),
    ),
});

/*
 * GET /groups/:id/rosters (route 5): a page of rosters, every succession, the version 1 keys and
 * each signer's ML-DSA key by its digest (keys vary, values are keys). `next` null on the last page.
 */
export const rostersResponse = t.Object({
    rosters: t.Array(t.Object({ version: t.Integer(), ...signedStatementFields })),
    successions: t.Array(t.Object(signedStatementFields)),
    firstKeys: t.Object({ ed25519PublicKey: t.String(), mlDsaPublicKey: t.String() }),
    signerKeys: t.Record(t.String(), t.String()),
    head,
    next: t.Nullable(t.Integer()),
});

/*
 * GET /groups/:id/identities (route 6): each head entry's identity (null for an account that is
 * gone) and its succession links, consent null on links from before consent.
 */
export const identitiesResponse = t.Object({
    identities: t.Array(
        t.Object({
            userId: t.String(),
            identity: t.Nullable(servedIdentity),
            links: t.Array(
                t.Object({
                    oldKeyVersion: t.Integer(),
                    newKeyVersion: t.Integer(),
                    oldEncryptionPublicKey: t.String(),
                    oldSigningPublicKey: t.String(),
                    oldMlDsaPublicKey: t.String(),
                    newEncryptionPublicKey: t.String(),
                    newSigningPublicKey: t.String(),
                    newMlDsaPublicKey: t.String(),
                    newKemPublicKey: t.String(),
                    signature: t.String(),
                    consent: t.Nullable(t.String()),
                }),
            ),
        }),
    ),
    next: t.Nullable(t.String()),
});

/*
 * What every roster route answers (chainAnswer): the new head, and whether the call was already
 * stored. Routes 7, 10, 17, 18, 19, 21, 24 and a folder's deletion.
 */
export const chainHeadResponse = t.Object({ ...headFields, replayed: t.Boolean() });

/* GET /groups/:id/key-seal (route 8): the caller's seal of the current group key. */
export const keySealResponse = t.Object({
    groupKeyVersion: t.Integer(),
    holderKeyVersion: t.Integer(),
    sealerUserId: t.String(),
    rosterVersion: t.Integer(),
    rosterDigest: t.String(),
    envelope: t.String(),
});

/* PUT /groups/:id/key-seals (9) and POST .../areas/:workspaceId/grants (22): how many were written. */
export const storedResponse = t.Object({ stored: t.Integer() });

/* POST /groups/:id/invitations (route 11, 201). */
export const invitedResponse = t.Object({ id: t.String(), expiresAt: t.String() });

/* GET /groups/:id/invitations (route 12). The address is typed nullable; an open one has one. */
export const invitationsResponse = t.Object({
    invitations: t.Array(
        t.Object({
            id: t.String(),
            email: t.Nullable(t.String()),
            roles: t.Array(role),
            invitedBy: t.Nullable(t.String()),
            expiresAt: t.String(),
        }),
    ),
});

/* DELETE /groups/:id/invitations/:invitationId (route 13). */
export const revokedResponse = t.Object({ revoked: t.Literal(true) });

/* GET /invitations (route 14b): open invitations to this account's address, no token. */
export const myInvitationsResponse = t.Object({
    invitations: t.Array(
        t.Object({
            id: t.String(),
            name: t.String(),
            inviterName: t.Nullable(t.String()),
            expiresAt: t.String(),
        }),
    ),
});

/*
 * POST /invitations/open (route 14): the invitation for its own addressee. `inFamily` is the
 * caller's other family, `inviter` null once their account is gone.
 */
export const openedInvitationResponse = t.Object({
    inFamily: t.Nullable(t.Object({ groupId: t.String(), name: t.String() })),
    invitationId: t.String(),
    groupId: t.String(),
    kind,
    name: t.String(),
    inviter: t.Nullable(t.Object({ id: t.String(), name: t.String(), email: t.String() })),
    roles: t.Array(role),
    expiresAt: t.String(),
});

/* POST /invitations/accept (route 15). */
export const acceptedResponse = t.Object({ groupId: t.String(), state: t.Literal('accepted') });

/* GET /groups/:id/pending (route 16): who waits, with the identity the words check compares. */
export const pendingResponse = t.Object({
    pending: t.Array(
        t.Object({
            userId: t.String(),
            name: t.String(),
            email: t.String(),
            roles: t.Array(role),
            acceptedAt: t.Nullable(t.String()),
            identity: t.Nullable(servedIdentity),
            inFamily: t.Boolean(),
        }),
    ),
});

/* POST /groups/:id/members/:userId/remove-preview: the lapsed plans a removal ends. */
export const removalPreviewResponse = t.Object({
    plans: t.Array(
        t.Object({
            id: t.String(),
            name: t.String(),
            standing: t.Union([t.Literal('payment-failed'), t.Literal('paused')]),
        }),
    ),
});

/* POST /groups/:id/members/:userId/decline (route 26). */
export const declinedResponse = t.Object({ declined: t.Literal(true) });

/* POST /groups/:id/members/:userId/hold (route 27): until when the member's writes are held. */
export const heldResponse = t.Object({ heldUntil: t.String() });

/* POST /groups/:id/leave (route 20): `dissolved` only when the leave ended the family. */
export const leftResponse = t.Object({
    state: t.Literal('left'),
    dissolved: t.Optional(t.Boolean()),
});

/* PUT /groups/:id/areas/:workspaceId/self-grant (route 23). */
export const selfGrantResponse = t.Object({ ok: t.Literal(true) });

/* PUT /groups/:id/areas/:workspaceId/previous-root (route 28): the change it was stored at. */
export const previousRootResponse = t.Object({ changeSeq: t.Integer() });

/* GET /groups/:id/areas/:workspaceId/root (route 29): the root as Drive's rotation work serves a node. */
export const areaRootResponse = rotationWorkNode;
