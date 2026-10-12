import sodium from 'libsodium-wrappers';
import { describe, expect, test } from 'vitest';
import {
    HYBRID_REPORT_ENVELOPE_BYTES,
    REPORT_ENVELOPE_BYTES,
    openReportKey,
    sealReportKey,
} from './reports';
import { KEM_SEED_BYTES, kemKeypair } from './pq';
import { createCryptoSession } from './session';

/*
 * A report's key opens for the operator it was sealed to, for the report it
 * was sealed for, and for nobody and nothing else. No reporter key is involved,
 * so a visitor with no account can file one.
 */

const ctx = {
    workspaceId: '22222222-2222-4222-8222-222222222222',
    nodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    keyEpoch: 7,
    reportId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    operatorUserId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};

describe('report envelopes', () => {
    const x25519 = (pair: { publicKey: Uint8Array; privateKey: Uint8Array }) => ({
        encryptionPublicKey: pair.publicKey,
        kemPublicKey: null,
    });
    const secrets = (
        pair: { publicKey: Uint8Array; privateKey: Uint8Array },
        kem: { secretKey: Uint8Array } | null = null,
    ) => ({
        publicKey: pair.publicKey,
        privateKey: pair.privateKey,
        kemSecretKey: kem?.secretKey ?? null,
    });

    test('an operator without a KEM key is sealed nothing: a classical seal is a harvest-now target', async () => {
        await sodium.ready;
        const operator = sodium.crypto_box_keypair();
        const nodeKey = crypto.getRandomValues(new Uint8Array(32));
        await expect(sealReportKey(nodeKey, x25519(operator), ctx)).rejects.toThrow(
            /no post-quantum key/,
        );
        expect(REPORT_ENVELOPE_BYTES).toBe(112);
    });

    test('suite 2: an operator with a KEM key gets a hybrid envelope that needs both private halves', async () => {
        await sodium.ready;
        const operator = sodium.crypto_box_keypair();
        const kem = kemKeypair(crypto.getRandomValues(new Uint8Array(KEM_SEED_BYTES)));
        const otherKem = kemKeypair(crypto.getRandomValues(new Uint8Array(KEM_SEED_BYTES)));
        const other = sodium.crypto_box_keypair();
        const nodeKey = crypto.getRandomValues(new Uint8Array(32));
        const keys = { encryptionPublicKey: operator.publicKey, kemPublicKey: kem.publicKey };
        const envelope = await sealReportKey(nodeKey, keys, ctx);
        expect(envelope).toHaveLength(HYBRID_REPORT_ENVELOPE_BYTES);
        expect(await openReportKey(envelope, secrets(operator, kem), ctx)).toEqual(nodeKey);
        expect(await sealReportKey(nodeKey, keys, ctx)).not.toEqual(envelope);

        // Either private half alone is not enough: the wrong X25519 key, or the wrong KEM key.
        await expect(openReportKey(envelope, secrets(other, kem), ctx)).rejects.toThrow(
            /not sealed to your operator key/,
        );
        await expect(openReportKey(envelope, secrets(operator, otherKem), ctx)).rejects.toThrow(
            /not sealed to your operator key/,
        );
        // An operator whose device has not minted its KEM secret yet is told so, not handed garbage.
        await expect(openReportKey(envelope, secrets(operator), ctx)).rejects.toThrow(
            /does not hold yet/,
        );
        // The context is bound: another report, another operator, a flipped ciphertext byte, a flipped body byte.
        await expect(
            openReportKey(envelope, secrets(operator, kem), {
                ...ctx,
                reportId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            }),
        ).rejects.toThrow(/not sealed to your operator key/);
        for (const at of [40, HYBRID_REPORT_ENVELOPE_BYTES - 5]) {
            const tampered = envelope.slice();
            tampered[at] = tampered[at]! ^ 1;
            await expect(openReportKey(tampered, secrets(operator, kem), ctx)).rejects.toThrow(
                /not sealed to your operator key/,
            );
        }
        // X25519 ignores the top bit, so this ephemeral key gives the same DH output; the
        // associated data carries the key itself, so the recoded envelope must not open.
        const recoded = envelope.slice();
        recoded[31] = recoded[31]! ^ 0x80;
        await expect(openReportKey(recoded, secrets(operator, kem), ctx)).rejects.toThrow(
            /not sealed to your operator key/,
        );
        // A bad KEM public key is refused before anything is sealed.
        await expect(
            sealReportKey(nodeKey, { ...keys, kemPublicKey: kem.publicKey.subarray(1) }, ctx),
        ).rejects.toThrow(/Invalid operator key/);
    });

    test('the worker refuses to open a report without the operator’s identity, and to seal a node it has not opened', async () => {
        const session = createCryptoSession();
        await expect(
            session.handle({
                id: 1,
                operation: 'driveOpenReport',
                input: { ...ctx, keyEnvelope: 'AA' },
            }),
        ).rejects.toThrow(/Open your identity first/);
        await expect(
            session.handle({
                id: 2,
                operation: 'driveSealReport',
                input: { ...ctx, operators: [] },
            }),
        ).rejects.toThrow(/Open the containing folder first/);
    });
});
