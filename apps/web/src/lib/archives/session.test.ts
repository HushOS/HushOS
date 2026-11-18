import { describe, expect, it } from 'vitest';
import { folderName, readListing, type ArchiveEntry } from './session';

/*
 * The page's boundary against the archive worker: a worker a hostile file took over can send the
 * page anything, and readListing is all that stands between that and the viewer's tree. Every
 * field is checked and copied; anything out of shape refuses the whole listing.
 */

const entry = (overrides: Record<string, unknown> = {}) => ({
    index: 0,
    path: 'docs/readme.txt',
    folder: 1,
    name: 'readme.txt',
    directory: false,
    size: 10,
    packed: 8,
    dos: 0,
    mtime: null,
    lock: 'none',
    support: 'ok',
    link: false,
    nested: false,
    hidden: false,
    stored: false,
    saveName: 'readme.txt',
    ...overrides,
});

/* A listing message: its entries under the folders `docs` (1) and `docs/notes` (2) unless others are given. */
const message = (
    entries: unknown[],
    {
        hidden = 0,
        parents = Uint32Array.of(0, 0, 1) as unknown,
        names = 'docs/notes/' as unknown,
    } = {},
) => ({ entries, hidden, parents, names });

describe('reading the worker’s listing', () => {
    it('keeps only the fields it checks, and finds each folder’s name', () => {
        const read = readListing(message([entry({ extra: new ArrayBuffer(1024) })]), 100);
        expect(read).not.toBeNull();
        expect(read!.entries[0]).not.toHaveProperty('extra');
        expect(read!.entries[0]!.folder).toBe(1);
        expect([0, 1, 2].map((k) => folderName(read!.folders, k))).toEqual(['', 'docs', 'notes']);
    });

    it('refuses folders that aren’t a tree, or names no path could hold', () => {
        const refused = (parents: unknown, names: unknown) =>
            readListing(message([entry()], { parents, names }), 100);
        expect(refused(Uint32Array.of(0, 0, 1), 'docs/notes/')).not.toBeNull();
        // A folder before its parent, or its own parent: a loop the view could walk forever.
        expect(refused(Uint32Array.of(0, 2, 0), 'docs/notes/')).toBeNull();
        expect(refused(Uint32Array.of(0, 1, 1), 'docs/notes/')).toBeNull();
        expect(refused(Uint32Array.of(1, 0, 1), 'docs/notes/')).toBeNull();
        // A name for every folder, each one a part: not empty, `.` or holding a separator.
        expect(refused(Uint32Array.of(0, 0, 1), 'docs/')).toBeNull();
        expect(refused(Uint32Array.of(0, 0, 1), 'docs/notes/more/')).toBeNull();
        expect(refused(Uint32Array.of(0, 0, 1), 'docs/notes')).toBeNull();
        expect(refused(Uint32Array.of(0, 0, 1), 'docs//')).toBeNull();
        expect(refused(Uint32Array.of(0, 0, 1), 'docs/./')).toBeNull();
        expect(refused(Uint32Array.of(0, 0, 1), 'docs/a\\b/')).toBeNull();
        expect(refused([0, 0, 1], 'docs/notes/')).toBeNull();
        expect(refused(new Uint32Array(0), '')).toBeNull();
    });

    it('refuses repeated indexes, an entry packed larger than the archive, and odd values', () => {
        expect(readListing(message([entry(), entry()]), 100)).toBeNull();
        expect(readListing(message([entry({ packed: 101 })]), 100)).toBeNull();
        for (const odd of [
            { lock: 'pkware' },
            { support: 'maybe' },
            { size: -1 },
            { size: 1.5 },
            { stored: 'yes' },
            { folder: 3 },
            { folder: -1 },
            { name: '' },
            { saveName: '' },
            { saveName: 'x'.repeat(256) },
            { mtime: Number.NaN },
        ])
            expect(readListing(message([entry(odd)]), 100), JSON.stringify(odd)).toBeNull();
    });

    it('refuses more than 100,000 entries, and a hidden count above the entries', () => {
        expect(readListing(message([entry()], { hidden: 2 }), 100)).toBeNull();
        expect(readListing(message(Array.from({ length: 100_001 }, () => null)), 100)).toBeNull();
    });
});

describe('what the worker names and dates', () => {
    it('makes an entry’s save name safe again on the page, never taking the worker’s word', () => {
        const listing = readListing(
            message([entry({ saveName: 'invoice\u202Etxt.exe', name: 'invoice.exe' })]),
            1000,
        )!;
        // The override that would make "…exe" read as "…txt" never reaches the browser's save.
        expect(listing.entries[0]!.saveName).toBe('invoice_txt.exe');
        expect(readListing(message([entry({ saveName: 'CON' })]), 1000)!.entries[0]!.saveName).toBe(
            '_CON',
        );
    });

    it('refuses a time a Date can’t hold, which would throw where the entry is shown', () => {
        expect(readListing(message([entry({ mtime: 8.64e15 })]), 1000)).not.toBeNull();
        expect(readListing(message([entry({ mtime: 8.64e15 + 1 })]), 1000)).toBeNull();
        expect(readListing(message([entry({ mtime: -9e15 })]), 1000)).toBeNull();
    });
});

describe('a lock or sign-out', () => {
    it('terminates the archive’s worker, and the password with it, and refuses every later call', async () => {
        const { openArchive } = await import('./session');
        const { cancelAllToolRuns } = await import('@/lib/tools/active');
        const { memoryReader } = await import('@/lib/tools/ranges');
        const posted: { type: string }[] = [];
        let terminated = false;
        const fake = {
            onmessage: null as ((event: MessageEvent) => void) | null,
            onerror: null,
            onmessageerror: null,
            postMessage: (message: { type: string }) => posted.push(message),
            terminate: () => void (terminated = true),
        };
        const session = openArchive(
            memoryReader(new Uint8Array(100)),
            () => fake as unknown as Worker,
        );
        fake.onmessage!({
            data: { type: 'listing', ...message([entry()]) },
        } as MessageEvent);
        await session.listing;
        const unlocking = session.unlock('the password');
        await Promise.resolve();
        expect(posted.map((message) => message.type)).toEqual(['open', 'unlock']);
        cancelAllToolRuns();
        expect(terminated).toBe(true);
        await expect(unlocking).rejects.toThrow();
        await expect(session.unlock('again')).rejects.toThrow();
        // Nothing more reaches a worker that is gone.
        expect(posted.map((message) => message.type)).toEqual(['open', 'unlock']);
    });
});

describe('leaving an entry while it previews', () => {
    it('stops the worker’s preview, and its late answer neither shows nor breaks the archive', async () => {
        const { openArchive } = await import('./session');
        const { memoryReader } = await import('@/lib/tools/ranges');
        const posted: { type: string; id?: number }[] = [];
        let terminated = false;
        const fake = {
            onmessage: null as ((event: MessageEvent) => void) | null,
            onerror: null,
            onmessageerror: null,
            postMessage: (message: { type: string; id?: number }) => posted.push(message),
            terminate: () => void (terminated = true),
        };
        const session = openArchive(
            memoryReader(new Uint8Array(100)),
            () => fake as unknown as Worker,
        );
        fake.onmessage!({ data: { type: 'listing', ...message([entry()]) } } as MessageEvent);
        await session.listing;
        const leaving = new AbortController();
        const previewing = session.preview(entry() as ArchiveEntry, 1024, leaving.signal);
        await Promise.resolve();
        await Promise.resolve();
        const asked = posted.find((message) => message.type === 'preview')!;
        leaving.abort();
        await expect(previewing).rejects.toThrow('Stopped.');
        expect(posted.at(-1)).toEqual({ type: 'stop', id: asked.id });
        // The worker's last message for it (`end`, after a stop) is let go: not a broken worker.
        fake.onmessage!({ data: { type: 'end', id: asked.id } } as MessageEvent);
        expect(terminated).toBe(false);
        // And the id is forgotten with it: anything more for it is a worker off its script.
        fake.onmessage!({
            data: { type: 'bytes', id: asked.id, bytes: new ArrayBuffer(10) },
        } as MessageEvent);
        expect(terminated).toBe(true);
    });
});

describe('a worker cycling one-byte reads across chunks', () => {
    it('is charged each 8 MiB chunk fetched, and stopped once its actions’ allowance is spent', async () => {
        const { openArchive } = await import('./session');
        const CHUNK = 8 * 1024 * 1024;
        // The download engine's reader as the session sees it: four chunks cached, each other one fetched.
        const cache: number[] = [];
        let fetched = 0;
        let charge: ((bytes: number) => void) | null = null;
        const reader = {
            size: 6 * CHUNK,
            meter: (counting: (bytes: number) => void) => void (charge = counting),
            async read(offset: number, length: number) {
                const index = Math.floor(offset / CHUNK);
                if (!cache.includes(index)) {
                    charge!(CHUNK);
                    fetched++;
                    cache.push(index);
                    if (cache.length > 4) cache.shift();
                }
                return new Uint8Array(length);
            },
        };
        let port: MessagePort | null = null;
        let terminated = false;
        const fake = {
            onmessage: null as ((event: MessageEvent) => void) | null,
            onerror: null,
            onmessageerror: null,
            postMessage: (message: { type: string; port?: MessagePort }) => {
                if (message.type === 'open') port = message.port!;
            },
            terminate: () => void (terminated = true),
        };
        const session = openArchive(reader, () => fake as unknown as Worker);
        session.listing.catch(() => {});
        await Promise.resolve();
        await Promise.resolve();
        // Opening grants the directory's reads (16 MiB and change, four times, and three chunks).
        const answers: string[] = [];
        port!.onmessage = (event) => answers.push((event.data as { type: string }).type);
        for (let id = 1; id <= 60 && !terminated; id++) {
            port!.postMessage({ type: 'read', id, offset: (id % 5) * CHUNK, length: 1 });
            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        expect(terminated).toBe(true);
        // The allowance the open granted, in whole chunks, and not one fetch past it.
        const granted = 4 * (16 * 1024 * 1024 + 128 * 1024) + 3 * CHUNK;
        expect(fetched).toBe(Math.floor(granted / CHUNK));
        expect(answers.length).toBeLessThan(60);
    });
});

/*
 * The download engine's reader as the session sees it, for a 7-chunk archive: a cache of its
 * own, each other chunk fetched (and charged, when metered); forks with caches of their own.
 */
function engine(chunks = 13) {
    const CHUNK = 8 * 1024 * 1024;
    const fetched = { main: 0, forks: 0, viewer: 0 };
    function reader(
        cacheChunks: number,
        kind: keyof typeof fetched,
        charge?: () => ((bytes: number) => void) | null,
    ) {
        const cache: number[] = [];
        return {
            size: chunks * CHUNK,
            async read(offset: number, length: number) {
                const first = Math.floor(offset / CHUNK);
                const last = Math.floor((offset + Math.max(1, length) - 1) / CHUNK);
                for (let index = first; index <= last; index++) {
                    if (cache.includes(index)) {
                        cache.splice(cache.indexOf(index), 1);
                        cache.push(index);
                        continue;
                    }
                    charge?.()?.(CHUNK);
                    fetched[kind]++;
                    cache.push(index);
                    if (cache.length > cacheChunks) cache.shift();
                }
                return new Uint8Array(length);
            },
            async close() {},
        };
    }
    let counting: ((bytes: number) => void) | null = null;
    const main = {
        ...reader(4, 'main', () => counting),
        meter: (charge: (bytes: number) => void) => void (counting = charge),
        fork: (charge?: (bytes: number) => void) =>
            charge ? reader(2, 'forks', () => charge) : reader(4, 'viewer'),
    };
    return { main, fetched, CHUNK };
}

/* A worker the test drives: it hands back its main port and each download's own. */
function driven() {
    const asked: { type: string; id: number; port?: MessagePort; index?: number }[] = [];
    let main: MessagePort | null = null;
    let terminated = false;
    const fake = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        onerror: null,
        onmessageerror: null,
        postMessage: (message: { type: string; id: number; port?: MessagePort }) => {
            if (message.type === 'open') main = message.port!;
            else asked.push(message);
        },
        terminate: () => void (terminated = true),
    };
    return {
        fake,
        asked,
        main: () => main!,
        terminated: () => terminated,
        send: (data: unknown) => fake.onmessage!({ data } as MessageEvent),
    };
}

/* Reads `length` bytes from `offset` over `port`, as the worker's range source does. */
function reading(port: MessagePort) {
    let next = 0;
    const waiting = new Map<number, (ok: boolean) => void>();
    port.onmessage = (event) => {
        const answer = event.data as { type: string; id: number };
        waiting.get(answer.id)?.(answer.type === 'data');
        waiting.delete(answer.id);
    };
    // A port the page let go of answers nothing: given up on after a moment.
    return (offset: number, length: number) =>
        new Promise<boolean>((resolve) => {
            const id = next++;
            waiting.set(id, resolve);
            port.postMessage({ type: 'read', id, offset, length });
            setTimeout(() => resolve(false), 1_000);
        });
}

const big = (index: number, size: number) =>
    entry({
        index,
        path: `docs/e${index}.bin`,
        name: `e${index}.bin`,
        saveName: `e${index}.bin`,
        size,
        packed: size,
        stored: true,
    });

describe('downloads side by side', () => {
    it('six 8 MiB stored entries all finish, each read through a cache of its own; one-byte cycling is still stopped', async () => {
        const { openArchive } = await import('./session');
        const { main, fetched, CHUNK } = engine();
        const worker = driven();
        const session = openArchive(main, () => worker.fake as unknown as Worker);
        const entries = Array.from({ length: 6 }, (_, i) => big(i, CHUNK));
        worker.send({ type: 'listing', ...message(entries) });
        await session.listing;
        const closed: number[] = [];
        const downloads = entries.map((item) =>
            session.download(item as ArchiveEntry, {
                write: async () => {},
                close: async () => void closed.push(item.index),
                abort: async () => {},
            }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        const started = worker.asked.filter((message) => message.type === 'download');
        expect(started).toHaveLength(6);
        // Each download read in 64 KiB pieces, all six at once, from its entry's place across two chunks.
        await Promise.all(
            started.map(async (message) => {
                expect(message.port).toBeDefined();
                const read = reading(message.port!);
                const at = message.index! * CHUNK + 4096;
                for (let done = 0; done < CHUNK; done += 65_536)
                    expect(await read(at + done, 65_536)).toBe(true);
                // Handed over a MiB at a time, as the worker's chunks are, each once the last was written.
                for (let sent = 0; sent < CHUNK; sent += 1024 * 1024) {
                    worker.send({
                        type: 'chunk',
                        id: message.id,
                        bytes: new ArrayBuffer(1024 * 1024),
                    });
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
                worker.send({ type: 'end', id: message.id });
            }),
        );
        await Promise.all(downloads.map((download) => download.done));
        expect(closed.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(worker.terminated()).toBe(false);
        // Two chunks each: never a chunk fetched twice because another download evicted it.
        expect(fetched.forks).toBe(12);
        expect(fetched.main).toBe(0);

        // A download's own port is still bounded: one-byte reads cycling over five chunks stop the worker.
        const last = session.download(big(0, CHUNK) as ArchiveEntry, {
            write: async () => {},
            close: async () => {},
            abort: async () => {},
        });
        last.done.catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 0));
        const hostile = reading(worker.asked.at(-1)!.port!);
        for (let n = 0; n < 60 && !worker.terminated(); n++) await hostile((n % 5) * CHUNK, 1);
        expect(worker.terminated()).toBe(true);
        // Its allowance (8 MiB four times, and three chunks) in whole chunks, and not one fetch past it.
        const allowed = Math.floor((4 * (CHUNK + 65_536 + 512) + 3 * CHUNK) / CHUNK);
        expect(fetched.forks - 12).toBe(allowed);
    });
});

describe('a large stored entry played by range', () => {
    it('plays through six times with seeks, never charged to the worker, whose own cycling is still stopped', async () => {
        const { openArchive } = await import('./session');
        const { main, fetched, CHUNK } = engine();
        const worker = driven();
        const session = openArchive(main, () => worker.fake as unknown as Worker);
        const video = big(0, 12 * CHUNK);
        worker.send({ type: 'listing', ...message([video]) });
        await session.listing;
        const previewing = session.preview(video as ArchiveEntry, 64 * 1024 * 1024);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const asked = worker.asked.find((message) => message.type === 'preview')!;
        worker.send({ type: 'span', id: asked.id, offset: 4096, size: video.size });
        const { reader, checked } = await previewing;
        expect(checked).toBe(false);
        for (let play = 0; play < 7; play++) {
            // A seek to the end and back, then the whole entry, 1 MiB at a time.
            await reader.read(video.size - 1024, 1024);
            for (let at = 0; at < video.size; at += 1024 * 1024) await reader.read(at, 1024 * 1024);
        }
        expect(worker.terminated()).toBe(false);
        expect(fetched.main).toBe(0);
        expect(fetched.viewer).toBeGreaterThan(7 * 12);
        await reader.close();

        // The worker's own reads are still charged: one-byte cycling over five chunks stops it.
        const hostile = reading(worker.main());
        for (let n = 0; n < 200 && !worker.terminated(); n++) await hostile((n % 5) * CHUNK, 1);
        expect(worker.terminated()).toBe(true);
    });
});

describe('what the worker hands the page', () => {
    it('keeps the folders in an array of their own, never the worker’s larger buffer', () => {
        const parents = new Uint32Array(new ArrayBuffer(32 * 1024 * 1024), 0, 1);
        const listing = readListing(message([], { parents, names: '' }), 1000)!;
        expect(listing).not.toBeNull();
        expect(listing.folders.parents.buffer.byteLength).toBe(4);
        expect([...listing.folders.parents]).toEqual([0]);
    });

    async function downloading() {
        const { openArchive } = await import('./session');
        const { memoryReader } = await import('@/lib/tools/ranges');
        const worker = driven();
        const session = openArchive(
            memoryReader(new Uint8Array(4 << 20)),
            () => worker.fake as unknown as Worker,
        );
        const item = big(0, 2 << 20);
        worker.send({ type: 'listing', ...message([item]) });
        await session.listing;
        const writes: number[] = [];
        let release = () => {};
        const download = session.download(item as ArchiveEntry, {
            // The sink is busy (a slow disk, a save dialog's stream): its write waits.
            write: (chunk) => {
                writes.push(chunk.byteLength);
                return new Promise<void>((resolve) => (release = resolve));
            },
            close: async () => {},
            abort: async () => {},
        });
        download.done.catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 0));
        const asked = worker.asked.find((message) => message.type === 'download')!;
        return { worker, writes, asked, release: () => release() };
    }

    it('takes one download chunk at a time: one more before `more` stops the worker', async () => {
        const { worker, writes, asked } = await downloading();
        worker.send({ type: 'chunk', id: asked.id, bytes: new ArrayBuffer(1 << 20) });
        await Promise.resolve();
        expect(worker.terminated()).toBe(false);
        // Sent on without waiting for `more`, while the sink still writes the first.
        worker.send({ type: 'chunk', id: asked.id, bytes: new ArrayBuffer(1 << 20) });
        expect(worker.terminated()).toBe(true);
        expect(writes).toEqual([1 << 20]);
    });

    it('takes a download’s end only once its last chunk is written', async () => {
        const { worker, asked, release } = await downloading();
        worker.send({ type: 'chunk', id: asked.id, bytes: new ArrayBuffer(1 << 20) });
        worker.send({ type: 'end', id: asked.id });
        expect(worker.terminated()).toBe(true);
        release();
    });

    it('waits for `more`, then takes the next chunk and the end', async () => {
        const { worker, writes, asked, release } = await downloading();
        const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
        worker.send({ type: 'chunk', id: asked.id, bytes: new ArrayBuffer(1 << 20) });
        await tick();
        release();
        await tick();
        expect(worker.asked.filter((message) => message.type === 'more')).toHaveLength(1);
        worker.send({ type: 'chunk', id: asked.id, bytes: new ArrayBuffer(1 << 20) });
        await tick();
        release();
        await tick();
        worker.send({ type: 'end', id: asked.id });
        expect(worker.terminated()).toBe(false);
        expect(writes).toEqual([1 << 20, 1 << 20]);
    });

    it('refuses a chunk in a resizable buffer, which could grow past what was checked', async () => {
        const { worker, writes, asked } = await downloading();
        const resizable = new (ArrayBuffer as unknown as new (
            length: number,
            options: { maxByteLength: number },
        ) => ArrayBuffer)(1024, { maxByteLength: 1 << 30 });
        worker.send({ type: 'chunk', id: asked.id, bytes: resizable });
        expect(worker.terminated()).toBe(true);
        expect(writes).toEqual([]);
    });
});
