import { CryptoError } from './errors';
import {
    KEY_ENVELOPE_BYTES,
    LEGACY_CONTENT_SUITE,
    VERSION_ENVELOPE_BYTES,
    contentKeyContext,
    metadataContext,
    openMetadata,
    openVersion,
    originOpeningKey,
    rekeyEnvelope,
    sealMetadata,
    sealVersion,
    wrapNodeKey,
    wrapOriginKey,
} from './drive';
import { decode, encode } from './keys';
import { openLinkSecret, sealLinkKeyWith, sealLinkSecret } from './links';
import { KEM_PUBLIC_KEY_BYTES } from './pq';
import { rekeyedFor } from './rekeyed-scope';
import type { RecordJudge } from './session-groups';
import type { DriveVersionEnvelope } from './session';
import { sealShareKey } from './shares';
import {
    carryOrigin,
    metadataRekeyedStatement,
    metadataStatementAs,
    metadataStatements,
    signStatement,
    versionRekeyedStatement,
    versionStatementAs,
    versionStatements,
    type HybridSigningKey,
    type MetadataStatement,
    type NodeKind,
    type RecordOrigin,
    type RekeyedRecord,
    type SignatureForm,
    type VersionStatement,
} from './signatures';

/*
 * The record half of a Drive rotation (docs/integrity-design.md, "Re-keyed
 * records"): one node's key envelope, metadata, versions, shares and links
 * sealed again under the fresh key a walk made. Moved out of session.ts
 * unchanged so the Rust core has a twin to be held to
 * (crates/hushos-core/src/rotation_records.rs, which AreaLedger::rotate_node
 * runs): the shared fixtures rotate a node in each twin and read it with the
 * other's verdicts (area-ledger fixtures, `rotations`).
 *
 * Nothing here holds a key or talks to the server: the worker hands it the
 * node as the rotation work serves it, the old and fresh keys (area-ledger.ts,
 * rotateKey) and the open identity that signs.
 */

export type RotateNodeInput = {
    id: string;
    kind: NodeKind;
    parentId: string;
    /* The parent's key epoch to wrap the new key under: the target for a rotated parent, its own for the root's outside parent. */
    parentKeyEpoch: number;
    /* The node as it is now: its key's epoch and the parent epoch its envelope was wrapped under. */
    keyEpoch: number;
    wrappedParentKeyEpoch: number;
    keyEnvelope: string;
    metadataVersion: number;
    metadataEnvelope: string;
    /* Who signed the metadata envelope being replaced, and how, as the rotation work serves it. */
    metadataSigner: string | null;
    metadataSignature: string | null;
    /* The origin an earlier rotation kept of the metadata, which this one carries. */
    metadataRekey?: ServedRekey | null;
    /* Each version with who signed the envelope being replaced, and any origin kept. */
    versions: (DriveVersionEnvelope & {
        signer: string | null;
        signature: string | null;
        rekey?: ServedRekey | null;
    })[];
    shares: {
        id: string;
        granteeUserId: string;
        granteePublicKey: string;
        granteeKemPublicKey: string | null;
    }[];
    links: { id: string; hasPassword: boolean; secretEnvelope: string | null }[];
};
/*
 * A re-keyed record's origin as the server serves it (RekeyView in
 * @hushos/drive/api, the signer by id): the envelope its writer signed, that
 * writer and their signature, the key that opens it alone wrapped under the
 * node key at the node's epoch, and the re-keyer's signature.
 */
export type ServedRekey = {
    origin: { envelope: string; signerId: string | null; signature: string; keyEnvelope: string };
    signature: string;
};
/* A re-keyed record's part of a rotation: the origin's opening key under the new node key, and the rekeyed statement's signature. */
export type RekeyOut = { originKeyEnvelope: string; signature: string };
/*
 * How one record re-sealed by a rotation is signed (docs/integrity-design.md,
 * "Re-keyed records"): re-keyed, with or without the honest legacy signature
 * beside it; or, where there is no writer's record to keep, the legacy
 * signature alone, re-sealed; `dropOrigin` when it drops an origin that did
 * not bind or names nobody.
 */
export type RotatedRecord = {
    signature: string | null;
    rekey: RekeyOut | null;
    dropOrigin?: true;
};
export type RotatedNode =
    | {
          id: string;
          keyEnvelope: string;
          metadataEnvelope: string;
          /* The re-sealed metadata's legacy signature by this account; null when only rewrapped or not sent. */
          metadataSignature: string | null;
          metadataRekey?: RekeyOut | null;
          metadataDropOrigin?: true;
          /* Each re-sealed version and how this account signed it. */
          versions: ({ id: string; contentKeyEnvelope: string } & RotatedRecord)[];
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

/*
 * The open identity a rotation signs with, as the session holds it at each
 * signature: its user id, its Ed25519 secret key (libsodium's 64 bytes), and
 * its hybrid keys, which seal shares. Throws when no identity is open.
 */
export type RotationSigner = () => {
    userId: string;
    signingKey: Uint8Array;
    hybridKeys(): HybridSigningKey;
};

/* A statement signed by the rotation's identity, base64url. */
async function sign(signer: RotationSigner, statement: Uint8Array) {
    return encode(await signStatement(statement, signer().signingKey));
}
/* The statement of `form` (see SignatureForm) over a record, signed by the rotation's identity. */
async function signMetadata(
    signer: RotationSigner,
    ctx: MetadataStatement,
    envelope: Uint8Array,
    form: SignatureForm = 'ordinary',
) {
    return sign(signer, await metadataStatementAs(form, ctx, envelope));
}
async function signVersion(
    signer: RotationSigner,
    ctx: VersionStatement,
    envelope: Uint8Array,
    form: SignatureForm = 'ordinary',
) {
    return sign(signer, await versionStatementAs(form, ctx, envelope));
}

/*
 * Opens a version's envelope under an open node key: the content key, the
 * plaintext size (from the envelope under suite 2, from the row under suite 1)
 * and the trailer's length. The caller owns the key it gets back.
 */
export async function openVersionUnder(
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

type ResealInput = {
    record: RekeyedRecord['record'];
    statement: MetadataStatement | VersionStatement;
    aad: Uint8Array;
    envelope: Uint8Array;
    signer: string | null;
    signature: string | null;
    rekey: ServedRekey | null | undefined;
    keyEpoch: number;
    targetEpoch: number;
    old: Uint8Array;
    fresh: Uint8Array;
    judge: RecordJudge;
    /* The identity that signs what the rotation writes. */
    by: RotationSigner;
    /* Suite 1 versions only: the size the row carries, which the legacy path re-seals. */
    plaintextSize?: number | null;
};

/*
 * One record re-sealed the way rotations wrote it before re-keyed records,
 * where rekeyedFor does not reach (personal workspaces, until the shipped
 * apps read origins): the plaintext opened and sealed again under `fresh`,
 * and signed by this account in the form `judge` gives on the record as
 * served (ordinary for a verified record, re-sealed otherwise; an
 * unchecked one is not re-signed at all). No origin is kept or carried,
 * whatever the server serves.
 */
export async function legacyRecord(
    input: ResealInput,
): Promise<{ envelope: Uint8Array } & RotatedRecord> {
    const { record, statement, envelope, old, fresh, by } = input;
    const form =
        (await input.judge({
            statements: async () =>
                record === 'metadata'
                    ? metadataStatements(statement as MetadataStatement, envelope)
                    : versionStatements(statement as VersionStatement, envelope),
            signer: input.signer,
            signature: input.signature,
        })) ?? 'resealed';
    if (record === 'metadata') {
        const m = statement as MetadataStatement;
        const ctx = {
            workspaceId: m.workspaceId,
            nodeId: m.nodeId,
            metadataVersion: m.metadataVersion,
        };
        const next = await sealMetadata(await openMetadata(envelope, old, ctx), fresh, ctx);
        return { envelope: next, signature: await signMetadata(by, m, next, form), rekey: null };
    }
    const v = statement as VersionStatement;
    const opened = await openVersionUnder(old, v.workspaceId, v.nodeId, {
        id: v.versionId,
        objectId: v.objectId,
        contentKeyEnvelope: encode(envelope),
        contentSuite: v.contentSuite,
        plaintextSize: input.plaintextSize ?? null,
    });
    try {
        // The same record, sealed under the fresh key in the object's own suite.
        const next = await sealVersion(
            {
                contentKey: opened.contentKey,
                plaintextSize: opened.plaintextSize,
                thumbnailBytes: opened.thumbnailBytes,
            },
            fresh,
            {
                workspaceId: v.workspaceId,
                nodeId: v.nodeId,
                versionId: v.versionId,
                objectId: v.objectId,
                suite: opened.suite,
            },
        );
        return {
            envelope: next,
            signature: await signVersion(by, { ...v, contentSuite: opened.suite }, next, form),
            rekey: null,
        };
    } finally {
        opened.contentKey.fill(0);
    }
}

/*
 * One record re-sealed by a rotation and how it is signed
 * (docs/integrity-design.md, "Re-keyed records"). The new envelope is the
 * old one's plaintext sealed again raw under `fresh`, nothing parsed. A
 * record that already carries an origin carries it on, after the same
 * bound check a reader makes (carryOrigin), or drops it, re-sealed, when it
 * does not bind or names nobody; a signed record with a named writer
 * becomes its own origin; anything else is re-sealed (decision D6). `judge`
 * says what legacy signature goes beside a re-key, judged on the writer's
 * record: none in a family folder.
 */
export async function rekeyRecord(
    input: ResealInput,
): Promise<{ envelope: Uint8Array } & RotatedRecord> {
    const { record, statement, envelope, old, fresh, targetEpoch, by } = input;
    const next = await rekeyEnvelope(envelope, old, fresh, input.aad);
    const statementsOver = (bytes: Uint8Array) => async () =>
        record === 'metadata'
            ? metadataStatements(statement as MetadataStatement, bytes)
            : versionStatements(statement as VersionStatement, bytes);
    const legacyOver = async (form: SignatureForm) =>
        record === 'metadata'
            ? signMetadata(by, statement as MetadataStatement, next, form)
            : signVersion(by, statement as VersionStatement, next, form);
    const resealed = async (
        dropOrigin: boolean,
    ): Promise<{ envelope: Uint8Array } & RotatedRecord> => ({
        envelope: next,
        signature: await legacyOver('resealed'),
        rekey: null,
        ...(dropOrigin ? { dropOrigin: true as const } : {}),
    });
    const position =
        record === 'metadata'
            ? {
                  kind: 'metadata' as const,
                  metadataVersion: (statement as MetadataStatement).metadataVersion,
              }
            : {
                  kind: 'version' as const,
                  versionId: (statement as VersionStatement).versionId,
              };
    let origin: RecordOrigin;
    if (input.rekey) {
        const served = input.rekey.origin;
        // The rekeyed statement names the writer: an origin whose writer is gone is dropped.
        if (!served.signerId) return resealed(true);
        const carried: RekeyedRecord = {
            record,
            statement,
            keyEpoch: input.keyEpoch,
            envelope,
            origin: {
                envelope: decode(served.envelope),
                signerId: served.signerId,
                signature: decode(served.signature),
                keyEnvelope: decode(served.keyEnvelope),
            },
            rekeySignature: decode(input.rekey.signature),
        } as RekeyedRecord;
        const wrapped = await carryOrigin(carried, old, fresh, targetEpoch);
        // Not bound: an honest rotation never signs its name under someone else's mismatch.
        if (!wrapped) return resealed(true);
        origin = {
            envelope: carried.origin.envelope,
            signerId: served.signerId,
            signature: carried.origin.signature!,
            keyEnvelope: wrapped,
        };
    } else if (input.signer && input.signature) {
        const opening = originOpeningKey(envelope, old);
        try {
            origin = {
                envelope,
                signerId: input.signer,
                signature: decode(input.signature),
                keyEnvelope: await wrapOriginKey(opening, fresh, {
                    workspaceId: statement.workspaceId,
                    nodeId: statement.nodeId,
                    keyEpoch: targetEpoch,
                    record: position,
                    originEnvelope: envelope,
                }),
            };
        } finally {
            opening.fill(0);
        }
    } else return resealed(false);
    const bytes =
        record === 'metadata'
            ? await metadataRekeyedStatement(
                  { ...(statement as MetadataStatement), keyEpoch: targetEpoch },
                  next,
                  origin,
              )
            : await versionRekeyedStatement(
                  { ...(statement as VersionStatement), keyEpoch: targetEpoch },
                  next,
                  origin,
              );
    // Judged on the writer's record, the origin, never on what a previous re-keyer signed.
    const legacy = await input.judge({
        statements: statementsOver(origin.envelope),
        signer: origin.signerId,
        signature: encode(origin.signature),
    });
    return {
        envelope: next,
        signature: legacy ? await legacyOver(legacy) : null,
        rekey: { originKeyEnvelope: encode(origin.keyEnvelope), signature: await sign(by, bytes) },
    };
}

/* What rekeyNode gives: a rotated node, without the rewrap and error branches. */
export type RekeyedNode = {
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

/*
 * One node re-keyed from `old` to `fresh` at `targetEpoch`, wrapped under
 * `parentKey` at the node's parentKeyEpoch: metadata, every version's
 * content key, every share and every link sealed again under the fresh key,
 * each record kept re-keyed where it can be (resealRecord). Nothing is
 * cached and neither key is zeroed: the caller owns both. `ownerKind` is
 * whose workspace the node is in (rekeyedFor, the one switch); `signer` the
 * open identity.
 */
export async function rekeyNode(input: {
    workspaceId: string;
    targetEpoch: number;
    granterUserId: string | null;
    node: RotateNodeInput;
    judge: RecordJudge;
    old: Uint8Array;
    fresh: Uint8Array;
    parentKey: Uint8Array;
    ownerKind: 'group' | 'personal';
    signer: RotationSigner;
}): Promise<RekeyedNode> {
    const { workspaceId, targetEpoch, granterUserId, node, judge, old, fresh, parentKey } = input;
    const nodeId = node.id;
    const by = input.signer;
    by();
    const keyEnvelope = await wrapNodeKey(fresh, parentKey, {
        workspaceId,
        nodeId,
        parentId: node.parentId,
        parentKeyEpoch: node.parentKeyEpoch,
        keyEpoch: targetEpoch,
    });
    // The one switch (rekeyedFor): outside it, exactly what rotations wrote before.
    const inScope = rekeyedFor({ ownerKind: input.ownerKind });
    const resealRecord = inScope ? rekeyRecord : legacyRecord;
    const metadata = await resealRecord({
        record: 'metadata',
        statement: {
            workspaceId,
            nodeId,
            kind: node.kind,
            metadataVersion: node.metadataVersion,
        },
        aad: metadataContext({
            workspaceId,
            nodeId,
            metadataVersion: node.metadataVersion,
        }),
        envelope: decode(node.metadataEnvelope),
        signer: node.metadataSigner,
        signature: node.metadataSignature,
        rekey: node.metadataRekey,
        keyEpoch: node.keyEpoch,
        targetEpoch,
        old,
        fresh,
        judge,
        by,
    });
    const versions: ({ id: string; contentKeyEnvelope: string } & RotatedRecord)[] = [];
    for (const version of node.versions) {
        const suite = version.contentSuite;
        // The same record in the object's own suite: its length is the suite's.
        const envelope = decode(
            version.contentKeyEnvelope,
            suite === LEGACY_CONTENT_SUITE ? KEY_ENVELOPE_BYTES : VERSION_ENVELOPE_BYTES,
        );
        const resealedVersion = await resealRecord({
            record: 'version',
            statement: {
                workspaceId,
                nodeId,
                versionId: version.id,
                objectId: version.objectId,
                contentSuite: suite,
            },
            aad: contentKeyContext({
                workspaceId,
                nodeId,
                versionId: version.id,
                objectId: version.objectId,
                suite,
            }),
            envelope,
            signer: version.signer,
            signature: version.signature,
            rekey: version.rekey,
            plaintextSize: version.plaintextSize,
            keyEpoch: node.keyEpoch,
            targetEpoch,
            old,
            fresh,
            judge,
            by,
        });
        versions.push({
            id: version.id,
            contentKeyEnvelope: encode(resealedVersion.envelope),
            signature: resealedVersion.signature,
            rekey: resealedVersion.rekey,
            ...(resealedVersion.dropOrigin ? { dropOrigin: true as const } : {}),
        });
    }
    const shares = [];
    for (const share of node.shares) {
        if (!granterUserId || by().userId !== granterUserId)
            throw new CryptoError('Open your identity first.');
        shares.push({
            id: share.id,
            shareEnvelope: encode(
                await sealShareKey(
                    fresh,
                    {
                        encryptionPublicKey: decode(share.granteePublicKey, 32),
                        kemPublicKey: share.granteeKemPublicKey
                            ? decode(share.granteeKemPublicKey, KEM_PUBLIC_KEY_BYTES)
                            : null,
                    },
                    by().hybridKeys(),
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
                linkEnvelope: encode(await sealLinkKeyWith(fresh, secret, stretched, newCtx)),
                secretEnvelope: encode(
                    await sealLinkSecret(secret, token, stretched, fresh, newCtx),
                ),
            });
        } finally {
            secret.fill(0);
            fromPassword?.fill(0);
        }
    }
    return {
        id: nodeId,
        keyEnvelope: encode(keyEnvelope),
        metadataEnvelope: encode(metadata.envelope),
        metadataSignature: metadata.signature,
        metadataRekey: metadata.rekey,
        ...(metadata.dropOrigin ? { metadataDropOrigin: true as const } : {}),
        versions,
        shares,
        links,
    };
}
