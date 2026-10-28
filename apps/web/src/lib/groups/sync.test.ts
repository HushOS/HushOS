import type { CryptoResults } from '@hushos/crypto';
import { OLDER_CHAIN, SPLIT_CHAIN } from '@hushos/crypto/protocol';
import { describe, expect, test } from 'vitest';
import { GUARD_UNREADABLE, GUARD_UNSAVED } from '@/lib/contact-guard';
import { areaWrite, syncGroup, wipeGroup, writeRefusal } from './sync';
import { AREA, GROUP, USER, harness, pinAt, refusal } from './test-harness';

/*
 * A family's sync (the 1c plan, section 2 "Sync", and section 5): a served
 * chain that does not continue this device's record is fetched again from
 * version 1 with the record as a mark, a fork writes no mark at all, and a
 * family folder is listed at its root right after its key is opened, which
 * is the only thing that lets the worker count it writable.
 */

function knownFamily(h: ReturnType<typeof harness>) {
    h.settings.doc = { version: 2, contacts: {}, groups: { [GROUP]: pinAt(5) } };
    return h.store.putChain({
        userId: USER,
        groupId: GROUP,
        envelope: 'record-5',
        rosterVersion: 5,
        areas: [AREA],
    });
}

function routeRosters(h: ReturnType<typeof harness>) {
    const asked: number[] = [];
    const served = h.ctx.api.rosters;
    Object.assign(h.ctx.api, {
        rosters: (groupId: string, after: number) => {
            asked.push(after);
            return served(groupId, after);
        },
    });
    return asked;
}

describe('syncing a family', () => {
    test('a chain that does not continue the record is fetched again from version 1, the record a mark', async () => {
        const h = harness({ head: 6 });
        await knownFamily(h);
        const asked = routeRosters(h);
        h.failNext.set('groupAccept', new Error('This member list does not continue the cache.'));
        expect((await syncGroup(h.ctx, GROUP)).status).toBe('accepted');
        expect(asked).toEqual([5, 0]);
        expect(h.calls('groupAccept')).toMatchObject([
            { record: 'record-5' },
            { record: 'record-5' },
        ]);
        expect((await h.store.chain(USER, GROUP))?.envelope).toBe('record-6');
    });

    test('a continuation a later acceptance overtook goes once from version 1 with the record, never without the cache', async () => {
        for (const refused of [OLDER_CHAIN, SPLIT_CHAIN]) {
            const h = harness({ head: 6 });
            await knownFamily(h);
            const asked = routeRosters(h);
            h.failNext.set('groupAccept', new Error(refused));
            const result = await syncGroup(h.ctx, GROUP);
            expect(result.status).toBe('accepted');
            // A damaged cache that names no head looks just like this: version 1 settles it.
            expect(asked).toEqual([5, 0]);
            expect(h.calls('groupAccept')).toMatchObject([
                { record: 'record-5' },
                { record: 'record-5' },
            ]);
            expect(h.calls('groupAccept').some((call) => 'withoutCache' in (call as object))).toBe(
                false,
            );
            expect((await h.store.chain(USER, GROUP))?.envelope).toBe('record-6');
        }
    });

    test('a run overtaken from version 1 too is read again quietly, from the record', async () => {
        const h = harness({ head: 6 });
        await knownFamily(h);
        const asked = routeRosters(h);
        const answer = h.results.groupAccept;
        let calls = 0;
        h.results.groupAccept = (input: unknown) => {
            if (++calls <= 2) throw new Error(OLDER_CHAIN);
            return (answer as (input: unknown) => unknown)(input);
        };
        expect((await syncGroup(h.ctx, GROUP)).status).toBe('accepted');
        // The record and settings read again, and the run starts over from the record.
        expect(asked).toEqual([5, 0, 5]);
        expect(h.calls('groupAccept').some((call) => 'withoutCache' in (call as object))).toBe(
            false,
        );
    });

    test('a server that keeps serving older, or another list at the version checked, is said so, not as a lost race', async () => {
        for (const [refused, said] of [
            [OLDER_CHAIN, /an older member list than this device/],
            [SPLIT_CHAIN, /a different member list at the version this device/],
        ] as const) {
            const h = harness({ head: 6 });
            await knownFamily(h);
            h.results.groupAccept = () => {
                throw new Error(refused);
            };
            await expect(syncGroup(h.ctx, GROUP)).rejects.toThrow(said);
            // Three runs, each the continuation and once from version 1.
            expect(h.calls('groupAccept')).toHaveLength(6);
            expect((await h.store.chain(USER, GROUP))?.envelope).toBe('record-5');
            expect(h.settingsLog.writes).toEqual([]);
        }
    });

    test('a route that failed is not taken for a chain that did not continue', async () => {
        const h = harness();
        await knownFamily(h);
        const asked = routeRosters(h);
        Object.assign(h.ctx.api, {
            rosters: async (_groupId: string, after: number) => {
                asked.push(after);
                throw refusal(503, 'unavailable');
            },
        });
        await expect(syncGroup(h.ctx, GROUP)).rejects.toThrow();
        expect(asked).toEqual([5]);
    });

    test('a fork writes no record and no pin', async () => {
        const h = harness({ head: 6 });
        await knownFamily(h);
        h.results.groupAccept = () => ({
            status: 'fork',
            fork: { status: 'fork', of: 'roster', version: 5, sides: [] },
        });
        expect((await syncGroup(h.ctx, GROUP)).status).toBe('fork');
        expect((await h.store.chain(USER, GROUP))?.envelope).toBe('record-5');
        expect(h.settingsLog.writes).toEqual([]);
    });

    test('with no mark anywhere, nothing is accepted: only the join flow can start the family here', async () => {
        const h = harness();
        expect(await syncGroup(h.ctx, GROUP)).toEqual({ status: 'unchecked', notices: [] });
        expect(h.calls('groupAccept')).toEqual([]);
    });

    test('each folder’s key is opened, its self-grant stored, then its root listed under the area', async () => {
        const h = harness({ head: 6 });
        await knownFamily(h);
        const selfGrant = { version: 1, workspaceId: AREA, workspaceKeyVersion: 1 };
        const stored: unknown[] = [];
        Object.assign(h.ctx.api, {
            spaces: async () => ({
                spaces: [
                    {
                        space: { kind: 'group', groupId: GROUP, name: 'Lindqvist family' },
                        areas: [
                            {
                                workspaceId: AREA,
                                idSeed: 'seed',
                                workspaceKeyVersion: 1,
                                changeSeq: 3,
                                // A root as Drive serves one: no parent id.
                                root: {
                                    id: 'root',
                                    parentId: null,
                                    parentKeyEpoch: 1,
                                    keyEpoch: 1,
                                    keyEnvelope: 'root-key',
                                    metadataVersion: 1,
                                    metadataEnvelope: 'root-meta',
                                    prevKeyEnvelope: null,
                                    prevKeyEpoch: null,
                                    prevParentKeyEpoch: null,
                                },
                                rotation: null,
                                grant: null,
                                selfGrant: null,
                            },
                        ],
                    },
                ],
            }),
            putSelfGrant: async (_groupId: string, workspaceId: string, grant: unknown) => {
                stored.push([workspaceId, grant]);
                return { ok: true };
            },
        });
        h.results.groupOpenArea = () => ({
            version: 1,
            writable: false,
            reason: 'root-unknown',
            selfGrantToStore: selfGrant as never,
            pinArea: { groupId: GROUP, workspaceId: AREA, version: 1 },
        });
        h.results.driveOpenNodes = () => ({
            nodes: [
                {
                    id: 'root',
                    metadata: { name: 'Family', mime: null, size: null, modified: null },
                    content: null,
                },
            ],
        });
        const result = await syncGroup(h.ctx, GROUP);
        if (result.status !== 'accepted') throw new Error(result.status);
        expect(stored).toEqual([[AREA, selfGrant]]);
        const order = h.worker.map((call) => call.operation);
        expect(order.indexOf('groupOpenArea')).toBeLessThan(order.indexOf('driveOpenNodes'));
        expect(h.calls('driveOpenNodes')).toMatchObject([
            { workspaceId: AREA, nodes: [{ id: 'root', parentId: AREA, parentKeyEpoch: 1 }] },
        ]);
        expect(result.areas).toMatchObject([{ workspaceId: AREA, rootListed: true, error: null }]);
    });

    test('not-member on any route a sync reads wipes the device, never the settings pin; a bare 404 wipes nothing', async () => {
        const routes = {
            rosters: (h: ReturnType<typeof harness>) =>
                Object.assign(h.ctx.api, {
                    rosters: async () => {
                        throw refusal(404, 'not-member');
                    },
                }),
            identities: (h: ReturnType<typeof harness>) =>
                Object.assign(h.ctx.api, {
                    spaces: async () => ({
                        spaces: [
                            {
                                space: { kind: 'group', groupId: GROUP, name: 'L' },
                                areas: [{ workspaceId: AREA, idSeed: 's', root: null }],
                            },
                        ],
                    }),
                    identities: async () => {
                        throw refusal(404, 'not-member');
                    },
                }),
        };
        for (const [route, breakRoute] of Object.entries(routes)) {
            const h = harness({ head: 6 });
            await knownFamily(h);
            breakRoute(h);
            expect(await syncGroup(h.ctx, GROUP), route).toEqual({ status: 'wiped' });
            expect(h.calls('groupForget'), route).toEqual([
                { groupId: GROUP, guard: null, checkedAt: expect.any(String) },
            ]);
            expect(await h.store.chain(USER, GROUP), route).toBeNull();
            expect(h.settings.doc.groups?.[GROUP], route).toEqual(pinAt(5));
        }
        const h = harness({ head: 6 });
        await knownFamily(h);
        Object.assign(h.ctx.api, {
            rosters: async () => {
                throw refusal(404, null);
            },
        });
        await expect(syncGroup(h.ctx, GROUP)).rejects.toThrow();
        expect(h.calls('groupForget')).toEqual([]);
        expect(await h.store.chain(USER, GROUP)).not.toBeNull();
    });

    test('a wipe stores the guard the worker hands back first, asks again with it, and deletes nothing until the worker forgot', async () => {
        const h = harness({ head: 6 });
        await knownFamily(h);
        const order: string[] = [];
        const forget = h.store.forgetGroup.bind(h.store);
        h.store.forgetGroup = async (userId, groupId) => {
            order.push('deleted');
            return forget(userId, groupId);
        };
        const keep = h.ctx.guard.keep.bind(h.ctx.guard);
        h.ctx.guard.keep = async (groupId, pin) => {
            order.push(`stored ${pin.rosterVersion}`);
            return keep(groupId, pin);
        };
        // The worker holds roster 7 this session and the guard is at nothing: it hands 7 back.
        let asked = 0;
        h.results.groupForget = () =>
            ++asked === 1
                ? { forgotten: false, guard: pinAt(7), unreadable: false }
                : { forgotten: true, guard: null, unreadable: false };
        await wipeGroup(h.ctx, GROUP);
        expect(order).toEqual(['stored 7', 'deleted']);
        // Asked again with what is stored now, which covers the session's floor.
        expect(h.calls('groupForget')).toEqual([
            { groupId: GROUP, guard: null, checkedAt: expect.any(String) },
            { groupId: GROUP, guard: pinAt(7), checkedAt: expect.any(String) },
        ]);
        expect(await h.store.chain(USER, GROUP)).toBeNull();
    });

    test('a wipe whose guard can’t be stored, or that the worker never says it forgot, deletes nothing', async () => {
        for (const kind of ['unsaved', 'never-forgot', 'unreadable'] as const) {
            const h = harness({ head: 6 });
            await knownFamily(h);
            if (kind === 'unsaved') h.guard.failWrites = 1;
            if (kind === 'unreadable') h.guard.failReads = true;
            h.results.groupForget = () => ({
                forgotten: false,
                guard: pinAt(7),
                unreadable: kind === 'unreadable',
            });
            const wiped = wipeGroup(h.ctx, GROUP);
            if (kind === 'unsaved') await expect(wiped, kind).rejects.toThrow(GUARD_UNSAVED);
            else if (kind === 'unreadable')
                await expect(wiped, kind).rejects.toThrow(GUARD_UNREADABLE);
            else await wiped;
            expect(await h.store.chain(USER, GROUP), kind).not.toBeNull();
        }
    });

    test('a record that no longer opens is deleted and the family checked again against the settings pin, and said so', async () => {
        const h = harness({ head: 6 });
        await knownFamily(h);
        let first = true;
        const accept = h.results.groupAccept!;
        h.results.groupAccept = (input) => {
            if (first && input.record) {
                first = false;
                return { status: 'record-unreadable' };
            }
            return accept(input);
        };
        const result = await syncGroup(h.ctx, GROUP);
        expect(result).toMatchObject({
            status: 'accepted',
            notices: [{ kind: 'record-reset', groupId: GROUP }],
        });
        expect(h.calls('groupAccept')).toMatchObject([{ record: 'record-5' }, { record: null }]);
        expect((await h.store.chain(USER, GROUP))?.envelope).toBe('record-6');
    });

    test('a record whose cache the worker refuses from version 1 too is accepted without its cache, its pin still a mark', async () => {
        const h = harness({ head: 6 });
        await knownFamily(h);
        const asked = routeRosters(h);
        const accept = h.results.groupAccept!;
        // A record a newer release wrote: every acceptance its cache is a mark of is refused.
        h.results.groupAccept = (input) => {
            if (input.record && !input.withoutCache) throw new Error('Invalid member list cache.');
            return accept(input);
        };
        expect((await syncGroup(h.ctx, GROUP)).status).toBe('accepted');
        expect(asked).toEqual([5, 0, 0]);
        // The record goes to the worker every time: only its cache is left out, never its pin.
        expect(h.calls('groupAccept')).toMatchObject([
            { record: 'record-5' },
            { record: 'record-5' },
            { record: 'record-5', withoutCache: true },
        ]);
        expect(h.calls('groupAccept')[1]).not.toHaveProperty('withoutCache');
        expect((await h.store.chain(USER, GROUP))?.envelope).toBe('record-6');
    });

    test('a chain refused on its own merits keeps the record', async () => {
        const h = harness({ head: 6 });
        await knownFamily(h);
        h.results.groupAccept = () => {
            throw new Error('Invalid roster.');
        };
        await expect(syncGroup(h.ctx, GROUP)).rejects.toThrow('Invalid roster.');
        expect(h.calls('groupAccept')).toHaveLength(3);
        expect((await h.store.chain(USER, GROUP))?.envelope).toBe('record-5');
    });

    test('with no settings pin either, an unreadable record leaves the family unchecked', async () => {
        const h = harness({ head: 6 });
        await knownFamily(h);
        h.settings.doc = { version: 2, contacts: {} };
        h.results.groupAccept = () => ({ status: 'record-unreadable' });
        expect(await syncGroup(h.ctx, GROUP)).toEqual({
            status: 'unchecked',
            notices: [{ kind: 'record-reset', groupId: GROUP }],
        });
        expect(await h.store.chain(USER, GROUP)).toBeNull();
    });

    test('a staged call the accepted chain holds goes from the outbox, after the record is written', async () => {
        const h = harness({ head: 6 });
        await knownFamily(h);
        await h.store.putOutbox({
            id: 'landed-elsewhere',
            userId: USER,
            groupId: GROUP,
            envelope: 'sealed:null',
        });
        const accept = h.results.groupAccept!;
        const order: string[] = [];
        h.results.groupAccept = (input) => ({
            ...(accept(input) as object),
            dropped: ['landed-elsewhere'],
        });
        const store = { ...h.store };
        h.store.putChain = async (row) => {
            order.push(`record, outbox ${(await h.store.outbox(USER, GROUP)).length}`);
            return store.putChain(row);
        };
        expect((await syncGroup(h.ctx, GROUP, { flush: false } as never)).status).toBe('accepted');
        // The row goes only once the record is written.
        expect(order).toEqual(['record, outbox 1']);
        expect(await h.store.outbox(USER, GROUP)).toEqual([]);
    });
});

/*
 * What a family folder page says it may do (plan section 5, F9). The worker
 * refuses any write this does not allow either way; a wrong reading here would
 * offer Add where the worker refuses, or say a folder is fine whose server is
 * ahead of or behind the member list.
 */
describe('areaWrite', () => {
    const root = { id: 'root' } as never;
    const opened = (reason: CryptoResults['groupOpenArea']['reason']) => ({
        version: 1,
        writable: reason === null,
        reason,
        selfGrantToStore: null,
        from: 'grant' as const,
        pinArea: { groupId: GROUP, workspaceId: AREA, version: 1 },
    });
    const view = (withRoot: boolean) => ({
        workspaceKeyVersion: 1,
        changeSeq: 0,
        root: withRoot ? root : null,
        rotation: null,
    });
    test.each([
        ['not opened at all', null, false, true, 'read-only'],
        ['no grant at the latest version', opened('no-grant-at-latest'), true, true, 'read-only'],
        ['the server behind the member list', opened('server-behind'), true, true, 'keys-changed'],
        ['the server ahead of the member list', opened('server-ahead'), true, true, 'keys-changed'],
        ['the root not listed yet, then listed', opened('root-unknown'), true, true, 'writable'],
        ['a root under an older key', opened('root-behind'), false, true, 'keys-changed'],
        ['a root that did not open', opened('root-unknown'), false, true, 'keys-changed'],
        ['no root at all', opened('root-unknown'), false, false, 'read-only'],
        ['nothing wrong and the root listed', opened(null), true, true, 'writable'],
    ] as const)('%s', (_case, state, rootListed, withRoot, expected) => {
        expect(areaWrite({ opened: state, rootListed, view: view(withRoot) })).toBe(expected);
    });
});

/*
 * Adding to a family folder while a key change walks it (D9): only a folder at
 * the walk's target epoch (re-keyed, or made since) takes anything. One below
 * is under a key the removed member holds.
 */
describe('writeRefusal', () => {
    const state = (
        write: ReturnType<typeof areaWrite>,
        rotation: { targetEpoch: number } | null,
    ) => ({
        write,
        view: {
            workspaceKeyVersion: 1,
            changeSeq: 0,
            root: null,
            rotation: rotation ? { id: 'r', nodeId: 'root', ...rotation } : null,
        },
    });
    test('the walk’s target epoch is the boundary: at it a folder takes things, one below waits', () => {
        const walking = state('writable', { targetEpoch: 7 });
        expect(writeRefusal(walking, { keyEpoch: 7 })).toBeNull();
        expect(writeRefusal(walking, { keyEpoch: 8 })).toBeNull();
        expect(writeRefusal(walking, { keyEpoch: 6 })).toMatch(/^Finishing a key change\./);
        // No walk: any folder.
        expect(writeRefusal(state('writable', null), { keyEpoch: 1 })).toBeNull();
    });
    test('no state, or a folder the worker may not write, refuses whatever the epoch', () => {
        expect(writeRefusal(undefined, { keyEpoch: 99 })).toMatch(/Open the family again/);
        expect(writeRefusal(state('read-only', null), { keyEpoch: 99 })).toMatch(/couldn’t check/);
        expect(writeRefusal(state('keys-changed', null), { keyEpoch: 99 })).toMatch(/keys changed/);
    });
});
