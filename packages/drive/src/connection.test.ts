import {
    forceCloseDatabase,
    IDBCursor,
    IDBCursorWithValue,
    IDBDatabase,
    IDBFactory,
    IDBIndex,
    IDBKeyRange,
    IDBObjectStore,
    IDBOpenDBRequest,
    IDBRequest,
    IDBTransaction,
    IDBVersionChangeEvent,
} from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIndexedDbJournal, type JournalEntry } from './journal';
import { createIndexedDbMirror } from './mirror';

/*
 * The upload journal and the tree mirror each keep one IndexedDB connection. It has to let go
 * when another tab deletes the database (sign-out there, a family wiped), and be replaced when
 * the browser closes it on its own or an open fails; otherwise every later call fails on a dead
 * connection until the page reloads, or the other tab's deletion waits forever.
 */

/* Every connection opened, as the browser hands it over. */
let opened: IDBDatabase[] = [];
let factory: IDBFactory;

beforeEach(() => {
    const globals = {
        IDBCursor,
        IDBCursorWithValue,
        IDBDatabase,
        IDBIndex,
        IDBKeyRange,
        IDBObjectStore,
        IDBOpenDBRequest,
        IDBRequest,
        IDBTransaction,
        IDBVersionChangeEvent,
    };
    for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
    factory = new IDBFactory();
    opened = [];
    const open = factory.open.bind(factory);
    factory.open = (name: string, version?: number) => {
        const request = open(name, version);
        request.addEventListener('success', () => opened.push(request.result));
        return request;
    };
    vi.stubGlobal('indexedDB', factory);
});
afterEach(() => vi.unstubAllGlobals());

/* Another tab deleting the database: 'deleted', or 'blocked' when a connection held on past 1 s. */
function deleteFromAnotherTab(name: string) {
    return new Promise<'deleted' | 'blocked'>((resolve, reject) => {
        const request = factory.deleteDatabase(name);
        const timer = setTimeout(() => resolve('blocked'), 1_000);
        request.onsuccess = () => {
            clearTimeout(timer);
            resolve('deleted');
        };
        request.onerror = () => reject(request.error);
    });
}

/* A newer version of the database already on disk: opening the older one fails with VersionError. */
function openNewer(name: string, version: number) {
    return new Promise<void>((resolve, reject) => {
        const request = factory.open(name, version);
        request.onsuccess = () => {
            request.result.close();
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
}

const entry = (id: string) =>
    ({ id, workspaceId: 'ws-1', updatedAt: 1 }) as unknown as JournalEntry;

describe('the upload journal', () => {
    it('lets another tab delete its database, then opens a new one on the next call', async () => {
        const name = `journal-${Math.random()}`;
        const journal = createIndexedDbJournal(name);
        await journal.put(entry('a'));

        expect(await deleteFromAnotherTab(name)).toBe('deleted');
        // The deletion took the entry; the journal works on the database it opens again.
        expect(await journal.listAll()).toEqual([]);
        await journal.put(entry('b'));
        expect((await journal.listAll()).map((row) => row.id)).toEqual(['b']);
    });

    it('opens a new connection after the browser closed its connection', async () => {
        const journal = createIndexedDbJournal(`journal-${Math.random()}`);
        await journal.put(entry('a'));
        forceCloseDatabase(opened.at(-1)! as never);

        await journal.put(entry('b'));
        expect((await journal.listAll()).map((row) => row.id).sort()).toEqual(['a', 'b']);
        expect(opened).toHaveLength(2);
    });

    it('tries the open again on the next call after one failed', async () => {
        const name = `journal-${Math.random()}`;
        await openNewer(name, 3);
        const journal = createIndexedDbJournal(name);
        await expect(journal.listAll()).rejects.toMatchObject({ name: 'VersionError' });

        expect(await deleteFromAnotherTab(name)).toBe('deleted');
        expect(await journal.listAll()).toEqual([]);
    });
});

describe('the tree mirror', () => {
    it('lets another tab delete its database, then opens a new one on the next read', async () => {
        const name = `mirror-${Math.random()}`;
        const mirror = createIndexedDbMirror(name);
        await mirror.apply('ws-1', [], 7);

        expect(await deleteFromAnotherTab(name)).toBe('deleted');
        expect(await mirror.cursor('ws-1')).toBe(0);
        await mirror.apply('ws-1', [], 9);
        expect(await mirror.cursor('ws-1')).toBe(9);
    });

    it('opens a new connection after the browser closed its connection', async () => {
        const mirror = createIndexedDbMirror(`mirror-${Math.random()}`);
        await mirror.apply('ws-1', [], 7);
        forceCloseDatabase(opened.at(-1)! as never);

        expect(await mirror.cursor('ws-1')).toBe(7);
        await mirror.apply('ws-1', [], 9);
        expect(await mirror.workspaces()).toEqual(['ws-1']);
        expect(opened).toHaveLength(2);
    });

    it('tries the open again on the next read after one failed', async () => {
        const name = `mirror-${Math.random()}`;
        await openNewer(name, 2);
        const mirror = createIndexedDbMirror(name);
        await expect(mirror.cursor('ws-1')).rejects.toMatchObject({ name: 'VersionError' });

        expect(await deleteFromAnotherTab(name)).toBe('deleted');
        expect(await mirror.cursor('ws-1')).toBe(0);
    });
});
