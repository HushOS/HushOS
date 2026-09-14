import { describe, expect, test } from 'vitest';
import { createDeviceKey, rememberAccountKey } from './device';
import { createIdentity } from './identity';
import { openShareKey, sealShareKey } from './shares';
import { createCryptoSession } from './session';
import { createWorkspaceGrant } from './workspace';
import { decode } from './keys';

/*
 * A share opens for the person it was sealed to, under the context it was
 * sealed with, and for nobody and nothing else. The session test runs the
 * whole exchange: the owner seals a folder key to a contact, the contact opens
 * it and reads the folder's children, and cannot climb above the folder.
 */

const WS = '22222222-2222-4222-8222-222222222222';
const ids = ['a', 'b', 'c', 'd', 'e'].map(
    (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`,
);
const [ROOT, SHARED, CHILD, OWNER, GUEST] = ids as [string, string, string, string, string];
const meta = (name: string) => ({ name, mime: null, size: null, modified: null });

async function person(userId: string) {
    const root = crypto.getRandomValues(new Uint8Array(32));
    const identity = await createIdentity(root, userId);
    const deviceKey = await createDeviceKey();
    const bundle = await rememberAccountKey(root, deviceKey, {
        userId,
        keyVersion: 1,
        credentialVersion: 1,
        deviceKeyId: 'device',
    });
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
    await call('identityOpen', { userId, identity });
    return { root, identity, call };
}

describe('share envelopes', () => {
    test('open for the grantee under the sealed context only', async () => {
        const { openIdentityEncryptionKey } = await import('./identity');
        const identities = await Promise.all(
            [OWNER, GUEST, CHILD].map(async (userId) => {
                const root = crypto.getRandomValues(new Uint8Array(32));
                const envelope = await createIdentity(root, userId);
                return {
                    envelope,
                    privateKey: await openIdentityEncryptionKey(root, userId, envelope),
                };
            }),
        );
        const [owner, guest, stranger] = identities as [
            (typeof identities)[number],
            (typeof identities)[number],
            (typeof identities)[number],
        ];
        const publicKey = (who: (typeof identities)[number]) =>
            decode(who.envelope.encryptionPublicKey, 32);
        const nodeKey = crypto.getRandomValues(new Uint8Array(32));
        const ctx = {
            workspaceId: WS,
            nodeId: SHARED,
            keyEpoch: 3,
            granteeUserId: GUEST,
            granterUserId: OWNER,
        };
        const envelope = await sealShareKey(nodeKey, publicKey(guest), owner.privateKey, ctx);
        expect(envelope).toHaveLength(72);
        const opened = await openShareKey(envelope, publicKey(owner), guest.privateKey, ctx);
        expect(Buffer.from(opened).equals(Buffer.from(nodeKey))).toBe(true);
        // The wrong person, the wrong granter key, or a shifted context: refused.
        await expect(
            openShareKey(envelope, publicKey(owner), stranger.privateKey, ctx),
        ).rejects.toThrow();
        await expect(
            openShareKey(envelope, publicKey(stranger), guest.privateKey, ctx),
        ).rejects.toThrow();
        for (const change of [
            { keyEpoch: 4 },
            { nodeId: CHILD },
            { granteeUserId: CHILD },
            { granterUserId: GUEST },
        ])
            await expect(
                openShareKey(envelope, publicKey(owner), guest.privateKey, { ...ctx, ...change }),
            ).rejects.toThrow();
    });

    test('through the session: the contact reads the shared folder and nothing above it', async () => {
        const owner = await person(OWNER);
        const guest = await person(GUEST);
        const grant = await createWorkspaceGrant(owner.root, OWNER, WS, 1);
        await owner.call('driveOpenWorkspace', { userId: OWNER, grant });
        const created = (await owner.call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                { id: ROOT, parentId: WS, parentKeyEpoch: 1, keyEpoch: 1, metadata: meta('Drive') },
                {
                    id: SHARED,
                    parentId: ROOT,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    metadata: meta('Project'),
                },
                {
                    id: CHILD,
                    parentId: SHARED,
                    parentKeyEpoch: 2,
                    keyEpoch: 3,
                    metadata: meta('notes.md'),
                },
            ],
        })) as { nodes: { id: string; keyEnvelope: string; metadataEnvelope: string }[] };

        const { shareEnvelope } = (await owner.call('driveSealShare', {
            workspaceId: WS,
            nodeId: SHARED,
            keyEpoch: 2,
            granterUserId: OWNER,
            granteeUserId: GUEST,
            granteePublicKey: guest.identity.encryptionPublicKey,
        })) as { shareEnvelope: string };
        // A stale epoch is refused before anything is sealed.
        await expect(
            owner.call('driveSealShare', {
                workspaceId: WS,
                nodeId: SHARED,
                keyEpoch: 9,
                granterUserId: OWNER,
                granteeUserId: GUEST,
                granteePublicKey: guest.identity.encryptionPublicKey,
            }),
        ).rejects.toThrow(/changed/);

        await guest.call('driveOpenShare', {
            workspaceId: WS,
            nodeId: SHARED,
            keyEpoch: 2,
            granterUserId: OWNER,
            granterPublicKey: owner.identity.encryptionPublicKey,
            granteeUserId: GUEST,
            shareEnvelope,
        });
        const opened = (await guest.call('driveOpenNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: SHARED,
                    parentId: ROOT,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    keyEnvelope: created.nodes[1]!.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: created.nodes[1]!.metadataEnvelope,
                },
                {
                    id: CHILD,
                    parentId: SHARED,
                    parentKeyEpoch: 2,
                    keyEpoch: 3,
                    keyEnvelope: created.nodes[2]!.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: created.nodes[2]!.metadataEnvelope,
                },
                // The folder above the share: its key was never given, so it stays closed.
                {
                    id: ROOT,
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    keyEnvelope: created.nodes[0]!.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: created.nodes[0]!.metadataEnvelope,
                },
            ],
        })) as { nodes: { id: string; metadata?: { name: string }; error?: string }[] };
        expect(opened.nodes[0]!.metadata?.name).toBe('Project');
        expect(opened.nodes[1]!.metadata?.name).toBe('notes.md');
        expect(opened.nodes[2]!.error).toBeDefined();
        // A swapped granter key (a dishonest server) cannot open the share.
        const third = await person(CHILD);
        await expect(
            third.call('driveOpenShare', {
                workspaceId: WS,
                nodeId: SHARED,
                keyEpoch: 2,
                granterUserId: OWNER,
                granterPublicKey: third.identity.encryptionPublicKey,
                granteeUserId: CHILD,
                shareEnvelope,
            }),
        ).rejects.toThrow();
    });
});
