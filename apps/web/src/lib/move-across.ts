import { contentSize, type DriveNode } from '@hushos/drive/client';
import type { MemoryFile } from '@hushos/drive/transfers';
import { copySignatureForms } from '@hushos/drive/trust';
import type { QueryClient } from '@tanstack/react-query';
import { driveApi } from '@/lib/drive-api';
import {
    clientFor,
    driveOpenQueryOptions,
    folderQueryOptions,
    invalidateFolders,
    nextName,
} from '@/lib/drive';
import { familiesSyncQueryOptions } from '@/lib/families';
import { activeFamily, familiesQueryOptions } from '@/lib/families-shell';
import { openReader, readAll } from '@/lib/previews';
import { SAVE_COPY_MAX_BYTES } from '@/lib/save-copy';
import { openArea } from '@/lib/spaces';
import { stashBytes } from '@/lib/stash';
import { thumbnailBytes } from '@/lib/thumbnails';
import { onTransferEvent, transfers } from '@/lib/transfers';

/*
 * Moving between a person's own files and their family's folders
 * (docs/families-shared-pool.md 3.8). Each is a workspace with keys of its
 * own, and the server copies only within one, so a move across them is done
 * here: each file is read whole and decrypted on this device, queued as an
 * upload under the destination's keys (the server never sees a byte of
 * plaintext). The upload names its source (`moveOf`), and the server deletes
 * the source in the transaction that completes it, or fails the move `stale` and
 * keeps the source if it changed: there is never a moment with both or neither.
 * Where both sides draw from one pool the copy is charged only what it adds, so
 * a full family can move files; across two (billing off, no live plan) it needs
 * the destination's room, as an upload does.
 *
 * Loaded with the move dialog only: it brings the families layer with it.
 */

/* Where a move can go: My files, and each folder of the person's family. */
export type MovePlace = {
    workspaceId: string;
    rootId: string;
    name: string;
    family: { groupId: string; name: string } | null;
};

/*
 * My files and the family's folders, each opened so the dialog can list it. A
 * folder whose keys this device couldn't open, or whose top folder isn't there
 * yet, is left out: nothing could be moved into it here.
 */
export async function movePlaces(queryClient: QueryClient, userId: string): Promise<MovePlace[]> {
    const mine = await queryClient.fetchQuery(driveOpenQueryOptions(userId));
    const places: MovePlace[] = [
        { workspaceId: mine.workspaceId, rootId: mine.root.id, name: 'My files', family: null },
    ];
    const family = activeFamily(await queryClient.fetchQuery(familiesQueryOptions(userId)));
    if (!family) return places;
    const { results } = await queryClient.fetchQuery(familiesSyncQueryOptions(userId));
    const result = results.get(family.id);
    if (!result || result.status !== 'accepted') return places;
    for (const state of result.areas) {
        if (!state.view.root || !state.opened) continue;
        try {
            const { root } = await openArea(userId, family.id, state);
            places.push({
                workspaceId: state.workspaceId,
                rootId: root.id,
                name: state.name ?? 'Family folder',
                family: { groupId: family.id, name: family.name },
            });
        } catch {
            /* Not openable on this device now: not offered. */
        }
    }
    return places;
}

/* Files are read whole into memory to be encrypted again, as a saved copy is. */
export const MOVE_MAX_BYTES = SAVE_COPY_MAX_BYTES;

/*
 * Moves `nodes` (all in one workspace) into `destination`, in another one:
 * folders are made there (they hold no bytes), each file is queued as an upload
 * of its re-encrypted copy, and a source folder goes once everything in it has
 * moved. Every file is checked for size before anything is made. Returns how
 * many files were queued.
 */
export async function moveAcross(
    queryClient: QueryClient,
    nodes: DriveNode[],
    destination: DriveNode,
    options: { onProgress?: (done: number) => void } = {},
) {
    const into = clientFor(destination.workspaceId);
    const listing = await queryClient.fetchQuery(
        folderQueryOptions(destination.id, destination.workspaceId),
    );
    const taken = new Set(listing.children.map((child) => child.name));
    let done = 0;
    const tick = () => options.onProgress?.(++done);

    async function moveFile(node: DriveNode, parent: DriveNode, name: string) {
        const version = node.currentVersion;
        if (!version) throw new Error(`“${node.name}” has no content yet, so it can’t move.`);
        const reader = openReader(node, true);
        let id: string;
        try {
            // Short of the whole file, the copy would replace the original with part of it.
            const { bytes, truncated } = await readAll(reader, MOVE_MAX_BYTES);
            if (truncated || bytes.byteLength !== contentSize(node))
                throw new Error(`“${node.name}” couldn’t be read whole, so it wasn’t moved.`);
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
            // Sealed to the stash first, so a reload continues the move rather than losing it.
            const stash = await stashBytes(bytes);
            [id] = transfers.enqueue([
                {
                    file,
                    parent,
                    name,
                    origin: 'copy',
                    // Signed as the person moving it, as a copy is: a family folder's writer
                    // becomes the mover (docs/families-shared-pool.md 3.8).
                    signAs: copySignatureForms(node, 'drive'),
                    stash: stash ?? undefined,
                    move: {
                        of: {
                            workspaceId: node.workspaceId,
                            nodeId: node.id,
                            versionId: version.id,
                        },
                    },
                },
            ]) as [string];
        } finally {
            await reader.close();
        }
        tick();
        return id;
    }

    /* Returns the uploads queued for `node` and everything in it. */
    async function moveTree(node: DriveNode, parent: DriveNode, name: string): Promise<string[]> {
        if (node.kind === 'file') return [await moveFile(node, parent, name)];
        const [made] = await into.createFolderPath(parent, [name], {
            signAs: copySignatureForms(node, 'drive').metadata,
        });
        tick();
        const queued: string[] = [];
        const children = await clientFor(node.workspaceId).listFolder(node.id);
        for (const child of children.children)
            queued.push(...(await moveTree(child, made!, child.name)));
        return queued;
    }

    // Every file's size first: a move that stops halfway for one large file leaves a mess.
    for (const node of nodes) await refuseLarge(node);
    try {
        for (const node of nodes) {
            const name = nextName(node.name, taken);
            taken.add(name);
            const queued = await moveTree(node, destination, name);
            if (node.kind === 'folder') removeWhenMoved(queryClient, node, queued);
        }
    } finally {
        await invalidateFolders(queryClient, destination.id);
    }
    return done;
}

async function refuseLarge(node: DriveNode): Promise<void> {
    if (node.kind === 'file') {
        const size = contentSize(node);
        // No size: its version envelope didn't open here, so nothing can be read or moved.
        if (size === null)
            throw new Error(`“${node.name}” couldn’t be opened on this device, so it can’t move.`);
        if (size > MOVE_MAX_BYTES)
            throw new Error(
                `“${node.name}” is too large to move between your files and the family’s here. Download it, then upload it there.`,
            );
        return;
    }
    const listing = await clientFor(node.workspaceId).listFolder(node.id);
    for (const child of listing.children) await refuseLarge(child);
}

/*
 * A source folder goes to the Trash once every file queued from it has moved
 * and nothing is listed in it but folders. Only to the Trash: the listing
 * leaves out what was trashed from inside it, and someone may add a file
 * between the look and the trash, so deleting it for good could take files
 * nobody moved. One whose move failed or was cancelled stays, with whatever
 * didn't move. Kept in this tab only: after a reload an emptied folder stays.
 */
function removeWhenMoved(queryClient: QueryClient, folder: DriveNode, queued: string[]) {
    const waiting = new Set(queued);
    const finish = async () => {
        stop();
        const client = clientFor(folder.workspaceId);
        const stack = [folder.id];
        while (stack.length) {
            const listing = await client.listFolder(stack.pop()!);
            for (const child of listing.children) {
                if (child.kind === 'file') return;
                stack.push(child.id);
            }
        }
        await driveApi.trash(folder.workspaceId, folder.id);
        await invalidateFolders(queryClient, folder.parentId);
    };
    const stop = onTransferEvent((event) => {
        if (!waiting.has(event.item.id)) return;
        if (event.type === 'failed' || event.type === 'cancelled' || event.type === 'lost') {
            stop();
            return;
        }
        if (event.type !== 'done') return;
        waiting.delete(event.item.id);
        if (waiting.size === 0) void finish().catch(() => {});
    });
    if (waiting.size === 0) void finish().catch(() => {});
}
