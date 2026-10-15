import { afterEach, describe, expect, test, vi } from 'vitest';
import type * as aead from './aead';
import { createIdentity, upgradeIdentity, type IdentityEnvelope } from './identity';

/*
 * An identity whose wrapped ML-DSA seed does not open again can never sign
 * again (docs/identity-pq-design.md 2), so the device opens the seed back
 * before using or uploading it. Here the wrap of that one seed is corrupted on
 * the way out, as a bug in the wrapping would: creating or upgrading an
 * identity must refuse rather than hand back an envelope that cannot be used.
 */
const wrap = vi.hoisted(() => ({ corrupt: false }));
vi.mock('./aead', async (importOriginal) => {
    const real = await importOriginal<typeof aead>();
    return {
        ...real,
        encryptKey: async (...args: Parameters<typeof real.encryptKey>) => {
            const sealed = await real.encryptKey(...args);
            if (wrap.corrupt && new TextDecoder().decode(args[3]).includes('ml-dsa-seed-wrap'))
                sealed[0]! ^= 1;
            return sealed;
        },
    };
});

const USER = '11111111-1111-4111-8111-111111111111';
/* What opening a corrupted wrap reports: the seed's own refusal, not some other failure. */
const UNOPENABLE = 'This encrypted key could not be opened';

afterEach(() => {
    wrap.corrupt = false;
});

describe('a wrapped ML-DSA seed that does not open again', () => {
    test('is never handed out by creating an identity', async () => {
        wrap.corrupt = true;
        await expect(
            createIdentity(crypto.getRandomValues(new Uint8Array(32)), USER),
        ).rejects.toThrow(UNOPENABLE);
    });

    test('is never handed out by an upgrade', async () => {
        const root = crypto.getRandomValues(new Uint8Array(32));
        const made = await createIdentity(root, USER);
        // The version 1 form of the same keys, as accounts held them before the release.
        const before: IdentityEnvelope = {
            version: 1,
            keyVersion: made.keyVersion,
            wrappingSalt: made.wrappingSalt,
            encryptionPublicKey: made.encryptionPublicKey,
            encryptionPrivateKeyNonce: made.encryptionPrivateKeyNonce,
            encryptedEncryptionPrivateKey: made.encryptedEncryptionPrivateKey,
            signingPublicKey: made.signingPublicKey,
            signingSeedNonce: made.signingSeedNonce,
            encryptedSigningSeed: made.encryptedSigningSeed,
            kem: { ...made.kem },
        };
        // With a sound wrap it upgrades; with the ML-DSA seed's wrap broken it refuses.
        await expect(upgradeIdentity(root, USER, before)).resolves.toMatchObject({ version: 2 });
        wrap.corrupt = true;
        await expect(upgradeIdentity(root, USER, before)).rejects.toThrow(UNOPENABLE);
    });
});
