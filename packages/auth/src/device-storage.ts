import { createDeviceKey } from '@hushos/crypto/device';

/*
 * IndexedDB on iOS Safari can leave a request without any event at all, most
 * often after the page comes back from the background. A restore that waits
 * on it would spin forever, so every step here gives up after a while and says
 * so; the caller then asks for the password instead of dropping the device.
 */
export class DeviceStorageTimeout extends Error {
    constructor() {
        super('Device storage did not respond.');
        this.name = 'DeviceStorageTimeout';
    }
}
/*
 * A device store known to hold no key: the browser keeps no IndexedDB for the page at all (no
 * API, or SecurityError), or the database did not exist until this open created it (whatever
 * happened after that, nothing was ever stored in it).
 */
export class NoDeviceStorage extends Error {
    constructor(options?: { cause?: unknown }) {
        super('This browser keeps no device storage for HushOS.', options);
        this.name = 'NoDeviceStorage';
    }
}
/* Another tab holds the database open across an upgrade or a deletion. */
export class DeviceStorageBlocked extends Error {
    constructor() {
        super('Device storage is busy in another tab.');
        this.name = 'DeviceStorageBlocked';
    }
}
/*
 * The database exists, or may, and could not be opened: site data blocked (Chrome says
 * UnknownError), a corrupted backing store, a full disk, an old private mode. Whether it holds a
 * key is unknown.
 */
export class DeviceStorageUnavailable extends Error {
    constructor(options?: { cause?: unknown }) {
        super('Device storage is unavailable.', options);
        this.name = 'DeviceStorageUnavailable';
    }
}
const STORAGE_TIMEOUT_MS = 8_000;
function withTimeout<T>(work: Promise<T>) {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new DeviceStorageTimeout()), STORAGE_TIMEOUT_MS);
        work.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
            },
        );
    });
}

/*
 * Opens one of the device databases, giving up after STORAGE_TIMEOUT_MS. An open that answers
 * after that is closed as it lands: nothing would ever use or close it, and a connection left
 * open blocks the database's deletion or upgrade from any tab. One open now can also be let go
 * when another tab wants to delete or upgrade the database.
 */
function openDeviceDatabase(name: string, store: string, version: number): Promise<IDBDatabase> {
    let request: IDBOpenDBRequest;
    try {
        // Reading `indexedDB` itself can throw (SecurityError where site storage is refused).
        const factory = typeof indexedDB === 'undefined' ? undefined : indexedDB;
        if (!factory) return Promise.reject(new NoDeviceStorage());
        request = factory.open(name, version);
    } catch (error) {
        return Promise.reject(
            error instanceof DOMException && error.name === 'SecurityError'
                ? new NoDeviceStorage({ cause: error })
                : new DeviceStorageUnavailable({ cause: error }),
        );
    }
    // Set once this open created the database: until then it did not exist, so it holds no key.
    let created = false;
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            settled = true;
            reject(created ? new NoDeviceStorage() : new DeviceStorageTimeout());
        }, STORAGE_TIMEOUT_MS);
        const settle = () => {
            if (settled) return false;
            settled = true;
            clearTimeout(timer);
            return true;
        };
        request.onupgradeneeded = (event) => {
            // Only an upgrade from nothing creates the database. A later version's upgrade runs
            // on a database that may already hold a key, which must still be read.
            if (event.oldVersion === 0) created = true;
            if (!request.result.objectStoreNames.contains(store))
                request.result.createObjectStore(store);
        };
        request.onsuccess = () => {
            const db = request.result;
            if (!settle()) {
                db.close();
                return;
            }
            db.onversionchange = () => db.close();
            resolve(db);
        };
        request.onerror = () => {
            if (!settle()) return;
            const cause = request.error;
            reject(
                created ? new NoDeviceStorage({ cause }) : new DeviceStorageUnavailable({ cause }),
            );
        };
        request.onblocked = () => {
            if (settle()) reject(new DeviceStorageBlocked());
        };
    });
}

/*
 * Deletes a device database outright, rather than emptying it: a browser
 * signed out of keeps no trace of one (apps/web lib/device-data.ts). Every
 * connection here closes after its step and on `versionchange`, so a `blocked`
 * is waited out, never longer than STORAGE_TIMEOUT_MS.
 */
function deleteDeviceDatabase(name: string): Promise<void> {
    let request: IDBOpenDBRequest;
    try {
        const factory = typeof indexedDB === 'undefined' ? undefined : indexedDB;
        if (!factory) return Promise.resolve();
        request = factory.deleteDatabase(name);
    } catch (error) {
        // SecurityError where site storage is refused: there is nothing to delete.
        if (error instanceof DOMException && error.name === 'SecurityError')
            return Promise.resolve();
        return Promise.reject(new DeviceStorageUnavailable({ cause: error }));
    }
    let blocked = false;
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(blocked ? new DeviceStorageBlocked() : new DeviceStorageTimeout()),
            STORAGE_TIMEOUT_MS,
        );
        request.onsuccess = () => {
            clearTimeout(timer);
            resolve();
        };
        request.onerror = () => {
            clearTimeout(timer);
            reject(new DeviceStorageUnavailable({ cause: request.error }));
        };
        request.onblocked = () => {
            blocked = true;
        };
    });
}

// Storage is an adapter; crypto owns the portable, versioned device envelope.
export type DeviceKeyStore = {
    create: () => Promise<{ id: string; key: CryptoKey }>;
    load: (id: string) => Promise<CryptoKey | null>;
    /* Forgets every key; the browser's store deletes its database. */
    clear: () => Promise<void>;
};
/* The device databases' version; bumped only with an upgrade that keeps what they hold. */
const DEVICE_DATABASE_VERSION = 1;
export function createBrowserDeviceKeyStore(): DeviceKeyStore {
    const open = () => openDeviceDatabase('hushos-device-keys', 'keys', DEVICE_DATABASE_VERSION);
    async function write(action: (store: IDBObjectStore) => void) {
        const db = await open();
        try {
            await new Promise<void>((resolve, reject) => {
                const transaction = db.transaction('keys', 'readwrite');
                transaction.oncomplete = () => resolve();
                transaction.onabort = transaction.onerror = () =>
                    reject(new Error('Could not save this device key.'));
                action(transaction.objectStore('keys'));
            });
        } finally {
            db.close();
        }
    }
    return {
        async create() {
            const key = await createDeviceKey();
            const id = crypto.randomUUID();
            await write((store) => {
                store.clear();
                store.put(key, id);
            });
            return { id, key };
        },
        async load(id) {
            const db = await open();
            try {
                return await withTimeout(
                    new Promise<CryptoKey | null>((resolve, reject) => {
                        const request = db
                            .transaction('keys', 'readonly')
                            .objectStore('keys')
                            .get(id);
                        request.onsuccess = () =>
                            resolve(
                                request.result instanceof CryptoKey && !request.result.extractable
                                    ? request.result
                                    : null,
                            );
                        request.onerror = () =>
                            reject(new Error('Could not read this device key.'));
                    }),
                );
            } finally {
                db.close();
            }
        },
        clear: () => deleteDeviceDatabase('hushos-device-keys'),
    };
}

/*
 * The device key (docs/devices-design.md, step 1), in its own database: the
 * remembered-unlock store above is wiped at every sign-in and lock, and this
 * key must outlive both, so the next sign-in comes back to the same device.
 * The private key is a non-extractable Ed25519 CryptoKey; the email is kept
 * only as its digest. Signing out, deleting the account and learning the
 * device was removed clear it.
 */
export type StoredDeviceIdentity = {
    userId: string;
    emailHash: string;
    deviceId: string;
    privateKey: CryptoKey;
    publicKey: string;
};
export type DeviceIdentityStore = {
    load: () => Promise<StoredDeviceIdentity | null>;
    save: (identity: StoredDeviceIdentity) => Promise<void>;
    /* Forgets the key; the browser's store deletes its database. */
    clear: () => Promise<void>;
};
const IDENTITY_KEY = 'current';
/* `version` is for an upgrade's own test: a later version must still read an earlier one's key. */
export function createBrowserDeviceIdentityStore({
    version = DEVICE_DATABASE_VERSION,
}: { version?: number } = {}): DeviceIdentityStore {
    const open = () => openDeviceDatabase('hushos-device-identity', 'identity', version);
    async function write(action: (store: IDBObjectStore) => void) {
        const db = await open();
        try {
            await withTimeout(
                new Promise<void>((resolve, reject) => {
                    const transaction = db.transaction('identity', 'readwrite');
                    transaction.oncomplete = () => resolve();
                    transaction.onabort = transaction.onerror = () =>
                        reject(transaction.error ?? new Error('Could not save this device’s key.'));
                    action(transaction.objectStore('identity'));
                }),
            );
        } finally {
            db.close();
        }
    }
    return {
        async load() {
            let db: IDBDatabase;
            try {
                db = await open();
            } catch (error) {
                // Nowhere to keep a key is an answer: there is none. Anything else is not.
                if (error instanceof NoDeviceStorage) return null;
                throw error;
            }
            try {
                return await withTimeout(
                    new Promise<StoredDeviceIdentity | null>((resolve, reject) => {
                        const request = db
                            .transaction('identity', 'readonly')
                            .objectStore('identity')
                            .get(IDENTITY_KEY);
                        request.onsuccess = () => {
                            const value = request.result as
                                | Partial<StoredDeviceIdentity>
                                | undefined;
                            resolve(
                                value &&
                                    typeof value.userId === 'string' &&
                                    typeof value.emailHash === 'string' &&
                                    typeof value.deviceId === 'string' &&
                                    typeof value.publicKey === 'string' &&
                                    value.privateKey instanceof CryptoKey &&
                                    !value.privateKey.extractable
                                    ? (value as StoredDeviceIdentity)
                                    : null,
                            );
                        };
                        request.onerror = () =>
                            reject(new Error('Could not read this device’s key.'));
                    }),
                );
            } finally {
                db.close();
            }
        },
        save: (identity) =>
            write((store) => {
                store.put(identity, IDENTITY_KEY);
            }),
        clear: () => deleteDeviceDatabase('hushos-device-identity'),
    };
}
