import { createHash, createPublicKey, verify } from 'node:crypto';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

/*
 * The statements writers sign, as docs/integrity-design.md fixes them: a UTF-8
 * JSON array in the same canonical form as associated data (lowercase ids, no
 * spaces, numbers as numbers), digests SHA-256 in Base64url without padding.
 * Every client builds the same bytes; the server rebuilds them from what it is
 * about to store and refuses a write whose signature does not verify against
 * the writer's current signing key. Clients check again on read and never rely
 * on this check: it exists so a client bug fails loudly at the write.
 */

export const SIGNATURE_BYTES = 64;
/*
 * A person's hybrid signature (docs/identity-pq-design.md): Ed25519 then
 * ML-DSA-65 over the same statement, under the identity context; valid only if
 * both halves verify. It signs the keys statement and successions. File and
 * folder signatures stay Ed25519.
 */
export const ML_DSA_PUBLIC_KEY_BYTES = 1952;
export const HYBRID_SIGNATURE_BYTES = 64 + 3309;
const IDENTITY_CONTEXT = new TextEncoder().encode('hushos/identity/v1');

/*
 * Which statement a signature makes. `ordinary` vouches for who wrote the
 * record; `saved` says "I saved this from a link" (a trailing "link" names
 * the source), and is what a save from a link signs over everything it
 * creates; `resealed` says only "I re-locked this; I don't vouch for who
 * wrote it", and is what rotation and copy sign over a record they could not
 * check (docs/integrity-design.md, round 3 and "Saved copies"). The server
 * accepts any of the three on every signed write; readers tell them apart.
 */
export type StatementForm = 'ordinary' | 'saved' | 'resealed';
const FORMS: readonly StatementForm[] = ['ordinary', 'saved', 'resealed'];
const SAVED_FROM_LINK = 'link';
const label = (record: 'metadata' | 'version', form: StatementForm) =>
    form === 'ordinary' ? `hushos/drive/sig/${record}` : `hushos/drive/sig/${record}-${form}`;

/* SHA-256, Base64url without padding. */
export function digest(bytes: Uint8Array) {
    return createHash('sha256').update(bytes).digest('base64url');
}

function statement(parts: (string | number)[]) {
    return Buffer.from(JSON.stringify(parts), 'utf8');
}

export type MetadataStatementInput = {
    workspaceId: string;
    nodeId: string;
    kind: 'folder' | 'file';
    metadataVersion: number;
    metadataEnvelope: Uint8Array;
};
export function metadataStatement(input: MetadataStatementInput, form: StatementForm = 'ordinary') {
    return statement([
        label('metadata', form),
        1,
        input.workspaceId.toLowerCase(),
        input.nodeId.toLowerCase(),
        input.kind,
        input.metadataVersion,
        digest(input.metadataEnvelope),
        ...(form === 'saved' ? [SAVED_FROM_LINK] : []),
    ]);
}

export type VersionStatementInput = {
    workspaceId: string;
    nodeId: string;
    versionId: string;
    objectId: string;
    contentSuite: number;
    contentKeyEnvelope: Uint8Array;
};
export function versionStatement(input: VersionStatementInput, form: StatementForm = 'ordinary') {
    return statement([
        label('version', form),
        1,
        input.workspaceId.toLowerCase(),
        input.nodeId.toLowerCase(),
        input.versionId.toLowerCase(),
        input.objectId.toLowerCase(),
        input.contentSuite,
        digest(input.contentKeyEnvelope),
        ...(form === 'saved' ? [SAVED_FROM_LINK] : []),
    ]);
}

/*
 * Version 2, the only one accepted: keys are Base64url here, as the statement
 * names them; the KEM key only by its digest. Signed with the old identity's
 * hybrid signature.
 */
export function successionStatement(input: {
    userId: string;
    oldKeyVersion: number;
    newKeyVersion: number;
    oldEncryptionPublicKey: Uint8Array;
    oldSigningPublicKey: Uint8Array;
    oldMlDsaPublicKey: Uint8Array;
    newEncryptionPublicKey: Uint8Array;
    newSigningPublicKey: Uint8Array;
    newMlDsaPublicKey: Uint8Array;
    newKemPublicKey: Uint8Array;
}) {
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
    return statement([
        'hushos/identity/succession',
        2,
        input.userId.toLowerCase(),
        input.oldKeyVersion,
        input.newKeyVersion,
        b64(input.oldEncryptionPublicKey),
        b64(input.oldSigningPublicKey),
        b64(input.oldMlDsaPublicKey),
        b64(input.newEncryptionPublicKey),
        b64(input.newSigningPublicKey),
        b64(input.newMlDsaPublicKey),
        digest(input.newKemPublicKey),
    ]);
}

/* What binds a version 2 identity's four public keys to the account, signed with both signing keys. */
export function keysStatement(input: {
    userId: string;
    keyVersion: number;
    encryptionPublicKey: Uint8Array;
    signingPublicKey: Uint8Array;
    mlDsaPublicKey: Uint8Array;
    kemPublicKey: Uint8Array;
}) {
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
    return statement([
        'hushos/identity/keys',
        1,
        input.userId.toLowerCase(),
        input.keyVersion,
        b64(input.encryptionPublicKey),
        b64(input.signingPublicKey),
        b64(input.mlDsaPublicKey),
        digest(input.kemPublicKey),
    ]);
}

/*
 * What a device signs to come back to its own row at sign-in
 * (docs/devices-design.md, step 1): the account, the device, and the digest of
 * the sign-in attempt's token, the SHA-256 of its UTF-8 bytes (which is the
 * attempt's stored token hash). The attempt is consumed before anything is
 * checked, so a signature is good for exactly one sign-in. Signed with the
 * device's own Ed25519 key, never the identity's.
 */
export function deviceSessionStatement(input: {
    userId: string;
    deviceId: string;
    attemptDigest: Uint8Array;
}) {
    return statement([
        'hushos/device/session',
        1,
        input.userId.toLowerCase(),
        input.deviceId.toLowerCase(),
        Buffer.from(input.attemptDigest).toString('base64url'),
    ]);
}

/*
 * Whether `signature` is both halves of a hybrid signature by `keys` over
 * `message`: Ed25519 under the signing key, then ML-DSA-65 under the
 * identity context. The caller knows from context that the statement is a
 * hybrid one; any other length is false, never a classical fallback.
 */
export function verifyHybrid(
    keys: { signingPublicKey: Uint8Array; mlDsaPublicKey: Uint8Array },
    message: Uint8Array,
    signature: Uint8Array,
) {
    if (
        signature.length !== HYBRID_SIGNATURE_BYTES ||
        keys.mlDsaPublicKey.length !== ML_DSA_PUBLIC_KEY_BYTES
    )
        return false;
    if (!verifySignature(keys.signingPublicKey, message, signature.subarray(0, SIGNATURE_BYTES)))
        return false;
    try {
        return ml_dsa65.verify(signature.subarray(SIGNATURE_BYTES), message, keys.mlDsaPublicKey, {
            context: IDENTITY_CONTEXT,
        });
    } catch {
        return false;
    }
}

/* Ed25519 over `message` by the raw 32-byte `publicKey`; false for anything malformed. */
export function verifySignature(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) {
    if (publicKey.length !== 32 || signature.length !== SIGNATURE_BYTES) return false;
    try {
        const key = createPublicKey({
            key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey).toString('base64url') },
            format: 'jwk',
        });
        return verify(null, message, key, signature);
    } catch {
        return false;
    }
}

/*
 * A signature and the statements it may be over: the ordinary one first, then
 * the saved one, then the re-sealed one. It holds when it verifies over any of them.
 */
export type SignedStatement = { messages: Buffer[]; signature: Uint8Array };

export function metadataSigned(
    input: MetadataStatementInput,
    signature: Uint8Array,
): SignedStatement {
    return {
        messages: FORMS.map((form) => metadataStatement(input, form)),
        signature,
    };
}

export function versionSigned(
    input: VersionStatementInput,
    signature: Uint8Array,
): SignedStatement {
    return {
        messages: FORMS.map((form) => versionStatement(input, form)),
        signature,
    };
}

/* Whether `signed` holds under the raw Ed25519 `publicKey`, in any form. */
export function verifySigned(publicKey: Uint8Array, signed: SignedStatement) {
    return signed.messages.some((message) => verifySignature(publicKey, message, signed.signature));
}
