import { TRASH_RETENTION_DAYS } from '@hushos/drive/protocol';

/*
 * What Empty Trash does on the family folders' tab, and how it is said (components/families/
 * family-trash.tsx). Pure, so the counts and the words are tested without a family.
 *
 * Only items in folders this device may write are asked for. That rule is the page's alone:
 * the server checks only that the person is in the family, and the client's purge doesn't
 * check the folder's write state, so the page must not ask for the rest. An item whose
 * folder is in the Trash too goes with that folder, so only the folder is asked for.
 */
export type EmptyRow = {
    /* The family folder it is in may be written from this device. */
    writable: boolean;
    /*
     * Why it may not, when it may not: `keys-changed` this device can fix with Check again on
     * the folder; `read-only`, its keys couldn't be checked here at all.
     */
    reason?: 'keys-changed' | 'read-only';
    /* Its folder is in the Trash too: it goes when that folder goes. */
    parentTrashed: boolean;
    kind: 'file' | 'folder';
    /* Its own id and the ids of the folders above it, to count what goes with a folder. */
    id?: string;
    ancestorIds?: readonly string[];
};

export type EmptyPlan<T extends EmptyRow> = {
    /* What Empty Trash asks the server to delete. */
    purge: T[];
    /* Every listed item that goes: what is asked for, and what is inside the folders asked for. */
    going: T[];
    /* What goes, with what is inside the folders asked for. */
    goes: number;
    /* What stays: items in folders this device can't change. */
    stays: number;
    /* Some of what stays is in a folder whose keys changed: Check again may let it go. */
    keysChanged: boolean;
    /* A folder is among what goes, so what is inside it goes too. */
    folders: boolean;
    /* Family folders this device couldn't open: their Trash isn't listed, so isn't counted. */
    unopened: boolean;
};

export function emptyPlan<T extends EmptyRow>(
    rows: readonly T[],
    options: { unopened?: boolean } = {},
): EmptyPlan<T> {
    const goes = rows.filter((row) => row.writable);
    return {
        purge: goes.filter((row) => !row.parentTrashed),
        going: goes,
        goes: goes.length,
        stays: rows.length - goes.length,
        keysChanged: rows.some((row) => !row.writable && row.reason === 'keys-changed'),
        folders: goes.some((row) => row.kind === 'folder' && !row.parentTrashed),
        unopened: options.unopened ?? false,
    };
}

/*
 * How many listed items a set of purge requests covers: each one asked for, and every listed item
 * inside it. Counts in the confirm's own unit (items listed), so "2 of 3" means the same in the
 * confirm, the progress and the result, and a failed folder counts what stayed with it.
 */
export function itemsCovered(going: readonly EmptyRow[], ids: ReadonlySet<string>) {
    return going.filter(
        (row) =>
            (row.id !== undefined && ids.has(row.id)) ||
            (row.ancestorIds ?? []).some((ancestor) => ids.has(ancestor)),
    ).length;
}

const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

const CHECK_AGAIN = 'If a folder’s keys changed, use Check again on that folder.';
const UNOPENED =
    'Some family folders couldn’t be opened on this device, so their Trash isn’t shown here.';

/*
 * The line under the list, while it holds items this device can't change or misses folders it
 * couldn't open: why those rows have no actions, and why Empty Trash leaves them. Null when
 * there is nothing to explain.
 */
export function staysLine(plan: Pick<EmptyPlan<EmptyRow>, 'stays' | 'keysChanged' | 'unopened'>) {
    const parts = [
        plan.stays > 0
            ? `Items in folders this device can’t change stay until they’re deleted from a device that can, or after ${TRASH_RETENTION_DAYS} days.`
            : null,
        plan.stays > 0 && plan.keysChanged ? CHECK_AGAIN : null,
        plan.unopened ? UNOPENED : null,
    ].filter(Boolean);
    return parts.length ? parts.join(' ') : null;
}

/* The confirm's sentence: what goes, for whom, what goes with a folder, and what stays. */
export function emptyConfirmText(
    plan: Pick<EmptyPlan<EmptyRow>, 'goes' | 'stays' | 'folders' | 'keysChanged' | 'unopened'>,
) {
    const all = plan.stays === 0 && !plan.unopened ? 'All ' : '';
    return [
        `${all}${items(plan.goes)} in the family folders’ Trash ${plan.goes === 1 ? 'is' : 'are'} deleted for good, for everyone in the family.`,
        plan.folders ? 'What’s inside a folder goes with it.' : null,
        plan.stays > 0
            ? `${items(plan.stays)} in folders this device can’t change ${plan.stays === 1 ? 'stays' : 'stay'}.`
            : null,
        plan.stays > 0 && plan.keysChanged ? CHECK_AGAIN : null,
        plan.unopened
            ? 'Anything in the Trash of family folders this device couldn’t open stays too.'
            : null,
        'This can’t be undone.',
    ]
        .filter(Boolean)
        .join(' ');
}

/*
 * What is said once it has run: "Trash emptied" only when nothing can be left, so never while
 * some family folders couldn't be opened here. A deletion that failed is an error, and what
 * stays is said beside it; what stays on its own is a plain warning.
 */
export function emptyResult(outcome: {
    asked: number;
    failed: number;
    stays: number;
    keysChanged?: boolean;
    unopened?: boolean;
}) {
    const left = [
        outcome.stays > 0
            ? `${items(outcome.stays)} in folders this device can’t change ${outcome.stays === 1 ? 'is' : 'are'} still there.`
            : null,
        outcome.stays > 0 && outcome.keysChanged ? CHECK_AGAIN : null,
        outcome.unopened
            ? 'Some family folders couldn’t be opened on this device; anything in their Trash is still there.'
            : null,
    ].filter(Boolean);
    if (outcome.failed > 0)
        return {
            type: 'error' as const,
            title: 'The Trash couldn’t be emptied',
            description: [
                `${outcome.failed} of ${items(outcome.asked)} couldn’t be deleted. Try again.`,
                ...left,
            ].join(' '),
        };
    if (left.length)
        return {
            type: 'warning' as const,
            title: 'Some items are still in the Trash',
            description: left.join(' '),
        };
    return { type: 'success' as const, title: 'Trash emptied', description: undefined };
}
