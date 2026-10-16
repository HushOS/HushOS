// @vitest-environment node
import type { CreateGroupBody, SettingsEnvelope } from '@hushos/crypto';
import { digest } from '@hushos/crypto/signatures';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { GroupsApi } from './groups/api';
import type { GroupContext } from './groups/context';
import { createFamily } from './groups/outbox';
import { createMemoryGroupStore } from './groups/store';
import { account, bytes } from './groups/worker-testkit';

/*
 * Families on an account whose settings this device could not open: a
 * version 1 document (sealed the old way, opened by no client), whether the
 * server serves it as none or as its version 1 envelope. Nothing is saved
 * over it on its own (a server hiding real settings could otherwise get an
 * unmarked device to wipe every pin), the worker is told nothing, and the
 * person is told plainly what to do. A device that has opened version 2
 * settings refuses either answer as a rollback.
 */

const USER = 'a1a1a1a1-0000-4000-8000-000000000001';

// What this browser keeps (the rollback marks), in memory.
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

const auth = vi.hoisted(() => ({ rpc: vi.fn(), settings: vi.fn(), saveSettings: vi.fn() }));
vi.mock('@/lib/auth-client', () => ({
    authClient: {
        ...auth,
        store: { subscribe: () => () => {}, getState: () => ({ unlockedUserId: USER }) },
    },
}));
vi.mock('@/lib/drive-api', () => ({ onStaleIdentity: () => {} }));
vi.mock('@/lib/own-identity', () => ({
    openOwnIdentity: async () => ({ envelope: { keyVersion: 1 }, keyVersion: 1 }),
}));

const { FAMILY_SETTINGS_NEEDED, compareAndSetSettings, readSettingsForFamilies } =
    await import('./contacts');

/* The account, its worker, and the server's settings row: a version 1 document at sequence 3. */
async function legacyAccount() {
    const alice = await account(USER);
    // The testkit stores an empty version 2 document for a new device; this account has none.
    alice.stored.envelope = {} as SettingsEnvelope;
    const device = await alice.device();
    const server = {
        version: 3,
        envelope: null as SettingsEnvelope | null,
        saves: 0,
        created: false,
    };
    auth.rpc.mockImplementation((operation, input) => device.call(operation, input));
    auth.settings.mockImplementation(async () => ({
        settings: server.envelope,
        settingsKey: alice.stored.key,
        settingsVersion: server.version,
    }));
    auth.saveSettings.mockImplementation(
        async (input: { expectedVersion: number; nonce: string; ciphertext: string }) => {
            if (input.expectedVersion !== server.version)
                throw new Error('Your settings changed on another device.');
            server.saves++;
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
    return { alice, device, server };
}

/* What the worker was asked to take as settings. */
const settingsOpens = () =>
    auth.rpc.mock.calls.filter(([operation]) => operation === 'settingsOpen');

/* A server for route 1 and what a first sync reads, as two-tabs.test.ts keeps one. */
function familyServer(alice: Awaited<ReturnType<typeof account>>, server: { created: boolean }) {
    let created: CreateGroupBody | null = null;
    const head = () => ({ version: 1, digest: '', revision: 1, groupKeyVersion: 1 });
    return {
        createGroup: async (body: CreateGroupBody) => {
            created = body;
            server.created = true;
            return { group: {} };
        },
        rosters: async () => ({
            rosters: [{ version: 1, ...created!.roster }],
            successions: [],
            firstKeys: created!.groupKey,
            signerKeys: {
                [await digest(bytes(alice.served.mlDsaPublicKey))]: alice.served.mlDsaPublicKey,
            },
            head: head(),
            next: null,
        }),
        identities: async () => ({
            identities: [{ userId: USER, identity: alice.served, links: [] }],
            next: null,
        }),
        spaces: async () => ({ spaces: [] }),
    } as unknown as GroupsApi;
}

describe('families on an account whose settings did not open here', () => {
    beforeEach(() => {
        kept.clear();
        auth.rpc.mockClear();
    });

    test('creating a family saves nothing and says what to do', async () => {
        const { alice, device, server } = await legacyAccount();
        const ctx: GroupContext = {
            userId: USER,
            api: familyServer(alice, server),
            rpc: device.call as GroupContext['rpc'],
            store: createMemoryGroupStore(),
            settings: {
                read: () => readSettingsForFamilies(USER),
                write: (version, settings) => compareAndSetSettings(USER, version, settings),
            },
            lock: (_groupId, work) => work(),
            sleep: async () => {},
            now: () => new Date('2026-10-17T12:00:00.000Z'),
            identities: async () => ({ identity: alice.identity, history: [] }),
            deleteMirrors: async () => {},
            rotations: null,
        };
        await expect(createFamily(ctx, 'Lindqvist family')).rejects.toThrow(FAMILY_SETTINGS_NEEDED);
        expect(server.saves).toBe(0);
        expect(server.created).toBe(false);
        expect(settingsOpens()).toEqual([]);
    });

    test('a version 1 envelope is no reading of "no settings", and after version 2 a rollback', async () => {
        const { server } = await legacyAccount();
        server.envelope = { version: 1, settingsVersion: 3, nonce: 'n', ciphertext: 'c' };
        await expect(readSettingsForFamilies(USER)).rejects.toThrow(FAMILY_SETTINGS_NEEDED);
        expect(settingsOpens()).toEqual([]);
        // This device then saves version 2 settings (a contact added) and opens them.
        server.envelope = null;
        await compareAndSetSettings(USER, 3, { version: 2, contacts: {} });
        await readSettingsForFamilies(USER);
        expect(settingsOpens()).toHaveLength(1);
        // The server goes back to the version 1 document, or to none: refused, nothing saved.
        server.envelope = { version: 1, settingsVersion: 4, nonce: 'n', ciphertext: 'c' };
        await expect(readSettingsForFamilies(USER)).rejects.toThrow(/older settings/);
        server.envelope = null;
        await expect(readSettingsForFamilies(USER)).rejects.toThrow(/older settings/);
        expect(server.saves).toBe(1);
    });
});
