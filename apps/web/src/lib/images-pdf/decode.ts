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
 * at most one image, and only a kind the PDF can't take as it is.
 */

export type Encoded = { kind: 'jpeg' | 'png'; bytes: Uint8Array };

/* Rows of pixels read at a time while looking for transparency, so a large image is not copied whole. */
const ROWS = 256;

export async function decodeForPdf(bytes: Uint8Array, index: number): Promise<Encoded> {
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

/* A small JPEG of the first image, for the PDF's thumbnail in the folder; null when it can't be made. */
export async function thumbnailOf(bytes: Uint8Array, edge: number, maxBytes: number) {
    let bitmap: ImageBitmap | null = null;
    let canvas: OffscreenCanvas | null = null;
    try {
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
