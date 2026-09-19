import { CryptoError } from './errors';
import { checkPassword } from './password';
import {
    createSecurityChange,
    type SecurityAction,
    type SecurityChallenge,
    type SecurityUpdate,
} from './security';
import {
    addIdentityKem,
    createIdentity,
    openIdentityEncryptionKey,
    openIdentityKemKey,
    verifyKemBinding,
    type IdentityEnvelope,
    type IdentityKem,
} from './identity';
import { openSettings, sealSettings, type Settings, type SettingsEnvelope } from './contacts';
import { openShareKey, sealShareKey } from './shares';
import { openReportKey, sealReportKey } from './reports';
import { KEM_PUBLIC_KEY_BYTES } from './pq';
import {
    generateLinkSalt,
    generateLinkSecret,
    openLinkKey,
    openLinkSecret,
    passwordKey,
    sealLinkKeyWith,
    sealLinkSecret,
} from './links';
import {
    createRecovery,
    openRecovery,
    readRecoveryPhrase,
    signRecoveryReset,
    type RecoveryEnvelope,
} from './recovery';
import { rememberAccountKey, restoreAccountKey, type RememberedAccount } from './device';
import { createWorkspaceGrant, openWorkspaceKey, type WorkspaceKeyEnvelope } from './workspace';
import {
    CHUNK_SIZE,
    CONTENT_SUITE,
    chunkCount,
    chunkDigest,
    chunkRange,
    ciphertextSize,
    decryptChunk,
    decryptThumbnail,
    encryptChunk,
    encryptThumbnail,
    generateContentNonce,
    generateKey,
    KEY_ENVELOPE_BYTES,
    LEGACY_CONTENT_SUITE,
    openMetadata,
    openNodeKey,
    openVersion,
    sealMetadata,
    sealVersion,
    THUMBNAIL_MAX_BYTES,
    thumbnailRange,
    trailerLength,
    VERSION_ENVELOPE_BYTES,
    wrapNodeKey,
    type NodeMetadata,
    sealDocument,
    openDocument,
} from './drive';
import { client, ready } from '@serenity-kit/opaque';
import { encryptKey, decryptKey } from './aead';
import { encode, decode, wrappingKey, checkProfile } from './keys';
import {
    accountKeyContext,
    ENVELOPE_VERSION,
    KEY_STRETCHING,
    OPAQUE_IDENTIFIERS,
    type AccountKeyEnvelope,
} from './protocol';

export type CryptoRequests = {
    securityStart: { password: string; newPassword?: string; action: SecurityAction };
    securityFinish: SecurityChallenge;
    initialize: {
        userId: string;
        recovery: boolean;
        identity: boolean;
        workspace?: { id: string };
    };
    remember: {
        deviceKey: CryptoKey;
        identity: Omit<RememberedAccount, 'nonce' | 'encryptedKey' | 'version'>;
    };
    restore: { deviceKey: CryptoKey; bundle: RememberedAccount };
    backup: { userId: string; recovery: RecoveryEnvelope };
    registerStart: { password: string };
    recoverFinish: {
        registrationResponse: string;
        userId: string;
        profileVersion: number;
        credentialVersion: number;
        attemptToken: string;
        recovery: RecoveryEnvelope;
        phrase: string;
    };
    registerFinish: { registrationResponse: string; userId: string; profileVersion: number };
    loginStart: { password: string };
    loginFinish: { loginResponse: string; profileVersion: number };
    unlock: { userId: string; envelope: AccountKeyEnvelope };
    /*
     * Identity: opens the X25519 private key under the unlocked account and keeps
     * it for the session (it dies with a lock). Settings are sealed under a key
     * derived from it, so every device that unlocks reads the same pins.
     */
    /* `refresh` re-reads an envelope already open, after the KEM key was added on the server. */
    identityOpen: { userId: string; identity: IdentityEnvelope; refresh?: boolean };
    /* An identity made before hybrid sharing gets its KEM key: minted, wrapped and signed; installed by the next open. */
    identityMintKem: { userId: string; identity: IdentityEnvelope };
    /* Whether a contact's served KEM key is vouched for by their signing key; pure, needs no unlock. */
    identityVerifyKem: {
        userId: string;
        encryptionPublicKey: string;
        signingPublicKey: string;
        kem: { publicKey: string; signature: string };
    };
    settingsOpen: { userId: string; envelope: SettingsEnvelope };
    settingsSeal: { userId: string; settingsVersion: number; settings: Settings };
    /*
     * Shares. Seal wraps an open node key to a contact's identity key under the
     * granter's own; open unwraps a share received, with the granter's public
     * key the caller has checked against its pin, and keeps the node key so the
     * subtree opens like any other.
     */
    driveSealShare: {
        workspaceId: string;
        nodeId: string;
        keyEpoch: number;
        granterUserId: string;
        granteeUserId: string;
        granteePublicKey: string;
        /* The grantee's KEM key, checked against their pin by the caller; null seals suite 1. */
        granteeKemPublicKey?: string | null;
    };
    driveOpenShare: {
        workspaceId: string;
        nodeId: string;
        keyEpoch: number;
        granterUserId: string;
        granterPublicKey: string;
        granteeUserId: string;
        shareEnvelope: string;
        /* During the owner's rotation: the previous node key too, to reach children not yet rotated. */
        prevShareEnvelope?: string | null;
        prevKeyEpoch?: number | null;
    };
    /*
     * Links. Seal mints the secret that goes in the URL fragment and, with an
     * optional password, seals an open node key for anyone holding the link;
     * open does the reverse for a visitor, with no account unlocked, and keeps
     * the node key so the subtree opens like any other.
     */
    driveSealLink: {
        workspaceId: string;
        nodeId: string;
        keyEpoch: number;
        linkId: string;
        password: string | null;
    };
    driveOpenLink: {
        workspaceId: string;
        nodeId: string;
        keyEpoch: number;
        linkId: string;
        secret: string;
        password: string | null;
        salt: string;
        linkEnvelope: string;
    };
    /*
     * Reports. Seal wraps an open node key to every current operator's identity
     * key, with no account of the reporter's involved; open is the operator
     * unwrapping it under their own identity and keeping the node key so the
     * reported subtree opens like any other.
     */
    driveSealReport: {
        workspaceId: string;
        nodeId: string;
        keyEpoch: number;
        reportId: string;
        /* Each operator's identity as the server served it; a KEM key is used only if its binding verifies. */
        operators: {
            userId: string;
            encryptionPublicKey: string;
            signingPublicKey: string;
            kem: { publicKey: string; signature: string } | null;
        }[];
    };
    driveOpenReport: {
        workspaceId: string;
        nodeId: string;
        keyEpoch: number;
        reportId: string;
        operatorUserId: string;
        keyEnvelope: string;
    };
    /* The owner reads a link's secret and token back from the envelope sealed under the node key. */
    driveLinkSecret: {
        workspaceId: string;
        nodeId: string;
        keyEpoch: number;
        linkId: string;
        secretEnvelope: string;
    };
    /* Seals the same secret again with another password (or none): the link itself does not change. */
    driveResealLink: {
        workspaceId: string;
        nodeId: string;
        keyEpoch: number;
        linkId: string;
        secretEnvelope: string;
        password: string | null;
    };
    /*
     * Rotation: a fresh key for each node in the batch (parents before children,
     * the parent already at the target epoch or outside the rotation), the old key
     * kept beside it so unrotated children still open; metadata, every version's
     * content key, every live share and every link re-sealed under the new key.
     * Objects are not touched.
     */
    driveRotateNodes: {
        workspaceId: string;
        targetEpoch: number;
        granterUserId: string | null;
        nodes: RotateNodeInput[];
    };
    /* Drive: opens the workspace key from the member's grant and keeps it in the worker. */
    driveOpenWorkspace: { userId: string; grant: WorkspaceKeyEnvelope };
    /* A workspace document (the tag registry) sealed under the open workspace key, bound to the version it becomes. */
    driveSealDocument: { workspaceId: string; kind: string; version: number; document: unknown };
    driveOpenDocument: { workspaceId: string; kind: string; version: number; envelope: string };
    /*
     * Creates nodes in order: a fresh key each, wrapped under the parent's key, and
     * the metadata sealed under the new key. A parent is the workspace id (the root),
     * a node opened earlier, or an earlier node in the same batch.
     */
    driveCreateNodes: { workspaceId: string; nodes: DriveNodeInput[] };
    /* Opens node keys and metadata, parents before children; keys stay cached. */
    driveOpenNodes: { workspaceId: string; nodes: DriveNodeEnvelopes[] };
    driveSealMetadata: {
        workspaceId: string;
        nodeId: string;
        metadataVersion: number;
        metadata: NodeMetadata;
    };
    /* The same node key rewrapped under another parent's key, for a move. */
    driveRewrapNode: {
        workspaceId: string;
        nodeId: string;
        parentId: string;
        parentKeyEpoch: number;
        keyEpoch: number;
    };
    /*
     * Uploads. Prepare mints the content key and nonce for one object and wraps the
     * key under the file's node key (opened or created earlier); the key stays here.
     * Each part is read from the File, encrypted and PUT from this worker, with
     * progress posted as it goes; the main thread never sees a byte of it.
     */
    driveUploadPrepare: {
        workspaceId: string;
        nodeId: string;
        versionId: string;
        objectId: string;
        plaintextSize: number;
        /* The rendered thumbnail, sealed here as the object's trailer; null or empty for none. */
        thumbnail?: Uint8Array | null;
    };
    /*
     * Reopen reinstates an upload after a reload or a lock from what the journal
     * kept: the content-key envelope opens under the file's node key (opened first),
     * and the nonce comes back with it. Nothing new is minted, which is the point:
     * the missing chunks are re-encrypted under the same key and nonce and come out
     * byte for byte the same.
     */
    driveUploadReopen: {
        workspaceId: string;
        nodeId: string;
        versionId: string;
        objectId: string;
        contentSuite: number;
        contentKeyEnvelope: string;
        contentNonce: string;
        plaintextSize: number;
        /* The sealed trailer the journal kept from prepare; must match what the envelope promises. */
        thumbnail: Uint8Array | null;
    };
    /*
     * Rewrap wraps a prepared or reopened upload's content key under another node
     * key (opened or created first), for attaching a conflicted upload to a fresh
     * sibling or to the same node after a key rotation. Nothing new is minted.
     */
    driveUploadRewrap: { workspaceId: string; objectId: string; nodeId: string; versionId: string };
    /* The plaintext digest of one chunk, to prove a re-read file is the one that was journaled. */
    driveUploadDigest: { objectId: string; file: Blob; index: number };
    /*
     * Copy within a workspace: a new file node with a fresh key under the
     * destination, its metadata sealed, and the source version's content key
     * (opened under the source node's key, which must be open) wrapped again
     * under the new node key for the new version. The object is shared, so the
     * key it was encrypted under is the one thing that must not change.
     */
    driveCopyFile: {
        workspaceId: string;
        source: { nodeId: string } & DriveVersionEnvelope;
        node: {
            id: string;
            parentId: string;
            parentKeyEpoch: number;
            keyEpoch: number;
            metadata: NodeMetadata;
        };
        versionId: string;
    };
    /*
     * A thumbnail is the trailer of its version's object. Fetch opens the version
     * envelope to learn where the trailer is and how long, fetches that range from
     * the object's URL, derives the thumbnail key and decrypts it here.
     */
    driveThumbnailFetch: {
        workspaceId: string;
        nodeId: string;
        version: DriveVersionEnvelope;
        contentNonce: string;
        url: string;
    };
    /* The sizes sealed in versions of one open node, for a versions list. */
    driveOpenVersions: { workspaceId: string; nodeId: string; versions: DriveVersionEnvelope[] };
    /* Encrypts one chunk and keeps the ciphertext here until it is sent or dropped. */
    driveUploadEncrypt: { objectId: string; file: Blob; index: number };
    /* PUTs a chunk encrypted earlier; progress is posted as it goes. */
    driveUploadSend: { objectId: string; index: number; url: string };
    driveUploadCancel: { objectId: string; index?: number };
    driveUploadForget: { objectId: string };
    /*
     * Downloads. Open unwraps a version's content key under the file's node key
     * (opened by listing its folder); each chunk is fetched by range from the
     * presigned URL and decrypted here, and the plaintext goes back to the caller,
     * which is the only place a file can be written or shown.
     */
    driveDownloadOpen: {
        workspaceId: string;
        nodeId: string;
        version: DriveVersionEnvelope;
        contentNonce: string;
    };
    driveDownloadChunk: { objectId: string; url: string; index: number };
    driveDownloadClose: { objectId: string };
    /*
     * The raw keys of one node, for the person who owns them: the node key and,
     * for a file version, its content key and nonce. Nothing is cached or
     * changed; the caller asked to see what protects an item, and gets exactly
     * that, encoded, to show or to save as a key file.
     */
    driveExportKeys: {
        workspaceId: string;
        nodeId: string;
        version: (DriveVersionEnvelope & { contentNonce: string }) | null;
    };
};
export type DriveNodeInput = {
    id: string;
    parentId: string;
    parentKeyEpoch: number;
    keyEpoch: number;
    metadata: NodeMetadata;
};
/* A version as the server hands it over: the envelope, its object's suite, and suite 1's size on the row. */
export type DriveVersionEnvelope = {
    id: string;
    objectId: string;
    contentKeyEnvelope: string;
    contentSuite: number;
    /* Suite 1 only; null under suite 2, where the envelope carries it. */
    plaintextSize: number | null;
};
/* What the version envelope told us: the size of the file and of its thumbnail trailer. */
export type DriveContentInfo = { plaintextSize: number; thumbnailBytes: number };
export type DriveNodeEnvelopes = {
    id: string;
    parentId: string;
    parentKeyEpoch: number;
    keyEpoch: number;
    keyEnvelope: string;
    metadataVersion: number;
    metadataEnvelope: string;
    /* Present while a rotation runs: the previous key, at its epoch, under the previous parent key. */
    prevKeyEnvelope?: string | null;
    prevKeyEpoch?: number | null;
    prevParentKeyEpoch?: number | null;
    /* The current version, when the caller wants its sizes opened along with the name. */
    version?: DriveVersionEnvelope | null;
};
export type RotateNodeInput = {
    id: string;
    parentId: string;
    /* The parent's key epoch to wrap the new key under: the target for a rotated parent, its own for the root's outside parent. */
    parentKeyEpoch: number;
    /* The node as it is now: its key's epoch and the parent epoch its envelope was wrapped under. */
    keyEpoch: number;
    wrappedParentKeyEpoch: number;
    keyEnvelope: string;
    metadataVersion: number;
    metadataEnvelope: string;
    versions: DriveVersionEnvelope[];
    shares: {
        id: string;
        granteeUserId: string;
        granteePublicKey: string;
        granteeKemPublicKey: string | null;
    }[];
    links: { id: string; hasPassword: boolean; secretEnvelope: string | null }[];
};
export type RotatedNode =
    | {
          id: string;
          keyEnvelope: string;
          metadataEnvelope: string;
          versions: { id: string; contentKeyEnvelope: string }[];
          shares: { id: string; shareEnvelope: string }[];
          links: (
              | { id: string; linkEnvelope: string; secretEnvelope: string }
              | { id: string; unsealable: true }
          )[];
          /* The key was already at the target and was only wrapped under its rotated parent. */
          rewrap?: true;
          error?: undefined;
      }
    | { id: string; error: string };
export type DriveOpenedNode =
    | { id: string; metadata: NodeMetadata; content?: DriveContentInfo | null; error?: undefined }
    | { id: string; metadata?: undefined; content?: undefined; error: string };
export type DriveOpenedVersion =
    | ({ id: string; error?: undefined } & DriveContentInfo)
    | { id: string; error: string };
export type CryptoResults = {
    securityStart: { startLoginRequest: string; registrationRequest: string };
    securityFinish: SecurityUpdate;
    initialize: {
        recovery?: RecoveryEnvelope;
        identity?: IdentityEnvelope;
        workspace?: WorkspaceSetup;
    };
    backup: { phrase: string };
    recoverFinish: {
        registrationRecord: string;
        envelope: AccountKeyEnvelope;
        recovery: RecoveryEnvelope;
        signature: string;
    };
    remember: RememberedAccount;
    restore: { userId: string };
    registerStart: { registrationRequest: string };
    registerFinish: {
        registrationRecord: string;
        envelope: AccountKeyEnvelope;
        recovery: RecoveryEnvelope;
        identity: IdentityEnvelope;
        workspace: WorkspaceSetup;
    };
    loginStart: { startLoginRequest: string };
    loginFinish: { finishLoginRequest: string };
    unlock: { userId: string };
    identityOpen: { encryptionPublicKey: string; kemPublicKey: string | null };
    identityMintKem: { kem: IdentityKem };
    identityVerifyKem: { valid: boolean };
    settingsOpen: { settings: Settings };
    settingsSeal: { envelope: SettingsEnvelope };
    driveSealShare: { shareEnvelope: string };
    driveOpenShare: { opened: true };
    driveSealLink: {
        linkEnvelope: string;
        secret: string;
        token: string;
        salt: string;
        secretEnvelope: string;
    };
    driveOpenLink: { opened: true };
    driveSealReport: { envelopes: { userId: string; keyEnvelope: string }[] };
    driveOpenReport: { opened: true };
    driveLinkSecret: { secret: string; token: string };
    driveResealLink: { linkEnvelope: string; salt: string; secretEnvelope: string };
    driveRotateNodes: { nodes: RotatedNode[] };
    driveOpenWorkspace: { workspaceId: string; workspaceKeyVersion: number };
    driveSealDocument: { envelope: string };
    driveOpenDocument: { document: unknown };
    driveCreateNodes: { nodes: { id: string; keyEnvelope: string; metadataEnvelope: string }[] };
    driveOpenNodes: { nodes: DriveOpenedNode[] };
    driveSealMetadata: { metadataEnvelope: string };
    driveRewrapNode: { keyEnvelope: string };
    driveUploadPrepare: {
        contentNonce: string;
        contentKeyEnvelope: string;
        chunkCount: number;
        /* The whole object, trailer included: what begin declares and the store must confirm. */
        ciphertextSize: number;
        /* The sealed trailer, for the journal; null when the file has no thumbnail. */
        thumbnail: Uint8Array | null;
    };
    driveUploadReopen: { chunkCount: number; ciphertextSize: number };
    driveUploadDigest: { digest: string };
    driveUploadEncrypt: { digest: string; bytes: number };
    driveUploadSend: UploadPartResult;
    driveUploadCancel: { cancelled: number };
    driveUploadForget: { forgotten: boolean };
    driveUploadRewrap: { contentKeyEnvelope: string };
    driveCopyFile: { keyEnvelope: string; metadataEnvelope: string; contentKeyEnvelope: string };
    driveThumbnailFetch: { plaintext: Uint8Array };
    driveOpenVersions: { versions: DriveOpenedVersion[] };
    driveDownloadOpen: { chunkCount: number } & DriveContentInfo;
    driveDownloadChunk: DownloadChunkResult;
    driveDownloadClose: { closed: boolean };
    driveExportKeys: {
        nodeKey: string;
        keyEpoch: number;
        content: ({ key: string; nonce: string } & DriveContentInfo) | null;
    };
};
export type DownloadChunkResult =
    | { ok: true; plaintext: Uint8Array; index: number }
    | { ok: false; status: number; retryable: boolean; message: string };
export type DownloadChunkProgress = {
    objectId: string;
    index: number;
    loaded: number;
    total: number;
    kind: 'download';
};
export type UploadPartResult =
    | { ok: true; etag: string; bytes: number }
    | { ok: false; status: number; retryable: boolean; message: string; cancelled?: boolean };
export type UploadPartProgress = { objectId: string; index: number; loaded: number; total: number };
/* Hooks a host may pass to `handle`; only transfers use them. */
export type SessionHooks = {
    progress?: (value: UploadPartProgress | DownloadChunkProgress) => void;
};
/* A personal workspace chosen by the client: its id and the creator's grant. */
export type WorkspaceSetup = { id: string; grant: WorkspaceKeyEnvelope };
type Message = {
    [K in keyof CryptoRequests]: { id: number; operation: K; input: CryptoRequests[K] };
}[keyof CryptoRequests];

export function createCryptoSession() {
    const security = createSecurityChange();
    let generation = 0;
    let queue = Promise.resolve();
    const pending = new Set<(error: Error) => void>();
    let accountKeyVersion = 1;
    let password = '';
    let state = '';
    let phase: 'idle' | 'register' | 'login' | 'unlock' = 'idle';
    let exportKey = '';
    let accountKey: Uint8Array<ArrayBuffer> | undefined;
    let unlockedUserId: string | null = null;
    // Drive keys, opened on demand and kept for the session; every one dies with a lock.
    const workspaceKeys = new Map<string, { key: Uint8Array<ArrayBuffer>; version: number }>();
    const nodeKeys = new Map<string, { key: Uint8Array<ArrayBuffer>; epoch: number }>();
    /* Previous node keys while a rotation runs: what children not yet rotated are still wrapped under. */
    const prevNodeKeys = new Map<string, { key: Uint8Array<ArrayBuffer>; epoch: number }>();
    let identityKey:
        | {
              userId: string;
              key: Uint8Array<ArrayBuffer>;
              publicKey: string;
              kem: { publicKey: string; secretKey: Uint8Array<ArrayBuffer> } | null;
          }
        | undefined;
    function forgetIdentity() {
        identityKey?.key.fill(0);
        identityKey?.kem?.secretKey.fill(0);
        identityKey = undefined;
    }
    type Upload = {
        workspaceId: string;
        contentKey: Uint8Array<ArrayBuffer>;
        contentNonce: Uint8Array<ArrayBuffer>;
        plaintextSize: number;
        chunkCount: number;
        thumbnailBytes: number;
        /* The sealed trailer, appended to the last chunk when it is encrypted. */
        thumbnail: Uint8Array<ArrayBuffer> | null;
        requests: Map<number, XMLHttpRequest>;
        /* Encrypted, journaled, not yet sent. Bounded by the caller's pool of parts in flight. */
        encrypted: Map<number, Uint8Array<ArrayBuffer>>;
    };
    const uploads = new Map<string, Upload>();
    type Download = {
        workspaceId: string;
        suite: number;
        contentKey: Uint8Array<ArrayBuffer>;
        contentNonce: Uint8Array<ArrayBuffer>;
        plaintextSize: number;
        chunkCount: number;
        controllers: Map<number, AbortController>;
    };
    const downloads = new Map<string, Download>();

    function closeDownload(objectId: string) {
        const download = downloads.get(objectId);
        if (!download) return false;
        for (const controller of download.controllers.values()) controller.abort();
        download.contentKey.fill(0);
        downloads.delete(objectId);
        return true;
    }

    function forgetUpload(objectId: string) {
        const upload = uploads.get(objectId);
        if (!upload) return false;
        for (const request of upload.requests.values()) request.abort();
        for (const chunk of upload.encrypted.values()) chunk.fill(0);
        upload.encrypted.clear();
        upload.thumbnail?.fill(0);
        upload.contentKey.fill(0);
        uploads.delete(objectId);
        return true;
    }
    /*
     * Opens a version's envelope under an open node key: the content key, the
     * plaintext size (from the envelope under suite 2, from the row under suite 1)
     * and the trailer's length. The caller owns the key it gets back.
     */
    async function openVersionUnder(
        nodeKey: Uint8Array,
        workspaceId: string,
        nodeId: string,
        version: DriveVersionEnvelope,
    ) {
        const suite = version.contentSuite;
        const opened = await openVersion(
            decode(
                version.contentKeyEnvelope,
                suite === LEGACY_CONTENT_SUITE ? KEY_ENVELOPE_BYTES : VERSION_ENVELOPE_BYTES,
            ),
            nodeKey,
            { workspaceId, nodeId, versionId: version.id, objectId: version.objectId, suite },
        );
        const plaintextSize = opened.plaintextSize ?? version.plaintextSize;
        if (plaintextSize === null || !Number.isSafeInteger(plaintextSize) || plaintextSize < 0) {
            opened.contentKey.fill(0);
            throw new CryptoError('This file has no size on record.');
        }
        return {
            contentKey: opened.contentKey as Uint8Array<ArrayBuffer>,
            plaintextSize,
            thumbnailBytes: opened.thumbnailBytes,
            suite,
        };
    }
    async function readChunk(upload: Upload, file: Blob, index: number) {
        if (file.size !== upload.plaintextSize)
            throw new CryptoError('The file changed since the upload started.');
        const start = index * CHUNK_SIZE;
        const end = Math.min(upload.plaintextSize, start + CHUNK_SIZE);
        return new Uint8Array(await file.slice(start, end).arrayBuffer());
    }
    function forgetDriveKeys() {
        forgetIdentity();
        for (const entry of workspaceKeys.values()) entry.key.fill(0);
        for (const entry of nodeKeys.values()) entry.key.fill(0);
        for (const entry of prevNodeKeys.values()) entry.key.fill(0);
        prevNodeKeys.clear();
        for (const objectId of uploads.keys()) forgetUpload(objectId);
        for (const objectId of downloads.keys()) closeDownload(objectId);
        workspaceKeys.clear();
        nodeKeys.clear();
    }
    /* The key a node is wrapped under: the workspace key for the root, else its parent's. */
    function parentKeyFor(workspaceId: string, parentId: string, parentKeyEpoch: number) {
        if (parentId === workspaceId) {
            const workspace = workspaceKeys.get(workspaceId);
            if (!workspace) throw new CryptoError('Open Drive again to continue.');
            if (workspace.version !== parentKeyEpoch)
                throw new CryptoError('This folder was wrapped under an older workspace key.');
            return workspace.key;
        }
        const parent = nodeKeys.get(parentId);
        if (!parent) throw new CryptoError('Open the containing folder first.');
        if (parent.epoch === parentKeyEpoch) return parent.key;
        const previous = prevNodeKeys.get(parentId);
        if (previous && previous.epoch === parentKeyEpoch) return previous.key;
        throw new CryptoError('This item was wrapped under an older folder key.');
    }
    function rememberNodeKey(nodeId: string, key: Uint8Array<ArrayBuffer>, epoch: number) {
        nodeKeys.get(nodeId)?.key.fill(0);
        nodeKeys.set(nodeId, { key, epoch });
    }
    function rememberPrevNodeKey(nodeId: string, key: Uint8Array<ArrayBuffer>, epoch: number) {
        prevNodeKeys.get(nodeId)?.key.fill(0);
        prevNodeKeys.set(nodeId, { key, epoch });
    }
    async function rotateOne(
        workspaceId: string,
        targetEpoch: number,
        granterUserId: string | null,
        node: RotateNodeInput,
    ): Promise<RotatedNode> {
        const nodeId = node.id;
        // The key as it is: cached from a listing, or opened now under the parent
        // key its envelope was wrapped under (a previous one, when the parent rotated first).
        const cached = nodeKeys.get(nodeId);
        const old =
            cached && cached.epoch === node.keyEpoch
                ? cached.key.slice()
                : ((await openNodeKey(
                      decode(node.keyEnvelope, 72),
                      parentKeyFor(workspaceId, node.parentId, node.wrappedParentKeyEpoch),
                      {
                          workspaceId,
                          nodeId,
                          parentId: node.parentId,
                          parentKeyEpoch: node.wrappedParentKeyEpoch,
                          keyEpoch: node.keyEpoch,
                      },
                  )) as Uint8Array<ArrayBuffer>);
        // Already at the target, only wrapped under an unrotated parent: the same key, rewrapped.
        if (node.keyEpoch >= targetEpoch) {
            const parentKey = parentKeyFor(workspaceId, node.parentId, node.parentKeyEpoch);
            const keyEnvelope = await wrapNodeKey(old, parentKey, {
                workspaceId,
                nodeId,
                parentId: node.parentId,
                parentKeyEpoch: node.parentKeyEpoch,
                keyEpoch: node.keyEpoch,
            });
            if (!cached) rememberNodeKey(nodeId, old, node.keyEpoch);
            else old.fill(0);
            return {
                id: nodeId,
                keyEnvelope: encode(keyEnvelope),
                metadataEnvelope: node.metadataEnvelope,
                versions: [],
                shares: [],
                links: [],
                rewrap: true,
            };
        }
        const fresh = generateKey();
        try {
            const parentKey = parentKeyFor(workspaceId, node.parentId, node.parentKeyEpoch);
            const keyEnvelope = await wrapNodeKey(fresh, parentKey, {
                workspaceId,
                nodeId,
                parentId: node.parentId,
                parentKeyEpoch: node.parentKeyEpoch,
                keyEpoch: targetEpoch,
            });
            const metadata = await openMetadata(decode(node.metadataEnvelope), old, {
                workspaceId,
                nodeId,
                metadataVersion: node.metadataVersion,
            });
            const metadataEnvelope = await sealMetadata(metadata, fresh, {
                workspaceId,
                nodeId,
                metadataVersion: node.metadataVersion,
            });
            const versions = [];
            for (const version of node.versions) {
                // The same record, sealed under the fresh key in the object's own suite.
                const opened = await openVersionUnder(old, workspaceId, nodeId, version);
                try {
                    versions.push({
                        id: version.id,
                        contentKeyEnvelope: encode(
                            await sealVersion(
                                {
                                    contentKey: opened.contentKey,
                                    plaintextSize: opened.plaintextSize,
                                    thumbnailBytes: opened.thumbnailBytes,
                                },
                                fresh,
                                {
                                    workspaceId,
                                    nodeId,
                                    versionId: version.id,
                                    objectId: version.objectId,
                                    suite: opened.suite,
                                },
                            ),
                        ),
                    });
                } finally {
                    opened.contentKey.fill(0);
                }
            }
            const shares = [];
            for (const share of node.shares) {
                if (!identityKey || !granterUserId || identityKey.userId !== granterUserId)
                    throw new CryptoError('Open your identity first.');
                shares.push({
                    id: share.id,
                    shareEnvelope: encode(
                        await sealShareKey(
                            fresh,
                            {
                                encryptionPublicKey: decode(share.granteePublicKey, 32),
                                kemPublicKey: share.granteeKemPublicKey
                                    ? decode(share.granteeKemPublicKey, 1184)
                                    : null,
                            },
                            identityKey.key,
                            {
                                workspaceId,
                                nodeId,
                                keyEpoch: targetEpoch,
                                granteeUserId: share.granteeUserId,
                                granterUserId,
                            },
                        ),
                    ),
                });
            }
            const links: Extract<RotatedNode, { links: unknown }>['links'] = [];
            for (const link of node.links) {
                if (!link.secretEnvelope) {
                    links.push({ id: link.id, unsealable: true });
                    continue;
                }
                const oldCtx = { workspaceId, nodeId, keyEpoch: node.keyEpoch, linkId: link.id };
                const newCtx = { workspaceId, nodeId, keyEpoch: targetEpoch, linkId: link.id };
                const { secret, token, fromPassword } = await openLinkSecret(
                    decode(link.secretEnvelope),
                    old,
                    oldCtx,
                );
                try {
                    // A password link sealed before the password key was kept cannot be re-sealed without the password.
                    if (link.hasPassword && !fromPassword) {
                        links.push({ id: link.id, unsealable: true });
                        continue;
                    }
                    const stretched = fromPassword ?? new Uint8Array(32);
                    links.push({
                        id: link.id,
                        linkEnvelope: encode(
                            await sealLinkKeyWith(fresh, secret, stretched, newCtx),
                        ),
                        secretEnvelope: encode(
                            await sealLinkSecret(secret, token, stretched, fresh, newCtx),
                        ),
                    });
                } finally {
                    secret.fill(0);
                    fromPassword?.fill(0);
                }
            }
            // From here the node's key is the fresh one; the old one stays reachable for its unrotated children.
            rememberPrevNodeKey(nodeId, old, node.keyEpoch);
            rememberNodeKey(nodeId, fresh, targetEpoch);
            return {
                id: nodeId,
                keyEnvelope: encode(keyEnvelope),
                metadataEnvelope: encode(metadataEnvelope),
                versions,
                shares,
                links,
            };
        } catch (error) {
            fresh.fill(0);
            old.fill(0);
            throw error;
        }
    }

    function clearState() {
        security.reset();
        accountKeyVersion = 1;
        password = '';
        state = '';
        exportKey = '';
        phase = 'idle';
        accountKey?.fill(0);
        accountKey = undefined;
        unlockedUserId = null;
    }
    function reset() {
        generation++;
        clearState();
        forgetDriveKeys();
        const error = new Error('Your account was locked. Please try again.');
        for (const reject of pending) reject(error);
        pending.clear();
    }
    function checkGeneration(expected: number) {
        if (expected !== generation)
            throw new CryptoError('Your account was locked. Please try again.');
    }
    async function execute(
        message: Message,
        expected: number,
        hooks: SessionHooks,
    ): Promise<CryptoResults[keyof CryptoResults]> {
        await ready;
        checkGeneration(expected);
        switch (message.operation) {
            case 'securityStart':
                clearState();
                return security.start(message.input);
            case 'securityFinish':
                return security.finish(message.input);
            case 'initialize': {
                if (!accountKey || unlockedUserId !== message.input.userId)
                    throw new CryptoError('Unlock your account to finish setup.');
                const root = accountKey.slice();
                const userId = unlockedUserId;
                const keyVersion = accountKeyVersion;
                try {
                    return {
                        recovery: message.input.recovery
                            ? (await createRecovery(root, userId, 1, keyVersion)).recovery
                            : undefined,
                        identity: message.input.identity
                            ? await createIdentity(root, userId, keyVersion)
                            : undefined,
                        workspace: message.input.workspace
                            ? {
                                  id: message.input.workspace.id,
                                  grant: await createWorkspaceGrant(
                                      root,
                                      userId,
                                      message.input.workspace.id,
                                      keyVersion,
                                  ),
                              }
                            : undefined,
                    };
                } finally {
                    root.fill(0);
                }
            }
            case 'backup': {
                if (!accountKey || unlockedUserId !== message.input.userId)
                    throw new CryptoError('Unlock your account to view your recovery key.');
                const root = accountKey.slice();
                try {
                    return {
                        phrase: await readRecoveryPhrase(
                            root,
                            unlockedUserId,
                            message.input.recovery,
                        ),
                    };
                } finally {
                    root.fill(0);
                }
            }
            case 'remember': {
                if (!accountKey || unlockedUserId !== message.input.identity.userId)
                    throw new CryptoError('Unlock your account before saving it on this device.');
                const root = accountKey.slice();
                try {
                    return await rememberAccountKey(
                        root,
                        message.input.deviceKey,
                        message.input.identity,
                    );
                } finally {
                    root.fill(0);
                }
            }
            case 'restore': {
                if (unlockedUserId !== message.input.bundle.userId) forgetDriveKeys();
                clearState();
                const root = await restoreAccountKey(message.input.bundle, message.input.deviceKey);
                if (expected !== generation) {
                    root.fill(0);
                    checkGeneration(expected);
                }
                accountKey = root;
                unlockedUserId = message.input.bundle.userId;
                accountKeyVersion = message.input.bundle.keyVersion;
                return { userId: unlockedUserId };
            }

            case 'registerStart': {
                clearState();
                password = checkPassword(message.input.password);
                const result = client.startRegistration({ password });
                state = result.clientRegistrationState;
                phase = 'register';
                return { registrationRequest: result.registrationRequest };
            }
            case 'recoverFinish':
            case 'registerFinish': {
                checkProfile(message.input.profileVersion);
                if (phase !== 'register')
                    throw new CryptoError('Registration expired. Please try again.');
                const result = client.finishRegistration({
                    password,
                    clientRegistrationState: state,
                    registrationResponse: message.input.registrationResponse,
                    identifiers: OPAQUE_IDENTIFIERS,
                    keyStretching: KEY_STRETCHING,
                });
                password = '';
                state = '';
                phase = 'idle';
                const salt = crypto.getRandomValues(new Uint8Array(32));
                const nonce = crypto.getRandomValues(new Uint8Array(24));
                const recovering = message.operation === 'recoverFinish';
                const recovered = recovering
                    ? await openRecovery(
                          message.input.phrase,
                          message.input.userId,
                          message.input.recovery,
                      )
                    : undefined;
                const root = recovered?.accountKey ?? crypto.getRandomValues(new Uint8Array(32));
                const keyVersion = recovering ? message.input.recovery.keyVersion : 1;
                const credentialVersion = recovering ? message.input.credentialVersion + 1 : 1;
                let key: Uint8Array<ArrayBuffer> | undefined;
                try {
                    key = await wrappingKey(result.exportKey, salt);
                    const encrypted = await encryptKey(
                        root,
                        key,
                        nonce,
                        accountKeyContext(message.input.userId, keyVersion, credentialVersion),
                    );
                    const { recovery } = await createRecovery(
                        root,
                        message.input.userId,
                        recovering ? message.input.recovery.recoveryVersion + 1 : 1,
                        keyVersion,
                    );
                    const output = {
                        recovery,
                        registrationRecord: result.registrationRecord,
                        envelope: {
                            envelopeVersion: ENVELOPE_VERSION as typeof ENVELOPE_VERSION,
                            keyVersion,
                            credentialVersion,
                            wrappingSalt: encode(salt),
                            wrappingNonce: encode(nonce),
                            encryptedKey: encode(encrypted),
                        },
                    };
                    if (recovering && recovered)
                        return {
                            ...output,
                            signature: await signRecoveryReset(
                                {
                                    ...output,
                                    userId: message.input.userId,
                                    attemptToken: message.input.attemptToken,
                                    credentialVersion: message.input.credentialVersion,
                                },
                                recovered.signingKey,
                            ),
                        };
                    const workspaceId = crypto.randomUUID();
                    return {
                        ...output,
                        identity: await createIdentity(root, message.input.userId),
                        workspace: {
                            id: workspaceId,
                            grant: await createWorkspaceGrant(
                                root,
                                message.input.userId,
                                workspaceId,
                                keyVersion,
                            ),
                        },
                    };
                } finally {
                    recovered?.signingKey.fill(0);
                    root.fill(0);
                    key?.fill(0);
                    clearState();
                }
            }
            case 'loginStart': {
                clearState();
                password = message.input.password;
                const result = client.startLogin({ password });
                state = result.clientLoginState;
                phase = 'login';
                return { startLoginRequest: result.startLoginRequest };
            }
            case 'loginFinish': {
                checkProfile(message.input.profileVersion);
                if (phase !== 'login') throw new CryptoError('Sign-in expired. Please try again.');
                const result = client.finishLogin({
                    password,
                    clientLoginState: state,
                    loginResponse: message.input.loginResponse,
                    identifiers: OPAQUE_IDENTIFIERS,
                    keyStretching: KEY_STRETCHING,
                });
                password = '';
                state = '';
                if (!result)
                    throw new CryptoError('Unable to sign in. Check your email and password.');
                exportKey = result.exportKey;
                phase = 'unlock';
                return { finishLoginRequest: result.finishLoginRequest };
            }
            case 'identityOpen': {
                const { userId, identity } = message.input;
                if (!accountKey || unlockedUserId !== userId)
                    throw new CryptoError('Unlock your account first.');
                if (identityKey && identityKey.userId === userId && !message.input.refresh)
                    return {
                        encryptionPublicKey: identityKey.publicKey,
                        kemPublicKey: identityKey.kem?.publicKey ?? null,
                    };
                const root = accountKey.slice();
                try {
                    const key = await openIdentityEncryptionKey(root, userId, identity);
                    const kem = await openIdentityKemKey(root, userId, identity);
                    forgetIdentity();
                    identityKey = { userId, key, publicKey: identity.encryptionPublicKey, kem };
                    return {
                        encryptionPublicKey: identity.encryptionPublicKey,
                        kemPublicKey: kem?.publicKey ?? null,
                    };
                } finally {
                    root.fill(0);
                }
            }
            case 'identityMintKem': {
                const { userId, identity } = message.input;
                if (!accountKey || unlockedUserId !== userId)
                    throw new CryptoError('Unlock your account first.');
                const root = accountKey.slice();
                try {
                    return { kem: await addIdentityKem(root, userId, identity) };
                } finally {
                    root.fill(0);
                }
            }
            case 'identityVerifyKem': {
                const { userId, encryptionPublicKey, signingPublicKey, kem } = message.input;
                return {
                    valid: await verifyKemBinding(
                        userId,
                        encryptionPublicKey,
                        signingPublicKey,
                        kem,
                    ),
                };
            }
            case 'settingsOpen': {
                const { userId, envelope } = message.input;
                if (!identityKey || identityKey.userId !== userId)
                    throw new CryptoError('Open your identity first.');
                return { settings: await openSettings(identityKey.key, userId, envelope) };
            }
            case 'settingsSeal': {
                const { userId, settingsVersion, settings } = message.input;
                if (!identityKey || identityKey.userId !== userId)
                    throw new CryptoError('Open your identity first.');
                return {
                    envelope: await sealSettings(
                        identityKey.key,
                        userId,
                        settingsVersion,
                        settings,
                    ),
                };
            }
            case 'driveSealShare': {
                const { workspaceId, nodeId, keyEpoch, granterUserId, granteeUserId } =
                    message.input;
                if (!identityKey || identityKey.userId !== granterUserId)
                    throw new CryptoError('Open your identity first.');
                const node = nodeKeys.get(nodeId);
                if (!node) throw new CryptoError('Open the containing folder first.');
                if (node.epoch !== keyEpoch)
                    throw new CryptoError(
                        'This item changed since it was opened. Refresh and retry.',
                    );
                const envelope = await sealShareKey(
                    node.key,
                    {
                        encryptionPublicKey: decode(message.input.granteePublicKey, 32),
                        kemPublicKey: message.input.granteeKemPublicKey
                            ? decode(message.input.granteeKemPublicKey, 1184)
                            : null,
                    },
                    identityKey.key,
                    { workspaceId, nodeId, keyEpoch, granteeUserId, granterUserId },
                );
                return { shareEnvelope: encode(envelope) };
            }
            case 'driveOpenShare': {
                const { workspaceId, nodeId, keyEpoch, granterUserId, granteeUserId } =
                    message.input;
                if (!identityKey || identityKey.userId !== granteeUserId)
                    throw new CryptoError('Open your identity first.');
                const cached = nodeKeys.get(nodeId);
                if (cached && cached.epoch === keyEpoch) return { opened: true as const };
                const secrets = {
                    privateKey: identityKey.key,
                    kemSecretKey: identityKey.kem?.secretKey ?? null,
                };
                const key = await openShareKey(
                    decode(message.input.shareEnvelope),
                    decode(message.input.granterPublicKey, 32),
                    secrets,
                    { workspaceId, nodeId, keyEpoch, granteeUserId, granterUserId },
                );
                rememberNodeKey(nodeId, key, keyEpoch);
                if (message.input.prevShareEnvelope && message.input.prevKeyEpoch) {
                    const previous = await openShareKey(
                        decode(message.input.prevShareEnvelope),
                        decode(message.input.granterPublicKey, 32),
                        secrets,
                        {
                            workspaceId,
                            nodeId,
                            keyEpoch: message.input.prevKeyEpoch,
                            granteeUserId,
                            granterUserId,
                        },
                    );
                    rememberPrevNodeKey(nodeId, previous, message.input.prevKeyEpoch);
                }
                return { opened: true as const };
            }
            case 'driveSealLink': {
                const { workspaceId, nodeId, keyEpoch, linkId, password } = message.input;
                const node = nodeKeys.get(nodeId);
                if (!node) throw new CryptoError('Open the containing folder first.');
                if (node.epoch !== keyEpoch)
                    throw new CryptoError(
                        'This item changed since it was opened. Refresh and retry.',
                    );
                const secret = generateLinkSecret();
                const token = crypto.getRandomValues(new Uint8Array(32));
                const salt = generateLinkSalt();
                const ctx = { workspaceId, nodeId, keyEpoch, linkId };
                const fromPassword = await passwordKey(password, salt);
                try {
                    const envelope = await sealLinkKeyWith(node.key, secret, fromPassword, ctx);
                    const secretEnvelope = await sealLinkSecret(
                        secret,
                        token,
                        fromPassword,
                        node.key,
                        ctx,
                    );
                    return {
                        linkEnvelope: encode(envelope),
                        secret: encode(secret),
                        token: encode(token),
                        salt: encode(salt),
                        secretEnvelope: encode(secretEnvelope),
                    };
                } finally {
                    secret.fill(0);
                    fromPassword.fill(0);
                }
            }
            case 'driveSealReport': {
                const { workspaceId, nodeId, keyEpoch, reportId } = message.input;
                const node = nodeKeys.get(nodeId);
                if (!node) throw new CryptoError('Open the containing folder first.');
                if (node.epoch !== keyEpoch)
                    throw new CryptoError(
                        'This item changed since it was opened. Refresh and retry.',
                    );
                const envelopes = [];
                for (const operator of message.input.operators) {
                    // A KEM key the signing key did not vouch for is a swap by the server: refuse it.
                    if (
                        operator.kem &&
                        !(await verifyKemBinding(
                            operator.userId,
                            operator.encryptionPublicKey,
                            operator.signingPublicKey,
                            operator.kem,
                        ))
                    )
                        throw new CryptoError("An operator's key does not match their identity.");
                    envelopes.push({
                        userId: operator.userId,
                        keyEnvelope: encode(
                            await sealReportKey(
                                node.key,
                                {
                                    encryptionPublicKey: decode(operator.encryptionPublicKey, 32),
                                    kemPublicKey: operator.kem
                                        ? decode(operator.kem.publicKey, KEM_PUBLIC_KEY_BYTES)
                                        : null,
                                },
                                {
                                    workspaceId,
                                    nodeId,
                                    keyEpoch,
                                    reportId,
                                    operatorUserId: operator.userId,
                                },
                            ),
                        ),
                    });
                }
                return { envelopes };
            }
            case 'driveOpenReport': {
                const { workspaceId, nodeId, keyEpoch, reportId, operatorUserId } = message.input;
                if (!identityKey || identityKey.userId !== operatorUserId)
                    throw new CryptoError('Open your identity first.');
                const cached = nodeKeys.get(nodeId);
                if (cached && cached.epoch === keyEpoch) return { opened: true as const };
                const key = await openReportKey(
                    decode(message.input.keyEnvelope),
                    {
                        publicKey: decode(identityKey.publicKey, 32),
                        privateKey: identityKey.key,
                        kemSecretKey: identityKey.kem?.secretKey ?? null,
                    },
                    { workspaceId, nodeId, keyEpoch, reportId, operatorUserId },
                );
                rememberNodeKey(nodeId, key, keyEpoch);
                return { opened: true as const };
            }
            case 'driveLinkSecret': {
                const { workspaceId, nodeId, keyEpoch, linkId } = message.input;
                const node = nodeKeys.get(nodeId);
                if (!node) throw new CryptoError('Open the containing folder first.');
                const { secret, token, fromPassword } = await openLinkSecret(
                    decode(message.input.secretEnvelope),
                    node.key,
                    { workspaceId, nodeId, keyEpoch, linkId },
                );
                try {
                    return { secret: encode(secret), token: encode(token) };
                } finally {
                    secret.fill(0);
                    fromPassword?.fill(0);
                }
            }
            case 'driveResealLink': {
                const { workspaceId, nodeId, keyEpoch, linkId, password } = message.input;
                const node = nodeKeys.get(nodeId);
                if (!node) throw new CryptoError('Open the containing folder first.');
                if (node.epoch !== keyEpoch)
                    throw new CryptoError(
                        'This item changed since it was opened. Refresh and retry.',
                    );
                const ctx = { workspaceId, nodeId, keyEpoch, linkId };
                const {
                    secret,
                    token,
                    fromPassword: previous,
                } = await openLinkSecret(decode(message.input.secretEnvelope), node.key, ctx);
                previous?.fill(0);
                const salt = generateLinkSalt();
                const fromPassword = await passwordKey(password, salt);
                try {
                    const envelope = await sealLinkKeyWith(node.key, secret, fromPassword, ctx);
                    const secretEnvelope = await sealLinkSecret(
                        secret,
                        token,
                        fromPassword,
                        node.key,
                        ctx,
                    );
                    return {
                        linkEnvelope: encode(envelope),
                        salt: encode(salt),
                        secretEnvelope: encode(secretEnvelope),
                    };
                } finally {
                    secret.fill(0);
                    fromPassword.fill(0);
                }
            }
            case 'driveOpenLink': {
                const { workspaceId, nodeId, keyEpoch, linkId, password } = message.input;
                const cached = nodeKeys.get(nodeId);
                if (cached && cached.epoch === keyEpoch) return { opened: true as const };
                const secret = decode(message.input.secret, 32);
                try {
                    const key = await openLinkKey(
                        decode(message.input.linkEnvelope, 72),
                        secret,
                        password,
                        decode(message.input.salt, 16),
                        { workspaceId, nodeId, keyEpoch, linkId },
                    );
                    rememberNodeKey(nodeId, key, keyEpoch);
                    return { opened: true as const };
                } finally {
                    secret.fill(0);
                }
            }
            case 'driveRotateNodes': {
                const { workspaceId, targetEpoch, granterUserId } = message.input;
                const out: RotatedNode[] = [];
                for (const node of message.input.nodes) {
                    try {
                        out.push(await rotateOne(workspaceId, targetEpoch, granterUserId, node));
                    } catch (error) {
                        out.push({
                            id: node.id,
                            error:
                                error instanceof CryptoError
                                    ? error.message
                                    : 'This item could not be rotated.',
                        });
                    }
                }
                return { nodes: out };
            }
            case 'driveOpenWorkspace': {
                if (!accountKey || unlockedUserId !== message.input.userId)
                    throw new CryptoError('Unlock your account to open Drive.');
                const { grant } = message.input;
                const cached = workspaceKeys.get(grant.workspaceId);
                if (cached && cached.version === grant.workspaceKeyVersion)
                    return { workspaceId: grant.workspaceId, workspaceKeyVersion: cached.version };
                const root = accountKey.slice();
                try {
                    const key = await openWorkspaceKey(root, unlockedUserId, grant);
                    cached?.key.fill(0);
                    workspaceKeys.set(grant.workspaceId, {
                        key: key as Uint8Array<ArrayBuffer>,
                        version: grant.workspaceKeyVersion,
                    });
                    return {
                        workspaceId: grant.workspaceId,
                        workspaceKeyVersion: grant.workspaceKeyVersion,
                    };
                } finally {
                    root.fill(0);
                }
            }
            case 'driveSealDocument': {
                const { workspaceId, kind, version, document } = message.input;
                const workspace = workspaceKeys.get(workspaceId);
                if (!workspace) throw new CryptoError('Open Drive first.');
                const envelope = await sealDocument(document, workspace.key, {
                    workspaceId,
                    kind,
                    version,
                });
                return { envelope: encode(envelope) };
            }
            case 'driveOpenDocument': {
                const { workspaceId, kind, version, envelope } = message.input;
                const workspace = workspaceKeys.get(workspaceId);
                if (!workspace) throw new CryptoError('Open Drive first.');
                const document = await openDocument(decode(envelope), workspace.key, {
                    workspaceId,
                    kind,
                    version,
                });
                return { document };
            }
            case 'driveCreateNodes': {
                const { workspaceId } = message.input;
                const out: { id: string; keyEnvelope: string; metadataEnvelope: string }[] = [];
                const created: { id: string; key: Uint8Array<ArrayBuffer>; epoch: number }[] = [];
                try {
                    for (const node of message.input.nodes) {
                        const parentKey = parentKeyFor(
                            workspaceId,
                            node.parentId,
                            node.parentKeyEpoch,
                        );
                        const key = generateKey();
                        const keyEnvelope = await wrapNodeKey(key, parentKey, {
                            workspaceId,
                            nodeId: node.id,
                            parentId: node.parentId,
                            parentKeyEpoch: node.parentKeyEpoch,
                            keyEpoch: node.keyEpoch,
                        });
                        const metadataEnvelope = await sealMetadata(node.metadata, key, {
                            workspaceId,
                            nodeId: node.id,
                            metadataVersion: 1,
                        });
                        out.push({
                            id: node.id,
                            keyEnvelope: encode(keyEnvelope),
                            metadataEnvelope: encode(metadataEnvelope),
                        });
                        created.push({ id: node.id, key, epoch: node.keyEpoch });
                        // Later nodes in the batch may be children of this one.
                        rememberNodeKey(node.id, key, node.keyEpoch);
                    }
                } catch (error) {
                    for (const node of created) {
                        nodeKeys.delete(node.id);
                        node.key.fill(0);
                    }
                    throw error;
                }
                return { nodes: out };
            }
            case 'driveOpenNodes': {
                const { workspaceId } = message.input;
                const nodes: DriveOpenedNode[] = [];
                for (const node of message.input.nodes) {
                    try {
                        const cached = nodeKeys.get(node.id);
                        let key = cached && cached.epoch === node.keyEpoch ? cached.key : undefined;
                        if (!key) {
                            const parentKey = parentKeyFor(
                                workspaceId,
                                node.parentId,
                                node.parentKeyEpoch,
                            );
                            key = (await openNodeKey(decode(node.keyEnvelope, 72), parentKey, {
                                workspaceId,
                                nodeId: node.id,
                                parentId: node.parentId,
                                parentKeyEpoch: node.parentKeyEpoch,
                                keyEpoch: node.keyEpoch,
                            })) as Uint8Array<ArrayBuffer>;
                            rememberNodeKey(node.id, key, node.keyEpoch);
                        }
                        // Mid-rotation: the same key under the previous parent key opens
                        // children the rotation has not reached; failure to open it is
                        // not failure to open the node.
                        if (node.prevKeyEnvelope && node.prevParentKeyEpoch && node.prevKeyEpoch)
                            try {
                                const previousParent = parentKeyFor(
                                    workspaceId,
                                    node.parentId,
                                    node.prevParentKeyEpoch,
                                );
                                const previous = (await openNodeKey(
                                    decode(node.prevKeyEnvelope, 72),
                                    previousParent,
                                    {
                                        workspaceId,
                                        nodeId: node.id,
                                        parentId: node.parentId,
                                        parentKeyEpoch: node.prevParentKeyEpoch,
                                        keyEpoch: node.prevKeyEpoch,
                                    },
                                )) as Uint8Array<ArrayBuffer>;
                                rememberPrevNodeKey(node.id, previous, node.prevKeyEpoch);
                            } catch {
                                /* The previous parent key is not held here; only rotated nodes open. */
                            }
                        const metadata = await openMetadata(decode(node.metadataEnvelope), key, {
                            workspaceId,
                            nodeId: node.id,
                            metadataVersion: node.metadataVersion,
                        });
                        // The sizes are sealed with the content key; a version that will
                        // not open leaves the row nameable and its download to say why.
                        let content: DriveContentInfo | null = null;
                        if (node.version)
                            try {
                                const opened = await openVersionUnder(
                                    key,
                                    workspaceId,
                                    node.id,
                                    node.version,
                                );
                                opened.contentKey.fill(0);
                                content = {
                                    plaintextSize: opened.plaintextSize,
                                    thumbnailBytes: opened.thumbnailBytes,
                                };
                            } catch {
                                content = null;
                            }
                        nodes.push({ id: node.id, metadata, content });
                    } catch (error) {
                        nodes.push({
                            id: node.id,
                            error:
                                error instanceof CryptoError
                                    ? error.message
                                    : 'This item could not be opened.',
                        });
                    }
                }
                return { nodes };
            }
            case 'driveSealMetadata': {
                const entry = nodeKeys.get(message.input.nodeId);
                if (!entry) throw new CryptoError('Open the containing folder first.');
                const metadataEnvelope = await sealMetadata(message.input.metadata, entry.key, {
                    workspaceId: message.input.workspaceId,
                    nodeId: message.input.nodeId,
                    metadataVersion: message.input.metadataVersion,
                });
                return { metadataEnvelope: encode(metadataEnvelope) };
            }
            case 'driveRewrapNode': {
                const { workspaceId, nodeId, parentId, parentKeyEpoch, keyEpoch } = message.input;
                const entry = nodeKeys.get(nodeId);
                if (!entry) throw new CryptoError('Open the containing folder first.');
                if (entry.epoch !== keyEpoch)
                    throw new CryptoError(
                        'This item changed since it was opened. Refresh and retry.',
                    );
                const parentKey = parentKeyFor(workspaceId, parentId, parentKeyEpoch);
                const keyEnvelope = await wrapNodeKey(entry.key, parentKey, {
                    workspaceId,
                    nodeId,
                    parentId,
                    parentKeyEpoch,
                    keyEpoch,
                });
                return { keyEnvelope: encode(keyEnvelope) };
            }
            case 'driveUploadPrepare': {
                const { workspaceId, nodeId, versionId, objectId, plaintextSize } = message.input;
                const node = nodeKeys.get(nodeId);
                if (!node) throw new CryptoError('Open the containing folder first.');
                forgetUpload(objectId);
                const contentKey = generateKey();
                const contentNonce = generateContentNonce();
                // The trailer is sealed now, so the envelope and the declared size are
                // final before a byte leaves; a thumbnail over the cap is simply dropped.
                const webp =
                    message.input.thumbnail?.byteLength &&
                    message.input.thumbnail.byteLength <= THUMBNAIL_MAX_BYTES
                        ? new Uint8Array(message.input.thumbnail)
                        : null;
                const thumbnail = webp
                    ? ((await encryptThumbnail(webp, contentKey, contentNonce, {
                          workspaceId,
                          objectId,
                          plaintextSize,
                      })) as Uint8Array<ArrayBuffer>)
                    : null;
                const thumbnailBytes = webp?.byteLength ?? 0;
                webp?.fill(0);
                const envelope = await sealVersion(
                    { contentKey, plaintextSize, thumbnailBytes },
                    node.key,
                    { workspaceId, nodeId, versionId, objectId, suite: CONTENT_SUITE },
                );
                uploads.set(objectId, {
                    workspaceId,
                    contentKey,
                    contentNonce,
                    plaintextSize,
                    chunkCount: chunkCount(plaintextSize),
                    thumbnailBytes,
                    thumbnail,
                    requests: new Map(),
                    encrypted: new Map(),
                });
                return {
                    contentNonce: encode(contentNonce),
                    contentKeyEnvelope: encode(envelope),
                    chunkCount: chunkCount(plaintextSize),
                    ciphertextSize: ciphertextSize(plaintextSize, thumbnailBytes),
                    thumbnail: thumbnail ? thumbnail.slice() : null,
                };
            }
            case 'driveThumbnailFetch': {
                const { workspaceId, nodeId, version, url } = message.input;
                const node = nodeKeys.get(nodeId);
                if (!node) throw new CryptoError('Open the containing folder first.');
                const opened = await openVersionUnder(node.key, workspaceId, nodeId, version);
                try {
                    if (opened.thumbnailBytes < 1)
                        throw new CryptoError('This file has no thumbnail.');
                    const range = thumbnailRange(opened.plaintextSize, opened.thumbnailBytes);
                    const response = await fetch(url, {
                        headers: { Range: `bytes=${range.start}-${range.end}` },
                        cache: 'no-store',
                    });
                    if (response.status !== 206)
                        throw new CryptoError(
                            `The thumbnail could not be fetched (${response.status}).`,
                        );
                    const ciphertext = new Uint8Array(await response.arrayBuffer());
                    const plaintext = await decryptThumbnail(
                        ciphertext,
                        opened.contentKey,
                        decode(message.input.contentNonce, 16),
                        {
                            workspaceId,
                            objectId: version.objectId,
                            plaintextSize: opened.plaintextSize,
                            thumbnailBytes: opened.thumbnailBytes,
                        },
                    );
                    return { plaintext: plaintext as Uint8Array };
                } finally {
                    opened.contentKey.fill(0);
                }
            }
            case 'driveOpenVersions': {
                const { workspaceId, nodeId } = message.input;
                const node = nodeKeys.get(nodeId);
                if (!node) throw new CryptoError('Open the containing folder first.');
                const versions: DriveOpenedVersion[] = [];
                for (const version of message.input.versions) {
                    try {
                        const opened = await openVersionUnder(
                            node.key,
                            workspaceId,
                            nodeId,
                            version,
                        );
                        opened.contentKey.fill(0);
                        versions.push({
                            id: version.id,
                            plaintextSize: opened.plaintextSize,
                            thumbnailBytes: opened.thumbnailBytes,
                        });
                    } catch (error) {
                        versions.push({
                            id: version.id,
                            error:
                                error instanceof CryptoError
                                    ? error.message
                                    : 'This version could not be opened.',
                        });
                    }
                }
                return { versions };
            }
            case 'driveUploadRewrap': {
                const { workspaceId, objectId, nodeId, versionId } = message.input;
                const upload = uploads.get(objectId);
                if (!upload) throw new CryptoError('This upload is not open here.');
                const node = nodeKeys.get(nodeId);
                if (!node) throw new CryptoError('Open the destination folder first.');
                const envelope = await sealVersion(
                    {
                        contentKey: upload.contentKey,
                        plaintextSize: upload.plaintextSize,
                        thumbnailBytes: upload.thumbnailBytes,
                    },
                    node.key,
                    { workspaceId, nodeId, versionId, objectId, suite: CONTENT_SUITE },
                );
                return { contentKeyEnvelope: encode(envelope) };
            }
            case 'driveCopyFile': {
                const { workspaceId, source, node, versionId } = message.input;
                const sourceKey = nodeKeys.get(source.nodeId);
                if (!sourceKey) throw new CryptoError('Open the containing folder first.');
                const parentKey = parentKeyFor(workspaceId, node.parentId, node.parentKeyEpoch);
                const opened = await openVersionUnder(
                    sourceKey.key,
                    workspaceId,
                    source.nodeId,
                    source,
                );
                const contentKey = opened.contentKey;
                const key = generateKey();
                try {
                    const keyEnvelope = await wrapNodeKey(key, parentKey, {
                        workspaceId,
                        nodeId: node.id,
                        parentId: node.parentId,
                        parentKeyEpoch: node.parentKeyEpoch,
                        keyEpoch: node.keyEpoch,
                    });
                    const metadataEnvelope = await sealMetadata(node.metadata, key, {
                        workspaceId,
                        nodeId: node.id,
                        metadataVersion: 1,
                    });
                    // The same record under the new node key, in the object's own suite:
                    // the object is shared, so nothing about how it opens may change.
                    const contentKeyEnvelope = await sealVersion(
                        {
                            contentKey,
                            plaintextSize: opened.plaintextSize,
                            thumbnailBytes: opened.thumbnailBytes,
                        },
                        key,
                        {
                            workspaceId,
                            nodeId: node.id,
                            versionId,
                            objectId: source.objectId,
                            suite: opened.suite,
                        },
                    );
                    rememberNodeKey(node.id, key, node.keyEpoch);
                    return {
                        keyEnvelope: encode(keyEnvelope),
                        metadataEnvelope: encode(metadataEnvelope),
                        contentKeyEnvelope: encode(contentKeyEnvelope),
                    };
                } catch (error) {
                    key.fill(0);
                    throw error;
                } finally {
                    contentKey.fill(0);
                }
            }
            case 'driveUploadReopen': {
                const { workspaceId, nodeId, versionId, objectId, plaintextSize } = message.input;
                const node = nodeKeys.get(nodeId);
                if (!node) throw new CryptoError('Open the containing folder first.');
                if (message.input.contentSuite !== CONTENT_SUITE)
                    throw new CryptoError(
                        'This upload was started by an older version of HushOS. Start it again.',
                    );
                forgetUpload(objectId);
                const opened = await openVersionUnder(node.key, workspaceId, nodeId, {
                    id: versionId,
                    objectId,
                    contentKeyEnvelope: message.input.contentKeyEnvelope,
                    contentSuite: CONTENT_SUITE,
                    plaintextSize: null,
                });
                // The journal must agree with the envelope on the size and hold the very
                // trailer that was sealed at begin; otherwise it is uncertain and does not resume.
                const thumbnail = message.input.thumbnail
                    ? (new Uint8Array(message.input.thumbnail) as Uint8Array<ArrayBuffer>)
                    : null;
                if (
                    opened.plaintextSize !== plaintextSize ||
                    (thumbnail?.byteLength ?? 0) !== trailerLength(opened.thumbnailBytes)
                ) {
                    opened.contentKey.fill(0);
                    throw new CryptoError('This upload cannot be resumed on this device.');
                }
                const contentNonce = decode(
                    message.input.contentNonce,
                    16,
                ) as Uint8Array<ArrayBuffer>;
                uploads.set(objectId, {
                    workspaceId,
                    contentKey: opened.contentKey,
                    contentNonce,
                    plaintextSize,
                    chunkCount: chunkCount(plaintextSize),
                    thumbnailBytes: opened.thumbnailBytes,
                    thumbnail,
                    requests: new Map(),
                    encrypted: new Map(),
                });
                return {
                    chunkCount: chunkCount(plaintextSize),
                    ciphertextSize: ciphertextSize(plaintextSize, opened.thumbnailBytes),
                };
            }
            case 'driveUploadDigest': {
                const upload = uploads.get(message.input.objectId);
                if (!upload)
                    throw new CryptoError('This upload is no longer prepared. Start it again.');
                const plaintext = await readChunk(upload, message.input.file, message.input.index);
                const digest = await chunkDigest(plaintext);
                plaintext.fill(0);
                return { digest: encode(digest) };
            }
            case 'driveUploadEncrypt': {
                const { objectId, file, index } = message.input;
                const upload = uploads.get(objectId);
                if (!upload)
                    throw new CryptoError('This upload is no longer prepared. Start it again.');
                const plaintext = await readChunk(upload, file, index);
                const [chunk, digest] = await Promise.all([
                    encryptChunk(plaintext, upload.contentKey, upload.contentNonce, {
                        workspaceId: upload.workspaceId,
                        objectId,
                        suite: CONTENT_SUITE,
                        index,
                        chunkCount: upload.chunkCount,
                        plaintextSize: upload.plaintextSize,
                    }),
                    chunkDigest(plaintext),
                ]);
                plaintext.fill(0);
                // The last part carries the trailer after the last chunk: one PUT, one range.
                let ciphertext = chunk as Uint8Array<ArrayBuffer>;
                if (index === upload.chunkCount - 1 && upload.thumbnail) {
                    ciphertext = new Uint8Array(chunk.byteLength + upload.thumbnail.byteLength);
                    ciphertext.set(chunk, 0);
                    ciphertext.set(upload.thumbnail, chunk.byteLength);
                    chunk.fill(0);
                }
                upload.encrypted.get(index)?.fill(0);
                upload.encrypted.set(index, ciphertext);
                return { digest: encode(digest), bytes: ciphertext.byteLength };
            }
            case 'driveUploadSend': {
                const { objectId, index, url } = message.input;
                const upload = uploads.get(objectId);
                if (!upload)
                    throw new CryptoError('This upload is no longer prepared. Start it again.');
                const ciphertext = upload.encrypted.get(index);
                if (!ciphertext) throw new CryptoError('This chunk was not encrypted yet.');
                return await new Promise<UploadPartResult>((resolve) => {
                    const request = new XMLHttpRequest();
                    upload.requests.set(index, request);
                    const done = (result: UploadPartResult) => {
                        upload.requests.delete(index);
                        // Sent or given up: the ciphertext is not kept around either way.
                        if (result.ok || !result.cancelled) {
                            ciphertext.fill(0);
                            upload.encrypted.delete(index);
                        }
                        resolve(result);
                    };
                    request.upload.onprogress = (event) =>
                        hooks.progress?.({
                            objectId,
                            index,
                            loaded: event.loaded,
                            total: ciphertext.byteLength,
                        });
                    request.onload = () => {
                        const etag = request.getResponseHeader('ETag');
                        if (request.status >= 200 && request.status < 300 && etag)
                            done({ ok: true, etag, bytes: ciphertext.byteLength });
                        else
                            done({
                                ok: false,
                                status: request.status,
                                retryable:
                                    request.status === 0 ||
                                    request.status === 408 ||
                                    request.status === 429 ||
                                    request.status >= 500,
                                message:
                                    !etag && request.status < 300
                                        ? 'The storage server did not return an ETag. Check its CORS settings.'
                                        : `The storage server answered ${request.status}.`,
                            });
                    };
                    request.onerror = () =>
                        done({
                            ok: false,
                            status: 0,
                            retryable: true,
                            message: 'The connection dropped.',
                        });
                    request.ontimeout = () =>
                        done({
                            ok: false,
                            status: 0,
                            retryable: true,
                            message: 'The storage server timed out.',
                        });
                    request.onabort = () =>
                        done({
                            ok: false,
                            status: 0,
                            retryable: true,
                            message: 'Paused.',
                            cancelled: true,
                        });
                    request.open('PUT', url, true);
                    request.timeout = 10 * 60_000;
                    request.setRequestHeader('Content-Type', 'application/octet-stream');
                    request.send(ciphertext);
                });
            }
            case 'driveUploadCancel': {
                const upload = uploads.get(message.input.objectId);
                if (!upload) return { cancelled: 0 };
                let cancelled = 0;
                for (const [index, request] of upload.requests) {
                    if (message.input.index !== undefined && index !== message.input.index)
                        continue;
                    request.abort();
                    cancelled++;
                }
                return { cancelled };
            }
            case 'driveUploadForget':
                return { forgotten: forgetUpload(message.input.objectId) };
            case 'driveDownloadOpen': {
                const { workspaceId, nodeId, version } = message.input;
                const node = nodeKeys.get(nodeId);
                if (!node) throw new CryptoError('Open the containing folder first.');
                closeDownload(version.objectId);
                const opened = await openVersionUnder(node.key, workspaceId, nodeId, version);
                downloads.set(version.objectId, {
                    workspaceId,
                    suite: opened.suite,
                    contentKey: opened.contentKey,
                    contentNonce: decode(message.input.contentNonce, 16) as Uint8Array<ArrayBuffer>,
                    plaintextSize: opened.plaintextSize,
                    chunkCount: chunkCount(opened.plaintextSize),
                    controllers: new Map(),
                });
                return {
                    chunkCount: chunkCount(opened.plaintextSize),
                    plaintextSize: opened.plaintextSize,
                    thumbnailBytes: opened.thumbnailBytes,
                };
            }
            case 'driveDownloadChunk': {
                const { objectId, url, index } = message.input;
                const download = downloads.get(objectId);
                if (!download)
                    throw new CryptoError('This download is no longer open. Start it again.');
                const range = chunkRange(download.plaintextSize, index);
                const controller = new AbortController();
                download.controllers.set(index, controller);
                try {
                    let response: Response;
                    try {
                        response = await fetch(url, {
                            headers: { Range: `bytes=${range.start}-${range.end}` },
                            signal: controller.signal,
                            cache: 'no-store',
                        });
                    } catch (error) {
                        return {
                            ok: false,
                            status: 0,
                            retryable: !controller.signal.aborted,
                            message: controller.signal.aborted
                                ? 'Cancelled.'
                                : `The connection dropped: ${error instanceof Error ? error.message : 'unknown error'}`,
                        };
                    }
                    if (response.status !== 206 && response.status !== 200)
                        return {
                            ok: false,
                            status: response.status,
                            retryable:
                                response.status === 408 ||
                                response.status === 429 ||
                                response.status >= 500,
                            message: `The storage server answered ${response.status}.`,
                        };
                    const expected = range.end - range.start + 1;
                    const ciphertext = new Uint8Array(expected);
                    let received = 0;
                    if (!response.body) throw new CryptoError('The storage server sent no data.');
                    const reader = response.body.getReader();
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (received + value.byteLength > expected)
                            return {
                                ok: false,
                                status: response.status,
                                retryable: false,
                                message:
                                    'The storage server sent more data than the range asked for.',
                            };
                        ciphertext.set(value, received);
                        received += value.byteLength;
                        hooks.progress?.({
                            kind: 'download',
                            objectId,
                            index,
                            loaded: received,
                            total: expected,
                        });
                    }
                    if (received !== expected)
                        return {
                            ok: false,
                            status: response.status,
                            retryable: true,
                            message: 'The storage server sent less data than the range asked for.',
                        };
                    const plaintext = await decryptChunk(
                        ciphertext,
                        download.contentKey,
                        download.contentNonce,
                        {
                            workspaceId: download.workspaceId,
                            objectId,
                            suite: download.suite,
                            index,
                            chunkCount: download.chunkCount,
                            plaintextSize: download.plaintextSize,
                        },
                    );
                    return { ok: true, plaintext, index };
                } finally {
                    download.controllers.delete(index);
                }
            }
            case 'driveDownloadClose':
                return { closed: closeDownload(message.input.objectId) };
            case 'driveExportKeys': {
                const { workspaceId, nodeId, version } = message.input;
                const node = nodeKeys.get(nodeId);
                if (!node) throw new CryptoError('Open the containing folder first.');
                let content: CryptoResults['driveExportKeys']['content'] = null;
                if (version) {
                    const opened = await openVersionUnder(node.key, workspaceId, nodeId, version);
                    content = {
                        key: encode(opened.contentKey),
                        nonce: version.contentNonce,
                        plaintextSize: opened.plaintextSize,
                        thumbnailBytes: opened.thumbnailBytes,
                    };
                    opened.contentKey.fill(0);
                }
                return { nodeKey: encode(node.key), keyEpoch: node.epoch, content };
            }
            case 'unlock': {
                if (phase !== 'unlock')
                    throw new CryptoError('Sign in again to unlock your account.');
                const { userId, envelope } = message.input;
                if (unlockedUserId !== userId) forgetDriveKeys();
                if (
                    envelope.envelopeVersion !== ENVELOPE_VERSION ||
                    !Number.isSafeInteger(envelope.keyVersion) ||
                    envelope.keyVersion < 1 ||
                    !Number.isSafeInteger(envelope.credentialVersion) ||
                    envelope.credentialVersion < 1
                )
                    throw new CryptoError('This account-key version is not supported.');
                const key = await wrappingKey(exportKey, decode(envelope.wrappingSalt, 32));
                exportKey = '';
                phase = 'idle';
                try {
                    const root = await decryptKey(
                        decode(envelope.encryptedKey, 48),
                        key,
                        decode(envelope.wrappingNonce, 24),
                        accountKeyContext(userId, envelope.keyVersion, envelope.credentialVersion),
                    );
                    if (expected !== generation || root.length !== 32) {
                        root.fill(0);
                        checkGeneration(expected);
                        throw new CryptoError('Invalid account key.');
                    }
                    accountKey = root;
                    unlockedUserId = userId;
                    accountKeyVersion = envelope.keyVersion;
                    return { userId };
                } finally {
                    key.fill(0);
                }
            }
        }
    }

    function handle(
        message: Message,
        hooks: SessionHooks = {},
    ): Promise<CryptoResults[keyof CryptoResults]> {
        const expected = generation;
        return new Promise((resolve, reject) => {
            pending.add(reject);
            // Keep a cancelled operation on the queue until its local secrets are cleared.
            // Reset rejects callers immediately; later generations cannot share its state.
            queue = queue.then(async () => {
                try {
                    checkGeneration(expected);
                    const result = await execute(message, expected, hooks);
                    checkGeneration(expected);
                    resolve(result);
                } catch (error) {
                    reject(error);
                } finally {
                    if (expected !== generation) clearState();
                    pending.delete(reject);
                }
            });
        });
    }

    return { handle, reset };
}
