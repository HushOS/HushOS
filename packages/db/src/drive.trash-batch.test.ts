import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
    closeDatabase,
    createTestAccount,
    createTestFamily,
    createTestIdentity,
    resetDatabase,
} from '../test/helpers';
import * as signed from '../test/signed';
import { db } from './client';
import * as drive from './drive';
import { driveNodes, groupHolds, groupMemberships, workspaceKeys } from './schema';

/*
 * A selection to the trash, and back, in one transaction (trashNodes,
 * restoreNodes): each node moves as trashNode or restoreNode would move it, or
 * is refused on its own, and nothing about one keeps another back.
 */

type Account = Awaited<ReturnType<typeof createTestAccount>>;
type Folder = { id: string; keyEpoch: number };

let owner: Account;
let root: Folder;

/* Holds the workspace's key, as every member of a workspace does (membership.ts). */
async function hold(workspaceId: string, userId: string) {
    await db.insert(workspaceKeys).values({
        workspaceId,
        userId,
        keyVersion: 1,
        workspaceKeyVersion: 1,
        wrappingSalt: randomBytes(32),
        wrappingNonce: randomBytes(24),
        encryptedKey: randomBytes(48),
    });
}

async function makeRoot(workspaceId: string, userId: string): Promise<Folder> {
    const keyEpoch = (await drive.allocateKeyEpochs(workspaceId, 1))!.from;
    const created = await signed.createRoot({
        workspaceId,
        userId,
        id: randomUUID(),
        envelopes: {
            keyEpoch,
            parentKeyEpoch: 1,
            keyEnvelope: randomBytes(72),
            metadataEnvelope: randomBytes(100),
        },
    });
    if (created.status !== 'created') throw new Error(created.status);
    return { id: created.root.id, keyEpoch: created.root.keyEpoch };
}

/* `count` folders under `parent`, in the owner's workspace unless another is named. */
async function folders(
    parent: Folder,
    count: number,
    where: { workspaceId: string; userId: string } = owner,
): Promise<Folder[]> {
    const range = (await drive.allocateKeyEpochs(where.workspaceId, count))!;
    const made = Array.from({ length: count }, (_, i) => ({
        id: randomUUID(),
        parentId: parent.id,
        envelopes: {
            keyEpoch: range.from + i,
            parentKeyEpoch: parent.keyEpoch,
            keyEnvelope: randomBytes(72),
            metadataEnvelope: randomBytes(100),
        },
    }));
    for (let start = 0; start < made.length; start += 100) {
        const created = await signed.createFolders({
            workspaceId: where.workspaceId,
            userId: where.userId,
            folders: made.slice(start, start + 100),
        });
        if (created.status !== 'created') throw new Error(created.status);
    }
    return made.map((folder) => ({ id: folder.id, keyEpoch: folder.envelopes.keyEpoch }));
}
const folder = async (parent: Folder, where?: { workspaceId: string; userId: string }) =>
    (await folders(parent, 1, where))[0]!;

async function rows(ids: string[]) {
    const found = await db
        .select({
            id: driveNodes.id,
            trashedAt: driveNodes.trashedAt,
            changeSeq: driveNodes.changeSeq,
        })
        .from(driveNodes)
        .where(inArray(driveNodes.id, ids));
    return new Map(found.map((row) => [row.id, row]));
}
/* Whether a node is in the trash, itself or through a folder it is in. */
async function inTrash(id: string) {
    const chain = await db.transaction((tx) => drive.walk(tx, id));
    return chain!.trashed;
}
async function workspaceSeq(workspaceId = owner.workspaceId) {
    const result = await db.execute<{ change_seq: string }>(
        sql`select change_seq from workspaces where id = ${workspaceId}::uuid`,
    );
    return Number(result.rows[0]!.change_seq);
}
async function trashedCount(workspaceId = owner.workspaceId) {
    const found = await db
        .select({ id: driveNodes.id })
        .from(driveNodes)
        .where(and(eq(driveNodes.workspaceId, workspaceId), isNotNull(driveNodes.trashedAt)));
    return found.length;
}
const trashAll = (nodeIds: string[], writer = owner.userId, workspaceId = owner.workspaceId) =>
    drive.trashNodes({ workspaceId, nodeIds, writer });
const restoreAll = (nodeIds: string[], writer = owner.userId, workspaceId = owner.workspaceId) =>
    drive.restoreNodes({ workspaceId, nodeIds, writer });
const trashOne = (nodeId: string, writer = owner.userId, workspaceId = owner.workspaceId) =>
    drive.trashNode({ workspaceId, nodeId, writer });
/* Each outcome as `id: status` (or `id: refused reason`), for comparing a batch at a glance. */
const summary = (outcomes: (drive.TrashOutcome | drive.RestoreOutcome)[]) =>
    Object.fromEntries(
        outcomes.map((outcome) => [
            outcome.id,
            outcome.status === 'refused'
                ? `refused ${outcome.reason}`
                : outcome.status === 'covered'
                  ? `covered by ${outcome.by}`
                  : outcome.status,
        ]),
    );

beforeEach(async () => {
    await resetDatabase();
    owner = await createTestAccount();
    await createTestIdentity(owner.userId);
    await hold(owner.workspaceId, owner.userId);
    root = await makeRoot(owner.workspaceId, owner.userId);
});
afterAll(closeDatabase);

describe('a selection to the trash', () => {
    test('a refused item keeps none of the rest back, and what is refused is left as it was', async () => {
        const [a, b, d] = await folders(root, 3);
        expect((await trashOne(b!.id)).status).toBe('ok');
        const bBefore = (await rows([b!.id])).get(b!.id)!;
        const missing = randomUUID();
        const outcomes = await trashAll([a!.id, b!.id, missing, root.id, d!.id]);
        expect(outcomes.map((outcome) => outcome.id)).toEqual([
            a!.id,
            b!.id,
            missing,
            root.id,
            d!.id,
        ]);
        expect(summary(outcomes)).toEqual({
            [a!.id]: 'trashed',
            [b!.id]: 'refused trashed',
            [missing]: 'refused not-found',
            [root.id]: 'refused root',
            [d!.id]: 'trashed',
        });
        const after = await rows([a!.id, b!.id, d!.id, root.id]);
        // What the answer says moved is what the rows say: the same time and change number.
        for (const outcome of outcomes)
            if (outcome.status === 'trashed') {
                expect(after.get(outcome.id)!.trashedAt).toEqual(outcome.trashedAt);
                expect(after.get(outcome.id)!.changeSeq).toBe(outcome.changeSeq);
            }
        expect(after.get(b!.id)).toEqual(bBefore);
        expect(after.get(root.id)!.trashedAt).toBeNull();
    });

    test('a folder and what is inside it: the folder moves, what is inside goes with it, whatever the order', async () => {
        const [outer, sibling] = await folders(root, 2);
        const child = await folder(outer!);
        const grandchild = await folder(child);
        // The child and grandchild before their folder; the grandchild is reported against the
        // outermost folder that went, which is what Undo puts back.
        const outcomes = await trashAll([grandchild.id, child.id, outer!.id, sibling!.id]);
        expect(summary(outcomes)).toEqual({
            [grandchild.id]: `covered by ${outer!.id}`,
            [child.id]: `covered by ${outer!.id}`,
            [outer!.id]: 'trashed',
            [sibling!.id]: 'trashed',
        });
        const after = await rows([child.id, grandchild.id]);
        // Neither carries a trashed_at of its own: trashed separately, they would stay behind on
        // Undo of the folder and show in the trash as items of their own.
        expect(after.get(child.id)!.trashedAt).toBeNull();
        expect(after.get(grandchild.id)!.trashedAt).toBeNull();
        expect(await inTrash(grandchild.id)).toBe(true);
        const listed = await drive.listTrash({ workspaceId: owner.workspaceId });
        expect(listed.items.map((item) => item.node.id).sort()).toEqual(
            [outer!.id, sibling!.id].sort(),
        );
        expect(summary(await restoreAll([outer!.id]))).toEqual({ [outer!.id]: 'restored' });
        expect(await inTrash(grandchild.id)).toBe(false);
    });

    test('an item inside a refused item of the same request is judged on its own', async () => {
        const outer = await folder(root);
        const child = await folder(outer);
        // The top folder is refused; what is in it still goes.
        expect(summary(await trashAll([root.id, outer.id]))).toEqual({
            [root.id]: 'refused root',
            [outer.id]: 'trashed',
        });
        expect(summary(await restoreAll([outer.id]))).toEqual({ [outer.id]: 'restored' });
        // A guest who may trash the item but not its folder: the folder is refused, the item moves
        // on its own, and the folder stays.
        const guest = await createTestAccount();
        await createTestIdentity(guest.userId);
        for (const [node, role] of [
            [outer, 'viewer'],
            [child, 'editor'],
        ] as const) {
            const shared = await drive.createShare({
                workspaceId: owner.workspaceId,
                nodeId: node.id,
                granterUserId: owner.userId,
                granteeUserId: guest.userId,
                role,
                keyEpoch: node.keyEpoch,
                shareEnvelope: randomBytes(4565),
            });
            if (shared.status !== 'ok') throw new Error(shared.status);
        }
        expect(summary(await trashAll([child.id, outer.id], guest.userId))).toEqual({
            [child.id]: 'trashed',
            [outer.id]: 'refused forbidden',
        });
        expect((await rows([child.id])).get(child.id)!.trashedAt).not.toBeNull();
        expect(await inTrash(outer.id)).toBe(false);
    });

    test('each item is checked against the writer’s own access to it, under the lock', async () => {
        const guest = await createTestAccount();
        await createTestIdentity(guest.userId);
        const [edited, viewed, unshared] = await folders(root, 3);
        const inEdited = await folder(edited!);
        const inViewed = await folder(viewed!);
        const inUnshared = await folder(unshared!);
        for (const [node, role] of [
            [edited!, 'editor'],
            [viewed!, 'viewer'],
        ] as const) {
            const shared = await drive.createShare({
                workspaceId: owner.workspaceId,
                nodeId: node.id,
                granterUserId: owner.userId,
                granteeUserId: guest.userId,
                role,
                keyEpoch: node.keyEpoch,
                shareEnvelope: randomBytes(4565),
            });
            if (shared.status !== 'ok') throw new Error(shared.status);
        }
        const outcomes = await trashAll([inViewed.id, inEdited.id, inUnshared.id], guest.userId);
        // A viewer is told no; a node they cannot see at all is not there, as for one trash.
        expect(summary(outcomes)).toEqual({
            [inViewed.id]: 'refused forbidden',
            [inEdited.id]: 'trashed',
            [inUnshared.id]: 'refused not-found',
        });
        expect(await inTrash(inViewed.id)).toBe(false);
        expect(await inTrash(inUnshared.id)).toBe(false);
        expect(await inTrash(inEdited.id)).toBe(true);
    });

    test('change numbers: one each, in the order sent, so a feed read one at a time sees every item', async () => {
        const [a, b, c, d, e, f, x] = await folders(root, 7);
        expect((await trashOne(x!.id)).status).toBe('ok');
        // One at a time, as the single route does it: consecutive numbers in the order sent.
        const before = await workspaceSeq();
        const singles = [];
        for (const node of [d!, f!, e!]) singles.push(await trashOne(node.id));
        expect(
            singles.map((result) => (result.status === 'ok' ? result.node.changeSeq : 0)),
        ).toEqual([before + 1, before + 2, before + 3]);
        // A batch in the same way, out of id order, with a refusal among them that takes none.
        const start = await workspaceSeq();
        const outcomes = await trashAll([c!.id, x!.id, a!.id, b!.id]);
        expect(
            outcomes.map((outcome) => (outcome.status === 'trashed' ? outcome.changeSeq : null)),
        ).toEqual([start + 1, null, start + 2, start + 3]);
        expect(await workspaceSeq()).toBe(start + 3);
        // A device reading the feed a page of one at a time from before the batch sees each item
        // once, in the order sent; numbers shared within a batch would lose all but one of them.
        const seen: string[] = [];
        let since = start;
        for (let pages = 0; pages < 10; pages++) {
            const page = await drive.listChanges({
                workspaceId: owner.workspaceId,
                since,
                limit: 1,
            });
            seen.push(
                ...page.changes.map((change) => (change.kind === 'node' ? change.node.id : '')),
            );
            if (page.nextCursor === since) break;
            since = page.nextCursor;
        }
        expect(seen).toEqual([c!.id, a!.id, b!.id]);
    });

    test('a batch and single trashes on the same workspace at once never deadlock, and each item moves once', async () => {
        for (let round = 0; round < 8; round++) {
            const [outer, s1, s2, s3] = await folders(root, 4);
            const [c1, c2] = await folders(outer!, 2);
            const before = await workspaceSeq();
            // The single trashes go for items the batch names too, and for one inside its folder.
            const [batch, other, one, two] = await Promise.all([
                trashAll(round % 2 ? [s1!.id, outer!.id, s2!.id] : [outer!.id, s2!.id, s1!.id]),
                trashAll([s3!.id, c2!.id]),
                trashOne(c1!.id),
                trashOne(s2!.id),
            ]);
            const byId = new Map([...batch, ...other].map((outcome) => [outcome.id, outcome]));
            // Each moved exactly once, whoever got there first.
            expect(byId.get(outer!.id)!.status).toBe('trashed');
            expect([byId.get(s2!.id)!.status === 'trashed', two.status === 'ok']).toContain(true);
            expect(byId.get(s2!.id)!.status === 'trashed' && two.status === 'ok').toBe(false);
            const seqs = [
                ...[...byId.values()].flatMap((outcome) =>
                    outcome.status === 'trashed' ? [outcome.changeSeq] : [],
                ),
                ...[one, two].flatMap((result) =>
                    result.status === 'ok' ? [result.node.changeSeq!] : [],
                ),
            ];
            expect(new Set(seqs).size).toBe(seqs.length);
            for (const seq of seqs) expect(seq).toBeGreaterThan(before);
            const own = await rows([c1!.id, c2!.id, s2!.id]);
            // c1 carries its own trashed_at only if its own trash moved it.
            expect(own.get(c1!.id)!.trashedAt !== null).toBe(one.status === 'ok');
            for (const node of [outer!, s1!, s2!, s3!, c1!, c2!])
                expect(await inTrash(node.id)).toBe(true);
        }
    });

    test('takes at most 500 items, each named once; a larger request moves nothing', async () => {
        const many = await folders(root, 500);
        const ids = many.map((node) => node.id);
        await expect(trashAll([...ids, randomUUID()])).rejects.toThrow(RangeError);
        await expect(trashAll([ids[0]!, ids[1]!, ids[0]!])).rejects.toThrow(RangeError);
        await expect(trashAll([])).rejects.toThrow(RangeError);
        expect(await trashedCount()).toBe(0);
        const before = await workspaceSeq();
        const started = performance.now();
        const outcomes = await trashAll(ids);
        const took = performance.now() - started;
        expect(outcomes.every((outcome) => outcome.status === 'trashed')).toBe(true);
        expect(await trashedCount()).toBe(500);
        expect(await workspaceSeq()).toBe(before + 500);
        await expect(restoreAll([...ids, randomUUID()])).rejects.toThrow(RangeError);
        expect(await trashedCount()).toBe(500);
        const back = await restoreAll(ids);
        expect(back.every((outcome) => outcome.status === 'restored')).toBe(true);
        expect(await trashedCount()).toBe(0);
        // For the record: how long 500 hold the workspace's lock here.
        console.info(`trashNodes: 500 items in ${Math.round(took)} ms`);
    }, 60_000);
});

describe('a family folder', () => {
    async function family() {
        const ana = owner;
        const ben = await createTestAccount();
        await createTestIdentity(ben.userId);
        const { groupId, areaIds } = await createTestFamily({
            organizerId: ana.userId,
            members: [{ userId: ben.userId }],
        });
        const areaId = areaIds[0]!;
        for (const person of [ana, ben]) await hold(areaId, person.userId);
        const top = await makeRoot(areaId, ana.userId);
        const [a, b] = await folders(top, 2, { workspaceId: areaId, userId: ana.userId });
        return { ben, groupId, areaId, a: a!, b: b! };
    }

    test('a member trashes what is in it', async () => {
        const { ben, areaId, a, b } = await family();
        expect(summary(await trashAll([a.id, b.id], ben.userId, areaId))).toEqual({
            [a.id]: 'trashed',
            [b.id]: 'trashed',
        });
        expect(summary(await restoreAll([a.id, b.id], ben.userId, areaId))).toEqual({
            [a.id]: 'restored',
            [b.id]: 'restored',
        });
    });

    test.each(['is held ahead of a removal', 'has left'])(
        'a member who %s moves nothing, and nothing is put back by them',
        async (change) => {
            const { ben, groupId, areaId, a, b } = await family();
            expect((await trashOne(b.id, owner.userId, areaId)).status).toBe('ok');
            if (change === 'has left')
                await db
                    .update(groupMemberships)
                    .set({ state: 'removed', leftAt: new Date() })
                    .where(eq(groupMemberships.userId, ben.userId));
            else
                await db.insert(groupHolds).values({
                    groupId,
                    userId: ben.userId,
                    expiresAt: new Date(Date.now() + 86_400_000),
                });
            const seq = await workspaceSeq(areaId);
            await expect(trashAll([a.id], ben.userId, areaId)).rejects.toBeInstanceOf(
                drive.AccessEndedError,
            );
            await expect(restoreAll([b.id], ben.userId, areaId)).rejects.toBeInstanceOf(
                drive.AccessEndedError,
            );
            expect(await inTrash(a.id)).toBe(false);
            expect(await inTrash(b.id)).toBe(true);
            expect(await workspaceSeq(areaId)).toBe(seq);
        },
    );
});

describe('Undo', () => {
    test('puts back what it can, says why not for the rest, and waits for a folder in the same request', async () => {
        const [a, notTrashed, removed, outer, first, lone] = await folders(root, 6);
        const child = await folder(outer!);
        const after = await folder(first!);
        const stranded = await folder(lone!);
        // Two levels below a folder that stays in the trash, with nothing trashed between.
        const middle = await folder(lone!);
        const deep = await folder(middle);
        for (const node of [a!, removed!, child, outer!, after, first!, stranded, deep, lone!])
            expect((await trashOne(node.id)).status).toBe('ok');
        expect(
            (await drive.removeNode({ workspaceId: owner.workspaceId, nodeId: removed!.id }))
                .status,
        ).toBe('ok');
        const start = await workspaceSeq();
        // One child listed before its folder and one after, each in the trash on its own; the
        // stranded nodes' folder stays in the trash, so they have nowhere to go back to.
        const outcomes = await restoreAll([
            child.id,
            a!.id,
            first!.id,
            notTrashed!.id,
            removed!.id,
            stranded.id,
            deep.id,
            outer!.id,
            after.id,
        ]);
        expect(summary(outcomes)).toEqual({
            [child.id]: 'restored',
            [a!.id]: 'restored',
            [first!.id]: 'restored',
            [notTrashed!.id]: 'refused not-trashed',
            [removed!.id]: 'refused removed',
            [stranded.id]: 'refused parent-trashed',
            [deep.id]: 'refused parent-trashed',
            [outer!.id]: 'restored',
            [after.id]: 'restored',
        });
        const seqOf = (id: string) => {
            const outcome = outcomes.find((entry) => entry.id === id)!;
            return outcome.status === 'restored' ? outcome.changeSeq : 0;
        };
        // Each folder came back before the child that waited for it; numbers one each.
        expect(seqOf(outer!.id)).toBeLessThan(seqOf(child.id));
        expect(seqOf(first!.id)).toBeLessThan(seqOf(after.id));
        const back = [a!.id, first!.id, outer!.id, child.id, after.id];
        expect(new Set(back.map(seqOf)).size).toBe(back.length);
        expect(await workspaceSeq()).toBe(start + back.length);
        const found = await rows([...back, removed!.id, stranded.id, deep.id]);
        for (const id of back) expect(found.get(id)!.trashedAt).toBeNull();
        for (const id of [removed!.id, stranded.id, deep.id])
            expect(found.get(id)!.trashedAt).not.toBeNull();
        expect(await inTrash(child.id)).toBe(false);
        expect(await inTrash(after.id)).toBe(false);
    });
});
