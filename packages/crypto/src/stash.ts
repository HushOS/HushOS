/*
 * Stashed upload bytes, sealed. A copy saved out of a share has no file on the
 * person's disk to reopen after a reload, so the web app keeps its bytes in
 * the browser's private file system until the upload is done. Those bytes are
 * the decrypted file; what reaches the disk is this sealing of them.
 *
 * The key is derived from the account key (HKDF, `hushos/stash/v1`, with the
 * user id), as editing's drafts are (editing-design.md): only an unlocked
 * session of this account can open a stash, a locked device cannot, and the
 * key is never stored. The worker hands it out as a non-extractable CryptoKey,
 * so the page can seal and open with it but never read it.
 *
 * Format: "HSS1", the chunk size and the total length, then 8 random bytes
 * that start every chunk's nonce (the chunk's index ends it), then each chunk
 * sealed with AES-256-GCM. A chunk's associated data names the stash, its
 * index and the total length, so chunks can't be reordered, dropped, cut
 * short or moved between stashes without failing.
 * WebCrypto only: no libsodium, so the page imports this without the worker's
 * code.
 */

const MAGIC = [0x48, 0x53, 0x53, 0x31]; // "HSS1"
const HEADER_BYTES = 4 + 4 + 8 + 8;
const TAG_BYTES = 16;
export const STASH_CHUNK_BYTES = 4 * 1024 * 1024;
const LABEL = 'hushos/stash/v1';

export class StashError extends Error {}

/* The account's stash key. The caller passes the account root and zeroes it. */
export async function deriveStashKey(root: Uint8Array<ArrayBuffer>, userId: string) {
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

function associated(name: string, index: number, total: number) {
    return new TextEncoder().encode(`${LABEL}|${name}|${index}|${total}`);
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

/*
 * Seals `bytes` as the stash called `name`, handing each part to `write` in
 * order: the header first, then one sealed chunk at a time, so the whole
 * ciphertext is never held at once.
 */
export async function sealStash(
    key: CryptoKey,
    name: string,
    bytes: Uint8Array,
    write: (part: Uint8Array<ArrayBuffer>) => Promise<void>,
    chunk = STASH_CHUNK_BYTES,
) {
    const total = bytes.byteLength;
    const prefix = crypto.getRandomValues(new Uint8Array(8));
    const header = new Uint8Array(HEADER_BYTES);
    header.set(MAGIC, 0);
    const view = new DataView(header.buffer);
    view.setUint32(4, chunk);
    view.setBigUint64(8, BigInt(total));
    header.set(prefix, 16);
    await write(header);
    const count = chunkCount(total, chunk);
    for (let index = 0; index < count; index++) {
        const plain = bytes.subarray(index * chunk, Math.min(total, (index + 1) * chunk));
        const sealed = await crypto.subtle.encrypt(
            {
                name: 'AES-GCM',
                iv: nonceOf(prefix, index),
                additionalData: associated(name, index, total),
            },
            key,
            plain as BufferSource,
        );
        await write(new Uint8Array(sealed));
    }
}

/*
 * Opens the stash called `name` from its stored bytes, chunk by chunk, and
 * returns the plaintext in parts (for a Blob or File). Anything that doesn't
 * open, under this key and this name, in this order and length, is refused.
 */
export async function openStash(key: CryptoKey, name: string, stored: Blob) {
    if (stored.size < HEADER_BYTES) throw new StashError('This stash is damaged.');
    const header = new Uint8Array(await stored.slice(0, HEADER_BYTES).arrayBuffer());
    if (MAGIC.some((byte, at) => header[at] !== byte))
        throw new StashError('This is not a sealed stash.');
    const view = new DataView(header.buffer);
    const chunk = view.getUint32(4);
    const total = Number(view.getBigUint64(8));
    const prefix = header.subarray(16, 24);
    if (!chunk || !Number.isSafeInteger(total)) throw new StashError('This stash is damaged.');
    const count = chunkCount(total, chunk);
    const sealedTotal = HEADER_BYTES + total + count * TAG_BYTES;
    if (stored.size !== sealedTotal) throw new StashError('This stash is damaged.');
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
                            additionalData: associated(name, index, total),
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
