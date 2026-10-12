import { CryptoError } from './errors';
import { decryptKey, encryptKey } from './aead';
import { decode, encode } from './keys';

/*
 * Contacts and the settings they are pinned in.
 *
 * A fingerprint (see fingerprint.ts) is what two people compare over another
 * channel before they trust a key the server handed them.
 *
 * Settings (the contact pins, and later anything else that must agree across
 * devices) are one JSON document sealed under a key derived from the identity
 * encryption private key. That key survives password changes, master-key
 * rotation and recovery unchanged, so settings need no rewrap in any of those
 * flows, and they are readable exactly by whoever holds the identity.
 */

export const SETTINGS_MAX_BYTES = 64 * 1024;
export const SETTINGS_PAD_STEP = 1024;

export { fingerprint } from './fingerprint';

export type SettingsEnvelope = {
    version: 1;
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
     * SHA-256 of the contact's ML-KEM public key, recorded when it was first
     * seen vouched for by their signing key; a different key served later is a
     * swap, and none at all is a downgrade. Absent until they have one.
     */
    kemPublicKeyHash?: string | null;
    /*
     * The identity key version the pin was made at, so a later change of keys
     * can be followed by its succession chain from here. Absent on pins made
     * before successions; the chain is then found from the pinned keys.
     */
    keyVersion?: number | null;
};

export type Settings = {
    version: 1;
    contacts: Record<string, ContactPin>;
    /*
     * The owner's own record of what they shared: per node, the people it was
     * shared with; per link, its node. Only what is here is ever sealed again on
     * rotation or upgrade (see SharingLedger in @hushos/drive/client). Every
     * client keeps fields it does not know when it saves.
     */
    sharing?: { shares: Record<string, string[]>; links: Record<string, string> };
};

export const EMPTY_SETTINGS: Settings = { version: 1, contacts: {} };

async function settingsKey(identityPrivateKey: Uint8Array<ArrayBuffer>) {
    const key = await crypto.subtle.importKey('raw', identityPrivateKey, 'HKDF', false, [
        'deriveBits',
    ]);
    return new Uint8Array(
        await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new Uint8Array(32),
                info: new TextEncoder().encode('hushos/settings/v1'),
            },
            key,
            256,
        ),
    ) as Uint8Array<ArrayBuffer>;
}
function settingsContext(userId: string, settingsVersion: number) {
    return new TextEncoder().encode(
        JSON.stringify(['hushos/settings', 1, userId.toLowerCase(), settingsVersion]),
    );
}

export async function sealSettings(
    identityPrivateKey: Uint8Array<ArrayBuffer>,
    userId: string,
    settingsVersion: number,
    settings: Settings,
): Promise<SettingsEnvelope> {
    if (!Number.isSafeInteger(settingsVersion) || settingsVersion < 1)
        throw new CryptoError('Invalid settings version.');
    const json = new TextEncoder().encode(JSON.stringify(settings));
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
    const key = await settingsKey(identityPrivateKey);
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    try {
        return {
            version: 1,
            settingsVersion,
            nonce: encode(nonce),
            ciphertext: encode(
                await encryptKey(plaintext, key, nonce, settingsContext(userId, settingsVersion)),
            ),
        };
    } finally {
        key.fill(0);
        plaintext.fill(0);
    }
}

export async function openSettings(
    identityPrivateKey: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: SettingsEnvelope,
): Promise<Settings> {
    if (
        envelope.version !== 1 ||
        !Number.isSafeInteger(envelope.settingsVersion) ||
        envelope.settingsVersion < 1
    )
        throw new CryptoError('Unsupported settings envelope.');
    const key = await settingsKey(identityPrivateKey);
    try {
        const plaintext = await decryptKey(
            decode(envelope.ciphertext),
            key,
            decode(envelope.nonce, 24),
            settingsContext(userId, envelope.settingsVersion),
        );
        const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
        plaintext.fill(0);
        if (
            !parsed ||
            typeof parsed !== 'object' ||
            (parsed as Settings).version !== 1 ||
            typeof (parsed as Settings).contacts !== 'object'
        )
            throw new CryptoError('Unsupported settings document.');
        return parsed as Settings;
    } finally {
        key.fill(0);
    }
}
