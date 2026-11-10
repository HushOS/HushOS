import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { companyCases, type CompanyCase } from './company-testkit';
import { CryptoError } from './errors';
import { acceptRosters, type AcceptInput, type AcceptedRosters } from './group-trust';
import { activeWith, isOwner, rosterDigest } from './groups';

/*
 * A company's acceptance over histories nobody wrote by hand: the rule
 * histories of company-testkit.ts with rosters dropped, repeated, reordered
 * or borrowed from other cases, kit signatures stripped or moved, and
 * successions borrowed. Whatever acceptance then takes, the chain it returns
 * keeps what docs/groups-invariants.md I17 to I25 promise of every company
 * chain; anything else is refused with a CryptoError, and the same input
 * gives the same answer twice.
 */

let cases: CompanyCase[];
beforeAll(async () => {
    cases = await companyCases();
}, 120_000);

const change = fc.oneof(
    fc.tuple(fc.constant('drop-roster'), fc.nat(), fc.nat()),
    fc.tuple(fc.constant('repeat-roster'), fc.nat(), fc.nat()),
    fc.tuple(fc.constant('swap-rosters'), fc.nat(), fc.nat()),
    fc.tuple(fc.constant('borrow-roster'), fc.nat(), fc.nat()),
    fc.tuple(fc.constant('borrow-succession'), fc.nat(), fc.nat()),
    fc.tuple(fc.constant('strip-kit-signature'), fc.nat(), fc.nat()),
    fc.tuple(fc.constant('borrow-kit-signature'), fc.nat(), fc.nat()),
);
const history = fc.tuple(fc.nat(), fc.array(change, { maxLength: 4 }));

function inputOf([at, changes]: [number, [string, number, number][]]): AcceptInput {
    const from = cases[at % cases.length]!.input;
    const input = { ...from, rosters: [...from.rosters], successions: [...from.successions] };
    for (const [kind, a, b] of changes) {
        const other = cases[a % cases.length]!.input;
        const { rosters, successions } = input;
        const i = rosters.length ? a % rosters.length : -1;
        if (kind === 'drop-roster' && i >= 0) rosters.splice(i, 1);
        if (kind === 'repeat-roster' && i >= 0) rosters.splice(i, 0, rosters[i]!);
        if (kind === 'swap-rosters' && i >= 0) {
            const j = b % rosters.length;
            [rosters[i], rosters[j]] = [rosters[j]!, rosters[i]!];
        }
        if (kind === 'borrow-roster' && other.rosters.length)
            rosters.push(other.rosters[b % other.rosters.length]!);
        if (kind === 'borrow-succession' && other.successions.length)
            successions.push(other.successions[b % other.successions.length]!);
        if (kind === 'strip-kit-signature' && i >= 0) {
            const { kitSignature: _, ...bare } = rosters[i]!;
            rosters[i] = bare;
        }
        if (kind === 'borrow-kit-signature' && i >= 0) {
            const lender = other.rosters.find((roster) => roster.kitSignature);
            if (lender) rosters[i] = { ...rosters[i]!, kitSignature: lender.kitSignature };
        }
    }
    return input;
}

async function accept(input: AcceptInput) {
    try {
        const chain = await acceptRosters(input);
        return chain.status === 'accepted' ? chain : null;
    } catch (error) {
        if (error instanceof CryptoError) return null;
        throw error;
    }
}

const SETS = [
    '',
    'billing',
    'recovery',
    'billing,recovery',
    'data_admin,members',
    'billing,data_admin,members,recovery',
];

/* What every accepted company chain keeps, whatever history it was accepted from. */
async function holds(chain: AcceptedRosters, input: AcceptInput) {
    const { roster } = chain;
    if (chain.kind !== 'org') {
        // A family's chain carries nothing of a company's.
        expect(chain.org).toBeNull();
        expect(chain.recoveries).toEqual([]);
        expect(roster.format).not.toBe(3);
        return;
    }
    const org = chain.org!;
    expect(roster.format).toBe(3);
    // I21: one of the six role sets, none once left, and an Owner.
    for (const entry of roster.members) {
        expect(SETS).toContain(entry.roles.join());
        if (entry.status === 'left') expect(entry.roles).toEqual([]);
        // `members` and `data_admin` come together: whoever signs rosters holds the company key.
        expect(activeWith(entry, 'members')).toBe(activeWith(entry, 'data_admin'));
    }
    expect(roster.members.some(isOwner)).toBe(true);
    // I19: one company key and one kit per version, each new, each introduced in order; and a
    // new kit always comes with a new company key (I20).
    const custody = roster.custody!;
    expect(org.custodyKeys).toHaveLength(custody.custodyKeyVersion);
    expect(org.kitKeys).toHaveLength(custody.kitVersion);
    for (const keys of [org.custodyKeys, org.kitKeys]) {
        expect(new Set(keys.map((at) => at.encryptionPublicKey)).size).toBe(keys.length);
        expect(new Set(keys.map((at) => at.kemPublicKeyDigest)).size).toBe(keys.length);
        const versions = keys.map((at) => at.rosterVersion);
        expect(versions).toEqual([...versions].sort((x, y) => x - y));
        expect(new Set(versions).size).toBe(versions.length);
        expect(versions[0]).toBe(1);
    }
    expect(new Set(org.kitKeys.map((at) => at.signingPublicKey)).size).toBe(org.kitKeys.length);
    const replacedAt = new Set(org.custodyKeys.map((at) => at.rosterVersion));
    for (const kit of org.kitKeys) expect(replacedAt.has(kit.rosterVersion)).toBe(true);
    // Who holds `data_admin` now is who has an open span, and nobody else.
    for (const entry of roster.members) {
        const spans = org.dataAdmins[entry.userId] ?? [];
        expect(spans.at(-1)?.until === null).toBe(activeWith(entry, 'data_admin'));
    }
    // I25: the heads count the live areas, each with a kind and a list for every key version.
    const live = Object.keys(chain.areaKeys).filter((id) => !chain.retiredAreas.includes(id));
    expect(roster.heads!.areaCount).toBe(live.length);
    for (const [id, keys] of Object.entries(chain.areaKeys)) {
        expect(['employee', 'shared']).toContain(org.areaKinds[id]);
        expect(org.areaLists[id]).toHaveLength(keys.length);
        expect(org.areaRosters[id]).toHaveLength(keys.length);
    }
    // I24: a day's count never passes what any roster's rules could allow.
    if (org.lastAuto) expect(org.lastAuto.countThatDay).toBeLessThanOrEqual(50);
    // I23: every recovery on the chain was served with a kit signature, at that very roster.
    expect(chain.recoveries).toEqual(org.recoveries);
    for (const recovery of chain.recoveries) {
        const digest = chain.rosterDigests[recovery.rosterVersion - 1];
        const served = [];
        for (const signed of input.rosters)
            if ((await rosterDigest(signed.statement)) === digest) served.push(signed);
        expect(served.some((signed) => signed.kitSignature?.length === 3373)).toBe(true);
        expect(recovery.rosterVersion).toBeGreaterThan(1);
    }
}

describe('a company’s acceptance, over generated histories', () => {
    it('refuses only with a CryptoError, answers alike twice, and every chain it accepts keeps the company invariants', async () => {
        let accepted = 0;
        await fc.assert(
            fc.asyncProperty(history, async (generated) => {
                const input = inputOf(generated);
                const chain = await accept(input);
                const again = await accept(inputOf(generated));
                expect(again?.rosterDigest ?? null).toBe(chain?.rosterDigest ?? null);
                if (!chain) return;
                accepted++;
                await holds(chain, input);
                // What it accepted continues from its own cache to the same chain.
                expect(chain.cache.rosterDigests.at(-1)).toBe(chain.rosterDigest);
            }),
            { numRuns: 80 },
        );
        // The generator is not vacuous: a fair share of what it writes is accepted.
        expect(accepted).toBeGreaterThan(15);
    }, 240_000);

    it('every unchanged rule history, accepted, keeps them too', async () => {
        for (const c of cases) {
            const chain = await accept(c.input);
            expect(chain !== null, c.name).toBe(c.expected.status === 'accepted');
            if (chain) await holds(chain, c.input);
        }
    }, 240_000);
});
