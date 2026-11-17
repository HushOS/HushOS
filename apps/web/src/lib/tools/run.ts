import { PlaintextBudget } from './budget';
import {
    TOOL_BUDGET_BYTES,
    TOOL_FAILED,
    TOOL_WATCHDOG_MS,
    type ToPage,
    type ToWorker,
} from './protocol';
import { serveRanges, type RangeReader } from './ranges';
import { createWatchdog } from './watchdog';

/*
 * A tool run, from the page: one worker, its sources served by range, its results handed
 * to the save path under the produced-plaintext budget, a watchdog, and cancel by
 * terminating the worker (docs/file-tools-design.md, section 2 "Workers" and section 3).
 *
 * One run at a time per tab: a run started while another is going waits behind it, and
 * says which one. A run that ends any way but done terminates its worker, drops every
 * result the save path has not released (each buffer is detached, so a reference kept
 * anywhere holds nothing), and revokes the blob URLs it made. A run that is done
 * terminates its worker too; its results stay with the save path until released.
 */

export type ToolOutput = {
    name: string;
    mime: string | null;
    /* Detached (zero bytes) once the run fails or is cancelled before it was released. */
    bytes: ArrayBuffer;
    size: number;
    /* The upload has the bytes (or they are dropped): their room in the budget goes back. */
    release(): void;
};

export type ToolRunState =
    | { status: 'waiting'; behind: string }
    | { status: 'running'; done: number; total: number | null }
    | { status: 'done' }
    | { status: 'failed'; message: string }
    | { status: 'cancelled' };

export type ToolRunOptions<I> = {
    /* Names the run to one waiting behind it ("Extracting Photos.zip"). */
    label: string;
    /* A same-origin module worker: `new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })`. */
    worker: () => Worker;
    input: I;
    sources: RangeReader[];
    /* The save path. Without one, each result is dropped as it arrives. */
    onOutput?: (output: ToolOutput) => void;
    budgetBytes?: number;
    watchdogMs?: number;
};

export class ToolCancelled extends Error {
    constructor() {
        super('Cancelled.');
        this.name = 'ToolCancelled';
    }
}

export type ToolRun<R> = {
    /* Resolves with the tool's result; rejects with ToolCancelled, or an Error whose message is the person's. */
    result: Promise<R>;
    cancel(): void;
    getState(): ToolRunState;
    subscribe(listener: (state: ToolRunState) => void): () => void;
    /* A blob URL that belongs to the run: revoked if it fails or is cancelled. Once done, the caller's. */
    objectUrl(blob: Blob): string;
};

type Queued = { label: string; begin: () => void; behind: (label: string) => void };

let current: Queued | null = null;
const queue: Queued[] = [];

/* Results not yet released, across runs: while any wait, leaving the page asks first. */
let unreleased = 0;
function guardUnload(event: BeforeUnloadEvent) {
    event.preventDefault();
}
function countUnreleased(delta: number) {
    const before = unreleased;
    unreleased += delta;
    if (typeof window === 'undefined') return;
    if (before === 0 && unreleased > 0) window.addEventListener('beforeunload', guardUnload);
    if (before > 0 && unreleased === 0) window.removeEventListener('beforeunload', guardUnload);
}

function advance() {
    current = queue.shift() ?? null;
    if (!current) return;
    for (const waiting of queue) waiting.behind(current.label);
    current.begin();
}

/* Detaches a buffer, freeing its bytes wherever a reference to it is kept. */
function drop(buffer: ArrayBuffer) {
    try {
        const transfer = (buffer as ArrayBuffer & { transfer?: (length?: number) => ArrayBuffer })
            .transfer;
        if (transfer) transfer.call(buffer, 0);
        else structuredClone(buffer, { transfer: [buffer] });
    } catch {
        // Already detached: moved to the crypto worker for upload, or dropped before.
    }
}

export function startToolRun<I, R>(options: ToolRunOptions<I>): ToolRun<R> {
    const listeners = new Set<(state: ToolRunState) => void>();
    let state: ToolRunState = { status: 'running', done: 0, total: null };
    const urls = new Set<string>();
    const outputs = new Map<number, { buffer: ArrayBuffer; size: number }>();
    let settle: { resolve: (value: R) => void; reject: (error: Error) => void };
    const result = new Promise<R>((resolve, reject) => (settle = { resolve, reject }));
    // A caller that only watches the state still gets no unhandled rejection.
    result.catch(() => {});
    let ended = false;
    let teardown: (() => void) | null = null;

    function set(next: ToolRunState) {
        state = next;
        for (const listener of listeners) listener(state);
    }

    function finish(outcome: { ok: true; value: R } | { ok: false; error: Error }) {
        if (ended) return;
        ended = true;
        teardown?.();
        if (current === entry) advance();
        else {
            const at = queue.indexOf(entry);
            if (at >= 0) queue.splice(at, 1);
        }
        if (outcome.ok) {
            set({ status: 'done' });
            settle.resolve(outcome.value);
            return;
        }
        for (const output of outputs.values()) drop(output.buffer);
        countUnreleased(-outputs.size);
        outputs.clear();
        for (const url of urls) URL.revokeObjectURL(url);
        urls.clear();
        set(
            outcome.error instanceof ToolCancelled
                ? { status: 'cancelled' }
                : { status: 'failed', message: outcome.error.message },
        );
        settle.reject(outcome.error);
    }

    function begin() {
        if (ended) return;
        set({ status: 'running', done: 0, total: null });
        const budget = new PlaintextBudget(options.budgetBytes ?? TOOL_BUDGET_BYTES);
        const watchdog = createWatchdog(options.watchdogMs ?? TOOL_WATCHDOG_MS, () =>
            finish({ ok: false, error: new Error(TOOL_FAILED) }),
        );
        let worker: Worker;
        try {
            worker = options.worker();
        } catch {
            // Refused before it started (a policy, a browser without module workers).
            watchdog.stop();
            finish({ ok: false, error: new Error(TOOL_FAILED) });
            return;
        }
        const stops: (() => void)[] = [];
        teardown = () => {
            watchdog.stop();
            // Frees the worker's memory and WebAssembly heap. An idle worker stops at once; one busy
            // in a loop is stopped by Chromium up to two seconds later (e2e/tools-harness.spec.ts).
            worker.terminate();
            for (const stop of stops) stop();
            budget.close(new ToolCancelled());
        };
        const ports = options.sources.map((reader) => {
            const channel = new MessageChannel();
            stops.push(serveRanges(channel.port1, reader, () => watchdog.hold()));
            return { size: reader.size, port: channel.port2 };
        });

        function accept(id: number) {
            const message: ToWorker = { type: 'accepted', id };
            if (!budget.full) {
                worker.postMessage(message);
                return;
            }
            const release = watchdog.hold();
            budget.whenRoom().then(
                () => {
                    release();
                    if (!ended) worker.postMessage(message);
                },
                () => release(),
            );
        }

        worker.onmessage = (event: MessageEvent<ToPage>) => {
            if (ended) return;
            const msg = event.data;
            switch (msg?.type) {
                case 'progress':
                    watchdog.progress();
                    set({ status: 'running', done: msg.done, total: msg.total });
                    return;
                case 'output': {
                    watchdog.progress();
                    const size = msg.bytes.byteLength;
                    budget.take(size);
                    outputs.set(msg.id, { buffer: msg.bytes, size });
                    countUnreleased(1);
                    let released = false;
                    const output: ToolOutput = {
                        name: msg.name,
                        mime: msg.mime,
                        bytes: msg.bytes,
                        size,
                        release() {
                            if (released) return;
                            released = true;
                            if (outputs.delete(msg.id)) countUnreleased(-1);
                            budget.release(size);
                        },
                    };
                    try {
                        if (options.onOutput) options.onOutput(output);
                        else output.release();
                    } catch {
                        finish({ ok: false, error: new Error(TOOL_FAILED) });
                        return;
                    }
                    accept(msg.id);
                    return;
                }
                case 'done':
                    finish({ ok: true, value: msg.result as R });
                    return;
                case 'fail':
                    finish({ ok: false, error: new Error(msg.message || TOOL_FAILED) });
                    return;
                default:
                    finish({ ok: false, error: new Error(TOOL_FAILED) });
            }
        };
        // A worker that fails to load, throws outside the tool, or sends what can't be read.
        worker.onerror = (event) => {
            event.preventDefault?.();
            finish({ ok: false, error: new Error(TOOL_FAILED) });
        };
        worker.onmessageerror = () => finish({ ok: false, error: new Error(TOOL_FAILED) });
        const start: ToWorker = { type: 'start', input: options.input, sources: ports };
        worker.postMessage(
            start,
            ports.map((source) => source.port),
        );
    }

    const entry: Queued = {
        label: options.label,
        begin,
        behind: (label) => set({ status: 'waiting', behind: label }),
    };
    if (current) {
        queue.push(entry);
        set({ status: 'waiting', behind: current.label });
    } else {
        current = entry;
        begin();
    }

    return {
        result,
        cancel: () => finish({ ok: false, error: new ToolCancelled() }),
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        objectUrl(blob) {
            const url = URL.createObjectURL(blob);
            if (ended && state.status !== 'done') URL.revokeObjectURL(url);
            else if (!ended) urls.add(url);
            return url;
        },
    };
}
