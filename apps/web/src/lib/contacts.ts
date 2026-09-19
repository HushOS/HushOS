import type { ContactIdentity, ContactPin, Settings } from '@hushos/auth/api';
import { fingerprint, keyDigest, publicKeyBytes } from '@hushos/auth/client';
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

/*
 * Opens the identity in the worker once per unlock; returns the encryption
 * public key. An identity from before hybrid sharing has no KEM key yet: it is
 * minted and signed in the worker, stored once on the server, and the envelope
 * reopened with it, so every share from now on can be sealed hybrid.
 */
export function openIdentity(userId: string) {
    if (opened?.userId !== userId)
        opened = {
            userId,
            promise: (async () => {
                let { identity } = await authClient.identity();
                let result = await authClient.rpc('identityOpen', { userId, identity });
                if (!result.kemPublicKey) {
                    const { kem } = await authClient.rpc('identityMintKem', { userId, identity });
                    try {
                        await authClient.addIdentityKem(kem);
                        identity = { ...identity, kem };
                    } catch (error) {
                        // Another device got there first: take the key it stored.
                        if (!/already has/.test(String((error as Error).message))) throw error;
                        identity = (await authClient.identity()).identity;
                    }
                    result = await authClient.rpc('identityOpen', {
                        userId,
                        identity,
                        refresh: true,
                    });
                }
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

/* A contact's identity as the server serves it: what every pin check is made against. */
type Served = {
    encryptionPublicKey: string;
    signingPublicKey: string;
    kem: { publicKey: string; signature: string } | null;
};

export type Lookup = {
    contact: ContactIdentity;
    fingerprint: string;
    /* The pin already held for this person, when there is one. */
    pinned: ContactPin | null;
    /* The looked-up key differs from the pinned one: a warning, never a silent update. */
    changed: boolean;
    /* Their post-quantum key, when they have one: its digest, and whether their signing key vouches for it. */
    kem: { hash: string; valid: boolean } | null;
};

async function servedKem(contactUserId: string, served: Served) {
    if (!served.kem) return null;
    const [{ valid }, hash] = await Promise.all([
        authClient.rpc('identityVerifyKem', {
            userId: contactUserId,
            encryptionPublicKey: served.encryptionPublicKey,
            signingPublicKey: served.signingPublicKey,
            kem: served.kem,
        }),
        keyDigest(publicKeyBytes(served.kem.publicKey)),
    ]);
    return { hash, valid };
}

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
    const kem = await servedKem(contact.userId, contact);
    // A changed X25519 key, a changed KEM key, or a KEM key gone missing: all warnings.
    const changed =
        pinned !== null &&
        (pinned.encryptionPublicKey !== contact.encryptionPublicKey ||
            (Boolean(pinned.kemPublicKeyHash) && (!kem || kem.hash !== pinned.kemPublicKeyHash)));
    return { contact, fingerprint: print, pinned, changed, kem };
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
            kemPublicKeyHash: lookup.kem?.valid ? lookup.kem.hash : null,
        };
        return settings;
    });
}

/*
 * The keys a share to a pinned contact is sealed to when the server, not the
 * person, names them: on rotation, when re-sealing older shares, and behind
 * the share dialog. The served X25519 key must be the pinned one. A KEM key
 * seen for the first time is taken when the contact's signing key signed it,
 * and its digest joins the pin, so that a different key served later, or none
 * at all, is refused rather than sealed to.
 */
export async function trustGrantee(
    userId: string,
    granteeUserId: string,
    served: Served,
): Promise<{ encryptionPublicKey: string; kemPublicKey: string | null }> {
    const loaded = await loadSettings(userId);
    const pinned = loaded.settings.contacts[granteeUserId];
    if (!pinned) throw new Error('This person is not in your contacts. Pin them before sharing.');
    if (pinned.encryptionPublicKey !== served.encryptionPublicKey)
        throw new Error(
            `${pinned.name}’s key has changed since you pinned it. Check the fingerprint with them on the Contacts page before sharing.`,
        );
    if (!served.kem) {
        if (pinned.kemPublicKeyHash)
            throw new Error(
                `${pinned.name}’s post-quantum key is missing from what the server sent. Nothing was shared.`,
            );
        return { encryptionPublicKey: pinned.encryptionPublicKey, kemPublicKey: null };
    }
    const hash = await keyDigest(publicKeyBytes(served.kem.publicKey));
    if (pinned.kemPublicKeyHash) {
        if (pinned.kemPublicKeyHash !== hash)
            throw new Error(
                `${pinned.name}’s post-quantum key has changed since you pinned it. Check with them before sharing.`,
            );
        return {
            encryptionPublicKey: pinned.encryptionPublicKey,
            kemPublicKey: served.kem.publicKey,
        };
    }
    const signingPublicKey = pinned.signingPublicKey || served.signingPublicKey;
    const { valid } = await authClient.rpc('identityVerifyKem', {
        userId: granteeUserId,
        encryptionPublicKey: pinned.encryptionPublicKey,
        signingPublicKey,
        kem: served.kem,
    });
    if (!valid)
        throw new Error(
            `${pinned.name}’s post-quantum key is not signed by their identity. Nothing was shared.`,
        );
    await saveSettings(boundQueryClient, userId, (settings) => {
        const pin = settings.contacts[granteeUserId];
        if (pin) {
            pin.kemPublicKeyHash = hash;
            if (!pin.signingPublicKey) pin.signingPublicKey = signingPublicKey;
        }
        return settings;
    });
    return { encryptionPublicKey: pinned.encryptionPublicKey, kemPublicKey: served.kem.publicKey };
}

/* Behind the share dialog: the pinned contact's served identity, checked against the pin. */
export async function granteeKeys(userId: string, pin: ContactPin) {
    const { contact } = await authClient.lookupContact(pin.email);
    if (contact.userId !== pin.userId)
        throw new Error('That address now belongs to a different account.');
    return { userId: pin.userId, ...(await trustGrantee(userId, pin.userId, contact)) };
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
