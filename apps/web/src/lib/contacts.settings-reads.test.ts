// @vitest-environment node
import 'fake-indexeddb/auto';
import type { Settings, SettingsEnvelope } from '@hushos/crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { account } from './groups/worker-testkit';

/*
 * One settings read serves the readers that only look (the settings query, the sharing
 * ledger, a family sync's steps) for a short while, so opening the app costs one read
 * instead of one per step. What must never come of it: a copy older than the settings this
 * browser has seen, a copy kept across a guard move from another tab, across a lost
 * compare-and-set or a lock, a rollback that a fresh read would refuse, or settings opened
 * before the identity that checks them. Against a real crypto worker and a server that keeps
 * the settings with its compare-and-set.
 */

const USER = 'a1a1a1a1-0000-4000-8000-000000000001';

// What this browser keeps (the rollback marks), shared by its tabs, in memory.
const kept = new Map<string, string>();
vi.stubGlobal('window', {
    localStorage: {
        get length() {
            return kept.size;
        },
        key: (index: number) => [...kept.keys()][index] ?? null,
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, value),
        removeItem: (key: string) => void kept.delete(key),
    },
});

/* The unlocked account as the auth store holds it, with its subscribers (a lock reaches them). */
const store = vi.hoisted(() => {
    type State = { unlockedUserId: string | null };
    let state: State = { unlockedUserId: 'a1a1a1a1-0000-4000-8000-000000000001' };
    const listeners = new Set<(next: State, previous: State) => void>();
    return {
        getState: () => state,
        subscribe: (listener: (next: State, previous: State) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        set(next: State) {
            const previous = state;
            state = next;
            for (const listener of listeners) listener(next, previous);
        },
    };
});
const auth = vi.hoisted(() => ({ rpc: vi.fn(), settings: vi.fn(), saveSettings: vi.fn() }));
const identity = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/lib/auth-client', () => ({ authClient: { ...auth, store } }));
vi.mock('@/lib/drive-api', () => ({ onStaleIdentity: () => {} }));
vi.mock('@/lib/own-identity', () => ({ openOwnIdentity: () => identity.open() }));

const { compareAndSetSettings, readSettingsForFamilies, readSettingsForWrite, sharingLedger } =
    await import('./contacts');
const { rememberSettingsSeen } = await import('./rollback-marks');

/* This account, its worker, and the server's settings row with its compare-and-set. */
async function world() {
    const me = await account(USER);
    const device = await me.device();
    const server = { version: me.stored.version, envelope: me.stored.envelope };
    auth.rpc.mockImplementation((operation, input) => device.call(operation, input));
    auth.settings.mockImplementation(async () => ({
        settings: server.envelope,
        settingsKey: me.stored.key,
        settingsVersion: server.version,
    }));
    auth.saveSettings.mockImplementation(
        async (input: { expectedVersion: number; nonce: string; ciphertext: string }) => {
            if (input.expectedVersion !== server.version)
                throw new Error('Your settings changed on another device.');
            server.version++;
            server.envelope = {
                version: 2,
                settingsVersion: server.version,
                nonce: input.nonce,
                ciphertext: input.ciphertext,
            };
            return { settingsVersion: server.version };
        },
    );
    /* Another device of this account saves `settings` over whatever is stored. */
    const elsewhere = async (settings: Settings, at = server.version + 1) => {
        const { envelope } = await device.call('settingsSeal', {
            userId: USER,
            settingsVersion: at,
            settings,
        });
        server.version = at;
        server.envelope = envelope as SettingsEnvelope;
    };
    return { server, elsewhere, device };
}

const fetches = () => auth.settings.mock.calls.length;
const opens = () =>
    auth.rpc.mock.calls.filter(([operation]) => operation === 'settingsOpen').length;
const withName = (name: string): Settings => ({
    version: 2,
    contacts: {},
    familyChecks: { [name]: { rosterVersion: 1, with: name, code: [], checkedAt: '' } },
});
const named = (loaded: { settings: { familyChecks?: unknown } }) =>
    Object.keys((loaded.settings.familyChecks as Record<string, unknown> | undefined) ?? {});

/* Moves the clock the reuse window is measured on past it. */
function later() {
    const now = performance.now();
    return vi.spyOn(performance, 'now').mockImplementation(() => now + 60_000);
}

beforeEach(() => {
    kept.clear();
    auth.rpc.mockReset();
    auth.settings.mockReset();
    auth.saveSettings.mockReset();
    identity.open.mockReset();
    identity.open.mockResolvedValue({ envelope: { keyVersion: 1 }, keyVersion: 1 });
    // Every test starts from its own unlock: nothing read before it is held.
    store.set({ unlockedUserId: null });
    store.set({ unlockedUserId: USER });
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('one read for the readers that only look', () => {
    test('a family sync’s steps read and open the settings once, each with a copy of its own', async () => {
        const w = await world();
        await w.elsewhere(withName('first'));
        const first = await readSettingsForFamilies(USER);
        const before = { fetches: fetches(), opens: opens() };
        first.settings.contacts.someone = {} as never;
        const second = await readSettingsForFamilies(USER);
        expect(second.settings.contacts).toEqual({});
        second.settings.contacts.another = {} as never;
        const third = await readSettingsForFamilies(USER);
        expect({ fetches: fetches(), opens: opens() }).toEqual(before);
        expect(before).toEqual({ fetches: 1, opens: 1 });
        // A reader changing its copy changes nobody else's.
        expect(third.settings.contacts).toEqual({});
        expect(named(third)).toEqual(['first']);
    });

    test('readers that start together share one request', async () => {
        const w = await world();
        await w.elsewhere(withName('first'));
        const all = await Promise.all([
            readSettingsForFamilies(USER),
            readSettingsForFamilies(USER),
            readSettingsForFamilies(USER),
        ]);
        expect(fetches()).toBe(1);
        expect(all.map(named)).toEqual([['first'], ['first'], ['first']]);
    });
});

describe('readers that act read now, even while a copy is held', () => {
    test('a family act (a join, a creation, an admission sent, a check) reads what another device saved', async () => {
        const w = await world();
        expect(named(await readSettingsForFamilies(USER))).toEqual([]);
        await w.elsewhere(withName('other-device'));
        expect(named(await readSettingsForFamilies(USER))).toEqual([]);
        expect(named(await readSettingsForFamilies(USER, { fresh: true }))).toEqual([
            'other-device',
        ]);
    });

    test('the sharing ledger a rotation seals over is the one stored now', async () => {
        const w = await world();
        const ledger = sharingLedger(() => USER);
        expect(await ledger.read()).toEqual({ shares: {}, links: {} });
        await w.elsewhere({
            version: 2,
            contacts: {},
            sharing: { shares: { n1: ['b'] }, links: {} },
        });
        expect(await ledger.read()).toEqual({ shares: {}, links: {} });
        expect(await ledger.read({ fresh: true })).toEqual({ shares: { n1: ['b'] }, links: {} });
    });
});

describe('what a held copy never outlives', () => {
    test('a guard move another tab announces: the next reader reads afresh', async () => {
        const w = await world();
        expect(named(await readSettingsForFamilies(USER))).toEqual([]);
        // Another tab continues someone: its settings save lands, and it says so on the channel.
        await w.elsewhere(withName('other-tab'));
        const channel = new BroadcastChannel('hushos-contact-guard');
        channel.postMessage({ userId: USER, contactId: 'b2b2b2b2-0000-4000-8000-000000000002' });
        channel.close();
        await vi.waitFor(async () =>
            expect(named(await readSettingsForFamilies(USER))).toEqual(['other-tab']),
        );
    });

    test('another tab’s later settings, before any message arrives: the marks it raised say so', async () => {
        const w = await world();
        expect(named(await readSettingsForFamilies(USER))).toEqual([]);
        const reads = fetches();
        // Another tab of this browser saves and raises the marks every tab shares; its
        // BroadcastChannel message has not arrived (nothing orders the two).
        await w.elsewhere(withName('other-tab'));
        await rememberSettingsSeen(USER, w.server.version);
        expect(named(await readSettingsForFamilies(USER))).toEqual(['other-tab']);
        expect(fetches()).toBe(reads + 1);
    });

    test('a compare-and-set another device won: the next read is the stored settings, not the copy', async () => {
        const w = await world();
        const held = await readSettingsForFamilies(USER);
        await w.elsewhere(withName('other-device'));
        // A family pin saved over the copy's version is refused by the server…
        expect(await compareAndSetSettings(USER, held.version, withName('mine'))).toBe(false);
        // …and the acceptance that follows reads what the other device stored, opened afresh.
        const opened = opens();
        const again = await readSettingsForFamilies(USER);
        expect(named(again)).toEqual(['other-device']);
        expect(again.version).toBe(w.server.version);
        expect(opens()).toBe(opened + 1);
        // Saved over the settings as they are, it lands.
        expect(await compareAndSetSettings(USER, again.version, withName('mine'))).toBe(true);
    });

    test('a write that landed: the worker opens what the server then serves, not what was sealed', async () => {
        await world();
        const held = await readSettingsForFamilies(USER);
        expect(await compareAndSetSettings(USER, held.version, withName('mine'))).toBe(true);
        const opened = opens();
        expect(named(await readSettingsForFamilies(USER))).toEqual(['mine']);
        expect(opens()).toBe(opened + 1);
    });

    test('a lock: the worker forgot the settings, so they are read and opened again after the unlock', async () => {
        const w = await world();
        await readSettingsForFamilies(USER);
        await w.elsewhere(withName('while-locked'));
        store.set({ unlockedUserId: null });
        await expect(readSettingsForFamilies(USER)).rejects.toThrow('Unlock your account first.');
        store.set({ unlockedUserId: USER });
        const opened = opens();
        expect(named(await readSettingsForFamilies(USER))).toEqual(['while-locked']);
        expect(opens()).toBe(opened + 1);
    });
});

describe('fresh reads still check everything', () => {
    test('a rollback is refused by a fresh read while a newer copy is held, and by the next sync', async () => {
        const w = await world();
        await w.elsewhere(withName('newer'));
        const held = await readSettingsForFamilies(USER);
        // The server goes back to an older document at an older sequence.
        await w.elsewhere(withName('older'), held.version - 1);
        // A reader within the window is never handed the older one.
        expect(named(await readSettingsForFamilies(USER))).toEqual(['newer']);
        // The next sync, past the window, reads afresh and refuses it.
        const clock = later();
        await expect(readSettingsForFamilies(USER)).rejects.toThrow(/older settings/);
        clock.mockRestore();
        // A read that must be fresh (a save's base, an act under the lock) refuses it at once,
        // and once one has, no reader goes on with the copy: each reads, and refuses, for itself.
        await w.elsewhere(withName('newer'), held.version);
        expect(named(await readSettingsForFamilies(USER))).toEqual(['newer']);
        await w.elsewhere(withName('older'), held.version - 1);
        await expect(readSettingsForWrite(USER)).rejects.toThrow(/older settings/);
        await expect(readSettingsForFamilies(USER)).rejects.toThrow(/older settings/);
    });

    test('settings fetched beside the identity are not opened when the identity fails', async () => {
        const w = await world();
        await w.elsewhere(withName('first'));
        identity.open.mockRejectedValueOnce(new Error('The identity didn’t open.'));
        await expect(readSettingsForFamilies(USER)).rejects.toThrow('The identity didn’t open.');
        expect(opens()).toBe(0);
        // Nothing of the failed read is held: the next one opens the identity and the settings.
        expect(named(await readSettingsForFamilies(USER))).toEqual(['first']);
        expect(opens()).toBe(1);
    });
});

describe('the reuse window', () => {
    test('ends on either clock: a device that slept, or a clock set back, reads again', async () => {
        const w = await world();
        expect(named(await readSettingsForFamilies(USER))).toEqual([]);
        await w.elsewhere(withName('while asleep'));
        // performance.now() stood still while the device slept; the wall clock moved on.
        const wall = Date.now();
        const slept = vi.spyOn(Date, 'now').mockImplementation(() => wall + 60_000);
        expect(named(await readSettingsForFamilies(USER))).toEqual(['while asleep']);
        slept.mockRestore();
        await w.elsewhere(withName('clock set back'));
        // The wall clock now reads before the copy was taken.
        const back = vi.spyOn(Date, 'now').mockImplementation(() => wall - 60_000);
        expect(named(await readSettingsForFamilies(USER))).toEqual(['clock set back']);
        back.mockRestore();
    });
});
