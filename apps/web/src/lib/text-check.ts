import { parseFailure, type StructuredKind } from '@/lib/text-parse';

/*
 * The structured-text check as the editor runs it: JSON, YAML and TOML in a
 * worker of their own, started per check and ended by `cancel` (a newer edit,
 * or the editor closing), so no parse, however long, holds the page. A YAML
 * file of 60,000 keys takes the parser seconds. XML is the browser's own
 * DOMParser, which a worker doesn't have; it stays here, under the editor's
 * size bound. The worker's script is fetched with the post-unlock preload
 * (`preloadCheckWorker`), so a check fetches nothing that says what was edited.
 */

/* Where no worker can start, only text this small is checked here (a few milliseconds); larger goes unchecked. */
export const INLINE_CHECK_LIMIT = 64 * 1024;

export type CheckAnswer = { line: number | null } | null | 'skipped';
export type Check = { result: Promise<CheckAnswer>; cancel: () => void };

function checkWorker() {
    return new Worker(new URL('./text-check.worker.ts', import.meta.url), {
        type: 'module',
        name: 'text-check',
    });
}

/* No worker: small text checked here, anything larger skipped (never a long parse on the page). */
function inline(kind: StructuredKind, text: string): Promise<CheckAnswer> {
    return text.length <= INLINE_CHECK_LIMIT
        ? parseFailure(kind, text)
        : Promise.resolve('skipped');
}

export function startCheck(kind: StructuredKind, text: string): Check {
    if (kind === 'xml') return { result: parseFailure(kind, text), cancel: () => {} };
    let worker: Worker | null = null;
    try {
        if (typeof Worker !== 'undefined') worker = checkWorker();
    } catch {
        worker = null;
    }
    if (!worker) return { result: inline(kind, text), cancel: () => {} };
    let settle: (answer: CheckAnswer) => void = () => {};
    const result = new Promise<CheckAnswer>((resolve) => {
        settle = resolve;
    });
    const end = (answer: CheckAnswer | Promise<CheckAnswer>) => {
        if (!worker) return;
        worker.terminate();
        worker = null;
        void Promise.resolve(answer).then(settle);
    };
    worker.onmessage = (event: MessageEvent<{ failure: { line: number | null } | null }>) =>
        end(event.data.failure ?? null);
    // A worker that fails to run (blocked, or its script gone with a deploy): as if there were none.
    worker.onerror = () => end(inline(kind, text));
    worker.postMessage({ kind, text });
    return { result, cancel: () => end('skipped') };
}

/* Fetches the check worker's script after unlock: started, asked to load, and let go. */
export function preloadCheckWorker() {
    if (typeof Worker === 'undefined') return;
    try {
        const worker = checkWorker();
        const done = () => worker.terminate();
        worker.onmessage = done;
        worker.onerror = done;
        setTimeout(done, 30_000);
        worker.postMessage({ kind: 'preload' });
    } catch {
        // No module workers here: checks run inline, under the size bound.
    }
}
