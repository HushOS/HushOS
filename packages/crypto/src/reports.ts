import sodium from 'libsodium-wrappers';
import { CryptoError } from './errors';
import { hybridKey } from './hybrid';
import {
    KEM_CIPHERTEXT_BYTES,
    KEM_PUBLIC_KEY_BYTES,
    KEM_SECRET_KEY_BYTES,
    kemDecapsulate,
    kemEncapsulate,
} from './pq';

/*
 * A report hands an operator the key to what was reported, and nobody else:
 * the reporter's device seals the node key to each operator's identity, with
 * no account of the reporter's involved, and the report's context is bound in
 * by a digest carried inside the envelope that the opener checks. The server
 * stores the sealed bodies and, holding only public keys, can open none of
 * them. Two suites exist and are told apart by length:
 *
 * Suite 1 (112 bytes): a libsodium sealed box to the operator's X25519 key,
 * over the node key and the digest.
 *
 * Suite 2 (1224 bytes): hybrid. An ephemeral X25519 key agreed with the
 * operator's, and an ML-KEM-768 encapsulation to the operator's KEM key; the
 * body key is HKDF over both secrets, salted with the KEM ciphertext, and the
 * body is XChaCha20-Poly1305 over the node key and the digest with the suite 2
 * context as associated data. The envelope is the ephemeral public key, the
 * KEM ciphertext, the nonce, then the body. Suite 1 is still opened, and still
 * made for an operator who has no KEM key yet; never when the key is known.
 */

export const REPORT_KEY_BYTES = 32;
export const REPORT_ENVELOPE_BYTES = 32 + 16 + REPORT_KEY_BYTES + 32; // ephemeral key, tag, key, digest
export const HYBRID_REPORT_ENVELOPE_BYTES =
    32 + KEM_CIPHERTEXT_BYTES + 24 + REPORT_KEY_BYTES + 32 + 16; // ephemeral key, ciphertext, nonce, key, digest, tag

export type ReportSuite = 1 | 2;

const REPORT_KEY_INFO = 'hushos/drive/report-key/v2';

export type ReportContext = {
    workspaceId: string;
    nodeId: string;
    keyEpoch: number;
    reportId: string;
    operatorUserId: string;
};

/* The operator as the reporter sees them: the X25519 key, and the KEM key when they have one. */
export type OperatorKeys = {
    encryptionPublicKey: Uint8Array;
    kemPublicKey: Uint8Array | null;
};
/* The operator's own halves. */
export type OperatorSecrets = {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
    kemSecretKey: Uint8Array | null;
};

/* The suite an envelope was sealed under, from its length; anything else is refused. */
export function reportSuite(envelope: Uint8Array): ReportSuite {
    if (envelope.length === REPORT_ENVELOPE_BYTES) return 1;
    if (envelope.length === HYBRID_REPORT_ENVELOPE_BYTES) return 2;
    throw new CryptoError('Invalid report envelope.');
}

export function reportContext(ctx: ReportContext, suite: ReportSuite = 1) {
    return new TextEncoder().encode(
        JSON.stringify([
            'hushos/drive/report',
            suite,
            ctx.workspaceId.toLowerCase(),
            ctx.nodeId.toLowerCase(),
            ctx.keyEpoch,
            ctx.reportId.toLowerCase(),
            ctx.operatorUserId.toLowerCase(),
        ]),
    );
}

async function contextDigest(ctx: ReportContext, suite: ReportSuite) {
    await sodium.ready;
    return sodium.crypto_generichash(
        32,
        reportContext(ctx, suite),
        null,
    ) as Uint8Array<ArrayBuffer>;
}

function pairKey(theirPublicKey: Uint8Array, myPrivateKey: Uint8Array) {
    if (theirPublicKey.length !== 32 || myPrivateKey.length !== 32)
        throw new CryptoError('Invalid operator key.');
    try {
        return sodium.crypto_box_beforenm(theirPublicKey, myPrivateKey) as Uint8Array<ArrayBuffer>;
    } catch {
        throw new CryptoError('Invalid operator key.');
    }
}

export async function sealReportKey(
    nodeKey: Uint8Array,
    operator: OperatorKeys,
    ctx: ReportContext,
) {
    await sodium.ready;
    if (nodeKey.length !== REPORT_KEY_BYTES) throw new CryptoError('Invalid node key.');
    if (operator.encryptionPublicKey.length !== 32) throw new CryptoError('Invalid operator key.');
    const suite: ReportSuite = operator.kemPublicKey ? 2 : 1;
    const plaintext = new Uint8Array(REPORT_KEY_BYTES + 32);
    plaintext.set(nodeKey);
    plaintext.set(await contextDigest(ctx, suite), REPORT_KEY_BYTES);
    try {
        if (suite === 1) {
            try {
                return new Uint8Array(
                    sodium.crypto_box_seal(plaintext, operator.encryptionPublicKey),
                );
            } catch {
                throw new CryptoError('Invalid operator key.');
            }
        }
        if (operator.kemPublicKey!.length !== KEM_PUBLIC_KEY_BYTES)
            throw new CryptoError('Invalid operator key.');
        const ephemeral = sodium.crypto_box_keypair();
        const pair = pairKey(operator.encryptionPublicKey, ephemeral.privateKey);
        ephemeral.privateKey.fill(0);
        try {
            const { ciphertext, sharedSecret } = kemEncapsulate(operator.kemPublicKey!);
            const key = await hybridKey(pair, sharedSecret, ciphertext, REPORT_KEY_INFO);
            sharedSecret.fill(0);
            try {
                const nonce = sodium.randombytes_buf(24);
                const body = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
                    plaintext,
                    reportContext(ctx, 2),
                    null,
                    nonce,
                    key,
                );
                const envelope = new Uint8Array(HYBRID_REPORT_ENVELOPE_BYTES);
                envelope.set(ephemeral.publicKey);
                envelope.set(ciphertext, 32);
                envelope.set(nonce, 32 + KEM_CIPHERTEXT_BYTES);
                envelope.set(body, 32 + KEM_CIPHERTEXT_BYTES + 24);
                return envelope;
            } finally {
                key.fill(0);
            }
        } finally {
            pair.fill(0);
        }
    } finally {
        plaintext.fill(0);
    }
}

export async function openReportKey(
    envelope: Uint8Array,
    operator: OperatorSecrets,
    ctx: ReportContext,
) {
    await sodium.ready;
    const suite = reportSuite(envelope);
    let plaintext: Uint8Array;
    if (suite === 1) {
        try {
            plaintext = sodium.crypto_box_seal_open(
                envelope,
                operator.publicKey,
                operator.privateKey,
            );
        } catch {
            throw new CryptoError('This report was not sealed to your operator key.');
        }
    } else {
        if (!operator.kemSecretKey || operator.kemSecretKey.length !== KEM_SECRET_KEY_BYTES)
            throw new CryptoError(
                'This report was sealed to a key this account does not hold yet. Unlock again and retry.',
            );
        const ciphertext = envelope.subarray(32, 32 + KEM_CIPHERTEXT_BYTES);
        const nonce = envelope.subarray(32 + KEM_CIPHERTEXT_BYTES, 32 + KEM_CIPHERTEXT_BYTES + 24);
        const body = envelope.subarray(32 + KEM_CIPHERTEXT_BYTES + 24);
        const pair = pairKey(envelope.subarray(0, 32), operator.privateKey);
        try {
            const sharedSecret = kemDecapsulate(ciphertext, operator.kemSecretKey);
            const key = await hybridKey(pair, sharedSecret, ciphertext, REPORT_KEY_INFO);
            sharedSecret.fill(0);
            try {
                plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                    null,
                    body,
                    reportContext(ctx, 2),
                    nonce,
                    key,
                );
            } catch {
                throw new CryptoError('This report was not sealed to your operator key.');
            } finally {
                key.fill(0);
            }
        } finally {
            pair.fill(0);
        }
    }
    try {
        const digest = await contextDigest(ctx, suite);
        if (!sodium.memcmp(plaintext.subarray(REPORT_KEY_BYTES), digest))
            throw new CryptoError('This report envelope belongs to a different report.');
        return plaintext.slice(0, REPORT_KEY_BYTES) as Uint8Array<ArrayBuffer>;
    } finally {
        plaintext.fill(0);
    }
}
