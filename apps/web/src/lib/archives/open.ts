import type { DriveNode } from '@hushos/drive/client';
import { nodeSize } from '@/lib/drive';
import { downloads } from '@/lib/downloads';
import {
    openReader,
    PREVIEW_LIMITS,
    readAll,
    recallPreview,
    rememberPreview,
    type PreviewKind,
} from '@/lib/previews';
import { memoryReader, type RangeReader } from '@/lib/tools/ranges';
import type { ArchiveEntry } from './session';

/*
 * The pieces the archive view opens an archive and its entries with: the worker, the archive's
 * bytes, and what an entry is to the viewer's renderers.
 */

/* A new archive worker: same origin, a module, one self-contained file (its policy loads nothing). */
export function archiveWorker() {
    return new Worker(new URL('./archive.tool-worker.ts', import.meta.url), {
        type: 'module',
        name: 'archive',
    });
}

/*
 * Fetches the worker's script after unlock (lib/preload.ts), so opening a zip fetches no code
 * that would say a zip was opened: a worker is started, which loads the script, and let go.
 */
export function preloadArchiveWorker() {
    if (typeof Worker === 'undefined') return;
    try {
        const worker = archiveWorker();
        setTimeout(() => worker.terminate(), 30_000);
    } catch {
        // No module workers here: the viewer says so when a zip is opened.
    }
}

/*
 * The archive's bytes for its worker. Up to 16 MiB it is read whole, padding and all, and
 * remembered like a PDF, so its reads look like a download; larger, the download engine's
 * reader fetches and decrypts the 8 MiB chunks each range covers. `signal` (the viewer closed)
 * stops a whole read at once: its reader is closed, so no further chunk is fetched or decrypted,
 * and nothing is remembered.
 */
export async function archiveReader(node: DriveNode, signal?: AbortSignal): Promise<RangeReader> {
    signal?.throwIfAborted();
    const size = nodeSize(node) ?? Infinity;
    const versionId = node.currentVersion?.id ?? null;
    if (size <= PREVIEW_LIMITS.document) {
        const remembered = versionId ? recallPreview(versionId) : null;
        if (remembered?.kind === 'document') return memoryReader(remembered.data);
        const reader = openReader(node, true);
        const stop = () => void reader.close();
        signal?.addEventListener('abort', stop, { once: true });
        try {
            const { bytes } = await readAll(reader, PREVIEW_LIMITS.document);
            signal?.throwIfAborted();
            if (versionId)
                rememberPreview(versionId, { kind: 'document', data: bytes, bytes: bytes.length });
            return memoryReader(bytes);
        } finally {
            signal?.removeEventListener('abort', stop);
            void reader.close();
        }
    }
    // A tool's reader without its lifetime cap: the archive's tail (its directory) kept, and the
    // padding after it fetched beside it and always to the end, so a quick refusal doesn't show
    // the store where the file ends. The worker's reads are bounded per action by the session.
    const reader = downloads.openReader(node, 4, { tool: true, uncapped: true });
    return {
        size: reader.size,
        fresh: true,
        read: (offset, length) => reader.read(offset, length),
        close: () => reader.close(),
    };
}

const MiB = 1024 * 1024;

/*
 * How much an entry may inflate to for a preview (section 3, "Limits"): the viewer's limit for
 * its kind, and 64 MiB for PDF, media and Office files. A stored entry is read by range instead,
 * at any size.
 */
export function entryLimit(kind: PreviewKind) {
    switch (kind) {
        case 'image':
            return PREVIEW_LIMITS.image;
        case 'text':
        case 'markdown':
        case 'none':
            return PREVIEW_LIMITS.text;
        case 'pdf':
        case 'video':
        case 'audio':
        case 'office':
            return 64 * MiB;
        case 'archive':
            return 0;
    }
}

/* When the entry last changed: its Unix time when the archive kept one, else its MS-DOS date and time, local. */
export function entryWhen(entry: Pick<ArchiveEntry, 'dos' | 'mtime'>) {
    if (entry.mtime !== null) return new Date(entry.mtime).toISOString();
    const date = entry.dos >>> 16;
    const time = entry.dos & 0xffff;
    const month = (date >> 5) & 0xf;
    const day = date & 0x1f;
    if (!month || !day) return null;
    const when = new Date(
        ((date >> 9) & 0x7f) + 1980,
        month - 1,
        day,
        time >> 11,
        (time >> 5) & 0x3f,
        (time & 0x1f) * 2,
    );
    return Number.isNaN(when.getTime()) ? null : when.toISOString();
}

/*
 * The entry as a node the viewer's renderers take: its name and size, no recorded type (the
 * archive's would say zip; the name decides), and a version id of its own, so a preview the
 * viewer remembers is the entry's and goes on lock with the rest.
 */
export function entryNode(archive: DriveNode, entry: ArchiveEntry): DriveNode {
    const name = entry.name;
    const version = archive.currentVersion!;
    return {
        ...archive,
        id: `${archive.id}#${entry.index}`,
        kind: 'file',
        name,
        metadata: { name, mime: null, size: entry.size, modified: entryWhen(entry) },
        content: { plaintextSize: entry.size, thumbnailBytes: 0 },
        currentVersion: { ...version, id: `${version.id}#${entry.index}` },
    };
}
