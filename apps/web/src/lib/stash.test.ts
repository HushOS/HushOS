import { describe, expect, it, vi } from 'vitest';
import { openStash, sealStash } from '@hushos/crypto/stash';
import { inMemory, StashGone, type UploadFile } from '@hushos/drive/transfers';

// The real auth client starts a worker and opens device storage; these tests stand in for both.
vi.mock('@/lib/auth-client', () => ({ authClient: { store: { getState: () => ({}) } } }));

const { createSealedStash } = await import('@/lib/stash');
type StashRoot = Awaited<ReturnType<Parameters<typeof createSealedStash>[0]['root']>>;

const missing = () => new DOMException('Not found', 'NotFoundError');

/* The browser's private file system, in memory: files and directories of files, nothing more. */
function privateFileSystem() {
    const directories = new Map<string, Map<string, Uint8Array>>();
    const files = new Map<string, Uint8Array>();
    let failRemovals = false;
    const fileHandle = (store: Map<string, Uint8Array>, name: string) => ({
        async createWritable() {
            const parts: Uint8Array[] = [];
            return {
                async write(part: Uint8Array | string) {
                    parts.push(
                        typeof part === 'string'
                            ? new TextEncoder().encode(part)
                            : new Uint8Array(part),
                    );
                },
                async close() {
                    store.set(
                        name,
                        new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer()),
                    );
                },
                async abort() {},
            };
        },
        async getFile() {
            return new File([store.get(name)! as BlobPart], name);
        },
    });
    const handles = (store: Map<string, Uint8Array>) => ({
        async getFileHandle(name: string, options?: { create?: boolean }) {
            if (!store.has(name)) {
                if (!options?.create) throw missing();
                store.set(name, new Uint8Array(0));
            }
            return fileHandle(store, name);
        },
        async removeEntry(name: string) {
            if (!store.delete(name)) throw missing();
        },
        async *keys() {
            yield* store.keys();
        },
    });
    const root = {
        ...handles(files),
        async getDirectoryHandle(name: string, options?: { create?: boolean }) {
            if (!directories.has(name)) {
                if (!options?.create) throw missing();
                directories.set(name, new Map());
            }
            return handles(directories.get(name)!);
        },
        async removeEntry(name: string) {
            if (failRemovals) throw new DOMException('Busy', 'NoModificationAllowedError');
            if (!directories.delete(name) && !files.delete(name)) throw missing();
        },
    } as unknown as StashRoot;
    return {
        root,
        directories,
        /* Every byte on "disk": each stash and the revision file. */
        disk: () => [
            ...files.values(),
            ...[...directories.values()].flatMap((d) => [...d.values()]),
        ],
        stashes: () => [...(directories.get('upload-stash-sealed')?.values() ?? [])],
        failRemovals: (on = true) => (failRemovals = on),
    };
}

/* The worker, as far as the stash sees it: sealing and opening under one account's key. */
async function worker() {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
    ]);
    return {
        seal: vi.fn(async (_userId: string, name: string, bytes: Uint8Array) =>
            sealStash(key, name, bytes),
        ),
        open: vi.fn(async (_userId: string, name: string, stored: Blob) =>
            openStash(key, name, stored),
        ),
    };
}

function setup(
    fs: ReturnType<typeof privateFileSystem>,
    sealer: Awaited<ReturnType<typeof worker>>,
    exclusive?: <T>(work: () => Promise<T>) => Promise<T>,
) {
    const state = {
        account: 'user-1' as string | null,
        revision: 100,
        /* The private file system answering, or rejecting as WebKit's does. */
        rootFails: false,
        written: false,
    };
    const stash = createSealedStash({
        root: async () => {
            if (state.rootFails) throw new DOMException('transient', 'UnknownError');
            return fs.root;
        },
        account: () => state.account,
        lockRevision: () => state.revision,
        seal: sealer.seal,
        open: sealer.open,
        written: {
            set: () => void (state.written = true),
            clear: () => void (state.written = false),
            get: () => state.written,
        },
        ...(exclusive ? { exclusive } : {}),
    });
    return { stash, state };
}

const canary = new TextEncoder().encode('PLAINTEXT-CANARY a copy of something shared');
const described = { name: 'copy.txt', type: 'text/plain', size: canary.length, lastModified: 1 };
const plain = new TextDecoder().decode(canary);

/* An opened stash is bytes in memory, never a Blob: read back by decoding its parts. */
function textOf(file: UploadFile) {
    if (!inMemory(file)) throw new Error('expected bytes in memory, not a File');
    const joined = new Uint8Array(file.size);
    let at = 0;
    for (const part of file.parts) {
        joined.set(part, at);
        at += part.byteLength;
    }
    return new TextDecoder().decode(joined);
}

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
        const { stash } = setup(fs, await worker());
        const name = await stash.put(canary);
        expect(name).not.toBeNull();
        expect(fs.stashes()).toHaveLength(1);
        expect(fs.disk().some((bytes) => contains(bytes, canary.subarray(0, 16)))).toBe(false);
        const file = await stash.open(name!, described);
        expect(file.name).toBe('copy.txt');
        expect(textOf(file)).toBe(plain);
    });

    it('calls a stash another key sealed lost, and a missing one too', async () => {
        const fs = privateFileSystem();
        const name = await setup(fs, await worker()).stash.put(canary);
        const other = setup(fs, await worker()).stash;
        await expect(other.open(name!, described)).rejects.toBeInstanceOf(StashGone);
        await expect(other.open('never-written', described)).rejects.toBeInstanceOf(StashGone);
    });

    it('keeps the stash when the worker is locked rather than calling it lost', async () => {
        const fs = privateFileSystem();
        const sealer = await worker();
        const { stash } = setup(fs, sealer);
        const name = await stash.put(canary);
        sealer.open.mockRejectedValueOnce(new Error('Your account was locked. Please try again.'));
        const refused = await stash.open(name!, described).catch((error: unknown) => error);
        expect(refused).not.toBeInstanceOf(StashGone);
        expect(textOf(await stash.open(name!, described))).toBe(plain);
    });

    it('keeps nothing while the account is locked', async () => {
        const fs = privateFileSystem();
        const sealer = await worker();
        const { stash, state } = setup(fs, sealer);
        state.account = null;
        expect(await stash.put(canary)).toBeNull();
        expect(fs.stashes()).toHaveLength(0);
        expect(sealer.seal).not.toHaveBeenCalled();
    });

    it('survives a tab closing or reloading, which locks without moving the lock revision', async () => {
        const fs = privateFileSystem();
        const { stash, state } = setup(fs, await worker());
        const name = await stash.put(canary);
        state.account = null; // pagehide
        await stash.settle();
        state.account = 'user-1'; // unlocked again after the reload
        expect(textOf(await stash.open(name!, described))).toBe(plain);
    });

    it('is deleted after an explicit lock, here or in another tab, before anything reads it', async () => {
        const fs = privateFileSystem();
        const { stash, state } = setup(fs, await worker());
        const name = await stash.put(canary);
        state.revision = 200; // Lock on this browser, sign-out, a password change
        await expect(stash.open(name!, described)).rejects.toBeInstanceOf(StashGone);
        expect(fs.disk()).toHaveLength(0);
    });

    it('never leaves a stash behind that was being written when it was wiped', async () => {
        const fs = privateFileSystem();
        const sealer = await worker();
        const { stash } = setup(fs, sealer);
        // The wipe lands while the worker is still sealing.
        sealer.seal.mockImplementationOnce(async (userId, name, bytes) => {
            const parts = await sealStash(
                await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
                    'encrypt',
                ]),
                name,
                bytes,
            );
            await stash.forget();
            void userId;
            return parts;
        });
        expect(await stash.put(canary)).toBeNull();
        expect(fs.stashes()).toHaveLength(0);
    });

    it('a stash of a session that ended never sets the revision back under the next one’s stashes', async () => {
        const fs = privateFileSystem();
        const { stash, state } = setup(fs, await worker());
        // Maya's copy reaches its revision commit, and the private file system is slow to answer.
        let sessionA = true;
        let resume!: () => void;
        const slow = new Promise<void>((resolve) => {
            resume = resolve;
        });
        let paused = false;
        const getFileHandle = fs.root.getFileHandle.bind(fs.root);
        fs.root.getFileHandle = (async (name: string, options?: { create?: boolean }) => {
            if (name === 'upload-stash-revision' && options?.create && !paused) {
                paused = true;
                await slow;
            }
            return getFileHandle(name, options);
        }) as typeof fs.root.getFileHandle;
        const mayas = stash.put(canary, { account: 'user-1', current: () => sessionA });
        await vi.waitFor(() => expect(paused).toBe(true));
        // Maya signs out: the lock revision moves and this browser's stash is wiped.
        sessionA = false;
        state.account = null;
        state.revision = 200;
        const wiping = stash.forget();
        // Sam signs in and saves a copy of his own.
        state.account = 'user-2';
        const sams = stash.put(canary, { account: 'user-2', current: () => true });
        await new Promise((resolve) => setTimeout(resolve, 50));
        // Only now does Maya's commit get its answer.
        resume();
        expect(await mayas).toBeNull();
        await wiping;
        const name = await sams;
        expect(name).not.toBeNull();
        // Sam's stash is still his: reading it settles against the revision, and keeps it.
        expect(textOf(await stash.open(name!, described))).toBe(plain);
        expect(fs.stashes()).toHaveLength(1);
    });

    it('a wipe waits for a revision commit under way, so nothing of the session outlives it', async () => {
        const fs = privateFileSystem();
        const { stash, state } = setup(fs, await worker());
        let session = true;
        let resume!: () => void;
        const slow = new Promise<void>((resolve) => {
            resume = resolve;
        });
        let paused = false;
        const getFileHandle = fs.root.getFileHandle.bind(fs.root);
        fs.root.getFileHandle = (async (name: string, options?: { create?: boolean }) => {
            if (name === 'upload-stash-revision' && options?.create && !paused) {
                paused = true;
                await slow;
            }
            return getFileHandle(name, options);
        }) as typeof fs.root.getFileHandle;
        const put = stash.put(canary, { account: 'user-1', current: () => session });
        await vi.waitFor(() => expect(paused).toBe(true));
        // Signed out while the commit, begun in the session, waits on the file system.
        session = false;
        state.account = null;
        state.revision = 200;
        const wiping = stash.forget();
        await new Promise((resolve) => setTimeout(resolve, 50));
        resume();
        expect(await put).toBeNull();
        await wiping;
        // Neither the stash nor the revision it was committing is left after the sign-out.
        expect(fs.disk()).toHaveLength(0);
    });

    it('a commit that gets the lock only after another tab wiped and the next session stashed writes nothing', async () => {
        // The lock across tabs: another tab can take it between this one's last look and its ask.
        let chain: Promise<unknown> = Promise.resolve();
        const lock = <T>(work: () => Promise<T>) => {
            const next = chain.then(work, work);
            chain = next.catch(() => {});
            return next;
        };
        let calls = 0;
        let late!: () => void;
        const lateAsk = new Promise<void>((resolve) => {
            late = resolve;
        });
        const exclusive = <T>(work: () => Promise<T>) =>
            // Maya's put asks twice: to settle, then to commit; the commit's ask comes in late.
            ++calls === 2 ? lateAsk.then(() => lock(work)) : lock(work);
        const fs = privateFileSystem();
        const sealer = await worker();
        // Maya's tab, which still sees the lock revision it had, and the tab that signs her out.
        const maya = setup(fs, sealer, exclusive);
        const other = setup(fs, sealer, lock);
        let sessionA = true;
        const mayas = maya.stash.put(canary, { account: 'user-1', current: () => sessionA });
        await vi.waitFor(() => expect(calls).toBe(2));
        // The other tab signs Maya out and wipes, and Sam signs in there and stashes, all before
        // Maya's tab asks for the lock to commit.
        sessionA = false;
        maya.state.account = null;
        other.state.revision = 200;
        await other.stash.forget();
        other.state.account = 'user-2';
        const name = await other.stash.put(canary, { account: 'user-2', current: () => true });
        late();
        expect(await mayas).toBeNull();
        expect(textOf(await other.stash.open(name!, described))).toBe(plain);
    });

    it('leaves no folder behind once wiped: tidying and reading after a sign-out make none', async () => {
        const fs = privateFileSystem();
        const { stash } = setup(fs, await worker());
        const name = await stash.put(canary);
        await stash.forget();
        // What sign-out's upload sweep and a late read do after the wipe.
        await stash.sweep!(new Set());
        await stash.remove(name!);
        await expect(stash.open(name!, described)).rejects.toBeInstanceOf(StashGone);
        expect([...fs.directories.keys()]).toEqual([]);
        expect(fs.disk()).toHaveLength(0);
    });

    it('says when it could not delete the stash, so sign-out reports it', async () => {
        const fs = privateFileSystem();
        const { stash } = setup(fs, await worker());
        await stash.put(canary);
        fs.failRemovals();
        await expect(stash.forget()).rejects.toThrow('Busy');
    });

    it('has nothing to wipe where no stash was ever written and the file system is unusable', async () => {
        // WebKit under automation and private windows reject getDirectory outright.
        const { stash, state } = setup(privateFileSystem(), await worker());
        state.rootFails = true;
        await expect(stash.forget()).resolves.toBeUndefined();
    });

    it('says so when a written stash can’t be reached to wipe, until a wipe gets through', async () => {
        const fs = privateFileSystem();
        const { stash, state } = setup(fs, await worker());
        await stash.put(canary);
        // A transient failure at the moment of the wipe: the files are still there.
        state.rootFails = true;
        await expect(stash.forget()).rejects.toThrow('transient');
        expect(fs.stashes()).toHaveLength(1);
        // Tried again once the file system answers: gone, and the marker with them.
        state.rootFails = false;
        await stash.forget();
        expect(fs.disk()).toHaveLength(0);
        state.rootFails = true;
        await expect(stash.forget()).resolves.toBeUndefined();
    });

    it('wipes the unsealed stash’s folder too', async () => {
        const fs = privateFileSystem();
        const { stash } = setup(fs, await worker());
        const old = await fs.root.getDirectoryHandle('upload-stash', { create: true });
        const writable = await (
            await old.getFileHandle('legacy', { create: true })
        ).createWritable();
        await writable.write(canary);
        await writable.close();
        await stash.forget();
        expect(fs.directories.has('upload-stash')).toBe(false);
    });

    it('removes the plaintext an unsealed stash left behind, and only that', async () => {
        const fs = privateFileSystem();
        const { stash } = setup(fs, await worker());
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
        expect(textOf(await stash.open(kept!, described))).toBe(plain);
    });
});

describe('the unsealed stash left from before sealing', () => {
    /* What an unsealed stash left on disk: decrypted bytes in the old folder. */
    async function plantPlaintext(fs: ReturnType<typeof privateFileSystem>) {
        const old = await fs.root.getDirectoryHandle('upload-stash', { create: true });
        const writable = await (
            await old.getFileHandle('legacy', { create: true })
        ).createWritable();
        await writable.write(canary);
        await writable.close();
    }
    const plaintextOnDisk = (fs: ReturnType<typeof privateFileSystem>) =>
        fs.disk().some((bytes) => contains(bytes, canary.subarray(0, 16)));

    it('never rejects at start-up when the private file system does not answer', async () => {
        const fs = privateFileSystem();
        const { stash, state } = setup(fs, await worker());
        state.rootFails = true;
        // Called as `void uploadStash.dropPlaintext()`: a rejection here is an unhandled one.
        await expect(stash.dropPlaintext()).resolves.toBeUndefined();
    });

    it('goes at the next use of the private file system once it answers', async () => {
        const fs = privateFileSystem();
        const { stash, state } = setup(fs, await worker());
        await plantPlaintext(fs);
        state.rootFails = true;
        await stash.dropPlaintext();
        expect(plaintextOnDisk(fs)).toBe(true);

        state.rootFails = false;
        const kept = await stash.put(canary);
        expect(fs.directories.has('upload-stash')).toBe(false);
        expect(plaintextOnDisk(fs)).toBe(false);
        // The use that cleared it did its own work too.
        expect(textOf(await stash.open(kept!, described))).toBe(plain);
    });

    it('is tried again after a removal that failed, and the use that retries it still works', async () => {
        const fs = privateFileSystem();
        const { stash } = setup(fs, await worker());
        await plantPlaintext(fs);
        fs.failRemovals();
        await expect(stash.dropPlaintext()).resolves.toBeUndefined();
        expect(plaintextOnDisk(fs)).toBe(true);
        // Still refused: the stash goes on regardless.
        const first = await stash.put(canary);
        expect(first).not.toBeNull();
        expect(plaintextOnDisk(fs)).toBe(true);

        fs.failRemovals(false);
        await stash.open(first!, described);
        expect(fs.directories.has('upload-stash')).toBe(false);
    });
});
