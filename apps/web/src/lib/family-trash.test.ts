import { describe, expect, test } from 'vitest';
import { emptyConfirmText, emptyPlan, emptyResult, type EmptyRow } from './family-trash';

const file = (writable: boolean, parentTrashed = false): EmptyRow => ({
    writable,
    parentTrashed,
    kind: 'file',
});
const folder = (writable: boolean): EmptyRow => ({
    writable,
    parentTrashed: false,
    kind: 'folder',
});

/*
 * Empty Trash on the family folders' tab once said "Trash emptied" while items in folders this
 * device can't change stayed behind, unsaid.
 */
describe('emptying the family folders’ Trash', () => {
    test('an item in a folder this device can’t change is never asked for, and is said to stay', () => {
        const writable = file(true);
        const locked = file(false);
        const plan = emptyPlan([writable, locked]);
        expect(plan.purge).toEqual([writable]);
        expect(plan).toMatchObject({ goes: 1, stays: 1, folders: false });
        expect(emptyConfirmText(plan)).toBe(
            '1 item in the family folders’ Trash is deleted for good, for everyone in the family. 1 item in folders you can’t change stays. This can’t be undone.',
        );
    });

    test('with nothing skipped it says all, and a folder takes what is inside it', () => {
        const top = folder(true);
        const inside = file(true, true);
        const loose = file(true);
        const plan = emptyPlan([top, inside, loose]);
        // The item inside isn't asked for on its own: it goes with its folder.
        expect(plan.purge).toEqual([top, loose]);
        expect(plan).toMatchObject({ goes: 3, stays: 0, folders: true });
        expect(emptyConfirmText(plan)).toBe(
            'All 3 items in the family folders’ Trash are deleted for good, for everyone in the family. What’s inside a folder goes with it. This can’t be undone.',
        );
    });

    test('“Trash emptied” only when nothing is left behind', () => {
        expect(emptyResult({ asked: 2, failed: 0, stays: 0 })).toMatchObject({
            type: 'success',
            title: 'Trash emptied',
        });
        const partial = emptyResult({ asked: 1, failed: 0, stays: 1 });
        expect(partial.title).not.toBe('Trash emptied');
        expect(partial).toMatchObject({
            type: 'warning',
            title: 'Some items are still in the Trash',
            description: '1 item in folders you can’t change is still there.',
        });
        expect(emptyResult({ asked: 3, failed: 1, stays: 2 })).toMatchObject({
            type: 'error',
            description: '1 of 3 items is still there. Try again.',
        });
    });
});
