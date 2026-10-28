// @vitest-environment node
import type { ContactPin, RosterCallBody } from '@hushos/crypto';
import { parseRoster } from '@hushos/crypto/groups';
import { entryCommitment, keyCommitment } from '@hushos/crypto/pins';
import { CHECK_MANAGER_FIRST } from '@hushos/crypto/protocol';
import { digest } from '@hushos/crypto/signatures';
import { describe, expect, test, vi } from 'vitest';
import { GUARD_UNSAVED } from '@/lib/contact-guard';
import type { GroupContext } from './context';
import { createFamily, letIn, resumeOutbox, stageChange, type StageOutcome } from './outbox';
import { AnotherChangeWaitsError, continueFoldIn, resealFolded, runDue } from './removal';
import { ALICE, BOB, CAROL, DAVE, familyServer } from './server-testkit';
import { createMemoryGroupStore } from './store';
import { fetchIdentities, syncGroup } from './sync';
import { account, bytes, pinOf } from './worker-testkit';

/*
 * Letting people into a family without words, and the rules that come with it
 * (docs/optional-verification.md 3.2, 3.3, 3.6), against the real crypto
 * worker and a server that keeps and serves what the routes would. What is
 * checked is what reaches the server: an admission built from a first-seen
 * pin and sealed to its keys only; no role that hands over the family's key
 * to keys nobody checked; and an account change no signed chain explains
 * taken only on a manager's Continue, with every family folder given new
 * keys in the same change.
 */

vi.setConfig({ testTimeout: 30_000 });

/* This account's contact pin of `userId`, as Let them in (first seen) or a check (verified) writes it. */
async function pin(ctx: GroupContext, userId: string, value: ContactPin | null) {
    const { settings, version } = await ctx.settings.read();
    const contacts = { ...settings.contacts };
    if (value) contacts[userId] = { ...value, userId } as never;
    else delete contacts[userId];
    expect(await ctx.settings.write(version, { ...settings, contacts })).toBe(true);
    await ctx.settings.read();
}
const firstSeen = (value: ContactPin): ContactPin => ({
    ...value,
    fingerprint: '',
    firstSeen: 'family',
});

/* Alice's family, made on her device, with no one else in it yet. */
async function family() {
    const server = await familyServer();
    const ctx = await server.device();
    const { groupId, outcome } = await createFamily(ctx, 'Lindqvist');
    expect(outcome.status).toBe('landed');
    return { server, ctx, groupId };
}

/* Let them in, as the family page does it: over the pin Alice holds of them now. */
async function letThemIn(
    f: Awaited<ReturnType<typeof family>>,
    userId: string,
    roles: ('members' | 'billing')[] = [],
) {
    const { settings } = await f.ctx.settings.read();
    const held = settings.contacts[userId]!;
    return letIn(
        f.ctx,
        f.groupId,
        { kind: 'admit', userId, served: f.server.people[userId as typeof BOB].served, roles },
        held,
    );
}

const entryOf = (call: RosterCallBody, userId: string) =>
    parseRoster(bytes(call.roster.statement)).members.find((m) => m.userId === userId)!;
const landed = (staged: StageOutcome) =>
    staged.status === 'sent' && staged.outcome.status === 'landed';

describe('letting someone in without words', () => {
    test('builds their entry from a first-seen pin and seals the family folders to its keys only', async () => {
        const f = await family();
        const carol = await pinOf(f.server.people[CAROL]);
        await pin(f.ctx, CAROL, firstSeen(carol));
        const staged = await letThemIn(f, CAROL);
        expect(landed(staged)).toBe(true);
        const [call] = f.server.sent('admit');
        const entry = entryOf(call!, CAROL);
        // The entry names exactly the keys the first-seen pin holds.
        expect(await entryCommitment(entry)).toBe(await keyCommitment(carol));
        expect(entry.kemPublicKeyDigest).toBe(
            await digest(bytes(f.server.people[CAROL].served.kemPublicKey)),
        );
        // Every family folder's key goes to her, and the kept call says whose keys it was for.
        expect(call!.grants?.map((grant) => grant.granteeUserId)).toEqual([CAROL]);
        expect(staged.status === 'sent' && staged.entry.admits).toEqual({
            userId: CAROL,
            keys: await keyCommitment(carol),
        });
    });

    test('is refused, with nothing sent, when the keys served for them are not the ones the pin holds', async () => {
        const f = await family();
        // The server served Carol's keys when Alice added her, and another account's now.
        const other = await account(CAROL);
        f.server.serveAs(CAROL, other.served);
        await pin(f.ctx, CAROL, firstSeen(await pinOf(f.server.people[CAROL])));
        await expect(
            letIn(
                f.ctx,
                f.groupId,
                { kind: 'admit', userId: CAROL, served: other.served, roles: [] },
                (await f.ctx.settings.read()).settings.contacts[CAROL]!,
            ),
        ).rejects.toThrow(/not the keys/);
        expect(f.server.sent('admit')).toEqual([]);
        expect(await f.ctx.store.outbox(ALICE, f.groupId)).toEqual([]);
    });

    test('lets in someone asked to manage the family only over a check; first seen, nothing is signed', async () => {
        const f = await family();
        const carol = await pinOf(f.server.people[CAROL]);
        await pin(f.ctx, CAROL, firstSeen(carol));
        await expect(letThemIn(f, CAROL, ['members'])).rejects.toThrow(CHECK_MANAGER_FIRST);
        expect(f.server.sent('admit')).toEqual([]);
        expect(await f.ctx.store.outbox(ALICE, f.groupId)).toEqual([]);
        // Checked first (Check it's Carol first): the role, and the family's key sealed to her.
        await pin(f.ctx, CAROL, carol);
        expect(landed(await letThemIn(f, CAROL, ['members']))).toBe(true);
        const [call] = f.server.sent('admit');
        expect(entryOf(call!, CAROL).roles).toEqual(['members']);
        expect(
            (call as RosterCallBody & { keySeal?: { holderUserId: string } }).keySeal,
        ).toMatchObject({ holderUserId: CAROL });
    });
});

/* Alice's family with Bob let in over `bobPin` (first seen by default), as `roles`. */
async function withBob(
    options: { verified?: boolean; roles?: ('members' | 'billing')[] } = {},
): Promise<Awaited<ReturnType<typeof family>> & { bob: ContactPin }> {
    const f = await family();
    const bob = await pinOf(f.server.people[BOB]);
    await pin(f.ctx, BOB, options.verified ? bob : firstSeen(bob));
    expect(landed(await letThemIn(f, BOB, options.roles ?? []))).toBe(true);
    return { ...f, bob };
}

const promote = (f: { ctx: GroupContext; groupId: string }, userId: string) =>
    stageChange(f.ctx, f.groupId, { kind: 'roles', userId, roles: ['members'] });

describe('the manager rule (3.6)', () => {
    test('making someone a manager without a check is refused before anything is signed, and goes ahead after one', async () => {
        const f = await withBob();
        await expect(promote(f, BOB)).rejects.toThrow(CHECK_MANAGER_FIRST);
        expect(f.server.sent('member')).toEqual([]);
        expect(await f.ctx.store.outbox(ALICE, f.groupId)).toEqual([]);
        // A check of Bob's words (or a family check that matched) leaves a verified pin.
        await pin(f.ctx, BOB, f.bob);
        expect(landed(await promote(f, BOB))).toBe(true);
        const [call] = f.server.sent('member');
        expect(entryOf(call!, BOB).roles).toEqual(['members']);
        expect(
            (call as RosterCallBody & { keySeal?: { holderUserId: string } }).keySeal,
        ).toMatchObject({ holderUserId: BOB });
    });

    test('a pin on a family’s word, or a verified pin of keys other than their entry’s, is no check', async () => {
        const f = await withBob();
        await pin(f.ctx, BOB, { ...f.bob, trustedVia: f.groupId } as ContactPin);
        await expect(promote(f, BOB)).rejects.toThrow(CHECK_MANAGER_FIRST);
        // Verified, but of keys Bob's entry doesn't name (another account's, served as his).
        await pin(f.ctx, BOB, { ...(await pinOf(await account(BOB))), userId: BOB });
        await expect(promote(f, BOB)).rejects.toThrow(CHECK_MANAGER_FIRST);
        expect(f.server.sent('member')).toEqual([]);
    });

    test('a family check, then a Continue on that member’s account change, then a promotion is refused', async () => {
        // Checked: a verified pin of Bob, over the keys he joined with.
        const f = await withBob({ verified: true });
        // Bob starts over with new keys and no signed chain; Alice continues.
        const fresh = await account(BOB);
        f.server.serveAs(BOB, fresh.served);
        await pin(f.ctx, BOB, firstSeen({ ...(await pinOf(fresh)), userId: BOB }));
        expect(landed(await continued(f, BOB))).toBe(true);
        // The check was of the keys he had: no role on the ones Continue took.
        await expect(promote(f, BOB)).rejects.toThrow(CHECK_MANAGER_FIRST);
        expect(f.server.sent('member')).toEqual([]);
    });
});

/* Continue on members' account changes, as the family page does it once their new keys are pinned. */
const continued = (f: { ctx: GroupContext; groupId: string }, ...userIds: string[]) =>
    continueFoldIn(f.ctx, f.groupId, userIds, { [BOB]: 'Bob', [CAROL]: 'Carol', [DAVE]: 'Dave' });

describe('a member’s account change with no signed chain', () => {
    test('is folded in only after Continue, never on its own, and that change rotates every family folder and seals the new keys to the new entry only', async () => {
        const f = await withBob();
        // A second family folder, so "every" means more than one.
        expect(landed(await stageChange(f.ctx, f.groupId, { kind: 'area', name: 'Photos' }))).toBe(
            true,
        );
        const fresh = await account(BOB);
        f.server.serveAs(BOB, fresh.served);
        f.server.dueFoldIn([BOB]);
        // What is due runs on its own, as on every open: no chain reaches the new keys, so it
        // asks for a person's decision and signs nothing.
        const due = await runDue(f.ctx, f.groupId, { manager: true, areas: [] });
        expect(due.needsCheck).toEqual([BOB]);
        expect(f.server.sent('rosters')).toEqual([]);
        // Even with a pin of the new keys, the fold-in alone is no Continue.
        await pin(f.ctx, BOB, firstSeen({ ...(await pinOf(fresh)), userId: BOB }));
        expect((await runDue(f.ctx, f.groupId, { manager: true, areas: [] })).needsCheck).toEqual([
            BOB,
        ]);
        expect(f.server.sent('rosters')).toEqual([]);
        // Continue: one roster with Bob's new keys and every folder's new key.
        expect(landed(await continued(f, BOB))).toBe(true);
        const [call] = f.server.sent('rosters');
        expect(await entryCommitment(entryOf(call!, BOB))).toBe(
            await keyCommitment(await pinOf(fresh)),
        );
        const rotated = (call!.rotations ?? []).map((rotation) => rotation.workspaceId).sort();
        expect(rotated).toEqual([...f.server.areas.keys()].sort());
        // Bob gets each folder's new key, sealed to his new entry, and no current key at all.
        const toBob = (call!.grants ?? []).filter((grant) => grant.granteeUserId === BOB);
        expect(toBob.map((grant) => grant.workspaceId).sort()).toEqual(rotated);
        for (const grant of toBob)
            expect(grant.workspaceKeyVersion).toBe(
                call!.rotations!.find((rotation) => rotation.workspaceId === grant.workspaceId)!
                    .toVersion,
            );
        // And Alice, who stays, gets the new keys too.
        expect(
            (call!.grants ?? [])
                .filter((grant) => grant.granteeUserId === ALICE)
                .map((grant) => grant.workspaceId)
                .sort(),
        ).toEqual(rotated);
    });

    /*
     * Everyone whose account changed, let back in by one Continue: one roster with each one's
     * new keys, every folder rotated once, its new keys sealed to the keys each entry names now
     * and never to the keys their accounts left; a manager among them loses the role, on POST
     * rosters, with the family's key sealed to the managers who stay.
     */
    async function startOver(f: Awaited<ReturnType<typeof withBob>>, userIds: string[]) {
        const fresh = new Map<string, Awaited<ReturnType<typeof account>>>();
        for (const userId of userIds) {
            const now = await account(userId);
            fresh.set(userId, now);
            f.server.serveAs(userId, now.served);
            await pin(f.ctx, userId, firstSeen({ ...(await pinOf(now)), userId }));
        }
        return fresh;
    }
    async function oneContinueFor(userIds: string[], managers: string[]) {
        const f = await withBob({
            verified: true,
            roles: managers.includes(BOB) ? ['members'] : [],
        });
        // A second family folder, so "every" means more than one.
        expect(landed(await stageChange(f.ctx, f.groupId, { kind: 'area', name: 'Photos' }))).toBe(
            true,
        );
        for (const userId of userIds.filter((id) => id !== BOB)) {
            await pin(f.ctx, userId, await pinOf(f.server.people[userId as typeof CAROL]));
            expect(
                landed(await letThemIn(f, userId, managers.includes(userId) ? ['members'] : [])),
            ).toBe(true);
        }
        const before = f.server.log.length;
        const old = new Map<string, string | null>();
        for (const userId of userIds)
            old.set(
                userId,
                await keyCommitment(await pinOf(f.server.people[userId as typeof BOB])),
            );
        const fresh = await startOver(f, userIds);
        const staged = await continued(f, ...userIds);
        expect(landed(staged)).toBe(true);
        // One roster call, on POST rosters, and nothing on the member route.
        const calls = f.server.log
            .slice(before)
            .filter((entry) => ['rosters', 'member'].includes(entry.route));
        expect(calls.map((entry) => entry.route)).toEqual(['rosters']);
        const call = calls[0]!.body as RosterCallBody;
        const roster = parseRoster(bytes(call.roster.statement));
        const rotated = (call.rotations ?? []).map((rotation) => rotation.workspaceId).sort();
        expect(rotated).toEqual([...f.server.areas.keys()].sort());
        for (const userId of userIds) {
            const entry = entryOf(call, userId);
            // Each one's entry names their new keys, and no manager role on keys nobody checked.
            expect(await entryCommitment(entry)).toBe(
                await keyCommitment(await pinOf(fresh.get(userId)!)),
            );
            expect(await entryCommitment(entry)).not.toBe(old.get(userId));
            expect(entry.roles).toEqual([]);
            // Every folder's new key and no other, each sealed under this roster, whose entry for
            // them names the new keys: none to the roster before, whose entry named the old ones.
            const theirs = (call.grants ?? []).filter((grant) => grant.granteeUserId === userId);
            expect(theirs.map((grant) => grant.workspaceId).sort()).toEqual(rotated);
            for (const grant of theirs) {
                expect(grant.rosterVersion).toBe(roster.rosterVersion);
                expect(grant.workspaceKeyVersion).toBe(
                    call.rotations!.find((rotation) => rotation.workspaceId === grant.workspaceId)!
                        .toVersion,
                );
            }
        }
        // Nothing of the family sealed to anyone but Alice, the one manager who stays.
        if (managers.length > 0) expect(call.succession).toBeDefined();
        expect((call.seals ?? []).map((seal) => seal.holderUserId)).toEqual(
            managers.length > 0 ? [ALICE] : [],
        );
        await resealAfter(f, staged, userIds);
        expect(f.server.log.slice(before).filter((entry) => entry.route === 'key-seals')).toEqual(
            [],
        );
        // And the family on the server agrees: they're members, the role gone.
        for (const userId of managers)
            expect(f.server.members.get(userId)?.roles ?? []).not.toContain('members');
    }
    const resealAfter = async (
        f: Awaited<ReturnType<typeof withBob>>,
        staged: StageOutcome,
        userIds: string[],
    ) => {
        if (staged.status === 'sent' && staged.outcome.status === 'landed')
            await resealFolded(
                f.ctx,
                f.groupId,
                staged.outcome.sync,
                userIds.map((userId) => ({ userId })),
                await fetchIdentities(f.ctx, f.groupId),
            );
    };

    test('two members whose accounts changed are let back in by one Continue, a manager among them losing the role', async () => {
        await oneContinueFor([BOB, CAROL], [CAROL]);
    });

    test('three are let back in by one Continue, two managers among them both losing the role', async () => {
        await oneContinueFor([BOB, CAROL, DAVE], [BOB, DAVE]);
    });

    test('a Continue that leaves out someone whose account changed too is refused before anything is signed, naming them', async () => {
        const f = await withBob();
        const carol = await pinOf(f.server.people[CAROL]);
        await pin(f.ctx, CAROL, firstSeen(carol));
        expect(landed(await letThemIn(f, CAROL))).toBe(true);
        await startOver(f, [BOB, CAROL]);
        const before = f.server.log.length;
        await expect(continued(f, BOB)).rejects.toThrow(AnotherChangeWaitsError);
        await expect(continued(f, BOB)).rejects.toThrow(
            'Carol’s account changed too. HushOS can’t give Bob the family folders again while Carol’s change is waiting.',
        );
        // Nothing signed, nothing sent, nothing kept to send later.
        expect(
            f.server.log
                .slice(before)
                .filter((entry) => ['rosters', 'member'].includes(entry.route)),
        ).toEqual([]);
        expect(await f.ctx.store.outbox(ALICE, f.groupId)).toEqual([]);
        // Both together go.
        expect(landed(await continued(f, BOB, CAROL))).toBe(true);
    });

    test('a manager let back in that way keeps the folders but not the role: the family’s key is sealed to their new keys only after a check', async () => {
        const f = await withBob({ verified: true, roles: ['members'] });
        const fresh = await account(BOB);
        f.server.serveAs(BOB, fresh.served);
        await pin(f.ctx, BOB, firstSeen({ ...(await pinOf(fresh)), userId: BOB }));
        const staged = await continued(f, BOB);
        expect(landed(staged)).toBe(true);
        // The role goes in the Continue's own roster, on POST rosters.
        expect(f.server.sent('member')).toEqual([]);
        const [call] = f.server.sent('rosters');
        expect(entryOf(call!, BOB).roles).toEqual([]);
        // The role going is a new family key, sealed to the managers who remain: Alice alone.
        expect(call!.succession).toBeDefined();
        expect((call!.seals ?? []).map((seal) => seal.holderUserId)).toEqual([ALICE]);
        // Nothing sealed to Bob afterwards either.
        if (staged.status === 'sent' && staged.outcome.status === 'landed')
            await resealFolded(
                f.ctx,
                f.groupId,
                staged.outcome.sync,
                [{ userId: BOB }],
                await fetchIdentities(f.ctx, f.groupId),
            );
        expect(f.server.log.filter((entry) => entry.route === 'key-seals')).toEqual([]);
        // Checked over the new keys: managing again, with the family's key sealed to them.
        await pin(f.ctx, BOB, { ...(await pinOf(fresh)), userId: BOB });
        expect(landed(await promote(f, BOB))).toBe(true);
        const [roles] = f.server.sent('member');
        expect(
            (roles as RosterCallBody & { keySeal?: { holderUserId: string } }).keySeal,
        ).toMatchObject({ holderUserId: BOB });
    });
});

describe('the family guard before anything written under an acceptance (2.8)', () => {
    test('a creation whose guard was stored but whose record never was opens after a reload, and its saved change goes', async () => {
        const server = await familyServer();
        const store = createMemoryGroupStore();
        // The tab closes between the guard write and the record write.
        const putChain = store.putChain.bind(store);
        let crash = true;
        store.putChain = async (row) => {
            if (!crash) return putChain(row);
            crash = false;
            throw new Error('The tab closed.');
        };
        const { groupId, outcome } = await createFamily(await server.device(store), 'Lindqvist');
        expect(outcome.status).toBe('pending');
        expect(server.familyGuard.rows.size).toBe(1);
        expect(await store.chain(ALICE, groupId)).toBeNull();
        expect(await store.outbox(ALICE, groupId)).toHaveLength(1);
        // A reload: the guard marks the family now, so it is accepted against that, not the seed.
        const reopened = await server.device(store);
        const resumed = await resumeOutbox(reopened);
        expect([...resumed.outcomes.values()].map((at) => at.status)).toEqual(['landed']);
        expect(await store.outbox(ALICE, groupId)).toEqual([]);
        expect(await store.chain(ALICE, groupId)).not.toBeNull();
        expect((await reopened.settings.read()).settings.groups?.[groupId]).toBeDefined();
        expect((await syncGroup(reopened, groupId)).status).toBe('accepted');
    });

    test('an admission waits for the guard: while it can’t be stored nothing is sent, and once it is, the admission goes', async () => {
        const f = await withBob();
        const carol = await pinOf(f.server.people[CAROL]);
        await pin(f.ctx, CAROL, firstSeen(carol));
        // The guard this browser held is lost (cleared storage), and the next write fails.
        f.server.familyGuard.rows.clear();
        f.server.familyGuard.failWrites = 1;
        await expect(letThemIn(f, CAROL)).rejects.toThrow(GUARD_UNSAVED);
        expect(f.server.sent('admit').map((call) => entryOf(call, CAROL))).toEqual([undefined]);
        expect(await f.ctx.store.outbox(ALICE, f.groupId)).toEqual([]);
        // Stored on the next acceptance, before the admission is staged and sent.
        expect(landed(await letThemIn(f, CAROL))).toBe(true);
        expect(f.server.familyGuard.rows.size).toBe(1);
        expect(f.server.sent('admit')).toHaveLength(2);
    });
});
