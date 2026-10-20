import { openDB, type DBSchema, type IDBPDatabase, type OpenDBCallbacks } from 'idb';

/*
 * One IndexedDB connection, opened on first use and kept, which lets go whenever it can no
 * longer serve: another tab (or this one) deleting or upgrading the database, the browser
 * closing it on its own (WebKit does when its storage process goes away), or an open that
 * failed. The next call opens a fresh one. A late event from a connection already replaced
 * never drops its successor.
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
                if (database === opening) database = undefined;
            },
            terminated() {
                if (database === opening) database = undefined;
            },
        });
        database = opening;
        opening.catch(() => {
            if (database === opening) database = undefined;
        });
        return opening;
    };
}
