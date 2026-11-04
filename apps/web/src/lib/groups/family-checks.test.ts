import { describe, expect, test } from 'vitest';
import type { GroupSettings } from './context';
import { asFirstUse, familyChecked, withFamilyChecks } from './family-checks';
import { settlePin } from './pins';
import { GROUP, harness, pinAt } from './test-harness';

/*
 * Which families this person vouched for (docs/optional-verification.md 7.2):
 * every family accepted before first use was anchored by creation or a
 * compared join code, so the first client able to take one on first use
 * records that, in one save with the marker, before or with its first
 * first-use pin. A pin labelled `before` must never be a first-use one,
 * whichever device saves first and however saves race.
 */

const OTHER = '0b0e0f6c-6a55-4e5b-9d1a-1f9e2f0c0a02';
const THIRD = '0b0e0f6c-6a55-4e5b-9d1a-1f9e2f0c0a03';
const NOW = '2026-10-28T12:00:00.000Z';
const BEFORE = { how: 'before' as const, checkedAt: NOW };

describe('the family checks migration', () => {
    test('writes a check record for every family pin already there, with the marker, in one document', () => {
        const settings: GroupSettings = {
            version: 2,
            contacts: {},
            groups: { [OTHER]: pinAt(4), [THIRD]: pinAt(9) },
        };
        const next = withFamilyChecks(settings, NOW, { groupId: GROUP, checked: null });
        expect(next.familyChecksSince).toBe(NOW);
        expect(next.familyChecks).toEqual({
            [OTHER]: { rosterVersion: 4, ...BEFORE },
            [THIRD]: { rosterVersion: 9, ...BEFORE },
        });
        // Every family accepted before reads as checked; the new first-use one does not, once
        // its pin is in.
        const saved = { ...next, groups: { ...next.groups, [GROUP]: pinAt(2) } };
        expect(familyChecked(saved, OTHER)).toBe(true);
        expect(familyChecked(saved, THIRD)).toBe(true);
        expect(familyChecked(saved, GROUP)).toBe(false);
    });

    test('never labels a pin made after the marker, and never moves the marker', () => {
        const settings: GroupSettings = {
            version: 2,
            contacts: {},
            groups: { [OTHER]: pinAt(4) },
            familyChecksSince: '2026-10-20T00:00:00.000Z',
        };
        const next = withFamilyChecks(settings, NOW, { groupId: GROUP, checked: null });
        expect(next.familyChecks).toEqual({});
        expect(next.familyChecksSince).toBe('2026-10-20T00:00:00.000Z');
        expect(familyChecked({ ...next, groups: { ...next.groups } }, OTHER)).toBe(false);
    });

    test('records what vouched for a family this person made or joined with a code, so it never reads as first use', () => {
        const settings: GroupSettings = { version: 2, contacts: {} };
        const created = withFamilyChecks(settings, NOW, {
            groupId: GROUP,
            checked: { how: 'created', rosterVersion: 1 },
        });
        expect(created.familyChecks?.[GROUP]).toEqual({
            rosterVersion: 1,
            how: 'created',
            checkedAt: NOW,
        });
        const joined = withFamilyChecks(settings, NOW, {
            groupId: GROUP,
            checked: { how: 'join', rosterVersion: 3 },
        });
        expect(joined.familyChecks?.[GROUP]).toEqual({
            rosterVersion: 3,
            how: 'join',
            checkedAt: NOW,
        });
        // A check record already there (a family check that matched) is kept as it is.
        const compared = {
            rosterVersion: 2,
            with: '5d2c1b0a-3f4e-4d5c-8b7a-6e5f4d3c2b1b',
            code: Array(12).fill('abandon'),
            checkedAt: '2026-10-27T00:00:00.000Z',
        };
        expect(
            withFamilyChecks({ ...settings, familyChecks: { [GROUP]: compared } }, NOW, {
                groupId: GROUP,
                checked: { how: 'created', rosterVersion: 1 },
            }).familyChecks?.[GROUP],
        ).toEqual(compared);
    });

    test('settings in which a phone joined first, carrying the marker and a first-use pin, read as not checked', () => {
        const phoneFirst: GroupSettings = {
            version: 2,
            contacts: {},
            groups: { [GROUP]: pinAt(3), [OTHER]: pinAt(5) },
            familyChecks: { [OTHER]: { rosterVersion: 5, ...BEFORE } },
            familyChecksSince: '2026-10-21T00:00:00.000Z',
        };
        expect(familyChecked(phoneFirst, GROUP)).toBe(false);
        expect(familyChecked(phoneFirst, OTHER)).toBe(true);
        // And this client saving its own first use there labels nothing `before`.
        expect(
            withFamilyChecks(phoneFirst, NOW, { groupId: THIRD, checked: null }).familyChecks,
        ).toEqual(phoneFirst.familyChecks);
    });
});

describe('the first first-use pin', () => {
    test('is never saved without the marker, in the same save, and only the pins already there are `before`', async () => {
        const h = harness({
            settings: {
                doc: { version: 2, contacts: {}, groups: { [OTHER]: pinAt(4) } },
                version: 3,
            },
        });
        await settlePin(
            h.ctx,
            GROUP,
            { pin: pinAt(2), checked: null },
            {
                reaccept: async () => ({ pin: pinAt(2) }),
            },
        );
        expect(h.settingsLog.writes).toHaveLength(1);
        const [saved] = h.settingsLog.writes;
        expect(saved!.groups?.[GROUP]).toMatchObject({ rosterVersion: 2 });
        expect(saved!.familyChecksSince).toEqual(expect.any(String));
        expect(saved!.familyChecks).toEqual({
            [OTHER]: { rosterVersion: 4, how: 'before', checkedAt: expect.any(String) },
        });
        expect(familyChecked(saved!, GROUP)).toBe(false);
    });

    test('racing another device’s first use (a lost compare-and-set) never labels that device’s first-use pin `before`', async () => {
        const h = harness({ settings: { doc: { version: 2, contacts: {} }, version: 3 } });
        // Between this device's read and its save, another device takes OTHER on first use: the
        // marker and its pin, with no check record.
        const write = h.ctx.settings.write.bind(h.ctx.settings);
        let raced = false;
        h.ctx.settings.write = async (version, doc) => {
            if (!raced) {
                raced = true;
                h.settings.doc = {
                    version: 2,
                    contacts: {},
                    groups: { [OTHER]: pinAt(6) },
                    familyChecksSince: '2026-10-28T11:59:00.000Z',
                };
                h.settings.version++;
            }
            return write(version, doc);
        };
        await settlePin(
            h.ctx,
            GROUP,
            { pin: pinAt(2), checked: null },
            {
                reaccept: async () => ({ pin: pinAt(2) }),
            },
        );
        const saved = h.settings.doc;
        expect(saved.groups?.[OTHER]).toEqual(pinAt(6));
        expect(saved.groups?.[GROUP]).toMatchObject({ rosterVersion: 2 });
        expect(saved.familyChecks?.[OTHER]).toBeUndefined();
        expect(saved.familyChecksSince).toBe('2026-10-28T11:59:00.000Z');
        expect(familyChecked(saved, OTHER)).toBe(false);
        expect(familyChecked(saved, GROUP)).toBe(false);
    });
});

describe('a family folder’s verdicts on first use (2.6)', () => {
    test('what the member list vouches for reads as seen, never verified, and a personal check stays verified', () => {
        const node = (integrity: 'verified' | 'unknown-signer', via: string | null) => ({
            id: 'n',
            metadata: integrity,
            via,
            metadataRekey: { rekeyer: integrity, via, bound: true },
            versions: [{ id: 'v', integrity, via, rekey: null }],
        });
        expect(asFirstUse([node('verified', GROUP)], GROUP)).toEqual([
            {
                id: 'n',
                metadata: 'seen',
                via: GROUP,
                metadataRekey: { rekeyer: 'seen', via: GROUP, bound: true },
                versions: [{ id: 'v', integrity: 'seen', via: GROUP, rekey: null }],
            },
        ]);
        // This person's own check (no family's word), and what's wrong anyway, are left alone.
        expect(asFirstUse([node('verified', null)], GROUP)).toEqual([node('verified', null)]);
        expect(asFirstUse([node('unknown-signer', GROUP)], GROUP)).toEqual([
            node('unknown-signer', GROUP),
        ]);
    });
});
