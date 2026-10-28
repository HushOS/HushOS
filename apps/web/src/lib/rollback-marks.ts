import type { SettingsKeyEnvelope } from '@hushos/auth/api';
import type * as AuthClientModule from '@/lib/auth-client';
import type * as ContactsModule from '@/lib/contacts';
import {
    highestMarks,
    NO_MARKS,
    rollbackMarksSlot,
    type RollbackMarks,
} from '@hushos/crypto/rollback-marks';

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
 * survive a succession and a master-key rotation; a new device starts with
 * none, which is inherent, and so does this browser after signing out, which
 * deletes them (lib/device-data.ts).
 *
 * At rest the marks are one record per account in localStorage under
 * `hushos.marks:<slot>`, sealed by the crypto worker under a key from the
 * settings key (@hushos/crypto/rollback-marks). A locked browser holds
 * ciphertext that says neither whose marks they are nor what they count; the
 * slot is a digest of the user id, found without a key. The settings key only
 * ever moves to a new root by being re-wrapped, so the marks open under every
 * root the account has had, one a server replays from before a rotation
 * included, and a rotation needs nothing done to them. They are read only
 * while unlocked, which is when every check runs (contacts.ts reads them after
 * requireUnlocked).
 *
 * Fail closed: a record that is there and does not open (damaged, swapped, or
 * under a settings key other than the one the server serves, or none served)
 * is an error (MARKS_UNREADABLE), and so is a read while locked; neither is
 * ever "nothing seen". Signing out and in again starts the browser afresh. A
 * browser that refuses site storage altogether has never kept a mark, and
 * reads none, as before. An account with no settings key yet gets one the
 * first time a mark is kept (contacts.ts marksKeyReady). Beside the marks sits
 * the settings key's envelope as the server keeps it (ciphertext under the
 * account key), so the marks open when the settings can't be fetched, and
 * opening files never waits on them.
 *
 * Earlier versions kept the marks in the clear (`hushos.settings-seen:<id>`,
 * `hushos.settings-document-seen:<id>`, `hushos.identity-seen:<id>` and
 * `…:version`, and per identity key `hushos.settings-seen:<id>:<key>`). The
 * first read after an unlock folds the highest of each into the sealed record,
 * then deletes them only if no tab still on an earlier version wrote a higher
 * one meanwhile; one that did is folded in first.
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

/* The marks are there and do not open: never "nothing seen". */
export class MarksUnreadableError extends Error {
    override name = 'MarksUnreadableError';
    constructor(cause?: unknown) {
        super(MARKS_UNREADABLE, { cause });
    }
}

/* The worker's side, under the settings key (rollbackMarksUpdate). */
export type MarksSealer = {
    /*
     * Opens the account's settings key in the worker and answers the envelope it opened: the
     * server's, or `kept` (the one beside the marks) when the server does not answer or serves
     * none. With `create`, makes and stores one when the account has none yet; without, the
     * worker may stay without one. Rejects only when it could not ask (the server did not
     * answer and nothing kept opens).
     */
    ready(
        userId: string,
        create: boolean,
        kept: SettingsKeyEnvelope | null,
    ): Promise<SettingsKeyEnvelope | null>;
    /*
     * Opens the record `envelope` holds (none for a first one), raises it to at least `to` and
     * seals it again, all under the one key the worker holds: null when the record does not
     * open under it. `changed` is false, and the envelope the same, when nothing rose.
     */
    update(
        userId: string,
        envelope: string | null,
        to: Partial<RollbackMarks>,
    ): Promise<{ marks: RollbackMarks; envelope: string; changed: boolean } | null>;
};

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

const PLAINTEXT_FIELD = (userId: string) => {
    const settings = `${PLAINTEXT_MARK_PREFIXES[0]}${userId}`;
    const document = `${PLAINTEXT_MARK_PREFIXES[1]}${userId}`;
    const identity = `${PLAINTEXT_MARK_PREFIXES[2]}${userId}`;
    /* The mark a plaintext key holds, or null when the key is not one of this account's. */
    return (key: string, raw: string | null): Partial<RollbackMarks> | null => {
        const value = Number(raw ?? 0) || 0;
        if (key === settings || key.startsWith(`${settings}:`)) return { settings: value };
        if (key === document) return { settingsDocument: value >= 2 };
        if (key === identity) return { identity: value };
        if (key === `${identity}:version`) return { identityVersion: value };
        return null;
    };
};
/* What earlier versions kept in the clear for `userId`: the keys, and the highest of each mark. */
function plaintextMarks(storage: Store, userId: string) {
    const fieldOf = PLAINTEXT_FIELD(userId);
    const keys: string[] = [];
    let marks = NO_MARKS;
    for (let index = 0; index < storage.length; index++) {
        const name = storage.key(index);
        const mark = name === null ? null : fieldOf(name, storage.getItem(name));
        if (!name || !mark) continue;
        keys.push(name);
        marks = highestMarks(marks, mark);
    }
    return { keys, marks, fieldOf };
}
/*
 * What a slot holds: the marks, sealed, and the settings key's envelope as the server keeps it
 * (wrapped under the account key), so the marks still open when the settings can't be fetched.
 */
type MarksRecord = { marks: string; key: SettingsKeyEnvelope | null };
function parse(raw: string): MarksRecord | null {
    try {
        const value = JSON.parse(raw) as Partial<MarksRecord>;
        const key = value.key;
        const keyOk =
            key === null ||
            (typeof key === 'object' &&
                typeof key.nonce === 'string' &&
                typeof key.ciphertext === 'string');
        return typeof value.marks === 'string' && keyOk
            ? { marks: value.marks, key: key ?? null }
            : null;
    } catch {
        return null;
    }
}
/* The plaintext keys as read, and the highest of each mark. */
function snapshot(storage: Store, userId: string) {
    const { keys, marks } = plaintextMarks(storage, userId);
    return { found: new Map(keys.map((key) => [key, storage.getItem(key) ?? ''])), marks };
}
const unchanged = (a: Map<string, string>, b: Map<string, string>) =>
    a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
const sameKey = (a: SettingsKeyEnvelope | null, b: SettingsKeyEnvelope | null) =>
    a?.nonce === b?.nonce && a?.ciphertext === b?.ciphertext;

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
    /*
     * One update of the stored record, alone across tabs: the record is read, opened, raised
     * to `to` and sealed again in one step under one settings key (MarksSealer.update), so it
     * never moves to another key it did not open under. The envelope kept beside it is
     * replaced by the one that just opened it (after a master-key rotation, the server's
     * re-wrapped one), so the fallback opens under the account key in use now. With nothing
     * stored, a read asks for no key and finds none.
     */
    async function update(
        storage: Store,
        userId: string,
        to: Partial<RollbackMarks>,
        create: boolean,
    ) {
        return exclusive(async () => {
            const slot = await rollbackMarksSlot(userId);
            const raw = storage.getItem(MARKS_PREFIX + slot);
            const record = raw === null ? null : parse(raw);
            if (raw !== null && !record) throw new MarksUnreadableError();
            if (!record && !create) return NO_MARKS;
            // Never makes a settings key while a record is kept: one the server withholds leaves
            // the record unopened. A server that does not answer, with nothing kept that opens,
            // is its own error, to try again.
            const key = await options.sealer.ready(userId, !record, record?.key ?? null);
            let result: Awaited<ReturnType<MarksSealer['update']>>;
            try {
                result = await options.sealer.update(userId, record?.marks ?? null, to);
            } catch (error) {
                throw new MarksUnreadableError(error);
            }
            if (!result) throw new MarksUnreadableError();
            const kept = key ?? record?.key ?? null;
            if (!record || result.changed || !sameKey(kept, record.key)) {
                const next: MarksRecord = { marks: result.envelope, key: kept };
                storage.setItem(MARKS_PREFIX + slot, JSON.stringify(next));
            }
            return result.marks;
        });
    }
    /* Raises the stored marks to at least `to`, never lowering any; returns what is stored. */
    async function raise(userId: string, to: Partial<RollbackMarks>) {
        const storage = storageOrNone();
        if (!storage) return highestMarks(NO_MARKS, to);
        await requireUnlocked(userId);
        return update(storage, userId, to, true);
    }
    /*
     * This device's marks for `userId`, migrating plaintext ones first. Throws
     * MarksUnreadableError when they are there and cannot be read.
     */
    async function read(userId: string): Promise<RollbackMarks> {
        const storage = storageOrNone();
        if (!storage) return NO_MARKS;
        await requireUnlocked(userId);
        const stored = await update(storage, userId, {}, false);
        let plaintext = snapshot(storage, userId);
        if (!plaintext.found.size) return stored;
        let marks = highestMarks(stored, plaintext.marks);
        // A tab still on an earlier version can write a plaintext mark at any time. Only what
        // was sealed is deleted, and only if it is still what was read; anything newer is
        // sealed first. A write that fails keeps the plaintext for the next read.
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                marks = await update(storage, userId, plaintext.marks, true);
            } catch (error) {
                if (error instanceof MarksUnreadableError) throw error;
                return marks;
            }
            const now = snapshot(storage, userId);
            if (unchanged(plaintext.found, now.found)) {
                for (const key of now.found.keys()) storage.removeItem(key);
                return marks;
            }
            plaintext = now;
            marks = highestMarks(marks, now.marks);
        }
        return marks;
    }
    return { read, raise };
}

/*
 * The worker and the settings key, reached through the app's modules, loaded once when first
 * used and shared by every caller after.
 */
let authModule: Promise<typeof AuthClientModule> | undefined;
let contactsModule: Promise<typeof ContactsModule> | undefined;
async function auth() {
    return (await (authModule ??= import('@/lib/auth-client'))).authClient;
}
const marks = createRollbackMarks({
    sealer: {
        ready: async (userId, create, kept) =>
            (await (contactsModule ??= import('@/lib/contacts'))).marksKeyReady(
                userId,
                create,
                kept,
            ),
        update: async (userId, envelope, to) => {
            const result = await (
                await auth()
            ).rpc('rollbackMarksUpdate', {
                userId,
                envelope,
                marks: to,
            });
            return result.refused ? null : result;
        },
    },
    storage: () => window.localStorage,
    account: async () => (await auth()).store.getState().unlockedUserId,
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
