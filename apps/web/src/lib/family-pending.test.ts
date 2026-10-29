import { describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/contacts', () => ({ saveSettings: vi.fn() }));
const {
    pendingFamiliesGone,
    pendingRolesOf,
    tidiedPendingRoles,
    withInvitedRole,
    withoutPendingRoles,
} = await import('./family-pending');

/*
 * The inviter's own record of "Let them manage the family" (6.8): kept by
 * invitation and the address typed, tied to a member only when one with that
 * address is let in, and gone once nothing waits: they left, were removed or
 * manage the family now, or the invitation was cancelled or expired.
 */

const G = 'f0000000-0000-4000-8000-000000000001';
const H = 'f0000000-0000-4000-8000-000000000002';
const SAM = 'b2b2b2b2-0000-4000-8000-000000000002';
const ANA = 'c3c3c3c3-0000-4000-8000-000000000003';
const INV_SAM = 'a0000000-0000-4000-8000-0000000000a1';
const INV_ANA = 'a0000000-0000-4000-8000-0000000000a2';
const INV_LEE = 'a0000000-0000-4000-8000-0000000000a3';
const AT = '2026-10-28T00:00:00.000Z';
const empty = { version: 2 as const, contacts: {} };
const invited = [
    [G, INV_SAM, 'Sam@Example.com '],
    [G, INV_ANA, 'ana@example.com'],
    [G, INV_LEE, 'lee@example.com'],
    [H, INV_SAM, 'sam@example.com'],
].reduce(
    (settings, [group, id, email]) => withInvitedRole(settings, group!, id!, email!, AT),
    empty as Parameters<typeof withInvitedRole>[0],
);
const none = () => undefined;
/* A day after the invitations went out, and well past their expiry. */
const SOON = new Date('2026-10-29T00:00:00.000Z');
const LATER = new Date('2026-11-20T00:00:00.000Z');

describe('the inviter’s record of a manager role', () => {
    test('is tied to the member let in with the address typed, and to no one else', () => {
        // Nobody let in yet: nothing is owed to anyone.
        expect(pendingRolesOf(invited, G, SAM)).toEqual([]);
        const tied = tidiedPendingRoles(
            invited,
            G,
            [
                // Let in under another address: never Ana's, nor anyone else's.
                { userId: ANA, email: 'ana.other@example.com', state: 'active', roles: [] },
                { userId: SAM, email: 'sam@example.com', state: 'active', roles: [] },
            ],
            none,
            SOON,
        );
        expect(pendingRolesOf(tied, G, SAM)).toEqual(['members']);
        expect(pendingRolesOf(tied, G, ANA)).toEqual([]);
        // Another family's record for the same address waits for its own family.
        expect(pendingRolesOf(tied, H, SAM)).toEqual([]);
        // Accepted, still waiting to be let in: not tied yet, and kept.
        const waiting = tidiedPendingRoles(
            invited,
            G,
            [{ userId: SAM, email: 'sam@example.com', state: 'accepted', roles: [] }],
            none,
            SOON,
        );
        expect(pendingRolesOf(waiting, G, SAM)).toEqual([]);
        expect(waiting.pendingRoles?.[G]?.[INV_SAM]).toBeDefined();
    });

    test('goes once nothing waits: invitation expired, member gone, or the role given', () => {
        const samIn = [{ userId: SAM, email: 'sam@example.com', state: 'active', roles: [] }];
        const tied = tidiedPendingRoles(invited, G, samIn, none, SOON);
        // Long past expiry: Lee's (nobody of that address waiting or in) goes; Ana's, waiting to be
        // let in, stays; Sam's is tied and stays.
        const lapsed = tidiedPendingRoles(
            tied,
            G,
            [...samIn, { userId: ANA, email: 'ana@example.com', state: 'accepted', roles: [] }],
            none,
            LATER,
        );
        expect(Object.keys(lapsed.pendingRoles?.[G] ?? {}).sort()).toEqual(
            [INV_ANA, INV_SAM].sort(),
        );
        // Before it expires, nobody waiting yet (route 3 behind route 12): nothing goes.
        expect(tidiedPendingRoles(tied, G, samIn, none, SOON)).toBe(tied);
        for (const sam of [
            { userId: SAM, email: 'sam@example.com', state: 'removed', roles: [] },
            { userId: SAM, email: 'sam@example.com', state: 'left', roles: [] },
            { userId: SAM, email: 'sam@example.com', state: 'active', roles: ['members'] },
        ])
            expect(pendingRolesOf(tidiedPendingRoles(tied, G, [sam], none, SOON), G, SAM)).toEqual(
                [],
            );
        // The checked member list's roles over route 3's.
        expect(
            pendingRolesOf(
                tidiedPendingRoles(
                    tied,
                    G,
                    samIn,
                    (id) => (id === SAM ? ['members'] : undefined),
                    SOON,
                ),
                G,
                SAM,
            ),
        ).toEqual([]);
    });

    test('a family this account is no longer in, and clearing one member leaves the rest', () => {
        expect(pendingFamiliesGone(invited, [G])).toEqual([H]);
        expect(pendingFamiliesGone(invited, [G, H])).toEqual([]);
        const tied = tidiedPendingRoles(
            invited,
            G,
            [{ userId: SAM, email: 'sam@example.com', state: 'active', roles: [] }],
            none,
            SOON,
        );
        const cleared = withoutPendingRoles(tied, G, [SAM]);
        expect(pendingRolesOf(cleared, G, SAM)).toEqual([]);
        expect(Object.keys(cleared.pendingRoles?.[G] ?? {}).sort()).toEqual(
            [INV_ANA, INV_LEE].sort(),
        );
        expect(
            withoutPendingRoles(withoutPendingRoles(invited, G, 'all'), H, 'all'),
        ).not.toHaveProperty('pendingRoles');
    });
});
