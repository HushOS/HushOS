import { describe, expect, test } from 'vitest';
import { Catalogue } from './catalogue';
import type { DriveNode } from './client';

/*
 * Recent, search and tags answer from the catalogue alone, so what they leave
 * out is what a person sees as gone. Trashing a folder marks only the folder;
 * everything inside it must drop out with it, at any depth, and come back when
 * the folder is restored.
 */

function node(
    id: string,
    parentId: string | null,
    options: { kind?: 'file' | 'folder'; updatedAt?: string; trashed?: boolean } = {},
) {
    return {
        id,
        parentId,
        kind: options.kind ?? 'file',
        name: id,
        updatedAt: options.updatedAt ?? '2026-10-01T00:00:00.000Z',
        trashedAt: options.trashed ? '2026-10-02T00:00:00.000Z' : null,
    } as unknown as DriveNode;
}

/* root ─ work ─ deep ─ old.pdf; root ─ notes.md; root ─ plan.md */
function drive(trashWork = false) {
    const catalogue = new Catalogue();
    catalogue.upsert(node('root', null, { kind: 'folder' }));
    catalogue.upsert(
        node('work', 'root', {
            kind: 'folder',
            updatedAt: '2026-10-01T09:00:00.000Z',
            trashed: trashWork,
        }),
    );
    catalogue.upsert(
        node('deep', 'work', { kind: 'folder', updatedAt: '2026-10-01T10:00:00.000Z' }),
    );
    catalogue.upsert(node('old.pdf', 'deep', { updatedAt: '2026-10-03T00:00:00.000Z' }));
    catalogue.upsert(node('notes.md', 'root', { updatedAt: '2026-10-02T00:00:00.000Z' }));
    catalogue.upsert(node('plan.md', 'root', { updatedAt: '2026-10-02T00:00:00.000Z' }));
    catalogue.setTags({
        tags: [{ id: 'tax', name: 'Tax', colour: '#2c428e' }],
        items: { tax: ['old.pdf', 'notes.md'] },
    } as never);
    return catalogue;
}

const ids = (nodes: DriveNode[]) => nodes.map((entry) => entry.id);

describe('recent', () => {
    test('lists newest first, breaks ties by name, and leaves out the top folder', () => {
        expect(ids(drive().recent(10))).toEqual(['old.pdf', 'notes.md', 'plan.md', 'deep', 'work']);
    });

    test('stops at the limit and passes only what keep lets through', () => {
        expect(ids(drive().recent(2))).toEqual(['old.pdf', 'notes.md']);
        expect(ids(drive().recent(10, (entry) => entry.kind === 'folder'))).toEqual([
            'deep',
            'work',
        ]);
    });

    test('drops everything under a trashed folder, at any depth', () => {
        expect(ids(drive(true).recent(10))).toEqual(['notes.md', 'plan.md']);
    });

    test('brings it back when the folder is restored', () => {
        const catalogue = drive(true);
        catalogue.upsert(
            node('work', 'root', { kind: 'folder', updatedAt: '2026-10-01T09:00:00.000Z' }),
        );
        expect(ids(catalogue.recent(10))).toContain('old.pdf');
    });
});

describe('a trashed folder hides what is inside it', () => {
    test('from search', () => {
        expect(
            ids(
                drive()
                    .search({ query: 'old' })
                    .map((hit) => hit.node),
            ),
        ).toEqual(['old.pdf']);
        expect(drive(true).search({ query: 'old' })).toEqual([]);
    });

    test('from a tag and its count', () => {
        expect(ids(drive().byTags(['tax'])).sort()).toEqual(['notes.md', 'old.pdf']);
        expect(drive().tagCounts().get('tax')).toBe(2);
        expect(ids(drive(true).byTags(['tax']))).toEqual(['notes.md']);
        expect(drive(true).tagCounts().get('tax')).toBe(1);
    });
});
