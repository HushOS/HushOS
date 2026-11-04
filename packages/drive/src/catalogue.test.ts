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
        // Work stands in for deep and old.pdf, at old.pdf's time: newer than notes.md and plan.md.
        expect(ids(drive().recent(10))).toEqual(['work', 'notes.md', 'plan.md']);
    });

    test('stops at the limit and passes only what keep lets through', () => {
        // The window closes before work and deep are reached, so they hide nothing: old.pdf shows itself.
        expect(ids(drive().recent(2))).toEqual(['old.pdf', 'notes.md']);
        expect(ids(drive().recent(10, (entry) => entry.kind === 'folder'))).toEqual(['work']);
        // With the folders filtered out, nothing stands in for old.pdf: it shows itself.
        expect(ids(drive().recent(10, (entry) => entry.kind === 'file'))).toEqual([
            'old.pdf',
            'notes.md',
            'plan.md',
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
        expect(ids(catalogue.recent(10))).toEqual(['work', 'notes.md', 'plan.md']);
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

describe('a folder that is no longer here', () => {
    test('leaves nothing that was inside it live, at any depth', () => {
        const catalogue = drive();
        // The folder's tombstone arrived; what was inside waits for the server's fan-out.
        catalogue.remove('work');
        expect(ids(catalogue.recent(10))).toEqual(['notes.md', 'plan.md']);
        expect(catalogue.search({ query: 'old' })).toEqual([]);
        expect(ids(catalogue.byTags(['tax']))).toEqual(['notes.md']);
    });
});

/*
 * Kind words stand in for Home's old type chips: "photos" must reach every image, at any
 * depth, ahead of what only has the word in its path, while a name with the word still
 * matches and every other word still has to land.
 */
describe('kind words', () => {
    /* root ─ Photos ─ Lisbon ─ beach.jpg; root ─ cat.png, photos.txt, report.pdf, clip.mp4 */
    function library() {
        const catalogue = new Catalogue();
        catalogue.upsert(node('root', null, { kind: 'folder' }));
        catalogue.upsert(node('Photos', 'root', { kind: 'folder' }));
        catalogue.upsert(node('Lisbon', 'Photos', { kind: 'folder' }));
        catalogue.upsert(node('beach.jpg', 'Lisbon'));
        catalogue.upsert(node('cat.png', 'root'));
        catalogue.upsert(node('photos.txt', 'root'));
        catalogue.upsert(node('report.pdf', 'root'));
        catalogue.upsert(node('clip.mp4', 'root'));
        catalogue.upsert(node('gone.png', 'root', { trashed: true }));
        return catalogue;
    }
    // The app's split, by name here; the web passes what its viewer shows a file as.
    const kindOf = (entry: DriveNode) =>
        entry.kind === 'folder'
            ? ('folder' as const)
            : /\.(jpg|png)$/.test(entry.name)
              ? ('image' as const)
              : entry.name.endsWith('.mp4')
                ? ('video' as const)
                : /\.(pdf|txt)$/.test(entry.name)
                  ? ('document' as const)
                  : null;
    const found = (query: string, catalogue = library(), withKinds = true) =>
        catalogue
            .search({ query, kindOf: withKinds ? kindOf : undefined })
            .map((hit) => hit.node.id);

    test('an image word finds every live image, nested ones too, ahead of a path match', () => {
        const hits = found('photos');
        expect(hits.slice(0, 2)).toEqual(['Photos', 'photos.txt']);
        expect(hits.slice(2, 4).sort()).toEqual(['beach.jpg', 'cat.png']);
        // Lisbon only has "Photos" in its path, so it comes after every image.
        expect(hits.slice(4)).toEqual(['Lisbon']);
        expect(hits).not.toContain('gone.png');
        expect(found('pictures').sort()).toEqual(['beach.jpg', 'cat.png']);
    });

    test('each word names its own kind', () => {
        expect(found('videos')).toEqual(['clip.mp4']);
        expect(found('docs').sort()).toEqual(['photos.txt', 'report.pdf']);
        expect(found('folders').sort()).toEqual(['Lisbon', 'Photos']);
    });

    test('every other word must still land', () => {
        expect(found('images lisbon')).toEqual(['beach.jpg']);
        expect(found('videos lisbon')).toEqual([]);
    });

    test('an extension is still an extension', () => {
        expect(found('pdf')).toEqual(['report.pdf']);
        expect(found('png')).toEqual(['cat.png']);
    });

    test('without the app’s split only folders are known by kind', () => {
        expect(found('folders', library(), false).sort()).toEqual(['Lisbon', 'Photos']);
        expect(found('photos', library(), false)).toEqual([
            'Photos',
            'photos.txt',
            'Lisbon',
            'beach.jpg',
        ]);
    });
});
