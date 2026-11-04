// @vitest-environment node
import 'fake-indexeddb/auto';
import type { GroupPin } from '@hushos/crypto';
import { describe, expect, test } from 'vitest';
import { openDB } from 'idb';
import {
    CONTACT_GUARD_DATABASE,
    createIndexedDbContactGuard,
    createIndexedDbFamilyGuard,
    GuardConflictError,
    type GuardSealer,
} from './contact-guard';
import { account } from './groups/worker-testkit';

/*
 * The family guard as this browser keeps it (docs/optional-verification.md
 * 2.8, "per family"): sealed as the contact guard is, in a database of its
 * own so the contact guard's version stays where open tabs expect it, one row per family
 * found by an id worked out under the settings key, sealed by the account's
 * worker. It only ever moves up, whoever writes last: every write is a merge
 * against what is stored, under the account's lock, so a late write of an
 * older pin changes nothing and one from another history is refused.
 */

const USER = 'a1a1a1a1-0000-4000-8000-000000000001';
const GROUP = 'b2b2b2b2-0000-4000-8000-000000000002';
const AREA = 'c3c3c3c3-0000-4000-8000-000000000003';
const digest = (n: number) => Buffer.alloc(32, n).toString('base64url');

/* A family pin at roster `version` (group key 1), its digests standing for that roster. */
function pinAt(version: number, overrides: Partial<GroupPin> = {}): GroupPin {
    return {
        firstEd25519PublicKey: digest(200),
        firstMlDsaPublicKeyDigest: digest(201),
        checkedAt: '2026-10-16T12:00:00.000Z',
        keyVersion: 1,
        groupKeyDigest: digest(202),
        rosterVersion: version,
        rosterDigest: digest(version),
        areas: {},
        ...overrides,
    };
}

async function browser() {
    const me = await account(USER);
    const device = await me.device();
    const sealer: GuardSealer = {
        ready: async () => {},
        ids: async (userId, contactIds) =>
            (await device.call('contactGuardIds', { userId, contactIds })).ids,
        seal: async (userId, rows) =>
            (await device.call('contactGuardSeal', { userId, rows })).rows,
        open: async (userId, kind, rows) =>
            (await device.call('contactGuardOpen', { userId, kind, rows })).rows,
    };
    const name = `guard-${crypto.randomUUID()}`;
    return {
        me,
        device,
        name,
        tab: () => createIndexedDbFamilyGuard(sealer, name),
        /* The app's own stores, by their own database names. */
        appFamilies: () => createIndexedDbFamilyGuard(sealer),
        appContacts: () => createIndexedDbContactGuard(sealer),
    };
}

describe('the family guard in its store', () => {
    test('leaves the contact guard at version 3: an open tab of the earlier release keeps its connection and can open it again', async () => {
        const b = await browser();
        // The earlier release's tab, with the contact guard open at version 3.
        const versionChanges: number[] = [];
        const older = await openDB(CONTACT_GUARD_DATABASE, 3, {
            upgrade(db) {
                db.createObjectStore('entries', { keyPath: 'key' });
                db.createObjectStore('pending', { keyPath: 'key' });
                db.createObjectStore('sealed-entries', { keyPath: 'key' });
                db.createObjectStore('sealed-pending', { keyPath: 'key' });
                db.createObjectStore('sealed-check', { keyPath: 'key' });
            },
            blocking(_current, next) {
                versionChanges.push(next ?? 0);
            },
        });
        // This release, in another tab: contacts and a family guard, both opened and written.
        expect(await b.appContacts().entries(USER)).toEqual(new Map());
        await b.appFamilies().keepFamily(USER, GROUP, pinAt(2));
        expect(await b.appFamilies().family(USER, GROUP)).toEqual(pinAt(2));
        expect(await b.appContacts().entries(USER)).toEqual(new Map());
        // Nothing asked the older tab to close, and it still reads; reopened, it still opens.
        expect(versionChanges).toEqual([]);
        expect(older.version).toBe(3);
        expect(await older.count('sealed-entries')).toBe(0);
        older.close();
        const again = await openDB(CONTACT_GUARD_DATABASE, 3);
        expect(again.version).toBe(3);
        again.close();
    });

    test('only moves up: an older guard written after a newer one leaves the newer, and another history is refused', async () => {
        const b = await browser();
        const store = b.tab();
        expect(await store.family(USER, GROUP)).toBeNull();
        expect(await store.keepFamily(USER, GROUP, pinAt(3))).toMatchObject({ rosterVersion: 3 });
        // Late, from an acceptance that finished after a later one: nothing changes.
        expect(await store.keepFamily(USER, GROUP, pinAt(2))).toMatchObject({ rosterVersion: 3 });
        expect(await store.family(USER, GROUP)).toEqual(pinAt(3));
        // The same roster with a folder opened since: merged in, never dropped.
        await store.keepFamily(USER, GROUP, pinAt(3, { areas: { [AREA]: 2 } }));
        await store.keepFamily(USER, GROUP, pinAt(3, { areas: { [AREA]: 1 } }));
        expect(await store.family(USER, GROUP)).toEqual(pinAt(3, { areas: { [AREA]: 2 } }));
        // Another member list at a version it holds: two histories, refused, nothing written.
        await expect(
            store.keepFamily(USER, GROUP, pinAt(3, { rosterDigest: digest(99) })),
        ).rejects.toThrow(GuardConflictError);
        await expect(
            store.keepFamily(USER, GROUP, pinAt(4, { firstEd25519PublicKey: digest(203) })),
        ).rejects.toThrow(GuardConflictError);
        expect(await store.family(USER, GROUP)).toEqual(pinAt(3, { areas: { [AREA]: 2 } }));
    });

    test('two tabs writing at once keep the higher one, in either order', async () => {
        for (const order of [
            [2, 5],
            [5, 2],
        ]) {
            const b = await browser();
            const [one, two] = [b.tab(), b.tab()];
            await Promise.all([
                one.keepFamily(USER, GROUP, pinAt(order[0]!)),
                two.keepFamily(USER, GROUP, pinAt(order[1]!)),
            ]);
            expect(await b.tab().family(USER, GROUP), order.join()).toMatchObject({
                rosterVersion: 5,
            });
        }
    });

    test('is sealed: a locked worker reads nothing, and that is never “none”', async () => {
        const b = await browser();
        await b.tab().keepFamily(USER, GROUP, pinAt(2));
        b.device.locked();
        await expect(b.tab().family(USER, GROUP)).rejects.toThrow();
        await b.device.unlock();
        expect(await b.tab().family(USER, GROUP)).toEqual(pinAt(2));
    });
});
