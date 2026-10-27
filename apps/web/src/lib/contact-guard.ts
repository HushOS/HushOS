import type { GuardEntry } from '@hushos/crypto/first-seen';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/*
 * The contact guard (docs/optional-verification.md 2.8): what this device
 * keeps, per account and per person, of the keys it last acted on, apart from
 * the settings document. A newer copy of the settings that disagrees with it
 * (an older copy saved over at a higher sequence, or an empty one) is caught
 * here, since nothing in the settings can stand in for what this device saw.
 * Never written to the settings, never cleared by anything the server
 * answers, and kept through sign-out, as the rollback marks are: only the
 * browser clearing site data makes this a new device again.
 *
 * Public keys and their digests only, in the clear: nothing here opens
 * anything, and a page that could rewrite it could rewrite the app too.
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

const keyOf = (userId: string, contactId: string) => `${userId}:${contactId.toLowerCase()}`;

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

type Row<T> = { key: string; userId: string; contactId: string; value: T };
interface Schema extends DBSchema {
    entries: { key: string; value: Row<GuardEntry> };
    pending: { key: string; value: Row<PendingAct> };
}

export function createIndexedDbContactGuard(name = CONTACT_GUARD_DATABASE): ContactGuardStore {
    let database: Promise<IDBPDatabase<Schema>> | undefined;
    const open = () =>
        (database ??= openDB<Schema>(name, 1, {
            upgrade(db) {
                db.createObjectStore('entries', { keyPath: 'key' });
                db.createObjectStore('pending', { keyPath: 'key' });
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
    const account = (userId: string) => IDBKeyRange.bound(`${userId}:`, `${userId}:￿`);
    return {
        async entry(userId, contactId) {
            const row = await (await open()).get('entries', keyOf(userId, contactId));
            return row ? checkGuardEntry(row.value) : null;
        },
        async entries(userId) {
            const rows = await (await open()).getAll('entries', account(userId));
            return new Map(rows.map((row) => [row.contactId, checkGuardEntry(row.value)]));
        },
        async pending(userId, contactId) {
            const row = await (await open()).get('pending', keyOf(userId, contactId));
            return row ? checkPending(row.value) : null;
        },
        async putPending(userId, contactId, act) {
            const key = keyOf(userId, contactId);
            await (
                await open()
            ).put('pending', { key, userId, contactId: contactId.toLowerCase(), value: act });
        },
        async commit(userId, contactId, entry, revision) {
            const key = keyOf(userId, contactId);
            const tx = (await open()).transaction(['entries', 'pending'], 'readwrite');
            const stored = await tx.objectStore('entries').get(key);
            const at = stored ? checkGuardEntry(stored.value).revision : 0;
            if (at !== revision) {
                tx.abort();
                await tx.done.catch(() => {});
                throw new GuardRacedError();
            }
            await tx
                .objectStore('entries')
                .put({ key, userId, contactId: contactId.toLowerCase(), value: entry });
            await tx.objectStore('pending').delete(key);
            await tx.done;
        },
        async dropPending(userId, contactId) {
            await (await open()).delete('pending', keyOf(userId, contactId));
        },
    };
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
