import { stashLost } from '@hushos/crypto/stash';
import { StashGone, type UploadStash } from '@hushos/drive/transfers';
import { authClient } from '@/lib/auth-client';

/*
 * Where uploads that have no file on disk keep their bytes: a copy of something
 * shared is decrypted into memory, and memory does not survive a reload. The
 * bytes go into the origin's private file system (invisible to other sites,
 * never shown to the person, cleared with site data) under a random name that
 * the upload journal records, so a restored upload reopens them itself.
 *
 * What lands there is sealed by the crypto worker under a key derived from the
 * account key (@hushos/crypto/stash); the page never holds that key. A locked
 * browser holds ciphertext it can't open. An explicit lock (Lock on this
 * browser, sign-out, a password change: anything that moves the auth store's
 * lockRevision, in this tab or another) deletes the stash; a tab closing or
 * reloading does not, since that is exactly what the stash is for. A browser
 * without a writable private file system stashes nothing; the copy then
 * finishes only if the page stays open, and is reported lost otherwise.
 */

const DIRECTORY = 'upload-stash-sealed';
/* The lockRevision the stash was written under, beside it: a later revision means a lock since. */
const REVISION = 'upload-stash-revision';
/* Where stashes were kept, unsealed, before they were sealed. Deleted on sight. */
const PLAINTEXT_DIRECTORY = 'upload-stash';

/* The parts of the private file system the stash uses, so tests can stand in for it. */
export type StashRoot = Pick<
    FileSystemDirectoryHandle,
    'getDirectoryHandle' | 'getFileHandle' | 'removeEntry'
>;

export type SealedStash = UploadStash & {
    /* Seals and writes the bytes, returning the stash's name, or null when they can't be kept. */
    put(bytes: Uint8Array): Promise<string | null>;
    /* Deletes every stash; rejects when it could not, so sign-out can say so. */
    forget(): Promise<void>;
    /* Deletes the stash when an explicit lock happened since it was written. */
    settle(): Promise<void>;
    /* Deletes what the unsealed stash left on disk; once, at start-up. */
    dropPlaintext(): Promise<void>;
};

const notFound = (error: unknown) =>
    error instanceof DOMException && error.name === 'NotFoundError';

export function createSealedStash(options: {
    root: () => Promise<StashRoot>;
    /* The unlocked account, or null while locked. */
    account: () => string | null;
    /* The auth store's lockRevision: it moves on every explicit lock, never on a tab closing. */
    lockRevision: () => number;
    /* The worker's sealing and opening (driveStashSeal, driveStashOpen). */
    seal: (userId: string, name: string, bytes: Uint8Array) => Promise<Uint8Array[]>;
    open: (userId: string, name: string, stored: Blob) => Promise<Uint8Array[]>;
    /*
     * Whether this browser may have written a stash since its last wipe: set
     * before a stash is written, cleared once a wipe succeeded. A wipe that
     * can't reach the private file system is a failure only when it is set.
     */
    written: { set(): void; clear(): void; get(): boolean };
}): SealedStash {
    // Moves on every wipe, so a write that began before one never lands after it.
    let generation = 0;
    async function directory() {
        return (await options.root()).getDirectoryHandle(DIRECTORY, { create: true });
    }
    async function writtenUnder() {
        try {
            const file = await (await (await options.root()).getFileHandle(REVISION)).getFile();
            const value = Number(await file.text());
            return Number.isFinite(value) ? value : null;
        } catch (error) {
            if (notFound(error)) return null;
            throw error;
        }
    }
    async function remember(revision: number) {
        const handle = await (await options.root()).getFileHandle(REVISION, { create: true });
        const writable = await handle.createWritable();
        await writable.write(String(revision));
        await writable.close();
    }
    async function wipe() {
        generation++;
        let root: StashRoot;
        try {
            root = await options.root();
        } catch (error) {
            // No usable private file system (WebKit under automation, a private window). If no
            // stash was ever written here there is nothing to wipe; if one was, files may be left
            // that this could not reach, and the wipe must say so, so it is tried again.
            if (options.written.get()) throw error;
            return;
        }
        // The unsealed stash's folder too, should start-up not have got to it.
        for (const name of [DIRECTORY, REVISION, PLAINTEXT_DIRECTORY])
            await root.removeEntry(name, { recursive: true }).catch((error: unknown) => {
                if (!notFound(error)) throw error;
            });
        options.written.clear();
    }
    const stash: SealedStash = {
        async put(bytes) {
            const userId = options.account();
            if (!userId) return null;
            const name = crypto.randomUUID();
            try {
                await stash.settle();
                const started = generation;
                // Marked before anything reaches the disk: a wipe that can't get there then fails.
                options.written.set();
                const parts = await options.seal(userId, name, bytes);
                const handle = await (await directory()).getFileHandle(name, { create: true });
                const writable = await handle.createWritable();
                try {
                    for (const part of parts) await writable.write(part as BufferSource);
                    // Wiped meanwhile (a lock, sign-out): this stash must not outlive it.
                    if (generation !== started) throw new Error('The stash was cleared.');
                } catch (error) {
                    await writable.abort().catch(() => {});
                    throw error;
                }
                await writable.close();
                await remember(options.lockRevision());
                return name;
            } catch {
                await stash.remove(name).catch(() => {});
                return null;
            }
        },
        async open(name, file) {
            await stash.settle();
            const userId = options.account();
            if (!userId) throw new Error('Your account was locked.');
            let stored: File;
            try {
                stored = await (await (await directory()).getFileHandle(name)).getFile();
            } catch (error) {
                throw notFound(error) ? new StashGone('This stash is gone.') : error;
            }
            let parts: Uint8Array[];
            try {
                parts = await options.open(userId, name, stored);
            } catch (error) {
                throw stashLost(error) ? new StashGone((error as Error).message) : error;
            }
            const opened = new File(parts as BlobPart[], file.name, {
                type: file.type,
                lastModified: file.lastModified,
            });
            if (opened.size !== file.size)
                throw new StashGone('The stashed bytes are not the file.');
            return opened;
        },
        async remove(name) {
            await (await directory()).removeEntry(name).catch(() => {});
        },
        async sweep(keep) {
            await stash.settle();
            const dir = await directory();
            const names: string[] = [];
            for await (const name of dir.keys()) if (!keep.has(name)) names.push(name);
            for (const name of names) await dir.removeEntry(name).catch(() => {});
        },
        forget: wipe,
        async settle() {
            const written = await writtenUnder();
            if (written !== null && options.lockRevision() > written) await wipe();
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

/* The written marker for this browser, in localStorage; unreadable counts as written. */
const WRITTEN_KEY = 'hushos-stash-written';
const writtenMarker = {
    set: () => localStorage.setItem(WRITTEN_KEY, '1'),
    clear: () => {
        try {
            localStorage.removeItem(WRITTEN_KEY);
        } catch {
            /* Kept, so a later wipe that can't reach the files still says so. */
        }
    },
    get: () => {
        try {
            return localStorage.getItem(WRITTEN_KEY) !== null;
        } catch {
            return true;
        }
    },
};

export const uploadStash = createSealedStash({
    written: writtenMarker,
    root: () => navigator.storage.getDirectory(),
    account: () => authClient.store.getState().unlockedUserId,
    lockRevision: () => authClient.store.getState().lockRevision,
    seal: async (userId, name, bytes) =>
        (await authClient.rpc('driveStashSeal', { userId, name, bytes })).parts,
    open: async (userId, name, stored) =>
        (await authClient.rpc('driveStashOpen', { userId, name, stored })).parts,
});

// Wherever the stash is used (Drive, or a link page saving a copy), an explicit lock in this
// tab or another deletes it as soon as the store hears of it.
if (stashAvailable())
    authClient.store.subscribe((state, previous) => {
        if (state.lockRevision !== previous.lockRevision) void uploadStash.settle().catch(() => {});
    });

/* Writes the bytes and returns the stash's name, or null when this browser cannot keep them. */
export async function stashBytes(bytes: Uint8Array): Promise<string | null> {
    if (!stashAvailable()) return null;
    return uploadStash.put(bytes);
}

/* At sign-out: every stash goes. Rejects when it could not, so the wipe is reported and retried. */
export async function forgetStash() {
    if (stashAvailable()) await uploadStash.forget();
}
