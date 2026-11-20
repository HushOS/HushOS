/*
 * What the page tells the PDF tools worker for Edit pages (pdf-tools.tool-worker.ts) and the page
 * renderer for Save as images (render.worker.ts), and what they hand back. Kept apart from both
 * workers, so the page imports none of their code. The numbers are docs/file-tools-design.md's,
 * section 3 ("PDF tools", "Save as images"); the core holds the same for the phones
 * (pdf_tools_limits).
 */

const MiB = 1024 * 1024;

/* Past this much of PDFs the dialog asks first (the large-file card); past the ceiling it refuses. */
export const PDF_TOOLS_CARD_BYTES = 64 * MiB;
export const PDF_TOOLS_MAX_BYTES = 256 * MiB;
export const PDF_TOOLS_MAX_FILES = 100;
export const PDF_TOOLS_MAX_PAGES = 2_000;
/* The largest PDF made: what can be held as one in-memory upload (RESULT_MAX_BYTES). */
export const PDF_MAX_BYTES = 256 * MiB;
/* Save as images: past this many pages the dialog asks first; at most this many in one run, each at most this many pixels. */
export const IMAGES_CARD_PAGES = 50;
export const IMAGES_MAX_PAGES = 500;
export const IMAGES_MAX_PIXELS = 40_000_000;

export type Rotation = 0 | 90 | 180 | 270;
/* A page as its PDF has it: the MediaBox's size in points, unrotated, and its /Rotate. */
export type PageInfo = { width: number; height: number; rotate: Rotation };
export type PdfFlags = { signed: boolean; outline: boolean; form: boolean };

/* One page of an output: which source, which of its pages (from 0), and the rotation it is to have. */
export type PagePlan = { source: number; page: number; rotate: Rotation };

export type PdfToolsInput =
    /* Each source's pages, warnings or refusal; produces nothing. */
    | { kind: 'inspect' }
    /* New PDFs, each one of `outputs`, handed back in order under its name. */
    | { kind: 'build'; outputs: { name: string; pages: PagePlan[] }[] };

/*
 * Inspect's summary. A source's pages travel as one string, "w h r" per page joined by ",", so 2,000
 * pages fit the summary's limits (run.ts: 4,096 entries an array, 64 KiB of text); parsePages reads
 * it back strictly. A refused source has only its reason.
 */
export type InspectedSource =
    | { ok: true; pages: string; signed: boolean; outline: boolean; form: boolean }
    | { ok: false; reason: 'encrypted' | 'damaged' | 'too-many-pages' };
export type PdfToolsSummary = { sources: InspectedSource[] } | { outputs: number };

export function pagesText(pages: readonly PageInfo[]) {
    return pages
        .map((page) => `${round(page.width)} ${round(page.height)} ${page.rotate}`)
        .join(',');
}

const round = (value: number) => Math.round(value * 100) / 100;

/* The pages of a source as inspect sent them, or null when the text isn't what pagesText writes. */
export function parsePages(text: unknown, max = PDF_TOOLS_MAX_PAGES): PageInfo[] | null {
    if (typeof text !== 'string' || text.length === 0) return null;
    const items = text.split(',');
    if (items.length > max) return null;
    const pages: PageInfo[] = [];
    for (const item of items) {
        const parts = item.split(' ');
        if (parts.length !== 3) return null;
        const [width, height, rotate] = parts.map(Number) as [number, number, number];
        if (![width, height].every((value) => Number.isFinite(value) && value >= 0 && value < 1e7))
            return null;
        if (rotate !== 0 && rotate !== 90 && rotate !== 180 && rotate !== 270) return null;
        pages.push({ width, height, rotate });
    }
    return pages;
}

/* What the page renderer is asked for: every planned page of the sources as an image. */
export type RenderInput = {
    pages: PagePlan[];
    format: 'png' | 'jpeg';
    dpi: 150 | 300;
    /* The names the images are handed back under, one a page, in order. */
    names: string[];
    /* Each image's thumbnail: its longest side and most bytes, as uploads make them. */
    thumbnail: { edge: number; maxBytes: number };
};
export type RenderSummary = { images: number };

/*
 * An image's size for a page of `width` by `height` points turned by `rotate`, at `dpi`: points are
 * 1/72 inch, rounded to the nearest pixel, at least one. Every client sizes the same way.
 */
export function imageSize(page: Pick<PageInfo, 'width' | 'height'>, rotate: Rotation, dpi: number) {
    const scale = dpi / 72;
    const w = Math.max(1, Math.round(page.width * scale));
    const h = Math.max(1, Math.round(page.height * scale));
    return rotate === 90 || rotate === 270 ? { width: h, height: w } : { width: w, height: h };
}
