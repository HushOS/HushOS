/*
 * Everything this browser keeps for an account, in one place. Signing out
 * (lib/sign-out.ts), and learning this browser was removed, delete all of it:
 * a browser someone signed out of holds nothing of theirs. Other tabs are told
 * first (announceSignOut), the parts that write these (uploads, the mirror,
 * families) are stopped by their own owners, and this then deletes what they
 * leave, by name.
 *
 * A new place that keeps anything about an account, or about what it did, is
 * registered here, or it outlives sign-out, and the file that touches it is
 * listed in STORAGE_OWNERS (device-data.test.ts holds the source to both).
 * While the account is only locked, what is kept should be sealed under a key
 * the unlocked account alone has (the rollback marks, the stash, families);
 * say so beside the entry when it is not.
 */

export const ACCOUNT_DATA = {
    /* localStorage, by exact key and by prefix. */
    local: {
        keys: [
            // The saved unlock: user id, device key id and the account key sealed under it.
            // Lock keeps it with no device and the lock time; the auth client also clears it.
            'hushos-device-unlock',
            // A saved return to a link, its key in the fragment (lib/return-to.ts).
            'hushos.return',
        ],
        prefixes: [
            // Rollback marks, sealed (lib/rollback-marks.ts).
            'hushos.marks:',
            // Rollback marks earlier versions kept in the clear, until an unlock seals them.
            'hushos.settings-seen:',
            'hushos.settings-document-seen:',
            'hushos.identity-seen:',
        ],
    },
    /* This tab's sessionStorage; other tabs clear theirs when they see the sign-out. */
    session: {
        keys: [
            // The address a sign-up or reset link was sent to (components/email-step.tsx).
            'hushos-link-sent',
            // A family invitation's token (routes/join/route.tsx).
            'hushos.invite',
            // The account that left for a family's checkout, and when (lib/family-checkout.ts).
            'hushos.family-checkout',
        ],
    },
    /* IndexedDB, deleted rather than emptied, by name and by prefix. */
    databases: {
        names: [
            // This browser's Ed25519 device key, its user id, device id and email digest. Read
            // before unlock to sign back in to the same device, so kept in the clear while locked.
            'hushos-device-identity',
            // The non-extractable key the saved unlock is sealed under.
            'hushos-device-keys',
            // The upload journal (packages/drive/src/journal.ts).
            'hushos-drive',
            // The tree mirror of the personal workspace (packages/drive/src/mirror.ts).
            'hushos-drive-mirror',
            // Families' sealed records (lib/groups/store.ts).
            'hushos-groups',
        ],
        // Each family folder's mirror (lib/groups/store.ts AREA_MIRROR_PREFIX).
        prefixes: ['hushos-drive-mirror:'],
    },
    /*
     * The origin private file system: the sealed stash and the lock revision beside it, and
     * the folder unsealed stashes were kept in before (lib/stash.ts). `hushos-stash-written`
     * says one may be there, and goes only once they did.
     */
    files: {
        entries: ['upload-stash-sealed', 'upload-stash-revision', 'upload-stash'],
        marker: 'hushos-stash-written',
    },
} as const;

/*
 * Kept after sign-out: how the site looks and sounds on this browser, which
 * says nothing about who used it, and one notice.
 */
export const KEPT = {
    cookies: ['hushos-theme', 'hushos-contrast', 'sidebar_state'],
    local: ['hushos-sounds', 'hushos.drive.view', 'hushos.folder-sort', 'hushos-json-view'],
    // "This browser was removed from your account.": set by the removal's own wipe, read and
    // deleted once by the sign-in page that follows. It holds only that it happened.
    // TanStack Router's scroll positions for this tab (`tsr-scroll-restoration-v1_3`): element
    // selectors and offsets under random keys, nothing of the account.
    session: ['hushos-device-removed', 'tsr-scroll-restoration-v1_3'],
} as const;

/*
 * The session and sign-up cookies: HttpOnly, set by the server and cleared by
 * it (Max-Age=0) when it ends the session (packages/auth/src/http.ts).
 */
export const SERVER_COOKIES = ['hushos-session', 'hushos-enrollment'] as const;

type Domain = 'local' | 'session' | 'databases' | 'files' | 'cookies';
/*
 * The only files that reach browser storage, and the names each may use, by
 * where they live: the registered wrappers. device-data.test.ts fails on raw
 * storage access in any other file, on a name a file uses that it does not
 * declare here (literal, template or imported constant), and on a declared
 * name that is not in ACCOUNT_DATA, KEPT or SERVER_COOKIES for the same place.
 * A name ending in ':' is a prefix.
 */
export const STORAGE_OWNERS: Record<string, Partial<Record<Domain, readonly string[]>>> = {
    'apps/web/src/components/drive/folder-view.tsx': {
        local: ['hushos.drive.view', 'hushos.folder-sort'],
    },
    'apps/web/src/components/drive/json-view.tsx': { local: ['hushos-json-view'] },
    'apps/web/src/components/ui/sidebar.tsx': { cookies: ['sidebar_state'] },
    'apps/web/src/lib/theme.ts': { cookies: ['hushos-theme', 'hushos-contrast', 'sidebar_state'] },
    'apps/web/src/lib/sounds.ts': { local: ['hushos-sounds'] },
    'apps/web/src/lib/return-to.ts': { local: ['hushos.return'] },
    'apps/web/src/lib/rollback-marks.ts': {
        local: [
            'hushos.marks:',
            'hushos.settings-seen:',
            'hushos.settings-document-seen:',
            'hushos.identity-seen:',
        ],
    },
    'apps/web/src/lib/stash.ts': {
        files: ['upload-stash-sealed', 'upload-stash-revision', 'upload-stash'],
        local: ['hushos-stash-written'],
    },
    'apps/web/src/lib/family-checkout.ts': { session: ['hushos.family-checkout'] },
    'apps/web/src/routes/join/route.tsx': { session: ['hushos.invite'] },
    'apps/web/src/lib/link-sent.ts': { session: ['hushos-link-sent'] },
    'apps/web/src/lib/groups/store.ts': { databases: ['hushos-groups', 'hushos-drive-mirror:'] },
    'apps/web/src/lib/groups/client.ts': { databases: [] },
    'apps/web/src/lib/spaces.ts': { databases: [] },
    'apps/web/src/lib/drive.ts': { databases: [] },
    'apps/web/src/lib/transfers.ts': { databases: [] },
    'packages/auth/src/store.ts': { local: ['hushos-device-unlock'] },
    'packages/auth/src/client.ts': { local: [], session: ['hushos-device-removed'] },
    'packages/auth/src/with-storage-events.ts': { local: [] },
    'packages/auth/src/device-storage.ts': {
        databases: ['hushos-device-keys', 'hushos-device-identity'],
    },
    'packages/auth/src/http.ts': { cookies: ['hushos-session', 'hushos-enrollment'] },
    'packages/drive/src/mirror.ts': { databases: ['hushos-drive-mirror'] },
    'packages/drive/src/journal.ts': { databases: ['hushos-drive'] },
    'packages/drive/src/connection.ts': { databases: [] },
};

/*
 * Deletes one database, failing (so the caller says so and tries again) when
 * it has not gone within `patience` of being asked, however the browser
 * answers: another tab holding it open (those close on `versionchange`), or
 * no answer at all, as a delete queued behind one that stalled gets. One
 * delete per database at a time: a second ask waits on the first rather than
 * queue behind it, each within its own deadline.
 */
const deletes = new WeakMap<IDBFactory, Map<string, Promise<void>>>();
export function deleteDatabase(name: string, patience = 5_000) {
    let deleting = deletes.get(indexedDB);
    if (!deleting) deletes.set(indexedDB, (deleting = new Map()));
    let pending = deleting.get(name);
    if (!pending) {
        const started = new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () =>
                reject(request.error ?? new Error('Device storage could not be cleared.'));
        });
        pending = started;
        deleting.set(name, started);
        const list = deleting;
        started
            .finally(() => {
                if (list.get(name) === started) list.delete(name);
            })
            .catch(() => {});
    }
    return within(pending, patience, 'Device storage is busy in another tab.');
}

/* `work`, or a rejection once `ms` have passed from now, whichever comes first. */
export function within<T>(work: Promise<T>, ms: number, message: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

type FileRoot = Pick<FileSystemDirectoryHandle, 'removeEntry'>;

const notFound = (error: unknown) =>
    error instanceof DOMException && error.name === 'NotFoundError';

function storageOf(kind: 'localStorage' | 'sessionStorage') {
    try {
        return window[kind];
    } catch {
        return null;
    }
}

function forgetKeys(
    storage: Storage | null,
    keys: readonly string[],
    prefixes: readonly string[] = [],
) {
    if (!storage) return;
    const names = new Set<string>(keys);
    for (let index = 0; index < storage.length; index++) {
        const name = storage.key(index);
        if (name && prefixes.some((prefix) => name.startsWith(prefix))) names.add(name);
    }
    for (const name of names) storage.removeItem(name);
}

/* This tab's sessionStorage entries for an account. */
export function forgetSessionData() {
    forgetKeys(storageOf('sessionStorage'), ACCOUNT_DATA.session.keys);
}

async function forgetDatabases() {
    if (typeof indexedDB === 'undefined') return;
    const names = new Set<string>(ACCOUNT_DATA.databases.names);
    if (typeof indexedDB.databases === 'function')
        for (const { name } of await indexedDB.databases())
            if (name && ACCOUNT_DATA.databases.prefixes.some((prefix) => name.startsWith(prefix)))
                names.add(name);
    await Promise.all([...names].map((name) => deleteDatabase(name)));
}

async function forgetFiles(root: () => Promise<FileRoot>) {
    const local = storageOf('localStorage');
    let handle: FileRoot;
    try {
        handle = await root();
    } catch (error) {
        // No private file system here (WebKit under automation, a private window): nothing to
        // delete unless a stash was written, and then what is left must be said. An unreadable
        // marker counts as written, as lib/stash.ts reads it.
        if (!local || local.getItem(ACCOUNT_DATA.files.marker) !== null) throw error;
        return;
    }
    for (const name of ACCOUNT_DATA.files.entries)
        await handle.removeEntry(name, { recursive: true }).catch((error: unknown) => {
            if (!notFound(error)) throw error;
        });
    local?.removeItem(ACCOUNT_DATA.files.marker);
}

/*
 * Deletes every registered store, each tried whatever another does; rejects
 * with the first failure once all settled, so the caller can say so and try
 * again. Preferences in KEPT stay.
 */
export async function forgetBrowserData(options: { files?: () => Promise<FileRoot> } = {}) {
    const root =
        options.files ??
        (() => {
            if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory)
                return Promise.reject(new Error('No private file system here.'));
            return navigator.storage.getDirectory();
        });
    announceSignOut();
    const results = await Promise.allSettled([
        (async () =>
            forgetKeys(
                storageOf('localStorage'),
                ACCOUNT_DATA.local.keys,
                ACCOUNT_DATA.local.prefixes,
            ))(),
        (async () => forgetSessionData())(),
        forgetDatabases(),
        forgetFiles(root),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
}

/*
 * Signing out tells every other tab of this browser, before anything is
 * deleted: it is the only way their sessionStorage goes (no other tab can
 * reach it), and their uploads must stop writing to the journal this tab is
 * about to delete. Said on a BroadcastChannel of its own, so it does not rest
 * on a storage event for the saved unlock, which a browser that never saved
 * one never fires.
 */
const SIGNED_OUT = 'hushos-signed-out';
export function announceSignOut() {
    try {
        const channel = new BroadcastChannel(SIGNED_OUT);
        channel.postMessage('signed-out');
        channel.close();
    } catch {
        /* No BroadcastChannel: other tabs still lock on the saved unlock's storage event. */
    }
}

const elsewhere = new Set<() => void>();
/* Work a tab drops when another signs out (its uploads, lib/transfers.ts). */
export function onSignedOutElsewhere(listener: () => void) {
    elsewhere.add(listener);
    return () => void elsewhere.delete(listener);
}

/* Installed once in every tab (lib/auth-client.ts). */
export function watchSignOutElsewhere() {
    let channel: BroadcastChannel;
    try {
        channel = new BroadcastChannel(SIGNED_OUT);
    } catch {
        return () => {};
    }
    channel.onmessage = () => {
        forgetSessionData();
        for (const listener of elsewhere) {
            try {
                listener();
            } catch (error) {
                console.error('Part of another tab’s sign-out could not be followed here.', error);
            }
        }
    };
    return () => channel.close();
}
