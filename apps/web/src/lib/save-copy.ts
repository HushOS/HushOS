import { contentSize, type DriveNode } from '@hushos/drive/client';
import { copySignatureForms } from '@hushos/drive/trust';
import type { QueryClient } from '@tanstack/react-query';
import { authClient } from '@/lib/auth-client';
import { deviceSession } from '@/lib/device-session';
import { driveClient, folderQueryOptions, invalidateFolders, nextName } from '@/lib/drive';
import { openReader, readAll } from '@/lib/previews';
import { SignedOutError, type EnqueueInput, type MemoryFile } from '@hushos/drive/transfers';
import { forgetStashed, stashBytes } from '@/lib/stash';
import { thumbnailBytes } from '@/lib/thumbnails';
import { transfers } from '@/lib/transfers';

/*
 * "Save a copy to my Drive": what a person keeps of something shared with
 * them, by account or by link. A copy out of a share must never carry the
 * sharer's key, so this is a re-encryption: each file is read through the
 * share's key on this device and queued as an ordinary upload under the
 * person's own folder, fresh keys and all. Folders are walked and recreated.
 * Files are read whole first, so very large ones are refused rather than
 * held in memory. The bytes are also stashed, sealed, in the browser's private storage,
 * because a copy has no file on disk to ask for again after a reload.
 *
 * Each copy is signed by where it came from (docs/integrity-design.md, "Saved
 * copies"): from a link, the saved statements, files and folders alike; from
 * a share or one's own drive, the ordinary ones for what verified and the
 * re-sealed ones for anything else, so a copy of an Unverified item keeps
 * its warning and a copy of a verified one carries none.
 */

export const SAVE_COPY_MAX_BYTES = 256 * 1024 * 1024;

/*
 * What a copy or a move took when it began: the session's generation and the account that
 * was unlocked. Its bytes are that account's; they are stashed only for it and queued only
 * while it is still the same session. Someone signing out and another (or the same) person
 * signing in while the bytes were read leaves nothing behind.
 */
export type CopyStart = { generation: number; account: string | null };
export function copyStart(): CopyStart {
    return {
        generation: deviceSession.generation(),
        account: authClient.store.getState().unlockedUserId,
    };
}
const stillCurrent = (start: CopyStart) =>
    deviceSession.open() &&
    deviceSession.generation() === start.generation &&
    authClient.store.getState().unlockedUserId === start.account;

/*
 * Stashes a copy's bytes, sealed for the account it began for, and queues it. Checked before
 * the stash, during it (stash.ts), and after; a stash already written for a copy that is then
 * refused is deleted. Throws SignedOutError when the session changed.
 */
export async function queueCopy(start: CopyStart, bytes: Uint8Array, input: EnqueueInput) {
    if (!start.account || !stillCurrent(start)) throw new SignedOutError();
    const account = start.account;
    const stash = await stashBytes(bytes, { account, current: () => stillCurrent(start) });
    if (!stillCurrent(start)) {
        if (stash) await forgetStashed(stash).catch(() => {});
        throw new SignedOutError();
    }
    try {
        return transfers.enqueue([{ ...input, stash: stash ?? undefined }], start)[0]!;
    } catch (error) {
        if (stash) await forgetStashed(stash).catch(() => {});
        throw error;
    }
}

export async function saveCopy(
    queryClient: QueryClient,
    nodes: DriveNode[],
    destination: DriveNode,
    source: 'link' | 'drive',
    onProgress?: (done: number) => void,
) {
    // A sign-out while this reads and seals the bytes means none of it is kept afterwards.
    const start = copyStart();
    const listing = await queryClient.fetchQuery(folderQueryOptions(destination.id));
    const taken = new Set(listing.children.map((child) => child.name));
    let done = 0;
    const tick = () => {
        done += 1;
        onProgress?.(done);
    };
    async function saveFile(node: DriveNode, into: DriveNode, name: string) {
        const size = contentSize(node) ?? 0;
        if (size > SAVE_COPY_MAX_BYTES)
            throw new Error(`“${node.name}” is too large to copy this way. Download it instead.`);
        const reader = openReader(node, true);
        try {
            const { bytes } = await readAll(reader, SAVE_COPY_MAX_BYTES);
            // Uploaded from memory, never a Blob the browser could page to disk; the source's
            // own thumbnail comes along, so nothing renders one from the plaintext.
            const file: MemoryFile = {
                kind: 'memory',
                name,
                size: bytes.byteLength,
                type: node.metadata?.mime ?? '',
                lastModified: node.metadata?.modified
                    ? new Date(node.metadata.modified).getTime()
                    : Date.now(),
                parts: [bytes],
                thumbnail: await thumbnailBytes(node),
            };
            // Sealed to the stash first: the upload moves the bytes to the worker, after which
            // this page no longer holds them.
            await queueCopy(start, bytes, {
                file,
                parent: into,
                name,
                origin: 'copy',
                signAs: copySignatureForms(node, source),
                // Its record's attributes come along, every key this client does not know included.
                attributes: node.metadata?.attributes,
            });
        } finally {
            await reader.close();
        }
        tick();
    }
    async function saveTree(node: DriveNode, into: DriveNode, name: string) {
        if (node.kind === 'file') return saveFile(node, into, name);
        const [made] = await driveClient.createFolderPath(into, [name], {
            signAs: copySignatureForms(node, source).metadata,
            attributes: node.metadata?.attributes,
        });
        tick();
        const children = await driveClient.listFolder(node.id);
        for (const child of children.children) await saveTree(child, made!, child.name);
    }
    try {
        for (const node of nodes) {
            const name = nextName(node.name, taken);
            taken.add(name);
            await saveTree(node, destination, name);
        }
    } finally {
        await invalidateFolders(queryClient, destination.id);
    }
    return done;
}
