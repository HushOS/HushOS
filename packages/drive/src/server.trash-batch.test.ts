import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { db } from '../../db/src/client';
import {
    closeDatabase,
    createTestAccount,
    createTestIdentity,
    resetDatabase,
} from '../../db/test/helpers';
import { folder, member, root, share, type Account } from '../test/fixtures';
import { MAX_TRASH_BATCH, TRASH_BATCHES_PER_MINUTE } from './protocol';
import * as server from './server';

/*
 * The batch trash and restore routes' answers for the whole request, as the
 * API returns them: who is turned away before the workspace's lock, how many
 * may go at once, how often, and what a lock held elsewhere too long becomes.
 */

let owner: Account;
let top: Awaited<ReturnType<typeof root>>;

beforeEach(async () => {
    await resetDatabase();
    owner = await member();
    top = await root(owner);
});
afterAll(closeDatabase);

async function refusal(promise: Promise<unknown>) {
    const error = await promise.then(
        () => null,
        (caught: unknown) => caught,
    );
    if (!(error instanceof server.DriveError))
        throw new Error('expected a DriveError', { cause: error });
    return { status: error.status, code: error.code };
}
/*
 * A request sent again while the answer is 409, the workspace's lock being busy: what a client
 * does with that answer. Any other refusal, and a 409 that never clears, is the caller's to see.
 */
async function unlessBusy<T>(send: () => Promise<T>, tries = 5): Promise<T> {
    for (let sent = 1; ; sent++) {
        try {
            return await send();
        } catch (error) {
            const busy = error instanceof server.DriveError && error.status === 409;
            if (!busy || sent >= tries) throw error;
        }
    }
}
async function workspaceSeq() {
    const result = await db.$client.query<{ change_seq: string }>(
        'select change_seq from workspaces where id = $1',
        [owner.workspaceId],
    );
    return Number(result.rows[0]!.change_seq);
}

describe('the whole request', () => {
    test('404 for someone with nothing to write here, a viewer included, before any lock', async () => {
        const item = await folder(owner, top);
        const viewer = await createTestAccount();
        await createTestIdentity(viewer.userId);
        await share(owner, item, viewer, 'viewer');
        const stranger = await createTestAccount();
        const seq = await workspaceSeq();
        for (const person of [stranger, viewer]) {
            expect(
                await refusal(server.trashNodes(person.userId, owner.workspaceId, [item.id])),
            ).toEqual({ status: 404, code: 'not-found' });
            expect(
                await refusal(server.restoreNodes(person.userId, owner.workspaceId, [item.id])),
            ).toEqual({ status: 404, code: 'not-found' });
        }
        expect(await workspaceSeq()).toBe(seq);
    });

    test(`400 for more than ${MAX_TRASH_BATCH} items, none, or one named twice`, async () => {
        const item = await folder(owner, top);
        const many = [item.id, ...Array.from({ length: MAX_TRASH_BATCH }, () => randomUUID())];
        for (const nodeIds of [many, [], [item.id, item.id]])
            for (const send of [server.trashNodes, server.restoreNodes])
                expect(await refusal(send(owner.userId, owner.workspaceId, nodeIds))).toEqual({
                    status: 400,
                    code: 'invalid',
                });
        // Exactly the most is taken. A batch that large may run past its share of the workspace's
        // lock on a loaded machine and be answered 409 to try again (driveRepository's
        // BATCH_HOLD_MS), which is the server working as meant and says nothing about the count:
        // sent again, as a client sends it, until it is answered for what it is.
        const most = await unlessBusy(() =>
            server.trashNodes(owner.userId, owner.workspaceId, many.slice(0, -1)),
        );
        expect(most.results).toHaveLength(MAX_TRASH_BATCH);
    });

    test('400 for a batch that is wrong in itself even while the workspace is locked elsewhere: it is read before the lock is asked for', async () => {
        const item = await folder(owner, top);
        const many = [item.id, ...Array.from({ length: MAX_TRASH_BATCH }, () => randomUUID())];
        const seq = await workspaceSeq();
        // Another transaction holds the workspace's row, as a long write would. A batch that
        // waited for it would be answered 409 two seconds later, whatever was wrong with it.
        const other = await db.$client.connect();
        await other.query('begin');
        await other.query('select id from workspaces where id = $1 for update', [
            owner.workspaceId,
        ]);
        try {
            for (const nodeIds of [many, [], [item.id, item.id]])
                for (const send of [server.trashNodes, server.restoreNodes])
                    expect(await refusal(send(owner.userId, owner.workspaceId, nodeIds))).toEqual({
                        status: 400,
                        code: 'invalid',
                    });
        } finally {
            await other.query('rollback');
            other.release();
        }
        expect(await workspaceSeq()).toBe(seq);
    });

    test(`429 past ${TRASH_BATCHES_PER_MINUTE} a minute for one account, trash and restore together`, async () => {
        const item = await folder(owner, top);
        for (let sent = 0; sent < TRASH_BATCHES_PER_MINUTE; sent++) {
            const send = sent % 2 ? server.restoreNodes : server.trashNodes;
            await send(owner.userId, owner.workspaceId, [item.id]);
        }
        for (const send of [server.trashNodes, server.restoreNodes])
            expect(await refusal(send(owner.userId, owner.workspaceId, [item.id]))).toEqual({
                status: 429,
                code: 'conflict',
            });
        // Someone else's budget is their own.
        const other = await member();
        const theirs = await folder(other, await root(other));
        expect(
            (await server.trashNodes(other.userId, other.workspaceId, [theirs.id])).results[0],
        ).toMatchObject({ status: 'trashed' });
    }, 30_000);

    test('409 to try again when the workspace stays locked elsewhere, having moved nothing', async () => {
        const item = await folder(owner, top);
        // Another transaction holds the workspace's row, as a long write would.
        const other = await db.$client.connect();
        await other.query('begin');
        await other.query('select id from workspaces where id = $1 for update', [
            owner.workspaceId,
        ]);
        try {
            expect(
                await refusal(server.trashNodes(owner.userId, owner.workspaceId, [item.id])),
            ).toEqual({ status: 409, code: 'conflict' });
        } finally {
            await other.query('commit');
            other.release();
        }
        expect(
            (await server.trashNodes(owner.userId, owner.workspaceId, [item.id])).results[0],
        ).toMatchObject({ status: 'trashed' });
    }, 15_000);
});

describe('delete forever for a selection', () => {
    test('404 for anyone not a member, an editor of something in it included, before any lock', async () => {
        const item = await folder(owner, top);
        await server.trashNodes(owner.userId, owner.workspaceId, [item.id]);
        const editor = await createTestAccount();
        await createTestIdentity(editor.userId);
        const shared = await folder(owner, top);
        await share(owner, shared, editor, 'editor');
        const stranger = await createTestAccount();
        const seq = await workspaceSeq();
        for (const person of [stranger, editor])
            expect(
                await refusal(server.purgeNodes(person.userId, owner.workspaceId, [item.id])),
            ).toEqual({ status: 404, code: 'not-found' });
        expect(await workspaceSeq()).toBe(seq);
    });

    test(`400 for more than ${MAX_TRASH_BATCH} items, none, or one named twice; the single route’s words for each refusal`, async () => {
        const item = await folder(owner, top);
        const many = [item.id, ...Array.from({ length: MAX_TRASH_BATCH }, () => randomUUID())];
        for (const nodeIds of [many, [], [item.id, item.id]])
            expect(
                await refusal(server.purgeNodes(owner.userId, owner.workspaceId, nodeIds)),
            ).toEqual({ status: 400, code: 'invalid' });
        const { results } = await server.purgeNodes(owner.userId, owner.workspaceId, [
            item.id,
            top.id,
        ]);
        expect(results).toEqual([
            {
                id: item.id,
                status: 'refused',
                reason: 'not-trashed',
                message: 'Move this item to the trash first.',
            },
            {
                id: top.id,
                status: 'refused',
                reason: 'root',
                message: 'The top folder cannot be deleted.',
            },
        ]);
    });

    test('shares the batch budget with trash and restore: 429 past it', async () => {
        const item = await folder(owner, top);
        for (let sent = 0; sent < TRASH_BATCHES_PER_MINUTE; sent++)
            await server.purgeNodes(owner.userId, owner.workspaceId, [item.id]);
        expect(
            await refusal(server.trashNodes(owner.userId, owner.workspaceId, [item.id])),
        ).toEqual({ status: 429, code: 'conflict' });
        expect(
            await refusal(server.purgeNodes(owner.userId, owner.workspaceId, [item.id])),
        ).toEqual({ status: 429, code: 'conflict' });
    }, 30_000);

    test('409 to try again when the workspace stays locked elsewhere, having purged nothing', async () => {
        const item = await folder(owner, top);
        await server.trashNodes(owner.userId, owner.workspaceId, [item.id]);
        const other = await db.$client.connect();
        await other.query('begin');
        await other.query('select id from workspaces where id = $1 for update', [
            owner.workspaceId,
        ]);
        try {
            expect(
                await refusal(server.purgeNodes(owner.userId, owner.workspaceId, [item.id])),
            ).toEqual({ status: 409, code: 'conflict' });
        } finally {
            await other.query('commit');
            other.release();
        }
        expect(
            (await server.purgeNodes(owner.userId, owner.workspaceId, [item.id])).results[0],
        ).toMatchObject({ status: 'purged' });
    }, 15_000);
});
