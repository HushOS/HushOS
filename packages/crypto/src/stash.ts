import { CryptoError } from './errors';

/*
 * Stashed upload bytes, sealed. A copy saved out of a share has no file on the
 * person's disk to reopen after a reload, so the web app keeps its bytes in
 * the browser's private file system until the upload is done; what it writes
 * there is this sealing of them, never the bytes themselves.
 *
 * The key is derived from the account key (HKDF, `hushos/stash/v1`, with the
 * user id), as editing's drafts are (editing-design.md): only an unlocked
 * session of this account can open a stash, a locked browser cannot, and the
 * key is never stored. Sealing and opening run in the crypto worker, so the
 * key never reaches the page (drive-design.md, keys stay in the worker).
 *
 * Format: a header of "HSS1", the chunk size, the total length and 8 random
 * bytes that start every chunk's nonce (the chunk's index ends it); then each
 * chunk sealed with AES-256-GCM. Every chunk's associated data is the whole
 * header, the stash's name and the chunk's index, so chunks can't be
 * reordered, dropped, cut short, moved between stashes or given another
 * header without failing.
 */

const MAGIC = [0x48, 0x53, 0x53, 0x31]; // "HSS1"
const HEADER_BYTES = 4 + 4 + 8 + 8;
const TAG_BYTES = 16;
/* One upload chunk (drive.ts CHUNK_SIZE): a stash is read in the pieces the upload sends. */
export const STASH_CHUNK_BYTES = 8 * 1024 * 1024;
const LABEL = 'hushos/stash/v1';
const MAX_UINT32 = 2 ** 32;

/* A stash that doesn't open: damaged, another account's, or another stash's bytes. */
export class StashError extends CryptoError {}

/* Whether an error (or one carried across the worker as its message) says the stash is lost. */
export function stashLost(error: unknown) {
    return error instanceof Error && error.message.startsWith('This stash ');
}

/* The account's stash key, non-extractable. The caller passes the 32-byte account root and zeroes it. */
export async function deriveStashKey(root: Uint8Array<ArrayBuffer>, userId: string) {
    if (root.byteLength !== 32) throw new CryptoError('Invalid account key.');
    const material = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new Uint8Array(32),
            info: new TextEncoder().encode(`${LABEL}:${userId.toLowerCase()}`),
        },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

function associated(header: Uint8Array, name: string, index: number) {
    const tail = new TextEncoder().encode(`|${LABEL}|${name}|${index}`);
    const out = new Uint8Array(header.byteLength + tail.byteLength);
    out.set(header, 0);
    out.set(tail, header.byteLength);
    return out;
}

function nonceOf(prefix: Uint8Array, index: number) {
    const nonce = new Uint8Array(12);
    nonce.set(prefix, 0);
    new DataView(nonce.buffer).setUint32(8, index);
    return nonce;
}

function chunkCount(total: number, chunk: number) {
    return Math.max(1, Math.ceil(total / chunk));
}

/* The header, then each sealed chunk, in order: what is written to disk, end to end. */
export async function sealStash(
    key: CryptoKey,
    name: string,
    bytes: Uint8Array,
    chunk = STASH_CHUNK_BYTES,
) {
    const total = bytes.byteLength;
    const count = chunkCount(total, chunk);
    // The index ends the nonce in four bytes, and the header holds the chunk size in four.
    if (!Number.isInteger(chunk) || chunk < 1 || chunk >= MAX_UINT32 || count >= MAX_UINT32)
        throw new CryptoError('This file is too large to stash.');
    const header = new Uint8Array(HEADER_BYTES);
    header.set(MAGIC, 0);
    const view = new DataView(header.buffer);
    view.setUint32(4, chunk);
    view.setBigUint64(8, BigInt(total));
    const prefix = crypto.getRandomValues(new Uint8Array(8));
    header.set(prefix, 16);
    const parts: Uint8Array<ArrayBuffer>[] = [header];
    for (let index = 0; index < count; index++) {
        const plain = bytes.subarray(index * chunk, Math.min(total, (index + 1) * chunk));
        const sealed = await crypto.subtle.encrypt(
            {
                name: 'AES-GCM',
                iv: nonceOf(prefix, index),
                additionalData: associated(header, name, index),
            },
            key,
            plain as BufferSource,
        );
        parts.push(new Uint8Array(sealed));
    }
    return parts;
}

/*
 * Opens the stash called `name` from its stored bytes, chunk by chunk, and
 * returns the plaintext in parts. Anything that doesn't open, under this key
 * and this name, in this order and length, is refused with a StashError.
 */
export async function openStash(key: CryptoKey, name: string, stored: Blob) {
    if (stored.size < HEADER_BYTES) throw new StashError('This stash is damaged.');
    const header = new Uint8Array(await stored.slice(0, HEADER_BYTES).arrayBuffer());
    if (MAGIC.some((byte, at) => header[at] !== byte))
        throw new StashError('This stash is not sealed.');
    const view = new DataView(header.buffer);
    const chunk = view.getUint32(4);
    const total = Number(view.getBigUint64(8));
    const prefix = header.subarray(16, 24);
    if (!chunk || !Number.isSafeInteger(total)) throw new StashError('This stash is damaged.');
    const count = chunkCount(total, chunk);
    if (stored.size !== HEADER_BYTES + total + count * TAG_BYTES)
        throw new StashError('This stash is damaged.');
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let offset = HEADER_BYTES;
    for (let index = 0; index < count; index++) {
        const plainBytes = index === count - 1 ? total - index * chunk : chunk;
        const sealed = await stored.slice(offset, offset + plainBytes + TAG_BYTES).arrayBuffer();
        offset += plainBytes + TAG_BYTES;
        try {
            parts.push(
                new Uint8Array(
                    await crypto.subtle.decrypt(
                        {
                            name: 'AES-GCM',
                            iv: nonceOf(prefix, index),
                            additionalData: associated(header, name, index),
                        },
                        key,
                        sealed,
                    ),
                ),
            );
        } catch {
            throw new StashError('This stash could not be opened on this account.');
        }
    }
    return parts;
}
