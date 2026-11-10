import type { Health } from './bounds';

/*
 * A store's share of one run of one worker job, and the stores served in turn
 * (docs/company-storage-design.md 2.4). The worker's loops are shared between
 * stores. A store that answers every call just inside its deadline trips no
 * breaker, and 200 rows of its own would otherwise hold a loop for hours, for
 * everyone.
 *
 * - A run groups its work by store and takes one item from each store in turn.
 * - A store may use `budgetMs` of wall time in one run. The budget is looked at
 *   before each item, never during one: an item that has started finishes under
 *   its own deadlines. What is left of the store's work is `deferred`, to the
 *   next run.
 * - A store whose breaker is open, or that is marked slow, is left alone for
 *   the rest of the run: its items are `avoided`.
 *
 * So one slow store delays the other stores' work in a run by at most its
 * budget and one item, however much it has waiting.
 */

/* The default share: `STORAGE_STORE_RUN_SECONDS`. */
export const STORE_RUN_MS = 60_000;

export type Shares = ReturnType<typeof createShares>;

export function createShares(options: {
    budgetMs: number;
    /* What the store's own breaker says; asked before every item. */
    health: (storeId: string) => Promise<Health> | Health;
    now?: () => number;
}) {
    const now = options.now ?? (() => performance.now());
    const used = new Map<string, number>();
    return {
        /* Whether work that calls every one of `storeIds` may start now, or why not. */
        async state(storeIds: string[]): Promise<'ok' | 'avoided' | 'deferred'> {
            for (const id of storeIds) if ((await options.health(id)) !== 'ok') return 'avoided';
            for (const id of storeIds)
                if ((used.get(id) ?? 0) >= options.budgetMs) return 'deferred';
            return 'ok';
        },
        /* Runs `work` and counts its wall time against each of `storeIds`, however it ends. */
        async spend<T>(storeIds: string[], work: () => Promise<T>): Promise<T> {
            const started = now();
            try {
                return await work();
            } finally {
                const took = now() - started;
                for (const id of storeIds) used.set(id, (used.get(id) ?? 0) + took);
            }
        },
    };
}

/*
 * Runs `work` over every group's items, one item from each group in turn, each
 * group in its own order. A group names the stores its items call; it stops for
 * this run when one of them is unhealthy or has used its share, and the count
 * of what it left is returned. `work` deals with its own failures.
 */
export async function inTurn<T>(
    groups: { stores: string[]; items: T[] }[],
    shares: Shares,
    work: (item: T) => Promise<void>,
) {
    const left = { avoided: 0, deferred: 0 };
    let waiting = groups
        .map((group) => ({ stores: group.stores, items: [...group.items] }))
        .filter((group) => group.items.length);
    while (waiting.length) {
        const next: typeof waiting = [];
        for (const group of waiting) {
            const state = await shares.state(group.stores);
            if (state !== 'ok') {
                left[state] += group.items.length;
                continue;
            }
            const item = group.items.shift()!;
            await shares.spend(group.stores, () => work(item));
            if (group.items.length) next.push(group);
        }
        waiting = next;
    }
    return left;
}

/* Rows grouped by the one store each calls, in the order they came. */
export function byStore<T>(rows: T[], storeOf: (row: T) => string) {
    const groups = new Map<string, T[]>();
    for (const row of rows) {
        const storeId = storeOf(row);
        const items = groups.get(storeId);
        if (items) items.push(row);
        else groups.set(storeId, [row]);
    }
    return [...groups].map(([storeId, items]) => ({ stores: [storeId], items }));
}

/*
 * Whether a run should be followed by another at once. A store that had used
 * its share of the run left work behind (`deferred`), and that work is not
 * late because anything is wrong: the share bounds how long one run can keep
 * the other stores waiting, not how fast a backlog drains. Work left because a
 * store is unwell (`avoided`), or that failed, waits for the schedule: sending
 * the job again would only ask the same store again.
 */
export function leftForNextRun(result: unknown) {
    const deferred = (result as { deferred?: unknown } | null | undefined)?.deferred;
    return typeof deferred === 'number' && deferred > 0;
}
