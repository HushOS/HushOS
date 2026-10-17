import sodium from 'libsodium-wrappers';
import {
    contentKeyContext,
    KEY_ENVELOPE_BYTES,
    METADATA_ENVELOPE_MAX_BYTES,
    metadataContext,
    openEnvelopeBytes,
    openOriginKey,
    openWithOriginKey,
    versionEnvelopeBytes,
    type OriginKeyContext,
} from './drive';
import { CryptoError } from './errors';
import { decode, encode } from './keys';
import { ML_DSA_PUBLIC_KEY_BYTES, ML_DSA_SIGNATURE_BYTES, mlDsaSign, mlDsaVerify } from './pq';

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
/*
 * A person's hybrid signature (docs/identity-pq-design.md): Ed25519 over the
 * statement, then ML-DSA-65 over the same bytes under this context. Valid only
 * if both halves verify. It signs what decides whose keys to trust: the keys
 * statement, successions and shares. File and folder signatures stay Ed25519.
 */
export const HYBRID_SIGNATURE_BYTES = SIGNATURE_BYTES + ML_DSA_SIGNATURE_BYTES; // 3373
export const IDENTITY_SIGNATURE_CONTEXT = 'hushos/identity/v1';

export type NodeKind = 'folder' | 'file';
/*
 * What a reader can say about who wrote a record:
 * - verified: the signer is someone this person trusts, and the signature
 *   holds under their current signing key over the ordinary statement;
 * - saved-from-link: it holds under their current key over the saved
 *   statement ("I saved this from a link", where nobody's signature could
 *   be checked): shown without a mark, with a neutral line in Info;
 * - resealed: it holds under their current key, but over the re-sealed
 *   statement ("I re-locked this; I don't vouch for who wrote it");
 * - retired-key: it holds only under a signing key the signer has since
 *   replaced (an earlier key a succession chain vouches for, or the reader's
 *   own earlier key), which vouches for nothing any more;
 * - unknown-signer: there is a signature, but by nobody this person has verified;
 * - bad-signature: the signer is trusted, and the signature does not hold;
 * - unsigned: there is no signature (written before signatures, or stripped);
 * - unchecked: the check could not run (what the reader trusts did not load,
 *   or the check threw). Never shown as clean.
 * Only `verified` is clean and `saved-from-link` unmarked; everything else is an issue.
 */
export type Integrity =
    | 'verified'
    | 'saved-from-link'
    | 'resealed'
    | 'retired-key'
    | 'unknown-signer'
    | 'bad-signature'
    | 'unsigned'
    | 'unchecked';

/*
 * Which statement a signature makes over a record: `ordinary` ("I wrote
 * this"), `saved` ("I saved this from a link") or `resealed` ("I re-locked
 * this; I don't vouch for who wrote it").
 */
export type SignatureForm = 'ordinary' | 'saved' | 'resealed';

/*
 * The signing keys a reader trusts for one account: the current one, which
 * alone can make a record `verified` (or `saved-from-link`, `resealed`), and the ones it held
 * before, which can only make it `retired-key`.
 */
export type TrustedSigner = { current: Uint8Array; retired: readonly Uint8Array[] };

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
    oldMlDsaPublicKey: string;
    newEncryptionPublicKey: string;
    newSigningPublicKey: string;
    newMlDsaPublicKey: string;
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
/* A content suite, as the Rust core holds it: 1..2^32-1 (a u32 there). */
function suite(value: number) {
    if (count(value, 'content suite') > 0xffff_ffff)
        throw new CryptoError('Invalid content suite.');
    return value;
}
function statement(parts: unknown[]) {
    return new TextEncoder().encode(JSON.stringify(parts));
}

/* SHA-256 of `bytes`, base64url without padding: how a statement names sealed bytes. */
export async function digest(bytes: Uint8Array) {
    return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice())));
}

const METADATA_DOMAIN = 'hushos/drive/sig/metadata';
const VERSION_DOMAIN = 'hushos/drive/sig/version';
/* The re-sealed forms: the same fields under their own domain, so neither can pass for the other. */
const METADATA_RESEALED_DOMAIN = 'hushos/drive/sig/metadata-resealed';
const VERSION_RESEALED_DOMAIN = 'hushos/drive/sig/version-resealed';
/* The saved forms: the same fields under their own domain, then where the copy came from. */
const METADATA_SAVED_DOMAIN = 'hushos/drive/sig/metadata-saved';
const VERSION_SAVED_DOMAIN = 'hushos/drive/sig/version-saved';
/* The rekeyed forms: what a rotation that kept the writer's record signs (see metadataRekeyedStatement). */
const METADATA_REKEYED_DOMAIN = 'hushos/drive/sig/metadata-rekeyed';
const VERSION_REKEYED_DOMAIN = 'hushos/drive/sig/version-rekeyed';
/* The only source a saved statement names in version 1. */
const SAVED_FROM_LINK = 'link';

async function metadataParts(domain: string, ctx: MetadataStatement, metadataEnvelope: Uint8Array) {
    if (ctx.kind !== 'folder' && ctx.kind !== 'file') throw new CryptoError('Invalid node kind.');
    const parts: unknown[] = [
        domain,
        1,
        text(ctx.workspaceId, 'workspace id'),
        text(ctx.nodeId, 'node id'),
        ctx.kind,
        count(ctx.metadataVersion, 'metadata version'),
        await digest(metadataEnvelope),
    ];
    if (domain === METADATA_SAVED_DOMAIN) parts.push(SAVED_FROM_LINK);
    return statement(parts);
}
async function versionParts(domain: string, ctx: VersionStatement, contentKeyEnvelope: Uint8Array) {
    const parts: unknown[] = [
        domain,
        1,
        text(ctx.workspaceId, 'workspace id'),
        text(ctx.nodeId, 'node id'),
        text(ctx.versionId, 'version id'),
        text(ctx.objectId, 'object id'),
        suite(ctx.contentSuite),
        await digest(contentKeyEnvelope),
    ];
    if (domain === VERSION_SAVED_DOMAIN) parts.push(SAVED_FROM_LINK);
    return statement(parts);
}

/* ["hushos/drive/sig/metadata", 1, workspaceId, nodeId, kind, metadataVersion, sha256(metadataEnvelope)] */
export async function metadataStatement(ctx: MetadataStatement, metadataEnvelope: Uint8Array) {
    return metadataParts(METADATA_DOMAIN, ctx, metadataEnvelope);
}

/*
 * ["hushos/drive/sig/metadata-resealed", 1, workspaceId, nodeId, kind, metadataVersion, sha256(metadataEnvelope)]
 * What a rotation or copy signs over metadata it re-sealed without having
 * verified who wrote it: the signer re-locked it and vouches for nothing else.
 */
export async function metadataResealedStatement(
    ctx: MetadataStatement,
    metadataEnvelope: Uint8Array,
) {
    return metadataParts(METADATA_RESEALED_DOMAIN, ctx, metadataEnvelope);
}

/* ["hushos/drive/sig/version", 1, workspaceId, nodeId, versionId, objectId, contentSuite, sha256(contentKeyEnvelope)] */
export async function versionStatement(ctx: VersionStatement, contentKeyEnvelope: Uint8Array) {
    return versionParts(VERSION_DOMAIN, ctx, contentKeyEnvelope);
}

/* ["hushos/drive/sig/version-resealed", 1, ...the version statement's fields]: see metadataResealedStatement. */
export async function versionResealedStatement(
    ctx: VersionStatement,
    contentKeyEnvelope: Uint8Array,
) {
    return versionParts(VERSION_RESEALED_DOMAIN, ctx, contentKeyEnvelope);
}

/*
 * ["hushos/drive/sig/metadata-saved", 1, workspaceId, nodeId, kind, metadataVersion, sha256(metadataEnvelope), "link"]
 * What a save from a link signs over the metadata it creates (the copied
 * file's, and each folder the save makes): the signer saved it from a link,
 * where nobody's signature could be checked, and vouches for nothing else.
 */
export async function metadataSavedStatement(ctx: MetadataStatement, metadataEnvelope: Uint8Array) {
    return metadataParts(METADATA_SAVED_DOMAIN, ctx, metadataEnvelope);
}

/* ["hushos/drive/sig/version-saved", 1, ...the version statement's fields, "link"]: see metadataSavedStatement. */
export async function versionSavedStatement(ctx: VersionStatement, contentKeyEnvelope: Uint8Array) {
    return versionParts(VERSION_SAVED_DOMAIN, ctx, contentKeyEnvelope);
}

/* The statement of one form over a record's metadata or version: what a writer signs. */
export async function metadataStatementAs(
    form: SignatureForm,
    ctx: MetadataStatement,
    metadataEnvelope: Uint8Array,
) {
    if (form === 'saved') return metadataSavedStatement(ctx, metadataEnvelope);
    if (form === 'resealed') return metadataResealedStatement(ctx, metadataEnvelope);
    if (form === 'ordinary') return metadataStatement(ctx, metadataEnvelope);
    throw new CryptoError('Invalid signature form.');
}
export async function versionStatementAs(
    form: SignatureForm,
    ctx: VersionStatement,
    contentKeyEnvelope: Uint8Array,
) {
    if (form === 'saved') return versionSavedStatement(ctx, contentKeyEnvelope);
    if (form === 'resealed') return versionResealedStatement(ctx, contentKeyEnvelope);
    if (form === 'ordinary') return versionStatement(ctx, contentKeyEnvelope);
    throw new CryptoError('Invalid signature form.');
}

/* A record's three statement forms, in the order integrityOf tries them. */
export type StatementForms = { ordinary: Uint8Array; saved: Uint8Array; resealed: Uint8Array };
export async function metadataStatements(
    ctx: MetadataStatement,
    metadataEnvelope: Uint8Array,
): Promise<StatementForms> {
    return {
        ordinary: await metadataStatement(ctx, metadataEnvelope),
        saved: await metadataSavedStatement(ctx, metadataEnvelope),
        resealed: await metadataResealedStatement(ctx, metadataEnvelope),
    };
}
export async function versionStatements(
    ctx: VersionStatement,
    contentKeyEnvelope: Uint8Array,
): Promise<StatementForms> {
    return {
        ordinary: await versionStatement(ctx, contentKeyEnvelope),
        saved: await versionSavedStatement(ctx, contentKeyEnvelope),
        resealed: await versionResealedStatement(ctx, contentKeyEnvelope),
    };
}

/*
 * How a rotation or rename re-signs a record it sealed again, from the
 * record's verdict as it was: `verified` stays ordinary, `saved-from-link`
 * stays saved, anything else is re-sealed, so re-locking never launders a
 * record into one this person vouches for. A record whose check did not run
 * is not re-signed at all. Rotations move to the rekeyed form and compatForm
 * (docs/integrity-design.md, "Re-keyed records"); renames and copies keep this.
 */
export function resealForm(prior: Integrity): SignatureForm {
    if (prior === 'unchecked')
        throw new CryptoError(
            'HushOS couldn’t check who wrote this, so it was not locked again. Try again.',
        );
    if (prior === 'verified') return 'ordinary';
    if (prior === 'saved-from-link') return 'saved';
    return 'resealed';
}

/*
 * The legacy signature a rotation writes beside the rekeyed one, for readers
 * that do not know it yet (the honest form): ordinary (or saved) only for the
 * re-keyer's own record (`ownRecord`: the origin's signer is the re-keyer)
 * whose origin verified as such; re-sealed for everything else. It never
 * throws: an unchecked record is re-sealed, so one record nobody could check
 * no longer blocks a rotation, and it never claims another person's work.
 */
export function compatForm(prior: Integrity, ownRecord: boolean): SignatureForm {
    if (ownRecord && prior === 'verified') return 'ordinary';
    if (ownRecord && prior === 'saved-from-link') return 'saved';
    return 'resealed';
}

/*
 * How a copy signs, by where the original came from: saved when it came from
 * a link (a visitor never sees signatures, so `prior` does not matter),
 * otherwise as a reseal of the original's verdict.
 */
export function copyForm(prior: Integrity | null, fromLink: boolean): SignatureForm {
    if (fromLink) return 'saved';
    return resealForm(prior ?? 'unchecked');
}

/*
 * A record as its writer signed it, before a rotation re-sealed it: the
 * envelope, who the server says signed it and the signature. What a rekeyed
 * statement names.
 */
export type RecordOrigin = { envelope: Uint8Array; signerId: string; signature: Uint8Array };
/* The node key's epoch after the rotation, beside the record's fields. */
export type Rekeyed<T> = T & { keyEpoch: number };

async function rekeyedTail(
    keyEpoch: number,
    envelope: Uint8Array,
    origin: RecordOrigin,
): Promise<unknown[]> {
    return [
        count(keyEpoch, 'key epoch'),
        await digest(envelope),
        await digest(origin.envelope),
        text(origin.signerId, 'user id'),
        await digest(origin.signature),
    ];
}

/*
 * ["hushos/drive/sig/metadata-rekeyed", 1, workspaceId, nodeId, kind, metadataVersion, keyEpoch,
 *  sha256(metadataEnvelope), sha256(originEnvelope), originSignerId, sha256(originSignature)]
 * What the account running a rotation signs over metadata it re-keyed while
 * keeping the writer's record: that it re-sealed that origin under the node
 * key at `keyEpoch`. Who wrote it is the origin signature's business.
 */
export async function metadataRekeyedStatement(
    ctx: Rekeyed<MetadataStatement>,
    metadataEnvelope: Uint8Array,
    origin: RecordOrigin,
) {
    if (ctx.kind !== 'folder' && ctx.kind !== 'file') throw new CryptoError('Invalid node kind.');
    return statement([
        METADATA_REKEYED_DOMAIN,
        1,
        text(ctx.workspaceId, 'workspace id'),
        text(ctx.nodeId, 'node id'),
        ctx.kind,
        count(ctx.metadataVersion, 'metadata version'),
        ...(await rekeyedTail(ctx.keyEpoch, metadataEnvelope, origin)),
    ]);
}

/*
 * ["hushos/drive/sig/version-rekeyed", 1, workspaceId, nodeId, versionId, objectId, contentSuite,
 *  keyEpoch, sha256(contentKeyEnvelope), sha256(originEnvelope), originSignerId, sha256(originSignature)]
 * See metadataRekeyedStatement.
 */
export async function versionRekeyedStatement(
    ctx: Rekeyed<VersionStatement>,
    contentKeyEnvelope: Uint8Array,
    origin: RecordOrigin,
) {
    return statement([
        VERSION_REKEYED_DOMAIN,
        1,
        text(ctx.workspaceId, 'workspace id'),
        text(ctx.nodeId, 'node id'),
        text(ctx.versionId, 'version id'),
        text(ctx.objectId, 'object id'),
        suite(ctx.contentSuite),
        ...(await rekeyedTail(ctx.keyEpoch, contentKeyEnvelope, origin)),
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
        4,
        text(ctx.workspaceId, 'workspace id'),
        text(ctx.nodeId, 'node id'),
        count(ctx.keyEpoch, 'key epoch'),
        text(ctx.granteeUserId, 'user id'),
        text(ctx.granterUserId, 'user id'),
        await digest(sealed),
    ]);
}

/* Canonical base64url of the right length, or refused: decode checks both. */
function key(value: string, length: number) {
    decode(value, length);
    return value;
}

/*
 * ["hushos/identity/succession", 2, userId, oldKeyVersion, newKeyVersion,
 *  oldX25519, oldEd25519, oldMlDsa, newX25519, newEd25519, newMlDsa,
 *  sha256(newKemPublicKey)]
 * Keys are base64url as the server serves them; the KEM key is digested from
 * its bytes. The new version is above the old one (one above, when minted).
 * Signed with the old identity's hybrid signature. Version 1 is refused.
 */
export async function successionStatement(link: SuccessionStatement) {
    return successionAt(2, link);
}

/*
 * ["hushos/identity/succession-consent", 1, role, userId, ...the version 2
 * fields...], role "old" or "new": a succession's consent, its own domain, one
 * half signed by the old identity's hybrid keys over role "old" and the other
 * by the new identity's over role "new" (docs/identity-pq-design.md 2). The
 * domain separates it from the one-sided version 2 statement (and from the
 * version 3 succession the docs keep for a restart link), and the role keeps
 * either half from standing for the other. The group core asks it of links
 * into keys it reached from a member's first keys.
 */
export type ConsentRole = 'old' | 'new';
export async function successionConsentStatement(link: SuccessionStatement, role: ConsentRole) {
    if (role !== 'old' && role !== 'new') throw new CryptoError('Invalid consent role.');
    return successionFields('hushos/identity/succession-consent', [1, role], link);
}

async function successionAt(version: 2, link: SuccessionStatement) {
    return successionFields('hushos/identity/succession', [version], link);
}

async function successionFields(
    domain: string,
    head: (number | string)[],
    link: SuccessionStatement,
) {
    // A succession mints current + 1; a reader asks only that the version rose, since a
    // master-key rotation may have raised it to the root's revision between two links.
    const oldVersion = count(link.oldKeyVersion, 'key version');
    if (!Number.isSafeInteger(link.newKeyVersion) || link.newKeyVersion <= oldVersion)
        throw new CryptoError('Invalid key version.');
    return statement([
        domain,
        ...head,
        text(link.userId, 'user id'),
        oldVersion,
        link.newKeyVersion,
        key(link.oldEncryptionPublicKey, 32),
        key(link.oldSigningPublicKey, SIGNING_PUBLIC_KEY_BYTES),
        key(link.oldMlDsaPublicKey, ML_DSA_PUBLIC_KEY_BYTES),
        key(link.newEncryptionPublicKey, 32),
        key(link.newSigningPublicKey, SIGNING_PUBLIC_KEY_BYTES),
        key(link.newMlDsaPublicKey, ML_DSA_PUBLIC_KEY_BYTES),
        await digest(decode(link.newKemPublicKey, 1184)),
    ]);
}

/*
 * ["hushos/identity/keys", 1, userId, keyVersion, x25519, ed25519, mlDsa,
 *  sha256(kemPublicKey)]
 * What binds a version 2 identity's four public keys to the account. The
 * identity signs it with its own hybrid signature, proving it holds both
 * signing keys. It replaces the Ed25519-only KEM binding.
 */
export type KeysStatement = {
    userId: string;
    keyVersion: number;
    encryptionPublicKey: string;
    signingPublicKey: string;
    mlDsaPublicKey: string;
    kemPublicKey: string;
};
export async function keysStatement(keys: KeysStatement) {
    return statement([
        'hushos/identity/keys',
        1,
        text(keys.userId, 'user id'),
        count(keys.keyVersion, 'key version'),
        key(keys.encryptionPublicKey, 32),
        key(keys.signingPublicKey, SIGNING_PUBLIC_KEY_BYTES),
        key(keys.mlDsaPublicKey, ML_DSA_PUBLIC_KEY_BYTES),
        await digest(decode(keys.kemPublicKey, 1184)),
    ]);
}

/* The two private halves of a person's signature: libsodium's 64-byte Ed25519 key and ML-DSA-65's. */
export type HybridSigningKey = { signingKey: Uint8Array; mlDsaSecretKey: Uint8Array };
/* The two public halves it verifies under. */
export type HybridPublicKey = { signingPublicKey: Uint8Array; mlDsaPublicKey: Uint8Array };

/* Ed25519 || ML-DSA-65 over the same statement: 3373 bytes. */
export async function signHybrid(message: Uint8Array, keys: HybridSigningKey) {
    const classical = await signStatement(message, keys.signingKey);
    const lattice = mlDsaSign(message, keys.mlDsaSecretKey, IDENTITY_SIGNATURE_CONTEXT);
    const signature = new Uint8Array(HYBRID_SIGNATURE_BYTES);
    signature.set(classical);
    signature.set(lattice, SIGNATURE_BYTES);
    return signature;
}

/*
 * Whether `signature` is both halves of `keys`' hybrid signature over
 * `message`. The caller knows from context that the statement is a hybrid one;
 * a signature of any other length is not valid, never a classical fallback.
 */
export async function verifyHybrid(
    message: Uint8Array,
    signature: Uint8Array,
    keys: HybridPublicKey,
) {
    if (signature.length !== HYBRID_SIGNATURE_BYTES) return false;
    const classical = signature.subarray(0, SIGNATURE_BYTES);
    const lattice = signature.subarray(SIGNATURE_BYTES);
    return (
        (await verifyStatement(message, classical, keys.signingPublicKey)) &&
        mlDsaVerify(lattice, message, keys.mlDsaPublicKey, IDENTITY_SIGNATURE_CONTEXT)
    );
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
 * What a reader shows for one record (see Integrity):
 * - no signature is `unsigned`;
 * - a signature by someone the reader holds no trusted key for is `unknown-signer`;
 * - otherwise the ordinary statement, then the saved one, then the re-sealed
 *   one, under the signer's current key: `verified`, `saved-from-link`,
 *   then `resealed`;
 * - then any of them under a key the signer has replaced: `retired-key`;
 * - and `bad-signature` when nothing holds, or when the record is too
 *   malformed for a statement to be built over it.
 * A check that throws anywhere else is `unchecked`, never clean.
 */
export async function integrityOf(
    statements: () => Promise<StatementForms>,
    signature: Uint8Array | null,
    trusted: TrustedSigner | null | undefined,
): Promise<Integrity> {
    if (!signature) return 'unsigned';
    if (!trusted) return 'unknown-signer';
    let forms: StatementForms;
    try {
        forms = await statements();
    } catch (error) {
        // A record no statement can be built over cannot carry a valid signature;
        // anything other than a refusal of its fields is the check failing to run.
        if (error instanceof CryptoError) return 'bad-signature';
        return 'unchecked';
    }
    try {
        if (await verifyStatement(forms.ordinary, signature, trusted.current)) return 'verified';
        if (await verifyStatement(forms.saved, signature, trusted.current))
            return 'saved-from-link';
        if (await verifyStatement(forms.resealed, signature, trusted.current)) return 'resealed';
        for (const key of trusted.retired)
            for (const statement of [forms.ordinary, forms.saved, forms.resealed])
                if (await verifyStatement(statement, signature, key)) return 'retired-key';
        return 'bad-signature';
    } catch {
        return 'unchecked';
    }
}

/*
 * A re-keyed record's origin as the server serves it: the writer's envelope,
 * signer (null once their account is gone) and signature, and the origin's
 * opening key wrapped under the current node key.
 */
export type ServedOrigin = {
    envelope: Uint8Array;
    signerId: string | null;
    signature: Uint8Array | null;
    keyEnvelope: Uint8Array;
};
/* A re-keyed record as served: the current envelope under the node key at `keyEpoch`, its origin, the re-keyer's signature. */
export type RekeyedRecord =
    | {
          record: 'metadata';
          statement: MetadataStatement;
          keyEpoch: number;
          envelope: Uint8Array;
          origin: ServedOrigin;
          rekeySignature: Uint8Array | null;
      }
    | {
          record: 'version';
          statement: VersionStatement;
          keyEpoch: number;
          envelope: Uint8Array;
          origin: ServedOrigin;
          rekeySignature: Uint8Array | null;
      };
/* The keys a reader trusts for a re-keyed record's two signers; null for someone not checked. */
export type RekeyedTrust = { origin: TrustedSigner | null; rekeyer: TrustedSigner | null };
/*
 * What a reader shows for a re-keyed record: `origin` is the record's verdict,
 * named after the origin's signer; `rekeyer` the re-keyer's, for the Info line
 * only. With `mismatch` the binding failed (the origin did not open, its bytes
 * differ from the current envelope's, or the re-keyer's signature is missing
 * or bad under a key the reader trusts): `origin` is then `bad-signature`,
 * shown as the re-keyer's.
 */
export type RekeyedVerdict = { origin: Integrity; rekeyer: Integrity; mismatch: boolean };

/*
 * Whether the origin, opened with the key wrapped beside it, holds exactly the
 * bytes the current envelope holds under the node key. Any refusal on the way
 * (a length, a context, a tag) is false.
 */
async function originBound(nodeKey: Uint8Array, record: RekeyedRecord) {
    const { statement: s, origin } = record;
    let aad: Uint8Array;
    let keyCtx: OriginKeyContext;
    try {
        if (record.record === 'metadata') {
            const fits = (envelope: Uint8Array) => envelope.length <= METADATA_ENVELOPE_MAX_BYTES;
            if (!fits(record.envelope) || !fits(origin.envelope)) return false;
            aad = metadataContext({
                workspaceId: s.workspaceId,
                nodeId: s.nodeId,
                metadataVersion: record.statement.metadataVersion,
            });
            keyCtx = {
                workspaceId: s.workspaceId,
                nodeId: s.nodeId,
                keyEpoch: record.keyEpoch,
                record: { kind: 'metadata', metadataVersion: record.statement.metadataVersion },
                originEnvelope: origin.envelope,
            };
        } else {
            const v = record.statement;
            const length = versionEnvelopeBytes(v.contentSuite);
            if (record.envelope.length !== length || origin.envelope.length !== length)
                return false;
            aad = contentKeyContext({
                workspaceId: v.workspaceId,
                nodeId: v.nodeId,
                versionId: v.versionId,
                objectId: v.objectId,
                suite: v.contentSuite,
            });
            keyCtx = {
                workspaceId: v.workspaceId,
                nodeId: v.nodeId,
                keyEpoch: record.keyEpoch,
                record: { kind: 'version', versionId: v.versionId },
                originEnvelope: origin.envelope,
            };
        }
        if (nodeKey.length !== 32 || origin.keyEnvelope.length !== KEY_ENVELOPE_BYTES) return false;
        const originKey = await openOriginKey(origin.keyEnvelope, nodeKey, keyCtx);
        let written: Uint8Array | undefined;
        let current: Uint8Array | undefined;
        try {
            written = await openWithOriginKey(origin.envelope, originKey, aad);
            current = await openEnvelopeBytes(record.envelope, nodeKey, aad);
            return (
                written.length === current.length &&
                written.every((byte, i) => byte === current![i])
            );
        } finally {
            originKey.fill(0);
            written?.fill(0);
            current?.fill(0);
        }
    } catch (error) {
        if (error instanceof CryptoError) return false;
        throw error;
    }
}

/*
 * A re-keyed record's checks, before trust: whether its origin opens to the
 * current envelope's bytes, the origin's verdict under any keys, and the
 * re-keyer's. The group core applies its own trust to both (group-trust.ts).
 */
export type RekeyedChecks = {
    bound: boolean;
    originSigned: boolean;
    rekeySigned: boolean;
    origin: (trusted: TrustedSigner | null) => Promise<Integrity>;
    rekeyer: (trusted: TrustedSigner | null) => Promise<Integrity>;
};
export async function rekeyedChecks(
    record: RekeyedRecord,
    nodeKey: Uint8Array,
): Promise<RekeyedChecks> {
    const { origin } = record;
    const forms =
        record.record === 'metadata'
            ? () => metadataStatements(record.statement, origin.envelope)
            : () => versionStatements(record.statement, origin.envelope);
    const named = (): RecordOrigin => {
        if (!origin.signature) throw new CryptoError('This record’s origin carries no signature.');
        return {
            envelope: origin.envelope,
            signerId: origin.signerId!,
            signature: origin.signature,
        };
    };
    const rekeyed =
        record.record === 'metadata'
            ? () =>
                  metadataRekeyedStatement(
                      { ...record.statement, keyEpoch: record.keyEpoch },
                      record.envelope,
                      named(),
                  )
            : () =>
                  versionRekeyedStatement(
                      { ...record.statement, keyEpoch: record.keyEpoch },
                      record.envelope,
                      named(),
                  );
    return {
        bound: await originBound(nodeKey, record),
        originSigned: !!origin.signature,
        rekeySigned: !!record.rekeySignature,
        origin: (trusted) => integrityOf(forms, origin.signature, trusted),
        rekeyer: (trusted) =>
            rekeyerIntegrityOf(rekeyed, record.rekeySignature, trusted, origin.signerId === null),
    };
}

/*
 * The re-keyer's verdict over the rekeyed statement, its one form: no
 * signature is `unsigned`, no trusted keys `unknown-signer`, an origin whose
 * signer is gone `unchecked` (the statement names them and the server no
 * longer does), a statement that does not build `bad-signature`; then the
 * current key (`verified`), the retired ones (`retired-key`), else bad.
 */
async function rekeyerIntegrityOf(
    statement: () => Promise<Uint8Array>,
    signature: Uint8Array | null,
    trusted: TrustedSigner | null | undefined,
    signerGone: boolean,
): Promise<Integrity> {
    if (!signature) return 'unsigned';
    if (!trusted) return 'unknown-signer';
    if (signerGone) return 'unchecked';
    let bytes: Uint8Array;
    try {
        bytes = await statement();
    } catch (error) {
        if (error instanceof CryptoError) return 'bad-signature';
        return 'unchecked';
    }
    try {
        if (await verifyStatement(bytes, signature, trusted.current)) return 'verified';
        for (const key of trusted.retired)
            if (await verifyStatement(bytes, signature, key)) return 'retired-key';
        return 'bad-signature';
    } catch {
        return 'unchecked';
    }
}

/* A re-keyer's verdict that breaks the binding: a signature missing, or bad under a key the reader trusts. */
export function breaksBinding(rekeyer: string) {
    return rekeyer === 'bad-signature' || rekeyer === 'unsigned';
}

const unchecked = (): RekeyedVerdict => ({
    origin: 'unchecked',
    rekeyer: 'unchecked',
    mismatch: false,
});

/*
 * What a reader shows for a re-keyed record (RekeyedVerdict). `nodeKey` is the
 * node's key at `record.keyEpoch`, null when the reader does not hold it;
 * `trust` is null when what the reader trusts did not load. Either missing is
 * `unchecked`, never clean, and so is a check that throws.
 */
export async function rekeyedIntegrityOf(
    record: RekeyedRecord,
    nodeKey: Uint8Array | null,
    trust: RekeyedTrust | null,
): Promise<RekeyedVerdict> {
    if (!nodeKey || !trust) return unchecked();
    try {
        const checks = await rekeyedChecks(record, nodeKey);
        const rekeyer = await checks.rekeyer(trust.rekeyer);
        if (!checks.bound || breaksBinding(rekeyer))
            return { origin: 'bad-signature', rekeyer, mismatch: true };
        return { origin: await checks.origin(trust.origin), rekeyer, mismatch: false };
    } catch {
        return unchecked();
    }
}
