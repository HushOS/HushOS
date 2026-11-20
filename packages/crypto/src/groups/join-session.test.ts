import { describe, expect, test } from 'vitest';
import {
    MAX_SHOWN_CODES,
    checkCode,
    drawPositions,
    holdsValue,
    newJoinFamily,
    restoreHolds,
    showCode,
    stillShown,
} from './join-session';

/*
 * The escalation's edges the shared session scenarios do not reach with the
 * fixtures' draws: the rejection boundary of the 32-bit draws, the bound on
 * shown codes, and restored roster versions JavaScript cannot hold exactly.
 * The core's join.rs tests the same edges.
 */

const LIMIT = 2 ** 32 - 4;
const CODE =
    'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(
        ' ',
    );
const mark = (rosterVersion: number, code = CODE) => ({ rosterVersion, code });
const draws = (list: number[]) => {
    let at = 0;
    return () => {
        const next = list[at++];
        if (next === undefined) throw new Error('the draws ran out');
        return next;
    };
};

describe('hidden positions', () => {
    test('draws from 2^32 - 4 up are rejected, so no position is likelier than another', () => {
        // 2^32 - 4 would be 0 and 2^32 - 3 would be 1 under a bare modulo.
        expect(drawPositions([LIMIT, LIMIT + 1, 3, 5])).toEqual([3, 5]);
        expect(drawPositions([LIMIT + 2, 0xffff_ffff, 7, 2])).toEqual([2, 7]);
        // Just below the boundary: the last whole run of twelve still counts.
        expect(drawPositions([LIMIT - 1, LIMIT - 2])).toEqual([10, 11]);
        // Rejected draws alone never give a position.
        expect(drawPositions([LIMIT, LIMIT + 1, LIMIT + 2, 0xffff_ffff])).toBeNull();
    });

    test('a code is drawn for once and keeps its positions however often it is shown', () => {
        const family = newJoinFamily();
        const first = showCode(family, mark(2), draws([1, 9]));
        expect(first).toEqual([1, 9]);
        // Shown again, after a wrong pair too: the same positions, nothing drawn.
        expect(showCode(family, mark(2), draws([]))).toEqual(first);
        expect(checkCode(family, mark(2), ['x', 'y'])).toBe('wrong-words');
        expect(showCode(family, mark(2), draws([]))).toEqual(first);
        // A distinct code gets its own draw.
        expect(showCode(family, mark(3), draws([4, 6]))).toEqual([4, 6]);
    });

    test(`a family keeps at most ${MAX_SHOWN_CODES} codes: the earliest unheld goes, and all held refuses another`, () => {
        const family = newJoinFamily();
        showCode(family, mark(1), draws([0, 1]));
        for (let version = 2; version <= MAX_SHOWN_CODES; version++)
            showCode(family, mark(version), draws([0, 1]));
        expect(family.issued.size).toBe(MAX_SHOWN_CODES);
        showCode(family, mark(MAX_SHOWN_CODES + 1), draws([0, 1]));
        expect(family.issued.size).toBe(MAX_SHOWN_CODES);
        expect(stillShown(family, mark(1), [0, 1])).toBe(false);
        expect(stillShown(family, mark(2), [0, 1])).toBe(true);

        const held = newJoinFamily();
        for (let version = 1; version <= MAX_SHOWN_CODES; version++) {
            showCode(held, mark(version), draws([0, 1]));
            checkCode(held, mark(version), ['x', 'y']);
        }
        expect(() => showCode(held, mark(MAX_SHOWN_CODES + 1), draws([0, 1]))).toThrow(
            /Too many join codes/,
        );
        // Every held code stays.
        expect(holdsValue(held)!.held).toHaveLength(MAX_SHOWN_CODES);
    });
});

describe('restoring a kept escalation', () => {
    const kept = (rosterVersion: number, positions: [number, number] = [3, 8]) => ({
        v: 1,
        tried: true,
        held: [{ rosterVersion, code: CODE, positions }],
    });

    test('takes roster versions 1 to 2^53 - 1 only, as the core does', () => {
        for (const version of [0, -1, 1.5, 2 ** 53, 2 ** 64]) {
            const family = newJoinFamily();
            restoreHolds(family, kept(version));
            expect(family.issued.size, String(version)).toBe(0);
            // Its wrong pair still counts: a damaged entry does not reset the alarm.
            expect(family.tried, String(version)).toBe(true);
        }
        for (const version of [1, Number.MAX_SAFE_INTEGER]) {
            const family = newJoinFamily();
            restoreHolds(family, kept(version));
            expect(stillShown(family, mark(version), [3, 8]), String(version)).toBe(true);
        }
    });

    test('only ever holds more: positions held here stay, unheld ones take the kept positions', () => {
        const family = newJoinFamily();
        showCode(family, mark(2), draws([1, 9]));
        checkCode(family, mark(2), ['x', 'y']);
        restoreHolds(family, kept(2));
        expect(stillShown(family, mark(2), [1, 9])).toBe(true);

        const unheld = newJoinFamily();
        showCode(unheld, mark(2), draws([1, 9]));
        restoreHolds(unheld, kept(2));
        // The showing on screen is replaced: checked, it is refused.
        expect(stillShown(unheld, mark(2), [1, 9])).toBe(false);
        expect(stillShown(unheld, mark(2), [3, 8])).toBe(true);
        expect(checkCode(unheld, mark(2), ['x', 'y'])).toBe('mismatch');
    });
});
