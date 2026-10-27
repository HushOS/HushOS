import { contentSize, type DriveNode } from '@hushos/drive/client';
import { copySignatureForms } from '@hushos/drive/trust';
import type { QueryClient } from '@tanstack/react-query';
import { deviceSession } from '@/lib/device-session';
import { driveClient, folderQueryOptions, invalidateFolders, nextName } from '@/lib/drive';
import { openReader, readAll } from '@/lib/previews';
import type { MemoryFile } from '@hushos/drive/transfers';
import { stashBytes } from '@/lib/stash';
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

export async function saveCopy(
    queryClient: QueryClient,
    nodes: DriveNode[],
    destination: DriveNode,
    source: 'link' | 'drive',
    onProgress?: (done: number) => void,
) {
    // A sign-out while this reads and seals the bytes means none of it is queued afterwards.
    const from = { generation: deviceSession.generation() };
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
            const stash = await stashBytes(bytes);
            transfers.enqueue(
                [
                    {
                        file,
                        parent: into,
                        name,
                        origin: 'copy',
                        signAs: copySignatureForms(node, source),
                        stash: stash ?? undefined,
                    },
                ],
                from,
            );
        } finally {
            await reader.close();
        }
        tick();
    }
    async function saveTree(node: DriveNode, into: DriveNode, name: string) {
        if (node.kind === 'file') return saveFile(node, into, name);
        const [made] = await driveClient.createFolderPath(into, [name], {
            signAs: copySignatureForms(node, source).metadata,
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
