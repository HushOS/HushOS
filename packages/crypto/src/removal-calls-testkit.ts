import { areaRootCommitment } from './area-keys';
import { ROOT } from './device-record-testkit';
import {
    openDocument,
    openMetadata,
    openNodeKey,
    openPreviousRootKey,
    sealDocument,
    sealMetadata,
    wrapNodeKey,
    wrapPreviousRootKey,
} from './drive';
import { pattern } from './group-testkit';
import { parseRoster } from './groups';
import { decode, encode } from './keys';
import {
    areaKey,
    canonical,
    chainOf,
    family,
    grantKey,
    rootKey,
    session,
    unwire,
    verdict,
} from './roster-calls-testkit';
import type {
    AreaRotationInput,
    GrantWire,
    RosterCallBody,
    RotationWire,
    SignedStatementWire,
} from './session-groups';
import { openAreaSelfGrant } from './workspace';

/*
 * Removals, key replacements and folder deletions (groups 1d, Core 5b), for
 * the shared fixtures: the twin of crates/hushos-core/tests/common/removal_calls.rs,
 * over the family of roster-calls-testkit.ts. Each twin builds the same calls
 * on person 1's device (here the worker's groupStage kinds remove, markLeft,
 * rotate and retire, there the core's AreaLedger builders) with the same
 * folders gathered (each live folder's root under its fixed keys, A1's tags
 * sealed under its key and A3's junk nobody can open), and reads the other
 * twin's bodies through its own code:
 *
 * - `removalCalls`: each body verified as every member takes it (the 5a
 *   verdict), then each folder's new key opened from its grants (the roster's
 *   commitment names it) and from it the root's new key (the roster's root
 *   commitment), the root's old key under its previous-root label, the root's
 *   name, the self-grant, and every workspace document sealed again; the
 *   roster's area rows exactly what the call writes (one tombstone for a
 *   deletion, nothing else). A refusal must be the same sentence.
 * - `previousRoots`: route 25's served previous envelope checked by
 *   groupPreviousRoot (the core's previous_root_repair) on person 1's device.
 *   A repair needs an old key the device opened itself, which only a Drive
 *   rotation's commit leaves; each twin's unit tests hold that rule.
 */

type Json = Record<string, any>;

/* The roots of A1, A2 (deleted) and A3, each at its key epoch, at the area's latest listed version. */
const ROOTS = [
    '0e0e0e0e-0000-4000-8000-0000000000a1',
    '0e0e0e0e-0000-4000-8000-0000000000a2',
    '0e0e0e0e-0000-4000-8000-0000000000a3',
];
const ROOT_EPOCHS = [1, 1, 2];
const LATEST = [1, 1, 2];
const TARGET_EPOCH = 9;
const TAGS = '{"version":2,"tags":[{"id":"t1","name":"Recipes"}],"items":{}}';
/* The key epoch of a previous root key in route 25's cases, and that key. */
const PREVIOUS_EPOCH = 7;
const previousKey = () => pattern(32, 77);

/* One folder's rotation, gathered as the app gathers it for the call: the root as route 25 serves it, its documents. */
export async function rotationInput(index: number): Promise<AreaRotationInput> {
    const f = await family();
    const workspaceId = f.areas[index]!.workspaceId;
    const version = LATEST[index]!;
    const nodeId = ROOTS[index]!;
    const key = rootKey(index, version);
    const keyEnvelope = await wrapNodeKey(key, areaKey(index, version), {
        workspaceId,
        nodeId,
        parentId: workspaceId,
        parentKeyEpoch: version,
        keyEpoch: ROOT_EPOCHS[index]!,
    });
    const metadataEnvelope = await sealMetadata(
        { name: 'Family', mime: null, size: null, modified: null },
        key,
        { workspaceId, nodeId, metadataVersion: 1 },
    );
    const documents =
        index === 0
            ? [
                  {
                      kind: 'tags',
                      version: 3,
                      envelope: encode(
                          await sealDocument(JSON.parse(TAGS), areaKey(0, 1), {
                              workspaceId,
                              kind: 'tags',
                              version: 3,
                          }),
                      ),
                  },
              ]
            : [{ kind: 'tags', version: 1, envelope: encode(new Uint8Array(80).fill(7)) }];
    return {
        workspaceId,
        targetEpoch: TARGET_EPOCH,
        root: {
            id: nodeId,
            kind: 'folder',
            parentId: workspaceId,
            parentKeyEpoch: version + 1,
            keyEpoch: ROOT_EPOCHS[index]!,
            wrappedParentKeyEpoch: version,
            keyEnvelope: encode(keyEnvelope),
            metadataVersion: 1,
            metadataEnvelope: encode(metadataEnvelope),
            metadataSigner: null,
            metadataSignature: null,
            versions: [],
            shares: [],
            links: [],
            changeSeq: 4 + index,
        },
        documents,
    };
}

/* The calls, in the order both twins build them. */
export async function removalSpecs(): Promise<Json[]> {
    const f = await family();
    const u = (n: number) => f.p[n - 1]!.userId;
    const a = (index: number) => f.areas[index]!.workspaceId;
    const left = (n: number, roles: string[]) => ({ userId: u(n), status: 'left', roles });
    const grant = (n: number, index: number, version: number) => ({
        userId: u(n),
        workspaceId: a(index),
        version,
    });
    const sorted = (list: Json[]) => list.sort((x, y) => (canonical(x) < canonical(y) ? -1 : 1));
    const row = (index: number, version: number, retired = false) => ({
        workspaceId: a(index),
        version,
        retired,
    });
    const rotated = (index: number, documents: Json[]) => ({
        workspaceId: a(index),
        fromVersion: LATEST[index]!,
        toVersion: LATEST[index]! + 1,
        targetEpoch: TARGET_EPOCH,
        rootId: ROOTS[index],
        name: 'Family',
        // A root's metadata nobody signed is signed by the rotator (no origin to keep).
        record: 'signed',
        documents,
    });
    const a3 = rotated(2, [
        { kind: 'tags', version: 2, value: { version: 2, tags: [], items: {} } },
    ]);
    const both = [rotated(0, [{ kind: 'tags', version: 4, value: JSON.parse(TAGS) }]), a3].sort(
        (x, y) => (x.workspaceId < y.workspaceId ? -1 : 1),
    );
    const allRows = [row(0, 2), row(2, 3)];
    const replaced = [{ workspaceId: a(2), kind: 'tags' }];
    return [
        {
            name: 'remove-member',
            op: { kind: 'remove', who: 2 },
            replaced,
            expected: {
                route: { kind: 'remove', userId: u(2) },
                rosterVersion: 8,
                groupKeyVersion: 1,
                changed: [left(2, [])],
                keySeal: null,
                seals: [],
                grants: sorted([grant(1, 0, 2), grant(1, 2, 3), grant(3, 0, 2), grant(3, 2, 3)]),
                areas: allRows,
                rotations: both,
            },
        },
        {
            // A manager leaving takes the family's key with them: a succession, sealed to the rest.
            name: 'remove-manager',
            op: { kind: 'remove', who: 3 },
            replaced,
            expected: {
                route: { kind: 'remove', userId: u(3) },
                rosterVersion: 8,
                groupKeyVersion: 2,
                changed: [left(3, ['members'])],
                keySeal: null,
                seals: [u(1)],
                grants: sorted([grant(1, 0, 2), grant(1, 2, 3), grant(2, 0, 2), grant(2, 2, 3)]),
                areas: allRows,
                rotations: both,
            },
        },
        {
            name: 'mark-left',
            op: { kind: 'markLeft', who: [2] },
            replaced,
            expected: {
                route: { kind: 'rosters' },
                rosterVersion: 8,
                groupKeyVersion: 1,
                changed: [left(2, [])],
                keySeal: null,
                seals: [],
                grants: sorted([grant(1, 0, 2), grant(1, 2, 3), grant(3, 0, 2), grant(3, 2, 3)]),
                areas: allRows,
                rotations: both,
            },
        },
        {
            name: 'replace-keys',
            op: { kind: 'rotate', area: 2 },
            replaced,
            expected: {
                route: { kind: 'rotation', workspaceId: a(2) },
                rosterVersion: 8,
                groupKeyVersion: 1,
                changed: [],
                keySeal: null,
                seals: [],
                grants: sorted([grant(1, 2, 3), grant(2, 2, 3), grant(3, 2, 3)]),
                areas: [row(2, 3)],
                rotations: [a3],
            },
        },
        {
            // Exactly one tombstone: no key, no grant, no rotation, no other row.
            name: 'delete-folder',
            op: { kind: 'retire', area: 0 },
            replaced: [],
            expected: {
                route: { kind: 'delete', workspaceId: a(0) },
                rosterVersion: 8,
                groupKeyVersion: 1,
                changed: [],
                keySeal: null,
                seals: [],
                grants: [],
                areas: [row(0, 2, true)],
                rotations: [],
            },
        },
        {
            name: 'refused-a-folder-left-unrotated',
            op: { kind: 'remove', who: 2, rotate: [0] },
            refused: 'Every family folder must get new keys in this change.',
        },
        {
            name: 'refused-a-folder-rotated-twice',
            op: { kind: 'remove', who: 2, rotate: [0, 2, 2] },
            refused: 'Every family folder must get new keys in this change.',
        },
        {
            name: 'refused-a-deleted-folder-rotated',
            op: { kind: 'remove', who: 2, rotate: [0, 1, 2] },
            refused: 'Every family folder must get new keys in this change.',
        },
        {
            name: 'refused-replace-a-deleted-folder',
            op: { kind: 'rotate', area: 1 },
            refused: 'This folder is not on the family’s member list.',
        },
        {
            name: 'refused-delete-a-deleted-folder',
            op: { kind: 'retire', area: 1 },
            refused: 'This folder is not on the family’s member list.',
        },
        {
            name: 'refused-remove-someone-not-in',
            op: { kind: 'remove', who: 4 },
            refused: 'This person is not in the family now.',
        },
        {
            name: 'refused-folders-not-opened',
            op: { kind: 'remove', who: 2, noArea: true },
            refused: 'Open every family folder first.',
        },
    ];
}

/* One call through the worker on person 1's device: the staged body, its route and replaced documents, or the refusal's sentence. */
export async function removalRun(
    op: Json,
): Promise<{ body: RosterCallBody; route: Json; replaced: Json[] } | { refused: string }> {
    const f = await family();
    const call = await session(1, { seed: true, area: op.noArea !== true });
    const kems = Object.fromEntries(f.p.map((p) => [p.userId, p.served.kemPublicKey]));
    const u = (n: number) => f.p[n - 1]!.userId;
    const rotations = async () =>
        Promise.all(((op.rotate as number[] | undefined) ?? [0, 2]).map(rotationInput));
    let stageOp: Json;
    let route: Json;
    switch (op.kind) {
        case 'remove':
            stageOp = { kind: 'remove', userId: u(op.who), rotations: await rotations() };
            route = { kind: 'remove', userId: u(op.who) };
            break;
        case 'markLeft':
            stageOp = {
                kind: 'markLeft',
                userIds: (op.who as number[]).map(u),
                rotations: await rotations(),
            };
            route = { kind: 'rosters' };
            break;
        case 'rotate': {
            const rotation = await rotationInput(op.area);
            stageOp = { kind: 'rotate', rotation };
            route = { kind: 'rotation', workspaceId: rotation.workspaceId };
            break;
        }
        case 'retire': {
            const workspaceId = f.areas[op.area]!.workspaceId;
            stageOp = { kind: 'retire', workspaceId };
            route = { kind: 'delete', workspaceId };
            break;
        }
        default:
            throw new Error(String(op.kind));
    }
    try {
        const staged = await call('groupStage', {
            groupId: f.groupId,
            expectedRevision: 7,
            op: stageOp,
            kems,
        } as never);
        // Nothing staged (members to check first) is a bug in these cases, never a refusal.
        if (staged.outboxId === null) throw new Error('nothing staged');
        return { body: staged.body, route, replaced: staged.replaced };
    } catch (error) {
        return { refused: (error as Error).message };
    }
}

/* What a record carries after the rotation: an origin kept, a signature, or neither. */
function recordOf(rotated: Json) {
    if (rotated.metadataRekey) return 'rekey';
    return rotated.metadataSignature ? 'signed' : 'none';
}

/*
 * A body as every member takes it (the 5a verdict), and what the call's
 * folders open to from their new keys: the verdict both twins declare.
 */
export async function removalVerdict(doc: Json, route: Json, body: RosterCallBody) {
    const f = await family();
    const base = await verdict(doc, route, body);
    const groupId: string = doc.family.groupId;
    const history = (doc.family.rosters as SignedStatementWire[]).map(unwire);
    const roster = unwire(body.roster);
    const after = await chainOf(
        doc.family.firstKeys,
        groupId,
        [...history, roster],
        body.succession ? [unwire(body.succession)] : [],
    );
    const rows = parseRoster(roster.statement).areas ?? [];
    const areas = rows
        .map((row) => ({
            workspaceId: row.workspaceId,
            version: row.workspaceKeyVersion,
            retired: row.retired === true,
        }))
        .sort((x, y) => (canonical(x) < canonical(y) ? -1 : 1));
    // Every grantee of a folder's new key opens the same key: the one the roster commits to.
    const keys = new Map<string, Uint8Array>();
    for (const grant of (body.grants ?? []) as GrantWire[]) {
        const key = await grantKey(doc, after, grant, f.p[0]!);
        const slot = `${grant.workspaceId}:${grant.workspaceKeyVersion}`;
        const known = keys.get(slot);
        if (known && encode(known) !== encode(key))
            throw new Error('two grantees of one folder’s key opened different keys');
        keys.set(slot, key);
    }
    const wires: RotationWire[] = body.rotation ? [body.rotation] : (body.rotations ?? []);
    const rotations: Json[] = [];
    for (const wire of wires) {
        const index = f.areas.findIndex((area) => area.workspaceId === wire.workspaceId);
        if (index < 0) throw new Error('a rotation of a folder the family never had');
        const areaKey = keys.get(`${wire.workspaceId}:${wire.toVersion}`);
        if (!areaKey) throw new Error('a rotated folder’s new key granted to nobody');
        const row = rows.find(
            (at) =>
                at.workspaceId === wire.workspaceId && at.workspaceKeyVersion === wire.toVersion,
        );
        if (!row || row.retired) throw new Error('a rotation the roster does not list');
        const current = {
            workspaceId: wire.workspaceId,
            nodeId: wire.root.id,
            parentId: wire.workspaceId,
            parentKeyEpoch: wire.toVersion,
            keyEpoch: wire.targetEpoch,
        };
        const newRoot = await openNodeKey(decode(wire.root.keyEnvelope, 72), areaKey, current);
        if ((await areaRootCommitment(newRoot)) !== row.rootCommitment)
            throw new Error('the root’s new key is not the one the roster commits to');
        const old = await openPreviousRootKey(decode(wire.previousRootKeyEnvelope, 72), areaKey, {
            ...current,
            keyEpoch: ROOT_EPOCHS[index]!,
        });
        if (encode(old) !== encode(rootKey(index, wire.fromVersion)))
            throw new Error('the previous root key is not the root’s old key');
        const name = (
            await openMetadata(decode(wire.root.rotated!.metadataEnvelope), newRoot, {
                workspaceId: wire.workspaceId,
                nodeId: wire.root.id,
                metadataVersion: 1,
            })
        ).name;
        const self = await openAreaSelfGrant(ROOT, f.p[0]!.userId, groupId, wire.selfGrant);
        if (
            encode(self) !== encode(areaKey) ||
            wire.selfGrant.workspaceKeyVersion !== wire.toVersion
        )
            throw new Error('the self-grant is not of the folder’s new key');
        const documents: Json[] = [];
        for (const document of wire.documents)
            documents.push({
                kind: document.kind,
                version: document.version + 1,
                value: await openDocument(decode(document.envelope), areaKey, {
                    workspaceId: wire.workspaceId,
                    kind: document.kind,
                    version: document.version + 1,
                }),
            });
        rotations.push({
            workspaceId: wire.workspaceId,
            fromVersion: wire.fromVersion,
            toVersion: wire.toVersion,
            targetEpoch: wire.targetEpoch,
            rootId: wire.root.id,
            name,
            record: recordOf(wire.root.rotated!),
            documents,
        });
    }
    rotations.sort((x, y) => (x.workspaceId < y.workspaceId ? -1 : 1));
    return { ...base, areas, rotations };
}

/* Route 25's previous envelopes on person 1's device, in the order both twins build them. */
export function previousRootSpecs(): Json[] {
    return [
        { name: 'no-envelope', area: 0, envelope: 'none', expected: { status: 'none' } },
        {
            name: 'under-another-version',
            area: 0,
            envelope: 'previous',
            prevParentKeyEpoch: 2,
            expected: { status: 'none' },
        },
        { name: 'opens', area: 0, envelope: 'previous', expected: { status: 'opens' } },
        {
            // The root's key under the plain node label opens as no previous key.
            name: 'a-plain-node-key',
            area: 0,
            envelope: 'node',
            expected: { status: 'cannot' },
        },
        { name: 'junk', area: 2, envelope: 'junk', expected: { status: 'cannot' } },
        {
            name: 'a-deleted-folder',
            area: 1,
            envelope: 'previous',
            expected: { status: 'refused', message: 'Open every family folder first.' },
        },
    ];
}

/* A spec's served envelope, as this twin seals it (base64url, or null for none). */
export async function previousEnvelope(spec: Json): Promise<string | null> {
    const f = await family();
    const workspaceId = f.areas[spec.area]!.workspaceId;
    const version = LATEST[spec.area]!;
    const ctx = {
        workspaceId,
        nodeId: ROOTS[spec.area]!,
        parentId: workspaceId,
        parentKeyEpoch: version,
        keyEpoch: PREVIOUS_EPOCH,
    };
    switch (spec.envelope) {
        case 'none':
            return null;
        case 'previous':
            return encode(
                await wrapPreviousRootKey(previousKey(), areaKey(spec.area, version), ctx),
            );
        case 'node':
            return encode(await wrapNodeKey(previousKey(), areaKey(spec.area, version), ctx));
        case 'junk':
            return encode(new Uint8Array(72).fill(9));
        default:
            throw new Error(String(spec.envelope));
    }
}

/* A served envelope checked by groupPreviousRoot on person 1's device: its outcome. */
export async function previousRootRun(spec: Json, envelope: string | null): Promise<Json> {
    const f = await family();
    const call = await session(1, { seed: true, area: true });
    const version = LATEST[spec.area]!;
    try {
        const result = await call('groupPreviousRoot', {
            groupId: f.groupId,
            workspaceId: f.areas[spec.area]!.workspaceId,
            root: {
                id: ROOTS[spec.area]!,
                parentKeyEpoch: version,
                prevKeyEnvelope: envelope,
                prevKeyEpoch: PREVIOUS_EPOCH,
                prevParentKeyEpoch: spec.prevParentKeyEpoch ?? version,
            },
        });
        return { status: result.status };
    } catch (error) {
        return { status: 'refused', message: (error as Error).message };
    }
}

/* This twin's Core 5b sections, each case checked against its declaration. */
export async function fixture(doc: Json) {
    const calls: Json[] = [];
    for (const spec of await removalSpecs()) {
        const out: Json = { ...spec };
        const result = await removalRun(spec.op);
        if ('refused' in result) {
            if (result.refused !== spec.refused)
                throw new Error(`${spec.name}: refused with ${result.refused}`);
            out.body = null;
        } else {
            if (spec.refused) throw new Error(`${spec.name}: built`);
            if (canonical(result.replaced) !== canonical(spec.replaced))
                throw new Error(`${spec.name}: replaced ${JSON.stringify(result.replaced)}`);
            const said = await removalVerdict(doc, result.route, result.body);
            if (canonical(said) !== canonical(spec.expected))
                throw new Error(`${spec.name}: ${JSON.stringify(said)}`);
            out.body = result.body;
        }
        calls.push(out);
    }
    const roots: Json[] = [];
    for (const spec of previousRootSpecs()) {
        const envelope = await previousEnvelope(spec);
        const outcome = await previousRootRun(spec, envelope);
        if (canonical(outcome) !== canonical(spec.expected))
            throw new Error(`${spec.name}: ${JSON.stringify(outcome)}`);
        roots.push({ ...spec, served: envelope });
    }
    return { removalCalls: calls, previousRoots: roots };
}

/* The other twin's Core 5b sections through this one: every outcome the same (thrown otherwise). */
export async function check(doc: Json) {
    const specs = await removalSpecs();
    if (
        canonical(specs.map((s) => s.name)) !==
        canonical((doc.removalCalls as Json[]).map((c) => c.name))
    )
        throw new Error('the same removal calls in the same order');
    for (const c of doc.removalCalls as Json[]) {
        const spec = specs.find((s) => s.name === c.name)!;
        if (c.body === null) {
            if (c.refused !== spec.refused) throw new Error(`${c.name}: another refusal`);
            const here = await removalRun(spec.op);
            if (!('refused' in here) || here.refused !== spec.refused)
                throw new Error(`${c.name}: not refused alike here`);
            continue;
        }
        if (canonical(c.expected) !== canonical(spec.expected))
            throw new Error(`${c.name}: declared otherwise`);
        const said = await removalVerdict(doc, c.expected.route, c.body);
        if (canonical(said) !== canonical(spec.expected))
            throw new Error(`${c.name}: ${JSON.stringify(said)}`);
    }
    const rootSpecs = previousRootSpecs();
    if (
        canonical(rootSpecs.map((s) => s.name)) !==
        canonical((doc.previousRoots as Json[]).map((c) => c.name))
    )
        throw new Error('the same previous roots in the same order');
    for (const theirs of doc.previousRoots as Json[]) {
        const spec = rootSpecs.find((s) => s.name === theirs.name)!;
        const outcome = await previousRootRun(spec, theirs.served);
        if (canonical(outcome) !== canonical(spec.expected))
            throw new Error(`${spec.name}: ${JSON.stringify(outcome)}`);
    }
}
