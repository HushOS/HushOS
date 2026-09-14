import { contentSize, type DriveNode } from '@hushos/drive/client';
import type { QueryClient } from '@tanstack/react-query';
import { driveClient, folderQueryOptions, invalidateFolders, nextName } from '@/lib/drive';
import { openReader, readAll } from '@/lib/previews';
import { stashBytes } from '@/lib/stash';
import { transfers } from '@/lib/transfers';

/*
 * "Save a copy to my Drive": what a person keeps of something shared with
 * them, by account or by link. A copy out of a share must never carry the
 * sharer's key, so this is a re-encryption: each file is read through the
 * share's key on this device and queued as an ordinary upload under the
 * person's own folder, fresh keys and all. Folders are walked and recreated.
 * Files are read whole first, so very large ones are refused rather than
 * held in memory. The bytes are also stashed in the browser's private storage,
 * because a copy has no file on disk to ask for again after a reload.
 */

export const SAVE_COPY_MAX_BYTES = 256 * 1024 * 1024;

export async function saveCopy(
    queryClient: QueryClient,
    nodes: DriveNode[],
    destination: DriveNode,
    onProgress?: (done: number) => void,
) {
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
        const reader = openReader(node);
        try {
            const { bytes } = await readAll(reader, SAVE_COPY_MAX_BYTES);
            const file = new File([bytes as BlobPart], name, {
                type: node.metadata?.mime ?? '',
                lastModified: node.metadata?.modified
                    ? new Date(node.metadata.modified).getTime()
                    : Date.now(),
            });
            const stash = await stashBytes(bytes);
            transfers.enqueue([
                { file, parent: into, name, origin: 'copy', stash: stash ?? undefined },
            ]);
        } finally {
            await reader.close();
        }
        tick();
    }
    async function saveTree(node: DriveNode, into: DriveNode, name: string) {
        if (node.kind === 'file') return saveFile(node, into, name);
        const [made] = await driveClient.createFolderPath(into, [name]);
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
