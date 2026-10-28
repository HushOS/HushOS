import { describe, expect, test } from 'vitest';
import type { DriveApi, NodeView, VersionView } from './api';
import { createDriveClient, type Rpc } from './client';

/*
 * A node's attributes (a folder's colour, and keys a newer client added that
 * this one does not know) ride along whenever this client seals its record
 * again: a rename, a copy of a file, a copy of a folder and everything in it.
 * The worker here opens every record to metadata with attributes and records
 * what it is asked to seal, so a path that rebuilds the record from its known
 * fields alone shows up as attributes missing from what was sealed.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const ROOT = 'root';
const FOLDER = 'folder';
const INNER = 'inner';
const FILE = 'file';
const DEST = 'dest';

const ATTRIBUTES: Record<string, Record<string, string>> = {
    [FOLDER]: { colour: 'blue', 'zz-unknown': 'from a newer client' },
    [INNER]: { colour: 'red' },
    [FILE]: { 'zz-unknown': 'kept' },
};

function version(id: string): VersionView {
    return {
        id: `${id}-v`,
        objectId: `${id}-o`,
        contentKeyEnvelope: 'ck',
        status: 'ready',
        objectStatus: 'ready',
        contentSuite: 3,
        chunkSize: 1,
        chunkCount: 1,
        contentNonce: 'n',
        plaintextSize: null,
        ciphertextSize: '1',
        readyAt: null,
        signer: null,
        signature: null,
    };
}

function node(id: string, parentId: string | null, kind: 'file' | 'folder' = 'folder'): NodeView {
    return {
        id,
        workspaceId: WS,
        parentId,
        kind,
        keyEpoch: 2,
        parentKeyEpoch: 1,
        keyEnvelope: 'ke',
        prevKeyEnvelope: null,
        prevKeyEpoch: null,
        prevParentKeyEpoch: null,
        metadataVersion: 1,
        metadataEnvelope: `me-${id}`,
        currentVersion: kind === 'file' ? version(id) : null,
        trashedAt: null,
        changeSeq: 1,
        createdAt: '2026-10-28T00:00:00.000Z',
        updatedAt: '2026-10-28T00:00:00.000Z',
        envelopeSuite: 1,
        metadataSigner: null,
        metadataSignature: null,
    };
}

const tree: Record<string, NodeView[]> = {
    [ROOT]: [node(FOLDER, ROOT), node(DEST, ROOT)],
    [FOLDER]: [node(INNER, FOLDER), node(FILE, FOLDER, 'file')],
    [INNER]: [],
    [DEST]: [],
};

function harness() {
    const sealed: { operation: string; id: string; metadata: unknown }[] = [];
    const parentOf = new Map<string, string | null>([[ROOT, null]]);
    for (const [parent, children] of Object.entries(tree))
        for (const child of children) parentOf.set(child.id, parent);
    let made = 0;
    const api = {
        workspace: async () => ({
            workspaceId: WS,
            grant: { workspaceKeyVersion: 1 },
            root: node(ROOT, null),
            changeSeq: 0,
        }),
        children: async (_ws: string, folderId: string) => ({
            folder: node(folderId, parentOf.get(folderId) ?? null),
            ancestors: folderId === ROOT ? [] : [node(ROOT, null)],
            children: tree[folderId] ?? [],
            nextCursor: null,
        }),
        allocateEpochs: async (_ws: string, count: number) => ({ from: 10, to: 10 + count - 1 }),
        createFolders: async (_ws: string, specs: { id: string; parentId: string }[]) => ({
            nodes: specs.map((spec) => node(spec.id, spec.parentId)),
        }),
        copy: async (_ws: string, _source: string, input: { node: { id: string } }) => ({
            node: node(input.node.id, DEST, 'file'),
        }),
        rename: async (_ws: string, nodeId: string) => ({ node: node(nodeId, ROOT) }),
    } as unknown as DriveApi;
    const rpc = (async (operation: string, input: Record<string, unknown>) => {
        switch (operation) {
            case 'driveOpenWorkspace':
                return { workspaceId: WS, workspaceKeyVersion: 1 };
            case 'driveOpenNodes':
                return {
                    nodes: (input.nodes as { id: string }[]).map((n) => ({
                        id: n.id,
                        metadata: {
                            name: n.id,
                            mime: null,
                            size: 3,
                            modified: '2026-10-01T00:00:00.000Z',
                            ...(ATTRIBUTES[n.id] ? { attributes: ATTRIBUTES[n.id] } : {}),
                        },
                    })),
                };
            case 'driveVerify':
                return {
                    nodes: (input.nodes as { id: string; versions: { id: string }[] }[]).map(
                        (n) => ({
                            id: n.id,
                            metadata: 'verified',
                            versions: n.versions.map((v) => ({ id: v.id, integrity: 'verified' })),
                        }),
                    ),
                };
            case 'driveSealMetadata':
                sealed.push({
                    operation,
                    id: input.nodeId as string,
                    metadata: input.metadata,
                });
                return { metadataEnvelope: 'renamed', metadataSignature: 'sig' };
            case 'driveCreateNodes': {
                const nodes = input.nodes as { id: string; metadata: unknown }[];
                for (const n of nodes) sealed.push({ operation, id: n.id, metadata: n.metadata });
                return {
                    nodes: nodes.map(() => ({
                        keyEnvelope: `k${made++}`,
                        metadataEnvelope: 'm',
                        metadataSignature: 's',
                    })),
                };
            }
            case 'driveCopyFile': {
                const n = input.node as { id: string; metadata: unknown };
                sealed.push({ operation, id: n.id, metadata: n.metadata });
                return {
                    keyEnvelope: 'k',
                    metadataEnvelope: 'm',
                    metadataSignature: 's',
                    contentKeyEnvelope: 'c',
                    versionSignature: 'v',
                };
            }
            default:
                throw new Error(`unexpected ${operation}`);
        }
    }) as unknown as Rpc;
    return { api, rpc, sealed };
}

async function opened() {
    const h = harness();
    const client = createDriveClient(h.rpc, h.api, { signers: async () => ({}) });
    await client.open('owner');
    const top = await client.listFolder(ROOT);
    const byId = (id: string) => top.children.find((child) => child.id === id)!;
    return { ...h, client, folder: byId(FOLDER), dest: byId(DEST) };
}

describe('attributes when a record is sealed again', () => {
    test('a rename keeps every attribute, and only the name changes', async () => {
        const { client, folder, sealed } = await opened();
        await client.rename(folder, 'Plans');
        expect(sealed).toEqual([
            {
                operation: 'driveSealMetadata',
                id: FOLDER,
                metadata: {
                    name: 'Plans',
                    mime: null,
                    size: 3,
                    modified: '2026-10-01T00:00:00.000Z',
                    attributes: ATTRIBUTES[FOLDER],
                },
            },
        ]);
    });

    test('a copy of a file keeps its attributes under the new name', async () => {
        const { client, dest, sealed } = await opened();
        const file = (await client.listFolder(FOLDER)).children.find((c) => c.id === FILE)!;
        await client.copyFile(file, dest, 'copy.txt');
        expect(sealed).toHaveLength(1);
        expect(sealed[0]).toMatchObject({
            operation: 'driveCopyFile',
            metadata: { name: 'copy.txt', attributes: ATTRIBUTES[FILE] },
        });
    });

    test('a copy of a folder gives every folder and file made its own source’s attributes', async () => {
        const { client, folder, dest, sealed } = await opened();
        await client.copyTree(folder, dest, 'Plans copy');
        const attributesOf = (name: string) =>
            (
                sealed.find((s) => (s.metadata as { name: string }).name === name)?.metadata as {
                    attributes?: unknown;
                }
            )?.attributes;
        expect(sealed.map((s) => (s.metadata as { name: string }).name).sort()).toEqual(
            ['Plans copy', FILE, INNER].sort(),
        );
        expect(attributesOf('Plans copy')).toEqual(ATTRIBUTES[FOLDER]);
        expect(attributesOf(INNER)).toEqual(ATTRIBUTES[INNER]);
        expect(attributesOf(FILE)).toEqual(ATTRIBUTES[FILE]);
    });

    test('a path of new folders puts attributes on the folder it names, and only there', async () => {
        const { client, dest, sealed } = await opened();
        await client.createFolderPath(dest, ['one', 'two'], { attributes: { colour: 'green' } });
        expect(sealed.map((s) => s.metadata)).toEqual([
            { name: 'one', mime: null, size: null, modified: null },
            {
                name: 'two',
                mime: null,
                size: null,
                modified: null,
                attributes: { colour: 'green' },
            },
        ]);
    });
});
