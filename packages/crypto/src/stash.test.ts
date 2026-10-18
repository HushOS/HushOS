import { describe, expect, it } from 'vitest';
import { deriveStashKey, openStash, sealStash, StashError } from './stash';

const USER = '0b7c6f2e-5d0a-4f63-9a1e-3c2d4b5a6e7f';
const root = () => crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;

/* A file with a marker that would be found in anything that held it unsealed. */
function file(size: number) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 251;
    bytes.set(new TextEncoder().encode('PLAINTEXT-CANARY'), 0);
    return bytes;
}

async function sealed(key: CryptoKey, name: string, bytes: Uint8Array, chunk?: number) {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    await sealStash(key, name, bytes, async (part) => void parts.push(part), chunk);
    return parts;
}

async function opened(key: CryptoKey, name: string, parts: BlobPart[]) {
    const out = await openStash(key, name, new Blob(parts));
    return new Uint8Array(await new Blob(out).arrayBuffer());
}

function contains(haystack: Uint8Array, needle: Uint8Array) {
    outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
        for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
        return true;
    }
    return false;
}

describe('sealed stash', () => {
    it('writes no plaintext, and the same account opens it byte for byte, across several chunks', async () => {
        const account = root();
        const key = await deriveStashKey(account, USER);
        const bytes = file(10_000);
        const parts = await sealed(key, 'stash-1', bytes, 4096);
        const disk = new Uint8Array(await new Blob(parts).arrayBuffer());
        expect(contains(disk, new TextEncoder().encode('PLAINTEXT-CANARY'))).toBe(false);
        expect(contains(disk, bytes.subarray(5000, 5032))).toBe(false);
        // The key is derived again after a reload, never stored: the same account, the same key.
        const again = await deriveStashKey(account, USER);
        expect(await opened(again, 'stash-1', parts)).toEqual(bytes);
    });

    it('keeps an empty file empty', async () => {
        const key = await deriveStashKey(root(), USER);
        expect(await opened(key, 'empty', await sealed(key, 'empty', new Uint8Array(0)))).toEqual(
            new Uint8Array(0),
        );
    });

    it('opens for no other account and no other user id', async () => {
        const account = root();
        const parts = await sealed(await deriveStashKey(account, USER), 'stash-1', file(3000));
        await expect(opened(await deriveStashKey(root(), USER), 'stash-1', parts)).rejects.toThrow(
            StashError,
        );
        const otherUser = await deriveStashKey(account, '9f8e7d6c-5b4a-4321-8fed-cba987654321');
        await expect(opened(otherUser, 'stash-1', parts)).rejects.toThrow(StashError);
    });

    it('refuses a stash under another name, so one upload cannot be handed another’s bytes', async () => {
        const key = await deriveStashKey(root(), USER);
        const parts = await sealed(key, 'stash-1', file(3000));
        await expect(opened(key, 'stash-2', parts)).rejects.toThrow(StashError);
    });

    it('refuses chunks swapped, a last chunk dropped, or a byte changed', async () => {
        const key = await deriveStashKey(root(), USER);
        // Header, then three chunks of 4096, 4096 and 1808 bytes.
        const parts = await sealed(key, 'stash-1', file(10_000), 4096);
        expect(parts).toHaveLength(4);
        const [header, first, second, third] = parts as [
            Uint8Array<ArrayBuffer>,
            Uint8Array<ArrayBuffer>,
            Uint8Array<ArrayBuffer>,
            Uint8Array<ArrayBuffer>,
        ];
        await expect(opened(key, 'stash-1', [header, second, first, third])).rejects.toThrow(
            StashError,
        );
        // Cut to two full chunks, with the header rewritten to claim 8192 bytes: every chunk was
        // sealed with the real length, so the stash can't be passed off as shorter.
        const shorter = header.slice();
        new DataView(shorter.buffer).setBigUint64(8, 8192n);
        await expect(opened(key, 'stash-1', [shorter, first, second])).rejects.toThrow(StashError);
        const flipped = second.slice();
        flipped[100] = flipped[100]! ^ 1;
        await expect(opened(key, 'stash-1', [header, first, flipped, third])).rejects.toThrow(
            StashError,
        );
    });

    it('hands out a key the page can use but never read', async () => {
        const key = await deriveStashKey(root(), USER);
        expect(key.extractable).toBe(false);
        await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    });
});
