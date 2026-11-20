/* pdf.js as Save as images' tools worker imports it (vite.config.ts, `pdfjsWithoutImports`). */
declare module 'pdfjs-dist/build/pdf.mjs?tool-worker' {
    export * from 'pdfjs-dist';
}
declare module 'pdfjs-dist/build/pdf.worker.mjs?tool-worker' {
    export const WorkerMessageHandler: unknown;
}
