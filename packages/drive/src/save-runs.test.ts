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
import { countedPool, wholeGibUp } from '../../db/src/pool-count';
import { DriveApiError, type NodeView } from './api';
import type { DriveNode } from './client';
import { createMemoryRunJournal, type RunRow } from './journal';
import {
    ALREADY_SAVED,
    NO_ROOM,
    NO_ROOM_SHARED,
    RecordNotUpdated,
    OWN_WRITING,
    RUN_CANCELLED,
    RunStopped,
    SaveRefused,
    abandonRuns,
    CREATION_SETTLE_MS,
    askAbort,
    cleanUpInterrupted,
    interruptedRuns,
    keepInterrupted,
    lockRuns,
    resultEstimate,
    resultsWaiting,
    roomOf,
    runEstimate,
    startRun,
    unknownResultSize,
    type ItemFate,
    type Room,
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

    test('of a result that carries no thumbnail is exactly what begin reserves for it, no allowance set aside', () => {
        for (const size of SIZES) {
            expect(resultEstimate(size, false), `${size} bytes`).toBe(
                ciphertextSize(CONTENT_SUITE, size, 0),
            );
            // The allowance it no longer takes: a run of small text files is not refused for thumbnails.
            if (size < 1_000)
                expect(resultEstimate(size)).toBeGreaterThan(resultEstimate(size, false));
        }
        expect(runEstimate([{ size: 10, thumbnail: false }])).toBe(resultEstimate(10, false));
        expect(runEstimate([{ sourcesSize: 500, thumbnail: false }])).toBe(
            resultEstimate(unknownResultSize(500), false),
        );
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
            known: { size: number; thumbnail: boolean; estimate: number }[];
            unknown: { sourcesSize: number; size: number; estimate: number }[];
            run: {
                results: (({ size: number } | { sourcesSize: number }) & { thumbnail: boolean })[];
                estimate: number;
            };
        };
        expect(cases.known.some((entry) => !entry.thumbnail)).toBe(true);
        for (const { size, thumbnail, estimate } of cases.known)
            expect(resultEstimate(size, thumbnail)).toBe(estimate);
        for (const { sourcesSize, size, estimate } of cases.unknown) {
            expect(unknownResultSize(sourcesSize)).toBe(size);
            expect(runEstimate([{ sourcesSize }])).toBe(estimate);
        }
        expect(runEstimate(cases.run.results)).toBe(cases.run.estimate);
    });
});

describe('the room a run checks against', () => {
    const GIB = 1n << 30n;
    /*
     * The server's own arithmetic (packages/db/src/pool.ts poolFigures): each part rounded up
     * to a whole GiB on its own, the writer's own part counted to the byte when it is their own
     * files, in whole GiB when it is the family folders. `shown` is what the person reads.
     */
    function pool(parts: { me: bigint; folders: bigint; others: bigint[] }, allowance: bigint) {
        const all = [parts.me, parts.folders, ...parts.others];
        const countedAll = countedPool(all);
        return {
            shown: allowance - countedAll,
            serverOwn: allowance - (countedAll - wholeGibUp(parts.me)) - parts.me,
            serverFolders: allowance - countedAll,
        };
    }

    test('in a family’s pool, the person’s own files take what the server says they may, never the rounded figure', () => {
        for (const me of [0n, 1n, GIB - 1n, GIB, GIB + 1n, 7n * GIB + 12_345n]) {
            const figures = pool(
                { me, folders: 3n * GIB + 5n, others: [2n * GIB + 9n] },
                50n * GIB,
            );
            const storage = {
                workspaceId: 'mine',
                availableBytes: figures.shown.toString(),
                pool: { groupId: 'fam' },
                own: { freeBytes: figures.serverOwn.toString() },
            };
            expect(roomOf(storage, 'mine', null)).toEqual({
                kind: 'own',
                free: Number(figures.serverOwn),
            });
            // A family folder: whole GiB on both sides, the shown figure exactly.
            expect(roomOf(storage, 'folder', 'fam')).toEqual({
                kind: 'family',
                free: Number(figures.serverFolders),
            });
            // An older server without the figure: the shown one, never more than the server's.
            const older = roomOf({ ...storage, own: {} }, 'mine', null) as { free: number };
            expect(older.free).toBeLessThanOrEqual(Number(figures.serverOwn));
        }
    });

    test('someone else’s share is never known; a family whose pool these figures are not is unknown, not shared', () => {
        const storage = { workspaceId: 'mine', availableBytes: '100', pool: null };
        expect(roomOf(storage, 'mine', null)).toEqual({ kind: 'own', free: 100 });
        expect(roomOf(storage, 'theirs', null)).toEqual({ kind: 'shared' });
        expect(roomOf(storage, 'folder', 'fam')).toEqual({ kind: 'family', free: null });
        expect(roomOf(null, 'folder', 'fam')).toEqual({ kind: 'family', free: null });
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
    test('a folder counts with what was read from inside it, and one that does not say is refused', () => {
        const verifiedFolder = {
            node: {
                kind: 'folder' as const,
                integrity: { metadata: 'verified' as const, version: null },
            },
            source: 'drive' as const,
        };
        const plantedFile = {
            node: {
                kind: 'file' as const,
                integrity: { metadata: 'verified' as const, version: 'unknown-signer' as const },
            },
            source: 'drive' as const,
        };
        expect(() => sourcesSignatureForms([verifiedFolder])).toThrow(
            /what the result was made from/,
        );
        expect(sourcesSignatureForms([{ ...verifiedFolder, within: [] }])).toEqual({
            metadata: 'ordinary',
            version: 'ordinary',
        });
        // A zip of a verified folder holding one planted file is not vouched for.
        expect(sourcesSignatureForms([{ ...verifiedFolder, within: [plantedFile] }]).version).toBe(
            'resealed',
        );
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
 * The server as a run's clean-up meets it: which nodes exist and where (live,
 * in the Trash, deleted forever), which uploads are open or finished, and a
 * free space. Its trash and purge answer per item as the batch routes do, and
 * the test can make an item refused, the workspace no longer the person's, a
 * purge left busy, or the network gone. The upload queue holds what it is given
 * until the test lands or fails it, and cancels as the real one does (telling
 * every listener at once).
 */
function world(
    options: {
        room?: Room;
        member?: boolean;
        names?: string[];
        refuse?: (target: DriveNode) => string | null;
        waits?: (target: DriveNode) => boolean;
    } = {},
) {
    const listeners = new Set<(event: TransferEvent) => void>();
    const runs = createMemoryRunJournal();
    const queued = new Map<string, { input: EnqueueInput; item: UploadItem }>();
    const cancelled: string[] = [];
    const server = {
        live: new Set<string>(),
        trash: new Set<string>(),
        purged: new Set<string>(),
        open: new Set<string>(),
        finished: new Set<string>(),
        aborted: [] as string[],
        refuse: new Set<string>(),
        busy: new Set<string>(),
        offline: false,
        denied: false,
    };
    let session = true;
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
                        origin: input.origin,
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
        room: async () => options.room ?? { kind: 'own', free: 1e12 },
        namesIn: async () => options.names ?? [],
        nextName,
        makeFolder: async (parent, name, signAs, minted) => {
            const made = folder(`made-${madeFolders.length + 1}`, parent.workspaceId);
            // Its id heard before the creation is sent, as createFolderPath's onMinted does.
            await minted(made.id);
            madeFolders.push({ parent: parent.id, name, signAs });
            server.live.add(made.id);
            return made;
        },
        abortUpload: async (_ws, uploadId) => {
            if (server.offline) return 'unknown';
            if (server.denied) return 'denied';
            server.aborted.push(uploadId);
            if (server.finished.has(uploadId)) return 'finished';
            return server.open.delete(uploadId) ? 'aborted' : 'gone';
        },
        trash: async (_ws, ids) => {
            if (server.offline) throw new Error('offline');
            const fates = new Map<string, ItemFate>();
            for (const id of ids) {
                if (server.denied) fates.set(id, 'denied');
                else if (server.refuse.has(id)) fates.set(id, 'refused');
                else if (server.live.delete(id)) {
                    server.trash.add(id);
                    fates.set(id, 'done');
                } else fates.set(id, server.trash.has(id) ? 'done' : 'gone');
            }
            return fates;
        },
        purge: async (_ws, ids) => {
            if (server.offline) throw new Error('offline');
            const fates = new Map<string, ItemFate>();
            for (const id of ids) {
                if (server.busy.has(id)) fates.set(id, 'refused');
                else if (server.trash.delete(id)) {
                    server.purged.add(id);
                    fates.set(id, 'done');
                } else fates.set(id, 'gone');
            }
            return fates;
        },
        mayPurge: async () => options.member ?? true,
        findChild: async (_parent, id) => (server.live.has(id) ? folder(id) : null),
        current: () => session,
    };
    /* The queue began an upload: the server holds it open, and the run's row learns of it. */
    function begin(id: string, uploadId: string, nodeId: string) {
        server.open.add(uploadId);
        queued.get(id)!.input.produced!.onBegun!({ workspaceId: 'ws-own', uploadId, nodeId });
    }
    function land(id: string, nodeId: string, uploadId?: string) {
        const held = queued.get(id)!;
        if (uploadId) {
            server.open.delete(uploadId);
            server.finished.add(uploadId);
        }
        if (!held.input.replaces) server.live.add(nodeId);
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
    function lock(id: string) {
        const held = queued.get(id)!;
        held.item.status = 'paused';
        emit({ type: 'locked', item: held.item });
    }
    return {
        deps,
        runs,
        queued,
        cancelled,
        server,
        madeFolders,
        begin,
        land,
        failWith,
        lock,
        signOut: () => {
            session = false;
        },
        ids: () => [...queued.keys()],
    };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const own = { sources: OWN_WRITING } as const;
const bytes = (n = 1) => new Uint8Array(n);

describe('an abort’s answer', () => {
    const refusal = (status: number, data?: unknown) =>
        new DriveApiError('refused', status === 409 ? 'conflict' : 'not-found', status, data);

    test('a finishing upload is asked about again, and is no answer (never finished) if it still is after the tries', async () => {
        const pauses: number[] = [];
        const answers = [
            refusal(409, { upload: 'completing' }),
            refusal(409, { upload: 'completing' }),
        ];
        const fate = await askAbort(
            async () => {
                const next = answers.shift();
                if (next) throw next;
            },
            { pause: async (ms) => void pauses.push(ms) },
        );
        expect(fate).toBe('aborted');
        expect(pauses).toEqual([2_000, 2_000]);
        expect(
            await askAbort(() => Promise.reject(refusal(409, { upload: 'completing' })), {
                tries: 3,
                pause: async () => {},
            }),
        ).toBe('unknown');
    });

    test('finished, gone, denied and no answer each say what they are; an unnamed 409 is no answer', async () => {
        const ask = (error: unknown) =>
            askAbort(() => Promise.reject(error), { pause: async () => {} });
        expect(await ask(refusal(409, { upload: 'completed' }))).toBe('finished');
        expect(await ask(refusal(404))).toBe('gone');
        expect(await ask(refusal(403))).toBe('denied');
        expect(await ask(refusal(409))).toBe('unknown');
        expect(await ask(new TypeError('Failed to fetch'))).toBe('unknown');
    });
});

describe('a save run', () => {
    test('refuses a read-only family folder before anything is made; one waiting for a key change takes the run', async () => {
        const w = world({ refuse: () => 'This family folder is read-only on this device.' });
        await expect(
            startRun(w.deps, { targets: [folder('fam', 'ws-fam')], results: [{ size: 10 }] }),
        ).rejects.toMatchObject({ reason: 'read-only' });
        expect(w.runs.rows.size).toBe(0);
        expect(w.queued.size).toBe(0);

        const waiting = world({ refuse: () => 'Finishing a key change.', waits: () => true });
        const run = await startRun(waiting.deps, {
            targets: [folder('fam', 'ws-fam')],
            results: [{ size: 10 }],
        });
        void run
            .file({ name: 'a.txt', bytes: bytes(10), mime: 'text/plain', ...own })
            .catch(() => {});
        await tick();
        expect(waiting.queued.size).toBe(1);
        await run.cancel();
    });

    test('refuses a run that does not fit the free space, by its estimate, and takes one that fits exactly', async () => {
        const results = [{ size: 5_000_000 }, { sourcesSize: 2_000_000, thumbnail: false }];
        const needed = runEstimate(results);
        const short = world({ room: { kind: 'own', free: needed - 1 } });
        const refused = await startRun(short.deps, { targets: [folder('f')], results }).catch(
            (error: unknown) => error,
        );
        expect(refused).toBeInstanceOf(SaveRefused);
        expect(refused).toMatchObject({ reason: 'no-room', room: { needed, free: needed - 1 } });
        expect((refused as Error).message).toBe(NO_ROOM);
        expect(short.runs.rows.size).toBe(0);

        const exact = world({ room: { kind: 'family', free: needed } });
        const run = await startRun(exact.deps, { targets: [folder('f')], results });
        expect(exact.runs.rows.size).toBe(1);
        await run.cancel();
    });

    test('a result planned without a thumbnail may not carry one: its room was never set aside', async () => {
        const w = world();
        const run = await startRun(w.deps, {
            targets: [folder('f')],
            results: [{ size: 10, thumbnail: false }, { size: 10 }],
        });
        void run
            .file({ name: 'a.png', bytes: bytes(), mime: 'image/png', thumbnail: bytes(5), ...own })
            .catch(() => {});
        await expect(
            run.file({
                name: 'b.png',
                bytes: bytes(),
                mime: 'image/png',
                thumbnail: bytes(5),
                ...own,
            }),
        ).rejects.toThrow(/without a thumbnail/);
        await run.cancel();
    });

    test('in someone else’s share a 402 ends the run “no room” without the server’s figure, and only trashes', async () => {
        const w = world({ room: { kind: 'shared' }, member: false });
        const run = await startRun(w.deps, {
            targets: [folder('shared', 'ws-owner')],
            results: [{ size: 1e15 }],
        });
        const first = run.file({ name: 'a.txt', bytes: bytes(4), mime: null, ...own });
        const second = run.file({ name: 'b.txt', bytes: bytes(4), mime: null, ...own });
        await tick();
        const [a, b] = w.ids();
        w.begin(a!, 'up-a', 'node-a');
        w.land(a!, 'node-a', 'up-a');
        w.begin(b!, 'up-b', 'node-b');
        w.failWith(b!, 'over-quota', { error: 'There isn’t enough room. 12 MB free.' });
        await expect(first).resolves.toEqual({ id: 'node-a' });
        const stopped = (await second.catch((error: unknown) => error)) as RunStopped;
        expect(stopped).toBeInstanceOf(RunStopped);
        expect(stopped).toMatchObject({ reason: 'no-room', cleanup: 'trashed' });
        expect(stopped.message).toBe(NO_ROOM_SHARED);
        expect(stopped.message).not.toContain('12 MB');
        expect(w.server.trash).toEqual(new Set(['node-a']));
        expect(w.server.purged.size).toBe(0);
        expect(w.server.aborted).toContain('up-b');
        expect(w.runs.rows.size).toBe(0);
    });

    test('unknown figures in the person’s own space never say “shared folder”', async () => {
        const w = world({ room: { kind: 'own', free: null } });
        const run = await startRun(w.deps, { targets: [folder('f')], results: [{ size: 1e15 }] });
        const saved = run.file({ name: 'a', bytes: bytes(), mime: null, ...own });
        await tick();
        w.failWith(w.ids()[0]!, 'over-quota');
        await expect(saved).rejects.toMatchObject({ message: NO_ROOM });
    });

    test('names each new file the next free name in its folder, case and all, and never replaces', async () => {
        const w = world({ names: ['report.pdf', 'Report (2).pdf'] });
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        for (const name of ['report.pdf', 'REPORT.pdf', 'notes.txt'])
            void run.file({ name, bytes: bytes(), mime: null, ...own }).catch(() => {});
        await tick();
        const inputs = [...w.queued.values()].map(({ input }) => input);
        expect(inputs.map((input) => input.name)).toEqual([
            'report (3).pdf',
            'REPORT (4).pdf',
            'notes.txt',
        ]);
        expect(inputs.every((input) => input.replaces === undefined)).toBe(true);
        expect(inputs.every((input) => input.produced && input.origin === 'result')).toBe(true);
        await run.cancel();
    });

    test('each result is signed by its own sources, the weakest of them; own writing is ordinary', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        const verified = {
            node: {
                kind: 'file' as const,
                integrity: { metadata: 'verified' as const, version: 'verified' as const },
            },
            source: 'drive' as const,
        };
        const planted = {
            node: {
                kind: 'file' as const,
                integrity: {
                    metadata: 'unknown-signer' as const,
                    version: 'unknown-signer' as const,
                },
            },
            source: 'drive' as const,
        };
        void run
            .file({ name: 'a', bytes: bytes(), mime: null, sources: [verified] })
            .catch(() => {});
        void run
            .file({ name: 'b', bytes: bytes(), mime: null, sources: [verified, planted] })
            .catch(() => {});
        void run.file({ name: 'c', bytes: bytes(), mime: null, ...own }).catch(() => {});
        await tick();
        expect([...w.queued.values()].map(({ input }) => input.signAs)).toEqual([
            { metadata: 'ordinary', version: 'ordinary' },
            { metadata: 'resealed', version: 'resealed' },
            { metadata: 'ordinary', version: 'ordinary' },
        ]);
        await expect(
            run.file({ name: 'd', bytes: bytes(), mime: null, sources: [] }),
        ).rejects.toThrow();
        await run.cancel();
    });

    test('two results cut from one buffer each upload their own bytes: neither takes the other’s buffer', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        const whole = new Uint8Array([1, 2, 3, 4, 5, 6]);
        void run
            .file({ name: 'a', bytes: whole.subarray(0, 3), mime: null, ...own })
            .catch(() => {});
        void run.file({ name: 'b', bytes: whole.subarray(3), mime: null, ...own }).catch(() => {});
        await tick();
        const parts = [...w.queued.values()].map(
            ({ input }) => (input.file as { parts: Uint8Array[] }).parts[0]!,
        );
        expect(parts.map((part) => [...part])).toEqual([
            [1, 2, 3],
            [4, 5, 6],
        ]);
        // Each part owns its whole buffer, and no two share one: moving one moves nothing else.
        expect(parts.every((part) => part.byteLength === part.buffer.byteLength)).toBe(true);
        expect(parts[0]!.buffer).not.toBe(parts[1]!.buffer);
        expect(parts[0]!.buffer).not.toBe(whole.buffer);
        await run.cancel();
    });

    test('a new version someone else beat is `stale` with their version: the run goes on, nothing to clean', async () => {
        const w = world();
        const doc = { ...folder('doc'), kind: 'file', parentId: 'f' } as DriveNode;
        const run = await startRun(w.deps, { targets: [doc], results: [{ size: 3 }] });
        const saved = run.version({
            file: doc,
            folder: folder('f'),
            startedFrom: 'v1',
            bytes: bytes(3),
            ...own,
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
        expect(w.server.trash.size).toBe(0);
        expect(w.runs.rows.size).toBe(0);
    });

    test('a stale version whose reservation the abort didn’t release keeps its id: finish asks again, then a row of its own the next open settles quietly', async () => {
        const w = world();
        const doc = { ...folder('doc'), kind: 'file', parentId: 'f' } as DriveNode;
        const run = await startRun(w.deps, { targets: [doc], results: [{ size: 3 }] });
        const saved = run.version({
            file: doc,
            folder: folder('f'),
            startedFrom: 'v1',
            bytes: bytes(3),
            ...own,
        });
        await tick();
        const [id] = w.ids();
        w.begin(id!, 'up-1', 'doc');
        w.failWith(id!, 'stale', { stale: { currentVersionId: 'v-theirs', released: false } });
        await expect(saved).resolves.toEqual({ status: 'stale', currentVersionId: 'v-theirs' });
        expect(w.runs.rows.get(run.id)!.uploadIds).toEqual(['up-1']);
        // Still no answer at finish: the saved results stay, and a row with no nodes keeps the id.
        w.server.offline = true;
        await run.finish();
        expect(w.runs.rows.get(run.id)).toMatchObject({ nodeIds: [], uploadIds: ['up-1'] });
        w.server.offline = false;
        abandonRuns();
        const offered = await interruptedRuns({
            runs: w.runs,
            isLive: async () => false,
            abortUpload: w.deps.abortUpload,
        });
        expect(offered).toEqual([]);
        expect(w.server.aborted).toContain('up-1');
        expect(w.runs.rows.size).toBe(0);
    });

    test('a version that landed before a cancel is kept and said so, never “nothing was saved”', async () => {
        const w = world();
        const doc = { ...folder('doc'), kind: 'file', parentId: 'f' } as DriveNode;
        const run = await startRun(w.deps, { targets: [doc, folder('f')], results: [] });
        const saved = run.version({
            file: doc,
            folder: folder('f'),
            startedFrom: 'v1',
            bytes: bytes(),
            ...own,
        });
        const other = run.file({ name: 'side.txt', bytes: bytes(), mime: null, ...own });
        await tick();
        const [version, file] = w.ids();
        w.begin(version!, 'up-v', 'doc');
        w.land(version!, 'doc', 'up-v');
        w.begin(file!, 'up-f', 'node-f');
        await saved;
        const stopped = await run.cancel();
        await expect(other).rejects.toBe(stopped);
        expect(stopped.keptVersions).toBe(1);
        expect(stopped.message).not.toContain('Nothing was saved');
        expect(stopped.message).toMatch(/new version .* was kept/);
        // The version's file stays where it is; only the new file goes.
        expect(w.server.trash.has('doc')).toBe(false);
        expect(w.server.aborted).toEqual(['up-f']);
    });

    test('a version the server finished during the cancel is counted as kept', async () => {
        const w = world();
        const doc = { ...folder('doc'), kind: 'file', parentId: 'f' } as DriveNode;
        const run = await startRun(w.deps, { targets: [doc], results: [] });
        void run
            .version({ file: doc, folder: folder('f'), startedFrom: 'v1', bytes: bytes(), ...own })
            .catch(() => {});
        await tick();
        const [version] = w.ids();
        w.begin(version!, 'up-v', 'doc');
        // Its completion went through as the cancel was sent: the abort is answered "finished".
        w.server.open.delete('up-v');
        w.server.finished.add('up-v');
        const stopped = await run.cancel();
        expect(stopped.keptVersions).toBe(1);
        expect(stopped.cleanup).toBe('nothing');
    });

    test('a completion slower than the abort’s tries keeps the row and says the version may have been saved', async () => {
        const w = world();
        // The object store is still completing both: the server answers "completing" every time.
        const completing = new Set(['up-v', 'up-f']);
        w.deps.abortUpload = (_ws, uploadId) =>
            askAbort(
                async () => {
                    if (completing.has(uploadId))
                        throw new DriveApiError('refused', 'conflict', 409, {
                            upload: 'completing',
                        });
                },
                { pause: async () => {} },
            );
        const doc = { ...folder('doc'), kind: 'file', parentId: 'f' } as DriveNode;
        const run = await startRun(w.deps, { targets: [doc, folder('f')], results: [] });
        void run
            .version({ file: doc, folder: folder('f'), startedFrom: 'v1', bytes: bytes(), ...own })
            .catch(() => {});
        void run.file({ name: 'a', bytes: bytes(), mime: null, ...own }).catch(() => {});
        await tick();
        const [version, file] = w.ids();
        w.begin(version!, 'up-v', 'doc');
        w.begin(file!, 'up-f', 'node-f');
        // Both completions sent: the server is completing them.
        await w.queued.get(version!)!.input.produced!.beforeComplete!();
        await w.queued.get(file!)!.input.produced!.beforeComplete!();
        const stopped = await run.cancel();
        expect(stopped.cleanup).toBe('left');
        expect(stopped.keptVersions).toBe(0);
        expect(stopped.uncertainVersions).toBe(1);
        expect(stopped.message).toBe(
            'Cancelled. A new version may have been saved. Some of what was made may still be there. You’ll be asked about it next time.',
        );
        // The row still names both: the file that lands later is the next open's to remove.
        expect(w.runs.rows.get(run.id)).toMatchObject({
            nodeIds: ['node-f'],
            uploadIds: ['up-v', 'up-f'],
        });
        // It lands; the next open's clean-up hears "completed" and removes the file.
        completing.clear();
        w.server.finished.add('up-f');
        w.server.live.add('node-f');
        w.deps.abortUpload = async () => 'finished';
        const [left] = await interruptedRuns({ runs: w.runs, isLive: async () => false });
        expect(await cleanUpInterrupted(w.deps, left!)).toBe('deleted');
        expect(w.server.purged.has('node-f')).toBe(true);
        expect(w.runs.rows.size).toBe(0);
    });

    test('a cancel stops open uploads and deletes forever what was published; the row goes last', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        void run.file({ name: 'a', bytes: bytes(), mime: null, ...own }).catch(() => {});
        const open = run.file({ name: 'b', bytes: bytes(), mime: null, ...own });
        await tick();
        const [a, b] = w.ids();
        w.begin(a!, 'up-a', 'node-a');
        w.land(a!, 'node-a', 'up-a');
        w.begin(b!, 'up-b', 'node-b');
        await tick();
        // The row as a closed tab would leave it: the published file and the open upload's ids.
        expect(w.runs.rows.get(run.id)).toMatchObject({
            nodeIds: ['node-a', 'node-b'],
            uploadIds: ['up-b'],
        });
        expect(resultsWaiting()).toBe(true);
        const stopped = await run.cancel();
        expect(stopped.cleanup).toBe('deleted');
        expect(stopped.message).toBe(RUN_CANCELLED);
        expect(w.cancelled).toEqual([b]);
        expect(w.server.purged).toEqual(new Set(['node-a']));
        expect(w.server.open.size).toBe(0);
        expect(w.runs.rows.size).toBe(0);
        await expect(open).rejects.toMatchObject({ reason: 'cancelled', cleanup: 'deleted' });
        expect(resultsWaiting()).toBe(false);
    });

    test('a result handed in while the run is stopping is refused and never reaches the queue; finish fails too', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        void run.file({ name: 'a', bytes: bytes(), mime: null, ...own }).catch(() => {});
        await tick();
        w.begin(w.ids()[0]!, 'up-a', 'node-a');
        const stopping = run.cancel();
        // Handed in after the cancel began, before its clean-up answered.
        const late = run.file({ name: 'late', bytes: bytes(), mime: null, ...own });
        const finished = run.finish();
        await expect(late).rejects.toBeInstanceOf(RunStopped);
        await expect(finished).rejects.toBeInstanceOf(RunStopped);
        await stopping;
        expect(w.queued.size).toBe(1);
        expect(w.runs.rows.size).toBe(0);
    });

    test('a result whose folder was still being listed when the stop began never reaches the queue', async () => {
        const w = world();
        let listed: (names: string[]) => void = () => {};
        w.deps.namesIn = () =>
            new Promise<string[]>((resolve) => {
                listed = resolve;
            });
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        const late = run.file({ name: 'late', bytes: bytes(), mime: null, ...own });
        await tick();
        const stopping = run.cancel();
        listed([]);
        await expect(late).rejects.toBeInstanceOf(RunStopped);
        await stopping;
        expect(w.queued.size).toBe(0);
    });

    test('a cancel from the transfers panel stops the whole run: all or nothing', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        const a = run.file({ name: 'a', bytes: bytes(), mime: null, ...own });
        const b = run.file({ name: 'b', bytes: bytes(), mime: null, ...own });
        await tick();
        const [idA, idB] = w.ids();
        w.begin(idA!, 'up-a', 'node-a');
        await w.deps.transfers.cancel(idA!);
        await expect(a).rejects.toBeInstanceOf(RunStopped);
        await expect(b).rejects.toBeInstanceOf(RunStopped);
        // The other result was cancelled too, and only once each.
        expect(w.cancelled).toEqual([idA, idB]);
        expect(w.server.aborted).toEqual(['up-a']);
    });

    test('a lock stops the run and cleans up, rather than hold the plaintext until someone unlocks', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        void run.file({ name: 'a', bytes: bytes(), mime: null, ...own }).catch(() => {});
        const open = run.file({ name: 'b', bytes: bytes(), mime: null, ...own });
        await tick();
        const [a, b] = w.ids();
        w.begin(a!, 'up-a', 'node-a');
        w.land(a!, 'node-a', 'up-a');
        w.begin(b!, 'up-b', 'node-b');
        w.lock(b!);
        await expect(open).rejects.toMatchObject({ reason: 'locked', cleanup: 'deleted' });
        expect(w.cancelled).toContain(b);
        expect(w.server.purged.has('node-a')).toBe(true);
        expect(resultsWaiting()).toBe(false);
    });

    test('a sign-out in another tab abandons the run: results rejected, nothing written after, nothing asked of the server', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        const open = run.file({ name: 'a', bytes: bytes(), mime: null, ...own });
        await tick();
        const [a] = w.ids();
        w.begin(a!, 'up-a', 'node-a');
        await tick();
        // That tab deletes the journal; this one must not write the row back.
        w.signOut();
        w.runs.rows.clear();
        abandonRuns();
        await expect(open).rejects.toMatchObject({ reason: 'signed-out' });
        expect(resultsWaiting()).toBe(false);
        // A begin answering late, and the heartbeat, write nothing.
        w.queued.get(a!)!.input.produced!.onBegun!({
            workspaceId: 'ws-own',
            uploadId: 'up-x',
            nodeId: 'n-x',
        });
        await tick();
        expect(w.runs.rows.size).toBe(0);
        expect(w.server.aborted).toEqual([]);
        await expect(
            run.file({ name: 'b', bytes: bytes(), mime: null, ...own }),
        ).rejects.toMatchObject({
            reason: 'signed-out',
        });
    });

    test('a restart’s second begin replaces the first in the row: the clean-up aborts and removes the live one', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        void run.file({ name: 'a', bytes: bytes(), mime: null, ...own }).catch(() => {});
        await tick();
        const [a] = w.ids();
        w.begin(a!, 'up-1', 'node-1');
        w.server.open.delete('up-1');
        w.begin(a!, 'up-2', 'node-2');
        await tick();
        expect(w.runs.rows.get(run.id)).toMatchObject({ nodeIds: ['node-2'], uploadIds: ['up-2'] });
        await run.cancel();
        expect(w.server.aborted).toEqual(['up-2']);
    });

    test('an attached sibling is in the row before its attach is sent, and a stopping run refuses the attach', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        void run.file({ name: 'a', bytes: bytes(), mime: null, ...own }).catch(() => {});
        await tick();
        const [a] = w.ids();
        w.begin(a!, 'up-a', 'node-begun');
        const produced = w.queued.get(a!)!.input.produced!;
        await produced.onAttach!({ workspaceId: 'ws-own', nodeId: 'node-sibling' });
        expect(w.runs.rows.get(run.id)!.nodeIds).toEqual(['node-begun', 'node-sibling']);
        // The attach landed but its answer was lost: the clean-up still removes the sibling.
        w.server.live.add('node-sibling');
        const stopping = run.cancel();
        await expect(
            produced.onAttach!({ workspaceId: 'ws-own', nodeId: 'node-other' }),
        ).rejects.toThrow();
        await stopping;
        expect(w.server.purged.has('node-sibling')).toBe(true);
    });

    test('per-item refusals, a purge left busy or no answer to an abort keep the row: nothing is called deleted', async () => {
        for (const breakIt of [
            (w: ReturnType<typeof world>) => w.server.refuse.add('node-a'),
            (w: ReturnType<typeof world>) => w.server.busy.add('node-a'),
            (w: ReturnType<typeof world>) => {
                w.server.offline = true;
            },
        ]) {
            const w = world();
            const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
            void run.file({ name: 'a', bytes: bytes(), mime: null, ...own }).catch(() => {});
            await tick();
            const [a] = w.ids();
            w.begin(a!, 'up-a', 'node-a');
            w.land(a!, 'node-a', 'up-a');
            breakIt(w);
            expect((await run.cancel()).cleanup).toBe('left');
            expect(w.runs.rows.get(run.id)!.nodeIds).toEqual(['node-a']);
        }
    });

    test('an interrupted version save with no answer to its abort keeps its only row', async () => {
        const w = world();
        const left: RunRow = {
            id: 'r',
            workspaceId: 'ws-own',
            nodeIds: [],
            uploadIds: ['up-v'],
            at: 1,
            beat: 1,
        };
        await w.runs.put(left);
        w.server.offline = true;
        expect(await cleanUpInterrupted(w.deps, left)).toBe('left');
        expect(w.runs.rows.has('r')).toBe(true);
        w.server.offline = false;
        w.server.open.add('up-v');
        expect(await cleanUpInterrupted(w.deps, left)).toBe('nothing');
        expect(w.runs.rows.has('r')).toBe(false);
    });

    test('a clean-up refused because the space is no longer the person’s drops the row instead of asking forever', async () => {
        const w = world();
        const left: RunRow = {
            id: 'r',
            workspaceId: 'ws-gone',
            nodeIds: ['node-a'],
            uploadIds: ['up-a'],
            at: 1,
            beat: 1,
        };
        await w.runs.put(left);
        w.server.denied = true;
        expect(await cleanUpInterrupted(w.deps, left)).toBe('no-access');
        expect(w.runs.rows.size).toBe(0);
    });

    test('keep what was made: the row goes and the files stay, its open uploads still aborted', async () => {
        const w = world();
        w.server.live.add('node-a');
        w.server.open.add('up-b');
        const left: RunRow = {
            id: 'r',
            workspaceId: 'ws-own',
            nodeIds: ['node-a'],
            uploadIds: ['up-b'],
            at: 1,
            beat: 1,
        };
        await w.runs.put(left);
        expect(await keepInterrupted(w.deps, left)).toBe('kept');
        expect(w.server.live.has('node-a')).toBe(true);
        expect(w.server.aborted).toEqual(['up-b']);
        expect(w.runs.rows.size).toBe(0);
        // With no answer to the abort (offline, an older server), the row goes all the same:
        // an open upload expires on the server, and Keep never leaves a row it can't clear.
        await w.runs.put({ ...left, id: 'r2' });
        w.server.offline = true;
        expect(await keepInterrupted(w.deps, { ...left, id: 'r2' })).toBe('kept');
        expect(w.runs.rows.size).toBe(0);
    });

    test('a folder the run made goes as one: what is inside it is not listed, nor removed one by one', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        const planted = {
            node: {
                kind: 'file' as const,
                integrity: { metadata: 'unsigned' as const, version: 'unsigned' as const },
            },
            source: 'drive' as const,
        };
        const made = await run.folder('Archive', { sources: [planted] });
        expect(w.madeFolders).toEqual([{ parent: 'f', name: 'Archive', signAs: 'resealed' }]);
        void run
            .file({ name: 'inside.txt', bytes: bytes(), mime: null, into: made, ...own })
            .catch(() => {});
        await tick();
        const [inside] = w.ids();
        w.begin(inside!, 'up-1', 'node-inside');
        w.land(inside!, 'node-inside', 'up-1');
        await tick();
        expect(w.runs.rows.get(run.id)!.nodeIds).toEqual([made.id]);
        await run.cancel();
        expect(w.server.purged).toEqual(new Set([made.id]));
    });

    test('a folder made while the run stopped, which then cannot be removed, keeps a row naming it', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        let finishMaking: (made: DriveNode) => void = () => {};
        w.deps.makeFolder = () =>
            new Promise<DriveNode>((resolve) => {
                finishMaking = resolve;
            });
        const making = run.folder('Archive', own);
        await tick();
        await run.cancel();
        w.server.refuse.add('late-folder');
        w.server.live.add('late-folder');
        finishMaking(folder('late-folder'));
        await expect(making).rejects.toBeInstanceOf(RunStopped);
        expect([...w.runs.rows.values()].map((row) => row.nodeIds)).toEqual([['late-folder']]);
    });

    test('a late folder that cannot be removed is added to the row a failed clean-up kept, never replacing it', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        void run.file({ name: 'a', bytes: bytes(), mime: null, ...own }).catch(() => {});
        await tick();
        w.begin(w.ids()[0]!, 'up-a', 'node-a');
        w.land(w.ids()[0]!, 'node-a', 'up-a');
        let finishMaking: (made: DriveNode) => void = () => {};
        w.deps.makeFolder = () =>
            new Promise<DriveNode>((resolve) => {
                finishMaking = resolve;
            });
        const making = run.folder('Archive', own);
        await tick();
        // The stop's clean-up fails for the file it made, and later for the late folder too.
        w.server.refuse.add('node-a');
        expect((await run.cancel()).cleanup).toBe('left');
        w.server.refuse.add('late-folder');
        w.server.live.add('late-folder');
        finishMaking(folder('late-folder'));
        await expect(making).rejects.toBeInstanceOf(RunStopped);
        expect([...w.runs.rows.values()].map((row) => row.nodeIds)).toEqual([
            ['node-a', 'late-folder'],
        ]);
    });

    test('a version whose completion was never sent is not said to maybe be saved, though its abort got no answer', async () => {
        const w = world();
        const doc = { ...folder('doc'), kind: 'file', parentId: 'f' } as DriveNode;
        const run = await startRun(w.deps, { targets: [doc], results: [] });
        void run
            .version({ file: doc, folder: folder('f'), startedFrom: 'v1', bytes: bytes(), ...own })
            .catch(() => {});
        await tick();
        w.begin(w.ids()[0]!, 'up-v', 'doc');
        await tick();
        // The network went while its parts went up: no completion was sent, and the abort gets no answer.
        w.server.offline = true;
        const stopped = await run.cancel();
        expect(stopped.cleanup).toBe('left');
        expect(stopped.uncertainVersions).toBe(0);
        expect(stopped.message).toBe(RUN_CANCELLED);
        // Its reservation is still the next open's to abort.
        expect(w.runs.rows.get(run.id)?.uploadIds).toEqual(['up-v']);
    });

    test('a clean-up that leaves a published file says what may remain, never “nothing was saved”', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        const saved = run.file({ name: 'a', bytes: bytes(), mime: null, ...own });
        await tick();
        w.begin(w.ids()[0]!, 'up-a', 'node-a');
        w.land(w.ids()[0]!, 'node-a', 'up-a');
        await saved;
        w.server.refuse.add('node-a');
        const stopped = await run.cancel();
        expect(stopped.cleanup).toBe('left');
        expect(stopped.message).toBe(
            'Cancelled. Some of what was made may still be there. You’ll be asked about it next time.',
        );
        // The space no longer the person's: it may remain, and they can no longer remove it.
        const gone = world();
        const other = await startRun(gone.deps, { targets: [folder('f')], results: [] });
        const result = other.file({ name: 'a', bytes: bytes(), mime: null, ...own });
        await tick();
        gone.begin(gone.ids()[0]!, 'up-a', 'node-a');
        gone.land(gone.ids()[0]!, 'node-a', 'up-a');
        await result;
        gone.server.denied = true;
        const denied = await other.cancel();
        expect(denied.cleanup).toBe('no-access');
        expect(denied.message).toBe(
            'Cancelled. Some of what was made may still be there, and you can no longer remove it.',
        );
    });

    test('a finished run whose row the journal won’t remove is never offered for deletion', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        const saved = run.file({ name: 'a', bytes: bytes(), mime: null, ...own });
        await tick();
        w.begin(w.ids()[0]!, 'up-a', 'node-a');
        w.land(w.ids()[0]!, 'node-a', 'up-a');
        await saved;
        const remove = w.runs.remove.bind(w.runs);
        w.runs.remove = () => Promise.reject(new DOMException('closed', 'InvalidStateError'));
        await run.finish();
        expect(w.runs.rows.get(run.id)?.done).toBe(true);
        expect(await interruptedRuns({ runs: w.runs, isLive: async () => false })).toEqual([]);
        // Keep is retired the same way.
        const left: RunRow = {
            id: 'r',
            workspaceId: 'ws-own',
            nodeIds: ['node-a'],
            uploadIds: [],
            at: 1,
            beat: 1,
        };
        await w.runs.put(left);
        await keepInterrupted(w.deps, left);
        expect(await interruptedRuns({ runs: w.runs, isLive: async () => false })).toEqual([]);
        // Once the journal works again the next open drops them.
        w.runs.remove = remove;
        await interruptedRuns({ runs: w.runs, isLive: async () => false });
        expect(w.runs.rows.size).toBe(0);
        expect(w.server.live.has('node-a')).toBe(true);
    });

    test('a folder’s id is on disk before its creation is sent, so a lost answer still leaves a row that removes it', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        const make = w.deps.makeFolder;
        const recordedAtSend: string[][] = [];
        w.deps.makeFolder = async (parent, name, signAs, minted) =>
            make(parent, name, signAs, async (id) => {
                await minted(id);
                recordedAtSend.push([...(w.runs.rows.get(run.id)?.nodeIds ?? [])]);
            }).then(() => {
                // Created, but the answer never came back.
                throw new TypeError('Failed to fetch');
            });
        const stopped = (await run
            .folder('Out', own)
            .catch((error: unknown) => error)) as RunStopped;
        expect(recordedAtSend).toEqual([['made-1']]);
        expect(stopped).toBeInstanceOf(RunStopped);
        expect(stopped.reason).toBe('failed');
        expect(w.server.purged.has('made-1')).toBe(true);
        expect(w.runs.rows.size).toBe(0);
    });

    test('a cancel that overtakes a folder’s creation waits for its answer, so a folder made after the clean-up looked is never left untracked', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        let create: () => void = () => {};
        w.deps.makeFolder = async (_parent, _name, _signAs, minted) => {
            await minted('slow');
            // The server creates it once the cancel's clean-up would already have looked, and the answer is lost.
            await new Promise<void>((resolve) => {
                create = resolve;
            });
            w.server.live.add('slow');
            throw new TypeError('Failed to fetch');
        };
        const making = run.folder('Out', own).catch((error: unknown) => error);
        await tick();
        await tick();
        const cancelled = run.cancel();
        await tick();
        create();
        const stopped = await cancelled;
        await making;
        expect(stopped.cleanup).toBe('deleted');
        expect(w.server.purged.has('slow')).toBe(true);
        expect(w.runs.rows.size).toBe(0);
    });

    test('a folder whose creation got no answer and is made after the clean-up looked keeps the row, and the next open removes it', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        let create: () => void = () => {};
        w.deps.makeFolder = async (_parent, _name, _signAs, minted) => {
            await minted('slow');
            // The connection drops while the server is still making it: it commits later.
            void new Promise<void>((resolve) => {
                create = resolve;
            }).then(() => w.server.live.add('slow'));
            throw new TypeError('Failed to fetch');
        };
        const stopped = (await run
            .folder('Out', own)
            .catch((error: unknown) => error)) as RunStopped;
        create();
        await tick();
        expect(stopped.reason).toBe('failed');
        expect(stopped.cleanup).toBe('left');
        expect(stopped.message).not.toContain('Nothing was saved');
        expect(stopped.message).toContain('You’ll be asked about it next time.');
        const [row] = await interruptedRuns({ runs: w.runs, isLive: async () => false });
        expect(row?.nodeIds).toEqual(['slow']);
        expect(await cleanUpInterrupted(w.deps, row!)).toBe('deleted');
        expect(w.server.purged.has('slow')).toBe(true);
        expect(w.runs.rows.size).toBe(0);
    });

    test('a folder whose creation the server refused with its reason was never made: the row goes', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        w.deps.makeFolder = async (_parent, _name, _signAs, minted) => {
            await minted('refused');
            throw new DriveApiError(
                'The destination folder is in the trash.',
                'parent-trashed',
                409,
            );
        };
        const stopped = (await run
            .folder('Out', own)
            .catch((error: unknown) => error)) as RunStopped;
        expect(stopped.cleanup).toBe('nothing');
        expect(stopped.message).toContain('Nothing was saved');
        expect(w.runs.rows.size).toBe(0);
    });

    test('a folder creation answered 409 for its own id (the browser sent it again) may exist: the row stays', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        let create: () => void = () => {};
        w.deps.makeFolder = async (_parent, _name, _signAs, minted) => {
            await minted('twice');
            // The first send is still being made; the resend finds its id taken.
            void new Promise<void>((resolve) => {
                create = resolve;
            }).then(() => w.server.live.add('twice'));
            throw new DriveApiError('An item with this id already exists.', 'conflict', 409);
        };
        const stopped = (await run
            .folder('Out', own)
            .catch((error: unknown) => error)) as RunStopped;
        create();
        await tick();
        expect(stopped.cleanup).toBe('left');
        expect(stopped.message).not.toContain('Nothing was saved');
        const [row] = await interruptedRuns({ runs: w.runs, isLive: async () => false });
        expect(await cleanUpInterrupted(w.deps, row!)).toBe('deleted');
        expect(w.server.purged.has('twice')).toBe(true);
    });

    test('a folder whose answer was lost when the app ended keeps its row at the next open until the folder appears, then goes', async () => {
        const w = world();
        let clock = 1_000;
        w.deps.now = () => clock;
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        w.deps.makeFolder = async (_parent, _name, _signAs, minted) => {
            await minted('slow');
            // The app ends with the creation on its way: no answer ever comes back here.
            return new Promise<DriveNode>(() => {});
        };
        void run.folder('Out', own);
        await tick();
        await tick();
        expect(w.runs.rows.get(run.id)!.uncertain).toEqual([{ id: 'slow', at: 1_000 }]);
        abandonRuns();
        // The next open, before the server made it: the person says delete; not found, the row stays
        // with that answer.
        const reopen = () => interruptedRuns({ ...w.deps, isLive: async () => false });
        const [row] = await reopen();
        expect(await cleanUpInterrupted(w.deps, row!)).toBe('left');
        expect(w.runs.rows.get(row!.id)?.chosen).toBe('delete');
        // Later opens never ask again: the answer is applied quietly while the folder isn't there.
        expect(await reopen()).toEqual([]);
        expect(w.runs.rows.size).toBe(1);
        // It lands; the open after that removes it and the row goes.
        w.server.live.add('slow');
        expect(await reopen()).toEqual([]);
        expect(w.server.purged.has('slow')).toBe(true);
        expect(w.runs.rows.size).toBe(0);

        // Past CREATION_SETTLE_MS a folder still not there was never made: the row goes.
        await w.runs.put(row!);
        clock += CREATION_SETTLE_MS;
        w.server.purged.clear();
        expect(await cleanUpInterrupted(w.deps, row!)).toBe('nothing');
        expect(w.runs.rows.size).toBe(0);
    });

    test('a folder creation answered 409 for its own id that is there is the folder: the run goes on', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        w.deps.makeFolder = async (_parent, _name, _signAs, minted) => {
            await minted('resent');
            // The first send made it; the browser's resend found the id taken.
            w.server.live.add('resent');
            throw new DriveApiError('An item with this id already exists.', 'conflict', 409);
        };
        const out = await run.folder('Out', own);
        expect(out.id).toBe('resent');
        await run.finish();
        expect(w.server.live.has('resent')).toBe(true);
        expect(w.runs.rows.size).toBe(0);
    });

    test('two late folders that both can’t be removed are both named by the row', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        const finishers: ((made: DriveNode) => void)[] = [];
        w.deps.makeFolder = () =>
            new Promise<DriveNode>((resolve) => {
                finishers.push(resolve);
            });
        const first = run.folder('One', own);
        const second = run.folder('Two', own);
        await tick();
        expect((await run.cancel()).cleanup).toBe('nothing');
        for (const id of ['late-1', 'late-2']) {
            w.server.live.add(id);
            w.server.refuse.add(id);
        }
        finishers[0]!(folder('late-1'));
        await expect(first).rejects.toBeInstanceOf(RunStopped);
        finishers[1]!(folder('late-2'));
        await expect(second).rejects.toBeInstanceOf(RunStopped);
        expect([...w.runs.rows.values()].map((row) => row.nodeIds)).toEqual([['late-1', 'late-2']]);
    });

    test('a folder listing or creation that fails stops the run and removes what it made, all or nothing', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        const saved = run.file({ name: 'a', bytes: bytes(), mime: null, ...own });
        await tick();
        w.begin(w.ids()[0]!, 'up-a', 'node-a');
        w.land(w.ids()[0]!, 'node-a', 'up-a');
        await saved;
        w.deps.namesIn = () => Promise.reject(new TypeError('Failed to fetch'));
        await expect(
            run.file({ name: 'b', bytes: bytes(), mime: null, ...own, into: folder('g') }),
        ).rejects.toMatchObject({ reason: 'failed' });
        expect(w.server.purged.has('node-a')).toBe(true);
        expect(w.runs.rows.size).toBe(0);
        expect(resultsWaiting()).toBe(false);

        const v = world();
        const other = await startRun(v.deps, { targets: [folder('f')], results: [] });
        const kept = other.file({ name: 'a', bytes: bytes(), mime: null, ...own });
        await tick();
        v.begin(v.ids()[0]!, 'up-a', 'node-a');
        v.land(v.ids()[0]!, 'node-a', 'up-a');
        await kept;
        v.deps.makeFolder = () => Promise.reject(new Error('This folder is read-only.'));
        await expect(other.folder('Out', own)).rejects.toMatchObject({ reason: 'failed' });
        expect(v.server.purged.has('node-a')).toBe(true);
        await expect(
            other.file({ name: 'c', bytes: bytes(), mime: null, ...own }),
        ).rejects.toBeInstanceOf(RunStopped);
    });

    test('a `stale` that is only a key having moved is a failure, never someone else’s version', async () => {
        const w = world();
        const doc = { ...folder('doc'), kind: 'file', parentId: 'f' } as DriveNode;
        const run = await startRun(w.deps, { targets: [doc], results: [] });
        const saved = run.version({
            file: doc,
            folder: folder('f'),
            startedFrom: 'v1',
            bytes: bytes(),
            ...own,
        });
        await tick();
        // The engine gave up on a key-only refusal: `stale` as the server's code, no race confirmed.
        w.failWith(w.ids()[0]!, 'stale');
        await expect(saved).rejects.toMatchObject({ reason: 'failed' });
    });

    test('a finish whose record the journal won’t update says so, stays live, and can be asked again', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        const saved = run.file({ name: 'a', bytes: bytes(), mime: null, ...own });
        await tick();
        w.begin(w.ids()[0]!, 'up-a', 'node-a');
        w.land(w.ids()[0]!, 'node-a', 'up-a');
        await saved;
        const put = w.runs.put.bind(w.runs);
        const remove = w.runs.remove.bind(w.runs);
        w.runs.put = () => Promise.reject(new DOMException('full', 'QuotaExceededError'));
        w.runs.remove = () => Promise.reject(new DOMException('full', 'QuotaExceededError'));
        await expect(run.finish()).rejects.toBeInstanceOf(RecordNotUpdated);
        // Still this page's: never taken for interrupted here, and nothing more taken in.
        expect(await interruptedRuns({ runs: w.runs, isLive: async () => false })).toEqual([]);
        await expect(run.file({ name: 'b', bytes: bytes(), mime: null, ...own })).rejects.toThrow();
        w.runs.put = put;
        w.runs.remove = remove;
        await run.finish();
        expect(w.runs.rows.size).toBe(0);
        // Keep, the same: not recorded is said, never "kept".
        const left: RunRow = {
            id: 'r',
            workspaceId: 'ws-own',
            nodeIds: [],
            uploadIds: [],
            at: 1,
            beat: 1,
        };
        await w.runs.put(left);
        w.runs.put = () => Promise.reject(new DOMException('full', 'QuotaExceededError'));
        w.runs.remove = () => Promise.reject(new DOMException('full', 'QuotaExceededError'));
        expect(await keepInterrupted(w.deps, left)).toBe('not-recorded');
        expect(w.runs.rows.has('r')).toBe(true);
    });

    test('a failure on the run’s own way says why', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        w.deps.namesIn = () => Promise.reject(new Error('This folder couldn’t be listed'));
        await expect(
            run.file({ name: 'a', bytes: bytes(), mime: null, ...own }),
        ).rejects.toMatchObject({
            message: 'This folder couldn’t be listed. Nothing was saved.',
        });
    });

    test('a sign-out after a result was sent to be published says it may still be there; a cancel after finish says it was saved', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        const saved = run.file({ name: 'a', bytes: bytes(), mime: null, ...own });
        await tick();
        w.begin(w.ids()[0]!, 'up-a', 'node-a');
        await w.queued.get(w.ids()[0]!)!.input.produced!.beforeComplete!();
        w.signOut();
        abandonRuns();
        await expect(saved).rejects.toMatchObject({
            reason: 'signed-out',
            message:
                'You signed out before this was saved. Some of what was made may still be there.',
        });

        const v = world();
        const done = await startRun(v.deps, { targets: [folder('f')], results: [] });
        const result = done.file({ name: 'a', bytes: bytes(), mime: null, ...own });
        await tick();
        v.begin(v.ids()[0]!, 'up-a', 'node-a');
        v.land(v.ids()[0]!, 'node-a', 'up-a');
        await result;
        await done.finish();
        expect((await done.cancel()).message).toBe(ALREADY_SAVED);
    });

    test('an abort refused as no longer theirs, once its completion was sent, may have landed', async () => {
        const w = world();
        const doc = { ...folder('doc'), kind: 'file', parentId: 'f' } as DriveNode;
        const run = await startRun(w.deps, { targets: [doc], results: [] });
        void run
            .version({ file: doc, folder: folder('f'), startedFrom: 'v1', bytes: bytes(), ...own })
            .catch(() => {});
        await tick();
        w.begin(w.ids()[0]!, 'up-v', 'doc');
        await w.queued.get(w.ids()[0]!)!.input.produced!.beforeComplete!();
        w.server.denied = true;
        const stopped = await run.cancel();
        expect(stopped.uncertainVersions).toBe(1);
        expect(stopped.message).toMatch(/may have been saved/);
    });

    test('an offline clean-up of a file whose completion was never sent doesn’t say it may still be there', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        void run.file({ name: 'a', bytes: bytes(), mime: null, ...own }).catch(() => {});
        await tick();
        w.begin(w.ids()[0]!, 'up-a', 'node-a');
        await tick();
        w.server.offline = true;
        const stopped = await run.cancel();
        expect(stopped.cleanup).toBe('left');
        expect(stopped.message).toBe(RUN_CANCELLED);
    });

    test('the app’s lock stops a run whose result is paused or completing, and its clean-up starts', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        const paused = run.file({ name: 'a', bytes: bytes(), mime: null, ...own });
        const completing = run.file({ name: 'b', bytes: bytes(), mime: null, ...own });
        await tick();
        const [a, b] = w.ids();
        // `a` begun and its parts paused; `b` with its completion sent. No upload reports a lock.
        w.begin(a!, 'up-a', 'node-a');
        w.begin(b!, 'up-b', 'node-b');
        await w.queued.get(b!)!.input.produced!.beforeComplete!();
        await lockRuns();
        await expect(paused).rejects.toMatchObject({ reason: 'locked' });
        await expect(completing).rejects.toMatchObject({ reason: 'locked' });
        expect(w.server.aborted).toEqual(expect.arrayContaining(['up-a', 'up-b']));
        expect(w.runs.rows.size).toBe(0);
        expect(resultsWaiting()).toBe(false);
    });

    test('a version whose completion was sent and whose abort finds nothing (a share ended) may have been saved', async () => {
        const w = world();
        const doc = { ...folder('doc'), kind: 'file', parentId: 'f' } as DriveNode;
        const run = await startRun(w.deps, { targets: [doc], results: [] });
        void run
            .version({ file: doc, folder: folder('f'), startedFrom: 'v1', bytes: bytes(), ...own })
            .catch(() => {});
        await tick();
        w.begin(w.ids()[0]!, 'up-v', 'doc');
        await w.queued.get(w.ids()[0]!)!.input.produced!.beforeComplete!();
        // Access lost: the server answers 404 for the upload, as it does for a workspace no longer theirs.
        w.server.open.delete('up-v');
        const stopped = await run.cancel();
        expect(stopped.uncertainVersions).toBe(1);
        expect(stopped.message).not.toMatch(/Nothing was saved/);
    });

    test('a row the journal refuses to write stops the run: nothing is attached or completed that it does not name', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        const saved = run.file({ name: 'a', bytes: bytes(), mime: null, ...own });
        await tick();
        const [a] = w.ids();
        const produced = w.queued.get(a!)!.input.produced!;
        // Storage full: the begin's row can't be written.
        w.runs.put = () => Promise.reject(new DOMException('full', 'QuotaExceededError'));
        w.begin(a!, 'up-a', 'node-a');
        await expect(produced.beforeComplete!()).rejects.toThrow();
        await expect(
            produced.onAttach!({ workspaceId: 'ws-own', nodeId: 'n-2' }),
        ).rejects.toThrow();
        const stopped = (await saved.catch((error: unknown) => error)) as RunStopped;
        expect(stopped).toMatchObject({ reason: 'failed' });
        expect(stopped.message).toMatch(/couldn’t keep a record/);
        // Its upload was aborted on the server all the same.
        expect(w.server.aborted).toContain('up-a');
    });

    test('one refused write (a connection the browser closed) is written again; the run goes on', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        const saved = run.file({ name: 'a', bytes: bytes(), mime: null, ...own });
        await tick();
        const [a] = w.ids();
        const produced = w.queued.get(a!)!.input.produced!;
        const put = w.runs.put.bind(w.runs);
        let refusals = 1;
        w.runs.put = (row) =>
            refusals-- > 0
                ? Promise.reject(new DOMException('closed', 'InvalidStateError'))
                : put(row);
        w.begin(a!, 'up-a', 'node-a');
        await produced.beforeComplete!();
        expect(w.runs.rows.get(run.id)).toMatchObject({
            nodeIds: ['node-a'],
            uploadIds: ['up-a'],
        });
        w.land(a!, 'node-a', 'up-a');
        await saved;
        await run.finish();
        expect(w.server.aborted).toEqual([]);
        expect(w.server.live.has('node-a')).toBe(true);
    });

    test('a sign-out while a run starts: it never starts, writes no row and lets its hold go', async () => {
        for (const during of ['room', 'hold', 'row'] as const) {
            const w = world();
            const held = new Set<string>();
            const room = w.deps.room;
            w.deps.room = async (ws) => {
                if (during === 'room') w.signOut();
                return room(ws);
            };
            w.deps.hold = async (id) => {
                held.add(id);
                if (during === 'hold') w.signOut();
                return () => held.delete(id);
            };
            const put = w.runs.put.bind(w.runs);
            w.runs.put = async (row) => {
                // The sign-out cleared the journal just before this row went in: it lands in the next one.
                if (during === 'row') {
                    w.signOut();
                    w.runs.rows.clear();
                }
                await put(row);
            };
            await expect(
                startRun(w.deps, { targets: [folder('f')], results: [] }),
                during,
            ).rejects.toMatchObject({ reason: 'signed-out' });
            expect(w.runs.rows.size, during).toBe(0);
            expect(held.size, during).toBe(0);
            expect(resultsWaiting()).toBe(false);
        }
    });

    test('a run whose session ended without reaching it takes no more work and makes no folder', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        w.signOut();
        await expect(run.folder('Out', own)).rejects.toMatchObject({ reason: 'signed-out' });
        await expect(
            run.file({ name: 'a', bytes: bytes(), mime: null, ...own }),
        ).rejects.toMatchObject({ reason: 'signed-out' });
        expect(w.madeFolders).toEqual([]);
        expect(w.ids()).toEqual([]);
        expect(w.server.aborted).toEqual([]);
    });

    test('a folder that lands after a sign-out is neither removed nor written down for that account', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        const make = w.deps.makeFolder;
        w.deps.makeFolder = async (parent, name, signAs, minted) => {
            const made = await make(parent, name, signAs, minted);
            w.signOut();
            w.runs.rows.clear();
            return made;
        };
        await expect(run.folder('Out', own)).rejects.toMatchObject({ reason: 'signed-out' });
        expect(w.runs.rows.size).toBe(0);
        expect(w.server.live.has('made-1')).toBe(true);
        expect([...w.server.trash, ...w.server.purged]).toEqual([]);
    });

    test('the next open lists a closed tab’s run, not a live one, and cleans it up from its ids alone', async () => {
        const w = world();
        const left: RunRow = {
            id: 'run-closed',
            workspaceId: 'ws-own',
            nodeIds: ['node-a'],
            uploadIds: ['up-b'],
            at: 1,
            beat: 1,
        };
        w.server.live.add('node-a');
        w.server.open.add('up-b');
        await w.runs.put(left);
        const live = await startRun(w.deps, { targets: [folder('f')], results: [] });
        // Another tab's run, held there: not this tab's to clean up.
        await w.runs.put({ ...left, id: 'run-other-tab' });
        const found = await interruptedRuns({
            runs: w.runs,
            isLive: async (id) => id === 'run-other-tab',
        });
        expect(found.map((row) => row.id)).toEqual(['run-closed']);
        expect(await cleanUpInterrupted(w.deps, found[0]!)).toBe('deleted');
        expect(w.server.aborted).toEqual(['up-b']);
        expect(w.server.purged).toEqual(new Set(['node-a']));
        expect([...w.runs.rows.keys()].sort()).toEqual([live.id, 'run-other-tab'].sort());
        await live.cancel();
    });

    test('without Web Locks, a row whose heartbeat is recent is another tab’s live run, not interrupted', async () => {
        const runs = createMemoryRunJournal();
        const at = 1_000_000;
        await runs.put({
            id: 'fresh',
            workspaceId: 'w',
            nodeIds: ['n'],
            uploadIds: [],
            at: 1,
            beat: at - 1_000,
        });
        await runs.put({
            id: 'stale',
            workspaceId: 'w',
            nodeIds: ['n'],
            uploadIds: [],
            at: 1,
            beat: at - 10 * 60_000,
        });
        expect((await interruptedRuns({ runs, now: () => at })).map((row) => row.id)).toEqual([
            'stale',
        ]);
    });

    test('its row is written only once its lock is held, and the lock is held for as long as the run runs', async () => {
        const w = world();
        // A lock manager that grants a moment later, as the browser's does.
        const held = new Set<string>();
        const unheldWrites: string[] = [];
        w.deps.hold = async (id) => {
            await tick();
            held.add(id);
            return () => held.delete(id);
        };
        w.deps.isLive = async (id) => held.has(id);
        const put = w.runs.put.bind(w.runs);
        w.runs.put = async (row) => {
            if (!held.has(row.id)) unheldWrites.push(row.id);
            await put(row);
        };
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        expect(unheldWrites).toEqual([]);
        // Another tab's next open, at any point while it runs: never interrupted.
        expect(await interruptedRuns({ runs: w.runs, isLive: w.deps.isLive })).toEqual([]);
        void run.file({ name: 'a', bytes: bytes(), mime: null, ...own }).catch(() => {});
        await tick();
        w.begin(w.ids()[0]!, 'up-a', 'node-a');
        w.land(w.ids()[0]!, 'node-a', 'up-a');
        await tick();
        expect(unheldWrites).toEqual([]);
        expect(await interruptedRuns({ runs: w.runs, isLive: w.deps.isLive })).toEqual([]);
        await run.finish();
        expect(held.size).toBe(0);
    });

    test('finish is refused while a result is on its way, and drops the row once all are in', async () => {
        const w = world();
        const run = await startRun(w.deps, { targets: [folder('f')], results: [] });
        const saved = run.file({ name: 'a', bytes: [bytes(2), bytes(3)], mime: null, ...own });
        await tick();
        const [a] = w.ids();
        expect(w.queued.get(a!)!.input.file).toMatchObject({ kind: 'memory', size: 5 });
        await expect(run.finish()).rejects.toThrow();
        w.begin(a!, 'up-a', 'node-a');
        w.land(a!, 'node-a', 'up-a');
        await saved;
        await run.finish();
        expect(w.runs.rows.size).toBe(0);
        // Finished: a cancel afterwards removes nothing it kept.
        expect((await run.cancel()).cleanup).toBe('nothing');
        expect(w.server.trash.size).toBe(0);
    });
});
