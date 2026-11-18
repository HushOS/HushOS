// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/*
 * The download service worker (public/download-sw.js) as the browser runs it: a chunk is
 * acknowledged to the page only when the browser pulls it from the download's stream. A paused
 * download holds the page at one chunk; nothing piles up in the worker.
 */

type Handler = (event: unknown) => void;

function loadWorker() {
    const handlers = new Map<string, Handler>();
    const self = {
        addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
        registration: { scope: 'https://hushos.test/hushos-download/' },
        location: { origin: 'https://hushos.test' },
        skipWaiting: () => {},
        clients: { claim: async () => {} },
    };
    const source = readFileSync(join(import.meta.dirname, '../../public/download-sw.js'), 'utf8');
    // Run as the browser runs it: its own global scope, with what a worker has.
    runInNewContext(source, {
        self,
        ReadableStream,
        Headers,
        Request,
        Response,
        URL,
        Map,
        Promise,
        Uint8Array,
        Error,
        encodeURIComponent,
        decodeURIComponent,
    });
    return handlers;
}

describe('a download through the service worker', () => {
    it('is acknowledged as the browser pulls it: a paused download holds the page at one chunk', async () => {
        const handlers = loadWorker();
        const channel = new MessageChannel();
        const answers: { type: string; url?: string }[] = [];
        channel.port1.onmessage = (event) => answers.push(event.data);
        handlers.get('message')!({
            data: { type: 'start', id: 'd1', filename: 'part.bin', size: 3 },
            ports: [channel.port2],
        });
        const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
        await tick();
        const url = answers.find((answer) => answer.type === 'ready')!.url!;
        let response: Response | null = null;
        handlers.get('fetch')!({
            request: new Request(url),
            respondWith: (answer: Response) => (response = answer),
        });
        const acks = () => answers.filter((answer) => answer.type === 'ack').length;
        // The page sends one chunk; the browser hasn't read: no acknowledgement, so the page waits.
        channel.port1.postMessage({ type: 'chunk', chunk: Uint8Array.of(1).buffer });
        await tick();
        expect(acks()).toBe(0);
        // The browser pulls it: acknowledged, and only then may the next come.
        const reader = response!.body!.getReader();
        expect([...(await reader.read()).value!]).toEqual([1]);
        await tick();
        expect(acks()).toBe(1);
        // A pull waiting before the chunk arrives takes it as it comes.
        const next = reader.read();
        channel.port1.postMessage({ type: 'chunk', chunk: Uint8Array.of(2, 3).buffer });
        expect([...(await next).value!]).toEqual([2, 3]);
        await tick();
        expect(acks()).toBe(2);
        channel.port1.postMessage({ type: 'end' });
        expect((await reader.read()).done).toBe(true);
        channel.port1.close();
    });

    it('settles a held chunk on an abort before the browser pulled it, and drops it', async () => {
        const handlers = loadWorker();
        const channel = new MessageChannel();
        const answers: { type: string; url?: string }[] = [];
        channel.port1.onmessage = (event) => answers.push(event.data);
        handlers.get('message')!({
            data: { type: 'start', id: 'd2', filename: 'part.bin', size: 1 },
            ports: [channel.port2],
        });
        const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
        await tick();
        const url = answers.find((answer) => answer.type === 'ready')!.url!;
        let response: Response | null = null;
        handlers.get('fetch')!({
            request: new Request(url),
            respondWith: (answer: Response) => (response = answer),
        });
        // A chunk held for a pull, then the page aborts before the browser read anything.
        channel.port1.postMessage({ type: 'chunk', chunk: Uint8Array.of(9).buffer });
        await tick();
        channel.port1.postMessage({ type: 'abort' });
        await tick();
        // The page's waiting write hears it (never an acknowledgement), and the stream ends in error.
        expect(answers.map((answer) => answer.type)).toEqual(['ready', 'cancelled']);
        await expect(response!.body!.getReader().read()).rejects.toThrow('Download aborted.');
        channel.port1.close();
    });
});
