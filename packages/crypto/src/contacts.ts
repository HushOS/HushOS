import { CryptoError } from './errors';
import { decryptKey, encryptKey } from './aead';
import { decode, encode } from './keys';
import { SETTINGS_MAX_BYTES, type GroupPin } from './pins';

/*
 * Contacts and the settings they are pinned in.
 *
 * A fingerprint (see fingerprint.ts) is what two people compare over another
 * channel before they trust a key the server handed them.
 *
 * Settings (the contact pins, the sharing ledger, and later anything else that
 * must agree across devices) are one JSON document. Version 2 seals it under a
 * random settings key wrapped under the account root (see SettingsKeyEnvelope),
 * so it survives an identity succession and a stolen identity key opens none
 * of it. Version 1 sealed it under a key derived from the identity's X25519
 * private key, which a stolen identity key opened; it no longer opens anywhere,
 * and a version 1 document reads as no settings at all.
 */

// Pure, so the web's main thread uses them without libsodium; re-exported here as before.
export {
    CONTACTS_FULL,
    contactRemoved,
    SETTINGS_MAX_BYTES,
    settingsThatFit,
    settingsWithoutContact,
    settingsWithPin,
    withoutRemoval,
} from './pins';
export const SETTINGS_PAD_STEP = 1024;

export { fingerprint } from './fingerprint';

export type SettingsEnvelope = {
    /* 2 under the settings key; 1 (under a key off the identity) is neither written nor read. */
    version: 1 | 2;
    /* Bumped by every save; the server refuses a save that names a stale one. */
    settingsVersion: number;
    nonce: string;
    ciphertext: string;
};

export type ContactPin = {
    userId: string;
    email: string;
    name: string;
    encryptionPublicKey: string;
    signingPublicKey: string;
    fingerprint: string;
    pinnedAt: string;
    /*
     * SHA-256 (hex) of the contact's ML-DSA and ML-KEM public keys, the two
     * lattice keys a version 3 pin keeps by digest rather than in full (3 KB a
     * contact would not fit the settings). A pin is version 3 exactly when it
     * carries `mlDsaPublicKeyHash`; its fingerprint is then the version 3 one
     * over all four keys (docs/identity-pq-design.md 2). A served key whose
     * digest differs is a swap, and none at all is a downgrade. Pins without
     * `mlDsaPublicKeyHash` were made before and trust nothing.
     */
    mlDsaPublicKeyHash?: string | null;
    kemPublicKeyHash?: string | null;
    /*
     * The identity key version the pin was made at, so a later change of keys
     * can be followed by its succession chain from here. Absent on pins made
     * before successions; the chain is then found from the pinned keys.
     */
    keyVersion?: number | null;
    /*
     * The group a pin was trusted through ("Trust as Acme does",
     * trustAsGroupDoes in group-trust.ts): the group's word for these keys,
     * not the reader's own words check. Absent or null for a words check.
     * Group verdicts ask the successor's consent of links from such a pin, and
     * no member is admitted from one. Every shipped client keeps fields it does
     * not know when it rewrites a pin, so this one survives them; a new words
     * check over the keys clears it.
     */
    trustedVia?: string | null;
    /*
     * How a first-seen pin (`fingerprint` exactly "", pinTrust in pins.ts)
     * came to be: added by email, met through something they shared, or a
     * family's newcomer (docs/optional-verification.md 2.2). Informational
     * only, for Technical details and support: no rule reads it, and a words
     * check over the keys keeps it.
     */
    firstSeen?: 'added' | 'shared-with-me' | 'family';
};

export type Settings = {
    /*
     * 2 is the only one written: it may hold version 3 pins and group pins, and
     * clients from before refuse it whole rather than rebuild a pin without
     * the fields they do not know (docs/envelope-migrations.md 2). 1 is read.
     */
    version: 1 | 2;
    contacts: Record<string, ContactPin>;
    /*
     * The owner's own record of what they shared: per node, the people it was
     * shared with; per link, its node. Only what is here is ever sealed again on
     * rotation or upgrade (see SharingLedger in @hushos/drive/client). Every
     * client keeps fields it does not know when it saves.
     */
    sharing?: { shares: Record<string, string[]>; links: Record<string, string> };
    /*
     * Per group, the checked version 1 key and the marks a server must not take
     * back (docs/groups-design.md 2.7); checkGroupPin in pins.ts refuses a
     * malformed one. Only a version 2 document holds it.
     */
    groups?: Record<string, GroupPin>;
    /*
     * Per group, the family check this person made (docs/optional-verification.md
     * 3.4): the pair code compared with member `with` over the roster at
     * `rosterVersion`. Acceptance holds it as a pair mark (settings-marks.ts
     * familyCheckOf). Every shipped client keeps it when it saves.
     */
    familyChecks?: Record<
        string,
        { rosterVersion: number; with: string; code: string[]; checkedAt: string }
    >;
    /*
     * People this account removed from its contacts and has not added back,
     * by lowercased account id, with when (docs/optional-verification.md
     * 2.8): a share from them is never added on its own, it waits until the
     * person opens it. Writing their pin again forgets the entry; the oldest
     * go first when the document runs out of room (settingsThatFit in
     * pins.ts). Every shipped client keeps it when it saves.
     */
    removedContacts?: Record<string, string>;
};

export const EMPTY_SETTINGS: Settings = { version: 2, contacts: {} };

/*
 * The settings key, apart from the identity: 32 random bytes wrapped under a
 * key derived from the account root, so replacing the identity strands
 * nothing and a stolen identity key opens no settings. The server keeps the
 * wrapped key beside the settings; a master-key rotation rewraps it.
 */
export type SettingsKeyEnvelope = { nonce: string; ciphertext: string };

async function hkdf(ikm: Uint8Array<ArrayBuffer>, info: string) {
    const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(
        await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new Uint8Array(32),
                info: new TextEncoder().encode(info),
            },
            key,
            256,
        ),
    ) as Uint8Array<ArrayBuffer>;
}
function settingsKeyContext(userId: string) {
    return new TextEncoder().encode(userId.toLowerCase());
}

/* A fresh settings key and its envelope under the root. The caller owns the key and zeroes it. */
export async function createSettingsKey(root: Uint8Array<ArrayBuffer>, userId: string) {
    const key = crypto.getRandomValues(new Uint8Array(32));
    try {
        return { key, envelope: await wrapSettingsKey(root, userId, key) };
    } catch (error) {
        key.fill(0);
        throw error;
    }
}
async function wrapSettingsKey(root: Uint8Array<ArrayBuffer>, userId: string, key: Uint8Array) {
    const wrap = await hkdf(root, 'hushos/settings-key-wrap/v1');
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    try {
        return {
            nonce: encode(nonce),
            ciphertext: encode(await encryptKey(key, wrap, nonce, settingsKeyContext(userId))),
        };
    } finally {
        wrap.fill(0);
    }
}
export async function openSettingsKey(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: SettingsKeyEnvelope,
) {
    const wrap = await hkdf(root, 'hushos/settings-key-wrap/v1');
    try {
        const key = await decryptKey(
            decode(envelope.ciphertext, 48),
            wrap,
            decode(envelope.nonce, 24),
            settingsKeyContext(userId),
        );
        if (key.length !== 32) {
            key.fill(0);
            throw new CryptoError('Invalid settings key.');
        }
        return key as Uint8Array<ArrayBuffer>;
    } finally {
        wrap.fill(0);
    }
}
/* The same settings key under a new root, for a master-key rotation: a fresh nonce, the key unchanged. */
export async function rewrapSettingsKey(
    oldRoot: Uint8Array<ArrayBuffer>,
    newRoot: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: SettingsKeyEnvelope,
) {
    const key = await openSettingsKey(oldRoot, userId, envelope);
    try {
        return await wrapSettingsKey(newRoot, userId, key);
    } finally {
        key.fill(0);
    }
}

function settingsContext(userId: string, version: 2, settingsVersion: number) {
    return new TextEncoder().encode(
        JSON.stringify(['hushos/settings', version, userId.toLowerCase(), settingsVersion]),
    );
}

/* Version 2, the only one sealed: under the settings key, padded to 1 KiB steps. */
export async function sealSettings(
    settingsKey: Uint8Array<ArrayBuffer>,
    userId: string,
    settingsVersion: number,
    settings: Settings,
): Promise<SettingsEnvelope> {
    if (!Number.isSafeInteger(settingsVersion) || settingsVersion < 1)
        throw new CryptoError('Invalid settings version.');
    if (settingsKey.length !== 32) throw new CryptoError('Invalid settings key.');
    // Always written as version 2, whatever was read (docs/envelope-migrations.md 2).
    const json = new TextEncoder().encode(JSON.stringify({ ...settings, version: 2 }));
    if (json.length > SETTINGS_MAX_BYTES) throw new CryptoError('Settings are too large.');
    // Padded to 1 KiB steps with spaces JSON ignores, as the native core pads them, so the
    // length says little about how many people are pinned; the server refuses unpadded ones.
    const plaintext = new Uint8Array(
        Math.min(
            Math.max(1, Math.ceil(json.length / SETTINGS_PAD_STEP)) * SETTINGS_PAD_STEP,
            SETTINGS_MAX_BYTES,
        ),
    ).fill(0x20);
    plaintext.set(json);
    json.fill(0);
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    try {
        return {
            version: 2,
            settingsVersion,
            nonce: encode(nonce),
            ciphertext: encode(
                await encryptKey(
                    plaintext,
                    settingsKey,
                    nonce,
                    settingsContext(userId, 2, settingsVersion),
                ),
            ),
        };
    } finally {
        plaintext.fill(0);
    }
}

/*
 * The settings out of a version 2 envelope, under the settings key. A version
 * 1 envelope is null: it is not opened, and the caller treats it as no
 * settings (its rollback mark still applies). Anything else is refused.
 */
export async function openSettings(
    settingsKey: Uint8Array<ArrayBuffer> | null,
    userId: string,
    envelope: SettingsEnvelope,
): Promise<Settings | null> {
    if (
        (envelope.version !== 1 && envelope.version !== 2) ||
        !Number.isSafeInteger(envelope.settingsVersion) ||
        envelope.settingsVersion < 1
    )
        throw new CryptoError('Unsupported settings envelope.');
    if (envelope.version === 1) return null;
    if (!settingsKey) throw new CryptoError('Open your settings key first.');
    const plaintext = await decryptKey(
        decode(envelope.ciphertext),
        settingsKey,
        decode(envelope.nonce, 24),
        settingsContext(userId, 2, envelope.settingsVersion),
    );
    try {
        return readSettingsDocument(plaintext);
    } finally {
        plaintext.fill(0);
    }
}

/*
 * The text with every unpaired \uD800..\uDFFF escape inside a string written
 * as \uFFFD (the core's without_lone_surrogates): serde_json refuses them, a
 * contact name the server served can hold one, and no field trust reads is
 * outside ASCII. Text outside strings is untouched.
 */
export function withoutLoneSurrogates(text: string) {
    if (!text.includes('\\u')) return text;
    const surrogateAt = (at: number) => {
        if (text[at] !== '\\' || text[at + 1] !== 'u') return null;
        const hex = text.slice(at + 2, at + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        const n = parseInt(hex, 16);
        return n >= 0xd800 && n <= 0xdfff ? n : null;
    };
    let out = '';
    let inString = false;
    let at = 0;
    while (at < text.length) {
        const c = text[at]!;
        if (!inString) inString = c === '"';
        else if (c === '"') inString = false;
        else if (c === '\\') {
            const unit = surrogateAt(at);
            if (unit !== null && unit <= 0xdbff) {
                const low = surrogateAt(at + 6);
                if (low !== null && low >= 0xdc00) {
                    out += text.slice(at, at + 12);
                    at += 12;
                    continue;
                }
            }
            if (unit !== null) {
                out += '\\ufffd';
                at += 6;
                continue;
            }
            // Any other escape: the backslash and the character it escapes, kept as they are.
            const next = text.codePointAt(at + 1);
            const width = next === undefined ? 0 : next > 0xffff ? 2 : 1;
            out += text.slice(at, at + 1 + width);
            at += 1 + width;
            continue;
        }
        out += c;
        at++;
    }
    return out;
}

/*
 * An opened document's plaintext, read: UTF-8 as TextDecoder reads it
 * (malformed bytes replaced, a leading BOM dropped), JSON (anything else is
 * unsupported, not a SyntaxError), then an object with `version` the number 1
 * or 2 and `contacts` an object (an array or null passes `typeof`, and holds
 * no pin keyed by a user id). The core reads it the same way
 * (ledger_settings.rs, read_document).
 */
export function readSettingsDocument(plaintext: Uint8Array): Settings {
    let parsed: unknown;
    try {
        parsed = JSON.parse(withoutLoneSurrogates(new TextDecoder().decode(plaintext)));
    } catch {
        throw new CryptoError('Unsupported settings document.');
    }
    if (
        !parsed ||
        typeof parsed !== 'object' ||
        ((parsed as Settings).version !== 1 && (parsed as Settings).version !== 2) ||
        typeof (parsed as Settings).contacts !== 'object'
    )
        throw new CryptoError('Unsupported settings document.');
    return parsed as Settings;
}
