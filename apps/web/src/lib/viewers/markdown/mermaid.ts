import { preloadOwnsDiagrams } from '@/lib/viewers/markdown/diagram-owner';
import type { DiagramOutcome } from '@/lib/viewers/markdown/mermaid-render';

/*
 * Mermaid diagrams for the Markdown renderer (components/drive/viewers/rich-text.tsx): drawn by pele in a worker
 * of their own (lib/viewers/markdown/mermaid.worker.ts), which the viewers' post-unlock preload fetches whole
 * (lib/viewers/preload.ts). Until then a diagram stays its code: drawing it before would fetch the worker and
 * say that a file with a diagram was just opened.
 *
 * One diagram at a time: the worker draws synchronously, so the queue is kept here and each diagram's
 * time starts when it is handed over, never while it waits behind others. One that takes too long ends
 * the worker; it alone fails, and the rest go on in a new worker from the same (cached) file.
 */

/* How long one diagram may take, from the moment the worker is given it. */
export const DIAGRAM_TIMEOUT = 8_000;
/*
 * How long a worker may take to say it has loaded, the first or a replacement. One that hasn't by then
 * is ended as one that couldn't start: diagrams are off, and every diagram waiting says it failed.
 */
export const STARTUP_TIMEOUT = 30_000;

/* Whether diagrams can be drawn: waiting for the preload, ready, or failed (the worker couldn't start). */
export type DiagramsState = 'waiting' | 'ready' | 'failed';

let state: DiagramsState = 'waiting';
let announce: () => void = () => {};
const settled = new Promise<void>((resolve) => {
    announce = resolve;
});
let started = false;
/*
 * The diagram worker, whether it has said it loaded, and its startup deadline (cleared once it has): one
 * that fails or stalls before then is not started again.
 */
let worker: { worker: Worker; loaded: boolean; startup: ReturnType<typeof setTimeout> } | null =
    null;
let next = 0;

type Job = {
    id: number;
    source: string;
    settle: (outcome: DiagramOutcome) => void;
    cancelled: boolean;
};
const queue: Job[] = [];
let running: { job: Job; timer: ReturnType<typeof setTimeout> } | null = null;

function settle(now: DiagramsState) {
    if (state !== 'waiting') return;
    state = now;
    announce();
}

function failAll() {
    for (const job of queue.splice(0)) job.settle({ failure: 'failed' });
}

function startWorker() {
    const made = new Worker(new URL('./mermaid.worker.ts', import.meta.url), {
        type: 'module',
        name: 'mermaid',
    });
    const entry = {
        worker: made,
        loaded: false,
        startup: setTimeout(() => {
            if (worker === entry && !entry.loaded) giveUp();
        }, STARTUP_TIMEOUT),
    };
    made.onmessage = (
        event: MessageEvent<{ kind: 'ready' } | { id: number; outcome: DiagramOutcome }>,
    ) => {
        if (worker !== entry) return;
        const message = event.data;
        if ('kind' in message) {
            clearTimeout(entry.startup);
            entry.loaded = true;
            settle('ready');
            pump();
            return;
        }
        if (running?.job.id !== message.id) return;
        clearTimeout(running.timer);
        const { job } = running;
        running = null;
        job.settle(message.outcome);
        pump();
    };
    // A worker that fails before it said it loaded can't start: diagrams are off from here, and nothing
    // starts another (the script is unavailable; retrying would only fail again). One that fails while
    // drawing takes that diagram with it, and a new one takes the rest.
    made.onerror = () => {
        if (worker !== entry) return;
        if (!entry.loaded) return giveUp();
        restart();
    };
    made.postMessage({ kind: 'preload' });
    return entry;
}

/* The worker ends: its startup deadline goes with it. */
function endWorker() {
    if (!worker) return;
    clearTimeout(worker.startup);
    worker.worker.terminate();
    worker = null;
}

/* The worker can't start: diagrams say they couldn't be drawn, now and from here on. */
function giveUp() {
    endWorker();
    if (running) {
        clearTimeout(running.timer);
        running.job.settle({ failure: 'failed' });
        running = null;
    }
    if (state === 'waiting') settle('failed');
    else state = 'failed';
    failAll();
}

/* The running diagram fails; a new worker takes the rest once it has loaded. */
function restart() {
    endWorker();
    if (running) {
        clearTimeout(running.timer);
        running.job.settle({ failure: 'failed' });
        running = null;
    }
    try {
        worker = startWorker();
    } catch {
        giveUp();
    }
}

/* The next diagram still wanted, once the worker has loaded and none is being drawn; its time starts now. */
function pump() {
    if (running || !worker?.loaded) return;
    let job = queue.shift();
    while (job?.cancelled) job = queue.shift();
    if (!job) return;
    running = { job, timer: setTimeout(restart, DIAGRAM_TIMEOUT) };
    worker.worker.postMessage({ id: job.id, source: job.source });
}

/*
 * The worker and every diagram type, fetched once after unlock with the other viewers. Settles as soon
 * as the worker says it has loaded, at once if it can't start, and at its startup deadline if it stalls,
 * so the preloads after it never wait on a failure already known.
 */
export function preloadMermaid() {
    if (!started) {
        started = true;
        if (typeof Worker === 'undefined') settle('failed');
        else
            try {
                worker = startWorker();
            } catch {
                giveUp();
            }
    }
    return settled;
}

export const diagramsState = () => state;
/* Settles when the preload has: the worker loaded, or couldn't. */
export const diagramsSettled = settled;

/*
 * A diagram drawn in the worker, in turn; only once the preload has fetched it. `cancel` takes a diagram
 * no longer wanted (its text changed, its view went) out of the queue before it is drawn; one already
 * being drawn finishes, and its result is ignored.
 */
export function drawDiagram(source: string): {
    result: Promise<DiagramOutcome>;
    cancel: () => void;
} {
    if (state !== 'ready')
        return { result: Promise.resolve({ failure: 'failed' }), cancel: () => {} };
    let job: Job | null = null;
    const result = new Promise<DiagramOutcome>((resolve) => {
        job = { id: ++next, source, settle: resolve, cancelled: false };
        queue.push(job);
        pump();
    });
    return {
        result,
        cancel: () => {
            if (job) job.cancelled = true;
        },
    };
}

/*
 * A Markdown view on a page without the drive's preload (a public link's page): the fixed bundle is
 * started for every Markdown file shown, with a diagram or without, so its fetch never says which.
 * Inside the drive it waits for the preload, whose order never says what was opened.
 */
export function startDiagramsForView() {
    if (!preloadOwnsDiagrams()) void preloadMermaid();
}
