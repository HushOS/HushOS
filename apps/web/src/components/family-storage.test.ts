import { describe, expect, test } from 'vitest';
import { familyStorage } from './family-storage';
import { dotParts } from './fit-answer';

const GB = 1024 ** 3;
const FREE = 2 * GB;

const view = (people: number, ownGb: number, foldersGb: number, leaving = false) =>
    familyStorage({
        people,
        ownEach: ownGb * GB,
        folders: foldersGb * GB,
        leaving,
        freeBytes: FREE,
    });
const planOf = (result: ReturnType<typeof view>) =>
    result.answer.kind === 'fits' || result.answer.kind === 'tight'
        ? `${result.answer.kind} ${result.answer.plan.name}`
        : result.answer.kind;

describe('familyStorage', () => {
    test('one plan holds everyone’s own files and the family folders together', () => {
        // 4 × 105 GB + 300 GB = 720 GB, exactly 90% of Family Plus: the planner's headroom edge.
        expect(planOf(view(4, 105, 300))).toBe('fits Family Plus');
        // A gigabyte more and the next tier answers, with its own room to spare.
        expect(planOf(view(4, 105, 301))).toBe('fits Family Pro');
        // Only the biggest plan is ever tight: 20 × 180 GB + 100 GB = 3700 GB of 4 TB.
        expect(planOf(view(20, 180, 100))).toBe('tight Family Max');
        expect(view(4, 105, 300).ownBytes).toBe(420 * GB);
        expect(view(4, 105, 300).folderBytes).toBe(300 * GB);
    });

    test('counts every person, so adding people can move the plan', () => {
        expect(planOf(view(7, 100, 0))).toBe('fits Family Plus');
        expect(planOf(view(8, 100, 0))).toBe('fits Family Pro');
    });

    test('past the biggest plan there is no plan to fill', () => {
        // 20 × 200 GB + 100 GB = 4100 GB, more than Family Max's 4 TB.
        expect(planOf(view(20, 200, 100))).toBe('beyond');
    });

    test('someone leaving takes their own files, and the family keeps its plan', () => {
        const before = view(4, 126, 300);
        const after = view(4, 126, 300, true);
        expect(planOf(after)).toBe(planOf(before));
        expect(after.ownBytes).toBe(before.ownBytes - 126 * GB);
        expect(after.folderBytes).toBe(before.folderBytes);
        expect(after.leaver).toEqual({ bytes: 126 * GB, quotaBytes: FREE, fits: false });
    });

    test('a leaver’s files fit Free up to its size and not a byte past it', () => {
        expect(view(3, 2, 10, true).leaver?.fits).toBe(true);
        const over = familyStorage({
            people: 3,
            ownEach: FREE + 1,
            folders: 0,
            leaving: true,
            freeBytes: FREE,
        });
        expect(over.leaver?.fits).toBe(false);
        expect(view(3, 2, 10).leaver).toBeNull();
    });
});

describe('dotParts', () => {
    test('fills parts in order and leaves the rest off', () => {
        expect(dotParts([0.25, 0.5], 8)).toEqual([0, 0, 1, 1, 1, 1, null, null]);
    });

    test('a part holding anything shows at least one dot; an empty one shows none', () => {
        expect(dotParts([0.001, 0, 0.001], 10)).toEqual([0, 2, ...Array(8).fill(null)]);
    });

    test('never lights more dots than there are, however the shares add up', () => {
        const parts = dotParts([0.7, 0.6], 120);
        expect(parts).toHaveLength(120);
        expect(parts.filter((part) => part === 0)).toHaveLength(84);
        expect(parts.filter((part) => part === 1)).toHaveLength(36);
        expect(parts).not.toContain(null);
    });

    test('one share is the planner’s bar: as many lit as its share, rounded', () => {
        const lit = (share: number) => dotParts([share], 120).filter((part) => part === 0).length;
        expect(lit(0.5)).toBe(60);
        expect(lit(1.4)).toBe(120);
        expect(lit(0)).toBe(0);
    });
});
