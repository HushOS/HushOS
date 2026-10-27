import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    ACCOUNT_DATA,
    deleteDatabase,
    forgetBrowserData,
    KEPT,
    onSignedOutElsewhere,
    watchSignOutElsewhere,
} from './device-data';

/*
 * The owner's rule: once someone signs out, this browser holds nothing of
 * theirs. Each name below is what the app writes today; a registry that
 * forgets one leaves it behind, and this fails.
 */

const ID = '0f6d6c1e-2a49-4d8b-9b1a-4b3f4b8c1d01';
const WORKSPACE = 'a1a1a1a1-0000-4000-8000-000000000001';

beforeEach(() => {
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
    vi.stubGlobal('indexedDB', new IDBFactory());
    localStorage.clear();
    sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

function makeDatabase(name: string) {
    return new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('rows').put('row', 'key');
        request.onsuccess = () => {
            request.result.close();
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
}
const databases = async () =>
    (await indexedDB.databases()).map((database) => database.name ?? '').sort();

/* The private file system's root, as far as the deletion reaches it. */
function fileRoot(names: string[]) {
    const entries = new Set(names);
    return {
        entries,
        root: {
            async removeEntry(name: string) {
                if (!entries.delete(name)) throw new DOMException('Gone', 'NotFoundError');
            },
        },
    };
}

const keys = (storage: Storage) =>
    Array.from({ length: storage.length }, (_, index) => storage.key(index)!).sort();

describe('signing out of this browser', () => {
    test('deletes everything kept for the account and keeps only how the site looks', async () => {
        for (const key of [
            'hushos-device-unlock',
            'hushos.return',
            'hushos-stash-written',
            'hushos.marks:Xq3v9b0aZ8kTn1r2Lw4p5A',
            `hushos.settings-seen:${ID}`,
            `hushos.settings-seen:${ID}:old-identity-key`,
            `hushos.settings-document-seen:${ID}`,
            `hushos.identity-seen:${ID}`,
            `hushos.identity-seen:${ID}:version`,
            // How the site looks and sounds: kept.
            'hushos-sounds',
            'hushos.drive.view',
            'hushos.folder-sort',
            'hushos-json-view',
            // Another app on the origin: not ours.
            'someone-else',
        ])
            localStorage.setItem(key, '1');
        for (const key of [
            'hushos-link-sent',
            'hushos.invite',
            'hushos.family-checkout',
            'hushos-device-removed',
        ])
            sessionStorage.setItem(key, '1');
        for (const name of [
            'hushos-device-identity',
            'hushos-device-keys',
            'hushos-drive',
            'hushos-drive-mirror',
            'hushos-groups',
            `hushos-drive-mirror:${WORKSPACE}`,
            'someone-elses-database',
        ])
            await makeDatabase(name);
        const files = fileRoot([
            'upload-stash-sealed',
            'upload-stash-revision',
            'upload-stash',
            'someone-elses-file',
        ]);

        await forgetBrowserData({ files: async () => files.root });

        expect(keys(localStorage)).toEqual(
            [
                'hushos-sounds',
                'hushos.drive.view',
                'hushos.folder-sort',
                'hushos-json-view',
                'someone-else',
            ].sort(),
        );
        // The removal notice is read and deleted by the sign-in page that follows it.
        expect(keys(sessionStorage)).toEqual(['hushos-device-removed']);
        // Deleted, not emptied: no database is left to say HushOS was used here.
        expect(await databases()).toEqual(['someone-elses-database']);
        expect([...files.entries]).toEqual(['someone-elses-file']);
    });

    test('with no private file system here, succeeds only if no stash was ever written', async () => {
        const none = () => Promise.reject(new DOMException('No', 'SecurityError'));
        await expect(forgetBrowserData({ files: none })).resolves.toBeUndefined();
        localStorage.setItem('hushos-stash-written', '1');
        await expect(forgetBrowserData({ files: none })).rejects.toThrow();
        // Kept, so the next try still knows a stash may be left there.
        expect(localStorage.getItem('hushos-stash-written')).toBe('1');
    });

    test('tells every other tab, with no saved unlock ever written here', async () => {
        // Saving the device key failed at sign-in: there is no entry whose removal other tabs see.
        expect(localStorage.getItem('hushos-device-unlock')).toBeNull();
        const otherTab = new BroadcastChannel('hushos-signed-out');
        const heard = new Promise(
            (resolve) => (otherTab.onmessage = (event) => resolve(event.data)),
        );
        await forgetBrowserData({ files: async () => fileRoot([]).root });
        expect(await heard).toBe('signed-out');
        otherTab.close();
    });

    test('a tab that hears another sign out drops its session entries and its uploads', async () => {
        const stop = watchSignOutElsewhere();
        const uploadsDropped = vi.fn();
        const stopListening = onSignedOutElsewhere(uploadsDropped);
        try {
            sessionStorage.setItem('hushos-link-sent', '{"email":"maya@example.com"}');
            sessionStorage.setItem('hushos.invite', 'token');
            sessionStorage.setItem('hushos-device-removed', '1');
            // The other tab's sign-out, as it says it: no hand-made event.
            const { announceSignOut } = await import('./device-data');
            announceSignOut();
            await vi.waitFor(() => expect(uploadsDropped).toHaveBeenCalledOnce());
            expect(keys(sessionStorage)).toEqual(['hushos-device-removed']);
        } finally {
            stopListening();
            stop();
        }
    });
});

describe('deleting a database', () => {
    /* A factory whose deletes never answer, as one queued behind a stalled delete gets. */
    function silentFactory() {
        const asked: string[] = [];
        vi.stubGlobal('indexedDB', {
            deleteDatabase: (name: string) => {
                asked.push(name);
                return {};
            },
        });
        return asked;
    }

    test('gives up when the browser never answers, counted from when it was asked', async () => {
        vi.useFakeTimers();
        try {
            silentFactory();
            const deletion = deleteDatabase('hushos-drive', 1_000);
            const settled = vi.fn();
            deletion.catch(settled);
            await vi.advanceTimersByTimeAsync(999);
            expect(settled).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(2);
            expect(settled).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    test('a second ask waits on the first instead of queueing behind it, within its own deadline', async () => {
        vi.useFakeTimers();
        try {
            const asked = silentFactory();
            const first = deleteDatabase('hushos-groups', 1_000).catch((error: Error) => error);
            await vi.advanceTimersByTimeAsync(600);
            const second = deleteDatabase('hushos-groups', 1_000).catch((error: Error) => error);
            await vi.advanceTimersByTimeAsync(500);
            expect(await first).toBeInstanceOf(Error);
            expect(asked).toEqual(['hushos-groups']);
            await vi.advanceTimersByTimeAsync(600);
            expect(await second).toBeInstanceOf(Error);
            expect(asked).toEqual(['hushos-groups']);
        } finally {
            vi.useRealTimers();
        }
    });
});

/*
 * Every storage name in the source is registered (deleted at sign-out) or kept on purpose. A
 * store added without a line in device-data.ts would outlive sign-out; this names it.
 */
describe('the registry', () => {
    // The repository: vitest runs from apps/web.
    const root = `${join(process.cwd(), '../..')}/`;
    const STORAGE_API =
        /localStorage|sessionStorage|indexedDB|openDB\(|cachedConnection|openDeviceDatabase|getDirectoryHandle|getFileHandle|setCookie\(|document\.cookie/;
    const NAME = /['"`](hushos[-.][A-Za-z0-9._:-]*|upload-stash[A-Za-z0-9-]*)['"`]/g;
    // Names in those files that are not storage: a BroadcastChannel or a Web Lock.
    const NOT_STORAGE = new Set([
        'hushos-auth',
        'hushos-device',
        'hushos-link-used',
        'hushos-rollback-marks',
    ]);

    function sources(dir: string): string[] {
        return readdirSync(dir).flatMap((entry) => {
            const path = join(dir, entry);
            if (statSync(path).isDirectory())
                return entry === 'node_modules' || entry === 'test' ? [] : sources(path);
            return /\.tsx?$/.test(entry) && !/\.test\.|\.spec\.|testkit/.test(entry) ? [path] : [];
        });
    }

    test('names every store the source writes', () => {
        const packages = join(root, 'packages');
        const files = [
            ...sources(join(root, 'apps/web/src')),
            ...readdirSync(packages).flatMap((name) => {
                const src = join(packages, name, 'src');
                try {
                    return sources(src);
                } catch {
                    return [];
                }
            }),
        ].filter((path) => !path.endsWith('device-data.ts'));
        const registered: string[] = [
            ...ACCOUNT_DATA.local.keys,
            ...ACCOUNT_DATA.session.keys,
            ...ACCOUNT_DATA.databases.names,
            ...ACCOUNT_DATA.files.entries,
            ACCOUNT_DATA.files.marker,
            ...KEPT.cookies,
            ...KEPT.local,
            ...KEPT.session,
        ];
        const prefixes: string[] = [
            ...ACCOUNT_DATA.local.prefixes,
            ...ACCOUNT_DATA.databases.prefixes,
        ];
        const found = new Map<string, string>();
        for (const path of files) {
            const text = readFileSync(path, 'utf8');
            if (!STORAGE_API.test(text)) continue;
            for (const [, name] of text.matchAll(NAME)) found.set(name!, path.slice(root.length));
        }
        // The scan reaches the stores it is meant to: a broken pattern would pass on nothing.
        expect(found.get('hushos-device-unlock')).toBe('packages/auth/src/store.ts');
        expect(found.get('hushos-drive')).toBe('packages/drive/src/journal.ts');
        const unregistered = [...found]
            .filter(
                ([name]) =>
                    !NOT_STORAGE.has(name) &&
                    !registered.includes(name) &&
                    !prefixes.some((prefix) => name === prefix || name.startsWith(prefix)),
            )
            .map(([name, path]) => `${name} (${path})`);
        expect(unregistered).toEqual([]);
    });
});
