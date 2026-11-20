import {
    type Draft,
    type DraftPlace,
    draftSavedAt,
    draftsToDrop,
    DRAFT_MAX_AGE_MS,
} from '@hushos/crypto/drafts';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { authClient } from '@/lib/auth-client';

/*
 * Drafts (docs/editing-design.md 3, "Draft"; Editing 1c): the text editor's unsaved text, sealed
 * by the crypto worker under a key derived from the account root for this account and file
 * (@hushos/crypto/drafts), kept in this browser's IndexedDB and nowhere else. A locked browser
 * holds only ciphertext: the worker has no root to seal or open with, so nothing is written or
 * read while locked, and an unlock brings the drafts back. Signing out, and the account's local
 * wipe, delete the whole database (lib/device-data.ts); a save that makes the text current, a
 * Discard and Open theirs delete the file's draft.
 *
 * One record per account and file, found by the worker's slot (a name only the unlocked account
 * works out), last writer wins: two tabs editing the same file keep whichever wrote last. Each
 * row keeps the account (so the caps count one account's drafts), when it was written (the caps
 * and expiry, readable without a key) and the sealed record. Bounds: 8 MiB of text per draft,
 * 50 drafts per account (the oldest go) and 30 days.
 *
 * Part of the editor's fixed set (editorAssets): nothing here is in the post-unlock preload.
 */

export const DRAFTS_DATABASE = 'hushos-drafts';
const DATABASE_VERSION = 1;

type Row = { key: string; userId: string; savedAt: number; record: string };
interface Schema extends DBSchema {
    drafts: { key: string; value: Row };
}

/* The worker's side (driveDraftSlot, driveDraftSeal, driveDraftOpen), so tests can stand in. */
export type DraftSealer = {
    slot(place: DraftPlace): Promise<string>;
    seal(place: DraftPlace, draft: Draft): Promise<{ slot: string; record: string }>;
    /* Null for a record that does not open here (another root, changed, damaged). */
    open(place: DraftPlace, record: string): Promise<Draft | null>;
};

export type DraftStore = {
    /*
     * Seals and keeps the draft, keeping the caps; false when it could not be kept. `current`, asked once
     * the text is sealed: false (locked or signed out meanwhile) and nothing reaches the database.
     */
    write(place: DraftPlace, draft: Draft, current?: () => boolean): Promise<boolean>;
    /* The file's draft, or null: none, or one that doesn't open or is too old, which is deleted. */
    read(place: DraftPlace): Promise<Draft | null>;
    remove(place: DraftPlace): Promise<void>;
};

const rowKey = (userId: string, slot: string) => `${userId.toLowerCase()}:${slot}`;

export function createDraftStore(
    sealer: DraftSealer,
    name = DRAFTS_DATABASE,
    now: () => number = Date.now,
): DraftStore {
    let database: Promise<IDBPDatabase<Schema>> | undefined;
    const open = () =>
        (database ??= openDB<Schema>(name, DATABASE_VERSION, {
            upgrade(db) {
                db.createObjectStore('drafts', { keyPath: 'key' });
            },
            // Another tab deleting it (a sign-out there): let go, so the deletion goes through.
            blocking(_current, _next, event) {
                (event.target as IDBDatabase).close();
                database = undefined;
            },
            terminated() {
                database = undefined;
            },
        }).catch((error: unknown) => {
            database = undefined;
            throw error;
        }));
    const account = (userId: string) => {
        const user = userId.toLowerCase();
        return IDBKeyRange.bound(`${user}:`, `${user}:￿`);
    };
    return {
        async write(place, draft, current = () => true) {
            try {
                const { slot, record } = await sealer.seal(place, draft);
                // A lock or a sign-out while it was sealed: its database may be on its way out.
                if (!current()) return false;
                const key = rowKey(place.userId, slot);
                const db = await open();
                const transaction = db.transaction('drafts', 'readwrite');
                const store = transaction.store;
                const rows = await store.getAll(account(place.userId));
                const drop = draftsToDrop(
                    rows.map((row) => ({
                        slot: row.key,
                        savedAt: draftSavedAt(row.record) === row.savedAt ? row.savedAt : null,
                    })),
                    now(),
                    key,
                );
                for (const gone of drop) void store.delete(gone);
                void store.put({
                    key,
                    userId: place.userId.toLowerCase(),
                    savedAt: draft.frame.savedAt,
                    record,
                });
                await transaction.done;
                return true;
            } catch {
                // Quota, a store that won't open, text past the limit: editing goes on regardless.
                return false;
            }
        },
        async read(place) {
            const slot = await sealer.slot(place);
            const key = rowKey(place.userId, slot);
            const db = await open();
            const row = await db.get('drafts', key);
            if (!row) return null;
            const draft = await sealer.open(place, row.record);
            // Never offered: one that doesn't open here (a rotated root, a changed record) or one past
            // its age. Gone for good, since nothing can ever show it.
            if (!draft || now() - draft.frame.savedAt > DRAFT_MAX_AGE_MS) {
                await db.delete('drafts', key);
                return null;
            }
            return draft;
        },
        async remove(place) {
            const slot = await sealer.slot(place);
            await (await open()).delete('drafts', rowKey(place.userId, slot));
        },
    };
}

let shared: DraftStore | undefined;
/* This browser's drafts, sealed by the crypto worker. */
export function drafts() {
    return (shared ??= createDraftStore({
        slot: async (place) => (await authClient.rpc('driveDraftSlot', place)).slot,
        seal: (place, draft) => authClient.rpc('driveDraftSeal', { ...place, draft }),
        open: async (place, record) =>
            (await authClient.rpc('driveDraftOpen', { ...place, record })).draft,
    }));
}

/*
 * What the editor holds now, for the writer: null when nothing may be written (no editable text,
 * a read-only or ended session, the restore offer still unanswered, Open theirs under way, no
 * version to start from, or another account session than the editor's). `atBaseline`: the text
 * is what was last opened or saved, so the draft goes instead.
 */
export type DraftSnapshot = {
    place: DraftPlace;
    atBaseline: boolean;
    draft: () => Draft | null;
};

export type DraftWriter = {
    /* The text changed: a write follows within `delay`, at most one per `delay` while typing. */
    changed(): void;
    /* Writes (or removes) now, for pagehide, hiding and closing; resolves once done. */
    flush(): Promise<void>;
    /* Removes the draft of `place` now, after anything queued; nothing queued writes it back. */
    remove(place: DraftPlace): Promise<void>;
    /* Stops the timer: nothing more is scheduled; what was already asked for still lands. */
    stop(): void;
};

/*
 * The draft writer's rules. A change schedules a write `delay` later; changes meanwhile ride on it,
 * so typing writes at most once per `delay` and the last change is written within `delay`. A write
 * never happens while locked (`locked`), never without a snapshot, and never for a text at its
 * baseline, which removes the draft instead. Writes and removals run one at a time, in order, so a
 * removal after a save is never overtaken by a write from before it. `onKept` hears whether the
 * last write was kept.
 */
export function createDraftWriter(options: {
    delay?: number;
    snapshot: () => DraftSnapshot | null;
    locked: () => boolean;
    store: Pick<DraftStore, 'write' | 'remove'>;
    now?: () => number;
    onKept?: (kept: boolean) => void;
}): DraftWriter {
    const delay = options.delay ?? DRAFT_WRITE_DELAY_MS;
    const now = options.now ?? Date.now;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let chain: Promise<void> = Promise.resolve();
    const queue = (work: () => Promise<void>) => {
        const next = chain.then(work, work).catch(() => {});
        chain = next;
        return next;
    };
    /*
     * The text is read when the write is asked for, never later: a close writes what was on screen
     * as it closed. The store is reached in order, after anything asked before.
     */
    const run = () => {
        if (stopped || options.locked()) return chain;
        const snapshot = options.snapshot();
        if (!snapshot) return chain;
        const { place } = snapshot;
        if (snapshot.atBaseline)
            return queue(async () => {
                await options.store.remove(place).catch(() => {});
            });
        const draft = snapshot.draft();
        // Half of a character just typed: nothing is written this time; the last draft stays.
        if (!draft) return chain;
        return queue(async () => {
            // Locked since it was asked for: nothing reaches the store.
            if (options.locked()) return;
            const kept = await options.store.write(
                place,
                { ...draft, frame: { ...draft.frame, savedAt: now() } },
                () => !options.locked(),
            );
            options.onKept?.(kept);
        });
    };
    const cancel = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
    return {
        changed() {
            if (stopped || timer !== null) return;
            timer = setTimeout(() => {
                timer = null;
                void run();
            }, delay);
        },
        flush() {
            cancel();
            return run();
        },
        remove(place) {
            cancel();
            return queue(() => options.store.remove(place).catch(() => {}));
        },
        stop() {
            stopped = true;
            cancel();
        },
    };
}

/* About two seconds after a change, and no more often while typing. */
export const DRAFT_WRITE_DELAY_MS = 2_000;

/*
 * "Restore your unsaved changes from 2:14 PM": in the person's locale, with the date when it isn't
 * today.
 */
export function draftWhen(savedAt: number, now = Date.now(), locale?: string) {
    const at = new Date(savedAt);
    const today = new Date(now);
    const sameDay =
        at.getFullYear() === today.getFullYear() &&
        at.getMonth() === today.getMonth() &&
        at.getDate() === today.getDate();
    const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(at);
    if (sameDay) return time;
    const date = new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        ...(at.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
    }).format(at);
    return `${date}, ${time}`;
}
