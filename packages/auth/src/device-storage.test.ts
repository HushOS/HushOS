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
