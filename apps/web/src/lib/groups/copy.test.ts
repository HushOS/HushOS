import { describe, expect, test } from 'vitest';
import { wrongWordsCopy } from './copy';

describe('the hidden words typed wrong', () => {
    test('are said calmly, naming neither word and never a different member list', () => {
        const line = wrongWordsCopy('Maya');
        expect(line).toBe(
            'One of the words doesn’t match. Ask Maya to read them again. If they still don’t match, choose They don’t match.',
        );
        // A number would tell a guesser which word to keep and which to change.
        expect(line).not.toMatch(/\d/);
        expect(line).not.toMatch(/member list|Don’t use/);
    });
});
