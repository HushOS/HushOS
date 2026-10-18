import { describe, expect, test } from 'vitest';
import { KEY_CHANGE_PENDING } from '@hushos/crypto/protocol';
import { driveError } from './drive';
import { errorCopy } from './groups/copy';
import { KEY_CHANGE_WAIT } from './key-change-words';

// The worker's other "keys changed" sentence: a different next step (reload), never the wait.
const KEYS_CHANGED = 'This folder’s keys changed. Reload to continue.';

describe('a write the worker holds back for a key change', () => {
    test.each([
        ['Drive actions (new folder, rename, move, copy)', driveError],
        ['the families pages', errorCopy],
    ])('reads as a short wait with a next step in %s', (_, words) => {
        const line = words(new Error(KEY_CHANGE_PENDING));
        expect(line).toBe(
            'HushOS is finishing a key change for this folder. Try again in a moment.',
        );
        expect(line).not.toContain(KEY_CHANGE_PENDING);
    });

    test.each([driveError, errorCopy])(
        'leaves every other worker sentence as it is, the reload one included',
        (words) => {
            expect(words(new Error(KEYS_CHANGED))).toBe(KEYS_CHANGED);
            // Matched exactly: a sentence that only starts like the refusal is not the wait.
            expect(words(new Error(`${KEY_CHANGE_PENDING} Reload.`))).not.toBe(KEY_CHANGE_WAIT);
        },
    );
});
