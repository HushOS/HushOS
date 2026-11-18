import {
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
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createIndexedDbRunJournal, type RunJournal, type RunRow } from './journal';
import { freeLock, runLocks } from './save-runs.locks.harness';
import {
    cleanUpInterrupted,
    interruptedRuns,
    keepInterrupted,
    quietlySettled,
    type SaveRunDeps,
} from './save-runs';

/*
 * Two tabs on one browser's journal: two IndexedDB connections to the same database. The quiet
 * look of one and the other's Keep interleave; the row the person kept never comes back.
 */
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
    vi.stubGlobal('indexedDB', new IDBFactory());
});
afterEach(() => vi.unstubAllGlobals());

const answered: RunRow = {
    id: 'answered',
    account: 'me',
    workspaceId: 'ws',
    nodeIds: ['slow'],
    uploadIds: [],
    at: 1,
    uncertain: [{ id: 'slow', at: 1 }],
    chosen: 'delete',
};

/*
 * Tab A's journal, with tab B's act armed by A's look: it runs on A's next journal access, right
 * after a read (between a read and the write that would follow it) or right before an update.
 */
function interleaved(tabA: RunJournal, act: () => Promise<void>) {
    let armed = false;
    const view: RunJournal = {
        ...tabA,
        async list() {
            const rows = await tabA.list();
            if (armed) {
                armed = false;
                await act();
            }
            return rows;
        },
        async update(id, change) {
            if (armed) {
                armed = false;
                await act();
            }
            return tabA.update!(id, change);
        },
    };
    return { view, arm: () => void (armed = true) };
}

test('another tab’s Keep between this tab’s look and its write is never undone', async () => {
    const tabA = createIndexedDbRunJournal('runs-two-tabs');
    const tabB = createIndexedDbRunJournal('runs-two-tabs');
    await tabA.put(answered);
    // Tab A's quiet look finds the folder (filled since) and would offer the row again; tab B's
    // Keep lands between A's look and its write.
    const { view, arm } = interleaved(tabA, async () => {
        // Tab B: its own turn (the lock a browser shares between tabs is what keeps them apart).
        await keepInterrupted(
            {
                current: () => true,
                account: 'me',
                runs: tabB,
                abortUpload: async () => 'aborted',
                exclusive: (_id, work) => work(),
            },
            answered,
        );
    });
    await interruptedRuns({
        exclusive: freeLock,
        current: () => true,
        account: 'me',
        runs: view,
        isLive: async () => false,
        lookFolder: async () => {
            arm();
            return 2;
        },
    });
    await quietlySettled();
    // Kept: only the done mark is left in both tabs' journal, never offered, dropped at the next open.
    expect(await tabA.list()).toEqual([{ ...answered, chosen: 'keep', done: true }]);
    expect(
        await interruptedRuns({
            exclusive: freeLock,
            current: () => true,
            account: 'me',
            runs: tabB,
            isLive: async () => false,
        }),
    ).toEqual([]);
    expect(await tabA.list()).toEqual([]);
});

test('a row changed by another tab is left as that tab wrote it', async () => {
    const tabA = createIndexedDbRunJournal('runs-changed');
    const tabB = createIndexedDbRunJournal('runs-changed');
    await tabA.put(answered);
    const { chosen: _answer, ...offered } = answered;
    // Tab B's own look got there first and offered it again with what it holds.
    const { view, arm } = interleaved(tabA, () => tabB.put({ ...offered, holds: 5 }));
    await interruptedRuns({
        exclusive: freeLock,
        current: () => true,
        account: 'me',
        runs: view,
        isLive: async () => false,
        lookFolder: async () => {
            arm();
            return 2;
        },
    });
    await quietlySettled();
    expect(await tabA.list()).toEqual([{ ...offered, holds: 5 }]);
});

/* A tab's Delete and Keep on one journal handle, with what it sends to the server. */
function recoveryTab(runs: RunJournal, exclusive: SaveRunDeps['exclusive'], sent: string[]) {
    let gate: Promise<void> = Promise.resolve();
    const deps = {
        runs,
        current: () => true,
        account: 'me',
        exclusive,
        trash: async (_ws: string, ids: string[]) => {
            sent.push(`trash ${ids.join(',')}`);
            await gate;
            return new Map(ids.map((id) => [id, 'done' as const]));
        },
        purge: async (_ws: string, ids: string[]) => {
            sent.push(`purge ${ids.join(',')}`);
            return new Map(ids.map((id) => [id, 'done' as const]));
        },
        mayPurge: async () => true,
        abortUpload: async (_ws: string, id: string) => {
            sent.push(`abort ${id}`);
            return 'aborted' as const;
        },
    } as unknown as SaveRunDeps;
    return { deps, hold: (until: Promise<void>) => void (gate = until) };
}

const offered: RunRow = {
    id: 'offered',
    account: 'me',
    workspaceId: 'ws',
    nodeIds: ['made'],
    uploadIds: ['up'],
    at: 1,
};

test('Delete from a snapshot read before another tab’s Keep sends nothing and says it was kept', async () => {
    const locks = runLocks().exclusive;
    const sent: string[] = [];
    const tabA = recoveryTab(createIndexedDbRunJournal('runs-keep-then-delete'), locks, sent);
    const tabB = recoveryTab(createIndexedDbRunJournal('runs-keep-then-delete'), locks, sent);
    await tabA.deps.runs.put(offered);
    // Both tabs offered the row; the person answered Keep in tab A first.
    const [snapshotB] = await interruptedRuns({
        exclusive: freeLock,
        current: () => true,
        account: 'me',
        runs: tabB.deps.runs,
        isLive: async () => false,
    });
    expect(await keepInterrupted(tabA.deps, offered)).toBe('kept');
    expect(sent).toEqual(['abort up']);
    // Tab B's Delete, from its older snapshot: no trash, no purge.
    expect(await cleanUpInterrupted(tabB.deps, snapshotB!)).toBe('kept');
    expect(sent).toEqual(['abort up']);
});

test('Keep while another tab’s Delete is under way is refused at once (busy), and never says kept of what went', async () => {
    const locks = runLocks().exclusive;
    const sent: string[] = [];
    const tabA = recoveryTab(createIndexedDbRunJournal('runs-delete-then-keep'), locks, sent);
    const tabB = recoveryTab(createIndexedDbRunJournal('runs-delete-then-keep'), locks, sent);
    await tabA.deps.runs.put({ ...offered, uploadIds: [] });
    let release!: () => void;
    tabB.hold(new Promise<void>((resolve) => (release = resolve)));
    const deleting = cleanUpInterrupted(tabB.deps, { ...offered, uploadIds: [] });
    await vi.waitFor(() => expect(sent).toEqual(['trash made']));
    // Keep asked in tab A while B's trash request is on its way: B holds the run's lock, so nothing is
    // kept or written, and the person is told to try again.
    expect(await keepInterrupted(tabA.deps, { ...offered, uploadIds: [] })).toBe('busy');
    expect((await tabA.deps.runs.list())[0]?.chosen).toBeUndefined();
    release();
    expect(await deleting).toBe('deleted');
    // Asked again: gone, never kept.
    expect(await keepInterrupted(tabA.deps, { ...offered, uploadIds: [] })).toBe('gone');
    expect(await tabA.deps.runs.list()).toEqual([]);
});

test('a run whose lock a tab still holds (frozen, or live) is never offered, deleted or kept from under it', async () => {
    const locks = runLocks();
    const sent: string[] = [];
    const tabA = recoveryTab(
        createIndexedDbRunJournal('runs-frozen-writer'),
        locks.exclusive,
        sent,
    );
    await tabA.deps.runs.put(offered);
    // The writing tab, frozen with the run's lock held.
    const release = await locks.hold(offered.id);
    expect(
        await interruptedRuns({
            current: () => true,
            account: 'me',
            runs: tabA.deps.runs,
            isLive: locks.isLive,
            exclusive: locks.exclusive,
        }),
    ).toEqual([]);
    expect(await cleanUpInterrupted(tabA.deps, offered)).toBe('busy');
    expect(await keepInterrupted(tabA.deps, offered)).toBe('busy');
    expect(sent).toEqual([]);
    expect(await tabA.deps.runs.list()).toEqual([offered]);
    // Its tab gone (the lock released): offered, and a Delete then removes it.
    release();
    const [found] = await interruptedRuns({
        current: () => true,
        account: 'me',
        runs: tabA.deps.runs,
        isLive: locks.isLive,
        exclusive: locks.exclusive,
    });
    expect(found).toEqual(offered);
    expect(await cleanUpInterrupted(tabA.deps, found!)).toBe('deleted');
});
