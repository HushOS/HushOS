import { requireAccepted } from './accepted';
import {
    ascending,
    bytesOf,
    digestOf,
    encodeStatement,
    integer,
    oneOf,
    parseStatement,
    requireCanonical,
    uuid,
} from './canonical';
import { RETIRED } from './area-keys';
import { CryptoError } from './errors';
import type { AcceptedRosters, OrgChain, RosterSpan, SignerKeysAt } from './group-trust';
import { activeWith, rosterEntry, type AreaKind, type RosterMember } from './groups';
import { decode, encode } from './keys';
import { ML_DSA_PUBLIC_KEY_BYTES } from './pq';
import { sameGroup, sealedAtLatest, sealerHolds } from './seal-rules';
import {
    HYBRID_SIGNATURE_BYTES,
    digest,
    signHybrid,
    verifyHybrid,
    type HybridSigningKey,
} from './signatures';

/*
 * Who opens which company folder (docs/companies-design.md 2.3): the signed
 * list of an area, base lists and additions, the heads every roster commits
 * to, the four states a device can be in against the furthest committed head
 * (level, behind, ahead, forked), settling a fork and its signed dismissal,
 * and the resolver (areaAccess). `hushos-core` (area_lists.rs) makes and
 * judges the same bytes, pinned by the shared company fixtures.
 *
 * A list is a long-lived signed statement: it is judged at the roster it
 * names, under the keys its signer's entry named there (OrgChain.signerKeys),
 * with the standing its signer had there (OrgChain.active, OrgChain.dataAdmins),
 * never by what the latest roster says of them. What a signer could still
 * sign after their standing ended is bounded by the heads the roster that
 * ended it committed (AFTER_LEAVING).
 *
 * Families have no lists: every member of a family opens every area, and
 * nothing here applies to one.
 */

/* The statement (2.3) ------------------------------------------------------ */

export type ListRole = 'editor' | 'manager' | 'viewer';
export type EveryoneRole = '' | 'editor' | 'viewer';
export const LIST_ROLES: readonly ListRole[] = ['editor', 'manager', 'viewer'];
export const EVERYONE_ROLES: readonly EveryoneRole[] = ['', 'editor', 'viewer'];
/* The most people one list names (2.3). */
export const MAX_LIST_PEOPLE = 10_000;
/* A list's nonce: 16 random bytes, new in every statement, so a digest says nothing of a small folder's people. */
export const LIST_NONCE_BYTES = 16;

export type ListPerson = { userId: string; role: ListRole };
export type AreaList = {
    groupId: string;
    workspaceId: string;
    /* Counts up through the life of the area, across key versions. */
    listVersion: number;
    /* SHA-256 of the list before it, base64url; "" for a base list. */
    previousListDigest: string;
    workspaceKeyVersion: number;
    signerUserId: string;
    signerKeyVersion: number;
    /* The roster the signer names: 0 and "" together, and only for a base list roster 1 commits. */
    rosterVersion: number;
    rosterDigest: string;
    nonce: string;
    everyone: EveryoneRole;
    /* Sorted by userId, no one twice. */
    people: ListPerson[];
};

const AREA_LIST_DOMAIN = 'hushos/group/area-list';

/* ["hushos/group/area-list",1,groupId,workspaceId,listVersion,previousListDigest,workspaceKeyVersion,signerUserId,signerKeyVersion,rosterVersion,rosterDigest,nonce,everyone,people] */
export function areaListStatement(list: AreaList) {
    if (typeof list !== 'object' || list === null) throw new CryptoError('Invalid area list.');
    if (!Array.isArray(list.people) || list.people.length > MAX_LIST_PEOPLE)
        throw new CryptoError('Invalid list people.');
    const people = list.people.map((person) => {
        if (typeof person !== 'object' || person === null)
            throw new CryptoError('Invalid list people.');
        return [uuid(person.userId, 'user id'), oneOf(person.role, LIST_ROLES, 'list role')];
    });
    ascending(
        people.map(([id]) => id as string),
        'list people',
    );
    const base = list.previousListDigest === '';
    // Roster 0 and no digest go together, and only on a base list: the one roster 1 commits.
    const unanchored = list.rosterVersion === 0 && list.rosterDigest === '';
    if (unanchored && !base) throw new CryptoError('Invalid area list.');
    return encodeStatement([
        AREA_LIST_DOMAIN,
        1,
        uuid(list.groupId, 'group id'),
        uuid(list.workspaceId, 'workspace id'),
        integer(list.listVersion, 'list version'),
        base ? '' : digestOf(list.previousListDigest, 'list digest'),
        integer(list.workspaceKeyVersion, 'workspace key version'),
        uuid(list.signerUserId, 'user id'),
        integer(list.signerKeyVersion, 'key version'),
        unanchored ? 0 : integer(list.rosterVersion, 'roster version'),
        unanchored ? '' : digestOf(list.rosterDigest, 'roster digest'),
        bytesOf(list.nonce, LIST_NONCE_BYTES, 'list nonce'),
        oneOf(list.everyone, EVERYONE_ROLES, 'list role'),
        people,
    ]);
}

/* The list a statement's bytes hold, refused unless the bytes are its canonical encoding. */
export function parseAreaList(statement: Uint8Array): AreaList {
    const parts = parseStatement(statement, 'area list');
    if (
        parts.length !== 14 ||
        parts[0] !== AREA_LIST_DOMAIN ||
        parts[1] !== 1 ||
        !Array.isArray(parts[13])
    )
        throw new CryptoError('Invalid area list.');
    const list = {
        groupId: parts[2],
        workspaceId: parts[3],
        listVersion: parts[4],
        previousListDigest: parts[5],
        workspaceKeyVersion: parts[6],
        signerUserId: parts[7],
        signerKeyVersion: parts[8],
        rosterVersion: parts[9],
        rosterDigest: parts[10],
        nonce: parts[11],
        everyone: parts[12],
        people: (parts[13] as unknown[]).map((person) => {
            if (!Array.isArray(person) || person.length !== 2)
                throw new CryptoError('Invalid list people.');
            return { userId: person[0], role: person[1] };
        }),
    } as AreaList;
    requireCanonical(statement, areaListStatement(list), 'area list');
    return list;
}

/* SHA-256 of a list statement, base64url: what a roster row, a heads row and the next list name. */
export async function areaListDigest(statement: Uint8Array) {
    return digest(statement);
}

/* A list as the server stores and serves it: the statement and its signer's hybrid signature, base64url. */
export type SignedAreaList = { statement: string; signature: string };

/* Heads (2.3) -------------------------------------------------------------- */

/* One area's head as a roster's signer verified it: its list and its share log. */
export type HeadRow = {
    workspaceId: string;
    workspaceKeyVersion: number;
    listVersion: number;
    listDigest: string;
    /* The share log's length and digest (2.4); 0 and shareLogStart for an empty log. */
    shareLogIndex: number;
    shareLogDigest: string;
};

const HEADS_DOMAIN = 'hushos/group/heads';
const SHARE_LOG_DOMAIN = 'hushos/group/share-log/v1';

function count(value: unknown, what: string) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw new CryptoError(`Invalid ${what}.`);
    return value;
}

function headRowParts(row: HeadRow) {
    if (typeof row !== 'object' || row === null) throw new CryptoError('Invalid heads.');
    return [
        uuid(row.workspaceId, 'workspace id'),
        integer(row.workspaceKeyVersion, 'workspace key version'),
        integer(row.listVersion, 'list version'),
        digestOf(row.listDigest, 'list digest'),
        count(row.shareLogIndex, 'share log index'),
        digestOf(row.shareLogDigest, 'share log digest'),
    ];
}

/*
 * headsDigest = SHA-256(["hushos/group/heads",1,groupId,rows]), base64url:
 * what a roster's `heads` field carries. `rows` is every live area after
 * that roster, sorted by workspace id, none twice.
 */
export async function headsDigest(groupId: string, rows: readonly HeadRow[]) {
    if (!Array.isArray(rows)) throw new CryptoError('Invalid heads.');
    const parts = rows.map(headRowParts);
    ascending(
        parts.map(([id]) => id as string),
        'heads',
    );
    return digest(encodeStatement([HEADS_DOMAIN, 1, uuid(groupId, 'group id'), parts]));
}

/*
 * An empty share log's digest (2.4): SHA-256("hushos/group/share-log/v1" ‖
 * groupId (36 ASCII bytes) ‖ workspaceId (36)), base64url. What a heads row
 * carries at index 0; the log itself is the share records' (PR 3).
 */
export async function shareLogStart(groupId: string, workspaceId: string) {
    return digest(
        new TextEncoder().encode(
            SHARE_LOG_DOMAIN + uuid(groupId, 'group id') + uuid(workspaceId, 'workspace id'),
        ),
    );
}

/* A row as one roster committed it. */
export type CommittedHead = Omit<HeadRow, 'workspaceId'> & { rosterVersion: number };

/*
 * What a device keeps of the heads its chain's rosters committed (its own
 * record, local, never synced): through which roster, and for every area each
 * row a roster committed that differed from the one before, oldest first. The
 * furthest head of an area is the highest list version, and the highest log
 * position, any of them names: a later roster with a lower row moves nothing.
 */
export type HeadsRecord = {
    groupId: string;
    rosterVersion: number;
    rosterDigest: string;
    areas: Record<string, CommittedHead[]>;
};

export const HEADS_MISMATCH = 'These are not the folder records this member list commits to.';
const BAD_HEADS = 'Invalid heads record.';
const NOT_A_COMPANY = 'This is not a company.';
const NOT_AN_AREA = 'This folder is not one of the company’s.';

function companyOf(chain: AcceptedRosters, groupId?: string): OrgChain {
    if (groupId === undefined) requireAccepted(chain);
    else sameGroup(chain, groupId);
    if (chain.kind !== 'org' || !chain.org) throw new CryptoError(NOT_A_COMPANY);
    return chain.org;
}

const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined =>
    Object.hasOwn(map, key) ? map[key] : undefined;

/* The span of `spans` that covers roster `at`, if any. */
function spanAt(spans: readonly RosterSpan[] | undefined, at: number) {
    return spans?.find((span) => span.from <= at && (span.until === null || at < span.until));
}

/* An area's key version at roster `at`: how many of its keys the chain had listed by then. */
function keyVersionAt(org: OrgChain, workspaceId: string, at: number) {
    return (own(org.areaRosters, workspaceId) ?? []).filter((row) => row.rosterVersion <= at)
        .length;
}

/* The live areas after roster `at`, sorted: listed by then and not yet retired. */
function liveAreasAt(org: OrgChain, at: number) {
    return Object.keys(org.areaRosters)
        .filter((id) => {
            const retiredAt = own(org.areaRetiredAt, id);
            return keyVersionAt(org, id, at) > 0 && (retiredAt === undefined || retiredAt > at);
        })
        .sort();
}

/* The full set of rows after roster `at`, from a record's deltas. */
function rowsAt(org: OrgChain, areas: Record<string, CommittedHead[]>, at: number): HeadRow[] {
    return liveAreasAt(org, at).map((workspaceId) => {
        const row = (own(areas, workspaceId) ?? []).filter((r) => r.rosterVersion <= at).at(-1);
        if (!row) throw new CryptoError(BAD_HEADS);
        return {
            workspaceId,
            workspaceKeyVersion: row.workspaceKeyVersion,
            listVersion: row.listVersion,
            listDigest: row.listDigest,
            shareLogIndex: row.shareLogIndex,
            shareLogDigest: row.shareLogDigest,
        };
    });
}

/* A record as stored, checked field by field and against the chain it is through. */
async function checkHeadsRecord(chain: AcceptedRosters, org: OrgChain, value: unknown) {
    const bad = () => new CryptoError(BAD_HEADS);
    try {
        if (typeof value !== 'object' || value === null) throw bad();
        const record = value as HeadsRecord;
        const through = integer(record.rosterVersion, 'roster version');
        if (
            record.groupId !== chain.groupId ||
            chain.rosterDigests[through - 1] !== record.rosterDigest ||
            typeof record.areas !== 'object' ||
            record.areas === null
        )
            throw bad();
        const areas: Record<string, CommittedHead[]> = {};
        for (const [workspaceId, rows] of Object.entries(record.areas)) {
            if (!own(org.areaRosters, workspaceId) || !Array.isArray(rows) || rows.length === 0)
                throw bad();
            let floor = 0;
            areas[workspaceId] = rows.map((row) => {
                const at = integer(row.rosterVersion, 'roster version');
                if (at <= floor || at > through) throw bad();
                floor = at;
                const [, ...rest] = headRowParts({ ...row, workspaceId });
                return {
                    rosterVersion: at,
                    workspaceKeyVersion: rest[0] as number,
                    listVersion: rest[1] as number,
                    listDigest: rest[2] as string,
                    shareLogIndex: rest[3] as number,
                    shareLogDigest: rest[4] as string,
                };
            });
        }
        // The rows it holds for the roster it is through are the ones that roster commits to.
        if (
            (await headsDigest(chain.groupId, rowsAt(org, areas, through))) !==
            org.headsDigests[through - 1]
        )
            throw bad();
        return {
            groupId: chain.groupId,
            rosterVersion: through,
            rosterDigest: record.rosterDigest,
            areas,
        };
    } catch (error) {
        if (error instanceof CryptoError) throw bad();
        throw error;
    }
}

/*
 * Reads the rows served with each roster after the record (2.3, "Heads"):
 * `served` holds, for a roster, the rows that differ from the roster before
 * (or all of them). Each roster's full set is rebuilt from the one before:
 * the areas it retired drop out, the served rows replace or add. A set is
 * taken only when it is exactly the live areas after that roster, each at
 * the key version the chain gives it there (an empty log at its start
 * digest), and hashes to that roster's `headsDigest` on the chain; anything
 * else is refused (HEADS_MISMATCH) and nothing is taken. Rosters are read in
 * order and reading stops at the first one not served: the record says how
 * far it got.
 *
 * `lowered` lists the rows that fell below one an earlier roster committed
 * for the same area: they move nothing (the furthest head stays), and are
 * what a device reports (route C33, `ahead`).
 */
export async function readHeads(input: {
    chain: AcceptedRosters;
    record: HeadsRecord | null;
    served: readonly { rosterVersion: number; rows: readonly HeadRow[] }[];
}): Promise<{
    record: HeadsRecord;
    lowered: { rosterVersion: number; workspaceId: string; list: boolean; shareLog: boolean }[];
}> {
    const { chain } = input;
    const org = companyOf(chain);
    const record: HeadsRecord = input.record
        ? await checkHeadsRecord(chain, org, input.record)
        : { groupId: chain.groupId, rosterVersion: 0, rosterDigest: '', areas: {} };
    const areas: Record<string, CommittedHead[]> = Object.fromEntries(
        Object.entries(record.areas).map(([id, rows]) => [id, rows.map((row) => ({ ...row }))]),
    );
    const lowered: {
        rosterVersion: number;
        workspaceId: string;
        list: boolean;
        shareLog: boolean;
    }[] = [];
    let through = record.rosterVersion;
    for (let at = through + 1; at <= chain.rosterDigests.length; at++) {
        const given = input.served.filter((entry) => entry.rosterVersion === at);
        if (given.length === 0) break;
        if (given.length !== 1 || !Array.isArray(given[0]!.rows))
            throw new CryptoError(HEADS_MISMATCH);
        const live = liveAreasAt(org, at);
        const seen = new Set<string>();
        for (const row of given[0]!.rows) {
            const parts = headRowParts(row);
            const { workspaceId } = row;
            if (seen.has(workspaceId) || !live.includes(workspaceId))
                throw new CryptoError(HEADS_MISMATCH);
            seen.add(workspaceId);
            if (
                row.workspaceKeyVersion !== keyVersionAt(org, workspaceId, at) ||
                (row.shareLogIndex === 0 &&
                    row.shareLogDigest !== (await shareLogStart(chain.groupId, workspaceId)))
            )
                throw new CryptoError(HEADS_MISMATCH);
            const history = areas[workspaceId] ?? [];
            const before = history.at(-1);
            const next: CommittedHead = {
                rosterVersion: at,
                workspaceKeyVersion: parts[1] as number,
                listVersion: parts[2] as number,
                listDigest: parts[3] as string,
                shareLogIndex: parts[4] as number,
                shareLogDigest: parts[5] as string,
            };
            if (
                before &&
                before.workspaceKeyVersion === next.workspaceKeyVersion &&
                before.listVersion === next.listVersion &&
                before.listDigest === next.listDigest &&
                before.shareLogIndex === next.shareLogIndex &&
                before.shareLogDigest === next.shareLogDigest
            )
                continue;
            const list = history.some((row) => row.listVersion > next.listVersion);
            const shareLog = history.some((row) => row.shareLogIndex > next.shareLogIndex);
            if (list || shareLog) lowered.push({ rosterVersion: at, workspaceId, list, shareLog });
            areas[workspaceId] = [...history, next];
        }
        let rows: HeadRow[];
        try {
            rows = rowsAt(org, areas, at);
        } catch {
            throw new CryptoError(HEADS_MISMATCH);
        }
        if ((await headsDigest(chain.groupId, rows)) !== org.headsDigests[at - 1])
            throw new CryptoError(HEADS_MISMATCH);
        through = at;
    }
    if (through === 0) throw new CryptoError(HEADS_MISMATCH);
    return {
        record: {
            groupId: chain.groupId,
            rosterVersion: through,
            rosterDigest: chain.rosterDigests[through - 1]!,
            areas,
        },
        lowered,
    };
}

/*
 * The furthest head the record's rosters committed for an area (2.3, "A
 * committed head never moves back"): the highest list version and the
 * highest log position, each with the first roster that committed it. Null
 * for an area no roster in the record names.
 */
export function committedHead(record: HeadsRecord, workspaceId: string) {
    const rows = own(record.areas, workspaceId) ?? [];
    let list: CommittedHead | undefined;
    let shareLog: CommittedHead | undefined;
    for (const row of rows) {
        if (!list || row.listVersion > list.listVersion) list = row;
        if (!shareLog || row.shareLogIndex > shareLog.shareLogIndex) shareLog = row;
    }
    if (!list || !shareLog) return null;
    return {
        list: {
            rosterVersion: list.rosterVersion,
            workspaceKeyVersion: list.workspaceKeyVersion,
            listVersion: list.listVersion,
            listDigest: list.listDigest,
        },
        shareLog: {
            rosterVersion: shareLog.rosterVersion,
            shareLogIndex: shareLog.shareLogIndex,
            shareLogDigest: shareLog.shareLogDigest,
        },
    };
}

/* The four states (2.3, "Reading a new committed head") ---------------------- */

/*
 * Where a device's verified record stands against the furthest committed
 * head, for a list or a share log alike (2.3, 2.4):
 * - level: the committed head is where the record ends;
 * - behind: it is past the record, and the device has not caught up yet;
 * - ahead: it is a point on the record, before its end;
 * - forked: anything else.
 */
export type HeadState = 'level' | 'behind' | 'ahead' | 'forked';

/*
 * The state of a record against a committed head. `record` is the digest at
 * every position the device verified, from position `first` on; `reaches`
 * says whether what the server served extends the record to a head past it:
 * true (the caller then extends the record and judges again), false (the
 * server answered and nothing reaches it), or null (no answer yet: a request
 * that fails is tried again and is not an answer).
 */
export function headState(
    record: { first: number; digests: readonly string[] },
    head: { position: number; digest: string },
    reaches: boolean | null,
): HeadState {
    const end = record.first + record.digests.length - 1;
    if (head.position > end) return reaches === false ? 'forked' : 'behind';
    if (head.position < record.first) return 'forked';
    if (record.digests[head.position - record.first] !== head.digest) return 'forked';
    return head.position === end ? 'level' : 'ahead';
}

/* Verifying a list (2.3) --------------------------------------------------- */

/* The refusals of a list, by the rule that refuses it. Both twins give the same words. */
export const AFTER_LEAVING =
    'This was signed by someone who had lost the right to, past what the member list that ended it records.';
export const HEAD_BEHIND =
    'This folder’s record is behind the company’s: nothing is written here until this device has caught up.';
export const HEAD_FORKED =
    'This folder’s record does not match the company’s: nothing is written here until that is settled.';
export const NOT_THE_BASE = 'This is not the list the member list names for this folder key.';
export const NOT_FOLLOWING_LIST = 'This list does not follow from the one before it.';
export const NOT_ON_CHAIN = 'This list names a member list this device does not have.';
export const NOT_ENTITLED = 'This list is not signed by a manager of the folder or an admin.';
export const NOT_LIST_SIGNED = 'This list is not signed by the member it names.';
export const NARROWS =
    'A list after the first only adds people or raises a role: taking access away needs a key change.';
export const NOT_ACTIVE = 'A list names only active members of the company.';
export const EMPLOYEE_LIST = 'An employee’s folder is listed for its assignee alone.';
export const LIST_STALE =
    'This list was built on one the company’s record does not have: add the person again.';
const BAD_RECORD = 'Invalid list record.';

const RANK: Record<string, number> = { '': 0, viewer: 1, editor: 2, manager: 3 };

/* A list this device verified, as its record keeps it. */
export type StoredAreaList = SignedAreaList & {
    /* The roster the heads were read through when this device first held it. */
    heldAt: number;
    /* The roster at which this device first found it past the committed head and posted it again; null before. */
    reportedAt: number | null;
};

/* A fork this device saw (2.3, "The note, and who clears it"): the head a roster committed and the one this device held. */
export type ForkNote = {
    kind: 'list';
    committed: { position: number; digest: string };
    reported: { position: number; digest: string };
    /* The roster whose head showed it. */
    rosterVersion: number;
    /* Whether this device has taken the committed record as its base since. */
    settled: boolean;
};

/*
 * What a device keeps of one area's list (2.3, "What a device keeps"), in
 * its device record (local, never synced): the furthest committed head it
 * verified, with that list, and every list it has verified past it, its own
 * included. `digests` is every list it verified at this key version, the
 * base list first, so a committed point is told from one that is not on the
 * record. `since` says from which roster each entry of the committed list
 * counts for its person (2.3, "After someone comes back").
 */
export type AreaListRecord = {
    groupId: string;
    workspaceId: string;
    workspaceKeyVersion: number;
    baseListVersion: number;
    digests: string[];
    committed: { rosterVersion: number; listVersion: number };
    lists: StoredAreaList[];
    since: Record<string, number>;
    /* The roster through which rows that moved back were judged. */
    judgedThrough: number;
    forks: ForkNote[];
};

/* One verified point on a list's record. */
type Step = {
    list: AreaList;
    statement: string;
    signature: string;
    digest: string;
    since: Map<string, number>;
};

type Ctx = {
    chain: AcceptedRosters;
    org: OrgChain;
    workspaceId: string;
    kind: AreaKind;
    keyVersion: number;
    /* The roster that listed this key version, and so committed its base list. */
    committedAt: number;
    committedBy: string;
    baseDigest: string;
    /* The rows the chain's rosters committed for this area, oldest first; null while the heads are not read through the head. */
    rows: readonly CommittedHead[] | null;
    mlDsaKeys: Record<string, string>;
};

/* Whoever held `members` at a roster: rule 3 gives `members` and `data_admin` together or not at all. */
function membersSpanAt(org: OrgChain, userId: string, at: number) {
    return spanAt(own(org.dataAdmins, userId), at);
}

/* The keys a list's signer's entry named at the roster the list names (roster 1's for a list that names none). */
function keysAt(org: OrgChain, userId: string, rosterVersion: number): SignerKeysAt | undefined {
    const spans = own(org.signerKeys, userId) ?? [];
    return spans.filter((span) => span.from <= Math.max(rosterVersion, 1)).at(-1);
}

async function signedAt(
    ctx: Ctx,
    list: AreaList,
    statement: Uint8Array,
    signature: Uint8Array,
): Promise<boolean> {
    const named = keysAt(ctx.org, list.signerUserId, list.rosterVersion);
    if (!named || named.keyVersion !== list.signerKeyVersion) return false;
    try {
        const mlDsaPublicKey = decode(
            ctx.mlDsaKeys[named.mlDsaPublicKeyDigest] ?? '',
            ML_DSA_PUBLIC_KEY_BYTES,
        );
        return (
            signature.length === HYBRID_SIGNATURE_BYTES &&
            (await digest(mlDsaPublicKey)) === named.mlDsaPublicKeyDigest &&
            (await verifyHybrid(statement, signature, {
                signingPublicKey: decode(named.signingPublicKey, 32),
                mlDsaPublicKey,
            }))
        );
    } catch {
        return false;
    }
}

/* What a served or stored list is, parsed: null when its bytes are no list of this area. */
async function parsed(ctx: Ctx, signed: SignedAreaList) {
    try {
        const statement = decode(signed.statement);
        const list = parseAreaList(statement);
        decode(signed.signature, HYBRID_SIGNATURE_BYTES);
        if (list.groupId !== ctx.chain.groupId || list.workspaceId !== ctx.workspaceId) return null;
        return {
            list,
            statement: signed.statement,
            signature: signed.signature,
            digest: await digest(statement),
        };
    } catch {
        return null;
    }
}
type Parsed = NonNullable<Awaited<ReturnType<typeof parsed>>>;

/*
 * A base list (2.3): the list at a folder key version, committed by the
 * roster row that introduced it. Its digest is the row's; its signer is that
 * roster's signer; it names the roster before that one (0 and "" under roster
 * 1); it follows nothing; everyone it names is active on the roster that
 * commits it; and an employee area's is its assignee alone, as manager.
 */
async function checkBase(ctx: Ctx, at: Parsed, verify: boolean): Promise<Step> {
    const { list } = at;
    const before = ctx.committedAt - 1;
    if (
        at.digest !== ctx.baseDigest ||
        list.previousListDigest !== '' ||
        list.workspaceKeyVersion !== ctx.keyVersion ||
        list.signerUserId !== ctx.committedBy ||
        list.rosterVersion !== before ||
        list.rosterDigest !== (before === 0 ? '' : ctx.chain.rosterDigests[before - 1]) ||
        // An area's first list is list 1: the version counts up from there.
        (ctx.keyVersion === 1 && list.listVersion !== 1)
    )
        throw new CryptoError(NOT_THE_BASE);
    if (
        ctx.kind === 'employee' &&
        (list.everyone !== '' || list.people.length !== 1 || list.people[0]!.role !== 'manager')
    )
        throw new CryptoError(EMPLOYEE_LIST);
    for (const person of list.people)
        if (!spanAt(own(ctx.org.active, person.userId), ctx.committedAt))
            throw new CryptoError(NOT_ACTIVE);
    if (verify && !(await signedAt(ctx, list, decode(at.statement), decode(at.signature))))
        throw new CryptoError(NOT_LIST_SIGNED);
    return {
        ...at,
        // A base list's entries count from the roster that commits it.
        since: new Map(list.people.map((person) => [person.userId, ctx.committedAt])),
    };
}

/* The furthest list version the rosters up to `through` committed for this area at this key version; 0 for none. */
function committedThrough(ctx: Ctx, through: number) {
    let furthest = 0;
    for (const row of ctx.rows ?? [])
        if (row.rosterVersion <= through && row.workspaceKeyVersion === ctx.keyVersion)
            furthest = Math.max(furthest, row.listVersion);
    return furthest;
}

/*
 * An addition (2.3): a later list at the same key version. It follows the
 * list before it by version and digest; names a roster on the reader's
 * chain; is signed, under the keys their entry named there, by someone
 * active on that roster who was a manager on the list before it (by an entry
 * that counted for them then) or held `members`; only adds people, raises a
 * role or raises `everyone`; and everyone it adds or raises is active on the
 * roster it names. An employee area takes none. And where its signer's
 * standing ended on a later roster of the chain, it is within the heads
 * committed up to that roster, or refused (AFTER_LEAVING).
 */
async function checkAddition(ctx: Ctx, prev: Step, at: Parsed, verify: boolean): Promise<Step> {
    const { list } = at;
    const { org } = ctx;
    if (
        list.listVersion !== prev.list.listVersion + 1 ||
        list.previousListDigest !== prev.digest ||
        list.workspaceKeyVersion !== ctx.keyVersion
    )
        throw new CryptoError(NOT_FOLLOWING_LIST);
    if (ctx.kind === 'employee') throw new CryptoError(EMPLOYEE_LIST);
    const named = list.rosterVersion;
    if (named < 1 || ctx.chain.rosterDigests[named - 1] !== list.rosterDigest)
        throw new CryptoError(NOT_ON_CHAIN);
    // Who signed it, as the roster it names knew them.
    const active = spanAt(own(org.active, list.signerUserId), named);
    if (!active) throw new CryptoError(NOT_ENTITLED);
    const holder = membersSpanAt(org, list.signerUserId, named);
    const entry = prev.list.people.find((person) => person.userId === list.signerUserId);
    const manager =
        entry?.role === 'manager' && (prev.since.get(list.signerUserId) ?? 0) >= active.from;
    if (!manager && !holder) throw new CryptoError(NOT_ENTITLED);
    // Only more: nobody dropped, no role lowered, `everyone` not lowered.
    const next = new Map(list.people.map((person) => [person.userId, person.role]));
    if (RANK[list.everyone]! < RANK[prev.list.everyone]!) throw new CryptoError(NARROWS);
    for (const person of prev.list.people)
        if (RANK[next.get(person.userId) ?? '']! < RANK[person.role]!)
            throw new CryptoError(NARROWS);
    // Everyone it adds or raises is active on the roster it names, and counts from it.
    const since = new Map<string, number>();
    const was = new Map(prev.list.people.map((person) => [person.userId, person.role]));
    for (const person of list.people) {
        if (was.get(person.userId) === person.role) {
            since.set(person.userId, prev.since.get(person.userId) ?? 0);
            continue;
        }
        if (!spanAt(own(org.active, person.userId), named)) throw new CryptoError(NOT_ACTIVE);
        since.set(person.userId, named);
    }
    if (verify && !(await signedAt(ctx, list, decode(at.statement), decode(at.signature))))
        throw new CryptoError(NOT_LIST_SIGNED);
    // After leaving: the roster that ended the standing it was signed with bounds it. A manager's
    // ends when they are marked left; someone who signed as an admin alone, when `members` goes.
    const ended = manager ? active.until : (holder!.until ?? active.until);
    if (ended !== null && committedThrough(ctx, ended) < list.listVersion)
        throw new CryptoError(AFTER_LEAVING);
    return { ...at, since };
}

/* A list read against the chain: what readAreaLists and settleAreaFork return. */
export type AreaLists = {
    readonly groupId: string;
    readonly workspaceId: string;
    readonly areaKind: AreaKind;
    /* The chain's key version for the area, and the roster this was read at. */
    readonly workspaceKeyVersion: number;
    readonly rosterVersion: number;
    readonly rosterDigest: string;
    readonly state: HeadState;
    /* The latest list this device verified at that key version; version 0 and no people when it has none. */
    readonly listVersion: number;
    readonly listDigest: string;
    readonly everyone: EveryoneRole;
    readonly people: readonly (ListPerson & { since: number })[];
    /* What to keep and pass back next time; null when nothing was verified and nothing kept. */
    readonly record: AreaListRecord | null;
    /* The lists this device holds past the committed head: posted again when it is ahead or forked. */
    readonly repost: readonly SignedAreaList[];
    /* What to tell the server (route C33): this device is ahead of a roster's head, or forked from it. */
    readonly report: 'ahead' | 'fork' | null;
    /* A roster after the one this device posted again at still lacks a list it holds: "An admin needs to look." */
    readonly missing: boolean;
    /* Lists not taken, or dropped from the record, with the rule that refused each. */
    readonly refused: readonly { listVersion: number; listDigest: string; reason: string }[];
    /* People a dropped or passed-over list had added: "Add them again." */
    readonly lost: readonly ListPerson[];
    /* The fork this device is in and has not settled; null otherwise. */
    readonly fork: ForkNote | null;
};

const read = new WeakSet<object>();
function freeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const inner of Object.values(value)) freeze(inner);
        Object.freeze(value);
    }
    return value;
}

/* Only what readAreaLists and settleAreaFork returned, read at this chain's latest roster. */
function requireRead(chain: AcceptedRosters, lists: AreaLists) {
    requireAccepted(chain);
    if (
        !read.has(lists) ||
        lists.groupId !== chain.groupId ||
        lists.rosterVersion !== chain.roster.rosterVersion ||
        lists.rosterDigest !== chain.rosterDigest
    )
        throw new CryptoError('This is not a list this device read at its latest member list.');
}

type Input = {
    chain: AcceptedRosters;
    /* The heads record (readHeads); null, or one not read through the chain's latest roster, reads as behind. */
    heads: HeadsRecord | null;
    workspaceId: string;
    record: AreaListRecord | null;
    /* What the server served of this area's lists, in any order; null when it has not answered. */
    served: readonly SignedAreaList[] | null;
    /* Served ML-DSA public keys, base64url, by their SHA-256, as acceptRosters takes them. */
    mlDsaKeys: Record<string, string>;
};

async function contextOf(input: Input): Promise<Ctx> {
    const { chain } = input;
    const org = companyOf(chain);
    const workspaceId = uuid(input.workspaceId, 'workspace id');
    const kind = own(org.areaKinds, workspaceId);
    if (!kind) throw new CryptoError(NOT_AN_AREA);
    if (chain.retiredAreas.includes(workspaceId)) throw new CryptoError(RETIRED);
    const keyVersion = chain.areaKeys[workspaceId]!.length;
    const listed = org.areaRosters[workspaceId]![keyVersion - 1]!;
    let rows: readonly CommittedHead[] | null = null;
    if (input.heads) {
        const heads = await checkHeadsRecord(chain, org, input.heads);
        if (heads.rosterVersion === chain.roster.rosterVersion)
            rows = own(heads.areas, workspaceId) ?? [];
    }
    return {
        chain,
        org,
        workspaceId,
        kind,
        keyVersion,
        committedAt: listed.rosterVersion,
        committedBy: listed.signerUserId,
        baseDigest: org.areaLists[workspaceId]![keyVersion - 1]!,
        rows,
        mlDsaKeys: input.mlDsaKeys,
    };
}

/* A record as stored, checked against the chain; its steps, the committed list first. */
async function recordSteps(ctx: Ctx, value: AreaListRecord) {
    const bad = () => new CryptoError(BAD_RECORD);
    try {
        if (typeof value !== 'object' || value === null) throw bad();
        const keyVersion = integer(value.workspaceKeyVersion, 'workspace key version');
        const base = integer(value.baseListVersion, 'list version');
        if (
            value.groupId !== ctx.chain.groupId ||
            value.workspaceId !== ctx.workspaceId ||
            keyVersion > ctx.keyVersion ||
            !Array.isArray(value.digests) ||
            !Array.isArray(value.lists) ||
            value.lists.length === 0 ||
            !Array.isArray(value.forks) ||
            typeof value.since !== 'object' ||
            value.since === null ||
            typeof value.committed !== 'object' ||
            value.committed === null
        )
            throw bad();
        const digests = value.digests.map((at) => digestOf(at, 'list digest'));
        // The base it stands on is the one the chain names for that key version.
        if (digests[0] !== ctx.org.areaLists[ctx.workspaceId]![keyVersion - 1]) throw bad();
        const committed = {
            rosterVersion: integer(value.committed.rosterVersion, 'roster version'),
            listVersion: integer(value.committed.listVersion, 'list version'),
        };
        const end = base + digests.length - 1;
        if (
            committed.rosterVersion > ctx.chain.rosterDigests.length ||
            committed.listVersion < base ||
            committed.listVersion + value.lists.length - 1 !== end
        )
            throw bad();
        const steps: Omit<Step, 'since'>[] = [];
        for (const [index, stored] of value.lists.entries()) {
            const at = await parsed(ctx, stored);
            const version = committed.listVersion + index;
            if (
                !at ||
                at.list.listVersion !== version ||
                at.list.workspaceKeyVersion !== keyVersion ||
                at.digest !== digests[version - base] ||
                (index > 0 && at.list.previousListDigest !== steps[index - 1]!.digest)
            )
                throw bad();
            integer(stored.heldAt, 'roster version');
            if (stored.reportedAt !== null) integer(stored.reportedAt, 'roster version');
            steps.push(at);
        }
        const since = new Map<string, number>();
        for (const person of steps[0]!.list.people) {
            const from = own(value.since, person.userId);
            since.set(person.userId, integer(from, 'roster version'));
        }
        if (Object.keys(value.since).length !== since.size) throw bad();
        const forks = value.forks.map((note) => {
            if (typeof note !== 'object' || note === null || note.kind !== 'list') throw bad();
            return {
                kind: 'list' as const,
                committed: {
                    position: integer(note.committed?.position, 'list version'),
                    digest: digestOf(note.committed?.digest, 'list digest'),
                },
                reported: {
                    position: integer(note.reported?.position, 'list version'),
                    digest: digestOf(note.reported?.digest, 'list digest'),
                },
                rosterVersion: integer(note.rosterVersion, 'roster version'),
                settled: note.settled === true,
            };
        });
        return {
            keyVersion,
            base,
            digests,
            committed,
            first: { ...steps[0]!, since },
            later: steps.slice(1),
            stored: value.lists,
            judgedThrough: count(value.judgedThrough, 'roster version'),
            forks,
        };
    } catch (error) {
        if (error instanceof CryptoError) throw bad();
        throw error;
    }
}
type Kept = Awaited<ReturnType<typeof recordSteps>>;

/* The people a list holds beyond another: new, or at a higher role. */
function beyond(list: AreaList, than: AreaList): ListPerson[] {
    const was = new Map(than.people.map((person) => [person.userId, person.role]));
    return list.people.filter((person) => RANK[person.role]! > RANK[was.get(person.userId) ?? '']!);
}

/* The base list among what was served, and every addition that follows it in turn. */
async function fromBase(ctx: Ctx, served: Parsed[], refused: AreaLists['refused'][number][]) {
    const base = served.find((at) => at.digest === ctx.baseDigest);
    if (!base) return null;
    let first: Step;
    try {
        first = await checkBase(ctx, base, true);
    } catch (error) {
        if (!(error instanceof CryptoError)) throw error;
        refused.push({
            listVersion: base.list.listVersion,
            listDigest: base.digest,
            reason: error.message,
        });
        return null;
    }
    const steps = [first];
    await extend(ctx, steps, served, refused);
    return steps;
}

/* Takes, in turn, each served list that follows the last step; stops at the first that is refused. */
async function extend(
    ctx: Ctx,
    steps: Step[],
    served: Parsed[],
    refused: AreaLists['refused'][number][],
) {
    for (;;) {
        const end = steps.at(-1)!;
        const candidates = served.filter(
            (at) =>
                at.list.workspaceKeyVersion === ctx.keyVersion &&
                at.list.listVersion === end.list.listVersion + 1,
        );
        const next = candidates.find((at) => at.list.previousListDigest === end.digest);
        // A served list at the next version that does not follow this record is never taken.
        for (const at of candidates)
            if (at !== next)
                refused.push({
                    listVersion: at.list.listVersion,
                    listDigest: at.digest,
                    reason: NOT_FOLLOWING_LIST,
                });
        if (!next) return;
        try {
            steps.push(await checkAddition(ctx, end, next, true));
        } catch (error) {
            if (!(error instanceof CryptoError)) throw error;
            refused.push({
                listVersion: next.list.listVersion,
                listDigest: next.digest,
                reason: error.message,
            });
            return;
        }
    }
}

const signedOf = (at: { statement: string; signature: string }): SignedAreaList => ({
    statement: at.statement,
    signature: at.signature,
});

/*
 * The heads to judge this area's list by, at this key version: the furthest
 * any roster committed, and after it the latest roster's when that is
 * another. A device goes by the furthest; only where nothing reaches the
 * furthest does it judge by the latest roster, so a later roster whose head
 * its record reaches clears the fork (2.3, "A committed head nothing
 * reaches").
 */
function headsOf(ctx: Ctx) {
    let head: CommittedHead | undefined;
    let latest: CommittedHead | undefined;
    for (const row of ctx.rows ?? []) {
        if (row.workspaceKeyVersion !== ctx.keyVersion) continue;
        if (!head || row.listVersion > head.listVersion) head = row;
        latest = row;
    }
    if (!head || !latest) throw new CryptoError(HEADS_MISMATCH);
    return latest === head ? [head] : [head, latest];
}

/* The first of `heads` that is a step of `steps`, with its place; null when none is. */
function reached(steps: Step[] | null, heads: CommittedHead[]) {
    for (const head of heads) {
        const anchor = (steps ?? []).findIndex(
            (step) => step.list.listVersion === head.listVersion && step.digest === head.listDigest,
        );
        if (anchor >= 0) return { head, anchor };
    }
    return null;
}

function result(
    ctx: Ctx,
    state: HeadState,
    steps: Step[] | null,
    record: AreaListRecord | null,
    more: Partial<Pick<AreaLists, 'report' | 'missing' | 'refused' | 'lost' | 'fork'>> & {
        repost?: readonly SignedAreaList[];
    } = {},
): AreaLists {
    const end = steps?.at(-1);
    const lists: AreaLists = {
        groupId: ctx.chain.groupId,
        workspaceId: ctx.workspaceId,
        areaKind: ctx.kind,
        workspaceKeyVersion: ctx.keyVersion,
        rosterVersion: ctx.chain.roster.rosterVersion,
        rosterDigest: ctx.chain.rosterDigest,
        state,
        listVersion: end?.list.listVersion ?? 0,
        listDigest: end?.digest ?? '',
        everyone: end?.list.everyone ?? '',
        people: (end?.list.people ?? []).map((person) => ({
            ...person,
            since: end!.since.get(person.userId) ?? 0,
        })),
        record,
        repost: more.repost ?? [],
        report: more.report ?? null,
        missing: more.missing ?? false,
        refused: more.refused ?? [],
        lost: more.lost ?? [],
        fork: more.fork ?? null,
    };
    read.add(freeze(lists));
    return lists;
}

const sameNote = (a: ForkNote, b: ForkNote) =>
    a.committed.position === b.committed.position &&
    a.committed.digest === b.committed.digest &&
    a.reported.position === b.reported.position &&
    a.reported.digest === b.reported.digest;

/* The record for a verified run of steps whose committed head is the step at `anchor`. */
function recordOf(
    ctx: Ctx,
    steps: Step[],
    base: number,
    digests: string[],
    anchor: number,
    committedAt: number,
    held: (step: Step) => { heldAt: number; reportedAt: number | null },
    judgedThrough: number,
    forks: ForkNote[],
): AreaListRecord {
    return {
        groupId: ctx.chain.groupId,
        workspaceId: ctx.workspaceId,
        workspaceKeyVersion: ctx.keyVersion,
        baseListVersion: base,
        digests,
        committed: { rosterVersion: committedAt, listVersion: steps[anchor]!.list.listVersion },
        lists: steps.slice(anchor).map((step) => ({ ...signedOf(step), ...held(step) })),
        since: Object.fromEntries(
            [...steps[anchor]!.since.entries()].sort(([x], [y]) => (x < y ? -1 : 1)),
        ),
        judgedThrough,
        forks,
    };
}

/*
 * Reads an area's list against the chain (2.3): the device's own record,
 * judged again by the chain as it is now, extended by what the server
 * served, and set against the furthest head a roster committed.
 *
 * - With no answer from the server (`served` null) and a committed head past
 *   the record, the device is behind, and writes nothing there (HEAD_BEHIND).
 * - Served lists that extend the record are verified and kept; one that does
 *   not follow it is never taken.
 * - A committed head on the record, before its end, leaves the device ahead:
 *   it keeps its record and posts the rest again (`repost`).
 * - A committed head that is not on the record, with nothing served that
 *   extends the record to it, is a fork: the record is kept with a note, and
 *   settleAreaFork takes the committed record once the device has warned and
 *   posted what it holds.
 * - A new folder key replaces the list: the base list the roster row commits
 *   to is verified from what was served, and what the device held past its
 *   last committed head and the rotator had not seen is `lost`.
 */
export async function readAreaLists(input: Input): Promise<AreaLists> {
    const ctx = await contextOf(input);
    const kept = input.record ? await recordSteps(ctx, input.record) : null;
    const refused: AreaLists['refused'][number][] = [];
    const lost: ListPerson[] = [];
    // The record at this key version, judged again by the chain as it is now: an addition whose
    // signer has since lost the standing it was signed with, past the heads that ended it, goes,
    // with every list built on it.
    let steps: Step[] | null = null;
    if (kept && kept.keyVersion === ctx.keyVersion) {
        steps = [kept.first];
        if (ctx.rows)
            for (const [index, at] of kept.later.entries()) {
                try {
                    steps.push(await checkAddition(ctx, steps.at(-1)!, at, false));
                } catch (error) {
                    if (!(error instanceof CryptoError)) throw error;
                    refused.push({
                        listVersion: at.list.listVersion,
                        listDigest: at.digest,
                        reason: error.message,
                    });
                    lost.push(...beyond(kept.later.at(-1)!.list, steps.at(-1)!.list));
                    for (const dropped of kept.later.slice(index + 1))
                        refused.push({
                            listVersion: dropped.list.listVersion,
                            listDigest: dropped.digest,
                            reason: NOT_FOLLOWING_LIST,
                        });
                    break;
                }
            }
        else {
            // Heads not read yet: the record as it stands, unjudged.
            let since = kept.first.since;
            for (const at of kept.later) {
                const next = new Map<string, number>();
                const was = new Map(
                    steps.at(-1)!.list.people.map((person) => [person.userId, person.role]),
                );
                for (const person of at.list.people)
                    next.set(
                        person.userId,
                        was.get(person.userId) === person.role
                            ? (since.get(person.userId) ?? 0)
                            : at.list.rosterVersion,
                    );
                since = next;
                steps.push({ ...at, since });
            }
        }
    }
    // Without the heads read through the latest roster nothing is judged: behind, the record kept.
    if (!ctx.rows) return result(ctx, 'behind', steps, input.record);
    const heads = headsOf(ctx);
    let head = heads[0]!;
    const through = ctx.chain.roster.rosterVersion;
    const served: Parsed[] = [];
    for (const signed of input.served ?? []) {
        const at = await parsed(ctx, signed);
        if (at && at.list.workspaceKeyVersion === ctx.keyVersion) served.push(at);
    }
    const heldOf = (from: Kept | null) => {
        const by = new Map(
            (from?.stored ?? []).map((stored, index) => [
                (index === 0 ? from!.first : from!.later[index - 1]!).digest,
                stored,
            ]),
        );
        return (step: Step) => {
            const stored = by.get(step.digest);
            return stored
                ? { heldAt: stored.heldAt, reportedAt: stored.reportedAt }
                : { heldAt: through, reportedAt: null };
        };
    };
    // (A note not yet settled goes when the latest roster's head is one this record reaches.)
    const settledNotes = (kept?.forks ?? []).filter((note) => note.settled);
    const forked = (reported: Step | null, record: AreaListRecord | null, now: Step[] | null) => {
        // The record kept as it was, with the note; nothing is adopted until the fork is settled.
        const note: ForkNote | null = reported
            ? {
                  kind: 'list',
                  committed: { position: head.listVersion, digest: head.listDigest },
                  reported: { position: reported.list.listVersion, digest: reported.digest },
                  rosterVersion: head.rosterVersion,
                  settled: false,
              }
            : null;
        const noted =
            record && note
                ? {
                      ...record,
                      forks: [...record.forks.filter((at) => !sameNote(at, note)), note],
                  }
                : record;
        return result(ctx, 'forked', now, noted, {
            repost: (noted?.lists ?? []).slice(1).map(signedOf),
            report: note ? 'fork' : null,
            refused,
            lost,
            fork: note,
        });
    };

    // A new folder key (or a first read): the list is the base list the roster row commits to.
    if (!steps) {
        const oldEnd = kept ? (kept.later.at(-1) ?? kept.first) : null;
        if (input.served === null) return result(ctx, 'behind', null, input.record);
        const fresh = await fromBase(ctx, served, refused);
        const at = reached(fresh, heads);
        // Nothing served reaches the committed head: forked, whatever the device held before.
        if (!fresh || !at)
            return forked(oldEnd ? { ...oldEnd, since: new Map() } : null, input.record, null);
        head = at.head;
        const { anchor } = at;
        const base = fresh[0]!.list.listVersion;
        if (kept && base <= kept.committed.listVersion)
            // The new base list stands below a head an earlier roster committed: not on this
            // device's record. Settled like any fork.
            return forked({ ...oldEnd!, since: new Map() }, input.record, null);
        let report: AreaLists['report'] = null;
        if (kept && base <= oldEnd!.list.listVersion) {
            // The rotator had seen less than this device: what it held from the new base's
            // version on is replaced, and whoever those lists added is no longer on the folder.
            const seen = kept.later.find((at) => at.list.listVersion === base - 1) ?? kept.first;
            const newest = fresh.at(-1)!.list;
            const now = new Map(newest.people.map((person) => [person.userId, person.role]));
            for (const person of beyond(oldEnd!.list, seen.list))
                if (
                    RANK[now.get(person.userId) ?? '']! < RANK[person.role]! &&
                    RANK[newest.everyone]! < RANK[person.role]!
                )
                    lost.push(person);
            for (const at of kept.later)
                if (at.list.listVersion >= base)
                    refused.push({
                        listVersion: at.list.listVersion,
                        listDigest: at.digest,
                        reason: LIST_STALE,
                    });
            report = 'ahead';
        }
        const record = recordOf(
            ctx,
            fresh,
            base,
            fresh.map((step) => step.digest),
            anchor,
            head.rosterVersion,
            () => ({ heldAt: through, reportedAt: null }),
            through,
            settledNotes,
        );
        return result(ctx, anchor === fresh.length - 1 ? 'level' : 'ahead', fresh, record, {
            repost: fresh.slice(anchor + 1).map(signedOf),
            report,
            refused,
            lost,
        });
    }

    // The same folder key: extend the record by what was served, then judge the committed head.
    const base = kept!.base;
    const first = steps[0]!.list.listVersion;
    let digests = kept!.digests.slice(0, first - base + steps.length);
    // A served list at a version this device holds, with another digest, is never taken.
    for (const at of served) {
        const index = at.list.listVersion - base;
        if (index >= 0 && index < digests.length && digests[index] !== at.digest)
            refused.push({
                listVersion: at.list.listVersion,
                listDigest: at.digest,
                reason: NOT_FOLLOWING_LIST,
            });
    }
    const before = steps.length;
    await extend(ctx, steps, served, refused);
    digests = [...digests, ...steps.slice(before).map((step) => step.digest)];
    const judge = (at: CommittedHead) =>
        headState(
            { first: base, digests },
            { position: at.listVersion, digest: at.listDigest },
            input.served === null ? null : false,
        );
    let state = judge(head);
    // Nothing reaches the furthest head: the latest roster's, where the record reaches that.
    if (state === 'forked' && heads[1] && ['level', 'ahead'].includes(judge(heads[1]))) {
        head = heads[1];
        state = judge(head);
    }
    const held = heldOf(kept);
    const keep = (anchor: number, committedAt: number, forks: ForkNote[], judged: number) =>
        recordOf(ctx, steps, base, digests, anchor, committedAt, held, judged, forks);
    if (state === 'behind')
        return result(
            ctx,
            'behind',
            steps,
            keep(0, kept!.committed.rosterVersion, kept!.forks, kept!.judgedThrough),
            { refused, lost },
        );
    if (state === 'forked')
        return forked(
            steps.at(-1)!,
            keep(0, kept!.committed.rosterVersion, kept!.forks, kept!.judgedThrough),
            steps,
        );
    // The committed head is on the record: it becomes the head this device keeps, if further.
    const anchor = Math.max(0, head.listVersion - first);
    const committedAt = anchor > 0 ? head.rosterVersion : kept!.committed.rosterVersion;
    // A later roster whose row fell back: on the record it moves nothing and is reported; off it,
    // two rosters committed to different records, which is a fork.
    const notes = [...settledNotes];
    let report: AreaLists['report'] = null;
    for (const row of ctx.rows)
        if (
            row.workspaceKeyVersion === ctx.keyVersion &&
            row.rosterVersion > Math.max(kept!.judgedThrough, head.rosterVersion) &&
            row.listVersion <= head.listVersion &&
            !(row.listVersion === head.listVersion && row.listDigest === head.listDigest)
        ) {
            const index = row.listVersion - base;
            if (index >= 0 && digests[index] === row.listDigest) report ??= 'ahead';
            else {
                const note: ForkNote = {
                    kind: 'list',
                    committed: { position: row.listVersion, digest: row.listDigest },
                    reported: { position: steps.at(-1)!.list.listVersion, digest: digests.at(-1)! },
                    rosterVersion: row.rosterVersion,
                    // Nothing to adopt: this device is on the furthest committed record already.
                    settled: true,
                };
                if (!notes.some((at) => sameNote(at, note))) notes.push(note);
                report = 'fork';
            }
        }
    // What it holds past the committed head: posted again at the first roster that lacks it, and
    // missing when a roster after that one still does.
    let missing = false;
    const marked = (step: Step) => {
        const at = held(step);
        if (step.list.listVersion <= head.listVersion) return at;
        if (at.reportedAt === null && through > at.heldAt) {
            report ??= 'ahead';
            return { ...at, reportedAt: through };
        }
        if (at.reportedAt !== null && through > at.reportedAt) missing = true;
        return at;
    };
    const record = recordOf(ctx, steps, base, digests, anchor, committedAt, marked, through, notes);
    return result(ctx, state, steps, record, {
        repost: steps.slice(anchor + 1).map(signedOf),
        report,
        missing,
        refused,
        lost,
    });
}

/*
 * Settles a fork (2.3, "Settling a fork"), once the device has warned and
 * posted what it holds: the committed record becomes its base for chaining.
 * The lists are verified from the base list the chain commits to, along what
 * the server served, to the committed head; a list this device held that
 * still follows that record is kept, and one built on a list that is gone is
 * refused (LIST_STALE), its people `lost` ("add the person again"). The note
 * stays, settled, until its person clears it. Refused (HEAD_FORKED) when the
 * record has no fork to settle, or nothing served reaches the committed head.
 */
export async function settleAreaFork(input: Input): Promise<AreaLists> {
    const ctx = await contextOf(input);
    const kept = input.record ? await recordSteps(ctx, input.record) : null;
    if (!kept || !ctx.rows || !kept.forks.some((note) => !note.settled) || input.served === null)
        throw new CryptoError(HEAD_FORKED);
    const refused: AreaLists['refused'][number][] = [];
    const served: Parsed[] = [];
    for (const signed of input.served) {
        const at = await parsed(ctx, signed);
        if (at && at.list.workspaceKeyVersion === ctx.keyVersion) served.push(at);
    }
    const steps = await fromBase(ctx, served, refused);
    const at = reached(steps, headsOf(ctx));
    if (!steps || !at) throw new CryptoError(HEAD_FORKED);
    const { head, anchor } = at;
    const through = ctx.chain.roster.rosterVersion;
    // What this device held and the committed record lacks: kept where it still follows.
    const committed = new Set(steps.map((step) => step.digest));
    const lost: ListPerson[] = [];
    const mine = new Set<string>();
    for (const held of kept.later) {
        if (committed.has(held.digest)) continue;
        const end = steps.at(-1)!;
        try {
            if (kept.keyVersion !== ctx.keyVersion) throw new CryptoError(LIST_STALE);
            if (held.list.previousListDigest !== end.digest) throw new CryptoError(LIST_STALE);
            steps.push(await checkAddition(ctx, end, held, false));
            mine.add(held.digest);
        } catch (error) {
            if (!(error instanceof CryptoError)) throw error;
            refused.push({
                listVersion: held.list.listVersion,
                listDigest: held.digest,
                reason: error.message === NOT_FOLLOWING_LIST ? LIST_STALE : error.message,
            });
        }
    }
    const newest = steps.at(-1)!.list;
    const now = new Map(newest.people.map((person) => [person.userId, person.role]));
    const oldEnd = kept.later.at(-1) ?? kept.first;
    // Whoever the lists this device held past its committed head had added, and is not there now.
    for (const person of beyond(oldEnd.list, kept.first.list))
        if (
            RANK[now.get(person.userId) ?? '']! < RANK[person.role]! &&
            RANK[newest.everyone]! < RANK[person.role]!
        )
            lost.push(person);
    const stored = new Map(
        kept.stored.map((at, index) => [
            (index === 0 ? kept.first : kept.later[index - 1]!).digest,
            at,
        ]),
    );
    const record = recordOf(
        ctx,
        steps,
        steps[0]!.list.listVersion,
        steps.map((step) => step.digest),
        anchor,
        head.rosterVersion,
        (step) => {
            const was = mine.has(step.digest) ? stored.get(step.digest) : undefined;
            return was
                ? { heldAt: was.heldAt, reportedAt: was.reportedAt }
                : { heldAt: through, reportedAt: null };
        },
        through,
        kept.forks.map((note) => ({ ...note, settled: true })),
    );
    return result(ctx, anchor === steps.length - 1 ? 'level' : 'ahead', steps, record, {
        repost: steps.slice(anchor + 1).map(signedOf),
        refused,
        lost,
    });
}

/* The person clears their own note, on their own device, after reading it (2.3). Nobody else can. */
export function clearForkNote(record: AreaListRecord, note: ForkNote): AreaListRecord {
    return { ...record, forks: record.forks.filter((at) => !(at.settled && sameNote(at, note))) };
}

/* Refuses a write in an area whose list is behind or forked (2.3): HEAD_BEHIND, HEAD_FORKED. */
export function requireAreaWritable(chain: AcceptedRosters, lists: AreaLists) {
    requireRead(chain, lists);
    if (lists.state === 'behind') throw new CryptoError(HEAD_BEHIND);
    if (lists.state === 'forked') throw new CryptoError(HEAD_FORKED);
}

/* Signing lists (2.3, 3.4) -------------------------------------------------- */

function sortedPeople(people: readonly ListPerson[]) {
    return [...people]
        .map((person) => ({ userId: person.userId, role: person.role }))
        .sort((x, y) => (x.userId < y.userId ? -1 : x.userId > y.userId ? 1 : 0));
}

function newNonce() {
    return encode(crypto.getRandomValues(new Uint8Array(LIST_NONCE_BYTES)));
}

/*
 * Signs the base list of an area's next key version (2.3), before the roster
 * whose row commits it: by the member who will sign that roster, naming
 * their latest accepted roster (the one before it), with a fresh nonce.
 * `chain` is null only for the areas of roster 1, before the company exists.
 * Everyone named must be active on the roster that will commit it
 * (`members`, the chain's latest by default), and an employee area's list is
 * its assignee alone, as manager. The digest goes on the roster row
 * (AreaKey.listDigest).
 */
export async function signBaseAreaList(input: {
    chain: AcceptedRosters | null;
    groupId: string;
    workspaceId: string;
    workspaceKeyVersion: number;
    listVersion: number;
    areaKind: AreaKind;
    everyone: EveryoneRole;
    people: readonly ListPerson[];
    signerUserId: string;
    signerKeyVersion: number;
    signer: HybridSigningKey;
    /* The entries of the roster that will commit it, when it changes who is active. */
    members?: readonly RosterMember[];
    nonce?: string;
}): Promise<SignedAreaList & { digest: string }> {
    const { chain } = input;
    const people = sortedPeople(input.people);
    if (
        input.areaKind === 'employee' &&
        (input.everyone !== '' || people.length !== 1 || people[0]!.role !== 'manager')
    )
        throw new CryptoError(EMPLOYEE_LIST);
    const members = input.members ?? chain?.roster.members;
    if (!members) throw new CryptoError(NOT_ACTIVE);
    for (const person of people)
        if (!activeWith(members.find((entry) => entry.userId === person.userId)))
            throw new CryptoError(NOT_ACTIVE);
    if (chain) {
        companyOf(chain, input.groupId);
        const entry = rosterEntry(chain.roster, input.signerUserId);
        if (!activeWith(entry, 'members') || entry!.keyVersion !== input.signerKeyVersion)
            throw new CryptoError(NOT_ENTITLED);
        await sealerHolds(chain, input.signerUserId, input.signer);
        const listed = own(chain.areaKeys, input.workspaceId)?.length ?? 0;
        if (input.workspaceKeyVersion !== listed + 1) throw new CryptoError(NOT_THE_BASE);
    } else if (input.workspaceKeyVersion !== 1) throw new CryptoError(NOT_THE_BASE);
    if (input.workspaceKeyVersion === 1 && input.listVersion !== 1)
        throw new CryptoError(NOT_THE_BASE);
    const statement = areaListStatement({
        groupId: input.groupId,
        workspaceId: input.workspaceId,
        listVersion: input.listVersion,
        previousListDigest: '',
        workspaceKeyVersion: input.workspaceKeyVersion,
        signerUserId: input.signerUserId,
        signerKeyVersion: input.signerKeyVersion,
        rosterVersion: chain ? chain.roster.rosterVersion : 0,
        rosterDigest: chain ? chain.rosterDigest : '',
        nonce: input.nonce ?? newNonce(),
        everyone: input.everyone,
        people,
    });
    return {
        statement: encode(statement),
        signature: encode(await signHybrid(statement, input.signer)),
        digest: await digest(statement),
    };
}

/*
 * Signs an addition (2.3, 3.4): the list after the latest one this device
 * verified, with `add` put in (new people, or a higher role for someone on
 * it) and `everyone` raised when given. Signed only at the signer's latest
 * accepted roster, with the keys their entry names there, on a list that is
 * level or ahead (HEAD_BEHIND, HEAD_FORKED otherwise), and only when it
 * would verify: what verification refuses is never signed.
 */
export async function signAreaListAddition(input: {
    chain: AcceptedRosters;
    heads: HeadsRecord;
    lists: AreaLists;
    add: readonly ListPerson[];
    everyone?: EveryoneRole;
    signerUserId: string;
    signer: HybridSigningKey;
    nonce?: string;
}): Promise<SignedAreaList & { digest: string }> {
    const { chain, lists } = input;
    requireAreaWritable(chain, lists);
    if (!lists.record || lists.listVersion === 0) throw new CryptoError(HEAD_BEHIND);
    const ctx = await contextOf({
        chain,
        heads: input.heads,
        workspaceId: lists.workspaceId,
        record: null,
        served: null,
        mlDsaKeys: {},
    });
    const entry = rosterEntry(chain.roster, input.signerUserId);
    if (!activeWith(entry)) throw new CryptoError(NOT_ENTITLED);
    await sealerHolds(chain, input.signerUserId, input.signer);
    const people = new Map(lists.people.map((person) => [person.userId, person.role]));
    for (const person of input.add) {
        if (RANK[person.role]! < RANK[people.get(person.userId) ?? '']!)
            throw new CryptoError(NARROWS);
        people.set(person.userId, person.role);
    }
    const everyone = input.everyone ?? lists.everyone;
    const kept = await recordSteps(ctx, lists.record);
    const end = kept.later.at(-1) ?? kept.first;
    const list: AreaList = {
        groupId: lists.groupId,
        workspaceId: lists.workspaceId,
        listVersion: lists.listVersion + 1,
        previousListDigest: lists.listDigest,
        workspaceKeyVersion: lists.workspaceKeyVersion,
        signerUserId: input.signerUserId,
        signerKeyVersion: entry!.keyVersion,
        rosterVersion: chain.roster.rosterVersion,
        rosterDigest: chain.rosterDigest,
        nonce: input.nonce ?? newNonce(),
        everyone,
        people: sortedPeople([...people].map(([userId, role]) => ({ userId, role }))),
    };
    const statement = areaListStatement(list);
    const at = {
        list,
        statement: encode(statement),
        signature: '',
        digest: await digest(statement),
    };
    // Acceptance's own rules, signature aside, on the list as this device verified it.
    await checkAddition(
        ctx,
        { ...end, since: new Map(lists.people.map((person) => [person.userId, person.since])) },
        at,
        false,
    );
    return {
        statement: at.statement,
        signature: encode(await signHybrid(statement, input.signer)),
        digest: at.digest,
    };
}

/* The signed dismissal (2.3, "The note, and who clears it") ------------------- */

export type ForkKind = 'list' | 'share-log';
export const FORK_KINDS: readonly ForkKind[] = ['list', 'share-log'];

/* An Admin's dismissal of a fork, for the Admins: it names both records. */
export type ForkDismissal = {
    groupId: string;
    workspaceId: string;
    kind: ForkKind;
    /* The head the roster committed, and the head the device reported: a list version, or a log index. */
    committedPosition: number;
    committedDigest: string;
    reportedPosition: number;
    reportedDigest: string;
    signerUserId: string;
    signerKeyVersion: number;
    rosterVersion: number;
    rosterDigest: string;
};

const FORK_DISMISSAL_DOMAIN = 'hushos/group/fork-dismissal';
export const NOT_AN_ADMIN = 'Only an admin dismisses a fork for the admins.';

/* ["hushos/group/fork-dismissal",1,groupId,workspaceId,kind,committedPosition,committedDigest,reportedPosition,reportedDigest,signerUserId,signerKeyVersion,rosterVersion,rosterDigest] */
export function forkDismissalStatement(dismissal: ForkDismissal) {
    const kind = oneOf(dismissal.kind, FORK_KINDS, 'fork kind');
    // A list's position is its version, from 1; a share log's is its length, from 0.
    const position = kind === 'list' ? integer : count;
    return encodeStatement([
        FORK_DISMISSAL_DOMAIN,
        1,
        uuid(dismissal.groupId, 'group id'),
        uuid(dismissal.workspaceId, 'workspace id'),
        kind,
        position(dismissal.committedPosition, 'fork position'),
        digestOf(dismissal.committedDigest, 'fork digest'),
        position(dismissal.reportedPosition, 'fork position'),
        digestOf(dismissal.reportedDigest, 'fork digest'),
        uuid(dismissal.signerUserId, 'user id'),
        integer(dismissal.signerKeyVersion, 'key version'),
        integer(dismissal.rosterVersion, 'roster version'),
        digestOf(dismissal.rosterDigest, 'roster digest'),
    ]);
}

/* The dismissal a statement's bytes hold, refused unless the bytes are its canonical encoding. */
export function parseForkDismissal(statement: Uint8Array): ForkDismissal {
    const parts = parseStatement(statement, 'fork dismissal');
    if (parts.length !== 13 || parts[0] !== FORK_DISMISSAL_DOMAIN || parts[1] !== 1)
        throw new CryptoError('Invalid fork dismissal.');
    const dismissal = {
        groupId: parts[2],
        workspaceId: parts[3],
        kind: parts[4],
        committedPosition: parts[5],
        committedDigest: parts[6],
        reportedPosition: parts[7],
        reportedDigest: parts[8],
        signerUserId: parts[9],
        signerKeyVersion: parts[10],
        rosterVersion: parts[11],
        rosterDigest: parts[12],
    } as ForkDismissal;
    requireCanonical(statement, forkDismissalStatement(dismissal), 'fork dismissal');
    return dismissal;
}

/* Whether the dismissal names an area of this company and a signer who is an Admin now, at the keys named. */
function dismissalHolds(chain: AcceptedRosters, org: OrgChain, dismissal: ForkDismissal) {
    const entry = rosterEntry(chain.roster, dismissal.signerUserId);
    return (
        own(org.areaKinds, dismissal.workspaceId) !== undefined &&
        activeWith(entry, 'members') &&
        membersSpanAt(org, dismissal.signerUserId, dismissal.rosterVersion) !== undefined &&
        keysAt(org, dismissal.signerUserId, dismissal.rosterVersion)?.keyVersion ===
            dismissal.signerKeyVersion
    );
}

/*
 * Signs a dismissal with the Admin's hybrid identity signature: only for an
 * active `members` holder, at the keys their entry names, naming their
 * latest accepted roster.
 */
export async function signForkDismissal(
    dismissal: ForkDismissal,
    options: { chain: AcceptedRosters; signer: HybridSigningKey },
) {
    const statement = forkDismissalStatement(dismissal);
    const org = companyOf(options.chain, dismissal.groupId);
    sealedAtLatest(options.chain, dismissal);
    if (!dismissalHolds(options.chain, org, dismissal)) throw new CryptoError(NOT_AN_ADMIN);
    await sealerHolds(options.chain, dismissal.signerUserId, options.signer);
    return { statement, signature: await signHybrid(statement, options.signer) };
}

/*
 * A dismissal as the server and the area's people take it: the bytes
 * canonical, for this company and one of its areas, naming a roster on the
 * chain, from someone who held `members` on that roster and still does on
 * the latest (a signature carries no time: a removed Admin's dismissal, with
 * any roster named, hides nothing), and signed under the keys their entry
 * named at the roster named. Anything else is refused.
 */
export async function verifyForkDismissal(
    statement: Uint8Array,
    signature: Uint8Array,
    options: { chain: AcceptedRosters; signerMlDsaPublicKey: Uint8Array },
): Promise<ForkDismissal> {
    const dismissal = parseForkDismissal(statement);
    const { chain } = options;
    const org = companyOf(chain, dismissal.groupId);
    if (chain.rosterDigests[dismissal.rosterVersion - 1] !== dismissal.rosterDigest)
        throw new CryptoError(NOT_ON_CHAIN);
    if (!dismissalHolds(chain, org, dismissal)) throw new CryptoError(NOT_AN_ADMIN);
    const named = keysAt(org, dismissal.signerUserId, dismissal.rosterVersion)!;
    const key = options.signerMlDsaPublicKey;
    if (
        signature.length !== HYBRID_SIGNATURE_BYTES ||
        key.length !== ML_DSA_PUBLIC_KEY_BYTES ||
        (await digest(key)) !== named.mlDsaPublicKeyDigest ||
        !(await verifyHybrid(statement, signature, {
            signingPublicKey: decode(named.signingPublicKey, 32),
            mlDsaPublicKey: key,
        }))
    )
        throw new CryptoError('This dismissal is not signed by the admin it names.');
    return dismissal;
}

/*
 * Whether a verified dismissal is of this very fork: the same area and kind,
 * and both digests, with their positions. A device hides the Admins' note
 * only then. It clears no override (2.4): only the committed record does.
 */
export function dismisses(dismissal: ForkDismissal, workspaceId: string, note: ForkNote) {
    return (
        dismissal.workspaceId === workspaceId &&
        dismissal.kind === note.kind &&
        dismissal.committedPosition === note.committed.position &&
        dismissal.committedDigest === note.committed.digest &&
        dismissal.reportedPosition === note.reported.position &&
        dismissal.reportedDigest === note.reported.digest
    );
}

/* The resolver (2.3, "Who is entitled") --------------------------------------- */

/*
 * On what basis someone reaches a company folder, and as what:
 * - list: active on the roster, not suspended, and on the folder's latest
 *   list by an entry that counts for them, or covered by `everyone`;
 * - share: named in a live share whose record verifies, on that node's
 *   subtree (the record is the share log's, PR 3: the caller says so);
 * - browse: an active data admin in a browse session: everything except
 *   making shares and links;
 * - key-change: an active data admin in a key-change session, for an area
 *   that is owed one: the rotation work and nothing else.
 * Null for everyone else: membership of the company alone grants nothing.
 */
export type AreaAccess =
    | { basis: 'list'; role: ListRole }
    | { basis: 'share'; role: 'editor' | 'viewer' }
    | { basis: 'browse' }
    | { basis: 'key-change' }
    | null;

/* The role a list gives someone active on the latest roster: their own entry, where it counts, or `everyone`. */
function listRole(chain: AcceptedRosters, org: OrgChain, lists: AreaLists, userId: string) {
    if (!activeWith(rosterEntry(chain.roster, userId))) return null;
    // An entry counts only from the roster that last let its person in (2.3, "After someone comes back").
    const admitted = own(org.active, userId)?.at(-1)?.from ?? Infinity;
    const entry = lists.people.find((person) => person.userId === userId);
    const named = entry && entry.since >= admitted ? entry.role : '';
    const role = RANK[named]! >= RANK[lists.everyone]! ? named : lists.everyone;
    return role === '' ? null : (role as ListRole);
}

/*
 * Whether an area is owed a key change (3.6, "While a key change is owed"),
 * from the device's own chain and list, never the server's word: the roster
 * row of its current key is older than the roster that marked `left` anyone
 * its list names (anyone at all where `everyone` is set), or than the roster
 * that last replaced the company key.
 */
export function areaOwed(chain: AcceptedRosters, lists: AreaLists) {
    requireRead(chain, lists);
    const org = companyOf(chain);
    const listed = org.areaRosters[lists.workspaceId]!.at(-1)!.rosterVersion;
    if (org.custodyKeys.length > 1 && org.custodyKeys.at(-1)!.rosterVersion > listed) return true;
    const leftSince = (userId: string) =>
        (own(org.active, userId) ?? []).some((span) => span.until !== null && span.until > listed);
    return lists.everyone !== ''
        ? Object.keys(org.active).some(leftSince)
        : lists.people.some((person) => leftSince(person.userId));
}

/*
 * The one resolver (2.3): what `userId` may do in the area `lists` is of, on
 * the device's own chain and the list it verified. `suspended` is the
 * server's word (a pause changes no key and is on no roster): a paused
 * member reaches nothing. `session` is the data admin's live session the
 * request is made in, if any (it then decides, and a session of someone who
 * is no data admin, or a key-change session for an area that is owed none,
 * is no basis at all); `share` the role of a live share whose record
 * verifies and that covers the node asked for, if any (the share log is PR
 * 3's).
 */
export function areaAccess(input: {
    chain: AcceptedRosters;
    lists: AreaLists;
    userId: string;
    suspended?: boolean;
    session?: 'browse' | 'key-change' | null;
    share?: 'editor' | 'viewer' | null;
}): AreaAccess {
    const { chain, lists } = input;
    requireRead(chain, lists);
    const org = companyOf(chain);
    if (input.suspended) return null;
    // A request made in a data admin's session is that session's, whatever else they are here.
    if (activeWith(rosterEntry(chain.roster, input.userId), 'data_admin')) {
        if (input.session === 'browse') return { basis: 'browse' };
        if (input.session === 'key-change' && areaOwed(chain, lists))
            return { basis: 'key-change' };
    }
    const role = listRole(chain, org, lists, input.userId);
    if (role) return { basis: 'list', role };
    if (input.share) return { basis: 'share', role: input.share };
    return null;
}

export type AreaAction = 'read' | 'download' | 'write' | 'share' | 'manage' | 'rotate';

/*
 * What a basis allows (2.3's table): a viewer reads and downloads; an editor
 * also writes and shares; a manager also signs additions; a share grantee
 * reads, downloads and, as editor, writes, and does not share on; a browsing
 * data admin does everything but make shares and links; a key-change session
 * does the rotation work and nothing else, no download URL.
 */
export function areaAllows(access: AreaAccess, action: AreaAction): boolean {
    if (!access) return false;
    switch (access.basis) {
        case 'list':
            if (action === 'read' || action === 'download') return true;
            if (action === 'write' || action === 'share') return access.role !== 'viewer';
            return action === 'manage' && access.role === 'manager';
        case 'share':
            if (action === 'read' || action === 'download') return true;
            return action === 'write' && access.role === 'editor';
        case 'browse':
            return action !== 'share' && action !== 'rotate';
        case 'key-change':
            return action === 'rotate';
    }
}

/*
 * Who is owed an area's current key (2.3, "Grants"): everyone its list
 * entitles who is active and not suspended, the uploader included, sorted.
 * A roster call that creates or rotates an area owes them the new key's
 * grant; an admission owes the newcomer the grants of the folders this names
 * them for (those whose list has `everyone` set, and their own).
 */
export function areaGrantsOwed(input: {
    chain: AcceptedRosters;
    lists: AreaLists;
    /* The members the server has paused: granted nothing while paused. */
    suspended?: readonly string[];
}): string[] {
    const { chain, lists } = input;
    requireRead(chain, lists);
    const org = companyOf(chain);
    const paused = new Set(input.suspended ?? []);
    return chain.roster.members
        .filter((entry) => !paused.has(entry.userId) && listRole(chain, org, lists, entry.userId))
        .map((entry) => entry.userId)
        .sort();
}

/*
 * Whether `userId` is entitled to an area's key by the list this device
 * verified (2.3, "Grants"): what a grantee's device asks before it opens a
 * company area's grant, beside the rules every grant keeps (openAreaGrant).
 * The list must be of that key version or a later one.
 */
export function grantAllowed(
    chain: AcceptedRosters,
    lists: AreaLists,
    userId: string,
    workspaceId: string,
    workspaceKeyVersion: number,
) {
    requireRead(chain, lists);
    return (
        lists.workspaceId === workspaceId &&
        lists.listVersion > 0 &&
        workspaceKeyVersion <= lists.workspaceKeyVersion &&
        listRole(chain, companyOf(chain), lists, userId) !== null
    );
}

/* Who writes (2.3) ------------------------------------------------------------ */

/*
 * A writer's standing on a company folder, for a writer active on the
 * roster whose signature holds (2.3, "Who writes"), in order:
 * - unchecked: the reader's list did not load or verify, or is behind or
 *   forked from a head a roster committed;
 * - listed: an editor or manager on the list, or covered by `everyone` as
 *   editor;
 * - data-admin: an active data admin not on the list;
 * - share: a colleague who edits that subtree by a share record that
 *   verifies (`sharedEditors`, the share log's, PR 3);
 * - not-on-this-folder: none of those: a viewer, someone on an earlier list,
 *   a former data admin, or an editor whose addition this device was not
 *   served.
 */
export type FolderStanding = 'unchecked' | 'listed' | 'data-admin' | 'share' | 'not-on-this-folder';

export function folderStanding(input: {
    chain: AcceptedRosters;
    lists: AreaLists | null;
    workspaceId: string;
    writerUserId: string;
    sharedEditors?: readonly string[];
}): FolderStanding {
    const { chain, lists } = input;
    try {
        if (!lists) return 'unchecked';
        requireRead(chain, lists);
        const org = companyOf(chain);
        if (
            lists.workspaceId !== input.workspaceId ||
            lists.listVersion === 0 ||
            lists.state === 'behind' ||
            lists.state === 'forked'
        )
            return 'unchecked';
        const role = listRole(chain, org, lists, input.writerUserId);
        if (role === 'editor' || role === 'manager') return 'listed';
        if (activeWith(rosterEntry(chain.roster, input.writerUserId), 'data_admin'))
            return 'data-admin';
        if (input.sharedEditors?.includes(input.writerUserId)) return 'share';
        return 'not-on-this-folder';
    } catch (error) {
        if (error instanceof CryptoError) return 'unchecked';
        throw error;
    }
}
