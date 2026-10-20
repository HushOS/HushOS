import type { DriveNode } from '@hushos/drive/client';
import {
    DriveApiError,
    type RestoreBatchItem,
    type RestoreRefusal,
    type TrashBatchItem,
    type TrashRefusal,
} from '@hushos/drive/api';
import { MAX_TRASH_BATCH } from '@hushos/drive/protocol';

/*
 * Moving a selection to the trash and Undo putting it back. The Drive client
 * calls come in as `TrashParts`, so the rules here (what is sent, what counts as
 * moved, what Undo puts back) are tested without a server or a worker.
 */

export type TrashParts = {
    /*
     * One request: these items, all in one workspace and at most MAX_TRASH_BATCH,
     * to the trash or back (api.ts trashBatch, restoreBatch). The server answers
     * for each; it throws only when the request as a whole fails.
     */
    trash: (workspaceId: string, nodeIds: string[]) => Promise<{ results: TrashBatchItem[] }>;
    restore: (workspaceId: string, nodeIds: string[]) => Promise<{ results: RestoreBatchItem[] }>;
    /* The folders an item sits in, as far as this device knows; any order. */
    ancestorsOf: (node: DriveNode) => { id: string }[];
};

type Item = TrashBatchItem | RestoreBatchItem;
/* What the server said about one item: its answer, or why there is none (`error`). */
type Answer<T extends Item> = { node: DriveNode; item: T | null; error: unknown };

const REFUSAL_CODES: Record<TrashRefusal | RestoreRefusal, DriveApiError['code']> = {
    'not-found': 'not-found',
    forbidden: 'forbidden',
    root: 'invalid',
    trashed: 'trashed',
    'not-trashed': 'conflict',
    removed: 'forbidden',
    'parent-trashed': 'parent-trashed',
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
    const going = new Set(nodes.map((node) => node.id));
    /* The selected folders each item sits in. */
    const within = new Map(
        nodes.map((node) => {
            const chain = new Set(parts.ancestorsOf(node).map((ancestor) => ancestor.id));
            if (node.parentId) chain.add(node.parentId);
            return [node.id, [...chain].filter((id) => going.has(id))];
        }),
    );
    const roots = nodes.filter((node) => !within.get(node.id)!.length);
    const wentWith = (movedIds: Set<string>) =>
        nodes
            .filter(
                (node) =>
                    movedIds.has(node.id) || within.get(node.id)!.some((id) => movedIds.has(id)),
            )
            .map((node) => node.id);
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
 * Undo for trashBatch: puts back what it moved. None of those sits inside
 * another (only the outermost are sent), and the server would wait for a
 * folder in the same request anyway. `back` is what came back, in the order
 * given; `error` the first refusal. `onBack` hears them as they land.
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
    const answers = await sendEach(nodes, parts.restore, (landed) => {
        const returned = back(landed);
        if (returned.length) onBack?.(returned);
    });
    return { back: back(answers), error: firstError(answers) };
}
