/*
 * Everything this browser keeps for an account, in one place. Signing out
 * (lib/sign-out.ts), and learning this browser was removed, delete all of it:
 * a browser someone signed out of holds nothing of theirs. The parts that
 * write these (uploads, the mirror, families) are stopped first by their own
 * owners in clearDevice; this then deletes what they leave, by name.
 *
 * A new place that keeps anything about an account, or about what it did, is
 * registered here, or it outlives sign-out. device-data.test.ts reads the
 * source for storage names and fails on any found neither here nor in KEPT.
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
 * Deletes one database, failing (so the caller tries again) if another tab
 * holds it open past `patience`: those tabs close on `versionchange`, so this
 * waits for them rather than give up at the first `blocked`.
 */
export function deleteDatabase(name: string, patience = 5_000) {
    return new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        let timer: ReturnType<typeof setTimeout> | undefined;
        request.onsuccess = () => {
            clearTimeout(timer);
            resolve();
        };
        request.onerror = () => {
            clearTimeout(timer);
            reject(request.error ?? new Error('Device storage could not be cleared.'));
        };
        request.onblocked = () => {
            timer ??= setTimeout(
                () => reject(new Error('Device storage is busy in another tab.')),
                patience,
            );
        };
    });
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
 * Another tab signed out (the saved unlock's entry went, which only a sign-out
 * or a removal does): this tab's sessionStorage goes too, since no other tab
 * can reach it. Installed once, in the browser.
 */
export function watchSignOutElsewhere() {
    if (typeof window === 'undefined') return () => {};
    const local = storageOf('localStorage');
    const onStorage = (event: StorageEvent) => {
        if (event.storageArea !== local) return;
        if (event.key === null || (event.key === 'hushos-device-unlock' && event.newValue === null))
            forgetSessionData();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
}
