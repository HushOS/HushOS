import { createAreaLedger, type AreaLedger } from './area-ledger';
import {
    contentKeyContext,
    metadataContext,
    originOpeningKey,
    rekeyEnvelope,
    sealMetadata,
    sealVersion,
    wrapNodeKey,
    wrapOriginKey,
    wrapPreviousRootKey,
} from './drive';
import { CryptoError } from './errors';
import type { AcceptedRosters, GroupIntegrity } from './group-trust';
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
    type Person,
} from './group-testkit';
import { recordVerdicts } from './group-verdicts';
import { decode, encode } from './keys';
import { KEY_CHANGE_PENDING } from './protocol';
import { rekeyNode, type RotateNodeInput, type ServedRekey } from './rotation-records';
import { rekeyOnly, servedRekeyedRecord, type GroupWriter } from './session-groups';
import {
    metadataRekeyedStatement,
    metadataStatementAs,
    metadataStatements,
    signStatement,
    versionRekeyedStatement,
    versionStatementAs,
    versionStatements,
    type MetadataStatement,
    type NodeKind,
    type TrustedSigner,
    type VersionStatement,
} from './signatures';

/*
 * A family folder's walk, node by node, for the shared fixtures
 * (scripts/area-ledger-fixtures.ts writes what the web rotated, and
 * area-ledger-fixtures.test.ts reads what the core rotated). The twin is
 * crates/hushos-core/tests/common/rotations.rs: both build the same cases in
 * the same order from the same keys (the shared people of group-testkit.ts,
 * the named keys of the area-ledger scenarios), walk each case's nodes in
 * order with their own walk (the worker's ledger rotateKey with
 * rotation-records.ts's rekeyNode; the core's AreaLedger::rotate_node), and
 * read the other twin's walked nodes with their own verdicts
 * (group-verdicts.ts; AreaLedger::record_verdict) on a fresh member's ledger.
 * Both declare each case's verdicts, which records are re-keyed, re-sealed or
 * dropped, what may be written after the walk, and the core's one refusal
 * the web does not make (a node with shares or links in a family folder:
 * the web re-seals them).
 *
 * The family: person 1 manages it, 2 writes, 3 was removed at roster 2 (the
 * area's key version 2), 4 reads. AREA's top level is ROOT, with root:1
 * before the removal and root:2 after (option A's previous key under area:2).
 */

export const ROOT = '0e0e0e0e-0000-4000-8000-000000000001';
export const FILE = '0e0e0e0e-0000-4000-8000-000000000002';
export const FOLDER = '0e0e0e0e-0000-4000-8000-000000000003';
export const CHILD_A = '0e0e0e0e-0000-4000-8000-000000000004';
export const CHILD_B = '0e0e0e0e-0000-4000-8000-000000000005';
export const STALE = '0e0e0e0e-0000-4000-8000-000000000006';
const SHARE = '5a5a5a5a-0000-4000-8000-000000000001';
const LINK = '1e1e1e1e-0000-4000-8000-000000000001';
/* The core's refusal of a node with shares or links in a family folder (area_ledger.rs). */
export const SHARED_IN_FAMILY =
    'This item has shares or links, which a family folder never has, so it was not re-keyed.';
const versionId = (n: number) => `5e5e5e5e-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const objectId = (n: number) => `0b0b0b0b-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
/* The scenarios' named keys: k:n is pattern(32, 200 + n). */
const key = (n: number) => pattern(32, 200 + n);
const e = (bytes: Uint8Array) => encode(bytes);

type Doc = Record<string, unknown>;

let built: Promise<{ people: Person[]; chain: AcceptedRosters }> | undefined;
/* The family's chain: roster 1 with everyone at area version 1, roster 2 removing person 3 at version 2. */
export function family() {
    built ??= (async () => {
        const people = await Promise.all([1, 2, 3, 4].map((n) => person(n)));
        const [p1, p2, p3, p4] = people as [Person, Person, Person, Person];
        const h = await history('family', { format: 2 });
        const everyone = (removed: boolean) =>
            [
                p1.entry(['billing', 'members']),
                p2.entry([]),
                removed ? p3.entry([], 2, 'left') : p3.entry([]),
                p4.entry([]),
            ].sort((a, b) => a.userId.localeCompare(b.userId));
        await h.roster(p1, everyone(false), undefined, [await keyRowAt(AREA, 1)]);
        await h.roster(p1, everyone(true), undefined, [await keyRowAt(AREA, 2)]);
        return { people, chain: await acceptedOf(h, people) };
    })();
    return built;
}

/* A member's ledger: the chain committed, the area opened at version 2, its top level listed. */
async function memberLedger(chain: AcceptedRosters) {
    const ledger = createAreaLedger();
    ledger.commit(chain);
    await ledger.openArea(GROUP, AREA, AREA_SEED, 2, areaKeyAt(AREA, 2), 2);
    const ctx = { workspaceId: AREA, nodeId: ROOT, parentId: AREA, parentKeyEpoch: 2, keyEpoch: 2 };
    await ledger.openListedNode(AREA, {
        id: ROOT,
        parentId: AREA,
        parentKeyEpoch: 2,
        keyEpoch: 2,
        keyEnvelope: e(await wrapNodeKey(rootKeyAt(AREA, 2), areaKeyAt(AREA, 2), ctx)),
        prevKeyEnvelope: e(
            await wrapPreviousRootKey(rootKeyAt(AREA, 1), areaKeyAt(AREA, 2), {
                ...ctx,
                keyEpoch: 1,
            }),
        ),
        prevKeyEpoch: 1,
        prevParentKeyEpoch: 2,
    });
    return ledger;
}

const metadataStatement = (nodeId: string, kind: NodeKind): MetadataStatement => ({
    workspaceId: AREA,
    nodeId,
    kind,
    metadataVersion: 1,
});
const versionStatement = (nodeId: string, n: number): VersionStatement => ({
    workspaceId: AREA,
    nodeId,
    versionId: versionId(n),
    objectId: objectId(n),
    contentSuite: 3,
});
const versionCtx = (nodeId: string, n: number) => ({
    workspaceId: AREA,
    nodeId,
    versionId: versionId(n),
    objectId: objectId(n),
    suite: 3,
});

type Version = RotateNodeInput['versions'][number];

/* Version `n` of `nodeId` sealed under `under` (content key filled with n), signed by `by` when given. */
async function versionBy(
    nodeId: string,
    n: number,
    under: Uint8Array,
    by: Person | null,
): Promise<Version> {
    const envelope = await sealVersion(
        { contentKey: new Uint8Array(32).fill(n), plaintextSize: 100 * n, thumbnailBytes: 0 },
        under,
        versionCtx(nodeId, n),
    );
    return {
        id: versionId(n),
        objectId: objectId(n),
        contentKeyEnvelope: e(envelope),
        contentSuite: 3,
        plaintextSize: null,
        signer: by?.userId ?? null,
        signature: by
            ? e(
                  await signStatement(
                      await versionStatementAs('ordinary', versionStatement(nodeId, n), envelope),
                      by.signer.signingKey,
                  ),
              )
            : null,
    };
}

/*
 * Version `n` of `nodeId` as an earlier walk from epoch 1 (key `first`) to 2
 * (key `now`) left it: written by `writer` under `first`, re-keyed raw under
 * `now` and attested by `rekeyer` at epoch 2.
 */
async function versionRekeyed(
    nodeId: string,
    n: number,
    first: Uint8Array,
    now: Uint8Array,
    writer: Person,
    rekeyer: Person,
): Promise<Version> {
    const written = await versionBy(nodeId, n, first, writer);
    const origin = decode(written.contentKeyEnvelope);
    const envelope = await rekeyEnvelope(
        origin,
        first,
        now,
        contentKeyContext(versionCtx(nodeId, n)),
    );
    const keyEnvelope = await wrapOriginKey(originOpeningKey(origin, first), now, {
        workspaceId: AREA,
        nodeId,
        keyEpoch: 2,
        record: { kind: 'version', versionId: versionId(n) },
        originEnvelope: origin,
    });
    const statement = await versionRekeyedStatement(
        { ...versionStatement(nodeId, n), keyEpoch: 2 },
        envelope,
        {
            envelope: origin,
            signerId: writer.userId,
            signature: decode(written.signature!),
            keyEnvelope,
        },
    );
    return {
        ...written,
        contentKeyEnvelope: e(envelope),
        signer: rekeyer.userId,
        signature: null,
        rekey: {
            origin: {
                envelope: e(origin),
                signerId: writer.userId,
                signature: written.signature!,
                keyEnvelope: e(keyEnvelope),
            },
            signature: e(await signStatement(statement, rekeyer.signer.signingKey)),
        },
    };
}

/* A node: its key `nodeKey` at `keyEpoch`, wrapped under `parentKey` at `wrappedParentKeyEpoch`, named by `by`. */
async function makeNode(o: {
    id: string;
    kind: NodeKind;
    parentId: string;
    parentKey: Uint8Array;
    wrappedParentKeyEpoch: number;
    /* The parent epoch the walk wraps the fresh key under. */
    parentKeyEpoch: number;
    nodeKey: Uint8Array;
    keyEpoch: number;
    by: Person | null;
    versions: Version[];
}): Promise<RotateNodeInput> {
    const envelope = await sealMetadata(
        {
            name: o.kind === 'folder' ? 'Plans' : 'plan.txt',
            mime: null,
            size: null,
            modified: null,
        },
        o.nodeKey,
        { workspaceId: AREA, nodeId: o.id, metadataVersion: 1 },
    );
    return {
        id: o.id,
        kind: o.kind,
        parentId: o.parentId,
        parentKeyEpoch: o.parentKeyEpoch,
        keyEpoch: o.keyEpoch,
        wrappedParentKeyEpoch: o.wrappedParentKeyEpoch,
        keyEnvelope: e(
            await wrapNodeKey(o.nodeKey, o.parentKey, {
                workspaceId: AREA,
                nodeId: o.id,
                parentId: o.parentId,
                parentKeyEpoch: o.wrappedParentKeyEpoch,
                keyEpoch: o.keyEpoch,
            }),
        ),
        metadataVersion: 1,
        metadataEnvelope: e(envelope),
        metadataSigner: o.by?.userId ?? null,
        metadataSignature: o.by
            ? e(
                  await signStatement(
                      await metadataStatementAs(
                          'ordinary',
                          metadataStatement(o.id, o.kind),
                          envelope,
                      ),
                      o.by.signer.signingKey,
                  ),
              )
            : null,
        versions: o.versions,
        shares: [],
        links: [],
    };
}

/* The file at `keyEpoch` (key `nodeKey`) under the top level's key at `parentEpoch`, named by `by`. */
function fileNode(
    nodeKey: Uint8Array,
    keyEpoch: number,
    parentEpoch: number,
    by: Person | null,
    versions: Version[],
) {
    return makeNode({
        id: FILE,
        kind: 'file',
        parentId: ROOT,
        parentKey: rootKeyAt(AREA, parentEpoch),
        wrappedParentKeyEpoch: parentEpoch,
        parentKeyEpoch: 2,
        nodeKey,
        keyEpoch,
        by,
        versions,
    });
}

/*
 * The node with its metadata as an earlier walk from epoch 1 (key `first`)
 * to 2 (key `now`) left it: named by `writer` under `first`, re-keyed raw
 * under `now` and attested by `rekeyer` at epoch 2.
 */
async function withMetadataRekeyed(
    node: RotateNodeInput,
    first: Uint8Array,
    now: Uint8Array,
    writer: Person,
    rekeyer: Person,
): Promise<RotateNodeInput> {
    const ctx = { workspaceId: AREA, nodeId: node.id, metadataVersion: 1 };
    const statementOf = metadataStatement(node.id, node.kind);
    const origin = await sealMetadata(
        { name: 'plan.txt', mime: null, size: null, modified: null },
        first,
        ctx,
    );
    const signature = await signStatement(
        await metadataStatementAs('ordinary', statementOf, origin),
        writer.signer.signingKey,
    );
    const envelope = await rekeyEnvelope(origin, first, now, metadataContext(ctx));
    const keyEnvelope = await wrapOriginKey(originOpeningKey(origin, first), now, {
        workspaceId: AREA,
        nodeId: node.id,
        keyEpoch: 2,
        record: { kind: 'metadata', metadataVersion: 1 },
        originEnvelope: origin,
    });
    const statement = await metadataRekeyedStatement({ ...statementOf, keyEpoch: 2 }, envelope, {
        envelope: origin,
        signerId: writer.userId,
        signature,
        keyEnvelope,
    });
    return {
        ...node,
        metadataEnvelope: e(envelope),
        metadataSigner: rekeyer.userId,
        metadataSignature: null,
        metadataRekey: {
            origin: {
                envelope: e(origin),
                signerId: writer.userId,
                signature: e(signature),
                keyEnvelope: e(keyEnvelope),
            },
            signature: e(await signStatement(statement, rekeyer.signer.signingKey)),
        },
    };
}

/* A child listed after the walk, written under its folder's old key: what a removed member could plant. */
export type StaleChild = {
    id: string;
    parentId: string;
    parentKeyEpoch: number;
    keyEpoch: number;
    keyEnvelope: string;
};

/*
 * A case as both twins declare it: the nodes walked in order, who walks and
 * reads, what each node's records are and read as (per node, metadata
 * first), or the core's refusal (`refused`, its exact message) with what the
 * web re-seals instead (`webReseals`); and, after the walk, whether the first
 * child walked is writable and a stale child (and anything under it) is not.
 */
export type RotationCase = {
    name: string;
    walker: number;
    reader: number;
    target: number;
    nodes: RotateNodeInput[];
    shapes: string[][];
    /* For a node only re-wrapped: the named key it holds. */
    key?: string;
    refused?: string;
    webReseals?: { shares: number; links: number };
    stale?: StaleChild;
    writes?: { walked: string; stale: string; under: string };
    expected: Doc[][];
};

const side = (integrity: GroupIntegrity, via = false) => ({ integrity, via: via ? GROUP : null });
const rekeyedVerdict = (
    origin: ReturnType<typeof side>,
    rekeyer: ReturnType<typeof side>,
    bound: boolean | null,
) => ({ kind: 'rekeyed', origin, rekeyer, bound });
const signedVerdict = (integrity: GroupIntegrity) => ({ kind: 'signed', ...side(integrity) });

/* The shared cases, in the order rotations.rs builds them. */
export async function rotationCases(): Promise<RotationCase[]> {
    const { people } = await family();
    const [p1, p2, p3] = people as [Person, Person, Person];
    const unbound = await versionRekeyed(FILE, 4, key(0), key(1), p2, p1);
    // Its current bytes are not its origin's: an earlier walker sealed something else.
    unbound.contentKeyEnvelope = e(
        await sealVersion(
            { contentKey: new Uint8Array(32).fill(9), plaintextSize: 1, thumbnailBytes: 0 },
            key(1),
            versionCtx(FILE, 4),
        ),
    );
    const gone = await versionRekeyed(FILE, 3, key(0), key(1), p2, p1);
    gone.rekey!.origin.signerId = null;
    // A version whose writer's account is gone: the signature stays, the signer is served as nobody.
    const writerGone = await versionBy(FILE, 23, key(1), p2);
    writerGone.signer = null;
    const folder = await makeNode({
        id: FOLDER,
        kind: 'folder',
        parentId: ROOT,
        parentKey: rootKeyAt(AREA, 1),
        wrappedParentKeyEpoch: 1,
        parentKeyEpoch: 2,
        nodeKey: key(2),
        keyEpoch: 1,
        by: p2,
        versions: [],
    });
    // The folder's children: wrapped under its key at epoch 1 now, under its walk's pending key next.
    const child = (id: string, nodeKey: Uint8Array, by: Person, versions: Version[]) =>
        makeNode({
            id,
            kind: 'file',
            parentId: FOLDER,
            parentKey: key(2),
            wrappedParentKeyEpoch: 1,
            parentKeyEpoch: 2,
            nodeKey,
            keyEpoch: 1,
            by,
            versions,
        });
    const shared = await fileNode(key(1), 1, 1, p2, []);
    shared.shares = [
        {
            id: SHARE,
            granteeUserId: p3.userId,
            granteePublicKey: p3.served.encryptionPublicKey,
            granteeKemPublicKey: p3.served.kemPublicKey,
        },
    ];
    const linked = await fileNode(key(1), 1, 1, p2, []);
    linked.links = [{ id: LINK, hasPassword: false, secretEnvelope: null }];
    return [
        {
            name: 'a removal walk keeps every writer record',
            walker: 1,
            reader: 4,
            target: 2,
            nodes: [
                await fileNode(key(1), 1, 1, p3, [
                    await versionBy(FILE, 1, key(1), p2),
                    await versionBy(FILE, 5, key(1), null),
                ]),
            ],
            shapes: [['rekeyed', 'rekeyed', 'resealed']],
            expected: [
                [
                    rekeyedVerdict(side('former-member'), side('verified', true), true),
                    rekeyedVerdict(side('verified', true), side('verified', true), true),
                    signedVerdict('resealed'),
                ],
            ],
        },
        {
            name: 'a second walk carries a bound origin and drops the rest',
            walker: 4,
            reader: 1,
            target: 3,
            nodes: [
                await withMetadataRekeyed(
                    await fileNode(key(1), 2, 1, null, [
                        await versionRekeyed(FILE, 2, key(0), key(1), p2, p1),
                        gone,
                        unbound,
                    ]),
                    key(0),
                    key(1),
                    p2,
                    p1,
                ),
            ],
            shapes: [['rekeyed', 'rekeyed', 'dropped', 'dropped']],
            expected: [
                [
                    rekeyedVerdict(side('verified', true), side('verified', true), true),
                    rekeyedVerdict(side('verified', true), side('verified', true), true),
                    signedVerdict('resealed'),
                    signedVerdict('resealed'),
                ],
            ],
        },
        {
            // Its own re-key and re-seal judged by its own keys, the writers' records by the roster.
            name: 'the walker reads its own walk',
            walker: 1,
            reader: 1,
            target: 2,
            nodes: [
                await fileNode(key(1), 1, 1, p3, [
                    await versionBy(FILE, 1, key(1), p2),
                    await versionBy(FILE, 5, key(1), null),
                ]),
            ],
            shapes: [['rekeyed', 'rekeyed', 'resealed']],
            expected: [
                [
                    rekeyedVerdict(side('former-member'), side('verified'), true),
                    rekeyedVerdict(side('verified', true), side('verified'), true),
                    signedVerdict('resealed'),
                ],
            ],
        },
        {
            name: 'a node already at the target is only re-wrapped',
            walker: 1,
            reader: 2,
            target: 3,
            nodes: [await fileNode(key(4), 3, 2, p2, [])],
            shapes: [[]],
            key: 'k:4',
            expected: [[]],
        },
        {
            name: 'a folder walk wraps its children under its pending key',
            walker: 1,
            reader: 4,
            target: 2,
            nodes: [
                folder,
                await child(CHILD_A, key(3), p2, [await versionBy(CHILD_A, 11, key(3), p2)]),
                await child(CHILD_B, key(5), p3, [await versionBy(CHILD_B, 12, key(5), null)]),
            ],
            shapes: [['rekeyed'], ['rekeyed', 'rekeyed'], ['rekeyed', 'resealed']],
            stale: {
                id: STALE,
                parentId: FOLDER,
                parentKeyEpoch: 1,
                keyEpoch: 1,
                keyEnvelope: e(
                    await wrapNodeKey(key(6), key(2), {
                        workspaceId: AREA,
                        nodeId: STALE,
                        parentId: FOLDER,
                        parentKeyEpoch: 1,
                        keyEpoch: 1,
                    }),
                ),
            },
            writes: {
                walked: 'writable',
                stale: 'key-change-pending',
                under: 'key-change-pending',
            },
            expected: [
                [rekeyedVerdict(side('verified', true), side('verified', true), true)],
                [
                    rekeyedVerdict(side('verified', true), side('verified', true), true),
                    rekeyedVerdict(side('verified', true), side('verified', true), true),
                ],
                [
                    rekeyedVerdict(side('former-member'), side('verified', true), true),
                    signedVerdict('resealed'),
                ],
            ],
        },
        {
            name: 'a file with three versions, one by a writer since gone',
            walker: 1,
            reader: 4,
            target: 2,
            nodes: [
                await fileNode(key(1), 1, 1, p2, [
                    await versionBy(FILE, 21, key(1), p2),
                    await versionBy(FILE, 22, key(1), p3),
                    writerGone,
                ]),
            ],
            shapes: [['rekeyed', 'rekeyed', 'rekeyed', 'resealed']],
            expected: [
                [
                    rekeyedVerdict(side('verified', true), side('verified', true), true),
                    rekeyedVerdict(side('verified', true), side('verified', true), true),
                    rekeyedVerdict(side('former-member'), side('verified', true), true),
                    signedVerdict('resealed'),
                ],
            ],
        },
        {
            name: 'a shared node in a family folder is refused by the core',
            walker: 1,
            reader: 4,
            target: 2,
            nodes: [shared],
            shapes: [],
            refused: SHARED_IN_FAMILY,
            webReseals: { shares: 1, links: 0 },
            expected: [],
        },
        {
            name: 'a linked node in a family folder is refused by the core',
            walker: 1,
            reader: 4,
            target: 2,
            nodes: [linked],
            shapes: [],
            refused: SHARED_IN_FAMILY,
            webReseals: { shares: 0, links: 1 },
            expected: [],
        },
    ];
}

/* A rotated record as both twins write it. */
type RecordOut = {
    envelope: string;
    signature: string | null;
    rekey: { originKeyEnvelope: string; signature: string } | null;
    dropOrigin: boolean;
};
export type Rotated = {
    id: string;
    keyEnvelope: string;
    rewrap: boolean;
    metadata: RecordOut | null;
    versions: (RecordOut & { id: string })[];
    shares: number;
    links: number;
};
const shapeOf = (record: RecordOut) =>
    record.rekey ? 'rekeyed' : record.dropOrigin ? 'dropped' : 'resealed';

/* A refusal's code, as the area-ledger scenarios compare them. */
function codeOf(error: unknown) {
    if (!(error instanceof CryptoError)) throw error;
    return error.message === KEY_CHANGE_PENDING ? 'key-change-pending' : 'refused';
}

/*
 * The case's nodes walked in order on a member's ledger by its walker, as
 * this twin's walk does it: the worker's rotateKey with rekeyNode's records
 * (a family folder's judge), then the batch committed. Then, for a case with
 * a stale child, what may be written: the first child walked, the stale
 * child, and a new node under it. Returns each node rotated, each node's key
 * at the target (for the fuzz seeds), and the writes.
 */
export async function walk(c: RotationCase) {
    const { people, chain } = await family();
    const walker = people[c.walker - 1]!;
    const ledger = await memberLedger(chain);
    for (const node of c.nodes)
        await ledger.openListedNode(AREA, {
            id: node.id,
            parentId: node.parentId,
            parentKeyEpoch: node.wrappedParentKeyEpoch,
            keyEpoch: node.keyEpoch,
            keyEnvelope: node.keyEnvelope,
        });
    const out: Rotated[] = [];
    for (const node of c.nodes) {
        const rotated = await ledger.rotateKey(AREA, node, c.target, ({ old, fresh, parentKey }) =>
            rekeyNode({
                workspaceId: AREA,
                targetEpoch: c.target,
                granterUserId: walker.userId,
                node,
                judge: rekeyOnly,
                old,
                fresh,
                parentKey,
                ownerKind: 'group',
                signer: () => ({
                    userId: walker.userId,
                    signingKey: walker.signer.signingKey,
                    hybridKeys: () => walker.signer,
                }),
            }),
        );
        if (rotated.rewrap) {
            out.push({
                id: node.id,
                keyEnvelope: e(rotated.keyEnvelope),
                rewrap: true,
                metadata: null,
                versions: [],
                shares: 0,
                links: 0,
            });
            rotated.key.fill(0);
            continue;
        }
        const r = rotated.result;
        const recordOf = (
            envelope: string,
            signature: string | null,
            rekey: RecordOut['rekey'] | undefined,
            dropOrigin: true | undefined,
        ): RecordOut => ({
            envelope,
            signature,
            rekey: rekey ?? null,
            dropOrigin: dropOrigin === true,
        });
        out.push({
            id: node.id,
            keyEnvelope: r.keyEnvelope,
            rewrap: false,
            metadata: recordOf(
                r.metadataEnvelope,
                r.metadataSignature,
                r.metadataRekey,
                r.metadataDropOrigin,
            ),
            versions: r.versions.map((v) => ({
                id: v.id,
                ...recordOf(v.contentKeyEnvelope, v.signature, v.rekey, v.dropOrigin),
            })),
            shares: r.shares.length,
            links: r.links.length,
        });
    }
    ledger.commitPending(
        AREA,
        c.nodes.map((node) => node.id),
    );
    const nodeKeys = out.map((r, i) =>
        r.rewrap ? null : e(ledger.keyAtEpoch(AREA, c.nodes[i]!.id, c.target)!),
    );
    let writes: RotationCase['writes'];
    if (c.stale) {
        const attempt = (write: () => unknown) => {
            try {
                return write() === undefined ? 'none' : 'writable';
            } catch (error) {
                return codeOf(error);
            }
        };
        await ledger.openListedNode(AREA, c.stale);
        const walked = attempt(() => ledger.writableNodeKey(AREA, c.nodes[1]!.id));
        const stale = attempt(() => ledger.writableNodeKey(AREA, c.stale!.id));
        let under: string;
        try {
            await ledger.newNodeKey(AREA, {
                id: '0e0e0e0e-0000-4000-8000-000000000007',
                parentId: c.stale.id,
                parentKeyEpoch: c.stale.keyEpoch,
                keyEpoch: 1,
            });
            under = 'writable';
        } catch (error) {
            under = codeOf(error);
        }
        writes = { walked, stale, under };
    }
    return { rotated: out, nodeKeys, writes };
}

/* What each walked node's records are, in order, as the case declares them. */
export function shapesOf(rotated: Rotated[]) {
    return rotated.map((r) =>
        r.rewrap ? [] : [r.metadata!, ...r.versions].map((record) => shapeOf(record)),
    );
}

/*
 * The records of each walked node as a listing serves them once the server
 * stored the walk: each re-keyed record with the origin the server keeps (the
 * one it carried, or the writer's record itself) and the walker as signer.
 */
export function servedAfter(c: RotationCase, rotated: Rotated[], walkerId: string): Doc[][] {
    return rotated.map((r, index) => {
        if (r.rewrap) return [];
        const n = c.nodes[index]!;
        const keptOf = (
            envelope: string,
            signer: string | null,
            signature: string | null,
            rekey: ServedRekey | null | undefined,
        ) =>
            rekey
                ? rekey.origin
                : signer && signature
                  ? { envelope, signerId: signer, signature, keyEnvelope: '' }
                  : null;
        const served = (statement: Doc, record: RecordOut, kept: ServedRekey['origin'] | null) => ({
            ...statement,
            keyEpoch: c.target,
            envelope: record.envelope,
            signer: walkerId,
            signature: record.signature,
            rekey: record.rekey
                ? {
                      origin: { ...kept!, keyEnvelope: record.rekey.originKeyEnvelope },
                      signature: record.rekey.signature,
                  }
                : null,
        });
        return [
            served(
                { record: 'metadata', statement: metadataStatement(n.id, n.kind) },
                r.metadata!,
                keptOf(n.metadataEnvelope, n.metadataSigner, n.metadataSignature, n.metadataRekey),
            ),
            ...r.versions.map((v, i) => {
                const before = n.versions[i]!;
                return served(
                    {
                        record: 'version',
                        statement: versionStatement(n.id, Number.parseInt(before.id.slice(24), 16)),
                    },
                    v,
                    keptOf(
                        before.contentKeyEnvelope,
                        before.signer,
                        before.signature,
                        before.rekey,
                    ),
                );
            }),
        ];
    });
}

/*
 * The walked nodes read by the case's reader on a fresh member's ledger, each
 * new key listed from the walk's envelope under its parent (a child under its
 * folder's new key): each served record's verdict, as the group session's
 * groupVerify gives it, and the key held for the first node (named when it is
 * one).
 */
export async function readBack(c: RotationCase, rotated: Rotated[], served: Doc[][]) {
    const { people, chain } = await family();
    const ledger: AreaLedger = await memberLedger(chain);
    const held: Uint8Array[] = [];
    for (const [index, r] of rotated.entries()) {
        const node = c.nodes[index]!;
        held.push(
            await ledger.openListedNode(AREA, {
                id: node.id,
                parentId: node.parentId,
                parentKeyEpoch: node.parentKeyEpoch,
                keyEpoch: r.rewrap ? node.keyEpoch : c.target,
                keyEnvelope: r.keyEnvelope,
            }),
        );
    }
    const reader = people[c.reader - 1]!;
    const writers: GroupWriter[] = people.map((p) => ({
        userId: p.userId,
        pinned: null,
        served: null,
        links: null,
        personal: { current: p.served.signingPublicKey, retired: [] },
    }));
    const trusted = new Map<string, TrustedSigner>(
        people.map((p) => [p.userId, { current: decode(p.served.signingPublicKey), retired: [] }]),
    );
    const verdict = recordVerdicts({
        groupId: GROUP,
        workspaceId: AREA,
        reading: { status: 'accepted', chain },
        writers,
        trusted,
        me: reader.userId,
        areas: { [AREA]: 2 },
        verified: new Map(),
    });
    const verdicts: Doc[][] = [];
    for (const records of served as {
        record: 'metadata' | 'version';
        statement: MetadataStatement | VersionStatement;
        keyEpoch: number;
        envelope: string;
        signer: string | null;
        signature: string | null;
        rekey: ServedRekey | null;
    }[][]) {
        const out: Doc[] = [];
        for (const record of records) {
            if (record.rekey) {
                const checked = await verdict.rekeyed(
                    servedRekeyedRecord(
                        record.record,
                        record.statement,
                        record.keyEpoch,
                        record.envelope,
                        record.rekey,
                    ),
                    ledger.keyAtEpoch(AREA, record.statement.nodeId, record.keyEpoch),
                    record.signer,
                );
                out.push({ kind: 'rekeyed', ...checked });
                continue;
            }
            const statements = async () =>
                record.record === 'metadata'
                    ? metadataStatements(
                          record.statement as MetadataStatement,
                          decode(record.envelope),
                      )
                    : versionStatements(
                          record.statement as VersionStatement,
                          decode(record.envelope),
                      );
            out.push({
                kind: 'signed',
                ...(await verdict(statements, record.signer, record.signature)),
            });
        }
        verdicts.push(out);
    }
    const first = held[0];
    return { verdicts, key: first && e(first) === e(key(4)) ? 'k:4' : first && e(first) };
}

/*
 * Each re-keyed record of the walked nodes as the fuzz target
 * `record_integrity` reads one (rekeyed-testkit.ts's readRekeyed): with its
 * node's key at the target, and the roster's trust in its writer and walker.
 */
export async function rekeyedInputs(served: Doc[][], nodeKeys: (string | null)[]) {
    const { people } = await family();
    const trustOf = (userId: string | null) => {
        const p = people.find((x) => x.userId === userId);
        if (!p) return { trust: 'outside' };
        return {
            trust: p.n === 3 ? 'former-member' : 'roster',
            signer: { current: p.served.signingPublicKey, retired: [] },
            ...(p.n === 3 ? {} : { via: GROUP }),
            linksLoaded: true,
        };
    };
    return served.flatMap((records, index) =>
        (records as (Doc & { rekey: ServedRekey | null; signer: string | null })[])
            .filter((record) => record.rekey)
            .map((record) => ({
                record: record.record,
                statement: record.statement,
                keyEpoch: record.keyEpoch,
                envelope: record.envelope,
                origin: record.rekey!.origin,
                rekeySignature: record.rekey!.signature,
                nodeKey: nodeKeys[index],
                group: {
                    origin: trustOf(record.rekey!.origin.signerId),
                    originPersonal: null,
                    rekeyer: trustOf(record.signer),
                    rekeyerPersonal: null,
                },
            })),
    );
}

/* Every case walked by this twin, checked against what it declares, as the fixture writes it. */
export async function rotationFixture() {
    const { people } = await family();
    const out = [];
    for (const c of await rotationCases()) {
        const { rotated, nodeKeys, writes } = await walk(c);
        if (c.refused) {
            // The web re-seals what the core refuses: say so, and how much.
            const reseals = {
                shares: rotated.reduce((n, r) => n + r.shares, 0),
                links: rotated.reduce((n, r) => n + r.links, 0),
            };
            if (JSON.stringify(reseals) !== JSON.stringify(c.webReseals))
                throw new Error(`${c.name}: re-sealed ${JSON.stringify(reseals)}`);
            out.push({ ...c, rotated, served: [], rekeyedInputs: [] });
            continue;
        }
        const shapes = shapesOf(rotated);
        if (JSON.stringify(shapes) !== JSON.stringify(c.shapes))
            throw new Error(`${c.name}: walked to ${JSON.stringify(shapes)}`);
        if (JSON.stringify(writes) !== JSON.stringify(c.writes))
            throw new Error(`${c.name}: writes ${JSON.stringify(writes)}`);
        const served = servedAfter(c, rotated, people[c.walker - 1]!.userId);
        const read = await readBack(c, rotated, served);
        if (JSON.stringify(read.verdicts) !== JSON.stringify(c.expected))
            throw new Error(`${c.name}: read as ${JSON.stringify(read.verdicts)}`);
        if (c.key && read.key !== c.key) throw new Error(`${c.name}: holds ${read.key}`);
        out.push({
            ...c,
            rotated,
            served,
            rekeyedInputs: await rekeyedInputs(served, nodeKeys),
        });
    }
    return out;
}
