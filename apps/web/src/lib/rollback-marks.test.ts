// @vitest-environment node
import {
    openRollbackMarks,
    RollbackMarksError,
    rollbackMarksSlot,
    sealRollbackMarks,
} from '@hushos/crypto/rollback-marks';
import { beforeEach, describe, expect, test } from 'vitest';
import {
    createRollbackMarks,
    identityRolledBack,
    MARKS_PREFIX,
    MarksUnreadableError,
    settingsDocumentRolledBack,
    settingsNoneTrusted,
} from './rollback-marks';

/*
 * A server keeps the settings and the identity, and would like to hand back
 * an older copy of either. What a device has seen must only ever go up, per
 * account, whatever identity the account has now; at rest it must say
 * nothing, and a record that does not open must never read as "nothing seen".
 *
 * The sealing is the worker's own (@hushos/crypto/rollback-marks), under a
 * root per account; "locked" is the account the worker would refuse.
 */
const MAYA = '0f6d6c1e-2a49-4d8b-9b1a-4b3f4b8c1d01';
const SAM = '0f6d6c1e-2a49-4d8b-9b1a-4b3f4b8c1d02';

/* localStorage as this browser's tabs share it; Node has none, and jsdom's bytes don't reach libsodium. */
const local = (() => {
    const items = new Map<string, string>();
    return {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, String(value)),
        removeItem: (key: string) => void items.delete(key),
        key: (index: number) => [...items.keys()][index] ?? null,
        clear: () => items.clear(),
        get length() {
            return items.size;
        },
    };
})();

function browser() {
    const roots = new Map<string, Uint8Array<ArrayBuffer>>();
    const rootOf = (userId: string) => {
        if (!roots.has(userId))
            roots.set(
                userId,
                crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>,
            );
        return roots.get(userId)!.slice();
    };
    let unlocked: string | null = null;
    let writes: 'ok' | 'full' = 'ok';
    const storage = {
        getItem: (key: string) => local.getItem(key),
        setItem: (key: string, value: string) => {
            if (writes === 'full') throw new DOMException('Full', 'QuotaExceededError');
            local.setItem(key, value);
        },
        removeItem: (key: string) => local.removeItem(key),
        key: (index: number) => local.key(index),
        get length() {
            return local.length;
        },
    };
    const marks = createRollbackMarks({
        sealer: {
            slot: (userId) => rollbackMarksSlot(rootOf(userId), userId),
            seal: (userId, value) => sealRollbackMarks(rootOf(userId), userId, value),
            open: (userId, envelope) =>
                openRollbackMarks(rootOf(userId), userId, envelope).catch((error: unknown) => {
                    if (error instanceof RollbackMarksError) return null;
                    throw error;
                }),
        },
        storage: () => storage,
        account: () => unlocked,
    });
    return {
        ...marks,
        unlock: (userId: string | null) => (unlocked = userId),
        slot: (userId: string) => rollbackMarksSlot(rootOf(userId), userId),
        fill: () => (writes = 'full'),
        /* A master-key rotation: the account's root is replaced. */
        rotate: (userId: string) =>
            roots.set(
                userId,
                crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>,
            ),
    };
}

const stored = () => {
    const out: Record<string, string> = {};
    for (let index = 0; index < local.length; index++) {
        const key = local.key(index)!;
        out[key] = local.getItem(key)!;
    }
    return out;
};

beforeEach(() => local.clear());

describe('rollback marks', () => {
    test('once a settings document opened here, none or a version 1 document is an older copy', () => {
        expect(settingsDocumentRolledBack('none', false)).toBe(false);
        expect(settingsDocumentRolledBack('none', true)).toBe(true);
        expect(settingsDocumentRolledBack(1, true)).toBe(true);
        expect(settingsDocumentRolledBack(2, true)).toBe(false);
    });

    test('"no settings" is a reading only for a brand-new account on a device that has seen nothing', () => {
        expect(settingsNoneTrusted(0, 0, false)).toBe(true);
        // None served at a sequence above 0: a version 1 document, or settings withheld.
        expect(settingsNoneTrusted(3, 3, false)).toBe(false);
        expect(settingsNoneTrusted(4, 0, false)).toBe(false);
        // This device saw a sequence or a document before.
        expect(settingsNoneTrusted(0, 2, false)).toBe(false);
        expect(settingsNoneTrusted(0, 0, true)).toBe(false);
    });

    test('no mark is ever lowered, and each account has its own', async () => {
        const b = browser();
        b.unlock(MAYA);
        await b.raise(MAYA, { settings: 5, identity: 3, identityVersion: 2 });
        await b.raise(MAYA, { settings: 3, identity: 2, identityVersion: 1 });
        await b.raise(MAYA, { settingsDocument: true });
        await b.raise(MAYA, { settingsDocument: false });
        expect(await b.read(MAYA)).toEqual({
            settings: 5,
            settingsDocument: true,
            identity: 3,
            identityVersion: 2,
        });
        b.unlock(SAM);
        expect(await b.read(SAM)).toEqual({
            settings: 0,
            settingsDocument: false,
            identity: 0,
            identityVersion: 0,
        });
    });

    test('raises from two places at once both stay', async () => {
        const b = browser();
        b.unlock(MAYA);
        await Promise.all([
            b.raise(MAYA, { settings: 9 }),
            b.raise(MAYA, { identity: 4 }),
            b.raise(MAYA, { settingsDocument: true }),
        ]);
        expect(await b.read(MAYA)).toMatchObject({
            settings: 9,
            identity: 4,
            settingsDocument: true,
        });
    });

    test('at rest they are ciphertext that names neither the account nor the counts', async () => {
        const b = browser();
        b.unlock(MAYA);
        await b.raise(MAYA, { settings: 4217, identity: 3, settingsDocument: true });
        const all = stored();
        expect(Object.keys(all)).toEqual([MARKS_PREFIX + (await b.slot(MAYA))]);
        const text = JSON.stringify(all);
        for (const needle of [MAYA, '4217', 'settings', 'identity', 'true'])
            expect(text).not.toContain(needle);
    });

    test('a locked browser reads nothing: an error, not "nothing seen"', async () => {
        const b = browser();
        b.unlock(MAYA);
        await b.raise(MAYA, { settings: 6 });
        b.unlock(null);
        await expect(b.read(MAYA)).rejects.toThrow('Unlock your account first.');
        await expect(b.raise(MAYA, { settings: 7 })).rejects.toThrow('Unlock your account first.');
        // Another account unlocked in this browser opens nothing of Maya's either.
        b.unlock(SAM);
        await expect(b.read(MAYA)).rejects.toThrow('Unlock your account first.');
    });

    test('a damaged record fails closed, and a raise does not write over it', async () => {
        const b = browser();
        b.unlock(MAYA);
        await b.raise(MAYA, { settings: 12 });
        const key = MARKS_PREFIX + (await b.slot(MAYA));
        const envelope = local.getItem(key)!;
        const damaged = `${envelope.slice(0, -2)}${envelope.endsWith('AA') ? 'BA' : 'AA'}`;
        local.setItem(key, damaged);
        await expect(b.read(MAYA)).rejects.toBeInstanceOf(MarksUnreadableError);
        await expect(b.raise(MAYA, { settings: 1 })).rejects.toBeInstanceOf(MarksUnreadableError);
        expect(local.getItem(key)).toBe(damaged);
    });

    test('another account’s record put in this account’s slot fails closed', async () => {
        const b = browser();
        b.unlock(SAM);
        await b.raise(SAM, { settings: 1 });
        const sams = local.getItem(MARKS_PREFIX + (await b.slot(SAM)))!;
        b.unlock(MAYA);
        await b.raise(MAYA, { settings: 30 });
        local.setItem(MARKS_PREFIX + (await b.slot(MAYA)), sams);
        await expect(b.read(MAYA)).rejects.toBeInstanceOf(MarksUnreadableError);
    });

    test('plaintext marks of an earlier version are sealed at their highest, then deleted', async () => {
        // What earlier versions kept in the clear, the per-identity settings marks among them.
        local.setItem(`hushos.settings-seen:${MAYA}`, '5');
        local.setItem(`hushos.settings-seen:${MAYA}:first-identity-key`, '7');
        local.setItem(`hushos.settings-seen:${MAYA}:second-identity-key`, '4');
        local.setItem(`hushos.settings-document-seen:${MAYA}`, '2');
        local.setItem(`hushos.identity-seen:${MAYA}`, '3');
        local.setItem(`hushos.identity-seen:${MAYA}:version`, '2');
        // Another account's are not this one's, and stay for that account's own unlock.
        local.setItem(`hushos.settings-seen:${SAM}`, '40');
        const b = browser();
        b.unlock(MAYA);
        // Something this device sealed since, higher than the plaintext: the higher stays.
        await b.raise(MAYA, { identity: 6 });
        const migrated = {
            settings: 7,
            settingsDocument: true,
            identity: 6,
            identityVersion: 2,
        };
        expect(await b.read(MAYA)).toEqual(migrated);
        expect(Object.keys(stored()).sort()).toEqual(
            [MARKS_PREFIX + (await b.slot(MAYA)), `hushos.settings-seen:${SAM}`].sort(),
        );
        // What was moved is the sealed record's now, on every later read.
        expect(await b.read(MAYA)).toEqual(migrated);
        b.unlock(SAM);
        expect((await b.read(SAM)).settings).toBe(40);
        expect(stored()[`hushos.settings-seen:${SAM}`]).toBeUndefined();
    });

    test('a new account key on this browser carries the marks to its slot, and the old record goes', async () => {
        const b = browser();
        b.unlock(MAYA);
        await b.raise(MAYA, { settings: 11, identity: 2, identityVersion: 2 });
        const before = MARKS_PREFIX + (await b.slot(MAYA));
        await b.carry(MAYA, async () => {
            // A master-key rotation: locked, a new root, unlocked again.
            b.unlock(null);
            b.rotate(MAYA);
            b.unlock(MAYA);
        });
        expect(await b.read(MAYA)).toEqual({
            settings: 11,
            settingsDocument: false,
            identity: 2,
            identityVersion: 2,
        });
        expect(Object.keys(stored())).toEqual([MARKS_PREFIX + (await b.slot(MAYA))]);
        expect(stored()[before]).toBeUndefined();
    });

    test('plaintext marks that could not be sealed stay, and still count', async () => {
        local.setItem(`hushos.settings-seen:${MAYA}`, '8');
        const b = browser();
        b.unlock(MAYA);
        b.fill();
        expect((await b.read(MAYA)).settings).toBe(8);
        expect(local.getItem(`hushos.settings-seen:${MAYA}`)).toBe('8');
    });

    test('an own identity served below the highest key version seen is refused', () => {
        const seen = { keyVersion: 3, identityVersion: 2 };
        expect(identityRolledBack({ keyVersion: 2, identityVersion: 2 }, seen)).toBe(true);
        expect(identityRolledBack({ keyVersion: 3, identityVersion: 2 }, seen)).toBe(false);
        expect(identityRolledBack({ keyVersion: 4, identityVersion: 2 }, seen)).toBe(false);
    });

    test('the version 1 form of an identity this device has seen upgraded is refused at the same key version', () => {
        // The upgrade keeps the key version: only the identity version tells them apart.
        const seen = { keyVersion: 3, identityVersion: 2 };
        expect(identityRolledBack({ keyVersion: 3, identityVersion: 1 }, seen)).toBe(true);
        // Nor at a higher key version: no version 1 identity can follow a version 2 one.
        expect(identityRolledBack({ keyVersion: 4, identityVersion: 1 }, seen)).toBe(true);
        // A device that has only ever seen version 1 lets it through, to upgrade it.
        expect(
            identityRolledBack(
                { keyVersion: 3, identityVersion: 1 },
                { keyVersion: 3, identityVersion: 1 },
            ),
        ).toBe(false);
    });
});
