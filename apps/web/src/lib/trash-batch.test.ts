import type { DriveNode } from '@hushos/drive/client';
import { describe, expect, test } from 'vitest';
import { restoreBatch, trashBatch, type TrashParts } from '@/lib/trash-batch';

/*
 * A selection to the trash and back, against a server kept in memory that
 * answers as the real one does: an item already in the trash, itself or through
 * a folder it is in, is refused; a refused item stays where it was.
 */

const ROOT = 'root';
const tree: Record<string, string> = {
    // id: parent
    F: ROOT,
    c: 'F',
    g: 'c',
    a: ROOT,
    b: ROOT,
    x: ROOT,
    ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, ROOT])),
};
const node = (id: string) =>
    ({ id, parentId: tree[id], workspaceId: 'ws', name: id, kind: 'file' }) as DriveNode;

function server({ refuseTrash = [] as string[], refuseRestore = [] as string[] } = {}) {
    const trashed = new Set<string>();
    const sent = { trash: [] as string[], restore: [] as string[] };
    const chain = (id: string) => {
        const up: string[] = [];
        for (let at = tree[id]; at && at !== ROOT; at = tree[at]) up.push(at);
        return up;
    };
    // Later items answer sooner, so the order things land in is not the order given.
    let delay = 12;
    const later = () =>
        new Promise((resolve) => setTimeout(resolve, (delay = Math.max(0, delay - 1))));
    const parts: TrashParts = {
        trash: async (n) => {
            sent.trash.push(n.id);
            // A refusal answers at once, while the rest are still on their way.
            if (refuseTrash.includes(n.id)) throw new Error(`refused ${n.id}`);
            await later();
            if (trashed.has(n.id) || chain(n.id).some((id) => trashed.has(id)))
                throw new Error(`${n.id} is already in the trash`);
            trashed.add(n.id);
            return { ...n, trashedAt: 'now' };
        },
        restore: async (n) => {
            sent.restore.push(n.id);
            await later();
            if (refuseRestore.includes(n.id) || !trashed.has(n.id))
                throw new Error(`refused ${n.id}`);
            trashed.delete(n.id);
            return { ...n, trashedAt: null };
        },
        ancestorsOf: (n) => chain(n.id).map((id) => ({ id })),
    };
    /* Whether an item is in the trash, itself or inside a trashed folder. */
    const inTrash = (id: string) => trashed.has(id) || chain(id).some((up) => trashed.has(up));
    return { parts, sent, inTrash };
}
const ids = (nodes: DriveNode[]) => nodes.map((n) => n.id);
const sorted = (list: string[]) => [...list].sort();

describe('a selection to the trash', () => {
    test('“N of M” counts only what reached the trash, in the order picked', async () => {
        const { parts, inTrash } = server({ refuseTrash: ['b'] });
        const picked = ['a', 'b', 'x'].map(node);
        const result = await trashBatch(picked, parts);
        expect(result.gone).toEqual(['a', 'x']);
        expect(ids(result.moved)).toEqual(['a', 'x']);
        expect(result.tried).toBe(3);
        expect(result.error).toBeInstanceOf(Error);
        expect(['a', 'b', 'x'].filter(inTrash)).toEqual(['a', 'x']);
    });

    test('one refusal leaves none of the rest behind, however many wait their turn', async () => {
        const files = Array.from({ length: 10 }, (_, i) => `f${i}`);
        const { parts, sent, inTrash } = server({ refuseTrash: ['f0'] });
        const result = await trashBatch(files.map(node), parts);
        expect(sorted(sent.trash)).toEqual(sorted(files));
        expect(result.gone).toEqual(files.slice(1));
        expect(files.filter(inTrash)).toEqual(files.slice(1));
    });

    test('an item inside a folder that is going is sent once, with its folder, and counted as gone', async () => {
        const { parts, sent, inTrash } = server();
        const told: string[] = [];
        // The child and grandchild listed before their folder; the grandchild's parent is not picked.
        const picked = ['g', 'c', 'F', 'a'].map(node);
        const result = await trashBatch(picked, parts, (landed) => told.push(...landed));
        expect(sorted(sent.trash)).toEqual(['F', 'a']);
        expect(result.tried).toBe(2);
        expect(result.gone).toEqual(['g', 'c', 'F', 'a']);
        expect(sorted(told)).toEqual(['F', 'a', 'c', 'g']);
        expect(ids(result.moved)).toEqual(['F', 'a']);
        expect(['g', 'c', 'F', 'a'].every(inTrash)).toBe(true);
    });

    test('an item inside a folder that is refused stays where it is and is not counted', async () => {
        const { parts, sent, inTrash } = server({ refuseTrash: ['F'] });
        const told: string[] = [];
        const picked = ['F', 'c', 'a'].map(node);
        const result = await trashBatch(picked, parts, (landed) => told.push(...landed));
        expect(sorted(sent.trash)).toEqual(['F', 'a']);
        expect(result.gone).toEqual(['a']);
        expect(told).toEqual(['a']);
        expect(ids(result.moved)).toEqual(['a']);
        expect(['F', 'c'].some(inTrash)).toBe(false);
    });
});

describe('Undo', () => {
    test('puts back exactly what moved: nothing refused, nothing that went inside a folder', async () => {
        const { parts, sent, inTrash } = server({ refuseTrash: ['b'] });
        const trashed = await trashBatch(['a', 'b', 'F', 'c'].map(node), parts);
        const undone = await restoreBatch(trashed.moved, parts);
        expect(sorted(sent.restore)).toEqual(['F', 'a']);
        expect(ids(undone.back)).toEqual(['a', 'F']);
        expect(undone.error).toBeNull();
        expect(['a', 'b', 'F', 'c'].some(inTrash)).toBe(false);
    });

    test('says what came back when some of it cannot', async () => {
        const { parts, inTrash } = server({ refuseRestore: ['F'] });
        const trashed = await trashBatch(['a', 'F', 'x'].map(node), parts);
        const told: string[] = [];
        const undone = await restoreBatch(trashed.moved, parts, (back) => told.push(...ids(back)));
        expect(ids(undone.back)).toEqual(['a', 'x']);
        expect(sorted(told)).toEqual(['a', 'x']);
        expect(undone.error).toBeInstanceOf(Error);
        expect(['a', 'x'].some(inTrash)).toBe(false);
        expect(inTrash('F')).toBe(true);
    });
});
