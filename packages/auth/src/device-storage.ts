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
 * This browser keeps no IndexedDB for the page at all (no API, or site storage refused outright
 * with SecurityError), so nothing can be stored here: unlike a store that is busy, slow or
 * failing, it is known to hold no key.
 */
export class NoDeviceStorage extends Error {
    constructor(options?: { cause?: unknown }) {
        super('This browser keeps no device storage for HushOS.', options);
        this.name = 'NoDeviceStorage';
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
function openDeviceDatabase(name: string, store: string): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined' || !indexedDB)
        return Promise.reject(new NoDeviceStorage());
    let request: IDBOpenDBRequest;
    try {
        request = indexedDB.open(name, 1);
    } catch (error) {
        return Promise.reject(
            error instanceof DOMException && error.name === 'SecurityError'
                ? new NoDeviceStorage({ cause: error })
                : error,
        );
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            settled = true;
            reject(new DeviceStorageTimeout());
        }, STORAGE_TIMEOUT_MS);
        const settle = () => {
            if (settled) return false;
            settled = true;
            clearTimeout(timer);
            return true;
        };
        request.onupgradeneeded = () => request.result.createObjectStore(store);
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
            if (settle()) reject(new Error('Device storage is unavailable.'));
        };
        request.onblocked = () => {
            if (settle()) reject(new Error('Device storage is busy in another tab.'));
        };
    });
}

// Storage is an adapter; crypto owns the portable, versioned device envelope.
export type DeviceKeyStore = {
    create: () => Promise<{ id: string; key: CryptoKey }>;
    load: (id: string) => Promise<CryptoKey | null>;
    clear: () => Promise<void>;
};
export function createBrowserDeviceKeyStore(): DeviceKeyStore {
    const open = () => openDeviceDatabase('hushos-device-keys', 'keys');
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
        clear: () =>
            write((store) => {
                store.clear();
            }),
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
    clear: () => Promise<void>;
};
const IDENTITY_KEY = 'current';
export function createBrowserDeviceIdentityStore(): DeviceIdentityStore {
    const open = () => openDeviceDatabase('hushos-device-identity', 'identity');
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
        clear: () =>
            write((store) => {
                store.clear();
            }),
    };
}
