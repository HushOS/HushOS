import { eq } from 'drizzle-orm';
import { db } from '../src/client';
import * as drive from '../src/drive';
import * as rotations from '../src/rotations';
import { driveNodes, driveObjects, driveUploads, fileVersions } from '../src/schema';
import { metadataStatement, versionStatement } from '../src/signatures';
import { signerFor } from './helpers';

/*
 * The repository's writes as a client makes them: every metadata and
 * content-key envelope signed by the writing account's test identity (see
 * createTestIdentity), with the statement built from the values the write will
 * store. Suites that are not about signatures write through these; the suites
 * that are call the repository directly with the signatures they mean to test.
 */

type Unsigned = Omit<drive.NodeEnvelopes, 'metadataSignature'>;

function sealNode(
    userId: string,
    workspaceId: string,
    nodeId: string,
    kind: 'folder' | 'file',
    envelopes: Unsigned,
    metadataVersion = 1,
): drive.NodeEnvelopes {
    return {
        ...envelopes,
        metadataSignature: signerFor(userId).sign(
            metadataStatement({
                workspaceId,
                nodeId,
                kind,
                metadataVersion,
                metadataEnvelope: envelopes.metadataEnvelope,
            }),
        ),
    };
}

function sealVersion(userId: string, input: Parameters<typeof versionStatement>[0]) {
    return signerFor(userId).sign(versionStatement(input));
}

async function objectOfVersion(versionId: string) {
    const [row] = await db
        .select({ objectId: fileVersions.objectId, contentSuite: driveObjects.contentSuite })
        .from(fileVersions)
        .innerJoin(driveObjects, eq(driveObjects.id, fileVersions.objectId))
        .where(eq(fileVersions.id, versionId));
    return row;
}

export function createRoot(
    input: Omit<Parameters<typeof drive.createRoot>[0], 'envelopes'> & { envelopes: Unsigned },
) {
    return drive.createRoot({
        ...input,
        envelopes: sealNode(input.userId, input.workspaceId, input.id, 'folder', input.envelopes),
    });
}

export function createFolders(input: {
    workspaceId: string;
    userId: string;
    folders: { id: string; parentId: string; envelopes: Unsigned }[];
}) {
    return drive.createFolders({
        ...input,
        folders: input.folders.map((folder) => ({
            ...folder,
            envelopes: sealNode(
                input.userId,
                input.workspaceId,
                folder.id,
                'folder',
                folder.envelopes,
            ),
        })),
    });
}

export async function renameNode(
    input: Omit<Parameters<typeof drive.renameNode>[0], 'metadataSignature'>,
) {
    const [node] = await db
        .select({ kind: driveNodes.kind })
        .from(driveNodes)
        .where(eq(driveNodes.id, input.nodeId));
    return drive.renameNode({
        ...input,
        metadataSignature: signerFor(input.userId).sign(
            metadataStatement({
                workspaceId: input.workspaceId,
                nodeId: input.nodeId,
                kind: node?.kind ?? 'folder',
                metadataVersion: input.metadataVersion + 1,
                metadataEnvelope: input.metadataEnvelope,
            }),
        ),
    });
}

export function beginUpload(
    input: Omit<drive.UploadBegin, 'node' | 'version'> & {
        node:
            | { existing: false; id: string; parentId: string; envelopes: Unsigned }
            | { existing: true; id: string; keyEpoch: number; expectedVersionId: string | null };
        version: { id: string; contentKeyEnvelope: Buffer };
    },
) {
    const node = input.node.existing
        ? input.node
        : {
              ...input.node,
              envelopes: sealNode(
                  input.userId,
                  input.workspaceId,
                  input.node.id,
                  'file',
                  input.node.envelopes,
              ),
          };
    return drive.beginUpload({
        ...input,
        node,
        version: {
            ...input.version,
            signature: sealVersion(input.userId, {
                workspaceId: input.workspaceId,
                nodeId: input.node.id,
                versionId: input.version.id,
                objectId: input.object.id,
                contentSuite: input.object.contentSuite,
                contentKeyEnvelope: input.version.contentKeyEnvelope,
            }),
        },
    });
}

export async function copyFile(
    input: Omit<drive.CopyFile, 'node' | 'version'> & {
        node: { id: string; parentId: string; envelopes: Unsigned };
        version: { id: string; contentKeyEnvelope: Buffer };
    },
) {
    const source = await objectOfVersion(input.sourceVersionId);
    return drive.copyFile({
        ...input,
        node: {
            ...input.node,
            envelopes: sealNode(
                input.userId,
                input.workspaceId,
                input.node.id,
                'file',
                input.node.envelopes,
            ),
        },
        version: {
            ...input.version,
            signature: sealVersion(input.userId, {
                workspaceId: input.workspaceId,
                nodeId: input.node.id,
                versionId: input.version.id,
                objectId: source?.objectId ?? input.version.id,
                contentSuite: source?.contentSuite ?? 0,
                contentKeyEnvelope: input.version.contentKeyEnvelope,
            }),
        },
    });
}

type UnsignedAttach = { userId: string; contentKeyEnvelope: Buffer } & (
    | { mode: 'same-node'; keyEpoch: number }
    | {
          mode: 'sibling';
          node: {
              id: string;
              parentId: string;
              keyEpoch: number;
              parentKeyEpoch: number;
              keyEnvelope: Buffer;
              metadataEnvelope: Buffer;
          };
      }
);

export async function attachUpload(workspaceId: string, uploadId: string, input: UnsignedAttach) {
    const [upload] = await db
        .select({ nodeId: driveUploads.nodeId, versionId: driveUploads.versionId })
        .from(driveUploads)
        .where(eq(driveUploads.id, uploadId));
    const object = upload ? await objectOfVersion(upload.versionId) : undefined;
    const nodeId = input.mode === 'same-node' ? (upload?.nodeId ?? uploadId) : input.node.id;
    const versionSignature = sealVersion(input.userId, {
        workspaceId,
        nodeId,
        versionId: upload?.versionId ?? uploadId,
        objectId: object?.objectId ?? uploadId,
        contentSuite: object?.contentSuite ?? 0,
        contentKeyEnvelope: input.contentKeyEnvelope,
    });
    return drive.attachUpload(
        workspaceId,
        uploadId,
        input.mode === 'same-node'
            ? { ...input, versionSignature }
            : {
                  ...input,
                  versionSignature,
                  node: {
                      ...input.node,
                      metadataSignature: sealNode(input.userId, workspaceId, nodeId, 'file', {
                          ...input.node,
                      }).metadataSignature,
                  },
              },
    );
}

type UnsignedRotated = Omit<rotations.RotatedNodeInput, 'rotated'> & {
    rotated:
        | (Omit<
              NonNullable<rotations.RotatedNodeInput['rotated']>,
              'metadataSignature' | 'versions'
          > & { versions: { id: string; contentKeyEnvelope: Buffer }[] })
        | null;
};

export async function rotateNodes(
    input: Omit<Parameters<typeof rotations.rotateNodes>[0], 'nodes'> & {
        nodes: UnsignedRotated[];
    },
) {
    const nodes: rotations.RotatedNodeInput[] = [];
    for (const item of input.nodes) {
        if (!item.rotated) {
            nodes.push({ ...item, rotated: null });
            continue;
        }
        const [node] = await db
            .select({ kind: driveNodes.kind, metadataVersion: driveNodes.metadataVersion })
            .from(driveNodes)
            .where(eq(driveNodes.id, item.id));
        const versions = [];
        for (const version of item.rotated.versions) {
            const object = await objectOfVersion(version.id);
            versions.push({
                ...version,
                signature: sealVersion(input.userId, {
                    workspaceId: input.workspaceId,
                    nodeId: item.id,
                    versionId: version.id,
                    objectId: object?.objectId ?? version.id,
                    contentSuite: object?.contentSuite ?? 0,
                    contentKeyEnvelope: version.contentKeyEnvelope,
                }),
            });
        }
        nodes.push({
            ...item,
            rotated: {
                ...item.rotated,
                versions,
                metadataSignature: signerFor(input.userId).sign(
                    metadataStatement({
                        workspaceId: input.workspaceId,
                        nodeId: item.id,
                        kind: node?.kind ?? 'folder',
                        metadataVersion: node?.metadataVersion ?? 1,
                        metadataEnvelope: item.rotated.metadataEnvelope,
                    }),
                ),
            },
        });
    }
    return rotations.rotateNodes({ ...input, nodes });
}
