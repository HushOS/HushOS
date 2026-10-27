import type { DriveNode } from '@hushos/drive/client';
import type { QueryClient } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';

/*
 * Saving a copy reads the whole file before it queues it. The session generation it hands
 * the queue is the one from when it began, so a sign-out during the read refuses the copy
 * (lib/device-session.ts) instead of queueing it into the next session.
 */
const state = vi.hoisted(() => ({ generation: 0, reading: false, release: () => {} }));
const enqueue = vi.hoisted(() => vi.fn((_inputs: unknown[], _from?: unknown) => ['upload-1']));
vi.mock('@/lib/device-session', () => ({
    deviceSession: { generation: () => state.generation },
}));
vi.mock('@/lib/drive', () => ({
    driveClient: {},
    folderQueryOptions: () => ({}),
    invalidateFolders: async () => {},
    nextName: (name: string) => name,
}));
vi.mock('@/lib/previews', () => ({
    openReader: () => ({ close: async () => {} }),
    // Held until released: the read a sign-out lands in the middle of.
    readAll: () =>
        new Promise((resolve) => {
            state.reading = true;
            state.release = () => resolve({ bytes: new Uint8Array(4), truncated: false });
        }),
}));
vi.mock('@/lib/stash', () => ({ stashBytes: async () => 'stash-1' }));
vi.mock('@/lib/thumbnails', () => ({ thumbnailBytes: async () => null }));
vi.mock('@/lib/transfers', () => ({ transfers: { enqueue } }));

const { saveCopy } = await import('./save-copy');

describe('saving a copy', () => {
    test('queues with the session it began in, whatever happened while it read', async () => {
        const queryClient = {
            fetchQuery: async () => ({ children: [] }),
        } as unknown as QueryClient;
        const file = {
            id: 'f',
            name: 'payroll.xlsx',
            kind: 'file',
            currentVersion: { plaintextSize: 4 },
            metadata: { mime: 'text/plain' },
        } as unknown as DriveNode;
        const saving = saveCopy(
            queryClient,
            [file],
            { id: 'root', name: 'My files' } as DriveNode,
            'drive',
        );
        await vi.waitFor(() => expect(state.reading).toBe(true));
        // Signed out (and in again) while the bytes were read.
        state.generation = 1;
        state.release();
        await saving;
        expect(enqueue).toHaveBeenCalledOnce();
        expect(enqueue.mock.calls[0]![1]).toEqual({ generation: 0 });
    });
});
