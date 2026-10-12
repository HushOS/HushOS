import { describe, expect, test } from 'vitest';
import { CryptoError } from './errors';
import {
    CHUNK_SIZE,
    CHUNK_TAG_BYTES,
    checkName,
    chunkCiphertextLength,
    chunkCount,
    chunkPlaintextLength as chunkPlaintextLengthOf,
    chunkNonce,
    chunkRange,
    ciphertextSize,
    CONTENT_SUITE,
    contentLength,
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
    fileBytesOf,
    paddedLength,
    UNPADDED_CONTENT_SUITE,
    DOCUMENT_MAX_BYTES,
    METADATA_PAD_STEP,
    metadataContext,
    openDocument,
    sealDocument,
} from './drive';
import sodium from 'libsodium-wrappers';

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

describe('suite 2 framing (read, never written)', () => {
    const S2 = UNPADDED_CONTENT_SUITE;
    test('chunk arithmetic matches the design', () => {
        expect(chunkCount(0)).toBe(1);
        expect(ciphertextSize(S2, 0, 0)).toBe(16);
        expect(chunkCount(CHUNK_SIZE)).toBe(1);
        expect(chunkCount(CHUNK_SIZE + 1)).toBe(2);
        expect(ciphertextSize(S2, CHUNK_SIZE + 1, 0)).toBe(CHUNK_SIZE + 1 + 2 * CHUNK_TAG_BYTES);
        expect(chunkCiphertextLength(CHUNK_SIZE + 1, 0)).toBe(CHUNK_SIZE + 16);
        expect(chunkCiphertextLength(CHUNK_SIZE + 1, 1)).toBe(17);
        expect(chunkRange(S2, CHUNK_SIZE + 1, 0, 1)).toEqual({
            start: CHUNK_SIZE + 16,
            end: CHUNK_SIZE + 16 + 16,
        });
        // With a thumbnail the last chunk's range runs to the object's end, never stopping at the
        // trailer's start (which would say the file's exact size); earlier chunks are unchanged.
        expect(chunkRange(S2, CHUNK_SIZE + 1, 3000, 1)).toEqual({
            start: CHUNK_SIZE + 16,
            end: ciphertextSize(S2, CHUNK_SIZE + 1, 3000) - 1,
        });
        expect(chunkRange(S2, CHUNK_SIZE + 1, 3000, 0)).toEqual(
            chunkRange(S2, CHUNK_SIZE + 1, 0, 0),
        );
        expect(() => chunkCiphertextLength(CHUNK_SIZE + 1, 2)).toThrow(CryptoError);
        // Suites 1 and 2 cover the file alone; an unknown suite is refused rather than guessed.
        expect(contentLength(1, 1000, 0)).toBe(1000);
        expect(contentLength(S2, 1000, 3000)).toBe(1000);
        expect(() => contentLength(4, 1000, 0)).toThrow(CryptoError);
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
            suite: S2,
            index: 1,
            chunkCount: 2,
            plaintextSize,
            thumbnailBytes: 0,
        };
        const plain = new TextEncoder().encode('hello');
        const cipher = await encryptChunk(plain, key, nonce, ctx);
        expect(cipher).toHaveLength(5 + 16);
        expect(await decryptChunk(cipher, key, nonce, ctx)).toEqual(plain);
        // The last chunk opens from the front of a range that carries the trailer behind it.
        const withTrailer = new Uint8Array(cipher.length + 3016);
        withTrailer.set(cipher);
        expect(await decryptChunk(withTrailer, key, nonce, ctx)).toEqual(plain);
        // Any other chunk must be exact, and the last one no shorter.
        await expect(
            decryptChunk(withTrailer, key, nonce, { ...ctx, index: 0 }),
        ).rejects.toBeInstanceOf(CryptoError);
        await expect(decryptChunk(cipher.subarray(1), key, nonce, ctx)).rejects.toBeInstanceOf(
            CryptoError,
        );
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
        await expect(encryptChunk(plain, key, nonce, { ...ctx, suite: 4 })).rejects.toBeInstanceOf(
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
            suite: S2,
            index: 0,
            chunkCount: 1,
            plaintextSize: 0,
            thumbnailBytes: 0,
        };
        const cipher = await encryptChunk(new Uint8Array(0), key, nonce, ctx);
        expect(cipher).toHaveLength(16);
        expect(await decryptChunk(cipher, key, nonce, ctx)).toHaveLength(0);
    });
});

describe('version envelopes', () => {
    const ctx = {
        workspaceId: WS,
        nodeId: FOLDER,
        versionId: VERSION,
        objectId: OBJECT,
        suite: CONTENT_SUITE,
    };

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
            // The same 84-byte record under suite 2 would be read without the padding: refused.
            { ...ctx, suite: 2 },
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
        // A suite 1 envelope is not a suite 3 envelope, whatever the row says.
        await expect(openVersion(envelope, nodeKey, ctx)).rejects.toBeInstanceOf(CryptoError);
    });
});

describe('the thumbnail trailer', () => {
    const base = {
        workspaceId: WS,
        objectId: OBJECT,
        suite: CONTENT_SUITE,
        plaintextSize: CHUNK_SIZE + 5,
    };

    test('sits after the last chunk and opens only under its own framing', async () => {
        const contentKey = generateKey();
        const nonce = generateContentNonce();
        const webp = crypto.getRandomValues(new Uint8Array(3000));
        const trailer = await encryptThumbnail(webp, contentKey, nonce, base);
        expect(trailer).toHaveLength(3000 + 16);
        const ctx = { ...base, thumbnailBytes: 3000 };
        expect(await decryptThumbnail(trailer, contentKey, nonce, ctx)).toEqual(webp);
        // The object ends with it, and the fetch is the same-length tail whatever its size,
        // so the store cannot read the trailer's length (and the file's exact size) off it.
        const range = thumbnailRange(CONTENT_SUITE, base.plaintextSize, 3000);
        expect(range.end + 1).toBe(ciphertextSize(CONTENT_SUITE, base.plaintextSize, 3000));
        const other = thumbnailRange(CONTENT_SUITE, base.plaintextSize, THUMBNAIL_MAX_BYTES);
        expect(other.end - other.start).toBe(range.end - range.start);
        expect(range.end - range.start + 1).toBe(THUMBNAIL_MAX_BYTES + 16);
        // A small object is fetched whole.
        expect(thumbnailRange(CONTENT_SUITE, 10, 3000)).toEqual({
            start: 0,
            end: ciphertextSize(CONTENT_SUITE, 10, 3000) - 1,
        });
        // The trailer opens from the end of that window, and a window short of it does not.
        const window = new Uint8Array(range.end - range.start + 1);
        window.set(trailer, window.length - trailer.length);
        expect(await decryptThumbnail(window, contentKey, nonce, ctx)).toEqual(webp);
        await expect(
            decryptThumbnail(trailer.subarray(1), contentKey, nonce, ctx),
        ).rejects.toBeInstanceOf(CryptoError);
        // Another object, another length, another file size (a different nonce) or the content key itself: refused.
        for (const wrong of [
            { ...ctx, objectId: OTHER },
            { ...ctx, thumbnailBytes: 2999 },
            { ...ctx, plaintextSize: 5 },
            // A suite 3 trailer is not a suite 2 one, though their bytes sit in the same place.
            { ...ctx, suite: UNPADDED_CONTENT_SUITE },
            { ...ctx, suite: 1 },
        ])
            await expect(
                decryptThumbnail(trailer, contentKey, nonce, wrong),
            ).rejects.toBeInstanceOf(CryptoError);
        await expect(
            decryptChunk(trailer, contentKey, nonce, {
                workspaceId: WS,
                objectId: OBJECT,
                suite: CONTENT_SUITE,
                index: 0,
                chunkCount: 1,
                plaintextSize: 3000,
                thumbnailBytes: 0,
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

describe('content suite 3: padded objects', () => {
    test('Padmé buckets: known values, never smaller, idempotent, monotonic, bounded', () => {
        const known: [number, number][] = [
            [0, 256],
            [1, 256],
            [256, 256],
            [257, 272],
            [1000, 1024],
            [1024, 1024],
            [65_537, 67_584],
            [2 ** 20 + 1, 1_081_344],
            [2 ** 32 + 1, 4_362_076_160],
            [10_000_000_000, 10_066_329_600],
            [2 ** 40, 2 ** 40],
        ];
        for (const [length, bucket] of known) expect(paddedLength(length)).toBe(bucket);
        const samples = [
            ...Array.from({ length: 2000 }, (_, i) => 250 + i),
            ...Array.from({ length: 200 }, () => Math.floor(Math.random() * 2 ** 40)),
            CHUNK_SIZE - 1,
            CHUNK_SIZE,
            CHUNK_SIZE + 1,
            Math.floor(Number.MAX_SAFE_INTEGER / 16),
        ];
        let previous = 0;
        for (const length of samples.sort((a, b) => a - b)) {
            const bucket = paddedLength(length);
            expect(bucket).toBeGreaterThanOrEqual(length);
            expect(paddedLength(bucket)).toBe(bucket);
            expect(bucket).toBeGreaterThanOrEqual(previous);
            previous = bucket;
            if (length > 256) {
                // The padding is under 2^-S of the length, S = floor(log2(log2 L)) + 1 >= 4.
                const s = Math.floor(Math.log2(Math.floor(Math.log2(length)))) + 1;
                expect((bucket - length) * 2 ** s).toBeLessThan(length);
            }
        }
        for (const bad of [-1, 0.5, Number.MAX_SAFE_INTEGER, Number.NaN])
            expect(() => paddedLength(bad)).toThrow(CryptoError);
    });

    test('the server sees a bucket, whether or not there is a thumbnail', () => {
        const sizes = [0, 1, 255, 256, 257, 4000, 70_000, CHUNK_SIZE - 300, CHUNK_SIZE, 5e8];
        for (const size of sizes)
            for (const thumbnail of [0, 1, 2000, THUMBNAIL_MAX_BYTES]) {
                const total = ciphertextSize(CONTENT_SUITE, size, thumbnail);
                const length = contentLength(CONTENT_SUITE, size, thumbnail);
                const count = chunkCount(length);
                const seen = total - CHUNK_TAG_BYTES * count;
                expect(paddedLength(seen)).toBe(seen);
                expect(seen).toBe(paddedLength(size + (thumbnail ? thumbnail + 16 : 0)));
                expect(length).toBeGreaterThanOrEqual(size);
                expect(validObjectSize(total, count)).toBe(true);
            }
        // Two files a few bytes apart, one with a thumbnail, land on the same object size.
        expect(ciphertextSize(CONTENT_SUITE, 8500, 0)).toBe(
            ciphertextSize(CONTENT_SUITE, 8000, 300),
        );
    });

    test('chunks carry the file then zeros, and the reader keeps exactly the file', async () => {
        const key = generateKey();
        const nonce = generateContentNonce();
        const size = CHUNK_SIZE + 1000;
        const thumbnailBytes = 2000;
        const file = Uint8Array.from({ length: size }, (_, i) => (i * 131 + 7) & 0xff);
        const length = contentLength(CONTENT_SUITE, size, thumbnailBytes);
        const count = chunkCount(length);
        expect(count).toBe(2);
        const ctx = (index: number) => ({
            workspaceId: WS,
            objectId: OBJECT,
            suite: CONTENT_SUITE,
            index,
            chunkCount: count,
            plaintextSize: size,
            thumbnailBytes,
        });
        // What the uploader encrypts: the file's bytes for the index, zero-filled to the chunk's length.
        const plaintextOf = (index: number) => {
            const chunk = new Uint8Array(chunkPlaintextLengthOf(length, index));
            chunk.set(file.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE));
            return chunk;
        };
        const chunks = [
            await encryptChunk(plaintextOf(0), key, nonce, ctx(0)),
            await encryptChunk(plaintextOf(1), key, nonce, ctx(1)),
        ];
        const trailer = await encryptThumbnail(new Uint8Array(thumbnailBytes), key, nonce, {
            workspaceId: WS,
            objectId: OBJECT,
            suite: CONTENT_SUITE,
            plaintextSize: size,
        });
        const object = new Uint8Array(ciphertextSize(CONTENT_SUITE, size, thumbnailBytes));
        object.set(chunks[0]!, 0);
        object.set(chunks[1]!, chunks[0]!.length);
        object.set(trailer, object.length - trailer.length);
        expect(chunks[0]!.length + chunks[1]!.length + trailer.length).toBe(object.length);

        // The reader fetches the ranges and keeps the first `size` bytes.
        const read: Uint8Array[] = [];
        for (let index = 0; index < count; index++) {
            const range = chunkRange(CONTENT_SUITE, size, thumbnailBytes, index);
            const plain = await decryptChunk(
                object.subarray(range.start, range.end + 1),
                key,
                nonce,
                ctx(index),
            );
            if (index === count - 1) expect(plain.subarray(1000).every((b) => b === 0)).toBe(true);
            read.push(fileBytesOf(plain, size, index));
        }
        expect(Buffer.concat(read).equals(Buffer.from(file))).toBe(true);
        // The trailer's nonce index follows the padded chunk count, not the file's.
        const range = thumbnailRange(CONTENT_SUITE, size, thumbnailBytes);
        expect(range.end + 1).toBe(object.length);
        await expect(
            decryptThumbnail(object.subarray(range.start), key, nonce, {
                ...ctx(0),
                thumbnailBytes,
            }),
        ).resolves.toEqual(new Uint8Array(thumbnailBytes));

        // A suite 3 chunk does not open as suite 2, where the same bytes would be the whole file.
        await expect(
            decryptChunk(chunks[1]!, key, nonce, { ...ctx(1), suite: UNPADDED_CONTENT_SUITE }),
        ).rejects.toBeInstanceOf(CryptoError);
        // Nor with the padding claimed for a different thumbnail, which moves the chunk count.
        await expect(
            decryptChunk(chunks[1]!, key, nonce, { ...ctx(1), thumbnailBytes: 0 }),
        ).rejects.toBeInstanceOf(CryptoError);
        // The file's bytes alone are not a suite 3 chunk: the writer must pad.
        await expect(
            encryptChunk(file.subarray(CHUNK_SIZE), key, nonce, ctx(1)),
        ).rejects.toBeInstanceOf(CryptoError);
    });

    test('a chunk wholly past the file reads as nothing, and fileBytesOf never reaches past the file', () => {
        const chunk = new Uint8Array(100).fill(7);
        expect(fileBytesOf(chunk, 50, 0)).toHaveLength(50);
        expect(fileBytesOf(chunk, CHUNK_SIZE + 10, 1)).toHaveLength(10);
        expect(fileBytesOf(chunk, CHUNK_SIZE, 1)).toHaveLength(0);
        expect(fileBytesOf(chunk, 0, 3)).toHaveLength(0);
    });
});

describe('what the server can check', () => {
    const S2 = UNPADDED_CONTENT_SUITE;
    test('part lengths follow from the declared size and chunk count', () => {
        const size = ciphertextSize(S2, 2 * CHUNK_SIZE + 100, 4000);
        expect(partLength(size, 3, 1)).toBe(CHUNK_SIZE + 16);
        expect(partLength(size, 3, 2)).toBe(CHUNK_SIZE + 16);
        expect(partLength(size, 3, 3)).toBe(100 + 16 + 4000 + 16);
        // Suite 3 pads the last part, and only the last part.
        const padded = ciphertextSize(CONTENT_SUITE, 2 * CHUNK_SIZE + 100, 4000);
        expect(partLength(padded, 3, 1)).toBe(CHUNK_SIZE + 16);
        expect(partLength(padded, 3, 3)).toBe(padded - 2 * (CHUNK_SIZE + 16));
        expect(() => partLength(size, 3, 4)).toThrow(CryptoError);
        expect(() => partLength(size, 3, 0)).toThrow(CryptoError);
    });

    test('an object size is valid only when its last part can hold a chunk and a trailer', () => {
        expect(validObjectSize(16, 1)).toBe(true); // an empty file
        expect(validObjectSize(15, 1)).toBe(false);
        expect(validObjectSize(ciphertextSize(S2, CHUNK_SIZE, THUMBNAIL_MAX_BYTES), 1)).toBe(true);
        expect(validObjectSize(ciphertextSize(S2, CHUNK_SIZE, THUMBNAIL_MAX_BYTES) + 1, 1)).toBe(
            false,
        );
        // Two chunks need a last chunk of at least one byte.
        expect(validObjectSize(CHUNK_SIZE + 16 + 16, 2)).toBe(false);
        expect(validObjectSize(CHUNK_SIZE + 16 + 17, 2)).toBe(true);
        // A chunk and a bit reads as one chunk with a small trailer: that is the documented residual.
        expect(validObjectSize(ciphertextSize(S2, CHUNK_SIZE + 1, 0), 1)).toBe(true);
        // More than a chunk and a full trailer cannot be one part.
        const over = ciphertextSize(S2, CHUNK_SIZE + THUMBNAIL_MAX_BYTES + 1, 0);
        expect(validObjectSize(over, 1)).toBe(false);
        expect(validObjectSize(over, 2)).toBe(true);
        expect(validObjectSize(100, 0)).toBe(false);
        expect(validObjectSize(-1, 1)).toBe(false);
    });
});

describe('workspace documents', () => {
    const ctx = { workspaceId: WS, kind: 'tags', version: 3 };
    test('opens under the same workspace, kind and version, and nothing else', async () => {
        const key = generateKey();
        const document = { version: 1, tags: [{ id: FOLDER, name: 'Home', colour: 'blue' }] };
        const envelope = await sealDocument(document, key, ctx);
        await expect(openDocument(envelope, key, ctx)).resolves.toEqual(document);
        await expect(openDocument(envelope, key, { ...ctx, version: 4 })).rejects.toThrow(
            'could not be opened',
        );
        await expect(openDocument(envelope, key, { ...ctx, kind: 'pins' })).rejects.toThrow(
            'could not be opened',
        );
        await expect(openDocument(envelope, key, { ...ctx, workspaceId: OTHER })).rejects.toThrow(
            'could not be opened',
        );
        await expect(openDocument(envelope, generateKey(), ctx)).rejects.toThrow(
            'could not be opened',
        );
    });
    test('refuses a kind the server would not store, a document too large, and a damaged envelope', async () => {
        const key = generateKey();
        await expect(sealDocument({}, key, { ...ctx, kind: 'Tags' })).rejects.toThrow(
            'Invalid document kind',
        );
        await expect(sealDocument({}, key, { ...ctx, kind: 'a'.repeat(33) })).rejects.toThrow(
            'Invalid document kind',
        );
        await expect(sealDocument({}, key, { ...ctx, version: 0 })).rejects.toThrow(
            'Invalid document version',
        );
        await expect(sealDocument(undefined, key, ctx)).rejects.toThrow('too large');
        await expect(
            sealDocument({ pad: 'x'.repeat(DOCUMENT_MAX_BYTES) }, key, ctx),
        ).rejects.toThrow('too large');
        const envelope = await sealDocument({ ok: true }, key, ctx);
        envelope[envelope.length - 1]! ^= 1;
        await expect(openDocument(envelope, key, ctx)).rejects.toThrow('could not be opened');
        await expect(openDocument(envelope.subarray(0, 30), key, ctx)).rejects.toThrow('damaged');
    });
});

describe('padding', () => {
    const ctx = { workspaceId: WS, nodeId: FOLDER, metadataVersion: 1 };
    const meta = (name: string) => ({ name, mime: null, size: null, modified: null });
    test("a name's length does not show in the metadata envelope until it crosses a step", async () => {
        const key = generateKey();
        const short = await sealMetadata(meta('a'), key, ctx);
        const longer = await sealMetadata(meta('a'.repeat(120)), key, ctx);
        const longest = await sealMetadata(meta('a'.repeat(240)), key, ctx);
        expect(short.length).toBe(longer.length);
        expect(longest.length).toBe(short.length + METADATA_PAD_STEP);
        expect((short.length - 24 - 16) % METADATA_PAD_STEP).toBe(0);
        await expect(openMetadata(longest, key, ctx)).resolves.toEqual(meta('a'.repeat(240)));
    });
    test("a document's size is a coarse bucket, never the count of what it holds", async () => {
        const key = generateKey();
        const docCtx = { workspaceId: WS, kind: 'tags', version: 1 };
        const few = await sealDocument({ tags: ['a'] }, key, docCtx);
        const some = await sealDocument(
            { tags: Array.from({ length: 20 }, () => 'x'.repeat(40)) },
            key,
            docCtx,
        );
        expect(few.length).toBe(some.length);
        expect((few.length - 24 - 16) % 1024).toBe(0);
        const big = { pad: 'x'.repeat(100 * 1024) };
        const sealed = await sealDocument(big, key, docCtx);
        expect((sealed.length - 24 - 16) % (4 * 1024)).toBe(0);
        await expect(openDocument(sealed, key, docCtx)).resolves.toEqual(big);
    });
    test('an envelope sealed before padding still opens', async () => {
        await sodium.ready;
        const key = generateKey();
        const nonce = crypto.getRandomValues(new Uint8Array(24));
        const body = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            new TextEncoder().encode(JSON.stringify(meta('old'))),
            metadataContext(ctx),
            null,
            nonce,
            key,
        );
        const legacy = new Uint8Array(24 + body.length);
        legacy.set(nonce);
        legacy.set(body, 24);
        await expect(openMetadata(legacy, key, ctx)).resolves.toEqual(meta('old'));
    });
});
