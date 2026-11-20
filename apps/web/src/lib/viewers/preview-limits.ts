/*
 * How much of a file the viewer reads as it opens. Apart from large-files.ts, which re-exports
 * it, so the file tools' harness can cap a run's blob URLs without loading the viewer's rules.
 */
export const PREVIEW_LIMITS = {
    image: 100 * 1024 * 1024,
    text: 8 * 1024 * 1024,
    /* A PDF up to this size is read whole and remembered; larger ones stream by range. */
    document: 16 * 1024 * 1024,
    /* A clip up to this size plays from memory and is remembered; larger media streams by range. */
    media: 16 * 1024 * 1024,
    /* Media falls back to a blob where the service worker is unavailable. */
    mediaBlob: 256 * 1024 * 1024,
};
