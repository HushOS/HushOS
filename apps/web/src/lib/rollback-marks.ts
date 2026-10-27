import { NO_MARKS, type RollbackMarks } from '@hushos/crypto/rollback-marks';

/*
 * Rollback marks, kept in this browser's storage, sealed. The rules a
 * malicious server would try to slip past are pure and tested on their own.
 */

/*
 * Per account and never lowered. The server keeps the settings
 * and the identity and could hand back an older copy of either: older settings
 * (or none) to bring back a pin the person replaced or drop one they made, an
 * older identity to bring back keys this account replaced. A device that has
 * seen settings version n refuses anything older, and one that has opened its
 * own identity at key version k refuses one served as current below it. Both
 * survive a succession; a new device starts with none, which is inherent, and
 * so does this browser after signing out, which deletes them (lib/device-data.ts).
 *
 * At rest the marks are one record per account, sealed by the crypto worker
 * under a key from the account root (@hushos/crypto/rollback-marks), in
 * localStorage under `hushos.marks:<slot>`, a slot only the root can name. A
 * locked browser holds ciphertext that says neither whose marks they are nor
 * what they count. They are read only while unlocked, which is when every
 * check runs (contacts.ts reads them after requireUnlocked).
 *
 * Fail closed: a record that is there and does not open is an error
 * (MARKS_UNREADABLE), and so is a read while locked; neither is ever "nothing
 * seen", so a damaged
 * or swapped record cannot reset this device's marks. Signing out and in again
 * starts the browser afresh. A browser that refuses site storage altogether
 * has never kept a mark, and reads none, as before.
 *
 * Earlier versions kept the marks in the clear (`hushos.settings-seen:<id>`,
 * `hushos.settings-document-seen:<id>`, `hushos.identity-seen:<id>` and
 * `…:version`, and per identity key `hushos.settings-seen:<id>:<key>`). The
 * first read after an unlock folds the highest of each into the sealed record
 * and deletes them once it is written.
 */

export type { RollbackMarks };

/* Where the sealed records live: `hushos.marks:<slot>`. */
export const MARKS_PREFIX = 'hushos.marks:';
/* The plaintext marks of earlier versions, followed by the user id. */
export const PLAINTEXT_MARK_PREFIXES = [
    'hushos.settings-seen:',
    'hushos.settings-document-seen:',
    'hushos.identity-seen:',
] as const;

export const MARKS_UNREADABLE =
    'HushOS couldn’t read what this browser last saw of your account, so nothing was opened. Sign out and sign in again to start this browser afresh.';

/* The marks are there and do not open, or the account is locked: never "nothing seen". */
export class MarksUnreadableError extends Error {
    override name = 'MarksUnreadableError';
    constructor(cause?: unknown) {
        super(MARKS_UNREADABLE, { cause });
    }
}

/* The worker's sealing (rollbackMarksSlot, rollbackMarksSeal, rollbackMarksOpen). */
export type MarksSealer = {
    slot(userId: string): Promise<string>;
    seal(userId: string, marks: RollbackMarks): Promise<{ slot: string; envelope: string }>;
    /* Null for a record that does not open. */
    open(userId: string, envelope: string): Promise<RollbackMarks | null>;
};

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

function highest(a: RollbackMarks, b: Partial<RollbackMarks>): RollbackMarks {
    return {
        settings: Math.max(a.settings, b.settings ?? 0),
        settingsDocument: a.settingsDocument || b.settingsDocument === true,
        identity: Math.max(a.identity, b.identity ?? 0),
        identityVersion: Math.max(a.identityVersion, b.identityVersion ?? 0),
    };
}
const same = (a: RollbackMarks, b: RollbackMarks) =>
    a.settings === b.settings &&
    a.settingsDocument === b.settingsDocument &&
    a.identity === b.identity &&
    a.identityVersion === b.identityVersion;

/* What earlier versions kept in the clear for `userId`, and under which keys. */
function plaintextMarks(storage: Store, userId: string) {
    const read = (key: string) => Number(storage.getItem(key) ?? 0) || 0;
    const settings = `${PLAINTEXT_MARK_PREFIXES[0]}${userId}`;
    const document = `${PLAINTEXT_MARK_PREFIXES[1]}${userId}`;
    const identity = `${PLAINTEXT_MARK_PREFIXES[2]}${userId}`;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
        const name = storage.key(index);
        if (
            name === settings ||
            name?.startsWith(`${settings}:`) ||
            name === document ||
            name === identity ||
            name === `${identity}:version`
        )
            keys.push(name);
    }
    let marks = NO_MARKS;
    for (const key of keys) {
        const value = read(key);
        if (key === settings || key.startsWith(`${settings}:`))
            marks = highest(marks, { settings: value });
        else if (key === document) marks = highest(marks, { settingsDocument: value >= 2 });
        else if (key === identity) marks = highest(marks, { identity: value });
        else marks = highest(marks, { identityVersion: value });
    }
    return { keys, marks };
}

export function createRollbackMarks(options: {
    sealer: MarksSealer;
    /* localStorage; throws where the browser refuses site storage. */
    storage: () => Store;
    /* The unlocked account, or null. */
    account: () => string | null | Promise<string | null>;
    /* Runs `work` alone across this browser's tabs (a Web Lock), so a raise never lowers another. */
    exclusive?: <T>(work: () => Promise<T>) => Promise<T>;
}) {
    let chain: Promise<unknown> = Promise.resolve();
    const exclusive =
        options.exclusive ??
        (<T>(work: () => Promise<T>) => {
            const next = chain.then(work, work);
            chain = next.catch(() => {});
            return next;
        });
    function storageOrNone() {
        try {
            return options.storage();
        } catch {
            return null;
        }
    }
    async function requireUnlocked(userId: string) {
        if ((await options.account()) !== userId) throw new Error('Unlock your account first.');
    }
    /* The sealed record as stored: none, or its marks; throws when it does not open. */
    async function sealed(storage: Store, userId: string) {
        const slot = await options.sealer.slot(userId);
        const raw = storage.getItem(MARKS_PREFIX + slot);
        if (raw === null) return { slot, marks: NO_MARKS, stored: false };
        const marks = await options.sealer.open(userId, raw);
        if (!marks) throw new MarksUnreadableError();
        return { slot, marks, stored: true };
    }
    /* Raises the stored marks to at least `to`, never lowering any; returns what is stored. */
    async function raise(userId: string, to: Partial<RollbackMarks>) {
        const storage = storageOrNone();
        if (!storage) return highest(NO_MARKS, to);
        await requireUnlocked(userId);
        return exclusive(async () => {
            // A record that does not open is never written over: that would reset it.
            const current = await sealed(storage, userId);
            const next = highest(current.marks, to);
            if (current.stored && same(next, current.marks)) return next;
            const { slot, envelope } = await options.sealer.seal(userId, next);
            storage.setItem(MARKS_PREFIX + slot, envelope);
            return next;
        });
    }
    /*
     * This device's marks for `userId`, migrating plaintext ones first. Throws
     * MarksUnreadableError when they are there and cannot be read.
     */
    async function read(userId: string): Promise<RollbackMarks> {
        const storage = storageOrNone();
        if (!storage) return NO_MARKS;
        await requireUnlocked(userId);
        const stored = (await sealed(storage, userId)).marks;
        const plaintext = plaintextMarks(storage, userId);
        if (!plaintext.keys.length) return stored;
        // Sealed first, then the plaintext goes: a write that failed keeps it for the next read.
        let marks: RollbackMarks;
        try {
            marks = await raise(userId, plaintext.marks);
        } catch (error) {
            if (error instanceof MarksUnreadableError) throw error;
            return highest(stored, plaintext.marks);
        }
        for (const key of plaintext.keys) storage.removeItem(key);
        return marks;
    }
    /*
     * Around a change that may give the account a new root: the marks read before it are
     * sealed again under the root it ends with, and the record under the old slot goes.
     */
    async function carry<T>(userId: string, work: () => Promise<T>) {
        const storage = storageOrNone();
        let before: { slot: string; marks: RollbackMarks } | null = null;
        try {
            before = { slot: await options.sealer.slot(userId), marks: await read(userId) };
        } catch {
            /* Nothing readable to carry: the change goes ahead as it would have. */
        }
        const result = await work();
        if (!storage || !before) return result;
        try {
            await raise(userId, before.marks);
            if ((await options.sealer.slot(userId)) !== before.slot)
                storage.removeItem(MARKS_PREFIX + before.slot);
        } catch (error) {
            console.warn(
                'The rollback marks could not be carried over to the new account key.',
                error,
            );
        }
        return result;
    }
    return { read, raise, carry };
}

/* The worker, reached through the auth client, loaded when first used. */
async function rpc() {
    return (await import('@/lib/auth-client')).authClient;
}
const marks = createRollbackMarks({
    sealer: {
        slot: async (userId) => (await (await rpc()).rpc('rollbackMarksSlot', { userId })).slot,
        seal: async (userId, value) =>
            (await rpc()).rpc('rollbackMarksSeal', { userId, marks: value }),
        open: async (userId, envelope) =>
            (await (await rpc()).rpc('rollbackMarksOpen', { userId, envelope })).marks,
    },
    storage: () => window.localStorage,
    account: async () => (await rpc()).store.getState().unlockedUserId,
    exclusive: (work) =>
        typeof navigator !== 'undefined' && navigator.locks?.request
            ? (navigator.locks.request('hushos-rollback-marks', work) as ReturnType<typeof work>)
            : work(),
});

/* A raise that could not be kept leaves this device a little less able to tell an old copy. */
function raiseQuietly(userId: string, to: Partial<RollbackMarks>) {
    return marks.raise(userId, to).then(
        () => {},
        (error: unknown) => console.warn('A rollback mark could not be saved here.', error),
    );
}

/* Seals marks an earlier version kept in the clear; called at unlock. Never rejects. */
export function migrateMarks(userId: string) {
    return marks.read(userId).then(
        () => {},
        () => {},
    );
}

/*
 * Around a security change that may give the account a new root (a master-key
 * rotation): the marks read before it are sealed again under the root it ends
 * with, so rotating on this browser keeps them. A browser where the rotation
 * was made elsewhere starts again from none, as a new device would.
 */
export function carryMarks<T>(userId: string, work: () => Promise<T>) {
    return marks.carry(userId, work);
}

export async function settingsSeen(userId: string) {
    return (await marks.read(userId)).settings;
}
export function rememberSettingsSeen(userId: string, version: number) {
    return raiseQuietly(userId, { settings: version });
}
/*
 * The settings document mark: whether this device has opened or saved a
 * version 2 document for the account. The sequence mark alone does not catch
 * a server that answers "none" (or a version 1 document, which reads as none)
 * at a sequence above the one seen: that would drop every pin the document
 * held, family pins among them, and with them the marks that keep a family
 * from being joined again onto another history (decision D7). Once a version
 * 2 document has been seen here, anything else is an older copy.
 */
export async function settingsDocumentSeen(userId: string) {
    return (await marks.read(userId)).settingsDocument;
}
export function rememberSettingsDocumentSeen(userId: string) {
    return raiseQuietly(userId, { settingsDocument: true });
}
/* Whether settings served as `served` ('none', or a document's version) are older than this device has seen. */
export function settingsDocumentRolledBack(served: 'none' | 1 | 2, documentSeen: boolean) {
    return documentSeen && served !== 2;
}
/*
 * Whether "the account has no settings" may be taken as a reading (and the
 * worker told so, which lets a family be joined with no settings pin as a
 * mark): only when nothing is stored and this device has never seen a sequence
 * or a document. A brand-new device of an account that has settings cannot
 * tell a server withholding them from a new account; that is inherent, as for
 * the sequence mark, and the residual is documented in docs/groups-invariants.md (I5).
 */
export function settingsNoneTrusted(
    storedSequence: number,
    seenSequence: number,
    documentSeen: boolean,
) {
    return storedSequence === 0 && seenSequence === 0 && !documentSeen;
}
export async function identitySeen(userId: string) {
    return (await marks.read(userId)).identity;
}
/* The highest identity version (1, or 2 once upgraded) this device has opened for the account. */
export async function identityVersionSeen(userId: string) {
    return (await marks.read(userId)).identityVersion;
}
export function rememberIdentitySeen(userId: string, keyVersion: number, identityVersion: number) {
    return raiseQuietly(userId, { identity: keyVersion, identityVersion });
}
/*
 * Whether the identity served as current is older than one this device has
 * opened: a lower key version, or the version 1 form once it has seen version
 * 2 (the upgrade keeps the key version, so the key version alone does not see
 * it; docs/identity-pq-design.md 2).
 */
export function identityRolledBack(
    served: { keyVersion: number; identityVersion: number },
    seen: { keyVersion: number; identityVersion: number },
) {
    if (served.keyVersion < seen.keyVersion) return true;
    // Once version 2 has been seen, the version 1 form is a rollback at any key version: every
    // identity made since the release is version 2, so none can follow it.
    return served.identityVersion < seen.identityVersion;
}
export const IDENTITY_ROLLED_BACK =
    'The server sent older sharing keys for your account than this device has opened, so nothing was opened. Try again later, and tell your operator if it keeps happening.';
