import sodium from 'libsodium-wrappers';
import { CryptoError } from './errors';
import { decryptKey, encryptKey } from './aead';
import { hybridKeyWithSalt } from './hybrid';
import {
    KEM_CIPHERTEXT_BYTES,
    KEM_PUBLIC_KEY_BYTES,
    KEM_SECRET_KEY_BYTES,
    kemDecapsulate,
    kemEncapsulate,
} from './pq';
import { shareStatement, signStatement, verifyStatement } from './signatures';

/*
 * A share is one node's key sealed to one grantee, as the design fixes it.
 * Suite 3 is the only one written or opened.
 *
 * Suite 3 (1256 bytes, docs/integrity-design.md): a fresh X25519 key per
 * share agreed with the grantee's identity key, and an ML-KEM-768
 * encapsulation to the grantee's KEM key; the body key is HKDF over both
 * secrets, salted with a digest of the KEM ciphertext and both X25519 public
 * keys. The granter signs the sealed bytes with their identity signing key,
 * and the grantee checks that signature against the granter's pinned key
 * before anything is decapsulated. A stolen granter key therefore opens none
 * of their shares, and neither side's key can stand in for the other's.
 * The envelope is the ephemeral public key, the KEM ciphertext, the nonce,
 * the body and the signature. It opens only under the granter's current
 * signing key: once they replace their keys, what an earlier key signed
 * waits for them to seal it again.
 *
 * Suites 1 (72 bytes) and 2 (1160 bytes) derived the body key from a static
 * X25519 agreement between the two identity keys, so a stolen granter key
 * opened every share they made. They are refused.
 */

export const SIGNED_SHARE_ENVELOPE_BYTES = 32 + KEM_CIPHERTEXT_BYTES + 24 + 32 + 16 + 64; // 1256
export const SHARE_SUITE = 3;

export type ShareSuite = 3;

const SIGNED_SHARE_KEY_INFO = 'hushos/drive/share-key/v3';
/* Where the signed bytes end: everything before the signature. */
const SIGNED_PART = SIGNED_SHARE_ENVELOPE_BYTES - 64;

export type ShareContext = {
    workspaceId: string;
    nodeId: string;
    keyEpoch: number;
    granteeUserId: string;
    granterUserId: string;
};

/* The grantee as the granter sees them, both keys checked against the grantee's pin. */
export type GranteeKeys = {
    encryptionPublicKey: Uint8Array;
    kemPublicKey: Uint8Array | null;
};
/* The grantee's own private halves. */
export type GranteeSecrets = {
    privateKey: Uint8Array;
    kemSecretKey: Uint8Array | null;
};
/* The suite an envelope was sealed under, from its length: suite 3, or refused. */
export function shareSuite(envelope: Uint8Array): ShareSuite {
    if (envelope.length === SIGNED_SHARE_ENVELOPE_BYTES) return 3;
    throw new CryptoError('Invalid share envelope.');
}

export function shareContext(ctx: ShareContext, suite: ShareSuite = 3) {
    return new TextEncoder().encode(
        JSON.stringify([
            'hushos/drive/share',
            suite,
            ctx.workspaceId.toLowerCase(),
            ctx.nodeId.toLowerCase(),
            ctx.keyEpoch,
            ctx.granteeUserId.toLowerCase(),
            ctx.granterUserId.toLowerCase(),
        ]),
    );
}

/* Raw X25519, refusing a low-order key whose agreement is all zeros. */
function agree(myPrivateKey: Uint8Array, theirPublicKey: Uint8Array) {
    if (theirPublicKey.length !== 32 || myPrivateKey.length !== 32)
        throw new CryptoError('Invalid identity key.');
    try {
        return sodium.crypto_scalarmult(myPrivateKey, theirPublicKey) as Uint8Array<ArrayBuffer>;
    } catch {
        throw new CryptoError('Invalid identity key.');
    }
}

/* salt = SHA-256(kemCiphertext || ephemeralPublicKey || granteePublicKey) */
async function signedShareKey(
    dh: Uint8Array,
    kemSecret: Uint8Array,
    kemCiphertext: Uint8Array,
    ephemeralPublicKey: Uint8Array,
    granteePublicKey: Uint8Array,
) {
    const transcript = new Uint8Array(KEM_CIPHERTEXT_BYTES + 64);
    transcript.set(kemCiphertext);
    transcript.set(ephemeralPublicKey, KEM_CIPHERTEXT_BYTES);
    transcript.set(granteePublicKey, KEM_CIPHERTEXT_BYTES + 32);
    const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', transcript));
    return hybridKeyWithSalt(dh, kemSecret, salt, SIGNED_SHARE_KEY_INFO);
}

/*
 * Seals a node key to a grantee in suite 3, signed with the granter's identity
 * signing key (libsodium's 64-byte secret key). The grantee's keys must be the
 * pinned ones: sealing to an unchecked key is sealing to a stranger.
 */
export async function sealShareKey(
    nodeKey: Uint8Array,
    grantee: GranteeKeys,
    granterSigningKey: Uint8Array,
    ctx: ShareContext,
) {
    await sodium.ready;
    if (nodeKey.length !== 32) throw new CryptoError('Invalid node key.');
    // Hybrid only: a share sealed to X25519 alone is a harvest-now, decrypt-later target,
    // and withholding the KEM key is all it would take.
    if (!grantee.kemPublicKey)
        throw new CryptoError('This person has no post-quantum key yet, so nothing was shared.');
    if (grantee.kemPublicKey.length !== KEM_PUBLIC_KEY_BYTES)
        throw new CryptoError('Invalid identity key.');
    const ephemeral = sodium.crypto_box_keypair();
    let dh: Uint8Array | undefined;
    try {
        dh = agree(ephemeral.privateKey, grantee.encryptionPublicKey);
        const { ciphertext, sharedSecret } = kemEncapsulate(grantee.kemPublicKey);
        const key = await signedShareKey(
            dh,
            sharedSecret,
            ciphertext,
            ephemeral.publicKey,
            grantee.encryptionPublicKey,
        );
        sharedSecret.fill(0);
        try {
            const nonce = crypto.getRandomValues(new Uint8Array(24));
            const body = await encryptKey(nodeKey, key, nonce, shareContext(ctx, 3));
            const envelope = new Uint8Array(SIGNED_SHARE_ENVELOPE_BYTES);
            envelope.set(ephemeral.publicKey);
            envelope.set(ciphertext, 32);
            envelope.set(nonce, 32 + KEM_CIPHERTEXT_BYTES);
            envelope.set(body, 32 + KEM_CIPHERTEXT_BYTES + 24);
            const statement = await shareStatement(ctx, envelope.subarray(0, SIGNED_PART));
            envelope.set(await signStatement(statement, granterSigningKey), SIGNED_PART);
            return envelope;
        } finally {
            key.fill(0);
        }
    } finally {
        ephemeral.privateKey.fill(0);
        dh?.fill(0);
    }
}

/*
 * Opens a share sealed to this identity: the node key inside. Only suite 3
 * opens, and only once its signature verifies under `granterSigningPublicKey`,
 * the granter's current signing key as the pin vouches for it; nothing about
 * it is decapsulated before. A key the granter has replaced opens nothing.
 */
export async function openShareKey(
    envelope: Uint8Array,
    granterSigningPublicKey: Uint8Array,
    grantee: GranteeSecrets,
    ctx: ShareContext,
) {
    await sodium.ready;
    shareSuite(envelope);
    return openSignedShare(envelope, granterSigningPublicKey, grantee, ctx);
}

async function openSignedShare(
    envelope: Uint8Array,
    granterSigningPublicKey: Uint8Array,
    grantee: GranteeSecrets,
    ctx: ShareContext,
) {
    if (granterSigningPublicKey.length !== 32)
        throw new CryptoError('This share needs the key of the person who shared it.');
    const statement = await shareStatement(ctx, envelope.subarray(0, SIGNED_PART));
    if (
        !(await verifyStatement(statement, envelope.subarray(SIGNED_PART), granterSigningPublicKey))
    )
        throw new CryptoError('This share is not signed by the person who shared it.');
    if (!grantee.kemSecretKey || grantee.kemSecretKey.length !== KEM_SECRET_KEY_BYTES)
        throw new CryptoError(
            'This share was sealed to a key this account does not hold yet. Unlock again and retry.',
        );
    const ephemeralPublicKey = envelope.subarray(0, 32);
    const ciphertext = envelope.subarray(32, 32 + KEM_CIPHERTEXT_BYTES);
    const nonce = envelope.subarray(32 + KEM_CIPHERTEXT_BYTES, 32 + KEM_CIPHERTEXT_BYTES + 24);
    const body = envelope.subarray(32 + KEM_CIPHERTEXT_BYTES + 24, SIGNED_PART);
    const dh = agree(grantee.privateKey, ephemeralPublicKey);
    try {
        const sharedSecret = kemDecapsulate(ciphertext, grantee.kemSecretKey);
        const key = await signedShareKey(
            dh,
            sharedSecret,
            ciphertext,
            ephemeralPublicKey,
            sodium.crypto_scalarmult_base(grantee.privateKey),
        );
        sharedSecret.fill(0);
        try {
            return (await decryptKey(
                body,
                key,
                nonce,
                shareContext(ctx, 3),
            )) as Uint8Array<ArrayBuffer>;
        } finally {
            key.fill(0);
        }
    } finally {
        dh.fill(0);
    }
}
