// @vitest-environment node
import {
    openRollbackMarks,
    RollbackMarksError,
    rollbackMarksSlot,
    updateRollbackMarks,
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
 * account, whatever identity or account key the account has now; at rest it
 * must say nothing, and a record that does not open must never read as
 * "nothing seen".
 *
 * The sealing is the worker's own (@hushos/crypto/rollback-marks), under the
 * account's settings key as the server serves it; "locked" is the account the
 * worker would refuse.
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

const key32 = () => crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;

/*
 * The server's side: each account's settings key and its envelope (wrapped under the account
 * key, bound to the account), the same whatever root unwraps it, since a master-key rotation
 * re-wraps it. `withhold` serves none, `down` answers nothing; `created` counts keys made.
 */
type Envelope = { nonce: string; ciphertext: string };
function server() {
    const keys = new Map<string, { key: Uint8Array<ArrayBuffer>; envelope: Envelope }>();
    /* What an envelope unwraps to, and for whom: another account's does not open. */
    const wraps = new Map<string, { userId: string; key: Uint8Array<ArrayBuffer> }>();
    const withheld = new Set<string>();
    let down = false;
    let created = 0;
    /* Answers given in turn before the usual one: an envelope, or 'down'. */
    const script: (Envelope | 'down')[] = [];
    return {
        served(userId: string) {
            const next = script.shift();
            if (next === 'down' || (next === undefined && down))
                throw new Error('Something went wrong.');
            if (next) return next;
            return withheld.has(userId) ? null : (keys.get(userId)?.envelope ?? null);
        },
        script,
        /* The key an envelope wraps, as a worker would open it. */
        keyOf: (envelope: Envelope) => wraps.get(envelope.ciphertext)?.key ?? null,
        /*
         * A master-key rotation: the same key, wrapped afresh under the new account key; the
         * old envelope no longer opens under the account key in use.
         */
        rotate(userId: string) {
            const held = keys.get(userId)!;
            wraps.delete(held.envelope.ciphertext);
            const envelope = {
                nonce: `r${++created}`,
                ciphertext: crypto.randomUUID().replaceAll('-', ''),
            };
            keys.set(userId, { key: held.key, envelope });
            wraps.set(envelope.ciphertext, { userId, key: held.key });
            return envelope;
        },
        /* Another settings key for the account, as two devices that raced to make one leave. */
        another(userId: string) {
            const key = key32();
            const envelope = {
                nonce: `a${++created}`,
                ciphertext: crypto.randomUUID().replaceAll('-', ''),
            };
            wraps.set(envelope.ciphertext, { userId, key });
            return envelope;
        },
        unwrap: (userId: string, envelope: Envelope) => {
            const found = wraps.get(envelope.ciphertext);
            return found?.userId === userId ? found.key : null;
        },
        store(userId: string) {
            created++;
            const key = key32();
            const envelope = {
                nonce: `n${created}`,
                ciphertext: crypto.randomUUID().replaceAll('-', ''),
            };
            keys.set(userId, { key, envelope });
            wraps.set(envelope.ciphertext, { userId, key });
            return envelope;
        },
        withhold: (userId: string) => withheld.add(userId),
        down: (value: boolean) => (down = value),
        created: () => created,
    };
}

/* One tab of the browser: its own worker state, the shared localStorage, and a lock. */
function browser(keys = server(), exclusive?: <T>(work: () => Promise<T>) => Promise<T>) {
    let unlocked: string | null = null;
    let writes: 'ok' | 'full' = 'ok';
    /* What the worker has open after `ready`. */
    const open = new Map<string, Uint8Array<ArrayBuffer>>();
    let onSeal: (() => void) | undefined;
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
    const keyOf = (userId: string) => {
        const key = open.get(userId);
        if (!key) throw new Error('Open your settings key first.');
        return key;
    };
    /* As contacts.ts marksKeyReady does it, against the server above. */
    async function ready(userId: string, create: boolean, kept: Envelope | null) {
        const fromKept = () => {
            const key = kept && keys.unwrap(userId, kept);
            if (key) open.set(userId, key);
            return Boolean(key);
        };
        let served: Envelope | null;
        try {
            served = keys.served(userId);
        } catch (error) {
            if (fromKept()) return kept;
            throw error;
        }
        if (served) {
            open.set(userId, keys.unwrap(userId, served)!);
            return served;
        }
        if (fromKept()) return kept;
        if (!create) return null;
        const made = keys.store(userId);
        open.set(userId, keys.unwrap(userId, made)!);
        return made;
    }
    const marks = createRollbackMarks({
        sealer: {
            ready,
            // As the worker's rollbackMarksUpdate: one step under the one key it holds.
            async update(userId, envelope, to) {
                const key = keyOf(userId);
                if (Object.keys(to).length) onSeal?.();
                return updateRollbackMarks(key, userId, envelope, to).catch((error: unknown) => {
                    if (error instanceof RollbackMarksError) return null;
                    throw error;
                });
            },
        },
        storage: () => storage,
        account: () => unlocked,
        ...(exclusive ? { exclusive } : {}),
    });
    return {
        ...marks,
        keys,
        unlock(userId: string | null) {
            unlocked = userId;
            open.clear();
        },
        fill: () => (writes = 'full'),
        /* Something another tab does while this one seals. */
        whileSealing: (work: () => void) => (onSeal = work),
    };
}

/* A lock across tabs, as navigator.locks gives one. */
function sharedLock() {
    let chain: Promise<unknown> = Promise.resolve();
    return <T>(work: () => Promise<T>) => {
        const next = chain.then(work, work);
        chain = next.catch(() => {});
        return next;
    };
}
const slotKey = async (userId: string) => MARKS_PREFIX + (await rollbackMarksSlot(userId));

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
        expect(Object.keys(all)).toEqual([await slotKey(MAYA)]);
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
        const key = await slotKey(MAYA);
        const record = JSON.parse(local.getItem(key)!) as { marks: string };
        const envelope = record.marks;
        record.marks = `${envelope.slice(0, -2)}${envelope.endsWith('AA') ? 'BA' : 'AA'}`;
        const damaged = JSON.stringify(record);
        local.setItem(key, damaged);
        await expect(b.read(MAYA)).rejects.toBeInstanceOf(MarksUnreadableError);
        await expect(b.raise(MAYA, { settings: 1 })).rejects.toBeInstanceOf(MarksUnreadableError);
        expect(local.getItem(key)).toBe(damaged);
    });

    test('another account’s record put in this account’s slot fails closed', async () => {
        const b = browser();
        b.unlock(SAM);
        await b.raise(SAM, { settings: 1 });
        const sams = local.getItem(await slotKey(SAM))!;
        b.unlock(MAYA);
        await b.raise(MAYA, { settings: 30 });
        local.setItem(await slotKey(MAYA), sams);
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
            [await slotKey(MAYA), `hushos.settings-seen:${SAM}`].sort(),
        );
        // What was moved is the sealed record's now, on every later read.
        expect(await b.read(MAYA)).toEqual(migrated);
        b.unlock(SAM);
        expect((await b.read(SAM)).settings).toBe(40);
        expect(stored()[`hushos.settings-seen:${SAM}`]).toBeUndefined();
    });

    test('two tabs raising at once both stay', async () => {
        // Each tab has its own module and worker; they share localStorage and the Web Lock.
        const keys = server();
        const lock = sharedLock();
        const one = browser(keys, lock);
        const two = browser(keys, lock);
        one.unlock(MAYA);
        two.unlock(MAYA);
        await one.raise(MAYA, { settings: 1 });
        await Promise.all([
            one.raise(MAYA, { settings: 9 }),
            two.raise(MAYA, { identity: 4, identityVersion: 2 }),
            one.raise(MAYA, { settingsDocument: true }),
            two.raise(MAYA, { settings: 8 }),
        ]);
        const read = { settings: 9, settingsDocument: true, identity: 4, identityVersion: 2 };
        expect(await one.read(MAYA)).toEqual(read);
        expect(await two.read(MAYA)).toEqual(read);
    });

    test('a new account key changes nothing: the marks open under the settings key it re-wraps', async () => {
        // A master-key rotation (here, or on another device), or the server replaying the root
        // from before one: the settings key is the same, so are the marks, with nothing carried.
        const keys = server();
        const before = browser(keys);
        before.unlock(MAYA);
        await before.raise(MAYA, { settings: 21, identity: 5, identityVersion: 2 });
        const after = browser(keys);
        after.unlock(MAYA);
        expect(await after.read(MAYA)).toEqual({
            settings: 21,
            settingsDocument: false,
            identity: 5,
            identityVersion: 2,
        });
    });

    test('the marks open while the server cannot serve the settings, or withholds the key', async () => {
        const keys = server();
        const b = browser(keys);
        b.unlock(MAYA);
        await b.raise(MAYA, { settings: 14, identity: 2 });
        for (const trouble of [
            () => keys.down(true),
            () => (keys.down(false), keys.withhold(MAYA)),
        ]) {
            trouble();
            // A fresh unlock: nothing open in the worker yet.
            const tab = browser(keys);
            tab.unlock(MAYA);
            expect((await tab.read(MAYA)).settings).toBe(14);
        }
    });

    test('with nothing kept that opens, a withheld key leaves the record refused and makes none', async () => {
        const keys = server();
        const b = browser(keys);
        b.unlock(MAYA);
        await b.raise(MAYA, { settings: 14 });
        // A record whose kept envelope is not this account's (or was never kept).
        const slot = await slotKey(MAYA);
        local.setItem(
            slot,
            JSON.stringify({
                ...JSON.parse(local.getItem(slot)!),
                key: { nonce: 'x', ciphertext: 'not-hers' },
            }),
        );
        keys.withhold(MAYA);
        const fresh = browser(keys);
        fresh.unlock(MAYA);
        await expect(fresh.read(MAYA)).rejects.toBeInstanceOf(MarksUnreadableError);
        await expect(fresh.raise(MAYA, { settings: 1 })).rejects.toBeInstanceOf(
            MarksUnreadableError,
        );
        expect(keys.created()).toBe(1);
    });

    test('a server that does not answer, with nothing kept, is an error to try again, not unreadable marks', async () => {
        const keys = server();
        const b = browser(keys);
        b.unlock(MAYA);
        await b.raise(MAYA, { settings: 3 });
        const slot = await slotKey(MAYA);
        local.setItem(slot, JSON.stringify({ ...JSON.parse(local.getItem(slot)!), key: null }));
        keys.down(true);
        const fresh = browser(keys);
        fresh.unlock(MAYA);
        const failure = await fresh.read(MAYA).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(MarksUnreadableError);
    });

    test('an account with no settings key gets one at its first mark, never just for reading', async () => {
        const keys = server();
        const b = browser(keys);
        b.unlock(MAYA);
        expect((await b.read(MAYA)).settings).toBe(0);
        expect(keys.created()).toBe(0);
        await b.raise(MAYA, { identity: 1, identityVersion: 2 });
        expect(keys.created()).toBe(1);
    });

    test('a higher plaintext mark an older tab writes during the migration is sealed, not lost', async () => {
        local.setItem(`hushos.settings-seen:${MAYA}`, '5');
        const b = browser();
        b.unlock(MAYA);
        let once = true;
        b.whileSealing(() => {
            // A tab still on the earlier version saves settings meanwhile.
            if (once) local.setItem(`hushos.settings-seen:${MAYA}`, '12');
            once = false;
        });
        // It counts at once, and stays in the clear until the sealed record holds it.
        expect((await b.read(MAYA)).settings).toBe(12);
        expect(local.getItem(`hushos.settings-seen:${MAYA}`)).toBe('12');
        expect((await b.read(MAYA)).settings).toBe(12);
        expect(local.getItem(`hushos.settings-seen:${MAYA}`)).toBeNull();
        expect((await b.read(MAYA)).settings).toBe(12);
    });

    test('plaintext an older tab keeps rewriting stays until it settles, and still counts', async () => {
        local.setItem(`hushos.identity-seen:${MAYA}`, '1');
        const b = browser();
        b.unlock(MAYA);
        let next = 1;
        b.whileSealing(() => local.setItem(`hushos.identity-seen:${MAYA}`, String(++next)));
        const read = await b.read(MAYA);
        // Never deleted while it moves, and what was last written counts.
        expect(local.getItem(`hushos.identity-seen:${MAYA}`)).not.toBeNull();
        expect(read.identity).toBe(Number(local.getItem(`hushos.identity-seen:${MAYA}`)));
    });

    test('a raise never seals the marks over under a settings key they did not open under', async () => {
        const keys = server();
        const b = browser(keys);
        b.unlock(MAYA);
        await b.raise(MAYA, { settings: 4 });
        const slot = await slotKey(MAYA);
        const kept = (JSON.parse(local.getItem(slot)!) as { key: Envelope }).key;
        const k1 = keys.keyOf(kept)!;
        // A fresh unlock: the server does not answer at first (the kept envelope opens the key
        // the marks are under), then answers with another settings key of the account's.
        const other = keys.another(MAYA);
        keys.script.push('down', other, other, other);
        const tab = browser(keys);
        tab.unlock(MAYA);
        await tab.raise(MAYA, { settings: 9 }).catch(() => {});
        const record = JSON.parse(local.getItem(slot)!) as { marks: string; key: Envelope };
        // Still under the key they opened under, and only there.
        expect(record.key).toEqual(kept);
        await expect(openRollbackMarks(k1, MAYA, record.marks)).resolves.toBeTruthy();
        await expect(
            openRollbackMarks(keys.keyOf(other)!, MAYA, record.marks),
        ).rejects.toBeInstanceOf(RollbackMarksError);
    });

    test('after a master-key rotation, the kept envelope is the re-wrapped one, so it still opens', async () => {
        const keys = server();
        const b = browser(keys);
        b.unlock(MAYA);
        await b.raise(MAYA, { settings: 6, identity: 2 });
        keys.rotate(MAYA);
        // Read with the server answering: nothing rises, but the marks opened under its envelope.
        const after = browser(keys);
        after.unlock(MAYA);
        expect((await after.read(MAYA)).settings).toBe(6);
        // Later the server does not answer: the kept envelope must open under the new account key.
        keys.down(true);
        const offline = browser(keys);
        offline.unlock(MAYA);
        expect(await offline.read(MAYA)).toMatchObject({ settings: 6, identity: 2 });
    });

    test('a plaintext mark an older tab raises while the migration deletes is never deleted', async () => {
        local.setItem(`hushos.settings-seen:${MAYA}`, '5');
        local.setItem(`hushos.identity-seen:${MAYA}`, '1');
        const b = browser();
        b.unlock(MAYA);
        // Just as the first plaintext key goes, a tab on the earlier version raises the other.
        const removeItem = local.removeItem;
        local.removeItem = (key: string) => {
            if (key === `hushos.settings-seen:${MAYA}`)
                local.setItem(`hushos.identity-seen:${MAYA}`, '4');
            removeItem(key);
        };
        try {
            expect((await b.read(MAYA)).identity).toBe(4);
        } finally {
            local.removeItem = removeItem;
        }
        expect(local.getItem(`hushos.identity-seen:${MAYA}`)).toBe('4');
        expect((await b.read(MAYA)).identity).toBe(4);
        expect(local.getItem(`hushos.identity-seen:${MAYA}`)).toBeNull();
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
