/*
 * Rollback marks, kept in this browser's storage. Pure apart from storage, so
 * the rules a malicious server would try to slip past are tested on their own.
 */

/*
 * Per account and never lowered. The server keeps the settings
 * and the identity and could hand back an older copy of either: older settings
 * (or none) to bring back a pin the person replaced or drop one they made, an
 * older identity to bring back keys this account replaced. A device that has
 * seen settings version n refuses anything older, and one that has opened its
 * own identity at key version k refuses one served as current below it. Both
 * survive a succession; a new device starts with none, which is inherent.
 */
const SEEN_PREFIX = 'hushos.settings-seen';
const IDENTITY_SEEN_PREFIX = 'hushos.identity-seen';
function readMark(key: string) {
    try {
        return Number(window.localStorage.getItem(key) ?? 0) || 0;
    } catch {
        return 0;
    }
}
function raiseMark(key: string, value: number) {
    try {
        if (value > readMark(key)) window.localStorage.setItem(key, String(value));
    } catch {
        /* No storage: this device simply cannot tell an old copy from a new one. */
    }
}
/*
 * The settings mark. Earlier versions kept one per identity key, which a
 * succession reset: the highest of those is carried over into the account's
 * own mark the first time it is read, and they are left where they are.
 */
export function settingsSeen(userId: string) {
    const key = `${SEEN_PREFIX}:${userId}`;
    let seen = readMark(key);
    try {
        const legacy = `${SEEN_PREFIX}:${userId}:`;
        for (let index = 0; index < window.localStorage.length; index++) {
            const name = window.localStorage.key(index);
            if (name?.startsWith(legacy)) seen = Math.max(seen, readMark(name));
        }
    } catch {
        /* No storage to carry anything over from. */
    }
    raiseMark(key, seen);
    return seen;
}
export function rememberSettingsSeen(userId: string, version: number) {
    raiseMark(`${SEEN_PREFIX}:${userId}`, version);
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
const DOCUMENT_SEEN_PREFIX = 'hushos.settings-document-seen';
export function settingsDocumentSeen(userId: string) {
    return readMark(`${DOCUMENT_SEEN_PREFIX}:${userId}`) >= 2;
}
export function rememberSettingsDocumentSeen(userId: string) {
    raiseMark(`${DOCUMENT_SEEN_PREFIX}:${userId}`, 2);
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
export function identitySeen(userId: string) {
    return readMark(`${IDENTITY_SEEN_PREFIX}:${userId}`);
}
/* The highest identity version (1, or 2 once upgraded) this device has opened for the account. */
export function identityVersionSeen(userId: string) {
    return readMark(`${IDENTITY_SEEN_PREFIX}:${userId}:version`);
}
export function rememberIdentitySeen(userId: string, keyVersion: number, identityVersion: number) {
    raiseMark(`${IDENTITY_SEEN_PREFIX}:${userId}`, keyVersion);
    raiseMark(`${IDENTITY_SEEN_PREFIX}:${userId}:version`, identityVersion);
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
