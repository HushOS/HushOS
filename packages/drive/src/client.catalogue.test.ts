import { afterEach, describe, expect, test } from 'vitest';
import type { ChangeFeed, DriveApi, NodeChange, NodeView } from './api';
import { createDriveClient, type Rpc } from './client';
import { createMemoryMirror, type TreeMirror } from './mirror';

/*
 * Recent, search and tags answer from the catalogue each tab keeps in memory,
 * filled from the change feed through the tree mirror every tab of the device
 * shares. What the feed says is gone must leave every tab's answers: a purged
 * folder with everything that was inside it, before the server's background
 * fan-out tombstones the contents, and a change another tab happened to pull
 * first.
 */

const WS = 'ws';

afterEach(() => {
    opening = null;
});

/* The server's side of the feed: state, not a log, as listChanges serves it. */
function server() {
    let seq = 0;
    /* The newest tombstone the server has since dropped (workspaces.tombstones_dropped_through). */
    let dropped = 0;
    const rows = new Map<string, { node: NodeView; purged: boolean }>();
    const api = {
        changes: async (_ws: string, since: number, limit = 200): Promise<ChangeFeed> => {
            const page = [...rows.values()]
                .filter((row) => row.node.changeSeq! > since)
                .sort((a, b) => a.node.changeSeq! - b.node.changeSeq!);
            const changes: NodeChange[] = page.slice(0, limit).map(({ node, purged }) =>
                purged
                    ? {
                          kind: 'tombstone',
                          changeSeq: node.changeSeq!,
                          nodeId: node.id,
                          parentId: node.parentId,
                      }
                    : { kind: 'node', changeSeq: node.changeSeq!, node },
            );
            return {
                changes,
                nextCursor: changes.at(-1)?.changeSeq ?? since,
                hasMore: page.length > limit,
                resync: since > 0 && since < dropped,
            };
        },
    } as unknown as DriveApi;
    function write(id: string, parentId: string | null, patch: Partial<NodeView> = {}) {
        const previous = rows.get(id)?.node;
        const node: NodeView = {
            id,
            workspaceId: WS,
            parentId,
            kind: 'file',
            keyEpoch: 1,
            parentKeyEpoch: 1,
            keyEnvelope: 'ke',
            prevKeyEnvelope: null,
            prevKeyEpoch: null,
            prevParentKeyEpoch: null,
            metadataVersion: 1,
            metadataEnvelope: id,
            currentVersion: null,
            trashedAt: null,
            createdAt: '2026-10-20T00:00:00.000Z',
            updatedAt: `2026-10-20T00:00:${String(seq + 1).padStart(2, '0')}.000Z`,
            envelopeSuite: 1,
            metadataSigner: null,
            metadataSignature: null,
            ...previous,
            ...patch,
            changeSeq: ++seq,
        };
        rows.set(id, { node, purged: false });
    }
    return {
        api,
        rows,
        folder: (id: string, parentId: string | null) => write(id, parentId, { kind: 'folder' }),
        file: (id: string, parentId: string) => write(id, parentId),
        trash: (id: string) => write(id, rows.get(id)!.node.parentId, { trashedAt: 'now' }),
        restore: (id: string) => write(id, rows.get(id)!.node.parentId, { trashedAt: null }),
        rename: (id: string, name: string) =>
            write(id, rows.get(id)!.node.parentId, { metadataEnvelope: name }),
        /* Delete forever: the node alone, as purgeNode does; its contents wait for the fan-out. */
        purge: (id: string) => {
            write(id, rows.get(id)!.node.parentId);
            rows.get(id)!.purged = true;
        },
        /* The tombstone's window passed: the row goes, and older cursors must start over. */
        expire: (id: string) => {
            dropped = Math.max(dropped, rows.get(id)!.node.changeSeq!);
            rows.delete(id);
        },
    };
}

/* The worker: names are the envelopes, and every writer checks out. `opening` runs first. */
let opening: (() => void) | null = null;
const rpc = (async (operation: string, input: { nodes: { metadataEnvelope: string }[] }) => {
    if (operation !== 'driveOpenNodes') throw new Error(`unexpected ${operation}`);
    opening?.();
    return {
        nodes: input.nodes.map((n) => ({
            metadata: { name: n.metadataEnvelope, mime: null, size: null, modified: null },
        })),
    };
}) as unknown as Rpc;

/*
 * A tab's own worker, as the real one: it opens a node only under a parent it opened before
 * (the workspace key for the root), and `failOnce` names nodes whose first open fails.
 */
function worker(failOnce: string[] = []) {
    const opened = new Set<string>();
    const failing = new Set(failOnce);
    return (async (
        operation: string,
        input: { nodes: { id: string; parentId: string; metadataEnvelope: string }[] },
    ) => {
        if (operation !== 'driveOpenNodes') throw new Error(`unexpected ${operation}`);
        opening?.();
        return {
            nodes: input.nodes.map((n) => {
                if ((n.parentId !== WS && !opened.has(n.parentId)) || failing.delete(n.id))
                    return { id: n.id, error: 'This item could not be opened.' };
                opened.add(n.id);
                return {
                    id: n.id,
                    metadata: { name: n.metadataEnvelope, mime: null, size: null, modified: null },
                };
            }),
        };
    }) as unknown as Rpc;
}

function tab(api: DriveApi, mirror: TreeMirror, worker: Rpc = rpc) {
    return createDriveClient(worker, api, {
        mirror,
        verify: async (_ws, nodes) =>
            nodes.map((n) => ({
                id: n.id,
                metadata: 'verified' as const,
                via: null,
                metadataRekey: null,
                versions: [],
            })),
    });
}

const recentIds = (client: ReturnType<typeof tab>) =>
    client
        .recent(50)
        .map((node) => node.id)
        .sort();

/* My files ─ Taxes (trashed) ─ Receipts ─ scan.pdf; My files ─ Taxes ─ return.pdf; My files ─ notes.md */
function drive() {
    const s = server();
    s.folder('root', null);
    s.folder('taxes', 'root');
    s.folder('receipts', 'taxes');
    s.file('scan.pdf', 'receipts');
    s.file('return.pdf', 'taxes');
    s.file('notes.md', 'root');
    s.trash('taxes');
    return s;
}

describe('deleting a folder forever', () => {
    test('takes everything inside it out of Recent, search and tags at once, and off the disk', async () => {
        const s = drive();
        const mirror = createMemoryMirror();
        const client = tab(s.api, mirror);
        await client.buildCatalogue(WS);
        expect(recentIds(client)).toEqual(['notes.md']);

        s.purge('taxes');
        await client.catchUp();

        expect(recentIds(client)).toEqual(['notes.md']);
        expect(client.search('scan')).toEqual([]);
        expect(client.search('receipts')).toEqual([]);
        expect(client.localListing('receipts')).toBeNull();
        // The fan-out has not run: the mirror drops the contents itself, so the next load
        // finds no rows without a parent (which it would take for a missed page and start over).
        expect((await mirror.rows(WS)).map((row) => row.id).sort()).toEqual(['notes.md', 'root']);
    });
});

describe('what Home redraws from', () => {
    test('hears of a deletion once the catalogue has made it', async () => {
        const s = drive();
        s.trash('notes.md');
        const client = tab(s.api, createMemoryMirror());
        await client.buildCatalogue(WS);
        const heard: string[][] = [];
        client.subscribeCatalogue(() =>
            heard.push(client.search('notes').map((hit) => hit.node.id)),
        );
        s.restore('notes.md');
        await client.catchUp();
        expect(heard.at(-1)).toEqual(['notes.md']);

        // Trashed and deleted forever between two polls: the feed carries the tombstone alone.
        s.trash('notes.md');
        s.purge('notes.md');
        await client.catchUp();
        expect(heard.at(-1)).toEqual([]);
    });
});

describe('two tabs of one person', () => {
    test('a change the other tab pulled first still reaches this tab’s Recent and search', async () => {
        const s = drive();
        const mirror = createMemoryMirror();
        const first = tab(s.api, mirror);
        const second = tab(s.api, mirror);
        await first.buildCatalogue(WS);
        await second.buildCatalogue(WS);

        s.trash('notes.md');
        s.file('budget.xlsx', 'root');
        await first.catchUp();
        await second.catchUp();

        expect(recentIds(first)).toEqual(['budget.xlsx']);
        expect(recentIds(second)).toEqual(['budget.xlsx']);
        expect(second.search('notes')).toEqual([]);
    });
});

describe('checking writers again', () => {
    test('a check still running when an item leaves never brings it back, with or without its mark', async () => {
        const s = drive();
        s.file('lease.pdf', 'root');
        // The next check waits for `release`, then calls every writer unknown.
        let gate: Promise<void> | null = null;
        let release!: () => void;
        const client = createDriveClient(rpc, s.api, {
            mirror: createMemoryMirror(),
            verify: async (_ws, nodes) => {
                const held = gate;
                gate = null;
                if (held) await held;
                return nodes.map((n) => ({
                    id: n.id,
                    metadata: held ? ('unknown-signer' as const) : ('verified' as const),
                    via: null,
                    metadataRekey: null,
                    versions: [],
                }));
            },
        });
        await client.buildCatalogue(WS);
        expect(recentIds(client)).toEqual(['lease.pdf', 'notes.md']);

        gate = new Promise((resolve) => (release = resolve));
        const checking = client.recheckIntegrity();
        // Meanwhile another device trashes one and deletes the other forever.
        s.trash('notes.md');
        s.trash('lease.pdf');
        s.purge('lease.pdf');
        await client.catchUp();
        release();
        await checking;

        expect(recentIds(client)).toEqual([]);
        expect(client.search('notes')).toEqual([]);
        expect(client.search('lease')).toEqual([]);
    });
});

describe('a tab that slept past the tombstones', () => {
    test('starts over rather than keep what was deleted while it slept', async () => {
        const s = drive();
        const mirror = createMemoryMirror();
        const client = tab(s.api, mirror);
        await client.buildCatalogue(WS);
        expect(recentIds(client)).toEqual(['notes.md']);

        // Trashed, deleted forever, and the tombstone itself expired: no change names it any more.
        s.trash('notes.md');
        s.purge('notes.md');
        s.expire('notes.md');
        s.file('budget.xlsx', 'root');
        await client.catchUp();

        expect(recentIds(client)).toEqual(['budget.xlsx']);
        expect(client.search('notes')).toEqual([]);
        expect((await mirror.rows(WS)).map((row) => row.id)).not.toContain('notes.md');
    });
});

/* Counts how often the device's mirror is started over. */
function counted(mirror: TreeMirror) {
    const cleared = { count: 0 };
    return {
        cleared,
        mirror: {
            ...mirror,
            clear: (workspaceId?: string) => {
                cleared.count++;
                return mirror.clear(workspaceId);
            },
        } satisfies TreeMirror,
    };
}

describe('pulls that overlap', () => {
    test('another tab clearing the mirror while this one pulls leaves nothing missing from it', async () => {
        const s = drive();
        const mirror = createMemoryMirror();
        const client = tab(s.api, mirror);
        await client.buildCatalogue(WS);
        s.file('budget.xlsx', 'root');
        // The other tab starts over (a rebuild) while this tab's page is on its way.
        const changes = s.api.changes.bind(s.api);
        let once = true;
        s.api.changes = async (ws, since, limit) => {
            const page = await changes(ws, since, limit);
            if (once && since > 0) {
                once = false;
                await mirror.clear(WS);
            }
            return page;
        };
        await client.catchUp();

        const live = [...s.rows.keys()].sort();
        expect((await mirror.rows(WS)).map((row) => row.id).sort()).toEqual(live);
        expect(recentIds(client)).toEqual(['budget.xlsx', 'notes.md']);
    });

    test('a first pull of a large workspace is never started over by its own later pages', async () => {
        const s = server();
        s.folder('root', null);
        for (let index = 0; index < 600; index++) s.file(`f${index}`, 'root');
        // A deletion past the first page whose tombstone has since expired.
        s.file('gone', 'root');
        s.trash('gone');
        s.purge('gone');
        s.expire('gone');
        const { mirror, cleared } = counted(createMemoryMirror());
        const client = tab(s.api, mirror);
        await client.buildCatalogue(WS);

        expect(cleared.count).toBe(0);
        expect(await mirror.rows(WS)).toHaveLength(601);
    });
});

describe('a tab that slept while another kept the mirror current', () => {
    test('refiles from the mirror without starting it over, and its answers stay whole meanwhile', async () => {
        const s = drive();
        s.file('plan.md', 'root');
        const { mirror, cleared } = counted(createMemoryMirror());
        const awake = tab(s.api, mirror);
        const asleep = tab(s.api, mirror);
        await awake.buildCatalogue(WS);
        await asleep.buildCatalogue(WS);
        s.trash('notes.md');
        s.purge('notes.md');
        s.file('budget.xlsx', 'root');
        await awake.catchUp();
        s.expire('notes.md');
        s.file('lease.pdf', 'root');
        await awake.catchUp();
        expect(cleared.count).toBe(0);

        // What the sleeping tab shows while it opens what it missed.
        const meanwhile: string[][] = [];
        opening = () => meanwhile.push(recentIds(asleep));
        await asleep.catchUp();

        expect(cleared.count).toBe(0);
        expect(recentIds(asleep)).toEqual(['budget.xlsx', 'lease.pdf', 'plan.md']);
        expect(meanwhile.length).toBeGreaterThan(0);
        for (const ids of meanwhile) expect(ids).toContain('plan.md');
    });
});

describe('a device that pulls from nothing while a deleted folder is still being emptied', () => {
    test('keeps none of its contents and never starts the pull over', async () => {
        const s = drive();
        // Deleted forever; the server's fan-out has not reached what was inside yet.
        s.purge('taxes');
        const { mirror, cleared } = counted(createMemoryMirror());
        const client = tab(s.api, mirror);
        await client.buildCatalogue(WS);

        expect(cleared.count).toBe(0);
        expect((await mirror.rows(WS)).map((row) => row.id).sort()).toEqual(['notes.md', 'root']);
        expect(recentIds(client)).toEqual(['notes.md']);
    });
});

describe('a refile while another tab clears the mirror', () => {
    test('removes nothing on a part of the tree, and pulls again at once to put things right', async () => {
        const s = drive();
        s.file('plan.md', 'root');
        const base = createMemoryMirror();
        const awake = tab(s.api, base);
        await awake.buildCatalogue(WS);
        // The sleeping tab reads its rows the moment another tab has just cleared the mirror.
        let clearFirst = false;
        const mirror: TreeMirror = {
            ...base,
            snapshot: async (ws) => {
                if (clearFirst) {
                    clearFirst = false;
                    await base.clear(ws);
                }
                return base.snapshot(ws);
            },
        };
        const asleep = tab(s.api, mirror);
        await asleep.buildCatalogue(WS);
        s.trash('notes.md');
        s.purge('notes.md');
        await awake.catchUp();
        s.expire('notes.md');
        s.file('lease.pdf', 'root');
        await awake.catchUp();

        clearFirst = true;
        await asleep.catchUp();
        expect(recentIds(asleep)).toEqual(['lease.pdf', 'plan.md']);
        expect(asleep.search('notes')).toEqual([]);
        expect((await base.rows(WS)).map((row) => row.id).sort()).toEqual(
            [...s.rows.keys()].sort(),
        );
    });
});

describe('a pull that fails after a page carrying a deletion', () => {
    test('still takes what was inside the deleted folder off the disk', async () => {
        const s = drive();
        const mirror = createMemoryMirror();
        const client = tab(s.api, mirror);
        await client.buildCatalogue(WS);
        s.purge('taxes');
        for (let index = 0; index < 600; index++) s.file(`f${index}`, 'root');
        // The second page never arrives; the first, with the tombstone, was applied.
        const changes = s.api.changes.bind(s.api);
        let calls = 0;
        s.api.changes = async (ws, since, limit) => {
            if (++calls === 2) throw new Error('Failed to fetch');
            return changes(ws, since, limit);
        };
        await expect(client.catchUp()).rejects.toThrow('Failed to fetch');

        const ids = (await mirror.rows(WS)).map((row) => row.id);
        expect(ids).not.toContain('receipts');
        expect(ids).not.toContain('scan.pdf');
        expect(ids).not.toContain('return.pdf');
    });
});

describe('a tab whose page is refused while the tab that cleared the mirror pulls past it', () => {
    test('still files what changed between where it stood and where the mirror got to', async () => {
        const s = drive();
        const base = createMemoryMirror();
        // This tab's page is on its way when another tab clears the mirror to start over, and
        // that tab's pull lands between this one's refusal and its look at the mirror's cursor.
        let race: 'clear' | 'pull' | null = null;
        const other = tab(s.api, base);
        const mirror: TreeMirror = {
            ...base,
            apply: async (ws, from, changes, next) => {
                const applied = await base.apply(ws, from, changes, next);
                if (applied === null && race === 'pull') {
                    race = null;
                    await other.buildCatalogue(WS);
                }
                return applied;
            },
        };
        const client = tab(s.api, mirror);
        await client.buildCatalogue(WS);
        const changes = s.api.changes.bind(s.api);
        s.api.changes = async (ws, since, limit) => {
            const page = await changes(ws, since, limit);
            if (race === 'clear') {
                race = 'pull';
                await base.clear(WS);
            }
            return page;
        };
        s.trash('notes.md');
        s.purge('notes.md');
        s.file('budget.xlsx', 'root');
        race = 'clear';
        await client.catchUp();

        expect(race).toBeNull();
        expect(recentIds(client)).toEqual(['budget.xlsx']);
        expect(client.search('notes')).toEqual([]);
    });
});

const named = (client: ReturnType<typeof tab>) =>
    client
        .recent(50)
        .map((node) => [node.id, node.name])
        .sort(([a], [b]) => (a! < b! ? -1 : 1));

describe('a folder made, filled and renamed while a tab was hidden', () => {
    test('opens in that tab with everything inside it readable', async () => {
        const s = drive();
        const mirror = createMemoryMirror();
        const visible = tab(s.api, mirror, worker());
        const hidden = tab(s.api, mirror, worker());
        await visible.buildCatalogue(WS);
        await hidden.buildCatalogue(WS);

        s.folder('trip', 'root');
        s.file('ticket.pdf', 'trip');
        s.file('hotel.pdf', 'trip');
        await visible.catchUp();
        // The feed now holds the folder after its files.
        s.rename('trip', 'Trip 2026');
        await visible.catchUp();
        await hidden.catchUp();

        const expected = [
            ['hotel.pdf', 'hotel.pdf'],
            ['notes.md', 'notes.md'],
            ['ticket.pdf', 'ticket.pdf'],
            ['trip', 'Trip 2026'],
        ];
        expect(named(visible)).toEqual(expected);
        expect(named(hidden)).toEqual(expected);
    });

    test('an item that would not open is opened again when the tab refiles', async () => {
        const s = drive();
        s.file('lease.pdf', 'root');
        const mirror = createMemoryMirror();
        const awake = tab(s.api, mirror, worker());
        const asleep = tab(s.api, mirror, worker(['lease.pdf']));
        await awake.buildCatalogue(WS);
        await asleep.buildCatalogue(WS);
        expect(asleep.search('unreadable').map((hit) => hit.node.id)).toEqual(['lease.pdf']);

        // The sleeping tab slept past an expired tombstone, so it refiles from the mirror.
        s.trash('notes.md');
        s.purge('notes.md');
        await awake.catchUp();
        s.expire('notes.md');
        await asleep.catchUp();

        expect(named(asleep)).toEqual([['lease.pdf', 'lease.pdf']]);
    });
});

describe('the server emptying a folder already deleted here', () => {
    test('never reads the whole mirror again for the tombstones of rows already gone', async () => {
        const s = drive();
        const base = createMemoryMirror();
        // Each sweep reads every row of the workspace in a write transaction.
        let sweeps = 0;
        const mirror: TreeMirror = {
            ...base,
            dropBelow: (ws, ids) => {
                sweeps++;
                return base.dropBelow(ws, ids);
            },
        };
        const client = tab(s.api, mirror);
        await client.buildCatalogue(WS);
        s.purge('taxes');
        await client.catchUp();
        expect(sweeps).toBe(1);

        // The fan-out, a level at a time.
        s.purge('receipts');
        s.purge('return.pdf');
        await client.catchUp();
        s.purge('scan.pdf');
        await client.catchUp();

        expect(sweeps).toBe(1);
        expect((await base.rows(WS)).map((row) => row.id).sort()).toEqual(['notes.md', 'root']);
    });
});

describe('a folder changed just before what held it was deleted forever', () => {
    test('goes with it, though both arrive in one pull', async () => {
        const s = drive();
        const client = tab(s.api, createMemoryMirror());
        await client.buildCatalogue(WS);
        s.rename('receipts', 'Receipts 2025');
        s.purge('taxes');
        await client.catchUp();

        expect(client.localListing('receipts')).toBeNull();
        expect(client.localListing('taxes')).toBeNull();
    });
});
