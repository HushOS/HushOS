import { describe, expect, test } from 'vitest';
import { onStage, REPLAY_SHOWN } from './stage';

const seen = (isIntersecting: boolean, intersectionRatio: number) => ({
    isIntersecting,
    intersectionRatio,
});

describe('onStage', () => {
    test('a replaying scene plays only once a quarter of it shows', () => {
        expect(REPLAY_SHOWN).toBe(0.25);
        expect(onStage('replay', seen(true, 0.25))).toBe(true);
        expect(onStage('replay', seen(true, 1))).toBe(true);
        // A sliver at the edge of the screen is away: it stops, goes back to its start, and
        // plays again from the start when it comes back in.
        expect(onStage('replay', seen(true, 0.24))).toBe(false);
        expect(onStage('replay', seen(true, 0))).toBe(false);
    });

    test('nothing off screen counts as on it, whatever its last ratio', () => {
        expect(onStage('replay', seen(false, 0.5))).toBe(false);
        expect(onStage('once', seen(false, 0.5))).toBe(false);
    });

    test('the kit’s own modes keep starting on the first pixel', () => {
        expect(onStage('once', seen(true, 0.01))).toBe(true);
        expect(onStage('loop', seen(true, 0.01))).toBe(true);
    });
});
