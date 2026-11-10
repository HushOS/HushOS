import { beforeAll, describe, expect, test } from 'vitest';
import {
    EMPLOYEE_LIST,
    HEAD_BEHIND,
    HEAD_FORKED,
    ENTRY_FROM_BEFORE,
    NARROWS,
    NOTHING_ADDED,
    NOT_ACTIVE,
    NOT_AN_ADMIN,
    NOT_ENTITLED,
    NOT_THE_BASE,
    areaListDigest,
    areaListStatement,
    clearForkNote,
    committedHead,
    headState,
    headsToCommit,
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
    folderItems,
    folderVerdict,
    grantItemVerdict,
    listCaseVerdict,
    listCases,
    listStatementCases,
    listStatementVerdict,
    listWorld,
    recordItemVerdict,
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
    OWNER_ROLES,
    areaKeyAt,
    atRoster,
    custodyAt,
    groupKeyAt,
    kitAt,
    pattern,
    person,
    rootKeyAt,
    type Person,
} from './group-testkit';
import { kitMlDsaKeys } from './company-testkit';
import { acceptRosters, firstRoster, nextRoster, type AcceptedRosters } from './group-trust';
import { folderRecordVerdicts, recordVerdicts } from './group-verdicts';
import { sealAreaGrant, signRoster } from './groups';
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
                if (step.commit && 'error' in step.commit) said.add(step.commit.error);
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
            lists: null,
            groupId: GROUP,
            workspaceId: folderId(3),
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
        expect([list.previousListDigest, list.listVersion, list.workspaceKeyVersion]).toEqual([
            '',
            1,
            1,
        ]);
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
        // An employee folder is its assignee's alone; a Member signs no roster.
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
        // A folder the chain has takes a key change only from its list as this device read it.
        await refused({ workspaceId: folderId(FOLDER) }, HEAD_BEHIND);
        const { lists } = await reading(w);
        await refused({ lists }, NOT_THE_BASE);
        // Roster 1's own folders: no roster to name yet.
        const first = await signBaseAreaList({
            ...base,
            chain: null,
            members: [admin.entry(['billing', 'data_admin', 'members', 'recovery'])],
            people: [{ userId: admin.userId, role: 'manager' }],
        });
        expect(parseAreaList(decode(first.statement)).rosterVersion).toBe(0);
    });

    test('a key change’s base list is numbered past everything verified or committed, and is not signed behind or over a fork it has not settled', async () => {
        const w = await listWorld();
        const { admin, member, keeper } = w.cast;
        const hidden = await w.add(FOLDER, member, [{ userId: keeper.userId, role: 'editor' }], {
            hidden: true,
        });
        await w.add(FOLDER, admin, [{ userId: w.cast.admin2.userId, role: 'viewer' }]);
        const theirs = w.served(FOLDER);
        await w.roster(admin, w.all);
        // A roster commits a list the server never serves.
        await w.roster(admin, w.all, {
            commit: { [FOLDER]: { listVersion: 6, listDigest: encode(pattern(32, 9)) } },
        });
        const keys = (await w.input()).mlDsaKeys;
        const at = async (
            through: number,
            record: AreaLists['record'],
            served: SignedAreaList[] | null,
        ) => {
            const chain = await chainOf(w, through);
            const heads = (await readHeads({ chain, record: null, served: w.heads })).record;
            const lists = await readAreaLists({
                chain,
                heads,
                workspaceId: folderId(FOLDER),
                record,
                served,
                mlDsaKeys: keys,
            });
            const sign = () =>
                signBaseAreaList({
                    chain,
                    lists,
                    groupId: GROUP,
                    workspaceId: folderId(FOLDER),
                    areaKind: 'employee',
                    everyone: '',
                    people: [{ userId: member.userId, role: 'manager' }],
                    signerUserId: admin.userId,
                    signerKeyVersion: 1,
                    signer: admin.signer,
                });
            return { lists, sign };
        };
        // Level at roster 4, two lists verified: the next key's base list is list 3, and keeps
        // the folder's kind whatever the caller says.
        const level = await at(4, null, theirs);
        const next = parseAreaList(decode((await level.sign()).statement));
        expect([level.lists.state, next.listVersion, next.workspaceKeyVersion]).toEqual([
            'level',
            3,
            2,
        ]);
        // Behind (not yet answered), nothing is signed.
        const early = (await at(3, null, [theirs[0]!])).lists.record;
        await expect((await at(4, early, null)).sign()).rejects.toThrow(HEAD_BEHIND);
        const mine = (await at(3, null, [theirs[0]!, hidden])).lists.record;
        // Forked from a list it holds another of, nothing is signed until that is settled.
        const forked = await at(4, mine, theirs);
        expect(forked.lists.state).toBe('forked');
        await expect(forked.sign()).rejects.toThrow(HEAD_FORKED);
        // Forked only because nothing reaches the committed head: the key change is the way out,
        // numbered past that head.
        const stuck = await at(5, level.lists.record, theirs);
        expect([stuck.lists.state, stuck.lists.head!.listVersion]).toEqual(['forked', 6]);
        expect(parseAreaList(decode((await stuck.sign()).statement)).listVersion).toBe(7);
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
        ) =>
            expect(
                signAreaListAddition({
                    ...input,
                    add: [{ userId: w.cast.admin2.userId, role: 'viewer' }],
                    ...over,
                }),
            ).rejects.toThrow(reason);
        // A viewer signs nothing; nobody lowers a role; nobody outside the company is added.
        await refused({ signerUserId: biller.userId, signer: biller.signer }, NOT_ENTITLED);
        await refused({ add: [{ userId: member.userId, role: 'viewer' }] }, NARROWS);
        await refused({ add: [{ userId: newcomer.userId, role: 'viewer' }] }, NOT_ACTIVE);
        await refused({ signer: biller.signer }, 'These are not the sealer’s keys');
        // One that changes nothing is not signed: nobody added, nobody raised.
        await refused({ add: [] }, NOTHING_ADDED);
        await refused({ add: [{ userId: member.userId, role: 'manager' }] }, NOTHING_ADDED);
        await refused({ add: [], everyone: '' }, NOTHING_ADDED);
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

describe('a company folder’s grants and records', () => {
    test('a grant is sealed and opened only for someone the verified list entitles, and a record reads by the roster and then the list', async () => {
        const folder = await folderItems();
        const said = new Map<string, string>();
        for (const item of folder.grants)
            said.set(item.name, (await grantItemVerdict(folder, item)).split(':')[0]!);
        for (const item of folder.records)
            said.set(item.name, (await recordItemVerdict(folder, item)).integrity);
        expect(Object.fromEntries(said)).toEqual({
            'grant-to-someone-on-the-list': 'opened',
            'grant-read-without-the-addition': 'refused',
            'grant-read-without-a-list': 'refused',
            'grant-by-an-admin-read-while-they-are-one': 'opened',
            'grant-by-an-admin-since-removed': 'opened',
            'grant-renamed-to-another-granter': 'refused',
            'sealing-to-someone-on-the-list': 'sealed',
            'sealing-to-a-colleague-off-the-list': 'refused',
            'sealing-without-a-list': 'refused',
            'sealing-without-the-addition-that-names-them': 'refused',
            'record-by-an-editor-on-the-list': 'verified',
            'record-by-an-admin-on-no-list': 'verified',
            'record-by-a-viewer': 'not-on-this-folder',
            'record-by-a-colleague-on-no-list': 'not-on-this-folder',
            'record-by-a-colleague-the-reader-checked': 'not-on-this-folder',
            'record-by-an-editor-the-reader-checked': 'verified',
            'record-by-a-colleague-who-edits-by-a-share': 'verified',
            'record-read-with-no-list': 'unchecked',
            'record-read-with-the-list-forked': 'unchecked',
            'record-with-a-bad-signature-on-the-folder': 'bad-signature',
            'record-with-a-bad-signature-off-the-folder': 'bad-signature',
            'record-by-a-checked-colleague-with-the-list-forked': 'unchecked',
        });
        // What opened is the folder's key, and the stored verdicts are these.
        const opened = folder.grants.find(
            (item) => item.name === 'grant-by-an-admin-since-removed',
        )!;
        expect(opened.expected).toBe(`opened:${encode(areaKeyAt(AREA, 1))}`);
        // A list this device did not read entitles nobody.
        const w = await listWorld({ folders: false });
        const { chain, lists } = await reading(w, 0);
        const ctx = {
            groupId: GROUP,
            workspaceId: AREA,
            workspaceKeyVersion: 1,
            granteeUserId: w.cast.owner.userId,
            granteeKeyVersion: 1,
            granterUserId: w.cast.owner.userId,
            ...atRoster(chain),
        };
        const seal = (given: AreaLists) =>
            sealAreaGrant(areaKeyAt(AREA, 1), ctx, {
                chain,
                areaIdSeed: AREA_SEED,
                granteeKemPublicKey: w.cast.owner.kemPublicKey,
                granter: w.cast.owner.signer,
                lists: given,
            });
        await seal(lists);
        await expect(seal(structuredClone(lists) as AreaLists)).rejects.toThrow(CryptoError);
    });
});

describe('the heads a roster commits', () => {
    test('a company is built on heads the device verified, and a roster takes no others', async () => {
        const owner = await person(1);
        const keys = {
            [owner.mlDsaDigest]: owner.served.mlDsaPublicKey,
            ...(await kitMlDsaKeys([1])),
        };
        const entry = owner.entry(OWNER_ROLES);
        const signer = {
            signerUserId: owner.userId,
            signerKeyVersion: 1,
            signer: owner.signer,
        };
        // Roster 1: the folder's base list, the heads over it, and the roster that commits both.
        const base = await signBaseAreaList({
            chain: null,
            lists: null,
            groupId: GROUP,
            workspaceId: AREA,
            areaKind: 'shared',
            everyone: '',
            people: [{ userId: owner.userId, role: 'manager' }],
            members: [entry],
            ...signer,
        });
        const firstHeads = await headsToCommit({
            chain: null,
            groupId: GROUP,
            heads: null,
            lists: [],
            changed: [base],
        });
        const areaKey = (version: number, listDigest: string) => ({
            workspaceId: AREA,
            workspaceKey: areaKeyAt(AREA, version),
            rootKey: rootKeyAt(AREA, version),
            areaKind: 'shared' as const,
            listDigest,
        });
        const org = {
            custodyKey: (await custodyAt(1)).publicKey,
            kit: (await kitAt(1)).publicKeys,
        };
        const first = await firstRoster(GROUP, entry, {
            kind: 'org',
            areaKeys: [areaKey(1, base.digest)],
            org: { ...org, heads: firstHeads },
        });
        expect(first.heads!.headsDigest).toBe(firstHeads.headsDigest);
        // Heads built for another base list, and a digest of the caller's own, sign no roster.
        const other = await signBaseAreaList({
            chain: null,
            lists: null,
            groupId: GROUP,
            workspaceId: AREA,
            areaKind: 'shared',
            everyone: '',
            people: [{ userId: owner.userId, role: 'manager' }],
            members: [entry],
            ...signer,
        });
        const otherHeads = await headsToCommit({
            chain: null,
            groupId: GROUP,
            heads: null,
            lists: [],
            changed: [other],
        });
        const build = (heads: unknown) =>
            firstRoster(GROUP, entry, {
                kind: 'org',
                areaKeys: [areaKey(1, base.digest)],
                org: { ...org, heads: heads as typeof firstHeads },
            });
        await expect(build(otherHeads)).rejects.toThrow('not built for this member list');
        await expect(build({ ...firstHeads })).rejects.toThrow('this device built');
        const rosters = [await signRoster(first, await groupKeyAt(1), owner.signer)];
        const accept = async () => {
            const chain = await acceptRosters({
                groupId: GROUP,
                firstKeys: (await groupKeyAt(1)).publicKey,
                rosters,
                successions: [],
                mlDsaKeys: keys,
                me: { userId: owner.userId, identities: [owner.served] },
                anchor: 'created',
                pins: [],
                cache: null,
            });
            if (chain.status !== 'accepted') throw new Error('not accepted');
            return chain;
        };
        const served = [{ rosterVersion: 1, rows: [...firstHeads.rows] }];
        const read = async (lists: SignedAreaList[]) => {
            const chain = await accept();
            const heads = (await readHeads({ chain, record: null, served })).record;
            return {
                chain,
                heads,
                lists: await readAreaLists({
                    chain,
                    heads,
                    workspaceId: AREA,
                    record: null,
                    served: lists,
                    mlDsaKeys: keys,
                }),
            };
        };
        // Roster 2 changes the folder's key: its base list is list 2, its heads say so, and a
        // device reads the new list level with them.
        const one = await read([base]);
        expect(one.lists.state).toBe('level');
        const rotated = await signBaseAreaList({
            chain: one.chain,
            lists: one.lists,
            groupId: GROUP,
            workspaceId: AREA,
            areaKind: 'shared',
            everyone: 'viewer',
            people: [{ userId: owner.userId, role: 'manager' }],
            ...signer,
        });
        const heads = { chain: one.chain, groupId: GROUP, heads: one.heads };
        const nextHeads = await headsToCommit({ ...heads, lists: [], changed: [rotated] });
        const next = (given: unknown, listDigest = rotated.digest) =>
            nextRoster(one.chain, [entry], {
                signerUserId: owner.userId,
                areaKeys: [areaKey(2, listDigest)],
                org: { heads: given as typeof nextHeads },
            });
        // Heads that leave the key change out, or were built on another roster, are not this roster's.
        const unchanged = await headsToCommit({ ...heads, lists: [one.lists] });
        await expect(next(unchanged)).rejects.toThrow('not built for this member list');
        await expect(next(firstHeads)).rejects.toThrow('not built for this member list');
        await expect(next(nextHeads, base.digest)).rejects.toThrow(CryptoError);
        // A base list numbered at what a roster already committed never reaches the heads.
        await expect(
            headsToCommit({
                ...heads,
                lists: [],
                changed: [{ ...other, statement: base.statement }],
            }),
        ).rejects.toThrow(CryptoError);
        rosters.push(await signRoster(await next(nextHeads), await groupKeyAt(1), owner.signer));
        served.push({ rosterVersion: 2, rows: [...nextHeads.rows] });
        const two = await read([rotated]);
        expect([two.lists.state, two.lists.workspaceKeyVersion, two.lists.listVersion]).toEqual([
            'level',
            2,
            2,
        ]);
        // The row is the list's, and the log's start for a folder nobody shared from.
        expect(nextHeads.rows).toEqual([
            {
                workspaceId: AREA,
                workspaceKeyVersion: 2,
                listVersion: 2,
                listDigest: rotated.digest,
                shareLogIndex: 0,
                shareLogDigest: firstHeads.rows[0]!.shareLogDigest,
            },
        ]);
    });

    test('an addition for someone back from leaving, at the role their old entry names, is not signed', async () => {
        const w = await listWorld();
        const { admin, biller } = w.cast;
        await w.roster(admin, [
            ...w.all.filter((entry) => entry.userId !== biller.userId),
            { ...w.e.biller, status: 'left', roles: [] },
        ]);
        await w.roster(admin, w.all);
        const { chain, heads, lists } = await reading(w);
        const add = (role: 'viewer' | 'editor') =>
            signAreaListAddition({
                chain,
                heads,
                lists,
                add: [{ userId: biller.userId, role }],
                signerUserId: admin.userId,
                signer: admin.signer,
            });
        // The entry is from before they left: the same role again changes nothing a device counts.
        await expect(add('viewer')).rejects.toThrow(ENTRY_FROM_BEFORE);
        // A higher role is a new entry, from the roster that let them back in.
        const raised = parseAreaList(decode((await add('editor')).statement));
        expect(raised.people.find((person) => person.userId === biller.userId)!.role).toBe(
            'editor',
        );
    });
});
