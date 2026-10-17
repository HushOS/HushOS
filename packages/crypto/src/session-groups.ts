import { encryptKey, decryptKey } from './aead';
import { areaKeyCommitment } from './area-keys';
import { encodeStatement, sameBytes, uuid } from './canonical';
import type { ContactPin } from './contacts';
import {
    generateKey,
    openDocument,
    openNodeKey,
    openPreviousRootKey,
    sealDocument,
    sealMetadata,
    wrapNodeKey,
    wrapPreviousRootKey,
    type NodeMetadata,
} from './drive';
import { CryptoError } from './errors';
import { sameKeyDigest } from './fingerprint';
import {
    acceptRosters,
    firstRoster,
    foldInEntry,
    groupIntegrityOf,
    groupRekeyedIntegrityOf,
    groupWriterTrust,
    joinCode,
    newRosterEntry,
    nextRoster,
    ownRosterEntry,
    pinAfter,
    trustAsGroupDoes,
    type AcceptedRosters,
    type GroupChainCache,
    type GroupIntegrity,
    type GroupReading,
    type GroupWriterTrust,
    type JoinMark,
    type RosterFork,
    type ServedIdentity,
    type WriterPin,
} from './group-trust';
import {
    AREA_GRANT_BYTES,
    GROUP_KEY_SEAL_BYTES,
    activeWith,
    areaWriteVersion,
    areasToRotate,
    groupKeyPair,
    groupWords,
    newGroupSeed,
    openAreaGrant,
    openGroupKey,
    parseRoster,
    rosterDigest,
    rosterEntry,
    sameGroupKey,
    sealAreaGrant,
    sealGroupKey,
    signGroupSuccession,
    signRoster,
    type GroupKeyPair,
    type GroupPublicKey,
    type GroupRole,
    type Roster,
    type RosterMember,
    type SignedGroupStatement,
    type SignerHistory,
} from './groups';
import {
    openIdentityMlDsaKey,
    openIdentitySigningKey,
    publicIdentity,
    verifyOwnIdentity,
    SUCCESSION_CONSENT_BYTES,
    type IdentityEnvelope,
    type ServedKeys,
    type SuccessionLink,
} from './identity';
import { checkId, newId } from './ids';
import { decode, encode } from './keys';
import type { GroupPin } from './pins';
import { ML_DSA_PUBLIC_KEY_BYTES } from './pq';
import { GROUP_OPERATIONS } from './protocol';
import type { GranteeSecrets } from './sealing';
import type {
    DriveSignedNode,
    DriveSigners,
    RekeyOut,
    RotateNodeInput,
    RotatedNode,
    RotatedRecord,
    ServedRekey,
} from './session';
import {
    digest,
    integrityOf,
    metadataStatementAs,
    metadataStatements,
    resealForm,
    signHybrid,
    signStatement,
    successionConsentStatement,
    versionStatements,
    HYBRID_SIGNATURE_BYTES,
    type HybridSigningKey,
    type Integrity,
    type MetadataStatement,
    type RekeyedRecord,
    type SignatureForm,
    type StatementForms,
    type TrustedSigner,
    type VersionStatement,
} from './signatures';
import { grantAreaKey, openAreaSelfGrant, type WorkspaceKeyEnvelope } from './workspace';

/*
 * The crypto worker's side of groups (milestone 1c; docs/groups-design.md 2.4
 * and 3, the 1c plan's section 1.2). Every accepted chain lives here and only
 * here: accepted.ts keeps accepted chains in a WeakSet of this realm, so a
 * chain posted to the main thread and back opens and vouches for nothing. The
 * main thread gets plain views, signed bodies to send, and sealed records to
 * keep; the group seeds, the area keys and the staged secrets never leave.
 *
 * Two kinds of chain:
 * - the committed chain of a group, accepted only from what the server
 *   served (groupAccept), the one whose cache and pin may be written;
 * - a staged chain per roster call (groupStage, groupCreate), the caller's own
 *   signed, unsent roster accepted on top of the committed chain, used only to
 *   seal and grant for that call and to judge writers for its rotations. A
 *   staged chain never becomes a mark: no record or pin is ever made from it,
 *   and nothing stages on top of one.
 *
 * The write rule (F9, plan section 5): a group area is written only under its
 * latest version on the committed chain (`writeVersion`), and only while the
 * last groupOpenArea found nothing that says the server is behind or ahead.
 */

/* ------------------------------------------------------------------------- */
/* Wire shapes: structurally the group routes' (packages/groups/src/api.ts)   */
/* ------------------------------------------------------------------------- */

export type SignedStatementWire = {
    statement: string;
    signature: { ed25519: string; mlDsa: string };
    signerSignature: string;
};
export type SealWire = {
    groupKeyVersion: number;
    holderUserId: string;
    holderKeyVersion: number;
    rosterVersion: number;
    rosterDigest: string;
    envelope: string;
};
export type GrantWire = {
    workspaceId: string;
    workspaceKeyVersion: number;
    granteeUserId: string;
    granteeKeyVersion: number;
    rosterVersion: number;
    rosterDigest: string;
    envelope: string;
};
export type AreaRootWire = {
    id: string;
    idSeed: string;
    keyEpoch: number;
    parentKeyEpoch: number;
    keyEnvelope: string;
    metadataEnvelope: string;
    metadataSignature: string;
};
export type RotatedNodeWire = {
    id: string;
    changeSeq: number;
    parentKeyEpoch: number;
    keyEnvelope: string;
    rotated: {
        metadataEnvelope: string;
        /* Re-keyed records carry no legacy signature in a family folder (decision D3). */
        metadataSignature?: string | null;
        metadataRekey?: RekeyOut | null;
        metadataDropOrigin?: boolean;
        versions: ({ id: string; contentKeyEnvelope: string } & RotatedRecord)[];
        shares: { id: string; shareEnvelope: string }[];
        links: { id: string; linkEnvelope: string; secretEnvelope: string }[];
        unsealableLinks: string[];
    } | null;
};
export type RotationWire = {
    workspaceId: string;
    fromVersion: number;
    toVersion: number;
    targetEpoch: number;
    root: RotatedNodeWire;
    /*
     * The root's old key wrapped under the new area key, under the
     * previous-root label of its own (previousRootKeyContext in drive.ts:
     * ["hushos/drive/previous-root-key",1,workspaceId,root,workspaceId,
     * toVersion,the root's epoch before]), so it opens only as the root's
     * previous key, never as its current one (docs/groups-server.md 8,
     * option A).
     */
    previousRootKeyEnvelope: string;
    selfGrant: WorkspaceKeyEnvelope;
    /*
     * Every workspace document of the area, sealed again under the new area
     * key: `version` is the version read (the precondition, as on PUT
     * /drive/workspaces/:id/documents/:kind), and `envelope` is sealed for
     * version + 1. The server must store them in the roster call's transaction
     * or refuse the call (docs/groups-server.md 8).
     */
    documents: RotatedDocumentWire[];
};
export type RotatedDocumentWire = { kind: string; version: number; envelope: string };
export type CreateGroupBody = {
    id: string;
    idSeed: string;
    kind: 'family';
    name: string;
    groupKey: GroupPublicKey;
    roster: SignedStatementWire;
    keySeal: { envelope: string };
    area: {
        workspaceId: string;
        idSeed: string;
        root: AreaRootWire;
        grant: { envelope: string };
        selfGrant: WorkspaceKeyEnvelope;
    };
};
/* Every roster route's body (7, 17, 18, 19, 21, 24): what applies to the call, nothing else. */
export type RosterCallBody = {
    expectedRevision: number;
    roster: SignedStatementWire;
    succession?: SignedStatementWire;
    seals?: SealWire[];
    keySeal?: SealWire;
    grants?: GrantWire[];
    rotations?: RotationWire[];
    rotation?: RotationWire;
    area?: {
        workspaceId: string;
        idSeed: string;
        root: AreaRootWire;
        selfGrant: WorkspaceKeyEnvelope;
    };
};

/* Route 5's page, as the caller gathered it from version 1 or after the cache. */
export type ServedChain = {
    rosters: SignedStatementWire[];
    successions: SignedStatementWire[];
    firstKeys: GroupPublicKey;
    /* SHA-256 (base64url) of every signer's ML-DSA key, to that key. */
    signerKeys: Record<string, string>;
};

/*
 * A writer as a group verdict takes them: the reader's pin of them (with its
 * origin), their identity and links as route 6 served them (null when they did
 * not load), and the personal keys driveVerify would use, for records the
 * roster does not speak for.
 */
export type GroupWriter = {
    userId: string;
    pinned: WriterPin | null;
    served: ServedKeys | null;
    links: SuccessionLink[] | null;
    personal: { current: string; retired: string[] } | null;
};
/* driveRotateNodes in a group's area: whose roster judges each record before it is signed again. */
export type GroupRotationTrust = {
    groupId: string;
    /* The roster call whose staged chain judges (a removal's rotation), or null for the committed chain. */
    staged: string | null;
    writers: GroupWriter[];
};

/*
 * The area root as a roster rotation re-keys it: the worker's input, built
 * from the root as the server serves it for that purpose (a Drive
 * RotationWorkNode of the root, served per area), mapped as the Drive walk
 * maps its nodes:
 * - id, kind ('folder'), keyEpoch, keyEnvelope, metadataVersion,
 *   metadataEnvelope, changeSeq: as served;
 * - parentId: the area's workspace id;
 * - wrappedParentKeyEpoch: the served parentKeyEpoch, the area key version
 *   the root's envelope is under now (the rotation's fromVersion);
 * - parentKeyEpoch: the area key version the root goes under, toVersion
 *   (fromVersion + 1), set by the client, never served;
 * - metadataSigner / metadataSignature: the served signer's id and signature,
 *   null before signatures;
 * - versions: each { id, objectId, contentKeyEnvelope, contentSuite,
 *   plaintextSize (a number, null under suites 2 and 3), signer (id or null),
 *   signature };
 * - shares: each live share the owner's ledger and the grantee's pin let the
 *   rotator re-seal, { id, granteeUserId, granteePublicKey,
 *   granteeKemPublicKey } (from the served grantee identity, checked first);
 * - links: each { id, hasPassword, secretEnvelope (null when unsealable) }.
 */
export type AreaRootRotationInput = RotateNodeInput & { changeSeq: number };
/* What a Drive rotation of an area's root needs, as the rotation work serves the root. */
export type AreaRotationInput = {
    workspaceId: string;
    /* Drawn from /drive/workspaces/:id/epochs, above every epoch a node in the area carries. */
    targetEpoch: number;
    root: AreaRootRotationInput;
    /*
     * Every workspace document of the area as served (/drive/workspaces/:id/
     * documents/:kind): each opens under the area's current key and is sealed
     * again under the new one in the same call, so documents never sit under a
     * key the rotation takes away.
     */
    documents: RotatedDocumentWire[];
};

export type GroupStageOp =
    | { kind: 'admit'; userId: string; pin: ContactPin; served: ServedIdentity; roles: GroupRole[] }
    | { kind: 'remove'; userId: string; rotations: AreaRotationInput[] }
    | { kind: 'markLeft'; userIds: string[]; rotations: AreaRotationInput[] }
    | { kind: 'roles'; userId: string; roles: GroupRole[] }
    | {
          kind: 'foldIn';
          members: { userId: string; served: ServedIdentity; links: SuccessionLink[] }[];
          /* The account's earlier identities, for one's own fold-in signed with the keys the old entry names. */
          history?: IdentityEnvelope[];
      }
    | { kind: 'area'; name: string }
    | { kind: 'rotate'; rotation: AreaRotationInput };

/* A plain view of a committed chain: what the main thread may know of it. */
export type GroupView = {
    groupId: string;
    kind: 'family' | 'org';
    rosterVersion: number;
    rosterDigest: string;
    groupKeyVersion: number;
    creatorUserId: string;
    members: RosterMember[];
    /* Each area's write version: its latest key version on the chain. */
    areas: Record<string, number>;
    successionDue: boolean;
    ownEntryWrongAt: number[];
    ownEntryBehindAt: number[];
    deadBranches: { version: number; signerUserId: string }[];
};

type SealInput = {
    groupKeyVersion: number;
    holderKeyVersion: number;
    sealerUserId: string;
    rosterVersion: number;
    rosterDigest: string;
    envelope: string;
};
type GrantInput = {
    workspaceKeyVersion: number;
    granteeKeyVersion: number;
    granterUserId: string;
    rosterVersion: number;
    rosterDigest: string;
    envelope: string;
};

/* Records the data layer keeps sealed in its own IndexedDB stores. */
export type DeviceStore = 'outbox' | 'joins';

export type GroupRequests = {
    /*
     * A family, made and staged here: the group seed and id, the first area
     * ("Family") with its key and root, roster version 1 from firstRoster with
     * the creator's own entry (roles billing and members), the seed sealed and
     * the area granted to the creator, and the creator's self-grant. Refused
     * unless the staged acceptance, with the account's identities as just
     * fetched (each proven to open under this account), reports no wrong or
     * behind own entry (design 3.1). Keep `stagedEnvelope` in the outbox until
     * the first committed acceptance has written the record and the pin.
     */
    groupCreate: {
        userId: string;
        name: string;
        areaName?: string;
        identities: { identity: IdentityEnvelope; history: IdentityEnvelope[] };
    };
    groupWords: { groupId: string; firstKeys: GroupPublicKey };
    /*
     * Accepts what route 5 served against this person's marks: the group pin
     * in the settings this worker last opened or sealed (settingsOpen,
     * settingsSeal; refused when it has opened none), and this device's sealed
     * record (its cache and device pin). With no
     * mark at all only two callers may vouch for the first keys: `joining`
     * (the join flow, with the join code the person compared with the admin's
     * screen as its mark) and `creating` (the creator's outbox entry, whose
     * seed must derive the served first keys; refused when any mark exists).
     * Where marks exist, `joining` vouches for nothing: the marks decide, and
     * its join mark is one more. A refusal throws, and the group then reads
     * unavailable. Staged calls whose roster the accepted chain holds are
     * dropped and named in `dropped`.
     */
    groupAccept: {
        userId: string;
        groupId: string;
        served: ServedChain;
        record: string | null;
        checkedAt: string;
        joining?: { joinMark: JoinMark } | null;
        creating?: { stagedEnvelope: string } | null;
    };
    /*
     * The join code a newcomer compares with the admin's screen (design 2.4,
     * 3.2): the served chain verified against this person's marks, or, with
     * none, from version 1 over the served first keys, and the code of the
     * roster at which this account's entry last became active (the one that
     * admitted them). Nothing is committed, kept or marked, and a fork sets
     * nothing: only groupAccept with this code as `joining.joinMark`, once the
     * person said the two match, does.
     */
    groupJoinPreview: {
        userId: string;
        groupId: string;
        served: ServedChain;
        record: string | null;
    };
    /* Opens the group key's seal to this account (route 8), with the sealer's identity and links from route 6. */
    groupOpenSeal: {
        groupId: string;
        seal: SealInput;
        sealerMlDsaPublicKey: string;
        sealerHistory?: SignerHistory | null;
    };
    /*
     * Opens an area from route 25: the self-grant only when it is at the
     * area's latest version on the chain and the served one (and its key is the
     * chain's), else the area grant (envelope-migrations 5).
     */
    groupOpenArea: {
        groupId: string;
        workspaceId: string;
        idSeed: string;
        /* The area's workspaceKeyVersion as served. */
        servedVersion: number;
        grant: GrantInput | null;
        granterMlDsaPublicKey?: string | null;
        granterHistory?: SignerHistory | null;
        selfGrant: WorkspaceKeyEnvelope | null;
    };
    /*
     * Stages one roster call on the committed chain: the roster, signed, and
     * accepted as a staged chain, then the succession, seals, grants (to every
     * active member, the uploader included), rotations and self-grants it makes
     * due. `kems` is every member's ML-KEM key from route 6, checked here
     * against their entries; `writers` judges the records a rotation re-signs.
     */
    groupStage: {
        groupId: string;
        expectedRevision: number;
        op: GroupStageOp;
        kems: Record<string, string>;
        writers?: GroupWriter[];
    };
    /*
     * The staged chain again from the committed chain and the body's own
     * roster (after a reload, before a resend); with `rebuild`, the named
     * rotations made again with the same area and root keys (409 rotating,
     * epoch-stale, root-moved). The roster bytes never change.
     */
    groupRestage: {
        groupId: string;
        stagedEnvelope: string;
        body: RosterCallBody;
        rebuild?: { rotations: AreaRotationInput[]; writers: GroupWriter[] } | null;
    };
    groupDrop: { outboxId: string };
    /* Grants owed on the committed chain (route 22): each area's current key to an active member. */
    groupGrants: {
        groupId: string;
        missing: { workspaceId: string; userId: string; kemPublicKey: string }[];
    };
    /* The current group key sealed again to holders on the committed chain (route 9). */
    groupReseal: { groupId: string; holders: { userId: string; kemPublicKey: string }[] };
    groupVerify: {
        groupId: string;
        workspaceId: string;
        writers: GroupWriter[];
        nodes: DriveSignedNode[];
    };
    /*
     * The join code an admin reads to a newcomer: over the committed chain,
     * the roster at which `userId`'s entry last became active. `rosters` is
     * route 5 from version 1; only those whose digest is the committed chain's
     * at their version are read. With `pin` (the admin's contact pin of them),
     * whether their entry on that roster names exactly the pinned keys.
     */
    groupJoinCode: {
        groupId: string;
        userId: string;
        rosters: SignedStatementWire[];
        pin?: ContactPin | null;
    };
    groupTrustAs: {
        groupId: string;
        userId: string;
        served: ServedIdentity;
        contact: { email: string; name: string; pinnedAt: string };
    };
    /* The two consent halves of a link between two of this account's identities, signed by each. */
    identityConsent: { userId: string; old: IdentityEnvelope; next: IdentityEnvelope };
    groupForget: { groupId: string };
    groupStoreSeal: { userId: string; groupId: string; store: DeviceStore; value: unknown };
    groupStoreOpen: { userId: string; groupId: string; store: DeviceStore; envelope: string };
    /*
     * An area root's previous envelope during a roster rotation (option A),
     * checked with the area's current key: whether it opens, and when it does
     * not, the repair route 28 takes, from the root's old key this session
     * held before the rotation (docs/groups-server.md 8, "Repair"). The root as
     * route 25 serves it.
     */
    groupPreviousRoot: {
        groupId: string;
        workspaceId: string;
        root: {
            id: string;
            parentKeyEpoch: number;
            prevKeyEnvelope: string | null;
            prevKeyEpoch: number | null;
            prevParentKeyEpoch: number | null;
        };
    };
};

export type GroupStaged = {
    outboxId: string;
    body: RosterCallBody;
    stagedEnvelope: string;
    /* An admission's join code, over the staged roster. */
    joinCode: { rosterVersion: number; code: string[] } | null;
    /* Members whose served identity no succession chain reaches from their entry. */
    needsCheck: string[];
    /* Workspace documents that did not open and were replaced by an empty one of their kind. */
    replaced: ReplacedDocument[];
};
export type ReplacedDocument = { workspaceId: string; kind: string };
export type GroupResults = {
    groupCreate: {
        outboxId: string;
        groupId: string;
        body: CreateGroupBody;
        stagedEnvelope: string;
    };
    groupWords: { words: string[] };
    groupJoinPreview:
        | { status: 'code'; rosterVersion: number; code: string[] }
        /* The served chain holds no active entry for this account at its head: not let in yet. */
        | { status: 'not-admitted' }
        | { status: 'fork'; fork: RosterFork }
        | { status: 'record-unreadable' };
    groupAccept:
        | {
              status: 'accepted';
              view: GroupView;
              /* The sealed record to keep (cache and device pin). */
              record: string | null;
              /* The pin after this acceptance, for the settings document. */
              pin: GroupPin | null;
              /* Outbox ids of this device's staged calls the served chain holds: they landed. */
              dropped: string[];
          }
        | { status: 'fork'; fork: RosterFork }
        /*
         * This device's record did not open (sealed under an earlier account
         * root, after a master-key rotation): nothing was accepted. The caller
         * deletes it and accepts again without it, against the settings pin.
         */
        | { status: 'record-unreadable' };
    groupOpenSeal: { groupKeyVersion: number };
    groupOpenArea: {
        version: number;
        writable: boolean;
        /* Why the area may not be written: the reader shows "Couldn't check this folder's keys". */
        reason:
            | 'no-grant-at-latest'
            | 'server-behind'
            | 'server-ahead'
            | 'root-behind'
            | 'root-unknown'
            | null;
        selfGrantToStore: WorkspaceKeyEnvelope | null;
        pinArea: { workspaceId: string; version: number };
    };
    groupStage: GroupStaged | { outboxId: null; needsCheck: string[] };
    groupRestage: {
        outboxId: string;
        body: RosterCallBody;
        stagedEnvelope: string;
        replaced: ReplacedDocument[];
    };
    groupDrop: { dropped: boolean };
    groupGrants: { grants: GrantWire[] };
    groupReseal: { seals: SealWire[] };
    groupVerify: {
        nodes: {
            id: string;
            metadata: GroupIntegrity;
            via: string | null;
            /* A re-keyed record's re-keyer and binding (its verdict above is its origin's). */
            metadataRekey?: GroupRekeyCheck | null;
            versions: {
                id: string;
                integrity: GroupIntegrity;
                via: string | null;
                rekey?: GroupRekeyCheck | null;
            }[];
        }[];
    };
    groupJoinCode: { rosterVersion: number; code: string[]; pinMatches: boolean | null };
    groupTrustAs: { pin: ContactPin };
    identityConsent: { consent: string };
    groupForget: { forgotten: boolean };
    groupStoreSeal: { envelope: string };
    /* `unreadable`: sealed under another account root (a master-key rotation) or not this group's. */
    groupStoreOpen: { value: unknown } | { unreadable: true };
    groupPreviousRoot:
        /* No previous envelope under the current area key: nothing to check. */
        | { status: 'none' }
        | { status: 'opens' }
        /* It does not open, and this device held the old key: route 28's body. */
        | { status: 'repair'; previousRootKeyEnvelope: string }
        /* It does not open, and this device never held the old key. */
        | { status: 'cannot' };
};

/* Every group operation is listed in GROUP_OPERATIONS (protocol.ts), and nothing else is. */
type Unlisted = Exclude<keyof GroupRequests, (typeof GROUP_OPERATIONS)[number]>;
type Unknown = Exclude<(typeof GROUP_OPERATIONS)[number], keyof GroupRequests>;
const LISTED: [Unlisted, Unknown] extends [never, never] ? true : never = true;
void LISTED;
export type GroupMessage = {
    [K in keyof GroupRequests]: { id: number; operation: K; input: GroupRequests[K] };
}[keyof GroupRequests];
export function isGroupMessage(message: { operation: string }): message is GroupMessage {
    return (GROUP_OPERATIONS as readonly string[]).includes(message.operation);
}

/* A re-keyed record's re-keyer in a family folder, as the group's trust judges them, and the binding. */
export type GroupRekeyCheck = {
    rekeyer: GroupIntegrity;
    via: string | null;
    bound: boolean | null;
};
function rekeyCheckOf(verdict: {
    rekeyer: { integrity: GroupIntegrity; via: string | null };
    bound: boolean | null;
}): GroupRekeyCheck {
    return { rekeyer: verdict.rekeyer.integrity, via: verdict.rekeyer.via, bound: verdict.bound };
}

/*
 * How a record written again is signed, from the record as served: for a copy
 * the form itself; for a rotation the legacy signature beside a re-keyed
 * record (its writer's record is what is judged), or null for none, which is
 * what a family folder's rotation sends (decision D3: nothing a rotation
 * signs there claims authorship, and no shipped reader needs the legacy one).
 */
export type RecordJudge = (record: {
    statements: () => Promise<StatementForms>;
    signer: string | null;
    signature: string | null;
    /*
     * A re-keyed record (a copy's source in a family folder): judged on its
     * origin's verdict, which is its writer's only when its bytes bind, with
     * the node's key at its epoch and the re-keyer (the record's signer).
     */
    rekeyed?: { record: RekeyedRecord; nodeKey: Uint8Array | null; rekeyer: string | null };
}) => Promise<SignatureForm | null>;

/* A family folder's rotation: re-keyed records only, nothing judged, so nothing unreadable stops it. */
const rekeyOnly: RecordJudge = async () => null;

/*
 * A re-keyed record as the reader checks it, from what the server serves: the
 * current envelope under the node key at `keyEpoch`, its origin and the
 * re-key signature (docs/integrity-design.md, "Re-keyed records").
 */
export function servedRekeyedRecord(
    record: 'metadata' | 'version',
    statement: MetadataStatement | VersionStatement,
    keyEpoch: number,
    envelope: string,
    rekey: ServedRekey,
): RekeyedRecord {
    return {
        record,
        statement,
        keyEpoch,
        envelope: decode(envelope),
        origin: {
            envelope: decode(rekey.origin.envelope),
            signerId: rekey.origin.signerId,
            signature: decode(rekey.origin.signature),
            keyEnvelope: decode(rekey.origin.keyEnvelope),
        },
        rekeySignature: decode(rekey.signature),
    } as RekeyedRecord;
}

type RekeyedNode = {
    id: string;
    keyEnvelope: string;
    metadataEnvelope: string;
    metadataSignature: string | null;
    metadataRekey?: RekeyOut | null;
    metadataDropOrigin?: true;
    versions: ({ id: string; contentKeyEnvelope: string } & RotatedRecord)[];
    shares: { id: string; shareEnvelope: string }[];
    links: Extract<RotatedNode, { links: unknown }>['links'];
};

/* What the session lends this module: its unlocked root, open identity and Drive keys. */
export type GroupHost = {
    /* The account, with a copy of its root the caller zeroes. */
    unlocked(): { userId: string; root: Uint8Array<ArrayBuffer>; keyVersion: number };
    /* The open version 2 identity and the earlier version 2 ones, as proven when opened. */
    identity(): { userId: string; served: ServedIdentity; history: ServedIdentity[] };
    hybridKeys(): HybridSigningKey;
    granteeSecrets(keyVersion: number): GranteeSecrets;
    ownSigner(): TrustedSigner;
    personalSigners(signers: DriveSigners): Map<string, TrustedSigner>;
    workspaceKey(workspaceId: string, version: number): Uint8Array | undefined;
    holdWorkspaceKey(workspaceId: string, version: number, key: Uint8Array<ArrayBuffer>): void;
    dropWorkspace(workspaceId: string): void;
    currentKeyOf(workspaceId: string, node: RotateNodeInput): Promise<Uint8Array<ArrayBuffer>>;
    /* The node's key at `epoch` as the session holds it, not to be zeroed; null when it does not. */
    nodeKeyAt(workspaceId: string, nodeId: string, epoch: number): Uint8Array | null;
    /* A copy of the previous key this session holds for a node at `epoch` (the caller zeroes it). */
    previousNodeKey(workspaceId: string, nodeId: string, epoch: number): Uint8Array | undefined;
    rekeyNode(input: {
        workspaceId: string;
        targetEpoch: number;
        granterUserId: string | null;
        node: RotateNodeInput;
        judge: RecordJudge;
        old: Uint8Array;
        fresh: Uint8Array;
        parentKey: Uint8Array;
    }): Promise<RekeyedNode>;
};

/* ------------------------------------------------------------------------- */
/* The device store                                                          */
/* ------------------------------------------------------------------------- */

/*
 * What this device keeps of a group, sealed under a key derived from the
 * account root (HKDF-SHA-256, salt 32 zero bytes, info
 * "hushos/group/device-store/v1"), each record bound to the account, the
 * group and the store it is kept in by its associated data
 * ["hushos/group/device-store",1,userId,groupId,store]. Membership is the
 * social graph, so none of it sits on disk in the clear. A master-key rotation
 * makes it unreadable: groupAccept answers `record-unreadable` and
 * groupStoreOpen `unreadable`, and the data layer deletes those records and
 * verifies from version 1 against the settings pin alone (a family with no pin
 * either is then unchecked on this device).
 * `chains` (the cache and the device pin) and `staged` (a roster call's
 * secrets) are opened only here; `outbox` and `joins` are the data layer's.
 */
const STORE_INFO = 'hushos/group/device-store/v1';
const STORE_DOMAIN = 'hushos/group/device-store';
const STORE_VERSION = 1;
type Store = DeviceStore | 'chains' | 'staged';

async function storeKey(root: Uint8Array<ArrayBuffer>) {
    const material = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(
        await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new Uint8Array(32),
                info: new TextEncoder().encode(STORE_INFO),
            },
            material,
            256,
        ),
    );
}
function storeContext(userId: string, groupId: string, store: Store) {
    return encodeStatement([
        STORE_DOMAIN,
        STORE_VERSION,
        uuid(userId, 'user id'),
        uuid(groupId, 'group id'),
        store,
    ]);
}
/* Bytes sealed in the device store: [version][24-byte nonce][XChaCha20-Poly1305 of the bytes]. */
async function sealDeviceBytes(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    groupId: string,
    store: Store,
    plaintext: Uint8Array,
) {
    const key = await storeKey(root);
    try {
        const nonce = crypto.getRandomValues(new Uint8Array(24));
        const sealed = await encryptKey(
            plaintext,
            key,
            nonce,
            storeContext(userId, groupId, store),
        );
        const out = new Uint8Array(1 + nonce.length + sealed.length);
        out[0] = STORE_VERSION;
        out.set(nonce, 1);
        out.set(sealed, 1 + nonce.length);
        return encode(out);
    } finally {
        key.fill(0);
    }
}
/* The bytes a device store envelope holds: the caller's, to zero. */
async function openDeviceBytes(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    groupId: string,
    store: Store,
    envelope: string,
) {
    const refused = () =>
        new CryptoError('This saved family record could not be opened on this account.');
    let bytes: Uint8Array;
    try {
        bytes = decode(envelope);
    } catch {
        throw refused();
    }
    if (bytes.length < 1 + 24 + 16 || bytes[0] !== STORE_VERSION) throw refused();
    const key = await storeKey(root);
    try {
        return await decryptKey(
            bytes.subarray(25),
            key,
            bytes.subarray(1, 25),
            storeContext(userId, groupId, store),
        );
    } catch {
        throw refused();
    } finally {
        key.fill(0);
    }
}
/* A record that holds no secret (the chain cache and pin, the data layer's own), as JSON. */
export async function sealDeviceRecord(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    groupId: string,
    store: Store,
    value: unknown,
) {
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    try {
        return await sealDeviceBytes(root, userId, groupId, store, plaintext);
    } finally {
        plaintext.fill(0);
    }
}
export async function openDeviceRecord(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    groupId: string,
    store: Store,
    envelope: string,
): Promise<unknown> {
    const plaintext = await openDeviceBytes(root, userId, groupId, store, envelope);
    try {
        return JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
        throw new CryptoError('This saved family record could not be opened on this account.');
    } finally {
        plaintext.fill(0);
    }
}

/*
 * What a roster call's staged secrets keep across a reload: the keys its
 * parts are made of, bound to the roster they were made for (its digest). The
 * keys are kept as raw bytes after a header that names them, never as text:
 * strings cannot be zeroed.
 *   [u32 header length][header JSON][key bytes, in the header's order]
 */
type StagedRecord = {
    v: 2;
    outboxId: string;
    groupId: string;
    op: GroupStageOp['kind'] | 'create';
    rosterDigest: string;
    areaSeeds: Record<string, string>;
    /* Each key by name ('seed', 'successor', 'area:<workspaceId>', 'root:<workspaceId>') and length. */
    keys: [string, number][];
};
type Secrets = {
    /* Creation's group seed: what lets the first committed acceptance vouch for the first keys. */
    seed: Uint8Array | null;
    /* A succession's new seed. */
    successor: Uint8Array | null;
    areaKeys: Map<string, Uint8Array>;
    areaSeeds: Map<string, string>;
    rootKeys: Map<string, Uint8Array>;
};
function zeroSecrets(secrets: Secrets) {
    secrets.seed?.fill(0);
    secrets.successor?.fill(0);
    for (const key of secrets.areaKeys.values()) key.fill(0);
    for (const key of secrets.rootKeys.values()) key.fill(0);
    secrets.areaKeys.clear();
    secrets.rootKeys.clear();
}
async function sealStaged(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    record: Omit<StagedRecord, 'v' | 'keys' | 'areaSeeds'>,
    secrets: Secrets,
) {
    const parts: [string, Uint8Array][] = [];
    if (secrets.seed) parts.push(['seed', secrets.seed]);
    if (secrets.successor) parts.push(['successor', secrets.successor]);
    for (const [at, key] of secrets.areaKeys) parts.push([`area:${at}`, key]);
    for (const [at, key] of secrets.rootKeys) parts.push([`root:${at}`, key]);
    const header = new TextEncoder().encode(
        JSON.stringify({
            ...record,
            v: 2,
            areaSeeds: Object.fromEntries(secrets.areaSeeds),
            keys: parts.map(([name, key]) => [name, key.length]),
        } satisfies StagedRecord),
    );
    const total = parts.reduce((sum, [, key]) => sum + key.length, 0);
    const plaintext = new Uint8Array(4 + header.length + total);
    try {
        new DataView(plaintext.buffer).setUint32(0, header.length);
        plaintext.set(header, 4);
        let at = 4 + header.length;
        for (const [, key] of parts) {
            plaintext.set(key, at);
            at += key.length;
        }
        return await sealDeviceBytes(root, userId, record.groupId, 'staged', plaintext);
    } finally {
        plaintext.fill(0);
    }
}
async function openStaged(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    groupId: string,
    envelope: string,
): Promise<{ record: StagedRecord; secrets: Secrets }> {
    const refused = () => new CryptoError('This saved change is not one this device made.');
    const plaintext = await openDeviceBytes(root, userId, groupId, 'staged', envelope);
    const secrets: Secrets = {
        seed: null,
        successor: null,
        areaKeys: new Map(),
        areaSeeds: new Map(),
        rootKeys: new Map(),
    };
    try {
        if (plaintext.length < 4) throw refused();
        const length = new DataView(plaintext.buffer, plaintext.byteOffset).getUint32(0);
        if (4 + length > plaintext.length) throw refused();
        const record = JSON.parse(
            new TextDecoder().decode(plaintext.subarray(4, 4 + length)),
        ) as StagedRecord;
        if (
            typeof record !== 'object' ||
            record === null ||
            record.v !== 2 ||
            record.groupId !== groupId ||
            typeof record.outboxId !== 'string' ||
            typeof record.rosterDigest !== 'string' ||
            !Array.isArray(record.keys)
        )
            throw refused();
        let at = 4 + length;
        for (const [name, size] of record.keys) {
            if (
                typeof name !== 'string' ||
                !Number.isSafeInteger(size) ||
                at + size > plaintext.length
            )
                throw refused();
            const key = plaintext.slice(at, at + size);
            at += size;
            const [kind, workspaceId] = name.split(':') as [string, string | undefined];
            if (kind === 'seed' && size === 64) secrets.seed = key;
            else if (kind === 'successor' && size === 64) secrets.successor = key;
            else if (kind === 'area' && size === 32)
                secrets.areaKeys.set(uuid(workspaceId, 'workspace id'), key);
            else if (kind === 'root' && size === 32)
                secrets.rootKeys.set(uuid(workspaceId, 'workspace id'), key);
            else {
                key.fill(0);
                throw refused();
            }
        }
        if (at !== plaintext.length) throw refused();
        for (const [workspaceId, seed] of Object.entries(record.areaSeeds ?? {}))
            secrets.areaSeeds.set(uuid(workspaceId, 'workspace id'), String(seed));
        return { record, secrets };
    } catch (error) {
        zeroSecrets(secrets);
        throw error instanceof CryptoError ? error : refused();
    } finally {
        plaintext.fill(0);
    }
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

function wire(signed: SignedGroupStatement): SignedStatementWire {
    return {
        statement: encode(signed.statement),
        signature: {
            ed25519: encode(signed.signature.ed25519),
            mlDsa: encode(signed.signature.mlDsa),
        },
        signerSignature: encode(signed.signerSignature),
    };
}
function unwire(value: SignedStatementWire): SignedGroupStatement {
    try {
        return {
            statement: decode(value.statement),
            signature: {
                ed25519: decode(value.signature.ed25519),
                mlDsa: decode(value.signature.mlDsa),
            },
            signerSignature: decode(value.signerSignature),
        };
    } catch {
        throw new CryptoError('The server sent a member list this device cannot read.');
    }
}
function atRoster(chain: AcceptedRosters) {
    return { rosterVersion: chain.roster.rosterVersion, rosterDigest: chain.rosterDigest };
}
function zeroPair(pair: GroupKeyPair | null) {
    pair?.signingKey.fill(0);
    pair?.mlDsaSecretKey.fill(0);
}
function viewOf(chain: AcceptedRosters): GroupView {
    return {
        groupId: chain.groupId,
        kind: chain.kind,
        rosterVersion: chain.roster.rosterVersion,
        rosterDigest: chain.rosterDigest,
        groupKeyVersion: chain.groupKeyVersion,
        creatorUserId: chain.creatorUserId,
        members: chain.roster.members.map((member) => ({ ...member, roles: [...member.roles] })),
        areas: Object.fromEntries(
            Object.entries(chain.areaKeys).map(([workspaceId, list]) => [workspaceId, list.length]),
        ),
        successionDue: chain.successionDue,
        ownEntryWrongAt: [...chain.ownEntryWrongAt],
        ownEntryBehindAt: [...chain.ownEntryBehindAt],
        deadBranches: chain.deadBranches.map((branch) => ({ ...branch })),
    };
}
/* Whether an entry names exactly these keys: X25519, Ed25519 and the ML-DSA key by digest. */
async function entryNames(entry: RosterMember | undefined, keys: ServedKeys) {
    if (!entry) return false;
    return (
        entry.encryptionPublicKey === keys.encryptionPublicKey &&
        entry.signingPublicKey === keys.signingPublicKey &&
        entry.mlDsaPublicKeyDigest ===
            (await digest(decode(keys.mlDsaPublicKey, ML_DSA_PUBLIC_KEY_BYTES)))
    );
}
async function mlDsaKeysOf(identities: ServedKeys[]) {
    const out: Record<string, string> = {};
    for (const identity of identities)
        out[await digest(decode(identity.mlDsaPublicKey, ML_DSA_PUBLIC_KEY_BYTES))] =
            identity.mlDsaPublicKey;
    return out;
}
function folderMetadata(name: string): NodeMetadata {
    return { name, mime: null, size: null, modified: null };
}

/*
 * The empty document of each kind a rotation may have to stand in for one it
 * cannot open (docs/groups-server.md 8): the kinds shipped clients write
 * (DOCUMENT_KINDS in @hushos/drive/protocol), each as its reader takes "none"
 * (emptyRegistry in @hushos/drive/tags).
 */
const EMPTY_DOCUMENTS: Record<string, () => unknown> = {
    tags: () => ({ version: 2, tags: [], items: {} }),
};

/*
 * A workspace document as a rotation carries it on: opened under the key
 * being replaced, or, when it does not open there (bytes a member wrote that
 * are no document of its kind), an empty document of its kind. Nobody could
 * read the junk before either, and aborting would let one member's bytes
 * block every removal of the folder. A kind with no empty form is refused.
 */
async function openOrReplace(
    document: RotatedDocumentWire,
    key: Uint8Array,
    workspaceId: string,
): Promise<{ value: unknown; replaced: boolean }> {
    try {
        return {
            value: await openDocument(decode(document.envelope), key, {
                workspaceId,
                kind: document.kind,
                version: document.version,
            }),
            replaced: false,
        };
    } catch (error) {
        const empty = Object.hasOwn(EMPTY_DOCUMENTS, document.kind)
            ? EMPTY_DOCUMENTS[document.kind]
            : undefined;
        if (!(error instanceof CryptoError) || !empty) throw error;
        return { value: empty(), replaced: true };
    }
}

const NO_CHAIN = 'Check the family’s member list first.';
const NO_SEED = 'Open the family’s key first.';
const NOT_OPENED = 'Open every family folder first.';
const KEYS_CHANGED = 'This folder’s keys changed. Reload to continue.';
const NOT_CHECKED_KEYS = 'Couldn’t check this folder’s keys. Reload to continue.';

/* ------------------------------------------------------------------------- */
/* The session                                                               */
/* ------------------------------------------------------------------------- */

/*
 * The roster at which `userId`'s entry last became active on a verified chain
 * (the roster that admitted them, or let them in again): the earliest version
 * of the run of active entries that reaches the head. Only served rosters
 * whose digest is the chain's at their version are read, so what the server
 * adds beside them changes nothing; one missing from the run is refused.
 * Null when the head has no active entry for them.
 */
export async function admittedAt(
    rosterDigests: readonly string[],
    served: readonly SignedStatementWire[],
    userId: string,
) {
    return runStart(await onChain(rosterDigests, served), rosterDigests.length, userId);
}

/* The served rosters whose digest is the chain's at their version, by version. */
async function onChain(rosterDigests: readonly string[], served: readonly SignedStatementWire[]) {
    const out = new Map<number, Roster>();
    for (const wire of served) {
        try {
            const statement = decode(wire.statement);
            const roster = parseRoster(statement);
            if (rosterDigests[roster.rosterVersion - 1] === (await rosterDigest(statement)))
                out.set(roster.rosterVersion, roster);
        } catch {
            // Not a roster of this chain: ignored, as acceptance ignores it.
        }
    }
    return out;
}

function runStart(rosters: Map<number, Roster>, head: number, userId: string) {
    const at = (version: number) => {
        const roster = rosters.get(version);
        if (!roster) throw new CryptoError('The server left out part of the family’s member list.');
        return activeWith(rosterEntry(roster, userId));
    };
    let version = head;
    if (version === 0 || !at(version)) return null;
    while (version > 1 && at(version - 1)) version--;
    return version;
}

/* Whether an entry names exactly the keys a contact pin holds (the lattice keys by digest). */
function entryIsPin(entry: RosterMember | undefined, pin: ContactPin) {
    return (
        entry !== undefined &&
        entry.encryptionPublicKey === pin.encryptionPublicKey &&
        entry.signingPublicKey === pin.signingPublicKey &&
        sameKeyDigest(pin.mlDsaPublicKeyHash, entry.mlDsaPublicKeyDigest) &&
        sameKeyDigest(pin.kemPublicKeyHash, entry.kemPublicKeyDigest)
    );
}

/*
 * The join code of the roster at `version` on a verified chain, under the group key it is under.
 * Both screens' code comes from here; acceptance works its own out (group-trust.ts), and the two
 * must agree at every version (session-groups.join.test.ts).
 */
export async function codeAt(chain: AcceptedRosters, version: number) {
    if (!Number.isSafeInteger(version) || version < 1 || version > chain.rosterDigests.length)
        throw new CryptoError('This member list is not on the family’s history.');
    // The group key that roster is under: one above every succession tied to an earlier roster.
    let keyVersion = 1;
    for (const out of chain.cache.successions) if (out.lastRosterVersion < version) keyVersion++;
    return joinCode(
        chain.rosterDigests[version - 1]!,
        chain.groupKeys[keyVersion - 1]!,
        keyVersion,
    );
}

export function createGroupSession(host: GroupHost) {
    /* Committed chains, from what the server served only. */
    const chains = new Map<string, AcceptedRosters>();
    /* Groups whose last acceptance was a fork: roster verdicts are personal until it is sorted. */
    const forked = new Set<string>();
    /* Group seeds by `${groupId}:${groupKeyVersion}`. */
    const seeds = new Map<string, Uint8Array>();
    /* Staged chains and their secrets, by outbox id. */
    const staged = new Map<
        string,
        { groupId: string; op: StagedRecord['op']; chain: AcceptedRosters | null; secrets: Secrets }
    >();
    /* Areas opened on this device, per group: their id seed (areaOf passed) and the version opened. */
    const opened = new Map<string, Map<string, { idSeed: string; version: number }>>();
    /* Each area's write version, from the committed chain only (F9). */
    const areaWrite = new Map<string, number>();
    /*
     * Areas the last groupOpenArea found unwritable, and why: the server
     * behind or ahead of the chain, or no grant at the latest version.
     */
    const blocked = new Map<string, string>();
    /*
     * The area key version each area's root was last opened under, by a real
     * open of its envelope in a listing (rootSeen): the area is written only
     * while that is its write version. Nothing a caller says sets it.
     */
    const rootSeenAt = new Map<string, number>();
    /* The group pins in the settings this worker last opened or sealed: the only settings marks taken. */
    let settingsPins: {
        userId: string;
        pins: Record<string, GroupPin>;
        /* Whether they came from a settings document that opened, not from "none". */
        opened: boolean;
    } | null = null;
    /* The session's succession verification cache (groupWriterTrust's `verified`). */
    const verified = new Map<string, boolean>();

    const seedSlot = (groupId: string, version: number) => `${groupId}:${version}`;

    function committed(groupId: string) {
        const chain = chains.get(uuid(groupId, 'group id'));
        if (!chain) throw new CryptoError(NO_CHAIN);
        return chain;
    }
    function areasOf(groupId: string) {
        return opened.get(groupId) ?? new Map<string, { idSeed: string; version: number }>();
    }
    function isArea(workspaceId: string) {
        if (areaWrite.has(workspaceId) || blocked.has(workspaceId) || rootSeenAt.has(workspaceId))
            return true;
        for (const areas of opened.values()) if (areas.has(workspaceId)) return true;
        for (const chain of chains.values())
            if (Object.hasOwn(chain.areaKeys, workspaceId)) return true;
        return false;
    }
    /* The version a group area is read under (its write version), null for a workspace that is no group's area. */
    function readVersion(workspaceId: string): number | null {
        if (!isArea(workspaceId)) return null;
        const version = areaWrite.get(workspaceId);
        if (version === undefined) throw new CryptoError(NOT_CHECKED_KEYS);
        return version;
    }
    /* The version a group area is written under, null for a workspace that is no group's area. */
    function writeVersion(workspaceId: string): number | null {
        if (!isArea(workspaceId)) return null;
        if (blocked.has(workspaceId)) throw new CryptoError(KEYS_CHANGED);
        const version = readVersion(workspaceId)!;
        // Only once a root wrapped under this very version was opened here.
        if (rootSeenAt.get(workspaceId) !== version) throw new CryptoError(KEYS_CHANGED);
        return version;
    }
    /* Why an area may not be written, or null. */
    function unwritable(workspaceId: string, latest: number) {
        const reason = blocked.get(workspaceId) as GroupResults['groupOpenArea']['reason'];
        if (reason) return reason;
        const seen = rootSeenAt.get(workspaceId);
        return seen === latest ? null : seen === undefined ? 'root-unknown' : 'root-behind';
    }
    /*
     * Refuses any write into a group area the worker has not found writable:
     * blocked, not checked against a committed chain, or without the key at
     * the write version (F9). Every Drive write in the session calls it.
     */
    function requireWritable(workspaceId: string) {
        const version = writeVersion(workspaceId);
        if (version !== null && !host.workspaceKey(workspaceId, version))
            throw new CryptoError(KEYS_CHANGED);
    }
    /*
     * An area root a listing has just opened, its envelope opened under the
     * area key at `parentKeyEpoch` (never a cached key the row only claims):
     * the area is writable only while that is its write version.
     */
    function rootSeen(workspaceId: string, parentKeyEpoch: number) {
        if (!isArea(workspaceId)) return;
        rootSeenAt.set(workspaceId, parentKeyEpoch);
    }
    /*
     * Within one unlock, settings that opened never give way to none (or to a
     * version 1 document, which opens as none): a server answering so would
     * drop the family pins, and with them the marks that keep a family from
     * being joined again onto another history (decision D7). The client keeps
     * the same rule across unlocks (its settings document mark).
     */
    function useSettings(userId: string, settings: { groups?: Record<string, GroupPin> } | null) {
        if (settings === null) refuseDowngrade(userId);
        settingsPins = { userId, pins: { ...settings?.groups }, opened: settings !== null };
    }
    function refuseDowngrade(userId: string) {
        if (settingsPins?.userId === userId && settingsPins.opened)
            throw new CryptoError(
                'The server sent older settings than this device has opened, so nothing was changed.',
            );
    }
    /*
     * A version 1 document: it opens nowhere, and is not "no settings" either
     * (the account has something stored), so it gives acceptance no marks at
     * all, and after settings that opened it is a rollback.
     */
    function legacySettings(userId: string) {
        refuseDowngrade(userId);
    }
    function commit(chain: AcceptedRosters) {
        chains.set(chain.groupId, chain);
        forked.delete(chain.groupId);
        // A new write version needs its root seen again (rootSeenAt no longer matches it).
        for (const workspaceId of Object.keys(chain.areaKeys))
            areaWrite.set(workspaceId, areaWriteVersion(chain, workspaceId)!);
        // Seeds of keys the group has replaced sign nothing any more.
        for (const [at, seed] of seeds) {
            const [groupId, version] = at.split(':');
            if (groupId === chain.groupId && Number(version) < chain.groupKeyVersion) {
                seed.fill(0);
                seeds.delete(at);
            }
        }
        // Staged calls built on another head can never land: their secrets go.
        for (const [outboxId, entry] of staged)
            if (
                entry.groupId === chain.groupId &&
                entry.chain &&
                entry.chain.roster.previousRosterDigest !== chain.rosterDigest
            )
                dropStaged(outboxId);
    }
    /* A refusal or a fork: nothing in the group is vouched for by its roster, and its areas are not written. */
    function uncommit(groupId: string, fork: boolean) {
        const chain = chains.get(groupId);
        for (const workspaceId of [
            ...Object.keys(chain?.areaKeys ?? {}),
            ...areasOf(groupId).keys(),
        ])
            areaWrite.delete(workspaceId);
        chains.delete(groupId);
        if (fork) forked.add(groupId);
        else forked.delete(groupId);
    }
    function readingOf(groupId: string): GroupReading {
        const chain = chains.get(groupId);
        if (chain) return { status: 'accepted', chain };
        return forked.has(groupId) ? { status: 'fork' } : { status: 'unavailable' };
    }
    function dropStaged(outboxId: string) {
        const entry = staged.get(outboxId);
        if (!entry) return false;
        zeroSecrets(entry.secrets);
        staged.delete(outboxId);
        return true;
    }
    function forgetGroup(groupId: string) {
        for (const [slot, seed] of seeds)
            if (slot.startsWith(`${groupId}:`)) {
                seed.fill(0);
                seeds.delete(slot);
            }
        for (const [outboxId, entry] of staged) if (entry.groupId === groupId) dropStaged(outboxId);
        const areas = [
            ...Object.keys(chains.get(groupId)?.areaKeys ?? {}),
            ...areasOf(groupId).keys(),
        ];
        for (const workspaceId of areas) {
            host.dropWorkspace(workspaceId);
            areaWrite.delete(workspaceId);
            blocked.delete(workspaceId);
            rootSeenAt.delete(workspaceId);
        }
        opened.delete(groupId);
        chains.delete(groupId);
        forked.delete(groupId);
    }
    function forget() {
        for (const groupId of new Set([...chains.keys(), ...opened.keys()])) forgetGroup(groupId);
        for (const seed of seeds.values()) seed.fill(0);
        seeds.clear();
        for (const outboxId of staged.keys()) dropStaged(outboxId);
        for (const workspaceId of areaWrite.keys()) host.dropWorkspace(workspaceId);
        chains.clear();
        forked.clear();
        opened.clear();
        areaWrite.clear();
        blocked.clear();
        rootSeenAt.clear();
        verified.clear();
        settingsPins = null;
    }

    /* Every identity this account has had (version 2), as the open session proved them. */
    function ownIdentities() {
        const me = host.identity();
        return { me, identities: [me.served, ...me.history] as ServedKeys[] };
    }

    /*
     * The staged chain of a roster call: `signed` (and `succession`) accepted
     * on top of the committed chain's cache, never as a mark, and only if every
     * device holding the committed chain would take it.
     */
    async function stageChain(
        chain: AcceptedRosters,
        signed: SignedGroupStatement,
        succession: SignedGroupStatement | null,
    ) {
        const { me, identities } = ownIdentities();
        const accepted = await acceptRosters({
            groupId: chain.groupId,
            firstKeys: chain.groupKeys[0]!,
            firstKeysChecked: false,
            pins: [],
            rosters: [signed],
            successions: succession ? [succession] : [],
            mlDsaKeys: await mlDsaKeysOf(identities),
            me: { userId: me.userId, identities },
            cache: chain.cache,
        });
        if (accepted.status !== 'accepted')
            throw new CryptoError('This change does not follow the family’s member list.');
        if (accepted.roster.rosterVersion !== chain.roster.rosterVersion + 1)
            throw new CryptoError('This change does not follow the family’s member list.');
        if (succession && accepted.groupKeyVersion !== chain.groupKeyVersion + 1)
            throw new CryptoError('The family’s new key would not be taken.');
        if (accepted.successionDue)
            throw new CryptoError('The family’s key must be replaced in the same change.');
        return accepted;
    }

    /*
     * A record's group verdict (design 2.8): this account's own records by its
     * own keys, anyone else's as the roster says, personal keys where the
     * roster does not speak. A check that throws is `unchecked`.
     */
    function verdicts(
        groupId: string,
        workspaceId: string,
        reading: GroupReading,
        writers: GroupWriter[],
        trusted: Map<string, TrustedSigner>,
    ) {
        const me = host.identity().userId.toLowerCase();
        const byId = new Map(writers.map((writer) => [writer.userId.toLowerCase(), writer]));
        const areas = Object.fromEntries(
            [...areasOf(groupId)].map(([at, area]) => [at, area.version]),
        );
        const trust = new Map<string, Promise<GroupWriterTrust | null>>();
        const trustOf = (userId: string) => {
            let held = trust.get(userId);
            if (!held) {
                const writer = byId.get(userId);
                held = groupWriterTrust({
                    groupId,
                    areas,
                    reading,
                    workspaceId,
                    writerUserId: userId,
                    pinned: writer?.pinned ?? null,
                    served: writer?.served ?? null,
                    links: writer?.links ?? null,
                    verified,
                }).catch(() => null);
                trust.set(userId, held);
            }
            return held;
        };
        /* Whose keys a re-keyed record's signer is judged under: their roster trust, or this account's own. */
        const rekeyedTrustOf = async (
            userId: string | null,
        ): Promise<{ trust: GroupWriterTrust; personal: TrustedSigner | null }> => {
            const id = userId?.toLowerCase() ?? null;
            if (!id) return { trust: { trust: 'outside' }, personal: null };
            if (id === me)
                return { trust: { trust: 'outside' }, personal: trusted.get(id) ?? null };
            return {
                trust: (await trustOf(id)) ?? { trust: 'unchecked' },
                personal: trusted.get(id) ?? null,
            };
        };
        /*
         * A re-keyed record's verdicts (design 2.8): its origin's, as its writer's
         * trust says, and the re-keyer's, as theirs does. `nodeKey` is the node's
         * key at the record's epoch, null when not held (unchecked).
         */
        const rekeyed = async (
            record: RekeyedRecord,
            nodeKey: Uint8Array | null,
            rekeyer: string | null,
        ) => {
            try {
                const origin = await rekeyedTrustOf(record.origin.signerId);
                const by = await rekeyedTrustOf(rekeyer);
                return await groupRekeyedIntegrityOf(record, nodeKey, {
                    origin: origin.trust,
                    originPersonal: origin.personal,
                    rekeyer: by.trust,
                    rekeyerPersonal: by.personal,
                });
            } catch {
                return {
                    origin: { integrity: 'unchecked' as const, via: null },
                    rekeyer: { integrity: 'unchecked' as const, via: null },
                    bound: null,
                };
            }
        };
        const check = async (
            statements: () => Promise<StatementForms>,
            signer: string | null,
            signature: string | null,
        ): Promise<{ integrity: GroupIntegrity; via: string | null }> => {
            let bytes: Uint8Array | null = null;
            if (signature)
                try {
                    bytes = decode(signature);
                } catch {
                    bytes = new Uint8Array(0);
                }
            // No signature is unsigned before any trust is looked up: a lookup that fails (and
            // reads unchecked) must not hide a stripped one.
            if (!bytes) return { integrity: 'unsigned', via: null };
            try {
                const id = signer?.toLowerCase() ?? null;
                if (!id || id === me)
                    return {
                        integrity: await integrityOf(
                            statements,
                            bytes,
                            id ? trusted.get(id) : null,
                        ),
                        via: null,
                    };
                const writerTrust = await trustOf(id);
                if (!writerTrust) return { integrity: 'unchecked', via: null };
                return await groupIntegrityOf(
                    statements,
                    bytes,
                    writerTrust,
                    trusted.get(id) ?? null,
                );
            } catch {
                return { integrity: 'unchecked', via: null };
            }
        };
        return Object.assign(check, { rekeyed });
    }
    function personalOf(writers: GroupWriter[]) {
        const signers: DriveSigners = {};
        for (const writer of writers) if (writer.personal) signers[writer.userId] = writer.personal;
        return host.personalSigners(signers);
    }
    /*
     * How a copy in a group area signs a record: verified stays ordinary and
     * saved stays saved; a former member's record and a key conflict's are
     * re-sealed, as is anything else; an unchecked one is not copied at all
     * (resealForm refuses).
     */
    function judgeWith(verdict: ReturnType<typeof verdicts>): RecordJudge {
        return async (record) => {
            const { integrity } = record.rekeyed
                ? (
                      await verdict.rekeyed(
                          record.rekeyed.record,
                          record.rekeyed.nodeKey,
                          record.rekeyed.rekeyer,
                      )
                  ).origin
                : await verdict(record.statements, record.signer, record.signature);
            if (integrity === 'key-conflict' || integrity === 'former-member') return 'resealed';
            return resealForm(integrity as Integrity);
        };
    }
    /*
     * The reading a family folder's rotation or copy is judged on: the staged
     * chain of the roster call named, or the committed one; refused unless it
     * is this family's area, opened on this device, on that chain.
     */
    function areaReading(workspaceId: string, group: GroupRotationTrust) {
        const groupId = uuid(group.groupId, 'group id');
        let reading = readingOf(groupId);
        if (group.staged !== null) {
            const entry = staged.get(group.staged);
            if (!entry || entry.groupId !== groupId || !entry.chain)
                throw new CryptoError('This change is no longer staged on this device.');
            reading = { status: 'accepted', chain: entry.chain };
        }
        // Only the group whose area this is judges it: an area opened on this device, on its chain.
        if (
            reading.status !== 'accepted' ||
            !Object.hasOwn(reading.chain.areaKeys, workspaceId) ||
            !areasOf(groupId).has(workspaceId)
        )
            throw new CryptoError('This folder is not one of this family’s.');
        return { groupId, reading };
    }
    /*
     * A Drive walk of a family folder: every record with a writer's signature
     * is kept re-keyed and nothing is re-signed as the walker's, so no record
     * is judged at all (one nobody can check no longer stops a removal), and
     * a departing member's records keep their name whoever walks them.
     */
    async function rotationJudge(
        workspaceId: string,
        group: GroupRotationTrust,
    ): Promise<RecordJudge> {
        areaReading(workspaceId, group);
        return rekeyOnly;
    }
    /* A copy out of a family folder's record, judged as its member list says. */
    async function copyJudge(
        workspaceId: string,
        group: GroupRotationTrust,
        trusted: Map<string, TrustedSigner>,
    ): Promise<RecordJudge> {
        const { groupId, reading } = areaReading(workspaceId, group);
        return judgeWith(verdicts(groupId, workspaceId, reading, group.writers, trusted));
    }

    /*
     * The roster's signer. Acceptance checks a roster's signer signature
     * against the signer's entry on the roster before it, so a member whose
     * entry still names an earlier identity signs the roster that folds in
     * their current one with that earlier identity's keys (plan finding 4):
     * opened here from its envelope only for that roster, only when the old
     * entry names exactly that identity and the new one names the open one,
     * and zeroed once it has signed. Every other roster is signed with the
     * open identity, which the old entry must name.
     */
    async function signerFor(
        chain: AcceptedRosters,
        next: { members: RosterMember[] },
        op: GroupStageOp,
    ): Promise<{ keys: HybridSigningKey; mlDsaPublicKey: string; zero: () => void }> {
        const me = host.identity();
        const before = rosterEntry(chain.roster, me.userId);
        if (await entryNames(before, me.served))
            return {
                keys: host.hybridKeys(),
                mlDsaPublicKey: me.served.mlDsaPublicKey,
                zero: () => {},
            };
        const after = next.members.find((member) => member.userId === me.userId);
        if (op.kind !== 'foldIn' || !(await entryNames(after, me.served)))
            throw new CryptoError(
                'Your entry on the family’s member list is not your current keys. Fold in your new keys first.',
            );
        for (const envelope of op.history ?? []) {
            if (envelope.version !== 2) continue;
            const served = publicIdentity(envelope);
            if (!(await entryNames(before, served))) continue;
            const { userId, root } = host.unlocked();
            let signingKey: Uint8Array | null = null;
            let mlDsa: { secretKey: Uint8Array } | null = null;
            try {
                // Each opens under this account's root and derives the public key the envelope names.
                signingKey = await openIdentitySigningKey(root, userId, envelope);
                mlDsa = await openIdentityMlDsaKey(root, userId, envelope);
            } catch (error) {
                signingKey?.fill(0);
                throw error;
            } finally {
                root.fill(0);
            }
            if (!mlDsa) {
                signingKey.fill(0);
                continue;
            }
            const keys = { signingKey, mlDsaSecretKey: mlDsa.secretKey };
            return {
                keys,
                mlDsaPublicKey: served.mlDsaPublicKey,
                zero: () => {
                    keys.signingKey.fill(0);
                    keys.mlDsaSecretKey.fill(0);
                },
            };
        }
        throw new CryptoError('Your earlier keys are needed to sign this. Unlock again and retry.');
    }

    /*
     * An area's rotation riding on a roster call: the root re-keyed at the
     * target epoch under the new area key (never through the session's own
     * caches: the call may still be refused), the root's old key wrapped again
     * under the new area key (option A), and both opened again with the new
     * area key before anything is returned, or nothing is sent.
     */
    async function rotationOf(
        groupId: string,
        rotation: AreaRotationInput,
        fromVersion: number,
        areaKey: Uint8Array,
        rootKey: Uint8Array,
        judge: RecordJudge,
        selfGrant: WorkspaceKeyEnvelope,
        /* Where documents that did not open, and went on empty, are reported. */
        replaced: ReplacedDocument[],
    ): Promise<RotationWire> {
        const { workspaceId, targetEpoch, root } = rotation;
        const toVersion = fromVersion + 1;
        if (root.parentId !== workspaceId || root.parentKeyEpoch !== toVersion)
            throw new CryptoError('This is not the root of the family folder being rotated.');
        if (!Number.isSafeInteger(targetEpoch) || targetEpoch <= root.keyEpoch)
            throw new CryptoError('Draw a new key epoch for this folder first.');
        if (!areasOf(groupId).has(workspaceId)) throw new CryptoError(NOT_OPENED);
        // The area's documents, opened under the key being replaced (and only that one) and sealed
        // for their next version under the new key: they move with the roster, never after it.
        const fromKey = host.workspaceKey(workspaceId, fromVersion);
        if (!fromKey) throw new CryptoError(NOT_OPENED);
        const documents: RotatedDocumentWire[] = [];
        const kinds = new Set<string>();
        for (const document of rotation.documents) {
            if (kinds.has(document.kind))
                throw new CryptoError('A folder’s document is sealed again only once.');
            kinds.add(document.kind);
            const { value, replaced: empty } = await openOrReplace(document, fromKey, workspaceId);
            if (empty) replaced.push({ workspaceId, kind: document.kind });
            documents.push({
                kind: document.kind,
                version: document.version,
                envelope: encode(
                    await sealDocument(value, areaKey, {
                        workspaceId,
                        kind: document.kind,
                        version: document.version + 1,
                    }),
                ),
            });
        }
        const old = await host.currentKeyOf(workspaceId, root);
        try {
            const rekeyed = await host.rekeyNode({
                workspaceId,
                targetEpoch,
                granterUserId: host.identity().userId,
                node: root,
                judge,
                old,
                fresh: rootKey,
                parentKey: areaKey,
            });
            const current = {
                workspaceId,
                nodeId: root.id,
                parentId: workspaceId,
                parentKeyEpoch: toVersion,
                keyEpoch: targetEpoch,
            };
            const previous = { ...current, keyEpoch: root.keyEpoch };
            const previousRootKeyEnvelope = await wrapPreviousRootKey(old, areaKey, previous);
            // The groups-server.md 8 requirement: a member holding only the new area key must open both.
            const opensNew = await openNodeKey(decode(rekeyed.keyEnvelope, 72), areaKey, current);
            const opensOld = await openPreviousRootKey(previousRootKeyEnvelope, areaKey, previous);
            const ok = sameBytes(opensNew, rootKey) && sameBytes(opensOld, old);
            opensNew.fill(0);
            opensOld.fill(0);
            if (!ok)
                throw new CryptoError(
                    'The family folder’s new keys didn’t open, so nothing was sent.',
                );
            const sealed = rekeyed.links.filter(
                (link): link is { id: string; linkEnvelope: string; secretEnvelope: string } =>
                    !('unsealable' in link),
            );
            return {
                workspaceId,
                fromVersion,
                toVersion,
                targetEpoch,
                root: {
                    id: root.id,
                    changeSeq: root.changeSeq,
                    parentKeyEpoch: toVersion,
                    keyEnvelope: rekeyed.keyEnvelope,
                    rotated: {
                        metadataEnvelope: rekeyed.metadataEnvelope,
                        metadataSignature: rekeyed.metadataSignature,
                        metadataRekey: rekeyed.metadataRekey ?? null,
                        ...(rekeyed.metadataDropOrigin ? { metadataDropOrigin: true } : {}),
                        versions: rekeyed.versions,
                        shares: rekeyed.shares,
                        links: sealed,
                        unsealableLinks: rekeyed.links
                            .filter((link) => 'unsealable' in link)
                            .map((link) => link.id),
                    },
                },
                previousRootKeyEnvelope: encode(previousRootKeyEnvelope),
                selfGrant,
                documents,
            };
        } finally {
            old.fill(0);
        }
    }

    /* A new area's root folder: key epoch 1 under the area key at version 1, signed by its creator. */
    async function newRoot(
        workspaceId: string,
        areaKey: Uint8Array,
        rootKey: Uint8Array,
        name: string,
        signer: HybridSigningKey,
    ): Promise<AreaRootWire> {
        const node = await newId('node', workspaceId);
        const keyEnvelope = await wrapNodeKey(rootKey, areaKey, {
            workspaceId,
            nodeId: node.id,
            parentId: workspaceId,
            parentKeyEpoch: 1,
            keyEpoch: 1,
        });
        const metadataEnvelope = await sealMetadata(folderMetadata(name), rootKey, {
            workspaceId,
            nodeId: node.id,
            metadataVersion: 1,
        });
        const signature = await signStatement(
            await metadataStatementAs(
                'ordinary',
                { workspaceId, nodeId: node.id, kind: 'folder', metadataVersion: 1 },
                metadataEnvelope,
            ),
            signer.signingKey,
        );
        return {
            id: node.id,
            idSeed: node.seed,
            keyEpoch: 1,
            parentKeyEpoch: 1,
            keyEnvelope: encode(keyEnvelope),
            metadataEnvelope: encode(metadataEnvelope),
            metadataSignature: encode(signature),
        };
    }

    async function selfGrantOf(
        groupId: string,
        workspaceId: string,
        key: Uint8Array,
        version: number,
    ) {
        const { userId, root, keyVersion } = host.unlocked();
        try {
            return await grantAreaKey(key, root, userId, groupId, workspaceId, keyVersion, version);
        } finally {
            root.fill(0);
        }
    }

    /* ------------------------------------------------------------------- */
    /* The operations                                                      */
    /* ------------------------------------------------------------------- */

    async function create(
        input: GroupRequests['groupCreate'],
    ): Promise<GroupResults['groupCreate']> {
        const { userId, root, keyVersion } = host.unlocked();
        const secrets: Secrets = {
            seed: null,
            successor: null,
            areaKeys: new Map(),
            areaSeeds: new Map(),
            rootKeys: new Map(),
        };
        let pair: GroupKeyPair | null = null;
        let kept = false;
        try {
            if (input.userId !== userId) throw new CryptoError('Unlock your account first.');
            const me = host.identity();
            if (me.userId !== userId) throw new CryptoError('Open your identity first.');
            if (
                typeof input.name !== 'string' ||
                input.name.trim().length === 0 ||
                input.name.length > 100
            )
                throw new CryptoError('Give the family a name of at most 100 characters.');
            // The account's identities as just fetched, each proven to open under this account.
            const fresh: ServedKeys[] = [];
            for (const envelope of [...input.identities.history, input.identities.identity]) {
                await verifyOwnIdentity(root, userId, envelope);
                if (envelope.version === 2) fresh.push(publicIdentity(envelope));
            }
            const seed = newGroupSeed();
            secrets.seed = seed;
            pair = await groupKeyPair(seed);
            const group = await newId('group', userId);
            const area = await newId('workspace', group.id);
            const areaKey = generateKey();
            const rootKey = generateKey();
            secrets.areaKeys.set(area.id, areaKey);
            secrets.areaSeeds.set(area.id, area.seed);
            secrets.rootKeys.set(area.id, rootKey);
            const entry = await ownRosterEntry(userId, me.served, {
                roles: ['billing', 'members'],
            });
            const roster = await firstRoster(group.id, entry, {
                kind: 'family',
                areaKeys: [{ workspaceId: area.id, workspaceKey: areaKey }],
            });
            const signer = host.hybridKeys();
            const signed = await signRoster(roster, pair, signer);
            // Staged: the keys this worker just made are the ones it vouches for, and only them.
            const chain = await acceptRosters({
                groupId: group.id,
                firstKeys: pair.publicKey,
                firstKeysChecked: true,
                pins: [],
                rosters: [signed],
                successions: [],
                mlDsaKeys: await mlDsaKeysOf([me.served]),
                me: { userId, identities: fresh },
                cache: null,
            });
            if (chain.status !== 'accepted')
                throw new CryptoError('This family’s first member list would not be taken.');
            // Design 3.1: never found a family on an identity the account has replaced.
            if (chain.ownEntryWrongAt.length > 0 || chain.ownEntryBehindAt.length > 0)
                throw new CryptoError(
                    'Your keys changed on another device. Unlock again, then create the family.',
                );
            const kem = decode(me.served.kemPublicKey);
            const keySeal = await sealGroupKey(
                seed,
                {
                    groupId: group.id,
                    groupKeyVersion: 1,
                    holderUserId: userId,
                    holderKeyVersion: me.served.keyVersion,
                    sealerUserId: userId,
                    ...atRoster(chain),
                },
                { chain, holderKemPublicKey: kem, sealer: signer },
            );
            const grant = await sealAreaGrant(
                areaKey,
                {
                    groupId: group.id,
                    workspaceId: area.id,
                    workspaceKeyVersion: 1,
                    granteeUserId: userId,
                    granteeKeyVersion: me.served.keyVersion,
                    granterUserId: userId,
                    ...atRoster(chain),
                },
                { chain, areaIdSeed: area.seed, granteeKemPublicKey: kem, granter: signer },
            );
            const rootWire = await newRoot(
                area.id,
                areaKey,
                rootKey,
                input.areaName ?? 'Family',
                signer,
            );
            const selfGrant = await grantAreaKey(
                areaKey,
                root,
                userId,
                group.id,
                area.id,
                keyVersion,
                1,
            );
            const outboxId = crypto.randomUUID();
            const stagedEnvelope = await sealStaged(
                root,
                userId,
                { outboxId, groupId: group.id, op: 'create', rosterDigest: chain.rosterDigest },
                secrets,
            );
            staged.set(outboxId, { groupId: group.id, op: 'create', chain, secrets });
            kept = true;
            return {
                outboxId,
                groupId: group.id,
                stagedEnvelope,
                body: {
                    id: group.id,
                    idSeed: group.seed,
                    kind: 'family',
                    name: input.name,
                    groupKey: { ...pair.publicKey },
                    roster: wire(signed),
                    keySeal: { envelope: encode(keySeal) },
                    area: {
                        workspaceId: area.id,
                        idSeed: area.seed,
                        root: rootWire,
                        grant: { envelope: encode(grant) },
                        selfGrant,
                    },
                },
            };
        } finally {
            root.fill(0);
            zeroPair(pair);
            if (!kept) zeroSecrets(secrets);
        }
    }

    /*
     * This person's marks for a group: the settings pin (from settings this
     * worker opened) and this device's record, opened. `marks` also counts what
     * this session holds, a committed chain or a fork. `null`: the record did
     * not open (sealed under an earlier account root).
     */
    async function marksOf(input: { userId: string; groupId: string; record: string | null }) {
        const groupId = uuid(input.groupId, 'group id');
        const { userId, root } = host.unlocked();
        try {
            if (input.userId !== userId) throw new CryptoError('Unlock your account first.');
            let record: { cache: GroupChainCache | null; pin: GroupPin | null } | null = null;
            if (input.record) {
                let value: { v?: number; cache?: GroupChainCache; pin?: GroupPin } | null;
                try {
                    value = (await openDeviceRecord(
                        root,
                        userId,
                        groupId,
                        'chains',
                        input.record,
                    )) as typeof value;
                } catch (error) {
                    // Sealed under an earlier account root: the caller starts over without it.
                    if (error instanceof CryptoError) return null;
                    throw error;
                }
                if (value?.v !== 1) return null;
                record = { cache: value.cache ?? null, pin: value.pin ?? null };
            }
            if (!settingsPins || settingsPins.userId !== userId)
                throw new CryptoError('Open your settings first.');
            const settingsPin = Object.hasOwn(settingsPins.pins, groupId)
                ? settingsPins.pins[groupId]!
                : null;
            const pins = [settingsPin, record?.pin ?? null].filter(
                (pin): pin is GroupPin => pin !== null && pin !== undefined,
            );
            // Marks include what this session already holds: a committed chain, or a fork.
            const marks =
                pins.length > 0 ||
                (record?.cache ?? null) !== null ||
                chains.has(groupId) ||
                forked.has(groupId);
            return { groupId, userId, pins, cache: record?.cache ?? null, marks };
        } finally {
            root.fill(0);
        }
    }

    async function accept(
        input: GroupRequests['groupAccept'],
    ): Promise<GroupResults['groupAccept']> {
        if (input.joining && input.creating)
            throw new CryptoError('A family is either joined or created, not both.');
        // Joining always carries the join code the person compared: there is no joining without
        // it, so nothing accepts, views or keeps a chain over first keys nobody checked.
        if (input.joining && !input.joining.joinMark)
            throw new CryptoError('Compare the join code first.');
        const marked = await marksOf(input);
        if (!marked) return { status: 'record-unreadable' };
        const { groupId, userId, pins, cache, marks } = marked;
        let firstKeysChecked = false;
        // Creation vouches for the first keys only where nothing marks the family (F1).
        if (input.creating && marks)
            throw new CryptoError('This device has already checked this family.');
        // Joining vouches for them only where nothing does either, through its join mark, which the
        // chain must pass through (a made-up history gives another code). With marks (a rejoin
        // after a not-member wipe, which keeps the settings pin) the marks decide the first keys
        // and the history, and the join mark only adds to them.
        if (input.joining && !marks) firstKeysChecked = true;
        if (input.creating) {
            const { root } = host.unlocked();
            try {
                const { secrets } = await openStaged(
                    root,
                    userId,
                    groupId,
                    input.creating.stagedEnvelope,
                );
                try {
                    if (!secrets.seed)
                        throw new CryptoError('This saved change did not create the family.');
                    const pair = await groupKeyPair(secrets.seed);
                    zeroPair(pair);
                    // Only the keys this device made: served first keys that are not the seed's are refused.
                    if (!sameGroupKey(pair.publicKey, input.served.firstKeys))
                        throw new CryptoError('These are not the family keys this device made.');
                    firstKeysChecked = true;
                } finally {
                    zeroSecrets(secrets);
                }
            } finally {
                root.fill(0);
            }
        }
        const { me, identities } = ownIdentities();
        if (me.userId !== userId) throw new CryptoError('Open your identity first.');
        // Served digests: a roster this device staged that the server now serves landed.
        const served = new Set(
            await Promise.all(
                input.served.rosters.map(async (roster) => {
                    try {
                        return await rosterDigest(decode(roster.statement));
                    } catch {
                        return '';
                    }
                }),
            ),
        );
        let chain;
        try {
            chain = await acceptRosters({
                groupId,
                firstKeys: input.served.firstKeys,
                firstKeysChecked,
                pins,
                rosters: input.served.rosters.map(unwire),
                successions: input.served.successions.map(unwire),
                mlDsaKeys: { ...input.served.signerKeys },
                me: { userId, identities },
                cache,
                joinMark: input.joining?.joinMark ?? null,
            });
        } catch (error) {
            // A refusal on a forked group keeps the fork: it is still the person's own marks' conflict.
            uncommit(groupId, forked.has(groupId));
            throw error;
        }
        if (chain.status === 'fork') {
            uncommit(groupId, true);
            return { status: 'fork', fork: chain };
        }
        // Staged calls whose roster the server served and this acceptance took: they landed (another
        // tab sent them, or a resend this tab never heard back from), and go with their secrets.
        // Only after acceptance held, so junk served beside them, or under them, drops nothing.
        const dropped: string[] = [];
        for (const [outboxId, entry] of staged)
            if (
                entry.groupId === groupId &&
                entry.chain &&
                served.has(entry.chain.rosterDigest) &&
                chain.rosterDigests.includes(entry.chain.rosterDigest)
            )
                dropped.push(outboxId);
        for (const outboxId of dropped) dropStaged(outboxId);
        commit(chain);
        const pin = await pinAfter(pins, chain, input.checkedAt);
        const unlocked = host.unlocked();
        try {
            return {
                status: 'accepted',
                view: viewOf(chain),
                record: await sealDeviceRecord(unlocked.root, userId, groupId, 'chains', {
                    v: 1,
                    cache: chain.cache,
                    pin,
                }),
                pin,
                dropped,
            };
        } finally {
            unlocked.root.fill(0);
        }
    }

    /*
     * The newcomer's join code, over what route 5 serves (groupJoinPreview):
     * verified as acceptance would verify it, then nothing done with it. No
     * commit, no uncommit, no fork set, no staged call dropped, no record or
     * pin: the chain is dropped here, and the code is all that leaves.
     */
    async function joinPreview(
        input: GroupRequests['groupJoinPreview'],
    ): Promise<GroupResults['groupJoinPreview']> {
        const marked = await marksOf(input);
        if (!marked) return { status: 'record-unreadable' };
        const { groupId, userId, pins, cache, marks } = marked;
        const { me, identities } = ownIdentities();
        if (me.userId !== userId) throw new CryptoError('Open your identity first.');
        const chain = await acceptRosters({
            groupId,
            firstKeys: input.served.firstKeys,
            // With no mark, over the served first keys, for the code only: the person compares it
            // with the admin's next, and only the acceptance that carries it vouches for anything.
            firstKeysChecked: !marks,
            pins,
            rosters: input.served.rosters.map(unwire),
            successions: input.served.successions.map(unwire),
            mlDsaKeys: { ...input.served.signerKeys },
            me: { userId, identities },
            cache,
        });
        if (chain.status === 'fork') return { status: 'fork', fork: chain };
        const version = await admittedAt(chain.rosterDigests, input.served.rosters, userId);
        if (version === null) return { status: 'not-admitted' };
        return { status: 'code', rosterVersion: version, code: await codeAt(chain, version) };
    }

    async function openSeal(
        input: GroupRequests['groupOpenSeal'],
    ): Promise<GroupResults['groupOpenSeal']> {
        const chain = committed(input.groupId);
        const me = host.identity();
        const { seal } = input;
        const seed = await openGroupKey(
            decode(seal.envelope, GROUP_KEY_SEAL_BYTES),
            {
                groupId: chain.groupId,
                groupKeyVersion: seal.groupKeyVersion,
                holderUserId: me.userId,
                holderKeyVersion: seal.holderKeyVersion,
                sealerUserId: seal.sealerUserId,
                rosterVersion: seal.rosterVersion,
                rosterDigest: seal.rosterDigest,
            },
            {
                chain,
                sealerMlDsaPublicKey: decode(input.sealerMlDsaPublicKey, ML_DSA_PUBLIC_KEY_BYTES),
                sealerHistory: input.sealerHistory ?? null,
                reader: { userId: me.userId, keyVersion: seal.holderKeyVersion },
                holder: host.granteeSecrets(seal.holderKeyVersion),
            },
        );
        // A replaced key's seed signs nothing any more: it is not kept.
        if (seal.groupKeyVersion < chain.groupKeyVersion) {
            seed.fill(0);
            return { groupKeyVersion: seal.groupKeyVersion };
        }
        const slot = seedSlot(chain.groupId, seal.groupKeyVersion);
        seeds.get(slot)?.fill(0);
        seeds.set(slot, seed);
        return { groupKeyVersion: seal.groupKeyVersion };
    }

    async function openArea(
        input: GroupRequests['groupOpenArea'],
    ): Promise<GroupResults['groupOpenArea']> {
        const chain = committed(input.groupId);
        const groupId = chain.groupId;
        const workspaceId = uuid(input.workspaceId, 'workspace id');
        try {
            await checkId('workspace', groupId, input.idSeed, workspaceId);
        } catch {
            throw new CryptoError('This folder does not belong to the family.');
        }
        const latest = areaWriteVersion(chain, workspaceId);
        if (latest === null)
            throw new CryptoError('This folder is not on the family’s member list.');
        const listed = chain.areaKeys[workspaceId]!;
        const served = input.servedVersion;
        const { userId, root, keyVersion } = host.unlocked();
        let key: Uint8Array | null = null;
        let version = 0;
        let fromGrant = false;
        try {
            // The self-grant only at the latest version both the chain and the server name.
            const self = input.selfGrant;
            if (
                self &&
                self.workspaceId === workspaceId &&
                self.workspaceKeyVersion >= latest &&
                self.workspaceKeyVersion >= served &&
                self.workspaceKeyVersion <= listed.length
            )
                try {
                    const opened = await openAreaSelfGrant(root, userId, groupId, self);
                    if (
                        (await areaKeyCommitment(opened)) === listed[self.workspaceKeyVersion - 1]
                    ) {
                        key = opened;
                        version = self.workspaceKeyVersion;
                    } else opened.fill(0);
                } catch {
                    // Ignored: the area grant decides.
                }
            if (!key && input.grant) {
                const grant = input.grant;
                if (!input.granterMlDsaPublicKey)
                    throw new CryptoError('This grant needs the key of the person who made it.');
                key = await openAreaGrant(
                    decode(grant.envelope, AREA_GRANT_BYTES),
                    {
                        groupId,
                        workspaceId,
                        workspaceKeyVersion: grant.workspaceKeyVersion,
                        granteeUserId: userId,
                        granteeKeyVersion: grant.granteeKeyVersion,
                        granterUserId: grant.granterUserId,
                        rosterVersion: grant.rosterVersion,
                        rosterDigest: grant.rosterDigest,
                    },
                    {
                        chain,
                        areaIdSeed: input.idSeed,
                        granterMlDsaPublicKey: decode(
                            input.granterMlDsaPublicKey,
                            ML_DSA_PUBLIC_KEY_BYTES,
                        ),
                        granterHistory: input.granterHistory ?? null,
                        reader: { userId, keyVersion: grant.granteeKeyVersion },
                        grantee: host.granteeSecrets(grant.granteeKeyVersion),
                    },
                );
                version = grant.workspaceKeyVersion;
                fromGrant = true;
            }
            if (!key) throw new CryptoError(NOT_CHECKED_KEYS);
            const reason: GroupResults['groupOpenArea']['reason'] =
                version < latest
                    ? 'no-grant-at-latest'
                    : served < latest
                      ? 'server-behind'
                      : served > latest
                        ? 'server-ahead'
                        : null;
            // The server takes a self-grant only at the area's current version.
            const selfGrantToStore =
                fromGrant && version === latest && served === latest
                    ? await grantAreaKey(
                          key,
                          root,
                          userId,
                          groupId,
                          workspaceId,
                          keyVersion,
                          version,
                      )
                    : null;
            host.holdWorkspaceKey(workspaceId, version, key as Uint8Array<ArrayBuffer>);
            key = null;
            const areas = opened.get(groupId) ?? new Map();
            const before = areas.get(workspaceId);
            areas.set(workspaceId, {
                idSeed: input.idSeed,
                version: Math.max(before?.version ?? 0, version),
            });
            opened.set(groupId, areas);
            if (reason) blocked.set(workspaceId, reason);
            else blocked.delete(workspaceId);
            // The root is the listing's to decide (rootSeen): until one is opened at the latest
            // version, the area reads 'root-unknown' (or 'root-behind') and is not written.
            const held = unwritable(workspaceId, latest);
            return {
                version,
                writable: held === null,
                reason: held,
                selfGrantToStore,
                pinArea: { workspaceId, version },
            };
        } finally {
            root.fill(0);
            key?.fill(0);
        }
    }

    /* The KEM key a seal or grant goes to: this account's own, or the one route 6 served (checked against the entry when sealed). */
    function kemFor(userId: string, kems: Record<string, string>) {
        const me = host.identity();
        const value = userId === me.userId ? me.served.kemPublicKey : kems[userId];
        if (!value) throw new CryptoError('HushOS couldn’t load everyone’s keys. Try again.');
        return decode(value);
    }

    async function grantTo(
        chain: AcceptedRosters,
        workspaceId: string,
        version: number,
        key: Uint8Array,
        idSeed: string,
        member: RosterMember,
        kems: Record<string, string>,
    ): Promise<GrantWire> {
        const me = host.identity();
        const ctx = {
            groupId: chain.groupId,
            workspaceId,
            workspaceKeyVersion: version,
            granteeUserId: member.userId,
            granteeKeyVersion: member.keyVersion,
            granterUserId: me.userId,
            ...atRoster(chain),
        };
        const envelope = await sealAreaGrant(key, ctx, {
            chain,
            areaIdSeed: idSeed,
            granteeKemPublicKey: kemFor(member.userId, kems),
            granter: host.hybridKeys(),
        });
        return {
            workspaceId,
            workspaceKeyVersion: version,
            granteeUserId: member.userId,
            granteeKeyVersion: member.keyVersion,
            rosterVersion: ctx.rosterVersion,
            rosterDigest: ctx.rosterDigest,
            envelope: encode(envelope),
        };
    }
    async function sealTo(
        chain: AcceptedRosters,
        seed: Uint8Array,
        groupKeyVersion: number,
        holder: RosterMember,
        kems: Record<string, string>,
    ): Promise<SealWire> {
        const me = host.identity();
        const ctx = {
            groupId: chain.groupId,
            groupKeyVersion,
            holderUserId: holder.userId,
            holderKeyVersion: holder.keyVersion,
            sealerUserId: me.userId,
            ...atRoster(chain),
        };
        const envelope = await sealGroupKey(seed, ctx, {
            chain,
            holderKemPublicKey: kemFor(holder.userId, kems),
            sealer: host.hybridKeys(),
        });
        return {
            groupKeyVersion,
            holderUserId: holder.userId,
            holderKeyVersion: holder.keyVersion,
            rosterVersion: ctx.rosterVersion,
            rosterDigest: ctx.rosterDigest,
            envelope: encode(envelope),
        };
    }
    /* An area this device opened, at the version it is written under, with its key and id seed. */
    function currentArea(chain: AcceptedRosters, workspaceId: string) {
        const area = areasOf(chain.groupId).get(workspaceId);
        const version = areaWriteVersion(chain, workspaceId);
        const key = version === null ? undefined : host.workspaceKey(workspaceId, version);
        if (!area || version === null || !key) throw new CryptoError(NOT_OPENED);
        return { version, key, idSeed: area.idSeed };
    }

    async function stage(input: GroupRequests['groupStage']): Promise<GroupResults['groupStage']> {
        const chain = committed(input.groupId);
        const groupId = chain.groupId;
        const { op } = input;
        // A newcomer's and a folded-in member's ML-KEM keys are the ones their entry is made from.
        const kems: Record<string, string> = { ...input.kems };
        if (op.kind === 'admit') kems[op.userId] = op.served.kemPublicKey;
        if (op.kind === 'foldIn')
            for (const member of op.members) kems[member.userId] = member.served.kemPublicKey;
        const me = host.identity();
        const next = chain.roster.rosterVersion + 1;
        const seed = seeds.get(seedSlot(groupId, chain.groupKeyVersion));
        if (!seed) throw new CryptoError(NO_SEED);
        let members = chain.roster.members.map((member) => ({
            ...member,
            roles: [...member.roles],
        }));
        const entryOf = (userId: string) => members.find((member) => member.userId === userId);
        const put = (entry: RosterMember) => {
            members = [...members.filter((member) => member.userId !== entry.userId), entry];
        };
        const active = (userId: string) => {
            const entry = entryOf(userId);
            if (!activeWith(entry)) throw new CryptoError('This person is not in the family now.');
            return entry!;
        };
        let rotations: AreaRotationInput[] = [];
        let newArea: { workspaceId: string; idSeed: string; name: string } | null = null;
        const needsCheck: string[] = [];
        const folded: string[] = [];
        switch (op.kind) {
            case 'admit': {
                if (activeWith(entryOf(op.userId)))
                    throw new CryptoError('This person is in the family already.');
                const entry = await newRosterEntry(op.pin, op.served, {
                    roles: op.roles,
                    rosterVersion: next,
                });
                if (entry.userId !== op.userId)
                    throw new CryptoError('These are not the keys whose words were checked.');
                put(entry);
                break;
            }
            case 'remove':
                put({ ...active(op.userId), status: 'left' });
                rotations = op.rotations;
                break;
            case 'markLeft':
                if (op.userIds.length === 0)
                    throw new CryptoError('No one is due to be marked as left.');
                for (const userId of op.userIds) put({ ...active(userId), status: 'left' });
                rotations = op.rotations;
                break;
            case 'roles':
                put({ ...active(op.userId), roles: [...op.roles] });
                break;
            case 'foldIn':
                for (const member of op.members) {
                    const result = await foldInEntry(
                        active(member.userId),
                        member.served,
                        member.links,
                        next,
                    );
                    if (result.changed) {
                        put(result.entry);
                        folded.push(member.userId);
                    } else if (result.needsCheck) needsCheck.push(member.userId);
                }
                if (folded.length === 0) return { outboxId: null, needsCheck };
                break;
            case 'area': {
                const area = await newId('workspace', groupId);
                newArea = { workspaceId: area.id, idSeed: area.seed, name: op.name };
                break;
            }
            case 'rotate':
                rotations = [op.rotation];
                break;
        }
        // A family's removal rotates every area, and only what is named is rotated.
        const toRotate =
            op.kind === 'rotate' ? [op.rotation.workspaceId] : areasToRotate(chain, members);
        const named = rotations.map((rotation) => rotation.workspaceId).sort();
        if (named.join() !== [...toRotate].sort().join() || new Set(named).size !== named.length)
            throw new CryptoError('Every family folder must get new keys in this change.');
        for (const workspaceId of toRotate)
            if (areaWriteVersion(chain, workspaceId) === null)
                throw new CryptoError('This folder is not on the family’s member list.');

        const secrets: Secrets = {
            seed: null,
            successor: null,
            areaKeys: new Map(),
            areaSeeds: new Map(),
            rootKeys: new Map(),
        };
        let pair: GroupKeyPair | null = null;
        let successorPair: GroupKeyPair | null = null;
        let signer: Awaited<ReturnType<typeof signerFor>> | null = null;
        let kept = false;
        try {
            for (const workspaceId of toRotate) {
                secrets.areaKeys.set(workspaceId, generateKey());
                secrets.rootKeys.set(workspaceId, generateKey());
            }
            if (newArea) {
                secrets.areaKeys.set(newArea.workspaceId, generateKey());
                secrets.areaSeeds.set(newArea.workspaceId, newArea.idSeed);
                secrets.rootKeys.set(newArea.workspaceId, generateKey());
            }
            const roster = await nextRoster(chain, members, {
                signerUserId: me.userId,
                areaKeys: [...secrets.areaKeys].map(([workspaceId, workspaceKey]) => ({
                    workspaceId,
                    workspaceKey,
                })),
            });
            signer = await signerFor(chain, roster, op);
            pair = await groupKeyPair(seed);
            const signed = await signRoster(roster, pair, signer.keys);
            signer.zero();
            // A roster that takes a holder away is the last under its key: the succession rides with it.
            const drops = chain.roster.members.some(
                (entry) =>
                    activeWith(entry, 'members') &&
                    !activeWith(rosterEntry(roster, entry.userId), 'members'),
            );
            let succession: SignedGroupStatement | null = null;
            if (drops) {
                secrets.successor = newGroupSeed();
                successorPair = await groupKeyPair(secrets.successor);
                succession = await signGroupSuccession(
                    {
                        groupId,
                        oldVersion: chain.groupKeyVersion,
                        newVersion: chain.groupKeyVersion + 1,
                        oldEd25519PublicKey: pair.publicKey.ed25519PublicKey,
                        oldMlDsaPublicKey: pair.publicKey.mlDsaPublicKey,
                        newEd25519PublicKey: successorPair.publicKey.ed25519PublicKey,
                        newMlDsaPublicKey: successorPair.publicKey.mlDsaPublicKey,
                        lastRosterVersion: next,
                        lastRosterDigest: await rosterDigest(signed.statement),
                        signerUserId: me.userId,
                    },
                    pair,
                    host.hybridKeys(),
                );
            }
            const stagedChain = await stageChain(chain, signed, succession);
            const parts = await partsOf({
                chain,
                stagedChain,
                op,
                secrets,
                seed,
                kems,
                rotations,
                newArea,
                folded,
                writers: input.writers ?? [],
            });
            const body: RosterCallBody = {
                expectedRevision: input.expectedRevision,
                roster: wire(signed),
                ...(succession ? { succession: wire(succession) } : {}),
                ...parts.body,
            };
            const outboxId = crypto.randomUUID();
            const { userId, root } = host.unlocked();
            let stagedEnvelope: string;
            try {
                stagedEnvelope = await sealStaged(
                    root,
                    userId,
                    { outboxId, groupId, op: op.kind, rosterDigest: stagedChain.rosterDigest },
                    secrets,
                );
            } finally {
                root.fill(0);
            }
            staged.set(outboxId, { groupId, op: op.kind, chain: stagedChain, secrets });
            kept = true;
            return {
                outboxId,
                body,
                stagedEnvelope,
                joinCode:
                    op.kind === 'admit'
                        ? {
                              rosterVersion: next,
                              code: await joinCode(
                                  stagedChain.rosterDigest,
                                  stagedChain.groupKey,
                                  stagedChain.groupKeyVersion,
                              ),
                          }
                        : null,
                needsCheck,
                replaced: parts.replaced,
            };
        } finally {
            signer?.zero();
            zeroPair(pair);
            zeroPair(successorPair);
            if (!kept) zeroSecrets(secrets);
        }
    }

    /*
     * The seals, grants, rotations, new area and self-grants a roster call
     * carries, made against its staged chain: grants of each new key to every
     * member active on it (the uploader included), an admission's grants of
     * every area's current key, a fold-in's grants to the members' new keys,
     * a new holder's seal, a succession's seals to every remaining holder.
     */
    async function partsOf(input: {
        chain: AcceptedRosters;
        stagedChain: AcceptedRosters;
        op: GroupStageOp;
        secrets: Secrets;
        seed: Uint8Array;
        kems: Record<string, string>;
        rotations: AreaRotationInput[];
        newArea: { workspaceId: string; idSeed: string; name: string } | null;
        folded: string[];
        writers: GroupWriter[];
    }) {
        const { chain, stagedChain, op, secrets, kems } = input;
        const after = stagedChain.roster;
        const activeAfter = after.members.filter((member) => activeWith(member));
        const body: Omit<RosterCallBody, 'expectedRevision' | 'roster' | 'succession'> = {};
        const grants: GrantWire[] = [];
        // Seals: a succession's new seed to every holder on the new roster, else a new holder's seal.
        if (secrets.successor) {
            body.seals = [];
            for (const holder of after.members.filter((member) => activeWith(member, 'members')))
                body.seals.push(
                    await sealTo(
                        stagedChain,
                        secrets.successor,
                        stagedChain.groupKeyVersion,
                        holder,
                        kems,
                    ),
                );
        } else {
            const promoted = after.members.filter(
                (member) =>
                    activeWith(member, 'members') &&
                    !activeWith(rosterEntry(chain.roster, member.userId), 'members'),
            );
            if (promoted.length > 1) throw new CryptoError('Give one person the role at a time.');
            if (promoted[0])
                body.keySeal = await sealTo(
                    stagedChain,
                    input.seed,
                    stagedChain.groupKeyVersion,
                    promoted[0],
                    kems,
                );
        }
        // Grants of every area's current key to a newcomer, or to members' folded-in keys.
        const receivers =
            op.kind === 'admit' ? [op.userId] : op.kind === 'foldIn' ? input.folded : [];
        for (const userId of receivers) {
            const member = rosterEntry(after, userId)!;
            for (const workspaceId of Object.keys(chain.areaKeys).sort()) {
                if (secrets.areaKeys.has(workspaceId)) continue;
                const area = currentArea(chain, workspaceId);
                grants.push(
                    await grantTo(
                        stagedChain,
                        workspaceId,
                        area.version,
                        area.key,
                        area.idSeed,
                        member,
                        kems,
                    ),
                );
            }
        }
        // Each new key to every active member.
        for (const [workspaceId, key] of secrets.areaKeys) {
            const version = stagedChain.areaKeys[workspaceId]!.length;
            const idSeed =
                secrets.areaSeeds.get(workspaceId) ??
                areasOf(chain.groupId).get(workspaceId)?.idSeed;
            if (!idSeed) throw new CryptoError(NOT_OPENED);
            for (const member of activeAfter)
                grants.push(
                    await grantTo(stagedChain, workspaceId, version, key, idSeed, member, kems),
                );
        }
        // Rotations keep every writer's record (re-keyed): nobody's record is judged, or re-signed.
        const rotations: RotationWire[] = [];
        const replaced: ReplacedDocument[] = [];
        for (const rotation of input.rotations) {
            const workspaceId = rotation.workspaceId;
            const key = secrets.areaKeys.get(workspaceId)!;
            const version = stagedChain.areaKeys[workspaceId]!.length;
            rotations.push(
                await rotationOf(
                    chain.groupId,
                    rotation,
                    version - 1,
                    key,
                    secrets.rootKeys.get(workspaceId)!,
                    rekeyOnly,
                    await selfGrantOf(chain.groupId, workspaceId, key, version),
                    replaced,
                ),
            );
        }
        if (op.kind === 'rotate') body.rotation = rotations[0];
        else if (rotations.length > 0) body.rotations = rotations;
        if (input.newArea) {
            const { workspaceId, idSeed, name } = input.newArea;
            const key = secrets.areaKeys.get(workspaceId)!;
            body.area = {
                workspaceId,
                idSeed,
                root: await newRoot(
                    workspaceId,
                    key,
                    secrets.rootKeys.get(workspaceId)!,
                    name,
                    host.hybridKeys(),
                ),
                selfGrant: await selfGrantOf(chain.groupId, workspaceId, key, 1),
            };
        }
        if (grants.length > 0) body.grants = grants;
        return { body, replaced };
    }
    async function restage(
        input: GroupRequests['groupRestage'],
    ): Promise<GroupResults['groupRestage']> {
        const chain = committed(input.groupId);
        const groupId = chain.groupId;
        const { userId, root } = host.unlocked();
        let opened: { record: StagedRecord; secrets: Secrets };
        try {
            opened = await openStaged(root, userId, groupId, input.stagedEnvelope);
        } finally {
            root.fill(0);
        }
        const { record, secrets } = opened;
        let kept = false;
        try {
            const signed = unwire(input.body.roster);
            // Bound to the very roster these secrets were made for, whatever the call changes.
            if ((await rosterDigest(signed.statement)) !== record.rosterDigest)
                throw new CryptoError('This saved change does not match its member list.');
            const succession = input.body.succession ? unwire(input.body.succession) : null;
            const stagedChain = await stageChain(chain, signed, succession);
            // The body's roster must be the one these secrets were made for: its rows are their keys.
            for (const [workspaceId, key] of secrets.areaKeys)
                if (stagedChain.areaKeys[workspaceId]?.at(-1) !== (await areaKeyCommitment(key)))
                    throw new CryptoError('This saved change does not match its member list.');
            const rows = stagedChain.roster.areas ?? [];
            if (rows.length !== secrets.areaKeys.size)
                throw new CryptoError('This saved change does not match its member list.');
            if (secrets.successor) {
                const pair = await groupKeyPair(secrets.successor);
                zeroPair(pair);
                if (!sameGroupKey(pair.publicKey, stagedChain.groupKey))
                    throw new CryptoError('This saved change does not match its member list.');
            }
            let body = input.body;
            const replaced: ReplacedDocument[] = [];
            if (input.rebuild) {
                const rebuilt = new Map<string, RotationWire>();
                for (const rotation of input.rebuild.rotations) {
                    const workspaceId = rotation.workspaceId;
                    const key = secrets.areaKeys.get(workspaceId);
                    const rootKey = secrets.rootKeys.get(workspaceId);
                    const existing = [
                        ...(body.rotations ?? []),
                        ...(body.rotation ? [body.rotation] : []),
                    ].find((at) => at.workspaceId === workspaceId);
                    if (!key || !rootKey || !existing)
                        throw new CryptoError('This change does not rotate that folder.');
                    const version = stagedChain.areaKeys[workspaceId]!.length;
                    rebuilt.set(
                        workspaceId,
                        await rotationOf(
                            groupId,
                            rotation,
                            version - 1,
                            key,
                            rootKey,
                            rekeyOnly,
                            existing.selfGrant,
                            replaced,
                        ),
                    );
                }
                const swap = (at: RotationWire) => rebuilt.get(at.workspaceId) ?? at;
                body = {
                    ...body,
                    ...(body.rotations ? { rotations: body.rotations.map(swap) } : {}),
                    ...(body.rotation ? { rotation: swap(body.rotation) } : {}),
                };
            }
            dropStaged(record.outboxId);
            staged.set(record.outboxId, { groupId, op: record.op, chain: stagedChain, secrets });
            kept = true;
            return {
                outboxId: record.outboxId,
                body,
                stagedEnvelope: input.stagedEnvelope,
                replaced,
            };
        } finally {
            if (!kept) zeroSecrets(secrets);
        }
    }

    async function grantsOwed(
        input: GroupRequests['groupGrants'],
    ): Promise<GroupResults['groupGrants']> {
        const chain = committed(input.groupId);
        const kems = Object.fromEntries(input.missing.map((at) => [at.userId, at.kemPublicKey]));
        const grants: GrantWire[] = [];
        for (const at of input.missing) {
            const member = rosterEntry(chain.roster, at.userId);
            if (!activeWith(member))
                throw new CryptoError('Areas are granted only to active members.');
            const area = currentArea(chain, at.workspaceId);
            grants.push(
                await grantTo(
                    chain,
                    at.workspaceId,
                    area.version,
                    area.key,
                    area.idSeed,
                    member!,
                    kems,
                ),
            );
        }
        return { grants };
    }

    async function reseal(
        input: GroupRequests['groupReseal'],
    ): Promise<GroupResults['groupReseal']> {
        const chain = committed(input.groupId);
        const seed = seeds.get(seedSlot(chain.groupId, chain.groupKeyVersion));
        if (!seed) throw new CryptoError(NO_SEED);
        const kems = Object.fromEntries(input.holders.map((at) => [at.userId, at.kemPublicKey]));
        const seals: SealWire[] = [];
        for (const holder of input.holders) {
            const entry = rosterEntry(chain.roster, holder.userId);
            if (!activeWith(entry, 'members'))
                throw new CryptoError('The group key is sealed only to members who hold it.');
            seals.push(await sealTo(chain, seed, chain.groupKeyVersion, entry!, kems));
        }
        return { seals };
    }

    async function verify(
        input: GroupRequests['groupVerify'],
    ): Promise<GroupResults['groupVerify']> {
        const groupId = uuid(input.groupId, 'group id');
        const { workspaceId } = input;
        const verdict = verdicts(
            groupId,
            workspaceId,
            readingOf(groupId),
            input.writers,
            personalOf(input.writers),
        );
        const nodes: GroupResults['groupVerify']['nodes'] = [];
        for (const node of input.nodes) {
            const key =
                node.keyEpoch === undefined
                    ? null
                    : host.nodeKeyAt(workspaceId, node.id, node.keyEpoch);
            const metadataStatement = {
                workspaceId,
                nodeId: node.id,
                kind: node.kind,
                metadataVersion: node.metadataVersion,
            };
            let metadata: { integrity: GroupIntegrity; via: string | null };
            let metadataRekey: GroupRekeyCheck | null = null;
            if (node.metadataRekey) {
                const checked = await verdict.rekeyed(
                    servedRekeyedRecord(
                        'metadata',
                        metadataStatement,
                        node.keyEpoch ?? 0,
                        node.metadataEnvelope,
                        node.metadataRekey,
                    ),
                    key,
                    node.metadataSigner,
                );
                metadata = checked.origin;
                metadataRekey = rekeyCheckOf(checked);
            } else
                metadata = await verdict(
                    async () =>
                        metadataStatements(metadataStatement, decode(node.metadataEnvelope)),
                    node.metadataSigner,
                    node.metadataSignature,
                );
            const versions: GroupResults['groupVerify']['nodes'][number]['versions'] = [];
            for (const version of node.versions ?? []) {
                const statement = {
                    workspaceId,
                    nodeId: node.id,
                    versionId: version.id,
                    objectId: version.objectId,
                    contentSuite: version.contentSuite,
                };
                if (version.rekey) {
                    const checked = await verdict.rekeyed(
                        servedRekeyedRecord(
                            'version',
                            statement,
                            node.keyEpoch ?? 0,
                            version.contentKeyEnvelope,
                            version.rekey,
                        ),
                        key,
                        version.signer,
                    );
                    versions.push({
                        id: version.id,
                        ...checked.origin,
                        rekey: rekeyCheckOf(checked),
                    });
                    continue;
                }
                const result = await verdict(
                    async () => versionStatements(statement, decode(version.contentKeyEnvelope)),
                    version.signer,
                    version.signature,
                );
                versions.push({ id: version.id, ...result });
            }
            nodes.push({
                id: node.id,
                metadata: metadata.integrity,
                via: metadata.via,
                ...(metadataRekey ? { metadataRekey } : {}),
                versions,
            });
        }
        return { nodes };
    }

    async function joinCodeOf(
        input: GroupRequests['groupJoinCode'],
    ): Promise<GroupResults['groupJoinCode']> {
        const chain = committed(input.groupId);
        const rosters = await onChain(chain.rosterDigests, input.rosters);
        const version = runStart(rosters, chain.rosterDigests.length, input.userId);
        if (version === null)
            throw new CryptoError('This person is not in the family’s member list yet.');
        const entry = rosterEntry(rosters.get(version)!, input.userId);
        return {
            rosterVersion: version,
            code: await codeAt(chain, version),
            pinMatches: input.pin ? entryIsPin(entry, input.pin) : null,
        };
    }

    async function consent(
        input: GroupRequests['identityConsent'],
    ): Promise<GroupResults['identityConsent']> {
        const { userId, root } = host.unlocked();
        const opened: Uint8Array[] = [];
        try {
            const { old, next } = input;
            if (input.userId !== userId) throw new CryptoError('Unlock your account first.');
            if (old.version !== 2 || next.version !== 2 || next.keyVersion <= old.keyVersion)
                throw new CryptoError('Only a link between two upgraded identities takes consent.');
            // Every key the consent names, not only the two that sign: each private half opens
            // under this account and derives its public key, and each keys statement holds.
            await verifyOwnIdentity(root, userId, old);
            await verifyOwnIdentity(root, userId, next);
            // And the two are one step of this account's own history, as this session opened it.
            const { identities } = ownIdentities();
            const ordered = [...identities].sort((a, b) => a.keyVersion - b.keyVersion);
            const same = (a: ServedKeys, b: ServedKeys) =>
                a.keyVersion === b.keyVersion &&
                a.encryptionPublicKey === b.encryptionPublicKey &&
                a.signingPublicKey === b.signingPublicKey &&
                a.mlDsaPublicKey === b.mlDsaPublicKey &&
                a.kemPublicKey === b.kemPublicKey;
            const at = ordered.findIndex((identity) => same(identity, publicIdentity(old)));
            if (at < 0 || !ordered[at + 1] || !same(ordered[at + 1]!, publicIdentity(next)))
                throw new CryptoError(
                    'These are not two identities this device opened one after the other.',
                );
            const keysOf = async (envelope: IdentityEnvelope) => {
                const signingKey = await openIdentitySigningKey(root, userId, envelope);
                opened.push(signingKey);
                const mlDsa = await openIdentityMlDsaKey(root, userId, envelope);
                if (!mlDsa)
                    throw new CryptoError(
                        'Only a link between two upgraded identities takes consent.',
                    );
                opened.push(mlDsa.secretKey);
                return { signingKey, mlDsaSecretKey: mlDsa.secretKey };
            };
            const oldKeys = await keysOf(old);
            const nextKeys = await keysOf(next);
            const fields = {
                userId,
                oldKeyVersion: old.keyVersion,
                newKeyVersion: next.keyVersion,
                oldEncryptionPublicKey: old.encryptionPublicKey,
                oldSigningPublicKey: old.signingPublicKey,
                oldMlDsaPublicKey: old.mlDsa.publicKey,
                newEncryptionPublicKey: next.encryptionPublicKey,
                newSigningPublicKey: next.signingPublicKey,
                newMlDsaPublicKey: next.mlDsa.publicKey,
                newKemPublicKey: next.kem.publicKey,
            };
            const out = new Uint8Array(SUCCESSION_CONSENT_BYTES);
            out.set(await signHybrid(await successionConsentStatement(fields, 'old'), oldKeys));
            out.set(
                await signHybrid(await successionConsentStatement(fields, 'new'), nextKeys),
                HYBRID_SIGNATURE_BYTES,
            );
            return { consent: encode(out) };
        } finally {
            root.fill(0);
            for (const secret of opened) secret.fill(0);
        }
    }

    async function storeSeal(input: GroupRequests['groupStoreSeal']) {
        if (input.store !== 'outbox' && input.store !== 'joins')
            throw new CryptoError('This is not a family record this device keeps.');
        const { userId, root } = host.unlocked();
        try {
            if (input.userId !== userId) throw new CryptoError('Unlock your account first.');
            return {
                envelope: await sealDeviceRecord(
                    root,
                    userId,
                    input.groupId,
                    input.store,
                    input.value,
                ),
            };
        } finally {
            root.fill(0);
        }
    }
    async function storeOpen(input: GroupRequests['groupStoreOpen']) {
        if (input.store !== 'outbox' && input.store !== 'joins')
            throw new CryptoError('This is not a family record this device keeps.');
        const { userId, root } = host.unlocked();
        try {
            if (input.userId !== userId) throw new CryptoError('Unlock your account first.');
            try {
                return {
                    value: await openDeviceRecord(
                        root,
                        userId,
                        input.groupId,
                        input.store,
                        input.envelope,
                    ),
                };
            } catch (error) {
                // Sealed under an earlier account root, or not this group's or store's: never readable here.
                if (error instanceof CryptoError) return { unreadable: true as const };
                throw error;
            }
        } finally {
            root.fill(0);
        }
    }

    async function previousRoot(
        input: GroupRequests['groupPreviousRoot'],
    ): Promise<GroupResults['groupPreviousRoot']> {
        const chain = committed(input.groupId);
        const workspaceId = uuid(input.workspaceId, 'workspace id');
        const { root } = input;
        const area = currentArea(chain, workspaceId);
        if (
            !root.prevKeyEnvelope ||
            root.prevKeyEpoch === null ||
            root.prevParentKeyEpoch !== area.version ||
            root.parentKeyEpoch !== area.version
        )
            return { status: 'none' };
        const context = {
            workspaceId,
            nodeId: root.id,
            parentId: workspaceId,
            parentKeyEpoch: area.version,
            keyEpoch: root.prevKeyEpoch,
        };
        let served: Uint8Array | null = null;
        try {
            served = await openPreviousRootKey(decode(root.prevKeyEnvelope), area.key, context);
        } catch {
            // Not an envelope under this key: repaired below if this device can.
        }
        // The old key this device opened itself as the root's own, before the key change. An
        // envelope that opens to anything else is no better than one that does not open.
        const old = host.previousNodeKey(workspaceId, root.id, root.prevKeyEpoch);
        if (served && (!old || sameBytes(served, old))) {
            served.fill(0);
            old?.fill(0);
            return { status: 'opens' };
        }
        served?.fill(0);
        if (!old) return { status: 'cannot' };
        try {
            const envelope = await wrapPreviousRootKey(old, area.key, context);
            // As a rotation's own: refused unless the new key opens it to the key wrapped.
            const back = await openPreviousRootKey(envelope, area.key, context);
            const same = sameBytes(back, old);
            back.fill(0);
            if (!same)
                throw new CryptoError('The folder’s earlier key didn’t open, so nothing was sent.');
            return { status: 'repair', previousRootKeyEnvelope: encode(envelope) };
        } finally {
            old.fill(0);
        }
    }

    async function handle(message: GroupMessage): Promise<GroupResults[keyof GroupResults]> {
        switch (message.operation) {
            case 'groupCreate':
                return create(message.input);
            case 'groupWords':
                return { words: await groupWords(message.input.groupId, message.input.firstKeys) };
            case 'groupAccept':
                return accept(message.input);
            case 'groupJoinPreview':
                return joinPreview(message.input);
            case 'groupOpenSeal':
                return openSeal(message.input);
            case 'groupOpenArea':
                return openArea(message.input);
            case 'groupStage':
                return stage(message.input);
            case 'groupRestage':
                return restage(message.input);
            case 'groupDrop':
                return { dropped: dropStaged(message.input.outboxId) };
            case 'groupGrants':
                return grantsOwed(message.input);
            case 'groupReseal':
                return reseal(message.input);
            case 'groupVerify':
                return verify(message.input);
            case 'groupJoinCode':
                return joinCodeOf(message.input);
            case 'groupTrustAs': {
                const { groupId, userId, served, contact } = message.input;
                return { pin: await trustAsGroupDoes(committed(groupId), userId, served, contact) };
            }
            case 'identityConsent':
                return consent(message.input);
            case 'groupForget': {
                const groupId = uuid(message.input.groupId, 'group id');
                const known = chains.has(groupId) || opened.has(groupId) || forked.has(groupId);
                forgetGroup(groupId);
                return { forgotten: known };
            }
            case 'groupStoreSeal':
                return storeSeal(message.input);
            case 'groupStoreOpen':
                return storeOpen(message.input);
            case 'groupPreviousRoot':
                return previousRoot(message.input);
        }
    }

    return {
        handle,
        readVersion,
        writeVersion,
        requireWritable,
        rootSeen,
        useSettings,
        legacySettings,
        isArea,
        rotationJudge,
        copyJudge,
        forget,
    };
}
