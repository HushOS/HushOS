import type { DriveNode } from '@hushos/drive/client';

/*
 * Which files One PDF takes, and how much of them (docs/file-tools-design.md, section 3,
 * "Images to PDF": the large-file card past 64 MiB of images; at most 256 MiB and 500 images).
 * The core holds the same numbers for the phones (images_pdf_limits). Pure, so it is tested
 * without a browser.
 */

const MiB = 1024 * 1024;
export const IMAGES_PDF_CARD_BYTES = 64 * MiB;
export const IMAGES_PDF_MAX_BYTES = 256 * MiB;
export const IMAGES_PDF_MAX_IMAGES = 500;

/* Kinds a PDF takes: JPEG and PNG as they are, the rest decoded by the browser. SVG, TIFF and icons are not offered. */
const TYPES = new Set([
    'image/jpeg',
    'image/pjpeg',
    'image/png',
    'image/heic',
    'image/heif',
    'image/webp',
    'image/avif',
    'image/gif',
    'image/bmp',
    'image/x-ms-bmp',
]);
const EXTENSIONS = new Set([
    'jpg',
    'jpeg',
    'jpe',
    'jfif',
    'png',
    'heic',
    'heif',
    'webp',
    'avif',
    'gif',
    'bmp',
]);

export function pdfable(node: DriveNode) {
    if (node.kind !== 'file' || !node.currentVersion) return false;
    if (node.currentVersion.objectStatus === 'missing') return false;
    const mime = node.metadata?.mime?.toLowerCase();
    if (mime && TYPES.has(mime)) return true;
    const dot = node.name.lastIndexOf('.');
    return dot > 0 && EXTENSIONS.has(node.name.slice(dot + 1).toLowerCase());
}

/* What a selection's One PDF is: fine, worth a word first (the large-file card), or past what is made here. */
export type ImagesPdfStage = 'fine' | 'offer' | 'ceiling';

export function imagesPdfStage(count: number, bytes: number): ImagesPdfStage {
    if (count > IMAGES_PDF_MAX_IMAGES || bytes > IMAGES_PDF_MAX_BYTES) return 'ceiling';
    return bytes > IMAGES_PDF_CARD_BYTES ? 'offer' : 'fine';
}

/* The first image's name with `.pdf` in place of its extension. */
export function pdfNameFor(first: string) {
    const dot = first.lastIndexOf('.');
    const base = (dot > 0 ? first.slice(0, dot) : first).trim();
    return `${base || 'Images'}.pdf`;
}
