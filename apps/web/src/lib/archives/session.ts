import type { DownloadSink, FileReader } from '@hushos/drive/downloads';
import { CHUNK_SIZE } from '@hushos/crypto/drive';
import { trackToolRun } from '@/lib/tools/active';
import { TOOL_FAILED, TOOL_WATCHDOG_MS } from '@/lib/tools/protocol';
import { readAllowance, serveRanges, type RangeReader } from '@/lib/tools/ranges';
import { createWatchdog, type Watchdog } from '@/lib/tools/watchdog';
import { CHUNK_BYTES, type FromArchive, type ToArchive, type WireEntry } from './protocol';
import { ZIP_LIMITS } from './zip-format';
import { entryRefusalWords, refusalWords } from './words';

/*
 * A zip open in the viewer, from the page (docs/file-tools-design.md, section 1 (a)): one archive
 * worker for as long as the viewer shows it, the archive served to it by range, its answers
 * checked. Browsing is a viewer, not a run, so it never waits behind one, but it keeps the
 * harness's rules: the worker reads only through the page, a watchdog stops it once it goes 30
 * seconds without progress while anything is asked of it, and every message is read once at the
 * boundary with only its checked fields kept. A lock or a sign-out closes it (cancelAllToolRuns),
 * which terminates the worker and with it the password.
 *
 * The worker reads no more than the person's actions need: each one adds to what the page will
 * serve it (four times what the action reads, as a tool's reader allows), so a worker made to
 * seek without end runs out instead of fetching the archive again and again.
 */

export type ArchiveEntry = WireEntry;
/*
 * The list's folders as the page holds them (zip-format.ts's Folders): folder `k`'s parent at
 * `parents[k]`, and its name in `names` from `starts[k]` to just before `starts[k + 1]`'s `/`.
 */
export type FolderList = { parents: Uint32Array; names: string; starts: Uint32Array };
export type Listing = { entries: ArchiveEntry[]; hidden: number; folders: FolderList };

/* Folder `k`'s name ('' for the top). */
export function folderName(folders: FolderList, k: number) {
    return k === 0 ? '' : folders.names.slice(folders.starts[k], folders.starts[k + 1]! - 1);
}

/* A refusal the archive or one of its items met, already in words; `code` says which. */
export class ArchiveRefusal extends Error {
    constructor(
        readonly code: string,
        scope: 'archive' | 'entry' = 'archive',
    ) {
        super((scope === 'entry' ? entryRefusalWords : refusalWords)[code] ?? TOOL_FAILED);
        this.name = 'ArchiveRefusal';
    }
}

const MAX_ENTRIES = 100_000;
/* The folders a listing may make, and the top. */
const MAX_FOLDERS = ZIP_LIMITS.folders + 1;
const MAX_TEXT = 128 * 1024 * 1024;
const LOCKS = new Set(['none', 'zipcrypto', 'aes', 'other']);
const SUPPORTS = new Set(['ok', 'method', 'encryption']);
const MiB = 1024 * 1024;

const whole = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;

/*
 * The folders, checked: each after its parent, each name a part a path could hold (never empty,
 * `.` or holding a separator), no more than the directory could hold; or null.
 */
function readFolders(parents: unknown, names: unknown): FolderList | null {
    if (!(parents instanceof Uint32Array) || typeof names !== 'string') return null;
    const count = parents.length;
    if (count < 1 || count > MAX_FOLDERS || names.length > ZIP_LIMITS.directoryBytes) return null;
    if (parents[0] !== 0 || names.includes('\\')) return null;
    const starts = new Uint32Array(count + 1);
    let at = 0;
    // Checked in place: a substring a folder would be millions of strings for a wide archive.
    for (let k = 1; k < count; k++) {
        if (parents[k]! >= k) return null;
        const end = names.indexOf('/', at);
        if (end <= at || (end - at === 1 && names.charCodeAt(at) === 0x2e)) return null;
        starts[k] = at;
        at = end + 1;
    }
    if (at !== names.length) return null;
    starts[count] = at;
    return { parents, names, starts };
}

/* The listing, rebuilt from checked fields only, or null if anything in it is out of shape. */
export function readListing(value: unknown, archiveSize: number): Listing | null {
    const msg = value as {
        entries?: unknown;
        hidden?: unknown;
        parents?: unknown;
        names?: unknown;
    } | null;
    const entries = msg?.entries;
    if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) return null;
    if (!whole(msg?.hidden, entries.length)) return null;
    const folders = readFolders(msg?.parents, msg?.names);
    if (!folders) return null;
    let text = folders.names.length;
    const seen = new Set<number>();
    const out: ArchiveEntry[] = [];
    for (const raw of entries) {
        const item = raw as Record<string, unknown> | null;
        if (!item || typeof item !== 'object') return null;
        const { index, path, folder, name, size, packed, dos, mtime, lock, support } = item;
        if (!whole(index, MAX_ENTRIES - 1) || seen.has(index)) return null;
        seen.add(index);
        if (typeof path !== 'string' || !whole(folder, folders.parents.length - 1)) return null;
        if (typeof name !== 'string' || name.length === 0) return null;
        const saveName: unknown = item.saveName;
        if (typeof saveName !== 'string' || saveName.length === 0 || saveName.length > 255)
            return null;
        text += path.length + name.length + saveName.length;
        if (text > MAX_TEXT) return null;
        if (!whole(size) || !whole(packed, archiveSize) || !whole(dos, 0xffffffff)) return null;
        if (mtime !== null && (typeof mtime !== 'number' || !Number.isFinite(mtime))) return null;
        if (typeof lock !== 'string' || !LOCKS.has(lock)) return null;
        if (typeof support !== 'string' || !SUPPORTS.has(support)) return null;
        const flag = (name: string) => item[name] === true;
        for (const name of ['directory', 'link', 'nested', 'hidden', 'stored'])
            if (typeof item[name] !== 'boolean') return null;
        out.push({
            index,
            path,
            folder,
            name,
            directory: flag('directory'),
            size,
            packed,
            dos,
            mtime: mtime as number | null,
            lock: lock as ArchiveEntry['lock'],
            support: support as ArchiveEntry['support'],
            link: flag('link'),
            nested: flag('nested'),
            hidden: flag('hidden'),
            stored: flag('stored'),
            saveName,
        });
    }
    return { entries: out, hidden: msg!.hidden as number, folders };
}

/* A reader over bytes the viewer holds: an entry the worker inflated. Closing it lets them go. */
export function bytesReader(bytes: Uint8Array): FileReader {
    let held: Uint8Array | null = bytes;
    return {
        size: bytes.length,
        async read(offset, length) {
            if (!held) throw new Error('The preview was closed.');
            const start = Math.min(Math.max(0, offset), held.length);
            return held.slice(start, Math.min(held.length, start + Math.max(0, length)));
        },
        async close() {
            held = null;
        },
    };
}

/* A reader over part of the archive: a stored entry, read by range at any size. */
/* `archive`'s bytes from `offset`, `size` of them; closing it closes `archive` when `owned`. */
function spanReader(archive: RangeReader, offset: number, size: number, owned = false): FileReader {
    let open = true;
    return {
        size,
        async read(at, length) {
            if (!open) throw new Error('The preview was closed.');
            const start = Math.min(Math.max(0, at), size);
            const end = Math.min(size, start + Math.max(0, length));
            if (end <= start) return new Uint8Array(0);
            // A copy: the archive may be bytes the viewer remembers, and a renderer may move what it gets.
            return (await archive.read(offset + start, end - start)).slice();
        },
        async close() {
            open = false;
            if (owned) await archive.close?.();
        },
    };
}

type Pending = {
    resolve: (value: FromArchive) => void;
    reject: (error: Error) => void;
    /* For a download: where each chunk goes. */
    chunk?: (bytes: ArrayBuffer) => void;
};

export type ArchiveSession = ReturnType<typeof openArchive>;

/*
 * Opens `reader` (the archive's bytes, from the download engine or memory) in a new archive
 * worker. The session owns the reader: it is closed with the session.
 */
export function openArchive(reader: RangeReader, worker: () => Worker) {
    let instance: Worker | null = worker();
    const channel = new MessageChannel();
    let ended: Error | null = null;
    const pending = new Map<number, Pending>();
    let nextId = 1;
    // Downloads the page stopped: what the worker still sends for them is let go.
    const stopped = new Set<number>();
    let active = 0;
    let watchdog: Watchdog | null = null;
    /*
     * What the worker may still be served, in bytes: each action adds to it. A reader that fetches
     * by chunk (`meter`) is charged each chunk it fetches, whatever a read asked for, so a worker
     * cycling one-byte reads across chunks pays 8 MiB a read; its actions are granted three
     * chunks more (a local header in the chunk before, an entry across a boundary, the tail).
     * Any other reader (the archive in memory) is charged the bytes each read asks for.
     */
    let allowed = 0;
    const metered = typeof reader.meter === 'function';
    const slack = metered ? 3 * CHUNK_SIZE : MiB;
    const grant = (bytes: number) =>
        (allowed += Math.min(4 * bytes + slack, 4 * reader.size + slack));
    reader.meter?.((bytes) => {
        if (bytes > allowed) {
            broken();
            throw new Error('The worker read more than it was allowed.');
        }
        allowed -= bytes;
    });

    /* Each download's own reader and its port: let go of with the download, or with the session. */
    const forks = new Set<() => void>();

    function end(error: Error) {
        if (ended) return;
        ended = error;
        // Each close takes itself out of the set: deleting what was visited is safe while iterating.
        for (const close of forks) close();
        forks.clear();
        watchdog?.stop();
        watchdog = null;
        instance?.terminate();
        instance = null;
        stopServing();
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
        listingReject(error);
        untrack();
        void Promise.resolve()
            .then(() => reader.close?.())
            .catch(() => {});
    }
    const broken = () => end(new Error(TOOL_FAILED));

    // While anything is asked of the worker, it must keep reporting progress.
    function begin() {
        if (active++ === 0) watchdog = createWatchdog(TOOL_WATCHDOG_MS, broken);
    }
    function idle() {
        if (--active === 0) {
            watchdog?.stop();
            watchdog = null;
        }
    }

    const counted: RangeReader = {
        size: reader.size,
        fresh: reader.fresh,
        read(offset, length) {
            if (!metered) {
                if (length > allowed) {
                    broken();
                    return Promise.reject(new Error('The worker read more than it was allowed.'));
                }
                allowed -= length;
            }
            return reader.read(offset, length);
        },
    };
    const stopServing = serveRanges(channel.port1, counted, {
        hold: () => watchdog?.hold() ?? (() => {}),
        allowance: readAllowance(),
        onAbuse: broken,
    });

    let listed = false;
    let listingResolve: (listing: Listing) => void = () => {};
    let listingReject: (error: Error) => void = () => {};
    const listing = new Promise<Listing>((resolve, reject) => {
        listingResolve = resolve;
        listingReject = reject;
    });
    listing.catch(() => {});

    function post(message: ToArchive, transfer: Transferable[] = []) {
        if (!instance) return;
        try {
            instance.postMessage(message, transfer);
        } catch {
            broken();
        }
    }

    function settle(id: unknown, message: FromArchive) {
        const waiter = typeof id === 'number' ? pending.get(id) : undefined;
        if (!waiter) return broken();
        pending.delete(id as number);
        idle();
        waiter.resolve(message);
    }

    instance.onmessage = (event: MessageEvent) => {
        if (ended) return;
        const msg = event.data as Record<string, unknown> | null;
        if (typeof msg?.id === 'number' && stopped.has(msg.id)) {
            // Every id gets one last message, `end` after a stop: then it is forgotten here too.
            if (['end', 'fail', 'bytes', 'span'].includes(msg.type as string))
                stopped.delete(msg.id);
            return;
        }
        switch (msg?.type) {
            case 'listing': {
                // Exactly one, first: a second listing (or one after a failure) is a worker off its script.
                if (listed) return broken();
                listed = true;
                const read = readListing(msg, reader.size);
                idle();
                if (!read) return broken();
                listingResolve(read);
                return;
            }
            case 'progress':
                watchdog?.progress();
                return;
            case 'unlocked':
                return settle(msg.id, {
                    type: 'unlocked',
                    id: msg.id as number,
                    ok: msg.ok === true,
                });
            case 'bytes': {
                const bytes = msg.bytes;
                if (!(bytes instanceof ArrayBuffer)) return broken();
                return settle(msg.id, { type: 'bytes', id: msg.id as number, bytes });
            }
            case 'span': {
                const { offset, size } = msg;
                if (!whole(offset) || !whole(size) || offset + size > reader.size) return broken();
                return settle(msg.id, { type: 'span', id: msg.id as number, offset, size });
            }
            case 'chunk': {
                const waiter = typeof msg.id === 'number' ? pending.get(msg.id) : undefined;
                const bytes = msg.bytes;
                if (
                    !waiter?.chunk ||
                    !(bytes instanceof ArrayBuffer) ||
                    bytes.byteLength > 2 * CHUNK_BYTES
                )
                    return broken();
                watchdog?.progress();
                waiter.chunk(bytes);
                return;
            }
            case 'end':
                return settle(msg.id, { type: 'end', id: msg.id as number });
            case 'fail': {
                const code = typeof msg.code === 'string' ? msg.code : 'damaged';
                if (msg.id === null) {
                    if (listed) return broken();
                    listed = true;
                    idle();
                    // The listing's own refusal: the session is over, in its words.
                    return end(new ArchiveRefusal(code));
                }
                const waiter = typeof msg.id === 'number' ? pending.get(msg.id) : undefined;
                if (!waiter) return broken();
                pending.delete(msg.id as number);
                idle();
                waiter.reject(new ArchiveRefusal(code, 'entry'));
                return;
            }
            default:
                broken();
        }
    };
    instance.onerror = (event) => {
        event.preventDefault?.();
        broken();
    };
    instance.onmessageerror = broken;

    // The directory: at most the end records and the largest directory read.
    grant(Math.min(reader.size, ZIP_LIMITS.directoryBytes + 128 * 1024));
    begin();
    post({ type: 'open', size: reader.size, port: channel.port2 }, [channel.port2]);

    function ask(
        message: (id: number) => ToArchive,
        chunk?: (bytes: ArrayBuffer) => void,
        transfer: Transferable[] = [],
    ) {
        if (ended) throw ended;
        const id = nextId++;
        begin();
        const answer = new Promise<FromArchive>((resolve, reject) =>
            pending.set(id, { resolve, reject, chunk }),
        );
        post(message(id), transfer);
        return { id, answer };
    }

    /*
     * A download's own reads, when the reader can fork: a reader with a cache of its own (so
     * downloads side by side never evict each other's chunks) served over a port of its own, each
     * chunk it fetches charged to that download's allowance (its bytes four times, and three
     * chunks), never the archive's. Past it, the worker read more than any download needs.
     */
    function lend(entry: ArchiveEntry) {
        if (!reader.fork) return null;
        let own = 4 * (entry.packed + 65_536 + 512) + 3 * CHUNK_SIZE;
        const forked = reader.fork((bytes) => {
            if (bytes > own) {
                broken();
                throw new Error('The worker read more than it was allowed.');
            }
            own -= bytes;
        });
        const channel = new MessageChannel();
        const stopServing = serveRanges(channel.port1, forked, {
            hold: () => watchdog?.hold() ?? (() => {}),
            allowance: readAllowance(),
            onAbuse: broken,
        });
        const close = () => {
            if (!forks.delete(close)) return;
            stopServing();
            void Promise.resolve()
                .then(() => forked.close?.())
                .catch(() => {});
        };
        forks.add(close);
        return { port: channel.port2, close };
    }

    /* A lock or sign-out ends the session as a close does. */
    const untrack = trackToolRun(() => end(new Error('Locked.')));

    return {
        listing,
        size: reader.size,

        /* Whether `password` opens the archive's locked entries; kept in the worker if it does. */
        async unlock(password: string, entry: ArchiveEntry | null = null) {
            await listing;
            // One try reads at most three entries and 32 MiB in all (zip-archive.ts), plus their headers.
            grant(32 * MiB + 3 * 65_536);
            const asked = ask((id) => ({
                type: 'unlock',
                id,
                password,
                index: entry?.index ?? null,
            }));
            const answer = await asked.answer;
            return answer.type === 'unlocked' && answer.ok;
        },

        /*
         * A reader over the entry for the viewer: its inflated bytes, checked to the end (never past
         * `limit`), or, stored, a range of the archive at any size. `signal` (the viewer left the
         * entry) stops the worker's inflating, and its buffer goes with it.
         */
        async preview(
            entry: ArchiveEntry,
            limit: number,
            signal?: AbortSignal,
        ): Promise<{ reader: FileReader; checked: boolean }> {
            await listing;
            signal?.throwIfAborted();
            grant(entry.packed + 65_536 + 512);
            const asked = ask((id) => ({ type: 'preview', id, index: entry.index, limit }));
            const stop = () => {
                const waiter = pending.get(asked.id);
                if (!waiter) return;
                stopped.add(asked.id);
                post({ type: 'stop', id: asked.id });
                pending.delete(asked.id);
                idle();
                waiter.reject(new Error('Stopped.'));
            };
            signal?.addEventListener('abort', stop, { once: true });
            const answer = await asked.answer.finally(() =>
                signal?.removeEventListener('abort', stop),
            );
            if (answer.type === 'bytes') {
                if (answer.bytes.byteLength !== entry.size || entry.size > limit)
                    throw new Error(TOOL_FAILED);
                return { reader: bytesReader(new Uint8Array(answer.bytes)), checked: true };
            }
            // Only a stored entry past the limit is read by range, and that one isn't checked.
            if (
                answer.type === 'span' &&
                entry.stored &&
                entry.size > limit &&
                answer.size === entry.size
            ) {
                // Read by the page's viewer, not the worker: a reader of its own, never charged to
                // the worker's allowance, so playing and seeking a large entry again and again works.
                const viewer = reader.fork?.();
                return {
                    reader: spanReader(viewer ?? reader, answer.offset, answer.size, !!viewer),
                    checked: false,
                };
            }
            throw new Error(TOOL_FAILED);
        },

        /*
         * The entry streamed into `sink`, a chunk at a time, never more than its declared size.
         * `onProgress` hears the bytes written so far. Stopping aborts the sink.
         */
        download(
            entry: ArchiveEntry,
            sink: DownloadSink,
            onProgress: (written: number) => void = () => {},
        ) {
            let written = 0;
            let id = 0;
            let writing = Promise.resolve();
            let failure: Error | null = null;
            /* Tells the worker to stop, lets go of what it still sends, and fails the download. */
            function halt() {
                if (!id) return;
                stopped.add(id);
                post({ type: 'stop', id });
                const waiter = pending.get(id);
                if (!waiter) return;
                pending.delete(id);
                idle();
                waiter.reject(failure ?? new Error('Stopped.'));
            }
            let lent: ReturnType<typeof lend> = null;
            const finished = (async () => {
                await listing;
                lent = lend(entry);
                if (!lent) grant(entry.packed + 65_536 + 512);
                const port = lent?.port;
                const asked = ask(
                    (asked) => ({
                        type: 'download',
                        id: asked,
                        index: entry.index,
                        ...(port ? { port } : {}),
                    }),
                    (bytes) => {
                        written += bytes.byteLength;
                        if (written > entry.size) {
                            failure = new ArchiveRefusal('size');
                            halt();
                            return;
                        }
                        // Writing the chunk is a wait on the page (or the browser's download), not the worker's time.
                        const release = watchdog?.hold();
                        writing = writing
                            .then(() => sink.write(new Uint8Array(bytes)))
                            .then(
                                () => {
                                    release?.();
                                    onProgress(written);
                                    post({ type: 'more', id });
                                },
                                (error: unknown) => {
                                    release?.();
                                    failure ??=
                                        error instanceof Error ? error : new Error(TOOL_FAILED);
                                    halt();
                                },
                            );
                    },
                    port ? [port] : [],
                );
                id = asked.id;
                await asked.answer;
                await writing;
                if (failure) throw failure;
                if (written !== entry.size) throw new ArchiveRefusal('size');
                await sink.close();
            })();
            // The download's own reader goes with it, however it ends.
            void finished.then(
                () => lent?.close(),
                () => lent?.close(),
            );
            finished.catch(async () => {
                await sink.abort().catch(() => {});
            });
            return {
                done: finished,
                stop: halt,
            };
        },

        /* Terminates the worker (and the password with it) and lets go of the archive. */
        close() {
            end(new Error('Closed.'));
        },
    };
}
