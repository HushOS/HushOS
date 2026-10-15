import { mkdir, writeFile } from 'node:fs/promises';
import { encryptKey } from '../src/aead';
import { rememberAccountKey } from '../src/device';
import {
    CHUNK_SIZE,
    CONTENT_SUITE,
    chunkCount,
    chunkPlaintextLength,
    ciphertextSize,
    contentLength,
    encryptChunk,
    encryptThumbnail,
    LEGACY_CONTENT_SUITE,
    sealDocument,
    sealMetadata,
    sealVersion,
    UNPADDED_CONTENT_SUITE,
    wrapContentKey,
    wrapNodeKey,
} from '../src/drive';
import sodium from 'libsodium-wrappers';
import {
    createIdentity,
    openIdentityMlDsaKey,
    publicIdentity,
    upgradeIdentity,
    type IdentityEnvelope,
} from '../src/identity';
import { decode, encode, wrappingKey } from '../src/keys';
import { sealShareKey, shareContext } from '../src/shares';
import { hybridKey, hybridKeyWithSalt } from '../src/hybrid';
import { kemEncapsulate } from '../src/pq';
import { fingerprint, fingerprintOfKeys, keyDigest } from '../src/fingerprint';
import {
    generateLinkSecret,
    generateLinkSalt,
    passwordKey,
    sealLinkKeyWith,
    sealLinkSecret,
} from '../src/links';
import { createRecovery } from '../src/recovery';
import { createSettingsKey, sealSettings } from '../src/contacts';
import {
    createSuccessor,
    openIdentityEncryptionKey,
    openIdentitySigningKey,
} from '../src/identity';
import {
    digest,
    keysStatement,
    metadataResealedStatement,
    metadataSavedStatement,
    metadataStatement,
    signStatement,
    successionStatement,
    versionResealedStatement,
    versionSavedStatement,
    versionStatement,
} from '../src/signatures';
import { deriveId, type IdKind } from '../src/ids';
import { accountKeyContext, ENVELOPE_VERSION } from '../src/protocol';
import { createWorkspaceGrant, openWorkspaceKey } from '../src/workspace';

/*
 * Records sealed by the web's code for the Rust core to open, so the two
 * implementations cannot drift apart unnoticed. Regenerate with
 * `bun run --cwd packages/crypto fixtures:core`; the Rust test
 * `crates/hushos-core/tests/web_fixtures.rs` reads the result.
 */
const bytes = (length: number, seed: number) =>
    Uint8Array.from({ length }, (_, i) => (i * 31 + seed * 7 + ((i * seed) >> 3)) & 0xff);
const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
const uuid = () => crypto.randomUUID();

const userId = uuid().toUpperCase();
const workspaceId = uuid();
const accountKey = random(32);

// Account key under the OPAQUE export key, as registration seals it.
const exportKey = encode(random(64));
const salt = random(32);
const nonce = random(24);
const wrap = await wrappingKey(exportKey, salt);
const account = {
    userId,
    exportKey,
    envelope: {
        envelopeVersion: ENVELOPE_VERSION,
        keyVersion: 2,
        credentialVersion: 3,
        wrappingSalt: encode(salt),
        wrappingNonce: encode(nonce),
        encryptedKey: encode(
            await encryptKey(accountKey, wrap, nonce, accountKeyContext(userId, 2, 3)),
        ),
    },
    accountKey: encode(accountKey),
};

// The account key remembered under a device key (AES-GCM), as the app stores it.
const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
]);
const bundle = await rememberAccountKey(accountKey, deviceKey, {
    userId,
    keyVersion: 2,
    credentialVersion: 3,
    deviceKeyId: uuid(),
});
const device = {
    bundle,
    deviceKey: encode(new Uint8Array(await crypto.subtle.exportKey('raw', deviceKey))),
    accountKey: encode(accountKey),
};

// A workspace grant and the key it holds.
const grant = await createWorkspaceGrant(accountKey, userId, workspaceId, 2);
const workspaceKey = await openWorkspaceKey(accountKey, userId, grant);
const workspace = {
    userId,
    accountKey: encode(accountKey),
    grant,
    workspaceKey: encode(workspaceKey),
};

// A node under the root, its metadata, suite 3 versions with and without a thumbnail, a suite 2
// version and a suite 1 version.
const nodeId = uuid();
const nodeKey = random(32);
const nodeCtx = { workspaceId, nodeId, parentId: uuid(), parentKeyEpoch: 4, keyEpoch: 9 };
const metadata = {
    name: 'Quarterly report — final.pdf',
    mime: 'application/pdf',
    size: 8_388_613,
    modified: '2026-09-22T10:00:00.000Z',
};
const metadataCtx = { workspaceId, nodeId, metadataVersion: 3 };
const contentKey = random(32);
const contentNonce = random(16);

/*
 * One version of `plaintextSize` bytes in `suite`, sealed under the node key,
 * keeping only chunk `index` (the file's bytes for it, padded under suite 3 as
 * the uploader pads them) and the thumbnail trailer when there is one.
 */
async function version(
    suite: number,
    plaintextSize: number,
    thumbnail: Uint8Array | null,
    index: number,
) {
    const objectId = uuid();
    const versionId = uuid();
    const thumbnailBytes = thumbnail?.length ?? 0;
    const ctx = { workspaceId, nodeId, versionId, objectId, suite };
    const length = contentLength(suite, plaintextSize, thumbnailBytes);
    const file = bytes(Math.max(0, Math.min(CHUNK_SIZE, plaintextSize - index * CHUNK_SIZE)), 9);
    const padded = new Uint8Array(chunkPlaintextLength(length, index));
    padded.set(file);
    return {
        ctx,
        contentKey: encode(contentKey),
        contentNonce: encode(contentNonce),
        plaintextSize,
        thumbnailBytes,
        envelope: encode(
            await sealVersion({ contentKey, plaintextSize, thumbnailBytes }, nodeKey, ctx),
        ),
        // The chunk opens to the file's bytes for its index; the padding is dropped.
        chunk: {
            index,
            chunkCount: chunkCount(length),
            plaintext: encode(file),
            ciphertext: encode(
                await encryptChunk(padded, contentKey, contentNonce, {
                    workspaceId,
                    objectId,
                    suite,
                    index,
                    chunkCount: chunkCount(length),
                    plaintextSize,
                    thumbnailBytes,
                }),
            ),
        },
        thumbnail: thumbnail
            ? {
                  plaintext: encode(thumbnail),
                  ciphertext: encode(
                      await encryptThumbnail(thumbnail, contentKey, contentNonce, {
                          workspaceId,
                          objectId,
                          suite,
                          plaintextSize,
                      }),
                  ),
              }
            : null,
    };
}
const legacyVersionId = uuid();
const legacyObjectId = uuid();
const node = {
    ctx: nodeCtx,
    parentKey: encode(workspaceKey),
    nodeKey: encode(nodeKey),
    keyEnvelope: encode(await wrapNodeKey(nodeKey, workspaceKey, nodeCtx)),
    metadata,
    metadataCtx,
    metadataEnvelope: encode(await sealMetadata(metadata, nodeKey, metadataCtx)),
    // Suite 3 with a thumbnail, one chunk of file and zeros.
    version: await version(CONTENT_SUITE, 1000, bytes(300, 5), 0),
    // Suite 3 without one; and an empty file, the smallest bucket.
    bareVersion: await version(CONTENT_SUITE, 5, null, 0),
    emptyVersion: await version(CONTENT_SUITE, 0, null, 0),
    // Suite 2, read and never written: its last, five-byte chunk binds index 1 of 2 and the size.
    unpaddedVersion: await version(UNPADDED_CONTENT_SUITE, CHUNK_SIZE + 5, bytes(300, 5), 1),
    legacyVersion: {
        ctx: {
            workspaceId,
            nodeId,
            versionId: legacyVersionId,
            objectId: legacyObjectId,
            suite: LEGACY_CONTENT_SUITE,
        },
        contentKey: encode(contentKey),
        rowSize: 77,
        envelope: encode(
            await wrapContentKey(contentKey, nodeKey, {
                workspaceId,
                nodeId,
                versionId: legacyVersionId,
                objectId: legacyObjectId,
            }),
        ),
    },
};

// The layout arithmetic both sides must agree on, at sizes too large to seal here.
const layouts = [0, 1, 256, 257, 1000, CHUNK_SIZE - 20, CHUNK_SIZE, CHUNK_SIZE + 1, 3e9, 2 ** 40]
    .flatMap((plaintextSize) =>
        [0, 300, 65_536].map((thumbnailBytes) => [plaintextSize, thumbnailBytes]),
    )
    .flatMap(([plaintextSize, thumbnailBytes]) =>
        [UNPADDED_CONTENT_SUITE, CONTENT_SUITE].map((suite) => {
            const length = contentLength(suite, plaintextSize!, thumbnailBytes!);
            return {
                suite,
                plaintextSize: plaintextSize!,
                thumbnailBytes: thumbnailBytes!,
                contentLength: length,
                chunkCount: chunkCount(length),
                ciphertextSize: ciphertextSize(suite, plaintextSize!, thumbnailBytes!),
            };
        }),
    );

// The tags registry, a workspace document sealed under the workspace key.
const registry = {
    version: 2,
    tags: [{ id: uuid(), name: 'Tax', colour: 'blue' }],
    items: {} as Record<string, string[]>,
};
registry.items[registry.tags[0]!.id] = [nodeId];
const document = {
    ctx: { workspaceId, kind: 'tags', version: 3 },
    workspaceKey: encode(workspaceKey),
    json: JSON.stringify(registry),
    envelope: encode(
        await sealDocument(registry, workspaceKey, { workspaceId, kind: 'tags', version: 3 }),
    ),
};

// The grantee's identity under the account key (version 2), and a node key shared to it in suite 4 by
// a granter with a version 2 identity of its own; and genuine suites 1, 2 and 3, refused everywhere now.
await sodium.ready;
const identity = await createIdentity(accountKey, userId, 2);
const granter = sodium.crypto_box_keypair();
const granterRoot = random(32);
const granterUserId = uuid();
const granterIdentity = await createIdentity(granterRoot, granterUserId, 1);
const granterKeys = {
    signingKey: await openIdentitySigningKey(granterRoot, granterUserId, granterIdentity),
    mlDsaSecretKey: (await openIdentityMlDsaKey(granterRoot, granterUserId, granterIdentity))!
        .secretKey,
};
const shareCtx = {
    workspaceId: uuid(),
    nodeId: uuid(),
    keyEpoch: 5,
    granteeUserId: userId,
    granterUserId,
};
const sharedNodeKey = random(32);
const grantee = {
    encryptionPublicKey: decode(identity.encryptionPublicKey, 32),
    kemPublicKey: identity.kem ? decode(identity.kem.publicKey, 1184) : null,
};
const share = {
    identity,
    granterPublicKey: encode(granter.publicKey),
    ctx: shareCtx,
    nodeKey: encode(sharedNodeKey),
    // Suite 1, as clients made them before shares went hybrid: genuine, and refused everywhere now.
    classic: encode(
        await (async () => {
            const pair = sodium.crypto_box_beforenm(
                grantee.encryptionPublicKey,
                granter.privateKey,
            );
            const nonce = random(24);
            const body = await encryptKey(
                sharedNodeKey,
                pair,
                nonce,
                shareContext(shareCtx, 1 as never),
            );
            return new Uint8Array([...nonce, ...body]);
        })(),
    ),
    // Suite 2, the static pair key with ML-KEM beside it, as made before shares were signed: refused too.
    hybrid: encode(
        await (async () => {
            const pair = sodium.crypto_box_beforenm(
                grantee.encryptionPublicKey,
                granter.privateKey,
            ) as Uint8Array<ArrayBuffer>;
            const { ciphertext, sharedSecret } = kemEncapsulate(grantee.kemPublicKey!);
            const key = await hybridKey(
                pair,
                sharedSecret,
                ciphertext,
                'hushos/drive/share-key/v2',
            );
            const nonce = random(24);
            const body = await encryptKey(
                sharedNodeKey,
                key,
                nonce,
                shareContext(shareCtx, 2 as never),
            );
            return new Uint8Array([...nonce, ...ciphertext, ...body]);
        })(),
    ),
    // Suite 3, as clients sealed it before this release: suite 4's layout with an Ed25519
    // signature alone, by the same granter. Genuine, and refused.
    suite3: encode(
        await (async () => {
            const ephemeral = sodium.crypto_box_keypair();
            const dh = sodium.crypto_scalarmult(ephemeral.privateKey, grantee.encryptionPublicKey);
            const { ciphertext, sharedSecret } = kemEncapsulate(grantee.kemPublicKey!);
            const salt = new Uint8Array(
                await crypto.subtle.digest(
                    'SHA-256',
                    new Uint8Array([
                        ...ciphertext,
                        ...ephemeral.publicKey,
                        ...grantee.encryptionPublicKey,
                    ]),
                ),
            );
            const key = await hybridKeyWithSalt(
                dh,
                sharedSecret,
                salt,
                'hushos/drive/share-key/v3',
            );
            const nonce = random(24);
            const body = await encryptKey(
                sharedNodeKey,
                key,
                nonce,
                shareContext(shareCtx, 3 as never),
            );
            const sealed = new Uint8Array([
                ...ephemeral.publicKey,
                ...ciphertext,
                ...nonce,
                ...body,
            ]);
            const statement = new TextEncoder().encode(
                JSON.stringify([
                    'hushos/drive/sig/share',
                    3,
                    shareCtx.workspaceId,
                    shareCtx.nodeId,
                    shareCtx.keyEpoch,
                    shareCtx.granteeUserId.toLowerCase(),
                    shareCtx.granterUserId,
                    await digest(sealed),
                ]),
            );
            return new Uint8Array([
                ...sealed,
                ...(await signStatement(statement, granterKeys.signingKey)),
            ]);
        })(),
    ),
    // Suite 4: an ephemeral key and ML-KEM, with the granter's hybrid signature.
    granterSigningPublicKey: granterIdentity.signingPublicKey,
    granterMlDsaPublicKey: granterIdentity.mlDsa!.publicKey,
    signed: encode(await sealShareKey(sharedNodeKey, grantee, granterKeys, shareCtx)),
};

// A password link: what a visitor opens from the URL, and the owner's sealed copy of its secret.
const linkCtx = { workspaceId: uuid(), nodeId: uuid(), keyEpoch: 3, linkId: uuid() };
const linkNodeKey = random(32);
const linkSecret = generateLinkSecret();
const linkToken = random(32);
const linkSalt = generateLinkSalt();
const linkPassword = 'open sesame';
const fromPassword = await passwordKey(linkPassword, linkSalt);
const link = {
    ctx: linkCtx,
    nodeKey: encode(linkNodeKey),
    secret: encode(linkSecret),
    token: encode(linkToken),
    salt: encode(linkSalt),
    password: linkPassword,
    envelope: encode(await sealLinkKeyWith(linkNodeKey, linkSecret, fromPassword, linkCtx)),
    secretEnvelope: encode(
        await sealLinkSecret(linkSecret, linkToken, fromPassword, linkNodeKey, linkCtx),
    ),
};

// The recovery key: the envelope the server keeps and the phrase the person wrote down.
const recoveryMade = await createRecovery(accountKey, userId, 2, 2);
const recovery = {
    userId,
    accountKey: encode(accountKey),
    envelope: recoveryMade.recovery,
    phrase: recoveryMade.phrase,
};

// The settings document (contact pins): version 2 under the settings key wrapped under the root, and
// version 1, as sealed before the settings key, under a key off the identity's private key, which
// no longer opens anywhere (it reads as no settings).
const identityPrivateKey = await openIdentityEncryptionKey(accountKey, userId, identity);
// A version 3 pin, in a document read as version 1: sealing raises it to version 2.
const pinned = {
    encryptionPublicKey: random(32),
    signingPublicKey: random(32),
    mlDsaPublicKey: random(1952),
    kemPublicKey: random(1184),
};
const settingsJson = {
    version: 1 as const,
    contacts: {
        [uuid()]: {
            userId: uuid(),
            email: 'friend@example.com',
            name: 'Friend',
            encryptionPublicKey: encode(pinned.encryptionPublicKey),
            signingPublicKey: encode(pinned.signingPublicKey),
            mlDsaPublicKeyHash: await keyDigest(pinned.mlDsaPublicKey),
            kemPublicKeyHash: await keyDigest(pinned.kemPublicKey),
            fingerprint: await fingerprintOfKeys(
                pinned.encryptionPublicKey,
                pinned.signingPublicKey,
                pinned.mlDsaPublicKey,
                pinned.kemPublicKey,
            ),
            pinnedAt: '2026-10-15T00:00:00.000Z',
            keyVersion: 1,
        },
    },
};
const settingsKey = await createSettingsKey(accountKey, userId);
const settings = {
    userId,
    accountKey: encode(accountKey),
    identityPrivateKey: encode(identityPrivateKey),
    // What the version 2 envelope opens to: the document, always written as version 2.
    json: JSON.stringify({ ...settingsJson, version: 2 }),
    readJson: JSON.stringify(settingsJson),
    // Version 1: HKDF(identity private key, zeros, "hushos/settings/v1"), context version 1.
    envelope: await (async () => {
        const base = await crypto.subtle.importKey('raw', identityPrivateKey, 'HKDF', false, [
            'deriveBits',
        ]);
        const key = new Uint8Array(
            await crypto.subtle.deriveBits(
                {
                    name: 'HKDF',
                    hash: 'SHA-256',
                    salt: new Uint8Array(32),
                    info: new TextEncoder().encode('hushos/settings/v1'),
                },
                base,
                256,
            ),
        );
        const json = new TextEncoder().encode(JSON.stringify(settingsJson));
        const plaintext = new Uint8Array(Math.ceil(json.length / 1024) * 1024).fill(0x20);
        plaintext.set(json);
        const nonce = random(24);
        const aad = new TextEncoder().encode(
            JSON.stringify(['hushos/settings', 1, userId.toLowerCase(), 4]),
        );
        return {
            version: 1,
            settingsVersion: 4,
            nonce: encode(nonce),
            ciphertext: encode(await encryptKey(plaintext, key, nonce, aad)),
        };
    })(),
    settingsKey: settingsKey.envelope,
    settingsKeyRaw: encode(settingsKey.key),
    v2: await sealSettings(settingsKey.key, userId, 5, settingsJson),
};

// Writer signatures by the account's identity over the node's metadata and its suite 3 version.
const signingKey = await openIdentitySigningKey(accountKey, userId, identity);
const metadataSigned = { workspaceId, nodeId, kind: 'file' as const, metadataVersion: 3 };
const versionSigned = {
    workspaceId,
    nodeId,
    versionId: node.version.ctx.versionId,
    objectId: node.version.ctx.objectId,
    contentSuite: CONTENT_SUITE,
};
const signatures = {
    signingPublicKey: identity.signingPublicKey,
    metadata: {
        statement: metadataSigned,
        envelope: node.metadataEnvelope,
        signature: encode(
            await signStatement(
                await metadataStatement(metadataSigned, decode(node.metadataEnvelope)),
                signingKey,
            ),
        ),
        // The same record re-sealed by its signer: "re-locked, not vouched for".
        resealed: encode(
            await signStatement(
                await metadataResealedStatement(metadataSigned, decode(node.metadataEnvelope)),
                signingKey,
            ),
        ),
        // And saved from a link by its signer.
        saved: encode(
            await signStatement(
                await metadataSavedStatement(metadataSigned, decode(node.metadataEnvelope)),
                signingKey,
            ),
        ),
    },
    version: {
        statement: versionSigned,
        envelope: node.version.envelope,
        signature: encode(
            await signStatement(
                await versionStatement(versionSigned, decode(node.version.envelope)),
                signingKey,
            ),
        ),
        resealed: encode(
            await signStatement(
                await versionResealedStatement(versionSigned, decode(node.version.envelope)),
                signingKey,
            ),
        ),
        saved: encode(
            await signStatement(
                await versionSavedStatement(versionSigned, decode(node.version.envelope)),
                signingKey,
            ),
        ),
    },
};

// Scoped ids: fixed seeds and scopes, so the ids are known answers both sides must derive.
const idScopes = [
    '0b6f0e1c-6a52-4f37-9d0e-5f1f2a3b4c5d',
    // Upper case: the scope is lowercased in the statement.
    '0B6F0E1C-6A52-4F37-9D0E-5F1F2A3B4C5D',
    'f4a7c2d9-1e3b-4c5a-8f6e-7d8c9b0a1e2f',
];
const idKinds: IdKind[] = ['node', 'version', 'object', 'link', 'report'];
const ids = [];
for (const [s, scopeId] of idScopes.entries())
    for (const [k, kind] of idKinds.entries()) {
        const seed = encode(bytes(16, 1 + s * idKinds.length + k));
        ids.push({ kind, scopeId, seed, id: await deriveId(kind, scopeId, seed) });
    }

// The account's identity replaced by a successor at the next version, and that one by a third,
// each signed with the old identity's hybrid signature: one link, and a chain of two.
const keysOf = async (envelope: IdentityEnvelope) => ({
    signingKey: await openIdentitySigningKey(accountKey, userId, envelope),
    mlDsaSecretKey: (await openIdentityMlDsaKey(accountKey, userId, envelope))!.secretKey,
});
const linkOf = (old: IdentityEnvelope, next: IdentityEnvelope, signature: string) => ({
    oldKeyVersion: old.keyVersion,
    newKeyVersion: next.keyVersion,
    oldEncryptionPublicKey: old.encryptionPublicKey,
    oldSigningPublicKey: old.signingPublicKey,
    oldMlDsaPublicKey: old.mlDsa!.publicKey,
    newEncryptionPublicKey: next.encryptionPublicKey,
    newSigningPublicKey: next.signingPublicKey,
    newMlDsaPublicKey: next.mlDsa!.publicKey,
    newKemPublicKey: next.kem!.publicKey,
    signature,
});
const successor = await createSuccessor(accountKey, userId, identity, await keysOf(identity));
const third = await createSuccessor(
    accountKey,
    userId,
    successor.identity,
    await keysOf(successor.identity),
);
const firstLink = linkOf(identity, successor.identity, successor.signature);
const succession = {
    userId,
    accountKey: encode(accountKey),
    identity: successor.identity,
    link: firstLink,
    statement: encode(await successionStatement({ ...firstLink, userId })),
    chain: {
        links: [firstLink, linkOf(successor.identity, third.identity, third.signature)],
        pinned: {
            keyVersion: identity.keyVersion,
            encryptionPublicKey: identity.encryptionPublicKey,
            signingPublicKey: identity.signingPublicKey,
            mlDsaPublicKeyHash: await keyDigest(decode(identity.mlDsa!.publicKey)),
        },
        served: {
            keyVersion: third.identity.keyVersion,
            encryptionPublicKey: third.identity.encryptionPublicKey,
            signingPublicKey: third.identity.signingPublicKey,
            mlDsaPublicKey: third.identity.mlDsa!.publicKey,
            kemPublicKey: third.identity.kem!.publicKey,
        },
    },
};

// The keys statement of the account's identity: its bytes, and the signature the identity carries.
const keys = {
    userId,
    identity: publicIdentity(identity),
    statement: encode(await keysStatement({ userId, ...publicIdentity(identity) })),
};

// Version 1 identities as accounts held them before the release (one with its ML-KEM key and Ed25519
// binding, one from before hybrid sharing), and their upgrades: the same keys and key version.
const legacySource = await createIdentity(accountKey, userId, 3);
const legacySigning = await openIdentitySigningKey(accountKey, userId, legacySource);
const versionOne = async (withKem: boolean): Promise<IdentityEnvelope> => ({
    version: 1,
    keyVersion: legacySource.keyVersion,
    wrappingSalt: legacySource.wrappingSalt,
    encryptionPublicKey: legacySource.encryptionPublicKey,
    encryptionPrivateKeyNonce: legacySource.encryptionPrivateKeyNonce,
    encryptedEncryptionPrivateKey: legacySource.encryptedEncryptionPrivateKey,
    signingPublicKey: legacySource.signingPublicKey,
    signingSeedNonce: legacySource.signingSeedNonce,
    encryptedSigningSeed: legacySource.encryptedSigningSeed,
    kem: withKem
        ? {
              publicKey: legacySource.kem!.publicKey,
              seedNonce: legacySource.kem!.seedNonce,
              encryptedSeed: legacySource.kem!.encryptedSeed,
              signature: encode(
                  await signStatement(
                      new TextEncoder().encode(
                          JSON.stringify([
                              'hushos/identity/kem',
                              1,
                              userId.toLowerCase(),
                              legacySource.encryptionPublicKey,
                              legacySource.kem!.publicKey,
                          ]),
                      ),
                      legacySigning,
                  ),
              ),
          }
        : null,
});
const legacy = await versionOne(true);
const legacyNoKem = await versionOne(false);
const upgrade = {
    userId,
    accountKey: encode(accountKey),
    legacy,
    upgraded: await upgradeIdentity(accountKey, userId, legacy),
    legacyNoKem,
    upgradedNoKem: await upgradeIdentity(accountKey, userId, legacyNoKem),
};

// Fingerprint version 3: the shared vector, and the account's identity's words.
const fill = (byte: number) => new Uint8Array(32).fill(byte);
const fingerprints = {
    vector: await fingerprint(fill(1), fill(2), fill(3), fill(4)),
    identity: await fingerprintOfKeys(
        decode(identity.encryptionPublicKey, 32),
        decode(identity.signingPublicKey, 32),
        decode(identity.mlDsa!.publicKey, 1952),
        decode(identity.kem!.publicKey, 1184),
    ),
};

const out = new URL('../../../crates/hushos-core/fixtures/', import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(
    new URL('web.json', out),
    JSON.stringify(
        {
            generatedBy: 'packages/crypto/scripts/core-fixtures.ts',
            account,
            device,
            workspace,
            node,
            layouts,
            document,
            share,
            link,
            recovery,
            settings,
            signatures,
            succession,
            keys,
            upgrade,
            fingerprints,
            ids,
        },
        null,
        2,
    ) + '\n',
);
console.log('wrote crates/hushos-core/fixtures/web.json');
