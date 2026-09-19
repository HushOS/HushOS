import type { DriveNode } from '@hushos/drive/client';
import { makeZip, predictLength } from 'client-zip';
import { openSink } from '@/lib/download-sinks';
import { driveClient } from '@/lib/drive';
import { driveApi } from '@/lib/drive-api';

/*
 * A sealed copy: an item exactly as the service holds it, for keeping offline.
 * A zip with a manifest of every record under the item, envelopes and all,
 * and the stored bytes of every file, still encrypted, named by object. It
 * carries no key and no name in the clear: opened with the key file from the
 * same dialog it reads without HushOS; without one it is as opaque to a finder
 * as it is to us. Objects are fetched through the same short-lived URLs a
 * download uses, minted a hundred at a time as the zip reaches them.
 */

export const SEALED_FORMAT = 'hushos-sealed';
const URL_BATCH = 100;

type SealedVersion = {
    id: string;
    objectId: string;
    object: string;
    contentKeyEnvelope: string;
    contentSuite: number;
    chunkSize: number;
    chunkCount: number;
    contentNonce: string;
    plaintextSize: string | null;
    ciphertextSize: string;
};

export type SealedRecord = {
    id: string;
    parentId: string | null;
    kind: 'folder' | 'file';
    keyEpoch: number;
    parentKeyEpoch: number;
    keyEnvelope: string;
    prevKeyEnvelope: string | null;
    prevKeyEpoch: number | null;
    prevParentKeyEpoch: number | null;
    metadataVersion: number;
    metadataEnvelope: string;
    version: SealedVersion | null;
    createdAt: string;
    updatedAt: string;
};

export type SealedManifest = {
    format: typeof SEALED_FORMAT;
    version: 1;
    encoding: 'base64url';
    exportedAt: string;
    workspaceId: string;
    root: string;
    nodes: SealedRecord[];
    notes: string[];
};

const objectPath = (objectId: string) => `objects/${objectId}`;

function record(node: DriveNode): SealedRecord {
    const version = node.kind === 'file' ? node.currentVersion : null;
    return {
        id: node.id,
        parentId: node.parentId,
        kind: node.kind,
        keyEpoch: node.keyEpoch,
        parentKeyEpoch: node.parentKeyEpoch,
        keyEnvelope: node.keyEnvelope,
        prevKeyEnvelope: node.prevKeyEnvelope,
        prevKeyEpoch: node.prevKeyEpoch,
        prevParentKeyEpoch: node.prevParentKeyEpoch,
        metadataVersion: node.metadataVersion,
        metadataEnvelope: node.metadataEnvelope,
        version:
            version && version.status === 'ready' && version.objectStatus === 'ready'
                ? {
                      id: version.id,
                      objectId: version.objectId,
                      object: objectPath(version.objectId),
                      contentKeyEnvelope: version.contentKeyEnvelope,
                      contentSuite: version.contentSuite,
                      chunkSize: version.chunkSize,
                      chunkCount: version.chunkCount,
                      contentNonce: version.contentNonce,
                      plaintextSize: version.plaintextSize,
                      ciphertextSize: version.ciphertextSize,
                  }
                : null,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
    };
}

/* Every record under the item, the item first, parents before children. */
export async function collectSealed(root: DriveNode) {
    const nodes: SealedRecord[] = [];
    async function walk(node: DriveNode) {
        nodes.push(record(node));
        if (node.kind !== 'folder') return;
        const listing = await driveClient.listFolder(node.id);
        for (const child of listing.children) await walk(child);
    }
    await walk(root);
    return nodes;
}

export function sealedManifest(root: DriveNode, nodes: SealedRecord[]): SealedManifest {
    return {
        format: SEALED_FORMAT,
        version: 1,
        encoding: 'base64url',
        exportedAt: new Date().toISOString(),
        workspaceId: root.workspaceId,
        root: root.id,
        nodes,
        notes: [
            'Every record is as the service stores it: nothing here is decrypted, and no key is included.',
            "A record's key envelope opens under its parent's key of the named epoch; the top record's under the workspace key. Its metadata envelope opens under its own key.",
            "A file's content key envelope opens under the file's key; the object at the named path is the ciphertext, in chunks of chunkSize bytes, each with its own tag.",
            'The key file that Info also offers holds the keys this copy needs; keep the two apart unless you mean the copy to be readable.',
        ],
    };
}

const safe = (name: string) => name.replaceAll(/[\\/:*?"<>|]/g, '_');

/* Streams the zip to disk through the sinks a download uses; returns the file name. */
export async function saveSealedCopy(
    root: DriveNode,
    onProgress?: (done: number, total: number) => void,
) {
    const nodes = await collectSealed(root);
    const files = nodes.flatMap((node) => (node.version ? [node.version] : []));
    const manifest = new TextEncoder().encode(JSON.stringify(sealedManifest(root, nodes), null, 2));
    const sizes = [
        { name: 'manifest.json', size: manifest.byteLength },
        ...files.map((file) => ({ name: file.object, size: Number(file.ciphertextSize) })),
    ];
    const name = `${safe(root.name)}.hushos.zip`;
    const sink = await openSink({ name, size: Number(predictLength(sizes)) });
    let done = 0;
    async function* entries() {
        yield { name: 'manifest.json', input: manifest as BlobPart, size: manifest.byteLength };
        for (let at = 0; at < files.length; at += URL_BATCH) {
            const batch = files.slice(at, at + URL_BATCH);
            const { urls } = await driveApi.downloadUrls(
                root.workspaceId,
                batch.map((file) => file.id),
            );
            for (const file of batch) {
                const url = urls.find((issued) => issued.versionId === file.id)?.url;
                if (!url) throw new Error('The store gave no address for one of the files.');
                const response = await fetch(url);
                if (!response.ok || !response.body)
                    throw new Error(`The store refused one of the files (${response.status}).`);
                yield {
                    name: file.object,
                    input: response.body,
                    size: Number(file.ciphertextSize),
                };
                onProgress?.(++done, files.length);
            }
        }
    }
    try {
        const reader = makeZip(entries(), { metadata: sizes }).getReader();
        for (;;) {
            const { done: finished, value } = await reader.read();
            if (finished) break;
            await sink.write(value);
        }
        await sink.close();
    } catch (error) {
        await sink.abort(error);
        throw error;
    }
    return name;
}
