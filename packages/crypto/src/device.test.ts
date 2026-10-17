import { describe, expect, test } from 'vitest';
import { createDeviceKey, rememberAccountKey, restoreAccountKey } from './device';
import { SavedAccessError } from './errors';

/*
 * The saved unlock opens only with the device key it was sealed to and only as written. A
 * failure to open is a SavedAccessError, the one restore failure the client erases the saved
 * unlock for; a different error would leave a dead bundle asking for the password forever.
 */
describe('restoring a saved account key', () => {
    const identity = {
        userId: '0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4',
        keyVersion: 1,
        credentialVersion: 1,
        deviceKeyId: 'device-key-1',
    };

    async function saved() {
        const accountKey = crypto.getRandomValues(new Uint8Array(32));
        const deviceKey = await createDeviceKey();
        const bundle = await rememberAccountKey(accountKey, deviceKey, identity);
        return { accountKey, deviceKey, bundle };
    }

    test('opens with the device key it was saved with', async () => {
        const { accountKey, deviceKey, bundle } = await saved();
        expect(await restoreAccountKey(bundle, deviceKey)).toEqual(accountKey);
    });

    test('refuses another device key', async () => {
        const { bundle } = await saved();
        await expect(restoreAccountKey(bundle, await createDeviceKey())).rejects.toBeInstanceOf(
            SavedAccessError,
        );
    });

    test('refuses a bundle whose ciphertext or header was changed', async () => {
        const { deviceKey, bundle } = await saved();
        const flipped = `${bundle.encryptedKey[0] === 'A' ? 'B' : 'A'}${bundle.encryptedKey.slice(1)}`;
        for (const changed of [
            { ...bundle, encryptedKey: flipped },
            { ...bundle, credentialVersion: 2 },
            { ...bundle, deviceKeyId: 'device-key-2' },
            { ...bundle, nonce: 'short' },
            { ...bundle, version: 2 as 1 },
        ])
            await expect(restoreAccountKey(changed, deviceKey)).rejects.toBeInstanceOf(
                SavedAccessError,
            );
    });
});
