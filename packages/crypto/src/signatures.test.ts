import { createHash } from 'node:crypto';
import sodium from 'libsodium-wrappers';
import { describe, expect, test } from 'vitest';
import { encode } from './keys';
import {
    integrityOf,
    metadataStatement,
    signStatement,
    successionStatement,
    verifyStatement,
    versionStatement,
} from './signatures';

/*
 * A writer's signature holds for the exact record it was made over and for
 * nothing near it: another envelope, version, node, kind or statement kind
 * fails, and a reader with nobody to check it against says so instead of
 * calling it good.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const NODE = '22222222-2222-4222-8222-222222222222';
const VERSION = '33333333-3333-4333-8333-333333333333';
const OBJECT = '44444444-4444-4444-8444-444444444444';

async function keyPair() {
    await sodium.ready;
    const pair = sodium.crypto_sign_keypair();
    return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}
const sha = (bytes: Uint8Array) =>
    encode(new Uint8Array(createHash('sha256').update(bytes).digest()));

describe('statements', () => {
    test('are the canonical JSON arrays the design fixes, ids lowercased', async () => {
        const envelope = crypto.getRandomValues(new Uint8Array(296));
        const metadata = await metadataStatement(
            { workspaceId: WS.toUpperCase(), nodeId: NODE, kind: 'file', metadataVersion: 4 },
            envelope,
        );
        expect(new TextDecoder().decode(metadata)).toBe(
            `["hushos/drive/sig/metadata",1,"${WS}","${NODE}","file",4,"${sha(envelope)}"]`,
        );
        const version = await versionStatement(
            {
                workspaceId: WS,
                nodeId: NODE,
                versionId: VERSION,
                objectId: OBJECT,
                contentSuite: 3,
            },
            envelope,
        );
        expect(new TextDecoder().decode(version)).toBe(
            `["hushos/drive/sig/version",1,"${WS}","${NODE}","${VERSION}","${OBJECT}",3,"${sha(envelope)}"]`,
        );
    });

    test('refuse what no writer signs', async () => {
        const envelope = new Uint8Array(10);
        await expect(
            metadataStatement(
                { workspaceId: WS, nodeId: NODE, kind: 'link' as 'file', metadataVersion: 1 },
                envelope,
            ),
        ).rejects.toThrow('Invalid node kind');
        await expect(
            metadataStatement(
                { workspaceId: WS, nodeId: NODE, kind: 'file', metadataVersion: 0 },
                envelope,
            ),
        ).rejects.toThrow('Invalid metadata version');
        await expect(
            versionStatement(
                {
                    workspaceId: '',
                    nodeId: NODE,
                    versionId: VERSION,
                    objectId: OBJECT,
                    contentSuite: 3,
                },
                envelope,
            ),
        ).rejects.toThrow('Invalid workspace id');
        const keys = await keyPair();
        const key = encode(keys.publicKey);
        const link = {
            userId: NODE,
            oldKeyVersion: 2,
            newKeyVersion: 4,
            oldEncryptionPublicKey: key,
            oldSigningPublicKey: key,
            newEncryptionPublicKey: key,
            newSigningPublicKey: key,
            newKemPublicKey: encode(new Uint8Array(1184)),
        };
        await expect(successionStatement(link)).rejects.toThrow('Invalid key version');
        await expect(
            successionStatement({ ...link, newKeyVersion: 3, newKemPublicKey: key }),
        ).rejects.toThrow();
    });
});

describe('signatures', () => {
    const ctx = { workspaceId: WS, nodeId: NODE, kind: 'folder' as const, metadataVersion: 2 };

    test('verify for the signer over the record they signed, and fail for anything near it', async () => {
        const writer = await keyPair();
        const stranger = await keyPair();
        const envelope = crypto.getRandomValues(new Uint8Array(296));
        const statement = await metadataStatement(ctx, envelope);
        const signature = await signStatement(statement, writer.privateKey);
        expect(signature).toHaveLength(64);
        expect(await verifyStatement(statement, signature, writer.publicKey)).toBe(true);
        // Another signer's key.
        expect(await verifyStatement(statement, signature, stranger.publicKey)).toBe(false);
        // The envelope swapped for one the server or a key holder sealed.
        const swapped = envelope.slice();
        swapped[30]! ^= 1;
        const near = [
            await metadataStatement(ctx, swapped),
            // Replayed at the next metadata version, or onto another node.
            await metadataStatement({ ...ctx, metadataVersion: 3 }, envelope),
            await metadataStatement({ ...ctx, nodeId: VERSION }, envelope),
            // A folder's name passed off as a file's.
            await metadataStatement({ ...ctx, kind: 'file' }, envelope),
            // The same bytes as a version's content-key envelope.
            await versionStatement(
                {
                    workspaceId: WS,
                    nodeId: NODE,
                    versionId: VERSION,
                    objectId: OBJECT,
                    contentSuite: 2,
                },
                envelope,
            ),
        ];
        for (const other of near)
            expect(await verifyStatement(other, signature, writer.publicKey)).toBe(false);
        // A flipped bit of the signature, or one of the wrong length, is no signature.
        const flipped = signature.slice();
        flipped[0]! ^= 1;
        expect(await verifyStatement(statement, flipped, writer.publicKey)).toBe(false);
        expect(await verifyStatement(statement, signature.subarray(1), writer.publicKey)).toBe(
            false,
        );
        expect(await verifyStatement(statement, signature, new Uint8Array(32))).toBe(false);
        await expect(signStatement(statement, writer.publicKey)).rejects.toThrow(
            'Invalid signing key',
        );
    });

    test('a version signature names the object, so it cannot vouch for a version pointed elsewhere', async () => {
        const writer = await keyPair();
        const envelope = crypto.getRandomValues(new Uint8Array(84));
        const ctx = {
            workspaceId: WS,
            nodeId: NODE,
            versionId: VERSION,
            objectId: OBJECT,
            contentSuite: 3,
        };
        const signature = await signStatement(
            await versionStatement(ctx, envelope),
            writer.privateKey,
        );
        for (const change of [{ objectId: NODE }, { versionId: NODE }, { contentSuite: 2 }])
            expect(
                await verifyStatement(
                    await versionStatement({ ...ctx, ...change }, envelope),
                    signature,
                    writer.publicKey,
                ),
            ).toBe(false);
    });

    test("a reader's verdict: unsigned, unknown signer, bad signature, or verified by any trusted key", async () => {
        const earlier = await keyPair();
        const current = await keyPair();
        const envelope = new Uint8Array(296).fill(3);
        const statement = () => metadataStatement(ctx, envelope);
        const signature = await signStatement(await statement(), earlier.privateKey);
        expect(await integrityOf(statement, null, [current.publicKey])).toBe('unsigned');
        expect(await integrityOf(statement, signature, undefined)).toBe('unknown-signer');
        expect(await integrityOf(statement, signature, [])).toBe('unknown-signer');
        expect(await integrityOf(statement, signature, [current.publicKey])).toBe('bad-signature');
        // A record made before a succession verifies against the earlier key the chain vouched for.
        expect(
            await integrityOf(statement, signature, [current.publicKey, earlier.publicKey]),
        ).toBe('verified');
        // A statement that cannot be built (a damaged row) is not a good signature.
        expect(
            await integrityOf(() => Promise.reject(new Error('damaged')), signature, [
                earlier.publicKey,
            ]),
        ).toBe('bad-signature');
    });
});
