import {
    DriveApiError,
    type PurgeBatchItem,
    type RestoreBatchItem,
    type TrashBatchItem,
} from '@hushos/drive/api';
import type { DriveNode } from '@hushos/drive/client';
import { MAX_TRASH_BATCH } from '@hushos/drive/protocol';
import { describe, expect, test } from 'vitest';
import {
    PURGE_RETRY_MS,
    purgeBatch,
    restoreBatch,
    trashBatch,
    type TrashParts,
} from '@/lib/trash-batch';

/*
 * A selection to the trash and back, against a server kept in memory that
 * answers the batch routes as the real one does: per item, in the order sent;
 * an item already in the trash, itself or through a folder it is in, is
 * refused; one inside a folder of the same request that goes is covered by it;
 * a refused item stays where it was.
 */

const ROOT = 'root';
const many = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${prefix}${i}`);
const tree: Record<string, string> = {
    // id: parent
    F: ROOT,
    c: 'F',
    g: 'c',
    a: ROOT,
    b: ROOT,
    x: ROOT,
    ...Object.fromEntries(many('f', 10).map((id) => [id, ROOT])),
    ...Object.fromEntries(many('n', 2 * MAX_TRASH_BATCH + 101).map((id) => [id, ROOT])),
};
const node = (id: string, workspaceId = 'ws') =>
    ({ id, parentId: tree[id], workspaceId, name: id, kind: 'file' }) as DriveNode;

function server({
    refuseTrash = [] as string[],
    refuseRestore = [] as string[],
    refusePurge = [] as string[],
    /* The most one delete request purges before it answers the rest `busy`. */
    purgeBudget = Infinity,
    /* Ids this device does not know the folders of (opened from search, say). */
    unknownFolders = [] as string[],
    /* The requests, counted from 0, that fail as a whole. */
    failRequests = [] as number[],
    /* The HTTP status they fail with, as the API client throws it; none: a network error. */
    failStatus = 0,
    /* Ids the server leaves out of its answer. */
    leaveOut = [] as string[],
} = {}) {
    const trashed = new Set<string>();
    const purged = new Set<string>();
    const sent = {
        trash: [] as { ws: string; ids: string[] }[],
        restore: [] as string[][],
        purge: [] as string[][],
    };
    let requests = 0;
    let changeSeq = 100;
    const paused: number[] = [];
    const chain = (id: string) => {
        const up: string[] = [];
        for (let at = tree[id]; at && at !== ROOT; at = tree[at]) up.push(at);
        return up;
    };
    const inTrash = (id: string) => trashed.has(id) || chain(id).some((up) => trashed.has(up));
    const request = async () => {
        const index = requests++;
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (failRequests.includes(index))
            throw failStatus
                ? new DriveApiError(`request ${index} failed`, 'conflict', failStatus)
                : new Error(`request ${index} failed`);
    };
    const parts: TrashParts = {
        trash: async (ws, ids) => {
            sent.trash.push({ ws, ids });
            await request();
            const passed = new Set(ids.filter((id) => !refuseTrash.includes(id) && !inTrash(id)));
            const results = ids.map((id): TrashBatchItem => {
                if (refuseTrash.includes(id))
                    return { id, status: 'refused', reason: 'forbidden', message: `refused ${id}` };
                if (inTrash(id))
                    return {
                        id,
                        status: 'refused',
                        reason: 'trashed',
                        message: `${id} is in the trash`,
                    };
                const by = chain(id)
                    .reverse()
                    .find((up) => passed.has(up));
                if (by) return { id, status: 'covered', by };
                return { id, status: 'trashed', trashedAt: 'now', changeSeq: ++changeSeq };
            });
            for (const result of results) if (result.status === 'trashed') trashed.add(result.id);
            return { results: results.filter((result) => !leaveOut.includes(result.id)) };
        },
        restore: async (_ws, ids) => {
            sent.restore.push(ids);
            await request();
            return {
                results: ids.map((id): RestoreBatchItem => {
                    if (refuseRestore.includes(id) || !trashed.has(id))
                        return {
                            id,
                            status: 'refused',
                            reason: 'not-trashed',
                            message: `refused ${id}`,
                        };
                    // Its folder is still in the trash: the server does not reparent on its own.
                    if (chain(id).some((up) => trashed.has(up)))
                        return {
                            id,
                            status: 'refused',
                            reason: 'parent-trashed',
                            message: `${id}'s folder is in the trash`,
                        };
                    trashed.delete(id);
                    return { id, status: 'restored', changeSeq: ++changeSeq };
                }),
            };
        },
        purge: async (_ws, ids) => {
            sent.purge.push(ids);
            let spent = 0;
            await request();
            // Gone already, itself or with a folder purged before: as if it never was.
            const gone = (id: string) => purged.has(id) || chain(id).some((up) => purged.has(up));
            const passed = new Set(
                ids.filter(
                    (id, index) =>
                        !refusePurge.includes(id) &&
                        !gone(id) &&
                        trashed.has(id) &&
                        index < purgeBudget,
                ),
            );
            const results = ids.map((id): PurgeBatchItem => {
                if (gone(id))
                    return { id, status: 'refused', reason: 'not-found', message: `no ${id}` };
                if (refusePurge.includes(id))
                    return { id, status: 'refused', reason: 'root', message: `refused ${id}` };
                if (!trashed.has(id))
                    return {
                        id,
                        status: 'refused',
                        reason: 'not-trashed',
                        message: `${id} is not in the trash`,
                    };
                const by = chain(id)
                    .reverse()
                    .find((up) => passed.has(up));
                if (by) return { id, status: 'covered', by };
                if (spent++ >= purgeBudget)
                    return { id, status: 'refused', reason: 'busy', message: 'no time' };
                return { id, status: 'purged', changeSeq: ++changeSeq };
            });
            spent = 0;
            for (const result of results)
                if (result.status === 'purged') {
                    purged.add(result.id);
                    trashed.delete(result.id);
                }
            return { results: results.filter((result) => !leaveOut.includes(result.id)) };
        },
        ancestorsOf: (n) =>
            unknownFolders.includes(n.id) ? [] : chain(n.id).map((id) => ({ id })),
        pause: async (ms) => {
            paused.push(ms);
        },
    };
    /* Whether an item is deleted forever, itself or with a folder it is in. */
    const isPurged = (id: string) => purged.has(id) || chain(id).some((up) => purged.has(up));
    /* Into the trash on their own, each in its own request, as rows of the Trash are. */
    const trashEach = async (ids: string[]) => {
        for (const id of ids) await parts.trash('ws', [id]);
    };
    return { parts, sent, inTrash, isPurged, trashEach, paused };
}
const ids = (nodes: DriveNode[]) => nodes.map((n) => n.id);
const sorted = (list: string[]) => [...list].sort();
/* A node this device holds without knowing its folder. */
const blind = (id: string) => ({ ...node(id), parentId: null }) as DriveNode;

describe('a selection to the trash', () => {
    test('“N of M” counts only what reached the trash, in the order picked', async () => {
        const { parts, inTrash } = server({ refuseTrash: ['b'] });
        const picked = ['a', 'b', 'x'].map((id) => node(id));
        const result = await trashBatch(picked, parts);
        expect(result.gone).toEqual(['a', 'x']);
        expect(ids(result.moved)).toEqual(['a', 'x']);
        expect(result.error).toMatchObject({ message: 'refused b', code: 'forbidden' });
        expect(['a', 'b', 'x'].filter(inTrash)).toEqual(['a', 'x']);
    });

    test('a selection goes in one request, and one refusal leaves none of the rest behind', async () => {
        const files = many('f', 10);
        const { parts, sent, inTrash } = server({ refuseTrash: ['f0'] });
        const told: string[][] = [];
        const result = await trashBatch(
            files.map((id) => node(id)),
            parts,
            (landed) => told.push(landed),
        );
        expect(sent.trash).toEqual([{ ws: 'ws', ids: files }]);
        expect(told).toEqual([files.slice(1)]);
        expect(result.gone).toEqual(files.slice(1));
        expect(files.filter(inTrash)).toEqual(files.slice(1));
    });

    test('what moved carries the server’s trashedAt and change number, and nothing else changes', async () => {
        const { parts } = server();
        const picked = node('a');
        const result = await trashBatch([picked], parts);
        expect(result.moved).toEqual([{ ...picked, trashedAt: 'now', changeSeq: 101 }]);
    });

    test('an item inside a folder that is going is sent once, with its folder, and counted as gone', async () => {
        const { parts, sent, inTrash } = server();
        const told: string[] = [];
        // The child and grandchild listed before their folder; the grandchild's parent is not picked.
        const picked = ['g', 'c', 'F', 'a'].map((id) => node(id));
        const result = await trashBatch(picked, parts, (landed) => told.push(...landed));
        expect(sent.trash.flatMap((request) => request.ids)).toEqual(['F', 'a']);
        expect(result.gone).toEqual(['g', 'c', 'F', 'a']);
        expect(sorted(told)).toEqual(['F', 'a', 'c', 'g']);
        expect(ids(result.moved)).toEqual(['F', 'a']);
        expect(['g', 'c', 'F', 'a'].every(inTrash)).toBe(true);
    });

    test('an item inside a folder that is refused stays where it is and is not counted', async () => {
        const { parts, sent, inTrash } = server({ refuseTrash: ['F'] });
        const told: string[] = [];
        const picked = ['F', 'c', 'a'].map((id) => node(id));
        const result = await trashBatch(picked, parts, (landed) => told.push(...landed));
        expect(sent.trash.flatMap((request) => request.ids)).toEqual(['F', 'a']);
        expect(result.gone).toEqual(['a']);
        expect(told).toEqual(['a']);
        expect(ids(result.moved)).toEqual(['a']);
        expect(['F', 'c'].some(inTrash)).toBe(false);
    });

    test('an item the server says went with its folder is gone, but Undo puts back only the folder', async () => {
        // This device does not know `c` is inside `F`; the server does.
        const { parts, sent, inTrash } = server({ unknownFolders: ['c'] });
        const trashed = await trashBatch([blind('c'), node('F'), node('a')], parts);
        expect(sent.trash[0]!.ids).toEqual(['c', 'F', 'a']);
        expect(trashed.gone).toEqual(['c', 'F', 'a']);
        expect(ids(trashed.moved)).toEqual(['F', 'a']);
        expect(trashed.error).toBeNull();
        const undone = await restoreBatch(trashed.moved, parts);
        expect(sent.restore).toEqual([['F', 'a']]);
        expect(undone.error).toBeNull();
        expect(['c', 'F', 'a'].some(inTrash)).toBe(false);
    });

    test(`over ${MAX_TRASH_BATCH} items go in requests of at most that many; one failing keeps none of the others back`, async () => {
        const all = many('n', 2 * MAX_TRASH_BATCH + 101);
        const { parts, sent, inTrash } = server({ failRequests: [1] });
        const told: number[] = [];
        const result = await trashBatch(
            all.map((id) => node(id)),
            parts,
            (landed) => told.push(landed.length),
        );
        expect(sent.trash.map((request) => request.ids.length)).toEqual([
            MAX_TRASH_BATCH,
            MAX_TRASH_BATCH,
            101,
        ]);
        expect(sent.trash.flatMap((request) => request.ids)).toEqual(all);
        const failed = all.slice(MAX_TRASH_BATCH, 2 * MAX_TRASH_BATCH);
        const went = all.filter((id) => !failed.includes(id));
        expect(told).toEqual([MAX_TRASH_BATCH, 101]);
        expect(result.gone).toEqual(went);
        expect(ids(result.moved)).toEqual(went);
        expect((result.error as Error).message).toBe('request 1 failed');
        expect(all.filter(inTrash)).toEqual(went);
    });

    test('a selection across workspaces goes as one request for each, with only its own items', async () => {
        const { parts, sent } = server();
        const picked = [node('a', 'mine'), node('b', 'family'), node('x', 'mine')];
        const result = await trashBatch(picked, parts);
        expect(sent.trash).toEqual([
            { ws: 'mine', ids: ['a', 'x'] },
            { ws: 'family', ids: ['b'] },
        ]);
        expect(result.gone).toEqual(['a', 'b', 'x']);
        expect(ids(result.moved)).toEqual(['a', 'b', 'x']);
    });

    test('an item the server’s answer leaves out is not counted as moved', async () => {
        const { parts } = server({ leaveOut: ['b'] });
        const result = await trashBatch(
            ['a', 'b'].map((id) => node(id)),
            parts,
        );
        expect(result.gone).toEqual(['a']);
        expect(ids(result.moved)).toEqual(['a']);
        expect(result.error).toMatchObject({ code: 'unavailable' });
    });
});

describe('Undo', () => {
    test('puts back exactly what moved: nothing refused, nothing that went inside a folder', async () => {
        const { parts, sent, inTrash } = server({ refuseTrash: ['b'] });
        const trashed = await trashBatch(
            ['a', 'b', 'F', 'c'].map((id) => node(id)),
            parts,
        );
        const told: string[] = [];
        const undone = await restoreBatch(trashed.moved, parts, (back) => told.push(...ids(back)));
        expect(sent.restore).toEqual([['a', 'F']]);
        expect(ids(undone.back)).toEqual(['a', 'F']);
        expect(told).toEqual(['a', 'F']);
        expect(undone.back.every((n) => n.trashedAt === null)).toBe(true);
        expect(undone.error).toBeNull();
        expect(['a', 'b', 'F', 'c'].some(inTrash)).toBe(false);
    });

    test(`an item and the folder it is in, trashed in different requests, both come back`, async () => {
        // This device did not know `c` is inside `F`, and they went in different requests.
        const fill = many('n', MAX_TRASH_BATCH - 1);
        const { parts, sent, inTrash } = server({ unknownFolders: ['c'] });
        const picked = [blind('c'), ...fill.map((id) => node(id)), node('F')];
        const trashed = await trashBatch(picked, parts);
        expect(sent.trash.map((request) => request.ids.length)).toEqual([MAX_TRASH_BATCH, 1]);
        expect(ids(trashed.moved)).toEqual(['c', ...fill, 'F']);
        const told: string[] = [];
        const undone = await restoreBatch(trashed.moved, parts, (back) => told.push(...ids(back)));
        // `c` was refused while `F` was still in the trash, then tried again once it came back.
        expect(sent.restore.map((request) => request.length)).toEqual([MAX_TRASH_BATCH, 1, 1]);
        expect(sent.restore.at(-1)).toEqual(['c']);
        expect(ids(undone.back)).toEqual(['c', ...fill, 'F']);
        expect(sorted(told)).toEqual(sorted(['c', ...fill, 'F']));
        expect(undone.error).toBeNull();
        expect(['c', ...fill, 'F'].some(inTrash)).toBe(false);
    });

    test('folders this device knows go back before what is in them, whatever the order given', async () => {
        const fill = many('n', MAX_TRASH_BATCH - 1);
        const { parts, sent, inTrash } = server();
        // Each in the trash on its own: the item first, then its folder.
        await parts.trash('ws', ['c']);
        await parts.trash('ws', ['F', ...fill]);
        const given = [node('c'), ...fill.map((id) => node(id)), node('F')];
        const undone = await restoreBatch(given, parts);
        // No request was refused and tried again: the folder went in the first.
        expect(sent.restore.map((request) => request.length)).toEqual([MAX_TRASH_BATCH, 1]);
        expect(sent.restore[1]).toEqual(['c']);
        expect(ids(undone.back)).toEqual(ids(given));
        expect(undone.error).toBeNull();
        expect(['c', 'F', ...fill].some(inTrash)).toBe(false);
    });

    test('an item whose folder stays in the trash is refused once retrying brings nothing back', async () => {
        const { parts, sent, inTrash } = server({ refuseRestore: ['F'] });
        await parts.trash('ws', ['c']);
        await parts.trash('ws', ['F']);
        const undone = await restoreBatch([node('c'), node('F')], parts);
        expect(sent.restore).toEqual([['F', 'c'], ['c']]);
        expect(undone.back).toEqual([]);
        expect(undone.error).toMatchObject({ code: 'parent-trashed' });
        expect(inTrash('c')).toBe(true);
    });

    test('says what came back when some of it cannot', async () => {
        const { parts, inTrash } = server({ refuseRestore: ['F'] });
        const trashed = await trashBatch(
            ['a', 'F', 'x'].map((id) => node(id)),
            parts,
        );
        const told: string[] = [];
        const undone = await restoreBatch(trashed.moved, parts, (back) => told.push(...ids(back)));
        expect(ids(undone.back)).toEqual(['a', 'x']);
        expect(told).toEqual(['a', 'x']);
        expect(undone.error).toMatchObject({ message: 'refused F' });
        expect(['a', 'x'].some(inTrash)).toBe(false);
        expect(inTrash('F')).toBe(true);
    });
});

describe('deleting Trash rows forever', () => {
    test('the rows go in one request, and “N of M” counts only what is gone', async () => {
        const { parts, sent, isPurged, trashEach } = server({ refusePurge: ['b'] });
        await trashEach(['a', 'b', 'x']);
        const told: string[][] = [];
        const result = await purgeBatch(
            ['a', 'b', 'x'].map((id) => node(id)),
            parts,
            (ids) => told.push(ids),
        );
        expect(sent.purge).toEqual([['a', 'b', 'x']]);
        expect(result.gone).toEqual(['a', 'x']);
        expect(told).toEqual([['a', 'x']]);
        expect(result.error).toMatchObject({ message: 'refused b', code: 'invalid' });
        expect(['a', 'b', 'x'].filter(isPurged)).toEqual(['a', 'x']);
    });

    test('a row inside a folder that is going is not sent, and counts as gone with it', async () => {
        // Each in the Trash on its own, the folder last: two rows of the Trash.
        const { parts, sent, isPurged, trashEach } = server();
        await trashEach(['c', 'F']);
        const result = await purgeBatch([node('c'), node('F')], parts);
        expect(sent.purge).toEqual([['F']]);
        expect(result.gone).toEqual(['c', 'F']);
        expect(result.error).toBeNull();
        expect(['c', 'F'].every(isPurged)).toBe(true);
    });

    test('a row inside a refused folder stays, and is not counted', async () => {
        const { parts, isPurged, trashEach } = server({ refusePurge: ['F'] });
        await trashEach(['c', 'F', 'a']);
        const result = await purgeBatch([node('F'), node('c'), node('a')], parts);
        expect(result.gone).toEqual(['a']);
        expect(['F', 'c'].some(isPurged)).toBe(false);
    });

    test('a row the server says goes with its folder counts as gone', async () => {
        // This device does not know `c` is inside `F`; the server does.
        const { parts, sent, trashEach } = server({ unknownFolders: ['c'] });
        await trashEach(['c', 'F']);
        const result = await purgeBatch([blind('c'), node('F')], parts);
        expect(sent.purge).toEqual([['c', 'F']]);
        expect(result.gone).toEqual(['c', 'F']);
        expect(result.error).toBeNull();
    });

    test(`over ${MAX_TRASH_BATCH} rows go in requests of at most that many; one failing keeps none of the others back`, async () => {
        const all = many('n', 2 * MAX_TRASH_BATCH + 101);
        const { parts, sent, isPurged } = server({ failRequests: [2] });
        // Requests 0 and 1 put them in the Trash; request 2, the first delete, fails.
        await parts.trash('ws', all.slice(0, MAX_TRASH_BATCH));
        await parts.trash('ws', all.slice(MAX_TRASH_BATCH));
        const told: number[] = [];
        const result = await purgeBatch(
            all.map((id) => node(id)),
            parts,
            (ids) => told.push(ids.length),
        );
        expect(sent.purge.map((ids) => ids.length)).toEqual([
            MAX_TRASH_BATCH,
            MAX_TRASH_BATCH,
            101,
        ]);
        const went = all.slice(MAX_TRASH_BATCH);
        expect(told).toEqual([MAX_TRASH_BATCH, 101]);
        expect(result.gone).toEqual(went);
        expect((result.error as Error).message).toBe('request 2 failed');
        expect(all.filter(isPurged)).toEqual(went);
    });

    test('a row the server leaves out of its answer is not counted as gone', async () => {
        const { parts, trashEach } = server({ leaveOut: ['b'] });
        await trashEach(['a', 'b']);
        const result = await purgeBatch([node('a'), node('b')], parts);
        expect(result.gone).toEqual(['a']);
        expect(result.error).toMatchObject({ code: 'unavailable' });
    });
});

describe('deleting Trash rows the server no longer has, or turned away whole', () => {
    test('a row deleted already (another tab, an answer that never came) counts as gone, with no error', async () => {
        const { parts, sent, trashEach } = server();
        await trashEach(['a', 'b']);
        // Another tab deleted `a` a moment ago.
        await parts.purge('ws', ['a']);
        const told: string[][] = [];
        const result = await purgeBatch([node('a'), node('b')], parts, (ids) => told.push(ids));
        expect(sent.purge.at(-1)).toEqual(['a', 'b']);
        expect(result.gone).toEqual(['a', 'b']);
        expect(told).toEqual([['a', 'b']]);
        expect(result.error).toBeNull();
    });

    test('a request turned away as busy (409) is sent once more after a pause, and then goes', async () => {
        const { parts, sent, isPurged, trashEach, paused } = server({
            failRequests: [2],
            failStatus: 409,
        });
        await trashEach(['a', 'b']);
        const result = await purgeBatch([node('a'), node('b')], parts);
        expect(sent.purge).toEqual([
            ['a', 'b'],
            ['a', 'b'],
        ]);
        expect(paused).toEqual([PURGE_RETRY_MS]);
        expect(result.gone).toEqual(['a', 'b']);
        expect(result.error).toBeNull();
        expect(['a', 'b'].every(isPurged)).toBe(true);
    });

    test('busy (409) twice running: one more try, then it says so and keeps the rows', async () => {
        const { parts, sent, isPurged, trashEach, paused } = server({
            failRequests: [2, 3],
            failStatus: 409,
        });
        await trashEach(['a', 'b']);
        const result = await purgeBatch([node('a'), node('b')], parts);
        expect(sent.purge).toHaveLength(2);
        expect(paused).toEqual([PURGE_RETRY_MS]);
        expect(result.gone).toEqual([]);
        expect(result.error).toMatchObject({ status: 409 });
        expect(['a', 'b'].some(isPurged)).toBe(false);
    });

    test('too many requests (429) is not sent again: its window runs a minute', async () => {
        const { parts, sent, trashEach, paused } = server({ failRequests: [2], failStatus: 429 });
        await trashEach(['a', 'b']);
        const result = await purgeBatch([node('a'), node('b')], parts);
        expect(sent.purge).toHaveLength(1);
        expect(paused).toEqual([]);
        expect(result.gone).toEqual([]);
        expect(result.error).toMatchObject({ status: 429 });
    });

    test('any other failure is not sent again', async () => {
        const { parts, sent, trashEach, paused } = server({ failRequests: [2], failStatus: 500 });
        await trashEach(['a', 'b']);
        const result = await purgeBatch([node('a'), node('b')], parts);
        expect(sent.purge).toHaveLength(1);
        expect(paused).toEqual([]);
        expect(result.error).toMatchObject({ status: 500 });
    });
});

describe('restoring Trash rows', () => {
    test('says which did not come back, and why', async () => {
        const { parts, trashEach } = server({ refuseRestore: ['b'] });
        await trashEach(['a', 'b']);
        const result = await restoreBatch([node('a'), node('b')], parts);
        expect(ids(result.back)).toEqual(['a']);
        expect(result.failed.map(({ node: n }) => n.id)).toEqual(['b']);
        expect(result.failed[0]!.error).toMatchObject({ message: 'refused b' });
    });
});

describe('deleting Trash rows a request has no time for', () => {
    test('what a request answered busy is sent again until it is all gone', async () => {
        const rows = many('f', 5);
        const { parts, sent, isPurged, trashEach } = server({ purgeBudget: 2 });
        await trashEach(rows);
        const told: string[][] = [];
        const result = await purgeBatch(
            rows.map((id) => node(id)),
            parts,
            (ids) => told.push(ids),
        );
        expect(sent.purge).toEqual([rows, rows.slice(2), rows.slice(4)]);
        expect(told).toEqual([rows.slice(0, 2), rows.slice(2, 4), rows.slice(4)]);
        expect(result.gone).toEqual(rows);
        expect(result.error).toBeNull();
        expect(rows.every(isPurged)).toBe(true);
    });

    test('a request that gets nothing further ends it, and says so', async () => {
        const { parts, sent, trashEach } = server({ purgeBudget: 0 });
        await trashEach(['a', 'b']);
        const result = await purgeBatch([node('a'), node('b')], parts);
        expect(sent.purge).toEqual([
            ['a', 'b'],
            ['a', 'b'],
        ]);
        expect(result.gone).toEqual([]);
        expect(result.error).toMatchObject({ code: 'conflict', message: 'no time' });
    });
});
