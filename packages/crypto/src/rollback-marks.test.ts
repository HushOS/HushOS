import { describe, expect, test } from 'vitest';
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
 * nothing (not the account, not the counters), open only under the root of
 * the account that sealed them, and never pass for another account's record or
 * for "no marks".
 */

const MAYA = '0f6d6c1e-2a49-4d8b-9b1a-4b3f4b8c1d01';
const SAM = '0f6d6c1e-2a49-4d8b-9b1a-4b3f4b8c1d02';
const root = () => crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
const marks: RollbackMarks = {
    settings: 41,
    settingsDocument: true,
    identity: 7,
    identityVersion: 2,
};

describe('sealed rollback marks', () => {
    test('open under the root that sealed them, and hold neither the account nor the counters', async () => {
        const key = root();
        const { slot, envelope } = await sealRollbackMarks(key, MAYA, marks);
        expect(await openRollbackMarks(key, MAYA, envelope)).toEqual(marks);
        // What sits in storage: neither the id (in any form a reader would search for) nor the JSON.
        const stored = new TextDecoder('latin1').decode(decode(envelope));
        for (const needle of [MAYA, MAYA.replaceAll('-', '')])
            expect(`${slot}|${envelope}|${stored}`).not.toContain(needle);
        for (const needle of ['settings', 'identity', ':41', ':true'])
            expect(stored).not.toContain(needle);
        // Fresh nonce each time: two seals of the same marks are not the same bytes.
        expect((await sealRollbackMarks(key, MAYA, marks)).envelope).not.toBe(envelope);
    });

    test('another root (a locked browser has none, another account has its own) opens nothing', async () => {
        const { envelope } = await sealRollbackMarks(root(), MAYA, marks);
        await expect(openRollbackMarks(root(), MAYA, envelope)).rejects.toBeInstanceOf(
            RollbackMarksError,
        );
    });

    test('a record is bound to its account: copied to another user id it does not open', async () => {
        const key = root();
        const { envelope } = await sealRollbackMarks(key, MAYA, marks);
        await expect(openRollbackMarks(key, SAM, envelope)).rejects.toBeInstanceOf(
            RollbackMarksError,
        );
    });

    test('the slot is per account and per root, and the same on every unlock', async () => {
        const key = root();
        const slot = await rollbackMarksSlot(key, MAYA);
        expect(await rollbackMarksSlot(key.slice(), MAYA)).toBe(slot);
        expect(await rollbackMarksSlot(key, SAM)).not.toBe(slot);
        expect(await rollbackMarksSlot(root(), MAYA)).not.toBe(slot);
    });

    test.each([
        ['a flipped ciphertext byte', (bytes: Uint8Array) => (bytes[bytes.length - 1]! ^= 1)],
        ['a flipped nonce byte', (bytes: Uint8Array) => (bytes[3]! ^= 1)],
        ['another format version', (bytes: Uint8Array) => (bytes[0] = 2)],
    ])('%s is refused, not read as no marks', async (_label, damage) => {
        const key = root();
        const bytes = decode((await sealRollbackMarks(key, MAYA, marks)).envelope);
        damage(bytes);
        await expect(openRollbackMarks(key, MAYA, encode(bytes))).rejects.toBeInstanceOf(
            RollbackMarksError,
        );
    });

    test.each([['not base64url!'], [''], [encode(new Uint8Array(30))]])(
        'garbage (%#) is refused',
        async (envelope) => {
            await expect(openRollbackMarks(root(), MAYA, envelope)).rejects.toBeInstanceOf(
                RollbackMarksError,
            );
        },
    );

    test('marks that are not counts are never sealed', async () => {
        await expect(
            sealRollbackMarks(root(), MAYA, { ...marks, settings: -1 }),
        ).rejects.toBeInstanceOf(RollbackMarksError);
        await expect(
            sealRollbackMarks(root(), MAYA, { ...marks, identity: 1.5 }),
        ).rejects.toBeInstanceOf(RollbackMarksError);
    });
});

/* The worker's side: only an unlocked session of the account seals or opens its marks. */
async function restored(key: Uint8Array<ArrayBuffer>) {
    const deviceKey = await createDeviceKey();
    const bundle = await rememberAccountKey(key, deviceKey, {
        userId: MAYA,
        keyVersion: 1,
        credentialVersion: 1,
        deviceKeyId: 'device',
    });
    const session = createCryptoSession();
    let id = 0;
    const call = (operation: string, input: unknown) =>
        session.handle({ id: ++id, operation, input } as Parameters<typeof session.handle>[0]);
    await call('restore', { deviceKey, bundle });
    return { session, call };
}

describe('rollbackMarksSeal and rollbackMarksOpen', () => {
    test('a session restored after a reload opens what the last one sealed, at the same slot', async () => {
        const key = root();
        const first = await restored(key);
        const sealed = (await first.call('rollbackMarksSeal', { userId: MAYA, marks })) as {
            slot: string;
            envelope: string;
        };
        const after = await restored(key);
        expect(await after.call('rollbackMarksSlot', { userId: MAYA })).toEqual({
            slot: sealed.slot,
        });
        expect(
            await after.call('rollbackMarksOpen', { userId: MAYA, envelope: sealed.envelope }),
        ).toEqual({ marks });
    });

    test('a record that does not open answers null, which the page refuses', async () => {
        const mine = await restored(root());
        const theirs = await restored(root());
        const { envelope } = (await mine.call('rollbackMarksSeal', { userId: MAYA, marks })) as {
            envelope: string;
        };
        expect(await theirs.call('rollbackMarksOpen', { userId: MAYA, envelope })).toEqual({
            marks: null,
        });
    });

    test('is refused for another account, and once locked', async () => {
        const { session, call } = await restored(root());
        const { envelope } = (await call('rollbackMarksSeal', { userId: MAYA, marks })) as {
            envelope: string;
        };
        await expect(call('rollbackMarksSeal', { userId: SAM, marks })).rejects.toThrow(
            'Unlock your account first.',
        );
        session.reset();
        await expect(call('rollbackMarksOpen', { userId: MAYA, envelope })).rejects.toThrow(
            'Unlock your account first.',
        );
        await expect(call('rollbackMarksSlot', { userId: MAYA })).rejects.toThrow(
            'Unlock your account first.',
        );
    });
});
