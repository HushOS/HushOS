// @vitest-environment node
import type { CryptoResults } from '@hushos/crypto';
import { digest } from '@hushos/crypto/signatures';
import { describe, expect, test, vi } from 'vitest';
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
            // Alice checked Bob's words: his pin saved in her settings, which her worker opens again.
            const { settings, version } = await aliceDevice.settings.read();
            await aliceDevice.settings.write(version, {
                ...settings,
                contacts: { ...settings.contacts, [BOB]: await pinOf(bob) },
            });
            await aliceDevice.settings.read();
            admitted = await aliceDevice.call('groupStage', {
                groupId,
                expectedRevision: 1,
                op: {
                    kind: 'admit',
                    userId: BOB,
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
    return confirmJoin(ctx, groupId, shown, wordsAt(read, shown.hidden));
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
        const joined = await confirmJoin(ctx, f.groupId, shown, wordsAt(shown.mark, shown.hidden));
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
        // Both hidden words wrong, or either one: nothing kept, and the same answer whichever
        // word it was, so a guesser never learns which was right. The first wrong pair for this
        // code is said calmly; every later one is the alarm, since a second miss on the same two
        // positions is no longer a typo to retry.
        const right = wordsAt(code, shown.hidden);
        const other = (word: string) => (word === 'abandon' ? 'ability' : 'abandon');
        const answers = [];
        for (const words of [
            [right[0]!, other(right[1]!)],
            right.map(other),
            [other(right[0]!), right[1]!],
        ]) {
            answers.push(await confirmJoin(ctx, f.groupId, shown, words));
            await nothingKept(ctx, store, f.groupId);
        }
        expect(answers).toEqual([
            { status: 'wrong-words' },
            { status: 'mismatch' },
            { status: 'mismatch' },
        ]);
        // After a wrong word the positions stay for that code: no showing offers easier ones.
        for (let showing = 0; showing < 4; showing++)
            expect(await joinStatus(ctx, f.groupId)).toMatchObject({ hidden: shown.hidden });
        // No two words at all: refused before anything is asked of the server.
        for (const typed of [[right[0]!], [right[0]!, ' '], [...right, right[0]!]])
            await expect(confirmJoin(ctx, f.groupId, shown, typed)).rejects.toThrow(
                /Type the two hidden words/,
            );
        await nothingKept(ctx, store, f.groupId);
        // As read out, any case and spacing: joined.
        expect(
            await confirmJoin(
                ctx,
                f.groupId,
                shown,
                right.map((word) => ` ${word.toUpperCase()} `),
            ),
        ).toMatchObject({ status: 'joined' });
    });

    test('a code this page never showed is never confirmed: the positions are the ones it issued, not the caller’s', async () => {
        const f = await invitedFamily();
        const { ctx, store } = await f.bobDevice();
        const code = await f.admit();
        await f.land();
        // The right code, its words at any two positions, but never shown here: nothing is
        // checked or kept, and the code is shown to compare again.
        const unshown = { mark: asMark(code), hidden: [0, 1], session: 0 };
        await expect(
            confirmJoin(ctx, f.groupId, unshown, wordsAt(code, [0, 1])),
        ).resolves.toMatchObject({ status: 'compare', mark: asMark(code) });
        await nothingKept(ctx, store, f.groupId);
        // Shown: only the words at the issued positions pass. Others, the code's own, do not.
        const shown = await joinStatus(ctx, f.groupId);
        if (shown.status !== 'compare') throw new Error(shown.status);
        const elsewhere = [0, 1, 2, 3, 4].filter((at) => !shown.hidden.includes(at)).slice(0, 2);
        const wrong = wordsAt(code, elsewhere);
        if (wrong.join(' ') !== wordsAt(code, shown.hidden).join(' '))
            expect(await confirmJoin(ctx, f.groupId, shown, wrong)).toEqual({
                status: 'wrong-words',
            });
        await nothingKept(ctx, store, f.groupId);
    });

    test('a code’s hidden positions stay with it until a match, and another code has its own', async () => {
        const f = await invitedFamily();
        const { ctx } = await f.bobDevice();
        const first = await f.admit();
        const second = await f.admit(['guardian']);
        f.serveInstead(0);
        await f.land();
        const shown = await joinStatus(ctx, f.groupId);
        if (shown.status !== 'compare') throw new Error(shown.status);
        const [low, high] = shown.hidden;
        expect(0 <= low && low < high && high <= 11).toBe(true);
        // Shown again: the same two words hidden, never a fresh pair to fish with.
        for (let showing = 0; showing < 4; showing++)
            expect(await joinStatus(ctx, f.groupId)).toMatchObject({ hidden: shown.hidden });
        // The server shows another admission: its own positions, also fixed.
        f.serveInstead(1);
        const other = await joinStatus(ctx, f.groupId);
        if (other.status !== 'compare') throw new Error(other.status);
        expect(other.mark).toEqual(asMark(second));
        for (let showing = 0; showing < 3; showing++)
            expect(await joinStatus(ctx, f.groupId)).toMatchObject({ hidden: other.hidden });
        // And back: the first code still hides what it hid.
        f.serveInstead(0);
        expect(await joinStatus(ctx, f.groupId)).toMatchObject({
            mark: asMark(first),
            hidden: shown.hidden,
        });
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
        expect(await confirmJoin(ctx, f.groupId, shown, wordsAt(alices, shown.hidden))).toEqual({
            status: 'wrong-words',
        });
        await nothingKept(ctx, store, f.groupId);
        // Read out again, still not the served code's: the alarm, not another calm retry.
        expect(await confirmJoin(ctx, f.groupId, shown, wordsAt(alices, shown.hidden))).toEqual({
            status: 'mismatch',
        });
        await nothingKept(ctx, store, f.groupId);
    });

    test('a reload asks the same two words after a wrong pair, and the next wrong pair is the alarm', async () => {
        const f = await invitedFamily();
        const { ctx, store } = await f.bobDevice();
        const alices = await f.admit();
        await f.admit(['guardian']);
        f.serveInstead(1);
        await f.land();
        const shown = await joinStatus(ctx, f.groupId);
        if (shown.status !== 'compare') throw new Error(shown.status);
        expect(await confirmJoin(ctx, f.groupId, shown, wordsAt(alices, shown.hidden))).toEqual({
            status: 'wrong-words',
        });
        // The escalation is kept beside the joins record, sealed by the worker.
        expect(await store.holds(BOB, f.groupId)).not.toBeNull();
        // A reload: the module and the worker (and their memory) start again; the device's storage
        // stays, and the worker folds in what it kept there.
        vi.resetModules();
        const reloaded = await import('./join');
        const after = (await f.bobDevice(store)).ctx;
        for (let showing = 0; showing < 4; showing++)
            expect(await reloaded.joinStatus(after, f.groupId)).toMatchObject({
                status: 'compare',
                hidden: shown.hidden,
            });
        expect(
            await reloaded.confirmJoin(after, f.groupId, shown, wordsAt(alices, shown.hidden)),
        ).toEqual({ status: 'mismatch' });
        await nothingKept(ctx, store, f.groupId);
    });

    test('a lock and an unlock in the same page ask the same two words after a wrong pair, and the next wrong pair is the alarm', async () => {
        const f = await invitedFamily();
        const { ctx, store, device } = await f.bobDevice();
        const alices = await f.admit();
        await f.admit(['guardian']);
        f.serveInstead(1);
        await f.land();
        const shown = await joinStatus(ctx, f.groupId);
        if (shown.status !== 'compare') throw new Error(shown.status);
        expect(await confirmJoin(ctx, f.groupId, shown, wordsAt(alices, shown.hidden))).toEqual({
            status: 'wrong-words',
        });
        // The worker forgets the family; the page (and join.ts) stays, so the kept escalation goes
        // back in on the first showing after the unlock.
        await device.lock();
        const again = await joinStatus(ctx, f.groupId);
        expect(again).toMatchObject({ status: 'compare', hidden: shown.hidden });
        if (again.status !== 'compare') throw new Error(again.status);
        // The showing from before the lock is not this unlock's: shown again, nothing checked.
        expect(
            await confirmJoin(ctx, f.groupId, shown, wordsAt(alices, shown.hidden)),
        ).toMatchObject({ status: 'compare', hidden: shown.hidden, session: again.session });
        expect(await confirmJoin(ctx, f.groupId, again, wordsAt(alices, again.hidden))).toEqual({
            status: 'mismatch',
        });
        await nothingKept(ctx, store, f.groupId);
    });

    test('storage that refuses the escalation leaves it held for the page: the second wrong pair is still the alarm', async () => {
        const f = await invitedFamily();
        const refusing: GroupStore = {
            ...createMemoryGroupStore(),
            putHolds: async () => {
                throw new Error('blocked');
            },
        };
        const { ctx, store } = await f.bobDevice(refusing);
        const code = await f.admit();
        await f.land();
        const shown = await joinStatus(ctx, f.groupId);
        if (shown.status !== 'compare') throw new Error(shown.status);
        const wrong = wordsAt(code, shown.hidden).map((word) =>
            word === 'abandon' ? 'ability' : 'abandon',
        );
        expect(await confirmJoin(ctx, f.groupId, shown, wrong)).toEqual({
            status: 'wrong-words',
        });
        expect(await joinStatus(ctx, f.groupId)).toMatchObject({ hidden: shown.hidden });
        expect(await confirmJoin(ctx, f.groupId, shown, wrong)).toEqual({
            status: 'mismatch',
        });
        await nothingKept(ctx, store, f.groupId);
        // Right after all, as read out: joined.
        expect(await confirmJoin(ctx, f.groupId, shown, wordsAt(code, shown.hidden))).toMatchObject(
            { status: 'joined' },
        );
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
        // was never shown here, so nothing is checked or kept and the served one is shown.
        const unshown = { mark: asMark(readOut), hidden: [0, 1], session: 0 };
        await expect(
            confirmJoin(ctx, f.groupId, unshown, wordsAt(readOut, [0, 1])),
        ).resolves.toMatchObject({ status: 'compare', mark: asMark(stored) });
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
        const reset = await confirmJoin(ctx, f.groupId, shown, wordsAt(first, shown.hidden));
        expect(reset).toMatchObject({
            status: 'compare',
            mark: asMark(second),
            changed: true,
        });
        await nothingKept(ctx, store, f.groupId);
        // Compared again, the new code joins.
        if (reset.status !== 'compare') throw new Error(reset.status);
        expect(
            await confirmJoin(ctx, f.groupId, reset, wordsAt(second, reset.hidden)),
        ).toMatchObject({ status: 'joined' });
    });

    test('one calm try per family: after a wrong pair, a switch to another code still gives the alarm', async () => {
        const f = await invitedFamily();
        const { ctx, store } = await f.bobDevice();
        const first = await f.admit();
        const second = await f.admit(['guardian']);
        f.serveInstead(0);
        await f.land();
        const shown = await joinStatus(ctx, f.groupId);
        if (shown.status !== 'compare') throw new Error(shown.status);
        const wrong = (read: { code: string[] }, hidden: readonly number[]) =>
            wordsAt(read, hidden).map((word) => (word === 'abandon' ? 'ability' : 'abandon'));
        expect(await confirmJoin(ctx, f.groupId, shown, wrong(first, shown.hidden))).toEqual({
            status: 'wrong-words',
        });
        // The server now shows another code: fresh positions for it, but no fresh calm try.
        f.serveInstead(1);
        const switched = await confirmJoin(ctx, f.groupId, shown, wordsAt(first, shown.hidden));
        expect(switched).toMatchObject({ status: 'compare', mark: asMark(second), changed: true });
        if (switched.status !== 'compare') throw new Error(switched.status);
        expect(await confirmJoin(ctx, f.groupId, switched, wrong(second, switched.hidden))).toEqual(
            { status: 'mismatch' },
        );
        await nothingKept(ctx, store, f.groupId);
        // After a reload too: the try is the tab's, not the page's or the worker's.
        vi.resetModules();
        const reloaded = await import('./join');
        const after = (await f.bobDevice(store)).ctx;
        const again = await reloaded.joinStatus(after, f.groupId);
        if (again.status !== 'compare') throw new Error(again.status);
        expect(
            await reloaded.confirmJoin(after, f.groupId, again, wrong(second, again.hidden)),
        ).toEqual({ status: 'mismatch' });
        // The right words join, and the family's try goes with the join.
        expect(
            await reloaded.confirmJoin(after, f.groupId, again, wordsAt(second, again.hidden)),
        ).toMatchObject({ status: 'joined' });
        // What stays kept is the family's sealed escalation: the first code's held positions, a code
        // no longer served; the family's wrong pair went with the join.
        expect(await store.holds(BOB, f.groupId)).not.toBeNull();
    });

    test('first keys that sign nothing served give no code to compare, and nothing is kept', async () => {
        const f = await invitedFamily();
        const { ctx, store } = await f.bobDevice();
        const code = await f.admit();
        await f.land();
        f.serveFirstKeys({ ...f.firstKeys, ed25519PublicKey: 'A'.repeat(43) });
        await expect(joinStatus(ctx, f.groupId)).rejects.toThrow(/not signed by the group key/);
        // Never shown, so never confirmed: showing it again meets the same unsigned roster.
        const unshown = { mark: asMark(code), hidden: [0, 1], session: 0 };
        await expect(confirmJoin(ctx, f.groupId, unshown, wordsAt(code, [0, 1]))).rejects.toThrow(
            /not signed by the group key/,
        );
        await nothingKept(ctx, store, f.groupId);
    });

    test('a “They match” cut short is finished after a reload while the served chain gives the code compared, and another code at its roster is the warning', async () => {
        const f = await invitedFamily();
        const store = createMemoryGroupStore();
        const { ctx } = await f.bobDevice(store);
        const first = await f.admit();
        await f.admit(['guardian']);
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
        // The server serves another admission at the same roster by the time the page comes back:
        // the code the person compared does not hold there, the hard warning, never a fresh code.
        f.serveInstead(1);
        expect(await joinStatus((await f.bobDevice(store)).ctx, f.groupId)).toMatchObject({
            status: 'fork',
            fork: { of: 'roster', version: 2 },
        });
        expect(await store.chain(BOB, f.groupId)).toBeNull();
        // Served as compared again: the reload finishes the join without asking again.
        f.serveInstead(0);
        expect(await joinStatus(ctx, f.groupId)).toMatchObject({ status: 'joined' });
        expect(await store.join(BOB, f.groupId)).toBeNull();
        expect((await store.chain(BOB, f.groupId))?.rosterVersion).toBe(2);
    });

    test('a joins record only the worker could have sealed: the data layer cannot write one, and one that does not open goes', async () => {
        const f = await invitedFamily();
        const { ctx, store, device } = await f.bobDevice();
        const code = await f.admit();
        await f.land();
        // The joins store is the worker's: a record of the data layer's own making would be a
        // family committed with no code compared (an earlier version's, the family's words
        // compared, is refused by the worker too: the join fixtures hold both twins to it).
        await expect(
            device.call('groupStoreSeal', {
                userId: BOB,
                groupId: f.groupId,
                store: 'joins' as never,
                value: { v: 2, groupId: f.groupId, joinMark: asMark(code), checkedAt: 'x' },
            }),
        ).rejects.toThrow(/not a family record this device keeps/);
        await store.putJoin({ userId: BOB, groupId: f.groupId, envelope: 'AAAA' });
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
            await confirmJoin(back.ctx, f.groupId, shown, wordsAt(shown.mark, shown.hidden)),
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
            await confirmJoin(ctx, f.groupId, shown, wordsAt(shown.mark, shown.hidden)),
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
