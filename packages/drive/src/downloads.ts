import type { DownloadChunkProgress, DownloadChunkResult } from '@hushos/crypto';
import { CHUNK_SIZE, chunkCount } from '@hushos/crypto/drive';
import type { DriveApi } from './api';
import {
    contentSize,
    versionEnvelopeOf,
    type DriveNode,
    type FolderListing,
    type Rpc,
} from './client';
import { backoffDelay, isOffline, onlineAgain } from './transfers';

/*
 * The download engine. A file is fetched from its presigned URL one chunk at a
 * time, decrypted in the crypto worker, and written in order to a sink the app
 * supplies: the service worker stream, a picked file, or a blob. The plaintext
 * exists only in the worker's decrypt call and in the sink's write; the engine
 * itself keeps no chunk longer than it takes to hand it on.
 *
 * Several files, or a folder, become one zip: the app supplies the zip function
 * and the engine feeds it one plaintext stream per file, in order.
 */

export type DownloadStatus =
    | 'queued'
    | 'preparing'
    | 'downloading'
    | 'paused'
    | 'done'
    | 'failed'
    | 'cancelled';

export type DownloadItem = {
    id: string;
    name: string;
    /* Plaintext bytes in total, when known: the zip's size is known exactly. */
    size: number | null;
    loaded: number;
    files: number;
    status: DownloadStatus;
    error: string | null;
    bytesPerSecond: number;
    startedAt: number | null;
    finishedAt: number | null;
};

export type DownloadsState = {
    downloads: DownloadItem[];
    active: number;
    bytesPerSecond: number;
};

/* Where plaintext goes. `write` may apply backpressure by taking its time. */
export type DownloadSink = {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
};

/* Random access to a file's plaintext, for viewers. */
export type FileReader = {
    size: number;
    read(offset: number, length: number): Promise<Uint8Array>;
    close(): Promise<void>;
};

export type ZipEntry = {
    name: string;
    size: number;
    lastModified: Date | null;
    input: ReadableStream<Uint8Array>;
};

export type DownloadManagerOptions = {
    rpc: Rpc;
    api: DriveApi;
    /*
     * Opens a sink for a download. Called before any bytes are fetched, and, for
     * sinks that need a user gesture, before the engine has awaited anything.
     */
    openSink: (file: { name: string; size: number | null }) => Promise<DownloadSink>;
    /*
     * Whether the sink must be opened before any network work: a sink that needs
     * the click's user activation (a save dialog) is opened first, without knowing
     * the size; the service worker sink prefers to know the size first.
     */
    openSinkEarly?: () => boolean;
    /* Lists a folder, opening its keys on the way; used to walk folders into a zip. */
    listFolder: (folderId: string) => Promise<FolderListing>;
    /* Makes sure a file node's key is in the worker (its folder was listed). */
    ensureOpen: (node: DriveNode) => Promise<void>;
    /* Store-only zip from entries; the app wires client-zip in here. */
    zip?: (
        entries: AsyncIterable<ZipEntry>,
        sizes: { name: string; size: number }[],
    ) => {
        stream: ReadableStream<Uint8Array>;
        size: number | null;
    };
    maxAttempts?: number;
    lookahead?: number;
    now?: () => number;
    /* Whether the device has no network: a failed chunk then waits for one without spending a try. Tests stub it. */
    offline?: () => boolean;
};

type Internal = {
    item: DownloadItem;
    generation: number;
    cancelled: boolean;
    /* While paused, chunk fetches wait on this before starting; the sink simply stalls. */
    gate: { wait: Promise<void>; release: () => void } | null;
    /* The status to return to on resume. */
    resumeTo: 'preparing' | 'downloading';
    sink: DownloadSink | null;
    /* Object ids opened in the worker for this download; closed on the way out. */
    open: Set<string>;
    /* Download URLs minted in one request for every file of a zip, by version id. */
    urls: Map<string, { url: string; expiresAt: number }>;
    completedBytes: number;
    inFlight: Map<string, number>;
};

function isLockError(error: unknown) {
    return error instanceof Error && /locked/i.test(error.message);
}

export function createDownloadManager(options: DownloadManagerOptions) {
    const {
        rpc,
        api,
        maxAttempts = 6,
        lookahead = 1,
        now = () => Date.now(),
        offline = isOffline,
    } = options;
    const downloads = new Map<string, Internal>();
    const order: string[] = [];
    const listeners = new Set<() => void>();
    let snapshot: DownloadsState = { downloads: [], active: 0, bytesPerSecond: 0 };
    let dirty = true;
    let ticker: ReturnType<typeof setInterval> | null = null;
    const speed = new Map<string, { at: number; loaded: number; rate: number }>();

    function emit() {
        dirty = true;
        for (const listener of listeners) listener();
    }
    const isActive = (d: Internal) =>
        d.item.status === 'preparing' ||
        d.item.status === 'downloading' ||
        d.item.status === 'paused';
    const isRunning = (d: Internal) =>
        d.item.status === 'preparing' || d.item.status === 'downloading';
    function loadedOf(d: Internal) {
        let inFlight = 0;
        for (const bytes of d.inFlight.values()) inFlight += bytes;
        return d.completedBytes + inFlight;
    }
    function tick() {
        const at = now();
        let anyActive = false;
        for (const d of downloads.values()) {
            if (!isRunning(d)) {
                speed.delete(d.item.id);
                d.item.bytesPerSecond = 0;
                continue;
            }
            anyActive = true;
            const loaded = loadedOf(d);
            const previous = speed.get(d.item.id);
            if (previous) {
                const seconds = (at - previous.at) / 1000;
                if (seconds > 0)
                    previous.rate =
                        previous.rate * 0.6 +
                        (Math.max(0, loaded - previous.loaded) / seconds) * 0.4;
                previous.at = at;
                previous.loaded = loaded;
                d.item.bytesPerSecond = Math.round(previous.rate);
            } else speed.set(d.item.id, { at, loaded, rate: 0 });
            d.item.loaded = loaded;
        }
        if (!anyActive && ticker) {
            clearInterval(ticker);
            ticker = null;
        }
        emit();
    }
    function getState(): DownloadsState {
        if (dirty) {
            const items = order.map((id) => ({ ...downloads.get(id)!.item }));
            let active = 0;
            let bytesPerSecond = 0;
            for (const d of downloads.values())
                if (isRunning(d)) {
                    active++;
                    bytesPerSecond += d.item.bytesPerSecond;
                }
            snapshot = { downloads: items, active, bytesPerSecond };
            dirty = false;
        }
        return snapshot;
    }
    function subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }
    function set(d: Internal, patch: Partial<DownloadItem>) {
        // A pause taken while the item was between states resumes to the newest one.
        if (patch.status === 'preparing' || patch.status === 'downloading') {
            d.resumeTo = patch.status;
            if (d.gate) patch = { ...patch, status: 'paused' };
        }
        Object.assign(d.item, patch);
        emit();
    }

    function pause(id: string) {
        const d = downloads.get(id);
        if (!d || !isRunning(d)) return;
        let release = () => {};
        const wait = new Promise<void>((resolve) => {
            release = resolve;
        });
        d.gate = { wait, release };
        set(d, { status: 'paused' });
    }
    function resume(id: string) {
        const d = downloads.get(id);
        if (!d || d.item.status !== 'paused' || !d.gate) return;
        const gate = d.gate;
        d.gate = null;
        set(d, { status: d.resumeTo });
        gate.release();
        ticker ??= setInterval(tick, 750);
    }
    function pauseAll() {
        for (const id of order) pause(id);
    }
    function resumeAll() {
        for (const id of order) resume(id);
    }

    /*
     * Chunk access for one file's current version: a URL shared by every chunk and
     * refreshed near expiry, chunks fetched and decrypted in the worker with retry,
     * and the worker's key opened once and closed once. `track` is the download
     * the bytes count towards; a reader for a preview passes none.
     */
    function chunkSource(node: DriveNode, track: Internal | null) {
        const generation = track?.generation ?? 0;
        const version = node.currentVersion;
        if (!version) throw new Error(`“${node.name}” has no content yet.`);
        // The size comes from the version envelope, opened when the folder was listed.
        const size = contentSize(node);
        if (size === null) throw new Error(`“${node.name}” could not be opened on this device.`);
        const plaintextSize = size;
        const total = chunkCount(plaintextSize);
        const objectId = version.objectId;
        // A zip minted URLs for all its files up front; a single file mints its own.
        const minted = track?.urls.get(version.id);
        let url = minted?.url ?? '';
        let urlExpiresAt = minted?.expiresAt ?? 0;
        let issuing: Promise<string> | null = null;
        let opened: Promise<void> | null = null;
        let closed = false;
        const inFlightKey = (index: number) => `${objectId}:${index}`;
        const cancelled = () =>
            closed || (track !== null && (track.cancelled || track.generation !== generation));

        // One URL per file, refreshed when it nears expiry; chunks asking at the
        // same moment share one request rather than each fetching their own.
        function freshUrl() {
            if (url && urlExpiresAt - now() > 60_000) return Promise.resolve(url);
            issuing ??= api
                .downloadUrl(node.workspaceId, version!.id)
                .then((issued) => {
                    url = issued.url;
                    urlExpiresAt = new Date(issued.urlExpiresAt).getTime();
                    return url;
                })
                .finally(() => {
                    issuing = null;
                });
            return issuing;
        }
        function open() {
            opened ??= (async () => {
                await options.ensureOpen(node);
                const opened = await rpc('driveDownloadOpen', {
                    workspaceId: node.workspaceId,
                    nodeId: node.id,
                    version: versionEnvelopeOf(version!),
                    contentNonce: version!.contentNonce,
                });
                if (opened.plaintextSize !== plaintextSize)
                    throw new Error(`“${node.name}” changed while it was being opened.`);
                track?.open.add(objectId);
                void freshUrl().catch(() => {});
            })();
            return opened;
        }
        async function fetchChunk(index: number): Promise<Uint8Array> {
            const key = inFlightKey(index);
            for (let attempt = 1; ; attempt++) {
                if (track?.gate) await track.gate.wait;
                if (cancelled()) throw new Error('Cancelled.');
                track?.inFlight.set(key, 0);
                let result: DownloadChunkResult;
                try {
                    result = await rpc(
                        'driveDownloadChunk',
                        { objectId, url: await freshUrl(), index },
                        {
                            idleTimeoutMs: 120_000,
                            onProgress: (raw) => {
                                const progress = raw as DownloadChunkProgress;
                                if (
                                    track &&
                                    progress.objectId === objectId &&
                                    progress.index === index
                                )
                                    track.inFlight.set(key, progress.loaded);
                            },
                        },
                    );
                } finally {
                    track?.inFlight.delete(key);
                }
                if (result.ok) {
                    if (track) {
                        track.completedBytes += result.plaintext.byteLength;
                        set(track, { loaded: loadedOf(track) });
                    }
                    return result.plaintext;
                }
                if (cancelled()) throw new Error('Cancelled.');
                if (result.status === 403) url = ''; // expired: fetch a fresh one
                if (result.retryable && offline()) {
                    // No network at all: wait for one, and do not count the try.
                    attempt--;
                    await onlineAgain(offline);
                    continue;
                }
                if (!result.retryable || attempt >= maxAttempts) throw new Error(result.message);
                await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt)));
            }
        }
        async function close() {
            closed = true;
            if (!opened) return;
            await rpc('driveDownloadClose', { objectId }).catch(() => {});
            track?.open.delete(objectId);
        }
        return { plaintextSize, total, open, fetchChunk, close };
    }

    /*
     * One file as an ordered plaintext stream. Chunk i+1 is fetched while chunk i
     * is being written, no more, so memory stays at two chunks per file whatever
     * the sink's speed.
     */
    function fileStream(d: Internal, node: DriveNode): ReadableStream<Uint8Array> {
        const source = chunkSource(node, d);
        let next = 0;
        // Chunks in flight, in order. The head is delivered next; behind it sit at
        // most `lookahead` more, so a slow sink never buffers a whole file.
        const queue: Promise<Uint8Array>[] = [];
        function topUp() {
            while (queue.length < lookahead + 1 && next < source.total) {
                const chunk = source.fetchChunk(next++);
                // Its failure surfaces when it reaches the head; until then it must
                // not count as unhandled.
                chunk.catch(() => {});
                queue.push(chunk);
            }
        }
        return new ReadableStream<Uint8Array>({
            start: async () => {
                await source.open();
                topUp();
            },
            pull: async (controller) => {
                const head = queue.shift();
                if (!head) {
                    controller.close();
                    await source.close();
                    return;
                }
                const plaintext = await head;
                topUp();
                controller.enqueue(plaintext);
            },
            cancel: async () => {
                d.cancelled = true;
                await source.close();
            },
        });
    }

    /*
     * Random access to one file for a viewer: a read covers whatever chunks it
     * touches, each decrypted once and kept while it is among the most recently
     * used, so a PDF paging back and forth or a video seeking does not refetch.
     */
    function openReader(node: DriveNode, cacheChunks = 4): FileReader {
        const source = chunkSource(node, null);
        const cache = new Map<number, Promise<Uint8Array>>();
        let closed = false;
        function chunk(index: number) {
            const cached = cache.get(index);
            if (cached) {
                // Most recently used moves to the end.
                cache.delete(index);
                cache.set(index, cached);
                return cached;
            }
            const fetched = source.open().then(() => source.fetchChunk(index));
            fetched.catch(() => cache.delete(index));
            cache.set(index, fetched);
            while (cache.size > cacheChunks) cache.delete(cache.keys().next().value!);
            return fetched;
        }
        return {
            size: source.plaintextSize,
            async read(offset, length) {
                if (closed) throw new Error('The preview was closed.');
                const end = Math.min(source.plaintextSize, offset + length);
                if (offset < 0 || end <= offset) return new Uint8Array(0);
                const first = Math.floor(offset / CHUNK_SIZE);
                const last = Math.floor((end - 1) / CHUNK_SIZE);
                const pieces = await Promise.all(
                    Array.from({ length: last - first + 1 }, (_, i) => chunk(first + i)),
                );
                const out = new Uint8Array(end - offset);
                let written = 0;
                for (let i = 0; i < pieces.length; i++) {
                    const base = (first + i) * CHUNK_SIZE;
                    const from = Math.max(offset, base) - base;
                    const to = Math.min(end, base + CHUNK_SIZE) - base;
                    out.set(pieces[i]!.subarray(from, to), written);
                    written += to - from;
                }
                return out;
            },
            async close() {
                closed = true;
                cache.clear();
                await source.close();
            },
        };
    }

    async function pump(d: Internal, stream: ReadableStream<Uint8Array>, sink: DownloadSink) {
        const reader = stream.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (d.cancelled) throw new Error('Cancelled.');
                await sink.write(value);
            }
            await sink.close();
        } catch (error) {
            await reader.cancel(error).catch(() => {});
            await sink.abort(error).catch(() => {});
            throw error;
        }
    }

    type PlannedFile = { name: string; node: DriveNode; size: number };

    /*
     * Walks folders once into the files a zip will hold with their relative paths.
     * Sibling folders are listed together, so a wide tree costs one round trip per
     * level rather than one per folder.
     */
    async function plan(nodes: DriveNode[], prefix: string, out: PlannedFile[]) {
        const folders: { node: DriveNode; prefix: string }[] = [];
        for (const node of nodes) {
            if (node.kind === 'folder') folders.push({ node, prefix: `${prefix}${node.name}/` });
            else if (node.currentVersion)
                out.push({
                    name: `${prefix}${node.name}`,
                    node,
                    size: contentSize(node) ?? 0,
                });
        }
        const listings = await Promise.all(
            folders.map(async (folder) => ({
                folder,
                listing: await options.listFolder(folder.node.id),
            })),
        );
        for (const { folder, listing } of listings)
            await plan(listing.children, folder.prefix, out);
        return out;
    }

    /* One request for the URLs of every file in a zip; a miss falls back to minting per file. */
    async function mintUrls(d: Internal, files: PlannedFile[]) {
        if (!api.downloadUrls) return;
        // A zip may span workspaces (a shared folder beside one's own); URLs are minted per workspace.
        const byWorkspace = new Map<string, string[]>();
        for (const file of files) {
            const list = byWorkspace.get(file.node.workspaceId) ?? [];
            list.push(file.node.currentVersion!.id);
            byWorkspace.set(file.node.workspaceId, list);
        }
        for (const [workspaceId, ids] of byWorkspace)
            for (let i = 0; i < ids.length; i += 100) {
                const batch = await api
                    .downloadUrls(workspaceId, ids.slice(i, i + 100))
                    .catch(() => null);
                if (!batch) return;
                const expiresAt = new Date(batch.urlExpiresAt).getTime();
                for (const entry of batch.urls)
                    d.urls.set(entry.versionId, { url: entry.url, expiresAt });
            }
    }

    /*
     * Zip entries in order. The next file's stream is built one ahead, so its key,
     * URL and first chunks are in flight while the current file is still being
     * written; memory stays at one file's look-ahead beyond the one streaming.
     */
    async function* entries(d: Internal, files: PlannedFile[]): AsyncGenerator<ZipEntry> {
        const first = files[0];
        let next: ReadableStream<Uint8Array> | null = first ? fileStream(d, first.node) : null;
        for (let i = 0; i < files.length; i++) {
            if (d.cancelled) {
                await next?.cancel().catch(() => {});
                return;
            }
            const file = files[i]!;
            const input = next!;
            const following = files[i + 1];
            next = following ? fileStream(d, following.node) : null;
            yield {
                name: file.name,
                size: file.size,
                lastModified: file.node.metadata?.modified
                    ? new Date(file.node.metadata.modified)
                    : null,
                input,
            };
        }
    }

    /*
     * Starts a download. One file streams as itself; anything else becomes a zip
     * named after the folder, or after the first item when several were picked.
     * The sink is opened first, synchronously with the caller's click when the
     * sink needs that, and the work follows.
     */
    function download(nodes: DriveNode[], zipName?: string) {
        if (!nodes.length) return null;
        const single = nodes.length === 1 && nodes[0]!.kind === 'file' ? nodes[0]! : null;
        const name =
            single?.name ??
            `${zipName ?? (nodes.length === 1 ? nodes[0]!.name : `${nodes[0]!.name} and ${nodes.length - 1} more`)}.zip`;
        const id = crypto.randomUUID();
        const d: Internal = {
            item: {
                id,
                name,
                size: single ? (contentSize(single) ?? 0) : null,
                loaded: 0,
                files: single ? 1 : 0,
                status: 'preparing',
                error: null,
                bytesPerSecond: 0,
                startedAt: now(),
                finishedAt: null,
            },
            generation: 0,
            cancelled: false,
            gate: null,
            resumeTo: 'preparing',
            sink: null,
            open: new Set(),
            urls: new Map(),
            completedBytes: 0,
            inFlight: new Map(),
        };
        downloads.set(id, d);
        order.push(id);
        emit();
        ticker ??= setInterval(tick, 750);
        void (async () => {
            try {
                if (single) {
                    if (!single.currentVersion) throw new Error('This file has no content yet.');
                    const sink = await options.openSink({ name, size: d.item.size });
                    d.sink = sink;
                    set(d, { status: 'downloading' });
                    await pump(d, fileStream(d, single), sink);
                } else {
                    if (!options.zip) throw new Error('Folder downloads are not available here.');
                    const early = options.openSinkEarly?.()
                        ? await options.openSink({ name, size: null })
                        : null;
                    if (early) d.sink = early;
                    const files = await plan(nodes, '', []);
                    await mintUrls(d, files);
                    const list = files.map((file) => ({ name: file.name, size: file.size }));
                    const total = list.reduce((sum, file) => sum + file.size, 0);
                    set(d, { files: list.length });
                    const zipped = options.zip(entries(d, files), list);
                    set(d, { size: zipped.size ?? total });
                    const sink = early ?? (await options.openSink({ name, size: zipped.size }));
                    d.sink = sink;
                    set(d, { status: 'downloading' });
                    await pump(d, zipped.stream, sink);
                }
                if (!d.cancelled)
                    set(d, {
                        status: 'done',
                        finishedAt: now(),
                        loaded: d.item.size ?? loadedOf(d),
                    });
            } catch (error) {
                for (const objectId of d.open)
                    await rpc('driveDownloadClose', { objectId }).catch(() => {});
                d.open.clear();
                if (d.cancelled) {
                    set(d, { status: 'cancelled', finishedAt: now() });
                    return;
                }
                set(d, {
                    status: 'failed',
                    finishedAt: now(),
                    error: isLockError(error)
                        ? 'The device was locked. Unlock it and download again.'
                        : error instanceof Error
                          ? error.message
                          : 'The download failed.',
                });
            }
        })();
        return id;
    }

    async function cancel(id: string) {
        const d = downloads.get(id);
        if (!d || !isActive(d)) return;
        d.cancelled = true;
        d.generation++;
        d.gate?.release();
        d.gate = null;
        for (const objectId of d.open)
            await rpc('driveDownloadClose', { objectId }).catch(() => {});
        d.open.clear();
        await d.sink?.abort(new Error('Cancelled.')).catch(() => {});
        set(d, { status: 'cancelled', finishedAt: now() });
    }
    function remove(id: string) {
        const d = downloads.get(id);
        if (!d || isActive(d)) return;
        downloads.delete(id);
        order.splice(order.indexOf(id), 1);
        emit();
    }
    function clearFinished() {
        for (const id of order.slice()) {
            const status = downloads.get(id)!.item.status;
            if (status === 'done' || status === 'cancelled') remove(id);
        }
    }

    return {
        download,
        openReader,
        pause,
        resume,
        pauseAll,
        resumeAll,
        cancel,
        remove,
        clearFinished,
        getState,
        subscribe,
    };
}

export type DownloadManager = ReturnType<typeof createDownloadManager>;
