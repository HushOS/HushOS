import { describe, expect, it } from 'vitest';
import { coreJoin } from './fixtures';
import { sessionHoldsMark } from './verdicts';

/*
 * The oracles the fuzz kinds hold both twins to, against the fixtures: an
 * oracle that judges a correct acceptance wrong fails every run, one that
 * judges a wrong one right finds nothing. The core's twin is the test in
 * crates/hushos-core/fuzz/src/targets.rs.
 */
describe('the join session oracle', () => {
    const base = coreJoin().joinPreviews;
    const chain = (history: string, through: number) => ({ history, through, cut: null });
    const holds = (
        served: ReturnType<typeof chain>,
        from: ReturnType<typeof chain>,
        version: number,
    ) => sessionHoldsMark(base, served, { served: from, version });

    it('holds a mark by its statements and the successions below it, never their signatures', () => {
        // removalFork re-signs removal's first three rosters (ML-DSA signs at random): the same chain through 3.
        expect(holds(chain('removalFork', 4), chain('removal', 3), 3)).toBe(true);
        // succOther has succ's rosters through 3 but another succession below 3: not that chain.
        expect(holds(chain('succOther', 3), chain('succ', 3), 3)).toBe(false);
        // Made-up first keys, and a chain short of the mark, never hold it.
        expect(holds(chain('madeUp', 3), chain('main', 2), 2)).toBe(false);
        expect(holds(chain('main', 1), chain('main', 2), 2)).toBe(false);
        expect(holds(chain('main', 5), chain('main', 2), 2)).toBe(true);
    });
});
