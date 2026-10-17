import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
    contentKeyContext,
    generateKey,
    metadataContext,
    openEnvelopeBytes,
    openOriginKey,
    openWithOriginKey,
    originOpeningKey,
    rekeyEnvelope,
    sealMetadata,
    sealVersion,
    wrapOriginKey,
    type OriginRecord,
} from '@hushos/crypto/drive';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
    closeDatabase,
    createTestAccount,
    createTestIdentity,
    resetDatabase,
    signerFor,
    signingKeyFromSeed,
} from '../test/helpers';
import * as signed from '../test/signed';
import { db } from './client';
import * as drive from './drive';
import * as groups from './groups';
import { scopedId } from './ids';
import * as reports from './reports';
import * as rotations from './rotations';
import {
    driveNodes,
    driveOriginDrops,
    driveReportItems,
    fileVersions,
    groupMemberships,
    users,
    workspaceKeys,
    workspaces,
} from './schema';
import {
    metadataRekeyedStatement,
    metadataSigned,
    metadataStatement,
    verifySignature,
    versionRekeyedStatement,
    versionStatement,
    type StatementForm,
} from './signatures';

/*
 * Re-keyed records on the server (docs/integrity-design.md, "Re-keyed
 * records", "What the server enforces"), in a family folder, the only place
 * they are written for now (rekeyedFor); the owner's own drive keeps the
 * legacy form shipped apps write, last below. The origin is the row's, copied by
 * the server under the rotation's change sequence and never taken from the
 * client; the re-key signature is checked under the rotating account's
 * current key over that origin and the target epoch; a later rotation keeps
 * the stored origin; a legacy re-seal of a re-keyed record is refused unless
 * it drops the origin as re-sealed; every write outside a rotation clears it;
 * and the columns hold a whole origin or none.
 */

const MiB = 1024n * 1024n;
const env = () => randomBytes(72);
const meta = () => randomBytes(100);

let owner: Awaited<ReturnType<typeof createTestAccount>>;
let writer: Awaited<ReturnType<typeof createTestAccount>>;
/* The workspace under test: a family folder (re-keyed records), or the owner's own drive. */
let ws: string;
let rootId: string;
let rootEpoch: number;

async function epoch() {
    return (await drive.allocateKeyEpochs(ws, 1))!.from;
}
async function nodeRow(id: string) {
    const [row] = await db.select().from(driveNodes).where(eq(driveNodes.id, id));
    return row!;
}
async function versionRow(id: string) {
    const [row] = await db.select().from(fileVersions).where(eq(fileVersions.id, id));
    return row!;
}

/* A file in the owner's drive under the root, uploaded and published. */
async function file() {
    const plaintext = 1n * MiB;
    const objectId = randomUUID();
    const begun = await signed.beginUpload({
        workspaceId: ws,
        userId: owner.userId,
        node: {
            existing: false,
            id: randomUUID(),
            parentId: rootId,
            envelopes: {
                keyEpoch: await epoch(),
                parentKeyEpoch: rootEpoch,
                keyEnvelope: env(),
                metadataEnvelope: meta(),
            },
        },
        version: { id: randomUUID(), contentKeyEnvelope: randomBytes(84) },
        object: {
            id: objectId,
            objectKey: `ws/${ws}/${objectId}`,
            contentSuite: 2,
            chunkSize: Number(8n * MiB),
            chunkCount: 1,
            contentNonce: randomBytes(16),
            ciphertextSize: plaintext + 16n,
        },
        multipartId: `mp-${objectId}`,
        expiresAt: new Date(Date.now() + 3600_000),
    });
    if (begun.status !== 'ok') throw new Error(begun.status);
    await drive.startCompleting(ws, begun.uploadId);
    const done = await drive.finishCompleting(ws, begun.uploadId, plaintext + 16n);
    if (done.status !== 'published') throw new Error(done.status);
    return done.node;
}

/*
 * The file's metadata and version as an editor (`writer`) wrote them: their
 * envelopes and their own signatures, as a write through a share stores them.
 */
async function writtenBy(account: { userId: string }, node: { id: string }) {
    const row = await nodeRow(node.id);
    const sign = signerFor(account.userId);
    await db
        .update(driveNodes)
        .set({
            metadataSignerId: account.userId,
            metadataSignature: sign.sign(
                metadataStatement({
                    workspaceId: ws,
                    nodeId: node.id,
                    kind: row.kind,
                    metadataVersion: row.metadataVersion,
                    metadataEnvelope: row.metadataEnvelope!,
                }),
            ),
        })
        .where(eq(driveNodes.id, node.id));
    const version = await versionRow(row.currentVersionId!);
    await db
        .update(fileVersions)
        .set({
            signerId: account.userId,
            signature: sign.sign(
                versionStatement({
                    workspaceId: ws,
                    nodeId: node.id,
                    versionId: version.id,
                    objectId: version.objectId!,
                    contentSuite: 2,
                    contentKeyEnvelope: version.contentKeyEnvelope!,
                }),
            ),
        })
        .where(eq(fileVersions.id, version.id));
}

async function startOn(nodeId: string) {
    const started = await rotations.startRotation({
        workspaceId: ws,
        nodeId,
        startedBy: owner.userId,
    });
    if (started.status !== 'ok') throw new Error(started.status);
    return {
        workspaceId: ws,
        rootId: nodeId,
        targetEpoch: started.rotation.targetEpoch,
        userId: owner.userId,
    };
}

/* What one record of a batch carries: a re-key, a legacy signature in a form, or both. */
type Signing = {
    rekey?: 'valid' | { signature: Buffer; originKeyEnvelope?: Buffer } | null;
    legacy?: StatementForm | null;
    dropOrigin?: boolean;
};

/* Envelopes really re-sealed under a node key, and the wrapped keys that open their origins. */
type Sealed = {
    metadataEnvelope: Buffer;
    contentKeyEnvelope: Buffer;
    metadataWrap: Buffer;
    versionWrap: Buffer;
};

/*
 * One file node re-keyed at the run's target, its metadata and its one version
 * each signed as `metadata` and `version` say, by the owner unless `by` says
 * another account's key; with `sealed`, over those envelopes and wraps rather
 * than random bytes.
 */
async function rotateFile(
    run: Awaited<ReturnType<typeof startOn>>,
    nodeId: string,
    metadata: Signing,
    version: Signing = metadata,
    by = owner.userId,
    sealed?: Sealed,
) {
    const row = await nodeRow(nodeId);
    const current = await versionRow(row.currentVersionId!);
    const metadataEnvelope = sealed?.metadataEnvelope ?? meta();
    const contentKeyEnvelope = sealed?.contentKeyEnvelope ?? randomBytes(84);
    const sign = signerFor(by);
    const rekeyOf = async (
        signing: Signing,
        made: () => Promise<{ originKeyEnvelope: Buffer; signature: Buffer } | null>,
    ) => {
        if (!signing.rekey) return null;
        if (signing.rekey !== 'valid')
            return {
                originKeyEnvelope: signing.rekey.originKeyEnvelope ?? env(),
                signature: signing.rekey.signature,
            };
        const valid = await made();
        if (!valid) throw new Error('nothing to re-key');
        return valid;
    };
    const metadataRekey = await rekeyOf(metadata, async () => {
        const rekey = await signed.metadataRekey(
            by,
            ws,
            nodeId,
            run.targetEpoch,
            metadataEnvelope,
            sealed?.metadataWrap,
        );
        return rekey;
    });
    const versionRekey = await rekeyOf(version, () =>
        signed.versionRekey(
            by,
            ws,
            nodeId,
            current.id,
            run.targetEpoch,
            contentKeyEnvelope,
            sealed?.versionWrap,
        ),
    );
    const fields = {
        workspaceId: ws,
        nodeId,
        kind: row.kind,
        metadataVersion: row.metadataVersion,
        metadataEnvelope,
    };
    const versionFields = {
        workspaceId: ws,
        nodeId,
        versionId: current.id,
        objectId: current.objectId!,
        contentSuite: 2,
        contentKeyEnvelope,
    };
    const [result] = await rotations.rotateNodes({
        ...run,
        nodes: [
            {
                id: nodeId,
                changeSeq: row.changeSeq!,
                parentKeyEpoch: rootEpoch,
                keyEnvelope: env(),
                rotated: {
                    metadataEnvelope,
                    metadataSignature: metadata.legacy
                        ? sign.sign(metadataStatement(fields, metadata.legacy))
                        : null,
                    metadataRekey,
                    metadataDropOrigin: metadata.dropOrigin,
                    versions: [
                        {
                            id: current.id,
                            contentKeyEnvelope,
                            signature: version.legacy
                                ? sign.sign(versionStatement(versionFields, version.legacy))
                                : null,
                            rekey: versionRekey,
                            dropOrigin: version.dropOrigin,
                        },
                    ],
                    shares: [],
                    links: [],
                    unsealableLinks: [],
                },
            },
        ],
    });
    return {
        status: result!.status,
        metadataEnvelope,
        contentKeyEnvelope,
        metadataRekey,
        versionRekey,
        versionId: current.id,
    };
}

/* A run on its own: the rotation started, `rotate` applied, and the rotation finished. */
async function rotatedOnce(nodeId: string, metadata: Signing, version: Signing = metadata) {
    const run = await startOn(nodeId);
    const result = await rotateFile(run, nodeId, metadata, version);
    if (result.status !== 'ok') throw new Error(result.status);
    if (!(await rotations.finishRotation(run))) throw new Error('not finished');
    return result;
}

/* A family made by `creator`, its first area granted to them (the repository stores statements as opaque bytes). */
async function familyArea(creator: { userId: string }) {
    const seed = () => randomBytes(16).toString('base64url');
    const idSeed = seed();
    const groupId = scopedId('group', creator.userId, idSeed)!;
    const areaSeed = seed();
    const areaId = scopedId('workspace', groupId, areaSeed)!;
    const signatures = () => ({
        ed25519Signature: randomBytes(64),
        mlDsaSignature: randomBytes(3309),
        signerSignature: randomBytes(3373),
    });
    const roster = {
        statement: Buffer.from(`roster 1 ${groupId}`),
        ...signatures(),
        version: 1,
        previousDigest: null,
        groupKeyVersion: 1,
        signerUserId: creator.userId,
        signerMlDsaPublicKey: randomBytes(1952),
        changes: [
            { userId: creator.userId, status: 'active', roles: ['billing', 'guardian', 'members'] },
        ],
        dropsHolder: false,
    } as groups.ParsedRoster;
    const head = { rosterVersion: 1, rosterDigest: groups.statementDigest(roster.statement) };
    const created = await groups.createGroup({
        id: groupId,
        idSeed,
        kind: 'family',
        name: 'Family',
        creatorUserId: creator.userId,
        firstEd25519PublicKey: randomBytes(32),
        firstMlDsaPublicKey: randomBytes(1952),
        roster,
        keySeal: {
            groupKeyVersion: 1,
            holderUserId: creator.userId,
            holderKeyVersion: 1,
            sealerUserId: creator.userId,
            ...head,
            envelope: randomBytes(4597),
        },
        area: {
            workspaceId: areaId,
            idSeed: areaSeed,
            quotaBytes: 1n << 30n,
            selfGrant: {
                keyVersion: 1,
                workspaceKeyVersion: 1,
                wrappingSalt: randomBytes(32),
                wrappingNonce: randomBytes(24),
                encryptedKey: randomBytes(48),
            },
        },
        grants: [
            {
                workspaceId: areaId,
                workspaceKeyVersion: 1,
                granteeUserId: creator.userId,
                granteeKeyVersion: 1,
                granterUserId: creator.userId,
                ...head,
                envelope: randomBytes(4565),
            },
        ],
        cache: { through: 1 },
    });
    if (created.status !== 'created') throw new Error(`createGroup ${created.status}`);
    return areaId;
}

/* A top folder in `ws`, signed by the owner, under key version 1 of its parent. */
async function makeRoot() {
    const created = await signed.createRoot({
        workspaceId: ws,
        userId: owner.userId,
        id: randomUUID(),
        envelopes: {
            keyEpoch: await epoch(),
            parentKeyEpoch: 1,
            keyEnvelope: env(),
            metadataEnvelope: meta(),
        },
    });
    if (created.status !== 'created') throw new Error(created.status);
    rootId = created.root.id;
    rootEpoch = created.root.keyEpoch;
}

beforeEach(async () => {
    await resetDatabase();
    owner = await createTestAccount();
    writer = await createTestAccount();
    for (const userId of [owner.userId, writer.userId]) await createTestIdentity(userId);
    ws = await familyArea(owner);
    await makeRoot();
});
afterAll(closeDatabase);

describe('a rotation that re-keys', () => {
    test('copies the origin from the row as it stood: a re-key over any other origin is refused', async () => {
        const doc = await file();
        await writtenBy(writer, doc);
        const before = await nodeRow(doc.id);
        const beforeVersion = await versionRow(before.currentVersionId!);
        const run = await startOn(doc.id);

        // The re-keyer signs over an origin of its own making (another envelope, or naming
        // itself as the writer): the server builds the statement from the row, so it fails.
        const row = await nodeRow(doc.id);
        const metadataEnvelope = meta();
        const keyEnvelope = env();
        for (const forged of [
            {
                envelope: meta(),
                signerId: writer.userId,
                signature: before.metadataSignature!,
            },
            {
                envelope: before.metadataEnvelope!,
                signerId: owner.userId,
                signature: before.metadataSignature!,
            },
        ]) {
            const [result] = await rotations.rotateNodes({
                ...run,
                nodes: [
                    {
                        id: doc.id,
                        changeSeq: row.changeSeq!,
                        parentKeyEpoch: rootEpoch,
                        keyEnvelope: env(),
                        rotated: {
                            metadataEnvelope,
                            metadataSignature: null,
                            metadataRekey: {
                                originKeyEnvelope: keyEnvelope,
                                signature: signerFor(owner.userId).sign(
                                    metadataRekeyedStatement(
                                        {
                                            workspaceId: ws,
                                            nodeId: doc.id,
                                            kind: 'file',
                                            metadataVersion: row.metadataVersion,
                                            metadataEnvelope,
                                            keyEpoch: run.targetEpoch,
                                        },
                                        { ...forged, keyEnvelope },
                                    ),
                                ),
                            },
                            versions: [
                                {
                                    id: beforeVersion.id,
                                    contentKeyEnvelope: randomBytes(84),
                                    rekey: (await signed.versionRekey(
                                        owner.userId,
                                        ws,
                                        doc.id,
                                        beforeVersion.id,
                                        run.targetEpoch,
                                        randomBytes(84),
                                    ))!,
                                    signature: null,
                                },
                            ],
                            shares: [],
                            links: [],
                            unsealableLinks: [],
                        },
                    },
                ],
            });
            expect(result!.status).toBe('bad-signature');
        }
        expect((await nodeRow(doc.id)).metadataEnvelope!.equals(before.metadataEnvelope!)).toBe(
            true,
        );

        // Signed over the row as it stood: stored, with the writer's record as the origin.
        const done = await rotateFile(run, doc.id, { rekey: 'valid' });
        expect(done.status).toBe('ok');
        const after = await nodeRow(doc.id);
        expect(after.metadataEnvelope!.equals(done.metadataEnvelope)).toBe(true);
        expect(after.metadataOriginEnvelope!.equals(before.metadataEnvelope!)).toBe(true);
        expect(after.metadataOriginSignerId).toBe(writer.userId);
        expect(after.metadataOriginSignature!.equals(before.metadataSignature!)).toBe(true);
        expect(after.metadataOriginKeyEnvelope!.equals(done.metadataRekey!.originKeyEnvelope)).toBe(
            true,
        );
        expect(after.metadataRekeySignature!.equals(done.metadataRekey!.signature)).toBe(true);
        // The re-keyer sealed the current envelope and is its signer; no legacy signature was sent.
        expect(after.metadataSignerId).toBe(owner.userId);
        expect(after.metadataSignature).toBeNull();
        const version = await versionRow(done.versionId);
        expect(version.originEnvelope!.equals(beforeVersion.contentKeyEnvelope!)).toBe(true);
        expect(version.originSignerId).toBe(writer.userId);
        expect(version.originSignature!.equals(beforeVersion.signature!)).toBe(true);
        expect(version.signerId).toBe(owner.userId);
    });

    test('a later rotation keeps the stored origin byte for byte and refuses a re-key over the record the first one wrote', async () => {
        const doc = await file();
        await writtenBy(writer, doc);
        const original = await nodeRow(doc.id);
        // The first rotation also writes an honest legacy signature: re-sealed, someone else's record.
        const first = await rotatedOnce(doc.id, { rekey: 'valid', legacy: 'resealed' });
        const between = await nodeRow(doc.id);
        expect(between.metadataSignature).not.toBeNull();

        const run = await startOn(doc.id);
        // A re-key over the current record (the first rotation's envelope, signed by the
        // re-keyer) would make the re-keyer the writer: refused.
        const metadataEnvelope = meta();
        const keyEnvelope = env();
        const overCurrent = signerFor(owner.userId).sign(
            metadataRekeyedStatement(
                {
                    workspaceId: ws,
                    nodeId: doc.id,
                    kind: 'file',
                    metadataVersion: between.metadataVersion,
                    metadataEnvelope,
                    keyEpoch: run.targetEpoch,
                },
                {
                    envelope: between.metadataEnvelope!,
                    signerId: owner.userId,
                    signature: between.metadataSignature!,
                    keyEnvelope,
                },
            ),
        );
        const refused = await rotateFile(
            run,
            doc.id,
            { rekey: { signature: overCurrent, originKeyEnvelope: keyEnvelope } },
            { rekey: 'valid' },
        );
        expect(refused.status).toBe('bad-signature');

        const second = await rotateFile(run, doc.id, { rekey: 'valid' });
        expect(second.status).toBe('ok');
        const after = await nodeRow(doc.id);
        expect(after.metadataOriginEnvelope!.equals(original.metadataEnvelope!)).toBe(true);
        expect(after.metadataOriginSignerId).toBe(writer.userId);
        expect(after.metadataOriginSignature!.equals(original.metadataSignature!)).toBe(true);
        // Only the wrap and the re-key signature move: the new ones.
        expect(
            after.metadataOriginKeyEnvelope!.equals(second.metadataRekey!.originKeyEnvelope),
        ).toBe(true);
        expect(
            after.metadataOriginKeyEnvelope!.equals(first.metadataRekey!.originKeyEnvelope),
        ).toBe(false);
        expect(after.metadataSignature).toBeNull();
    });

    test('a bad re-key signature is refused and nothing is written', async () => {
        const doc = await file();
        const before = await nodeRow(doc.id);
        const run = await startOn(doc.id);
        // Junk; the writer's key over the right statement; the right key over another epoch.
        const otherKey = await signed.metadataRekey(
            writer.userId,
            ws,
            doc.id,
            run.targetEpoch,
            meta(),
        );
        const otherEpoch = await signed.metadataRekey(
            owner.userId,
            ws,
            doc.id,
            run.targetEpoch + 1,
            meta(),
        );
        for (const rekey of [{ signature: randomBytes(64) }, otherKey!, otherEpoch!])
            expect((await rotateFile(run, doc.id, { rekey }, { rekey: 'valid' })).status).toBe(
                'bad-signature',
            );
        // The same for the version's re-key, the metadata's being good.
        expect(
            (
                await rotateFile(
                    run,
                    doc.id,
                    { rekey: 'valid' },
                    { rekey: { signature: randomBytes(64) } },
                )
            ).status,
        ).toBe('bad-signature');
        const after = await nodeRow(doc.id);
        expect(after.keyEpoch).toBe(before.keyEpoch);
        expect(after.metadataEnvelope!.equals(before.metadataEnvelope!)).toBe(true);
        expect(after.metadataOriginEnvelope).toBeNull();
        expect((await versionRow(before.currentVersionId!)).originEnvelope).toBeNull();
    });

    test('in a family folder a legacy signature beside a re-key is only ever re-sealed, the re-keyer’s own record included', async () => {
        const theirs = await file();
        await writtenBy(writer, theirs);
        const mine = await file();
        const run = await startOn(rootId);
        // Walk the root first, as a batch must (parents before children).
        const root = await nodeRow(rootId);
        expect(
            await signed.rotateNodes({
                ...run,
                nodes: [
                    {
                        id: rootId,
                        changeSeq: root.changeSeq!,
                        parentKeyEpoch: root.parentKeyEpoch,
                        keyEnvelope: env(),
                        rotated: {
                            metadataEnvelope: meta(),
                            versions: [],
                            shares: [],
                            links: [],
                            unsealableLinks: [],
                        },
                    },
                ],
            }),
        ).toEqual([{ id: rootId, status: 'ok' }]);
        rootEpoch = run.targetEpoch;
        for (const legacy of ['ordinary', 'saved'] as const)
            expect((await rotateFile(run, theirs.id, { rekey: 'valid', legacy })).status).toBe(
                'unsupported',
            );
        expect(
            (await rotateFile(run, theirs.id, { rekey: 'valid', legacy: 'resealed' })).status,
        ).toBe('ok');

        // The owner's own file too: nothing a rotation signs there claims authorship (D3).
        expect(
            (await rotateFile(run, mine.id, { rekey: 'valid', legacy: 'ordinary' })).status,
        ).toBe('unsupported');
        expect((await rotateFile(run, mine.id, { rekey: 'valid' })).status).toBe('ok');
    });

    test('a record with no writer’s signature to keep is not re-keyed, only re-sealed', async () => {
        const doc = await file();
        // Written before signatures.
        await db
            .update(driveNodes)
            .set({ metadataSignerId: null, metadataSignature: null })
            .where(eq(driveNodes.id, doc.id));
        const run = await startOn(doc.id);
        // A re-key of it names no origin the server could copy: refused before any signature.
        expect(
            (
                await rotateFile(
                    run,
                    doc.id,
                    { legacy: 'resealed', rekey: { signature: randomBytes(64) } },
                    { rekey: 'valid' },
                )
            ).status,
        ).toBe('unsupported');
        const dropped = await rotateFile(run, doc.id, { legacy: 'resealed' }, { rekey: 'valid' });
        expect(dropped.status).toBe('ok');
        expect((await nodeRow(doc.id)).metadataOriginEnvelope).toBeNull();
        expect((await versionRow(dropped.versionId)).originEnvelope).not.toBeNull();
    });
});

describe('a legacy re-seal of a re-keyed record', () => {
    test('is refused, unless it drops the origin and is signed re-sealed (decision D9)', async () => {
        const doc = await file();
        await writtenBy(writer, doc);
        await rotatedOnce(doc.id, { rekey: 'valid' });
        const run = await startOn(doc.id);
        // What a shipped app sends: a legacy signature alone, no word of the origin.
        for (const legacy of ['ordinary', 'resealed'] as const)
            expect((await rotateFile(run, doc.id, { legacy })).status).toBe('unsupported');
        // Dropping the origin claims nothing: only as re-sealed.
        expect(
            (await rotateFile(run, doc.id, { legacy: 'ordinary', dropOrigin: true })).status,
        ).toBe('unsupported');
        expect((await nodeRow(doc.id)).metadataOriginEnvelope).not.toBeNull();

        const kept = await nodeRow(doc.id);
        const keptVersion = await versionRow(kept.currentVersionId!);
        const dropped = await rotateFile(run, doc.id, { legacy: 'resealed', dropOrigin: true });
        expect(dropped.status).toBe('ok');
        const after = await nodeRow(doc.id);
        expect(after.metadataOriginEnvelope).toBeNull();
        expect(after.metadataRekeySignature).toBeNull();
        expect(after.metadataSignature).not.toBeNull();
        expect((await versionRow(dropped.versionId)).originEnvelope).toBeNull();
        // Not silently: whose signature went and who dropped it stay on the record, for Info,
        // and in the evidence table with the dropped origin's digest and signature.
        expect(after.metadataDroppedSignerId).toBe(writer.userId);
        expect(after.metadataOriginDroppedBy).toBe(owner.userId);
        const version = await versionRow(dropped.versionId);
        expect(version.droppedSignerId).toBe(writer.userId);
        expect(version.originDroppedBy).toBe(owner.userId);
        const evidence = await db
            .select()
            .from(driveOriginDrops)
            .where(eq(driveOriginDrops.nodeId, doc.id));
        expect(
            evidence.map((row) => ({
                metadataVersion: row.metadataVersion,
                versionId: row.versionId,
                signer: row.originSignerId,
                by: row.droppedBy,
                epoch: row.targetEpoch,
            })),
        ).toEqual(
            expect.arrayContaining([
                {
                    metadataVersion: kept.metadataVersion,
                    versionId: null,
                    signer: writer.userId,
                    by: owner.userId,
                    epoch: run.targetEpoch,
                },
                {
                    metadataVersion: null,
                    versionId: keptVersion.id,
                    signer: writer.userId,
                    by: owner.userId,
                    epoch: run.targetEpoch,
                },
            ]),
        );
        const metadataDrop = evidence.find((row) => row.versionId === null)!;
        // The origin whole, its wrap and the binding the previous re-keyer signed: enough, with
        // the node key at that epoch, to tell a poisoned wrap from a dropper who lied.
        expect(metadataDrop.originEnvelope.equals(kept.metadataOriginEnvelope!)).toBe(true);
        expect(metadataDrop.originSignature.equals(kept.metadataOriginSignature!)).toBe(true);
        expect(metadataDrop.originKeyEnvelope.equals(kept.metadataOriginKeyEnvelope!)).toBe(true);
        expect(metadataDrop.previousRekeySignature.equals(kept.metadataRekeySignature!)).toBe(true);
        expect(metadataDrop.previousRekeyerId).toBe(kept.metadataSignerId);
        const versionDrop = evidence.find((row) => row.versionId !== null)!;
        expect(versionDrop.originEnvelope.equals(keptVersion.originEnvelope!)).toBe(true);
        expect(versionDrop.originKeyEnvelope.equals(keptVersion.originKeyEnvelope!)).toBe(true);
        expect(versionDrop.previousRekeySignature.equals(keptVersion.rekeySignature!)).toBe(true);
        expect(evidence).toHaveLength(2);

        // A later rotation re-keys the dropped record as its own origin: the trace stays.
        if (!(await rotations.finishRotation(run))) throw new Error('not finished');
        const next = await startOn(doc.id);
        expect((await rotateFile(next, doc.id, { rekey: 'valid' })).status).toBe('ok');
        expect((await nodeRow(doc.id)).metadataDroppedSignerId).toBe(writer.userId);
        // A rename writes the record again, but never hides that its origin was dropped.
        const renamed = await nodeRow(doc.id);
        expect(
            (
                await signed.renameNode({
                    workspaceId: ws,
                    userId: owner.userId,
                    nodeId: doc.id,
                    keyEpoch: renamed.keyEpoch,
                    metadataVersion: renamed.metadataVersion,
                    metadataEnvelope: meta(),
                })
            ).status,
        ).toBe('ok');
        const afterRename = await nodeRow(doc.id);
        expect(afterRename.metadataOriginEnvelope).toBeNull();
        expect(afterRename.metadataDroppedSignerId).toBe(writer.userId);
        expect(afterRename.metadataOriginDroppedBy).toBe(owner.userId);
        expect(
            await db.select().from(driveOriginDrops).where(eq(driveOriginDrops.nodeId, doc.id)),
        ).toHaveLength(2);
    });
});

describe('a second drop', () => {
    test('by someone else keeps the first trace on the record and adds its own evidence row', async () => {
        const doc = await file();
        await writtenBy(writer, doc);
        await rotatedOnce(doc.id, { rekey: 'valid' });
        // The owner drops it, then re-keys it again: the owner's re-sealed record is the origin.
        let run = await startOn(doc.id);
        expect(
            (await rotateFile(run, doc.id, { legacy: 'resealed', dropOrigin: true })).status,
        ).toBe('ok');
        if (!(await rotations.finishRotation(run))) throw new Error('not finished');
        await rotatedOnce(doc.id, { rekey: 'valid' });
        // The writer joins the family, and drops that origin in turn.
        const [area] = await db
            .select({ groupId: workspaces.groupId })
            .from(workspaces)
            .where(eq(workspaces.id, ws));
        await db.insert(groupMemberships).values({
            groupId: area!.groupId!,
            userId: writer.userId,
            state: 'active',
            roles: [],
            admittedAt: new Date(),
        });
        await db.insert(workspaceKeys).values({
            workspaceId: ws,
            userId: writer.userId,
            keyVersion: 1,
            workspaceKeyVersion: 1,
            wrappingSalt: randomBytes(32),
            wrappingNonce: randomBytes(24),
            encryptedKey: randomBytes(48),
        });
        run = await startOn(doc.id);
        const second = await rotateFile(
            { ...run, userId: writer.userId },
            doc.id,
            { legacy: 'resealed', dropOrigin: true },
            { legacy: 'resealed', dropOrigin: true },
            writer.userId,
        );
        expect(second.status).toBe('ok');
        const row = await nodeRow(doc.id);
        // The first trace stands: the writer's signature, dropped by the owner.
        expect(row.metadataDroppedSignerId).toBe(writer.userId);
        expect(row.metadataOriginDroppedBy).toBe(owner.userId);
        const evidence = await db
            .select()
            .from(driveOriginDrops)
            .where(and(eq(driveOriginDrops.nodeId, doc.id), isNull(driveOriginDrops.versionId)));
        expect(evidence.map((drop) => [drop.originSignerId, drop.droppedBy])).toEqual(
            expect.arrayContaining([
                [writer.userId, owner.userId],
                [owner.userId, writer.userId],
            ]),
        );
        expect(evidence).toHaveLength(2);
    });
});

/*
 * A drop's evidence must stand on its own: the rotation that drops an origin
 * overwrites the envelope the previous re-keyer sealed and its epoch, and a
 * later purge takes the version's object. Someone holding the node key at the
 * previous epoch rebuilds the previous re-keyer's statement from the row alone
 * and opens what it covers, so a poisoned wrap (their signature covers it)
 * can be told from a dropper who lied about one. Real envelopes, real wraps.
 */
describe('a drop’s evidence', () => {
    /* What the row alone shows, under `nodeKey`: whether the origin binds, and whose signatures hold. */
    async function evidenceOf(row: typeof driveOriginDrops.$inferSelect, nodeKey: Uint8Array) {
        const metadata = row.versionId === null;
        const record: OriginRecord = metadata
            ? { kind: 'metadata', metadataVersion: row.metadataVersion! }
            : { kind: 'version', versionId: row.versionId! };
        const aad = metadata
            ? metadataContext({
                  workspaceId: row.workspaceId,
                  nodeId: row.nodeId,
                  metadataVersion: row.metadataVersion!,
              })
            : contentKeyContext({
                  workspaceId: row.workspaceId,
                  nodeId: row.nodeId,
                  versionId: row.versionId!,
                  objectId: row.objectId!,
                  suite: row.contentSuite!,
              });
        const origin = {
            envelope: row.originEnvelope,
            signerId: row.originSignerId,
            signature: row.originSignature,
            keyEnvelope: row.originKeyEnvelope,
        };
        const statement = metadata
            ? metadataRekeyedStatement(
                  {
                      workspaceId: row.workspaceId,
                      nodeId: row.nodeId,
                      kind: row.nodeKind!,
                      metadataVersion: row.metadataVersion!,
                      metadataEnvelope: row.previousEnvelope!,
                      keyEpoch: row.previousKeyEpoch!,
                  },
                  origin,
              )
            : versionRekeyedStatement(
                  {
                      workspaceId: row.workspaceId,
                      nodeId: row.nodeId,
                      versionId: row.versionId!,
                      objectId: row.objectId!,
                      contentSuite: row.contentSuite!,
                      contentKeyEnvelope: row.previousEnvelope!,
                      keyEpoch: row.previousKeyEpoch!,
                  },
                  origin,
              );
        const writerStatement = metadata
            ? metadataStatement({
                  workspaceId: row.workspaceId,
                  nodeId: row.nodeId,
                  kind: row.nodeKind!,
                  metadataVersion: row.metadataVersion!,
                  metadataEnvelope: row.originEnvelope,
              })
            : versionStatement({
                  workspaceId: row.workspaceId,
                  nodeId: row.nodeId,
                  versionId: row.versionId!,
                  objectId: row.objectId!,
                  contentSuite: row.contentSuite!,
                  contentKeyEnvelope: row.originEnvelope,
              });
        const opened = await openOriginKey(row.originKeyEnvelope, nodeKey, {
            workspaceId: row.workspaceId,
            nodeId: row.nodeId,
            keyEpoch: row.previousKeyEpoch!,
            record,
            originEnvelope: row.originEnvelope,
        });
        const current = Buffer.from(await openEnvelopeBytes(row.previousEnvelope!, nodeKey, aad));
        const fromOrigin = await openWithOriginKey(row.originEnvelope, opened, aad).then(
            (bytes) => Buffer.from(bytes),
            () => null,
        );
        return {
            bound: fromOrigin !== null && fromOrigin.equals(current),
            rekeyerSigned: verifySignature(
                signerFor(row.previousRekeyerId!).publicKey,
                statement,
                row.previousRekeySignature,
            ),
            writerSigned: verifySignature(
                signerFor(row.originSignerId).publicKey,
                writerStatement,
                row.originSignature,
            ),
        };
    }

    /* The file's records as `writer` sealed them under `nodeKey` for real, and signed them. */
    async function sealedBy(nodeKey: Uint8Array, doc: { id: string }) {
        const row = await nodeRow(doc.id);
        const version = await versionRow(row.currentVersionId!);
        const content = {
            workspaceId: ws,
            nodeId: doc.id,
            versionId: version.id,
            objectId: version.objectId!,
            suite: 2,
        };
        const metadataEnvelope = Buffer.from(
            await sealMetadata(
                { name: 'Plans.pdf', mime: 'application/pdf', size: 1024, modified: null },
                nodeKey,
                { workspaceId: ws, nodeId: doc.id, metadataVersion: row.metadataVersion },
            ),
        );
        const contentKeyEnvelope = Buffer.from(
            await sealVersion(
                { contentKey: generateKey(), plaintextSize: 1024, thumbnailBytes: 0 },
                nodeKey,
                content,
            ),
        );
        await db.update(driveNodes).set({ metadataEnvelope }).where(eq(driveNodes.id, doc.id));
        await db
            .update(fileVersions)
            .set({ contentKeyEnvelope })
            .where(eq(fileVersions.id, version.id));
        await writtenBy(writer, doc);
        return {
            metadata: {
                envelope: metadataEnvelope,
                aad: metadataContext({
                    workspaceId: ws,
                    nodeId: doc.id,
                    metadataVersion: row.metadataVersion,
                }),
                record: { kind: 'metadata', metadataVersion: row.metadataVersion } as OriginRecord,
            },
            version: {
                envelope: contentKeyEnvelope,
                aad: contentKeyContext(content),
                record: { kind: 'version', versionId: version.id } as OriginRecord,
            },
        };
    }

    /*
     * An honest first re-key from `oldKey` to `newKey` at `keyEpoch`: each record re-sealed raw
     * and its origin's opening key wrapped, unless `poison` wraps some other key for one record.
     */
    async function rekeyed(
        records: Awaited<ReturnType<typeof sealedBy>>,
        nodeId: string,
        oldKey: Uint8Array,
        newKey: Uint8Array,
        keyEpoch: number,
        poison?: 'version',
    ): Promise<Sealed> {
        const one = async (
            entry: Awaited<ReturnType<typeof sealedBy>>['metadata'],
            poisoned: boolean,
        ) => ({
            envelope: Buffer.from(await rekeyEnvelope(entry.envelope, oldKey, newKey, entry.aad)),
            wrap: Buffer.from(
                await wrapOriginKey(
                    poisoned ? generateKey() : originOpeningKey(entry.envelope, oldKey),
                    newKey,
                    {
                        workspaceId: ws,
                        nodeId,
                        keyEpoch,
                        record: entry.record,
                        originEnvelope: entry.envelope,
                    },
                ),
            ),
        });
        const metadata = await one(records.metadata, false);
        const version = await one(records.version, poison === 'version');
        return {
            metadataEnvelope: metadata.envelope,
            contentKeyEnvelope: version.envelope,
            metadataWrap: metadata.wrap,
            versionWrap: version.wrap,
        };
    }

    /* A newer version published over the current one, which is then discarded and purged. */
    async function purgeCurrentVersion(nodeId: string) {
        const row = await nodeRow(nodeId);
        const objectId = randomUUID();
        const next = await signed.beginUpload({
            workspaceId: ws,
            userId: owner.userId,
            node: {
                existing: true,
                id: nodeId,
                keyEpoch: row.keyEpoch,
                expectedVersionId: row.currentVersionId,
            },
            version: { id: randomUUID(), contentKeyEnvelope: randomBytes(84) },
            object: {
                id: objectId,
                objectKey: `ws/${ws}/${objectId}`,
                contentSuite: 2,
                chunkSize: Number(8n * MiB),
                chunkCount: 1,
                contentNonce: randomBytes(16),
                ciphertextSize: MiB + 16n,
            },
            multipartId: `mp-${objectId}`,
            expiresAt: new Date(Date.now() + 3600_000),
        });
        if (next.status !== 'ok') throw new Error(next.status);
        await drive.startCompleting(ws, next.uploadId);
        const done = await drive.finishCompleting(ws, next.uploadId, MiB + 16n);
        if (done.status !== 'published') throw new Error(done.status);
        const discarded = await drive.discardVersion(ws, row.currentVersionId!);
        if (discarded.status !== 'ok') throw new Error(discarded.status);
        expect((await versionRow(row.currentVersionId!)).status).toBe('purged');
    }

    const evidenceRows = (nodeId: string) =>
        db.select().from(driveOriginDrops).where(eq(driveOriginDrops.nodeId, nodeId));

    /* Written by `writer` under K0, re-keyed by the owner to K1, then dropped by the owner. */
    async function droppedFile(poison?: 'version') {
        const doc = await file();
        const k0 = generateKey();
        const k1 = generateKey();
        const records = await sealedBy(k0, doc);
        const first = await startOn(doc.id);
        const sealed = await rekeyed(records, doc.id, k0, k1, first.targetEpoch, poison);
        const result = await rotateFile(
            first,
            doc.id,
            { rekey: 'valid' },
            { rekey: 'valid' },
            owner.userId,
            sealed,
        );
        if (result.status !== 'ok') throw new Error(result.status);
        if (!(await rotations.finishRotation(first))) throw new Error('not finished');
        const drop = await startOn(doc.id);
        expect(
            (await rotateFile(drop, doc.id, { legacy: 'resealed', dropOrigin: true })).status,
        ).toBe('ok');
        if (!(await rotations.finishRotation(drop))) throw new Error('not finished');
        return { doc, k1, firstEpoch: first.targetEpoch, versionId: result.versionId };
    }

    test('the row alone, with the old node key, rebuilds the previous re-keyer’s statement and verifies it, after a later rotation and a purge', async () => {
        const { doc, k1, firstEpoch, versionId } = await droppedFile();
        const before = await evidenceRows(doc.id);
        expect(before.map((row) => row.versionId)).toEqual(
            expect.arrayContaining([null, versionId]),
        );
        expect(before).toHaveLength(2);
        for (const row of before) {
            expect(row.previousKeyEpoch).toBe(firstEpoch);
            expect(row.previousRekeyerId).toBe(owner.userId);
            expect(await evidenceOf(row, k1)).toEqual({
                bound: true,
                rekeyerSigned: true,
                writerSigned: true,
            });
        }

        // The record moves on: re-keyed again over the dropper's re-sealed record, and its
        // version replaced and purged, its object gone. The evidence needs none of it.
        await rotatedOnce(doc.id, { rekey: 'valid' });
        await purgeCurrentVersion(doc.id);
        const node = await nodeRow(doc.id);
        expect(node.keyEpoch).toBeGreaterThan(firstEpoch);
        const after = await evidenceRows(doc.id);
        expect(after).toHaveLength(2);
        for (const row of after)
            expect(await evidenceOf(row, k1)).toEqual({
                bound: true,
                rekeyerSigned: true,
                writerSigned: true,
            });
    });

    test('tells a poisoned wrap, which the previous re-keyer signed, from an origin that binds', async () => {
        const { doc, k1, versionId } = await droppedFile('version');
        const rows = await evidenceRows(doc.id);
        const version = rows.find((row) => row.versionId === versionId)!;
        const metadata = rows.find((row) => row.versionId === null)!;
        // The owner's signature covers a wrap that opens nothing of the writer's: their fault, and
        // the dropper was right to drop it. The metadata beside it bound: a drop of that was not.
        expect(await evidenceOf(version, k1)).toEqual({
            bound: false,
            rekeyerSigned: true,
            writerSigned: true,
        });
        expect((await evidenceOf(metadata, k1)).bound).toBe(true);
    });
});

describe('writes outside a rotation', () => {
    test('a rename clears the metadata’s origin, and a discarded version its own', async () => {
        const doc = await file();
        await writtenBy(writer, doc);
        const rotated = await rotatedOnce(doc.id, { rekey: 'valid' });
        const row = await nodeRow(doc.id);
        expect(row.metadataOriginEnvelope).not.toBeNull();

        const renamed = await signed.renameNode({
            workspaceId: ws,
            userId: owner.userId,
            nodeId: doc.id,
            keyEpoch: row.keyEpoch,
            metadataVersion: row.metadataVersion,
            metadataEnvelope: meta(),
        });
        expect(renamed.status).toBe('ok');
        const after = await nodeRow(doc.id);
        expect(after.metadataOriginEnvelope).toBeNull();
        expect(after.metadataOriginKeyEnvelope).toBeNull();
        expect(after.metadataOriginSignerId).toBeNull();
        expect(after.metadataOriginSignature).toBeNull();
        expect(after.metadataRekeySignature).toBeNull();
        // The version was not rewritten: its origin stands.
        expect((await versionRow(rotated.versionId)).originEnvelope).not.toBeNull();

        // A newer version displaces it; discarding the old one purges its origin with it.
        const next = await signed.beginUpload({
            workspaceId: ws,
            userId: owner.userId,
            node: {
                existing: true,
                id: doc.id,
                keyEpoch: after.keyEpoch,
                expectedVersionId: after.currentVersionId,
            },
            version: { id: randomUUID(), contentKeyEnvelope: randomBytes(84) },
            object: (() => {
                const objectId = randomUUID();
                return {
                    id: objectId,
                    objectKey: `ws/${ws}/${objectId}`,
                    contentSuite: 2,
                    chunkSize: Number(8n * MiB),
                    chunkCount: 1,
                    contentNonce: randomBytes(16),
                    ciphertextSize: MiB + 16n,
                };
            })(),
            multipartId: `mp-${randomUUID()}`,
            expiresAt: new Date(Date.now() + 3600_000),
        });
        if (next.status !== 'ok') throw new Error(next.status);
        await drive.startCompleting(ws, next.uploadId);
        expect((await drive.finishCompleting(ws, next.uploadId, MiB + 16n)).status).toBe(
            'published',
        );
        expect(await drive.discardVersion(ws, rotated.versionId)).toEqual({
            status: 'ok',
        });
        const purged = await versionRow(rotated.versionId);
        expect(purged.status).toBe('purged');
        expect(purged.originEnvelope).toBeNull();
        expect(purged.originSignerId).toBeNull();
        expect(purged.rekeySignature).toBeNull();
    });
});

describe('the origin columns', () => {
    async function rekeyedFile() {
        const doc = await file();
        await writtenBy(writer, doc);
        const rotated = await rotatedOnce(doc.id, { rekey: 'valid' });
        return { node: await nodeRow(doc.id), version: await versionRow(rotated.versionId) };
    }
    const refused = (write: Promise<unknown>) =>
        expect(write.then(() => 'stored')).rejects.toBeDefined();

    test('hold a whole origin or none, of the right lengths', async () => {
        const { node } = await rekeyedFile();
        const set = (values: Partial<typeof driveNodes.$inferInsert>) =>
            db.update(driveNodes).set(values).where(eq(driveNodes.id, node.id));
        // Each required part missing in turn.
        for (const missing of [
            { metadataOriginEnvelope: null },
            { metadataOriginKeyEnvelope: null },
            { metadataOriginSignature: null },
            { metadataRekeySignature: null },
        ])
            await refused(set(missing));
        // An origin signer and nothing else.
        const doc = await file();
        await refused(
            db
                .update(driveNodes)
                .set({ metadataOriginSignerId: writer.userId })
                .where(eq(driveNodes.id, doc.id)),
        );
        // Lengths: the wrap is exactly 72 bytes, the origin at most 4136, signatures 64.
        await refused(set({ metadataOriginKeyEnvelope: randomBytes(71) }));
        await refused(set({ metadataOriginKeyEnvelope: randomBytes(73) }));
        await refused(set({ metadataOriginEnvelope: randomBytes(4137) }));
        await refused(set({ metadataOriginSignature: randomBytes(63) }));
        await refused(set({ metadataRekeySignature: randomBytes(65) }));
        // An origin always names its writer (no foreign key nulls it), and may be 4136 bytes.
        await refused(set({ metadataOriginSignerId: null }));
        await set({ metadataOriginEnvelope: randomBytes(4136) });
        // A signer with neither a legacy signature nor a re-key signature is refused.
        await refused(
            db
                .update(driveNodes)
                .set({ metadataSignature: null, metadataSignerId: owner.userId })
                .where(eq(driveNodes.id, doc.id)),
        );
    });

    test('a version’s origin is as long as its envelope, and goes when the version is purged', async () => {
        const { version } = await rekeyedFile();
        const set = (values: Partial<typeof fileVersions.$inferInsert>) =>
            db.update(fileVersions).set(values).where(eq(fileVersions.id, version.id));
        expect(version.contentKeyEnvelope!.length).toBe(84);
        // A suite 1 length beside a suite 2 envelope, and neither suite's.
        await refused(set({ originEnvelope: randomBytes(72) }));
        await refused(set({ originEnvelope: randomBytes(100) }));
        await refused(set({ originKeyEnvelope: randomBytes(84) }));
        await refused(set({ originSignerId: null }));
        // Purged with its origin left behind.
        await refused(
            set({
                status: 'purged',
                contentKeyEnvelope: null,
                signerId: null,
                signature: null,
                purgedAt: new Date(),
            }),
        );
    });

    test('keep a gone writer’s id: deleting their account leaves the origin naming them', async () => {
        const { node, version } = await rekeyedFile();
        expect(node.metadataOriginSignerId).toBe(writer.userId);
        await db.delete(users).where(eq(users.id, writer.userId));
        // A foreign key would have nulled it (and made the re-key statement unbuildable); the
        // owner's decision is that a gone writer reads as someone unknown, the re-keyer verifying.
        const after = await nodeRow(node.id);
        expect(after.metadataOriginSignerId).toBe(writer.userId);
        expect(after.metadataSignerId).toBe(owner.userId);
        expect((await versionRow(version.id)).originSignerId).toBe(writer.userId);
    });
});

/*
 * The owner's own drive, outside the re-keyed scope until native clients read
 * origins (rekeyedFor): a rotation takes exactly what shipped apps send, the
 * legacy statement alone, and nothing it writes leaves an origin a shipped
 * app would stall on.
 */
describe('a personal workspace', () => {
    beforeEach(async () => {
        ws = owner.workspaceId;
        await db.insert(workspaceKeys).values({
            workspaceId: ws,
            userId: owner.userId,
            keyVersion: 1,
            wrappingSalt: randomBytes(32),
            wrappingNonce: randomBytes(24),
            encryptedKey: randomBytes(48),
        });
        await makeRoot();
    });

    test('takes a native-shaped legacy rotation as before, someone else’s record included, and writes no origin', async () => {
        const doc = await file();
        await writtenBy(writer, doc);
        const run = await startOn(doc.id);
        const row = await nodeRow(doc.id);
        const current = await versionRow(row.currentVersionId!);
        const sign = signerFor(owner.userId);
        const metadataEnvelope = meta();
        const contentKeyEnvelope = randomBytes(84);
        // Exactly the fields a shipped app sends: no re-key, no origin, no drop.
        const [result] = await rotations.rotateNodes({
            ...run,
            nodes: [
                {
                    id: doc.id,
                    changeSeq: row.changeSeq!,
                    parentKeyEpoch: rootEpoch,
                    keyEnvelope: env(),
                    rotated: {
                        metadataEnvelope,
                        metadataSignature: sign.sign(
                            metadataStatement({
                                workspaceId: ws,
                                nodeId: doc.id,
                                kind: 'file',
                                metadataVersion: row.metadataVersion,
                                metadataEnvelope,
                            }),
                        ),
                        versions: [
                            {
                                id: current.id,
                                contentKeyEnvelope,
                                signature: sign.sign(
                                    versionStatement({
                                        workspaceId: ws,
                                        nodeId: doc.id,
                                        versionId: current.id,
                                        objectId: current.objectId!,
                                        contentSuite: 2,
                                        contentKeyEnvelope,
                                    }),
                                ),
                            },
                        ],
                        shares: [],
                        links: [],
                        unsealableLinks: [],
                    },
                },
            ],
        });
        expect(result!.status).toBe('ok');
        const after = await nodeRow(doc.id);
        expect(after.metadataSignerId).toBe(owner.userId);
        expect(after.metadataSignature).not.toBeNull();
        expect(after.metadataOriginEnvelope).toBeNull();
        expect(after.metadataRekeySignature).toBeNull();
        const version = await versionRow(current.id);
        expect(version.signature).not.toBeNull();
        expect(version.originEnvelope).toBeNull();
        expect(version.rekeySignature).toBeNull();
    });

    test('refuses the re-keyed form whole, so no origin is ever written there; a drop flag changes nothing', async () => {
        const doc = await file();
        await writtenBy(writer, doc);
        const before = await nodeRow(doc.id);
        const run = await startOn(doc.id);
        // A valid re-key, with or without a legacy signature beside it: not taken here yet.
        for (const signing of [{ rekey: 'valid' }, { rekey: 'valid', legacy: 'resealed' }] as const)
            expect((await rotateFile(run, doc.id, signing)).status).toBe('unsupported');
        const untouched = await nodeRow(doc.id);
        expect(untouched.keyEpoch).toBe(before.keyEpoch);
        expect(untouched.metadataOriginEnvelope).toBeNull();
        // A legacy re-seal marked as dropping an origin the row never had lands as any other.
        const dropped = await rotateFile(run, doc.id, { legacy: 'resealed', dropOrigin: true });
        expect(dropped.status).toBe('ok');
        expect((await nodeRow(doc.id)).metadataOriginEnvelope).toBeNull();
        expect((await versionRow(dropped.versionId)).originEnvelope).toBeNull();
    });
});

/*
 * The legacy signature beside a re-key over the rotator's own origin
 * (decision D2, the honest form), checked on its own: no workspace takes it
 * yet (rekeyedFor keeps personal workspaces out, D3 refuses it in group
 * areas), so this calls the record check directly as a widened scope would.
 * It may claim no more than the origin's own signature did.
 */
describe('a legacy signature beside a re-key over one’s own origin', () => {
    const ROTATOR = '0b0b0b0b-0000-4000-8000-00000000000b';
    const fields = {
        workspaceId: '0a0a0a0a-0000-4000-8000-00000000000a',
        nodeId: '0c0c0c0c-0000-4000-8000-00000000000c',
        kind: 'file' as const,
        metadataVersion: 2,
    };
    const key = signingKeyFromSeed(Buffer.alloc(32, 9));
    const origin = randomBytes(100);
    const next = randomBytes(100);
    const check = (originForm: StatementForm, legacy: StatementForm) => {
        const originSignature = key.sign(
            metadataStatement({ ...fields, metadataEnvelope: origin }, originForm),
        );
        const keyEnvelope = randomBytes(72);
        return rotations.checkRotatedRecord({
            // The rotator's own record, no origin kept: it becomes the origin.
            stored: {
                envelope: origin,
                signerId: ROTATOR,
                signature: originSignature,
                originEnvelope: null,
                originSignerId: null,
                originSignature: null,
            },
            sent: {
                signature: key.sign(
                    metadataStatement({ ...fields, metadataEnvelope: next }, legacy),
                ),
                rekey: {
                    originKeyEnvelope: keyEnvelope,
                    signature: key.sign(
                        metadataRekeyedStatement(
                            { ...fields, metadataEnvelope: next, keyEpoch: 9 },
                            {
                                envelope: origin,
                                signerId: ROTATOR,
                                signature: originSignature,
                                keyEnvelope,
                            },
                        ),
                    ),
                },
            },
            key: key.publicKey,
            rotator: ROTATOR,
            inScope: true,
            group: false,
            legacy: (envelope, signature) =>
                metadataSigned({ ...fields, metadataEnvelope: envelope }, signature),
            envelope: next,
            rekeyed: (full) =>
                metadataRekeyedStatement({ ...fields, metadataEnvelope: next, keyEpoch: 9 }, full),
        });
    };
    const status = (result: ReturnType<typeof check>) =>
        typeof result === 'string' ? result : 'ok';

    test('a re-sealed origin of one’s own (after a drop) never comes back ordinary or saved', () => {
        expect(status(check('resealed', 'ordinary'))).toBe('unsupported');
        expect(status(check('resealed', 'saved'))).toBe('unsupported');
        expect(status(check('resealed', 'resealed'))).toBe('ok');
    });

    test('an ordinary origin stays ordinary, a saved one saved, and neither turns into the other', () => {
        expect(status(check('ordinary', 'ordinary'))).toBe('ok');
        expect(status(check('saved', 'saved'))).toBe('ok');
        expect(status(check('saved', 'ordinary'))).toBe('unsupported');
        expect(status(check('ordinary', 'saved'))).toBe('unsupported');
    });
});

describe('a report of a re-keyed record', () => {
    test('snapshots its writer beside its re-keyer', async () => {
        const doc = await file();
        await writtenBy(writer, doc);
        await rotatedOnce(doc.id, { rekey: 'valid' });
        const operator = await createTestAccount();
        await createTestIdentity(operator.userId);
        await db.update(users).set({ role: 'admin' }).where(eq(users.id, operator.userId));
        const row = await nodeRow(doc.id);
        const filed = await reports.createReport({
            id: randomUUID(),
            workspaceId: ws,
            nodeId: doc.id,
            keyEpoch: row.keyEpoch,
            linkId: null,
            shareId: null,
            category: 'other',
            reason: 'Looks wrong.',
            reporterUserId: null,
            reporterEmail: null,
            reporterAddressHash: createHash('sha256').update('1.2.3.4').digest(),
            keys: [{ operatorUserId: operator.userId, keyEnvelope: randomBytes(112) }],
        });
        if (filed.status !== 'ok') throw new Error(filed.status);
        const [item] = await db
            .select()
            .from(driveReportItems)
            .where(eq(driveReportItems.reportId, filed.report.id));
        // The re-keyer locked it; the writer wrote it: evidence keeps both, not the re-keyer alone.
        expect(item!.metadataSignerId).toBe(owner.userId);
        expect(item!.metadataOriginSignerId).toBe(writer.userId);
        expect(item!.versionSignerId).toBe(owner.userId);
        expect(item!.versionOriginSignerId).toBe(writer.userId);
    });
});
