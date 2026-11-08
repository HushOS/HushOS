// @vitest-environment node
import { Elysia, type AnySchema } from 'elysia';
import { describe, expect, test, vi } from 'vitest';
import type { NodeRow, VersionRow, rotationsRepository } from '@hushos/db';
import type * as drive from '@hushos/drive/server';
import type * as groups from '@hushos/groups/server';
import {
    abortedUploadResponse,
    beginUploadResponse,
    capabilitiesResponse,
    changesResponse,
    completedUploadResponse,
    discardedResponse,
    documentResponse,
    downloadUrlResponse,
    drainResponse,
    epochsResponse,
    fileReportResponse,
    foldersResponse,
    linkDownloadUrlResponse,
    linkListingResponse,
    linkResponse,
    listingResponse,
    nodeLinksResponse,
    nodeResponse,
    nodeSharesResponse,
    objectUrlsResponse,
    openLinkResponse,
    partUrlsResponse,
    purgeBatchResponse,
    purgedResponse,
    putDocumentResponse,
    reportOperatorsResponse,
    resealedResponse,
    restoreBatchResponse,
    revokedResponse,
    rootResponse,
    rotateNodesResponse,
    rotationWorkResponse,
    shareChangesResponse,
    shareResponse,
    sharedByMeResponse,
    sharedWithMeResponse,
    spacesResponse,
    startRotationResponse,
    storageResponse,
    trashBatchResponse,
    trashResponse,
    uploadStateResponse,
    versionsResponse,
    workspaceResponse,
} from '@/lib/api/drive-responses.server';
import { loadApi, type ApiRoute } from '@/test/api-app';
import type { personalSpace as personalSpaceOf } from '@/lib/api/drive-responses.server';

/*
 * The Drive routes' reply schemas, through a real Elysia route so normalisation runs as it does in
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
const uploadId = 'b063c2a1-15f3-41fc-8f5e-d0c4f234a3cc';
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
        { id: linkId, hasPassword: true, secretEnvelope: bytes(104), kdfVersion: 2 },
        // A link from before the current derivation: its version is sent so the client ends it.
        { id: shareId, hasPassword: false, secretEnvelope: null, kdfVersion: 1 },
    ],
};

/*
 * A route several package functions answer: a sample must be what every one of them returns, so
 * a field any of them gains fails typecheck. (A tuple, not an intersection: some are the same type.)
 */
type Every<T extends unknown[]> = T extends [infer Head, ...infer Rest]
    ? Head & Every<Rest>
    : unknown;
type NodeReply = Every<
    [
        Reply<typeof drive.renameNode>,
        Reply<typeof drive.moveNode>,
        Reply<typeof drive.trashNode>,
        Reply<typeof drive.restoreNode>,
        Reply<typeof drive.copyNode>,
        Reply<typeof drive.restoreVersion>,
    ]
>;
type ObjectUrlsReply = Every<
    [
        Reply<typeof drive.thumbnailUrls>,
        Reply<typeof drive.downloadUrls>,
        Reply<typeof drive.linkThumbnailUrls>,
        Reply<typeof drive.linkDownloadUrls>,
    ]
>;
type CompletedReply = Every<[Reply<typeof drive.completeUpload>, Reply<typeof drive.attachUpload>]>;
type LinkReply = Every<[Reply<typeof drive.createLink>, Reply<typeof drive.updateLink>]>;
type RevokedReply = Every<[Reply<typeof drive.revokeShare>, Reply<typeof drive.revokeLink>]>;
type DrainReply = Every<
    [Reply<typeof drive.emptyTrash>, Reply<typeof drive.discardSupersededVersions>]
>;

/* An upload as uploadView makes it: open with its object, and aborted with the object retired. */
const openUpload = {
    id: uploadId,
    nodeId: fileId,
    versionId,
    objectId,
    status: 'open' as const,
    chunkCount: 2,
    ciphertextSize: '4194418',
    expiresAt: iso(33),
};
const abortedUpload = {
    ...openUpload,
    objectId: null,
    status: 'aborted' as const,
    chunkCount: 0,
    ciphertextSize: '0',
};
const partUrls = {
    parts: [
        { partNumber: 1, length: 4_194_320, url: 'https://store.example/o?partNumber=1&sig=a' },
        { partNumber: 2, length: 98, url: 'https://store.example/o?partNumber=2&sig=b' },
    ],
    urlExpiresAt: iso(10),
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
    'GET /drive/capabilities': {
        schema: capabilitiesResponse,
        samples: {
            capabilities: {
                protocolVersion: 3,
                contentSuites: [3],
                envelopeSuites: [1],
                chunkSize: 4_194_304,
                maxFileBytes: '10737418240',
                maxDepth: 64,
                nameMaxCodePoints: 255,
                tombstoneDays: 90,
                trashRetentionDays: 30,
                groups: true,
            } satisfies Reply<typeof drive.capabilities>,
            // The type's shape from before families: no `groups`, which a client reads as off.
            'before families': {
                protocolVersion: 3,
                contentSuites: [3],
                envelopeSuites: [1],
                chunkSize: 4_194_304,
                maxFileBytes: '10737418240',
                maxDepth: 64,
                nameMaxCodePoints: 255,
                tombstoneDays: 90,
                trashRetentionDays: 30,
            } satisfies Reply<typeof drive.capabilities>,
        },
        stray: () => [],
        required: ['capabilities', (v) => delete v.maxFileBytes],
    },
    'POST /drive/workspaces/:id/epochs': {
        schema: epochsResponse,
        samples: { range: { from: 5, to: 68 } satisfies Reply<typeof drive.allocateEpochs> },
        stray: () => [],
        required: ['range', (v) => delete v.to],
    },
    'POST /drive/workspaces/:id/root': {
        schema: rootResponse,
        samples: {
            created: { created: true, root: nodes.root } satisfies Reply<typeof drive.createRoot>,
            'a retry': { created: false, root: nodes.root } satisfies Reply<
                typeof drive.createRoot
            >,
        },
        stray: (v) => [v.root],
        required: ['created', (v) => delete v.created],
    },
    'POST /drive/folders': {
        schema: foldersResponse,
        samples: {
            folders: {
                nodes: [nodes.folder, { ...nodes.folder, id: fileId, parentId: folderId }],
                changeSeq: 43,
            } satisfies Reply<typeof drive.createFolders>,
            // Made through a share: grantee nodes, and no sequence of the owner's.
            'through a share': {
                nodes: [granteeView(nodes.folder)],
                changeSeq: null,
            } satisfies Reply<typeof drive.createFolders>,
        },
        stray: (v) => v.nodes,
        required: ['folders', (v) => delete v.changeSeq],
    },
    'POST /drive/nodes/:id/{metadata,parent,trash,restore,copy}, /drive/versions/:id/restore': {
        schema: nodeResponse,
        samples: {
            member: { node: nodes.rekeyed } satisfies NodeReply,
            'an editor through a share': { node: granteeView(nodes.rekeyed) } satisfies NodeReply,
            legacy: { node: nodes.legacyFile } satisfies NodeReply,
            trashed: { node: nodes.dropped } satisfies NodeReply,
        },
        stray: (v) =>
            [v.node, v.node.currentVersion, v.node.metadataRekey, v.node.currentVersion?.rekey]
                .concat(v.node.metadataOriginDropped ?? [])
                .filter(Boolean),
        required: ['member', (v) => delete v.node.metadataSignature],
    },
    'POST /drive/workspaces/:id/trash-batch': {
        schema: trashBatchResponse,
        samples: {
            results: {
                results: [
                    { id: folderId, status: 'trashed', trashedAt: iso(11), changeSeq: 44 },
                    { id: fileId, status: 'covered', by: folderId },
                    {
                        id: rootId,
                        status: 'refused',
                        reason: 'root',
                        message: 'The top folder cannot be moved to the trash.',
                    },
                    {
                        id: versionId,
                        status: 'refused',
                        reason: 'forbidden',
                        message: 'You do not have permission to do that here.',
                    },
                ],
            } satisfies Reply<typeof drive.trashNodes>,
            // An editor through a share: told what moved, never the owner's change count.
            'an editor through a share': {
                results: [{ id: folderId, status: 'trashed', trashedAt: iso(11), changeSeq: null }],
            } satisfies Reply<typeof drive.trashNodes>,
        },
        stray: (v) => v.results,
        required: ['results', (v) => delete v.results[0].trashedAt],
    },
    'POST /drive/workspaces/:id/restore-batch': {
        schema: restoreBatchResponse,
        samples: {
            results: {
                results: [
                    { id: folderId, status: 'restored', changeSeq: 45 },
                    {
                        id: fileId,
                        status: 'refused',
                        reason: 'parent-trashed',
                        message: 'The folder this was in is still in the trash.',
                    },
                    {
                        id: rootId,
                        status: 'refused',
                        reason: 'removed',
                        message: 'This item was removed by the operator of this instance.',
                    },
                ],
            } satisfies Reply<typeof drive.restoreNodes>,
        },
        stray: (v) => v.results,
        required: ['results', (v) => delete v.results[1].reason],
    },
    'POST /drive/workspaces/:id/purge-batch': {
        schema: purgeBatchResponse,
        samples: {
            results: {
                results: [
                    { id: folderId, status: 'purged', changeSeq: 46 },
                    { id: fileId, status: 'covered', by: folderId },
                    {
                        id: versionId,
                        status: 'refused',
                        reason: 'busy',
                        message: 'There wasn’t time to delete this one yet. Try again.',
                    },
                    {
                        id: rootId,
                        status: 'refused',
                        reason: 'not-trashed',
                        message: 'Move this item to the trash first.',
                    },
                ],
            } satisfies Reply<typeof drive.purgeNodes>,
        },
        stray: (v) => v.results,
        required: ['results', (v) => delete v.results[1].by],
    },
    'POST /drive/uploads': {
        schema: beginUploadResponse,
        samples: {
            begun: { upload: openUpload, ...partUrls } satisfies Reply<typeof drive.beginUpload>,
        },
        stray: (v) => [v.upload, ...v.parts],
        required: ['begun', (v) => delete v.parts[1].length],
    },
    'GET /drive/uploads/:id': {
        schema: uploadStateResponse,
        samples: {
            open: {
                upload: openUpload,
                parts: [
                    { partNumber: 1, etag: '"9b2cf535f27731c974343645a3985328"', size: 4_194_320 },
                ],
            } satisfies Reply<typeof drive.getUploadState>,
            aborted: { upload: abortedUpload, parts: [] } satisfies Reply<
                typeof drive.getUploadState
            >,
        },
        stray: (v) => [v.upload, ...v.parts],
        required: ['open', (v) => delete v.parts[0].etag],
    },
    'GET /drive/uploads/:id/parts': {
        schema: partUrlsResponse,
        samples: { parts: partUrls satisfies Reply<typeof drive.uploadPartUrls> },
        stray: (v) => v.parts,
        required: ['parts', (v) => delete v.urlExpiresAt],
    },
    'POST /drive/uploads/:id/{complete,attach}': {
        schema: completedUploadResponse,
        samples: {
            published: { status: 'completed', node: nodes.file } satisfies CompletedReply,
            // A retry after the node it published was purged.
            gone: { status: 'completed', node: null } satisfies CompletedReply,
        },
        stray: (v) => [v.node, v.node?.currentVersion].filter(Boolean),
        required: ['published', (v) => delete v.status],
    },
    'POST /drive/uploads/:id/abort': {
        schema: abortedUploadResponse,
        samples: { aborted: { aborted: true } satisfies Reply<typeof drive.abortUpload> },
        stray: () => [],
        required: ['aborted', (v) => delete v.aborted],
    },
    'GET /drive/thumbnails, POST /drive/versions/urls and the link visitor’s two': {
        schema: objectUrlsResponse,
        samples: {
            urls: {
                urls: [
                    { versionId, url: 'https://store.example/a?sig=1' },
                    { versionId: shareId, url: 'https://store.example/b?sig=2' },
                ],
                urlExpiresAt: iso(10),
            } satisfies ObjectUrlsReply,
            // A link that no longer resolves, or nothing readable among the ids.
            none: { urls: [], urlExpiresAt: iso(9) } satisfies ObjectUrlsReply,
        },
        stray: (v) => v.urls,
        required: ['urls', (v) => delete v.urls[1].versionId],
    },
    'GET /drive/versions/:id/url': {
        schema: downloadUrlResponse,
        samples: {
            member: {
                url: 'https://store.example/a?sig=1',
                urlExpiresAt: iso(10),
                node: nodes.rekeyed,
                version: nodes.rekeyed.currentVersion!,
            } satisfies Reply<typeof drive.downloadUrl>,
            grantee: {
                url: 'https://store.example/a?sig=2',
                urlExpiresAt: iso(9),
                node: granteeView(nodes.legacyFile),
                version: nodes.legacyFile.currentVersion!,
            } satisfies Reply<typeof drive.downloadUrl>,
        },
        stray: (v) => [v.node, v.version, v.version.rekey].filter(Boolean),
        required: ['member', (v) => delete v.version.chunkSize],
    },
    'GET /drive/links/versions/:versionId/url': {
        schema: linkDownloadUrlResponse,
        samples: {
            visitor: {
                url: 'https://store.example/a?sig=3',
                urlExpiresAt: iso(9),
                node: visitor(nodes.file),
                version: visitor(nodes.file).currentVersion!,
            } satisfies Reply<typeof drive.linkDownloadUrl>,
        },
        stray: (v) => [v.node, v.node.currentVersion, v.version],
        required: ['visitor', (v) => delete v.version.contentKeyEnvelope],
    },
    'DELETE /drive/nodes/:id': {
        schema: purgedResponse,
        samples: { purged: { purged: true } satisfies Reply<typeof drive.purgeNode> },
        stray: () => [],
        required: ['purged', (v) => delete v.purged],
    },
    'DELETE /drive/versions/:id': {
        schema: discardedResponse,
        samples: { discarded: { discarded: true } satisfies Reply<typeof drive.discardVersion> },
        stray: () => [],
        required: ['discarded', (v) => delete v.discarded],
    },
    'POST /drive/nodes/:id/shares': {
        schema: shareResponse,
        samples: { share: { share } satisfies Reply<typeof drive.shareNode> },
        stray: (v) => [v.share, v.share.grantee],
        required: ['share', (v) => delete v.share.grantee.name],
    },
    'PUT /drive/shares/:id/envelope': {
        schema: resealedResponse,
        samples: { resealed: { resealed: true } satisfies Reply<typeof drive.resealShare> },
        stray: () => [],
        required: ['resealed', (v) => delete v.resealed],
    },
    'DELETE /drive/shares/:id and /drive/links/:id': {
        schema: revokedResponse,
        samples: { revoked: { revoked: true } satisfies RevokedReply },
        stray: () => [],
        required: ['revoked', (v) => delete v.revoked],
    },
    'POST /drive/nodes/:id/links and PATCH /drive/links/:id': {
        schema: linkResponse,
        samples: {
            link: { link } satisfies LinkReply,
            legacy: { link: legacyLink } satisfies LinkReply,
        },
        stray: (v) => [v.link],
        required: ['link', (v) => delete v.link.kdfVersion],
    },
    'PUT /drive/workspaces/:id/documents/:kind': {
        schema: putDocumentResponse,
        samples: {
            document: {
                document: {
                    kind: 'tags',
                    version: 4,
                    envelope: b64(552),
                    updatedAt: iso(10),
                    envelopeSuite: 1,
                },
            } satisfies Reply<typeof drive.putWorkspaceDocument>,
        },
        stray: (v) => [v.document],
        required: ['document', (v) => delete v.document.updatedAt],
    },
    'POST /drive/nodes/:id/rotation': {
        schema: startRotationResponse,
        samples: {
            rotation: {
                rotation: { id: shareId, nodeId: folderId, targetEpoch: 4 },
            } satisfies Reply<typeof drive.startRotation>,
        },
        stray: (v) => [v.rotation],
        required: ['rotation', (v) => delete v.rotation.targetEpoch],
    },
    'POST /drive/nodes/:id/rotation/nodes': {
        schema: rotateNodesResponse,
        samples: {
            results: {
                results: [
                    { id: folderId, status: 'ok' },
                    { id: fileId, status: 'already' },
                    { id: rootId, status: 'parent-not-ready' },
                    { id: versionId, status: 'stale' },
                    { id: shareId, status: 'not-found' },
                    { id: linkId, status: 'forbidden' },
                ],
            } satisfies Reply<typeof drive.rotateNodes>,
        },
        stray: (v) => v.results,
        required: ['results', (v) => delete v.results[0].status],
    },
    'GET /drive/workspaces/:id/storage': {
        schema: storageResponse,
        samples: {
            storage: {
                trashBytes: '9007199254740993',
                trashItems: 12,
                supersededBytes: '0',
                supersededVersions: 0,
            } satisfies Reply<typeof drive.storageBreakdown>,
        },
        stray: () => [],
        required: ['storage', (v) => delete v.trashBytes],
    },
    'POST /drive/workspaces/:id/{trash/empty,versions/discard-superseded}': {
        schema: drainResponse,
        samples: {
            more: { purged: 100, remaining: 101 } satisfies DrainReply,
            done: { purged: 3, remaining: 0 } satisfies DrainReply,
        },
        stray: () => [],
        required: ['more', (v) => delete v.remaining],
    },
    'GET /drive/workspaces/:id/trash': {
        schema: trashResponse,
        samples: {
            trash: {
                items: [
                    { node: nodes.dropped, ancestors: [nodes.root], parentTrashed: false },
                    {
                        node: { ...nodes.file, trashedAt: iso(11) },
                        ancestors: [nodes.root, nodes.dropped],
                        parentTrashed: true,
                    },
                ],
                nextCursor: `1762592400000000.${fileId}`,
            } satisfies Reply<typeof drive.listTrash>,
            empty: { items: [], nextCursor: null } satisfies Reply<typeof drive.listTrash>,
        },
        stray: (v) => v.items.flatMap((i: any) => [i, i.node, ...i.ancestors]),
        required: ['trash', (v) => delete v.items[0].parentTrashed],
    },
    'GET /drive/reports/operators': {
        schema: reportOperatorsResponse,
        samples: {
            operators: {
                operators: [
                    { ...identityV2, userId: owner },
                    { ...identityV1, userId: editor },
                ],
            } satisfies Reply<typeof drive.reportOperators>,
            // No operator yet: this instance takes no reports.
            none: { operators: [] } satisfies Reply<typeof drive.reportOperators>,
        },
        stray: (v) => v.operators,
        required: ['operators', (v) => delete v.operators[0].userId],
    },
    'POST /drive/reports': {
        schema: fileReportResponse,
        samples: {
            filed: { report: { id: shareId }, duplicate: false } satisfies Reply<
                typeof drive.fileReport
            >,
            duplicate: { report: { id: shareId }, duplicate: true } satisfies Reply<
                typeof drive.fileReport
            >,
        },
        stray: (v) => [v.report],
        required: ['filed', (v) => delete v.report.id],
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

/* The same for a file a visitor downloads: its node and version name no writer. */
test("strips the writer from a link visitor's download", async () => {
    const download = clone(
        cases['GET /drive/links/versions/:versionId/url']!.samples.visitor,
    ) as Reply<typeof drive.linkDownloadUrl>;
    const leaky = {
        ...download,
        node: nodes.rekeyed,
        version: nodes.rekeyed.currentVersion!,
    };
    const { status, body } = await serve(linkDownloadUrlResponse, leaky);
    expect(status).toBe(200);
    expect(body).toEqual({
        ...download,
        node: { ...visitor(nodes.rekeyed), changeSeq: 41 },
        version: visitor(nodes.rekeyed).currentVersion,
    });
    expect(JSON.stringify(body)).not.toContain(owner);
    expect(JSON.stringify(body)).not.toContain(editor);
});

/*
 * A batch result is matched by its status alone: a refusal that claims a reason of another
 * batch, or a status no batch has, fails rather than going out as something a client misreads.
 */
test('refuses a batch result outside its own set', async () => {
    const trash = clone(cases['POST /drive/workspaces/:id/trash-batch']!.samples.results) as any;
    trash.results[2].reason = 'busy';
    expect((await serve(trashBatchResponse, trash)).status).toBe(500);
    const restore = clone(
        cases['POST /drive/workspaces/:id/restore-batch']!.samples.results,
    ) as any;
    restore.results[0].status = 'covered';
    restore.results[0].by = folderId;
    expect((await serve(restoreBatchResponse, restore)).status).toBe(500);
    const purge = clone(cases['POST /drive/workspaces/:id/purge-batch']!.samples.results) as any;
    purge.results[0].status = 'trashed';
    expect((await serve(purgeBatchResponse, purge)).status).toBe(500);
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

/*
 * The schemas guard nothing unless the routes carry them: each Drive route names its own, but
 * the retired link paths, which only ever answer 410.
 */
const expectedSchemas: Record<string, AnySchema> = {
    'GET /api/drive/workspace': workspaceResponse,
    'GET /api/drive/spaces': spacesResponse,
    'GET /api/drive/shares': sharedWithMeResponse,
    'GET /api/drive/shares/mine': sharedByMeResponse,
    'GET /api/drive/nodes/:id/children': listingResponse,
    'GET /api/drive/nodes/:id/versions': versionsResponse,
    'GET /api/drive/nodes/:id/shares': nodeSharesResponse,
    'GET /api/drive/nodes/:id/links': nodeLinksResponse,
    'GET /api/drive/workspaces/:id/documents/:kind': documentResponse,
    'GET /api/drive/workspaces/:id/changes': changesResponse,
    'GET /api/drive/shares/:id/changes': shareChangesResponse,
    'GET /api/drive/nodes/:id/rotation/work': rotationWorkResponse,
    'GET /api/drive/links/open': openLinkResponse,
    'GET /api/drive/links/nodes/:nodeId/children': linkListingResponse,
    'GET /api/drive/capabilities': capabilitiesResponse,
    'GET /api/drive/links/versions/:versionId/url': linkDownloadUrlResponse,
    'POST /api/drive/links/versions/urls': objectUrlsResponse,
    'GET /api/drive/links/thumbnails': objectUrlsResponse,
    'GET /api/drive/reports/operators': reportOperatorsResponse,
    'POST /api/drive/reports': fileReportResponse,
    'POST /api/drive/workspaces/:id/epochs': epochsResponse,
    'POST /api/drive/workspaces/:id/root': rootResponse,
    'POST /api/drive/folders': foldersResponse,
    'POST /api/drive/nodes/:id/metadata': nodeResponse,
    'POST /api/drive/nodes/:id/parent': nodeResponse,
    'POST /api/drive/nodes/:id/trash': nodeResponse,
    'POST /api/drive/nodes/:id/restore': nodeResponse,
    'POST /api/drive/workspaces/:id/trash-batch': trashBatchResponse,
    'POST /api/drive/workspaces/:id/restore-batch': restoreBatchResponse,
    'POST /api/drive/workspaces/:id/purge-batch': purgeBatchResponse,
    'POST /api/drive/uploads': beginUploadResponse,
    'GET /api/drive/uploads/:id': uploadStateResponse,
    'GET /api/drive/uploads/:id/parts': partUrlsResponse,
    'POST /api/drive/uploads/:id/complete': completedUploadResponse,
    'POST /api/drive/uploads/:id/attach': completedUploadResponse,
    'POST /api/drive/uploads/:id/abort': abortedUploadResponse,
    'GET /api/drive/thumbnails': objectUrlsResponse,
    'DELETE /api/drive/nodes/:id': purgedResponse,
    'POST /api/drive/nodes/:id/copy': nodeResponse,
    'POST /api/drive/versions/:id/restore': nodeResponse,
    'DELETE /api/drive/versions/:id': discardedResponse,
    'POST /api/drive/nodes/:id/shares': shareResponse,
    'PUT /api/drive/shares/:id/envelope': resealedResponse,
    'DELETE /api/drive/shares/:id': revokedResponse,
    'POST /api/drive/nodes/:id/links': linkResponse,
    'PATCH /api/drive/links/:id': linkResponse,
    'DELETE /api/drive/links/:id': revokedResponse,
    'PUT /api/drive/workspaces/:id/documents/:kind': putDocumentResponse,
    'POST /api/drive/nodes/:id/rotation': startRotationResponse,
    'POST /api/drive/nodes/:id/rotation/nodes': rotateNodesResponse,
    'GET /api/drive/workspaces/:id/storage': storageResponse,
    'POST /api/drive/workspaces/:id/versions/discard-superseded': drainResponse,
    'POST /api/drive/workspaces/:id/trash/empty': drainResponse,
    'POST /api/drive/versions/urls': objectUrlsResponse,
    'GET /api/drive/versions/:id/url': downloadUrlResponse,
    'GET /api/drive/workspaces/:id/trash': trashResponse,
};
const retired = new Set([
    'GET /api/drive/links/:id/open',
    'GET /api/drive/links/:id/nodes/:nodeId/children',
    'GET /api/drive/links/:id/versions/:versionId/url',
    'POST /api/drive/links/:id/versions/urls',
    'GET /api/drive/links/:id/thumbnails',
]);

test('each Drive route carries its reply schema', async () => {
    const app = await loadApi();
    const routes = (
        app.routes as unknown as (ApiRoute & { hooks: { response?: unknown } })[]
    ).filter((r) => r.path.startsWith('/api/drive/'));
    for (const [key, schema] of Object.entries(expectedSchemas)) {
        const [method, path] = key.split(' ');
        const route = routes.find((r) => r.method === method && r.path === path);
        expect(route, key).toBeDefined();
        expect((route!.hooks.response as Record<number, unknown>)[200], key).toEqual(schema);
    }
    // A route added later without a schema, or one this list forgot, fails here.
    const unlisted = routes
        .map((r) => `${r.method} ${r.path}`)
        .filter((key) => !(key in expectedSchemas) && !retired.has(key));
    expect(unlisted).toEqual([]);
});
