import { PlaintextBudget } from '../../../apps/web/src/lib/tools/budget';
import { memoryReader } from '../../../apps/web/src/lib/tools/ranges';
import { startToolRun, type ToolOutput, type ToolRun } from '../../../apps/web/src/lib/tools/run';

/*
 * The page e2e/tools-harness.spec.ts drives: the real harness and a real module worker,
 * bundled by Vite and served under the production Content Security Policy (the worker under
 * the tools worker's own). Everything the spec needs is on `window.tools`.
 */

const violations: string[] = [];
document.addEventListener('securitypolicyviolation', (event) =>
    violations.push(`${event.violatedDirective} ${event.blockedURI}`),
);

/*
 * When the worker last said it was alive, by its own clock (Date.now, shared with the page),
 * and any policy violation inside it, which a page listener would never see.
 */
let lastBeat = 0;
const beats = new BroadcastChannel('probe');
beats.onmessage = (event: MessageEvent<number | { violation: string }>) => {
    if (typeof event.data === 'number') lastBeat = Math.max(lastBeat, event.data);
    else violations.push(`worker: ${event.data.violation}`);
};

const probe = () =>
    new Worker(new URL('./probe.tool-worker.ts', import.meta.url), { type: 'module' });

/* A source that is not periodic, so bytes read from the wrong offset change the digest. */
function sourceBytes(size: number) {
    const bytes = new Uint8Array(size);
    let x = 0x9e3779b9;
    for (let i = 0; i < size; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        bytes[i] = x & 0xff;
    }
    return bytes;
}

async function hex(bytes: Uint8Array<ArrayBuffer>) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

let current: ToolRun<unknown> | null = null;
const held: ToolOutput[] = [];
let autoRelease = false;
let url: string | null = null;

const settled = (run: ToolRun<unknown>) =>
    run.result.then(
        (value) => ({ ok: true as const, value }),
        (error: Error) => ({ ok: false as const, message: error.message, name: error.name }),
    );

const tools = {
    violations: () => violations,
    clearViolations: () => void violations.splice(0),
    /* The worker's last sign of life, and now, both by Date.now. */
    lastBeat: () => lastBeat,
    now: () => Date.now(),
    state: () => current?.getState() ?? null,

    async digest(size: number, offset: number, length: number, step: number) {
        const bytes = sourceBytes(size);
        const expected = await hex(bytes.subarray(offset, Math.min(size, offset + length)));
        current = startToolRun({
            label: 'Digest',
            worker: probe,
            input: { mode: 'digest', offset, length, step },
            sources: [memoryReader(bytes)],
        });
        const outcome = await settled(current);
        return { outcome, expected, sourceIntact: bytes.byteLength === size };
    },

    async spin(watchdogMs: number) {
        const started = performance.now();
        current = startToolRun({
            label: 'Spin',
            worker: probe,
            input: { mode: 'spin' },
            sources: [],
            watchdogMs,
        });
        const outcome = await settled(current);
        return { outcome, elapsed: performance.now() - started };
    },

    /* Produces `count` results of `size` bytes; the page keeps each until `release`. */
    produce(count: number, size: number, budgetBytes: number) {
        held.length = 0;
        autoRelease = false;
        current = startToolRun({
            label: 'Produce',
            worker: probe,
            input: { mode: 'produce', count, size },
            sources: [],
            budget: new PlaintextBudget(budgetBytes),
            onOutput: (output) => {
                held.push(output);
                if (autoRelease) output.release();
            },
        });
        // A 1x1 PNG the run owns, as a preview's would be.
        const png = Uint8Array.from(
            atob(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            ),
            (c) => c.charCodeAt(0),
        );
        url = current.objectUrl(new Blob([png], { type: 'image/png' }), 'image');
        void settled(current).then(
            (outcome) => ((window as unknown as Record<string, unknown>).produced = outcome),
        );
    },
    received: () => held.length,
    heldBytes: () => held.map((output) => output.bytes.byteLength),
    releaseAll() {
        for (const output of held) output.release();
    },
    /* From now on, release each result as it arrives. */
    releaseAsTheyCome() {
        autoRelease = true;
        for (const output of held) output.release();
    },
    /* What the worker could reach: this origin's API (with the person's cookie), and its own assets. */
    async reach() {
        current = startToolRun({
            label: 'Reach',
            worker: probe,
            input: { mode: 'reach' },
            sources: [],
        });
        return settled(current);
    },
    cancel: () => current?.cancel(),
    produced: () => (window as unknown as Record<string, unknown>).produced ?? null,
    /* Whether the run's blob URL still loads. */
    urlLoads: () =>
        new Promise<boolean>((resolve) => {
            const img = new Image();
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
            img.src = url!;
        }),
};

(window as unknown as { tools: typeof tools }).tools = tools;
