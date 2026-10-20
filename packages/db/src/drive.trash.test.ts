import { randomBytes, randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
    closeDatabase,
    createTestAccount,
    createTestIdentity,
    resetDatabase,
} from '../test/helpers';
import * as signed from '../test/signed';
import { db } from './client';
import * as drive from './drive';
import { driveNodes } from './schema';

/*
 * Paging through the trash: every trashed node once, newest first, whatever the
 * page size and however its ids happen to sort. The times below are chosen so the
 * trash order and the id order disagree, and two rows share a millisecond but not
 * a microsecond, which is what Postgres keeps and a millisecond cursor would lose.
 */

let account: Awaited<ReturnType<typeof createTestAccount>>;
let rootId: string;
let rootEpoch: number;

async function epoch() {
    const range = await drive.allocateKeyEpochs(account.workspaceId, 1);
    return range!.from;
}

/* `count` folders under the root, each in the trash; returns their ids sorted ascending. */
async function trashedFolders(count: number) {
    const folders = [];
    for (let i = 0; i < count; i++) {
        folders.push({
            id: randomUUID(),
            parentId: rootId,
            envelopes: {
                keyEpoch: await epoch(),
                parentKeyEpoch: rootEpoch,
                keyEnvelope: randomBytes(72),
                metadataEnvelope: randomBytes(100),
            },
        });
    }
    const created = await signed.createFolders({
        workspaceId: account.workspaceId,
        userId: account.userId,
        folders,
    });
    if (created.status !== 'created') throw new Error(created.status);
    for (const folder of folders) {
        const trashed = await drive.trashNode({
            workspaceId: account.workspaceId,
            nodeId: folder.id,
        });
        if (trashed.status !== 'ok') throw new Error(trashed.status);
    }
    return folders.map((folder) => folder.id).sort();
}

async function setTrashedAt(id: string, at: string) {
    await db.execute(
        sql`update drive_nodes set trashed_at = ${at}::timestamptz where id = ${id}::uuid`,
    );
}

/* The whole trash, a page of `limit` at a time; fails on a cursor that never ends. */
async function walk(limit: number) {
    const seen: string[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 50; pages++) {
        const page = await drive.listTrash({ workspaceId: account.workspaceId, after, limit });
        seen.push(...page.items.map((item) => item.node.id));
        if (!page.nextCursor) return seen;
        after = page.nextCursor;
    }
    throw new Error('the trash cursor never ran out');
}

beforeEach(async () => {
    await resetDatabase();
    account = await createTestAccount({ quotaBytes: 1024n * 1024n });
    await createTestIdentity(account.userId);
    const created = await signed.createRoot({
        workspaceId: account.workspaceId,
        userId: account.userId,
        id: randomUUID(),
        envelopes: {
            keyEpoch: await epoch(),
            parentKeyEpoch: 1,
            keyEnvelope: randomBytes(72),
            metadataEnvelope: randomBytes(100),
        },
    });
    if (created.status !== 'created') throw new Error(created.status);
    rootId = created.root.id;
    rootEpoch = created.root.keyEpoch;
});
afterAll(closeDatabase);

describe('the trash across pages', () => {
    test('every node once, newest first, the id breaking ties, at any page size', async () => {
        const ids = await trashedFolders(7);
        // Newest first is the reverse of id order for most rows; two rows tie outright,
        // and two share a millisecond but not a microsecond.
        await setTrashedAt(ids[0]!, '2026-09-25 10:00:00.000001+00');
        await setTrashedAt(ids[1]!, '2026-09-25 10:00:00.000002+00');
        await setTrashedAt(ids[2]!, '2026-09-25 09:59:59.500000+00');
        await setTrashedAt(ids[3]!, '2026-09-25 09:59:59.500000+00');
        await setTrashedAt(ids[4]!, '2026-09-25 11:00:00.000000+00');
        await setTrashedAt(ids[5]!, '2026-09-24 08:00:00.000000+00');
        await setTrashedAt(ids[6]!, '2026-09-25 10:30:00.000000+00');
        const newestFirst = [ids[4], ids[6], ids[1], ids[0], ids[2], ids[3], ids[5]];

        for (const limit of [1, 2, 3, 7, 8]) {
            const seen = await walk(limit);
            expect(seen, `page size ${limit}`).toEqual(newestFirst);
        }
    });

    test('a node restored between pages drops out without shifting the rest', async () => {
        const ids = await trashedFolders(4);
        // Newest first runs against the ids: ids[3], ids[2], ids[1], ids[0].
        const times = [
            '2026-09-25 10:00:01+00',
            '2026-09-25 10:00:02+00',
            '2026-09-25 10:00:03+00',
            '2026-09-25 10:00:04+00',
        ];
        for (const [index, id] of ids.entries()) await setTrashedAt(id, times[index]!);

        const first = await drive.listTrash({ workspaceId: account.workspaceId, limit: 2 });
        expect(first.items.map((item) => item.node.id)).toEqual([ids[3], ids[2]]);
        // The first page's rows leave the trash; an offset would now skip ids[1], an id cursor both.
        await db
            .update(driveNodes)
            .set({ trashedAt: null })
            .where(inArray(driveNodes.id, [ids[3]!, ids[2]!]));
        const second = await drive.listTrash({
            workspaceId: account.workspaceId,
            after: first.nextCursor!,
            limit: 2,
        });
        expect(second.items.map((item) => item.node.id)).toEqual([ids[1], ids[0]]);
        expect(second.nextCursor).toBeNull();
    });

    test('refuses a cursor that is not one of its own', async () => {
        await trashedFolders(1);
        for (const bad of [
            randomUUID(),
            '12.not-a-uuid',
            `-5.${randomUUID()}`,
            `1.${randomUUID()}.x`,
            '',
        ]) {
            expect(drive.parseTrashCursor(bad), bad).toBeNull();
            await expect(
                drive.listTrash({ workspaceId: account.workspaceId, after: bad }),
            ).rejects.toThrow('Malformed trash cursor');
        }
        expect(drive.parseTrashCursor(`1790320010367123.${randomUUID()}`)).not.toBeNull();
    });
});

/*
 * The web app trashes a selection several items at a time. Every trash takes
 * the workspace row's lock first (nextChangeSeq), so they run one after another
 * whatever their order: none deadlocks, and each that moves takes its own change
 * sequence number, so a device reading the feed sees every one. A trash that
 * takes any other lock before that one (the node's, its parent's) can deadlock
 * against the trash of a folder inside it, which the second test would catch.
 */
describe('trashing at once', () => {
    async function folders(parentId: string, parentKeyEpoch: number, count: number) {
        const made = [];
        for (let i = 0; i < count; i++)
            made.push({
                id: randomUUID(),
                parentId,
                envelopes: {
                    keyEpoch: await epoch(),
                    parentKeyEpoch,
                    keyEnvelope: randomBytes(72),
                    metadataEnvelope: randomBytes(100),
                },
            });
        const created = await signed.createFolders({
            workspaceId: account.workspaceId,
            userId: account.userId,
            folders: made,
        });
        if (created.status !== 'created') throw new Error(created.status);
        return made.map((folder) => ({ id: folder.id, keyEpoch: folder.envelopes.keyEpoch }));
    }
    async function workspaceSeq() {
        const result = await db.execute<{ change_seq: string }>(
            sql`select change_seq from workspaces where id = ${account.workspaceId}::uuid`,
        );
        return Number(result.rows[0]!.change_seq);
    }
    const trash = (nodeId: string) =>
        drive.trashNode({ workspaceId: account.workspaceId, nodeId, writer: account.userId });

    test('siblings trashed together each move, with change numbers one apart and none shared', async () => {
        const siblings = await folders(rootId, rootEpoch, 16);
        const before = await workspaceSeq();
        const results = await Promise.all(siblings.map((folder) => trash(folder.id)));
        expect(results.map((result) => result.status)).toEqual(siblings.map(() => 'ok'));
        const seqs = results
            .map((result) => (result.status === 'ok' ? result.node.changeSeq : null))
            .sort((a, b) => a! - b!);
        expect(seqs).toEqual(siblings.map((_, index) => before + index + 1));
        expect(await workspaceSeq()).toBe(before + siblings.length);
        const trashed = await drive.listTrash({ workspaceId: account.workspaceId, limit: 100 });
        expect(trashed.items.map((item) => item.node.id).sort()).toEqual(
            siblings.map((folder) => folder.id).sort(),
        );
    });

    test('a folder and the folder inside it, trashed together, never deadlock and both end in the trash', async () => {
        for (let round = 0; round < 12; round++) {
            const [outer] = await folders(rootId, rootEpoch, 1);
            const [inner] = await folders(outer!.id, outer!.keyEpoch, 1);
            // Alternate which goes first, so both lock orders are tried.
            const [first, second] = round % 2 ? [inner!, outer!] : [outer!, inner!];
            const before = await workspaceSeq();
            const [a, b] = await Promise.all([trash(first.id), trash(second.id)]);
            const byId = new Map([
                [first.id, a],
                [second.id, b],
            ]);
            // The folder always moves. The one inside moves too unless the folder got there first,
            // when it is already in the trash with it and is refused as such, changing nothing.
            expect(byId.get(outer!.id)!.status).toBe('ok');
            expect(['ok', 'trashed']).toContain(byId.get(inner!.id)!.status);
            const oks = [a, b].filter((result) => result.status === 'ok');
            const moved = oks.length;
            // Each that moved has a change number of its own, after everything before the pair.
            const seqs = oks.map((result) => (result.status === 'ok' ? result.node.changeSeq! : 0));
            expect(new Set(seqs).size).toBe(seqs.length);
            for (const seq of seqs) expect(seq).toBeGreaterThan(before);
            const listed = await drive.listTrash({ workspaceId: account.workspaceId, limit: 100 });
            const ids = listed.items.map((item) => item.node.id);
            expect(ids).toContain(outer!.id);
            expect(ids.includes(inner!.id)).toBe(moved === 2);
            const chain = await db.transaction((tx) => drive.walk(tx, inner!.id));
            expect(chain!.trashed).toBe(true);
        }
    });
});
