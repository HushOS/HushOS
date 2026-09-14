import { createHash } from 'node:crypto';
import {
    authRepository,
    driveRepository,
    reportsRepository,
    rotationsRepository,
    type NodeRow,
    type UploadRow,
    type VersionRow,
} from '@hushos/db';
import { partLength, validObjectSize } from '@hushos/crypto/drive';
import { objectKey, primaryStore } from './storage';
import { storageEnv } from '@hushos/env/storage';
import {
    ANCESTOR_WALK_CAP,
    CHUNK_SIZE,
    CHUNK_TAG_BYTES,
    CONTENT_SUITE,
    DOWNLOAD_URL_TTL_SECONDS,
    DRIVE_ENVELOPE_SUITE,
    DRIVE_PROTOCOL_VERSION,
    KEY_ENVELOPE_BYTES,
    LEGACY_CONTENT_SUITE,
    MAX_DEPTH,
    MAX_FOLDER_BATCH,
    MAX_PART_URLS_PER_REQUEST,
    THUMBNAIL_BATCH,
    THUMBNAIL_MAX_BYTES,
    VERSION_ENVELOPE_BYTES,
    METADATA_MAX_BYTES,
    NAME_MAX_CODE_POINTS,
    PART_URL_TTL_SECONDS,
    SHARE_URL_TTL_SECONDS,
    TOMBSTONE_DAYS,
    TRASH_RETENTION_DAYS,
    UPLOAD_TTL_HOURS,
    type Capabilities,
    type DriveErrorCode,
} from './protocol';

/*
 * The Drive domain. Functions take a user id and plain values, never a request,
 * and return wire-shaped views; failures are DriveErrors with a code a client can
 * act on and a message a person can read. Authorization is membership of the
 * workspace; the repository refuses a node that lives elsewhere as not found.
 */

export class DriveError extends Error {
    constructor(
        readonly code: DriveErrorCode,
        message: string,
        readonly status: 400 | 402 | 403 | 404 | 409 | 410 | 413 | 426 | 429 = 400,
        readonly data?: unknown,
    ) {
        super(message);
        this.name = 'DriveError';
    }
}

export { ANCESTOR_WALK_CAP };

export function capabilities(): Capabilities {
    return {
        protocolVersion: DRIVE_PROTOCOL_VERSION,
        contentSuites: [CONTENT_SUITE],
        envelopeSuites: [DRIVE_ENVELOPE_SUITE],
        chunkSize: CHUNK_SIZE,
        maxFileBytes: storageEnv.DRIVE_MAX_FILE_BYTES.toString(),
        maxDepth: MAX_DEPTH,
        nameMaxCodePoints: NAME_MAX_CODE_POINTS,
        tombstoneDays: TOMBSTONE_DAYS,
        trashRetentionDays: TRASH_RETENTION_DAYS,
    };
}

/* Wire shapes: envelopes as Base64url, byte counts as decimal strings, dates as ISO. */
export type VersionView = {
    id: string;
    objectId: string;
    contentKeyEnvelope: string;
    status: 'pending' | 'ready' | 'purged';
    objectStatus: 'pending' | 'ready' | 'missing';
    contentSuite: number;
    chunkSize: number;
    chunkCount: number;
    contentNonce: string;
    /* Suite 1 only; null under suite 2, where the envelope carries it. */
    plaintextSize: string | null;
    ciphertextSize: string;
    readyAt: string | null;
};
export type NodeView = {
    id: string;
    workspaceId: string;
    parentId: string | null;
    kind: 'folder' | 'file';
    keyEpoch: number;
    parentKeyEpoch: number;
    keyEnvelope: string;
    prevKeyEnvelope: string | null;
    prevKeyEpoch: number | null;
    prevParentKeyEpoch: number | null;
    metadataVersion: number;
    metadataEnvelope: string;
    currentVersion: VersionView | null;
    trashedAt: string | null;
    changeSeq: number | null;
    createdAt: string;
    updatedAt: string;
};

function b64(buffer: Buffer | Uint8Array) {
    return Buffer.from(buffer).toString('base64url');
}
function versionView(version: VersionRow | null | undefined): VersionView | null {
    if (!version || !version.contentKeyEnvelope) return null;
    return {
        id: version.id,
        objectId: version.objectId,
        contentKeyEnvelope: b64(version.contentKeyEnvelope),
        status: version.status,
        objectStatus: version.objectStatus,
        contentSuite: version.contentSuite,
        chunkSize: version.chunkSize,
        chunkCount: version.chunkCount,
        contentNonce: b64(version.contentNonce),
        plaintextSize: version.plaintextSize?.toString() ?? null,
        ciphertextSize: version.ciphertextSize.toString(),
        readyAt: version.readyAt?.toISOString() ?? null,
    };
}
export function nodeView(node: NodeRow & { currentVersion?: VersionRow | null }): NodeView {
    if (!node.keyEnvelope || !node.metadataEnvelope)
        throw new DriveError('not-found', 'This item no longer exists.', 404);
    return {
        id: node.id,
        workspaceId: node.workspaceId,
        parentId: node.parentId,
        kind: node.kind,
        keyEpoch: node.keyEpoch,
        parentKeyEpoch: node.parentKeyEpoch,
        keyEnvelope: b64(node.keyEnvelope),
        prevKeyEnvelope: node.prevKeyEnvelope ? b64(node.prevKeyEnvelope) : null,
        prevKeyEpoch: node.prevKeyEpoch,
        prevParentKeyEpoch: node.prevParentKeyEpoch,
        metadataVersion: node.metadataVersion,
        metadataEnvelope: b64(node.metadataEnvelope),
        currentVersion: versionView(node.currentVersion),
        trashedAt: node.trashedAt?.toISOString() ?? null,
        changeSeq: node.changeSeq,
        createdAt: node.createdAt.toISOString(),
        updatedAt: node.updatedAt.toISOString(),
    };
}

/* Base64url in, Buffer out, with the exact or maximum length the column allows. */
export function decodeEnvelope(value: string, exact?: number, max?: number) {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new DriveError('invalid', 'Invalid envelope.');
    const bytes = Buffer.from(value, 'base64url');
    if (
        bytes.toString('base64url') !== value ||
        (exact !== undefined && bytes.length !== exact) ||
        (max !== undefined && (bytes.length < 42 || bytes.length > max))
    )
        throw new DriveError('invalid', 'Invalid envelope.');
    return bytes;
}
const keyEnvelope = (value: string) => decodeEnvelope(value, KEY_ENVELOPE_BYTES);
/* A version envelope for an upload of the current suite: the key sealed with the sizes. */
const versionEnvelope = (value: string) => decodeEnvelope(value, VERSION_ENVELOPE_BYTES);
/* A version envelope for an object of either suite; the repository holds it to the object's. */
function anyVersionEnvelope(value: string) {
    const bytes = decodeEnvelope(value, undefined, VERSION_ENVELOPE_BYTES);
    if (bytes.length !== KEY_ENVELOPE_BYTES && bytes.length !== VERSION_ENVELOPE_BYTES)
        throw new DriveError('invalid', 'Invalid envelope.');
    return bytes;
}
/* The owner's sealed copy of a link's secret: 104 bytes before the password key was kept, 136 since. */
function linkSecretEnvelope(value: string) {
    const bytes = decodeEnvelope(value, undefined, 136);
    if (bytes.length !== 104 && bytes.length !== 136)
        throw new DriveError('invalid', 'Invalid envelope.');
    return bytes;
}
const metadataEnvelope = (value: string) =>
    decodeEnvelope(value, undefined, 24 + 16 + METADATA_MAX_BYTES);

async function requireMember(userId: string, workspaceId: string) {
    if (!(await driveRepository.isMember(userId, workspaceId)))
        throw new DriveError('not-found', 'This workspace does not exist.', 404);
}

/*
 * Authorization is the walk: a member owns the workspace; anyone else holds
 * the role of the nearest live share above the node, or nothing, which is the
 * same 404 as a node that does not exist. Too low a role is a 403, since the
 * caller can already see the node.
 */
type Access = NonNullable<Awaited<ReturnType<typeof driveRepository.authorize>>>;
const forbidden = (message = 'You do not have permission to do that here.') =>
    new DriveError('forbidden', message, 403);
async function requireAccess(
    userId: string,
    workspaceId: string,
    nodeId: string,
    needed: driveRepository.Role,
): Promise<Access> {
    const access = await driveRepository.authorize(userId, workspaceId, nodeId);
    if (!access) throw new DriveError('not-found', 'This item no longer exists.', 404);
    if (!driveRepository.atLeast(access.role, needed)) throw forbidden();
    return access;
}
async function requireVersionAccess(
    userId: string,
    workspaceId: string,
    versionId: string,
    needed: driveRepository.Role,
) {
    const access = await driveRepository.authorizeVersion(userId, workspaceId, versionId);
    if (!access) throw new DriveError('not-found', 'This version no longer exists.', 404);
    if (!driveRepository.atLeast(access.role, needed)) throw forbidden();
    return access;
}
async function requireUploadAccess(userId: string, workspaceId: string, uploadId: string) {
    const access = await driveRepository.authorizeUpload(userId, workspaceId, uploadId);
    if (!access) throw new DriveError('not-found', 'This upload no longer exists.', 404);
    if (!driveRepository.atLeast(access.role, 'editor')) throw forbidden();
    return access;
}
/* Editors of a shared folder need epochs in its owner's workspace for the nodes they create. */
async function requireEpochs(userId: string, workspaceId: string) {
    if (
        !(await driveRepository.isMember(userId, workspaceId)) &&
        !(await driveRepository.hasEditorShare(userId, workspaceId))
    )
        throw new DriveError('not-found', 'This workspace does not exist.', 404);
}
/*
 * The versions among `ids` the caller may read, and how long their URLs live:
 * all of them for an hour for a member; by the walk, for fifteen minutes, for
 * anyone else, since a revoked grantee must not keep a long-lived URL.
 */
async function readableVersions(userId: string, workspaceId: string, ids: string[]) {
    if (await driveRepository.isMember(userId, workspaceId))
        return { ids, ttl: DOWNLOAD_URL_TTL_SECONDS };
    return {
        ids: [...(await driveRepository.authorizeVersions(userId, workspaceId, ids))],
        ttl: SHARE_URL_TTL_SECONDS,
    };
}

const notFound = () => new DriveError('not-found', 'This item no longer exists.', 404);
const rotating = () =>
    new DriveError(
        'rotating',
        'Keys are being rotated for this folder. Try again in a moment.',
        409,
    );
const trashed = () =>
    new DriveError('trashed', 'This item is in the trash. Restore it first.', 409);
const parentTrashed = () =>
    new DriveError('parent-trashed', 'The destination folder is in the trash.', 409);
const tooDeep = () =>
    new DriveError('too-deep', `Folders cannot be nested more than ${MAX_DEPTH} levels deep.`, 409);
const stale = (data?: unknown) =>
    new DriveError(
        'stale',
        'This item changed since you last saw it. Refresh and try again.',
        409,
        data,
    );

/* The personal workspace: its id, the member's grant, and the root if it exists. */
export async function getWorkspace(userId: string) {
    const workspace = await driveRepository.getPersonalWorkspace(userId);
    if (!workspace) throw new DriveError('not-found', 'Finish account setup to open Drive.', 404);
    return {
        workspaceId: workspace.workspaceId,
        changeSeq: workspace.changeSeq,
        grant: workspace.grant
            ? {
                  version: 1 as const,
                  workspaceId: workspace.workspaceId,
                  keyVersion: workspace.grant.keyVersion,
                  workspaceKeyVersion: workspace.grant.workspaceKeyVersion,
                  wrappingSalt: b64(workspace.grant.wrappingSalt),
                  wrappingNonce: b64(workspace.grant.wrappingNonce),
                  encryptedKey: b64(workspace.grant.encryptedKey),
              }
            : null,
        root: workspace.root ? nodeView(workspace.root) : null,
        rotation: workspace.rotation
            ? { nodeId: workspace.rotation.nodeId, targetEpoch: workspace.rotation.targetEpoch }
            : null,
    };
}

export async function allocateEpochs(userId: string, workspaceId: string, count: number) {
    await requireEpochs(userId, workspaceId);
    if (!Number.isInteger(count) || count < 1 || count > 10_000)
        throw new DriveError('invalid', 'Invalid epoch count.');
    const range = await driveRepository.allocateKeyEpochs(workspaceId, count);
    if (!range) throw notFound();
    return range;
}

export type NodeEnvelopesInput = {
    keyEpoch: number;
    parentKeyEpoch: number;
    keyEnvelope: string;
    metadataEnvelope: string;
};
function envelopes(input: NodeEnvelopesInput) {
    return {
        keyEpoch: input.keyEpoch,
        parentKeyEpoch: input.parentKeyEpoch,
        keyEnvelope: keyEnvelope(input.keyEnvelope),
        metadataEnvelope: metadataEnvelope(input.metadataEnvelope),
    };
}

export async function createRoot(
    userId: string,
    workspaceId: string,
    input: { id: string } & NodeEnvelopesInput,
) {
    await requireMember(userId, workspaceId);
    const result = await driveRepository.createRoot({
        workspaceId,
        userId,
        id: input.id,
        envelopes: envelopes(input),
    });
    if (result.status === 'stale') throw stale();
    return { created: result.status === 'created', root: nodeView(result.root) };
}

export async function listChildren(
    userId: string,
    workspaceId: string,
    parentId: string,
    after?: string,
) {
    const access = await requireAccess(userId, workspaceId, parentId, 'viewer');
    const result = await driveRepository.listChildren({
        workspaceId,
        parentId,
        after,
        boundary: access.shareRootId,
    });
    if (result.status === 'not-found') throw notFound();
    if (result.status === 'trashed') throw trashed();
    return {
        folder: nodeView(result.folder),
        ancestors: result.ancestors.map(nodeView),
        children: result.children.map(nodeView),
        nextCursor: result.nextCursor,
    };
}

export async function createFolders(
    userId: string,
    workspaceId: string,
    folders: ({ id: string; parentId: string } & NodeEnvelopesInput)[],
) {
    const batchIds = new Set(folders.map((folder) => folder.id));
    for (const parentId of new Set(folders.map((folder) => folder.parentId)))
        if (!batchIds.has(parentId)) await requireAccess(userId, workspaceId, parentId, 'editor');
    if (folders.length < 1 || folders.length > MAX_FOLDER_BATCH)
        throw new DriveError(
            'invalid',
            `Create between 1 and ${MAX_FOLDER_BATCH} folders at a time.`,
        );
    const result = await driveRepository.createFolders({
        workspaceId,
        userId,
        folders: folders.map((folder) => ({
            id: folder.id,
            parentId: folder.parentId,
            envelopes: envelopes(folder),
        })),
    });
    switch (result.status) {
        case 'created':
            return { nodes: result.nodes.map(nodeView), changeSeq: result.changeSeq };
        case 'not-found':
            throw notFound();
        case 'parent-trashed':
            throw parentTrashed();
        case 'too-deep':
            throw tooDeep();
        case 'stale':
            throw stale({ id: result.id });
        case 'conflict':
            throw new DriveError('conflict', 'An item with this id already exists.', 409, {
                id: result.id,
            });
    }
}

export async function renameNode(
    userId: string,
    workspaceId: string,
    nodeId: string,
    input: { metadataVersion: number; keyEpoch: number; metadataEnvelope: string },
) {
    await requireAccess(userId, workspaceId, nodeId, 'editor');
    const result = await driveRepository.renameNode({
        workspaceId,
        nodeId,
        metadataVersion: input.metadataVersion,
        keyEpoch: input.keyEpoch,
        metadataEnvelope: metadataEnvelope(input.metadataEnvelope),
    });
    if (result.status === 'not-found') throw notFound();
    if (result.status === 'trashed') throw trashed();
    if (result.status === 'stale') throw stale({ node: nodeView(result.node) });
    return { node: nodeView(result.node) };
}

export async function moveNode(
    userId: string,
    workspaceId: string,
    nodeId: string,
    input: { parentId: string; parentKeyEpoch: number; keyEnvelope: string },
) {
    const [source, destination] = await Promise.all([
        requireAccess(userId, workspaceId, nodeId, 'editor'),
        requireAccess(userId, workspaceId, input.parentId, 'editor'),
    ]);
    // An editor holds no key outside the share: both ends must lie inside the same one.
    if (source.shareId !== destination.shareId)
        throw forbidden('Move it within the shared folder, or ask its owner to move it out.');
    const result = await driveRepository.moveNode({
        workspaceId,
        nodeId,
        parentId: input.parentId,
        parentKeyEpoch: input.parentKeyEpoch,
        keyEnvelope: keyEnvelope(input.keyEnvelope),
    });
    switch (result.status) {
        case 'ok':
            return { node: nodeView(result.node) };
        case 'not-found':
            throw notFound();
        case 'root':
            throw new DriveError('invalid', 'The top folder cannot be moved.', 409);
        case 'trashed':
            throw trashed();
        case 'parent-trashed':
            throw parentTrashed();
        case 'cycle':
            throw new DriveError('cycle', 'A folder cannot be moved into itself.', 409);
        case 'too-deep':
            throw tooDeep();
        case 'rotating':
            throw rotating();
        case 'stale':
            throw stale({ node: nodeView(result.node) });
    }
}

export async function trashNode(userId: string, workspaceId: string, nodeId: string) {
    await requireAccess(userId, workspaceId, nodeId, 'editor');
    const result = await driveRepository.trashNode({ workspaceId, nodeId });
    if (result.status === 'not-found') throw notFound();
    if (result.status === 'root')
        throw new DriveError('invalid', 'The top folder cannot be moved to the trash.', 409);
    if (result.status === 'trashed') throw trashed();
    return { node: nodeView(result.node) };
}

export async function restoreNode(
    userId: string,
    workspaceId: string,
    nodeId: string,
    toRoot?: { parentKeyEpoch: number; keyEnvelope: string },
) {
    await requireMember(userId, workspaceId);
    const result = await driveRepository.restoreNode({
        workspaceId,
        nodeId,
        toRoot: toRoot
            ? {
                  parentKeyEpoch: toRoot.parentKeyEpoch,
                  keyEnvelope: keyEnvelope(toRoot.keyEnvelope),
              }
            : undefined,
    });
    switch (result.status) {
        case 'ok':
            return { node: nodeView(result.node) };
        case 'not-found':
            throw notFound();
        case 'not-trashed':
            throw new DriveError('conflict', 'This item is not in the trash.', 409);
        case 'parent-trashed':
            throw new DriveError(
                'parent-trashed',
                'The folder this was in is still in the trash. Restore it to the top folder instead.',
                409,
            );
        case 'too-deep':
            throw tooDeep();
        case 'stale':
            throw stale();
        case 'removed':
            throw new DriveError(
                'forbidden',
                'This item was removed by the operator of this instance and cannot be restored.',
                403,
            );
    }
}

/* Delete forever: purges one trashed node now; its descendants follow in the worker's fan-out. */
export async function purgeNode(userId: string, workspaceId: string, nodeId: string) {
    await requireMember(userId, workspaceId);
    const result = await driveRepository.purgeNode({ workspaceId, nodeId });
    switch (result.status) {
        case 'not-found':
            throw notFound();
        case 'root':
            throw new DriveError('invalid', 'The top folder cannot be deleted.', 409);
        case 'not-trashed':
            throw new DriveError('conflict', 'Move this item to the trash first.', 409);
        case 'ok':
            return { purged: true };
    }
}

const unavailable = () =>
    new DriveError(
        'conflict',
        'This file is unavailable: its data could not be found in storage.',
        409,
    );

export type CopyInput = {
    sourceVersionId: string;
    node: { id: string; parentId: string } & NodeEnvelopesInput;
    versionId: string;
    contentKeyEnvelope: string;
};

/*
 * Copy within the workspace: the client rewrapped the source version's content
 * key under a fresh node key; the server shares the object and charges the
 * copy like any upload.
 */
export async function copyNode(
    userId: string,
    workspaceId: string,
    sourceNodeId: string,
    input: CopyInput,
) {
    await requireAccess(userId, workspaceId, sourceNodeId, 'viewer');
    await requireAccess(userId, workspaceId, input.node.parentId, 'editor');
    const result = await driveRepository.copyFile({
        workspaceId,
        userId,
        sourceNodeId,
        sourceVersionId: input.sourceVersionId,
        node: {
            id: input.node.id,
            parentId: input.node.parentId,
            envelopes: envelopes(input.node),
        },
        version: {
            id: input.versionId,
            contentKeyEnvelope: anyVersionEnvelope(input.contentKeyEnvelope),
        },
    });
    switch (result.status) {
        case 'ok':
            return { node: nodeView(result.node) };
        case 'invalid':
            throw new DriveError('invalid', 'The envelope does not match how this file is stored.');
        case 'over-quota':
            throw new DriveError(
                'over-quota',
                'Not enough storage for a copy. Free some space or upgrade your plan.',
                402,
                { freeBytes: result.free.toString() },
            );
        case 'not-found':
            throw notFound();
        case 'trashed':
            throw trashed();
        case 'parent-trashed':
            throw parentTrashed();
        case 'too-deep':
            throw tooDeep();
        case 'stale':
            throw stale();
        case 'unavailable':
            throw unavailable();
        case 'conflict':
            throw new DriveError('conflict', 'An item with this id already exists.', 409);
    }
}

/* A file's versions, current first. */
export async function listVersions(userId: string, workspaceId: string, nodeId: string) {
    await requireAccess(userId, workspaceId, nodeId, 'viewer');
    const result = await driveRepository.listVersions(workspaceId, nodeId);
    if (!result) throw notFound();
    return {
        versions: result.versions.map((version) => ({
            ...versionView(version)!,
            current: version.id === result.currentVersionId,
            supersededAt: version.supersededAt?.toISOString() ?? null,
            createdAt: version.createdAt.toISOString(),
        })),
    };
}

export async function restoreVersion(userId: string, workspaceId: string, versionId: string) {
    await requireVersionAccess(userId, workspaceId, versionId, 'editor');
    const result = await driveRepository.restoreVersion(workspaceId, versionId);
    switch (result.status) {
        case 'ok':
            return { node: nodeView(result.node) };
        case 'not-found':
            throw new DriveError('not-found', 'This version no longer exists.', 404);
        case 'trashed':
            throw trashed();
        case 'not-superseded':
            throw new DriveError('conflict', 'This is already the current version.', 409);
        case 'unavailable':
            throw unavailable();
    }
}

export async function discardVersion(userId: string, workspaceId: string, versionId: string) {
    await requireVersionAccess(userId, workspaceId, versionId, 'editor');
    const result = await driveRepository.discardVersion(workspaceId, versionId);
    switch (result.status) {
        case 'ok':
            return { discarded: true };
        case 'not-found':
            throw new DriveError('not-found', 'This version no longer exists.', 404);
        case 'current':
            throw new DriveError(
                'conflict',
                'The current version cannot be discarded. Upload a new one or move the file to the trash.',
                409,
            );
    }
}

/* ------------------------------------------------------------------------- */
/* Shares                                                                     */
/* ------------------------------------------------------------------------- */

function shareView(row: Awaited<ReturnType<typeof driveRepository.listNodeShares>>[number]) {
    return {
        id: row.id,
        role: row.role,
        keyEpoch: row.keyEpoch,
        createdAt: row.createdAt.toISOString(),
        grantee: row.grantee,
    };
}

/* Owners alone share: a node's key sealed by the client to a contact's identity, with a role. */
export async function shareNode(
    userId: string,
    workspaceId: string,
    nodeId: string,
    input: {
        granteeUserId: string;
        role: 'viewer' | 'editor';
        keyEpoch: number;
        shareEnvelope: string;
    },
) {
    await requireMember(userId, workspaceId);
    const result = await driveRepository.createShare({
        workspaceId,
        nodeId,
        granterUserId: userId,
        granteeUserId: input.granteeUserId,
        role: input.role,
        keyEpoch: input.keyEpoch,
        shareEnvelope: decodeEnvelope(input.shareEnvelope, 72),
    });
    switch (result.status) {
        case 'not-found':
            throw notFound();
        case 'trashed':
            throw trashed();
        case 'stale':
            throw stale();
        case 'self':
            throw new DriveError('invalid', 'You already have access to your own files.', 409);
        case 'ok': {
            const shares = await driveRepository.listNodeShares(workspaceId, nodeId);
            const share = shares.find((row) => row.id === result.share.id);
            if (!share) throw notFound();
            return { share: shareView(share) };
        }
    }
}

export async function listNodeShares(userId: string, workspaceId: string, nodeId: string) {
    await requireMember(userId, workspaceId);
    return { shares: (await driveRepository.listNodeShares(workspaceId, nodeId)).map(shareView) };
}

export async function revokeShare(userId: string, workspaceId: string, shareId: string) {
    await requireMember(userId, workspaceId);
    const revoked = await driveRepository.revokeShare(workspaceId, shareId);
    if (!revoked) throw new DriveError('not-found', 'This share no longer exists.', 404);
    return { revoked: true };
}

/* Everything the caller shares out, for the Shared page's "by me" view. */
export async function listSharedByMe(userId: string) {
    const [shares, links] = await Promise.all([
        driveRepository.listSharesByGranter(userId),
        driveRepository.listLinksByGranter(userId),
    ]);
    return {
        shares: shares.map((row) => ({ ...shareView(row), node: nodeView(row.node) })),
        links: links.map((row) => ({ ...linkView(row), node: nodeView(row.node) })),
    };
}

/* Everything shared with the caller, each node a root of its own. */
export async function listSharedWithMe(userId: string) {
    const rows = await driveRepository.listSharesForGrantee(userId);
    return {
        shares: rows.map((row) => ({
            id: row.id,
            workspaceId: row.workspaceId,
            role: row.role,
            keyEpoch: row.keyEpoch,
            shareEnvelope: b64(row.shareEnvelope),
            prevShareEnvelope: row.prevShareEnvelope ? b64(row.prevShareEnvelope) : null,
            prevKeyEpoch: row.prevKeyEpoch,
            createdAt: row.createdAt.toISOString(),
            changeSeq: row.changeSeq,
            granter: {
                id: row.granter.id,
                name: row.granter.name,
                email: row.granter.email,
                encryptionPublicKey: b64(row.granter.encryptionPublicKey),
            },
            node: nodeView(row.node),
        })),
    };
}

/* Bytes a person could free: the trash, and earlier versions of files. */
export async function storageBreakdown(userId: string, workspaceId: string) {
    await requireMember(userId, workspaceId);
    const breakdown = await driveRepository.getStorageBreakdown(workspaceId);
    return {
        trashBytes: breakdown.trashBytes.toString(),
        trashItems: breakdown.trashItems,
        supersededBytes: breakdown.supersededBytes.toString(),
        supersededVersions: breakdown.supersededVersions,
    };
}

/* Removes every file's earlier version now, a batch at a time; current versions are never touched. */
export async function discardSupersededVersions(userId: string, workspaceId: string) {
    await requireMember(userId, workspaceId);
    const purged = await driveRepository.purgeExpiredSupersededVersions(0, 200, workspaceId);
    const remaining = (await driveRepository.getStorageBreakdown(workspaceId)).supersededVersions;
    return { purged, remaining };
}

/* Empties the trash a batch of roots at a time; the client calls until nothing remains. */
export async function emptyTrash(userId: string, workspaceId: string) {
    await requireMember(userId, workspaceId);
    return driveRepository.emptyTrash(workspaceId, 100);
}

export async function listTrash(userId: string, workspaceId: string, after?: string) {
    await requireMember(userId, workspaceId);
    const result = await driveRepository.listTrash({ workspaceId, after });
    return {
        items: result.items.map((item) => ({
            node: nodeView(item.node),
            ancestors: item.ancestors.map(nodeView),
            parentTrashed: item.parentTrashed,
        })),
        nextCursor: result.nextCursor,
    };
}

/* ------------------------------------------------------------------------- */
/* Uploads                                                                    */
/* ------------------------------------------------------------------------- */

export type UploadBeginInput = {
    node:
        | ({ existing: false; id: string; parentId: string } & NodeEnvelopesInput)
        | { existing: true; id: string; keyEpoch: number; expectedVersionId: string | null };
    versionId: string;
    objectId: string;
    contentKeyEnvelope: string;
    contentNonce: string;
    contentSuite: number;
    chunkCount: number;
    /* The whole object, trailer included: what is reserved and what the store must confirm. */
    ciphertextSize: string;
};

export type UploadView = {
    id: string;
    nodeId: string;
    versionId: string;
    objectId: string | null;
    status: UploadRow['status'];
    chunkCount: number;
    ciphertextSize: string;
    expiresAt: string;
};

/* An upload whose object row is still there: the framing is known. */
type LiveUploadRow = UploadRow & {
    objectId: string;
    chunkSize: number;
    chunkCount: number;
    ciphertextSize: bigint;
};
function live(row: UploadRow): LiveUploadRow {
    if (
        row.objectId === null ||
        row.chunkCount === null ||
        row.ciphertextSize === null ||
        row.chunkSize === null
    )
        throw new DriveError('conflict', `This upload is ${row.status}.`, 409, {
            status: row.status,
        });
    return row as LiveUploadRow;
}

function uploadView(row: UploadRow): UploadView {
    return {
        id: row.id,
        nodeId: row.nodeId,
        versionId: row.versionId,
        objectId: row.objectId,
        status: row.status,
        chunkCount: row.chunkCount ?? 0,
        ciphertextSize: row.ciphertextSize?.toString() ?? '0',
        expiresAt: row.expiresAt.toISOString(),
    };
}

/*
 * What the server can check about a declared object: that a last part of the
 * declared size can hold a chunk and a trailer, and that the plaintext it bounds
 * (the object less its tags, allowing for a trailer) is within the file limit.
 * The plaintext size itself is sealed in the envelope and never seen here.
 */
function parseCiphertextSize(value: string, chunkCount: number) {
    if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 10_000)
        throw new DriveError('invalid', 'Invalid chunk count.');
    if (!/^[0-9]{1,16}$/.test(value)) throw new DriveError('invalid', 'Invalid object size.');
    const size = BigInt(value);
    if (!validObjectSize(Number(size), chunkCount))
        throw new DriveError('invalid', 'The object size does not fit its chunk count.');
    const contentBound =
        size - BigInt(CHUNK_TAG_BYTES * chunkCount) - BigInt(THUMBNAIL_MAX_BYTES + CHUNK_TAG_BYTES);
    if (contentBound > storageEnv.DRIVE_MAX_FILE_BYTES)
        throw new DriveError(
            'too-large',
            `Files can be at most ${Number(storageEnv.DRIVE_MAX_FILE_BYTES / (1024n * 1024n * 1024n))} GiB on this server.`,
            413,
        );
    return size;
}

async function presignParts(upload: UploadRow, from: number, count: number) {
    const row = live(upload);
    const store = primaryStore();
    const total = row.chunkCount;
    const size = Number(row.ciphertextSize);
    const to = Math.min(total, from + count - 1);
    const parts = [];
    for (let partNumber = from; partNumber <= to; partNumber++) {
        const length = partLength(size, total, partNumber);
        parts.push({
            partNumber,
            length,
            url: await store.presignPart(
                row.objectKey,
                row.multipartId,
                partNumber,
                length,
                PART_URL_TTL_SECONDS,
            ),
        });
    }
    return {
        parts,
        urlExpiresAt: new Date(Date.now() + PART_URL_TTL_SECONDS * 1000).toISOString(),
    };
}

/*
 * Begin: the store's multipart upload is opened first (an abandoned one costs
 * nothing until parts arrive and is swept), then the reservation and pending rows
 * are written in one transaction; a refusal there aborts the multipart upload.
 */
export async function beginUpload(userId: string, workspaceId: string, input: UploadBeginInput) {
    if (input.node.existing) await requireAccess(userId, workspaceId, input.node.id, 'editor');
    else await requireAccess(userId, workspaceId, input.node.parentId, 'editor');
    if (input.contentSuite !== CONTENT_SUITE)
        throw new DriveError(
            'unsupported',
            input.contentSuite === LEGACY_CONTENT_SUITE
                ? 'This app is out of date for this server. Reload and try again.'
                : 'This server does not accept files stored that way.',
        );
    const ciphertextSize = parseCiphertextSize(input.ciphertextSize, input.chunkCount);
    const contentNonce = decodeEnvelope(input.contentNonce, 16);
    const key = objectKey(workspaceId, input.objectId);
    const store = primaryStore();
    const multipartId = await store.createMultipart(key);
    const result = await driveRepository.beginUpload({
        workspaceId,
        userId,
        node: input.node.existing
            ? {
                  existing: true,
                  id: input.node.id,
                  keyEpoch: input.node.keyEpoch,
                  expectedVersionId: input.node.expectedVersionId,
              }
            : {
                  existing: false,
                  id: input.node.id,
                  parentId: input.node.parentId,
                  envelopes: envelopes(input.node),
              },
        version: {
            id: input.versionId,
            contentKeyEnvelope: versionEnvelope(input.contentKeyEnvelope),
        },
        object: {
            id: input.objectId,
            objectKey: key,
            contentSuite: CONTENT_SUITE,
            chunkSize: CHUNK_SIZE,
            chunkCount: input.chunkCount,
            contentNonce,
            ciphertextSize,
        },
        multipartId,
        expiresAt: new Date(Date.now() + UPLOAD_TTL_HOURS * 3600 * 1000),
    });
    if (result.status !== 'ok') {
        await store.abortMultipart(key, multipartId).catch(() => {});
        switch (result.status) {
            case 'over-quota':
                throw new DriveError(
                    'over-quota',
                    'Not enough storage for this file. Free some space or upgrade your plan.',
                    402,
                    { freeBytes: result.free.toString() },
                );
            case 'not-found':
                throw notFound();
            case 'trashed':
                throw trashed();
            case 'parent-trashed':
                throw parentTrashed();
            case 'too-deep':
                throw tooDeep();
            case 'stale':
                throw stale();
            case 'conflict':
                throw new DriveError('conflict', 'An item with this id already exists.', 409);
        }
    }
    const row = await driveRepository.getUpload(workspaceId, result.uploadId);
    if (!row) throw notFound();
    return { upload: uploadView(row), ...(await presignParts(row, 1, MAX_PART_URLS_PER_REQUEST)) };
}

async function openUpload(userId: string, workspaceId: string, uploadId: string) {
    await requireUploadAccess(userId, workspaceId, uploadId);
    const row = await driveRepository.getUpload(workspaceId, uploadId);
    if (!row) throw new DriveError('not-found', 'This upload no longer exists.', 404);
    return row;
}

/* More presigned part URLs; they expire after an hour and can always be reissued. */
export async function uploadPartUrls(
    userId: string,
    workspaceId: string,
    uploadId: string,
    from: number,
    count: number,
) {
    const row = await openUpload(userId, workspaceId, uploadId);
    if (row.status !== 'open')
        throw new DriveError('conflict', `This upload is ${row.status}.`, 409, {
            status: row.status,
        });
    if (row.expiresAt.getTime() <= Date.now())
        throw new DriveError('expired', 'This upload expired. Start it again.', 409);
    if (!Number.isInteger(from) || from < 1 || from > (row.chunkCount ?? 0))
        throw new DriveError('invalid', 'Invalid part number.');
    return presignParts(row, from, Math.min(Math.max(1, count), MAX_PART_URLS_PER_REQUEST));
}

/* The upload's state and the parts the store already holds, for a resume. */
export async function getUploadState(userId: string, workspaceId: string, uploadId: string) {
    const row = await openUpload(userId, workspaceId, uploadId);
    const stored =
        row.status === 'open'
            ? await primaryStore().listParts(row.objectKey, row.multipartId)
            : null;
    return { upload: uploadView(row), parts: stored ?? [] };
}

/*
 * Complete, in the design's three steps. Between one and three the store does the
 * work; a failure there leaves the upload `completing`, which expiry resolves.
 */
export async function completeUpload(
    userId: string,
    workspaceId: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
) {
    await requireUploadAccess(userId, workspaceId, uploadId);
    const started = await driveRepository.startCompleting(workspaceId, uploadId);
    switch (started.status) {
        case 'not-found':
            throw new DriveError('not-found', 'This upload no longer exists.', 404);
        case 'aborted':
            throw new DriveError('conflict', 'This upload was cancelled.', 409);
        case 'expired':
            throw new DriveError('expired', 'This upload expired. Start it again.', 409);
        case 'completed': {
            const node = await driveRepository.getNode(workspaceId, started.upload.nodeId);
            return { status: 'completed' as const, node: node ? nodeView(node.node) : null };
        }
        case 'conflicted':
            throw new DriveError('conflict', 'This file changed while it was uploading.', 409, {
                conflicted: true,
            });
    }
    const row = live(started.upload);
    if (parts.length !== row.chunkCount)
        throw new DriveError('invalid', 'Every part must be listed exactly once.');
    const store = primaryStore();
    const stored = await store.completeMultipart(
        row.objectKey,
        row.multipartId,
        [...parts].sort((a, b) => a.partNumber - b.partNumber),
    );
    const finished = await driveRepository.finishCompleting(
        workspaceId,
        uploadId,
        stored ? BigInt(stored.size) : null,
    );
    switch (finished.status) {
        case 'published':
            return { status: 'completed' as const, node: nodeView(finished.node) };
        case 'completed': {
            const node = await driveRepository.getNode(workspaceId, finished.upload.nodeId);
            return { status: 'completed' as const, node: node ? nodeView(node.node) : null };
        }
        case 'conflicted':
            throw new DriveError('conflict', 'This file changed while it was uploading.', 409, {
                conflicted: true,
                currentVersionId: finished.currentVersionId,
            });
        case 'size-mismatch':
            await store.abortMultipart(row.objectKey, row.multipartId).catch(() => {});
            throw new DriveError(
                'invalid',
                'The uploaded data did not match its expected size. Upload it again.',
                409,
            );
        case 'purged':
            throw new DriveError(
                'not-found',
                'The folder this was going to no longer exists.',
                404,
            );
        case 'not-found':
            throw new DriveError('not-found', 'This upload no longer exists.', 404);
        case 'not-completing':
            throw new DriveError('conflict', `This upload is ${finished.uploadStatus}.`, 409);
    }
}

export type UploadAttachInput =
    | { mode: 'same-node'; keyEpoch: number; contentKeyEnvelope: string }
    | {
          mode: 'sibling';
          node: { id: string; parentId: string } & NodeEnvelopesInput;
          contentKeyEnvelope: string;
      };

/*
 * Attach publishes a conflicted upload's finished object under fresh keys: the
 * same node when only the key epoch moved, or a new sibling when the version did.
 * The repository checks every epoch against the tree as it is now.
 */
export async function attachUpload(
    userId: string,
    workspaceId: string,
    uploadId: string,
    input: UploadAttachInput,
) {
    await requireUploadAccess(userId, workspaceId, uploadId);
    const result = await driveRepository.attachUpload(
        workspaceId,
        uploadId,
        input.mode === 'same-node'
            ? {
                  mode: 'same-node',
                  keyEpoch: input.keyEpoch,
                  contentKeyEnvelope: versionEnvelope(input.contentKeyEnvelope),
              }
            : {
                  mode: 'sibling',
                  userId,
                  node: {
                      id: input.node.id,
                      parentId: input.node.parentId,
                      ...envelopes(input.node),
                  },
                  contentKeyEnvelope: versionEnvelope(input.contentKeyEnvelope),
              },
    );
    switch (result.status) {
        case 'published':
            return { status: 'completed' as const, node: nodeView(result.node) };
        case 'completed': {
            const node = await driveRepository.getNode(workspaceId, result.upload.nodeId);
            return { status: 'completed' as const, node: node ? nodeView(node.node) : null };
        }
        case 'not-found':
            throw new DriveError('not-found', 'This upload no longer exists.', 404);
        case 'not-conflicted':
            throw new DriveError('conflict', `This upload is ${result.uploadStatus}.`, 409, {
                status: result.uploadStatus,
            });
        case 'conflicted':
            throw new DriveError(
                'conflict',
                'This file changed again while it was being attached.',
                409,
                { conflicted: true, currentVersionId: result.currentVersionId },
            );
        case 'purged':
            throw new DriveError(
                'not-found',
                'The folder this was going to no longer exists.',
                404,
            );
        case 'parent-trashed':
            throw parentTrashed();
        case 'too-deep':
            throw tooDeep();
        case 'stale':
            throw stale();
        case 'conflict':
            throw new DriveError('conflict', 'An item with this id already exists.', 409);
    }
}

export async function abortUpload(userId: string, workspaceId: string, uploadId: string) {
    await requireUploadAccess(userId, workspaceId, uploadId);
    const result = await driveRepository.abortUpload(workspaceId, uploadId);
    switch (result.status) {
        case 'not-found':
            throw new DriveError('not-found', 'This upload no longer exists.', 404);
        case 'completing':
            throw new DriveError(
                'conflict',
                'This upload is finishing and cannot be cancelled.',
                409,
            );
        case 'completed':
            throw new DriveError('conflict', 'This upload already finished.', 409);
        case 'ok':
            if (!result.alreadyAborted)
                await primaryStore()
                    .abortMultipart(result.upload.objectKey, result.upload.multipartId)
                    .catch(() => {});
            return { aborted: true };
    }
}

/* ------------------------------------------------------------------------- */
/* Thumbnails                                                                 */
/* ------------------------------------------------------------------------- */

/*
 * A thumbnail is the trailer of its version's object, and only the envelope
 * says whether there is one, so this is a presigned GET for each ready version's
 * object, for up to 100 at once, without the read that opening the file records.
 * The client fetches the trailer's range and decrypts it in the worker.
 */
export async function thumbnailUrls(userId: string, workspaceId: string, versionIds: string[]) {
    const { ids, ttl } = await readableVersions(
        userId,
        workspaceId,
        [...new Set(versionIds)].slice(0, THUMBNAIL_BATCH),
    );
    const { urls, urlExpiresAt } = await presignObjects(workspaceId, ids, ttl);
    return { urls, urlExpiresAt };
}

/* The rows come back too, for callers that record the read; they hold bigints and never go on the wire. */
async function presignObjects(workspaceId: string, ids: string[], ttl: number) {
    const rows = await driveRepository.getVersionsForDownload(workspaceId, ids);
    const store = primaryStore();
    const urls = await Promise.all(
        rows.map(async (row) => ({
            versionId: row.version.id,
            url: await store.presignGet(row.objectKey, ttl),
        })),
    );
    return { rows, urls, urlExpiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
}

/* ------------------------------------------------------------------------- */
/* Downloads                                                                  */
/* ------------------------------------------------------------------------- */

/* Presigned GETs for up to 100 versions at once, for a zip; versions not ready are left out. */
export async function downloadUrls(userId: string, workspaceId: string, versionIds: string[]) {
    const { ids, ttl } = await readableVersions(
        userId,
        workspaceId,
        [...new Set(versionIds)].slice(0, THUMBNAIL_BATCH),
    );
    return presignDownloads(workspaceId, ids, ttl);
}

async function presignDownloads(workspaceId: string, ids: string[], ttl: number) {
    const { rows, urls, urlExpiresAt } = await presignObjects(workspaceId, ids, ttl);
    for (const row of rows)
        void driveRepository.touchObjectRead(row.version.objectId).catch(() => {});
    return { urls, urlExpiresAt };
}

/*
 * A presigned GET for a version's object, good for an hour and reissued on
 * demand. The client fetches chunk-aligned ranges from it and decrypts each
 * chunk as it arrives; the response carries the framing it needs to do so.
 */
export async function downloadUrl(userId: string, workspaceId: string, versionId: string) {
    const access = await requireVersionAccess(userId, workspaceId, versionId, 'viewer');
    return presignDownload(
        workspaceId,
        versionId,
        access.role === 'owner' ? DOWNLOAD_URL_TTL_SECONDS : SHARE_URL_TTL_SECONDS,
    );
}

async function presignDownload(workspaceId: string, versionId: string, ttl: number) {
    const result = await driveRepository.getVersionForDownload(workspaceId, versionId);
    if (result.status === 'not-found') throw notFound();
    if (result.status === 'not-ready')
        throw new DriveError(
            'conflict',
            result.objectStatus === 'missing'
                ? 'This file is unavailable: its data could not be found in storage.'
                : 'This file is still being uploaded.',
            409,
        );
    const url = await primaryStore().presignGet(result.objectKey, ttl);
    void driveRepository.touchObjectRead(result.version.objectId).catch(() => {});
    return {
        url,
        urlExpiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        node: nodeView(result.node),
        version: versionView(result.version)!,
    };
}

/* ------------------------------------------------------------------------- */
/* Links                                                                      */
/* ------------------------------------------------------------------------- */

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const hashToken = (token: string) => createHash('sha256').update(token).digest();

function linkView(row: Awaited<ReturnType<typeof driveRepository.listNodeLinks>>[number]) {
    return {
        id: row.id,
        keyEpoch: row.keyEpoch,
        secretEnvelope: row.secretEnvelope ? b64(row.secretEnvelope) : null,
        hasPassword: row.hasPassword,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        useCount: row.useCount,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
    };
}

/*
 * Owners alone make links. The token is minted here, stored only as a hash,
 * and returned once; the fragment secret was never sent. Expiry is capped so a
 * forgotten link does not outlive the year.
 */
export async function createLink(
    userId: string,
    workspaceId: string,
    nodeId: string,
    input: {
        linkId: string;
        token: string;
        keyEpoch: number;
        linkEnvelope: string;
        linkSalt: string;
        secretEnvelope: string;
        hasPassword: boolean;
        expiresAt: string | null;
    },
) {
    await requireMember(userId, workspaceId);
    if (!TOKEN_PATTERN.test(input.token)) throw new DriveError('invalid', 'Invalid link token.');
    const result = await driveRepository.createLink({
        id: input.linkId,
        workspaceId,
        nodeId,
        granterUserId: userId,
        tokenHash: hashToken(input.token),
        keyEpoch: input.keyEpoch,
        linkEnvelope: decodeEnvelope(input.linkEnvelope, 72),
        linkSalt: decodeEnvelope(input.linkSalt, 16),
        secretEnvelope: linkSecretEnvelope(input.secretEnvelope),
        hasPassword: input.hasPassword,
        expiresAt: linkExpiry(input.expiresAt) ?? null,
    });
    switch (result.status) {
        case 'not-found':
            throw notFound();
        case 'trashed':
            throw trashed();
        case 'stale':
            throw stale();
        case 'conflict':
            throw new DriveError('conflict', 'A link with this id already exists.', 409);
        case 'ok':
            return { link: linkView(result.link) };
    }
}

/* An expiry, if any, must lie ahead and within a year, so a forgotten link does not outlive it. */
function linkExpiry(value: string | null | undefined) {
    if (value === null || value === undefined) return value;
    const expiresAt = new Date(value);
    const max = Date.now() + 366 * 24 * 3600 * 1000;
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())
        throw new DriveError('invalid', 'Choose an expiry in the future.');
    if (expiresAt.getTime() > max)
        throw new DriveError('invalid', 'A link can last at most a year.');
    return expiresAt;
}

/* Owners change a link's password (a fresh seal of the same secret) or expiry; the link stays the same. */
export async function updateLink(
    userId: string,
    workspaceId: string,
    linkId: string,
    input: {
        keyEpoch: number;
        seal?: {
            linkEnvelope: string;
            linkSalt: string;
            hasPassword: boolean;
            secretEnvelope?: string;
        };
        expiresAt?: string | null;
    },
) {
    await requireMember(userId, workspaceId);
    const result = await driveRepository.updateLink({
        workspaceId,
        linkId,
        keyEpoch: input.keyEpoch,
        seal: input.seal
            ? {
                  linkEnvelope: decodeEnvelope(input.seal.linkEnvelope, 72),
                  linkSalt: decodeEnvelope(input.seal.linkSalt, 16),
                  hasPassword: input.seal.hasPassword,
                  ...(input.seal.secretEnvelope
                      ? { secretEnvelope: linkSecretEnvelope(input.seal.secretEnvelope) }
                      : {}),
              }
            : undefined,
        expiresAt: input.expiresAt === undefined ? undefined : linkExpiry(input.expiresAt),
    });
    switch (result.status) {
        case 'not-found':
            throw new DriveError('not-found', 'This link no longer exists.', 404);
        case 'stale':
            throw stale();
        case 'ok':
            return { link: linkView(result.link) };
    }
}

export async function listNodeLinks(userId: string, workspaceId: string, nodeId: string) {
    await requireMember(userId, workspaceId);
    return { links: (await driveRepository.listNodeLinks(workspaceId, nodeId)).map(linkView) };
}

export async function revokeLink(userId: string, workspaceId: string, linkId: string) {
    await requireMember(userId, workspaceId);
    const revoked = await driveRepository.revokeLink(workspaceId, linkId);
    if (!revoked) throw new DriveError('not-found', 'This link no longer exists.', 404);
    return { revoked: true };
}

const linkGone = () => new DriveError('not-found', 'This link no longer works.', 404);

/*
 * Every visit is bounded per address and per token: the token is the only
 * secret the server ever sees, and a token cannot be guessed at any useful
 * rate under these limits.
 */
async function limitLink(token: string, address: string) {
    if (!TOKEN_PATTERN.test(token)) throw linkGone();
    if (!(await authRepository.consumeRateLimit(hashToken(`link:address:${address}`), 300, 60_000)))
        throw new DriveError('conflict', 'Too many requests. Please try again shortly.', 429);
    if (!(await authRepository.consumeRateLimit(hashToken(`link:token:${token}`), 120, 60_000)))
        throw new DriveError('conflict', 'Too many requests. Please try again shortly.', 429);
}

/* The linked node with what the visitor's device needs to open it; the secret stays in their URL. */
export async function openLink(token: string, address: string) {
    await limitLink(token, address);
    const resolved = await driveRepository.resolveLink(hashToken(token));
    if (!resolved) throw linkGone();
    void driveRepository.touchLink(resolved.link.id).catch(() => {});
    return {
        link: {
            id: resolved.link.id,
            workspaceId: resolved.link.workspaceId,
            keyEpoch: resolved.link.keyEpoch,
            hasPassword: resolved.link.hasPassword,
            linkSalt: b64(resolved.link.linkSalt),
            linkEnvelope: b64(resolved.link.linkEnvelope),
            expiresAt: resolved.link.expiresAt?.toISOString() ?? null,
        },
        node: nodeView(resolved.node),
    };
}

export async function linkChildren(
    token: string,
    address: string,
    parentId: string,
    after?: string,
) {
    await limitLink(token, address);
    const access = await driveRepository.authorizeLink(hashToken(token), parentId);
    if (!access) throw linkGone();
    const result = await driveRepository.listChildren({
        workspaceId: access.workspaceId,
        parentId,
        after,
        boundary: access.boundary,
    });
    if (result.status !== 'ok') throw linkGone();
    return {
        folder: nodeView(result.folder),
        ancestors: result.ancestors.map(nodeView),
        children: result.children.map(nodeView),
        nextCursor: result.nextCursor,
    };
}

export async function linkDownloadUrl(token: string, address: string, versionId: string) {
    await limitLink(token, address);
    const { workspaceId, allowed } = await driveRepository.authorizeLinkVersions(hashToken(token), [
        versionId,
    ]);
    if (!workspaceId || !allowed.has(versionId)) throw linkGone();
    return presignDownload(workspaceId, versionId, SHARE_URL_TTL_SECONDS);
}

export async function linkDownloadUrls(token: string, address: string, versionIds: string[]) {
    await limitLink(token, address);
    const { workspaceId, allowed } = await driveRepository.authorizeLinkVersions(
        hashToken(token),
        [...new Set(versionIds)].slice(0, THUMBNAIL_BATCH),
    );
    if (!workspaceId) return { urls: [], urlExpiresAt: new Date().toISOString() };
    return presignDownloads(workspaceId, [...allowed], SHARE_URL_TTL_SECONDS);
}

export async function linkThumbnailUrls(token: string, address: string, versionIds: string[]) {
    await limitLink(token, address);
    const { workspaceId, allowed } = await driveRepository.authorizeLinkVersions(
        hashToken(token),
        [...new Set(versionIds)].slice(0, THUMBNAIL_BATCH),
    );
    if (!workspaceId) return { urls: [], urlExpiresAt: new Date().toISOString() };
    const { urls, urlExpiresAt } = await presignObjects(
        workspaceId,
        [...allowed],
        SHARE_URL_TTL_SECONDS,
    );
    return { urls, urlExpiresAt };
}

/* ------------------------------------------------------------------------- */
/* Reports                                                                    */
/* ------------------------------------------------------------------------- */

/*
 * Anyone who can see a node through a link or a share can report it. The
 * reporter's device seals the node key to every operator; the server checks
 * that the reporter really can see the node, bounds how often anyone files,
 * and freezes the subtree. Operators triage from the snapshot, so nothing the
 * owner does afterwards empties a report.
 */

export const REPORT_CATEGORIES = [
    'csam',
    'terrorism',
    'ncii',
    'malware',
    'copyright',
    'harassment',
    'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
const REPORT_ENVELOPE_BYTES = 112;
const REPORTS_PER_HOUR = 20;

type ReportRow =
    Awaited<ReturnType<typeof reportsRepository.getReport>> extends infer R
        ? R extends { report: infer T }
            ? T
            : never
        : never;

function reportView(report: ReportRow, uploaderSuspended = false) {
    return {
        id: report.id,
        workspaceId: report.workspaceId,
        nodeId: report.nodeId,
        nodeKind: report.nodeKind,
        keyEpoch: report.keyEpoch,
        via: (report.linkId ? 'link' : 'share') as 'link' | 'share',
        category: report.category,
        reason: report.reason,
        reporter: { userId: report.reporterUserId, email: report.reporterEmail },
        uploader: {
            userId: report.uploaderUserId,
            email: report.uploaderEmail,
            suspended: uploaderSuspended,
        },
        contentHash: report.contentHash ? report.contentHash.toString('hex') : null,
        status: report.status,
        heldAt: report.heldAt?.toISOString() ?? null,
        evidenceStatus: report.evidenceStatus,
        itemCount: report.itemCount,
        itemsTruncated: report.itemsTruncated,
        filedWith: report.filedWith,
        filedReference: report.filedReference,
        resolvedAt: report.resolvedAt?.toISOString() ?? null,
        createdAt: report.createdAt.toISOString(),
        updatedAt: report.updatedAt.toISOString(),
    };
}
function reportEventView(event: reportsRepository.ReportEventRow) {
    return {
        id: event.id,
        actorUserId: event.actorUserId,
        action: event.action,
        note: event.note,
        createdAt: event.createdAt.toISOString(),
    };
}
function evidenceRequestView(row: reportsRepository.EvidenceRequestRow) {
    return {
        id: row.id,
        status: row.status,
        urls: row.urls ?? null,
        urlExpiresAt: row.urlExpiresAt?.toISOString() ?? null,
        error: row.error,
        createdAt: row.createdAt.toISOString(),
    };
}
/* A snapshot row as the node the client already knows how to open. */
function reportItemView(item: reportsRepository.ReportItemRow, workspaceId: string): NodeView {
    const version: VersionView | null =
        item.versionId && item.objectId && item.contentKeyEnvelope && item.contentNonce
            ? {
                  id: item.versionId,
                  objectId: item.objectId,
                  contentKeyEnvelope: b64(item.contentKeyEnvelope),
                  status: 'ready',
                  objectStatus: 'ready',
                  contentSuite: item.contentSuite ?? CONTENT_SUITE,
                  chunkSize: item.chunkSize ?? CHUNK_SIZE,
                  chunkCount: item.chunkCount ?? 1,
                  contentNonce: b64(item.contentNonce),
                  plaintextSize: item.plaintextSize?.toString() ?? null,
                  ciphertextSize: (item.ciphertextSize ?? 0n).toString(),
                  readyAt: null,
              }
            : null;
    return {
        id: item.nodeId,
        workspaceId,
        parentId: item.parentId,
        kind: item.kind,
        keyEpoch: item.keyEpoch,
        parentKeyEpoch: item.parentKeyEpoch,
        keyEnvelope: b64(item.keyEnvelope),
        prevKeyEnvelope: null,
        prevKeyEpoch: null,
        prevParentKeyEpoch: null,
        metadataVersion: item.metadataVersion,
        metadataEnvelope: b64(item.metadataEnvelope),
        currentVersion: version,
        trashedAt: null,
        changeSeq: null,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.createdAt.toISOString(),
    };
}
const reportGone = () => new DriveError('not-found', 'This report does not exist.', 404);

/* Who a report is sealed to. Empty means this instance takes no reports yet. */
export async function reportOperators() {
    const operators = await reportsRepository.listOperators();
    return {
        operators: operators.map((o) => ({
            userId: o.userId,
            publicKey: b64(o.encryptionPublicKey),
        })),
    };
}

export async function fileReport(
    actor: { userId: string | null; address: string },
    input: {
        id: string;
        workspaceId: string;
        nodeId: string;
        keyEpoch: number;
        category: ReportCategory;
        reason: string;
        via: { link: string } | { share: true };
        reporterEmail: string | null;
        contentHash: string | null;
        keys: { operatorUserId: string; keyEnvelope: string }[];
    },
) {
    const limits = [hashToken(`report:address:${actor.address}`)];
    if (actor.userId) limits.push(hashToken(`report:user:${actor.userId}`));
    for (const key of limits)
        if (!(await authRepository.consumeRateLimit(key, REPORTS_PER_HOUR, 3600_000)))
            throw new DriveError('conflict', 'Too many reports. Please try again later.', 429);

    let linkId: string | null = null;
    let shareId: string | null = null;
    if ('link' in input.via) {
        if (!TOKEN_PATTERN.test(input.via.link)) throw linkGone();
        const access = await driveRepository.authorizeLink(hashToken(input.via.link), input.nodeId);
        if (!access || access.workspaceId !== input.workspaceId) throw linkGone();
        linkId = access.linkId;
    } else {
        if (!actor.userId) throw new DriveError('forbidden', 'Sign in to report this.', 403);
        const access = await driveRepository.authorize(
            actor.userId,
            input.workspaceId,
            input.nodeId,
        );
        if (!access) throw notFound();
        if (access.role === 'owner')
            throw new DriveError('invalid', 'You cannot report your own files.', 409);
        shareId = access.shareId;
    }
    const reason = input.reason.trim();
    if (!reason) throw new DriveError('invalid', 'Say what is wrong with it.');
    const result = await reportsRepository.createReport({
        id: input.id,
        workspaceId: input.workspaceId,
        nodeId: input.nodeId,
        keyEpoch: input.keyEpoch,
        linkId,
        shareId,
        category: input.category,
        reason,
        reporterUserId: actor.userId,
        reporterEmail: actor.userId ? null : input.reporterEmail?.trim() || null,
        reporterAddressHash: actor.userId ? null : hashToken(`report:address:${actor.address}`),
        contentHash: input.contentHash ? decodeEnvelope(input.contentHash, 32) : null,
        keys: input.keys.map((key) => ({
            operatorUserId: key.operatorUserId,
            keyEnvelope: decodeEnvelope(key.keyEnvelope, REPORT_ENVELOPE_BYTES),
        })),
    });
    switch (result.status) {
        case 'not-found':
            throw notFound();
        case 'stale':
            throw stale();
        case 'operators-changed':
            throw new DriveError(
                'stale',
                'The operators of this instance changed while you were writing. Please try again.',
                409,
            );
        case 'duplicate':
            return { report: { id: result.reportId }, duplicate: true };
        case 'ok':
            return { report: { id: result.report.id }, duplicate: false };
    }
}

/* The operator's side. Every function takes an operator the caller has already checked. */

export async function listReports(filter: {
    status?: 'open' | 'dismissed' | 'removed' | 'filed' | 'all';
    category?: ReportCategory;
}) {
    const [reports, counts] = await Promise.all([
        // A query with the field absent can arrive as an empty string: both mean the default.
        reportsRepository.listReports({
            status: filter.status || 'open',
            category: filter.category || undefined,
        }),
        reportsRepository.countReports(),
    ]);
    return { reports: reports.map((row) => reportView(row)), counts };
}

async function loadReport(reportId: string) {
    const found = await reportsRepository.getReport(reportId);
    if (!found) throw reportGone();
    return found;
}

export async function getReport(reportId: string) {
    const found = await loadReport(reportId);
    return {
        report: reportView(found.report, Boolean(found.uploader?.suspendedAt)),
        events: found.events.map(reportEventView),
    };
}

/* Hands the operator their sealed key and the reported node; every open is on the record. */
export async function openReport(operatorUserId: string, reportId: string) {
    const found = await loadReport(reportId);
    const item = await reportsRepository.getReportItem(reportId, found.report.nodeId);
    if (!item) throw reportGone();
    const keyEnvelope = await reportsRepository.getReportKey(reportId, operatorUserId);
    await reportsRepository.addReportEvent(reportId, operatorUserId, 'viewed');
    return {
        report: reportView(found.report, Boolean(found.uploader?.suspendedAt)),
        node: reportItemView(item, found.report.workspaceId),
        keyEnvelope: keyEnvelope ? b64(keyEnvelope) : null,
    };
}

export async function reportChildren(reportId: string, parentId: string) {
    const found = await loadReport(reportId);
    const listing = await reportsRepository.listReportChildren(reportId, parentId);
    if (!listing) throw notFound();
    const ws = found.report.workspaceId;
    return {
        folder: reportItemView(listing.folder, ws),
        ancestors: listing.ancestors.map((row) => reportItemView(row, ws)),
        children: listing.children.map((row) => reportItemView(row, ws)),
        nextCursor: null,
    };
}

/*
 * URLs for reported bytes, from the primary store, where the hold keeps them
 * while the report is open or held. Once released and drained there is nothing
 * to show; the evidence copy, when one was made, is the worker's to reach.
 */
export async function reportDownloadUrls(reportId: string, versionIds: string[]) {
    await loadReport(reportId);
    const items = await reportsRepository.getReportVersions(
        reportId,
        [...new Set(versionIds)].slice(0, THUMBNAIL_BATCH),
    );
    const store = primaryStore();
    const urls = await Promise.all(
        items.map(async (item) => ({
            versionId: item.versionId!,
            url: await store.presignGet(item.objectKey!, SHARE_URL_TTL_SECONDS),
        })),
    );
    return {
        urls,
        urlExpiresAt: new Date(Date.now() + SHARE_URL_TTL_SECONDS * 1000).toISOString(),
    };
}

export async function reportDownloadUrl(reportId: string, versionId: string) {
    const found = await loadReport(reportId);
    const [item] = await reportsRepository.getReportVersions(reportId, [versionId]);
    if (!item) throw notFound();
    // Presigned whether or not the primary copy is still there: once a released hold has
    // drained it, the page reads the evidence copy through a worker-answered request instead.
    const node = reportItemView(item, found.report.workspaceId);
    return {
        url: await primaryStore().presignGet(item.objectKey!, SHARE_URL_TTL_SECONDS),
        urlExpiresAt: new Date(Date.now() + SHARE_URL_TTL_SECONDS * 1000).toISOString(),
        node,
        version: node.currentVersion!,
    };
}

/* The same presigned objects as a download: the trailer, when there is one, is inside. */
export async function reportThumbnailUrls(reportId: string, versionIds: string[]) {
    return reportDownloadUrls(reportId, versionIds);
}

/*
 * The evidence copy, through the worker: the web service holds no credentials
 * for that bucket, so it records the request and the worker answers it with
 * presigned URLs the page then reads directly.
 */
export async function requestEvidence(operatorUserId: string, reportId: string) {
    const result = await reportsRepository.createEvidenceRequest(reportId, operatorUserId);
    switch (result.status) {
        case 'not-found':
            throw reportGone();
        case 'no-evidence':
            throw new DriveError(
                'conflict',
                result.evidenceStatus === 'skipped'
                    ? 'No evidence store is configured on this instance, so there is no copy to fetch.'
                    : result.evidenceStatus === 'purged'
                      ? 'The evidence copy was deleted when this report was dismissed without a hold.'
                      : 'The evidence copy is not complete yet. Try again in a few minutes.',
                409,
            );
        case 'ok':
            return { request: evidenceRequestView(result.request) };
    }
}
export async function getEvidenceRequest(reportId: string, requestId: string) {
    const row = await reportsRepository.getEvidenceRequest(reportId, requestId);
    if (!row) throw notFound();
    return { request: evidenceRequestView(row) };
}

export async function reportKeyHolders(reportId: string) {
    await loadReport(reportId);
    const holders = await reportsRepository.listReportKeyHolders(reportId);
    return {
        operators: holders.map((o) => ({
            userId: o.userId,
            publicKey: b64(o.encryptionPublicKey),
            sealed: o.sealed,
        })),
    };
}

/* An operator who opened the report seals its key to the operators who cannot open it yet. */
export async function resealReport(
    operatorUserId: string,
    reportId: string,
    keys: { operatorUserId: string; keyEnvelope: string }[],
) {
    const result = await reportsRepository.addReportKeys(
        reportId,
        operatorUserId,
        keys.map((key) => ({
            operatorUserId: key.operatorUserId,
            keyEnvelope: decodeEnvelope(key.keyEnvelope, REPORT_ENVELOPE_BYTES),
        })),
    );
    if (result.status !== 'ok') throw reportGone();
    return { added: result.added };
}

export async function recordPacket(operatorUserId: string, reportId: string) {
    await loadReport(reportId);
    const event = await reportsRepository.addReportEvent(reportId, operatorUserId, 'packet');
    return { event: reportEventView(event) };
}

export type ReportResolution =
    | { status: 'dismissed'; hold: boolean }
    | { status: 'removed'; hold: boolean }
    | { status: 'filed'; filedWith: string; filedReference: string | null };

/* Closes a report. Removal takes the content down first: trashed, unrestorable, every share and link on it revoked. */
export async function resolveReport(
    operatorUserId: string,
    reportId: string,
    resolution: ReportResolution,
) {
    const found = await loadReport(reportId);
    if (resolution.status === 'removed') {
        const removed = await driveRepository.removeNode({
            workspaceId: found.report.workspaceId,
            nodeId: found.report.nodeId,
        });
        await reportsRepository.addReportEvent(
            reportId,
            operatorUserId,
            'content-removed',
            removed.status === 'ok'
                ? `${removed.shares} shares and ${removed.links} links revoked`
                : 'already gone',
        );
    }
    const result = await reportsRepository.resolveReport(reportId, operatorUserId, resolution);
    if (result.status !== 'ok') throw reportGone();
    return { report: reportView(result.report, Boolean(found.uploader?.suspendedAt)) };
}

export async function holdReport(operatorUserId: string, reportId: string, held: boolean) {
    const found = await loadReport(reportId);
    const report = await reportsRepository.setReportHold(reportId, operatorUserId, held);
    if (!report) throw reportGone();
    return { report: reportView(report, Boolean(found.uploader?.suspendedAt)) };
}

export async function reopenReport(operatorUserId: string, reportId: string) {
    const found = await loadReport(reportId);
    const report = await reportsRepository.reopenReport(reportId, operatorUserId);
    if (!report) throw reportGone();
    return { report: reportView(report, Boolean(found.uploader?.suspendedAt)) };
}

/* Suspends or reinstates whoever owns the reported workspace; their sessions end at once. */
export async function suspendUploader(
    operatorUserId: string,
    reportId: string,
    suspended: boolean,
) {
    const found = await loadReport(reportId);
    if (!found.report.uploaderUserId)
        throw new DriveError('conflict', 'This report has no uploader on record.', 409);
    if (found.report.uploaderUserId === operatorUserId)
        throw new DriveError('invalid', 'You cannot suspend yourself.', 409);
    const result = await authRepository.setUserSuspended(found.report.uploaderUserId, suspended);
    if (!result) throw new DriveError('conflict', 'The uploader’s account no longer exists.', 409);
    await reportsRepository.addReportEvent(
        reportId,
        operatorUserId,
        suspended ? 'uploader-suspended' : 'uploader-reinstated',
    );
    return { report: reportView(found.report, suspended) };
}

export async function noteReport(operatorUserId: string, reportId: string, note: string) {
    await loadReport(reportId);
    const trimmed = note.trim();
    if (!trimmed) throw new DriveError('invalid', 'Write something first.');
    const event = await reportsRepository.addReportEvent(reportId, operatorUserId, 'note', trimmed);
    return { event: reportEventView(event) };
}

/* ------------------------------------------------------------------------- */
/* Rotation                                                                   */
/* ------------------------------------------------------------------------- */

/*
 * A member rotates a subtree's keys after a revocation. The server allocates
 * the target epoch, hands out work in parent-first batches, applies what the
 * device sealed, and closes the rotation when nothing is left; the device
 * does every bit of cryptography. Anyone else in the workspace's tree sees
 * only the usual staleness refusals until it is over.
 */

type RotationWorkRow = rotationsRepository.RotationWorkNode;

function rotationWorkView(row: RotationWorkRow) {
    return {
        ...nodeView(row),
        depth: row.depth,
        versions: row.versions.map((v) => ({
            id: v.id,
            objectId: v.objectId,
            contentKeyEnvelope: b64(v.contentKeyEnvelope),
            contentSuite: v.contentSuite,
            plaintextSize: v.plaintextSize?.toString() ?? null,
        })),
        shares: row.shares.map((share) => ({
            id: share.id,
            granteeUserId: share.granteeUserId,
            granteePublicKey: b64(share.granteePublicKey),
        })),
        links: row.links.map((link) => ({
            id: link.id,
            hasPassword: link.hasPassword,
            secretEnvelope: link.secretEnvelope ? b64(link.secretEnvelope) : null,
        })),
    };
}
const noRotation = () => new DriveError('not-found', 'No rotation is running here.', 404);

export async function startRotation(userId: string, workspaceId: string, nodeId: string) {
    await requireMember(userId, workspaceId);
    const result = await rotationsRepository.startRotation({
        workspaceId,
        nodeId,
        startedBy: userId,
    });
    switch (result.status) {
        case 'not-found':
            throw notFound();
        case 'active':
            if (result.rotation.nodeId === nodeId)
                return {
                    rotation: {
                        nodeId: result.rotation.nodeId,
                        targetEpoch: result.rotation.targetEpoch,
                    },
                };
            throw new DriveError(
                'rotating',
                'Another rotation is still running in this workspace. Let it finish first.',
                409,
            );
        case 'ok':
            return {
                rotation: {
                    nodeId: result.rotation.nodeId,
                    targetEpoch: result.rotation.targetEpoch,
                },
            };
    }
}

const CURSOR = /^(\d{1,3}):([0-9a-f-]{36})$/;

export async function rotationWork(
    userId: string,
    workspaceId: string,
    nodeId: string,
    after?: string | null,
) {
    await requireMember(userId, workspaceId);
    const rotation = await rotationsRepository.getRotation(workspaceId, nodeId);
    if (!rotation) throw noRotation();
    const cursor = after ? CURSOR.exec(after) : null;
    if (after && !cursor) throw new DriveError('invalid', 'Invalid cursor.');
    const view = { nodeId: rotation.nodeId, targetEpoch: rotation.targetEpoch };
    const work = await rotationsRepository.listRotationWork({
        workspaceId,
        rootId: nodeId,
        targetEpoch: rotation.targetEpoch,
        after: cursor ? { depth: Number(cursor[1]), id: cursor[2]! } : null,
    });
    if (!work.nodes.length && !after) {
        const finished = await rotationsRepository.finishRotation({
            workspaceId,
            rootId: nodeId,
            targetEpoch: rotation.targetEpoch,
        });
        return { rotation: view, nodes: [], nextCursor: null, done: finished };
    }
    return {
        rotation: view,
        nodes: work.nodes.map(rotationWorkView),
        nextCursor: work.nextCursor ? `${work.nextCursor.depth}:${work.nextCursor.id}` : null,
        done: false,
    };
}

export async function rotateNodes(
    userId: string,
    workspaceId: string,
    nodeId: string,
    nodes: {
        id: string;
        changeSeq: number;
        parentKeyEpoch: number;
        keyEnvelope: string;
        rotated: {
            metadataEnvelope: string;
            versions: { id: string; contentKeyEnvelope: string }[];
            shares: { id: string; shareEnvelope: string }[];
            links: { id: string; linkEnvelope: string; secretEnvelope: string }[];
            unsealableLinks: string[];
        } | null;
    }[],
) {
    await requireMember(userId, workspaceId);
    const rotation = await rotationsRepository.getRotation(workspaceId, nodeId);
    if (!rotation) throw noRotation();
    const results = await rotationsRepository.rotateNodes({
        workspaceId,
        rootId: nodeId,
        targetEpoch: rotation.targetEpoch,
        nodes: nodes.map((node) => ({
            id: node.id,
            changeSeq: node.changeSeq,
            parentKeyEpoch: node.parentKeyEpoch,
            keyEnvelope: keyEnvelope(node.keyEnvelope),
            rotated: node.rotated
                ? {
                      metadataEnvelope: metadataEnvelope(node.rotated.metadataEnvelope),
                      versions: node.rotated.versions.map((v) => ({
                          id: v.id,
                          // Resealed in the object's own suite: 72 bytes for suite 1, 84 for suite 2.
                          contentKeyEnvelope: anyVersionEnvelope(v.contentKeyEnvelope),
                      })),
                      shares: node.rotated.shares.map((share) => ({
                          id: share.id,
                          shareEnvelope: decodeEnvelope(share.shareEnvelope, 72),
                      })),
                      links: node.rotated.links.map((link) => ({
                          id: link.id,
                          linkEnvelope: decodeEnvelope(link.linkEnvelope, 72),
                          secretEnvelope: linkSecretEnvelope(link.secretEnvelope),
                      })),
                      unsealableLinks: node.rotated.unsealableLinks,
                  }
                : null,
        })),
    });
    return { results };
}

/* ------------------------------------------------------------------------- */
/* Change feeds                                                               */
/* ------------------------------------------------------------------------- */

type ChangeRow = Awaited<ReturnType<typeof driveRepository.listChanges>>['changes'][number];
function changeView(change: ChangeRow) {
    switch (change.kind) {
        case 'node':
            return {
                kind: 'node' as const,
                changeSeq: change.changeSeq,
                node: nodeView(change.node),
            };
        case 'tombstone':
            return {
                kind: 'tombstone' as const,
                changeSeq: change.changeSeq,
                nodeId: change.nodeId,
                parentId: change.parentId,
            };
        default:
            return { kind: change.kind, changeSeq: change.changeSeq, nodeId: change.nodeId };
    }
}

export async function changes(userId: string, workspaceId: string, since: number, limit?: number) {
    await requireMember(userId, workspaceId);
    const page = await driveRepository.listChanges({ workspaceId, since, limit });
    return {
        changes: page.changes.map(changeView),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
    };
}

/* A grantee follows a share; once it is revoked the feed is gone, and says so with 410. */
export async function shareChanges(userId: string, shareId: string, since: number) {
    const page = await driveRepository.listShareChanges({ shareId, granteeUserId: userId, since });
    switch (page.status) {
        case 'not-found':
            throw new DriveError('not-found', 'This share no longer exists.', 404);
        case 'revoked':
            throw new DriveError('expired', 'This share has ended.', 410);
        case 'ok':
            return {
                changes: page.changes.map(changeView),
                nextCursor: page.nextCursor,
                hasMore: page.hasMore,
            };
    }
}
