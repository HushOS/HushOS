import type {
    CryptoRequests,
    CryptoResults,
    DriveContentInfo,
    DriveVersionEnvelope,
    NodeMetadata,
} from '@hushos/crypto';
import { checkName } from '@hushos/crypto/drive';
import {
    DriveApiError,
    type DriveApi,
    type LinkApi,
    type LinkView,
    type NodeView,
    type ReportApi,
    type ReportCategory,
    type SharedWithMeView,
    type ShareRole,
    type VersionListView,
    type VersionView,
    type WorkspaceView,
} from './api';
import { MAX_FOLDER_BATCH, ROOT_NAME } from './protocol';

/*
 * Browser orchestration for Drive. Keys live in the crypto worker and are reached
 * through the auth client's RPC, so this module never sees one; it turns server
 * rows into nodes with names by asking the worker to open them, parents first,
 * and turns a person's intent into the envelopes the server stores.
 */

export type RpcOptions = {
    onProgress?: (progress: unknown) => void;
    idleTimeoutMs?: number;
};
export type Rpc = <K extends keyof CryptoRequests>(
    operation: K,
    input: CryptoRequests[K],
    options?: RpcOptions,
) => Promise<CryptoResults[K]>;

export type DriveNode = NodeView & {
    metadata: NodeMetadata | null;
    name: string;
    /*
     * What the current version's envelope says about its bytes: the file's size
     * and the length of its thumbnail trailer. Null for a folder, a file with no
     * version, or a version whose envelope would not open here.
     */
    content: DriveContentInfo | null;
    /* Set when the item could not be opened on this device; the row still renders. */
    openError: string | null;
};

/* The version as the worker wants it: envelope, suite, and suite 1's row size. */
export function versionEnvelopeOf(version: VersionView): DriveVersionEnvelope {
    return {
        id: version.id,
        objectId: version.objectId,
        contentKeyEnvelope: version.contentKeyEnvelope,
        contentSuite: version.contentSuite,
        plaintextSize: version.plaintextSize === null ? null : Number(version.plaintextSize),
    };
}

/* A file's size in bytes: the envelope's word where it opened, else suite 1's row. */
export function contentSize(node: Pick<DriveNode, 'content' | 'currentVersion'>) {
    if (node.content) return node.content.plaintextSize;
    const size = node.currentVersion?.plaintextSize;
    return size == null ? null : Number(size);
}

export type FolderListing = {
    folder: DriveNode;
    ancestors: DriveNode[];
    children: DriveNode[];
};

export type TrashItem = { node: DriveNode; ancestors: DriveNode[]; parentTrashed: boolean };

export { checkName };

export function splitPath(input: string) {
    return input
        .split('/')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}

export type Granter = { id: string; name: string; email: string; encryptionPublicKey: string };
export type DriveClientOptions = {
    /* The no-session surface for link visitors; without it, links cannot be opened here. */
    linkApi?: LinkApi;
    /* The operator's surface for reports; without it, reports cannot be opened here. */
    reportApi?: ReportApi;
    /*
     * Decides which identity key a share's granter is trusted with: the pinned
     * one, or the served one on first use. Throws to refuse (a key that changed
     * since it was pinned). Without it, shares received cannot be opened.
     */
    trustGranter?: (granter: Granter) => Promise<string>;
};

export type ShareMount = SharedWithMeView & { node: DriveNode; error: string | null };

export function createDriveClient(rpc: Rpc, api: DriveApi, options: DriveClientOptions = {}) {
    let workspace: WorkspaceView | undefined;
    let opening: Promise<{ workspaceId: string; root: NodeView; changeSeq: number }> | undefined;
    /* Nodes whose keys the worker holds since the workspace was last opened. */
    const openedNodes = new Set<string>();
    /* Which workspace each node seen so far belongs to: one's own, or a share's owner's. */
    const workspaceOf = new Map<string, string>();
    let mounts: Promise<ShareMount[]> | undefined;
    let currentUserId: string | null = null;
    /* The workspace behind the link or report opened last: what a node this client has not listed resolves to. */
    let guestWorkspaceId: string | null = null;

    function workspaceId() {
        if (!workspace) throw new Error('Open Drive first.');
        return workspace.workspaceId;
    }
    /* The workspace a node lives in, as far as this client has seen; one's own by default. */
    function workspaceFor(nodeId: string) {
        const known = workspaceOf.get(nodeId);
        if (known) return known;
        if (!workspace && guestWorkspaceId) return guestWorkspaceId;
        return workspaceId();
    }
    function remember(nodes: { id: string; workspaceId: string }[]) {
        for (const node of nodes) workspaceOf.set(node.id, node.workspaceId);
    }
    /* The parent the worker wraps under: the workspace itself for the root. */
    function parentRef(node: Pick<NodeView, 'parentId' | 'workspaceId'>) {
        return node.parentId ?? node.workspaceId;
    }

    /* Opens node keys and metadata in the worker. Callers pass parents before children. */
    async function decorate(nodes: NodeView[]): Promise<DriveNode[]> {
        if (!nodes.length) return [];
        remember(nodes);
        const { nodes: opened } = await rpc('driveOpenNodes', {
            workspaceId: nodes[0]!.workspaceId,
            nodes: nodes.map((node) => ({
                id: node.id,
                parentId: parentRef(node),
                parentKeyEpoch: node.parentKeyEpoch,
                keyEpoch: node.keyEpoch,
                keyEnvelope: node.keyEnvelope,
                metadataVersion: node.metadataVersion,
                metadataEnvelope: node.metadataEnvelope,
                prevKeyEnvelope: node.prevKeyEnvelope,
                prevKeyEpoch: node.prevKeyEpoch,
                prevParentKeyEpoch: node.prevParentKeyEpoch,
                version: node.currentVersion ? versionEnvelopeOf(node.currentVersion) : null,
            })),
        });
        return nodes.map((node, index) => {
            const result = opened[index]!;
            if (!result.error) openedNodes.add(node.id);
            const metadata = result.metadata ?? null;
            return {
                ...node,
                metadata,
                content: result.content ?? null,
                name: metadata?.name ?? (node.parentId === null ? ROOT_NAME : 'Unreadable item'),
                openError: result.error ?? null,
            };
        });
    }

    /*
     * Loads the workspace, opens its key in the worker and makes sure the root
     * exists. The root is created on first open, in the request that stores its
     * envelope; a race with another tab is settled by the server, which returns
     * the root that won.
     */
    function open(userId: string) {
        currentUserId = userId;
        opening ??= (async () => {
            const view = await api.workspace();
            if (!view.grant)
                throw new Error('This account has no workspace key yet. Finish account setup.');
            workspace = view;
            await rpc('driveOpenWorkspace', { userId, grant: view.grant });
            let root = view.root;
            if (!root) {
                const { from } = await api.allocateEpochs(view.workspaceId, 1);
                const id = crypto.randomUUID();
                const { nodes } = await rpc('driveCreateNodes', {
                    workspaceId: view.workspaceId,
                    nodes: [
                        {
                            id,
                            parentId: view.workspaceId,
                            parentKeyEpoch: view.grant.workspaceKeyVersion,
                            keyEpoch: from,
                            metadata: { name: ROOT_NAME, mime: null, size: null, modified: null },
                        },
                    ],
                });
                const result = await api.createRoot(view.workspaceId, {
                    id,
                    keyEpoch: from,
                    parentKeyEpoch: view.grant.workspaceKeyVersion,
                    keyEnvelope: nodes[0]!.keyEnvelope,
                    metadataEnvelope: nodes[0]!.metadataEnvelope,
                });
                root = result.root;
                workspace = { ...view, root };
            }
            return { workspaceId: view.workspaceId, root, changeSeq: view.changeSeq };
        })().catch((error: unknown) => {
            opening = undefined;
            throw error;
        });
        return opening;
    }

    /* A page of a folder, with every ancestor opened so the chain of keys is complete. */
    async function listFolder(folderId: string): Promise<FolderListing> {
        let ws = workspaceFor(folderId);
        const children: NodeView[] = [];
        let first: Awaited<ReturnType<DriveApi['children']>> | undefined;
        let cursor: string | undefined;
        try {
            do {
                const page = await api.children(ws, folderId, cursor);
                first ??= page;
                children.push(...page.children);
                cursor = page.nextCursor ?? undefined;
            } while (cursor);
        } catch (error) {
            // A folder this client has not seen (a deep link into a share): mount the
            // shares, which opens their keys, and try each owner's workspace.
            if (!(error instanceof DriveApiError) || error.status !== 404 || first) throw error;
            const candidates = new Set(
                (await mountShares()).map((mount) => mount.workspaceId).filter((id) => id !== ws),
            );
            let found: Awaited<ReturnType<DriveApi['children']>> | undefined;
            for (const candidate of candidates) {
                found = await api.children(candidate, folderId).catch(() => undefined);
                if (found) {
                    ws = candidate;
                    break;
                }
            }
            if (!found) throw error;
            first = found;
            children.push(...found.children);
            cursor = found.nextCursor ?? undefined;
            while (cursor) {
                const page = await api.children(ws, folderId, cursor);
                children.push(...page.children);
                cursor = page.nextCursor ?? undefined;
            }
        }
        const chain = await decorate([...first!.ancestors, first!.folder]);
        const folder = chain.at(-1)!;
        const opened = await decorate(children);
        return { folder, ancestors: chain.slice(0, -1), children: opened };
    }

    /*
     * Creates a chain of folders under `parent`: ["one", "two", "three"] becomes
     * one/two/three in a single request, each wrapped under the one before it.
     */
    async function createFolderPath(parent: DriveNode, path: string[]) {
        const ws = parent.workspaceId;
        const names = path.map((name) => checkName(name));
        if (names.length < 1) throw new Error('Enter a folder name.');
        if (names.length > MAX_FOLDER_BATCH)
            throw new Error(`Create at most ${MAX_FOLDER_BATCH} folders at a time.`);
        const { from } = await api.allocateEpochs(ws, names.length);
        const specs = names.map((name, index) => ({
            id: crypto.randomUUID(),
            keyEpoch: from + index,
            name,
        }));
        const { nodes } = await rpc('driveCreateNodes', {
            workspaceId: ws,
            nodes: specs.map((spec, index) => ({
                id: spec.id,
                parentId: index === 0 ? parent.id : specs[index - 1]!.id,
                parentKeyEpoch: index === 0 ? parent.keyEpoch : specs[index - 1]!.keyEpoch,
                keyEpoch: spec.keyEpoch,
                metadata: { name: spec.name, mime: null, size: null, modified: null },
            })),
        });
        const created = await api.createFolders(
            ws,
            specs.map((spec, index) => ({
                id: spec.id,
                parentId: index === 0 ? parent.id : specs[index - 1]!.id,
                parentKeyEpoch: index === 0 ? parent.keyEpoch : specs[index - 1]!.keyEpoch,
                keyEpoch: spec.keyEpoch,
                keyEnvelope: nodes[index]!.keyEnvelope,
                metadataEnvelope: nodes[index]!.metadataEnvelope,
            })),
        );
        return decorate(created.nodes);
    }

    async function rename(node: DriveNode, name: string) {
        const ws = node.workspaceId;
        const clean = checkName(name);
        const { metadataEnvelope } = await rpc('driveSealMetadata', {
            workspaceId: ws,
            nodeId: node.id,
            metadataVersion: node.metadataVersion + 1,
            metadata: {
                ...(node.metadata ?? { mime: null, size: null, modified: null }),
                name: clean,
            },
        });
        const result = await api.rename(ws, node.id, {
            metadataVersion: node.metadataVersion,
            keyEpoch: node.keyEpoch,
            metadataEnvelope,
        });
        return (await decorate([result.node]))[0]!;
    }

    /* Moves one node under `destination`, whose key must already be open. */
    async function move(node: DriveNode, destination: DriveNode) {
        const ws = node.workspaceId;
        const { keyEnvelope } = await rpc('driveRewrapNode', {
            workspaceId: ws,
            nodeId: node.id,
            parentId: destination.id,
            parentKeyEpoch: destination.keyEpoch,
            keyEpoch: node.keyEpoch,
        });
        const result = await api.move(ws, node.id, {
            parentId: destination.id,
            parentKeyEpoch: destination.keyEpoch,
            keyEnvelope,
        });
        return (await decorate([result.node]))[0]!;
    }

    /*
     * Copies one file into `destination` (whose key is open) under `name`: the
     * worker rewraps the content key under a fresh node key, and the server
     * shares the object. Nothing is downloaded or re-uploaded.
     */
    async function copyFile(node: DriveNode, destination: DriveNode, name: string) {
        const ws = destination.workspaceId;
        const version = node.currentVersion;
        if (node.kind !== 'file' || !version) throw new Error(`“${node.name}” has no content yet.`);
        const { from } = await api.allocateEpochs(ws, 1);
        const id = crypto.randomUUID();
        const versionId = crypto.randomUUID();
        const sealed = await rpc('driveCopyFile', {
            workspaceId: ws,
            source: { nodeId: node.id, ...versionEnvelopeOf(version) },
            node: {
                id,
                parentId: destination.id,
                parentKeyEpoch: destination.keyEpoch,
                keyEpoch: from,
                metadata: {
                    ...(node.metadata ?? { mime: null, size: null, modified: null }),
                    name: checkName(name),
                },
            },
            versionId,
        });
        const result = await api.copy(ws, node.id, {
            sourceVersionId: version.id,
            node: {
                id,
                parentId: destination.id,
                parentKeyEpoch: destination.keyEpoch,
                keyEpoch: from,
                keyEnvelope: sealed.keyEnvelope,
                metadataEnvelope: sealed.metadataEnvelope,
            },
            versionId,
            contentKeyEnvelope: sealed.contentKeyEnvelope,
        });
        return (await decorate([result.node]))[0]!;
    }

    /*
     * Copies a file or a whole folder into `destination`, node by node: the
     * server has no key to rewrap a subtree with, so a folder copy is the
     * client walking it, creating each folder and copying each file, reporting
     * progress as it goes. `name` is what the top item is called at the
     * destination. Returns how many items were made.
     */
    async function copyTree(
        node: DriveNode,
        destination: DriveNode,
        name: string,
        onProgress?: (done: number) => void,
    ) {
        let done = 0;
        const tick = () => onProgress?.(++done);
        if (node.kind === 'file') {
            await copyFile(node, destination, name);
            tick();
            return done;
        }
        const [made] = await createFolderPath(destination, [name]);
        tick();
        const stack: { source: DriveNode; target: DriveNode }[] = [{ source: node, target: made! }];
        while (stack.length) {
            const { source, target } = stack.pop()!;
            const listing = await listFolder(source.id);
            for (const child of listing.children) {
                if (child.kind === 'folder') {
                    const [folder] = await createFolderPath(target, [child.name]);
                    stack.push({ source: child, target: folder! });
                } else if (child.currentVersion) await copyFile(child, target, child.name);
                tick();
            }
        }
        return done;
    }

    /*
     * A file's versions, current first, with sizes and dates. The sizes come
     * from each version's envelope, opened here; a version that will not open
     * lists without one.
     */
    async function versions(node: DriveNode) {
        const listed = (await api.versions(node.workspaceId, node.id)).versions;
        if (!listed.length) return [] as (VersionListView & { content: DriveContentInfo | null })[];
        const { versions: opened } = await rpc('driveOpenVersions', {
            workspaceId: node.workspaceId,
            nodeId: node.id,
            versions: listed.map(versionEnvelopeOf),
        });
        return listed.map((version, index) => {
            const result = opened[index]!;
            return {
                ...version,
                content:
                    result.error !== undefined
                        ? null
                        : {
                              plaintextSize: result.plaintextSize,
                              thumbnailBytes: result.thumbnailBytes,
                          },
            };
        });
    }
    async function restoreVersion(node: DriveNode, versionId: string) {
        const result = await api.restoreVersion(node.workspaceId, versionId);
        return (await decorate([result.node]))[0]!;
    }
    async function discardVersion(node: DriveNode, versionId: string) {
        await api.discardVersion(node.workspaceId, versionId);
    }

    /*
     * Shares. Owners seal a node's key to a contact's identity key with a role;
     * grantees mount what was shared with them as roots of their own, opening
     * each envelope with the granter's key the app has decided to trust.
     */
    async function share(
        node: DriveNode,
        contact: { userId: string; encryptionPublicKey: string },
        role: ShareRole,
    ) {
        if (!currentUserId) throw new Error('Open Drive first.');
        const ws = node.workspaceId;
        const { shareEnvelope } = await rpc('driveSealShare', {
            workspaceId: ws,
            nodeId: node.id,
            keyEpoch: node.keyEpoch,
            granterUserId: currentUserId,
            granteeUserId: contact.userId,
            granteePublicKey: contact.encryptionPublicKey,
        });
        return (
            await api.share(ws, node.id, {
                granteeUserId: contact.userId,
                role,
                keyEpoch: node.keyEpoch,
                shareEnvelope,
            })
        ).share;
    }
    async function nodeShares(node: DriveNode) {
        return (await api.nodeShares(node.workspaceId, node.id)).shares;
    }
    async function revokeShare(node: DriveNode, shareId: string) {
        await api.revokeShare(node.workspaceId, shareId);
    }
    /*
     * Links. Owners mint them (the secret and token are shown once, never
     * stored in the clear anywhere); a visitor opens one with the fragment
     * secret and, when set, the password, with no account at all. The linked
     * node becomes this client's root of that workspace.
     */
    async function createLink(
        node: DriveNode,
        input: { password: string | null; expiresAt: string | null },
    ) {
        const linkId = crypto.randomUUID();
        const sealed = await rpc('driveSealLink', {
            workspaceId: node.workspaceId,
            nodeId: node.id,
            keyEpoch: node.keyEpoch,
            linkId,
            password: input.password,
        });
        // The id, secret and token are sealed on this device; the server stores the
        // token only as a hash and the sealed copy it cannot open.
        const { link } = await api.createLink(node.workspaceId, node.id, {
            linkId,
            token: sealed.token,
            keyEpoch: node.keyEpoch,
            linkEnvelope: sealed.linkEnvelope,
            linkSalt: sealed.salt,
            secretEnvelope: sealed.secretEnvelope,
            hasPassword: input.password !== null,
            expiresAt: input.expiresAt,
        });
        return { link, token: sealed.token, secret: sealed.secret };
    }
    /* The full URL of a link the owner made, from the sealed copy; null for links made before it existed. */
    async function linkUrl(node: DriveNode, link: LinkView, origin: string) {
        if (!link.secretEnvelope) return null;
        const { secret, token } = await rpc('driveLinkSecret', {
            workspaceId: node.workspaceId,
            nodeId: node.id,
            keyEpoch: link.keyEpoch,
            linkId: link.id,
            secretEnvelope: link.secretEnvelope,
        });
        return `${origin}/s/${token}#${secret}`;
    }
    /* Changes a link's password (a fresh seal of the same secret) or its expiry; the URL stays the same. */
    async function updateLink(
        node: DriveNode,
        link: LinkView,
        input: { password?: string | null; expiresAt?: string | null },
    ) {
        let seal:
            | {
                  linkEnvelope: string;
                  linkSalt: string;
                  hasPassword: boolean;
                  secretEnvelope: string;
              }
            | undefined;
        if (input.password !== undefined) {
            if (!link.secretEnvelope)
                throw new Error('This link cannot be changed. Make a new one.');
            const resealed = await rpc('driveResealLink', {
                workspaceId: node.workspaceId,
                nodeId: node.id,
                keyEpoch: link.keyEpoch,
                linkId: link.id,
                secretEnvelope: link.secretEnvelope,
                password: input.password,
            });
            seal = {
                linkEnvelope: resealed.linkEnvelope,
                linkSalt: resealed.salt,
                hasPassword: input.password !== null,
                secretEnvelope: resealed.secretEnvelope,
            };
        }
        return (
            await api.updateLink(node.workspaceId, link.id, {
                keyEpoch: link.keyEpoch,
                seal,
                expiresAt: input.expiresAt,
            })
        ).link;
    }
    async function nodeLinks(node: DriveNode) {
        return (await api.nodeLinks(node.workspaceId, node.id)).links;
    }
    async function revokeLink(node: DriveNode, linkId: string) {
        await api.revokeLink(node.workspaceId, linkId);
    }
    async function openLink(token: string, secret: string, password: string | null) {
        if (!options.linkApi) throw new Error('Links cannot be opened on this client.');
        const opened = await options.linkApi.open(token);
        remember([opened.node]);
        guestWorkspaceId = opened.link.workspaceId;
        await rpc('driveOpenLink', {
            workspaceId: opened.link.workspaceId,
            nodeId: opened.node.id,
            keyEpoch: opened.link.keyEpoch,
            linkId: opened.link.id,
            secret,
            password,
            salt: opened.link.linkSalt,
            linkEnvelope: opened.link.linkEnvelope,
        });
        const [node] = await decorate([opened.node]);
        return { link: opened.link, node: node! };
    }

    /*
     * Reports. Anyone who can see a node seals its key to every operator of the
     * instance on this device and files the report; the server never sees the
     * key. An operator opens a report under their own identity, which must be
     * open in the worker, and the reported subtree then reads like any other.
     */
    async function fileReport(
        node: DriveNode,
        input: {
            category: ReportCategory;
            reason: string;
            via: { link: string } | { share: true };
            reporterEmail: string | null;
            contentHash: string | null;
        },
    ) {
        const { operators } = await api.reportOperators();
        if (!operators.length)
            throw new Error('This instance has no operator yet, so it cannot take reports.');
        const id = crypto.randomUUID();
        const { envelopes } = await rpc('driveSealReport', {
            workspaceId: node.workspaceId,
            nodeId: node.id,
            keyEpoch: node.keyEpoch,
            reportId: id,
            operators,
        });
        return api.report({
            id,
            workspaceId: node.workspaceId,
            nodeId: node.id,
            keyEpoch: node.keyEpoch,
            ...input,
            keys: envelopes.map((e) => ({ operatorUserId: e.userId, keyEnvelope: e.keyEnvelope })),
        });
    }
    async function openReport(reportId: string) {
        if (!options.reportApi) throw new Error('Reports cannot be opened on this client.');
        if (!currentUserId) throw new Error('Open Drive first.');
        const opened = await options.reportApi.open(reportId);
        remember([opened.node]);
        guestWorkspaceId = opened.report.workspaceId;
        if (!opened.keyEnvelope)
            throw new Error(
                'This report was filed before you became an operator, so it was not sealed to you. Another operator can open it.',
            );
        await rpc('driveOpenReport', {
            workspaceId: opened.report.workspaceId,
            nodeId: opened.node.id,
            keyEpoch: opened.node.keyEpoch,
            reportId,
            operatorUserId: currentUserId,
            keyEnvelope: opened.keyEnvelope,
        });
        const [node] = await decorate([opened.node]);
        return { report: opened.report, node: node! };
    }

    /* Seals an opened report's key to the operators who cannot open it yet. */
    async function resealReport(reportId: string, node: DriveNode) {
        if (!options.reportApi) throw new Error('Reports cannot be opened on this client.');
        const { operators } = await options.reportApi.keyHolders(reportId);
        const missing = operators.filter((operator) => !operator.sealed);
        if (!missing.length) return { added: 0 };
        const { envelopes } = await rpc('driveSealReport', {
            workspaceId: node.workspaceId,
            nodeId: node.id,
            keyEpoch: node.keyEpoch,
            reportId,
            operators: missing.map((o) => ({ userId: o.userId, publicKey: o.publicKey })),
        });
        return options.reportApi.reseal(
            reportId,
            envelopes.map((e) => ({ operatorUserId: e.userId, keyEnvelope: e.keyEnvelope })),
        );
    }

    /*
     * Rotation: after a revocation, fresh keys for the node and everything
     * beneath it, in server-sized batches parents first, every version, share
     * and link re-sealed on this device. Survives a reload: the server keeps the
     * work list and previous envelopes, and `resumeRotation` picks it up.
     */
    async function rotate(node: DriveNode, onProgress?: (done: number) => void) {
        const ws = node.workspaceId;
        const { rotation } = await api.startRotation(ws, node.id);
        return runRotation(ws, node.id, rotation.targetEpoch, node.kind, node.parentId, onProgress);
    }
    async function runRotation(
        ws: string,
        rootId: string,
        targetEpoch: number,
        kind: 'folder' | 'file',
        rootParentId: string | null,
        onProgress?: (done: number) => void,
    ) {
        // The root's own chain must be open: its parent key is what the new root key wraps under.
        if (kind === 'folder') await listFolder(rootId);
        else if (rootParentId) await listFolder(rootParentId);
        let done = 0;
        let cursor: string | null = null;
        let idle = 0;
        for (;;) {
            const work = await api.rotationWork(ws, rootId, cursor);
            if (work.done) break;
            if (!work.nodes.length) {
                cursor = null;
                if (++idle > 3) throw new Error('The rotation could not finish. Try again.');
                continue;
            }
            remember(work.nodes);
            // Parents not opened on this device (a resumed rotation, a deep subtree):
            // listing a parent opens it and, mid-rotation, its previous key too.
            const parents = new Set(
                work.nodes.map((n) => n.parentId).filter((id): id is string => id !== null),
            );
            const inBatch = new Set(work.nodes.map((n) => n.id));
            for (const parentId of parents)
                if (!inBatch.has(parentId) && !openedNodes.has(parentId))
                    await listFolder(parentId);
            const sealed = await rpc('driveRotateNodes', {
                workspaceId: ws,
                targetEpoch,
                granterUserId: currentUserId,
                nodes: work.nodes.map((n) => ({
                    id: n.id,
                    parentId: parentRef(n),
                    parentKeyEpoch: n.id === rootId ? n.parentKeyEpoch : targetEpoch,
                    keyEpoch: n.keyEpoch,
                    wrappedParentKeyEpoch: n.parentKeyEpoch,
                    keyEnvelope: n.keyEnvelope,
                    metadataVersion: n.metadataVersion,
                    metadataEnvelope: n.metadataEnvelope,
                    versions: n.versions.map((v) => ({
                        ...v,
                        plaintextSize: v.plaintextSize === null ? null : Number(v.plaintextSize),
                    })),
                    shares: n.shares,
                    links: n.links,
                })),
            });
            const batch = [];
            for (const [index, result] of sealed.nodes.entries()) {
                const source = work.nodes[index]!;
                if (result.error !== undefined) continue;
                batch.push({
                    id: source.id,
                    changeSeq: source.changeSeq ?? 0,
                    parentKeyEpoch: source.id === rootId ? source.parentKeyEpoch : targetEpoch,
                    keyEnvelope: result.keyEnvelope,
                    rotated: result.rewrap
                        ? null
                        : {
                              metadataEnvelope: result.metadataEnvelope,
                              versions: result.versions,
                              shares: result.shares,
                              links: result.links.flatMap((link) =>
                                  'unsealable' in link
                                      ? []
                                      : [
                                            {
                                                id: link.id,
                                                linkEnvelope: link.linkEnvelope,
                                                secretEnvelope: link.secretEnvelope,
                                            },
                                        ],
                              ),
                              unsealableLinks: result.links.flatMap((link) =>
                                  'unsealable' in link ? [link.id] : [],
                              ),
                          },
                });
            }
            let applied = 0;
            if (batch.length) {
                const { results } = await api.rotateNodes(ws, rootId, batch);
                applied = results.filter((r) => r.status === 'ok' || r.status === 'already').length;
            }
            done += applied;
            onProgress?.(done);
            idle = applied ? 0 : idle + 1;
            if (idle > 3) throw new Error('The rotation could not finish. Try again.');
            // Everything applied: continue past the batch; otherwise start over so parents come first.
            cursor = applied === work.nodes.length ? work.nextCursor : null;
        }
        // Envelopes changed under every folder: what this client listed is stale.
        openedNodes.clear();
        return { rotated: done };
    }
    /*
     * Feeds. The workspace feed and each mounted share's feed are polled by the
     * app; this client only turns a page into the folders whose listings are
     * stale and remembers which workspace a changed node belongs to.
     */
    async function changesSince(workspaceId: string, since: number) {
        const page = await api.changes(workspaceId, since);
        for (const change of page.changes) if (change.kind === 'node') remember([change.node]);
        return page;
    }
    async function shareChangesSince(shareId: string, since: number) {
        const page = await api.shareChanges(shareId, since);
        for (const change of page.changes) if (change.kind === 'node') remember([change.node]);
        return page;
    }
    /* A rotation this account left unfinished, from any device; null when none. */
    function pendingRotation() {
        return workspace?.rotation ?? null;
    }
    async function resumeRotation(onProgress?: (done: number) => void) {
        const pending = workspace?.rotation;
        if (!pending || !workspace) return null;
        const root = await api
            .children(workspace.workspaceId, pending.nodeId)
            .then((listing) => listing.folder)
            .catch(() => null);
        // A file root has no listing; its parent's listing names it.
        const kind = root ? ('folder' as const) : ('file' as const);
        let parentId: string | null = root?.parentId ?? null;
        if (!root) {
            const trash = await api.trashListing(workspace.workspaceId).catch(() => null);
            parentId =
                trash?.items.find((item) => item.node.id === pending.nodeId)?.node.parentId ?? null;
        }
        const result = await runRotation(
            workspace.workspaceId,
            pending.nodeId,
            pending.targetEpoch,
            kind,
            parentId,
            onProgress,
        );
        workspace = { ...workspace, rotation: null };
        return result;
    }

    /* What this person shares out, nodes named, for managing in one place. */
    async function mySharing() {
        const mine = await api.sharedByMe();
        const nodes = new Map<string, NodeView>();
        for (const entry of [...mine.shares, ...mine.links]) nodes.set(entry.node.id, entry.node);
        // Names need the folder chain: open each node's parents by listing them once.
        const named = new Map<string, DriveNode>();
        for (const node of nodes.values()) {
            if (node.parentId && !openedNodes.has(node.parentId)) await listFolder(node.parentId);
            const [opened] = await decorate([node]);
            named.set(node.id, opened!);
        }
        return {
            shares: mine.shares.map((share) => ({ ...share, node: named.get(share.node.id)! })),
            links: mine.links.map((link) => ({ ...link, node: named.get(link.node.id)! })),
        };
    }

    /* Everything shared with this person, keys opened; a share whose granter is not trusted is reported, not opened. */
    function mountShares(refresh = false) {
        // Before Drive is open there is no identity to open a share with; a failure
        // this early must not be remembered as the answer.
        if (!currentUserId) return Promise.reject(new Error('Open Drive first.'));
        if (refresh) mounts = undefined;
        mounts ??= (async () => {
            const { shares } = await api.sharedWithMe();
            const granteeUserId = currentUserId;
            const out: ShareMount[] = [];
            for (const received of shares) {
                remember([received.node]);
                let error: string | null = null;
                try {
                    if (!options.trustGranter || !granteeUserId)
                        throw new Error('Shares cannot be opened on this client.');
                    const granterPublicKey = await options.trustGranter(received.granter);
                    await rpc('driveOpenShare', {
                        workspaceId: received.workspaceId,
                        nodeId: received.node.id,
                        keyEpoch: received.keyEpoch,
                        granterUserId: received.granter.id,
                        granterPublicKey,
                        granteeUserId,
                        shareEnvelope: received.shareEnvelope,
                        prevShareEnvelope: received.prevShareEnvelope,
                        prevKeyEpoch: received.prevKeyEpoch,
                    });
                } catch (cause) {
                    error =
                        cause instanceof Error ? cause.message : 'This share could not be opened.';
                }
                const node: DriveNode = error
                    ? {
                          ...received.node,
                          metadata: null,
                          name: 'Shared folder',
                          content: null,
                          openError: error,
                      }
                    : (await decorate([received.node]))[0]!;
                out.push({ ...received, node, error });
            }
            return out;
        })().catch((error: unknown) => {
            mounts = undefined;
            throw error;
        });
        return mounts;
    }

    async function trash(node: DriveNode) {
        const result = await api.trash(node.workspaceId, node.id);
        return (await decorate([result.node]))[0]!;
    }

    /* Restores in place, or to the root when the original parent is itself in the trash. */
    async function restore(node: DriveNode, toRoot?: DriveNode) {
        const ws = node.workspaceId;
        let envelope: { parentKeyEpoch: number; keyEnvelope: string } | undefined;
        if (toRoot) {
            const { keyEnvelope } = await rpc('driveRewrapNode', {
                workspaceId: ws,
                nodeId: node.id,
                parentId: toRoot.id,
                parentKeyEpoch: toRoot.keyEpoch,
                keyEpoch: node.keyEpoch,
            });
            envelope = { parentKeyEpoch: toRoot.keyEpoch, keyEnvelope };
        }
        const result = await api.restore(ws, node.id, envelope);
        return (await decorate([result.node]))[0]!;
    }

    /* Delete forever. The server refuses anything not itself in the trash. */
    async function purge(node: DriveNode) {
        await api.purge(node.workspaceId, node.id);
    }
    /* One batch of the trash; returns how many roots are still waiting. */
    async function emptyTrash() {
        return api.emptyTrash(workspaceId());
    }
    /* What could be freed without losing anything current. */
    async function storageBreakdown() {
        return api.storageBreakdown(workspaceId());
    }
    /* One batch of earlier versions removed; returns how many remain. */
    async function discardSupersededVersions() {
        return api.discardSupersededVersions(workspaceId());
    }

    async function listTrash(): Promise<TrashItem[]> {
        const ws = workspaceId();
        const items: Awaited<ReturnType<DriveApi['trashListing']>>['items'] = [];
        let cursor: string | undefined;
        do {
            const page = await api.trashListing(ws, cursor);
            items.push(...page.items);
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        const out: TrashItem[] = [];
        for (const item of items) {
            const chain = await decorate([...item.ancestors, item.node]);
            out.push({
                node: chain.at(-1)!,
                ancestors: chain.slice(0, -1),
                parentTrashed: item.parentTrashed,
            });
        }
        return out;
    }

    /*
     * The keys behind an item, for its owner to see or save: the node key and,
     * for a file, the current version's content key and nonce, as the worker
     * holds them. The folder must be open on this device, which it is for
     * anything listed.
     */
    async function exportKeys(node: DriveNode) {
        const version = node.kind === 'file' ? node.currentVersion : null;
        return rpc('driveExportKeys', {
            workspaceId: node.workspaceId,
            nodeId: node.id,
            version: version
                ? { ...versionEnvelopeOf(version), contentNonce: version.contentNonce }
                : null,
        });
    }

    /* Opens one node from envelopes the caller kept (the upload journal); parents must be open. */
    async function openNode(node: {
        id: string;
        workspaceId: string;
        parentId: string;
        parentKeyEpoch: number;
        keyEpoch: number;
        keyEnvelope: string;
        metadataVersion: number;
        metadataEnvelope: string;
    }) {
        const { nodes } = await rpc('driveOpenNodes', {
            workspaceId: node.workspaceId,
            nodes: [
                {
                    id: node.id,
                    parentId: node.parentId,
                    parentKeyEpoch: node.parentKeyEpoch,
                    keyEpoch: node.keyEpoch,
                    keyEnvelope: node.keyEnvelope,
                    metadataVersion: node.metadataVersion,
                    metadataEnvelope: node.metadataEnvelope,
                },
            ],
        });
        const opened = nodes[0]!;
        if (opened.error) throw new Error(opened.error);
        return opened.metadata;
    }

    /*
     * Forgets the open workspace, after a lock: the worker has dropped every key,
     * so the next `open` must unwrap them again and every node counts as closed.
     */
    function close() {
        workspace = undefined;
        opening = undefined;
        openedNodes.clear();
        workspaceOf.clear();
        mounts = undefined;
    }

    return {
        open,
        close,
        /* Whether the worker holds this node's key, so a caller can skip re-listing its folder. */
        isOpen: (nodeId: string) => openedNodes.has(nodeId),
        get workspace() {
            return workspace;
        },
        openNode,
        exportKeys,
        listFolder,
        createFolderPath,
        rename,
        move,
        copyFile,
        copyTree,
        versions,
        restoreVersion,
        discardVersion,
        share,
        nodeShares,
        revokeShare,
        mountShares,
        mySharing,
        createLink,
        linkUrl,
        updateLink,
        nodeLinks,
        revokeLink,
        openLink,
        fileReport,
        openReport,
        resealReport,
        rotate,
        resumeRotation,
        pendingRotation,
        changesSince,
        shareChangesSince,
        workspaceFor,
        trash,
        restore,
        purge,
        emptyTrash,
        storageBreakdown,
        discardSupersededVersions,
        listTrash,
        capabilities: () => api.capabilities(),
    };
}

export type DriveClient = ReturnType<typeof createDriveClient>;
