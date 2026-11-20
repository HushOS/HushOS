import { describe, expect, test } from 'vitest';
import type { DriveNode } from '@hushos/drive/client';
import { sortNodesBy } from './drive';

/* A node with only what ordering reads: kind, name, modified time and size. */
function node(
    name: string,
    kind: 'file' | 'folder',
    modified: string,
    size: number | null,
): DriveNode {
    return {
        id: name,
        kind,
        name,
        updatedAt: modified,
        metadata: { name, mime: null, size, modified },
        content: size === null ? null : { plaintextSize: size, thumbnailBytes: 0 },
        currentVersion: null,
        openError: null,
    } as unknown as DriveNode;
}

const nodes = [
    node('b.txt', 'file', '2026-09-20T10:00:00Z', 300),
    node('Zeta', 'folder', '2026-09-01T10:00:00Z', null),
    node('a10.txt', 'file', '2026-09-22T10:00:00Z', 10),
    node('a2.txt', 'file', '2026-09-21T10:00:00Z', 10),
    node('Alpha', 'folder', '2026-09-23T10:00:00Z', null),
];
const names = (list: DriveNode[]) => list.map((n) => n.name);

describe('sortNodesBy', () => {
    test('by name: folders first, then natural order, so a2 comes before a10', () => {
        expect(names(sortNodesBy(nodes, { key: 'name', ascending: true }))).toEqual([
            'Alpha',
            'Zeta',
            'a2.txt',
            'a10.txt',
            'b.txt',
        ]);
    });

    test('newest first keeps folders on top and orders each group by time', () => {
        expect(names(sortNodesBy(nodes, { key: 'modified', ascending: false }))).toEqual([
            'Alpha',
            'Zeta',
            'a10.txt',
            'a2.txt',
            'b.txt',
        ]);
    });

    test('by size, equal sizes fall back to the name', () => {
        expect(names(sortNodesBy(nodes, { key: 'size', ascending: true }))).toEqual([
            'Alpha',
            'Zeta',
            'a2.txt',
            'a10.txt',
            'b.txt',
        ]);
        expect(names(sortNodesBy(nodes, { key: 'size', ascending: false })).slice(2)).toEqual([
            'b.txt',
            'a10.txt',
            'a2.txt',
        ]);
    });
});
