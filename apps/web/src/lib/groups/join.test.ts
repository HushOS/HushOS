// @vitest-environment node
import 'fake-indexeddb/auto';
import type { CryptoResults, GroupPin } from '@hushos/crypto';
import { GUARD_NOT_KEPT } from '@hushos/crypto/protocol';
import { digest } from '@hushos/crypto/signatures';
import { describe, expect, test } from 'vitest';
import { createIndexedDbContactGuard, GUARD_UNSAVED, type GuardSealer } from '@/lib/contact-guard';
import { GroupApiError, type GroupsApi } from './api';
import { familyGuardOf, type FamilyGuard, type GroupContext } from './context';
import { joinStatus } from './join';
import { createMemoryGroupStore, type GroupStore } from './store';
import { fetchServed, syncGroup, wipeGroup } from './sync';
import { account, bytes, pinOf } from './worker-testkit';

/*
 * The newcomer's join (join.ts, docs/optional-verification.md 3.2, 3.3) and
 * the family guard it keeps (2.8), against the real crypto worker: Alice
 * creates a family and admits Bob in her own session over a first-seen pin
 * of him, as Let them in does; Bob's side runs only through join.ts and
 * sync.ts, with a server that serves what the roster routes stored, and a
 * family guard sealed in IndexedDB under his settings key, as the app keeps
 * it. Bob waits, is let in, and joins on first use with no words; from then on
 * his guard is a mark that no `not-member` answer clears, written before the
 * device record and never lowered.
 */

const ALICE = 'a1a1a1a1-0000-4000-8000-000000000001';
const BOB = 'b2b2b2b2-0000-4000-8000-000000000002';

/*
 * Alice's family, created and committed in her session; Bob accepted the
 * invitation (route 2 says `accepted`) and is not admitted yet. `admit()`
 * signs his admitting roster over a first-seen pin of him; `land()` stores
 * it; `later()` has Alice sign and land one more roster (a new family folder).
 */
async function invitedFamily() {
    const alice = await account(ALICE);
    const bob = await account(BOB);
    const aliceDevice = await alice.device();
    const created = await aliceDevice.call('groupCreate', {
        userId: ALICE,
        name: 'Lindqvist',
        identities: { identity: alice.identity, history: [] },
    });
    const { groupId } = created;
    const area = created.body.area;
    const rosters: (typeof created.body.roster)[] = [created.body.roster];
    const signerKeys = {
        [await digest(bytes(alice.served.mlDsaPublicKey))]: alice.served.mlDsaPublicKey,
    };
    const served = () => ({
        rosters: [...rosters],
        successions: [],
        firstKeys: created.body.groupKey,
        signerKeys: { ...signerKeys },
    });
    await aliceDevice.call('groupDrop', { outboxId: created.outboxId });
    await aliceDevice.settings.read();
    const first = await aliceDevice.call('groupAccept', {
        userId: ALICE,
        groupId,
        served: served(),
        record: null,
        checkedAt: '2026-10-16T00:00:00.000Z',
        creating: { stagedEnvelope: created.stagedEnvelope },
    });
    if (first.status !== 'accepted') throw new Error('not accepted');
    await aliceDevice.call('groupOpenSeal', {
        groupId,
        seal: {
            groupKeyVersion: 1,
            holderKeyVersion: 1,
            sealerUserId: ALICE,
            rosterVersion: 1,
            rosterDigest: first.view.rosterDigest,
            envelope: created.body.keySeal.envelope,
        },
        sealerMlDsaPublicKey: alice.served.mlDsaPublicKey,
    });
    await aliceDevice.call('groupOpenArea', {
        groupId,
        workspaceId: area.workspaceId,
        idSeed: area.idSeed,
        servedVersion: 1,
        grant: null,
        selfGrant: area.selfGrant,
    });

    let state: 'accepted' | 'active' = 'accepted';
    // The server's answer that Bob is not in the family (404 not-member) on every group route.
    let gone = false;
    const notMember = () => {
        if (gone) throw Object.assign(new GroupApiError('not-member', 404, 'not-member', null));
    };
    // The first keys route 5 serves: another family's (or a server's own) once switched.
    let firstKeys = created.body.groupKey;
    let admitted: CryptoResults['groupStage'] | null = null;
    // A server rolling the member list back: only the first `servedUpTo` rosters served.
    let servedUpTo: number | null = null;
    const signed: CryptoResults['groupStage'][] = [];
    const bobGrant = () => {
        const grant = admitted?.outboxId
            ? admitted.body.grants?.find((at) => at.granteeUserId === BOB)
            : undefined;
        return grant ? { ...grant, granterUserId: ALICE } : null;
    };
    const api = {
        rosters: async (_groupId: string, after: number) => {
            notMember();
            return {
                rosters: (servedUpTo === null ? rosters : rosters.slice(0, servedUpTo))
                    .slice(after)
                    .map((roster, at) => ({ version: after + at + 1, ...roster })),
                successions: [],
                firstKeys,
                signerKeys: { ...signerKeys },
                head: {
                    version: rosters.length,
                    digest: '',
                    revision: rosters.length,
                    groupKeyVersion: 1,
                },
                next: null,
            };
        },
        listGroups: async () => ({ groups: [{ id: groupId, state }] }),
        identities: async () => ({
            identities: [{ userId: ALICE, identity: alice.served, links: [] }],
            next: null,
        }),
        spaces: async () => ({
            spaces: [
                {
                    space: { kind: 'group', groupId, name: 'Lindqvist' },
                    areas: [
                        {
                            workspaceId: area.workspaceId,
                            idSeed: area.idSeed,
                            workspaceKeyVersion: 1,
                            changeSeq: 1,
                            root: {
                                id: area.root.id,
                                parentId: null,
                                parentKeyEpoch: 1,
                                keyEpoch: 1,
                                keyEnvelope: area.root.keyEnvelope,
                                metadataVersion: 1,
                                metadataEnvelope: area.root.metadataEnvelope,
                                prevKeyEnvelope: null,
                                prevKeyEpoch: null,
                                prevParentKeyEpoch: null,
                            },
                            rotation: null,
                            grant: bobGrant(),
                            selfGrant: null,
                        },
                    ],
                },
            ],
        }),
        putSelfGrant: async () => ({ ok: true }),
    } as unknown as GroupsApi;

    /* Bob's browser: one family guard in IndexedDB, under his settings key, for all his tabs. */
    const guardName = `family-guard-${crypto.randomUUID()}`;
    /*
     * Bob's device: the real worker behind join.ts, a fresh session each time (a reload), with
     * the device store it is given and this browser's guard store (wrapped by `guard` when a
     * test stands in for its writes).
     */
    const bobDevice = async (
        store: GroupStore = createMemoryGroupStore(),
        guard?: (inner: FamilyGuard) => FamilyGuard,
    ) => {
        const device = await bob.device();
        const sealer: GuardSealer = {
            ready: async () => {},
            ids: async (userId, contactIds) =>
                (await device.call('contactGuardIds', { userId, contactIds })).ids,
            seal: async (userId, rows) =>
                (await device.call('contactGuardSeal', { userId, rows })).rows,
            open: async (userId, kind, rows) =>
                (await device.call('contactGuardOpen', { userId, kind, rows })).rows,
        };
        const guardStore = createIndexedDbContactGuard(sealer, guardName);
        const inner = familyGuardOf(() => guardStore, BOB);
        let session = 0;
        const ctx: GroupContext = {
            userId: BOB,
            api,
            rpc: device.call as GroupContext['rpc'],
            store,
            settings: device.settings,
            guard: guard ? guard(inner) : inner,
            session: () => session,
            lock: (_groupId, work) => work(),
            sleep: async () => {},
            now: () => new Date('2026-10-16T12:00:00.000Z'),
            identities: async () => ({ identity: bob.identity, history: [] }),
            deleteMirrors: async () => {},
            rotations: null,
        };
        return {
            ctx,
            store,
            device,
            /* What this browser's guard holds for the family, read through the store itself. */
            held: () => guardStore.family(BOB, groupId),
            /* A lock and an unlock: the worker forgets everything, and the session moves on. */
            lock: async () => {
                session++;
                await device.lock();
            },
        };
    };

    /* Alice's committed chain, brought up to what is served. */
    let aliceRecord = first.record;
    const aliceSync = async () => {
        await aliceDevice.settings.read();
        const synced = await aliceDevice.call('groupAccept', {
            userId: ALICE,
            groupId,
            served: served(),
            record: aliceRecord,
            checkedAt: '2026-10-16T00:00:00.000Z',
        });
        if (synced.status !== 'accepted') throw new Error(synced.status);
        aliceRecord = synced.record ?? aliceRecord;
        return synced;
    };

    return {
        groupId,
        area,
        bob,
        alice,
        bobDevice,
        rosters,
        /* Alice signs Bob's admission ("Let them in", before it reaches the server). */
        admit: async (
            roles: ('billing' | 'guardian' | 'members')[] = [],
            { verified = false }: { verified?: boolean } = {},
        ) => {
            // Let them in pins Bob first seen (no words), unless Alice checked him first.
            const pin = await pinOf(bob);
            const { settings, version } = await aliceDevice.settings.read();
            await aliceDevice.settings.write(version, {
                ...settings,
                contacts: {
                    ...settings.contacts,
                    [BOB]: verified ? pin : { ...pin, fingerprint: '', firstSeen: 'family' },
                },
            });
            await aliceDevice.settings.read();
            admitted = await aliceDevice.call('groupStage', {
                groupId,
                expectedRevision: 1,
                op: { kind: 'admit', userId: BOB, served: bob.served, roles },
                kems: { [BOB]: bob.served.kemPublicKey },
            });
            if (admitted.outboxId === null) throw new Error('nothing staged');
            signed.push(admitted);
            return admitted;
        },
        /* "Let them in" landed: the roster is stored and Bob is active. */
        land: async () => {
            if (!admitted?.outboxId) throw new Error('nothing admitted');
            await aliceDevice.call('groupDrop', { outboxId: admitted.outboxId });
            rosters.push(admitted.body.roster);
            state = 'active';
        },
        /* Alice signs one more roster on her committed chain (a new family folder), and it lands. */
        later: async () => {
            await aliceSync();
            const staged = await aliceDevice.call('groupStage', {
                groupId,
                expectedRevision: rosters.length,
                op: { kind: 'area', name: 'Photos' },
                kems: { [BOB]: bob.served.kemPublicKey },
            });
            if (staged.outboxId === null) throw new Error('nothing staged');
            await aliceDevice.call('groupDrop', { outboxId: staged.outboxId });
            rosters.push(staged.body.roster);
            return rosters.length;
        },
        /* Another admission Alice signed at the same version is the one served. */
        serveInstead: (index: number) => {
            admitted = signed[index]!;
            if (admitted.outboxId === null) throw new Error('nothing staged');
            if (rosters.length > 1) rosters[1] = admitted.body.roster;
        },
        /* Route 5 serves other first keys from now on. */
        serveFirstKeys: (keys: typeof firstKeys) => {
            firstKeys = keys;
        },
        firstKeys: created.body.groupKey,
        /* The server says Bob is not in the family (404 not-member), or lets him back. */
        notMember: (on: boolean) => {
            gone = on;
        },
        /* The server serves only the first `n` rosters (a rollback), or all of them again. */
        serveUpTo: (n: number | null) => {
            servedUpTo = n;
        },
    };
}

async function settingsPinOf(ctx: GroupContext, groupId: string) {
    return (await ctx.settings.read()).settings.groups?.[groupId];
}

/* Nothing of the family kept on this device or account: no record, no pin, no joins record. */
async function nothingKept(ctx: GroupContext, store: GroupStore, groupId: string) {
    expect(await store.chain(BOB, groupId)).toBeNull();
    expect(await store.join(BOB, groupId)).toBeNull();
    expect(await settingsPinOf(ctx, groupId)).toBeUndefined();
}

/* A guard store whose writes are watched, failed (`fail` of them) or held until `release`. */
function watched(inner: FamilyGuard, options: { fail?: number; hold?: boolean } = {}) {
    let fail = options.fail ?? 0;
    const kept: GroupPin[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let reached: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
        reached = resolve;
    });
    const guard: FamilyGuard = {
        read: (groupId) => inner.read(groupId),
        keep: async (groupId, pin) => {
            kept.push(structuredClone(pin));
            if (fail > 0) {
                fail--;
                throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
            }
            if (options.hold) {
                reached();
                await held;
            }
            return inner.keep(groupId, pin);
        },
    };
    return { guard, kept, release, waiting, failMore: (n: number) => (fail = n) };
}

describe('joining a family on first use', () => {
    test('waiting, then let in and joined with no words: the guard, then the record, the folder and the pin', async () => {
        const f = await invitedFamily();
        const order: string[] = [];
        const base = createMemoryGroupStore();
        const store: GroupStore = {
            ...base,
            putChain: async (row) => {
                order.push('record');
                return base.putChain(row);
            },
        };
        const bob = await f.bobDevice(store, (inner) => ({
            read: (groupId) => inner.read(groupId),
            keep: async (groupId, pin) => {
                order.push('guard');
                return inner.keep(groupId, pin);
            },
        }));
        expect(await joinStatus(bob.ctx, f.groupId)).toEqual({ status: 'waiting' });
        await f.admit();
        // Signed but not stored yet: still waiting, and nothing kept.
        expect(await joinStatus(bob.ctx, f.groupId)).toEqual({ status: 'waiting' });
        await nothingKept(bob.ctx, store, f.groupId);
        expect(await bob.held()).toBeNull();
        await f.land();
        const joined = await joinStatus(bob.ctx, f.groupId);
        if (joined.status !== 'joined') throw new Error(joined.status);
        expect(joined.sync.view.rosterVersion).toBe(2);
        expect(joined.sync.areas).toMatchObject([
            { workspaceId: f.area.workspaceId, error: null, rootListed: true },
        ]);
        // The guard before the record: a crash between them leaves the guard above, never below.
        expect(order.slice(0, 2)).toEqual(['guard', 'record']);
        expect(await bob.held()).toMatchObject({ rosterVersion: 2 });
        expect((await store.chain(BOB, f.groupId))?.rosterVersion).toBe(2);
        const { settings } = await bob.ctx.settings.read();
        expect(settings.groups?.[f.groupId]).toMatchObject({
            rosterVersion: 2,
            areas: { [f.area.workspaceId]: 1 },
        });
        // A first use: the marker is there, and nothing says this family was checked.
        expect(settings.familyChecksSince).toEqual(expect.any(String));
        expect(settings.familyChecks?.[f.groupId]).toBeUndefined();
        expect(await store.join(BOB, f.groupId)).toBeNull();
        expect(await joinStatus(bob.ctx, f.groupId)).toEqual({ status: 'member' });
    });

    test('a crash between the guard write and the record write: the next run accepts from version 1, and a chain short of the guard is refused', async () => {
        const f = await invitedFamily();
        const store = createMemoryGroupStore();
        await f.admit();
        await f.land();
        // The tab dies right after the guard was stored, before the record.
        const crashing: GroupStore = {
            ...store,
            putChain: async () => {
                throw new Error('tab closed');
            },
        };
        const cut = await f.bobDevice(crashing);
        await expect(joinStatus(cut.ctx, f.groupId)).rejects.toThrow('tab closed');
        expect(await cut.held()).toMatchObject({ rosterVersion: 2 });
        expect(await store.chain(BOB, f.groupId)).toBeNull();
        // The next run: no record, and the guard a mark. It accepts from version 1 again.
        const next = await f.bobDevice(store);
        expect(await joinStatus(next.ctx, f.groupId)).toMatchObject({ status: 'joined' });
        expect((await store.chain(BOB, f.groupId))?.rosterVersion).toBe(2);
        // The family moves on, and the guard with it.
        await f.later();
        expect((await syncGroup(next.ctx, f.groupId)).status).toBe('accepted');
        expect(await next.held()).toMatchObject({ rosterVersion: 3 });
        // A fresh device whose record and settings pin are gone (cleared, or served older):
        // the guard alone refuses the member list rolled back below it.
        const { settings, version } = await next.ctx.settings.read();
        const { [f.groupId]: _dropped, ...groups } = settings.groups ?? {};
        await next.ctx.settings.write(version, { ...settings, groups });
        const bare = createMemoryGroupStore();
        const fresh = await f.bobDevice(bare);
        f.serveUpTo(2);
        await expect(joinStatus(fresh.ctx, f.groupId)).rejects.toThrow(
            /older member list than this device has seen/,
        );
        await nothingKept(fresh.ctx, bare, f.groupId);
        f.serveUpTo(null);
        expect(await joinStatus(fresh.ctx, f.groupId)).toMatchObject({ status: 'joined' });
        expect(await fresh.held()).toMatchObject({ rosterVersion: 3 });
    });

    test('a guard above the record, left by a crash before the record was written, refuses a rollback the record alone would take', async () => {
        const f = await invitedFamily();
        const store = createMemoryGroupStore();
        await f.admit();
        await f.land();
        const bob = await f.bobDevice(store);
        expect(await joinStatus(bob.ctx, f.groupId)).toMatchObject({ status: 'joined' });
        await f.later();
        // The sync takes roster 3: the guard is stored, then the tab dies before the record.
        const crashing = await f.bobDevice({
            ...store,
            putChain: async () => {
                throw new Error('tab closed');
            },
        });
        await expect(syncGroup(crashing.ctx, f.groupId)).rejects.toThrow('tab closed');
        expect(await crashing.held()).toMatchObject({ rosterVersion: 3 });
        expect((await store.chain(BOB, f.groupId))?.rosterVersion).toBe(2);
        expect(await settingsPinOf(crashing.ctx, f.groupId)).toMatchObject({ rosterVersion: 2 });
        // The server rolls the family back to 2, where the record and the settings pin agree:
        // the guard alone says this device took more, and the sync refuses it.
        f.serveUpTo(2);
        const next = await f.bobDevice(store);
        await expect(syncGroup(next.ctx, f.groupId)).rejects.toThrow(
            /older member list than this device has seen/,
        );
        expect((await store.chain(BOB, f.groupId))?.rosterVersion).toBe(2);
        f.serveUpTo(null);
        expect((await syncGroup(next.ctx, f.groupId)).status).toBe('accepted');
        expect((await store.chain(BOB, f.groupId))?.rosterVersion).toBe(3);
    });

    test('a kept first-use joins record finishes only above the guard: a replay at its roster after the family moved on is refused', async () => {
        const f = await invitedFamily();
        await f.admit();
        await f.land();
        // A tab sealed the joins record at roster 2 and closed before committing it.
        const early = await f.bobDevice();
        await early.ctx.settings.read();
        const { served } = await fetchServed(early.ctx, f.groupId, 0);
        const sealed = await early.device.call('groupJoinFirstUse', {
            userId: BOB,
            groupId: f.groupId,
            served,
            record: null,
            guard: null,
            now: '2026-10-16T12:00:00.000Z',
        });
        if (sealed.status !== 'first-use') throw new Error(sealed.status);
        // Another tab joined meanwhile, and took roster 3 too.
        const other = await f.bobDevice();
        expect(await joinStatus(other.ctx, f.groupId)).toMatchObject({ status: 'joined' });
        await f.later();
        expect((await syncGroup(other.ctx, f.groupId)).status).toBe('accepted');
        expect(await other.held()).toMatchObject({ rosterVersion: 3 });
        // The kept record comes back on a device with no record, settings without the family's
        // pin, and the family served as it was at 2: the guard refuses it.
        const { settings, version } = await other.ctx.settings.read();
        const { [f.groupId]: _dropped, ...groups } = settings.groups ?? {};
        await other.ctx.settings.write(version, { ...settings, groups });
        const store = createMemoryGroupStore();
        await store.putJoin({ userId: BOB, groupId: f.groupId, envelope: sealed.joinsRecord });
        f.serveUpTo(2);
        const back = await f.bobDevice(store);
        await expect(joinStatus(back.ctx, f.groupId)).rejects.toThrow(
            /older member list than this device has seen/,
        );
        expect(await store.chain(BOB, f.groupId)).toBeNull();
    });

    test('a failed guard write writes no record, the sync says so, and the next acceptance stores the same guard', async () => {
        const f = await invitedFamily();
        const store = createMemoryGroupStore();
        await f.admit();
        await f.land();
        const bob = await f.bobDevice(store);
        expect(await joinStatus(bob.ctx, f.groupId)).toMatchObject({ status: 'joined' });
        await f.later();
        let guard!: ReturnType<typeof watched>;
        const failing = await f.bobDevice(store, (inner) => {
            guard = watched(inner, { fail: 1 });
            return guard.guard;
        });
        await expect(syncGroup(failing.ctx, f.groupId)).rejects.toThrow(GUARD_UNSAVED);
        // Nothing under that acceptance was written: the record and the pin stay at 2.
        expect((await store.chain(BOB, f.groupId))?.rosterVersion).toBe(2);
        expect(await settingsPinOf(failing.ctx, f.groupId)).toMatchObject({ rosterVersion: 2 });
        expect(await failing.held()).toMatchObject({ rosterVersion: 2 });
        const handed = guard.kept[0]!;
        expect(handed).toMatchObject({ rosterVersion: 3 });
        // The next acceptance hands the same guard back, and it is stored before the record.
        expect((await syncGroup(failing.ctx, f.groupId)).status).toBe('accepted');
        expect(guard.kept[1]).toEqual(handed);
        expect(await failing.held()).toEqual(handed);
        expect((await store.chain(BOB, f.groupId))?.rosterVersion).toBe(3);
    });

    test('a join whose guard, and the guard letting go of it, both failed to store joins on the retry once storage is back, with no reload', async () => {
        const f = await invitedFamily();
        const store = createMemoryGroupStore();
        await f.admit();
        await f.land();
        let guard!: ReturnType<typeof watched>;
        const bob = await f.bobDevice(store, (inner) => {
            guard = watched(inner, { fail: 2 });
            return guard.guard;
        });
        // The acceptance's guard fails, and so does the one the cleanup is handed back.
        await expect(joinStatus(bob.ctx, f.groupId)).rejects.toThrow(GUARD_UNSAVED);
        expect(guard.kept).toHaveLength(2);
        expect(await store.chain(BOB, f.groupId)).toBeNull();
        expect(await store.join(BOB, f.groupId)).not.toBeNull();
        expect(await bob.held()).toBeNull();
        // Storage is back. The retry, in the same session, lets go of the kept chain (storing
        // its guard first), then joins.
        const joined = await joinStatus(bob.ctx, f.groupId);
        expect(joined.status).toBe('joined');
        expect((await store.chain(BOB, f.groupId))?.rosterVersion).toBe(2);
        expect(await bob.held()).toMatchObject({ rosterVersion: 2 });
        expect(await store.join(BOB, f.groupId)).toBeNull();
        expect(await settingsPinOf(bob.ctx, f.groupId)).toMatchObject({ rosterVersion: 2 });
    });

    test('while the guard still can’t be stored, the retry says so and the join waits', async () => {
        const f = await invitedFamily();
        const store = createMemoryGroupStore();
        await f.admit();
        await f.land();
        let guard!: ReturnType<typeof watched>;
        const bob = await f.bobDevice(store, (inner) => {
            guard = watched(inner, { fail: 3 });
            return guard.guard;
        });
        await expect(joinStatus(bob.ctx, f.groupId)).rejects.toThrow(GUARD_UNSAVED);
        // The retry stores nothing and joins nothing: storage is still failing.
        await expect(joinStatus(bob.ctx, f.groupId)).rejects.toThrow(GUARD_UNSAVED);
        expect(await store.chain(BOB, f.groupId)).toBeNull();
        expect(await store.join(BOB, f.groupId)).not.toBeNull();
        // And once it's back, the join goes through.
        expect((await joinStatus(bob.ctx, f.groupId)).status).toBe('joined');
    });

    test('while an accepted chain’s guard isn’t stored, nothing is written under it: no seal, grant or roster, and the floor stays', async () => {
        const f = await invitedFamily();
        const store = createMemoryGroupStore();
        await f.admit();
        await f.land();
        let guard!: ReturnType<typeof watched>;
        const bob = await f.bobDevice(store, (inner) => {
            guard = watched(inner);
            return guard.guard;
        });
        expect(await joinStatus(bob.ctx, f.groupId)).toMatchObject({ status: 'joined' });
        const workspaceId = f.area.workspaceId;
        const seal = () =>
            bob.device.call(
                'driveSealDocument' as never,
                {
                    workspaceId,
                    kind: 'tags',
                    version: 1,
                    document: { version: 2, tags: [], items: {} },
                } as never,
            );
        // Writable while the guard is stored.
        await expect(seal()).resolves.toBeDefined();
        // The family moves on; this background sync commits roster 3, and its guard isn't stored.
        await f.later();
        guard.failMore(1);
        await expect(syncGroup(bob.ctx, f.groupId)).rejects.toThrow(GUARD_UNSAVED);
        expect(await bob.held()).toMatchObject({ rosterVersion: 2 });
        // Nothing is written under the accepted chain meanwhile: a document sealed in a family
        // folder, a grant, a roster.
        await expect(seal()).rejects.toThrow(GUARD_NOT_KEPT);
        await expect(
            bob.ctx.rpc('groupGrants', {
                groupId: f.groupId,
                missing: [
                    { workspaceId, userId: ALICE, kemPublicKey: f.alice.served.kemPublicKey },
                ],
            }),
        ).rejects.toThrow(GUARD_NOT_KEPT);
        await expect(
            bob.ctx.rpc('groupStage', {
                groupId: f.groupId,
                expectedRevision: 3,
                op: { kind: 'area', name: 'Taxes' },
                kems: {},
            }),
        ).rejects.toThrow(GUARD_NOT_KEPT);
        // The chain stays committed: it is still the floor, so a replay below it is refused.
        f.serveUpTo(2);
        await expect(syncGroup(bob.ctx, f.groupId)).rejects.toThrow(/older member list/);
        await expect(seal()).rejects.toThrow(GUARD_NOT_KEPT);
        // Stored on the next acceptance: writes go on.
        f.serveUpTo(null);
        expect((await syncGroup(bob.ctx, f.groupId)).status).toBe('accepted');
        expect(await bob.held()).toMatchObject({ rosterVersion: 3 });
        await expect(seal()).resolves.toBeDefined();
    });

    test('a not-member answer after a failed guard write waits to wipe until the guard is stored, and a replay below the head after the wipe is refused', async () => {
        const f = await invitedFamily();
        const store = createMemoryGroupStore();
        await f.admit();
        await f.land();
        let guard!: ReturnType<typeof watched>;
        const bob = await f.bobDevice(store, (inner) => {
            guard = watched(inner);
            return guard.guard;
        });
        expect(await joinStatus(bob.ctx, f.groupId)).toMatchObject({ status: 'joined' });
        await f.later();
        // Roster 3 accepted in this session, its guard not stored.
        guard.failMore(1);
        await expect(syncGroup(bob.ctx, f.groupId)).rejects.toThrow(GUARD_UNSAVED);
        expect(await bob.held()).toMatchObject({ rosterVersion: 2 });
        // The server says not-member. The wipe stores the session's guard first, and while that
        // fails, nothing of the family goes.
        f.notMember(true);
        guard.failMore(1);
        await expect(syncGroup(bob.ctx, f.groupId)).rejects.toThrow(GUARD_UNSAVED);
        expect(await store.chain(BOB, f.groupId)).not.toBeNull();
        expect(await bob.held()).toMatchObject({ rosterVersion: 2 });
        // Once it is stored, the wipe goes through: the device forgets, the guard stays at 3.
        expect(await syncGroup(bob.ctx, f.groupId)).toEqual({ status: 'wiped' });
        expect(await store.chain(BOB, f.groupId)).toBeNull();
        expect(await bob.held()).toMatchObject({ rosterVersion: 3 });
        // Let back in, the server replays the family as it was at 2, below the head this device
        // took: refused, as a join and as a sync, and nothing is written.
        f.notMember(false);
        f.serveUpTo(2);
        const back = await f.bobDevice(store);
        await expect(joinStatus(back.ctx, f.groupId)).rejects.toThrow(
            /older member list than this device has seen/,
        );
        expect(await store.chain(BOB, f.groupId)).toBeNull();
        f.serveUpTo(null);
        expect(await joinStatus(back.ctx, f.groupId)).toMatchObject({ status: 'joined' });
    });

    test('a not-member answer, then settings without the family and a fresh invitation: first use is refused, since the guard outlives the wipe', async () => {
        const f = await invitedFamily();
        const store = createMemoryGroupStore();
        await f.admit();
        // A second admission Alice signed at the same version: the server's other history.
        await f.admit(['guardian']);
        f.serveInstead(0);
        await f.land();
        const bob = await f.bobDevice(store);
        expect(await joinStatus(bob.ctx, f.groupId)).toMatchObject({ status: 'joined' });
        f.notMember(true);
        expect(await syncGroup(bob.ctx, f.groupId)).toEqual({ status: 'wiped' });
        expect(await store.chain(BOB, f.groupId)).toBeNull();
        // The guard is still there after the wipe.
        const kept = await bob.held();
        expect(kept).toMatchObject({ rosterVersion: 2 });
        // The settings come back without the family's pin (an older copy, or withheld), and the
        // server invites Bob again, onto the other history at the version the guard holds.
        const { settings, version } = await bob.ctx.settings.read();
        const { [f.groupId]: _dropped, ...groups } = settings.groups ?? {};
        await bob.ctx.settings.write(version, { ...settings, groups });
        f.notMember(false);
        f.serveInstead(1);
        const back = await f.bobDevice(store);
        expect(await joinStatus(back.ctx, f.groupId)).toMatchObject({
            status: 'fork',
            fork: { of: 'roster', version: 2 },
        });
        await nothingKept(back.ctx, store, f.groupId);
        expect(await back.held()).toEqual(kept);
    });

    test('a lock before the guard is stored leaves nothing written on that chain', async () => {
        const f = await invitedFamily();
        const store = createMemoryGroupStore();
        await f.admit();
        await f.land();
        let guard!: ReturnType<typeof watched>;
        const bob = await f.bobDevice(store, (inner) => {
            guard = watched(inner, { hold: true });
            return guard.guard;
        });
        const joining = joinStatus(bob.ctx, f.groupId);
        await guard.waiting;
        // The person locks while the guard is being written.
        await bob.lock();
        guard.release();
        await expect(joining).rejects.toThrow(/Unlock your account first/);
        expect(await store.chain(BOB, f.groupId)).toBeNull();
        expect(await settingsPinOf(bob.ctx, f.groupId)).toBeUndefined();
    });

    test('a finish whose pin save failed is completed by the next one, and the joins record goes', async () => {
        const f = await invitedFamily();
        await f.admit();
        await f.land();
        const bob = await f.bobDevice();
        const settings = bob.ctx.settings;
        let failed = false;
        bob.ctx.settings = {
            read: () => settings.read(),
            write: async (version, doc) => {
                if (!failed && doc.groups?.[f.groupId]) {
                    failed = true;
                    throw new Error('offline');
                }
                return settings.write(version, doc);
            },
        };
        await expect(joinStatus(bob.ctx, f.groupId)).rejects.toThrow('offline');
        expect(await bob.store.chain(BOB, f.groupId)).not.toBeNull();
        expect(await bob.store.join(BOB, f.groupId)).not.toBeNull();
        expect(await joinStatus(bob.ctx, f.groupId)).toMatchObject({ status: 'joined' });
        expect(await settingsPinOf(bob.ctx, f.groupId)).toMatchObject({ rosterVersion: 2 });
        expect(await bob.store.join(BOB, f.groupId)).toBeNull();
    });

    test('a joins record that does not open goes, and the join is a first use', async () => {
        const f = await invitedFamily();
        await f.admit();
        await f.land();
        const bob = await f.bobDevice();
        await bob.store.putJoin({ userId: BOB, groupId: f.groupId, envelope: 'AAAA' });
        expect(await joinStatus(bob.ctx, f.groupId)).toMatchObject({ status: 'joined' });
        expect(await bob.store.join(BOB, f.groupId)).toBeNull();
    });

    test('a rejoin after a wipe keeps the pin a mark: made-up first keys are refused, the same history passes', async () => {
        const f = await invitedFamily();
        const store = createMemoryGroupStore();
        await f.admit();
        await f.land();
        const bob = await f.bobDevice(store);
        expect(await joinStatus(bob.ctx, f.groupId)).toMatchObject({ status: 'joined' });
        await wipeGroup(bob.ctx, f.groupId);
        expect(await store.chain(BOB, f.groupId)).toBeNull();
        const back = await f.bobDevice(store);
        const real = f.firstKeys;
        f.serveFirstKeys({ ...real, ed25519PublicKey: 'A'.repeat(43) });
        await expect(joinStatus(back.ctx, f.groupId)).rejects.toThrow(
            /not the group keys this person checked/,
        );
        expect(await store.chain(BOB, f.groupId)).toBeNull();
        f.serveFirstKeys(real);
        expect(await joinStatus(back.ctx, f.groupId)).toMatchObject({ status: 'joined' });
    });
});
