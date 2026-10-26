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

    it('holds a mark only with every group key its roster is under, a later one allowed', () => {
        // A copy of a history with its successions taken out: the same rosters under fewer keys.
        const bare = (history: string) => ({ ...base.histories[history], successions: [] });
        const withBare = {
            ...base,
            histories: { ...base.histories, removalBare: bare('removal'), succBare: bare('succ') },
        };
        const holdsIn = (
            served: ReturnType<typeof chain>,
            from: ReturnType<typeof chain>,
            version: number,
        ) => sessionHoldsMark(withBare, served, { served: from, version });
        // removal's succession is tied at roster 5 (the roster that drops p3), so its pin at 5 is
        // under key 2: a chain without that succession does not hold it.
        expect(holdsIn(chain('removalBare', 5), chain('removal', 5), 5)).toBe(false);
        // The reverse: a mark under key 1 at 5, and a chain that adds the succession after it.
        expect(holdsIn(chain('removal', 5), chain('removalBare', 5), 5)).toBe(true);
        // succ's succession is tied at roster 2: the same at a mark there.
        expect(holdsIn(chain('succBare', 3), chain('succ', 2), 2)).toBe(false);
        expect(holdsIn(chain('succ', 3), chain('succBare', 2), 2)).toBe(true);
        // Below the roster a succession is tied at, it is not the mark's to hold.
        expect(holdsIn(chain('removalBare', 5), chain('removal', 4), 4)).toBe(true);
    });
});
