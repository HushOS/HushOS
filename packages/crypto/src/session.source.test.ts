import { describe, expect, test } from 'vitest';
import { createDeviceKey, rememberAccountKey } from './device';
import { CHUNK_SIZE } from './drive';
import { createIdentity } from './identity';
import { createCryptoSession } from './session';
import { createWorkspaceGrant } from './workspace';

/*
 * In-memory upload bytes in the worker: attached once, read chunk by chunk
 * exactly as a File of the same bytes is, across any split into parts, and
 * zeroed and gone once released or locked.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const [A, B, C, D] = ['a', 'b', 'c', 'd'].map(
    (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`,
) as [string, string, string, string];

async function preparedUpload(size: number) {
    const root = crypto.getRandomValues(new Uint8Array(32));
    const deviceKey = await createDeviceKey();
    const bundle = await rememberAccountKey(root, deviceKey, {
        userId: USER,
        keyVersion: 1,
        credentialVersion: 1,
        deviceKeyId: 'device',
    });
    const session = createCryptoSession();
    let id = 0;
    const call = (operation: string, input: unknown) =>
        session.handle({ id: ++id, operation, input } as Parameters<typeof session.handle>[0]);
    await call('restore', { deviceKey, bundle });
    await call('identityOpen', { userId: USER, identity: await createIdentity(root, USER) });
    await call('driveOpenWorkspace', {
        userId: USER,
        grant: await createWorkspaceGrant(root, USER, WS, 1),
    });
    const meta = (name: string) => ({ name, mime: null, size: null, modified: null });
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
                metadata: meta('copy.bin'),
            },
        ],
    });
    await call('driveUploadPrepare', {
        workspaceId: WS,
        nodeId: B,
        versionId: C,
        objectId: D,
        plaintextSize: size,
        thumbnail: null,
    });
    const digest = async (file: unknown, index: number) =>
        ((await call('driveUploadDigest', { objectId: D, file, index })) as { digest: string })
            .digest;
    return { session, call, digest };
}

describe('in-memory upload bytes', () => {
    test('read exactly as a File of the same bytes, whatever the parts’ boundaries', async () => {
        const size = 2 * CHUNK_SIZE + 5;
        const content = Uint8Array.from({ length: size }, (_, i) => (i * 13 + 5) & 0xff);
        const { call, digest } = await preparedUpload(size);
        // Split off the chunk boundaries, one part straddling both.
        const parts = [
            content.slice(0, 100),
            content.slice(100, 2 * CHUNK_SIZE - 3),
            content.slice(2 * CHUNK_SIZE - 3),
        ];
        expect(await call('driveSourceAttach', { sourceId: 's-1', parts })).toEqual({ size });
        const file = new Blob([content]);
        for (let index = 0; index < 3; index++)
            expect(await digest({ source: 's-1' }, index)).toBe(await digest(file, index));
    });

    test('refuses bytes of the wrong length, as a changed file is refused', async () => {
        const { call, digest } = await preparedUpload(100);
        await call('driveSourceAttach', { sourceId: 's-1', parts: [new Uint8Array(99)] });
        await expect(digest({ source: 's-1' }, 0)).rejects.toThrow('The file changed');
    });

    test('zeroes and forgets the bytes when released, and on a lock', async () => {
        const { session, call, digest } = await preparedUpload(64);
        const kept = new Uint8Array(64).fill(7);
        await call('driveSourceAttach', { sourceId: 's-1', parts: [kept] });
        expect(await call('driveSourceRelease', { sourceId: 's-1' })).toEqual({ released: true });
        expect(kept.every((byte) => byte === 0)).toBe(true);
        await expect(digest({ source: 's-1' }, 0)).rejects.toThrow('no longer on this device');

        const locked = new Uint8Array(64).fill(7);
        await call('driveSourceAttach', { sourceId: 's-2', parts: [locked] });
        session.reset();
        expect(locked.every((byte) => byte === 0)).toBe(true);
    });
});
