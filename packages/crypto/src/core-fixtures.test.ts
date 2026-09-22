import { describe, expect, it } from 'vitest';
import { restoreAccountKey } from './device';
import {
    chunkCount,
    CONTENT_SUITE,
    decryptChunk,
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
import { openIdentityEncryptionKey, openIdentityKemKey } from './identity';
import { openWorkspaceKey } from './workspace';
import { openShareKey } from './shares';
import { openSettings } from './contacts';
import web from '../../../crates/hushos-core/fixtures/web.json';
import { decode, wrappingKey } from './keys';
import { accountKeyContext } from './protocol';
import core from './__fixtures__/core.json';

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

    it('opens a suite 2 version, its last chunk and its thumbnail', async () => {
        const node = core.node;
        const version = node.version;
        const opened = await openVersion(
            decode(version.envelope, 84),
            decode(node.nodeKey, 32),
            version.ctx,
        );
        expect(opened).toEqual({
            contentKey: decode(version.contentKey, 32),
            plaintextSize: version.plaintextSize,
            thumbnailBytes: version.thumbnailBytes,
        });
        const contentNonce = decode(version.contentNonce, 16);
        const ctx = {
            workspaceId: version.ctx.workspaceId,
            objectId: version.ctx.objectId,
            suite: CONTENT_SUITE,
            index: version.lastChunk.index,
            chunkCount: chunkCount(version.plaintextSize),
            plaintextSize: version.plaintextSize,
        };
        expect(chunkCount(version.plaintextSize)).toBe(2);
        expect(
            await decryptChunk(
                decode(version.lastChunk.ciphertext),
                opened.contentKey,
                contentNonce,
                ctx,
            ),
        ).toEqual(decode(version.lastChunk.plaintext));
        await expect(
            decryptChunk(decode(version.lastChunk.ciphertext), opened.contentKey, contentNonce, {
                ...ctx,
                index: 0,
            }),
        ).rejects.toThrow();
        expect(
            await decryptThumbnail(
                decode(version.thumbnail.ciphertext),
                opened.contentKey,
                contentNonce,
                {
                    workspaceId: version.ctx.workspaceId,
                    objectId: version.ctx.objectId,
                    plaintextSize: version.plaintextSize,
                    thumbnailBytes: version.thumbnailBytes,
                },
            ),
        ).toEqual(decode(version.thumbnail.plaintext));
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

    it('opens an empty file the core sealed', async () => {
        const node = core.node;
        const plaintext = await decryptChunk(
            decode(node.emptyFile.ciphertext),
            decode(node.version.contentKey, 32),
            decode(node.version.contentNonce, 16),
            {
                workspaceId: node.version.ctx.workspaceId,
                objectId: node.emptyFile.objectId,
                suite: CONTENT_SUITE,
                index: 0,
                chunkCount: 1,
                plaintextSize: 0,
            },
        );
        expect(plaintext).toEqual(new Uint8Array(0));
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

    it('opens a report key the core sealed to this identity, in both suites', async () => {
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
        expect(await openReportKey(decode(report.classic), operator, report.ctx)).toEqual(
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
    });

    it('opens shares the core sealed to this identity, in both suites', async () => {
        const { share } = core;
        const root = decode(web.account.accountKey, 32);
        const identity = web.share.identity as never;
        const privateKey = await openIdentityEncryptionKey(root, web.account.userId, identity);
        const kem = await openIdentityKemKey(root, web.account.userId, identity);
        const grantee = { privateKey, kemSecretKey: kem!.secretKey };
        expect(
            await openShareKey(
                decode(share.classic),
                decode(share.granterPublicKey, 32),
                grantee,
                share.ctx,
            ),
        ).toEqual(decode(share.nodeKey, 32));
        expect(
            await openShareKey(
                decode(share.hybrid),
                decode(share.granterPublicKey, 32),
                grantee,
                share.ctx,
            ),
        ).toEqual(decode(share.nodeKey, 32));
        await expect(
            openShareKey(decode(share.hybrid), decode(share.granterPublicKey, 32), grantee, {
                ...share.ctx,
                keyEpoch: 10,
            }),
        ).rejects.toThrow();
    });

    it('opens a settings document the core sealed', async () => {
        const { settings } = core;
        const root = decode(web.account.accountKey, 32);
        const privateKey = await openIdentityEncryptionKey(
            root,
            web.account.userId,
            web.share.identity as never,
        );
        expect(await openSettings(privateKey, settings.userId, settings.envelope as never)).toEqual(
            JSON.parse(settings.json),
        );
    });
});
