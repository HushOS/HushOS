import { randomBytes, randomUUID } from 'node:crypto';
import { groupsRepository } from '@hushos/db';
import { afterAll, beforeEach, expect, test } from 'vitest';
import { db } from '../../db/src/client';
import { driveObjects } from '../../db/src/schema';
import {
    closeDatabase,
    createTestAccount,
    createTestFamily,
    resetDatabase,
} from '../../db/test/helpers';
import { deleteObjects, purgeDue } from './jobs';
import type { ObjectStore } from './storage';

/*
 * A dissolved family's stored objects leave the store the way a deleted family
 * folder's do: dissolving retires its folders, Drive's purge job queues their
 * objects on the deletion outbox after the trash's retention, and the
 * delete-objects job deletes exactly those keys, nothing of anyone else's. The
 * family's own records go after (groups.purge-dissolved).
 */

beforeEach(resetDatabase);
afterAll(closeDatabase);

/* A store that records what it is asked to delete. */
function recordingStore() {
    const deleted: string[] = [];
    const store = {
        delete: async (key: string) => {
            deleted.push(key);
        },
    } as unknown as ObjectStore;
    return { store, deleted };
}

async function storedObject(workspaceId: string) {
    const id = randomUUID();
    const objectKey = `ws/${workspaceId}/${id}`;
    await db.insert(driveObjects).values({
        id,
        workspaceId,
        objectKey,
        chunkSize: 1,
        chunkCount: 1,
        contentNonce: randomBytes(16),
        ciphertextSize: 17n,
        status: 'ready',
    });
    return objectKey;
}

test('a purged family’s objects are deleted from the store through the outbox, and only theirs', async () => {
    const organizer = await createTestAccount();
    const other = await createTestAccount();
    const dissolved = await createTestFamily({ organizerId: organizer.userId, areas: 2 });
    const live = await createTestFamily({ organizerId: other.userId });
    const familyKeys = [
        await storedObject(dissolved.areaIds[0]!),
        await storedObject(dissolved.areaIds[0]!),
        await storedObject(dissolved.areaIds[1]!),
    ];
    const ownKey = await storedObject(organizer.workspaceId);
    const liveKey = await storedObject(live.areaIds[0]!);
    // Its last member leaves, which dissolves it; then the retention passes.
    expect(await groupsRepository.leaveGroup(dissolved.groupId, organizer.userId)).toEqual({
        status: 'dissolved',
    });
    const days = groupsRepository.DISSOLVED_FAMILY_RETENTION_DAYS + 1;
    await db.$client.query(
        `update groups set dissolved_at = now() - make_interval(days => $2) where id = $1`,
        [dissolved.groupId, days],
    );
    await db.$client.query(
        // Only what dissolving retired: a folder it left live stays live.
        `update workspaces set deleted_at = now() - make_interval(days => $2) where group_id = $1 and deleted_at is not null`,
        [dissolved.groupId, days],
    );

    // Before the purge the drain has nothing to delete.
    const { store, deleted } = recordingStore();
    expect(await deleteObjects({ primary: store, replica: null })).toMatchObject({ primaries: 0 });

    expect(await purgeDue()).toMatchObject({ areas: 2 });
    expect(
        await groupsRepository.purgeDissolvedFamilies(
            groupsRepository.DISSOLVED_FAMILY_RETENTION_DAYS,
        ),
    ).toEqual({ retired: 0, families: 1, busy: 0 });
    expect(await deleteObjects({ primary: store, replica: null })).toMatchObject({ primaries: 3 });
    expect([...deleted].sort()).toEqual([...familyKeys].sort());
    expect(deleted).not.toContain(ownKey);
    expect(deleted).not.toContain(liveKey);

    // Drained once: a second pass deletes nothing more.
    expect(await deleteObjects({ primary: store, replica: null })).toMatchObject({ primaries: 0 });
    expect(deleted).toHaveLength(3);
});
