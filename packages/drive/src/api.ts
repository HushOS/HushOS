import type { WorkspaceKeyEnvelope } from '@hushos/crypto';
import type { Capabilities, DriveErrorCode } from './protocol';

/*
 * What the Drive client needs from the server. The web app implements it over the
 * shared Treaty client; a native client implements it over plain HTTP. Envelopes
 * are Base64url strings, byte counts decimal strings, dates ISO strings.
 */

export type VersionView = {
    id: string;
    objectId: string;
    /* 72 bytes under suite 1, 84 under suite 2, where it also seals the sizes. */
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

export type NodeEnvelopes = {
    keyEpoch: number;
    parentKeyEpoch: number;
    keyEnvelope: string;
    metadataEnvelope: string;
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

export type RotationView = { nodeId: string; targetEpoch: number };

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
export type ChangeFeed = { changes: NodeChange[]; nextCursor: number; hasMore: boolean };
/* A node the rotation still has to visit, with everything sealed under its key. */
export type RotationWorkNode = NodeView & {
    depth: number;
    versions: {
        id: string;
        objectId: string;
        contentKeyEnvelope: string;
        contentSuite: number;
        plaintextSize: string | null;
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
        versions: { id: string; contentKeyEnvelope: string }[];
        shares: { id: string; shareEnvelope: string }[];
        links: { id: string; linkEnvelope: string; secretEnvelope: string }[];
        unsealableLinks: string[];
    } | null;
};
export type RotateOutcome = 'ok' | 'stale' | 'not-found' | 'parent-not-ready' | 'already';

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

export type UploadNodeInput =
    | ({ existing: false; id: string; parentId: string } & NodeEnvelopes)
    | { existing: true; id: string; keyEpoch: number; expectedVersionId: string | null };

export type UploadAttachInput =
    | { mode: 'same-node'; keyEpoch: number; contentKeyEnvelope: string }
    | {
          mode: 'sibling';
          node: { id: string; parentId: string } & NodeEnvelopes;
          contentKeyEnvelope: string;
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
    node: { id: string; parentId: string } & NodeEnvelopes;
    versionId: string;
    contentKeyEnvelope: string;
};

export type ShareRole = 'viewer' | 'editor';
export type ShareView = {
    id: string;
    role: ShareRole;
    keyEpoch: number;
    createdAt: string;
    /* 1: sealed under X25519 alone; 2: hybrid, with ML-KEM-768 beside it. */
    suite: 1 | 2;
    grantee: { id: string; name: string; email: string };
};
/* The grantee's identity as the server serves it, for the owner to check against a pin. */
export type ServedIdentity = {
    encryptionPublicKey: string;
    signingPublicKey: string;
    kem: { publicKey: string; signature: string } | null;
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
    /* The owner's workspace sequence as of this listing: where the share's feed starts. */
    changeSeq: number;
    granter: { id: string; name: string; email: string; encryptionPublicKey: string };
    node: NodeView;
};

export type LinkView = {
    id: string;
    keyEpoch: number;
    /* The owner's sealed copy of the secret and token; null for links made before it existed. */
    secretEnvelope: string | null;
    hasPassword: boolean;
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
        linkSalt: string;
        linkEnvelope: string;
        expiresAt: string | null;
    };
    node: NodeView;
};

/*
 * The no-session surface a link visitor uses: the token names the link, and
 * every node or version asked for must lie beneath the linked node.
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
            objectId: string;
            contentKeyEnvelope: string;
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
        input: { id: string } & NodeEnvelopes,
    ): Promise<{ created: boolean; root: NodeView }>;
    children(workspaceId: string, parentId: string, after?: string): Promise<Listing>;
    createFolders(
        workspaceId: string,
        folders: ({ id: string; parentId: string } & NodeEnvelopes)[],
    ): Promise<{ nodes: NodeView[]; changeSeq: number }>;
    rename(
        workspaceId: string,
        nodeId: string,
        input: { metadataVersion: number; keyEpoch: number; metadataEnvelope: string },
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
    /* Replaces a live share's envelope at the current epoch: how a suite 1 share becomes hybrid. */
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
    shareChanges(shareId: string, since: number): Promise<ChangeFeed>;
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

export type ReportOperator = { userId: string; publicKey: string };

export type ReportInput = {
    id: string;
    workspaceId: string;
    nodeId: string;
    keyEpoch: number;
    category: ReportCategory;
    reason: string;
    /* How the reporter can see the node: a link's token, or the share behind their session. */
    via: { link: string } | { share: true };
    reporterEmail: string | null;
    contentHash: string | null;
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
    reason: string;
    reporter: { userId: string | null; email: string | null };
    uploader: { userId: string | null; email: string | null; suspended: boolean };
    contentHash: string | null;
    status: ReportStatus;
    heldAt: string | null;
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
        status?: ReportStatus | 'all';
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
