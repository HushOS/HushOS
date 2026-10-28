// @vitest-environment node
import 'fake-indexeddb/auto';
import type { ContactIdentity } from '@hushos/auth/api';
import type { SettingsEnvelope } from '@hushos/crypto';
import { pinTrust } from '@hushos/crypto/pins';
import { CHECK_MANAGER_FIRST } from '@hushos/crypto/protocol';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';
import { createIndexedDbContactGuard, type GuardSealer } from './contact-guard';
import type { GroupContext } from './groups/context';
import { createFamily, stageChange } from './groups/outbox';
import { ALICE, BOB, familyServer } from './groups/server-testkit';
import { fetchServed, syncGroup } from './groups/sync';
import { account } from './groups/worker-testkit';

/*
 * Checking each other in a family (docs/optional-verification.md 3.4, 6.10),
 * and letting someone in without words (3.2), through the app's own contacts
 * layer and the real crypto worker: Alice lets Bob in with one click (a
 * first-seen pin of him), Bob's device joins on first use, and the two compare
 * the same twelve words. They match writes, on Alice's side, the family's
 * check record and a verified pin of Bob from his entry, in one settings save;
 * They don't match writes nothing. The one-way path for an older app reads
 * the old join code and writes nothing either, whatever keys the server
 * planted.
 */

vi.setConfig({ testTimeout: 30_000 });

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

const auth = vi.hoisted(() => ({
    rpc: vi.fn(),
    settings: vi.fn(),
    saveSettings: vi.fn(),
    lookupContact: vi.fn(),
    contactSuccession: vi.fn(),
}));
vi.mock('@/lib/auth-client', () => ({
    authClient: {
        ...auth,
        store: { subscribe: () => () => {}, getState: () => ({ unlockedUserId: ALICE }) },
    },
}));
vi.mock('@/lib/drive-api', () => ({ onStaleIdentity: () => {} }));
vi.mock('@/lib/own-identity', () => ({
    openOwnIdentity: async () => ({ envelope: { keyVersion: 1 }, keyVersion: 1 }),
}));

const { compareAndSetSettings, readSettingsForFamilies, setContactGuard, contactGuardEntry } =
    await import('./contacts');
const { keepInvitedRole, pendingRolesOf, savePendingRoles, tidiedPendingRoles } =
    await import('./family-pending');
const {
    continueMembers,
    familyCheckCode,
    familyCheckMatch,
    letInWithoutWords,
    memberStanding,
    memberStandings,
    olderAppCode,
} = await import('./family-trust');

const BOB_EMAIL = `${BOB}@example.com`;

/*
 * Alice's family with nobody else in it, her device running through lib/contacts.ts as the app
 * does: the settings row with the server's compare-and-set, her contact guard in IndexedDB, and
 * the accounts the server serves by email (`serve`).
 */
async function aliceFamily() {
    kept.clear();
    const server = await familyServer();
    const ctx: GroupContext = await server.device();
    // No contacts yet: the testkit's device comes with pins of everyone, which this flow writes.
    const first = await ctx.settings.read();
    await ctx.settings.write(first.version, { ...first.settings, contacts: {} });
    const stored = server.people[ALICE].stored;
    auth.rpc.mockImplementation((operation, input) => ctx.rpc(operation as never, input as never));
    auth.settings.mockImplementation(async () => ({
        settings: stored.envelope,
        settingsKey: stored.key,
        settingsVersion: stored.version,
    }));
    auth.saveSettings.mockImplementation(
        async (input: { expectedVersion: number; nonce: string; ciphertext: string }) => {
            if (input.expectedVersion !== stored.version)
                throw new Error('Your settings changed on another device.');
            stored.version++;
            stored.envelope = {
                version: 2,
                settingsVersion: stored.version,
                nonce: input.nonce,
                ciphertext: input.ciphertext,
            } as SettingsEnvelope;
            return { settingsVersion: stored.version };
        },
    );
    const served = new Map<string, ContactIdentity>();
    const serve = (identity: (typeof server.people)[typeof BOB]['served']) =>
        served.set(BOB_EMAIL, {
            userId: BOB,
            email: BOB_EMAIL,
            name: 'Bob Lindqvist',
            identityVersion: 2,
            ...identity,
        } as ContactIdentity);
    serve(server.people[BOB].served);
    auth.lookupContact.mockImplementation(async (email: string) => ({
        contact: served.get(email)!,
    }));
    auth.contactSuccession.mockResolvedValue({ links: [] });
    // The same worker the family layer runs on (the testkit types its calls as the groups' only).
    const call = ctx.rpc as unknown as (operation: string, input: unknown) => Promise<never>;
    const sealer: GuardSealer = {
        ready: async () => {},
        ids: async (userId, contactIds) =>
            ((await call('contactGuardIds', { userId, contactIds })) as { ids: string[] }).ids,
        seal: async (userId, rows) =>
            (
                (await call('contactGuardSeal', { userId, rows })) as {
                    rows: { id: string; envelope: string }[];
                }
            ).rows,
        open: async (userId, kind, rows) =>
            (
                (await call('contactGuardOpen', { userId, kind, rows })) as {
                    rows: ({ contactId: string; value: unknown } | null)[];
                }
            ).rows,
    };
    setContactGuard({
        store: createIndexedDbContactGuard(sealer, `guard-${crypto.randomUUID()}`),
        persist: async () => true,
    });
    ctx.settings = {
        read: () => readSettingsForFamilies(ALICE),
        write: (version, settings) => compareAndSetSettings(ALICE, version, settings),
    };
    const { groupId, outcome } = await createFamily(ctx, 'Lindqvist');
    expect(outcome.status).toBe('landed');
    const queryClient = new QueryClient();
    /* Let them in, as the family page does, with what route 16 serves for Bob now. */
    const letBobIn = async (identity = server.people[BOB].served) => {
        const result = await letInWithoutWords(queryClient, ALICE, ctx, groupId, {
            userId: BOB,
            email: BOB_EMAIL,
            roles: [],
            identity,
        });
        if (result.outcome !== 'staged') throw new Error(result.outcome);
        expect(result.staged).toMatchObject({ status: 'sent', outcome: { status: 'landed' } });
    };
    const settings = async () => (await readSettingsForFamilies(ALICE)).settings;
    const view = async () => {
        const synced = await syncGroup(ctx, groupId);
        if (synced.status !== 'accepted') throw new Error(synced.status);
        return synced.view;
    };
    return { server, ctx, groupId, queryClient, serve, letBobIn, settings, view, stored };
}

const bob = { userId: BOB, email: BOB_EMAIL, name: 'Bob Lindqvist' };

/* Bob's device: let in, it joins on first use, then works out its own words for Alice. */
async function bobsWords(f: Awaited<ReturnType<typeof aliceFamily>>) {
    f.server.as(BOB);
    try {
        const ctx = await f.server.deviceOf(BOB);
        const { joinStatus } = await import('./groups/join');
        expect(await joinStatus(ctx, f.groupId)).toMatchObject({ status: 'joined' });
        const { served } = await fetchServed(ctx, f.groupId, 0);
        return await ctx.rpc('groupPairCode', {
            groupId: f.groupId,
            userId: ALICE,
            rosters: served.rosters,
        });
    } finally {
        f.server.as(ALICE);
    }
}

describe('checking each other in a family', () => {
    test('both screens show the same words; They match writes the check and a verified pin of Bob in one save, and They don’t match writes nothing', async () => {
        const f = await aliceFamily();
        await f.letBobIn();
        // Let in with no words: Alice holds Bob first seen, and the member list says Not verified.
        expect(await pinTrust((await f.settings()).contacts[BOB]!)).toBe('seen');
        expect((await memberStandings(ALICE, await f.view())).get(BOB)).toBe('not-verified');
        const theirs = await bobsWords(f);
        const mine = await familyCheckCode(f.ctx, f.groupId, BOB);
        expect(mine).toMatchObject({ status: 'code', rosterVersion: 2 });
        expect(theirs).toEqual({
            status: 'code',
            rosterVersion: 2,
            code: (mine as { code: string[] }).code,
        });
        const shown = mine as { rosterVersion: number; code: string[] };
        // They don't match (or the words differ): nothing at all is written.
        const before = f.stored.version;
        const other = [...shown.code.slice(1), shown.code[0]!];
        expect(
            await familyCheckMatch(f.queryClient, ALICE, f.ctx, f.groupId, bob, {
                rosterVersion: shown.rosterVersion,
                code: other,
            }),
        ).toEqual({ checked: false, verified: false });
        expect(f.stored.version).toBe(before);
        expect(await pinTrust((await f.settings()).contacts[BOB]!)).toBe('seen');
        // They match: the check record and the verified pin, in one save.
        expect(await familyCheckMatch(f.queryClient, ALICE, f.ctx, f.groupId, bob, shown)).toEqual({
            checked: true,
            verified: true,
        });
        expect(f.stored.version).toBe(before + 1);
        const after = await f.settings();
        expect(after.familyChecks?.[f.groupId]).toEqual({
            rosterVersion: 2,
            with: BOB,
            code: shown.code,
            checkedAt: expect.any(String),
        });
        expect(await pinTrust(after.contacts[BOB]!)).toBe('verified');
        // This device's guard moved with it, and the member list says Verified.
        expect(await contactGuardEntry(ALICE, BOB)).toMatchObject({ verified: true });
        expect((await memberStandings(ALICE, await f.view())).get(BOB)).toBe('verified');
    });

    test('over a pin taken on the family’s word, They match makes it this person’s own check: Verified, and the manager role goes ahead', async () => {
        const f = await aliceFamily();
        await f.letBobIn();
        await bobsWords(f);
        const shown = (await familyCheckCode(f.ctx, f.groupId, BOB)) as {
            rosterVersion: number;
            code: string[];
        };
        // Bob's pin, as Trust as family left it before 3.7: his very keys, on the family's word.
        expect(await familyCheckMatch(f.queryClient, ALICE, f.ctx, f.groupId, bob, shown)).toEqual({
            checked: true,
            verified: true,
        });
        const loaded = await readSettingsForFamilies(ALICE);
        await compareAndSetSettings(ALICE, loaded.version, {
            ...loaded.settings,
            contacts: {
                ...loaded.settings.contacts,
                [BOB]: {
                    ...loaded.settings.contacts[BOB]!,
                    trustedVia: f.groupId,
                    trustedViaFamily: 'Lindqvist',
                } as never,
            },
        });
        expect((await memberStandings(ALICE, await f.view())).get(BOB)).toBe('not-verified');
        await expect(
            stageChange(f.ctx, f.groupId, { kind: 'roles', userId: BOB, roles: ['members'] }),
        ).rejects.toThrow(CHECK_MANAGER_FIRST);
        // They match again: the family's word goes, and the check is this person's own.
        expect(await familyCheckMatch(f.queryClient, ALICE, f.ctx, f.groupId, bob, shown)).toEqual({
            checked: true,
            verified: true,
        });
        const pin = (await f.settings()).contacts[BOB]! as {
            trustedVia?: unknown;
            trustedViaFamily?: unknown;
        };
        expect(pin.trustedVia ?? null).toBeNull();
        expect(pin.trustedViaFamily).toBeUndefined();
        expect(await pinTrust(pin as never)).toBe('verified');
        expect((await memberStandings(ALICE, await f.view())).get(BOB)).toBe('verified');
        // And making Bob a manager goes ahead without asking for another check.
        expect(
            await stageChange(f.ctx, f.groupId, { kind: 'roles', userId: BOB, roles: ['members'] }),
        ).toMatchObject({ status: 'sent', outcome: { status: 'landed' } });
    });

    test('the older-app path reads the old join code to the phone and writes nothing on this device, over keys the server planted too', async () => {
        const f = await aliceFamily();
        // The server served another account's keys as Bob's when Alice let him in.
        const planted = await account(BOB);
        f.serve(planted.served);
        await f.letBobIn(planted.served);
        const before = f.stored.version;
        const guard = await contactGuardEntry(ALICE, BOB);
        // The family's own record: Alice made it.
        const record = (await f.settings()).familyChecks?.[f.groupId];
        expect(record).toMatchObject({ how: 'created', rosterVersion: 1 });
        // Help Bob finish joining: the code his 0.10.0 phone compares.
        const old = await olderAppCode(f.ctx, f.groupId, BOB);
        expect(old).toHaveLength(12);
        expect(f.stored.version).toBe(before);
        expect(await contactGuardEntry(ALICE, BOB)).toEqual(guard);
        expect((await f.settings()).familyChecks?.[f.groupId]).toEqual(record);
        expect((await memberStandings(ALICE, await f.view())).get(BOB)).toBe('not-verified');
        // Taken as a family check's They match, the old code is no pair code: nothing saved.
        expect(
            await familyCheckMatch(f.queryClient, ALICE, f.ctx, f.groupId, bob, {
                rosterVersion: 2,
                code: old,
            }),
        ).toEqual({ checked: false, verified: false });
        expect(f.stored.version).toBe(before);
        expect(await pinTrust((await f.settings()).contacts[BOB]!)).toBe('seen');
    });
});

describe('a manager role asked for at Invite someone (6.8)', () => {
    const INVITATION = 'a0000000-0000-4000-8000-0000000000a1';
    /* Alice sent Invite someone with "Let them manage the family" ticked, then let Bob in. */
    async function invitedBob(f: Awaited<ReturnType<typeof aliceFamily>>) {
        await keepInvitedRole(f.queryClient, ALICE, f.groupId, INVITATION, BOB_EMAIL);
        await f.letBobIn();
        // Her device sees him let in, under the address she typed.
        await savePendingRoles(f.queryClient, ALICE, (settings) =>
            tidiedPendingRoles(
                settings,
                f.groupId,
                [{ userId: BOB, email: BOB_EMAIL, state: 'active', roles: [] }],
                () => undefined,
                new Date(),
            ),
        );
        expect(pendingRolesOf(await f.settings(), f.groupId, BOB)).toEqual(['members']);
    }

    test('Let them in never records one from the server’s invitation roles, whoever presses it', async () => {
        const f = await aliceFamily();
        // The server says Bob was asked to manage the family; nobody here asked.
        const result = await letInWithoutWords(f.queryClient, ALICE, f.ctx, f.groupId, {
            userId: BOB,
            email: BOB_EMAIL,
            roles: ['members'],
            identity: f.server.people[BOB].served,
        });
        // Held back all the same (safe that way), and nothing says it is owed.
        expect(result).toMatchObject({ outcome: 'staged', heldBack: ['members'] });
        expect(f.server.members.get(BOB)?.roles).toEqual([]);
        expect((await f.settings()).pendingRoles).toBeUndefined();
        expect(pendingRolesOf(await f.settings(), f.groupId, BOB)).toEqual([]);
    });

    test('is the inviter’s own, kept by invitation and address, and nothing of it reaches the server', async () => {
        const f = await aliceFamily();
        await invitedBob(f);
        expect((await f.settings()).pendingRoles?.[f.groupId]?.[INVITATION]).toEqual({
            email: BOB_EMAIL.toLowerCase(),
            roles: ['members'],
            since: expect.any(String),
            userId: BOB,
        });
        expect(JSON.stringify(f.server.log)).not.toContain('pendingRoles');
    });

    test('survives a save by a tab that doesn’t know it: a check of Bob’s words and a sync', async () => {
        const f = await aliceFamily();
        await invitedBob(f);
        const before = f.stored.version;
        // An older release's acts, through the very save paths it runs (saveSettings,
        // compareAndSetSettings, the worker's settingsOpen and settingsSeal, all as on main):
        // Check it's Bob through his words, then a sync that writes the family's pin.
        const { lookupContact, pinContact } = await import('./contacts');
        await pinContact(
            f.queryClient,
            ALICE,
            await lookupContact(f.queryClient, ALICE, BOB_EMAIL),
        );
        await f.view();
        expect(f.stored.version).toBeGreaterThan(before);
        expect(pendingRolesOf(await f.settings(), f.groupId, BOB)).toEqual(['members']);
    });

    test('goes with a Continue on Bob’s account change', async () => {
        const f = await aliceFamily();
        await invitedBob(f);
        const fresh = await account(BOB);
        f.serve(fresh.served);
        f.server.serveAs(BOB, fresh.served);
        const staged = await continueMembers(f.queryClient, ALICE, f.ctx, f.groupId, [bob]);
        expect(staged).toMatchObject({ status: 'sent', outcome: { status: 'landed' } });
        expect(pendingRolesOf(await f.settings(), f.groupId, BOB)).toEqual([]);
    });
});

describe('who the member list shows as Verified (3.8)', () => {
    test('only a verified pin of this person’s own, agreeing with this device, of the very keys their entry names', async () => {
        const f = await aliceFamily();
        await f.letBobIn();
        const entry = (await f.view()).members.find((member) => member.userId === BOB)!;
        const { pinOf } = await import('./groups/worker-testkit');
        const verified = { ...(await pinOf(f.server.people[BOB])), userId: BOB };
        const agrees = { verified: true, changed: false };
        expect(await memberStanding(entry, verified, agrees)).toBe('verified');
        // Not this device's (the guard disagrees): the account changed.
        expect(await memberStanding(entry, verified, { verified: false, changed: true })).toBe(
            'changed',
        );
        // First seen, a family's word, or verified keys their entry doesn't name: not verified.
        expect(await memberStanding(entry, { ...verified, fingerprint: '' }, agrees)).toBe(
            'not-verified',
        );
        expect(
            await memberStanding(entry, { ...verified, trustedVia: f.groupId } as never, agrees),
        ).toBe('not-verified');
        const elsewhere = { ...(await pinOf(await account(BOB))), userId: BOB };
        expect(await memberStanding(entry, elsewhere, agrees)).toBe('not-verified');
        expect(await memberStanding(entry, null, undefined)).toBe('not-verified');
    });
});
