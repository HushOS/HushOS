import { describe, expect, test } from 'vitest';
import { leaveBlocker, removeBlocker } from './family-leave';

const MAYA = 'a0000000-0000-4000-8000-000000000001';
const SAM = 'a0000000-0000-4000-8000-000000000002';
const ANA = 'a0000000-0000-4000-8000-000000000003';
const member = (userId: string, roles: string[], state = 'active') => ({ userId, roles, state });

describe('who can leave a family', () => {
    test('the only organizer is told to hand it over before being offered Leave family', () => {
        const family = [member(MAYA, ['billing', 'members']), member(SAM, ['members'])];
        expect(leaveBlocker(MAYA, family)).toBe('Make someone else the organizer first.');
        // Once someone else is the organizer too, nothing stands in the way.
        expect(
            leaveBlocker(MAYA, [...family.slice(0, 1), member(SAM, ['billing', 'members'])]),
        ).toBeNull();
    });

    test('the last manager is told to let someone else manage first', () => {
        const family = [member(SAM, ['members']), member(ANA, []), member(MAYA, ['billing'])];
        expect(leaveBlocker(SAM, family)).toBe('Let someone else manage the family first.');
        // A plain member is never held back by anyone's roles.
        expect(leaveBlocker(ANA, family)).toBeNull();
    });

    test('only active members count: someone who left or waits to join holds no role here', () => {
        expect(
            leaveBlocker(MAYA, [
                member(MAYA, ['billing', 'members']),
                member(SAM, ['billing', 'members'], 'left'),
                member(ANA, ['members']),
            ]),
        ).toBe('Make someone else the organizer first.');
    });

    test('the last one in a family may always leave, which ends it', () => {
        expect(
            leaveBlocker(MAYA, [member(MAYA, ['billing', 'members']), member(SAM, [], 'accepted')]),
        ).toBeNull();
    });
});

describe('who can be removed from a family', () => {
    test('the only organizer is not offered for removal, with the reason; once another holds billing, they are', () => {
        const family = [member(MAYA, ['billing', 'members']), member(SAM, ['members'])];
        expect(removeBlocker(MAYA, 'Maya', family)).toBe(
            'Maya is the only one who manages the family’s plan. Make someone else the organizer first.',
        );
        expect(removeBlocker(SAM, 'Sam', family)).toBeNull();
        expect(
            removeBlocker(MAYA, 'Maya', [family[0]!, member(SAM, ['billing', 'members'])]),
        ).toBeNull();
        // Someone who left holds no role here.
        expect(
            removeBlocker(MAYA, 'Maya', [family[0]!, member(SAM, ['billing'], 'left')]),
        ).not.toBeNull();
    });
});
