/*
 * Evaluated just before pdf.js's worker code in Save as images' tools worker (pdf-render.tool-worker.ts):
 * that code, finding itself in a worker with no `window`, takes the worker's own message channel for
 * pdf.js's and answers the harness's messages, which fails the run. A `window` for that moment keeps it
 * to itself; pdf-window-shim-end.ts takes it away again before pdf.js's display code runs.
 */
(globalThis as { window?: unknown }).window = globalThis;
export {};
