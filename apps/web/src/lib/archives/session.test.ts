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
