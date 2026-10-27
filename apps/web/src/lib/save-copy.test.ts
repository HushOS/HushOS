import type { DriveNode } from '@hushos/drive/client';
import { SignedOutError } from '@hushos/drive/transfers';
import type { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';

/*
 * Saving a copy reads one account's bytes, then waits (the thumbnail, the seal) before it
 * stashes and queues them. If that account signs out meanwhile and someone signs in, the
 * bytes must never be sealed for the new account, nor left on disk, nor queued. The copy, the
 * stash and the device session here are the app's own; only what lies around them (the
 * worker's sealing, the private file system, the queue) is stood in for.
 */
const MAYA = 'maya-user-id';
const SAM = 'sam-user-id';

const world = vi.hoisted(() => ({
    sealedFor: [] as string[],
    holdThumbnail: null as Promise<void> | null,
    holdSeal: null as Promise<void> | null,
    reachedThumbnail: false,
    reachedSeal: false,
}));
type Store = StoreApi<{ unlockedUserId: string | null }>;
const auth = vi.hoisted(() => ({ store: undefined as unknown as Store }));
vi.mock('@/lib/auth-client', async () => {
    const zustand = await import('zustand/vanilla');
    auth.store = zustand.createStore(() => ({ unlockedUserId: null as string | null }));
    return {
        authClient: {
            store: auth.store,
            rpc: async (operation: string, input: { userId: string; bytes: Uint8Array }) => {
                if (operation !== 'driveStashSeal') throw new Error(`unexpected ${operation}`);
                world.reachedSeal = true;
                await world.holdSeal;
                world.sealedFor.push(input.userId);
                return { parts: [new Uint8Array([1, 2, 3, 4])] };
            },
        },
    };
});
const enqueue = vi.hoisted(() =>
    vi.fn((_inputs: { stash?: string }[], _from?: unknown) => ['upload-1']),
);
vi.mock('@/lib/transfers', () => ({ transfers: { enqueue } }));
vi.mock('@/lib/drive', () => ({
    driveClient: {},
    folderQueryOptions: () => ({}),
    invalidateFolders: async () => {},
    nextName: (name: string) => name,
}));
vi.mock('@/lib/previews', () => ({
    openReader: () => ({ close: async () => {} }),
    readAll: async () => ({ bytes: new TextEncoder().encode('MAYA-PAYROLL'), truncated: false }),
}));
vi.mock('@/lib/thumbnails', () => ({
    thumbnailBytes: async () => {
        world.reachedThumbnail = true;
        await world.holdThumbnail;
        return null;
    },
}));

/* The private file system, in memory. */
function privateFileSystem() {
    const directories = new Map<string, Map<string, Uint8Array>>();
    const files = new Map<string, Uint8Array>();
    const missing = () => new DOMException('Not found', 'NotFoundError');
    const handles = (store: Map<string, Uint8Array>) => ({
        async getFileHandle(name: string, options?: { create?: boolean }) {
            if (!store.has(name)) {
                if (!options?.create) throw missing();
                store.set(name, new Uint8Array(0));
            }
            return {
                async createWritable() {
                    const parts: Uint8Array[] = [];
                    return {
                        write: async (part: Uint8Array | string) =>
                            void parts.push(
                                typeof part === 'string' ? new TextEncoder().encode(part) : part,
                            ),
                        close: async () =>
                            void store.set(
                                name,
                                new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer()),
                            ),
                        abort: async () => {},
                    };
                },
                async getFile() {
                    return new File([store.get(name)! as BlobPart], name);
                },
            };
        },
        async removeEntry(name: string) {
            if (!store.delete(name)) throw missing();
        },
        async *keys() {
            yield* store.keys();
        },
    });
    const root = {
        ...handles(files),
        async getDirectoryHandle(name: string, options?: { create?: boolean }) {
            if (!directories.has(name)) {
                if (!options?.create) throw missing();
                directories.set(name, new Map());
            }
            return handles(directories.get(name)!);
        },
        async removeEntry(name: string) {
            if (!directories.delete(name) && !files.delete(name)) throw missing();
        },
    };
    return {
        root,
        stashes: () => [...(directories.get('upload-stash-sealed')?.keys() ?? [])],
        revision: () => files.has('upload-stash-revision'),
    };
}

let disk: ReturnType<typeof privateFileSystem>;
beforeEach(() => {
    disk = privateFileSystem();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => disk.root } });
    vi.stubGlobal(
        'FileSystemFileHandle',
        class {
            createWritable() {}
        },
    );
    auth.store.setState({ unlockedUserId: MAYA });
    Object.assign(world, {
        sealedFor: [],
        holdThumbnail: null,
        holdSeal: null,
        reachedThumbnail: false,
        reachedSeal: false,
    });
    enqueue.mockReset();
    enqueue.mockImplementation(() => ['upload-1']);
});
afterEach(() => vi.unstubAllGlobals());

const { saveCopy } = await import('./save-copy');
const { deviceSession } = await import('./device-session');

const queryClient = { fetchQuery: async () => ({ children: [] }) } as unknown as QueryClient;
const file = {
    id: 'f',
    name: 'payroll.xlsx',
    kind: 'file',
    currentVersion: { plaintextSize: 12 },
    metadata: { mime: 'text/plain' },
} as unknown as DriveNode;
const destination = { id: 'root', name: 'My files' } as DriveNode;
const held = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
};
/* Maya signs out of this browser and Sam signs in on it. */
function mayaLeavesSamArrives() {
    deviceSession.signedOut();
    auth.store.setState({ unlockedUserId: null });
    auth.store.setState({ unlockedUserId: SAM });
}

describe('saving a copy across a sign-out', () => {
    test('one read before Maya signed out is never sealed for Sam, kept on disk, or queued', async () => {
        const thumbnail = held();
        world.holdThumbnail = thumbnail.promise;
        const saving = saveCopy(queryClient, [file], destination, 'drive');
        await vi.waitFor(() => expect(world.reachedThumbnail).toBe(true));
        mayaLeavesSamArrives();
        expect(deviceSession.open()).toBe(true);
        thumbnail.release();
        await expect(saving).rejects.toBeInstanceOf(SignedOutError);
        expect(world.sealedFor).toEqual([]);
        expect(disk.stashes()).toEqual([]);
        expect(disk.revision()).toBe(false);
        expect(enqueue).not.toHaveBeenCalled();
    });

    test('one whose seal was under way when Maya signed out leaves nothing on disk', async () => {
        const seal = held();
        world.holdSeal = seal.promise;
        const saving = saveCopy(queryClient, [file], destination, 'drive');
        await vi.waitFor(() => expect(world.reachedSeal).toBe(true));
        mayaLeavesSamArrives();
        seal.release();
        await expect(saving).rejects.toBeInstanceOf(SignedOutError);
        expect(disk.stashes()).toEqual([]);
        expect(disk.revision()).toBe(false);
        expect(enqueue).not.toHaveBeenCalled();
    });

    test('one the queue refuses has its stash deleted', async () => {
        enqueue.mockImplementation(() => {
            throw new SignedOutError();
        });
        await expect(saveCopy(queryClient, [file], destination, 'drive')).rejects.toBeInstanceOf(
            SignedOutError,
        );
        expect(world.sealedFor).toEqual([MAYA]);
        expect(disk.stashes()).toEqual([]);
    });

    test('in one session it is sealed for that account, kept, and queued with its stash', async () => {
        await saveCopy(queryClient, [file], destination, 'drive');
        expect(world.sealedFor).toEqual([MAYA]);
        const [stash] = disk.stashes();
        expect(stash).toBeTruthy();
        expect(enqueue.mock.calls[0]![0][0]!.stash).toBe(stash);
    });
});
