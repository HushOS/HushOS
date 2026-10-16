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

// Storage is an adapter; crypto owns the portable, versioned device envelope.
export type DeviceKeyStore = {
    create: () => Promise<{ id: string; key: CryptoKey }>;
    load: (id: string) => Promise<CryptoKey | null>;
    clear: () => Promise<void>;
};
export function createBrowserDeviceKeyStore(): DeviceKeyStore {
    function open(): Promise<IDBDatabase> {
        return withTimeout(
            new Promise((resolve, reject) => {
                const request = indexedDB.open('hushos-device-keys', 1);
                request.onupgradeneeded = () => request.result.createObjectStore('keys');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(new Error('Device storage is unavailable.'));
                request.onblocked = () =>
                    reject(new Error('Device storage is busy in another tab.'));
            }),
        );
    }
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
    function open(): Promise<IDBDatabase> {
        return withTimeout(
            new Promise((resolve, reject) => {
                const request = indexedDB.open('hushos-device-identity', 1);
                request.onupgradeneeded = () => request.result.createObjectStore('identity');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(new Error('Device storage is unavailable.'));
                request.onblocked = () =>
                    reject(new Error('Device storage is busy in another tab.'));
            }),
        );
    }
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
            const db = await open();
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
