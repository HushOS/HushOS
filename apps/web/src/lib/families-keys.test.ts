import { describe, expect, test } from 'vitest';
import { familiesSyncQueryOptions } from './families';
import { familiesSyncAllKey } from './families-keys';

/*
 * The drive shell runs the families pass under a key of its own, so it never
 * loads the families layer. If it drifted from the families pages' key the
 * shell and the pages would sync twice, and a change on one would not refresh
 * the other.
 */
describe('families query keys', () => {
    test('the shell’s key is the families pages’ key', () => {
        const user = 'a0000000-0000-4000-8000-000000000001';
        expect(familiesSyncAllKey(user)).toEqual(familiesSyncQueryOptions(user).queryKey);
    });
});
