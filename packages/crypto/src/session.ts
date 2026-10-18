import { CryptoError, RefusedError } from './errors';
import { checkPassword, normalizePassword } from './password';
import {
    createSecurityChange,
    type SecurityAction,
    type SecurityChallenge,
    type SecurityUpdate,
} from './security';
import {
    createIdentity,
    createSuccessor,
    verifySuccessionChain,
    type PinnedKeys,
    type ServedKeys,
    type SuccessionLink,
    openIdentityEncryptionKey,
    openIdentityKemKey,
    openIdentitySigningKey,
    verifyIdentityKeys,
    upgradeIdentity,
    openIdentityMlDsaKey,
    publicIdentity,
    type IdentityEnvelope,
} from './identity';
import {
    createGroupSession,
    isGroupMessage,
    servedRekeyedRecord,
    type GroupRequests,
    type GroupResults,
    type GroupRotationTrust,
    type RecordJudge,
} from './session-groups';
import type { ServedIdentity } from './group-trust';
import {
    createSettingsKey,
    openSettings,
    openSettingsKey,
    sealSettings,
    type Settings,
    type SettingsEnvelope,
    type SettingsKeyEnvelope,
} from './contacts';
import { openShareKey, sealShareKey, type GranteeSecrets, type ShareContext } from './shares';
import {
    copyForm,
    integrityOf,
    metadataStatementAs,
    metadataStatements,
    rekeyedIntegrityOf,
    resealForm,
    signStatement,
    versionStatementAs,
    versionStatements,
    type HybridPublicKey,
    type Integrity,
    type MetadataStatement,
    type NodeKind,
    type RekeyedRecord,
    type SignatureForm,
    type StatementForms,
    type TrustedSigner,
    type VersionStatement,
} from './signatures';
import { openReportKey, sealReportKey } from './reports';
import { rekeyedFor } from './rekeyed-scope';
import {
    openVersionUnder,
    rekeyNode as rekeyNodeRecords,
    type RotateNodeInput,
    type RotatedNode,
    type ServedRekey,
} from './rotation-records';
import { FAMILY_FOLDER, createAreaLedger } from './area-ledger';
import { KEM_PUBLIC_KEY_BYTES, ML_DSA_PUBLIC_KEY_BYTES } from './pq';
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
    chunkPlaintextLength,
    contentLength,
    fileBytesOf,
    chunkDigest,
    chunkRange,
    ciphertextSize,
    decryptChunk,
    decryptThumbnail,
    encryptChunk,
    encryptThumbnail,
    generateContentNonce,
    generateKey,
    openMetadata,
    sealMetadata,
    sealVersion,
    THUMBNAIL_MAX_BYTES,
    thumbnailRange,
    trailerLength,
    wrapNodeKey,
    type NodeMetadata,
    sealDocument,
    openDocument,
} from './drive';
import { client, ready } from '@serenity-kit/opaque';
import { encryptKey, decryptKey } from './aead';
import { deriveStashKey } from './stash';
import { encode, decode, wrappingKey, checkProfile } from './keys';
import {
    accountKeyContext,
    ENVELOPE_VERSION,
    FAMILY_SHARING,
    KEY_STRETCHING,
    OPAQUE_IDENTIFIERS,
    type AccountKeyEnvelope,
} from './protocol';

type BaseRequests = {
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
    /*
     * Proving the password again while unlocked (removing a device): an OPAQUE login
     * kept apart from sign-in's, so the open account stays open, and a wrong password
     * is a refusal that keeps the session, not a reset.
     */
    reauthStart: { password: string };
    reauthFinish: { loginResponse: string; profileVersion: number };
    /* Forgets a re-authentication's password and state, finished or not. */
    reauthCancel: Record<string, never>;
    unlock: { userId: string; envelope: AccountKeyEnvelope };
    /*
     * Identity: opens the X25519 private key under the unlocked account and keeps
     * it for the session (it dies with a lock). Settings are sealed under a key
     * derived from it, so every device that unlocks reads the same pins.
     */
    /*
     * `refresh` re-reads an envelope already open, after the KEM key was added
     * or a succession was accepted on the server. `history` is the account's
     * earlier identities (GET /api/auth/identity/history), oldest first: their
     * private keys stay open beside the current ones, since shares sealed to
     * them open only with them, and their signing keys vouch for what they signed.
     */
    identityOpen: {
        userId: string;
        identity: IdentityEnvelope;
        history?: IdentityEnvelope[];
        refresh?: boolean;
    };
    /*
     * A new identity at the next key version, vouched for by the open one (see
     * docs/integrity-design.md, identity succession). Nothing is installed:
     * send it to the server, and once it is accepted open it with identityOpen
     * (refresh, the old identity appended to the history).
     */
    identitySucceed: { userId: string; identity: IdentityEnvelope };
    /*
     * Whether a contact's served keys follow from their pinned keys through
     * the succession links the server returned. Pure; needs no unlock.
     */
    identityVerifyChain: {
        userId: string;
        pinned: PinnedKeys;
        served: ServedKeys;
        links: SuccessionLink[];
    };
    /*
     * A version 1 identity upgraded to version 2 (docs/identity-pq-design.md 2):
     * the same keys and key version plus an ML-DSA key and the keys statement.
     * Nothing is installed: send it with POST /api/auth/identity/upgrade, then
     * open whatever the server answers with (refresh).
     */
    identityUpgrade: { userId: string; identity: IdentityEnvelope };
    /* Whether a served version 2 identity's keys statement holds; pure, needs no unlock. Not a reason to trust. */
    identityVerifyKeys: {
        userId: string;
        identity: {
            keyVersion: number;
            encryptionPublicKey: string;
            signingPublicKey: string;
            mlDsaPublicKey: string;
            kemPublicKey: string;
            keysSignature: string;
        };
    };
    /*
     * Settings. The settings key is created once per account (store it with
     * PUT /api/auth/settings-key; on 409 open the one stored) or opened from
     * GET /api/auth/settings, and stays in the worker until a lock. Open reads
     * version 2 with it, and answers null for version 1, which no longer
     * opens; seal writes version 2 only.
     */
    settingsKeyCreate: { userId: string };
    settingsKeyOpen: { userId: string; settingsKey: SettingsKeyEnvelope };
    /* `envelope` null: the account has no settings stored yet (a new account), read as none. */
    settingsOpen: { userId: string; envelope: SettingsEnvelope | null };
    settingsSeal: { userId: string; settingsVersion: number; settings: Settings };
    /*
     * Shares. Seal wraps an open node key to a contact's identity keys in share
     * suite 4 (a fresh X25519 key and ML-KEM), with the granter's hybrid signature;
     * open unwraps a share received, with the granter's keys the caller has
     * checked against its pin, and keeps the node key so the subtree opens like
     * any other.
     */
    driveSealShare: {
        workspaceId: string;
        nodeId: string;
        keyEpoch: number;
        granterUserId: string;
        granteeUserId: string;
        /* The grantee's X25519 and KEM keys, both checked against their pin by the caller. */
        granteePublicKey: string;
        granteeKemPublicKey: string;
    };
    driveOpenShare: {
        workspaceId: string;
        nodeId: string;
        keyEpoch: number;
        granterUserId: string;
        /*
         * The granter's current Ed25519 and ML-DSA keys, as the grantee's
         * version 3 pin vouches for them (followed through a signed succession
         * when they moved on). A share opens only if both signed it: never one
         * the granter has since replaced.
         */
        granterSigningPublicKey: string;
        granterMlDsaPublicKey: string;
        granteeUserId: string;
        /*
         * Which of this account's identities the share was sealed to, when the
         * caller knows; otherwise the current one is tried, then the earlier
         * ones (see identityOpen's history).
         */
        granteeKeyVersion?: number | null;
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
        /*
         * Each operator's identity as the server served it. A version 2 identity's
         * KEM key is used once its keys statement holds. A version 1 identity (an
         * operator who has not signed in since the upgrade) has no statement, and
         * its served KEM key is used as served: operator keys come from the
         * server and are pinned by nobody, so its old Ed25519 binding never
         * protected against the server either (the reports dialog says so).
         */
        operators: {
            userId: string;
            keyVersion: number;
            encryptionPublicKey: string;
            signingPublicKey: string;
            mlDsaPublicKey: string | null;
            kemPublicKey: string | null;
            keysSignature: string | null;
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
        /*
         * Who this person trusts, as for driveVerify. Required: each record is
         * checked before it is signed again, a verified one with the ordinary
         * statement and anything else re-sealed. Without it nothing is rotated.
         */
        signers: DriveSigners;
        nodes: RotateNodeInput[];
        /*
         * In a group's area: each record is checked as the group's roster
         * says (groupVerify), over the staged chain of the roster call named
         * (a removal's own rotation, judged as the roster marking someone
         * `left` does) or else the committed one, and a former member's or a
         * key conflict's record is re-sealed, never re-signed as ordinary.
         * `signers` still gives the personal keys for writers the roster does
         * not speak for.
         */
        group?: GroupRotationTrust | null;
    };
    /*
     * Drive: opens the workspace key from the member's grant and keeps it in
     * the worker. Never a group's area: those open through groupOpenArea,
     * which checks their version against the group's member list.
     */
    driveOpenWorkspace: { userId: string; grant: WorkspaceKeyEnvelope };
    /*
     * A workspace document (the tag registry) sealed under the workspace key
     * the workspace is written under (a group area's latest version on its
     * member list), bound to the version it becomes. Open says which key
     * version opened it: a personal workspace's tries every version held,
     * newest first; a group area's only its write version, since a roster
     * rotation carries the area's documents sealed again (groupStage).
     */
    driveSealDocument: { workspaceId: string; kind: string; version: number; document: unknown };
    driveOpenDocument: { workspaceId: string; kind: string; version: number; envelope: string };
    /*
     * After the server answers a rotation batch: the nodes it applied (ok or
     * already) take the keys driveRotateNodes made as their own, the old ones
     * kept as previous for their unrotated children; drop forgets the rest.
     */
    driveRotateCommit: { workspaceId: string; nodeIds: string[] };
    driveRotateDrop: { workspaceId: string; nodeIds: string[] };
    /*
     * Creates nodes in order: a fresh key each, wrapped under the parent's key, and
     * the metadata sealed under the new key. A parent is the workspace id (the root),
     * a node opened earlier, or an earlier node in the same batch.
     */
    driveCreateNodes: { workspaceId: string; nodes: DriveNodeInput[] };
    /* Opens node keys and metadata, parents before children; keys stay cached. */
    driveOpenNodes: { workspaceId: string; nodes: DriveNodeEnvelopes[] };
    /*
     * A rename: the metadata sealed at its next version, and signed. `signAs`
     * is the statement (ordinary by default): `resealed` for a record whose
     * current metadata did not verify, since the rest of it (type, size, date)
     * is carried over from something this person cannot vouch for, and `saved`
     * for one that verified as saved from a link.
     */
    driveSealMetadata: {
        workspaceId: string;
        nodeId: string;
        kind: NodeKind;
        metadataVersion: number;
        metadata: NodeMetadata;
        signAs?: SignatureForm;
    };
    /*
     * Who wrote each record, checked against keys the caller trusts: `signers`
     * maps an account id to the signing keys the caller verified (a pinned
     * contact's current key, and the earlier ones a succession chain vouched
     * for, which only ever yield `retired-key`). The worker adds this
     * account's own, current and earlier, so the identity must be open. A
     * signer who is not there is an unknown signer, never a verified one; a
     * record whose check throws is `unchecked`.
     */
    driveVerify: {
        workspaceId: string;
        signers: DriveSigners;
        nodes: DriveSignedNode[];
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
        /* The version statement to sign (see DriveNodeInput): a saved copy signs `saved` or `resealed`. */
        signAs?: SignatureForm;
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
    driveUploadRewrap: {
        workspaceId: string;
        objectId: string;
        nodeId: string;
        versionId: string;
        /* As for prepare. */
        signAs?: SignatureForm;
    };
    /* The plaintext digest of one chunk, to prove a re-read file is the one that was journaled. */
    driveUploadDigest: { objectId: string; file: Blob; index: number };
    /*
     * Copy within a workspace: a new file node with a fresh key under the
     * destination, its metadata sealed, and the source version's content key
     * (opened under the source node's key, which must be open) wrapped again
     * under the new node key for the new version. The object is shared, so the
     * key it was encrypted under is the one thing that must not change.
     *
     * The source's records are checked first, as a reading would: the copy's
     * metadata is signed with the ordinary statement only when the source's
     * metadata verified, and its version only when the source's version
     * verified; anything else is signed re-sealed. `signers` is required: a
     * copy never re-signs what it could not check.
     */
    driveCopyFile: {
        workspaceId: string;
        signers: DriveSigners;
        source: {
            nodeId: string;
            /* The source node's metadata record as served, signature included. */
            metadataVersion: number;
            metadataEnvelope: string;
            metadataSigner: string | null;
            metadataSignature: string | null;
            /* Who signed the source version's envelope. */
            signer: string | null;
            signature: string | null;
            /*
             * A re-keyed source (family folders, rekeyedFor): the node's key epoch and
             * each record's origin, so the copy is judged on its writer's record (the
             * origin's verdict, when its bytes bind), not on the re-keyer's columns.
             */
            keyEpoch?: number;
            metadataRekey?: ServedRekey | null;
            rekey?: ServedRekey | null;
        } & DriveVersionEnvelope;
        node: {
            id: string;
            parentId: string;
            parentKeyEpoch: number;
            keyEpoch: number;
            metadata: NodeMetadata;
        };
        versionId: string;
        /*
         * In a family folder: the source's records are checked as the family's
         * member list says (groupVerify, over the committed chain), never by
         * personal pins alone, and a former member's or a key conflict's record
         * is copied re-sealed. Required there; refused anywhere else.
         */
        group?: GroupRotationTrust | null;
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
    /* The key that seals this account's stashed upload bytes on the device (stash.ts). */
    driveStashKey: { userId: string };
};
export type CryptoRequests = BaseRequests & GroupRequests;
export type DriveNodeInput = {
    id: string;
    /* Signed with the metadata: a folder's name cannot be passed off as a file's. */
    kind: NodeKind;
    /*
     * The statement the metadata is signed with, ordinary by default: `saved`
     * for what a save from a link creates (its files and folders), `resealed`
     * for metadata taken from a record this person did not verify (a copy of
     * an unverified item), which they re-lock without vouching for who wrote
     * it. See copyForm in ./signatures.
     */
    signAs?: SignatureForm;
    parentId: string;
    parentKeyEpoch: number;
    keyEpoch: number;
    metadata: NodeMetadata;
};
/*
 * The signing keys a caller trusts, per account id, base64url: the account's
 * current key, and the keys it replaced (a succession chain vouched for them),
 * which only ever yield `retired-key`. See TrustedSigner.
 */
export type DriveSigners = Record<string, { current: string; retired: string[] }>;
/* A node's signed records as the server serves them, for driveVerify. */
export type DriveSignedNode = {
    id: string;
    kind: NodeKind;
    metadataVersion: number;
    metadataEnvelope: string;
    /* The account the server says wrote the metadata, and its signature; null before signatures. */
    metadataSigner: string | null;
    metadataSignature: string | null;
    /*
     * The node's key epoch, which a re-keyed record's origin key is wrapped at:
     * its key at that epoch is what opens both envelopes. Rows mirrored before
     * re-keyed records carry neither field.
     */
    keyEpoch?: number;
    /* What a rotation kept of the metadata's writer; the signer above is then the re-keyer. */
    metadataRekey?: ServedRekey | null;
    /* The versions to check: the current one for a listing, all of them for a versions list. */
    versions?: DriveSignedVersion[];
};
export type DriveSignedVersion = {
    id: string;
    objectId: string;
    contentSuite: number;
    contentKeyEnvelope: string;
    signer: string | null;
    signature: string | null;
    rekey?: ServedRekey | null;
};
/*
 * A re-keyed record's second verdict: the re-keyer's over the rekeyed
 * statement, and what the plaintexts showed (RekeyedVerdict). The record's
 * own verdict is its origin's.
 */
export type RekeyCheck = { rekeyer: Integrity; bound: boolean | null };
export type DriveVerifiedNode = {
    id: string;
    metadata: Integrity;
    metadataRekey?: RekeyCheck | null;
    versions: { id: string; integrity: Integrity; rekey?: RekeyCheck | null }[];
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
export type {
    RekeyOut,
    RotateNodeInput,
    RotatedNode,
    RotatedRecord,
    ServedRekey,
} from './rotation-records';
export type DriveOpenedNode =
    | { id: string; metadata: NodeMetadata; content?: DriveContentInfo | null; error?: undefined }
    | { id: string; metadata?: undefined; content?: undefined; error: string };
export type DriveOpenedVersion =
    | ({ id: string; error?: undefined } & DriveContentInfo)
    | { id: string; error: string };
type BaseResults = {
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
    reauthStart: { startLoginRequest: string };
    reauthFinish: { finishLoginRequest: string };
    reauthCancel: { ok: true };
    unlock: { userId: string };
    identityOpen: {
        keyVersion: number;
        identityVersion: 1 | 2;
        encryptionPublicKey: string;
        signingPublicKey: string;
        mlDsaPublicKey: string | null;
        kemPublicKey: string | null;
        /* The earlier identities opened beside it, oldest first. */
        history: { keyVersion: number; encryptionPublicKey: string; signingPublicKey: string }[];
    };
    identitySucceed: { identity: IdentityEnvelope; signature: string; consent: string };
    identityVerifyChain: { valid: boolean };
    identityUpgrade: { identity: IdentityEnvelope };
    identityVerifyKeys: { valid: boolean };
    settingsKeyCreate: { settingsKey: SettingsKeyEnvelope };
    settingsKeyOpen: { opened: true };
    /* Null for a version 1 document, which no longer opens: treat it as no settings. */
    settingsOpen: { settings: Settings | null };
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
    driveOpenDocument: { document: unknown; workspaceKeyVersion: number };
    driveRotateCommit: { committed: number };
    driveRotateDrop: { dropped: number };
    driveCreateNodes: {
        nodes: {
            id: string;
            keyEnvelope: string;
            metadataEnvelope: string;
            metadataSignature: string;
        }[];
    };
    driveOpenNodes: { nodes: DriveOpenedNode[] };
    driveSealMetadata: { metadataEnvelope: string; metadataSignature: string };
    driveVerify: { nodes: DriveVerifiedNode[] };
    driveRewrapNode: { keyEnvelope: string };
    driveUploadPrepare: {
        contentNonce: string;
        contentKeyEnvelope: string;
        /* The version statement signed by this account: send as `versionSignature`. */
        versionSignature: string;
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
    driveUploadRewrap: { contentKeyEnvelope: string; versionSignature: string };
    driveCopyFile: {
        keyEnvelope: string;
        metadataEnvelope: string;
        metadataSignature: string;
        contentKeyEnvelope: string;
        versionSignature: string;
    };
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
    /* Non-extractable: the page seals and opens with it and can never read it. */
    driveStashKey: { key: CryptoKey };
};
export type CryptoResults = BaseResults & GroupResults;
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
    // The re-authentication's own OPAQUE state: never the sign-in's, never the root's.
    let reauthPassword = '';
    let reauthState = '';
    let accountKey: Uint8Array<ArrayBuffer> | undefined;
    let unlockedUserId: string | null = null;
    /*
     * Drive keys and the family write rules that hold them (area-ledger.ts,
     * the Rust core's twin): every workspace and node key this session opened,
     * which of them a write may use, and each group area's write version. The
     * group session (below) tells it which workspaces are areas.
     */
    const ledger = createAreaLedger();
    const {
        isArea,
        dropWorkspace,
        nodeKey,
        keyAtEpoch,
        refuseOwnWorkspace,
        rootOf,
        writableNodeKey,
        writeVersionOf,
        wrapKeyFor,
        requireWritable,
        rememberNodeKey,
        rememberPrevNodeKey,
        currentKeyOf,
    } = ledger;
    /*
     * The open identity: its X25519 and ML-KEM private keys, which open what
     * was sealed to it, and its Ed25519 signing key, which signs every write,
     * share and succession. All of it dies with a lock.
     */
    let identityKey:
        | {
              userId: string;
              keyVersion: number;
              key: Uint8Array<ArrayBuffer>;
              publicKey: string;
              signingPublicKey: string;
              signingKey: Uint8Array<ArrayBuffer>;
              kem: { publicKey: string; secretKey: Uint8Array<ArrayBuffer> } | null;
              identityVersion: 1 | 2;
              /* Version 2 only: the other half of every hybrid signature. */
              mlDsa: { publicKey: string; secretKey: Uint8Array<ArrayBuffer> } | null;
              /* Version 2 only: the keys statement the identity was opened with. */
              keysSignature: string | null;
          }
        | undefined;
    /*
     * Earlier identities of the account, oldest first: what shares sealed
     * before a succession open with. `served` is a version 2 identity's
     * public keys (null for version 1), proven the account's own when it was
     * opened: what a group roster's entry for this account may name.
     */
    let identityHistory: {
        keyVersion: number;
        key: Uint8Array<ArrayBuffer>;
        publicKey: string;
        signingPublicKey: string;
        kem: { publicKey: string; secretKey: Uint8Array<ArrayBuffer> } | null;
        served: ServedIdentity | null;
    }[] = [];
    /*
     * An earlier identity's public keys as one of this account's own, for a
     * roster entry to be checked against: only a version 2 identity whose
     * ML-DSA key opens under the root and whose keys statement holds; else
     * none, and no entry naming it is taken as this account's.
     */
    async function ownServed(
        root: Uint8Array<ArrayBuffer>,
        userId: string,
        envelope: IdentityEnvelope,
    ): Promise<ServedIdentity | null> {
        if (envelope.version !== 2) return null;
        try {
            (await openIdentityMlDsaKey(root, userId, envelope))?.secretKey.fill(0);
            const served = publicIdentity(envelope);
            return (await verifyIdentityKeys(userId, served)) ? served : null;
        } catch {
            return null;
        }
    }
    function forgetIdentity() {
        identityKey?.key.fill(0);
        identityKey?.signingKey.fill(0);
        identityKey?.kem?.secretKey.fill(0);
        identityKey?.mlDsa?.secretKey.fill(0);
        identityKey = undefined;
        for (const earlier of identityHistory) {
            earlier.key.fill(0);
            earlier.kem?.secretKey.fill(0);
        }
        identityHistory = [];
    }
    /* The settings key, opened under the root: what settings version 2 is sealed under. */
    let settingsKey: { userId: string; key: Uint8Array<ArrayBuffer> } | undefined;
    function forgetSettingsKey() {
        settingsKey?.key.fill(0);
        settingsKey = undefined;
    }
    function openedIdentity() {
        if (!identityKey) throw new CryptoError('Open your identity first.');
        return {
            keyVersion: identityKey.keyVersion,
            identityVersion: identityKey.identityVersion,
            encryptionPublicKey: identityKey.publicKey,
            signingPublicKey: identityKey.signingPublicKey,
            mlDsaPublicKey: identityKey.mlDsa?.publicKey ?? null,
            kemPublicKey: identityKey.kem?.publicKey ?? null,
            history: identityHistory.map((earlier) => ({
                keyVersion: earlier.keyVersion,
                encryptionPublicKey: earlier.publicKey,
                signingPublicKey: earlier.signingPublicKey,
            })),
        };
    }
    /* The open identity's hybrid signing keys: what signs shares and successions. */
    function hybridKeys() {
        if (!identityKey) throw new CryptoError('Open your identity first.');
        if (!identityKey.mlDsa)
            throw new CryptoError('Your keys need upgrading first. Unlock again and retry.');
        return { signingKey: identityKey.signingKey, mlDsaSecretKey: identityKey.mlDsa.secretKey };
    }
    /* A statement signed by the open identity, base64url. */
    async function sign(statement: Uint8Array) {
        if (!identityKey) throw new CryptoError('Open your identity first.');
        return encode(await signStatement(statement, identityKey.signingKey));
    }
    /* The statement of `form` (see SignatureForm) over a record, signed by the open identity. */
    async function signMetadata(
        ctx: MetadataStatement,
        envelope: Uint8Array,
        form: SignatureForm = 'ordinary',
    ) {
        return sign(await metadataStatementAs(form, ctx, envelope));
    }
    async function signVersion(
        ctx: VersionStatement,
        envelope: Uint8Array,
        form: SignatureForm = 'ordinary',
    ) {
        return sign(await versionStatementAs(form, ctx, envelope));
    }
    /*
     * The keys a check accepts: the caller's, and this account's own (its
     * current key, and its earlier ones as retired), proven when the identity
     * was opened. No trust set, or one with a key that does not read, is
     * refused outright rather than checked against in part: the caller shows
     * every record as unchecked, and a rotation or copy stops and retries.
     */
    function trustSet(signers: DriveSigners | null | undefined) {
        if (!signers || typeof signers !== 'object')
            throw new CryptoError(
                'HushOS couldn’t load the people you trust, so nothing was checked. Try again.',
            );
        if (!identityKey) throw new CryptoError('Open your identity first.');
        const trusted = new Map<string, TrustedSigner>();
        for (const [userId, keys] of Object.entries(signers))
            try {
                trusted.set(userId.toLowerCase(), {
                    current: decode(keys.current, 32),
                    retired: keys.retired.map((key) => decode(key, 32)),
                });
            } catch {
                throw new CryptoError(
                    'A key of someone you trust could not be read, so nothing was checked.',
                );
            }
        trusted.set(identityKey.userId.toLowerCase(), {
            current: decode(identityKey.signingPublicKey, 32),
            retired: identityHistory.map((earlier) => decode(earlier.signingPublicKey, 32)),
        });
        return trusted;
    }
    /*
     * One record's verdict, as a reading shows it. A signature present but
     * unreadable is one that cannot hold; a check that throws is `unchecked`.
     */
    async function checkRecord(
        trusted: Map<string, TrustedSigner>,
        statements: () => Promise<StatementForms>,
        signer: string | null,
        signature: string | null,
    ): Promise<Integrity> {
        let bytes: Uint8Array | null = null;
        if (signature)
            try {
                bytes = decode(signature);
            } catch {
                bytes = new Uint8Array(0);
            }
        try {
            return await integrityOf(
                statements,
                bytes,
                signer ? trusted.get(signer.toLowerCase()) : undefined,
            );
        } catch {
            return 'unchecked';
        }
    }
    /*
     * The identities a share sealed to this account may have been sealed to:
     * the one named, or the current one and then the earlier ones, newest first.
     */
    function granteeIdentities(keyVersion?: number | null) {
        if (!identityKey) throw new CryptoError('Open your identity first.');
        const all = [identityKey, ...[...identityHistory].reverse()].map((identity) => ({
            keyVersion: identity.keyVersion,
            privateKey: identity.key,
            kemSecretKey: identity.kem?.secretKey ?? null,
        }));
        if (keyVersion === undefined || keyVersion === null) return all;
        const named = all.filter((identity) => identity.keyVersion === keyVersion);
        if (named.length === 0)
            throw new CryptoError('This share was sealed to keys this device does not hold.');
        return named;
    }
    /*
     * A share opened with the first of `candidates` it was sealed to. The
     * granter's signature, under their current key, is checked before any of
     * them is tried.
     */
    async function openShareWithAny(
        envelope: Uint8Array,
        granter: HybridPublicKey,
        candidates: GranteeSecrets[],
        ctx: ShareContext,
    ) {
        let failure: unknown;
        for (const grantee of candidates)
            try {
                return await openShareKey(envelope, granter, grantee, ctx);
            } catch (error) {
                // A bad signature fails for every candidate alike: say so at once.
                if (error instanceof CryptoError && /not signed/.test(error.message)) throw error;
                failure ??= error;
            }
        throw failure ?? new CryptoError('This share could not be opened.');
    }
    type Upload = {
        workspaceId: string;
        contentKey: Uint8Array<ArrayBuffer>;
        contentNonce: Uint8Array<ArrayBuffer>;
        plaintextSize: number;
        /* The file and, under suite 3, its padding: what the chunks cover. */
        contentLength: number;
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
        /* The trailer's length: the last chunk's range runs on through it (see chunkRange). */
        thumbnailBytes: number;
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
    /* Chunk `index` of the upload: the file's bytes, then zeros where suite 3 pads past its end. */
    async function readChunk(upload: Upload, file: Blob, index: number) {
        if (file.size !== upload.plaintextSize)
            throw new CryptoError('The file changed since the upload started.');
        const start = index * CHUNK_SIZE;
        const chunk = new Uint8Array(chunkPlaintextLength(upload.contentLength, index));
        const end = Math.min(upload.plaintextSize, start + chunk.length);
        if (end > start) chunk.set(new Uint8Array(await file.slice(start, end).arrayBuffer()));
        return chunk;
    }
    function forgetDriveKeys() {
        forgetIdentity();
        forgetSettingsKey();
        groups.forget();
        ledger.clear();
        for (const objectId of uploads.keys()) forgetUpload(objectId);
        for (const objectId of downloads.keys()) closeDownload(objectId);
    }
    /*
     * A workspace document. A group area's documents open only under its write
     * version: they travel with every roster rotation (sealed again in the
     * call), so one under an older area key is one nobody re-sealed, which a
     * removed member could have written with the server's help (they are not
     * signed). A personal workspace's open under any key version held, newest
     * first. Either way the caller learns the version.
     */
    async function openDocumentUnderAny(
        workspaceId: string,
        kind: string,
        version: number,
        envelope: string,
    ) {
        const held = ledger.workspaceVersions(workspaceId);
        if (!held) throw new CryptoError('Open Drive first.');
        const area = ledger.readVersion(workspaceId);
        const versions = area === null ? held : [area];
        let failure: unknown = new CryptoError(
            area === null
                ? 'This document could not be opened.'
                : 'This document is not sealed under the folder’s current key.',
        );
        for (const keyVersion of versions) {
            const key = ledger.workspaceKey(workspaceId, keyVersion);
            if (!key) continue;
            try {
                const document = await openDocument(decode(envelope), key, {
                    workspaceId,
                    kind,
                    version,
                });
                return { document, workspaceKeyVersion: keyVersion };
            } catch (error) {
                if (area === null) failure = error;
            }
        }
        throw failure;
    }
    /*
     * How a personal rotation re-signs each record, from the record as served,
     * exactly as before re-keyed records (they wait for the shipped apps,
     * rekeyedFor): a verified record ordinary, saved stays saved, anything
     * else re-sealed, and an unchecked one is not re-signed at all. When
     * personal workspaces move to the re-keyed form, this becomes the honest
     * legacy form beside it (compatForm, decision D2).
     */
    function personalJudge(trusted: Map<string, TrustedSigner>): RecordJudge {
        return async (record) =>
            resealForm(
                await checkRecord(trusted, record.statements, record.signer, record.signature),
            );
    }
    /*
     * One node re-keyed from `old` to `fresh` (rotation-records.ts), signed by
     * the open identity, in the form its workspace's owner calls for (rekeyedFor).
     */
    function rekeyNode(input: {
        workspaceId: string;
        targetEpoch: number;
        granterUserId: string | null;
        node: RotateNodeInput;
        judge: RecordJudge;
        old: Uint8Array;
        fresh: Uint8Array;
        parentKey: Uint8Array;
    }) {
        return rekeyNodeRecords({
            ...input,
            ownerKind: isArea(input.workspaceId) ? 'group' : 'personal',
            signer: rotationSigner,
        });
    }
    /* The open identity, as a rotation signs with it: read at each signature, as sign() does. */
    function rotationSigner() {
        if (!identityKey) throw new CryptoError('Open your identity first.');
        return { userId: identityKey.userId, signingKey: identityKey.signingKey, hybridKeys };
    }
    async function rotateOne(
        workspaceId: string,
        targetEpoch: number,
        granterUserId: string | null,
        node: RotateNodeInput,
        judge: RecordJudge,
    ): Promise<RotatedNode> {
        const nodeId = node.id;
        const rotated = await ledger.rotateKey(
            workspaceId,
            node,
            targetEpoch,
            ({ old, fresh, parentKey }) =>
                rekeyNode({
                    workspaceId,
                    targetEpoch,
                    granterUserId,
                    node,
                    judge,
                    old,
                    fresh,
                    parentKey,
                }),
        );
        if (!rotated.rewrap) return rotated.result;
        // Already at the target, only wrapped under an unrotated parent: the same key, rewrapped.
        rotated.key.fill(0);
        return {
            id: nodeId,
            keyEnvelope: encode(rotated.keyEnvelope),
            metadataEnvelope: node.metadataEnvelope,
            metadataSignature: null,
            versions: [],
            shares: [],
            links: [],
            rewrap: true,
        };
    }
    const groups = createGroupSession({
        unlocked() {
            if (!accountKey || !unlockedUserId) throw new CryptoError('Unlock your account first.');
            return {
                userId: unlockedUserId,
                root: accountKey.slice(),
                keyVersion: accountKeyVersion,
            };
        },
        identity() {
            if (!identityKey) throw new CryptoError('Open your identity first.');
            if (!identityKey.mlDsa || !identityKey.kem || identityKey.identityVersion !== 2)
                throw new CryptoError('Your keys need upgrading first. Unlock again and retry.');
            return {
                userId: identityKey.userId,
                served: {
                    keyVersion: identityKey.keyVersion,
                    encryptionPublicKey: identityKey.publicKey,
                    signingPublicKey: identityKey.signingPublicKey,
                    mlDsaPublicKey: identityKey.mlDsa.publicKey,
                    kemPublicKey: identityKey.kem.publicKey,
                    keysSignature: identityKey.keysSignature ?? '',
                },
                history: identityHistory.flatMap((earlier) =>
                    earlier.served ? [earlier.served] : [],
                ),
            };
        },
        hybridKeys,
        granteeSecrets(keyVersion) {
            const [identity] = granteeIdentities(keyVersion);
            return { privateKey: identity!.privateKey, kemSecretKey: identity!.kemSecretKey };
        },
        ownSigner() {
            if (!identityKey) throw new CryptoError('Open your identity first.');
            return {
                current: decode(identityKey.signingPublicKey, 32),
                retired: identityHistory.map((earlier) => decode(earlier.signingPublicKey, 32)),
            };
        },
        personalSigners: trustSet,
        ledger,
        workspaceKey: ledger.workspaceKey,
        dropWorkspace,
        currentKeyOf,
        rekeyNode,
        nodeKeyAt: keyAtEpoch,
        previousNodeKey(workspaceId, nodeId, epoch) {
            // Only the key this device opened as the node's own: never one a served envelope gave.
            const held = ledger.prevNodeKey(workspaceId, nodeId);
            return held && held.own && held.epoch === epoch ? held.key.slice() : undefined;
        },
    });

    function clearState() {
        security.reset();
        accountKeyVersion = 1;
        password = '';
        reauthPassword = '';
        reauthState = '';
        state = '';
        exportKey = '';
        phase = 'idle';
        accountKey?.fill(0);
        accountKey = undefined;
        unlockedUserId = null;
        // Group state goes with the Drive keys (forgetDriveKeys: a lock, another account), never
        // with a password change or a restore of the same account, which keep personal keys too.
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
        if (isGroupMessage(message)) return groups.handle(message);
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
                password = normalizePassword(message.input.password);
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
            case 'reauthStart': {
                try {
                    reauthPassword = normalizePassword(message.input.password);
                } catch (error) {
                    throw new RefusedError(
                        error instanceof Error ? error.message : 'Enter your password.',
                    );
                }
                const result = client.startLogin({ password: reauthPassword });
                reauthState = result.clientLoginState;
                return { startLoginRequest: result.startLoginRequest };
            }
            case 'reauthCancel': {
                reauthPassword = '';
                reauthState = '';
                return { ok: true };
            }
            case 'reauthFinish': {
                checkProfile(message.input.profileVersion);
                const [password, state] = [reauthPassword, reauthState];
                reauthPassword = '';
                reauthState = '';
                if (!state) throw new RefusedError('Enter your password again.');
                const result = client.finishLogin({
                    password,
                    clientLoginState: state,
                    loginResponse: message.input.loginResponse,
                    identifiers: OPAQUE_IDENTIFIERS,
                    keyStretching: KEY_STRETCHING,
                });
                if (!result)
                    throw new RefusedError('That password isn’t right. Check it and try again.');
                // The export key is not needed and not kept: this proves the password, nothing more.
                return { finishLoginRequest: result.finishLoginRequest };
            }
            case 'identityOpen': {
                const { userId, identity } = message.input;
                const history = message.input.history ?? [];
                if (!accountKey || unlockedUserId !== userId)
                    throw new CryptoError('Unlock your account first.');
                // Never older than the identity already open, whatever the caller checked: opening
                // one makes it the identity everything is signed with, and a replaced identity is
                // still sealed under this root, so it would open. A fresh unlock starts with none.
                if (
                    identityKey &&
                    identityKey.userId === userId &&
                    (identity.keyVersion < identityKey.keyVersion ||
                        identity.version < identityKey.identityVersion)
                )
                    throw new RefusedError(
                        'The server sent older sharing keys than the ones open on this device.',
                    );
                // The identity already open, only if it is the one served: after an upgrade or a
                // succession the served envelope differs, and the cached one must not stand in for it.
                if (
                    identityKey &&
                    identityKey.userId === userId &&
                    !message.input.refresh &&
                    history.length <= identityHistory.length &&
                    identityKey.identityVersion === identity.version &&
                    identityKey.keyVersion === identity.keyVersion &&
                    identityKey.publicKey === identity.encryptionPublicKey &&
                    identityKey.signingPublicKey === identity.signingPublicKey &&
                    (identityKey.mlDsa?.publicKey ?? null) ===
                        (identity.mlDsa?.publicKey ?? null) &&
                    (identityKey.kem?.publicKey ?? null) === (identity.kem?.publicKey ?? null) &&
                    identityKey.keysSignature === (identity.keysSignature ?? null)
                )
                    return openedIdentity();
                // Oldest first, each older than the one after and than the current one.
                for (const [index, earlier] of history.entries())
                    if (
                        earlier.keyVersion >=
                        (history[index + 1]?.keyVersion ?? identity.keyVersion)
                    )
                        throw new CryptoError('Your earlier keys are out of order.');
                const root = accountKey.slice();
                const opened: Uint8Array[] = [];
                try {
                    const key = await openIdentityEncryptionKey(root, userId, identity);
                    opened.push(key);
                    const signingKey = await openIdentitySigningKey(root, userId, identity);
                    opened.push(signingKey);
                    const kem = await openIdentityKemKey(root, userId, identity);
                    if (kem) opened.push(kem.secretKey);
                    const mlDsa = await openIdentityMlDsaKey(root, userId, identity);
                    if (mlDsa) opened.push(mlDsa.secretKey);
                    // A version 2 identity is used only once its keys statement holds.
                    if (
                        identity.version === 2 &&
                        !(await verifyIdentityKeys(userId, {
                            keyVersion: identity.keyVersion,
                            encryptionPublicKey: identity.encryptionPublicKey,
                            signingPublicKey: identity.signingPublicKey,
                            mlDsaPublicKey: identity.mlDsa!.publicKey,
                            kemPublicKey: identity.kem!.publicKey,
                            keysSignature: identity.keysSignature!,
                        }))
                    )
                        throw new CryptoError('Your identity keys do not match.');
                    const earlier = [];
                    for (const previous of history) {
                        const previousKey = await openIdentityEncryptionKey(root, userId, previous);
                        opened.push(previousKey);
                        // Proves the signing key is the one this account held, as for the current one.
                        (await openIdentitySigningKey(root, userId, previous)).fill(0);
                        const previousKem = await openIdentityKemKey(root, userId, previous);
                        if (previousKem) opened.push(previousKem.secretKey);
                        earlier.push({
                            keyVersion: previous.keyVersion,
                            key: previousKey,
                            publicKey: previous.encryptionPublicKey,
                            signingPublicKey: previous.signingPublicKey,
                            kem: previousKem,
                            served: await ownServed(root, userId, previous),
                        });
                    }
                    forgetIdentity();
                    identityKey = {
                        userId,
                        keyVersion: identity.keyVersion,
                        key,
                        publicKey: identity.encryptionPublicKey,
                        signingPublicKey: identity.signingPublicKey,
                        signingKey,
                        kem,
                        identityVersion: identity.version,
                        mlDsa,
                        keysSignature: identity.keysSignature ?? null,
                    };
                    identityHistory = earlier;
                    opened.length = 0;
                    return openedIdentity();
                } finally {
                    root.fill(0);
                    for (const secret of opened) secret.fill(0);
                }
            }
            case 'identitySucceed': {
                const { userId, identity } = message.input;
                if (!accountKey || unlockedUserId !== userId)
                    throw new CryptoError('Unlock your account first.');
                // Every public key the succession statement names as the old one must be the open
                // identity's, proven when it was opened: never sign for keys served beside it.
                if (!identityKey || identityKey.userId !== userId)
                    throw new CryptoError('Open your identity first.');
                if (
                    identityKey.keyVersion !== identity.keyVersion ||
                    identity.version !== 2 ||
                    identityKey.signingPublicKey !== identity.signingPublicKey ||
                    identityKey.publicKey !== identity.encryptionPublicKey ||
                    identityKey.mlDsa?.publicKey !== identity.mlDsa.publicKey ||
                    identityKey.kem?.publicKey !== identity.kem.publicKey
                )
                    throw new RefusedError('Your keys changed on another device. Try again.');
                const root = accountKey.slice();
                try {
                    return await createSuccessor(root, userId, identity, hybridKeys());
                } finally {
                    root.fill(0);
                }
            }
            case 'identityVerifyChain': {
                const { userId, pinned, served, links } = message.input;
                return { valid: await verifySuccessionChain(userId, pinned, served, links) };
            }
            case 'identityUpgrade': {
                const { userId, identity } = message.input;
                if (!accountKey || unlockedUserId !== userId)
                    throw new CryptoError('Unlock your account first.');
                const root = accountKey.slice();
                try {
                    return { identity: await upgradeIdentity(root, userId, identity) };
                } finally {
                    root.fill(0);
                }
            }
            case 'identityVerifyKeys': {
                const { userId, identity } = message.input;
                return { valid: await verifyIdentityKeys(userId, identity) };
            }
            case 'settingsKeyCreate':
            case 'settingsKeyOpen': {
                const { userId } = message.input;
                if (!accountKey || unlockedUserId !== userId)
                    throw new CryptoError('Unlock your account first.');
                const root = accountKey.slice();
                try {
                    if (message.operation === 'settingsKeyOpen') {
                        const key = await openSettingsKey(root, userId, message.input.settingsKey);
                        forgetSettingsKey();
                        settingsKey = { userId, key };
                        return { opened: true as const };
                    }
                    const created = await createSettingsKey(root, userId);
                    forgetSettingsKey();
                    settingsKey = { userId, key: created.key };
                    return { settingsKey: created.envelope };
                } finally {
                    root.fill(0);
                }
            }
            case 'settingsOpen': {
                const { userId, envelope } = message.input;
                // None stored: this account's settings are empty, so it holds no group pins. Only
                // the unlocked account's own reading says so; acceptance takes them as its marks.
                if (envelope === null) {
                    if (!accountKey || unlockedUserId !== userId)
                        throw new CryptoError('Unlock your account first.');
                    groups.useSettings(userId, null);
                    return { settings: null };
                }
                const ownSettingsKey = settingsKey?.userId === userId ? settingsKey.key : null;
                const settings = await openSettings(ownSettingsKey, userId, envelope);
                // The group pins acceptance takes as marks: only from settings this worker opened.
                // A version 1 document (null here) is not a reading of "no settings".
                if (envelope.version !== 2) groups.legacySettings(userId);
                else groups.useSettings(userId, settings);
                return { settings };
            }
            case 'settingsSeal': {
                const { userId, settingsVersion, settings } = message.input;
                if (!settingsKey || settingsKey.userId !== userId)
                    throw new CryptoError('Open your settings key first.');
                const envelope = await sealSettings(
                    settingsKey.key,
                    userId,
                    settingsVersion,
                    settings,
                );
                // Not taken as this worker's settings marks: the server has not accepted it yet.
                // Group pins come only from settingsOpen of what the server serves.
                return { envelope };
            }
            case 'driveSealShare': {
                const { workspaceId, nodeId, keyEpoch, granterUserId, granteeUserId } =
                    message.input;
                // Sharing is not offered in family folders (design 3.4): a walk would close it.
                if (isArea(workspaceId)) throw new CryptoError(FAMILY_SHARING);
                requireWritable(workspaceId);
                if (!identityKey || identityKey.userId !== granterUserId)
                    throw new CryptoError('Open your identity first.');
                const node = writableNodeKey(workspaceId, nodeId);
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
                            ? decode(message.input.granteeKemPublicKey, KEM_PUBLIC_KEY_BYTES)
                            : null,
                    },
                    hybridKeys(),
                    { workspaceId, nodeId, keyEpoch, granteeUserId, granterUserId },
                );
                return { shareEnvelope: encode(envelope) };
            }
            case 'driveOpenShare': {
                const { workspaceId, nodeId, keyEpoch, granterUserId, granteeUserId } =
                    message.input;
                refuseOwnWorkspace(workspaceId);
                if (!identityKey || identityKey.userId !== granteeUserId)
                    throw new CryptoError('Open your identity first.');
                const cached = nodeKey(workspaceId, nodeId);
                if (cached && cached.epoch === keyEpoch) return { opened: true as const };
                if (!message.input.granterSigningPublicKey || !message.input.granterMlDsaPublicKey)
                    throw new CryptoError('This share needs the key of the person who shared it.');
                const granter = {
                    signingPublicKey: decode(message.input.granterSigningPublicKey, 32),
                    mlDsaPublicKey: decode(
                        message.input.granterMlDsaPublicKey,
                        ML_DSA_PUBLIC_KEY_BYTES,
                    ),
                };
                const candidates = granteeIdentities(message.input.granteeKeyVersion);
                const key = await openShareWithAny(
                    decode(message.input.shareEnvelope),
                    granter,
                    candidates,
                    { workspaceId, nodeId, keyEpoch, granteeUserId, granterUserId },
                );
                rememberNodeKey(workspaceId, nodeId, key, keyEpoch);
                if (message.input.prevShareEnvelope && message.input.prevKeyEpoch) {
                    const previous = await openShareWithAny(
                        decode(message.input.prevShareEnvelope),
                        granter,
                        candidates,
                        {
                            workspaceId,
                            nodeId,
                            keyEpoch: message.input.prevKeyEpoch,
                            granteeUserId,
                            granterUserId,
                        },
                    );
                    rememberPrevNodeKey(workspaceId, nodeId, previous, message.input.prevKeyEpoch);
                }
                return { opened: true as const };
            }
            case 'driveSealLink': {
                const { workspaceId, nodeId, keyEpoch, linkId, password } = message.input;
                if (isArea(workspaceId)) throw new CryptoError(FAMILY_SHARING);
                requireWritable(workspaceId);
                const node = writableNodeKey(workspaceId, nodeId);
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
                const node = nodeKey(workspaceId, nodeId);
                if (!node) throw new CryptoError('Open the containing folder first.');
                if (node.epoch !== keyEpoch)
                    throw new CryptoError(
                        'This item changed since it was opened. Refresh and retry.',
                    );
                const envelopes = [];
                for (const operator of message.input.operators) {
                    // A version 2 identity's KEM key is used only once its keys statement holds.
                    const hybrid =
                        operator.mlDsaPublicKey && operator.kemPublicKey && operator.keysSignature;
                    if (
                        hybrid &&
                        !(await verifyIdentityKeys(operator.userId, {
                            keyVersion: operator.keyVersion,
                            encryptionPublicKey: operator.encryptionPublicKey,
                            signingPublicKey: operator.signingPublicKey,
                            mlDsaPublicKey: operator.mlDsaPublicKey!,
                            kemPublicKey: operator.kemPublicKey!,
                            keysSignature: operator.keysSignature!,
                        }))
                    )
                        throw new CryptoError("An operator's key does not match their identity.");
                    envelopes.push({
                        userId: operator.userId,
                        keyEnvelope: encode(
                            await sealReportKey(
                                node.key,
                                {
                                    encryptionPublicKey: decode(operator.encryptionPublicKey, 32),
                                    kemPublicKey: operator.kemPublicKey
                                        ? decode(operator.kemPublicKey, KEM_PUBLIC_KEY_BYTES)
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
                refuseOwnWorkspace(workspaceId);
                if (!identityKey || identityKey.userId !== operatorUserId)
                    throw new CryptoError('Open your identity first.');
                const cached = nodeKey(workspaceId, nodeId);
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
                rememberNodeKey(workspaceId, nodeId, key, keyEpoch);
                return { opened: true as const };
            }
            case 'driveLinkSecret': {
                const { workspaceId, nodeId, keyEpoch, linkId } = message.input;
                const node = nodeKey(workspaceId, nodeId);
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
                if (isArea(workspaceId)) throw new CryptoError(FAMILY_SHARING);
                requireWritable(workspaceId);
                const node = writableNodeKey(workspaceId, nodeId);
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
                refuseOwnWorkspace(workspaceId);
                const cached = nodeKey(workspaceId, nodeId);
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
                    rememberNodeKey(workspaceId, nodeId, key, keyEpoch);
                    return { opened: true as const };
                } finally {
                    secret.fill(0);
                }
            }
            case 'driveRotateNodes': {
                const { workspaceId, targetEpoch, granterUserId } = message.input;
                requireWritable(workspaceId);
                // Every record is checked before it is signed again: without the trust
                // set the whole batch stops, rather than re-sealing everything in it.
                const trusted = trustSet(message.input.signers);
                // A group's area is always judged as its roster says (plan finding 6): never personally.
                if (isArea(workspaceId) && !message.input.group)
                    throw new CryptoError(
                        'A family folder is rotated only with the family’s trust.',
                    );
                const judge = message.input.group
                    ? await groups.rotationJudge(workspaceId, message.input.group)
                    : personalJudge(trusted);
                const out: RotatedNode[] = [];
                for (const node of message.input.nodes) {
                    try {
                        out.push(
                            await rotateOne(workspaceId, targetEpoch, granterUserId, node, judge),
                        );
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
                // A family folder this session opened (its id derived under its family) served as a
                // personal workspace would skip its version checks. A family's roster merely naming
                // the workspace is no reason: a hostile family could name the person's own drive.
                if (ledger.openedByFamily(grant.workspaceId)) throw new CryptoError(FAMILY_FOLDER);
                // Opened under the account root as a personal grant, a context no family's key opens
                // under: the account's own workspace, never an area, whatever a family's roster lists.
                if (ledger.workspaceKey(grant.workspaceId, grant.workspaceKeyVersion))
                    return {
                        workspaceId: grant.workspaceId,
                        workspaceKeyVersion: grant.workspaceKeyVersion,
                    };
                const root = accountKey.slice();
                try {
                    const key = await openWorkspaceKey(root, unlockedUserId, grant);
                    ledger.openPersonalWorkspace(
                        grant.workspaceId,
                        grant.workspaceKeyVersion,
                        key as Uint8Array<ArrayBuffer>,
                    );
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
                if (!ledger.hasWorkspace(workspaceId)) throw new CryptoError('Open Drive first.');
                const envelope = await sealDocument(document, writeVersionOf(workspaceId).key, {
                    workspaceId,
                    kind,
                    version,
                });
                return { envelope: encode(envelope) };
            }
            case 'driveOpenDocument': {
                const { workspaceId, kind, version, envelope } = message.input;
                return openDocumentUnderAny(workspaceId, kind, version, envelope);
            }
            case 'driveRotateCommit':
            case 'driveRotateDrop': {
                const { workspaceId, nodeIds } = message.input;
                return message.operation === 'driveRotateDrop'
                    ? { dropped: ledger.dropPending(workspaceId, nodeIds) }
                    : { committed: ledger.commitPending(workspaceId, nodeIds) };
            }
            case 'driveCreateNodes': {
                const { workspaceId } = message.input;
                requireWritable(workspaceId);
                const out: CryptoResults['driveCreateNodes']['nodes'] = [];
                const created: { id: string; key: Uint8Array<ArrayBuffer>; epoch: number }[] = [];
                // Every node is signed by its writer: refuse before minting anything.
                if (!identityKey) throw new CryptoError('Open your identity first.');
                try {
                    for (const node of message.input.nodes) {
                        // Wrapped under its parent by the family write rules, and held rooted
                        // where its parent is: later nodes in the batch may be its children.
                        const { key, keyEnvelope } = await ledger.newNodeKey(workspaceId, node);
                        created.push({ id: node.id, key, epoch: node.keyEpoch });
                        const metadataEnvelope = await sealMetadata(node.metadata, key, {
                            workspaceId,
                            nodeId: node.id,
                            metadataVersion: 1,
                        });
                        out.push({
                            id: node.id,
                            keyEnvelope: encode(keyEnvelope),
                            metadataEnvelope: encode(metadataEnvelope),
                            metadataSignature: await signMetadata(
                                {
                                    workspaceId,
                                    nodeId: node.id,
                                    kind: node.kind,
                                    metadataVersion: 1,
                                },
                                metadataEnvelope,
                                node.signAs ?? 'ordinary',
                            ),
                        });
                    }
                } catch (error) {
                    for (const node of created) {
                        ledger.forgetNodeKey(workspaceId, node.id);
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
                        // The key, held rooted as its path is, and the area made writable
                        // only by a root its member list committed to (area-ledger.ts).
                        const key = await ledger.openListedNode(workspaceId, node);
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
                const { workspaceId, nodeId, kind, metadataVersion } = message.input;
                requireWritable(workspaceId);
                const entry = writableNodeKey(workspaceId, nodeId);
                if (!entry) throw new CryptoError('Open the containing folder first.');
                if (!identityKey) throw new CryptoError('Open your identity first.');
                const metadataEnvelope = await sealMetadata(message.input.metadata, entry.key, {
                    workspaceId,
                    nodeId,
                    metadataVersion,
                });
                return {
                    metadataEnvelope: encode(metadataEnvelope),
                    metadataSignature: await signMetadata(
                        { workspaceId, nodeId, kind, metadataVersion },
                        metadataEnvelope,
                        message.input.signAs ?? 'ordinary',
                    ),
                };
            }
            case 'driveVerify': {
                const { workspaceId } = message.input;
                // A family folder's records are judged only as its member list says (groupVerify):
                // by personal pins alone a former member's record could read verified and be
                // signed again as this person's own.
                if (isArea(workspaceId))
                    throw new CryptoError(
                        'A family folder is checked only with the family’s member list.',
                    );
                const trusted = trustSet(message.input.signers);
                // Never a family folder here: origins are read only where rekeyedFor reaches, so a
                // personal row read as shipped apps read it, by its legacy columns, whatever is served.
                const readsOrigins = rekeyedFor({ ownerKind: 'personal' });
                const nodes: DriveVerifiedNode[] = [];
                for (const node of message.input.nodes) {
                    // A re-keyed record reads as its origin, opened with the node's key at its epoch.
                    const key =
                        node.keyEpoch === undefined
                            ? null
                            : keyAtEpoch(workspaceId, node.id, node.keyEpoch);
                    const rekeyed = async (
                        record: RekeyedRecord,
                        rekeyer: string | null,
                    ): Promise<{ integrity: Integrity; rekey: RekeyCheck }> => {
                        const origin = record.origin.signerId;
                        const verdict = await rekeyedIntegrityOf(record, key, {
                            origin: origin ? (trusted.get(origin.toLowerCase()) ?? null) : null,
                            rekeyer: rekeyer ? (trusted.get(rekeyer.toLowerCase()) ?? null) : null,
                        });
                        return {
                            integrity: verdict.origin,
                            rekey: { rekeyer: verdict.rekeyer, bound: verdict.bound },
                        };
                    };
                    const metadataStatement = {
                        workspaceId,
                        nodeId: node.id,
                        kind: node.kind,
                        metadataVersion: node.metadataVersion,
                    };
                    let metadata: Integrity;
                    let metadataRekey: RekeyCheck | null = null;
                    if (readsOrigins && node.metadataRekey) {
                        const checked = await rekeyed(
                            servedRekeyedRecord(
                                'metadata',
                                metadataStatement,
                                node.keyEpoch ?? 0,
                                node.metadataEnvelope,
                                node.metadataRekey,
                            ),
                            node.metadataSigner,
                        );
                        metadata = checked.integrity;
                        metadataRekey = checked.rekey;
                    } else
                        metadata = await checkRecord(
                            trusted,
                            async () =>
                                metadataStatements(
                                    metadataStatement,
                                    decode(node.metadataEnvelope),
                                ),
                            node.metadataSigner,
                            node.metadataSignature,
                        );
                    const versions: DriveVerifiedNode['versions'] = [];
                    for (const version of node.versions ?? []) {
                        const statement = {
                            workspaceId,
                            nodeId: node.id,
                            versionId: version.id,
                            objectId: version.objectId,
                            contentSuite: version.contentSuite,
                        };
                        if (readsOrigins && version.rekey) {
                            const checked = await rekeyed(
                                servedRekeyedRecord(
                                    'version',
                                    statement,
                                    node.keyEpoch ?? 0,
                                    version.contentKeyEnvelope,
                                    version.rekey,
                                ),
                                version.signer,
                            );
                            versions.push({ id: version.id, ...checked });
                        } else
                            versions.push({
                                id: version.id,
                                integrity: await checkRecord(
                                    trusted,
                                    async () =>
                                        versionStatements(
                                            statement,
                                            decode(version.contentKeyEnvelope),
                                        ),
                                    version.signer,
                                    version.signature,
                                ),
                            });
                    }
                    nodes.push({
                        id: node.id,
                        metadata,
                        ...(metadataRekey ? { metadataRekey } : {}),
                        versions,
                    });
                }
                return { nodes };
            }
            case 'driveRewrapNode': {
                const { workspaceId, nodeId, parentId, parentKeyEpoch, keyEpoch } = message.input;
                const keyEnvelope = await ledger.rewrapNode(workspaceId, {
                    id: nodeId,
                    parentId,
                    parentKeyEpoch,
                    keyEpoch,
                });
                return { keyEnvelope: encode(keyEnvelope) };
            }
            case 'driveUploadPrepare': {
                const { workspaceId, nodeId, versionId, objectId, plaintextSize } = message.input;
                requireWritable(workspaceId);
                const node = writableNodeKey(workspaceId, nodeId);
                if (!node) throw new CryptoError('Open the containing folder first.');
                if (!identityKey) throw new CryptoError('Open your identity first.');
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
                          suite: CONTENT_SUITE,
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
                const length = contentLength(CONTENT_SUITE, plaintextSize, thumbnailBytes);
                uploads.set(objectId, {
                    workspaceId,
                    contentKey,
                    contentNonce,
                    plaintextSize,
                    contentLength: length,
                    chunkCount: chunkCount(length),
                    thumbnailBytes,
                    thumbnail,
                    requests: new Map(),
                    encrypted: new Map(),
                });
                return {
                    contentNonce: encode(contentNonce),
                    contentKeyEnvelope: encode(envelope),
                    versionSignature: await signVersion(
                        { workspaceId, nodeId, versionId, objectId, contentSuite: CONTENT_SUITE },
                        envelope,
                        message.input.signAs ?? 'ordinary',
                    ),
                    chunkCount: chunkCount(length),
                    ciphertextSize: ciphertextSize(CONTENT_SUITE, plaintextSize, thumbnailBytes),
                    thumbnail: thumbnail ? thumbnail.slice() : null,
                };
            }
            case 'driveThumbnailFetch': {
                const { workspaceId, nodeId, version, url } = message.input;
                const node = nodeKey(workspaceId, nodeId);
                if (!node) throw new CryptoError('Open the containing folder first.');
                const opened = await openVersionUnder(node.key, workspaceId, nodeId, version);
                try {
                    if (opened.thumbnailBytes < 1)
                        throw new CryptoError('This file has no thumbnail.');
                    const range = thumbnailRange(
                        opened.suite,
                        opened.plaintextSize,
                        opened.thumbnailBytes,
                    );
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
                            suite: opened.suite,
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
                const node = nodeKey(workspaceId, nodeId);
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
                requireWritable(workspaceId);
                const upload = uploads.get(objectId);
                if (!upload) throw new CryptoError('This upload is not open here.');
                const node = writableNodeKey(workspaceId, nodeId);
                if (!node) throw new CryptoError('Open the destination folder first.');
                if (!identityKey) throw new CryptoError('Open your identity first.');
                const envelope = await sealVersion(
                    {
                        contentKey: upload.contentKey,
                        plaintextSize: upload.plaintextSize,
                        thumbnailBytes: upload.thumbnailBytes,
                    },
                    node.key,
                    { workspaceId, nodeId, versionId, objectId, suite: CONTENT_SUITE },
                );
                return {
                    contentKeyEnvelope: encode(envelope),
                    versionSignature: await signVersion(
                        { workspaceId, nodeId, versionId, objectId, contentSuite: CONTENT_SUITE },
                        envelope,
                        message.input.signAs ?? 'ordinary',
                    ),
                };
            }
            case 'driveCopyFile': {
                const { workspaceId, source, node, versionId } = message.input;
                // A copy re-signs its source: in a family folder only as the family's member list
                // judges it, so a former member's record is never signed as this person's own.
                const group = message.input.group ?? null;
                if (isArea(workspaceId) && !group)
                    throw new CryptoError(
                        'A family folder’s files are copied only with the family’s trust.',
                    );
                if (group && group.staged !== null)
                    throw new CryptoError('A copy is judged by the family as it stands.');
                requireWritable(workspaceId);
                const sourceKey = nodeKey(workspaceId, source.nodeId);
                if (!sourceKey) throw new CryptoError('Open the containing folder first.');
                if (!identityKey) throw new CryptoError('Open your identity first.');
                // The source as a reading would check it: only what verified is vouched for again,
                // and a copy of something saved from a link stays saved.
                const trusted = trustSet(message.input.signers);
                // A re-keyed source served without its key epoch: its signature columns are the
                // walker's, so nothing about its writer can be judged, and it is not copied.
                if (
                    group !== null &&
                    source.keyEpoch === undefined &&
                    (source.metadataRekey || source.rekey)
                )
                    throw new CryptoError(
                        'HushOS couldn’t check who wrote this, so it was not locked again. Try again.',
                    );
                // A re-keyed source is judged on its writer's record, where origins are read.
                const readsOrigins =
                    group !== null &&
                    source.keyEpoch !== undefined &&
                    rekeyedFor({ ownerKind: isArea(workspaceId) ? 'group' : 'personal' });
                const originKey = readsOrigins
                    ? keyAtEpoch(workspaceId, source.nodeId, source.keyEpoch!)
                    : null;
                const rekeyedOf = (
                    record: 'metadata' | 'version',
                    statement: MetadataStatement | VersionStatement,
                    envelope: string,
                    rekey: ServedRekey | null | undefined,
                    rekeyer: string | null,
                ) =>
                    readsOrigins && rekey
                        ? {
                              rekeyed: {
                                  record: servedRekeyedRecord(
                                      record,
                                      statement,
                                      source.keyEpoch!,
                                      envelope,
                                      rekey,
                                  ),
                                  nodeKey: originKey,
                                  rekeyer,
                              },
                          }
                        : {};
                const metadataRecord = {
                    statements: async () =>
                        metadataStatements(
                            {
                                workspaceId,
                                nodeId: source.nodeId,
                                kind: 'file',
                                metadataVersion: source.metadataVersion,
                            },
                            decode(source.metadataEnvelope),
                        ),
                    signer: source.metadataSigner,
                    signature: source.metadataSignature,
                    ...rekeyedOf(
                        'metadata',
                        {
                            workspaceId,
                            nodeId: source.nodeId,
                            kind: 'file',
                            metadataVersion: source.metadataVersion,
                        },
                        source.metadataEnvelope,
                        source.metadataRekey,
                        source.metadataSigner,
                    ),
                };
                const versionRecord = {
                    statements: async () =>
                        versionStatements(
                            {
                                workspaceId,
                                nodeId: source.nodeId,
                                versionId: source.id,
                                objectId: source.objectId,
                                contentSuite: source.contentSuite,
                            },
                            decode(source.contentKeyEnvelope),
                        ),
                    signer: source.signer,
                    signature: source.signature,
                    ...rekeyedOf(
                        'version',
                        {
                            workspaceId,
                            nodeId: source.nodeId,
                            versionId: source.id,
                            objectId: source.objectId,
                            contentSuite: source.contentSuite,
                        },
                        source.contentKeyEnvelope,
                        source.rekey,
                        source.signer,
                    ),
                };
                // In a family folder the family's judge (it refuses another group's or a
                // personal workspace); elsewhere this person's own pins.
                const judge = group
                    ? await groups.copyJudge(workspaceId, group, trusted)
                    : async (record: typeof metadataRecord) =>
                          copyForm(
                              await checkRecord(
                                  trusted,
                                  record.statements,
                                  record.signer,
                                  record.signature,
                              ),
                              false,
                          );
                const metadataForm = (await judge(metadataRecord)) ?? 'resealed';
                const versionForm = (await judge(versionRecord)) ?? 'resealed';
                const parentKey = wrapKeyFor(workspaceId, node.parentId, node.parentKeyEpoch);
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
                    const signatures = {
                        metadataSignature: await signMetadata(
                            { workspaceId, nodeId: node.id, kind: 'file', metadataVersion: 1 },
                            metadataEnvelope,
                            metadataForm,
                        ),
                        versionSignature: await signVersion(
                            {
                                workspaceId,
                                nodeId: node.id,
                                versionId,
                                objectId: source.objectId,
                                contentSuite: opened.suite,
                            },
                            contentKeyEnvelope,
                            versionForm,
                        ),
                    };
                    rememberNodeKey(
                        workspaceId,
                        node.id,
                        key,
                        node.keyEpoch,
                        rootOf(workspaceId, node.parentId, node.parentKeyEpoch),
                    );
                    return {
                        keyEnvelope: encode(keyEnvelope),
                        metadataEnvelope: encode(metadataEnvelope),
                        contentKeyEnvelope: encode(contentKeyEnvelope),
                        ...signatures,
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
                requireWritable(workspaceId);
                // Only opens the version's content key (a read): the write that follows goes
                // through driveUploadRewrap or driveCreateNodes, which ask the key's root.
                const node = nodeKey(workspaceId, nodeId);
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
                const length = contentLength(CONTENT_SUITE, plaintextSize, opened.thumbnailBytes);
                uploads.set(objectId, {
                    workspaceId,
                    contentKey: opened.contentKey,
                    contentNonce,
                    plaintextSize,
                    contentLength: length,
                    chunkCount: chunkCount(length),
                    thumbnailBytes: opened.thumbnailBytes,
                    thumbnail,
                    requests: new Map(),
                    encrypted: new Map(),
                });
                return {
                    chunkCount: chunkCount(length),
                    ciphertextSize: ciphertextSize(
                        CONTENT_SUITE,
                        plaintextSize,
                        opened.thumbnailBytes,
                    ),
                };
            }
            case 'driveUploadDigest': {
                const upload = uploads.get(message.input.objectId);
                if (!upload)
                    throw new CryptoError('This upload is no longer prepared. Start it again.');
                const plaintext = await readChunk(upload, message.input.file, message.input.index);
                const digest = await chunkDigest(plaintext, upload.contentKey);
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
                        thumbnailBytes: upload.thumbnailBytes,
                    }),
                    chunkDigest(plaintext, upload.contentKey),
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
                const node = nodeKey(workspaceId, nodeId);
                if (!node) throw new CryptoError('Open the containing folder first.');
                closeDownload(version.objectId);
                const opened = await openVersionUnder(node.key, workspaceId, nodeId, version);
                const length = contentLength(
                    opened.suite,
                    opened.plaintextSize,
                    opened.thumbnailBytes,
                );
                downloads.set(version.objectId, {
                    workspaceId,
                    suite: opened.suite,
                    contentKey: opened.contentKey,
                    contentNonce: decode(message.input.contentNonce, 16) as Uint8Array<ArrayBuffer>,
                    plaintextSize: opened.plaintextSize,
                    thumbnailBytes: opened.thumbnailBytes,
                    chunkCount: chunkCount(length),
                    controllers: new Map(),
                });
                // Every chunk, padding included: a reader that stopped at the file's last chunk
                // would show the store where the file ends. Chunks past it come back empty.
                return {
                    chunkCount: chunkCount(length),
                    plaintextSize: opened.plaintextSize,
                    thumbnailBytes: opened.thumbnailBytes,
                };
            }
            case 'driveDownloadChunk': {
                const { objectId, url, index } = message.input;
                const download = downloads.get(objectId);
                if (!download)
                    throw new CryptoError('This download is no longer open. Start it again.');
                const range = chunkRange(
                    download.suite,
                    download.plaintextSize,
                    download.thumbnailBytes,
                    index,
                );
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
                            thumbnailBytes: download.thumbnailBytes,
                        },
                    );
                    return {
                        ok: true,
                        plaintext: fileBytesOf(plaintext, download.plaintextSize, index),
                        index,
                    };
                } finally {
                    download.controllers.delete(index);
                }
            }
            case 'driveDownloadClose':
                return { closed: closeDownload(message.input.objectId) };
            case 'driveExportKeys': {
                const { workspaceId, nodeId, version } = message.input;
                const node = nodeKey(workspaceId, nodeId);
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
            case 'driveStashKey': {
                // Only the unlocked account's own key: a locked worker has nothing to derive from.
                if (!accountKey || unlockedUserId !== message.input.userId)
                    throw new CryptoError('Unlock your account first.');
                const root = accountKey.slice();
                try {
                    return { key: await deriveStashKey(root, message.input.userId) };
                } finally {
                    root.fill(0);
                }
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
