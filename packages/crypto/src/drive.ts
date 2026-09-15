import sodium from 'libsodium-wrappers';
import { CryptoError } from './errors';
import { encryptKey, decryptKey } from './aead';

/*
 * Drive's envelopes and content framing, as fixed by docs/drive-design.md.
 *
 * Every node has a random 32-byte key wrapped under its parent's key (the root's
 * under the workspace key). A file's node key encrypts its metadata and wraps the
 * content key of each version; the content key encrypts one stored object as
 * independent 8 MiB chunks. Every wrap binds the ids and epochs it belongs to, so
 * an envelope cannot be presented from another position, version, or object.
 *
 * Envelopes travel as one byte string, nonce || body, Base64url on the wire and
 * bytea in the database. Callers own every raw key they pass in and zero it.
 */

export const DRIVE_ENVELOPE_SUITE = 1;
/*
 * Content suite 2 is suite 1's chunk framing with the thumbnail sealed as a
 * trailer of the same object and a version envelope that carries the plaintext
 * size and the trailer's length, so the server holds neither. Suite 1 objects
 * are read forever and never written again.
 */
export const CONTENT_SUITE = 2;
export const LEGACY_CONTENT_SUITE = 1;
export const READABLE_CONTENT_SUITES: readonly number[] = [LEGACY_CONTENT_SUITE, CONTENT_SUITE];
export const CHUNK_SIZE = 8 * 1024 * 1024;
export const CHUNK_TAG_BYTES = 16;
export const ENVELOPE_NONCE_BYTES = 24;
export const KEY_BYTES = 32;
export const CONTENT_NONCE_BYTES = 16;
export const KEY_ENVELOPE_BYTES = ENVELOPE_NONCE_BYTES + KEY_BYTES + CHUNK_TAG_BYTES; // 72
/* contentKey || u64be(plaintextSize) || u32be(thumbnailBytes), sealed: 84 bytes with the nonce. */
export const VERSION_RECORD_BYTES = KEY_BYTES + 8 + 4;
export const VERSION_ENVELOPE_BYTES = ENVELOPE_NONCE_BYTES + VERSION_RECORD_BYTES + CHUNK_TAG_BYTES; // 84
/* A thumbnail is a 256-pixel WebP the uploader renders; anything bigger is refused. */
export const THUMBNAIL_MAX_BYTES = 64 * 1024;
export const NAME_MAX_CODE_POINTS = 255;
export const METADATA_MAX_BYTES = 4096;

export type NodeMetadata = {
    name: string;
    mime: string | null;
    size: number | null;
    modified: string | null;
};

export type NodeKeyContext = {
    workspaceId: string;
    nodeId: string;
    parentId: string;
    parentKeyEpoch: number;
    keyEpoch: number;
};
export type MetadataContext = { workspaceId: string; nodeId: string; metadataVersion: number };
export type ContentKeyContext = {
    workspaceId: string;
    nodeId: string;
    versionId: string;
    objectId: string;
    /* The object's content suite: 2 seals the sizes with the key, 1 the key alone. */
    suite: number;
};
/* What a version envelope holds. Suite 1 never sealed the sizes, so an opened one has no plaintext size. */
export type VersionRecord = {
    contentKey: Uint8Array;
    plaintextSize: number;
    thumbnailBytes: number;
};
export type ChunkContext = {
    workspaceId: string;
    objectId: string;
    suite: number;
    index: number;
    chunkCount: number;
    plaintextSize: number;
};
export type ThumbnailContext = {
    workspaceId: string;
    objectId: string;
    plaintextSize: number;
    thumbnailBytes: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function id(value: string, what: string) {
    if (!UUID.test(value)) throw new CryptoError(`Invalid ${what}.`);
    return value;
}
function epoch(value: number, what: string) {
    if (!Number.isSafeInteger(value) || value < 1) throw new CryptoError(`Invalid ${what}.`);
    return value;
}
function suite(value: number) {
    if (!READABLE_CONTENT_SUITES.includes(value))
        throw new CryptoError('This file was stored in a way this app does not support.');
    return value;
}
function byteCount(value: number, what: string) {
    if (!Number.isSafeInteger(value) || value < 0) throw new CryptoError(`Invalid ${what}.`);
    return value;
}
function context(parts: unknown[]) {
    return new TextEncoder().encode(JSON.stringify(parts));
}

/* Names are enforced by the client because the server cannot read them. */
export function checkName(name: string) {
    if (typeof name !== 'string') throw new CryptoError('Enter a name.');
    const points = Array.from(name).length;
    if (points < 1) throw new CryptoError('Enter a name.');
    if (points > NAME_MAX_CODE_POINTS)
        throw new CryptoError(`Use a name of at most ${NAME_MAX_CODE_POINTS} characters.`);
    if (name === '.' || name === '..' || name.includes('/'))
        throw new CryptoError('Names cannot contain "/" or be "." or "..".');
    for (const character of name) {
        const point = character.codePointAt(0) ?? 0;
        if (point < 0x20 || point === 0x7f)
            throw new CryptoError('Names cannot contain control characters.');
    }
    return name;
}

function split(envelope: Uint8Array, bodyLength?: number) {
    if (
        envelope.length <= ENVELOPE_NONCE_BYTES + CHUNK_TAG_BYTES ||
        (bodyLength !== undefined && envelope.length !== ENVELOPE_NONCE_BYTES + bodyLength)
    )
        throw new CryptoError('This encrypted envelope is damaged.');
    return {
        nonce: envelope.subarray(0, ENVELOPE_NONCE_BYTES),
        body: envelope.subarray(ENVELOPE_NONCE_BYTES),
    };
}
function join(nonce: Uint8Array, body: Uint8Array) {
    const out = new Uint8Array(nonce.length + body.length);
    out.set(nonce, 0);
    out.set(body, nonce.length);
    return out;
}
async function seal(plaintext: Uint8Array, key: Uint8Array, aad: Uint8Array) {
    const nonce = crypto.getRandomValues(new Uint8Array(ENVELOPE_NONCE_BYTES));
    return join(nonce, await encryptKey(plaintext, key, nonce, aad));
}

export function nodeKeyContext(ctx: NodeKeyContext) {
    return context([
        'hushos/drive/node-key',
        DRIVE_ENVELOPE_SUITE,
        id(ctx.workspaceId, 'workspace id'),
        id(ctx.nodeId, 'node id'),
        id(ctx.parentId, 'parent id'),
        epoch(ctx.parentKeyEpoch, 'parent key epoch'),
        epoch(ctx.keyEpoch, 'key epoch'),
    ]);
}
export function metadataContext(ctx: MetadataContext) {
    return context([
        'hushos/drive/node-meta',
        DRIVE_ENVELOPE_SUITE,
        id(ctx.workspaceId, 'workspace id'),
        id(ctx.nodeId, 'node id'),
        epoch(ctx.metadataVersion, 'metadata version'),
    ]);
}
export function contentKeyContext(ctx: ContentKeyContext) {
    return context([
        'hushos/drive/content-key',
        suite(ctx.suite),
        id(ctx.workspaceId, 'workspace id'),
        id(ctx.nodeId, 'node id'),
        id(ctx.versionId, 'version id'),
        id(ctx.objectId, 'object id'),
    ]);
}

export function generateKey() {
    return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

/* nodeKey wrapped under its parent's key (the workspace key for the root). 72 bytes. */
export async function wrapNodeKey(nodeKey: Uint8Array, parentKey: Uint8Array, ctx: NodeKeyContext) {
    if (nodeKey.length !== KEY_BYTES) throw new CryptoError('Invalid node key.');
    return seal(nodeKey, parentKey, nodeKeyContext(ctx));
}
export async function openNodeKey(
    envelope: Uint8Array,
    parentKey: Uint8Array,
    ctx: NodeKeyContext,
) {
    const { nonce, body } = split(envelope, KEY_BYTES + CHUNK_TAG_BYTES);
    const key = await decryptKey(body, parentKey, nonce, nodeKeyContext(ctx));
    if (key.length !== KEY_BYTES) {
        key.fill(0);
        throw new CryptoError('Invalid node key.');
    }
    return key;
}

export async function sealMetadata(
    metadata: NodeMetadata,
    nodeKey: Uint8Array,
    ctx: MetadataContext,
) {
    const clean: NodeMetadata = {
        name: checkName(metadata.name),
        mime:
            typeof metadata.mime === 'string' && metadata.mime.length <= 255 ? metadata.mime : null,
        size:
            typeof metadata.size === 'number' &&
            Number.isSafeInteger(metadata.size) &&
            metadata.size >= 0
                ? metadata.size
                : null,
        modified:
            typeof metadata.modified === 'string' && metadata.modified.length <= 64
                ? metadata.modified
                : null,
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(clean));
    if (plaintext.length > METADATA_MAX_BYTES) throw new CryptoError('This name is too long.');
    return seal(plaintext, nodeKey, metadataContext(ctx));
}
export async function openMetadata(
    envelope: Uint8Array,
    nodeKey: Uint8Array,
    ctx: MetadataContext,
): Promise<NodeMetadata> {
    await sodium.ready;
    const { nonce, body } = split(envelope);
    if (body.length > METADATA_MAX_BYTES + CHUNK_TAG_BYTES)
        throw new CryptoError('This encrypted envelope is damaged.');
    let plaintext: Uint8Array;
    try {
        plaintext = new Uint8Array(
            sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                null,
                body,
                metadataContext(ctx),
                nonce,
                nodeKey,
            ),
        );
    } catch (error) {
        // A bad context is reported as such; only a failed decrypt reads as damage.
        if (error instanceof CryptoError) throw error;
        throw new CryptoError('This item could not be opened. It may be damaged.');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
        throw new CryptoError('This item could not be opened. It may be damaged.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new CryptoError('This item could not be opened. It may be damaged.');
    const value = parsed as Record<string, unknown>;
    return {
        name: checkName(value.name as string),
        mime: typeof value.mime === 'string' ? value.mime : null,
        size:
            typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0
                ? value.size
                : null,
        modified: typeof value.modified === 'string' ? value.modified : null,
    };
}

/* Suite 1's envelope: the content key alone under the file's node key. 72 bytes; read, never written. */
export async function wrapContentKey(
    contentKey: Uint8Array,
    nodeKey: Uint8Array,
    ctx: Omit<ContentKeyContext, 'suite'>,
) {
    if (contentKey.length !== KEY_BYTES) throw new CryptoError('Invalid content key.');
    return seal(contentKey, nodeKey, contentKeyContext({ ...ctx, suite: LEGACY_CONTENT_SUITE }));
}
export async function openContentKey(
    envelope: Uint8Array,
    nodeKey: Uint8Array,
    ctx: Omit<ContentKeyContext, 'suite'>,
) {
    const { nonce, body } = split(envelope, KEY_BYTES + CHUNK_TAG_BYTES);
    const key = await decryptKey(
        body,
        nodeKey,
        nonce,
        contentKeyContext({ ...ctx, suite: LEGACY_CONTENT_SUITE }),
    );
    if (key.length !== KEY_BYTES) {
        key.fill(0);
        throw new CryptoError('Invalid content key.');
    }
    return key;
}

/*
 * The version envelope, bound to the version and its object. Under suite 2 it
 * seals the content key with the plaintext size and the thumbnail's length, so
 * the server never holds either; under suite 1 it is the 72-byte key envelope
 * and carries no sizes. A copy reseals the same record under a new node key.
 */
export async function sealVersion(
    record: VersionRecord,
    nodeKey: Uint8Array,
    ctx: ContentKeyContext,
) {
    if (record.contentKey.length !== KEY_BYTES) throw new CryptoError('Invalid content key.');
    if (suite(ctx.suite) === LEGACY_CONTENT_SUITE) {
        if (record.thumbnailBytes !== 0)
            throw new CryptoError('This file was stored without room for a thumbnail.');
        return wrapContentKey(record.contentKey, nodeKey, ctx);
    }
    byteCount(record.plaintextSize, 'file size');
    if (
        !Number.isSafeInteger(record.thumbnailBytes) ||
        record.thumbnailBytes < 0 ||
        record.thumbnailBytes > THUMBNAIL_MAX_BYTES
    )
        throw new CryptoError('Invalid thumbnail size.');
    const body = new Uint8Array(VERSION_RECORD_BYTES);
    body.set(record.contentKey, 0);
    const view = new DataView(body.buffer);
    view.setBigUint64(KEY_BYTES, BigInt(record.plaintextSize), false);
    view.setUint32(KEY_BYTES + 8, record.thumbnailBytes, false);
    try {
        return await seal(body, nodeKey, contentKeyContext(ctx));
    } finally {
        body.fill(0);
    }
}
export type OpenedVersion = {
    contentKey: Uint8Array;
    /* Null for suite 1, whose size lives on the object row instead. */
    plaintextSize: number | null;
    thumbnailBytes: number;
};
export async function openVersion(
    envelope: Uint8Array,
    nodeKey: Uint8Array,
    ctx: ContentKeyContext,
): Promise<OpenedVersion> {
    if (suite(ctx.suite) === LEGACY_CONTENT_SUITE)
        return {
            contentKey: await openContentKey(envelope, nodeKey, ctx),
            plaintextSize: null,
            thumbnailBytes: 0,
        };
    const { nonce, body } = split(envelope, VERSION_RECORD_BYTES + CHUNK_TAG_BYTES);
    const record = await decryptKey(body, nodeKey, nonce, contentKeyContext(ctx));
    try {
        if (record.length !== VERSION_RECORD_BYTES)
            throw new CryptoError('Invalid version envelope.');
        const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
        const size = view.getBigUint64(KEY_BYTES, false);
        const thumbnailBytes = view.getUint32(KEY_BYTES + 8, false);
        if (size > BigInt(Number.MAX_SAFE_INTEGER) || thumbnailBytes > THUMBNAIL_MAX_BYTES)
            throw new CryptoError('Invalid version envelope.');
        return {
            contentKey: record.slice(0, KEY_BYTES),
            plaintextSize: Number(size),
            thumbnailBytes,
        };
    } finally {
        record.fill(0);
    }
}

/* The thumbnail's key is derived for that one role; the content key never opens it. */
export async function thumbnailKey(contentKey: Uint8Array) {
    await sodium.ready;
    if (contentKey.length !== KEY_BYTES) throw new CryptoError('Invalid content key.');
    return new Uint8Array(sodium.crypto_kdf_derive_from_key(KEY_BYTES, 1, 'hushthmb', contentKey));
}

/* Chunk arithmetic, the same under both suites. An empty file is one 16-byte chunk. */
export function chunkCount(plaintextSize: number) {
    if (!Number.isSafeInteger(plaintextSize) || plaintextSize < 0)
        throw new CryptoError('Invalid file size.');
    return Math.max(1, Math.ceil(plaintextSize / CHUNK_SIZE));
}
/* The trailer's length in the object: the thumbnail and its tag, or nothing. */
export function trailerLength(thumbnailBytes: number) {
    if (
        !Number.isSafeInteger(thumbnailBytes) ||
        thumbnailBytes < 0 ||
        thumbnailBytes > THUMBNAIL_MAX_BYTES
    )
        throw new CryptoError('Invalid thumbnail size.');
    return thumbnailBytes > 0 ? thumbnailBytes + CHUNK_TAG_BYTES : 0;
}
/* The whole object: every chunk with its tag, then the trailer when there is one. */
export function ciphertextSize(plaintextSize: number, thumbnailBytes = 0) {
    return (
        plaintextSize + CHUNK_TAG_BYTES * chunkCount(plaintextSize) + trailerLength(thumbnailBytes)
    );
}
/* Byte range of the thumbnail trailer inside the stored object. */
export function thumbnailRange(plaintextSize: number, thumbnailBytes: number) {
    if (thumbnailBytes < 1) throw new CryptoError('This file has no thumbnail.');
    const start = ciphertextSize(plaintextSize);
    return { start, end: start + trailerLength(thumbnailBytes) - 1 };
}
/*
 * What the server can know about the parts of an object it was told has
 * `chunkCount` chunks and `ciphertextSize` bytes: every part but the last is a
 * full chunk with its tag, and the last is the rest, which holds the last
 * chunk and the trailer. Part numbers are 1-based, as the store counts them.
 */
export function partLength(ciphertextSize: number, chunkCount: number, partNumber: number) {
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > chunkCount)
        throw new CryptoError('Invalid part number.');
    if (partNumber < chunkCount) return CHUNK_SIZE + CHUNK_TAG_BYTES;
    return ciphertextSize - (chunkCount - 1) * (CHUNK_SIZE + CHUNK_TAG_BYTES);
}
/*
 * Whether an object of `chunkCount` chunks can be `ciphertextSize` bytes long:
 * the last part must hold at least an empty chunk's tag (one byte more unless
 * the file is a single chunk) and at most a full chunk and a full trailer.
 */
export function validObjectSize(ciphertextSize: number, chunkCount: number) {
    if (
        !Number.isSafeInteger(ciphertextSize) ||
        !Number.isSafeInteger(chunkCount) ||
        chunkCount < 1 ||
        ciphertextSize < 0
    )
        return false;
    const last = partLength(ciphertextSize, chunkCount, chunkCount);
    const least = chunkCount === 1 ? CHUNK_TAG_BYTES : CHUNK_TAG_BYTES + 1;
    return (
        last >= least &&
        last <= CHUNK_SIZE + CHUNK_TAG_BYTES + THUMBNAIL_MAX_BYTES + CHUNK_TAG_BYTES
    );
}
export function chunkPlaintextLength(plaintextSize: number, index: number) {
    const count = chunkCount(plaintextSize);
    if (!Number.isSafeInteger(index) || index < 0 || index >= count)
        throw new CryptoError('Invalid chunk index.');
    return index < count - 1 ? CHUNK_SIZE : plaintextSize - index * CHUNK_SIZE;
}
export function chunkCiphertextLength(plaintextSize: number, index: number) {
    return chunkPlaintextLength(plaintextSize, index) + CHUNK_TAG_BYTES;
}
/* Byte range of chunk `index` inside the stored object. */
export function chunkRange(plaintextSize: number, index: number) {
    const start = index * (CHUNK_SIZE + CHUNK_TAG_BYTES);
    return { start, end: start + chunkCiphertextLength(plaintextSize, index) - 1 };
}

export function generateContentNonce() {
    return crypto.getRandomValues(new Uint8Array(CONTENT_NONCE_BYTES));
}
export function chunkNonce(contentNonce: Uint8Array, index: number) {
    if (contentNonce.length !== CONTENT_NONCE_BYTES)
        throw new CryptoError('Invalid content nonce.');
    const nonce = new Uint8Array(ENVELOPE_NONCE_BYTES);
    nonce.set(contentNonce, 0);
    new DataView(nonce.buffer).setBigUint64(CONTENT_NONCE_BYTES, BigInt(index), false);
    return nonce;
}
export function chunkContext(ctx: ChunkContext) {
    return context([
        'hushos/drive/content',
        suite(ctx.suite),
        id(ctx.workspaceId, 'workspace id'),
        id(ctx.objectId, 'object id'),
        ctx.index,
        ctx.chunkCount,
        ctx.plaintextSize,
    ]);
}
export function thumbnailContext(ctx: ThumbnailContext) {
    return context([
        'hushos/drive/thumbnail',
        CONTENT_SUITE,
        id(ctx.workspaceId, 'workspace id'),
        id(ctx.objectId, 'object id'),
        ctx.thumbnailBytes,
    ]);
}

/*
 * Encrypts one chunk. The plaintext must be exactly the length the arithmetic
 * gives that index, so a caller cannot produce an object the reader will refuse.
 */
export async function encryptChunk(
    plaintext: Uint8Array,
    contentKey: Uint8Array,
    contentNonce: Uint8Array,
    ctx: ChunkContext,
) {
    await sodium.ready;
    if (
        ctx.chunkCount !== chunkCount(ctx.plaintextSize) ||
        plaintext.length !== chunkPlaintextLength(ctx.plaintextSize, ctx.index)
    )
        throw new CryptoError('Invalid chunk.');
    return new Uint8Array(
        sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            plaintext,
            chunkContext(ctx),
            null,
            chunkNonce(contentNonce, ctx.index),
            contentKey,
        ),
    );
}
export async function decryptChunk(
    ciphertext: Uint8Array,
    contentKey: Uint8Array,
    contentNonce: Uint8Array,
    ctx: ChunkContext,
) {
    await sodium.ready;
    if (
        ctx.chunkCount !== chunkCount(ctx.plaintextSize) ||
        ciphertext.length !== chunkCiphertextLength(ctx.plaintextSize, ctx.index)
    )
        throw new CryptoError('This file could not be decrypted. It may be damaged.');
    try {
        return new Uint8Array(
            sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                null,
                ciphertext,
                chunkContext(ctx),
                chunkNonce(contentNonce, ctx.index),
                contentKey,
            ),
        );
    } catch {
        throw new CryptoError('This file could not be decrypted. It may be damaged.');
    }
}

/*
 * The thumbnail trailer: the rendered WebP under the key derived for that role,
 * with the nonce index after the last chunk's, bound to the object and its own
 * length. The content key never opens it, and it never opens as a chunk.
 */
export async function encryptThumbnail(
    webp: Uint8Array,
    contentKey: Uint8Array,
    contentNonce: Uint8Array,
    ctx: Omit<ThumbnailContext, 'thumbnailBytes'>,
) {
    await sodium.ready;
    if (webp.length < 1 || webp.length > THUMBNAIL_MAX_BYTES)
        throw new CryptoError('Invalid thumbnail size.');
    const key = await thumbnailKey(contentKey);
    try {
        return new Uint8Array(
            sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
                webp,
                thumbnailContext({ ...ctx, thumbnailBytes: webp.length }),
                null,
                chunkNonce(contentNonce, chunkCount(ctx.plaintextSize)),
                key,
            ),
        );
    } finally {
        key.fill(0);
    }
}
export async function decryptThumbnail(
    ciphertext: Uint8Array,
    contentKey: Uint8Array,
    contentNonce: Uint8Array,
    ctx: ThumbnailContext,
) {
    await sodium.ready;
    if (ciphertext.length !== trailerLength(ctx.thumbnailBytes) || ctx.thumbnailBytes < 1)
        throw new CryptoError('This thumbnail could not be decrypted. It may be damaged.');
    const key = await thumbnailKey(contentKey);
    try {
        return new Uint8Array(
            sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                null,
                ciphertext,
                thumbnailContext(ctx),
                chunkNonce(contentNonce, chunkCount(ctx.plaintextSize)),
                key,
            ),
        );
    } catch {
        throw new CryptoError('This thumbnail could not be decrypted. It may be damaged.');
    } finally {
        key.fill(0);
    }
}

/* BLAKE2b of a plaintext chunk, for the upload journal. */
export async function chunkDigest(plaintext: Uint8Array) {
    await sodium.ready;
    return new Uint8Array(sodium.crypto_generichash(32, plaintext, null));
}
