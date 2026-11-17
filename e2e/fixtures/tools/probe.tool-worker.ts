import { serveTool } from '../../../apps/web/src/lib/tools/worker';

/*
 * The smallest tools worker, for e2e/tools-harness.spec.ts only: it never ships. It digests a
 * range of its source, spins without reporting progress, or produces results. While it runs
 * it says it is alive on a BroadcastChannel, so the page can tell a terminated worker (silent
 * at once) from one that was only told to stop.
 */

type Input =
    | { mode: 'digest'; offset: number; length: number; step: number }
    | { mode: 'spin' }
    | { mode: 'produce'; count: number; size: number }
    | { mode: 'escape' }
    | { mode: 'wasm' };

const alive = new BroadcastChannel('probe');
// The page can't see a violation inside a worker: it is told, and its check fails on it.
self.addEventListener('securitypolicyviolation', (event) =>
    alive.postMessage({ violation: `${event.violatedDirective} ${event.blockedURI}` }),
);

/*
 * Every way a worker taken over by a hostile file might carry plaintext to this origin's server
 * (with the person's cookie): each is tried, and the test then looks for any of them in the
 * server's log. Whether each threw here is reported, but what counts is the log.
 */
async function escape() {
    const tried: Record<string, string> = {};
    const attempt = async (name: string, go: () => unknown) => {
        try {
            await go();
            tried[name] = 'went';
        } catch (error) {
            tried[name] = `refused: ${String(error).slice(0, 80)}`;
        }
    };
    const leak = 'PLAINTEXT';
    await attempt(
        'import /api',
        () => import(/* @vite-ignore */ `/api/health?via=import&q=${leak}`),
    );
    await attempt(
        'import /assets',
        () => import(/* @vite-ignore */ `/assets/x.js?via=import&q=${leak}`),
    );
    await attempt('importScripts', () =>
        (self as unknown as { importScripts(url: string): void }).importScripts(
            `/assets/y.js?via=importScripts&q=${leak}`,
        ),
    );
    await attempt('fetch /api', () =>
        fetch(`/api/health?via=fetch&q=${leak}`, { credentials: 'include' }),
    );
    await attempt('fetch /assets', () => fetch(`/assets/z?via=fetch&q=${leak}`));
    await attempt('xhr', () => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', `/api/health?via=xhr&q=${leak}`, false);
        xhr.send();
    });
    await attempt('websocket', () => new WebSocket(`ws://${location.host}/api?via=ws&q=${leak}`));
    await attempt('worker', async () => {
        new Worker(`/assets/w.js?via=worker&q=${leak}`);
        await new Promise((resolve) => setTimeout(resolve, 300));
    });
    // Anything still on its way gets the time to arrive before the test reads the log.
    await new Promise((resolve) => setTimeout(resolve, 300));
    return tried;
}

serveTool<Input, unknown>(async (input, { sources, modules, progress, produce }) => {
    if (input.mode === 'digest') {
        const source = sources[0]!;
        const end = Math.min(source.size, input.offset + input.length);
        const out = new Uint8Array(end - input.offset);
        for (let at = input.offset; at < end; at += input.step) {
            out.set(await source.read(at, Math.min(input.step, end - at)), at - input.offset);
            progress(at - input.offset, out.byteLength);
        }
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', out));
        return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    if (input.mode === 'escape') return escape();
    if (input.mode === 'wasm') {
        // Compiled on the page, which is the only way WebAssembly reaches a tools worker.
        const instance = await WebAssembly.instantiate(modules.add!, {});
        return (instance.exports.add as (a: number, b: number) => number)(2, 3);
    }
    if (input.mode === 'spin') {
        // A parser stuck in a loop: busy, never yielding, never reporting progress.
        let last = 0;
        for (;;) {
            const now = Date.now();
            if (now - last >= 20) {
                last = now;
                alive.postMessage(now);
            }
        }
    }
    const beat = setInterval(() => alive.postMessage(Date.now()), 20);
    try {
        for (let i = 0; i < input.count; i++) {
            await produce(`out-${i}.bin`, new Uint8Array(input.size).fill(i & 0xff));
            progress(i + 1, input.count);
        }
        return input.count;
    } finally {
        clearInterval(beat);
    }
});
