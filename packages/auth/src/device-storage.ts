import { createDeviceKey } from '@hushos/crypto/device';

// Storage is an adapter; crypto owns the portable, versioned device envelope.
export type DeviceKeyStore = {
    create: () => Promise<{ id: string; key: CryptoKey }>;
    load: (id: string) => Promise<CryptoKey | null>;
    clear: () => Promise<void>;
};
export function createBrowserDeviceKeyStore(): DeviceKeyStore {
    function open(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('hushos-device-keys', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('keys');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(new Error('Device storage is unavailable.'));
        });
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
                return await new Promise<CryptoKey | null>((resolve, reject) => {
                    const request = db.transaction('keys', 'readonly').objectStore('keys').get(id);
                    request.onsuccess = () =>
                        resolve(
                            request.result instanceof CryptoKey && !request.result.extractable
                                ? request.result
                                : null,
                        );
                    request.onerror = () => reject(new Error('Could not read this device key.'));
                });
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
