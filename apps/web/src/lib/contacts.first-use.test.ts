// @vitest-environment node
import 'fake-indexeddb/auto';
import type { ContactIdentity } from '@hushos/auth/api';
import type { SettingsEnvelope } from '@hushos/crypto';
import { keyCommitment, pinTrust } from '@hushos/crypto/pins';
import { pinOfServed } from '@hushos/drive/trust';
import { QueryClient } from '@tanstack/react-query';
import { openDB } from 'idb';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
    createIndexedDbContactGuard,
    deleteContactGuard,
    GUARD_RACED,
    GUARD_UNREADABLE,
    GUARD_UNSAVED,
    type ContactGuardStore,
    type GuardSealer,
} from './contact-guard';
import { account } from './groups/worker-testkit';

/*
 * Sharing on first use (docs/optional-verification.md 2, 8 "PR 3"), against a
 * real crypto worker and a server that keeps the settings with its
 * compare-and-set: someone added is shared with at once, sealed to the keys
 * pinned and to nothing else; a change with no signed chain pauses that one
 * person until Continue or a check; and this device's guard (2.8) keeps a
 * replaced settings document, a lost answer, a crash or a failed write from
 * ever turning into a share to keys nobody pinned.
 */

const ME = 'a1a1a1a1-0000-4000-8000-000000000001';
const MAYA = 'a1a1a1a1-0000-4000-8000-000000000002';
const MAYA_EMAIL = 'maya@example.com';

// What this browser keeps (the rollback marks), in memory.
const kept = new Map<string, string>();
vi.stubGlobal('window', {
    localStorage: {
        get length() {
            return kept.size;
        },
        key: (index: number) => [...kept.keys()][index] ?? null,
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, value),
        removeItem: (key: string) => void kept.delete(key),
    },
});

const auth = vi.hoisted(() => ({
    rpc: vi.fn(),
    settings: vi.fn(),
    saveSettings: vi.fn(),
    lookupContact: vi.fn(),
    contactSuccession: vi.fn(),
}));
vi.mock('@/lib/auth-client', () => ({
    authClient: {
        ...auth,
        store: { subscribe: () => () => {}, getState: () => ({ unlockedUserId: ME }) },
    },
}));
vi.mock('@/lib/drive-api', () => ({ onStaleIdentity: () => {} }));
vi.mock('@/lib/own-identity', () => ({
    openOwnIdentity: async () => ({ envelope: { keyVersion: 1 }, keyVersion: 1 }),
}));

const contacts = await import('./contacts');
const {
    AccountChangedError,
    addContact,
    bindContactsToQueries,
    continueWith,
    GranterWaitingError,
    lookupContact,
    pinContact,
    removeContact,
    resealPending,
    setContactGuard,
    trustedSigners,
    trustGrantee,
    trustGranter,
} = contacts;

/* The guard sealed by this account's own worker, as the app seals it (lib/contacts.ts guardSealer). */
type Device = Awaited<ReturnType<Awaited<ReturnType<typeof account>>['device']>>;
const sealerOf = (device: Device): GuardSealer => ({
    ready: async () => {},
    ids: async (userId, contactIds) =>
        (await device.call('contactGuardIds', { userId, contactIds })).ids,
    seal: async (userId, rows) => (await device.call('contactGuardSeal', { userId, rows })).rows,
    open: async (userId, kind, rows) =>
        (await device.call('contactGuardOpen', { userId, kind, rows })).rows,
});

/* Someone's account as the server serves it: a fresh account under one id is "starting over". */
async function person(userId: string, email: string, name: string) {
    const who = await account(userId);
    const served: ContactIdentity = {
        userId,
        email,
        name,
        identityVersion: 2,
        ...who.served,
    };
    return served;
}
const granter = (served: ContactIdentity) => ({ ...served, id: served.userId });

/*
 * This account, its worker, and the server: the settings row with its
 * compare-and-set (a save whose answer is lost still lands), the identities it
 * serves by email, and the guard's store, which a test can make fail.
 */
async function world() {
    kept.clear();
    const me = await account(ME);
    const device = await me.device();
    const server = {
        version: me.stored.version,
        envelope: me.stored.envelope as SettingsEnvelope | null,
        saves: 0,
        loseNextAnswer: false,
        /* Another device's save, landing between this one's read and its save. */
        beforeNextSave: null as null | (() => Promise<void>),
        served: new Map<string, ContactIdentity>(),
    };
    auth.rpc.mockImplementation((operation, input) => device.call(operation, input));
    auth.settings.mockImplementation(async () => ({
        settings: server.envelope,
        settingsKey: me.stored.key,
        settingsVersion: server.version,
    }));
    auth.saveSettings.mockImplementation(
        async (input: { expectedVersion: number; nonce: string; ciphertext: string }) => {
            const between = server.beforeNextSave;
            server.beforeNextSave = null;
            await between?.();
            if (input.expectedVersion !== server.version)
                throw new Error('Your settings changed on another device.');
            server.saves++;
            server.version++;
            server.envelope = {
                version: 2,
                settingsVersion: server.version,
                nonce: input.nonce,
                ciphertext: input.ciphertext,
            };
            if (server.loseNextAnswer) {
                server.loseNextAnswer = false;
                throw new Error('Failed to fetch');
            }
            return { settingsVersion: server.version };
        },
    );
    auth.lookupContact.mockImplementation(async (email: string) => {
        const contact = server.served.get(email);
        if (!contact) throw new Error('No HushOS account uses that email.');
        return { contact };
    });
    // Nobody here replaced their keys with a signed chain: every change below has none.
    auth.contactSuccession.mockResolvedValue({ links: [] });

    const guardName = `hushos-contact-guard-test-${Math.random()}`;
    const real = createIndexedDbContactGuard(sealerOf(device), guardName);
    const fail = { read: false, pending: null as Error | null, commit: null as Error | null };
    const store: ContactGuardStore = {
        ...real,
        entry: (...args) => (fail.read ? Promise.reject(new Error('read')) : real.entry(...args)),
        entries: (...args) =>
            fail.read ? Promise.reject(new Error('read')) : real.entries(...args),
        putPending: (...args) =>
            fail.pending ? Promise.reject(fail.pending) : real.putPending(...args),
        commit: (...args) => (fail.commit ? Promise.reject(fail.commit) : real.commit(...args)),
    };
    const persist = vi.fn(async () => true);
    setContactGuard({ store, persist });

    const maya = await person(MAYA, MAYA_EMAIL, 'Maya Lindqvist');
    server.served.set(MAYA_EMAIL, maya);
    /* The settings as stored now, opened by this account's worker. */
    const stored = async () =>
        (await device.call('settingsOpen', { userId: ME, envelope: server.envelope }))
            .settings as Awaited<ReturnType<typeof contacts.readSettingsForWrite>>['settings'];
    /* A copy of the settings sealed at the next sequence, as a server replaying a fork serves it. */
    const replace = async (settings: Awaited<ReturnType<typeof stored>>) => {
        const { envelope } = await device.call('settingsSeal', {
            userId: ME,
            settingsVersion: server.version + 1,
            settings: settings as never,
        });
        server.version++;
        server.envelope = envelope;
    };
    return { device, server, maya, store, real, fail, persist, stored, replace, guardName };
}

/* Maya starts her account over: new keys under her id, and no chain from the old ones. */
async function startOver(w: Awaited<ReturnType<typeof world>>) {
    const fresh = await person(MAYA, MAYA_EMAIL, 'Maya Lindqvist');
    w.server.served.set(MAYA_EMAIL, fresh);
    return fresh;
}

const query = undefined as never;
const change = { contactId: MAYA, name: 'Maya Lindqvist', email: MAYA_EMAIL };

beforeEach(() => {
    auth.rpc.mockReset();
});

describe('adding someone and sharing with them', () => {
    test('sharing after Add seals to the pinned keys and to nothing else', async () => {
        const w = await world();
        const added = await addContact(query, ME, MAYA_EMAIL);
        expect(added.outcome).toBe('added');
        const pin = (await w.stored()).contacts[MAYA]!;
        // First-seen, never verified: no words were compared.
        expect(await pinTrust(pin)).toBe('seen');
        expect(pin.firstSeen).toBe('added');
        expect(await trustGrantee(ME, MAYA, w.maya)).toEqual({
            encryptionPublicKey: w.maya.encryptionPublicKey,
            kemPublicKey: w.maya.kemPublicKey,
        });
        // The server serving other keys for Maya gets nothing sealed to them.
        const other = await startOver(w);
        await expect(trustGrantee(ME, MAYA, other)).rejects.toBeInstanceOf(AccountChangedError);
        await expect(contacts.granteeKeys(ME, pin)).rejects.toBeInstanceOf(AccountChangedError);
        // Adding again over other keys is the notice, never a second pin.
        expect((await addContact(query, ME, MAYA_EMAIL)).outcome).toBe('changed');
        expect((await w.stored()).contacts[MAYA]!.encryptionPublicKey).toBe(
            w.maya.encryptionPublicKey,
        );
    });

    test('a storage refusal of persistence changes nothing, and a failed guard write stops the add', async () => {
        const w = await world();
        w.persist.mockResolvedValue(false);
        expect((await addContact(query, ME, MAYA_EMAIL)).outcome).toBe('added');
        expect(w.persist).toHaveBeenCalled();
        const again = await world();
        again.persist.mockRejectedValue(new Error('denied'));
        expect((await addContact(query, ME, MAYA_EMAIL)).outcome).toBe('added');
        expect(await trustGrantee(ME, MAYA, again.maya)).toMatchObject({
            encryptionPublicKey: again.maya.encryptionPublicKey,
        });

        // Quota: the act stops before the settings are saved, and says so.
        const full = await world();
        full.fail.pending = new DOMException('full', 'QuotaExceededError');
        await expect(addContact(query, ME, MAYA_EMAIL)).rejects.toThrow(GUARD_UNSAVED);
        expect(full.server.saves).toBe(0);
        await expect(trustGrantee(ME, MAYA, full.maya)).rejects.toThrow(/not in your contacts/);
    });
});

describe('a change with no signed chain', () => {
    test('shares nothing, re-seals nothing and opens nothing new until Continue, which moves to the new keys only', async () => {
        const w = await world();
        await addContact(query, ME, MAYA_EMAIL);
        const before = w.maya;
        const after = await startOver(w);
        // New shares and re-sealing (the same keys behind both), and opening something new.
        await expect(trustGrantee(ME, MAYA, after)).rejects.toBeInstanceOf(AccountChangedError);
        await expect(trustGranter(granter(after))).rejects.toBeInstanceOf(AccountChangedError);
        expect(await resealPending(ME)).toEqual([]);
        expect(contacts.accountChangeOf(ME, MAYA)).not.toBeNull();

        const pin = await continueWith(query, ME, change);
        expect(contacts.accountChangeOf(ME, MAYA)).toBeNull();
        expect(await pinTrust(pin)).toBe('seen');
        // What they signed before reads as theirs with earlier keys.
        expect(pin.previousSigningKeys).toEqual([before.signingPublicKey]);
        // What was shared waits to be sealed again, and only to the keys served now.
        expect(await resealPending(ME)).toEqual([MAYA]);
        expect(await trustGrantee(ME, MAYA, after)).toEqual({
            encryptionPublicKey: after.encryptionPublicKey,
            kemPublicKey: after.kemPublicKey,
        });
        await expect(trustGrantee(ME, MAYA, before)).rejects.toBeInstanceOf(AccountChangedError);
    });

    test('a verified contact’s change needs Continue or a check, and Continue drops the verified state', async () => {
        const w = await world();
        await addContact(query, ME, MAYA_EMAIL);
        await pinContact(query, ME, await lookupContact(query, ME, MAYA_EMAIL));
        expect(await pinTrust((await w.stored()).contacts[MAYA]!)).toBe('verified');
        const after = await startOver(w);
        await expect(trustGrantee(ME, MAYA, after)).rejects.toBeInstanceOf(AccountChangedError);
        const looked = await lookupContact(query, ME, MAYA_EMAIL);
        expect(looked).toMatchObject({ changed: true, wasVerified: true, verified: false });

        // A check over the new keys is a Continue that is also verified, and what was shared
        // with her waits to be sealed to them.
        expect((await pinContact(query, ME, looked)).resealShares).toBe(true);
        expect(await pinTrust((await w.stored()).contacts[MAYA]!)).toBe('verified');
        expect(await resealPending(ME)).toEqual([MAYA]);
        expect(await trustGrantee(ME, MAYA, after)).toMatchObject({
            encryptionPublicKey: after.encryptionPublicKey,
        });

        // And Continue, the other way on, leaves it not verified.
        const third = await startOver(w);
        await continueWith(query, ME, change);
        expect(await pinTrust((await w.stored()).contacts[MAYA]!)).toBe('seen');
        expect((await lookupContact(query, ME, MAYA_EMAIL)).verified).toBe(false);
        expect(await trustGrantee(ME, MAYA, third)).toMatchObject({
            encryptionPublicKey: third.encryptionPublicKey,
        });
    });
});

describe('opening something shared', () => {
    test('from someone new pins the keys it came with, and a share under other keys then pauses', async () => {
        const w = await world();
        const keys = await trustGranter(granter(w.maya), { explicit: true });
        expect(keys.signingPublicKey).toBe(w.maya.signingPublicKey);
        const pin = (await w.stored()).contacts[MAYA]!;
        expect(pin.firstSeen).toBe('shared-with-me');
        expect(await pinTrust(pin)).toBe('seen');
        const other = await startOver(w);
        await expect(trustGranter(granter(other))).rejects.toBeInstanceOf(AccountChangedError);
        // The pin is untouched: the second share's keys were never taken as hers.
        expect((await w.stored()).contacts[MAYA]!.signingPublicKey).toBe(w.maya.signingPublicKey);
        // What she writes reads as hers, first-seen.
        expect((await trustedSigners(ME))[MAYA]).toMatchObject({
            current: w.maya.signingPublicKey,
            seen: true,
        });
    });
});

describe('checking it’s Maya', () => {
    test('They match writes a verified pin over the keys the words were worked out from', async () => {
        const w = await world();
        await addContact(query, ME, MAYA_EMAIL);
        const looked = await lookupContact(query, ME, MAYA_EMAIL);
        expect(looked.verified).toBe(false);
        await pinContact(query, ME, looked);
        const pin = (await w.stored()).contacts[MAYA]!;
        expect(await pinTrust(pin)).toBe('verified');
        expect(pin.fingerprint).toBe(await keyCommitment(pin));
        expect((await lookupContact(query, ME, MAYA_EMAIL)).verified).toBe(true);
    });
});

describe('the guard (2.8)', () => {
    test('a newer settings copy that drops or swaps a pin is a change, never first use', async () => {
        const w = await world();
        await addContact(query, ME, MAYA_EMAIL);
        const held = await w.stored();
        // The server serves a copy without Maya at a higher sequence (an older copy saved over).
        await w.replace({ ...held, contacts: {} });
        const planted = await startOver(w);
        // Opening a share "from Maya" under the server's keys would otherwise pin them first-seen.
        await expect(trustGranter(granter(planted))).rejects.toBeInstanceOf(AccountChangedError);
        expect((await w.stored()).contacts[MAYA]).toBeUndefined();
        // A copy whose pin is someone else's keys, even a verified one, is not used either.
        const verifiedPlant = {
            ...held.contacts[MAYA]!,
            ...(await pinOfServed(
                {
                    ...planted,
                    mlDsaPublicKey: planted.mlDsaPublicKey!,
                    kemPublicKey: planted.kemPublicKey!,
                },
                'verified',
            )),
        };
        expect(await pinTrust(verifiedPlant)).toBe('verified');
        await w.replace({ ...held, contacts: { [MAYA]: verifiedPlant } });
        await expect(trustGrantee(ME, MAYA, planted)).rejects.toBeInstanceOf(AccountChangedError);
        // Over the keys the guard holds, adding her again is silent.
        w.server.served.set(MAYA_EMAIL, w.maya);
        await w.replace({ ...held, contacts: {} });
        expect((await addContact(query, ME, MAYA_EMAIL)).outcome).toBe('added');
    });

    test('a pin that came with the settings is kept in the guard before it opens or judges anything', async () => {
        const w = await world();
        await addContact(query, ME, MAYA_EMAIL);
        // A new device of this account: the settings hold Maya, its guard holds nothing.
        await deleteContactGuard(w.guardName);
        expect(await w.real.entry(ME, MAYA)).toBeNull();
        // Listing what she shared opens it, and the guard keeps the keys it opened under.
        expect((await trustGranter(granter(w.maya))).signingPublicKey).toBe(
            w.maya.signingPublicKey,
        );
        expect((await w.real.entry(ME, MAYA))!.signingPublicKey).toBe(w.maya.signingPublicKey);

        // Another device continues to new keys; here that is the notice, never taken silently.
        const after = await startOver(w);
        await w.replace({
            ...(await w.stored()),
            contacts: {
                [MAYA]: {
                    ...(await w.stored()).contacts[MAYA]!,
                    ...(await pinOfServed(
                        {
                            ...after,
                            mlDsaPublicKey: after.mlDsaPublicKey!,
                            kemPublicKey: after.kemPublicKey!,
                        },
                        'seen',
                    )),
                },
            },
        });
        await expect(trustGranter(granter(after))).rejects.toBeInstanceOf(AccountChangedError);

        // Verdicts the same way: on a new device, what Maya wrote is judged only once the guard
        // keeps her, and a move of her pin elsewhere afterwards judges nothing as hers.
        const again = await world();
        await addContact(query, ME, MAYA_EMAIL);
        await deleteContactGuard(again.guardName);
        expect((await trustedSigners(ME))[MAYA]).toMatchObject({
            current: again.maya.signingPublicKey,
        });
        expect((await again.real.entry(ME, MAYA))!.signingPublicKey).toBe(
            again.maya.signingPublicKey,
        );
        const moved = await startOver(again);
        await again.replace({
            ...(await again.stored()),
            contacts: {
                [MAYA]: {
                    ...(await again.stored()).contacts[MAYA]!,
                    ...(await pinOfServed(
                        {
                            ...moved,
                            mlDsaPublicKey: moved.mlDsaPublicKey!,
                            kemPublicKey: moved.kemPublicKey!,
                        },
                        'seen',
                    )),
                },
            },
        });
        expect((await trustedSigners(ME))[MAYA]).toMatchObject({
            current: again.maya.signingPublicKey,
        });

        // A guard write that fails judges nothing and opens nothing on that pin.
        const full = await world();
        await addContact(query, ME, MAYA_EMAIL);
        await deleteContactGuard(full.guardName);
        full.fail.commit = new DOMException('full', 'QuotaExceededError');
        await expect(trustedSigners(ME)).rejects.toThrow(GUARD_UNSAVED);
        await expect(trustGranter(granter(full.maya))).rejects.toThrow(GUARD_UNSAVED);
    });

    test('a lost settings answer shares nothing on the act, and the next act finishes it silently', async () => {
        const w = await world();
        await addContact(query, ME, MAYA_EMAIL);
        const after = await startOver(w);
        w.server.loseNextAnswer = true;
        await expect(continueWith(query, ME, change)).rejects.toThrow('Failed to fetch');
        // The settings reached the new keys; the guard did not.
        expect((await w.stored()).contacts[MAYA]!.signingPublicKey).toBe(after.signingPublicKey);
        expect((await w.real.entry(ME, MAYA))!.signingPublicKey).toBe(w.maya.signingPublicKey);
        // The pending record names exactly that pin over the guard's revision: finished, no notice.
        expect(await trustGrantee(ME, MAYA, after)).toMatchObject({
            encryptionPublicKey: after.encryptionPublicKey,
        });
        expect((await w.real.entry(ME, MAYA))!.signingPublicKey).toBe(after.signingPublicKey);
        expect(await w.real.pending(ME, MAYA)).toBeNull();
    });

    test('a failed guard write or a crash before it shares nothing; a restart finishes only with the pending record', async () => {
        const w = await world();
        await addContact(query, ME, MAYA_EMAIL);
        const after = await startOver(w);
        w.fail.commit = new DOMException('full', 'QuotaExceededError');
        await expect(continueWith(query, ME, change)).rejects.toThrow(GUARD_UNSAVED);
        // Nothing is shared on its strength while the guard cannot be written.
        await expect(trustGrantee(ME, MAYA, after)).rejects.toThrow(GUARD_UNSAVED);
        // A restart (the write works again) with the pending record: silent.
        w.fail.commit = null;
        expect(await trustGrantee(ME, MAYA, after)).toMatchObject({
            encryptionPublicKey: after.encryptionPublicKey,
        });

        // The same crash with no pending record (it was lost with the tab): the notice.
        const third = await startOver(w);
        w.fail.commit = new Error('the tab closed');
        await expect(continueWith(query, ME, change)).rejects.toThrow(GUARD_UNSAVED);
        w.fail.commit = null;
        await w.real.dropPending(ME, MAYA);
        await expect(trustGrantee(ME, MAYA, third)).rejects.toBeInstanceOf(AccountChangedError);

        // A pending record for keys the settings never reached is dropped, never taken.
        const fourth = await startOver(w);
        const guard = (await w.real.entry(ME, MAYA))!;
        await w.real.putPending(ME, MAYA, {
            target: (await keyCommitment({
                ...guard,
                encryptionPublicKey: fourth.encryptionPublicKey,
            }))!,
            revision: guard.revision,
            at: new Date().toISOString(),
        });
        await expect(trustGrantee(ME, MAYA, third)).rejects.toBeInstanceOf(AccountChangedError);
        expect(await w.real.pending(ME, MAYA)).toBeNull();
    });

    test('an unreadable guard is a pause, never first use', async () => {
        const w = await world();
        await addContact(query, ME, MAYA_EMAIL);
        w.fail.read = true;
        await expect(trustGrantee(ME, MAYA, w.maya)).rejects.toThrow(GUARD_UNREADABLE);
        await expect(trustedSigners(ME)).rejects.toThrow(GUARD_UNREADABLE);
        // Someone new sharing something: nothing is pinned while the guard can't be read.
        const saves = w.server.saves;
        const sam = await person('a1a1a1a1-0000-4000-8000-000000000003', 'sam@example.com', 'Sam');
        await expect(trustGranter(granter(sam), { explicit: true })).rejects.toThrow(
            GUARD_UNREADABLE,
        );
        expect(w.server.saves).toBe(saves);
        w.fail.read = false;
        expect(await trustGrantee(ME, MAYA, w.maya)).toMatchObject({
            encryptionPublicKey: w.maya.encryptionPublicKey,
        });
    });

    test('two tabs acting on one person never leave an older revision over a newer one', async () => {
        const w = await world();
        await addContact(query, ME, MAYA_EMAIL);
        const name = `hushos-contact-guard-tabs-${Math.random()}`;
        const [one, two] = [
            createIndexedDbContactGuard(sealerOf(w.device), name),
            createIndexedDbContactGuard(sealerOf(w.device), name),
        ];
        const first = (await w.real.entry(ME, MAYA))!;
        await one.commit(ME, MAYA, first, 0);
        const read = (await two.entry(ME, MAYA))!;
        // Tab one moves on to revision 2; tab two's write, made from revision 1, is refused.
        await one.commit(ME, MAYA, { ...first, revision: 2, verified: true }, 1);
        await expect(
            two.commit(ME, MAYA, { ...read, revision: 2, signingPublicKey: 'older' }, 1),
        ).rejects.toThrow(GUARD_RACED);
        expect(await two.entry(ME, MAYA)).toMatchObject({ revision: 2, verified: true });
        // Within one tab, acts on one person run one at a time and each lands over the last.
        await startOver(w);
        await Promise.all([
            continueWith(query, ME, change),
            continueWith(query, ME, change),
            lookupContact(query, ME, MAYA_EMAIL),
        ]);
        const guard = (await w.real.entry(ME, MAYA))!;
        expect(guard.revision).toBe(3);
        expect(await keyCommitment(guard)).toBe(
            await keyCommitment((await w.stored()).contacts[MAYA]!),
        );
    });
});

describe('another device saving between the read and the save', () => {
    test('a verified pin of the same keys another device saved is kept, verified', async () => {
        const w = await world();
        const verified = {
            userId: MAYA,
            email: MAYA_EMAIL,
            name: 'Maya Lindqvist',
            pinnedAt: new Date().toISOString(),
            ...(await pinOfServed(
                {
                    ...w.maya,
                    mlDsaPublicKey: w.maya.mlDsaPublicKey!,
                    kemPublicKey: w.maya.kemPublicKey!,
                },
                'verified',
            )),
        };
        // Another device checks Maya's words and saves while this one adds her.
        w.server.beforeNextSave = async () =>
            w.replace({ ...(await w.stored()), contacts: { [MAYA]: verified } });
        expect((await addContact(query, ME, MAYA_EMAIL)).outcome).toBe('added');
        expect(await pinTrust((await w.stored()).contacts[MAYA]!)).toBe('verified');
        expect((await w.real.entry(ME, MAYA))!.verified).toBe(true);
    });

    test('a pin of other keys another device saved stops the add: it is the changed-account notice', async () => {
        const w = await world();
        const other = await person(MAYA, MAYA_EMAIL, 'Maya Lindqvist');
        const theirs = {
            userId: MAYA,
            email: MAYA_EMAIL,
            name: 'Maya Lindqvist',
            pinnedAt: new Date().toISOString(),
            ...(await pinOfServed(
                {
                    ...other,
                    mlDsaPublicKey: other.mlDsaPublicKey!,
                    kemPublicKey: other.kemPublicKey!,
                },
                'seen',
            )),
        };
        w.server.beforeNextSave = async () =>
            w.replace({ ...(await w.stored()), contacts: { [MAYA]: theirs } });
        expect((await addContact(query, ME, MAYA_EMAIL)).outcome).toBe('changed');
        // What the other device saved stays, and nothing is shared to the keys served here.
        expect((await w.stored()).contacts[MAYA]!.signingPublicKey).toBe(other.signingPublicKey);
        await expect(trustGrantee(ME, MAYA, w.maya)).rejects.toBeInstanceOf(AccountChangedError);

        // Opening something from her meets the same: the notice, never a pin over theirs.
        const again = await world();
        again.server.beforeNextSave = async () =>
            again.replace({ ...(await again.stored()), contacts: { [MAYA]: theirs } });
        await expect(trustGranter(granter(again.maya), { explicit: true })).rejects.toBeInstanceOf(
            AccountChangedError,
        );
        expect((await again.stored()).contacts[MAYA]!.signingPublicKey).toBe(
            other.signingPublicKey,
        );
    });
});

describe('a check another device saves while this one rewrites the pin', () => {
    /* Maya's pin over the keys served now, verified, as another device's They match writes it. */
    const verifiedOf = async (served: ContactIdentity, base: object = {}) => ({
        userId: MAYA,
        email: MAYA_EMAIL,
        name: 'Maya Lindqvist',
        pinnedAt: new Date().toISOString(),
        ...base,
        ...(await pinOfServed(
            {
                ...served,
                mlDsaPublicKey: served.mlDsaPublicKey!,
                kemPublicKey: served.kemPublicKey!,
            },
            'verified',
        )),
    });

    test('is kept when a pin from before post-quantum keys becomes first-seen', async () => {
        const w = await world();
        // A pin from before post-quantum identities: the classical keys only.
        const legacy = {
            userId: MAYA,
            email: MAYA_EMAIL,
            name: 'Maya Lindqvist',
            pinnedAt: '2026-01-01T00:00:00.000Z',
            encryptionPublicKey: w.maya.encryptionPublicKey,
            signingPublicKey: w.maya.signingPublicKey,
            fingerprint: 'words-from-before',
        };
        await w.replace({ version: 2, contacts: { [MAYA]: legacy } } as never);
        const checked = await verifiedOf(w.maya);
        w.server.beforeNextSave = async () =>
            w.replace({ ...(await w.stored()), contacts: { [MAYA]: checked } });
        expect(await trustGrantee(ME, MAYA, w.maya)).toMatchObject({
            encryptionPublicKey: w.maya.encryptionPublicKey,
        });
        expect(await pinTrust((await w.stored()).contacts[MAYA]!)).toBe('verified');
        expect((await w.real.entry(ME, MAYA))!.verified).toBe(true);
    });

    test('carries over to the keys a followed succession leads to', async () => {
        const w = await world();
        await addContact(query, ME, MAYA_EMAIL);
        const next = { ...(await startOver(w)), keyVersion: 2 };
        auth.contactSuccession.mockResolvedValue({
            links: [
                {
                    oldEncryptionPublicKey: w.maya.encryptionPublicKey,
                    oldSigningPublicKey: w.maya.signingPublicKey,
                    oldMlDsaPublicKey: w.maya.mlDsaPublicKey!,
                },
            ],
        });
        auth.rpc.mockImplementation(async (operation, input) =>
            operation === 'identityVerifyChain' ? { valid: true } : w.device.call(operation, input),
        );
        // Another device checks Maya's old keys while this one follows her to the new ones.
        const checked = await verifiedOf(w.maya, { firstSeen: 'added' });
        w.server.beforeNextSave = async () =>
            w.replace({ ...(await w.stored()), contacts: { [MAYA]: checked } });
        expect((await trustGranter(granter(next), { explicit: true })).signingPublicKey).toBe(
            next.signingPublicKey,
        );
        const pin = (await w.stored()).contacts[MAYA]!;
        expect(pin.signingPublicKey).toBe(next.signingPublicKey);
        expect(await pinTrust(pin)).toBe('verified');
        expect(pin.previousSigningKeys).toEqual([w.maya.signingPublicKey]);
    });
});

describe('listing what was shared, and opening it', () => {
    test('a share from someone never met opens as it is listed, and pins them first-seen', async () => {
        const w = await world();
        expect((await trustGranter(granter(w.maya))).signingPublicKey).toBe(
            w.maya.signingPublicKey,
        );
        const pin = (await w.stored()).contacts[MAYA]!;
        expect(pin.firstSeen).toBe('shared-with-me');
        expect(await pinTrust(pin)).toBe('seen');
        // Remembered here too, so settings that later drop or swap her are a change.
        expect(await keyCommitment((await w.real.entry(ME, MAYA))!)).toBe(await keyCommitment(pin));
        // A second share under other keys pauses: the first keys stand.
        const other = await startOver(w);
        await expect(trustGranter(granter(other))).rejects.toBeInstanceOf(AccountChangedError);
        expect((await w.stored()).contacts[MAYA]!.signingPublicKey).toBe(w.maya.signingPublicKey);
    });

    test('a removed contact is never added back by listing, on any device, until the person opens it', async () => {
        const w = await world();
        await addContact(query, ME, MAYA_EMAIL);
        await pinContact(query, ME, await lookupContact(query, ME, MAYA_EMAIL));
        await removeContact(query, ME, MAYA);
        expect((await w.stored()).removedContacts).toEqual({ [MAYA]: expect.any(String) });
        const saves = w.server.saves;
        // Listing waits, here (the guard holds her) and on a device that never met her.
        await expect(trustGranter(granter(w.maya))).rejects.toThrow(
            'You removed Maya from your contacts. Open this to add them again.',
        );
        const fresh = createIndexedDbContactGuard(sealerOf(w.device), `fresh-${Math.random()}`);
        setContactGuard({ store: fresh, persist: async () => true });
        await expect(trustGranter(granter(w.maya))).rejects.toBeInstanceOf(GranterWaitingError);
        expect(w.server.saves).toBe(saves);
        expect((await w.stored()).contacts[MAYA]).toBeUndefined();
        expect(await fresh.entry(ME, MAYA)).toBeNull();

        // Opening it is the person's act: she is a contact again and the removal is forgotten.
        setContactGuard({ store: w.store, persist: w.persist });
        expect((await trustGranter(granter(w.maya), { explicit: true })).signingPublicKey).toBe(
            w.maya.signingPublicKey,
        );
        expect((await w.stored()).contacts[MAYA]).toBeDefined();
        expect((await w.stored()).removedContacts).toBeUndefined();
        // The guard kept that this device saw these keys verified.
        expect((await w.real.entry(ME, MAYA))!.verified).toBe(true);

        // Adding her back from Contacts forgets a removal too.
        await removeContact(query, ME, MAYA);
        expect((await addContact(query, ME, MAYA_EMAIL)).outcome).toBe('added');
        expect((await w.stored()).removedContacts).toBeUndefined();
        expect((await trustGranter(granter(w.maya))).signingPublicKey).toBe(
            w.maya.signingPublicKey,
        );
    });

    test('a pin gone from the settings with no removal recorded waits too where the guard holds them', async () => {
        const w = await world();
        await addContact(query, ME, MAYA_EMAIL);
        // An older app removed her (it records no removal), or a copy of the settings dropped her.
        await w.replace({ ...(await w.stored()), contacts: {} });
        const saves = w.server.saves;
        await expect(trustGranter(granter(w.maya))).rejects.toThrow(
            'Open this to add Maya to your contacts.',
        );
        expect(w.server.saves).toBe(saves);
    });
});

describe('a signed succession', () => {
    test('is followed only when the person opens something, never while listing', async () => {
        const w = await world();
        await addContact(query, ME, MAYA_EMAIL);
        // Maya replaces her keys with a chain signed by the ones pinned here.
        const next = { ...(await startOver(w)), keyVersion: 2 };
        const link = {
            oldEncryptionPublicKey: w.maya.encryptionPublicKey,
            oldSigningPublicKey: w.maya.signingPublicKey,
            oldMlDsaPublicKey: w.maya.mlDsaPublicKey!,
        };
        auth.contactSuccession.mockResolvedValue({ links: [link] });
        auth.rpc.mockImplementation(async (operation, input) =>
            operation === 'identityVerifyChain' ? { valid: true } : w.device.call(operation, input),
        );
        const saves = w.server.saves;
        await expect(trustGranter(granter(next))).rejects.toBeInstanceOf(GranterWaitingError);
        expect(w.server.saves).toBe(saves);
        expect((await w.stored()).contacts[MAYA]!.signingPublicKey).toBe(w.maya.signingPublicKey);
        // Opening it is the person's act: the pin follows, and it opens under the new keys.
        expect((await trustGranter(granter(next), { explicit: true })).signingPublicKey).toBe(
            next.signingPublicKey,
        );
        expect((await w.stored()).contacts[MAYA]!.signingPublicKey).toBe(next.signingPublicKey);
        // What was shared with her waits to be sealed to the new keys, and a check made now
        // still says so, so They match runs that reseal (check-contact.tsx).
        expect(await resealPending(ME)).toEqual([MAYA]);
        w.server.served.set(MAYA_EMAIL, next);
        // Her keys statement is over key version 1 in this fixture; the chain is what is tested.
        auth.rpc.mockImplementation(async (operation, input) =>
            operation === 'identityVerifyChain' || operation === 'identityVerifyKeys'
                ? { valid: true }
                : w.device.call(operation, input),
        );
        const looked = await lookupContact(query, ME, MAYA_EMAIL);
        expect(looked).toMatchObject({ changed: false });
        expect((await pinContact(query, ME, looked)).resealShares).toBe(true);
    });
});

describe('another tab of this browser', () => {
    test('a Continue made in another tab rebuilds who wrote what here, the catalogue included', async () => {
        const w = await world();
        const client = new QueryClient();
        bindContactsToQueries(client);
        try {
            await addContact(query, ME, MAYA_EMAIL);
            expect((await trustedSigners(ME))[MAYA]).toMatchObject({
                current: w.maya.signingPublicKey,
            });
            // The other tab: Maya started over, it continued, saving the settings and the guard.
            const after = await startOver(w);
            const moved = {
                ...(await w.stored()).contacts[MAYA]!,
                ...(await pinOfServed(
                    {
                        ...after,
                        mlDsaPublicKey: after.mlDsaPublicKey!,
                        kemPublicKey: after.kemPublicKey!,
                    },
                    'seen',
                )),
            };
            await w.replace({ ...(await w.stored()), contacts: { [MAYA]: moved } });
            const held = (await w.real.entry(ME, MAYA))!;
            const other = createIndexedDbContactGuard(sealerOf(w.device), w.guardName);
            await other.commit(
                ME,
                MAYA,
                {
                    ...held,
                    revision: held.revision + 1,
                    encryptionPublicKey: moved.encryptionPublicKey,
                    signingPublicKey: moved.signingPublicKey,
                    mlDsaPublicKeyHash: moved.mlDsaPublicKeyHash!,
                    kemPublicKeyHash: moved.kemPublicKeyHash!,
                },
                held.revision,
            );
            // The catalogue behind Home, search and tags is judged again too, not only listings.
            const rechecked = vi.fn();
            const stop = contacts.onGuardMovedElsewhere(rechecked);
            const channel = new BroadcastChannel('hushos-contact-guard');
            channel.postMessage({ userId: ME, contactId: MAYA });
            channel.close();
            await vi.waitFor(async () =>
                expect((await trustedSigners(ME))[MAYA]).toMatchObject({
                    current: after.signingPublicKey,
                }),
            );
            await vi.waitFor(() => expect(rechecked).toHaveBeenCalledTimes(1));
            stop();
        } finally {
            bindContactsToQueries(undefined as never);
        }
    });
});

describe('the guard at rest', () => {
    /* The guard's database as it sits on disk, read with no key. */
    const disk = async (name: string) => {
        const db = await openDB(name);
        try {
            return await Promise.all(
                [...db.objectStoreNames].map(async (store) => ({
                    store,
                    rows: await db.getAll(store),
                })),
            );
        } finally {
            db.close();
        }
    };

    test('is sealed: a locked worker reads nothing, and that is never "nothing recorded"', async () => {
        const w = await world();
        await addContact(query, ME, MAYA_EMAIL);
        const written = JSON.stringify(await disk(w.guardName));
        expect(written).not.toContain(w.maya.signingPublicKey);
        expect(written).not.toContain(MAYA);
        w.device.locked();
        await expect(w.real.entry(ME, MAYA)).rejects.toThrow();
        await expect(w.real.entries(ME)).rejects.toThrow();
        await expect(w.real.pending(ME, MAYA)).rejects.toThrow();
        await w.device.unlock();
        expect((await w.real.entry(ME, MAYA))!.signingPublicKey).toBe(w.maya.signingPublicKey);
    });

    test('rows sealed under another settings key are never read as none: everyone pauses', async () => {
        const w = await world();
        await addContact(query, ME, MAYA_EMAIL);
        const held = (await w.real.entry(ME, MAYA))!;
        // The server serves a settings key of its own (a fork, or settings withheld from this
        // device), and a later document under it in which Maya's pin is other keys.
        const { settingsKey } = await w.device.call('settingsKeyCreate', { userId: ME });
        expect(settingsKey).toBeDefined();
        const planted = await startOver(w);
        await w.replace({
            version: 2,
            contacts: {
                [MAYA]: {
                    userId: MAYA,
                    email: MAYA_EMAIL,
                    name: 'Maya Lindqvist',
                    pinnedAt: new Date().toISOString(),
                    ...(await pinOfServed(
                        {
                            ...planted,
                            mlDsaPublicKey: planted.mlDsaPublicKey!,
                            kemPublicKey: planted.kemPublicKey!,
                        },
                        'seen',
                    )),
                },
            },
        } as never);
        // Looked up under the new key, her row would just be missing: that must not read as none.
        await expect(w.real.entry(ME, MAYA)).rejects.toThrow();
        await expect(w.real.pending(ME, MAYA)).rejects.toThrow();
        await expect(trustGrantee(ME, MAYA, planted)).rejects.toThrow(GUARD_UNREADABLE);
        await expect(trustGranter(granter(planted))).rejects.toThrow(GUARD_UNREADABLE);
        // Someone the guard never held pauses too: nothing is first use over a guard it can't read.
        const sam = await person('a1a1a1a1-0000-4000-8000-000000000003', 'sam@example.com', 'Sam');
        await expect(trustGranter(granter(sam))).rejects.toThrow(GUARD_UNREADABLE);
        // And nothing is written beside the old rows under the new key.
        await expect(w.real.commit(ME, MAYA, { ...held, revision: 1 }, 0)).rejects.toThrow();
        await expect(
            w.real.putPending(ME, MAYA, { target: 'x', revision: 1, at: new Date().toISOString() }),
        ).rejects.toThrow();
    });

    test('a guard kept in the clear is sealed on the first unlock and its plaintext deleted', async () => {
        const w = await world();
        await addContact(query, ME, MAYA_EMAIL);
        const entry = (await w.real.entry(ME, MAYA))!;
        // What a version 1 guard left: the same entry, in the clear.
        const name = `hushos-contact-guard-old-${Math.random()}`;
        const old = await openDB(name, 1, {
            upgrade(db) {
                db.createObjectStore('entries', { keyPath: 'key' });
                db.createObjectStore('pending', { keyPath: 'key' });
            },
        });
        await old.put('entries', {
            key: `${ME}:${MAYA}`,
            userId: ME,
            contactId: MAYA,
            value: entry,
        });
        old.close();
        const store = createIndexedDbContactGuard(sealerOf(w.device), name);
        // Locked: nothing is read, nothing is moved, and the plaintext stays until it can be.
        w.device.locked();
        await expect(store.entry(ME, MAYA)).rejects.toThrow();
        await w.device.unlock();
        expect(await store.entry(ME, MAYA)).toEqual(entry);
        const after = await disk(name);
        expect(after.find((each) => each.store === 'entries')!.rows).toEqual([]);
        expect(JSON.stringify(after)).not.toContain(entry.signingPublicKey);
    });

    test('sign-out deletes it; signing back in trusts the settings, as a new device does', async () => {
        const w = await world();
        await addContact(query, ME, MAYA_EMAIL);
        await deleteContactGuard(w.guardName);
        expect((await disk(w.guardName)).every((each) => each.rows.length === 0)).toBe(true);
        expect(await w.real.entry(ME, MAYA)).toBeNull();
        // The pin the settings hold is taken as first use again, and shared with.
        expect(await trustGrantee(ME, MAYA, w.maya)).toMatchObject({
            encryptionPublicKey: w.maya.encryptionPublicKey,
        });
    });
});
