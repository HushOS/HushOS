import { PREVIEW_LIMITS } from '@/lib/preview-limits';
import { imageSize } from './dimensions';
import { ImageRefused, isHeic } from './pdf';
import { MAX_PIXELS } from './protocol';

/*
 * HEIC, WebP, AVIF, GIF (its first frame) and BMP for a PDF, with the browser's own decoders in
 * the PDF tools worker: decoded with its orientation applied, then encoded as JPEG at quality 92,
 * or PNG when any pixel is transparent. HEIC opens only where the browser decodes it (Safari);
 * elsewhere it is refused with words of its own (the owner's decision, 2026-10-19).
 *
 * Stands in for the shared image module (docs/file-tools-design.md, section 2), which arrives with
 * image conversion (step 11, wasm-vips) and replaces this one function; nothing else here knows
 * how an image was decoded. Until then the colour profile is not carried over (the canvas draws
 * in sRGB), and the encoded bytes are held in a Blob for the moment the browser decodes them:
 * one image at a time, only a kind the PDF can't take as it is, and never one larger than an
 * image preview may be (PREVIEW_LIMITS.image), the size below which Chromium keeps a Blob in
 * memory as it does a preview's. Its size is read from its header first, so a file that would
 * decode to more than MAX_PIXELS is refused before the browser allocates a pixel of it.
 */

/* The most an image may be to be handed to the browser's decoder, as a Blob: what a preview may hold. */
export const DECODE_BLOB_MAX = PREVIEW_LIMITS.image;

/* An image's size from its header, refused when unreadable or past MAX_PIXELS, before any decode. */
function checkedSize(bytes: Uint8Array, index: number) {
    const size = imageSize(bytes);
    if (!size) throw new ImageRefused(isHeic(bytes) ? 'heic' : 'damaged', index);
    if (size.width * size.height > MAX_PIXELS) throw new ImageRefused('too-many-pixels', index);
    return size;
}

export type Encoded = { kind: 'jpeg' | 'png'; bytes: Uint8Array };

/* Rows of pixels read at a time while looking for transparency, so a large image is not copied whole. */
const ROWS = 256;

export async function decodeForPdf(bytes: Uint8Array, index: number): Promise<Encoded> {
    checkedSize(bytes, index);
    if (bytes.byteLength > DECODE_BLOB_MAX) throw new ImageRefused('too-large-to-decode', index);
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
            imageOrientation: 'from-image',
        });
    } catch {
        throw new ImageRefused(isHeic(bytes) ? 'heic' : 'damaged', index);
    }
    const { width, height } = bitmap;
    let canvas: OffscreenCanvas | null = null;
    try {
        if (width * height > MAX_PIXELS) throw new ImageRefused('too-many-pixels', index);
        canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new ImageRefused('damaged', index);
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        let transparent = false;
        for (let top = 0; top < height && !transparent; top += ROWS) {
            const rows = context.getImageData(0, top, width, Math.min(ROWS, height - top)).data;
            for (let i = 3; i < rows.length; i += 4)
                if (rows[i] !== 255) {
                    transparent = true;
                    break;
                }
        }
        const blob = await canvas.convertToBlob(
            transparent ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.92 },
        );
        return {
            kind: transparent ? 'png' : 'jpeg',
            bytes: new Uint8Array(await blob.arrayBuffer()),
        };
    } finally {
        bitmap.close();
        // Its pixels go now, not when the collector gets to it.
        if (canvas) canvas.width = canvas.height = 0;
    }
}

/*
 * A small JPEG of the first image, for the PDF's thumbnail in the folder; null when it can't be
 * made, and not made at all for an image past the preview limit or MAX_PIXELS (the thumbnail is
 * optional; the Blob it needs is not).
 */
export async function thumbnailOf(bytes: Uint8Array, edge: number, maxBytes: number) {
    if (bytes.byteLength > DECODE_BLOB_MAX) return null;
    let bitmap: ImageBitmap | null = null;
    let canvas: OffscreenCanvas | null = null;
    try {
        // Read inside the try: a damaged header makes no thumbnail, never a failed run.
        const size = imageSize(bytes);
        if (!size || size.width * size.height > MAX_PIXELS) return null;
        bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
            imageOrientation: 'from-image',
        });
        if (bitmap.width * bitmap.height > MAX_PIXELS) return null;
        const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
        canvas = new OffscreenCanvas(
            Math.max(1, Math.round(bitmap.width * scale)),
            Math.max(1, Math.round(bitmap.height * scale)),
        );
        const context = canvas.getContext('2d');
        if (!context) return null;
        // A transparent image on white, as a PDF reader shows it on its page.
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        for (const quality of [0.8, 0.6, 0.4]) {
            const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
            if (blob.size <= maxBytes) return new Uint8Array(await blob.arrayBuffer());
        }
        return null;
    } catch {
        return null;
    } finally {
        bitmap?.close();
        if (canvas) canvas.width = canvas.height = 0;
    }
}
