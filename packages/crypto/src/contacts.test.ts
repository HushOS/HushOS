import { describe, expect, test } from 'vitest';
import { createIdentity, openIdentityEncryptionKey } from './identity';
import { EMPTY_SETTINGS, fingerprint, openSettings, sealSettings, type Settings } from './contacts';
import { decode } from './keys';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

async function identityWithKey(userId = USER) {
    const root = crypto.getRandomValues(new Uint8Array(32));
    const envelope = await createIdentity(root, userId);
    const key = await openIdentityEncryptionKey(root, userId, envelope);
    return { root, envelope, key };
}

describe('fingerprints', () => {
    test('are stable for a key, differ between keys, and are ten groups of four hex digits', async () => {
        const a = await identityWithKey();
        const b = await identityWithKey();
        const first = await fingerprint(decode(a.envelope.encryptionPublicKey, 32));
        expect(first).toMatch(/^([0-9a-f]{4} ){9}[0-9a-f]{4}$/);
        expect(await fingerprint(decode(a.envelope.encryptionPublicKey, 32))).toBe(first);
        expect(await fingerprint(decode(b.envelope.encryptionPublicKey, 32))).not.toBe(first);
        await expect(fingerprint(new Uint8Array(31))).rejects.toThrow();
    });
});

describe('identity private key', () => {
    test('opens under the root it was wrapped with and refuses a swapped public key', async () => {
        const { root, envelope } = await identityWithKey();
        const swapped = {
            ...envelope,
            encryptionPublicKey: (await identityWithKey()).envelope.encryptionPublicKey,
        };
        await expect(openIdentityEncryptionKey(root, USER, swapped)).rejects.toThrow();
        await expect(openIdentityEncryptionKey(root, OTHER, envelope)).rejects.toThrow();
        const wrongRoot = crypto.getRandomValues(new Uint8Array(32));
        await expect(openIdentityEncryptionKey(wrongRoot, USER, envelope)).rejects.toThrow();
    });
});

describe('settings', () => {
    const settings: Settings = {
        version: 1,
        contacts: {
            [OTHER]: {
                userId: OTHER,
                email: 'other@hushos.test',
                name: 'Other',
                encryptionPublicKey: 'k',
                signingPublicKey: 's',
                fingerprint: 'f',
                pinnedAt: '2026-09-13T00:00:00.000Z',
            },
        },
    };

    test('round-trip under the identity key, bound to the person and the version', async () => {
        const { key } = await identityWithKey();
        const envelope = await sealSettings(key, USER, 3, settings);
        expect(await openSettings(key, USER, envelope)).toEqual(settings);
        // Another identity, another person, or a replayed older version: refused.
        const stranger = await identityWithKey(OTHER);
        await expect(openSettings(stranger.key, USER, envelope)).rejects.toThrow();
        await expect(openSettings(key, OTHER, envelope)).rejects.toThrow();
        await expect(
            openSettings(key, USER, { ...envelope, settingsVersion: 2 }),
        ).rejects.toThrow();
        // A flipped byte in the ciphertext is refused, never parsed.
        const bytes = decode(envelope.ciphertext);
        bytes[5] = bytes[5]! ^ 1;
        const tampered = { ...envelope, ciphertext: Buffer.from(bytes).toString('base64url') };
        await expect(openSettings(key, USER, tampered)).rejects.toThrow();
    });

    test('the same identity key opens settings after the root is rotated', async () => {
        const { root, envelope: identity, key } = await identityWithKey();
        const sealed = await sealSettings(key, USER, 1, EMPTY_SETTINGS);
        const { rewrapIdentity } = await import('./identity');
        const newRoot = crypto.getRandomValues(new Uint8Array(32));
        const rewrapped = await rewrapIdentity(root, newRoot, USER, identity, 2);
        const reopened = await openIdentityEncryptionKey(newRoot, USER, rewrapped);
        expect(await openSettings(reopened, USER, sealed)).toEqual(EMPTY_SETTINGS);
    });

    test('refuses a document over the size cap', async () => {
        const { key } = await identityWithKey();
        const big: Settings = { version: 1, contacts: {} };
        for (let i = 0; i < 700; i++)
            big.contacts[`u${i}`] = {
                ...settings.contacts[OTHER]!,
                userId: `u${i}`,
                name: 'x'.repeat(80),
            };
        await expect(sealSettings(key, USER, 1, big)).rejects.toThrow(/too large/);
    });
});

describe('the identity’s KEM key', () => {
    test('is minted at creation, opens under the root, and is refused when swapped', async () => {
        const { openIdentityKemKey } = await import('./identity');
        const { kemKeypair } = await import('./pq');
        const { root, envelope } = await identityWithKey();
        const opened = await openIdentityKemKey(root, USER, envelope);
        expect(opened?.publicKey).toBe(envelope.kem!.publicKey);
        expect(opened?.secretKey).toHaveLength(2400);
        const other = (await identityWithKey()).envelope.kem!;
        await expect(
            openIdentityKemKey(root, USER, {
                ...envelope,
                kem: { ...envelope.kem!, publicKey: other.publicKey },
            }),
        ).rejects.toThrow();
        await expect(openIdentityKemKey(root, OTHER, envelope)).rejects.toThrow();
        expect(await openIdentityKemKey(root, USER, { ...envelope, kem: null })).toBeNull();
        // The seed alone reproduces the pair: what a device expands, nothing else is stored.
        expect(kemKeypair(new Uint8Array(64)).publicKey).toHaveLength(1184);
    });

    test('the binding is signed by the identity and fails for another identity, user or key', async () => {
        const { verifyKemBinding } = await import('./identity');
        const a = await identityWithKey();
        const b = await identityWithKey(OTHER);
        const ok = (envelope: typeof a.envelope, userId = USER) =>
            verifyKemBinding(
                userId,
                envelope.encryptionPublicKey,
                envelope.signingPublicKey,
                envelope.kem!,
            );
        expect(await ok(a.envelope)).toBe(true);
        expect(await ok(b.envelope, OTHER)).toBe(true);
        expect(await ok(a.envelope, OTHER)).toBe(false);
        // A server that swaps in its own KEM key cannot sign for it.
        expect(
            await ok({
                ...a.envelope,
                kem: { ...a.envelope.kem!, publicKey: b.envelope.kem!.publicKey },
            }),
        ).toBe(false);
        expect(await ok({ ...a.envelope, signingPublicKey: b.envelope.signingPublicKey })).toBe(
            false,
        );
        expect(
            await ok({ ...a.envelope, encryptionPublicKey: b.envelope.encryptionPublicKey }),
        ).toBe(false);
    });

    test('an identity from before hybrid sharing gets a key that opens, verifies, and survives a rewrap', async () => {
        const { addIdentityKem, openIdentityKemKey, rewrapIdentity, verifyKemBinding } =
            await import('./identity');
        const { root, envelope } = await identityWithKey();
        const legacy = { ...envelope, kem: undefined };
        const kem = await addIdentityKem(root, USER, legacy);
        const upgraded = { ...legacy, kem };
        expect(
            await verifyKemBinding(
                USER,
                upgraded.encryptionPublicKey,
                upgraded.signingPublicKey,
                kem,
            ),
        ).toBe(true);
        expect((await openIdentityKemKey(root, USER, upgraded))?.publicKey).toBe(kem.publicKey);
        await expect(addIdentityKem(root, USER, upgraded)).rejects.toThrow();
        // Master-key rotation rewraps the seed under the new root; the public key and signature stay.
        const nextRoot = crypto.getRandomValues(new Uint8Array(32));
        const rewrapped = await rewrapIdentity(root, nextRoot, USER, upgraded, 2);
        expect(rewrapped.kem?.publicKey).toBe(kem.publicKey);
        expect(rewrapped.kem?.signature).toBe(kem.signature);
        expect(rewrapped.kem?.encryptedSeed).not.toBe(kem.encryptedSeed);
        expect((await openIdentityKemKey(nextRoot, USER, rewrapped))?.publicKey).toBe(
            kem.publicKey,
        );
        await expect(openIdentityKemKey(root, USER, rewrapped)).rejects.toThrow();
    });
});
