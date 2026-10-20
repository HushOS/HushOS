import { openDB, type DBSchema, type IDBPDatabase, type OpenDBCallbacks } from 'idb';

/*
 * One IndexedDB connection, opened on first use and kept, which lets go whenever it can no
 * longer serve: another tab (or this one) deleting or upgrading the database, the browser
 * closing it on its own (WebKit does when its storage process goes away), or an open that
 * failed. The next call opens a fresh one.
 *
 * Only "close" can come from a connection that is no longer the cached one: a connection let
 * go on versionchange stays open until its transactions finish, and the browser can still
 * close it for good in that time (site data cleared, storage lost), after the next call
 * cached its successor. So only that handler checks which connection it belongs to.
 * versionchange never reaches a connection already closing, and an open that fails was never
 * replaced, since only its own success-time events replace it.
 */
export function cachedConnection<Schema extends DBSchema>(
    name: string,
    version: number,
    upgrade: OpenDBCallbacks<Schema>['upgrade'],
): () => Promise<IDBPDatabase<Schema>> {
    let database: Promise<IDBPDatabase<Schema>> | undefined;
    return () => {
        if (database) return database;
        const opening: Promise<IDBPDatabase<Schema>> = openDB<Schema>(name, version, {
            upgrade,
            blocking(_current, _next, event) {
                (event.target as IDBDatabase).close();
                database = undefined;
            },
            terminated() {
                if (database === opening) database = undefined;
            },
        });
        database = opening;
        opening.catch(() => {
            database = undefined;
        });
        return opening;
    };
}
