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
    DeviceStorageTimeout,
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
});

/*
 * At sign-in, only a store that answers "no key" lets this browser register as a new device.
 * A browser that keeps no IndexedDB for the page at all is such an answer; a store that fails
 * to open is not.
 */
describe('the device identity store with nowhere to keep a key', () => {
    it('answers that it holds none when the browser has no IndexedDB', async () => {
        vi.stubGlobal('indexedDB', undefined);
        await expect(createBrowserDeviceIdentityStore().load()).resolves.toBeNull();
    });

    it('answers that it holds none when site storage is refused outright', async () => {
        vi.stubGlobal('indexedDB', {
            open: () => {
                throw new DOMException('The operation is insecure.', 'SecurityError');
            },
        });
        await expect(createBrowserDeviceIdentityStore().load()).resolves.toBeNull();
    });

    it('does not answer when the store fails to open', async () => {
        const reading = createBrowserDeviceIdentityStore().load();
        const failed = expect(reading).rejects.toThrow('Device storage is unavailable.');
        requests[0]!.onerror!();
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
