import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import { eq, inArray, sql } from 'drizzle-orm';
import { driveNodes, workspaceKeys } from './schema';
import { sealShareCursor } from './share-cursor';

/*
 * The change feed is a range over the workspace's sequence, tombstones
 * included; a share's feed is that range filtered to the shared subtree plus
 * the moves across its boundary, and it ends with the share.
 */

const env = () => randomBytes(72);
const meta = () => randomBytes(100);

let owner: Awaited<ReturnType<typeof createTestAccount>>;
let guest: Awaited<ReturnType<typeof createTestAccount>>;
let rootId: string;
let rootEpoch: number;

async function epoch() {
    return (await drive.allocateKeyEpochs(owner.workspaceId, 1))!.from;
}
async function folder(parentId: string, parentKeyEpoch: number) {
    const created = await signed.createFolders({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        folders: [
            {
                id: randomUUID(),
                parentId,
                envelopes: {
                    keyEpoch: await epoch(),
                    parentKeyEpoch,
                    keyEnvelope: env(),
                    metadataEnvelope: meta(),
                },
            },
        ],
    });
    if (created.status !== 'created') throw new Error(created.status);
    return created.nodes[0]!;
}

/* A suite 3 share of `node` to the guest, the only kind served; its id. */
async function shareWithGuest(node: { id: string; keyEpoch: number }) {
    const shared = await drive.createShare({
        workspaceId: owner.workspaceId,
        nodeId: node.id,
        granterUserId: owner.userId,
        granteeUserId: guest.userId,
        role: 'viewer',
        keyEpoch: node.keyEpoch,
        shareEnvelope: randomBytes(4565),
    });
    if (shared.status !== 'ok') throw new Error(shared.status);
    return shared.share.id;
}
/* Where a feed starts for a share listed now, as shared-with-me hands it out. */
async function cursorNow(shareId: string) {
    return sealShareCursor(shareId, (await drive.getPersonalWorkspace(owner.userId))!.changeSeq);
}
async function feedOf(shareId: string, cursor?: string) {
    const page = await drive.listShareChanges({ shareId, granteeUserId: guest.userId, cursor });
    if (page.status !== 'ok') throw new Error(page.status);
    return page;
}

beforeEach(async () => {
    await resetDatabase();
    owner = await createTestAccount();
    guest = await createTestAccount();
    for (const person of [owner, guest]) await createTestIdentity(person.userId);
    await db.insert(workspaceKeys).values({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        keyVersion: 1,
        wrappingSalt: randomBytes(32),
        wrappingNonce: randomBytes(24),
        encryptedKey: randomBytes(48),
    });
    const created = await signed.createRoot({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        id: randomUUID(),
        envelopes: {
            keyEpoch: await epoch(),
            parentKeyEpoch: 1,
            keyEnvelope: env(),
            metadataEnvelope: meta(),
        },
    });
    if (created.status !== 'created') throw new Error(created.status);
    rootId = created.root.id;
    rootEpoch = created.root.keyEpoch;
});
afterAll(closeDatabase);

describe('change feeds', () => {
    test("trash and restore reach the feed but leave the item's date alone", async () => {
        const a = await folder(rootId, rootEpoch);
        const before = a.updatedAt;
        const trashed = await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: a.id });
        if (trashed.status !== 'ok') throw new Error(trashed.status);
        expect(trashed.node.trashedAt).not.toBeNull();
        expect(trashed.node.updatedAt).toEqual(before);
        expect(trashed.node.changeSeq).toBeGreaterThan(a.changeSeq ?? 0);
        const restored = await drive.restoreNode({ workspaceId: owner.workspaceId, nodeId: a.id });
        if (restored.status !== 'ok') throw new Error(restored.status);
        expect(restored.node.trashedAt).toBeNull();
        expect(restored.node.updatedAt).toEqual(before);
        expect(restored.node.changeSeq).toBeGreaterThan(trashed.node.changeSeq ?? 0);
    });

    test('the workspace feed is ordered, cursored, and carries tombstones', async () => {
        const start = (await drive.getPersonalWorkspace(owner.userId))!.changeSeq;
        const a = await folder(rootId, rootEpoch);
        const b = await folder(rootId, rootEpoch);
        const first = await drive.listChanges({
            workspaceId: owner.workspaceId,
            since: start,
            limit: 1,
        });
        expect(first.changes.map((c) => (c.kind === 'node' ? c.node.id : null))).toEqual([a.id]);
        expect(first.hasMore).toBe(true);
        const rest = await drive.listChanges({
            workspaceId: owner.workspaceId,
            since: first.nextCursor,
        });
        expect(rest.changes.map((c) => (c.kind === 'node' ? c.node.id : null))).toEqual([b.id]);
        expect(rest.hasMore).toBe(false);
        // Nothing new: the cursor stays put.
        const quiet = await drive.listChanges({
            workspaceId: owner.workspaceId,
            since: rest.nextCursor,
        });
        expect(quiet.changes).toEqual([]);
        expect(quiet.nextCursor).toBe(rest.nextCursor);
        // Trash, then purge: a change, then a tombstone with its parent still named.
        await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: b.id });
        await drive.purgeNode({ workspaceId: owner.workspaceId, nodeId: b.id });
        const after = await drive.listChanges({
            workspaceId: owner.workspaceId,
            since: rest.nextCursor,
        });
        expect(after.changes.map((c) => c.kind)).toEqual(['tombstone']);
        expect(after.changes[0]).toMatchObject({ nodeId: b.id, parentId: rootId });
        // Another workspace's changes never show.
        expect(
            (await drive.listChanges({ workspaceId: guest.workspaceId, since: 0 })).changes,
        ).toEqual([]);
    });

    test('a share’s feed is the subtree only, with moves across the boundary as events, until the share ends', async () => {
        const project = await folder(rootId, rootEpoch);
        const outside = await folder(rootId, rootEpoch);
        const shareId = await shareWithGuest(project);
        const start = await cursorNow(shareId);
        const inner = await folder(project.id, project.keyEpoch);
        await folder(outside.id, outside.keyEpoch);
        const feed = await feedOf(shareId, start);
        expect(feed.changes.map((c) => (c.kind === 'node' ? c.node.id : c.kind))).toEqual([
            inner.id,
        ]);
        // The cursor advanced past the outside change too, so it is never re-examined.
        expect((await feedOf(shareId, feed.cursor)).changes).toEqual([]);
        const elsewhere = await folder(outside.id, outside.keyEpoch);
        const skipped = await feedOf(shareId, feed.cursor);
        expect(skipped.changes).toEqual([]);

        // Move inner out: the grantee sees it leave. Move elsewhere in: it enters.
        await drive.moveNode({
            workspaceId: owner.workspaceId,
            nodeId: inner.id,
            parentId: outside.id,
            parentKeyEpoch: outside.keyEpoch,
            keyEnvelope: env(),
        });
        await drive.moveNode({
            workspaceId: owner.workspaceId,
            nodeId: elsewhere.id,
            parentId: project.id,
            parentKeyEpoch: project.keyEpoch,
            keyEnvelope: env(),
        });
        const moved = await feedOf(shareId, skipped.cursor);
        expect(moved.changes.map((c) => [c.kind, 'nodeId' in c ? c.nodeId : c.node.id])).toEqual([
            ['left', inner.id],
            ['node', elsewhere.id],
            ['entered', elsewhere.id],
        ]);
        // A move within the subtree is a plain change, no event; and the feed is state, not a
        // log: a node created and then moved since the cursor appears once, as it is now.
        const deeper = await folder(elsewhere.id, elsewhere.keyEpoch);
        await drive.moveNode({
            workspaceId: owner.workspaceId,
            nodeId: deeper.id,
            parentId: project.id,
            parentKeyEpoch: project.keyEpoch,
            keyEnvelope: env(),
        });
        const within = await feedOf(shareId, moved.cursor);
        expect(within.changes.map((c) => [c.kind, 'nodeId' in c ? c.nodeId : c.node.id])).toEqual([
            ['node', deeper.id],
        ]);
        expect(within.changes[0]?.kind === 'node' && within.changes[0].node.parentId).toBe(
            project.id,
        );

        // Someone else's share id, or a revoked share, gets nothing.
        expect(
            (await drive.listShareChanges({ shareId, granteeUserId: owner.userId })).status,
        ).toBe('not-found');
        await drive.revokeShare(owner.workspaceId, shareId);
        expect(
            (await drive.listShareChanges({ shareId, granteeUserId: guest.userId })).status,
        ).toBe('revoked');
    });

    test('deletions show only inside the share, however they were purged; older tombstones never', async () => {
        const project = await folder(rootId, rootEpoch);
        const outside = await folder(rootId, rootEpoch);
        const sub = await folder(project.id, project.keyEpoch);
        const leaf = await folder(sub.id, sub.keyEpoch);
        const gone = await folder(outside.id, outside.keyEpoch);
        const shareId = await shareWithGuest(project);
        const start = await cursorNow(shareId);
        // Inside: a folder deleted forever, and its child purged after it by the fan-out.
        await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: sub.id });
        await drive.purgeNode({ workspaceId: owner.workspaceId, nodeId: sub.id });
        expect(await drive.purgeDescendants()).toBe(1);
        // Outside: a deletion elsewhere in the owner's drive.
        await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: gone.id });
        await drive.purgeNode({ workspaceId: owner.workspaceId, nodeId: gone.id });
        const feed = await feedOf(shareId, start);
        const tombstones = feed.changes.filter((c) => c.kind === 'tombstone');
        expect(tombstones).toEqual([
            { kind: 'tombstone', nodeId: sub.id, parentId: project.id },
            { kind: 'tombstone', nodeId: leaf.id, parentId: sub.id },
        ]);
        // Nothing about the outside folder, in any form: not its trashing, not its tombstone.
        expect(JSON.stringify(feed.changes)).not.toContain(gone.id);
        // The owner's own feed still has every deletion.
        const own = await drive.listChanges({ workspaceId: owner.workspaceId, since: 0 });
        expect(own.changes.filter((c) => c.kind === 'tombstone').map((c) => c.nodeId)).toEqual(
            expect.arrayContaining([sub.id, leaf.id, gone.id]),
        );

        // A tombstone from before ancestors were recorded is never shown to a grantee.
        const old = await folder(project.id, project.keyEpoch);
        const before = await feedOf(shareId, feed.cursor);
        await drive.trashNode({ workspaceId: owner.workspaceId, nodeId: old.id });
        await drive.purgeNode({ workspaceId: owner.workspaceId, nodeId: old.id });
        await db
            .update(driveNodes)
            .set({ purgedAncestorIds: null })
            .where(eq(driveNodes.id, old.id));
        const after = await feedOf(shareId, before.cursor);
        expect(after.changes.filter((c) => c.kind === 'tombstone')).toEqual([]);
    });

    test('the cursor is sealed: no sequence numbers, a fresh value each poll, refused when tampered or moved', async () => {
        const project = await folder(rootId, rootEpoch);
        const other = await folder(rootId, rootEpoch);
        const shareId = await shareWithGuest(project);
        const otherShareId = await shareWithGuest(other);
        await folder(project.id, project.keyEpoch);
        const first = await feedOf(shareId);
        expect(first.changes.length).toBeGreaterThan(0);
        // Changes are in order but carry no sequence of the owner's.
        for (const change of first.changes) expect(change).not.toHaveProperty('changeSeq');
        // The same position seals to a different string every time.
        const again = await feedOf(shareId, first.cursor);
        const third = await feedOf(shareId, again.cursor);
        expect(again.changes).toEqual([]);
        expect(third.cursor).not.toBe(again.cursor);
        // One flipped character, a truncated cursor, or another share's cursor is refused.
        const flipped = `${first.cursor.slice(0, 10)}${first.cursor[10] === 'A' ? 'B' : 'A'}${first.cursor.slice(11)}`;
        for (const cursor of [flipped, first.cursor.slice(1), 'not a cursor'])
            expect(
                (await drive.listShareChanges({ shareId, granteeUserId: guest.userId, cursor }))
                    .status,
            ).toBe('bad-cursor');
        const foreign = await feedOf(otherShareId);
        expect(
            (
                await drive.listShareChanges({
                    shareId,
                    granteeUserId: guest.userId,
                    cursor: foreign.cursor,
                })
            ).status,
        ).toBe('bad-cursor');
    });
});

/*
 * A batch of folders (POST /drive/folders, up to 64) used to take one change
 * number for all of them. The feed pages on that number and its cursor is the
 * last one served, so a page ending inside a batch had the next page skip the
 * rest of it, on every pull.
 */
describe('a batch of folders in the feed', () => {
    const BATCH = 64;

    /* `count` folders in one request: the first `chain` nested in order, the rest under `parentId`. */
    async function batch(
        parentId: string,
        parentKeyEpoch: number,
        count: number,
        chain = 0,
        who = owner,
    ) {
        const from = (await drive.allocateKeyEpochs(who.workspaceId, count))!.from;
        const specs = Array.from({ length: count }, (_, index) => ({
            id: randomUUID(),
            keyEpoch: from + index,
        }));
        const created = await signed.createFolders({
            workspaceId: who.workspaceId,
            userId: who.userId,
            folders: specs.map((spec, index) => {
                const nested = index > 0 && index < chain;
                return {
                    id: spec.id,
                    parentId: nested ? specs[index - 1]!.id : parentId,
                    envelopes: {
                        keyEpoch: spec.keyEpoch,
                        parentKeyEpoch: nested ? specs[index - 1]!.keyEpoch : parentKeyEpoch,
                        keyEnvelope: env(),
                        metadataEnvelope: meta(),
                    },
                };
            }),
        });
        if (created.status !== 'created') throw new Error(created.status);
        return created.nodes.map((node) => node.id);
    }
    async function head(who = owner) {
        return (await drive.getPersonalWorkspace(who.userId))!.changeSeq;
    }
    /* Pulls the workspace feed from `since` to its end as a device does; every node change, in order. */
    async function pull(since: number, limit: number) {
        const ids: string[] = [];
        let cursor = since;
        for (let pages = 0; ; pages++) {
            if (pages > 100) throw new Error('the feed never ended');
            const page = await drive.listChanges({
                workspaceId: owner.workspaceId,
                since: cursor,
                limit,
            });
            expect(page.changes.length).toBeLessThanOrEqual(limit);
            if (page.changes.length) expect(page.nextCursor).toBeGreaterThan(cursor);
            for (const change of page.changes) if (change.kind === 'node') ids.push(change.node.id);
            cursor = page.nextCursor;
            if (!page.hasMore) break;
            // A page that says there is more has something in it.
            expect(page.changes.length).toBe(limit);
        }
        return { ids, cursor };
    }
    /*
     * The index as it was before it became unique, for rows written the old way; afterwards it is
     * unique again, whatever the body did (a body that left rows sharing a number leaves an empty
     * database behind it).
     */
    async function beforeUniqueIndex(body: () => Promise<void>) {
        await db.execute(sql`drop index drive_nodes_change_idx`);
        await db.execute(
            sql`create index drive_nodes_change_idx on drive_nodes (workspace_id, change_seq) where change_seq is not null`,
        );
        try {
            await body();
        } finally {
            if (!(await changeIndexIsUnique())) {
                await resetDatabase();
                await db.execute(sql`drop index if exists drive_nodes_change_uidx`);
                await db.execute(sql`drop index drive_nodes_change_idx`);
                await db.execute(
                    sql`create unique index drive_nodes_change_idx on drive_nodes (workspace_id, change_seq) where change_seq is not null`,
                );
            }
        }
    }
    async function changeIndexIsUnique() {
        const rows = await db.execute<{ name: string; def: string }>(
            sql`select indexname as name, indexdef as def from pg_indexes where tablename = 'drive_nodes' and indexname like 'drive_nodes_change_%'`,
        );
        return (
            rows.rows.length === 1 &&
            rows.rows[0]!.name === 'drive_nodes_change_idx' &&
            rows.rows[0]!.def.includes('UNIQUE')
        );
    }
    function migrationOf(name: string) {
        const statements = readFileSync(
            new URL(`../drizzle/${name}/migration.sql`, import.meta.url),
            'utf8',
        )
            .split('--> statement-breakpoint')
            .map((statement) => statement.replace(/^--.*$/gm, '').trim())
            .filter(Boolean);
        return () =>
            db.transaction(async (tx) => {
                for (const statement of statements) await tx.execute(sql.raw(statement));
            });
    }
    async function seqsOf(ids: string[]) {
        return new Map(
            (
                await db
                    .select({ id: driveNodes.id, changeSeq: driveNodes.changeSeq })
                    .from(driveNodes)
                    .where(inArray(driveNodes.id, ids))
            ).map((row) => [row.id, row.changeSeq!]),
        );
    }
    /* Gives every row of `ids` the number of the first, as the old code wrote a batch. */
    async function asOldCodeWrote(ids: string[]) {
        const seq = (await seqsOf([ids[0]!])).get(ids[0]!)!;
        await db.update(driveNodes).set({ changeSeq: seq }).where(inArray(driveNodes.id, ids));
    }
    function once(arrived: string[], expected: string[]) {
        const counts = new Map<string, number>();
        for (const id of arrived) counts.set(id, (counts.get(id) ?? 0) + 1);
        expect(expected.filter((id) => counts.get(id) !== 1)).toEqual([]);
    }

    test('a page boundary inside a batch loses none of it, in the workspace feed and a share’s', async () => {
        const project = await folder(rootId, rootEpoch);
        const shareId = await shareWithGuest(project);
        const start = await head();
        // Three folders, then the batch: a page of 7 ends four folders into it.
        for (let i = 0; i < 3; i++) await folder(rootId, rootEpoch);
        const before = await head();
        const ids = await batch(project.id, project.keyEpoch, BATCH, 4);
        const after = await folder(rootId, rootEpoch);

        const seqs = await db
            .select({ id: driveNodes.id, changeSeq: driveNodes.changeSeq })
            .from(driveNodes)
            .where(inArray(driveNodes.id, ids));
        const seqOf = new Map(seqs.map((row) => [row.id, row.changeSeq!]));
        // One number each, in the order sent: a chain's parents come first.
        expect(ids.map((id) => seqOf.get(id))).toEqual(ids.map((_, index) => before + 1 + index));
        expect(await head()).toBe(before + BATCH + 1);

        const pulled = await pull(start, 7);
        once(pulled.ids, [...ids, after.id]);
        expect(pulled.cursor).toBe(await head());

        // The share's feed, paged as small: every folder of the batch is inside the share.
        const shared: string[] = [];
        let cursor: string | undefined;
        for (let polls = 0; ; polls++) {
            if (polls > 100) throw new Error('the share feed never ended');
            const page = await drive.listShareChanges({
                shareId,
                granteeUserId: guest.userId,
                cursor,
                limit: 7,
            });
            if (page.status !== 'ok') throw new Error(page.status);
            for (const change of page.changes)
                if (change.kind === 'node') shared.push(change.node.id);
            cursor = page.cursor;
            if (!page.hasMore) break;
        }
        once(shared, ids);
    });

    test('a page wholly inside a batch moves the cursor on without skipping the rest', async () => {
        const start = await head();
        const ids = await batch(rootId, rootEpoch, BATCH);
        const first = await drive.listChanges({
            workspaceId: owner.workspaceId,
            since: start,
            limit: 10,
        });
        expect(first.changes.map((c) => (c.kind === 'node' ? c.node.id : c.kind))).toEqual(
            ids.slice(0, 10),
        );
        expect(first.hasMore).toBe(true);
        expect(first.nextCursor).toBe(start + 10);
        const rest = await pull(first.nextCursor, 10);
        expect(rest.ids).toEqual(ids.slice(10));
        expect(rest.cursor).toBe(start + BATCH);
    });

    test('the upgrade gives batches still sharing a number new ones, per workspace, so a device that skipped them gets them', async () => {
        const upgrade = migrationOf('20261020213416_change_seq_renumber');
        await beforeUniqueIndex(async () => {
            // The owner: a folder, a batch with a chain of 5, a folder, then a batch of 3 filed under
            // a folder of the first batch.
            const start = await head();
            const solo = await folder(rootId, rootEpoch);
            const first = await batch(rootId, rootEpoch, BATCH, 5);
            const between = await folder(rootId, rootEpoch);
            const [holder] = await db
                .select({ keyEpoch: driveNodes.keyEpoch })
                .from(driveNodes)
                .where(eq(driveNodes.id, first[10]!));
            const second = await batch(first[10]!, holder!.keyEpoch, 3);
            await asOldCodeWrote(first);
            await asOldCodeWrote(second);
            // The guest's workspace has a batch of its own, and a folder outside it.
            const guestRoot = await signed.createRoot({
                workspaceId: guest.workspaceId,
                userId: guest.userId,
                id: randomUUID(),
                envelopes: {
                    keyEpoch: (await drive.allocateKeyEpochs(guest.workspaceId, 1))!.from,
                    parentKeyEpoch: 1,
                    keyEnvelope: env(),
                    metadataEnvelope: meta(),
                },
            });
            if (guestRoot.status !== 'created') throw new Error(guestRoot.status);
            const guestBatch = await batch(guestRoot.root.id, guestRoot.root.keyEpoch, 4, 2, guest);
            await asOldCodeWrote(guestBatch);
            const kept = [solo.id, between.id, guestRoot.root.id];
            const keptBefore = await seqsOf(kept);

            // A device pulling 10 at a time ends its first page inside the first batch and never
            // sees the rest of it: the defect, as databases written before the fix hold it.
            const device = await pull(start, 10);
            expect(first.filter((id) => !device.ids.includes(id)).length).toBeGreaterThan(0);

            const ownerHead = await head();
            const guestHead = await head(guest);
            await upgrade();

            // Each workspace's rows take the numbers just above its own head, one each, and its
            // counter moves by exactly as many.
            const owned = [...first, ...second];
            const ownedSeqs = await seqsOf(owned);
            expect([...ownedSeqs.values()].sort((a, b) => a - b)).toEqual(
                owned.map((_, index) => ownerHead + 1 + index),
            );
            expect(await head()).toBe(ownerHead + owned.length);
            const guestSeqs = await seqsOf(guestBatch);
            expect([...guestSeqs.values()].sort((a, b) => a - b)).toEqual(
                guestBatch.map((_, index) => guestHead + 1 + index),
            );
            expect(await head(guest)).toBe(guestHead + guestBatch.length);
            // Parents first: down the chain, and the second batch's parent before all of it.
            for (let i = 1; i < 5; i++)
                expect(ownedSeqs.get(first[i]!)!).toBeGreaterThan(ownedSeqs.get(first[i - 1]!)!);
            for (const id of second)
                expect(ownedSeqs.get(id)!).toBeGreaterThan(ownedSeqs.get(first[10]!)!);
            expect(guestSeqs.get(guestBatch[1]!)!).toBeGreaterThan(guestSeqs.get(guestBatch[0]!)!);
            // What never shared a number kept its own.
            expect(await seqsOf(kept)).toEqual(keptBefore);

            // The device, from where it stopped, now gets both batches whole; a fresh pull gets
            // every folder exactly once.
            const caughtUp = await pull(device.cursor, 10);
            once(caughtUp.ids, owned);
            once((await pull(start, 10)).ids, [solo.id, ...first, between.id, ...second]);

            // Run again (a retried deploy): nothing shares a number, so nothing moves.
            await upgrade();
            expect(await seqsOf([...owned, ...guestBatch, ...kept])).toEqual(
                new Map([...ownedSeqs, ...guestSeqs, ...keptBefore]),
            );
            expect(await head()).toBe(ownerHead + owned.length);
            expect(await head(guest)).toBe(guestHead + guestBatch.length);
        });
    });

    test('the unique index release renumbers what older containers wrote meanwhile, then refuses a shared number', async () => {
        await beforeUniqueIndex(async () => {
            // The previous release ran; an older container still beside it then wrote a batch the
            // old way.
            await migrationOf('20261020213416_change_seq_renumber')();
            const start = await head();
            const late = await batch(rootId, rootEpoch, BATCH, 3);
            const after = await folder(rootId, rootEpoch);
            await asOldCodeWrote(late);
            const device = await pull(start, 10);
            expect(late.filter((id) => !device.ids.includes(id)).length).toBeGreaterThan(0);
            const keptBefore = await seqsOf([after.id]);
            const headBefore = await head();

            await migrationOf('20261020214235_change_seq_unique')();

            expect([...(await seqsOf(late)).values()].sort((a, b) => a - b)).toEqual(
                late.map((_, index) => headBefore + 1 + index),
            );
            expect(await head()).toBe(headBefore + BATCH);
            expect(await seqsOf([after.id])).toEqual(keptBefore);
            once((await pull(device.cursor, 10)).ids, late);
            // One index, unique, under the old name.
            expect(await changeIndexIsUnique()).toBe(true);
            const taken = (await seqsOf([late[0]!])).get(late[0]!)!;
            await expect(
                db.update(driveNodes).set({ changeSeq: taken }).where(eq(driveNodes.id, late[1]!)),
            ).rejects.toThrow();
        });
    });

    test('a clash on the change number fails loudly; only a clash on the id is "already exists"', async () => {
        // The next number is taken already (a bug the index catches): the write must not pass
        // for an id that exists.
        const rootSeq = (await seqsOf([rootId])).get(rootId)!;
        const before = await head();
        await db
            .update(driveNodes)
            .set({ changeSeq: before + 1 })
            .where(eq(driveNodes.id, rootId));
        const clash = signed.createFolders({
            workspaceId: owner.workspaceId,
            userId: owner.userId,
            folders: [
                {
                    id: randomUUID(),
                    parentId: rootId,
                    envelopes: {
                        keyEpoch: await epoch(),
                        parentKeyEpoch: rootEpoch,
                        keyEnvelope: env(),
                        metadataEnvelope: meta(),
                    },
                },
            ],
        });
        await expect(clash).rejects.toMatchObject({
            cause: { code: '23505', constraint: 'drive_nodes_change_idx' },
        });
        expect(await head()).toBe(before);
        await db.update(driveNodes).set({ changeSeq: rootSeq }).where(eq(driveNodes.id, rootId));
        const existing = await folder(rootId, rootEpoch);
        const again = await signed.createFolders({
            workspaceId: owner.workspaceId,
            userId: owner.userId,
            folders: [
                {
                    id: existing.id,
                    parentId: rootId,
                    envelopes: {
                        keyEpoch: await epoch(),
                        parentKeyEpoch: rootEpoch,
                        keyEnvelope: env(),
                        metadataEnvelope: meta(),
                    },
                },
            ],
        });
        expect(again).toMatchObject({ status: 'conflict', id: existing.id });
    });
});
