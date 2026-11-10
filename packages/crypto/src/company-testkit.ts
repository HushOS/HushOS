import { areaKeyCommitment, areaRootCommitment } from './area-keys';
import { encodeStatement } from './canonical';
import {
    checkKitSeal,
    custodyFingerprint,
    custodySealStatement,
    keyEscrowStatement,
    kitSealProofStatement,
    kitSealStatement,
    noticeKeys,
    noticeSeed,
    openCustodyKey,
    openCustodyPrevious,
    openCustodySeal,
    openKeyEscrow,
    openKitSeal,
    sealCustody,
    sealCustodyKey,
    sealCustodyPrevious,
    sealKeyEscrow,
    sealKit,
    signRecoveryRequest,
    verifyRecoveryRequest,
    wrapPreviousNoticeSeed,
    type CustodyKeySealContext,
    type CustodyPreviousContext,
    type CustodySealContext,
    type KeyEscrowContext,
    type KitSealContext,
    type SealCheck,
} from './custody';
import { CryptoError } from './errors';
import {
    ADMIN_ROLES,
    AREA,
    GROUP,
    OWNER_ROLES,
    areaKeyAt,
    custodyAt,
    custodyFieldAt,
    groupKeyAt,
    history,
    inputOf,
    kitAt,
    mlDsaKeysOf,
    orgRowAt,
    pattern,
    person,
    succeed,
    type History,
    type OrgRosterOptions,
    type Person,
} from './group-testkit';
import { acceptRosters, type AcceptInput, type AcceptedRosters } from './group-trust';
import {
    GROUP_SIGNATURE_CONTEXT,
    recoveryRosterStatement,
    rosterDigest,
    rosterMembersDigest,
    signRecoveryRoster,
    signRoster,
    type GroupRole,
    type Roster,
    type RosterArea,
    type RosterMember,
    type SignedGroupStatement,
} from './groups';
import { decode, encode } from './keys';
import { mlDsaSign } from './pq';
import { SEAL_COINS_BYTES, sealHybrid, sealWithCoins, type HybridSealKind } from './sealing';
import {
    HYBRID_SIGNATURE_BYTES,
    SIGNATURE_BYTES,
    digest,
    signHybrid,
    signStatement,
} from './signatures';

/*
 * A company for the company tests and the shared company fixtures
 * (docs/companies-design.md 2.1): its people, its first two rosters, and the
 * histories that keep or break each acceptance rule, one rule at a time. Like
 * group-testkit.ts, every key comes from a fixed seed and histories are
 * written without nextRoster's checks, so a case can sign what a hostile
 * Admin, a broken client or a server might serve. Not part of the package's
 * exports. The Rust core judges the same histories from web-company.json.
 */

/* The refusals checkRosterOrg words as the design does (group-trust.ts): what a case says broke. */
export const REFUSALS = {
    droppedAdmin: 'A roster that removes a data admin replaces the company key.',
    kitNeedsKey: 'A new recovery kit needs a new company key.',
    ownerOnly: 'Only an owner can change an owner, the recovery kit or its holders.',
    ownerKeys: 'Only an owner can replace the company’s keys.',
    kitFollows: 'A roster that takes the recovery kit from someone replaces the kit.',
    roleSet: 'This is not one of a company’s roles.',
    leftWithRoles: 'Someone who has left a company holds no role.',
    noOwner: 'A company keeps an active owner.',
    custody: 'The company’s keys do not follow from the member list before.',
    reused: 'This company key or recovery kit was used before: a new one is needed.',
    rotations: 'A company’s member list changes at most 8 folder keys.',
    auto: 'This is not an automatic admission the company’s rules allow.',
    areaCount: 'This member list does not count the company’s folders.',
    recovery: 'The recovery kit makes its holder an owner and changes nothing else.',
    kitSigned: 'This member list is not signed with the company’s recovery kit.',
    kind: 'A company folder keeps the kind it was made with.',
    notHolder: 'This was not signed by a member who holds the group key.',
    holderLeft: 'A member who held the group key left, so the key must be replaced first.',
    groupSigned: 'This roster is not signed by the group key.',
    following: 'This member list does not follow from the one before.',
    noSuccession: 'A group key succession is missing.',
    format: 'Invalid roster format.',
} as const;
export type Refusal = keyof typeof REFUSALS;

/* The company's people: an Owner who creates it, a second Owner, two Admins, a Member, a kit holder, a Billing holder, and two not yet in it. */
export async function companyCast() {
    const [owner, second, admin, member, keeper, biller, newcomer, admin2, another] =
        (await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => person(n)))) as [
            Person,
            Person,
            Person,
            Person,
            Person,
            Person,
            Person,
            Person,
            Person,
        ];
    return { owner, second, admin, member, keeper, biller, newcomer, admin2, another };
}
export type CompanyCast = Awaited<ReturnType<typeof companyCast>>;

/* The served ML-DSA keys of the testkit's kits at `versions`, by digest, as acceptance takes them beside members'. */
export async function kitMlDsaKeys(versions: number[], groupId = GROUP) {
    const keys: Record<string, string> = {};
    for (const version of versions) {
        const kit = (await kitAt(version, groupId)).publicKeys;
        keys[await digest(decode(kit.mlDsaPublicKey))] = kit.mlDsaPublicKey;
    }
    return keys;
}

/* An area id that sorts after AREA, by `n` (not derived under the group: only its rows are read). */
export function areaIdOf(n: number) {
    return `c${n.toString(16).padStart(7, '0')}-8dfc-4914-8447-0417b55e2ec5`;
}

/* A format 3 key row for areaIdOf(n) at `version`, with keys of its own (no two areas share one). */
export async function rowOf(n: number, version: number): Promise<RosterArea> {
    return {
        workspaceId: areaIdOf(n),
        workspaceKeyVersion: version,
        commitment: await areaKeyCommitment(pattern(32, 300 + n * 7 + version)),
        rootCommitment: await areaRootCommitment(pattern(32, 500 + n * 7 + version)),
        areaKind: 'shared',
        listDigest: encode(pattern(32, 700 + n * 7 + version)),
    };
}

/*
 * A company two rosters old: created by its Owner alone (roster 1, with its
 * first shared folder), who then lets everyone else in with their roles
 * (roster 2). Every case continues from here unless it says otherwise.
 */
export async function companyStart(cast: CompanyCast) {
    const h = await history('org');
    const e = {
        owner: cast.owner.entry(OWNER_ROLES),
        second: cast.second.entry(OWNER_ROLES),
        admin: cast.admin.entry(ADMIN_ROLES),
        member: cast.member.entry([]),
        keeper: cast.keeper.entry(['recovery']),
        biller: cast.biller.entry(['billing']),
        admin2: cast.admin2.entry(ADMIN_ROLES),
    };
    await h.roster(cast.owner, [e.owner]);
    await h.roster(cast.owner, Object.values(e));
    return { h, e, cast, all: Object.values(e) };
}
export type Company = Awaited<ReturnType<typeof companyStart>>;

/* `all` with one entry replaced (or added): by role set, status, or a whole entry. */
export function withEntry(company: Company, entry: RosterMember): RosterMember[] {
    return [...company.all.filter((at) => at.userId !== entry.userId), entry];
}
const roles = (entry: RosterMember, to: GroupRole[]): RosterMember => ({
    ...entry,
    roles: [...to].sort(),
});
const left = (entry: RosterMember): RosterMember => ({ ...entry, status: 'left', roles: [] });

/* What acceptance takes for a company's history: everyone's ML-DSA keys and the kits', created by this reader's own device. */
export async function companyInput(
    h: History,
    cast: CompanyCast,
    over: Partial<AcceptInput> & { extra?: Person[] } = {},
): Promise<AcceptInput> {
    const { extra, ...rest } = over;
    return inputOf(h, Object.values(cast), {
        mlDsaKeys: {
            ...mlDsaKeysOf(...Object.values(cast), ...(extra ?? [])),
            ...(await kitMlDsaKeys([1, 2, 3], h.groupId)),
        },
        ...rest,
    });
}

/* The latest roster of `h` signed again as a recovery roster, by `signer`, with a kit signature of the case's making. */
async function resign(
    h: History,
    signer: Person,
    kitSignature: (statement: Uint8Array, roster: Roster) => Promise<Uint8Array | undefined>,
    groupKeyVersion = 1,
) {
    const roster = h.statements.at(-1)!;
    const signed: SignedGroupStatement = await signRoster(
        roster,
        await groupKeyAt(groupKeyVersion),
        signer.signer,
    );
    const kit = await kitSignature(signed.statement, roster);
    h.rosters[h.rosters.length - 1] = kit ? { ...signed, kitSignature: kit } : signed;
}

/* The recovery-roster statement of a signed roster, as the kit signs it. */
async function recoveryStatementOf(statement: Uint8Array, roster: Roster) {
    return recoveryRosterStatement({
        groupId: roster.groupId,
        rosterVersion: roster.rosterVersion,
        kitVersion: roster.custody!.kitVersion,
        rosterDigest: await rosterDigest(statement),
    });
}

/* A case: a history, what a newcomer's acceptance must say of it, and, refused, the rule that refuses it. */
export type CompanyCase = {
    name: string;
    input: AcceptInput;
    expected: { status: 'accepted'; rosterVersion: number } | { status: 'refused' };
    /* The refusal acceptance gives (REFUSALS), when the case is refused by a company rule. */
    refusal?: Refusal;
};

/*
 * The histories that keep or break each rule of companies-design 2.1, one at
 * a time: for every rule a history that passes with it and one that fails
 * without it. Both twins judge them alike (web-company.json).
 */
export async function companyCases(): Promise<CompanyCase[]> {
    const cast = await companyCast();
    const { owner, second, admin, member, keeper, newcomer, another } = cast;
    const cases: CompanyCase[] = [];
    const accepted = (rosterVersion: number) => ({ status: 'accepted' as const, rosterVersion });
    const refused = { status: 'refused' as const };
    /* One case: `write` continues a fresh company (roster 3 on), and acceptance says `expected`. */
    const add = async (
        name: string,
        write: (company: Company) => Promise<void | Partial<AcceptInput> | { extra: Person[] }>,
        expected: number | Refusal | 'refused',
    ) => {
        const company = await companyStart(cast);
        const over = (await write(company)) ?? {};
        cases.push({
            name,
            input: await companyInput(company.h, cast, over),
            expected: typeof expected === 'number' ? accepted(expected) : refused,
            ...(typeof expected === 'string' && expected !== 'refused'
                ? { refusal: expected }
                : {}),
        });
    };
    /* The next roster, by `signer`, with `members` (everyone unchanged by default). */
    const next = (
        c: Company,
        signer: Person,
        members: RosterMember[] = c.all,
        org: OrgRosterOptions = {},
        areas?: RosterArea[],
    ) => c.h.roster(signer, members, undefined, areas, org);
    const replaced = { custodyVersion: 2 };
    const replacedWithKit = { custodyVersion: 2, kitVersion: 2 };
    const v1 = await custodyFieldAt(1, 1);
    const kit2 = (await kitAt(2)).publicKeys;

    // The start itself, and `same` (2.1): a roster that changes no entry names the list before.
    await add('company-start', async () => {}, 2);
    await add('same-members', async (c) => void (await next(c, admin)), 3);
    await add(
        'same-with-another-digest',
        async (c) => void (await next(c, admin, c.all, { membersSame: encode(pattern(32, 9)) })),
        'following',
    );
    await add(
        // `same` over a changed list names the new list's digest, which is not the list before.
        'same-on-a-changed-list',
        async (c) => {
            const members = withEntry(c, left(c.e.member));
            const digestOfNew = await rosterMembersDigest({
                kind: 'org',
                rosterVersion: 3,
                members: members
                    .map((entry) => ({
                        ...entry,
                        sinceVersion: entry.userId === member.userId ? 3 : entry.sinceVersion,
                    }))
                    .sort((a, b) => (a.userId < b.userId ? -1 : 1)),
            });
            await next(c, admin, members, { membersSame: digestOfNew });
        },
        'following',
    );
    await add(
        'full-list-unchanged',
        async (c) => void (await next(c, admin, c.all, { same: false })),
        3,
    );

    // Rule 1: the company key and the kit move forward only, one version at a time, to new keys.
    await add('custody-replaced', async (c) => void (await next(c, owner, c.all, replaced)), 3);
    await add(
        'kit-replaced-with-key',
        async (c) => void (await next(c, owner, c.all, replacedWithKit)),
        3,
    );
    await add(
        'custody-skips-a-version',
        async (c) => void (await next(c, owner, c.all, { custodyVersion: 3 })),
        'custody',
    );
    await add(
        // The version alone moves, the keys kept: neither the one before nor one more.
        'custody-version-skips-with-the-same-keys',
        async (c) => void (await next(c, owner, c.all, { custody: { custodyKeyVersion: 3 } })),
        'custody',
    );
    await add(
        'custody-version-goes-back-with-the-same-keys',
        async (c) => {
            await next(c, owner, c.all, replaced);
            await next(c, owner, c.all, { custody: { custodyKeyVersion: 1 } });
        },
        'custody',
    );
    await add(
        'kit-version-skips-with-the-same-keys',
        async (c) => void (await next(c, owner, c.all, { custody: { kitVersion: 3 } })),
        'custody',
    );
    await add(
        'custody-kept-with-other-keys',
        async (c) =>
            void (await next(c, owner, c.all, {
                custody: {
                    custodyEncryptionPublicKey: (await custodyAt(2)).publicKey.encryptionPublicKey,
                },
            })),
        'custody',
    );
    await add(
        'custody-raised-with-the-same-keys',
        async (c) => void (await next(c, owner, c.all, { custody: { custodyKeyVersion: 2 } })),
        'reused',
    );
    await add(
        'custody-raised-with-earlier-keys',
        async (c) => {
            await next(c, owner, c.all, replaced);
            await next(c, owner, c.all, {
                custodyVersion: 3,
                custody: {
                    custodyEncryptionPublicKey: v1.custodyEncryptionPublicKey,
                    custodyKemPublicKeyDigest: v1.custodyKemPublicKeyDigest,
                },
            });
        },
        'reused',
    );
    await add(
        'custody-goes-back',
        async (c) => {
            await next(c, owner, c.all, replaced);
            await next(c, owner, c.all, { custodyVersion: 1 });
        },
        'custody',
    );
    await add(
        'kit-kept-with-another-signing-key',
        async (c) =>
            void (await next(c, owner, c.all, {
                custody: { kitSigningPublicKey: kit2.signingPublicKey },
            })),
        'custody',
    );
    await add(
        'kit-raised-with-an-earlier-key',
        async (c) => {
            await next(c, owner, c.all, replacedWithKit);
            await next(c, owner, c.all, {
                custodyVersion: 3,
                kitVersion: 3,
                custody: { kitSigningPublicKey: v1.kitSigningPublicKey },
            });
        },
        'reused',
    );
    {
        const h = await history('org');
        await h.roster(owner, [owner.entry(OWNER_ROLES)], 1, undefined, { custodyVersion: 2 });
        cases.push({
            name: 'first-roster-at-company-key-2',
            input: await companyInput(h, cast),
            expected: refused,
            refusal: 'custody',
        });
    }

    // Rule 2: dropping a data admin replaces the company key.
    await add(
        'admin-demoted-without-new-key',
        async (c) => void (await next(c, owner, withEntry(c, roles(c.e.admin, [])))),
        'droppedAdmin',
    );
    await add(
        'admin-demoted-with-new-key',
        async (c) => void (await next(c, owner, withEntry(c, roles(c.e.admin, [])), replaced)),
        3,
    );
    await add(
        'admin-left-without-new-key',
        async (c) => void (await next(c, owner, withEntry(c, left(c.e.admin)))),
        'droppedAdmin',
    );

    // Rule 3: one of the six role sets; none once left.
    for (const [name, set] of [
        ['members-without-data-admin', ['members']],
        ['data-admin-without-members', ['data_admin']],
        ['admin-with-billing', ['billing', 'data_admin', 'members']],
        ['guardian-in-a-company', ['guardian']],
    ] as [string, GroupRole[]][])
        await add(
            name,
            async (c) => void (await next(c, owner, withEntry(c, roles(c.e.member, set)))),
            'roleSet',
        );
    await add(
        'billing-and-recovery',
        async (c) =>
            void (await next(c, owner, withEntry(c, roles(c.e.member, ['billing', 'recovery'])))),
        3,
    );
    await add(
        'left-keeps-a-role',
        async (c) => void (await next(c, admin, withEntry(c, { ...c.e.biller, status: 'left' }))),
        'leftWithRoles',
    );
    await add(
        'left-without-roles',
        async (c) => void (await next(c, admin, withEntry(c, left(c.e.biller)))),
        3,
    );

    // Rule 4: an Owner stays.
    {
        const h = await history('org');
        const sole = owner.entry(OWNER_ROLES);
        await h.roster(owner, [sole]);
        await h.roster(owner, [sole, admin.entry(ADMIN_ROLES)]);
        await h.roster(owner, [owner.entry(ADMIN_ROLES), admin.entry(ADMIN_ROLES)], undefined, [], {
            custodyVersion: 2,
            kitVersion: 2,
        });
        cases.push({
            name: 'last-owner-steps-down',
            input: await companyInput(h, cast),
            expected: refused,
            refusal: 'noOwner',
        });
    }
    await add(
        'owner-steps-down-to-admin',
        async (c) =>
            void (await next(
                c,
                owner,
                withEntry(c, roles(c.e.owner, ADMIN_ROLES)),
                replacedWithKit,
            )),
        3,
    );

    // Rule 6: at most 8 rows rotate an existing area; new areas are not counted.
    const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const rows = (version: number, of = nine) => Promise.all(of.map((n) => rowOf(n, version)));
    await add(
        'nine-new-areas',
        async (c) => void (await next(c, admin, c.all, {}, await rows(1))),
        3,
    );
    await add(
        'eight-rotations',
        async (c) => {
            await next(c, admin, c.all, {}, await rows(1));
            await next(c, admin, c.all, {}, await rows(2, nine.slice(0, 8)));
        },
        4,
    );
    await add(
        'nine-rotations',
        async (c) => {
            await next(c, admin, c.all, {}, await rows(1));
            await next(c, admin, c.all, {}, await rows(2));
        },
        'rotations',
    );

    // Rule 7: the kit follows `recovery`, and a new kit needs a new company key.
    await add(
        'recovery-taken-without-new-kit',
        async (c) => void (await next(c, owner, withEntry(c, roles(c.e.keeper, [])))),
        'kitFollows',
    );
    await add(
        'recovery-taken-with-kit-alone',
        async (c) =>
            void (await next(c, owner, withEntry(c, roles(c.e.keeper, [])), { kitVersion: 2 })),
        'kitNeedsKey',
    );
    await add(
        'recovery-taken-with-kit-and-key',
        async (c) =>
            void (await next(c, owner, withEntry(c, roles(c.e.keeper, [])), replacedWithKit)),
        3,
    );
    await add(
        'kit-holder-left-without-new-kit',
        async (c) => void (await next(c, owner, withEntry(c, left(c.e.keeper)))),
        'kitFollows',
    );
    await add(
        // The roster that marked the kit holder left emptied their roles: nothing is owed again.
        'after-kit-holder-left',
        async (c) => {
            const members = withEntry(c, left(c.e.keeper));
            await next(c, owner, members, replacedWithKit);
            await next(c, admin, members);
        },
        4,
    );

    // Rule 8: Owners rank above Admins. Each roster an Admin signs is refused; an Owner's is taken.
    const guarded: [string, (c: Company) => RosterMember[], OrgRosterOptions][] = [
        ['marks-an-owner-left', (c) => withEntry(c, left(c.e.second)), replacedWithKit],
        ['demotes-an-owner', (c) => withEntry(c, roles(c.e.second, ADMIN_ROLES)), replacedWithKit],
        ['gives-recovery', (c) => withEntry(c, roles(c.e.member, ['recovery'])), {}],
        ['takes-recovery', (c) => withEntry(c, roles(c.e.keeper, [])), replacedWithKit],
        ['adds-a-kit-holder', (c) => withEntry(c, newcomer.entry(['recovery'])), {}],
        [
            'bumps-a-kit-holders-key-version',
            (c) => withEntry(c, { ...c.e.keeper, keyVersion: 2 }),
            {},
        ],
        [
            // Keys of the Admin's own, written into an Owner's entry.
            'writes-own-keys-into-an-owner',
            (c) =>
                withEntry(c, {
                    ...c.e.second,
                    encryptionPublicKey: c.e.admin.encryptionPublicKey,
                    signingPublicKey: c.e.admin.signingPublicKey,
                    mlDsaPublicKeyDigest: c.e.admin.mlDsaPublicKeyDigest,
                    kemPublicKeyDigest: c.e.admin.kemPublicKeyDigest,
                }),
            {},
        ],
        ['replaces-the-kit', (c) => c.all, replacedWithKit],
    ];
    for (const [name, members, org] of guarded) {
        await add(
            `admin-${name}`,
            async (c) => void (await next(c, admin, members(c), org)),
            'ownerOnly',
        );
        await add(`owner-${name}`, async (c) => void (await next(c, owner, members(c), org)), 3);
    }
    await add(
        // Planted keys, end to end: the roster that plants them is refused, so nothing signed
        // "as the Owner" under them follows either.
        'admin-signs-as-the-owner-under-planted-keys',
        async (c) => {
            const planted = withEntry(c, {
                ...c.e.second,
                encryptionPublicKey: c.e.admin.encryptionPublicKey,
                signingPublicKey: c.e.admin.signingPublicKey,
                mlDsaPublicKeyDigest: c.e.admin.mlDsaPublicKeyDigest,
                kemPublicKeyDigest: c.e.admin.kemPublicKeyDigest,
            });
            await next(c, admin, planted);
            // Signed with the Admin's keys, naming the Owner: it removes the other Owner.
            await c.h.roster(
                { ...admin, userId: second.userId } as Person,
                planted.map((entry) => (entry.userId === owner.userId ? left(entry) : entry)),
                undefined,
                undefined,
                replacedWithKit,
            );
        },
        'ownerOnly',
    );
    {
        // An Owner folds in their own new identity, signed under the keys their entry named before.
        const { next: owner2 } = await succeed(owner);
        await add(
            'owner-folds-in-own-identity',
            async (c) => {
                await next(c, owner, withEntry(c, owner2.entry(OWNER_ROLES, 2)));
                return { extra: [owner2] };
            },
            3,
        );
        const { next: second2 } = await succeed(second);
        await add(
            'admin-folds-in-an-owners-identity',
            async (c) => {
                await next(c, admin, withEntry(c, second2.entry(OWNER_ROLES, 2)));
                return { extra: [second2] };
            },
            'ownerOnly',
        );
    }
    await add(
        'admin-removes-a-member',
        async (c) => void (await next(c, admin, withEntry(c, left(c.e.member)))),
        3,
    );
    await add(
        'admin-makes-an-admin',
        async (c) => void (await next(c, admin, withEntry(c, roles(c.e.member, ADMIN_ROLES)))),
        3,
    );
    await add(
        'admin-lets-someone-in',
        async (c) => void (await next(c, admin, withEntry(c, newcomer.entry([])))),
        3,
    );

    // Rule 12: new keys are an Owner's, the group key's succession included.
    await add(
        'admin-replaces-the-company-key',
        async (c) => void (await next(c, admin, c.all, replaced)),
        'ownerKeys',
    );
    await add(
        'admin-removes-an-admin',
        async (c) => void (await next(c, admin, withEntry(c, left(c.e.admin2)), replaced)),
        'ownerKeys',
    );
    await add(
        'admin-demotes-an-admin',
        async (c) => void (await next(c, admin, withEntry(c, roles(c.e.admin2, [])), replaced)),
        'ownerKeys',
    );
    await add(
        'owner-removes-an-admin',
        async (c) => void (await next(c, owner, withEntry(c, left(c.e.admin2)), replaced)),
        3,
    );
    await add(
        // The succession the removal makes due, signed by an Admin who holds the group seed: no
        // device takes it, so the roster under the key it names is refused.
        'succession-by-an-admin',
        async (c) => {
            const members = withEntry(c, left(c.e.admin2));
            await next(c, owner, members, replaced);
            await c.h.succession(admin);
            await next(c, owner, members);
        },
        'ownerKeys',
    );
    await add(
        'succession-by-an-owner',
        async (c) => {
            const members = withEntry(c, left(c.e.admin2));
            await next(c, owner, members, replaced);
            await c.h.succession(second);
            await next(c, owner, members);
        },
        4,
    );
    {
        // The same shape in a family: any `members` holder signs the succession.
        const h = await history();
        const organizer = owner.entry(['billing', 'guardian', 'members']);
        await h.roster(owner, [organizer, second.entry(['members']), admin.entry(['members'])]);
        await h.roster(owner, [
            organizer,
            second.entry(['members']),
            admin.entry(['members'], 2, 'left'),
        ]);
        await h.succession(second);
        await h.roster(owner, [
            organizer,
            second.entry(['members']),
            admin.entry(['members'], 2, 'left'),
        ]);
        cases.push({
            name: 'family-succession-by-any-holder',
            input: await companyInput(h, cast),
            expected: accepted(3),
        });
    }

    // An area's kind is fixed at its first row; rule 10: heads count the live areas.
    await add(
        'area-rotated',
        async (c) => void (await next(c, admin, c.all, {}, [await orgRowAt(AREA, 2)])),
        3,
    );
    await add(
        'area-kind-changes',
        async (c) => void (await next(c, admin, c.all, {}, [await orgRowAt(AREA, 2, 'employee')])),
        'kind',
    );
    await add(
        'heads-miscount-the-areas',
        async (c) => void (await next(c, admin, c.all, { heads: { areaCount: 2 } })),
        'areaCount',
    );
    await add(
        'heads-count-a-new-area-and-a-tombstone',
        async (c) => {
            await next(c, admin, c.all, {}, [await rowOf(1, 1)]);
            await next(c, admin, c.all, {}, [
                { workspaceId: AREA, workspaceKeyVersion: 2, commitment: '', retired: true },
                await rowOf(2, 1),
            ]);
        },
        4,
    );

    // Rule 9: an automatic admission says so, and is nothing but one new Member.
    const on = { rules: { autoJoin: true, autoJoinDailyLimit: 2 } };
    const day = '2026-11-10';
    const admit = (c: Company, who: Person, auto: { utcDay: string; countThatDay: number }) => {
        c.all.push(who.entry([]));
        return next(c, admin, c.all, { auto });
    };
    await add(
        'auto-admission',
        async (c) => {
            await next(c, admin, c.all, on);
            await admit(c, newcomer, { utcDay: day, countThatDay: 1 });
        },
        4,
    );
    await add(
        'auto-without-the-rule',
        async (c) => void (await admit(c, newcomer, { utcDay: day, countThatDay: 1 })),
        'auto',
    );
    await add(
        'auto-after-the-rule-is-turned-off',
        async (c) => {
            await next(c, admin, c.all, on);
            await next(c, admin, c.all, { rules: { autoJoin: false, autoJoinDailyLimit: 2 } });
            await admit(c, newcomer, { utcDay: day, countThatDay: 1 });
        },
        'auto',
    );
    await add(
        'auto-with-a-role',
        async (c) => {
            await next(c, admin, c.all, on);
            await next(c, admin, withEntry(c, newcomer.entry(['billing'])), {
                auto: { utcDay: day, countThatDay: 1 },
            });
        },
        'auto',
    );
    await add(
        'auto-with-a-second-change',
        async (c) => {
            await next(c, admin, c.all, on);
            await next(c, admin, [...withEntry(c, left(c.e.biller)), newcomer.entry([])], {
                auto: { utcDay: day, countThatDay: 1 },
            });
        },
        'auto',
    );
    await add(
        'auto-with-two-newcomers',
        async (c) => {
            await next(c, admin, c.all, on);
            await next(c, admin, [...c.all, newcomer.entry([]), another.entry([])], {
                auto: { utcDay: day, countThatDay: 1 },
            });
        },
        'auto',
    );
    await add(
        'auto-with-nobody-new',
        async (c) => {
            await next(c, admin, c.all, on);
            await next(c, admin, c.all, { auto: { utcDay: day, countThatDay: 1 } });
        },
        'auto',
    );
    await add(
        'auto-count-skips',
        async (c) => {
            await next(c, admin, c.all, on);
            await admit(c, newcomer, { utcDay: day, countThatDay: 2 });
        },
        'auto',
    );
    await add(
        // Two devices that each sign "count 1": the second, signed over the first, must say 2.
        'auto-count-repeats',
        async (c) => {
            await next(c, admin, c.all, on);
            await admit(c, newcomer, { utcDay: day, countThatDay: 1 });
            await admit(c, another, { utcDay: day, countThatDay: 1 });
        },
        'auto',
    );
    await add(
        'auto-count-follows',
        async (c) => {
            await next(c, admin, c.all, on);
            await admit(c, newcomer, { utcDay: day, countThatDay: 1 });
            await admit(c, another, { utcDay: day, countThatDay: 2 });
        },
        5,
    );
    {
        const third = await person(10);
        await add(
            'auto-count-above-the-limit',
            async (c) => {
                await next(c, admin, c.all, on);
                await admit(c, newcomer, { utcDay: day, countThatDay: 1 });
                await admit(c, another, { utcDay: day, countThatDay: 2 });
                await admit(c, third, { utcDay: day, countThatDay: 3 });
                return { extra: [third] };
            },
            'auto',
        );
    }
    await add(
        'auto-on-an-earlier-day',
        async (c) => {
            await next(c, admin, c.all, on);
            await admit(c, newcomer, { utcDay: day, countThatDay: 1 });
            await admit(c, another, { utcDay: '2026-11-09', countThatDay: 1 });
        },
        'auto',
    );
    await add(
        'auto-on-the-next-day-starts-at-one',
        async (c) => {
            await next(c, admin, c.all, on);
            await admit(c, newcomer, { utcDay: day, countThatDay: 1 });
            await admit(c, another, { utcDay: '2026-11-11', countThatDay: 1 });
        },
        5,
    );

    // Rule 11: the recovery roster. The kit holder signs their own promotion, with the kit.
    const promote = (c: Company, who = c.e.keeper) => withEntry(c, roles(who, OWNER_ROLES));
    const recover = (c: Company, org: OrgRosterOptions = {}, members = promote(c)) =>
        next(c, keeper, members, { kit: 1, ...org }, []);
    await add('recovery-roster', async (c) => void (await recover(c)), 3);
    await add(
        'recovery-without-the-kit-signature',
        async (c) => void (await next(c, keeper, promote(c), {}, [])),
        'kitSigned',
    );
    await add(
        'recovery-with-another-kit',
        async (c) => void (await recover(c, { kit: 2 })),
        'kitSigned',
    );
    await add(
        'recovery-with-an-earlier-kit',
        async (c) => {
            await next(c, owner, c.all, replacedWithKit);
            await recover(c, { kit: 1 });
        },
        'kitSigned',
    );
    await add(
        'recovery-with-the-current-kit',
        async (c) => {
            await next(c, owner, c.all, replacedWithKit);
            await recover(c, { kit: 2 });
        },
        4,
    );
    await add(
        // The kit's signature over another roster version: a genuine one, from one roster later.
        'recovery-kit-signature-over-another-version',
        async (c) => {
            const later = await companyStart(cast);
            await next(later, admin);
            const moved = await recover(later);
            await recover(c);
            c.h.rosters[2] = { ...c.h.rosters[2]!, kitSignature: moved.kitSignature };
        },
        'kitSigned',
    );
    await add(
        // And over another statement at the same version: the same promotion with other heads.
        'recovery-kit-signature-over-another-statement',
        async (c) => {
            const other = await companyStart(cast);
            await next(other, admin, other.all, {
                heads: { headsDigest: encode(pattern(32, 241)) },
            });
            const moved = await recover(other);
            await next(c, admin);
            await recover(c);
            c.h.rosters[3] = { ...c.h.rosters[3]!, kitSignature: moved.kitSignature };
        },
        'kitSigned',
    );
    await add(
        // An Admin who holds the group seed and the kit holder's identity keys, and no kit: the
        // holder's own signature in the kit's place.
        'recovery-signed-with-identity-keys-for-the-kit',
        async (c) => {
            await next(c, keeper, promote(c), {}, []);
            await resign(c.h, keeper, async (statement, roster) =>
                signHybrid(await recoveryStatementOf(statement, roster), keeper.signer),
            );
        },
        'kitSigned',
    );
    await add(
        // The kit's keys under the group's ML-DSA context: its own context is the only one taken.
        'recovery-kit-signature-under-the-group-context',
        async (c) => {
            await next(c, keeper, promote(c), {}, []);
            const kit = (await kitAt(1)).signer;
            await resign(c.h, keeper, async (statement, roster) => {
                const message = await recoveryStatementOf(statement, roster);
                const signature = new Uint8Array(HYBRID_SIGNATURE_BYTES);
                signature.set(await signStatement(message, kit.signingKey));
                signature.set(
                    mlDsaSign(message, kit.mlDsaSecretKey, GROUP_SIGNATURE_CONTEXT),
                    SIGNATURE_BYTES,
                );
                return signature;
            });
        },
        'kitSigned',
    );
    await add(
        'recovery-with-a-second-change',
        async (c) =>
            void (await recover(c, {}, [
                ...promote(c).filter((entry) => entry.userId !== member.userId),
                left(c.e.member),
            ])),
        'recovery',
    );
    {
        const { next: keeper2 } = await succeed(keeper);
        await add(
            'recovery-changes-the-signers-keys',
            async (c) => {
                await recover(c, {}, withEntry(c, keeper2.entry(OWNER_ROLES, 2)));
                return { extra: [keeper2] };
            },
            'recovery',
        );
    }
    await add(
        'recovery-to-less-than-owner',
        async (c) => void (await recover(c, {}, withEntry(c, roles(c.e.keeper, ADMIN_ROLES)))),
        // `recovery` is given up without a new kit before rule 11 is reached.
        'kitFollows',
    );
    await add(
        'recovery-with-an-area-row',
        async (c) =>
            void (await next(c, keeper, promote(c), { kit: 1 }, [await orgRowAt(AREA, 2)])),
        'recovery',
    );
    await add(
        'recovery-with-another-company-key',
        async (c) => void (await recover(c, { custodyVersion: 2 })),
        'recovery',
    );
    await add('recovery-with-other-rules', async (c) => void (await recover(c, on)), 'recovery');
    await add(
        'recovery-with-other-heads',
        async (c) => void (await recover(c, { heads: { headsDigest: encode(pattern(32, 241)) } })),
        'recovery',
    );
    await add(
        'recovery-with-auto',
        async (c) => void (await recover(c, { auto: { utcDay: day, countThatDay: 1 } })),
        'recovery',
    );
    await add(
        // Someone without `recovery` holds the kit: it signs nothing a device accepts.
        'recovery-by-a-member',
        async (c) => void (await next(c, member, promote(c, c.e.member), { kit: 1 }, [])),
        'notHolder',
    );
    await add(
        // For someone else's promotion: the signer's own entry is the one that changes.
        'recovery-of-someone-else',
        async (c) => void (await recover(c, {}, promote(c, c.e.member))),
        'recovery',
    );
    await add(
        'recovery-under-another-group-key',
        async (c) => {
            await recover(c);
            const roster = c.h.statements.at(-1)!;
            c.h.rosters[2] = await signRecoveryRoster(
                roster,
                await groupKeyAt(2),
                keeper.signer,
                (await kitAt(1)).signer,
            );
        },
        'groupSigned',
    );
    // The invariant the recovery roster rests on: an Owner demoted to "can use the kit" was a
    // `members` holder dropped, so the group key they held is replaced before any roster follows.
    const demoted = (c: Company) => withEntry(c, roles(c.e.second, ['recovery']));
    await add(
        'demoted-owner-recovers-under-the-key-they-held',
        async (c) => {
            await next(c, owner, demoted(c), replaced);
            await next(c, second, withEntry(c, roles(c.e.second, OWNER_ROLES)), { kit: 1 }, []);
        },
        'holderLeft',
    );
    await add(
        'demoted-owner-recovers-under-the-new-key',
        async (c) => {
            await next(c, owner, demoted(c), replaced);
            await c.h.succession(owner);
            await next(c, second, withEntry(c, roles(c.e.second, OWNER_ROLES)), { kit: 1 }, []);
        },
        4,
    );
    return cases;
}

/* The message a refused case's acceptance must give, or null. */
export function refusalOf(c: CompanyCase) {
    return c.refusal ? REFUSALS[c.refusal] : null;
}

/* Whether an error is the refusal a case names (a CryptoError with exactly that message). */
export function isRefusal(error: unknown, refusal: Refusal) {
    return error instanceof CryptoError && error.message === REFUSALS[refusal];
}

/* Seals both twins make, open and judge alike (web-company.json, core-company.json) ------------- */

/*
 * One sealed thing and what opening it must say, with everything named by
 * seed so either twin rebuilds the keys: `sealer` and `reader` are testkit
 * people by number, the company key and the kit are the testkit's at the
 * versions the context names, and `through` is how much of the history the
 * opener has accepted.
 */
export type SealItem = {
    name: string;
    kind:
        | 'custody-seal'
        | 'custody-key-seal'
        | 'kit-seal'
        | 'key-escrow'
        | 'custody-previous'
        | 'recovery-request';
    through: number;
    ctx: Record<string, unknown>;
    envelope: string;
    /* A kit seal's proof; a recovery request's signature. */
    proof?: string;
    sealer: number;
    reader?: number;
    /* What the opener says: `opened:<base64url>`, `bad:<sealer id>`, `holds`, `verified` or `refused`; a kit seal has two. */
    expected: string | { check: string; opened: string };
};

async function outcome(open: () => Promise<SealCheck<Uint8Array | true> | Uint8Array | string>) {
    try {
        const result = await open();
        if (typeof result === 'string') return result;
        if (result instanceof Uint8Array) return `opened:${encode(result)}`;
        if (result.status === 'bad') return `bad:${result.sealerUserId}`;
        return result.value === true ? 'holds' : `opened:${encode(result.value)}`;
    } catch (error) {
        if (error instanceof CryptoError) return 'refused';
        throw error;
    }
}

/* What this twin says of a sealed item, on the chain accepted through `item.through`. */
export async function sealItemVerdict(
    item: SealItem,
    chainAt: (through: number) => Promise<AcceptedRosters>,
): Promise<SealItem['expected']> {
    const chain = await chainAt(item.through);
    const sealer = await person(item.sealer);
    const opening = { chain, sealerMlDsaPublicKey: decode(sealer.served.mlDsaPublicKey) };
    const envelope = decode(item.envelope);
    const custodySeed = async () =>
        (await custodyAt((item.ctx as { custodyKeyVersion: number }).custodyKeyVersion)).seed;
    switch (item.kind) {
        case 'custody-seal':
            return outcome(async () =>
                openCustodySeal(envelope, item.ctx as CustodySealContext, {
                    ...opening,
                    custodySeed: await custodySeed(),
                }),
            );
        case 'custody-key-seal': {
            const reader = await person(item.reader!);
            return outcome(() =>
                openCustodyKey(envelope, item.ctx as CustodyKeySealContext, {
                    ...opening,
                    reader: { userId: reader.userId, keyVersion: 1 },
                    holder: reader.secrets,
                }),
            );
        }
        case 'kit-seal': {
            const ctx = item.ctx as KitSealContext;
            const kit = await kitAt(ctx.kitVersion, ctx.groupId);
            return {
                check: await outcome(async () =>
                    checkKitSeal(envelope, decode(item.proof!), ctx, {
                        ...opening,
                        kitKemPublicKey: decode(kit.publicKeys.kemPublicKey),
                        custodySeed: await custodySeed(),
                    }),
                ),
                opened: await outcome(() =>
                    openKitSeal(envelope, ctx, { ...opening, kitSecret: kit.secret }),
                ),
            };
        }
        case 'key-escrow':
            return outcome(async () =>
                openKeyEscrow(envelope, item.ctx as KeyEscrowContext, {
                    ...opening,
                    custodySeed: await custodySeed(),
                }),
            );
        case 'custody-previous':
            return outcome(async () =>
                openCustodyPrevious(envelope, item.ctx as CustodyPreviousContext, {
                    ...opening,
                    custodySeed: await custodySeed(),
                }),
            );
        case 'recovery-request':
            return outcome(async () => {
                await verifyRecoveryRequest(envelope, decode(item.proof!), {
                    chain,
                    requesterMlDsaPublicKey: opening.sealerMlDsaPublicKey,
                });
                return 'verified';
            });
    }
}

/* A seal kind built by hand: any payload under the real statement, as a hostile or broken client would seal. */
async function kindFrom(
    statement: (sealed: Uint8Array) => Promise<Uint8Array>,
    info: string,
): Promise<HybridSealKind> {
    const parts = JSON.parse(new TextDecoder().decode(await statement(new Uint8Array(0))));
    return {
        info,
        associatedData: encodeStatement((parts as unknown[]).slice(0, -1)),
        statement,
        noun: 'x',
        invalid: 'x',
        unsigned: 'x',
    };
}

/*
 * A company's history with its key replaced twice (rosters 3 and 4, the
 * second with a new kit), and every seal of its life made along it, with a
 * few a hostile client made. `history` is what acceptance takes for all four
 * rosters; each item says how far its opener has accepted.
 */
export async function companySeals() {
    const cast = await companyCast();
    const { owner, second, admin, keeper } = cast;
    const c = await companyStart(cast);
    await c.h.roster(owner, c.all, undefined, undefined, { custodyVersion: 2 });
    await c.h.roster(second, c.all, undefined, undefined, { custodyVersion: 3, kitVersion: 2 });
    const input = await companyInput(c.h, cast);
    const chainAt = async (through: number) => {
        const chain = await acceptRosters({ ...input, rosters: input.rosters.slice(0, through) });
        if (chain.status !== 'accepted') throw new Error('not accepted');
        return chain;
    };
    const chains = [await chainAt(1), await chainAt(2), await chainAt(3), await chainAt(4)];
    const at = (through: number) => ({
        rosterVersion: through,
        rosterDigest: chains[through - 1]!.rosterDigest,
    });
    const keys = [await custodyAt(1), await custodyAt(2), await custodyAt(3)];
    const kits = [await kitAt(1), await kitAt(2)];
    const kem = (version: number) => decode(keys[version - 1]!.publicKey.kemPublicKey);
    const toKey = (version: number) => ({
        encryptionPublicKey: decode(keys[version - 1]!.publicKey.encryptionPublicKey),
        kemPublicKey: kem(version),
    });
    const groupSeed = pattern(64, 91);
    const areaKey = areaKeyAt(AREA, 1);
    const items: SealItem[] = [];
    const add = (
        item: Omit<SealItem, 'envelope' | 'proof'>,
        envelope: Uint8Array,
        proof?: Uint8Array,
    ) =>
        items.push({
            ...item,
            envelope: encode(envelope),
            ...(proof ? { proof: encode(proof) } : {}),
        });
    const opened = (value: Uint8Array) => `opened:${encode(value)}`;

    // At creation (roster 1): the folder's key, the seed to the kit with its proof, the escrow.
    const sealAt1: CustodySealContext = {
        groupId: GROUP,
        workspaceId: AREA,
        workspaceKeyVersion: 1,
        custodyKeyVersion: 1,
        sealerUserId: owner.userId,
        ...at(1),
    };
    add(
        {
            name: 'folder-key-at-creation',
            kind: 'custody-seal',
            through: 4,
            ctx: sealAt1,
            sealer: 1,
            expected: opened(areaKey),
        },
        await sealCustody(areaKey, sealAt1, {
            chain: chains[0]!,
            custodyKemPublicKey: kem(1),
            sealer: owner.signer,
        }),
    );
    const kitAt1: KitSealContext = {
        groupId: GROUP,
        custodyKeyVersion: 1,
        kitVersion: 1,
        sealerUserId: owner.userId,
        ...at(1),
    };
    const first = await sealKit(keys[0]!.seed, kitAt1, {
        chain: chains[0]!,
        kitKemPublicKey: decode(kits[0]!.publicKeys.kemPublicKey),
        custodyKemPublicKey: kem(1),
        sealer: owner.signer,
    });
    add(
        {
            name: 'kit-seal-at-creation',
            kind: 'kit-seal',
            through: 4,
            ctx: kitAt1,
            sealer: 1,
            expected: { check: 'holds', opened: opened(keys[0]!.seed) },
        },
        first.kitSeal,
        first.proof,
    );
    // A kit seal with junk in place of the seed, and a proof of its own coins: the check names
    // the sealer, and the kit opens it to nothing the chain names.
    const kitKind = await kindFrom(
        (sealed) => kitSealStatement(kitAt1, sealed),
        'hushos/group/kit-seal/v1',
    );
    const coins = pattern(SEAL_COINS_BYTES, 12);
    const junk = await sealWithCoins(
        pattern(96, 13),
        {
            encryptionPublicKey: decode(kits[0]!.publicKeys.encryptionPublicKey),
            kemPublicKey: decode(kits[0]!.publicKeys.kemPublicKey),
        },
        owner.signer,
        kitKind,
        coins,
    );
    add(
        {
            name: 'kit-seal-of-junk',
            kind: 'kit-seal',
            through: 4,
            ctx: kitAt1,
            sealer: 1,
            expected: { check: `bad:${owner.userId}`, opened: 'refused' },
        },
        junk,
        await sealHybrid(
            coins,
            toKey(1),
            owner.signer,
            await kindFrom(
                (sealed) => kitSealProofStatement(kitAt1, junk, sealed),
                'hushos/group/kit-seal-proof/v1',
            ),
        ),
    );
    // A proof for another kit seal is no proof of this one.
    const again = await sealKit(keys[0]!.seed, kitAt1, {
        chain: chains[0]!,
        kitKemPublicKey: decode(kits[0]!.publicKeys.kemPublicKey),
        custodyKemPublicKey: kem(1),
        sealer: owner.signer,
    });
    add(
        {
            name: 'kit-seal-with-another-seals-proof',
            kind: 'kit-seal',
            through: 4,
            ctx: kitAt1,
            sealer: 1,
            expected: { check: 'refused', opened: opened(keys[0]!.seed) },
        },
        first.kitSeal,
        again.proof,
    );
    const escrowAt1: KeyEscrowContext = {
        groupId: GROUP,
        groupKeyVersion: 1,
        custodyKeyVersion: 1,
        sealerUserId: owner.userId,
        ...at(1),
    };
    add(
        {
            name: 'escrow-at-creation',
            kind: 'key-escrow',
            through: 4,
            ctx: escrowAt1,
            sealer: 1,
            expected: opened(groupSeed),
        },
        await sealKeyEscrow(groupSeed, escrowAt1, {
            chain: chains[0]!,
            custodyKemPublicKey: kem(1),
            sealer: owner.signer,
        }),
    );
    add(
        // The Owner's app escrows another seed: it opens, and is not the chain's group key.
        {
            name: 'escrow-of-another-seed',
            kind: 'key-escrow',
            through: 4,
            ctx: escrowAt1,
            sealer: 1,
            expected: `bad:${owner.userId}`,
        },
        await sealHybrid(
            pattern(64, 92),
            toKey(1),
            owner.signer,
            await kindFrom(
                (sealed) => keyEscrowStatement(escrowAt1, sealed),
                'hushos/group/key-escrow/v1',
            ),
        ),
    );

    // With everyone in (roster 2): the seed to an Admin, and a kit holder's request.
    const seedAt2: CustodyKeySealContext = {
        groupId: GROUP,
        custodyKeyVersion: 1,
        holderUserId: admin.userId,
        holderKeyVersion: 1,
        sealerUserId: owner.userId,
        ...at(2),
    };
    const seedSeal = await sealCustodyKey(keys[0]!.seed, seedAt2, {
        chain: chains[1]!,
        holderKemPublicKey: admin.kemPublicKey,
        sealer: owner.signer,
    });
    add(
        {
            name: 'seed-to-an-admin',
            kind: 'custody-key-seal',
            through: 2,
            ctx: seedAt2,
            sealer: 1,
            reader: 3,
            expected: opened(keys[0]!.seed),
        },
        seedSeal,
    );
    add(
        {
            name: 'seed-read-by-another-admin',
            kind: 'custody-key-seal',
            through: 2,
            ctx: seedAt2,
            sealer: 1,
            reader: 8,
            expected: 'refused',
        },
        seedSeal,
    );
    const request = await signRecoveryRequest(
        {
            groupId: GROUP,
            requesterUserId: keeper.userId,
            requesterKeyVersion: 1,
            kitVersion: 1,
            custodyKeyVersion: 1,
            ...at(2),
            requestedAt: '2026-11-03T09:00:00.000Z',
        },
        { chain: chains[1]!, signer: keeper.signer },
    );
    add(
        {
            name: 'recovery-request',
            kind: 'recovery-request',
            through: 2,
            ctx: {},
            sealer: 5,
            expected: 'verified',
        },
        request.statement,
        request.signature,
    );
    add(
        // After the kit is replaced, a request for the old one is no request.
        {
            name: 'recovery-request-for-a-replaced-kit',
            kind: 'recovery-request',
            through: 4,
            ctx: {},
            sealer: 5,
            expected: 'refused',
        },
        request.statement,
        request.signature,
    );
    add(
        // Signed by an Admin's keys in the kit holder's name.
        {
            name: 'recovery-request-signed-by-another',
            kind: 'recovery-request',
            through: 2,
            ctx: {},
            sealer: 5,
            expected: 'refused',
        },
        request.statement,
        await signHybrid(request.statement, admin.signer),
    );

    // The first replacement (roster 3, by the Owner): previousEnvelope, the folder re-sealed by an Admin.
    const previousAt3: CustodyPreviousContext = {
        groupId: GROUP,
        custodyKeyVersion: 2,
        previousVersion: 1,
        sealerUserId: owner.userId,
        ...at(3),
    };
    add(
        {
            name: 'previous-envelope-2',
            kind: 'custody-previous',
            through: 4,
            ctx: previousAt3,
            sealer: 1,
            expected: opened(keys[0]!.seed),
        },
        await sealCustodyPrevious(keys[0]!.seed, previousAt3, {
            chain: chains[2]!,
            custodyKemPublicKey: kem(2),
            sealer: owner.signer,
        }),
    );
    const resealAt3: CustodySealContext = {
        ...sealAt1,
        custodyKeyVersion: 2,
        sealerUserId: admin.userId,
        ...at(3),
    };
    add(
        {
            name: 'folder-key-resealed-by-an-admin',
            kind: 'custody-seal',
            through: 4,
            ctx: resealAt3,
            sealer: 3,
            expected: opened(areaKey),
        },
        await sealCustody(areaKey, resealAt3, {
            chain: chains[2]!,
            custodyKemPublicKey: kem(2),
            sealer: admin.signer,
        }),
    );
    add(
        // The Admin's app seals another key under the listed row: it opens to a key the roster does not commit to.
        {
            name: 'folder-key-of-another-key',
            kind: 'custody-seal',
            through: 4,
            ctx: resealAt3,
            sealer: 3,
            expected: `bad:${admin.userId}`,
        },
        await sealHybrid(
            pattern(32, 4),
            toKey(2),
            admin.signer,
            await kindFrom(
                (sealed) => custodySealStatement(resealAt3, sealed),
                'hushos/group/custody-seal/v1',
            ),
        ),
    );
    const byMember: CustodySealContext = { ...resealAt3, sealerUserId: cast.member.userId };
    add(
        // A Member's app makes one by hand: nobody the chain entitles sealed it.
        {
            name: 'folder-key-sealed-by-a-member',
            kind: 'custody-seal',
            through: 4,
            ctx: byMember,
            sealer: 4,
            expected: 'refused',
        },
        await sealHybrid(
            areaKey,
            toKey(2),
            cast.member.signer,
            await kindFrom(
                (sealed) => custodySealStatement(byMember, sealed),
                'hushos/group/custody-seal/v1',
            ),
        ),
    );

    // The second replacement (roster 4, by the second Owner, with a new kit).
    const previousAt4: CustodyPreviousContext = {
        groupId: GROUP,
        custodyKeyVersion: 3,
        previousVersion: 2,
        sealerUserId: second.userId,
        ...at(4),
    };
    add(
        {
            name: 'previous-envelope-3',
            kind: 'custody-previous',
            through: 4,
            ctx: previousAt4,
            sealer: 2,
            expected: opened(keys[1]!.seed),
        },
        await sealCustodyPrevious(keys[1]!.seed, previousAt4, {
            chain: chains[3]!,
            custodyKemPublicKey: kem(3),
            sealer: second.signer,
        }),
    );
    const kitAt4: KitSealContext = {
        groupId: GROUP,
        custodyKeyVersion: 3,
        kitVersion: 2,
        sealerUserId: second.userId,
        ...at(4),
    };
    const latest = await sealKit(keys[2]!.seed, kitAt4, {
        chain: chains[3]!,
        kitKemPublicKey: decode(kits[1]!.publicKeys.kemPublicKey),
        custodyKemPublicKey: kem(3),
        sealer: second.signer,
    });
    add(
        {
            name: 'kit-seal-after-replacement',
            kind: 'kit-seal',
            through: 4,
            ctx: kitAt4,
            sealer: 2,
            expected: { check: 'holds', opened: opened(keys[2]!.seed) },
        },
        latest.kitSeal,
        latest.proof,
    );
    add(
        // The old kit, named for the new key: the chain names kit 2 for it.
        {
            name: 'kit-seal-read-as-the-old-kits',
            kind: 'kit-seal',
            through: 4,
            ctx: { ...kitAt4, kitVersion: 1 },
            sealer: 2,
            expected: { check: 'refused', opened: 'refused' },
        },
        latest.kitSeal,
        latest.proof,
    );
    const escrowAt4: KeyEscrowContext = {
        ...escrowAt1,
        custodyKeyVersion: 3,
        sealerUserId: second.userId,
        ...at(4),
    };
    add(
        {
            name: 'escrow-after-replacement',
            kind: 'key-escrow',
            through: 4,
            ctx: escrowAt4,
            sealer: 2,
            expected: opened(groupSeed),
        },
        await sealKeyEscrow(groupSeed, escrowAt4, {
            chain: chains[3]!,
            custodyKemPublicKey: kem(3),
            sealer: second.signer,
        }),
    );
    return { history: input, items, chainAt };
}

/*
 * What both twins derive alike from fixed seeds: each company key and its
 * words, each kit's four public keys, a folder's notice seed and keys, and a
 * wrapped previous notice seed (made with a fresh nonce: the other twin opens
 * it).
 */
export async function companyKeys() {
    const custody = [];
    for (const version of [1, 2, 3]) {
        const key = await custodyAt(version);
        custody.push({
            version,
            seed: encode(key.seed),
            publicKey: key.publicKey,
            fingerprint: await custodyFingerprint(GROUP, version, key.publicKey),
        });
    }
    const kits = [];
    for (const version of [1, 2])
        kits.push({
            version,
            secret: encode((await kitAt(version)).secret),
            publicKeys: (await kitAt(version)).publicKeys,
        });
    const [before, after] = [
        await noticeSeed(areaKeyAt(AREA, 1), GROUP, AREA),
        await noticeSeed(areaKeyAt(AREA, 2), GROUP, AREA),
    ];
    const ctx = { groupId: GROUP, workspaceId: AREA, toVersion: 2, fromVersion: 1 };
    return {
        custody,
        kits,
        notice: {
            areaKey: encode(areaKeyAt(AREA, 1)),
            workspaceId: AREA,
            seed: encode(before),
            publicKey: (await noticeKeys(before)).publicKey,
            next: encode(after),
            ctx,
            wrapped: encode(await wrapPreviousNoticeSeed(before, after, ctx)),
        },
    };
}
