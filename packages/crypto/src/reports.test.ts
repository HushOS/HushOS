import sodium from 'libsodium-wrappers';
import { describe, expect, test } from 'vitest';
import { REPORT_ENVELOPE_BYTES, openReportKey, sealReportKey } from './reports';
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
    test('open for the operator and the report they were sealed for, and for nothing else', async () => {
        await sodium.ready;
        const operator = sodium.crypto_box_keypair();
        const other = sodium.crypto_box_keypair();
        const nodeKey = crypto.getRandomValues(new Uint8Array(32));
        const envelope = await sealReportKey(nodeKey, operator.publicKey, ctx);
        expect(envelope).toHaveLength(REPORT_ENVELOPE_BYTES);
        expect(await openReportKey(envelope, operator.publicKey, operator.privateKey, ctx)).toEqual(
            nodeKey,
        );
        // Two seals of the same key differ: the box carries a fresh ephemeral key each time.
        expect(await sealReportKey(nodeKey, operator.publicKey, ctx)).not.toEqual(envelope);

        await expect(
            openReportKey(envelope, other.publicKey, other.privateKey, ctx),
        ).rejects.toThrow(/not sealed to your operator key/);
        await expect(
            openReportKey(envelope, operator.publicKey, operator.privateKey, {
                ...ctx,
                reportId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            }),
        ).rejects.toThrow(/different report/);
        await expect(
            openReportKey(envelope, operator.publicKey, operator.privateKey, {
                ...ctx,
                operatorUserId: ctx.reportId,
            }),
        ).rejects.toThrow(/different report/);
        const tampered = envelope.slice();
        tampered[60] = tampered[60]! ^ 1;
        await expect(
            openReportKey(tampered, operator.publicKey, operator.privateKey, ctx),
        ).rejects.toThrow(/not sealed/);
        await expect(
            openReportKey(envelope.subarray(1), operator.publicKey, operator.privateKey, ctx),
        ).rejects.toThrow(/Invalid report envelope/);
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
