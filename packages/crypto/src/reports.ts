import sodium from 'libsodium-wrappers';
import { CryptoError } from './errors';

/*
 * A report hands an operator the key to what was reported, and nobody else:
 * the reporter's device seals the node key to each operator's X25519 identity
 * key with a sealed box (the reporter may hold no account, so no sender key
 * is involved), and the report's context is bound in by a digest carried
 * inside the box that the opener checks. The server stores the sealed bodies
 * and, holding only public keys, can open none of them.
 */

export const REPORT_KEY_BYTES = 32;
export const REPORT_ENVELOPE_BYTES = 32 + 16 + REPORT_KEY_BYTES + 32; // ephemeral key, tag, key, digest

export type ReportContext = {
    workspaceId: string;
    nodeId: string;
    keyEpoch: number;
    reportId: string;
    operatorUserId: string;
};

export function reportContext(ctx: ReportContext) {
    return new TextEncoder().encode(
        JSON.stringify([
            'hushos/drive/report',
            1,
            ctx.workspaceId.toLowerCase(),
            ctx.nodeId.toLowerCase(),
            ctx.keyEpoch,
            ctx.reportId.toLowerCase(),
            ctx.operatorUserId.toLowerCase(),
        ]),
    );
}

async function contextDigest(ctx: ReportContext) {
    await sodium.ready;
    return sodium.crypto_generichash(32, reportContext(ctx), null) as Uint8Array<ArrayBuffer>;
}

export async function sealReportKey(
    nodeKey: Uint8Array,
    operatorPublicKey: Uint8Array,
    ctx: ReportContext,
) {
    await sodium.ready;
    if (nodeKey.length !== REPORT_KEY_BYTES) throw new CryptoError('Invalid node key.');
    if (operatorPublicKey.length !== 32) throw new CryptoError('Invalid operator key.');
    const plaintext = new Uint8Array(REPORT_KEY_BYTES + 32);
    plaintext.set(nodeKey);
    plaintext.set(await contextDigest(ctx), REPORT_KEY_BYTES);
    try {
        return new Uint8Array(sodium.crypto_box_seal(plaintext, operatorPublicKey));
    } catch {
        throw new CryptoError('Invalid operator key.');
    } finally {
        plaintext.fill(0);
    }
}

export async function openReportKey(
    envelope: Uint8Array,
    operatorPublicKey: Uint8Array,
    operatorPrivateKey: Uint8Array,
    ctx: ReportContext,
) {
    await sodium.ready;
    if (envelope.length !== REPORT_ENVELOPE_BYTES)
        throw new CryptoError('Invalid report envelope.');
    let plaintext: Uint8Array;
    try {
        plaintext = sodium.crypto_box_seal_open(envelope, operatorPublicKey, operatorPrivateKey);
    } catch {
        throw new CryptoError('This report was not sealed to your operator key.');
    }
    try {
        const digest = await contextDigest(ctx);
        if (!sodium.memcmp(plaintext.subarray(REPORT_KEY_BYTES), digest))
            throw new CryptoError('This report envelope belongs to a different report.');
        return plaintext.slice(0, REPORT_KEY_BYTES) as Uint8Array<ArrayBuffer>;
    } finally {
        plaintext.fill(0);
    }
}
