// @vitest-environment node
import type { CryptoResults } from '@hushos/crypto';
import { digest } from '@hushos/crypto/signatures';
import { describe, expect, test } from 'vitest';
import type { GroupsApi } from './api';
import type { GroupContext } from './context';
import { confirmJoin, joinStatus } from './join';
import { createMemoryGroupStore, type GroupStore } from './store';
import { syncGroup, wipeGroup } from './sync';
import { account, bytes, pinOf } from './worker-testkit';

/*
 * The newcomer's join (join.ts) against the real crypto worker: Alice
 * creates a family and admits Bob in her own session, as the admin's dialog
 * does; Bob's side runs only through join.ts, with a server that serves what
 * the roster routes stored. Bob waits, is let in, compares the join code his
 * device works out with the one Alice's screen shows, and joins. Nothing is
 * kept until "They match", and then only if the served chain still gives the
 * code he compared; another code resets to it. A device that holds a mark,
 * the settings pin, decides the history with it even when rejoining.
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
        /* The code Alice's dialog shows once Bob is in: from her committed chain, after a sync. */
        codeAsAliceSees: async () => {
            await aliceDevice.settings.read();
            const synced = await aliceDevice.call('groupAccept', {
                userId: ALICE,
                groupId,
                served: served(),
                record: first.record,
                checkedAt: '2026-10-16T00:00:00.000Z',
            });
            if (synced.status !== 'accepted') throw new Error(synced.status);
            return aliceDevice.call('groupJoinCode', {
                groupId,
                userId: BOB,
                rosters: [...rosters],
            });
        },
        /* Alice signs Bob's admission ("Let them in", before it reaches the server). */
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
        /* Another admission Alice signed at the same version is the one served. */
        serveInstead: (index: number) => {
            admitted = signed[index]!;
            if (admitted.outboxId === null) throw new Error('nothing staged');
            // Before it landed, this is the one that lands; after, it replaces the stored one.
            if (rosters.length > 1) rosters[1] = admitted.body.roster;
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
    // And a sync has no mark to go on: only the join flow can start the family here.
    expect((await syncGroup(ctx, groupId)).status).toBe('unchecked');
}

const asMark = (code: { rosterVersion: number; code: string[] }) => ({
    rosterVersion: code.rosterVersion,
    code: code.code,
});

/* The two hidden words (at `hidden`) as Alice reads `read` out. */
const wordsAt = (read: { code: string[] }, hidden: readonly number[]) =>
    hidden.map((at) => read.code[at]!);

/* Bob's page shows the code, and he types its two hidden words as Alice reads `read` out. */
async function confirmAsRead(ctx: GroupContext, groupId: string, read: { code: string[] }) {
    const shown = await joinStatus(ctx, groupId);
    if (shown.status !== 'compare') throw new Error(shown.status);
    return confirmJoin(ctx, groupId, shown.mark, wordsAt(read, shown.hidden));
}

describe('joining a family', () => {
    test('waiting, then the code both screens show, then joined: the record, the folder and the pin come only after “They match”', async () => {
        const f = await invitedFamily();
        const { ctx, store } = await f.bobDevice();
        expect(await joinStatus(ctx, f.groupId)).toEqual({ status: 'waiting' });
        const staged = await f.admit();
        // Signed but not stored yet: still waiting.
        expect(await joinStatus(ctx, f.groupId)).toEqual({ status: 'waiting' });
        await f.land();
        const shown = await joinStatus(ctx, f.groupId);
        expect(shown).toMatchObject({
            status: 'compare',
            mark: asMark(staged),
        });
        // Alice's screen shows the same code, worked out from her own committed chain.
        expect(await f.codeAsAliceSees()).toMatchObject(asMark(staged));
        // Shown, not kept.
        await nothingKept(ctx, store, f.groupId);
        if (shown.status !== 'compare') throw new Error(shown.status);
        const joined = await confirmJoin(
            ctx,
            f.groupId,
            shown.mark,
            wordsAt(shown.mark, shown.hidden),
        );
        if (joined.status !== 'joined') throw new Error(joined.status);
        expect(joined.sync.view.rosterVersion).toBe(2);
        expect(joined.sync.areas).toMatchObject([
            { workspaceId: f.area.workspaceId, error: null, rootListed: true },
        ]);
        expect((await store.chain(BOB, f.groupId))?.rosterVersion).toBe(2);
        expect(await settingsPinOf(ctx, f.groupId)).toMatchObject({
            rosterVersion: 2,
            checkedAt: '2026-10-16T12:00:00.000Z',
            areas: { [f.area.workspaceId]: 1 },
        });
        expect(await store.join(BOB, f.groupId)).toBeNull();
        // From here the device holds the family: nothing more to join.
        expect(await joinStatus(ctx, f.groupId)).toEqual({ status: 'member' });
    });

    test('“They match” without the two hidden words as Alice reads them keeps nothing', async () => {
        const f = await invitedFamily();
        const { ctx, store } = await f.bobDevice();
        const code = await f.admit();
        await f.land();
        const shown = await joinStatus(ctx, f.groupId);
        if (shown.status !== 'compare') throw new Error(shown.status);
        // Both hidden words wrong, or either one: nothing kept, and the same answer every time,
        // so a guesser never learns which word was right.
        const right = wordsAt(code, shown.hidden);
        const other = (word: string) => (word === 'abandon' ? 'ability' : 'abandon');
        for (const words of [
            right.map(other),
            [right[0]!, other(right[1]!)],
            [other(right[0]!), right[1]!],
        ]) {
            expect(await confirmJoin(ctx, f.groupId, shown.mark, words)).toEqual({
                status: 'wrong-words',
            });
            await nothingKept(ctx, store, f.groupId);
        }
        // After a wrong word the positions stay for that code: no showing offers easier ones.
        for (let showing = 0; showing < 4; showing++)
            expect(await joinStatus(ctx, f.groupId)).toMatchObject({ hidden: shown.hidden });
        // No two words at all: refused before anything is asked of the server.
        for (const typed of [[right[0]!], [right[0]!, ' '], [...right, right[0]!]])
            await expect(confirmJoin(ctx, f.groupId, shown.mark, typed)).rejects.toThrow(
                /Type the two hidden words/,
            );
        await nothingKept(ctx, store, f.groupId);
        // As read out, any case and spacing: joined.
        expect(
            await confirmJoin(
                ctx,
                f.groupId,
                shown.mark,
                right.map((word) => ` ${word.toUpperCase()} `),
            ),
        ).toMatchObject({ status: 'joined' });
    });

    test('a code this page never showed is never confirmed: the positions are the ones it issued, not the caller’s', async () => {
        const f = await invitedFamily();
        const { ctx, store } = await f.bobDevice();
        const code = await f.admit();
        await f.land();
        // The right code, its words at any two positions, but never shown here.
        await expect(
            confirmJoin(ctx, f.groupId, asMark(code), wordsAt(code, [0, 1])),
        ).rejects.toThrow(/Compare the join code again/);
        await nothingKept(ctx, store, f.groupId);
        // Shown: only the words at the issued positions pass. Others, the code's own, do not.
        const shown = await joinStatus(ctx, f.groupId);
        if (shown.status !== 'compare') throw new Error(shown.status);
        const elsewhere = [0, 1, 2, 3, 4].filter((at) => !shown.hidden.includes(at)).slice(0, 2);
        const wrong = wordsAt(code, elsewhere);
        if (wrong.join(' ') !== wordsAt(code, shown.hidden).join(' '))
            expect(await confirmJoin(ctx, f.groupId, shown.mark, wrong)).toEqual({
                status: 'wrong-words',
            });
        await nothingKept(ctx, store, f.groupId);
    });

    test('the hidden positions are picked anew for each showing: two different ones of twelve', async () => {
        const f = await invitedFamily();
        const { ctx } = await f.bobDevice();
        await f.admit();
        await f.land();
        const pairs = new Set<string>();
        for (let showing = 0; showing < 12; showing++) {
            const shown = await joinStatus(ctx, f.groupId);
            if (shown.status !== 'compare') throw new Error(shown.status);
            const [first, second] = shown.hidden;
            expect(Number.isInteger(first) && Number.isInteger(second)).toBe(true);
            expect(0 <= first && first < second && second <= 11).toBe(true);
            pairs.add(shown.hidden.join(','));
        }
        // Twelve showings on one pair of 66 would be a fixed choice, not a random one.
        expect(pairs.size).toBeGreaterThan(1);
    });

    test('a code the server chose cannot be confirmed without the two words only Alice’s screen shows', async () => {
        const f = await invitedFamily();
        const { ctx, store } = await f.bobDevice();
        // Alice's screen shows one admission; the server stores and serves another.
        const alices = await f.admit();
        await f.admit(['guardian']);
        f.serveInstead(1);
        await f.land();
        const shown = await joinStatus(ctx, f.groupId);
        if (shown.status !== 'compare') throw new Error(shown.status);
        // Ten words compared by a person in a hurry, the two typed as Alice reads her own code.
        expect(
            await confirmJoin(ctx, f.groupId, shown.mark, wordsAt(alices, shown.hidden)),
        ).toEqual({ status: 'wrong-words' });
        await nothingKept(ctx, store, f.groupId);
    });

    test('a server showing another admission than Alice’s gives another code; “They match” on the code Alice read keeps no mark', async () => {
        const f = await invitedFamily();
        const { ctx, store } = await f.bobDevice();
        // Alice's screen shows the code of one admission; the server stores another.
        const readOut = await f.admit();
        const stored = await f.admit(['guardian']);
        f.serveInstead(1);
        await f.land();
        expect(stored.code).not.toEqual(readOut.code);
        const shown = await joinStatus(ctx, f.groupId);
        expect(shown).toMatchObject({
            status: 'compare',
            mark: asMark(stored),
        });
        // "They don't match": the page keeps nothing, and the same code comes back on a reload.
        await nothingKept(ctx, store, f.groupId);
        expect(await joinStatus((await f.bobDevice(store)).ctx, f.groupId)).toMatchObject({
            status: 'compare',
            mark: asMark(stored),
        });
        // The match gate: a code the served chain does not give, handed to confirmJoin directly,
        // was never shown here, so it is refused before anything is kept.
        await expect(
            confirmJoin(ctx, f.groupId, asMark(readOut), wordsAt(readOut, [0, 1])),
        ).rejects.toThrow(/Compare the join code again/);
        await nothingKept(ctx, store, f.groupId);
    });

    test('the member list changing between showing the code and “They match” resets to the new code, keeping nothing', async () => {
        const f = await invitedFamily();
        const { ctx, store } = await f.bobDevice();
        const first = await f.admit();
        const second = await f.admit(['guardian']);
        f.serveInstead(0);
        await f.land();
        const shown = await joinStatus(ctx, f.groupId);
        expect(shown).toMatchObject({
            status: 'compare',
            mark: asMark(first),
        });
        // The server serves another admission from now on.
        f.serveInstead(1);
        if (shown.status !== 'compare') throw new Error(shown.status);
        const reset = await confirmJoin(ctx, f.groupId, shown.mark, wordsAt(first, shown.hidden));
        expect(reset).toMatchObject({
            status: 'compare',
            mark: asMark(second),
            changed: true,
        });
        await nothingKept(ctx, store, f.groupId);
        // Compared again, the new code joins.
        if (reset.status !== 'compare') throw new Error(reset.status);
        expect(
            await confirmJoin(ctx, f.groupId, reset.mark, wordsAt(second, reset.hidden)),
        ).toMatchObject({ status: 'joined' });
    });

    test('first keys that sign nothing served give no code to compare, and nothing is kept', async () => {
        const f = await invitedFamily();
        const { ctx, store } = await f.bobDevice();
        const code = await f.admit();
        await f.land();
        f.serveFirstKeys({ ...f.firstKeys, ed25519PublicKey: 'A'.repeat(43) });
        await expect(joinStatus(ctx, f.groupId)).rejects.toThrow(/not signed by the group key/);
        // Never shown, so never confirmed.
        await expect(
            confirmJoin(ctx, f.groupId, asMark(code), wordsAt(code, [0, 1])),
        ).rejects.toThrow(/Compare the join code again/);
        await nothingKept(ctx, store, f.groupId);
    });

    test('a “They match” cut short is finished after a reload, but only while the served chain still gives the code compared', async () => {
        const f = await invitedFamily();
        const store = createMemoryGroupStore();
        const { ctx } = await f.bobDevice(store);
        const first = await f.admit();
        const second = await f.admit(['guardian']);
        f.serveInstead(0);
        await f.land();
        // The tab dies between keeping the compared code and writing the record.
        const failing: GroupStore = {
            ...store,
            putChain: async () => {
                throw new Error('tab closed');
            },
        };
        const cut = await f.bobDevice(failing);
        await expect(confirmAsRead(cut.ctx, f.groupId, first)).rejects.toThrow('tab closed');
        expect(await store.join(BOB, f.groupId)).not.toBeNull();
        expect(await store.chain(BOB, f.groupId)).toBeNull();
        // The server serves another admission by the time the page comes back: the code kept no
        // longer holds, so it goes, and the new one is compared.
        f.serveInstead(1);
        const again = await joinStatus((await f.bobDevice(store)).ctx, f.groupId);
        expect(again).toMatchObject({ status: 'compare', mark: asMark(second), changed: true });
        expect(await store.join(BOB, f.groupId)).toBeNull();
        // Again in the same tab, with the served chain unchanged, and cut short again.
        if (again.status !== 'compare') throw new Error(again.status);
        await expect(
            confirmJoin(cut.ctx, f.groupId, again.mark, wordsAt(second, again.hidden)),
        ).rejects.toThrow('tab closed');
        // The reload finishes the join without asking again.
        expect(await joinStatus(ctx, f.groupId)).toMatchObject({ status: 'joined' });
        expect(await store.join(BOB, f.groupId)).toBeNull();
        expect((await store.chain(BOB, f.groupId))?.rosterVersion).toBe(2);
    });

    test('a joins record from an earlier version (the family’s words compared) is no comparison: it goes, and the code is compared', async () => {
        const f = await invitedFamily();
        const { ctx, store, device } = await f.bobDevice();
        const code = await f.admit();
        await f.land();
        const { envelope } = await device.call('groupStoreSeal', {
            userId: BOB,
            groupId: f.groupId,
            store: 'joins',
            value: {
                v: 1,
                groupId: f.groupId,
                firstKeysDigest: 'x',
                checkedAt: '2026-10-01T00:00:00.000Z',
                joinMark: null,
            },
        });
        await store.putJoin({ userId: BOB, groupId: f.groupId, envelope });
        expect(await joinStatus(ctx, f.groupId)).toMatchObject({
            status: 'compare',
            mark: asMark(code),
        });
        expect(await store.join(BOB, f.groupId)).toBeNull();
    });

    test('a finish whose pin save failed is completed by the next one, and the joins record goes', async () => {
        const f = await invitedFamily();
        const { ctx, store } = await f.bobDevice();
        const code = await f.admit();
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
        await expect(confirmAsRead(ctx, f.groupId, code)).rejects.toThrow('offline');
        expect(await store.chain(BOB, f.groupId)).not.toBeNull();
        expect(await store.join(BOB, f.groupId)).not.toBeNull();
        expect(await joinStatus(ctx, f.groupId)).toMatchObject({ status: 'joined' });
        expect(await settingsPinOf(ctx, f.groupId)).toMatchObject({ rosterVersion: 2 });
        expect(await store.join(BOB, f.groupId)).toBeNull();
    });

    test('after a not-member wipe the settings pin is still a mark: a rejoin compares the code on top of it, and made-up first keys get no code', async () => {
        const f = await invitedFamily();
        const store = createMemoryGroupStore();
        const { ctx } = await f.bobDevice(store);
        const code = await f.admit();
        await f.land();
        expect(await confirmAsRead(ctx, f.groupId, code)).toMatchObject({
            status: 'joined',
        });
        // The server said not-member: the device forgets the family; the pin stays.
        await wipeGroup(ctx, f.groupId);
        expect(await store.chain(BOB, f.groupId)).toBeNull();
        expect(await settingsPinOf(ctx, f.groupId)).toMatchObject({ rosterVersion: 2 });
        const back = await f.bobDevice(store);
        // Made-up first keys: a device with no mark would be shown a code over them; the pin refuses.
        const real = f.firstKeys;
        f.serveFirstKeys({ ...real, ed25519PublicKey: 'A'.repeat(43) });
        await expect(joinStatus(back.ctx, f.groupId)).rejects.toThrow(
            /not the group keys this person checked/,
        );
        f.serveFirstKeys(real);
        const shown = await joinStatus(back.ctx, f.groupId);
        expect(shown).toMatchObject({
            status: 'compare',
            mark: asMark(code),
        });
        if (shown.status !== 'compare') throw new Error(shown.status);
        expect(
            await confirmJoin(back.ctx, f.groupId, shown.mark, wordsAt(shown.mark, shown.hidden)),
        ).toMatchObject({
            status: 'joined',
        });
        // The rejoin keeps the date the family was first checked on this account.
        expect(await settingsPinOf(back.ctx, f.groupId)).toMatchObject({
            checkedAt: '2026-10-16T12:00:00.000Z',
        });
        expect((await syncGroup(back.ctx, f.groupId)).status).toBe('accepted');
    });

    test('a rejoin onto another history than the pin fixes is the hard warning, before any code is shown', async () => {
        const f = await invitedFamily();
        const store = createMemoryGroupStore();
        const { ctx } = await f.bobDevice(store);
        await f.admit();
        await f.admit(['guardian']);
        f.serveInstead(0);
        await f.land();
        const shown = await joinStatus(ctx, f.groupId);
        if (shown.status !== 'compare') throw new Error(shown.status);
        expect(
            await confirmJoin(ctx, f.groupId, shown.mark, wordsAt(shown.mark, shown.hidden)),
        ).toMatchObject({ status: 'joined' });
        // not-member, then the family again, under the other admission at the same version.
        await wipeGroup(ctx, f.groupId);
        f.serveInstead(1);
        const back = await f.bobDevice(store);
        expect(await joinStatus(back.ctx, f.groupId)).toMatchObject({
            status: 'fork',
            fork: { of: 'roster', version: 2 },
        });
        expect(await store.chain(BOB, f.groupId)).toBeNull();
    });
});
