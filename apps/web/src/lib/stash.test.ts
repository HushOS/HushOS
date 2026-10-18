import { describe, expect, it, vi } from 'vitest';

// The real auth client starts a worker and opens device storage; these tests bring their own key.
vi.mock('@/lib/auth-client', () => ({ authClient: {} }));

const { createSealedStash } = await import('@/lib/stash');
type StashRoot = Parameters<typeof createSealedStash>[0]['root'] extends () => Promise<infer R>
    ? R
    : never;

/* The browser's private file system, in memory: directories of named files, nothing more. */
function privateFileSystem() {
    const directories = new Map<string, Map<string, Uint8Array>>();
    const missing = () => new DOMException('Not found', 'NotFoundError');
    const directory = (files: Map<string, Uint8Array>) => ({
        async getFileHandle(name: string, options?: { create?: boolean }) {
            if (!files.has(name)) {
                if (!options?.create) throw missing();
                files.set(name, new Uint8Array(0));
            }
            return {
                async createWritable() {
                    const parts: Uint8Array[] = [];
                    return {
                        async write(part: Uint8Array) {
                            parts.push(new Uint8Array(part));
                        },
                        async close() {
                            files.set(
                                name,
                                new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer()),
                            );
                        },
                        async abort() {},
                    };
                },
                async getFile() {
                    return new File([files.get(name)! as BlobPart], name);
                },
            };
        },
        async removeEntry(name: string) {
            if (!files.delete(name)) throw missing();
        },
        async *keys() {
            yield* files.keys();
        },
    });
    const root = {
        async getDirectoryHandle(name: string, options?: { create?: boolean }) {
            if (!directories.has(name)) {
                if (!options?.create) throw missing();
                directories.set(name, new Map());
            }
            return directory(directories.get(name)!);
        },
        async removeEntry(name: string) {
            if (!directories.delete(name)) throw missing();
        },
    } as unknown as StashRoot;
    /* Everything on "disk", every file of every directory. */
    const disk = () => [...directories.values()].flatMap((files) => [...files.values()]);
    return { root, directories, disk };
}

const key = () =>
    crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

function stashOn(
    fs: ReturnType<typeof privateFileSystem>,
    account: () => string | null,
    derive: (userId: string) => Promise<CryptoKey>,
) {
    return createSealedStash({ root: async () => fs.root, account, deriveKey: derive });
}

const canary = new TextEncoder().encode('PLAINTEXT-CANARY a copy of something shared');
const described = { name: 'copy.txt', type: 'text/plain', size: canary.length, lastModified: 1 };

function contains(haystack: Uint8Array, needle: Uint8Array) {
    outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
        for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
        return true;
    }
    return false;
}

describe('the sealed upload stash', () => {
    it('writes only ciphertext to disk and opens it back as the file the journal describes', async () => {
        const fs = privateFileSystem();
        const sealing = await key();
        const stash = stashOn(
            fs,
            () => 'user-1',
            async () => sealing,
        );
        const name = await stash.put(canary);
        expect(name).not.toBeNull();
        const stored = fs.disk();
        expect(stored).toHaveLength(1);
        expect(contains(stored[0]!, canary.subarray(0, 16))).toBe(false);
        const file = await stash.open(name!, described);
        expect(file.name).toBe('copy.txt');
        expect(await file.text()).toBe(new TextDecoder().decode(canary));
    });

    it('cannot be opened with another key, such as another account’s on this browser', async () => {
        const fs = privateFileSystem();
        const name = await stashOn(fs, () => 'user-1', key).put(canary);
        const other = await key();
        await expect(
            stashOn(
                fs,
                () => 'user-1',
                async () => other,
            ).open(name!, described),
        ).rejects.toThrow();
    });

    it('derives a key per account, never reusing one account’s key for the next', async () => {
        const fs = privateFileSystem();
        let account = 'user-1';
        const derive = vi.fn(async (_userId: string) => key());
        const stash = stashOn(fs, () => account, derive);
        await stash.put(canary);
        account = 'user-2';
        await stash.put(canary);
        expect(derive.mock.calls.map(([userId]) => userId)).toEqual(['user-1', 'user-2']);
    });

    it('keeps nothing while the account is locked', async () => {
        const fs = privateFileSystem();
        const derive = vi.fn(key);
        expect(await stashOn(fs, () => null, derive).put(canary)).toBeNull();
        expect(fs.disk()).toHaveLength(0);
        expect(derive).not.toHaveBeenCalled();
    });

    it('deletes every stash on lock and forgets the key', async () => {
        const fs = privateFileSystem();
        const derive = vi.fn(async () => key());
        const stash = stashOn(fs, () => 'user-1', derive);
        const name = await stash.put(canary);
        await stash.forget();
        expect(fs.disk()).toHaveLength(0);
        await expect(stash.open(name!, described)).rejects.toThrow();
        // The next stash after unlocking asks the worker again: the old key was not kept.
        await stash.put(canary);
        expect(derive).toHaveBeenCalledTimes(2);
    });

    it('removes the plaintext an unsealed stash left behind, and only that', async () => {
        const fs = privateFileSystem();
        const stash = stashOn(fs, () => 'user-1', key);
        const kept = await stash.put(canary);
        const old = await fs.root.getDirectoryHandle('upload-stash', { create: true });
        const writable = await (
            await old.getFileHandle('legacy', { create: true })
        ).createWritable();
        await writable.write(canary);
        await writable.close();
        await stash.dropPlaintext();
        expect(fs.directories.has('upload-stash')).toBe(false);
        expect(fs.disk().some((bytes) => contains(bytes, canary.subarray(0, 16)))).toBe(false);
        // The sealed stash is untouched.
        expect(await (await stash.open(kept!, described)).text()).toBe(
            new TextDecoder().decode(canary),
        );
    });
});
