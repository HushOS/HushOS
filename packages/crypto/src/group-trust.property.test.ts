import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CryptoError } from './errors';
import {
    acceptRosters,
    type AcceptedRosters,
    type AcceptInput,
    type GroupAnchor,
    type GroupChainCache,
} from './group-trust';
import { GROUP, READER, mlDsaKeysOf, person, verdictOf, type Person } from './group-testkit';
import { openAreaGrant, openGroupKey, parseRoster, type SignedGroupStatement } from './groups';
import type { ServedKeys } from './identity';
import { decode, encode } from './keys';
import type { GroupPin } from './pins';
import core from './__fixtures__/core-groups.json';

/*
 * Acceptance and the two group seals over histories nobody wrote by hand:
 * the shared fixture cases (core-groups.json) with signed parts dropped,
 * repeated, reordered or borrowed from other cases, and marks (pins, cache,
 * the reader) swapped. Acceptance refuses with a CryptoError and nothing
 * else, is a function of what it is given (the same history twice gives the
 * same verdict, whatever was verified before), and an accepted chain caches
 * the roster it ends at. A seal opens only as it was sealed.
 */

type Served = {
    statement: string;
    signature: { ed25519: string; mlDsa: string };
    signerSignature: string;
};
type Case = (typeof core.cases)[number]['input'];

const signed = (value: Served): SignedGroupStatement => ({
    statement: decode(value.statement),
    signature: { ed25519: decode(value.signature.ed25519), mlDsa: decode(value.signature.mlDsa) },
    signerSignature: decode(value.signerSignature),
});

function inputOf(c: Case): AcceptInput {
    return {
        groupId: GROUP,
        firstKeys: c.firstKeys,
        anchor: ((c as { anchor?: GroupAnchor | null }).anchor ?? null) as GroupAnchor | null,
        pins: c.pins as unknown as GroupPin[],
        rosters: (c.rosters as Served[]).map(signed),
        successions: (c.successions as Served[]).map(signed),
        mlDsaKeys: c.mlDsaKeys as unknown as Record<string, string>,
        me: c.me as { userId: string; identities: ServedKeys[] },
        cache: c.cache as unknown as GroupChainCache | null,
        joinMark: (c.joinMark as AcceptInput['joinMark']) ?? null,
    };
}

const cases = core.cases.map((c) => c.input as Case);
const pick = fc.nat(cases.length - 1);

/* One change to a served history; indices wrap around whatever list they land in. */
const change = fc.oneof(
    fc.tuple(fc.constant('drop-roster'), fc.nat(), fc.nat()),
    fc.tuple(fc.constant('repeat-roster'), fc.nat(), fc.nat()),
    fc.tuple(fc.constant('swap-rosters'), fc.nat(), fc.nat()),
    fc.tuple(fc.constant('borrow-roster'), pick, fc.nat()),
    fc.tuple(fc.constant('drop-succession'), fc.nat(), fc.nat()),
    fc.tuple(fc.constant('borrow-succession'), pick, fc.nat()),
    fc.tuple(fc.constant('borrow-pins'), pick, fc.nat()),
    fc.tuple(fc.constant('borrow-cache'), pick, fc.nat()),
    fc.tuple(fc.constant('borrow-reader'), pick, fc.nat()),
);

const history = fc.tuple(pick, fc.array(change, { maxLength: 4 })).map(([at, changes]) => {
    const input = inputOf(cases[at]!);
    for (const [kind, a, b] of changes) {
        const other = inputOf(cases[a % cases.length]!);
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
        if (kind === 'drop-succession' && successions.length)
            successions.splice(a % successions.length, 1);
        if (kind === 'borrow-succession' && other.successions.length)
            successions.push(other.successions[b % other.successions.length]!);
        if (kind === 'borrow-pins') input.pins = other.pins;
        if (kind === 'borrow-cache') input.cache = other.cache;
        if (kind === 'borrow-reader') input.me = other.me;
    }
    return input;
});

describe('acceptance, over generated histories', () => {
    it('refuses only with a CryptoError, gives the same verdict twice, and caches the roster it ends at', async () => {
        await fc.assert(
            fc.asyncProperty(history, async (input) => {
                // verdictOf rethrows anything but a CryptoError.
                const first = await verdictOf(input);
                expect(await verdictOf(structuredClone(input))).toEqual(first);
                if (first.status === 'accepted') {
                    const cache = first.cache as { statement: string };
                    expect(parseRoster(decode(cache.statement)).rosterVersion).toBe(
                        first.rosterVersion,
                    );
                }
            }),
            { numRuns: 40 },
        );
    }, 120_000);
});

describe('group seals, over changed envelopes', () => {
    let people: Person[];
    let chain: AcceptedRosters;

    async function setUp() {
        people ??= await Promise.all([1, 2, 3, 4].map((n) => person(n)));
        if (!chain) {
            const accepted = await acceptRosters({
                groupId: GROUP,
                firstKeys: core.groupKeys[0]!,
                rosters: core.rosters.map(signed),
                successions: core.successions.map(signed),
                ...READER,
                mlDsaKeys: mlDsaKeysOf(...people),
            });
            chain = accepted as AcceptedRosters;
        }
    }

    const flips = fc.array(fc.tuple(fc.nat(), fc.integer({ min: 1, max: 255 })), { maxLength: 2 });
    function flipped(envelope: Uint8Array, changes: [number, number][]) {
        const out = Uint8Array.from(envelope);
        for (const [at, mask] of changes) out[at % out.length]! ^= mask;
        return out;
    }
    async function opened(open: () => Promise<Uint8Array>) {
        try {
            return encode(await open());
        } catch (error) {
            if (error instanceof CryptoError) return null;
            throw error;
        }
    }

    it('open a key seal or a grant to what was sealed when untouched, and refuse any change with a CryptoError', async () => {
        await setUp();
        const [organizer, adult] = people;
        const { keySeal, areaGrant } = core.seals;
        await fc.assert(
            fc.asyncProperty(fc.boolean(), flips, async (grant, changes) => {
                const envelope = flipped(
                    decode(grant ? areaGrant.envelope : keySeal.envelope),
                    changes,
                );
                const touched =
                    encode(envelope) !== (grant ? areaGrant.envelope : keySeal.envelope);
                const result = await opened(() =>
                    grant
                        ? openAreaGrant(envelope, areaGrant.ctx, {
                              chain,
                              areaIdSeed: areaGrant.areaIdSeed,
                              granterMlDsaPublicKey: organizer!.mlDsaPublicKey,
                              reader: { userId: adult!.userId, keyVersion: 1 },
                              grantee: adult!.secrets,
                          })
                        : openGroupKey(envelope, keySeal.ctx, {
                              chain,
                              sealerMlDsaPublicKey: organizer!.mlDsaPublicKey,
                              reader: { userId: organizer!.userId, keyVersion: 1 },
                              holder: organizer!.secrets,
                          }),
                );
                expect(result).toBe(touched ? null : grant ? areaGrant.workspaceKey : keySeal.seed);
            }),
            { numRuns: 40 },
        );
    }, 120_000);
});
