import { CryptoError } from './errors';
import { KEM_CIPHERTEXT_BYTES } from './pq';
import {
    HYBRID_SIGNATURE_BYTES,
    shareStatement,
    type HybridPublicKey,
    type HybridSigningKey,
} from './signatures';
import {
    openHybrid,
    sealHybrid,
    type GranteeKeys,
    type GranteeSecrets,
    type HybridSealKind,
} from './sealing';

export type { GranteeKeys, GranteeSecrets };

/*
 * A share is one node's key sealed to one grantee, as the design fixes it.
 * Suite 4 is the only one written or opened.
 *
 * Suite 4 (4565 bytes, docs/identity-pq-design.md): a fresh X25519 key per
 * share agreed with the grantee's identity key, and an ML-KEM-768
 * encapsulation to the grantee's KEM key; the body key is HKDF over both
 * secrets, salted with a digest of the KEM ciphertext and both X25519 public
 * keys. The granter signs the sealed bytes with their hybrid identity
 * signature (Ed25519 and ML-DSA-65), and the grantee checks both halves
 * against the granter's pinned keys before anything is decapsulated. A stolen
 * granter key therefore opens none of their shares, neither side's key can
 * stand in for the other's, and a quantum forger of Ed25519 still cannot seal
 * a share in someone's name. The envelope is the ephemeral public key, the
 * KEM ciphertext, the nonce, the body and the signature. The suite number is
 * in the key derivation, the associated data and the signed statement, so an
 * envelope cut down to an older suite's length opens as nothing.
 *
 * Suite 3 (1256 bytes) was the same with an Ed25519 signature alone; suites 1
 * and 2 derived the body key from a static X25519 agreement. All are refused.
 */

export const SIGNED_SHARE_ENVELOPE_BYTES =
    32 + KEM_CIPHERTEXT_BYTES + 24 + 32 + 16 + HYBRID_SIGNATURE_BYTES; // 4565
export const SHARE_SUITE = 4;

export type ShareSuite = 4;

const SIGNED_SHARE_KEY_INFO = 'hushos/drive/share-key/v4';

export type ShareContext = {
    workspaceId: string;
    nodeId: string;
    keyEpoch: number;
    granteeUserId: string;
    granterUserId: string;
};

/* The suite an envelope was sealed under, from its length: suite 4, or refused. */
export function shareSuite(envelope: Uint8Array): ShareSuite {
    if (envelope.length === SIGNED_SHARE_ENVELOPE_BYTES) return 4;
    throw new CryptoError('Invalid share envelope.');
}

export function shareContext(ctx: ShareContext, suite: ShareSuite = 4) {
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

/* What a share is sealed as: suite 4's `info`, its context as associated data, its statement. */
function shareKind(ctx: ShareContext): HybridSealKind {
    return {
        info: SIGNED_SHARE_KEY_INFO,
        associatedData: shareContext(ctx, 4),
        statement: (sealed) => shareStatement(ctx, sealed),
        noun: 'share',
        invalid: 'Invalid share envelope.',
        unsigned: 'This share is not signed by the person who shared it.',
    };
}

/*
 * Seals a node key to a grantee in suite 4, signed with the granter's hybrid
 * identity signature. The grantee's keys must be the pinned ones: sealing to
 * an unchecked key is sealing to a stranger.
 */
export async function sealShareKey(
    nodeKey: Uint8Array,
    grantee: GranteeKeys,
    granter: HybridSigningKey,
    ctx: ShareContext,
) {
    if (nodeKey.length !== 32) throw new CryptoError('Invalid node key.');
    return sealHybrid(nodeKey, grantee, granter, shareKind(ctx));
}

/*
 * Opens a share sealed to this identity: the node key inside. Only suite 4
 * opens, and only once both halves of its signature verify under `granter`,
 * the granter's current Ed25519 and ML-DSA keys as a version 3 pin vouches for
 * them; nothing about it is decapsulated before. A key the granter has
 * replaced opens nothing.
 */
export async function openShareKey(
    envelope: Uint8Array,
    granter: HybridPublicKey,
    grantee: GranteeSecrets,
    ctx: ShareContext,
) {
    shareSuite(envelope);
    if (granter.signingPublicKey.length !== 32 || granter.mlDsaPublicKey.length !== 1952)
        throw new CryptoError('This share needs the key of the person who shared it.');
    return openHybrid(envelope, 32, [granter], grantee, shareKind(ctx));
}
