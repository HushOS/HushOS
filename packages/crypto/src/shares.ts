import sodium from 'libsodium-wrappers';
import { CryptoError } from './errors';
import { decryptKey, encryptKey } from './aead';
import {
    KEM_CIPHERTEXT_BYTES,
    KEM_PUBLIC_KEY_BYTES,
    KEM_SECRET_KEY_BYTES,
    kemDecapsulate,
    kemEncapsulate,
} from './pq';

/*
 * A share is one node's key sealed to one grantee, as the design fixes it. Two
 * suites exist and are told apart by length:
 *
 * Suite 1 (72 bytes): the symmetric key is crypto_box_beforenm over the
 * granter's and grantee's X25519 identity keys, the body is XChaCha20-Poly1305
 * over the node key with the share's context as associated data, and the
 * envelope is the 24-byte nonce followed by the 48-byte body.
 *
 * Suite 2 (1160 bytes): hybrid. The same X25519 agreement, and an ML-KEM-768
 * encapsulation to the grantee's KEM key; the body key is HKDF over both
 * secrets, salted with the KEM ciphertext, so the envelope opens only for
 * someone who holds both private halves and stays shut unless both problems
 * fall. The envelope is the nonce, the 1088-byte KEM ciphertext, then the body.
 * Suite 1 is still opened, for shares made before the grantee had a KEM key,
 * and still made, for a grantee who has none yet; it is never chosen when the
 * grantee's KEM key is known.
 *
 * Either side derives the same symmetric key from their own private keys and
 * the other's public keys, so the server, which only ever holds public keys,
 * cannot open it.
 */

export const SHARE_ENVELOPE_BYTES = 24 + 32 + 16;
export const HYBRID_SHARE_ENVELOPE_BYTES = 24 + KEM_CIPHERTEXT_BYTES + 32 + 16;

export type ShareSuite = 1 | 2;

export type ShareContext = {
    workspaceId: string;
    nodeId: string;
    keyEpoch: number;
    granteeUserId: string;
    granterUserId: string;
};

/* The grantee as the granter sees them: the X25519 key, and the KEM key when they have one. */
export type GranteeKeys = {
    encryptionPublicKey: Uint8Array;
    kemPublicKey: Uint8Array | null;
};
/* The grantee's own private halves. */
export type GranteeSecrets = {
    privateKey: Uint8Array;
    kemSecretKey: Uint8Array | null;
};

/* The suite an envelope was sealed under, from its length; anything else is refused. */
export function shareSuite(envelope: Uint8Array): ShareSuite {
    if (envelope.length === SHARE_ENVELOPE_BYTES) return 1;
    if (envelope.length === HYBRID_SHARE_ENVELOPE_BYTES) return 2;
    throw new CryptoError('Invalid share envelope.');
}

export function shareContext(ctx: ShareContext, suite: ShareSuite = 1) {
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

async function pairKey(theirPublicKey: Uint8Array, myPrivateKey: Uint8Array) {
    await sodium.ready;
    if (theirPublicKey.length !== 32 || myPrivateKey.length !== 32)
        throw new CryptoError('Invalid identity key.');
    try {
        return sodium.crypto_box_beforenm(theirPublicKey, myPrivateKey) as Uint8Array<ArrayBuffer>;
    } catch {
        throw new CryptoError('Invalid identity key.');
    }
}

/* The suite 2 body key: both secrets through HKDF, the KEM ciphertext as the salt. */
async function hybridKey(
    pair: Uint8Array<ArrayBuffer>,
    kemSecret: Uint8Array<ArrayBuffer>,
    kemCiphertext: Uint8Array,
) {
    const material = new Uint8Array(pair.length + kemSecret.length);
    material.set(pair);
    material.set(kemSecret, pair.length);
    try {
        const key = await crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveBits']);
        return new Uint8Array(
            await crypto.subtle.deriveBits(
                {
                    name: 'HKDF',
                    hash: 'SHA-256',
                    salt: kemCiphertext.slice(),
                    info: new TextEncoder().encode('hushos/drive/share-key/v2'),
                },
                key,
                256,
            ),
        ) as Uint8Array<ArrayBuffer>;
    } finally {
        material.fill(0);
    }
}

export async function sealShareKey(
    nodeKey: Uint8Array,
    grantee: GranteeKeys,
    granterPrivateKey: Uint8Array,
    ctx: ShareContext,
) {
    const pair = await pairKey(grantee.encryptionPublicKey, granterPrivateKey);
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    try {
        if (!grantee.kemPublicKey) {
            const body = await encryptKey(nodeKey, pair, nonce, shareContext(ctx, 1));
            const envelope = new Uint8Array(SHARE_ENVELOPE_BYTES);
            envelope.set(nonce);
            envelope.set(body, 24);
            return envelope;
        }
        if (grantee.kemPublicKey.length !== KEM_PUBLIC_KEY_BYTES)
            throw new CryptoError('Invalid identity key.');
        const { ciphertext, sharedSecret } = kemEncapsulate(grantee.kemPublicKey);
        const key = await hybridKey(pair, sharedSecret, ciphertext);
        sharedSecret.fill(0);
        try {
            const body = await encryptKey(nodeKey, key, nonce, shareContext(ctx, 2));
            const envelope = new Uint8Array(HYBRID_SHARE_ENVELOPE_BYTES);
            envelope.set(nonce);
            envelope.set(ciphertext, 24);
            envelope.set(body, 24 + KEM_CIPHERTEXT_BYTES);
            return envelope;
        } finally {
            key.fill(0);
        }
    } finally {
        pair.fill(0);
    }
}

export async function openShareKey(
    envelope: Uint8Array,
    granterPublicKey: Uint8Array,
    grantee: GranteeSecrets,
    ctx: ShareContext,
) {
    const suite = shareSuite(envelope);
    const pair = await pairKey(granterPublicKey, grantee.privateKey);
    try {
        if (suite === 1)
            return (await decryptKey(
                envelope.subarray(24),
                pair,
                envelope.subarray(0, 24),
                shareContext(ctx, 1),
            )) as Uint8Array<ArrayBuffer>;
        if (!grantee.kemSecretKey || grantee.kemSecretKey.length !== KEM_SECRET_KEY_BYTES)
            throw new CryptoError(
                'This share was sealed to a key this account does not hold yet. Unlock again and retry.',
            );
        const ciphertext = envelope.subarray(24, 24 + KEM_CIPHERTEXT_BYTES);
        const sharedSecret = kemDecapsulate(ciphertext, grantee.kemSecretKey);
        const key = await hybridKey(pair, sharedSecret, ciphertext);
        sharedSecret.fill(0);
        try {
            return (await decryptKey(
                envelope.subarray(24 + KEM_CIPHERTEXT_BYTES),
                key,
                envelope.subarray(0, 24),
                shareContext(ctx, 2),
            )) as Uint8Array<ArrayBuffer>;
        } finally {
            key.fill(0);
        }
    } finally {
        pair.fill(0);
    }
}
