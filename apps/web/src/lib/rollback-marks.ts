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
export function identitySeen(userId: string) {
    return readMark(`${IDENTITY_SEEN_PREFIX}:${userId}`);
}
export function rememberIdentitySeen(userId: string, keyVersion: number) {
    raiseMark(`${IDENTITY_SEEN_PREFIX}:${userId}`, keyVersion);
}
export function identityRolledBack(served: number, seen: number) {
    return served < seen;
}
export const IDENTITY_ROLLED_BACK =
    'The server sent older sharing keys for your account than this device has opened, so nothing was opened. Try again later, and tell your operator if it keeps happening.';
