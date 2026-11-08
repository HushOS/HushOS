import '@/lib/server-only';
import type * as drive from '@hushos/drive/server';
import { t } from 'elysia';

/*
 * What the Drive reads that carry keys and the tree answer (drive.server.ts), field for field.
 * Elysia checks a reply against its schema and drops every field the schema does not name, so a
 * column added to a row later stays on the server. Each mirrors the view @hushos/drive/server
 * builds (nodeView, versionView, shareView, linkView, publicIdentity, rotationWorkView): a field
 * the schema misses is silently dropped, and one it requires that the view leaves out fails the
 * request. Envelopes, signatures and salts are Base64url, kept as plain strings; byte counts are
 * decimal strings and dates ISO strings, as the views make them. Suites and key-derivation
 * versions stay plain integers: a reader refuses one it does not know, so the server must not.
 */

const signer = t.Object({ id: t.String() });

/* RekeyView: what a rotation kept of a record's writer, and the re-keyer's signature; or null. */
const rekey = t.Nullable(
    t.Object({
        origin: t.Object({
            envelope: t.String(),
            signer: t.Nullable(signer),
            signature: t.String(),
            keyEnvelope: t.String(),
        }),
        signature: t.String(),
    }),
);
/* DroppedView: who the server says dropped a kept origin; or null. */
const dropped = t.Nullable(t.Object({ by: signer }));

/* A version as a link visitor sees it (VisitorVersionView): no signer, signature or origin. */
const visitorVersionFields = {
    id: t.String(),
    objectId: t.String(),
    contentKeyEnvelope: t.String(),
    status: t.Union([t.Literal('pending'), t.Literal('ready'), t.Literal('purged')]),
    objectStatus: t.Union([t.Literal('pending'), t.Literal('ready'), t.Literal('missing')]),
    contentSuite: t.Integer(),
    chunkSize: t.Integer(),
    chunkCount: t.Integer(),
    contentNonce: t.String(),
    // Suite 1 only; null under suites 2 and 3.
    plaintextSize: t.Nullable(t.String()),
    ciphertextSize: t.String(),
    readyAt: t.Nullable(t.String()),
};
/* VersionView: null signer and signature before signatures, null rekey unless a rotation kept one. */
const versionFields = {
    ...visitorVersionFields,
    signer: t.Nullable(signer),
    signature: t.Nullable(t.String()),
    rekey,
    originDropped: dropped,
};
const version = t.Object(versionFields);
const visitorVersion = t.Object(visitorVersionFields);

/*
 * A node as a link visitor sees it (VisitorNodeView): no metadata signer, signature or origin,
 * and changeSeq null. A grantee's (granteeView) is a member's with changeSeq null.
 */
const visitorNodeFields = {
    id: t.String(),
    workspaceId: t.String(),
    parentId: t.Nullable(t.String()),
    kind: t.Union([t.Literal('folder'), t.Literal('file')]),
    keyEpoch: t.Integer(),
    parentKeyEpoch: t.Integer(),
    keyEnvelope: t.String(),
    // Set together while a rotation runs, null otherwise.
    prevKeyEnvelope: t.Nullable(t.String()),
    prevKeyEpoch: t.Nullable(t.Integer()),
    prevParentKeyEpoch: t.Nullable(t.Integer()),
    metadataVersion: t.Integer(),
    metadataEnvelope: t.String(),
    trashedAt: t.Nullable(t.String()),
    changeSeq: t.Nullable(t.Integer()),
    createdAt: t.String(),
    updatedAt: t.String(),
    envelopeSuite: t.Integer(),
};
const nodeFields = {
    ...visitorNodeFields,
    currentVersion: t.Nullable(version),
    metadataSigner: t.Nullable(signer),
    metadataSignature: t.Nullable(t.String()),
    metadataRekey: rekey,
    metadataOriginDropped: dropped,
};
const node = t.Object(nodeFields);
const visitorNode = t.Object({ ...visitorNodeFields, currentVersion: t.Nullable(visitorVersion) });

/* Someone's public identity (publicIdentity): a version 1 identity has no ML-DSA key or statement. */
const servedIdentityFields = {
    keyVersion: t.Integer(),
    identityVersion: t.Union([t.Literal(1), t.Literal(2)]),
    encryptionPublicKey: t.String(),
    signingPublicKey: t.String(),
    mlDsaPublicKey: t.Nullable(t.String()),
    kemPublicKey: t.Nullable(t.String()),
    keysSignature: t.Nullable(t.String()),
};
const servedIdentity = t.Object(servedIdentityFields);

/* The member's own wrapped workspace key (WorkspaceKeyEnvelope), served as version 1. */
const workspaceGrant = t.Object({
    version: t.Literal(1),
    workspaceId: t.String(),
    keyVersion: t.Integer(),
    workspaceKeyVersion: t.Integer(),
    wrappingSalt: t.String(),
    wrappingNonce: t.String(),
    encryptedKey: t.String(),
});
/* A rotation the owner's device has not finished. */
const rotation = t.Object({ id: t.String(), nodeId: t.String(), targetEpoch: t.Integer() });

const role = t.Union([t.Literal('viewer'), t.Literal('editor')]);
/* ShareView: the owner's view of a live share; suite told apart by the envelope's length. */
const shareFields = {
    id: t.String(),
    role,
    keyEpoch: t.Integer(),
    createdAt: t.String(),
    suite: t.Union([t.Literal(1), t.Literal(2), t.Literal(3), t.Literal(4)]),
    grantee: t.Object({ id: t.String(), name: t.String(), email: t.String() }),
};
/* LinkView: the owner's view of a live link, never its token. Null secret on links made before it. */
const linkFields = {
    id: t.String(),
    keyEpoch: t.Integer(),
    secretEnvelope: t.Nullable(t.String()),
    hasPassword: t.Boolean(),
    kdfVersion: t.Integer(),
    expiresAt: t.Nullable(t.String()),
    useCount: t.Integer(),
    lastUsedAt: t.Nullable(t.String()),
    createdAt: t.String(),
};

/* GET /drive/workspace: the personal workspace, the member's grant, its root and any rotation. */
export const workspaceResponse = t.Object({
    workspaceId: t.String(),
    changeSeq: t.Integer(),
    grant: t.Nullable(workspaceGrant),
    root: t.Nullable(node),
    rotation: t.Nullable(rotation),
});

/*
 * GET /drive/spaces: the personal space first, then each group's areas while groups are on. A
 * personal area has no id seed and no area grant, only the member's own; told apart by
 * `space.kind`, so no reply matches both variants.
 */
const areaFields = {
    workspaceId: t.String(),
    workspaceKeyVersion: t.Integer(),
    changeSeq: t.Integer(),
    root: t.Nullable(node),
    rotation: t.Nullable(rotation),
    selfGrant: t.Nullable(workspaceGrant),
};
export const spacesResponse = t.Object({
    spaces: t.Array(
        t.Union([
            t.Object({
                space: t.Object({ kind: t.Literal('personal') }),
                areas: t.Array(t.Object(areaFields)),
            }),
            t.Object({
                space: t.Object({
                    kind: t.Literal('group'),
                    groupId: t.String(),
                    name: t.String(),
                }),
                areas: t.Array(
                    t.Object({
                        ...areaFields,
                        idSeed: t.String(),
                        grant: t.Nullable(
                            t.Object({
                                workspaceKeyVersion: t.Integer(),
                                granteeKeyVersion: t.Integer(),
                                granterUserId: t.String(),
                                rosterVersion: t.Integer(),
                                rosterDigest: t.String(),
                                envelope: t.String(),
                            }),
                        ),
                    }),
                ),
            }),
        ]),
    ),
});

/* GET /drive/shares: each share received, its node a root of its own seen as a grantee. */
export const sharedWithMeResponse = t.Object({
    shares: t.Array(
        t.Object({
            id: t.String(),
            workspaceId: t.String(),
            role,
            keyEpoch: t.Integer(),
            shareEnvelope: t.String(),
            // Set together while a rotation in flight replaced a suite 4 envelope, null otherwise.
            prevShareEnvelope: t.Nullable(t.String()),
            prevKeyEpoch: t.Nullable(t.Integer()),
            createdAt: t.String(),
            cursor: t.String(),
            granter: t.Object({
                id: t.String(),
                name: t.String(),
                email: t.String(),
                ...servedIdentityFields,
            }),
            node,
        }),
    ),
});

/* GET /drive/shares/mine: what the caller shares out, by account and by link, with the nodes. */
export const sharedByMeResponse = t.Object({
    shares: t.Array(t.Object({ ...shareFields, node, granteeIdentity: servedIdentity })),
    links: t.Array(t.Object({ ...linkFields, node })),
});

/* GET /drive/nodes/:id/children: a page of a folder; nodes as a grantee sees them through a share. */
export const listingResponse = t.Object({
    folder: node,
    ancestors: t.Array(node),
    children: t.Array(node),
    nextCursor: t.Nullable(t.String()),
});

/* GET /drive/nodes/:id/versions: the ready versions, newest first. */
export const versionsResponse = t.Object({
    versions: t.Array(
        t.Object({
            ...versionFields,
            current: t.Boolean(),
            supersededAt: t.Nullable(t.String()),
            createdAt: t.String(),
        }),
    ),
});

/* GET /drive/nodes/:id/shares. */
export const nodeSharesResponse = t.Object({ shares: t.Array(t.Object(shareFields)) });

/* GET /drive/nodes/:id/links. */
export const nodeLinksResponse = t.Object({ links: t.Array(t.Object(linkFields)) });

/* GET /drive/workspaces/:id/documents/:kind: the sealed document, or null before the first write. */
export const documentResponse = t.Object({
    document: t.Nullable(
        t.Object({
            kind: t.String(),
            version: t.Integer(),
            envelope: t.String(),
            updatedAt: t.String(),
            envelopeSuite: t.Integer(),
        }),
    ),
});

/*
 * GET /drive/workspaces/:id/changes. Each change is told apart by `kind`, so no change matches
 * two variants. The workspace feed never holds `entered` or `left` today; the type allows them.
 */
const membershipKind = t.Union([t.Literal('entered'), t.Literal('left')]);
export const changesResponse = t.Object({
    changes: t.Array(
        t.Union([
            t.Object({ kind: t.Literal('node'), changeSeq: t.Integer(), node }),
            t.Object({
                kind: t.Literal('tombstone'),
                changeSeq: t.Integer(),
                nodeId: t.String(),
                parentId: t.Nullable(t.String()),
            }),
            t.Object({ kind: membershipKind, changeSeq: t.Integer(), nodeId: t.String() }),
        ]),
    ),
    resync: t.Boolean(),
    nextCursor: t.Integer(),
    hasMore: t.Boolean(),
});

/* GET /drive/shares/:id/changes: as the workspace feed, without the owner's sequence numbers. */
export const shareChangesResponse = t.Object({
    changes: t.Array(
        t.Union([
            t.Object({ kind: t.Literal('node'), node }),
            t.Object({
                kind: t.Literal('tombstone'),
                nodeId: t.String(),
                parentId: t.Nullable(t.String()),
            }),
            t.Object({ kind: membershipKind, nodeId: t.String() }),
        ]),
    ),
    cursor: t.String(),
    hasMore: t.Boolean(),
    resync: t.Boolean(),
});

/*
 * GET /drive/nodes/:id/rotation/work: a batch of nodes with everything sealed under their keys.
 * The rotation is served without its id here; links without their derivation version.
 */
export const rotationWorkResponse = t.Object({
    rotation: t.Object({ nodeId: t.String(), targetEpoch: t.Integer() }),
    nodes: t.Array(
        t.Object({
            ...nodeFields,
            depth: t.Integer(),
            versions: t.Array(
                t.Object({
                    id: t.String(),
                    objectId: t.String(),
                    contentKeyEnvelope: t.String(),
                    contentSuite: t.Integer(),
                    plaintextSize: t.Nullable(t.String()),
                    signer: t.Nullable(signer),
                    signature: t.Nullable(t.String()),
                    rekey,
                }),
            ),
            shares: t.Array(
                t.Object({ id: t.String(), granteeUserId: t.String(), grantee: servedIdentity }),
            ),
            links: t.Array(
                t.Object({
                    id: t.String(),
                    hasPassword: t.Boolean(),
                    secretEnvelope: t.Nullable(t.String()),
                }),
            ),
        }),
    ),
    nextCursor: t.Nullable(t.String()),
    done: t.Boolean(),
});

/* GET /drive/links/open: the link a visitor's token names, and its node as a visitor sees it. */
export const openLinkResponse = t.Object({
    link: t.Object({
        id: t.String(),
        workspaceId: t.String(),
        keyEpoch: t.Integer(),
        hasPassword: t.Boolean(),
        kdfVersion: t.Integer(),
        linkSalt: t.String(),
        linkEnvelope: t.String(),
        expiresAt: t.Nullable(t.String()),
    }),
    node: visitorNode,
});

/* GET /drive/links/nodes/:nodeId/children: a page of a folder beneath the link, as a visitor sees it. */
export const linkListingResponse = t.Object({
    folder: visitorNode,
    ancestors: t.Array(visitorNode),
    children: t.Array(visitorNode),
    nextCursor: t.Nullable(t.String()),
});

/*
 * The account's own space in /drive/spaces, built from its workspace. A function, not inline in
 * the route, so the test's sample is typed by what the route really sends: a field added here and
 * not to `spacesResponse` fails typecheck there instead of being stripped unseen.
 */
export function personalSpace(personal: Awaited<ReturnType<typeof drive.getWorkspace>>) {
    return {
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
    };
}
