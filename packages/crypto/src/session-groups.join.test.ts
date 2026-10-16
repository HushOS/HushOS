import { describe, expect, test } from 'vitest';
import { acceptRosters, joinCode } from './group-trust';
import { rosterDigest } from './groups';
import { acceptedOf, history, inputOf, person, type Person } from './group-testkit';
import { encode } from './keys';
import { admittedAt, codeAt, type SignedStatementWire } from './session-groups';

/*
 * The join code both screens show (codeAt, from the roster that admitted a
 * person, admittedAt) against acceptance's own rule for a join mark: if the
 * two counted group keys differently, both screens would agree and the
 * newcomer's acceptance would fork, so every family admitting someone after
 * a key change could never be joined. Checked at every roster of a history
 * with a succession tied to an admitting roster (the `<` boundary: that
 * roster is the last under the old key), an admission under the new key, a
 * removal, and a re-admission.
 */

describe('the join code at every group key version', () => {
    test('codeAt and admittedAt agree with acceptance across a succession and a re-admission', async () => {
        const [organizer, adult, holder, child] = (await Promise.all(
            [1, 2, 3, 4].map((n) => person(n)),
        )) as [Person, Person, Person, Person];
        const people = [organizer, adult, holder, child];
        const owner = organizer.entry(['billing', 'guardian', 'members']);
        const h = await history();
        // 1: the organizer and the adult. 2: the holder admitted, and a succession tied to 2.
        await h.roster(organizer, [owner, adult.entry(['members'])]);
        await h.roster(organizer, [owner, adult.entry(['members']), holder.entry([])]);
        await h.succession(organizer);
        // 3: the child admitted under key 2. 4: the holder removed. 5: the holder let in again.
        await h.roster(
            adult,
            [owner, adult.entry(['members']), holder.entry([]), child.entry([])],
            2,
        );
        const left = { ...holder.entry([]), status: 'left' as const };
        await h.roster(adult, [owner, adult.entry(['members']), left, child.entry([])], 2);
        await h.roster(
            adult,
            [owner, adult.entry(['members']), holder.entry([]), child.entry([])],
            2,
        );
        const chain = await acceptedOf(h, people);
        const rosters = h.rosters.map(
            (at) => ({ statement: encode(at.statement) }) as SignedStatementWire,
        );
        const admitted = async (who: Person) =>
            admittedAt(chain.rosterDigests, rosters, who.userId);
        expect(await admitted(adult)).toBe(1);
        expect(await admitted(holder)).toBe(5);
        expect(await admitted(child)).toBe(3);

        // The tie: roster 2 is the last under key 1, so its code names key 1.
        expect(await codeAt(chain, 2)).toEqual(
            await joinCode(await rosterDigest(h.rosters[1]!.statement), h.keys[0]!.publicKey, 1),
        );
        expect(await codeAt(chain, 3)).toEqual(
            await joinCode(await rosterDigest(h.rosters[2]!.statement), h.keys[1]!.publicKey, 2),
        );
        // At every version, acceptance takes the code both screens show.
        for (let version = 1; version <= 5; version++) {
            const code = await codeAt(chain, version);
            await expect(
                acceptRosters(inputOf(h, people, { joinMark: { rosterVersion: version, code } })),
            ).resolves.toMatchObject({ status: 'accepted' });
        }
    });

    test('a roster missing from the run, or a head without the person, gives no admitting roster', async () => {
        const [organizer, adult, child] = (await Promise.all([1, 2, 4].map((n) => person(n)))) as [
            Person,
            Person,
            Person,
        ];
        const owner = organizer.entry(['billing', 'guardian', 'members']);
        const h = await history();
        await h.roster(organizer, [owner, adult.entry([])]);
        await h.roster(organizer, [owner, adult.entry([]), child.entry([])]);
        await h.roster(organizer, [owner, adult.entry(['members']), child.entry([])]);
        const chain = await acceptedOf(h, [organizer, adult, child]);
        const wires = h.rosters.map(
            (at) => ({ statement: encode(at.statement) }) as SignedStatementWire,
        );
        // Later role changes keep the admitting roster.
        expect(await admittedAt(chain.rosterDigests, wires, child.userId)).toBe(2);
        // Not on the head: not admitted.
        expect(
            await admittedAt(chain.rosterDigests, wires, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
        ).toBeNull();
        // A roster of the run left out: refused, never a later admitting roster.
        await expect(
            admittedAt(chain.rosterDigests, [wires[0]!, wires[2]!], child.userId),
        ).rejects.toThrow(/left out part/);
        // Junk and rosters off the chain beside them change nothing.
        expect(
            await admittedAt(
                chain.rosterDigests,
                [{ statement: 'junk' } as SignedStatementWire, ...wires],
                child.userId,
            ),
        ).toBe(2);
    });
});
