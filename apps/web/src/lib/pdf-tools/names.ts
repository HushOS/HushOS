import type { DriveNode } from '@hushos/drive/client';
import {
    IMAGES_CARD_PAGES,
    IMAGES_MAX_PAGES,
    PDF_TOOLS_CARD_BYTES,
    PDF_TOOLS_MAX_BYTES,
    PDF_TOOLS_MAX_FILES,
    PDF_TOOLS_MAX_PAGES,
} from './protocol';

/*
 * Which files Edit pages takes, how much of them, and what its results are called
 * (docs/file-tools-design.md, feature (c) and section 3). Pure, so it is tested without a browser.
 * The phones name their results the same way (PdfPagesSheet on iOS and Android).
 */

export function isPdf(node: DriveNode) {
    if (node.kind !== 'file' || !node.currentVersion) return false;
    if (node.currentVersion.objectStatus === 'missing') return false;
    const mime = node.metadata?.mime?.toLowerCase();
    if (mime === 'application/pdf') return true;
    return node.name.toLowerCase().endsWith('.pdf');
}

/* What a selection's Edit pages is: fine, worth a word first (the large-file card), or past what is done here. */
export type PdfToolsStage = 'fine' | 'offer' | 'ceiling';

export function pdfToolsStage(files: number, bytes: number): PdfToolsStage {
    if (files > PDF_TOOLS_MAX_FILES || bytes > PDF_TOOLS_MAX_BYTES) return 'ceiling';
    return bytes > PDF_TOOLS_CARD_BYTES ? 'offer' : 'fine';
}

/* Save as images for `pages` pages: fine, worth a word first, or more than one run makes. */
export function imagesStage(pages: number): PdfToolsStage {
    if (pages > IMAGES_MAX_PAGES) return 'ceiling';
    return pages > IMAGES_CARD_PAGES ? 'offer' : 'fine';
}

export const tooManyPages = (pages: number) => pages > PDF_TOOLS_MAX_PAGES;

/* A name without its last extension: "Report.pdf" is "Report"; a name that is only an extension stays. */
export function baseName(name: string) {
    const dot = name.lastIndexOf('.');
    const base = (dot > 0 ? name.slice(0, dot) : name).trim();
    return base || 'PDF';
}

/* "Report (pages 1–3).pdf" for a range, "Report (page 4).pdf" for one page; pages counted from 1. */
export function splitName(source: string, first: number, last: number) {
    const pages = first === last ? `page ${first}` : `pages ${first}–${last}`;
    return `${baseName(source)} (${pages}).pdf`;
}

/* "<first name> (merged).pdf". */
export function mergedName(first: string) {
    return `${baseName(first)} (merged).pdf`;
}

/* "<name> (images)": the folder Save as images makes. */
export function imagesFolderName(source: string) {
    return `${baseName(source)} (images)`;
}

/* "page 001.png" onwards; past 999 the number simply grows. */
export function pageImageName(index: number, format: 'png' | 'jpeg') {
    return `page ${String(index + 1).padStart(3, '0')}.${format === 'png' ? 'png' : 'jpg'}`;
}

/*
 * The ranges a list of `count` pages is cut into, after each index in `cuts` (0-based, the page a cut
 * follows): [[0, 2], [3, 3]] for cuts after page 3 of 4. Cuts outside the list, or after its last
 * page, cut nothing.
 */
export function rangesOf(count: number, cuts: Iterable<number>) {
    const after = [...new Set(cuts)]
        .filter((cut) => cut >= 0 && cut < count - 1)
        .sort((a, b) => a - b);
    const ranges: [number, number][] = [];
    let start = 0;
    for (const cut of after) {
        ranges.push([start, cut]);
        start = cut + 1;
    }
    if (count > 0) ranges.push([start, count - 1]);
    return ranges;
}

/* PDFs from more than one folder (search results, Home): refused, never edited in part. */
export const MIXED_FOLDERS =
    'These PDFs are in different folders. Edit pages from one folder at a time.';
