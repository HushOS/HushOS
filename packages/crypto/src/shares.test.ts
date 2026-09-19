import { describe, expect, test } from 'vitest';
import { createDeviceKey, rememberAccountKey } from './device';
import { createIdentity } from './identity';
import { HYBRID_SHARE_ENVELOPE_BYTES, openShareKey, sealShareKey } from './shares';
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
        const legacy = (who: (typeof identities)[number]) => ({
            encryptionPublicKey: publicKey(who),
            kemPublicKey: null,
        });
        const secrets = (who: (typeof identities)[number]) => ({
            privateKey: who.privateKey,
            kemSecretKey: null,
        });
        const envelope = await sealShareKey(nodeKey, legacy(guest), owner.privateKey, ctx);
        expect(envelope).toHaveLength(72);
        const opened = await openShareKey(envelope, publicKey(owner), secrets(guest), ctx);
        expect(Buffer.from(opened).equals(Buffer.from(nodeKey))).toBe(true);
        // The wrong person, the wrong granter key, or a shifted context: refused.
        await expect(
            openShareKey(envelope, publicKey(owner), secrets(stranger), ctx),
        ).rejects.toThrow();
        await expect(
            openShareKey(envelope, publicKey(stranger), secrets(guest), ctx),
        ).rejects.toThrow();
        for (const change of [
            { keyEpoch: 4 },
            { nodeId: CHILD },
            { granteeUserId: CHILD },
            { granterUserId: GUEST },
        ])
            await expect(
                openShareKey(envelope, publicKey(owner), secrets(guest), { ...ctx, ...change }),
            ).rejects.toThrow();
    });

    test('the hybrid suite needs both private halves, and a suite 1 envelope still opens beside it', async () => {
        const { openIdentityEncryptionKey, openIdentityKemKey } = await import('./identity');
        const { KEM_CIPHERTEXT_BYTES } = await import('./pq');
        const make = async (userId: string) => {
            const root = crypto.getRandomValues(new Uint8Array(32));
            const envelope = await createIdentity(root, userId);
            return {
                envelope,
                privateKey: await openIdentityEncryptionKey(root, userId, envelope),
                kem: (await openIdentityKemKey(root, userId, envelope))!,
            };
        };
        const [owner, guest, stranger] = await Promise.all([make(OWNER), make(GUEST), make(CHILD)]);
        const nodeKey = crypto.getRandomValues(new Uint8Array(32));
        const ctx = {
            workspaceId: WS,
            nodeId: SHARED,
            keyEpoch: 3,
            granteeUserId: GUEST,
            granterUserId: OWNER,
        };
        const guestKeys = {
            encryptionPublicKey: decode(guest.envelope.encryptionPublicKey, 32),
            kemPublicKey: decode(guest.kem.publicKey, 1184),
        };
        const ownerPublic = decode(owner.envelope.encryptionPublicKey, 32);
        const envelope = await sealShareKey(nodeKey, guestKeys, owner.privateKey, ctx);
        expect(envelope).toHaveLength(HYBRID_SHARE_ENVELOPE_BYTES);
        const both = { privateKey: guest.privateKey, kemSecretKey: guest.kem.secretKey };
        expect(
            Buffer.from(await openShareKey(envelope, ownerPublic, both, ctx)).equals(
                Buffer.from(nodeKey),
            ),
        ).toBe(true);
        // The X25519 half alone is not enough, nor is it with somebody else's KEM key.
        await expect(
            openShareKey(envelope, ownerPublic, { ...both, kemSecretKey: null }, ctx),
        ).rejects.toThrow(/does not hold/);
        await expect(
            openShareKey(
                envelope,
                ownerPublic,
                { ...both, kemSecretKey: stranger.kem.secretKey },
                ctx,
            ),
        ).rejects.toThrow();
        // Nor is the KEM half with somebody else's X25519 key.
        await expect(
            openShareKey(envelope, ownerPublic, { ...both, privateKey: stranger.privateKey }, ctx),
        ).rejects.toThrow();
        // A bit flipped in the KEM ciphertext: ML-KEM rejects implicitly, the AEAD refuses.
        const tampered = envelope.slice();
        tampered[24 + KEM_CIPHERTEXT_BYTES - 1]! ^= 1;
        await expect(openShareKey(tampered, ownerPublic, both, ctx)).rejects.toThrow();
        // The same context under the other suite does not open it either.
        const asLegacy = await sealShareKey(
            nodeKey,
            { ...guestKeys, kemPublicKey: null },
            owner.privateKey,
            ctx,
        );
        expect(asLegacy).toHaveLength(72);
        expect(
            Buffer.from(await openShareKey(asLegacy, ownerPublic, both, ctx)).equals(
                Buffer.from(nodeKey),
            ),
        ).toBe(true);
        await expect(
            openShareKey(envelope.subarray(0, 72), ownerPublic, both, ctx),
        ).rejects.toThrow();
        await expect(
            openShareKey(envelope.subarray(0, 100), ownerPublic, both, ctx),
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
            granteeKemPublicKey: guest.identity.kem!.publicKey,
        })) as { shareEnvelope: string };
        expect(decode(shareEnvelope)).toHaveLength(HYBRID_SHARE_ENVELOPE_BYTES);
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
