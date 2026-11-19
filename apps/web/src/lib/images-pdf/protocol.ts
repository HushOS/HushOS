import type { PageSize } from './geometry';

/*
 * What the page tells the PDF tools worker for One PDF, and what it hands back
 * (images-pdf.tool-worker.ts). Kept apart from the worker, so the page imports none of its code.
 */

export type ImagesPdfInput = {
    name: string;
    size: PageSize;
    margin: boolean;
    /* The thumbnail's longest side and most bytes, as the upload's own thumbnails are made. */
    thumbnail: { edge: number; maxBytes: number };
};

export type ImagesPdfSummary = { pages: number };

/* The first result's name when it is the thumbnail of the first image; a file name never holds a NUL. */
export const THUMBNAIL = '\u0000thumbnail';

/* The largest PDF made: what can be held as one in-memory upload (RESULT_MAX_BYTES). */
export const PDF_MAX_BYTES = 256 * 1024 * 1024;
/* The most pixels of an image decoded to put in a PDF (editing's limit; a JPEG is never decoded). */
export const MAX_PIXELS = 100_000_000;
