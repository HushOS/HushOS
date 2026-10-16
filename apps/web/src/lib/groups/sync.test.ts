import { describe, expect, test } from 'vitest';
import { syncGroup } from './sync';
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
            pinArea: { workspaceId: AREA, version: 1 },
        });
        h.results.driveOpenNodes = () => ({ nodes: [] });
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
            expect(h.calls('groupForget'), route).toEqual([{ groupId: GROUP }]);
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
