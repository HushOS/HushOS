import { describe, expect, test } from 'vitest';
import {
    DEMO_START,
    foldersDemo,
    NAME_MAX,
    type DemoAction,
    type DemoState,
} from './folders-demo-state';

const run = (...actions: DemoAction[]) =>
    actions.reduce<DemoState>((state, action) => foldersDemo(state, action), DEMO_START);
const names = (state: DemoState) => state.folders.map((folder) => folder.name);

describe('the family folders demo', () => {
    test('opens a folder and comes back to the list', () => {
        const open = run({ type: 'open', id: 'household' });
        expect(open.view).toEqual({ kind: 'folder', id: 'household' });
        expect(foldersDemo(open, { type: 'back' }).view).toEqual({ kind: 'folders' });
    });

    test('a folder that isn’t there opens nothing', () => {
        expect(run({ type: 'open', id: 'holidays' })).toBe(DEMO_START);
    });

    test('Members is a view of its own, and back leads to the folders', () => {
        const members = run({ type: 'open', id: 'family' }, { type: 'members' });
        expect(members.view).toEqual({ kind: 'members' });
        expect(foldersDemo(members, { type: 'back' }).view).toEqual({ kind: 'folders' });
    });

    test('New family folder adds the trimmed name in order, empty, and closes', () => {
        const made = run(
            { type: 'new' },
            { type: 'name', value: '  Garden   plans ' },
            { type: 'create' },
        );
        expect(names(made)).toEqual(['Family', 'Garden plans', 'Household']);
        expect(made.folders.find((folder) => folder.name === 'Garden plans')?.files).toEqual([]);
        expect(made.naming).toBeNull();
    });

    test('a blank name creates nothing and keeps the dialog open', () => {
        const blank = run({ type: 'new' }, { type: 'name', value: '   ' }, { type: 'create' });
        expect(names(blank)).toEqual(['Family', 'Household']);
        expect(blank.naming).toBe('   ');
    });

    test('Escape cancels without adding, and typing with the dialog shut changes nothing', () => {
        const cancelled = run(
            { type: 'new' },
            { type: 'name', value: 'Taxes' },
            { type: 'cancel' },
        );
        expect(names(cancelled)).toEqual(['Family', 'Household']);
        expect(cancelled.naming).toBeNull();
        expect(foldersDemo(cancelled, { type: 'name', value: 'x' })).toBe(cancelled);
        expect(foldersDemo(cancelled, { type: 'create' })).toBe(cancelled);
    });

    test('two folders may share a name and still open apart', () => {
        const twice = run({ type: 'new' }, { type: 'name', value: 'Family' }, { type: 'create' });
        const ids = twice.folders.filter((folder) => folder.name === 'Family').map((f) => f.id);
        expect(ids).toHaveLength(2);
        expect(new Set(ids).size).toBe(2);
        const second = ids.find((id) => id !== 'family')!;
        const opened = foldersDemo(twice, { type: 'open', id: second });
        expect(opened.view).toEqual({ kind: 'folder', id: second });
    });

    test('a name stops at the most the app takes', () => {
        const long = run({ type: 'new' }, { type: 'name', value: 'a'.repeat(NAME_MAX + 20) });
        expect(long.naming).toHaveLength(NAME_MAX);
    });
});
