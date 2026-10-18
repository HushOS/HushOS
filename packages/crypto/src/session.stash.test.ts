import { describe, expect, test } from 'vitest';
import { createDeviceKey, rememberAccountKey } from './device';
import { createCryptoSession } from './session';

/*
 * The worker's side of the sealed stash: only an unlocked session seals or
 * opens a stash, only for its own account, and a session restored after a
 * reload derives the same key, so a stash sealed before the reload opens.
 * The key itself never leaves the worker.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';

async function restored(root: Uint8Array<ArrayBuffer>) {
    const deviceKey = await createDeviceKey();
    const bundle = await rememberAccountKey(root, deviceKey, {
        userId: USER,
        keyVersion: 1,
        credentialVersion: 1,
        deviceKeyId: 'device',
    });
    const session = createCryptoSession();
    let id = 0;
    const call = (operation: string, input: unknown) =>
        session.handle({ id: ++id, operation, input } as Parameters<typeof session.handle>[0]);
    await call('restore', { deviceKey, bundle });
    return {
        session,
        seal: async (userId: string, bytes: Uint8Array) =>
            new Blob(
                (
                    (await call('driveStashSeal', { userId, name: 'stash', bytes })) as {
                        parts: BlobPart[];
                    }
                ).parts,
            ),
        open: async (userId: string, stored: Blob) =>
            new Blob(
                (
                    (await call('driveStashOpen', { userId, name: 'stash', stored })) as {
                        parts: BlobPart[];
                    }
                ).parts,
            ),
    };
}

const text = async (blob: Blob) => new TextDecoder().decode(await blob.arrayBuffer());

describe('driveStashSeal and driveStashOpen', () => {
    test('a session restored after a reload opens what the last one sealed', async () => {
        const root = crypto.getRandomValues(new Uint8Array(32));
        const stored = await (await restored(root)).seal(USER, new TextEncoder().encode('a copy'));
        expect(await text(stored)).not.toContain('a copy');
        const after = await restored(root);
        expect(await text(await after.open(USER, stored))).toBe('a copy');
    });

    test('another account’s session opens nothing of this one', async () => {
        const mine = await restored(crypto.getRandomValues(new Uint8Array(32)));
        const theirs = await restored(crypto.getRandomValues(new Uint8Array(32)));
        const stored = await mine.seal(USER, new Uint8Array(64));
        await expect(theirs.open(USER, stored)).rejects.toThrow(/^This stash /);
    });

    test('is refused for another user id, and after a lock', async () => {
        const { session, seal, open } = await restored(crypto.getRandomValues(new Uint8Array(32)));
        const stored = await seal(USER, new Uint8Array(8));
        await expect(seal(OTHER, new Uint8Array(8))).rejects.toThrow('Unlock your account first.');
        await expect(open(OTHER, stored)).rejects.toThrow('Unlock your account first.');
        session.reset();
        await expect(open(USER, stored)).rejects.toThrow('Unlock your account first.');
    });
});
