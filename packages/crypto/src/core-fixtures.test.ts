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
    openIdentityMlDsaKey,
    openIdentitySigningKey,
    publicIdentity,
    verifyIdentityKeys,
    verifyOwnIdentity,
    verifySuccessionChain,
    verifySuccessionLink,
    type IdentityEnvelope,
} from './identity';
import { fingerprint, fingerprintOfKeys, keyDigest } from './fingerprint';
import { pinVerified } from './pins';
import {
    integrityOf,
    keysStatement,
    successionStatement,
    metadataResealedStatement,
    metadataSavedStatement,
    metadataStatement,
    metadataStatements,
    verifyStatement,
    versionSavedStatement,
    versionStatement,
    versionStatements,
} from './signatures';
import { deriveId, type IdKind } from './ids';
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
        // A version 1 operator, sealed to the KEM key the server served: opens with that identity's keys.
        const legacy = web.upgrade.legacy as never;
        const legacyOperator = {
            publicKey: decode(web.upgrade.legacy.encryptionPublicKey, 32),
            privateKey: await openIdentityEncryptionKey(root, web.account.userId, legacy),
            kemSecretKey: (await openIdentityKemKey(root, web.account.userId, legacy))!.secretKey,
        };
        expect(decode(report.legacyHybrid)).toHaveLength(1224);
        expect(
            await openReportKey(decode(report.legacyHybrid), legacyOperator, report.ctx),
        ).toEqual(decode(report.nodeKey, 32));
        await expect(
            openReportKey(decode(report.legacyHybrid), operator, report.ctx),
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
        const rotated = rotation.identity as IdentityEnvelope;
        const kem = await openIdentityKemKey(newRoot, rotation.userId, rotated);
        expect(kem?.publicKey).toBe(web.share.identity.kem.publicKey);
        // The ML-DSA seed moved with the rest, and the keys statement still holds.
        const mlDsa = await openIdentityMlDsaKey(newRoot, rotation.userId, rotated);
        expect(mlDsa?.publicKey).toBe(web.share.identity.mlDsa.publicKey);
        await expect(verifyOwnIdentity(newRoot, rotation.userId, rotated)).resolves.toBeUndefined();
        expect(rotated.keysSignature).toBe(web.share.identity.keysSignature);
        await expect(openIdentityMlDsaKey(oldRoot, rotation.userId, rotated)).rejects.toThrow();
        await expect(
            openIdentityEncryptionKey(oldRoot, rotation.userId, rotation.identity as never),
        ).rejects.toThrow();
        // A rotation keeps the identity's own key version.
        expect(rotation.identity.keyVersion).toBe(web.share.identity.keyVersion);
        // A version 1 identity in the history moves too, still version 1.
        const legacy = rotation.legacyIdentity as IdentityEnvelope;
        expect(legacy.version).toBe(1);
        expect(await openIdentitySigningKey(newRoot, rotation.userId, legacy)).toEqual(
            await openIdentitySigningKey(oldRoot, rotation.userId, web.upgrade.legacy as never),
        );
    });

    it('opens a suite 4 share the core sealed and signed, and only from its signer', async () => {
        const { share } = core;
        const root = decode(web.account.accountKey, 32);
        const identity = web.share.identity as never;
        const privateKey = await openIdentityEncryptionKey(root, web.account.userId, identity);
        const kem = await openIdentityKemKey(root, web.account.userId, identity);
        const grantee = { privateKey, kemSecretKey: kem!.secretKey };
        const granter = {
            signingPublicKey: decode(share.granterSigningPublicKey, 32),
            mlDsaPublicKey: decode(share.granterMlDsaPublicKey, 1952),
        };
        const signed = decode(share.signed);
        expect(signed).toHaveLength(4565);
        expect(await openShareKey(signed, granter, grantee, share.ctx)).toEqual(
            decode(share.nodeKey, 32),
        );
        await expect(
            openShareKey(signed, granter, grantee, { ...share.ctx, keyEpoch: 10 }),
        ).rejects.toThrow('not signed');
        // Only from its signer: the grantee's own keys, or either of the granter's swapped.
        const own = {
            signingPublicKey: decode(web.share.identity.signingPublicKey, 32),
            mlDsaPublicKey: decode(web.share.identity.mlDsa.publicKey, 1952),
        };
        for (const other of [
            own,
            { ...granter, signingPublicKey: own.signingPublicKey },
            { ...granter, mlDsaPublicKey: own.mlDsaPublicKey },
        ])
            await expect(openShareKey(signed, other, grantee, share.ctx)).rejects.toThrow(
                'not signed',
            );
        // Cut to suite 3's length, it opens as nothing.
        await expect(
            openShareKey(signed.subarray(0, 1256), granter, grantee, share.ctx),
        ).rejects.toThrow('Invalid share envelope');
    });

    it('opens a version 2 identity the core made, all four keys, and its keys statement holds', async () => {
        const { identity } = core;
        const root = decode(identity.accountKey, 32);
        const envelope = identity.envelope as IdentityEnvelope;
        expect(envelope.version).toBe(2);
        await expect(verifyOwnIdentity(root, identity.userId, envelope)).resolves.toBeUndefined();
        expect((await openIdentityMlDsaKey(root, identity.userId, envelope))!.publicKey).toBe(
            envelope.mlDsa!.publicKey,
        );
        expect((await openIdentityKemKey(root, identity.userId, envelope))!.publicKey).toBe(
            envelope.kem!.publicKey,
        );
        expect(await verifyIdentityKeys(identity.userId, publicIdentity(envelope))).toBe(true);
        // It is the share's granter: the keys it signed the share with.
        expect(envelope.signingPublicKey).toBe(core.share.granterSigningPublicKey);
        expect(envelope.mlDsa!.publicKey).toBe(core.share.granterMlDsaPublicKey);
        await expect(
            verifyOwnIdentity(
                crypto.getRandomValues(new Uint8Array(32)),
                identity.userId,
                envelope,
            ),
        ).rejects.toThrow();
    });

    it('builds the core’s keys statement byte for byte and verifies its hybrid signature', async () => {
        const { keys } = core;
        const statement = await keysStatement({ userId: keys.userId, ...keys.identity });
        expect(statement).toEqual(decode(keys.statement));
        expect(await verifyIdentityKeys(keys.userId, keys.identity)).toBe(true);
        expect(await verifyIdentityKeys(web.account.userId, keys.identity)).toBe(false);
        const signature = decode(keys.identity.keysSignature);
        for (const at of [9, 64 + 9]) {
            const broken = signature.slice();
            broken[at]! ^= 1;
            expect(
                await verifyIdentityKeys(keys.userId, {
                    ...keys.identity,
                    keysSignature: Buffer.from(broken).toString('base64url'),
                }),
            ).toBe(false);
        }
    });

    it('opens the core’s upgrades of the web’s version 1 identities: the same keys, and an ML-DSA key', async () => {
        const { upgrade } = core;
        const root = decode(web.upgrade.accountKey, 32);
        for (const [from, to] of [
            ['legacy', 'upgraded'],
            ['legacyNoKem', 'upgradedNoKem'],
        ] as const) {
            const legacy = upgrade[from] as IdentityEnvelope;
            const upgraded = upgrade[to] as IdentityEnvelope;
            expect([legacy.version, upgraded.version]).toEqual([1, 2]);
            // The web's version 1 identity, as the core read it.
            expect(legacy.signingPublicKey).toBe(web.upgrade[from].signingPublicKey);
            expect(legacy.kem ?? null).toEqual(web.upgrade[from].kem ?? null);
            expect(upgraded.keyVersion).toBe(legacy.keyVersion);
            expect(upgraded.encryptionPublicKey).toBe(legacy.encryptionPublicKey);
            expect(upgraded.signingPublicKey).toBe(legacy.signingPublicKey);
            if (legacy.kem) expect(upgraded.kem!.publicKey).toBe(legacy.kem.publicKey);
            expect(upgraded.kem).not.toHaveProperty('signature');
            await expect(
                verifyOwnIdentity(root, upgrade.userId, upgraded),
            ).resolves.toBeUndefined();
            expect(await verifyIdentityKeys(upgrade.userId, publicIdentity(upgraded))).toBe(true);
            expect(await openIdentityEncryptionKey(root, upgrade.userId, upgraded)).toEqual(
                await openIdentityEncryptionKey(root, upgrade.userId, legacy),
            );
        }
    });

    it('agrees with the core on fingerprint version 3', async () => {
        const { fingerprints, identity } = core;
        const fill = (byte: number) => new Uint8Array(32).fill(byte);
        expect(fingerprints.vector).toBe('8b16 2a14 2a5b cb5b 1070 8017 ae93 b2e6 b496 7640');
        expect(await fingerprint(fill(1), fill(2), fill(3), fill(4))).toBe(fingerprints.vector);
        const envelope = identity.envelope as IdentityEnvelope;
        expect(
            await fingerprintOfKeys(
                decode(envelope.encryptionPublicKey, 32),
                decode(envelope.signingPublicKey, 32),
                decode(envelope.mlDsa!.publicKey, 1952),
                decode(envelope.kem!.publicKey, 1184),
            ),
        ).toBe(fingerprints.identity);
        // The version 3 pin the core wrote into its settings verifies here.
        const pin = Object.values(
            JSON.parse(core.settings.readJson).contacts as Record<string, never>,
        )[0]!;
        expect(await pinVerified(pin)).toBe(true);
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
        // The verdicts agree: ordinary is verified under the current key, re-sealed is only
        // re-sealed, and either under a key since replaced is a retired key.
        const current = { current: key, retired: [] };
        const replaced = {
            current: decode(web.share.identity.signingPublicKey, 32),
            retired: [key],
        };
        const metadataPair = () => metadataStatements(metadata, metadataEnvelope);
        const versionPair = () => versionStatements(version, versionEnvelope);
        const resealed = decode(signatures.metadata.resealed, 64);
        const versionResealed = decode(signatures.version.resealed, 64);
        expect(await integrityOf(metadataPair, signature, current)).toBe('verified');
        expect(await integrityOf(metadataPair, resealed, current)).toBe('resealed');
        expect(await integrityOf(versionPair, versionSignature, current)).toBe('verified');
        expect(await integrityOf(versionPair, versionResealed, current)).toBe('resealed');
        expect(await integrityOf(metadataPair, signature, replaced)).toBe('retired-key');
        expect(await integrityOf(versionPair, versionResealed, replaced)).toBe('retired-key');
        expect(
            await verifyStatement(
                await metadataStatement(metadata, metadataEnvelope),
                resealed,
                key,
            ),
        ).toBe(false);
    });

    it('reads the core’s saved signatures as saved, and as no other form', async () => {
        const { signatures } = core;
        const key = decode(signatures.signingPublicKey, 32);
        const metadata = {
            ...signatures.metadata.statement,
            kind: signatures.metadata.statement.kind as 'file',
        };
        const metadataEnvelope = decode(signatures.metadata.envelope);
        const saved = decode(signatures.metadata.saved, 64);
        expect(
            await verifyStatement(
                await metadataSavedStatement(metadata, metadataEnvelope),
                saved,
                key,
            ),
        ).toBe(true);
        for (const other of [
            await metadataStatement(metadata, metadataEnvelope),
            await metadataResealedStatement(metadata, metadataEnvelope),
        ])
            expect(await verifyStatement(other, saved, key)).toBe(false);
        expect(
            await verifyStatement(
                await metadataSavedStatement(metadata, metadataEnvelope),
                decode(signatures.metadata.resealed, 64),
                key,
            ),
        ).toBe(false);
        const current = { current: key, retired: [] };
        expect(
            await integrityOf(() => metadataStatements(metadata, metadataEnvelope), saved, current),
        ).toBe('saved-from-link');
        const version = signatures.version.statement;
        const versionEnvelope = decode(signatures.version.envelope, 84);
        const versionSaved = decode(signatures.version.saved, 64);
        expect(
            await verifyStatement(
                await versionSavedStatement(version, versionEnvelope),
                versionSaved,
                key,
            ),
        ).toBe(true);
        expect(
            await verifyStatement(
                await versionStatement(version, versionEnvelope),
                versionSaved,
                key,
            ),
        ).toBe(false);
        expect(
            await integrityOf(
                () => versionStatements(version, versionEnvelope),
                versionSaved,
                current,
            ),
        ).toBe('saved-from-link');
    });

    it('derives the core’s scoped ids from the same seeds and scopes', async () => {
        expect(core.ids).toHaveLength(15);
        for (const entry of core.ids)
            expect(await deriveId(entry.kind as IdKind, entry.scopeId, entry.seed)).toBe(entry.id);
    });

    it('accepts the core’s hybrid succession of this identity, and opens the successor under the root', async () => {
        const { succession } = core;
        const root = decode(web.account.accountKey, 32);
        const link = succession.link;
        const signer = {
            signingPublicKey: link.oldSigningPublicKey,
            mlDsaPublicKey: link.oldMlDsaPublicKey,
        };
        expect(await successionStatement({ ...link, userId: succession.userId })).toEqual(
            decode(succession.statement),
        );
        expect(decode(link.signature)).toHaveLength(3373);
        expect(await verifySuccessionLink(succession.userId, link, signer)).toBe(true);
        // Never under the keys the link brings in, and never with the Ed25519 half alone.
        expect(
            await verifySuccessionLink(succession.userId, link, {
                signingPublicKey: link.newSigningPublicKey,
                mlDsaPublicKey: link.newMlDsaPublicKey,
            }),
        ).toBe(false);
        const stripped = Buffer.from(decode(link.signature).subarray(0, 64)).toString('base64url');
        expect(
            await verifySuccessionLink(succession.userId, { ...link, signature: stripped }, signer),
        ).toBe(false);
        expect(succession.identity.keyVersion).toBe(web.share.identity.keyVersion + 1);
        expect(link.oldSigningPublicKey).toBe(web.share.identity.signingPublicKey);
        expect(link.oldMlDsaPublicKey).toBe(web.share.identity.mlDsa.publicKey);
        // The core's successor is the web's in every part: all four keys open and its keys statement holds.
        await expect(
            verifyOwnIdentity(root, succession.userId, succession.identity as never),
        ).resolves.toBeUndefined();
        const { chain } = succession;
        expect(chain.pinned.mlDsaPublicKeyHash).toBe(
            await keyDigest(decode(web.share.identity.mlDsa.publicKey)),
        );
        expect(
            await verifySuccessionChain(succession.userId, chain.pinned, chain.served, chain.links),
        ).toBe(true);
        expect(
            await verifySuccessionChain(
                succession.userId,
                chain.pinned,
                chain.served,
                chain.links.slice(1),
            ),
        ).toBe(false);
        expect(
            await verifySuccessionChain(
                succession.userId,
                chain.pinned,
                { ...chain.served, mlDsaPublicKey: link.newMlDsaPublicKey },
                chain.links,
            ),
        ).toBe(false);
    });

    it('opens version 2 settings the core sealed, and a settings key it made and rewrapped', async () => {
        const { settings, rotation } = core;
        const root = decode(web.account.accountKey, 32);
        const webKey = await openSettingsKey(root, web.settings.userId, web.settings.settingsKey);
        expect(settings.envelope.version).toBe(2);
        // The core read the document as version 1 and sealed it as version 2, as both must.
        const read = JSON.parse(settings.readJson);
        expect(read.version).toBe(1);
        expect(await openSettings(webKey, settings.userId, settings.envelope as never)).toEqual({
            ...read,
            version: 2,
        });
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
