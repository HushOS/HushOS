import {
    IDBCursor,
    IDBCursorWithValue,
    IDBDatabase,
    IDBFactory,
    IDBIndex,
    IDBKeyRange,
    IDBObjectStore,
    IDBOpenDBRequest,
    IDBRequest,
    IDBTransaction,
    IDBVersionChangeEvent,
} from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createBrowserDeviceIdentityStore,
    createBrowserDeviceKeyStore,
    DeviceStorageBlocked,
    DeviceStorageTimeout,
    DeviceStorageUnavailable,
} from './device-storage';

/*
 * IndexedDB on Safari can answer an open long after anyone waits for it. The device stores give
 * up after eight seconds; a connection that lands after that must be closed as it lands, since
 * nothing else will close it and an open connection blocks the database's deletion or upgrade
 * from every tab.
 */

type FakeRequest = {
    result?: unknown;
    onupgradeneeded?: () => void;
    onsuccess?: () => void;
    onerror?: () => void;
    onblocked?: () => void;
};

let requests: FakeRequest[] = [];

beforeEach(() => {
    vi.useFakeTimers();
    requests = [];
    vi.stubGlobal('indexedDB', {
        open: () => {
            const request: FakeRequest = {};
            requests.push(request);
            return request;
        },
    });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function connection() {
    return { close: vi.fn(), onversionchange: null as null | (() => void) };
}

const stores = [
    ['the device key store', () => createBrowserDeviceKeyStore().load('key-1')],
    ['the device identity store', () => createBrowserDeviceIdentityStore().load()],
] as const;

describe.each(stores)('%s', (_, read) => {
    it('closes a connection that arrives after the open gave up', async () => {
        const reading = read();
        const failed = expect(reading).rejects.toBeInstanceOf(DeviceStorageTimeout);
        await vi.advanceTimersByTimeAsync(8_000);
        await failed;

        const late = connection();
        requests[0]!.result = late;
        requests[0]!.onsuccess!();
        expect(late.close).toHaveBeenCalledTimes(1);
    });

    it('closes a connection that arrives after the open was refused as blocked', async () => {
        const reading = read();
        const failed = expect(reading).rejects.toThrow('busy in another tab');
        requests[0]!.onblocked!();
        await failed;

        const late = connection();
        requests[0]!.result = late;
        requests[0]!.onsuccess!();
        expect(late.close).toHaveBeenCalledTimes(1);
    });

    it('lets go of an open connection when another tab deletes or upgrades the database', async () => {
        void read().catch(() => {});
        const db = {
            ...connection(),
            // The read itself stays pending: the store never answers it.
            transaction: () => ({ objectStore: () => ({ get: () => ({}) }) }),
        };
        requests[0]!.result = db;
        requests[0]!.onsuccess!();
        await vi.advanceTimersByTimeAsync(0);
        expect(db.close).not.toHaveBeenCalled();

        db.onversionchange!();
        expect(db.close).toHaveBeenCalledTimes(1);
    });
});

/*
 * At sign-in, only a store that answers "no key" lets this browser register as a new device
 * without asking; anything else stops the sign-in with a reason (client.ts). Each way a browser
 * can fail to open the store, and what it must be read as.
 */
describe('the device identity store when it cannot simply be read', () => {
    const load = () => createBrowserDeviceIdentityStore().load();
    /* The open fails after `upgraded` (the database was being created) with `name`. */
    function failOpen(name: string, message: string, upgraded = false) {
        const reading = load();
        const request = requests[0]!;
        if (upgraded) {
            request.result = { createObjectStore: vi.fn() };
            request.onupgradeneeded!();
        }
        Object.assign(request, { error: new DOMException(message, name) });
        request.onerror!();
        return reading;
    }

    it('holds no key where the browser has no IndexedDB', async () => {
        vi.stubGlobal('indexedDB', undefined);
        await expect(load()).resolves.toBeNull();
    });

    it('holds no key where reading indexedDB itself is refused', async () => {
        vi.unstubAllGlobals();
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
        Object.defineProperty(globalThis, 'indexedDB', {
            configurable: true,
            get() {
                throw new DOMException('The operation is insecure.', 'SecurityError');
            },
        });
        try {
            await expect(load()).resolves.toBeNull();
        } finally {
            if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor);
            else delete (globalThis as { indexedDB?: unknown }).indexedDB;
        }
    });

    it('holds no key where opening is refused outright with SecurityError', async () => {
        vi.stubGlobal('indexedDB', {
            open: () => {
                throw new DOMException('The operation is insecure.', 'SecurityError');
            },
        });
        await expect(load()).resolves.toBeNull();
    });

    it('holds no key when a full disk fails the open that was creating the database', async () => {
        await expect(
            failOpen('QuotaExceededError', 'The quota has been exceeded.', true),
        ).resolves.toBeNull();
    });

    it('holds no key when the open creating the database outlasts the wait', async () => {
        const reading = load();
        requests[0]!.result = { createObjectStore: vi.fn() };
        requests[0]!.onupgradeneeded!();
        const answered = expect(reading).resolves.toBeNull();
        await vi.advanceTimersByTimeAsync(8_000);
        await answered;
    });

    it.each([
        [
            'Chrome with site data blocked',
            'UnknownError',
            'The user denied permission to access the database.',
        ],
        [
            'a corrupted database',
            'UnknownError',
            'Internal error opening backing store for indexedDB.open.',
        ],
        [
            'Firefox before 115 in a private window',
            'InvalidStateError',
            'A mutation operation was attempted on a database that did not allow mutations.',
        ],
    ])('is unavailable, not empty, for %s', async (_, name, message) => {
        await expect(failOpen(name, message)).rejects.toBeInstanceOf(DeviceStorageUnavailable);
    });

    it('is blocked when another tab holds the database across an upgrade', async () => {
        const reading = load();
        requests[0]!.onblocked!();
        await expect(reading).rejects.toBeInstanceOf(DeviceStorageBlocked);
    });

    it('is slow when an existing database does not open in time', async () => {
        const reading = load();
        const failed = expect(reading).rejects.toBeInstanceOf(DeviceStorageTimeout);
        await vi.advanceTimersByTimeAsync(8_000);
        await failed;
    });
});

/*
 * Another tab upgrading the device key database while this one writes a key: the connection
 * lets go on versionchange, and the write already under way must land rather than abort, so the
 * key is there for the next restore. A real IndexedDB in memory (fake-indexeddb).
 */
describe('a key write when another tab upgrades the database', () => {
    beforeEach(() => {
        vi.useRealTimers();
        const globals = {
            IDBCursor,
            IDBCursorWithValue,
            IDBDatabase,
            IDBIndex,
            IDBKeyRange,
            IDBObjectStore,
            IDBOpenDBRequest,
            IDBRequest,
            IDBTransaction,
            IDBVersionChangeEvent,
        };
        for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
    });

    it('lands, and the other tab’s upgrade goes ahead once it has', async () => {
        const factory = new IDBFactory();
        let upgrade: Promise<IDBDatabase> | undefined;
        const open = factory.open.bind(factory);
        factory.open = (name: string, version?: number) => {
            const request = open(name, version);
            // The moment this tab's connection opens, before its write starts, the other tab
            // asks for version 2; this tab hears versionchange while the write is under way.
            if (name === 'hushos-device-keys' && version === 1 && !upgrade)
                request.addEventListener('success', () => {
                    upgrade = new Promise((resolve, reject) => {
                        const other = open('hushos-device-keys', 2);
                        other.onsuccess = () => resolve(other.result);
                        other.onerror = () => reject(other.error);
                    });
                });
            return request;
        };
        vi.stubGlobal('indexedDB', factory);

        const { id } = await createBrowserDeviceKeyStore().create();
        const other = await upgrade!;
        const stored = await new Promise((resolve, reject) => {
            const request = other.transaction('keys').objectStore('keys').get(id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        other.close();
        expect(stored).toBeInstanceOf(CryptoKey);
        expect((stored as CryptoKey).extractable).toBe(false);
    });
});
