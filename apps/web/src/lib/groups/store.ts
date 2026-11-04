import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { deleteDatabase } from '@/lib/device-data';

/*
 * What this device keeps of its families (the 1c plan, 1.3), in IndexedDB
 * `hushos-groups`. Every value is an envelope the crypto worker sealed under a
 * key derived from the account root and bound to the account, the group and
 * the store (session-groups.ts, "The device store"); nothing here is readable
 * without the unlocked account, and a record moved to another group or store
 * does not open. Beside each envelope sit only the keys it is found by:
 *
 * - `chains`: the device record (chain cache and device pin), sealed by
 *   groupAccept. `rosterVersion` (where the next route 5 page starts) and
 *   `areas` (whose Drive mirrors a wipe deletes) are hints in the clear: a
 *   wrong version only makes the worker refuse and the sync start again from
 *   version 1, and a wrong area list only deletes the wrong mirrors. A record
 *   sealed under an earlier account root (a master-key rotation) does not
 *   open: the worker says `record-unreadable`, and sync.ts deletes it and
 *   accepts again from version 1 against the settings pin alone. Outbox and
 *   joins records that do not open are deleted too, and the person told.
 * - `outbox`: roster calls not yet known to have landed (outbox.ts).
 * - `joins`: the code a newcomer compared and matched, sealed by the worker
 *   only, kept between "They match" and the join's end (join.ts).
 * - `holds`: a newcomer's join escalation (the held positions and the
 *   family's wrong pair), sealed by the worker, so a reload or a lock keeps
 *   them. Deleted only when the worker hands back none or says it does not
 *   open; a family wipe leaves it, so a join on screen keeps its alarm.
 *
 * Group ids sit in the keys, so the database says which families this device
 * holds; the account's own server knows that anyway, and sign-out deletes it.
 */

export const GROUPS_DATABASE = 'hushos-groups';
/* Each family folder's Drive mirror: `hushos-drive-mirror:<workspaceId>` (1c plan, 1.3). */
export const AREA_MIRROR_PREFIX = 'hushos-drive-mirror:';

export type ChainRow = {
    userId: string;
    groupId: string;
    envelope: string;
    rosterVersion: number;
    areas: string[];
};
export type OutboxRow = { id: string; userId: string; groupId: string; envelope: string };
export type JoinRow = { userId: string; groupId: string; envelope: string };
export type HoldsRow = { userId: string; groupId: string; envelope: string };

export interface GroupStore {
    chain(userId: string, groupId: string): Promise<ChainRow | null>;
    /*
     * Writes the record unless one at a later roster version is stored: records
     * reach disk in commit order, so an acceptance that finished late never
     * puts an older record back (a rollback the next sync would accept from).
     */
    putChain(row: ChainRow): Promise<void>;
    deleteChain(userId: string, groupId: string): Promise<void>;
    /* The outbox of one group, or of every group this account has entries for. */
    outbox(userId: string, groupId?: string): Promise<OutboxRow[]>;
    putOutbox(row: OutboxRow): Promise<void>;
    deleteOutbox(id: string): Promise<void>;
    join(userId: string, groupId: string): Promise<JoinRow | null>;
    putJoin(row: JoinRow): Promise<void>;
    deleteJoin(userId: string, groupId: string): Promise<void>;
    holds(userId: string, groupId: string): Promise<HoldsRow | null>;
    putHolds(row: HoldsRow): Promise<void>;
    deleteHolds(userId: string, groupId: string): Promise<void>;
    /* Everything kept of one group: its record, outbox and pending join (never its join escalation). */
    forgetGroup(userId: string, groupId: string): Promise<void>;
}

const keyOf = (userId: string, groupId: string) => `${userId}:${groupId}`;

interface Schema extends DBSchema {
    chains: { key: string; value: ChainRow & { key: string } };
    outbox: { key: string; value: OutboxRow & { group: string }; indexes: { group: string } };
    joins: { key: string; value: JoinRow & { key: string } };
    holds: { key: string; value: HoldsRow & { key: string } };
}

/* Version 2 added `holds`; a version 1 database keeps its stores and gains it. */
const DATABASE_VERSION = 2;
function createStores(db: IDBPDatabase<Schema>, oldVersion: number) {
    if (oldVersion < 1) {
        db.createObjectStore('chains', { keyPath: 'key' });
        db.createObjectStore('outbox', { keyPath: 'id' }).createIndex('group', 'group');
        db.createObjectStore('joins', { keyPath: 'key' });
    }
    if (oldVersion < 2) db.createObjectStore('holds', { keyPath: 'key' });
}

export function createIndexedDbGroupStore(name = GROUPS_DATABASE): GroupStore {
    let database: Promise<IDBPDatabase<Schema>> | undefined;
    const open = () =>
        (database ??= openDB<Schema>(name, DATABASE_VERSION, {
            upgrade: (db, oldVersion) => createStores(db, oldVersion),
            // Sign-out in another tab deletes the database: let it go rather than block it.
            blocking(_current, _next, event) {
                (event.target as IDBDatabase).close();
                database = undefined;
            },
            terminated() {
                database = undefined;
            },
        }));
    return {
        async chain(userId, groupId) {
            const row = await (await open()).get('chains', keyOf(userId, groupId));
            if (!row) return null;
            const { key: _key, ...rest } = row;
            return rest;
        },
        async putChain(row) {
            const tx = (await open()).transaction('chains', 'readwrite');
            const key = keyOf(row.userId, row.groupId);
            const stored = await tx.store.get(key);
            if (!stored || stored.rosterVersion <= row.rosterVersion)
                await tx.store.put({ ...row, key });
            await tx.done;
        },
        async deleteChain(userId, groupId) {
            await (await open()).delete('chains', keyOf(userId, groupId));
        },
        async outbox(userId, groupId) {
            const db = await open();
            const rows = groupId
                ? await db.getAllFromIndex('outbox', 'group', keyOf(userId, groupId))
                : (await db.getAll('outbox')).filter((row) => row.userId === userId);
            return rows.map(({ group: _group, ...rest }) => rest);
        },
        async putOutbox(row) {
            await (await open()).put('outbox', { ...row, group: keyOf(row.userId, row.groupId) });
        },
        async deleteOutbox(id) {
            await (await open()).delete('outbox', id);
        },
        async join(userId, groupId) {
            const row = await (await open()).get('joins', keyOf(userId, groupId));
            if (!row) return null;
            const { key: _key, ...rest } = row;
            return rest;
        },
        async putJoin(row) {
            await (await open()).put('joins', { ...row, key: keyOf(row.userId, row.groupId) });
        },
        async deleteJoin(userId, groupId) {
            await (await open()).delete('joins', keyOf(userId, groupId));
        },
        async holds(userId, groupId) {
            const row = await (await open()).get('holds', keyOf(userId, groupId));
            if (!row) return null;
            const { key: _key, ...rest } = row;
            return rest;
        },
        async putHolds(row) {
            await (await open()).put('holds', { ...row, key: keyOf(row.userId, row.groupId) });
        },
        async deleteHolds(userId, groupId) {
            await (await open()).delete('holds', keyOf(userId, groupId));
        },
        async forgetGroup(userId, groupId) {
            const db = await open();
            const tx = db.transaction(['chains', 'outbox', 'joins'], 'readwrite');
            const key = keyOf(userId, groupId);
            await tx.objectStore('chains').delete(key);
            await tx.objectStore('joins').delete(key);
            const index = tx.objectStore('outbox').index('group');
            let cursor = await index.openKeyCursor(key);
            while (cursor) {
                await tx.objectStore('outbox').delete(cursor.primaryKey);
                cursor = await cursor.continue();
            }
            await tx.done;
        },
    };
}

/* The same, in memory: for tests only (nothing survives a reload, so F7 and creation would not hold). */
export function createMemoryGroupStore(): GroupStore {
    const chains = new Map<string, ChainRow>();
    const outbox = new Map<string, OutboxRow>();
    const joins = new Map<string, JoinRow>();
    const holds = new Map<string, HoldsRow>();
    const copy = <T>(value: T) => structuredClone(value);
    return {
        chain: async (userId, groupId) => copy(chains.get(keyOf(userId, groupId)) ?? null),
        putChain: async (row) => {
            const stored = chains.get(keyOf(row.userId, row.groupId));
            if (!stored || stored.rosterVersion <= row.rosterVersion)
                chains.set(keyOf(row.userId, row.groupId), copy(row));
        },
        deleteChain: async (userId, groupId) => void chains.delete(keyOf(userId, groupId)),
        outbox: async (userId, groupId) =>
            [...outbox.values()]
                .filter((row) => row.userId === userId && (!groupId || row.groupId === groupId))
                .map(copy),
        putOutbox: async (row) => void outbox.set(row.id, copy(row)),
        deleteOutbox: async (id) => void outbox.delete(id),
        join: async (userId, groupId) => copy(joins.get(keyOf(userId, groupId)) ?? null),
        putJoin: async (row) => void joins.set(keyOf(row.userId, row.groupId), copy(row)),
        deleteJoin: async (userId, groupId) => void joins.delete(keyOf(userId, groupId)),
        holds: async (userId, groupId) => copy(holds.get(keyOf(userId, groupId)) ?? null),
        putHolds: async (row) => void holds.set(keyOf(row.userId, row.groupId), copy(row)),
        deleteHolds: async (userId, groupId) => void holds.delete(keyOf(userId, groupId)),
        forgetGroup: async (userId, groupId) => {
            chains.delete(keyOf(userId, groupId));
            joins.delete(keyOf(userId, groupId));
            for (const [id, row] of outbox)
                if (row.userId === userId && row.groupId === groupId) outbox.delete(id);
        },
    };
}

/*
 * Where IndexedDB is not available (a private window that blocks it, an old
 * browser): reads find nothing, and every write is refused, since a family
 * change that cannot outlive the tab would break the outbox's rules (a call
 * resent as signed, a creator's seed kept until the first pin).
 */
export function createUnavailableGroupStore(): GroupStore {
    const refuse = async () => {
        throw new Error(
            'This browser can’t keep family changes on this device. Allow site storage for HushOS, or use another browser.',
        );
    };
    return {
        chain: async () => null,
        putChain: refuse,
        deleteChain: async () => {},
        outbox: async () => [],
        putOutbox: refuse,
        deleteOutbox: async () => {},
        join: async () => null,
        putJoin: refuse,
        deleteJoin: async () => {},
        holds: async () => null,
        putHolds: refuse,
        deleteHolds: async () => {},
        forgetGroup: async () => {},
    };
}

/*
 * Sign-out (1c plan, 1.3): the families database and every family folder's
 * Drive mirror. The mirrors are found by name (indexedDB.databases), so a
 * mirror of a family this device has since forgotten goes too.
 */
export async function deleteGroupDevice(known: () => Promise<string[]> = knownAreas) {
    if (typeof indexedDB === 'undefined') return;
    const names = new Set([GROUPS_DATABASE]);
    if (typeof indexedDB.databases === 'function') {
        for (const { name } of await indexedDB.databases())
            if (name?.startsWith(AREA_MIRROR_PREFIX)) names.add(name);
    } else {
        // No list of databases: the folders this device's family records name.
        for (const id of await known()) names.add(AREA_MIRROR_PREFIX + id);
    }
    await Promise.all([...names].map((name) => deleteDatabase(name)));
}

/* Every family folder the device records name, read before the database goes. */
async function knownAreas() {
    const db = await openDB<Schema>(GROUPS_DATABASE, DATABASE_VERSION, {
        upgrade: (database, oldVersion) => createStores(database, oldVersion),
    });
    try {
        return (await db.getAll('chains')).flatMap((row) => row.areas);
    } finally {
        db.close();
    }
}

/* One family folder's mirror, when a wipe forgets the family (outbox.ts). */
export async function deleteAreaMirrors(workspaceIds: readonly string[]) {
    if (typeof indexedDB === 'undefined') return;
    await Promise.all(workspaceIds.map((id) => deleteDatabase(AREA_MIRROR_PREFIX + id)));
}
