import { describe, expect, test } from 'vitest';
import { GroupApiError } from './api';
import { errorCopy } from './copy';

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

describe('a payer’s leave or removal while a change to the plan is under way', () => {
    test('says to try again in a moment, not to reload', () => {
        const busy = new GroupApiError('Another change…', 409, 'busy', undefined);
        expect(errorCopy(busy, { family: 'The Lindqvists' })).toBe(
            'Another change to this plan is in progress. Try again in a moment.',
        );
    });
});
