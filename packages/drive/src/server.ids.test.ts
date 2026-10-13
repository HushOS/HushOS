import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { metadataStatement, versionStatement } from '../../db/src/signatures';
import { closeDatabase, resetDatabase, signerFor } from '../../db/test/helpers';
import { epoch, file, folder, member, minted, root, share, type Account } from '../test/fixtures';
import * as server from './server';

/*
 * A create names its ids with the seeds they were derived from, and the server
 * derives them again in the workspace of the request before anything else.
 * The answer to an id not made for that workspace must say nothing about the
 * id: an id that exists in someone else's workspace (sent with the very seed
 * that made it there) and a fresh random one get byte for byte the same
 * response, as do a missing seed and a seed of another kind. Ids derived for
 * the workspace go through, and replaying one's own seed is the only 409.
 */

vi.mock('./storage', () => ({
    objectKey: (workspaceId: string, objectId: string) => `ws/${workspaceId}/${objectId}`,
    primaryStore: () => ({
        createMultipart: async () => 'multipart-test',
        abortMultipart: async () => {},
        presignGet: async (key: string) => `https://store.test/${key}`,
        presignPart: async (key: string, _id: string, part: number) =>
            `https://store.test/${key}?part=${part}`,
    }),
}));

const b64 = (bytes: Buffer) => bytes.toString('base64url');
const paddedMetadata = () => randomBytes(24 + 256 + 16);
type Minted = { id: string; seed: string | undefined };

let mine: Account;
let theirs: Account;
let myRoot: Awaited<ReturnType<typeof root>>;
let theirRoot: Awaited<ReturnType<typeof root>>;

beforeEach(async () => {
    await resetDatabase();
    mine = await member();
    theirs = await member();
    myRoot = await root(mine);
    theirRoot = await root(theirs);
});
afterAll(closeDatabase);

/* The refusal as the API would serialize it: status, then the body {message, code, data}. */
async function answer(promise: Promise<unknown>) {
    const error = await promise.then(
        () => null,
        (caught: unknown) => caught,
    );
    if (!(error instanceof server.DriveError))
        throw new Error(`expected a DriveError, got ${String(error)}`);
    return JSON.stringify([
        error.status,
        { message: error.message, code: error.code, data: error.data },
    ]);
}
const NOT_MADE_HERE = JSON.stringify([
    400,
    { message: 'This id was not made for this workspace.', code: 'invalid', data: undefined },
]);

/* A node's envelopes, signed by `writer` over the node it will be in `workspaceId`. */
async function nodeEnvelopes(
    writer: Account,
    workspaceId: string,
    nodeId: string,
    kind: 'folder' | 'file',
    parent: { keyEpoch: number },
) {
    const metadata = paddedMetadata();
    return {
        keyEpoch: await epoch(workspaceId),
        parentKeyEpoch: parent.keyEpoch,
        keyEnvelope: b64(randomBytes(72)),
        metadataEnvelope: b64(metadata),
        metadataSignature: b64(
            signerFor(writer.userId).sign(
                metadataStatement({
                    workspaceId,
                    nodeId,
                    kind,
                    metadataVersion: 1,
                    metadataEnvelope: metadata,
                }),
            ),
        ),
    };
}

async function createFolder(writer: Account, node: Minted, parent = myRoot) {
    return server.createFolders(writer.userId, writer.workspaceId, [
        {
            id: node.id,
            idSeed: node.seed,
            parentId: parent.id,
            ...(await nodeEnvelopes(writer, writer.workspaceId, node.id, 'folder', parent)),
        },
    ]);
}

async function begin(
    writer: Account,
    ids: { node: Minted; version: Minted; object: Minted },
    parent = writer === theirs ? theirRoot : myRoot,
) {
    const content = randomBytes(84);
    return server.beginUpload(writer.userId, writer.workspaceId, {
        node: {
            existing: false,
            id: ids.node.id,
            idSeed: ids.node.seed,
            parentId: parent.id,
            ...(await nodeEnvelopes(writer, writer.workspaceId, ids.node.id, 'file', parent)),
        },
        versionId: ids.version.id,
        versionIdSeed: ids.version.seed,
        objectId: ids.object.id,
        objectIdSeed: ids.object.seed,
        contentKeyEnvelope: b64(content),
        versionSignature: b64(
            signerFor(writer.userId).sign(
                versionStatement({
                    workspaceId: writer.workspaceId,
                    nodeId: ids.node.id,
                    versionId: ids.version.id,
                    objectId: ids.object.id,
                    contentSuite: 3,
                    contentKeyEnvelope: content,
                }),
            ),
        ),
        contentNonce: b64(randomBytes(16)),
        contentSuite: 3,
        chunkCount: 1,
        ciphertextSize: '4096',
    });
}

async function copy(
    writer: Account,
    source: Awaited<ReturnType<typeof file>>,
    ids: { node: Minted; version: Minted },
    parent = writer === theirs ? theirRoot : myRoot,
) {
    const content = randomBytes(84);
    return server.copyNode(writer.userId, writer.workspaceId, source.id, {
        sourceVersionId: source.currentVersion!.id,
        node: {
            id: ids.node.id,
            idSeed: ids.node.seed,
            parentId: parent.id,
            ...(await nodeEnvelopes(writer, writer.workspaceId, ids.node.id, 'file', parent)),
        },
        versionId: ids.version.id,
        versionIdSeed: ids.version.seed,
        contentKeyEnvelope: b64(content),
        versionSignature: b64(
            signerFor(writer.userId).sign(
                versionStatement({
                    workspaceId: writer.workspaceId,
                    nodeId: ids.node.id,
                    versionId: ids.version.id,
                    objectId: source.currentVersion!.objectId,
                    contentSuite: 3,
                    contentKeyEnvelope: content,
                }),
            ),
        ),
    });
}

function createLink(writer: Account, node: { id: string; keyEpoch: number }, link: Minted) {
    return server.createLink(writer.userId, writer.workspaceId, node.id, {
        linkId: link.id,
        linkIdSeed: link.seed,
        token: b64(randomBytes(32)),
        keyEpoch: node.keyEpoch,
        linkEnvelope: b64(randomBytes(72)),
        linkSalt: b64(randomBytes(16)),
        secretEnvelope: b64(randomBytes(136)),
        hasPassword: false,
        expiresAt: null,
    });
}

/*
 * The ids that must all get the one refusal in my workspace: one that exists in
 * theirs, with the seed that made it there; a fresh one with a seed of its own;
 * my own kind of id with no seed; and an id derived here but for another kind.
 */
function strangers(existing: Minted, kind: Parameters<typeof minted>[0]) {
    const here = minted(kind, mine.workspaceId);
    const otherKind = minted(kind === 'node' ? 'version' : 'node', mine.workspaceId);
    return {
        'an id that exists in another workspace': existing,
        'a fresh random id': { id: randomUUID(), seed: b64(randomBytes(16)) },
        'no seed': { id: here.id, seed: undefined },
        'a seed of another kind': otherKind,
        'a seed that is not 16 bytes': { id: here.id, seed: b64(randomBytes(15)) },
    };
}

describe('an id not made for the workspace of the request', () => {
    test('folders: every cause gets the same answer, and nothing is created', async () => {
        const existing = minted('node', theirs.workspaceId);
        await createFolder(theirs, existing, theirRoot);
        for (const [cause, node] of Object.entries(strangers(existing, 'node'))) {
            expect(await answer(createFolder(mine, node)), cause).toBe(NOT_MADE_HERE);
        }
        const listed = await server.listChildren(mine.userId, mine.workspaceId, myRoot.id);
        expect(listed.children).toEqual([]);
    });

    test('root: the same answer before anything else is looked at', async () => {
        const fresh = await member();
        const existing = { id: theirRoot.id, seed: b64(randomBytes(16)) };
        const create = (node: Minted) =>
            nodeEnvelopes(fresh, fresh.workspaceId, node.id, 'folder', { keyEpoch: 1 }).then(
                (envelopes) =>
                    server.createRoot(fresh.userId, fresh.workspaceId, {
                        id: node.id,
                        idSeed: node.seed,
                        ...envelopes,
                    }),
            );
        expect(await answer(create(existing))).toBe(NOT_MADE_HERE);
        expect(await answer(create({ id: randomUUID(), seed: b64(randomBytes(16)) }))).toBe(
            NOT_MADE_HERE,
        );
        const made = minted('node', fresh.workspaceId);
        expect((await create(made)).created).toBe(true);
    });

    test('upload begin: the node, the version and the object are each derived', async () => {
        // Their file exists, begun with these seeds in their workspace.
        const theirIds = {
            node: minted('node', theirs.workspaceId),
            version: minted('version', theirs.workspaceId),
            object: minted('object', theirs.workspaceId),
        };
        expect((await begin(theirs, theirIds)).upload.status).toBe('open');
        const good = () => ({
            node: minted('node', mine.workspaceId),
            version: minted('version', mine.workspaceId),
            object: minted('object', mine.workspaceId),
        });
        for (const part of ['node', 'version', 'object'] as const)
            for (const [cause, id] of Object.entries(strangers(theirIds[part], part)))
                expect(
                    await answer(begin(mine, { ...good(), [part]: id })),
                    `${part}: ${cause}`,
                ).toBe(NOT_MADE_HERE);
        const accepted = await begin(mine, good());
        expect(accepted.upload.status).toBe('open');
    });

    test('copy: the new node and version are derived; derived ones copy', async () => {
        const source = await file(mine, myRoot);
        const theirSource = await file(theirs, theirRoot);
        // Their copy exists, made with these seeds in their workspace.
        const theirCopy = {
            node: minted('node', theirs.workspaceId),
            version: minted('version', theirs.workspaceId),
        };
        await copy(theirs, theirSource, theirCopy);
        const good = () => ({
            node: minted('node', mine.workspaceId),
            version: minted('version', mine.workspaceId),
        });
        for (const part of ['node', 'version'] as const)
            for (const [cause, id] of Object.entries(strangers(theirCopy[part], part)))
                expect(
                    await answer(copy(mine, source, { ...good(), [part]: id })),
                    `${part}: ${cause}`,
                ).toBe(NOT_MADE_HERE);
        const copied = await copy(mine, source, good());
        expect(copied.node.parentId).toBe(myRoot.id);
    });

    test('links: the same answer for their link id and a fresh one; a derived one is made', async () => {
        const theirFolder = await folder(theirs, theirRoot);
        const theirLink = minted('link', theirs.workspaceId);
        await createLink(theirs, theirFolder, theirLink);
        const myFolder = await folder(mine, myRoot);
        for (const [cause, link] of Object.entries(strangers(theirLink, 'link')))
            expect(await answer(createLink(mine, myFolder, link)), cause).toBe(NOT_MADE_HERE);
        const made = await createLink(mine, myFolder, minted('link', mine.workspaceId));
        expect(made.link.id).toEqual(expect.any(String));
    });

    test('attach: a sibling’s node is checked before the upload is even looked up', async () => {
        const attach = (node: Minted) =>
            nodeEnvelopes(mine, mine.workspaceId, node.id, 'file', myRoot).then((envelopes) =>
                server.attachUpload(mine.userId, mine.workspaceId, randomUUID(), {
                    mode: 'sibling',
                    node: { id: node.id, idSeed: node.seed, parentId: myRoot.id, ...envelopes },
                    contentKeyEnvelope: b64(randomBytes(84)),
                    versionSignature: b64(randomBytes(64)),
                }),
            );
        expect(await answer(attach({ id: theirRoot.id, seed: b64(randomBytes(16)) }))).toBe(
            NOT_MADE_HERE,
        );
        expect(await answer(attach({ id: randomUUID(), seed: undefined }))).toBe(NOT_MADE_HERE);
        // Derived here, it gets as far as the missing upload.
        expect(JSON.parse(await answer(attach(minted('node', mine.workspaceId))))[0]).toBe(404);
    });

    test('reports: derived in the reported item’s workspace, the same answer otherwise', async () => {
        const project = await folder(theirs, theirRoot);
        await share(theirs, project, mine, 'viewer');
        const report = (id: Minted, workspaceId = theirs.workspaceId, by = mine) =>
            server.fileReport(
                { userId: by.userId, address: `198.51.100.${Math.floor(Math.random() * 200)}` },
                {
                    id: id.id,
                    reportIdSeed: id.seed,
                    workspaceId,
                    nodeId: project.id,
                    keyEpoch: project.keyEpoch,
                    category: 'other',
                    reason: 'Not mine to judge.',
                    via: { share: true },
                    reporterEmail: null,
                    keys: [],
                },
            );
        // Made for the reporter's own workspace rather than the reported item's, fresh, or bare.
        const causes = {
            'an id made for the reporter’s workspace': minted('report', mine.workspaceId),
            'a fresh random id': { id: randomUUID(), seed: b64(randomBytes(16)) },
            'no seed': { id: minted('report', theirs.workspaceId).id, seed: undefined },
            'a seed of another kind': minted('node', theirs.workspaceId),
        };
        for (const [cause, id] of Object.entries(causes))
            expect(await answer(report(id)), cause).toBe(NOT_MADE_HERE);
        // Derived for the item's workspace, it passes the gate and meets the next check
        // (here: the owner reporting their own file).
        const derived = minted('report', theirs.workspaceId);
        expect(await answer(report(derived, theirs.workspaceId, theirs))).toBe(
            JSON.stringify([
                409,
                { message: 'You cannot report your own files.', code: 'invalid', data: undefined },
            ]),
        );
    });
});

describe('a replayed seed', () => {
    test('is the only 409: one’s own seed again in one’s own workspace', async () => {
        const node = minted('node', mine.workspaceId);
        await createFolder(mine, node);
        expect(await answer(createFolder(mine, node))).toBe(
            JSON.stringify([
                409,
                {
                    message: 'An item with this id already exists.',
                    code: 'conflict',
                    data: { id: node.id },
                },
            ]),
        );
    });
});
