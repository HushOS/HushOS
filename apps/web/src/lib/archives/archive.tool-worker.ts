import { rangeSource, turns } from '@/lib/tools/worker';
import { CHUNK_BYTES, type FromArchive, type ToArchive, type WireEntry } from './protocol';
import { ZipArchive } from './zip-archive';
import { ZipError } from './zip-format';

/*
 * The archive viewer's worker: a zip open in the viewer, for as long as it is open. It lists the
 * archive, previews and downloads entries, and keeps the password the person typed, which never
 * leaves it and goes when the page terminates it (on close, lock or sign-out). A tools worker:
 * its file is `*.tool-worker.ts`, so it runs under a policy that names no source (no fetch, no
 * import, no worker of its own), and it is bundled as one file with zip.js inside, zip.js's own
 * workers off. It reads the archive only by range, through the page.
 */

type Scope = {
    postMessage(message: FromArchive, transfer?: Transferable[]): void;
    onmessage: ((event: MessageEvent<ToArchive>) => void) | null;
};
const scope = self as unknown as Scope;

let archive: ZipArchive | null = null;
let opening: Promise<ZipArchive> | null = null;
/* Each download in flight: what stops it, and what lets its next chunk go. */
const running = new Map<number, { stop: AbortController; more: (() => void) | null }>();

/* Set by every read and every piece produced; the page's watchdog hears of it each second. */
let moved = false;

const codeOf = (error: unknown) => (error instanceof ZipError ? error.code : 'damaged');
const fail = (id: number | null, error: unknown) =>
    scope.postMessage({ type: 'fail', id, code: codeOf(error) });

function wire(opened: ZipArchive): WireEntry[] {
    return opened.listed.map((item) => ({
        index: item.index,
        path: item.path,
        folder: item.folder,
        name: item.name,
        directory: item.directory,
        size: item.size,
        packed: item.packed,
        dos: item.dos,
        mtime: item.mtime,
        lock: item.lock,
        support: item.support,
        link: item.link,
        nested: item.nested,
        hidden: item.hidden,
        stored: item.stored,
        saveName: item.saveName,
    }));
}

async function ready() {
    if (archive) return archive;
    if (!opening) throw new ZipError('damaged');
    return opening;
}

async function download(id: number, index: number) {
    const stop = new AbortController();
    const state = { stop, more: null as (() => void) | null };
    running.set(id, state);
    const gathered = new Uint8Array(CHUNK_BYTES);
    let size = 0;
    // One chunk crosses at a time, never more than CHUNK_BYTES: the next waits until the page has
    // written this one. What an inflater hands back at once is cut, however large it came.
    const send = async () => {
        if (!size) return;
        const bytes = gathered.subarray(0, size).slice();
        size = 0;
        const taken = new Promise<void>((resolve) => (state.more = resolve));
        scope.postMessage({ type: 'chunk', id, bytes: bytes.buffer }, [bytes.buffer]);
        await taken;
        if (stop.signal.aborted) throw new ZipError('damaged');
    };
    const gather = async (chunk: Uint8Array) => {
        for (let at = 0; at < chunk.length;) {
            const take = Math.min(CHUNK_BYTES - size, chunk.length - at);
            gathered.set(chunk.subarray(at, at + take), size);
            size += take;
            at += take;
            if (size === CHUNK_BYTES) await send();
        }
    };
    try {
        const opened = await ready();
        await opened.download(
            index,
            async (chunk) => {
                moved = true;
                await gather(chunk);
            },
            stop.signal,
        );
        await send();
        scope.postMessage({ type: 'end', id });
    } catch (error) {
        if (!stop.signal.aborted) fail(id, error);
    } finally {
        running.delete(id);
    }
}

scope.onmessage = (event) => {
    const msg = event.data;
    switch (msg.type) {
        case 'open': {
            if (opening) return;
            const ranges = rangeSource(msg.size, msg.port, turns());
            opening = ZipArchive.open({
                size: ranges.size,
                read: (offset, length) => {
                    moved = true;
                    return ranges.read(offset, length);
                },
            });
            opening.then(
                (opened) => {
                    archive = opened;
                    const { parents, names } = opened.takeFolders();
                    scope.postMessage(
                        {
                            type: 'listing',
                            entries: wire(opened),
                            hidden: opened.hidden,
                            parents,
                            names,
                        },
                        [parents.buffer],
                    );
                },
                (error: unknown) => fail(null, error),
            );
            return;
        }
        case 'unlock':
            void ready()
                .then((opened) => opened.unlock(msg.password, msg.index ?? undefined))
                .then(
                    (ok) => scope.postMessage({ type: 'unlocked', id: msg.id, ok }),
                    (error: unknown) => fail(msg.id, error),
                );
            return;
        case 'preview':
            void (async () => {
                try {
                    const opened = await ready();
                    const listed = opened.listed.find((item) => item.index === msg.index);
                    // A stored entry up to the limit is read whole, so its CRC is checked before it
                    // shows; a larger one is read by range, unchecked, and the page says so.
                    if (listed?.stored && listed.size > msg.limit) {
                        const { offset, size } = await opened.span(msg.index);
                        scope.postMessage({ type: 'span', id: msg.id, offset, size });
                        return;
                    }
                    const bytes = await opened.preview(msg.index, msg.limit);
                    scope.postMessage(
                        { type: 'bytes', id: msg.id, bytes: bytes.buffer as ArrayBuffer },
                        [bytes.buffer as ArrayBuffer],
                    );
                } catch (error) {
                    fail(msg.id, error);
                }
            })();
            return;
        case 'download':
            void download(msg.id, msg.index);
            return;
        case 'more': {
            const state = running.get(msg.id);
            const more = state?.more;
            if (state) state.more = null;
            more?.();
            return;
        }
        case 'stop': {
            const state = running.get(msg.id);
            if (!state) return;
            state.stop.abort();
            state.more?.();
            return;
        }
    }
};

// Progress for the page's watchdog: only when a read or a produced piece happened since the last
// tick, so a worker stuck in a loop, or waiting on nothing, says nothing.
setInterval(() => {
    if (!moved) return;
    moved = false;
    scope.postMessage({ type: 'progress', id: -1 });
}, 1_000);
