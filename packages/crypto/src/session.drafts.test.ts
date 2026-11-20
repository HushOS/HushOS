import { describe, expect, test } from 'vitest';
import { createDeviceKey, rememberAccountKey } from './device';
import type { Draft } from './drafts';
import { createCryptoSession } from './session';

/*
 * The worker's side of drafts: only an unlocked session seals, opens or finds a draft, only for
 * its own account; a session restored after a lock (or a reload) opens what the last one sealed,
 * which is how text a lock dropped comes back; and another account's root opens nothing.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const NODE = '44444444-4444-4444-8444-444444444444';

const draft: Draft = {
    frame: {
        baseVersionId: '55555555-5555-4555-8555-555555555555',
        encoding: 'utf-8',
        lineEnding: 'lf',
        mixed: false,
        savedAt: 1_763_650_440_000,
    },
    text: 'unsaved canary',
    selection: { from: 3, to: 3 },
};

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
    const where = (userId: string) => ({ userId, workspaceId: WORKSPACE, nodeId: NODE });
    return {
        session,
        seal: async (userId: string) =>
            (await call('driveDraftSeal', { ...where(userId), draft })) as {
                slot: string;
                record: string;
            },
        open: async (userId: string, record: string) =>
            (
                (await call('driveDraftOpen', { ...where(userId), record })) as {
                    draft: Draft | null;
                }
            ).draft,
        slot: async (userId: string) =>
            ((await call('driveDraftSlot', where(userId))) as { slot: string }).slot,
    };
}

describe('driveDraftSeal, driveDraftOpen and driveDraftSlot', () => {
    test('a session unlocked again opens what the last one sealed, under the same slot', async () => {
        const root = crypto.getRandomValues(new Uint8Array(32));
        const before = await restored(root);
        const { slot, record } = await before.seal(USER);
        expect(record).not.toContain('canary');
        before.session.reset();
        const after = await restored(root);
        expect(await after.slot(USER)).toBe(slot);
        expect(await after.open(USER, record)).toEqual(draft);
    });

    test('another account’s root opens nothing, and finds it under another slot', async () => {
        const mine = await restored(crypto.getRandomValues(new Uint8Array(32)));
        const theirs = await restored(crypto.getRandomValues(new Uint8Array(32)));
        const { slot, record } = await mine.seal(USER);
        expect(await theirs.open(USER, record)).toBeNull();
        expect(await theirs.slot(USER)).not.toBe(slot);
    });

    test('is refused for another user id, and while locked', async () => {
        const { session, seal, open, slot } = await restored(
            crypto.getRandomValues(new Uint8Array(32)),
        );
        const { record } = await seal(USER);
        await expect(seal(OTHER)).rejects.toThrow('Unlock your account first.');
        await expect(open(OTHER, record)).rejects.toThrow('Unlock your account first.');
        session.reset();
        await expect(seal(USER)).rejects.toThrow('Unlock your account first.');
        await expect(open(USER, record)).rejects.toThrow('Unlock your account first.');
        await expect(slot(USER)).rejects.toThrow('Unlock your account first.');
    });
});
