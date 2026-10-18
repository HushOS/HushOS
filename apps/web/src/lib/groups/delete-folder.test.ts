// @vitest-environment node
import type { RosterCallBody } from '@hushos/crypto';
import { parseRoster } from '@hushos/crypto/groups';
import { describe, expect, test, vi } from 'vitest';
import { createFamily, stageChange } from './outbox';
import { removeMember } from './removal';
import { BOB, familyServer } from './server-testkit';
import { syncGroup } from './sync';
import { bytes } from './worker-testkit';

/*
 * Deleting a family folder (groups design 2.10), against the real crypto
 * worker and a server that keeps and serves what the routes would: what
 * reaches the server (the route, the roster's rows, what the call carries)
 * and what the family looks like afterwards, a later removal included.
 */

vi.setConfig({ testTimeout: 30_000 });

const rowsOf = (call: RosterCallBody) => parseRoster(bytes(call.roster.statement)).areas ?? [];
const rotatedIn = (call: RosterCallBody) =>
    [...(call.rotations ?? []), ...(call.rotation ? [call.rotation] : [])].map(
        (rotation) => rotation.workspaceId,
    );

/* Alice's family with Bob let in and a second folder, "Photos", all synced on Alice's device. */
async function withPhotos() {
    const server = await familyServer();
    const ctx = await server.device();
    const { groupId, outcome } = await createFamily(ctx, 'Lindqvist');
    expect(outcome.status).toBe('landed');
    const bob = server.people[BOB];
    expect(
        await stageChange(ctx, groupId, {
            kind: 'admit',
            userId: BOB,
            served: bob.served,
            roles: [],
        }),
    ).toMatchObject({ status: 'sent', outcome: { status: 'landed' } });
    const family = server.workspaceId();
    expect(await stageChange(ctx, groupId, { kind: 'area', name: 'Photos' })).toMatchObject({
        status: 'sent',
        outcome: { status: 'landed' },
    });
    const photos = [...server.areas.keys()].find((id) => id !== family)!;
    return { server, ctx, groupId, family, photos };
}

describe('deleting a family folder', () => {
    test('every roster is format 2, and each new folder key commits to its top folder’s key', async () => {
        const { server, family, photos } = await withPhotos();
        const [created] = server.sent('create');
        const [area] = server.sent('areas');
        for (const call of [created!, area!, ...server.sent('admit')])
            expect(parseRoster(bytes(call.roster.statement)).format).toBe(2);
        expect(rowsOf(created!)).toEqual([
            expect.objectContaining({ workspaceId: family, rootCommitment: expect.any(String) }),
        ]);
        expect(rowsOf(area!)).toEqual([
            expect.objectContaining({ workspaceId: photos, rootCommitment: expect.any(String) }),
        ]);
    });

    test('its tombstone goes alone on the delete route, the folder leaves the family, and a later removal rotates only what is left', async () => {
        const { server, ctx, groupId, family, photos } = await withPhotos();
        const staged = await stageChange(ctx, groupId, { kind: 'retire', workspaceId: photos });
        expect(staged).toMatchObject({ status: 'sent', outcome: { status: 'landed' } });
        const [call] = server.sent('delete');
        expect(rowsOf(call!)).toEqual([
            { workspaceId: photos, workspaceKeyVersion: 2, commitment: '', retired: true },
        ]);
        expect(call!.grants ?? []).toEqual([]);
        expect(call!.rotations ?? []).toEqual([]);
        const synced = await syncGroup(ctx, groupId);
        if (synced.status !== 'accepted') throw new Error(synced.status);
        expect(Object.keys(synced.view.areas)).toEqual([family]);
        expect(synced.areas.map((area) => area.workspaceId)).toEqual([family]);
        // Bob's removal rotates the family's one live folder, never the deleted one.
        expect(await removeMember(ctx, groupId, BOB)).toEqual({ status: 'removed' });
        const [removal] = server.sent('remove');
        expect(rotatedIn(removal!)).toEqual([family]);
        expect(rowsOf(removal!).map((row) => row.workspaceId)).toEqual([family]);
    });
});
