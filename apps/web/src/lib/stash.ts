import type { UploadStash } from '@hushos/drive/transfers';

/*
 * Where uploads that have no file on disk keep their bytes: a copy of something
 * shared is decrypted into memory, and memory does not survive a reload. The
 * bytes go into the origin's private file system (invisible to other sites,
 * never shown to the person, cleared with site data) under a random name that
 * the upload journal records, so a restored upload reopens them itself. A
 * browser without a writable private file system stashes nothing; the copy
 * then finishes only if the page stays open, and is reported lost otherwise.
 */

const DIRECTORY = 'upload-stash';

async function directory() {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(DIRECTORY, { create: true });
}

export function stashAvailable() {
    return (
        typeof navigator !== 'undefined' &&
        typeof navigator.storage?.getDirectory === 'function' &&
        typeof FileSystemFileHandle !== 'undefined' &&
        'createWritable' in FileSystemFileHandle.prototype
    );
}

/* Writes the bytes and returns the stash's name, or null when this browser cannot keep them. */
export async function stashBytes(bytes: Uint8Array): Promise<string | null> {
    if (!stashAvailable()) return null;
    const name = crypto.randomUUID();
    try {
        const handle = await (await directory()).getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        try {
            await writable.write(bytes as BufferSource);
        } catch (error) {
            await writable.abort().catch(() => {});
            throw error;
        }
        await writable.close();
        return name;
    } catch {
        await uploadStash.remove(name).catch(() => {});
        return null;
    }
}

export const uploadStash: UploadStash = {
    async open(name, file) {
        const handle = await (await directory()).getFileHandle(name);
        const stored = await handle.getFile();
        if (stored.size !== file.size) throw new Error('The stashed bytes are not the file.');
        // The same bytes, described as the journal remembers the file.
        return new File([stored], file.name, {
            type: file.type,
            lastModified: file.lastModified,
        });
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
};
