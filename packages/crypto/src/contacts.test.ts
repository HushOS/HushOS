import { describe, expect, test } from 'vitest';
import { createIdentity, openIdentityEncryptionKey, verifyIdentitySigningKey } from './identity';
import {
    createSettingsKey,
    EMPTY_SETTINGS,
    fingerprint,
    openSettings,
    openSettingsKey,
    rewrapSettingsKey,
    sealSettings,
    SETTINGS_PAD_STEP,
    type Settings,
    type SettingsEnvelope,
} from './contacts';
import { encryptKey } from './aead';
import { decode, encode } from './keys';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/*
 * Settings version 1 as clients sealed them before the settings key: under
 * HKDF of the identity's X25519 private key. Nothing seals these now; they open.
 */
async function legacySettings(
    identityPrivateKey: Uint8Array<ArrayBuffer>,
    userId: string,
    settingsVersion: number,
    settings: Settings,
): Promise<SettingsEnvelope> {
    const base = await crypto.subtle.importKey('raw', identityPrivateKey, 'HKDF', false, [
        'deriveBits',
    ]);
    const key = new Uint8Array(
        await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new Uint8Array(32),
                info: new TextEncoder().encode('hushos/settings/v1'),
            },
            base,
            256,
        ),
    );
    const json = new TextEncoder().encode(JSON.stringify(settings));
    const plaintext = new Uint8Array(Math.ceil(json.length / 1024) * 1024).fill(0x20);
    plaintext.set(json);
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const aad = new TextEncoder().encode(
        JSON.stringify(['hushos/settings', 1, userId.toLowerCase(), settingsVersion]),
    );
    return {
        version: 1,
        settingsVersion,
        nonce: encode(nonce),
        ciphertext: encode(await encryptKey(plaintext, key, nonce, aad)),
    };
}

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
        const keys = (envelope: typeof a.envelope) =>
            [
                decode(envelope.encryptionPublicKey, 32),
                decode(envelope.signingPublicKey, 32),
            ] as const;
        const first = await fingerprint(...keys(a.envelope));
        expect(first).toMatch(/^([0-9a-f]{4} ){9}[0-9a-f]{4}$/);
        expect(await fingerprint(...keys(a.envelope))).toBe(first);
        expect(await fingerprint(...keys(b.envelope))).not.toBe(first);
        // The same X25519 key beside another identity's signing key: not the same person.
        expect(
            await fingerprint(
                decode(a.envelope.encryptionPublicKey, 32),
                decode(b.envelope.signingPublicKey, 32),
            ),
        ).not.toBe(first);
        await expect(fingerprint(new Uint8Array(31), new Uint8Array(32))).rejects.toThrow();
    });
});

describe('own signing key', () => {
    test('is proven against the seed under the root, so a swapped one is refused', async () => {
        const { root, envelope } = await identityWithKey();
        expect(await verifyIdentitySigningKey(root, USER, envelope)).toBe(
            envelope.signingPublicKey,
        );
        const swapped = {
            ...envelope,
            signingPublicKey: (await identityWithKey()).envelope.signingPublicKey,
        };
        await expect(verifyIdentitySigningKey(root, USER, swapped)).rejects.toThrow();
        await expect(verifyIdentitySigningKey(root, OTHER, envelope)).rejects.toThrow();
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

    /* A settings key as an account makes it: random, wrapped under the root. */
    async function withSettingsKey(userId = USER) {
        const identity = await identityWithKey(userId);
        const made = await createSettingsKey(identity.root, userId);
        return { ...identity, settingsKey: made.key, wrapped: made.envelope };
    }
    const only = (settingsKey: Uint8Array<ArrayBuffer>) => settingsKey;

    test('version 2 round-trips under the settings key, bound to the person and the version', async () => {
        const { settingsKey } = await withSettingsKey();
        const envelope = await sealSettings(settingsKey, USER, 3, settings);
        expect(envelope.version).toBe(2);
        expect(await openSettings(only(settingsKey), USER, envelope)).toEqual(settings);
        // Another account's key, another person, or a replayed older version: refused.
        const stranger = await withSettingsKey(OTHER);
        await expect(openSettings(only(stranger.settingsKey), USER, envelope)).rejects.toThrow();
        await expect(openSettings(only(settingsKey), OTHER, envelope)).rejects.toThrow();
        await expect(
            openSettings(only(settingsKey), USER, { ...envelope, settingsVersion: 2 }),
        ).rejects.toThrow();
        // Presented as version 1, it is not opened at all: no settings, never the document.
        expect(await openSettings(settingsKey, USER, { ...envelope, version: 1 })).toBeNull();
        // A flipped byte in the ciphertext is refused, never parsed.
        const bytes = decode(envelope.ciphertext);
        bytes[5] = bytes[5]! ^ 1;
        const tampered = { ...envelope, ciphertext: Buffer.from(bytes).toString('base64url') };
        await expect(openSettings(only(settingsKey), USER, tampered)).rejects.toThrow();
    });

    test('version 1 no longer opens: a genuine one reads as no settings, and never as a document', async () => {
        const { key, settingsKey } = await withSettingsKey();
        const legacy = await legacySettings(key, USER, 4, settings);
        // A stolen identity key opened these; whatever key is at hand, nothing comes out.
        expect(await openSettings(settingsKey, USER, legacy)).toBeNull();
        expect(await openSettings(null, USER, legacy)).toBeNull();
        // Relabelled as version 2 it is refused, not read under the identity's key.
        await expect(openSettings(settingsKey, USER, { ...legacy, version: 2 })).rejects.toThrow();
        await expect(
            openSettings(settingsKey, USER, { ...legacy, version: 3 as 2 }),
        ).rejects.toThrow('Unsupported settings envelope.');
    });

    test('the settings key opens only under its root and account, and follows a master-key rotation', async () => {
        const { root, settingsKey, wrapped } = await withSettingsKey();
        expect(wrapped.ciphertext).toHaveLength(64); // 48 bytes, base64url
        expect(await openSettingsKey(root, USER, wrapped)).toEqual(settingsKey);
        await expect(openSettingsKey(root, OTHER, wrapped)).rejects.toThrow();
        const nextRoot = crypto.getRandomValues(new Uint8Array(32));
        await expect(openSettingsKey(nextRoot, USER, wrapped)).rejects.toThrow();
        // Wrapped under the root, not derived from it: an identity's key opens nothing here.
        const sealed = await sealSettings(settingsKey, USER, 1, EMPTY_SETTINGS);
        const rewrapped = await rewrapSettingsKey(root, nextRoot, USER, wrapped);
        expect(rewrapped.nonce).not.toBe(wrapped.nonce);
        const reopened = await openSettingsKey(nextRoot, USER, rewrapped);
        expect(await openSettings(only(reopened), USER, sealed)).toEqual(EMPTY_SETTINGS);
        await expect(openSettingsKey(root, USER, rewrapped)).rejects.toThrow();
        await expect(rewrapSettingsKey(nextRoot, root, USER, wrapped)).rejects.toThrow();
    });

    test('pads to whole kibibytes, so the length says little about how many are pinned', async () => {
        const { settingsKey } = await withSettingsKey();
        const one = await sealSettings(settingsKey, USER, 1, EMPTY_SETTINGS);
        const two = await sealSettings(settingsKey, USER, 1, settings);
        expect(decode(one.ciphertext).length - 16).toBe(SETTINGS_PAD_STEP);
        expect(decode(two.ciphertext).length).toBe(decode(one.ciphertext).length);
        expect(await openSettings(only(settingsKey), USER, two)).toEqual(settings);
    });

    test('refuses a document over the size cap', async () => {
        const { settingsKey: key } = await withSettingsKey();
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
        const rewrapped = await rewrapIdentity(root, nextRoot, USER, upgraded);
        expect(rewrapped.kem?.publicKey).toBe(kem.publicKey);
        expect(rewrapped.kem?.signature).toBe(kem.signature);
        expect(rewrapped.kem?.encryptedSeed).not.toBe(kem.encryptedSeed);
        expect((await openIdentityKemKey(nextRoot, USER, rewrapped))?.publicKey).toBe(
            kem.publicKey,
        );
        await expect(openIdentityKemKey(root, USER, rewrapped)).rejects.toThrow();
    });
});

describe('settings in the worker', () => {
    test('version 2 needs the settings key, which a lock forgets; version 1 is no settings', async () => {
        const { createDeviceKey, rememberAccountKey } = await import('./device');
        const { createCryptoSession } = await import('./session');
        const { root, envelope: identity, key } = await identityWithKey();
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
        await expect(
            call('settingsSeal', { userId: USER, settingsVersion: 1, settings: EMPTY_SETTINGS }),
        ).rejects.toThrow('Open your settings key first.');
        const { settingsKey } = (await call('settingsKeyCreate', { userId: USER })) as {
            settingsKey: { nonce: string; ciphertext: string };
        };
        const { envelope } = (await call('settingsSeal', {
            userId: USER,
            settingsVersion: 2,
            settings: EMPTY_SETTINGS,
        })) as { envelope: SettingsEnvelope };
        expect(envelope.version).toBe(2);
        // The key it made is the one the server keeps: it opens the envelope from the root alone.
        const opened = await openSettingsKey(root, USER, settingsKey);
        expect(await openSettings(opened, USER, envelope)).toEqual(EMPTY_SETTINGS);
        // A version 1 envelope is no settings, with the identity open or not.
        const legacy = await legacySettings(key, USER, 1, EMPTY_SETTINGS);
        await expect(call('settingsOpen', { userId: USER, envelope: legacy })).resolves.toEqual({
            settings: null,
        });
        await call('identityOpen', { userId: USER, identity });
        await expect(call('settingsOpen', { userId: USER, envelope: legacy })).resolves.toEqual({
            settings: null,
        });
        // A key for another account, or after a lock, opens nothing.
        await expect(call('settingsKeyOpen', { userId: OTHER, settingsKey })).rejects.toThrow();
        session.reset();
        await call('restore', { deviceKey, bundle });
        await expect(call('settingsOpen', { userId: USER, envelope })).rejects.toThrow(
            'Open your settings key first.',
        );
        await call('settingsKeyOpen', { userId: USER, settingsKey });
        await expect(call('settingsOpen', { userId: USER, envelope })).resolves.toEqual({
            settings: EMPTY_SETTINGS,
        });
    });
});
