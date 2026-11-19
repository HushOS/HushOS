import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { UploadPartResult } from '@hushos/crypto';
import { KEY_CHANGE_PENDING } from '@hushos/crypto/protocol';
import { generateKey, openMetadata, sealMetadata } from '@hushos/crypto/drive';
import { DriveApiError, type DriveApi } from './api';
import type { DriveNode } from './client';
import { scopedId } from '../../db/src/ids';
import { createMemoryJournal } from './journal';
import {
    backoffDelay,
    DESTINATION_CHANGED,
    KEY_CHANGE_GAVE_UP,
    VERSION_MOVED,
    type MemoryFile,
} from './transfers';
import {
    CHUNK,
    NODE_ID,
    WS_ID,
    fakeFile,
    fakeStash,
    harness,
    node,
    settle,
    type Journal,
} from './transfers.harness';

/*
 * The upload engine against a fake worker, a fake API and an in-memory journal:
 * the pool bounds parts in flight, a digest is journaled before a part is sent,
 * pause aborts and resume continues from the parts the store has, a retryable
 * failure backs off, a permanent one fails the file, cancel releases the server
 * reservation, and a journaled upload comes back after a "reload" and continues
 * only when the file proves to be the same one. No bytes, no crypto: decisions.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('backoff', () => {
    test('grows exponentially with full jitter and never exceeds a minute', () => {
        expect(backoffDelay(1, () => 1)).toBe(1_000);
        expect(backoffDelay(3, () => 1)).toBe(4_000);
        expect(backoffDelay(10, () => 1)).toBe(60_000);
        expect(backoffDelay(3, () => 0)).toBe(0);
        expect(backoffDelay(3, () => 0.5)).toBe(2_000);
    });
});

describe('transfer manager', () => {
    test('a key change that lands after a file was queued stops it at prepare, and a retry goes once the walk reached the folder', async () => {
        // The running key change's target epoch, null before it lands; what the walk has re-keyed.
        let target: number | null = null;
        const epochs = new Map([
            ['waiting', 1],
            ['old', 1],
        ]);
        const at = (id: string, parentId: string | null = 'root') => ({
            ...node(id, parentId),
            keyEpoch: epochs.get(id) ?? 9,
        });
        const existing = { ...at('old'), kind: 'file' as const };
        const h = harness({
            // As the app's refusal reads it: by the key epoch of the node it is handed.
            refuseWrite: (t) =>
                target !== null && t.keyEpoch < target ? 'Finishing a key change.' : null,
            // The folder (and the file replaced) as listed now, not as when queued.
            openNodes: async (entry) => ({
                parent: at(entry.parentId, null),
                ...('replacesId' in entry && entry.replacesId
                    ? { replaces: { ...at(entry.replacesId), kind: 'file' as const } }
                    : {}),
            }),
        });
        const [intoFolder, replacing] = h.manager.enqueue([
            { file: fakeFile(CHUNK), parent: at('waiting') },
            { file: fakeFile(CHUNK), parent: at('root', null), replaces: existing },
        ]);
        target = 5;
        await settle(2_000);
        for (const id of [intoFolder!, replacing!]) {
            expect(h.item(id).status).toBe('failed');
            expect(h.item(id).error).toBe('Finishing a key change.');
        }
        // Nothing was wrapped under the old keys, and the server saw nothing.
        for (const operation of ['driveCreateNodes', 'driveUploadPrepare', 'driveUploadSend'])
            expect(h.calls).not.toContain(operation);
        expect(h.server.uploads.size).toBe(0);
        // The walk re-keys both: the snapshots taken when they were queued are still at epoch 1,
        // so a retry goes only because the folder and the file are looked up again.
        epochs.set('waiting', 5);
        epochs.set('old', 5);
        await h.manager.retry(intoFolder!);
        await h.manager.retry(replacing!);
        await settle(2_000);
        expect(h.item(intoFolder!).status).toBe('done');
        expect(h.item(replacing!).status).toBe('done');
        expect(h.givenEpochs.length).toBe(1);
    });

    test('an upload into a folder a key change has not reached waits without a slot, and goes once the walk re-keyed it; any other refusal still fails', async () => {
        let target: number | null = 5;
        const epochs = new Map([
            ['waiting', 1],
            ['old', 1],
        ]);
        const at = (id: string, parentId: string | null = 'root') => ({
            ...node(id, parentId),
            keyEpoch: epochs.get(id) ?? 9,
        });
        const existing = { ...at('old'), kind: 'file' as const };
        const h = harness({
            refuseWrite: (t) =>
                t.id === 'shut'
                    ? 'You can open this folder but not add to it.'
                    : target !== null && t.keyEpoch < target
                      ? 'Finishing a key change.'
                      : null,
            waitsForKeyChange: (t) => t.id !== 'shut' && target !== null && t.keyEpoch < target,
            openNodes: async (entry) => ({
                parent: at(entry.parentId, null),
                ...('replacesId' in entry && entry.replacesId
                    ? { replaces: { ...at(entry.replacesId), kind: 'file' as const } }
                    : {}),
            }),
        });
        const [intoFolder, replacing, shut] = h.manager.enqueue([
            { file: fakeFile(CHUNK), parent: at('waiting') },
            { file: fakeFile(CHUNK), parent: at('root', null), replaces: existing },
            { file: fakeFile(CHUNK), parent: at('shut') },
        ]);
        await settle(5_000);
        // The two waiting say why and hold nothing made; the refused one failed as before.
        for (const id of [intoFolder!, replacing!]) {
            expect(h.item(id)).toMatchObject({
                status: 'preparing',
                waitingFor: 'Finishing a key change.',
            });
        }
        expect(h.item(shut!)).toMatchObject({
            status: 'failed',
            error: 'You can open this folder but not add to it.',
        });
        for (const operation of ['driveCreateNodes', 'driveUploadPrepare', 'driveUploadSend'])
            expect(h.calls).not.toContain(operation);
        // Waiting holds no slot (two at a time here): an upload elsewhere goes meanwhile.
        const [elsewhere] = h.manager.enqueue([
            { file: fakeFile(CHUNK), parent: at('root', null) },
        ]);
        await settle(5_000);
        expect(h.item(elsewhere!).status).toBe('done');
        expect(h.item(intoFolder!).status).toBe('preparing');
        // The walk re-keys the folder and the file: at the next look they go by themselves.
        epochs.set('waiting', 5);
        epochs.set('old', 5);
        await settle(5_000);
        expect(h.item(intoFolder!)).toMatchObject({ status: 'done', waitingFor: null });
        expect(h.item(replacing!)).toMatchObject({ status: 'done', waitingFor: null });
        target = null;
    });

    test('uploads through a bounded pool, journals digests before sends, completes once', async () => {
        const h = harness();
        const [id] = h.manager.enqueue([{ file: fakeFile(5 * CHUNK), parent: node('root', null) }]);
        await settle(2_000);
        expect(h.item(id!).status).toBe('done');
        expect(h.peak()).toBe(3);
        expect(h.server.completed).toEqual([{ id: 'up-1', parts: [1, 2, 3, 4, 5] }]);
        expect(h.published).toEqual(['n']);
        const firstSend = h.calls.indexOf('driveUploadSend');
        expect(h.calls.slice(0, firstSend)).toContain('driveUploadEncrypt');
        expect(h.journal.entries.size).toBe(0);
    });

    test('pause aborts parts in flight and resume continues from the ones that landed', async () => {
        const h = harness();
        const [id] = h.manager.enqueue([{ file: fakeFile(6 * CHUNK), parent: node('root', null) }]);
        await settle(150);
        const landed = h.item(id!).partsDone;
        expect(landed).toBeGreaterThanOrEqual(1);
        await h.manager.pause(id!);
        await settle(500);
        expect(h.item(id!).status).toBe('paused');
        const sendsWhilePaused = h.calls.filter((c) => c === 'driveUploadSend').length;
        await settle(1_000);
        expect(h.calls.filter((c) => c === 'driveUploadSend').length).toBe(sendsWhilePaused);
        await h.manager.resume(id!);
        await settle(2_000);
        expect(h.item(id!).status).toBe('done');
        expect(h.server.completed).toEqual([{ id: 'up-1', parts: [1, 2, 3, 4, 5, 6] }]);
        expect(h.calls.filter((c) => c === 'driveUploadSend').length - sendsWhilePaused).toBe(
            6 - landed,
        );
    });

    test('a pause while preparing holds the file before a byte is sent, and a resume in either order sends it once', async () => {
        const h = harness();
        // Hold the server's answer to begin, so the pause lands while the file is preparing.
        const begin = h.api.beginUpload;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        h.api.beginUpload = async (ws, input) => {
            await held;
            return begin(ws, input);
        };
        const [id] = h.manager.enqueue([{ file: fakeFile(3 * CHUNK), parent: node('root', null) }]);
        await settle(100);
        expect(h.item(id!).status).toBe('preparing');
        await h.manager.pause(id!);
        expect(h.item(id!).status).toBe('paused');
        release();
        await settle(500);
        // Prepared, journaled, and not sending: the reservation is what a resume continues from.
        expect(h.item(id!).status).toBe('paused');
        expect(h.journal.entries.size).toBe(1);
        expect(h.calls.filter((c) => c === 'driveUploadSend')).toEqual([]);
        await h.manager.resume(id!);
        await settle(2_000);
        expect(h.item(id!).status).toBe('done');
        expect(h.server.completed).toEqual([{ id: 'up-1', parts: [1, 2, 3] }]);

        // Resumed before preparation finished: it carries on, and begins on the server once.
        let releaseAgain!: () => void;
        const heldAgain = new Promise<void>((resolve) => {
            releaseAgain = resolve;
        });
        h.api.beginUpload = async (ws, input) => {
            await heldAgain;
            return begin(ws, input);
        };
        const [second] = h.manager.enqueue([
            { file: fakeFile(CHUNK, 'second.bin'), parent: node('root', null) },
        ]);
        await settle(100);
        await h.manager.pause(second!);
        expect(h.item(second!).status).toBe('paused');
        await h.manager.resume(second!);
        expect(h.item(second!).status).toBe('preparing');
        releaseAgain();
        await settle(2_000);
        expect(h.item(second!).status).toBe('done');
        expect(h.server.completed.map((c) => c.id)).toEqual(['up-1', 'up-2']);
    });

    test('a part retried after the file changed under it starts over, never re-sent under the same nonce', async () => {
        let encryptions = 0;
        const h = harness({
            random: () => 0.5,
            // The second chunk reads differently the second time it is encrypted.
            digest: (file, index) =>
                index === 1 && ++encryptions > 1 ? 'changed' : `d-${file.name}-${index}`,
            send: async (_objectId, index) => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                if (index === 1 && encryptions === 1)
                    return { ok: false, status: 503, retryable: true, message: 'busy' };
                return { ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 };
            },
        });
        const [id] = h.manager.enqueue([{ file: fakeFile(3 * CHUNK), parent: node('root', null) }]);
        await settle(5_000);
        // The first object is abandoned, and the changed bytes went out only in a fresh one.
        expect(h.server.aborted).toContain('up-1');
        expect(h.calls.filter((c) => c === 'driveUploadPrepare').length).toBeGreaterThan(1);
        expect(h.server.completed.some((c) => c.id === 'up-1')).toBe(false);
        expect(h.item(id!).status).not.toBe('failed');
    });

    test('a retryable part failure backs off and the file still completes', async () => {
        let failures = 0;
        const h = harness({
            // Half the ceiling every time: 500 ms then 1 s, so neither retry lands inside the first check.
            random: () => 0.5,
            send: async (_objectId, index) => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                if (index === 1 && failures < 2) {
                    failures++;
                    return { ok: false, status: 503, retryable: true, message: 'busy' };
                }
                return { ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 };
            },
        });
        const [id] = h.manager.enqueue([{ file: fakeFile(3 * CHUNK), parent: node('root', null) }]);
        await settle(200);
        expect(h.item(id!).status).toBe('uploading');
        expect(h.item(id!).partsDone).toBe(2);
        await settle(70_000);
        expect(failures).toBe(2);
        expect(h.item(id!).status).toBe('done');
        expect(h.server.completed[0]!.parts).toEqual([1, 2, 3]);
    });

    test('while offline a failing part waits for the network and the tries are not counted', async () => {
        let failures = 0;
        const h = harness({
            random: () => 0.5,
            offline: () => failures < 5,
            send: async (_objectId, index) => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                // Five failures, more than the harness's three tries, all while offline.
                if (index === 1 && failures < 5) {
                    failures++;
                    return { ok: false, status: 0, retryable: true, message: 'offline' };
                }
                return { ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 };
            },
        });
        const [id] = h.manager.enqueue([{ file: fakeFile(3 * CHUNK), parent: node('root', null) }]);
        await settle(200_000);
        expect(failures).toBe(5);
        expect(h.item(id!).status).toBe('done');
        expect(h.server.completed[0]!.parts).toEqual([1, 2, 3]);
    });

    test('a permanent part failure fails the file and keeps the journal for a retry', async () => {
        const h = harness({
            send: async (_objectId, index) => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                if (index === 0)
                    return { ok: false, status: 400, retryable: false, message: 'rejected' };
                return { ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 };
            },
        });
        const [id] = h.manager.enqueue([{ file: fakeFile(2 * CHUNK), parent: node('root', null) }]);
        await settle(500);
        expect(h.item(id!).status).toBe('failed');
        expect(h.item(id!).error).toBe('rejected');
        expect(h.server.completed).toHaveLength(0);
        expect(h.server.aborted).toHaveLength(0);
        expect(h.journal.entries.size).toBe(1);
    });

    test('cancel aborts the server upload, forgets the key, and drops the journal', async () => {
        const h = harness();
        const [id] = h.manager.enqueue([{ file: fakeFile(4 * CHUNK), parent: node('root', null) }]);
        await settle(120);
        await h.manager.cancel(id!);
        await settle(500);
        expect(h.item(id!).status).toBe('cancelled');
        expect(h.server.aborted).toEqual(['up-1']);
        expect(h.calls.filter((c) => c === 'driveUploadForget')).toHaveLength(1);
        expect(h.server.completed).toHaveLength(0);
        expect(h.journal.entries.size).toBe(0);
    });

    test('a cancel whose worker steps outlast a sign-out sends no abort for that session', async () => {
        let open = true;
        let generation = 1;
        let release: () => void = () => {};
        const h = harness({
            session: { open: () => open, generation: () => generation },
            cancelHold: () => new Promise<void>((resolve) => (release = resolve)),
        });
        const [id] = h.manager.enqueue(
            [{ file: fakeFile(4 * CHUNK), parent: node('root', null) }],
            {
                generation: 1,
            },
        );
        await settle(120);
        const cancelling = h.manager.cancel(id!);
        await settle(10);
        // Signed out while the worker's cancel was on its way.
        open = false;
        generation = 2;
        release();
        await cancelling;
        await settle(500);
        expect(h.item(id!).status).toBe('cancelled');
        expect(h.server.aborted).toEqual([]);
    });

    test('this tab’s own sign-out (session shut first, then forgetAll) still lets every reservation go (review probe)', async () => {
        let open = true;
        let generation = 1;
        const h = harness({ session: { open: () => open, generation: () => generation } });
        h.manager.enqueue([{ file: fakeFile(4 * CHUNK), parent: node('root', null) }], {
            generation: 1,
        });
        await settle(120);
        expect(h.server.begins).toHaveLength(1);
        // apps/web/src/lib/sign-out.ts: deviceSession.signedOut() first, then transfers.forgetAll().
        open = false;
        generation = 2;
        await h.manager.forgetAll();
        await settle(200);
        expect(h.server.aborted).toHaveLength(1);
    });

    test('a batch takes its key epochs in one range, one round trip for the lot', async () => {
        const h = harness();
        const ids = h.manager.enqueue([
            { file: fakeFile(CHUNK), parent: node('root', null) },
            { file: fakeFile(CHUNK), parent: node('root', null) },
            { file: fakeFile(CHUNK), parent: node('root', null) },
        ]);
        await settle(1_000);
        expect(ids.map((id) => h.item(id).status)).toEqual(['done', 'done', 'done']);
        expect(h.server.epochs).toEqual([3]);
        // Each file still got an epoch of its own out of the range.
        expect(new Set(h.givenEpochs).size).toBe(3);
    });

    test('files start two at a time; the third waits its turn', async () => {
        const h = harness();
        const ids = h.manager.enqueue([
            { file: fakeFile(CHUNK), parent: node('root', null) },
            { file: fakeFile(CHUNK), parent: node('root', null) },
            { file: fakeFile(CHUNK), parent: node('root', null) },
        ]);
        await settle(0);
        expect(ids.slice(0, 2).map((id) => h.item(id).status)).not.toContain('queued');
        expect(h.item(ids[2]!).status).toBe('queued');
        await settle(1_000);
        expect(ids.map((id) => h.item(id).status)).toEqual(['done', 'done', 'done']);
    });
});

describe('journal and restore', () => {
    /* Runs an upload half way, then builds a second manager on the same journal, as a reload would. */
    async function interrupted() {
        const first = harness();
        const [id] = first.manager.enqueue([
            { file: fakeFile(6 * CHUNK, 'movie.mp4'), parent: node('root', null) },
        ]);
        await settle(150);
        await first.manager.pause(id!);
        await settle(100);
        const landed = first.item(id!).partsDone;
        expect(landed).toBeGreaterThan(0);
        expect(landed).toBeLessThan(6);
        const entry = first.journal.entries.get(id!)!;
        expect(Object.values(entry.parts).filter((part) => part.etag)).toHaveLength(landed);
        const second = harness({ journal: first.journal });
        second.server.uploads = first.server.uploads;
        return { id: id!, landed, second, entry };
    }

    test('a journaled upload comes back paused and continues once the same file is attached', async () => {
        const { id, landed, second } = await interrupted();
        const [restored] = await second.manager.restore('ws');
        expect(restored).toBe(id);
        expect(second.item(id).status).toBe('paused');
        expect(second.item(id).needsFile).toBe(true);
        expect(second.item(id).partsDone).toBe(landed);
        const result = await second.manager.attachFile(id, fakeFile(6 * CHUNK, 'movie.mp4'));
        expect(result).toEqual({ ok: true, resumed: true });
        await settle(2_000);
        expect(second.item(id).status).toBe('done');
        // The keys were reopened, never re-minted, and the landed parts were not re-sent.
        expect(second.calls).toContain('driveUploadReopen');
        expect(second.calls).not.toContain('driveUploadPrepare');
        expect(second.calls.filter((c) => c === 'driveUploadSend')).toHaveLength(6 - landed);
        expect(second.server.completed).toEqual([{ id: 'up-1', parts: [1, 2, 3, 4, 5, 6] }]);
        expect(second.journal.entries.size).toBe(0);
    });

    test('an upload the server finished while the page was away is published, never sent or begun again', async () => {
        const { id, second } = await interrupted();
        // The complete request got through after the page went: the server holds it finished.
        second.server.uploads.get('up-1')!.status = 'completed';
        const minted = [...second.journal.entries.values()][0]!.versionId;
        await second.manager.restore('ws');
        const result = await second.manager.attachFile(id, fakeFile(6 * CHUNK, 'movie.mp4'));
        expect(result).toEqual({ ok: true, resumed: true });
        await settle(500);
        expect(second.item(id).status).toBe('done');
        // No node came back, but the version it published is still named, by the id it was minted with.
        expect(second.item(id).node).toBeNull();
        expect(minted).toBeTruthy();
        expect(second.item(id).versionId).toBe(minted);
        expect(second.calls.filter((c) => c === 'driveUploadSend')).toHaveLength(0);
        expect(second.server.aborted).toEqual([]);
        expect(second.server.uploads.size).toBe(1);
        expect(second.journal.entries.size).toBe(0);
    });

    test('an upload the server is still finishing fails with a retry, instead of a duplicate', async () => {
        const { id, second } = await interrupted();
        second.server.uploads.get('up-1')!.status = 'completing';
        await second.manager.restore('ws');
        await second.manager.attachFile(id, fakeFile(6 * CHUNK, 'movie.mp4'));
        await settle(500);
        expect(second.item(id).status).toBe('failed');
        expect(second.server.uploads.size).toBe(1);
        expect(second.journal.entries.size).toBe(1);
        // Once the server is done, retry publishes it without a byte sent.
        second.server.uploads.get('up-1')!.status = 'completed';
        await second.manager.retry(id);
        await settle(500);
        expect(second.item(id).status).toBe('done');
        expect(second.calls.filter((c) => c === 'driveUploadSend')).toHaveLength(0);
        expect(second.server.uploads.size).toBe(1);
    });

    test('a different file starts over with a fresh object instead of continuing', async () => {
        const { id, second } = await interrupted();
        await second.manager.restore('ws');
        // Same size, different name: identity fails, so nothing is re-encrypted under the old key.
        const swapped = await second.manager.attachFile(id, fakeFile(6 * CHUNK, 'other.mp4'));
        expect(swapped).toEqual({ ok: true, resumed: false });
        await settle(2_000);
        expect(second.item(id).status).toBe('done');
        expect(second.server.aborted).toContain('up-1');
        expect(second.calls).toContain('driveUploadPrepare');
        expect(second.server.completed.at(-1)!.parts).toEqual([1, 2, 3, 4, 5, 6]);
    });

    test('every new id goes to begin with the seed that derives it there; starting over mints new ones', async () => {
        const { id, second, entry } = await interrupted();
        // Nothing has begun on the reloaded side yet.
        expect(second.server.begins).toEqual([]);
        // The journal kept the seeds the first begin sent, beside the ids they derive.
        expect(entry.idSeeds).toBeDefined();
        expect(scopedId('node', 'ws', entry.idSeeds!.node!)).toBe(entry.nodeId);
        expect(scopedId('version', 'ws', entry.idSeeds!.version)).toBe(entry.versionId);
        expect(scopedId('object', 'ws', entry.idSeeds!.object)).toBe(entry.objectId);
        await second.manager.restore('ws');
        await second.manager.attachFile(id, fakeFile(6 * CHUNK, 'other.mp4'));
        await settle(2_000);
        const [again] = second.server.begins;
        expect(again).toBeDefined();
        if (again!.node.existing) throw new Error('a new file begins a new node');
        expect(scopedId('node', 'ws', again!.node.idSeed)).toBe(again!.node.id);
        expect(scopedId('version', 'ws', again!.versionIdSeed)).toBe(again!.versionId);
        expect(scopedId('object', 'ws', again!.objectIdSeed)).toBe(again!.objectId);
        // Fresh material for a fresh object: none of the abandoned ids or seeds comes back.
        expect(again!.node.id).not.toBe(entry.nodeId);
        expect(again!.objectId).not.toBe(entry.objectId);
        expect(again!.versionIdSeed).not.toBe(entry.idSeeds!.version);
    });

    test('a file with the same identity but different bytes also starts over', async () => {
        const { id, second, entry } = await interrupted();
        // Forge the journal so a landed chunk's digest no longer matches the file's bytes.
        const landedPart = Object.entries(entry.parts).find(([, part]) => part.etag)![0];
        second.journal.entries.set(id, {
            ...entry,
            parts: {
                ...entry.parts,
                [landedPart]: { ...entry.parts[landedPart]!, digest: 'stale' },
            },
        });
        await second.manager.restore('ws');
        const result = await second.manager.attachFile(id, fakeFile(6 * CHUNK, 'movie.mp4'));
        expect(result).toEqual({ ok: true, resumed: false });
        expect(second.calls).toContain('driveUploadDigest');
        expect(second.server.aborted).toContain('up-1');
    });

    test('a part sent without an answer must match too: the store may hold it under the same nonce', async () => {
        const { id, second, entry } = await interrupted();
        // A part whose digest was journaled before its send, with no etag back: changed bytes there.
        const landed = Object.keys(entry.parts).map(Number);
        const unanswered = String(Math.max(...landed) + 1);
        second.journal.entries.set(id, {
            ...entry,
            parts: { ...entry.parts, [unanswered]: { digest: 'stale' } },
        });
        await second.manager.restore('ws');
        const result = await second.manager.attachFile(id, fakeFile(6 * CHUNK, 'movie.mp4'));
        expect(result).toEqual({ ok: true, resumed: false });
        expect(second.server.aborted).toContain('up-1');
    });

    test('an expired journal entry is discarded and the server told', async () => {
        const { id, second, entry } = await interrupted();
        second.journal.entries.set(id, {
            ...entry,
            expiresAt: new Date(Date.now() - 1).toISOString(),
        });
        const restored = await second.manager.restore('ws');
        expect(restored).toEqual([]);
        expect(second.server.aborted).toEqual(['up-1']);
        expect(second.journal.entries.size).toBe(0);
    });

    test('a lock pauses everything and resume reopens from the journal', async () => {
        let lockedOnce = false;
        const h = harness({
            send: async (_objectId, index) => {
                await new Promise((resolve) => setTimeout(resolve, 50));
                if (index === 2 && !lockedOnce) {
                    lockedOnce = true;
                    throw new Error('Your account was locked. Please try again.');
                }
                return { ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 };
            },
        });
        const [id] = h.manager.enqueue([{ file: fakeFile(4 * CHUNK), parent: node('root', null) }]);
        await settle(300);
        expect(h.item(id!).status).toBe('paused');
        expect(h.item(id!).error).toMatch(/unlock/i);
        expect(h.server.aborted).toHaveLength(0);
        const sendsBefore = h.calls.filter((c) => c === 'driveUploadSend').length;
        await h.manager.resume(id!);
        await settle(2_000);
        expect(h.calls).toContain('driveUploadReopen');
        expect(h.item(id!).status).toBe('done');
        expect(
            h.calls.filter((c) => c === 'driveUploadSend').length - sendsBefore,
        ).toBeLessThanOrEqual(2);
    });
    test('a conflict at complete attaches the finished object as a conflict copy instead of re-uploading', async () => {
        const h = harness({ conflict: true });
        const [id] = h.manager.enqueue([
            { file: fakeFile(2 * CHUNK, 'report.pdf'), parent: node('root', null) },
        ]);
        await settle(5_000);
        const item = h.item(id!);
        expect(item.error).toBeNull();
        expect(item.status).toBe('done');
        expect(item.name).toBe('report (conflict copy).pdf');
        expect(h.server.attached).toHaveLength(1);
        const attach = h.server.attached[0]!.input as {
            mode: string;
            node: { id: string; parentId: string };
            contentKeyEnvelope: string;
        };
        expect(attach.mode).toBe('sibling');
        expect(attach.node.parentId).toBe('root');
        expect(attach.contentKeyEnvelope).toBe(`rewrapped-under-${attach.node.id}`);
        expect(h.published).toEqual([attach.node.id]);
        // Nothing was sent twice, nothing aborted, and the journal row is gone.
        expect(h.calls.filter((call) => call === 'driveUploadSend')).toHaveLength(2);
        expect(h.server.aborted).toEqual([]);
        expect(h.journal.entries.size).toBe(0);
    });

    test('an attach after a conflict waits for a key change that landed meanwhile, then writes', async () => {
        // The key change lands while the upload is in flight: its conflict copy would be wrapped
        // under the folder's old key, so the attach waits like any upload.
        let target: number | null = null;
        const epochs = new Map([['waiting', 1]]);
        const at = (id: string) => ({ ...node(id, 'root'), keyEpoch: epochs.get(id) ?? 9 });
        const h = harness({
            conflict: true,
            refuseWrite: (t) =>
                target !== null && t.keyEpoch < target ? 'Finishing a key change.' : null,
            waitsForKeyChange: (t) => target !== null && t.keyEpoch < target,
            openNodes: async (entry) => ({ parent: at(entry.parentId) }),
        });
        const api = h.api as unknown as DriveApi;
        const complete = api.completeUpload.bind(api);
        api.completeUpload = (async (...args: Parameters<typeof complete>) => {
            target = 5;
            return complete(...args);
        }) as typeof complete;
        const [id] = h.manager.enqueue([{ file: fakeFile(2 * CHUNK), parent: at('waiting') }]);
        await settle(5_000);
        expect(h.item(id!)).toMatchObject({ waitingFor: 'Finishing a key change.' });
        expect(h.server.attached).toEqual([]);
        // The walk reaches the folder: the conflict copy goes under its new key.
        epochs.set('waiting', 5);
        await settle(5_000);
        expect(h.item(id!)).toMatchObject({ status: 'done', waitingFor: null });
        expect(h.server.attached).toHaveLength(1);
    });

    test('a waiting upload can be cancelled, and nothing is made for it', async () => {
        const h = harness({
            refuseWrite: () => 'Finishing a key change.',
            waitsForKeyChange: () => true,
            openNodes: async (entry) => ({
                parent: { ...node(entry.parentId, 'root'), keyEpoch: 1 },
            }),
        });
        const [id] = h.manager.enqueue([
            { file: fakeFile(CHUNK), parent: { ...node('waiting', 'root'), keyEpoch: 1 } },
        ]);
        await settle(3_000);
        expect(h.item(id!).waitingFor).toBe('Finishing a key change.');
        await h.manager.cancel(id!);
        await settle(5_000);
        expect(h.item(id!).status).toBe('cancelled');
        for (const operation of ['driveCreateNodes', 'driveUploadPrepare'])
            expect(h.calls).not.toContain(operation);
    });

    test('a key change’s re-look answered with another folder never becomes the destination', async () => {
        for (const other of [
            { ...node('elsewhere', 'root'), keyEpoch: 2 },
            { ...node('waiting', 'root'), workspaceId: 'ws-other', keyEpoch: 2 },
        ]) {
            const h = harness({
                refuseWrite: (t) => (t.keyEpoch < 2 ? 'Finishing a key change.' : null),
                waitsForKeyChange: () => true,
                // The server answers the re-listing of the folder with another one the device can open.
                openNodes: async () => ({ parent: other }),
            });
            const [id] = h.manager.enqueue([
                { file: fakeFile(CHUNK), parent: { ...node('waiting', 'root'), keyEpoch: 1 } },
            ]);
            await settle(5_000);
            expect(h.item(id!).status).toBe('failed');
            expect(h.item(id!).error).toBe(DESTINATION_CHANGED);
            for (const operation of ['driveCreateNodes', 'driveUploadPrepare'])
                expect(h.calls).not.toContain(operation);
            expect(h.server.begins).toEqual([]);
        }
    });

    test('a refusal for lack of room fails the upload with the code the app needs to offer a way out', async () => {
        const h = harness({});
        const begin = h.api.beginUpload;
        h.api.beginUpload = async () => {
            throw new DriveApiError('Not enough storage for this file.', 'over-quota', 402, {
                freeBytes: '0',
            });
        };
        const [id] = h.manager.enqueue([{ file: fakeFile(CHUNK), parent: node('root', null) }]);
        await settle(1_000);
        const item = h.item(id!);
        expect(item.status).toBe('failed');
        expect(item.errorCode).toBe('over-quota');
        expect(item.error).toMatch(/Not enough storage/);
        // Room found: a retry starts over and goes through.
        h.api.beginUpload = begin;
        await h.manager.retry(id!);
        await settle(3_000);
        expect(h.item(id!).status).toBe('done');
        expect(h.item(id!).errorCode).toBeNull();
    });
});

/*
 * A landed part's etag goes into the journal in the background. A write that fails must not
 * become an unhandled rejection. It is tried once more; if the journal still refuses, the row
 * stays as it is, upload id and all: a reload resumes the same upload and sends that part again,
 * checked against its journaled digest, instead of leaving the server's upload open (holding
 * quota and a pending node) while a fresh one reserves the size again.
 */
describe('a journal that refuses a landed part', () => {
    /* A memory journal whose writes of an etag for `part` fail `times` times. */
    function refusingJournal(part: number, times: number) {
        const journal = createMemoryJournal();
        const update = journal.update.bind(journal);
        let refused = 0;
        journal.update = async (id, patch) => {
            const current = journal.entries.get(id);
            if (
                current &&
                patch(current).parts[part]?.etag &&
                !current.parts[part]?.etag &&
                refused < times
            ) {
                refused++;
                throw new DOMException('The transaction was aborted.', 'AbortError');
            }
            return update(id, patch);
        };
        return { journal, refused: () => refused };
    }

    test('is written on the second try, and the upload resumes after a reload as usual', async () => {
        const { journal, refused } = refusingJournal(1, 1);
        const first = harness({ journal });
        const [id] = first.manager.enqueue([
            { file: fakeFile(6 * CHUNK, 'movie.mp4'), parent: node('root', null) },
        ]);
        await settle(150);
        await first.manager.pause(id!);
        await settle(100);
        expect(refused()).toBe(1);
        const landed = first.item(id!).partsDone;
        expect(landed).toBeGreaterThan(0);
        const entry = journal.entries.get(id!)!;
        expect(entry.parts[1]?.etag).toBeDefined();
        expect(Object.values(entry.parts).filter((part) => part.etag)).toHaveLength(landed);

        const second = harness({ journal });
        second.server.uploads = first.server.uploads;
        await second.manager.restore('ws');
        expect(second.item(id!).partsDone).toBe(landed);
    });

    test('refused twice, keeps the row: a reload resumes the same upload, sends that part again, and leaves nothing open', async () => {
        const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { journal, refused } = refusingJournal(1, 2);
        const first = harness({ journal });
        const [id] = first.manager.enqueue([
            { file: fakeFile(6 * CHUNK, 'movie.mp4'), parent: node('root', null) },
        ]);
        await settle(150);
        await first.manager.pause(id!);
        await settle(100);
        expect(refused()).toBe(2);
        expect(warned).toHaveBeenCalledTimes(1);
        const landed = first.item(id!).partsDone;
        expect(landed).toBeGreaterThan(1);
        // The row is kept with its upload id; only part 1's etag is missing from it.
        const entry = journal.entries.get(id!)!;
        expect(entry.uploadId).toBe('up-1');
        expect(entry.parts[1]?.digest).toBeDefined();
        expect(entry.parts[1]?.etag).toBeUndefined();

        const second = harness({ journal });
        second.server.uploads = first.server.uploads;
        await second.manager.restore('ws');
        const result = await second.manager.attachFile(id!, fakeFile(6 * CHUNK, 'movie.mp4'));
        expect(result).toEqual({ ok: true, resumed: true });
        await settle(2_000);
        expect(second.item(id!).status).toBe('done');
        // The same upload, finished: part 1 sent again beside the ones that never landed, no
        // second upload begun, nothing aborted, nothing left open on the server.
        expect(second.calls).toContain('driveUploadReopen');
        expect(second.calls).not.toContain('driveUploadPrepare');
        expect(second.calls.filter((c) => c === 'driveUploadSend')).toHaveLength(6 - landed + 1);
        expect(second.server.completed).toEqual([{ id: 'up-1', parts: [1, 2, 3, 4, 5, 6] }]);
        expect([...second.server.uploads.keys()]).toEqual(['up-1']);
        expect(second.server.aborted).toEqual([]);
        expect(journal.entries.size).toBe(0);
    });

    test('refused twice, the upload still finishes in this page', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { journal } = refusingJournal(1, 2);
        const h = harness({ journal });
        const [id] = h.manager.enqueue([
            { file: fakeFile(6 * CHUNK, 'movie.mp4'), parent: node('root', null) },
        ]);
        await settle(2_000);
        expect(h.item(id!).status).toBe('done');
        expect(h.server.completed.at(-1)?.parts).toEqual([1, 2, 3, 4, 5, 6]);
        expect(journal.entries.size).toBe(0);
    });
});

describe('a key change the server says nothing of (design 2.10, F14)', () => {
    test('the worker refusing the folder’s old key is waited out like a 409, and the upload lands under the new key', async () => {
        // The server serves the folder under its old key and refuses nothing; only the worker,
        // whose member list says the folder's key changed, will not seal under it.
        const folder = { epoch: 1 };
        const pauses: number[] = [];
        const h = harness({
            openNodes: async () => ({
                parent: { ...node('trips', 'root'), keyEpoch: folder.epoch },
            }),
            keyChangePause: async (_target, attempt) => {
                pauses.push(attempt);
                await new Promise((resolve) => setTimeout(resolve, 1_000));
            },
            keyChangePendingAt: (parentKeyEpoch) => parentKeyEpoch < 5,
        });
        const [id] = h.manager.enqueue([
            { file: fakeFile(CHUNK), parent: { ...node('trips', 'root'), keyEpoch: 1 } },
        ]);
        await settle(3_000);
        // Waiting, never failed, and nothing begun under the old key.
        expect(h.item(id!)).toMatchObject({ status: 'preparing', error: null });
        expect(h.item(id!).waitingFor).toBe(KEY_CHANGE_PENDING);
        expect(h.server.begins).toHaveLength(0);
        // The walk re-keys the folder: the next look finds the new key, and it lands under it.
        folder.epoch = 5;
        await settle(5_000);
        expect(h.item(id!)).toMatchObject({ status: 'done', error: null, waitingFor: null });
        expect(h.server.begins).toHaveLength(1);
        expect(h.server.begins[0]!.node).toMatchObject({
            parentKeyEpoch: 5,
            keyEnvelope: 'ke-under-5',
        });
        expect(pauses.length).toBeGreaterThan(0);
    });
});

describe('a key change this device has not heard of (409 rotating)', () => {
    /*
     * A family folder, "trips", and the server's side of a key change walking
     * it, judged as packages/db's beginUpload and attachUpload judge them: a new
     * node there is refused as `rotating` while the walk has not reached the
     * folder (its key epoch below the target), and as `stale` when its key is
     * wrapped under any epoch but the folder's own. The app's own view
     * (refuseWrite) never hears of the change: it started a moment after the
     * file was queued, so only the server's answer says to wait.
     */
    function family(
        options: Parameters<typeof harness>[0] & {
            /* At this look, the walk finishes right after the folder was listed under its old key. */
            raceAtLook?: number;
        } = {},
    ) {
        const { raceAtLook, ...rest } = options;
        // The folder, and a file in it, as the server holds them; the walk re-keys both.
        const folder = { epoch: 1, target: null as number | null, file: 1, version: 'v1' };
        const at = () => ({ ...node('trips', 'root'), keyEpoch: folder.epoch });
        const file = () => ({
            ...node('old', 'trips'),
            kind: 'file' as const,
            keyEpoch: folder.file,
            currentVersion: { id: folder.version } as DriveNode['currentVersion'],
        });
        const pauses: number[] = [];
        let looks = 0;
        const walked = () => {
            folder.epoch = folder.target ?? folder.epoch;
            folder.file = folder.target ?? folder.file;
            folder.target = null;
        };
        const h = harness({
            // The folder (and the file replaced) as the server lists them now.
            openNodes: async (entry) => {
                const listed = {
                    parent: at(),
                    ...('replacesId' in entry && entry.replacesId ? { replaces: file() } : {}),
                };
                if (++looks === raceAtLook) walked();
                return listed;
            },
            // The app's pause: a sync of the family, a second here.
            keyChangePause: async (_target, attempt) => {
                pauses.push(attempt);
                await new Promise((resolve) => setTimeout(resolve, 1_000));
            },
            ...rest,
        });
        const rotating = () =>
            new DriveApiError(
                'Keys are being rotated for this folder. Try again in a moment.',
                'rotating',
                409,
            );
        const stale = () =>
            new DriveApiError(
                'This item changed since you last saw it. Refresh and try again.',
                'stale',
                409,
            );
        const walking = (epoch: number) => folder.target !== null && epoch < folder.target;
        // As packages/db judges a node in trips: `rotating` first, then `stale`.
        const judge = (parentKeyEpoch: number) => {
            if (walking(folder.epoch)) throw rotating();
            if (parentKeyEpoch !== folder.epoch) throw stale();
        };
        /* Every begin sent, refused ones included. */
        const tried: Parameters<DriveApi['beginUpload']>[1][] = [];
        const api = h.api as unknown as DriveApi;
        const begin = api.beginUpload.bind(api);
        api.beginUpload = (async (ws, input) => {
            tried.push(input);
            if (input.node.existing) {
                if (walking(folder.file)) throw rotating();
                if (input.node.keyEpoch !== folder.file) throw stale();
                if (input.node.expectedVersionId !== folder.version) throw stale();
            } else if (input.node.parentId === 'trips') judge(input.node.parentKeyEpoch);
            return begin(ws, input);
        }) as typeof begin;
        const attach = api.attachUpload.bind(api);
        api.attachUpload = (async (ws, id, input) => {
            if (input.mode === 'sibling' && input.node.parentId === 'trips')
                judge(input.node.parentKeyEpoch);
            return attach(ws, id, input);
        }) as typeof attach;
        return {
            ...h,
            api,
            at,
            file,
            folder,
            pauses,
            tried,
            // The key change starts: the folder keeps its old key until the walk reaches it.
            start: (target: number) => {
                folder.target = target;
            },
            // The walk re-keys the folder (and the file) and the run ends.
            walked,
        };
    }

    test('a refused begin waits, says so, and lands by itself once the walk is done, sealed afresh under the folder’s new key', async () => {
        const f = family();
        const [id] = f.manager.enqueue([{ file: fakeFile(CHUNK), parent: f.at() }]);
        f.start(5);
        await settle(500);
        // Refused once, under the old key: it waits rather than failing, and holds no slot.
        expect(f.tried).toHaveLength(1);
        expect(f.tried[0]!.node).toMatchObject({ parentKeyEpoch: 1 });
        expect(f.item(id!)).toMatchObject({ status: 'preparing', error: null });
        expect(f.item(id!).waitingFor).toBeTruthy();
        expect(f.state().active).toBe(0);
        // Still walking: refused again at each look, never failed, nothing reserved.
        await settle(5_000);
        expect(f.item(id!).status).toBe('preparing');
        expect(f.server.uploads.size).toBe(0);
        // The walk reaches the folder: nobody presses anything, and it lands.
        f.walked();
        await settle(5_000);
        expect(f.item(id!)).toMatchObject({ status: 'done', error: null, waitingFor: null });
        expect(f.server.begins).toHaveLength(1);
        const landed = f.server.begins[0]!;
        // The node's key wrapped under the folder's new key, and a content key never sent before.
        expect(landed.node).toMatchObject({
            existing: false,
            parentKeyEpoch: 5,
            keyEnvelope: 'ke-under-5',
        });
        const refused = f.tried.slice(0, -1).map((input) => input.contentKeyEnvelope);
        expect(refused).not.toContain(landed.contentKeyEnvelope);
        expect(f.pauses[0]).toBe(1);
    });

    test('a refused attach waits the same way, then attaches the sent bytes under the folder’s new key', async () => {
        const f = family({ conflict: true });
        // The key change lands while the bytes are in flight: completing finds the node moved on.
        const complete = f.api.completeUpload.bind(f.api);
        f.api.completeUpload = (async (...args: Parameters<typeof complete>) => {
            f.start(5);
            return complete(...args);
        }) as typeof complete;
        const [id] = f.manager.enqueue([{ file: fakeFile(2 * CHUNK), parent: f.at() }]);
        await settle(3_000);
        expect(f.item(id!)).toMatchObject({ status: 'completing', error: null });
        expect(f.item(id!).waitingFor).toBeTruthy();
        expect(f.state().active).toBe(0);
        expect(f.server.attached).toEqual([]);
        f.walked();
        await settle(5_000);
        expect(f.item(id!)).toMatchObject({ status: 'done', error: null, waitingFor: null });
        expect(f.server.attached).toHaveLength(1);
        const attached = f.server.attached[0]!.input as {
            mode: string;
            node: { id: string; parentKeyEpoch: number; keyEnvelope: string };
            contentKeyEnvelope: string;
        };
        expect(attached.mode).toBe('sibling');
        expect(attached.node).toMatchObject({ parentKeyEpoch: 5, keyEnvelope: 'ke-under-5' });
        expect(attached.contentKeyEnvelope).toBe(`rewrapped-under-${attached.node.id}`);
        // Attaching never sends the bytes again.
        expect(f.calls.filter((call) => call === 'driveUploadSend')).toHaveLength(2);
    });

    test('a retry after a key change looks the folder up again and seals afresh, never resending the old envelopes', async () => {
        const f = family();
        const begin = f.api.beginUpload.bind(f.api);
        let reachable = false;
        f.api.beginUpload = (async (...args: Parameters<typeof begin>) => {
            if (!reachable) throw new Error('Failed to fetch');
            return begin(...args);
        }) as typeof begin;
        const [id] = f.manager.enqueue([{ file: fakeFile(CHUNK), parent: f.at() }]);
        await settle(1_000);
        expect(f.item(id!).status).toBe('failed');
        // Meanwhile a key change re-keyed the folder and finished: nothing on this device says so.
        f.start(5);
        f.walked();
        reachable = true;
        await f.manager.retry(id!);
        await settle(3_000);
        expect(f.item(id!)).toMatchObject({ status: 'done', error: null });
        expect(f.server.begins.at(-1)!.node).toMatchObject({
            parentKeyEpoch: 5,
            keyEnvelope: 'ke-under-5',
        });
    });

    test('a key change that never finishes gives up after the wait, cleanly; once it is done a retry lands', async () => {
        const pauses: number[] = [];
        const f = family({
            keyChangeGiveUpMs: 60_000,
            // An app whose pause never returns (a sync that hangs) must not hold the upload forever.
            keyChangePause: (_target, attempt) => {
                pauses.push(attempt);
                return new Promise(() => {});
            },
        });
        f.start(5);
        const [id] = f.manager.enqueue([{ file: fakeFile(CHUNK), parent: f.at() }]);
        await settle(30_000);
        expect(f.item(id!).status).toBe('preparing');
        expect(f.item(id!).waitingFor).toBeTruthy();
        await settle(31_000);
        expect(f.item(id!)).toMatchObject({
            status: 'failed',
            error: KEY_CHANGE_GAVE_UP,
            waitingFor: null,
        });
        // Nothing reserved on the server, and nothing tries again by itself.
        expect(f.server.uploads.size).toBe(0);
        const tried = f.tried.length;
        await settle(10 * 60_000);
        expect(f.tried).toHaveLength(tried);
        expect(pauses).toEqual([1]);
        // The walk ends after all: Retry seals afresh under the new key and lands.
        f.walked();
        await f.manager.retry(id!);
        await settle(3_000);
        expect(f.item(id!)).toMatchObject({ status: 'done', error: null });
        expect(f.server.begins.at(-1)!.node).toMatchObject({ parentKeyEpoch: 5 });
    });

    test('a walk that reaches the folder between the look and the begin answers stale: looked at again, it still lands', async () => {
        // The first look after the refusal lists the folder under its old key, and the walk ends
        // right then: the begin sealed from that look is `stale`, not `rotating`.
        const f = family({ raceAtLook: 1 });
        const [id] = f.manager.enqueue([{ file: fakeFile(CHUNK), parent: f.at() }]);
        f.start(5);
        await settle(10_000);
        expect(f.item(id!)).toMatchObject({ status: 'done', error: null, waitingFor: null });
        expect(
            f.tried.map((input) => (input.node as { parentKeyEpoch: number }).parentKeyEpoch),
        ).toEqual([1, 1, 5]);
        expect(f.server.begins.at(-1)!.node).toMatchObject({ keyEnvelope: 'ke-under-5' });
    });

    test('the same race at attach answers stale too, and the attach is looked at again and lands', async () => {
        // Attach looks first under the old key (refused, rotating); its second look races the walk.
        const f = family({ conflict: true, raceAtLook: 2 });
        const complete = f.api.completeUpload.bind(f.api);
        f.api.completeUpload = (async (...args: Parameters<typeof complete>) => {
            f.start(5);
            return complete(...args);
        }) as typeof complete;
        const [id] = f.manager.enqueue([{ file: fakeFile(2 * CHUNK), parent: f.at() }]);
        await settle(10_000);
        expect(f.item(id!)).toMatchObject({ status: 'done', error: null, waitingFor: null });
        expect(f.server.attached).toHaveLength(1);
        expect((f.server.attached[0]!.input as { node: unknown }).node).toMatchObject({
            parentKeyEpoch: 5,
            keyEnvelope: 'ke-under-5',
        });
    });

    test('a stale answer before any wait is not a key change: it fails as before', async () => {
        const f = family();
        const [id] = f.manager.enqueue([{ file: fakeFile(CHUNK), parent: f.at() }]);
        // Re-keyed and finished before the upload began, unseen: nothing said to wait, so `stale`
        // is the server's last word, as for any upload outside a family folder.
        f.start(5);
        f.walked();
        await settle(3_000);
        expect(f.item(id!)).toMatchObject({ status: 'failed', errorCode: 'stale' });
        expect(f.tried).toHaveLength(1);
    });

    test('an upload discarded while it waits is gone for good: its wait ends without failing it or sending anything', async () => {
        const events: string[] = [];
        const f = family({
            keyChangeGiveUpMs: 60_000,
            // The give-up is what would fire later: a pause that never returns.
            keyChangePause: () => new Promise(() => {}),
            onEvent: (event) => events.push(`${event.type}:${event.item.id}`),
        });
        f.start(5);
        const [id] = f.manager.enqueue([{ file: fakeFile(CHUNK), parent: f.at() }]);
        await settle(1_000);
        expect(f.item(id!).waitingFor).toBeTruthy();
        await f.manager.pause(id!);
        await f.manager.discard(id!);
        const tried = f.tried.length;
        await settle(5 * 60_000);
        expect(f.state().uploads).toEqual([]);
        expect(events.filter((event) => event.startsWith('failed'))).toEqual([]);
        expect(f.tried).toHaveLength(tried);
        // Discarded while its begin is on the wire, which then fails: nothing answers for it.
        const begin = f.api.beginUpload.bind(f.api);
        f.api.beginUpload = (async () => {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            throw new DriveApiError('Not enough storage for this file.', 'over-quota', 402);
        }) as typeof begin;
        f.walked();
        const [other] = f.manager.enqueue([{ file: fakeFile(CHUNK), parent: f.at() }]);
        await settle(100);
        await f.manager.pause(other!);
        await f.manager.discard(other!);
        await settle(5_000);
        expect(f.state().uploads).toEqual([]);
        expect(events.filter((event) => event.startsWith('failed'))).toEqual([]);
    });

    test('uploads leaving a key-change wait take a slot to seal again, so no more than two run at once', async () => {
        // Sends that take a while, and a begin that takes half a second: a slot held is visible.
        let beginning = 0;
        let most = 0;
        const f = family({
            send: (_objectId, index) =>
                new Promise((resolve) =>
                    setTimeout(
                        () => resolve({ ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 }),
                        10_000,
                    ),
                ),
        });
        const begin = f.api.beginUpload.bind(f.api);
        f.api.beginUpload = (async (...args: Parameters<typeof begin>) => {
            beginning++;
            const uploading = f.state().uploads.filter((u) => u.status === 'uploading').length;
            most = Math.max(most, beginning + uploading);
            try {
                await new Promise((resolve) => setTimeout(resolve, 500));
                return await begin(...args);
            } finally {
                beginning--;
            }
        }) as typeof begin;
        f.start(5);
        const waiting = f.manager.enqueue(
            [1, 2, 3].map((n) => ({ file: fakeFile(CHUNK, `trip-${n}.bin`), parent: f.at() })),
        );
        await settle(2_000);
        // Waiting, they hold no slot: two uploads elsewhere start at once.
        const elsewhere = f.manager.enqueue(
            [1, 2].map((n) => ({
                file: fakeFile(CHUNK, `home-${n}.bin`),
                parent: node('root', null),
            })),
        );
        await settle(2_000);
        expect(elsewhere.map((id) => f.item(id).status)).toEqual(['uploading', 'uploading']);
        f.walked();
        await settle(60_000);
        for (const id of [...waiting, ...elsewhere]) expect(f.item(id).status).toBe('done');
        expect(most).toBeLessThanOrEqual(2);
    });

    test('a new version refused for a key change waits too, and lands under the file’s new key; one overtaken meanwhile is never overwritten', async () => {
        const f = family();
        const [id] = f.manager.enqueue([
            { file: fakeFile(CHUNK, 'old'), parent: f.at(), replaces: f.file() },
        ]);
        f.start(5);
        await settle(3_000);
        expect(f.item(id!).status).toBe('preparing');
        expect(f.item(id!).waitingFor).toBeTruthy();
        expect(f.tried[0]!.node).toMatchObject({ existing: true, keyEpoch: 1 });
        f.walked();
        await settle(5_000);
        expect(f.item(id!)).toMatchObject({ status: 'done', error: null });
        expect(f.server.begins.at(-1)!.node).toMatchObject({
            existing: true,
            id: 'old',
            keyEpoch: 5,
            expectedVersionId: 'v1',
        });
        // Again, but someone else's version becomes current while this one waits.
        const g = family();
        const [late] = g.manager.enqueue([
            { file: fakeFile(CHUNK, 'old'), parent: g.at(), replaces: g.file() },
        ]);
        g.start(5);
        await settle(3_000);
        g.folder.version = 'v2';
        g.walked();
        await settle(5_000);
        expect(g.item(late!)).toMatchObject({ status: 'failed', error: VERSION_MOVED });
        expect(g.server.begins).toEqual([]);
    });
});

describe('queued rows and stashed copies', () => {
    test('files still waiting when the page went away come back and start once their file is attached', async () => {
        const first = harness();
        const ids = first.manager.enqueue([
            { file: fakeFile(CHUNK, 'a.bin'), parent: node('root', null) },
            { file: fakeFile(CHUNK, 'b.bin'), parent: node('root', null) },
            { file: fakeFile(CHUNK, 'c.bin'), parent: node('root', null) },
        ]);
        await settle(10);
        // Two began (the active-file limit); the third only ever reached its queued row.
        expect(first.item(ids[2]!).status).toBe('queued');
        expect(first.journal.queued.size).toBe(3);
        expect(first.journal.entries.has(ids[2]!)).toBe(false);
        const second = harness({ journal: first.journal });
        second.server.uploads = first.server.uploads;
        const restored = await second.manager.restore('ws');
        expect(restored).toHaveLength(3);
        const third = second.item(ids[2]!);
        expect(third.status).toBe('paused');
        expect(third.needsFile).toBe(true);
        expect(third.partsDone).toBe(0);
        // Not the file that was waiting: refused, and nothing is sent under its name.
        expect(await second.manager.attachFile(ids[2]!, fakeFile(CHUNK, 'other.bin'))).toEqual({
            ok: false,
            reason: 'different',
        });
        expect(second.item(ids[2]!).status).toBe('paused');
        expect(second.calls).not.toContain('driveUploadPrepare');
        expect(await second.manager.attachFile(ids[2]!, fakeFile(CHUNK, 'c.bin'))).toEqual({
            ok: true,
            resumed: false,
        });
        await settle(2_000);
        expect(second.item(ids[2]!).status).toBe('done');
        expect(second.calls).toContain('driveUploadPrepare');
        expect(second.journal.queued.has(ids[2]!)).toBe(false);
        expect(second.journal.entries.has(ids[2]!)).toBe(false);
    });

    test('a move waiting when the page went away is still a move: its begin names the source', async () => {
        const stash = fakeStash();
        stash.files.set('move-1', fakeFile(CHUNK, 'moved.bin'));
        const source = { workspaceId: 'mine', nodeId: 'n-1', versionId: 'v-1' };
        const first = harness({ stash });
        const ids = first.manager.enqueue([
            { file: fakeFile(CHUNK, 'a.bin'), parent: node('root', null) },
            { file: fakeFile(CHUNK, 'b.bin'), parent: node('root', null) },
            {
                file: fakeFile(CHUNK, 'moved.bin'),
                parent: node('root', null),
                origin: 'copy',
                stash: 'move-1',
                move: { of: source },
            },
        ]);
        await settle(10);
        // The move never began: only its queued row holds it.
        expect(first.journal.entries.has(ids[2]!)).toBe(false);
        const second = harness({ journal: first.journal, stash });
        second.server.uploads = first.server.uploads;
        await second.manager.restore('ws');
        await settle(2_000);
        expect(second.item(ids[2]!).status).toBe('done');
        // A begin sent without it would be a plain copy: charged in full, and the source kept.
        const moves = second.server.begins.filter((begin) => begin.moveOf);
        expect(moves.map((begin) => begin.moveOf)).toEqual([source]);
        expect(second.item(ids[2]!).move).toEqual({ of: source });
    });

    test('a new version names only its version and object: the node is the file it replaces', async () => {
        const h = harness();
        const file = { ...node('doc'), kind: 'file' as const };
        h.manager.enqueue([
            { file: fakeFile(CHUNK, 'doc'), parent: node('root', null), replaces: file },
        ]);
        await settle(2_000);
        const [begun] = h.server.begins;
        expect(begun!.node).toMatchObject({ existing: true, id: 'doc' });
        expect(begun!.node).not.toHaveProperty('idSeed');
        expect(scopedId('version', 'ws', begun!.versionIdSeed)).toBe(begun!.versionId);
    });

    test('a copy signs as it was told, through a conflict copy too; an older journaled copy signs re-sealed', async () => {
        const h = harness({ conflict: true });
        h.manager.enqueue([
            {
                file: fakeFile(CHUNK, 'saved.bin'),
                parent: node('root', null),
                origin: 'copy',
                signAs: { metadata: 'saved', version: 'saved' },
            },
        ]);
        await settle(2_000);
        // Its node, its version, and the sibling a conflict made, all saved.
        expect(h.signed).toEqual([
            { operation: 'driveCreateNodes', signAs: 'saved' },
            { operation: 'driveUploadPrepare', signAs: 'saved' },
            { operation: 'driveCreateNodes', signAs: 'saved' },
            { operation: 'driveUploadRewrap', signAs: 'saved' },
        ]);
        const sibling = h.server.attached[0]!.input as { node: { id: string; idSeed: string } };
        expect(scopedId('node', 'ws', sibling.node.idSeed)).toBe(sibling.node.id);

        // A verified original's name with content that did not verify: chosen apart.
        const mixed = harness();
        mixed.manager.enqueue([
            {
                file: fakeFile(CHUNK, 'mixed.bin'),
                parent: node('root', null),
                origin: 'copy',
                signAs: { metadata: 'ordinary', version: 'resealed' },
            },
        ]);
        await settle(2_000);
        expect(mixed.signed.map((call) => call.signAs)).toEqual(['ordinary', 'resealed']);

        // A file the person holds is theirs: ordinary.
        const own = harness();
        own.manager.enqueue([{ file: fakeFile(CHUNK, 'own.bin'), parent: node('root', null) }]);
        await settle(2_000);
        expect(own.signed.map((call) => call.signAs)).toEqual(['ordinary', 'ordinary']);

        // A copy queued before copies said how to sign, restored: re-sealed, as copies were then.
        const journal = createMemoryJournal();
        const stash = fakeStash();
        stash.files.set('old-copy', fakeFile(CHUNK, 'old.bin'));
        await journal.putQueued({
            id: 'q-old',
            workspaceId: 'ws',
            parentId: 'root',
            parentName: 'root',
            name: 'old.bin',
            replacesId: null,
            file: { name: 'old.bin', size: CHUNK, lastModified: 0, type: '' },
            handle: null,
            origin: 'copy',
            stash: 'old-copy',
            createdAt: 0,
            updatedAt: 0,
        });
        const restored = harness({ journal, stash });
        await restored.manager.restore('ws');
        await settle(2_000);
        expect(restored.signed.map((call) => call.signAs)).toEqual(['resealed', 'resealed']);
    });

    test('a copy’s node carries its source’s attributes, through a conflict copy and a reload at either stage', async () => {
        const attributes = { colour: 'blue', 'zz-unknown': 'from a newer client' };
        const attributesOf = (h: ReturnType<typeof harness>) =>
            h.createdMetadata.map((metadata) => metadata.attributes);
        // Straight through, and the "keep both" copy a conflict makes: both carry them.
        const h = harness({ conflict: true });
        h.manager.enqueue([
            {
                file: fakeFile(CHUNK, 'saved.bin'),
                parent: node('root', null),
                origin: 'copy',
                attributes,
            },
        ]);
        await settle(2_000);
        expect(attributesOf(h)).toEqual([attributes, attributes]);
        expect(h.createdMetadata[1]!.name).toBe('saved (conflict copy).bin');

        // Queued when the page went away: the queued row keeps them.
        const stash = fakeStash();
        stash.files.set('waiting', fakeFile(CHUNK, 'waiting.bin'));
        const queued = harness({ stash });
        queued.manager.enqueue([
            {
                file: fakeFile(CHUNK, 'waiting.bin'),
                parent: node('root', null),
                origin: 'copy',
                stash: 'waiting',
                attributes,
            },
        ]);
        const row = [...queued.journal.queued.values()][0]!;
        expect(row.attributes).toEqual(attributes);
        const fresh = createMemoryJournal();
        await fresh.putQueued(row);
        const restored = harness({ journal: fresh, stash });
        await restored.manager.restore('ws');
        await settle(2_000);
        expect(attributesOf(restored)).toEqual([attributes]);

        // Begun, then the page went away, then a conflict: the journaled row keeps them for the copy.
        const begunStash = fakeStash();
        begunStash.files.set('begun', fakeFile(6 * CHUNK, 'movie.mp4'));
        const first = harness({ stash: begunStash });
        const [id] = first.manager.enqueue([
            {
                file: fakeFile(6 * CHUNK, 'movie.mp4'),
                parent: node('root', null),
                origin: 'copy',
                stash: 'begun',
                attributes,
            },
        ]);
        await settle(150);
        await first.manager.pause(id!);
        await settle(100);
        expect(first.journal.entries.get(id!)!.attributes).toEqual(attributes);
        const second = harness({ journal: first.journal, stash: begunStash, conflict: true });
        second.server.uploads = first.server.uploads;
        await second.manager.restore('ws');
        await settle(2_000);
        expect(second.server.attached).toHaveLength(1);
        expect(attributesOf(second)).toEqual([attributes]);
    });

    test('a file whose name holds a lone surrogate lands with U+FFFD in its place, and its record opens', async () => {
        const h = harness();
        const [id] = h.manager.enqueue([
            { file: fakeFile(CHUNK, 'a\ud800b'), parent: node('root', null) },
        ]);
        await settle(2_000);
        expect(h.item(id!).status).toBe('done');
        expect(h.item(id!).name).toBe('a�b');
        const sealed = h.createdMetadata[0]!;
        expect(sealed.name).toBe('a�b');
        // Sealed and opened as the worker does: a name that seals is one that opens.
        const key = generateKey();
        const ctx = { workspaceId: WS_ID, nodeId: NODE_ID, metadataVersion: 1 };
        expect(await openMetadata(await sealMetadata(sealed, key, ctx), key, ctx)).toMatchObject({
            name: 'a�b',
        });
    });

    test('a replacement’s "keep both" copy takes the replaced file’s attributes; a new file has none', async () => {
        const attributes = { colour: 'red' };
        const replaced = {
            ...node('doc'),
            kind: 'file' as const,
            metadata: { name: 'doc', mime: null, size: 1, modified: null, attributes },
        };
        const h = harness({ conflict: true });
        h.manager.enqueue([
            { file: fakeFile(CHUNK, 'doc'), parent: node('root', null), replaces: replaced },
        ]);
        await settle(2_000);
        expect(h.server.attached).toHaveLength(1);
        expect(h.createdMetadata).toHaveLength(1);
        expect(h.createdMetadata[0]!.attributes).toEqual(attributes);

        const own = harness();
        own.manager.enqueue([{ file: fakeFile(CHUNK, 'own.bin'), parent: node('root', null) }]);
        await settle(2_000);
        expect(own.createdMetadata).toHaveLength(1);
        expect(own.createdMetadata[0]).not.toHaveProperty('attributes');
    });

    test('a copy comes back from its stash and finishes without being asked', async () => {
        const stash = fakeStash();
        stash.files.set('copy-1', fakeFile(6 * CHUNK, 'movie.mp4'));
        const first = harness({ stash });
        const [id] = first.manager.enqueue([
            {
                file: fakeFile(6 * CHUNK, 'movie.mp4'),
                parent: node('root', null),
                origin: 'copy',
                stash: 'copy-1',
            },
        ]);
        await settle(150);
        await first.manager.pause(id!);
        await settle(100);
        const landed = first.item(id!).partsDone;
        expect(landed).toBeGreaterThan(0);
        expect(landed).toBeLessThan(6);
        const second = harness({ journal: first.journal, stash });
        second.server.uploads = first.server.uploads;
        await second.manager.restore('ws');
        await settle(2_000);
        expect(second.item(id!).status).toBe('done');
        // Resumed from the journal's keys and the landed parts, not begun again.
        expect(second.calls).toContain('driveUploadReopen');
        expect(second.calls).not.toContain('driveUploadPrepare');
        expect(second.calls.filter((c) => c === 'driveUploadSend')).toHaveLength(6 - landed);
        expect(second.server.completed).toEqual([{ id: 'up-1', parts: [1, 2, 3, 4, 5, 6] }]);
        expect(stash.removed).toEqual(['copy-1']);
        expect(second.journal.entries.size).toBe(0);
        expect(second.journal.queued.size).toBe(0);
    });

    test('a stash that can’t be read just now is kept and tried again; only a gone one is lost', async () => {
        const stash = fakeStash();
        stash.files.set('copy-1', fakeFile(2 * CHUNK, 'notes.pdf'));
        const first = harness({ stash });
        const [id] = first.manager.enqueue([
            {
                file: fakeFile(2 * CHUNK, 'notes.pdf'),
                parent: node('root', null),
                origin: 'copy',
                stash: 'copy-1',
            },
        ]);
        await settle(50);
        await first.manager.pause(id!);
        await settle(100);
        // After a reload the disk is busy for a moment: not lost, the stash stays.
        const open = stash.open.bind(stash);
        stash.open = async () => {
            throw new DOMException('Busy', 'NoModificationAllowedError');
        };
        const second = harness({ journal: first.journal, stash });
        second.server.uploads = first.server.uploads;
        await second.manager.restore('ws');
        await settle(500);
        expect(second.item(id!).status).toBe('paused');
        expect(stash.files.has('copy-1')).toBe(true);
        // A lock while reopening pauses it as a lock does, and keeps the stash too.
        stash.open = async () => {
            throw new Error('Your account was locked. Please try again.');
        };
        await second.manager.resume(id!);
        await settle(200);
        expect(second.item(id!).error).toBe('Unlock this device to continue.');
        expect(stash.files.has('copy-1')).toBe(true);
        // Readable again: it finishes.
        stash.open = open;
        await second.manager.resume(id!);
        await settle(2_000);
        expect(second.item(id!).status).toBe('done');
        // A stash that is gone, by contrast, is lost at once.
        const third = harness({ stash });
        const [goneId] = third.manager.enqueue([
            {
                file: fakeFile(CHUNK, 'gone.pdf'),
                parent: node('root', null),
                origin: 'copy',
                stash: 'copy-2',
            },
        ]);
        await settle(20);
        await third.manager.pause(goneId!);
        const fourth = harness({ journal: third.journal, stash });
        await fourth.manager.restore('ws');
        await settle(500);
        expect(fourth.item(goneId!).status).toBe('failed');
    });

    test('signing out stops every upload and leaves no name, digest or stashed byte behind', async () => {
        const stash = fakeStash();
        stash.files.set('copy-1', fakeFile(4 * CHUNK, 'shared-contract.pdf'));
        // A stash an earlier page left behind, which no upload names any more.
        stash.files.set('orphan', fakeFile(CHUNK, 'old.bin'));
        const h = harness({ stash });
        h.manager.enqueue([
            {
                file: fakeFile(4 * CHUNK, 'shared-contract.pdf'),
                parent: node('root', null),
                origin: 'copy',
                stash: 'copy-1',
            },
            { file: fakeFile(4 * CHUNK, 'payroll.xlsx'), parent: node('root', null) },
            { file: fakeFile(CHUNK, 'waiting.txt'), parent: node('root', null) },
        ]);
        await settle(120);
        expect(h.journal.entries.size + h.journal.queued.size).toBeGreaterThan(0);
        await h.manager.forgetAll();
        await settle(200);
        expect(h.journal.entries.size).toBe(0);
        expect(h.journal.queued.size).toBe(0);
        expect(stash.files.size).toBe(0);
        expect(h.manager.getState().uploads).toHaveLength(0);
        // The server is told, so the reservations do not linger until they expire.
        expect(h.server.aborted.length).toBeGreaterThan(0);
        expect(h.server.completed).toHaveLength(0);
    });

    /* Records every journal write from now on. */
    function journalWrites(journal: Journal) {
        const writes: string[] = [];
        for (const method of ['put', 'update', 'remove', 'putQueued', 'removeQueued'] as const) {
            const original = journal[method].bind(journal) as (...args: never[]) => Promise<void>;
            (journal[method] as unknown) = async (...args: never[]) => {
                writes.push(method);
                return original(...args);
            };
        }
        return writes;
    }

    test('after another tab signed out, a part that lands later writes nothing to the journal', async () => {
        let land!: () => void;
        const landing = new Promise<void>((resolve) => {
            land = resolve;
        });
        const h = harness({
            send: async (_objectId, index) => {
                await landing;
                return { ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 };
            },
        });
        h.manager.enqueue([
            { file: fakeFile(2 * CHUNK, 'payroll.xlsx'), parent: node('root', null) },
        ]);
        await settle(200);
        expect(h.journal.entries.size).toBe(1);
        // That tab deletes the journal; this one hears of it and must not write it back.
        const writes = journalWrites(h.journal);
        h.manager.invalidate();
        land();
        await settle(1_000);
        expect(writes).toEqual([]);
        expect(h.manager.getState().uploads).toHaveLength(0);
        // Signed in again, the journal is used as before.
        h.manager.enqueue([{ file: fakeFile(CHUNK, 'later.txt'), parent: node('root', null) }]);
        await settle(1_000);
        expect(writes).toContain('put');
    });

    test('after another tab signed out, an upload whose begin answers later sends nothing and is released', async () => {
        const h = harness();
        const begin = h.api.beginUpload;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        h.api.beginUpload = async (ws, input) => {
            await held;
            return begin(ws, input);
        };
        h.manager.enqueue([
            { file: fakeFile(2 * CHUNK, 'contract.pdf'), parent: node('root', null) },
        ]);
        await settle(100);
        const sendsBefore = h.calls.filter((c) => c === 'driveUploadSend').length;
        h.manager.invalidate();
        release();
        await settle(1_000);
        expect(h.calls.filter((c) => c === 'driveUploadSend').length).toBe(sendsBefore);
        expect(h.server.aborted).toEqual(['up-1']);
        expect(h.journal.entries.size).toBe(0);
    });

    test('when another tab signs out, uploads here release their reservations and write nothing', async () => {
        const h = harness({
            // Parts never land: the uploads are begun and stay so.
            send: () => new Promise(() => {}),
        });
        const [sending, paused] = h.manager.enqueue([
            { file: fakeFile(2 * CHUNK, 'payroll.xlsx'), parent: node('root', null) },
            { file: fakeFile(2 * CHUNK, 'contract.pdf'), parent: node('root', null) },
        ]);
        await settle(200);
        await h.manager.pause(paused!);
        expect(h.item(sending!).status).toBe('uploading');
        expect(h.item(paused!).status).toBe('paused');
        const writes = journalWrites(h.journal);
        await h.manager.releaseAll();
        // Both reservations go back to the server now, not when they expire a day later.
        expect([...h.server.aborted].sort()).toEqual(['up-1', 'up-2']);
        expect(writes).toEqual([]);
        expect(h.manager.getState().uploads).toHaveLength(0);
    });

    test('a release waits for a begin still on its way, and aborts what it reserved before it says released', async () => {
        const h = harness();
        const begin = h.api.beginUpload;
        let answer!: () => void;
        const held = new Promise<void>((resolve) => {
            answer = resolve;
        });
        h.api.beginUpload = async (ws, input) => {
            await held;
            return begin(ws, input);
        };
        h.manager.enqueue([
            { file: fakeFile(2 * CHUNK, 'contract.pdf'), parent: node('root', null) },
        ]);
        await settle(100);
        let released = false;
        const releasing = h.manager.releaseAll().then(() => (released = true));
        await settle(50);
        expect(released).toBe(false);
        // The server answers the begin while the other tab still waits on this one.
        answer();
        await releasing;
        // Aborted before the release was reported, so before that tab ends the session (the
        // upload's own late begin aborts it once more, harmlessly).
        expect(h.server.aborted).toContain('up-1');
    });

    test('a worker that hangs does not hold up releasing the server’s reservations', async () => {
        const h = harness({
            send: () => new Promise(() => {}),
            cancelHold: () => new Promise(() => {}),
        });
        h.manager.enqueue([
            { file: fakeFile(2 * CHUNK, 'payroll.xlsx'), parent: node('root', null) },
        ]);
        await settle(200);
        void h.manager.releaseAll();
        await settle(50);
        expect(h.server.aborted).toEqual(['up-1']);
    });

    test('a copy without bytes on this device is reported lost, its reservation released, no file picker offered', async () => {
        const stash = fakeStash();
        stash.files.set('copy-1', fakeFile(2 * CHUNK, 'stashed.bin'));
        const first = harness({ stash });
        const [stashed, unstashed] = first.manager.enqueue([
            {
                file: fakeFile(2 * CHUNK, 'stashed.bin'),
                parent: node('root', null),
                origin: 'copy',
                stash: 'copy-1',
            },
            // A browser that could not stash: the copy lives only in memory.
            { file: fakeFile(2 * CHUNK, 'plain.bin'), parent: node('root', null), origin: 'copy' },
        ]);
        await settle(50);
        await first.manager.pause(stashed!);
        await first.manager.pause(unstashed!);
        await settle(100);
        expect(first.journal.entries.size).toBe(2);
        // Site data cleared: the stash is gone too.
        stash.files.clear();
        const second = harness({ journal: first.journal, stash });
        second.server.uploads = first.server.uploads;
        await second.manager.restore('ws');
        await settle(100);
        for (const id of [stashed!, unstashed!]) {
            const item = second.item(id);
            expect(item.status).toBe('failed');
            expect(item.error).toMatch(/Save it again/);
            expect(item.needsFile).toBe(true);
            expect(item.hasHandle).toBe(false);
        }
        expect(second.server.aborted.sort()).toEqual(['up-1', 'up-2']);
        expect(second.journal.entries.size).toBe(0);
        expect(second.journal.queued.size).toBe(0);
        // Nothing to retry with: the row stays as it is until removed.
        await second.manager.retry(stashed!);
        expect(second.item(stashed!).status).toBe('failed');
        expect(second.calls).not.toContain('driveUploadPrepare');
    });
});

/* A copy's bytes in memory, in uneven parts, with a recognisable pattern. */
function memoryCopy(size: number, name = 'copy.bin') {
    // The pattern repeats every 256 bytes, so it is written once and doubled: built byte by
    // byte through Uint8Array.from, 48 MB took over a second here and 14 s on a loaded CI runner.
    const content = new Uint8Array(size);
    for (let i = 0; i < Math.min(256, size); i++) content[i] = (i * 31 + 11) & 0xff;
    for (let filled = 256; filled < size; filled *= 2)
        content.copyWithin(filled, 0, Math.min(filled, size - filled));
    // A chunk is a whole number of patterns, so every chunk would read the same: each one's
    // first four bytes carry its index, and a chunk swapped or read twice shows.
    for (let start = 0; start + 4 <= size; start += CHUNK)
        new DataView(content.buffer).setUint32(start, start / CHUNK + 1, false);
    const cut = [0, 1000, CHUNK + 7, size].filter(
        (at, i, all) => at <= size && all.indexOf(at) === i,
    );
    const parts = cut.slice(1).map((end, i) => content.slice(cut[i], end));
    const file: MemoryFile = {
        kind: 'memory',
        name,
        size,
        type: 'application/octet-stream',
        lastModified: 2_000,
        parts,
        thumbnail: new Uint8Array([1, 2, 3]),
    };
    return { content, file };
}

describe('uploads from memory', () => {
    test('send exactly the bytes, never as a Blob, and move them to the worker rather than copy', async () => {
        const blobs = vi.spyOn(globalThis, 'Blob');
        const files = vi.spyOn(globalThis, 'File');
        const h = harness();
        // Five chunks, so later parts are read after the first wave (three in flight) has
        // already moved the bytes: they must read the worker's copy, not move them again.
        const size = 4 * CHUNK + 5;
        const { content, file } = memoryCopy(size);
        const parts = [...file.parts];
        const [id] = h.manager.enqueue([{ file, parent: node('root', null), origin: 'copy' }]);
        await settle(3_000);
        expect(h.item(id!).status).toBe('done');
        // Byte for byte: the chunks the worker read, in order, are the copy.
        const sourceId = [...h.readChunks.keys()][0]!.split(':')[0]!;
        const sent = new Uint8Array(size);
        for (let index = 0; index < 5; index++)
            sent.set(h.readChunks.get(`${sourceId}:${index}`)!, index * CHUNK);
        // Compared natively, without printing 40 MB on a mismatch.
        expect(Buffer.compare(sent, content)).toBe(0);
        // Moved once: the page's buffers are detached, and attached a single time.
        expect(h.calls.filter((call) => call === 'driveSourceAttach')).toHaveLength(1);
        expect(parts.every((part) => part.byteLength === 0)).toBe(true);
        // And let go of in the worker once the upload is done.
        expect(h.released).toEqual([sourceId]);
        expect(h.sources.size).toBe(0);
        // The plaintext never became a Blob or a File on the way.
        expect(blobs.mock.calls.length).toBe(0);
        expect(files.mock.calls.length).toBe(0);
    });

    test('a lock drops the bytes the worker held, and the copy comes back from its stash', async () => {
        const stash = fakeStash();
        const { file } = memoryCopy(3 * CHUNK);
        stash.files.set('copy-1', fakeFile(3 * CHUNK, 'copy.bin', 2_000));
        let fail = false;
        const h = harness({
            stash,
            send: async (_objectId, index) => {
                if (fail) throw new Error('Your account was locked. Please try again.');
                return { ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 };
            },
        });
        const [id] = h.manager.enqueue([
            { file, parent: node('root', null), origin: 'copy', stash: 'copy-1' },
        ]);
        fail = true;
        await settle(500);
        expect(h.item(id!).status).toBe('paused');
        // What was moved to the worker is not asked for again: the page has nothing to move.
        const opened = vi.spyOn(stash, 'open');
        fail = false;
        await h.manager.resume(id!);
        await settle(2_000);
        expect(opened).toHaveBeenCalledTimes(1);
        expect(h.item(id!).status).toBe('done');
    });
});

describe('in-memory bytes after the upload stops', () => {
    const permanent = async () =>
        ({ ok: false, status: 400, retryable: false, message: 'Refused.' }) as UploadPartResult;

    test('a failed copy removed from the list lets the worker drop its bytes', async () => {
        const h = harness({ send: permanent });
        const { file } = memoryCopy(CHUNK);
        const [id] = h.manager.enqueue([{ file, parent: node('root', null), origin: 'copy' }]);
        await settle(500);
        expect(h.item(id!).status).toBe('failed');
        expect(h.sources.size).toBe(1);
        h.manager.remove(id!);
        await settle(10);
        expect(h.sources.size).toBe(0);
        expect(h.released).toHaveLength(1);
    });

    test('a cancelled copy lets the worker drop its bytes', async () => {
        let hold: (() => void) | null = null;
        const h = harness({
            send: (_objectId, index) =>
                new Promise((resolve) => {
                    hold = () => resolve({ ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 });
                }),
        });
        const { file } = memoryCopy(CHUNK);
        const [id] = h.manager.enqueue([{ file, parent: node('root', null), origin: 'copy' }]);
        await settle(100);
        expect(h.sources.size).toBe(1);
        await h.manager.cancel(id!);
        void hold;
        expect(h.sources.size).toBe(0);
    });

    test('carries the copy’s own thumbnail into the sealed object', async () => {
        const h = harness();
        const { file } = memoryCopy(CHUNK);
        h.manager.enqueue([{ file, parent: node('root', null), origin: 'copy' }]);
        await settle(1_000);
        expect(h.preparedThumbnails.map((t) => (t ? [...t] : null))).toEqual([[1, 2, 3]]);
    });

    test('after a lock it never saw, a paused copy reopens from its stash instead of failing', async () => {
        const stash = fakeStash();
        const { content, file } = memoryCopy(6 * CHUNK);
        stash.bytes.set('copy-1', content.slice());
        const h = harness({ stash });
        const [id] = h.manager.enqueue([
            { file, parent: node('root', null), origin: 'copy', stash: 'copy-1' },
        ]);
        await settle(150);
        await h.manager.pause(id!);
        await settle(100);
        expect(h.item(id!).partsDone).toBeLessThan(6);
        // Locked while paused: the worker and its copy of the bytes are gone.
        h.lockWorker();
        const opened = vi.spyOn(stash, 'open');
        await h.manager.resume(id!);
        await settle(3_000);
        expect(h.item(id!).status).toBe('done');
        expect(opened).toHaveBeenCalledTimes(1);
        // Reattached from the stash's bytes, which were in memory, never a Blob.
        expect(h.calls.filter((call) => call === 'driveSourceAttach')).toHaveLength(2);
    });

    test('after a lock it never saw, a copy with no stash is reported lost, not failed at every retry', async () => {
        const h = harness();
        const { file } = memoryCopy(6 * CHUNK);
        const [id] = h.manager.enqueue([{ file, parent: node('root', null), origin: 'copy' }]);
        await settle(150);
        await h.manager.pause(id!);
        await settle(100);
        expect(h.item(id!).partsDone).toBeLessThan(6);
        h.lockWorker();
        await h.manager.resume(id!);
        await settle(500);
        expect(h.item(id!).status).toBe('failed');
        expect(h.item(id!).error).toMatch(/did not finish/);
    });

    test('a lock that cuts the move to the worker short, with no stash, reports the copy lost', async () => {
        const h = harness({ attachLocks: true });
        const { file } = memoryCopy(CHUNK);
        const [id] = h.manager.enqueue([{ file, parent: node('root', null), origin: 'copy' }]);
        await settle(300);
        expect(h.item(id!).status).toBe('paused');
        await h.manager.resume(id!);
        await settle(300);
        expect(h.item(id!).status).toBe('failed');
        expect(h.item(id!).error).toMatch(/did not finish/);
    });
});

describe('in-memory bytes and the person’s own actions', () => {
    test('Retry brings back a failed copy whose bytes a lock took, from its sealed stash', async () => {
        const stash = fakeStash();
        const { content, file } = memoryCopy(2 * CHUNK);
        stash.bytes.set('copy-1', content.slice());
        let mode: 'fail' | 'lock' | 'ok' = 'fail';
        const h = harness({
            stash,
            send: async (_objectId, index) => {
                if (mode === 'lock') throw new Error('Your account was locked. Please try again.');
                if (mode === 'fail')
                    return { ok: false, status: 400, retryable: false, message: 'Refused.' };
                return { ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 };
            },
        });
        const [copy] = h.manager.enqueue([
            { file, parent: node('root', null), origin: 'copy', stash: 'copy-1' },
        ]);
        await settle(500);
        expect(h.item(copy!).status).toBe('failed');
        // Another upload meets the lock: the engine notices, and the worker's bytes are gone.
        mode = 'lock';
        h.manager.enqueue([{ file: fakeFile(CHUNK, 'other.bin'), parent: node('root', null) }]);
        await settle(500);
        h.lockWorker();
        expect(h.item(copy!).status).toBe('failed');
        mode = 'ok';
        await h.manager.retry(copy!);
        await settle(3_000);
        expect(h.item(copy!).status).toBe('done');
    });

    test('a copy cancelled while its bytes move to the worker leaves none there', async () => {
        let arrive: () => void = () => {};
        const h = harness({ attachHold: () => new Promise((resolve) => (arrive = resolve)) });
        const { file } = memoryCopy(CHUNK);
        const [id] = h.manager.enqueue([{ file, parent: node('root', null), origin: 'copy' }]);
        await settle(100);
        expect(h.calls).toContain('driveSourceAttach');
        await h.manager.cancel(id!);
        arrive();
        await settle(100);
        expect(h.sources.size).toBe(0);
    });

    test('removing a failed copy with a part still encrypting touches nothing more', async () => {
        // No stash: a part that wrongly carried on would end in lost(), on a row already gone.
        const { file } = memoryCopy(3 * CHUNK);
        let encrypted: () => void = () => {};
        const events: string[] = [];
        const h = harness({
            // The first part is refused for good; the last is still being encrypted meanwhile.
            send: async () => ({ ok: false, status: 400, retryable: false, message: 'Refused.' }),
            encryptHold: (index) =>
                index === 2 ? new Promise((resolve) => (encrypted = resolve)) : undefined,
            onEvent: (event) => void events.push(event.type),
        });
        const [id] = h.manager.enqueue([{ file, parent: node('root', null), origin: 'copy' }]);
        await settle(300);
        expect(h.item(id!).status).toBe('failed');
        const before = events.length;
        h.manager.remove(id!);
        await settle(10);
        encrypted();
        await settle(300);
        // Nothing more happens to the removed copy: no lost event, no server abort.
        expect(events.slice(before)).toEqual([]);
        expect(h.server.aborted).toEqual([]);
    });
});

/*
 * A produced result (the save path, ./save-runs.ts): a tool's or an editor's
 * bytes from memory. A new version that loses a race to someone else's must
 * end `stale`, naming the version that won, with nothing published beside it
 * and its reservation released; it must never be journaled, so it never
 * resumes after a reload.
 */
describe('produced results', () => {
    const memory = (name: string, size = 1024): MemoryFile => ({
        kind: 'memory',
        name,
        size,
        type: 'text/plain',
        lastModified: 1_000,
        parts: [new Uint8Array(size).fill(7)],
    });
    const fileAt = (version: string) => ({
        ...node('doc'),
        kind: 'file' as const,
        name: 'doc.txt',
        currentVersion: { id: version } as DriveNode['currentVersion'],
    });
    /* The file as the server lists it now, for the engine's look before an attach. */
    const listedAt = (version: () => string) => ({
        openNodes: async () => ({ parent: node('root', null), replaces: fileAt(version()) }),
    });

    test('an editor’s version and an ordinary replacement both name the folder: the server can’t tell them apart', async () => {
        const h = harness({ serverVersion: () => 'v1', ...listedAt(() => 'v1') });
        h.manager.enqueue([
            {
                file: memory('doc.txt'),
                parent: node('root', null),
                replaces: fileAt('v1'),
                produced: { startedFrom: 'v1' },
            },
        ]);
        h.manager.enqueue([
            { file: memory('doc.txt'), parent: node('root', null), replaces: fileAt('v1') },
        ]);
        await settle(5_000);
        const nodes = h.server.begins.map((begin) => begin.node);
        expect(nodes).toHaveLength(2);
        expect(nodes[0]).toMatchObject({ existing: true, expectedParentId: 'root' });
        expect(nodes[1]).toMatchObject({ existing: true, expectedParentId: 'root' });
        // The same fields, the same shape: nothing in an editor's begin marks it as one.
        expect(Object.keys(nodes[0] ?? {}).sort()).toEqual(Object.keys(nodes[1] ?? {}).sort());
    });

    test('a file moved between begin and completion is stale with no version: no copy, nothing attached', async () => {
        const h = harness({ moved: true, ...listedAt(() => 'v1') });
        const [id] = h.manager.enqueue([
            {
                file: memory('doc.txt'),
                parent: node('root', null),
                replaces: fileAt('v1'),
                produced: { startedFrom: 'v1' },
            },
        ]);
        await settle(5_000);
        expect(h.item(id!).errorCode).toBe('stale');
        expect(h.item(id!).stale).toMatchObject({ currentVersionId: null });
        expect(h.server.attached).toEqual([]);
    });

    test('a version race at completion is stale, naming the winner: no conflict copy, the upload aborted', async () => {
        let current = 'v1';
        const h = harness({
            serverVersion: () => current,
            ...listedAt(() => current),
            // Someone else saves once this upload has begun, while its bytes are on their way.
            encryptHold: () => void (current = 'v-theirs'),
        });
        const [id] = h.manager.enqueue([
            {
                file: memory('doc.txt'),
                parent: node('root', null),
                replaces: fileAt('v1'),
                produced: { startedFrom: 'v1' },
            },
        ]);
        await settle(5_000);
        const item = h.item(id!);
        expect(item.status).toBe('failed');
        expect(item.errorCode).toBe('stale');
        expect(item.stale).toEqual({ currentVersionId: 'v-theirs', released: true });
        expect(h.server.attached).toEqual([]);
        expect(h.createdMetadata).toEqual([]);
        expect(h.published).toEqual([]);
        expect(h.server.begins).toHaveLength(1);
        expect(h.server.aborted).toEqual(['up-1']);
        // Nothing to retry with: a retry must not upload it beside theirs.
        await h.manager.retry(id!);
        await settle(5_000);
        expect(h.server.begins).toHaveLength(1);
        expect(h.server.attached).toEqual([]);
    });

    test('a version whose file left its folder during a key change’s look or wait is stale, never sealed under the file as it was', async () => {
        for (const leavesAt of [1, 2]) {
            let looks = 0;
            const h = harness({
                serverVersion: () => 'v1',
                // The file is refused for its key; the folder isn't. A key change the upload waits
                // out only in the second case (the look after a wait), never past a second.
                refuseWrite: (t) => (t.id === 'doc' ? 'Finishing a key change.' : null),
                waitsForKeyChange: () => leavesAt === 2,
                // A wait that goes on past a few looks is not this case: it gives up after a second.
                keyChangePause: (_target, attempt) =>
                    attempt > 3 ? new Promise<void>(() => {}) : Promise.resolve(),
                keyChangeGiveUpMs: 1_000,
                // The look before the seal (1), or the look after a wait (2), no longer lists it.
                openNodes: async () => {
                    looks += 1;
                    return looks >= leavesAt
                        ? { parent: node('root', null) }
                        : { parent: node('root', null), replaces: fileAt('v1') };
                },
            });
            const [id] = h.manager.enqueue([
                {
                    file: memory('doc.txt'),
                    parent: node('root', null),
                    replaces: fileAt('v1'),
                    produced: { startedFrom: 'v1' },
                },
            ]);
            await settle(5_000);
            const item = h.item(id!);
            expect(item.status).toBe('failed');
            expect(item.errorCode).toBe('stale');
            expect(item.stale?.currentVersionId).toBeNull();
            expect(h.server.begins).toEqual([]);
            expect(h.server.attached).toEqual([]);
        }
    });

    test('a version race whose abort gets no answer says its reservation wasn’t released', async () => {
        let current = 'v1';
        const h = harness({
            serverVersion: () => current,
            ...listedAt(() => current),
            encryptHold: () => void (current = 'v-theirs'),
        });
        Object.assign(h.api, {
            abortUpload: async () => {
                throw new TypeError('Failed to fetch');
            },
        });
        const [id] = h.manager.enqueue([
            {
                file: memory('doc.txt'),
                parent: node('root', null),
                replaces: fileAt('v1'),
                produced: { startedFrom: 'v1' },
            },
        ]);
        await settle(5_000);
        expect(h.item(id!).stale).toEqual({ currentVersionId: 'v-theirs', released: false });
    });

    test('a stale version whose abort a family manager’s pause refused is not released', async () => {
        let current = 'v1';
        const h = harness({
            serverVersion: () => current,
            ...listedAt(() => current),
            encryptHold: () => void (current = 'v-theirs'),
        });
        Object.assign(h.api, {
            abortUpload: async () => {
                throw new DriveApiError(
                    'A group manager has paused changes to this folder.',
                    'held',
                    403,
                );
            },
        });
        const [id] = h.manager.enqueue([
            {
                file: memory('doc.txt'),
                parent: node('root', null),
                replaces: fileAt('v1'),
                produced: { startedFrom: 'v1' },
            },
        ]);
        await settle(5_000);
        expect(h.item(id!).stale).toEqual({ currentVersionId: 'v-theirs', released: false });
    });

    test('a stale version whose abort met an expired session (401) is not released', async () => {
        let current = 'v1';
        const h = harness({
            serverVersion: () => current,
            ...listedAt(() => current),
            encryptHold: () => void (current = 'v-theirs'),
        });
        Object.assign(h.api, {
            abortUpload: async () => {
                throw new DriveApiError('Sign in again.', 'forbidden', 401);
            },
        });
        const [id] = h.manager.enqueue([
            {
                file: memory('doc.txt'),
                parent: node('root', null),
                replaces: fileAt('v1'),
                produced: { startedFrom: 'v1' },
            },
        ]);
        await settle(5_000);
        expect(h.item(id!).stale).toEqual({ currentVersionId: 'v-theirs', released: false });
    });

    test('the same race, uploaded as a dropped file is, still becomes a conflict copy', async () => {
        let current = 'v1';
        const h = harness({
            serverVersion: () => current,
            ...listedAt(() => current),
            encryptHold: () => void (current = 'v-theirs'),
        });
        const [id] = h.manager.enqueue([
            {
                file: fakeFile(CHUNK, 'doc.txt'),
                parent: node('root', null),
                replaces: fileAt('v1'),
            },
        ]);
        await settle(5_000);
        expect(h.item(id!).status).toBe('done');
        expect(h.item(id!).name).toBe('doc (conflict copy).txt');
    });

    test('the work started from an older version than the file as held: stale before anything is sealed or begun', async () => {
        const h = harness({ serverVersion: () => 'v2', ...listedAt(() => 'v2') });
        const [id] = h.manager.enqueue([
            {
                file: memory('doc.txt'),
                parent: node('root', null),
                replaces: fileAt('v2'),
                produced: { startedFrom: 'v1' },
            },
        ]);
        await settle(2_000);
        expect(h.item(id!).stale).toEqual({ currentVersionId: 'v2', released: true });
        expect(h.server.begins).toEqual([]);
        expect(h.calls).not.toContain('driveUploadPrepare');
    });

    test('a begin refused only for the file’s key, its version the same, is sealed afresh, never taken for a race', async () => {
        let keyEpoch = 1;
        const h = harness({
            openNodes: async () => ({
                parent: node('root', null),
                replaces: { ...fileAt('v1'), keyEpoch },
            }),
        });
        const begin = h.api.beginUpload;
        const asked: number[] = [];
        // A key change re-keyed the file (its version still v1): the first begin is refused `stale`.
        h.api.beginUpload = async (ws, input) => {
            asked.push((input.node as { keyEpoch: number }).keyEpoch);
            if (input.node.existing && input.node.keyEpoch !== keyEpoch)
                throw new DriveApiError('This item changed since you last saw it.', 'stale', 409);
            return begin(ws, input);
        };
        keyEpoch = 2;
        const [id] = h.manager.enqueue([
            {
                file: memory('doc.txt'),
                parent: node('root', null),
                replaces: fileAt('v1'),
                produced: { startedFrom: 'v1' },
            },
        ]);
        await settle(5_000);
        expect(h.item(id!).status).toBe('done');
        expect(asked).toEqual([1, 2]);
        // Refused for its key again after looking it up afresh: a failure, never `stale`.
        const again = harness({
            openNodes: async () => ({ parent: node('root', null), replaces: fileAt('v1') }),
        });
        again.api.beginUpload = async () => {
            throw new DriveApiError('This item changed since you last saw it.', 'stale', 409);
        };
        const [other] = again.manager.enqueue([
            {
                file: memory('doc.txt'),
                parent: node('root', null),
                replaces: fileAt('v1'),
                produced: { startedFrom: 'v1' },
            },
        ]);
        await settle(5_000);
        expect(again.item(other!).status).toBe('failed');
        expect(again.item(other!).errorCode).toBeNull();
        expect(again.item(other!).stale).toBeUndefined();
    });

    test('a stale begin is told from a key change by the server now, never by a listing fetched moments ago', async () => {
        // Another upload's listing, shared for two seconds, still shows v1; the server holds v2.
        const asked: boolean[] = [];
        const h = harness({
            serverVersion: () => 'v2',
            openNodes: async (_row, options) => {
                asked.push(Boolean(options?.fresh));
                return {
                    parent: node('root', null),
                    replaces: fileAt(options?.fresh ? 'v2' : 'v1'),
                };
            },
        });
        const [id] = h.manager.enqueue([
            {
                file: memory('doc.txt'),
                parent: node('root', null),
                replaces: fileAt('v1'),
                produced: { startedFrom: 'v1' },
            },
        ]);
        await settle(5_000);
        expect(h.item(id!).errorCode).toBe('stale');
        expect(h.item(id!).stale).toEqual({ currentVersionId: 'v2', released: true });
        expect(asked[0]).toBe(true);
        // The file gone from its folder by the fresh look: stale with no version, never "keys changed".
        const gone = harness({
            serverVersion: () => 'v2',
            openNodes: async () => ({ parent: node('root', null) }),
        });
        const [other] = gone.manager.enqueue([
            {
                file: memory('doc.txt'),
                parent: node('root', null),
                replaces: fileAt('v1'),
                produced: { startedFrom: 'v1' },
            },
        ]);
        await settle(5_000);
        expect(gone.item(other!).errorCode).toBe('stale');
        expect(gone.item(other!).stale).toEqual({ currentVersionId: null, released: true });
    });

    test('begin names the version the work started from, and the server refusing it is stale with the version listed now', async () => {
        // The device's listing is behind: it still shows v1, the version the work started from.
        const h = harness({ serverVersion: () => 'v3', ...listedAt(() => 'v3') });
        const [id] = h.manager.enqueue([
            {
                file: memory('doc.txt'),
                parent: node('root', null),
                replaces: fileAt('v1'),
                produced: { startedFrom: 'v1' },
            },
        ]);
        await settle(2_000);
        expect(h.server.begins[0]!.node).toMatchObject({ existing: true, expectedVersionId: 'v1' });
        expect(h.item(id!).errorCode).toBe('stale');
        expect(h.item(id!).stale).toEqual({ currentVersionId: 'v3', released: true });
        expect(h.server.uploads.size).toBe(0);
    });

    test('a completion refused only because the file was re-keyed (its version unchanged) attaches to the same file', async () => {
        const h = harness({ conflict: true, ...listedAt(() => 'v-winner') });
        const [id] = h.manager.enqueue([
            {
                file: memory('doc.txt'),
                parent: node('root', null),
                replaces: fileAt('v-winner'),
                produced: { startedFrom: 'v-winner' },
            },
        ]);
        await settle(5_000);
        expect(h.item(id!).status).toBe('done');
        expect(h.item(id!).stale ?? null).toBeNull();
        expect((h.server.attached[0]!.input as { mode: string }).mode).toBe('same-node');
    });

    test('a same-file attach cancelled while its key is rewrapped is never sent', async () => {
        let rewrapped: () => void = () => {};
        let reached = false;
        const h = harness({
            conflict: true,
            ...listedAt(() => 'v-winner'),
            rewrapHold: () =>
                new Promise((resolve) => {
                    reached = true;
                    rewrapped = resolve;
                }),
        });
        const [id] = h.manager.enqueue([
            {
                file: memory('doc.txt'),
                parent: node('root', null),
                replaces: fileAt('v-winner'),
                produced: { startedFrom: 'v-winner' },
            },
        ]);
        const attachesSent: unknown[] = [];
        const api = h.api as unknown as DriveApi;
        const attach = api.attachUpload.bind(api);
        api.attachUpload = (async (...args: Parameters<typeof attach>) => {
            attachesSent.push(args[2]);
            return attach(...args);
        }) as typeof attach;
        await vi.waitFor(() => expect(reached).toBe(true), { timeout: 5_000 });
        await h.manager.cancel(id!);
        rewrapped();
        await settle(1_000);
        expect(attachesSent).toEqual([]);
        expect(h.item(id!).status).toBe('cancelled');
    });

    test('a cancel under way when this tab signs out is still released, once', async () => {
        let open = true;
        let generation = 1;
        let workerDone: () => void = () => {};
        const h = harness({
            session: { open: () => open, generation: () => generation },
            cancelHold: () => new Promise<void>((resolve) => (workerDone = resolve)),
        });
        const [id] = h.manager.enqueue(
            [{ file: fakeFile(4 * CHUNK), parent: node('root', null) }],
            {
                generation: 1,
            },
        );
        await settle(120);
        const cancelling = h.manager.cancel(id!);
        await settle(10);
        // The sign-out comes while that cancel waits on the worker.
        open = false;
        generation = 2;
        const forgetting = h.manager.forgetAll();
        await settle(50);
        workerDone();
        await Promise.all([cancelling, forgetting]);
        await settle(200);
        expect(h.server.aborted).toEqual(['up-1']);
    });

    test('a produced new file a key change moved under keeps its own name when attached', async () => {
        const h = harness({ conflict: true });
        const [id] = h.manager.enqueue([
            { file: memory('Extracted.txt'), parent: node('root', null), produced: {} },
        ]);
        await settle(5_000);
        expect(h.item(id!).status).toBe('done');
        expect(h.item(id!).name).toBe('Extracted.txt');
        expect((h.server.attached[0]!.input as { mode: string }).mode).toBe('sibling');
    });

    test('is never journaled, from queued to done, and tells its run the ids begin made', async () => {
        const begun: { uploadId: string; nodeId: string }[] = [];
        const journal = createMemoryJournal();
        const writes: string[] = [];
        for (const method of ['put', 'update', 'remove', 'putQueued', 'removeQueued'] as const) {
            const original = journal[method].bind(journal) as (...args: unknown[]) => Promise<void>;
            (journal as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
                writes.push(method);
                return original(...args);
            };
        }
        const h = harness({ journal });
        const [id] = h.manager.enqueue([
            {
                file: memory('out.txt', 2 * CHUNK + 5),
                parent: node('root', null),
                produced: { onBegun: ({ uploadId, nodeId }) => begun.push({ uploadId, nodeId }) },
            },
        ]);
        await settle(5_000);
        // Through every part and the completion, not one row: nothing to resume, nothing named.
        expect(h.item(id!).status).toBe('done');
        expect(h.calls.filter((call) => call === 'driveUploadSend').length).toBeGreaterThanOrEqual(
            3,
        );
        expect(writes).toEqual([]);
        expect(begun).toEqual([{ uploadId: 'up-1', nodeId: h.server.begins[0]!.node.id }]);
    });

    test('a paused result hears of a lock, and resumed without its bytes is lost, never left waiting for a file', async () => {
        const events: { type: string; id: string }[] = [];
        let lockOnSend = false;
        const h = harness({
            onEvent: (event) => events.push({ type: event.type, id: event.item.id }),
            send: async (_objectId, index) => {
                if (lockOnSend) throw new Error('Your account was locked. Please try again.');
                return { ok: true, etag: `etag-${index}`, bytes: CHUNK + 16 };
            },
            encryptHold: () => (lockOnSend ? undefined : new Promise(() => {})),
        });
        const [result] = h.manager.enqueue([
            {
                file: memory('out.bin', 2 * CHUNK),
                parent: node('root', null),
                origin: 'result',
                produced: {},
            },
        ]);
        await settle(200);
        await h.manager.pause(result!);
        await settle(50);
        expect(h.item(result!).status).toBe('paused');
        // Another upload meets the lock: the worker, and the result's bytes with it, are gone.
        lockOnSend = true;
        h.manager.enqueue([{ file: fakeFile(CHUNK, 'other.bin'), parent: node('root', null) }]);
        await settle(500);
        expect(events).toContainEqual({ type: 'locked', id: result! });
        await h.manager.resume(result!);
        await settle(200);
        expect(events).toContainEqual({ type: 'lost', id: result! });
        expect(h.item(result!).status).toBe('failed');
    });

    test('a result whose run cannot record it is never completed', async () => {
        const h = harness();
        const [id] = h.manager.enqueue([
            {
                file: memory('out.txt'),
                parent: node('root', null),
                produced: { beforeComplete: () => Promise.reject(new Error('not recorded')) },
            },
        ]);
        await settle(3_000);
        expect(h.item(id!).status).toBe('failed');
        expect(h.server.completed).toEqual([]);
    });

    test('a produced version whose file left its folder is stale, never attached as a new file there', async () => {
        const h = harness({
            conflict: true,
            // The folder as listed now: the file is no longer in it.
            openNodes: async () => ({ parent: node('root', null) }),
        });
        const [id] = h.manager.enqueue([
            {
                file: memory('doc.txt'),
                parent: node('root', null),
                replaces: fileAt('v-winner'),
                produced: { startedFrom: 'v-winner' },
            },
        ]);
        await settle(5_000);
        expect(h.item(id!).errorCode).toBe('stale');
        expect(h.item(id!).stale).toEqual({ currentVersionId: null, released: true });
        expect(h.server.attached).toEqual([]);
        expect(h.createdMetadata).toEqual([]);
    });

    test('a completion the server finishes after the upload was cancelled publishes nothing here', async () => {
        let finish = () => {};
        const held = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const events: string[] = [];
        const h = harness({
            completeHold: () => held,
            onEvent: (event) => events.push(event.type),
        });
        const [id] = h.manager.enqueue([
            { file: memory('out.txt'), parent: node('root', null), produced: {} },
        ]);
        await settle(2_000);
        expect(h.item(id!).status).toBe('completing');
        await h.manager.cancel(id!);
        finish();
        await settle(2_000);
        expect(h.item(id!).status).toBe('cancelled');
        expect(events).not.toContain('done');
        expect(h.published).toEqual([]);
    });

    test('a produced new file’s sibling is announced before its attach is sent; a refusal stops the attach', async () => {
        const announced: string[] = [];
        const h = harness({ conflict: true });
        const [id] = h.manager.enqueue([
            {
                file: memory('out.txt'),
                parent: node('root', null),
                produced: {
                    onAttach: ({ nodeId }) => {
                        // Not yet attached when the run hears of it.
                        expect(h.server.attached).toEqual([]);
                        announced.push(nodeId);
                    },
                },
            },
        ]);
        await settle(5_000);
        expect(h.item(id!).status).toBe('done');
        expect(announced).toEqual([
            (h.server.attached[0]!.input as { node: { id: string } }).node.id,
        ]);

        const refused = harness({ conflict: true });
        const [other] = refused.manager.enqueue([
            {
                file: memory('out.txt'),
                parent: node('root', null),
                produced: {
                    onAttach: () => {
                        throw new Error('This save run is stopping.');
                    },
                },
            },
        ]);
        await settle(5_000);
        expect(refused.server.attached).toEqual([]);
        expect(refused.item(other!).status).toBe('failed');
    });
});
