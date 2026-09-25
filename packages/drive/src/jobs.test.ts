import { describe, expect, test } from 'vitest';
import { judgeObject, selectOrphans } from './jobs';

/*
 * The two decisions that delete or downgrade bytes at the store, checked at
 * their edges. Everything around them is glue over the repository and the
 * store, exercised against the local Garage by hand and by the repository tests.
 */

const row = { ciphertextSize: 1_048_592n };

describe('judgeObject', () => {
    test('the primary audit trusts a copy of the recorded size and nothing else', () => {
        expect(judgeObject('primary', row, { primary: { size: 1_048_592 }, replica: null })).toBe(
            'present',
        );
        // Truncated at the store: a file that would fail to decrypt is a miss.
        expect(judgeObject('primary', row, { primary: { size: 1_048_576 }, replica: null })).toBe(
            'missing',
        );
        expect(judgeObject('primary', row, { primary: null, replica: null })).toBe('missing');
    });

    test('a lost primary copy the replica still holds is recovered, a short one is not', () => {
        expect(judgeObject('primary', row, { primary: null, replica: { size: 1_048_592 } })).toBe(
            'recoverable',
        );
        expect(judgeObject('primary', row, { primary: null, replica: { size: 12 } })).toBe(
            'missing',
        );
    });

    test('the replica audit reports the replica only and never marks the file missing', () => {
        expect(judgeObject('replica', row, { primary: null, replica: { size: 1_048_592 } })).toBe(
            'present',
        );
        expect(judgeObject('replica', row, { primary: { size: 1_048_592 }, replica: null })).toBe(
            'replica-missing',
        );
    });
});

describe('selectOrphans', () => {
    const now = new Date('2026-09-13T12:00:00Z');
    const days = (n: number) => new Date(now.getTime() - n * 24 * 3600 * 1000);

    test('deletes only what no row names and what is older than the age bound', () => {
        const listed = [
            { key: 'ws/a/known-old', modifiedAt: days(30) },
            { key: 'ws/a/stray-old', modifiedAt: days(8) },
            { key: 'ws/a/stray-young', modifiedAt: days(6) },
            { key: 'ws/a/stray-boundary', modifiedAt: days(7) },
            { key: 'ws/a/stray-undated', modifiedAt: null },
        ];
        const known = new Set(['ws/a/known-old']);
        expect(selectOrphans(listed, known, now, 7).map((o) => o.key)).toEqual(['ws/a/stray-old']);
    });

    test('an empty listing and a fully known listing delete nothing', () => {
        expect(selectOrphans([], new Set(), now, 7)).toEqual([]);
        const listed = [{ key: 'ws/a/x', modifiedAt: days(100) }];
        expect(selectOrphans(listed, new Set(['ws/a/x']), now, 7)).toEqual([]);
    });
});
