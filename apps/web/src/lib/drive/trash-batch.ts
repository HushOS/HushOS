import type { DriveNode } from '@hushos/drive/client';
import {
    DriveApiError,
    type PurgeBatchItem,
    type PurgeRefusal,
    type RestoreBatchItem,
    type RestoreRefusal,
    type TrashBatchItem,
    type TrashRefusal,
} from '@hushos/drive/api';
import { MAX_TRASH_BATCH } from '@hushos/drive/protocol';

/*
 * Moving a selection to the trash, Undo putting it back, and deleting Trash
 * rows forever. The Drive client calls come in as `TrashParts`, so the rules
 * here (what is sent, what counts as moved or gone, what Undo puts back) are
 * tested without a server or a worker.
 */

export type TrashParts = {
    /*
     * One request: these items, all in one workspace and at most MAX_TRASH_BATCH,
     * to the trash or back (api.ts trashBatch, restoreBatch). The server answers
     * for each; it throws only when the request as a whole fails.
     */
    trash: (workspaceId: string, nodeIds: string[]) => Promise<{ results: TrashBatchItem[] }>;
    restore: (workspaceId: string, nodeIds: string[]) => Promise<{ results: RestoreBatchItem[] }>;
    /* Delete forever (api.ts purgeBatch). */
    purge: (workspaceId: string, nodeIds: string[]) => Promise<{ results: PurgeBatchItem[] }>;
    /* The folders an item sits in, as far as this device knows; any order. */
    ancestorsOf: (node: DriveNode) => { id: string }[];
    /* Waits before a request is sent again (purgeBatch); a timer unless tests say otherwise. */
    pause?: (ms: number) => Promise<void>;
};

/* How long a delete waits before it asks once more after the workspace was busy (409). */
export const PURGE_RETRY_MS = 1_000;

type Item = TrashBatchItem | RestoreBatchItem | PurgeBatchItem;
/* What the server said about one item: its answer, or why there is none (`error`). */
type Answer<T extends Item> = { node: DriveNode; item: T | null; error: unknown };

const REFUSAL_CODES: Record<TrashRefusal | RestoreRefusal | PurgeRefusal, DriveApiError['code']> = {
    'not-found': 'not-found',
    forbidden: 'forbidden',
    root: 'invalid',
    trashed: 'trashed',
    'not-trashed': 'conflict',
    removed: 'forbidden',
    'parent-trashed': 'parent-trashed',
    busy: 'conflict',
};

/*
 * Sends the items through `send`: one request per workspace for up to
 * MAX_TRASH_BATCH of them, a larger selection in several, one after another
 * (the server takes each under the workspace's lock, so more at once would
 * only queue there). `onLanded` hears each request's answers as it lands.
 * Every item is tried: a request that fails as a whole fails only its own
 * items, with its error, and an item the server refused, or left out of its
 * answer, carries the error that says why. This is the one place that decides
 * how a batch reaches the server. Answers keep the order given.
 */
async function sendEach<T extends Item>(
    nodes: DriveNode[],
    send: (workspaceId: string, nodeIds: string[]) => Promise<{ results: T[] }>,
    onLanded: (landed: Answer<T>[]) => void,
) {
    const answers: Answer<T>[] = nodes.map((node) => ({ node, item: null, error: null }));
    const byWorkspace = new Map<string, number[]>();
    for (const [index, node] of nodes.entries())
        byWorkspace.set(node.workspaceId, [...(byWorkspace.get(node.workspaceId) ?? []), index]);
    for (const [workspaceId, indexes] of byWorkspace)
        for (let start = 0; start < indexes.length; start += MAX_TRASH_BATCH) {
            const chunk = indexes.slice(start, start + MAX_TRASH_BATCH).map((i) => answers[i]!);
            try {
                const { results } = await send(
                    workspaceId,
                    chunk.map(({ node }) => node.id),
                );
                const byId = new Map(results.map((item) => [item.id, item]));
                for (const answer of chunk) {
                    const item = byId.get(answer.node.id) ?? null;
                    answer.item = item;
                    if (!item)
                        answer.error = new DriveApiError(
                            'The server didn’t say what happened to this item.',
                            'unavailable',
                            502,
                        );
                    else if (item.status === 'refused')
                        answer.error = new DriveApiError(
                            item.message,
                            REFUSAL_CODES[item.reason],
                            409,
                        );
                }
            } catch (cause) {
                for (const answer of chunk) answer.error = cause;
            }
            onLanded(chunk);
        }
    return answers;
}

const firstError = (answers: Answer<Item>[]) =>
    answers.find((answer) => answer.error !== null)?.error ?? null;

/*
 * A selection as this device knows it: `roots`, the items inside no other
 * selected item, which are all that is sent; and `wentWith`, every selected
 * item that went once these ids did, itself or inside one of them.
 */
function nesting(nodes: DriveNode[], parts: TrashParts) {
    const picked = new Set(nodes.map((node) => node.id));
    /* The selected folders each item sits in. */
    const within = new Map(
        nodes.map((node) => {
            const chain = new Set(parts.ancestorsOf(node).map((ancestor) => ancestor.id));
            if (node.parentId) chain.add(node.parentId);
            return [node.id, [...chain].filter((id) => picked.has(id))];
        }),
    );
    return {
        roots: nodes.filter((node) => !within.get(node.id)!.length),
        wentWith: (wentIds: Set<string>) =>
            nodes
                .filter(
                    (node) =>
                        wentIds.has(node.id) || within.get(node.id)!.some((id) => wentIds.has(id)),
                )
                .map((node) => node.id),
    };
}

/*
 * Moves items to the trash. An item inside a folder that is also going, as far
 * as this device knows, is never sent: trashed as well, it would either be
 * refused as already in the trash or come back on Undo without its folder. It
 * goes with its folder, or stays where it is if the folder is refused. The
 * server does the same for what this device does not know (`covered`).
 *
 * `moved` is what reached the trash itself, in the order given, and is exactly
 * what Undo puts back. `gone` is every selected item now in the trash, those
 * inside a folder that went included: what "N of M" counts, and the whole
 * selection went when it holds every item. `error` is the first refusal.
 * `onMoved` hears the same ids as they land.
 */
export async function trashBatch(
    nodes: DriveNode[],
    parts: TrashParts,
    onMoved?: (ids: string[]) => void,
) {
    const { roots, wentWith } = nesting(nodes, parts);
    const went = (answers: Answer<TrashBatchItem>[]) =>
        new Set(
            answers
                .filter(({ item }) => item?.status === 'trashed' || item?.status === 'covered')
                .map(({ node }) => node.id),
        );
    const answers = await sendEach(roots, parts.trash, (landed) => {
        const ids = wentWith(went(landed));
        if (ids.length) onMoved?.(ids);
    });
    const moved = answers.flatMap(({ node, item }) =>
        item?.status === 'trashed'
            ? [{ ...node, trashedAt: item.trashedAt, changeSeq: item.changeSeq }]
            : [],
    );
    return {
        moved,
        gone: wentWith(went(answers)),
        error: firstError(answers),
    };
}

/*
 * Undo for trashBatch: puts back what it moved. Those can sit inside one
 * another when this device did not know it at trash time, and a selection over
 * MAX_TRASH_BATCH goes in several requests: the server waits for a folder in
 * the same request, but not for one in a later request. So folders go first,
 * as far as this device knows, and an item refused as `parent-trashed` is tried
 * again once the other requests have landed, for as long as that brings more
 * back. `back` is what came back, in the order given; `failed` each that did
 * not, with why; `error` the first refusal that stands. `onBack` hears them as
 * they land.
 */
export async function restoreBatch(
    nodes: DriveNode[],
    parts: TrashParts,
    onBack?: (back: DriveNode[]) => void,
) {
    const back = (answers: Answer<RestoreBatchItem>[]) =>
        answers.flatMap(({ node, item }) =>
            item?.status === 'restored'
                ? [{ ...node, trashedAt: null, changeSeq: item.changeSeq }]
                : [],
        );
    const tell = (landed: Answer<RestoreBatchItem>[]) => {
        const returned = back(landed);
        if (returned.length) onBack?.(returned);
    };
    // Folders before what is in them: by how many of the others each sits inside.
    const given = new Set(nodes.map((node) => node.id));
    const inside = (node: DriveNode) =>
        new Set(
            [...parts.ancestorsOf(node).map((ancestor) => ancestor.id), node.parentId].filter(
                (id): id is string => id !== null && id !== undefined && given.has(id),
            ),
        ).size;
    const depth = new Map(nodes.map((node) => [node.id, inside(node)]));
    const ordered = [...nodes].sort((a, b) => depth.get(a.id)! - depth.get(b.id)!);
    const latest = new Map(
        (await sendEach(ordered, parts.restore, tell)).map((answer) => [answer.node.id, answer]),
    );
    for (;;) {
        const waited = [...latest.values()].filter(
            ({ item }) => item?.status === 'refused' && item.reason === 'parent-trashed',
        );
        if (!waited.length) break;
        const again = await sendEach(
            waited.map(({ node }) => node),
            parts.restore,
            tell,
        );
        for (const answer of again) latest.set(answer.node.id, answer);
        if (!again.some(({ item }) => item?.status === 'restored')) break;
    }
    const answers = nodes.map((node) => latest.get(node.id)!);
    return {
        back: back(answers),
        failed: answers.flatMap(({ node, item, error }) =>
            item?.status === 'restored' ? [] : [{ node, error }],
        ),
        error: firstError(answers),
    };
}

/*
 * Delete forever for Trash rows. An item inside a folder that is also going,
 * as far as this device knows, is never sent: purged with the folder it goes
 * with it, and asked for on its own it would be refused as gone. It stays if
 * the folder is refused. The server does the same for what this device does
 * not know (`covered`). `gone` is every picked item now deleted, those inside
 * a purged folder included, in the order given: what "N of M" counts. What a
 * request had no time for (`busy`) is sent again while that gets further.
 * A row the server no longer has (`not-found`: deleted from another tab, or
 * by a request whose answer never arrived) is gone too, not a failure. A
 * request turned away whole because the workspace was busy (409: another
 * write held its lock) is sent once more after PURGE_RETRY_MS. Too many
 * requests (429) is not: its window runs a minute from the first, so a
 * second later would be turned away again. `error` is the first refusal that
 * stands. `onGone` hears the same ids as each request lands.
 */
export async function purgeBatch(
    nodes: DriveNode[],
    parts: TrashParts,
    onGone?: (ids: string[]) => void,
) {
    const { roots, wentWith } = nesting(nodes, parts);
    const isGone = (item: PurgeBatchItem | null) =>
        item?.status === 'purged' ||
        item?.status === 'covered' ||
        (item?.status === 'refused' && item.reason === 'not-found');
    const went = (answers: Answer<PurgeBatchItem>[]) =>
        new Set(answers.filter(({ item }) => isGone(item)).map(({ node }) => node.id));
    const pause =
        parts.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const send: TrashParts['purge'] = async (workspaceId, nodeIds) => {
        try {
            return await parts.purge(workspaceId, nodeIds);
        } catch (error) {
            const busy = error instanceof DriveApiError && error.status === 409;
            if (!busy) throw error;
            await pause(PURGE_RETRY_MS);
            return parts.purge(workspaceId, nodeIds);
        }
    };
    const tell = (landed: Answer<PurgeBatchItem>[]) => {
        const ids = wentWith(went(landed));
        if (ids.length) onGone?.(ids);
    };
    const latest = new Map(
        (await sendEach(roots, send, tell)).map((answer) => [answer.node.id, answer]),
    );
    // What a request had no time for is sent again, for as long as that gets further.
    for (;;) {
        const waited = [...latest.values()].filter(
            ({ item }) => item?.status === 'refused' && item.reason === 'busy',
        );
        if (!waited.length) break;
        const again = await sendEach(
            waited.map(({ node }) => node),
            send,
            tell,
        );
        for (const answer of again) latest.set(answer.node.id, answer);
        if (!again.some(({ item }) => item?.status === 'purged')) break;
    }
    const answers = roots.map((node) => latest.get(node.id)!);
    return {
        gone: wentWith(went(answers)),
        error: firstError(answers.filter(({ item }) => !isGone(item))),
    };
}
