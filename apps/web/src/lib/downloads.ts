import type { DriveNode } from '@hushos/drive/client';
import { createDownloadManager, type DownloadsState, type ZipEntry } from '@hushos/drive/downloads';
import { makeZip, predictLength } from 'client-zip';
import { useSyncExternalStore } from 'react';
import { authClient } from '@/lib/auth-client';
import { downloadWorker, openSink, serviceWorkerUnavailable } from '@/lib/download-sinks';
import { driveClient } from '@/lib/drive';
import { driveApi } from '@/lib/drive-api';

/*
 * The app's download manager: the engine from @hushos/drive with the browser's
 * sinks and client-zip. Zips are store-only: the content is already what the
 * person uploaded, compression would cost CPU for little, and every unzip tool
 * reads it. Sizes are known up front, so the zip announces its length and the
 * browser shows a real progress bar.
 */

async function ensureOpen(node: DriveNode) {
    // A node that came from a listing is already open in the worker; only after a
    // lock, which drops every key, does its folder need listing again.
    if (driveClient.isOpen(node.id) || !node.parentId) return;
    await driveClient.listFolder(node.parentId);
}

function zip(entries: AsyncIterable<ZipEntry>, sizes: { name: string; size: number }[]) {
    const stream = makeZip(
        (async function* () {
            for await (const entry of entries)
                yield {
                    name: entry.name,
                    input: entry.input,
                    size: entry.size,
                    lastModified: entry.lastModified ?? undefined,
                };
        })(),
        { metadata: sizes.map((file) => ({ name: file.name, size: file.size })) },
    );
    return { stream, size: Number(predictLength(sizes)) };
}

export const downloads = createDownloadManager({
    rpc: authClient.rpc,
    api: driveApi,
    openSink,
    // Without the service worker the save dialog needs the click's activation, so
    // the sink opens before any folder is listed or URL minted.
    openSinkEarly: serviceWorkerUnavailable,
    listFolder: (folderId) => driveClient.listFolder(folderId),
    ensureOpen,
    zip,
});

/* Warm the service worker so the first download does not wait on registration. */
export function prepareDownloads() {
    void downloadWorker();
}

/* Downloads a selection: one file as itself, otherwise a zip named after the folder it came from. */
export function downloadNodes(nodes: DriveNode[], folderName?: string) {
    const zipName =
        nodes.length === 1 && nodes[0]!.kind === 'folder'
            ? nodes[0]!.name
            : folderName && folderName !== 'Drive'
              ? folderName
              : 'HushOS files';
    return downloads.download(nodes, zipName);
}

const EMPTY: DownloadsState = { downloads: [], active: 0, bytesPerSecond: 0 };
export function useDownloads() {
    return useSyncExternalStore(downloads.subscribe, downloads.getState, () => EMPTY);
}
