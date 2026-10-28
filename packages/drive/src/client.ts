import type {
    CryptoRequests,
    CryptoResults,
    DriveContentInfo,
    DriveSignedNode,
    DriveSignedVersion,
    DriveSigners,
    DriveVersionEnvelope,
    GroupRotationTrust,
    NodeMetadata,
    ServedRekey,
} from '@hushos/crypto';
import { checkName, DRIVE_ENVELOPE_SUITE } from '@hushos/crypto/drive';
import { newId } from '@hushos/crypto/ids';
import { LINK_KDF_VERSION } from '@hushos/crypto/links';
import { NOT_CARRIED, SHARED_IN_FAMILY } from '@hushos/crypto/protocol';
import { Catalogue, parentsBefore, parentsFirst } from './catalogue';
import type { TreeMirror } from './mirror';
import {
    TAGS_DOCUMENT,
    assign,
    emptyRegistry,
    mergeRegistries,
    parseRegistry,
    serialiseRegistry,
    tagsOf as registryTagsOf,
    type TagRegistry,
} from './tags';
import {
    DriveApiError,
    type DriveApi,
    type LinkApi,
    type LinkView,
    type NodeView,
    type ReportApi,
    type ReportCategory,
    type ServedIdentity,
    type SharedWithMeView,
    type ShareRole,
    type VersionListView,
    type VersionView,
    type WorkspaceView,
    type NodeChange,
    type RekeyView,
} from './api';
import { MAX_FOLDER_BATCH, ROOT_NAME } from './protocol';
import {
    signatureFormFor,
    type NodeIntegrity,
    type RecordIntegrity,
    type RekeyNote,
    type SignatureForm,
} from './trust';

/*
 * Browser orchestration for Drive. Keys live in the crypto worker and are reached
 * through the auth client's RPC, so this module never sees one; it turns server
 * rows into nodes with names by asking the worker to open them, parents first,
 * and turns a person's intent into the envelopes the server stores.
 */

export type RpcOptions = {
    onProgress?: (progress: unknown) => void;
    idleTimeoutMs?: number;
    /* Buffers moved to the worker rather than copied (an in-memory upload's bytes). */
    transfer?: Transferable[];
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
    /*
     * Who wrote the metadata and the current version, checked against the keys
     * this person trusts (see docs/integrity-design.md). Null only where there
     * is nothing to check: a link visitor's view, or an item that would not
     * open. A check that could not run is `unchecked`, never null.
     */
    integrity: NodeIntegrity | null;
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

/* A re-keyed record's origin as the worker takes it: the writer by id. */
export function servedRekeyOf(view: RekeyView | null | undefined): ServedRekey | null {
    if (!view) return null;
    return {
        origin: {
            envelope: view.origin.envelope,
            signerId: view.origin.signer?.id ?? null,
            signature: view.origin.signature,
            keyEnvelope: view.origin.keyEnvelope,
        },
        signature: view.signature,
    };
}

/* A node's signed records as driveVerify takes them; `versions` are the ones to check. */
export function signedNodeOf(node: NodeView, versions: VersionView[]): DriveSignedNode {
    return {
        id: node.id,
        kind: node.kind,
        metadataVersion: node.metadataVersion,
        metadataEnvelope: node.metadataEnvelope,
        // Rows a device mirrored before signatures carry neither field.
        metadataSigner: node.metadataSigner?.id ?? null,
        metadataSignature: node.metadataSignature ?? null,
        keyEpoch: node.keyEpoch,
        metadataRekey: servedRekeyOf(node.metadataRekey),
        versions: versions.map(signedVersionOf),
    };
}
function signedVersionOf(version: VersionView): DriveSignedVersion {
    return {
        id: version.id,
        objectId: version.objectId,
        contentSuite: version.contentSuite,
        contentKeyEnvelope: version.contentKeyEnvelope,
        signer: version.signer?.id ?? null,
        signature: version.signature ?? null,
        rekey: servedRekeyOf(version.rekey),
    };
}

/* A re-keyed record's note, from its served origin and the verifier's second verdict. */
function rekeyNoteOf(
    view: RekeyView | null | undefined,
    by: VersionView['signer'],
    check: RekeyChecked | null | undefined,
): RekeyNote | null {
    // The verifier says whether it read the origin: a family folder's always does (its verdict
    // fails closed itself), and a personal workspace's does not yet (rekeyedFor), so a served
    // origin there is read as shipped apps read the row, by its legacy columns.
    if (!view || !check) return null;
    return {
        writer: view.origin.signer,
        by: by ?? null,
        integrity: check.rekeyer,
        via: check.via ?? null,
        bound: check.bound,
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

/* Where the catalogue build is: pulling the feed into the mirror, opening rows, or done. */
export type CatalogueState = {
    phase: 'idle' | 'pulling' | 'opening' | 'ready' | 'failed';
    pulled: number;
    opened: number;
    error: string | null;
};

export { checkName };
/* The catalogue's parts, reachable from the client entry the app already imports. */
export { createIndexedDbMirror, createMemoryMirror, type TreeMirror } from './mirror';
export { Catalogue, tokenize, type CatalogueHit } from './catalogue';
export * from './tags';

export function splitPath(input: string) {
    return input
        .split('/')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}

export type Granter = SharedWithMeView['granter'];
/*
 * The granter's current Ed25519 and ML-DSA keys, as the person's version 3 pin
 * vouches for them (the ML-DSA key by its digest): the only keys a received
 * share opens with. A share signed with keys the granter has since replaced
 * stays shut until they seal it again.
 */
export type TrustedGranter = {
    signingPublicKey: string;
    mlDsaPublicKey: string;
    /*
     * Set when the pin followed keys the granter has since replaced: a share
     * that will not open under the current key is then most likely one sealed
     * before, waiting for their re-seal, and is said so, by the pin's name.
     */
    replaced?: { name: string };
};
/* A grantee's keys as a pin vouches for them: share suite 4 needs the KEM key. */
export type TrustedGrantee = { encryptionPublicKey: string; kemPublicKey: string | null };
/*
 * Records checked by a verifier other than driveVerify (a family folder's,
 * groupVerify): each node's metadata and versions, with the group whose
 * member list vouched for a verified one (`via`), null otherwise.
 */
export type VerifiedRecords = {
    id: string;
    metadata: RecordIntegrity;
    via: string | null;
    /* A re-keyed record's re-keyer and binding; its own verdict above is its origin's. */
    metadataRekey?: RekeyChecked | null;
    versions: {
        id: string;
        integrity: RecordIntegrity;
        via: string | null;
        rekey?: RekeyChecked | null;
    }[];
}[];
export type RekeyChecked = { rekeyer: RecordIntegrity; via: string | null; bound: boolean | null };
export type DriveClientOptions = {
    /*
     * A workspace whose key the caller has already opened in the worker, and
     * how to read it: a family folder, opened by the family's sync (route
     * 25's area view, groupOpenArea, its root listed). `open` then neither
     * opens a workspace grant nor makes a root: a folder without one cannot
     * be opened here. Without it, `open` loads this account's own workspace.
     */
    view?: () => Promise<WorkspaceView>;
    /*
     * Checks who wrote what is listed, in place of driveVerify against the
     * personal trust set: a family folder's records are judged by the
     * family's member list (groupVerify). It must fail closed, as driveVerify
     * does: a check that throws reads `unchecked`.
     */
    verify?: (workspaceId: string, nodes: DriveSignedNode[]) => Promise<VerifiedRecords>;
    /*
     * Where this device keeps the workspace's tree as the server serves it, so
     * the catalogue (names, tags, search) rebuilds without the network and an
     * interrupted build resumes. Without it there is no catalogue.
     */
    mirror?: TreeMirror;
    /* The no-session surface for link visitors; without it, links cannot be opened here. */
    linkApi?: LinkApi;
    /* The operator's surface for reports; without it, reports cannot be opened here. */
    reportApi?: ReportApi;
    /*
     * Decides which keys a share's granter is trusted with: the pinned ones
     * (followed through a signed succession when the served keys moved on), and
     * only when the served keys match. Throws to refuse (no pin, an unchecked
     * one, or keys that changed). Without it, shares received cannot be opened.
     * `explicit` is the person opening that one share (openShare): only then
     * may it follow a succession or add back someone the person removed;
     * listing what was shared (mountShares) opens only what needs neither.
     */
    trustGranter?: (granter: Granter, how: { explicit: boolean }) => Promise<TrustedGranter>;
    /*
     * Decides which keys a share is sealed to when the server, not the person,
     * names the grantee: on rotation and when re-sealing older shares. Returns
     * the pinned X25519 key and the KEM key the pin vouches for, or null for
     * none; throws to refuse a served key that differs from the pin.
     */
    trustGrantee?: (granteeUserId: string, served: ServedIdentity) => Promise<TrustedGrantee>;
    /*
     * The signing keys this person trusts for other accounts, for checking who
     * wrote what is listed (the worker adds this account's own). When it is
     * missing, or fails to load, every item is `unchecked`; a rotation or copy
     * refuses to run without it.
     */
    signers?: () => Promise<DriveSigners>;
    /*
     * A family folder's trust (groups 1c step 7): every record a rotation or a
     * copy re-signs is judged as the family's member list says, over the
     * committed chain, so a former member's record is re-sealed and never
     * signed as this person's own. The worker refuses either in a family
     * folder without it. It must throw rather than answer with less.
     */
    rotationTrust?: () => Promise<GroupRotationTrust>;
    /*
     * Opens this account's identity in the worker: every write is signed with
     * it. Called by `open` before anything else.
     */
    openIdentity?: (userId: string) => Promise<unknown>;
    /* Grantees whose pin followed a succession: what was shared with them waits to be sealed to their new keys. */
    resealPending?: () => Promise<string[]>;
    /* Called once every share to them was sealed again, so the pin can stop asking for it. */
    resealedTo?: (granteeUserIds: string[]) => Promise<void>;
    /*
     * Whether this account replaced its own keys and has not yet sealed every
     * share again under them (an interrupted Replace sharing keys), and the
     * call that says it is done. The upgrade pass finishes it.
     */
    resealAll?: () => Promise<boolean>;
    resealedAll?: () => Promise<void>;
    /*
     * The owner's own record of what they shared. Without it nothing is ever
     * re-sealed: not on rotation, not when older shares are upgraded.
     */
    ledger?: SharingLedger;
};

/*
 * The owner's own record of what they shared, kept sealed in their settings:
 * the people each node was shared with, and the links they made. The server
 * lists shares and links on every rotation and re-seal, and its list is only a
 * claim: sealing again what it names would hand a node key to anyone it added
 * or revive a share or link the owner stopped. So only what the ledger holds is
 * ever sealed again, and a stop leaves the ledger before it reaches the server.
 */
export type SharingLedger = {
    read(): Promise<{ shares: Record<string, string[]>; links: Record<string, string> }>;
    addShare(nodeId: string, granteeUserId: string): Promise<void>;
    removeShare(nodeId: string, granteeUserId: string): Promise<void>;
    addLink(linkId: string, nodeId: string): Promise<void>;
    removeLink(linkId: string): Promise<void>;
};

/*
 * `unverified`: the share stays shut until its granter can be pinned.
 * `waiting`: it opens when the person opens it (openShare), which may add its
 * granter back or follow their succession; listing never does.
 */
export type ShareMount = SharedWithMeView & {
    node: DriveNode;
    error: string | null;
    unverified: boolean;
    waiting: boolean;
};

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
    /* Workspaces reached through a link: their writers are not this visitor's business, and the server names none. */
    const linkWorkspaces = new Set<string>();

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
        // A suite this client does not know never reaches the worker: the node stays shut.
        // Rows the device mirrored before nodes carried a suite are suite 1.
        const known = nodes.filter(
            (node) => (node.envelopeSuite ?? DRIVE_ENVELOPE_SUITE) === DRIVE_ENVELOPE_SUITE,
        );
        const { nodes: opened } = known.length
            ? await rpc('driveOpenNodes', {
                  workspaceId: nodes[0]!.workspaceId,
                  nodes: known.map((node) => ({
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
              })
            : { nodes: [] };
        const results = new Map(known.map((node, index) => [node, opened[index]!]));
        const checked = await verify(nodes.filter((node) => !results.get(node)?.error));
        return nodes.map((node) => {
            const result = results.get(node) ?? {
                error: 'Made by a newer version of HushOS. Update to open it.',
            };
            if (!result.error) openedNodes.add(node.id);
            const metadata = 'metadata' in result ? (result.metadata ?? null) : null;
            return {
                ...node,
                metadata,
                content: 'content' in result ? (result.content ?? null) : null,
                name: metadata?.name ?? (node.parentId === null ? ROOT_NAME : 'Unreadable item'),
                openError: result.error ?? null,
                integrity: checked.get(node.id) ?? null,
            };
        });
    }

    /*
     * Who wrote each node's metadata and current version, checked in the worker
     * against the keys this person trusts. Nothing is checked for a link
     * visitor. Checking fails closed: without signers, or when loading them or
     * the check fails, every record is `unchecked`, never left unmarked.
     */
    async function verify(nodes: NodeView[]) {
        const out = new Map<string, NodeIntegrity>();
        if (!nodes.length || linkWorkspaces.has(nodes[0]!.workspaceId)) return out;
        try {
            const verified = await checkRecords(
                nodes[0]!.workspaceId,
                nodes.map((node) =>
                    signedNodeOf(node, node.currentVersion ? [node.currentVersion] : []),
                ),
            );
            for (const [index, node] of nodes.entries()) {
                // Matched by id as well as place: a verifier that answers out of order checks nothing.
                const result = verified[index]?.id === node.id ? verified[index] : undefined;
                const version = node.currentVersion
                    ? result?.versions.find((v) => v.id === node.currentVersion!.id)
                    : undefined;
                const rekeyed = {
                    metadata: rekeyNoteOf(
                        node.metadataRekey,
                        node.metadataSigner ?? null,
                        result?.metadataRekey,
                    ),
                    version: node.currentVersion
                        ? rekeyNoteOf(
                              node.currentVersion.rekey,
                              node.currentVersion.signer ?? null,
                              version?.rekey,
                          )
                        : null,
                };
                out.set(node.id, {
                    metadata: result?.metadata ?? 'unchecked',
                    version: node.currentVersion ? (version?.integrity ?? 'unchecked') : null,
                    ...(options.verify
                        ? {
                              via: {
                                  metadata: result?.via ?? null,
                                  version: version?.via ?? null,
                              },
                          }
                        : {}),
                    ...(rekeyed.metadata || rekeyed.version ? { rekeyed } : {}),
                });
            }
        } catch {
            for (const node of nodes)
                out.set(node.id, {
                    metadata: 'unchecked',
                    version: node.currentVersion ? 'unchecked' : null,
                });
        }
        return out;
    }
    /* Records checked by the client's verifier: the family's member list, or the personal trust set. */
    async function checkRecords(workspaceId: string, nodes: DriveSignedNode[]) {
        if (options.verify) return options.verify(workspaceId, nodes);
        const { nodes: verified } = await rpc('driveVerify', {
            workspaceId,
            signers: await trustedSigners(),
            nodes,
        });
        return verified.map((node) => ({
            id: node.id,
            metadata: node.metadata,
            via: null,
            metadataRekey: node.metadataRekey ? { ...node.metadataRekey, via: null } : null,
            versions: node.versions.map((version) => ({
                id: version.id,
                integrity: version.integrity,
                via: null,
                rekey: version.rekey ? { ...version.rekey, via: null } : null,
            })),
        }));
    }
    /* The trust set, or a refusal: nothing is checked or re-signed against a guess. */
    async function trustedSigners() {
        if (!options.signers) throw new Error('HushOS couldn’t load the people you trust.');
        return options.signers();
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
            if (options.view) {
                // Opened elsewhere (a family folder's sync): its key is in the worker already, and
                // its root is made with the folder itself, never here.
                const view = await options.view();
                if (!view.root) throw new Error('This folder isn’t ready yet. Try again later.');
                workspace = view;
                await options.openIdentity?.(userId);
                return {
                    workspaceId: view.workspaceId,
                    root: view.root,
                    changeSeq: view.changeSeq,
                };
            }
            const view = await api.workspace();
            if (!view.grant)
                throw new Error('This account has no workspace key yet. Finish account setup.');
            workspace = view;
            await options.openIdentity?.(userId);
            await rpc('driveOpenWorkspace', { userId, grant: view.grant });
            let root = view.root;
            if (!root) {
                const { from } = await api.allocateEpochs(view.workspaceId, 1);
                const { id, seed } = await newId('node', view.workspaceId);
                const { nodes } = await rpc('driveCreateNodes', {
                    workspaceId: view.workspaceId,
                    nodes: [
                        {
                            id,
                            kind: 'folder',
                            parentId: view.workspaceId,
                            parentKeyEpoch: view.grant.workspaceKeyVersion,
                            keyEpoch: from,
                            metadata: { name: ROOT_NAME, mime: null, size: null, modified: null },
                        },
                    ],
                });
                const result = await api.createRoot(view.workspaceId, {
                    id,
                    idSeed: seed,
                    keyEpoch: from,
                    parentKeyEpoch: view.grant.workspaceKeyVersion,
                    keyEnvelope: nodes[0]!.keyEnvelope,
                    metadataEnvelope: nodes[0]!.metadataEnvelope,
                    metadataSignature: nodes[0]!.metadataSignature,
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

    /*
     * The catalogue: the whole workspace opened in memory, built from the mirror.
     * Building is two passes that each resume: the feed is pulled from the
     * mirror's cursor a page at a time, each page committed with its cursor, and
     * then every row is opened parents-first from the mirror. A page the network
     * dropped is fetched again next time; a row the worker could not open renders
     * as unreadable, like anywhere else.
     */
    const FEED_PAGE = 500;
    const OPEN_BATCH = 400;
    const catalogue = new Catalogue();
    let catalogueWorkspace: string | null = null;
    let catalogueState: CatalogueState = { phase: 'idle', pulled: 0, opened: 0, error: null };
    const catalogueListeners = new Set<(state: CatalogueState) => void>();
    let building: Promise<void> | undefined;
    let feedChain: Promise<unknown> = Promise.resolve();
    let ingesting: Promise<unknown> = Promise.resolve();
    /*
     * The last change this tab's catalogue holds. The mirror's cursor is the device's, shared
     * by every tab, so it says only what reached the disk: a change another tab pulled is
     * past it, and this catalogue would never hear of it from the mirror's cursor alone.
     */
    let catalogueCursor = 0;
    let rebuiltOnce = false;
    /* Bumped by close(): work started before a lock must not touch the catalogue after it. */
    let generation = 0;

    function setCatalogueState(patch: Partial<CatalogueState>) {
        catalogueState = { ...catalogueState, ...patch };
        for (const listener of catalogueListeners) listener(catalogueState);
    }
    function subscribeCatalogue(listener: (state: CatalogueState) => void) {
        catalogueListeners.add(listener);
        return () => {
            catalogueListeners.delete(listener);
        };
    }

    /*
     * Pulls the feed until the head, committing each page to the mirror; returns what arrived
     * and the cursor it reached. It starts at the mirror's cursor, or earlier at `from` (where
     * a catalogue stands that another tab's pull left behind); the mirror keeps only what is
     * past its own cursor, and refuses a page from past it (another tab cleared it meanwhile),
     * after which the pull goes on from the mirror's cursor or its own, whichever is earlier:
     * the clearing tab may have pulled past this one's start by then, and this catalogue still
     * needs what lies in between.
     *
     * A start so old the server dropped tombstones since (`resync`, said of the first page)
     * means deletions went by unnamed: when the start was this tab's own, the mirror may still
     * be current and is asked from its own cursor; when the mirror is stale too, it starts over
     * from nothing. Either way, and whenever the pull for a catalogue starts from nothing (the
     * mirror was cleared), `refile` tells the catalogue to refile from the mirror's rows.
     *
     * A close() in between stops it before the next write: signing out clears the mirror, and
     * a pull still on its way must not write the tree back.
     */
    function pullFeed(workspaceId: string, from?: number) {
        const mirror = options.mirror!;
        const startedIn = generation;
        const work = feedChain.then(async () => {
            const arrived: NodeChange[] = [];
            let refile = false;
            if (generation !== startedIn) return { arrived, cursor: 0, refile };
            let mirrored = await mirror.cursor(workspaceId);
            let cursor = from === undefined ? mirrored : Math.min(from, mirrored);
            // From nothing, a pull names no deletion: a catalogue that stood anywhere refiles.
            if (cursor === 0 && from) refile = true;
            let first = true;
            // What was inside a folder deleted forever leaves with it (TreeMirror.dropBelow), for
            // every page applied, even when a later one fails: no later pull names that deletion
            // again. A tab closed or locked mid-pull leaves the rows until the server's fan-out
            // tombstones them, or the next build finds them without a parent and starts over:
            // only the tab whose page took the folder off sweeps, and the others skip a
            // tombstone the mirror already holds.
            // Only where something can be below: a folder the mirror took off, or a tombstoned
            // node that rows of this pull name as their parent (a pull from nothing gets a
            // purged folder's contents, and the folder only as its tombstone).
            const foldersDropped: string[] = [];
            const tombstoned = new Set<string>();
            const parents = new Set<string>();
            let failed = true;
            try {
                for (;;) {
                    const page = await api.changes(workspaceId, cursor, FEED_PAGE);
                    if (generation !== startedIn) break;
                    if (first && page.resync && cursor > 0) {
                        refile = true;
                        arrived.length = 0;
                        if (cursor < mirrored) cursor = mirrored;
                        else {
                            await mirror.clear(workspaceId);
                            cursor = mirrored = 0;
                        }
                        continue;
                    }
                    first = false;
                    for (const change of page.changes)
                        if (change.kind === 'node') remember([change.node]);
                    const dropped = await mirror.apply(
                        workspaceId,
                        cursor,
                        page.changes,
                        page.nextCursor,
                    );
                    if (dropped === null) {
                        cursor = Math.min(cursor, await mirror.cursor(workspaceId));
                        if (cursor === 0 && from) refile = true;
                        continue;
                    }
                    arrived.push(...page.changes);
                    foldersDropped.push(...dropped);
                    for (const change of page.changes)
                        if (change.kind === 'tombstone') tombstoned.add(change.nodeId);
                        else if (change.kind === 'node' && change.node.parentId)
                            parents.add(change.node.parentId);
                    cursor = page.nextCursor;
                    // A poll that brought nothing redraws nothing.
                    if (page.changes.length)
                        setCatalogueState({ pulled: catalogueState.pulled + page.changes.length });
                    if (!page.hasMore) break;
                }
                failed = false;
            } finally {
                const below = new Set(foldersDropped);
                for (const id of tombstoned) if (parents.has(id)) below.add(id);
                if (generation === startedIn && below.size) {
                    const sweep = mirror.dropBelow(workspaceId, [...below]);
                    await (failed ? sweep.catch(() => {}) : sweep);
                }
            }
            return { arrived, cursor, refile };
        });
        feedChain = work.catch(() => {});
        return work;
    }

    /* Opens rows in batches, parents first, and files them; keys stay in the worker. */
    async function fileRows(rows: NodeView[], startedIn: number) {
        for (let index = 0; index < rows.length; index += OPEN_BATCH) {
            const opened = await decorate(rows.slice(index, index + OPEN_BATCH));
            if (generation !== startedIn) return;
            for (const node of opened) catalogue.upsert(node);
            setCatalogueState({ opened: catalogueState.opened + opened.length });
        }
    }

    function buildCatalogue(workspaceId: string): Promise<void> {
        const mirror = options.mirror;
        if (!mirror) return Promise.resolve();
        if (building) return building;
        // Every Drive page asks on mount; once built for this workspace the feed keeps it current.
        if (catalogueWorkspace === workspaceId && catalogueState.phase === 'ready')
            return Promise.resolve();
        const startedIn = generation;
        building = (async () => {
            try {
                // One workspace per device: another account's tree is not kept beside this one.
                for (const other of await mirror.workspaces())
                    if (other !== workspaceId) await mirror.clear(other);
                if (catalogueWorkspace !== workspaceId) catalogue.clearNodes();
                catalogueWorkspace = workspaceId;
                setCatalogueState({ phase: 'pulling', pulled: 0, opened: 0, error: null });
                await pullFeed(workspaceId);
                if (generation !== startedIn) return;
                setCatalogueState({ phase: 'opening' });
                const snapshot = await mirror.snapshot(workspaceId);
                catalogueCursor = snapshot.cursor;
                const { ordered, orphans } = parentsFirst(snapshot.rows);
                if (orphans.length && !rebuiltOnce) {
                    // A row without its parent is a page this device missed: start over once.
                    rebuiltOnce = true;
                    await mirror.clear(workspaceId);
                    building = undefined;
                    return buildCatalogue(workspaceId);
                }
                catalogue.clearNodes();
                await fileRows(ordered, startedIn);
                if (generation !== startedIn) return;
                setCatalogueState({ phase: 'ready' });
            } catch (error) {
                if (generation === startedIn)
                    setCatalogueState({
                        phase: 'failed',
                        error: error instanceof Error ? error.message : 'Please try again.',
                    });
            } finally {
                if (generation === startedIn) building = undefined;
            }
        })();
        return building;
    }

    /*
     * After a page of changes reached the app, bring the mirror and this tab's catalogue up to
     * the head: from wherever the catalogue stands, whichever tab moved the mirror on. One at a
     * time, so a slower pull never files an older state over a newer one.
     */
    function ingest(workspaceId: string) {
        const work = ingesting.then(() => ingestNow(workspaceId));
        ingesting = work.catch(() => {});
        return work;
    }
    async function ingestNow(workspaceId: string) {
        if (
            !options.mirror ||
            catalogueState.phase !== 'ready' ||
            catalogueWorkspace !== workspaceId
        )
            return;
        const startedIn = generation;
        // A refile that met a mirror another tab cleared meanwhile pulls again at once, a few
        // times at most: the app pulls next only when the feed has news, which may be long.
        for (let attempt = 0; ; attempt++) {
            const { arrived, cursor, refile } = await pullFeed(workspaceId, catalogueCursor);
            if (generation !== startedIn) return;
            if (!refile) return fileArrived(arrived, cursor, startedIn);
            // Deletions went by that no change names: the mirror's rows say what is left. Only
            // rows that stand at least where the pull ended: a mirror another tab cleared since
            // holds a part, and what is missing from a part is not gone.
            const snapshot = await options.mirror.snapshot(workspaceId);
            if (generation !== startedIn) return;
            if (snapshot.cursor < cursor) {
                if (attempt < 2) continue;
                return;
            }
            const { ordered } = parentsFirst(snapshot.rows);
            // What changed is filed over what was held, so answers stay whole meanwhile; so is
            // what would not open before, which may have been for want of its folder's key.
            const left = new Set(ordered.map((row) => row.id));
            let removed = false;
            for (const node of catalogue.values())
                if (!left.has(node.id)) removed = catalogue.remove(node.id) || removed;
            await fileRows(
                ordered.filter((row) => {
                    const held = catalogue.get(row.id);
                    return !held || held.changeSeq !== row.changeSeq || held.openError !== null;
                }),
                startedIn,
            );
            if (generation !== startedIn) return;
            // The rows filed stand where the snapshot does, which may be past the pull.
            catalogueCursor = snapshot.cursor;
            // What was filed was heard as it opened; a removal alone is heard here.
            if (removed) setCatalogueState({});
            return;
        }
    }
    async function fileArrived(arrived: NodeChange[], cursor: number, startedIn: number) {
        const changed: NodeView[] = [];
        const purged: string[] = [];
        for (const change of arrived)
            if (change.kind === 'node') changed.push(change.node);
            else if (change.kind === 'tombstone') purged.push(change.nodeId);
        // The feed holds each node once, at its latest change: a folder made, filled and then
        // renamed comes after what is inside it, and the worker opens a child only under a
        // parent it has opened. Folders made together share one change, in no set order.
        await fileRows(parentsBefore(changed), startedIn);
        if (generation !== startedIn) return;
        // What was inside a purged folder goes with it: its own tombstones come minutes later.
        // After the changes are filed, so a child changed before its folder went goes too.
        let removed = 0;
        for (const id of purged) removed += catalogue.removeTree(id);
        catalogueCursor = Math.max(catalogueCursor, cursor);
        // What was filed was heard as it opened; a removal alone is heard here.
        if (removed) setCatalogueState({});
    }

    /*
     * After a change made here: pull the feed into the catalogue now rather than at the app's
     * next poll, so Recent, search and tags show it at once. A no-op until the catalogue is built.
     */
    function catchUp() {
        return catalogueWorkspace ? ingest(catalogueWorkspace) : Promise.resolve();
    }

    /* The catalogue's answers: instant, or null while it is not ready. */
    function localListing(folderId: string): FolderListing | null {
        if (catalogueState.phase !== 'ready') return null;
        return catalogue.listing(folderId);
    }
    function byTags(tagIds: string[]) {
        return catalogueState.phase === 'ready' ? catalogue.byTags(tagIds) : [];
    }
    /* Search answers while the build is still opening rows, since a partial answer beats none. */
    function search(query: string, limit?: number) {
        return catalogueState.phase === 'ready' || catalogueState.phase === 'opening'
            ? catalogue.search({ query, limit })
            : [];
    }
    /* Home's Recent: answers while rows are still opening, like search. */
    function recent(limit: number, keep?: (node: DriveNode) => boolean) {
        return catalogueState.phase === 'ready' || catalogueState.phase === 'opening'
            ? catalogue.recent(limit, keep)
            : [];
    }
    /* Root first, the node's parent last, as far as the catalogue knows. */
    function ancestorsOf(nodeId: string) {
        return catalogue.ancestors(nodeId);
    }
    function tagCounts() {
        return catalogueState.phase === 'ready' ? catalogue.tagCounts() : new Map<string, number>();
    }
    /*
     * Checks again who wrote every item the catalogue holds, after the people
     * this person trusts changed (a contact checked, removed, or followed to new
     * keys). Listings are the query layer's to refetch.
     */
    async function recheckIntegrity() {
        const startedIn = generation;
        const nodes = catalogue.values().filter((node) => !node.openError);
        for (let index = 0; index < nodes.length; index += OPEN_BATCH) {
            const batch = nodes.slice(index, index + OPEN_BATCH);
            const checked = await verify(batch);
            if (generation !== startedIn) return;
            // Only onto the row as it was checked: one purged meanwhile stays gone, and one the
            // feed changed meanwhile (trashed, renamed) was checked when it was filed.
            for (const node of batch)
                if (catalogue.get(node.id)?.changeSeq === node.changeSeq)
                    catalogue.upsert({
                        ...catalogue.get(node.id)!,
                        integrity: checked.get(node.id) ?? null,
                    });
        }
        setCatalogueState({});
    }

    /*
     * The tag registry: the workspace's sealed document, read when first needed
     * and merged on a refused write so two devices editing tags cannot drop each
     * other's. `base` is what this device last saw the server hold, which is what
     * makes a three-way merge possible.
     */
    let registry: { value: TagRegistry; base: TagRegistry; version: number } | null = null;
    async function readRegistry(ws: string) {
        const { document } = await api.document(ws, TAGS_DOCUMENT);
        if (!document) return { value: emptyRegistry(), base: emptyRegistry(), version: 0 };
        if (document.envelopeSuite !== DRIVE_ENVELOPE_SUITE)
            throw new Error(
                'Your tags were saved by a newer version of HushOS. Update to see them.',
            );
        const opened = await rpc('driveOpenDocument', {
            workspaceId: ws,
            kind: TAGS_DOCUMENT,
            version: document.version,
            envelope: document.envelope,
        });
        const value = parseRegistry(opened.document);
        return { value, base: value, version: document.version };
    }
    async function tags(fresh = false) {
        if (!workspace) throw new Error('Open Drive first.');
        if (!registry || fresh) {
            registry = await readRegistry(workspace.workspaceId);
            catalogue.setTags(registry.value);
        }
        return registry.value;
    }
    /* What this device last read of a node's tags, without a request; ids, in the registry's order. */
    function tagsOf(nodeId: string) {
        return registry ? registryTagsOf(registry.value, nodeId) : [];
    }
    async function saveTags(next: TagRegistry) {
        if (!workspace) throw new Error('Open Drive first.');
        const ws = workspace.workspaceId;
        const current = registry ?? (await readRegistry(ws));
        let attempt = { value: next, base: current.base, version: current.version };
        for (let tries = 0; tries < 3; tries++) {
            const { envelope } = await rpc('driveSealDocument', {
                workspaceId: ws,
                kind: TAGS_DOCUMENT,
                version: attempt.version + 1,
                document: serialiseRegistry(attempt.value),
            });
            try {
                const { document } = await api.putDocument(ws, TAGS_DOCUMENT, {
                    version: attempt.version,
                    envelope,
                });
                registry = { value: attempt.value, base: attempt.value, version: document.version };
                catalogue.setTags(registry.value);
                return registry.value;
            } catch (error) {
                if (!(error instanceof DriveApiError) || error.code !== 'stale') throw error;
                // Another device saved first: take theirs, keep what we changed, try again.
                const theirs = await readRegistry(ws);
                attempt = {
                    value: mergeRegistries(attempt.base, attempt.value, theirs.value),
                    base: theirs.value,
                    version: theirs.version,
                };
            }
        }
        throw new Error('The tag list keeps changing on another device. Try again.');
    }
    /* Sets the tags one node carries: a change to the registry alone; the node is not touched. */
    async function setTags(node: DriveNode, tagIds: string[]) {
        const current = await tags();
        return saveTags(assign(current, node.id, tagIds));
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
            // shares, which opens their keys, and try each owner's workspace. A family
            // folder's client holds no shares: its folders are its own workspace's.
            if (options.view || !(error instanceof DriveApiError) || error.status !== 404 || first)
                throw error;
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
     * `signAs` is the statement their names are signed with (see
     * signatureFormFor): ordinary for folders this person makes, `saved` for
     * those a save from a link recreates, `resealed` for names taken from
     * something this person did not verify, which they re-lock, nothing more.
     */
    async function createFolderPath(
        parent: DriveNode,
        path: string[],
        options: { signAs?: SignatureForm } = {},
    ) {
        const ws = parent.workspaceId;
        const names = path.map((name) => checkName(name));
        if (names.length < 1) throw new Error('Enter a folder name.');
        if (names.length > MAX_FOLDER_BATCH)
            throw new Error(`Create at most ${MAX_FOLDER_BATCH} folders at a time.`);
        const { from } = await api.allocateEpochs(ws, names.length);
        const specs = await Promise.all(
            names.map(async (name, index) => ({
                ...(await newId('node', ws)),
                keyEpoch: from + index,
                name,
            })),
        );
        const { nodes } = await rpc('driveCreateNodes', {
            workspaceId: ws,
            nodes: specs.map((spec, index) => ({
                id: spec.id,
                kind: 'folder' as const,
                parentId: index === 0 ? parent.id : specs[index - 1]!.id,
                parentKeyEpoch: index === 0 ? parent.keyEpoch : specs[index - 1]!.keyEpoch,
                keyEpoch: spec.keyEpoch,
                metadata: { name: spec.name, mime: null, size: null, modified: null },
                signAs: options.signAs ?? 'ordinary',
            })),
        });
        const created = await api.createFolders(
            ws,
            specs.map((spec, index) => ({
                id: spec.id,
                idSeed: spec.seed,
                parentId: index === 0 ? parent.id : specs[index - 1]!.id,
                parentKeyEpoch: index === 0 ? parent.keyEpoch : specs[index - 1]!.keyEpoch,
                keyEpoch: spec.keyEpoch,
                keyEnvelope: nodes[index]!.keyEnvelope,
                metadataEnvelope: nodes[index]!.metadataEnvelope,
                metadataSignature: nodes[index]!.metadataSignature,
            })),
        );
        return decorate(created.nodes);
    }

    /*
     * A rename re-signs the whole record, type, size and date carried over, so
     * it is checked first, as a reading would: only metadata that verifies is
     * signed again with the ordinary statement, and only metadata that
     * verified as saved from a link keeps the saved one. Anything else
     * (planted, unchecked, signed by someone not checked) is re-locked with
     * the re-sealed one and stays Unverified, rather than turning into a
     * record this person vouches for.
     */
    async function rename(node: DriveNode, name: string) {
        const ws = node.workspaceId;
        const clean = checkName(name);
        const checked = (await verify([node])).get(node.id);
        const { metadataEnvelope, metadataSignature } = await rpc('driveSealMetadata', {
            workspaceId: ws,
            nodeId: node.id,
            kind: node.kind,
            metadataVersion: node.metadataVersion + 1,
            metadata: {
                ...(node.metadata ?? { mime: null, size: null, modified: null }),
                name: clean,
            },
            signAs: signatureFormFor(checked?.metadata),
        });
        const result = await api.rename(ws, node.id, {
            metadataVersion: node.metadataVersion,
            keyEpoch: node.keyEpoch,
            metadataEnvelope,
            metadataSignature,
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
        const { id, seed } = await newId('node', ws);
        const { id: versionId, seed: versionIdSeed } = await newId('version', ws);
        const signed = signedNodeOf(node, [version]);
        const sealed = await rpc('driveCopyFile', {
            workspaceId: ws,
            // The source's records are checked in the worker before anything is re-signed.
            signers: await trustedSigners(),
            source: {
                nodeId: node.id,
                ...versionEnvelopeOf(version),
                metadataVersion: signed.metadataVersion,
                metadataEnvelope: signed.metadataEnvelope,
                metadataSigner: signed.metadataSigner,
                metadataSignature: signed.metadataSignature,
                signer: signed.versions?.[0]?.signer ?? null,
                signature: signed.versions?.[0]?.signature ?? null,
                // A re-keyed source is judged on its writer's record (family folders, rekeyedFor).
                keyEpoch: signed.keyEpoch,
                metadataRekey: signed.metadataRekey ?? null,
                rekey: signed.versions?.[0]?.rekey ?? null,
            },
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
            ...(options.rotationTrust ? { group: await options.rotationTrust() } : {}),
        });
        const result = await api.copy(ws, node.id, {
            sourceVersionId: version.id,
            node: {
                id,
                idSeed: seed,
                parentId: destination.id,
                parentKeyEpoch: destination.keyEpoch,
                keyEpoch: from,
                keyEnvelope: sealed.keyEnvelope,
                metadataEnvelope: sealed.metadataEnvelope,
                metadataSignature: sealed.metadataSignature,
            },
            versionId,
            versionIdSeed,
            contentKeyEnvelope: sealed.contentKeyEnvelope,
            versionSignature: sealed.versionSignature,
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
        // A folder's name is re-signed as this person's only when the source's verified
        // (and stays saved only when it verified as saved from a link).
        const signAs = (folder: DriveNode) => signatureFormFor(folder.integrity?.metadata);
        const [made] = await createFolderPath(destination, [name], { signAs: signAs(node) });
        tick();
        const stack: { source: DriveNode; target: DriveNode }[] = [{ source: node, target: made! }];
        while (stack.length) {
            const { source, target } = stack.pop()!;
            const listing = await listFolder(source.id);
            for (const child of listing.children) {
                if (child.kind === 'folder') {
                    const [folder] = await createFolderPath(target, [child.name], {
                        signAs: signAs(child),
                    });
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
        if (!listed.length)
            return [] as (VersionListView & {
                content: DriveContentInfo | null;
                integrity: RecordIntegrity | null;
                rekeyed: RekeyNote | null;
            })[];
        const { versions: opened } = await rpc('driveOpenVersions', {
            workspaceId: node.workspaceId,
            nodeId: node.id,
            versions: listed.map(versionEnvelopeOf),
        });
        // Each version on its own: an earlier one may have been added by someone else.
        const checked = new Map<string, VerifiedRecords[number]['versions'][number]>();
        const link = linkWorkspaces.has(node.workspaceId);
        if (!link) {
            try {
                const nodes = await checkRecords(node.workspaceId, [signedNodeOf(node, listed)]);
                for (const version of nodes[0]?.id === node.id ? nodes[0].versions : [])
                    checked.set(version.id, version);
            } catch {
                /* Unchecked: every version below says so. */
            }
        }
        return listed.map((version, index) => {
            const result = opened[index]!;
            const check = checked.get(version.id);
            return {
                ...version,
                integrity: link ? null : (check?.integrity ?? 'unchecked'),
                rekeyed: link
                    ? null
                    : rekeyNoteOf(version.rekey, version.signer ?? null, check?.rekey),
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
        contact: { userId: string; encryptionPublicKey: string; kemPublicKey: string | null },
        role: ShareRole,
    ) {
        if (!currentUserId) throw new Error('Open Drive first.');
        // Share suite 4 seals to the KEM key too; there is no sealing to X25519 alone any more.
        if (!contact.kemPublicKey)
            throw new Error(
                'They haven’t got post-quantum keys yet, so nothing was shared. They get them the next time they sign in.',
            );
        const ws = node.workspaceId;
        const { shareEnvelope } = await rpc('driveSealShare', {
            workspaceId: ws,
            nodeId: node.id,
            keyEpoch: node.keyEpoch,
            granterUserId: currentUserId,
            granteeUserId: contact.userId,
            granteePublicKey: contact.encryptionPublicKey,
            granteeKemPublicKey: contact.kemPublicKey,
        });
        const { share } = await api.share(ws, node.id, {
            granteeUserId: contact.userId,
            role,
            keyEpoch: node.keyEpoch,
            shareEnvelope,
        });
        await options.ledger?.addShare(node.id, contact.userId);
        return share;
    }
    async function nodeShares(node: DriveNode) {
        return (await api.nodeShares(node.workspaceId, node.id)).shares;
    }
    /*
     * Seals shares again in suite 4, signed by this account's current keys: any
     * share in an older suite, any whose grantee's pin followed a succession
     * (their new keys), and with `all`, every share in the ledger (after this
     * account replaced its own keys). Runs in the background after Drive opens;
     * a grantee whose served keys the pin refuses is skipped and counted, never
     * sealed to. Returns how many were re-sealed and how many were refused.
     */
    async function upgradeShares(input: { all?: boolean } = {}) {
        if (!currentUserId || !options.trustGrantee || !options.ledger)
            return { resealed: 0, refused: 0 };
        // Read once: a lock mid-pass clears `workspace`, and a share must then count as failed
        // (owed again later), never as refused, which would mark its grantee done.
        const ownWorkspace = workspace?.workspaceId;
        if (!ownWorkspace) return { resealed: 0, refused: 0 };
        const [mine, ledger] = await Promise.all([api.sharedByMe(), options.ledger.read()]);
        // Each grantee the owner shared with, checked against their pin once: a pin that
        // follows a succession here asks for what was shared to be sealed to the new keys.
        const trusted = new Map<string, Promise<TrustedGrantee>>();
        const trust = (share: (typeof mine.shares)[number]) => {
            let keys = trusted.get(share.grantee.id);
            if (!keys) {
                keys = options.trustGrantee!(share.grantee.id, share.granteeIdentity);
                keys.catch(() => {});
                trusted.set(share.grantee.id, keys);
            }
            return keys;
        };
        for (const share of mine.shares)
            if (ledger.shares[share.node.id]?.includes(share.grantee.id))
                await trust(share).catch(() => {});
        const waiting = new Set((await options.resealPending?.()) ?? []);
        const all = input.all || ((await options.resealAll?.()) ?? false);
        let failed = 0;
        // Grantees whose pin asked for this, and whether every share to them went through.
        const owed = new Map<string, boolean>();
        let resealed = 0;
        let refused = 0;
        for (const share of mine.shares) {
            const grantee = share.grantee.id;
            if (waiting.has(grantee) && !owed.has(grantee)) owed.set(grantee, true);
            if (share.suite === 4 && !all && !waiting.has(grantee)) continue;
            // Only a share in this account's own Drive: one it made elsewhere is in a family folder,
            // where sharing is not offered (design 3.4) and the worker and server refuse to seal.
            if (options.view || share.node.workspaceId !== ownWorkspace) {
                refused++;
                continue;
            }
            // Only a share the owner made: the server's list alone is no reason to seal.
            if (!ledger.shares[share.node.id]?.includes(grantee)) {
                refused++;
                continue;
            }
            let keys: TrustedGrantee;
            try {
                keys = await trust(share);
            } catch {
                owed.set(grantee, false);
                refused++;
                continue;
            }
            if (!keys.kemPublicKey) {
                owed.set(grantee, false);
                continue;
            }
            try {
                const node = share.node;
                if (node.parentId && !openedNodes.has(node.parentId))
                    await listFolder(node.parentId);
                await decorate([node]);
                const { shareEnvelope } = await rpc('driveSealShare', {
                    workspaceId: node.workspaceId,
                    nodeId: node.id,
                    keyEpoch: node.keyEpoch,
                    granterUserId: currentUserId,
                    granteeUserId: grantee,
                    granteePublicKey: keys.encryptionPublicKey,
                    granteeKemPublicKey: keys.kemPublicKey,
                });
                await api.resealShare(node.workspaceId, share.id, {
                    keyEpoch: node.keyEpoch,
                    shareEnvelope,
                });
                resealed++;
            } catch (error) {
                owed.set(grantee, false);
                failed++;
                if (input.all) throw error;
            }
        }
        const done = [...owed].flatMap(([id, ok]) => (ok ? [id] : []));
        if (done.length) await options.resealedTo?.(done);
        if (all && !failed) await options.resealedAll?.();
        return { resealed, refused };
    }
    async function revokeShare(node: DriveNode, shareId: string) {
        // Out of the ledger first, so the rotation that follows never seals to them again.
        const grantee = (await nodeShares(node)).find((share) => share.id === shareId)?.grantee.id;
        if (grantee) await options.ledger?.removeShare(node.id, grantee);
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
        const { id: linkId, seed: linkIdSeed } = await newId('link', node.workspaceId);
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
            linkIdSeed,
            token: sealed.token,
            keyEpoch: node.keyEpoch,
            linkEnvelope: sealed.linkEnvelope,
            linkSalt: sealed.salt,
            secretEnvelope: sealed.secretEnvelope,
            hasPassword: input.password !== null,
            expiresAt: input.expiresAt,
        });
        await options.ledger?.addLink(linkId, node.id);
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
        await options.ledger?.removeLink(linkId);
        await api.revokeLink(node.workspaceId, linkId);
    }
    async function openLink(token: string, secret: string, password: string | null) {
        if (!options.linkApi) throw new Error('Links cannot be opened on this client.');
        const opened = await options.linkApi.open(token);
        if (opened.link.kdfVersion !== LINK_KDF_VERSION)
            throw new Error(
                'This link was made by an older version of HushOS. Ask for a new link.',
            );
        remember([opened.node]);
        guestWorkspaceId = opened.link.workspaceId;
        linkWorkspaces.add(opened.link.workspaceId);
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
        },
    ) {
        const { operators } = await api.reportOperators();
        if (!operators.length)
            throw new Error('This instance has no operator yet, so it cannot take reports.');
        // Made in the reported item's workspace, which is the one the server derives it in.
        const { id, seed } = await newId('report', node.workspaceId);
        const { envelopes } = await rpc('driveSealReport', {
            workspaceId: node.workspaceId,
            nodeId: node.id,
            keyEpoch: node.keyEpoch,
            reportId: id,
            operators,
        });
        return api.report({
            id,
            reportIdSeed: seed,
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
            operators: missing.map(({ sealed: _sealed, ...operator }) => operator),
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
        // What may be sealed again: the owner's ledger, never the server's list alone.
        const ledger = (await options.ledger?.read()) ?? { shares: {}, links: {} };
        // Who this person trusts: every record is checked before it is signed again, and
        // without the trust set the rotation stops here and is retried, never run unchecked.
        const signers = await trustedSigners();
        // A family folder's walk is checked against its member list (the worker requires it).
        const group = options.rotationTrust ? await options.rotationTrust() : null;
        let done = 0;
        let cursor: string | null = null;
        let idle = 0;
        // A node the worker would not carry into the new tree (design 2.10): only a manager clears it.
        let notCarried = false;
        // A family-folder node with shares or links, which family folders do not take (design 3.4).
        let shared = false;
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
            // A family folder's walk refuses any share or link the server lists on a node, the
            // walker's own included (design 3.4): none is made there, so none is sealed again or
            // filtered down to the ledger's and the rest left to close. The worker and the core
            // refuse such a node alike; this one never reaches the worker.
            const sending = group
                ? work.nodes.filter((n) => !n.shares.length && !n.links.length)
                : work.nodes;
            if (sending.length < work.nodes.length) shared = true;
            const sealed = await rpc('driveRotateNodes', {
                workspaceId: ws,
                targetEpoch,
                granterUserId: currentUserId,
                signers,
                ...(group ? { group } : {}),
                nodes: await Promise.all(
                    sending.map(async (n) => ({
                        id: n.id,
                        kind: n.kind,
                        parentId: parentRef(n),
                        parentKeyEpoch: n.id === rootId ? n.parentKeyEpoch : targetEpoch,
                        keyEpoch: n.keyEpoch,
                        wrappedParentKeyEpoch: n.parentKeyEpoch,
                        keyEnvelope: n.keyEnvelope,
                        metadataVersion: n.metadataVersion,
                        metadataEnvelope: n.metadataEnvelope,
                        metadataSigner: n.metadataSigner?.id ?? null,
                        metadataSignature: n.metadataSignature ?? null,
                        // The origin an earlier rotation kept: carried on, never sent back.
                        metadataRekey: servedRekeyOf(n.metadataRekey),
                        versions: n.versions.map((v) => ({
                            id: v.id,
                            objectId: v.objectId,
                            contentKeyEnvelope: v.contentKeyEnvelope,
                            contentSuite: v.contentSuite,
                            plaintextSize:
                                v.plaintextSize === null ? null : Number(v.plaintextSize),
                            signer: v.signer?.id ?? null,
                            signature: v.signature ?? null,
                            rekey: servedRekeyOf(v.rekey),
                        })),
                        shares: (
                            await Promise.all(
                                n.shares.map(async (share) => {
                                    // The server names the grantee; the ledger says whether the
                                    // owner shared with them and the pin which keys are sealed to.
                                    // A share either refuses keeps its old envelope, which the
                                    // rotation leaves unopenable: closed, never re-sealed to someone
                                    // the person did not share with or a key they did not vouch for.
                                    if (!ledger.shares[n.id]?.includes(share.granteeUserId))
                                        return null;
                                    if (!options.trustGrantee) return null;
                                    let keys: TrustedGrantee;
                                    try {
                                        keys = await options.trustGrantee(
                                            share.granteeUserId,
                                            share.grantee,
                                        );
                                    } catch {
                                        return null;
                                    }
                                    return {
                                        id: share.id,
                                        granteeUserId: share.granteeUserId,
                                        granteePublicKey: keys.encryptionPublicKey,
                                        granteeKemPublicKey: keys.kemPublicKey,
                                    };
                                }),
                            )
                        ).filter((share) => share !== null),
                        // A link the owner did not make, or stopped, is left to the rotation to close.
                        links: n.links.filter((link) => ledger.links[link.id] === n.id),
                    })),
                ),
            });
            let applied = 0;
            // The keys the worker made become the nodes' own only for what the server applied:
            // whatever stops this batch, every other key it made is dropped, so a retry in this
            // tab walks those nodes again instead of finding them pending.
            const kept = new Set<string>();
            try {
                const batch = [];
                for (const [index, result] of sealed.nodes.entries()) {
                    const source = sending[index]!;
                    if (result.error !== undefined) {
                        if (result.error === NOT_CARRIED) notCarried = true;
                        if (result.error === SHARED_IN_FAMILY) shared = true;
                        continue;
                    }
                    if (!result.rewrap && !result.metadataSignature && !result.metadataRekey)
                        throw new Error('The rotation could not sign what it sealed. Try again.');
                    batch.push({
                        id: source.id,
                        changeSeq: source.changeSeq ?? 0,
                        parentKeyEpoch: source.id === rootId ? source.parentKeyEpoch : targetEpoch,
                        keyEnvelope: result.keyEnvelope,
                        rotated: result.rewrap
                            ? null
                            : {
                                  metadataEnvelope: result.metadataEnvelope,
                                  metadataSignature: result.metadataSignature,
                                  metadataRekey: result.metadataRekey ?? null,
                                  ...(result.metadataDropOrigin
                                      ? { metadataDropOrigin: true }
                                      : {}),
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
                if (batch.length) {
                    const { results } = await api.rotateNodes(ws, rootId, batch);
                    for (const r of results)
                        if (r.status === 'ok' || r.status === 'already') kept.add(r.id);
                    applied = kept.size;
                }
            } finally {
                const ids = work.nodes.map((n) => n.id);
                await rpc('driveRotateCommit', {
                    workspaceId: ws,
                    nodeIds: ids.filter((id) => kept.has(id)),
                });
                await rpc('driveRotateDrop', {
                    workspaceId: ws,
                    nodeIds: ids.filter((id) => !kept.has(id)),
                });
            }
            done += applied;
            onProgress?.(done);
            idle = applied ? 0 : idle + 1;
            if (idle > 3)
                throw new Error(
                    shared
                        ? 'An item in this family folder has shares or links, which family folders don’t support, so its keys weren’t changed. The key change can finish once they’re stopped.'
                        : notCarried
                          ? 'One item in this folder can’t take the new keys. A manager can move it to Trash and delete it forever, then the key change finishes.'
                          : 'The rotation could not finish. Try again.',
                );
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
        if (page.changes.length) void ingest(workspaceId).catch(() => {});
        return page;
    }
    async function shareChangesSince(shareId: string, cursor?: string) {
        const page = await api.shareChanges(shareId, cursor);
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
        const result = await walkRotation(pending, onProgress);
        workspace = { ...workspace, rotation: null };
        return result;
    }
    /*
     * Walks a rotation running in this workspace to its end, from what the
     * server names (a family folder's, from route 25 or a 409 rotating): the
     * same walk as `rotate`, from wherever it got to.
     */
    async function walkRotation(
        pending: { nodeId: string; targetEpoch: number },
        onProgress?: (done: number) => void,
    ) {
        if (!workspace) throw new Error('Open Drive first.');
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
        return runRotation(
            workspace.workspaceId,
            pending.nodeId,
            pending.targetEpoch,
            kind,
            parentId,
            onProgress,
        );
    }

    /* What this person shares out, nodes named, for managing in one place. */
    async function mySharing() {
        const mine = await api.sharedByMe();
        const nodes = new Map<string, NodeView>();
        for (const entry of [...mine.shares, ...mine.links]) nodes.set(entry.node.id, entry.node);
        // Names need the folder chain: open each node's parents by listing them once.
        const named = new Map<string, DriveNode>();
        for (const node of nodes.values()) {
            try {
                if (node.parentId && !openedNodes.has(node.parentId))
                    await listFolder(node.parentId);
                const [opened] = await decorate([node]);
                named.set(node.id, opened!);
            } catch (cause) {
                // One item that cannot be named must not take the whole page with it.
                named.set(node.id, {
                    ...node,
                    metadata: null,
                    name: node.kind === 'folder' ? 'Shared folder' : 'Shared file',
                    content: null,
                    openError:
                        cause instanceof Error ? cause.message : 'This item could not be opened.',
                    integrity: null,
                });
            }
        }
        return {
            shares: mine.shares.map((share) => ({ ...share, node: named.get(share.node.id)! })),
            links: mine.links.map((link) => ({ ...link, node: named.get(link.node.id)! })),
        };
    }

    /*
     * Everything shared with this person, keys opened; a share whose granter is
     * not trusted is reported, not opened. `explicit`, the one share the person
     * is opening now (openShare): its granter may be added back or followed.
     */
    function mountShares(refresh = false, explicit?: string) {
        // Before Drive is open there is no identity to open a share with; a failure
        // this early must not be remembered as the answer.
        if (!currentUserId) return Promise.reject(new Error('Open Drive first.'));
        if (refresh || explicit !== undefined) mounts = undefined;
        mounts ??= (async () => {
            const { shares } = await api.sharedWithMe();
            const granteeUserId = currentUserId;
            const out: ShareMount[] = [];
            for (const received of shares) {
                remember([received.node]);
                let error: string | null = null;
                let unverified = false;
                let waiting = false;
                try {
                    if (!options.trustGranter || !granteeUserId)
                        throw new Error('Shares cannot be opened on this client.');
                    // The granter's current key only: a share signed before they replaced
                    // their keys waits for them to seal it again.
                    const { signingPublicKey, mlDsaPublicKey, replaced } =
                        await options.trustGranter(received.granter, {
                            explicit: received.id === explicit,
                        });
                    try {
                        await rpc('driveOpenShare', {
                            workspaceId: received.workspaceId,
                            nodeId: received.node.id,
                            keyEpoch: received.keyEpoch,
                            granterUserId: received.granter.id,
                            granterSigningPublicKey: signingPublicKey,
                            granterMlDsaPublicKey: mlDsaPublicKey,
                            granteeUserId,
                            // Not recorded on the share: the worker tries this account's identities in turn.
                            granteeKeyVersion: null,
                            shareEnvelope: received.shareEnvelope,
                            prevShareEnvelope: received.prevShareEnvelope,
                            prevKeyEpoch: received.prevKeyEpoch,
                        });
                    } catch (cause) {
                        if (!replaced) throw cause;
                        throw new Error(
                            `${replaced.name} replaced their sharing keys since sharing this. Ask ${replaced.name} to share it again.`,
                            { cause },
                        );
                    }
                } catch (cause) {
                    error =
                        cause instanceof Error ? cause.message : 'This share could not be opened.';
                    unverified = cause instanceof Error && cause.name === 'UnverifiedGranterError';
                    waiting = cause instanceof Error && cause.name === 'GranterWaitingError';
                }
                const node: DriveNode = error
                    ? {
                          ...received.node,
                          metadata: null,
                          name: 'Shared folder',
                          content: null,
                          openError: error,
                          integrity: null,
                      }
                    : (await decorate([received.node]))[0]!;
                out.push({ ...received, node, error, unverified, waiting });
            }
            return out;
        })().catch((error: unknown) => {
            mounts = undefined;
            throw error;
        });
        return mounts;
    }

    /* The person opening one share: its granter may be added back or followed, and it opens. */
    async function openShare(shareId: string) {
        const mounted = await mountShares(true, shareId);
        const share = mounted.find((each) => each.id === shareId);
        if (!share) throw new Error('This share no longer exists.');
        if (share.error) throw new Error(share.error);
        return share;
    }

    /*
     * Trashing and restoring in place change only `trashedAt` and `changeSeq`
     * (packages/db drive.ts): no key, envelope or signature moves. So the node
     * the caller already opened is the answer, with those two fields from the
     * server; nothing goes back through the worker. Any other field the
     * response carries is ignored, so a server cannot slip an envelope in
     * beside metadata this client decrypted from another.
     */
    function withPlace(node: DriveNode, served: NodeView): DriveNode {
        return { ...node, trashedAt: served.trashedAt, changeSeq: served.changeSeq };
    }

    async function trash(node: DriveNode) {
        const result = await api.trash(node.workspaceId, node.id);
        return withPlace(node, result.node);
    }

    /*
     * Restores in place, or to the root when the original parent is itself in
     * the trash. Only the second re-wraps the node key under a new parent, and
     * only it is opened again, so the worker holds the node under its new
     * parent.
     */
    async function restore(node: DriveNode, toRoot?: DriveNode) {
        const ws = node.workspaceId;
        if (!toRoot) return withPlace(node, (await api.restore(ws, node.id)).node);
        const { keyEnvelope } = await rpc('driveRewrapNode', {
            workspaceId: ws,
            nodeId: node.id,
            parentId: toRoot.id,
            parentKeyEpoch: toRoot.keyEpoch,
            keyEpoch: node.keyEpoch,
        });
        const result = await api.restore(ws, node.id, {
            parentKeyEpoch: toRoot.keyEpoch,
            keyEnvelope,
        });
        return (await decorate([result.node]))[0]!;
    }

    /*
     * A selection in this workspace to the trash, or back in place, in one
     * request of at most MAX_TRASH_BATCH ids (api.ts trashBatch): the server's
     * answer for each, in the order sent. The caller merges what moved into
     * the nodes it holds, as `withPlace` does for one.
     */
    function trashMany(workspaceId: string, nodeIds: string[]) {
        return api.trashBatch(workspaceId, nodeIds);
    }
    function restoreMany(workspaceId: string, nodeIds: string[]) {
        return api.restoreBatch(workspaceId, nodeIds);
    }
    /* Delete forever for a selection in this workspace's trash, in one request (api.ts purgeBatch). */
    function purgeMany(workspaceId: string, nodeIds: string[]) {
        return api.purgeBatch(workspaceId, nodeIds);
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
        // Names die with the keys; the mirror on disk is ciphertext and stays.
        generation++;
        building = undefined;
        catalogue.clear();
        catalogueWorkspace = null;
        catalogueCursor = 0;
        registry = null;
        setCatalogueState({ phase: 'idle', pulled: 0, opened: 0, error: null });
    }

    return {
        open,
        close,
        /* Whether the worker holds this node's key, so a caller can skip re-listing its folder. */
        isOpen: (nodeId: string) => openedNodes.has(nodeId),
        /* Whether this client has seen the node listed (which workspace holds it is known). */
        knows: (nodeId: string) => workspaceOf.has(nodeId),
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
        upgradeShares,
        revokeShare,
        mountShares,
        openShare,
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
        walkRotation,
        pendingRotation,
        changesSince,
        shareChangesSince,
        buildCatalogue,
        recheckIntegrity,
        catchUp,
        subscribeCatalogue,
        get catalogueState() {
            return catalogueState;
        },
        localListing,
        byTags,
        search,
        recent,
        ancestorsOf,
        tagCounts,
        tags,
        tagsOf,
        saveTags,
        setTags,
        /* Forgets the mirror on this device entirely, for a device being handed on. */
        forgetMirror: () => options.mirror?.clear() ?? Promise.resolve(),
        workspaceFor,
        trash,
        restore,
        trashMany,
        restoreMany,
        purgeMany,
        purge,
        emptyTrash,
        storageBreakdown,
        discardSupersededVersions,
        listTrash,
        capabilities: () => api.capabilities(),
    };
}

export type DriveClient = ReturnType<typeof createDriveClient>;
