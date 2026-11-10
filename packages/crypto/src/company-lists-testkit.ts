import {
    AFTER_LEAVING,
    EMPLOYEE_LIST,
    HEADS_INCOMPLETE,
    HEADS_MISMATCH,
    HEAD_BEHIND,
    HEAD_FORKED,
    KEYS_REPLACED,
    LIST_RIVAL,
    LIST_STALE,
    NARROWS,
    NOT_ACTIVE,
    NOT_ENTITLED,
    NOT_FOLLOWING_LIST,
    NOT_LIST_SIGNED,
    NOT_ON_CHAIN,
    NOT_THE_BASE,
    areaAccess,
    areaAllows,
    areaGrantsOwed,
    areaListDigest,
    areaListStatement,
    areaOwed,
    dismisses,
    folderStanding,
    forkDismissalStatement,
    headsDigest,
    headsToCommit,
    parseAreaList,
    parseForkDismissal,
    readAreaLists,
    readHeads,
    requireAreaWritable,
    settleAreaFork,
    shareLogStart,
    verifyForkDismissal,
    type AreaAccess,
    type AreaAction,
    type AreaList,
    type AreaListRecord,
    type AreaLists,
    type EveryoneRole,
    type FolderStanding,
    type ForkDismissal,
    type ForkNote,
    type HeadRow,
    type HeadsRecord,
    type ListPerson,
    type SignedAreaList,
} from './area-lists';
import { companyCast, companyInput, rowOf, type CompanyCast } from './company-testkit';
import { CryptoError } from './errors';
import {
    ADMIN_ROLES,
    AREA,
    AREA_SEED,
    ENVELOPE,
    GROUP,
    OWNER_ROLES,
    RECORD,
    areaKeyAt,
    recordSignature,
    history,
    orgRowAt,
    pattern,
    person,
    succeed,
    tombstoneAt,
    type OrgRosterOptions,
    type Person,
} from './group-testkit';
import {
    acceptRosters,
    folderIntegrityOf,
    groupIntegrityOf,
    groupWriterTrust,
    type AcceptInput,
    type AcceptedRosters,
    type GroupIntegrity,
    type GroupWriterTrust,
} from './group-trust';
import {
    openAreaGrant,
    parseGroupSuccession,
    rosterDigest,
    sealAreaGrant,
    type AreaGrantContext,
    type AreaKind,
    type RosterArea,
    type RosterMember,
} from './groups';
import { decode, encode } from './keys';
import { metadataStatements, signHybrid } from './signatures';

/*
 * A company's folders for the list tests and the shared company fixtures
 * (docs/companies-design.md 2.3): a history whose roster rows commit to real
 * base lists and whose heads commit to real rows, a "server" that stores the
 * lists and may hide one from a signer or serve another in its place, and the
 * cases that keep or break each rule of 2.3, one at a time. A case is a
 * device reading that history step by step; both twins must give the same
 * verdict at every step, record included (web-company.json, `lists`). Not
 * part of the package's exports.
 */

/* The refusals of area-lists.ts, by the name the cases use. */
export const LIST_REFUSALS = {
    afterLeaving: AFTER_LEAVING,
    employee: EMPLOYEE_LIST,
    heads: HEADS_MISMATCH,
    behind: HEAD_BEHIND,
    forked: HEAD_FORKED,
    stale: LIST_STALE,
    narrows: NARROWS,
    notActive: NOT_ACTIVE,
    notEntitled: NOT_ENTITLED,
    notFollowing: NOT_FOLLOWING_LIST,
    notSigned: NOT_LIST_SIGNED,
    notOnChain: NOT_ON_CHAIN,
    notTheBase: NOT_THE_BASE,
    keysReplaced: KEYS_REPLACED,
    rival: LIST_RIVAL,
    incomplete: HEADS_INCOMPLETE,
    record: 'Invalid list record.',
    headsRecord: 'Invalid heads record.',
} as const;

/* The company's folders: a shared one two people are on, and one person's own. */
export const FOLDER = 1;
export const OWN = 2;
export const folderId = (n: number) =>
    n === 0 ? AREA : `c${n.toString(16).padStart(7, '0')}-8dfc-4914-8447-0417b55e2ec5`;

type Folder = {
    workspaceId: string;
    kind: AreaKind;
    keyVersion: number;
    /* The lists the server holds at this key version, the base list first. */
    lists: SignedAreaList[];
};

type BaseOptions = {
    people: ListPerson[];
    everyone?: EveryoneRole;
    kind?: AreaKind;
    listVersion?: number;
    /* The list's own signer and the roster it names, where a case breaks the rule. */
    signedBy?: Person;
    signerUserId?: string;
    names?: { rosterVersion: number; rosterDigest: string };
};

/* What a roster of the world does beside its members. */
type RosterOptions = {
    create?: Record<number, BaseOptions>;
    rotate?: Record<number, BaseOptions>;
    retire?: number[];
    /* The list version the signer commits for a folder, where it saw less than the server holds. */
    commit?: Record<number, number | { listVersion: number; listDigest: string }>;
    /* The rows the digest is over, written over what the signer would commit. */
    rows?: (rows: HeadRow[]) => HeadRow[];
    /* The rows the server serves with the roster: those that changed (the default), all, or its own. */
    serve?: 'delta' | 'full' | ((rows: HeadRow[]) => HeadRow[]);
    org?: OrgRosterOptions;
};

type AddOptions = {
    everyone?: EveryoneRole;
    /* The whole list, where a case takes someone off or lowers a role. */
    people?: ListPerson[];
    names?: { rosterVersion: number; rosterDigest: string };
    /* The list it follows, where not the server's latest. */
    on?: SignedAreaList;
    /* Kept from the server: served only where a case passes it. */
    hidden?: boolean;
    signWith?: Person;
    signerKeyVersion?: number;
    previousListDigest?: string;
};

const sorted = (people: ListPerson[]) =>
    [...people].sort((x, y) => (x.userId < y.userId ? -1 : x.userId > y.userId ? 1 : 0));

/*
 * A company and its server: roster 1 by its Owner alone with its first
 * folder (folder 0, the Owner its manager), roster 2 letting everyone in, and
 * roster 3 by an Admin making FOLDER (shared: the Member its manager, the
 * Billing holder a viewer) and OWN (the kit holder's employee folder).
 */
export async function listWorld(options: { folders?: boolean } = {}) {
    const cast = await companyCast();
    const h = await history('org');
    const folders = new Map<number, Folder>();
    const heads: { rosterVersion: number; rows: HeadRow[] }[] = [];
    let committed: HeadRow[] = [];
    let nonce = 0;
    const position = async () => ({
        rosterVersion: h.rosters.length,
        rosterDigest: h.rosters.length === 0 ? '' : await rosterDigest(h.rosters.at(-1)!.statement),
    });
    const sign = async (list: AreaList, by: Person): Promise<SignedAreaList> => {
        const statement = areaListStatement(list);
        return {
            statement: encode(statement),
            signature: encode(await signHybrid(statement, by.signer)),
        };
    };
    const digestOfList = (signed: SignedAreaList) => areaListDigest(decode(signed.statement));
    const base = async (n: number, keyVersion: number, signer: Person, o: BaseOptions) => {
        const at = o.names ?? (await position());
        const before = folders.get(n)?.lists.at(-1);
        return sign(
            {
                groupId: h.groupId,
                workspaceId: folderId(n),
                listVersion:
                    o.listVersion ??
                    (before ? parseAreaList(decode(before.statement)).listVersion + 1 : 1),
                previousListDigest: '',
                workspaceKeyVersion: keyVersion,
                signerUserId: o.signerUserId ?? signer.userId,
                signerKeyVersion: signer.keyVersion,
                ...at,
                nonce: encode(pattern(16, ++nonce)),
                everyone: o.everyone ?? '',
                people: sorted(o.people),
            },
            o.signedBy ?? signer,
        );
    };
    const world = {
        cast,
        h,
        folders,
        heads,
        /* Extra people whose keys acceptance and the lists need (a member's later identity). */
        extra: [] as Person[],
        position,
        digestOfList,
        async roster(signer: Person, members: RosterMember[], o: RosterOptions = {}) {
            const rows: RosterArea[] = [];
            for (const [key, options] of [
                ...Object.entries(o.create ?? {}),
                ...Object.entries(o.rotate ?? {}),
            ]) {
                const n = Number(key);
                const keyVersion = (folders.get(n)?.keyVersion ?? 0) + 1;
                const kind = options.kind ?? folders.get(n)?.kind ?? 'shared';
                const list = await base(n, keyVersion, signer, options);
                const row = n === 0 ? await orgRowAt(AREA, keyVersion) : await rowOf(n, keyVersion);
                rows.push({ ...row, areaKind: kind, listDigest: await digestOfList(list) });
                folders.set(n, { workspaceId: folderId(n), kind, keyVersion, lists: [list] });
            }
            for (const n of o.retire ?? []) {
                rows.push(tombstoneAt(folderId(n), folders.get(n)!.keyVersion + 1));
                folders.delete(n);
            }
            rows.sort((x, y) => (x.workspaceId < y.workspaceId ? -1 : 1));
            // What the signer's device commits: every live folder's head as it verified it.
            let all: HeadRow[] = [];
            for (const [n, folder] of folders) {
                const over = o.commit?.[n];
                const at =
                    typeof over === 'object'
                        ? over
                        : await (async () => {
                              const list =
                                  over === undefined
                                      ? folder.lists.at(-1)!
                                      : folder.lists.find(
                                            (signed) =>
                                                parseAreaList(decode(signed.statement))
                                                    .listVersion === over,
                                        )!;
                              return {
                                  listVersion: parseAreaList(decode(list.statement)).listVersion,
                                  listDigest: await digestOfList(list),
                              };
                          })();
                all.push({
                    workspaceId: folder.workspaceId,
                    workspaceKeyVersion: folder.keyVersion,
                    ...at,
                    shareLogIndex: 0,
                    shareLogDigest: await shareLogStart(h.groupId, folder.workspaceId),
                });
            }
            all.sort((x, y) => (x.workspaceId < y.workspaceId ? -1 : 1));
            if (o.rows) all = o.rows(all);
            const signed = await h.roster(signer, members, undefined, rows, {
                ...o.org,
                heads: { headsDigest: await headsDigest(h.groupId, all), ...o.org?.heads },
            });
            const was = new Map(committed.map((row) => [row.workspaceId, JSON.stringify(row)]));
            const delta = all.filter((row) => was.get(row.workspaceId) !== JSON.stringify(row));
            const serve = o.serve ?? 'delta';
            heads.push({
                rosterVersion: h.rosters.length,
                rows: typeof serve === 'function' ? serve(all) : serve === 'full' ? all : delta,
            });
            committed = all;
            return signed;
        },
        /* An addition on folder `n`, by `signer`: `add` put into the list it follows. */
        async add(n: number, signer: Person, add: ListPerson[], o: AddOptions = {}) {
            const folder = folders.get(n)!;
            const on = o.on ?? folder.lists.at(-1)!;
            const before = parseAreaList(decode(on.statement));
            const people = new Map(before.people.map((person) => [person.userId, person.role]));
            for (const person of add) people.set(person.userId, person.role);
            const list = await sign(
                {
                    groupId: h.groupId,
                    workspaceId: folder.workspaceId,
                    listVersion: before.listVersion + 1,
                    previousListDigest: o.previousListDigest ?? (await digestOfList(on)),
                    workspaceKeyVersion: folder.keyVersion,
                    signerUserId: signer.userId,
                    signerKeyVersion: o.signerKeyVersion ?? signer.keyVersion,
                    ...(o.names ?? (await position())),
                    nonce: encode(pattern(16, ++nonce)),
                    everyone: o.everyone ?? before.everyone,
                    people: sorted(
                        o.people ?? [...people].map(([userId, role]) => ({ userId, role })),
                    ),
                },
                o.signWith ?? signer,
            );
            if (!o.hidden && !o.on) folder.lists.push(list);
            return list;
        },
        /* What the server serves of folder `n` now. */
        /* The base list of folder `n`'s next key version, as its rotator would sign it now. */
        baseList(n: number, signer: Person, o: BaseOptions) {
            return base(n, (folders.get(n)?.keyVersion ?? 0) + 1, signer, o);
        },
        served(n: number) {
            return [...folders.get(n)!.lists];
        },
        async input(over: Partial<AcceptInput> = {}) {
            return companyInput(h, cast, { extra: world.extra, ...over });
        },
    };
    const e = {
        owner: cast.owner.entry(OWNER_ROLES),
        second: cast.second.entry(OWNER_ROLES),
        admin: cast.admin.entry(ADMIN_ROLES),
        member: cast.member.entry([]),
        keeper: cast.keeper.entry(['recovery']),
        biller: cast.biller.entry(['billing']),
        admin2: cast.admin2.entry(ADMIN_ROLES),
        // A plain Member on no list.
        another: cast.another.entry([]),
    };
    const all = Object.values(e);
    await world.roster(cast.owner, [e.owner], {
        create: { 0: { people: [{ userId: cast.owner.userId, role: 'manager' }] } },
    });
    await world.roster(cast.owner, all);
    if (options.folders ?? true)
        await world.roster(cast.admin, all, {
            create: {
                [FOLDER]: {
                    people: [
                        { userId: cast.member.userId, role: 'manager' },
                        { userId: cast.biller.userId, role: 'viewer' },
                    ],
                },
                [OWN]: {
                    kind: 'employee',
                    people: [{ userId: cast.keeper.userId, role: 'manager' }],
                },
            },
        });
    return { ...world, e, all };
}
export type ListWorld = Awaited<ReturnType<typeof listWorld>>;

/* What a case asks of a step beside reading the list. */
export type ListProbes = {
    access?: {
        userId: string;
        suspended?: boolean;
        session?: 'browse' | 'key-change' | null;
        share?: 'editor' | 'viewer' | null;
    }[];
    owed?: boolean;
    grants?: { suspended?: string[] };
    standing?: { writerUserId: string; sharedEditors?: string[] }[];
    writable?: boolean;
    dismissals?: { statement: string; signature: string; signer: number; keyVersion?: number }[];
    /*
     * Builds the heads a roster's signer would commit now (headsToCommit): `others` is what the
     * server serves of every other live folder, `changed` the base lists of the folders the
     * roster would create or rotate, `retire` those it would retire.
     */
    commit?: {
        others: Record<string, SignedAreaList[]>;
        changed?: SignedAreaList[];
        retire?: string[];
    };
};

/* One step of a device's life: accept the chain through a roster, read the heads, read (or settle) a folder's list. */
export type ListStep = {
    through: number;
    call?: 'read' | 'settle';
    folder: number;
    served: SignedAreaList[] | null;
    /* The heads rows it is served up to this roster (through, by default); `false` reads none. */
    headsThrough?: number | false;
    /* A record in place of the one the step before left: an edited one, or none. */
    record?: AreaListRecord | null;
    headsRecord?: HeadsRecord | null;
    probes?: ListProbes;
};

export type ListStepVerdict = {
    heads: { rosterVersion: number; lowered: unknown[] } | { error: string } | null;
    lists: (Omit<AreaLists, 'record'> & { record: AreaListRecord | null }) | { error: string };
    access?: { access: AreaAccess; allows: string }[];
    owed?: boolean;
    grants?: string[];
    standing?: FolderStanding[];
    writable?: string;
    dismissals?: string[];
    commit?: { headsDigest: string; rows: HeadRow[] } | { error: string };
};

export type ListCase = {
    name: string;
    input: AcceptInput;
    heads: { rosterVersion: number; rows: HeadRow[] }[];
    steps: (Omit<ListStep, 'folder'> & { workspaceId: string })[];
    /* Whether the verdicts are what the case is about (TypeScript only; the fixture carries the verdicts). */
    holds: (steps: ListStepVerdict[]) => boolean;
};

const ACTIONS: AreaAction[] = ['read', 'download', 'write', 'share', 'manage', 'rotate'];

async function chainThrough(input: AcceptInput, through: number): Promise<AcceptedRosters> {
    const chain = await acceptRosters({
        ...input,
        rosters: input.rosters.slice(0, through),
        successions: input.successions.filter(
            (s) => parseGroupSuccession(s.statement).lastRosterVersion < through,
        ),
    });
    if (chain.status !== 'accepted') throw new Error('the case’s chain is not accepted');
    return chain;
}

const refusal = (error: unknown) => {
    if (error instanceof CryptoError) return { error: error.message };
    throw error;
};

/*
 * What this twin says of a case, step by step: the heads it reads, the list
 * it reads (or the fork it settles) with the record it would keep, and the
 * probes the step asks. The record and the heads record pass from each step
 * to the next, as a device's own would.
 */
export async function listCaseVerdict(
    c: Pick<ListCase, 'input' | 'heads' | 'steps'>,
): Promise<ListStepVerdict[]> {
    const out: ListStepVerdict[] = [];
    let record: AreaListRecord | null = null;
    let headsRecord: HeadsRecord | null = null;
    for (const step of c.steps) {
        const chain = await chainThrough(c.input, step.through);
        if (step.headsRecord !== undefined) headsRecord = step.headsRecord;
        if (step.record !== undefined) record = step.record;
        let heads: ListStepVerdict['heads'] = null;
        if (step.headsThrough !== false) {
            const upTo = step.headsThrough ?? step.through;
            try {
                const read = await readHeads({
                    chain,
                    record: headsRecord,
                    served: c.heads.filter((at) => at.rosterVersion <= upTo),
                });
                headsRecord = read.record;
                heads = { rosterVersion: read.record.rosterVersion, lowered: read.lowered };
            } catch (error) {
                heads = refusal(error);
            }
        }
        const verdict: ListStepVerdict = { heads, lists: { error: '' } };
        let lists: AreaLists | null = null;
        try {
            const input: Parameters<typeof readAreaLists>[0] = {
                chain,
                heads: headsRecord,
                workspaceId: step.workspaceId,
                record,
                served: step.served,
                mlDsaKeys: c.input.mlDsaKeys,
            };
            lists =
                step.call === 'settle' ? await settleAreaFork(input) : await readAreaLists(input);
            record = lists.record;
            verdict.lists = structuredClone(lists) as ListStepVerdict['lists'];
        } catch (error) {
            verdict.lists = refusal(error);
        }
        const probes = step.probes;
        if (probes && lists) {
            const read = lists;
            if (probes.access)
                verdict.access = probes.access.map((probe) => {
                    const access = areaAccess({ chain, lists: read, ...probe });
                    return {
                        access,
                        allows: ACTIONS.filter((action) => areaAllows(access, action)).join(),
                    };
                });
            if (probes.owed) verdict.owed = areaOwed(chain, read);
            if (probes.grants)
                verdict.grants = areaGrantsOwed({ chain, lists: read, ...probes.grants });
            if (probes.writable)
                try {
                    requireAreaWritable(chain, read);
                    verdict.writable = 'ok';
                } catch (error) {
                    verdict.writable = refusal(error).error;
                }
            if (probes.dismissals) {
                verdict.dismissals = [];
                for (const probe of probes.dismissals) {
                    const signer = (await person(probe.signer, probe.keyVersion ?? 1))
                        .mlDsaPublicKey;
                    try {
                        const dismissal = await verifyForkDismissal(
                            decode(probe.statement),
                            decode(probe.signature),
                            { chain, signerMlDsaPublicKey: signer },
                        );
                        verdict.dismissals.push(
                            (read.record?.forks ?? []).some((note) =>
                                dismisses(dismissal, read.workspaceId, note),
                            )
                                ? 'dismisses'
                                : 'verified',
                        );
                    } catch (error) {
                        refusal(error);
                        verdict.dismissals.push('refused');
                    }
                }
            }
        }
        if (probes?.commit && lists) {
            const { others, changed, retire } = probes.commit;
            try {
                const all = [lists];
                for (const [workspaceId, served] of Object.entries(others))
                    all.push(
                        await readAreaLists({
                            chain,
                            heads: headsRecord,
                            workspaceId,
                            record: null,
                            served,
                            mlDsaKeys: c.input.mlDsaKeys,
                        }),
                    );
                const built = await headsToCommit({
                    chain,
                    groupId: chain.groupId,
                    heads: headsRecord,
                    lists: all,
                    changed,
                    retire,
                });
                verdict.commit = { headsDigest: built.headsDigest, rows: [...built.rows] };
            } catch (error) {
                verdict.commit = refusal(error);
            }
        }
        if (probes?.standing)
            verdict.standing = probes.standing.map((probe) =>
                folderStanding({ chain, lists, workspaceId: step.workspaceId, ...probe }),
            );
        out.push(verdict);
    }
    return out;
}

/* A dismissal as a case signs it: by anyone, over anything. */
async function dismissal(by: Person, fields: ForkDismissal, signWith: Person = by) {
    const statement = forkDismissalStatement(fields);
    return {
        statement: encode(statement),
        signature: encode(await signHybrid(statement, signWith.signer)),
        signer: by.n,
        keyVersion: by.keyVersion,
    };
}

const listed = (v: ListStepVerdict) => {
    if ('error' in v.lists) throw new Error(`the list was refused: ${v.lists.error}`);
    return v.lists;
};
const reasons = (v: ListStepVerdict) => listed(v).refused.map((at) => at.reason);
const ids = (people: readonly { userId: string }[]) => people.map((person) => person.userId).join();

/*
 * The cases of companies-design 2.3: for every rule one device that reads a
 * history that keeps it and one that reads a history that breaks it.
 */
export async function listCases(): Promise<ListCase[]> {
    const cast: CompanyCast = await companyCast();
    const { owner, admin, member, keeper, biller, newcomer, admin2, another, second } = cast;
    const cases: ListCase[] = [];
    const editor = (who: Person): ListPerson => ({ userId: who.userId, role: 'editor' });
    const viewer = (who: Person): ListPerson => ({ userId: who.userId, role: 'viewer' });
    const manager = (who: Person): ListPerson => ({ userId: who.userId, role: 'manager' });
    const left = (entry: RosterMember): RosterMember => ({ ...entry, status: 'left', roles: [] });
    const withEntry = (w: ListWorld, ...entries: RosterMember[]) => [
        ...w.all.filter((at) => !entries.some((entry) => entry.userId === at.userId)),
        ...entries,
    ];
    const add = async (
        name: string,
        write: (w: ListWorld) => Promise<ListStep[]>,
        holds: ListCase['holds'],
        options: { folders?: boolean } = {},
    ) => {
        const w = await listWorld(options);
        const steps = await write(w);
        cases.push({
            name,
            input: await w.input(),
            heads: w.heads,
            steps: steps.map(({ folder, ...step }) => ({ ...step, workspaceId: folderId(folder) })),
            holds,
        });
    };
    /* A device that reads FOLDER for the first time at the head, served everything the server holds. */
    const fresh = (w: ListWorld, probes?: ListProbes, folder = FOLDER): ListStep[] => [
        { through: w.h.rosters.length, folder, served: w.served(folder), probes },
    ];
    const state = (expected: string, version: number) => (v: ListStepVerdict[]) =>
        listed(v.at(-1)!).state === expected && listed(v.at(-1)!).listVersion === version;
    /* The last step took the list up to `version` and refused the next for `reason`. */
    const refuses =
        (reason: keyof typeof LIST_REFUSALS, version = 1) =>
        (v: ListStepVerdict[]) =>
            listed(v.at(-1)!).listVersion === version &&
            reasons(v.at(-1)!).includes(LIST_REFUSALS[reason]);

    // A base list and additions (2.3): a manager and an Admin add; the list is every one of them.
    await add(
        'base-list-and-additions',
        async (w) => {
            await w.add(FOLDER, member, [editor(keeper)]);
            await w.add(FOLDER, admin, [viewer(admin2)]);
            await w.roster(admin, w.all);
            return fresh(w, {
                access: [
                    { userId: member.userId },
                    { userId: keeper.userId },
                    { userId: biller.userId },
                    { userId: admin2.userId },
                    // An Admin who is on no list: nothing without a session, everything but shares with one.
                    { userId: admin.userId },
                    { userId: admin.userId, session: 'browse' },
                    // No key change is owed: a key-change session opens nothing.
                    { userId: admin.userId, session: 'key-change' },
                    // An Owner is a data admin too; a Member on no list, and someone outside the
                    // company, are nobody here.
                    { userId: second.userId },
                    { userId: another.userId },
                    { userId: newcomer.userId },
                    // A share grantee, from outside the company or in it (the record is the share log's).
                    { userId: newcomer.userId, share: 'viewer' },
                    { userId: another.userId, share: 'editor' },
                    // A paused member reaches nothing, by any basis.
                    { userId: member.userId, suspended: true },
                    { userId: admin.userId, suspended: true, session: 'browse' },
                    { userId: newcomer.userId, suspended: true, share: 'editor' },
                    // An admin who is on the list is one of the folder's people, not browsing; a
                    // session is no basis for someone who is no admin.
                    { userId: admin2.userId, session: 'browse' },
                    { userId: member.userId, session: 'browse' },
                ],
                owed: true,
                grants: { suspended: [biller.userId] },
                writable: true,
                standing: [
                    { writerUserId: member.userId },
                    { writerUserId: keeper.userId },
                    { writerUserId: biller.userId },
                    { writerUserId: admin.userId },
                    { writerUserId: owner.userId },
                    { writerUserId: admin2.userId },
                    { writerUserId: another.userId },
                    { writerUserId: another.userId, sharedEditors: [another.userId] },
                ],
            });
        },
        (v) => {
            const last = v.at(-1)!;
            const access = last.access!.map((at) =>
                at.access ? `${at.access.basis}:${'role' in at.access ? at.access.role : ''}` : '-',
            );
            return (
                state('level', 3)(v) &&
                ids(listed(last).people) ===
                    ids(
                        sorted([manager(member), editor(keeper), viewer(biller), viewer(admin2)]),
                    ) &&
                access.join(' ') ===
                    'list:manager list:editor list:viewer list:viewer - browse: - - - - share:viewer share:editor - - - list:viewer list:manager' &&
                last.access![0]!.allows === 'read,download,write,share,manage' &&
                last.access![1]!.allows === 'read,download,write,share' &&
                last.access![5]!.allows === 'read,download,write,manage' &&
                last.access![2]!.allows === 'read,download' &&
                last.access![10]!.allows === 'read,download' &&
                last.access![11]!.allows === 'read,download,write' &&
                last.owed === false &&
                last.grants!.join() ===
                    [member.userId, keeper.userId, admin2.userId].sort().join() &&
                last.writable === 'ok' &&
                last.standing!.join() ===
                    'listed,listed,not-on-this-folder,data-admin,data-admin,data-admin,not-on-this-folder,share'
            );
        },
    );
    // Membership alone grants nothing; an employee folder is its assignee's; `everyone` is every active member's.
    await add(
        'an-employee-folder-is-its-assignees',
        async (w) =>
            fresh(
                w,
                {
                    access: [
                        { userId: keeper.userId },
                        { userId: member.userId },
                        { userId: admin.userId },
                        { userId: admin.userId, session: 'browse' },
                    ],
                    grants: {},
                },
                OWN,
            ),
        (v) =>
            state('level', 1)(v) &&
            v[0]!.access!.map((at) => at.access?.basis ?? '-').join() === 'list,-,-,browse' &&
            v[0]!.grants!.join() === keeper.userId,
    );
    await add(
        'everyone-is-every-active-member',
        async (w) => {
            await w.add(FOLDER, member, [], { everyone: 'editor' });
            await w.roster(admin, withEntry(w, left(w.e.another)));
            return fresh(w, {
                access: [
                    { userId: admin2.userId },
                    { userId: biller.userId },
                    { userId: another.userId },
                    { userId: newcomer.userId },
                ],
                owed: true,
                grants: { suspended: [admin2.userId] },
                standing: [{ writerUserId: biller.userId }, { writerUserId: another.userId }],
            });
        },
        (v) =>
            v[0]!
                .access!.map((at) => (at.access && 'role' in at.access ? at.access.role : '-'))
                .join() === 'editor,editor,-,-' &&
            // Someone left after the folder's key was made: with `everyone` set, it is owed a change.
            v[0]!.owed === true &&
            !v[0]!.grants!.includes(admin2.userId) &&
            !v[0]!.grants!.includes(another.userId) &&
            v[0]!.grants!.length === 6 &&
            v[0]!.standing!.join() === 'listed,not-on-this-folder',
    );

    // Who may sign an addition: a manager on the list before it, or an Admin; nobody else.
    for (const [name, signer] of [
        ['a-viewer', biller],
        ['someone-not-on-the-list', keeper],
    ] as const)
        await add(
            `addition-by-${name}`,
            async (w) => {
                await w.add(FOLDER, signer, [viewer(admin2)]);
                return fresh(w);
            },
            refuses('notEntitled'),
        );
    await add(
        'addition-by-an-editor',
        async (w) => {
            await w.add(FOLDER, member, [editor(keeper)]);
            await w.add(FOLDER, keeper, [viewer(admin2)]);
            return fresh(w);
        },
        refuses('notEntitled', 2),
    );
    await add(
        'addition-by-someone-outside-the-company',
        async (w) => {
            await w.add(FOLDER, newcomer, [viewer(admin2)]);
            w.extra.push(newcomer);
            return fresh(w);
        },
        refuses('notEntitled'),
    );
    // Only more: nobody taken off, no role lowered, `everyone` never lowered.
    await add(
        'addition-removes-a-person',
        async (w) => {
            await w.add(FOLDER, member, [], { people: [manager(member)] });
            return fresh(w);
        },
        refuses('narrows'),
    );
    await add(
        'addition-lowers-a-role',
        async (w) => {
            await w.add(FOLDER, admin, [], { people: [editor(member), viewer(biller)] });
            return fresh(w);
        },
        refuses('narrows'),
    );
    await add(
        'addition-raises-a-role',
        async (w) => {
            await w.add(FOLDER, member, [editor(biller)]);
            return fresh(w, { access: [{ userId: biller.userId }] });
        },
        (v) => state('ahead', 2)(v) && v[0]!.access![0]!.allows === 'read,download,write,share',
    );
    await add(
        'addition-lowers-everyone',
        async (w) => {
            await w.add(FOLDER, member, [], { everyone: 'editor' });
            await w.add(FOLDER, member, [], { everyone: 'viewer' });
            return fresh(w);
        },
        refuses('narrows', 2),
    );
    await add(
        'a-second-base-list-without-a-key-change',
        async (w) => {
            // A list that follows nothing, at the same folder key: the narrowing a key change is for.
            await w.add(FOLDER, admin, [], { people: [manager(member)], previousListDigest: '' });
            return fresh(w);
        },
        refuses('notFollowing'),
    );
    // Everyone a list adds is an active member on the roster it names.
    await add(
        'addition-names-someone-not-in-the-company',
        async (w) => {
            await w.add(FOLDER, member, [viewer(newcomer)]);
            return fresh(w);
        },
        refuses('notActive'),
    );
    await add(
        'addition-names-someone-who-left',
        async (w) => {
            await w.roster(admin, withEntry(w, left(w.e.biller)));
            await w.add(FOLDER, member, [viewer(keeper), editor(biller)]);
            return fresh(w);
        },
        refuses('notActive'),
    );
    await add(
        'addition-names-a-roster-before-they-left',
        async (w) => {
            // Added while active, on the roster the list names: taken. Being `left` is what the
            // resolver reads, and they get nothing.
            const before = await w.position();
            await w.roster(admin, withEntry(w, left(w.e.another)));
            await w.add(FOLDER, member, [editor(another)], { names: before });
            return fresh(w, { access: [{ userId: another.userId }], owed: true });
        },
        (v) => state('ahead', 2)(v) && v[0]!.access![0]!.access === null && v[0]!.owed === true,
    );
    await add(
        'addition-on-an-employee-folder',
        async (w) => {
            await w.add(OWN, admin, [viewer(member)]);
            return fresh(w, undefined, OWN);
        },
        refuses('employee'),
    );
    // A list names a roster on the reader's chain.
    await add(
        'addition-names-a-roster-off-the-chain',
        async (w) => {
            await w.add(FOLDER, member, [editor(keeper)], {
                names: { rosterVersion: 3, rosterDigest: encode(pattern(32, 9)) },
            });
            return fresh(w);
        },
        refuses('notOnChain'),
    );
    await add(
        'addition-names-a-roster-yet-to-come',
        async (w) => {
            await w.add(FOLDER, member, [editor(keeper)], {
                names: { rosterVersion: 9, rosterDigest: (await w.position()).rosterDigest },
            });
            return fresh(w);
        },
        refuses('notOnChain'),
    );
    // Signed by the member it names, under the keys their entry named at the roster it names.
    await add(
        'addition-signed-with-other-keys',
        async (w) => {
            await w.add(FOLDER, member, [editor(keeper)], { signWith: biller });
            return fresh(w);
        },
        refuses('notSigned'),
    );
    await add(
        'addition-at-another-key-version',
        async (w) => {
            await w.add(FOLDER, member, [editor(keeper)], { signerKeyVersion: 2 });
            return fresh(w);
        },
        refuses('notSigned'),
    );
    {
        const { next: member2 } = await succeed(member);
        const moved = async (w: ListWorld) => {
            const before = await w.position();
            w.extra.push(member2);
            // An Admin folds the Member's new identity into their entry (a holder's claim).
            await w.roster(admin, withEntry(w, member2.entry([])), { commit: { [FOLDER]: 1 } });
            return before;
        };
        await add(
            'addition-under-the-keys-its-roster-named-after-a-fold-in',
            async (w) => {
                const before = await moved(w);
                await w.add(FOLDER, member, [editor(keeper)], { names: before });
                return fresh(w);
            },
            refuses('keysReplaced'),
        );
        await add(
            // Signed before the key change and within the heads the roster that made it committed.
            'addition-under-replaced-keys-within-the-heads',
            async (w) => {
                await w.add(FOLDER, member, [editor(keeper)]);
                w.extra.push(member2);
                await w.roster(admin, withEntry(w, member2.entry([])));
                return fresh(w);
            },
            state('level', 2),
        );
        await add(
            // A device took it while the keys were the entry's; the fold-in's heads lack it.
            'addition-under-replaced-keys-racing-the-fold-in',
            async (w) => {
                const raced = await w.add(FOLDER, member, [editor(keeper)], { hidden: true });
                const mine = [...w.served(FOLDER), raced];
                await moved(w);
                return [
                    { through: 3, folder: FOLDER, served: mine },
                    { through: 4, folder: FOLDER, served: w.served(FOLDER) },
                ];
            },
            (v) =>
                state('ahead', 2)([v[0]!]) &&
                state('level', 1)(v) &&
                reasons(v[1]!).join() === LIST_REFUSALS.keysReplaced &&
                ids(listed(v[1]!).lost) === keeper.userId,
        );
        await add(
            // Their keys were replaced, and later they left: the earlier roster is the bound on
            // what the old keys signed, though the roster that removed them committed the list.
            'addition-under-replaced-keys-by-someone-who-then-left',
            async (w) => {
                const before = await moved(w);
                await w.add(FOLDER, member, [editor(keeper)], { names: before });
                await w.roster(admin, withEntry(w, left(member2.entry([]))));
                return fresh(w);
            },
            (v) =>
                listed(v[0]!).state === 'forked' &&
                reasons(v[0]!).join() === LIST_REFUSALS.keysReplaced,
        );
        await add(
            // An Admin on no list signs by role alone: their old keys sign nothing past the
            // heads of the roster that replaced them, on any folder.
            'addition-under-an-admins-replaced-keys',
            async (w) => {
                const { next: admin3 } = await succeed(admin);
                const before = await w.position();
                w.extra.push(admin3);
                await w.roster(admin, withEntry(w, admin3.entry(ADMIN_ROLES)));
                await w.add(FOLDER, admin, [editor(admin)], { names: before });
                return fresh(w);
            },
            refuses('keysReplaced'),
        );
        await add(
            'dismissal-under-replaced-keys',
            async (w) => {
                const { next: admin3 } = await succeed(admin);
                const names = {
                    groupId: GROUP,
                    workspaceId: folderId(FOLDER),
                    kind: 'list' as const,
                    committedPosition: 2,
                    committedDigest: encode(pattern(32, 1)),
                    reportedPosition: 2,
                    reportedDigest: encode(pattern(32, 2)),
                    signerUserId: admin.userId,
                };
                const old = await dismissal(admin, {
                    ...names,
                    signerKeyVersion: 1,
                    ...(await w.position()),
                });
                w.extra.push(admin3);
                await w.roster(admin, withEntry(w, admin3.entry(ADMIN_ROLES)));
                const again = await dismissal(admin3, {
                    ...names,
                    signerKeyVersion: 2,
                    ...(await w.position()),
                });
                return [
                    {
                        through: 3,
                        folder: FOLDER,
                        served: w.served(FOLDER),
                        probes: { dismissals: [old] },
                    },
                    {
                        through: 4,
                        folder: FOLDER,
                        served: w.served(FOLDER),
                        probes: { dismissals: [old, again] },
                    },
                ];
            },
            // Old keys clear no note once the entry has moved on: the Admin signs it again.
            (v) =>
                v[0]!.dismissals!.join() === 'verified' &&
                v[1]!.dismissals!.join() === 'refused,verified',
        );
        await add(
            'addition-under-keys-the-entry-took-later',
            async (w) => {
                const before = await moved(w);
                await w.add(FOLDER, member2, [editor(keeper)], { names: before });
                return fresh(w);
            },
            refuses('notSigned'),
        );
        await add(
            'addition-under-the-new-keys-at-the-roster-that-names-them',
            async (w) => {
                await moved(w);
                await w.add(FOLDER, member2, [editor(keeper)]);
                return fresh(w);
            },
            state('ahead', 2),
        );
        await add(
            'addition-under-keys-the-entry-had-left',
            async (w) => {
                await moved(w);
                await w.add(FOLDER, member, [editor(keeper)]);
                return fresh(w);
            },
            refuses('notSigned'),
        );
    }

    // The base list is the one the roster row commits to, by the roster's signer, naming the roster before.
    const createThird = (base: Partial<BaseOptions>) => async (w: ListWorld) => {
        await w.roster(admin, w.all, {
            create: { 3: { people: [manager(member)], ...base } },
        });
        return [{ through: 4, folder: 3, served: w.served(3) }] as ListStep[];
    };
    const noList = (reason: keyof typeof LIST_REFUSALS) => (v: ListStepVerdict[]) =>
        listed(v[0]!).state === 'forked' &&
        listed(v[0]!).listVersion === 0 &&
        listed(v[0]!).record === null &&
        reasons(v[0]!).includes(LIST_REFUSALS[reason]);
    await add('a-new-folder', createThird({}), state('level', 1));
    await add(
        'base-list-of-another-digest',
        async (w) => {
            await w.roster(admin, w.all, { create: { 3: { people: [manager(member)] } } });
            // The same people, signed again: another nonce, another digest, not the roster row's.
            const again = await w.add(3, admin, [], {
                people: [manager(member)],
                previousListDigest: '',
                names: {
                    rosterVersion: 3,
                    rosterDigest: await rosterDigest(w.h.rosters[2]!.statement),
                },
                hidden: true,
            });
            const statement = areaListStatement({
                ...parseAreaList(decode(again.statement)),
                listVersion: 1,
            });
            return [
                {
                    through: 4,
                    folder: 3,
                    served: [
                        {
                            statement: encode(statement),
                            signature: encode(await signHybrid(statement, admin.signer)),
                        },
                    ],
                },
            ];
        },
        (v) =>
            listed(v[0]!).state === 'forked' &&
            listed(v[0]!).record === null &&
            listed(v[0]!).refused.length === 0,
    );
    await add(
        'base-list-names-the-roster-that-commits-it',
        async (w) =>
            createThird({
                names: { rosterVersion: 4, rosterDigest: (await w.position()).rosterDigest },
            })(w),
        noList('notTheBase'),
    );
    await add(
        'base-list-names-an-earlier-roster',
        async (w) =>
            createThird({
                names: {
                    rosterVersion: 2,
                    rosterDigest: await rosterDigest(w.h.rosters[1]!.statement),
                },
            })(w),
        noList('notTheBase'),
    );
    await add(
        'base-list-signed-by-someone-else',
        createThird({ signerUserId: member.userId, signedBy: member }),
        noList('notTheBase'),
    );
    await add(
        'base-list-with-anothers-signature',
        createThird({ signedBy: member }),
        noList('notSigned'),
    );
    await add(
        'base-list-starts-above-version-1',
        createThird({ listVersion: 2 }),
        noList('notTheBase'),
    );
    await add(
        'base-list-names-someone-not-in-the-company',
        createThird({ people: [manager(member), viewer(newcomer)] }),
        noList('notActive'),
    );
    await add(
        'base-list-names-someone-the-roster-lets-in',
        async (w) => {
            // The admitting roster makes the newcomer's own folder: its list names the roster
            // before, and its one person is active on the roster that commits it.
            w.extra.push(newcomer);
            await w.roster(admin, [...w.all, newcomer.entry([])], {
                create: { 3: { kind: 'employee', people: [manager(newcomer)] } },
            });
            return [
                {
                    through: 4,
                    folder: 3,
                    served: w.served(3),
                    probes: { access: [{ userId: newcomer.userId }], grants: {} },
                },
            ];
        },
        (v) =>
            state('level', 1)(v) &&
            v[0]!.access![0]!.allows === 'read,download,write,share,manage' &&
            v[0]!.grants!.join() === newcomer.userId,
    );
    await add(
        'employee-base-list-with-two-people',
        createThird({ kind: 'employee', people: [manager(member), viewer(biller)] }),
        noList('employee'),
    );
    await add(
        'employee-base-list-open-to-everyone',
        createThird({ kind: 'employee', everyone: 'viewer' }),
        noList('employee'),
    );
    await add(
        'the-first-rosters-own-folder',
        // Roster 1's base list names no roster: 0 and "", accepted only there.
        async (w) => [{ through: 2, folder: 0, served: w.served(0) }],
        state('level', 1),
        { folders: false },
    );

    // After someone leaves (2.3): what they signed counts only within the heads the roster that
    // ended their standing committed.
    await add(
        'after-leaving-within-the-heads',
        async (w) => {
            await w.add(FOLDER, member, [editor(keeper)]);
            await w.roster(admin, withEntry(w, left(w.e.member)));
            return fresh(w, { owed: true, access: [{ userId: member.userId }] });
        },
        (v) => state('level', 2)(v) && v[0]!.owed === true && v[0]!.access![0]!.access === null,
    );
    await add(
        'after-leaving-past-the-heads',
        async (w) => {
            const before = await w.position();
            await w.roster(admin, withEntry(w, left(w.e.member)));
            // Signed today, naming a roster from before they left.
            await w.add(FOLDER, member, [editor(keeper)], { names: before });
            return fresh(w);
        },
        refuses('afterLeaving'),
    );
    await add(
        'after-leaving-racing-the-removal',
        async (w) => {
            // The device verified it while its signer was a manager; the removal's heads lack it.
            const raced = await w.add(FOLDER, member, [editor(keeper)], { hidden: true });
            const built = await w.add(FOLDER, admin, [viewer(admin2)], { on: raced });
            await w.roster(admin, withEntry(w, left(w.e.member)));
            return [
                { through: 3, folder: FOLDER, served: [...w.served(FOLDER), raced, built] },
                { through: 4, folder: FOLDER, served: w.served(FOLDER) },
            ];
        },
        (v) =>
            state('ahead', 3)([v[0]!]) &&
            state('level', 1)(v) &&
            reasons(v[1]!).join('|') ===
                [LIST_REFUSALS.afterLeaving, LIST_REFUSALS.notFollowing].join('|') &&
            ids(listed(v[1]!).lost) === ids(sorted([editor(keeper), viewer(admin2)])),
    );
    await add(
        'after-an-admin-is-demoted',
        async (w) => {
            const before = await w.position();
            // Signed as an Admin and nothing else; an Owner takes the role away (rules 2 and 12).
            await w.roster(owner, withEntry(w, { ...w.e.admin2, roles: [] }), {
                org: { custodyVersion: 2 },
            });
            await w.add(FOLDER, admin2, [editor(keeper)], { names: before });
            return fresh(w);
        },
        refuses('afterLeaving'),
    );
    await add(
        'after-a-demoted-admin-who-manages-the-folder',
        async (w) => {
            await w.add(FOLDER, member, [manager(admin2)]);
            const before = await w.position();
            await w.roster(owner, withEntry(w, { ...w.e.admin2, roles: [] }), {
                org: { custodyVersion: 2 },
            });
            // Their standing on this folder is the list's, which the demotion did not end.
            await w.add(FOLDER, admin2, [editor(keeper)], { names: before });
            return fresh(w);
        },
        state('ahead', 3),
    );

    // After someone comes back (2.3): no standing from a list that names a roster before the one
    // that last let them in.
    const backAgain = async (w: ListWorld, who: RosterMember) => {
        await w.roster(admin, withEntry(w, left(who)));
        await w.roster(admin, w.all);
    };
    await add(
        'coming-back-gives-no-old-standing',
        async (w) => {
            await backAgain(w, w.e.biller);
            return fresh(w, {
                access: [{ userId: biller.userId }, { userId: member.userId }],
                owed: true,
                grants: {},
                standing: [{ writerUserId: biller.userId }],
            });
        },
        (v) =>
            state('level', 1)(v) &&
            // Still named by the list, and nothing for it.
            ids(listed(v[0]!).people).includes(biller.userId) &&
            v[0]!.access![0]!.access === null &&
            v[0]!.access![1]!.access !== null &&
            v[0]!.owed === true &&
            v[0]!.grants!.join() === member.userId &&
            v[0]!.standing![0] === 'not-on-this-folder',
    );
    await add(
        'coming-back-and-added-again',
        async (w) => {
            await backAgain(w, w.e.biller);
            await w.add(FOLDER, member, [editor(biller)]);
            return fresh(w, { access: [{ userId: biller.userId }] });
        },
        (v) => state('ahead', 2)(v) && v[0]!.access![0]!.allows === 'read,download,write,share',
    );
    await add(
        'coming-back-a-manager-signs-on-their-old-entry',
        async (w) => {
            await backAgain(w, w.e.member);
            await w.add(FOLDER, member, [editor(keeper)]);
            return fresh(w, { access: [{ userId: member.userId }] });
        },
        (v) => refuses('notEntitled')(v) && v[0]!.access![0]!.access === null,
    );
    await add(
        'coming-back-to-a-folder-open-to-everyone',
        async (w) => {
            await w.add(FOLDER, member, [], { everyone: 'viewer' });
            await backAgain(w, w.e.biller);
            return fresh(w, { access: [{ userId: biller.userId }] });
        },
        (v) => v[0]!.access![0]!.allows === 'read,download',
    );

    // Heads (2.3): the rows a roster's signer committed to, and nothing else.
    await add(
        'heads-of-another-digest',
        async (w) => {
            await w.roster(admin, w.all, {
                serve: (rows) =>
                    rows.map((row) => ({ ...row, listDigest: encode(pattern(32, 9)) })),
            });
            return fresh(w, { writable: true, standing: [{ writerUserId: member.userId }] });
        },
        (v) =>
            'error' in v[0]!.heads! &&
            v[0]!.heads.error === LIST_REFUSALS.heads &&
            listed(v[0]!).state === 'behind' &&
            v[0]!.writable === LIST_REFUSALS.behind &&
            v[0]!.standing![0] === 'unchecked',
    );
    for (const [name, rows] of [
        ['that-leave-a-folder-out', (all: HeadRow[]) => all.slice(1)],
        [
            'at-another-folder-key',
            (all: HeadRow[]) => all.map((row) => ({ ...row, workspaceKeyVersion: 2 })),
        ],
        [
            'with-an-empty-log-at-another-digest',
            (all: HeadRow[]) =>
                all.map((row) => ({ ...row, shareLogDigest: encode(pattern(32, 9)) })),
        ],
    ] as const)
        await add(
            `heads-${name}`,
            async (w) => {
                // The signer commits to them, and the server serves exactly what was committed.
                await w.roster(admin, w.all, { rows, serve: 'full' });
                return fresh(w);
            },
            (v) => 'error' in v[0]!.heads! && listed(v[0]!).state === 'behind',
        );
    await add(
        'heads-served-whole',
        async (w) => {
            await w.add(FOLDER, member, [editor(keeper)]);
            await w.roster(admin, w.all, { serve: 'full' });
            return fresh(w);
        },
        state('level', 2),
    );
    await add(
        'heads-after-a-folder-is-deleted',
        async (w) => {
            await w.roster(admin, w.all, { retire: [OWN] });
            await w.add(FOLDER, member, [editor(keeper)]);
            await w.roster(admin, w.all);
            return fresh(w);
        },
        state('level', 2),
    );
    await add(
        'heads-not-read-yet',
        async (w) => {
            await w.roster(admin, w.all);
            return [
                { through: 3, folder: FOLDER, served: w.served(FOLDER) },
                // The roster is accepted on its statement alone; its rows have not come yet.
                {
                    through: 4,
                    folder: FOLDER,
                    served: null,
                    headsThrough: 3,
                    probes: { writable: true },
                },
                { through: 4, folder: FOLDER, served: null, probes: { writable: true } },
            ];
        },
        (v) =>
            listed(v[1]!).state === 'behind' &&
            v[1]!.writable === LIST_REFUSALS.behind &&
            listed(v[2]!).state === 'level' &&
            v[2]!.writable === 'ok',
    );

    // The four states (2.3), at the folder's first key and after a key change alike.
    for (const rotated of [false, true]) {
        const at = rotated ? '-after-a-key-change' : '';
        const base = rotated ? 2 : 1;
        /* The world, with FOLDER's key changed on roster 4 when the case is the rotated one. */
        const start = async (w: ListWorld) => {
            if (rotated)
                await w.roster(admin, w.all, {
                    rotate: { [FOLDER]: { people: [manager(member), viewer(biller)] } },
                });
            return w.h.rosters.length;
        };
        await add(
            `behind-until-it-has-caught-up${at}`,
            async (w) => {
                const head = await start(w);
                const first = w.served(FOLDER);
                await w.add(FOLDER, member, [editor(keeper)]);
                await w.roster(admin, w.all);
                const probes: ListProbes = {
                    writable: true,
                    standing: [{ writerUserId: member.userId }],
                    access: [{ userId: keeper.userId }],
                };
                return [
                    { through: head, folder: FOLDER, served: first, probes },
                    // No answer from the server yet.
                    { through: head + 1, folder: FOLDER, served: null, probes },
                    { through: head + 1, folder: FOLDER, served: w.served(FOLDER), probes },
                ];
            },
            (v) =>
                state('level', base)([v[0]!]) &&
                state('behind', base)([v[1]!]) &&
                v[1]!.writable === LIST_REFUSALS.behind &&
                v[1]!.standing![0] === 'unchecked' &&
                v[1]!.access![0]!.access === null &&
                state('level', base + 1)(v) &&
                v[2]!.writable === 'ok' &&
                v[2]!.standing![0] === 'listed' &&
                v[2]!.access![0]!.access !== null,
        );
        await add(
            `ahead-and-then-it-matters${at}`,
            async (w) => {
                const head = await start(w);
                // The hidden addition: served to the person added and to nobody who signs rosters.
                const hidden = await w.add(FOLDER, member, [editor(another)], { hidden: true });
                const mine = [...w.served(FOLDER), hidden];
                await w.roster(admin, w.all);
                // The person added leaves: on every other device the folder is not owed.
                await w.roster(admin, withEntry(w, left(w.e.another)));
                const probes: ListProbes = { owed: true, writable: true };
                return [
                    { through: head, folder: FOLDER, served: mine, probes },
                    { through: head + 1, folder: FOLDER, served: w.served(FOLDER), probes },
                    { through: head + 2, folder: FOLDER, served: w.served(FOLDER), probes },
                    // Another device, never served the addition.
                    {
                        through: head + 2,
                        folder: FOLDER,
                        served: w.served(FOLDER),
                        record: null,
                        headsRecord: null,
                        probes,
                    },
                ];
            },
            (v) =>
                state('ahead', base + 1)([v[0]!]) &&
                listed(v[0]!).report === null &&
                // The next roster lacks it: kept, posted again, reported. It writes on.
                state('ahead', base + 1)([v[1]!]) &&
                listed(v[1]!).report === 'ahead' &&
                listed(v[1]!).repost.length === 1 &&
                listed(v[1]!).missing === false &&
                v[1]!.writable === 'ok' &&
                // The roster after still does: "An admin needs to look." And its maker's device
                // knows the folder is owed a key change.
                listed(v[2]!).missing === true &&
                v[2]!.owed === true &&
                state('level', base)(v) &&
                v[3]!.owed === false,
        );
        await add(
            `forked-by-another-list-in-its-place${at}`,
            async (w) => {
                const head = await start(w);
                const hidden = await w.add(FOLDER, member, [editor(keeper)], { hidden: true });
                const mine = [...w.served(FOLDER), hidden];
                // The server stores someone else's list at that version, and a roster commits it.
                await w.add(FOLDER, admin, [viewer(admin2)]);
                await w.roster(admin, w.all);
                const committed = await w.digestOfList(w.served(FOLDER).at(-1)!);
                const reported = await w.digestOfList(hidden);
                const at = await w.position();
                const names = {
                    groupId: GROUP,
                    workspaceId: folderId(FOLDER),
                    kind: 'list' as const,
                    committedPosition: base + 1,
                    committedDigest: committed,
                    reportedPosition: base + 1,
                    reportedDigest: reported,
                    signerKeyVersion: 1,
                    ...at,
                };
                const dismissals = [
                    await dismissal(admin, { ...names, signerUserId: admin.userId }),
                    // Not an Admin; someone else's signature; other digests; another kind; an
                    // earlier roster's Admin who still is one.
                    await dismissal(member, { ...names, signerUserId: member.userId }),
                    await dismissal(admin, { ...names, signerUserId: admin.userId }, member),
                    await dismissal(admin, {
                        ...names,
                        signerUserId: admin.userId,
                        reportedDigest: committed,
                    }),
                    await dismissal(admin, {
                        ...names,
                        signerUserId: admin.userId,
                        kind: 'share-log',
                    }),
                    await dismissal(admin2, {
                        ...names,
                        signerUserId: admin2.userId,
                        rosterVersion: 2,
                        rosterDigest: await rosterDigest(w.h.rosters[1]!.statement),
                    }),
                    await dismissal(admin, {
                        ...names,
                        signerUserId: admin.userId,
                        rosterDigest: encode(pattern(32, 9)),
                    }),
                ];
                const probes: ListProbes = {
                    writable: true,
                    standing: [{ writerUserId: member.userId }],
                    dismissals,
                };
                return [
                    { through: head, folder: FOLDER, served: mine },
                    { through: head + 1, folder: FOLDER, served: w.served(FOLDER), probes },
                    // Warned and posted: the committed record becomes the base.
                    {
                        through: head + 1,
                        call: 'settle',
                        folder: FOLDER,
                        served: w.served(FOLDER),
                        probes,
                    },
                    { through: head + 1, folder: FOLDER, served: w.served(FOLDER) },
                ];
            },
            (v) => {
                const fork = listed(v[1]!).fork;
                const settled = listed(v[2]!);
                return (
                    state('forked', base + 1)([v[1]!]) &&
                    fork !== null &&
                    !fork.settled &&
                    fork.committed.position === base + 1 &&
                    fork.reported.position === base + 1 &&
                    fork.committed.digest !== fork.reported.digest &&
                    listed(v[1]!).report === 'fork' &&
                    listed(v[1]!).repost.length === 1 &&
                    v[1]!.writable === LIST_REFUSALS.forked &&
                    v[1]!.standing![0] === 'unchecked' &&
                    v[1]!.dismissals!.join() ===
                        'dismisses,refused,refused,verified,verified,dismisses,refused' &&
                    // Settled: on the committed record, the stale list refused and its person lost.
                    settled.state === 'level' &&
                    settled.listDigest === fork.committed.digest &&
                    settled.refused.map((r) => r.reason).join() === LIST_REFUSALS.stale &&
                    ids(settled.lost) === keeper.userId &&
                    settled.record!.forks.length === 1 &&
                    settled.record!.forks[0]!.settled &&
                    v[2]!.writable === 'ok' &&
                    // The note stays until its person clears it, and a dismissal still names it.
                    v[2]!.dismissals![0] === 'dismisses' &&
                    listed(v[3]!).record!.forks.length === 1
                );
            },
        );
        await add(
            `forked-when-nothing-reaches-the-head${at}`,
            async (w) => {
                const head = await start(w);
                const first = w.served(FOLDER);
                const others = { [folderId(0)]: w.served(0), [folderId(OWN)]: w.served(OWN) };
                // A roster commits a list the server never serves; the next commits what exists.
                await w.roster(admin, w.all, {
                    commit: {
                        [FOLDER]: { listVersion: base + 1, listDigest: encode(pattern(32, 9)) },
                    },
                });
                // The way out an honest signer has: the folder's key change, numbered past it.
                const next = await w.baseList(FOLDER, admin, {
                    people: [manager(member)],
                    listVersion: base + 2,
                });
                const low = await w.baseList(FOLDER, admin, {
                    people: [manager(member)],
                    listVersion: base + 1,
                });
                await w.roster(admin, w.all, { commit: { [FOLDER]: base } });
                const probes: ListProbes = { writable: true, commit: { others } };
                return [
                    { through: head, folder: FOLDER, served: first, probes },
                    { through: head + 1, folder: FOLDER, served: null, probes },
                    { through: head + 1, folder: FOLDER, served: first, probes },
                    {
                        through: head + 1,
                        folder: FOLDER,
                        served: first,
                        probes: { commit: { others, changed: [next] } },
                    },
                    {
                        through: head + 1,
                        folder: FOLDER,
                        served: first,
                        probes: { commit: { others, changed: [low] } },
                    },
                    { through: head + 2, folder: FOLDER, served: first, probes },
                    { through: head + 2, folder: FOLDER, served: first, probes },
                    // Another device, reading for the first time after both rosters.
                    {
                        through: head + 2,
                        folder: FOLDER,
                        served: first,
                        record: null,
                        headsRecord: null,
                    },
                ];
            },
            (v) => {
                const error = (at: ListStepVerdict) =>
                    at.commit && 'error' in at.commit ? at.commit.error : null;
                const passed = listed(v[5]!);
                return (
                    // Level, a signer's heads are what it verified.
                    v[0]!.commit !== undefined &&
                    'rows' in v[0]!.commit &&
                    v[0]!.commit.rows.length === 3 &&
                    // Asked and not yet answered, it is behind; answered with nothing that
                    // reaches the head, it is forked: it never stays behind. Neither signs
                    // heads: a roster from this device would bury a list it was not served.
                    state('behind', base)([v[1]!]) &&
                    error(v[1]!) === LIST_REFUSALS.behind &&
                    state('forked', base)([v[2]!]) &&
                    v[2]!.writable === LIST_REFUSALS.forked &&
                    listed(v[2]!).fork !== null &&
                    error(v[2]!) === LIST_REFUSALS.forked &&
                    // Unless the roster changes that folder's key, with a base list past the head.
                    v[3]!.commit !== undefined &&
                    'rows' in v[3]!.commit &&
                    error(v[4]!) ===
                        'A member list’s heads never fall below what an earlier one committed.' &&
                    // A later roster whose head the record reaches lets it go on: the head it
                    // passed over is noted and reported, once, and never committed below.
                    passed.state === 'level' &&
                    passed.listVersion === base &&
                    passed.report === 'fork' &&
                    passed.fork !== null &&
                    passed.fork.settled &&
                    passed.fork.committed.position === base + 1 &&
                    passed.record!.forks.length === 1 &&
                    passed.head!.listVersion === base &&
                    v[5]!.writable === 'ok' &&
                    error(v[5]!) === LIST_REFUSALS.forked &&
                    listed(v[6]!).report === null &&
                    listed(v[6]!).fork === null &&
                    listed(v[6]!).record!.forks.length === 1 &&
                    listed(v[7]!).state === 'level' &&
                    listed(v[7]!).report === 'fork' &&
                    listed(v[7]!).record!.forks.length === 1
                );
            },
        );
        await add(
            `a-true-fork-is-not-cleared-by-a-later-lower-row${at}`,
            async (w) => {
                const head = await start(w);
                const hidden = await w.add(FOLDER, member, [editor(keeper)], { hidden: true });
                const mine = [...w.served(FOLDER), hidden];
                await w.add(FOLDER, admin, [viewer(admin2)]);
                await w.roster(admin, w.all);
                // A later roster commits a lower point, which this device does hold.
                await w.roster(admin, w.all, { commit: { [FOLDER]: base } });
                return [
                    { through: head, folder: FOLDER, served: mine },
                    { through: head + 1, folder: FOLDER, served: w.served(FOLDER) },
                    {
                        through: head + 2,
                        folder: FOLDER,
                        served: w.served(FOLDER),
                        probes: { writable: true },
                    },
                ];
            },
            (v) =>
                state('forked', base + 1)([v[1]!]) &&
                state('forked', base + 1)(v) &&
                listed(v[2]!).fork !== null &&
                !listed(v[2]!).fork!.settled &&
                listed(v[2]!).fork!.committed.position === base + 1 &&
                v[2]!.writable === LIST_REFUSALS.forked,
        );
        await add(
            `two-lists-at-one-version${at}`,
            async (w) => {
                const head = await start(w);
                const first = w.served(FOLDER);
                const one = await w.add(FOLDER, member, [editor(keeper)], { hidden: true });
                const other = await w.add(FOLDER, admin, [viewer(admin2)], { hidden: true });
                return [
                    { through: head, folder: FOLDER, served: [...first, one, other] },
                    // The same two, served the other way round, to a device with no record.
                    {
                        through: head,
                        folder: FOLDER,
                        served: [...first, other, one],
                        record: null,
                        headsRecord: null,
                    },
                    // And twice, one copy with its signature damaged: no copy stands in another's way.
                    {
                        through: head,
                        folder: FOLDER,
                        served: [
                            ...first,
                            { ...one, signature: other.signature },
                            one,
                            other,
                            other,
                        ],
                        record: null,
                        headsRecord: null,
                    },
                ];
            },
            (v) =>
                // The server does not choose by order: the same list is taken each time, the
                // other refused as a rival and reported.
                state('ahead', base + 1)([v[0]!]) &&
                listed(v[1]!).listDigest === listed(v[0]!).listDigest &&
                listed(v[2]!).listDigest === listed(v[0]!).listDigest &&
                reasons(v[0]!).join() === LIST_REFUSALS.rival &&
                reasons(v[1]!).join() === LIST_REFUSALS.rival &&
                reasons(v[2]!).join() === LIST_REFUSALS.rival &&
                listed(v[0]!).report === 'fork' &&
                listed(v[0]!).refused[0]!.listDigest === listed(v[1]!).refused[0]!.listDigest,
        );
        await add(
            `the-furthest-head-wins${at}`,
            async (w) => {
                const head = await start(w);
                await w.add(FOLDER, member, [editor(keeper)]);
                await w.add(FOLDER, member, [viewer(admin2)]);
                await w.roster(admin, w.all);
                // A later roster, signed from a stale read: a lower row, on the same record.
                await w.roster(admin, w.all, { commit: { [FOLDER]: base + 1 } });
                return [
                    { through: head + 1, folder: FOLDER, served: w.served(FOLDER) },
                    { through: head + 2, folder: FOLDER, served: w.served(FOLDER) },
                    { through: head + 2, folder: FOLDER, served: w.served(FOLDER) },
                ];
            },
            (v) =>
                state('level', base + 2)([v[0]!]) &&
                state('level', base + 2)([v[1]!]) &&
                listed(v[1]!).record!.committed.listVersion === base + 2 &&
                listed(v[1]!).record!.committed.rosterVersion ===
                    listed(v[0]!).record!.committed.rosterVersion &&
                (v[1]!.heads as { lowered: unknown[] }).lowered.length === 1 &&
                listed(v[1]!).report === 'ahead' &&
                // Reported once.
                listed(v[2]!).report === null &&
                listed(v[2]!).record!.forks.length === 0,
        );
        await add(
            `a-lower-head-off-the-record${at}`,
            async (w) => {
                const head = await start(w);
                await w.add(FOLDER, member, [editor(keeper)]);
                await w.add(FOLDER, member, [viewer(admin2)]);
                await w.roster(admin, w.all);
                await w.roster(admin, w.all, {
                    commit: {
                        [FOLDER]: { listVersion: base + 1, listDigest: encode(pattern(32, 9)) },
                    },
                });
                return [
                    { through: head + 1, folder: FOLDER, served: w.served(FOLDER) },
                    {
                        through: head + 2,
                        folder: FOLDER,
                        served: w.served(FOLDER),
                        probes: { writable: true },
                    },
                ];
            },
            (v) =>
                // The committed head does not move back, and the lower point, not on this
                // record, is a fork: reported, noted, nothing to adopt.
                state('level', base + 2)(v) &&
                listed(v[1]!).report === 'fork' &&
                listed(v[1]!).record!.forks.length === 1 &&
                listed(v[1]!).record!.forks[0]!.settled &&
                listed(v[1]!).record!.committed.listVersion === base + 2 &&
                v[1]!.writable === 'ok',
        );
    }

    // A key change (2.3, "A new base list replaces what was before it").
    const people = [manager(member), viewer(biller)];
    await add(
        'key-change-read-clean',
        async (w) => {
            await w.add(FOLDER, member, [editor(keeper)]);
            const first = w.served(FOLDER);
            await w.roster(admin, w.all, { rotate: { [FOLDER]: { people } } });
            const probes: ListProbes = {
                standing: [{ writerUserId: keeper.userId }],
                access: [{ userId: keeper.userId }],
            };
            return [
                { through: 3, folder: FOLDER, served: first },
                { through: 4, folder: FOLDER, served: null, probes },
                { through: 4, folder: FOLDER, served: w.served(FOLDER), probes },
            ];
        },
        (v) =>
            state('behind', 0)([v[1]!]) &&
            v[1]!.standing![0] === 'unchecked' &&
            // The new base list, without the editor the old one had: on an earlier list only.
            state('level', 3)(v) &&
            listed(v[2]!).workspaceKeyVersion === 2 &&
            listed(v[2]!).report === null &&
            // The addition this device held is gone with the old key: stale, its person lost.
            ids(listed(v[2]!).lost) === keeper.userId &&
            reasons(v[2]!).join() === LIST_REFUSALS.stale &&
            v[2]!.standing![0] === 'not-on-this-folder' &&
            v[2]!.access![0]!.access === null,
    );
    await add(
        'key-change-over-a-hidden-addition',
        async (w) => {
            const hidden = await w.add(FOLDER, member, [editor(keeper)], { hidden: true });
            const mine = [...w.served(FOLDER), hidden];
            // The rotator's base list is made from the list as its device verified it.
            await w.roster(admin, w.all, { rotate: { [FOLDER]: { people } } });
            return [
                { through: 3, folder: FOLDER, served: mine },
                { through: 4, folder: FOLDER, served: w.served(FOLDER) },
            ];
        },
        (v) =>
            state('level', 2)(v) &&
            listed(v[1]!).report === 'ahead' &&
            ids(listed(v[1]!).lost) === keeper.userId &&
            reasons(v[1]!).join() === LIST_REFUSALS.stale,
    );
    await add(
        'key-change-below-a-committed-head',
        async (w) => {
            await w.add(FOLDER, member, [editor(keeper)]);
            await w.roster(admin, w.all);
            const before = w.served(FOLDER);
            // A base list numbered below a head an earlier roster committed: the key change's
            // own roster is held to the same rule.
            await w.roster(admin, w.all, {
                rotate: { [FOLDER]: { people, listVersion: 2 } },
            });
            return [
                { through: 4, folder: FOLDER, served: before },
                {
                    through: 5,
                    folder: FOLDER,
                    served: w.served(FOLDER),
                    probes: { writable: true },
                },
                { through: 5, call: 'settle', folder: FOLDER, served: w.served(FOLDER) },
            ];
        },
        (v) =>
            state('forked', 0)([v[1]!]) &&
            listed(v[1]!).report === 'fork' &&
            v[1]!.writable === LIST_REFUSALS.forked &&
            state('level', 2)(v) &&
            listed(v[2]!).workspaceKeyVersion === 2 &&
            listed(v[2]!).record!.forks[0]!.settled,
    );
    await add(
        // The base list is numbered above what the device held, and names the person it had
        // added: the held list is stale all the same, and nobody is lost.
        'key-change-that-kept-the-person-added',
        async (w) => {
            const hidden = await w.add(FOLDER, member, [editor(keeper)], { hidden: true });
            const mine = [...w.served(FOLDER), hidden];
            await w.roster(admin, w.all, {
                rotate: { [FOLDER]: { people: [...people, editor(keeper)], listVersion: 5 } },
            });
            return [
                { through: 3, folder: FOLDER, served: mine },
                { through: 4, folder: FOLDER, served: w.served(FOLDER) },
            ];
        },
        (v) =>
            state('level', 5)(v) &&
            listed(v[1]!).report === null &&
            listed(v[1]!).lost.length === 0 &&
            reasons(v[1]!).join() === LIST_REFUSALS.stale,
    );
    await add(
        // Numbered above what the device held, without the person it had added offline: told.
        'key-change-numbered-above-a-hidden-addition',
        async (w) => {
            const hidden = await w.add(FOLDER, member, [editor(keeper)], { hidden: true });
            const mine = [...w.served(FOLDER), hidden];
            await w.roster(admin, w.all, {
                rotate: { [FOLDER]: { people, listVersion: 7 } },
            });
            return [
                { through: 3, folder: FOLDER, served: mine },
                { through: 4, folder: FOLDER, served: w.served(FOLDER) },
            ];
        },
        (v) =>
            state('level', 7)(v) &&
            ids(listed(v[1]!).lost) === keeper.userId &&
            reasons(v[1]!).join() === LIST_REFUSALS.stale,
    );
    await add(
        // List versions count up through every folder key: key version 2's base is not list 1.
        'key-change-with-a-base-list-numbered-below-its-key',
        async (w) => {
            await w.roster(admin, w.all, { rotate: { [FOLDER]: { people, listVersion: 1 } } });
            return fresh(w);
        },
        noList('notTheBase'),
    );
    await add(
        // Heads are built only from every folder read, and never over one left unread.
        'heads-need-every-folder-read',
        async (w) => {
            const others = { [folderId(0)]: w.served(0) };
            const all = { ...others, [folderId(OWN)]: w.served(OWN) };
            return [
                {
                    through: 3,
                    folder: FOLDER,
                    served: w.served(FOLDER),
                    probes: { commit: { others } },
                },
                {
                    through: 3,
                    folder: FOLDER,
                    served: w.served(FOLDER),
                    probes: { commit: { others: all, retire: [folderId(OWN)] } },
                },
                {
                    through: 3,
                    folder: FOLDER,
                    served: w.served(FOLDER),
                    probes: { commit: { others: { ...all, [folderId(OWN)]: [] } } },
                },
            ];
        },
        (v) =>
            'error' in v[0]!.commit! &&
            v[0]!.commit.error === LIST_REFUSALS.incomplete &&
            'rows' in v[1]!.commit! &&
            v[1]!.commit.rows.length === 2 &&
            // A folder whose list was not served is forked: no heads over it.
            'error' in v[2]!.commit! &&
            v[2]!.commit.error === LIST_REFUSALS.forked,
    );
    await add(
        'key-change-with-no-base-list-served',
        async (w) => {
            const first = w.served(FOLDER);
            await w.roster(admin, w.all, { rotate: { [FOLDER]: { people } } });
            return [
                { through: 3, folder: FOLDER, served: first },
                { through: 4, folder: FOLDER, served: first, probes: { writable: true } },
            ];
        },
        (v) =>
            state('forked', 0)(v) &&
            listed(v[1]!).fork !== null &&
            v[1]!.writable === LIST_REFUSALS.forked,
    );
    await add(
        'key-change-owed-after-a-company-key-is-replaced',
        async (w) => {
            await w.roster(owner, w.all, { org: { custodyVersion: 2 } });
            const probes: ListProbes = {
                owed: true,
                access: [
                    { userId: admin.userId, session: 'key-change' },
                    { userId: admin.userId, session: 'browse' },
                    { userId: member.userId, session: 'key-change' },
                ],
            };
            return fresh(w, probes);
        },
        (v) =>
            v[0]!.owed === true &&
            // The rotation work and nothing else: no download URL.
            v[0]!.access![0]!.allows === 'rotate' &&
            v[0]!.access![1]!.allows === 'read,download,write,manage' &&
            v[0]!.access![2]!.access?.basis === 'list',
    );

    // A device's own records: read back as stored, and refused with any part edited.
    {
        const from = async (w: ListWorld) => {
            await w.add(FOLDER, member, [editor(keeper)]);
            await w.roster(admin, w.all);
            await w.add(FOLDER, member, [viewer(admin2)]);
            return [{ through: 4, folder: FOLDER, served: w.served(FOLDER) }] as ListStep[];
        };
        const again =
            (edit: (record: AreaListRecord) => AreaListRecord) => async (w: ListWorld) => {
                const steps = await from(w);
                // The record the first step leaves, in this very history.
                const [kept] = await listCaseVerdict({
                    input: await w.input(),
                    heads: w.heads,
                    steps: steps.map(({ folder, ...step }) => ({
                        ...step,
                        workspaceId: folderId(folder),
                    })),
                });
                const record = structuredClone(listed(kept!).record!);
                return [
                    ...steps,
                    { through: 4, folder: FOLDER, served: null, record: edit(record) },
                ];
            };
        await add(
            'from-a-record',
            again((r) => r),
            (v) => JSON.stringify(v[1]!.lists) === JSON.stringify(v[0]!.lists),
        );
        const edits: [string, (r: AreaListRecord) => AreaListRecord][] = [
            ['of-another-company', (r) => ({ ...r, groupId: folderId(9) })],
            ['of-another-folder', (r) => ({ ...r, workspaceId: folderId(OWN) })],
            ['at-a-key-the-chain-lacks', (r) => ({ ...r, workspaceKeyVersion: 2 })],
            [
                'with-another-base',
                (r) => ({ ...r, digests: [r.digests[1]!, ...r.digests.slice(1)] }),
            ],
            [
                'with-a-digest-swapped',
                (r) => ({ ...r, digests: [r.digests[0]!, r.digests[2]!, r.digests[1]!] }),
            ],
            ['with-a-list-dropped', (r) => ({ ...r, lists: r.lists.slice(0, 1) })],
            ['with-lists-swapped', (r) => ({ ...r, lists: [r.lists[1]!, r.lists[0]!] })],
            [
                'committed-further-than-it-holds',
                (r) => ({ ...r, committed: { ...r.committed, listVersion: 3 } }),
            ],
            [
                'committed-by-a-roster-yet-to-come',
                (r) => ({ ...r, committed: { ...r.committed, rosterVersion: 9 } }),
            ],
            [
                'with-a-standing-dropped',
                (r) => ({ ...r, since: Object.fromEntries(Object.entries(r.since).slice(1)) }),
            ],
            [
                'with-a-standing-added',
                (r) => ({ ...r, since: { ...r.since, [newcomer.userId]: 1 } }),
            ],
            [
                'with-a-fork-of-another-kind',
                (r) => ({ ...r, forks: [{ kind: 'share-log' } as unknown as ForkNote] }),
            ],
        ];
        for (const [name, edit] of edits)
            await add(
                `record-edited-${name}`,
                again(edit),
                (v) => 'error' in v[1]!.lists && v[1]!.lists.error === LIST_REFUSALS.record,
            );
        const withHeads = (edit: (record: HeadsRecord) => HeadsRecord) => async (w: ListWorld) => {
            const steps = await from(w);
            const { record } = await readHeads({
                chain: await chainThrough(await w.input(), 4),
                record: null,
                served: w.heads,
            });
            return [
                ...steps,
                {
                    through: 4,
                    folder: FOLDER,
                    served: null,
                    headsRecord: edit(structuredClone(record)),
                },
            ];
        };
        await add(
            'from-a-heads-record',
            withHeads((r) => r),
            (v) => JSON.stringify(v[1]) === JSON.stringify(v[0]),
        );
        const row = (
            r: HeadsRecord,
            edit: (row: HeadsRecord['areas'][string][number]) => object,
        ) => ({
            ...r,
            areas: {
                ...r.areas,
                [folderId(FOLDER)]: r.areas[folderId(FOLDER)]!.map((at, index, all) =>
                    index === all.length - 1 ? ({ ...at, ...edit(at) } as typeof at) : at,
                ),
            },
        });
        const headsEdits: [string, (r: HeadsRecord) => HeadsRecord][] = [
            ['of-another-company', (r) => ({ ...r, groupId: folderId(9) })],
            ['through-another-roster', (r) => ({ ...r, rosterVersion: 3 })],
            ['through-a-roster-yet-to-come', (r) => ({ ...r, rosterVersion: 9 })],
            ['at-another-roster-digest', (r) => ({ ...r, rosterDigest: encode(pattern(32, 9)) })],
            ['with-a-further-list', (r) => row(r, (at) => ({ listVersion: at.listVersion + 1 }))],
            [
                'with-another-list-digest',
                (r) => row(r, () => ({ listDigest: encode(pattern(32, 9)) })),
            ],
            ['with-a-longer-share-log', (r) => row(r, () => ({ shareLogIndex: 1 }))],
            [
                'with-a-folder-dropped',
                (r) => ({ ...r, areas: Object.fromEntries(Object.entries(r.areas).slice(1)) }),
            ],
            ['with-rows-out-of-order', (r) => row(r, () => ({ rosterVersion: 1 }))],
        ];
        for (const [name, edit] of headsEdits)
            await add(
                `heads-record-edited-${name}`,
                withHeads(edit),
                (v) =>
                    'error' in v[1]!.heads! &&
                    v[1]!.heads.error === LIST_REFUSALS.headsRecord &&
                    'error' in v[1]!.lists &&
                    v[1]!.lists.error === LIST_REFUSALS.headsRecord,
            );
    }
    return cases;
}

/* The fork dismissal a fixture keeps, parsed again: both twins give the same fields. */
export function dismissalFields(statement: string) {
    return parseForkDismissal(decode(statement));
}

/* Raw statements against the list, heads and dismissal grammars: both twins parse or refuse alike. */
export async function listStatementCases() {
    const a = '00000001-abcd-4abc-8abc-abcdefabcdef';
    const b = '00000002-abcd-4abc-8abc-abcdefabcdef';
    const d = encode(pattern(32, 3));
    const n = encode(pattern(16, 4));
    const list = (
        over: Record<number, unknown> = {},
        people: unknown = [
            [a, 'manager'],
            [b, 'viewer'],
        ],
    ) => {
        const parts: unknown[] = [
            'hushos/group/area-list',
            1,
            GROUP,
            AREA,
            2,
            d,
            1,
            a,
            1,
            3,
            d,
            n,
            '',
            people,
        ];
        for (const [index, value] of Object.entries(over)) parts[Number(index)] = value;
        return parts;
    };
    const dismissed = (over: Record<number, unknown> = {}) => {
        const parts: unknown[] = [
            'hushos/group/fork-dismissal',
            1,
            GROUP,
            AREA,
            'list',
            2,
            d,
            2,
            d,
            a,
            1,
            3,
            d,
        ];
        for (const [index, value] of Object.entries(over)) parts[Number(index)] = value;
        return parts;
    };
    const cases: [string, 'area-list' | 'fork-dismissal', unknown[] | string, boolean][] = [
        ['an-addition', 'area-list', list(), true],
        ['a-base-list', 'area-list', list({ 5: '' }), true],
        ['a-base-list-under-roster-1', 'area-list', list({ 5: '', 9: 0, 10: '' }), true],
        ['open-to-everyone', 'area-list', list({ 12: 'editor' }), true],
        ['nobody-named', 'area-list', list({}, []), true],
        ['an-addition-that-names-no-roster', 'area-list', list({ 9: 0, 10: '' }), false],
        ['roster-0-with-a-digest', 'area-list', list({ 5: '', 9: 0 }), false],
        ['a-roster-with-no-digest', 'area-list', list({ 5: '', 10: '' }), false],
        ['version-2-of-the-statement', 'area-list', list({ 1: 2 }), false],
        ['list-version-0', 'area-list', list({ 4: 0 }), false],
        ['everyone-as-manager', 'area-list', list({ 12: 'manager' }), false],
        ['a-role-that-is-none', 'area-list', list({}, [[a, 'owner']]), false],
        [
            'people-out-of-order',
            'area-list',
            list({}, [
                [b, 'viewer'],
                [a, 'manager'],
            ]),
            false,
        ],
        [
            'someone-twice',
            'area-list',
            list({}, [
                [a, 'viewer'],
                [a, 'manager'],
            ]),
            false,
        ],
        ['a-nonce-of-15-bytes', 'area-list', list({ 11: encode(pattern(15, 4)) }), false],
        ['an-uppercase-id', 'area-list', list({ 7: a.toUpperCase() }), false],
        ['a-person-with-three-fields', 'area-list', list({}, [[a, 'viewer', 1]]), false],
        ['thirteen-parts', 'area-list', list().slice(0, 13), false],
        ['spaced', 'area-list', JSON.stringify(list()).replace(',', ', '), false],
        ['a-dismissal', 'fork-dismissal', dismissed(), true],
        [
            'a-share-log-dismissal-at-0',
            'fork-dismissal',
            dismissed({ 4: 'share-log', 5: 0, 7: 0 }),
            true,
        ],
        ['a-list-dismissal-at-0', 'fork-dismissal', dismissed({ 5: 0 }), false],
        ['a-dismissal-of-another-kind', 'fork-dismissal', dismissed({ 4: 'roster' }), false],
        ['a-dismissal-of-twelve-parts', 'fork-dismissal', dismissed().slice(0, 12), false],
        [
            'a-dismissal-with-a-hex-digest',
            'fork-dismissal',
            dismissed({ 6: 'ab'.repeat(32) }),
            false,
        ],
    ];
    const rows = (over: Partial<HeadRow>[] = [{}, {}]): HeadRow[] =>
        over.map((at, index) => ({
            workspaceId: index === 0 ? AREA : folderId(1),
            workspaceKeyVersion: 1,
            listVersion: 1,
            listDigest: d,
            shareLogIndex: 0,
            shareLogDigest: d,
            ...at,
        }));
    const heads: [string, HeadRow[]][] = [
        ['two-folders', rows()],
        ['no-folders', []],
        ['a-log-of-three', rows([{ shareLogIndex: 3 }])],
        ['folders-out-of-order', rows().reverse()],
        ['a-folder-twice', rows([{}, { workspaceId: AREA }])],
        ['list-version-0', rows([{ listVersion: 0 }])],
    ];
    return {
        statements: cases.map(([name, kind, parts, valid]) => ({
            name,
            kind,
            statement: encode(
                new TextEncoder().encode(typeof parts === 'string' ? parts : JSON.stringify(parts)),
            ),
            valid,
        })),
        heads: await Promise.all(
            heads.map(async ([name, at]) => ({
                name,
                rows: at,
                digest: await headsDigest(GROUP, at).catch(() => null),
            })),
        ),
        shareLogStart: await shareLogStart(GROUP, AREA),
    };
}

/* What this twin says of a raw statement: its fields re-encoded, or refused. */
export function listStatementVerdict(kind: string, statement: string) {
    try {
        const bytes = decode(statement);
        return encode(
            kind === 'area-list'
                ? areaListStatement(parseAreaList(bytes))
                : forkDismissalStatement(parseForkDismissal(bytes)),
        );
    } catch (error) {
        refusal(error);
        return 'refused';
    }
}

/* The folder's rows over the verdict of design 2.8, case by case: both twins map them alike. */
export function folderVerdictCases() {
    const verdicts: GroupIntegrity[] = [
        'verified',
        'seen',
        'saved-from-link',
        'resealed',
        'retired-key',
        'bad-signature',
        'unsigned',
        'unchecked',
        'key-conflict',
        'former-member',
    ];
    const trusts = ['roster', 'outside', 'former-member', 'key-conflict', 'unchecked'] as const;
    const standings: FolderStanding[] = [
        'unchecked',
        'listed',
        'data-admin',
        'share',
        'not-on-this-folder',
    ];
    const out = [];
    for (const integrity of verdicts)
        for (const trust of trusts)
            for (const standing of standings)
                for (const via of [null, GROUP])
                    out.push({
                        integrity,
                        via,
                        trust,
                        standing,
                        expected: folderVerdict(integrity, via, trust, standing),
                    });
    return out;
}

export function folderVerdict(
    integrity: GroupIntegrity,
    via: string | null,
    trust: GroupWriterTrust['trust'],
    standing: FolderStanding,
) {
    return folderIntegrityOf({ integrity, via }, { trust } as GroupWriterTrust, standing);
}

/* One grant of the company's first folder, sealed or to be sealed, and who reads it with which list. */
export type GrantItem = {
    name: string;
    kind: 'open' | 'sealing';
    through: number;
    /* What the device was served of the folder's lists: all of them, the base list alone, or it read none. */
    lists: 'full' | 'base' | 'none';
    ctx: AreaGrantContext;
    envelope?: string;
    granter: number;
    reader: number;
    expected?: string;
};

/* One record in the company's first folder, and the reader who judges its writer. */
export type RecordItem = {
    name: string;
    through: number;
    lists: 'full' | 'base' | 'none';
    writer: number;
    signedBy: number;
    pinned: boolean;
    sharedEditors: string[];
    expected?: { integrity: string; via: string | null };
};

/*
 * A company's first folder (its area derived under the group, so its grants
 * open) with a list, for the grants and the writer verdicts that go by it
 * (2.3, "Grants", "Who writes"): the Owner, its manager, adds a Member as a
 * viewer and the kit holder as an editor; roster 3 commits that; grants are
 * made there; and roster 4 removes the Admin who made one of them.
 */
export async function folderItems() {
    const w = await listWorld({ folders: false });
    const { owner, admin, member, keeper, biller, another } = w.cast;
    const base = w.served(0);
    await w.add(0, owner, [
        { userId: member.userId, role: 'viewer' },
        { userId: keeper.userId, role: 'editor' },
    ]);
    const full = w.served(0);
    await w.roster(admin, w.all);
    const input3 = await w.input();
    const folder: FolderData = { input: input3, heads: w.heads, served: { full, base } };
    const chain = await chainThrough(input3, 3);
    const lists = (await listsAt(folder, 3, 'full'))!;
    const at = { rosterVersion: 3, rosterDigest: chain.rosterDigest };
    const grant = (granter: Person, reader: Person): AreaGrantContext => ({
        groupId: GROUP,
        workspaceId: AREA,
        workspaceKeyVersion: 1,
        granteeUserId: reader.userId,
        granteeKeyVersion: 1,
        granterUserId: granter.userId,
        ...at,
    });
    const sealed = async (granter: Person, reader: Person) =>
        encode(
            await sealAreaGrant(areaKeyAt(AREA, 1), grant(granter, reader), {
                chain,
                areaIdSeed: AREA_SEED,
                granteeKemPublicKey: reader.kemPublicKey,
                granter: granter.signer,
                lists,
            }),
        );
    const toMember = await sealed(owner, member);
    const byAdmin = await sealed(admin, keeper);
    // The Owner removes the Admin (a new company key with it): the Admin's grant is from before.
    await w.roster(
        owner,
        [
            ...w.all.filter((entry) => entry.userId !== admin.userId),
            { ...w.e.admin, status: 'left', roles: [] },
        ],
        { org: { custodyVersion: 2 } },
    );
    const open = (
        name: string,
        through: number,
        which: GrantItem['lists'],
        envelope: string,
        granter: Person,
        reader: Person,
    ): GrantItem => ({
        name,
        kind: 'open',
        through,
        lists: which,
        ctx: grant(granter, reader),
        envelope,
        granter: granter.n,
        reader: reader.n,
    });
    const sealing = (name: string, which: GrantItem['lists'], reader: Person): GrantItem => ({
        name,
        kind: 'sealing',
        through: 3,
        lists: which,
        ctx: grant(owner, reader),
        granter: owner.n,
        reader: reader.n,
    });
    const grants: GrantItem[] = [
        open('grant-to-someone-on-the-list', 3, 'full', toMember, owner, member),
        // The reader's device was not served the addition that names them: nothing opens.
        open('grant-read-without-the-addition', 3, 'base', toMember, owner, member),
        open('grant-read-without-a-list', 3, 'none', toMember, owner, member),
        open('grant-by-an-admin-read-while-they-are-one', 3, 'full', byAdmin, admin, keeper),
        // Judged at the roster it names: it opens after the Admin who made it is removed.
        open('grant-by-an-admin-since-removed', 4, 'full', byAdmin, admin, keeper),
        // The Owner's grant with another granter's name on it opens nothing.
        open('grant-renamed-to-another-granter', 4, 'full', toMember, admin, member),
        sealing('sealing-to-someone-on-the-list', 'full', member),
        // A colleague the list does not name is sealed nothing, and nothing is sealed without a list.
        sealing('sealing-to-a-colleague-off-the-list', 'full', another),
        sealing('sealing-without-a-list', 'none', member),
        sealing('sealing-without-the-addition-that-names-them', 'base', member),
    ];
    const record = (name: string, writer: Person, over: Partial<RecordItem> = {}): RecordItem => ({
        name,
        through: 3,
        lists: 'full',
        writer: writer.n,
        signedBy: writer.n,
        pinned: false,
        sharedEditors: [],
        ...over,
    });
    const records: RecordItem[] = [
        record('record-by-an-editor-on-the-list', keeper),
        record('record-by-an-admin-on-no-list', admin),
        record('record-by-a-viewer', member),
        record('record-by-a-colleague-on-no-list', another),
        // The reader's own words check says whose keys these are, not that they are on the folder.
        record('record-by-a-colleague-the-reader-checked', another, { pinned: true }),
        record('record-by-an-editor-the-reader-checked', keeper, { pinned: true }),
        record('record-by-a-colleague-who-edits-by-a-share', another, {
            sharedEditors: [another.userId],
        }),
        record('record-read-with-no-list', keeper, { lists: 'none' }),
        record('record-read-with-the-list-forked', keeper, { lists: 'base' }),
        record('record-with-a-bad-signature-on-the-folder', keeper, { signedBy: biller.n }),
        record('record-with-a-bad-signature-off-the-folder', another, { signedBy: biller.n }),
        record('record-by-a-checked-colleague-with-the-list-forked', another, {
            pinned: true,
            lists: 'base',
        }),
    ];
    const data: FolderData = { ...folder, input: await w.input(), heads: w.heads };
    for (const item of grants) item.expected = await grantItemVerdict(data, item);
    for (const item of records) item.expected = await recordItemVerdict(data, item);
    return { ...data, grants, records };
}
export type FolderData = {
    input: AcceptInput;
    heads: { rosterVersion: number; rows: HeadRow[] }[];
    served: { full: SignedAreaList[]; base: SignedAreaList[] };
};

/* The folder's list as a device served `which` of its lists reads it at `through`; null when it read none. */
async function listsAt(folder: FolderData, through: number, which: GrantItem['lists']) {
    if (which === 'none') return null;
    const chain = await chainThrough(folder.input, through);
    const heads = await readHeads({ chain, record: null, served: folder.heads });
    return readAreaLists({
        chain,
        heads: heads.record,
        workspaceId: AREA,
        record: null,
        served: folder.served[which],
        mlDsaKeys: folder.input.mlDsaKeys,
    });
}

/* What this twin says of a grant item: `opened:<key>`, `sealed` or `refused`. */
export async function grantItemVerdict(folder: FolderData, item: GrantItem): Promise<string> {
    const chain = await chainThrough(folder.input, item.through);
    const lists = await listsAt(folder, item.through, item.lists);
    const granter = await person(item.granter);
    const reader = await person(item.reader);
    try {
        if (item.kind === 'sealing') {
            await sealAreaGrant(areaKeyAt(AREA, 1), item.ctx, {
                chain,
                areaIdSeed: AREA_SEED,
                granteeKemPublicKey: reader.kemPublicKey,
                granter: granter.signer,
                lists,
            });
            return 'sealed';
        }
        const key = await openAreaGrant(decode(item.envelope!), item.ctx, {
            chain,
            areaIdSeed: AREA_SEED,
            granterMlDsaPublicKey: granter.mlDsaPublicKey,
            reader: { userId: reader.userId, keyVersion: 1 },
            grantee: reader.secrets,
            lists,
        });
        return `opened:${encode(key)}`;
    } catch (error) {
        refusal(error);
        return 'refused';
    }
}

/* What this twin says of a record item: the verdict of design 2.8, then the folder's own rows. */
export async function recordItemVerdict(folder: FolderData, item: RecordItem) {
    const chain = await chainThrough(folder.input, item.through);
    const lists = await listsAt(folder, item.through, item.lists);
    const writer = await person(item.writer);
    const signer = await person(item.signedBy);
    const trust = await groupWriterTrust({
        groupId: GROUP,
        areas: { [AREA]: 1 },
        reading: { status: 'accepted', chain },
        workspaceId: AREA,
        writerUserId: writer.userId,
        pinned: item.pinned ? await writer.pinned() : null,
        served: writer.served,
        links: [],
    });
    const verdict = await groupIntegrityOf(
        () => metadataStatements(RECORD, ENVELOPE),
        await recordSignature(signer.signer.signingKey),
        trust,
        null,
    );
    return folderIntegrityOf(
        verdict,
        trust,
        folderStanding({
            chain,
            lists,
            workspaceId: AREA,
            writerUserId: writer.userId,
            sharedEditors: item.sharedEditors,
        }),
    );
}
