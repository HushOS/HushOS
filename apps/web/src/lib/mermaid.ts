import type { DiagramOutcome } from '@/lib/mermaid-render';

/*
 * Mermaid diagrams for the Markdown renderer (components/drive/rich-text.tsx): drawn by pele in a worker
 * of their own (lib/mermaid.worker.ts), which the viewers' post-unlock preload fetches whole
 * (lib/preload.ts). Until then a diagram stays its code: drawing it before would fetch the worker and
 * say that a file with a diagram was just opened.
 *
 * One diagram at a time: the worker draws synchronously, so the queue is kept here and each diagram's
 * time starts when it is handed over, never while it waits behind others. One that takes too long ends
 * the worker; it alone fails, and the rest go on in a new worker from the same (cached) file.
 */

/* How long one diagram may take, from the moment the worker is given it. */
export const DIAGRAM_TIMEOUT = 8_000;
/* How long the preload waits for the worker to say it has loaded. */
const PRELOAD_TIMEOUT = 30_000;

/* Whether diagrams can be drawn: waiting for the preload, ready, or failed (the worker couldn't start). */
export type DiagramsState = 'waiting' | 'ready' | 'failed';

let state: DiagramsState = 'waiting';
let announce: () => void = () => {};
const settled = new Promise<void>((resolve) => {
    announce = resolve;
});
let started = false;
let worker: Worker | null = null;
let next = 0;

type Job = { id: number; source: string; settle: (outcome: DiagramOutcome) => void };
const queue: Job[] = [];
let running: { job: Job; timer: ReturnType<typeof setTimeout> } | null = null;

function settle(now: DiagramsState) {
    if (state !== 'waiting') return;
    state = now;
    announce();
}

function startWorker() {
    const made = new Worker(new URL('./mermaid.worker.ts', import.meta.url), {
        type: 'module',
        name: 'mermaid',
    });
    made.onmessage = (
        event: MessageEvent<{ kind: 'ready' } | { id: number; outcome: DiagramOutcome }>,
    ) => {
        const message = event.data;
        if ('kind' in message) return settle('ready');
        if (running?.job.id !== message.id) return;
        clearTimeout(running.timer);
        const { job } = running;
        running = null;
        job.settle(message.outcome);
        pump();
    };
    // The worker's script didn't load, or it died: before the preload settled, diagrams are off;
    // during a diagram, that one fails and the rest go on in a new worker.
    made.onerror = () => {
        if (state === 'waiting') {
            settle('failed');
            for (const job of queue.splice(0)) job.settle({ failure: 'failed' });
            return;
        }
        restart();
    };
    return made;
}

/* The running diagram fails; a new worker takes the rest. */
function restart() {
    worker?.terminate();
    if (running) {
        clearTimeout(running.timer);
        running.job.settle({ failure: 'failed' });
        running = null;
    }
    try {
        worker = startWorker();
    } catch {
        worker = null;
        state = 'failed';
        for (const job of queue.splice(0)) job.settle({ failure: 'failed' });
        return;
    }
    pump();
}

/* The next diagram, if none is being drawn; its time starts now. */
function pump() {
    if (running || !worker) return;
    const job = queue.shift();
    if (!job) return;
    running = { job, timer: setTimeout(restart, DIAGRAM_TIMEOUT) };
    worker.postMessage({ id: job.id, source: job.source });
}

/*
 * The worker and every diagram type, fetched once after unlock with the other viewers. Settles as soon
 * as the worker says it has loaded, or at once if it can't start, so the preloads after it never wait on
 * a failure already known.
 */
export function preloadMermaid() {
    if (!started) {
        started = true;
        if (typeof Worker === 'undefined') settle('failed');
        else
            try {
                worker = startWorker();
                worker.postMessage({ kind: 'preload' });
            } catch {
                settle('failed');
            }
    }
    return Promise.race([
        settled,
        new Promise<void>((resolve) => setTimeout(resolve, PRELOAD_TIMEOUT)),
    ]);
}

export const diagramsState = () => state;
/* Settles when the preload has: the worker loaded, or couldn't. */
export const diagramsSettled = settled;

/* A diagram drawn in the worker, in turn; only once the preload has fetched it. */
export function drawDiagram(source: string): Promise<DiagramOutcome> {
    if (state !== 'ready' || !worker) return Promise.resolve({ failure: 'failed' });
    return new Promise((resolve) => {
        queue.push({ id: ++next, source, settle: resolve });
        pump();
    });
}
