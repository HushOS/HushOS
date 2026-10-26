import { createAreaLedger } from './area-ledger';
import { linksNeedingConsent } from './consent-due';
import { ROOT, ROTATED_ROOT, sessionOf } from './device-record-testkit';
import { CryptoError } from './errors';
import { lostRace } from './record-acceptance';
import { SPLIT_CHAIN } from './protocol';
import { joinCode } from './group-trust';
import {
    CHECKED,
    GROUP,
    OTHER_GROUP,
    groupKeyAt,
    history,
    mlDsaKeysOf,
    pattern,
    person,
    pinOf,
    type History,
    type Person,
} from './group-testkit';
import {
    groupKeyPair,
    rosterDigest,
    signGroup,
    signGroupSuccession,
    signRoster,
    type GroupPublicKey,
    type SignedGroupStatement,
} from './groups';
import {
    createIdentity,
    createSuccessor,
    openIdentityMlDsaKey,
    openIdentitySigningKey,
    publicIdentity,
    verifySuccessionConsent,
    type IdentityEnvelope,
    type ServedKeys,
    type SuccessionLink,
} from './identity';
import { joinCheck } from './join-check';
import { decode, encode } from './keys';
import type { GroupPin } from './pins';
import { signHybrid, successionStatement } from './signatures';
import {
    createGroupSession,
    openDeviceRecord,
    sealDeviceRecord,
    type GroupHost,
    type GroupMessage,
    type GroupResults,
    type ServedChain,
    type SignedStatementWire,
} from './session-groups';

/*
 * Joining and consent (groups 1d, Core 4), for the shared fixtures: the twin
 * of crates/hushos-core/tests/common/join.rs. Both build the same cases in the
 * same order from the same people (group-testkit.ts's persons 1, 2 and 3;
 * person 2 is the newcomer who previews), write the histories they signed,
 * the chain records their own acceptance sealed and the identities their own
 * code made, and run the other twin's document through their own code to the
 * same outcome:
 *
 * - `joinPreviews`: the worker's groupJoinPreview (the core's
 *   AreaLedger::group_join_preview) over named histories;
 * - `joinChecks`: joinCheck (join_check) over fixtures/join-check-cases.json;
 * - `consents`: linksNeedingConsent (links_needing_consent) and the worker's
 *   identityConsent (succession_consent_sign) over one account's identities,
 *   every consent either twin signed verified by the other.
 *
 * scripts/join-fixtures.ts writes this twin's document; join-fixtures.test.ts
 * reads the core's.
 */

type Json = Record<string, any>;

/* Join previews ------------------------------------------------------------ */

type Family = {
    p1: Person;
    p2: Person;
    p3: Person;
    main: History;
    other: History;
    succ: History;
    dead: History;
    /*
     * Person 3, a holder, at 2; person 2 let in at 3 (on first use), billing at 4; person 3
     * removed at 5 with every folder rotated and a succession tied to it.
     */
    removal: History;
    /* The same to 3, then another 4 and 5 (person 2 with members): another history above 3. */
    removalFork: History;
    /* succ's rosters 1 and 2, then a succession to another key 2 (seed 7) and roster 3 under it. */
    succOther: { rosters: SignedGroupStatement[]; successions: SignedGroupStatement[] };
};

async function joinWith(p1: Person, p2: Person, roles: ('billing' | 'members')[]) {
    const owner = p1.entry(['billing', 'members']);
    const h = await history('family', { format: 2 });
    await h.roster(p1, [owner]);
    await h.roster(p1, [owner, p2.entry(roles)]);
    await h.roster(p1, [owner, p2.entry(['billing'])]);
    await h.roster(p1, [owner, p2.entry(['billing'], 1, 'left')]);
    await h.roster(p1, [owner, p2.entry([])]);
    return h;
}

let built: Promise<Family> | undefined;
export function family() {
    built ??= (async () => {
        const [p1, p2, p3] = (await Promise.all([person(1), person(2), person(3)])) as [
            Person,
            Person,
            Person,
        ];
        const main = await joinWith(p1, p2, []);
        const other = await joinWith(p1, p2, ['billing']);
        const owner = p1.entry(['billing', 'members']);
        const succ = await history('family', { format: 2 });
        await succ.roster(p1, [owner, p3.entry(['members'])]);
        await succ.roster(p1, [owner, p3.entry(['members'], 1, 'left')]);
        await succ.succession(p1);
        await succ.roster(p1, [owner, p3.entry(['members'], 1, 'left'), p2.entry([])], 2);
        const dead = await history('family', { format: 2 });
        await dead.roster(p1, [owner]);
        await dead.roster(p1, [owner]);
        const removalOf = async (later: ('billing' | 'members')[]) => {
            const h = await history('family', { format: 2 });
            const holder = p3.entry(['members']);
            await h.roster(p1, [owner]);
            await h.roster(p1, [owner, holder]);
            await h.roster(p1, [owner, holder, p2.entry([])]);
            await h.roster(p1, [owner, holder, p2.entry(later)]);
            await h.roster(p1, [owner, p3.entry(['members'], 1, 'left'), p2.entry(later)]);
            await h.succession(p1);
            return h;
        };
        const removal = await removalOf(['billing']);
        const removalFork = await removalOf(['members']);
        const other7 = await groupKeyAt(7);
        const key1 = succ.keys[0]!;
        const away = await signGroupSuccession(
            {
                groupId: GROUP,
                oldVersion: 1,
                newVersion: 2,
                oldEd25519PublicKey: key1.publicKey.ed25519PublicKey,
                oldMlDsaPublicKey: key1.publicKey.mlDsaPublicKey,
                newEd25519PublicKey: other7.publicKey.ed25519PublicKey,
                newMlDsaPublicKey: other7.publicKey.mlDsaPublicKey,
                lastRosterVersion: 2,
                lastRosterDigest: await rosterDigest(succ.rosters[1]!.statement),
                signerUserId: p1.userId,
            },
            key1,
            p1.signer,
        );
        const succOther = {
            rosters: [
                succ.rosters[0]!,
                succ.rosters[1]!,
                await signRoster(succ.statements[2]!, other7, p1.signer),
            ],
            successions: [away],
        };
        return { p1, p2, p3, main, other, succ, dead, removal, removalFork, succOther };
    })();
    return built;
}

function wire(signed: SignedGroupStatement): SignedStatementWire {
    return {
        statement: encode(signed.statement),
        signature: {
            ed25519: encode(signed.signature.ed25519),
            mlDsa: encode(signed.signature.mlDsa),
        },
        signerSignature: encode(signed.signerSignature),
    };
}

function historyJson(
    firstKeys: GroupPublicKey,
    rosters: SignedGroupStatement[],
    successions: SignedGroupStatement[],
) {
    return { firstKeys, rosters: rosters.map(wire), successions: successions.map(wire) };
}

/* The code the admitting admin's screen shows for roster `version` of `h`, under key `keyVersion`. */
async function adminCode(h: History, version: number, keyVersion: number) {
    return joinCode(
        await rosterDigest(h.rosters[version - 1]!.statement),
        h.keys[keyVersion - 1]!.publicKey,
        keyVersion,
    );
}

const LEFT_OUT = 'The server left out part of the family’s member list.';
const UNSIGNED = 'This roster is not signed by the group key.';
/* What acceptance answers when nothing vouches for the served first keys. */
const UNCHECKED = 'These group keys have not been checked: compare the join code first.';

type Spec = {
    name: string;
    /* `me` as another account than the one unlocked, or without its identity open. */
    me?: 'other-account' | 'not-open';
    settings?: 'none' | 'pin-main-2' | 'not-open';
    record?: '2' | '3' | '2-other-root';
    held?: 'chain' | 'fork';
    history: 'main' | 'other' | 'succ' | 'madeUp';
    after?: number;
    through: number;
    cut?: 'beside' | 'bad-signature';
    expected: Json;
};

/* The cases, in the order both twins build them. */
async function specs(): Promise<Spec[]> {
    const f = await family();
    const code = (rosterVersion: number, words: string[]) => ({
        status: 'code',
        rosterVersion,
        code: words,
    });
    const notAdmitted = { status: 'not-admitted' };
    const fork = { status: 'fork' };
    const refused = (message: string) => ({ status: 'refused', message });
    const honest = await adminCode(f.main, 2, 1);
    const letInAgain = await adminCode(f.main, 5, 1);
    return [
        { name: 'admitted-at-roster-2', history: 'main', through: 2, expected: code(2, honest) },
        { name: 'the-head-moved-on', history: 'main', through: 3, expected: code(2, honest) },
        { name: 'not-let-in-yet', history: 'main', through: 1, expected: notAdmitted },
        { name: 'marked-left', history: 'main', through: 4, expected: notAdmitted },
        { name: 'let-in-again', history: 'main', through: 5, expected: code(5, letInAgain) },
        {
            name: 'another-admission',
            history: 'other',
            through: 2,
            expected: { ...code(2, await adminCode(f.other, 2, 1)), notCode: honest },
        },
        {
            name: 'made-up-first-keys',
            history: 'madeUp',
            through: 3,
            expected: { status: 'code', rosterVersion: 2, notCode: honest },
        },
        {
            name: 'after-a-succession',
            history: 'succ',
            through: 3,
            expected: {
                ...code(3, await adminCode(f.succ, 3, 2)),
                notCode: await adminCode(f.succ, 3, 1),
            },
        },
        {
            name: 'a-rejoin-pin-on-another-history',
            settings: 'pin-main-2',
            history: 'other',
            through: 2,
            expected: fork,
        },
        {
            name: 'a-rejoin-pin-agrees',
            settings: 'pin-main-2',
            history: 'main',
            through: 5,
            expected: code(5, letInAgain),
        },
        {
            name: 'the-record-continues',
            record: '3',
            history: 'main',
            through: 5,
            expected: code(5, letInAgain),
        },
        {
            name: 'the-record-on-another-history',
            record: '3',
            history: 'other',
            through: 3,
            expected: fork,
        },
        {
            name: 'a-record-after-a-master-key-rotation',
            record: '2-other-root',
            history: 'main',
            through: 3,
            expected: { status: 'record-unreadable' },
        },
        {
            name: 'a-roster-of-the-run-left-out',
            record: '2',
            history: 'main',
            after: 2,
            through: 3,
            expected: refused(LEFT_OUT),
        },
        {
            name: 'a-roster-beside-the-chain-is-not-read',
            cut: 'beside',
            history: 'main',
            through: 3,
            expected: code(2, honest),
        },
        {
            name: 'settings-first',
            settings: 'not-open',
            history: 'main',
            through: 2,
            expected: refused('Open your settings first.'),
        },
        {
            name: 'a-bad-group-signature',
            cut: 'bad-signature',
            history: 'main',
            through: 2,
            expected: refused(UNSIGNED),
        },
        {
            name: 'a-chain-this-session-holds-is-a-mark',
            held: 'chain',
            history: 'main',
            through: 3,
            expected: refused(UNCHECKED),
        },
        {
            name: 'a-fork-this-session-holds-is-a-mark',
            held: 'fork',
            history: 'main',
            through: 3,
            expected: refused(UNCHECKED),
        },
        // The account checked in the worker's order: another account first, then the record,
        // then the settings, then the identity.
        {
            name: 'another-account-than-the-one-unlocked',
            me: 'other-account',
            history: 'main',
            through: 2,
            expected: refused('Unlock your account first.'),
        },
        {
            name: 'an-identity-not-open',
            me: 'not-open',
            history: 'main',
            through: 2,
            expected: refused('Open your identity first.'),
        },
        {
            name: 'an-unreadable-record-before-the-identity',
            me: 'not-open',
            record: '2-other-root',
            history: 'main',
            through: 2,
            expected: { status: 'record-unreadable' },
        },
    ];
}

let id = 0;
type Session = ReturnType<typeof sessionOf>;
function call<
    K extends
        | 'groupAccept'
        | 'groupJoinPreview'
        | 'groupJoinCheck'
        | 'groupJoinFirstUse'
        | 'groupForget',
>(session: Session, operation: K, input: Json) {
    return session.handle({ id: ++id, operation, input } as GroupMessage) as Promise<
        GroupResults[K]
    >;
}

function servedInput(served: { rosters: unknown; successions: unknown }, doc: Json, name: string) {
    return {
        rosters: served.rosters,
        successions: served.successions,
        firstKeys: doc.histories[name].firstKeys,
        signerKeys: doc.signerKeys,
    } as ServedChain;
}

/* The record person 2's device keeps after accepting main's first `through` rosters, pinned at 2. */
async function recordThrough(doc: Json, through: number) {
    const f = await family();
    const session = sessionOf(f.p2, ROOT);
    session.useSettings(f.p2.userId, { groups: { [GROUP]: doc.pinMain2 as GroupPin } });
    const main = doc.histories.main;
    const result = await call(session, 'groupAccept', {
        userId: f.p2.userId,
        groupId: GROUP,
        served: servedInput(
            { rosters: main.rosters.slice(0, through), successions: [] },
            doc,
            'main',
        ),
        record: null,
        checkedAt: CHECKED,
    });
    if (result.status !== 'accepted' || !result.record)
        throw new Error('the record was not sealed');
    return result.record;
}

/*
 * Every case's name and what it declares, as previewDoc gives them: all a
 * check of the core's run against this twin's cases reads. The shared family
 * (people and histories, signed once per file by family()) is still built,
 * since the declared join codes come from it; what is skipped is the rest of
 * previewDoc, the made-up history it signs and the records it seals.
 */
export async function previewCases(): Promise<Json[]> {
    return (await specs()).map(caseJson);
}

function caseJson(spec: Spec): Json {
    return {
        name: spec.name,
        settings: spec.settings ?? 'none',
        record: spec.record ?? null,
        held: spec.held ?? null,
        served: {
            history: spec.history,
            after: spec.after ?? 0,
            through: spec.through,
            cut: spec.cut ?? null,
        },
        me: spec.me ?? null,
        expected: spec.expected,
    };
}

/* Every case and what it runs over, as this twin signed and sealed it. */
export async function previewDoc(): Promise<Json> {
    const f = await family();
    const made = await groupKeyPair(pattern(64, 150));
    const remade = await Promise.all(
        f.main.rosters.slice(0, 3).map(async (signed) => ({
            ...signed,
            signature: await signGroup(signed.statement, made),
        })),
    );
    const doc: Json = {
        histories: {
            main: historyJson(f.main.keys[0]!.publicKey, f.main.rosters, f.main.successions),
            other: historyJson(f.other.keys[0]!.publicKey, f.other.rosters, f.other.successions),
            succ: historyJson(f.succ.keys[0]!.publicKey, f.succ.rosters, f.succ.successions),
            madeUp: historyJson(made.publicKey, remade, []),
            dead: historyJson(f.dead.keys[0]!.publicKey, f.dead.rosters, f.dead.successions),
            removal: historyJson(
                f.removal.keys[0]!.publicKey,
                f.removal.rosters,
                f.removal.successions,
            ),
            removalFork: historyJson(
                f.removalFork.keys[0]!.publicKey,
                f.removalFork.rosters,
                f.removalFork.successions,
            ),
            succOther: historyJson(
                f.succ.keys[0]!.publicKey,
                f.succOther.rosters,
                f.succOther.successions,
            ),
        },
        signerKeys: mlDsaKeysOf(f.p1, f.p2, f.p3),
        pinMain2: await pinOf(f.main, 2, [f.p1, f.p2]),
    };
    const two = await recordThrough(doc, 2);
    const value = await openDeviceRecord(ROOT.slice(), f.p2.userId, GROUP, 'chains', two);
    const three = await recordThrough(doc, 3);
    // The JSON each record holds, for the fuzz seeds.
    doc.recordValues = {
        '2': value,
        '3': await openDeviceRecord(ROOT.slice(), f.p2.userId, GROUP, 'chains', three),
    };
    doc.records = {
        '2': two,
        '3': three,
        '2-other-root': await sealDeviceRecord(
            ROTATED_ROOT.slice(),
            f.p2.userId,
            GROUP,
            'chains',
            value,
        ),
    };
    doc.cases = (await specs()).map(caseJson);
    return doc;
}

/* What a case's served chain carries, from the document's histories. */
export function servedOf(doc: Json, served: Json): ServedChain {
    const chain = doc.histories[served.history];
    const rosters = (chain.rosters as SignedStatementWire[]).slice(served.after, served.through);
    if (served.cut === 'beside')
        // Another roster 2, served right after the chain's own.
        rosters.splice(2 - served.after, 0, doc.histories.dead.rosters[1]);
    else if (served.cut === 'bad-signature') {
        // The last roster's group signature, zeroed.
        const last = rosters.at(-1)!;
        rosters[rosters.length - 1] = {
            ...last,
            signature: { ...last.signature, ed25519: encode(new Uint8Array(64)) },
        };
    } else if (served.cut !== null) throw new Error(`a cut ${served.cut}`);
    return {
        rosters,
        successions: chain.successions,
        firstKeys: chain.firstKeys,
        signerKeys: doc.signerKeys,
    };
}

function settingsOf(session: Session, doc: Json, which: string, userId: string) {
    if (which === 'not-open') return;
    if (which === 'none') session.useSettings(userId, { groups: {} });
    // A family check record with no code (the migration's `before`, a mark but no pair mark), or
    // one that is no pair mark at all.
    else if (which === 'checked-before')
        session.useSettings(userId, {
            groups: {},
            familyChecks: { [GROUP]: { how: 'before', rosterVersion: 2 } },
        });
    else if (which === 'checked-malformed')
        session.useSettings(userId, {
            groups: {},
            familyChecks: { [GROUP]: { rosterVersion: 2, with: 'someone', code: 'words' } },
        });
    else if (which === 'pin-main-2')
        session.useSettings(userId, { groups: { [GROUP]: doc.pinMain2 as GroupPin } });
    else throw new Error(`settings ${which}`);
}

/* The draws both twins' fixture ledgers take for hidden positions: the same list, from the start, on every session. */
export const draws = () =>
    Array.from({ length: 256 }, (_, at) => {
        // The second draw repeats the first, so a showing draws its second position anew.
        const i = at === 1 ? 0 : at;
        return i % 7 === 3 ? 0xffff_ffff : (i * 2_654_435_761 + 12_345) % 2 ** 32;
    });

/* A group session of person `who`'s, unlocked under `root`, drawing positions from draws(); `as` the identity it opened. */
export function drawnSessionOf(who: Person, root: Uint8Array, as: Person = who) {
    const queue = draws();
    const host = {
        unlocked: () => ({ userId: who.userId, root: root.slice(), keyVersion: 1 }),
        identity: () => ({ userId: as.userId, served: as.served, history: [] }),
        ledger: createAreaLedger(),
        randomUint32: () => {
            const next = queue.shift();
            if (next === undefined) throw new Error('the injected draws ran out');
            return next;
        },
    } as unknown as GroupHost;
    return Object.assign(createGroupSession(host), { ledger: host.ledger });
}

function previewJson(result: GroupResults['groupJoinPreview']): Json {
    if (result.status === 'code')
        return {
            status: 'code',
            rosterVersion: result.rosterVersion,
            code: result.code,
            hidden: result.hidden,
        };
    if (result.status === 'fork') {
        const { of, version, sides } = result.fork;
        return { status: 'fork', of, version, sides };
    }
    return { status: result.status };
}

/* One case through the worker, on `doc`'s histories and records: the outcome as both twins write it. */
export async function runPreview(doc: Json, c: Json): Promise<Json> {
    const f = await family();
    const session = drawnSessionOf(f.p2, ROOT, c.me === 'not-open' ? f.p1 : f.p2);
    if (c.held) {
        settingsOf(session, doc, 'pin-main-2', f.p2.userId);
        const name = c.held === 'chain' ? 'main' : 'other';
        const held = await call(session, 'groupAccept', {
            userId: f.p2.userId,
            groupId: GROUP,
            served: servedOf(doc, { history: name, after: 0, through: 2, cut: null }),
            record: null,
            checkedAt: CHECKED,
        });
        if (held.status !== (c.held === 'chain' ? 'accepted' : 'fork'))
            throw new Error(`${c.name}: the held ${c.held} was not reached`);
    }
    settingsOf(session, doc, c.settings, f.p2.userId);
    try {
        const result = await call(session, 'groupJoinPreview', {
            userId: c.me === 'other-account' ? f.p1.userId : f.p2.userId,
            groupId: GROUP,
            served: servedOf(doc, c.served),
            record: c.record === null ? null : doc.records[c.record],
        });
        return previewJson(result);
    } catch (error) {
        if (!(error instanceof CryptoError)) throw error;
        return { status: 'refused', message: error.message };
    }
}

/* Whether an outcome is what its case declares. */
export function previewSays(outcome: Json, expected: Json) {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const field = (key: string) => !(key in expected) || same(outcome[key], expected[key]);
    return (
        outcome.status === expected.status &&
        field('rosterVersion') &&
        field('code') &&
        field('message') &&
        (!('notCode' in expected) || !same(outcome.code, expected.notCode))
    );
}

/* Join checks -------------------------------------------------------------- */

export type CheckFile = {
    code: string[];
    cases: {
        name: string;
        code?: string[];
        hidden: number[];
        typed: string[];
        expected: unknown;
    }[];
};

/* One shared case through joinCheck: 'match', 'no-match', 'incomplete' or {refused: message}. */
export function runCheck(file: CheckFile, c: CheckFile['cases'][number]) {
    try {
        return joinCheck(c.code ?? file.code, c.hidden, c.typed);
    } catch (error) {
        if (!(error instanceof CryptoError)) throw error;
        return { refused: error.message };
    }
}

/* Consents ----------------------------------------------------------------- */

export const CONSENT_USER = '00000007-abcd-4abc-8abc-abcdefabcdef';
export const CONSENT_ROOT = pattern(32, 120);
const OTHER_ROOT = pattern(32, 121);

/* The link the server serves for a succession from `old` to `next`, with `signature` and `consent`. */
export function linkBetween(
    old: IdentityEnvelope,
    next: IdentityEnvelope,
    signature: string,
    consent: string | null,
): SuccessionLink {
    return {
        oldKeyVersion: old.keyVersion,
        newKeyVersion: next.keyVersion,
        oldEncryptionPublicKey: old.encryptionPublicKey,
        oldSigningPublicKey: old.signingPublicKey,
        oldMlDsaPublicKey: old.mlDsa?.publicKey ?? '',
        newEncryptionPublicKey: next.encryptionPublicKey,
        newSigningPublicKey: next.signingPublicKey,
        newMlDsaPublicKey: next.mlDsa?.publicKey ?? '',
        newKemPublicKey: next.kem?.publicKey ?? '',
        signature,
        consent,
    };
}

const UPGRADED = 'Only a link between two upgraded identities takes consent.';
const NOT_OWN = 'This identity does not open on this account.';
const APART = 'These are not two identities this device opened one after the other.';

/* The due and sign cases, in the order both twins build them. */
const DUE = [
    {
        name: 'only-links-without-consent',
        links: ['ab', 'bcConsented'],
        identities: ['a', 'b', 'c'],
        expected: [{ oldKeyVersion: 1, old: 0, next: 1 }],
    },
    {
        name: 'empty-consent-is-none',
        links: ['abEmpty'],
        identities: ['a', 'b', 'c'],
        expected: [{ oldKeyVersion: 1, old: 0, next: 1 }],
    },
    {
        name: 'a-version-1-identity-is-never-offered',
        links: ['ab', 'bc'],
        identities: ['aLegacy', 'b', 'c'],
        expected: [{ oldKeyVersion: 2, old: 1, next: 2 }],
    },
    {
        name: 'a-version-1-claim-beside-an-ml-dsa-key',
        links: ['ab'],
        identities: ['aClaimsV1', 'b'],
        expected: [],
    },
    {
        name: 'keys-that-are-not-the-account-s',
        links: ['abKem'],
        identities: ['a', 'b', 'c'],
        expected: [],
    },
    {
        name: 'an-identity-at-another-key-version',
        links: ['ab'],
        identities: ['aMoved', 'b'],
        expected: [],
    },
    {
        name: 'the-next-identity-at-another-key-version',
        links: ['ab'],
        identities: ['a', 'bMoved'],
        expected: [],
    },
    {
        name: 'an-identity-the-account-does-not-have',
        links: ['ab'],
        identities: ['a', 'c'],
        expected: [],
    },
    {
        name: 'the-first-copy-is-offered',
        links: ['ab'],
        identities: ['bTampered', 'b', 'a'],
        expected: [{ oldKeyVersion: 1, old: 2, next: 0 }],
    },
];

const NOT_LINK = 'This link is not one this account made.';
const ALL = ['a', 'b', 'c'];
const sign = (
    name: string,
    old: string,
    next: string,
    link: string,
    me: string[],
    expected: Json,
) => ({
    name,
    old,
    next,
    link,
    me,
    expected,
});
const SIGNED = { status: 'signed' };
const refusedWith = (message: string) => ({ status: 'refused', message });
const SIGNS: Json[] = [
    sign('one-step', 'a', 'b', 'ab', ALL, SIGNED),
    sign('the-next-step-listed-in-any-order', 'b', 'c', 'bc', ['c', 'a', 'b'], SIGNED),
    sign('a-version-1-identity', 'aLegacy', 'b', 'ab', ALL, refusedWith(UPGRADED)),
    sign('backwards', 'b', 'a', 'ab', ALL, refusedWith(UPGRADED)),
    sign('another-account-root', 'a', 'bOtherRoot', 'ab', ALL, refusedWith(NOT_OWN)),
    sign('a-keys-statement-that-does-not-hold', 'a', 'bTampered', 'ab', ALL, refusedWith(NOT_OWN)),
    sign('a-link-naming-other-keys', 'a', 'b', 'bc', ALL, refusedWith(NOT_LINK)),
    sign('a-made-up-link-past-an-identity', 'a', 'c', 'acServed', ALL, refusedWith(NOT_LINK)),
    sign(
        'leaving-b-out-makes-no-made-up-link-a-step',
        'a',
        'c',
        'acServed',
        ['a', 'c'],
        refusedWith(NOT_LINK),
    ),
    sign('a-link-the-account-signed-that-skips-one', 'a', 'c', 'acSigned', ALL, refusedWith(APART)),
    sign(
        'a-link-naming-other-old-keys',
        'a',
        'c',
        'bcSignedByA',
        ['a', 'c'],
        refusedWith(NOT_LINK),
    ),
    // A genuine link to b, offered for a and c with b left out: the link names other keys.
    sign(
        'a-genuine-link-offered-for-another-step',
        'a',
        'c',
        'ab',
        ['a', 'c'],
        refusedWith(NOT_LINK),
    ),
    sign('the-app-left-one-out', 'a', 'b', 'ab', ['a', 'c'], refusedWith(APART)),
    {
        ...sign('another-account', 'a', 'b', 'ab', ALL, refusedWith('Unlock your account first.')),
        meUser: '00000009-abcd-4abc-8abc-abcdefabcdef',
    },
];

async function successor(root: Uint8Array<ArrayBuffer>, current: IdentityEnvelope) {
    const signingKey = await openIdentitySigningKey(root, CONSENT_USER, current);
    const mlDsa = (await openIdentityMlDsaKey(root, CONSENT_USER, current))!;
    try {
        return await createSuccessor(root, CONSENT_USER, current, {
            signingKey,
            mlDsaSecretKey: mlDsa.secretKey,
        });
    } finally {
        signingKey.fill(0);
        mlDsa.secretKey.fill(0);
    }
}

/* The account's identities and links as this twin makes them (fresh keys every run), and the cases. */
export async function consentDoc(): Promise<Json> {
    const root = CONSENT_ROOT.slice();
    const a = await createIdentity(root, CONSENT_USER, 1);
    const b = await successor(root, a);
    const c = await successor(root, b.identity);
    const signature = decode(b.identity.keysSignature!);
    signature[100]! ^= 1;
    const legacy = { ...a, version: 1, mlDsa: undefined, keysSignature: undefined };
    const ab = linkBetween(a, b.identity, b.signature, null);
    const bc = linkBetween(b.identity, c.identity, c.signature, null);
    // a → c: as a server could make it up (b → c's signature, not a's), and as a itself signed it.
    const acServed = linkBetween(a, c.identity, c.signature, null);
    const aKeys = {
        signingKey: await openIdentitySigningKey(root, CONSENT_USER, a),
        mlDsaSecretKey: (await openIdentityMlDsaKey(root, CONSENT_USER, a))!.secretKey,
    };
    const { signature: _, consent: __, ...acFields } = acServed;
    const acSigned = {
        ...acServed,
        signature: encode(
            await signHybrid(
                await successionStatement({ ...acFields, userId: CONSENT_USER }),
                aKeys,
            ),
        ),
    };
    // b → c's statement, signed by a: a link that verifies under a's keys but names other old keys.
    const { signature: ___, consent: ____, ...bcFields } = bc;
    const bcSignedByA = {
        ...bc,
        signature: encode(
            await signHybrid(
                await successionStatement({ ...bcFields, userId: CONSENT_USER }),
                aKeys,
            ),
        ),
    };
    aKeys.signingKey.fill(0);
    aKeys.mlDsaSecretKey.fill(0);
    return JSON.parse(
        JSON.stringify({
            userId: CONSENT_USER,
            root: encode(CONSENT_ROOT),
            identities: {
                a,
                b: b.identity,
                c: c.identity,
                aLegacy: legacy,
                aClaimsV1: { ...a, version: 1 },
                aMoved: { ...a, keyVersion: 7 },
                bMoved: { ...b.identity, keyVersion: 7 },
                bOtherRoot: await createIdentity(OTHER_ROOT.slice(), CONSENT_USER, 2),
                bTampered: { ...b.identity, keysSignature: encode(signature) },
            },
            links: {
                ab,
                bc,
                bcConsented: { ...bc, consent: c.consent },
                abEmpty: { ...ab, consent: '' },
                abKem: { ...ab, newKemPublicKey: c.identity.kem.publicKey },
                acServed,
                acSigned,
                bcSignedByA,
            },
            due: DUE,
            signs: SIGNS,
        }),
    );
}

/* A due case through linksNeedingConsent: each offered link's old key version and its two identities' places. */
export function runDue(doc: Json, c: Json) {
    const identities = (c.identities as string[]).map(
        (name) => doc.identities[name] as IdentityEnvelope,
    );
    const links = (c.links as string[]).map((name) => doc.links[name] as SuccessionLink);
    return linksNeedingConsent(links, identities).map((due) => ({
        oldKeyVersion: due.link.oldKeyVersion,
        old: identities.indexOf(due.old),
        next: identities.indexOf(due.next),
    }));
}

/* The worker's identityConsent for `doc`'s account, holding the identities `me` names (the first opened, the rest its history). */
function consentSession(doc: Json, me: string[]) {
    const keys = me.map((name) => {
        const { keysSignature: _, ...served } = publicIdentity(doc.identities[name]);
        return served as ServedKeys;
    });
    const host = {
        unlocked: () => ({ userId: doc.userId, root: decode(doc.root), keyVersion: 1 }),
        identity: () => ({ userId: doc.userId, served: keys[0], history: keys.slice(1) }),
        ledger: createAreaLedger(),
    } as unknown as GroupHost;
    return createGroupSession(host);
}

/* A sign case through the worker's identityConsent: signed with the consent, or refused with the message. */
export async function runSign(doc: Json, c: Json): Promise<Json> {
    const session = consentSession(doc, c.me);
    try {
        const { consent } = (await session.handle({
            id: ++id,
            operation: 'identityConsent',
            input: {
                userId: c.meUser ?? doc.userId,
                link: doc.links[c.link],
                old: doc.identities[c.old],
                next: doc.identities[c.next],
            },
        } as GroupMessage)) as GroupResults['identityConsent'];
        return { status: 'signed', consent };
    } catch (error) {
        if (!(error instanceof CryptoError)) throw error;
        return { status: 'refused', message: error.message };
    }
}

/* Whether a sign outcome is what its case declares (or what the other twin reached): the consent itself differs per run. */
export function signSays(outcome: Json, expected: Json) {
    return (
        outcome.status === expected.status &&
        (!('message' in expected) || outcome.message === expected.message)
    );
}

/* Whether a signed case's consent holds for the link between its two identities, here. */
export function consentHolds(doc: Json, c: Json, consent: string) {
    return verifySuccessionConsent(
        doc.userId,
        linkBetween(doc.identities[c.old], doc.identities[c.next], '', consent),
    );
}

/* Join sessions ------------------------------------------------------------ */

export const SESSION_NOW = '2026-10-18T12:00:00.000Z';

/* A served chain of the preview document's histories: `{history, through, cut}`, from version 1. */
const sessionServed = (doc: Json, served: Json) =>
    servedOf(doc, { after: 0, cut: null, ...served });

/* The words a step types for a showing: as read out, one of them misheard, or one blank. */
function typedFor(code: string[], hidden: number[], words: string) {
    const right = hidden.map((at) => code[at]!);
    const other = (word: string) => (word === 'abandon' ? 'ability' : 'abandon');
    if (words === 'right') return right;
    if (words === 'misheard') return [right[0]!, other(right[1]!)];
    if (words === 'blank') return [right[0]!, ' '];
    throw new Error(`words ${words}`);
}

/*
 * A joins record no match of this account's sealed: an app's (the outbox
 * store), another family's, the data layer's version 2, a version this release
 * does not know (5); or `value`, any JSON sealed as this account's joins record
 * of the family (the fuzz kind joins_record).
 */
export async function forgedRecord(kind: string, value?: unknown) {
    const f = await family();
    if (kind === 'value') return sealDeviceRecord(ROOT.slice(), f.p2.userId, GROUP, 'joins', value);
    const mark = { rosterVersion: 2, code: await adminCode(f.main, 2, 1) };
    const record = (groupId: string, v: number) => ({
        v,
        groupId,
        joinMark: mark,
        checkedAt: SESSION_NOW,
    });
    const at: Record<string, [string, string, unknown]> = {
        outbox: ['outbox', GROUP, record(GROUP, 3)],
        'other-family': ['joins', OTHER_GROUP, record(OTHER_GROUP, 3)],
        // The data layer's version 2 (before the escalation moved here): one compare again.
        'earlier-version': ['joins', GROUP, record(GROUP, 2)],
        'newer-version': ['joins', GROUP, record(GROUP, 5)],
    };
    const [store, groupId, forged] = at[kind]!;
    return sealDeviceRecord(ROOT.slice(), f.p2.userId, groupId, store as 'outbox', forged);
}

/* What a refusal reads as, or an overtaken run. */
function refusal(error: unknown): Json {
    if (!(error instanceof CryptoError)) throw error;
    if (lostRace(error)) return { status: 'overtaken', split: error.message === SPLIT_CHAIN };
    return { status: 'refused', message: error.message };
}

function acceptanceJson(result: GroupResults['groupAccept']): Json {
    if (result.status === 'accepted')
        return {
            status: 'accepted',
            rosterVersion: result.view.rosterVersion,
            checkedAt: result.pin!.checkedAt,
            checked: result.checked ?? null,
            guard: guardJson(result.guard),
        };
    if (result.status === 'fork') {
        const { of, version, sides } = result.fork;
        return { status: 'fork', of, version, sides };
    }
    if (result.status === 'changed')
        return {
            status: 'changed',
            rosterVersion: result.rosterVersion,
            code: result.code,
            hidden: result.hidden,
        };
    return { status: result.status };
}

/*
 * The family guard a step names (docs/optional-verification.md 2.8): none, the pin at main's
 * roster 2, unreadable, or the one this device holds (`held`: the latest an acceptance returned,
 * as the app stores it before the record).
 */
function guardOf(doc: Json, which: unknown, held: GroupPin | null): GroupPin | 'unreadable' | null {
    if (which === undefined || which === 'none') return null;
    if (which === 'pin-main-2') return doc.pinMain2 as GroupPin;
    if (which === 'unreadable') return 'unreadable';
    if (which === 'held') return held;
    throw new Error(`a guard ${JSON.stringify(which)}`);
}

/* A guard as both twins write it in an outcome: where it stands, or null when none was returned. */
function guardJson(guard: GroupPin | null | undefined): Json | null {
    return guard
        ? { rosterVersion: guard.rosterVersion, keyVersion: guard.keyVersion, areas: guard.areas }
        : null;
}

/* A first use's outcome as both twins write it, with its record's check time. */
async function firstUseJson(
    result: GroupResults['groupJoinFirstUse'],
    userId: string,
): Promise<Json> {
    if (result.status === 'first-use') {
        const value = (await openDeviceRecord(
            ROOT.slice(),
            userId,
            GROUP,
            'joins',
            result.joinsRecord,
        )) as { firstUse: { checkedAt: string } };
        return {
            status: 'first-use',
            rosterVersion: result.rosterVersion,
            checkedAt: value.firstUse.checkedAt,
        };
    }
    if (result.status === 'fork') {
        const { of, version, sides } = result.fork;
        return { status: 'fork', of, version, sides };
    }
    return { status: result.status };
}

/* Person 2's drawn session with the scenario's settings. */
async function sessionFor(doc: Json, settings: string) {
    const f = await family();
    const session = drawnSessionOf(f.p2, ROOT);
    settingsOf(session, doc, settings, f.p2.userId);
    return session;
}

/* A check's outcome as both twins write it: the escalation's presence (its sealed bytes differ per run). */
function checkJson(result: GroupResults['groupJoinCheck']): Json {
    if (
        result.status === 'matched' ||
        result.status === 'wrong-words' ||
        result.status === 'mismatch'
    )
        return { status: result.status, kept: result.holds !== null };
    if (result.status === 'changed')
        return {
            status: 'changed',
            rosterVersion: result.rosterVersion,
            code: result.code,
            hidden: result.hidden,
        };
    if (result.status === 'fork') {
        const { of, version, sides } = result.fork;
        return { status: 'fork', of, version, sides };
    }
    return { status: result.status };
}

type Showing = { rosterVersion: number; code: string[]; hidden: [number, number]; session: number };

export type SessionRun = { outcomes: Json[]; records: Map<number, string>; holds: string | null };

const SKIPPED = 'skipped';

/*
 * One scenario through the worker, step by step, as the web drives it: it
 * keeps the escalation each check hands back (`kept`, and what it was after
 * each step), restores it once after a lock or a relaunch (or an older one,
 * with `restore`), on the next showing or check. A lock keeps the showings on
 * screen (checked, they are refused); a relaunch loses them. A match is
 * always joined from its joins record. A step naming a showing or a match no
 * earlier step made (or one a relaunch lost) is "skipped", in both twins (the
 * fuzz kind's ops). Each step's outcome as both twins write it.
 */
export async function runSession(doc: Json, scenario: Json): Promise<SessionRun> {
    const f = await family();
    const userId = f.p2.userId;
    let session = await sessionFor(doc, scenario.settings);
    const outcomes: Json[] = [];
    const showings = new Map<number, Showing>();
    const records = new Map<number, string>();
    let kept: string | null = null;
    const keptAfter: (string | null)[] = [];
    let pending: string | null = null;
    // The family guard this device holds: the latest an acceptance returned, never cleared.
    let guard: GroupPin | null = null;
    const keep = (result: GroupResults['groupAccept']) => {
        if (result.status === 'accepted' && result.guard) guard = result.guard;
    };
    const take = () => {
        const holds = pending;
        pending = null;
        return holds;
    };
    for (const [at, step] of (scenario.steps as Json[]).entries()) {
        let outcome: Json;
        switch (step.op) {
            case 'show': {
                try {
                    const result = await call(session, 'groupJoinPreview', {
                        userId,
                        groupId: GROUP,
                        served: sessionServed(doc, step.served),
                        record: null,
                        holds: take(),
                    });
                    if (result.status === 'code') showings.set(at, result);
                    outcome = previewJson(result);
                } catch (error) {
                    outcome = refusal(error);
                }
                break;
            }
            case 'check': {
                let shown: Showing | undefined;
                if (step.session === 'elsewhere') {
                    const other = await sessionFor(doc, scenario.settings);
                    const result = await call(other, 'groupJoinPreview', {
                        userId,
                        groupId: GROUP,
                        served: sessionServed(doc, { history: 'main', through: 2 }),
                        record: null,
                    });
                    if (result.status !== 'code') throw new Error('a code elsewhere');
                    shown = result;
                } else if (typeof step.session === 'number') shown = showings.get(step.session);
                if (!shown) {
                    outcome = { status: SKIPPED };
                    break;
                }
                try {
                    const result = await call(session, 'groupJoinCheck', {
                        userId,
                        groupId: GROUP,
                        served: sessionServed(doc, step.served),
                        record: null,
                        mark: { rosterVersion: shown.rosterVersion, code: shown.code },
                        hidden: shown.hidden,
                        session: shown.session,
                        typed: typedFor(shown.code, shown.hidden, step.words),
                        now: SESSION_NOW,
                        holds: take(),
                    });
                    outcome = checkJson(result);
                    if (
                        result.status === 'matched' ||
                        result.status === 'wrong-words' ||
                        result.status === 'mismatch'
                    )
                        kept = result.holds;
                    if (result.status === 'matched') {
                        records.set(at, result.joinsRecord);
                        // The joins record's check time, read as only the fixtures can.
                        const value = (await openDeviceRecord(
                            ROOT.slice(),
                            userId,
                            GROUP,
                            'joins',
                            result.joinsRecord,
                        )) as { checkedAt: string };
                        outcome.checkedAt = value.checkedAt;
                    } else if (result.status === 'changed') showings.set(at, result);
                } catch (error) {
                    outcome = refusal(error);
                }
                break;
            }
            case 'first-use': {
                try {
                    const result = await call(session, 'groupJoinFirstUse', {
                        userId,
                        groupId: GROUP,
                        served: sessionServed(doc, step.served),
                        record: null,
                        guard: guardOf(doc, step.guard, guard),
                        now: SESSION_NOW,
                    });
                    if (result.status === 'first-use') records.set(at, result.joinsRecord);
                    outcome = await firstUseJson(result, userId);
                } catch (error) {
                    outcome = refusal(error);
                }
                break;
            }
            case 'accept': {
                const joinsRecord =
                    typeof step.matched === 'number'
                        ? records.get(step.matched)
                        : typeof step.record !== 'string'
                          ? undefined
                          : step.record.startsWith('own:')
                            ? records.get(Number(step.record.slice(4)))
                            : await forgedRecord(step.record, step.value);
                if (joinsRecord === undefined) {
                    outcome = { status: SKIPPED };
                    break;
                }
                try {
                    const result = await call(session, 'groupAccept', {
                        userId,
                        groupId: GROUP,
                        served: sessionServed(doc, step.served),
                        record: null,
                        checkedAt: SESSION_NOW,
                        joining: { joinsRecord },
                        guard: guardOf(doc, step.guard, guard),
                    });
                    keep(result);
                    if (result.status === 'changed') showings.set(at, result);
                    outcome = acceptanceJson(result);
                } catch (error) {
                    outcome = refusal(error);
                }
                break;
            }
            case 'sync': {
                try {
                    const result = await call(session, 'groupAccept', {
                        userId,
                        groupId: GROUP,
                        served: sessionServed(doc, step.served),
                        record: null,
                        checkedAt: SESSION_NOW,
                        guard: guardOf(doc, step.guard, guard),
                    });
                    keep(result);
                    outcome =
                        result.status === 'accepted'
                            ? {
                                  status: 'accepted',
                                  rosterVersion: result.view.rosterVersion,
                                  guard: guardJson(result.guard),
                              }
                            : result.status === 'fork'
                              ? { status: 'fork', of: result.fork.of, version: result.fork.version }
                              : { status: 'not-accepted' };
                } catch (error) {
                    outcome = refusal(error);
                }
                break;
            }
            case 'holds':
                outcome = { status: kept !== null ? 'kept' : 'none' };
                break;
            case 'guard':
                outcome = guard ? { status: 'held', ...guardJson(guard) } : { status: 'none' };
                break;
            case 'relaunch':
            case 'lock': {
                if (step.op === 'relaunch') {
                    session = await sessionFor(doc, scenario.settings);
                    showings.clear();
                } else {
                    session.forget();
                    settingsOf(session, doc, scenario.settings, userId);
                }
                pending = step.restore === true ? kept : null;
                outcome = { status: step.op === 'relaunch' ? 'relaunched' : 'locked' };
                break;
            }
            case 'restore': {
                const older = typeof step.from === 'number' ? keptAfter[step.from] : undefined;
                if (older === undefined) outcome = { status: SKIPPED };
                else {
                    pending = older;
                    outcome = { status: 'restoring' };
                }
                break;
            }
            case 'forget': {
                await call(session, 'groupForget', { groupId: GROUP });
                outcome = { status: 'forgotten' };
                break;
            }
            default:
                throw new Error(`an op ${step.op}`);
        }
        outcomes.push(outcome);
        keptAfter.push(kept);
    }
    return { outcomes, records, holds: kept };
}

/* Whether a step's outcome is what it declares (`hiddenOf`: the same positions as that step's showing). */
export function stepSays(outcomes: Json[], at: number, expected: Json) {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    return Object.entries(expected).every(([key, want]) =>
        key === 'hiddenOf'
            ? same(outcomes[at]!.hidden, outcomes[want as number]!.hidden)
            : key === 'notHiddenOf'
              ? !same(outcomes[at]!.hidden, outcomes[want as number]!.hidden)
              : same(outcomes[at]![key], want),
    );
}

/* Every scenario run here, each step checked against its declaration, with what the other twin opens. */
export async function sessionFixture(doc: Json, file: Json) {
    const runs = [];
    const cross: Json = {};
    for (const scenario of file.scenarios as Json[]) {
        const run = await runSession(doc, scenario);
        for (const [at, step] of (scenario.steps as Json[]).entries())
            if (!stepSays(run.outcomes, at, step.expect))
                throw new Error(`${scenario.name} step ${at}: ${JSON.stringify(run.outcomes[at])}`);
        if (scenario.name === 'a-match-joins-once') cross.joinsRecord = run.records.get(1);
        if (scenario.name === 'a-first-use-joins-once') cross.firstUseRecord = run.records.get(0);
        if (scenario.name === 'the-escalation-kept-across-a-relaunch') {
            cross.holds = run.holds;
            cross.heldHidden = run.outcomes[0]!.hidden;
        }
        runs.push({ name: scenario.name, outcomes: run.outcomes });
    }
    return { runs, cross };
}

/* The other twin's sealed records opened here: its joins record joins a fresh session of person 2's, and its kept escalation holds what it held. */
export async function openCross(doc: Json, cross: Json) {
    const f = await family();
    const userId = f.p2.userId;
    const session = await sessionFor(doc, 'none');
    const joined = acceptanceJson(
        await call(session, 'groupAccept', {
            userId,
            groupId: GROUP,
            served: sessionServed(doc, { history: 'main', through: 3 }),
            record: null,
            checkedAt: SESSION_NOW,
            joining: { joinsRecord: cross.joinsRecord },
        }),
    );
    // The other twin's first use: its record finishes the join here, against the roster it took.
    const firstUse = await sessionFor(doc, 'none');
    const firstJoined = acceptanceJson(
        await call(firstUse, 'groupAccept', {
            userId,
            groupId: GROUP,
            served: sessionServed(doc, { history: 'main', through: 2 }),
            record: null,
            checkedAt: SESSION_NOW,
            joining: { joinsRecord: cross.firstUseRecord },
        }),
    );
    const relaunched = await sessionFor(doc, 'none');
    const shown = await call(relaunched, 'groupJoinPreview', {
        userId,
        groupId: GROUP,
        served: sessionServed(doc, { history: 'main', through: 2 }),
        record: null,
        holds: cross.holds,
    });
    return { joined, firstJoined, hidden: shown.status === 'code' ? shown.hidden : null };
}

/*
 * A preview case, then (with `words`) "They match" on the same served chain
 * and record, then (with `join`) the join: what the fuzz kind `join_preview`
 * compares, so a served chain and record reach the check and the join too.
 */
export async function runPreviewFlow(doc: Json, c: Json): Promise<Json> {
    const f = await family();
    const userId = f.p2.userId;
    const session = drawnSessionOf(f.p2, ROOT);
    settingsOf(session, doc, c.settings, userId);
    const record = c.record === null || c.record === undefined ? null : doc.records[c.record];
    const served = servedOf(doc, c.served);
    let preview;
    try {
        preview = await call(session, 'groupJoinPreview', {
            userId,
            groupId: GROUP,
            served,
            record,
        });
    } catch (error) {
        return { preview: refusal(error) };
    }
    const out: Json = { preview: previewJson(preview) };
    if (typeof c.words !== 'string' || preview.status !== 'code') return out;
    let check;
    try {
        check = await call(session, 'groupJoinCheck', {
            userId,
            groupId: GROUP,
            served,
            record,
            mark: { rosterVersion: preview.rosterVersion, code: preview.code },
            hidden: preview.hidden,
            session: preview.session,
            typed: typedFor(preview.code, preview.hidden, c.words),
            now: SESSION_NOW,
        });
    } catch (error) {
        out.check = refusal(error);
        return out;
    }
    out.check = checkJson(check);
    if (c.join !== true || check.status !== 'matched') return out;
    try {
        out.join = acceptanceJson(
            await call(session, 'groupAccept', {
                userId,
                groupId: GROUP,
                served,
                record,
                checkedAt: SESSION_NOW,
                joining: { joinsRecord: check.joinsRecord },
            }),
        );
    } catch (error) {
        out.join = refusal(error);
    }
    return out;
}
