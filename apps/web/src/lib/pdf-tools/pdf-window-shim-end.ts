/* See pdf-window-shim.ts: the `window` it lent pdf.js's worker code is gone again. */
delete (globalThis as { window?: unknown }).window;
export {};
