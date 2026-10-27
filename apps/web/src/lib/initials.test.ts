import { describe, expect, test } from 'vitest';
import { initialsOf } from './initials';

/*
 * One person must look the same in every avatar. The family page once fed "Lisa (you)" to
 * the old rule and drew "L(" where the account menu drew "L".
 */
describe('initialsOf', () => {
    test('an aside in brackets and punctuation are never initials', () => {
        expect(initialsOf('Lisa (you)')).toBe('L');
        expect(initialsOf('Maya Lindqvist (you)')).toBe('ML');
        expect(initialsOf('Maya (Mai) Lindqvist')).toBe('ML');
        expect(initialsOf('"Jo" - Park')).toBe('JP');
        // All there is: the aside is the name.
        expect(initialsOf('(Sam)')).toBe('S');
    });

    test('emoji are skipped while there is a letter, and shown whole when there is none', () => {
        expect(initialsOf('🌻 Maya')).toBe('M');
        expect(initialsOf('Maya 🌻')).toBe('M');
        expect(initialsOf('👨‍👩‍👧')).toBe('👨‍👩‍👧');
    });

    test('a single name gives one initial; only the first two words count', () => {
        expect(initialsOf('Cher')).toBe('C');
        expect(initialsOf('  maya  ')).toBe('M');
        expect(initialsOf('Maya Anna Lindqvist')).toBe('MA');
    });

    test('non-Latin and accented letters are taken whole', () => {
        expect(initialsOf('李小龙')).toBe('李');
        expect(initialsOf('Анна Петрова')).toBe('АП');
        expect(initialsOf('山田 太郎')).toBe('山太');
        // "É" written as E plus a combining accent stays one initial, accent included.
        expect(initialsOf('Émile Zola')).toBe('ÉZ');
        expect(initialsOf('ömer')).toBe('Ö');
    });

    test('an empty name is a question mark', () => {
        expect(initialsOf('')).toBe('?');
        expect(initialsOf('   ')).toBe('?');
    });
});
