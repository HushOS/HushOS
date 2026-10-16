// @vitest-environment node
import type { CryptoResults } from '@hushos/crypto';
import { digest } from '@hushos/crypto/signatures';
import { describe, expect, test } from 'vitest';
import type { GroupsApi } from './api';
import type { GroupContext } from './context';
import { enterJoinCode, familyWords, finishJoin, joinProgress, wordsMatch } from './join';
import { createMemoryGroupStore, type GroupStore } from './store';
import { syncGroup, wipeGroup } from './sync';
import { account, bytes, pinOf } from './worker-testkit';

/*
 * The newcomer's join (join.ts) against the real crypto worker: Alice
 * creates a family and admits Bob in her own session, as the admin's dialog
 * does; Bob's side runs only through join.ts, with a server that serves what
 * the roster routes stored. Bob compares the words, types the join code,
 * waits, and joins. A code that does not match keeps no mark and can be typed
 * again; this device cannot tell a typo from a server showing another history
 * (both are a code that is not the served roster's), and says so. A device
 * that holds a mark, a record or the settings pin, never joins again, even
 * after a not-member wipe and the family's return.
 */

const ALICE = 'a1a1a1a1-0000-4000-8000-000000000001';
const BOB = 'b2b2b2b2-0000-4000-8000-000000000002';

/*
 * Alice's family, created and committed in her session; Bob accepted the
 * invitation (route 2 says `accepted`) and is not admitted yet. `admit()`
 * signs his admitting roster and returns its join code; `land()` stores it.
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
    // The first keys route 5 serves: another family's (or a server's own) once switched.
    let firstKeys = created.body.groupKey;
    let admitted: CryptoResults['groupStage'] | null = null;
    const signed: CryptoResults['groupStage'][] = [];
    const bobGrant = () => {
        const grant = admitted?.outboxId
            ? admitted.body.grants?.find((at) => at.granteeUserId === BOB)
            : undefined;
        return grant ? { ...grant, granterUserId: ALICE } : null;
    };
    const api = {
        rosters: async (_groupId: string, after: number) => ({
            rosters: rosters
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
        }),
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

    /* Bob's device: the real worker behind join.ts. */
    const bobDevice = async (store: GroupStore = createMemoryGroupStore()) => {
        const device = await bob.device();
        const ctx: GroupContext = {
            userId: BOB,
            api,
            rpc: device.call as GroupContext['rpc'],
            store,
            settings: device.settings,
            lock: (_groupId, work) => work(),
            sleep: async () => {},
            now: () => new Date('2026-10-16T12:00:00.000Z'),
            identities: async () => ({ identity: bob.identity, history: [] }),
            deleteMirrors: async () => {},
            rotations: null,
        };
        return { ctx, store, device };
    };

    return {
        groupId,
        area,
        bob,
        bobDevice,
        familyWordsAsAliceSees: async () =>
            (await aliceDevice.call('groupWords', { groupId, firstKeys: created.body.groupKey }))
                .words,
        /* Alice signs Bob's admission (the admin's dialog, before "Let them in"). */
        admit: async (roles: ('billing' | 'guardian' | 'members')[] = []) => {
            admitted = await aliceDevice.call('groupStage', {
                groupId,
                expectedRevision: 1,
                op: {
                    kind: 'admit',
                    userId: BOB,
                    pin: await pinOf(bob),
                    served: bob.served,
                    roles,
                },
                kems: { [BOB]: bob.served.kemPublicKey },
            });
            if (admitted.outboxId === null) throw new Error('nothing staged');
            signed.push(admitted);
            return admitted.joinCode!;
        },
        /* "Let them in" landed: the roster is stored and Bob is active. */
        land: async () => {
            if (!admitted?.outboxId) throw new Error('nothing admitted');
            await aliceDevice.call('groupDrop', { outboxId: admitted.outboxId });
            rosters.push(admitted.body.roster);
            state = 'active';
        },
        /* Route 5 serves other first keys from now on. */
        serveFirstKeys: (keys: typeof firstKeys) => {
            firstKeys = keys;
        },
        firstKeys: created.body.groupKey,
        /* The server starts serving another admission Alice signed at the same version: a fork. */
        serveInstead: (index: number) => {
            admitted = signed[index]!;
            if (admitted.outboxId === null) throw new Error('nothing staged');
            rosters[1] = admitted.body.roster;
        },
    };
}

async function settingsPinOf(ctx: GroupContext, groupId: string) {
    return (await ctx.settings.read()).settings.groups?.[groupId];
}

describe('joining a family', () => {
    test('words, join code, waiting, then joined: the record, the folder and the pin come only at the end', async () => {
        const f = await invitedFamily();
        const { ctx, store } = await f.bobDevice();
        const words = await familyWords(ctx, f.groupId);
        if (words.status !== 'compare') throw new Error(words.status);
        // Both screens show the same twelve words, over the first keys the server serves.
        expect(words.words).toEqual(await f.familyWordsAsAliceSees());
        expect(words.nextRosterVersion).toBe(2);
        const checked = await wordsMatch(ctx, f.groupId, words.firstKeys);
        expect(checked).toMatchObject({ status: 'checked', view: { rosterVersion: 1 } });
        // Checking the words keeps no mark.
        expect(await store.chain(BOB, f.groupId)).toBeNull();
        expect(await settingsPinOf(ctx, f.groupId)).toBeUndefined();
        const code = await f.admit();
        expect(code.rosterVersion).toBe(words.nextRosterVersion);
        await enterJoinCode(ctx, f.groupId, code);
        expect(await finishJoin(ctx, f.groupId)).toEqual({ status: 'waiting' });
        await f.land();
        const joined = await finishJoin(ctx, f.groupId);
        if (joined.status !== 'joined') throw new Error(joined.status);
        expect(joined.sync.view.rosterVersion).toBe(2);
        expect(joined.sync.areas).toMatchObject([
            { workspaceId: f.area.workspaceId, error: null, rootListed: true },
        ]);
        expect((await store.chain(BOB, f.groupId))?.rosterVersion).toBe(2);
        expect(await settingsPinOf(ctx, f.groupId)).toMatchObject({
            rosterVersion: 2,
            areas: { [f.area.workspaceId]: 1 },
        });
        expect(await store.join(BOB, f.groupId)).toBeNull();
    });

    test('first keys that change after the words check undo it: the record and the code go, and the words are compared again', async () => {
        const f = await invitedFamily();
        const { ctx, store } = await f.bobDevice();
        const { firstKeys } = await familyWords(ctx, f.groupId);
        await wordsMatch(ctx, f.groupId, firstKeys);
        await enterJoinCode(ctx, f.groupId, await f.admit());
        expect(await joinProgress(ctx, f.groupId)).toMatchObject({
            status: 'checked',
            joinMark: { rosterVersion: 2 },
        });
        // Another family's keys (or the server's own) from now on.
        f.serveFirstKeys({ ...f.firstKeys, ed25519PublicKey: 'A'.repeat(43) });
        expect(await joinProgress(ctx, f.groupId)).toEqual({ status: 'keys-changed' });
        expect(await store.join(BOB, f.groupId)).toBeNull();
        expect(await finishJoin(ctx, f.groupId)).toEqual({ status: 'waiting' });
        expect(await joinProgress(ctx, f.groupId)).toEqual({ status: 'none' });
    });

    test('a words check that does not verify keeps no record, so a reload asks for the words again', async () => {
        const f = await invitedFamily();
        const { ctx, store } = await f.bobDevice();
        // The person compared words over keys that sign none of the served member lists.
        const other = { ...f.firstKeys, ed25519PublicKey: 'A'.repeat(43) };
        f.serveFirstKeys(other);
        await expect(wordsMatch(ctx, f.groupId, other)).rejects.toThrow();
        expect(await store.join(BOB, f.groupId)).toBeNull();
        expect(await joinProgress(ctx, f.groupId)).toEqual({ status: 'none' });
        await expect(
            enterJoinCode(ctx, f.groupId, { rosterVersion: 2, code: Array(12).fill('abandon') }),
        ).rejects.toThrow(/Compare the family’s words first/);
    });

    test('a mistyped join code keeps no mark, and can be typed again', async () => {
        const f = await invitedFamily();
        const { ctx, store } = await f.bobDevice();
        const { firstKeys } = await familyWords(ctx, f.groupId);
        await wordsMatch(ctx, f.groupId, firstKeys);
        const code = await f.admit();
        const typo = {
            ...code,
            code: [code.code[0] === 'abandon' ? 'ability' : 'abandon', ...code.code.slice(1)],
        };
        await enterJoinCode(ctx, f.groupId, typo);
        await f.land();
        expect(await finishJoin(ctx, f.groupId)).toMatchObject({ status: 'code-mismatch' });
        expect(await store.chain(BOB, f.groupId)).toBeNull();
        expect(await settingsPinOf(ctx, f.groupId)).toBeUndefined();
        // Read out again and typed right, in the same session: joined.
        await enterJoinCode(ctx, f.groupId, code);
        expect(await finishJoin(ctx, f.groupId)).toMatchObject({ status: 'joined' });
    });

    test('a device that already holds the family’s mark never joins it again, after a reload too', async () => {
        const f = await invitedFamily();
        const store = createMemoryGroupStore();
        const { ctx } = await f.bobDevice(store);
        const { firstKeys } = await familyWords(ctx, f.groupId);
        await wordsMatch(ctx, f.groupId, firstKeys);
        await enterJoinCode(ctx, f.groupId, await f.admit());
        await f.land();
        expect(await finishJoin(ctx, f.groupId)).toMatchObject({ status: 'joined' });
        // Same session: the committed chain is a mark.
        await expect(wordsMatch(ctx, f.groupId, firstKeys)).resolves.toMatchObject({
            status: 'already-checked',
        });
        // A fresh worker on this device: the stored record and the settings pin are marks.
        const reloaded = await f.bobDevice(store);
        await expect(wordsMatch(reloaded.ctx, f.groupId, firstKeys)).resolves.toMatchObject({
            status: 'already-checked',
        });
        // Another device of the account, with nothing stored: the settings pin is a mark.
        const other = await f.bobDevice();
        await expect(wordsMatch(other.ctx, f.groupId, firstKeys)).resolves.toMatchObject({
            status: 'already-checked',
        });
        // The record alone is a mark too (a join whose pin save never landed).
        const { settings, version } = await reloaded.ctx.settings.read();
        await reloaded.ctx.settings.write(version, { ...settings, groups: {} });
        const unpinned = await f.bobDevice(store);
        await expect(wordsMatch(unpinned.ctx, f.groupId, firstKeys)).resolves.toMatchObject({
            status: 'already-checked',
        });
    });

    test('a server showing another admission than the one whose code was read out reads as a mismatch, and keeps no mark', async () => {
        const f = await invitedFamily();
        const { ctx, store } = await f.bobDevice();
        const { firstKeys } = await familyWords(ctx, f.groupId);
        await wordsMatch(ctx, f.groupId, firstKeys);
        // The admin reads out the code of one admitting roster; the server stores another.
        const readOut = await f.admit();
        const stored = await f.admit(['guardian']);
        expect(stored.code).not.toEqual(readOut.code);
        await enterJoinCode(ctx, f.groupId, readOut);
        await f.land();
        expect(await finishJoin(ctx, f.groupId)).toMatchObject({ status: 'code-mismatch' });
        expect(await store.chain(BOB, f.groupId)).toBeNull();
        expect(await settingsPinOf(ctx, f.groupId)).toBeUndefined();
    });

    test('a finish whose pin save failed is completed by the next one, and the joins record goes', async () => {
        const f = await invitedFamily();
        const { ctx, store } = await f.bobDevice();
        const { firstKeys } = await familyWords(ctx, f.groupId);
        await wordsMatch(ctx, f.groupId, firstKeys);
        await enterJoinCode(ctx, f.groupId, await f.admit());
        await f.land();
        const settings = ctx.settings;
        let failed = false;
        ctx.settings = {
            read: () => settings.read(),
            write: async (version, doc) => {
                if (!failed && doc.groups?.[f.groupId]) {
                    failed = true;
                    throw new Error('offline');
                }
                return settings.write(version, doc);
            },
        };
        await expect(finishJoin(ctx, f.groupId)).rejects.toThrow('offline');
        expect(await store.chain(BOB, f.groupId)).not.toBeNull();
        expect(await store.join(BOB, f.groupId)).not.toBeNull();
        expect(await finishJoin(ctx, f.groupId)).toMatchObject({ status: 'joined' });
        expect(await settingsPinOf(ctx, f.groupId)).toMatchObject({ rosterVersion: 2 });
        expect(await store.join(BOB, f.groupId)).toBeNull();
    });

    test('after a not-member wipe the settings pin is still a mark: the family coming back is checked against it, never joined', async () => {
        const f = await invitedFamily();
        const store = createMemoryGroupStore();
        const { ctx } = await f.bobDevice(store);
        const { firstKeys } = await familyWords(ctx, f.groupId);
        await wordsMatch(ctx, f.groupId, firstKeys);
        const code = await f.admit();
        await enterJoinCode(ctx, f.groupId, code);
        await f.land();
        expect(await finishJoin(ctx, f.groupId)).toMatchObject({ status: 'joined' });
        // The server said not-member: the device forgets the family.
        await wipeGroup(ctx, f.groupId);
        expect(await store.chain(BOB, f.groupId)).toBeNull();
        expect(await settingsPinOf(ctx, f.groupId)).toMatchObject({ rosterVersion: 2 });
        // It lists the family again: a fresh tab still holds the pin as a mark.
        const back = await f.bobDevice(store);
        // No words to compare: checked before, so straight to the join code.
        expect(await familyWords(back.ctx, f.groupId)).toMatchObject({ status: 'already-checked' });
        await expect(wordsMatch(back.ctx, f.groupId, firstKeys)).resolves.toMatchObject({
            status: 'already-checked',
        });
        // A rejoin with a code that is not the served roster's is refused, the pin a mark beside it.
        const typo = [...code.code];
        typo[0] = typo[0] === 'abandon' ? 'ability' : 'abandon';
        await enterJoinCode(back.ctx, f.groupId, { ...code, code: typo });
        expect(await finishJoin(back.ctx, f.groupId)).toMatchObject({ status: 'code-mismatch' });
        expect(await store.chain(BOB, f.groupId)).toBeNull();
        // With the right code, the rejoin lands on the history the pin fixes.
        await enterJoinCode(back.ctx, f.groupId, code);
        expect(await finishJoin(back.ctx, f.groupId)).toMatchObject({ status: 'joined' });
        expect((await syncGroup(back.ctx, f.groupId)).status).toBe('accepted');
    });

    test('a rejoin onto another history than the pin fixes is the hard warning, even with that history’s own code', async () => {
        const f = await invitedFamily();
        const store = createMemoryGroupStore();
        const { ctx } = await f.bobDevice(store);
        const { firstKeys } = await familyWords(ctx, f.groupId);
        await wordsMatch(ctx, f.groupId, firstKeys);
        await enterJoinCode(ctx, f.groupId, await f.admit());
        await f.land();
        expect(await finishJoin(ctx, f.groupId)).toMatchObject({ status: 'joined' });
        // Alice (or whoever holds her keys) also signed another admission at that version.
        const other = await f.admit(['guardian']);
        // not-member, then the family again, under the other admission at the same version.
        await wipeGroup(ctx, f.groupId);
        f.serveInstead(1);
        const back = await f.bobDevice(store);
        await wordsMatch(back.ctx, f.groupId, firstKeys);
        await enterJoinCode(back.ctx, f.groupId, other);
        expect(await finishJoin(back.ctx, f.groupId)).toMatchObject({
            status: 'fork',
            fork: { of: 'roster', version: 2 },
        });
        expect(await store.chain(BOB, f.groupId)).toBeNull();
    });
});
