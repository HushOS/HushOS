import { createAreaLedger } from './area-ledger';
import { CryptoError } from './errors';
import {
    CHECKED,
    GROUP,
    OTHER_GROUP,
    history,
    mlDsaKeysOf,
    pattern,
    person,
    pinOf,
    type History,
    type Person,
} from './group-testkit';
import type { GroupPublicKey, SignedGroupStatement } from './groups';
import { decode, encode } from './keys';
import { mergePin, pinAhead, type GroupPin, type OpenedArea } from './pins';
import { SPLIT_CHAIN } from './protocol';
import { acceptFromRecord, lostRace } from './record-acceptance';
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
 * The device record and the settings pin, for the shared fixtures
 * (scripts/area-ledger-fixtures.ts writes what the web sealed and decided,
 * area-ledger-fixtures.test.ts reads what the core did). The twin is
 * crates/hushos-core/tests/common/device_records.rs: both build the same cases
 * in the same order from the same people (group-testkit.ts's person 1 reads,
 * person 2 is the other member), seal each case's chain record with their own
 * acceptance (the worker's groupAccept; the core's AreaLedger::accept_served)
 * and change it as the case says, and run the other twin's records and served
 * chains through their own order (record-acceptance.ts driving groupAccept;
 * accept_served, following FetchFromVersionOne) to the declared outcome.
 *
 * The family: person 1 holds members, person 2's roles change at each of
 * three rosters (format 2); two branches of it, one with another roster 3,
 * one with another roster 2 (and so another roster 3 after it).
 */

export const ROOT = pattern(32, 90);
/* The same account's root after a master-key rotation. */
export const ROTATED_ROOT = pattern(32, 91);

type Json = Record<string, unknown>;
/* Every outcome says whether the run asked route 5 for version 1 after starting from a record. */
export type Outcome = { fromVersionOne: boolean } & (
    | { status: 'accepted'; rosterVersion: number; pin: GroupPin }
    | { status: 'fork'; of: string; version: number; sides: unknown[] }
    | { status: 'record-unreadable' }
    | { status: 'overtaken'; split: boolean }
    | { status: 'refused'; message: string }
);
type Declared =
    | { status: 'accepted'; rosterVersion: number; fromVersionOne?: boolean }
    | { status: 'fork'; version: number }
    | { status: 'record-unreadable' }
    | { status: 'overtaken'; split: boolean }
    | { status: 'refused' };

/* How a case changes the record its twin's acceptance sealed. */
type Change =
    | 'other-root'
    | 'other-account'
    | 'other-family'
    | 'newer-record'
    | 'newer-cache'
    | 'damaged-cache'
    | 'headless-cache'
    | 'damaged-pin'
    | 'newer-cache-no-pin';
type Branch = 'at-3' | 'at-2';
type Served = { after: number; through: number; branch?: Branch; badSignature?: boolean };
type Spec = {
    name: string;
    /* The record: none, or the one accepted through roster 2 or 3, changed as `change` says. */
    record: null | 2 | 3;
    change?: Change;
    /*
     * The settings pin: none, at roster 1 (older settings), at roster 3, at the branch's roster 3,
     * or a version 1 document (which opens nowhere and sets nothing).
     */
    settings: null | 1 | 3 | 'branch-3' | 'legacy';
    /* The chain the session committed first (through this roster, against the settings pin at 1). */
    held?: number;
    start: number;
    served: Served[];
    expected: Declared;
};

const accepted = (rosterVersion: number, fromVersionOne?: boolean): Declared =>
    fromVersionOne === undefined
        ? { status: 'accepted', rosterVersion }
        : { status: 'accepted', rosterVersion, fromVersionOne };
const refused: Declared = { status: 'refused' };
const unreadable: Declared = { status: 'record-unreadable' };
const older: Declared = { status: 'overtaken', split: false };

/* The cases, in the order both twins build them. */
export const SPECS: Spec[] = [
    {
        name: 'continues-the-cache',
        record: 2,
        settings: null,
        start: 2,
        served: [{ after: 2, through: 3 }],
        expected: accepted(3, false),
    },
    {
        name: 'continuation-refused-then-from-version-1',
        record: 2,
        settings: null,
        start: 2,
        served: [
            { after: 2, through: 3, badSignature: true },
            { after: 0, through: 3 },
        ],
        expected: accepted(3, true),
    },
    {
        name: 'record-after-a-master-key-rotation',
        record: 2,
        change: 'other-root',
        settings: 1,
        start: 2,
        served: [{ after: 2, through: 3 }],
        expected: unreadable,
    },
    {
        name: 'record-of-another-account',
        record: 2,
        change: 'other-account',
        settings: 1,
        start: 2,
        served: [{ after: 2, through: 3 }],
        expected: unreadable,
    },
    {
        name: 'record-of-another-family',
        record: 2,
        change: 'other-family',
        settings: 1,
        start: 2,
        served: [{ after: 2, through: 3 }],
        expected: unreadable,
    },
    {
        name: 'record-of-a-newer-release',
        record: 2,
        change: 'newer-record',
        settings: 1,
        start: 2,
        served: [{ after: 2, through: 3 }],
        expected: unreadable,
    },
    {
        name: 'newer-cache-from-version-1-without-it',
        record: 3,
        change: 'newer-cache',
        settings: null,
        start: 3,
        served: [
            { after: 3, through: 3 },
            { after: 0, through: 3 },
        ],
        expected: accepted(3, true),
    },
    {
        name: 'damaged-cache-from-version-1-without-it',
        record: 3,
        change: 'damaged-cache',
        settings: null,
        start: 3,
        served: [
            { after: 3, through: 3 },
            { after: 0, through: 3 },
        ],
        expected: accepted(3, true),
    },
    {
        name: 'newer-cache-cut-below-the-record-pin',
        record: 3,
        change: 'newer-cache',
        settings: 1,
        start: 3,
        served: [
            { after: 3, through: 3 },
            { after: 0, through: 2 },
        ],
        expected: refused,
    },
    {
        name: 'damaged-cache-cut-below-the-record-pin',
        record: 3,
        change: 'damaged-cache',
        settings: 1,
        start: 0,
        served: [{ after: 0, through: 2 }],
        expected: refused,
    },
    {
        // The break-check of the two above: without the record's own pin, older settings let it in.
        name: 'newer-cache-cut-with-no-record-pin',
        record: 3,
        change: 'newer-cache-no-pin',
        settings: 1,
        start: 3,
        served: [
            { after: 3, through: 3 },
            { after: 0, through: 2 },
        ],
        expected: accepted(2, true),
    },
    {
        name: 'record-pin-refused-on-every-path',
        record: 3,
        change: 'damaged-pin',
        settings: 1,
        start: 0,
        served: [{ after: 0, through: 3 }],
        expected: refused,
    },
    {
        name: 'cache-is-a-mark-from-version-1',
        record: 3,
        settings: null,
        start: 0,
        served: [{ after: 0, through: 3, branch: 'at-3' }],
        expected: { status: 'fork', version: 3 },
    },
    {
        name: 'served-older-than-the-committed-chain',
        record: null,
        settings: 1,
        held: 3,
        start: 0,
        served: [{ after: 0, through: 2 }],
        expected: older,
    },
    {
        name: 'committed-chain-is-a-mark',
        record: null,
        settings: 1,
        held: 3,
        start: 0,
        served: [{ after: 0, through: 3, branch: 'at-3' }],
        expected: { status: 'fork', version: 3 },
    },
    {
        name: 'no-mark-at-all',
        record: null,
        settings: null,
        start: 0,
        served: [{ after: 0, through: 3 }],
        expected: refused,
    },
    // A session that already committed the family (a warm ledger).
    {
        name: 'warm-record-at-the-committed-version',
        record: 3,
        settings: null,
        held: 3,
        start: 3,
        served: [{ after: 3, through: 3 }],
        expected: accepted(3, false),
    },
    {
        name: 'warm-record-behind-the-committed-chain',
        record: 2,
        settings: null,
        held: 3,
        start: 2,
        served: [
            { after: 2, through: 2 },
            { after: 0, through: 2 },
        ],
        expected: older,
    },
    {
        name: 'warm-damaged-cache-asks-for-version-1',
        record: 3,
        change: 'damaged-cache',
        settings: null,
        held: 3,
        start: 3,
        served: [
            { after: 3, through: 3 },
            { after: 0, through: 3 },
        ],
        expected: accepted(3, true),
    },
    {
        // A damaged cache whose digests are no list names no head: overtaken on the continuation,
        // which is a reason to fetch from version 1, never the answer.
        name: 'warm-headless-cache-asks-for-version-1',
        record: 3,
        change: 'headless-cache',
        settings: null,
        held: 3,
        start: 3,
        served: [
            { after: 3, through: 3 },
            { after: 0, through: 3 },
        ],
        expected: accepted(3, true),
    },
    {
        name: 'settings-ahead-of-the-record',
        record: 2,
        settings: 3,
        start: 2,
        served: [
            { after: 2, through: 2 },
            { after: 0, through: 2 },
        ],
        expected: refused,
    },
    {
        name: 'settings-on-another-branch',
        record: 3,
        settings: 'branch-3',
        start: 3,
        served: [{ after: 3, through: 3 }],
        expected: { status: 'fork', version: 3 },
    },
    {
        // The background committed roster 3; the foreground, which read the record at 2, gets junk
        // claiming roster 3 (refused, which uncommits), then the genuine rosters 1 and 2.
        name: 'refused-continuation-keeps-the-floor',
        record: 2,
        settings: null,
        held: 3,
        start: 2,
        served: [
            { after: 2, through: 3, badSignature: true },
            { after: 0, through: 2 },
        ],
        expected: older,
    },
    {
        // With the cache its digests are marks: the fork shows at roster 2 with the cache's side.
        // Without it (only the record's pin, at 3) it would show at 3.
        name: 'cache-shows-the-fork-at-roster-2',
        record: 3,
        settings: null,
        start: 0,
        served: [{ after: 0, through: 3, branch: 'at-2' }],
        expected: { status: 'fork', version: 2 },
    },
    // Settings as a version 1 document set nothing: acceptance stays refused until settings open.
    {
        name: 'version-1-settings-open-nothing',
        record: 2,
        settings: 'legacy',
        start: 2,
        served: [{ after: 2, through: 3 }],
        expected: refused,
    },
    // The record is opened before the settings are read, as the worker's marksOf.
    {
        name: 'unreadable-record-before-settings',
        record: 2,
        change: 'other-root',
        settings: 'legacy',
        start: 2,
        served: [{ after: 2, through: 3 }],
        expected: unreadable,
    },
];

type Family = { p1: Person; p2: Person; h: History; at3: History; at2: History };
let built: Promise<Family> | undefined;
export function family() {
    built ??= (async () => {
        const [p1, p2] = (await Promise.all([person(1), person(2)])) as [Person, Person];
        const write = async (branchAt: number | null) => {
            const h = await history('family', { format: 2 });
            for (let at = 0; at < 3; at++) {
                const roles =
                    branchAt === at + 1
                        ? (['members'] as const)
                        : at % 2
                          ? (['billing'] as const)
                          : [];
                await h.roster(p1, [p1.entry(['billing', 'members']), p2.entry([...roles])]);
            }
            return h;
        };
        return { p1, p2, h: await write(null), at3: await write(3), at2: await write(2) };
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

/* A group session as the worker holds one for person `who`, with only what acceptance reads. */
export function sessionOf(who: Person, root: Uint8Array) {
    const host = {
        unlocked: () => ({ userId: who.userId, root: root.slice(), keyVersion: 1 }),
        identity: () => ({ userId: who.userId, served: who.served, history: [] }),
        ledger: createAreaLedger(),
    } as unknown as GroupHost;
    return Object.assign(createGroupSession(host), { ledger: host.ledger });
}

export type DeviceCase = {
    name: string;
    record: string | null;
    /* The JSON the record holds, whichever key sealed it (the fuzz seeds' records). */
    recordValue?: unknown;
    recordVersion: number | null;
    settingsPin: GroupPin | null;
    /* Settings served as a version 1 document: legacySettings, never useSettings. */
    settingsLegacy?: boolean;
    held: Json | null;
    /* The settings the held chain was accepted against (the pin at roster 1). */
    heldSettingsPin?: GroupPin | null;
    start: number;
    served: Json[];
    firstKeys: GroupPublicKey;
    signerKeys: Record<string, string>;
    expected: Declared;
};

/* What one served chain carries, as route 5 serves it. */
export function servedOf(f: Family, served: Served) {
    const from = served.branch === 'at-3' ? f.at3 : served.branch === 'at-2' ? f.at2 : f.h;
    const rosters = from.rosters.slice(served.after, served.through).map((signed, index) => {
        const out = wire(signed);
        // A continuation the record's cache refuses: a group signature that does not hold.
        if (served.badSignature && index === 0)
            out.signature = { ...out.signature, ed25519: encode(new Uint8Array(64)) };
        return out;
    });
    return { after: served.after, rosters, successions: [] };
}

/*
 * A record's JSON changed as the case says, sealed again for the account,
 * family and root it says; with the JSON it holds (the fuzz seeds' records).
 */
async function changed(record: string, change: Change | undefined, f: Family) {
    const value = (await openDeviceRecord(
        ROOT.slice(),
        f.p1.userId,
        GROUP,
        'chains',
        record,
    )) as Json & { cache: Json; pin?: unknown };
    if (!change) return { envelope: record, value };
    let [root, userId, groupId] = [ROOT, f.p1.userId, GROUP];
    if (change === 'other-root') root = ROTATED_ROOT;
    if (change === 'other-account') userId = f.p2.userId;
    if (change === 'other-family') groupId = OTHER_GROUP;
    if (change === 'newer-record') value.v = 2;
    if (change === 'newer-cache' || change === 'newer-cache-no-pin') value.cache.cacheVersion = 3;
    if (change === 'damaged-cache') value.cache.statement = 7;
    if (change === 'headless-cache') value.cache.rosterDigests = 'abc';
    if (change === 'newer-cache-no-pin') delete value.pin;
    if (change === 'damaged-pin') value.pin = { rosterVersion: 3 };
    return {
        envelope: await sealDeviceRecord(root.slice(), userId, groupId, 'chains', value),
        value,
    };
}

/* Every case, its record sealed by this twin's acceptance and changed as it says. */
export async function deviceCases(): Promise<DeviceCase[]> {
    const f = await family();
    const firstKeys = f.h.keys[0]!.publicKey;
    const signerKeys = mlDsaKeysOf(f.p1, f.p2);
    const people = [f.p1, f.p2];
    const pins = {
        1: await pinOf(f.h, 1, people),
        3: await pinOf(f.h, 3, people),
        'branch-3': await pinOf(f.at3, 3, people),
    };
    const recordThrough = async (through: number) => {
        const { record } = await run({
            name: 'record',
            record: null,
            recordVersion: null,
            settingsPin: pins[1],
            held: null,
            start: 0,
            served: [servedOf(f, { after: 0, through })],
            firstKeys,
            signerKeys,
            expected: accepted(through),
        });
        if (!record) throw new Error('the record was not sealed');
        return record;
    };
    const records = { 2: await recordThrough(2), 3: await recordThrough(3) };
    const out: DeviceCase[] = [];
    for (const spec of SPECS) {
        const record = spec.record ? await changed(records[spec.record], spec.change, f) : null;
        out.push({
            name: spec.name,
            record: record?.envelope ?? null,
            recordValue: record?.value ?? null,
            recordVersion: spec.record,
            settingsPin: spec.settings && spec.settings !== 'legacy' ? pins[spec.settings] : null,
            settingsLegacy: spec.settings === 'legacy',
            held: spec.held ? servedOf(f, { after: 0, through: spec.held }) : null,
            heldSettingsPin: spec.held ? pins[1] : null,
            start: spec.start,
            served: spec.served.map((served) => servedOf(f, served)),
            firstKeys,
            signerKeys,
            expected: spec.expected,
        });
    }
    return out;
}

/*
 * One case through the web's order: record-acceptance.ts driving the worker's
 * groupAccept, each attempt handed the served chain after the version it asks
 * for. The outcome as both twins write it, and the record the acceptance sealed.
 */
export async function run(c: DeviceCase): Promise<{ outcome: Outcome; record: string | null }> {
    const f = await family();
    const session = sessionOf(f.p1, ROOT);
    const settings = (pin: GroupPin | null | undefined) =>
        session.useSettings(f.p1.userId, { groups: pin ? { [GROUP]: pin } : {} });
    let id = 0;
    const accept = (served: Json, record: string | null, withoutCache: boolean, retried: boolean) =>
        session.handle({
            id: ++id,
            operation: 'groupAccept',
            input: {
                userId: f.p1.userId,
                groupId: GROUP,
                served: {
                    rosters: served.rosters,
                    successions: served.successions,
                    firstKeys: c.firstKeys,
                    signerKeys: c.signerKeys,
                } as ServedChain,
                record,
                checkedAt: CHECKED,
                ...(withoutCache ? { withoutCache } : {}),
                ...(retried ? { retried } : {}),
            },
        } as GroupMessage) as Promise<GroupResults['groupAccept']>;
    if (c.held) {
        settings(c.heldSettingsPin);
        const held = await accept(c.held, null, false, false);
        if (held.status !== 'accepted')
            throw new Error(`${c.name}: the held chain was not accepted`);
    }
    if (c.settingsLegacy) session.legacySettings(f.p1.userId);
    else settings(c.settingsPin);
    const servedAfter = (after: number) => {
        const served = c.served.find((s) => s.after === after);
        if (!served) throw new Error(`${c.name}: nothing served after ${after}`);
        return served;
    };
    let fromVersionOne = false;
    try {
        // The first fetch continues from where the app stored the record (`start`), or from 1.
        const result = await acceptFromRecord(
            c.record ? c.start : null,
            (after, withoutCache, retried) => {
                if (c.record && c.start > 0 && after === 0) fromVersionOne = true;
                return accept(servedAfter(after), c.record, withoutCache, retried);
            },
        );
        if (result.status === 'accepted')
            return {
                outcome: {
                    status: 'accepted',
                    rosterVersion: result.view.rosterVersion,
                    pin: result.pin!,
                    fromVersionOne,
                },
                record: result.record,
            };
        if (result.status === 'fork') {
            const { of, version, sides } = result.fork;
            return {
                outcome: { status: 'fork', of, version, sides, fromVersionOne },
                record: null,
            };
        }
        return { outcome: { status: 'record-unreadable', fromVersionOne }, record: null };
    } catch (error) {
        if (!(error instanceof CryptoError)) throw error;
        return {
            outcome: lostRace(error)
                ? { status: 'overtaken', split: error.message === SPLIT_CHAIN, fromVersionOne }
                : { status: 'refused', message: error.message, fromVersionOne },
            record: null,
        };
    }
}

/* Whether an outcome is what its case declares. */
export function says(outcome: Outcome, expected: Declared) {
    if (outcome.status !== expected.status) return false;
    if (expected.status === 'accepted') {
        const at = outcome as { rosterVersion: number };
        return (
            at.rosterVersion === expected.rosterVersion &&
            (expected.fromVersionOne === undefined ||
                outcome.fromVersionOne === expected.fromVersionOne)
        );
    }
    if (expected.status === 'fork')
        return (outcome as { version: number }).version === expected.version;
    if (expected.status === 'overtaken')
        return (outcome as { split: boolean }).split === expected.split;
    return true;
}

/* The app's own records in the device store: what one twin sealed, opened by the other as each row says. */
export const STORE_VALUE = { calls: [{ id: 'a', body: 'x' }], v: 1 };
export type StoreRow = {
    name: string;
    open: { root: string; userId: string; groupId: string; store: 'outbox' | 'joins' };
    /* The value it opens to, or null when it must not open. */
    value: Json | null;
};
export async function storeRows(): Promise<{ envelope: string; rows: StoreRow[] }> {
    const f = await family();
    const envelope = await sealDeviceRecord(
        ROOT.slice(),
        f.p1.userId,
        GROUP,
        'outbox',
        STORE_VALUE,
    );
    const at = (over: Partial<StoreRow['open']>) => ({
        root: encode(ROOT),
        userId: f.p1.userId,
        groupId: GROUP,
        store: 'outbox' as const,
        ...over,
    });
    return {
        envelope,
        rows: [
            { name: 'as-sealed', open: at({}), value: STORE_VALUE },
            { name: 'another-store', open: at({ store: 'joins' }), value: null },
            { name: 'another-family', open: at({ groupId: OTHER_GROUP }), value: null },
            { name: 'another-account', open: at({ userId: f.p2.userId }), value: null },
            { name: 'a-rotated-root', open: at({ root: encode(ROTATED_ROOT) }), value: null },
        ],
    };
}

/* A row opened here: the value, or null when it does not open. */
export async function openRow(envelope: string, row: StoreRow): Promise<unknown> {
    const { root, userId, groupId, store } = row.open;
    try {
        return await openDeviceRecord(decode(root), userId, groupId, store, envelope);
    } catch (error) {
        if (error instanceof CryptoError) return null;
        throw error;
    }
}

/* The shared merge cases (crates/hushos-core/fixtures/merge-pin-cases.json), as this twin decides them. */
export type MergeCase = {
    name: string;
    groupId: string;
    current: GroupPin | null;
    next: GroupPin;
    opened: OpenedArea[];
    expected: 'behind' | 'conflict' | 'refused' | { merged: GroupPin; ahead: boolean };
};
export function mergeResult(c: MergeCase) {
    let merged;
    try {
        merged = mergePin(c.groupId, c.current, c.next, c.opened);
    } catch (error) {
        if (error instanceof CryptoError) return 'refused';
        throw error;
    }
    if (merged === null) return 'behind';
    if (merged === 'conflict') return 'conflict';
    return { merged, ahead: pinAhead(c.current, merged) };
}
