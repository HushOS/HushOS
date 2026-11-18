import type { DriveNode } from '@hushos/drive/client';
import { nodeSize } from '@/lib/drive';
import { downloads } from '@/lib/downloads';
import {
    openReader,
    PREVIEW_LIMITS,
    readAll,
    forgetPreviewsWhere,
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
        /*
         * Stopped while the file is read: closed at once. Stopped while its padding is fetched
         * (the file read whole): that fetch finishes first, as a tool's reader lets it, so the
         * store never sees reading stop where the file ends.
         */
        let draining: Promise<void> | null = null;
        const reading = {
            ...reader,
            drain: () => (draining = reader.drain?.() ?? Promise.resolve()),
        };
        const stop = () => {
            if (!draining) void reader.close();
        };
        signal?.addEventListener('abort', stop, { once: true });
        try {
            const { bytes } = await readAll(reading, PREVIEW_LIMITS.document);
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
    // the store where the file ends. Each chunk it fetches is charged to the session's actions
    // (`meter`); until the session meters it, nothing is fetched.
    let charge: ((bytes: number) => void) | null = null;
    const main = toolReader(node, 4, (bytes) => {
        if (!charge) throw new Error('The archive’s reads aren’t counted yet.');
        charge(bytes);
    });
    return {
        ...main,
        meter: (counting) => {
            charge = counting;
        },
        /*
         * A download's own reader (two chunks of its own, so downloads side by side don't evict
         * each other's), charged to that download; or, uncharged, the viewer's reader for a stored
         * entry played by range, which the page reads, not the worker.
         */
        fork: (counting) => {
            if (counting) return toolReader(node, 2, counting);
            const viewer = downloads.openReader(node);
            return {
                size: viewer.size,
                fresh: true,
                read: (offset, length) => viewer.read(offset, length),
                close: () => viewer.close(),
            };
        },
    };
}

/* The download engine's reader for a tool: `charge` hears each chunk it fetches. */
function toolReader(
    node: DriveNode,
    cacheChunks: number,
    charge: (bytes: number) => void,
): RangeReader {
    const reader = downloads.openReader(node, cacheChunks, {
        tool: true,
        uncapped: true,
        onFetch: charge,
    });
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
 * viewer remembers is the entry's and goes on lock with the rest. A locked entry's is the
 * session's too (`session`, one per archive opened): what its password opened is shown again
 * only in the session that proved that password, never from a later one where another entry's
 * password was typed (each entry may have its own).
 */
/*
 * A closed archive session's remembered previews of locked entries: gone with it, never kept in
 * memory until a lock (they are only ever shown again in that session).
 */
export function forgetEntryPreviews(session: string) {
    const own = `@${session}`;
    forgetPreviewsWhere((versionId) => versionId.endsWith(own));
}

export function entryNode(archive: DriveNode, entry: ArchiveEntry, session: string): DriveNode {
    const name = entry.name;
    const version = archive.currentVersion!;
    const own = entry.lock === 'none' ? `${entry.index}` : `${entry.index}@${session}`;
    return {
        ...archive,
        id: `${archive.id}#${own}`,
        kind: 'file',
        name,
        metadata: { name, mime: null, size: entry.size, modified: entryWhen(entry) },
        content: { plaintextSize: entry.size, thumbnailBytes: 0 },
        currentVersion: { ...version, id: `${version.id}#${own}` },
    };
}
