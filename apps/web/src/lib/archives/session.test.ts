import { describe, expect, it } from 'vitest';
import { readListing } from './session';

/*
 * The page's boundary against the archive worker: a worker a hostile file took over can send the
 * page anything, and readListing is all that stands between that and the viewer's tree. Every
 * field is checked and copied; anything out of shape refuses the whole listing.
 */

const entry = (overrides: Record<string, unknown> = {}) => ({
    index: 0,
    path: 'docs/readme.txt',
    parts: ['docs', 'readme.txt'],
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

describe('reading the worker’s listing', () => {
    it('keeps only the fields it checks, copied', () => {
        const parts = ['docs', 'readme.txt'];
        const read = readListing(
            { entries: [entry({ parts, extra: new ArrayBuffer(1024) })], hidden: 0 },
            100,
        );
        expect(read).not.toBeNull();
        expect(read!.entries[0]).not.toHaveProperty('extra');
        // A copy: the worker's own array is never what the viewer holds.
        expect(read!.entries[0]!.parts).not.toBe(parts);
        expect(read!.entries[0]!.parts).toEqual(parts);
    });

    it('refuses a path deeper than the listing’s cap, and more parts than the archive may spend', () => {
        const deep = Array.from({ length: 257 }, (_, i) => `d${i}`);
        expect(readListing({ entries: [entry({ parts: deep })], hidden: 0 }, 100)).toBeNull();
        expect(
            readListing({ entries: [entry({ parts: deep.slice(0, 256) })], hidden: 0 }, 100),
        ).not.toBeNull();
        // 4,000 entries of 256 parts: a million and twenty-four thousand parts.
        const many = Array.from({ length: 4_000 }, (_, i) =>
            entry({ index: i, parts: deep.slice(0, 256) }),
        );
        expect(readListing({ entries: many, hidden: 0 }, 100)).toBeNull();
    });

    it('refuses repeated indexes, an entry packed larger than the archive, and odd values', () => {
        expect(readListing({ entries: [entry(), entry()], hidden: 0 }, 100)).toBeNull();
        expect(readListing({ entries: [entry({ packed: 101 })], hidden: 0 }, 100)).toBeNull();
        for (const odd of [
            { lock: 'pkware' },
            { support: 'maybe' },
            { size: -1 },
            { size: 1.5 },
            { stored: 'yes' },
            { parts: ['docs', ''] },
            { saveName: '' },
            { saveName: 'x'.repeat(256) },
            { mtime: Number.NaN },
        ])
            expect(
                readListing({ entries: [entry(odd)], hidden: 0 }, 100),
                JSON.stringify(odd),
            ).toBeNull();
    });

    it('refuses more than 100,000 entries, and a hidden count above the entries', () => {
        expect(readListing({ entries: [entry()], hidden: 2 }, 100)).toBeNull();
        expect(
            readListing({ entries: Array.from({ length: 100_001 }, () => null), hidden: 0 }, 100),
        ).toBeNull();
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
            data: { type: 'listing', entries: [entry()], hidden: 0 },
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
