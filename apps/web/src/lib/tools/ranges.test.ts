import { describe, expect, test } from 'vitest';
import type { CryptoRequests, CryptoResults } from '@hushos/crypto';
import type { DriveApi } from '@hushos/drive/api';
import type { DriveNode, Rpc } from '@hushos/drive/client';
import { createDownloadManager } from '@hushos/drive/downloads';
import type { ToPage, ToWorker } from './protocol';
import { memoryReader, serveRanges, type RangeReader } from './ranges';
import { serveTool, ToolError, type ToolContext } from './worker';

/*
 * Both ends of the range port, over a real MessageChannel: the worker runtime's sources
 * (worker.ts) asking, the page's server (ranges.ts) answering from the download engine's
 * real reader, whose chunks come from a stand-in crypto worker. Chunk i of the file is a
 * pattern no other chunk repeats, so bytes from the wrong chunk or the wrong offset show.
 */

const CHUNK = 8 * 1024 * 1024;

const patternAt = (index: number, i: number) => (index * 131 + i * 7 + (i >> 8)) & 0xff;
function chunkBytes(index: number, size: number) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = patternAt(index, i);
    return bytes;
}

function fileNode(size: number): DriveNode {
    return {
        id: 'f',
        workspaceId: 'ws',
        parentId: 'root',
        kind: 'file',
        keyEpoch: 1,
        parentKeyEpoch: 1,
        keyEnvelope: 'k',
        prevKeyEnvelope: null,
        prevKeyEpoch: null,
        prevParentKeyEpoch: null,
        metadataVersion: 1,
        metadataEnvelope: 'm',
        currentVersion: {
            id: 'v-f',
            objectId: 'o-f',
            contentKeyEnvelope: 'c',
            status: 'ready',
            objectStatus: 'ready',
            contentSuite: 1,
            chunkSize: CHUNK,
            chunkCount: Math.ceil(size / CHUNK),
            contentNonce: 'n',
            plaintextSize: String(size),
            ciphertextSize: String(size + 16 * Math.ceil(size / CHUNK)),
            readyAt: '',
            signer: null,
            signature: null,
        },
        trashedAt: null,
        changeSeq: 1,
        createdAt: '',
        updatedAt: '',
        metadata: { name: 'f.zip', mime: null, size, modified: null },
        name: 'f.zip',
        content: { plaintextSize: size, thumbnailBytes: 0 },
        openError: null,
        envelopeSuite: 1,
        metadataSigner: null,
        metadataSignature: null,
        integrity: null,
    };
}

/* The download engine's reader, its chunks decrypted by a stand-in worker. */
function driveReader(size: number, fetched: number[]) {
    const rpc: Rpc = async <K extends keyof CryptoRequests>(
        operation: K,
        input: CryptoRequests[K],
    ): Promise<CryptoResults[K]> => {
        if (operation === 'driveDownloadOpen')
            return {
                chunkCount: Math.ceil(size / CHUNK),
                plaintextSize: size,
                thumbnailBytes: 0,
            } as CryptoResults[K];
        if (operation === 'driveDownloadChunk') {
            const { index } = input as CryptoRequests['driveDownloadChunk'];
            fetched.push(index);
            const length = Math.min(CHUNK, size - index * CHUNK);
            return { ok: true, index, plaintext: chunkBytes(index, length) } as CryptoResults[K];
        }
        return { closed: true } as CryptoResults[K];
    };
    const api = {
        downloadUrl: async () => ({
            url: 'https://store/o-f',
            urlExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
    } as unknown as DriveApi;
    const manager = createDownloadManager({
        rpc,
        api,
        openSink: async () => {
            throw new Error('no downloads here');
        },
        listFolder: async () => {
            throw new Error('no folders here');
        },
        ensureOpen: async () => {},
    });
    return manager.openReader(fileNode(size), 2);
}

/* A tool run by the real worker runtime on a scope the test plays the page for. */
function runTool<R>(
    sources: RangeReader[],
    work: (input: unknown, context: ToolContext) => Promise<R>,
) {
    const sent: ToPage[] = [];
    const scope = {
        onmessage: null as ((event: MessageEvent<ToWorker>) => void) | null,
        // Cloned and transferred as a worker's postMessage does.
        postMessage: (message: ToPage, transfer: Transferable[] = []) =>
            void sent.push(structuredClone(message, { transfer })),
    };
    serveTool(work, scope);
    const stops: (() => void)[] = [];
    const channels = sources.map((reader) => {
        const channel = new MessageChannel();
        stops.push(serveRanges(channel.port1, reader));
        return { size: reader.size, port: channel.port2 };
    });
    scope.onmessage!({
        data: { type: 'start', input: null, sources: channels },
    } as MessageEvent<ToWorker>);
    const finished = new Promise<ToPage>((resolve) => {
        const check = () => {
            const last = sent.find((m) => m.type === 'done' || m.type === 'fail');
            if (last) resolve(last);
            else setTimeout(check, 1);
        };
        check();
    });
    const accept = (id: number) =>
        scope.onmessage!({ data: { type: 'accepted', id } } as MessageEvent<ToWorker>);
    return { sent, finished, accept, stop: () => stops.forEach((stop) => stop()) };
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

describe('the range port', () => {
    test('a range across a chunk boundary of a Drive file arrives whole and in order', async () => {
        const size = 2 * CHUNK + 1000;
        const fetched: number[] = [];
        const reader = driveReader(size, fetched);
        const { finished, stop } = runTool([reader], async (_input, { sources }) => {
            const [source] = sources;
            return {
                size: source!.size,
                across: await source!.read(CHUNK - 3, 10),
                tail: await source!.read(2 * CHUNK + 990, 100),
                twoBoundaries: await source!.read(CHUNK - 1, CHUNK + 2),
                past: await source!.read(size, 10),
            };
        });
        const done = await finished;
        stop();
        expect(done.type).toBe('done');
        const result = (done as Extract<ToPage, { type: 'done' }>).result as Record<
            string,
            Uint8Array | number
        >;
        expect(result.size).toBe(size);
        const expected = (offset: number, length: number) => {
            const out = new Uint8Array(length);
            for (let i = 0; i < length; i++) {
                const at = offset + i;
                out[i] = patternAt(Math.floor(at / CHUNK), at % CHUNK);
            }
            return out;
        };
        expect(same(result.across as Uint8Array, expected(CHUNK - 3, 10))).toBe(true);
        // The short last chunk: clipped at the end of the file.
        expect(same(result.tail as Uint8Array, expected(2 * CHUNK + 990, 10))).toBe(true);
        expect(same(result.twoBoundaries as Uint8Array, expected(CHUNK - 1, CHUNK + 2))).toBe(true);
        expect((result.past as Uint8Array).byteLength).toBe(0);
        expect([...new Set(fetched)].sort((a, b) => a - b)).toEqual([0, 1, 2]);
        await reader.close();
    });

    test('reads two sources at once, each from its own file', async () => {
        const a = memoryReader(new TextEncoder().encode('first file'));
        const b = memoryReader(new TextEncoder().encode('second'));
        const { finished } = runTool([a, b], async (_input, { sources }) => {
            const [x, y] = await Promise.all([sources[0]!.read(0, 5), sources[1]!.read(0, 6)]);
            return new TextDecoder().decode(x) + '+' + new TextDecoder().decode(y);
        });
        expect(await finished).toEqual({ type: 'done', result: 'first+second' });
    });

    test('a memory reader’s bytes are copied, never moved out from under the page', async () => {
        const bytes = new TextEncoder().encode('held by the page');
        const { finished } = runTool([memoryReader(bytes)], async (_i, { sources }) =>
            sources[0]!.read(0, 4),
        );
        await finished;
        expect(bytes.byteLength).toBe(16);
        expect(new TextDecoder().decode(bytes)).toBe('held by the page');
    });

    test('the page refuses a read it should not allocate, and the tool fails with the generic words', async () => {
        const huge = { size: 2 ** 40, read: async () => new Uint8Array(0) };
        const channel = new MessageChannel();
        const stop = serveRanges(channel.port1, huge);
        const answers: unknown[] = [];
        channel.port2.onmessage = (event) => answers.push(event.data);
        // A worker taken over by a hostile file asking for more than any tool reads at once.
        channel.port2.postMessage({ type: 'read', id: 1, offset: 0, length: 65 * 1024 * 1024 });
        channel.port2.postMessage({ type: 'read', id: 2, offset: -1, length: 1 });
        channel.port2.postMessage({ type: 'read', id: 3, offset: 0.5, length: 1 });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(answers).toEqual([
            { type: 'fail', id: 1, message: 'The read was too long.' },
            { type: 'fail', id: 2, message: 'The read was not valid.' },
            { type: 'fail', id: 3, message: 'The read was not valid.' },
        ]);
        stop();

        // A read failing inside a tool is an error the tool did not understand: the generic words.
        const failing = { size: 10, read: async () => Promise.reject(new Error('network')) };
        const { finished } = runTool([failing], async (_i, { sources }) => sources[0]!.read(0, 4));
        expect(await finished).toEqual({
            type: 'fail',
            message: "This file couldn't be processed.",
        });
        // A refusal the tool understood keeps its words.
        const refused = runTool([memoryReader(new Uint8Array(4))], async () => {
            throw new ToolError('This PDF has a password.');
        });
        expect(await refused.finished).toEqual({
            type: 'fail',
            message: 'This PDF has a password.',
        });
    });

    test('a produced result is transferred to the page and the next waits for its acceptance', async () => {
        let produced = 0;
        let kept = -1;
        const { sent, finished, accept } = runTool([], async (_i, { produce }) => {
            const bytes = new Uint8Array(1024).fill(7);
            await produce('a.bin', bytes);
            kept = bytes.byteLength;
            produced++;
            await produce('b.bin', new Uint8Array(8));
            produced++;
            return 'ok';
        });
        const outputs = () =>
            sent.filter((m): m is Extract<ToPage, { type: 'output' }> => m.type === 'output');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(outputs()).toHaveLength(1);
        expect(outputs()[0]!.bytes.byteLength).toBe(1024);
        expect(produced).toBe(0);
        accept(0);
        await new Promise((resolve) => setTimeout(resolve, 20));
        // Moved, not copied: the worker no longer holds the first result.
        expect(kept).toBe(0);
        expect(produced).toBe(1);
        expect(outputs()).toHaveLength(2);
        accept(1);
        expect(await finished).toEqual({ type: 'done', result: 'ok' });
    });
});
