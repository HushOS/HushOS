import { describe, expect, test } from 'vitest';
import { mergePin, settlePin } from './pins';
import { afterAccept } from './sync';
import { AREA, AREA_2, GROUP, harness, pinAt } from './test-harness';

/*
 * The settings pin is the mark every other device of the account checks a
 * family against (F4). Lowering it would let a server roll a device back with
 * nobody noticing; saving over a newer one blind would do the same from the
 * other side; and an area a server merely listed must never become a mark of
 * "this device opened that key".
 */

describe('the settings pin', () => {
    test('is never lowered: a newer one from another device makes this device accept again instead', async () => {
        const h = harness({
            settings: {
                doc: { version: 2, contacts: {}, groups: { [GROUP]: pinAt(7) } },
                version: 3,
            },
        });
        let reaccepted = 0;
        const saved = await settlePin(
            h.ctx,
            GROUP,
            { pin: pinAt(5) },
            {
                reaccept: async () => {
                    reaccepted++;
                    return { pin: pinAt(7) };
                },
            },
        );
        expect(reaccepted).toBe(1);
        expect(saved).toEqual({ status: 'settled', pin: pinAt(7) });
        expect(h.settingsLog.writes).toEqual([]);
    });

    test('a server that keeps this device behind gets no save at all, however often it is asked', async () => {
        const h = harness({
            settings: {
                doc: { version: 2, contacts: {}, groups: { [GROUP]: pinAt(7) } },
                version: 3,
            },
        });
        await expect(
            settlePin(
                h.ctx,
                GROUP,
                { pin: pinAt(5) },
                { reaccept: async () => ({ pin: pinAt(5) }) },
            ),
        ).rejects.toThrow();
        expect(h.settingsLog.writes).toEqual([]);
        expect(h.settings.doc.groups?.[GROUP]).toEqual(pinAt(7));
    });

    test('losing a save to another device re-reads the settings and accepts again before saving', async () => {
        const h = harness({
            settings: {
                doc: { version: 2, contacts: {}, groups: { [GROUP]: pinAt(5) } },
                version: 3,
            },
        });
        // Another device saves roster 7 between this device's read and its save.
        const settings = h.ctx.settings;
        const write = (version: number, doc: Parameters<typeof settings.write>[1]) =>
            settings.write(version, doc);
        let raced = false;
        h.ctx.settings = {
            ...settings,
            write: async (version, doc) => {
                if (!raced) {
                    raced = true;
                    h.settings.doc = { version: 2, contacts: {}, groups: { [GROUP]: pinAt(7) } };
                    h.settings.version++;
                }
                return write(version, doc);
            },
        };
        const readsBefore: number[] = [];
        const saved = await settlePin(
            h.ctx,
            GROUP,
            { pin: pinAt(6) },
            {
                reaccept: async () => {
                    readsBefore.push(h.settingsLog.reads);
                    // The worker, holding roster 7 as a mark now, accepts on to 8.
                    return { pin: pinAt(8) };
                },
            },
        );
        // Accepted again only after the newer settings were read (and so opened in the worker).
        expect(readsBefore).toEqual([1]);
        expect(saved).toMatchObject({ status: 'settled', pin: { rosterVersion: 8 } });
        expect(h.settings.doc.groups?.[GROUP]?.rosterVersion).toBe(8);
        // Roster 6 never landed over 7.
        expect(h.settingsLog.writes.map((doc) => doc.groups?.[GROUP]?.rosterVersion)).toEqual([8]);
    });

    test('another roster at the pinned version is never saved over: acceptance runs again against it and its fork is the answer', async () => {
        const h = harness({
            settings: {
                doc: { version: 2, contacts: {}, groups: { [GROUP]: pinAt(6) } },
                version: 3,
            },
        });
        const fork = {
            status: 'fork' as const,
            fork: { status: 'fork' as const, of: 'roster' as const, version: 6, sides: [] },
        };
        let reaccepted = 0;
        const settled = await settlePin(
            h.ctx,
            GROUP,
            { pin: pinAt(6, { rosterDigest: 'another-6' }) },
            {
                reaccept: async () => {
                    reaccepted++;
                    return fork;
                },
            },
        );
        // The worker, holding the settings pin as a mark, found the fork and dropped the chain.
        expect(reaccepted).toBe(1);
        expect(settled).toEqual(fork);
        expect(h.settingsLog.writes).toEqual([]);
    });

    test('keeps the earliest words check and never lowers an area', () => {
        const merged = mergePin(
            pinAt(5, { checkedAt: '2026-09-01T08:00:00.000Z', areas: { [AREA]: 3 } }),
            pinAt(6, { checkedAt: '2026-10-01T08:00:00.000Z', areas: { [AREA]: 2 } }),
            [{ workspaceId: AREA_2, version: 1 }],
        );
        expect(merged).toMatchObject({
            rosterVersion: 6,
            checkedAt: '2026-09-01T08:00:00.000Z',
            areas: { [AREA]: 3, [AREA_2]: 1 },
        });
    });
});

describe('areas in the pin', () => {
    test('come only from grants this device opened, never from the chain’s or the server’s list', async () => {
        const h = harness({
            settings: {
                doc: { version: 2, contacts: {}, groups: { [GROUP]: pinAt(5) } },
                version: 3,
            },
        });
        const area = (workspaceId: string) => ({
            workspaceId,
            idSeed: 'seed',
            workspaceKeyVersion: 1,
            changeSeq: 1,
            root: null,
            rotation: null,
            grant: null,
            selfGrant: null,
        });
        Object.assign(h.ctx.api, {
            spaces: async () => ({
                spaces: [
                    {
                        space: { kind: 'group', groupId: GROUP, name: 'Lindqvist family' },
                        areas: [area(AREA), area(AREA_2)],
                    },
                ],
            }),
        });
        // AREA opens; AREA_2's key does not (no grant at its version).
        h.results.groupOpenArea = (input) => {
            if (input.workspaceId !== AREA) throw new Error('Couldn’t check this folder’s keys.');
            return {
                version: 1,
                writable: false,
                reason: 'root-unknown',
                selfGrantToStore: null,
                pinArea: { workspaceId: AREA, version: 1 },
            };
        };
        const result = await afterAccept(h.ctx, GROUP, {
            status: 'accepted',
            view: { rosterVersion: 6, areas: { [AREA]: 1, [AREA_2]: 1 } } as never,
            record: 'record-6',
            pin: pinAt(6),
            dropped: [],
        });
        if (result.status !== 'accepted') throw new Error(result.status);
        expect(result.areas.map((at) => [at.workspaceId, at.error === null])).toEqual([
            [AREA, true],
            [AREA_2, false],
        ]);
        expect(h.settings.doc.groups?.[GROUP]?.areas).toEqual({ [AREA]: 1 });
    });
});
