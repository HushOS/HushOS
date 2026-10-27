import { describe, expect, test } from 'vitest';
import { checkGroupName, GROUP_NAME_MAX } from './protocol';

describe('checkGroupName (the server’s rule for a family’s name)', () => {
    test('stores a name trimmed and composed', () => {
        expect(checkGroupName('  Ortega family ')).toBe('Ortega family');
        expect(checkGroupName('José family')).toBe('José family');
    });

    test('refuses what would print badly in an invitation email: controls and invisible marks', () => {
        for (const name of ['Sam\tOrtega', 'مهر‌انگیز', '‫سارا‬', '👨‍👩'])
            expect(checkGroupName(name)).toBeNull();
    });

    test('takes 1 to 100 characters, counted as code points', () => {
        expect(checkGroupName('   ')).toBeNull();
        expect(checkGroupName('👍'.repeat(GROUP_NAME_MAX))).toBe('👍'.repeat(GROUP_NAME_MAX));
        expect(checkGroupName('a'.repeat(GROUP_NAME_MAX + 1))).toBeNull();
    });
});
