import { describe, expect, test } from 'vitest';
import { errorCopy, refusalCopy, wrongWordsCopy } from './copy';

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

describe('a place an admission could not have', () => {
    test('while the bank holds an upgrade, says the plan change comes first, not another place', () => {
        const line = refusalCopy('seats', { reason: 'upgrade-waiting' }, { family: 'Lindqvist' });
        expect(line).toBe('Confirm the plan change with your bank first, then let them in.');
        expect(line).not.toMatch(/another place/);
    });
});

describe('a request the client gave up on', () => {
    test('is said in the app’s words, never the browser’s', () => {
        // Chromium's AbortSignal.timeout, then Safari's and Firefox's, then one whose name alone says it.
        const timedOut = [
            new DOMException('signal timed out', 'TimeoutError'),
            new Error('The operation timed out.'),
            Object.assign(new Error('Request aborted'), { name: 'TimeoutError' }),
        ];
        for (const error of timedOut)
            expect(errorCopy(error)).toBe('HushOS’s server took too long to answer.');
        // Anything else the worker or the server said is still said as it was.
        expect(errorCopy(new Error('Open the family’s folders first, then try again.'))).toBe(
            'Open the family’s folders first, then try again.',
        );
    });
});
