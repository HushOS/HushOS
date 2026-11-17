// @vitest-environment node
import type { DriveNode } from '@hushos/drive/client';
import { describe, expect, it, vi } from 'vitest';

/*
 * The first read of a small archive: closing the viewer while it is read whole stops the read
 * there, the reader closed and no later chunk asked for, and nothing is remembered.
 */

const reads: number[] = [];
let closed = 0;
let release: () => void = () => {};

vi.mock('@/lib/previews', () => ({
    PREVIEW_LIMITS: { document: 16 * 1024 * 1024 },
    recallPreview: () => null,
    rememberPreview: vi.fn(),
    // The real readAll: one 8 MiB chunk at a time.
    readAll: async (reader: {
        size: number;
        read: (o: number, l: number) => Promise<Uint8Array>;
    }) => {
        const out = new Uint8Array(reader.size);
        for (let at = 0; at < reader.size; at += 8 << 20)
            out.set(await reader.read(at, Math.min(8 << 20, reader.size - at)), at);
        return { bytes: out, truncated: false };
    },
    openReader: () => {
        let isClosed = false;
        return {
            size: 12 << 20,
            read: async (offset: number, length: number) => {
                if (isClosed) throw new Error('The preview was closed.');
                reads.push(offset);
                await new Promise<void>((resolve) => (release = resolve));
                return new Uint8Array(length);
            },
            close: async () => {
                isClosed = true;
                closed++;
            },
        };
    },
}));
vi.mock('@/lib/downloads', () => ({ downloads: {} }));

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
});
