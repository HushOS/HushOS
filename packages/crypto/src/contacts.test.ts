import { describe, expect, test } from 'vitest';
import {
    createIdentity,
    openIdentityEncryptionKey,
    publicIdentity,
    upgradeIdentity,
    verifyIdentityKeys,
    verifyOwnIdentity,
    type IdentityEnvelope,
} from './identity';
import { fingerprintOfKeys, keyDigest } from './fingerprint';
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
    test('are stable for an identity, differ between identities, and are ten groups of four hex digits', async () => {
        const a = await identityWithKey();
        const b = await identityWithKey();
        const keys = (envelope: IdentityEnvelope) =>
            [
                decode(envelope.encryptionPublicKey, 32),
                decode(envelope.signingPublicKey, 32),
                decode(envelope.mlDsa!.publicKey, 1952),
                decode(envelope.kem!.publicKey, 1184),
            ] as const;
        const first = await fingerprintOfKeys(...keys(a.envelope));
        expect(first).toMatch(/^([0-9a-f]{4} ){9}[0-9a-f]{4}$/);
        expect(await fingerprintOfKeys(...keys(a.envelope))).toBe(first);
        expect(await fingerprintOfKeys(...keys(b.envelope))).not.toBe(first);
        // Any one of the four keys from another identity: not the same person.
        for (let at = 0; at < 4; at++) {
            const mixed = [...keys(a.envelope)] as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
            mixed[at] = keys(b.envelope)[at]!;
            expect(await fingerprintOfKeys(...mixed)).not.toBe(first);
        }
        await expect(
            fingerprint(
                new Uint8Array(31),
                new Uint8Array(32),
                new Uint8Array(32),
                new Uint8Array(32),
            ),
        ).rejects.toThrow();
    });
});

describe('own identity', () => {
    test('every private half is proven against its public key under the root, so a swapped one is refused', async () => {
        const { root, envelope } = await identityWithKey();
        await expect(verifyOwnIdentity(root, USER, envelope)).resolves.toBeUndefined();
        const other = (await identityWithKey()).envelope;
        for (const swapped of [
            { ...envelope, signingPublicKey: other.signingPublicKey },
            { ...envelope, encryptionPublicKey: other.encryptionPublicKey },
            { ...envelope, mlDsa: { ...envelope.mlDsa!, publicKey: other.mlDsa!.publicKey } },
            { ...envelope, kem: { ...envelope.kem!, publicKey: other.kem!.publicKey } },
            // The keys statement of another identity beside this one's keys.
            { ...envelope, keysSignature: other.keysSignature },
        ])
            await expect(verifyOwnIdentity(root, USER, swapped)).rejects.toThrow();
        await expect(verifyOwnIdentity(root, OTHER, envelope)).rejects.toThrow();
    });
});

describe('the keys statement', () => {
    test('binds all four keys, the account and the key version, signed with both signing keys', async () => {
        const a = (await identityWithKey()).envelope;
        const b = (await identityWithKey(OTHER)).envelope;
        const keys = publicIdentity(a);
        expect(decode(keys.keysSignature)).toHaveLength(3373);
        expect(await verifyIdentityKeys(USER, keys)).toBe(true);
        expect(await verifyIdentityKeys(OTHER, keys)).toBe(false);
        expect(await verifyIdentityKeys(USER, { ...keys, keyVersion: 2 })).toBe(false);
        // A server that swaps in a key of its own cannot sign for it, whichever key it is.
        const other = publicIdentity(b);
        for (const field of [
            'encryptionPublicKey',
            'signingPublicKey',
            'mlDsaPublicKey',
            'kemPublicKey',
        ] as const)
            expect(await verifyIdentityKeys(USER, { ...keys, [field]: other[field] })).toBe(false);
        // Stripped to its Ed25519 half: the statement is a hybrid one.
        expect(
            await verifyIdentityKeys(USER, {
                ...keys,
                keysSignature: encode(decode(keys.keysSignature).subarray(0, 64)),
            }),
        ).toBe(false);
    });
});

/* A version 1 identity as accounts held them before the release, from a version 2 one's keys. */
function versionOne(envelope: IdentityEnvelope, kem = true): IdentityEnvelope {
    return {
        version: 1,
        keyVersion: envelope.keyVersion,
        wrappingSalt: envelope.wrappingSalt,
        encryptionPublicKey: envelope.encryptionPublicKey,
        encryptionPrivateKeyNonce: envelope.encryptionPrivateKeyNonce,
        encryptedEncryptionPrivateKey: envelope.encryptedEncryptionPrivateKey,
        signingPublicKey: envelope.signingPublicKey,
        signingSeedNonce: envelope.signingSeedNonce,
        encryptedSigningSeed: envelope.encryptedSigningSeed,
        kem: kem ? { ...envelope.kem!, signature: encode(new Uint8Array(64)) } : null,
    };
}

describe('the upgrade', () => {
    test('keeps the X25519, Ed25519 and ML-KEM keys and the key version, and adds an ML-DSA key that opens', async () => {
        const { openIdentityMlDsaKey, rewrapIdentity } = await import('./identity');
        const { root, envelope } = await identityWithKey();
        const legacy = versionOne({ ...envelope, keyVersion: 1 });
        const upgraded = await upgradeIdentity(root, USER, legacy);
        expect(upgraded.version).toBe(2);
        expect(upgraded.keyVersion).toBe(legacy.keyVersion);
        expect(upgraded.encryptionPublicKey).toBe(legacy.encryptionPublicKey);
        expect(upgraded.signingPublicKey).toBe(legacy.signingPublicKey);
        expect(upgraded.kem!.publicKey).toBe(legacy.kem!.publicKey);
        // The Ed25519 KEM binding is gone: the keys statement replaces it.
        expect('signature' in upgraded.kem).toBe(false);
        expect(await verifyIdentityKeys(USER, publicIdentity(upgraded))).toBe(true);
        expect((await openIdentityMlDsaKey(root, USER, upgraded))!.publicKey).toBe(
            upgraded.mlDsa!.publicKey,
        );
        await expect(verifyOwnIdentity(root, USER, upgraded)).resolves.toBeUndefined();
        // Only once: an upgraded identity is not upgraded again with a second ML-DSA key.
        await expect(upgradeIdentity(root, USER, upgraded)).rejects.toThrow(/already/);
        // Master-key rotation after the upgrade keeps the ML-DSA seed openable under the new root.
        const nextRoot = crypto.getRandomValues(new Uint8Array(32));
        const rotated = await rewrapIdentity(root, nextRoot, USER, upgraded);
        expect((await openIdentityMlDsaKey(nextRoot, USER, rotated))!.publicKey).toBe(
            upgraded.mlDsa!.publicKey,
        );
        await expect(openIdentityMlDsaKey(root, USER, rotated)).rejects.toThrow();
        expect(await verifyIdentityKeys(USER, publicIdentity(rotated))).toBe(true);
    });

    test('gives a version 1 identity from before hybrid sharing its ML-KEM key too', async () => {
        const { openIdentityKemKey } = await import('./identity');
        const { root, envelope } = await identityWithKey();
        const upgraded = await upgradeIdentity(root, USER, versionOne(envelope, false));
        expect(upgraded.kem!.publicKey).not.toBe(envelope.kem!.publicKey);
        expect((await openIdentityKemKey(root, USER, upgraded))!.publicKey).toBe(
            upgraded.kem!.publicKey,
        );
        expect(await verifyIdentityKeys(USER, publicIdentity(upgraded))).toBe(true);
    });

    test('refuses an identity whose keys do not open under this root', async () => {
        const { root, envelope } = await identityWithKey();
        const stranger = (await identityWithKey()).envelope;
        await expect(
            upgradeIdentity(
                root,
                USER,
                versionOne({ ...envelope, signingPublicKey: stranger.signingPublicKey }),
            ),
        ).rejects.toThrow();
        await expect(
            upgradeIdentity(root, USER, {
                ...versionOne(envelope),
                kem: { ...envelope.kem!, publicKey: stranger.kem!.publicKey },
            }),
        ).rejects.toThrow();
        // An X25519 key the server swapped in: the upgrade would sign for a key this device
        // never proved it holds.
        await expect(
            upgradeIdentity(
                root,
                USER,
                versionOne({ ...envelope, encryptionPublicKey: stranger.encryptionPublicKey }),
            ),
        ).rejects.toThrow();
        await expect(
            upgradeIdentity(crypto.getRandomValues(new Uint8Array(32)), USER, versionOne(envelope)),
        ).rejects.toThrow();
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
        version: 2,
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

    test('fifty contacts’ version 3 pins fit under the cap', async () => {
        const { settingsKey: key } = await withSettingsKey();
        const many: Settings = { version: 2, contacts: {} };
        const sample = (await identityWithKey()).envelope;
        for (let i = 0; i < 50; i++) {
            const userId = `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`;
            many.contacts[userId] = {
                userId,
                email: `contact-${i}@a-long-company-domain.example`,
                name: `Contact with a fairly long display name ${i}`,
                encryptionPublicKey: sample.encryptionPublicKey,
                signingPublicKey: sample.signingPublicKey,
                mlDsaPublicKeyHash: await keyDigest(decode(sample.mlDsa!.publicKey)),
                kemPublicKeyHash: await keyDigest(decode(sample.kem!.publicKey)),
                fingerprint: '0000 0000 0000 0000 0000 0000 0000 0000 0000 0000',
                pinnedAt: new Date().toISOString(),
                keyVersion: 1,
            };
        }
        await expect(sealSettings(key, USER, 1, many)).resolves.toBeDefined();
    });

    test('a version 1 document still opens, and is sealed again as version 2', async () => {
        const { settingsKey: key } = await withSettingsKey();
        const old: Settings = { ...settings, version: 1 };
        const sealed = await sealSettings(key, USER, 3, old);
        const reopened = await openSettings(key, USER, sealed);
        expect(reopened).toEqual({ ...old, version: 2 });
    });

    test('refuses a document over the size cap', async () => {
        const { settingsKey: key } = await withSettingsKey();
        const big: Settings = { version: 2, contacts: {} };
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
        // A version 1 identity from before hybrid sharing has none.
        expect(await openIdentityKemKey(root, USER, versionOne(envelope, false))).toBeNull();
        // The seed alone reproduces the pair: what a device expands, nothing else is stored.
        expect(kemKeypair(new Uint8Array(64)).publicKey).toHaveLength(1184);
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
