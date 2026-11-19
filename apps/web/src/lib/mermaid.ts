import type { DiagramOutcome } from '@/lib/mermaid-render';

/*
 * Mermaid diagrams for the Markdown renderer (components/drive/rich-text.tsx): drawn by pele in a worker
 * of their own (lib/mermaid.worker.ts), which the viewers' post-unlock preload fetches whole
 * (lib/preload.ts). Until then a diagram stays its code: drawing it before would fetch the worker and
 * say that a file with a diagram was just opened. A diagram that takes too long ends its worker, and
 * the next one starts a new one from the same file.
 */

/* How long one diagram may take before its worker is ended. */
const DIAGRAM_TIMEOUT = 8_000;

let worker: Worker | null = null;
let ready = false;
let announce: () => void = () => {};
const preloaded = new Promise<void>((resolve) => {
    announce = resolve;
});
let started = false;
let next = 0;
const waiting = new Map<number, (outcome: DiagramOutcome) => void>();

function startWorker() {
    const made = new Worker(new URL('./mermaid.worker.ts', import.meta.url), {
        type: 'module',
        name: 'mermaid',
    });
    made.onmessage = (
        event: MessageEvent<{ kind: 'ready' } | { id: number; outcome: DiagramOutcome }>,
    ) => {
        const message = event.data;
        if ('kind' in message) {
            ready = true;
            announce();
            return;
        }
        waiting.get(message.id)?.(message.outcome);
        waiting.delete(message.id);
    };
    made.onerror = () => {
        for (const [, settle] of waiting) settle({ failure: 'failed' });
        waiting.clear();
    };
    return made;
}

/* The worker and every diagram type, fetched once after unlock with the other viewers. */
export function preloadMermaid() {
    if (!started && typeof Worker !== 'undefined') {
        started = true;
        try {
            worker = startWorker();
            worker.postMessage({ kind: 'preload' });
        } catch {
            // No module workers: diagrams stay code.
        }
    }
    return Promise.race([preloaded, new Promise<void>((resolve) => setTimeout(resolve, 30_000))]);
}

/* Whether diagrams can be drawn now, and when they can. */
export const diagramsReady = () => ready;
export const diagramsPreloaded = preloaded;

/* A diagram drawn in the worker; only once the preload has fetched it. */
export function drawDiagram(source: string): Promise<DiagramOutcome> {
    if (!ready || !worker) return Promise.resolve({ failure: 'failed' });
    const id = ++next;
    const current = worker;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (!waiting.has(id)) return;
            // A diagram that never finishes: its worker goes, and with it every diagram waiting on it.
            current.terminate();
            for (const [, settle] of waiting) settle({ failure: 'failed' });
            waiting.clear();
            if (worker === current) worker = startWorker();
        }, DIAGRAM_TIMEOUT);
        waiting.set(id, (outcome) => {
            clearTimeout(timer);
            resolve(outcome);
        });
        current.postMessage({ id, source });
    });
}
