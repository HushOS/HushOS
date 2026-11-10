import { describe, expect, test } from 'vitest';
import { companyCast, companyStart } from './company-testkit';
import { CryptoError } from './errors';
import {
    AREA,
    HEADS_DIGEST,
    OWNER_ROLES,
    custodyAt,
    custodyFieldAt,
    history,
    kitAt,
    orgRowAt,
    person,
    rootKeyAt,
    areaKeyAt,
    listDigestAt,
} from './group-testkit';
import { firstRoster } from './group-trust';
import {
    MAX_AUTO_JOIN_DAILY,
    parseRecoveryRoster,
    parseRoster,
    recoveryRosterStatement,
    rosterMembersDigest,
    rosterStatement,
    type Roster,
} from './groups';
import { digest } from './signatures';

/*
 * Roster format 3 (docs/companies-design.md 2.1): a company's statement, and
 * only a company's. Fourteen parts, each bound by the signatures over the
 * bytes, each with one encoding.
 */

const text = (value: Uint8Array) => new TextDecoder().decode(value);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

async function rosters() {
    const cast = await companyCast();
    const c = await companyStart(cast);
    // Roster 3 changes no entry (`same`); it rotates the folder, and is marked automatic for the layout's sake.
    await c.h.roster(cast.admin, c.all, undefined, [await orgRowAt(AREA, 2)], {
        auto: { utcDay: '2026-11-10', countThatDay: 3 },
        rules: { autoJoin: true, autoJoinDailyLimit: 50 },
    });
    return { cast, c, one: c.h.statements[0]!, two: c.h.statements[1]!, three: c.h.statements[2]! };
}

describe('roster format 3', () => {
    test('the layout: fourteen parts, the format in the signed bytes, every field where the design puts it', async () => {
        const { cast, c, one, three } = await rosters();
        const parts = JSON.parse(text(c.h.rosters[0]!.statement));
        const custody = await custodyFieldAt(1, 1);
        const row = await orgRowAt(AREA, 1);
        expect(parts).toHaveLength(14);
        expect(parts.slice(0, 8)).toEqual([
            'hushos/group/roster',
            3,
            c.h.groupId,
            'org',
            1,
            '',
            1,
            cast.owner.userId,
        ]);
        expect(parts[9]).toEqual([
            [AREA, 1, 'key', row.commitment, row.rootCommitment, 'shared', listDigestAt(AREA, 1)],
        ]);
        expect(parts[10]).toEqual([
            1,
            custody.custodyEncryptionPublicKey,
            custody.custodyKemPublicKeyDigest,
            1,
            custody.kitEncryptionPublicKey,
            custody.kitKemPublicKeyDigest,
            custody.kitSigningPublicKey,
            custody.kitMlDsaPublicKeyDigest,
        ]);
        expect(parts.slice(11)).toEqual([[0, 10], [], [1, HEADS_DIGEST]]);
        // The custody field names the lattice keys by the SHA-256 of the served key.
        expect(custody.custodyKemPublicKeyDigest).toBe(
            await digest(Buffer.from((await custodyAt(1)).publicKey.kemPublicKey, 'base64url')),
        );
        expect(custody.kitMlDsaPublicKeyDigest).toBe(
            await digest(Buffer.from((await kitAt(1)).publicKeys.mlDsaPublicKey, 'base64url')),
        );
        // `same`, a rule that is on, and an automatic admission's day and count.
        const later = JSON.parse(text(c.h.rosters[2]!.statement));
        expect(later[8]).toEqual(['same', await rosterMembersDigest(c.h.statements[1]!)]);
        expect(later.slice(11, 13)).toEqual([
            [1, 50],
            ['2026-11-10', 3],
        ]);
        // Parsing gives back what was signed, and re-encodes to the same bytes.
        expect(parseRoster(c.h.rosters[0]!.statement)).toEqual({ ...one, auto: null });
        const parsed = parseRoster(c.h.rosters[2]!.statement);
        expect(parsed.members).toEqual([]);
        expect(parsed.membersSame).toBe(three.membersSame);
        expect(rosterStatement(parsed)).toEqual(c.h.rosters[2]!.statement);
        // The members a resolved roster holds beside `same` are not in its statement.
        expect(rosterStatement(three)).toEqual(c.h.rosters[2]!.statement);
    });

    test('format 3 is a company’s and only a company’s, and neither format parses as the other', async () => {
        const { one } = await rosters();
        const family = await history();
        const organizer = await person(1);
        await family.roster(organizer, [organizer.entry(['billing', 'guardian', 'members'])]);
        const familyRoster = family.statements[0]!;
        // A family at format 3, a company at format 1 or 2: no statement is built.
        const { custody, rules, auto, heads, ...bare } = one;
        for (const roster of [
            { ...one, kind: 'family' as const, members: familyRoster.members },
            { ...familyRoster, kind: 'org' as const },
            { ...familyRoster, kind: 'org' as const, format: 2 as const, areas: [] },
            { ...bare, format: 2 as const, areas: [] },
            // A family's statement takes none of a company's fields.
            { ...familyRoster, custody },
            { ...familyRoster, rules },
            { ...familyRoster, heads },
            { ...familyRoster, auto: { utcDay: '2026-11-10', countThatDay: 1 } },
            { ...familyRoster, membersSame: HEADS_DIGEST },
        ] as Roster[])
            expect(() => rosterStatement(roster), JSON.stringify(roster).slice(0, 80)).toThrow(
                CryptoError,
            );
        void auto;
        // The bytes themselves: a format 2 statement relabelled 3, a format 3 one relabelled 2
        // or cut to ten parts, a format 2 one given four more: none parses.
        const three = JSON.parse(text(rosterStatement(one)));
        const two = JSON.parse(text(rosterStatement({ ...familyRoster, format: 2, areas: [] })));
        for (const forged of [
            [two[0], 3, ...two.slice(2)],
            [three[0], 2, ...three.slice(2)],
            [three[0], 2, ...three.slice(2, 10)],
            three.slice(0, 10),
            [...two, three[10], three[11], three[12], three[13]],
            [two[0], 3, ...two.slice(2), three[10], three[11], three[12], three[13]],
            [...three, []],
            three.slice(0, 13),
        ])
            expect(() => parseRoster(bytes(forged)), JSON.stringify(forged).slice(0, 60)).toThrow(
                CryptoError,
            );
        expect(parseRoster(bytes(three)).format).toBe(3);
        expect(parseRoster(bytes(two)).format).toBe(2);
    });

    test('every company field has one encoding and its bounds', async () => {
        const { one, two } = await rosters();
        const base = JSON.parse(text(rosterStatement(one)));
        const later = JSON.parse(
            text(
                rosterStatement({
                    ...two,
                    auto: { utcDay: '2026-11-10', countThatDay: 1 },
                    rules: { autoJoin: true, autoJoinDailyLimit: 10 },
                }),
            ),
        );
        const withPart = (from: unknown[], index: number, value: unknown) =>
            bytes(from.map((part, at) => (at === index ? value : part)));
        expect(parseRoster(withPart(later, 12, ['2026-11-10', MAX_AUTO_JOIN_DAILY])).auto).toEqual({
            utcDay: '2026-11-10',
            countThatDay: 50,
        });
        expect(parseRoster(withPart(base, 13, [0, HEADS_DIGEST])).heads!.areaCount).toBe(0);
        const digestPart = base[10][2] as string;
        for (const [index, value] of [
            // rules: autoJoin 0 or 1, the limit 1 to 50, two parts.
            [11, [2, 10]],
            [11, [0, 0]],
            [11, [0, 51]],
            [11, [0]],
            [11, ['0', 10]],
            // auto: empty or a day and a count from 1 to 50.
            [12, ['2026-11-10']],
            [12, ['2026-11-10', 0]],
            [12, ['2026-11-10', 51]],
            [12, ['2026-13-01', 1]],
            [12, ['2026-11-32', 1]],
            [12, ['26-11-10', 1]],
            [12, ['2026-11-10T00:00:00.000Z', 1]],
            [12, [1, '2026-11-10']],
            // heads: a count and a digest.
            [13, [1]],
            [13, [1, 'AA']],
            [13, [HEADS_DIGEST, 1]],
            // custody: eight parts, versions from 1, keys and digests of 32 bytes.
            [10, base[10].slice(0, 7)],
            [10, [0, ...base[10].slice(1)]],
            [10, [1, 'AA', ...base[10].slice(2)]],
            [10, [...base[10].slice(0, 3), 0, ...base[10].slice(4)]],
            [10, [...base[10].slice(0, 7), `${digestPart}A`]],
            // members: `same` is a digest, and nothing else stands where the list does.
            [8, ['same', 'AA']],
            [8, ['same']],
            [8, ['other', digestPart]],
        ] as [number, unknown][])
            expect(
                () => parseRoster(withPart(later, index, value)),
                JSON.stringify([index, value]),
            ).toThrow(CryptoError);
        // `same` is never roster 1's.
        expect(() => parseRoster(withPart(base, 8, ['same', digestPart]))).toThrow(CryptoError);
        expect(() => rosterStatement({ ...one, membersSame: digestPart })).toThrow(
            'Invalid roster members.',
        );
        // Area rows: seven parts with a kind and a list digest, or a tombstone; never a format 2 row.
        const row = base[9][0] as unknown[];
        for (const rows of [
            [row.slice(0, 5)],
            [[...row.slice(0, 5), 'private', row[6]]],
            [[...row.slice(0, 6), 'AA']],
            [[...row, 'more']],
            [[row[0], 1, 'retired', row[3]]],
        ])
            expect(() => parseRoster(withPart(base, 9, rows)), JSON.stringify(rows)).toThrow(
                CryptoError,
            );
        expect(parseRoster(withPart(later, 9, [[row[0], 2, 'retired']])).areas).toEqual([
            { workspaceId: AREA, workspaceKeyVersion: 2, commitment: '', retired: true },
        ]);
        // A changed byte anywhere in the statement is another statement: the canonical form is exact.
        const spaced = text(rosterStatement(one)).replace(',[0,10]', ', [0,10]');
        expect(() => parseRoster(new TextEncoder().encode(spaced))).toThrow(CryptoError);
    });

    test('the members digest is over the canonical list, whatever statement carried it', async () => {
        const { two, three } = await rosters();
        expect(await rosterMembersDigest(two)).toBe(three.membersSame);
        // The resolved roster 3 holds the same list, so a chain of `same` rosters names one digest.
        expect(await rosterMembersDigest(three)).toBe(three.membersSame);
        const changed = {
            ...two,
            members: two.members.map((entry, index) =>
                index === 0 ? { ...entry, keyVersion: entry.keyVersion + 1 } : entry,
            ),
        };
        expect(await rosterMembersDigest(changed)).not.toBe(three.membersSame);
        const list = JSON.parse(text(rosterStatement(two)))[8];
        expect(three.membersSame).toBe(await digest(bytes(list)));
    });

    test('firstRoster builds a company’s roster 1 at format 3, and refuses what acceptance refuses', async () => {
        const owner = await person(1);
        const org = {
            custodyKey: (await custodyAt(1)).publicKey,
            kit: (await kitAt(1)).publicKeys,
            headsDigest: HEADS_DIGEST,
        };
        const areaKeys = [
            {
                workspaceId: AREA,
                workspaceKey: areaKeyAt(AREA, 1),
                rootKey: rootKeyAt(AREA, 1),
                areaKind: 'shared' as const,
                listDigest: listDigestAt(AREA, 1),
            },
        ];
        const start = await history('org');
        await start.roster(owner, [owner.entry(OWNER_ROLES)]);
        const first = await firstRoster(start.groupId, owner.entry(OWNER_ROLES), {
            kind: 'org',
            areaKeys,
            org,
        });
        expect(rosterStatement(first)).toEqual(start.rosters[0]!.statement);
        expect(first.heads).toEqual({ areaCount: 1, headsDigest: HEADS_DIGEST });
        const build = (roles: Parameters<typeof owner.entry>[0], over = {}) =>
            firstRoster(start.groupId, owner.entry(roles), { kind: 'org', areaKeys, org, ...over });
        // The creator is an Owner: an Admin makes no company key (rule 12) and no company (rule 4).
        await expect(build(['data_admin', 'members'])).rejects.toThrow(
            'A company keeps an active owner.',
        );
        await expect(build(['members'])).rejects.toThrow('This is not one of a company’s roles.');
        // A company needs its key, kit and heads; a family takes none; an area needs its kind and list.
        await expect(build(OWNER_ROLES, { org: undefined })).rejects.toThrow(
            'Invalid roster format.',
        );
        await expect(
            firstRoster(start.groupId, owner.entry(['members']), { kind: 'family', org }),
        ).rejects.toThrow('Invalid roster format.');
        await expect(
            firstRoster(start.groupId, owner.entry(['members']), { kind: 'family', format: 3 }),
        ).rejects.toThrow('Invalid roster format.');
        const [area] = areaKeys;
        await expect(
            build(OWNER_ROLES, { areaKeys: [{ ...area!, areaKind: undefined }] }),
        ).rejects.toThrow('A company folder keeps the kind it was made with.');
        await expect(
            build(OWNER_ROLES, { areaKeys: [{ ...area!, listDigest: undefined }] }),
        ).rejects.toThrow('A company folder’s key needs its list beside it.');
        await expect(
            build(OWNER_ROLES, { org: { ...org, kit: { ...org.kit, mlDsaPublicKey: 'AA' } } }),
        ).rejects.toThrow(CryptoError);
    });

    test('the recovery-roster statement has one layout and one encoding', () => {
        const recovery = {
            groupId: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
            rosterVersion: 7,
            kitVersion: 2,
            rosterDigest: HEADS_DIGEST,
        };
        const statement = recoveryRosterStatement(recovery);
        expect(text(statement)).toBe(
            `["hushos/group/recovery-roster",1,"${recovery.groupId}",7,2,"${HEADS_DIGEST}"]`,
        );
        expect(parseRecoveryRoster(statement)).toEqual(recovery);
        for (const forged of [
            ['hushos/group/recovery-roster', 2, recovery.groupId, 7, 2, HEADS_DIGEST],
            ['hushos/group/roster', 1, recovery.groupId, 7, 2, HEADS_DIGEST],
            ['hushos/group/recovery-roster', 1, recovery.groupId, 7, 2, HEADS_DIGEST, 1],
            ['hushos/group/recovery-roster', 1, recovery.groupId, 0, 2, HEADS_DIGEST],
        ])
            expect(() => parseRecoveryRoster(bytes(forged))).toThrow(CryptoError);
    });
});
