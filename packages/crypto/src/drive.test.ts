import { describe, expect, test } from 'vitest';
import { CryptoError } from './errors';
import {
    CHUNK_SIZE,
    CHUNK_TAG_BYTES,
    checkName,
    chunkCiphertextLength,
    chunkCount,
    chunkNonce,
    chunkRange,
    ciphertextSize,
    decryptChunk,
    encryptChunk,
    generateContentNonce,
    generateKey,
    openContentKey,
    openMetadata,
    openNodeKey,
    openVersion,
    partLength,
    sealMetadata,
    sealVersion,
    thumbnailKey,
    thumbnailRange,
    THUMBNAIL_MAX_BYTES,
    validObjectSize,
    wrapContentKey,
    wrapNodeKey,
    decryptThumbnail,
    encryptThumbnail,
} from './drive';

const WS = '11111111-1111-4111-8111-111111111111';
const ROOT = '22222222-2222-4222-8222-222222222222';
const FOLDER = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const VERSION = '55555555-5555-4555-8555-555555555555';
const OBJECT = '66666666-6666-4666-8666-666666666666';

describe('node key envelopes', () => {
    const ctx = { workspaceId: WS, nodeId: FOLDER, parentId: ROOT, parentKeyEpoch: 1, keyEpoch: 2 };

    test('opens under the parent key with the same position and epochs', async () => {
        const parent = generateKey();
        const key = generateKey();
        const envelope = await wrapNodeKey(key, parent, ctx);
        expect(envelope).toHaveLength(72);
        expect(await openNodeKey(envelope, parent, ctx)).toEqual(key);
    });

    test('does not open from another position, epoch, or workspace', async () => {
        const parent = generateKey();
        const envelope = await wrapNodeKey(generateKey(), parent, ctx);
        const cases = [
            { ...ctx, parentId: OTHER }, // moved without a rewrap
            { ...ctx, nodeId: OTHER }, // presented as a different node
            { ...ctx, parentKeyEpoch: 2 }, // wrong parent key epoch after a rotation
            { ...ctx, keyEpoch: 3 }, // wrong own epoch
            { ...ctx, workspaceId: OTHER },
        ];
        for (const wrong of cases)
            await expect(openNodeKey(envelope, parent, wrong)).rejects.toBeInstanceOf(CryptoError);
        await expect(openNodeKey(envelope, generateKey(), ctx)).rejects.toBeInstanceOf(CryptoError);
        const truncated = envelope.slice(0, 71);
        await expect(openNodeKey(truncated, parent, ctx)).rejects.toBeInstanceOf(CryptoError);
    });
});

describe('metadata envelopes', () => {
    const ctx = { workspaceId: WS, nodeId: FOLDER, metadataVersion: 3 };
    const meta = { name: 'Tax 2026.pdf', mime: 'application/pdf', size: 1234, modified: null };

    test('round-trips and is bound to its node and version', async () => {
        const key = generateKey();
        const envelope = await sealMetadata(meta, key, ctx);
        expect(await openMetadata(envelope, key, ctx)).toEqual(meta);
        // An old name replayed under a new version number does not open.
        await expect(
            openMetadata(envelope, key, { ...ctx, metadataVersion: 4 }),
        ).rejects.toBeInstanceOf(CryptoError);
        await expect(openMetadata(envelope, key, { ...ctx, nodeId: OTHER })).rejects.toBeInstanceOf(
            CryptoError,
        );
        const flipped = envelope.slice();
        flipped[40]! ^= 1;
        await expect(openMetadata(flipped, key, ctx)).rejects.toBeInstanceOf(CryptoError);
    });

    test('refuses names the client must not produce', async () => {
        const key = generateKey();
        for (const name of ['', '.', '..', 'a/b', 'x'.repeat(256), 'tab\there'])
            await expect(sealMetadata({ ...meta, name }, key, ctx)).rejects.toBeInstanceOf(
                CryptoError,
            );
        expect(checkName('x'.repeat(255))).toHaveLength(255);
        expect(checkName('naïve résumé.txt')).toBe('naïve résumé.txt');
    });
});

describe('content key envelopes', () => {
    const ctx = { workspaceId: WS, nodeId: FOLDER, versionId: VERSION, objectId: OBJECT };

    test('is bound to the object, so a version cannot be pointed at other ciphertext', async () => {
        const nodeKey = generateKey();
        const contentKey = generateKey();
        const envelope = await wrapContentKey(contentKey, nodeKey, ctx);
        expect(await openContentKey(envelope, nodeKey, ctx)).toEqual(contentKey);
        await expect(
            openContentKey(envelope, nodeKey, { ...ctx, objectId: OTHER }),
        ).rejects.toBeInstanceOf(CryptoError);
        await expect(
            openContentKey(envelope, nodeKey, { ...ctx, versionId: OTHER }),
        ).rejects.toBeInstanceOf(CryptoError);
    });

    test('the thumbnail key is derived, deterministic, and never the content key', async () => {
        const contentKey = generateKey();
        const derived = await thumbnailKey(contentKey);
        expect(derived).toHaveLength(32);
        expect(derived).not.toEqual(contentKey);
        expect(await thumbnailKey(contentKey)).toEqual(derived);
        expect(await thumbnailKey(generateKey())).not.toEqual(derived);
    });
});

describe('content suite 1 framing', () => {
    test('chunk arithmetic matches the design', () => {
        expect(chunkCount(0)).toBe(1);
        expect(ciphertextSize(0)).toBe(16);
        expect(chunkCount(CHUNK_SIZE)).toBe(1);
        expect(chunkCount(CHUNK_SIZE + 1)).toBe(2);
        expect(ciphertextSize(CHUNK_SIZE + 1)).toBe(CHUNK_SIZE + 1 + 2 * CHUNK_TAG_BYTES);
        expect(chunkCiphertextLength(CHUNK_SIZE + 1, 0)).toBe(CHUNK_SIZE + 16);
        expect(chunkCiphertextLength(CHUNK_SIZE + 1, 1)).toBe(17);
        expect(chunkRange(CHUNK_SIZE + 1, 1)).toEqual({
            start: CHUNK_SIZE + 16,
            end: CHUNK_SIZE + 16 + 16,
        });
        expect(() => chunkCiphertextLength(CHUNK_SIZE + 1, 2)).toThrow(CryptoError);
    });

    test('chunk nonces differ by index in the trailing counter', () => {
        const base = generateContentNonce();
        const zero = chunkNonce(base, 0);
        const one = chunkNonce(base, 1);
        expect(zero.subarray(0, 16)).toEqual(base);
        expect(zero.subarray(16)).toEqual(new Uint8Array(8));
        expect(one[23]).toBe(1);
        expect(one.subarray(0, 23)).toEqual(zero.subarray(0, 23));
    });

    test('a chunk authenticates its index, count, and total size', async () => {
        const key = generateKey();
        const nonce = generateContentNonce();
        // A two-chunk file where the second chunk is 5 bytes; test the short one.
        const plaintextSize = CHUNK_SIZE + 5;
        const ctx = {
            workspaceId: WS,
            objectId: OBJECT,
            suite: 2,
            index: 1,
            chunkCount: 2,
            plaintextSize,
        };
        const plain = new TextEncoder().encode('hello');
        const cipher = await encryptChunk(plain, key, nonce, ctx);
        expect(cipher).toHaveLength(5 + 16);
        expect(await decryptChunk(cipher, key, nonce, ctx)).toEqual(plain);
        // Presented as a one-chunk file of 5 bytes: a truncated object must not open.
        await expect(
            decryptChunk(cipher, key, nonce, { ...ctx, index: 0, chunkCount: 1, plaintextSize: 5 }),
        ).rejects.toBeInstanceOf(CryptoError);
        await expect(
            decryptChunk(cipher, key, nonce, { ...ctx, objectId: OTHER }),
        ).rejects.toBeInstanceOf(CryptoError);
        // The suite is in the associated data: a suite 2 chunk is not a suite 1 chunk.
        await expect(decryptChunk(cipher, key, nonce, { ...ctx, suite: 1 })).rejects.toBeInstanceOf(
            CryptoError,
        );
        await expect(encryptChunk(plain, key, nonce, { ...ctx, suite: 3 })).rejects.toBeInstanceOf(
            CryptoError,
        );
        await expect(decryptChunk(cipher, generateKey(), nonce, ctx)).rejects.toBeInstanceOf(
            CryptoError,
        );
        // A plaintext of the wrong length for its index is refused before encryption.
        await expect(encryptChunk(plain, key, nonce, { ...ctx, index: 0 })).rejects.toBeInstanceOf(
            CryptoError,
        );
        await expect(
            encryptChunk(plain, key, nonce, { ...ctx, chunkCount: 3 }),
        ).rejects.toBeInstanceOf(CryptoError);
    });

    test('an empty file is one authenticated 16-byte chunk', async () => {
        const key = generateKey();
        const nonce = generateContentNonce();
        const ctx = {
            workspaceId: WS,
            objectId: OBJECT,
            suite: 2,
            index: 0,
            chunkCount: 1,
            plaintextSize: 0,
        };
        const cipher = await encryptChunk(new Uint8Array(0), key, nonce, ctx);
        expect(cipher).toHaveLength(16);
        expect(await decryptChunk(cipher, key, nonce, ctx)).toHaveLength(0);
    });
});

describe('version envelopes', () => {
    const ctx = { workspaceId: WS, nodeId: FOLDER, versionId: VERSION, objectId: OBJECT, suite: 2 };

    test('seals the key with the sizes and opens them back, 84 bytes', async () => {
        const nodeKey = generateKey();
        const contentKey = generateKey();
        const record = { contentKey, plaintextSize: 3 * CHUNK_SIZE + 7, thumbnailBytes: 41_000 };
        const envelope = await sealVersion(record, nodeKey, ctx);
        expect(envelope).toHaveLength(84);
        const opened = await openVersion(envelope, nodeKey, ctx);
        expect(opened.contentKey).toEqual(contentKey);
        expect(opened.plaintextSize).toBe(record.plaintextSize);
        expect(opened.thumbnailBytes).toBe(41_000);
        // No thumbnail is a zero, not an absence.
        const bare = await openVersion(
            await sealVersion({ ...record, thumbnailBytes: 0 }, nodeKey, ctx),
            nodeKey,
            ctx,
        );
        expect(bare.thumbnailBytes).toBe(0);
    });

    test('does not open from another version, object, suite or key, and refuses bad sizes', async () => {
        const nodeKey = generateKey();
        const record = { contentKey: generateKey(), plaintextSize: 10, thumbnailBytes: 5 };
        const envelope = await sealVersion(record, nodeKey, ctx);
        for (const wrong of [
            { ...ctx, versionId: OTHER },
            { ...ctx, objectId: OTHER },
            { ...ctx, nodeId: OTHER },
            { ...ctx, suite: 1 },
        ])
            await expect(openVersion(envelope, nodeKey, wrong)).rejects.toBeInstanceOf(CryptoError);
        await expect(openVersion(envelope, generateKey(), ctx)).rejects.toBeInstanceOf(CryptoError);
        // A flipped byte in the sealed sizes fails authentication rather than reading as a size.
        const tampered = envelope.slice();
        tampered[24 + 32 + 7] = (tampered[24 + 32 + 7] ?? 0) ^ 1;
        await expect(openVersion(tampered, nodeKey, ctx)).rejects.toBeInstanceOf(CryptoError);
        await expect(
            sealVersion({ ...record, thumbnailBytes: THUMBNAIL_MAX_BYTES + 1 }, nodeKey, ctx),
        ).rejects.toBeInstanceOf(CryptoError);
        await expect(
            sealVersion({ ...record, plaintextSize: -1 }, nodeKey, ctx),
        ).rejects.toBeInstanceOf(CryptoError);
    });

    test('suite 1 is the 72-byte key envelope with no sizes, and cannot carry a thumbnail', async () => {
        const nodeKey = generateKey();
        const contentKey = generateKey();
        const legacy = { ...ctx, suite: 1 };
        const envelope = await sealVersion(
            { contentKey, plaintextSize: 9, thumbnailBytes: 0 },
            nodeKey,
            legacy,
        );
        expect(envelope).toHaveLength(72);
        expect(await openContentKey(envelope, nodeKey, ctx)).toEqual(contentKey);
        expect(await openVersion(envelope, nodeKey, legacy)).toEqual({
            contentKey,
            plaintextSize: null,
            thumbnailBytes: 0,
        });
        await expect(
            sealVersion({ contentKey, plaintextSize: 9, thumbnailBytes: 1 }, nodeKey, legacy),
        ).rejects.toBeInstanceOf(CryptoError);
        // A suite 1 envelope is not a suite 2 envelope, whatever the row says.
        await expect(openVersion(envelope, nodeKey, ctx)).rejects.toBeInstanceOf(CryptoError);
    });
});

describe('the thumbnail trailer', () => {
    const base = { workspaceId: WS, objectId: OBJECT, plaintextSize: CHUNK_SIZE + 5 };

    test('sits after the last chunk and opens only under its own framing', async () => {
        const contentKey = generateKey();
        const nonce = generateContentNonce();
        const webp = crypto.getRandomValues(new Uint8Array(3000));
        const trailer = await encryptThumbnail(webp, contentKey, nonce, base);
        expect(trailer).toHaveLength(3000 + 16);
        const ctx = { ...base, thumbnailBytes: 3000 };
        expect(await decryptThumbnail(trailer, contentKey, nonce, ctx)).toEqual(webp);
        // Its range is exactly the bytes after the chunks, and the object ends with it.
        const range = thumbnailRange(base.plaintextSize, 3000);
        expect(range.start).toBe(ciphertextSize(base.plaintextSize));
        expect(range.end + 1).toBe(ciphertextSize(base.plaintextSize, 3000));
        expect(ciphertextSize(base.plaintextSize, 0)).toBe(ciphertextSize(base.plaintextSize));
        // Another object, another length, another file size (a different nonce) or the content key itself: refused.
        for (const wrong of [
            { ...ctx, objectId: OTHER },
            { ...ctx, thumbnailBytes: 2999 },
            { ...ctx, plaintextSize: 5 },
        ])
            await expect(
                decryptThumbnail(trailer, contentKey, nonce, wrong),
            ).rejects.toBeInstanceOf(CryptoError);
        await expect(
            decryptChunk(trailer, contentKey, nonce, {
                workspaceId: WS,
                objectId: OBJECT,
                suite: 2,
                index: 0,
                chunkCount: 1,
                plaintextSize: 3000,
            }),
        ).rejects.toBeInstanceOf(CryptoError);
        await expect(
            decryptThumbnail(trailer, await thumbnailKey(contentKey), nonce, ctx),
        ).rejects.toBeInstanceOf(CryptoError);
        await expect(
            encryptThumbnail(new Uint8Array(THUMBNAIL_MAX_BYTES + 1), contentKey, nonce, base),
        ).rejects.toBeInstanceOf(CryptoError);
        await expect(
            encryptThumbnail(new Uint8Array(0), contentKey, nonce, base),
        ).rejects.toBeInstanceOf(CryptoError);
    });
});

describe('what the server can check', () => {
    test('part lengths follow from the declared size and chunk count', () => {
        const size = ciphertextSize(2 * CHUNK_SIZE + 100, 4000);
        expect(partLength(size, 3, 1)).toBe(CHUNK_SIZE + 16);
        expect(partLength(size, 3, 2)).toBe(CHUNK_SIZE + 16);
        expect(partLength(size, 3, 3)).toBe(100 + 16 + 4000 + 16);
        expect(() => partLength(size, 3, 4)).toThrow(CryptoError);
        expect(() => partLength(size, 3, 0)).toThrow(CryptoError);
    });

    test('an object size is valid only when its last part can hold a chunk and a trailer', () => {
        expect(validObjectSize(16, 1)).toBe(true); // an empty file
        expect(validObjectSize(15, 1)).toBe(false);
        expect(validObjectSize(ciphertextSize(CHUNK_SIZE, THUMBNAIL_MAX_BYTES), 1)).toBe(true);
        expect(validObjectSize(ciphertextSize(CHUNK_SIZE, THUMBNAIL_MAX_BYTES) + 1, 1)).toBe(false);
        // Two chunks need a last chunk of at least one byte.
        expect(validObjectSize(CHUNK_SIZE + 16 + 16, 2)).toBe(false);
        expect(validObjectSize(CHUNK_SIZE + 16 + 17, 2)).toBe(true);
        // A chunk and a bit reads as one chunk with a small trailer: that is the documented residual.
        expect(validObjectSize(ciphertextSize(CHUNK_SIZE + 1), 1)).toBe(true);
        // More than a chunk and a full trailer cannot be one part.
        const over = ciphertextSize(CHUNK_SIZE + THUMBNAIL_MAX_BYTES + 1);
        expect(validObjectSize(over, 1)).toBe(false);
        expect(validObjectSize(over, 2)).toBe(true);
        expect(validObjectSize(100, 0)).toBe(false);
        expect(validObjectSize(-1, 1)).toBe(false);
    });
});
