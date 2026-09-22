import { mkdir, writeFile } from 'node:fs/promises';
import { encryptKey } from '../src/aead';
import { rememberAccountKey } from '../src/device';
import {
    CONTENT_SUITE,
    chunkCount,
    encryptChunk,
    encryptThumbnail,
    LEGACY_CONTENT_SUITE,
    sealDocument,
    sealMetadata,
    sealVersion,
    wrapContentKey,
    wrapNodeKey,
} from '../src/drive';
import sodium from 'libsodium-wrappers';
import { createIdentity } from '../src/identity';
import { decode, encode, wrappingKey } from '../src/keys';
import { sealShareKey } from '../src/shares';
import {
    generateLinkSecret,
    generateLinkSalt,
    passwordKey,
    sealLinkKeyWith,
    sealLinkSecret,
} from '../src/links';
import { createRecovery } from '../src/recovery';
import { sealSettings } from '../src/contacts';
import { openIdentityEncryptionKey } from '../src/identity';
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

// A node under the root, its metadata, a suite 2 version with a thumbnail, and a suite 1 version.
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
const objectId = uuid();
const versionId = uuid();
const plaintextSize = 8 * 1024 * 1024 + 5;
const thumbnail = bytes(300, 5);
const versionCtx = { workspaceId, nodeId, versionId, objectId, suite: CONTENT_SUITE };
const lastChunk = bytes(5, 9);
const chunkCtx = {
    workspaceId,
    objectId,
    suite: CONTENT_SUITE,
    index: 1,
    chunkCount: chunkCount(plaintextSize),
    plaintextSize,
};
const emptyObjectId = uuid();
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
    version: {
        ctx: versionCtx,
        contentKey: encode(contentKey),
        contentNonce: encode(contentNonce),
        plaintextSize,
        thumbnailBytes: thumbnail.length,
        envelope: encode(
            await sealVersion(
                { contentKey, plaintextSize, thumbnailBytes: thumbnail.length },
                nodeKey,
                versionCtx,
            ),
        ),
        // Only the last, five-byte chunk is kept: it still binds index 1 of 2 and the full size.
        lastChunk: {
            index: 1,
            plaintext: encode(lastChunk),
            ciphertext: encode(await encryptChunk(lastChunk, contentKey, contentNonce, chunkCtx)),
        },
        thumbnail: {
            plaintext: encode(thumbnail),
            ciphertext: encode(
                await encryptThumbnail(thumbnail, contentKey, contentNonce, {
                    workspaceId,
                    objectId,
                    plaintextSize,
                }),
            ),
        },
    },
    emptyFile: {
        objectId: emptyObjectId,
        ciphertext: encode(
            await encryptChunk(new Uint8Array(0), contentKey, contentNonce, {
                workspaceId,
                objectId: emptyObjectId,
                suite: CONTENT_SUITE,
                index: 0,
                chunkCount: 1,
                plaintextSize: 0,
            }),
        ),
    },
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

// The grantee's identity under the account key, and a node key shared to it by a granter, in both suites.
await sodium.ready;
const identity = await createIdentity(accountKey, userId, 2);
const granter = sodium.crypto_box_keypair();
const shareCtx = {
    workspaceId: uuid(),
    nodeId: uuid(),
    keyEpoch: 5,
    granteeUserId: userId,
    granterUserId: uuid(),
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
    classic: encode(
        await sealShareKey(
            sharedNodeKey,
            { ...grantee, kemPublicKey: null },
            granter.privateKey,
            shareCtx,
        ),
    ),
    hybrid: encode(await sealShareKey(sharedNodeKey, grantee, granter.privateKey, shareCtx)),
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

// The settings document (contact pins) sealed under the identity's private key.
const identityPrivateKey = await openIdentityEncryptionKey(accountKey, userId, identity);
const settingsJson = {
    version: 1 as const,
    contacts: {
        [uuid()]: {
            userId: uuid(),
            email: 'friend@example.com',
            name: 'Friend',
            encryptionPublicKey: encode(random(32)),
            signingPublicKey: encode(random(32)),
            fingerprint: 'abcd',
            pinnedAt: '2026-09-22T00:00:00.000Z',
            kemPublicKeyHash: null,
        },
    },
};
const settings = {
    userId,
    identityPrivateKey: encode(identityPrivateKey),
    json: JSON.stringify(settingsJson),
    envelope: await sealSettings(identityPrivateKey, userId, 4, settingsJson),
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
            document,
            share,
            link,
            recovery,
            settings,
        },
        null,
        2,
    ) + '\n',
);
console.log('wrote crates/hushos-core/fixtures/web.json');
