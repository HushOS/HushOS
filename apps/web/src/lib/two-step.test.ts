import { describe, expect, test } from 'vitest';
import { backupCodesText, codesLeft, groupSecret, usedOn } from './two-step';

/*
 * What a person copies off the screen when they turn two-step sign-in on. The setup key is
 * typed into an authenticator app by hand and the backup codes file is often the only copy
 * of codes shown once, so a dropped character or a missing code locks someone out later.
 */
describe('the setup key, for typing by hand', () => {
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

    test('is the whole secret in fours, nothing dropped or reordered', () => {
        const shown = groupSecret(secret);
        expect(shown).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
        expect(shown.replaceAll(' ', '')).toBe(secret);
    });

    test('keeps a last group shorter than four', () => {
        expect(groupSecret('JBSWY3DPEH')).toBe('JBSW Y3DP EH');
        expect(groupSecret('')).toBe('');
    });
});

describe('the backup codes file', () => {
    const codes = [
        '7KQ2M-9XD4P',
        'A1B2C-3D4E5',
        'F6G7H-8J9K0',
        'M1N2P-3Q4R5',
        'S6T7V-8W9X0',
        'Y1Z2A-3B4C5',
        'D6E7F-8G9H0',
        'J1K2M-3N4P5',
        'Q6R7S-8T9V0',
        'W1X2Y-3Z4A5',
    ];
    const text = backupCodesText(
        { email: 'maya@example.com' },
        codes,
        'drive.example.org',
        new Date('2026-11-10T09:30:00Z'),
    );

    test('holds every code once, in the order shown, numbered so the tenth lines up', () => {
        const listed = text.split('\n').filter((line) => /^\s?\d+\. /.test(line));
        expect(listed).toEqual([
            ' 1. 7KQ2M-9XD4P',
            ' 2. A1B2C-3D4E5',
            ' 3. F6G7H-8J9K0',
            ' 4. M1N2P-3Q4R5',
            ' 5. S6T7V-8W9X0',
            ' 6. Y1Z2A-3B4C5',
            ' 7. D6E7F-8G9H0',
            ' 8. J1K2M-3N4P5',
            ' 9. Q6R7S-8T9V0',
            '10. W1X2Y-3Z4A5',
        ]);
    });

    test('says which account and which HushOS they open, and when they were made', () => {
        expect(text).toContain('Account:  maya@example.com');
        expect(text).toContain('Server:   drive.example.org');
        expect(text).toContain('Saved 2026-11-10');
        expect(text.startsWith('HushOS backup codes\n')).toBe(true);
    });
});

describe('how many backup codes are left', () => {
    test('counts in words a person reads, down to none', () => {
        expect(codesLeft(10)).toBe('10 backup codes left');
        expect(codesLeft(1)).toBe('1 backup code left');
        expect(codesLeft(0)).toBe('No backup codes left');
    });
});

/*
 * The server rounds a method's last use to the day, in UTC. Read as a moment in the browser's
 * own timezone, a code used a minute ago showed as "yesterday" east of Greenwich in the small
 * hours, and as a day late west of it.
 */
describe('when a method was last used', () => {
    // 05:07 on 10 November in India, 23:37 on the 9th in UTC: the server's day is the 9th.
    const now = new Date('2026-11-09T23:37:00Z');

    test('a use the server dates today is today, whatever the browser’s own date is', () => {
        expect(usedOn('2026-11-09T00:00:00.000Z', now)).toBe('today');
    });

    test('reads the Date the API client makes of it as it reads the server’s string', () => {
        expect(usedOn(new Date('2026-11-09T00:00:00.000Z'), now)).toBe('today');
        expect(usedOn(new Date('2026-11-01T00:00:00.000Z'), now)).toBe('1 Nov');
        expect(usedOn('not a date', now)).toBe('');
    });

    test('the day before is yesterday, and earlier days are named by the server’s date', () => {
        expect(usedOn('2026-11-08T00:00:00.000Z', now)).toBe('yesterday');
        expect(usedOn('2026-11-01T00:00:00.000Z', now)).toBe('1 Nov');
        expect(usedOn('2025-12-31T00:00:00.000Z', now)).toBe('31 Dec 2025');
    });
});
