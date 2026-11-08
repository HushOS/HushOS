// @vitest-environment node
import { Elysia, type AnySchema } from 'elysia';
import { describe, expect, test, vi } from 'vitest';
import type { NodeRow, VersionRow, rotationsRepository } from '@hushos/db';
import type * as drive from '@hushos/drive/server';
import type * as groups from '@hushos/groups/server';
import {
    changesResponse,
    documentResponse,
    linkListingResponse,
    listingResponse,
    nodeLinksResponse,
    nodeSharesResponse,
    openLinkResponse,
    rotationWorkResponse,
    shareChangesResponse,
    sharedByMeResponse,
    sharedWithMeResponse,
    spacesResponse,
    versionsResponse,
    workspaceResponse,
} from '@/lib/api/drive-responses.server';
import { loadApi, type ApiRoute } from '@/test/api-app';
import type { personalSpace as personalSpaceOf } from '@/lib/api/drive-responses.server';

/*
 * The Drive reads' reply schemas, through a real Elysia route so normalisation runs as it does in
 * the app: what the Drive package returns goes out unchanged (every variant: legacy suites,
 * unsigned and re-keyed records, nulls), a field the schema does not name is dropped, and a reply
 * missing a field a client needs fails instead of going out short. Nodes are made by the
 * package's own nodeView, granteeView and rotationWorkView from rows shaped as the repository
 * returns them; the rest are typed as the package's return types, so a sample that drifts from
 * what the handler returns fails typecheck.
 */

// The views live in the server module, which reads its environment on import.
vi.stubEnv('DATABASE_URL', 'postgresql://test:test@127.0.0.1:1/test');
vi.stubEnv('STORAGE_ACCESS_KEY_ID', 'test');
vi.stubEnv('STORAGE_BUCKET', 'test');
vi.stubEnv('STORAGE_ENDPOINT', 'http://127.0.0.1:1');
vi.stubEnv('STORAGE_SECRET_ACCESS_KEY', 'test');
const { granteeView, nodeView, rotationWorkView } = await import('@hushos/drive/server');

type Reply<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

async function serve(schema: AnySchema, value: unknown) {
    const app = new Elysia().get('/x', { response: { 200: schema } }, () => value as never);
    const response = await app.handle(new Request('http://localhost/x'));
    return {
        status: response.status,
        body: response.ok ? ((await response.json()) as unknown) : null,
    };
}

const clone = <T>(value: T): T => structuredClone(value);
const bytes = (length: number, fill = 7) => Buffer.alloc(length, fill);
const b64 = (length: number, fill = 7) => bytes(length, fill).toString('base64url');

const ws = '0b5e0d1c-6a4e-4c41-9a43-2b1f4d8f9e10';
const area = '1c6f1e2d-7b5f-4d52-8b54-3c2a5e9a0f21';
const area2 = 'b063b2a1-15f3-41fc-8f5e-d0c4f234a3cb';
const owner = '2d7a2f3e-8c6a-4e63-9c65-4d3b6fab1a32';
const editor = '3e8b3a4f-9d7b-4f74-8d76-5e4c7abc2b43';
const rootId = '4f9c4b5a-ae8c-4a85-9e87-6f5d8bcd3c54';
const folderId = '5a0d5c6b-bf9d-4b96-8f98-7a6e9cde4d65';
const fileId = '6b1e6d7c-c0ae-4ca7-9a09-8b7fadef5e76';
const versionId = '7c2f7e8d-d1bf-4db8-8b1a-9c80bef06f87';
const objectId = '8d308f9e-e2c0-4ec9-9c2b-ad91cf017098';
const shareId = '9e41908f-f3d1-4fda-8d3c-bea2d01281a9';
const linkId = 'af52a190-04e2-40eb-9e4d-cfb3e12392ba';
const at = (hour: number) => new Date(Date.UTC(2026, 10, 8, hour));
const iso = (hour: number) => at(hour).toISOString();

/* A version as the repository joins it: suite 3, signed by the owner, no origin kept. */
function versionRow(overrides: Partial<VersionRow> = {}): VersionRow {
    return {
        id: versionId,
        objectId,
        contentKeyEnvelope: bytes(84),
        signerId: owner,
        signature: bytes(64, 1),
        signer: { id: owner },
        originEnvelope: null,
        originKeyEnvelope: null,
        originSignerId: null,
        originSignature: null,
        rekeySignature: null,
        droppedSignerId: null,
        originDroppedBy: null,
        status: 'ready',
        plaintextSize: null,
        ciphertextSize: 1_048_640n,
        chunkSize: 4_194_304,
        chunkCount: 1,
        contentNonce: bytes(16, 2),
        contentSuite: 3,
        objectStatus: 'ready',
        readyAt: at(9),
        ...overrides,
    };
}
/* A node as selectNodes returns it: a signed folder with no rotation, origin or version. */
function nodeRow(
    overrides: Partial<NodeRow & { currentVersion: VersionRow | null }> = {},
): NodeRow & { currentVersion: VersionRow | null } {
    return {
        id: folderId,
        workspaceId: ws,
        parentId: rootId,
        kind: 'folder',
        keyEpoch: 3,
        parentKeyEpoch: 2,
        keyEnvelope: bytes(72, 3),
        prevKeyEnvelope: null,
        prevKeyEpoch: null,
        prevParentKeyEpoch: null,
        metadataVersion: 2,
        metadataEnvelope: bytes(296, 4),
        envelopeSuite: 1,
        metadataSignerId: owner,
        metadataSignature: bytes(64, 5),
        metadataSigner: { id: owner },
        metadataOriginEnvelope: null,
        metadataOriginKeyEnvelope: null,
        metadataOriginSignerId: null,
        metadataOriginSignature: null,
        metadataRekeySignature: null,
        metadataDroppedSignerId: null,
        metadataOriginDroppedBy: null,
        currentVersionId: null,
        currentVersion: null,
        trashedAt: null,
        removedAt: null,
        heightBound: 1,
        changeSeq: 41,
        createdAt: at(8),
        updatedAt: at(10),
        ...overrides,
    };
}

const rows = {
    root: nodeRow({ id: rootId, parentId: null, parentKeyEpoch: 1, keyEpoch: 1, changeSeq: 1 }),
    folder: nodeRow(),
    file: nodeRow({
        id: fileId,
        parentId: folderId,
        kind: 'file',
        heightBound: 0,
        currentVersionId: versionId,
        currentVersion: versionRow(),
    }),
    // Written before signatures: no signer anywhere, and suite 1 content with its plaintext size.
    legacyFile: nodeRow({
        id: fileId,
        kind: 'file',
        heightBound: 0,
        metadataSignerId: null,
        metadataSignature: null,
        metadataSigner: null,
        currentVersionId: versionId,
        currentVersion: versionRow({
            contentKeyEnvelope: bytes(72),
            signerId: null,
            signature: null,
            signer: null,
            contentSuite: 1,
            plaintextSize: 1_048_576n,
            readyAt: null,
        }),
    }),
    // Re-keyed by an editor's rotation, without a legacy signature beside it: the origin kept.
    rekeyed: nodeRow({
        id: fileId,
        kind: 'file',
        heightBound: 0,
        metadataSignerId: editor,
        metadataSignature: null,
        metadataSigner: { id: editor },
        metadataOriginEnvelope: bytes(296, 6),
        metadataOriginKeyEnvelope: bytes(72, 6),
        metadataOriginSignerId: owner,
        metadataOriginSignature: bytes(64, 6),
        metadataRekeySignature: bytes(64, 8),
        currentVersionId: versionId,
        currentVersion: versionRow({
            signerId: editor,
            signature: null,
            signer: { id: editor },
            originEnvelope: bytes(84, 6),
            originKeyEnvelope: bytes(72, 6),
            originSignerId: owner,
            originSignature: bytes(64, 6),
            rekeySignature: bytes(64, 8),
        }),
    }),
    // A rotation dropped the kept origins, and is still running: the previous key beside the new.
    dropped: nodeRow({
        id: fileId,
        kind: 'file',
        heightBound: 0,
        prevKeyEnvelope: bytes(72, 9),
        prevKeyEpoch: 2,
        prevParentKeyEpoch: 1,
        metadataDroppedSignerId: owner,
        metadataOriginDroppedBy: editor,
        trashedAt: at(11),
        currentVersionId: versionId,
        currentVersion: versionRow({ droppedSignerId: owner, originDroppedBy: editor }),
    }),
};
const nodes = Object.fromEntries(
    Object.entries(rows).map(([name, row]) => [name, nodeView(row)]),
) as Record<keyof typeof rows, drive.NodeView>;

/* What a link visitor is served (visitorView in the Drive package): no signer, no sequence. */
function visitor(node: drive.NodeView): drive.VisitorNodeView {
    const {
        metadataSigner: _a,
        metadataSignature: _b,
        metadataRekey: _c,
        metadataOriginDropped: _d,
        currentVersion,
        ...rest
    } = node;
    if (!currentVersion) return { ...rest, changeSeq: null, currentVersion: null };
    const { signer: _e, signature: _f, rekey: _g, originDropped: _h, ...version } = currentVersion;
    return { ...rest, changeSeq: null, currentVersion: version };
}

const identityV2 = {
    keyVersion: 3,
    identityVersion: 2 as const,
    encryptionPublicKey: b64(32),
    signingPublicKey: b64(32, 8),
    mlDsaPublicKey: b64(1952),
    kemPublicKey: b64(1184),
    keysSignature: b64(3373),
};
// Not yet upgraded: no ML-DSA key, no statement, and the oldest have no KEM key either.
const identityV1 = {
    keyVersion: 1,
    identityVersion: 1 as const,
    encryptionPublicKey: b64(32, 9),
    signingPublicKey: b64(32, 10),
    mlDsaPublicKey: null,
    kemPublicKey: null,
    keysSignature: null,
};
const selfGrant = {
    version: 1 as const,
    workspaceId: ws,
    keyVersion: 2,
    workspaceKeyVersion: 1,
    wrappingSalt: b64(32),
    wrappingNonce: b64(24),
    encryptedKey: b64(48),
};
const link = {
    id: linkId,
    keyEpoch: 3,
    secretEnvelope: b64(136),
    hasPassword: true,
    kdfVersion: 2,
    expiresAt: iso(20),
    useCount: 4,
    lastUsedAt: iso(12),
    createdAt: iso(9),
};
// Made before the owner's sealed copy of the secret, under the first derivation, never opened.
const legacyLink = {
    ...link,
    secretEnvelope: null,
    hasPassword: false,
    kdfVersion: 1,
    expiresAt: null,
    useCount: 0,
    lastUsedAt: null,
};
const share = {
    id: shareId,
    role: 'editor' as const,
    keyEpoch: 3,
    createdAt: iso(9),
    suite: 4 as const,
    grantee: { id: editor, name: 'Grace', email: 'grace@example.com' },
};

/* A rotation's batch node as the repository returns it: versions, shares and links included. */
const workRow: rotationsRepository.RotationWorkNode = {
    ...rows.rekeyed,
    depth: 1,
    versions: [
        {
            id: versionId,
            objectId,
            contentKeyEnvelope: bytes(84),
            contentSuite: 3,
            plaintextSize: null,
            signer: { id: editor },
            signature: null,
            originEnvelope: bytes(84, 6),
            originKeyEnvelope: bytes(72, 6),
            originSignerId: owner,
            originSignature: bytes(64, 6),
            rekeySignature: bytes(64, 8),
        },
        {
            id: shareId,
            objectId: linkId,
            contentKeyEnvelope: bytes(72),
            contentSuite: 1,
            plaintextSize: 5n,
            signer: null,
            signature: null,
            originEnvelope: null,
            originKeyEnvelope: null,
            originSignerId: null,
            originSignature: null,
            rekeySignature: null,
        },
    ],
    shares: [
        {
            id: shareId,
            granteeUserId: editor,
            granteePublicKey: bytes(32),
            granteeSigningPublicKey: bytes(32, 8),
            granteeMlDsaPublicKey: bytes(1952),
            granteeKemPublicKey: bytes(1184),
            granteeKeysSignature: bytes(3373),
            granteeKeyVersion: 3,
            granteeIdentityVersion: 2,
        },
        {
            id: linkId,
            granteeUserId: owner,
            granteePublicKey: bytes(32, 9),
            granteeSigningPublicKey: bytes(32, 10),
            granteeMlDsaPublicKey: null,
            granteeKemPublicKey: null,
            granteeKeysSignature: null,
            granteeKeyVersion: 1,
            granteeIdentityVersion: 1,
        },
    ],
    links: [
        { id: linkId, hasPassword: true, secretEnvelope: bytes(104) },
        { id: shareId, hasPassword: false, secretEnvelope: null },
    ],
};

type SpacesReply = {
    spaces: (ReturnType<typeof personalSpaceOf> | Reply<typeof groups.spaces>[number])[];
};

const personalSpace: ReturnType<typeof personalSpaceOf> = {
    space: { kind: 'personal' },
    areas: [
        {
            workspaceId: ws,
            workspaceKeyVersion: 1,
            changeSeq: 41,
            root: nodes.root,
            rotation: null,
            selfGrant,
        },
    ],
};

/*
 * Per route: the replies the package can give, the objects a new column would surface in (a
 * stray field is planted there and at the top), and a field the reply cannot go out without.
 */
type Case = {
    schema: AnySchema;
    samples: Record<string, unknown>;
    stray: (value: any) => Record<string, unknown>[];
    /* Which sample to cut, and the cut. */
    required: [string, (value: any) => void];
};
const cases: Record<string, Case> = {
    'GET /drive/workspace': {
        schema: workspaceResponse,
        samples: {
            open: {
                workspaceId: ws,
                changeSeq: 41,
                grant: selfGrant,
                root: nodes.root,
                rotation: { id: shareId, nodeId: folderId, targetEpoch: 4 },
            } satisfies Reply<typeof drive.getWorkspace>,
            'before the root': {
                workspaceId: ws,
                changeSeq: 0,
                grant: selfGrant,
                root: null,
                rotation: null,
            } satisfies Reply<typeof drive.getWorkspace>,
            'no grant': {
                workspaceId: ws,
                changeSeq: 0,
                grant: null,
                root: null,
                rotation: null,
            } satisfies Reply<typeof drive.getWorkspace>,
        },
        stray: (v) => [v.grant, v.root, v.rotation].filter(Boolean),
        required: ['open', (v) => delete v.grant.encryptedKey],
    },
    'GET /drive/spaces': {
        schema: spacesResponse,
        samples: {
            'groups off': { spaces: [personalSpace] } satisfies SpacesReply,
            'a family': {
                spaces: [
                    personalSpace,
                    {
                        space: { kind: 'group', groupId: editor, name: 'The Lovelaces' },
                        areas: [
                            {
                                workspaceId: area,
                                idSeed: b64(16),
                                workspaceKeyVersion: 2,
                                changeSeq: 7,
                                root: { ...nodes.folder, workspaceId: area, parentId: null },
                                rotation: { id: shareId, nodeId: rootId, targetEpoch: 5 },
                                grant: {
                                    workspaceKeyVersion: 2,
                                    granteeKeyVersion: 3,
                                    granterUserId: owner,
                                    rosterVersion: 6,
                                    rosterDigest: b64(32),
                                    envelope: b64(1200),
                                },
                                selfGrant: null,
                            },
                            {
                                workspaceId: area2,
                                idSeed: b64(16, 2),
                                workspaceKeyVersion: 1,
                                changeSeq: 0,
                                root: null,
                                rotation: null,
                                grant: null,
                                selfGrant: { ...selfGrant, workspaceId: area2 },
                            },
                        ],
                    },
                ],
            } satisfies SpacesReply,
        },
        stray: (v) =>
            v.spaces
                .flatMap((entry: any) => [entry, entry.space, ...entry.areas])
                .concat(v.spaces[1]?.areas[0].grant ?? []),
        required: ['a family', (v) => delete v.spaces[1].areas[0].idSeed],
    },
    'GET /drive/shares': {
        schema: sharedWithMeResponse,
        samples: {
            shares: {
                shares: [
                    {
                        id: shareId,
                        workspaceId: ws,
                        role: 'viewer',
                        keyEpoch: 3,
                        shareEnvelope: b64(4565),
                        // A rotation in flight: the envelope it replaced, at its epoch.
                        prevShareEnvelope: b64(4565, 8),
                        prevKeyEpoch: 2,
                        createdAt: iso(9),
                        cursor: b64(44),
                        granter: {
                            id: owner,
                            name: 'Ada',
                            email: 'ada@example.com',
                            ...identityV2,
                        },
                        node: granteeView(nodes.file),
                    },
                    {
                        id: linkId,
                        workspaceId: area,
                        role: 'editor',
                        keyEpoch: 1,
                        shareEnvelope: b64(4565),
                        prevShareEnvelope: null,
                        prevKeyEpoch: null,
                        createdAt: iso(8),
                        cursor: b64(44, 2),
                        granter: {
                            id: editor,
                            name: 'Grace',
                            email: 'g@example.com',
                            ...identityV1,
                        },
                        node: granteeView(nodes.legacyFile),
                    },
                ],
            } satisfies Reply<typeof drive.listSharedWithMe>,
            none: { shares: [] } satisfies Reply<typeof drive.listSharedWithMe>,
        },
        stray: (v) => v.shares.flatMap((s: any) => [s, s.granter, s.node]),
        required: ['shares', (v) => delete v.shares[0].granter.signingPublicKey],
    },
    'GET /drive/shares/mine': {
        schema: sharedByMeResponse,
        samples: {
            both: {
                shares: [
                    { ...share, node: nodes.folder, granteeIdentity: identityV2 },
                    // Left in suite 1, for the owner to re-seal or revoke.
                    {
                        ...share,
                        role: 'viewer',
                        suite: 1,
                        node: nodes.legacyFile,
                        granteeIdentity: identityV1,
                    },
                ],
                links: [
                    { ...link, node: nodes.rekeyed },
                    { ...legacyLink, node: nodes.root },
                ],
            } satisfies Reply<typeof drive.listSharedByMe>,
            none: { shares: [], links: [] } satisfies Reply<typeof drive.listSharedByMe>,
        },
        stray: (v) => [...v.shares, ...v.links].flatMap((s: any) => [s, s.node, s.grantee ?? s]),
        required: ['both', (v) => delete v.links[0].useCount],
    },
    'GET /drive/nodes/:id/children': {
        schema: listingResponse,
        samples: {
            member: {
                folder: nodes.folder,
                ancestors: [nodes.root],
                children: [nodes.file, nodes.legacyFile, nodes.rekeyed, nodes.dropped],
                nextCursor: fileId,
            } satisfies Reply<typeof drive.listChildren>,
            grantee: {
                folder: granteeView(nodes.folder),
                ancestors: [],
                children: [granteeView(nodes.rekeyed)],
                nextCursor: null,
            } satisfies Reply<typeof drive.listChildren>,
        },
        stray: (v) =>
            [
                v.folder,
                ...v.children.flatMap((n: any) => [
                    n,
                    n.currentVersion,
                    n.metadataRekey?.origin,
                    n.currentVersion?.rekey,
                    n.metadataOriginDropped,
                ]),
            ].filter(Boolean),
        required: ['member', (v) => delete v.children[0].keyEnvelope],
    },
    'GET /drive/nodes/:id/versions': {
        schema: versionsResponse,
        samples: {
            versions: {
                versions: [
                    {
                        ...nodes.rekeyed.currentVersion!,
                        current: true,
                        supersededAt: null,
                        createdAt: iso(9),
                    },
                    {
                        ...nodes.legacyFile.currentVersion!,
                        id: shareId,
                        current: false,
                        supersededAt: iso(9),
                        createdAt: iso(7),
                    },
                ],
            } satisfies Reply<typeof drive.listVersions>,
        },
        stray: (v) => v.versions.flatMap((x: any) => [x, x.rekey].filter(Boolean)),
        required: ['versions', (v) => delete v.versions[0].contentNonce],
    },
    'GET /drive/nodes/:id/shares': {
        schema: nodeSharesResponse,
        samples: {
            shares: {
                shares: [share, { ...share, id: linkId, role: 'viewer', suite: 3 }],
            } satisfies Reply<typeof drive.listNodeShares>,
            none: { shares: [] } satisfies Reply<typeof drive.listNodeShares>,
        },
        stray: (v) => v.shares.flatMap((s: any) => [s, s.grantee]),
        required: ['shares', (v) => delete v.shares[1].grantee.email],
    },
    'GET /drive/nodes/:id/links': {
        schema: nodeLinksResponse,
        samples: {
            links: { links: [link, legacyLink] } satisfies Reply<typeof drive.listNodeLinks>,
        },
        stray: (v) => v.links,
        required: ['links', (v) => delete v.links[0].hasPassword],
    },
    'GET /drive/workspaces/:id/documents/:kind': {
        schema: documentResponse,
        samples: {
            document: {
                document: {
                    kind: 'tags',
                    version: 3,
                    envelope: b64(552),
                    updatedAt: iso(9),
                    envelopeSuite: 1,
                },
            } satisfies Reply<typeof drive.workspaceDocument>,
            none: { document: null } satisfies Reply<typeof drive.workspaceDocument>,
        },
        stray: (v) => [v.document].filter(Boolean),
        required: ['document', (v) => delete v.document.envelope],
    },
    'GET /drive/workspaces/:id/changes': {
        schema: changesResponse,
        samples: {
            changes: {
                changes: [
                    { kind: 'node', changeSeq: 40, node: nodes.rekeyed },
                    { kind: 'tombstone', changeSeq: 41, nodeId: fileId, parentId: folderId },
                    { kind: 'node', changeSeq: 42, node: nodes.legacyFile },
                ],
                resync: false,
                nextCursor: 42,
                hasMore: true,
            } satisfies Reply<typeof drive.changes>,
            'start again': {
                changes: [],
                resync: true,
                nextCursor: 3,
                hasMore: false,
            } satisfies Reply<typeof drive.changes>,
        },
        stray: (v) => v.changes.flatMap((c: any) => [c, c.node].filter(Boolean)),
        required: ['changes', (v) => delete v.resync],
    },
    'GET /drive/shares/:id/changes': {
        schema: shareChangesResponse,
        samples: {
            changes: {
                changes: [
                    { kind: 'entered', nodeId: folderId },
                    { kind: 'node', node: granteeView(nodes.file) },
                    { kind: 'tombstone', nodeId: fileId, parentId: folderId },
                    { kind: 'left', nodeId: folderId },
                ],
                cursor: b64(44),
                hasMore: false,
                resync: false,
            } satisfies Reply<typeof drive.shareChanges>,
        },
        stray: (v) => v.changes.flatMap((c: any) => [c, c.node].filter(Boolean)),
        required: ['changes', (v) => delete v.cursor],
    },
    'GET /drive/nodes/:id/rotation/work': {
        schema: rotationWorkResponse,
        samples: {
            batch: {
                rotation: { nodeId: folderId, targetEpoch: 4 },
                nodes: [
                    rotationWorkView(workRow),
                    rotationWorkView({
                        ...rows.folder,
                        depth: 0,
                        versions: [],
                        shares: [],
                        links: [],
                    }),
                ],
                nextCursor: `1:${fileId}`,
                done: false,
            } satisfies Reply<typeof drive.rotationWork>,
            done: {
                rotation: { nodeId: folderId, targetEpoch: 4 },
                nodes: [],
                nextCursor: null,
                done: true,
            } satisfies Reply<typeof drive.rotationWork>,
        },
        stray: (v) =>
            [v.rotation, ...v.nodes].concat(
                v.nodes.flatMap((n: any) => [...n.versions, ...n.shares, ...n.links]),
                v.nodes.flatMap((n: any) => n.shares.map((s: any) => s.grantee)),
            ),
        required: ['batch', (v) => delete v.nodes[0].shares[0].grantee.encryptionPublicKey],
    },
    'GET /drive/links/open': {
        schema: openLinkResponse,
        samples: {
            file: {
                link: {
                    id: linkId,
                    workspaceId: ws,
                    keyEpoch: 3,
                    hasPassword: true,
                    kdfVersion: 2,
                    linkSalt: b64(16),
                    linkEnvelope: b64(72),
                    expiresAt: iso(20),
                },
                node: visitor(nodes.rekeyed),
            } satisfies Reply<typeof drive.openLink>,
            'old folder link': {
                link: {
                    id: linkId,
                    workspaceId: ws,
                    keyEpoch: 1,
                    hasPassword: false,
                    kdfVersion: 1,
                    linkSalt: b64(16),
                    linkEnvelope: b64(72),
                    expiresAt: null,
                },
                node: visitor(nodes.folder),
            } satisfies Reply<typeof drive.openLink>,
        },
        stray: (v) => [v.link, v.node, v.node.currentVersion].filter(Boolean),
        required: ['file', (v) => delete v.link.linkSalt],
    },
    'GET /drive/links/nodes/:nodeId/children': {
        schema: linkListingResponse,
        samples: {
            listing: {
                folder: visitor(nodes.folder),
                ancestors: [],
                children: [visitor(nodes.file), visitor(nodes.legacyFile)],
                nextCursor: null,
            } satisfies Reply<typeof drive.linkChildren>,
        },
        stray: (v) => [v.folder, ...v.children, v.children[0].currentVersion],
        required: ['listing', (v) => delete v.folder.metadataEnvelope],
    },
};

describe.each(Object.entries(cases))('%s', (_route, { schema, samples, stray, required }) => {
    test.each(Object.entries(samples))('goes out unchanged: %s', async (_name, sample) => {
        expect(await serve(schema, sample)).toEqual({ status: 200, body: sample });
    });

    test.each(Object.entries(samples))(
        'drops a field the schema does not name: %s',
        async (_name, sample) => {
            const planted = clone(sample) as Record<string, unknown>;
            planted.leaked = 'top';
            for (const object of stray(planted)) object.signingPrivateKey = 'nested';
            const { status, body } = await serve(schema, planted);
            expect(status).toBe(200);
            expect(body).toEqual(sample);
            expect(JSON.stringify(body)).not.toMatch(/leaked|signingPrivateKey/);
        },
    );

    test('fails rather than send a reply missing a required field', async () => {
        const [name, cut] = required;
        const short = clone(samples[name]);
        cut(short);
        expect((await serve(schema, short)).status).toBe(500);
    });
});

/*
 * A visitor has no account and no pins: a signer would only tell an anonymous holder of the URL
 * who wrote the files. Were the visitor view to pass a member's node through, the reply would
 * still name no writer and carry no signature. (The change sequence is typed number or null on
 * the view, so the schema cannot refuse it; the view sets it null.)
 */
test("strips the writer from what a link's visitor is sent", async () => {
    const opened = clone(cases['GET /drive/links/open']!.samples.file) as Reply<
        typeof drive.openLink
    >;
    const leaky = { ...opened, node: nodes.rekeyed };
    const { status, body } = await serve(openLinkResponse, leaky);
    expect(status).toBe(200);
    expect(body).toEqual({ ...opened, node: { ...visitor(nodes.rekeyed), changeSeq: 41 } });
    expect(JSON.stringify(body)).not.toContain(owner);
    expect(JSON.stringify(body)).not.toContain(editor);
});

/* A field typed as one of a set: a value outside it fails rather than going out. */
test('refuses a role, a node kind or a suite outside its set', async () => {
    const shares = clone(cases['GET /drive/nodes/:id/shares']!.samples.shares) as any;
    shares.shares[0].role = 'owner';
    expect((await serve(nodeSharesResponse, shares)).status).toBe(500);
    const listing = clone(cases['GET /drive/nodes/:id/children']!.samples.member) as any;
    listing.children[0].kind = 'symlink';
    expect((await serve(listingResponse, listing)).status).toBe(500);
    const mine = clone(cases['GET /drive/shares/mine']!.samples.both) as any;
    mine.shares[0].suite = 5;
    expect((await serve(sharedByMeResponse, mine)).status).toBe(500);
});

/* The schemas guard nothing unless the routes carry them: each read names its own. */
test('each Drive read carries its reply schema', async () => {
    const app = await loadApi();
    const routes = app.routes as unknown as (ApiRoute & { hooks: { response?: unknown } })[];
    const expected: Record<string, AnySchema> = {
        '/api/drive/workspace': workspaceResponse,
        '/api/drive/spaces': spacesResponse,
        '/api/drive/shares': sharedWithMeResponse,
        '/api/drive/shares/mine': sharedByMeResponse,
        '/api/drive/nodes/:id/children': listingResponse,
        '/api/drive/nodes/:id/versions': versionsResponse,
        '/api/drive/nodes/:id/shares': nodeSharesResponse,
        '/api/drive/nodes/:id/links': nodeLinksResponse,
        '/api/drive/workspaces/:id/documents/:kind': documentResponse,
        '/api/drive/workspaces/:id/changes': changesResponse,
        '/api/drive/shares/:id/changes': shareChangesResponse,
        '/api/drive/nodes/:id/rotation/work': rotationWorkResponse,
        '/api/drive/links/open': openLinkResponse,
        '/api/drive/links/nodes/:nodeId/children': linkListingResponse,
    };
    for (const [path, schema] of Object.entries(expected)) {
        const route = routes.find((r) => r.method === 'GET' && r.path === path);
        expect(route, path).toBeDefined();
        expect((route!.hooks.response as Record<number, unknown>)[200], path).toEqual(schema);
    }
});
