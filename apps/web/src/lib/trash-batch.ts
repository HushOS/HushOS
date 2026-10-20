import type { DriveNode } from '@hushos/drive/client';

/*
 * Moving a selection to the trash and Undo putting it back. The Drive client
 * calls come in as `TrashParts`, so the rules here (what is sent, what counts as
 * moved, what Undo puts back) are tested without a server or a worker.
 */

export type TrashParts = {
    /* One item to the trash, or back; throws when the server refuses it. */
    trash: (node: DriveNode) => Promise<DriveNode>;
    restore: (node: DriveNode) => Promise<DriveNode>;
    /* The folders an item sits in, as far as this device knows; any order. */
    ancestorsOf: (node: DriveNode) => { id: string }[];
};

/*
 * How many items go to or come back from the trash at once. The server takes
 * them one at a time under the workspace's lock (nextChangeSeq), so more at
 * once only hides the round trips between them. Each waiting request holds one
 * of the server process's pooled database connections (ten by default) while
 * it queues for the lock, so this stays small: at a 180 ms round trip, six
 * moved 100 items in 4.4 s where four took 7.9 s.
 */
export const AT_ONCE = 6;

type Landed = { node: DriveNode; result: DriveNode }[];

/* At most once a frame: each telling redraws a whole list. Without frames (a hidden tab, tests), at the end. */
function frames(tell: () => void) {
    let frame = 0;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
    return {
        soon() {
            if (raf && !frame)
                frame = raf(() => {
                    frame = 0;
                    tell();
                });
        },
        now() {
            if (frame) cancelAnimationFrame(frame);
            frame = 0;
            tell();
        },
    };
}

/*
 * Sends each item through `send`, a few at a time. Every item is tried, so one
 * refusal leaves no others behind. `results` keeps the order given, undefined
 * where the server refused; `error` is the first refusal. This is the one place
 * that decides how a batch reaches the server: a batch endpoint replaces this
 * function and nothing else.
 */
async function sendEach(
    nodes: DriveNode[],
    send: (node: DriveNode) => Promise<DriveNode>,
    onLanded: (landed: Landed) => void,
) {
    const results: (DriveNode | undefined)[] = Array.from({ length: nodes.length });
    let error: unknown = null;
    let next = 0;
    let landed: Landed = [];
    const telling = frames(() => {
        const batch = landed;
        landed = [];
        if (batch.length) onLanded(batch);
    });
    const lane = async () => {
        while (next < nodes.length) {
            const index = next++;
            const node = nodes[index]!;
            let result: DriveNode;
            try {
                result = await send(node);
            } catch (cause) {
                error ??= cause;
                continue;
            }
            results[index] = result;
            landed.push({ node, result });
            telling.soon();
        }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, nodes.length) }, lane));
    telling.now();
    return { results, error };
}

/*
 * Moves items to the trash. An item inside a folder that is also going is never
 * sent on its own: trashed as well, it would either be refused as already in the
 * trash or come back on Undo without its folder. It goes with its folder, or
 * stays where it is if the folder is refused.
 *
 * `moved` is what reached the trash, in the order given, and is exactly what
 * Undo puts back. `tried` is how many were sent. `gone` is every selected item
 * now in the trash, those inside moved folders included: what "N of M" counts.
 * `error` is the first refusal. `onMoved` hears the same ids as they land.
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
    const { results, error } = await sendEach(roots, parts.trash, (landed) =>
        onMoved?.(wentWith(new Set(landed.map(({ node }) => node.id)))),
    );
    const moved = results.filter((node) => node !== undefined);
    return {
        moved,
        tried: roots.length,
        gone: wentWith(new Set(moved.map((node) => node.id))),
        error,
    };
}

/*
 * Undo for trashBatch: puts back what it moved. None of those sits inside
 * another (only the outermost are sent), so the order they land in does not
 * matter. `back` is what came back, in the order given; `error` the first
 * refusal. `onBack` hears them as they land.
 */
export async function restoreBatch(
    nodes: DriveNode[],
    parts: TrashParts,
    onBack?: (back: DriveNode[]) => void,
) {
    const { results, error } = await sendEach(nodes, parts.restore, (landed) =>
        onBack?.(landed.map(({ result }) => result)),
    );
    return { back: results.filter((node) => node !== undefined), error };
}
