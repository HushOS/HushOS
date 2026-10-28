import { describe, expect, test } from 'vitest';
import { createSettingsKey, rewrapSettingsKey } from './contacts';
import { createDeviceKey, rememberAccountKey } from './device';
import { decode, encode } from './keys';
import {
    openRollbackMarks,
    RollbackMarksError,
    rollbackMarksSlot,
    sealRollbackMarks,
    type RollbackMarks,
} from './rollback-marks';
import { createCryptoSession } from './session';

/*
 * Rollback marks at rest: what a locked browser keeps of them must say
 * nothing (not the account, not the counters), open only under the settings
 * key of the account that sealed them, whatever root unlocked it, and never
 * pass for another account's record or for "no marks".
 */

const MAYA = '0f6d6c1e-2a49-4d8b-9b1a-4b3f4b8c1d01';
const SAM = '0f6d6c1e-2a49-4d8b-9b1a-4b3f4b8c1d02';
const key32 = () => crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
const marks: RollbackMarks = {
    settings: 41,
    settingsDocument: true,
    identity: 7,
    identityVersion: 2,
};

describe('sealed rollback marks', () => {
    test('open under the settings key that sealed them, and hold neither the account nor the counters', async () => {
        const key = key32();
        const { slot, envelope } = await sealRollbackMarks(key, MAYA, marks);
        expect(await openRollbackMarks(key, MAYA, envelope)).toEqual(marks);
        const stored = new TextDecoder('latin1').decode(decode(envelope));
        for (const needle of [MAYA, MAYA.replaceAll('-', '')])
            expect(`${slot}|${envelope}|${stored}`).not.toContain(needle);
        for (const needle of ['settings', 'identity', ':41', ':true'])
            expect(stored).not.toContain(needle);
        // Fresh nonce each time: two seals of the same marks are not the same bytes.
        expect((await sealRollbackMarks(key, MAYA, marks)).envelope).not.toBe(envelope);
    });

    test('another settings key (another account’s, or none a server could make) opens nothing', async () => {
        const { envelope } = await sealRollbackMarks(key32(), MAYA, marks);
        await expect(openRollbackMarks(key32(), MAYA, envelope)).rejects.toBeInstanceOf(
            RollbackMarksError,
        );
    });

    test('a record is bound to its account: copied to another user id it does not open', async () => {
        const key = key32();
        const { envelope } = await sealRollbackMarks(key, MAYA, marks);
        await expect(openRollbackMarks(key, SAM, envelope)).rejects.toBeInstanceOf(
            RollbackMarksError,
        );
    });

    test('the slot needs no key: one per account, the same on every device, and not the id', async () => {
        const slot = await rollbackMarksSlot(MAYA);
        expect(await rollbackMarksSlot(MAYA)).toBe(slot);
        expect(await rollbackMarksSlot(SAM)).not.toBe(slot);
        expect((await sealRollbackMarks(key32(), MAYA, marks)).slot).toBe(slot);
        expect(slot).not.toContain(MAYA.slice(0, 8));
    });

    test.each([
        ['a flipped ciphertext byte', (bytes: Uint8Array) => (bytes[bytes.length - 1]! ^= 1)],
        ['a flipped nonce byte', (bytes: Uint8Array) => (bytes[3]! ^= 1)],
        ['another format version', (bytes: Uint8Array) => (bytes[0] = 2)],
    ])('%s is refused, not read as no marks', async (_label, damage) => {
        const key = key32();
        const bytes = decode((await sealRollbackMarks(key, MAYA, marks)).envelope);
        damage(bytes);
        await expect(openRollbackMarks(key, MAYA, encode(bytes))).rejects.toBeInstanceOf(
            RollbackMarksError,
        );
    });

    test.each([['not base64url!'], [''], [encode(new Uint8Array(30))]])(
        'garbage (%#) is refused',
        async (envelope) => {
            await expect(openRollbackMarks(key32(), MAYA, envelope)).rejects.toBeInstanceOf(
                RollbackMarksError,
            );
        },
    );

    test('marks that are not counts are never sealed', async () => {
        await expect(
            sealRollbackMarks(key32(), MAYA, { ...marks, settings: -1 }),
        ).rejects.toBeInstanceOf(RollbackMarksError);
        await expect(
            sealRollbackMarks(key32(), MAYA, { ...marks, identity: 1.5 }),
        ).rejects.toBeInstanceOf(RollbackMarksError);
    });
});

/* The worker's side: a session of the account, its root and its settings key open. */
async function session(root: Uint8Array<ArrayBuffer>, settingsKey?: unknown) {
    const deviceKey = await createDeviceKey();
    const bundle = await rememberAccountKey(root, deviceKey, {
        userId: MAYA,
        keyVersion: 1,
        credentialVersion: 1,
        deviceKeyId: 'device',
    });
    const handle = createCryptoSession();
    let id = 0;
    const call = (operation: string, input: unknown) =>
        handle.handle({ id: ++id, operation, input } as Parameters<typeof handle.handle>[0]);
    await call('restore', { deviceKey, bundle });
    if (settingsKey) await call('settingsKeyOpen', { userId: MAYA, settingsKey });
    return { handle, call };
}
const sealIn = async (call: (operation: string, input: unknown) => Promise<unknown>) =>
    ((await call('rollbackMarksSeal', { userId: MAYA, marks })) as { envelope: string }).envelope;

describe('rollbackMarksSeal and rollbackMarksOpen', () => {
    test('marks sealed before a master-key rotation open after it, and under the old root a server replays', async () => {
        const oldRoot = key32();
        const { envelope: wrapped } = await createSettingsKey(oldRoot, MAYA);
        const before = await session(oldRoot, wrapped);
        const envelope = await sealIn(before.call);
        // The rotation re-wraps the same settings key under the new root.
        const newRoot = key32();
        const rewrapped = await rewrapSettingsKey(oldRoot, newRoot, MAYA, wrapped);
        const after = await session(newRoot, rewrapped);
        expect(await after.call('rollbackMarksOpen', { userId: MAYA, envelope })).toEqual({
            marks,
        });
        // The server replays the account as it was before the rotation: the same marks, so
        // whatever older settings or identity it serves alongside is still refused.
        const replayed = await session(oldRoot, wrapped);
        expect(await replayed.call('rollbackMarksOpen', { userId: MAYA, envelope })).toEqual({
            marks,
        });
    });

    test('a record under another settings key answers null, which the page refuses', async () => {
        const root = key32();
        const mine = await session(root, (await createSettingsKey(root, MAYA)).envelope);
        const other = await session(root, (await createSettingsKey(root, MAYA)).envelope);
        const envelope = await sealIn(mine.call);
        expect(await other.call('rollbackMarksOpen', { userId: MAYA, envelope })).toEqual({
            marks: null,
        });
    });

    test('the envelope kept beside the marks opens the key when the server serves none; a stale one is refused without locking', async () => {
        const root = key32();
        const wrapped = (await createSettingsKey(root, MAYA)).envelope;
        const first = await session(root, wrapped);
        const envelope = await sealIn(first.call);
        const later = await session(root);
        expect(
            await later.call('rollbackMarksKey', { userId: MAYA, settingsKey: wrapped }),
        ).toEqual({
            opened: true,
        });
        expect(await later.call('rollbackMarksOpen', { userId: MAYA, envelope })).toEqual({
            marks,
        });
        // Kept from before a rotation made elsewhere: it does not open under the new root, and
        // the session stays unlocked for the server's envelope.
        const rotated = await session(key32());
        expect(
            await rotated.call('rollbackMarksKey', { userId: MAYA, settingsKey: wrapped }),
        ).toEqual({ opened: false });
        await expect(rotated.call('rollbackMarksSeal', { userId: MAYA, marks })).rejects.toThrow(
            'Open your settings key first.',
        );
    });

    test('one update opens and seals under the one key held: a record under another is refused, not sealed over', async () => {
        const root = key32();
        const mine = await session(root, (await createSettingsKey(root, MAYA)).envelope);
        const envelope = await sealIn(mine.call);
        // Nothing rises: the same record back, not sealed again.
        expect(
            await mine.call('rollbackMarksUpdate', {
                userId: MAYA,
                envelope,
                marks: { settings: 3 },
            }),
        ).toEqual({ refused: false, marks, envelope, changed: false });
        const raised = (await mine.call('rollbackMarksUpdate', {
            userId: MAYA,
            envelope,
            marks: { settings: 50 },
        })) as { envelope: string; marks: { settings: number }; changed: boolean };
        expect(raised.changed).toBe(true);
        expect(raised.marks.settings).toBe(50);
        // A worker holding another settings key of the account's refuses, and returns nothing to store.
        const other = await session(root, (await createSettingsKey(root, MAYA)).envelope);
        expect(
            await other.call('rollbackMarksUpdate', {
                userId: MAYA,
                envelope: raised.envelope,
                marks: { settings: 60 },
            }),
        ).toEqual({ refused: true });
    });

    test('is refused without the settings key open, for another account, and once locked', async () => {
        const root = key32();
        const wrapped = (await createSettingsKey(root, MAYA)).envelope;
        const { handle, call } = await session(root, wrapped);
        const envelope = await sealIn(call);
        const keyless = await session(root);
        await expect(keyless.call('rollbackMarksOpen', { userId: MAYA, envelope })).rejects.toThrow(
            'Open your settings key first.',
        );
        await expect(call('rollbackMarksSeal', { userId: SAM, marks })).rejects.toThrow(
            'Unlock your account first.',
        );
        handle.reset();
        await expect(call('rollbackMarksOpen', { userId: MAYA, envelope })).rejects.toThrow(
            'Unlock your account first.',
        );
    });
});
