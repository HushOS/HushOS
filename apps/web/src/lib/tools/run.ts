import { PREVIEW_LIMITS } from '@/lib/preview-limits';
import { trackToolRun } from './active';
import { toolBudget, type PlaintextBudget } from './budget';
import {
    RESULT_MAX_BYTES,
    TOOL_FAILED,
    TOOL_WATCHDOG_MS,
    type ToPage,
    type ToWorker,
} from './protocol';
import { readAllowance, serveRanges, type RangeReader } from './ranges';
import { createWatchdog } from './watchdog';

/*
 * A tool run, from the page: one worker, its sources served by range, its results handed
 * to the save path under the tab's produced-plaintext budget, a watchdog, and cancel by
 * terminating the worker (docs/file-tools-design.md, section 2 "Workers" and section 3).
 *
 * One run at a time per tab: a run started while another is going waits behind it, and
 * says which one. Viewers (browsing an archive, previewing an entry) are not runs and never
 * wait here. Every run, however it ends, terminates its worker and closes its sources. One
 * that ends any way but done also drops every result the save path has not released (each
 * buffer is detached, so a reference kept anywhere holds nothing, and its room in the budget
 * goes back) and revokes the blob URLs it made. A run that is done leaves its results with
 * the save path, counted in the budget until released, and stays known until then: a lock or
 * sign-out drops them as it would a cancelled run's (`cancelAllToolRuns`).
 *
 * Chromium lets a worker busy in a loop run for up to two seconds after terminate(); the
 * next run's worker may start meanwhile, so two heaps can overlap for that long.
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
    /* A same-origin module worker: `new Worker(new URL('./x.tool-worker.ts', import.meta.url), { type: 'module' })`. */
    worker: () => Worker;
    input: I;
    /* The run owns them: each is closed when the run ends. */
    sources: RangeReader[];
    /*
     * WebAssembly the worker needs, compiled on the page (compileWasm), and data files: the
     * worker's policy lets it fetch and load nothing, so the page hands over all it uses.
     * Files are copied, not moved, so one fetched once can serve every run.
     */
    modules?: Record<string, WebAssembly.Module>;
    files?: Record<string, ArrayBuffer>;
    /* The save path. Without one, each result is dropped as it arrives. */
    onOutput?: (output: ToolOutput) => void;
    /* The tab's budget unless a test brings its own. */
    budget?: PlaintextBudget;
    watchdogMs?: number;
    /* The person's words for each refusal code the tool may send; any other failure is TOOL_FAILED. */
    refusals?: Record<string, string>;
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
    /*
     * A blob URL that belongs to the run: revoked if it fails or is cancelled, the caller's
     * once done. At most the preview limit of `kind`: Chrome can page a larger Blob to disk.
     */
    objectUrl(blob: Blob, kind: keyof typeof PREVIEW_LIMITS): string;
};

type Queued = {
    label: string;
    begin: () => void;
    behind: (label: string) => void;
    fail: () => void;
};

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
    const next = current;
    try {
        next.begin();
    } catch {
        // Its own failure, never the run that just ended: that one has settled already.
        next.fail();
    }
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
    const budget = options.budget ?? toolBudget;
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
        for (const listener of listeners) {
            try {
                listener(state);
            } catch {
                // A listener's failure is its own; the run goes on, and so do the others.
            }
        }
    }

    /*
     * Every result the save path has not released goes: its buffer detached, so a reference kept
     * anywhere holds nothing, and its room in the budget back. Then the run is forgotten.
     */
    function dropOutputs() {
        for (const output of outputs.values()) {
            drop(output.buffer);
            budget.release(output.size);
        }
        countUnreleased(-outputs.size);
        outputs.clear();
        untrack();
    }

    function finish(outcome: { ok: true; value: R } | { ok: false; error: Error }) {
        if (ended) return;
        ended = true;
        // Its own clean-up and settling first; only then the next run.
        try {
            teardown?.();
        } catch {
            // Terminating and closing ports do not throw; nothing here may keep the run from settling.
        }
        for (const source of options.sources)
            void Promise.resolve()
                .then(() => source.close?.())
                .catch(() => {});
        if (!outcome.ok) {
            dropOutputs();
            for (const url of urls) URL.revokeObjectURL(url);
            urls.clear();
        } else if (outputs.size === 0) {
            untrack();
        }
        // Done with results still waiting for upload: the run stays known until the last is
        // released, so a lock or sign-out meanwhile still drops them (endForAccount).
        if (outcome.ok) {
            set({ status: 'done' });
            settle.resolve(outcome.value);
        } else {
            set(
                outcome.error instanceof ToolCancelled
                    ? { status: 'cancelled' }
                    : { status: 'failed', message: outcome.error.message },
            );
            settle.reject(outcome.error);
        }
        if (current === entry) advance();
        else {
            const at = queue.indexOf(entry);
            if (at >= 0) queue.splice(at, 1);
        }
    }

    const failed = () => finish({ ok: false, error: new Error(TOOL_FAILED) });

    function begin() {
        if (ended) return;
        set({ status: 'running', done: 0, total: null });
        const watchdog = createWatchdog(options.watchdogMs ?? TOOL_WATCHDOG_MS, failed);
        let worker: Worker;
        try {
            worker = options.worker();
        } catch {
            // Refused before it started (a policy, a browser without module workers).
            watchdog.stop();
            failed();
            return;
        }
        const stops: (() => void)[] = [];
        let stopWaiting = () => {};
        teardown = () => {
            watchdog.stop();
            stopWaiting();
            // Frees the worker's memory and WebAssembly heap. An idle worker stops at once; one busy
            // in a loop is stopped by Chromium up to two seconds later (e2e/tools-harness.spec.ts).
            worker.terminate();
            for (const stop of stops) stop();
        };
        const allowance = readAllowance();
        const ports = options.sources.map((reader) => {
            const channel = new MessageChannel();
            stops.push(
                serveRanges(channel.port1, reader, {
                    hold: () => watchdog.hold(),
                    allowance,
                    onAbuse: failed,
                }),
            );
            return { size: reader.size, port: channel.port2 };
        });

        // The output the worker waits on the page to accept; it may send no other meanwhile.
        let awaiting: number | null = null;
        let nextId = 0;
        function accept(id: number) {
            const message: ToWorker = { type: 'accepted', id };
            const release = budget.full ? watchdog.hold() : () => {};
            stopWaiting = budget.whenRoom(() => {
                release();
                if (ended) return;
                awaiting = null;
                worker.postMessage(message);
            });
        }

        function take(msg: Extract<ToPage, { type: 'output' }>) {
            const bytes: unknown = msg.bytes;
            if (
                awaiting !== null ||
                msg.id !== nextId ||
                !(bytes instanceof ArrayBuffer) ||
                bytes.byteLength > RESULT_MAX_BYTES
            ) {
                // Not pacing itself, an id seen before, or more than one upload can hold.
                if (bytes instanceof ArrayBuffer) drop(bytes);
                failed();
                return;
            }
            nextId++;
            awaiting = msg.id;
            watchdog.progress();
            const size = bytes.byteLength;
            budget.take(size);
            outputs.set(msg.id, { buffer: bytes, size });
            countUnreleased(1);
            let released = false;
            const output: ToolOutput = {
                name: String(msg.name),
                mime: typeof msg.mime === 'string' ? msg.mime : null,
                bytes,
                size,
                release() {
                    if (released) return;
                    released = true;
                    if (!outputs.delete(msg.id)) return;
                    countUnreleased(-1);
                    budget.release(size);
                    if (ended && outputs.size === 0) untrack();
                },
            };
            try {
                if (options.onOutput) options.onOutput(output);
                else output.release();
            } catch {
                failed();
                return;
            }
            accept(msg.id);
        }

        worker.onmessage = (event: MessageEvent<ToPage>) => {
            if (ended) return;
            const msg = event.data;
            switch (msg?.type) {
                case 'progress':
                    watchdog.progress();
                    set({
                        status: 'running',
                        done: Number(msg.done) || 0,
                        total: typeof msg.total === 'number' ? msg.total : null,
                    });
                    return;
                case 'output':
                    take(msg);
                    return;
                case 'done':
                    finish({ ok: true, value: msg.result as R });
                    return;
                case 'fail': {
                    const code = typeof msg.code === 'string' ? msg.code : null;
                    const words =
                        code !== null && options.refusals && Object.hasOwn(options.refusals, code)
                            ? options.refusals[code]!
                            : TOOL_FAILED;
                    finish({ ok: false, error: new Error(words) });
                    return;
                }
                default:
                    failed();
            }
        };
        // A worker that fails to load, throws outside the tool, or sends what can't be read.
        worker.onerror = (event) => {
            event.preventDefault?.();
            failed();
        };
        worker.onmessageerror = failed;
        const start: ToWorker = {
            type: 'start',
            input: options.input,
            sources: ports,
            modules: options.modules ?? {},
            files: options.files ?? {},
        };
        try {
            worker.postMessage(
                start,
                ports.map((source) => source.port),
            );
        } catch {
            // An input that can't be cloned.
            failed();
        }
    }

    const entry: Queued = {
        label: options.label,
        begin,
        behind: (label) => set({ status: 'waiting', behind: label }),
        fail: failed,
    };
    const cancel = () => finish({ ok: false, error: new ToolCancelled() });
    /* A lock or sign-out: a run going or waiting is cancelled; one done drops what it still holds. */
    const endForAccount = () => (ended ? dropOutputs() : cancel());
    const untrack = trackToolRun(endForAccount);
    if (current) {
        queue.push(entry);
        set({ status: 'waiting', behind: current.label });
    } else {
        current = entry;
        try {
            begin();
        } catch {
            failed();
        }
    }

    return {
        result,
        cancel,
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        objectUrl(blob, kind) {
            if (blob.size > PREVIEW_LIMITS[kind])
                throw new Error('This is too large to show here.');
            const url = URL.createObjectURL(blob);
            if (ended && state.status !== 'done') URL.revokeObjectURL(url);
            else if (!ended) urls.add(url);
            return url;
        },
    };
}
