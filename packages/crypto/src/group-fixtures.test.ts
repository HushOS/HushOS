import { describe, expect, it } from 'vitest';
import {
    acceptRosters,
    type AcceptInput,
    type JoinMark,
    type GroupChainCache,
    type ServedIdentity,
    groupIntegrityOf,
    groupWriterTrust,
    type AcceptedRosters,
} from './group-trust';
import {
    areaGrantStatement,
    groupFingerprint,
    groupKeyPair,
    groupKeySealStatement,
    groupSuccessionStatement,
    openAreaGrant,
    openGroupKey,
    parseGroupSuccession,
    parseRoster,
    rosterDigest,
    rosterStatement,
    verifyGroup,
    type GroupPublicKey,
    type Roster,
    type SignedGroupStatement,
} from './groups';
import {
    GROUP,
    AREA,
    READER,
    foldInVerdict,
    groupCases,
    mlDsaKeysOf,
    pattern,
    person,
    sealCases,
    chainCases,
    statementCases,
    statementVerdict,
    sealVerdict,
    sealerCases,
    sealerVerdict,
    succeed,
    verdictOf,
    type SealCase,
    type SealerCase,
    type Person,
    type RecordProbe,
} from './group-testkit';
import type { SuccessionLink } from './identity';
import type { GroupPin } from './pins';
import { checkId, deriveId, type GroupIdKind } from './ids';
import { verifyIdentityKeys, verifySuccessionChain } from './identity';
import { decode, encode } from './keys';
import { metadataStatements } from './signatures';
import core from './__fixtures__/core-groups.json';

/*
 * The group statements, signatures and seals the Rust core made
 * (crates/hushos-core/examples/group_fixtures.rs) must rebuild here byte for
 * byte, verify, and open; the other direction is
 * crates/hushos-core/tests/web_group_fixtures.rs. Both derive every key from
 * the same seeds, so each also checks the other's key derivation. Regenerate
 * with `bun run fixtures` at the repository root.
 */

type Served = {
    statement: string;
    signature: { ed25519: string; mlDsa: string };
    signerSignature: string;
};
const signed = (value: Served): SignedGroupStatement => ({
    statement: decode(value.statement),
    signature: { ed25519: decode(value.signature.ed25519), mlDsa: decode(value.signature.mlDsa) },
    signerSignature: decode(value.signerSignature),
});
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
/* A seal's associated data: its statement with the final digest removed. */
const withoutDigest = (statement: Uint8Array) =>
    new TextEncoder().encode(
        JSON.stringify((JSON.parse(text(statement)) as unknown[]).slice(0, -1)),
    );

async function people() {
    return (await Promise.all([1, 2, 3, 4].map((n) => person(n)))) as [
        Person,
        Person,
        Person,
        Person,
    ];
}

async function accepted() {
    const all = await people();
    const chain = await acceptRosters({
        groupId: GROUP,
        firstKeys: {
            ed25519PublicKey: core.groupKeys[0]!.ed25519PublicKey,
            mlDsaPublicKey: core.groupKeys[0]!.mlDsaPublicKey,
        },
        rosters: core.rosters.map(signed),
        successions: core.successions.map(signed),
        ...READER,
        mlDsaKeys: mlDsaKeysOf(...all),
    });
    if (chain.status !== 'accepted')
        throw new Error(`the core's history forked at ${chain.version}`);
    return chain as AcceptedRosters;
}

describe('group records made by the Rust core', () => {
    it('derives every person’s keys from the same seeds, and their keys statements hold', async () => {
        const all = await people();
        for (const [index, theirs] of core.people.entries()) {
            const made = all[index]!;
            expect(theirs.userId).toBe(made.userId);
            const { keysSignature, ...keys } = theirs.served;
            const { keysSignature: _, ...ours } = made.served;
            expect(keys).toEqual(ours);
            expect(await verifyIdentityKeys(made.userId, theirs.served)).toBe(true);
            expect(await verifyIdentityKeys(all[(index + 1) % 4]!.userId, theirs.served)).toBe(
                false,
            );
            expect(keysSignature).not.toBe(made.served.keysSignature);
        }
    });

    it('has the same group keys and fingerprint', async () => {
        for (const [index, key] of core.groupKeys.entries()) {
            expect(decode(key.seed)).toEqual(pattern(64, 91 + index));
            const derived = await groupKeyPair(decode(key.seed));
            expect(derived.publicKey).toEqual({
                ed25519PublicKey: key.ed25519PublicKey,
                mlDsaPublicKey: key.mlDsaPublicKey,
            });
        }
        expect(await groupFingerprint(GROUP, (await groupKeyPair(pattern(64, 91))).publicKey)).toBe(
            core.fingerprint,
        );
    });

    it('rebuilds every roster and succession to the core’s bytes', async () => {
        let previous: Uint8Array | null = null;
        for (const served of core.rosters) {
            const statement = decode(served.statement);
            const roster = served.roster as Roster;
            expect(rosterStatement(roster)).toEqual(statement);
            expect(parseRoster(statement)).toEqual(roster);
            expect(roster.previousRosterDigest).toBe(previous ? await rosterDigest(previous) : '');
            previous = statement;
        }
        const keys = await Promise.all(
            [91, 92].map(async (seed) => (await groupKeyPair(pattern(64, seed))).publicKey),
        );
        for (const served of core.successions) {
            const statement = decode(served.statement);
            const succession = parseGroupSuccession(statement);
            expect(groupSuccessionStatement(succession)).toEqual(statement);
            expect(succession.oldEd25519PublicKey).toBe(keys[0]!.ed25519PublicKey);
            expect(succession.newMlDsaPublicKey).toBe(keys[1]!.mlDsaPublicKey);
            expect(await verifyGroup(statement, signed(served).signature, keys[0]!)).toBe(true);
            expect(await verifyGroup(statement, signed(served).signature, keys[1]!)).toBe(false);
        }
    });

    it('accepts the core’s history as the core accepted it, and needs both halves of its group signatures', async () => {
        const chain = await accepted();
        expect(chain.roster.rosterVersion).toBe(core.accepted.rosterVersion);
        expect(chain.rosterDigest).toBe(core.accepted.rosterDigest);
        expect(chain.groupKeyVersion).toBe(core.accepted.groupKeyVersion);
        expect(chain.creatorUserId).toBe(core.accepted.creatorUserId);
        expect(chain.successionDue).toBe(core.accepted.successionDue);
        const rosters = core.rosters.map(signed);
        rosters[1]!.signature.mlDsa[7]! ^= 1;
        await expect(
            acceptRosters({
                groupId: GROUP,
                firstKeys: chain.groupKeys[0]!,
                rosters,
                successions: core.successions.map(signed),
                ...READER,
                mlDsaKeys: mlDsaKeysOf(...(await people())),
            }),
        ).rejects.toThrow('not signed by the group key');
    });

    it('opens the core’s seals, whose associated data is the statement without its digest', async () => {
        const [organizer, adult] = await people();
        const chain = await accepted();
        const { keySeal, areaGrant } = core.seals;
        const signedPart = (envelope: Uint8Array) => envelope.subarray(0, envelope.length - 3373);

        const keyEnvelope = decode(keySeal.envelope);
        expect(keyEnvelope).toHaveLength(4597);
        expect(
            withoutDigest(await groupKeySealStatement(keySeal.ctx, signedPart(keyEnvelope))),
        ).toEqual(decode(keySeal.associatedData));
        const options = {
            chain,
            sealerMlDsaPublicKey: organizer.mlDsaPublicKey,
            reader: { userId: organizer.userId, keyVersion: 1 },
            holder: organizer.secrets,
        };
        expect(encode(await openGroupKey(keyEnvelope, keySeal.ctx, options))).toBe(keySeal.seed);
        // Read as key version 1's seal (another context), it is not even signed for that.
        await expect(
            openGroupKey(keyEnvelope, { ...keySeal.ctx, groupKeyVersion: 1 }, options),
        ).rejects.toThrow('not sealed by a member who holds it');

        const grantEnvelope = decode(areaGrant.envelope);
        expect(
            withoutDigest(await areaGrantStatement(areaGrant.ctx, signedPart(grantEnvelope))),
        ).toEqual(decode(areaGrant.associatedData));
        const grantOptions = {
            chain,
            areaIdSeed: areaGrant.areaIdSeed,
            granterMlDsaPublicKey: organizer.mlDsaPublicKey,
            reader: { userId: adult.userId, keyVersion: 1 },
            grantee: adult.secrets,
        };
        expect(encode(await openAreaGrant(grantEnvelope, areaGrant.ctx, grantOptions))).toBe(
            areaGrant.workspaceKey,
        );
    });

    it('reads records in the area as the core read them', async () => {
        const chain = await accepted();
        const { verdicts } = core;
        const statement = { ...verdicts.statement, kind: 'file' as const };
        for (const record of verdicts.records) {
            const trust = await groupWriterTrust({
                groupId: GROUP,
                areas: { [AREA]: 1 },
                reading: { status: 'accepted', chain },
                workspaceId: AREA,
                writerUserId: record.writerUserId,
                pinned: null,
                served: null,
                links: [],
            });
            const verdict = await groupIntegrityOf(
                () => metadataStatements(statement, decode(verdicts.envelope)),
                decode(record.signature),
                trust,
                null,
            );
            expect(verdict).toEqual(
                record.verdict === 'verified'
                    ? { integrity: 'verified', via: GROUP }
                    : { integrity: 'former-member', via: null },
            );
        }
    });

    it('derives the core’s group and area ids', async () => {
        expect(core.ids).toHaveLength(4);
        for (const entry of core.ids) {
            expect(await deriveId(entry.kind as GroupIdKind, entry.scopeId, entry.seed)).toBe(
                entry.id,
            );
            expect(
                await checkId(entry.kind as GroupIdKind, entry.scopeId, entry.seed, entry.id),
            ).toBe(entry.id);
        }
    });

    it('judges the core’s histories as the core did: forks, refusals, the cache and records', async () => {
        expect(core.cases.map((entry) => entry.name)).toEqual(
            (await groupCases()).map((entry) => entry.name),
        );
        for (const { name, input, expected } of core.cases as unknown as {
            name: string;
            input: {
                firstKeys: GroupPublicKey;
                pins: GroupPin[];
                rosters: Served[];
                successions: Served[];
                mlDsaKeys: Record<string, string>;
                me: AcceptInput['me'];
                cache: GroupChainCache | null;
                firstKeysChecked: boolean;
                record: RecordProbe | null;
                joinMark?: JoinMark | null;
                next: {
                    roster: Served | null;
                    succession: Served | null;
                    identities: Record<string, ServedIdentity[]> | null;
                } | null;
            };
            expected: Record<string, unknown>;
        }[]) {
            const verdict = await verdictOf(
                {
                    groupId: GROUP,
                    firstKeys: input.firstKeys,
                    pins: input.pins,
                    rosters: input.rosters.map(signed),
                    successions: input.successions.map(signed),
                    mlDsaKeys: input.mlDsaKeys,
                    me: input.me,
                    cache: input.cache,
                    firstKeysChecked: input.firstKeysChecked,
                    joinMark: input.joinMark ?? null,
                },
                input.record ?? undefined,
                input.next
                    ? {
                          roster: input.next.roster ? signed(input.next.roster) : null,
                          succession: input.next.succession ? signed(input.next.succession) : null,
                          identities: input.next.identities,
                      }
                    : undefined,
            );
            expect(verdict, name).toEqual(expected);
        }
    }, 30_000);

    it('folds in the core’s entries as the core did', async () => {
        expect(core.foldIns.map((entry) => entry.name)).toEqual([
            'two-ahead',
            'forged-link',
            'one-sided-link',
            'inflated-version',
        ]);
        for (const entry of core.foldIns as unknown as {
            name: string;
            entry: Roster['members'][number];
            served: ServedIdentity;
            links: SuccessionLink[];
            rosterVersion: number;
            expected: unknown;
        }[])
            expect(await foldInVerdict(entry), entry.name).toEqual(entry.expected);
    });

    it('opens, or refuses, the core’s seal cases as the core did', async () => {
        expect(core.sealCases.map((c) => c.name)).toEqual((await sealCases()).map((c) => c.name));
        for (const c of core.sealCases as unknown as (Omit<SealCase, 'rosters' | 'envelope'> & {
            rosters: Parameters<typeof signed>[0][];
            envelope: string;
        })[])
            expect(
                await sealVerdict({
                    ...c,
                    rosters: c.rosters.map(signed),
                    envelope: decode(c.envelope),
                }),
                c.name,
            ).toBe(c.expected);
    }, 30_000);

    it('seals, or refuses to seal, the core’s sealer cases as the core did', async () => {
        expect(core.sealerCases.map((c) => c.name)).toEqual(
            (await sealerCases()).map((c) => c.name),
        );
        for (const c of core.sealerCases as unknown as (Omit<SealerCase, 'rosters'> & {
            rosters: Parameters<typeof signed>[0][];
        })[])
            expect(await sealerVerdict({ ...c, rosters: c.rosters.map(signed) }), c.name).toBe(
                c.expected,
            );
    }, 30_000);

    it('verifies, or refuses, the core’s personal-pin chains as the core did', async () => {
        expect(core.chainCases.map((c) => c.name)).toEqual((await chainCases()).map((c) => c.name));
        for (const c of core.chainCases as unknown as Awaited<ReturnType<typeof chainCases>>)
            expect(await verifySuccessionChain(c.userId, c.pinned, c.served, c.links), c.name).toBe(
                c.expected,
            );
    });

    it('parses, or refuses, the core’s raw statements as the core did', () => {
        expect(core.statementCases.map((c) => c.name)).toEqual(statementCases().map((c) => c.name));
        for (const c of core.statementCases)
            expect(statementVerdict(c.statement), c.name).toBe(c.expected);
    });

    it('opens the core’s seal from before the sealer’s identity was folded in, through their chain', async () => {
        const [organizer, adult] = await people();
        const { next: adult2 } = await succeed(adult!);
        const folded = core.foldedSealer;
        const chain = await acceptRosters({
            groupId: GROUP,
            firstKeys: (await groupKeyPair(pattern(64, 91))).publicKey,
            rosters: folded.rosters.map(signed),
            successions: [],
            ...READER,
            mlDsaKeys: mlDsaKeysOf(organizer!, adult!),
        });
        if (chain.status !== 'accepted') throw new Error('the core’s history forked');
        const open = (sealerHistory: { served: ServedIdentity; links: SuccessionLink[] } | null) =>
            openGroupKey(decode(folded.envelope), folded.ctx, {
                chain,
                sealerMlDsaPublicKey: adult2.mlDsaPublicKey,
                sealerHistory,
                reader: { userId: organizer!.userId, keyVersion: 1 },
                holder: organizer!.secrets,
            });
        expect(encode(await open({ served: adult2.served, links: folded.links }))).toBe(
            folded.seed,
        );
        await expect(open(null)).rejects.toThrow('not sealed by a member who holds it');
    });
});
