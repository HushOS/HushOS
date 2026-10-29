import type { ContactIdentity, Settings, SettingsKeyEnvelope } from '@hushos/auth/api';
import {
    fingerprintOfKeys,
    pinVerified,
    publicKeyBytes,
    settingsRolledBack,
} from '@hushos/auth/client';
import {
    CONTACTS_FULL,
    contactRemoved,
    keyCommitment,
    nextGuardEntry,
    pinTrust,
    settingsThatFit,
    settingsWithoutContact,
    settingsWithPin,
    withoutRemoval,
    type GuardEntry,
} from '@hushos/crypto/pins';
import type { ServedIdentity } from '@hushos/drive/api';
import type { SharingLedger, TrustedGranter, TrustedGrantee } from '@hushos/drive/client';
import {
    comparePin,
    granterKeysOf,
    keysPassedThrough,
    pinAfterSuccession,
    pinOfServed,
    signersFromPins,
    type DriveSigners,
    type Pin,
} from '@hushos/drive/trust';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { authClient } from '@/lib/auth-client';
import { backfillConsent } from '@/lib/consent-backfill';
import {
    askPersistentStorage,
    createIndexedDbContactGuard,
    createIndexedDbFamilyGuard,
    GuardRacedError,
    GuardUnreadableError,
    GuardUnsavedError,
    withGuardLock,
    type ContactGuardStore,
    type FamilyGuardStore,
    type PendingAct,
    type GuardSealer,
} from '@/lib/contact-guard';
import { onStaleIdentity } from '@/lib/drive-api';
import { pinOf } from '@/lib/family-pin';
import { familyChecked, withFamilyChecks } from '@/lib/groups/family-checks';
import { openOwnIdentity, type OwnIdentity } from '@/lib/own-identity';
import {
    identitySeen,
    identityVersionSeen,
    migrateMarks,
    rememberIdentitySeen,
    rememberSettingsDocumentSeen,
    rememberSettingsSeen,
    settingsDocumentRolledBack,
    settingsDocumentSeen,
    settingsNoneTrusted,
    settingsSeen,
} from '@/lib/rollback-marks';

/*
 * Contacts are pins: a person's identity keys as this person's devices first
 * saw them (first-seen), or as two people compared twelve words over them
 * (verified). The pins live in the settings document, sealed in the worker
 * under the settings key, so every device sees the same pins and a key the
 * server swaps later is noticed rather than trusted. A pin moves on to new
 * keys without the person only along a succession chain signed by the keys it
 * held. Reads are cached per unlock; a lock forgets the identity and the
 * settings key in the worker, and the next read opens them again.
 */

export type { Pin };
export { GUARD_UNREADABLE, GUARD_UNSAVED } from '@/lib/contact-guard';
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
    /*
     * Settings are stored (the sequence is above 0) but none opened here: a
     * version 1 document, or settings the server withheld from a device that
     * has never opened any. The worker was told nothing, so families cannot
     * use them as a mark (readSettingsForFamilies says so).
     */
    unopened?: true;
};
export const EMPTY: LoadedSettings['settings'] = { version: 2, contacts: {} };

let opened: { userId: string; promise: Promise<OwnIdentity> } | undefined;
let settingsKeyOpened: { userId: string; promise: Promise<void> } | undefined;
let consentBackfilled: { userId: string; promise: Promise<{ stored: number }> } | undefined;
authClient.store.subscribe((state, previous) => {
    if (state.unlockedUserId !== previous.unlockedUserId) {
        opened = undefined;
        settingsKeyOpened = undefined;
        consentBackfilled = undefined;
        if (state.unlockedUserId) sealOlderGuard(state.unlockedUserId);
    }
});

/*
 * Opens the identity in the worker once per unlock, with every earlier one the
 * account has had (shares sealed to them open only with them, and what was
 * signed with them still checks); returns its key version and public keys,
 * proven against the private keys. A version 1 identity is upgraded here
 * before anything is signed (docs/identity-pq-design.md 2): the worker adds an
 * ML-DSA key and the keys statement, the server stores it once, and a device
 * that lost that race opens the one another device stored.
 */
export function openIdentity(userId: string, refresh = false) {
    if (opened?.userId !== userId || refresh) {
        const promise: Promise<OwnIdentity> = (async () => {
            requireUnlocked(userId);
            return openOwnIdentity(
                {
                    fetch: async () => {
                        const [{ identity }, { identities: history }] = await Promise.all([
                            authClient.identity(),
                            authClient.identityHistory(),
                        ]);
                        requireUnlocked(userId);
                        return { identity, history };
                    },
                    open: (identity, history, refresh) =>
                        authClient.rpc('identityOpen', { userId, identity, history, refresh }),
                    upgrade: async (identity) =>
                        (await authClient.rpc('identityUpgrade', { userId, identity })).identity,
                    store: async (identity) =>
                        (await authClient.upgradeIdentity(identity)).identity,
                    seen: async () => ({
                        keyVersion: await identitySeen(userId),
                        identityVersion: await identityVersionSeen(userId),
                    }),
                    remember: (keyVersion, identityVersion) =>
                        rememberIdentitySeen(userId, keyVersion, identityVersion),
                },
                refresh,
            );
        })().catch((error: unknown) => {
            // Only this attempt's own entry: a later refresh may have replaced it meanwhile.
            if (opened?.promise === promise) opened = undefined;
            throw error;
        });
        opened = { userId, promise };
    }
    return opened.promise;
}

onStaleIdentity(() => {
    const userId = authClient.store.getState().unlockedUserId;
    if (userId) void openIdentity(userId, true).catch(() => {});
});

// At each unlock: rollback marks an earlier version kept in the clear are sealed, and deleted.
authClient.store.subscribe((state, previous) => {
    if (state.unlockedUserId && state.unlockedUserId !== previous.unlockedUserId)
        void migrateMarks(state.unlockedUserId);
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
    // Opened afresh, and signed over the envelope opened: the worker signs only for the identity
    // it holds. Another device replacing it meanwhile is refused by the server as stale.
    const { envelope: identity } = await openIdentity(userId, true);
    const {
        identity: next,
        signature,
        consent,
    } = await authClient.rpc('identitySucceed', { userId, identity });
    // The successor's consent goes with the link (docs/groups-server.md 5): group verdicts ask it
    // of links a member's entry walks, and without it this link needs the backfill pass later.
    await authClient.succeedIdentity({ identity: next, signature, consent });
    const opened = await openIdentity(userId, true);
    // The twelve words are over the keys: new keys, new words.
    void queryClient.invalidateQueries({ queryKey: contactKeys.own(userId) });
    return opened;
}

/*
 * Once per unlock, beside the shares upgrade: consent for this account's own
 * earlier successions that landed without it (lib/consent-backfill.ts). The
 * identity is opened first, with its history, since the worker signs consent
 * only for two identities it opened one after the other.
 */
export function backfillOwnConsent(userId: string) {
    if (consentBackfilled?.userId !== userId) {
        const promise = (async () => {
            requireUnlocked(userId);
            await openIdentity(userId);
            return backfillConsent({
                links: async () => (await authClient.contactSuccession(userId, 1)).links,
                identities: async () => {
                    const [{ identity }, { identities: history }] = await Promise.all([
                        authClient.identity(),
                        authClient.identityHistory(),
                    ]);
                    return { identity, history };
                },
                consent: async (link, old, next) =>
                    (await authClient.rpc('identityConsent', { userId, link, old, next })).consent,
                upload: (oldKeyVersion, consent) =>
                    authClient.backfillSuccessionConsent({ oldKeyVersion, consent }),
            });
        })().catch((error: unknown) => {
            if (consentBackfilled?.promise === promise) consentBackfilled = undefined;
            throw error;
        });
        consentBackfilled = { userId, promise };
    }
    return consentBackfilled.promise;
}

export const contactKeys = {
    all: ['contacts'] as const,
    settings: (userId: string) => ['contacts', 'settings', userId] as const,
    own: (userId: string) => ['contacts', 'own', userId] as const,
};

export { pinVerified };

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
            keyEnvelope = { userId, envelope: served };
            return;
        }
        const { settingsKey } = await authClient.rpc('settingsKeyCreate', { userId });
        try {
            await authClient.saveSettingsKey(settingsKey);
            keyEnvelope = { userId, envelope: settingsKey };
        } catch (error) {
            const stored = (await authClient.settings()).settingsKey;
            if (!stored) throw error;
            await authClient.rpc('settingsKeyOpen', { userId, settingsKey: stored });
            keyEnvelope = { userId, envelope: stored };
        }
    })().catch((error: unknown) => {
        settingsKeyOpened = undefined;
        throw error;
    });
    settingsKeyOpened = { userId, promise };
    return promise;
}

/* The settings key envelope the worker opened this unlock, which the rollback marks keep. */
let keyEnvelope: { userId: string; envelope: SettingsKeyEnvelope } | undefined;

/*
 * The settings key in the worker for the rollback marks (lib/rollback-marks.ts), which are
 * sealed under it; answers the envelope it was opened from, for the marks to keep beside them.
 * The server's envelope first. When the server does not answer, or serves none, the one `kept`
 * beside the marks opens the same key, so marks read while the settings cannot be fetched (a
 * server error, or one withheld) and a replayed account key still finds its key on the server.
 * `create` only when no marks are kept here yet: an account with no settings key at all gets
 * one then. Otherwise none is made, and marks that are there stay unopened, and refused.
 */
export async function marksKeyReady(
    userId: string,
    create: boolean,
    kept: SettingsKeyEnvelope | null,
): Promise<SettingsKeyEnvelope | null> {
    requireUnlocked(userId);
    if (settingsKeyOpened?.userId === userId) {
        await settingsKeyOpened.promise;
        return keyEnvelope?.userId === userId ? keyEnvelope.envelope : null;
    }
    // Opened from the kept envelope, the key stays the worker's for this unlock: a later
    // answer from the server never swaps in another one under the marks without proof that
    // the marks open under it (lib/rollback-marks.ts refuses rather than seal them over).
    const fromKept = async () => {
        if (kept === null) return false;
        const { opened } = await authClient.rpc('rollbackMarksKey', { userId, settingsKey: kept });
        if (!opened) return false;
        keyEnvelope = { userId, envelope: kept };
        settingsKeyOpened = { userId, promise: Promise.resolve() };
        return true;
    };
    let served: SettingsKeyEnvelope | null;
    try {
        served = (await authClient.settings()).settingsKey;
    } catch (error) {
        if (await fromKept()) return kept;
        throw error;
    }
    requireUnlocked(userId);
    if (!served && (await fromKept())) return kept;
    await settingsKeyReady(userId, served, create);
    return keyEnvelope?.userId === userId ? keyEnvelope.envelope : null;
}

/* Background reads stop at a lock rather than ask a locked worker, which would lock it again. */
function requireUnlocked(userId: string) {
    if (authClient.store.getState().unlockedUserId !== userId)
        throw new Error('Unlock your account first.');
}

async function readSettings(userId: string, create: boolean): Promise<LoadedSettings> {
    requireUnlocked(userId);
    // The identity first, with its history: what this account signed is checked against it,
    // and a failure here must fail the trust set rather than leave it half loaded.
    await openIdentity(userId);
    requireUnlocked(userId);
    const { settings: served, settingsKey, settingsVersion } = await authClient.settings();
    await settingsKeyReady(userId, settingsKey, create);
    // The stored sequence, whatever is stored: a device that has seen a later one refuses it,
    // document or none. A document served at another sequence than the server says is stored
    // is refused too.
    const seen = await settingsSeen(userId);
    if (settingsRolledBack(settingsVersion, seen)) throw new Error(ROLLED_BACK);
    if (served && served.settingsVersion !== settingsVersion) throw new Error(ROLLED_BACK);
    // Once this device has opened a version 2 document, none (or version 1) is an older copy,
    // whatever sequence it comes at: it would drop the pins it held, family marks among them.
    const documentSeen = await settingsDocumentSeen(userId);
    const servedVersion = served ? (served.version as number) : null;
    if (
        settingsDocumentRolledBack(
            servedVersion === null ? 'none' : servedVersion === 2 ? 2 : 1,
            documentSeen,
        )
    )
        throw new Error(ROLLED_BACK);
    // A version 1 document opens nowhere: it reads as none, under the same rules.
    const envelope = servedVersion === 2 ? served : null;
    await rememberSettingsSeen(userId, settingsVersion);
    // None stored (sequence 0), or a version 1 document the server serves as none at its
    // sequence: empty settings, and the next save names that sequence and is sealed at the
    // one after, which replaces a version 1 row.
    if (!envelope) {
        // The worker hears "no settings" (no family pins to take as marks) only from a brand-new
        // account on a device that has seen nothing; otherwise family acceptance stays refused
        // until settings that open are read ("Open your settings first").
        if (settingsNoneTrusted(settingsVersion, seen, documentSeen)) {
            await authClient.rpc('settingsOpen', { userId, envelope: null });
            return { settings: EMPTY, version: settingsVersion };
        }
        return { settings: EMPTY, version: settingsVersion, unopened: true };
    }
    const { settings } = await authClient.rpc('settingsOpen', { userId, envelope });
    if (!settings) return { settings: EMPTY, version: settingsVersion, unopened: true };
    await rememberSettingsDocumentSeen(userId);
    return { settings: settings as LoadedSettings['settings'], version: settingsVersion };
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
            // Over the keys the worker re-derived from all four private halves, never the served ones.
            let own = await openIdentity(userId);
            // The identity open since unlock may have been replaced from another device; read the
            // words over what this account holds now, opened again (rollback checks included).
            const { identity: served } = await authClient.identity();
            if (
                served.keyVersion !== own.keyVersion ||
                served.encryptionPublicKey !== own.encryptionPublicKey ||
                served.signingPublicKey !== own.signingPublicKey ||
                (served.version === 2 ? served.mlDsa.publicKey : null) !== own.mlDsaPublicKey ||
                (served.kem?.publicKey ?? null) !== own.kemPublicKey
            )
                own = await openIdentity(userId, true);
            return fingerprintOfKeys(
                publicKeyBytes(own.encryptionPublicKey),
                publicKeyBytes(own.signingPublicKey),
                publicKeyBytes(own.mlDsaPublicKey),
                publicKeyBytes(own.kemPublicKey),
            );
        },
        staleTime: Infinity,
        retry: 1,
    });

/*
 * The settings as stored, opened in the worker: settingsOpen is also where the
 * worker takes the group pins it passes to acceptance as marks, so a family
 * sync reads them through here before it accepts anything (lib/groups/pins.ts).
 */
export function readSettingsForWrite(userId: string) {
    return readSettings(userId, true);
}

/*
 * Said when families need settings this device could not open: an account
 * whose only settings are a version 1 document (sealed the old way, opened by
 * no client), or settings the server withheld from a device that has never
 * opened any (a fresh browser, a private window). Either way they can't serve
 * as a mark, and nothing saves over them on its own: a save from this device
 * could only be built on nothing, and would wipe pins every device relies on
 * if the server were hiding them. Adding a contact saves settings the person
 * chose to, and from then on they open here.
 */
export const FAMILY_SETTINGS_NEEDED =
    'Add someone in Contacts first. That sets up where HushOS keeps your family checks on this account.';

/* The settings as families read them (lib/groups/client.ts): refused, plainly, when none opened. */
export async function readSettingsForFamilies(userId: string) {
    const loaded = await readSettings(userId, true);
    if (loaded.unopened) throw new Error(FAMILY_SETTINGS_NEEDED);
    return loaded;
}

/*
 * One compare-and-set save of `settings` over the stored `version`: false when
 * another device saved in between, for callers that must re-derive what they
 * save from the newer document (a family pin is re-accepted, never merged blind).
 */
export async function compareAndSetSettings(
    userId: string,
    version: number,
    given: LoadedSettings['settings'],
) {
    // Removals count against the room the document has: the oldest go first (2.7).
    const settings = settingsThatFit(given);
    const { envelope } = await authClient.rpc('settingsSeal', {
        userId,
        settingsVersion: version + 1,
        settings,
    });
    try {
        const saved = await authClient.saveSettings({
            expectedVersion: version,
            version: 2,
            nonce: envelope.nonce,
            ciphertext: envelope.ciphertext,
        });
        await rememberSettingsSeen(userId, saved.settingsVersion);
        await rememberSettingsDocumentSeen(userId);
        boundQueryClient?.setQueryData(contactKeys.settings(userId), {
            settings,
            version: saved.settingsVersion,
        });
        return true;
    } catch (error) {
        if (/another device/.test(String((error as Error).message))) return false;
        throw error;
    }
}

/*
 * Compare-and-set save: re-read, apply the change, seal under the next version,
 * and retry once if another device saved in between.
 */
export async function saveSettings(
    queryClient: QueryClient | undefined,
    userId: string,
    change: (
        settings: LoadedSettings['settings'],
    ) => LoadedSettings['settings'] | Promise<LoadedSettings['settings']>,
    /* Runs before each attempt is sent, with the stored sequence it must land over. */
    beforeSend?: (expectedVersion: number) => Promise<void>,
) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const current = await readSettings(userId, true);
        // Removals count against the room the document has: the oldest go first (2.7).
        const next = settingsThatFit(await change(structuredClone(current.settings)));
        const { envelope } = await authClient.rpc('settingsSeal', {
            userId,
            settingsVersion: current.version + 1,
            settings: next,
        });
        await beforeSend?.(current.version);
        try {
            const saved = await authClient.saveSettings({
                expectedVersion: current.version,
                version: 2,
                nonce: envelope.nonce,
                ciphertext: envelope.ciphertext,
            });
            await rememberSettingsSeen(userId, saved.settingsVersion);
            await rememberSettingsDocumentSeen(userId);
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

/*
 * First use (docs/optional-verification.md 2): someone added, or met through
 * something they shared, is remembered with the keys the server serves then
 * (a first-seen pin), and shared with at once. Comparing twelve words, any
 * time, makes the pin verified. A later change is followed only along a
 * succession chain signed by keys this device holds; any other change pauses
 * that one person (new shares, re-sealing, opening anything new from them)
 * until the person continues or checks, and nothing is ever sealed to keys
 * nobody pinned, followed or accepted.
 *
 * The settings pin is used only if it agrees with the guard this device keeps
 * (lib/contact-guard.ts, 2.8): a settings document replaced by a newer copy
 * that drops or swaps a pin is met as a change, never taken as first use.
 */

/* A served identity, with the keys statement first-seen pins are written over. */
type Served = ServedIdentity;

/*
 * The guard's store, and how the browser is asked to keep it. Tests hand in
 * their own (setContactGuard); the app opens IndexedDB on first use, sealed by
 * this account's worker under a key from the settings key (lib/contact-guard.ts).
 */
type Guard = { store: ContactGuardStore; persist: () => Promise<boolean> };
let guard: Guard | undefined;
export const guardSealer: GuardSealer = {
    ready: (userId) => settingsKeyFor(userId),
    ids: async (userId, contactIds) =>
        (await authClient.rpc('contactGuardIds', { userId, contactIds })).ids,
    seal: async (userId, rows) => (await authClient.rpc('contactGuardSeal', { userId, rows })).rows,
    open: async (userId, kind, rows) =>
        (await authClient.rpc('contactGuardOpen', { userId, kind, rows })).rows,
};
let appStore: ReturnType<typeof createIndexedDbContactGuard> | undefined;
function contactGuard(): Guard {
    guard ??= {
        store: (appStore = createIndexedDbContactGuard(guardSealer)),
        persist: askPersistentStorage,
    };
    return guard;
}
export function setContactGuard(next: Guard | undefined) {
    guard = next;
    guardMoved(null);
}

/*
 * The family guard on this browser (2.8, "per family"): sealed as the contact
 * guard is, in a database of its own, and deleted on sign-out.
 * lib/groups/client.ts reads and merges it per family.
 */
let familyStore: FamilyGuardStore | undefined;
export function familyGuardStore(): FamilyGuardStore {
    familyStore ??= createIndexedDbFamilyGuard(guardSealer);
    return familyStore;
}

/*
 * The settings key in the worker, for the guard sealed under it: the one
 * opened since this unlock, else the one the server keeps. Never created
 * here: a guard with rows always has a key behind it, and an act that writes
 * the first row saves the settings (which creates one) before it.
 */
async function settingsKeyFor(userId: string) {
    requireUnlocked(userId);
    if (settingsKeyOpened?.userId === userId) return settingsKeyOpened.promise;
    const { settingsKey } = await authClient.settings();
    await settingsKeyReady(userId, settingsKey, false);
    if (settingsKeyOpened?.userId !== userId) throw new Error('Open your settings first.');
}
/* The same, made and stored when the account has none yet: before an act's first guard write. */
async function settingsKeyMade(userId: string) {
    requireUnlocked(userId);
    if (settingsKeyOpened?.userId === userId) return settingsKeyOpened.promise;
    const { settingsKey } = await authClient.settings();
    await settingsKeyReady(userId, settingsKey, true);
}

/*
 * Every guard write, in this tab or another of this browser: verdicts and
 * standings built over older entries are built again. Another tab's write
 * (a Continue, a check, an add) arrives on a BroadcastChannel, with its
 * settings save: both are read again here, and a change this tab noted for
 * that person is cleared, so the next act finds where it stands afresh.
 */
let guardWrites = 0;
const GUARD_CHANNEL = 'hushos-contact-guard';
/*
 * What else is judged over the guard and must be judged again when another
 * tab moves it: the catalogue's verdicts behind Home, search and tags
 * (lib/drive.ts registers its recheck here, as afterTrustChanged runs it).
 */
const movedElsewhere = new Set<() => void>();
export function onGuardMovedElsewhere(listener: () => void) {
    movedElsewhere.add(listener);
    return () => void movedElsewhere.delete(listener);
}
const guardChannel =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(GUARD_CHANNEL);
guardChannel?.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { userId?: unknown; contactId?: unknown } | null;
    guardWrites++;
    if (typeof data?.userId !== 'string') return;
    if (typeof data.contactId === 'string') clearChange(data.userId, data.contactId);
    void boundQueryClient?.invalidateQueries({ queryKey: contactKeys.settings(data.userId) });
    void boundQueryClient?.invalidateQueries({ queryKey: ['contacts', 'standing'] });
    void boundQueryClient?.invalidateQueries({ queryKey: ['contacts', 'sharee'] });
    // What Drive drew was judged over the guard as it was (lib/integrity.ts afterTrustChanged):
    // every listing, and the catalogue behind Home, search and tags.
    void boundQueryClient?.invalidateQueries({
        predicate: (query) => query.queryKey[0] === 'drive' && query.queryKey[1] !== 'open',
    });
    for (const listener of movedElsewhere) listener();
});
function guardMoved(moved: { userId: string; contactId: string } | null) {
    guardWrites++;
    if (moved) guardChannel?.postMessage(moved);
}
/* The guard's revision as this tab knows it, for queries built over it. */
export function guardRevision() {
    return guardWrites;
}

/* On unlock: a guard written before it was sealed is sealed now and its plaintext deleted. */
function sealOlderGuard(userId: string) {
    if (guard && !appStore) return;
    contactGuard();
    void appStore
        ?.migrate(userId)
        .catch((error: unknown) =>
            console.error('The contacts this device remembers could not be sealed yet.', error),
        );
}

/*
 * Someone whose keys changed with no chain from the keys this device holds:
 * paused until the person continues or checks (2.4). Said calmly wherever it
 * is met, as the same notice (components/drive/account-changed.tsx).
 */
export class AccountChangedError extends Error {
    override name = 'AccountChangedError';
    constructor(
        readonly contactId: string,
        readonly person: string,
    ) {
        super(`${firstNameOf(person)}’s account changed.`);
    }
}
function firstNameOf(name: string) {
    return name.trim().split(/\s+/)[0] || name;
}
export const notUpgradedWords = (name: string) =>
    `${firstNameOf(name)} needs to sign in to HushOS once more before you can share with them.`;

/*
 * The people this tab found changed, so every place that shows them (Contacts,
 * the share sheet, Shared with me) says so until Continue or a check. A
 * session's knowledge only: the settings never carry it, and the next act
 * finds the change again.
 */
export type AccountChange = { contactId: string; name: string; email: string };
const changes = new Map<string, AccountChange>();
const changeListeners = new Set<() => void>();
let changeVersion = 0;
const changeKey = (userId: string, contactId: string) => `${userId}:${contactId.toLowerCase()}`;
function noteChange(userId: string, change: AccountChange) {
    changes.set(changeKey(userId, change.contactId), change);
    changeVersion++;
    for (const listener of changeListeners) listener();
    return change;
}
function clearChange(userId: string, contactId: string) {
    if (!changes.delete(changeKey(userId, contactId))) return;
    changeVersion++;
    for (const listener of changeListeners) listener();
}
export function accountChangeOf(userId: string, contactId: string) {
    return changes.get(changeKey(userId, contactId)) ?? null;
}
/* Re-renders when this tab finds or clears a change; read with accountChangeOf. */
export function useAccountChanges() {
    return useSyncExternalStore(
        (listener) => {
            changeListeners.add(listener);
            return () => changeListeners.delete(listener);
        },
        () => changeVersion,
        () => 0,
    );
}

/* This device's entry for a person; a read that fails is never first use. */
async function readGuard(userId: string, contactId: string) {
    const { store } = contactGuard();
    try {
        return await Promise.all([
            store.entry(userId, contactId),
            store.pending(userId, contactId),
        ]);
    } catch (error) {
        throw new GuardUnreadableError(error);
    }
}

async function commitGuard(
    userId: string,
    contactId: string,
    entry: GuardEntry,
    revision: number,
    keep?: PendingAct | null,
): Promise<GuardEntry> {
    try {
        await contactGuard().store.commit(userId, contactId, entry, revision, keep ?? undefined);
    } catch (error) {
        if (error instanceof GuardRacedError) throw error;
        throw new GuardUnsavedError(error);
    }
    guardMoved({ userId, contactId });
    return entry;
}

/*
 * The guard entry for a person, with an act left pending settled first (2.8),
 * given the settings pin and the stored sequence (`at`) read under the lock:
 * one whose target the settings pin reached, over the entry's current
 * revision, is finished silently. One whose save could still land is kept,
 * and the entry is judged as it is: the settings are still at the sequence
 * its save was sent over (`base`), which the server's compare-and-set needs
 * to land it, so a save whose answer this device stopped waiting for may yet
 * arrive. Any other is dropped: the settings moved past its base without its
 * target, or the entry moved since, and that act was never done. Under the
 * account's lock. `kept` is an act kept that way: whatever this device then
 * remembers for the person in the same turn under the lock (a first entry
 * for a pin that came with the settings, a followed succession) keeps it,
 * moved to the entry's new revision, so the late save still finishes it.
 */
async function guardFor(
    userId: string,
    contactId: string,
    pin: Pin | null,
    at: number,
): Promise<{ entry: GuardEntry | null; kept: PendingAct | null }> {
    const [entry, pending] = await readGuard(userId, contactId);
    if (!pending) return { entry, kept: null };
    const revision = entry?.revision ?? 0;
    if (pending.revision === revision) {
        if (pin !== null && (await keyCommitment(pin)) === pending.target) {
            const next = await nextGuardEntry(entry, pin).catch(() => null);
            if (next)
                return { entry: await commitGuard(userId, contactId, next, revision), kept: null };
        }
        if (pending.base !== undefined && at <= pending.base) return { entry, kept: pending };
    }
    try {
        await contactGuard().store.dropPending(userId, contactId);
    } catch (error) {
        throw new GuardUnsavedError(error);
    }
    return { entry, kept: null };
}

/*
 * Whether the settings pin agrees with this device's guard, by key commitment
 * (never by `fingerprint`, which every first-seen pin holds as ""): first use
 * when this device has no entry, else agrees or changed. A pin missing from
 * the settings while the guard holds the person is a change too.
 */
type Agreement = 'first-use' | 'agrees' | 'changed';
async function agreement(entry: GuardEntry | null, pin: Pin | null): Promise<Agreement> {
    if (entry === null) return 'first-use';
    if (pin === null) return 'changed';
    const trust = await pinTrust(pin);
    if (trust !== 'verified' && trust !== 'seen') return 'changed';
    const [held, keys] = await Promise.all([keyCommitment(entry), keyCommitment(pin)]);
    return held !== null && held === keys ? 'agrees' : 'changed';
}

/* The key commitment of a served identity, or null for one that cannot be pinned. */
async function servedCommitment(served: Served) {
    if (!served.mlDsaPublicKey || !served.kemPublicKey) return null;
    try {
        return await keyCommitment(
            await pinOfServed({
                ...served,
                mlDsaPublicKey: served.mlDsaPublicKey,
                kemPublicKey: served.kemPublicKey,
            }),
        );
    } catch {
        return null;
    }
}

/*
 * A guard entry for keys this device acts on with nothing in the settings to
 * change: a pin met here for the first time, or one now seen verified.
 */
async function rememberKeys(
    userId: string,
    contactId: string,
    entry: GuardEntry | null,
    pin: Pin,
    keep?: PendingAct | null,
): Promise<GuardEntry> {
    void contactGuard().persist();
    return commitGuard(
        userId,
        contactId,
        await nextGuardEntry(entry, pin),
        entry?.revision ?? 0,
        keep,
    );
}

/*
 * The settings pins and this device's guard entries as one view, both read
 * under the account's lock, for the readers that judge from them (who wrote
 * what, and Verified on Contacts). Nothing is judged from a pin read before
 * the lock: a contact removed or moved on another device meanwhile is judged
 * as the settings are now. Under the lock, every act left pending (by an
 * interrupted Continue, add or check, in any tab) is settled as `stand`
 * settles it (guardFor, 2.8): finished when the settings pin is exactly its
 * target over the entry's revision, else dropped. And a pin that came with
 * the settings with nothing for it in the guard yet (a new device, a browser
 * signed back into) is written to the guard before it is used, so a later
 * change made on another device is met here as a change, never as first
 * use. A guard that cannot be read or written fails the caller, so nothing is
 * judged or shown as theirs.
 */
async function guardedView(userId: string) {
    return withGuardLock(userId, async () => {
        const { settings, version: at } = await loadSettings(userId);
        const { store } = contactGuard();
        const read = async () => {
            try {
                return await Promise.all([store.entries(userId), store.pendingAll(userId)]);
            } catch (error) {
                throw new GuardUnreadableError(error);
            }
        };
        const [held, pending] = await read();
        let entries = held;
        const due = new Set(pending.keys());
        for (const pin of Object.values(settings.contacts)) {
            const id = pin.userId.toLowerCase();
            if (entries.has(id)) continue;
            const trust = await pinTrust(pin);
            if (trust === 'verified' || trust === 'seen') due.add(id);
        }
        if (due.size) {
            for (const contactId of due) {
                const pin = pinOf(settings.contacts, contactId)?.pin ?? null;
                const { entry, kept } = await guardFor(userId, contactId, pin, at);
                if (entry !== null || pin === null) continue;
                const trust = await pinTrust(pin);
                if (trust === 'verified' || trust === 'seen')
                    await rememberKeys(userId, contactId, null, pin, kept);
            }
            [entries] = await read();
        }
        return { contacts: settings.contacts, entries };
    });
}

/*
 * One act that changes whom this device trusts (2.8, "Committing an act"): a
 * pending record naming the exact keys it moves to, the settings saved, then
 * the guard entry at the next revision with the pending record deleted, in
 * one transaction. Only then is the act done; a lost answer, a crash or a
 * failed write between leaves the pending record for the next attempt to
 * settle. `change` must write a pin of `target`'s keys, or the act stops.
 * Under the account's lock.
 */
async function commitTrust(
    queryClient: QueryClient | undefined,
    userId: string,
    contactId: string,
    entry: GuardEntry | null,
    target: Pin,
    change: (
        settings: LoadedSettings['settings'],
    ) => LoadedSettings['settings'] | Promise<LoadedSettings['settings']>,
): Promise<{ pin: Pin; entry: GuardEntry }> {
    const { store, persist } = contactGuard();
    void persist();
    const keys = await keyCommitment(target);
    if (keys === null) throw new Error('These keys can’t be remembered.');
    const revision = entry?.revision ?? 0;
    // The pending record is sealed under the settings key: the account's first act makes one.
    await settingsKeyMade(userId);
    // Written again before every attempt, naming the stored sequence that attempt lands over
    // (`base`, what the server's compare-and-set compares): until the settings move past it,
    // the save may still land, even after this tab gave up waiting for its answer.
    const pending = async (base: number) => {
        try {
            await store.putPending(userId, contactId, {
                target: keys,
                revision,
                at: new Date().toISOString(),
                base,
            });
        } catch (error) {
            throw new GuardUnsavedError(error);
        }
    };
    const saved = await saveSettings(queryClient ?? boundQueryClient, userId, change, pending);
    const pin = pinOf(saved.contacts, contactId)?.pin ?? null;
    if (!pin || (await keyCommitment(pin)) !== keys) throw new TrustMovedError();
    return {
        pin,
        entry: await commitGuard(userId, contactId, await nextGuardEntry(entry, pin), revision),
    };
}

/*
 * A pin from before post-quantum identities, or a malformed one, as a
 * first-seen pin of the served keys (2.5, the crypto core's
 * firstSeenOfLegacy): only when its X25519 and Ed25519 keys are the served
 * ones and the keys statement holds, so the new keys are signed by the very
 * Ed25519 key pinned before. Never verified. Null when the rule does not apply.
 */
async function firstSeenOfLegacy(pin: Pin, served: Served): Promise<Pin | null> {
    const trust = await pinTrust(pin);
    if (trust !== 'legacy' && trust !== 'invalid') return null;
    if (
        pin.encryptionPublicKey !== served.encryptionPublicKey ||
        pin.signingPublicKey !== served.signingPublicKey
    )
        return null;
    if (!(await keysHold(pin.userId, served))) return null;
    try {
        return {
            ...pin,
            ...(await pinOfServed({
                ...served,
                mlDsaPublicKey: served.mlDsaPublicKey!,
                kemPublicKey: served.kemPublicKey!,
            })),
            fingerprint: '',
        };
    } catch {
        return null;
    }
}

/* Whether a succession chain the server serves leads from `from` to the served keys; checked in the worker. */
async function chainHolds(
    contactId: string,
    from: Pick<
        Pin,
        'keyVersion' | 'encryptionPublicKey' | 'signingPublicKey' | 'mlDsaPublicKeyHash'
    >,
    served: Served,
    links?: SuccessionLink[],
) {
    if (!served.mlDsaPublicKey || !served.kemPublicKey || !from.mlDsaPublicKeyHash) return false;
    try {
        // Asked for whole, from the first key version, so the request does not say where the pin is.
        const chain = links ?? (await authClient.contactSuccession(contactId, 1)).links;
        if (!chain.length) return false;
        const { valid } = await authClient.rpc('identityVerifyChain', {
            userId: contactId,
            pinned: {
                keyVersion: from.keyVersion ?? null,
                encryptionPublicKey: from.encryptionPublicKey,
                signingPublicKey: from.signingPublicKey,
                mlDsaPublicKeyHash: from.mlDsaPublicKeyHash,
            },
            served: {
                keyVersion: served.keyVersion,
                encryptionPublicKey: served.encryptionPublicKey,
                signingPublicKey: served.signingPublicKey,
                mlDsaPublicKey: served.mlDsaPublicKey,
                kemPublicKey: served.kemPublicKey,
            },
            links: chain,
        });
        return valid;
    } catch {
        return false;
    }
}
type SuccessionLink = Awaited<ReturnType<typeof authClient.contactSuccession>>['links'][number];

/*
 * Where this device stands with one person, given the keys the server serves
 * for them now (2.3, 2.4, 2.8):
 * - ok: the settings pin agrees with the guard (or this device has none) and
 *   holds the served keys, or follows them along a chain from the guard's
 *   keys (`followed`);
 * - new: nobody pinned: first use, or a contact removed from the settings
 *   whose guard holds the served keys (`removed`: the settings record that
 *   this account removed them, so nothing adds them back on its own);
 * - succession: a signed succession not looked up (a background pass);
 * - changed: anything else, a pin missing from the settings included;
 * - not-upgraded: a pin from before post-quantum identities whose person has
 *   not signed in since, so their new keys cannot be pinned yet.
 * `act` writes what the person's act needs (a first guard entry, a legacy pin
 * made first-seen, a followed succession); `follow` looks a succession up,
 * only ever on the person's act, so the server cannot learn whom this device
 * pins by watching it look people up. Under the account's lock.
 */
type Standing =
    | { kind: 'ok'; pin: Pin; entry: GuardEntry | null; followed: boolean }
    | { kind: 'new'; entry: GuardEntry | null; removed: boolean }
    | { kind: 'succession'; pin: Pin }
    | { kind: 'changed'; pin: Pin | null; entry: GuardEntry | null; wasVerified: boolean }
    | { kind: 'not-upgraded'; pin: Pin };
async function stand(
    userId: string,
    contactId: string,
    served: Served,
    { act, follow }: { act: boolean; follow: boolean },
): Promise<Standing> {
    const loaded = await loadSettings(userId);
    const found = pinOf(loaded.settings.contacts, contactId);
    let pin = found?.pin ?? null;
    let { entry, kept } = await guardFor(userId, contactId, pin, loaded.version);
    let trust = pin ? await pinTrust(pin) : null;
    const changed = async (): Promise<Standing> => ({
        kind: 'changed',
        pin,
        entry,
        // Whether this device had these people checked: the notice then leads with a check.
        wasVerified:
            Boolean(entry?.verified) ||
            (trust === 'verified' && (await agreement(entry, pin)) !== 'changed'),
    });
    if (pin === null) {
        const removed = contactRemoved(loaded.settings, contactId);
        if (entry === null) return { kind: 'new', entry, removed };
        const keys = await servedCommitment(served);
        return keys !== null && keys === (await keyCommitment(entry))
            ? { kind: 'new', entry, removed }
            : changed();
    }
    if (trust === 'legacy' || trust === 'invalid') {
        // A legacy pin over a guard is settings older than this device has acted on.
        if (entry !== null) return changed();
        const upgraded = await firstSeenOfLegacy(pin, served);
        if (!upgraded)
            return pin.encryptionPublicKey === served.encryptionPublicKey &&
                pin.signingPublicKey === served.signingPublicKey
                ? { kind: 'not-upgraded', pin }
                : changed();
        if (!act) return { kind: 'ok', pin: upgraded, entry, followed: false };
        const before = pin;
        // Only over the pin it was worked out from, by every key: another device may have moved
        // first, and a pin of these keys it saved meanwhile (checked, say) is kept as it is.
        ({ pin, entry } = await commitTrust(
            boundQueryClient,
            userId,
            contactId,
            entry,
            upgraded,
            (settings) => withPinIf(settings, upgraded, before),
        ));
        trust = 'seen';
    }
    if ((await agreement(entry, pin)) === 'changed') {
        // The settings moved away from what this device holds: taken only along a chain this
        // device verifies from the guard's keys to the served ones, which must be the pin's.
        if (!follow || entry === null) return changed();
        const keys = await servedCommitment(served);
        if (keys === null || keys !== (await keyCommitment(pin))) return changed();
        if (!(await chainHolds(contactId, entry, served))) return changed();
        if (act) entry = await rememberKeys(userId, contactId, entry, pin, kept);
    }
    const comparison = await comparePin(pin, served);
    if (comparison === 'same') {
        if (act && (entry === null || (trust === 'verified' && !entry.verified)))
            entry = await rememberKeys(userId, contactId, entry, pin, kept);
        return { kind: 'ok', pin, entry, followed: false };
    }
    if (comparison !== 'succession') return changed();
    if (!follow) return { kind: 'succession', pin };
    let links;
    try {
        ({ links } = await authClient.contactSuccession(pin.userId, 1));
    } catch {
        return changed();
    }
    if (!(await chainHolds(contactId, pin, served, links))) return changed();
    const from = pin;
    const next = await pinAfterSuccession(
        from,
        { ...served, mlDsaPublicKey: served.mlDsaPublicKey!, kemPublicKey: served.kemPublicKey! },
        new Date(),
        await keysPassedThrough(from, links),
    );
    if (!act) return { kind: 'ok', pin: next, entry, followed: true };
    const at = new Date();
    const passed = await keysPassedThrough(from, links);
    ({ pin, entry } = await commitTrust(
        boundQueryClient,
        userId,
        contactId,
        entry,
        next,
        async (settings) => {
            const current = pinOf(settings.contacts, contactId)?.pin ?? null;
            // Another device followed it first: its pin is kept as it is, a check included.
            if (current !== null && (await sameKeys(current, next)))
                return withoutRemoval(settings, contactId);
            // Only from the keys the chain was checked from, by every key.
            if (current === null || !(await sameKeys(current, from))) throw new TrustMovedError();
            // What the chain carries over is the source pin's standing as it is now: a check
            // another device made of these keys meanwhile stays a check after the succession.
            return withPinOnce(
                settings,
                await pinAfterSuccession(
                    current,
                    {
                        ...served,
                        mlDsaPublicKey: served.mlDsaPublicKey!,
                        kemPublicKey: served.kemPublicKey!,
                    },
                    at,
                    passed,
                ),
            );
        },
    ));
    return { kind: 'ok', pin, entry, followed: true };
}

/*
 * "Check again" on a mark: looks a pinned contact's served keys up and follows
 * a succession to them when a signed chain holds. Says what came of it: the
 * same keys, followed to new ones, a change with no chain (the notice), a pin
 * whose person has not signed in since post-quantum keys, or nobody pinned.
 */
export async function followServedKeys(
    userId: string,
    signer: { id: string },
): Promise<'same' | 'followed' | 'recheck' | 'changed' | 'not-pinned'> {
    const { settings } = await loadSettings(userId);
    const held = pinOf(settings.contacts, signer.id)?.pin;
    if (!held) return 'not-pinned';
    const { contact } = await authClient.lookupContact(held.email);
    if (contact.userId.toLowerCase() !== held.userId.toLowerCase()) return 'changed';
    const standing = await withGuardLock(userId, () =>
        stand(userId, contact.userId, contact, { act: true, follow: true }),
    );
    switch (standing.kind) {
        case 'ok':
            return standing.followed ? 'followed' : 'same';
        case 'not-upgraded':
            return 'recheck';
        case 'new':
            return 'not-pinned';
        default:
            noteChange(userId, { contactId: held.userId, name: held.name, email: held.email });
            return 'changed';
    }
}

export type Lookup = {
    contact: ContactIdentity;
    /* The version 3 fingerprint over their four keys; null until their identity is upgraded. */
    fingerprint: string | null;
    /* The pin held for this person, after any succession it followed just now. */
    pinned: Pin | null;
    /* The served keys are not the ones this device holds and no signed chain explains it: the notice, never a silent update. */
    changed: boolean;
    /* The pin is not verified (first-seen, or from before post-quantum keys) and nothing changed. */
    stale: boolean;
    /* The pin is verified and agrees with this device: "Verified", and Check again. */
    verified: boolean;
    /* For a change: whether this device had them checked, so the notice leads with a check. */
    wasVerified: boolean;
    /* For a change: the key commitment of the keys this device held, for Technical details. */
    heldFingerprint: string | null;
    /* The pin followed their signed succession to the keys looked up just now. */
    followed: boolean;
    /*
     * Whether their identity is version 2 with a keys statement that holds: the
     * only kind that can be pinned or checked. False for someone who has not
     * signed in since the post-quantum release.
     */
    upgraded: boolean;
};

/* Whether a served identity is version 2 and its keys statement holds; not by itself a reason to trust it. */
async function keysHold(contactUserId: string, served: Served) {
    if (
        served.identityVersion !== 2 ||
        !served.mlDsaPublicKey ||
        !served.kemPublicKey ||
        !served.keysSignature
    )
        return false;
    const { valid } = await authClient.rpc('identityVerifyKeys', {
        userId: contactUserId,
        identity: {
            keyVersion: served.keyVersion,
            encryptionPublicKey: served.encryptionPublicKey,
            signingPublicKey: served.signingPublicKey,
            mlDsaPublicKey: served.mlDsaPublicKey,
            kemPublicKey: served.kemPublicKey,
            keysSignature: served.keysSignature,
        },
    });
    return valid;
}

/*
 * Looks a person up by email and says where this device stands with them:
 * for Check it's Maya, the changed-account notice and letting someone into a
 * family. A followed succession is saved; nobody is added here.
 */
export async function lookupContact(
    _queryClient: QueryClient,
    userId: string,
    email: string,
): Promise<Lookup> {
    const { contact } = await authClient.lookupContact(email);
    const upgraded = await keysHold(contact.userId, contact);
    const print = upgraded
        ? await fingerprintOfKeys(
              publicKeyBytes(contact.encryptionPublicKey),
              publicKeyBytes(contact.signingPublicKey),
              publicKeyBytes(contact.mlDsaPublicKey!),
              publicKeyBytes(contact.kemPublicKey!),
          )
        : null;
    const standing = await withGuardLock(userId, () =>
        stand(userId, contact.userId, contact, { act: true, follow: true }),
    );
    const pinned = standing.kind === 'new' ? null : standing.pin;
    const changed = standing.kind === 'changed';
    if (changed)
        noteChange(userId, { contactId: contact.userId, name: contact.name, email: contact.email });
    else clearChange(userId, contact.userId);
    const verified = pinned !== null && !changed && (await pinTrust(pinned)) === 'verified';
    const held = standing.kind === 'changed' ? (standing.entry ?? standing.pin) : null;
    return {
        contact,
        fingerprint: print,
        pinned,
        changed,
        stale: pinned !== null && !changed && !verified,
        verified,
        wasVerified: standing.kind === 'changed' && standing.wasVerified,
        heldFingerprint: held ? await keyCommitment(held) : null,
        followed: standing.kind === 'ok' && standing.followed,
        upgraded,
    };
}

/*
 * Adding someone (6.2): looked up by email and, when the keys statement holds,
 * remembered at once as a first-seen pin of the keys the server serves now. No
 * words. Someone already added is said so; a change from the keys this device
 * holds for them (a contact removed and added again over other keys included)
 * is the notice instead. `writer`, from a mark: the account that wrote an
 * item, which the address must be.
 */
export type Added =
    | { outcome: 'added' | 'already'; pin: Pin }
    | { outcome: 'changed'; change: AccountChange };
export async function addContact(
    queryClient: QueryClient,
    userId: string,
    email: string,
    writer?: string,
    /* Where they were first met (Technical details only; no rule reads it): `family` when let in. */
    firstSeen: 'added' | 'family' = 'added',
): Promise<Added> {
    const { contact } = await authClient.lookupContact(email);
    if (writer !== undefined && contact.userId.toLowerCase() !== writer.toLowerCase())
        throw new Error('This isn’t the account that wrote it. Check the address, then try again.');
    if (!(await keysHold(contact.userId, contact))) throw new Error(notUpgradedWords(contact.name));
    return withGuardLock(userId, () =>
        decidedAgain(() => addDecided(queryClient, userId, contact, firstSeen)),
    );
}

/*
 * An act decided over what the settings held, run again once when another
 * device moved the person's pin before it saved (TrustMovedError): the second
 * decision meets what that device saved, as a change when the keys differ.
 */
async function decidedAgain<T>(act: () => Promise<T>): Promise<T> {
    try {
        return await act();
    } catch (error) {
        if (!(error instanceof TrustMovedError)) throw error;
        return act();
    }
}

async function addDecided(
    queryClient: QueryClient,
    userId: string,
    contact: ContactIdentity,
    firstSeen: 'added' | 'family' = 'added',
): Promise<Added> {
    const standing = await stand(userId, contact.userId, contact, { act: true, follow: true });
    if (standing.kind === 'ok') return { outcome: 'already', pin: standing.pin };
    if (standing.kind === 'not-upgraded') throw new Error(notUpgradedWords(contact.name));
    if (standing.kind !== 'new')
        return {
            outcome: 'changed',
            change: noteChange(userId, {
                contactId: contact.userId,
                name: standing.pin?.name ?? contact.name,
                email: contact.email,
            }),
        };
    const fresh: Pin = {
        userId: contact.userId,
        email: contact.email,
        name: contact.name,
        ...(await pinOfServed(
            {
                ...contact,
                mlDsaPublicKey: contact.mlDsaPublicKey!,
                kemPublicKey: contact.kemPublicKey!,
            },
            'seen',
        )),
        pinnedAt: new Date().toISOString(),
        firstSeen,
    };
    // Over nobody: a pin another device saved meanwhile is kept, or stops the add.
    const { pin } = await commitTrust(
        queryClient,
        userId,
        contact.userId,
        standing.entry,
        fresh,
        (settings) => withPinIf(settings, fresh, null),
    );
    return { outcome: 'added', pin };
}

/* `pin` for its person, under the served id: a pin stored under the id in other letters goes. */
function withPinOnce(settings: LoadedSettings['settings'], pin: Pin) {
    const next = settingsWithPin(settings, pin);
    for (const key of Object.keys(next.contacts))
        if (key !== pin.userId && key.toLowerCase() === pin.userId.toLowerCase())
            delete next.contacts[key];
    return next;
}

/*
 * Another device moved this person's pin between the read an act was decided
 * over and its save: nothing was written, and the act is decided again from
 * what the settings hold now (for someone new, that is the changed-account
 * notice when the keys differ).
 */
export class TrustMovedError extends Error {
    override name = 'TrustMovedError';
    constructor() {
        super('Your contacts changed on another device. Try again.');
    }
}

/* Whether two pins hold the same keys: by key commitment, or for pins without one, by every key field. */
async function sameKeys(a: Pin | null, b: Pin | null) {
    if (a === null || b === null) return a === b;
    const [left, right] = await Promise.all([keyCommitment(a), keyCommitment(b)]);
    if (left !== null || right !== null) return left === right;
    return (
        a.encryptionPublicKey === b.encryptionPublicKey &&
        a.signingPublicKey === b.signingPublicKey &&
        (a.mlDsaPublicKeyHash ?? null) === (b.mlDsaPublicKeyHash ?? null) &&
        (a.kemPublicKeyHash ?? null) === (b.kemPublicKeyHash ?? null)
    );
}

/*
 * The save of an act that writes `target`, checked again on every attempt of
 * the compare-and-set (another device may have saved since the act was
 * decided): a pin of the target's own keys already there is kept exactly as
 * it is, its verified state included, unless `verify` asks for a verified one
 * over first-seen keys, or for this person's own check over a family's word
 * (`trustedVia` reads verified, but the manager rule and the Verified label
 * want a check of one's own, docs/optional-verification.md 3.4, 3.6, 3.8);
 * the target is written only over the pin the act was
 * decided from (`expected`, null for nobody); anything else stops the act.
 */
/*
 * A pin taken on a family's word (Trust as family, before 3.7) rather than this person's own
 * check; `trustedViaFamily` is only that family's name beside it.
 */
const familysWord = (pin: Pin) => pin.trustedVia !== undefined && pin.trustedVia !== null;

async function withPinIf(
    settings: LoadedSettings['settings'],
    target: Pin,
    expected: Pin | null,
    { verify = false }: { verify?: boolean } = {},
) {
    const current = pinOf(settings.contacts, target.userId)?.pin ?? null;
    if (
        current !== null &&
        (await sameKeys(current, target)) &&
        (!verify || ((await pinTrust(current)) === 'verified' && !familysWord(current)))
    )
        return withoutRemoval(settings, target.userId);
    if (await sameKeys(current, expected)) return withPinOnce(settings, target);
    throw new TrustMovedError();
}

/*
 * The pin a person moves to when they accept keys this device did not follow
 * there (Continue, or They match over new keys): the served keys, the signing
 * keys this device held kept as earlier ones (what they signed reads as theirs
 * with earlier keys), and what was shared with them waiting to be sealed to
 * the new keys. A family's word goes: the pin is this person's own now.
 */
function acceptedPin(
    before: Pin | null,
    base: Pick<Pin, 'signingPublicKey' | 'previousSigningKeys'> | null,
    contact: ContactIdentity,
    keys: Awaited<ReturnType<typeof pinOfServed>>,
): Pin {
    const kept = { ...before } as Partial<Pin>;
    delete kept.trustedVia;
    delete kept.trustedViaFamily;
    delete kept.keysReplacedAt;
    delete kept.replacementSeen;
    const previous: string[] = [];
    for (const key of [...(base?.previousSigningKeys ?? []), base?.signingPublicKey])
        if (key && key !== keys.signingPublicKey && !previous.includes(key)) previous.push(key);
    return {
        ...kept,
        userId: contact.userId,
        email: contact.email,
        name: contact.name,
        ...keys,
        pinnedAt: new Date().toISOString(),
        firstSeen: before?.firstSeen ?? 'added',
        ...(previous.length ? { previousSigningKeys: previous } : {}),
        resealShares: true,
    } as Pin;
}

/*
 * Continue on "Maya's account changed" (6.7): the keys the server serves now,
 * looked up afresh, become a first-seen pin, and what waited runs: what was
 * shared with them is sealed again, to these keys only. A verified pin loses
 * its verified state; Check it's Maya restores it.
 */
export async function continueWith(
    queryClient: QueryClient,
    userId: string,
    change: AccountChange,
): Promise<Pin> {
    const { contact } = await authClient.lookupContact(change.email);
    if (contact.userId.toLowerCase() !== change.contactId.toLowerCase())
        throw new Error('That address now belongs to a different account.');
    if (!(await keysHold(contact.userId, contact))) throw new Error(notUpgradedWords(contact.name));
    const pin = await withGuardLock(userId, async () => {
        const loaded = await loadSettings(userId);
        const found = pinOf(loaded.settings.contacts, contact.userId);
        const before = found?.pin ?? null;
        const { entry } = await guardFor(userId, contact.userId, before, loaded.version);
        // What this device trusted: the settings pin where it agrees, else the guard's keys.
        const base = before && (await agreement(entry, before)) !== 'changed' ? before : entry;
        const keys = await pinOfServed(
            {
                ...contact,
                mlDsaPublicKey: contact.mlDsaPublicKey!,
                kemPublicKey: contact.kemPublicKey!,
            },
            'seen',
        );
        const target = acceptedPin(before, base, contact, keys);
        return (
            await commitTrust(queryClient, userId, contact.userId, entry, target, (settings) =>
                withPinIf(settings, target, before),
            )
        ).pin;
    });
    clearChange(userId, contact.userId);
    return pin;
}

/*
 * They match (6.6): the version 3 pin of the keys whose words were just
 * compared, verified. Over the keys this device held, it stays as it was in
 * every other way; over others, it is a Continue that is also a check. Only
 * for an upgraded identity whose keys statement held (`lookup.upgraded`).
 */
export async function pinContact(queryClient: QueryClient, userId: string, lookup: Lookup) {
    const { contact } = lookup;
    if (!lookup.upgraded || !contact.mlDsaPublicKey || !contact.kemPublicKey)
        throw new Error(
            `${contact.name} needs to sign in to HushOS once more before you can compare words.`,
        );
    const keys = await pinOfServed({
        ...contact,
        mlDsaPublicKey: contact.mlDsaPublicKey,
        kemPublicKey: contact.kemPublicKey,
    });
    const pin = await withGuardLock(userId, async () => {
        const loaded = await loadSettings(userId);
        const found = pinOf(loaded.settings.contacts, contact.userId);
        const before = found?.pin ?? null;
        const { entry } = await guardFor(userId, contact.userId, before, loaded.version);
        const base = before && (await agreement(entry, before)) !== 'changed' ? before : entry;
        const moved =
            base !== null &&
            (base.encryptionPublicKey !== contact.encryptionPublicKey ||
                base.signingPublicKey !== contact.signingPublicKey);
        let target: Pin;
        if (moved) target = { ...acceptedPin(before, base, contact, keys), ...keys };
        else {
            // Fields this version does not know are kept, and so are the keys a followed succession
            // left behind; the pin is the reader's own now, not a family's word.
            const kept = { ...before } as Partial<Pin>;
            delete kept.trustedVia;
            delete kept.trustedViaFamily;
            target = {
                ...kept,
                userId: contact.userId,
                email: contact.email,
                name: contact.name,
                ...keys,
                pinnedAt: new Date().toISOString(),
                ...(before?.keysReplacedAt ? { replacementSeen: before.keysReplacedAt } : {}),
            } as Pin;
        }
        return (
            await commitTrust(queryClient, userId, contact.userId, entry, target, (settings) =>
                withPinIf(settings, target, before, { verify: true }),
            )
        ).pin;
    });
    clearChange(userId, contact.userId);
    return pin;
}

/*
 * This device's guard entry for a person, with an act left pending settled
 * first, for a family check (groupPairMatch takes it): null for none, and a
 * read that fails is never none (GuardUnreadableError).
 */
export async function contactGuardEntry(userId: string, contactId: string) {
    return withGuardLock(userId, async () => {
        const loaded = await loadSettings(userId);
        const pin = pinOf(loaded.settings.contacts, contactId)?.pin ?? null;
        return (await guardFor(userId, contactId, pin, loaded.version)).entry;
    });
}

/*
 * "They match" in a family check (docs/optional-verification.md 3.4): what
 * the worker allowed (groupPairMatch), saved in one settings write, then the
 * guard moved. `check` is the family's check record; `keys` the verified pin
 * keys of the other member, only when the worker found them the very keys
 * their entry names and the ones this device holds for them. With keys, the
 * act commits as every trust-changing act does (2.8: a pending record, the
 * save, the guard), from the guard entry it was decided over; a guard that
 * moved meanwhile stops it before anything is saved. With none, only the
 * check record is saved, and the pin and the guard stay as they were.
 * `familyChecks` and the first-use marker go in that same save (7.2).
 */
export async function saveFamilyCheck(
    queryClient: QueryClient | undefined,
    userId: string,
    input: {
        groupId: string;
        member: { userId: string; email: string; name: string };
        check: { rosterVersion: number; with: string; code: string[]; checkedAt: string };
        keys: Omit<Pin, 'userId' | 'email' | 'name' | 'pinnedAt'> | null;
        /* The guard entry groupPairMatch was given. */
        decidedOver: GuardEntry | null;
    },
): Promise<{ verified: boolean }> {
    const withCheck = (settings: LoadedSettings['settings']) => {
        const marked = withFamilyChecks(settings, input.check.checkedAt);
        return {
            ...marked,
            familyChecks: { ...marked.familyChecks, [input.groupId]: input.check },
        };
    };
    if (!input.keys) {
        await saveSettings(queryClient ?? boundQueryClient, userId, withCheck);
        return { verified: false };
    }
    const keys = input.keys;
    const contactId = input.member.userId;
    await withGuardLock(userId, async () => {
        const loaded = await loadSettings(userId);
        const before = pinOf(loaded.settings.contacts, contactId)?.pin ?? null;
        const { entry } = await guardFor(userId, contactId, before, loaded.version);
        // Decided over this very entry, or not at all: a Continue or a check since is its own act.
        if ((entry?.revision ?? 0) !== (input.decidedOver?.revision ?? 0))
            throw new TrustMovedError();
        const kept = { ...before } as Partial<Pin>;
        delete kept.trustedVia;
        delete kept.trustedViaFamily;
        const target = {
            ...kept,
            userId: contactId,
            email: before?.email ?? input.member.email,
            name: before?.name ?? input.member.name,
            ...keys,
            pinnedAt: new Date().toISOString(),
            firstSeen: before?.firstSeen ?? 'family',
        } as Pin;
        await commitTrust(queryClient, userId, contactId, entry, target, async (settings) =>
            withCheck(await withPinIf(settings, target, before, { verify: true })),
        );
    });
    clearChange(userId, contactId);
    return { verified: true };
}

/*
 * The keys a share to a pinned contact is sealed to: behind the share dialog
 * (`follow`, the person's act, which follows a signed succession), and when
 * the server, not the person, names the grantee, on rotation and when
 * re-sealing older shares. The served keys must be the pinned ones, the pin
 * must agree with this device's guard, and a pin from before post-quantum
 * keys becomes first-seen first. Anything else shares nothing: a change is
 * the notice, and a guard that cannot be read or written stops it.
 */
export async function trustGrantee(
    userId: string,
    granteeUserId: string,
    served: Served,
    { follow = false }: { follow?: boolean } = {},
): Promise<TrustedGrantee> {
    return withGuardLock(userId, async () => {
        const standing = await stand(userId, granteeUserId, served, { act: true, follow });
        if (standing.kind === 'new' || (standing.kind === 'changed' && standing.pin === null))
            throw new Error('This person is not in your contacts. Add them before sharing.');
        if (standing.kind === 'not-upgraded') throw new Error(notUpgradedWords(standing.pin.name));
        if (standing.kind === 'succession')
            throw new Error(
                `${firstNameOf(standing.pin.name)} updated their account. Share with them again to follow it.`,
            );
        if (standing.kind === 'changed') {
            const pin = standing.pin!;
            noteChange(userId, { contactId: pin.userId, name: pin.name, email: pin.email });
            throw new AccountChangedError(pin.userId, pin.name);
        }
        // comparePin said `same` (or the pin followed to them): the served ML-KEM key is the one
        // the version 3 pin's digest names.
        if (!served.kemPublicKey) throw new Error(notUpgradedWords(standing.pin.name));
        return {
            encryptionPublicKey: standing.pin.encryptionPublicKey,
            kemPublicKey: served.kemPublicKey,
        };
    });
}

/* Behind the share dialog: the pinned contact's served identity, checked against the pin. */
export async function granteeKeys(userId: string, pin: Pin) {
    const { contact } = await authClient.lookupContact(pin.email);
    if (contact.userId.toLowerCase() !== pin.userId.toLowerCase())
        throw new Error('That address now belongs to a different account.');
    return {
        userId: pin.userId,
        ...(await trustGrantee(userId, pin.userId, contact, { follow: true })),
    };
}

/*
 * Where each contact stands on this device, from the settings and the guard
 * alone (no lookup): Verified only for a verified pin that agrees with the
 * guard (a check made on another device over the same keys counts); a pin
 * that disagrees with it is an account changed. A guard that cannot be read
 * fails the whole query: nothing is shown as verified then.
 */
export async function contactStandings(userId: string) {
    // Judged only from pins and entries read under the lock, acts left pending settled first.
    const { contacts, entries } = await guardedView(userId);
    const out = new Map<string, { verified: boolean; changed: boolean }>();
    for (const pin of Object.values(contacts)) {
        const held = await agreement(entries.get(pin.userId.toLowerCase()) ?? null, pin);
        const trust = await pinTrust(pin);
        out.set(pin.userId.toLowerCase(), {
            verified: held !== 'changed' && trust === 'verified',
            changed: held === 'changed',
        });
    }
    return out;
}
export const contactStandingsQueryOptions = (userId: string, settingsAt: number) =>
    queryOptions({
        queryKey: ['contacts', 'standing', userId, settingsAt, guardWrites],
        queryFn: () => contactStandings(userId),
        staleTime: Infinity,
        retry: false,
    });

/*
 * Where this device stands with someone the share sheet lists, from the keys
 * the server serves them now: the share sheet is one of the places a change is
 * met (2.4). Nothing is written here; sharing or Review does that.
 */
export async function shareeStanding(userId: string, pin: Pin): Promise<'ok' | 'changed'> {
    const { contact } = await authClient.lookupContact(pin.email);
    if (contact.userId.toLowerCase() !== pin.userId.toLowerCase()) return 'changed';
    const standing = await withGuardLock(userId, () =>
        stand(userId, pin.userId, contact, { act: false, follow: false }),
    );
    if (standing.kind !== 'changed') return 'ok';
    noteChange(userId, { contactId: pin.userId, name: pin.name, email: pin.email });
    return 'changed';
}

/*
 * Removing forgets the pin in the settings and records the removal there
 * (2.8), so no device adds them back on its own when they share something:
 * it waits until the person opens it, which adds them again on purpose.
 * This device's guard keeps what it saw.
 */
export async function removeContact(queryClient: QueryClient, userId: string, contactId: string) {
    const saved = await saveSettings(queryClient, userId, (settings) =>
        settingsWithoutContact(settings, contactId, new Date().toISOString()),
    );
    clearChange(userId, contactId);
    return saved;
}

/* The app's query client, so pins updated behind the share dialog reach the contacts page too. */
let boundQueryClient: QueryClient | undefined;
export function bindContactsToQueries(client: QueryClient) {
    boundQueryClient = client;
}

/* A share whose granter cannot be pinned yet: shown calmly, with why, never as broken. */
export class UnverifiedGranterError extends Error {
    override name = 'UnverifiedGranterError';
}
/*
 * A share that opens only when the person opens it (6.4, 2.3): from someone
 * this device has not pinned, or whose signed succession it has not followed.
 * Listing what was shared never pins anyone or follows anything.
 */
export class GranterWaitingError extends Error {
    override name = 'GranterWaitingError';
}

/*
 * Which keys to open a share with (6.4). From someone pinned, the pinned
 * keys, only when the server serves those same keys or a signed succession
 * from them leads to them, and the pin agrees with this device's guard (a
 * pin that came with the settings, with no guard entry here yet, is
 * remembered in the guard first, or nothing opens). Anything else waits for
 * the person: "Maya's account changed", Review.
 *
 * Listing what was shared opens it: from someone this account has never had
 * as a contact, the keys the share came with are pinned first-seen and it
 * opens. That is first use, and the server could make a share look as if
 * anyone sent it (docs/optional-verification.md 4.1). Two things wait for the
 * person's own open (`explicit`): following a signed succession (2.3), and
 * adding back someone this account removed (the settings record it) or this
 * device has acted on before (its guard holds them, their pin gone), so a
 * removal sticks.
 */
const removedWords = (first: string) =>
    `You removed ${first} from your contacts. Open this to add them again.`;

export async function trustGranter(
    granter: { id: string; name: string; email: string } & Served,
    { explicit = false }: { explicit?: boolean } = {},
): Promise<TrustedGranter> {
    const userId = authClient.store.getState().unlockedUserId;
    if (!userId) throw new Error('Unlock your account first.');
    const first = firstNameOf(granter.name);
    return withGuardLock(userId, () =>
        decidedAgain(async () => {
            // Every open remembers the pin it uses in the guard; only the person's own open follows.
            let standing = await stand(userId, granter.id, granter, {
                act: true,
                follow: explicit,
            });
            if (standing.kind === 'new' && !explicit && (standing.removed || standing.entry))
                throw new GranterWaitingError(
                    standing.removed
                        ? removedWords(first)
                        : `Open this to add ${first} to your contacts.`,
                );
            if (standing.kind === 'succession')
                throw new GranterWaitingError(
                    `${first} updated their account. Open this to carry on.`,
                );
            if (standing.kind === 'new') {
                if (!(await keysHold(granter.id, granter)))
                    throw new UnverifiedGranterError(
                        `${first} needs to sign in to HushOS once more before this opens.`,
                    );
                const fresh: Pin = {
                    userId: granter.id,
                    email: granter.email,
                    name: granter.name,
                    ...(await pinOfServed(
                        {
                            ...granter,
                            mlDsaPublicKey: granter.mlDsaPublicKey!,
                            kemPublicKey: granter.kemPublicKey!,
                        },
                        'seen',
                    )),
                    pinnedAt: new Date().toISOString(),
                    firstSeen: 'shared-with-me',
                };
                try {
                    // Over nobody: a pin another device saved meanwhile is kept, or decided again.
                    // Listing never undoes a removal: one recorded on any attempt of this save
                    // (another device added and removed them meanwhile) stops the add, and the
                    // share waits for the person's Open, the only act that clears it.
                    const { pin, entry } = await commitTrust(
                        boundQueryClient,
                        userId,
                        granter.id,
                        standing.entry,
                        fresh,
                        (settings) => {
                            if (!explicit && contactRemoved(settings, granter.id))
                                throw new GranterWaitingError(removedWords(first));
                            return withPinIf(settings, fresh, null);
                        },
                    );
                    standing = { kind: 'ok', pin, entry, followed: false };
                } catch (error) {
                    if (error instanceof Error && error.message === CONTACTS_FULL)
                        throw new UnverifiedGranterError(CONTACTS_FULL);
                    throw error;
                }
            }
            if (standing.kind === 'not-upgraded')
                throw new UnverifiedGranterError(
                    `${firstNameOf(standing.pin.name)} needs to sign in to HushOS once more before this opens.`,
                );
            if (standing.kind !== 'ok') {
                const name = standing.pin?.name ?? granter.name;
                noteChange(userId, {
                    contactId: granter.id,
                    name,
                    email: standing.pin?.email ?? granter.email,
                });
                throw new AccountChangedError(granter.id, name);
            }
            // Both halves of the share's signature: the pinned Ed25519 key, and the served ML-DSA
            // key whose digest the pin holds.
            const pin = standing.pin;
            const keys = await granterKeysOf(pin, granter);
            if (!keys) {
                noteChange(userId, { contactId: granter.id, name: pin.name, email: pin.email });
                throw new AccountChangedError(granter.id, pin.name);
            }
            return {
                ...keys,
                // Keys the pin followed a succession from open nothing: a share sealed under one waits.
                ...(pin.previousSigningKeys?.length ? { replaced: { name: pin.name } } : {}),
            };
        }),
    );
}

/*
 * Who may have written what Drive lists, beside this account: every contact
 * pinned, verified or first-seen, with the keys their pin followed a
 * succession from, as this device's guard allows (2.8): a settings pin that
 * disagrees with the guard vouches for nothing, and the keys the guard holds
 * stand in for it, never verified. Pins and entries are read under the
 * account's lock, with acts left pending settled and pins the guard holds
 * nothing for written to it first (guardedView). A guard that cannot be read
 * or written fails the set, so every item reads Couldn't check rather than as
 * anyone's. Cached with the
 * settings query and the guard's writes, so a listing does not refetch them.
 */
const signersCache = new WeakMap<object, { writes: number; signers: Promise<DriveSigners> }>();
export async function trustedSigners(userId: string) {
    const loaded = await cachedSettings(userId);
    const held = signersCache.get(loaded.settings);
    if (held && held.writes === guardWrites) return held.signers;
    const signers = (async () => {
        // Judged only from pins and entries read under the lock, acts left pending settled first.
        const { contacts, entries } = await guardedView(userId);
        const effective: Record<string, Pin> = {};
        for (const [key, pin] of Object.entries(contacts)) {
            const entry = entries.get(pin.userId.toLowerCase()) ?? null;
            if ((await agreement(entry, pin)) !== 'changed') effective[key] = pin;
            else if (entry)
                effective[key] = {
                    userId: pin.userId,
                    email: pin.email,
                    name: pin.name,
                    pinnedAt: pin.pinnedAt,
                    keyVersion: entry.keyVersion,
                    encryptionPublicKey: entry.encryptionPublicKey,
                    signingPublicKey: entry.signingPublicKey,
                    mlDsaPublicKeyHash: entry.mlDsaPublicKeyHash,
                    kemPublicKeyHash: entry.kemPublicKeyHash,
                    fingerprint: '',
                    previousSigningKeys: entry.previousSigningKeys,
                };
        }
        return signersFromPins(effective);
    })();
    const record = { writes: guardWrites, signers };
    signersCache.set(loaded.settings, record);
    signers.catch(() => {
        if (signersCache.get(loaded.settings) === record) signersCache.delete(loaded.settings);
    });
    return signers;
}

/* The settings as the query layer holds them, so a listing does not open them again. */
function cachedSettings(userId: string) {
    return boundQueryClient
        ? boundQueryClient.fetchQuery(settingsQueryOptions(userId))
        : loadSettings(userId);
}

/*
 * Whether this person vouched for a family (docs/optional-verification.md
 * 3.4, 7.2: a check record, or a pin from before first use), from the
 * settings as cached: what its folders' verdicts say of members' work (2.6).
 */
export async function familyCheckedOnAccount(userId: string, groupId: string) {
    return familyChecked((await cachedSettings(userId)).settings, groupId);
}

/*
 * This person's pins, as family folder verdicts take them (lib/groups/writers.ts).
 * The same object while the settings do not change, so what is built from it can be
 * kept until they do.
 */
export async function contactPins(userId: string) {
    return (await cachedSettings(userId)).settings.contacts;
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
