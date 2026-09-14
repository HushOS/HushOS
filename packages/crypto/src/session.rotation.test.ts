import { describe, expect, test } from 'vitest';
import { createDeviceKey, rememberAccountKey } from './device';
import { createIdentity } from './identity';
import { generateKey, wrapContentKey } from './drive';
import { openLinkKey } from './links';
import { createCryptoSession } from './session';
import { createWorkspaceGrant } from './workspace';
import { decode, encode } from './keys';

/*
 * Rotation in the worker: a chain gets fresh keys top-down, the old keys stay
 * beside them so children not yet rotated still open, metadata and content
 * keys come through unchanged under the new keys, a share is re-sealed to the
 * grantee at the new epoch, a link is re-sealed for the same secret and
 * password, and a fresh device reading the previous envelopes reaches an
 * unrotated child while a device without the old parent key does not.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const GUEST = '33333333-3333-4333-8333-333333333333';
const WS = '22222222-2222-4222-8222-222222222222';
const ids = ['a', 'b', 'c', 'd', 'e', 'f'].map(
    (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`,
);
const [A, B, C, VERSION, OBJECT, LINK] = ids as [string, string, string, string, string, string];
const meta = (name: string) => ({ name, mime: null, size: null, modified: null });

async function device(userId: string, root: Uint8Array<ArrayBuffer>, deviceKeyId: string) {
    const deviceKey = await createDeviceKey();
    const bundle = await rememberAccountKey(root, deviceKey, {
        userId,
        keyVersion: 1,
        credentialVersion: 1,
        deviceKeyId,
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
    return call;
}

describe('rotation', () => {
    test('re-keys a chain top-down, keeps the old keys for unrotated children, and re-seals versions, shares and links', async () => {
        const root = crypto.getRandomValues(new Uint8Array(32));
        const grant = await createWorkspaceGrant(root, USER, WS, 1);
        const identity = await createIdentity(root, USER);
        const guestRoot = crypto.getRandomValues(new Uint8Array(32));
        const guestIdentity = await createIdentity(guestRoot, GUEST);
        const owner = await device(USER, root, 'owner');
        await owner('driveOpenWorkspace', { userId: USER, grant });
        await owner('identityOpen', { userId: USER, identity });

        const created = (await owner('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                { id: A, parentId: WS, parentKeyEpoch: 1, keyEpoch: 1, metadata: meta('Drive') },
                { id: B, parentId: A, parentKeyEpoch: 1, keyEpoch: 2, metadata: meta('shared') },
                { id: C, parentId: B, parentKeyEpoch: 2, keyEpoch: 3, metadata: meta('inner') },
            ],
        })) as { nodes: { id: string; keyEnvelope: string; metadataEnvelope: string }[] };
        const [a, b, c] = created.nodes as [
            (typeof created.nodes)[number],
            (typeof created.nodes)[number],
            (typeof created.nodes)[number],
        ];
        // A file version under B, a share of B to the guest, and a password link on B.
        const contentKey = generateKey();
        const bKey = await (async () => {
            // The test needs B's key to wrap a content key; take it the way a device would, from its envelope.
            const { openNodeKey } = await import('./drive');
            const { openWorkspaceKey } = await import('./workspace');
            const wsKey = await openWorkspaceKey(root, USER, grant);
            const aKey = await openNodeKey(decode(a.keyEnvelope, 72), wsKey, {
                workspaceId: WS,
                nodeId: A,
                parentId: WS,
                parentKeyEpoch: 1,
                keyEpoch: 1,
            });
            return openNodeKey(decode(b.keyEnvelope, 72), aKey, {
                workspaceId: WS,
                nodeId: B,
                parentId: A,
                parentKeyEpoch: 1,
                keyEpoch: 2,
            });
        })();
        const contentEnvelope = encode(
            await wrapContentKey(contentKey, bKey, {
                workspaceId: WS,
                nodeId: B,
                versionId: VERSION,
                objectId: OBJECT,
            }),
        );
        const { shareEnvelope } = (await owner('driveSealShare', {
            workspaceId: WS,
            nodeId: B,
            keyEpoch: 2,
            granterUserId: USER,
            granteeUserId: GUEST,
            granteePublicKey: guestIdentity.encryptionPublicKey,
        })) as { shareEnvelope: string };
        const link = (await owner('driveSealLink', {
            workspaceId: WS,
            nodeId: B,
            keyEpoch: 2,
            linkId: LINK,
            password: 'open sesame',
        })) as { linkEnvelope: string; secret: string; salt: string; secretEnvelope: string };

        // Rotate B (the share root) first, at target epoch 9; C waits for the next batch.
        const first = (await owner('driveRotateNodes', {
            workspaceId: WS,
            targetEpoch: 9,
            granterUserId: USER,
            nodes: [
                {
                    id: B,
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    wrappedParentKeyEpoch: 1,
                    keyEnvelope: b.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: b.metadataEnvelope,
                    // A first-release version: suite 1, its size on the row, resealed in its own suite.
                    versions: [
                        {
                            id: VERSION,
                            objectId: OBJECT,
                            contentKeyEnvelope: contentEnvelope,
                            contentSuite: 1,
                            plaintextSize: 5,
                        },
                    ],
                    shares: [
                        {
                            id: 'share-1',
                            granteeUserId: GUEST,
                            granteePublicKey: guestIdentity.encryptionPublicKey,
                        },
                    ],
                    links: [{ id: LINK, hasPassword: true, secretEnvelope: link.secretEnvelope }],
                },
            ],
        })) as {
            nodes: {
                id: string;
                keyEnvelope: string;
                metadataEnvelope: string;
                versions: { id: string; contentKeyEnvelope: string }[];
                shares: { id: string; shareEnvelope: string }[];
                links: {
                    id: string;
                    linkEnvelope?: string;
                    secretEnvelope?: string;
                    unsealable?: true;
                }[];
                error?: string;
            }[];
        };
        const rotatedB = first.nodes[0]!;
        expect(rotatedB.error).toBeUndefined();
        expect(rotatedB.keyEnvelope).not.toBe(b.keyEnvelope);
        expect(rotatedB.versions[0]!.contentKeyEnvelope).not.toBe(contentEnvelope);
        expect(decode(rotatedB.versions[0]!.contentKeyEnvelope)).toHaveLength(72);
        expect(rotatedB.shares[0]!.shareEnvelope).not.toBe(shareEnvelope);
        expect(rotatedB.links[0]!.unsealable).toBeUndefined();

        // C, wrapped under B's old key, still opens here: the worker kept B's previous key.
        const openedC = (await owner('driveOpenNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: C,
                    parentId: B,
                    parentKeyEpoch: 2,
                    keyEpoch: 3,
                    keyEnvelope: c.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: c.metadataEnvelope,
                },
            ],
        })) as { nodes: { metadata?: { name: string }; error?: string }[] };
        expect(openedC.nodes[0]!.metadata?.name).toBe('inner');

        // Then C rotates under B's new key.
        const second = (await owner('driveRotateNodes', {
            workspaceId: WS,
            targetEpoch: 9,
            granterUserId: USER,
            nodes: [
                {
                    id: C,
                    parentId: B,
                    parentKeyEpoch: 9,
                    keyEpoch: 3,
                    wrappedParentKeyEpoch: 2,
                    keyEnvelope: c.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: c.metadataEnvelope,
                    versions: [],
                    shares: [],
                    links: [],
                },
            ],
        })) as { nodes: { keyEnvelope: string; metadataEnvelope: string; error?: string }[] };
        expect(second.nodes[0]!.error).toBeUndefined();

        // A second device of the owner, fresh: the new envelopes open top-down with no old key anywhere.
        const fresh = await device(USER, root, 'owner-2');
        await fresh('driveOpenWorkspace', { userId: USER, grant });
        const reopened = (await fresh('driveOpenNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: A,
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    keyEnvelope: a.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: a.metadataEnvelope,
                },
                {
                    id: B,
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 9,
                    keyEnvelope: rotatedB.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: rotatedB.metadataEnvelope,
                    // The previous envelope is still served mid-rotation; it opens too.
                    prevKeyEnvelope: b.keyEnvelope,
                    prevKeyEpoch: 2,
                    prevParentKeyEpoch: 1,
                },
                {
                    id: C,
                    parentId: B,
                    parentKeyEpoch: 9,
                    keyEpoch: 9,
                    keyEnvelope: second.nodes[0]!.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: second.nodes[0]!.metadataEnvelope,
                },
            ],
        })) as { nodes: { metadata?: { name: string }; error?: string }[] };
        expect(reopened.nodes.map((n) => n.metadata?.name)).toEqual(['Drive', 'shared', 'inner']);
        // And the unrotated form of C, under B's old key, opens on that device only because B's previous envelope was given.
        const viaPrevious = (await fresh('driveOpenNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: C,
                    parentId: B,
                    parentKeyEpoch: 2,
                    keyEpoch: 3,
                    keyEnvelope: c.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: c.metadataEnvelope,
                },
            ],
        })) as { nodes: { metadata?: { name: string }; error?: string }[] };
        expect(viaPrevious.nodes[0]!.metadata?.name).toBe('inner');
        // The old key cannot open the new envelope: stale epoch, refused.
        const staleB = (await fresh('driveOpenNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: B,
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    keyEnvelope: rotatedB.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: b.metadataEnvelope,
                },
            ],
        })) as { nodes: { error?: string }[] };
        expect(staleB.nodes[0]!.error).toBeTruthy();

        // The guest opens the re-sealed share at the new epoch, and with the previous envelope reaches unrotated children.
        const guest = await device(GUEST, guestRoot, 'guest');
        await guest('identityOpen', { userId: GUEST, identity: guestIdentity });
        await guest('driveOpenShare', {
            workspaceId: WS,
            nodeId: B,
            keyEpoch: 9,
            granterUserId: USER,
            granterPublicKey: identity.encryptionPublicKey,
            granteeUserId: GUEST,
            shareEnvelope: rotatedB.shares[0]!.shareEnvelope,
            prevShareEnvelope: shareEnvelope,
            prevKeyEpoch: 2,
        });
        const guestSees = (await guest('driveOpenNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: C,
                    parentId: B,
                    parentKeyEpoch: 2,
                    keyEpoch: 3,
                    keyEnvelope: c.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: c.metadataEnvelope,
                },
            ],
        })) as { nodes: { metadata?: { name: string }; error?: string }[] };
        expect(guestSees.nodes[0]!.metadata?.name).toBe('inner');

        // The link re-sealed for the same secret and password opens the new key with the old salt.
        const relinked = rotatedB.links[0] as { linkEnvelope: string; secretEnvelope: string };
        const newKey = await openLinkKey(
            decode(relinked.linkEnvelope, 72),
            decode(link.secret, 32),
            'open sesame',
            decode(link.salt, 16),
            { workspaceId: WS, nodeId: B, keyEpoch: 9, linkId: LINK },
        );
        expect(newKey).toHaveLength(32);
        await expect(
            openLinkKey(
                decode(relinked.linkEnvelope, 72),
                decode(link.secret, 32),
                'wrong',
                decode(link.salt, 16),
                { workspaceId: WS, nodeId: B, keyEpoch: 9, linkId: LINK },
            ),
        ).rejects.toThrow();
        // A password link whose owner's copy predates the password key cannot be re-sealed.
        const legacy = (await owner('driveRotateNodes', {
            workspaceId: WS,
            targetEpoch: 12,
            granterUserId: USER,
            nodes: [
                {
                    id: A,
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    wrappedParentKeyEpoch: 1,
                    keyEnvelope: a.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: a.metadataEnvelope,
                    versions: [],
                    shares: [],
                    links: [{ id: LINK, hasPassword: true, secretEnvelope: null }],
                },
            ],
        })) as { nodes: { links: { unsealable?: true }[] }[] };
        expect(legacy.nodes[0]!.links[0]!.unsealable).toBe(true);
    }, 60_000);
});
