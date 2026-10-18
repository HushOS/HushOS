import type * as Db from '@hushos/db';
import { afterAll, beforeEach, expect, test, vi } from 'vitest';

/*
 * Route 1's answer when the one-family index refuses a creation (another
 * family took the creator after every check) and, by the time the route reads
 * which family that was, the creator has left it too. Nothing names a family
 * then, so the route says try again (503), never a 500 from a missing name.
 * The index race that leads here is real in server.test.ts ("one family per
 * account under races"); this pins only the last branch, which no lock
 * ordering can reach on demand: the repository's createGroup answers as the
 * index made it, and the creator is in no family when asked again.
 */
const answered = { familyOf: 0 };
vi.mock('@hushos/db', async (original) => {
    const real = await original<typeof Db>();
    return {
        ...real,
        groupsRepository: {
            ...real.groupsRepository,
            createGroup: async () => ({ status: 'in-family' as const, family: null }),
            familyOf: async (userId: string) => {
                answered.familyOf += 1;
                return real.groupsRepository.familyOf(userId);
            },
        },
    };
});

const { closeDatabase, resetDatabase } = await import('../../db/test/helpers');
const kit = await import('../test/kit');
const groups = await import('./server');

beforeEach(resetDatabase);
afterAll(closeDatabase);

test('a creation the index refused, from someone in no family by the time it is asked, is 503 unavailable', async () => {
    const sam = await kit.member();
    const { body } = await kit.familyBody(sam);
    const refusal = await groups.createGroup(sam.userId, body).then(
        () => null,
        (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(groups.GroupError);
    expect(refusal).toMatchObject({ code: 'unavailable', status: 503 });
    // Asked twice: before anything was checked, and again after the refusal.
    expect(answered.familyOf).toBe(2);
});
