import { describe, expect, it } from 'vitest';
import { restoreAccountKey } from './device';
import {
    chunkCount,
    ciphertextSize,
    contentLength,
    decryptChunk,
    fileBytesOf,
    decryptThumbnail,
    openDocument,
    openMetadata,
    openNodeKey,
    openVersion,
} from './drive';
import { decryptKey } from './aead';
import { openLinkKey, openLinkSecret, passwordKey } from './links';
import { openRecovery, readRecoveryPhrase } from './recovery';
import { openReportKey } from './reports';
import {
    openIdentityEncryptionKey,
    openIdentityKemKey,
    openIdentitySigningKey,
    verifyKemBinding,
    verifySuccessionChain,
    verifySuccessionLink,
} from './identity';
import { metadataStatement, verifyStatement, versionStatement } from './signatures';
import { openWorkspaceKey } from './workspace';
import { openShareKey } from './shares';
import { openSettings, openSettingsKey } from './contacts';
import web from '../../../crates/hushos-core/fixtures/web.json';
import { decode, wrappingKey } from './keys';
import { accountKeyContext } from './protocol';
import core from './__fixtures__/core.json';

/* The file's bytes as the fixture writes them; an empty file is the empty string, which decode refuses. */
const fileOf = (value: string) => (value === '' ? new Uint8Array(0) : decode(value));

type VersionFixture = {
    ctx: {
        workspaceId: string;
        nodeId: string;
        versionId: string;
        objectId: string;
        suite: number;
    };
    contentKey: string;
    contentNonce: string;
    plaintextSize: number;
    thumbnailBytes: number;
    envelope: string;
    chunk: { index: number; chunkCount: number; plaintext: string; ciphertext: string };
    thumbnail: { plaintext: string; ciphertext: string } | null;
};

/*
 * Records sealed by the Rust core (crates/hushos-core/examples/fixtures.rs)
 * must open here; the other direction is crates/hushos-core/tests/web_fixtures.rs.
 * Regenerate both with `bun run fixtures` at the repository root.
 */
describe('records sealed by the Rust core', () => {
    it('opens an account key envelope the core sealed for a password change', async () => {
        const { envelope } = core.account;
        const wrap = await wrappingKey(core.account.exportKey, decode(envelope.wrappingSalt, 32));
        const opened = await decryptKey(
            decode(envelope.encryptedKey, 48),
            wrap,
            decode(envelope.wrappingNonce, 24),
            accountKeyContext(core.account.userId, envelope.keyVersion, envelope.credentialVersion),
        );
        expect(opened).toEqual(decode(core.account.accountKey, 32));
    });

    it('restores the account key from a device bundle the core made', async () => {
        const deviceKey = await crypto.subtle.importKey(
            'raw',
            decode(core.device.deviceKey, 32),
            'AES-GCM',
            false,
            ['decrypt'],
        );
        const bundle = { ...core.device.bundle, version: 1 as const };
        expect(await restoreAccountKey(bundle, deviceKey)).toEqual(
            decode(core.device.accountKey, 32),
        );
    });

    it('opens the node key and the metadata', async () => {
        const node = core.node;
        const nodeKey = await openNodeKey(
            decode(node.keyEnvelope, 72),
            decode(node.parentKey, 32),
            node.ctx,
        );
        expect(nodeKey).toEqual(decode(node.nodeKey, 32));
        const metadata = await openMetadata(
            decode(node.metadataEnvelope),
            nodeKey,
            node.metadataCtx,
        );
        expect(metadata).toEqual(node.metadata);
    });

    it('opens suite 3 versions with and without a thumbnail, and a suite 2 one, to the file', async () => {
        const node = core.node;
        const nodeKey = decode(node.nodeKey, 32);
        const versions = [node.version, node.bareVersion, node.emptyVersion, node.unpaddedVersion];
        expect(versions.map((version) => version.ctx.suite)).toEqual([3, 3, 3, 2]);
        for (const version of versions as VersionFixture[]) {
            const opened = await openVersion(decode(version.envelope, 84), nodeKey, version.ctx);
            expect(opened).toEqual({
                contentKey: decode(version.contentKey, 32),
                plaintextSize: version.plaintextSize,
                thumbnailBytes: version.thumbnailBytes,
            });
            const contentNonce = decode(version.contentNonce, 16);
            const { chunk } = version;
            const ctx = {
                workspaceId: version.ctx.workspaceId,
                objectId: version.ctx.objectId,
                suite: version.ctx.suite,
                index: chunk.index,
                chunkCount: chunk.chunkCount,
                plaintextSize: version.plaintextSize,
                thumbnailBytes: version.thumbnailBytes,
            };
            expect(chunk.chunkCount).toBe(
                chunkCount(contentLength(ctx.suite, ctx.plaintextSize, ctx.thumbnailBytes)),
            );
            const plaintext = await decryptChunk(
                decode(chunk.ciphertext),
                opened.contentKey,
                contentNonce,
                ctx,
            );
            expect(fileBytesOf(plaintext, version.plaintextSize, chunk.index)).toEqual(
                fileOf(chunk.plaintext),
            );
            // Under suite 3 what follows the file is zeros, and the suite is bound.
            expect(plaintext.subarray(fileOf(chunk.plaintext).length).every((b) => b === 0)).toBe(
                true,
            );
            if (ctx.suite === 3)
                await expect(
                    decryptChunk(decode(chunk.ciphertext), opened.contentKey, contentNonce, {
                        ...ctx,
                        suite: 2,
                    }),
                ).rejects.toThrow();
            if (version.thumbnail)
                expect(
                    await decryptThumbnail(
                        decode(version.thumbnail.ciphertext),
                        opened.contentKey,
                        contentNonce,
                        { ...ctx, thumbnailBytes: version.thumbnailBytes },
                    ),
                ).toEqual(decode(version.thumbnail.plaintext));
        }
        // Suite 2's kept chunk is the last of two: another index is another context.
        const unpadded = node.unpaddedVersion;
        await expect(
            decryptChunk(
                decode(unpadded.chunk.ciphertext),
                decode(unpadded.contentKey, 32),
                decode(unpadded.contentNonce, 16),
                {
                    ...unpadded.ctx,
                    index: 0,
                    chunkCount: 2,
                    plaintextSize: unpadded.plaintextSize,
                    thumbnailBytes: unpadded.thumbnailBytes,
                },
            ),
        ).rejects.toThrow();
    });

    it('agrees with the core on the layout of every suite and size', () => {
        expect(core.layouts.length).toBeGreaterThan(20);
        for (const row of core.layouts) {
            const length = contentLength(row.suite, row.plaintextSize, row.thumbnailBytes);
            expect([length, chunkCount(length)]).toEqual([row.contentLength, row.chunkCount]);
            expect(ciphertextSize(row.suite, row.plaintextSize, row.thumbnailBytes)).toBe(
                row.ciphertextSize,
            );
        }
    });

    it('opens a tags registry document the core sealed', async () => {
        const { document } = core;
        const opened = await openDocument(
            decode(document.envelope),
            decode(document.workspaceKey, 32),
            document.ctx,
        );
        expect(opened).toEqual(JSON.parse(document.json));
    });

    it('opens a password link the core made, as visitor and as owner', async () => {
        const { link } = core;
        const nodeKey = await openLinkKey(
            decode(link.envelope),
            decode(link.secret, 32),
            link.password,
            decode(link.salt, 16),
            link.ctx,
        );
        expect(nodeKey).toEqual(decode(link.nodeKey, 32));
        await expect(
            openLinkKey(
                decode(link.envelope),
                decode(link.secret, 32),
                null,
                decode(link.salt, 16),
                link.ctx,
            ),
        ).rejects.toThrow();
        const owned = await openLinkSecret(
            decode(link.secretEnvelope),
            decode(link.nodeKey, 32),
            link.ctx,
        );
        expect(owned.secret).toEqual(decode(link.secret, 32));
        expect(owned.token).toEqual(decode(link.token, 32));
        expect(owned.fromPassword).toEqual(await passwordKey(link.password, decode(link.salt, 16)));
    });

    it('accepts the recovery phrase the core made and reads it back', async () => {
        const { recovery } = core;
        const opened = await openRecovery(
            recovery.phrase,
            recovery.userId,
            recovery.envelope as never,
        );
        expect(opened.accountKey).toEqual(decode(recovery.accountKey, 32));
        expect(
            await readRecoveryPhrase(
                decode(recovery.accountKey, 32),
                recovery.userId,
                recovery.envelope as never,
            ),
        ).toBe(recovery.phrase);
    });

    it('opens a hybrid report key the core sealed to this identity', async () => {
        const { report } = core;
        const root = decode(web.account.accountKey, 32);
        const identity = web.share.identity as never;
        const privateKey = await openIdentityEncryptionKey(root, web.account.userId, identity);
        const kem = await openIdentityKemKey(root, web.account.userId, identity);
        const operator = {
            publicKey: decode(web.share.identity.encryptionPublicKey, 32),
            privateKey,
            kemSecretKey: kem!.secretKey,
        };
        expect(await openReportKey(decode(report.hybrid), operator, report.ctx)).toEqual(
            decode(report.nodeKey, 32),
        );
        await expect(
            openReportKey(decode(report.hybrid), operator, {
                ...report.ctx,
                reportId: crypto.randomUUID(),
            }),
        ).rejects.toThrow();
    });

    it('opens the grant and the identity the core rewrapped under a new root', async () => {
        const { rotation } = core;
        const newRoot = decode(rotation.newRoot, 32);
        expect(await openWorkspaceKey(newRoot, rotation.userId, rotation.grant as never)).toEqual(
            decode(rotation.workspaceKey, 32),
        );
        const oldRoot = decode(web.account.accountKey, 32);
        const before = await openIdentityEncryptionKey(
            oldRoot,
            rotation.userId,
            web.share.identity as never,
        );
        expect(
            await openIdentityEncryptionKey(newRoot, rotation.userId, rotation.identity as never),
        ).toEqual(before);
        const kem = await openIdentityKemKey(newRoot, rotation.userId, rotation.identity as never);
        expect(kem?.publicKey).toBe(web.share.identity.kem.publicKey);
        await expect(
            openIdentityEncryptionKey(oldRoot, rotation.userId, rotation.identity as never),
        ).rejects.toThrow();
        // A rotation keeps the identity's own key version.
        expect(rotation.identity.keyVersion).toBe(web.share.identity.keyVersion);
    });

    it('opens a suite 3 share the core sealed and signed, and only from its signer', async () => {
        const { share } = core;
        const root = decode(web.account.accountKey, 32);
        const identity = web.share.identity as never;
        const privateKey = await openIdentityEncryptionKey(root, web.account.userId, identity);
        const kem = await openIdentityKemKey(root, web.account.userId, identity);
        const grantee = { privateKey, kemSecretKey: kem!.secretKey };
        const granter = decode(share.granterSigningPublicKey, 32);
        expect(decode(share.signed)).toHaveLength(1256);
        expect(await openShareKey(decode(share.signed), granter, grantee, share.ctx)).toEqual(
            decode(share.nodeKey, 32),
        );
        await expect(
            openShareKey(decode(share.signed), granter, grantee, { ...share.ctx, keyEpoch: 10 }),
        ).rejects.toThrow('not signed');
        await expect(
            openShareKey(
                decode(share.signed),
                decode(web.share.identity.signingPublicKey, 32),
                grantee,
                share.ctx,
            ),
        ).rejects.toThrow('not signed');
    });

    it('verifies the core’s writer signatures, and nothing near them', async () => {
        const { signatures } = core;
        const key = decode(signatures.signingPublicKey, 32);
        const metadata = {
            ...signatures.metadata.statement,
            kind: signatures.metadata.statement.kind as 'file',
        };
        const metadataEnvelope = decode(signatures.metadata.envelope);
        const signature = decode(signatures.metadata.signature, 64);
        expect(
            await verifyStatement(
                await metadataStatement(metadata, metadataEnvelope),
                signature,
                key,
            ),
        ).toBe(true);
        expect(
            await verifyStatement(
                await metadataStatement({ ...metadata, kind: 'folder' }, metadataEnvelope),
                signature,
                key,
            ),
        ).toBe(false);
        const version = signatures.version.statement;
        const versionEnvelope = decode(signatures.version.envelope, 84);
        const versionSignature = decode(signatures.version.signature, 64);
        expect(
            await verifyStatement(
                await versionStatement(version, versionEnvelope),
                versionSignature,
                key,
            ),
        ).toBe(true);
        expect(
            await verifyStatement(
                await versionStatement({ ...version, contentSuite: 2 }, versionEnvelope),
                versionSignature,
                key,
            ),
        ).toBe(false);
    });

    it('accepts the core’s succession of this identity, and opens the successor under the root', async () => {
        const { succession } = core;
        const root = decode(web.account.accountKey, 32);
        expect(await verifySuccessionLink(succession.userId, succession.link)).toBe(true);
        expect(succession.identity.keyVersion).toBe(web.share.identity.keyVersion + 1);
        expect(succession.link.oldSigningPublicKey).toBe(web.share.identity.signingPublicKey);
        await expect(
            openIdentityEncryptionKey(root, succession.userId, succession.identity as never),
        ).resolves.toHaveLength(32);
        // The core's identity is the web's in every part: its signing key and KEM binding check.
        await expect(
            openIdentitySigningKey(root, succession.userId, succession.identity as never),
        ).resolves.toHaveLength(64);
        expect(
            await verifyKemBinding(
                succession.userId,
                succession.identity.encryptionPublicKey,
                succession.identity.signingPublicKey,
                succession.identity.kem,
            ),
        ).toBe(true);
        expect(
            await verifySuccessionChain(
                succession.userId,
                {
                    keyVersion: succession.link.oldKeyVersion,
                    encryptionPublicKey: succession.link.oldEncryptionPublicKey,
                    signingPublicKey: succession.link.oldSigningPublicKey,
                },
                {
                    keyVersion: succession.identity.keyVersion,
                    encryptionPublicKey: succession.identity.encryptionPublicKey,
                    signingPublicKey: succession.identity.signingPublicKey,
                    kemPublicKey: succession.identity.kem.publicKey,
                },
                [succession.link],
            ),
        ).toBe(true);
    });

    it('opens version 2 settings the core sealed, and a settings key it made and rewrapped', async () => {
        const { settings, rotation } = core;
        const root = decode(web.account.accountKey, 32);
        const webKey = await openSettingsKey(root, web.settings.userId, web.settings.settingsKey);
        expect(settings.envelope.version).toBe(2);
        expect(await openSettings(webKey, settings.userId, settings.envelope as never)).toEqual(
            JSON.parse(settings.json),
        );
        expect(await openSettingsKey(root, settings.userId, settings.settingsKey)).toEqual(
            decode(settings.settingsKeyRaw, 32),
        );
        // The rotation's settings key is the web's key, now under the new root only.
        const newRoot = decode(rotation.newRoot, 32);
        expect(await openSettingsKey(newRoot, rotation.userId, rotation.settingsKey)).toEqual(
            webKey,
        );
        await expect(
            openSettingsKey(root, rotation.userId, rotation.settingsKey),
        ).rejects.toThrow();
    });
});
