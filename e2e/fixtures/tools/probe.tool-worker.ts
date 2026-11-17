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
    | { mode: 'reach' };

const alive = new BroadcastChannel('probe');
// The page can't see a violation inside a worker: it is told, and its check fails on it.
self.addEventListener('securitypolicyviolation', (event) =>
    alive.postMessage({ violation: `${event.violatedDirective} ${event.blockedURI}` }),
);

/* Whether a fetch got an answer, or was refused before leaving. */
async function answered(url: string) {
    try {
        return (await fetch(url, { credentials: 'include' })).ok;
    } catch {
        return false;
    }
}

serveTool<Input, unknown>(async (input, { sources, progress, produce }) => {
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
    if (input.mode === 'reach') {
        return {
            api: await answered('/api/health'),
            own: await answered(import.meta.url),
        };
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
