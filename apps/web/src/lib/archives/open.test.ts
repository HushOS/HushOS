// @vitest-environment node
import type { DriveNode } from '@hushos/drive/client';
import { describe, expect, it, vi } from 'vitest';

/*
 * The first read of a small archive: closing the viewer while it is read whole stops the read
 * there, the reader closed and no later chunk asked for, and nothing is remembered; closing it
 * while the padding after the file is fetched lets that fetch finish first.
 */

const reads: number[] = [];
let closed = 0;
let release: () => void = () => {};
let drained: () => void = () => {};
let draining = false;
let size = 12 << 20;

vi.mock('@/lib/previews', () => ({
    PREVIEW_LIMITS: { document: 16 * 1024 * 1024 },
    recallPreview: () => null,
    rememberPreview: vi.fn(),
    forgetPreviewsWhere: vi.fn(),
    // The real readAll: one 8 MiB chunk at a time, then the padding after the file.
    readAll: async (reader: {
        size: number;
        read: (o: number, l: number) => Promise<Uint8Array>;
        drain?: () => Promise<void>;
    }) => {
        const out = new Uint8Array(reader.size);
        for (let at = 0; at < reader.size; at += 8 << 20)
            out.set(await reader.read(at, Math.min(8 << 20, reader.size - at)), at);
        await reader.drain?.();
        return { bytes: out, truncated: false };
    },
}));
// The download engine's tool reader: its padding is fetched to the end as ciphertext whether or not
// it is closed; a drain on a closed reader returns at once, holding nothing.
vi.mock('@/lib/downloads', () => ({
    downloads: {
        openReader: () => {
            let isClosed = false;
            return {
                size,
                read: async (offset: number, length: number) => {
                    if (isClosed) throw new Error('The preview was closed.');
                    reads.push(offset);
                    await new Promise<void>((resolve) => (release = resolve));
                    return new Uint8Array(length);
                },
                drain: async () => {
                    if (isClosed) return;
                    draining = true;
                    await new Promise<void>((resolve) => (drained = resolve));
                    draining = false;
                },
                close: async () => {
                    isClosed = true;
                    closed++;
                    // A drain waiting on the padding is let go of: the padding goes on without the reader.
                    drained();
                },
            };
        },
    },
}));

describe('reading a small archive whole', () => {
    it('stops when the viewer closes: the reader closed, no further chunk read, nothing remembered', async () => {
        const { archiveReader } = await import('./open');
        const { rememberPreview } = await import('@/lib/previews');
        const node = {
            id: 'n',
            kind: 'file',
            name: 'a.zip',
            content: { plaintextSize: 12 << 20 },
            metadata: { size: 12 << 20 },
            currentVersion: { id: 'v' },
        } as unknown as DriveNode;
        const leaving = new AbortController();
        const reading = archiveReader(node, leaving.signal);
        await vi.waitFor(() => expect(reads).toEqual([0]));
        leaving.abort();
        expect(closed).toBe(1);
        release();
        await expect(reading).rejects.toThrow();
        // The second 8 MiB chunk was never asked for, and the bytes read so far were let go.
        expect(reads).toEqual([0]);
        expect(rememberPreview).not.toHaveBeenCalled();
    });

    it('lets go of the plaintext at once when the viewer closes while the padding is fetched', async () => {
        const { archiveReader } = await import('./open');
        reads.length = 0;
        closed = 0;
        size = 4 << 20;
        const node = {
            id: 'n',
            kind: 'file',
            name: 'a.zip',
            content: { plaintextSize: 4 << 20 },
            metadata: { size: 4 << 20 },
            currentVersion: { id: 'w' },
        } as unknown as DriveNode;
        const leaving = new AbortController();
        const reading = archiveReader(node, leaving.signal);
        await vi.waitFor(() => expect(reads).toEqual([0]));
        release();
        await vi.waitFor(() => expect(draining).toBe(true));
        // Closed while the padding is fetched (offline, it may take long): the reader closes now, its
        // plaintext and key gone, and the read ends without waiting for the padding.
        leaving.abort();
        expect(closed).toBe(1);
        await expect(reading).rejects.toThrow();
    });
});
