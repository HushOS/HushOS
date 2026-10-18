import { openStash, sealStash } from '@hushos/crypto/stash';
import type { UploadStash } from '@hushos/drive/transfers';
import { authClient } from '@/lib/auth-client';

/*
 * Where uploads that have no file on disk keep their bytes: a copy of something
 * shared is decrypted into memory, and memory does not survive a reload. The
 * bytes go into the origin's private file system (invisible to other sites,
 * never shown to the person, cleared with site data) under a random name that
 * the upload journal records, so a restored upload reopens them itself.
 *
 * What lands there is sealed, never the plaintext (@hushos/crypto/stash): the
 * key comes from the unlocked account key and is held in memory only, so a
 * locked or signed-out browser holds ciphertext it cannot open, and locking
 * deletes the stash and forgets the key outright. A browser without a writable
 * private file system stashes nothing; the copy then finishes only if the
 * page stays open, and is reported lost otherwise.
 */

const DIRECTORY = 'upload-stash-sealed';
/* Where stashes were kept, unsealed, before they were sealed. Deleted on sight. */
const PLAINTEXT_DIRECTORY = 'upload-stash';

/* The parts of the private file system the stash uses, so tests can stand in for it. */
export type StashRoot = Pick<FileSystemDirectoryHandle, 'getDirectoryHandle' | 'removeEntry'>;

export type SealedStash = UploadStash & {
    /* Seals and writes the bytes, returning the stash's name, or null when they can't be kept. */
    put(bytes: Uint8Array): Promise<string | null>;
    /* Deletes every stash and forgets the key: on lock and sign-out. */
    forget(): Promise<void>;
    /* Deletes what the unsealed stash left on disk; once, at start-up. */
    dropPlaintext(): Promise<void>;
};

export function createSealedStash(options: {
    root: () => Promise<StashRoot>;
    /* The unlocked account, or null while locked. */
    account: () => string | null;
    /* The account's stash key, from the worker. */
    deriveKey: (userId: string) => Promise<CryptoKey>;
}): SealedStash {
    // Held for one account: another account signing in on this page derives its own.
    let key: { userId: string; key: Promise<CryptoKey> } | null = null;
    function stashKey() {
        const userId = options.account();
        if (!userId) return Promise.reject(new Error('Unlock your account first.'));
        if (key?.userId !== userId) {
            const pending = options.deriveKey(userId);
            const held = { userId, key: pending };
            key = held;
            // A failed derivation is asked again next time, not remembered.
            pending.catch(() => {
                if (key === held) key = null;
            });
        }
        return key.key;
    }
    async function directory() {
        return (await options.root()).getDirectoryHandle(DIRECTORY, { create: true });
    }
    const stash: SealedStash = {
        async put(bytes) {
            const name = crypto.randomUUID();
            try {
                const sealing = await stashKey();
                const handle = await (await directory()).getFileHandle(name, { create: true });
                const writable = await handle.createWritable();
                try {
                    await sealStash(sealing, name, bytes, async (part) => {
                        await writable.write(part);
                    });
                } catch (error) {
                    await writable.abort().catch(() => {});
                    throw error;
                }
                await writable.close();
                return name;
            } catch {
                await stash.remove(name).catch(() => {});
                return null;
            }
        },
        async open(name, file) {
            const handle = await (await directory()).getFileHandle(name);
            const parts = await openStash(await stashKey(), name, await handle.getFile());
            const opened = new File(parts, file.name, {
                type: file.type,
                lastModified: file.lastModified,
            });
            if (opened.size !== file.size) throw new Error('The stashed bytes are not the file.');
            return opened;
        },
        async remove(name) {
            await (await directory()).removeEntry(name).catch(() => {});
        },
        async sweep(keep) {
            const dir = await directory();
            const names: string[] = [];
            for await (const name of dir.keys()) if (!keep.has(name)) names.push(name);
            for (const name of names) await dir.removeEntry(name).catch(() => {});
        },
        async forget() {
            key = null;
            await (
                await options.root()
            )
                .removeEntry(DIRECTORY, { recursive: true })
                .catch(() => {});
        },
        async dropPlaintext() {
            await (
                await options.root()
            )
                .removeEntry(PLAINTEXT_DIRECTORY, { recursive: true })
                .catch(() => {});
        },
    };
    return stash;
}

export function stashAvailable() {
    return (
        typeof navigator !== 'undefined' &&
        typeof navigator.storage?.getDirectory === 'function' &&
        typeof FileSystemFileHandle !== 'undefined' &&
        'createWritable' in FileSystemFileHandle.prototype
    );
}

export const uploadStash = createSealedStash({
    root: () => navigator.storage.getDirectory(),
    account: () => authClient.store.getState().unlockedUserId,
    deriveKey: async (userId) => (await authClient.rpc('driveStashKey', { userId })).key,
});

/* Writes the bytes and returns the stash's name, or null when this browser cannot keep them. */
export async function stashBytes(bytes: Uint8Array): Promise<string | null> {
    if (!stashAvailable()) return null;
    return uploadStash.put(bytes);
}

/* On lock and sign-out: every stash goes, and so does the key. */
export async function forgetStash() {
    if (stashAvailable()) await uploadStash.forget();
}
