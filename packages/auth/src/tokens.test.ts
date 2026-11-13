import { twoStepRepository } from '@hushos/db';
import { describe, expect, test } from 'vitest';
import { SESSION_IDLE_SECONDS, SESSION_MAX_SECONDS } from './tokens';

/*
 * A replacement session is told apart by its length: `getSession` never slides the deadline
 * of a session written to end within REPLACEMENT_SESSION_SECONDS of its creation. An ordinary
 * session is written to end one idle lifetime after its creation, so the idle lifetime must be
 * longer than that, or every ordinary session would be taken for a replacement, never slide,
 * and end after its first idle lifetime however much it was used.
 */
describe('session lifetimes', () => {
    test('an ordinary session outlasts a replacement session by far, so the two are never confused', () => {
        expect(twoStepRepository.REPLACEMENT_SESSION_SECONDS).toBe(10 * 60);
        expect(SESSION_IDLE_SECONDS).toBeGreaterThan(
            10 * twoStepRepository.REPLACEMENT_SESSION_SECONDS,
        );
        expect(SESSION_MAX_SECONDS).toBeGreaterThan(SESSION_IDLE_SECONDS);
    });
});
