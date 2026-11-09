import { describe, expect, it } from 'vitest';
import { familyItemActive, waitingOn } from '@/lib/families-shell';

const family = '0b6a6c1e-6a39-4f36-9f53-2f1d1c3a7e10';

describe('familyItemActive', () => {
    it('marks the family item on its folders, a folder in them and their Trash', () => {
        expect(familyItemActive(`/app/s/${family}`, family)).toBe(true);
        expect(familyItemActive(`/app/s/${family}/f/9d2a`, family)).toBe(true);
        expect(familyItemActive(`/app/s/${family}/trash`, family)).toBe(true);
    });

    it('marks it on the family page, which it no longer links to', () => {
        expect(familyItemActive('/app/family', family)).toBe(true);
        expect(familyItemActive('/app/family/', family)).toBe(true);
    });

    it('leaves it alone on another family’s folders, an id it only prefixes, and My files', () => {
        expect(familyItemActive('/app/s/7f1e2d3c-0000-4000-8000-000000000000', family)).toBe(false);
        expect(familyItemActive(`/app/s/${family}0`, family)).toBe(false);
        expect(familyItemActive('/app/familyx', family)).toBe(false);
        expect(familyItemActive('/app/drive', family)).toBe(false);
        expect(familyItemActive('/app/trash', family)).toBe(false);
    });
});

describe('waitingOn', () => {
    const me = 'maya';
    const members = [
        { userId: 'maya', state: 'active' },
        { userId: 'sam', state: 'active' },
        { userId: 'ana', state: 'active' },
        { userId: 'lee', state: 'left' },
    ];

    it('counts each person waiting to be let in, not one let back in who is still in', () => {
        expect(
            waitingOn({
                userId: me,
                manager: true,
                pending: [{ inFamily: false }, { inFamily: false }, { inFamily: true }],
                members,
                needsCheck: [],
            }),
        ).toBe(2);
    });

    it('adds the other active members a manager must check, never themselves or someone gone', () => {
        expect(
            waitingOn({
                userId: me,
                manager: true,
                pending: [{ inFamily: false }],
                members,
                needsCheck: ['maya', 'sam', 'lee', 'nobody'],
            }),
        ).toBe(2);
    });

    it('asks nothing of a member who does not manage the family', () => {
        expect(
            waitingOn({
                userId: me,
                manager: false,
                pending: [],
                members,
                needsCheck: ['sam', 'ana'],
            }),
        ).toBe(0);
    });

    it('is nothing once nobody waits', () => {
        expect(
            waitingOn({
                userId: me,
                manager: true,
                pending: [{ inFamily: true }],
                members,
                needsCheck: [],
            }),
        ).toBe(0);
    });
});
