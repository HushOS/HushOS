import { openStash, sealStash } from '@hushos/crypto/stash';
import { describe, expect, test, vi } from 'vitest';

/*
 * The app's own stash (uploadStash), in a browser without Web Locks: its revision commits
 * and wipes must still be kept apart within the tab, or a commit from a session that ended
 * sets the revision back under the next account's stashes, and their next settle deletes
 * them.
 */
const world = vi.hoisted(() => ({
    state: { unlockedUserId: 'user-1' as string | null, lockRevision: 1 },
    key: null as CryptoKey | null,
}));
vi.mock('@/lib/auth-client', () => ({
    authClient: {
        store: { getState: () => world.state, subscribe: () => () => {} },
        rpc: async (
            operation: string,
            input: { name: string; bytes: Uint8Array; stored: Blob },
        ) => {
            if (operation === 'driveStashSeal')
                return { parts: await sealStash(world.key!, input.name, input.bytes) };
            if (operation === 'driveStashOpen')
                return { parts: await openStash(world.key!, input.name, input.stored) };
            throw new Error(`unexpected ${operation}`);
        },
    },
}));

/* The private file system, in memory, whose revision writes can be held. */
const disk = (() => {
    const directories = new Map<string, Map<string, Uint8Array>>();
    const files = new Map<string, Uint8Array>();
    const missing = () => new DOMException('Not found', 'NotFoundError');
    const held = { revision: null as Promise<void> | null, reached: false };
    const handles = (store: Map<string, Uint8Array>, top = false) => ({
        async getFileHandle(name: string, options?: { create?: boolean }) {
            if (top && name === 'upload-stash-revision' && options?.create && held.revision) {
                const wait = held.revision;
                held.revision = null;
                held.reached = true;
                await wait;
            }
            if (!store.has(name)) {
                if (!options?.create) throw missing();
                store.set(name, new Uint8Array(0));
            }
            return {
                async createWritable() {
                    const parts: Uint8Array[] = [];
                    return {
                        write: async (part: Uint8Array | string) =>
                            void parts.push(
                                typeof part === 'string' ? new TextEncoder().encode(part) : part,
                            ),
                        close: async () =>
                            void store.set(
                                name,
                                new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer()),
                            ),
                        abort: async () => {},
                    };
                },
                async getFile() {
                    return new File([store.get(name)! as BlobPart], name);
                },
            };
        },
        async removeEntry(name: string) {
            if (!store.delete(name)) throw missing();
        },
        async *keys() {
            yield* store.keys();
        },
    });
    const root = {
        ...handles(files, true),
        async getDirectoryHandle(name: string, options?: { create?: boolean }) {
            if (!directories.has(name)) {
                if (!options?.create) throw missing();
                directories.set(name, new Map());
            }
            return handles(directories.get(name)!);
        },
        async removeEntry(name: string) {
            if (!directories.delete(name) && !files.delete(name)) throw missing();
        },
    };
    return { root, held };
})();

// A browser with a private file system and no Web Locks.
vi.stubGlobal('navigator', { storage: { getDirectory: async () => disk.root } });
const { uploadStash } = await import('./stash');

describe('the app’s stash without Web Locks', () => {
    test('a commit from a session that ended never sets the revision back under the next one’s stash', async () => {
        world.key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
            'encrypt',
            'decrypt',
        ]);
        const bytes = new TextEncoder().encode('a copy of something shared');
        const file = { name: 'copy.txt', type: 'text/plain', size: bytes.length, lastModified: 1 };
        let resume!: () => void;
        disk.held.revision = new Promise<void>((resolve) => {
            resume = resolve;
        });
        let mayaCurrent = true;
        const mayas = uploadStash.put(bytes, { account: 'user-1', current: () => mayaCurrent });
        await vi.waitFor(() => expect(disk.held.reached).toBe(true));
        // Maya signs out: the lock revision moves and the stash is wiped.
        mayaCurrent = false;
        world.state = { unlockedUserId: null, lockRevision: 2 };
        const wiping = uploadStash.forget();
        // Sam signs in and saves a copy of his own, before Maya's commit gets its answer.
        world.state = { unlockedUserId: 'user-2', lockRevision: 2 };
        const sams = uploadStash.put(bytes, { account: 'user-2', current: () => true });
        await new Promise((resolve) => setTimeout(resolve, 50));
        resume();
        expect(await mayas).toBeNull();
        await wiping;
        const name = await sams;
        expect(name).not.toBeNull();
        const opened = await uploadStash.open(name!, file);
        expect(opened.size).toBe(bytes.length);
    });
});
