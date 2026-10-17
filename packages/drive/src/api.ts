import type { WorkspaceKeyEnvelope } from '@hushos/crypto';
import type { Capabilities, DriveErrorCode } from './protocol';

/*
 * What the Drive client needs from the server. The web app implements it over the
 * shared Treaty client; a native client implements it over plain HTTP. Envelopes
 * are Base64url strings, byte counts decimal strings, dates ISO strings.
 */

/*
 * Who wrote a record: the account id alone. A client names a signer from its
 * own pins ("you", a checked contact's name) or says "someone you haven't
 * checked"; the signature is what it checks.
 */
export type Signer = { id: string };

export type VersionView = {
    id: string;
    objectId: string;
    /* 72 bytes under suite 1, 84 under suites 2 and 3, where it also seals the sizes. */
    contentKeyEnvelope: string;
    status: 'pending' | 'ready' | 'purged';
    objectStatus: 'pending' | 'ready' | 'missing';
    contentSuite: number;
    chunkSize: number;
    chunkCount: number;
    contentNonce: string;
    /* Suite 1 only; null under suite 2, where the client reads it from the envelope. */
    plaintextSize: string | null;
    ciphertextSize: string;
    readyAt: string | null;
    /*
     * The account that sealed the content-key envelope and its Ed25519 signature
     * over the version statement (docs/integrity-design.md); null before
     * signatures. Absent, not null, on what a link visitor receives: a visitor
     * has nothing to check them against.
     */
    signer?: Signer | null;
    signature?: string | null;
    /*
     * What a rotation kept of the version's writer (see RekeyView); null when no
     * rotation did, absent on what a link visitor receives and from servers
     * before re-keyed records.
     */
    rekey?: RekeyView | null;
};

/*
 * A re-keyed record (docs/integrity-design.md, "Re-keyed records"): the
 * envelope its writer signed (its origin), who the server says that writer is
 * and their signature, the key that opens the origin alone wrapped under the
 * node key at the node's key epoch, and the re-keyer's signature over the
 * binding. The re-keyer is the record's own signer (`metadataSigner`,
 * `signer`): whoever sealed the current envelope.
 */
export type RekeyView = {
    origin: { envelope: string; signer: Signer | null; signature: string; keyEnvelope: string };
    signature: string;
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
    /*
     * How the node's key and metadata envelopes are sealed. 1 today; a reader
     * refuses any other value rather than guess, so a later suite can sit
     * beside this one while a workspace is re-wrapped.
     */
    envelopeSuite: number;
    /*
     * The account that wrote the metadata envelope and its signature; null
     * before signatures. Absent, not null, on what a link visitor receives.
     */
    metadataSigner?: Signer | null;
    metadataSignature?: string | null;
    /* What a rotation kept of the metadata's writer, as on versions. */
    metadataRekey?: RekeyView | null;
};

export type NodeEnvelopes = {
    keyEpoch: number;
    parentKeyEpoch: number;
    keyEnvelope: string;
    metadataEnvelope: string;
    /* The writer's Ed25519 signature over the metadata statement, at metadata version 1. */
    metadataSignature: string;
};

export type WorkspaceView = {
    workspaceId: string;
    changeSeq: number;
    grant: WorkspaceKeyEnvelope | null;
    root: NodeView | null;
    /* A key rotation the owner's device has not finished; it resumes on the next open. */
    rotation: RotationView | null;
};

/* ------------------------------------------------------------------------- */
/* Rotation                                                                   */
/* ------------------------------------------------------------------------- */

/* `id` is served since 1c; servers before it sent only the node and the target. */
export type RotationView = { id?: string; nodeId: string; targetEpoch: number };

/* ------------------------------------------------------------------------- */
/* Change feeds                                                               */
/* ------------------------------------------------------------------------- */

/*
 * A feed is state, not a log: a node changed since the cursor appears once, as
 * it is now; a purged one appears as a tombstone naming its parent; a share's
 * feed adds the moves across its boundary. The cursor is the last sequence
 * examined, so a quiet poll costs one row.
 */
export type NodeChange =
    | { kind: 'node'; changeSeq: number; node: NodeView }
    | { kind: 'tombstone'; changeSeq: number; nodeId: string; parentId: string | null }
    | { kind: 'entered' | 'left'; changeSeq: number; nodeId: string };
/* `resync`: the cursor predates a deletion the server no longer keeps a tombstone for; start from zero. */
export type ChangeFeed = {
    changes: NodeChange[];
    nextCursor: number;
    hasMore: boolean;
    resync: boolean;
};
/*
 * A share's feed, as a grantee sees it: only changes inside the share (a
 * tombstone only for what was inside when it was purged), in order, with no
 * sequence numbers of the owner's anywhere, nodes included (`changeSeq` is
 * null). `cursor` is opaque and sealed by the server for this share: pass it
 * back as it came; none starts from the beginning, and one the server did not
 * seal for this share is refused with 400, after which the feed starts over.
 */
export type ShareChange =
    | { kind: 'node'; node: NodeView }
    | { kind: 'tombstone'; nodeId: string; parentId: string | null }
    | { kind: 'entered' | 'left'; nodeId: string };
export type ShareChangeFeed = {
    changes: ShareChange[];
    cursor: string;
    hasMore: boolean;
    /* As on the workspace feed: deletions were dropped since the cursor; start from none. */
    resync: boolean;
};
/* A sealed workspace document as the server holds it: kind, the version it is at, bytes. */
export type DocumentView = {
    kind: string;
    version: number;
    envelope: string;
    updatedAt: string;
    /* As on nodes: 1 today, and anything else is refused. */
    envelopeSuite: number;
};
/* A node the rotation still has to visit, with everything sealed under its key. */
export type RotationWorkNode = NodeView & {
    depth: number;
    versions: {
        id: string;
        objectId: string;
        contentKeyEnvelope: string;
        contentSuite: number;
        plaintextSize: string | null;
        /* Who signed the envelope being replaced. */
        signer: Signer | null;
        signature: string | null;
        /* The origin an earlier rotation kept, which this one carries. */
        rekey?: RekeyView | null;
    }[];
    /* Each live share with the grantee's served identity, for the owner's pin check before re-sealing. */
    shares: { id: string; granteeUserId: string; grantee: ServedIdentity }[];
    links: { id: string; hasPassword: boolean; secretEnvelope: string | null }[];
};
export type RotationWork = {
    rotation: RotationView;
    nodes: RotationWorkNode[];
    nextCursor: string | null;
    /* True once nothing is left and the rotation has been closed. */
    done: boolean;
};
export type RotateNodeWire = {
    id: string;
    changeSeq: number;
    parentKeyEpoch: number;
    keyEnvelope: string;
    rotated: {
        metadataEnvelope: string;
        /*
         * The rotating account's legacy signature over the node's unchanged metadata
         * version: optional beside `metadataRekey`, required without it.
         */
        metadataSignature?: string | null;
        metadataRekey?: RekeyWire | null;
        /* A legacy re-seal meant to drop the origin the record carries (it did not bind, or names nobody). */
        metadataDropOrigin?: boolean;
        versions: RotatedVersionWire[];
        shares: { id: string; shareEnvelope: string }[];
        links: { id: string; linkEnvelope: string; secretEnvelope: string }[];
        unsealableLinks: string[];
    } | null;
};
/*
 * A re-keyed record's part of a rotation: the origin's opening key wrapped
 * under the new node key, and the rekeyed statement's signature. The server
 * copies the origin itself from the record as it stands.
 */
export type RekeyWire = { originKeyEnvelope: string; signature: string };
export type RotatedVersionWire = {
    id: string;
    contentKeyEnvelope: string;
    signature?: string | null;
    rekey?: RekeyWire | null;
    dropOrigin?: boolean;
};
/* `unsupported`: a record signed in a form the server does not take there (see docs/integrity-design.md). */
export type RotateOutcome =
    | 'ok'
    | 'stale'
    | 'not-found'
    | 'parent-not-ready'
    | 'already'
    | 'bad-signature'
    | 'unsupported';

export type Listing = {
    folder: NodeView;
    ancestors: NodeView[];
    children: NodeView[];
    nextCursor: string | null;
};

export type TrashListing = {
    items: { node: NodeView; ancestors: NodeView[]; parentTrashed: boolean }[];
    nextCursor: string | null;
};

/* A server refusal the client can act on. */
export class DriveApiError extends Error {
    constructor(
        message: string,
        readonly code: DriveErrorCode | 'unavailable',
        readonly status: number,
        readonly data?: unknown,
    ) {
        super(message);
        this.name = 'DriveApiError';
    }
}

/*
 * Every id a client makes travels with the seed it was derived from
 * (`newId` in @hushos/crypto): the server derives it again with the kind and
 * the workspace of the request and refuses anything else with one answer, 400
 * "This id was not made for this workspace" (docs/integrity-design.md, "Ids
 * derived from a seed and a scope"). Seeds are 16 bytes, Base64url.
 */
export type UploadNodeInput =
    | ({ existing: false; id: string; idSeed: string; parentId: string } & NodeEnvelopes)
    | { existing: true; id: string; keyEpoch: number; expectedVersionId: string | null };

/* Either way a fresh envelope, signed over the version where it lands (the sibling's id, if so). */
export type UploadAttachInput =
    | { mode: 'same-node'; keyEpoch: number; contentKeyEnvelope: string; versionSignature: string }
    | {
          mode: 'sibling';
          node: { id: string; idSeed: string; parentId: string } & NodeEnvelopes;
          contentKeyEnvelope: string;
          versionSignature: string;
      };

export type UploadView = {
    id: string;
    nodeId: string;
    versionId: string;
    objectId: string | null;
    status: 'open' | 'completing' | 'conflicted' | 'completed' | 'aborted';
    chunkCount: number;
    ciphertextSize: string;
    expiresAt: string;
};

export type VersionListView = VersionView & {
    current: boolean;
    supersededAt: string | null;
    createdAt: string;
};

export type CopyInput = {
    sourceVersionId: string;
    node: { id: string; idSeed: string; parentId: string } & NodeEnvelopes;
    versionId: string;
    versionIdSeed: string;
    contentKeyEnvelope: string;
    /* Over the copy's node and version, the source version's object and its content suite. */
    versionSignature: string;
};

export type ShareRole = 'viewer' | 'editor';
export type ShareView = {
    id: string;
    role: ShareRole;
    keyEpoch: number;
    createdAt: string;
    /*
     * 1: sealed under X25519 alone; 2: hybrid, with ML-KEM-768 beside it; 3: an
     * ephemeral X25519 key and ML-KEM-768, signed by the granter with Ed25519; 4:
     * the same with the granter's hybrid signature. Only 4 is written or opened.
     */
    suite: 1 | 2 | 3 | 4;
    grantee: { id: string; name: string; email: string };
};
/* The grantee's identity as the server serves it, for the owner to check against a pin. */
/*
 * Someone's public identity as the server serves it (docs/identity-pq-design.md):
 * all four public keys and a version 2 identity's keys statement. A version 1
 * identity (not yet upgraded) has no ML-DSA key and no statement and is
 * trusted with nothing; only a version 3 pin vouches for any of these.
 */
export type ServedIdentity = {
    /* The identity's generation: a succession raises it, and a contact asks for the chain from a pin's. */
    keyVersion: number;
    identityVersion: 1 | 2;
    encryptionPublicKey: string;
    signingPublicKey: string;
    mlDsaPublicKey: string | null;
    kemPublicKey: string | null;
    keysSignature: string | null;
};
/* A share received: the node as a root of its own, and the granter's key to check against a pin. */
export type SharedWithMeView = {
    id: string;
    workspaceId: string;
    role: ShareRole;
    keyEpoch: number;
    shareEnvelope: string;
    prevShareEnvelope: string | null;
    prevKeyEpoch: number | null;
    createdAt: string;
    /* Where the share's feed starts: opaque and sealed, as the feed's own cursor. */
    cursor: string;
    /* The granter's current identity: the Ed25519 and ML-DSA keys a suite 4 share is checked against. */
    granter: { id: string; name: string; email: string } & ServedIdentity;
    node: NodeView;
};

export type LinkView = {
    id: string;
    keyEpoch: number;
    /* The owner's sealed copy of the secret and token; null for links made before it existed. */
    secretEnvelope: string | null;
    hasPassword: boolean;
    /* How the link's key is derived (see @hushos/crypto/links); a reader refuses any version it does not know. */
    kdfVersion: number;
    expiresAt: string | null;
    useCount: number;
    lastUsedAt: string | null;
    createdAt: string;
};
/* What a visitor holding the token receives; the fragment secret opens the envelope on their device. */
export type OpenedLink = {
    link: {
        id: string;
        workspaceId: string;
        keyEpoch: number;
        hasPassword: boolean;
        kdfVersion: number;
        linkSalt: string;
        linkEnvelope: string;
        expiresAt: string | null;
    };
    node: NodeView;
};

/*
 * The no-session surface a link visitor uses: the token names the link (sent in
 * the `x-link-token` header, never the path, so proxy logs do not keep it), and
 * every node or version asked for must lie beneath the linked node. Nodes and
 * versions come without signers or signatures, and without the owner's change
 * sequence.
 */
export interface LinkApi {
    open(token: string): Promise<OpenedLink>;
    children(token: string, parentId: string, after?: string): Promise<Listing>;
    downloadUrl(
        token: string,
        versionId: string,
    ): Promise<{ url: string; urlExpiresAt: string; node: NodeView; version: VersionView }>;
    downloadUrls(
        token: string,
        versionIds: string[],
    ): Promise<{ urls: { versionId: string; url: string }[]; urlExpiresAt: string }>;
    thumbnailUrls(token: string, versionIds: string[]): Promise<ThumbnailUrls>;
}

export type StorageBreakdown = {
    trashBytes: string;
    trashItems: number;
    supersededBytes: string;
    supersededVersions: number;
};

/*
 * Presigned GETs for the objects of ready versions. The server does not know
 * which have a thumbnail trailer; the client asks only for the ones whose
 * envelope says so, and fetches the trailer's range from the same URL.
 */
export type ThumbnailUrls = { urls: { versionId: string; url: string }[]; urlExpiresAt: string };

export type PartUrl = { partNumber: number; length: number; url: string };
export type PartUrls = { parts: PartUrl[]; urlExpiresAt: string };
export type StoredPart = { partNumber: number; etag: string; size: number };

export interface DriveApi {
    beginUpload(
        workspaceId: string,
        input: {
            node: UploadNodeInput;
            versionId: string;
            versionIdSeed: string;
            objectId: string;
            objectIdSeed: string;
            contentKeyEnvelope: string;
            /* The writer's signature over the version statement; the suite in it is 3. */
            versionSignature: string;
            contentNonce: string;
            contentSuite: number;
            chunkCount: number;
            /* The whole object, trailer included; the store must confirm it at complete. */
            ciphertextSize: string;
        },
    ): Promise<{ upload: UploadView } & PartUrls>;
    uploadState(
        workspaceId: string,
        uploadId: string,
    ): Promise<{ upload: UploadView; parts: StoredPart[] }>;
    uploadPartUrls(
        workspaceId: string,
        uploadId: string,
        from: number,
        count?: number,
    ): Promise<PartUrls>;
    completeUpload(
        workspaceId: string,
        uploadId: string,
        parts: { partNumber: number; etag: string }[],
    ): Promise<{ status: 'completed'; node: NodeView | null }>;
    attachUpload(
        workspaceId: string,
        uploadId: string,
        input: UploadAttachInput,
    ): Promise<{ status: 'completed'; node: NodeView | null }>;
    abortUpload(workspaceId: string, uploadId: string): Promise<{ aborted: boolean }>;
    downloadUrl(
        workspaceId: string,
        versionId: string,
    ): Promise<{ url: string; urlExpiresAt: string; node: NodeView; version: VersionView }>;
    downloadUrls(
        workspaceId: string,
        versionIds: string[],
    ): Promise<{ urls: { versionId: string; url: string }[]; urlExpiresAt: string }>;
    thumbnailUrls(workspaceId: string, versionIds: string[]): Promise<ThumbnailUrls>;
    capabilities(): Promise<Capabilities>;
    workspace(): Promise<WorkspaceView>;
    allocateEpochs(workspaceId: string, count: number): Promise<{ from: number; to: number }>;
    createRoot(
        workspaceId: string,
        input: { id: string; idSeed: string } & NodeEnvelopes,
    ): Promise<{ created: boolean; root: NodeView }>;
    children(workspaceId: string, parentId: string, after?: string): Promise<Listing>;
    createFolders(
        workspaceId: string,
        folders: ({ id: string; idSeed: string; parentId: string } & NodeEnvelopes)[],
    ): Promise<{ nodes: NodeView[]; changeSeq: number }>;
    rename(
        workspaceId: string,
        nodeId: string,
        input: {
            metadataVersion: number;
            keyEpoch: number;
            metadataEnvelope: string;
            /* Signed over `metadataVersion + 1`, the version the server stores. */
            metadataSignature: string;
        },
    ): Promise<{ node: NodeView }>;
    move(
        workspaceId: string,
        nodeId: string,
        input: { parentId: string; parentKeyEpoch: number; keyEnvelope: string },
    ): Promise<{ node: NodeView }>;
    trash(workspaceId: string, nodeId: string): Promise<{ node: NodeView }>;
    restore(
        workspaceId: string,
        nodeId: string,
        toRoot?: { parentKeyEpoch: number; keyEnvelope: string },
    ): Promise<{ node: NodeView }>;
    trashListing(workspaceId: string, after?: string): Promise<TrashListing>;
    purge(workspaceId: string, nodeId: string): Promise<{ purged: boolean }>;
    emptyTrash(workspaceId: string): Promise<{ purged: number; remaining: number }>;
    storageBreakdown(workspaceId: string): Promise<StorageBreakdown>;
    discardSupersededVersions(workspaceId: string): Promise<{ purged: number; remaining: number }>;
    copy(workspaceId: string, sourceNodeId: string, input: CopyInput): Promise<{ node: NodeView }>;
    versions(workspaceId: string, nodeId: string): Promise<{ versions: VersionListView[] }>;
    restoreVersion(workspaceId: string, versionId: string): Promise<{ node: NodeView }>;
    discardVersion(workspaceId: string, versionId: string): Promise<{ discarded: boolean }>;
    share(
        workspaceId: string,
        nodeId: string,
        input: { granteeUserId: string; role: ShareRole; keyEpoch: number; shareEnvelope: string },
    ): Promise<{ share: ShareView }>;
    nodeShares(workspaceId: string, nodeId: string): Promise<{ shares: ShareView[] }>;
    /* Replaces a live share's envelope at the current epoch with a suite 4 one; 409 for any other suite. */
    resealShare(
        workspaceId: string,
        shareId: string,
        input: { keyEpoch: number; shareEnvelope: string },
    ): Promise<{ resealed: true }>;
    revokeShare(workspaceId: string, shareId: string): Promise<{ revoked: boolean }>;
    sharedWithMe(): Promise<{ shares: SharedWithMeView[] }>;
    createLink(
        workspaceId: string,
        nodeId: string,
        input: {
            linkId: string;
            linkIdSeed: string;
            token: string;
            keyEpoch: number;
            linkEnvelope: string;
            linkSalt: string;
            secretEnvelope: string;
            hasPassword: boolean;
            expiresAt: string | null;
        },
    ): Promise<{ link: LinkView }>;
    updateLink(
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
    ): Promise<{ link: LinkView }>;
    /* Change feeds: the caller's workspace, and each share received (410 once it is revoked). */
    changes(workspaceId: string, since: number, limit?: number): Promise<ChangeFeed>;
    /* Sealed workspace documents, replaced whole; a write names the version it saw (0 for none) and is refused stale. */
    document(workspaceId: string, kind: string): Promise<{ document: DocumentView | null }>;
    putDocument(
        workspaceId: string,
        kind: string,
        input: { version: number; envelope: string },
    ): Promise<{ document: DocumentView }>;
    shareChanges(shareId: string, cursor?: string): Promise<ShareChangeFeed>;
    /* Rotation: start (or learn of the one running), fetch a batch of work, apply it. */
    startRotation(workspaceId: string, nodeId: string): Promise<{ rotation: RotationView }>;
    rotationWork(workspaceId: string, nodeId: string, after?: string | null): Promise<RotationWork>;
    rotateNodes(
        workspaceId: string,
        nodeId: string,
        nodes: RotateNodeWire[],
    ): Promise<{ results: { id: string; status: RotateOutcome }[] }>;
    nodeLinks(workspaceId: string, nodeId: string): Promise<{ links: LinkView[] }>;
    revokeLink(workspaceId: string, linkId: string): Promise<{ revoked: boolean }>;
    /* Everything the caller shares out, by account and by link, with the nodes to name them. */
    sharedByMe(): Promise<{
        shares: (ShareView & { node: NodeView; granteeIdentity: ServedIdentity })[];
        links: (LinkView & { node: NodeView })[];
    }>;
    /* Who a report is sealed to, and filing one; neither needs a session. */
    reportOperators(): Promise<{ operators: ReportOperator[] }>;
    report(input: ReportInput): Promise<{ report: { id: string }; duplicate: boolean }>;
}

/* ------------------------------------------------------------------------- */
/* Reports                                                                    */
/* ------------------------------------------------------------------------- */

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
export type ReportStatus = 'open' | 'dismissed' | 'removed' | 'filed';

/* An operator as the server serves them, for the reporter's device to seal to and check. */
export type ReportOperator = ServedIdentity & { userId: string };

export type ReportInput = {
    id: string;
    /* Derived in the reported item's workspace. */
    reportIdSeed: string;
    workspaceId: string;
    nodeId: string;
    keyEpoch: number;
    category: ReportCategory;
    reason: string;
    /* How the reporter can see the node: a link's token, or the share behind their session. */
    via: { link: string } | { share: true };
    reporterEmail: string | null;
    keys: { operatorUserId: string; keyEnvelope: string }[];
};

export type ReportView = {
    id: string;
    workspaceId: string;
    nodeId: string;
    nodeKind: 'folder' | 'file';
    keyEpoch: number;
    via: 'link' | 'share';
    category: ReportCategory;
    /* The reporter's own words; null once released, when it is cleared with who reported it. */
    reason: string | null;
    reporter: { userId: string | null; email: string | null };
    uploader: { userId: string | null; email: string | null; suspended: boolean };
    status: ReportStatus;
    heldAt: string | null;
    /* Closed without a hold: its keys are gone and it can no longer be opened, held or reopened. */
    releasedAt: string | null;
    evidenceStatus: 'pending' | 'copied' | 'skipped' | 'failed' | 'purged';
    itemCount: number;
    itemsTruncated: boolean;
    filedWith: string | null;
    filedReference: string | null;
    resolvedAt: string | null;
    createdAt: string;
    updatedAt: string;
};

export type ReportEventView = {
    id: string;
    actorUserId: string | null;
    action: string;
    note: string | null;
    createdAt: string;
};

export type ReportResolution =
    | { status: 'dismissed'; hold: boolean }
    | { status: 'removed'; hold: boolean }
    | { status: 'filed'; filedWith: string; filedReference: string | null };

/*
 * The operator's surface: reads answered from the report's snapshot, so they
 * work after the owner has purged the tree, and the node key sealed to this
 * operator, opened on their device under their own identity.
 */
export interface ReportApi {
    list(filter: {
        status?: ReportStatus | 'all' | 'held';
        category?: ReportCategory;
    }): Promise<{ reports: ReportView[]; counts: { open: number; held: number; total: number } }>;
    get(reportId: string): Promise<{ report: ReportView; events: ReportEventView[] }>;
    open(
        reportId: string,
    ): Promise<{ report: ReportView; node: NodeView; keyEnvelope: string | null }>;
    children(reportId: string, parentId: string): Promise<Listing>;
    downloadUrl(
        reportId: string,
        versionId: string,
    ): Promise<{ url: string; urlExpiresAt: string; node: NodeView; version: VersionView }>;
    downloadUrls(
        reportId: string,
        versionIds: string[],
    ): Promise<{ urls: { versionId: string; url: string }[]; urlExpiresAt: string }>;
    thumbnailUrls(reportId: string, versionIds: string[]): Promise<ThumbnailUrls>;
    resolve(reportId: string, resolution: ReportResolution): Promise<{ report: ReportView }>;
    hold(reportId: string, held: boolean): Promise<{ report: ReportView }>;
    reopen(reportId: string): Promise<{ report: ReportView }>;
    suspendUploader(reportId: string, suspended: boolean): Promise<{ report: ReportView }>;
    note(reportId: string, note: string): Promise<{ event: ReportEventView }>;
    /* Asks the worker, which alone holds the evidence store's credentials, for URLs to the copies. */
    requestEvidence(reportId: string): Promise<{ request: EvidenceRequestView }>;
    evidenceRequest(reportId: string, requestId: string): Promise<{ request: EvidenceRequestView }>;
    /* Puts a packet download on the record. */
    recordPacket(reportId: string): Promise<{ event: ReportEventView }>;
    /* Who can open the report today, and sealing it to operators promoted since it was filed. */
    keyHolders(reportId: string): Promise<{ operators: (ReportOperator & { sealed: boolean })[] }>;
    reseal(
        reportId: string,
        keys: { operatorUserId: string; keyEnvelope: string }[],
    ): Promise<{ added: number }>;
}

export type EvidenceRequestView = {
    id: string;
    status: 'pending' | 'ready' | 'failed';
    /* By version id, once ready. */
    urls: Record<string, string> | null;
    urlExpiresAt: string | null;
    error: string | null;
    createdAt: string;
};
