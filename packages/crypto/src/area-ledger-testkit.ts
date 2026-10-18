import {
    AREA_ROOT,
    KEYS_CHANGED,
    NOT_CHECKED_KEYS,
    NOT_COMMITTED_ROOT,
    OLDER_CHAIN,
    SPLIT_CHAIN,
    createAreaLedger,
    type AreaLedger,
    type RotatingNodeKey,
} from './area-ledger';
import { areaKeyCommitment } from './area-keys';
import { openNodeKey, openPreviousRootKey, wrapNodeKey, wrapPreviousRootKey } from './drive';
import { CryptoError } from './errors';
import type { AcceptedRosters } from './group-trust';
import {
    AREA,
    AREA_SEED,
    GROUP,
    OTHER_GROUP,
    acceptedOf,
    areaKeyAt,
    history,
    keyRowAt,
    pattern,
    person,
    rootKeyAt,
    standardAreas,
    tombstoneAt,
    type Person,
} from './group-testkit';
import type { RosterArea } from './groups';
import { decode, encode } from './keys';
import { KEY_CHANGE_PENDING, NOT_CARRIED } from './protocol';

/*
 * The family write rules as steps, for the shared fixtures
 * (scripts/area-ledger-fixtures.ts writes what the web did, and
 * area-ledger-fixtures.test.ts checks what the core did) and the fuzz target
 * `area_ledger` (fuzz/verdicts.ts). The twin is
 * crates/hushos-core/tests/common/area_ledger.rs: both read the same steps
 * the same way (a step that does not fit is a skip, as the fuzz shapes say),
 * run them on their own ledger, and must give the same outcome for every
 * step. The scenarios both run, with what each step must give, are
 * crates/hushos-core/fixtures/area-ledger-scenarios.json.
 *
 * Every step calls the worker's own ledger functions, the ones session.ts and
 * session-groups.ts call: commit, uncommit, forgetGroup and openArea (what
 * groupAccept, groupForget and groupOpenArea hand the ledger), openListedNode
 * (driveOpenNodes), requireWritable with newNodeKey (driveCreateNodes),
 * rewrapNode (driveRewrapNode) and rotateKey (rotateOne, with a re-key that
 * only wraps the fresh key). What they do not reach is the worker's grant
 * opening (openAreaGrant needs an unlocked account and a holder's seal; it
 * has its own shared cases, `sealCases`) and rekeyNode's records (rotation-testkit.ts).
 *
 * Two rule oracles hold on every run: each successful create, re-wrap or walk
 * key went under a parent rooted at the area's write version (a key the
 * ledger itself reports writable at that epoch, or a walk's pending key made
 * under one at the current write version), and each node a step made is
 * writable at once. A miss is listed in `violations`.
 */

/*
 * Every chain a step may commit: AREA in GROUP, created by person 1, rotated
 * or retired; and another family (OTHER_GROUP) whose chain also lists AREA at
 * version 1, as a removed member who manages a second family the person is
 * in could sign it.
 */
export const CHAINS = [
    'f2-v1',
    'f2-v2',
    'f2-v3',
    'f1-v1',
    'f1-v2',
    'f1-to-f2',
    'f2-retired',
    'other-f2-v1',
    'other-lists-personal',
    'f2-v2-split',
] as const;
export type ChainName = (typeof CHAINS)[number];

/* Node names a step may use, and the ids they stand for. */
export const NODES = ['ROOT', 'A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
/* The account's own workspace in the steps, and its key (pattern(32, 209), named k:9). */
export const PERSONAL = 'f0f0f0f0-0000-4000-8000-00000000000f';
const nodeId = (name: string) =>
    `0e0e0e0e-0000-4000-8000-${(NODES.indexOf(name as (typeof NODES)[number]) + 1)
        .toString(16)
        .padStart(12, '0')}`;

/* The codes a step's refusal is compared by: the ledger's own messages, anything else "refused". */
const CODES: Record<string, string> = {
    [KEY_CHANGE_PENDING]: 'key-change-pending',
    [NOT_CARRIED]: 'not-carried',
    [KEYS_CHANGED]: 'keys-changed',
    [NOT_CHECKED_KEYS]: 'not-checked',
    [AREA_ROOT]: 'area-root',
    [NOT_COMMITTED_ROOT]: 'not-committed-root',
    'Open Drive again to continue.': 'open-drive',
    'This folder was wrapped under an older workspace key.': 'older-workspace-key',
    'Open the containing folder first.': 'open-parent',
    'This item was wrapped under an older folder key.': 'older-folder-key',
    'Check the family’s member list first.': 'no-chain',
    'This folder does not belong to the family.': 'not-the-familys',
    'This folder is not on the family’s member list.': 'not-listed',
    'This item changed since it was opened. Refresh and retry.': 'item-changed',
    [OLDER_CHAIN]: 'older-chain',
    [SPLIT_CHAIN]: 'split-chain',
};
export function codeOf(error: unknown) {
    if (!(error instanceof CryptoError)) throw error;
    return CODES[error.message] ?? 'refused';
}

let built: Promise<Map<ChainName, AcceptedRosters>> | undefined;
/* Every chain in CHAINS, built once: the same statements in both twins, signatures aside. */
export function chains() {
    built ??= (async () => {
        const owner = await person(1);
        const out = new Map<ChainName, AcceptedRosters>();
        const entry = owner.entry(['billing', 'members']);
        const make = async (format: 1 | 2, steps: (RosterArea[] | 'switch')[]) => {
            const h = await history('family', { format });
            for (const step of steps) {
                if (step === 'switch') {
                    h.format = 2;
                    continue;
                }
                await h.roster(owner, [entry], undefined, step);
            }
            return acceptedOf(h, [owner as Person]);
        };
        const f1 = async (version: number): Promise<RosterArea> => ({
            workspaceId: AREA,
            workspaceKeyVersion: version,
            commitment: await areaKeyCommitment(areaKeyAt(AREA, version)),
        });
        out.set('f2-v1', await make(2, [await standardAreas(2)]));
        out.set('f2-v2', await make(2, [await standardAreas(2), [await keyRowAt(AREA, 2)]]));
        out.set(
            'f2-v3',
            await make(2, [
                await standardAreas(2),
                [await keyRowAt(AREA, 2)],
                [await keyRowAt(AREA, 3)],
            ]),
        );
        out.set('f1-v1', await make(1, [[await f1(1)]]));
        out.set('f1-v2', await make(1, [[await f1(1)], [await f1(2)]]));
        out.set('f1-to-f2', await make(1, [[await f1(1)], 'switch', [await keyRowAt(AREA, 2)]]));
        out.set('f2-retired', await make(2, [await standardAreas(2), [tombstoneAt(AREA, 2)]]));
        // Roster 2 with no rows: the version f2-v2 holds, another digest (a split view).
        out.set('f2-v2-split', await make(2, [await standardAreas(2), []]));
        const other = await history('family', { format: 2, groupId: OTHER_GROUP });
        await other.roster(owner, [entry], undefined, await standardAreas(2));
        out.set('other-f2-v1', await acceptedOf(other, [owner as Person]));
        // Another family whose roster names this account's own workspace as one of its areas.
        const hostile = await history('family', { format: 2, groupId: OTHER_GROUP });
        await hostile.roster(owner, [entry], undefined, [await keyRowAt(PERSONAL, 1)]);
        out.set('other-lists-personal', await acceptedOf(hostile, [owner as Person]));
        return out;
    })();
    return built;
}

/* A named key: the testkit's area and root keys, or a pattern. */
function namedKey(name: string): Uint8Array<ArrayBuffer> | undefined {
    const match = /^(area|root|k):(\d{1,2})$/.exec(name);
    if (!match) return undefined;
    const n = Number(match[2]);
    if (match[1] === 'area') return n >= 1 && n <= 9 ? areaKeyAt(AREA, n) : undefined;
    if (match[1] === 'root') return n >= 1 && n <= 9 ? rootKeyAt(AREA, n) : undefined;
    return n <= 15 ? pattern(32, 200 + n) : undefined;
}
const NAMED = [
    ...Array.from({ length: 9 }, (_, i) => `area:${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `root:${i + 1}`),
    ...Array.from({ length: 16 }, (_, i) => `k:${i}`),
];

type Doc = Record<string, unknown>;
const isObject = (value: unknown): value is Doc =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const epochOf = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 64
        ? value
        : undefined;
const nodeOf = (value: unknown) =>
    typeof value === 'string' && (NODES as readonly string[]).includes(value) ? value : undefined;
const parentOf = (value: unknown) => (value === 'WS' ? 'WS' : nodeOf(value));
const keyRef = (value: unknown) =>
    typeof value === 'string' && (namedKey(value) || /^made:[A-Z]+@\d{1,2}$/.test(value))
        ? value
        : undefined;
/* The family a step names: GROUP unless it says "other". */
const groupOf = (value: unknown) =>
    value === undefined || value === 'family' ? GROUP : value === 'other' ? OTHER_GROUP : undefined;
const labelOf = (value: unknown) =>
    value === undefined
        ? 'node'
        : value === 'node' || value === 'previous-root'
          ? value
          : undefined;

type Wrapped = {
    key: string;
    under: string;
    parentKeyEpoch: number;
    keyEpoch: number;
    label: 'node' | 'previous-root';
};
export type Step =
    | { op: 'commit'; chain: ChainName }
    /* `fork`: the worker's uncommit after a fork (its `forked` set is the session's, not the ledger's). */
    | { op: 'uncommit'; group: string; fork: boolean }
    | { op: 'forget'; group: string }
    | {
          op: 'openArea';
          group: string;
          version: number;
          served: number;
          key: string;
          idSeed: string;
      }
    | {
          op: 'list';
          node: string;
          parent: string;
          envelope: Wrapped;
          prev: Wrapped | null;
      }
    | { op: 'create'; node: string; parent: string; parentKeyEpoch: number; keyEpoch: number }
    | { op: 'writable'; node: string }
    | { op: 'requireWritable' }
    | { op: 'rewrap'; node: string; parent: string; parentKeyEpoch: number; keyEpoch: number }
    | {
          op: 'rotate';
          node: string;
          parent: string;
          parentKeyEpoch: number;
          target: number;
          envelope: Wrapped;
      }
    | { op: 'commitPending' | 'dropPending'; nodes: string[] }
    | { op: 'dropAllPending' | 'personalState' | 'foreign' }
    | { op: 'openPersonal'; version: number }
    | { op: 'personalCreate'; node: string; parentKeyEpoch: number; keyEpoch: number }
    | { op: 'keyAt'; node: string; epoch: number }
    | { op: 'nodeKey'; node: string }
    | { op: 'state' };

function wrappedOf(value: unknown): Wrapped | undefined {
    if (!isObject(value)) return undefined;
    const key = keyRef(value.key);
    const under = keyRef(value.under);
    const parentKeyEpoch = epochOf(value.parentKeyEpoch);
    const keyEpoch = epochOf(value.keyEpoch);
    const label = labelOf(value.label);
    if (!key || !under || parentKeyEpoch === undefined || keyEpoch === undefined || !label)
        return undefined;
    return { key, under, parentKeyEpoch, keyEpoch, label };
}

/* One step from JSON; undefined when it does not fit. */
export function readStep(value: unknown): Step | undefined {
    if (!isObject(value)) return undefined;
    switch (value.op) {
        case 'commit':
            return (CHAINS as readonly string[]).includes(value.chain as string)
                ? { op: 'commit', chain: value.chain as ChainName }
                : undefined;
        case 'uncommit': {
            const group = groupOf(value.group);
            const fork =
                value.fork === undefined
                    ? false
                    : typeof value.fork === 'boolean'
                      ? value.fork
                      : undefined;
            return group === undefined || fork === undefined
                ? undefined
                : { op: 'uncommit', group, fork };
        }
        case 'forget': {
            const group = groupOf(value.group);
            return group === undefined ? undefined : { op: 'forget', group };
        }
        case 'requireWritable':
        case 'state':
        case 'dropAllPending':
        case 'personalState':
        case 'foreign':
            return { op: value.op };
        case 'openPersonal': {
            const version = epochOf(value.version);
            return version === undefined ? undefined : { op: 'openPersonal', version };
        }
        case 'personalCreate': {
            const node = nodeOf(value.node);
            const parentKeyEpoch = epochOf(value.parentKeyEpoch);
            const keyEpoch = epochOf(value.keyEpoch);
            if (!node || parentKeyEpoch === undefined || keyEpoch === undefined) return undefined;
            return { op: 'personalCreate', node, parentKeyEpoch, keyEpoch };
        }
        case 'openArea': {
            const group = groupOf(value.group);
            const version = epochOf(value.version);
            const served = epochOf(value.served);
            const key = keyRef(value.key === undefined ? `area:${version}` : value.key);
            const idSeed =
                value.idSeed === undefined
                    ? AREA_SEED
                    : typeof value.idSeed === 'string'
                      ? value.idSeed
                      : undefined;
            if (
                group === undefined ||
                version === undefined ||
                served === undefined ||
                !key ||
                idSeed === undefined
            )
                return undefined;
            return { op: 'openArea', group, version, served, key, idSeed };
        }
        case 'list': {
            const node = nodeOf(value.node);
            const parent = parentOf(value.parent);
            const envelope = wrappedOf(value);
            const prev = value.prev === undefined ? null : wrappedOf(value.prev);
            if (!node || !parent || !envelope || prev === undefined) return undefined;
            return { op: 'list', node, parent, envelope, prev };
        }
        case 'create':
        case 'rewrap': {
            const node = nodeOf(value.node);
            const parent = parentOf(value.parent);
            const parentKeyEpoch = epochOf(value.parentKeyEpoch);
            const keyEpoch = epochOf(value.keyEpoch);
            if (!node || !parent || parentKeyEpoch === undefined || keyEpoch === undefined)
                return undefined;
            return { op: value.op, node, parent, parentKeyEpoch, keyEpoch };
        }
        case 'writable':
        case 'nodeKey':
        case 'keyAt': {
            const node = nodeOf(value.node);
            if (!node) return undefined;
            if (value.op === 'writable') return { op: 'writable', node };
            if (value.op === 'nodeKey') return { op: 'nodeKey', node };
            const epoch = epochOf(value.epoch);
            return epoch === undefined ? undefined : { op: 'keyAt', node, epoch };
        }
        case 'rotate': {
            const node = nodeOf(value.node);
            const parent = parentOf(value.parent);
            const parentKeyEpoch = epochOf(value.parentKeyEpoch);
            const target = epochOf(value.target);
            const envelope = wrappedOf(value.served);
            if (
                !node ||
                !parent ||
                parentKeyEpoch === undefined ||
                target === undefined ||
                !envelope ||
                envelope.label !== 'node'
            )
                return undefined;
            return { op: 'rotate', node, parent, parentKeyEpoch, target, envelope };
        }
        case 'commitPending':
        case 'dropPending': {
            if (!Array.isArray(value.nodes) || value.nodes.length > 8) return undefined;
            const nodes = value.nodes.map(nodeOf);
            if (nodes.some((n) => !n)) return undefined;
            return { op: value.op, nodes: nodes as string[] };
        }
        default:
            return undefined;
    }
}

/* Steps from JSON (at most 64); undefined when any does not fit. */
export function readSteps(value: unknown): Step[] | undefined {
    if (!Array.isArray(value) || value.length > 64) return undefined;
    const steps = value.map(readStep);
    return steps.some((step) => !step) ? undefined : (steps as Step[]);
}

/* An envelope a step made, with what opens it and what it holds, for the other twin to open. */
export type Made = {
    step: number;
    workspaceId: string;
    nodeId: string;
    parentId: string;
    parentKeyEpoch: number;
    keyEpoch: number;
    parentKey: string;
    key: string;
    keyEnvelope: string;
};

/*
 * Runs `steps` on a fresh ledger: each step's outcome ({ ok, ...what it gave }
 * or { error: code }) and every envelope a step made. Keys in outcomes are
 * named (area:1, root:2, k:3), or made:NODE@EPOCH for a key a step made.
 */
export async function runSteps(steps: Step[]) {
    const catalog = await chains();
    const ledger: AreaLedger = createAreaLedger();
    /* The families that opened AREA here: forgetting one of them drops AREA's keys, pending ones included. */
    const openedBy = new Set<string>();
    /* Every key a step made, by label, and the label of each made key's bytes. */
    const made = new Map<string, Uint8Array>();
    const labels = new Map<string, string>();
    const remember = (node: string, epoch: number, key: Uint8Array) => {
        const label = `made:${node}@${epoch}`;
        made.set(label, key.slice());
        labels.set(encode(key), label);
    };
    const resolve = (ref: string) => namedKey(ref) ?? made.get(ref);
    const nameOf = (key: Uint8Array) => {
        for (const name of NAMED) if (encode(namedKey(name)!) === encode(key)) return name;
        return labels.get(encode(key)) ?? 'unknown';
    };
    const id = (name: string) => (name === 'WS' ? AREA : nodeId(name));
    const envelopeOf = async (node: string, parent: string, w: Wrapped) => {
        const key = resolve(w.key);
        const under = resolve(w.under);
        if (!key || !under) return undefined;
        const ctx = {
            workspaceId: AREA,
            nodeId: id(node),
            parentId: id(parent),
            parentKeyEpoch: w.parentKeyEpoch,
            keyEpoch: w.keyEpoch,
        };
        try {
            const envelope = encode(
                w.label === 'previous-root'
                    ? await wrapPreviousRootKey(key, under, ctx)
                    : await wrapNodeKey(key, under, ctx),
            );
            served.push({
                label: w.label,
                ...ctx,
                parentKey: encode(under),
                key: encode(key),
                keyEnvelope: envelope,
            });
            return envelope;
        } catch {
            // Fields the envelope's context refuses: an envelope that opens nowhere.
            return encode(new Uint8Array(72));
        }
    };
    const outcomes: Record<string, unknown>[] = [];
    const out: Made[] = [];
    /* Every envelope a step served the ledger, for the other twin to open under its label. */
    const served: Served[] = [];
    /* The key a parent at `epoch` has, as far as the steps know it, for the other twin to open with. */
    // A walk's pending key first, as wrapKeyFor takes it; pendingFresh holds only uncommitted ones.
    const parentKeyOf = (parent: string, epoch: number) =>
        parent === 'WS'
            ? ledger.workspaceKey(AREA, epoch)
            : (pendingFresh.get(`${parent}@${epoch}`) ??
              ledger.keyAtEpoch(AREA, id(parent), epoch));
    const pendingFresh = new Map<string, Uint8Array>();
    /* Each walk's pending key by NODE@EPOCH: the write version it is rooted at, or null for none. */
    const pendingRooted = new Map<string, number | null>();
    const forgetPending = (node: string) => {
        for (const at of pendingFresh.keys())
            if (at.startsWith(`${node}@`)) pendingFresh.delete(at);
        for (const at of pendingRooted.keys())
            if (at.startsWith(`${node}@`)) pendingRooted.delete(at);
    };
    const writeVersionNow = () => {
        try {
            return ledger.writeVersion(AREA);
        } catch {
            return null;
        }
    };
    /* The oracle's view: whether a parent at `epoch` is rooted at the area's write version. */
    const rootedParent = (parent: string, epoch: number) => {
        if (!ledger.isArea(AREA)) return true;
        if (parent === 'WS') return false;
        const pending = pendingRooted.get(`${parent}@${epoch}`);
        if (pending !== undefined) return pending !== null && pending === writeVersionNow();
        try {
            return ledger.writableNodeKey(AREA, id(parent))?.epoch === epoch;
        } catch {
            return false;
        }
    };
    const violations: string[] = [];
    for (const [index, step] of steps.entries()) {
        const parent =
            step.op === 'create' || step.op === 'rewrap' || step.op === 'rotate'
                ? rootedParent(step.parent, step.parentKeyEpoch)
                : true;
        try {
            outcomes.push({ ok: true, ...(await run(index, step, parent)) });
            if (!parent)
                violations.push(
                    `step ${index}: ${step.op} went under a parent not rooted at the write version`,
                );
            if (step.op === 'create' && ledger.isArea(AREA)) {
                let writable = false;
                try {
                    writable = ledger.writableNodeKey(AREA, id(step.node)) !== undefined;
                } catch {
                    /* not writable */
                }
                if (!writable)
                    violations.push(`step ${index}: a node a write made is not writable`);
            }
        } catch (error) {
            outcomes.push({ error: codeOf(error) });
        }
    }
    return { outcomes, made: out, served, violations };

    async function run(
        index: number,
        step: Step,
        rootedBefore: boolean,
    ): Promise<Record<string, unknown>> {
        switch (step.op) {
            case 'commit':
                ledger.commit(catalog.get(step.chain)!);
                return {};
            case 'uncommit':
                ledger.uncommit(step.group);
                return {};
            case 'forget':
                ledger.forgetGroup(step.group);
                if (openedBy.delete(step.group)) for (const node of NODES) forgetPending(node);
                return {};
            case 'openArea': {
                const key = resolve(step.key);
                if (!key) throw new CryptoError('unknown key');
                const reason = await ledger.openArea(
                    step.group,
                    AREA,
                    step.idSeed,
                    step.version,
                    key.slice() as Uint8Array<ArrayBuffer>,
                    step.served,
                );
                openedBy.add(step.group);
                return { version: step.version, writable: reason === null, reason };
            }
            case 'list': {
                const keyEnvelope = await envelopeOf(step.node, step.parent, step.envelope);
                const prev = step.prev && (await envelopeOf(step.node, step.parent, step.prev));
                if (!keyEnvelope || prev === undefined) throw new CryptoError('unknown key');
                const key = await ledger.openListedNode(AREA, {
                    id: id(step.node),
                    parentId: id(step.parent),
                    parentKeyEpoch: step.envelope.parentKeyEpoch,
                    keyEpoch: step.envelope.keyEpoch,
                    keyEnvelope,
                    prevKeyEnvelope: prev,
                    prevKeyEpoch: step.prev?.keyEpoch ?? null,
                    prevParentKeyEpoch: step.prev?.parentKeyEpoch ?? null,
                });
                return { key: nameOf(key) };
            }
            case 'create': {
                ledger.requireWritable(AREA);
                // The parent's key as it was before the step (a node may be made under its own id).
                const under = parentKeyOf(step.parent, step.parentKeyEpoch)?.slice();
                const { key, keyEnvelope } = await ledger.newNodeKey(AREA, {
                    id: id(step.node),
                    parentId: id(step.parent),
                    parentKeyEpoch: step.parentKeyEpoch,
                    keyEpoch: step.keyEpoch,
                });
                remember(step.node, step.keyEpoch, key);
                out.push(
                    madeOf(
                        index,
                        step.node,
                        step.parent,
                        step.parentKeyEpoch,
                        step.keyEpoch,
                        key,
                        keyEnvelope,
                        under,
                    ),
                );
                return { key: nameOf(key) };
            }
            case 'writable': {
                const held = ledger.writableNodeKey(AREA, id(step.node));
                return held ? { key: nameOf(held.key), epoch: held.epoch } : { none: true };
            }
            case 'requireWritable':
                ledger.requireWritable(AREA);
                return {};
            case 'rewrap': {
                const under = parentKeyOf(step.parent, step.parentKeyEpoch)?.slice();
                const keyEnvelope = await ledger.rewrapNode(AREA, {
                    id: id(step.node),
                    parentId: id(step.parent),
                    parentKeyEpoch: step.parentKeyEpoch,
                    keyEpoch: step.keyEpoch,
                });
                const key = ledger.nodeKey(AREA, id(step.node))!.key;
                out.push(
                    madeOf(
                        index,
                        step.node,
                        step.parent,
                        step.parentKeyEpoch,
                        step.keyEpoch,
                        key,
                        keyEnvelope,
                        under,
                    ),
                );
                return {};
            }
            case 'rotate': {
                const served = await envelopeOf(step.node, step.parent, step.envelope);
                if (!served) throw new CryptoError('unknown key');
                const node: RotatingNodeKey = {
                    id: id(step.node),
                    parentId: id(step.parent),
                    parentKeyEpoch: step.parentKeyEpoch,
                    keyEpoch: step.envelope.keyEpoch,
                    wrappedParentKeyEpoch: step.envelope.parentKeyEpoch,
                    keyEnvelope: served,
                };
                const under = parentKeyOf(step.parent, step.parentKeyEpoch)?.slice();
                const rotated = await ledger.rotateKey(
                    AREA,
                    node,
                    step.target,
                    async ({ old, fresh, parentKey }) => ({
                        old: nameOf(old),
                        fresh: fresh.slice(),
                        parentKey: parentKey.slice(),
                        keyEnvelope: await wrapNodeKey(fresh, parentKey, {
                            workspaceId: AREA,
                            nodeId: node.id,
                            parentId: node.parentId,
                            parentKeyEpoch: node.parentKeyEpoch,
                            keyEpoch: step.target,
                        }),
                    }),
                );
                if (rotated.rewrap) {
                    out.push(
                        madeOf(
                            index,
                            step.node,
                            step.parent,
                            step.parentKeyEpoch,
                            node.keyEpoch,
                            rotated.key,
                            rotated.keyEnvelope,
                            under,
                        ),
                    );
                    return { rewrap: true, key: nameOf(rotated.key) };
                }
                const { fresh, parentKey, keyEnvelope } = rotated.result;
                remember(step.node, step.target, fresh);
                forgetPending(step.node);
                pendingFresh.set(`${step.node}@${step.target}`, fresh);
                pendingRooted.set(
                    `${step.node}@${step.target}`,
                    rootedBefore ? writeVersionNow() : null,
                );
                out.push(
                    madeOf(
                        index,
                        step.node,
                        step.parent,
                        step.parentKeyEpoch,
                        step.target,
                        fresh,
                        keyEnvelope,
                        parentKey,
                    ),
                );
                return { rewrap: false, old: rotated.result.old, fresh: nameOf(fresh) };
            }
            case 'commitPending':
            case 'dropPending': {
                for (const node of step.nodes) forgetPending(node);
                const ids = step.nodes.map(id);
                return {
                    count:
                        step.op === 'commitPending'
                            ? ledger.commitPending(AREA, ids)
                            : ledger.dropPending(AREA, ids),
                };
            }
            case 'dropAllPending':
                for (const node of NODES) forgetPending(node);
                return { count: ledger.dropAllPending(AREA) };
            case 'openPersonal':
                // driveOpenWorkspace: the account's own grant opened, its key held as personal.
                ledger.openPersonalWorkspace(PERSONAL, step.version, namedKey('k:9')!);
                return {};
            case 'personalCreate': {
                // driveCreateNodes at the personal workspace's top level.
                ledger.requireWritable(PERSONAL);
                const { key } = await ledger.newNodeKey(PERSONAL, {
                    id: id(step.node),
                    parentId: PERSONAL,
                    parentKeyEpoch: step.parentKeyEpoch,
                    keyEpoch: step.keyEpoch,
                });
                remember(step.node, step.keyEpoch, key);
                return { key: nameOf(key) };
            }
            case 'personalState':
                return {
                    isArea: ledger.isArea(PERSONAL),
                    read: attemptRead(() => ledger.readVersion(PERSONAL)),
                    write: attemptRead(() => ledger.writeVersion(PERSONAL)),
                };
            case 'foreign':
                return {
                    listings: ledger.foreignListings().map((at) => ({
                        group: at.groupId === GROUP ? 'family' : 'other',
                        workspace: at.workspaceId === AREA ? 'area' : 'personal',
                        openedBy:
                            at.openedBy === null
                                ? null
                                : at.openedBy === GROUP
                                  ? 'family'
                                  : 'other',
                    })),
                };
            case 'keyAt': {
                const key = ledger.keyAtEpoch(AREA, id(step.node), step.epoch);
                return { key: key ? nameOf(key) : null };
            }
            case 'nodeKey': {
                // What a cached read (metadata, a download) takes: the node's current key as held.
                const held = ledger.nodeKey(AREA, id(step.node));
                return held ? { key: nameOf(held.key), epoch: held.epoch } : { none: true };
            }
            case 'state':
                return {
                    isArea: ledger.isArea(AREA),
                    read: attemptRead(() => ledger.readVersion(AREA)),
                    write: attemptRead(() => ledger.writeVersion(AREA)),
                };
        }
    }

    function attemptRead(read: () => number | null) {
        try {
            return read();
        } catch (error) {
            return codeOf(error);
        }
    }

    function madeOf(
        step: number,
        node: string,
        parent: string,
        parentKeyEpoch: number,
        keyEpoch: number,
        key: Uint8Array,
        keyEnvelope: Uint8Array,
        parentKey?: Uint8Array,
    ): Made {
        const under = parentKey ?? parentKeyOf(parent, parentKeyEpoch);
        return {
            step,
            workspaceId: AREA,
            nodeId: id(node),
            parentId: id(parent),
            parentKeyEpoch,
            keyEpoch,
            parentKey: under ? encode(under) : '',
            key: encode(key),
            keyEnvelope: encode(keyEnvelope),
        };
    }
}

/* An envelope a step served the ledger (a listing's or a walk's), with its label. */
export type Served = Omit<Made, 'step'> & { label: 'node' | 'previous-root' };

/* Whether the other twin's served envelope opens under its label to the key it says. */
export async function opensAsServed(served: Served) {
    const ctx = {
        workspaceId: served.workspaceId,
        nodeId: served.nodeId,
        parentId: served.parentId,
        parentKeyEpoch: served.parentKeyEpoch,
        keyEpoch: served.keyEpoch,
    };
    const envelope = decode(served.keyEnvelope, 72);
    const under = decode(served.parentKey, 32);
    const key =
        served.label === 'previous-root'
            ? await openPreviousRootKey(envelope, under, ctx)
            : await openNodeKey(envelope, under, ctx);
    return encode(key) === served.key;
}

/* Whether the other twin's made envelope opens to the key it says, under the parent key it says. */
export async function opensAsMade(made: Made) {
    const key = await openNodeKey(decode(made.keyEnvelope, 72), decode(made.parentKey, 32), {
        workspaceId: made.workspaceId,
        nodeId: made.nodeId,
        parentId: made.parentId,
        parentKeyEpoch: made.parentKeyEpoch,
        keyEpoch: made.keyEpoch,
    });
    return encode(key) === made.key;
}

/* The shared scenarios' expectations: each step whose `expect` is given must give exactly it. */
export function unmet(
    scenario: { steps: { expect?: unknown }[] },
    outcomes: Record<string, unknown>[],
) {
    const misses: string[] = [];
    scenario.steps.forEach((step, index) => {
        if (step.expect === undefined) return;
        const got = outcomes[index];
        const want = step.expect;
        const same =
            typeof want === 'string'
                ? want === 'ok'
                    ? got?.ok === true
                    : got?.error === want
                : JSON.stringify(sorted(got)) ===
                  JSON.stringify(sorted({ ok: true, ...(want as Doc) }));
        if (!same)
            misses.push(
                `step ${index}: wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
            );
    });
    return misses;
}

function sorted(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sorted);
    if (!isObject(value)) return value;
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, sorted(value[key])]),
    );
}
