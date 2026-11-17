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
import { interruptedRuns, keepInterrupted, quietlySettled } from './save-runs';

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
        await keepInterrupted({ runs: tabB, abortUpload: async () => 'aborted' }, answered);
    });
    await interruptedRuns({
        runs: view,
        isLive: async () => false,
        lookFolder: async () => {
            arm();
            return 2;
        },
    });
    await quietlySettled();
    expect(await tabB.list()).toEqual([]);
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
