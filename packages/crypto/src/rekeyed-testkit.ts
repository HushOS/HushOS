import {
    contentKeyContext,
    metadataContext,
    originOpeningKey,
    rekeyEnvelope,
    sealMetadata,
    sealVersion,
    wrapContentKey,
    wrapNodeKey,
    wrapOriginKey,
    type NodeMetadata,
    type VersionRecord,
} from './drive';
import { groupRekeyedIntegrityOf, type GroupWriterTrust } from './group-trust';
import { decode, encode } from './keys';
import {
    metadataRekeyedStatement,
    metadataStatement,
    rekeyedIntegrityOf,
    signStatement,
    versionRekeyedStatement,
    type MetadataStatement,
    type RekeyedRecord,
    type TrustedSigner,
    type VersionStatement,
} from './signatures';

/*
 * Re-keyed records as JSON, for the shared fixtures (scripts/core-fixtures.ts
 * writes cases, core-fixtures.test.ts reads the core's) and the fuzz targets
 * (fuzz/verdicts.ts, `record_integrity`). The twin is
 * crates/hushos-core/tests/common/rekeyed.rs: both read the same document the
 * same way (a field that does not fit is a skip, as the fuzz shapes say) and
 * give the same verdict, and both build the same cases with the same
 * expectations from their own keys.
 */

type Doc = Record<string, unknown>;
const isObject = (value: unknown): value is Doc =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: Doc, key: string) =>
    typeof value[key] === 'string' ? (value[key] as string) : undefined;
/* A number a u64 holds; a u32 for `small`. */
const unsigned = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 64
        ? value
        : undefined;
const number = (value: Doc, key: string) => unsigned(value[key]);
const small = (value: Doc, key: string) => {
    const n = number(value, key);
    return n !== undefined && n <= 0xffff_ffff ? n : undefined;
};
function bytesOf(value: unknown) {
    if (typeof value !== 'string') return undefined;
    if (value === '') return new Uint8Array();
    try {
        return decode(value);
    } catch {
        return undefined;
    }
}
const bytes = (value: Doc, key: string) => bytesOf(value[key]);
/* Absent or null is null; present and not fitting is undefined. */
function nullable<T>(value: Doc, key: string, read: (inner: unknown) => T | undefined) {
    if (value[key] === undefined || value[key] === null) return null;
    return read(value[key]);
}

function signerOf(value: unknown): TrustedSigner | undefined {
    if (!isObject(value) || !Array.isArray(value.retired)) return undefined;
    const current = bytes(value, 'current');
    const retired = value.retired.map(bytesOf);
    if (!current || retired.some((key) => key === undefined)) return undefined;
    return { current, retired: retired as Uint8Array[] };
}

function groupTrustOf(value: unknown): GroupWriterTrust | undefined {
    if (!isObject(value)) return undefined;
    const trust = text(value, 'trust');
    if (trust === 'outside' || trust === 'unchecked' || trust === 'key-conflict') return { trust };
    const signer = signerOf(value.signer);
    const linksLoaded = typeof value.linksLoaded === 'boolean' ? value.linksLoaded : undefined;
    if (!signer || linksLoaded === undefined) return undefined;
    if (trust === 'former-member') return { trust, signer, linksLoaded };
    if (trust !== 'roster') return undefined;
    const via = nullable(value, 'via', (v) => (typeof v === 'string' ? v : undefined));
    if (via === undefined) return undefined;
    return { trust, signer, via, followed: null, linksLoaded };
}

export type RekeyedInput = {
    record: RekeyedRecord;
    nodeKey: Uint8Array | null;
    trust:
        | {
              kind: 'personal';
              trust: { origin: TrustedSigner | null; rekeyer: TrustedSigner | null } | null;
          }
        | {
              kind: 'group';
              origin: GroupWriterTrust;
              originPersonal: TrustedSigner | null;
              rekeyer: GroupWriterTrust;
              rekeyerPersonal: TrustedSigner | null;
          };
};

/* A re-keyed record and what the reader holds, from JSON; undefined when it does not fit. */
export function readRekeyed(value: unknown): RekeyedInput | undefined {
    if (!isObject(value) || !isObject(value.statement) || !isObject(value.origin)) return undefined;
    const kind = text(value, 'record');
    const s = value.statement;
    let statement: MetadataStatement | VersionStatement | undefined;
    if (kind === 'metadata') {
        const nodeKind = text(s, 'kind');
        const fields = {
            workspaceId: text(s, 'workspaceId'),
            nodeId: text(s, 'nodeId'),
            metadataVersion: number(s, 'metadataVersion'),
        };
        if (Object.values(fields).some((f) => f === undefined)) return undefined;
        if (nodeKind !== 'folder' && nodeKind !== 'file') return undefined;
        statement = { ...(fields as Omit<MetadataStatement, 'kind'>), kind: nodeKind };
    } else if (kind === 'version') {
        const fields = {
            workspaceId: text(s, 'workspaceId'),
            nodeId: text(s, 'nodeId'),
            versionId: text(s, 'versionId'),
            objectId: text(s, 'objectId'),
            contentSuite: small(s, 'contentSuite'),
        };
        if (Object.values(fields).some((f) => f === undefined)) return undefined;
        statement = fields as VersionStatement;
    } else return undefined;
    const o = value.origin;
    const origin = {
        envelope: bytes(o, 'envelope'),
        signerId: nullable(o, 'signerId', (v) => (typeof v === 'string' ? v : undefined)),
        signature: nullable(o, 'signature', bytesOf),
        keyEnvelope: bytes(o, 'keyEnvelope'),
    };
    const keyEpoch = number(value, 'keyEpoch');
    const envelope = bytes(value, 'envelope');
    const rekeySignature = nullable(value, 'rekeySignature', bytesOf);
    const nodeKey = nullable(value, 'nodeKey', bytesOf);
    if (
        Object.values(origin).some((f) => f === undefined) ||
        keyEpoch === undefined ||
        !envelope ||
        rekeySignature === undefined ||
        nodeKey === undefined
    )
        return undefined;
    const record = {
        record: kind,
        statement,
        keyEpoch,
        envelope,
        origin: origin as RekeyedRecord['origin'],
        rekeySignature,
    } as RekeyedRecord;
    if (value.group !== undefined && value.group !== null) {
        const g = value.group;
        if (!isObject(g)) return undefined;
        const trust = {
            origin: groupTrustOf(g.origin),
            originPersonal: nullable(g, 'originPersonal', signerOf),
            rekeyer: groupTrustOf(g.rekeyer),
            rekeyerPersonal: nullable(g, 'rekeyerPersonal', signerOf),
        };
        if (Object.values(trust).some((f) => f === undefined)) return undefined;
        return {
            record,
            nodeKey,
            trust: { kind: 'group', ...(trust as Required<typeof trust>) } as RekeyedInput['trust'],
        };
    }
    const trust = nullable(value, 'trust', (t) => {
        if (!isObject(t)) return undefined;
        const both = {
            origin: nullable(t, 'origin', signerOf),
            rekeyer: nullable(t, 'rekeyer', signerOf),
        };
        return both.origin === undefined || both.rekeyer === undefined
            ? undefined
            : (both as { origin: TrustedSigner | null; rekeyer: TrustedSigner | null });
    });
    if (trust === undefined) return undefined;
    return { record, nodeKey, trust: { kind: 'personal', trust } };
}

/* The verdict as JSON: { origin, rekeyer, mismatch }, each side { integrity, via } in a group's area. */
export async function judgeRekeyed(input: RekeyedInput): Promise<Doc> {
    if (input.trust.kind === 'personal')
        return { ...(await rekeyedIntegrityOf(input.record, input.nodeKey, input.trust.trust)) };
    const { kind: _, ...trust } = input.trust;
    return { ...(await groupRekeyedIntegrityOf(input.record, input.nodeKey, trust)) };
}

/* ---------------------------------------------------------------------------------------------- */
/* The shared cases, built from this twin's keys with the expectations both twins declare.        */
/* ---------------------------------------------------------------------------------------------- */

/* An Ed25519 signer: libsodium's 64-byte secret key and the public key. */
export type CaseSigner = { userId: string; secretKey: Uint8Array; publicKey: Uint8Array };
export type CaseMaterial = {
    oldNodeKey: Uint8Array;
    nodeKey: Uint8Array;
    /* The node key's epoch after the rotation. */
    keyEpoch: number;
    parentId: string;
    writer: CaseSigner;
    rekeyer: CaseSigner;
    stranger: Uint8Array;
    group: string;
    /* The writer's metadata, sealed under the old key and signed. */
    metadata: {
        statement: MetadataStatement;
        plaintext: NodeMetadata;
        envelope: Uint8Array;
        signature: Uint8Array;
    };
    /* The writer's version and another version of the same node, sealed under the old key and signed. */
    version: {
        statement: VersionStatement;
        record: VersionRecord;
        envelope: Uint8Array;
        signature: Uint8Array;
    };
    otherVersion: {
        statement: VersionStatement;
        record: VersionRecord;
        envelope: Uint8Array;
        signature: Uint8Array;
    };
    /* The same metadata sealed under the old key for another node of the workspace, and signed there. */
    otherNode: { statement: MetadataStatement; envelope: Uint8Array; signature: Uint8Array };
};
export type RekeyedCase = { name: string; input: Doc; expected: Doc };

const e = (value: Uint8Array) => encode(value);
const signer = (current: Uint8Array, retired: Uint8Array[] = []) => ({
    current: e(current),
    retired: retired.map(e),
});
const verdict = (origin: string, rekeyer: string, mismatch: boolean) => ({
    origin,
    rekeyer,
    mismatch,
});
const side = (integrity: string, via: string | null = null) => ({ integrity, via });

type Built = {
    record: 'metadata' | 'version';
    statement: MetadataStatement | VersionStatement;
    keyEpoch: number;
    envelope: Uint8Array;
    origin: {
        envelope: Uint8Array;
        signerId: string | null;
        signature: Uint8Array | null;
        keyEnvelope: Uint8Array;
    };
    rekeySignature: Uint8Array | null;
};

function json(built: Built): Doc {
    return {
        record: built.record,
        statement: built.statement,
        keyEpoch: built.keyEpoch,
        envelope: e(built.envelope),
        origin: {
            envelope: e(built.origin.envelope),
            signerId: built.origin.signerId,
            signature: built.origin.signature && e(built.origin.signature),
            keyEnvelope: e(built.origin.keyEnvelope),
        },
        rekeySignature: built.rekeySignature && e(built.rekeySignature),
    };
}

/* The rekeyed statement over `built` as it stands, signed by `by`. */
async function signed(built: Built, by: CaseSigner): Promise<Built> {
    const origin = {
        envelope: built.origin.envelope,
        signerId: built.origin.signerId!,
        signature: built.origin.signature!,
    };
    const statement =
        built.record === 'metadata'
            ? await metadataRekeyedStatement(
                  { ...(built.statement as MetadataStatement), keyEpoch: built.keyEpoch },
                  built.envelope,
                  origin,
              )
            : await versionRekeyedStatement(
                  { ...(built.statement as VersionStatement), keyEpoch: built.keyEpoch },
                  built.envelope,
                  origin,
              );
    return { ...built, rekeySignature: await signStatement(statement, by.secretKey) };
}

function versionCtx(s: VersionStatement) {
    return {
        workspaceId: s.workspaceId,
        nodeId: s.nodeId,
        versionId: s.versionId,
        objectId: s.objectId,
        suite: s.contentSuite,
    };
}

/*
 * The writer's metadata and version re-keyed to `keyEpoch` by the re-keyer,
 * as a rotation keeping the origin writes them, and the cases both twins
 * judge alike. The order and names are the same in rekeyed.rs.
 */
export async function rekeyedCases(m: CaseMaterial): Promise<{
    metadata: Doc;
    version: Doc;
    metadataOriginKey: string;
    versionOriginKey: string;
    metadataStatement: string;
    versionStatement: string;
    /* Every origin the cases carry, with the record it was sealed for: the fuzz targets' oracle. */
    origins: Doc[];
    cases: RekeyedCase[];
}> {
    const ms = m.metadata.statement;
    const vs = m.version.statement;
    const metaAad = metadataContext({
        workspaceId: ms.workspaceId,
        nodeId: ms.nodeId,
        metadataVersion: ms.metadataVersion,
    });
    const keyCtx = (
        record: Built['record'],
        s: MetadataStatement | VersionStatement,
        origin: Uint8Array,
        keyEpoch = m.keyEpoch,
    ) => ({
        workspaceId: s.workspaceId,
        nodeId: s.nodeId,
        keyEpoch,
        record:
            record === 'metadata'
                ? {
                      kind: 'metadata' as const,
                      metadataVersion: (s as MetadataStatement).metadataVersion,
                  }
                : { kind: 'version' as const, versionId: (s as VersionStatement).versionId },
        originEnvelope: origin,
    });
    const metadataOriginKey = originOpeningKey(m.metadata.envelope, m.oldNodeKey);
    const versionOriginKey = originOpeningKey(m.version.envelope, m.oldNodeKey);
    const metadata = await signed(
        {
            record: 'metadata',
            statement: ms,
            keyEpoch: m.keyEpoch,
            envelope: await rekeyEnvelope(m.metadata.envelope, m.oldNodeKey, m.nodeKey, metaAad),
            origin: {
                envelope: m.metadata.envelope,
                signerId: m.writer.userId,
                signature: m.metadata.signature,
                keyEnvelope: await wrapOriginKey(
                    metadataOriginKey,
                    m.nodeKey,
                    keyCtx('metadata', ms, m.metadata.envelope),
                ),
            },
            rekeySignature: null,
        },
        m.rekeyer,
    );
    const version = await signed(
        {
            record: 'version',
            statement: vs,
            keyEpoch: m.keyEpoch,
            envelope: await rekeyEnvelope(
                m.version.envelope,
                m.oldNodeKey,
                m.nodeKey,
                contentKeyContext(versionCtx(vs)),
            ),
            origin: {
                envelope: m.version.envelope,
                signerId: m.writer.userId,
                signature: m.version.signature,
                keyEnvelope: await wrapOriginKey(
                    versionOriginKey,
                    m.nodeKey,
                    keyCtx('version', vs, m.version.envelope),
                ),
            },
            rekeySignature: null,
        },
        m.rekeyer,
    );

    const W = signer(m.writer.publicKey);
    const R = signer(m.rekeyer.publicKey);
    const both = { origin: W, rekeyer: R };
    const nodeKey = e(m.nodeKey);
    const cases: RekeyedCase[] = [];
    const personal = (
        name: string,
        built: Built,
        trust: unknown,
        expected: Doc,
        key: string | null = nodeKey,
    ) => cases.push({ name, input: { ...json(built), nodeKey: key, trust }, expected });
    const roster = (key: Uint8Array, linksLoaded = true) => ({
        trust: 'roster',
        signer: signer(key),
        via: m.group,
        linksLoaded,
    });
    const family = (
        name: string,
        built: Built,
        group: unknown,
        expected: Doc,
        key: string | null = nodeKey,
    ) => cases.push({ name, input: { ...json(built), nodeKey: key, group }, expected });

    // As a rotation writes them.
    personal('metadata', metadata, both, verdict('verified', 'verified', false));
    personal('version', version, both, verdict('verified', 'verified', false));
    // Whom the reader has checked: the Info line and the verdict, apart.
    personal(
        'rekeyer not checked',
        metadata,
        { origin: W, rekeyer: null },
        verdict('verified', 'unknown-signer', false),
    );
    personal(
        'writer not checked',
        metadata,
        { origin: null, rekeyer: R },
        verdict('unknown-signer', 'verified', false),
    );
    personal(
        'writer key replaced',
        metadata,
        { origin: signer(m.stranger, [m.writer.publicKey]), rekeyer: R },
        verdict('retired-key', 'verified', false),
    );
    personal(
        'rekeyer key replaced',
        version,
        { origin: W, rekeyer: signer(m.stranger, [m.rekeyer.publicKey]) },
        verdict('verified', 'retired-key', false),
    );
    // The writer's signature over another record, faithfully re-keyed: bad, and the writer's.
    personal(
        'writer signature over another record',
        await signed(
            { ...metadata, origin: { ...metadata.origin, signature: m.version.signature } },
            m.rekeyer,
        ),
        both,
        verdict('bad-signature', 'verified', false),
    );
    // What the re-keyer sealed is not what was written: the re-keyer's, and a mismatch.
    const otherName = await sealMetadata(
        { ...m.metadata.plaintext, name: `${m.metadata.plaintext.name} (swapped)` },
        m.nodeKey,
        { workspaceId: ms.workspaceId, nodeId: ms.nodeId, metadataVersion: ms.metadataVersion },
    );
    const swapped = await signed({ ...metadata, envelope: otherName }, m.rekeyer);
    personal('swapped metadata', swapped, both, verdict('bad-signature', 'verified', true));
    const otherContent = await sealVersion(
        { ...m.version.record, contentKey: new Uint8Array(32).fill(9) },
        m.nodeKey,
        versionCtx(vs),
    );
    personal(
        'swapped version',
        await signed({ ...version, envelope: otherContent }, m.rekeyer),
        both,
        verdict('bad-signature', 'verified', true),
    );
    // An origin sealed for another version, the same bytes sealed again for this one: the context refuses it.
    const foreign = m.otherVersion;
    personal(
        'origin from another version',
        await signed(
            {
                ...version,
                envelope: await sealVersion(foreign.record, m.nodeKey, versionCtx(vs)),
                origin: {
                    envelope: foreign.envelope,
                    signerId: m.writer.userId,
                    signature: foreign.signature,
                    keyEnvelope: await wrapOriginKey(
                        originOpeningKey(foreign.envelope, m.oldNodeKey),
                        m.nodeKey,
                        keyCtx('version', vs, foreign.envelope),
                    ),
                },
            },
            m.rekeyer,
        ),
        both,
        verdict('bad-signature', 'verified', true),
    );
    personal(
        'origin from another node',
        await signed(
            {
                ...metadata,
                origin: {
                    envelope: m.otherNode.envelope,
                    signerId: m.writer.userId,
                    signature: m.otherNode.signature,
                    keyEnvelope: await wrapOriginKey(
                        originOpeningKey(m.otherNode.envelope, m.oldNodeKey),
                        m.nodeKey,
                        keyCtx('metadata', ms, m.otherNode.envelope),
                    ),
                },
            },
            m.rekeyer,
        ),
        both,
        verdict('bad-signature', 'verified', true),
    );
    // What the reader lacks: never clean.
    personal('no node key', metadata, both, verdict('unchecked', 'unchecked', false), null);
    personal('trust did not load', metadata, null, verdict('unchecked', 'unchecked', false));
    personal(
        'old node key',
        metadata,
        both,
        verdict('bad-signature', 'verified', true),
        e(m.oldNodeKey),
    );
    // The re-keyer's signature.
    const flipped = metadata.rekeySignature!.slice();
    flipped[5]! ^= 1;
    personal(
        'rekey signature flipped',
        { ...metadata, rekeySignature: flipped },
        both,
        verdict('bad-signature', 'bad-signature', true),
    );
    // The re-keyer's legacy signature over the current envelope is no binding.
    personal(
        'rekey signature in a writer form',
        {
            ...metadata,
            rekeySignature: await signStatement(
                await metadataStatement(ms, metadata.envelope),
                m.rekeyer.secretKey,
            ),
        },
        both,
        verdict('bad-signature', 'bad-signature', true),
    );
    personal(
        'rekey signature missing',
        { ...metadata, rekeySignature: null },
        both,
        verdict('bad-signature', 'unsigned', true),
    );
    personal(
        'rekey signature missing, rekeyer not checked',
        { ...version, rekeySignature: null },
        { origin: W, rekeyer: null },
        verdict('bad-signature', 'unsigned', true),
    );
    // The writer's account is gone: nobody to name, nothing laundered.
    personal(
        'writer account gone',
        { ...metadata, origin: { ...metadata.origin, signerId: null } },
        { origin: null, rekeyer: R },
        verdict('unknown-signer', 'unchecked', false),
    );
    personal(
        'origin unsigned',
        { ...metadata, origin: { ...metadata.origin, signature: null } },
        both,
        verdict('bad-signature', 'bad-signature', true),
    );
    // The origin key under another label: as a legacy content key, or as a node key.
    personal(
        'origin key as a content key',
        {
            ...version,
            origin: {
                ...version.origin,
                keyEnvelope: await wrapContentKey(versionOriginKey, m.nodeKey, versionCtx(vs)),
            },
        },
        both,
        verdict('bad-signature', 'verified', true),
    );
    personal(
        'origin key as a node key',
        {
            ...metadata,
            origin: {
                ...metadata.origin,
                keyEnvelope: await wrapNodeKey(metadataOriginKey, m.nodeKey, {
                    workspaceId: ms.workspaceId,
                    nodeId: ms.nodeId,
                    parentId: m.parentId,
                    parentKeyEpoch: m.keyEpoch,
                    keyEpoch: m.keyEpoch,
                }),
            },
        },
        both,
        verdict('bad-signature', 'verified', true),
    );
    personal(
        'stale epoch',
        { ...metadata, keyEpoch: m.keyEpoch - 1 },
        both,
        verdict('bad-signature', 'bad-signature', true),
    );
    personal(
        'rekeyed by the writer',
        await signed(metadata, m.writer),
        { origin: W, rekeyer: W },
        verdict('verified', 'verified', false),
    );

    // In a family's area: the origin judged as the group judges its signer.
    family(
        'family writer left',
        metadata,
        {
            origin: { trust: 'former-member', signer: W, linksLoaded: true },
            originPersonal: null,
            rekeyer: roster(m.rekeyer.publicKey),
            rekeyerPersonal: null,
        },
        { origin: side('former-member'), rekeyer: side('verified', m.group), mismatch: false },
    );
    family(
        'family writer on the roster',
        version,
        {
            origin: roster(m.writer.publicKey),
            originPersonal: null,
            rekeyer: roster(m.rekeyer.publicKey),
            rekeyerPersonal: null,
        },
        { origin: side('verified', m.group), rekeyer: side('verified', m.group), mismatch: false },
    );
    family(
        'family roster unavailable',
        metadata,
        {
            origin: { trust: 'unchecked' },
            originPersonal: W,
            rekeyer: { trust: 'unchecked' },
            rekeyerPersonal: R,
        },
        { origin: side('unchecked'), rekeyer: side('unchecked'), mismatch: false },
    );
    family(
        'family swapped metadata',
        swapped,
        {
            origin: roster(m.writer.publicKey),
            originPersonal: null,
            rekeyer: roster(m.rekeyer.publicKey),
            rekeyerPersonal: null,
        },
        { origin: side('bad-signature'), rekeyer: side('verified', m.group), mismatch: true },
    );
    family(
        'family rekeyer left',
        metadata,
        {
            origin: roster(m.writer.publicKey),
            originPersonal: null,
            rekeyer: { trust: 'former-member', signer: R, linksLoaded: true },
            rekeyerPersonal: null,
        },
        { origin: side('verified', m.group), rekeyer: side('former-member'), mismatch: false },
    );
    family(
        'family rekeyer unknown key, links not loaded',
        metadata,
        {
            origin: roster(m.writer.publicKey),
            originPersonal: null,
            rekeyer: roster(m.stranger, false),
            rekeyerPersonal: null,
        },
        { origin: side('verified', m.group), rekeyer: side('unchecked'), mismatch: false },
    );
    family(
        'family rekeyer unknown key, links loaded',
        metadata,
        {
            origin: roster(m.writer.publicKey),
            originPersonal: null,
            rekeyer: roster(m.stranger),
            rekeyerPersonal: null,
        },
        { origin: side('bad-signature'), rekeyer: side('bad-signature'), mismatch: true },
    );
    family(
        'family writer outside the roster',
        metadata,
        {
            origin: { trust: 'outside' },
            originPersonal: W,
            rekeyer: roster(m.rekeyer.publicKey),
            rekeyerPersonal: null,
        },
        { origin: side('verified'), rekeyer: side('verified', m.group), mismatch: false },
    );
    family(
        'family writer key conflict',
        metadata,
        {
            origin: { trust: 'key-conflict' },
            originPersonal: W,
            rekeyer: roster(m.rekeyer.publicKey),
            rekeyerPersonal: null,
        },
        { origin: side('key-conflict'), rekeyer: side('verified', m.group), mismatch: false },
    );
    family(
        'family no node key',
        metadata,
        {
            origin: roster(m.writer.publicKey),
            originPersonal: null,
            rekeyer: roster(m.rekeyer.publicKey),
            rekeyerPersonal: null,
        },
        { origin: side('unchecked'), rekeyer: side('unchecked'), mismatch: false },
        null,
    );

    const statementOf = async (built: Built) => {
        const origin = {
            envelope: built.origin.envelope,
            signerId: built.origin.signerId!,
            signature: built.origin.signature!,
        };
        return e(
            built.record === 'metadata'
                ? await metadataRekeyedStatement(
                      { ...(built.statement as MetadataStatement), keyEpoch: built.keyEpoch },
                      built.envelope,
                      origin,
                  )
                : await versionRekeyedStatement(
                      { ...(built.statement as VersionStatement), keyEpoch: built.keyEpoch },
                      built.envelope,
                      origin,
                  ),
        );
    };
    return {
        metadata: json(metadata),
        version: json(version),
        metadataOriginKey: e(metadataOriginKey),
        versionOriginKey: e(versionOriginKey),
        metadataStatement: await statementOf(metadata),
        versionStatement: await statementOf(version),
        origins: [
            {
                envelope: e(m.metadata.envelope),
                record: 'metadata',
                workspaceId: ms.workspaceId,
                nodeId: ms.nodeId,
                metadataVersion: ms.metadataVersion,
            },
            {
                envelope: e(m.otherNode.envelope),
                record: 'metadata',
                workspaceId: m.otherNode.statement.workspaceId,
                nodeId: m.otherNode.statement.nodeId,
                metadataVersion: m.otherNode.statement.metadataVersion,
            },
            {
                envelope: e(m.version.envelope),
                record: 'version',
                workspaceId: vs.workspaceId,
                nodeId: vs.nodeId,
                versionId: vs.versionId,
            },
            {
                envelope: e(foreign.envelope),
                record: 'version',
                workspaceId: foreign.statement.workspaceId,
                nodeId: foreign.statement.nodeId,
                versionId: foreign.statement.versionId,
            },
        ],
        cases,
    };
}
