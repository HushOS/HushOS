import { describe, expect, test } from 'vitest';
import type { Health } from './bounds';
import { byStore, createShares, inTurn, leftForNextRun } from './turns';

/*
 * A store's share of a run, and stores served in turn
 * (docs/company-storage-design.md 2.4), with a clock that the work itself
 * moves: an item "takes" what the test says it takes.
 */

function run(options: { budgetMs?: number; health?: (storeId: string) => Health } = {}) {
    let at = 0;
    const done: { item: string; endedAt: number }[] = [];
    const shares = createShares({
        budgetMs: options.budgetMs ?? 60_000,
        health: options.health ?? (() => 'ok'),
        now: () => at,
    });
    /* An item is its name and how long its store takes over it. */
    const work = async ([item, ms]: [string, number]) => {
        at += ms;
        done.push({ item, endedAt: at });
    };
    const items = (store: string, count: number, ms: number): [string, number][] =>
        Array.from({ length: count }, (_, index) => [`${store}${index + 1}`, ms]);
    return { shares, work, items, done, names: () => done.map((entry) => entry.item) };
}

describe('stores served in turn', () => {
    test('one item from each store in turn, each store in its own order, until all are done', async () => {
        const { shares, work, items, names } = run();
        const left = await inTurn(
            [
                { stores: ['a'], items: items('a', 3, 10) },
                { stores: ['b'], items: items('b', 1, 10) },
                { stores: ['c'], items: items('c', 2, 10) },
            ],
            shares,
            work,
        );
        expect(names()).toEqual(['a1', 'b1', 'c1', 'a2', 'c2', 'a3']);
        expect(left).toEqual({ avoided: 0, deferred: 0 });
    });

    test('rows are grouped by the store each names, in the order they were listed', () => {
        const rows = [
            { id: 1, storeId: 'a' },
            { id: 2, storeId: 'b' },
            { id: 3, storeId: 'a' },
        ];
        expect(byStore(rows, (row) => row.storeId)).toEqual([
            { stores: ['a'], items: [rows[0], rows[2]] },
            { stores: ['b'], items: [rows[1]] },
        ]);
    });
});

describe('a store’s share of a run', () => {
    test('a store that answers every call at 59 seconds, with 200 rows waiting, delays another store by its share and one call, and no more', async () => {
        const { shares, work, items, done, names } = run({ budgetMs: 60_000 });
        const left = await inTurn(
            [
                { stores: ['slow'], items: items('slow', 200, 59_000) },
                { stores: ['well'], items: items('well', 10, 50) },
            ],
            shares,
            work,
        );
        // All of the other store's work was done in this run.
        expect(names().filter((name) => name.startsWith('well'))).toHaveLength(10);
        // The slow store got two calls: the second began inside its share and was let finish.
        expect(names().filter((name) => name.startsWith('slow'))).toEqual(['slow1', 'slow2']);
        expect(left).toEqual({ avoided: 0, deferred: 198 });
        // The bound section 15 pins: the share, one request's deadline, and the well store's own time.
        const lastWell = done.filter((entry) => entry.item.startsWith('well')).at(-1)!;
        expect(lastWell.endedAt).toBeLessThanOrEqual(60_000 + 60_000 + 10 * 50);
        // Without a share this run would have taken over three hours.
        expect(done.at(-1)!.endedAt).toBeLessThan(2 * 60_000 + 10 * 50);
    });

    test('is looked at before each item: one that began inside the share finishes, and none begins once it is used', async () => {
        const inside = run({ budgetMs: 60_000 });
        expect(
            await inTurn(
                [{ stores: ['a'], items: inside.items('a', 3, 59_999) }],
                inside.shares,
                inside.work,
            ),
        ).toEqual({ avoided: 0, deferred: 1 });
        const exact = run({ budgetMs: 60_000 });
        expect(
            await inTurn(
                [{ stores: ['a'], items: exact.items('a', 3, 60_000) }],
                exact.shares,
                exact.work,
            ),
        ).toEqual({ avoided: 0, deferred: 2 });
    });

    test('is each store’s own: one store using its share takes nothing from another’s', async () => {
        const { shares, work, items, names } = run({ budgetMs: 1_000 });
        const left = await inTurn(
            [
                { stores: ['a'], items: items('a', 5, 600) },
                { stores: ['b'], items: items('b', 5, 100) },
            ],
            shares,
            work,
        );
        expect(names()).toEqual(['a1', 'b1', 'a2', 'b2', 'b3', 'b4', 'b5']);
        expect(left).toEqual({ avoided: 0, deferred: 3 });
    });

    test('work that calls two stores counts against both, and a store two pairs share is spent by both', async () => {
        const { shares, work, items, names } = run({ budgetMs: 1_000 });
        const left = await inTurn(
            [
                { stores: ['region-a', 'backup'], items: items('a', 4, 400) },
                { stores: ['region-b', 'backup'], items: items('b', 4, 400) },
            ],
            shares,
            work,
        );
        // 400 ms each: the backup's second is used after a1, b1, a2; neither region used its own.
        expect(names()).toEqual(['a1', 'b1', 'a2']);
        expect(left).toEqual({ avoided: 0, deferred: 5 });
    });

    test('spans the phases of one run: time a store used in the first is gone in the second', async () => {
        const { shares, work, items } = run({ budgetMs: 1_000 });
        await inTurn([{ stores: ['a'], items: items('a', 2, 600) }], shares, work);
        expect(await inTurn([{ stores: ['a'], items: items('a', 3, 10) }], shares, work)).toEqual({
            avoided: 0,
            deferred: 3,
        });
    });
});

describe('a store that is unwell', () => {
    test('is not worked at all when its breaker is open or it is slow, and the others are', async () => {
        const health = (storeId: string): Health =>
            storeId === 'open' ? 'open' : storeId === 'slow' ? 'slow' : 'ok';
        const { shares, work, items, names } = run({ health });
        const left = await inTurn(
            [
                { stores: ['open'], items: items('open', 7, 10) },
                { stores: ['slow'], items: items('slow', 4, 10) },
                { stores: ['well'], items: items('well', 2, 10) },
            ],
            shares,
            work,
        );
        expect(names()).toEqual(['well1', 'well2']);
        expect(left).toEqual({ avoided: 11, deferred: 0 });
    });

    test('is asked before every item: a breaker that opens during the run stops the rest of that store’s work', async () => {
        let failing = false;
        const { shares, items, names, work } = run({
            health: (storeId) => (storeId === 'a' && failing ? 'open' : 'ok'),
        });
        const left = await inTurn(
            [
                { stores: ['a'], items: items('a', 10, 10) },
                { stores: ['b'], items: items('b', 4, 10) },
            ],
            shares,
            async (item) => {
                await work(item);
                if (item[0] === 'a3') failing = true;
            },
        );
        expect(names()).toEqual(['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'b4']);
        expect(left).toEqual({ avoided: 7, deferred: 0 });
    });

    test('counts as avoided, not deferred, when it is both unwell and out of its share', async () => {
        let slow = false;
        const { shares, items, work } = run({
            budgetMs: 100,
            health: () => (slow ? 'slow' : 'ok'),
        });
        const left = await inTurn(
            [{ stores: ['a'], items: items('a', 5, 200) }],
            shares,
            async (item) => {
                await work(item);
                slow = true;
            },
        );
        // Deferred work is run again at once; an unwell store's must wait.
        expect(left).toEqual({ avoided: 4, deferred: 0 });
    });
});

describe('a run that stopped at a share', () => {
    test('is followed by another at once, and one that left work for any other reason is not', async () => {
        const { shares, work, items } = run({ budgetMs: 100 });
        const cut = await inTurn([{ stores: ['a'], items: items('a', 3, 100) }], shares, work);
        expect(leftForNextRun({ copied: 1, ...cut })).toBe(true);

        const unwell = run({ health: () => 'open' });
        const avoided = await inTurn(
            [{ stores: ['a'], items: unwell.items('a', 3, 100) }],
            unwell.shares,
            unwell.work,
        );
        // Asking a store whose breaker is open again at once is what the breaker is there to stop.
        expect(leftForNextRun({ failed: 4, ...avoided })).toBe(false);
        expect(leftForNextRun({ failed: 9, deferred: 0 })).toBe(false);
        // Jobs that take no turns (the purge, the usage audit) report no such count.
        expect(leftForNextRun({ trash: 3 })).toBe(false);
        expect(leftForNextRun(undefined)).toBe(false);
        expect(leftForNextRun({ skipped: 'paused' })).toBe(false);
    });
});
