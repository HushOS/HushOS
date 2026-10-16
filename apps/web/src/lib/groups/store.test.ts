import { afterEach, describe, expect, test, vi } from 'vitest';
import { deleteGroupDevice } from './store';

/*
 * Sign-out (the 1c plan, 1.3): membership is the social graph, so every
 * family's sealed records and every family folder's Drive mirror leave the
 * device with the session, and nothing of another app's storage goes with
 * them. A database another tab holds open makes it fail, so the caller tries
 * again rather than report the device clean.
 */

function fakeIndexedDb(names: string[], blocked = new Set<string>()) {
    const deleted: string[] = [];
    vi.stubGlobal('indexedDB', {
        databases: async () => names.map((name) => ({ name, version: 1 })),
        deleteDatabase: (name: string) => {
            const request = {} as {
                onsuccess?: () => void;
                onerror?: () => void;
                onblocked?: () => void;
            };
            queueMicrotask(() => {
                if (blocked.has(name)) request.onblocked?.();
                else {
                    deleted.push(name);
                    request.onsuccess?.();
                }
            });
            return request;
        },
    });
    return deleted;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('signing out', () => {
    test('deletes the families database and every family folder’s mirror, and nothing else', async () => {
        const deleted = fakeIndexedDb([
            'hushos-groups',
            'hushos-drive-mirror:a1a1a1a1-0000-4000-8000-000000000001',
            'hushos-drive-mirror:a2a2a2a2-0000-4000-8000-000000000002',
            // Personal Drive's mirror and upload journal are cleared by their own owners.
            'hushos-drive-mirror',
            'hushos-drive',
        ]);
        await deleteGroupDevice();
        expect(deleted.sort()).toEqual([
            'hushos-drive-mirror:a1a1a1a1-0000-4000-8000-000000000001',
            'hushos-drive-mirror:a2a2a2a2-0000-4000-8000-000000000002',
            'hushos-groups',
        ]);
    });

    test('fails while another tab keeps a mirror open, so the removal is not acknowledged', async () => {
        vi.useFakeTimers();
        fakeIndexedDb(
            ['hushos-groups', 'hushos-drive-mirror:a1a1a1a1-0000-4000-8000-000000000001'],
            new Set(['hushos-drive-mirror:a1a1a1a1-0000-4000-8000-000000000001']),
        );
        const done = deleteGroupDevice();
        const settled = expect(done).rejects.toThrow('busy');
        await vi.advanceTimersByTimeAsync(10_000);
        await settled;
    });

    test('where the browser cannot list databases, the mirrors the family records name are deleted', async () => {
        const deleted = fakeIndexedDb([]);
        (globalThis.indexedDB as { databases?: unknown }).databases = undefined;
        await deleteGroupDevice(async () => ['a1a1a1a1-0000-4000-8000-000000000001']);
        expect(deleted.sort()).toEqual([
            'hushos-drive-mirror:a1a1a1a1-0000-4000-8000-000000000001',
            'hushos-groups',
        ]);
    });
});
