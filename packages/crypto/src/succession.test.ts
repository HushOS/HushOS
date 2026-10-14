import { describe, expect, test } from 'vitest';
import { createDeviceKey, rememberAccountKey } from './device';
import {
    createIdentity,
    createSuccessor,
    openIdentityEncryptionKey,
    openIdentityMlDsaKey,
    openIdentitySigningKey,
    rewrapIdentity,
    verifySuccessionChain,
    verifySuccessionLink,
    type IdentityEnvelope,
    type SuccessionLink,
} from './identity';
import { createCryptoSession } from './session';
import { createWorkspaceGrant } from './workspace';
import { decode, encode } from './keys';
import { keyDigest } from './fingerprint';
import { signHybrid, signStatement, successionStatement } from './signatures';

/*
 * An identity is replaced by minting the next one under the same root and
 * signing the change with the old identity's hybrid signature (Ed25519 and
 * ML-DSA-65, docs/identity-pq-design.md 2). A contact follows a chain of
 * such links from the keys they pinned to the keys served, and anything but an
 * unbroken chain signed link by link is a changed key. The account's devices
 * keep the earlier private keys, because shares sealed to them open with
 * nothing else.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const FRIEND = '33333333-3333-4333-8333-333333333333';
const WS = '22222222-2222-4222-8222-222222222222';
const ids = ['a', 'b', 'c'].map(
    (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`,
);
const [A, B, C] = ids as [string, string, string];

/* The link the server would serve for a succession from `old` to `next`, with its signature. */
function linkOf(old: IdentityEnvelope, next: IdentityEnvelope, signature: string): SuccessionLink {
    return {
        oldKeyVersion: old.keyVersion,
        newKeyVersion: next.keyVersion,
        oldEncryptionPublicKey: old.encryptionPublicKey,
        oldSigningPublicKey: old.signingPublicKey,
        oldMlDsaPublicKey: old.mlDsa!.publicKey,
        newEncryptionPublicKey: next.encryptionPublicKey,
        newSigningPublicKey: next.signingPublicKey,
        newMlDsaPublicKey: next.mlDsa!.publicKey,
        newKemPublicKey: next.kem!.publicKey,
        signature,
    };
}

/* Both private halves of an identity's signature, opened under its root. */
async function keysOf(root: Uint8Array<ArrayBuffer>, userId: string, identity: IdentityEnvelope) {
    return {
        signingKey: await openIdentitySigningKey(root, userId, identity),
        mlDsaSecretKey: (await openIdentityMlDsaKey(root, userId, identity))!.secretKey,
    };
}
/* The keys a version 3 pin holds of an identity. */
async function pinOf(identity: IdentityEnvelope, keyVersion: number | null = identity.keyVersion) {
    return {
        keyVersion,
        encryptionPublicKey: identity.encryptionPublicKey,
        signingPublicKey: identity.signingPublicKey,
        mlDsaPublicKeyHash: await keyDigest(decode(identity.mlDsa!.publicKey)),
    };
}
/* The keys the server serves for an identity. */
function servedOf(identity: IdentityEnvelope, keyVersion = identity.keyVersion) {
    return {
        keyVersion,
        encryptionPublicKey: identity.encryptionPublicKey,
        signingPublicKey: identity.signingPublicKey,
        mlDsaPublicKey: identity.mlDsa!.publicKey,
        kemPublicKey: identity.kem!.publicKey,
    };
}
const signerOf = (identity: IdentityEnvelope) => ({
    signingPublicKey: identity.signingPublicKey,
    mlDsaPublicKey: identity.mlDsa!.publicKey,
});

/* Three generations of one account's identity: v1 pinned by a contact, v3 served now. */
async function generations() {
    const root = crypto.getRandomValues(new Uint8Array(32));
    const first = await createIdentity(root, USER);
    const second = await createSuccessor(root, USER, first, await keysOf(root, USER, first));
    const third = await createSuccessor(
        root,
        USER,
        second.identity,
        await keysOf(root, USER, second.identity),
    );
    const links = [
        linkOf(first, second.identity, second.signature),
        linkOf(second.identity, third.identity, third.signature),
    ];
    const pinned = await pinOf(first);
    const served = servedOf(third.identity);
    return { root, first, second, third, links, pinned, served };
}

describe('succession', () => {
    test('mints fresh keys at the next version, vouched for by both old signing keys', async () => {
        const root = crypto.getRandomValues(new Uint8Array(32));
        const first = await createIdentity(root, USER);
        const { identity, signature } = await createSuccessor(
            root,
            USER,
            first,
            await keysOf(root, USER, first),
        );
        expect(identity.keyVersion).toBe(first.keyVersion + 1);
        expect(identity.encryptionPublicKey).not.toBe(first.encryptionPublicKey);
        expect(identity.signingPublicKey).not.toBe(first.signingPublicKey);
        expect(identity.mlDsa!.publicKey).not.toBe(first.mlDsa!.publicKey);
        expect(identity.kem!.publicKey).not.toBe(first.kem!.publicKey);
        // The new identity is the account's own: it opens under the same root.
        await expect(openIdentityEncryptionKey(root, USER, identity)).resolves.toHaveLength(32);
        const link = linkOf(first, identity, signature);
        expect(decode(signature)).toHaveLength(3373);
        expect(await verifySuccessionLink(USER, link, signerOf(first))).toBe(true);
        // Bound to the account, and to the new ML-DSA and KEM keys as much as the others.
        expect(await verifySuccessionLink(FRIEND, link, signerOf(first))).toBe(false);
        const other = await createIdentity(root, USER);
        expect(
            await verifySuccessionLink(
                USER,
                { ...link, newKemPublicKey: other.kem!.publicKey },
                signerOf(first),
            ),
        ).toBe(false);
        expect(
            await verifySuccessionLink(
                USER,
                { ...link, newMlDsaPublicKey: other.mlDsa!.publicKey },
                signerOf(first),
            ),
        ).toBe(false);
        // A signing key that is not the current identity's vouches for nothing.
        const stranger = await createIdentity(root, FRIEND);
        await expect(
            createSuccessor(root, USER, first, await keysOf(root, FRIEND, stranger)),
        ).rejects.toThrow('Identity keys do not match');
    });

    test('a succession signed with Ed25519 alone, or with either half broken, does not hold', async () => {
        const root = crypto.getRandomValues(new Uint8Array(32));
        const first = await createIdentity(root, USER);
        const { identity, signature } = await createSuccessor(
            root,
            USER,
            first,
            await keysOf(root, USER, first),
        );
        const link = linkOf(first, identity, signature);
        const bytes = decode(signature);
        // The Ed25519 half alone, as a stripped signature: the statement is a hybrid one.
        const stripped = encode(bytes.slice(0, 64));
        expect(
            await verifySuccessionLink(USER, { ...link, signature: stripped }, signerOf(first)),
        ).toBe(false);
        // A valid Ed25519 signature over the statement on its own, the way version 1 signed.
        const classical = encode(
            await signStatement(
                await successionStatement({ ...link, userId: USER }),
                await openIdentitySigningKey(root, USER, first),
            ),
        );
        expect(
            await verifySuccessionLink(USER, { ...link, signature: classical }, signerOf(first)),
        ).toBe(false);
        // One half broken, the other intact, each way round.
        for (const at of [5, 64 + 100]) {
            const broken = bytes.slice();
            broken[at]! ^= 1;
            expect(
                await verifySuccessionLink(
                    USER,
                    { ...link, signature: encode(broken) },
                    signerOf(first),
                ),
            ).toBe(false);
        }
    });

    test('a chain holds from the pinned keys to the served ones, and nothing else does', async () => {
        const { root, first, second, third, links, pinned, served } = await generations();
        expect(await verifySuccessionChain(USER, pinned, served, links)).toBe(true);
        // A pin made with no version: the chain is found from its keys.
        expect(
            await verifySuccessionChain(USER, { ...pinned, keyVersion: null }, served, links),
        ).toBe(true);
        // A pin at v2 needs only the second link; links before it are not the start.
        const fromSecond = await pinOf(second.identity);
        expect(await verifySuccessionChain(USER, fromSecond, served, links.slice(1))).toBe(true);
        // Links before the pinned keys are not part of the chain; the chain starts at them.
        expect(await verifySuccessionChain(USER, fromSecond, served, links)).toBe(true);

        // A server that mints its own v3 and signs the link with keys it holds: v2's keys did not sign.
        const forged = await createIdentity(root, USER, 3);
        const unsigned = linkOf(second.identity, forged, '');
        const ownSignature = encode(
            await signHybrid(
                await successionStatement({ ...unsigned, userId: USER }),
                await keysOf(root, USER, forged),
            ),
        );
        const forgedServed = servedOf(forged);
        expect(
            await verifySuccessionChain(USER, pinned, forgedServed, [
                links[0]!,
                { ...unsigned, signature: ownSignature },
            ]),
        ).toBe(false);
        // The real chain does not vouch for keys the server serves beside it.
        for (const change of [
            // A served version below the chain's end: a rollback.
            { keyVersion: 2 },
            { encryptionPublicKey: forged.encryptionPublicKey },
            { signingPublicKey: forged.signingPublicKey },
            { mlDsaPublicKey: forged.mlDsa!.publicKey },
            { kemPublicKey: forged.kem!.publicKey },
        ])
            expect(await verifySuccessionChain(USER, pinned, { ...served, ...change }, links)).toBe(
                false,
            );
        // A gap, links out of order, a flipped signature, a fork, or no chain at all.
        expect(await verifySuccessionChain(USER, pinned, served, links.slice(1))).toBe(false);
        expect(await verifySuccessionChain(USER, pinned, served, [links[1]!, links[0]!])).toBe(
            false,
        );
        const flipped = decode(links[1]!.signature);
        flipped[3]! ^= 1;
        expect(
            await verifySuccessionChain(USER, pinned, served, [
                links[0]!,
                { ...links[1]!, signature: Buffer.from(flipped).toString('base64url') },
            ]),
        ).toBe(false);
        const branch = linkOf(first, third.identity, links[1]!.signature);
        expect(await verifySuccessionChain(USER, pinned, served, [branch])).toBe(false);
        expect(await verifySuccessionChain(USER, pinned, served, [])).toBe(false);
        // Another account's id under the same links.
        expect(await verifySuccessionChain(FRIEND, pinned, served, links)).toBe(false);
    });

    test('a chain never verifies a half under an ML-DSA key the pin did not name', async () => {
        const { root, first, second, third, links, pinned, served } = await generations();
        // A quantum forger of Ed25519: the pinned X25519 and Ed25519 keys with an ML-DSA key of
        // their own. The Ed25519 half is made with the real key (as a forger could), the ML-DSA
        // half with theirs, and the link names theirs as the old one.
        const forger = await createIdentity(root, USER, 2);
        const forgerKeys = await keysOf(root, USER, forger);
        const realEd = await openIdentitySigningKey(root, USER, first);
        const statementOf = async (link: Omit<SuccessionLink, 'signature'>) =>
            successionStatement({ ...link, userId: USER });
        const hijack = {
            ...linkOf(first, forger, ''),
            oldMlDsaPublicKey: forger.mlDsa!.publicKey,
        };
        const half = await signHybrid(await statementOf(hijack), {
            signingKey: realEd,
            mlDsaSecretKey: forgerKeys.mlDsaSecretKey,
        });
        // Both halves verify under the keys the link itself names...
        expect(
            await verifySuccessionLink(
                USER,
                { ...hijack, signature: encode(half) },
                {
                    signingPublicKey: first.signingPublicKey,
                    mlDsaPublicKey: forger.mlDsa!.publicKey,
                },
            ),
        ).toBe(true);
        // ...but the chain starts only where the pin's ML-DSA digest matches, so it never starts.
        expect(
            await verifySuccessionChain(USER, pinned, servedOf(forger), [
                { ...hijack, signature: encode(half) },
            ]),
        ).toBe(false);
        // A later link whose old ML-DSA key is not the previous link's new one breaks the chain,
        // even under a signature valid for the keys that link names.
        const swapped = {
            ...linkOf(second.identity, third.identity, ''),
            oldMlDsaPublicKey: forger.mlDsa!.publicKey,
        };
        const swappedSignature = await signHybrid(await statementOf(swapped), {
            signingKey: await openIdentitySigningKey(root, USER, second.identity),
            mlDsaSecretKey: forgerKeys.mlDsaSecretKey,
        });
        expect(
            await verifySuccessionChain(USER, pinned, served, [
                links[0]!,
                { ...swapped, signature: encode(swappedSignature) },
            ]),
        ).toBe(false);
    });

    test('a version raised by a rotation between two links leaves the chain whole', async () => {
        const { root, first, second, pinned } = await generations();
        // A master-key rotation lifted v2 to the root's revision, 4, before the next succession.
        const raised = { ...second.identity, keyVersion: 4 };
        const secondKeys = await keysOf(root, USER, second.identity);
        const next = await createSuccessor(root, USER, raised, secondKeys);
        expect(next.identity.keyVersion).toBe(5);
        const links = [
            linkOf(first, second.identity, second.signature),
            linkOf(raised, next.identity, next.signature),
        ];
        const served = servedOf(next.identity, 5);
        expect(await verifySuccessionChain(USER, pinned, served, links)).toBe(true);
        // Raised again by a later rotation, the served version may be above the last link's.
        expect(await verifySuccessionChain(USER, pinned, { ...served, keyVersion: 6 }, links)).toBe(
            true,
        );
        // But versions never fall back along the chain, even under good signatures.
        const lowered = { ...second.identity, keyVersion: 1 };
        const back = await createSuccessor(root, USER, lowered, secondKeys);
        const fallen = [links[0]!, linkOf(lowered, back.identity, back.signature)];
        expect(await verifySuccessionLink(USER, fallen[1]!, signerOf(second.identity))).toBe(true);
        expect(await verifySuccessionChain(USER, pinned, servedOf(back.identity, 2), fallen)).toBe(
            false,
        );
    });

    test('a master-key rotation keeps each identity’s key version and opens it under the new root', async () => {
        const { root, second } = await generations();
        const next = crypto.getRandomValues(new Uint8Array(32));
        const rewrapped = await rewrapIdentity(root, next, USER, second.identity);
        expect(rewrapped.keyVersion).toBe(2);
        expect(rewrapped.signingPublicKey).toBe(second.identity.signingPublicKey);
        expect(rewrapped.mlDsa!.publicKey).toBe(second.identity.mlDsa!.publicKey);
        expect(rewrapped.keysSignature).toBe(second.identity.keysSignature);
        await expect(openIdentityEncryptionKey(next, USER, rewrapped)).resolves.toHaveLength(32);
        // The ML-DSA seed moves with the rest and still opens to the same key.
        const mlDsa = await openIdentityMlDsaKey(next, USER, rewrapped);
        expect(mlDsa!.publicKey).toBe(second.identity.mlDsa!.publicKey);
        await expect(openIdentityMlDsaKey(root, USER, rewrapped)).rejects.toThrow();
        await expect(openIdentityEncryptionKey(root, USER, rewrapped)).rejects.toThrow();
    });
});

async function device(userId: string, root: Uint8Array<ArrayBuffer>) {
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
    return call;
}
const meta = (name: string) => ({ name, mime: null, size: null, modified: null });

describe('succession in the worker', () => {
    test('a device succeeds, then still opens what was shared to its earlier keys, and what they signed is only a retired key', async () => {
        const root = crypto.getRandomValues(new Uint8Array(32));
        const first = await createIdentity(root, USER);
        const me = await device(USER, root);
        await me('identityOpen', { userId: USER, identity: first });

        // A friend shares a folder to the first identity.
        const friendRoot = crypto.getRandomValues(new Uint8Array(32));
        const friendIdentity = await createIdentity(friendRoot, FRIEND);
        const friend = await device(FRIEND, friendRoot);
        await friend('identityOpen', { userId: FRIEND, identity: friendIdentity });
        await friend('driveOpenWorkspace', {
            userId: FRIEND,
            grant: await createWorkspaceGrant(friendRoot, FRIEND, WS, 1),
        });
        await friend('driveCreateNodes', {
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
                    metadata: meta('Shared'),
                },
            ],
        });
        const { shareEnvelope } = (await friend('driveSealShare', {
            workspaceId: WS,
            nodeId: B,
            keyEpoch: 2,
            granterUserId: FRIEND,
            granteeUserId: USER,
            granteePublicKey: first.encryptionPublicKey,
            granteeKemPublicKey: first.kem!.publicKey,
        })) as { shareEnvelope: string };

        // My own record, signed by the first identity.
        await me('driveOpenWorkspace', {
            userId: USER,
            grant: await createWorkspaceGrant(root, USER, C, 1),
        });
        const mine = (await me('driveCreateNodes', {
            workspaceId: C,
            nodes: [
                {
                    id: A,
                    kind: 'folder',
                    parentId: C,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    metadata: meta('Drive'),
                },
            ],
        })) as { nodes: { metadataEnvelope: string; metadataSignature: string }[] };

        // Succeed: the worker mints and signs, installs nothing.
        const { identity: second, signature } = (await me('identitySucceed', {
            userId: USER,
            identity: first,
        })) as { identity: IdentityEnvelope; signature: string };
        expect(second.keyVersion).toBe(2);
        expect(
            await verifySuccessionLink(USER, linkOf(first, second, signature), signerOf(first)),
        ).toBe(true);
        expect(
            (
                (await me('identityOpen', { userId: USER, identity: first })) as {
                    keyVersion: number;
                }
            ).keyVersion,
        ).toBe(1);
        // A stale envelope (not the open identity) cannot be succeeded.
        await expect(me('identitySucceed', { userId: USER, identity: second })).rejects.toThrow(
            'Open your identity first',
        );

        // The server took it: the device opens the new identity with the old one as history.
        const reopened = (await me('identityOpen', {
            userId: USER,
            identity: second,
            history: [first],
            refresh: true,
        })) as { keyVersion: number; history: { keyVersion: number }[] };
        expect(reopened.keyVersion).toBe(2);
        expect(reopened.history.map((earlier) => earlier.keyVersion)).toEqual([1]);
        // History must be older than the current identity, oldest first.
        await expect(
            me('identityOpen', { userId: USER, identity: first, history: [second], refresh: true }),
        ).rejects.toThrow('out of order');

        const open = {
            workspaceId: WS,
            nodeId: B,
            keyEpoch: 2,
            granterUserId: FRIEND,
            granterSigningPublicKey: friendIdentity.signingPublicKey,
            granterMlDsaPublicKey: friendIdentity.mlDsa!.publicKey,
            granteeUserId: USER,
            shareEnvelope,
        };
        // Named by version, the earlier identity opens it; naming the current one does not.
        await expect(me('driveOpenShare', { ...open, granteeKeyVersion: 2 })).rejects.toThrow();
        await expect(me('driveOpenShare', { ...open, granteeKeyVersion: 7 })).rejects.toThrow(
            'does not hold',
        );
        await me('driveOpenShare', { ...open, granteeKeyVersion: 1 });
        // Unnamed, the worker tries the current identity and then the earlier ones.
        const fresh = await device(USER, root);
        await fresh('identityOpen', { userId: USER, identity: second, history: [first] });
        await fresh('driveOpenShare', open);

        // The friend replaces their keys: the share their first key signed waits for them to
        // seal it again, and does not open against the key they hold now.
        const { identity: friendSecond } = (await friend('identitySucceed', {
            userId: FRIEND,
            identity: friendIdentity,
        })) as { identity: IdentityEnvelope };
        const later = await device(USER, root);
        await later('identityOpen', { userId: USER, identity: second, history: [first] });
        await expect(
            later('driveOpenShare', {
                ...open,
                granterSigningPublicKey: friendSecond.signingPublicKey,
                granterMlDsaPublicKey: friendSecond.mlDsa!.publicKey,
            }),
        ).rejects.toThrow('not signed');

        // What the first identity signed is this account's, under a key it has replaced:
        // replaced because it may be exposed, so it vouches for nothing any more.
        const verified = (await me('driveVerify', {
            workspaceId: C,
            signers: {},
            nodes: [
                {
                    id: A,
                    kind: 'folder',
                    metadataVersion: 1,
                    metadataEnvelope: mine.nodes[0]!.metadataEnvelope,
                    metadataSigner: USER,
                    metadataSignature: mine.nodes[0]!.metadataSignature,
                },
            ],
        })) as { nodes: { metadata: string }[] };
        expect(verified.nodes[0]!.metadata).toBe('retired-key');
        // And it no longer signs: new writes carry the second identity's signature.
        const renamed = (await me('driveSealMetadata', {
            workspaceId: C,
            nodeId: A,
            kind: 'folder',
            metadataVersion: 2,
            metadata: meta('Drive'),
        })) as { metadataEnvelope: string; metadataSignature: string };
        const { metadataStatement, verifyStatement } = await import('./signatures');
        const statement = await metadataStatement(
            { workspaceId: C, nodeId: A, kind: 'folder', metadataVersion: 2 },
            decode(renamed.metadataEnvelope),
        );
        const signatureBytes = decode(renamed.metadataSignature, 64);
        expect(
            await verifyStatement(statement, signatureBytes, decode(second.signingPublicKey, 32)),
        ).toBe(true);
        expect(
            await verifyStatement(statement, signatureBytes, decode(first.signingPublicKey, 32)),
        ).toBe(false);

        // A contact checks the chain without unlocking anything.
        const chain = (await friend('identityVerifyChain', {
            userId: USER,
            pinned: await pinOf(first),
            served: servedOf(second),
            links: [linkOf(first, second, signature)],
        })) as { valid: boolean };
        expect(chain.valid).toBe(true);
    });
});
