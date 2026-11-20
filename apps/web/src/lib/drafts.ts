import { type Draft, type DraftPlace, draftsToDrop, DRAFT_MAX_AGE_MS } from '@hushos/crypto/drafts';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { authClient } from '@/lib/auth-client';

/*
 * Drafts (docs/editing-design.md 3, "Draft"; Editing 1c): the text editor's unsaved text, sealed
 * by the crypto worker under a key derived from the account root for this account and file
 * (@hushos/crypto/drafts), kept in this browser's IndexedDB and nowhere else. A locked browser
 * holds only ciphertext: the worker has no root to seal or open with, so nothing is written or
 * read while locked, and an unlock brings the drafts back. Signing out, and the account's local
 * wipe, delete the whole database (lib/device-data.ts).
 *
 * One record per account and file, found by the worker's slot (a name only the unlocked account
 * works out), last writer wins. Beside each record, a small metadata row: the account, when it
 * was written, its size, and which editor session wrote it with which revision. The caps read
 * only those (never a sealed record), and a session removes only a draft it owns: one it wrote
 * (the same session and revision still stored) or one the person restored or discarded. So an
 * untouched tab, or an editor closed while it loaded, never deletes another's draft. Bounds:
 * 8 MiB of text per draft, 50 drafts per account (the oldest go), and 30 days, after which a
 * draft is never offered (and is deleted when its slot is next read or the caps run).
 *
 * Part of the editor's fixed set (editorAssets): nothing here is in the post-unlock preload.
 */

export const DRAFTS_DATABASE = 'hushos-drafts';
const DATABASE_VERSION = 2;

/* Which editor session wrote a stored draft, and its how-many-th write. */
export type DraftOwner = { session: string; revision: number };

type Row = { key: string; record: string };
type Meta = { key: string; userId: string; savedAt: number; size: number } & DraftOwner;
interface Schema extends DBSchema {
    drafts: { key: string; value: Row };
    meta: { key: string; value: Meta; indexes: { userId: string } };
}

/* The worker's side (driveDraftSlot, driveDraftSeal, driveDraftOpen), so tests can stand in. */
export type DraftSealer = {
    slot(place: DraftPlace): Promise<string>;
    seal(place: DraftPlace, draft: Draft): Promise<{ slot: string; record: string }>;
    /* Null for a record that does not open here (another root, changed, damaged). */
    open(place: DraftPlace, record: string): Promise<Draft | null>;
};

/* A draft read back: what it holds, and who wrote it. */
export type StoredDraft = { draft: Draft; owner: DraftOwner };

export type DraftStore = {
    /*
     * Seals and keeps the draft as `owner`'s, keeping the caps; false when it could not be kept.
     * `current`, asked once the text is sealed: false (locked or signed out meanwhile) and nothing
     * reaches the database.
     */
    write(
        place: DraftPlace,
        draft: Draft,
        owner: DraftOwner,
        current?: () => boolean,
    ): Promise<boolean>;
    /*
     * The file's draft, or null for none (or one that doesn't open or is past its age, which is
     * deleted: nothing could ever show it). Rejects when the store couldn't be read: that is no
     * answer, never "none".
     */
    read(place: DraftPlace): Promise<StoredDraft | null>;
    /* Removes the file's draft only while `owner` still wrote what is stored; true when it went (or was none). */
    remove(place: DraftPlace, owner: DraftOwner): Promise<boolean>;
};

const rowKey = (userId: string, slot: string) => `${userId.toLowerCase()}:${slot}`;
const same = (a: DraftOwner, b: DraftOwner) => a.session === b.session && a.revision === b.revision;

export function createDraftStore(
    sealer: DraftSealer,
    name = DRAFTS_DATABASE,
    now: () => number = Date.now,
): DraftStore {
    let database: Promise<IDBPDatabase<Schema>> | undefined;
    const open = () =>
        (database ??= openDB<Schema>(name, DATABASE_VERSION, {
            upgrade(db) {
                // Version 1 kept the time beside each record; nothing of it was released.
                if (db.objectStoreNames.contains('drafts')) db.deleteObjectStore('drafts');
                db.createObjectStore('drafts', { keyPath: 'key' });
                db.createObjectStore('meta', { keyPath: 'key' }).createIndex('userId', 'userId');
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
    return {
        async write(place, draft, owner, current = () => true) {
            try {
                const { slot, record } = await sealer.seal(place, draft);
                // A lock or a sign-out while it was sealed: its database may be on its way out.
                if (!current()) return false;
                const key = rowKey(place.userId, slot);
                const db = await open();
                const transaction = db.transaction(['drafts', 'meta'], 'readwrite');
                const metas = transaction.objectStore('meta');
                const records = transaction.objectStore('drafts');
                const rows = await metas.index('userId').getAll(place.userId.toLowerCase());
                const drop = draftsToDrop(
                    rows.map((row) => ({ slot: row.key, savedAt: row.savedAt })),
                    now(),
                    key,
                );
                // Every request awaited with the transaction: a refused one (quota) fails here, once.
                await Promise.all([
                    ...drop.flatMap((gone) => [metas.delete(gone), records.delete(gone)]),
                    records.put({ key, record }),
                    metas.put({
                        key,
                        userId: place.userId.toLowerCase(),
                        savedAt: draft.frame.savedAt,
                        size: record.length,
                        ...owner,
                    }),
                    transaction.done,
                ]);
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
            const [row, meta] = await Promise.all([db.get('drafts', key), db.get('meta', key)]);
            if (!row || !meta) return null;
            const owner = { session: meta.session, revision: meta.revision };
            const draft = await sealer.open(place, row.record);
            // Never offered: one that doesn't open here (a rotated root, a changed record) or one past
            // its age. Gone for good, since nothing can ever show it, but only while it is still the
            // revision read: another tab may have written a fresh one meanwhile.
            if (!draft || now() - draft.frame.savedAt > DRAFT_MAX_AGE_MS) {
                await this.remove(place, owner);
                return null;
            }
            return { draft, owner };
        },
        async remove(place, owner) {
            const slot = await sealer.slot(place);
            const key = rowKey(place.userId, slot);
            const db = await open();
            const transaction = db.transaction(['drafts', 'meta'], 'readwrite');
            const meta = await transaction.objectStore('meta').get(key);
            // Another session wrote since (another tab): its draft is not this one's to remove.
            if (meta && !same(meta, owner)) {
                await transaction.done;
                return false;
            }
            await Promise.all([
                transaction.objectStore('drafts').delete(key),
                transaction.objectStore('meta').delete(key),
                transaction.done,
            ]);
            return true;
        },
    };
}

let shared: DraftStore | undefined;
/* This browser's drafts, sealed by the crypto worker. */
export function drafts() {
    return (shared ??= createDraftStore({
        slot: async (place) => (await authClient.rpc('driveDraftSlot', place)).slot,
        // Asked for as it is called (a lock's hook calls it with the key still there), and allowed to
        // finish past that lock (drainOnLock).
        seal: (place, draft) =>
            authClient.rpc('driveDraftSeal', { ...place, draft }, { drainOnLock: true }),
        open: async (place, record) =>
            (await authClient.rpc('driveDraftOpen', { ...place, record })).draft,
    }));
}

/*
 * What the editor holds now, for the writer: null when nothing may be written (no editable text,
 * a read-only or ended session, the restore offer unanswered or the lookup still out, Open theirs
 * under way, no version to start from, or another account session than the editor's).
 * `atBaseline`: the text is what was last opened or saved, so the draft goes instead, if this
 * session owns it.
 */
export type DraftSnapshot = {
    place: DraftPlace;
    atBaseline: boolean;
    draft: () => Draft | null;
};

export type DraftWriter = {
    /* The text changed: a write follows within `delay`, at most one per `delay` while typing. */
    changed(): void;
    /* Writes (or removes an owned draft) now, for hiding, a lock and closing; resolves once done. */
    flush(): Promise<void>;
    /*
     * The text sealed at once, the seal asked for before this returns: called by the lock itself
     * (authClient.beforeLock), while the key is still there. What lands after the lock is ciphertext.
     */
    seize(): Promise<void>;
    /* Removes the draft of `place` now, if this session owns it, after anything queued. */
    remove(place: DraftPlace): Promise<void>;
    /* The person restored (or will discard) this stored draft: this session owns it from here. */
    adopt(place: DraftPlace, owner: DraftOwner): void;
    /* Stops the timer: nothing more is scheduled; what was already asked for still lands. */
    stop(): void;
};

const placeKey = (place: DraftPlace) =>
    `${place.userId.toLowerCase()}/${place.workspaceId.toLowerCase()}/${place.nodeId.toLowerCase()}`;

/*
 * The draft writer's rules. A change schedules a write `delay` later; changes meanwhile ride on it,
 * so typing writes at most once per `delay` and the last change is written within `delay`. A write
 * never happens while locked (`locked`), never without a snapshot, and never for a text at its
 * baseline, which removes the draft instead, and only one this session owns (wrote, or adopted
 * from a restore): an untouched session never deletes. Writes and removals run one at a time, in
 * order, so a removal after a save is never overtaken by a write from before it. `onKept` hears
 * whether the last write was kept.
 */
export function createDraftWriter(options: {
    delay?: number;
    snapshot: () => DraftSnapshot | null;
    /* No key to seal with (locked, signed out, another session): nothing new is started. */
    locked: () => boolean;
    /*
     * Signed out (its database on its way out): nothing more reaches the store. A lock is not
     * this: a draft sealed before it still lands, as ciphertext. Defaults to `locked`.
     */
    ended?: () => boolean;
    store: Pick<DraftStore, 'write' | 'remove'>;
    now?: () => number;
    onKept?: (kept: boolean) => void;
    session?: string;
}): DraftWriter {
    const delay = options.delay ?? DRAFT_WRITE_DELAY_MS;
    const now = options.now ?? Date.now;
    const session = options.session ?? crypto.randomUUID();
    let revision = 0;
    /* What this session may remove, by file: what it wrote last, or adopted. */
    const owned = new Map<string, DraftOwner>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let chain: Promise<void> = Promise.resolve();
    const queue = (work: () => Promise<void>) => {
        const next = chain.then(work, work).catch(() => {});
        chain = next;
        return next;
    };
    const removeOwned = (place: DraftPlace) =>
        queue(async () => {
            const owner = owned.get(placeKey(place));
            if (!owner) return;
            await options.store
                .remove(place, owner)
                .then(() => owned.delete(placeKey(place)))
                .catch(() => {});
        });
    const ended = options.ended ?? options.locked;
    /* The write of `draft`: its seal asked for the moment this is called. */
    const write = async (place: DraftPlace, draft: Draft) => {
        const owner = { session, revision: ++revision };
        const kept = await options.store.write(
            place,
            { ...draft, frame: { ...draft.frame, savedAt: now() } },
            owner,
            () => !ended(),
        );
        if (kept) owned.set(placeKey(place), owner);
        options.onKept?.(kept);
    };
    /*
     * The text is read when the write is asked for, never later: a close writes what was on screen
     * as it closed. The store is reached in order, after anything asked before.
     */
    const run = (atOnce = false) => {
        if (stopped || options.locked()) return chain;
        const snapshot = options.snapshot();
        if (!snapshot) return chain;
        const { place } = snapshot;
        if (snapshot.atBaseline) return removeOwned(place);
        const draft = snapshot.draft();
        // Half of a character just typed: nothing is written this time; the last draft stays.
        if (!draft) return chain;
        // Sealed from here, before the caller goes on (a lock clears the key right after); anything
        // asked for later waits for it.
        if (atOnce) {
            const writing = write(place, draft);
            return queue(() => writing);
        }
        return queue(async () => {
            // Locked since it was asked for: nothing is sealed.
            if (options.locked()) return;
            await write(place, draft);
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
        seize() {
            cancel();
            return run(true);
        },
        remove(place) {
            cancel();
            return removeOwned(place);
        },
        adopt(place, owner) {
            owned.set(placeKey(place), owner);
        },
        stop() {
            stopped = true;
            cancel();
        },
    };
}

/* Past this the editor shows the text without waiting for the lookup, which goes on: no draft is written until it answers. */
export const DRAFT_READ_MS = 2_000;

/*
 * A file's draft as the store answered (`stored`, null for none), or still being read past `ms`
 * (`later`), or not read at all (`failed`). Neither of the last two is "none": a draft not yet
 * read is never written over or removed.
 */
export type DraftLookup =
    | { status: 'answered'; stored: StoredDraft | null }
    | { status: 'waiting'; later: Promise<StoredDraft | null> }
    | { status: 'failed' };

export async function lookUpDraft(
    store: Pick<DraftStore, 'read'>,
    place: DraftPlace,
    ms = DRAFT_READ_MS,
): Promise<DraftLookup> {
    const reading = store.read(place);
    // Read on past `ms`: its failure is the waiting caller's, never an unhandled rejection.
    reading.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            reading.then(
                (stored): DraftLookup => ({ status: 'answered', stored }),
                (): DraftLookup => ({ status: 'failed' }),
            ),
            new Promise<DraftLookup>((resolve) => {
                timer = setTimeout(() => resolve({ status: 'waiting', later: reading }), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
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
