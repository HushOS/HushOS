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
    workspaceId: 'ws',
    nodeIds: ['slow'],
    uploadIds: [],
    at: 1,
    beat: 1,
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
                runs: tabB,
                abortUpload: async () => 'aborted',
                exclusive: (_id, work) => work(),
            },
            answered,
        );
    });
    await interruptedRuns({
        current: () => true,
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
        await interruptedRuns({ current: () => true, runs: tabB, isLive: async () => false }),
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
        current: () => true,
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

/* One Web Lock per name shared by the tabs, as navigator.locks is: each holder in turn. */
function sharedLocks() {
    const tails = new Map<string, Promise<unknown>>();
    return <T>(runId: string, work: () => Promise<T>) => {
        const turn = (tails.get(runId) ?? Promise.resolve()).then(work);
        tails.set(
            runId,
            turn.catch(() => {}),
        );
        return turn;
    };
}

/* A tab's Delete and Keep on one journal handle, with what it sends to the server. */
function recoveryTab(runs: RunJournal, exclusive: ReturnType<typeof sharedLocks>, sent: string[]) {
    let gate: Promise<void> = Promise.resolve();
    const deps = {
        runs,
        current: () => true,
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
    workspaceId: 'ws',
    nodeIds: ['made'],
    uploadIds: ['up'],
    at: 1,
    beat: 1,
};

test('Delete from a snapshot read before another tab’s Keep sends nothing and says it was kept', async () => {
    const locks = sharedLocks();
    const sent: string[] = [];
    const tabA = recoveryTab(createIndexedDbRunJournal('runs-keep-then-delete'), locks, sent);
    const tabB = recoveryTab(createIndexedDbRunJournal('runs-keep-then-delete'), locks, sent);
    await tabA.deps.runs.put(offered);
    // Both tabs offered the row; the person answered Keep in tab A first.
    const [snapshotB] = await interruptedRuns({
        current: () => true,
        runs: tabB.deps.runs,
        isLive: async () => false,
    });
    expect(await keepInterrupted(tabA.deps, offered)).toBe('kept');
    expect(sent).toEqual(['abort up']);
    // Tab B's Delete, from its older snapshot: no trash, no purge.
    expect(await cleanUpInterrupted(tabB.deps, snapshotB!)).toBe('kept');
    expect(sent).toEqual(['abort up']);
});

test('Keep while another tab’s Delete is under way waits for it, and never says kept of what went', async () => {
    const locks = sharedLocks();
    const sent: string[] = [];
    const tabA = recoveryTab(createIndexedDbRunJournal('runs-delete-then-keep'), locks, sent);
    const tabB = recoveryTab(createIndexedDbRunJournal('runs-delete-then-keep'), locks, sent);
    await tabA.deps.runs.put({ ...offered, uploadIds: [] });
    let release!: () => void;
    tabB.hold(new Promise<void>((resolve) => (release = resolve)));
    const deleting = cleanUpInterrupted(tabB.deps, { ...offered, uploadIds: [] });
    await vi.waitFor(() => expect(sent).toEqual(['trash made']));
    // Keep asked in tab A while B's trash request is on its way: it waits for B's lock.
    const keeping = keepInterrupted(tabA.deps, { ...offered, uploadIds: [] });
    release();
    expect(await deleting).toBe('deleted');
    expect(await keeping).toBe('gone');
    expect(await tabA.deps.runs.list()).toEqual([]);
});
