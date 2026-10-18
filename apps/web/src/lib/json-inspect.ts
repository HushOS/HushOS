import { inspectJson, type JsonInspection } from '@/lib/json';

/*
 * Where a JSON file is checked: on the spot when it is small (a millisecond or
 * two), in a worker when it is large. The worker starts with the other viewers
 * after unlock (lib/preload.ts), so fetching it says nothing about the file.
 */

/* Up to this size checking and laying out takes under about 10ms, less than a worker round trip saves. */
const INLINE_LIMIT = 1024 * 1024;

type Job = { text: string; resolve: (result: JsonInspection) => void };

let worker: Worker | null = null;
let nextJob = 1;
const jobs = new Map<number, Job>();

function inspector() {
    if (worker) return worker;
    if (typeof Worker === 'undefined') return null;
    try {
        worker = new Worker(new URL('./json.worker.ts', import.meta.url), { type: 'module' });
    } catch {
        return null;
    }
    worker.onmessage = (event: MessageEvent<{ id: number; result: JsonInspection }>) => {
        jobs.get(event.data.id)?.resolve(event.data.result);
        jobs.delete(event.data.id);
    };
    // A worker that fails finishes its jobs here instead; the next file starts a fresh one.
    worker.onerror = () => {
        worker?.terminate();
        worker = null;
        const pending = [...jobs.values()];
        jobs.clear();
        for (const job of pending) job.resolve(inspectJson(job.text));
    };
    return worker;
}

/* Small text is answered now; null means ask `inspect`. */
export function inspectNow(text: string) {
    return text.length <= INLINE_LIMIT ? inspectJson(text) : null;
}

export function inspect(text: string): Promise<JsonInspection> {
    const target = text.length <= INLINE_LIMIT ? null : inspector();
    if (!target) return Promise.resolve(inspectJson(text));
    return new Promise((resolve) => {
        const id = nextJob++;
        jobs.set(id, { text, resolve });
        target.postMessage({ id, text });
    });
}

export function preloadJsonWorker() {
    inspector()?.postMessage({ kind: 'preload' });
}
