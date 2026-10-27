import { describe, expect, test } from 'vitest';
import { emptyConfirmText, emptyPlan, emptyResult, staysLine, type EmptyRow } from './family-trash';

const file = (writable: boolean, parentTrashed = false): EmptyRow => ({
    writable,
    reason: writable ? undefined : 'read-only',
    parentTrashed,
    kind: 'file',
});
const keysChanged = (): EmptyRow => ({
    writable: false,
    reason: 'keys-changed',
    parentTrashed: false,
    kind: 'file',
});
const folder = (writable: boolean): EmptyRow => ({
    writable,
    parentTrashed: false,
    kind: 'folder',
});

/*
 * Empty Trash on the family folders' tab once said "Trash emptied" while items in folders this
 * device can't change stayed behind, unsaid, and while folders it couldn't open weren't listed.
 */
describe('emptying the family folders’ Trash', () => {
    test('an item in a folder this device can’t change is never asked for, and is said to stay', () => {
        const writable = file(true);
        const locked = file(false);
        const plan = emptyPlan([writable, locked]);
        expect(plan.purge).toEqual([writable]);
        expect(plan).toMatchObject({ goes: 1, stays: 1, folders: false, keysChanged: false });
        expect(emptyConfirmText(plan)).toBe(
            '1 item in the family folders’ Trash is deleted for good, for everyone in the family. 1 item in folders this device can’t change stays. This can’t be undone.',
        );
        expect(staysLine(plan)).toBe(
            'Items in folders this device can’t change stay until they’re deleted from a device that can, or after 30 days.',
        );
    });

    test('a folder whose keys changed points to Check again, which this device can do', () => {
        const plan = emptyPlan([file(true), keysChanged()]);
        expect(plan.keysChanged).toBe(true);
        expect(emptyConfirmText(plan)).toContain(
            'If a folder’s keys changed, use Check again on that folder.',
        );
        expect(staysLine(plan)).toBe(
            'Items in folders this device can’t change stay until they’re deleted from a device that can, or after 30 days. If a folder’s keys changed, use Check again on that folder.',
        );
        expect(emptyResult({ asked: 1, failed: 0, stays: 1, keysChanged: true }).description).toBe(
            '1 item in folders this device can’t change is still there. If a folder’s keys changed, use Check again on that folder.',
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
        expect(staysLine(plan)).toBeNull();
    });

    test('family folders this device couldn’t open: never “all”, never “Trash emptied”', () => {
        const plan = emptyPlan([file(true)], { unopened: true });
        expect(emptyConfirmText(plan)).not.toContain('All ');
        expect(emptyConfirmText(plan)).toContain(
            'Anything in the Trash of family folders this device couldn’t open stays too.',
        );
        expect(staysLine(plan)).toBe(
            'Some family folders couldn’t be opened on this device, so their Trash isn’t shown here.',
        );
        // Even with nothing listed at all, the page explains rather than calling it empty.
        expect(staysLine(emptyPlan([], { unopened: true }))).not.toBeNull();
        const result = emptyResult({ asked: 1, failed: 0, stays: 0, unopened: true });
        expect(result.title).not.toBe('Trash emptied');
        expect(result).toMatchObject({
            type: 'warning',
            description:
                'Some family folders couldn’t be opened on this device; anything in their Trash is still there.',
        });
    });

    test('“Trash emptied” only when nothing is left, and a failure still says what stays', () => {
        expect(emptyResult({ asked: 2, failed: 0, stays: 0 })).toMatchObject({
            type: 'success',
            title: 'Trash emptied',
        });
        const partial = emptyResult({ asked: 1, failed: 0, stays: 1 });
        expect(partial).toMatchObject({
            type: 'warning',
            title: 'Some items are still in the Trash',
            description: '1 item in folders this device can’t change is still there.',
        });
        expect(emptyResult({ asked: 3, failed: 1, stays: 2 })).toMatchObject({
            type: 'error',
            description:
                '1 of 3 items couldn’t be deleted. Try again. 2 items in folders this device can’t change are still there.',
        });
    });
});
