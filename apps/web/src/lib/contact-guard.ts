import type { GuardEntry } from '@hushos/crypto/first-seen';
import { checkGroupPin, mergePin, pinAhead, type GroupPin } from '@hushos/crypto/pins';
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
 * it is never "nothing recorded". Since an id is worked out under the
 * settings key, a person's row looked up under another key would simply be
 * missing, so each account keeps one sealed key-check row beside its rows:
 * a lookup reads "none" only once that row proves the rows here are sealed
 * under the key open now. Rows sealed under another settings key (the server
 * served a new one with a later settings document) fail every read and every
 * write, so that person, and everyone else on this account, pauses with
 * "Couldn't check" rather than starting over as first use; signing out
 * (which deletes the guard) is the way out. A guard written before it was
 * sealed is sealed on the first unlock and its plaintext deleted (migrate).
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

/*
 * A trust-changing act on its way: the key commitment it moves to, from
 * `revision`, and `base`, the stored settings sequence its save was sent over
 * (the server's compare-and-set lands it only while that is still stored).
 * Records from before `base` was kept have none, and are settled as before.
 */
export type PendingAct = { target: string; revision: number; at: string; base?: number };

export interface ContactGuardStore {
    /* This device's entry for one person: null when it has none; throws when it could not be read. */
    entry(userId: string, contactId: string): Promise<GuardEntry | null>;
    /* Every entry of the account, by lowercased contact id; throws when any could not be read. */
    entries(userId: string): Promise<Map<string, GuardEntry>>;
    pending(userId: string, contactId: string): Promise<PendingAct | null>;
    /* Every pending act of the account, by lowercased contact id; throws when any could not be read. */
    pendingAll(userId: string): Promise<Map<string, PendingAct>>;
    putPending(userId: string, contactId: string, act: PendingAct): Promise<void>;
    /*
     * Writes `entry` and deletes the pending record, in one transaction, only
     * over `revision` (0 for none stored): a write that read an earlier
     * revision than is stored throws GuardRacedError and changes nothing, so a
     * delayed write never puts an older entry back. `keep`, a pending act
     * whose save may still land: kept instead, moved to the entry's new
     * revision, in the same transaction.
     */
    commit(
        userId: string,
        contactId: string,
        entry: GuardEntry,
        revision: number,
        keep?: PendingAct,
    ): Promise<void>;
    dropPending(userId: string, contactId: string): Promise<void>;
}

/*
 * The family guard (docs/optional-verification.md 2.8, "per family"): the
 * latest group pin this device accepted for a family, sealed as the contact
 * guard is, in a database of its own (createIndexedDbFamilyGuard), deleted on
 * sign-out, never written to the settings and never cleared by a `not-member`
 * answer. It only ever moves
 * up: every write is mergePin against what is stored, under the account's
 * lock, so a late write of an older pin changes nothing, and one from another
 * history is refused (GuardConflictError) rather than written over it.
 */
export interface FamilyGuardStore {
    /* The guard this device holds for a family: null for none; throws when it could not be read. */
    family(userId: string, groupId: string): Promise<GroupPin | null>;
    /* `pin` merged into what is stored (never lower), and what is stored after; throws when not written. */
    keepFamily(userId: string, groupId: string, pin: GroupPin): Promise<GroupPin>;
}

/* A family guard of another history than the one stored: never written over it. */
export class GuardConflictError extends Error {
    override name = 'GuardConflictError';
    constructor() {
        super('This family looks different on this device. Nothing was saved.');
    }
}

/*
 * The guard merged: what to store over `held`, or null when `held` already
 * covers `pin` (or is ahead of it), so nothing is written. Another history is
 * refused.
 */
export function familyGuardAfter(groupId: string, held: GroupPin | null, pin: GroupPin) {
    const merged = mergePin(groupId, held, pin);
    if (merged === 'conflict') throw new GuardConflictError();
    if (merged === null || !pinAhead(held, merged)) return null;
    return merged;
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
        typeof act.at !== 'string' ||
        !(act.base === undefined || (Number.isSafeInteger(act.base) && act.base >= 0))
    )
        throw new Error('A pending contact act is corrupt.');
    return {
        target: act.target,
        revision: act.revision,
        at: act.at,
        ...(act.base === undefined ? {} : { base: act.base }),
    };
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
        rows: { contactId: string; kind: RowKind; value: unknown }[],
    ): Promise<{ id: string; envelope: string }[]>;
    open(
        userId: string,
        kind: RowKind,
        rows: { id: string; envelope: string }[],
    ): Promise<({ contactId: string; value: unknown } | null)[]>;
};

type RowKind = 'entry' | 'pending' | 'check' | 'family';
/* A family guard row's id is worked out from this, as a contact's is from their account id. */
const familyKey = (groupId: string) => `family:${groupId.toLowerCase()}`;
/* The key-check row's contact id: no account id looks like it, and its kind keeps it apart anyway. */
const KEY_CHECK = 'key-check';
const KEY_CHECK_VALUE = { check: 1 };

/* Before the guard was sealed: its rows in the clear, sealed and deleted on the first unlock. */
type PlainRow<T> = { key: string; userId: string; contactId: string; value: T };
/* A sealed row: found by the account and the row's id; the revision beside it for the commit. */
type SealedRow = { key: string; userId: string; id: string; revision?: number; envelope: string };
interface Schema extends DBSchema {
    entries: { key: string; value: PlainRow<GuardEntry> };
    pending: { key: string; value: PlainRow<PendingAct> };
    'sealed-entries': { key: string; value: SealedRow };
    'sealed-pending': { key: string; value: SealedRow };
    /* One per account, keyed by the account id: which settings key its rows are sealed under. */
    'sealed-check': { key: string; value: SealedRow };
}
/*
 * Version 2 added the sealed stores; version 1's plaintext ones stay until
 * every account moved. Version 3 added the key-check rows. Never raised for
 * something an open tab of an earlier release doesn't need: that tab's
 * connection closes on `versionchange` and can't open this database again
 * (VersionError), so its contacts and sharing stop until it reloads
 * (docs/optional-verification.md 7.3). The family guards have a database of
 * their own for that reason (createIndexedDbFamilyGuard).
 */
const DATABASE_VERSION = 3;

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
                if (oldVersion < 3) db.createObjectStore('sealed-check', { keyPath: 'key' });
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
                // Every sealed row of the account under the key open now, or none of them.
                await keyHolds(userId);
                const sealed = await sealer.seal(userId, values);
                const check = await sealCheck(userId);
                const tx = db.transaction(
                    ['entries', 'pending', 'sealed-entries', 'sealed-pending', 'sealed-check'],
                    'readwrite',
                );
                if (!(await tx.objectStore('sealed-check').get(userId)))
                    await tx.objectStore('sealed-check').put(check);
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

    /* The key-check row for an account, sealed under the key open now. */
    async function sealCheck(userId: string): Promise<SealedRow> {
        await sealer.ready(userId);
        const [{ id, envelope }] = (await sealer.seal(userId, [
            { contactId: KEY_CHECK, kind: 'check', value: KEY_CHECK_VALUE },
        ])) as [{ id: string; envelope: string }];
        return { key: userId, userId, id, envelope };
    }
    /*
     * Whether this account's rows are sealed under the settings key open now:
     * 'empty' when it keeps nothing here, 'held' when its key-check row opens
     * under that key. Throws for a key-check row of another key (or one that
     * does not open), so a row looked up by an id worked out under the wrong
     * key is never read as missing. Rows from before key-check rows existed
     * are proven by opening every one of them, and the row is then written.
     */
    const proven = new Map<string, string>();
    async function keyHolds(userId: string): Promise<'empty' | 'held'> {
        const db = await open();
        const check = await db.get('sealed-check', userId);
        const kept =
            (await db.count('sealed-entries', account(userId))) +
            (await db.count('sealed-pending', account(userId)));
        if (!check && !kept) return 'empty';
        await sealer.ready(userId);
        const [expected] = await sealer.ids(userId, [KEY_CHECK]);
        if (check) {
            if (check.id !== expected)
                throw new Error('These contact records were saved under another settings key.');
            if (proven.get(userId) === check.envelope) return 'held';
            const [opened] = await sealer.open(userId, 'check', [check]);
            if (!opened || opened.contactId !== KEY_CHECK)
                throw new Error('A contact guard record could not be opened.');
            proven.set(userId, check.envelope);
            return 'held';
        }
        const [entries, pending] = await Promise.all([
            db.getAll('sealed-entries', account(userId)),
            db.getAll('sealed-pending', account(userId)),
        ]);
        for (const entry of await openRows(userId, 'entry', entries)) entryOf(entry);
        await openRows(userId, 'pending', pending);
        const row = await sealCheck(userId);
        const tx = db.transaction('sealed-check', 'readwrite');
        if (!(await tx.store.get(userId))) await tx.store.put(row);
        await tx.done;
        return 'held';
    }

    /*
     * The row id of a person, the settings key opened first. Null only when
     * this account keeps no row here at all, which is an honest "none" that
     * needs no key to say; with any row kept, a locked worker, or rows sealed
     * under another settings key, fail the read.
     */
    async function idOf(userId: string, contactId: string) {
        await migrate(userId);
        if ((await keyHolds(userId)) === 'empty') return null;
        const [id] = await sealer.ids(userId, [contactId]);
        if (!id) throw new Error('A contact guard id could not be worked out.');
        return id;
    }
    function openRows(userId: string, kind: 'entry' | 'pending', rows: SealedRow[]) {
        return openSealed(sealer, userId, kind, rows);
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
            if ((await keyHolds(userId)) === 'empty') return new Map();
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
        async pendingAll(userId) {
            await migrate(userId);
            if ((await keyHolds(userId)) === 'empty') return new Map();
            const rows = await (await open()).getAll('sealed-pending', account(userId));
            const out = new Map<string, PendingAct>();
            for (const opened of await openRows(userId, 'pending', rows))
                out.set(opened.contactId, checkPending(opened.value));
            return out;
        },
        async putPending(userId, contactId, act) {
            await migrate(userId);
            // Never a row under one key beside rows under another; the first one brings its check.
            const held = await keyHolds(userId);
            const [{ id, envelope }] = (await sealer.seal(userId, [
                { contactId, kind: 'pending', value: checkPending(act) },
            ])) as [{ id: string; envelope: string }];
            const check = held === 'empty' ? await sealCheck(userId) : null;
            const tx = (await open()).transaction(['sealed-pending', 'sealed-check'], 'readwrite');
            if (check && !(await tx.objectStore('sealed-check').get(userId)))
                await tx.objectStore('sealed-check').put(check);
            await tx
                .objectStore('sealed-pending')
                .put({ key: rowKey(userId, id), userId, id, envelope });
            await tx.done;
        },
        async commit(userId, contactId, entry, revision, keep) {
            await migrate(userId);
            const held = await keyHolds(userId);
            // Sealed first: nothing may await the worker inside the transaction below.
            const [{ id, envelope }, kept] = (await sealer.seal(userId, [
                { contactId, kind: 'entry', value: checkGuardEntry(entry) },
                ...(keep
                    ? [
                          {
                              contactId,
                              kind: 'pending' as const,
                              value: checkPending({ ...keep, revision: entry.revision }),
                          },
                      ]
                    : []),
            ])) as [{ id: string; envelope: string }, { id: string; envelope: string }?];
            const check = held === 'empty' ? await sealCheck(userId) : null;
            const key = rowKey(userId, id);
            const tx = (await open()).transaction(
                ['sealed-entries', 'sealed-pending', 'sealed-check'],
                'readwrite',
            );
            if (check && !(await tx.objectStore('sealed-check').get(userId)))
                await tx.objectStore('sealed-check').put(check);
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
            if (kept)
                await tx
                    .objectStore('sealed-pending')
                    .put({ key, userId, id, envelope: kept.envelope });
            else await tx.objectStore('sealed-pending').delete(key);
            await tx.done;
        },
        async dropPending(userId, contactId) {
            const id = await idOf(userId, contactId);
            if (id === null) return;
            await (await open()).delete('sealed-pending', rowKey(userId, id));
        },
    };
}

/* Rows opened by the sealer; one sealed under another key, for another place, or altered fails. */
async function openSealed(
    sealer: GuardSealer,
    userId: string,
    kind: 'entry' | 'pending' | 'family',
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

export const FAMILY_GUARD_DATABASE = 'hushos-family-guard';

interface FamilySchema extends DBSchema {
    /* One per account, keyed by the account id: which settings key its rows are sealed under. */
    'sealed-check': { key: string; value: SealedRow };
    /* Each family's guard, by the account and the row's id (2.8). */
    'sealed-families': { key: string; value: SealedRow };
}

/*
 * The family guards on this browser (docs/optional-verification.md 2.8, "per
 * family"), sealed by the same worker under the same settings-derived key as
 * the contact guard, with a key-check row of their own, in a database of
 * their own: adding them to the contact guard's would raise its version, and
 * every open tab of an earlier release would lose its contacts until it
 * reloaded. Deleted on sign-out with the rest (lib/device-data.ts).
 */
export function createIndexedDbFamilyGuard(
    sealer: GuardSealer,
    name = FAMILY_GUARD_DATABASE,
): FamilyGuardStore {
    let database: Promise<IDBPDatabase<FamilySchema>> | undefined;
    const open = () =>
        (database ??= openDB<FamilySchema>(name, 1, {
            upgrade(db) {
                db.createObjectStore('sealed-check', { keyPath: 'key' });
                db.createObjectStore('sealed-families', { keyPath: 'key' });
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

    /* The key-check row for an account, sealed under the settings key open now. */
    async function sealCheck(userId: string): Promise<SealedRow> {
        await sealer.ready(userId);
        const [{ id, envelope }] = (await sealer.seal(userId, [
            { contactId: KEY_CHECK, kind: 'check', value: KEY_CHECK_VALUE },
        ])) as [{ id: string; envelope: string }];
        return { key: userId, userId, id, envelope };
    }
    /*
     * 'empty' when this account keeps no family guard here; 'held' when its key-check row
     * opens under the settings key open now. Anything else (a check row of another key, rows
     * with none) fails, so a row looked up by an id worked out under the wrong key is never
     * read as missing.
     */
    const proven = new Map<string, string>();
    async function keyHolds(userId: string): Promise<'empty' | 'held'> {
        const db = await open();
        const check = await db.get('sealed-check', userId);
        const kept = await db.count('sealed-families', account(userId));
        if (!check && !kept) return 'empty';
        if (!check) throw new Error('A family guard record could not be opened.');
        await sealer.ready(userId);
        const [expected] = await sealer.ids(userId, [KEY_CHECK]);
        if (check.id !== expected)
            throw new Error('These family records were saved under another settings key.');
        if (proven.get(userId) === check.envelope) return 'held';
        const [opened] = await sealer.open(userId, 'check', [check]);
        if (!opened || opened.contactId !== KEY_CHECK)
            throw new Error('A family guard record could not be opened.');
        proven.set(userId, check.envelope);
        return 'held';
    }

    /* A family's guard row and the pin it holds: none, or the row opened; a row that does not open fails. */
    async function familyRow(userId: string, groupId: string) {
        if ((await keyHolds(userId)) === 'empty') return { pin: null, row: null };
        const [id] = await sealer.ids(userId, [familyKey(groupId)]);
        if (!id) throw new Error('A family guard id could not be worked out.');
        const row = (await (await open()).get('sealed-families', rowKey(userId, id))) ?? null;
        if (!row) return { pin: null, row: null };
        const [opened] = await openSealed(sealer, userId, 'family', [row]);
        if (opened!.contactId !== familyKey(groupId))
            throw new Error('A family guard record is corrupt.');
        return { pin: checkGroupPin(groupId, opened!.value), row };
    }

    return {
        async family(userId, groupId) {
            return (await familyRow(userId, groupId)).pin;
        },
        keepFamily(userId, groupId, pin) {
            // Every family guard write is a merge, one at a time across this browser's tabs: an
            // older pin written late finds a newer one stored and changes nothing.
            return withGuardLock(userId, async () => {
                const { pin: held, row: before } = await familyRow(userId, groupId);
                const next = familyGuardAfter(groupId, held, pin);
                if (next === null) return held!;
                const stored = await keyHolds(userId);
                const [{ id, envelope }] = (await sealer.seal(userId, [
                    { contactId: familyKey(groupId), kind: 'family', value: next },
                ])) as [{ id: string; envelope: string }];
                const check = stored === 'empty' ? await sealCheck(userId) : null;
                const key = rowKey(userId, id);
                const tx = (await open()).transaction(
                    ['sealed-families', 'sealed-check'],
                    'readwrite',
                );
                if (check && !(await tx.objectStore('sealed-check').get(userId)))
                    await tx.objectStore('sealed-check').put(check);
                // Written only over the row this merge read: anything else is another writer's.
                const now = await tx.objectStore('sealed-families').get(key);
                if ((now?.envelope ?? null) !== (before?.envelope ?? null)) {
                    tx.abort();
                    await tx.done.catch(() => {});
                    throw new GuardRacedError();
                }
                await tx.objectStore('sealed-families').put({ key, userId, id, envelope });
                await tx.done;
                return next;
            });
        },
    };
}

/* The family guard in memory, for tests: the same merge, nothing sealed. */
export function createMemoryFamilyGuard(): FamilyGuardStore & {
    rows: Map<string, GroupPin>;
    failWrites: number;
    failReads: boolean;
} {
    const rows = new Map<string, GroupPin>();
    const store = {
        rows,
        failWrites: 0,
        failReads: false,
        async family(userId: string, groupId: string) {
            if (store.failReads) throw new Error('This store could not be read.');
            return structuredClone(rows.get(`${userId}:${groupId}`) ?? null);
        },
        async keepFamily(userId: string, groupId: string, pin: GroupPin) {
            const held = rows.get(`${userId}:${groupId}`) ?? null;
            const next = familyGuardAfter(groupId, held, pin);
            if (next === null) return structuredClone(held!);
            if (store.failWrites > 0) {
                store.failWrites--;
                throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
            }
            rows.set(`${userId}:${groupId}`, structuredClone(next));
            return structuredClone(next);
        },
    };
    return store;
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
    const lock = `hushos-contact-guard:${userId}`;
    if (typeof navigator !== 'undefined' && navigator.locks)
        return navigator.locks.request(lock, { mode: 'exclusive' }, work) as Promise<T>;
    const previous = local.get(lock) ?? Promise.resolve();
    const next = previous.then(work, work);
    local.set(
        lock,
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
