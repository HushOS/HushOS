import { describe, expect, test, vi } from 'vitest';
import { createDeviceKey, rememberAccountKey } from './device';
import { createCryptoSession } from './session';
import { createWorkspaceGrant } from './workspace';
import { createIdentity } from './identity';
import {
    CHUNK_SIZE,
    CHUNK_TAG_BYTES,
    ciphertextSize,
    CONTENT_SUITE,
    decryptChunk,
    decryptThumbnail,
    paddedLength,
    openMetadata,
    openNodeKey,
    openVersion,
    thumbnailRange,
} from './drive';
import { decode, encode } from './keys';
import sodium from 'libsodium-wrappers';
import {
    metadataResealedStatement,
    metadataSavedStatement,
    metadataStatement,
    signStatement,
    verifyStatement,
    versionSavedStatement,
    versionStatement,
} from './signatures';
import { generateLinkSalt, generateLinkSecret, sealLinkKey } from './links';

/*
 * The worker side of Drive: keys are opened parent-first and stay in the session,
 * a batch may chain on its own earlier nodes, wrong epochs are refused, and a
 * lock forgets everything. The session is unlocked the way a remembered device
 * does it, so no OPAQUE round trip is needed.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const ids = ['a', 'b', 'c', 'd', 'f', 'e'].map(
    (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`,
);
const [A, B, C, D, E, F] = ids as [string, string, string, string, string, string];

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
    // Every write is signed, so the identity is open as it is in the app.
    const identity = await createIdentity(root, USER);
    await call('identityOpen', { userId: USER, identity });
    return { session, call, grant, root, identity };
}

const meta = (name: string) => ({ name, mime: null, size: null, modified: null });

describe('drive session operations', () => {
    test('creates a chain in one batch and reopens it parent-first', async () => {
        const { call, grant } = await unlockedSession();
        await call('driveOpenWorkspace', { userId: USER, grant });
        const created = (await call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: A,
                    kind: 'folder',
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    metadata: meta('Drive'),
                },
                {
                    id: B,
                    kind: 'folder',
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    metadata: meta('one'),
                },
                {
                    id: C,
                    kind: 'folder',
                    parentId: B,
                    parentKeyEpoch: 2,
                    keyEpoch: 3,
                    metadata: meta('two'),
                },
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
                {
                    id: A,
                    kind: 'folder',
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    metadata: meta('Drive'),
                },
                {
                    id: B,
                    kind: 'folder',
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    metadata: meta('one'),
                },
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
                {
                    id: A,
                    kind: 'folder',
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    metadata: meta('Drive'),
                },
                {
                    id: B,
                    kind: 'folder',
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    metadata: meta('one'),
                },
                {
                    id: C,
                    kind: 'folder',
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 3,
                    metadata: meta('two'),
                },
                {
                    id: D,
                    kind: 'folder',
                    parentId: B,
                    parentKeyEpoch: 2,
                    keyEpoch: 4,
                    metadata: meta('leaf'),
                },
            ],
        })) as { nodes: { id: string; keyEnvelope: string; metadataEnvelope: string }[] };
        const renamed = (await call('driveSealMetadata', {
            workspaceId: WS,
            nodeId: D,
            kind: 'folder',
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
        const { call, grant, root, identity } = await unlockedSession();
        await call('driveOpenWorkspace', { userId: USER, grant });
        const created = (await call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: A,
                    kind: 'folder',
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    metadata: meta('Drive'),
                },
                {
                    id: B,
                    kind: 'folder',
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    metadata: meta('dest'),
                },
                {
                    id: C,
                    kind: 'file',
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 3,
                    metadata: meta('file'),
                },
            ],
        })) as {
            nodes: { keyEnvelope: string; metadataEnvelope: string; metadataSignature: string }[];
        };
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
        })) as { contentKeyEnvelope: string; versionSignature: string };

        // The source as served: its own records, signed by this account, so they verify.
        const source = {
            nodeId: C,
            id: sourceVersion,
            objectId,
            contentKeyEnvelope: prepared.contentKeyEnvelope,
            contentSuite: CONTENT_SUITE,
            plaintextSize: null,
            metadataVersion: 1,
            metadataEnvelope: created.nodes[2]!.metadataEnvelope,
            metadataSigner: USER,
            metadataSignature: created.nodes[2]!.metadataSignature,
            signer: USER,
            signature: prepared.versionSignature,
        };
        const copied = (await call('driveCopyFile', {
            workspaceId: WS,
            signers: {},
            source,
            node: {
                id: copyId,
                parentId: B,
                parentKeyEpoch: 2,
                keyEpoch: 4,
                metadata: meta('file (copy)'),
            },
            versionId: copyVersion,
        })) as {
            keyEnvelope: string;
            metadataEnvelope: string;
            metadataSignature: string;
            contentKeyEnvelope: string;
            versionSignature: string;
        };

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
            suite: CONTENT_SUITE,
        });
        const rewrapped = await openVersion(decode(copied.contentKeyEnvelope, 84), copyKey, {
            workspaceId: WS,
            nodeId: copyId,
            versionId: copyVersion,
            objectId,
            suite: CONTENT_SUITE,
        });
        expect(Buffer.from(rewrapped.contentKey).equals(Buffer.from(original.contentKey))).toBe(
            true,
        );
        // The copy is signed as a new file and a new version of the shared object, by its copier.
        const signer = decode(identity.signingPublicKey, 32);
        expect(
            await verifyStatement(
                await metadataStatement(
                    { workspaceId: WS, nodeId: copyId, kind: 'file', metadataVersion: 1 },
                    decode(copied.metadataEnvelope),
                ),
                decode(copied.metadataSignature, 64),
                signer,
            ),
        ).toBe(true);
        expect(
            await verifyStatement(
                await versionStatement(
                    {
                        workspaceId: WS,
                        nodeId: copyId,
                        versionId: copyVersion,
                        objectId,
                        contentSuite: CONTENT_SUITE,
                    },
                    decode(copied.contentKeyEnvelope),
                ),
                decode(copied.versionSignature, 64),
                signer,
            ),
        ).toBe(true);
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
                suite: CONTENT_SUITE,
            }),
        ).rejects.toThrow();
        // The copy's key is cached: a rename of the copy needs no reopen.
        await expect(
            call('driveSealMetadata', {
                workspaceId: WS,
                nodeId: copyId,
                kind: 'folder',
                metadataVersion: 2,
                metadata: meta('renamed'),
            }),
        ).resolves.toBeDefined();
        // A source whose folder is not open cannot be copied.
        await expect(
            call('driveCopyFile', {
                workspaceId: WS,
                signers: {},
                source: { ...source, nodeId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
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
                {
                    id: A,
                    kind: 'folder',
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    metadata: meta('Drive'),
                },
            ],
        });
        session.reset();
        await expect(
            call('driveSealMetadata', {
                workspaceId: WS,
                nodeId: A,
                kind: 'folder',
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
                {
                    id: A,
                    kind: 'folder',
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 7,
                    metadata: meta('Drive'),
                },
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
                {
                    id: A,
                    kind: 'folder',
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    metadata: meta('Drive'),
                },
                {
                    id: B,
                    kind: 'file',
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    metadata: meta('photo.jpg'),
                },
            ],
        })) as { nodes: { id: string; keyEnvelope: string; metadataEnvelope: string }[] };
        const webp = crypto.getRandomValues(new Uint8Array(1234));
        const size = CHUNK_SIZE + 3; // two chunks; the trailer rides behind the 3-byte one
        const version = { id: C, objectId: D, contentSuite: CONTENT_SUITE, plaintextSize: null };
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
        expect(prepared.ciphertextSize).toBe(ciphertextSize(CONTENT_SUITE, size, 1234));
        // What the store learns is a Padmé bucket of the file and its trailer together.
        const seen = prepared.ciphertextSize - CHUNK_TAG_BYTES * prepared.chunkCount;
        expect(seen).toBe(paddedLength(size + 1234 + 16));
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
            suite: CONTENT_SUITE,
        });
        expect(opened.plaintextSize).toBe(size);
        expect(opened.thumbnailBytes).toBe(1234);
        expect(
            await decryptThumbnail(
                prepared.thumbnail!,
                opened.contentKey,
                decode(prepared.contentNonce, 16),
                {
                    workspaceId: WS,
                    objectId: D,
                    suite: CONTENT_SUITE,
                    plaintextSize: size,
                    thumbnailBytes: 1234,
                },
            ),
        ).toEqual(webp);

        // The first part is a bare chunk; the last is the last chunk, its padding and the trailer.
        const file = new Blob([new Uint8Array(size)]);
        const first = (await call('driveUploadEncrypt', { objectId: D, file, index: 0 })) as {
            bytes: number;
        };
        expect(first.bytes).toBe(CHUNK_SIZE + 16);
        const last = (await call('driveUploadEncrypt', { objectId: D, file, index: 1 })) as {
            bytes: number;
        };
        expect(last.bytes).toBe(prepared.ciphertextSize - (CHUNK_SIZE + 16));
        expect(last.bytes).toBeGreaterThan(3 + 16 + 1234 + 16);

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

        // A thumbnail fetch asks the object's URL for the fixed-length tail, not the trailer's own range.
        const range = thumbnailRange(CONTENT_SUITE, size, 1234);
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
        // agrees on the size, and was written under the current suite.
        await call('driveUploadForget', { objectId: D });
        const reopen = {
            workspaceId: WS,
            nodeId: B,
            versionId: C,
            objectId: D,
            contentSuite: CONTENT_SUITE,
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
        for (const contentSuite of [1, 2])
            await expect(call('driveUploadReopen', { ...reopen, contentSuite })).rejects.toThrow(
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
        expect(bare.ciphertextSize).toBe(256 + 16);
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

/*
 * What a PUT carries, captured: the worker sends parts with XMLHttpRequest,
 * which the test environment lacks, so a stand-in records the body and answers
 * with an ETag the way the store does.
 */
function captureUploads() {
    const sent = new Map<string, Uint8Array>();
    class FakeRequest {
        upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
        status = 0;
        timeout = 0;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        ontimeout: (() => void) | null = null;
        onabort: (() => void) | null = null;
        private url = '';
        open(_method: string, url: string) {
            this.url = url;
        }
        setRequestHeader() {}
        getResponseHeader(name: string) {
            return name === 'ETag' ? '"etag"' : null;
        }
        abort() {
            this.onabort?.();
        }
        send(body: Uint8Array) {
            sent.set(this.url, body.slice());
            this.status = 200;
            queueMicrotask(() => this.onload?.());
        }
    }
    vi.stubGlobal('XMLHttpRequest', FakeRequest);
    return sent;
}

describe('a suite 3 object end to end', () => {
    test('uploads the file and zeros, and downloads exactly the file, every chunk fetched', async () => {
        const { call, grant } = await unlockedSession();
        await call('driveOpenWorkspace', { userId: USER, grant });
        await call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: A,
                    kind: 'folder',
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    metadata: meta('Drive'),
                },
                {
                    id: B,
                    kind: 'file',
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    metadata: meta('clip.mp4'),
                },
            ],
        });
        // Just past a chunk, with a thumbnail: the padding pushes past the file into a full second chunk.
        const size = CHUNK_SIZE + 3;
        const content = Uint8Array.from({ length: size }, (_, i) => (i * 7 + 1) & 0xff);
        const file = new Blob([content]);
        const webp = new Uint8Array(500).fill(9);
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
        };
        const sent = captureUploads();
        try {
            for (let index = 0; index < prepared.chunkCount; index++) {
                await call('driveUploadEncrypt', { objectId: D, file, index });
                const result = (await call('driveUploadSend', {
                    objectId: D,
                    index,
                    url: `https://store/part/${index}`,
                })) as { ok: boolean };
                expect(result.ok).toBe(true);
            }
        } finally {
            vi.unstubAllGlobals();
        }
        const object = new Uint8Array(prepared.ciphertextSize);
        let offset = 0;
        for (let index = 0; index < prepared.chunkCount; index++) {
            const part = sent.get(`https://store/part/${index}`)!;
            object.set(part, offset);
            offset += part.length;
        }
        expect(offset).toBe(prepared.ciphertextSize);

        // The last chunk, opened with the primitives, is the file's tail and then zeros.
        const { contentKey } = (await call('driveExportKeys', {
            workspaceId: WS,
            nodeId: B,
            version: {
                id: C,
                objectId: D,
                contentKeyEnvelope: prepared.contentKeyEnvelope,
                contentNonce: prepared.contentNonce,
                contentSuite: CONTENT_SUITE,
                plaintextSize: null,
            },
        }).then((keys) => ({
            contentKey: decode((keys as { content: { key: string } }).content.key, 32),
        }))) as { contentKey: Uint8Array };
        const lastStart = CHUNK_SIZE + 16;
        const last = await decryptChunk(
            object.subarray(lastStart),
            contentKey,
            decode(prepared.contentNonce, 16),
            {
                workspaceId: WS,
                objectId: D,
                suite: CONTENT_SUITE,
                index: 1,
                chunkCount: 2,
                plaintextSize: size,
                thumbnailBytes: 500,
            },
        );
        expect(Array.from(last.subarray(0, 3))).toEqual(Array.from(content.subarray(CHUNK_SIZE)));
        expect(last.length).toBeGreaterThan(3);
        expect(last.subarray(3).every((byte) => byte === 0)).toBe(true);

        // The download fetches both chunks by range and hands back the file and nothing else.
        const version = {
            id: C,
            objectId: D,
            contentKeyEnvelope: prepared.contentKeyEnvelope,
            contentSuite: CONTENT_SUITE,
            plaintextSize: null,
        };
        const opened = (await call('driveDownloadOpen', {
            workspaceId: WS,
            nodeId: B,
            version,
            contentNonce: prepared.contentNonce,
        })) as { chunkCount: number; plaintextSize: number };
        expect(opened.chunkCount).toBe(2);
        const ranges: string[] = [];
        vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
            const range = (init.headers as Record<string, string>).Range!;
            ranges.push(range);
            const [start, end] = range.replace('bytes=', '').split('-').map(Number) as [
                number,
                number,
            ];
            return new Response(object.slice(start, end + 1), { status: 206 });
        });
        const received: Uint8Array[] = [];
        try {
            for (let index = 0; index < opened.chunkCount; index++) {
                const chunk = (await call('driveDownloadChunk', {
                    objectId: D,
                    url: 'https://store/object',
                    index,
                })) as { ok: true; plaintext: Uint8Array };
                expect(chunk.ok).toBe(true);
                received.push(chunk.plaintext);
            }
        } finally {
            vi.unstubAllGlobals();
        }
        expect(received[1]).toHaveLength(3);
        expect(Buffer.concat(received).equals(Buffer.from(content))).toBe(true);
        // The last range runs to the object's end, padding and trailer included.
        expect(ranges[1]).toBe(`bytes=${lastStart}-${prepared.ciphertextSize - 1}`);
    });

    test('a suite 2 object written before padding still downloads', async () => {
        const { call, grant, root } = await unlockedSession();
        await call('driveOpenWorkspace', { userId: USER, grant });
        const created = (await call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: A,
                    kind: 'folder',
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    metadata: meta('Drive'),
                },
                {
                    id: B,
                    kind: 'file',
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    metadata: meta('old.txt'),
                },
            ],
        })) as { nodes: { keyEnvelope: string }[] };
        const { openWorkspaceKey } = await import('./workspace');
        const { encryptChunk, generateContentNonce, generateKey, sealVersion } =
            await import('./drive');
        const aKey = await openNodeKey(
            decode(created.nodes[0]!.keyEnvelope, 72),
            await openWorkspaceKey(root, USER, grant),
            { workspaceId: WS, nodeId: A, parentId: WS, parentKeyEpoch: 1, keyEpoch: 1 },
        );
        const bKey = await openNodeKey(decode(created.nodes[1]!.keyEnvelope, 72), aKey, {
            workspaceId: WS,
            nodeId: B,
            parentId: A,
            parentKeyEpoch: 1,
            keyEpoch: 2,
        });
        const contentKey = generateKey();
        const nonce = generateContentNonce();
        const text = new TextEncoder().encode('written under suite 2');
        const envelope = await sealVersion(
            { contentKey, plaintextSize: text.length, thumbnailBytes: 0 },
            bKey,
            { workspaceId: WS, nodeId: B, versionId: C, objectId: D, suite: 2 },
        );
        const object = await encryptChunk(text, contentKey, nonce, {
            workspaceId: WS,
            objectId: D,
            suite: 2,
            index: 0,
            chunkCount: 1,
            plaintextSize: text.length,
            thumbnailBytes: 0,
        });
        expect(object).toHaveLength(text.length + 16);
        await call('driveDownloadOpen', {
            workspaceId: WS,
            nodeId: B,
            version: {
                id: C,
                objectId: D,
                contentKeyEnvelope: encode(envelope),
                contentSuite: 2,
                plaintextSize: null,
            },
            contentNonce: encode(nonce),
        });
        vi.stubGlobal('fetch', async () => new Response(object.slice(), { status: 206 }));
        try {
            const chunk = (await call('driveDownloadChunk', {
                objectId: D,
                url: 'https://store/object',
                index: 0,
            })) as { ok: true; plaintext: Uint8Array };
            expect(new TextDecoder().decode(chunk.plaintext)).toBe('written under suite 2');
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe('writer signatures', () => {
    test('every write is signed by the account making it, as the raw primitives check it', async () => {
        const { call, grant, identity } = await unlockedSession();
        await call('driveOpenWorkspace', { userId: USER, grant });
        const created = (await call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: A,
                    kind: 'folder',
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    metadata: meta('Drive'),
                },
                {
                    id: B,
                    kind: 'file',
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    metadata: meta('a.txt'),
                },
            ],
        })) as {
            nodes: { id: string; metadataEnvelope: string; metadataSignature: string }[];
        };
        const signer = decode(identity.signingPublicKey, 32);
        const holds = async (statement: Uint8Array, signature: string) =>
            verifyStatement(statement, decode(signature, 64), signer);
        for (const [index, kind] of [
            [0, 'folder'],
            [1, 'file'],
        ] as const) {
            const node = created.nodes[index]!;
            const ctx = { workspaceId: WS, nodeId: node.id, kind, metadataVersion: 1 };
            expect(
                await holds(
                    await metadataStatement(ctx, decode(node.metadataEnvelope)),
                    node.metadataSignature,
                ),
            ).toBe(true);
            // The kind is signed: the folder's statement is not the file's.
            expect(
                await holds(
                    await metadataStatement(
                        { ...ctx, kind: kind === 'file' ? 'folder' : 'file' },
                        decode(node.metadataEnvelope),
                    ),
                    node.metadataSignature,
                ),
            ).toBe(false);
        }
        const renamed = (await call('driveSealMetadata', {
            workspaceId: WS,
            nodeId: B,
            kind: 'file',
            metadataVersion: 2,
            metadata: meta('b.txt'),
        })) as { metadataEnvelope: string; metadataSignature: string };
        expect(
            await holds(
                await metadataStatement(
                    { workspaceId: WS, nodeId: B, kind: 'file', metadataVersion: 2 },
                    decode(renamed.metadataEnvelope),
                ),
                renamed.metadataSignature,
            ),
        ).toBe(true);
        // Renaming a record that did not verify re-locks it: the re-sealed statement holds, the
        // ordinary one does not, so the rename cannot launder the rest of the record.
        const relocked = (await call('driveSealMetadata', {
            workspaceId: WS,
            nodeId: B,
            kind: 'file',
            metadataVersion: 3,
            metadata: meta('c.txt'),
            signAs: 'resealed',
        })) as { metadataEnvelope: string; metadataSignature: string };
        const relockedCtx = {
            workspaceId: WS,
            nodeId: B,
            kind: 'file' as const,
            metadataVersion: 3,
        };
        expect(
            await holds(
                await metadataStatement(relockedCtx, decode(relocked.metadataEnvelope)),
                relocked.metadataSignature,
            ),
        ).toBe(false);
        expect(
            await holds(
                await metadataResealedStatement(relockedCtx, decode(relocked.metadataEnvelope)),
                relocked.metadataSignature,
            ),
        ).toBe(true);
        const prepared = (await call('driveUploadPrepare', {
            workspaceId: WS,
            nodeId: B,
            versionId: C,
            objectId: D,
            plaintextSize: 10,
        })) as { contentKeyEnvelope: string; versionSignature: string };
        const versionCtx = {
            workspaceId: WS,
            nodeId: B,
            versionId: C,
            objectId: D,
            contentSuite: CONTENT_SUITE,
        };
        expect(
            await holds(
                await versionStatement(versionCtx, decode(prepared.contentKeyEnvelope)),
                prepared.versionSignature,
            ),
        ).toBe(true);
        const rewrapped = (await call('driveUploadRewrap', {
            workspaceId: WS,
            objectId: D,
            nodeId: B,
            versionId: E,
        })) as { contentKeyEnvelope: string; versionSignature: string };
        expect(
            await holds(
                await versionStatement(
                    { ...versionCtx, versionId: E },
                    decode(rewrapped.contentKeyEnvelope),
                ),
                rewrapped.versionSignature,
            ),
        ).toBe(true);
        // A save from a link signs the saved statements, and only those, on both records.
        const saved = (await call('driveSealMetadata', {
            workspaceId: WS,
            nodeId: B,
            kind: 'file',
            metadataVersion: 4,
            metadata: meta('d.txt'),
            signAs: 'saved',
        })) as { metadataEnvelope: string; metadataSignature: string };
        const savedCtx = { workspaceId: WS, nodeId: B, kind: 'file' as const, metadataVersion: 4 };
        const savedEnvelope = decode(saved.metadataEnvelope);
        expect(
            await holds(
                await metadataSavedStatement(savedCtx, savedEnvelope),
                saved.metadataSignature,
            ),
        ).toBe(true);
        for (const other of [
            await metadataStatement(savedCtx, savedEnvelope),
            await metadataResealedStatement(savedCtx, savedEnvelope),
        ])
            expect(await holds(other, saved.metadataSignature)).toBe(false);
        const savedVersion = (await call('driveUploadRewrap', {
            workspaceId: WS,
            objectId: D,
            nodeId: B,
            versionId: F,
            signAs: 'saved',
        })) as { contentKeyEnvelope: string; versionSignature: string };
        const savedVersionCtx = { ...versionCtx, versionId: F };
        expect(
            await holds(
                await versionSavedStatement(
                    savedVersionCtx,
                    decode(savedVersion.contentKeyEnvelope),
                ),
                savedVersion.versionSignature,
            ),
        ).toBe(true);
        expect(
            await holds(
                await versionStatement(savedVersionCtx, decode(savedVersion.contentKeyEnvelope)),
                savedVersion.versionSignature,
            ),
        ).toBe(false);
    });

    test('nothing is written unsigned: without the identity open, writes are refused', async () => {
        const root = crypto.getRandomValues(new Uint8Array(32));
        const deviceKey = await createDeviceKey();
        const bundle = await rememberAccountKey(root, deviceKey, {
            userId: USER,
            keyVersion: 1,
            credentialVersion: 1,
            deviceKeyId: 'device',
        });
        const session = createCryptoSession();
        const call = (operation: string, input: unknown) =>
            session.handle({ id: 1, operation, input } as Parameters<typeof session.handle>[0]);
        await call('restore', { deviceKey, bundle });
        await call('driveOpenWorkspace', {
            userId: USER,
            grant: await createWorkspaceGrant(root, USER, WS, 1),
        });
        await expect(
            call('driveCreateNodes', {
                workspaceId: WS,
                nodes: [
                    {
                        id: A,
                        kind: 'folder',
                        parentId: WS,
                        parentKeyEpoch: 1,
                        keyEpoch: 1,
                        metadata: meta('Drive'),
                    },
                ],
            }),
        ).rejects.toThrow('Open your identity first.');
    });

    test('a reader is told who wrote a record, and when that cannot be trusted, why', async () => {
        const { call, grant } = await unlockedSession();
        await call('driveOpenWorkspace', { userId: USER, grant });
        const created = (await call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: A,
                    kind: 'folder',
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    metadata: meta('Drive'),
                },
                {
                    id: B,
                    kind: 'file',
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    metadata: meta('a.txt'),
                },
            ],
        })) as { nodes: { metadataEnvelope: string; metadataSignature: string }[] };
        const prepared = (await call('driveUploadPrepare', {
            workspaceId: WS,
            nodeId: B,
            versionId: C,
            objectId: D,
            plaintextSize: 10,
        })) as { contentKeyEnvelope: string; versionSignature: string };
        const version = {
            id: C,
            objectId: D,
            contentSuite: CONTENT_SUITE,
            contentKeyEnvelope: prepared.contentKeyEnvelope,
            signer: USER,
            signature: prepared.versionSignature,
        };
        const file = {
            id: B,
            kind: 'file' as const,
            metadataVersion: 1,
            metadataEnvelope: created.nodes[1]!.metadataEnvelope,
            metadataSigner: USER,
            metadataSignature: created.nodes[1]!.metadataSignature,
            versions: [version],
        };
        // Someone holding the folder's key (a viewer, a link, the server with a stolen key)
        // seals a name of their own and signs it with their own identity.
        await sodium.ready;
        const intruder = sodium.crypto_sign_keypair();
        const INTRUDER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
        const planted = encode(
            await signStatement(
                await metadataStatement(
                    { workspaceId: WS, nodeId: B, kind: 'file', metadataVersion: 1 },
                    decode(file.metadataEnvelope),
                ),
                intruder.privateKey,
            ),
        );
        const verify = async (
            nodes: unknown[],
            signers: Record<string, { current: string; retired: string[] }> = {},
        ) =>
            (
                (await call('driveVerify', {
                    workspaceId: WS,
                    signers,
                    nodes: nodes as never,
                })) as {
                    nodes: {
                        id: string;
                        metadata: string;
                        versions: { id: string; integrity: string }[];
                    }[];
                }
            ).nodes;
        const [own, intruded, lied, swapped, replayed, old, otherVersion] = await verify([
            // This account's own records: the worker knows its own key without being told.
            file,
            // Signed by someone this person never verified.
            { ...file, metadataSigner: INTRUDER, metadataSignature: planted, versions: [] },
            // The server names this account as the writer of the intruder's record.
            { ...file, metadataSignature: planted, versions: [] },
            // A different envelope under the real signature (the folder's metadata, here).
            { ...file, metadataEnvelope: created.nodes[0]!.metadataEnvelope, versions: [] },
            // The real signature replayed at another metadata version, and onto another version.
            {
                ...file,
                metadataVersion: 2,
                versions: [{ ...version, id: E }],
            },
            // Written before signatures.
            {
                ...file,
                metadataSigner: null,
                metadataSignature: null,
                versions: [{ ...version, signer: null, signature: null }],
            },
            // A version signature presented for the same version of another object.
            { ...file, versions: [{ ...version, objectId: A }] },
        ]);
        expect(own).toEqual({
            id: B,
            metadata: 'verified',
            versions: [{ id: C, integrity: 'verified' }],
        });
        expect(intruded!.metadata).toBe('unknown-signer');
        expect(lied!.metadata).toBe('bad-signature');
        expect(swapped!.metadata).toBe('bad-signature');
        expect(replayed!.metadata).toBe('bad-signature');
        expect(replayed!.versions).toEqual([{ id: E, integrity: 'bad-signature' }]);
        expect(old!.metadata).toBe('unsigned');
        expect(old!.versions).toEqual([{ id: C, integrity: 'unsigned' }]);
        expect(otherVersion!.versions[0]!.integrity).toBe('bad-signature');
        // Once the caller has verified the intruder (say, they compared words), their record is theirs.
        const [known] = await verify(
            [{ ...file, metadataSigner: INTRUDER, metadataSignature: planted, versions: [] }],
            { [INTRUDER]: { current: encode(intruder.publicKey), retired: [] } },
        );
        expect(known!.metadata).toBe('verified');
        // A key the caller passes for this account does not stand in for its own: the
        // intruder's signature under this account's name is still bad.
        const [impostor] = await verify([{ ...file, metadataSignature: planted, versions: [] }], {
            [USER]: { current: encode(intruder.publicKey), retired: [] },
        });
        expect(impostor!.metadata).toBe('bad-signature');
        // A key only a succession vouched for is retired: the record is no longer vouched for.
        const [retired] = await verify(
            [{ ...file, metadataSigner: INTRUDER, metadataSignature: planted, versions: [] }],
            {
                [INTRUDER]: {
                    current: encode(sodium.crypto_sign_keypair().publicKey),
                    retired: [encode(intruder.publicKey)],
                },
            },
        );
        expect(retired!.metadata).toBe('retired-key');
        // Without a trust set, or with one that does not read, nothing is checked at all.
        await expect(
            call('driveVerify', { workspaceId: WS, signers: null as never, nodes: [file] }),
        ).rejects.toThrow(/couldn’t load/);
        await expect(
            call('driveVerify', {
                workspaceId: WS,
                signers: { [INTRUDER]: { current: 'not a key', retired: [] } },
                nodes: [file],
            }),
        ).rejects.toThrow(/could not be read/);
    });

    test('a copy of a record nobody verified is signed re-sealed, so copying never launders it', async () => {
        const { call, grant } = await unlockedSession();
        await call('driveOpenWorkspace', { userId: USER, grant });
        const created = (await call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: A,
                    kind: 'folder',
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    metadata: meta('Drive'),
                },
                {
                    id: B,
                    kind: 'file',
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    metadata: meta('planted.pdf'),
                },
            ],
        })) as { nodes: { metadataEnvelope: string; metadataSignature: string }[] };
        const prepared = (await call('driveUploadPrepare', {
            workspaceId: WS,
            nodeId: B,
            versionId: C,
            objectId: D,
            plaintextSize: 10,
        })) as { contentKeyEnvelope: string; versionSignature: string };
        // The server (or anyone holding the folder key) planted this file and signed it
        // with a key of its own, naming someone this person never checked.
        await sodium.ready;
        const intruder = sodium.crypto_sign_keypair();
        const INTRUDER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
        const metadataEnvelope = created.nodes[1]!.metadataEnvelope;
        const planted: {
            nodeId: string;
            id: string;
            objectId: string;
            contentKeyEnvelope: string;
            contentSuite: number;
            plaintextSize: null;
            metadataVersion: number;
            metadataEnvelope: string;
            metadataSigner: string | null;
            metadataSignature: string | null;
            signer: string | null;
            signature: string | null;
        } = {
            nodeId: B,
            id: C,
            objectId: D,
            contentKeyEnvelope: prepared.contentKeyEnvelope,
            contentSuite: CONTENT_SUITE,
            plaintextSize: null,
            metadataVersion: 1,
            metadataEnvelope,
            metadataSigner: INTRUDER,
            metadataSignature: encode(
                await signStatement(
                    await metadataStatement(
                        { workspaceId: WS, nodeId: B, kind: 'file', metadataVersion: 1 },
                        decode(metadataEnvelope),
                    ),
                    intruder.privateKey,
                ),
            ),
            signer: INTRUDER,
            signature: encode(
                await signStatement(
                    await versionStatement(
                        {
                            workspaceId: WS,
                            nodeId: B,
                            versionId: C,
                            objectId: D,
                            contentSuite: CONTENT_SUITE,
                        },
                        decode(prepared.contentKeyEnvelope),
                    ),
                    intruder.privateKey,
                ),
            ),
        };
        const copyId = 'dddddddd-dddd-4ddd-8ddd-000000000003';
        const copyVersion = 'dddddddd-dddd-4ddd-8ddd-000000000002';
        const copy = (signers: unknown, source = planted) =>
            call('driveCopyFile', {
                workspaceId: WS,
                signers: signers as never,
                source,
                node: {
                    id: copyId,
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 3,
                    metadata: meta('x'),
                },
                versionId: copyVersion,
            }) as Promise<{
                metadataEnvelope: string;
                metadataSignature: string;
                contentKeyEnvelope: string;
                versionSignature: string;
            }>;
        // Without the trust set the copy does not happen: it never re-signs blind.
        await expect(copy(undefined)).rejects.toThrow(/couldn’t load/);
        const readBack = async (copied: Awaited<ReturnType<typeof copy>>) =>
            (
                (await call('driveVerify', {
                    workspaceId: WS,
                    signers: {},
                    nodes: [
                        {
                            id: copyId,
                            kind: 'file',
                            metadataVersion: 1,
                            metadataEnvelope: copied.metadataEnvelope,
                            metadataSigner: USER,
                            metadataSignature: copied.metadataSignature,
                            versions: [
                                {
                                    id: copyVersion,
                                    objectId: D,
                                    contentSuite: CONTENT_SUITE,
                                    contentKeyEnvelope: copied.contentKeyEnvelope,
                                    signer: USER,
                                    signature: copied.versionSignature,
                                },
                            ],
                        },
                    ],
                })) as { nodes: { metadata: string; versions: { integrity: string }[] }[] }
            ).nodes[0]!;
        // Re-locked by this person, who vouches for nothing more: never verified.
        const read = await readBack(await copy({}));
        expect(read.metadata).toBe('resealed');
        expect(read.versions[0]!.integrity).toBe('resealed');
        // Once the intruder is someone this person checked, a copy is theirs to vouch for.
        const trusted = { [INTRUDER]: { current: encode(intruder.publicKey), retired: [] } };
        const vouched = await readBack(await copy(trusted));
        expect(vouched.metadata).toBe('verified');
        expect(vouched.versions[0]!.integrity).toBe('verified');
        // A key the intruder has since replaced vouches for nothing: re-sealed again.
        const replaced = await readBack(
            await copy({
                [INTRUDER]: {
                    current: encode(sodium.crypto_sign_keypair().publicKey),
                    retired: [encode(intruder.publicKey)],
                },
            }),
        );
        expect(replaced.metadata).toBe('resealed');
        // An unsigned source (written before signatures, or stripped) is re-sealed too,
        // and so is each record on its own: a stripped name beside a signed version.
        const stripped = await readBack(
            await copy(trusted, { ...planted, metadataSigner: null, metadataSignature: null }),
        );
        expect(stripped.metadata).toBe('resealed');
        expect(stripped.versions[0]!.integrity).toBe('verified');
    });
});

describe('exporting keys', () => {
    test('the exported keys open the real envelopes; an unopened node has nothing to export', async () => {
        const { session, call, grant } = await unlockedSession();
        await call('driveOpenWorkspace', { userId: USER, grant });
        const created = (await call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: A,
                    kind: 'folder',
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    metadata: meta('Drive'),
                },
                {
                    id: B,
                    kind: 'file',
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    metadata: meta('file.bin'),
                },
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
                contentSuite: CONTENT_SUITE,
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
            suite: CONTENT_SUITE,
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

describe('keys from links, shares and reports', () => {
    const OTHER_WS = '33333333-3333-4333-8333-333333333333';
    const LINK = '44444444-4444-4444-8444-444444444444';

    /* A link the server made for a node id of its choosing, under a key it knows. */
    async function plantedLink(workspaceId: string, nodeId: string) {
        const planted = crypto.getRandomValues(new Uint8Array(32));
        const secret = generateLinkSecret();
        const salt = generateLinkSalt();
        const linkEnvelope = await sealLinkKey(planted, secret, null, salt, {
            workspaceId,
            nodeId,
            keyEpoch: 1,
            linkId: LINK,
        });
        return {
            planted,
            input: {
                workspaceId,
                nodeId,
                keyEpoch: 1,
                linkId: LINK,
                secret: encode(secret),
                password: null,
                salt: encode(salt),
                linkEnvelope: encode(linkEnvelope),
            },
        };
    }

    test('never replace the key of a folder of the person’s own, whatever workspace they name', async () => {
        const { call, grant } = await unlockedSession();
        await call('driveOpenWorkspace', { userId: USER, grant });
        await call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: A,
                    kind: 'folder',
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    metadata: meta('Mine'),
                },
            ],
        });
        const exported = async () =>
            (
                (await call('driveExportKeys', { workspaceId: WS, nodeId: A, version: null })) as {
                    nodeKey: string;
                }
            ).nodeKey;
        const before = await exported();

        // Naming the person's own workspace is refused outright.
        const own = await plantedLink(WS, A);
        await expect(call('driveOpenLink', own.input)).rejects.toThrow(/folder of your own/);
        // Naming another workspace opens, but only in that workspace's pool: the folder of
        // their own keeps its key, and a child made under it is wrapped under the real one.
        const elsewhere = await plantedLink(OTHER_WS, A);
        await call('driveOpenLink', elsewhere.input);
        expect(await exported()).toBe(before);
        expect(before).not.toBe(encode(own.planted));
        const child = (await call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: B,
                    kind: 'folder',
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    metadata: meta('new'),
                },
            ],
        })) as { nodes: { keyEnvelope: string }[] };
        const ctx = { workspaceId: WS, nodeId: B, parentId: A, parentKeyEpoch: 1, keyEpoch: 2 };
        await expect(
            openNodeKey(decode(child.nodes[0]!.keyEnvelope, 72), decode(before), ctx),
        ).resolves.toHaveLength(32);
        await expect(
            openNodeKey(decode(child.nodes[0]!.keyEnvelope, 72), elsewhere.planted, ctx),
        ).rejects.toThrow();
    });
});
