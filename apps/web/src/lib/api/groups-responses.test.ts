// @vitest-environment node
import { Elysia, t, type AnySchema } from 'elysia';
import { describe, expect, test } from 'vitest';
import type * as groups from '@hushos/groups/server';
import {
    acceptedResponse,
    areaRootResponse,
    chainHeadResponse,
    declinedResponse,
    groupDetailResponse,
    groupResponse,
    groupsResponse,
    heldResponse,
    identitiesResponse,
    invitationsResponse,
    invitedResponse,
    keySealResponse,
    leftResponse,
    myInvitationsResponse,
    openedInvitationResponse,
    pendingResponse,
    previousRootResponse,
    removalPreviewResponse,
    revokedResponse,
    rostersResponse,
    selfGrantResponse,
    storedResponse,
} from '@/lib/api/groups-responses.server';
import { loadApi, type ApiRoute } from '@/test/api-app';

/*
 * The groups and invitations routes' reply schemas, through a real Elysia route so normalisation
 * runs as it does in the app: what the groups package returns goes out unchanged (every variant: a
 * manager's, a member's and a waiting person's view of a family, a replayed chain write, an
 * account that is gone, links from before consent, a leave that dissolves the family), a field
 * the schema does not name is dropped, and a reply missing a field a client needs fails instead
 * of going out short. Samples are typed as the package's return types, so a sample that drifts
 * from what the handler returns fails typecheck. The signed statements, identities, seals and the
 * area root are compared whole: the clients verify them byte for byte.
 */

type Reply<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

async function serve(schema: AnySchema, value: unknown, status: 200 | 201 = 200) {
    const app = new Elysia().get('/x', { response: { [status]: schema } }, ({ set }) => {
        set.status = status;
        return value as never;
    });
    const response = await app.handle(new Request('http://localhost/x'));
    return {
        status: response.status,
        body: response.ok ? ((await response.json()) as unknown) : null,
    };
}

const clone = <T>(value: T): T => structuredClone(value);
const b64 = (length: number, fill = 7) => Buffer.alloc(length, fill).toString('base64url');

const groupId = '0b5e0d1c-6a4e-4c41-9a43-2b1f4d8f9e10';
const otherGroup = '1c6f1e2d-7b5f-4d52-8b54-3c2a5e9a0f21';
const organizer = '2d7a2f3e-8c6a-4e63-9c65-4d3b6fab1a32';
const member = '3e8b3a4f-9d7b-4f74-8d76-5e4c7abc2b43';
const newcomer = '4f9c4b5a-ae8c-4a85-9e87-6f5d8bcd3c54';
const area = '5a0d5c6b-bf9d-4b96-8f98-7a6e9cde4d65';
const rootId = '6b1e6d7c-c0ae-4ca7-9a09-8b7fadef5e76';
const invitationId = '7c2f7e8d-d1bf-4db8-8b1a-9c80bef06f87';
const versionId = '8d308f9e-e2c0-4ec9-9c2b-ad91cf017098';
const objectId = '9e41908f-f3d1-4fda-8d3c-bea2d01281a9';
const shareId = 'af52a190-04e2-40eb-9e4d-cfb3e12392ba';
const linkId = 'b063c2a1-15f3-41fc-8f5e-d0c4f234a3cc';
const iso = (hour: number) => new Date(Date.UTC(2026, 10, 8, hour)).toISOString();

/* ------------------------------------------------------------------------- */
/* Shared pieces */

const family = {
    id: groupId,
    kind: 'family' as const,
    name: 'The Lovelaces',
    rosterVersion: 4,
    groupKeyVersion: 2,
    revision: 9,
};
const head = { version: 4, digest: b64(32, 1), revision: 9, groupKeyVersion: 2 };
// A roster or succession as stored: the statement, the group's hybrid signature, the signer's own.
const signed = (fill: number) => ({
    statement: b64(1800, fill),
    signature: { ed25519: b64(64, fill), mlDsa: b64(3309, fill) },
    signerSignature: b64(3373, fill),
});
const identity = (fill: number) => ({
    keyVersion: 2,
    encryptionPublicKey: b64(32, fill),
    signingPublicKey: b64(32, fill + 1),
    mlDsaPublicKey: b64(1952, fill),
    kemPublicKey: b64(1184, fill),
    keysSignature: b64(3373, fill),
});
const link = {
    oldKeyVersion: 1,
    newKeyVersion: 2,
    oldEncryptionPublicKey: b64(32, 3),
    oldSigningPublicKey: b64(32, 4),
    oldMlDsaPublicKey: b64(1952, 3),
    newEncryptionPublicKey: b64(32, 5),
    newSigningPublicKey: b64(32, 6),
    newMlDsaPublicKey: b64(1952, 5),
    newKemPublicKey: b64(1184, 5),
    signature: b64(3373, 5),
    consent: b64(3373, 6),
};

type Detail = Reply<typeof groups.getGroup>;
const managerView: Detail = {
    group: family,
    head,
    members: [
        {
            userId: organizer,
            name: 'Ada',
            email: 'ada@example.com',
            state: 'active',
            roles: ['billing', 'members'],
        },
        { userId: member, name: 'Byron', email: 'byron@example.com', state: 'active', roles: [] },
        { userId: newcomer, name: 'Charles', email: null, state: 'accepted', roles: [] },
        { userId: otherGroup, name: 'Mary', email: null, state: 'left', roles: ['guardian'] },
    ],
    seats: { used: 2, limit: 5 },
    due: {
        grants: [{ workspaceId: area, userId: member }],
        markLeft: [otherGroup],
        foldIn: [member],
        succession: true,
        rotations: [area],
        holds: [
            { userId: member, heldBy: organizer, expiresAt: iso(12) },
            // The holder's account is gone; the hold still runs out.
            { userId: newcomer, heldBy: null, expiresAt: iso(13) },
        ],
    },
};

/* The area's root as Drive's rotation work serves a node: one signed file version, a share, a link. */
const areaRoot: Reply<typeof groups.areaRoot> = {
    id: rootId,
    workspaceId: area,
    parentId: null,
    kind: 'folder',
    keyEpoch: 2,
    parentKeyEpoch: 1,
    keyEnvelope: b64(72, 3),
    prevKeyEnvelope: b64(72, 9),
    prevKeyEpoch: 1,
    prevParentKeyEpoch: 1,
    metadataVersion: 2,
    metadataEnvelope: b64(296, 4),
    trashedAt: null,
    changeSeq: 41,
    createdAt: iso(8),
    updatedAt: iso(10),
    envelopeSuite: 1,
    currentVersion: null,
    metadataSigner: { id: member },
    metadataSignature: null,
    metadataRekey: {
        origin: {
            envelope: b64(296, 6),
            signer: { id: organizer },
            signature: b64(64, 6),
            keyEnvelope: b64(72, 6),
        },
        signature: b64(64, 8),
    },
    metadataOriginDropped: null,
    depth: 0,
    versions: [
        {
            id: versionId,
            objectId,
            contentKeyEnvelope: b64(84),
            contentSuite: 3,
            plaintextSize: null,
            signer: { id: organizer },
            signature: b64(64, 1),
            rekey: null,
        },
    ],
    shares: [
        {
            id: shareId,
            granteeUserId: newcomer,
            grantee: { ...identity(11), identityVersion: 2 as const },
        },
    ],
    links: [{ id: linkId, hasPassword: false, secretEnvelope: b64(136), kdfVersion: 2 }],
};

/*
 * Per route: the replies the package can give, the objects a new column would surface in (a stray
 * field is planted there and at the top), and a field the reply cannot go out without.
 */
type Case = {
    schema: AnySchema;
    /* The status the route answers with, when not 200. */
    status?: 201;
    samples: Record<string, unknown>;
    stray: (value: any) => Record<string, unknown>[];
    /* The samples a nested stray can be planted in, when some have nowhere to put one (an empty list). */
    strayIn?: string[];
    /* Which sample to cut, and the cut. */
    required: [string, (value: any) => void];
};
const cases: Record<string, Case> = {
    'POST /groups (created) and PATCH /groups/:id': {
        schema: groupResponse,
        samples: {
            renamed: { group: family } satisfies Reply<typeof groups.renameGroup>,
            'a company group': {
                group: { ...family, kind: 'org' as const, rosterVersion: 1, revision: 1 },
            } satisfies Pick<Reply<typeof groups.createGroup>, 'group'>,
        },
        stray: (v) => [v.group],
        required: ['renamed', (v) => delete v.group.revision],
    },
    'POST /groups (a new group)': {
        schema: groupResponse,
        status: 201,
        samples: {
            created: { group: family } satisfies Pick<Reply<typeof groups.createGroup>, 'group'>,
        },
        stray: (v) => [v.group],
        required: ['created', (v) => delete v.group.kind],
    },
    'GET /groups': {
        schema: groupsResponse,
        samples: {
            'active in one, waiting for another': {
                groups: [
                    {
                        id: groupId,
                        kind: 'family',
                        name: 'The Lovelaces',
                        roles: ['billing', 'guardian', 'members'],
                        state: 'active',
                        rosterVersion: 4,
                        groupKeyVersion: 2,
                    },
                    {
                        id: otherGroup,
                        kind: 'org',
                        name: 'Analytical Engines',
                        roles: [],
                        state: 'accepted',
                        rosterVersion: 1,
                        groupKeyVersion: 1,
                    },
                ],
            } satisfies Reply<typeof groups.listGroups>,
            none: { groups: [] } satisfies Reply<typeof groups.listGroups>,
        },
        stray: (v) => v.groups,
        strayIn: ['active in one, waiting for another'],
        required: ['active in one, waiting for another', (v) => delete v.groups[1].state],
    },
    'GET /groups/:id': {
        schema: groupDetailResponse,
        samples: {
            'a manager, everything due': managerView,
            'a member: grants due only, no departures': {
                ...managerView,
                members: managerView.members.slice(0, 3),
                due: { grants: [] },
            } satisfies Detail,
            // Accepted, not let in: who manages it, and nothing due at all.
            waiting: {
                group: family,
                head,
                members: [managerView.members[0]!],
                seats: { used: 2, limit: 5 },
            } satisfies Detail,
        },
        stray: (v) =>
            [v.group, v.head, v.seats, v.due, ...v.members, ...(v.due?.grants ?? [])]
                .concat(v.due?.holds ?? [])
                .filter(Boolean),
        required: ['a manager, everything due', (v) => delete v.head.digest],
    },
    'GET /groups/:id/rosters': {
        schema: rostersResponse,
        samples: {
            'a page with more': {
                rosters: [
                    { version: 1, ...signed(1) },
                    { version: 2, ...signed(2) },
                ],
                successions: [signed(3)],
                firstKeys: { ed25519PublicKey: b64(32, 9), mlDsaPublicKey: b64(1952, 9) },
                signerKeys: { [b64(32, 10)]: b64(1952, 10), [b64(32, 11)]: b64(1952, 11) },
                head,
                next: 2,
            } satisfies Reply<typeof groups.getRosters>,
            'the last page, before any succession': {
                rosters: [{ version: 4, ...signed(4) }],
                successions: [],
                firstKeys: { ed25519PublicKey: b64(32, 9), mlDsaPublicKey: b64(1952, 9) },
                signerKeys: { [b64(32, 10)]: b64(1952, 10) },
                head,
                next: null,
            } satisfies Reply<typeof groups.getRosters>,
        },
        stray: (v) =>
            [v.firstKeys, v.head, ...v.rosters, ...v.successions].concat(
                [...v.rosters, ...v.successions].map((s: any) => s.signature),
            ),
        required: ['a page with more', (v) => delete v.successions[0].signerSignature],
    },
    'GET /groups/:id/identities': {
        schema: identitiesResponse,
        samples: {
            'a page with more': {
                identities: [
                    // Links from before consent carry none.
                    {
                        userId: organizer,
                        identity: identity(1),
                        links: [link, { ...link, consent: null }],
                    },
                    // An account that is gone: no identity, no links.
                    { userId: member, identity: null, links: [] },
                ],
                next: member,
            } satisfies Reply<typeof groups.getIdentities>,
            'the last page': {
                identities: [{ userId: newcomer, identity: identity(2), links: [] }],
                next: null,
            } satisfies Reply<typeof groups.getIdentities>,
        },
        stray: (v) =>
            v.identities.flatMap((row: any) => [row, row.identity, ...row.links].filter(Boolean)),
        required: ['a page with more', (v) => delete v.identities[0].links[0].consent],
    },
    'every roster route (7, 10, 17, 18, 19, 21, 24, a folder deletion)': {
        schema: chainHeadResponse,
        samples: {
            // Each route's own answer type: the same head, so a route that drifts fails here.
            'rosters (7)': { ...head, replayed: false } satisfies Reply<typeof groups.postRoster>,
            'a succession (10)': { ...head, groupKeyVersion: 3, replayed: false } satisfies Reply<
                typeof groups.postSuccession
            >,
            'an admission (17)': { ...head, replayed: false } satisfies Reply<typeof groups.admit>,
            'roles (18)': { ...head, replayed: false } satisfies Reply<typeof groups.patchMember>,
            'a removal (19)': { ...head, replayed: false } satisfies Reply<
                typeof groups.removeMember
            >,
            'a new folder (21)': { ...head, replayed: false } satisfies Reply<
                typeof groups.createArea
            >,
            'a deleted folder': { ...head, replayed: false } satisfies Reply<
                typeof groups.deleteArea
            >,
            'a rotation (24)': { ...head, replayed: false } satisfies Reply<
                typeof groups.rotateArea
            >,
            replayed: { ...head, replayed: true } satisfies Reply<typeof groups.postRoster>,
        },
        stray: () => [],
        strayIn: [],
        required: ['replayed', (v) => delete v.replayed],
    },
    'GET /groups/:id/key-seal': {
        schema: keySealResponse,
        samples: {
            sealed: {
                groupKeyVersion: 2,
                holderKeyVersion: 3,
                sealerUserId: organizer,
                rosterVersion: 4,
                rosterDigest: b64(32, 1),
                envelope: b64(4597, 2),
            } satisfies Reply<typeof groups.getKeySeal>,
        },
        stray: () => [],
        strayIn: [],
        required: ['sealed', (v) => delete v.rosterDigest],
    },
    'PUT /groups/:id/key-seals and POST /groups/:id/areas/:workspaceId/grants': {
        schema: storedResponse,
        samples: {
            seals: { stored: 2 } satisfies Reply<typeof groups.putKeySeals>,
            'nothing new': { stored: 0 } satisfies Reply<typeof groups.postGrants>,
        },
        stray: () => [],
        strayIn: [],
        required: ['seals', (v) => delete v.stored],
    },
    'POST /groups/:id/invitations': {
        schema: invitedResponse,
        status: 201,
        samples: {
            invited: { id: invitationId, expiresAt: iso(20) } satisfies Reply<typeof groups.invite>,
        },
        stray: () => [],
        strayIn: [],
        required: ['invited', (v) => delete v.expiresAt],
    },
    'GET /groups/:id/invitations': {
        schema: invitationsResponse,
        samples: {
            open: {
                invitations: [
                    {
                        id: invitationId,
                        email: 'charles@example.com',
                        roles: ['members'],
                        invitedBy: organizer,
                        expiresAt: iso(20),
                    },
                    // The inviter's account is gone; the invitation stays open.
                    {
                        id: shareId,
                        email: 'mary@example.com',
                        roles: [],
                        invitedBy: null,
                        expiresAt: iso(21),
                    },
                ],
            } satisfies Reply<typeof groups.listInvitations>,
            none: { invitations: [] } satisfies Reply<typeof groups.listInvitations>,
        },
        stray: (v) => v.invitations,
        strayIn: ['open'],
        required: ['open', (v) => delete v.invitations[0].invitedBy],
    },
    'DELETE /groups/:id/invitations/:invitationId': {
        schema: revokedResponse,
        samples: { revoked: { revoked: true } satisfies Reply<typeof groups.revokeInvitation> },
        stray: () => [],
        strayIn: [],
        required: ['revoked', (v) => delete v.revoked],
    },
    'GET /invitations': {
        schema: myInvitationsResponse,
        samples: {
            two: {
                invitations: [
                    {
                        id: invitationId,
                        name: 'The Lovelaces',
                        inviterName: 'Ada',
                        expiresAt: iso(20),
                    },
                    { id: shareId, name: 'The Byrons', inviterName: null, expiresAt: iso(22) },
                ],
            } satisfies Reply<typeof groups.listMyInvitations>,
            none: { invitations: [] } satisfies Reply<typeof groups.listMyInvitations>,
        },
        stray: (v) => v.invitations,
        strayIn: ['two'],
        required: ['two', (v) => delete v.invitations[1].inviterName],
    },
    'POST /invitations/open': {
        schema: openedInvitationResponse,
        samples: {
            'in another family': {
                inFamily: { groupId: otherGroup, name: 'The Byrons' },
                invitationId,
                groupId,
                kind: 'family',
                name: 'The Lovelaces',
                inviter: { id: organizer, name: 'Ada', email: 'ada@example.com' },
                roles: ['guardian'],
                expiresAt: iso(20),
            } satisfies Reply<typeof groups.openInvitation>,
            'from an account that is gone': {
                inFamily: null,
                invitationId,
                groupId,
                kind: 'family',
                name: 'The Lovelaces',
                inviter: null,
                roles: [],
                expiresAt: iso(20),
            } satisfies Reply<typeof groups.openInvitation>,
        },
        stray: (v) => [v.inFamily, v.inviter].filter(Boolean),
        strayIn: ['in another family'],
        required: ['in another family', (v) => delete v.inviter.email],
    },
    'POST /invitations/accept': {
        schema: acceptedResponse,
        samples: {
            accepted: { groupId, state: 'accepted' } satisfies Reply<
                typeof groups.acceptInvitation
            >,
        },
        stray: () => [],
        strayIn: [],
        required: ['accepted', (v) => delete v.groupId],
    },
    'GET /groups/:id/pending': {
        schema: pendingResponse,
        samples: {
            two: {
                pending: [
                    {
                        userId: newcomer,
                        name: 'Charles',
                        email: 'charles@example.com',
                        roles: ['members'],
                        acceptedAt: iso(9),
                        identity: identity(4),
                        inFamily: false,
                    },
                    // Before acceptance times were kept, with no identity readable yet, in another family.
                    {
                        userId: member,
                        name: 'Byron',
                        email: 'byron@example.com',
                        roles: [],
                        acceptedAt: null,
                        identity: null,
                        inFamily: true,
                    },
                ],
            } satisfies Reply<typeof groups.listPending>,
            none: { pending: [] } satisfies Reply<typeof groups.listPending>,
        },
        stray: (v) => v.pending.flatMap((row: any) => [row, row.identity].filter(Boolean)),
        strayIn: ['two'],
        required: ['two', (v) => delete v.pending[0].identity.keysSignature],
    },
    'POST /groups/:id/members/:userId/remove-preview': {
        schema: removalPreviewResponse,
        samples: {
            two: {
                plans: [
                    { id: 'sub_a', name: 'Family Plus (monthly)', standing: 'payment-failed' },
                    { id: 'sub_b', name: 'Family Pro (monthly)', standing: 'paused' },
                ],
            } satisfies Reply<typeof groups.removalPreview>,
            none: { plans: [] } satisfies Reply<typeof groups.removalPreview>,
        },
        stray: (v) => v.plans,
        strayIn: ['two'],
        required: ['two', (v) => delete v.plans[0].id],
    },
    'POST /groups/:id/members/:userId/decline': {
        schema: declinedResponse,
        samples: { declined: { declined: true } satisfies Reply<typeof groups.declinePending> },
        stray: () => [],
        strayIn: [],
        required: ['declined', (v) => delete v.declined],
    },
    'POST /groups/:id/members/:userId/hold': {
        schema: heldResponse,
        samples: { held: { heldUntil: iso(12) } satisfies Reply<typeof groups.hold> },
        stray: () => [],
        strayIn: [],
        required: ['held', (v) => delete v.heldUntil],
    },
    'POST /groups/:id/leave': {
        schema: leftResponse,
        samples: {
            left: { state: 'left' } satisfies Reply<typeof groups.leave>,
            'the last one out': { state: 'left', dissolved: true } satisfies Reply<
                typeof groups.leave
            >,
        },
        stray: () => [],
        strayIn: [],
        required: ['the last one out', (v) => delete v.state],
    },
    'PUT /groups/:id/areas/:workspaceId/self-grant': {
        schema: selfGrantResponse,
        samples: { stored: { ok: true } satisfies Reply<typeof groups.putSelfGrant> },
        stray: () => [],
        strayIn: [],
        required: ['stored', (v) => delete v.ok],
    },
    'PUT /groups/:id/areas/:workspaceId/previous-root': {
        schema: previousRootResponse,
        samples: { replaced: { changeSeq: 42 } satisfies Reply<typeof groups.putPreviousRoot> },
        stray: () => [],
        strayIn: [],
        required: ['replaced', (v) => delete v.changeSeq],
    },
    'GET /groups/:id/areas/:workspaceId/root': {
        schema: areaRootResponse,
        samples: {
            'mid-rotation, re-keyed, shared and linked': areaRoot,
            // A grantee still on a version 1 identity: no ML-DSA key, KEM key or statement.
            'a version 1 grantee, no versions or links': {
                ...areaRoot,
                prevKeyEnvelope: null,
                prevKeyEpoch: null,
                prevParentKeyEpoch: null,
                metadataSigner: null,
                metadataRekey: null,
                versions: [],
                shares: [
                    {
                        id: shareId,
                        granteeUserId: newcomer,
                        grantee: {
                            keyVersion: 1,
                            identityVersion: 1,
                            encryptionPublicKey: b64(32, 12),
                            signingPublicKey: b64(32, 13),
                            mlDsaPublicKey: null,
                            kemPublicKey: null,
                            keysSignature: null,
                        },
                    },
                ],
                links: [],
            } satisfies Reply<typeof groups.areaRoot>,
        },
        stray: (v) =>
            [v.metadataRekey, v.metadataRekey?.origin, ...v.versions, ...v.shares, ...v.links]
                .concat(v.shares.map((s: any) => s.grantee))
                .filter(Boolean),
        required: [
            'mid-rotation, re-keyed, shared and linked',
            (v) => delete v.metadataRekey.origin.keyEnvelope,
        ],
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
                for (const object of nested) object.signingPrivateKey = 'nested';
                const { status: served, body } = await serve(schema, planted, status);
                expect(served).toBe(status ?? 200);
                expect(body).toEqual(sample);
                expect(JSON.stringify(body)).not.toMatch(/leaked|signingPrivateKey/);
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

/* A role, state or kind outside the database's own set fails rather than going out. */
test('refuses a role, state, kind or standing outside its set', async () => {
    const roles = clone(managerView) as any;
    roles.members[0].roles = ['owner'];
    expect((await serve(groupDetailResponse, roles)).status).toBe(500);
    const state = clone(managerView) as any;
    state.members[1].state = 'invited';
    expect((await serve(groupDetailResponse, state)).status).toBe(500);
    const kind = clone(cases['POST /invitations/open']!.samples['in another family']) as any;
    kind.kind = 'team';
    expect((await serve(openedInvitationResponse, kind)).status).toBe(500);
    const standing = clone(
        cases['POST /groups/:id/members/:userId/remove-preview']!.samples.two,
    ) as any;
    standing.plans[1].standing = 'ended';
    expect((await serve(removalPreviewResponse, standing)).status).toBe(500);
});

/*
 * signerKeys is keyed by digest, so any key goes out; its values are keys and nothing else. A
 * value that is not a string (an object, a Buffer serialized) fails rather than reaching a
 * client's verifier.
 */
test("a roster page's signer keys keep every digest and refuse a value that is not a key", async () => {
    const page = cases['GET /groups/:id/rosters']!.samples['a page with more'] as Reply<
        typeof groups.getRosters
    >;
    const served = await serve(rostersResponse, page);
    expect(Object.keys((served.body as typeof page).signerKeys)).toEqual(
        Object.keys(page.signerKeys),
    );
    const wrong = clone(page) as any;
    wrong.signerKeys[b64(32, 10)] = { type: 'Buffer', data: [1, 2, 3] };
    expect((await serve(rostersResponse, wrong)).status).toBe(500);
});

/*
 * A reply that fails its schema is the server's bug: on a groups route it must be a 500 with no
 * code, an unknown outcome the outbox sends again, never a coded 4xx (`invalid`), which the
 * clients take as a refusal and drop the signed call on.
 */
test('a groups reply that fails its schema is a 500 with no code, never a refusal', async () => {
    await loadApi();
    const { requestContext } = await import('@/lib/api/shared.server');
    const app = new Elysia({ prefix: '/api' })
        .use(requestContext)
        .get(
            '/groups/probe',
            { response: { 200: t.Object({ right: t.String() }) } },
            () => ({ wrong: 1 }) as unknown as { right: string },
        )
        .get(
            '/invitations/probe',
            { response: { 200: t.Object({ right: t.String() }) } },
            () => ({ wrong: 1 }) as unknown as { right: string },
        );
    for (const path of ['/api/groups/probe', '/api/invitations/probe']) {
        const response = await app.handle(new Request(`http://localhost${path}`));
        expect(response.status, path).toBe(500);
        expect((await response.json()) as Record<string, unknown>, path).not.toHaveProperty('code');
    }
});

/* The schemas guard nothing unless the routes carry them: every groups route names its own. */
const expectedSchemas: Record<string, { 200?: AnySchema; 201?: AnySchema }> = {
    'POST /api/groups': { 200: groupResponse, 201: groupResponse },
    'GET /api/groups': { 200: groupsResponse },
    'GET /api/groups/:id': { 200: groupDetailResponse },
    'PATCH /api/groups/:id': { 200: groupResponse },
    'GET /api/groups/:id/rosters': { 200: rostersResponse },
    'GET /api/groups/:id/identities': { 200: identitiesResponse },
    'POST /api/groups/:id/rosters': { 200: chainHeadResponse },
    'GET /api/groups/:id/key-seal': { 200: keySealResponse },
    'PUT /api/groups/:id/key-seals': { 200: storedResponse },
    'POST /api/groups/:id/key-successions': { 200: chainHeadResponse },
    'POST /api/groups/:id/invitations': { 201: invitedResponse },
    'GET /api/groups/:id/invitations': { 200: invitationsResponse },
    'DELETE /api/groups/:id/invitations/:invitationId': { 200: revokedResponse },
    'GET /api/invitations': { 200: myInvitationsResponse },
    'POST /api/invitations/open': { 200: openedInvitationResponse },
    'POST /api/invitations/accept': { 200: acceptedResponse },
    'GET /api/groups/:id/pending': { 200: pendingResponse },
    'POST /api/groups/:id/members/:userId/admit': { 200: chainHeadResponse },
    'PATCH /api/groups/:id/members/:userId': { 200: chainHeadResponse },
    'POST /api/groups/:id/members/:userId/remove': { 200: chainHeadResponse },
    'POST /api/groups/:id/members/:userId/remove-preview': { 200: removalPreviewResponse },
    'POST /api/groups/:id/members/:userId/decline': { 200: declinedResponse },
    'POST /api/groups/:id/members/:userId/hold': { 200: heldResponse },
    'POST /api/groups/:id/leave': { 200: leftResponse },
    'POST /api/groups/:id/areas': { 200: chainHeadResponse },
    'POST /api/groups/:id/areas/:workspaceId/grants': { 200: storedResponse },
    'PUT /api/groups/:id/areas/:workspaceId/self-grant': { 200: selfGrantResponse },
    'PUT /api/groups/:id/areas/:workspaceId/previous-root': { 200: previousRootResponse },
    'GET /api/groups/:id/areas/:workspaceId/root': { 200: areaRootResponse },
    'POST /api/groups/:id/areas/:workspaceId/delete': { 200: chainHeadResponse },
    'POST /api/groups/:id/areas/:workspaceId/rotations': { 200: chainHeadResponse },
};
/*
 * Routes deliberately served without a schema, each with its reason. None today: every handler
 * builds its reply field by field, so each can be declared exactly, signed payloads included.
 */
const leftOut: Record<string, string> = {};

test('each groups and invitations route carries its reply schema', async () => {
    const app = await loadApi();
    const routes = (
        app.routes as unknown as (ApiRoute & { hooks: { response?: unknown } })[]
    ).filter((r) => /^\/api\/(groups|invitations)(\/|$)/.test(r.path));
    for (const [key, statuses] of Object.entries(expectedSchemas)) {
        const [method, path] = key.split(' ');
        const route = routes.find((r) => r.method === method && r.path === path);
        expect(route, key).toBeDefined();
        const response = route!.hooks.response as Record<number, unknown>;
        // A status the route answers with but has no schema for goes out unchecked.
        expect(Object.keys(response).sort(), key).toEqual(Object.keys(statuses).sort());
        for (const [status, schema] of Object.entries(statuses))
            // Elysia keeps a copy of each schema, so equal in structure; the schemas all differ in shape.
            expect(response[Number(status)], `${key} ${status}`).toEqual(schema);
    }
    // A route added later without a schema, or one this list forgot, fails here.
    const unlisted = routes
        .map((r) => `${r.method} ${r.path}`)
        .filter((key) => !(key in expectedSchemas) && !(key in leftOut));
    expect(unlisted).toEqual([]);
});
