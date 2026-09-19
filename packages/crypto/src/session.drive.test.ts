import { describe, expect, test, vi } from 'vitest';
import { createDeviceKey, rememberAccountKey } from './device';
import { createCryptoSession } from './session';
import { createWorkspaceGrant } from './workspace';
import {
    CHUNK_SIZE,
    ciphertextSize,
    decryptThumbnail,
    openMetadata,
    openNodeKey,
    openVersion,
    thumbnailRange,
} from './drive';
import { decode, encode } from './keys';

/*
 * The worker side of Drive: keys are opened parent-first and stay in the session,
 * a batch may chain on its own earlier nodes, wrong epochs are refused, and a
 * lock forgets everything. The session is unlocked the way a remembered device
 * does it, so no OPAQUE round trip is needed.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const ids = ['a', 'b', 'c', 'd'].map(
    (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`,
);
const [A, B, C, D] = ids as [string, string, string, string];

async function unlockedSession() {
    const root = crypto.getRandomValues(new Uint8Array(32));
    const deviceKey = await createDeviceKey();
    const bundle = await rememberAccountKey(root, deviceKey, {
        userId: USER,
        keyVersion: 1,
        credentialVersion: 1,
        deviceKeyId: 'device',
    });
    const grant = await createWorkspaceGrant(root, USER, WS, 1);
    const session = createCryptoSession();
    let id = 0;
    const call = <K extends Parameters<typeof session.handle>[0]['operation']>(
        operation: K,
        input: Extract<Parameters<typeof session.handle>[0], { operation: K }>['input'],
    ) =>
        session.handle({ id: ++id, operation, input } as Parameters<
            typeof session.handle
        >[0]) as Promise<Extract<Awaited<ReturnType<typeof session.handle>>, object>>;
    await call('restore', { deviceKey, bundle });
    return { session, call, grant, root };
}

const meta = (name: string) => ({ name, mime: null, size: null, modified: null });

describe('drive session operations', () => {
    test('creates a chain in one batch and reopens it parent-first', async () => {
        const { call, grant } = await unlockedSession();
        await call('driveOpenWorkspace', { userId: USER, grant });
        const created = (await call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                { id: A, parentId: WS, parentKeyEpoch: 1, keyEpoch: 1, metadata: meta('Drive') },
                { id: B, parentId: A, parentKeyEpoch: 1, keyEpoch: 2, metadata: meta('one') },
                { id: C, parentId: B, parentKeyEpoch: 2, keyEpoch: 3, metadata: meta('two') },
            ],
        })) as { nodes: { id: string; keyEnvelope: string; metadataEnvelope: string }[] };
        expect(created.nodes.map((n) => n.id)).toEqual([A, B, C]);

        // Reopening from the envelopes reports the names; B's key is still cached.
        const opened = (await call('driveOpenNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: A,
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    keyEnvelope: created.nodes[0]!.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: created.nodes[0]!.metadataEnvelope,
                },
                {
                    id: C,
                    parentId: B,
                    parentKeyEpoch: 2,
                    keyEpoch: 3,
                    keyEnvelope: created.nodes[2]!.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: created.nodes[2]!.metadataEnvelope,
                },
            ],
        })) as { nodes: { id: string; metadata?: { name: string }; error?: string }[] };
        expect(opened.nodes[0]!.metadata?.name).toBe('Drive');
        expect(opened.nodes[1]!.metadata?.name).toBe('two');
    });

    test('a child cannot be opened before its parent, nor under a stale parent epoch', async () => {
        const { call, grant, root } = await unlockedSession();
        await call('driveOpenWorkspace', { userId: USER, grant });
        const created = (await call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                { id: A, parentId: WS, parentKeyEpoch: 1, keyEpoch: 1, metadata: meta('Drive') },
                { id: B, parentId: A, parentKeyEpoch: 1, keyEpoch: 2, metadata: meta('one') },
            ],
        })) as { nodes: { id: string; keyEnvelope: string; metadataEnvelope: string }[] };
        // A second device of the same account: same root, its own session and no cache.
        const second = createCryptoSession();
        const deviceKey = await createDeviceKey();
        const bundle = await rememberAccountKey(root, deviceKey, {
            userId: USER,
            keyVersion: 1,
            credentialVersion: 1,
            deviceKeyId: 'device-2',
        });
        let id = 0;
        const call2 = (operation: string, input: unknown) =>
            second.handle({ id: ++id, operation, input } as Parameters<typeof second.handle>[0]);
        await call2('restore', { deviceKey, bundle });
        await call2('driveOpenWorkspace', { userId: USER, grant });
        const envelopes = (
            id: string,
            index: number,
            parentId: string,
            parentKeyEpoch: number,
            keyEpoch: number,
        ) => ({
            id,
            parentId,
            parentKeyEpoch,
            keyEpoch,
            keyEnvelope: created.nodes[index]!.keyEnvelope,
            metadataVersion: 1,
            metadataEnvelope: created.nodes[index]!.metadataEnvelope,
        });
        const childFirst = (await call2('driveOpenNodes', {
            workspaceId: WS,
            nodes: [envelopes(B, 1, A, 1, 2)],
        })) as { nodes: { error?: string }[] };
        expect(childFirst.nodes[0]!.error).toMatch(/containing folder/);
        // The same envelope presented under a different parent epoch does not open.
        const stale = (await call2('driveOpenNodes', {
            workspaceId: WS,
            nodes: [envelopes(A, 0, WS, 1, 1), envelopes(B, 1, A, 2, 2)],
        })) as { nodes: { metadata?: { name: string }; error?: string }[] };
        expect(stale.nodes[0]!.metadata?.name).toBe('Drive');
        expect(stale.nodes[1]!.error).toMatch(/older folder key/);
        const ok = (await call2('driveOpenNodes', {
            workspaceId: WS,
            nodes: [envelopes(B, 1, A, 1, 2)],
        })) as { nodes: { metadata?: { name: string }; error?: string }[] };
        expect(ok.nodes.map((n) => n.metadata?.name)).toEqual(['one']);
    });

    test('rename seals under the node key; a move rewraps it under the new parent', async () => {
        const { call, grant } = await unlockedSession();
        await call('driveOpenWorkspace', { userId: USER, grant });
        const created = (await call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                { id: A, parentId: WS, parentKeyEpoch: 1, keyEpoch: 1, metadata: meta('Drive') },
                { id: B, parentId: A, parentKeyEpoch: 1, keyEpoch: 2, metadata: meta('one') },
                { id: C, parentId: A, parentKeyEpoch: 1, keyEpoch: 3, metadata: meta('two') },
                { id: D, parentId: B, parentKeyEpoch: 2, keyEpoch: 4, metadata: meta('leaf') },
            ],
        })) as { nodes: { id: string; keyEnvelope: string; metadataEnvelope: string }[] };
        const renamed = (await call('driveSealMetadata', {
            workspaceId: WS,
            nodeId: D,
            metadataVersion: 2,
            metadata: meta('renamed'),
        })) as { metadataEnvelope: string };
        // Reading it back through the opened node reports the new name at version 2.
        const reopened = (await call('driveOpenNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: D,
                    parentId: B,
                    parentKeyEpoch: 2,
                    keyEpoch: 4,
                    keyEnvelope: created.nodes[3]!.keyEnvelope,
                    metadataVersion: 2,
                    metadataEnvelope: renamed.metadataEnvelope,
                },
            ],
        })) as { nodes: { metadata?: { name: string } }[] };
        expect(reopened.nodes[0]!.metadata?.name).toBe('renamed');

        // Move D from B to C: the rewrapped envelope opens under C's key at its epoch.
        const moved = (await call('driveRewrapNode', {
            workspaceId: WS,
            nodeId: D,
            parentId: C,
            parentKeyEpoch: 3,
            keyEpoch: 4,
        })) as { keyEnvelope: string };
        expect(moved.keyEnvelope).not.toBe(created.nodes[3]!.keyEnvelope);
        const afterMove = (await call('driveOpenNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: D,
                    parentId: C,
                    parentKeyEpoch: 3,
                    keyEpoch: 4,
                    keyEnvelope: moved.keyEnvelope,
                    metadataVersion: 2,
                    metadataEnvelope: renamed.metadataEnvelope,
                },
            ],
        })) as { nodes: { metadata?: { name: string }; error?: string }[] };
        expect(afterMove.nodes[0]!.metadata?.name).toBe('renamed');
        // A rewrap for an epoch the node does not have is refused.
        await expect(
            call('driveRewrapNode', {
                workspaceId: WS,
                nodeId: D,
                parentId: C,
                parentKeyEpoch: 3,
                keyEpoch: 5,
            }),
        ).rejects.toThrow(/changed/);
    });

    test('a copy rewraps the same content key under a fresh node key in the destination', async () => {
        const { call, grant, root } = await unlockedSession();
        await call('driveOpenWorkspace', { userId: USER, grant });
        const created = (await call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                { id: A, parentId: WS, parentKeyEpoch: 1, keyEpoch: 1, metadata: meta('Drive') },
                { id: B, parentId: A, parentKeyEpoch: 1, keyEpoch: 2, metadata: meta('dest') },
                { id: C, parentId: A, parentKeyEpoch: 1, keyEpoch: 3, metadata: meta('file') },
            ],
        })) as { nodes: { keyEnvelope: string; metadataEnvelope: string }[] };
        const objectId = D;
        const sourceVersion = 'dddddddd-dddd-4ddd-8ddd-000000000001';
        const copyVersion = 'dddddddd-dddd-4ddd-8ddd-000000000002';
        const copyId = 'dddddddd-dddd-4ddd-8ddd-000000000003';
        const prepared = (await call('driveUploadPrepare', {
            workspaceId: WS,
            nodeId: C,
            versionId: sourceVersion,
            objectId,
            plaintextSize: 100,
        })) as { contentKeyEnvelope: string };

        const copied = (await call('driveCopyFile', {
            workspaceId: WS,
            source: {
                nodeId: C,
                id: sourceVersion,
                objectId,
                contentKeyEnvelope: prepared.contentKeyEnvelope,
                contentSuite: 2,
                plaintextSize: null,
            },
            node: {
                id: copyId,
                parentId: B,
                parentKeyEpoch: 2,
                keyEpoch: 4,
                metadata: meta('file (copy)'),
            },
            versionId: copyVersion,
        })) as { keyEnvelope: string; metadataEnvelope: string; contentKeyEnvelope: string };

        // Checked with the raw primitives, so the session cannot agree with itself by accident.
        const { openWorkspaceKey } = await import('./workspace');
        const workspaceKey = await openWorkspaceKey(root, USER, grant);
        const aKey = await openNodeKey(decode(created.nodes[0]!.keyEnvelope, 72), workspaceKey, {
            workspaceId: WS,
            nodeId: A,
            parentId: WS,
            parentKeyEpoch: 1,
            keyEpoch: 1,
        });
        const bKey = await openNodeKey(decode(created.nodes[1]!.keyEnvelope, 72), aKey, {
            workspaceId: WS,
            nodeId: B,
            parentId: A,
            parentKeyEpoch: 1,
            keyEpoch: 2,
        });
        const cKey = await openNodeKey(decode(created.nodes[2]!.keyEnvelope, 72), aKey, {
            workspaceId: WS,
            nodeId: C,
            parentId: A,
            parentKeyEpoch: 1,
            keyEpoch: 3,
        });
        const copyKey = await openNodeKey(decode(copied.keyEnvelope, 72), bKey, {
            workspaceId: WS,
            nodeId: copyId,
            parentId: B,
            parentKeyEpoch: 2,
            keyEpoch: 4,
        });
        expect(
            (
                await openMetadata(decode(copied.metadataEnvelope), copyKey, {
                    workspaceId: WS,
                    nodeId: copyId,
                    metadataVersion: 1,
                })
            ).name,
        ).toBe('file (copy)');
        const original = await openVersion(decode(prepared.contentKeyEnvelope, 84), cKey, {
            workspaceId: WS,
            nodeId: C,
            versionId: sourceVersion,
            objectId,
            suite: 2,
        });
        const rewrapped = await openVersion(decode(copied.contentKeyEnvelope, 84), copyKey, {
            workspaceId: WS,
            nodeId: copyId,
            versionId: copyVersion,
            objectId,
            suite: 2,
        });
        expect(Buffer.from(rewrapped.contentKey).equals(Buffer.from(original.contentKey))).toBe(
            true,
        );
        // The sizes travel with the key: the copy opens the shared object exactly as the source does.
        expect(rewrapped.plaintextSize).toBe(100);
        expect(rewrapped.thumbnailBytes).toBe(0);
        // The new envelope is bound to the copy, not the source: the source's context refuses it.
        await expect(
            openVersion(decode(copied.contentKeyEnvelope, 84), copyKey, {
                workspaceId: WS,
                nodeId: C,
                versionId: sourceVersion,
                objectId,
                suite: 2,
            }),
        ).rejects.toThrow();
        // The copy's key is cached: a rename of the copy needs no reopen.
        await expect(
            call('driveSealMetadata', {
                workspaceId: WS,
                nodeId: copyId,
                metadataVersion: 2,
                metadata: meta('renamed'),
            }),
        ).resolves.toBeDefined();
        // A source whose folder is not open cannot be copied.
        await expect(
            call('driveCopyFile', {
                workspaceId: WS,
                source: {
                    nodeId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                    id: sourceVersion,
                    objectId,
                    contentKeyEnvelope: prepared.contentKeyEnvelope,
                    contentSuite: 2,
                    plaintextSize: null,
                },
                node: {
                    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                    parentId: B,
                    parentKeyEpoch: 2,
                    keyEpoch: 5,
                    metadata: meta('x'),
                },
                versionId: copyVersion,
            }),
        ).rejects.toThrow(/containing folder/);
    });

    test('a lock forgets every drive key', async () => {
        const { session, call, grant } = await unlockedSession();
        await call('driveOpenWorkspace', { userId: USER, grant });
        await call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                { id: A, parentId: WS, parentKeyEpoch: 1, keyEpoch: 1, metadata: meta('Drive') },
            ],
        });
        session.reset();
        await expect(
            call('driveSealMetadata', {
                workspaceId: WS,
                nodeId: A,
                metadataVersion: 2,
                metadata: meta('x'),
            }),
        ).rejects.toThrow();
    });

    test('envelopes from the session open with the raw primitives', async () => {
        // Guards against the session and the primitives drifting apart in their contexts.
        const { call, grant, root } = await unlockedSession();
        await call('driveOpenWorkspace', { userId: USER, grant });
        const created = (await call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                { id: A, parentId: WS, parentKeyEpoch: 1, keyEpoch: 7, metadata: meta('Drive') },
            ],
        })) as { nodes: { keyEnvelope: string; metadataEnvelope: string }[] };
        const { openWorkspaceKey } = await import('./workspace');
        const workspaceKey = await openWorkspaceKey(root, USER, grant);
        const nodeKey = await openNodeKey(decode(created.nodes[0]!.keyEnvelope, 72), workspaceKey, {
            workspaceId: WS,
            nodeId: A,
            parentId: WS,
            parentKeyEpoch: 1,
            keyEpoch: 7,
        });
        const metadata = await openMetadata(decode(created.nodes[0]!.metadataEnvelope), nodeKey, {
            workspaceId: WS,
            nodeId: A,
            metadataVersion: 1,
        });
        expect(metadata.name).toBe('Drive');
    });
});

describe('the thumbnail trailer', () => {
    test('is sealed at prepare, rides with the last chunk, and resumes only with the same bytes', async () => {
        const { call, grant, root } = await unlockedSession();
        await call('driveOpenWorkspace', { userId: USER, grant });
        const created = (await call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                { id: A, parentId: WS, parentKeyEpoch: 1, keyEpoch: 1, metadata: meta('Drive') },
                { id: B, parentId: A, parentKeyEpoch: 1, keyEpoch: 2, metadata: meta('photo.jpg') },
            ],
        })) as { nodes: { id: string; keyEnvelope: string; metadataEnvelope: string }[] };
        const webp = crypto.getRandomValues(new Uint8Array(1234));
        const size = CHUNK_SIZE + 3; // two chunks; the trailer rides behind the 3-byte one
        const version = { id: C, objectId: D, contentSuite: 2, plaintextSize: null };
        const prepared = (await call('driveUploadPrepare', {
            workspaceId: WS,
            nodeId: B,
            versionId: C,
            objectId: D,
            plaintextSize: size,
            thumbnail: webp,
        })) as {
            contentNonce: string;
            contentKeyEnvelope: string;
            chunkCount: number;
            ciphertextSize: number;
            thumbnail: Uint8Array | null;
        };
        expect(prepared.chunkCount).toBe(2);
        expect(prepared.thumbnail).toHaveLength(1234 + 16);
        expect(prepared.ciphertextSize).toBe(ciphertextSize(size, 1234));
        expect(decode(prepared.contentKeyEnvelope)).toHaveLength(84);

        // The raw primitives agree on what was sealed: the sizes, and a trailer the content key opens.
        const { openWorkspaceKey } = await import('./workspace');
        const workspaceKey = await openWorkspaceKey(root, USER, grant);
        const aKey = await openNodeKey(decode(created.nodes[0]!.keyEnvelope, 72), workspaceKey, {
            workspaceId: WS,
            nodeId: A,
            parentId: WS,
            parentKeyEpoch: 1,
            keyEpoch: 1,
        });
        const bKey = await openNodeKey(decode(created.nodes[1]!.keyEnvelope, 72), aKey, {
            workspaceId: WS,
            nodeId: B,
            parentId: A,
            parentKeyEpoch: 1,
            keyEpoch: 2,
        });
        const opened = await openVersion(decode(prepared.contentKeyEnvelope, 84), bKey, {
            workspaceId: WS,
            nodeId: B,
            versionId: C,
            objectId: D,
            suite: 2,
        });
        expect(opened.plaintextSize).toBe(size);
        expect(opened.thumbnailBytes).toBe(1234);
        expect(
            await decryptThumbnail(
                prepared.thumbnail!,
                opened.contentKey,
                decode(prepared.contentNonce, 16),
                { workspaceId: WS, objectId: D, plaintextSize: size, thumbnailBytes: 1234 },
            ),
        ).toEqual(webp);

        // The first part is a bare chunk; the last is the last chunk and the trailer.
        const file = new Blob([new Uint8Array(size)]);
        const first = (await call('driveUploadEncrypt', { objectId: D, file, index: 0 })) as {
            bytes: number;
        };
        expect(first.bytes).toBe(CHUNK_SIZE + 16);
        const last = (await call('driveUploadEncrypt', { objectId: D, file, index: 1 })) as {
            bytes: number;
        };
        expect(last.bytes).toBe(3 + 16 + 1234 + 16);

        // A listing opens the sizes beside the name; a download opens them too.
        const envelope = { ...version, contentKeyEnvelope: prepared.contentKeyEnvelope };
        const listed = (await call('driveOpenNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: B,
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    keyEnvelope: created.nodes[1]!.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: created.nodes[1]!.metadataEnvelope,
                    version: envelope,
                },
            ],
        })) as { nodes: { content?: { plaintextSize: number; thumbnailBytes: number } }[] };
        expect(listed.nodes[0]!.content).toEqual({ plaintextSize: size, thumbnailBytes: 1234 });
        const download = await call('driveDownloadOpen', {
            workspaceId: WS,
            nodeId: B,
            version: envelope,
            contentNonce: prepared.contentNonce,
        });
        expect(download).toEqual({ chunkCount: 2, plaintextSize: size, thumbnailBytes: 1234 });
        const versions = (await call('driveOpenVersions', {
            workspaceId: WS,
            nodeId: B,
            versions: [
                envelope,
                // One byte of the tag changed, whatever the last character happens to be.
                {
                    ...envelope,
                    contentKeyEnvelope: prepared.contentKeyEnvelope.replace(/.$/, (c) =>
                        c === 'A' ? 'B' : 'A',
                    ),
                },
            ],
        })) as { versions: { id: string; plaintextSize?: number; error?: string }[] };
        expect(versions.versions[0]).toEqual({ id: C, plaintextSize: size, thumbnailBytes: 1234 });
        expect(versions.versions[1]!.error).toBeDefined();

        // A thumbnail fetch asks the object's URL for exactly the trailer's range.
        const range = thumbnailRange(size, 1234);
        const fetched = vi.fn(async (_url: string, init?: RequestInit) => {
            expect((init?.headers as Record<string, string> | undefined)?.Range).toBe(
                `bytes=${range.start}-${range.end}`,
            );
            return new Response(new Blob([prepared.thumbnail as BlobPart]), { status: 206 });
        });
        vi.stubGlobal('fetch', fetched);
        try {
            const { plaintext } = (await call('driveThumbnailFetch', {
                workspaceId: WS,
                nodeId: B,
                version: envelope,
                contentNonce: prepared.contentNonce,
                url: 'https://store/object',
            })) as { plaintext: Uint8Array };
            expect(plaintext).toEqual(webp);
            expect(fetched).toHaveBeenCalledTimes(1);
        } finally {
            vi.unstubAllGlobals();
        }

        // Reopen resumes only from a journal that holds the very trailer that was sealed,
        // agrees on the size, and was written under suite 2.
        await call('driveUploadForget', { objectId: D });
        const reopen = {
            workspaceId: WS,
            nodeId: B,
            versionId: C,
            objectId: D,
            contentSuite: 2,
            contentKeyEnvelope: prepared.contentKeyEnvelope,
            contentNonce: prepared.contentNonce,
            plaintextSize: size,
            thumbnail: prepared.thumbnail,
        };
        await expect(call('driveUploadReopen', { ...reopen, thumbnail: null })).rejects.toThrow(
            /cannot be resumed/,
        );
        await expect(
            call('driveUploadReopen', { ...reopen, thumbnail: prepared.thumbnail!.slice(1) }),
        ).rejects.toThrow(/cannot be resumed/);
        await expect(
            call('driveUploadReopen', { ...reopen, plaintextSize: size + 1 }),
        ).rejects.toThrow();
        await expect(call('driveUploadReopen', { ...reopen, contentSuite: 1 })).rejects.toThrow(
            /older version/,
        );
        expect(await call('driveUploadReopen', reopen)).toEqual({
            chunkCount: 2,
            ciphertextSize: prepared.ciphertextSize,
        });
        const again = (await call('driveUploadEncrypt', { objectId: D, file, index: 1 })) as {
            bytes: number;
        };
        expect(again.bytes).toBe(last.bytes);

        // Without a thumbnail there is no trailer, and the envelope says so.
        const bare = (await call('driveUploadPrepare', {
            workspaceId: WS,
            nodeId: B,
            versionId: C,
            objectId: D,
            plaintextSize: 5,
            thumbnail: null,
        })) as { ciphertextSize: number; thumbnail: Uint8Array | null; contentKeyEnvelope: string };
        expect(bare.thumbnail).toBeNull();
        expect(bare.ciphertextSize).toBe(5 + 16);
        await expect(
            call('driveThumbnailFetch', {
                workspaceId: WS,
                nodeId: B,
                version: { ...version, contentKeyEnvelope: bare.contentKeyEnvelope },
                contentNonce: prepared.contentNonce,
                url: 'https://store/object',
            }),
        ).rejects.toThrow(/no thumbnail/);
    });
});

describe('exporting keys', () => {
    test('the exported keys open the real envelopes; an unopened node has nothing to export', async () => {
        const { session, call, grant } = await unlockedSession();
        await call('driveOpenWorkspace', { userId: USER, grant });
        const created = (await call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                { id: A, parentId: WS, parentKeyEpoch: 1, keyEpoch: 1, metadata: meta('Drive') },
                { id: B, parentId: A, parentKeyEpoch: 1, keyEpoch: 2, metadata: meta('file.bin') },
            ],
        })) as { nodes: { id: string; keyEnvelope: string; metadataEnvelope: string }[] };
        const prepared = (await call('driveUploadPrepare', {
            workspaceId: WS,
            nodeId: B,
            versionId: C,
            objectId: D,
            plaintextSize: 10,
        })) as { contentNonce: string; contentKeyEnvelope: string };
        const folder = (await call('driveExportKeys', {
            workspaceId: WS,
            nodeId: A,
            version: null,
        })) as {
            nodeKey: string;
            keyEpoch: number;
            content: null;
        };
        expect(folder.keyEpoch).toBe(1);
        expect(folder.content).toBeNull();
        expect(decode(folder.nodeKey)).toHaveLength(32);
        const file = (await call('driveExportKeys', {
            workspaceId: WS,
            nodeId: B,
            version: {
                id: C,
                objectId: D,
                contentKeyEnvelope: prepared.contentKeyEnvelope,
                contentNonce: prepared.contentNonce,
                contentSuite: 2,
                plaintextSize: null,
            },
        })) as {
            nodeKey: string;
            keyEpoch: number;
            content: { key: string; nonce: string; plaintextSize: number; thumbnailBytes: number };
        };
        // The file's key opens under the exported folder key, and the exported content
        // key is what the file's envelope holds: these are the keys, not look-alikes.
        const fileKey = await openNodeKey(
            decode(created.nodes[1]!.keyEnvelope, 72),
            decode(folder.nodeKey),
            {
                workspaceId: WS,
                nodeId: B,
                parentId: A,
                parentKeyEpoch: 1,
                keyEpoch: 2,
            },
        );
        expect(encode(fileKey)).toBe(file.nodeKey);
        const { contentKey } = await openVersion(decode(prepared.contentKeyEnvelope, 84), fileKey, {
            workspaceId: WS,
            nodeId: B,
            versionId: C,
            objectId: D,
            suite: 2,
        });
        expect(encode(contentKey)).toBe(file.content.key);
        expect(file.content.nonce).toBe(prepared.contentNonce);
        expect(file.content.plaintextSize).toBe(10);
        expect(file.content.thumbnailBytes).toBe(0);
        // A node this device never opened has no key to give.
        await expect(
            call('driveExportKeys', { workspaceId: WS, nodeId: D, version: null }),
        ).rejects.toThrow('Open the containing folder first.');
        // After a lock, nothing is exportable.
        session.reset();
        await expect(
            call('driveExportKeys', { workspaceId: WS, nodeId: A, version: null }),
        ).rejects.toThrow();
    });
});

describe('workspace documents in the session', () => {
    test('a document seals only once Drive is open, and opens only at the version it was sealed as', async () => {
        const { session, call, grant } = await unlockedSession();
        const document = { version: 1, tags: [{ id: A, name: 'Home', colour: 'blue' }] };
        await expect(
            call('driveSealDocument', { workspaceId: WS, kind: 'tags', version: 1, document }),
        ).rejects.toThrow('Open Drive first');
        await call('driveOpenWorkspace', { userId: USER, grant });
        const { envelope } = (await call('driveSealDocument', {
            workspaceId: WS,
            kind: 'tags',
            version: 1,
            document,
        })) as { envelope: string };
        await expect(
            call('driveOpenDocument', { workspaceId: WS, kind: 'tags', version: 1, envelope }),
        ).resolves.toEqual({ document });
        await expect(
            call('driveOpenDocument', { workspaceId: WS, kind: 'tags', version: 2, envelope }),
        ).rejects.toThrow('could not be opened');
        session.reset();
        await expect(
            call('driveOpenDocument', { workspaceId: WS, kind: 'tags', version: 1, envelope }),
        ).rejects.toThrow();
    });
});
