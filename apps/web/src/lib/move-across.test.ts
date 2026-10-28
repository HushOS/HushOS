import type { DriveNode } from '@hushos/drive/client';
import type { QueryClient } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';

/*
 * A move between one's own files and a family folder makes everything again
 * under the destination's keys: folders made, files queued as uploads. What it
 * makes must carry each source's attributes (a folder's colour, and keys a
 * newer client added), or the move quietly drops them. The move is the app's
 * own; the drive clients, the reader and the queue around it are stood in for.
 */

const world = vi.hoisted(() => ({
    made: [] as { name: string; attributes: unknown }[],
    queued: [] as { name?: string; attributes?: unknown }[],
}));

const folderAttributes = { colour: 'blue', 'zz-unknown': 'from a newer client' };
const fileAttributes = { 'zz-unknown': 'kept' };
const file = {
    id: 'source-file',
    workspaceId: 'mine',
    name: 'payroll.xlsx',
    kind: 'file',
    currentVersion: { id: 'v1', plaintextSize: '12' },
    content: { plaintextSize: 12, thumbnailBytes: 0 },
    metadata: { name: 'payroll.xlsx', mime: 'text/plain', attributes: fileAttributes },
} as unknown as DriveNode;
const folder = {
    id: 'source-folder',
    workspaceId: 'mine',
    name: 'Plans',
    kind: 'folder',
    metadata: { name: 'Plans', attributes: folderAttributes },
} as unknown as DriveNode;

vi.mock('@/lib/drive', () => ({
    clientFor: () => ({
        listFolder: async (id: string) => ({ children: id === 'source-folder' ? [file] : [] }),
        createFolderPath: async (
            _parent: DriveNode,
            [name]: string[],
            options: { attributes?: unknown },
        ) => {
            world.made.push({ name: name!, attributes: options.attributes });
            return [{ id: `made-${name}`, name, workspaceId: 'family' } as DriveNode];
        },
    }),
    driveOpenQueryOptions: () => ({}),
    folderQueryOptions: () => ({}),
    invalidateFolders: async () => {},
    nextName: (name: string) => name,
}));
vi.mock('@/lib/save-copy', () => ({
    SAVE_COPY_MAX_BYTES: 256 * 1024 * 1024,
    copyStart: () => ({ generation: 1, account: 'maya' }),
    queueCopy: async (_start: unknown, _bytes: Uint8Array, input: { name?: string }) => {
        world.queued.push(input);
        return `upload-${world.queued.length}`;
    },
}));
vi.mock('@/lib/previews', () => ({
    openReader: () => ({ close: async () => {} }),
    readAll: async () => ({ bytes: new Uint8Array(12), truncated: false }),
}));
vi.mock('@/lib/thumbnails', () => ({ thumbnailBytes: async () => null }));
vi.mock('@/lib/transfers', () => ({ onTransferEvent: () => () => {} }));
vi.mock('@/lib/drive-api', () => ({ driveApi: {} }));
vi.mock('@/lib/families', () => ({ familiesSyncQueryOptions: () => ({}) }));
vi.mock('@/lib/families-shell', () => ({
    activeFamily: () => null,
    familiesQueryOptions: () => ({}),
}));
vi.mock('@/lib/spaces', () => ({ openArea: async () => ({}) }));

const { moveAcross } = await import('./move-across');
const queryClient = { fetchQuery: async () => ({ children: [] }) } as unknown as QueryClient;
const destination = { id: 'family-root', name: 'Family', workspaceId: 'family' } as DriveNode;

describe('a move across spaces', () => {
    test('every folder made and every file queued carries its own source’s attributes', async () => {
        await moveAcross(queryClient, [folder], destination);
        expect(world.made).toEqual([{ name: 'Plans', attributes: folderAttributes }]);
        expect(world.queued).toHaveLength(1);
        expect(world.queued[0]).toMatchObject({ name: 'payroll.xlsx', attributes: fileAttributes });
    });
});
