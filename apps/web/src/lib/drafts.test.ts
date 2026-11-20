// @vitest-environment node
import { type Draft, draftSlot, openDraft, sealDraft } from '@hushos/crypto/drafts';
import {
    IDBCursor,
    IDBCursorWithValue,
    IDBDatabase,
    IDBFactory,
    IDBIndex,
    IDBKeyRange,
    IDBObjectStore,
    IDBOpenDBRequest,
    IDBRequest,
    IDBTransaction,
    IDBVersionChangeEvent,
} from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    createDraftStore,
    createDraftWriter,
    DRAFT_WRITE_DELAY_MS,
    draftWhen,
    type DraftSealer,
    type DraftSnapshot,
} from './drafts';

/*
 * Drafts on the web: the store keeps sealed records only, within the caps, and drops what can never
 * be shown; the writer's rules decide when a draft is written, removed, or left alone.
 */

const USER = '0f6d6c1e-2a49-4d8b-9b1a-4b3f4b8c1d01';
const OTHER_USER = '7a7a7a7a-0000-4000-8000-000000000007';
const WORKSPACE = 'a1a1a1a1-0000-4000-8000-000000000001';
const node = (n: number) => `b2b2b2b2-0000-4000-8000-${String(n).padStart(12, '0')}`;
const place = (n = 1, userId = USER) => ({ userId, workspaceId: WORKSPACE, nodeId: node(n) });
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_763_650_440_000;

const draft = (text: string, savedAt = NOW): Draft => ({
    frame: {
        baseVersionId: 'c3c3c3c3-0000-4000-8000-000000000003',
        encoding: 'utf-8',
        lineEnding: 'lf',
        mixed: false,
        savedAt,
    },
    text,
    selection: { from: 1, to: 2 },
});

/* The worker's sealing, run here with a root of its own: what reaches the store is real ciphertext. */
function sealer(root = new Uint8Array(32).fill(5)): DraftSealer {
    return {
        slot: (where) => draftSlot(root, where),
        seal: async (where, value) => ({
            slot: await draftSlot(root, where),
            record: await sealDraft(root, where, value),
        }),
        open: (where, record) => openDraft(root, where, record).catch(() => null),
    };
}

beforeEach(() => {
    const globals = {
        IDBCursor,
        IDBCursorWithValue,
        IDBDatabase,
        IDBIndex,
        IDBKeyRange,
        IDBObjectStore,
        IDBOpenDBRequest,
        IDBRequest,
        IDBTransaction,
        IDBVersionChangeEvent,
    };
    for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
    vi.stubGlobal('indexedDB', new IDBFactory());
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

/* Every value the database holds, as text, to look for plaintext in. */
async function rawRows() {
    return new Promise<string>((resolve, reject) => {
        const request = indexedDB.open('hushos-drafts');
        request.onsuccess = () => {
            const all = request.result.transaction('drafts').objectStore('drafts').getAll();
            all.onsuccess = () => {
                request.result.close();
                resolve(JSON.stringify(all.result));
            };
            all.onerror = () => reject(all.error);
        };
        request.onerror = () => reject(request.error);
    });
}

describe('the draft store', () => {
    test('keeps only ciphertext, and gives the text back to the same account and file', async () => {
        const store = createDraftStore(sealer(), 'hushos-drafts', () => NOW);
        expect(await store.write(place(), draft('canary text'))).toBe(true);
        const raw = await rawRows();
        expect(raw).not.toContain('canary');
        expect(raw).not.toContain(node(1));
        expect((await store.read(place()))?.text).toBe('canary text');
        // Another file, another account: nothing.
        expect(await store.read(place(2))).toBeNull();
        expect(await store.read(place(1, OTHER_USER))).toBeNull();
    });

    test('one draft per account and file: the last write wins', async () => {
        const store = createDraftStore(sealer(), 'hushos-drafts', () => NOW);
        await store.write(place(), draft('first'));
        await store.write(place(), draft('second', NOW + 1));
        expect((await store.read(place()))?.text).toBe('second');
        expect(JSON.parse(await rawRows())).toHaveLength(1);
    });

    test('a draft that no longer opens here (a changed record, a rotated root) is deleted, never offered', async () => {
        await createDraftStore(sealer(), 'hushos-drafts', () => NOW).write(place(), draft('mine'));
        const store = createDraftStore(
            { ...sealer(), open: async () => null },
            'hushos-drafts',
            () => NOW,
        );
        expect(await store.read(place())).toBeNull();
        expect(JSON.parse(await rawRows())).toHaveLength(0);
    });

    test('older than thirty days is dropped on read; thirty days exactly is offered', async () => {
        const store = createDraftStore(sealer(), 'hushos-drafts', () => NOW);
        await store.write(place(1), draft('edge', NOW - 30 * DAY));
        await store.write(place(2), draft('past', NOW - 30 * DAY - 1));
        expect((await store.read(place(1)))?.text).toBe('edge');
        expect(await store.read(place(2))).toBeNull();
        expect(JSON.parse(await rawRows())).toHaveLength(1);
    });

    test('fifty per account: a new one pushes the oldest out, and other accounts are not counted', async () => {
        const store = createDraftStore(sealer(), 'hushos-drafts', () => NOW);
        await store.write(place(100, OTHER_USER), draft('theirs', NOW - 60_000));
        for (let n = 0; n < 50; n++) await store.write(place(n), draft(`d${n}`, NOW - 50_000 + n));
        expect(JSON.parse(await rawRows())).toHaveLength(51);
        await store.write(place(50), draft('newest', NOW));
        expect(await store.read(place(0))).toBeNull();
        expect((await store.read(place(1)))?.text).toBe('d1');
        expect((await store.read(place(50)))?.text).toBe('newest');
        expect((await store.read(place(100, OTHER_USER)))?.text).toBe('theirs');
        expect(JSON.parse(await rawRows())).toHaveLength(51);
    });

    test('a write that can’t be sealed is not kept, and says so; the last draft stays', async () => {
        const store = createDraftStore(sealer(), 'hushos-drafts', () => NOW);
        await store.write(place(), draft('kept'));
        expect(await store.write(place(), draft('a'.repeat(8 * 1024 * 1024 + 1)))).toBe(false);
        expect((await store.read(place()))?.text).toBe('kept');
    });
});

describe('the draft writer', () => {
    type Calls = { writes: string[]; removes: number };
    function setup(over: { locked?: () => boolean; snapshot?: () => DraftSnapshot | null } = {}) {
        let text = 'typed';
        let atBaseline = false;
        const calls: Calls = { writes: [], removes: 0 };
        const writer = createDraftWriter({
            locked: over.locked ?? (() => false),
            snapshot:
                over.snapshot ??
                (() => ({
                    place: place(),
                    atBaseline,
                    draft: () => draft(text),
                })),
            store: {
                write: async (_where, value) => {
                    calls.writes.push(value.text);
                    return true;
                },
                remove: async () => {
                    calls.removes += 1;
                },
            },
        });
        return {
            writer,
            calls,
            type: (value: string) => {
                text = value;
                atBaseline = false;
                writer.changed();
            },
            backToBaseline: () => {
                atBaseline = true;
                writer.changed();
            },
        };
    }
    const settle = async (ms: number) => {
        await vi.advanceTimersByTimeAsync(ms);
    };

    test('writes once about two seconds after typing starts, and no more often while typing', async () => {
        vi.useFakeTimers();
        const { calls, type } = setup();
        type('a');
        await settle(500);
        type('ab');
        await settle(500);
        type('abc');
        expect(calls.writes).toEqual([]);
        await settle(DRAFT_WRITE_DELAY_MS - 1000);
        expect(calls.writes).toEqual(['abc']);
        type('abcd');
        await settle(DRAFT_WRITE_DELAY_MS - 1);
        expect(calls.writes).toEqual(['abc']);
        await settle(1);
        expect(calls.writes).toEqual(['abc', 'abcd']);
    });

    test('writes nothing while locked, and nothing for a read-only or unanswered editor', async () => {
        vi.useFakeTimers();
        let locked = true;
        const lockedOne = setup({ locked: () => locked });
        lockedOne.type('secret');
        await settle(DRAFT_WRITE_DELAY_MS);
        await lockedOne.writer.flush();
        expect(lockedOne.calls.writes).toEqual([]);
        locked = false;
        lockedOne.type('after unlock');
        await settle(DRAFT_WRITE_DELAY_MS);
        expect(lockedOne.calls.writes).toEqual(['after unlock']);

        const readOnly = setup({ snapshot: () => null });
        readOnly.type('x');
        await settle(DRAFT_WRITE_DELAY_MS);
        await readOnly.writer.flush();
        expect(readOnly.calls).toEqual({ writes: [], removes: 0 });
    });

    test('back at the saved text, the draft is removed instead of written', async () => {
        vi.useFakeTimers();
        const { calls, type, backToBaseline } = setup();
        type('changed');
        await settle(DRAFT_WRITE_DELAY_MS);
        backToBaseline();
        await settle(DRAFT_WRITE_DELAY_MS);
        expect(calls).toEqual({ writes: ['changed'], removes: 1 });
    });

    test('flush writes at once and takes the pending write with it', async () => {
        vi.useFakeTimers();
        const { writer, calls, type } = setup();
        type('closing');
        await writer.flush();
        expect(calls.writes).toEqual(['closing']);
        await settle(DRAFT_WRITE_DELAY_MS * 2);
        expect(calls.writes).toEqual(['closing']);
    });

    test('a removal asked for after a write is never overtaken by it', async () => {
        const order: string[] = [];
        let release!: () => void;
        const writer = createDraftWriter({
            locked: () => false,
            snapshot: () => ({ place: place(), atBaseline: false, draft: () => draft('x') }),
            store: {
                write: () =>
                    new Promise<boolean>((resolve) => {
                        release = () => {
                            order.push('write');
                            resolve(true);
                        };
                    }),
                remove: async () => {
                    order.push('remove');
                },
            },
        });
        const writing = writer.flush();
        const removing = writer.remove(place());
        await Promise.resolve();
        release();
        await Promise.all([writing, removing]);
        expect(order).toEqual(['write', 'remove']);
    });

    test('a lock that lands after the text was read keeps it out of the store', async () => {
        let locked = false;
        const writes: string[] = [];
        const writer = createDraftWriter({
            locked: () => locked,
            snapshot: () => ({ place: place(), atBaseline: false, draft: () => draft('late') }),
            store: {
                write: async (_where, value) => {
                    writes.push(value.text);
                    return true;
                },
                remove: async () => {},
            },
        });
        // Read now, written a moment later: a lock between the two leaves the store untouched.
        const late = writer.flush();
        locked = true;
        await late;
        expect(writes).toEqual([]);
    });
});

describe('when a draft was written', () => {
    test('says the time alone today, and the date too on another day', () => {
        const at = new Date(2026, 10, 20, 14, 14).getTime();
        const today = draftWhen(at, new Date(2026, 10, 20, 18, 0).getTime(), 'en-US');
        expect(today).toBe('2:14 PM');
        const later = draftWhen(at, new Date(2026, 10, 21, 9, 0).getTime(), 'en-US');
        expect(later).toBe('Nov 20, 2:14 PM');
        const nextYear = draftWhen(at, new Date(2027, 0, 2, 9, 0).getTime(), 'en-US');
        expect(nextYear).toBe('Nov 20, 2026, 2:14 PM');
    });
});
