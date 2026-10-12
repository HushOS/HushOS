import sodium from 'libsodium-wrappers';
import { CryptoError } from './errors';
import { decode, encode } from './keys';

/*
 * What a signature in HushOS covers, as docs/integrity-design.md fixes it.
 *
 * Every statement is the UTF-8 of a compact JSON array, the same canonical
 * form as associated data: a domain string, a version, lowercase ids, and
 * SHA-256 digests (base64url, no padding) of the sealed bytes it vouches for.
 * The identity's Ed25519 key signs it detached. The server builds the same
 * statements to check a writer's signature before it stores one; clients
 * check again on read and never rely on that.
 */

export const SIGNATURE_BYTES = 64;
export const SIGNING_PUBLIC_KEY_BYTES = 32;
/* libsodium's Ed25519 secret key: the 32-byte seed followed by the public key. */
export const SIGNING_SECRET_KEY_BYTES = 64;

export type NodeKind = 'folder' | 'file';
/*
 * What a reader can say about who wrote a record:
 * - verified: the signer is someone this person trusts, and the signature holds;
 * - unknown-signer: there is a signature, but by nobody this person has verified;
 * - bad-signature: the signer is trusted, and the signature does not hold;
 * - unsigned: there is no signature (written before signatures).
 */
export type Integrity = 'verified' | 'unknown-signer' | 'bad-signature' | 'unsigned';

export type MetadataStatement = {
    workspaceId: string;
    nodeId: string;
    kind: NodeKind;
    metadataVersion: number;
};
export type VersionStatement = {
    workspaceId: string;
    nodeId: string;
    versionId: string;
    objectId: string;
    contentSuite: number;
};
export type ShareStatement = {
    workspaceId: string;
    nodeId: string;
    keyEpoch: number;
    granteeUserId: string;
    granterUserId: string;
};
/* One link of an identity's succession: the old keys vouching for the new ones. */
export type SuccessionStatement = {
    userId: string;
    oldKeyVersion: number;
    newKeyVersion: number;
    oldEncryptionPublicKey: string;
    oldSigningPublicKey: string;
    newEncryptionPublicKey: string;
    newSigningPublicKey: string;
    newKemPublicKey: string;
};

function text(value: string, what: string) {
    if (typeof value !== 'string' || value.length === 0) throw new CryptoError(`Invalid ${what}.`);
    return value.toLowerCase();
}
function count(value: number, what: string) {
    if (!Number.isSafeInteger(value) || value < 1) throw new CryptoError(`Invalid ${what}.`);
    return value;
}
function statement(parts: unknown[]) {
    return new TextEncoder().encode(JSON.stringify(parts));
}

/* SHA-256 of `bytes`, base64url without padding: how a statement names sealed bytes. */
export async function digest(bytes: Uint8Array) {
    return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice())));
}

/* ["hushos/drive/sig/metadata", 1, workspaceId, nodeId, kind, metadataVersion, sha256(metadataEnvelope)] */
export async function metadataStatement(ctx: MetadataStatement, metadataEnvelope: Uint8Array) {
    if (ctx.kind !== 'folder' && ctx.kind !== 'file') throw new CryptoError('Invalid node kind.');
    return statement([
        'hushos/drive/sig/metadata',
        1,
        text(ctx.workspaceId, 'workspace id'),
        text(ctx.nodeId, 'node id'),
        ctx.kind,
        count(ctx.metadataVersion, 'metadata version'),
        await digest(metadataEnvelope),
    ]);
}

/* ["hushos/drive/sig/version", 1, workspaceId, nodeId, versionId, objectId, contentSuite, sha256(contentKeyEnvelope)] */
export async function versionStatement(ctx: VersionStatement, contentKeyEnvelope: Uint8Array) {
    return statement([
        'hushos/drive/sig/version',
        1,
        text(ctx.workspaceId, 'workspace id'),
        text(ctx.nodeId, 'node id'),
        text(ctx.versionId, 'version id'),
        text(ctx.objectId, 'object id'),
        count(ctx.contentSuite, 'content suite'),
        await digest(contentKeyEnvelope),
    ]);
}

/*
 * ["hushos/drive/sig/share", 3, workspaceId, nodeId, keyEpoch, granteeUserId,
 *  granterUserId, sha256(ephemeralPublicKey || kemCiphertext || nonce || body)]
 * `sealed` is the envelope without its signature: everything the signature follows.
 */
export async function shareStatement(ctx: ShareStatement, sealed: Uint8Array) {
    return statement([
        'hushos/drive/sig/share',
        3,
        text(ctx.workspaceId, 'workspace id'),
        text(ctx.nodeId, 'node id'),
        count(ctx.keyEpoch, 'key epoch'),
        text(ctx.granteeUserId, 'user id'),
        text(ctx.granterUserId, 'user id'),
        await digest(sealed),
    ]);
}

/*
 * ["hushos/identity/succession", 1, userId, oldKeyVersion, newKeyVersion,
 *  oldX25519, oldEd25519, newX25519, newEd25519, sha256(newKemPublicKey)]
 * Keys are base64url as the server serves them; the KEM key is digested from
 * its bytes. The new version is the old one plus one, always.
 */
export async function successionStatement(link: SuccessionStatement) {
    const oldVersion = count(link.oldKeyVersion, 'key version');
    if (link.newKeyVersion !== oldVersion + 1) throw new CryptoError('Invalid key version.');
    // Canonical base64url of the right length, or refused: decode checks both.
    const key = (value: string, length: number) => {
        decode(value, length);
        return value;
    };
    return statement([
        'hushos/identity/succession',
        1,
        text(link.userId, 'user id'),
        oldVersion,
        link.newKeyVersion,
        key(link.oldEncryptionPublicKey, 32),
        key(link.oldSigningPublicKey, SIGNING_PUBLIC_KEY_BYTES),
        key(link.newEncryptionPublicKey, 32),
        key(link.newSigningPublicKey, SIGNING_PUBLIC_KEY_BYTES),
        await digest(decode(link.newKemPublicKey, 1184)),
    ]);
}

/* Ed25519, detached, with libsodium's 64-byte secret key. */
export async function signStatement(message: Uint8Array, signingKey: Uint8Array) {
    await sodium.ready;
    if (signingKey.length !== SIGNING_SECRET_KEY_BYTES)
        throw new CryptoError('Invalid signing key.');
    return new Uint8Array(sodium.crypto_sign_detached(message, signingKey));
}

/*
 * Whether `signature` is `signingPublicKey`'s over `message`. libsodium checks
 * strictly: a non-canonical signature, or a small-order key or point, fails.
 * Anything malformed is simply not a valid signature.
 */
export async function verifyStatement(
    message: Uint8Array,
    signature: Uint8Array,
    signingPublicKey: Uint8Array,
) {
    await sodium.ready;
    if (
        signature.length !== SIGNATURE_BYTES ||
        signingPublicKey.length !== SIGNING_PUBLIC_KEY_BYTES
    )
        return false;
    try {
        return sodium.crypto_sign_verify_detached(signature, message, signingPublicKey);
    } catch {
        return false;
    }
}

/*
 * What a reader shows for one record: no signature is `unsigned`; a signature
 * by someone the reader holds no trusted key for is `unknown-signer`; else it
 * is `verified` when any of that signer's trusted keys (their current one, or
 * an earlier one their succession chain vouches for) verifies it, and
 * `bad-signature` when none does.
 */
export async function integrityOf(
    message: () => Promise<Uint8Array>,
    signature: Uint8Array | null,
    trustedKeys: readonly Uint8Array[] | null | undefined,
): Promise<Integrity> {
    if (!signature) return 'unsigned';
    if (!trustedKeys || trustedKeys.length === 0) return 'unknown-signer';
    let bytes: Uint8Array;
    try {
        bytes = await message();
    } catch {
        return 'bad-signature';
    }
    for (const key of trustedKeys)
        if (await verifyStatement(bytes, signature, key)) return 'verified';
    return 'bad-signature';
}
