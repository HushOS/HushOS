// @vitest-environment node
import type { RosterCallBody } from '@hushos/crypto';
import { parseRoster } from '@hushos/crypto/groups';
import { describe, expect, test } from 'vitest';
import type { GroupContext } from './context';
import { createFamily, stageChange } from './outbox';
import { foldIn, removeMember, repairPreviousRoots, replaceKeys, runDue } from './removal';
import { ALICE, BOB, CAROL, familyServer } from './server-testkit';
import { syncGroup } from './sync';
import { pinOf, bytes } from './worker-testkit';
import { refusal } from './test-harness';

/*
 * Removal, leaving's other half and key changes (1c step 7), against the real
 * crypto worker and a server that keeps and serves what the routes would
 * (server-testkit.ts). What is checked is what reaches the server: in what
 * order, with which roster bytes, and with rotations the worker built from
 * what route 29, the epochs route and the documents route served, rebuilt on
 * every answer that says a folder moved and never with another roster.
 */

type Server = Awaited<ReturnType<typeof familyServer>>;

/* Alice's family with Bob (and Carol when asked) let in, all synced on Alice's device. */
async function family(options: { bobRoles?: ('members' | 'billing')[]; carol?: boolean } = {}) {
    const server = await familyServer();
    const ctx = await server.device();
    const { groupId, outcome } = await createFamily(ctx, 'Lindqvist');
    expect(outcome.status).toBe('landed');
    const admit = async (userId: string, roles: ('members' | 'billing')[] = []) => {
        const who = server.people[userId as typeof BOB];
        const staged = await stageChange(ctx, groupId, {
            kind: 'admit',
            userId,
            pin: { ...(await pinOf(who)), userId },
            served: who.served,
            roles,
        });
        expect(staged).toMatchObject({ status: 'sent', outcome: { status: 'landed' } });
    };
    await admit(BOB, options.bobRoles);
    if (options.carol) await admit(CAROL);
    return { server, ctx, groupId, workspaceId: server.workspaceId() };
}

const rostersOf = (calls: RosterCallBody[]) => calls.map((call) => call.roster.statement);
const statusOf = (call: RosterCallBody, userId: string) =>
    parseRoster(bytes(call.roster.statement)).members.find((m) => m.userId === userId)?.status;
const rotationsOf = (call: RosterCallBody) => [
    ...(call.rotations ?? []),
    ...(call.rotation ? [call.rotation] : []),
];

/* A tags document sealed under the folder's current key, as a member's Tags would store it. */
async function tags(server: Server, ctx: GroupContext, workspaceId: string, version: number) {
    const { envelope } = await ctx.rpc(
        'driveSealDocument' as never,
        {
            workspaceId,
            kind: 'tags',
            version,
            document: { version: 2, tags: [], items: {} },
        } as never,
    );
    server.areas.get(workspaceId)!.documents.set('tags', { version, envelope });
}

describe('removing someone: hold, finish, remove', () => {
    test('the hold comes first, a running walk is finished next, and only then the removal, with every folder rotated and Bob left', async () => {
        const { server, ctx, groupId, workspaceId } = await family({ carol: true });
        // A walk is running in the folder (a holder's Drive rotation, say).
        server.areas.get(workspaceId)!.rotation = {
            id: 'run-1',
            nodeId: 'root',
            targetEpoch: 50,
        };
        const steps: string[] = [];
        const outcome = await removeMember(ctx, groupId, BOB, {
            family: 'Lindqvist',
            onStep: (step) => steps.push(step),
        });
        expect(outcome).toEqual({ status: 'removed' });
        expect(steps).toEqual(['hold', 'finish', 'remove']);
        const order = server.log
            .map((entry) => entry.route)
            .filter((route) => ['hold', 'walk', 'remove'].includes(route));
        // Placed, placed again before the walk, and again right before the call is built.
        expect(order).toEqual(['hold', 'hold', 'walk', 'hold', 'remove']);
        // The finish walk judges Bob as on his way out: his records are re-sealed, not Alice's own.
        expect(server.log.find((entry) => entry.route === 'walk')!.body).toMatchObject({
            departing: [BOB],
        });
        const [call] = server.sent('remove');
        expect(statusOf(call!, BOB)).toBe('left');
        expect(statusOf(call!, CAROL)).toBe('active');
        // Every folder rotated, under the top folder route 29 served, at a freshly drawn epoch.
        expect(rotationsOf(call!).map((rotation) => rotation.workspaceId)).toEqual([workspaceId]);
        expect(rotationsOf(call!)[0]!.toVersion).toBe(2);
        // The new key goes to those who remain, the remover included, and never to Bob.
        const grantees = (call!.grants ?? []).map((grant) => grant.granteeUserId).sort();
        expect(grantees).toEqual([ALICE, CAROL].sort());
        // Alice's device took it from what the server serves: Bob is left on her committed chain.
        const synced = await syncGroup(ctx, groupId);
        if (synced.status !== 'accepted') throw new Error(synced.status);
        expect(synced.view.members.find((m) => m.userId === BOB)?.status).toBe('left');
        expect(synced.view.areas[workspaceId]).toBe(2);
        // The folder opened at its new key version, its top folder listed under it: writable.
        expect(synced.areas[0]).toMatchObject({ write: 'writable', name: 'Family' });
    });

    test('a removal that cannot place its hold sends nothing: another manager paused us, or Bob did', async () => {
        const { server, ctx, groupId } = await family({ bobRoles: ['members'] });
        server.answer('hold', refusal(409, 'held'));
        // Route 3 lists who holds whom: Bob holds Alice.
        server.holds.push({ userId: ALICE, heldBy: BOB });
        expect(await removeMember(ctx, groupId, BOB)).toEqual({
            status: 'held',
            heldBy: BOB,
            targetManages: true,
        });
        server.holds.length = 0;
        expect(server.sent('remove')).toEqual([]);
        expect(server.walked).toEqual([]);
        // The way out: stop Bob managing (a succession, no rotation), then hold, then remove.
        const steps: string[] = [];
        const outcome = await removeMember(ctx, groupId, BOB, {
            demoteFirst: true,
            onStep: (step) => steps.push(step),
        });
        expect(outcome).toEqual({ status: 'removed' });
        expect(steps).toEqual(['demote', 'hold', 'finish', 'remove']);
        const [demotion] = server.sent('member');
        expect(demotion!.succession).toBeDefined();
        expect(rotationsOf(demotion!)).toEqual([]);
        const order = server.log
            .map((entry) => entry.route)
            .filter((route) => ['member', 'hold', 'remove'].includes(route));
        expect(order).toEqual(['hold', 'member', 'hold', 'hold', 'remove']);
    });

    test('a third manager’s pause is said as theirs, and a demotion that did not end it offers nothing more', async () => {
        const { server, ctx, groupId } = await family({ bobRoles: ['members'] });
        // Carol paused Alice, not Bob: the hold answers held even after Bob stops managing.
        server.holds.push({ userId: ALICE, heldBy: CAROL });
        server.answer('hold', refusal(409, 'held'));
        expect(await removeMember(ctx, groupId, BOB)).toEqual({
            status: 'held',
            heldBy: CAROL,
            targetManages: true,
        });
        server.answer('hold', refusal(409, 'held'));
        // Demoted anyway: read again afterwards, Bob no longer manages, so nothing offers it again.
        expect(await removeMember(ctx, groupId, BOB, { demoteFirst: true })).toEqual({
            status: 'held',
            heldBy: CAROL,
            targetManages: false,
        });
        expect(server.sent('remove')).toEqual([]);
        // Route 3 naming nobody (or more than one hold of Alice): nobody is named.
        server.holds.length = 0;
        server.answer('hold', refusal(409, 'held'));
        expect(await removeMember(ctx, groupId, BOB)).toMatchObject({ heldBy: null });
    });

    test('the hold is placed again before each folder’s finish walk, and a refused renewal stops the removal', async () => {
        const { server, ctx, groupId, workspaceId } = await family();
        const added = await stageChange(ctx, groupId, { kind: 'area', name: 'Photos' });
        expect(added).toMatchObject({ status: 'sent', outcome: { status: 'landed' } });
        for (const area of server.areas.values())
            area.rotation = { id: `run-${area.workspaceId}`, nodeId: 'root', targetEpoch: 90 };
        expect(await removeMember(ctx, groupId, BOB)).toEqual({ status: 'removed' });
        const order = server.log
            .map((entry) => entry.route)
            .filter((route) => ['hold', 'walk', 'remove'].includes(route));
        expect(order).toEqual(['hold', 'hold', 'walk', 'hold', 'walk', 'hold', 'remove']);

        // Another removal whose renewal is refused (another manager paused Alice meanwhile): it
        // stops there, says so, and sends nothing.
        const next = await family({ carol: true });
        next.server.areas.get(next.workspaceId)!.rotation = {
            id: 'run-x',
            nodeId: 'root',
            targetEpoch: 90,
        };
        next.server.holds.push({ userId: ALICE, heldBy: CAROL });
        // The first hold lands; the renewal before the walk is refused.
        const hold = next.server.api.hold.bind(next.server.api);
        let holds = 0;
        next.server.api.hold = (async (group: string, user: string) => {
            if (++holds === 2) throw refusal(409, 'held');
            return hold(group, user);
        }) as typeof hold;
        expect(await removeMember(next.ctx, next.groupId, BOB)).toEqual({
            status: 'held',
            heldBy: CAROL,
            targetManages: false,
        });
        expect(next.server.walked).toEqual([]);
        expect(next.server.sent('remove')).toEqual([]);
        void workspaceId;
    });

    test('the hold is placed again before every build of the call, rebuilds included', async () => {
        const { server, ctx, groupId } = await family();
        server.answer('remove', refusal(409, 'epoch-stale'));
        server.answer('remove', refusal(409, 'root-moved'));
        expect(await removeMember(ctx, groupId, BOB)).toEqual({ status: 'removed' });
        const order = server.log
            .map((entry) => entry.route)
            .filter((route) => ['hold', 'area-root', 'remove'].includes(route));
        // Every read of the folders, and so every call built from it, comes right after a hold.
        expect(order).toEqual([
            'hold',
            'hold',
            'area-root',
            'remove',
            'hold',
            'area-root',
            'remove',
            'hold',
            'area-root',
            'remove',
        ]);
    });

    test('someone no longer active is not removed again', async () => {
        const { server, ctx, groupId } = await family();
        server.answer('hold', refusal(409, 'members-changed', { reason: 'target' }));
        expect(await removeMember(ctx, groupId, BOB)).toEqual({ status: 'changed' });
        expect(server.sent('remove')).toEqual([]);
    });
});

describe('a removal’s answers that say a folder moved: the same roster bytes, the rotation built again', () => {
    test('rotating: the named walk is finished, then the same roster goes again with a rebuilt rotation', async () => {
        const { server, ctx, groupId, workspaceId } = await family();
        server.answer(
            'remove',
            refusal(409, 'rotating', {
                workspaceId,
                rotationId: 'run-2',
                nodeId: 'root',
                targetEpoch: 60,
            }),
        );
        expect(await removeMember(ctx, groupId, BOB)).toEqual({ status: 'removed' });
        const calls = server.sent('remove');
        expect(calls).toHaveLength(2);
        expect(new Set(rostersOf(calls)).size).toBe(1);
        expect(server.walked).toEqual([{ workspaceId, rotationId: 'run-2' }]);
        // Built again from what is served now: another epoch drawn.
        expect(rotationsOf(calls[1]!)[0]!.targetEpoch).toBeGreaterThan(
            rotationsOf(calls[0]!)[0]!.targetEpoch,
        );
    });

    test('epoch-stale and root-moved: drawn again, the top folder read again, the same roster', async () => {
        const { server, ctx, groupId, workspaceId } = await family();
        server.answer('remove', refusal(409, 'epoch-stale'));
        server.answer('remove', refusal(409, 'root-moved'));
        // The top folder moved meanwhile (a share sealed on it, say): its change sequence went up.
        const area = server.areas.get(workspaceId)!;
        const original = server.api.areaRoot.bind(server.api);
        let reads = 0;
        server.api.areaRoot = (async (group: string, ws: string) => {
            reads++;
            if (reads === 3) area.root = { ...area.root, changeSeq: area.root.changeSeq + 5 };
            return original(group, ws);
        }) as typeof server.api.areaRoot;
        expect(await removeMember(ctx, groupId, BOB)).toEqual({ status: 'removed' });
        const calls = server.sent('remove');
        expect(calls).toHaveLength(3);
        expect(new Set(rostersOf(calls)).size).toBe(1);
        const epochs = calls.map((call) => rotationsOf(call)[0]!.targetEpoch);
        expect(new Set(epochs).size).toBe(3);
        expect(rotationsOf(calls[2]!)[0]!.root.changeSeq).toBe(
            rotationsOf(calls[0]!)[0]!.root.changeSeq + 5,
        );
    });

    test('document-stale: the named documents are read again and sealed under the new key; one that never opens goes on empty, and the person is told', async () => {
        const { server, ctx, groupId, workspaceId } = await family();
        const writers = await server.rotations.writers(groupId);
        const area = server.areas.get(workspaceId)!;
        // The first read finds no documents; the tags document lands after it.
        const rotations = await server.rotations.read(groupId, [{ workspaceId, kinds: [] }]);
        expect(rotations[0]!.documents).toEqual([]);
        await tags(server, ctx, workspaceId, 1);
        server.answer(
            'remove',
            refusal(409, 'document-stale', { stale: [{ workspaceId, kind: 'tags' }] }),
        );
        const staged = await stageChange(
            ctx,
            groupId,
            { kind: 'remove', userId: BOB, rotations },
            { writers },
        );
        if (staged.status !== 'sent') throw new Error(staged.status);
        expect(staged.outcome).toMatchObject({ status: 'landed', notices: [] });
        const calls = server.sent('remove');
        expect(calls).toHaveLength(2);
        expect(new Set(rostersOf(calls)).size).toBe(1);
        expect(rotationsOf(calls[0]!)[0]!.documents).toEqual([]);
        expect(rotationsOf(calls[1]!)[0]!.documents.map((d) => [d.kind, d.version])).toEqual([
            ['tags', 1],
        ]);
        // Sealed for its next version under the new key: Alice's device opens it there.
        const stored = area.documents.get('tags')!;
        expect(stored.version).toBe(2);
        await expect(
            ctx.rpc(
                'driveOpenDocument' as never,
                {
                    workspaceId,
                    kind: 'tags',
                    version: 2,
                    envelope: stored.envelope,
                } as never,
            ),
        ).resolves.toMatchObject({ workspaceKeyVersion: 2 });

        // Junk bytes stored as the folder's tags: they never open, so the next rotation carries an
        // empty registry in their place, read twice first, and says so.
        area.documents.set('tags', {
            version: 2,
            envelope: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(96))))
                .replaceAll('+', '-')
                .replaceAll('/', '_')
                .replaceAll('=', ''),
        });
        const again = await replaceKeys(ctx, groupId, workspaceId);
        if (again.status !== 'sent') throw new Error(again.status);
        expect(again.outcome).toMatchObject({
            status: 'landed',
            notices: [{ kind: 'documents-cleared', workspaceId, document: 'tags' }],
        });
        await expect(
            ctx.rpc(
                'driveOpenDocument' as never,
                {
                    workspaceId,
                    kind: 'tags',
                    version: 3,
                    envelope: area.documents.get('tags')!.envelope,
                } as never,
            ),
        ).resolves.toMatchObject({ document: { tags: [] } });
    });

    test('grants-due: the named member’s grant on route 22, then the same bytes again', async () => {
        const { server, ctx, groupId, workspaceId } = await family({ carol: true });
        server.answer(
            'remove',
            refusal(409, 'grants-due', { missing: [{ workspaceId, userId: CAROL }] }),
        );
        expect(await removeMember(ctx, groupId, BOB)).toEqual({ status: 'removed' });
        const calls = server.sent('remove');
        expect(calls).toHaveLength(2);
        expect(JSON.stringify(calls[0])).toBe(JSON.stringify(calls[1]));
        const posted = server.log.find((entry) => entry.route === 'grants')!.body as {
            workspaceId: string;
            grants: { granteeUserId: string; workspaceKeyVersion: number }[];
        };
        expect(posted.grants).toMatchObject([{ granteeUserId: CAROL, workspaceKeyVersion: 1 }]);
    });

    test('left-due: the departed are marked left first (every folder rotated), then the removal goes again', async () => {
        const { server, ctx, groupId } = await family({ carol: true });
        server.departures.push(CAROL);
        server.answer('remove', refusal(409, 'left-due', { userIds: [CAROL] }));
        expect(await removeMember(ctx, groupId, BOB)).toEqual({ status: 'removed' });
        const [marked] = server.sent('rosters');
        expect(statusOf(marked!, CAROL)).toBe('left');
        expect(statusOf(marked!, BOB)).toBe('active');
        expect(rotationsOf(marked!)).toHaveLength(1);
        const removals = server.sent('remove');
        expect(removals).toHaveLength(2);
        // Rebuilt on top of the mark-left roster: another roster, never the refused bytes again.
        expect(removals[0]!.roster.statement).not.toBe(removals[1]!.roster.statement);
        expect(statusOf(removals[1]!, CAROL)).toBe('left');
        expect(statusOf(removals[1]!, BOB)).toBe('left');
    });
});

describe('work a manager’s device does on its own', () => {
    test('a departure is marked left quietly, with every folder rotated and the key handed on when they managed it', async () => {
        const { server, ctx, groupId } = await family({ bobRoles: ['members'] });
        server.departures.push(BOB);
        const synced = await syncGroup(ctx, groupId);
        if (synced.status !== 'accepted') throw new Error(synced.status);
        const report = await runDue(ctx, groupId, { manager: true, areas: synced.areas });
        expect(report.done).toContain('mark-left');
        const [marked] = server.sent('rosters');
        expect(statusOf(marked!, BOB)).toBe('left');
        expect(marked!.succession).toBeDefined();
        expect(rotationsOf(marked!)).toHaveLength(1);
        // Done once: route 3 no longer names him.
        expect(server.departures).toEqual([]);
        const again = await runDue(ctx, groupId, { manager: true, areas: synced.areas });
        expect(again.done).toEqual([]);
        expect(server.sent('rosters')).toHaveLength(1);
    });

    test('a member who does not manage the family marks nobody left', async () => {
        const { server, ctx, groupId } = await family();
        server.departures.push(BOB);
        const report = await runDue(ctx, groupId, { manager: false, areas: [] });
        expect(report.done).toEqual([]);
        expect(server.sent('rosters')).toEqual([]);
    });

    test('Replace keys: route 24 with the folder’s top folder re-keyed and its key to every member', async () => {
        const { server, ctx, groupId, workspaceId } = await family();
        const staged = await replaceKeys(ctx, groupId, workspaceId);
        expect(staged).toMatchObject({ status: 'sent', outcome: { status: 'landed' } });
        const [call] = server.sent('rotation');
        expect(call!.rotation).toMatchObject({ workspaceId, fromVersion: 1, toVersion: 2 });
        expect(call!.rotations).toBeUndefined();
        expect((call!.grants ?? []).map((grant) => grant.granteeUserId).sort()).toEqual(
            [ALICE, BOB].sort(),
        );
        // Nobody's membership moves on a key change.
        expect(statusOf(call!, BOB)).toBe('active');
    });

    test('a previous top-folder key that does not open is repaired by a manager who held the old key', async () => {
        const { server, ctx, groupId, workspaceId } = await family();
        // Alice's device listed the top folder at key version 1 (the sync did); the key change is
        // stored with a previous envelope that opens nothing, from the first sync after it on.
        server.junkNextPrevious();
        await replaceKeys(ctx, groupId, workspaceId);
        const area = server.areas.get(workspaceId)!;
        const synced = await syncGroup(ctx, groupId);
        if (synced.status !== 'accepted') throw new Error(synced.status);
        expect(await repairPreviousRoots(ctx, groupId, synced.areas)).toBe(1);
        const [put] = server.log.filter((entry) => entry.route === 'previous-root');
        expect(put!.body).toMatchObject({ workspaceId, rotationId: area.rotation!.id });
        // What it put opens: synced again, there is nothing left to repair.
        const after = await syncGroup(ctx, groupId);
        if (after.status !== 'accepted') throw new Error(after.status);
        expect(await repairPreviousRoots(ctx, groupId, after.areas)).toBe(0);
    });

    test('a fold-in with nobody whose keys moved signs nothing', async () => {
        const { server, ctx, groupId } = await family();
        expect(await foldIn(ctx, groupId, [BOB])).toEqual({ needsCheck: [], landed: false });
        expect(server.sent('rosters')).toEqual([]);
    });
});

describe('what a rotation is read from', () => {
    test('the top folder as route 29 serves it, one key version on; an epoch drawn after it; every document kind known plus those named', async () => {
        const { server, ctx, groupId, workspaceId } = await family();
        await tags(server, ctx, workspaceId, 1);
        server.log.length = 0;
        const [read] = await server.rotations.read(groupId, [
            { workspaceId, kinds: ['tags', 'later-kind'] },
        ]);
        expect(server.log.map((entry) => entry.route)).toEqual(['area-root', 'epochs']);
        expect(read!.root).toMatchObject({
            parentId: workspaceId,
            wrappedParentKeyEpoch: 1,
            parentKeyEpoch: 2,
            keyEpoch: 1,
            metadataSigner: ALICE,
            shares: [],
            links: [],
        });
        expect(read!.targetEpoch).toBeGreaterThan(read!.root.keyEpoch);
        expect(read!.documents.map((document) => document.kind)).toEqual(['tags']);
    });
});
