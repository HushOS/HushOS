import type { ContactIdentity, ContactPin, Settings } from '@hushos/auth/api';
import { fingerprint, publicKeyBytes } from '@hushos/auth/client';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { authClient } from '@/lib/auth-client';

/*
 * Contacts are pins: a person's identity key as it was the first time it was
 * looked up, with the fingerprint both people compare. The pins live in the
 * settings document, sealed in the worker under the identity key, so every
 * device sees the same pins and a key the server swaps later is noticed rather
 * than trusted. Reads are cached per unlock; a lock forgets the identity in the
 * worker, and the next read opens it again.
 */

export const EMPTY: Settings = { version: 1, contacts: {} };

let opened: { userId: string; promise: Promise<string> } | undefined;
authClient.store.subscribe((state, previous) => {
    if (state.unlockedUserId !== previous.unlockedUserId) opened = undefined;
});

/* Opens the identity in the worker once per unlock; returns the encryption public key. */
export function openIdentity(userId: string) {
    if (opened?.userId !== userId)
        opened = {
            userId,
            promise: (async () => {
                const { identity } = await authClient.identity();
                const result = await authClient.rpc('identityOpen', { userId, identity });
                return result.encryptionPublicKey;
            })().catch((error: unknown) => {
                opened = undefined;
                throw error;
            }),
        };
    return opened.promise;
}

export const contactKeys = {
    all: ['contacts'] as const,
    settings: (userId: string) => ['contacts', 'settings', userId] as const,
    own: (userId: string) => ['contacts', 'own', userId] as const,
};

export type LoadedSettings = { settings: Settings; version: number };

async function loadSettings(userId: string): Promise<LoadedSettings> {
    await openIdentity(userId);
    const { settings: envelope } = await authClient.settings();
    if (!envelope) return { settings: EMPTY, version: 0 };
    const { settings } = await authClient.rpc('settingsOpen', { userId, envelope });
    return { settings, version: envelope.settingsVersion };
}

export const settingsQueryOptions = (userId: string) =>
    queryOptions({
        queryKey: contactKeys.settings(userId),
        queryFn: () => loadSettings(userId),
        staleTime: 30_000,
        retry: 1,
    });

/* The person's own fingerprint, for the other side of the comparison. */
export const ownFingerprintQueryOptions = (userId: string) =>
    queryOptions({
        queryKey: contactKeys.own(userId),
        queryFn: async () => fingerprint(publicKeyBytes(await openIdentity(userId))),
        staleTime: Infinity,
        retry: 1,
    });

/*
 * Compare-and-set save: re-read, apply the change, seal under the next version,
 * and retry once if another device saved in between.
 */
export async function saveSettings(
    queryClient: QueryClient | undefined,
    userId: string,
    change: (settings: Settings) => Settings,
) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const current = await loadSettings(userId);
        const next = change(structuredClone(current.settings));
        const { envelope } = await authClient.rpc('settingsSeal', {
            userId,
            settingsVersion: current.version + 1,
            settings: next,
        });
        try {
            const saved = await authClient.saveSettings({
                expectedVersion: current.version,
                nonce: envelope.nonce,
                ciphertext: envelope.ciphertext,
            });
            queryClient?.setQueryData(contactKeys.settings(userId), {
                settings: next,
                version: saved.settingsVersion,
            });
            return next;
        } catch (error) {
            if (attempt === 0 && /another device/.test(String((error as Error).message))) continue;
            throw error;
        }
    }
    throw new Error('Your settings keep changing on another device. Try again.');
}

export type Lookup = {
    contact: ContactIdentity;
    fingerprint: string;
    /* The pin already held for this person, when there is one. */
    pinned: ContactPin | null;
    /* The looked-up key differs from the pinned one: a warning, never a silent update. */
    changed: boolean;
};

/* Looks a person up by email and compares the key the server gave with the pin held. */
export async function lookupContact(
    queryClient: QueryClient,
    userId: string,
    email: string,
): Promise<Lookup> {
    const [{ contact }, loaded] = await Promise.all([
        authClient.lookupContact(email),
        queryClient.fetchQuery(settingsQueryOptions(userId)),
    ]);
    const print = await fingerprint(publicKeyBytes(contact.encryptionPublicKey));
    const pinned = loaded.settings.contacts[contact.userId] ?? null;
    return {
        contact,
        fingerprint: print,
        pinned,
        changed: pinned !== null && pinned.encryptionPublicKey !== contact.encryptionPublicKey,
    };
}

export function pinContact(queryClient: QueryClient, userId: string, lookup: Lookup) {
    return saveSettings(queryClient, userId, (settings) => {
        settings.contacts[lookup.contact.userId] = {
            userId: lookup.contact.userId,
            email: lookup.contact.email,
            name: lookup.contact.name,
            encryptionPublicKey: lookup.contact.encryptionPublicKey,
            signingPublicKey: lookup.contact.signingPublicKey,
            fingerprint: lookup.fingerprint,
            pinnedAt: new Date().toISOString(),
        };
        return settings;
    });
}

export function removeContact(queryClient: QueryClient, userId: string, contactId: string) {
    return saveSettings(queryClient, userId, (settings) => {
        delete settings.contacts[contactId];
        return settings;
    });
}

/* The app's query client, so pins made while opening a share reach the contacts page too. */
let boundQueryClient: QueryClient | undefined;
export function bindContactsToQueries(client: QueryClient) {
    boundQueryClient = client;
}

/*
 * Which key to open a share with. The pinned key when there is one; the served
 * key on first use, pinned right then, so a later swap is caught; and a refusal
 * when the served key differs from the pin, because that is exactly the attack
 * the pin exists to catch.
 */
export async function trustGranter(granter: {
    id: string;
    name: string;
    email: string;
    encryptionPublicKey: string;
}) {
    const userId = authClient.store.getState().unlockedUserId;
    if (!userId) throw new Error('Unlock your account first.');
    const loaded = await loadSettings(userId);
    const pinned = loaded.settings.contacts[granter.id];
    if (pinned) {
        if (pinned.encryptionPublicKey === granter.encryptionPublicKey)
            return pinned.encryptionPublicKey;
        throw new Error(
            `${granter.name}’s key has changed since you pinned it. Check the fingerprint with them on the Contacts page before opening what they shared.`,
        );
    }
    const print = await fingerprint(publicKeyBytes(granter.encryptionPublicKey));
    await saveSettings(boundQueryClient, userId, (settings) => {
        settings.contacts[granter.id] = {
            userId: granter.id,
            email: granter.email,
            name: granter.name,
            encryptionPublicKey: granter.encryptionPublicKey,
            signingPublicKey: '',
            fingerprint: print,
            pinnedAt: new Date().toISOString(),
        };
        return settings;
    });
    return granter.encryptionPublicKey;
}
