import { PREVIEW_LIMITS } from '@/lib/preview-limits';
import { trackToolRun } from './active';
import { toolBudget, type PlaintextBudget } from './budget';
import {
    DONE_RESULT_MAX_BYTES,
    OUTPUT_MIME_MAX,
    OUTPUT_MIN_CHARGE,
    OUTPUT_NAME_MAX,
    OUTPUTS_UNRELEASED_MAX,
    RESULT_MAX_BYTES,
    RUN_OUTPUTS_MAX,
    RUN_TOTAL_BYTES_MAX,
    TOOL_FAILED,
    TOOL_WATCHDOG_MS,
    type ToPage,
    type ToWorker,
} from './protocol';
import { readAllowance, serveRanges, type RangeReader } from './ranges';
import { createWatchdog } from './watchdog';
import { holdPageWhile } from '@/lib/leave-guard';

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
    /*
     * The most results the run may produce, and their bytes in all (RUN_OUTPUTS_MAX and
     * RUN_TOTAL_BYTES_MAX unless the run sets its own): the page fails the run past either,
     * whatever the worker says.
     */
    maxOutputs?: number;
    maxTotalBytes?: number;
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
    started: () => boolean;
};

let current: Queued | null = null;
const queue: Queued[] = [];

/* Results not yet released, across runs: while any wait, leaving the page asks first (lib/leave-guard.ts). */
let unreleased = 0;
let holding = false;
function countUnreleased(delta: number) {
    unreleased += delta;
    if (holding || unreleased <= 0) return;
    holding = true;
    holdPageWhile(() => unreleased > 0);
}

function advance() {
    const next = queue.shift() ?? null;
    current = next;
    if (!next) return;
    for (const waiting of queue) waiting.behind(next.label);
    // A listener told who is ahead may have cancelled `next`, and advanced past it, meanwhile:
    // only the run still chosen, and not started yet, is started, and only once.
    if (current !== next || next.started()) return;
    try {
        next.begin();
    } catch {
        // Its own failure, never the run that just ended: that one has settled already.
        next.fail();
    }
}

/*
 * A run's result, rebuilt on the page as a plain summary: the worker's value is never kept, only
 * a fresh copy made of primitives, arrays (indices 0 to length - 1, nothing else) and objects
 * whose prototype is Object's or null (own enumerable string keys, nothing else). Anything else
 * (a buffer, a typed array, a Blob, a Map, a class instance, a named property on an array, a
 * symbol key) is either refused, failing the run, or left out of the copy, so no bytes reach
 * `result`. A worker taken over could otherwise hand back plaintext there, past the per-result
 * limit and the budget, kept by the page after a lock; or a value built to hold the page's own
 * thread, which the watchdog could not stop, since it runs on that thread. So the walk visits at
 * most SUMMARY_NODES values, refuses any object it meets twice (shared references included),
 * any array or object with more than SUMMARY_ENTRIES entries and any nesting past 32, and counts
 * every string and key against DONE_RESULT_MAX_BYTES, all before anything is kept.
 */
const SUMMARY_NODES = 10_000;
const SUMMARY_ENTRIES = 4_096;
const REFUSED = Symbol('refused');
function summaryOf(value: unknown): { value: unknown } | null {
    let nodes = 0;
    let text = 0;
    const seen = new Set<object>();
    const counted = (length: number) => (text += length) <= DONE_RESULT_MAX_BYTES;
    const copy = (item: unknown, depth: number): unknown => {
        if (++nodes > SUMMARY_NODES || depth > 32) return REFUSED;
        if (item === null || item === undefined || typeof item === 'boolean') return item;
        if (typeof item === 'number') return counted(24) ? item : REFUSED;
        if (typeof item === 'string') return counted(item.length) ? item : REFUSED;
        if (typeof item !== 'object' || seen.has(item)) return REFUSED;
        seen.add(item);
        const prototype = Object.getPrototypeOf(item);
        if (Array.isArray(item)) {
            if (prototype !== Array.prototype || item.length > SUMMARY_ENTRIES) return REFUSED;
            const out: unknown[] = [];
            for (let i = 0; i < item.length; i++) {
                const entry = copy(item[i], depth + 1);
                if (entry === REFUSED) return REFUSED;
                out.push(entry);
            }
            return out;
        }
        if (prototype !== Object.prototype && prototype !== null) return REFUSED;
        const out: Record<string, unknown> = {};
        let entries = 0;
        for (const key of Object.keys(item)) {
            if (++entries > SUMMARY_ENTRIES || !counted(key.length)) return REFUSED;
            const entry = copy((item as Record<string, unknown>)[key], depth + 1);
            if (entry === REFUSED) return REFUSED;
            // Defined, not assigned: a key named __proto__ stays a key.
            Object.defineProperty(out, key, {
                value: entry,
                enumerable: true,
                writable: true,
                configurable: true,
            });
        }
        return out;
    };
    try {
        const rebuilt = copy(value, 0);
        return rebuilt === REFUSED ? null : { value: rebuilt };
    } catch {
        // A value that throws when read (only something the page made could): refused.
        return null;
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

/* A run's cap as given, or its default: NaN, Infinity, zero or a fraction would quietly turn it off, so they throw. */
function capOf(name: string, value: number | undefined, fallback: number) {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError(`${name} must be a positive whole number, not ${value}.`);
    return value;
}

export function startToolRun<I, R>(options: ToolRunOptions<I>): ToolRun<R> {
    /*
     * What the run needs, copied out: no function below may reach `options`, and what is heavy
     * (the sources, which may hold a whole decrypted file, the input, the WebAssembly and files)
     * is let go when the run ends, so a handle kept after that holds none of it.
     */
    const { label, refusals } = options;
    const budget = options.budget ?? toolBudget;
    const watchdogMs = options.watchdogMs ?? TOOL_WATCHDOG_MS;
    const maxOutputs = capOf('maxOutputs', options.maxOutputs, RUN_OUTPUTS_MAX);
    const maxTotalBytes = capOf('maxTotalBytes', options.maxTotalBytes, RUN_TOTAL_BYTES_MAX);
    // Each closed once: when the worker says it is done with it (its reads over), or when the run ends.
    let sources: RangeReader[] = options.sources.map((source) => {
        let closing: Promise<void> | undefined;
        return {
            ...source,
            read: source.read.bind(source),
            close: () => (closing ??= Promise.resolve().then(() => source.close?.())),
        };
    });
    let launch: {
        worker: () => Worker;
        input: I;
        modules: Record<string, WebAssembly.Module>;
        files: Record<string, ArrayBuffer>;
        onOutput: ((output: ToolOutput) => void) | undefined;
    } | null = {
        worker: options.worker,
        input: options.input,
        modules: options.modules ?? {},
        files: options.files ?? {},
        onOutput: options.onOutput,
    };
    const listeners = new Set<(state: ToolRunState) => void>();
    let state: ToolRunState = { status: 'running', done: 0, total: null };
    const urls = new Set<string>();
    // Each result's buffer and what it was charged against the budget.
    const outputs = new Map<number, { buffer: ArrayBuffer; charge: number }>();
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
            budget.release(output.charge);
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
        teardown = null;
        launch = null;
        const closing = sources;
        sources = [];
        for (const source of closing)
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

    let started = false;
    function begin() {
        if (ended || started) return;
        started = true;
        set({ status: 'running', done: 0, total: null });
        // A listener told it is running may have cancelled it (or every run): nothing is started.
        if (ended || !launch) return;
        const { input, modules, files } = launch;
        const watchdog = createWatchdog(watchdogMs, failed);
        let worker: Worker;
        try {
            worker = launch.worker();
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
            // A result still held keeps this scope: the stops (and through them the sources) go.
            stops.length = 0;
        };
        const allowance = readAllowance();
        const ports = sources.map((reader) => {
            const channel = new MessageChannel();
            stops.push(
                serveRanges(channel.port1, reader, {
                    hold: () => watchdog.hold(),
                    allowance,
                    onAbuse: failed,
                    // Read whole: its chunks and key go now, not when the run's last image is done.
                    onDone: () => void Promise.resolve(reader.close?.()).catch(() => {}),
                }),
            );
            return { size: reader.size, port: channel.port2 };
        });

        // The output the worker waits on the page to accept; it may send no other meanwhile.
        let awaiting: number | null = null;
        // What the run has produced in all, released or not.
        let producedBytes = 0;
        let nextId = 0;
        // Set while the run holds OUTPUTS_UNRELEASED_MAX results: a release lets the next in.
        let belowCap: (() => void) | null = null;
        function accept(id: number) {
            if (outputs.size >= OUTPUTS_UNRELEASED_MAX) {
                const release = watchdog.hold();
                belowCap = () => {
                    belowCap = null;
                    release();
                    accept(id);
                };
                stopWaiting = () => {
                    belowCap = null;
                    release();
                };
                return;
            }
            const message: ToWorker = { type: 'accepted', id };
            const release = budget.full ? watchdog.hold() : () => {};
            stopWaiting = budget.whenRoom(() => {
                release();
                if (ended) return;
                awaiting = null;
                worker.postMessage(message);
            });
        }

        /*
         * A result, already copied out of the worker's message: nothing here, nor the record handed
         * to the save path, nor its release(), may reach that message, so anything else it carried
         * (another buffer, say) is garbage once the handler returns.
         */
        function take(id: number, name: string, mime: string | null, bytes: ArrayBuffer) {
            nextId++;
            awaiting = id;
            watchdog.progress();
            const size = bytes.byteLength;
            const charge = Math.max(size, OUTPUT_MIN_CHARGE);
            budget.take(charge);
            outputs.set(id, { buffer: bytes, charge });
            countUnreleased(1);
            let released = false;
            const output: ToolOutput = {
                name,
                mime,
                bytes,
                size,
                release() {
                    if (released) return;
                    released = true;
                    if (!outputs.delete(id)) return;
                    countUnreleased(-1);
                    budget.release(charge);
                    if (ended && outputs.size === 0) untrack();
                    else if (belowCap && outputs.size < OUTPUTS_UNRELEASED_MAX) belowCap();
                },
            };
            try {
                const onOutput = launch?.onOutput;
                if (onOutput) onOutput(output);
                else output.release();
            } catch {
                failed();
                return;
            }
            accept(id);
        }

        /*
         * Every message from the worker is read here once, and only checked scalars (and one checked
         * buffer) go on: the message itself is never kept, nor reached by anything made from it.
         */
        worker.onmessage = (event: MessageEvent<ToPage>) => {
            if (ended) return;
            const msg = event.data as Record<string, unknown> | null;
            switch (msg?.type) {
                case 'progress': {
                    const done: unknown = msg.done;
                    const total: unknown = msg.total;
                    watchdog.progress();
                    set({
                        status: 'running',
                        done: typeof done === 'number' && Number.isFinite(done) ? done : 0,
                        total: typeof total === 'number' && Number.isFinite(total) ? total : null,
                    });
                    return;
                }
                case 'output': {
                    const id: unknown = msg.id;
                    const bytes: unknown = msg.bytes;
                    const name: unknown = msg.name;
                    const mime: unknown = msg.mime;
                    if (
                        awaiting !== null ||
                        id !== nextId ||
                        // Outside the budget, so held to a size: a name or type is never a way to carry bytes.
                        typeof name !== 'string' ||
                        name.length > OUTPUT_NAME_MAX ||
                        (mime !== null &&
                            (typeof mime !== 'string' || mime.length > OUTPUT_MIME_MAX)) ||
                        !(bytes instanceof ArrayBuffer) ||
                        bytes.byteLength > RESULT_MAX_BYTES ||
                        // Past the run's caps: ids count from 0, so nextId results came before.
                        nextId + 1 > maxOutputs ||
                        producedBytes + bytes.byteLength > maxTotalBytes
                    ) {
                        // Not pacing itself, an id seen before, more than one upload can hold, or
                        // more than the run may produce.
                        if (bytes instanceof ArrayBuffer) drop(bytes);
                        failed();
                        return;
                    }
                    producedBytes += bytes.byteLength;
                    take(nextId, name, mime, bytes);
                    return;
                }
                case 'done': {
                    // Not while a result still waits for room: that would leave the budget for
                    // the next run to pass, and the next, unbounded.
                    if (awaiting !== null) {
                        failed();
                        return;
                    }
                    // A summary only, rebuilt here: bytes come as outputs, counted and dropped on a lock.
                    const summary = summaryOf(msg.result);
                    if (!summary) {
                        failed();
                        return;
                    }
                    finish({ ok: true, value: summary.value as R });
                    return;
                }
                case 'fail': {
                    const code = typeof msg.code === 'string' ? msg.code : null;
                    const words =
                        code !== null && refusals && Object.hasOwn(refusals, code)
                            ? refusals[code]!
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
            input,
            sources: ports,
            modules,
            files,
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
        label,
        begin,
        behind: (label) => set({ status: 'waiting', behind: label }),
        fail: failed,
        started: () => started,
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
