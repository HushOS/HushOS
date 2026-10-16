import type { RotatedNodeWire } from '@hushos/drive/server';

/*
 * The group routes' wire shapes (docs/groups-server.md 4): what a client
 * sends and gets back. Byte strings are base64url without padding; ids are
 * lowercase UUIDs. A signed statement carries its bytes, the group
 * signature (Ed25519 and ML-DSA-65 halves) and the signer's own hybrid
 * identity signature.
 */

export type GroupRoleWire = 'billing' | 'guardian' | 'members';

export type SignedStatementWire = {
    statement: string;
    signature: { ed25519: string; mlDsa: string };
    signerSignature: string;
};

/* A seal of the group seed to a holder; the sealer is the uploader. */
export type SealWire = {
    groupKeyVersion: number;
    holderUserId: string;
    holderKeyVersion: number;
    rosterVersion: number;
    rosterDigest: string;
    envelope: string;
};

/* An area key sealed to a member; the granter is the uploader. */
export type GrantWire = {
    workspaceId: string;
    workspaceKeyVersion: number;
    granteeUserId: string;
    granteeKeyVersion: number;
    rosterVersion: number;
    rosterDigest: string;
    envelope: string;
};

/* The uploader's own wrap of an area key, as for a personal workspace. */
export type SelfGrantWire = {
    version: 1;
    workspaceId: string;
    keyVersion: number;
    workspaceKeyVersion: number;
    wrappingSalt: string;
    wrappingNonce: string;
    encryptedKey: string;
};

/* A new area's root folder: a node id derived from its seed in the area, at epoch 1 under key version 1. */
export type AreaRootWire = {
    id: string;
    idSeed: string;
    keyEpoch: number;
    parentKeyEpoch: number;
    keyEnvelope: string;
    metadataEnvelope: string;
    metadataSignature: string;
};

export type AreaWire = {
    workspaceId: string;
    idSeed: string;
    root: AreaRootWire;
    selfGrant: SelfGrantWire;
};

/*
 * An area's key rotation riding on a roster: the root re-keyed at
 * `targetEpoch` (drawn from the area's epochs first) under the new workspace
 * key, and the rotator's self-grant at the new version.
 *
 * `previousRootKeyEnvelope` is the root's old key wrapped again under the new
 * area key: a node key envelope (72 bytes) with the context `{ workspaceId,
 * nodeId: root, parentId: workspaceId, parentKeyEpoch: toVersion, keyEpoch:
 * the root's key epoch before the rotation }`. The server stores it as the
 * root's previous envelope, so anyone holding only the new area key still opens
 * the children the Drive walk has not re-keyed yet (docs/groups-server.md 8).
 */
export type RotationWire = {
    workspaceId: string;
    fromVersion: number;
    toVersion: number;
    targetEpoch: number;
    root: RotatedNodeWire;
    previousRootKeyEnvelope: string;
    selfGrant: SelfGrantWire;
};

export type CreateGroupBody = {
    id: string;
    idSeed: string;
    kind: 'family' | 'org';
    name: string;
    groupKey: { ed25519PublicKey: string; mlDsaPublicKey: string };
    roster: SignedStatementWire;
    keySeal: { envelope: string };
    area: AreaWire & { grant: { envelope: string } };
};

/* What every roster route takes beside its own fields. */
export type RosterCall = {
    expectedRevision: number;
    roster: SignedStatementWire;
    succession?: SignedStatementWire;
    seals?: SealWire[];
    grants?: GrantWire[];
    rotations?: RotationWire[];
};

export type Head = { version: number; digest: string; revision: number; groupKeyVersion: number };
