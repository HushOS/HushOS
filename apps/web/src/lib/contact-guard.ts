import type { GuardEntry } from '@hushos/crypto/first-seen';
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';

/*
 * The contact guard (docs/optional-verification.md 2.8): what this device
 * keeps, per account and per person, of the keys it last acted on, apart from
 * the settings document. A newer copy of the settings that disagrees with it
 * (an older copy saved over at a higher sequence, or an empty one) is caught
 * here, since nothing in the settings can stand in for what this device saw.
 * Never written to the settings and never cleared by anything the server
 * answers. Sign-out deletes it (deleteContactGuard): a browser someone signed
 * out of keeps nothing of whom they shared with, and after signing back in it
 * trusts the server's copy of the contacts, as a new device does.
 *
 * Sealed at rest by the crypto worker under a key derived from the settings
 * key, which exists only while the account is unlocked: a locked browser holds
 * ciphertext, and rows are found by an id that does not say whom they are
 * about. A read that cannot open (locked, another key, a damaged row) fails;
 * it is never "nothing recorded". A guard written before it was sealed is
 * sealed on the first unlock and its plaintext deleted (migrate).
 *
 * Every act that changes whom this device trusts (adding, Continue, a check)
 * commits in four steps (lib/contacts.ts commitTrust): a pending record names
 * the exact keys the act moves to and the revision it starts from; the
 * settings are saved; the entry is written at the next revision and the
 * pending record deleted, in one transaction; only then is the act done. On a
 * restart, or a lost answer to the save, only a pending record that names
 * exactly the settings pin over the entry's current revision lets the device
 * finish silently. Reads that fail are never first use: they are errors.
 */

/* A trust-changing act on its way: the key commitment it moves to, from `revision`. */
export type PendingAct = { target: string; revision: number; at: string };

export interface ContactGuardStore {
    /* This device's entry for one person: null when it has none; throws when it could not be read. */
    entry(userId: string, contactId: string): Promise<GuardEntry | null>;
    /* Every entry of the account, by lowercased contact id; throws when any could not be read. */
    entries(userId: string): Promise<Map<string, GuardEntry>>;
    pending(userId: string, contactId: string): Promise<PendingAct | null>;
    putPending(userId: string, contactId: string, act: PendingAct): Promise<void>;
    /*
     * Writes `entry` and deletes the pending record, in one transaction, only
     * over `revision` (0 for none stored): a write that read an earlier
     * revision than is stored throws GuardRacedError and changes nothing, so a
     * delayed write never puts an older entry back.
     */
    commit(userId: string, contactId: string, entry: GuardEntry, revision: number): Promise<void>;
    dropPending(userId: string, contactId: string): Promise<void>;
}

export const GUARD_UNREADABLE = 'HushOS couldn’t check this right now.';
export const GUARD_UNSAVED =
    'HushOS couldn’t save this on this device. Free up some space, then try again.';
export const GUARD_RACED = 'This changed in another tab. Try again.';

/* The guard could not be read: a pause for that person, never first use. */
export class GuardUnreadableError extends Error {
    override name = 'GuardUnreadableError';
    constructor(cause?: unknown) {
        super(GUARD_UNREADABLE, { cause });
    }
}
/* A trust-changing act whose guard write failed: it stops before it is reported done. */
export class GuardUnsavedError extends Error {
    override name = 'GuardUnsavedError';
    constructor(cause?: unknown) {
        super(GUARD_UNSAVED, { cause });
    }
}
/* Another writer moved the entry between this act's read and its write. */
export class GuardRacedError extends Error {
    override name = 'GuardRacedError';
    constructor() {
        super(GUARD_RACED);
    }
}

/* An entry as stored, or refused: a corrupt entry reads as one that could not be read. */
export function checkGuardEntry(value: unknown): GuardEntry {
    const entry = value as GuardEntry;
    const text = (field: unknown) => typeof field === 'string' && field.length > 0;
    if (
        typeof entry !== 'object' ||
        entry === null ||
        !Number.isSafeInteger(entry.revision) ||
        entry.revision < 1 ||
        !(entry.keyVersion === null || Number.isSafeInteger(entry.keyVersion)) ||
        !text(entry.encryptionPublicKey) ||
        !text(entry.signingPublicKey) ||
        !text(entry.mlDsaPublicKeyHash) ||
        !text(entry.kemPublicKeyHash) ||
        !Array.isArray(entry.previousSigningKeys) ||
        !entry.previousSigningKeys.every(text) ||
        typeof entry.verified !== 'boolean'
    )
        throw new Error('A contact guard entry is corrupt.');
    return {
        revision: entry.revision,
        keyVersion: entry.keyVersion,
        encryptionPublicKey: entry.encryptionPublicKey,
        signingPublicKey: entry.signingPublicKey,
        mlDsaPublicKeyHash: entry.mlDsaPublicKeyHash,
        kemPublicKeyHash: entry.kemPublicKeyHash,
        previousSigningKeys: [...entry.previousSigningKeys],
        verified: entry.verified,
    };
}

function checkPending(value: unknown): PendingAct {
    const act = value as PendingAct;
    if (
        typeof act !== 'object' ||
        act === null ||
        typeof act.target !== 'string' ||
        !Number.isSafeInteger(act.revision) ||
        act.revision < 0 ||
        typeof act.at !== 'string'
    )
        throw new Error('A pending contact act is corrupt.');
    return { target: act.target, revision: act.revision, at: act.at };
}

export const CONTACT_GUARD_DATABASE = 'hushos-contact-guard';

/*
 * What seals the guard: the crypto worker, under a key derived from the
 * settings key (@hushos/crypto contact-guard.ts), which exists only while the
 * account is unlocked. `ready` opens the settings key in the worker when it is
 * not open yet; ids find a row without saying whom it is about.
 */
export type GuardSealer = {
    ready(userId: string): Promise<void>;
    ids(userId: string, contactIds: string[]): Promise<string[]>;
    seal(
        userId: string,
        rows: { contactId: string; kind: 'entry' | 'pending'; value: unknown }[],
    ): Promise<{ id: string; envelope: string }[]>;
    open(
        userId: string,
        kind: 'entry' | 'pending',
        rows: { id: string; envelope: string }[],
    ): Promise<({ contactId: string; value: unknown } | null)[]>;
};

/* Before the guard was sealed: its rows in the clear, sealed and deleted on the first unlock. */
type PlainRow<T> = { key: string; userId: string; contactId: string; value: T };
/* A sealed row: found by the account and the row's id; the revision beside it for the commit. */
type SealedRow = { key: string; userId: string; id: string; revision?: number; envelope: string };
interface Schema extends DBSchema {
    entries: { key: string; value: PlainRow<GuardEntry> };
    pending: { key: string; value: PlainRow<PendingAct> };
    'sealed-entries': { key: string; value: SealedRow };
    'sealed-pending': { key: string; value: SealedRow };
}
/* Version 2 added the sealed stores; version 1's plaintext ones stay until every account moved. */
const DATABASE_VERSION = 2;

const rowKey = (userId: string, id: string) => `${userId}:${id}`;

export function createIndexedDbContactGuard(
    sealer: GuardSealer,
    name = CONTACT_GUARD_DATABASE,
): ContactGuardStore & { migrate(userId: string): Promise<void> } {
    let database: Promise<IDBPDatabase<Schema>> | undefined;
    const open = () =>
        (database ??= openDB<Schema>(name, DATABASE_VERSION, {
            upgrade(db, oldVersion) {
                if (oldVersion < 2) {
                    db.createObjectStore('sealed-entries', { keyPath: 'key' });
                    db.createObjectStore('sealed-pending', { keyPath: 'key' });
                }
            },
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
    const account = (userId: string) => IDBKeyRange.bound(`${userId}:`, `${userId}:\uffff`);

    /*
     * The plaintext rows a version 1 guard left for this account, sealed and
     * then deleted, in one transaction with the sealed rows written: a crash
     * leaves either the plaintext or the sealed rows, never neither. A sealed
     * row already there (another tab moved first) at a revision as high is
     * kept. Once per account per page; a failure (locked, a corrupt row) is
     * tried again on the next read, and the read fails meanwhile.
     */
    const moved = new Map<string, Promise<void>>();
    function migrate(userId: string) {
        let done = moved.get(userId);
        if (!done) {
            done = (async () => {
                const db = await open();
                if (!db.objectStoreNames.contains('entries')) return;
                const read = db.transaction(['entries', 'pending'], 'readonly');
                const [entries, pending] = await Promise.all([
                    read.objectStore('entries').getAll(account(userId)),
                    read.objectStore('pending').getAll(account(userId)),
                ]);
                if (!entries.length && !pending.length) return;
                await sealer.ready(userId);
                const values = [
                    ...entries.map((row) => ({
                        contactId: row.contactId,
                        kind: 'entry' as const,
                        value: checkGuardEntry(row.value),
                    })),
                    ...pending.map((row) => ({
                        contactId: row.contactId,
                        kind: 'pending' as const,
                        value: checkPending(row.value),
                    })),
                ];
                const sealed = await sealer.seal(userId, values);
                const tx = db.transaction(
                    ['entries', 'pending', 'sealed-entries', 'sealed-pending'],
                    'readwrite',
                );
                for (const [index, row] of values.entries()) {
                    const { id, envelope } = sealed[index]!;
                    const store = tx.objectStore(
                        row.kind === 'entry' ? 'sealed-entries' : 'sealed-pending',
                    );
                    const existing = await store.get(rowKey(userId, id));
                    const revision = row.kind === 'entry' ? (row.value as GuardEntry).revision : 0;
                    if (!existing || (row.kind === 'entry' && (existing.revision ?? 0) < revision))
                        await store.put({
                            key: rowKey(userId, id),
                            userId,
                            id,
                            ...(row.kind === 'entry' ? { revision } : {}),
                            envelope,
                        });
                }
                for (const row of entries) await tx.objectStore('entries').delete(row.key);
                for (const row of pending) await tx.objectStore('pending').delete(row.key);
                await tx.done;
            })();
            moved.set(userId, done);
            done.catch(() => {
                if (moved.get(userId) === done) moved.delete(userId);
            });
        }
        return done;
    }

    /*
     * The row id of a person, the settings key opened first. Null only when
     * this account keeps no row here at all, which is an honest "none" that
     * needs no key to say; with any row kept, a locked worker fails the read.
     */
    async function idOf(userId: string, contactId: string) {
        await migrate(userId);
        const db = await open();
        const kept =
            (await db.count('sealed-entries', account(userId))) +
            (await db.count('sealed-pending', account(userId)));
        if (!kept) return null;
        await sealer.ready(userId);
        const [id] = await sealer.ids(userId, [contactId]);
        if (!id) throw new Error('A contact guard id could not be worked out.');
        return id;
    }
    async function openRows(
        userId: string,
        kind: 'entry' | 'pending',
        rows: SealedRow[],
    ): Promise<{ contactId: string; value: unknown; row: SealedRow }[]> {
        if (!rows.length) return [];
        await sealer.ready(userId);
        const opened = await sealer.open(
            userId,
            kind,
            rows.map((row) => ({ id: row.id, envelope: row.envelope })),
        );
        return rows.map((row, index) => {
            const value = opened[index];
            // Sealed under another key, for another place, or altered: never read as none.
            if (!value) throw new Error('A contact guard record could not be opened.');
            return { ...value, row };
        });
    }
    function entryOf(opened: { value: unknown; row: SealedRow }) {
        const entry = checkGuardEntry(opened.value);
        // The revision the commit compares, in the clear beside the envelope, must be the sealed one.
        if (entry.revision !== opened.row.revision)
            throw new Error('A contact guard entry is corrupt.');
        return entry;
    }
    return {
        migrate,
        async entry(userId, contactId) {
            const id = await idOf(userId, contactId);
            if (id === null) return null;
            const row = await (await open()).get('sealed-entries', rowKey(userId, id));
            if (!row) return null;
            const [opened] = await openRows(userId, 'entry', [row]);
            if (opened!.contactId !== contactId.toLowerCase())
                throw new Error('A contact guard entry is corrupt.');
            return entryOf(opened!);
        },
        async entries(userId) {
            await migrate(userId);
            const rows = await (await open()).getAll('sealed-entries', account(userId));
            const out = new Map<string, GuardEntry>();
            for (const opened of await openRows(userId, 'entry', rows))
                out.set(opened.contactId, entryOf(opened));
            return out;
        },
        async pending(userId, contactId) {
            const id = await idOf(userId, contactId);
            if (id === null) return null;
            const row = await (await open()).get('sealed-pending', rowKey(userId, id));
            if (!row) return null;
            const [opened] = await openRows(userId, 'pending', [row]);
            if (opened!.contactId !== contactId.toLowerCase())
                throw new Error('A pending contact act is corrupt.');
            return checkPending(opened!.value);
        },
        async putPending(userId, contactId, act) {
            await migrate(userId);
            await sealer.ready(userId);
            const [{ id, envelope }] = (await sealer.seal(userId, [
                { contactId, kind: 'pending', value: checkPending(act) },
            ])) as [{ id: string; envelope: string }];
            await (
                await open()
            ).put('sealed-pending', {
                key: rowKey(userId, id),
                userId,
                id,
                envelope,
            });
        },
        async commit(userId, contactId, entry, revision) {
            await migrate(userId);
            await sealer.ready(userId);
            // Sealed first: nothing may await the worker inside the transaction below.
            const [{ id, envelope }] = (await sealer.seal(userId, [
                { contactId, kind: 'entry', value: checkGuardEntry(entry) },
            ])) as [{ id: string; envelope: string }];
            const key = rowKey(userId, id);
            const tx = (await open()).transaction(
                ['sealed-entries', 'sealed-pending'],
                'readwrite',
            );
            const stored = await tx.objectStore('sealed-entries').get(key);
            const at = stored?.revision ?? 0;
            if (at !== revision) {
                tx.abort();
                await tx.done.catch(() => {});
                throw new GuardRacedError();
            }
            await tx
                .objectStore('sealed-entries')
                .put({ key, userId, id, revision: entry.revision, envelope });
            await tx.objectStore('sealed-pending').delete(key);
            await tx.done;
        },
        async dropPending(userId, contactId) {
            const id = await idOf(userId, contactId);
            if (id === null) return;
            await (await open()).delete('sealed-pending', rowKey(userId, id));
        },
    };
}

/*
 * Sign-out (lib/sign-out.ts): every account's guard on this browser goes, the
 * plaintext rows of a version 1 guard included. After signing back in this
 * device trusts the server's copy of the contacts, as a new device does
 * (docs/optional-verification.md 2.8). An open connection in another tab lets
 * go when asked (the store's `blocking`), so the deletion is not held up.
 */
export function deleteContactGuard(name = CONTACT_GUARD_DATABASE) {
    if (typeof indexedDB === 'undefined') return Promise.resolve();
    return deleteDB(name, {
        blocked() {
            // Every connection this app opens closes on `blocking`; one that does not is a
            // tab of an older release, and the deletion lands once it closes.
        },
    });
}

/*
 * The account's trust-changing acts, one at a time across this browser's
 * tabs (a Web Lock), or in this tab alone where there are none.
 */
const local = new Map<string, Promise<unknown>>();
export function withGuardLock<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const name = `hushos-contact-guard:${userId}`;
    if (typeof navigator !== 'undefined' && navigator.locks)
        return navigator.locks.request(name, { mode: 'exclusive' }, work) as Promise<T>;
    const previous = local.get(name) ?? Promise.resolve();
    const next = previous.then(work, work);
    local.set(
        name,
        next.catch(() => {}),
    );
    return next;
}

/*
 * Asks the browser once per page to keep this site's storage rather than
 * clear it under pressure. A refusal, or a browser without the call, leaves
 * the guard in best-effort storage, which is the loss residual of 2.8; nothing
 * else changes, so the answer is only reported, never acted on.
 */
let persisting: Promise<boolean> | undefined;
export function askPersistentStorage(): Promise<boolean> {
    persisting ??= (async () => {
        try {
            const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
            return storage?.persist ? await storage.persist() : false;
        } catch {
            return false;
        }
    })();
    return persisting;
}
