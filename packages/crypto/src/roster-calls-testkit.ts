import { createAreaLedger } from './area-ledger';
import { areaKeyCommitment, areaRootCommitment } from './area-keys';
import { ROOT } from './device-record-testkit';
import {
    CHECKED,
    groupKeyAt,
    history,
    mlDsaKeysOf,
    pattern,
    person,
    type History,
    type Person,
} from './group-testkit';
import {
    acceptRosters,
    checkNextRoster,
    joinCode,
    nextRoster,
    pinAfter,
    type AcceptedRosters,
} from './group-trust';
import {
    groupKeyPair,
    parseRoster,
    signRoster,
    openAreaGrant,
    openGroupKey,
    rosterDigest,
    sameGroupKey,
    sealAreaGrant,
    sealGroupKey,
    type GroupPublicKey,
    type GroupRole,
    type RosterArea,
    type SignedGroupStatement,
} from './groups';
import { deriveId } from './ids';
import { decode, encode } from './keys';
import { outboxStep, readOutboxEntry } from './outbox';
import type { ContactPin } from './contacts';
import { fingerprintOfKeys, keyDigest } from './fingerprint';
import {
    createGroupSession,
    openDeviceRecord,
    sealDeviceRecord,
    type GrantWire,
    type GroupHost,
    type GroupMessage,
    type GroupResults,
    type RosterCallBody,
    type ServedChain,
    type SignedStatementWire,
} from './session-groups';

/*
 * Roster calls (groups 1d, Core 5a), for the shared fixtures: the twin of
 * crates/hushos-core/tests/common/roster_calls.rs. Both twins build the same
 * family from the same people (group-testkit.ts's persons 1 to 5) and keys,
 * the same calls in the same order through their own code (here the worker's
 * groupStage and groupGrants, there the core's AreaLedger builders), write the
 * history they signed, the bodies and the outbox entries their own code
 * sealed, and read the other twin's document through their own code:
 *
 * - `calls`: each body verified as every member and the server take it, to
 *   the declared verdict; a refusal must be the same sentence;
 * - `grantCalls`: owed grants, each opened by its grantee to the folder's key;
 * - `joinCodes`: the admin's join code (the worker's groupJoinCode), the
 *   contact pin as filed in the settings the worker opened;
 * - `outboxEntries`: entries sealed under person 1's device store, read by
 *   readOutboxEntry (the core's outbox_open) against a committed head.
 *
 * The family is replayable on the server's routes (packages/groups/src/server.test.ts
 * stores it and posts every body): rosters 1 to 7 create A1, admit 2, admit 3
 * with members, create A2, delete A2, create A3, rotate A3 to key version 2.
 * scripts/roster-call-fixtures.ts writes this twin's document;
 * roster-call-fixtures.test.ts reads the core's.
 */

type Json = Record<string, any>;

export type Family = {
    p: Person[];
    groupId: string;
    groupIdSeed: string;
    /* A1, A2 (deleted) and A3. */
    areas: { workspaceId: string; idSeed: string }[];
    h: History;
};

/* The key the family gives an area at a version (index 0 to 2: A1, A2, A3), as the core's area_key. */
export const areaKey = (index: number, version: number) =>
    pattern(32, 120 + index * 2 + version - 1);
const rootKey = (index: number, version: number) => pattern(32, 140 + index * 2 + version - 1);
export const OTHER_FAMILY = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
export const OTHER_ID = 'f0f0f0f0-0000-4000-8000-000000000001';

async function row(
    f: { areas: Family['areas'] },
    index: number,
    version: number,
): Promise<RosterArea> {
    return {
        workspaceId: f.areas[index]!.workspaceId,
        workspaceKeyVersion: version,
        commitment: await areaKeyCommitment(areaKey(index, version)),
        rootCommitment: await areaRootCommitment(rootKey(index, version)),
    };
}

let built: Promise<Family> | undefined;
export function family() {
    built ??= (async () => {
        const p = await Promise.all([1, 2, 3, 4, 5].map((n) => person(n)));
        const groupIdSeed = encode(pattern(16, 40));
        const groupId = await deriveId('group', p[0]!.userId, groupIdSeed);
        const areas = await Promise.all(
            [0, 1, 2].map(async (i) => {
                const idSeed = encode(pattern(16, 41 + i));
                return { workspaceId: await deriveId('workspace', groupId, idSeed), idSeed };
            }),
        );
        const h = await history('family', { groupId, format: 2 });
        const owner = p[0]!.entry(['billing', 'members']);
        const p2 = p[1]!.entry([]);
        const p3 = p[2]!.entry(['members']);
        const all = [owner, p2, p3];
        const f = { areas };
        await h.roster(p[0]!, [owner], 1, [await row(f, 0, 1)]);
        await h.roster(p[0]!, [owner, p2], 1, []);
        await h.roster(p[0]!, all, 1, []);
        await h.roster(p[0]!, all, 1, [await row(f, 1, 1)]);
        await h.roster(p[0]!, all, 1, [
            {
                workspaceId: areas[1]!.workspaceId,
                workspaceKeyVersion: 2,
                commitment: '',
                retired: true,
            },
        ]);
        await h.roster(p[0]!, all, 1, [await row(f, 2, 1)]);
        await h.roster(p[0]!, all, 1, [await row(f, 2, 2)]);
        return { p, groupId, groupIdSeed, areas, h };
    })();
    return built;
}

export function wire(signed: SignedGroupStatement): SignedStatementWire {
    return {
        statement: encode(signed.statement),
        signature: {
            ed25519: encode(signed.signature.ed25519),
            mlDsa: encode(signed.signature.mlDsa),
        },
        signerSignature: encode(signed.signerSignature),
    };
}
export function unwire(value: SignedStatementWire): SignedGroupStatement {
    return {
        statement: decode(value.statement),
        signature: {
            ed25519: decode(value.signature.ed25519),
            mlDsa: decode(value.signature.mlDsa),
        },
        signerSignature: decode(value.signerSignature),
    };
}

async function mlDsaKeys() {
    return mlDsaKeysOf(...(await family()).p);
}

/* A history's chain, accepted from version 1 by a reader outside the family. */
export async function chainOf(
    firstKeys: GroupPublicKey,
    groupId: string,
    rosters: SignedGroupStatement[],
    successions: SignedGroupStatement[],
): Promise<AcceptedRosters> {
    const accepted = await acceptRosters({
        groupId,
        firstKeys,
        firstKeysChecked: true,
        pins: [],
        rosters,
        successions,
        mlDsaKeys: await mlDsaKeys(),
        me: { userId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', identities: [] },
        cache: null,
    });
    if (accepted.status !== 'accepted') throw new Error('expected an accepted chain');
    return accepted;
}

/* Person `n`'s version 3 contact pin, as comparing their words writes it. */
export async function pin(n: number): Promise<ContactPin> {
    const p = (await family()).p[n - 1]!;
    return {
        userId: p.userId,
        email: `person${n}@hushos.test`,
        name: `Person ${n}`,
        encryptionPublicKey: p.served.encryptionPublicKey,
        signingPublicKey: p.served.signingPublicKey,
        fingerprint: await fingerprintOfKeys(
            decode(p.served.encryptionPublicKey),
            decode(p.served.signingPublicKey),
            p.mlDsaPublicKey,
            p.kemPublicKey,
        ),
        pinnedAt: CHECKED,
        mlDsaPublicKeyHash: await keyDigest(p.mlDsaPublicKey),
        kemPublicKeyHash: await keyDigest(p.kemPublicKey),
        keyVersion: 1,
    } as ContactPin;
}

/* The contact pins a person's settings hold: everyone but themself, or `filed` ([who, whose keys]) alone. */
async function contacts(of: number, filed: [number, number][] | null) {
    const f = await family();
    const pairs =
        filed ?? [1, 2, 3, 4, 5].filter((n) => n !== of).map((n) => [n, n] as [number, number]);
    const out: Record<string, ContactPin> = {};
    for (const [who, keys] of pairs) {
        const userId = f.p[who - 1]!.userId;
        out[userId] = { ...(await pin(keys)), userId };
    }
    return out;
}

type Call = <K extends keyof GroupResults>(
    operation: K,
    input: unknown,
) => Promise<GroupResults[K]>;

/*
 * Person `n`'s browser: the worker unlocked under the shared root, the
 * settings (the group pin at the head, `filed` contacts or everyone's),
 * `rosters` served and committed (the family's history by default); with
 * `seed` the group key opened from person 1's seal to them; with `area` A1
 * and A3 opened from person 1's grants to them.
 */
export async function session(
    n: number,
    options: {
        filed?: [number, number][] | null;
        rosters?: SignedGroupStatement[];
        seed?: boolean;
        area?: boolean;
    } = {},
): Promise<Call> {
    const f = await family();
    const who = f.p[n - 1]!;
    const p1 = f.p[0]!;
    const ledger = createAreaLedger();
    const host = {
        unlocked: () => ({ userId: who.userId, root: ROOT.slice(), keyVersion: 1 }),
        identity: () => ({ userId: who.userId, served: who.served, history: [] }),
        hybridKeys: () => ({
            signingKey: who.signer.signingKey.slice(),
            mlDsaSecretKey: who.signer.mlDsaSecretKey.slice(),
        }),
        granteeSecrets: () => who.secrets,
        ledger,
        workspaceKey: ledger.workspaceKey,
    } as unknown as GroupHost;
    const worker = createGroupSession(host);
    let id = 0;
    const call: Call = (operation, input) =>
        worker.handle({ id: ++id, operation, input } as GroupMessage) as never;
    const rosters = options.rosters ?? f.h.rosters;
    const chain = await chainOf(f.h.keys[0]!.publicKey, f.groupId, rosters, []);
    worker.useSettings(who.userId, {
        groups: { [f.groupId]: await pinAfter([], chain, CHECKED) },
        contacts: await contacts(n, options.filed ?? null),
    } as never);
    const served: ServedChain = {
        rosters: rosters.map(wire),
        successions: [],
        firstKeys: f.h.keys[0]!.publicKey,
        signerKeys: await mlDsaKeys(),
    };
    const accepted = await call('groupAccept', {
        userId: who.userId,
        groupId: f.groupId,
        served,
        record: null,
        checkedAt: CHECKED,
    });
    if (accepted.status !== 'accepted') throw new Error(`not accepted: ${accepted.status}`);
    const at = { rosterVersion: chain.roster.rosterVersion, rosterDigest: chain.rosterDigest };
    if (options.seed) {
        const ctx = {
            groupId: f.groupId,
            groupKeyVersion: 1,
            holderUserId: who.userId,
            holderKeyVersion: 1,
            sealerUserId: p1.userId,
            ...at,
        };
        const envelope = await sealGroupKey(pattern(64, 91), ctx, {
            chain,
            holderKemPublicKey: who.kemPublicKey,
            sealer: p1.signer,
        });
        await call('groupOpenSeal', {
            groupId: f.groupId,
            seal: { ...ctx, envelope: encode(envelope) },
            sealerMlDsaPublicKey: p1.served.mlDsaPublicKey,
        });
    }
    if (options.area)
        for (const [index, version] of [
            [0, 1],
            [2, 2],
        ] as const) {
            const area = f.areas[index]!;
            const ctx = {
                groupId: f.groupId,
                workspaceId: area.workspaceId,
                workspaceKeyVersion: version,
                granteeUserId: who.userId,
                granteeKeyVersion: 1,
                granterUserId: p1.userId,
                ...at,
            };
            const envelope = await sealAreaGrant(areaKey(index, version), ctx, {
                chain,
                areaIdSeed: area.idSeed,
                granteeKemPublicKey: who.kemPublicKey,
                granter: p1.signer,
            });
            await call('groupOpenArea', {
                groupId: f.groupId,
                workspaceId: area.workspaceId,
                idSeed: area.idSeed,
                servedVersion: version,
                grant: { ...ctx, envelope: encode(envelope) },
                granterMlDsaPublicKey: p1.served.mlDsaPublicKey,
                selfGrant: null,
            });
        }
    return call;
}

/* JSON with keys sorted at every level, as serde_json writes a Value: how both twins compare. */
export function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.keys(value)
            .sort()
            .filter((key) => (value as Json)[key] !== undefined)
            .map((key) => `${JSON.stringify(key)}:${canonical((value as Json)[key])}`)
            .join(',')}}`;
    return JSON.stringify(value);
}
const byCanonical = (a: unknown, b: unknown) => (canonical(a) < canonical(b) ? -1 : 1);

/* The calls, in the order both twins build them. */
export async function callSpecs(): Promise<Json[]> {
    const f = await family();
    const u = (n: number) => f.p[n - 1]!.userId;
    const changed = (n: number, roles: GroupRole[]) => ({ userId: u(n), status: 'active', roles });
    const grants = (n: number) =>
        [
            { userId: u(n), workspaceId: f.areas[0]!.workspaceId, version: 1 },
            { userId: u(n), workspaceId: f.areas[2]!.workspaceId, version: 2 },
        ].sort(byCanonical);
    const built = (route: Json, groupKeyVersion: number, who: Json, extra: Json) => ({
        route,
        rosterVersion: 8,
        groupKeyVersion,
        changed: [who],
        keySeal: null,
        seals: [],
        grants: [],
        ...extra,
    });
    return [
        {
            name: 'admit-member',
            op: { kind: 'admit', who: 4, roles: [] },
            expected: built({ kind: 'admit', userId: u(4) }, 1, changed(4, []), {
                grants: grants(4),
            }),
        },
        {
            name: 'admit-manager',
            op: { kind: 'admit', who: 5, roles: ['members'] },
            expected: built({ kind: 'admit', userId: u(5) }, 1, changed(5, ['members']), {
                keySeal: u(5),
                grants: grants(5),
            }),
        },
        {
            name: 'grant-members',
            op: { kind: 'grant', who: 2 },
            expected: built({ kind: 'member', userId: u(2) }, 1, changed(2, ['members']), {
                keySeal: u(2),
            }),
        },
        {
            name: 'take-members',
            op: { kind: 'take', who: 3 },
            expected: built({ kind: 'member', userId: u(3) }, 2, changed(3, []), { seals: [u(1)] }),
        },
        {
            name: 'handover-to',
            op: { kind: 'handover', who: 2 },
            expected: built({ kind: 'member', userId: u(2) }, 1, changed(2, ['billing']), {}),
        },
        {
            name: 'refused-already-in',
            op: { kind: 'admit', who: 2, roles: [] },
            refused: 'This person is in the family already.',
        },
        {
            name: 'refused-not-checked',
            op: { kind: 'admit', who: 4, roles: [], filed: [] },
            refused: 'Check their words first.',
        },
        {
            name: 'refused-unchecked-keys',
            op: { kind: 'admit', who: 5, roles: [], filed: [[5, 4]] },
            refused: 'These are not the keys whose words were checked.',
        },
        {
            name: 'refused-not-in',
            op: { kind: 'grant', who: 4 },
            refused: 'This person is not in the family now.',
        },
        {
            name: 'refused-unchanged',
            op: { kind: 'grant', who: 3 },
            refused: 'That doesn’t change their roles.',
        },
        {
            name: 'refused-step-down',
            op: { kind: 'stepDown' },
            refused: 'Make someone else the organizer first.',
        },
        {
            name: 'refused-take-from-oneself',
            op: { kind: 'take', who: 1 },
            refused: 'Ask another manager to take this role from you.',
        },
        {
            name: 'refused-not-a-manager',
            op: { kind: 'take', who: 3, as: 2 },
            refused: 'Only someone who manages the family can change its members.',
        },
        {
            name: 'refused-no-seed',
            op: { kind: 'grant', who: 2, noSeed: true },
            refused: 'Open the family’s key first.',
        },
        {
            name: 'refused-folder-not-opened',
            op: { kind: 'admit', who: 4, roles: [], noArea: true },
            refused: 'Open every family folder first.',
        },
    ];
}

const withRole = (roles: GroupRole[], role: GroupRole, on: boolean) =>
    [...roles.filter((at) => at !== role), ...(on ? [role] : [])].sort() as GroupRole[];

/*
 * One call through the worker, as the web's callers make it (let-in-dialog's
 * admit, members.tsx's role changes, the handover's two calls), on `call` (a
 * session made as the op says when none): the staged body and the outbox entry
 * the web keeps, or the refusal's sentence.
 */
export async function runOn(
    given: Call | null,
    op: Json,
    at: { revision: number; members: { userId: string; roles: GroupRole[] }[] } | null = null,
): Promise<{ body: RosterCallBody; entry: Json; route: Json } | { refused: string }> {
    const f = await family();
    const by: number = op.as ?? 1;
    const call =
        given ??
        (await session(by, {
            filed: op.filed ?? null,
            seed: by !== 2 && op.noSeed !== true,
            area: op.noArea !== true,
        }));
    const kems = Object.fromEntries(f.p.map((p) => [p.userId, p.served.kemPublicKey]));
    // Roles as the device's committed chain holds them (the family's roster 7 unless told).
    const members = at?.members ?? f.h.statements.at(-1)!.members;
    const roles = (n: number) => members.find((m) => m.userId === f.p[n - 1]!.userId)?.roles ?? [];
    let stageOp: Json;
    let route: Json;
    switch (op.kind) {
        case 'admit': {
            const newcomer = f.p[op.who - 1]!;
            // An admission's served identity with fields replaced (the fuzz kind roster_call).
            const served = { ...newcomer.served };
            for (const [key, value] of Object.entries((op.served ?? {}) as Json))
                if (key in served) (served as Json)[key] = value;
            stageOp = { kind: 'admit', userId: newcomer.userId, served, roles: op.roles };
            route = { kind: 'admit', userId: newcomer.userId };
            break;
        }
        case 'grant':
        case 'take': {
            const userId = f.p[op.who - 1]!.userId;
            stageOp = {
                kind: 'roles',
                userId,
                roles: withRole([...roles(op.who)], 'members', op.kind === 'grant'),
            };
            route = { kind: 'member', userId };
            break;
        }
        case 'handover': {
            const userId = f.p[op.who - 1]!.userId;
            stageOp = {
                kind: 'roles',
                userId,
                roles: withRole([...roles(op.who)], 'billing', true),
            };
            route = { kind: 'member', userId };
            break;
        }
        case 'stepDown': {
            const userId = f.p[by - 1]!.userId;
            stageOp = { kind: 'roles', userId, roles: withRole([...roles(by)], 'billing', false) };
            route = { kind: 'member', userId };
            break;
        }
        default:
            throw new Error(String(op.kind));
    }
    try {
        const staged = await call('groupStage', {
            groupId: f.groupId,
            expectedRevision: at?.revision ?? 7,
            op: stageOp,
            kems: op.kind === 'admit' ? {} : kems,
        });
        if (staged.outboxId === null) throw new Error('nothing staged');
        // The web's outbox entry, as outbox.ts keeps it.
        const entry = {
            v: 1,
            id: staged.outboxId,
            groupId: f.groupId,
            route,
            body: staged.body,
            stagedEnvelope: staged.stagedEnvelope,
            state: 'ready',
            attempts: 0,
            joinCode: staged.joinCode,
            notices: [],
            ...(staged.admits ? { admits: staged.admits } : {}),
            previousRosterDigest: staged.previousRosterDigest,
            rosterDigest: staged.rosterDigest,
        };
        return { body: staged.body, entry, route };
    } catch (error) {
        return { refused: (error as Error).message };
    }
}

export const run = (op: Json) => runOn(null, op);

function personOf(f: Family, userId: string) {
    const found = f.p.find((p) => p.userId === userId);
    if (!found) throw new Error(`no person ${userId}`);
    return found;
}

const firstKeysOf = (doc: Json): GroupPublicKey => doc.family.firstKeys;
const historyOf = (doc: Json) => (doc.family.rosters as SignedStatementWire[]).map(unwire);

/* A grant opened by its grantee to the folder's key at its version, granted by `granter`: its verdict entry. */
async function openGrant(doc: Json, chain: AcceptedRosters, grant: GrantWire, granter: Person) {
    const f = await family();
    const grantee = personOf(f, grant.granteeUserId);
    const index = (doc.family.areas as Json[]).findIndex(
        (area) => area.workspaceId === grant.workspaceId,
    );
    if (index < 0) throw new Error('a grant of a folder the family never had');
    const key = await openAreaGrant(
        decode(grant.envelope),
        {
            groupId: doc.family.groupId,
            workspaceId: grant.workspaceId,
            workspaceKeyVersion: grant.workspaceKeyVersion,
            granteeUserId: grantee.userId,
            granteeKeyVersion: grant.granteeKeyVersion,
            granterUserId: granter.userId,
            rosterVersion: grant.rosterVersion,
            rosterDigest: grant.rosterDigest,
        },
        {
            chain,
            areaIdSeed: doc.family.areas[index].idSeed,
            granterMlDsaPublicKey: granter.mlDsaPublicKey,
            reader: { userId: grantee.userId, keyVersion: 1 },
            grantee: grantee.secrets,
        },
    );
    if (encode(key) !== encode(areaKey(index, grant.workspaceKeyVersion)))
        throw new Error('the grant is not of that folder’s key at that version');
    return {
        userId: grantee.userId,
        workspaceId: grant.workspaceId,
        version: grant.workspaceKeyVersion,
    };
}

/*
 * A body as every member and the server take it, from the family's history in
 * `doc` (the core's verdict, crates/hushos-core/tests/common/roster_calls.rs).
 */
export async function verdict(doc: Json, route: Json, body: RosterCallBody) {
    const f = await family();
    const groupId: string = doc.family.groupId;
    const history = historyOf(doc);
    const chain = await chainOf(firstKeysOf(doc), groupId, history, []);
    const roster = unwire(body.roster);
    const identities = Object.fromEntries(f.p.map((p) => [p.userId, [p.served]]));
    await checkNextRoster(chain, roster, await mlDsaKeys(), identities);
    const after = await chainOf(
        firstKeysOf(doc),
        groupId,
        [...history, roster],
        body.succession ? [unwire(body.succession)] : [],
    );
    const p1 = f.p[0]!;
    const openSeal = async (seal: Json) => {
        const holder = personOf(f, seal.holderUserId);
        const seed = await openGroupKey(
            decode(seal.envelope),
            {
                groupId,
                groupKeyVersion: seal.groupKeyVersion,
                holderUserId: holder.userId,
                holderKeyVersion: seal.holderKeyVersion,
                sealerUserId: p1.userId,
                rosterVersion: seal.rosterVersion,
                rosterDigest: seal.rosterDigest,
            },
            {
                chain: after,
                sealerMlDsaPublicKey: p1.mlDsaPublicKey,
                reader: { userId: holder.userId, keyVersion: 1 },
                holder: holder.secrets,
            },
        );
        const pair = await groupKeyPair(seed);
        if (!sameGroupKey(pair.publicKey, after.groupKey))
            throw new Error('the seal is not of the key after the call');
        return holder.userId;
    };
    const seals: string[] = [];
    for (const seal of body.seals ?? []) seals.push(await openSeal(seal));
    seals.sort();
    const keySeal = body.keySeal ? await openSeal(body.keySeal) : null;
    const grants: Json[] = [];
    for (const grant of body.grants ?? []) grants.push(await openGrant(doc, after, grant, p1));
    grants.sort(byCanonical);
    const changed = after.roster.members
        .filter((entry) => entry.sinceVersion === after.roster.rosterVersion)
        .map((entry) => ({ userId: entry.userId, status: entry.status, roles: [...entry.roles] }))
        .sort(byCanonical);
    return {
        route,
        rosterVersion: after.roster.rosterVersion,
        groupKeyVersion: after.groupKeyVersion,
        changed,
        keySeal,
        seals,
        grants,
    };
}

export function familyJson(f: Family) {
    return {
        groupId: f.groupId,
        groupIdSeed: f.groupIdSeed,
        firstKeys: f.h.keys[0]!.publicKey,
        areas: f.areas,
        rosters: f.h.rosters.map(wire),
        expectedRevision: 7,
    };
}

/* Owed grants, in the order both twins build them. */
export async function grantSpecs(): Promise<Json[]> {
    const f = await family();
    const u = (n: number) => f.p[n - 1]!.userId;
    return [
        {
            name: 'a-member-pays-what-is-owed',
            as: 2,
            missing: [
                [0, 3],
                [2, 3],
                [2, 1],
            ],
            expected: [
                { userId: u(3), workspaceId: f.areas[0]!.workspaceId, version: 1 },
                { userId: u(3), workspaceId: f.areas[2]!.workspaceId, version: 2 },
                { userId: u(1), workspaceId: f.areas[2]!.workspaceId, version: 2 },
            ].sort(byCanonical),
        },
        {
            name: 'refused-to-someone-not-in',
            as: 2,
            missing: [[0, 4]],
            refused: 'Areas are granted only to active members.',
        },
    ];
}

/* Owed grants through the worker, posted per folder as fillGrants posts them (at most 256 a call). */
export async function grantRun(
    spec: Json,
): Promise<{ workspaceId: string; body: string }[] | { refused: string }> {
    const f = await family();
    const call = await session(spec.as, { area: true });
    const missing = (spec.missing as [number, number][]).map(([area, who]) => ({
        workspaceId: f.areas[area]!.workspaceId,
        userId: f.p[who - 1]!.userId,
        kemPublicKey: f.p[who - 1]!.served.kemPublicKey,
    }));
    try {
        const { grants } = await call('groupGrants', { groupId: f.groupId, missing });
        const byArea = new Map<string, GrantWire[]>();
        for (const grant of grants)
            byArea.set(grant.workspaceId, [...(byArea.get(grant.workspaceId) ?? []), grant]);
        const out: { workspaceId: string; body: string }[] = [];
        for (const [workspaceId, list] of byArea)
            for (let at = 0; at < list.length; at += 256)
                out.push({
                    workspaceId,
                    body: JSON.stringify({ grants: list.slice(at, at + 256) }),
                });
        return out;
    } catch (error) {
        return { refused: (error as Error).message };
    }
}

/* Route 22 bodies, each grant opened by its grantee, as both twins declare them. */
export async function grantsVerdict(doc: Json, by: number, requests: Json[]) {
    const f = await family();
    const chain = await chainOf(firstKeysOf(doc), doc.family.groupId, historyOf(doc), []);
    const out: Json[] = [];
    for (const request of requests) {
        const body = JSON.parse(request.body) as { grants: GrantWire[] };
        for (const grant of body.grants) {
            if (grant.workspaceId !== request.workspaceId)
                throw new Error('a request is one folder’s');
            out.push(await openGrant(doc, chain, grant, f.p[by - 1]!));
        }
    }
    return out.sort(byCanonical);
}

/* The admin's join codes over the family: the contact filed for them (`keys`: whose), which rosters. */
export async function joinSpecs(doc: Json): Promise<Json[]> {
    const rosters = historyOf(doc);
    const code = async (version: number) =>
        joinCode(await rosterDigest(rosters[version - 1]!.statement), firstKeysOf(doc), 1);
    const codeAt = async (version: number) => ({
        status: 'code',
        rosterVersion: version,
        code: await code(version),
    });
    return [
        { name: 'let-in-at-2', who: 2, keys: 2, rosters: 'all', expected: await codeAt(2) },
        { name: 'let-in-at-3', who: 3, keys: 3, rosters: 'all', expected: await codeAt(3) },
        { name: 'the-organizer-at-1', who: 1, keys: 1, rosters: 'all', expected: await codeAt(1) },
        {
            name: 'other-keys-pinned',
            who: 2,
            keys: 3,
            rosters: 'all',
            expected: { status: 'other-keys', rosterVersion: 2 },
        },
        {
            name: 'never-checked',
            who: 2,
            keys: null,
            rosters: 'all',
            expected: { status: 'not-pinned' },
        },
        {
            name: 'not-let-in',
            who: 4,
            keys: 4,
            rosters: 'all',
            expected: { status: 'not-admitted' },
        },
        {
            name: 'a-roster-of-the-run-left-out',
            who: 2,
            keys: 2,
            rosters: 'without-2',
            expected: {
                status: 'refused',
                message: 'The server left out part of the family’s member list.',
            },
        },
        {
            name: 'junk-beside-the-chain',
            who: 2,
            keys: 2,
            rosters: 'with-junk',
            expected: await codeAt(2),
        },
    ];
}

export const JUNK = wire({
    statement: new TextEncoder().encode('["junk"]'),
    signature: { ed25519: new Uint8Array(64), mlDsa: new Uint8Array(3309) },
    signerSignature: new Uint8Array(3373),
});

/* Person 1's worker that committed `doc`'s history (plus `extra`), with `filed` contacts. */
export async function committedSession(
    doc: Json,
    filed: [number, number][],
    extra: SignedGroupStatement | null = null,
): Promise<Call> {
    const f = await family();
    const p1 = f.p[0]!;
    const ledger = createAreaLedger();
    const worker = createGroupSession({
        unlocked: () => ({ userId: p1.userId, root: ROOT.slice(), keyVersion: 1 }),
        identity: () => ({ userId: p1.userId, served: p1.served, history: [] }),
        ledger,
    } as unknown as GroupHost);
    let id = 0;
    const call: Call = (operation, input) =>
        worker.handle({ id: ++id, operation, input } as GroupMessage) as never;
    const history = [...historyOf(doc), ...(extra ? [extra] : [])];
    const chain = await chainOf(firstKeysOf(doc), doc.family.groupId, history, []);
    worker.useSettings(p1.userId, {
        groups: { [doc.family.groupId]: await pinAfter([], chain, CHECKED) },
        contacts: await contacts(1, filed),
    } as never);
    const accepted = await call('groupAccept', {
        userId: p1.userId,
        groupId: doc.family.groupId,
        served: {
            rosters: history.map(wire),
            successions: [],
            firstKeys: firstKeysOf(doc),
            signerKeys: await mlDsaKeys(),
        },
        record: null,
        checkedAt: CHECKED,
    });
    if (accepted.status !== 'accepted') throw new Error(`not accepted: ${accepted.status}`);
    return call;
}

/*
 * The admin's join code for person `who` (6: someone never in it) over
 * `rosters`, read as the core's typed answer: the code only for the pinned
 * keys, none without a pin, "not in the member list yet" as not admitted.
 */
export async function joinCodeWith(
    call: Call,
    doc: Json,
    who: number,
    rosters: SignedStatementWire[],
) {
    const f = await family();
    const userId = who === 6 ? 'ffffffff-0000-4000-8000-000000000006' : f.p[who - 1]!.userId;
    try {
        const result = await call('groupJoinCode', {
            groupId: doc.family.groupId,
            userId,
            rosters,
        });
        if (result.pinMatches === null) return { status: 'not-pinned' };
        if (result.pinMatches !== true)
            return { status: 'other-keys', rosterVersion: result.rosterVersion };
        return { status: 'code', rosterVersion: result.rosterVersion, code: result.code };
    } catch (error) {
        const message = (error as Error).message;
        if (message === 'This person is not in the family’s member list yet.')
            return { status: 'not-admitted' };
        return { status: 'refused', message };
    }
}

const filedFor = (spec: Json): [number, number][] =>
    spec.keys !== null && spec.who <= 5 ? [[spec.who, spec.keys]] : [];

export async function joinRunOver(doc: Json, spec: Json) {
    let rosters = [...(doc.family.rosters as SignedStatementWire[])];
    if (spec.rosters === 'without-2') rosters = rosters.filter((_, index) => index !== 1);
    if (spec.rosters === 'with-junk') rosters.push(JUNK);
    return joinCodeWith(await committedSession(doc, filedFor(spec)), doc, spec.who, rosters);
}

/* The outbox entries: which call's entry, how it is changed, the pin filed, the head committed, what is declared. */
export function entrySpecs(doc: Json): Json[] {
    const route = (name: string) => doc.calls.find((c: Json) => c.name === name).expected.route;
    const send = (call: string) => ({ status: 'send', route: route(call), body: call });
    const hold = (call: string, reason: string) => ({ status: 'hold', route: route(call), reason });
    return [
        {
            name: 'an-admission-as-signed',
            call: 'admit-member',
            keys: 4,
            head: 'family',
            expected: send('admit-member'),
        },
        {
            name: 'an-admission-with-no-head-yet',
            call: 'admit-member',
            keys: 4,
            head: null,
            expected: send('admit-member'),
        },
        {
            name: 'an-admission-to-other-keys',
            call: 'admit-member',
            keys: 5,
            head: 'family',
            expected: hold('admit-member', 'other-keys'),
        },
        {
            name: 'an-admission-never-checked',
            call: 'admit-member',
            keys: null,
            head: 'family',
            expected: hold('admit-member', 'other-keys'),
        },
        {
            name: 'a-role-change',
            call: 'take-members',
            keys: null,
            head: 'family',
            expected: send('take-members'),
        },
        {
            name: 'landed-already',
            call: 'grant-members',
            keys: null,
            head: 'with:grant-members',
            expected: { status: 'landed', route: route('grant-members') },
        },
        {
            name: 'superseded-by-another',
            call: 'grant-members',
            keys: null,
            head: 'with:handover-to',
            expected: { status: 'superseded', route: route('grant-members') },
        },
        {
            name: 'held-back-by-an-earlier-version',
            call: 'admit-member',
            change: 'awaiting-check',
            keys: 4,
            head: 'family',
            expected: hold('admit-member', 'awaiting-check'),
        },
        {
            name: 'a-creation-stored-not-pinned',
            call: 'grant-members',
            change: 'committed',
            keys: null,
            head: null,
            expected: hold('grant-members', 'committed'),
        },
        {
            name: 'kept-under-another-id',
            call: 'grant-members',
            change: 'other-id',
            keys: null,
            head: 'family',
            expected: { status: 'lost' },
        },
        {
            name: 'a-later-version',
            call: 'grant-members',
            change: 'v2',
            keys: null,
            head: 'family',
            expected: { status: 'lost' },
        },
        {
            name: 'another-family',
            call: 'grant-members',
            change: 'other-family',
            keys: null,
            head: 'family',
            expected: { status: 'lost' },
        },
        {
            name: 'an-unknown-route',
            call: 'grant-members',
            change: 'unknown-route',
            keys: null,
            head: 'family',
            expected: { status: 'lost' },
        },
    ];
}

export function entryValue(
    entry: Json,
    change: string | undefined,
): { value: Json; otherFamily: boolean } {
    const value = structuredClone(entry);
    if (change === 'awaiting-check') value.state = 'awaiting-check';
    if (change === 'committed') value.state = 'committed';
    if (change === 'v2') value.v = 2;
    if (change === 'unknown-route') value.route = { kind: 'join' };
    return { value, otherFamily: change === 'other-family' };
}

/* The committed chain's roster digests a spec's head names: none, the family's, or with a call's roster. */
async function headOf(doc: Json, head: string | null): Promise<string[] | null> {
    if (head === null) return null;
    const rosters = historyOf(doc);
    if (head.startsWith('with:')) {
        const call = doc.calls.find((c: Json) => c.name === head.slice(5));
        rosters.push(unwire(call.body.roster));
    }
    // The chain is accepted as the core's ledger commits it, so a head that is not a chain is refused here too.
    const chain = await chainOf(firstKeysOf(doc), doc.family.groupId, rosters, []);
    return [...chain.rosterDigests];
}

/* An entry read by the web, as kept under `id`: opened from person 1's device store, then readOutboxEntry. */
export async function entryRead(doc: Json, spec: Json, id: string, envelope: string) {
    const f = await family();
    let value: unknown;
    try {
        value = await openDeviceRecord(
            ROOT.slice(),
            f.p[0]!.userId,
            doc.family.groupId,
            'outbox',
            envelope,
        );
    } catch {
        return { status: 'lost' };
    }
    const routeUser: string | undefined = doc.calls.find((c: Json) => c.name === spec.call)
        ?.expected.route.userId;
    const who = routeUser ? f.p.findIndex((p) => p.userId === routeUser) + 1 : 0;
    const pinned =
        who > 0 && spec.keys !== null ? { ...(await pin(spec.keys)), userId: routeUser! } : null;
    const read = readOutboxEntry(
        value,
        doc.family.groupId,
        pinned ? { userId: pinned.userId, fingerprint: pinned.fingerprint } : null,
        { id, head: await headOf(doc, spec.head) },
    );
    if (read === null) return { status: 'lost' };
    if (read.status === 'hold') return { status: 'hold', route: read.route, reason: read.reason };
    if (read.status === 'landed' || read.status === 'superseded')
        return { status: read.status, route: read.route };
    return { status: 'send', route: read.route, body: JSON.parse(read.body) };
}

/* Whether a read says what is declared: a body must be the named call's, by content. */
export function entrySays(doc: Json, read: Json, expected: Json) {
    const want = { ...expected };
    if (typeof want.body === 'string')
        want.body = doc.calls.find((c: Json) => c.name === want.body).body;
    return canonical(read) === canonical(want);
}

export async function sealEntry(groupId: string, value: Json) {
    const f = await family();
    return sealDeviceRecord(ROOT.slice(), f.p[0]!.userId, groupId, 'outbox', value);
}

/* This twin's whole document, each case checked against its declaration. */
export async function fixture() {
    const f = await family();
    const doc: Json = { family: familyJson(f), accountRoot: encode(ROOT) };
    const entries = new Map<string, Json>();
    const calls: Json[] = [];
    for (const spec of await callSpecs()) {
        const out: Json = { ...spec };
        const result = await run(spec.op);
        if ('refused' in result) {
            if (result.refused !== spec.refused)
                throw new Error(`${spec.name}: refused with ${result.refused}`);
            out.body = null;
        } else {
            if (canonical(result.route) !== canonical(spec.expected.route))
                throw new Error(`${spec.name}: route`);
            out.body = result.body;
            entries.set(spec.name, result.entry);
        }
        calls.push(out);
    }
    doc.calls = calls;
    for (const c of calls)
        if (c.body !== null) {
            const said = await verdict(doc, c.expected.route, c.body);
            if (canonical(said) !== canonical(c.expected))
                throw new Error(`${c.name}: ${JSON.stringify(said)}`);
        }
    const grants: Json[] = [];
    for (const spec of await grantSpecs()) {
        const result = await grantRun(spec);
        if ('refused' in result) {
            if (result.refused !== spec.refused) throw new Error(`${spec.name}: ${result.refused}`);
            grants.push({ ...spec, requests: null });
            continue;
        }
        const said = await grantsVerdict(doc, spec.as, result);
        if (canonical(said) !== canonical(spec.expected))
            throw new Error(`${spec.name}: ${JSON.stringify(said)}`);
        grants.push({ ...spec, requests: result });
    }
    doc.grantCalls = grants;
    const joins: Json[] = [];
    for (const spec of await joinSpecs(doc)) {
        const outcome = await joinRunOver(doc, spec);
        if (canonical(outcome) !== canonical(spec.expected))
            throw new Error(`${spec.name}: ${JSON.stringify(outcome)}`);
        joins.push({ ...spec, outcome });
    }
    doc.joinCodes = joins;
    const sealed: Json[] = [];
    for (const spec of entrySpecs(doc)) {
        const { value, otherFamily } = entryValue(entries.get(spec.call)!, spec.change);
        const envelope = await sealEntry(otherFamily ? OTHER_FAMILY : f.groupId, value);
        const id = spec.change === 'other-id' ? OTHER_ID : (value.id as string);
        const read = await entryRead(doc, spec, id, envelope);
        if (!entrySays(doc, read, spec.expected))
            throw new Error(`${spec.name}: ${JSON.stringify(read)}`);
        sealed.push({ ...spec, envelope, id });
    }
    doc.outboxEntries = sealed;
    return doc;
}

/* The core's document through this twin: every outcome the same (thrown otherwise). */
export async function check(doc: Json) {
    const specs = await callSpecs();
    if (canonical(specs.map((s) => s.name)) !== canonical(doc.calls.map((c: Json) => c.name)))
        throw new Error('the same calls in the same order');
    for (const c of doc.calls) {
        const spec = specs.find((s) => s.name === c.name)!;
        if (c.body === null) {
            if (c.refused !== spec.refused) throw new Error(`${c.name}: another refusal`);
            const here = await run(spec.op);
            if (!('refused' in here) || here.refused !== spec.refused)
                throw new Error(`${c.name}: not refused alike here`);
            continue;
        }
        if (canonical(c.expected) !== canonical(spec.expected))
            throw new Error(`${c.name}: declared otherwise`);
        const said = await verdict(doc, c.expected.route, c.body);
        if (canonical(said) !== canonical(spec.expected))
            throw new Error(`${c.name}: ${JSON.stringify(said)}`);
    }
    const grantSpecsHere = await grantSpecs();
    if (doc.grantCalls.length !== grantSpecsHere.length) throw new Error('the same grant calls');
    for (const [index, theirs] of (doc.grantCalls as Json[]).entries()) {
        const spec = grantSpecsHere[index]!;
        if (theirs.name !== spec.name) throw new Error('the same grant calls in the same order');
        if (theirs.requests === null) {
            if (theirs.refused !== spec.refused) throw new Error(`${spec.name}: another refusal`);
            const here = await grantRun(spec);
            if (!('refused' in here) || here.refused !== spec.refused)
                throw new Error(`${spec.name}: not refused alike here`);
            continue;
        }
        const said = await grantsVerdict(doc, spec.as, theirs.requests);
        if (canonical(said) !== canonical(spec.expected))
            throw new Error(`${spec.name}: ${JSON.stringify(said)}`);
    }
    for (const spec of doc.joinCodes) {
        const outcome = await joinRunOver(doc, spec);
        if (canonical(outcome) !== canonical(spec.outcome))
            throw new Error(`${spec.name}: ${JSON.stringify(outcome)}`);
    }
    for (const spec of doc.outboxEntries) {
        const read = await entryRead(doc, spec, spec.id, spec.envelope);
        if (!entrySays(doc, read, spec.expected))
            throw new Error(`${spec.name}: ${JSON.stringify(read)}`);
    }
}

/* A manager's device over time (the fuzz kind roster_call_session) -------- */

/* The ops a session takes, each with only the fields it reads; null when a step does not fit (the core's session_step). */
export function sessionStep(step: Json): Json | null {
    if (typeof step !== 'object' || step === null) return null;
    const op = step.op;
    if (['sync', 'openKey', 'openArea', 'lock', 'unlock', 'relaunch', 'commitOther'].includes(op))
        return { op };
    if (op === 'build') {
        const call = step.call;
        if (typeof call !== 'object' || call === null || Array.isArray(call)) return null;
        const who =
            Number.isInteger(call.who) && call.who >= 1 && call.who <= 5
                ? (call.who as number)
                : null;
        switch (call.kind) {
            case 'admit':
                return who === null ? null : { op, call: { kind: 'admit', who, roles: [] } };
            case 'grant':
            case 'take':
            case 'handover':
                return who === null ? null : { op, call: { kind: call.kind, who } };
            case 'stepDown':
                return { op, call: { kind: 'stepDown' } };
            default:
                return null;
        }
    }
    if (op === 'send') {
        const entry = step.entry;
        if (!Number.isInteger(entry) || entry < 0 || entry >= 16) return null;
        if (step.answer !== 'land' && step.answer !== 'none') return null;
        return { op, entry, answer: step.answer };
    }
    return null;
}

const FIRSTS: Record<string, string> = {
    'Open the family’s key first.': 'first:open-key',
    'Check the family’s member list first.': 'first:sync',
    'Open every family folder first.': 'first:open-folders',
};

/*
 * Steps of a manager's device (person 1) against a server holding the family
 * (the core's session_run): the outcome of each step, as both twins write it.
 * Invariants: a sent body is the kept one, byte for byte; a built call's
 * expectedRevision is the head it was built on; nothing is built while locked.
 */
export async function sessionRun(steps: Json[]): Promise<string[]> {
    const f = await family();
    const p1 = f.p[0]!;
    const p3 = f.p[2]!;
    const server = { rosters: [...f.h.rosters], successions: [] as SignedGroupStatement[] };
    const serverChain = () =>
        chainOf(f.h.keys[0]!.publicKey, f.groupId, server.rosters, server.successions);
    const pinR7 = await pinAfter(
        [],
        await chainOf(f.h.keys[0]!.publicKey, f.groupId, f.h.rosters, []),
        CHECKED,
    );
    const everyone = await contacts(1, null);
    let locked = false;
    let committed: AcceptedRosters | null = null;
    let committedMembers: { userId: string; roles: GroupRole[] }[] | null = null;
    const host = {
        unlocked: () => {
            if (locked) throw new Error('Unlock your account first.');
            return { userId: p1.userId, root: ROOT.slice(), keyVersion: 1 };
        },
        identity: () => {
            if (locked) throw new Error('Open your identity first.');
            return { userId: p1.userId, served: p1.served, history: [] };
        },
        hybridKeys: () => ({
            signingKey: p1.signer.signingKey.slice(),
            mlDsaSecretKey: p1.signer.mlDsaSecretKey.slice(),
        }),
        granteeSecrets: () => p1.secrets,
    } as Json;
    let worker: ReturnType<typeof createGroupSession>;
    const unlock = (fresh: boolean) => {
        if (fresh) {
            const ledger = createAreaLedger();
            host.ledger = ledger;
            host.workspaceKey = ledger.workspaceKey;
            worker = createGroupSession(host as GroupHost);
        }
        locked = false;
        worker.useSettings(p1.userId, {
            groups: { [f.groupId]: pinR7 },
            contacts: everyone,
        } as never);
    };
    unlock(true);
    let id = 0;
    const call: Call = (operation, input) =>
        worker.handle({ id: ++id, operation, input } as GroupMessage) as never;
    const kept: { id: string; envelope: string; body: string }[] = [];
    const out: string[] = [];
    for (const step of steps) {
        let outcome: string;
        switch (step.op) {
            case 'sync': {
                if (locked) {
                    outcome = 'locked';
                    break;
                }
                try {
                    const result = await call('groupAccept', {
                        userId: p1.userId,
                        groupId: f.groupId,
                        served: {
                            rosters: server.rosters.map(wire),
                            successions: server.successions.map(wire),
                            firstKeys: f.h.keys[0]!.publicKey,
                            signerKeys: await mlDsaKeys(),
                        },
                        record: null,
                        checkedAt: CHECKED,
                    });
                    if (result.status === 'accepted') {
                        committed = await serverChain();
                        committedMembers = result.view.members.map((m) => ({
                            userId: m.userId,
                            roles: [...m.roles],
                        }));
                        outcome = `accepted:${result.view.rosterVersion}`;
                    } else outcome = 'refused';
                } catch {
                    outcome = 'refused';
                }
                break;
            }
            case 'openKey': {
                const chain = await serverChain();
                if (chain.groupKeyVersion !== 1 || locked) {
                    outcome = 'no-seal';
                    break;
                }
                try {
                    const ctx = {
                        groupId: f.groupId,
                        groupKeyVersion: 1,
                        holderUserId: p1.userId,
                        holderKeyVersion: 1,
                        sealerUserId: p1.userId,
                        rosterVersion: chain.roster.rosterVersion,
                        rosterDigest: chain.rosterDigest,
                    };
                    const envelope = await sealGroupKey(pattern(64, 91), ctx, {
                        chain,
                        holderKemPublicKey: p1.kemPublicKey,
                        sealer: p1.signer,
                    });
                    await call('groupOpenSeal', {
                        groupId: f.groupId,
                        seal: { ...ctx, envelope: encode(envelope) },
                        sealerMlDsaPublicKey: p1.served.mlDsaPublicKey,
                    });
                    outcome = 'opened';
                } catch {
                    outcome = 'refused';
                }
                break;
            }
            case 'openArea': {
                // Granted at the device's committed head (none: nothing opens), as the core opens the keys.
                try {
                    if (!committed || locked) throw new Error('no chain');
                    for (const [index, version] of [
                        [0, 1],
                        [2, 2],
                    ] as const) {
                        const area = f.areas[index]!;
                        const ctx = {
                            groupId: f.groupId,
                            workspaceId: area.workspaceId,
                            workspaceKeyVersion: version,
                            granteeUserId: p1.userId,
                            granteeKeyVersion: 1,
                            granterUserId: p1.userId,
                            rosterVersion: committed.roster.rosterVersion,
                            rosterDigest: committed.rosterDigest,
                        };
                        const envelope = await sealAreaGrant(areaKey(index, version), ctx, {
                            chain: committed,
                            areaIdSeed: area.idSeed,
                            granteeKemPublicKey: p1.kemPublicKey,
                            granter: p1.signer,
                        });
                        await call('groupOpenArea', {
                            groupId: f.groupId,
                            workspaceId: area.workspaceId,
                            idSeed: area.idSeed,
                            servedVersion: version,
                            grant: { ...ctx, envelope: encode(envelope) },
                            granterMlDsaPublicKey: p1.served.mlDsaPublicKey,
                            selfGrant: null,
                        });
                    }
                    outcome = 'opened';
                } catch {
                    outcome = 'refused';
                }
                break;
            }
            case 'build': {
                const revision = server.rosters.length;
                const at = {
                    revision,
                    members: committedMembers ?? f.h.statements.at(-1)!.members,
                };
                const result = await runOn(call, step.call, at);
                if (locked) {
                    if (!('refused' in result)) throw new Error('built while locked');
                    outcome = 'locked-refused';
                } else if ('refused' in result) outcome = FIRSTS[result.refused] ?? 'refused';
                else {
                    if (result.body.expectedRevision !== revision)
                        throw new Error('expectedRevision is not the head’s');
                    kept.push({
                        id: result.entry.id,
                        envelope: await sealEntry(f.groupId, result.entry),
                        body: JSON.stringify(result.body),
                    });
                    outcome = `staged:${result.route.kind}`;
                }
                break;
            }
            case 'send': {
                if (locked || kept.length === 0) {
                    outcome = 'nothing';
                    break;
                }
                const entry = kept[step.entry % kept.length]!;
                const value = await openDeviceRecord(
                    ROOT.slice(),
                    p1.userId,
                    f.groupId,
                    'outbox',
                    entry.envelope,
                );
                const route = (value as Json).route;
                const pinned = route?.userId ? (everyone[route.userId] ?? null) : null;
                const read = readOutboxEntry(
                    value,
                    f.groupId,
                    pinned ? { userId: pinned.userId, fingerprint: pinned.fingerprint } : null,
                    { id: entry.id, head: committed ? [...committed.rosterDigests] : null },
                );
                if (read === null) outcome = 'lost';
                else if (read.status === 'hold') outcome = `hold:${read.reason}`;
                else if (read.status === 'landed' || read.status === 'superseded')
                    outcome = read.status;
                else {
                    if (read.body !== entry.body)
                        throw new Error('read back other bytes than kept');
                    let answer;
                    if (step.answer === 'land') {
                        const body = JSON.parse(read.body) as RosterCallBody;
                        const roster = unwire(body.roster);
                        const own = await rosterDigest(roster.statement);
                        const digests = await Promise.all(
                            server.rosters.map((r) => rosterDigest(r.statement)),
                        );
                        if (digests.includes(own)) answer = outboxStep(200, null);
                        else if (
                            parseRoster(roster.statement).previousRosterDigest === digests.at(-1)
                        ) {
                            server.rosters.push(roster);
                            if (body.succession) server.successions.push(unwire(body.succession));
                            answer = outboxStep(201, null);
                        } else answer = outboxStep(409, 'stale');
                    } else answer = outboxStep(0, null);
                    outcome = `send:${answer}`;
                }
                break;
            }
            case 'commitOther': {
                const chain = await serverChain();
                const holds = chain.roster.members.some(
                    (m) =>
                        m.userId === p3.userId &&
                        m.status === 'active' &&
                        m.roles.includes('members'),
                );
                if (chain.groupKeyVersion !== 1 || !holds) {
                    outcome = 'skipped';
                    break;
                }
                // Person 3 gives person 2 billing, or takes it back.
                const members = chain.roster.members.map((m) =>
                    m.userId === f.p[1]!.userId && m.status === 'active'
                        ? {
                              ...m,
                              roles: m.roles.includes('billing')
                                  ? m.roles.filter((r) => r !== 'billing')
                                  : [...m.roles, 'billing' as GroupRole],
                          }
                        : m,
                );
                const roster = await nextRoster(chain, members, {
                    signerUserId: p3.userId,
                    format: 2,
                });
                server.rosters.push(await signRoster(roster, await groupKeyAt(1), p3.signer));
                outcome = `committed:${server.rosters.length}`;
                break;
            }
            case 'lock':
                worker!.forget();
                locked = true;
                committed = null;
                committedMembers = null;
                outcome = 'locked';
                break;
            case 'unlock':
                unlock(false);
                outcome = 'unlocked';
                break;
            case 'relaunch':
                unlock(true);
                committed = null;
                committedMembers = null;
                outcome = 'relaunched';
                break;
            default:
                throw new Error(String(step.op));
        }
        out.push(outcome);
    }
    return out;
}
