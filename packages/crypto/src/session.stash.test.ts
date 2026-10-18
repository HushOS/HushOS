import { describe, expect, test } from 'vitest';
import { createDeviceKey, rememberAccountKey } from './device';
import { createCryptoSession } from './session';
import { openStash, sealStash } from './stash';

/*
 * The worker's side of the sealed stash: only an unlocked session hands out
 * the stash key, only for its own account, and a session restored after a
 * reload hands out the same key, so a stash written before the reload opens.
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
    return { session, stashKey: (userId: string) => call('driveStashKey', { userId }) };
}

async function seal(key: CryptoKey, bytes: Uint8Array) {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    await sealStash(key, 'stash', bytes, async (part) => void parts.push(part));
    return new Blob(parts);
}

describe('driveStashKey', () => {
    test('a session restored after a reload opens what the last one sealed', async () => {
        const root = crypto.getRandomValues(new Uint8Array(32));
        const before = await restored(root);
        const { key } = (await before.stashKey(USER)) as { key: CryptoKey };
        const bytes = new TextEncoder().encode('a copy of something shared');
        const stored = await seal(key, bytes);
        const after = await restored(root);
        const { key: again } = (await after.stashKey(USER)) as { key: CryptoKey };
        const opened = await openStash(again, 'stash', stored);
        expect(new Uint8Array(await new Blob(opened).arrayBuffer())).toEqual(bytes);
    });

    test('another account’s session gets a key that opens nothing of this one', async () => {
        const mine = await restored(crypto.getRandomValues(new Uint8Array(32)));
        const theirs = await restored(crypto.getRandomValues(new Uint8Array(32)));
        const stored = await seal(
            ((await mine.stashKey(USER)) as { key: CryptoKey }).key,
            new Uint8Array(64),
        );
        const { key } = (await theirs.stashKey(USER)) as { key: CryptoKey };
        await expect(openStash(key, 'stash', stored)).rejects.toThrow();
    });

    test('is refused for another user id, and after a lock', async () => {
        const { session, stashKey } = await restored(crypto.getRandomValues(new Uint8Array(32)));
        await expect(stashKey(OTHER)).rejects.toThrow('Unlock your account first.');
        session.reset();
        await expect(stashKey(USER)).rejects.toThrow('Unlock your account first.');
    });
});
