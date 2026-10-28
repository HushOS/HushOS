import sodium from 'libsodium-wrappers';
import { CryptoError } from './errors';
import { paddedLength } from './padding';
import { encryptKey, decryptKey } from './aead';
import { encode } from './keys';

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
 * Content suite 3, the one written, pads every object to a Padmé bucket (see
 * paddedLength and docs/integrity-design.md). Suite 2 is the same framing
 * without the padding: the thumbnail sealed as a trailer of the object and a
 * version envelope that carries the plaintext size and the trailer's length.
 * Suite 1 kept the size on the object row. Both are read forever and never
 * written again.
 */
export const CONTENT_SUITE = 3;
export const UNPADDED_CONTENT_SUITE = 2;
export const LEGACY_CONTENT_SUITE = 1;
export const READABLE_CONTENT_SUITES: readonly number[] = [
    LEGACY_CONTENT_SUITE,
    UNPADDED_CONTENT_SUITE,
    CONTENT_SUITE,
];
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
/*
 * A workspace document is one sealed JSON value the workspace keeps beside its
 * tree: the tag registry today. Members open it with the workspace key; the
 * server holds the envelope, a kind and a version, and nothing else.
 */
export const DOCUMENT_MAX_BYTES = 1024 * 1024;
/*
 * Plaintext is padded before sealing so a ciphertext's length says little about
 * its content: metadata to 256-byte steps, so a name's length and a rename's
 * size are hidden; a document in steps that grow with it, so the count of what
 * it holds is a coarse bucket. The padding is trailing whitespace, which JSON
 * ignores, so envelopes sealed before padding open unchanged.
 */
export const METADATA_PAD_STEP = 256;
export function documentPadStep(length: number) {
    if (length <= 64 * 1024) return 1024;
    if (length <= 256 * 1024) return 4 * 1024;
    return 16 * 1024;
}
function padded(plaintext: Uint8Array, step: number, max: number) {
    const target = Math.min(Math.ceil(plaintext.length / step) * step, max);
    if (target <= plaintext.length) return plaintext;
    const out = new Uint8Array(target);
    out.set(plaintext);
    out.fill(0x20, plaintext.length);
    return out;
}
export const DOCUMENT_ENVELOPE_MAX_BYTES =
    ENVELOPE_NONCE_BYTES + DOCUMENT_MAX_BYTES + CHUNK_TAG_BYTES;
const DOCUMENT_KIND = /^[a-z][a-z0-9-]{0,31}$/;

/*
 * Attributes: plain data a feature keeps on a node (a folder's colour), as
 * short lowercase keys to strings, sealed beside the name. A client carries
 * every key through unchanged whenever it seals the record again, the ones it
 * does not know included, so a feature can add one without the others losing
 * it. New plain data goes here: top-level fields nobody knows are dropped.
 * Limits: keys match ATTRIBUTE_KEY, at most ATTRIBUTES_MAX_KEYS of them, every
 * value a string, and the whole plaintext within METADATA_MAX_BYTES. A record
 * that breaks one is refused, sealing and opening, never trimmed. None is
 * written as no `attributes` field at all, so a record without any seals to
 * exactly what it did before attributes; keys are written in sorted order.
 */
export const ATTRIBUTE_KEY = /^[a-z][a-z0-9_-]{0,31}$/;
export const ATTRIBUTES_MAX_KEYS = 32;
export type NodeAttributes = Record<string, string>;

export type NodeMetadata = {
    name: string;
    mime: string | null;
    size: number | null;
    modified: string | null;
    /*
     * Absent for none, as on the wire: openMetadata leaves it out of a record
     * that has none, and sealMetadata writes none for `{}`.
     */
    attributes?: NodeAttributes;
};

export type NodeKeyContext = {
    workspaceId: string;
    nodeId: string;
    parentId: string;
    parentKeyEpoch: number;
    keyEpoch: number;
};
export type MetadataContext = { workspaceId: string; nodeId: string; metadataVersion: number };
export type DocumentContext = { workspaceId: string; kind: string; version: number };
export type ContentKeyContext = {
    workspaceId: string;
    nodeId: string;
    versionId: string;
    objectId: string;
    /* The object's content suite: 2 and 3 seal the sizes with the key, 1 the key alone. */
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
    /* The file's real size, bound in the associated data. */
    plaintextSize: number;
    /* The trailer's thumbnail: under suite 3 it decides how much padding the chunks carry. */
    thumbnailBytes: number;
};
export type ThumbnailContext = {
    workspaceId: string;
    objectId: string;
    suite: number;
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
function checkSuite(value: number) {
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
/*
 * A group area root's previous key wrapped under the new area key by a roster
 * rotation (option A, docs/groups-server.md 8): the same fields as a node key
 * envelope under a label of its own, so it opens only through the previous
 * envelope path and can never pass as the root's current key, which a removed
 * member holds.
 */
export function previousRootKeyContext(ctx: NodeKeyContext) {
    return context([
        'hushos/drive/previous-root-key',
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
export function documentContext(ctx: DocumentContext) {
    if (typeof ctx.kind !== 'string' || !DOCUMENT_KIND.test(ctx.kind))
        throw new CryptoError('Invalid document kind.');
    return context([
        'hushos/drive/workspace-doc',
        DRIVE_ENVELOPE_SUITE,
        id(ctx.workspaceId, 'workspace id'),
        ctx.kind,
        epoch(ctx.version, 'document version'),
    ]);
}
export function contentKeyContext(ctx: ContentKeyContext) {
    return context([
        'hushos/drive/content-key',
        checkSuite(ctx.suite),
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

/* A group area root's previous key under the new area key (previousRootKeyContext). 72 bytes. */
export async function wrapPreviousRootKey(
    rootKey: Uint8Array,
    areaKey: Uint8Array,
    ctx: NodeKeyContext,
) {
    if (rootKey.length !== KEY_BYTES) throw new CryptoError('Invalid node key.');
    if (ctx.parentId !== ctx.workspaceId) throw new CryptoError('Invalid node key.');
    return seal(rootKey, areaKey, previousRootKeyContext(ctx));
}
export async function openPreviousRootKey(
    envelope: Uint8Array,
    areaKey: Uint8Array,
    ctx: NodeKeyContext,
) {
    const { nonce, body } = split(envelope, KEY_BYTES + CHUNK_TAG_BYTES);
    const key = await decryptKey(body, areaKey, nonce, previousRootKeyContext(ctx));
    if (key.length !== KEY_BYTES) {
        key.fill(0);
        throw new CryptoError('Invalid node key.');
    }
    return key;
}

/*
 * UTF-8 as Rust's String::from_utf8 reads it: invalid bytes throw rather than
 * become U+FFFD, and a leading byte order mark is kept (so JSON.parse refuses
 * it, as serde does) rather than dropped.
 */
function strictText(bytes: Uint8Array) {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

/*
 * Whether JSON text JSON.parse already accepted names one key twice in any
 * object, escapes decoded ("colour" and "\u0063olour" are the same key).
 */
export function hasDuplicateKey(text: string) {
    // One entry per open object (its keys so far) or array (null).
    const open: (Set<string> | null)[] = [];
    let keyNext = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            let end = i + 1;
            while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
            const keys = open.at(-1);
            if (keys && keyNext) {
                const key = JSON.parse(text.slice(i, end + 1)) as string;
                if (keys.has(key)) return true;
                keys.add(key);
                keyNext = false;
            }
            i = end;
        } else if (c === '{') {
            open.push(new Set());
            keyNext = true;
        } else if (c === '[') {
            open.push(null);
            keyNext = false;
        } else if (c === '}' || c === ']') {
            open.pop();
            keyNext = false;
        } else if (c === ',') keyNext = open.at(-1) instanceof Set;
    }
    return false;
}

/* A lone surrogate: JSON.parse makes one from "\ud800", TextEncoder would not keep it, Rust refuses it. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
/*
 * A node's attributes as sealed: `undefined` is none, anything else must be a
 * plain object within the limits. Returns a fresh object with its keys sorted.
 */
export function checkAttributes(attributes: unknown): NodeAttributes {
    if (attributes === undefined) return {};
    if (
        typeof attributes !== 'object' ||
        attributes === null ||
        Array.isArray(attributes) ||
        (Object.getPrototypeOf(attributes) !== Object.prototype &&
            Object.getPrototypeOf(attributes) !== null)
    )
        throw new CryptoError('Invalid attributes.');
    const keys = Object.keys(attributes);
    if (keys.length > ATTRIBUTES_MAX_KEYS)
        throw new CryptoError(`An item can have at most ${ATTRIBUTES_MAX_KEYS} attributes.`);
    const out: NodeAttributes = {};
    for (const key of keys.sort()) {
        if (!ATTRIBUTE_KEY.test(key)) throw new CryptoError('Invalid attribute name.');
        const value = (attributes as Record<string, unknown>)[key];
        if (typeof value !== 'string' || LONE_SURROGATE.test(value))
            throw new CryptoError('An attribute must be text.');
        out[key] = value;
    }
    return out;
}

export async function sealMetadata(
    metadata: NodeMetadata,
    nodeKey: Uint8Array,
    ctx: MetadataContext,
) {
    const attributes = checkAttributes(metadata.attributes);
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
    // None is no field at all: such a record seals exactly as one from before attributes.
    if (Object.keys(attributes).length) clean.attributes = attributes;
    const plaintext = new TextEncoder().encode(JSON.stringify(clean));
    if (plaintext.length > METADATA_MAX_BYTES)
        throw new CryptoError(
            clean.attributes
                ? 'This name and its attributes are too long to save.'
                : 'This name is too long.',
        );
    return seal(
        padded(plaintext, METADATA_PAD_STEP, METADATA_MAX_BYTES),
        nodeKey,
        metadataContext(ctx),
    );
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
        const text = strictText(plaintext);
        parsed = JSON.parse(text);
        // JSON.parse keeps the last of two equal keys; serde refuses them, and so does this.
        if (hasDuplicateKey(text)) throw new CryptoError('Duplicate key.');
    } catch {
        throw new CryptoError('This item could not be opened. It may be damaged.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new CryptoError('This item could not be opened. It may be damaged.');
    const value = parsed as Record<string, unknown>;
    let attributes: NodeAttributes;
    try {
        attributes = checkAttributes(value.attributes);
    } catch {
        // Refused whole, never trimmed: a re-save would otherwise drop what it could not read.
        throw new CryptoError('This item could not be opened. It may be damaged.');
    }
    return {
        name: checkName(value.name as string),
        mime: typeof value.mime === 'string' ? value.mime : null,
        size:
            typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0
                ? value.size
                : null,
        modified: typeof value.modified === 'string' ? value.modified : null,
        ...(Object.keys(attributes).length ? { attributes } : {}),
    };
}

/* Suite 1's envelope: the content key alone under the file's node key. 72 bytes; read, never written. */

/* A workspace document sealed under the workspace key, bound to its kind and the version it becomes. */
export async function sealDocument(
    document: unknown,
    workspaceKey: Uint8Array,
    ctx: DocumentContext,
) {
    let plaintext: Uint8Array;
    try {
        plaintext = new TextEncoder().encode(JSON.stringify(document));
    } catch {
        throw new CryptoError('This document cannot be saved.');
    }
    if (document === undefined || plaintext.length > DOCUMENT_MAX_BYTES)
        throw new CryptoError('This document is too large to save.');
    return seal(
        padded(plaintext, documentPadStep(plaintext.length), DOCUMENT_MAX_BYTES),
        workspaceKey,
        documentContext(ctx),
    );
}
export async function openDocument(
    envelope: Uint8Array,
    workspaceKey: Uint8Array,
    ctx: DocumentContext,
): Promise<unknown> {
    await sodium.ready;
    const { nonce, body } = split(envelope);
    if (body.length > DOCUMENT_MAX_BYTES + CHUNK_TAG_BYTES)
        throw new CryptoError('This encrypted envelope is damaged.');
    const aad = documentContext(ctx);
    let plaintext: Uint8Array;
    try {
        plaintext = new Uint8Array(
            sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, body, aad, nonce, workspaceKey),
        );
    } catch {
        throw new CryptoError('This document could not be opened. It may be damaged.');
    }
    try {
        return JSON.parse(strictText(plaintext));
    } catch {
        throw new CryptoError('This document could not be opened. It may be damaged.');
    }
}
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
    if (checkSuite(ctx.suite) === LEGACY_CONTENT_SUITE) {
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
    if (checkSuite(ctx.suite) === LEGACY_CONTENT_SUITE)
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

/*
 * Re-keyed records (docs/integrity-design.md, "Re-keyed records"). A rotation
 * that keeps the writer's record (its origin) seals the same bytes again under
 * the fresh node key and hands readers a key that opens the origin alone.
 */

/* The longest metadata envelope: the padded maximum, its nonce and its tag. */
export const METADATA_ENVELOPE_MAX_BYTES =
    ENVELOPE_NONCE_BYTES + METADATA_MAX_BYTES + CHUNK_TAG_BYTES;
/* A version envelope's length in its suite: the key alone under suite 1, the record under 2 and 3. */
export function versionEnvelopeBytes(suite: number) {
    return checkSuite(suite) === LEGACY_CONTENT_SUITE ? KEY_ENVELOPE_BYTES : VERSION_ENVELOPE_BYTES;
}

function key32(key: Uint8Array, what: string) {
    if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES)
        throw new CryptoError(`Invalid ${what}.`);
    return key;
}

/*
 * The plaintext of an envelope exactly as it was sealed, padding and all:
 * for the re-keyed binding, which compares bytes and never parses.
 */
export async function openEnvelopeBytes(envelope: Uint8Array, key: Uint8Array, aad: Uint8Array) {
    const { nonce, body } = split(envelope);
    return decryptKey(body, key32(key, 'key'), nonce, aad);
}

/*
 * A raw re-seal: the plaintext exactly as it was sealed (padding, field order
 * and all) sealed again under `newKey` with a fresh nonce and the same
 * associated data. Nothing is parsed or cleaned, so a re-keyed record's origin
 * and its current envelope hold the same bytes and a reader can compare them.
 */
export async function rekeyEnvelope(
    envelope: Uint8Array,
    oldKey: Uint8Array,
    newKey: Uint8Array,
    aad: Uint8Array,
) {
    key32(newKey, 'key');
    const plaintext = await openEnvelopeBytes(envelope, oldKey, aad);
    try {
        return await seal(plaintext, newKey, aad);
    } finally {
        plaintext.fill(0);
    }
}

/* ChaCha20's quarter round on four words of the state. */
function quarter(x: Uint32Array, a: number, b: number, c: number, d: number) {
    x[a] = (x[a]! + x[b]!) | 0;
    x[d] = rotl(x[d]! ^ x[a]!, 16);
    x[c] = (x[c]! + x[d]!) | 0;
    x[b] = rotl(x[b]! ^ x[c]!, 12);
    x[a] = (x[a]! + x[b]!) | 0;
    x[d] = rotl(x[d]! ^ x[a]!, 8);
    x[c] = (x[c]! + x[d]!) | 0;
    x[b] = rotl(x[b]! ^ x[c]!, 7);
}
function rotl(value: number, bits: number) {
    return (value << bits) | (value >>> (32 - bits));
}

/*
 * HChaCha20 (draft-irtf-cfrg-xchacha, 2.2): the ChaCha20 state over the key
 * and a 16-byte input, twenty rounds, no feed-forward; words 0-3 and 12-15
 * are the subkey. libsodium-wrappers 0.8.4 does not export
 * crypto_core_hchacha20, so it is written out here, pinned by the draft's
 * known answer and by opening libsodium's own XChaCha20-Poly1305 envelopes.
 */
function hchacha20(key: Uint8Array, input: Uint8Array) {
    const view = (bytes: Uint8Array) =>
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const x = new Uint32Array(16);
    x.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
    for (let i = 0; i < 8; i++) x[4 + i] = view(key).getUint32(i * 4, true);
    for (let i = 0; i < 4; i++) x[12 + i] = view(input).getUint32(i * 4, true);
    for (let round = 0; round < 10; round++) {
        quarter(x, 0, 4, 8, 12);
        quarter(x, 1, 5, 9, 13);
        quarter(x, 2, 6, 10, 14);
        quarter(x, 3, 7, 11, 15);
        quarter(x, 0, 5, 10, 15);
        quarter(x, 1, 6, 11, 12);
        quarter(x, 2, 7, 8, 13);
        quarter(x, 3, 4, 9, 14);
    }
    const out = new Uint8Array(KEY_BYTES);
    const words = [0, 1, 2, 3, 12, 13, 14, 15];
    for (const [i, word] of words.entries()) view(out).setUint32(i * 4, x[word]!, true);
    x.fill(0);
    return out;
}

/*
 * The key that opens this one envelope and nothing else `key` sealed:
 * XChaCha20-Poly1305's own subkey, HChaCha20 of the key and the first 16
 * bytes of the envelope's nonce. A rotation wraps it under the fresh node key
 * (wrapOriginKey) instead of handing out the old node key, which still opens
 * what was moved out of the folder before the rotation.
 */
export function originOpeningKey(envelope: Uint8Array, key: Uint8Array) {
    const { nonce } = split(envelope);
    return hchacha20(key32(key, 'node key'), nonce.subarray(0, 16));
}

/*
 * An envelope opened with its opening key: ChaCha20-Poly1305 (IETF) under the
 * subkey, the nonce four zero bytes and then the envelope nonce's last eight,
 * which is what XChaCha20-Poly1305 does after deriving it.
 */
export async function openWithOriginKey(
    envelope: Uint8Array,
    originKey: Uint8Array,
    aad: Uint8Array,
) {
    await sodium.ready;
    const { nonce, body } = split(envelope);
    const ietf = new Uint8Array(12);
    ietf.set(nonce.subarray(16), 4);
    try {
        return new Uint8Array(
            sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
                null,
                body,
                aad,
                ietf,
                key32(originKey, 'origin key'),
            ),
        );
    } catch (error) {
        if (error instanceof CryptoError) throw error;
        throw new CryptoError('This item could not be opened. It may be damaged.');
    }
}

/* Which record an origin is: a node's metadata at a metadata version, or one version of a file. */
export type OriginRecord =
    | { kind: 'metadata'; metadataVersion: number }
    | { kind: 'version'; versionId: string };
/* What binds a wrapped origin key: the node, the record, the node key's epoch, and the origin it opens. */
export type OriginKeyContext = {
    workspaceId: string;
    nodeId: string;
    keyEpoch: number;
    record: OriginRecord;
    originEnvelope: Uint8Array;
};

/*
 * ["hushos/drive/origin-key", 1, ws, nodeId, "metadata", metadataVersion, keyEpoch, sha256(originEnvelope)]
 * ["hushos/drive/origin-key", 1, ws, nodeId, "version", versionId, keyEpoch, sha256(originEnvelope)]
 * Its own label: the wrapped origin key is 72 bytes, as a node key or a legacy
 * content key envelope is, and must never open as either.
 */
export async function originKeyContext(ctx: OriginKeyContext) {
    const record = ctx.record;
    let position: unknown[];
    if (record?.kind === 'metadata')
        position = ['metadata', epoch(record.metadataVersion, 'metadata version')];
    else if (record?.kind === 'version') position = ['version', id(record.versionId, 'version id')];
    else throw new CryptoError('Invalid origin.');
    if (!(ctx.originEnvelope instanceof Uint8Array)) throw new CryptoError('Invalid origin.');
    const digest = encode(
        new Uint8Array(await crypto.subtle.digest('SHA-256', ctx.originEnvelope.slice())),
    );
    return context([
        'hushos/drive/origin-key',
        DRIVE_ENVELOPE_SUITE,
        id(ctx.workspaceId, 'workspace id'),
        id(ctx.nodeId, 'node id'),
        ...position,
        epoch(ctx.keyEpoch, 'key epoch'),
        digest,
    ]);
}

/* An origin's opening key under the node key at the epoch it now has: the 72-byte originKeyEnvelope. */
export async function wrapOriginKey(
    originKey: Uint8Array,
    nodeKey: Uint8Array,
    ctx: OriginKeyContext,
) {
    key32(originKey, 'origin key');
    return seal(originKey, key32(nodeKey, 'node key'), await originKeyContext(ctx));
}
export async function openOriginKey(
    envelope: Uint8Array,
    nodeKey: Uint8Array,
    ctx: OriginKeyContext,
) {
    const { nonce, body } = split(envelope, KEY_BYTES + CHUNK_TAG_BYTES);
    const key = await decryptKey(
        body,
        key32(nodeKey, 'node key'),
        nonce,
        await originKeyContext(ctx),
    );
    if (key.length !== KEY_BYTES) {
        key.fill(0);
        throw new CryptoError('Invalid origin key.');
    }
    return key;
}

/* The thumbnail's key is derived for that one role; the content key never opens it. */
export async function thumbnailKey(contentKey: Uint8Array) {
    await sodium.ready;
    if (contentKey.length !== KEY_BYTES) throw new CryptoError('Invalid content key.');
    return new Uint8Array(sodium.crypto_kdf_derive_from_key(KEY_BYTES, 1, 'hushthmb', contentKey));
}

/* Chunk arithmetic: chunks over a stream of `length` bytes. An empty stream is one 16-byte chunk. */
export function chunkCount(length: number) {
    if (!Number.isSafeInteger(length) || length < 0) throw new CryptoError('Invalid file size.');
    return Math.max(1, Math.ceil(length / CHUNK_SIZE));
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
/* Padmé lives in ./padding, which loads nothing else, so a public page can show it. */
export { paddedLength };
/*
 * What the chunks of an object cover: under suite 3 the file and then zeros,
 * so that chunks and trailer together come to a Padmé bucket; under suites 1
 * and 2 the file alone.
 */
export function contentLength(suite: number, plaintextSize: number, thumbnailBytes: number) {
    byteCount(plaintextSize, 'file size');
    const trailer = trailerLength(thumbnailBytes);
    if (checkSuite(suite) < CONTENT_SUITE) return plaintextSize;
    return paddedLength(plaintextSize + trailer) - trailer;
}
/* The whole object: every chunk with its tag, then the trailer when there is one. */
export function ciphertextSize(suite: number, plaintextSize: number, thumbnailBytes: number) {
    const length = contentLength(suite, plaintextSize, thumbnailBytes);
    return length + CHUNK_TAG_BYTES * chunkCount(length) + trailerLength(thumbnailBytes);
}
/*
 * The bytes to fetch for a thumbnail: always the object's last 64 KiB and a tag
 * (or all of it, when smaller), whatever the trailer's length. Asking for the
 * trailer's own range would hand the store its length and with it the file's
 * exact size; decryptThumbnail takes the trailer from the end of the window.
 */
export function thumbnailRange(suite: number, plaintextSize: number, thumbnailBytes: number) {
    if (thumbnailBytes < 1) throw new CryptoError('This file has no thumbnail.');
    const end = ciphertextSize(suite, plaintextSize, thumbnailBytes) - 1;
    return { start: Math.max(0, end + 1 - trailerLength(THUMBNAIL_MAX_BYTES)), end };
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
/* The plaintext of chunk `index` of a stream of `length` bytes. */
export function chunkPlaintextLength(length: number, index: number) {
    const count = chunkCount(length);
    if (!Number.isSafeInteger(index) || index < 0 || index >= count)
        throw new CryptoError('Invalid chunk index.');
    return index < count - 1 ? CHUNK_SIZE : length - index * CHUNK_SIZE;
}
export function chunkCiphertextLength(length: number, index: number) {
    return chunkPlaintextLength(length, index) + CHUNK_TAG_BYTES;
}
/*
 * The bytes to fetch for chunk `index`. The last chunk runs on to the end of
 * the object, thumbnail trailer and all: a range that stopped where the trailer
 * begins would hand the store the trailer's length and so the file's exact
 * size. decryptChunk takes the chunk from the front of what comes back.
 */
export function chunkRange(
    suite: number,
    plaintextSize: number,
    thumbnailBytes: number,
    index: number,
) {
    const length = contentLength(suite, plaintextSize, thumbnailBytes);
    const start = index * (CHUNK_SIZE + CHUNK_TAG_BYTES);
    if (index === chunkCount(length) - 1)
        return { start, end: ciphertextSize(suite, plaintextSize, thumbnailBytes) - 1 };
    return { start, end: start + chunkCiphertextLength(length, index) - 1 };
}
/*
 * The part of chunk `index`'s plaintext that is the file: under suite 3 the
 * chunks run on past the file into zeros, which a reader drops. A chunk past
 * the file's end gives nothing; it is still fetched (see driveDownloadOpen).
 */
export function fileBytesOf(chunk: Uint8Array, plaintextSize: number, index: number) {
    const start = index * CHUNK_SIZE;
    return chunk.subarray(0, Math.max(0, Math.min(chunk.length, plaintextSize - start)));
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
        checkSuite(ctx.suite),
        id(ctx.workspaceId, 'workspace id'),
        id(ctx.objectId, 'object id'),
        ctx.index,
        ctx.chunkCount,
        ctx.plaintextSize,
    ]);
}
export function thumbnailContext(ctx: ThumbnailContext) {
    // Suite 1 has no trailer; suites 2 and 3 bind their own number, so a trailer is one suite's.
    if (checkSuite(ctx.suite) === LEGACY_CONTENT_SUITE)
        throw new CryptoError('This file was stored without room for a thumbnail.');
    return context([
        'hushos/drive/thumbnail',
        ctx.suite,
        id(ctx.workspaceId, 'workspace id'),
        id(ctx.objectId, 'object id'),
        ctx.thumbnailBytes,
    ]);
}

/*
 * A chunk's context must agree with itself: the count is the one the suite's
 * layout gives the file and its trailer. Returns what the chunks cover.
 */
function checkChunkContext(ctx: ChunkContext) {
    const length = contentLength(ctx.suite, ctx.plaintextSize, ctx.thumbnailBytes);
    if (ctx.chunkCount !== chunkCount(length)) throw new CryptoError('Invalid chunk.');
    return length;
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
    if (plaintext.length !== chunkPlaintextLength(checkChunkContext(ctx), ctx.index))
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
    // The last chunk may come with the trailer behind it (see chunkRange); every other must be exact.
    let length: number;
    try {
        length = chunkCiphertextLength(checkChunkContext(ctx), ctx.index);
    } catch {
        throw new CryptoError('This file could not be decrypted. It may be damaged.');
    }
    const last = ctx.index === ctx.chunkCount - 1;
    if (last ? ciphertext.length < length : ciphertext.length !== length)
        throw new CryptoError('This file could not be decrypted. It may be damaged.');
    try {
        return new Uint8Array(
            sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                null,
                ciphertext.subarray(0, length),
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
                chunkNonce(
                    contentNonce,
                    chunkCount(contentLength(ctx.suite, ctx.plaintextSize, webp.length)),
                ),
                key,
            ),
        );
    } finally {
        key.fill(0);
    }
}
/* `fetched` is the window thumbnailRange asks for, or just the trailer: the trailer is its end. */
export async function decryptThumbnail(
    fetched: Uint8Array,
    contentKey: Uint8Array,
    contentNonce: Uint8Array,
    ctx: ThumbnailContext,
) {
    await sodium.ready;
    const length = trailerLength(ctx.thumbnailBytes);
    if (fetched.length < length || ctx.thumbnailBytes < 1)
        throw new CryptoError('This thumbnail could not be decrypted. It may be damaged.');
    const ciphertext = fetched.subarray(fetched.length - length);
    const key = await thumbnailKey(contentKey);
    try {
        return new Uint8Array(
            sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                null,
                ciphertext,
                thumbnailContext(ctx),
                chunkNonce(
                    contentNonce,
                    chunkCount(contentLength(ctx.suite, ctx.plaintextSize, ctx.thumbnailBytes)),
                ),
                key,
            ),
        );
    } catch {
        throw new CryptoError('This thumbnail could not be decrypted. It may be damaged.');
    } finally {
        key.fill(0);
    }
}

/*
 * BLAKE2b of a plaintext chunk for the upload journal, keyed under a subkey of
 * the upload's content key: the journal keeps these on the device, and an
 * unkeyed hash would let anyone holding the device confirm a guessed file.
 */
export async function chunkDigest(plaintext: Uint8Array, contentKey: Uint8Array) {
    await sodium.ready;
    const key = sodium.crypto_kdf_derive_from_key(32, 2, 'hushjrnl', contentKey);
    try {
        return new Uint8Array(sodium.crypto_generichash(32, plaintext, key));
    } finally {
        key.fill(0);
    }
}
