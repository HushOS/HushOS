import { describe, expect, test } from 'vitest';
import { createDeviceKey, rememberAccountKey } from './device';
import { createIdentity, openIdentitySigningKey } from './identity';
import { generateKey, wrapContentKey } from './drive';
import { openLinkKey } from './links';
import { createCryptoSession } from './session';
import { createWorkspaceGrant } from './workspace';
import { decode, encode } from './keys';
import {
    metadataSavedStatement,
    metadataStatement,
    signStatement,
    verifyStatement,
    versionResealedStatement,
    versionStatement,
} from './signatures';
import sodium from 'libsodium-wrappers';

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
                    metadata: meta('shared'),
                },
                {
                    id: C,
                    kind: 'folder',
                    parentId: B,
                    parentKeyEpoch: 2,
                    keyEpoch: 3,
                    metadata: meta('inner'),
                },
            ],
        })) as {
            nodes: {
                id: string;
                keyEnvelope: string;
                metadataEnvelope: string;
                metadataSignature: string;
            }[];
        };
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
            granteeKemPublicKey: guestIdentity.kem!.publicKey,
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
            signers: {},
            nodes: [
                {
                    id: B,
                    kind: 'folder',
                    parentId: A,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    wrappedParentKeyEpoch: 1,
                    keyEnvelope: b.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: b.metadataEnvelope,
                    metadataSigner: USER,
                    metadataSignature: b.metadataSignature,
                    // A first-release version: suite 1, its size on the row, resealed in its own
                    // suite. Written before signatures, so nobody vouched for it.
                    versions: [
                        {
                            id: VERSION,
                            objectId: OBJECT,
                            contentKeyEnvelope: contentEnvelope,
                            contentSuite: 1,
                            plaintextSize: 5,
                            signer: null,
                            signature: null,
                        },
                    ],
                    shares: [
                        {
                            id: 'share-1',
                            granteeUserId: GUEST,
                            granteePublicKey: guestIdentity.encryptionPublicKey,
                            granteeKemPublicKey: guestIdentity.kem!.publicKey,
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
                metadataSignature: string | null;
                versions: { id: string; contentKeyEnvelope: string; signature: string }[];
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
        // Everything re-sealed is signed by the account running the rotation, the old suite's
        // version included; checked with the primitives against the owner's signing key. The
        // metadata verified, so it is signed as the owner's; the unsigned version is only re-sealed.
        const owners = decode(identity.signingPublicKey, 32);
        expect(
            await verifyStatement(
                await metadataStatement(
                    { workspaceId: WS, nodeId: B, kind: 'folder', metadataVersion: 1 },
                    decode(rotatedB.metadataEnvelope),
                ),
                decode(rotatedB.metadataSignature!, 64),
                owners,
            ),
        ).toBe(true);
        const rotatedVersion = {
            workspaceId: WS,
            nodeId: B,
            versionId: VERSION,
            objectId: OBJECT,
            contentSuite: 1,
        };
        const rotatedEnvelope = decode(rotatedB.versions[0]!.contentKeyEnvelope);
        expect(
            await verifyStatement(
                await versionResealedStatement(rotatedVersion, rotatedEnvelope),
                decode(rotatedB.versions[0]!.signature, 64),
                owners,
            ),
        ).toBe(true);
        expect(
            await verifyStatement(
                await versionStatement(rotatedVersion, rotatedEnvelope),
                decode(rotatedB.versions[0]!.signature, 64),
                owners,
            ),
        ).toBe(false);
        expect(rotatedB.keyEnvelope).not.toBe(b.keyEnvelope);
        expect(rotatedB.versions[0]!.contentKeyEnvelope).not.toBe(contentEnvelope);
        expect(decode(rotatedB.versions[0]!.contentKeyEnvelope)).toHaveLength(72);
        expect(rotatedB.shares[0]!.shareEnvelope).not.toBe(shareEnvelope);
        // Re-sealed in suite 3, signed by the owner running the rotation.
        expect(decode(rotatedB.shares[0]!.shareEnvelope)).toHaveLength(1256);
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
            signers: {},
            nodes: [
                {
                    id: C,
                    kind: 'folder',
                    parentId: B,
                    parentKeyEpoch: 9,
                    keyEpoch: 3,
                    wrappedParentKeyEpoch: 2,
                    keyEnvelope: c.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: c.metadataEnvelope,
                    metadataSigner: USER,
                    metadataSignature: c.metadataSignature,
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
            granterSigningPublicKey: identity.signingPublicKey,
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
            signers: {},
            nodes: [
                {
                    id: A,
                    kind: 'folder',
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    wrappedParentKeyEpoch: 1,
                    keyEnvelope: a.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: a.metadataEnvelope,
                    metadataSigner: USER,
                    metadataSignature: a.metadataSignature,
                    versions: [],
                    shares: [],
                    links: [{ id: LINK, hasPassword: true, secretEnvelope: null }],
                },
            ],
        })) as { nodes: { links: { unsealable?: true }[] }[] };
        expect(legacy.nodes[0]!.links[0]!.unsealable).toBe(true);
    }, 60_000);

    test('a planted record stays unverified through a rotation, and nothing rotates without the trust set', async () => {
        const root = crypto.getRandomValues(new Uint8Array(32));
        const grant = await createWorkspaceGrant(root, USER, WS, 1);
        const identity = await createIdentity(root, USER);
        const owner = await device(USER, root, 'owner');
        await owner('driveOpenWorkspace', { userId: USER, grant });
        await owner('identityOpen', { userId: USER, identity });
        const created = (await owner('driveCreateNodes', {
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
                    metadata: meta('Invoices'),
                },
            ],
        })) as { nodes: { keyEnvelope: string; metadataEnvelope: string }[] };
        const b = created.nodes[1]!;
        // Someone holding the folder key renamed B and signed it as themselves, a person
        // the owner never checked; the server serves that signature.
        await sodium.ready;
        const intruder = sodium.crypto_sign_keypair();
        const INTRUDER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
        const plantedSignature = encode(
            await signStatement(
                await metadataStatement(
                    { workspaceId: WS, nodeId: B, kind: 'folder', metadataVersion: 1 },
                    decode(b.metadataEnvelope),
                ),
                intruder.privateKey,
            ),
        );
        const node = {
            id: B,
            kind: 'folder' as const,
            parentId: A,
            parentKeyEpoch: 1,
            keyEpoch: 2,
            wrappedParentKeyEpoch: 1,
            keyEnvelope: b.keyEnvelope,
            metadataVersion: 1,
            metadataEnvelope: b.metadataEnvelope,
            metadataSigner: INTRUDER,
            metadataSignature: plantedSignature,
            versions: [],
            shares: [],
            links: [],
        };
        // Without the trust set the batch is refused whole: nothing is re-signed blind.
        await expect(
            owner('driveRotateNodes', {
                workspaceId: WS,
                targetEpoch: 7,
                granterUserId: USER,
                signers: undefined as never,
                nodes: [node],
            }),
        ).rejects.toThrow(/couldn’t load/);
        const rotated = (
            (await owner('driveRotateNodes', {
                workspaceId: WS,
                targetEpoch: 7,
                granterUserId: USER,
                signers: {},
                nodes: [node],
            })) as { nodes: { metadataEnvelope: string; metadataSignature: string }[] }
        ).nodes[0]!;
        // After the rotation the owner's signature stands on it, but only as re-sealed:
        // reading it back never says verified.
        const [after] = (
            (await owner('driveVerify', {
                workspaceId: WS,
                signers: {},
                nodes: [
                    {
                        id: B,
                        kind: 'folder',
                        metadataVersion: 1,
                        metadataEnvelope: rotated.metadataEnvelope,
                        metadataSigner: USER,
                        metadataSignature: rotated.metadataSignature,
                    },
                ],
            })) as { nodes: { metadata: string }[] }
        ).nodes;
        expect(after!.metadata).toBe('resealed');
        expect(
            await verifyStatement(
                await metadataStatement(
                    { workspaceId: WS, nodeId: B, kind: 'folder', metadataVersion: 1 },
                    decode(rotated.metadataEnvelope),
                ),
                decode(rotated.metadataSignature, 64),
                decode(identity.signingPublicKey, 32),
            ),
        ).toBe(false);
    }, 60_000);

    test('a rotation keeps a copy saved from a link saved only when it verified as saved', async () => {
        const root = crypto.getRandomValues(new Uint8Array(32));
        const grant = await createWorkspaceGrant(root, USER, WS, 1);
        const identity = await createIdentity(root, USER);
        const owner = await device(USER, root, 'owner');
        await owner('driveOpenWorkspace', { userId: USER, grant });
        await owner('identityOpen', { userId: USER, identity });
        const created = (await owner('driveCreateNodes', {
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
                    metadata: meta('Saved from a link'),
                },
            ],
        })) as { nodes: { keyEnvelope: string; metadataEnvelope: string }[] };
        const b = created.nodes[1]!;
        const statement = {
            workspaceId: WS,
            nodeId: B,
            kind: 'folder' as const,
            metadataVersion: 1,
        };
        const signingKey = await openIdentitySigningKey(root, USER, identity);
        const savedByOwner = encode(
            await signStatement(
                await metadataSavedStatement(statement, decode(b.metadataEnvelope)),
                signingKey,
            ),
        );
        await sodium.ready;
        const stranger = sodium.crypto_sign_keypair();
        const savedByStranger = encode(
            await signStatement(
                await metadataSavedStatement(statement, decode(b.metadataEnvelope)),
                stranger.privateKey,
            ),
        );
        const node = (signer: string, signature: string) => ({
            id: B,
            kind: 'folder' as const,
            parentId: A,
            parentKeyEpoch: 1,
            keyEpoch: 2,
            wrappedParentKeyEpoch: 1,
            keyEnvelope: b.keyEnvelope,
            metadataVersion: 1,
            metadataEnvelope: b.metadataEnvelope,
            metadataSigner: signer,
            metadataSignature: signature,
            versions: [],
            shares: [],
            links: [],
        });
        const STRANGER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
        const verdictAfter = async (signer: string, signature: string, targetEpoch: number) => {
            const rotated = (
                (await owner('driveRotateNodes', {
                    workspaceId: WS,
                    targetEpoch,
                    granterUserId: USER,
                    signers: {},
                    nodes: [node(signer, signature)],
                })) as { nodes: { metadataEnvelope: string; metadataSignature: string }[] }
            ).nodes[0]!;
            const [after] = (
                (await owner('driveVerify', {
                    workspaceId: WS,
                    signers: {},
                    nodes: [
                        {
                            ...statement,
                            id: B,
                            metadataEnvelope: rotated.metadataEnvelope,
                            metadataSigner: USER,
                            metadataSignature: rotated.metadataSignature,
                        },
                    ],
                })) as { nodes: { metadata: string }[] }
            ).nodes;
            return after!.metadata;
        };
        // Saved by the owner: it reads as saved before, and stays saved through the rotation.
        expect(await verdictAfter(USER, savedByOwner, 7)).toBe('saved-from-link');
        // "Saved" by someone the owner never checked: that is an unknown signer, so re-sealed.
        expect(await verdictAfter(STRANGER, savedByStranger, 8)).toBe('resealed');
    }, 60_000);
});
