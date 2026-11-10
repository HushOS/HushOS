import { beforeAll, describe, expect, test } from 'vitest';
import {
    EMPLOYEE_LIST,
    HEAD_BEHIND,
    HEAD_FORKED,
    NARROWS,
    NOT_ACTIVE,
    NOT_AN_ADMIN,
    NOT_ENTITLED,
    NOT_THE_BASE,
    areaListDigest,
    areaListStatement,
    clearForkNote,
    committedHead,
    headState,
    parseAreaList,
    readAreaLists,
    readHeads,
    settleAreaFork,
    signAreaListAddition,
    signBaseAreaList,
    signForkDismissal,
    verifyForkDismissal,
    type AreaLists,
    type SignedAreaList,
} from './area-lists';
import {
    FOLDER,
    LIST_REFUSALS,
    OWN,
    folderId,
    folderVerdict,
    listCaseVerdict,
    listCases,
    listStatementCases,
    listStatementVerdict,
    listWorld,
    type ListCase,
    type ListWorld,
} from './company-lists-testkit';
import { CryptoError } from './errors';
import {
    AREA,
    AREA_SEED,
    ENVELOPE,
    GROUP,
    RECORD,
    areaKeyAt,
    atRoster,
    pattern,
    type Person,
} from './group-testkit';
import { acceptRosters, type AcceptedRosters } from './group-trust';
import { folderRecordVerdicts, recordVerdicts } from './group-verdicts';
import { NOT_ON_LIST, openAreaGrant, sealAreaGrant } from './groups';
import { decode, encode } from './keys';
import { metadataStatement, metadataStatements, signStatement } from './signatures';

/*
 * Area lists, heads and the resolver (docs/companies-design.md 2.3). The
 * cases of company-lists-testkit.ts are judged here against what each
 * declares, and by the Rust core against this twin's full verdict
 * (web-company.json, `lists`).
 */

let cases: ListCase[];
beforeAll(async () => {
    cases = await listCases();
}, 600_000);

async function chainOf(w: ListWorld, through = w.h.rosters.length): Promise<AcceptedRosters> {
    const input = await w.input();
    const chain = await acceptRosters({ ...input, rosters: input.rosters.slice(0, through) });
    if (chain.status !== 'accepted') throw new Error('not accepted');
    return chain;
}

/* A device that has read the heads and FOLDER's list at the world's head. */
async function reading(w: ListWorld, folder = FOLDER, served = w.served(folder)) {
    const chain = await chainOf(w);
    const heads = (await readHeads({ chain, record: null, served: w.heads })).record;
    const lists = await readAreaLists({
        chain,
        heads,
        workspaceId: folderId(folder),
        record: null,
        served,
        mlDsaKeys: (await w.input()).mlDsaKeys,
    });
    return { chain, heads, lists };
}

describe('the cases of 2.3', () => {
    test('every case reads as it declares, and every rule has a case on each side', async () => {
        const said = new Set<string>();
        for (const c of cases) {
            const verdict = await listCaseVerdict(c);
            expect(c.holds(verdict), c.name).toBe(true);
            for (const step of verdict) {
                if ('error' in step.lists) said.add(step.lists.error);
                else for (const at of step.lists.refused) said.add(at.reason);
                if (step.heads && 'error' in step.heads) said.add(step.heads.error);
                if (step.writable && step.writable !== 'ok') said.add(step.writable);
            }
        }
        // Each refusal the module words is given by some case.
        for (const [name, sentence] of Object.entries(LIST_REFUSALS))
            expect(said.has(sentence), name).toBe(true);
        expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
    }, 600_000);
});

describe('the statements', () => {
    test('a list has one encoding, and two lists with the same people have different digests', async () => {
        const kit = await listStatementCases();
        for (const c of kit.statements) {
            const verdict = listStatementVerdict(c.kind, c.statement);
            // Valid: its fields encode back to the very bytes. Anything else is refused.
            expect(verdict, c.name).toBe(c.valid ? c.statement : 'refused');
        }
        const list = parseAreaList(decode(kit.statements[0]!.statement));
        const again = { ...list, nonce: encode(pattern(16, 5)) };
        expect(await areaListDigest(areaListStatement(again))).not.toBe(
            await areaListDigest(areaListStatement(list)),
        );
        expect(new TextDecoder().decode(areaListStatement(list))).toBe(
            JSON.stringify([
                'hushos/group/area-list',
                1,
                list.groupId,
                list.workspaceId,
                list.listVersion,
                list.previousListDigest,
                list.workspaceKeyVersion,
                list.signerUserId,
                list.signerKeyVersion,
                list.rosterVersion,
                list.rosterDigest,
                list.nonce,
                list.everyone,
                list.people.map((person) => [person.userId, person.role]),
            ]),
        );
    });

    test('the heads digest is over every row, in order, and refuses rows out of order or twice', async () => {
        const kit = await listStatementCases();
        const digests = kit.heads.map((at) => at.digest);
        expect(digests.slice(3)).toEqual([null, null, null]);
        expect(new Set(digests.slice(0, 3)).size).toBe(3);
        // SHA-256("hushos/group/share-log/v1" ‖ groupId ‖ workspaceId).
        const bytes = new TextEncoder().encode(`hushos/group/share-log/v1${GROUP}${AREA}`);
        expect(kit.shareLogStart).toBe(
            encode(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))),
        );
    });

    test('headState: level, behind, ahead and forked by where the committed head lies', () => {
        const record = { first: 3, digests: ['c', 'd', 'e'] };
        expect(headState(record, { position: 5, digest: 'e' }, null)).toBe('level');
        expect(headState(record, { position: 4, digest: 'd' }, null)).toBe('ahead');
        expect(headState(record, { position: 4, digest: 'x' }, null)).toBe('forked');
        // Past the record: behind until the server has answered; forked once it has and nothing reaches.
        expect(headState(record, { position: 6, digest: 'f' }, null)).toBe('behind');
        expect(headState(record, { position: 6, digest: 'f' }, true)).toBe('behind');
        expect(headState(record, { position: 6, digest: 'f' }, false)).toBe('forked');
        // Before anything the device holds: not on its record.
        expect(headState(record, { position: 2, digest: 'b' }, null)).toBe('forked');
    });
});

describe('who writes in a company folder', () => {
    test('the folder’s rows apply only where the signature held for someone active on the roster', () => {
        // Verified by the roster, or by the reader's own pin (no `via`): the list still decides.
        for (const via of [GROUP, null]) {
            expect(folderVerdict('verified', via, 'roster', 'not-on-this-folder')).toEqual({
                integrity: 'not-on-this-folder',
                via: null,
            });
            expect(folderVerdict('verified', via, 'roster', 'unchecked')).toEqual({
                integrity: 'unchecked',
                via: null,
            });
            for (const standing of ['listed', 'data-admin', 'share'] as const)
                expect(folderVerdict('verified', via, 'roster', standing)).toEqual({
                    integrity: 'verified',
                    via,
                });
        }
        expect(folderVerdict('retired-key', null, 'roster', 'not-on-this-folder').integrity).toBe(
            'not-on-this-folder',
        );
        // Never a bad signature, and a bad signature is never excused by the list.
        for (const standing of ['unchecked', 'listed', 'not-on-this-folder'] as const) {
            expect(folderVerdict('bad-signature', null, 'roster', standing).integrity).toBe(
                'bad-signature',
            );
            expect(folderVerdict('unsigned', null, 'roster', standing).integrity).toBe('unsigned');
            // Leaving, a key conflict and a writer outside the roster read as design 2.8 has them.
            expect(folderVerdict('former-member', null, 'former-member', standing).integrity).toBe(
                'former-member',
            );
            expect(folderVerdict('key-conflict', null, 'key-conflict', standing).integrity).toBe(
                'key-conflict',
            );
            expect(folderVerdict('verified', null, 'outside', standing).integrity).toBe('verified');
        }
    });

    test('a record reads by the roster and then by the list: a colleague off the folder, checked or not, is not-on-this-folder', async () => {
        const w = await listWorld();
        const { member, biller, keeper, admin, another } = w.cast;
        await w.add(FOLDER, member, [{ userId: keeper.userId, role: 'editor' }]);
        const { chain, lists } = await reading(w);
        const workspaceId = folderId(FOLDER);
        const record = { ...RECORD, workspaceId };
        const verdictOf = async (
            who: Person,
            folder: { lists: AreaLists | null; sharedEditors?: string[] } | undefined,
            options: { pinned?: boolean; signedBy?: Person } = {},
        ) => {
            const read = (input: Parameters<typeof recordVerdicts>[0]) =>
                folder ? folderRecordVerdicts({ ...input, folder }) : recordVerdicts(input);
            const verdict = read({
                groupId: GROUP,
                workspaceId,
                reading: { status: 'accepted', chain },
                writers: [
                    {
                        userId: who.userId,
                        pinned: options.pinned ? await who.pinned() : null,
                        served: who.served,
                        links: [],
                        personal: null,
                    },
                ],
                trusted: new Map(),
                me: w.cast.owner.userId,
                areas: { [workspaceId]: 1 },
            });
            return verdict(
                () => metadataStatements(record, ENVELOPE),
                who.userId,
                encode(
                    await signStatement(
                        await metadataStatement(record, ENVELOPE),
                        (options.signedBy ?? who).signer.signingKey,
                    ),
                ),
            );
        };
        const folder = { lists };
        // A manager and an editor on the list, and an Admin who is on no list: by the company.
        for (const who of [member, keeper, admin])
            expect(await verdictOf(who, folder)).toEqual({ integrity: 'verified', via: GROUP });
        // A viewer, and a colleague on no list: the signature held, the standing did not.
        for (const who of [biller, another])
            expect(await verdictOf(who, folder)).toEqual({
                integrity: 'not-on-this-folder',
                via: null,
            });
        // The reader's own words check says whose keys these are, not that they are on the folder.
        expect(await verdictOf(another, folder, { pinned: true })).toEqual({
            integrity: 'not-on-this-folder',
            via: null,
        });
        expect(await verdictOf(member, folder, { pinned: true })).toEqual({
            integrity: 'verified',
            via: null,
        });
        // A colleague who edits by a share record that verifies: by the company.
        expect(await verdictOf(another, { lists, sharedEditors: [another.userId] })).toEqual({
            integrity: 'verified',
            via: GROUP,
        });
        // The list did not load: couldn't check, for the manager too. Never without a list.
        expect((await verdictOf(member, { lists: null })).integrity).toBe('unchecked');
        expect((await verdictOf(member, undefined)).integrity).toBe('unchecked');
        // A signature that fails under the roster's keys is a bad signature, on the folder or off it.
        expect((await verdictOf(member, folder, { signedBy: biller })).integrity).toBe(
            'bad-signature',
        );
        expect((await verdictOf(another, folder, { signedBy: biller })).integrity).toBe(
            'bad-signature',
        );
    });
});

describe('signing lists', () => {
    test('a base list is signed only as acceptance will take it', async () => {
        const w = await listWorld();
        const { admin, member, biller, newcomer } = w.cast;
        const chain = await chainOf(w);
        type Base = Parameters<typeof signBaseAreaList>[0];
        const base: Base = {
            chain,
            groupId: GROUP,
            workspaceId: folderId(3),
            workspaceKeyVersion: 1,
            listVersion: 1,
            areaKind: 'shared',
            everyone: '',
            people: [{ userId: member.userId, role: 'manager' }],
            signerUserId: admin.userId,
            signerKeyVersion: 1,
            signer: admin.signer,
        };
        const signed = await signBaseAreaList(base);
        const list = parseAreaList(decode(signed.statement));
        expect([list.rosterVersion, list.rosterDigest]).toEqual([3, chain.rosterDigest]);
        expect(list.previousListDigest).toBe('');
        expect(signed.digest).toBe(await areaListDigest(decode(signed.statement)));
        // A fresh nonce each time.
        expect((await signBaseAreaList(base)).digest).not.toBe(signed.digest);
        const refused = async (over: Partial<Base>, reason: string) =>
            expect(signBaseAreaList({ ...base, ...over })).rejects.toThrow(reason);
        // Someone who is not in the company, unless the roster that commits it lets them in.
        const withNewcomer: Base['people'] = [
            ...base.people,
            { userId: newcomer.userId, role: 'viewer' },
        ];
        await refused({ people: withNewcomer }, NOT_ACTIVE);
        await signBaseAreaList({
            ...base,
            people: withNewcomer,
            members: [...chain.roster.members, newcomer.entry([])],
        });
        // An employee folder is its assignee's alone; a Member signs no roster; versions follow.
        await refused({ areaKind: 'employee', everyone: 'viewer' }, EMPLOYEE_LIST);
        await refused(
            {
                areaKind: 'employee',
                people: [...base.people, { userId: biller.userId, role: 'viewer' }],
            },
            EMPLOYEE_LIST,
        );
        await refused({ signerUserId: member.userId, signer: member.signer }, NOT_ENTITLED);
        await refused({ signer: member.signer }, 'These are not the sealer’s keys');
        await refused({ workspaceKeyVersion: 2 }, NOT_THE_BASE);
        await refused({ listVersion: 2 }, NOT_THE_BASE);
        await refused({ workspaceId: folderId(FOLDER) }, NOT_THE_BASE);
        // Roster 1's own folders: no roster to name yet.
        const first = await signBaseAreaList({
            ...base,
            chain: null,
            members: [admin.entry(['billing', 'data_admin', 'members', 'recovery'])],
            people: [{ userId: admin.userId, role: 'manager' }],
        });
        expect(parseAreaList(decode(first.statement)).rosterVersion).toBe(0);
    });

    test('an addition is signed only when it would verify, and what it signs then does', async () => {
        const w = await listWorld();
        const { admin, member, biller, keeper, newcomer } = w.cast;
        const { chain, heads, lists } = await reading(w);
        const input = { chain, heads, lists, signerUserId: member.userId, signer: member.signer };
        const signed = await signAreaListAddition({
            ...input,
            add: [{ userId: keeper.userId, role: 'editor' }],
        });
        // The device that signed it reads it back as the next list of its record.
        const read = await readAreaLists({
            chain,
            heads,
            workspaceId: folderId(FOLDER),
            record: lists.record,
            served: [signed],
            mlDsaKeys: (await w.input()).mlDsaKeys,
        });
        expect([read.state, read.listVersion, read.listDigest]).toEqual([
            'ahead',
            2,
            signed.digest,
        ]);
        expect(read.repost).toEqual([{ statement: signed.statement, signature: signed.signature }]);
        const refused = async (
            over: Partial<Parameters<typeof signAreaListAddition>[0]>,
            reason: string,
        ) => expect(signAreaListAddition({ ...input, add: [], ...over })).rejects.toThrow(reason);
        // A viewer signs nothing; nobody lowers a role; nobody outside the company is added.
        await refused({ signerUserId: biller.userId, signer: biller.signer }, NOT_ENTITLED);
        await refused({ add: [{ userId: member.userId, role: 'viewer' }] }, NARROWS);
        await refused({ add: [{ userId: newcomer.userId, role: 'viewer' }] }, NOT_ACTIVE);
        await refused({ signer: biller.signer }, 'These are not the sealer’s keys');
        // An Admin on no list adds, and raises `everyone`; never lowers it.
        const open = await signAreaListAddition({
            ...input,
            add: [],
            everyone: 'editor',
            signerUserId: admin.userId,
            signer: admin.signer,
        });
        expect(parseAreaList(decode(open.statement)).everyone).toBe('editor');
        // An employee folder takes no addition.
        const own = await reading(w, OWN);
        await expect(
            signAreaListAddition({
                chain,
                heads: own.heads,
                lists: own.lists,
                add: [{ userId: member.userId, role: 'viewer' }],
                signerUserId: admin.userId,
                signer: admin.signer,
            }),
        ).rejects.toThrow(EMPLOYEE_LIST);
        // A list read at an earlier roster, or one a caller wrote out by hand, signs nothing.
        await w.roster(admin, w.all);
        const later = await chainOf(w);
        await expect(signAreaListAddition({ ...input, chain: later, add: [] })).rejects.toThrow(
            CryptoError,
        );
        await expect(
            signAreaListAddition({ ...input, lists: structuredClone(lists) as AreaLists, add: [] }),
        ).rejects.toThrow(CryptoError);
    });

    test('nothing is signed on a list that is behind or forked', async () => {
        const w = await listWorld();
        const { admin, member, keeper } = w.cast;
        const first = w.served(FOLDER);
        const mine = await w.add(FOLDER, member, [{ userId: keeper.userId, role: 'editor' }], {
            hidden: true,
        });
        await w.add(FOLDER, admin, [{ userId: w.cast.admin2.userId, role: 'viewer' }]);
        await w.roster(admin, w.all);
        const keys = (await w.input()).mlDsaKeys;
        const at3 = await chainOf(w, 3);
        const heads3 = (await readHeads({ chain: at3, record: null, served: w.heads })).record;
        const before = await readAreaLists({
            chain: at3,
            heads: heads3,
            workspaceId: folderId(FOLDER),
            record: null,
            served: [...first, mine],
            mlDsaKeys: keys,
        });
        const chain = await chainOf(w);
        const heads = (await readHeads({ chain, record: heads3, served: w.heads })).record;
        const read = (served: SignedAreaList[] | null) =>
            readAreaLists({
                chain,
                heads,
                workspaceId: folderId(FOLDER),
                record: before.record,
                served,
                mlDsaKeys: keys,
            });
        const sign = (lists: AreaLists) =>
            signAreaListAddition({
                chain,
                heads,
                lists,
                add: [],
                signerUserId: member.userId,
                signer: member.signer,
            });
        const forked = await read(w.served(FOLDER));
        expect(forked.state).toBe('forked');
        await expect(sign(forked)).rejects.toThrow(HEAD_FORKED);
        // The person clears their note once the fork is settled, not before.
        expect(clearForkNote(forked.record!, forked.fork!).forks).toHaveLength(1);
        const settled = await settleAreaFork({
            chain,
            heads,
            workspaceId: folderId(FOLDER),
            record: forked.record,
            served: w.served(FOLDER),
            mlDsaKeys: keys,
        });
        expect(settled.record!.forks).toHaveLength(1);
        expect(clearForkNote(settled.record!, settled.record!.forks[0]!).forks).toHaveLength(0);
        // With nothing to settle, or nothing served that reaches the head, nothing is taken.
        await expect(
            settleAreaFork({
                chain,
                heads,
                workspaceId: folderId(FOLDER),
                record: settled.record,
                served: w.served(FOLDER),
                mlDsaKeys: keys,
            }),
        ).rejects.toThrow(HEAD_FORKED);
        await expect(
            settleAreaFork({
                chain,
                heads,
                workspaceId: folderId(FOLDER),
                record: forked.record,
                served: first,
                mlDsaKeys: keys,
            }),
        ).rejects.toThrow(HEAD_FORKED);
        // Without the heads read through the latest roster the list is behind.
        const behind = await readAreaLists({
            chain,
            heads: heads3,
            workspaceId: folderId(FOLDER),
            record: before.record,
            served: null,
            mlDsaKeys: keys,
        });
        expect(behind.state).toBe('behind');
        await expect(sign(behind)).rejects.toThrow(HEAD_BEHIND);
    });
});

describe('heads', () => {
    test('the furthest committed head is the highest list version any roster named, and a lower one moves nothing', async () => {
        const w = await listWorld();
        const { admin, member, keeper } = w.cast;
        await w.add(FOLDER, member, [{ userId: keeper.userId, role: 'editor' }]);
        await w.roster(admin, w.all);
        await w.roster(admin, w.all, { commit: { [FOLDER]: 1 } });
        const chain = await chainOf(w);
        const read = await readHeads({ chain, record: null, served: w.heads });
        expect(read.lowered).toEqual([
            { rosterVersion: 5, workspaceId: folderId(FOLDER), list: true, shareLog: false },
        ]);
        const head = committedHead(read.record, folderId(FOLDER))!;
        expect([head.list.listVersion, head.list.rosterVersion]).toEqual([2, 4]);
        expect(head.shareLog.shareLogIndex).toBe(0);
        expect(committedHead(read.record, folderId(9))).toBeNull();
        // Read in two goes, it is the same record; a roster's rows served twice are refused.
        const part = await readHeads({ chain, record: null, served: w.heads.slice(0, 3) });
        expect(part.record.rosterVersion).toBe(3);
        const rest = await readHeads({ chain, record: part.record, served: w.heads });
        expect(rest.record).toEqual(read.record);
        await expect(
            readHeads({ chain, record: null, served: [...w.heads, w.heads[1]!] }),
        ).rejects.toThrow(LIST_REFUSALS.heads);
        expect(read.record.rosterDigest).toBe(chain.rosterDigest);
    });
});

describe('the signed dismissal', () => {
    test('only an Admin signs one, at their latest roster, and it verifies only as signed', async () => {
        const w = await listWorld();
        const { admin, member, owner } = w.cast;
        const chain = await chainOf(w);
        const digest = encode(pattern(32, 1));
        const dismissal = {
            groupId: GROUP,
            workspaceId: folderId(FOLDER),
            kind: 'list' as const,
            committedPosition: 2,
            committedDigest: digest,
            reportedPosition: 2,
            reportedDigest: encode(pattern(32, 2)),
            signerUserId: admin.userId,
            signerKeyVersion: 1,
            ...atRoster(chain),
        };
        const signed = await signForkDismissal(dismissal, { chain, signer: admin.signer });
        const verify = (statement: Uint8Array, signature: Uint8Array, key = admin.mlDsaPublicKey) =>
            verifyForkDismissal(statement, signature, { chain, signerMlDsaPublicKey: key });
        expect(await verify(signed.statement, signed.signature)).toEqual(dismissal);
        const flipped = signed.signature.slice();
        flipped[10]! ^= 1;
        await expect(verify(signed.statement, flipped)).rejects.toThrow(CryptoError);
        await expect(
            verify(signed.statement, signed.signature, owner.mlDsaPublicKey),
        ).rejects.toThrow(CryptoError);
        const refused = async (
            over: Partial<typeof dismissal>,
            signer = admin,
            reason = NOT_AN_ADMIN,
        ) =>
            expect(
                signForkDismissal({ ...dismissal, ...over }, { chain, signer: signer.signer }),
            ).rejects.toThrow(reason);
        await refused({ signerUserId: member.userId }, member);
        await refused({ workspaceId: folderId(9) });
        await refused({ signerKeyVersion: 2 });
        await refused({ rosterVersion: 2 }, admin, 'A seal names the latest member list');
        await refused({}, member, 'These are not the sealer’s keys');
    });
});

describe('a company folder’s grant', () => {
    test('opens only for someone the list this device verified entitles', async () => {
        const w = await listWorld({ folders: false });
        const { owner, member, keeper } = w.cast;
        await w.add(0, owner, [{ userId: member.userId, role: 'viewer' }]);
        const { chain, lists } = await reading(w, 0);
        const key = areaKeyAt(AREA, 1);
        const grantTo = async (who: Person) => {
            const ctx = {
                groupId: GROUP,
                workspaceId: AREA,
                workspaceKeyVersion: 1,
                granteeUserId: who.userId,
                granteeKeyVersion: 1,
                granterUserId: owner.userId,
                ...atRoster(chain),
            };
            const envelope = await sealAreaGrant(key, ctx, {
                chain,
                areaIdSeed: AREA_SEED,
                granteeKemPublicKey: who.kemPublicKey,
                granter: owner.signer,
            });
            return (given: AreaLists | null | undefined) =>
                openAreaGrant(envelope, ctx, {
                    chain,
                    areaIdSeed: AREA_SEED,
                    granterMlDsaPublicKey: owner.mlDsaPublicKey,
                    reader: { userId: who.userId, keyVersion: 1 },
                    grantee: who.secrets,
                    lists: given,
                });
        };
        const forMember = await grantTo(member);
        expect(encode(await forMember(lists))).toBe(encode(key));
        // Without the list, or with one this device did not read, nothing opens.
        await expect(forMember(undefined)).rejects.toThrow(NOT_ON_LIST);
        await expect(forMember(null)).rejects.toThrow(NOT_ON_LIST);
        await expect(forMember(structuredClone(lists) as AreaLists)).rejects.toThrow(CryptoError);
        // A member of the company the list does not name: the grant is well made, and opens nothing.
        const forKeeper = await grantTo(keeper);
        await expect(forKeeper(lists)).rejects.toThrow(NOT_ON_LIST);
    });
});
