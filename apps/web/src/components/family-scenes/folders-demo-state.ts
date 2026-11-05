/*
 * The family plans post's folders demo, apart from its screen: which view shows (the family's
 * folders, one folder, or its members), the folders and their files, and New family folder's name
 * while it's being typed. Local only: nothing is saved or sent. The folders and files are the
 * site's demo account's (e2e/screenshots.spec.ts), so the post and the pictures tell one story.
 */

/* Two folders may share a name, as in the app, so each has an id of its own. */
export type DemoFolder = { id: string; name: string; files: readonly string[] };

export type DemoView = { kind: 'folders' } | { kind: 'folder'; id: string } | { kind: 'members' };

export type DemoState = {
    view: DemoView;
    folders: readonly DemoFolder[];
    /* New family folder's name while its dialog is open; null when it's closed. */
    naming: string | null;
};

export type DemoAction =
    | { type: 'open'; id: string }
    | { type: 'members' }
    | { type: 'back' }
    | { type: 'new' }
    | { type: 'name'; value: string }
    | { type: 'create' }
    | { type: 'cancel' };

/* The most a folder's name takes in the demo, as the app's own name fields allow. */
export const NAME_MAX = 100;

export const DEMO_START: DemoState = {
    view: { kind: 'folders' },
    folders: [
        { id: 'family', name: 'Family', files: ['Birthdays.md', 'Summer 2027 ideas.md'] },
        {
            id: 'household',
            name: 'Household',
            files: ['Home insurance.pdf', 'Meal plan.md', 'Utilities 2026.csv'],
        },
    ],
    naming: null,
};

const byName = (a: DemoFolder, b: DemoFolder) =>
    a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' });

/* The name New family folder would create: trimmed, runs of spaces as one, or nothing. */
export function folderName(value: string) {
    return value.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);
}

export function foldersDemo(state: DemoState, action: DemoAction): DemoState {
    switch (action.type) {
        case 'open':
            return state.folders.some((folder) => folder.id === action.id)
                ? { ...state, view: { kind: 'folder', id: action.id }, naming: null }
                : state;
        case 'members':
            return { ...state, view: { kind: 'members' }, naming: null };
        case 'back':
            return { ...state, view: { kind: 'folders' } };
        case 'new':
            return { ...state, view: { kind: 'folders' }, naming: '' };
        case 'name':
            return state.naming === null
                ? state
                : { ...state, naming: action.value.slice(0, NAME_MAX) };
        case 'cancel':
            return { ...state, naming: null };
        case 'create': {
            if (state.naming === null) return state;
            const name = folderName(state.naming);
            if (!name) return state;
            return {
                ...state,
                naming: null,
                folders: [
                    ...state.folders,
                    { id: `new-${state.folders.length + 1}`, name, files: [] },
                ].sort(byName),
            };
        }
    }
}
