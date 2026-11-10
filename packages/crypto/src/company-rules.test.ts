import { carriedHeads } from './area-lists';
import { unverifiedHeads } from './committed-heads';
import { describe, expect, test } from 'vitest';
import {
    companyCases,
    companyCast,
    companyInput,
    companyStart,
    refusalOf,
    withEntry,
    type Company,
} from './company-testkit';
import { CryptoError } from './errors';
import {
    ADMIN_ROLES,
    AREA,
    HEADS_DIGEST,
    OWNER_ROLES,
    areaKeyAt,
    custodyAt,
    kitAt,
    listDigestAt,
    rootKeyAt,
    succeed,
} from './group-testkit';
import {
    acceptRosters,
    checkNextRoster,
    checkNextSuccession,
    foldInEntry,
    nextRoster,
    type AcceptedRosters,
    type GroupChainCache,
} from './group-trust';
import {
    parseRoster,
    rosterEntry,
    rosterMembersDigest,
    rosterStatement,
    signRecoveryRoster,
    signRoster,
    type GroupRole,
    type RosterMember,
} from './groups';

/*
 * A company's acceptance rules (docs/companies-design.md 2.1): every history
 * of company-testkit.ts judged as it declares, each refusal by the rule it
 * names; then what the chain keeps of a company, its cache, and nextRoster,
 * which builds only what acceptance takes.
 */

/* The four key fields of an entry: what a holder writes when it writes keys into another's. */
function keysOf(entry: RosterMember) {
    return {
        encryptionPublicKey: entry.encryptionPublicKey,
        signingPublicKey: entry.signingPublicKey,
        mlDsaPublicKeyDigest: entry.mlDsaPublicKeyDigest,
        kemPublicKeyDigest: entry.kemPublicKeyDigest,
    };
}

async function accepted(c: Company, over: Parameters<typeof companyInput>[2] = {}) {
    const chain = await acceptRosters(await companyInput(c.h, c.cast, over));
    if (chain.status !== 'accepted') throw new Error('not accepted');
    return chain;
}

describe('a company’s histories', async () => {
    const cases = await companyCases();

    /* What acceptance itself said of each history: the refusal's own words, or the version accepted. */
    const said = new Map<string, string | number>();

    test.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
        const outcome = await acceptRosters(c.input).then(
            (chain) => (chain as AcceptedRosters).roster.rosterVersion,
            (error: unknown) => {
                if (!(error instanceof CryptoError)) throw error;
                return error.message;
            },
        );
        said.set(c.name, outcome);
        if (c.expected.status === 'accepted') expect(outcome).toBe(c.expected.rosterVersion);
        else expect(outcome).toBe(refusalOf(c) ?? outcome);
        expect(typeof outcome).toBe(c.expected.status === 'accepted' ? 'number' : 'string');
    });

    test('acceptance itself gave every company refusal at least once, and accepted a fair share', () => {
        // From what acceptRosters threw above, not from the cases' own labels: each sentence of
        // companies-design 2.1 was the reason some history was refused.
        const refusals = new Set([...said.values()].filter((at) => typeof at === 'string'));
        for (const sentence of [
            'A roster that removes a data admin replaces the company key.',
            'A new recovery kit needs a new company key.',
            'Only an owner can change an owner, the recovery kit or its holders.',
            'Only an owner can replace the company’s keys.',
            'A roster that takes the recovery kit from someone replaces the kit.',
            'This is not one of a company’s roles.',
            'Someone who has left a company holds no role.',
            'A company keeps an active owner.',
            'The company’s keys do not follow from the member list before.',
            'This company key or recovery kit was used before: a new one is needed.',
            'A company’s member list changes at most 8 folder keys.',
            'This is not an automatic admission the company’s rules allow.',
            'This member list does not count the company’s folders.',
            'The recovery kit makes its holder an owner and changes nothing else.',
            'This member list is not signed with the company’s recovery kit.',
            'A company folder keeps the kind it was made with.',
            'Only an owner, or the member themselves, changes the keys of someone who signs member lists.',
            'Only a recovery roster carries the recovery kit’s signature.',
            'Invalid member list cache.',
        ])
            expect(refusals.has(sentence), sentence).toBe(true);
        expect([...said.values()].filter((at) => typeof at === 'number').length).toBeGreaterThan(
            40,
        );
        expect(said.size).toBe(cases.length);
    });
});

describe('what the chain keeps of a company', () => {
    test('every company key and kit with the roster and signer that introduced it, and who held data_admin when', async () => {
        const cast = await companyCast();
        const c = await companyStart(cast);
        // Roster 3: the Owner removes an Admin and replaces the key; 4: a new kit, with its key.
        const without = withEntry(c, { ...c.e.admin2, status: 'left', roles: [] });
        await c.h.roster(cast.owner, without, undefined, undefined, { custodyVersion: 2 });
        await c.h.succession(cast.owner);
        await c.h.roster(cast.second, without, undefined, undefined, {
            custodyVersion: 3,
            kitVersion: 2,
        });
        const chain = await accepted(c);
        const org = chain.org!;
        expect(org.custodyKeys.map((at) => [at.rosterVersion, at.signerUserId])).toEqual([
            [1, cast.owner.userId],
            [3, cast.owner.userId],
            [4, cast.second.userId],
        ]);
        expect(org.kitKeys.map((at) => [at.rosterVersion, at.signerUserId])).toEqual([
            [1, cast.owner.userId],
            [4, cast.second.userId],
        ]);
        expect(org.custodyKeys[2]!.encryptionPublicKey).toBe(
            (await custodyAt(3)).publicKey.encryptionPublicKey,
        );
        expect(org.dataAdmins[cast.owner.userId]).toEqual([{ from: 1, until: null }]);
        expect(org.dataAdmins[cast.admin2.userId]).toEqual([{ from: 2, until: 3 }]);
        expect(org.dataAdmins[cast.member.userId]).toBeUndefined();
        expect(org.areaKinds).toEqual({ [AREA]: 'shared' });
        expect(org.areaLists).toEqual({ [AREA]: [listDigestAt(AREA, 1)] });
        expect(org.areaRosters).toEqual({
            [AREA]: [{ rosterVersion: 1, signerUserId: cast.owner.userId }],
        });
        expect(chain.recoveries).toEqual([]);
        // A `same` roster's members are the list before, in place.
        expect(chain.roster.membersSame).toBeDefined();
        expect(chain.roster.members.map((entry) => entry.userId).sort()).toEqual(
            without.map((entry) => entry.userId).sort(),
        );
    });

    test('a recovery is recorded with its version and signer, and a family records none', async () => {
        const cast = await companyCast();
        const c = await companyStart(cast);
        await c.h.roster(
            cast.keeper,
            withEntry(c, { ...c.e.keeper, roles: [...OWNER_ROLES] }),
            undefined,
            [],
            { kit: 1 },
        );
        const chain = await accepted(c);
        expect(chain.recoveries).toEqual([{ rosterVersion: 3, signerUserId: cast.keeper.userId }]);
        expect(chain.org!.recoveries).toEqual(chain.recoveries);
    });

    test('the cache continues a company’s chain: `same`, the kit and an automatic count all carry over it', async () => {
        const cast = await companyCast();
        const c = await companyStart(cast);
        const on = { rules: { autoJoin: true, autoJoinDailyLimit: 5 } };
        await c.h.roster(cast.admin, c.all, undefined, undefined, on);
        const all = [...c.all, cast.newcomer.entry([])];
        await c.h.roster(cast.admin, all, undefined, undefined, {
            auto: { utcDay: '2026-11-10', countThatDay: 1 },
        });
        await c.h.roster(cast.admin, all);
        const five = await accepted(c);
        expect(five.cache.cacheVersion).toBe(4);
        expect(five.cache.org!.members).toHaveLength(all.length);
        const cache = structuredClone(five.cache) as GroupChainCache;
        // From the cache: a second automatic admission must count 2, and the kit still signs.
        const more = [...all, cast.another.entry([])];
        const repeat = await c.h.roster(cast.admin, more, undefined, undefined, {
            auto: { utcDay: '2026-11-10', countThatDay: 1 },
        });
        const input = await companyInput(c.h, cast);
        const from = (rosters: typeof input.rosters, over: Partial<GroupChainCache> = {}) =>
            acceptRosters({ ...input, anchor: null, rosters, cache: { ...cache, ...over } });
        await expect(from([repeat])).rejects.toThrow('automatic admission');
        c.h.rosters.pop();
        c.h.statements.pop();
        const follows = await c.h.roster(cast.admin, more, undefined, undefined, {
            auto: { utcDay: '2026-11-10', countThatDay: 2 },
        });
        expect((await from([follows])).status).toBe('accepted');
        const recovery = await c.h.roster(
            cast.keeper,
            more.map((entry) =>
                entry.userId === cast.keeper.userId ? { ...entry, roles: [...OWNER_ROLES] } : entry,
            ),
            undefined,
            [],
            { kit: 1 },
        );
        const seven = (await from([follows, recovery])) as AcceptedRosters;
        expect(seven.recoveries).toEqual([{ rosterVersion: 7, signerUserId: cast.keeper.userId }]);
        // A cache whose record was edited is refused, never continued from: other members beside
        // a `same` statement, a company key history that is not the roster's, a lost admin span.
        const org = cache.org!;
        const edited: Partial<GroupChainCache>[] = [
            { org: { ...org, members: org.members!.slice(1) } },
            { org: { ...org, members: null } },
            { org: { ...org, custodyKeys: [...org.custodyKeys, org.custodyKeys[0]!] } },
            { org: { ...org, kitKeys: [] } },
            { org: { ...org, areaKinds: {} } },
            { org: { ...org, areaLists: { [AREA]: [] } } },
            { org: { ...org, dataAdmins: {} } },
            { org: undefined },
            { cacheVersion: 2 },
        ];
        for (const over of edited)
            await expect(from([follows], over), JSON.stringify(Object.keys(over))).rejects.toThrow(
                'Invalid member list cache.',
            );
    });
});

describe('nextRoster for a company', () => {
    const heads = { heads: unverifiedHeads(HEADS_DIGEST) };
    /* What a recovery roster carries (rule 11): the heads of the roster before, restated. */
    const carried = async (chain: AcceptedRosters) => ({
        heads: await carriedHeads({ chain, groupId: chain.groupId, heads: null }),
    });

    test('builds what acceptance takes: `same` when nothing changed, versions and digests computed, the count kept', async () => {
        const cast = await companyCast();
        const c = await companyStart(cast);
        const chain = await accepted(c);
        const same = await nextRoster(chain, c.all, {
            signerUserId: cast.admin.userId,
            org: heads,
        });
        expect(same.membersSame).toBe(await rosterMembersDigest(chain.roster));
        expect(same.custody).toEqual(chain.roster.custody);
        expect(same.heads).toEqual({ areaCount: 1, headsDigest: HEADS_DIGEST });
        // The same roster with one entry changed lists everyone.
        const changed = await nextRoster(chain, withEntry(c, { ...c.e.member, status: 'left' }), {
            signerUserId: cast.admin.userId,
            org: heads,
        });
        expect(changed.membersSame).toBeUndefined();
        expect(parseRoster(rosterStatement(changed)).members).toHaveLength(c.all.length);
        // A new company key and kit: the next versions, the lattice keys by digest.
        const key = (await custodyAt(2)).publicKey;
        const kit = (await kitAt(2)).publicKeys;
        const replaced = await nextRoster(chain, c.all, {
            signerUserId: cast.owner.userId,
            org: { ...heads, custodyKey: key, kit },
        });
        expect(replaced.custody).toMatchObject({
            custodyKeyVersion: 2,
            kitVersion: 2,
            custodyEncryptionPublicKey: key.encryptionPublicKey,
            kitSigningPublicKey: kit.signingPublicKey,
        });
        const signed = await signRoster(replaced, c.h.keys[0]!, cast.owner.signer);
        const input = await companyInput(c.h, cast);
        const stored = await checkNextRoster(chain, signed, input.mlDsaKeys, null);
        expect(stored.roster.custody!.custodyKeyVersion).toBe(2);
        // A new area: its kind and list on the row, and counted.
        const withArea = await nextRoster(chain, c.all, {
            signerUserId: cast.admin.userId,
            areaKeys: [
                {
                    workspaceId: 'c0000001-8dfc-4914-8447-0417b55e2ec5',
                    workspaceKey: areaKeyAt('x', 5),
                    rootKey: rootKeyAt('x', 5),
                    areaKind: 'employee',
                    listDigest: listDigestAt('x', 1),
                },
            ],
            org: heads,
        });
        expect(withArea.heads!.areaCount).toBe(2);
        expect(withArea.areas![0]).toMatchObject({ areaKind: 'employee', workspaceKeyVersion: 1 });
    });

    test('refuses what acceptance refuses, before anyone signs', async () => {
        const cast = await companyCast();
        const c = await companyStart(cast);
        const chain = await accepted(c);
        const by = (who: { userId: string }, org = {}) => ({
            signerUserId: who.userId,
            org: { ...heads, ...org },
        });
        const key = (await custodyAt(2)).publicKey;
        const kit = (await kitAt(2)).publicKeys;
        const demoted = withEntry(c, { ...c.e.admin, roles: [] });
        // Dropping a data admin without a new company key; with one, only from an Owner.
        await expect(nextRoster(chain, demoted, by(cast.owner))).rejects.toThrow(
            'A roster that removes a data admin replaces the company key.',
        );
        await expect(
            nextRoster(chain, demoted, by(cast.admin2, { custodyKey: key })),
        ).rejects.toThrow('Only an owner can replace the company’s keys.');
        await expect(
            nextRoster(chain, demoted, by(cast.owner, { custodyKey: key })),
        ).resolves.toMatchObject({ rosterVersion: 3 });
        // Taking `recovery` without a new kit, and a new kit without a new company key.
        const taken = withEntry(c, { ...c.e.keeper, roles: [] });
        await expect(nextRoster(chain, taken, by(cast.owner))).rejects.toThrow(
            'A roster that takes the recovery kit from someone replaces the kit.',
        );
        await expect(nextRoster(chain, taken, by(cast.owner, { kit }))).rejects.toThrow(
            'A new recovery kit needs a new company key.',
        );
        // A family's chain takes no company fields, and a company's none of a family's formats.
        await expect(nextRoster(chain, c.all, { signerUserId: cast.admin.userId })).rejects.toThrow(
            'Invalid roster format.',
        );
        await expect(nextRoster(chain, c.all, { ...by(cast.admin), format: 2 })).rejects.toThrow();
        // An area's kind cannot change at a rotation, and a company row needs its list.
        const rotation = {
            workspaceId: AREA,
            workspaceKey: areaKeyAt(AREA, 2),
            rootKey: rootKeyAt(AREA, 2),
        };
        await expect(
            nextRoster(chain, c.all, {
                ...by(cast.admin),
                areaKeys: [
                    { ...rotation, areaKind: 'employee', listDigest: listDigestAt(AREA, 2) },
                ],
            }),
        ).rejects.toThrow('A company folder keeps the kind it was made with.');
        await expect(
            nextRoster(chain, c.all, { ...by(cast.admin), areaKeys: [rotation] }),
        ).rejects.toThrow('A company folder’s key needs its list beside it.');
        // An automatic admission: the count is computed, and refused where the rules are off.
        await expect(
            nextRoster(
                chain,
                [...c.all, cast.newcomer.entry([])],
                by(cast.admin, {
                    auto: { utcDay: '2026-11-10' },
                }),
            ),
        ).rejects.toThrow('automatic admission');
    });

    test('an automatic admission’s count is one more on the same day, and 1 on a later one', async () => {
        const cast = await companyCast();
        const c = await companyStart(cast);
        await c.h.roster(cast.admin, c.all, undefined, undefined, {
            rules: { autoJoin: true, autoJoinDailyLimit: 2 },
        });
        const all = [...c.all, cast.newcomer.entry([])];
        await c.h.roster(cast.admin, all, undefined, undefined, {
            auto: { utcDay: '2026-11-10', countThatDay: 1 },
        });
        const chain = await accepted(c);
        const admit = (utcDay: string, members: RosterMember[]) =>
            nextRoster(chain, members, {
                signerUserId: cast.admin.userId,
                org: { ...heads, auto: { utcDay } },
            });
        const more = [...all, cast.another.entry([])];
        expect((await admit('2026-11-10', more)).auto).toEqual({
            utcDay: '2026-11-10',
            countThatDay: 2,
        });
        expect((await admit('2026-11-11', more)).auto).toEqual({
            utcDay: '2026-11-11',
            countThatDay: 1,
        });
        await expect(admit('2026-11-09', more)).rejects.toThrow('automatic admission');
        await expect(admit('2026-11-10', all)).rejects.toThrow('automatic admission');
    });

    test('a guarded fold-in: another Owner needs a fresh check of the new keys; the person’s own roster does not', async () => {
        const cast = await companyCast();
        const c = await companyStart(cast);
        const chain = await accepted(c);
        const { next: second2, link } = await succeed(cast.second);
        const { next: keeper2, link: keeperLink } = await succeed(cast.keeper);
        const { next: admin2, link: adminLink } = await succeed(cast.admin);
        // A signed link is followed by foldInEntry, as for anyone.
        const folded = await foldInEntry(c.e.second, second2.served, [link], 3);
        expect(folded.changed).toBe(true);
        const members = withEntry(c, folded.entry);
        const by = (who: { userId: string }, checked?: unknown[]) => ({
            signerUserId: who.userId,
            org: { ...heads, ...(checked ? { checked: checked as never } : {}) },
        });
        const needsCheck = 'need a fresh words check';
        // Served to another Owner's device, it is not followed into the Owner's entry.
        await expect(nextRoster(chain, members, by(cast.owner))).rejects.toThrow(needsCheck);
        // Nor with a check of the old keys, a first-seen pin, a pin through a group, or another person's.
        const fresh = await second2.pin();
        for (const pin of [
            await cast.second.pin(),
            { ...fresh, fingerprint: '' },
            { ...fresh, trustedVia: chain.groupId },
            await cast.owner.pin(),
            { ...fresh, keyVersion: 1 },
        ])
            await expect(nextRoster(chain, members, by(cast.owner, [pin]))).rejects.toThrow(
                needsCheck,
            );
        // With a verified pin of the new keys it is built, and the chain takes it from an Owner.
        const built = await nextRoster(chain, members, by(cast.owner, [fresh]));
        expect(built.members.find((m) => m.userId === cast.second.userId)!.keyVersion).toBe(2);
        // The same for someone who only holds the kit.
        const keeperFolded = await foldInEntry(c.e.keeper, keeper2.served, [keeperLink], 3);
        await expect(
            nextRoster(chain, withEntry(c, keeperFolded.entry), by(cast.owner)),
        ).rejects.toThrow(needsCheck);
        await expect(
            nextRoster(
                chain,
                withEntry(c, keeperFolded.entry),
                by(cast.owner, [await keeper2.pin()]),
            ),
        ).resolves.toBeDefined();
        // The person's own roster needs none: they sign under the keys their entry named before.
        await expect(nextRoster(chain, members, by(cast.second))).resolves.toBeDefined();
        // An Admin's keys change on their own roster or an Owner's (rule 8), on the link alone;
        // a fellow Admin's roster cannot carry it.
        const adminFolded = await foldInEntry(c.e.admin, admin2.served, [adminLink], 3);
        const adminMoved = withEntry(c, adminFolded.entry);
        await expect(nextRoster(chain, adminMoved, by(cast.admin2))).rejects.toThrow(
            'Only an owner, or the member themselves, changes the keys',
        );
        await expect(nextRoster(chain, adminMoved, by(cast.admin))).resolves.toBeDefined();
        await expect(nextRoster(chain, adminMoved, by(cast.owner))).resolves.toBeDefined();
    });

    test('giving `members` or `recovery` to someone on the list needs a check of exactly the keys their entry names', async () => {
        const cast = await companyCast();
        const c = await companyStart(cast);
        const chain = await accepted(c);
        const by = (who: { userId: string }, checked: unknown[] = []) => ({
            signerUserId: who.userId,
            org: { ...heads, checked: checked as never },
        });
        const needsCheck = 'needs a fresh words check of their keys';
        const admin = withEntry(c, { ...c.e.member, roles: [...ADMIN_ROLES] });
        const holder = withEntry(c, { ...c.e.member, roles: ['recovery'] });
        const pin = await cast.member.pin();
        // Making a Member an Admin, or a kit holder: refused without the signer's verified pin.
        await expect(nextRoster(chain, admin, by(cast.admin))).rejects.toThrow(needsCheck);
        await expect(nextRoster(chain, holder, by(cast.owner))).rejects.toThrow(needsCheck);
        for (const other of [
            await cast.biller.pin(),
            { ...pin, fingerprint: '' },
            { ...pin, trustedVia: chain.groupId },
        ]) {
            await expect(nextRoster(chain, admin, by(cast.admin, [other]))).rejects.toThrow(
                needsCheck,
            );
        }
        await expect(nextRoster(chain, admin, by(cast.admin, [pin]))).resolves.toBeDefined();
        await expect(nextRoster(chain, holder, by(cast.owner, [pin]))).resolves.toBeDefined();
        // A role that opens nothing needs none; nor does taking a role away.
        await expect(
            nextRoster(chain, withEntry(c, { ...c.e.member, roles: ['billing'] }), by(cast.admin)),
        ).resolves.toBeDefined();
        // Plant, then promote: an Admin writes other keys into the Member's entry (the chain takes
        // that, as a family's does), and an Owner's device is asked to make "them" an Admin. A
        // check of the real person does not cover the keys the entry now names.
        const planted = { ...c.e.member, ...keysOf(cast.newcomer.entry([])) };
        await c.h.roster(cast.admin, withEntry(c, planted));
        const after = await accepted(c);
        const promoted = withEntry(c, { ...planted, roles: [...ADMIN_ROLES] });
        await expect(nextRoster(after, promoted, by(cast.owner, [pin]))).rejects.toThrow(
            needsCheck,
        );
        await expect(nextRoster(after, promoted, by(cast.owner))).rejects.toThrow(needsCheck);
    });

    test('letting someone in with `members` or `recovery` needs a check of exactly the keys their entry names, and a Member needs none', async () => {
        const cast = await companyCast();
        const c = await companyStart(cast);
        const chain = await accepted(c);
        expect(rosterEntry(chain.roster, cast.newcomer.userId)).toBeUndefined();
        const by = (who: { userId: string }, checked: unknown[] = []) => ({
            signerUserId: who.userId,
            org: { ...heads, checked: checked as never },
        });
        const needsCheck = 'needs a fresh words check of their keys';
        const letIn = (roles: GroupRole[]) => [...c.all, cast.newcomer.entry(roles)];
        const pin = await cast.newcomer.pin();
        // Straight in as an Admin, or with the kit: the keys are only what the server served.
        await expect(nextRoster(chain, letIn([...ADMIN_ROLES]), by(cast.admin))).rejects.toThrow(
            needsCheck,
        );
        await expect(nextRoster(chain, letIn(['recovery']), by(cast.owner))).rejects.toThrow(
            needsCheck,
        );
        await expect(nextRoster(chain, letIn([...OWNER_ROLES]), by(cast.owner))).rejects.toThrow(
            needsCheck,
        );
        // A check of someone else, or of other keys of theirs, is no check of these.
        for (const other of [
            await cast.member.pin(),
            { ...pin, keyVersion: 2 },
            { ...pin, signingPublicKey: cast.member.entry([]).signingPublicKey },
        ]) {
            await expect(
                nextRoster(chain, letIn([...ADMIN_ROLES]), by(cast.admin, [other])),
            ).rejects.toThrow(needsCheck);
        }
        const admitted = await nextRoster(chain, letIn([...ADMIN_ROLES]), by(cast.admin, [pin]));
        expect(rosterEntry(admitted, cast.newcomer.userId)?.roles).toEqual([...ADMIN_ROLES]);
        await expect(
            nextRoster(chain, letIn(['recovery']), by(cast.owner, [pin])),
        ).resolves.toBeDefined();
        // A Member, or a Billing holder, comes in as before: first-seen keys, no check.
        await expect(nextRoster(chain, letIn([]), by(cast.admin))).resolves.toBeDefined();
        await expect(nextRoster(chain, letIn(['billing']), by(cast.admin))).resolves.toBeDefined();
        // Someone who had left is let back in with a role on the same terms.
        await c.h.roster(cast.owner, withEntry(c, { ...c.e.member, status: 'left', roles: [] }));
        const after = await accepted(c);
        const back = withEntry(c, { ...c.e.member, roles: [...ADMIN_ROLES] });
        await expect(nextRoster(after, back, by(cast.admin))).rejects.toThrow(needsCheck);
        await expect(
            nextRoster(after, back, by(cast.admin, [await cast.member.pin()])),
        ).resolves.toBeDefined();
    });

    test('a roster served with a null kit signature is one without: ordinary rosters are taken, a recovery roster is not', async () => {
        const cast = await companyCast();
        const c = await companyStart(cast);
        const input = await companyInput(c.h, cast);
        // What a client reading an empty database column hands over.
        const nulled = input.rosters.map((roster) => ({ ...roster, kitSignature: null as never }));
        const plain = await acceptRosters(input);
        const served = await acceptRosters({ ...input, rosters: nulled });
        expect(served.status).toBe('accepted');
        expect((served as AcceptedRosters).rosterDigest).toBe(
            (plain as AcceptedRosters).rosterDigest,
        );
        // Each next roster alike, one at a time.
        const first = await acceptRosters({ ...input, rosters: nulled.slice(0, 1) });
        await expect(
            checkNextRoster(first as AcceptedRosters, nulled[1]!, input.mlDsaKeys, null),
        ).resolves.toBeDefined();
        // And null is no signature where one is needed.
        const promoted = withEntry(c, { ...c.e.keeper, roles: [...OWNER_ROLES] });
        const roster = await nextRoster(plain as AcceptedRosters, promoted, {
            signerUserId: cast.keeper.userId,
            org: await carried(plain as AcceptedRosters),
        });
        const signed = await signRecoveryRoster(
            roster,
            c.h.keys[0]!,
            cast.keeper.signer,
            (await kitAt(1)).signer,
        );
        await expect(
            checkNextRoster(
                plain as AcceptedRosters,
                { ...signed, kitSignature: null as never },
                input.mlDsaKeys,
                null,
            ),
        ).rejects.toThrow('not signed with the company’s recovery kit');
    });

    test('a recovery roster is built only for the kit holder’s own promotion, and signed with the kit', async () => {
        const cast = await companyCast();
        const c = await companyStart(cast);
        const chain = await accepted(c);
        const promoted = withEntry(c, { ...c.e.keeper, roles: [...OWNER_ROLES] });
        const roster = await nextRoster(chain, promoted, {
            signerUserId: cast.keeper.userId,
            org: await carried(chain),
        });
        expect(roster.heads).toEqual(chain.roster.heads);
        // No other roster restates the heads before it.
        await expect(
            nextRoster(chain, c.all, {
                signerUserId: cast.admin.userId,
                org: await carried(chain),
            }),
        ).rejects.toThrow('These heads were not built for this member list.');
        const input = await companyInput(c.h, cast);
        const kit = (await kitAt(1)).signer;
        const signed = await signRecoveryRoster(roster, c.h.keys[0]!, cast.keeper.signer, kit);
        expect(signed.kitSignature).toHaveLength(3373);
        const stored = await checkNextRoster(chain, signed, input.mlDsaKeys, null);
        expect(stored.recoveries).toEqual([{ rosterVersion: 3, signerUserId: cast.keeper.userId }]);
        // Without the kit's signature, or with a byte of it changed, no device takes it.
        const { kitSignature, ...bare } = signed;
        await expect(checkNextRoster(chain, bare, input.mlDsaKeys, null)).rejects.toThrow(
            'not signed with the company’s recovery kit',
        );
        const flipped = kitSignature.slice();
        flipped[100]! ^= 1;
        await expect(
            checkNextRoster(chain, { ...bare, kitSignature: flipped }, input.mlDsaKeys, null),
        ).rejects.toThrow('not signed with the company’s recovery kit');
        // The kit holder builds nothing else: an Admin's roster, or their promotion with more.
        await expect(
            nextRoster(chain, withEntry(c, { ...c.e.keeper, roles: [...ADMIN_ROLES] }), {
                signerUserId: cast.keeper.userId,
                org: await carried(chain),
            }),
        ).rejects.toThrow(CryptoError);
        await expect(
            nextRoster(chain, c.all, {
                signerUserId: cast.keeper.userId,
                org: await carried(chain),
            }),
        ).rejects.toThrow('The recovery kit makes its holder an owner and changes nothing else.');
    });

    test('the shut-out, end to end: an Admin holding the group seed makes no succession and no company key any device takes', async () => {
        const cast = await companyCast();
        const c = await companyStart(cast);
        const input = await companyInput(c.h, cast);
        // The Owner removes an Admin: the succession is due.
        const without = withEntry(c, { ...c.e.admin2, status: 'left', roles: [] });
        await c.h.roster(cast.owner, without, undefined, undefined, { custodyVersion: 2 });
        const chain = await accepted(c);
        expect(chain.successionDue).toBe(true);
        // The remaining Admin holds the group seed, and signs the succession with it.
        const byAdmin = await c.h.succession(cast.admin);
        await expect(checkNextSuccession(chain, byAdmin, input.mlDsaKeys)).rejects.toThrow(
            'Only an owner can replace the company’s keys.',
        );
        c.h.successions.pop();
        c.h.keys.pop();
        const byOwner = await c.h.succession(cast.second);
        expect((await checkNextSuccession(chain, byOwner, input.mlDsaKeys)).groupKeyVersion).toBe(
            2,
        );
        // Nor a company key replacement, whatever it seals to whom: the roster itself is refused.
        const fresh = await companyStart(cast);
        const start = await accepted(fresh);
        const replacement = await fresh.h.roster(cast.admin, fresh.all, undefined, undefined, {
            custodyVersion: 2,
        });
        await expect(checkNextRoster(start, replacement, input.mlDsaKeys, null)).rejects.toThrow(
            'Only an owner can replace the company’s keys.',
        );
    });
});
