import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { driveRepository, scopedId, type IdKind } from '@hushos/db';
import { db } from '../../db/src/client';
import { workspaceKeys } from '../../db/src/schema';
import { metadataStatement, versionStatement } from '../../db/src/signatures';
import { createTestAccount, createTestIdentity, signerFor } from '../../db/test/helpers';
import * as signed from '../../db/test/signed';

/*
 * A workspace as the domain's tests need it: an owner who is a member, with a
 * signing identity, a root, and helpers that write folders, published files,
 * links and suite 3 shares through the repository the way a client would.
 * Nothing here reaches the store; the tests replace it.
 */

const MiB = 1024n * 1024n;
export const keyEnvelope = () => randomBytes(72);
export const metadataEnvelope = () => randomBytes(100);
export const hashToken = (token: string) => createHash('sha256').update(token).digest();

export type Account = Awaited<ReturnType<typeof createTestAccount>>;

/* A client-made id as a client mints it: a fresh seed and the id it derives for `kind` in `workspaceId`. */
export function minted(kind: IdKind, workspaceId: string) {
    const seed = randomBytes(16).toString('base64url');
    return { id: scopedId(kind, workspaceId, seed)!, seed };
}

export async function member(input: { quotaBytes?: bigint } = {}) {
    const account = await createTestAccount(input);
    await createTestIdentity(account.userId);
    await db.insert(workspaceKeys).values({
        workspaceId: account.workspaceId,
        userId: account.userId,
        keyVersion: 1,
        wrappingSalt: randomBytes(32),
        wrappingNonce: randomBytes(24),
        encryptedKey: randomBytes(48),
    });
    return account;
}

export async function epoch(workspaceId: string) {
    return (await driveRepository.allocateKeyEpochs(workspaceId, 1))!.from;
}

export async function root(owner: Account) {
    const created = await signed.createRoot({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        id: randomUUID(),
        envelopes: {
            keyEpoch: await epoch(owner.workspaceId),
            parentKeyEpoch: 1,
            keyEnvelope: keyEnvelope(),
            metadataEnvelope: metadataEnvelope(),
        },
    });
    if (created.status !== 'created') throw new Error(created.status);
    return created.root;
}

export async function folder(owner: Account, parent: { id: string; keyEpoch: number }) {
    const created = await signed.createFolders({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        folders: [
            {
                id: randomUUID(),
                parentId: parent.id,
                envelopes: {
                    keyEpoch: await epoch(owner.workspaceId),
                    parentKeyEpoch: parent.keyEpoch,
                    keyEnvelope: keyEnvelope(),
                    metadataEnvelope: metadataEnvelope(),
                },
            },
        ],
    });
    if (created.status !== 'created') throw new Error(created.status);
    return created.nodes[0]!;
}

/* A suite 3 file of `size` stored bytes, published. */
export async function file(
    owner: Account,
    parent: { id: string; keyEpoch: number },
    size = 1n * MiB,
) {
    const objectId = randomUUID();
    const begun = await signed.beginUpload({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        node: {
            existing: false,
            id: randomUUID(),
            parentId: parent.id,
            envelopes: {
                keyEpoch: await epoch(owner.workspaceId),
                parentKeyEpoch: parent.keyEpoch,
                keyEnvelope: keyEnvelope(),
                metadataEnvelope: metadataEnvelope(),
            },
        },
        version: { id: randomUUID(), contentKeyEnvelope: randomBytes(84) },
        object: {
            id: objectId,
            objectKey: `ws/${owner.workspaceId}/${objectId}`,
            contentSuite: 3,
            chunkSize: Number(8n * MiB),
            chunkCount: 1,
            contentNonce: randomBytes(16),
            ciphertextSize: size,
        },
        multipartId: `mp-${objectId}`,
        expiresAt: new Date(Date.now() + 3600_000),
    });
    if (begun.status !== 'ok') throw new Error(begun.status);
    await driveRepository.startCompleting(owner.workspaceId, begun.uploadId);
    const done = await driveRepository.finishCompleting(owner.workspaceId, begun.uploadId, size);
    if (done.status !== 'published') throw new Error(done.status);
    return done.node;
}

/* A live link on `node`; the token is what a visitor holds. */
export async function link(owner: Account, node: { id: string; keyEpoch: number }) {
    const token = randomBytes(32).toString('base64url');
    const made = await driveRepository.createLink({
        id: randomUUID(),
        workspaceId: owner.workspaceId,
        nodeId: node.id,
        granterUserId: owner.userId,
        tokenHash: hashToken(token),
        keyEpoch: node.keyEpoch,
        linkEnvelope: randomBytes(72),
        linkSalt: randomBytes(16),
        secretEnvelope: randomBytes(136),
        hasPassword: false,
        expiresAt: null,
    });
    if (made.status !== 'ok') throw new Error(made.status);
    return token;
}

/* A suite 3 share of `node` with `grantee`, who gets an identity of their own. */
export async function share(
    owner: Account,
    node: { id: string; keyEpoch: number },
    grantee: Account,
    role: 'viewer' | 'editor',
) {
    const made = await driveRepository.createShare({
        workspaceId: owner.workspaceId,
        nodeId: node.id,
        granterUserId: owner.userId,
        granteeUserId: grantee.userId,
        role,
        keyEpoch: node.keyEpoch,
        shareEnvelope: randomBytes(4565),
    });
    if (made.status !== 'ok') throw new Error(made.status);
    return made.share.id;
}

/* Every key anywhere inside a JSON-shaped value, for asserting what a response never carries. */
export function keysOf(value: unknown): Set<string> {
    const keys = new Set<string>();
    const visit = (entry: unknown) => {
        if (Array.isArray(entry)) entry.forEach(visit);
        else if (entry && typeof entry === 'object')
            for (const [key, inner] of Object.entries(entry)) {
                keys.add(key);
                visit(inner);
            }
    };
    visit(value);
    return keys;
}

const b64 = (bytes: Buffer) => bytes.toString('base64url');

/* A begin as a client sends it: fresh ids for the owner's workspace, signed by the owner, for a new file under `parent`. */
export async function beginInput(
    owner: Account,
    parent: { id: string; keyEpoch: number },
    framing: { chunkCount: number; ciphertextSize: number },
) {
    const node = minted('node', owner.workspaceId);
    const version = minted('version', owner.workspaceId);
    const object = minted('object', owner.workspaceId);
    const metadata = randomBytes(24 + 256 + 16);
    const content = randomBytes(84);
    const sign = signerFor(owner.userId).sign;
    return {
        node: {
            existing: false as const,
            id: node.id,
            idSeed: node.seed,
            parentId: parent.id,
            keyEpoch: await epoch(owner.workspaceId),
            parentKeyEpoch: parent.keyEpoch,
            keyEnvelope: b64(randomBytes(72)),
            metadataEnvelope: b64(metadata),
            metadataSignature: b64(
                sign(
                    metadataStatement({
                        workspaceId: owner.workspaceId,
                        nodeId: node.id,
                        kind: 'file',
                        metadataVersion: 1,
                        metadataEnvelope: metadata,
                    }),
                ),
            ),
        },
        versionId: version.id,
        versionIdSeed: version.seed,
        objectId: object.id,
        objectIdSeed: object.seed,
        contentKeyEnvelope: b64(content),
        versionSignature: b64(
            sign(
                versionStatement({
                    workspaceId: owner.workspaceId,
                    nodeId: node.id,
                    versionId: version.id,
                    objectId: object.id,
                    contentSuite: 3,
                    contentKeyEnvelope: content,
                }),
            ),
        ),
        contentNonce: b64(randomBytes(16)),
        contentSuite: 3,
        chunkCount: framing.chunkCount,
        ciphertextSize: String(framing.ciphertextSize),
    };
}
