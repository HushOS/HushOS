import sodium from 'libsodium-wrappers';
import { CryptoError } from './errors';
import { decryptKey, encryptKey } from './aead';

/*
 * A share is one node's key sealed to one grantee, as the design fixes it:
 * the symmetric key is crypto_box_beforenm over the granter's and grantee's
 * X25519 identity keys, the body is XChaCha20-Poly1305 over the node key with
 * the share's context as associated data, and the envelope is the 24-byte nonce
 * followed by the 48-byte body. Either side derives the same symmetric key from
 * their own private key and the other's public key, so the server, which only
 * ever holds public keys, cannot open it.
 */

export const SHARE_ENVELOPE_BYTES = 24 + 32 + 16;

export type ShareContext = {
    workspaceId: string;
    nodeId: string;
    keyEpoch: number;
    granteeUserId: string;
    granterUserId: string;
};

export function shareContext(ctx: ShareContext) {
    return new TextEncoder().encode(
        JSON.stringify([
            'hushos/drive/share',
            1,
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

export async function sealShareKey(
    nodeKey: Uint8Array,
    granteePublicKey: Uint8Array,
    granterPrivateKey: Uint8Array,
    ctx: ShareContext,
) {
    const key = await pairKey(granteePublicKey, granterPrivateKey);
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    try {
        const body = await encryptKey(nodeKey, key, nonce, shareContext(ctx));
        const envelope = new Uint8Array(SHARE_ENVELOPE_BYTES);
        envelope.set(nonce);
        envelope.set(body, 24);
        return envelope;
    } finally {
        key.fill(0);
    }
}

export async function openShareKey(
    envelope: Uint8Array,
    granterPublicKey: Uint8Array,
    granteePrivateKey: Uint8Array,
    ctx: ShareContext,
) {
    if (envelope.length !== SHARE_ENVELOPE_BYTES) throw new CryptoError('Invalid share envelope.');
    const key = await pairKey(granterPublicKey, granteePrivateKey);
    try {
        return (await decryptKey(
            envelope.subarray(24),
            key,
            envelope.subarray(0, 24),
            shareContext(ctx),
        )) as Uint8Array<ArrayBuffer>;
    } finally {
        key.fill(0);
    }
}
