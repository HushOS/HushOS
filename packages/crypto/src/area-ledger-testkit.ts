import {
    AREA_ROOT,
    KEYS_CHANGED,
    NOT_CHECKED_KEYS,
    NOT_COMMITTED_ROOT,
    createAreaLedger,
    type AreaLedger,
    type RotatingNodeKey,
} from './area-ledger';
import { areaKeyCommitment } from './area-keys';
import { uuid } from './canonical';
import {
    generateKey,
    openNodeKey,
    openPreviousRootKey,
    wrapNodeKey,
    wrapPreviousRootKey,
} from './drive';
import { CryptoError } from './errors';
import type { AcceptedRosters } from './group-trust';
import {
    AREA,
    AREA_SEED,
    GROUP,
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
import { areaWriteVersion, type RosterArea } from './groups';
import { checkId } from './ids';
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
 * The group part of a step (commit, uncommit, forget, openArea) is what the
 * web's group session does around the ledger (session-groups.ts) and the
 * core's AreaLedger does itself: committed chains, opened areas, the area
 * key's commitment checked against the chain.
 */

/* Every chain a step may commit: AREA in GROUP, created by person 1, rotated or retired. */
export const CHAINS = [
    'f2-v1',
    'f2-v2',
    'f2-v3',
    'f1-v1',
    'f1-v2',
    'f1-to-f2',
    'f2-retired',
] as const;
export type ChainName = (typeof CHAINS)[number];

/* Node names a step may use, and the ids they stand for. */
export const NODES = ['ROOT', 'A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
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
    | { op: 'uncommit' }
    | { op: 'forget' }
    | { op: 'openArea'; version: number; served: number; key: string; idSeed: string }
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
    | { op: 'keyAt'; node: string; epoch: number }
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
        case 'uncommit':
        case 'forget':
        case 'requireWritable':
        case 'state':
            return { op: value.op };
        case 'openArea': {
            const version = epochOf(value.version);
            const served = epochOf(value.served);
            const key = keyRef(value.key === undefined ? `area:${version}` : value.key);
            const idSeed =
                value.idSeed === undefined
                    ? AREA_SEED
                    : typeof value.idSeed === 'string'
                      ? value.idSeed
                      : undefined;
            if (version === undefined || served === undefined || !key || idSeed === undefined)
                return undefined;
            return { op: 'openArea', version, served, key, idSeed };
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
        case 'keyAt': {
            const node = nodeOf(value.node);
            if (!node) return undefined;
            if (value.op === 'writable') return { op: 'writable', node };
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
    const committed = new Map<string, AcceptedRosters>();
    const opened = new Map<string, Map<string, number>>();
    const ledger: AreaLedger = createAreaLedger({
        knownArea(workspaceId) {
            for (const areas of opened.values()) if (areas.has(workspaceId)) return true;
            for (const chain of committed.values())
                if (Object.hasOwn(chain.areaKeys, workspaceId)) return true;
            return false;
        },
        chainOf(workspaceId) {
            return [...committed.values()].find((at) => Object.hasOwn(at.areaKeys, workspaceId));
        },
    });
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
    for (const [index, step] of steps.entries()) {
        try {
            outcomes.push({ ok: true, ...(await run(index, step)) });
        } catch (error) {
            outcomes.push({ error: codeOf(error) });
        }
    }
    return { outcomes, made: out, served };

    async function run(index: number, step: Step): Promise<Record<string, unknown>> {
        switch (step.op) {
            case 'commit': {
                const chain = catalog.get(step.chain)!;
                committed.set(chain.groupId, chain);
                ledger.commitAreas(chain);
                return {};
            }
            case 'uncommit': {
                const chain = committed.get(GROUP);
                ledger.uncommitAreas([
                    ...Object.keys(chain?.areaKeys ?? {}),
                    ...(opened.get(GROUP)?.keys() ?? []),
                ]);
                committed.delete(GROUP);
                return {};
            }
            case 'forget': {
                const chain = committed.get(GROUP);
                ledger.forgetAreas([
                    ...Object.keys(chain?.areaKeys ?? {}),
                    ...(opened.get(GROUP)?.keys() ?? []),
                ]);
                opened.delete(GROUP);
                committed.delete(GROUP);
                return {};
            }
            case 'openArea': {
                // What the group session does around the ledger (openArea), as the core's open_area.
                uuid(GROUP, 'group id');
                const chain = committed.get(GROUP);
                if (!chain) throw new CryptoError('Check the family’s member list first.');
                uuid(AREA, 'workspace id');
                try {
                    await checkId('workspace', GROUP, step.idSeed, AREA);
                } catch {
                    throw new CryptoError('This folder does not belong to the family.');
                }
                const latest = areaWriteVersion(chain, AREA);
                if (latest === null)
                    throw new CryptoError('This folder is not on the family’s member list.');
                const key = resolve(step.key);
                if (!key) throw new CryptoError('unknown key');
                const listed = chain.areaKeys[AREA] ?? [];
                if (step.version < 1 || listed[step.version - 1] !== (await areaKeyCommitment(key)))
                    throw new CryptoError(NOT_CHECKED_KEYS);
                const areas = opened.get(GROUP) ?? new Map<string, number>();
                areas.set(AREA, Math.max(areas.get(AREA) ?? 0, step.version));
                opened.set(GROUP, areas);
                const reason = ledger.admitAreaKey(
                    AREA,
                    step.version,
                    key.slice() as Uint8Array<ArrayBuffer>,
                    step.served,
                    latest,
                );
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
                // driveRewrapNode, as the core's rewrap_node.
                ledger.requireWritable(AREA);
                const entry = ledger.writableNodeKey(AREA, id(step.node));
                if (!entry) throw new CryptoError('Open the containing folder first.');
                if (entry.epoch !== step.keyEpoch)
                    throw new CryptoError(
                        'This item changed since it was opened. Refresh and retry.',
                    );
                const parentKey = ledger.wrapKeyFor(AREA, id(step.parent), step.parentKeyEpoch);
                const keyEnvelope = await wrapNodeKey(entry.key, parentKey, {
                    workspaceId: AREA,
                    nodeId: id(step.node),
                    parentId: id(step.parent),
                    parentKeyEpoch: step.parentKeyEpoch,
                    keyEpoch: step.keyEpoch,
                });
                out.push(
                    madeOf(
                        index,
                        step.node,
                        step.parent,
                        step.parentKeyEpoch,
                        step.keyEpoch,
                        entry.key,
                        keyEnvelope,
                        parentKey,
                    ),
                );
                return {};
            }
            case 'rotate': {
                // rotateOne's key part (session.ts), as the core's rotate_key.
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
                const old = await ledger.rotationOldKey(AREA, node);
                if (node.keyEpoch >= step.target) {
                    const kept = old.slice();
                    const keyEnvelope = await ledger.rewrapAtTarget(AREA, node, old);
                    out.push(
                        madeOf(
                            index,
                            step.node,
                            step.parent,
                            step.parentKeyEpoch,
                            node.keyEpoch,
                            kept,
                            keyEnvelope,
                            under,
                        ),
                    );
                    return { rewrap: true, key: nameOf(kept) };
                }
                const fresh = generateKey();
                try {
                    const parent = ledger.freshKeyParent(AREA, node);
                    const keyEnvelope = await wrapNodeKey(fresh, parent.key, {
                        workspaceId: AREA,
                        nodeId: node.id,
                        parentId: node.parentId,
                        parentKeyEpoch: node.parentKeyEpoch,
                        keyEpoch: step.target,
                    });
                    const oldName = nameOf(old);
                    remember(step.node, step.target, fresh);
                    for (const at of pendingFresh.keys())
                        if (at.startsWith(`${step.node}@`)) pendingFresh.delete(at);
                    pendingFresh.set(`${step.node}@${step.target}`, fresh.slice());
                    out.push(
                        madeOf(
                            index,
                            step.node,
                            step.parent,
                            step.parentKeyEpoch,
                            step.target,
                            fresh,
                            keyEnvelope,
                            parent.key,
                        ),
                    );
                    ledger.setPending(AREA, node.id, {
                        fresh,
                        epoch: step.target,
                        old,
                        oldEpoch: node.keyEpoch,
                        rootedAt: parent.rootedAt,
                    });
                    return { rewrap: false, old: oldName, fresh: nameOf(fresh) };
                } catch (error) {
                    fresh.fill(0);
                    old.fill(0);
                    throw error;
                }
            }
            case 'commitPending':
            case 'dropPending': {
                for (const node of step.nodes)
                    for (const at of pendingFresh.keys())
                        if (at.startsWith(`${node}@`)) pendingFresh.delete(at);
                const ids = step.nodes.map(id);
                return {
                    count:
                        step.op === 'commitPending'
                            ? ledger.commitPending(AREA, ids)
                            : ledger.dropPending(AREA, ids),
                };
            }
            case 'keyAt': {
                const key = ledger.keyAtEpoch(AREA, id(step.node), step.epoch);
                return { key: key ? nameOf(key) : null };
            }
            case 'state': {
                const attempt = (read: () => number | null) => {
                    try {
                        return read();
                    } catch (error) {
                        return codeOf(error);
                    }
                };
                return {
                    isArea: ledger.isArea(AREA),
                    read: attempt(() => ledger.readVersion(AREA)),
                    write: attempt(() => ledger.writeVersion(AREA)),
                };
            }
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
