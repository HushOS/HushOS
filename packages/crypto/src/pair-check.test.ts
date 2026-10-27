import { describe, expect, test } from 'vitest';
import { nextGuardEntry } from './first-seen';
import { acceptRosters, joinCode, pairCodeOf, type AcceptedRosters } from './group-trust';
import { rosterDigest } from './groups';
import { history, mlDsaKeysOf, person, servedKeysOf, succeed, type Person } from './group-testkit';
import { encode } from './keys';
import { keyCommitment, pinKeysOfServed, pinTrust } from './pins';
import { pairCode, pairMatch, type SignedStatementWire } from './session-groups';

/*
 * The family check (docs/optional-verification.md 3.4): the pair code two
 * members compare, worked out over a chain each device accepted, and what a
 * match writes. The Rust core's join.rs tests are the twin; the shared
 * fixtures (`pairCodes` in the roster-call documents, the pair-mark cases in
 * the group cases) hold the two to each other.
 */

const CHECKED = '2026-10-18T12:00:00.000Z';
const wires = (h: { rosters: { statement: Uint8Array }[] }) =>
    h.rosters.map((at) => ({ statement: encode(at.statement) }) as SignedStatementWire);
const meOf = (who: Person) => ({ userId: who.userId, identities: [servedKeysOf(who)] });

/* Roster 2 lets in persons 2 and 3 together, roster 3 person 4; `third` is person 3's entry on roster 3. */
async function family(third?: (p: Person[]) => Promise<ReturnType<Person['entry']>>) {
    const p = (await Promise.all([1, 2, 3, 4].map((n) => person(n)))) as Person[];
    const owner = p[0]!.entry(['billing', 'members']);
    const h = await history();
    await h.roster(p[0]!, [owner]);
    await h.roster(p[0]!, [owner, p[1]!.entry([]), p[2]!.entry([])]);
    const moved = third ? await third(p) : p[2]!.entry([]);
    await h.roster(p[0]!, [owner, p[1]!.entry([]), moved, p[3]!.entry([])]);
    const chainAs = async (who: Person, people: Person[] = p): Promise<AcceptedRosters> => {
        const chain = await acceptRosters({
            groupId: h.groupId,
            firstKeys: h.keys[0]!.publicKey,
            anchor: 'created',
            pins: [],
            rosters: [...h.rosters],
            successions: [],
            mlDsaKeys: mlDsaKeysOf(...people),
            me: meOf(who),
            cache: null,
        });
        if (chain.status !== 'accepted') throw new Error('accepted');
        return chain;
    };
    const words = async (version: number, a: Person, b: Person) =>
        pairCodeOf(
            await rosterDigest(h.rosters[version - 1]!.statement),
            h.keys[0]!.publicKey,
            1,
            a.userId,
            b.userId,
        );
    const code = async (me: Person, other: Person) =>
        pairCode(await chainAs(me), meOf(me), other.userId, wires(h));
    return { p, h, chainAs, words, code };
}

describe('the pair code', () => {
    test('is the roster of the later admission of the two, the same words from either side', async () => {
        const { p, words, code } = await family();
        const [p1, p2, p3, p4] = p as [Person, Person, Person, Person];
        expect(await code(p2, p3)).toEqual({
            status: 'code',
            rosterVersion: 2,
            code: await words(2, p2, p3),
        });
        expect(await code(p3, p2)).toEqual(await code(p2, p3));
        expect(await code(p2, p4)).toEqual({
            status: 'code',
            rosterVersion: 3,
            code: await words(3, p2, p4),
        });
        expect(await code(p1, p2)).toMatchObject({ status: 'code', rosterVersion: 2 });
        const outsider = await person(5);
        expect(await code(p2, outsider)).toEqual({ status: 'not-admitted' });
        await expect(code(p2, p2)).rejects.toThrow(/between two members/);
    });

    test('gives every pair over one roster its own words, so a relabelled entry gets other words', async () => {
        const { p, h, words } = await family();
        const [p1, p2, p3, p4] = p as [Person, Person, Person, Person];
        // A↔B and A↔C over roster 3: a server labelling person 4's entry as person 3 has person 2's
        // device work out 2↔4 while person 3's works out 2↔3.
        expect(await words(3, p2, p3)).not.toEqual(await words(3, p2, p4));
        expect(await words(3, p1, p3)).not.toEqual(await words(3, p1, p4));
        expect(await words(3, p2, p3)).toEqual(await words(3, p3, p2));
        // Its own domain: never the roster's join code.
        const join = await joinCode(
            await rosterDigest(h.rosters[1]!.statement),
            h.keys[0]!.publicKey,
            1,
        );
        expect(await words(2, p2, p3)).not.toEqual(join);
    });

    test('is not shown on a device whose own entry was wrong at that roster', async () => {
        const [p1, p2, p3, server] = (await Promise.all([1, 2, 3, 9].map((n) => person(n)))) as [
            Person,
            Person,
            Person,
            Person,
        ];
        const planted = await person(9, 1, { userId: p2.userId });
        const owner = p1.entry(['billing', 'members']);
        const h = await history();
        await h.roster(p1, [owner]);
        await h.roster(p1, [owner, planted.entry([])]);
        await h.roster(p1, [owner, p2.entry([]), p3.entry([])]);
        const chainAs = async (who: Person) => {
            const chain = await acceptRosters({
                groupId: h.groupId,
                firstKeys: h.keys[0]!.publicKey,
                anchor: 'created',
                pins: [],
                rosters: [...h.rosters],
                successions: [],
                mlDsaKeys: mlDsaKeysOf(p1, p2, p3, server),
                me: meOf(who),
                cache: null,
            });
            if (chain.status !== 'accepted') throw new Error('accepted');
            return chain;
        };
        const mine = await chainAs(p2);
        expect(mine.ownEntryWrongAt).toEqual([2]);
        expect(await pairCode(mine, meOf(p2), p1.userId, wires(h))).toEqual({
            status: 'own-entry-wrong',
            rosterVersion: 2,
        });
        // Only where it was wrong: with person 3, at roster 3, its entry is its own.
        expect(await pairCode(mine, meOf(p2), p3.userId, wires(h))).toMatchObject({
            status: 'code',
            rosterVersion: 3,
        });
        expect(await pairCode(await chainAs(p1), meOf(p1), p2.userId, wires(h))).toMatchObject({
            status: 'code',
            rosterVersion: 2,
        });
    });
});

describe('a pair match', () => {
    async function matchOf(
        f: Awaited<ReturnType<typeof family>>,
        over: Partial<Parameters<typeof pairMatch>[0]> = {},
    ) {
        const [, p2, p3] = f.p as [Person, Person, Person];
        const shown = await f.code(p2, p3);
        if (shown.status !== 'code') throw new Error('a code');
        return pairMatch({
            chain: await f.chainAs(p2),
            me: meOf(p2),
            otherUserId: p3.userId,
            rosters: wires(f.h),
            rosterVersion: shown.rosterVersion,
            code: shown.code,
            guard: null,
            settingsPin: null,
            checkedAt: CHECKED,
            ...over,
        });
    }
    const guardOf = async (who: Person) =>
        nextGuardEntry(null, await pinKeysOfServed(who.served, 'seen'));

    test('writes a verified pin only over the keys the compared entry, the guard or the settings pin hold', async () => {
        const f = await family();
        const [, p2, p3] = f.p as [Person, Person, Person];
        const other = await person(9);
        const matched = await matchOf(f);
        expect(matched.check).toEqual({
            rosterVersion: 2,
            with: p3.userId,
            code: await f.words(2, p2, p3),
            checkedAt: CHECKED,
        });
        expect(await pinTrust(matched.pin!)).toBe('verified');
        expect(await keyCommitment(matched.pin!)).toBe(
            await keyCommitment(await pinKeysOfServed(p3.served, 'seen')),
        );
        // Words that are not this device's code, or the code of another roster: nothing.
        const wrong = [...matched.check!.code];
        wrong[0] = wrong[0] === 'abandon' ? 'ability' : 'abandon';
        expect(await matchOf(f, { code: wrong })).toEqual({ check: null, pin: null });
        expect(await matchOf(f, { rosterVersion: 3 })).toEqual({ check: null, pin: null });
        // A guard of these keys keeps the pin; of other keys, or unreadable, no pin, the check kept.
        expect((await matchOf(f, { guard: await guardOf(p3) })).pin).not.toBeNull();
        for (const guard of [await guardOf(other), 'unreadable' as const]) {
            const stopped = await matchOf(f, { guard });
            expect([stopped.check !== null, stopped.pin]).toEqual([true, null]);
        }
        // No guard: the settings pin decides.
        const pinOf = async (who: Person) => pinKeysOfServed(who.served, 'seen');
        expect((await matchOf(f, { settingsPin: await pinOf(p3) })).pin).not.toBeNull();
        const stale = await matchOf(f, { settingsPin: await pinOf(other) });
        expect([stale.check !== null, stale.pin]).toEqual([true, null]);
        // A newer guard entry over a stale settings pin: the guard's keys are the ones held.
        expect(
            (await matchOf(f, { settingsPin: await pinOf(other), guard: await guardOf(p3) })).pin,
        ).not.toBeNull();
    });

    test('of a member whose keys moved since the compared roster checks the family and writes no pin', async () => {
        // A handover (a fold-in to their next identity), or keys put in without a chain (a Continue).
        const handover = await family(async (p) => (await succeed(p[2]!)).next.entry([]));
        const putIn = await family(async (p) =>
            (await person(9, 1, { userId: p[2]!.userId })).entry([]),
        );
        const moved = [
            (await succeed(await person(3))).next,
            await person(9, 1, { userId: (await person(3)).userId }),
        ];
        for (const [index, f] of [handover, putIn].entries()) {
            const [, p2, p3] = f.p as [Person, Person, Person];
            expect(await f.code(p2, p3)).toMatchObject({ status: 'code', rosterVersion: 2 });
            // With the pin of their earlier keys, with no pin at all, and with a pin already moved to
            // the new keys (a Continue on this device): the words compared vouch for none of it.
            for (const settingsPin of [
                await pinKeysOfServed(p3.served, 'seen'),
                null,
                await pinKeysOfServed(moved[index]!.served, 'seen'),
            ]) {
                const matched = await matchOf(f, { settingsPin });
                expect(matched.check).not.toBeNull();
                expect(matched.pin).toBeNull();
            }
        }
    });
});
