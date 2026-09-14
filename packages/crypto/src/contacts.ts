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
};

export type Settings = {
    version: 1;
    contacts: Record<string, ContactPin>;
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
    const plaintext = new TextEncoder().encode(JSON.stringify(settings));
    if (plaintext.length > SETTINGS_MAX_BYTES) throw new CryptoError('Settings are too large.');
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
