import type { ContactIdentity, Settings, SettingsKeyEnvelope } from '@hushos/auth/api';
import {
    fingerprint,
    keyDigest,
    pinVerified,
    publicKeyBytes,
    settingsRolledBack,
} from '@hushos/auth/client';
import type { SharingLedger, TrustedGranter, TrustedGrantee } from '@hushos/drive/client';
import {
    comparePin,
    granterKeysOf,
    replacementUnseen,
    pinAfterSuccession,
    signersFromPins,
    type Pin,
    type ServedKeys,
} from '@hushos/drive/trust';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { authClient } from '@/lib/auth-client';
import { onStaleIdentity } from '@/lib/drive-api';

/*
 * Contacts are pins: a person's identity keys as they were when their words
 * were compared, with the fingerprint both people compare. The pins live in the
 * settings document, sealed in the worker under the settings key, so every
 * device sees the same pins and a key the server swaps later is noticed rather
 * than trusted. A pin moves on to new keys without a words check only along a
 * succession chain signed by the keys it held. Reads are cached per unlock; a
 * lock forgets the identity and the settings key in the worker, and the next
 * read opens them again.
 */

export type { Pin };
export { replacementUnseen };
/* The settings as this app reads them: pins carry what the web keeps beside them. */
export type LoadedSettings = {
    settings: Omit<Settings, 'contacts'> & {
        contacts: Record<string, Pin>;
        /*
         * Set before this account replaces its sharing keys and cleared once every
         * share it made is sealed again under the new ones; an interrupted
         * replacement is finished by the next upgrade pass, not done again.
         */
        resealOwnShares?: boolean;
    };
    version: number;
};
export const EMPTY: LoadedSettings['settings'] = { version: 1, contacts: {} };

type OwnIdentity = { keyVersion: number; encryptionPublicKey: string; signingPublicKey: string };
let opened: { userId: string; promise: Promise<OwnIdentity> } | undefined;
let settingsKeyOpened: { userId: string; promise: Promise<void> } | undefined;
authClient.store.subscribe((state, previous) => {
    if (state.unlockedUserId !== previous.unlockedUserId) {
        opened = undefined;
        settingsKeyOpened = undefined;
    }
});

/*
 * Opens the identity in the worker once per unlock, with every earlier one the
 * account has had (shares sealed to them open only with them, and what was
 * signed with them still checks); returns its key version and public keys,
 * proven against the private keys. An identity from before hybrid sharing has
 * no KEM key yet: it is minted and signed in the worker, stored once on the
 * server, and the envelope reopened with it.
 */
export function openIdentity(userId: string, refresh = false) {
    if (opened?.userId !== userId || refresh)
        opened = {
            userId,
            promise: (async () => {
                let [{ identity }, { identities: history }] = await Promise.all([
                    authClient.identity(),
                    authClient.identityHistory(),
                ]);
                let result = await authClient.rpc('identityOpen', {
                    userId,
                    identity,
                    history,
                    refresh,
                });
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
                        history,
                        refresh: true,
                    });
                }
                return {
                    keyVersion: result.keyVersion,
                    encryptionPublicKey: result.encryptionPublicKey,
                    signingPublicKey: result.signingPublicKey,
                };
            })().catch((error: unknown) => {
                opened = undefined;
                throw error;
            }),
        };
    return opened.promise;
}

onStaleIdentity(() => {
    const userId = authClient.store.getState().unlockedUserId;
    if (userId) void openIdentity(userId, true).catch(() => {});
});

/*
 * Replaces this account's identity (sharing keys) by a succession: new keys at
 * the next key version, the statement signed by the current signing key, so
 * contacts follow without comparing words again (see docs/integrity-design.md).
 * Settings are moved under the settings key first, since version 1 is sealed
 * under the identity being replaced. Once the server took it, the identity is
 * opened again with the old one in its history (shares sealed to it still
 * open), and the caller seals again what this account shares.
 */
export async function succeedIdentity(queryClient: QueryClient, userId: string) {
    // Saving moves version 1 settings under the settings key, and leaves the reminder to seal again.
    await saveSettings(queryClient, userId, (settings) => {
        settings.resealOwnShares = true;
        return settings;
    });
    await openIdentity(userId);
    const { identity } = await authClient.identity();
    const { identity: next, signature } = await authClient.rpc('identitySucceed', {
        userId,
        identity,
    });
    await authClient.succeedIdentity({ identity: next, signature });
    const opened = await openIdentity(userId, true);
    // The twelve words are over the keys: new keys, new words.
    void queryClient.invalidateQueries({ queryKey: contactKeys.own(userId) });
    return opened;
}

export const contactKeys = {
    all: ['contacts'] as const,
    settings: (userId: string) => ['contacts', 'settings', userId] as const,
    own: (userId: string) => ['contacts', 'own', userId] as const,
};

/*
 * The newest settings version this device has seen, per account and identity.
 * The server keeps the settings and could hand back an older copy, or none,
 * to bring back a pin the person replaced or drop one they made; a device that
 * has seen version n refuses anything older. A new identity starts its own count.
 */
export { pinVerified };

const SEEN_PREFIX = 'hushos.settings-seen';
function seenKey(userId: string, identityKey: string) {
    return `${SEEN_PREFIX}:${userId}:${identityKey}`;
}
export function settingsSeen(userId: string, identityKey: string) {
    try {
        return Number(window.localStorage.getItem(seenKey(userId, identityKey)) ?? 0) || 0;
    } catch {
        return 0;
    }
}
export function rememberSettingsSeen(userId: string, identityKey: string, version: number) {
    try {
        if (version > settingsSeen(userId, identityKey))
            window.localStorage.setItem(seenKey(userId, identityKey), String(version));
    } catch {
        /* No storage: this device simply cannot tell an old copy from a new one. */
    }
}
const ROLLED_BACK =
    'The server sent older settings than this device has seen, so nothing was changed. Try again later, and tell your operator if it keeps happening.';

/*
 * The settings key in the worker, once per unlock: the one the server keeps,
 * or, before the account has one and only when something is about to be
 * saved, a fresh one stored once. A device that loses that race opens the key
 * the other one stored.
 */
function settingsKeyReady(userId: string, served: SettingsKeyEnvelope | null, create: boolean) {
    if (settingsKeyOpened?.userId === userId) return settingsKeyOpened.promise;
    if (!served && !create) return Promise.resolve();
    const promise = (async () => {
        if (served) {
            await authClient.rpc('settingsKeyOpen', { userId, settingsKey: served });
            return;
        }
        const { settingsKey } = await authClient.rpc('settingsKeyCreate', { userId });
        try {
            await authClient.saveSettingsKey(settingsKey);
        } catch (error) {
            const stored = (await authClient.settings()).settingsKey;
            if (!stored) throw error;
            await authClient.rpc('settingsKeyOpen', { userId, settingsKey: stored });
        }
    })().catch((error: unknown) => {
        settingsKeyOpened = undefined;
        throw error;
    });
    settingsKeyOpened = { userId, promise };
    return promise;
}

async function readSettings(userId: string, create: boolean): Promise<LoadedSettings> {
    const own = await openIdentity(userId);
    const { settings: envelope, settingsKey } = await authClient.settings();
    await settingsKeyReady(userId, settingsKey, create);
    const seen = settingsSeen(userId, own.encryptionPublicKey);
    if (settingsRolledBack(envelope?.settingsVersion ?? null, seen)) throw new Error(ROLLED_BACK);
    if (!envelope) return { settings: EMPTY, version: 0 };
    const { settings } = await authClient.rpc('settingsOpen', { userId, envelope });
    rememberSettingsSeen(userId, own.encryptionPublicKey, envelope.settingsVersion);
    const loaded = {
        settings: settings as LoadedSettings['settings'],
        version: envelope.settingsVersion,
    };
    // Version 1 is sealed under a key off the identity, which a succession replaces: it is
    // read once and saved again under the settings key, before anything can strand it.
    if (envelope.version === 1) return migrate(userId, loaded);
    return loaded;
}

async function migrate(userId: string, loaded: LoadedSettings): Promise<LoadedSettings> {
    const { settingsKey } = await authClient.settings();
    await settingsKeyReady(userId, settingsKey, true);
    const { envelope } = await authClient.rpc('settingsSeal', {
        userId,
        settingsVersion: loaded.version + 1,
        settings: loaded.settings,
    });
    try {
        const saved = await authClient.saveSettings({
            expectedVersion: loaded.version,
            version: 2,
            nonce: envelope.nonce,
            ciphertext: envelope.ciphertext,
        });
        const own = await openIdentity(userId);
        rememberSettingsSeen(userId, own.encryptionPublicKey, saved.settingsVersion);
        return { settings: loaded.settings, version: saved.settingsVersion };
    } catch (error) {
        // Another device saved (and so moved them) first: read theirs.
        if (/another device/.test(String((error as Error).message)))
            return readSettings(userId, false);
        throw error;
    }
}

function loadSettings(userId: string) {
    return readSettings(userId, false);
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
        queryFn: async () => {
            const own = await openIdentity(userId);
            return fingerprint(
                publicKeyBytes(own.encryptionPublicKey),
                publicKeyBytes(own.signingPublicKey),
            );
        },
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
    change: (settings: LoadedSettings['settings']) => LoadedSettings['settings'],
) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const current = await readSettings(userId, true);
        const next = change(structuredClone(current.settings));
        const { envelope } = await authClient.rpc('settingsSeal', {
            userId,
            settingsVersion: current.version + 1,
            settings: next,
        });
        try {
            const saved = await authClient.saveSettings({
                expectedVersion: current.version,
                version: 2,
                nonce: envelope.nonce,
                ciphertext: envelope.ciphertext,
            });
            const own = await openIdentity(userId);
            rememberSettingsSeen(userId, own.encryptionPublicKey, saved.settingsVersion);
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
type Served = ServedKeys & { kem?: { publicKey: string; signature: string } | null };

/*
 * Brings a pin up to the keys the server serves, when it can without a words
 * check: the pinned keys themselves, or new ones a succession chain signed by
 * the pinned keys leads to. Anything else (a changed key, a chain that does
 * not hold, none at all) is `changed`, and the pin is left as it was. A
 * followed pin is saved at once, so every device takes the same step.
 */
const following = new Map<
    string,
    Promise<{ pin: Pin; outcome: 'same' | 'followed' | 'changed' }>
>();
async function bringUpToDate(userId: string, pin: Pin, served: Served) {
    const comparison = await comparePin(pin, served);
    if (comparison !== 'succession') return { pin, outcome: comparison };
    const key = `${pin.userId}:${served.encryptionPublicKey}`;
    let pending = following.get(key);
    if (!pending) {
        pending = (async () => {
            let links;
            try {
                ({ links } = await authClient.contactSuccession(pin.userId, pin.keyVersion ?? 1));
            } catch {
                return { pin, outcome: 'changed' as const };
            }
            const last = links.at(-1);
            const kemPublicKey = served.kem?.publicKey ?? last?.newKemPublicKey;
            if (!last || !kemPublicKey) return { pin, outcome: 'changed' as const };
            const { valid } = await authClient.rpc('identityVerifyChain', {
                userId: pin.userId,
                pinned: {
                    keyVersion: pin.keyVersion ?? null,
                    encryptionPublicKey: pin.encryptionPublicKey,
                    signingPublicKey: pin.signingPublicKey,
                },
                served: {
                    keyVersion: served.keyVersion,
                    encryptionPublicKey: served.encryptionPublicKey,
                    signingPublicKey: served.signingPublicKey,
                    kemPublicKey,
                },
                links,
            });
            if (!valid) return { pin, outcome: 'changed' as const };
            const next = await pinAfterSuccession(pin, served, kemPublicKey, new Date());
            await saveSettings(boundQueryClient, userId, (settings) => {
                const current = settings.contacts[pin.userId];
                // Only from the keys the chain was checked from: another device may have moved first.
                if (
                    current &&
                    current.encryptionPublicKey === pin.encryptionPublicKey &&
                    current.signingPublicKey === pin.signingPublicKey
                )
                    settings.contacts[pin.userId] = next;
                return settings;
            });
            return { pin: next, outcome: 'followed' as const };
        })().finally(() => following.delete(key));
        following.set(key, pending);
    }
    return pending;
}

/*
 * Looks up a pinned contact's served keys and follows a succession to them
 * when a signed chain holds. True when the pin moved on.
 */
export async function followServedKeys(userId: string, signer: { id: string; email: string }) {
    const { settings } = await loadSettings(userId);
    const held = settings.contacts[signer.id];
    if (!held) return false;
    const { contact } = await authClient.lookupContact(held.email);
    if (contact.userId !== held.userId) return false;
    return (await bringUpToDate(userId, held, contact)).outcome === 'followed';
}

export type Lookup = {
    contact: ContactIdentity;
    fingerprint: string;
    /* The pin already held for this person, when there is one. */
    pinned: Pin | null;
    /* The looked-up key differs from the pinned one and no signed chain explains it: a warning, never a silent update. */
    changed: boolean;
    /* The pin predates a words check over every key it holds: check again before it counts. */
    stale: boolean;
    /* The pin followed their signed succession to the keys looked up just now. */
    followed: boolean;
    /* Their post-quantum key, when they have one: its digest, and whether their signing key vouches for it. */
    kem: { hash: string; valid: boolean } | null;
};

async function servedKem(contactUserId: string, served: ContactIdentity) {
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

/* Looks a person up by email and compares the keys the server gave with the pin held. */
export async function lookupContact(
    queryClient: QueryClient,
    userId: string,
    email: string,
): Promise<Lookup> {
    const [{ contact }, loaded] = await Promise.all([
        authClient.lookupContact(email),
        queryClient.fetchQuery(settingsQueryOptions(userId)),
    ]);
    const print = await fingerprint(
        publicKeyBytes(contact.encryptionPublicKey),
        publicKeyBytes(contact.signingPublicKey),
    );
    const held = loaded.settings.contacts[contact.userId] ?? null;
    const kem = await servedKem(contact.userId, contact);
    const checked = held ? await bringUpToDate(userId, held, contact) : null;
    const pinned = checked?.pin ?? null;
    const changed = checked?.outcome === 'changed';
    const stale = pinned !== null && !changed && !(await pinVerified(pinned));
    return {
        contact,
        fingerprint: print,
        pinned,
        changed,
        stale,
        followed: checked?.outcome === 'followed',
        kem,
    };
}

export function pinContact(queryClient: QueryClient, userId: string, lookup: Lookup) {
    return saveSettings(queryClient, userId, (settings) => {
        const before = settings.contacts[lookup.contact.userId];
        const moved =
            before !== undefined &&
            (before.encryptionPublicKey !== lookup.contact.encryptionPublicKey ||
                before.signingPublicKey !== lookup.contact.signingPublicKey);
        // Fields this version does not know are kept; so are the keys a followed succession
        // left behind, unless these words were compared over brand-new keys.
        const kept = { ...before } as Partial<Pin>;
        if (moved) {
            delete kept.previousSigningKeys;
            delete kept.keysReplacedAt;
            delete kept.replacementSeen;
        }
        settings.contacts[lookup.contact.userId] = {
            ...kept,
            userId: lookup.contact.userId,
            email: lookup.contact.email,
            name: lookup.contact.name,
            encryptionPublicKey: lookup.contact.encryptionPublicKey,
            signingPublicKey: lookup.contact.signingPublicKey,
            fingerprint: lookup.fingerprint,
            pinnedAt: new Date().toISOString(),
            kemPublicKeyHash: lookup.kem?.valid ? lookup.kem.hash : null,
            keyVersion: lookup.contact.keyVersion,
            // Words compared after a replacement: People need not say so any more.
            ...(!moved && before?.keysReplacedAt ? { replacementSeen: before.keysReplacedAt } : {}),
            // Accepting new keys: what was shared with them is sealed again, to these.
            ...(moved || before?.resealShares ? { resealShares: true } : {}),
        };
        return settings;
    });
}

/* Stops showing that a contact replaced their keys, without comparing words again. */
export function acknowledgeSuccession(queryClient: QueryClient, userId: string, contactId: string) {
    return saveSettings(queryClient, userId, (settings) => {
        const pin = settings.contacts[contactId];
        if (pin?.keysReplacedAt) pin.replacementSeen = pin.keysReplacedAt;
        return settings;
    });
}

/*
 * The keys a share to a pinned contact is sealed to when the server, not the
 * person, names them: on rotation, when re-sealing older shares, and behind
 * the share dialog. The served keys must be the pinned ones, or follow from
 * them through a signed succession. A KEM key seen for the first time is
 * taken when the contact's signing key signed it, and its digest joins the
 * pin, so that a different key served later, or none at all, is refused
 * rather than sealed to.
 */
export async function trustGrantee(
    userId: string,
    granteeUserId: string,
    served: Served & { kem: { publicKey: string; signature: string } | null },
): Promise<TrustedGrantee> {
    const loaded = await loadSettings(userId);
    const held = loaded.settings.contacts[granteeUserId];
    if (!held) throw new Error('This person is not in your contacts. Pin them before sharing.');
    if (!(await pinVerified(held)))
        throw new Error(
            `Check ${held.name}’s words again in People you share with: this pin was made before the words covered all their keys. Nothing was shared.`,
        );
    const { pin: pinned, outcome } = await bringUpToDate(userId, held, served);
    if (outcome === 'changed')
        throw new Error(
            `${pinned.name}’s keys have changed since you checked them. Check it’s them in People you share with before sharing.`,
        );
    // Hybrid only: a share sealed to X25519 alone is a harvest-now, decrypt-later target, and
    // withholding the KEM key is all it would take a server to get one.
    if (!served.kem)
        throw new Error(
            `${pinned.name} hasn’t got post-quantum keys yet, so nothing was shared. They get them the next time they sign in.`,
        );
    if (pinned.kemPublicKeyHash)
        return {
            encryptionPublicKey: pinned.encryptionPublicKey,
            kemPublicKey: served.kem.publicKey,
        };
    // Only the pinned signing key may vouch: the fingerprint compared covers it, the served one could be anyone's.
    const { valid } = await authClient.rpc('identityVerifyKem', {
        userId: granteeUserId,
        encryptionPublicKey: pinned.encryptionPublicKey,
        signingPublicKey: pinned.signingPublicKey,
        kem: served.kem,
    });
    if (!valid)
        throw new Error(
            `${pinned.name}’s post-quantum key is not signed by their identity. Nothing was shared.`,
        );
    const hash = await keyDigest(publicKeyBytes(served.kem.publicKey));
    await saveSettings(boundQueryClient, userId, (settings) => {
        const pin = settings.contacts[granteeUserId];
        if (pin) pin.kemPublicKeyHash = hash;
        return settings;
    });
    return { encryptionPublicKey: pinned.encryptionPublicKey, kemPublicKey: served.kem.publicKey };
}

/* Behind the share dialog: the pinned contact's served identity, checked against the pin. */
export async function granteeKeys(userId: string, pin: Pin) {
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

/* The app's query client, so pins updated behind the share dialog reach the contacts page too. */
let boundQueryClient: QueryClient | undefined;
export function bindContactsToQueries(client: QueryClient) {
    boundQueryClient = client;
}

/* A share whose granter is not pinned yet: shown as waiting for a words check, not as broken. */
export class UnverifiedGranterError extends Error {
    override name = 'UnverifiedGranterError';
}

/*
 * Which keys to open a share with: the pinned ones, and only when the server
 * serves those same keys or ones a signed succession from them leads to. A
 * share from someone not pinned stays shut until the person is added in People
 * you share with and their words are compared; taking the served key on first
 * use would let a server fake a share "from" anyone and plant its own key as
 * theirs.
 */
export async function trustGranter(granter: {
    id: string;
    name: string;
    email: string;
    keyVersion: number;
    encryptionPublicKey: string;
    signingPublicKey: string;
}): Promise<TrustedGranter> {
    const userId = authClient.store.getState().unlockedUserId;
    if (!userId) throw new Error('Unlock your account first.');
    const loaded = await loadSettings(userId);
    const held = loaded.settings.contacts[granter.id];
    if (!held || !(await pinVerified(held)))
        throw new UnverifiedGranterError(
            `Add ${granter.name} in People you share with and check their words to open what they shared.`,
        );
    // The share listing serves no KEM key: only a chain can name one, and opening needs none.
    const { pin, outcome } = await bringUpToDate(userId, held, { ...granter, kem: undefined });
    if (outcome === 'changed')
        throw new Error(
            `${granter.name}’s keys have changed since you checked them. Check it’s them in People you share with before opening what they shared.`,
        );
    return granterKeysOf(pin);
}

/*
 * Who may have written what Drive lists, beside this account: every contact
 * whose words were checked, with the keys their pin followed a succession
 * from. Cached with the settings query, so a listing does not refetch them.
 */
const signersCache = new WeakMap<object, Promise<Record<string, string[]>>>();
export async function trustedSigners(userId: string) {
    const loaded = boundQueryClient
        ? await boundQueryClient.fetchQuery(settingsQueryOptions(userId))
        : await loadSettings(userId);
    let signers = signersCache.get(loaded.settings);
    if (!signers) {
        signers = signersFromPins(loaded.settings.contacts);
        signersCache.set(loaded.settings, signers);
    }
    return signers;
}

/* Grantees whose pin followed a succession: what was shared with them waits to be sealed again. */
export async function resealPending(userId: string) {
    const { settings } = await loadSettings(userId);
    return Object.values(settings.contacts).flatMap((pin) =>
        pin.resealShares ? [pin.userId] : [],
    );
}
export async function resealAll(userId: string) {
    return Boolean((await loadSettings(userId)).settings.resealOwnShares);
}
export async function resealedAll(userId: string) {
    await saveSettings(boundQueryClient, userId, (settings) => {
        delete settings.resealOwnShares;
        return settings;
    });
}
export async function resealedTo(userId: string, granteeUserIds: string[]) {
    await saveSettings(boundQueryClient, userId, (settings) => {
        for (const id of granteeUserIds) {
            const pin = settings.contacts[id];
            if (pin) delete pin.resealShares;
        }
        return settings;
    });
}

/*
 * The sharing ledger (see SharingLedger in @hushos/drive/client), kept in the
 * settings document so every device of the person reads the same one.
 */
function ledgerOf(settings: LoadedSettings['settings']) {
    settings.sharing ??= { shares: {}, links: {} };
    return settings.sharing;
}
export function sharingLedger(userId: () => string | null): SharingLedger {
    const save = (change: (ledger: NonNullable<Settings['sharing']>) => void) => {
        const id = userId();
        if (!id) throw new Error('Unlock your account first.');
        return saveSettings(boundQueryClient, id, (settings) => {
            change(ledgerOf(settings));
            return settings;
        }).then(() => undefined);
    };
    return {
        async read() {
            const id = userId();
            if (!id) return { shares: {}, links: {} };
            const { settings } = await loadSettings(id);
            return settings.sharing ?? { shares: {}, links: {} };
        },
        addShare: (nodeId, granteeUserId) =>
            save((ledger) => {
                const people = (ledger.shares[nodeId] ??= []);
                if (!people.includes(granteeUserId)) people.push(granteeUserId);
            }),
        removeShare: (nodeId, granteeUserId) =>
            save((ledger) => {
                const people = (ledger.shares[nodeId] ?? []).filter((id) => id !== granteeUserId);
                if (people.length) ledger.shares[nodeId] = people;
                else delete ledger.shares[nodeId];
            }),
        addLink: (linkId, nodeId) =>
            save((ledger) => {
                ledger.links[linkId] = nodeId;
            }),
        removeLink: (linkId) =>
            save((ledger) => {
                delete ledger.links[linkId];
            }),
    };
}
