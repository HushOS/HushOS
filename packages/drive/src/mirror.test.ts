import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import type { NodeChange, NodeView } from './api';
import { createIndexedDbMirror, createMemoryMirror, type TreeMirror } from './mirror';

/*
 * Every tab of a device writes to one mirror, each pulling the feed from where
 * its own catalogue stands. A page fetched before another tab's later one can
 * land after it; what it carries is older than what the mirror holds, and
 * putting it back would leave the disk with a moved node in its old place, or
 * a deleted one back, until the next rebuild. And a tab can clear the mirror
 * while another's page is on its way: that page must not let the cursor claim
 * the changes in between. A folder deleted forever takes its contents off the
 * disk at once, though the server tombstones them only minutes later.
 */

const WS = 'ws';

const put = (
    id: string,
    parentId: string | null,
    changeSeq: number,
    kind: 'file' | 'folder' = 'file',
): NodeChange => ({
    kind: 'node',
    changeSeq,
    node: { id, workspaceId: WS, parentId, changeSeq, kind } as NodeView,
});
const gone = (id: string, parentId: string, changeSeq: number): NodeChange => ({
    kind: 'tombstone',
    changeSeq,
    nodeId: id,
    parentId,
});
const held = async (mirror: TreeMirror) =>
    Object.fromEntries((await mirror.rows(WS)).map((r) => [r.id, [r.parentId, r.changeSeq]]));

describe.each([
    ['in memory', () => createMemoryMirror()],
    ['in IndexedDB', () => createIndexedDbMirror(`mirror-${Math.random()}`)],
])('the tree mirror %s', (_, make) => {
    test('a page older than the cursor never puts back a node moved or deleted since', async () => {
        const mirror = make();
        await mirror.apply(
            WS,
            0,
            [put('root', null, 1, 'folder'), put('a', 'root', 2), put('b', 'root', 3, 'folder')],
            3,
        );
        // Other tabs: "a" moved into "b", then back to the top, and "b" deleted forever.
        await mirror.apply(WS, 3, [put('a', 'b', 4)], 4);
        await mirror.apply(WS, 4, [put('a', 'root', 5), gone('b', 'root', 6)], 6);
        // This tab's slower pages, fetched before either.
        expect(await mirror.apply(WS, 3, [put('a', 'b', 4)], 4)).toBe(true);
        expect(await mirror.apply(WS, 2, [put('b', 'root', 3, 'folder')], 3)).toBe(true);

        expect(await held(mirror)).toEqual({ root: [null, 1], a: ['root', 5] });
        expect(await mirror.cursor(WS)).toBe(6);
    });

    test('a page asked for before the mirror was cleared is refused, so the cursor claims no gap', async () => {
        const mirror = make();
        await mirror.apply(WS, 0, [put('root', null, 1, 'folder'), put('a', 'root', 2)], 2);
        // Another tab clears it and starts over; this tab's page, from 2, lands meanwhile.
        await mirror.clear(WS);
        expect(await mirror.apply(WS, 2, [put('b', 'root', 3)], 3)).toBe(false);
        expect(await mirror.cursor(WS)).toBe(0);
        // The other tab's pull goes on from where the mirror stands, and misses nothing.
        await mirror.apply(WS, 0, [put('root', null, 1, 'folder'), put('a', 'root', 2)], 2);
        await mirror.apply(WS, 2, [put('b', 'root', 3)], 3);
        expect(await held(mirror)).toEqual({ root: [null, 1], a: ['root', 2], b: ['root', 3] });
    });

    test('dropping below a deleted folder takes what was inside it, at any depth, but nothing beside it', async () => {
        const mirror = make();
        await mirror.apply(
            WS,
            0,
            [
                put('root', null, 1, 'folder'),
                put('taxes', 'root', 2, 'folder'),
                put('receipts', 'taxes', 3, 'folder'),
                put('scan.pdf', 'receipts', 4),
                put('notes.md', 'root', 5),
            ],
            5,
        );
        await mirror.apply(WS, 5, [gone('taxes', 'root', 6)], 6);
        await mirror.dropBelow(WS, ['taxes']);
        expect(await held(mirror)).toEqual({ root: [null, 1], 'notes.md': ['root', 5] });
    });

    test('dropping below a folder this device never held still takes what arrived inside it', async () => {
        const mirror = make();
        // A pull from nothing: the contents come live, the folder only as its tombstone.
        await mirror.apply(
            WS,
            0,
            [
                put('root', null, 1, 'folder'),
                put('receipts', 'taxes', 3, 'folder'),
                put('scan.pdf', 'receipts', 4),
                put('notes.md', 'root', 5),
                gone('taxes', 'root', 6),
            ],
            6,
        );
        await mirror.dropBelow(WS, ['taxes']);
        expect(await held(mirror)).toEqual({ root: [null, 1], 'notes.md': ['root', 5] });
    });
});
