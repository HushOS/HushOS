import { encodeStatement } from './canonical';
import { deriveStoreKey, openStoreBytes, sealStoreBytes } from './device-store';
import { CryptoError } from './errors';

/*
 * The contact guard as a device keeps it (docs/optional-verification.md 2.8),
 * sealed in the device-store envelope (device-store.ts) under a key derived
 * from the account's settings key (HKDF-SHA-256, salt 32 zero bytes, info
 * "hushos/contact-guard/v1"). The settings key exists in the worker only
 * while the account is unlocked, and an account key rotation re-wraps it
 * unchanged, so a guard written before one still opens after it, and a locked
 * browser holds only ciphertext.
 *
 * Rows are found by an id, never by whom they are about: HMAC-SHA-256 under a
 * second key from the same settings key (info "hushos/contact-guard/id/v1")
 * over ["hushos/contact-guard",1,userId,contactId], both lowercased. Each row
 * is sealed with associated data ["hushos/contact-guard",1,userId,id,kind]
 * and holds the contact id it is about, so a row moved to another id, kind or
 * account does not open, and one whose contact id does not hash to its id is
 * refused.
 */
const KEY_INFO = 'hushos/contact-guard/v1';
const ID_INFO = 'hushos/contact-guard/id/v1';
const DOMAIN = 'hushos/contact-guard';
const VERSION = 1;

/*
 * `check` is one row per account (apps/web lib/contact-guard.ts): it proves
 * which settings key the account's rows are sealed under, so rows sealed
 * under another one are never read as none.
 */
export type GuardRowKind = 'entry' | 'pending' | 'check';

const refused = () => new CryptoError('This saved contact record could not be opened.');

function rowContext(userId: string, id: string, kind: GuardRowKind) {
    return encodeStatement([DOMAIN, VERSION, userId.toLowerCase(), id, kind]);
}

export async function guardRowId(
    settingsKey: Uint8Array<ArrayBuffer>,
    userId: string,
    contactId: string,
) {
    const raw = await deriveStoreKey(settingsKey, ID_INFO);
    try {
        const key = await crypto.subtle.importKey(
            'raw',
            raw,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
        );
        const mac = new Uint8Array(
            await crypto.subtle.sign(
                'HMAC',
                key,
                encodeStatement([DOMAIN, VERSION, userId.toLowerCase(), contactId.toLowerCase()]),
            ),
        );
        return Array.from(mac, (byte) => byte.toString(16).padStart(2, '0')).join('');
    } finally {
        raw.fill(0);
    }
}

/* One guard row sealed: its id and envelope. `value` holds public keys and digests only. */
export async function sealGuardRow(
    settingsKey: Uint8Array<ArrayBuffer>,
    userId: string,
    contactId: string,
    kind: GuardRowKind,
    value: unknown,
) {
    const id = await guardRowId(settingsKey, userId, contactId);
    const plaintext = new TextEncoder().encode(
        JSON.stringify({ contactId: contactId.toLowerCase(), value }),
    );
    const key = await deriveStoreKey(settingsKey, KEY_INFO);
    try {
        return { id, envelope: await sealStoreBytes(key, rowContext(userId, id, kind), plaintext) };
    } finally {
        key.fill(0);
        plaintext.fill(0);
    }
}

/* One guard row opened, or refused: sealed under another key, for another place, or altered. */
export async function openGuardRow(
    settingsKey: Uint8Array<ArrayBuffer>,
    userId: string,
    kind: GuardRowKind,
    id: string,
    envelope: string,
): Promise<{ contactId: string; value: unknown }> {
    if (!/^[0-9a-f]{64}$/.test(id)) throw refused();
    const key = await deriveStoreKey(settingsKey, KEY_INFO);
    let plaintext: Uint8Array;
    try {
        plaintext = await openStoreBytes(key, rowContext(userId, id, kind), envelope, refused);
    } finally {
        key.fill(0);
    }
    let opened: { contactId?: unknown; value?: unknown };
    try {
        opened = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
        throw refused();
    } finally {
        plaintext.fill(0);
    }
    if (typeof opened?.contactId !== 'string' || opened.contactId.length === 0) throw refused();
    if ((await guardRowId(settingsKey, userId, opened.contactId)) !== id) throw refused();
    return { contactId: opened.contactId, value: opened.value };
}
