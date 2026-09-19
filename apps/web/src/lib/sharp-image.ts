import { contentSize, type DriveNode } from '@hushos/drive/client';
import { useEffect, useState } from 'react';
import {
    openReader,
    previewKind,
    previewMime,
    readAll,
    recallPreview,
    rememberPreview,
} from '@/lib/previews';

/*
 * The image itself, decrypted here, for the one place a thumbnail is too small
 * and the person has asked to look: the details panel's preview. The thumbnail
 * shows at once; this reads the real file and takes its place when it is ready,
 * only for files under the caller's limit. Lists and grids stay on thumbnails:
 * reading every picture in a folder to draw its tile is not worth the transfer.
 * The viewer's cache keeps the result, so opening the file afterwards costs
 * nothing more.
 */

const CONCURRENCY = 3;
let running = 0;
const waiting: (() => void)[] = [];
async function turn<T>(work: () => Promise<T>) {
    if (running >= CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
        return await work();
    } finally {
        running--;
        waiting.shift()?.();
    }
}

export function useSharpImage(node: DriveNode, limit: number, enabled = true) {
    const versionId = node.currentVersion?.id ?? null;
    const size = contentSize(node) ?? 0;
    const wanted =
        enabled &&
        node.kind === 'file' &&
        versionId !== null &&
        previewKind(node) === 'image' &&
        size > 0 &&
        size <= limit;
    const [loaded, setLoaded] = useState<{ versionId: string; url: string } | null>(null);
    // The cache may let go of a full image while it is on show; the caller's thumbnail takes over again.
    const [broken, setBroken] = useState<string | null>(null);
    useEffect(() => {
        if (!wanted || !versionId) return;
        const known = recallPreview(versionId);
        if (known?.kind === 'image') {
            setLoaded({ versionId, url: known.url });
            return;
        }
        let active = true;
        void turn(async () => {
            if (!active) return;
            const reader = openReader(node);
            try {
                const { bytes } = await readAll(reader, limit);
                const url = URL.createObjectURL(
                    new Blob([bytes as BlobPart], { type: previewMime(node) }),
                );
                rememberPreview(versionId, { kind: 'image', url, bytes: bytes.byteLength });
                if (active) setLoaded({ versionId, url });
            } catch {
                // The thumbnail stays.
            } finally {
                await reader.close();
            }
        });
        return () => {
            active = false;
        };
        // The version names the bytes; the node object changes identity on every listing.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [wanted, versionId, limit]);
    const url =
        loaded && loaded.versionId === versionId && loaded.url !== broken ? loaded.url : null;
    return { url, onError: () => url && setBroken(url) };
}
