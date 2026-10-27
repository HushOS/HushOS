// @vitest-environment node
import 'fake-indexeddb/auto';
import type { ContactIdentity } from '@hushos/auth/api';
import type { SettingsEnvelope } from '@hushos/crypto';
import { keyCommitment, pinTrust } from '@hushos/crypto/pins';
import { pinOfServed } from '@hushos/drive/trust';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
    createIndexedDbContactGuard,
    GUARD_RACED,
    GUARD_UNREADABLE,
    GUARD_UNSAVED,
    type ContactGuardStore,
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
    continueWith,
    lookupContact,
    pinContact,
    resealPending,
    setContactGuard,
    trustedSigners,
    trustGrantee,
    trustGranter,
} = contacts;

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

    const real = createIndexedDbContactGuard(`hushos-contact-guard-test-${Math.random()}`);
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
    return { device, server, maya, store, real, fail, persist, stored, replace };
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

        // A check over the new keys is a Continue that is also verified.
        await pinContact(query, ME, looked);
        expect(await pinTrust((await w.stored()).contacts[MAYA]!)).toBe('verified');
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
        const keys = await trustGranter(granter(w.maya));
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
        await expect(trustGranter(granter(sam))).rejects.toThrow(GUARD_UNREADABLE);
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
        const [one, two] = [createIndexedDbContactGuard(name), createIndexedDbContactGuard(name)];
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
