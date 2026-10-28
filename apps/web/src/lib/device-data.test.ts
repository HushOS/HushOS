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
    announceSignOut,
    deleteDatabase,
    forgetBrowserData,
    KEPT,
    onSignedOutElsewhere,
    SERVER_COOKIES,
    STORAGE_OWNERS,
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
            'hushos-contact-guard',
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
        const heard = new Promise<{ kind: string }>(
            (resolve) => (otherTab.onmessage = (event) => resolve(event.data)),
        );
        await forgetBrowserData({ files: async () => fileRoot([]).root });
        expect((await heard).kind).toBe('signing-out');
        otherTab.close();
    });
});

/* Two tabs of one browser: each its own copy of the module, sharing the BroadcastChannel. */
async function anotherTab() {
    vi.resetModules();
    return import('./device-data');
}

describe('telling other tabs', () => {
    test('a tab that hears another sign out drops its session entries and releases its uploads', async () => {
        const other = await anotherTab();
        const stop = other.watchSignOutElsewhere();
        let release!: () => void;
        const releasing = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        const stopListening = other.onSignedOutElsewhere(releasing);
        try {
            sessionStorage.setItem('hushos-link-sent', '{"email":"maya@example.com"}');
            sessionStorage.setItem('hushos.invite', 'token');
            sessionStorage.setItem('hushos-device-removed', '1');
            let finished = false;
            const told = announceSignOut({ heardWithin: 50, releasedWithin: 3_000 }).then(
                (result) => {
                    finished = true;
                    return result;
                },
            );
            await vi.waitFor(() => expect(releasing).toHaveBeenCalledOnce());
            expect(keys(sessionStorage)).toEqual(['hushos-device-removed']);
            // The signing-out tab waits for the release, not merely for the message to land.
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(finished).toBe(false);
            release();
            expect(await told).toEqual({ heard: 1, released: 1 });
        } finally {
            stopListening();
            stop();
        }
    });

    test('waits for a tab that never releases only so long', async () => {
        const other = await anotherTab();
        const stop = other.watchSignOutElsewhere();
        const stopListening = other.onSignedOutElsewhere(() => new Promise(() => {}));
        try {
            const started = Date.now();
            expect(await announceSignOut({ heardWithin: 50, releasedWithin: 400 })).toEqual({
                heard: 1,
                released: 0,
            });
            expect(Date.now() - started).toBeLessThan(1_000);
        } finally {
            stopListening();
            stop();
        }
    });

    test('a tab never acts on its own sign-out, which its own listener also hears', async () => {
        const stop = watchSignOutElsewhere();
        const releasing = vi.fn();
        const stopListening = onSignedOutElsewhere(releasing);
        try {
            sessionStorage.setItem('hushos.invite', 'token');
            expect(await announceSignOut({ heardWithin: 50, releasedWithin: 200 })).toEqual({
                heard: 0,
                released: 0,
            });
            // Its uploads are stopped by its own sign-out, after it has looked at them.
            expect(releasing).not.toHaveBeenCalled();
            expect(sessionStorage.getItem('hushos.invite')).toBe('token');
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
 * Only the files in STORAGE_OWNERS reach browser storage, each with the names it declares,
 * and every declared name is registered for the same place. A store added any other way would
 * outlive sign-out; these checks name it.
 */
type Owners = typeof STORAGE_OWNERS;
type Source = { path: string; text: string };
const API: Record<string, RegExp> = {
    local: /\blocalStorage\b/,
    session: /\bsessionStorage\b/,
    databases: /\bindexedDB\b|\bopenDB\b|\bcachedConnection\(|\bopenDeviceDatabase\(/,
    files: /\bgetDirectory\(|\bgetDirectoryHandle\(|\bgetFileHandle\(/,
    cookies: /\bdocument\.cookie\b|\b[sg]etCookie\(/,
};
/* Names that look like storage and are not: channels, Web Locks, downloads, formats, a slug. */
const NOT_STORAGE = new Set([
    'hushos-auth',
    'hushos-signed-out',
    'hushos-link-used',
    'hushos-device',
    'hushos-sign-out',
    'hushos-rollback-marks',
    'hushos-stash',
    'hushos-area-walk:',
    'hushos-group-write:',
    // The contact guard's Web Lock, per account (lib/contact-guard.ts withGuardLock).
    'hushos-contact-guard:',
    'hushos-recovery-kit.txt',
    'hushos-report-',
    'hushos-keys',
    'hushos-sealed',
    'hushos-api',
    'hushos-api-context',
    'hushos.logging.stripped',
    'hushos-1-0',
]);
const NAME = /(['"`])((?:hushos[-.:]|upload-stash|tsr-|sidebar_)[^'"`$\s]*)(\1|\$\{)/g;
/*
 * Each storage call by the place it reaches, and the expression its name is given as. A web
 * storage reached through a variable (`storage.getItem`) counts for the web storage the file
 * owns.
 */
const CALLS: [string, RegExp][] = [
    ['local', /\blocalStorage\.(?:get|set|remove)Item\(\s*([^,)]+)/g],
    ['session', /\bsessionStorage\.(?:get|set|remove)Item\(\s*([^,)]+)/g],
    [
        'databases',
        /(?<!function\s)\b(?:indexedDB\.(?:open|deleteDatabase)|openDB|cachedConnection|openDeviceDatabase|deleteDeviceDatabase|deleteDatabase)(?:<[^>(]*>)?\(\s*([^,)]+)/g,
    ],
    ['files', /\b(?:getDirectoryHandle|getFileHandle|removeEntry)\(\s*([^,)]+)/g],
    ['cookies', /\b[sg]etCookie\(\s*([^,)]+)/g],
    ['cookies', /\bdocument\.cookie\s*=\s*(`\$\{\w+\})/g],
];
const WEB_STORAGE = /\b(?!(?:local|session)Storage\b)\w+\.(?:get|set|remove)Item\(\s*([^,)]+)/g;

/*
 * The name an argument stands for in `body`: a literal, a template's head, or a constant (or
 * a parameter's default) it resolves to, in this file; `head` when more is added to it. Null
 * when it does not resolve here: a parameter, an import, a computed value.
 */
function resolve(
    expression: string,
    body: string,
    depth = 0,
): { name: string; head: boolean } | null {
    const text = expression.trim();
    const literal = /^(['"`])([^'"`$]*)(\1|\$\{)/.exec(text);
    if (literal)
        return {
            name: literal[2]!,
            head: literal[3] === '${' || /[+]/.test(text.slice(literal[0].length)),
        };
    const leading = /^`\$\{(\w+)\}/.exec(text) ?? /^(\w+)(\s*\+|$)/.exec(text);
    if (!leading || depth > 2) return null;
    const name = leading[1]!;
    // A constant (`const NAME = …`) or a parameter's default (`(NAME = …` or `, NAME: T = …`).
    const assigned =
        new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*([^;\\n]+)`).exec(body) ??
        new RegExp(`[(,]\\s*${name}\\s*(?::\\s*[\\w.]+)?\\s*=\\s*([^,)\\n]+)`).exec(body);
    if (!assigned) return null;
    const found = resolve(assigned[1]!, body, depth + 1);
    if (!found) return null;
    return { name: found.name, head: found.head || text !== name };
}

function registered(domain: string): string[] {
    const local = [
        ...ACCOUNT_DATA.local.keys,
        ...ACCOUNT_DATA.local.prefixes,
        ACCOUNT_DATA.files.marker,
    ];
    return {
        local: [...local, ...KEPT.local],
        session: [...ACCOUNT_DATA.session.keys, ...KEPT.session],
        databases: [...ACCOUNT_DATA.databases.names, ...ACCOUNT_DATA.databases.prefixes],
        files: [...ACCOUNT_DATA.files.entries],
        cookies: [...KEPT.cookies, ...SERVER_COOKIES],
    }[domain]!;
}
const code = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const covers = (names: readonly string[], name: string, head = false) =>
    names.some(
        (declared) =>
            declared === name ||
            (declared.endsWith(':') && name.startsWith(declared)) ||
            (head && declared.startsWith(name)),
    );

function audit(files: Source[], owners: Owners = STORAGE_OWNERS) {
    const problems: string[] = [];
    const namesOf = (domains: Owners[string]) =>
        Object.entries(domains)
            .filter(([domain]) => domain !== 'passThrough')
            .flatMap(([, names]) => [...((names as readonly string[] | undefined) ?? [])]);
    const everyDeclared = Object.values(owners).flatMap(namesOf);
    for (const [path, domains] of Object.entries(owners))
        for (const [domain, names] of Object.entries(domains))
            if (domain !== 'passThrough')
                for (const name of names ?? [])
                    if (!covers(registered(domain), name))
                        problems.push(`${path}: ${name} is not registered under ${domain}`);
    for (const { path, text } of files) {
        if (path.endsWith('apps/web/src/lib/device-data.ts')) continue;
        const body = code(text);
        const own = owners[path];
        for (const [domain, pattern] of Object.entries(API))
            if (
                pattern.test(body) &&
                !own?.[domain as Exclude<keyof Owners[string], 'passThrough'>]
            )
                problems.push(`${path}: reaches ${domain} storage without being its owner`);
        const declared = own ? namesOf(own) : [];
        for (const [, , name, end] of body.matchAll(NAME)) {
            const head = end === '${';
            if (NOT_STORAGE.has(name!)) continue;
            const ok = own ? covers(declared, name!, head) : covers(everyDeclared, name!, head);
            if (!ok)
                problems.push(`${path}: ${name}${head ? '…' : ''} is not a declared storage name`);
        }
        if (!own) continue;
        const passThrough: readonly string[] = own.passThrough ?? [];
        const webPlaces = (['local', 'session'] as const).filter((place) => own[place]);
        const calls: [string[], string][] = [
            ...CALLS.flatMap(([place, pattern]) =>
                [...body.matchAll(pattern)].map(
                    (match) => [[place], match[1]!] as [string[], string],
                ),
            ),
            ...[...body.matchAll(WEB_STORAGE)].map(
                (match) => [webPlaces, match[1]!] as [string[], string],
            ),
        ];
        for (const [places, argument] of calls) {
            if (!places.length) continue;
            const found = resolve(argument, body);
            if (!found) {
                if (!places.some((place) => passThrough.includes(place)))
                    problems.push(
                        `${path}: ${argument.trim()} does not resolve to a storage name for ${places.join(' or ')}`,
                    );
                continue;
            }
            const names = places.flatMap((place) => [
                ...((own[place as keyof Owners[string]] as readonly string[] | undefined) ?? []),
            ]);
            if (!covers(names, found.name, found.head))
                problems.push(
                    `${path}: ${found.name} is used as a ${places.join(' or ')} name without being declared there`,
                );
        }
    }
    return problems;
}

describe('the registry', () => {
    // The repository: vitest runs from apps/web.
    const root = `${join(process.cwd(), '../..')}/`;
    function sources(dir: string): string[] {
        return readdirSync(dir).flatMap((entry) => {
            const path = join(dir, entry);
            if (statSync(path).isDirectory())
                return entry === 'node_modules' || entry === 'test' ? [] : sources(path);
            return /\.tsx?$/.test(entry) && !/\.test\.|\.spec\.|testkit/.test(entry) ? [path] : [];
        });
    }
    const tree = () => {
        const packages = join(root, 'packages');
        return [
            ...sources(join(root, 'apps/web/src')),
            ...readdirSync(packages).flatMap((name) => {
                try {
                    return sources(join(packages, name, 'src'));
                } catch {
                    return [];
                }
            }),
        ].map((path) => ({ path: path.slice(root.length), text: readFileSync(path, 'utf8') }));
    };

    test('every file that reaches browser storage is an owner, with every name registered for its place', () => {
        const files = tree();
        // The scan reads what it is meant to: a broken walk would pass on nothing.
        expect(files.some(({ path }) => path === 'packages/auth/src/store.ts')).toBe(true);
        expect(files.length).toBeGreaterThan(200);
        expect(audit(files)).toEqual([]);
    });

    const fixture = (path: string, text: string) => [
        ...tree().filter((file) => file.path !== path),
        { path, text },
    ];
    test.each([
        [
            'raw storage in a file that is not an owner',
            'apps/web/src/lib/new-feature.ts',
            `const KEY = 'feature'; export const keep = () => localStorage.setItem(KEY, '1');`,
            'reaches local storage without being its owner',
        ],
        [
            'a name built in a template',
            'apps/web/src/lib/rollback-marks.ts',
            "export const extra = (id: string) => localStorage.setItem(`hushos.extra:${id}`, '1');",
            'hushos.extra:… is not a declared storage name',
        ],
        [
            'a name kept in a constants file',
            'apps/web/src/lib/storage-keys.ts',
            `export const EXTRA_KEY = 'hushos.extra';`,
            'hushos.extra is not a declared storage name',
        ],
        [
            'a plain name passed straight to storage by an owner',
            'apps/web/src/routes/join/route.tsx',
            `export const keep = () => sessionStorage.setItem('draft', '1');`,
            'draft is used as a session name without being declared there',
        ],
        [
            'a plain name an owner keeps in a constant',
            'apps/web/src/routes/join/route.tsx',
            `const KEY = 'draft'; export const keep = (data: string) => sessionStorage.setItem(KEY, data);`,
            'draft is used as a session name without being declared there',
        ],
        [
            'a name registered for one place used in another',
            'apps/web/src/lib/stash.ts',
            `export const keep = (data: string) => localStorage.setItem('upload-stash', data);`,
            'upload-stash is used as a local name without being declared there',
        ],
        [
            'a name an owner computes',
            'apps/web/src/lib/return-to.ts',
            `export const keep = (key: string) => localStorage.setItem(key.trim(), '1');`,
            'does not resolve to a storage name for local',
        ],
        [
            'an owner reaching a place it did not declare',
            'apps/web/src/lib/link-sent.ts',
            `export const keep = () => localStorage.setItem('hushos-link-sent', '1');`,
            'reaches local storage without being its owner',
        ],
    ])('fails on %s', (_label, path, text, problem) => {
        const found = audit(fixture(path, text));
        expect(found.some((line) => line.includes(problem))).toBe(true);
    });

    test('fails on a name declared for one place and registered for another', () => {
        const owners = {
            ...STORAGE_OWNERS,
            'apps/web/src/lib/link-sent.ts': { local: ['hushos-link-sent'] },
        };
        expect(audit(tree(), owners)).toContain(
            'apps/web/src/lib/link-sent.ts: hushos-link-sent is not registered under local',
        );
    });

    test('a comment that names storage is not storage', () => {
        expect(
            audit(
                fixture(
                    'apps/web/src/lib/notes.ts',
                    '/* Kept in localStorage as hushos.extra. */\n// sessionStorage too\nexport const x = 1;',
                ),
            ),
        ).toEqual([]);
    });
});
