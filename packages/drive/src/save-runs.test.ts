import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
    CHUNK_TAG_BYTES,
    CONTENT_SUITE,
    THUMBNAIL_MAX_BYTES,
    chunkCount,
    ciphertextSize,
    contentLength,
    paddedLength,
    validObjectSize,
} from '@hushos/crypto/drive';
import {
    integrityOf,
    signStatement,
    versionStatementAs,
    versionStatements,
    type Integrity,
} from '@hushos/crypto/signatures';
import type { NodeView } from './api';
import type { DriveNode } from './client';
import { createMemoryRunJournal, type RunRow } from './journal';
import {
    NO_ROOM,
    NO_ROOM_SHARED,
    RunStopped,
    SaveRefused,
    cleanUpInterrupted,
    interruptedRuns,
    resultEstimate,
    resultsWaiting,
    runEstimate,
    startRun,
    unknownResultSize,
    type SaveRunDeps,
} from './save-runs';
import type { EnqueueInput, TransferManagerOptions, UploadItem } from './transfers';
import { sourcesSignatureForms } from './trust';

/*
 * The save path decides, before anything is made, whether a run may write and
 * whether it fits, and afterwards what a cancel or a failure removes. A wrong
 * estimate lets a run start that the server refuses halfway (or refuses one
 * that fits); a wrong signature launders an Unverified file's mark into a
 * result; a wrong clean-up leaves half a result in someone's Drive, deletes
 * what an editor may only trash, or loses the row the next open cleans up
 * from.
 */

const THUMBNAILS = [0, 1, 1_000, 30_000, THUMBNAIL_MAX_BYTES];
const SIZES = [
    0,
    1,
    255,
    256,
    257,
    65_535,
    65_536,
    1 << 20,
    8 * 1024 * 1024 - 1,
    8 * 1024 * 1024,
    8 * 1024 * 1024 + 1,
    16 * 1024 * 1024 - 65_552,
    100_000_000,
    2 ** 32 + 1,
    10_000_000_000,
];

describe('a result’s room', () => {
    test('covers what begin reserves for it whatever its thumbnail, and by no more than a chunk tag', () => {
        for (const size of SIZES) {
            const reserved = THUMBNAILS.map((t) => ciphertextSize(CONTENT_SUITE, size, t));
            const estimate = resultEstimate(size);
            for (const [i, bytes] of reserved.entries())
                expect(
                    estimate,
                    `${size} bytes, thumbnail ${THUMBNAILS[i]}`,
                ).toBeGreaterThanOrEqual(bytes);
            expect(estimate - Math.max(...reserved), `${size} bytes`).toBeLessThanOrEqual(
                CHUNK_TAG_BYTES,
            );
        }
    });

    test('is a Padmé bucket and its tags: one bucket up to 256 bytes with the thumbnail allowance, the next bucket past it', () => {
        // 0 and 1000 bytes share the bucket over a full thumbnail trailer; a byte past it moves up.
        const edge = paddedLength(THUMBNAIL_MAX_BYTES + CHUNK_TAG_BYTES) - THUMBNAIL_MAX_BYTES;
        expect(resultEstimate(0)).toBe(resultEstimate(edge - CHUNK_TAG_BYTES));
        expect(resultEstimate(edge - CHUNK_TAG_BYTES + 1)).toBeGreaterThan(resultEstimate(0));
        expect(resultEstimate(0)).toBe(
            paddedLength(THUMBNAIL_MAX_BYTES + CHUNK_TAG_BYTES) + CHUNK_TAG_BYTES,
        );
    });

    test('of the largest file the server takes is exactly the bound the server checks every object against', () => {
        // packages/drive/src/server.ts parseCiphertextSize, at the default DRIVE_MAX_FILE_BYTES.
        const largest = 32 * 1024 * 1024 * 1024;
        const bound = paddedLength(largest + THUMBNAIL_MAX_BYTES + CHUNK_TAG_BYTES);
        const estimate = resultEstimate(largest);
        expect(estimate - CHUNK_TAG_BYTES * chunkCount(bound)).toBe(bound);
        for (const thumbnail of THUMBNAILS) {
            const object = ciphertextSize(CONTENT_SUITE, largest, thumbnail);
            const chunks = chunkCount(contentLength(CONTENT_SUITE, largest, thumbnail));
            expect(validObjectSize(object, chunks)).toBe(true);
            expect(object - CHUNK_TAG_BYTES * chunks).toBeLessThanOrEqual(bound);
            expect(object).toBeLessThanOrEqual(estimate);
        }
    });

    test('of an unknown result is its sources’ total and 1%, rounded up, then estimated as a result', () => {
        expect(unknownResultSize(100)).toBe(101);
        expect(unknownResultSize(101)).toBe(103);
        const sources = 1_000_000_007;
        expect(runEstimate([{ sourcesSize: sources }])).toBe(resultEstimate(1_010_000_008));
        // A result 1% larger than its sources, with a full thumbnail, still fits what was set aside.
        expect(unknownResultSize(sources)).toBeGreaterThanOrEqual(sources * 1.01);
        expect(runEstimate([{ sourcesSize: sources }])).toBeGreaterThanOrEqual(
            ciphertextSize(CONTENT_SUITE, Math.ceil(sources * 1.01), THUMBNAIL_MAX_BYTES),
        );
        expect(runEstimate([{ size: 0 }, { size: 0 }])).toBe(2 * resultEstimate(0));
    });

    test('is the number every client gives (the core reads the same cases)', () => {
        const cases = JSON.parse(
            readFileSync(
                new URL(
                    '../../../crates/hushos-core/fixtures/save-estimate-cases.json',
                    import.meta.url,
                ),
                'utf8',
            ),
        ) as {
            known: { size: number; estimate: number }[];
            unknown: { sourcesSize: number; size: number; estimate: number }[];
            run: { results: ({ size: number } | { sourcesSize: number })[]; estimate: number };
        };
        for (const { size, estimate } of cases.known) expect(resultEstimate(size)).toBe(estimate);
        for (const { sourcesSize, size, estimate } of cases.unknown) {
            expect(unknownResultSize(sourcesSize)).toBe(size);
            expect(runEstimate([{ sourcesSize }])).toBe(estimate);
        }
        expect(runEstimate(cases.run.results)).toBe(cases.run.estimate);
    });
});

/* An Ed25519 key in libsodium's form (seed, then public key), from Node's own. */
function writerKey() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const jwk = privateKey.export({ format: 'jwk' });
    const seed = Buffer.from(jwk.d!, 'base64url');
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
    return {
        secret: new Uint8Array(Buffer.concat([seed, raw])),
        public: new Uint8Array(raw),
    };
}

describe('a result’s signature, from its sources', () => {
    const version = (nodeId: string) => ({
        workspaceId: '11111111-1111-4111-8111-111111111111',
        nodeId,
        versionId: '33333333-3333-4333-8333-333333333333',
        objectId: '44444444-4444-4444-8444-444444444444',
        contentSuite: CONTENT_SUITE,
    });
    const NODE_A = '22222222-2222-4222-8222-22222222222a';
    const NODE_B = '22222222-2222-4222-8222-22222222222b';
    const RESULT = '22222222-2222-4222-8222-2222222222cc';
    const envelope = crypto.getRandomValues(new Uint8Array(84));

    /* A source's version as a reader checks it: signed for real in `form`, read under `trusted`. */
    async function source(
        nodeId: string,
        form: 'ordinary' | 'saved' | 'resealed',
        signer: ReturnType<typeof writerKey>,
        trusted: ReturnType<typeof writerKey> | null,
    ) {
        const signature = await signStatement(
            await versionStatementAs(form, version(nodeId), envelope),
            signer.secret,
        );
        const integrity = await integrityOf(
            () => versionStatements(version(nodeId), envelope),
            signature,
            trusted ? { current: trusted.public, retired: [] } : null,
        );
        return {
            node: {
                kind: 'file' as const,
                integrity: { metadata: integrity, version: integrity },
            },
            source: 'drive' as const,
            integrity,
        };
    }

    /* What the result reads as once it is signed as the save path says, by the person saving it. */
    async function resultReads(sources: Awaited<ReturnType<typeof source>>[]) {
        const me = writerKey();
        const forms = sourcesSignatureForms(sources);
        const signature = await signStatement(
            await versionStatementAs(forms.version, version(RESULT), envelope),
            me.secret,
        );
        return integrityOf(() => versionStatements(version(RESULT), envelope), signature, {
            current: me.public,
            retired: [],
        }) as Promise<Integrity>;
    }

    test('one Unverified source makes the result Unverified, however many verified sources beside it', async () => {
        const maya = writerKey();
        const stranger = writerKey();
        const verified = await source(NODE_A, 'ordinary', maya, maya);
        // Signed by someone this reader has never checked: an unknown signer.
        const unknown = await source(NODE_B, 'ordinary', stranger, null);
        expect(verified.integrity).toBe('verified');
        expect(unknown.integrity).toBe('unknown-signer');
        expect(await resultReads([verified, unknown, verified])).toBe('resealed');
        expect(await resultReads([verified, verified])).toBe('verified');
    });

    test('a source that reads as forged or re-sealed is the weakest too, not only an unknown signer', async () => {
        const maya = writerKey();
        const forger = writerKey();
        const verified = await source(NODE_A, 'ordinary', maya, maya);
        // Claims Maya, signed by someone else: bad-signature.
        const forged = await source(NODE_B, 'ordinary', forger, maya);
        const resealed = await source(NODE_B, 'resealed', maya, maya);
        expect(forged.integrity).toBe('bad-signature');
        expect(resealed.integrity).toBe('resealed');
        expect(await resultReads([verified, forged])).toBe('resealed');
        expect(await resultReads([resealed, verified])).toBe('resealed');
    });

    test('a source saved from a link makes a verified one’s result saved from a link, never verified', async () => {
        const maya = writerKey();
        const verified = await source(NODE_A, 'ordinary', maya, maya);
        const saved = await source(NODE_B, 'saved', maya, maya);
        expect(saved.integrity).toBe('saved-from-link');
        expect(await resultReads([verified, saved])).toBe('saved-from-link');
    });

    test('each record takes its own weakest: a verified name never covers unverified content', () => {
        const forms = sourcesSignatureForms([
            {
                node: { kind: 'file', integrity: { metadata: 'verified', version: 'unsigned' } },
                source: 'drive',
            },
            {
                node: { kind: 'file', integrity: { metadata: 'verified', version: 'verified' } },
                source: 'drive',
            },
        ]);
        expect(forms).toEqual({ metadata: 'ordinary', version: 'resealed' });
        // From a link, every source is saved whatever it showed.
        expect(
            sourcesSignatureForms([
                {
                    node: {
                        kind: 'file',
                        integrity: { metadata: 'verified', version: 'verified' },
                    },
                    source: 'link',
                },
            ]),
        ).toEqual({ metadata: 'saved', version: 'saved' });
        expect(() => sourcesSignatureForms([])).toThrow();
    });
});

/* ---------------------------------------------------------------------------------------------- */

type TransferEvent = Parameters<NonNullable<TransferManagerOptions['onEvent']>>[0];

function folder(id: string, workspaceId = 'ws-own', keyEpoch = 1): DriveNode {
    return {
        id,
        workspaceId,
        parentId: 'root',
        kind: 'folder',
        keyEpoch,
        name: id,
        currentVersion: null,
        metadata: { name: id, mime: null, size: null, modified: null },
    } as unknown as DriveNode;
}

function nextName(name: string, taken: Set<string>) {
    const lower = new Set([...taken].map((entry) => entry.toLowerCase()));
    if (!lower.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf('.');
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 2; ; n++) {
        const candidate = `${base} (${n})${ext}`;
        if (!lower.has(candidate.toLowerCase())) return candidate;
    }
}

/*
 * The world around a run: an upload queue that holds what it is given until
 * the test lands or fails it (and that cancels as the real one does, telling
 * every listener at once), a journal, a server's trash and purge, and the
 * free space a workspace has. The run's own decisions are what is checked.
 */
function world(
    options: {
        free?: number | null;
        mayPurge?: boolean;
        names?: string[];
        refuse?: (target: DriveNode) => string | null;
        waits?: (target: DriveNode) => boolean;
        trashFails?: boolean;
    } = {},
) {
    const listeners = new Set<(event: TransferEvent) => void>();
    const runs = createMemoryRunJournal();
    const queued = new Map<string, { input: EnqueueInput; item: UploadItem }>();
    const cancelled: string[] = [];
    const aborted: string[] = [];
    const trashed: string[][] = [];
    const purged: string[][] = [];
    const madeFolders: { parent: string; name: string; signAs: string }[] = [];
    let next = 0;
    const emit = (event: TransferEvent) => {
        for (const listener of listeners) listener(event);
    };
    const deps: SaveRunDeps = {
        transfers: {
            enqueue: (inputs) =>
                inputs.map((input) => {
                    const id = `item-${++next}`;
                    const item = {
                        id,
                        name: input.name ?? input.file.name,
                        status: 'queued',
                        error: null,
                        errorCode: null,
                        node: null,
                    } as unknown as UploadItem;
                    queued.set(id, { input, item });
                    return id;
                }),
            cancel: async (id) => {
                const held = queued.get(id);
                if (!held || held.item.status === 'done' || held.item.status === 'cancelled')
                    return;
                cancelled.push(id);
                held.item.status = 'cancelled';
                emit({ type: 'cancelled', item: held.item });
            },
        },
        events: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        runs,
        refuseWrite: options.refuse ?? (() => null),
        waitsForKeyChange: options.waits ?? (() => false),
        freeSpace: async () => (options.free === undefined ? 1e12 : options.free),
        namesIn: async () => options.names ?? [],
        nextName,
        makeFolder: async (parent, name, signAs) => {
            madeFolders.push({ parent: parent.id, name, signAs });
            return folder(`made-${madeFolders.length}`, parent.workspaceId);
        },
        abortUpload: async (_ws, uploadId) => {
            aborted.push(uploadId);
        },
        trash: async (_ws, ids) => {
            if (options.trashFails) throw new Error('offline');
            trashed.push(ids);
        },
        purge: async (_ws, ids) => {
            purged.push(ids);
        },
        mayPurge: () => options.mayPurge ?? true,
    };
    /* The queue began an upload: what its run's row learns. */
    function begin(id: string, uploadId: string, nodeId: string) {
        queued.get(id)!.input.produced!.onBegun!({ workspaceId: 'ws-own', uploadId, nodeId });
    }
    function land(id: string, nodeId: string) {
        const held = queued.get(id)!;
        held.item.status = 'done';
        held.item.node = { id: nodeId } as NodeView;
        emit({ type: 'done', item: held.item });
    }
    function failWith(
        id: string,
        errorCode: UploadItem['errorCode'],
        extra: Partial<UploadItem> = {},
    ) {
        const held = queued.get(id)!;
        Object.assign(held.item, { status: 'failed', errorCode, error: 'refused', ...extra });
        emit({ type: 'failed', item: held.item });
    }
    return {
        deps,
        runs,
        queued,
        cancelled,
        aborted,
        trashed,
        purged,
        madeFolders,
        begin,
        land,
        failWith,
        ids: () => [...queued.keys()],
    };
}

const signAs = { metadata: 'ordinary', version: 'ordinary' } as const;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a save run', () => {
    test('refuses a read-only family folder before anything is made; one waiting for a key change takes the run', async () => {
        const w = world({ refuse: () => 'This family folder is read-only on this device.' });
        await expect(
            startRun(w.deps, {
                targets: [folder('fam', 'ws-fam')],
                results: [{ size: 10 }],
                signAs,
            }),
        ).rejects.toMatchObject({ reason: 'read-only' });
        expect(w.runs.rows.size).toBe(0);
        expect(w.queued.size).toBe(0);

        const waiting = world({ refuse: () => 'Finishing a key change.', waits: () => true });
        const run = await startRun(waiting.deps, {
            targets: [folder('fam', 'ws-fam')],
            results: [{ size: 10 }],
            signAs,
        });
        void run
            .file({ name: 'a.txt', bytes: new Uint8Array(10), mime: 'text/plain' })
            .catch(() => {});
        await tick();
        expect(waiting.queued.size).toBe(1);
        await run.cancel();
    });

    test('refuses a run that does not fit the free space, by its estimate, and takes one that fits exactly', async () => {
        const results = [{ size: 5_000_000 }, { sourcesSize: 2_000_000 }];
        const needed = runEstimate(results);
        const short = world({ free: needed - 1 });
        const refused = await startRun(short.deps, {
            targets: [folder('f')],
            results,
            signAs,
        }).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(SaveRefused);
        expect(refused).toMatchObject({ reason: 'no-room', room: { needed, free: needed - 1 } });
        expect((refused as Error).message).toBe(NO_ROOM);
        expect(short.runs.rows.size).toBe(0);

        const exact = world({ free: needed });
        const run = await startRun(exact.deps, { targets: [folder('f')], results, signAs });
        expect(exact.runs.rows.size).toBe(1);
        await run.cancel();
    });

    test('in someone else’s share, where the free space is not known, starts; a 402 then ends it “no room”, owner’s figures unsaid, and trashes what it made', async () => {
        const w = world({ free: null, mayPurge: false });
        const run = await startRun(w.deps, {
            targets: [folder('shared', 'ws-owner')],
            results: [{ size: 1e15 }],
            signAs,
        });
        const first = run.file({ name: 'a.txt', bytes: new Uint8Array(4), mime: null });
        const second = run.file({ name: 'b.txt', bytes: new Uint8Array(4), mime: null });
        await tick();
        const [a, b] = w.ids();
        w.begin(a!, 'up-a', 'node-a');
        w.land(a!, 'node-a');
        w.begin(b!, 'up-b', 'node-b');
        w.failWith(b!, 'over-quota');
        await expect(first).resolves.toEqual({ id: 'node-a' });
        const stopped = await second.catch((error: unknown) => error);
        expect(stopped).toBeInstanceOf(RunStopped);
        expect(stopped).toMatchObject({ reason: 'no-room', cleanup: 'trashed' });
        expect((stopped as Error).message).toBe(NO_ROOM_SHARED);
        expect(JSON.stringify(stopped)).not.toMatch(/free|needed/);
        // An editor may only trash: both files to the owner's Trash, nothing deleted forever.
        expect(w.trashed).toEqual([['node-a', 'node-b']]);
        expect(w.purged).toEqual([]);
        expect(w.runs.rows.size).toBe(0);
    });

    test('names each new file the next free name in its folder, case and all, and never replaces', async () => {
        const w = world({ names: ['report.pdf', 'Report (2).pdf'] });
        const run = await startRun(w.deps, { targets: [folder('f')], results: [], signAs });
        for (const name of ['report.pdf', 'REPORT.pdf', 'notes.txt'])
            void run.file({ name, bytes: new Uint8Array(1), mime: null }).catch(() => {});
        await tick();
        const inputs = [...w.queued.values()].map(({ input }) => input);
        expect(inputs.map((input) => input.name)).toEqual([
            'report (3).pdf',
            'REPORT (4).pdf',
            'notes.txt',
        ]);
        expect(inputs.every((input) => input.replaces === undefined)).toBe(true);
        expect(inputs.every((input) => input.produced && input.signAs === signAs)).toBe(true);
        await run.cancel();
    });

    test('a new version someone else beat is `stale` with their version: the run goes on, nothing to clean', async () => {
        const w = world();
        const doc = { ...folder('doc'), kind: 'file', parentId: 'f' } as DriveNode;
        const run = await startRun(w.deps, { targets: [doc], results: [{ size: 3 }], signAs });
        const saved = run.version({
            file: doc,
            folder: folder('f'),
            startedFrom: 'v1',
            bytes: new Uint8Array(3),
        });
        await tick();
        const [id] = w.ids();
        expect(w.queued.get(id!)!.input.produced!.startedFrom).toBe('v1');
        expect(w.queued.get(id!)!.input.replaces).toBe(doc);
        w.begin(id!, 'up-1', 'doc');
        w.failWith(id!, 'stale', { stale: { currentVersionId: 'v-theirs' } });
        await expect(saved).resolves.toEqual({ status: 'stale', currentVersionId: 'v-theirs' });
        // A version's file is never the run's to delete: the row never named it.
        expect(w.runs.rows.get(run.id)!.nodeIds).toEqual([]);
        expect(w.runs.rows.get(run.id)!.uploadIds).toEqual([]);
        await run.finish();
        expect(w.trashed).toEqual([]);
        expect(w.runs.rows.size).toBe(0);
    });

    test('a cancel stops open uploads and deletes forever what was published; the row goes last', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [], signAs });
        void run.file({ name: 'a', bytes: new Uint8Array(1), mime: null }).catch(() => {});
        const open = run.file({ name: 'b', bytes: new Uint8Array(1), mime: null });
        await tick();
        const [a, b] = w.ids();
        w.begin(a!, 'up-a', 'node-a');
        w.land(a!, 'node-a');
        w.begin(b!, 'up-b', 'node-b');
        await tick();
        // The row as a closed tab would leave it: the published file and the open upload's ids.
        expect(w.runs.rows.get(run.id)).toMatchObject({
            nodeIds: ['node-a', 'node-b'],
            uploadIds: ['up-b'],
        });
        expect(resultsWaiting()).toBe(true);
        expect(await run.cancel()).toBe('deleted');
        expect(w.cancelled).toEqual([b]);
        expect(w.trashed).toEqual([['node-a', 'node-b']]);
        expect(w.purged).toEqual([['node-a', 'node-b']]);
        expect(w.runs.rows.size).toBe(0);
        await expect(open).rejects.toMatchObject({ reason: 'cancelled', cleanup: 'deleted' });
        expect(resultsWaiting()).toBe(false);
    });

    test('a cancel from the transfers panel stops the whole run: all or nothing', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [], signAs });
        const a = run.file({ name: 'a', bytes: new Uint8Array(1), mime: null });
        const b = run.file({ name: 'b', bytes: new Uint8Array(1), mime: null });
        await tick();
        const [idA, idB] = w.ids();
        w.begin(idA!, 'up-a', 'node-a');
        await w.deps.transfers.cancel(idA!);
        await expect(a).rejects.toBeInstanceOf(RunStopped);
        await expect(b).rejects.toBeInstanceOf(RunStopped);
        // The other result was cancelled too, and only once each.
        expect(w.cancelled).toEqual([idA, idB]);
        expect(w.trashed).toEqual([['node-a']]);
    });

    test('a folder the run made goes as one: what is inside it is not listed, nor removed one by one', async () => {
        const w = world();
        const run = await startRun(w.deps, {
            targets: [folder('f')],
            results: [],
            signAs: { metadata: 'resealed', version: 'resealed' },
        });
        const made = await run.folder('Archive');
        expect(w.madeFolders).toEqual([{ parent: 'f', name: 'Archive', signAs: 'resealed' }]);
        void run
            .file({ name: 'inside.txt', bytes: new Uint8Array(1), mime: null, into: made })
            .catch(() => {});
        await tick();
        const [inside] = w.ids();
        w.begin(inside!, 'up-1', 'node-inside');
        w.land(inside!, 'node-inside');
        await tick();
        expect(w.runs.rows.get(run.id)!.nodeIds).toEqual([made.id]);
        await run.cancel();
        expect(w.trashed).toEqual([[made.id]]);
    });

    test('a new file a key change landed under another node is cleaned up by the node that landed', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [], signAs });
        void run.file({ name: 'a', bytes: new Uint8Array(1), mime: null }).catch(() => {});
        await tick();
        const [a] = w.ids();
        w.begin(a!, 'up-a', 'node-begun');
        w.land(a!, 'node-attached');
        await run.cancel();
        expect(w.trashed).toEqual([['node-attached']]);
    });

    test('a clean-up that cannot reach the server keeps the row for the next open', async () => {
        const w = world({ trashFails: true });
        const run = await startRun(w.deps, { targets: [folder('f')], results: [], signAs });
        void run.file({ name: 'a', bytes: new Uint8Array(1), mime: null }).catch(() => {});
        await tick();
        const [a] = w.ids();
        w.begin(a!, 'up-a', 'node-a');
        w.land(a!, 'node-a');
        expect(await run.cancel()).toBe('left');
        expect(w.runs.rows.get(run.id)!.nodeIds).toEqual(['node-a']);
    });

    test('the next open lists a closed tab’s run, not a live one, and cleans it up from its ids alone', async () => {
        const w = world();
        const left: RunRow = {
            id: 'run-closed',
            workspaceId: 'ws-own',
            nodeIds: ['node-a'],
            uploadIds: ['up-b'],
            at: 1,
        };
        await w.runs.put(left);
        const live = await startRun(w.deps, { targets: [folder('f')], results: [], signAs });
        // Another tab's run, held there: not this tab's to clean up.
        await w.runs.put({ ...left, id: 'run-other-tab' });
        const found = await interruptedRuns({
            runs: w.runs,
            isLive: async (id) => id === 'run-other-tab',
        });
        expect(found.map((row) => row.id)).toEqual(['run-closed']);
        expect(await cleanUpInterrupted(w.deps, found[0]!)).toBe('deleted');
        expect(w.aborted).toEqual(['up-b']);
        expect(w.trashed).toEqual([['node-a']]);
        expect(w.purged).toEqual([['node-a']]);
        expect([...w.runs.rows.keys()].sort()).toEqual([live.id, 'run-other-tab'].sort());
        await live.cancel();
    });

    test('finish is refused while a result is on its way, and drops the row once all are in', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [], signAs });
        const saved = run.file({
            name: 'a',
            bytes: [new Uint8Array(2), new Uint8Array(3)],
            mime: null,
        });
        await tick();
        const [a] = w.ids();
        expect(w.queued.get(a!)!.input.file).toMatchObject({ kind: 'memory', size: 5 });
        await expect(run.finish()).rejects.toThrow();
        w.begin(a!, 'up-a', 'node-a');
        w.land(a!, 'node-a');
        await saved;
        await run.finish();
        expect(w.runs.rows.size).toBe(0);
        // Finished: a cancel afterwards removes nothing it kept.
        expect(await run.cancel()).toBe('nothing');
        expect(w.trashed).toEqual([]);
    });
});
