import { mkdir, writeFile } from 'node:fs/promises';
import type { AcceptInput } from '../src/group-trust';
import {
    areaGrantContext,
    groupFingerprint,
    groupKeySealContext,
    sealAreaGrant,
    sealGroupKey,
    type AreaGrantContext,
    type GroupKeySealContext,
    type SignedGroupStatement,
} from '../src/groups';
import {
    AREA,
    AREA_SEED,
    GROUP,
    acceptedOf,
    chainCases,
    statementCases,
    statementVerdict,
    foldInCases,
    foldInVerdict,
    groupCases,
    history,
    says,
    verdictOf,
    pattern,
    person,
    sealCases,
    sealVerdict,
    sealerCases,
    sealerVerdict,
    succeed,
    type Person,
} from '../src/group-testkit';
import { deriveId, type GroupIdKind } from '../src/ids';
import { verifySuccessionChain } from '../src/identity';
import { encode } from '../src/keys';
import { metadataStatement, signStatement } from '../src/signatures';

/*
 * The group statements, signatures, seals and verdicts as the web makes them,
 * for the Rust core to rebuild byte for byte, open and judge the same way
 * (crates/hushos-core/tests/web_group_fixtures.rs). Every key comes from a
 * fixed seed both twins derive the same way (group-testkit.ts,
 * tests/common/groups.rs), so the core checks its own key derivation against
 * these too; signatures and seals use fresh randomness and differ on every
 * run. Regenerate with `bun run fixtures:groups` at the repository root.
 */

const [organizer, adult, holder, child] = (await Promise.all(
    [1, 2, 3, 4].map((n) => person(n)),
)) as [Person, Person, Person, Person];

const signed = (statement: SignedGroupStatement) => ({
    statement: encode(statement.statement),
    signature: {
        ed25519: encode(statement.signature.ed25519),
        mlDsa: encode(statement.signature.mlDsa),
    },
    signerSignature: encode(statement.signerSignature),
});

// The family's history: created (1), a second holder admitted (2), the holder leaves (3), the
// key replaced (1 -> 2, tied to 3), the organizer signs on under the new key (4).
const h = await history();
const owner = organizer.entry(['billing', 'guardian', 'members']);
const members = [owner, adult.entry([]), child.entry([])];
await h.roster(organizer, members);
await h.roster(organizer, [...members, holder.entry(['members'])]);
await h.roster(organizer, [...members, holder.entry(['members'], 3, 'left')]);
await h.succession(organizer);
await h.roster(organizer, [...members, holder.entry(['members'], 3, 'left')]);
const chain = await acceptedOf(h, [organizer, adult, holder, child]);

// The two seals of milestone 1: the group key (version 2) to its holder, the area's key to the
// adult.
const groupSeed = pattern(64, 92);
const keySealCtx: GroupKeySealContext = {
    groupId: GROUP,
    groupKeyVersion: 2,
    holderUserId: organizer.userId,
    holderKeyVersion: 1,
    sealerUserId: organizer.userId,
    rosterVersion: chain.roster.rosterVersion,
    rosterDigest: chain.rosterDigest,
};
const workspaceKey = pattern(32, 77);
const grantCtx: AreaGrantContext = {
    groupId: GROUP,
    workspaceId: AREA,
    // Version 1, which roster 1 lists: an earlier version still grants (the removal at 3
    // rotated the area to 2).
    workspaceKeyVersion: 1,
    granteeUserId: adult.userId,
    granteeKeyVersion: 1,
    granterUserId: organizer.userId,
    rosterVersion: chain.roster.rosterVersion,
    rosterDigest: chain.rosterDigest,
};
const seals = {
    keySeal: {
        ctx: keySealCtx,
        seed: encode(groupSeed),
        associatedData: encode(groupKeySealContext(keySealCtx)),
        envelope: encode(
            await sealGroupKey(groupSeed, keySealCtx, {
                chain,
                holderKemPublicKey: organizer.kemPublicKey,
                sealer: organizer.signer,
            }),
        ),
    },
    areaGrant: {
        ctx: grantCtx,
        areaIdSeed: AREA_SEED,
        workspaceKey: encode(workspaceKey),
        associatedData: encode(areaGrantContext(grantCtx)),
        envelope: encode(
            await sealAreaGrant(workspaceKey, grantCtx, {
                chain,
                areaIdSeed: AREA_SEED,
                granteeKemPublicKey: adult.kemPublicKey,
                granter: organizer.signer,
            }),
        ),
    },
};

// Records in the area: by an active member (verified via the group) and by the former holder.
const record = {
    workspaceId: AREA,
    nodeId: '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e',
    kind: 'file' as const,
    metadataVersion: 1,
};
const envelope = pattern(96, 5);
const recordBy = async (who: Person, verdict: string) => ({
    writerUserId: who.userId,
    signature: encode(
        await signStatement(await metadataStatement(record, envelope), who.signer.signingKey),
    ),
    verdict,
});
const verdicts = {
    statement: record,
    envelope: encode(envelope),
    records: [await recordBy(adult, 'verified'), await recordBy(holder, 'former-member')],
};

// Group and area ids: fixed seeds and scopes, known answers both twins derive.
const ids = [];
for (const [k, kind] of (['group', 'workspace'] as GroupIdKind[]).entries())
    for (const [s, scopeId] of [organizer.userId, GROUP].entries()) {
        const seed = encode(pattern(16, 40 + k * 2 + s));
        ids.push({ kind, scopeId, seed, id: await deriveId(kind, scopeId, seed) });
    }

// Histories the core must judge as the web does: forks, refusals, the entry rules, the cache and
// records read through the chain.
const inputJson = (input: AcceptInput) => ({
    firstKeys: input.firstKeys,
    firstKeysChecked: input.firstKeysChecked,
    pins: input.pins,
    rosters: input.rosters.map(signed),
    successions: input.successions.map(signed),
    mlDsaKeys: input.mlDsaKeys,
    me: input.me,
    cache: input.cache,
    joinMark: input.joinMark ?? null,
});
const cases = [];
for (const { name, input, record, next, expected } of await groupCases()) {
    // The web's own verdict first: a case the web misjudges is not written. The full verdict
    // (history, cache, own entry, key digest, the record's and the rest) is what the core must match.
    const verdict = await verdictOf(input, record, next);
    if (!says(verdict, expected))
        throw new Error(`${name}: the web says ${JSON.stringify(verdict)}`);
    cases.push({
        name,
        input: {
            ...inputJson(input),
            record: record ?? null,
            next: next
                ? {
                      roster: next.roster ? signed(next.roster) : null,
                      succession: next.succession ? signed(next.succession) : null,
                      identities: next.identities,
                  }
                : null,
        },
        expected: verdict,
    });
}
// A key seal the adult made while a holder, before their next identity was folded in.
const folded = await (async () => {
    const { next: adult2, link } = await succeed(adult);
    const fh = await history();
    await fh.roster(organizer, [owner, adult.entry(['members'])]);
    const before = await acceptedOf(fh, [organizer, adult]);
    const ctx: GroupKeySealContext = {
        groupId: GROUP,
        groupKeyVersion: 1,
        holderUserId: organizer.userId,
        holderKeyVersion: 1,
        sealerUserId: adult.userId,
        rosterVersion: before.roster.rosterVersion,
        rosterDigest: before.rosterDigest,
    };
    const seed = pattern(64, 91);
    const envelope = await sealGroupKey(seed, ctx, {
        chain: before,
        holderKemPublicKey: organizer.kemPublicKey,
        sealer: adult.signer,
    });
    await fh.roster(organizer, [owner, adult2.entry(['members'])]);
    return {
        rosters: fh.rosters.map(signed),
        ctx,
        seed: encode(seed),
        envelope: encode(envelope),
        links: [link],
    };
})();
// Seals the core must open, or refuse, as the web does.
const sealed = [];
for (const c of await sealCases()) {
    const verdict = await sealVerdict(c);
    if (verdict !== c.expected) throw new Error(`${c.name}: the web says ${verdict}`);
    sealed.push({ ...c, rosters: c.rosters.map(signed), envelope: encode(c.envelope) });
}
const sealers = [];
for (const c of await sealerCases()) {
    const verdict = await sealerVerdict(c);
    if (verdict !== c.expected) throw new Error(`${c.name}: the web says ${verdict}`);
    sealers.push({ ...c, rosters: c.rosters.map(signed) });
}
// The shipped strict verifier for personal pins, unchanged by the group code.
const chains = [];
for (const c of await chainCases()) {
    const verdict = await verifySuccessionChain(c.userId, c.pinned, c.served, c.links);
    if (verdict !== c.expected) throw new Error(`${c.name}: the web says ${verdict}`);
    chains.push(c);
}
// The statement grammar both twins parse alike.
const statements = statementCases().map((c) => {
    if (statementVerdict(c.statement) !== c.expected)
        throw new Error(`${c.name}: the web disagrees`);
    return c;
});
// Which entries fold in: a forged link changes nothing; a genuine one on its version 2 signature
// alone does (r9: fold-in walks from the entry's keys, where consent buys nothing).
const folds: Record<string, boolean> = {
    'two-ahead': true,
    'forged-link': false,
    'one-sided-link': true,
    'inflated-version': true,
};
const foldIns = [];
for (const c of await foldInCases()) {
    const expected = await foldInVerdict(c);
    if (expected.changed !== folds[c.name]) throw new Error(`${c.name}: the web folds it wrongly`);
    foldIns.push({ ...c, expected });
}

const out = new URL('../../../crates/hushos-core/fixtures/', import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(
    new URL('web-groups.json', out),
    JSON.stringify(
        {
            generatedBy: 'packages/crypto/scripts/group-fixtures.ts',
            groupId: GROUP,
            people: [organizer, adult, holder, child].map((who) => ({
                n: who.n,
                userId: who.userId,
                seeds: who.seeds,
                served: who.served,
            })),
            groupKeys: h.keys.map((key, index) => ({
                seed: encode(pattern(64, 91 + index)),
                ...key.publicKey,
            })),
            fingerprint: await groupFingerprint(GROUP, h.keys[0]!.publicKey),
            rosters: h.rosters.map((statement, index) => ({
                roster: h.statements[index],
                ...signed(statement),
            })),
            successions: h.successions.map(signed),
            accepted: {
                rosterVersion: chain.roster.rosterVersion,
                rosterDigest: chain.rosterDigest,
                groupKeyVersion: chain.groupKeyVersion,
                groupKeyDigest: chain.groupKeyDigest,
                creatorUserId: chain.creatorUserId,
                successionDue: chain.successionDue,
            },
            seals,
            verdicts,
            ids,
            cases,
            foldIns,
            foldedSealer: folded,
            sealCases: sealed,
            sealerCases: sealers,
            chainCases: chains,
            statementCases: statements,
        },
        null,
        2,
    ) + '\n',
);
console.log('wrote crates/hushos-core/fixtures/web-groups.json');
