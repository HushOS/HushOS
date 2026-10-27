/*
 * What Empty Trash does on the family folders' tab, and how it is said (components/families/
 * family-trash.tsx). Pure, so the counts and the words are tested without a family.
 *
 * Only items in folders this device may write go (the worker refuses the rest anyway). An item
 * whose folder is in the Trash too goes with that folder, so only the folder is asked for.
 */
export type EmptyRow = {
    /* The family folder it is in may be written from this device. */
    writable: boolean;
    /* Its folder is in the Trash too: it goes when that folder goes. */
    parentTrashed: boolean;
    kind: 'file' | 'folder';
};

export type EmptyPlan<T extends EmptyRow> = {
    /* What Empty Trash asks the server to delete. */
    purge: T[];
    /* What goes, with what is inside the folders asked for. */
    goes: number;
    /* What stays: items in folders this device can't change. */
    stays: number;
    /* A folder is among what goes, so what is inside it goes too. */
    folders: boolean;
};

export function emptyPlan<T extends EmptyRow>(rows: readonly T[]): EmptyPlan<T> {
    const goes = rows.filter((row) => row.writable);
    return {
        purge: goes.filter((row) => !row.parentTrashed),
        goes: goes.length,
        stays: rows.length - goes.length,
        folders: goes.some((row) => row.kind === 'folder' && !row.parentTrashed),
    };
}

const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

/* The confirm's sentence: what goes, for whom, what goes with a folder, and what stays. */
export function emptyConfirmText(plan: Pick<EmptyPlan<EmptyRow>, 'goes' | 'stays' | 'folders'>) {
    const all = plan.stays === 0 ? 'All ' : '';
    return [
        `${all}${items(plan.goes)} in the family folders’ Trash ${plan.goes === 1 ? 'is' : 'are'} deleted for good, for everyone in the family.`,
        plan.folders ? 'What’s inside a folder goes with it.' : null,
        plan.stays > 0
            ? `${items(plan.stays)} in folders you can’t change ${plan.stays === 1 ? 'stays' : 'stay'}.`
            : null,
        'This can’t be undone.',
    ]
        .filter(Boolean)
        .join(' ');
}

/*
 * What is said once it has run: "Trash emptied" only when nothing is left. Items left because
 * this device can't change their folder are said plainly; a deletion that failed is an error.
 */
export function emptyResult(outcome: { asked: number; failed: number; stays: number }) {
    if (outcome.failed > 0)
        return {
            type: 'error' as const,
            title: 'The Trash couldn’t be emptied',
            description: `${outcome.failed} of ${items(outcome.asked)} ${outcome.failed === 1 ? 'is' : 'are'} still there. Try again.`,
        };
    if (outcome.stays > 0)
        return {
            type: 'warning' as const,
            title: 'Some items are still in the Trash',
            description: `${items(outcome.stays)} in folders you can’t change ${outcome.stays === 1 ? 'is' : 'are'} still there.`,
        };
    return { type: 'success' as const, title: 'Trash emptied', description: undefined };
}
