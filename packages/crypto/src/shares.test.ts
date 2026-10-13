import { describe, expect, test } from 'vitest';
import { createDeviceKey, rememberAccountKey } from './device';
import {
    createIdentity,
    openIdentityEncryptionKey,
    openIdentityKemKey,
    openIdentitySigningKey,
} from './identity';
import sodium from 'libsodium-wrappers';
import { encryptKey } from './aead';
import { hybridKey } from './hybrid';
import { KEM_CIPHERTEXT_BYTES, kemEncapsulate } from './pq';
import {
    openShareKey,
    sealShareKey,
    shareContext,
    SIGNED_SHARE_ENVELOPE_BYTES,
    type ShareContext,
} from './shares';
import { createCryptoSession } from './session';
import { createWorkspaceGrant } from './workspace';
import { decode } from './keys';

/*
 * A share opens for the person it was sealed to, under the context it was
 * sealed with, from the person who signed it, and for nobody and nothing else.
 * Suite 3 is the only one sealed or opened: suites 1 and 2, whose static key
 * agreement a stolen granter key opened, are refused even when genuine. The
 * session test runs the whole exchange: the owner seals a folder key to a
 * contact, the contact opens it and reads the folder's children, and cannot
 * climb above the folder.
 */

const WS = '22222222-2222-4222-8222-222222222222';
const ids = ['a', 'b', 'c', 'd', 'e'].map(
    (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`,
);
const [ROOT, SHARED, CHILD, OWNER, GUEST] = ids as [string, string, string, string, string];
const meta = (name: string) => ({ name, mime: null, size: null, modified: null });
const ctx: ShareContext = {
    workspaceId: WS,
    nodeId: SHARED,
    keyEpoch: 3,
    granteeUserId: GUEST,
    granterUserId: OWNER,
};

/* The share context as suites 1 and 2 bound it. */
const legacyContext = (ctx: ShareContext, suite: 1 | 2) =>
    new TextEncoder().encode(
        new TextDecoder()
            .decode(shareContext(ctx))
            .replace('"hushos/drive/share",3,', `"hushos/drive/share",${suite},`),
    );

/* Suite 1 as clients made them before shares went hybrid: genuine, and refused. */
async function suite1Envelope(
    nodeKey: Uint8Array,
    granteePublicKey: Uint8Array,
    granterPrivateKey: Uint8Array,
    ctx: ShareContext,
) {
    await sodium.ready;
    const pair = sodium.crypto_box_beforenm(granteePublicKey, granterPrivateKey);
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const body = await encryptKey(nodeKey, pair, nonce, legacyContext(ctx, 1));
    return new Uint8Array([...nonce, ...body]);
}

/* Suite 2 as clients made them before shares were signed: the static pair key and ML-KEM. */
async function suite2Envelope(
    nodeKey: Uint8Array,
    grantee: { encryptionPublicKey: Uint8Array; kemPublicKey: Uint8Array },
    granterPrivateKey: Uint8Array,
    ctx: ShareContext,
) {
    await sodium.ready;
    const pair = sodium.crypto_box_beforenm(
        grantee.encryptionPublicKey,
        granterPrivateKey,
    ) as Uint8Array<ArrayBuffer>;
    const { ciphertext, sharedSecret } = kemEncapsulate(grantee.kemPublicKey);
    const key = await hybridKey(pair, sharedSecret, ciphertext, 'hushos/drive/share-key/v2');
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const body = await encryptKey(nodeKey, key, nonce, legacyContext(ctx, 2));
    return new Uint8Array([...nonce, ...ciphertext, ...body]);
}

/* An account's identity, opened the way the worker opens it. */
async function account(userId: string) {
    const root = crypto.getRandomValues(new Uint8Array(32));
    const envelope = await createIdentity(root, userId);
    return {
        envelope,
        privateKey: await openIdentityEncryptionKey(root, userId, envelope),
        signingKey: await openIdentitySigningKey(root, userId, envelope),
        kem: (await openIdentityKemKey(root, userId, envelope))!,
        publicKey: decode(envelope.encryptionPublicKey, 32),
        signingPublicKey: decode(envelope.signingPublicKey, 32),
        kemPublicKey: decode(envelope.kem!.publicKey, 1184),
    };
}
type Account = Awaited<ReturnType<typeof account>>;
const keysOf = (who: Account) => ({
    encryptionPublicKey: who.publicKey,
    kemPublicKey: who.kemPublicKey,
});
const secretsOf = (who: Account) => ({
    privateKey: who.privateKey,
    kemSecretKey: who.kem.secretKey,
});
/* What a share opens against: the granter's current signing key, as pinned. */
const granterOf = (who: Account) => who.signingPublicKey;

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

describe('share suite 3', () => {
    test('opens for the grantee, from the granter who signed it, under the sealed context', async () => {
        const [owner, guest] = await Promise.all([account(OWNER), account(GUEST)]);
        const nodeKey = crypto.getRandomValues(new Uint8Array(32));
        const envelope = await sealShareKey(nodeKey, keysOf(guest), owner.signingKey, ctx);
        expect(envelope).toHaveLength(SIGNED_SHARE_ENVELOPE_BYTES);
        expect(envelope).toHaveLength(1256);
        expect(await openShareKey(envelope, granterOf(owner), secretsOf(guest), ctx)).toEqual(
            nodeKey,
        );
        // Each share has its own ephemeral key: sealing again shares nothing with the first.
        const again = await sealShareKey(nodeKey, keysOf(guest), owner.signingKey, ctx);
        expect(again.subarray(0, 32)).not.toEqual(envelope.subarray(0, 32));
        // Nothing is sealed to X25519 alone.
        await expect(
            sealShareKey(nodeKey, { ...keysOf(guest), kemPublicKey: null }, owner.signingKey, ctx),
        ).rejects.toThrow(/no post-quantum key/);
    });

    test('is refused, before anything is decapsulated, unless the pinned granter signed it', async () => {
        const [owner, guest, intruder] = await Promise.all([
            account(OWNER),
            account(GUEST),
            account(CHILD),
        ]);
        const nodeKey = crypto.getRandomValues(new Uint8Array(32));
        const envelope = await sealShareKey(nodeKey, keysOf(guest), owner.signingKey, ctx);
        // Checked before decapsulating: a grantee holding no KEM key still learns it is unsigned.
        const noKem = { ...secretsOf(guest), kemSecretKey: null };
        await expect(openShareKey(envelope, granterOf(intruder), noKem, ctx)).rejects.toThrow(
            'not signed',
        );
        await expect(openShareKey(envelope, granterOf(owner), noKem, ctx)).rejects.toThrow(
            /does not hold/,
        );
        // Someone else (the server, holding only public keys) seals a key of their choosing
        // to the grantee in the granter's name: the pinned key refuses it.
        const planted = await sealShareKey(
            crypto.getRandomValues(new Uint8Array(32)),
            keysOf(guest),
            intruder.signingKey,
            ctx,
        );
        await expect(
            openShareKey(planted, granterOf(owner), secretsOf(guest), ctx),
        ).rejects.toThrow('not signed');
        // Every byte the signature covers: the ephemeral key, the KEM ciphertext, the nonce, the
        // body; and a flipped signature.
        for (const at of [0, 32 + 5, 32 + KEM_CIPHERTEXT_BYTES + 3, 1192 - 1, 1255]) {
            const tampered = envelope.slice();
            tampered[at]! ^= 1;
            await expect(
                openShareKey(tampered, granterOf(owner), secretsOf(guest), ctx),
            ).rejects.toThrow('not signed');
        }
        // The context is in the signed statement: another epoch, node, grantee or granter.
        for (const change of [
            { keyEpoch: 4 },
            { nodeId: CHILD },
            { granteeUserId: CHILD },
            { granterUserId: GUEST },
        ])
            await expect(
                openShareKey(envelope, granterOf(owner), secretsOf(guest), { ...ctx, ...change }),
            ).rejects.toThrow('not signed');
        // The granter's X25519 key is no signing key: nothing opens without the right one.
        await expect(
            openShareKey(envelope, new Uint8Array(0), secretsOf(guest), ctx),
        ).rejects.toThrow(/needs the key/);
        await expect(
            openShareKey(envelope, owner.publicKey, secretsOf(guest), ctx),
        ).rejects.toThrow('not signed');
    });

    test('needs both of the grantee’s private halves, and only the grantee’s', async () => {
        const [owner, guest, stranger] = await Promise.all([
            account(OWNER),
            account(GUEST),
            account(CHILD),
        ]);
        const nodeKey = crypto.getRandomValues(new Uint8Array(32));
        const envelope = await sealShareKey(nodeKey, keysOf(guest), owner.signingKey, ctx);
        for (const secrets of [
            secretsOf(stranger),
            { ...secretsOf(guest), privateKey: stranger.privateKey },
            { ...secretsOf(guest), kemSecretKey: stranger.kem.secretKey },
        ])
            await expect(openShareKey(envelope, granterOf(owner), secrets, ctx)).rejects.toThrow(
                'could not be opened',
            );
        // A key stolen from the granter opens none of their shares: sealing used no secret of
        // theirs but the signing key, and the body key comes from the grantee's halves.
        await expect(
            openShareKey(
                envelope,
                granterOf(owner),
                { privateKey: owner.privateKey, kemSecretKey: owner.kem.secretKey },
                ctx,
            ),
        ).rejects.toThrow('could not be opened');
    });
});

describe('older share suites', () => {
    test('suites 1 and 2 no longer open, even genuine ones from the pinned granter to the grantee', async () => {
        const [owner, guest] = await Promise.all([account(OWNER), account(GUEST)]);
        const nodeKey = crypto.getRandomValues(new Uint8Array(32));
        const one = await suite1Envelope(nodeKey, guest.publicKey, owner.privateKey, ctx);
        const two = await suite2Envelope(nodeKey, keysOf(guest), owner.privateKey, ctx);
        expect([one.length, two.length]).toEqual([72, 1160]);
        // A static agreement that a stolen granter key reproduces: refused by length, whoever asks.
        for (const envelope of [one, two])
            await expect(
                openShareKey(envelope, granterOf(owner), secretsOf(guest), ctx),
            ).rejects.toThrow('Invalid share envelope');
        await expect(
            openShareKey(two.subarray(0, 100), granterOf(owner), secretsOf(guest), ctx),
        ).rejects.toThrow('Invalid share envelope');
    });

    test('a share signed with a key the granter has since replaced does not open against the current one', async () => {
        const [earlier, current, guest] = await Promise.all([
            account(OWNER),
            account(OWNER),
            account(GUEST),
        ]);
        const nodeKey = crypto.getRandomValues(new Uint8Array(32));
        const envelope = await sealShareKey(nodeKey, keysOf(guest), earlier.signingKey, ctx);
        await expect(
            openShareKey(envelope, granterOf(current), secretsOf(guest), ctx),
        ).rejects.toThrow('not signed');
    });
});

describe('shares through the session', () => {
    test('through the session: the contact reads the shared folder and nothing above it', async () => {
        const owner = await person(OWNER);
        const guest = await person(GUEST);
        const grant = await createWorkspaceGrant(owner.root, OWNER, WS, 1);
        await owner.call('driveOpenWorkspace', { userId: OWNER, grant });
        const created = (await owner.call('driveCreateNodes', {
            workspaceId: WS,
            nodes: [
                {
                    id: ROOT,
                    kind: 'folder',
                    parentId: WS,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    metadata: meta('Drive'),
                },
                {
                    id: SHARED,
                    kind: 'folder',
                    parentId: ROOT,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    metadata: meta('Project'),
                },
                {
                    id: CHILD,
                    kind: 'file',
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
        expect(decode(shareEnvelope)).toHaveLength(SIGNED_SHARE_ENVELOPE_BYTES);
        // A stale epoch is refused before anything is sealed.
        await expect(
            owner.call('driveSealShare', {
                workspaceId: WS,
                nodeId: SHARED,
                keyEpoch: 9,
                granterUserId: OWNER,
                granteeUserId: GUEST,
                granteePublicKey: guest.identity.encryptionPublicKey,
                granteeKemPublicKey: guest.identity.kem!.publicKey,
            }),
        ).rejects.toThrow(/changed/);

        const open = {
            workspaceId: WS,
            nodeId: SHARED,
            keyEpoch: 2,
            granterUserId: OWNER,
            granterSigningPublicKey: owner.identity.signingPublicKey,
            granteeUserId: GUEST,
            shareEnvelope,
        };
        // A signing key the pin does not hold (a dishonest server's) does not open it.
        const third = await person(CHILD);
        await expect(
            guest.call('driveOpenShare', {
                ...open,
                granterSigningPublicKey: third.identity.signingPublicKey,
            }),
        ).rejects.toThrow('not signed');
        await expect(
            guest.call('driveOpenShare', { ...open, granterSigningPublicKey: '' }),
        ).rejects.toThrow(/needs the key/);
        await guest.call('driveOpenShare', open);
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
        // Somebody else cannot open it, even naming themselves the grantee.
        await expect(
            third.call('driveOpenShare', { ...open, granteeUserId: CHILD }),
        ).rejects.toThrow();
    });
});
