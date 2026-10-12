import { describe, expect, test } from 'vitest';
import {
    addTag,
    assign,
    mergeRegistries,
    parseRegistry,
    removeTag,
    renameTag,
    serialiseRegistry,
} from './tags';

/*
 * A newer app may write fields this one does not know: at the top of the
 * document, on a tag, or as memberships of a tag this app cannot read. Every
 * edit here saves the document, so each must carry them through untouched,
 * or the first save from an older device would erase a newer one's work.
 */

const ids = ['a', 'b', 'c', 'd'].map(
    (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`,
);
const [WORK, NODE, OTHER, FUTURE] = ids as [string, string, string, string];

const newer = () => ({
    version: 2,
    order: 'manual',
    tags: [{ id: WORK, name: 'Work', colour: 'blue', icon: 'briefcase' }],
    items: { [WORK]: [NODE], [FUTURE]: [NODE] },
});

function survives(saved: Record<string, unknown>) {
    expect(saved.order).toBe('manual');
    expect((saved.items as Record<string, unknown>)[FUTURE]).toEqual([NODE]);
}

describe('fields this app does not know', () => {
    test('ride through every edit and come back out when saved', () => {
        const opened = parseRegistry(newer());
        const added = addTag(opened, 'Home').registry;
        const renamed = renameTag(added, WORK, 'Office');
        const assigned = assign(renamed, OTHER, [WORK]);
        const saved = serialiseRegistry(assigned) as Record<string, unknown>;
        survives(saved);
        const work = (saved.tags as Record<string, unknown>[]).find((tag) => tag.id === WORK)!;
        expect(work.icon).toBe('briefcase');
        // The edits themselves applied.
        expect(work.name).toBe('Office');
        expect((saved.tags as unknown[]).length).toBe(2);
        expect((saved.items as Record<string, string[]>)[WORK]).toEqual([NODE, OTHER]);
    });

    test('removing a tag keeps the rest of what this app could not read', () => {
        const saved = serialiseRegistry(removeTag(parseRegistry(newer()), WORK)) as Record<
            string,
            unknown
        >;
        survives(saved);
        expect((saved.items as Record<string, unknown>)[WORK]).toBeUndefined();
    });

    test('a merge with another device keeps what either side kept', () => {
        const base = parseRegistry(newer());
        const ours = renameTag(base, WORK, 'Office');
        const theirs = parseRegistry({ ...newer(), layout: 'grid' });
        const saved = serialiseRegistry(mergeRegistries(base, ours, theirs)) as Record<
            string,
            unknown
        >;
        survives(saved);
        expect(saved.layout).toBe('grid');
        expect((saved.tags as Record<string, unknown>[])[0]!.icon).toBe('briefcase');
    });

    test('a document from a newer version is refused rather than rewritten', () => {
        expect(() => parseRegistry({ ...newer(), version: 3 })).toThrow(/newer app/);
    });
});
