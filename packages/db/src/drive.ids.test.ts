import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
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
import * as reports from './reports';
import { driveNodes, driveReports, users } from './schema';

/*
 * Clients make the ids of nodes, versions, objects, links and reports. One
 * that already exists is refused with the same answer whichever workspace
 * holds it, so a write cannot be used to learn whether an id is in use in
 * someone else's drive. A refusal undoes the whole write: no storage stays
 * reserved, no node is left without a version, no part of a batch lands.
 */

const MiB = 1024n * 1024n;

type Account = Awaited<ReturnType<typeof createTestAccount>>;
type Drive = { account: Account; root: { id: string; keyEpoch: number } };

let mine: Drive;
let theirs: Drive;

async function epoch(workspaceId: string) {
    return (await drive.allocateKeyEpochs(workspaceId, 1))!.from;
}

async function driveFor(): Promise<Drive> {
    const account = await createTestAccount({ quotaBytes: 100n * MiB });
    await createTestIdentity(account.userId);
    const created = await signed.createRoot({
        workspaceId: account.workspaceId,
        userId: account.userId,
        id: randomUUID(),
        envelopes: {
            keyEpoch: await epoch(account.workspaceId),
            parentKeyEpoch: 1,
            keyEnvelope: randomBytes(72),
            metadataEnvelope: randomBytes(100),
        },
    });
    if (created.status !== 'created') throw new Error(created.status);
    return { account, root: { id: created.root.id, keyEpoch: created.root.keyEpoch } };
}

async function newFolder(on: Drive, id: string, parent = on.root) {
    return signed.createFolders({
        workspaceId: on.account.workspaceId,
        userId: on.account.userId,
        folders: [
            {
                id,
                parentId: parent.id,
                envelopes: {
                    keyEpoch: await epoch(on.account.workspaceId),
                    parentKeyEpoch: parent.keyEpoch,
                    keyEnvelope: randomBytes(72),
                    metadataEnvelope: randomBytes(100),
                },
            },
        ],
    });
}

async function begin(on: Drive, ids: { node?: string; version?: string; object?: string } = {}) {
    const objectId = ids.object ?? randomUUID();
    return signed.beginUpload({
        workspaceId: on.account.workspaceId,
        userId: on.account.userId,
        node: {
            existing: false,
            id: ids.node ?? randomUUID(),
            parentId: on.root.id,
            envelopes: {
                keyEpoch: await epoch(on.account.workspaceId),
                parentKeyEpoch: on.root.keyEpoch,
                keyEnvelope: randomBytes(72),
                metadataEnvelope: randomBytes(100),
            },
        },
        version: { id: ids.version ?? randomUUID(), contentKeyEnvelope: randomBytes(84) },
        object: {
            id: objectId,
            objectKey: `ws/${on.account.workspaceId}/${objectId}`,
            contentSuite: 3,
            chunkSize: Number(8n * MiB),
            chunkCount: 1,
            contentNonce: randomBytes(16),
            ciphertextSize: 1n * MiB,
        },
        multipartId: `mp-${objectId}`,
        expiresAt: new Date(Date.now() + 3600_000),
    });
}

/* A published file: its node, version and object ids are all taken from here on. */
async function publish(on: Drive) {
    const ids = { node: randomUUID(), version: randomUUID(), object: randomUUID() };
    const begun = await begin(on, ids);
    if (begun.status !== 'ok') throw new Error(begun.status);
    await drive.startCompleting(on.account.workspaceId, begun.uploadId);
    const done = await drive.finishCompleting(on.account.workspaceId, begun.uploadId, 1n * MiB);
    if (done.status !== 'published') throw new Error(done.status);
    return ids;
}

async function exists(nodeIds: string[]) {
    const rows = await db
        .select({ id: driveNodes.id })
        .from(driveNodes)
        .where(inArray(driveNodes.id, nodeIds));
    return rows.map((row) => row.id);
}

async function reserved(on: Drive) {
    return (await drive.getStorage(on.account.workspaceId))!.reserved;
}

beforeEach(async () => {
    await resetDatabase();
    mine = await driveFor();
    theirs = await driveFor();
});
afterAll(closeDatabase);

describe('folders', () => {
    test('a taken folder id is the same conflict in my drive and in theirs', async () => {
        const own = randomUUID();
        const other = randomUUID();
        expect((await newFolder(mine, own)).status).toBe('created');
        expect((await newFolder(theirs, other)).status).toBe('created');
        expect(await newFolder(mine, own)).toEqual({ status: 'conflict', id: own });
        expect(await newFolder(mine, other)).toEqual({ status: 'conflict', id: other });
    });

    test('a batch refused at a taken id lands none of its folders', async () => {
        const taken = randomUUID();
        expect((await newFolder(theirs, taken)).status).toBe('created');
        const first = randomUUID();
        const firstEpoch = await epoch(mine.account.workspaceId);
        const secondEpoch = await epoch(mine.account.workspaceId);
        const batch = await signed.createFolders({
            workspaceId: mine.account.workspaceId,
            userId: mine.account.userId,
            folders: [
                {
                    id: first,
                    parentId: mine.root.id,
                    envelopes: {
                        keyEpoch: firstEpoch,
                        parentKeyEpoch: mine.root.keyEpoch,
                        keyEnvelope: randomBytes(72),
                        metadataEnvelope: randomBytes(100),
                    },
                },
                {
                    id: taken,
                    parentId: first,
                    envelopes: {
                        keyEpoch: secondEpoch,
                        parentKeyEpoch: firstEpoch,
                        keyEnvelope: randomBytes(72),
                        metadataEnvelope: randomBytes(100),
                    },
                },
            ],
        });
        expect(batch).toEqual({ status: 'conflict', id: taken });
        expect(await exists([first])).toEqual([]);
    });
});

describe('uploads', () => {
    test('a taken node, version or object id is the same conflict in my drive and in theirs, and reserves nothing', async () => {
        const own = await publish(mine);
        const other = await publish(theirs);
        const before = await reserved(mine);
        for (const kind of ['node', 'version', 'object'] as const)
            for (const taken of [own, other]) {
                const fresh = randomUUID();
                const ids = { node: fresh, [kind]: taken[kind] };
                expect(await begin(mine, ids)).toEqual({ status: 'conflict' });
                // Nothing of the refused begin stays: no reservation, no hidden node.
                expect(await reserved(mine)).toBe(before);
                if (kind !== 'node') expect(await exists([fresh])).toEqual([]);
            }
    });
});

describe('copies', () => {
    test('a taken node or version id is the same conflict either way, and leaves no node behind', async () => {
        const source = await publish(mine);
        const own = await publish(mine);
        const other = await publish(theirs);
        const copy = async (ids: { node: string; version: string }) =>
            signed.copyFile({
                workspaceId: mine.account.workspaceId,
                userId: mine.account.userId,
                sourceNodeId: source.node,
                sourceVersionId: source.version,
                node: {
                    id: ids.node,
                    parentId: mine.root.id,
                    envelopes: {
                        keyEpoch: await epoch(mine.account.workspaceId),
                        parentKeyEpoch: mine.root.keyEpoch,
                        keyEnvelope: randomBytes(72),
                        metadataEnvelope: randomBytes(100),
                    },
                },
                version: { id: ids.version, contentKeyEnvelope: randomBytes(84) },
            });
        const usedBefore = (await drive.getStorage(mine.account.workspaceId))!.used;
        for (const taken of [own, other]) {
            expect(await copy({ node: taken.node, version: randomUUID() })).toEqual({
                status: 'conflict',
            });
            const fresh = randomUUID();
            expect(await copy({ node: fresh, version: taken.version })).toEqual({
                status: 'conflict',
            });
            expect(await exists([fresh])).toEqual([]);
        }
        expect((await drive.getStorage(mine.account.workspaceId))!.used).toBe(usedBefore);
    });
});

describe('links', () => {
    test('a taken link id is the same conflict in my drive and in theirs', async () => {
        const create = (on: Drive, id: string) =>
            drive.createLink({
                id,
                workspaceId: on.account.workspaceId,
                nodeId: on.root.id,
                granterUserId: on.account.userId,
                tokenHash: randomBytes(32),
                keyEpoch: on.root.keyEpoch,
                linkEnvelope: randomBytes(72),
                linkSalt: randomBytes(16),
                secretEnvelope: randomBytes(136),
                hasPassword: false,
                expiresAt: null,
            });
        const own = randomUUID();
        const other = randomUUID();
        expect((await create(mine, own)).status).toBe('ok');
        expect((await create(theirs, other)).status).toBe('ok');
        expect(await create(mine, own)).toEqual({ status: 'conflict' });
        expect(await create(mine, other)).toEqual({ status: 'conflict' });
    });
});

describe('reports', () => {
    test('a taken report id is the same conflict whoever filed it, and files nothing', async () => {
        const operator = await createTestAccount();
        await createTestIdentity(operator.userId);
        await db.update(users).set({ role: 'admin' }).where(eq(users.id, operator.userId));
        const file = async (on: Drive, id: string) =>
            reports.createReport({
                id,
                workspaceId: on.account.workspaceId,
                nodeId: on.root.id,
                keyEpoch: on.root.keyEpoch,
                linkId: null,
                shareId: null,
                category: 'other',
                reason: 'Looks wrong.',
                reporterUserId: null,
                reporterEmail: null,
                reporterAddressHash: null,
                keys: [{ operatorUserId: operator.userId, keyEnvelope: randomBytes(112) }],
            });
        const own = randomUUID();
        const other = randomUUID();
        expect((await file(mine, own)).status).toBe('ok');
        expect((await file(theirs, other)).status).toBe('ok');
        expect(await file(mine, own)).toEqual({ status: 'conflict' });
        expect(await file(mine, other)).toEqual({ status: 'conflict' });
        const rows = await db.select({ id: driveReports.id }).from(driveReports);
        expect(rows.map((row) => row.id).sort()).toEqual([own, other].sort());
    });
});
