import {
    createCryptoSession,
    type ContactPin,
    type CryptoRequests,
    type CryptoResults,
    type Settings,
    type SettingsEnvelope,
    type SettingsKeyEnvelope,
} from '@hushos/crypto';
import { createDeviceKey, rememberAccountKey } from '@hushos/crypto/device';
import { fingerprint, hexBytes, keyDigest } from '@hushos/crypto/fingerprint';
import { createIdentity, publicIdentity } from '@hushos/crypto/identity';
import type { GroupContext, GroupSettings } from './context';

/*
 * Real accounts for the families data layer's tests that run against the
 * crypto worker itself (join.test.ts, two-tabs.test.ts): each account has its
 * own root, identity and settings document (kept as the server keeps it, with
 * its compare-and-set), and every `device()` is a fresh worker session, as a
 * new tab or a reload is. Imported by tests only.
 */

export const bytes = (value: string) =>
    Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
        char.charCodeAt(0),
    );

type Call = <K extends keyof CryptoRequests>(
    operation: K,
    input: CryptoRequests[K],
) => Promise<CryptoResults[K]>;

/* An account's settings as the server keeps them, with its compare-and-set. */
type Stored = {
    key: SettingsKeyEnvelope | null;
    version: number;
    envelope: SettingsEnvelope | null;
};

export async function account(userId: string) {
    const root = crypto.getRandomValues(new Uint8Array(32));
    const identity = await createIdentity(root, userId);
    const stored: Stored = { key: null, version: 0, envelope: null };
    const device = async () => {
        const deviceKey = await createDeviceKey();
        const bundle = await rememberAccountKey(root, deviceKey, {
            userId,
            keyVersion: 1,
            credentialVersion: 1,
            deviceKeyId: crypto.randomUUID(),
        });
        const session = createCryptoSession();
        let id = 0;
        const call: Call = (operation, input) =>
            session.handle({ id: ++id, operation, input } as Parameters<
                typeof session.handle
            >[0]) as Promise<never>;
        await call('restore', { deviceKey, bundle });
        await call('identityOpen', { userId, identity, history: [] });
        if (!stored.key) stored.key = (await call('settingsKeyCreate', { userId })).settingsKey;
        else await call('settingsKeyOpen', { userId, settingsKey: stored.key });
        /* The settings document, read through the worker and saved compare-and-set. */
        const settings: GroupContext['settings'] = {
            read: async () => {
                if (!stored.envelope)
                    return { settings: { version: 2, contacts: {} }, version: stored.version };
                const opened = await call('settingsOpen', { userId, envelope: stored.envelope });
                return {
                    settings: (opened.settings ?? { version: 2, contacts: {} }) as GroupSettings,
                    version: stored.version,
                };
            },
            write: async (version, doc) => {
                if (version !== stored.version) return false;
                const { envelope } = await call('settingsSeal', {
                    userId,
                    settingsVersion: version + 1,
                    settings: doc as Settings,
                });
                Object.assign(stored, { version: version + 1, envelope });
                return true;
            },
        };
        // An empty document stored once, so every read opens one in the worker.
        if (!stored.envelope) await settings.write(stored.version, { version: 2, contacts: {} });
        return { call, settings };
    };
    return { userId, identity, served: publicIdentity(identity), stored, device };
}

export async function pinOf(who: Awaited<ReturnType<typeof account>>): Promise<ContactPin> {
    const s = who.served;
    const mlDsaPublicKeyHash = await keyDigest(bytes(s.mlDsaPublicKey));
    const kemPublicKeyHash = await keyDigest(bytes(s.kemPublicKey));
    return {
        userId: who.userId,
        email: 'bob@example.com',
        name: 'Bob',
        keyVersion: s.keyVersion,
        pinnedAt: '2026-10-16T00:00:00.000Z',
        encryptionPublicKey: s.encryptionPublicKey,
        signingPublicKey: s.signingPublicKey,
        mlDsaPublicKeyHash,
        kemPublicKeyHash,
        fingerprint: await fingerprint(
            bytes(s.encryptionPublicKey),
            bytes(s.signingPublicKey),
            hexBytes(mlDsaPublicKeyHash),
            hexBytes(kemPublicKeyHash),
        ),
    };
}
