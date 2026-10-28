import { describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/contacts', () => ({ saveSettings: vi.fn() }));
const { pendingFamiliesGone, pendingRolesDone, pendingRolesOf, withoutPendingRoles } =
    await import('./family-pending');

/*
 * What still waits of a manager role held back at Let them in (6.8): only
 * someone still in the family, or still waiting to be let in, who doesn't
 * manage it yet; and only in a family this account is still in.
 */

const G = 'f0000000-0000-4000-8000-000000000001';
const H = 'f0000000-0000-4000-8000-000000000002';
const SAM = 'b2b2b2b2-0000-4000-8000-000000000002';
const ANA = 'c3c3c3c3-0000-4000-8000-000000000003';
const LEE = 'd4d4d4d4-0000-4000-8000-000000000004';
const KIM = 'e5e5e5e5-0000-4000-8000-000000000005';
const waiting = { roles: ['members' as const], since: '2026-10-28T00:00:00Z' };
const settings = {
    version: 2 as const,
    contacts: {},
    pendingRoles: {
        [G]: { [SAM]: waiting, [ANA]: waiting, [LEE]: waiting, [KIM]: waiting },
        [H]: { [SAM]: waiting },
    },
};

describe('what no longer waits', () => {
    test('someone gone, removed or managing now; not someone waiting to be let in or still a plain member', () => {
        const members = [
            { userId: SAM, state: 'removed', roles: [] },
            { userId: ANA, state: 'accepted', roles: [] },
            { userId: LEE, state: 'active', roles: [] },
            // KIM has no membership at all: an admission that never landed, an invitation gone.
        ];
        expect(pendingRolesDone(settings, G, members, () => undefined).sort()).toEqual(
            [KIM, SAM].sort(),
        );
        // The checked member list's roles, where it has them, over route 3's.
        expect(
            pendingRolesDone(settings, G, members, (id) =>
                id === LEE ? ['members'] : undefined,
            ).sort(),
        ).toEqual([KIM, LEE, SAM].sort());
        expect(
            pendingRolesDone(
                settings,
                G,
                [...members, { userId: KIM, state: 'left', roles: [] }],
                () => undefined,
            ).sort(),
        ).toEqual([KIM, SAM].sort());
    });

    test('a family this account is no longer in, and clearing leaves the rest', () => {
        expect(pendingFamiliesGone(settings, [G])).toEqual([H]);
        expect(pendingFamiliesGone(settings, [G, H])).toEqual([]);
        const cleared = withoutPendingRoles(settings, G, [SAM]);
        expect(pendingRolesOf(cleared, G, SAM)).toEqual([]);
        expect(pendingRolesOf(cleared, G, ANA)).toEqual(['members']);
        expect(pendingRolesOf(cleared, H, SAM)).toEqual(['members']);
        expect(
            withoutPendingRoles(withoutPendingRoles(settings, G, 'all'), H, 'all'),
        ).not.toHaveProperty('pendingRoles');
    });
});
